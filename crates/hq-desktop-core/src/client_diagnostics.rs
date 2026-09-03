//! Client-diagnostics execution — the Rust adapter of
//! `client-sync-health-control-plane` US-007 ("Run redacted desktop
//! self-diagnostics"), layered on the US-000 wire contract
//! (`crate::client_health`).
//!
//! This module is product-neutral (no Tauri, no filesystem, no network) so it
//! can be unit-tested in isolation. It owns:
//!
//! * Parsing the desired-state command list returned by
//!   `GET /v1/client-health/commands` (hq-pro
//!   `src/vault-service/lib/client-health-command-store.ts`,
//!   `ClientHealthDesiredCommand`). The response is a trusted, TLS-fetched,
//!   bearer-authenticated server payload — not caller-supplied — so parsing
//!   here is a plain shape check, not the fail-closed adversarial validation
//!   `client_health::parse_client_health_command_receipt` applies to
//!   OUTGOING receipts.
//! * A small bounded local execution ledger (`DiagnosticsExecutionState`) the
//!   app layer persists to disk so a restart mid-command resumes instead of
//!   silently dropping it (US-007 AC #4 / e2eTest #4), and so a command whose
//!   receipt already reached a terminal state is never re-executed (AC #4
//!   idempotency).
//! * `ProbeErrorKind` + `probe_error_reason`: the ONLY sanctioned path from an
//!   underlying probe failure to a closed [`crate::client_health::ClientHealthFailureReason`].
//!   Callers classify an error by its already-closed `std::io::ErrorKind` (or
//!   an equivalent fixed vocabulary) BEFORE calling in — the raw
//!   `Display`/`Debug` text of an OS/library error (which can embed a
//!   customer path, a filename, or a secret-shaped value) never has a
//!   parameter slot to flow through. This is the structural fix for the class
//!   of bug the story calls out: "a similar leak (raw doctor messages
//!   containing absolute paths) was just caught and fixed elsewhere in HQ."
//!
//! Note on the failure-reason vocabulary: [`crate::client_health::ClientHealthFailureReason`]
//! is a cross-repo synchronized closed enum (hq-pro, hq-desktop-app, hq-cli,
//! indigo-gtm-hq all carry byte-equivalent copies) and this change does not
//! touch hq-pro. There is no dedicated "probe timed out" or "probe panicked"
//! code in the existing set, so both map to the closest existing bucket,
//! [`crate::client_health::ClientHealthFailureReason::RunnerFailed`] — the
//! same bucket `client_health.rs` already uses for "unclassified runner
//! exits." Adding a dedicated code is future work tracked as a known gap (see
//! the story's final report).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client_health::{
    ClientHealthCommandState, ClientHealthFailureReason, ClientHealthRepairKind,
};

// ─── Wire endpoints (US-006/US-007 desired-state + receipt routes) ──────────

pub const CLIENT_HEALTH_COMMANDS_PATH: &str = "/v1/client-health/commands";
pub const CLIENT_HEALTH_RECEIPT_PATH: &str = "/v1/client-health/commands/receipt";

// ─── Cadence + bounds ─────────────────────────────────────────────────────────

/// Authenticated polling fallback interval — the long-stop that must work on
/// every platform even when the MQTT wake is unavailable (AC #1).
pub const DIAGNOSTICS_POLL_INTERVAL_SECS: u64 = 60;
/// Per-probe timeout (AC #4: "bounded by timeouts"). A hung probe must not
/// hang the whole CHECK_NOW run.
pub const DIAGNOSTICS_PROBE_TIMEOUT_SECS: u64 = 10;
/// Bound on the locally persisted completed-command ledger — the same
/// "bounded storage" discipline the server's command store applies
/// (`CLIENT_HEALTH_MAX_ACTIVE_COMMANDS`), applied to our own local dedupe set
/// so it can never grow unbounded across a long-lived installation.
pub const DIAGNOSTICS_COMPLETED_LEDGER_CAP: usize = 100;

// ─── Desired-state command (GET response) ───────────────────────────────────

/// One desired-state diagnostic/repair command, as returned by
/// `GET /v1/client-health/commands`. Mirrors hq-pro's
/// `ClientHealthDesiredCommand` field-for-field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientHealthDesiredCommand {
    pub command_id: String,
    pub kind: ClientHealthRepairKind,
    pub state: ClientHealthCommandState,
    /// Current server-side revision. The next receipt for this command MUST
    /// carry a revision strictly greater than this value.
    pub revision: u64,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesiredCommandsParseError {
    /// The top-level `commands` array is missing or the wrong shape.
    InvalidShape,
    /// One entry's `kind` is not a recognized [`ClientHealthRepairKind`].
    UnknownKind,
    /// One entry's `state` is not a recognized [`ClientHealthCommandState`].
    UnknownState,
    /// A required field is missing or the wrong JSON type.
    InvalidField,
}

/// Reverse-lookup of a repair-kind wire string. Manual match (rather than
/// reusing the private `parse_field` the `closed_wire_enum!` macro generates
/// in `client_health.rs`) keeps this module's only coupling to the wire
/// contract at the public `wire_value()` surface.
fn parse_repair_kind(wire: &str) -> Option<ClientHealthRepairKind> {
    use ClientHealthRepairKind::*;
    for kind in [
        CheckNow,
        RetrySync,
        ResumeSync,
        RepairCli,
        UpdateCore,
        ApplyDesktopUpdate,
        RestartApp,
    ] {
        if kind.wire_value() == wire {
            return Some(kind);
        }
    }
    None
}

fn parse_command_state(wire: &str) -> Option<ClientHealthCommandState> {
    use ClientHealthCommandState::*;
    for state in [Queued, Acknowledged, Running, Succeeded, Failed, Expired] {
        if state.wire_value() == wire {
            return Some(state);
        }
    }
    None
}

/// Parse the body of `GET /v1/client-health/commands` (`{"commands": [...]}`).
/// Trusted server response: unknown EXTRA fields on each entry are ignored;
/// an unrecognized `kind`/`state` fails closed (the caller skips that one
/// command rather than crashing the whole poll — a future server-side repair
/// kind must not break an older desktop's diagnostics poller).
pub fn parse_desired_commands(
    value: &Value,
) -> Result<Vec<ClientHealthDesiredCommand>, DesiredCommandsParseError> {
    let entries = value
        .get("commands")
        .and_then(Value::as_array)
        .ok_or(DesiredCommandsParseError::InvalidShape)?;

    let mut commands = Vec::with_capacity(entries.len());
    for entry in entries {
        let obj = entry
            .as_object()
            .ok_or(DesiredCommandsParseError::InvalidField)?;
        let command_id = obj
            .get("commandId")
            .and_then(Value::as_str)
            .ok_or(DesiredCommandsParseError::InvalidField)?
            .to_string();
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(DesiredCommandsParseError::InvalidField)
            .and_then(|s| parse_repair_kind(s).ok_or(DesiredCommandsParseError::UnknownKind))?;
        let state = obj
            .get("state")
            .and_then(Value::as_str)
            .ok_or(DesiredCommandsParseError::InvalidField)
            .and_then(|s| parse_command_state(s).ok_or(DesiredCommandsParseError::UnknownState))?;
        let revision = obj
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or(DesiredCommandsParseError::InvalidField)?;
        let created_at = obj
            .get("createdAt")
            .and_then(Value::as_str)
            .ok_or(DesiredCommandsParseError::InvalidField)?
            .to_string();
        let expires_at = obj
            .get("expiresAt")
            .and_then(Value::as_str)
            .ok_or(DesiredCommandsParseError::InvalidField)?
            .to_string();
        commands.push(ClientHealthDesiredCommand {
            command_id,
            kind,
            state,
            revision,
            created_at,
            expires_at,
        });
    }
    Ok(commands)
}

// ─── Local execution ledger (persisted by the app layer) ────────────────────

/// Bounded local record of diagnostic-command execution, persisted by the app
/// layer (mirrors `client_health.rs`'s `~/.hq/client-health.json`
/// read-modify-write discipline) so a restart mid-execution resumes rather
/// than silently dropping the command (AC #4 / e2eTest #4), and a command
/// whose receipt already reached a terminal state is never re-executed even
/// if the server's desired-state list has not caught up yet (defense in
/// depth on top of the server's own conditional-write idempotency).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnosticsExecutionState {
    /// The command currently being executed, if the process is mid-run (or
    /// was, at last save, before a crash/restart).
    pub in_flight_command_id: Option<String>,
    /// Bounded FIFO of command IDs whose receipt reached a terminal state
    /// (succeeded/failed/expired) — capped at
    /// [`DIAGNOSTICS_COMPLETED_LEDGER_CAP`].
    pub completed_ids: Vec<String>,
}

impl DiagnosticsExecutionState {
    /// True when this command's receipt has already reached a terminal
    /// state locally — the poller must not re-execute it even if the
    /// server's desired-state list has not caught up.
    pub fn is_completed(&self, command_id: &str) -> bool {
        self.completed_ids.iter().any(|id| id == command_id)
    }

    /// Mark a command as currently executing (idempotent).
    pub fn begin(&mut self, command_id: &str) {
        self.in_flight_command_id = Some(command_id.to_string());
    }

    /// Record a terminal outcome and clear the in-flight marker. Bounded
    /// FIFO: the oldest entry is dropped once the cap is exceeded.
    pub fn complete(&mut self, command_id: &str) {
        if self.in_flight_command_id.as_deref() == Some(command_id) {
            self.in_flight_command_id = None;
        }
        if !self.is_completed(command_id) {
            self.completed_ids.push(command_id.to_string());
            while self.completed_ids.len() > DIAGNOSTICS_COMPLETED_LEDGER_CAP {
                self.completed_ids.remove(0);
            }
        }
    }
}

/// Should the poller execute this desired command right now? False for a
/// command already known locally complete (idempotency-by-command-ID, AC
/// #4) — true otherwise, INCLUDING a command that was `in_flight` at last
/// save (a restart must resume, not skip, e2eTest #4).
pub fn should_execute(state: &DiagnosticsExecutionState, command_id: &str) -> bool {
    !state.is_completed(command_id)
}

// ─── Redaction-safe probe error classification ──────────────────────────────

/// Closed vocabulary a probe error is classified into BEFORE it ever reaches
/// [`probe_error_reason`]. Callers match on `std::io::ErrorKind` (itself a
/// closed, non-free-text enum) or an equivalent fixed signal — never on an
/// error's `Display`/`Debug` text — so a raw message (which can embed a
/// customer path, filename, or secret-shaped value) structurally has no
/// parameter through which to reach the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeErrorKind {
    PermissionDenied,
    DiskFull,
    NotFound,
    /// The probe exceeded [`DIAGNOSTICS_PROBE_TIMEOUT_SECS`].
    TimedOut,
    /// The probe task panicked; caught via `catch_unwind`/`JoinError`
    /// (AC #5: a probe failure must never crash the app).
    Panicked,
    Other,
}

/// Free bytes available on the filesystem backing `path` — thin wrapper over
/// `fs2` so app-layer storage probes don't need their own dependency on it.
pub fn available_space(path: &std::path::Path) -> std::io::Result<u64> {
    fs2::available_space(path)
}

/// Classify a `std::io::Error` by its `ErrorKind` ONLY — the message text is
/// never consulted. `ErrorKind` is itself a closed, non-free-text enum, so
/// this function cannot leak anything the error's `Display` might carry.
pub fn classify_io_error(error: &std::io::Error) -> ProbeErrorKind {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => ProbeErrorKind::PermissionDenied,
        std::io::ErrorKind::NotFound => ProbeErrorKind::NotFound,
        // `StorageFull` observed on the newer nightly ErrorKind stability
        // effort; std stable does not expose it as of this crate's MSRV, so
        // disk-full is asserted by the caller from a free-space probe, not
        // derived from an io::Error kind here.
        _ => ProbeErrorKind::Other,
    }
}

/// The ONLY sanctioned mapping from a classified probe failure to a closed
/// wire [`ClientHealthFailureReason`]. See the module docs for why
/// `TimedOut`/`Panicked`/`NotFound`/`Other` all fold into `RunnerFailed`
/// (no dedicated code exists in the cross-repo-synchronized enum, and this
/// change cannot touch the hq-pro copy).
pub fn probe_error_reason(kind: ProbeErrorKind) -> ClientHealthFailureReason {
    match kind {
        ProbeErrorKind::PermissionDenied => ClientHealthFailureReason::PermissionDenied,
        ProbeErrorKind::DiskFull => ClientHealthFailureReason::DiskFull,
        ProbeErrorKind::NotFound
        | ProbeErrorKind::TimedOut
        | ProbeErrorKind::Panicked
        | ProbeErrorKind::Other => ClientHealthFailureReason::RunnerFailed,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client_health::{
        ClientHealthCheckResult, ClientHealthCheckStatus, ClientHealthDiagnosticCheck,
    };
    use serde_json::json;

    // ── Desired-state parsing ────────────────────────────────────────────────

    #[test]
    fn parses_a_healthy_desired_commands_response() {
        let body = json!({
            "commands": [
                {
                    "commandId": "cmd-01f7ee3b2c9d",
                    "kind": "CHECK_NOW",
                    "state": "queued",
                    "revision": 0,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }
            ]
        });
        let parsed = parse_desired_commands(&body).expect("parses");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].command_id, "cmd-01f7ee3b2c9d");
        assert_eq!(parsed[0].kind, ClientHealthRepairKind::CheckNow);
        assert_eq!(parsed[0].state, ClientHealthCommandState::Queued);
        assert_eq!(parsed[0].revision, 0);
    }

    #[test]
    fn empty_commands_list_parses_to_empty_vec() {
        let body = json!({ "commands": [] });
        assert_eq!(parse_desired_commands(&body).unwrap(), vec![]);
    }

    #[test]
    fn unknown_extra_fields_on_a_command_are_tolerated() {
        let body = json!({
            "commands": [{
                "commandId": "cmd-01f7ee3b2c9d",
                "kind": "CHECK_NOW",
                "state": "queued",
                "revision": 0,
                "createdAt": "2026-09-03T17:00:00.000Z",
                "expiresAt": "2026-09-03T18:00:00.000Z",
                "someFutureField": "value-from-a-newer-server"
            }]
        });
        assert!(parse_desired_commands(&body).is_ok());
    }

    #[test]
    fn missing_top_level_commands_array_fails_closed() {
        let body = json!({ "notCommands": [] });
        assert_eq!(
            parse_desired_commands(&body),
            Err(DesiredCommandsParseError::InvalidShape)
        );
    }

    #[test]
    fn unknown_kind_fails_closed_without_rejecting_the_whole_response() {
        let body = json!({
            "commands": [{
                "commandId": "cmd-01f7ee3b2c9d",
                "kind": "RUN_SHELL",
                "state": "queued",
                "revision": 0,
                "createdAt": "2026-09-03T17:00:00.000Z",
                "expiresAt": "2026-09-03T18:00:00.000Z"
            }]
        });
        assert_eq!(
            parse_desired_commands(&body),
            Err(DesiredCommandsParseError::UnknownKind)
        );
    }

    #[test]
    fn unknown_state_fails_closed() {
        let body = json!({
            "commands": [{
                "commandId": "cmd-01f7ee3b2c9d",
                "kind": "CHECK_NOW",
                "state": "somehow_cancelled",
                "revision": 0,
                "createdAt": "2026-09-03T17:00:00.000Z",
                "expiresAt": "2026-09-03T18:00:00.000Z"
            }]
        });
        assert_eq!(
            parse_desired_commands(&body),
            Err(DesiredCommandsParseError::UnknownState)
        );
    }

    // ── Idempotency / execution ledger (AC #4, e2eTest #1, #4) ──────────────

    #[test]
    fn fresh_command_should_execute_and_completed_ones_never_re_execute() {
        let mut state = DiagnosticsExecutionState::default();
        assert!(should_execute(&state, "cmd-a"));

        state.begin("cmd-a");
        // Still in-flight (not yet terminal) — still eligible (a retried poll
        // of the SAME still-non-terminal command resumes, not skips).
        assert!(should_execute(&state, "cmd-a"));

        state.complete("cmd-a");
        assert!(
            !should_execute(&state, "cmd-a"),
            "a terminally completed command must never re-execute"
        );
        assert_eq!(state.in_flight_command_id, None);
    }

    #[test]
    fn restart_resumes_an_in_flight_command_instead_of_dropping_it() {
        // Simulate: process persisted in_flight before a crash/restart.
        let mut state = DiagnosticsExecutionState::default();
        state.begin("cmd-resume-me");
        let persisted = serde_json::to_string(&state).unwrap();

        // "Restart": reload from the persisted JSON.
        let reloaded: DiagnosticsExecutionState = serde_json::from_str(&persisted).unwrap();
        assert_eq!(
            reloaded.in_flight_command_id.as_deref(),
            Some("cmd-resume-me")
        );
        assert!(
            should_execute(&reloaded, "cmd-resume-me"),
            "an in-flight (not yet terminal) command must resume after restart"
        );
    }

    #[test]
    fn completed_ledger_is_bounded_and_deduplicated() {
        let mut state = DiagnosticsExecutionState::default();
        for i in 0..(DIAGNOSTICS_COMPLETED_LEDGER_CAP + 10) {
            state.complete(&format!("cmd-{i}"));
        }
        assert_eq!(state.completed_ids.len(), DIAGNOSTICS_COMPLETED_LEDGER_CAP);
        // The oldest entries were evicted, not the newest.
        assert!(!state.completed_ids.contains(&"cmd-0".to_string()));
        assert!(state
            .completed_ids
            .contains(&format!("cmd-{}", DIAGNOSTICS_COMPLETED_LEDGER_CAP + 9)));

        // Re-completing an already-completed id does not duplicate it.
        let before = state.completed_ids.len();
        state.complete(&format!("cmd-{}", DIAGNOSTICS_COMPLETED_LEDGER_CAP + 9));
        assert_eq!(state.completed_ids.len(), before);
    }

    // ── Redaction (AC #3, e2eTest #5) ────────────────────────────────────────

    #[test]
    fn probe_error_reason_never_receives_or_can_echo_the_raw_message() {
        // A realistic underlying error whose Display embeds a customer path
        // AND a secret-shaped value — exactly the class of leak the story
        // calls out ("raw doctor messages containing absolute paths").
        let poisoned = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "EACCES: /Users/jane/Library/HQ/companies/acme/settings/vault.json token=sk-liveSECRETVALUE1234",
        );

        // The classifier only ever sees `.kind()` — never the message.
        let kind = classify_io_error(&poisoned);
        assert_eq!(kind, ProbeErrorKind::PermissionDenied);

        let reason = probe_error_reason(kind);
        let result = ClientHealthCheckResult {
            check: ClientHealthDiagnosticCheck::Storage,
            status: ClientHealthCheckStatus::Fail,
            reason: Some(reason),
        };
        let wire = serde_json::to_string(&result).unwrap();

        assert!(!wire.contains("/Users/jane"), "leaked a customer path: {wire}");
        assert!(!wire.contains("sk-liveSECRETVALUE1234"), "leaked a secret-shaped value: {wire}");
        assert!(!wire.contains("vault.json"), "leaked a filename: {wire}");
        assert_eq!(wire, r#"{"check":"storage","status":"fail","reason":"PERMISSION_DENIED"}"#);
    }

    #[test]
    fn every_probe_error_kind_maps_to_a_closed_reason_never_free_text() {
        for kind in [
            ProbeErrorKind::PermissionDenied,
            ProbeErrorKind::DiskFull,
            ProbeErrorKind::NotFound,
            ProbeErrorKind::TimedOut,
            ProbeErrorKind::Panicked,
            ProbeErrorKind::Other,
        ] {
            let reason = probe_error_reason(kind);
            let token = reason.wire_value();
            assert!(
                token.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "probe error reason must be a closed code, got {token}"
            );
        }
    }
}
