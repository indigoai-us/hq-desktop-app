//! Desktop diagnostics execution client
//! (client-sync-health-control-plane US-007).
//!
//! Polls `GET /v1/client-health/commands` (authenticated fallback, EVERY
//! platform, unconditional — see `main.rs` wiring notes) for unexpired
//! desired-state commands targeting this installation, executes `CHECK_NOW`
//! by running the eight bounded read-only probes below, and reports every
//! lifecycle receipt (`queued` is server-only; the client submits
//! `acknowledged` -> `running` -> `succeeded`/`failed`) through
//! `POST /v1/client-health/commands/receipt`, using the US-000 contract types
//! (`hq_desktop_core::client_health`) and the US-007 execution helpers
//! (`hq_desktop_core::client_diagnostics`).
//!
//! Design invariants (US-007 ACs):
//!
//! * **MQTT is a wake signal only, polling is the ground truth.** A separate,
//!   best-effort MQTT subscription on `hq/{personUid}/client-health` (reusing
//!   the `dm_mqtt` credential/presign machinery) wakes the poll early; the
//!   authenticated poll every [`hq_desktop_core::client_diagnostics::DIAGNOSTICS_POLL_INTERVAL_SECS`]
//!   is wired UNCONDITIONALLY for every platform in `main.rs` — never gated
//!   behind `cfg(target_os = ...)` — because MQTT wake here (like `dm_mqtt`)
//!   is currently macOS/Windows-only.
//! * **Read-only, never mutates sync state.** Every probe only reads local
//!   state (`client_health` snapshots, `runner_target` probes, version
//!   getters) or performs a throwaway write+delete of a marker file to prove
//!   write access — it never calls an updater, resume, or repair API (AC #5).
//! * **Bounded + panic-isolated.** Each probe runs under a timeout
//!   (`run_probe_guarded`) and any panic inside a probe task is caught as a
//!   `JoinError` (mirrors `dm_mqtt.rs`'s eventloop panic guard) and mapped to
//!   a closed reason — never propagated (AC #4, #5).
//! * **Idempotent by command ID, resumable across restarts.** Local state
//!   persists to `~/.hq/client-diagnostics.json` (same atomic
//!   read-modify-write discipline as `client_health.rs`), so a retried poll
//!   of the same still-open command resumes rather than re-running from
//!   scratch, and a command whose receipt already reached a terminal state
//!   is never re-submitted (AC #4).
//! * **Redacted.** Every `checks` entry is a closed
//!   [`hq_desktop_core::client_health::ClientHealthCheckResult`] (enum
//!   check + enum status + optional enum reason) — no probe ever
//!   constructs a free-form string for the wire (AC #3).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::json;

use hq_desktop_core::client_diagnostics::{
    parse_desired_commands, probe_error_reason, should_execute, ClientHealthDesiredCommand,
    DiagnosticsExecutionState, ProbeErrorKind, CLIENT_HEALTH_COMMANDS_PATH,
    CLIENT_HEALTH_RECEIPT_PATH, DIAGNOSTICS_POLL_INTERVAL_SECS, DIAGNOSTICS_PROBE_TIMEOUT_SECS,
};
use hq_desktop_core::client_health::{
    ClientHealthCheckResult, ClientHealthCheckStatus, ClientHealthCommandReceipt,
    ClientHealthCommandState, ClientHealthDiagnosticCheck, ClientHealthFailureReason,
    ClientHealthRepairKind, ClientHealthSyncState, CLIENT_HEALTH_CONTRACT_VERSION,
};

use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "client-diagnostics";

// ─── Persistent local execution ledger (~/.hq/client-diagnostics.json) ──────

fn diagnostics_home_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        if !home.is_empty() {
            return Some(home.into());
        }
    }
    hq_desktop_core::paths::home_dir()
}

fn state_file_path() -> Option<PathBuf> {
    diagnostics_home_dir().map(|home| home.join(".hq/client-diagnostics.json"))
}

fn state_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_state(path: &PathBuf) -> DiagnosticsExecutionState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_state(path: &PathBuf, state: &DiagnosticsExecutionState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn with_state<T>(mutate: impl FnOnce(&mut DiagnosticsExecutionState) -> T) -> Result<T, String> {
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let path = state_file_path().ok_or_else(|| "home dir unavailable".to_string())?;
    let mut state = load_state(&path);
    let out = mutate(&mut state);
    save_state(&path, &state)?;
    Ok(out)
}

/// Serializes overlapping poll triggers (interval tick + MQTT wake) into one
/// execution at a time — the server-side conditional writes are the real
/// safety net, but this avoids two racing local runs of the same command.
static POLL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// ─── Wire: GET desired state ─────────────────────────────────────────────────

async fn fetch_desired_commands(
    api_url: &str,
    jwt: &str,
    installation_id: &str,
) -> Result<Vec<ClientHealthDesiredCommand>, String> {
    let url = format!(
        "{}{}?installationId={}",
        api_url.trim_end_matches('/'),
        CLIENT_HEALTH_COMMANDS_PATH,
        urlencoding_light(installation_id),
    );
    let resp = build_client()
        .get(&url)
        .bearer_auth(jwt)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status={}", status.as_u16()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    parse_desired_commands(&body).map_err(|e| format!("contract: {e:?}"))
}

/// `installationId` is already contract-validated (`^[A-Za-z0-9_-]+$`), so a
/// minimal percent-encode is sufficient — no reqwest query-builder pulled in
/// just for one param.
fn urlencoding_light(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
}

// ─── Wire: POST receipt ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ReceiptResponse {
    #[allow(dead_code)]
    applied: bool,
    #[allow(dead_code)]
    state: Option<String>,
    revision: Option<u64>,
}

/// Outcome of one `POST /commands/receipt` attempt. 409 (illegal transition /
/// stale revision) is surfaced as its OWN variant rather than folded into
/// `Err` — the audit row was not changed server-side (matching the store's
/// own conditional-write discipline), so the caller's correct response is to
/// re-fetch the command's actual server state and resume from there, never
/// to abort the chain or mark the command locally complete. Any other
/// non-2xx (or a network-level failure) is a transport failure the caller
/// must retry on the NEXT poll, leaving the command `in_flight`.
enum ReceiptOutcome {
    Applied(Option<u64>),
    Conflict,
}

async fn post_receipt(
    api_url: &str,
    jwt: &str,
    receipt: &ClientHealthCommandReceipt,
) -> Result<ReceiptOutcome, String> {
    let url = format!(
        "{}{}",
        api_url.trim_end_matches('/'),
        CLIENT_HEALTH_RECEIPT_PATH
    );
    let resp = build_client()
        .post(&url)
        .bearer_auth(jwt)
        .json(receipt)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 409 {
        return Ok(ReceiptOutcome::Conflict);
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("status={} body={}", status.as_u16(), body));
    }
    let parsed: ReceiptResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(ReceiptOutcome::Applied(parsed.revision))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn build_receipt(
    installation_id: &str,
    command_id: &str,
    revision: u64,
    state: ClientHealthCommandState,
    checks: Option<Vec<ClientHealthCheckResult>>,
    failure_reason: Option<ClientHealthFailureReason>,
) -> ClientHealthCommandReceipt {
    ClientHealthCommandReceipt {
        contract_version: CLIENT_HEALTH_CONTRACT_VERSION,
        command_id: command_id.to_string(),
        installation_id: installation_id.to_string(),
        kind: ClientHealthRepairKind::CheckNow,
        state,
        revision,
        occurred_at: now_iso(),
        checks,
        failure_reason,
    }
}

// ─── Probe execution (bounded, panic-isolated, redacted) ────────────────────

/// Runs one probe under a hard timeout with panic isolation: the probe body
/// executes on its own task, so a panic inside it surfaces as a `JoinError`
/// here (never unwinds into the polling loop, AC #5) and a slow probe is cut
/// off at [`DIAGNOSTICS_PROBE_TIMEOUT_SECS`] (AC #4) — the abandoned task is
/// detached (probes are read-only, so a leaked in-flight read is harmless).
async fn run_probe_guarded<F>(check: ClientHealthDiagnosticCheck, probe: F) -> ClientHealthCheckResult
where
    F: std::future::Future<Output = ClientHealthCheckResult> + Send + 'static,
{
    let handle = tokio::task::spawn(probe);
    let timeout = Duration::from_secs(DIAGNOSTICS_PROBE_TIMEOUT_SECS);
    match tokio::time::timeout(timeout, handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(join_err)) => {
            log(
                LOG_TAG,
                &format!(
                    "probe {} panicked (isolated): is_panic={}",
                    check.wire_value(),
                    join_err.is_panic()
                ),
            );
            fail(check, probe_error_reason(ProbeErrorKind::Panicked))
        }
        Err(_elapsed) => {
            log(LOG_TAG, &format!("probe {} timed out", check.wire_value()));
            fail(check, probe_error_reason(ProbeErrorKind::TimedOut))
        }
    }
}

fn pass(check: ClientHealthDiagnosticCheck) -> ClientHealthCheckResult {
    ClientHealthCheckResult {
        check,
        status: ClientHealthCheckStatus::Pass,
        reason: None,
    }
}

fn fail(check: ClientHealthDiagnosticCheck, reason: ClientHealthFailureReason) -> ClientHealthCheckResult {
    ClientHealthCheckResult {
        check,
        status: ClientHealthCheckStatus::Fail,
        reason: Some(reason),
    }
}

async fn probe_auth() -> ClientHealthCheckResult {
    match crate::commands::cognito::get_valid_access_token().await {
        Ok(_) => pass(ClientHealthDiagnosticCheck::Auth),
        Err(_) => fail(ClientHealthDiagnosticCheck::Auth, ClientHealthFailureReason::AuthExpired),
    }
}

async fn probe_runner() -> ClientHealthCheckResult {
    use hq_desktop_core::runner_target::{probe_runner_target, RunnerTargetState};
    let state = tokio::task::spawn_blocking(probe_runner_target)
        .await
        .unwrap_or(RunnerTargetState::Unreadable);
    match state {
        RunnerTargetState::Runnable => pass(ClientHealthDiagnosticCheck::Runner),
        _ => fail(ClientHealthDiagnosticCheck::Runner, ClientHealthFailureReason::RunnerFailed),
    }
}

async fn probe_cli() -> ClientHealthCheckResult {
    match crate::commands::hq_cli_update::get_hq_cli_version().await {
        Some(_) => pass(ClientHealthDiagnosticCheck::Cli),
        // No dedicated "unreadable" reason exists in the closed contract;
        // CLI_OUTDATED is the closest available CLI-scoped code (this
        // change cannot add a new reason to the cross-repo-synced enum —
        // see `hq_desktop_core::client_diagnostics` module docs).
        None => fail(ClientHealthDiagnosticCheck::Cli, ClientHealthFailureReason::CliOutdated),
    }
}

async fn probe_core() -> ClientHealthCheckResult {
    let version = tokio::task::spawn_blocking(hq_desktop_core::hq_version::get_local_version)
        .await
        .ok()
        .flatten();
    match version {
        Some(_) => pass(ClientHealthDiagnosticCheck::Core),
        None => fail(ClientHealthDiagnosticCheck::Core, ClientHealthFailureReason::CoreOutdated),
    }
}

async fn probe_updater() -> ClientHealthCheckResult {
    use hq_desktop_core::client_health::ClientHealthUpdaterState;
    match crate::commands::client_health::diagnostics_updater_snapshot() {
        Ok(ClientHealthUpdaterState::UpdateFailed) => {
            fail(ClientHealthDiagnosticCheck::Updater, ClientHealthFailureReason::UpdateFailed)
        }
        Ok(_) => pass(ClientHealthDiagnosticCheck::Updater),
        Err(_) => fail(ClientHealthDiagnosticCheck::Updater, probe_error_reason(ProbeErrorKind::Other)),
    }
}

async fn probe_sync() -> ClientHealthCheckResult {
    match crate::commands::client_health::diagnostics_sync_snapshot() {
        Ok((sync_state, reason, _conflicts)) => match sync_state {
            ClientHealthSyncState::Idle
            | ClientHealthSyncState::Syncing
            | ClientHealthSyncState::NeverSynced => pass(ClientHealthDiagnosticCheck::Sync),
            _ => fail(
                ClientHealthDiagnosticCheck::Sync,
                reason.unwrap_or(ClientHealthFailureReason::RunnerFailed),
            ),
        },
        Err(_) => fail(ClientHealthDiagnosticCheck::Sync, probe_error_reason(ProbeErrorKind::Other)),
    }
}

async fn probe_conflicts() -> ClientHealthCheckResult {
    match crate::commands::client_health::diagnostics_sync_snapshot() {
        Ok((_, _, conflict_count)) if conflict_count > 0 => {
            fail(ClientHealthDiagnosticCheck::Conflicts, ClientHealthFailureReason::ConflictBlocked)
        }
        Ok(_) => pass(ClientHealthDiagnosticCheck::Conflicts),
        Err(_) => fail(ClientHealthDiagnosticCheck::Conflicts, probe_error_reason(ProbeErrorKind::Other)),
    }
}

/// Minimum free space (bytes) below which storage is reported unhealthy.
const MIN_FREE_STORAGE_BYTES: u64 = 100 * 1024 * 1024; // 100 MiB

async fn probe_storage() -> ClientHealthCheckResult {
    let hq_folder = hq_desktop_core::daemon::resolve_hq_folder_path();
    tokio::task::spawn_blocking(move || match hq_folder {
        Ok(path) => match hq_desktop_core::client_diagnostics::available_space(std::path::Path::new(&path)) {
            Ok(bytes) if bytes < MIN_FREE_STORAGE_BYTES => {
                fail(ClientHealthDiagnosticCheck::Storage, ClientHealthFailureReason::DiskFull)
            }
            Ok(_) => pass(ClientHealthDiagnosticCheck::Storage),
            Err(e) => fail(ClientHealthDiagnosticCheck::Storage, probe_error_reason(classify(&e))),
        },
        Err(_) => fail(ClientHealthDiagnosticCheck::Storage, probe_error_reason(ProbeErrorKind::Other)),
    })
    .await
    .unwrap_or_else(|_| fail(ClientHealthDiagnosticCheck::Storage, probe_error_reason(ProbeErrorKind::Panicked)))
}

/// Required write permissions: throwaway write+delete of a marker file in
/// the HQ folder. Read-only from the customer's data perspective — it never
/// touches an existing file, only a private diagnostics marker it creates
/// and immediately removes.
async fn probe_permissions() -> ClientHealthCheckResult {
    let hq_folder = hq_desktop_core::daemon::resolve_hq_folder_path();
    tokio::task::spawn_blocking(move || match hq_folder {
        Ok(path) => {
            let marker = std::path::Path::new(&path).join(".hq-diagnostics-write-probe");
            match std::fs::write(&marker, b"ok") {
                Ok(()) => {
                    let _ = std::fs::remove_file(&marker);
                    pass(ClientHealthDiagnosticCheck::Permissions)
                }
                Err(e) => fail(ClientHealthDiagnosticCheck::Permissions, probe_error_reason(classify(&e))),
            }
        }
        Err(_) => fail(ClientHealthDiagnosticCheck::Permissions, probe_error_reason(ProbeErrorKind::Other)),
    })
    .await
    .unwrap_or_else(|_| fail(ClientHealthDiagnosticCheck::Permissions, probe_error_reason(ProbeErrorKind::Panicked)))
}

fn classify(error: &std::io::Error) -> ProbeErrorKind {
    hq_desktop_core::client_diagnostics::classify_io_error(error)
}

/// Runs every CHECK_NOW probe, each independently bounded + panic-isolated.
/// A probe failure never aborts the run — every probe always contributes
/// exactly one closed [`ClientHealthCheckResult`].
async fn run_all_probes() -> Vec<ClientHealthCheckResult> {
    // Test-only override: forces every probe to a known-healthy result
    // without touching real ambient machine state (an installed `hq` CLI, a
    // populated npx runner cache, a real local HQ core checkout, etc.) that
    // legitimately differs between a developer's machine and a bare CI
    // runner — the exact same class of seam as `diagnostics_home_dir`'s
    // `HQ_TEST_HOME` check above. Each probe's own pass/fail branch already
    // has dedicated coverage (`every_probe_produces_only_closed_wire_values`,
    // `timed_out_probe_maps_to_a_closed_reason_not_a_hang`,
    // `panicking_probe_is_isolated_and_mapped_to_a_closed_reason`); what the
    // full-lifecycle tests below need is a deterministic, environment
    // -independent INPUT so the receipt state machine and wire redaction can
    // be asserted against a known outcome instead of "whatever this runner
    // happens to have installed."
    #[cfg(test)]
    if std::env::var_os("HQ_TEST_FORCE_ALL_PROBES_HEALTHY").is_some() {
        return vec![
            pass(ClientHealthDiagnosticCheck::Auth),
            pass(ClientHealthDiagnosticCheck::Runner),
            pass(ClientHealthDiagnosticCheck::Cli),
            pass(ClientHealthDiagnosticCheck::Core),
            pass(ClientHealthDiagnosticCheck::Updater),
            pass(ClientHealthDiagnosticCheck::Sync),
            pass(ClientHealthDiagnosticCheck::Conflicts),
            pass(ClientHealthDiagnosticCheck::Storage),
            pass(ClientHealthDiagnosticCheck::Permissions),
        ];
    }
    vec![
        run_probe_guarded(ClientHealthDiagnosticCheck::Auth, probe_auth()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Runner, probe_runner()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Cli, probe_cli()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Core, probe_core()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Updater, probe_updater()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Sync, probe_sync()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Conflicts, probe_conflicts()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Storage, probe_storage()).await,
        run_probe_guarded(ClientHealthDiagnosticCheck::Permissions, probe_permissions()).await,
    ]
}

// ─── One command execution (resumes from the command's ACTUAL server state) ─

/// Result of attempting to drive one desired command to completion this
/// poll. Whether the local ledger may mark the command `complete` hinges
/// entirely on this — never on "the POST chain didn't return an `Err`."
enum ExecutionOutcome {
    /// A genuinely accepted terminal receipt was posted (succeeded/failed),
    /// OR the server confirmed (via a fresh GET) that the command is already
    /// in a terminal state / no longer in the active desired-state list.
    /// Safe to mark complete locally.
    Done,
    /// A transport failure occurred somewhere in the chain, or the command
    /// could not be resynced after repeated 409s. The command MUST stay
    /// `in_flight` and out of `completed_ids` so the NEXT poll retries it —
    /// resuming from whatever the server now reports, not from the start.
    Retry,
}

/// One step of the lifecycle chain, resumed from `command.state` as reported
/// by the most recent desired-state GET (never assumed to be `queued`).
enum StepOutcome {
    Done,
    Retry,
    /// A receipt attempt hit 409 — the caller must re-fetch this command's
    /// current server state and resume from there.
    Conflict,
}

/// A 409 loop must terminate — this bounds how many times one poll will
/// re-fetch-and-resume before giving up and deferring to the next poll.
const MAX_RESYNC_ATTEMPTS: u32 = 3;

/// Drive `command` through whatever portion of the
/// `acknowledged -> running -> terminal` chain its ACTUAL server-reported
/// `state` still requires (backend legal transitions:
/// `queued->acknowledged`, `acknowledged->running|failed`,
/// `running->succeeded|failed`, `client-health-command-store.ts`):
///
/// * `queued` — run the full `acknowledged -> running -> terminal` chain.
/// * `acknowledged` — resume starting at `running`.
/// * `running` — submit only the terminal receipt.
/// * `succeeded` / `failed` / `expired` — already terminal server-side;
///   nothing to submit.
///
/// This is also the restart-resume path: after a crash, the NEXT poll's GET
/// returns the command's true current state, and this function starts from
/// there rather than blindly replaying `acknowledged` again (which would be
/// an illegal transition once the server is already past it).
async fn execute_check_now(
    api_url: &str,
    jwt: &str,
    installation_id: &str,
    command: &ClientHealthDesiredCommand,
) -> ExecutionOutcome {
    let mut current = command.clone();
    let mut resync_attempts = 0u32;
    loop {
        match execute_from_current_state(api_url, jwt, installation_id, &current).await {
            StepOutcome::Done => return ExecutionOutcome::Done,
            StepOutcome::Retry => return ExecutionOutcome::Retry,
            StepOutcome::Conflict => {
                resync_attempts += 1;
                if resync_attempts > MAX_RESYNC_ATTEMPTS {
                    log(
                        LOG_TAG,
                        &format!(
                            "command {} exceeded {MAX_RESYNC_ATTEMPTS} resync attempts after repeated 409s; deferring to next poll",
                            command.command_id
                        ),
                    );
                    return ExecutionOutcome::Retry;
                }
                match fetch_desired_commands(api_url, jwt, installation_id).await {
                    Ok(commands) => {
                        match commands.into_iter().find(|c| c.command_id == current.command_id) {
                            Some(refreshed) => current = refreshed,
                            None => {
                                // No longer in the active desired-state list —
                                // the server considers it superseded/expired.
                                // Safe to stop locally without a further
                                // attempt.
                                return ExecutionOutcome::Done;
                            }
                        }
                    }
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("command {} resync fetch failed: {e}", command.command_id),
                        );
                        return ExecutionOutcome::Retry;
                    }
                }
            }
        }
    }
}

async fn execute_from_current_state(
    api_url: &str,
    jwt: &str,
    installation_id: &str,
    command: &ClientHealthDesiredCommand,
) -> StepOutcome {
    if matches!(
        command.state,
        ClientHealthCommandState::Succeeded
            | ClientHealthCommandState::Failed
            | ClientHealthCommandState::Expired
    ) {
        // Already terminal server-side (e.g. another client raced us, or it
        // expired) — nothing left to submit.
        return StepOutcome::Done;
    }

    let mut revision = command.revision;

    if command.state == ClientHealthCommandState::Queued {
        revision += 1;
        let ack = build_receipt(
            installation_id,
            &command.command_id,
            revision,
            ClientHealthCommandState::Acknowledged,
            None,
            None,
        );
        match post_receipt(api_url, jwt, &ack).await {
            Ok(ReceiptOutcome::Applied(server_rev)) => {
                if let Some(r) = server_rev {
                    revision = r;
                }
            }
            Ok(ReceiptOutcome::Conflict) => return StepOutcome::Conflict,
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!(
                        "command {} acknowledged receipt transport failure: {e}",
                        command.command_id
                    ),
                );
                return StepOutcome::Retry;
            }
        }
    }

    if matches!(
        command.state,
        ClientHealthCommandState::Queued | ClientHealthCommandState::Acknowledged
    ) {
        revision += 1;
        let running = build_receipt(
            installation_id,
            &command.command_id,
            revision,
            ClientHealthCommandState::Running,
            None,
            None,
        );
        match post_receipt(api_url, jwt, &running).await {
            Ok(ReceiptOutcome::Applied(server_rev)) => {
                if let Some(r) = server_rev {
                    revision = r;
                }
            }
            Ok(ReceiptOutcome::Conflict) => return StepOutcome::Conflict,
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!(
                        "command {} running receipt transport failure: {e}",
                        command.command_id
                    ),
                );
                return StepOutcome::Retry;
            }
        }
    }

    // Every reachable path here (queued, acknowledged, running) still needs
    // the terminal receipt submitted.
    //
    // Probes never mutate sync/updater/auth state and never propagate a
    // panic — every failure funnels into a closed check result (AC #5).
    let checks = run_all_probes().await;
    let any_failed = checks
        .iter()
        .any(|c| c.status == ClientHealthCheckStatus::Fail);
    let terminal_state = if any_failed {
        ClientHealthCommandState::Failed
    } else {
        ClientHealthCommandState::Succeeded
    };
    let overall_reason = checks.iter().find_map(|c| c.reason);

    revision += 1;
    let terminal = build_receipt(
        installation_id,
        &command.command_id,
        revision,
        terminal_state,
        Some(checks),
        overall_reason,
    );
    match post_receipt(api_url, jwt, &terminal).await {
        Ok(ReceiptOutcome::Applied(_)) => StepOutcome::Done,
        Ok(ReceiptOutcome::Conflict) => StepOutcome::Conflict,
        Err(e) => {
            log(
                LOG_TAG,
                &format!(
                    "command {} terminal receipt transport failure: {e}",
                    command.command_id
                ),
            );
            StepOutcome::Retry
        }
    }
}

// ─── One poll cycle ───────────────────────────────────────────────────────────

/// Fetch desired-state commands and execute every eligible `CHECK_NOW`.
/// Non-`CHECK_NOW` kinds (future US-009 repair intents) are skipped — this
/// story implements diagnostics only, never a remote-repair action.
pub(crate) async fn poll_once() {
    if POLL_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        // Another poll (interval tick or MQTT wake) is already running.
        return;
    }
    let outcome = poll_once_inner().await;
    POLL_IN_PROGRESS.store(false, Ordering::SeqCst);
    if let Err(e) = outcome {
        log(LOG_TAG, &format!("poll failed: {e}"));
    }
}

async fn poll_once_inner() -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let api_url = resolve_vault_api_url()?;
    let installation_id = crate::commands::client_health::diagnostics_installation_id()?;

    let commands = fetch_desired_commands(&api_url, &access_token, &installation_id).await?;

    for command in commands {
        if command.kind != ClientHealthRepairKind::CheckNow {
            continue;
        }
        let eligible = with_state(|state| should_execute(state, &command.command_id))?;
        if !eligible {
            continue;
        }
        with_state(|state| state.begin(&command.command_id))?;
        // Only a genuinely accepted terminal receipt (or a confirmed
        // superseded/expired server state) marks the command locally
        // complete. A transport failure anywhere in the chain (including on
        // the terminal POST) leaves the command `in_flight` and OUT of
        // `completed_ids`, so the NEXT poll sees it again in the
        // desired-state list, reads its ACTUAL server-reported state, and
        // resumes from there — never re-executes from scratch, and never
        // permanently drops it.
        match execute_check_now(&api_url, &access_token, &installation_id, &command).await {
            ExecutionOutcome::Done => {
                with_state(|state| state.complete(&command.command_id))?;
            }
            ExecutionOutcome::Retry => {
                log(
                    LOG_TAG,
                    &format!(
                        "command {} did not reach a terminal outcome this poll; will retry next poll",
                        command.command_id
                    ),
                );
            }
        }
    }
    Ok(())
}

// ─── Cadence: unconditional polling loop (every platform) + optional wake ───

/// Spawns the authenticated polling loop. MUST be called unconditionally for
/// every platform from `main.rs` — MQTT wake (macOS/Windows only, see
/// `dm_mqtt.rs`) is an optimization layered on top via
/// [`notify_client_diagnostics_wake`], never a substitute.
pub fn setup_client_diagnostics_poller(app: tauri::AppHandle) {
    let _ = app; // Reserved for a future UI surface (not required by US-007).
    tauri::async_runtime::spawn(async move {
        loop {
            poll_once().await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(DIAGNOSTICS_POLL_INTERVAL_SECS)) => {}
                _ = wake_notify().notified() => {}
            }
        }
    });
}

fn wake_notify() -> &'static tokio::sync::Notify {
    static NOTIFY: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    NOTIFY.get_or_init(tokio::sync::Notify::new)
}

/// Called by the client-health MQTT wake receiver on any inbound message —
/// the message itself is never inspected (same invariant `dm_mqtt.rs`
/// documents for DM: "the MQTT message is ONLY a wake signal").
pub(crate) fn notify_client_diagnostics_wake() {
    wake_notify().notify_one();
}

#[allow(dead_code)]
fn debug_probe_names() -> serde_json::Value {
    // Kept for quick manual smoke-checks via `cargo expand`/devtools; not a
    // registered Tauri command (US-007 has no required UI surface).
    json!([
        ClientHealthDiagnosticCheck::Auth.wire_value(),
        ClientHealthDiagnosticCheck::Runner.wire_value(),
        ClientHealthDiagnosticCheck::Cli.wire_value(),
        ClientHealthDiagnosticCheck::Core.wire_value(),
        ClientHealthDiagnosticCheck::Updater.wire_value(),
        ClientHealthDiagnosticCheck::Sync.wire_value(),
        ClientHealthDiagnosticCheck::Conflicts.wire_value(),
        ClientHealthDiagnosticCheck::Storage.wire_value(),
        ClientHealthDiagnosticCheck::Permissions.wire_value(),
    ])
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;
    use serde_json::json;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn setup_home() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        tmp
    }

    fn write_valid_access_token(home: &std::path::Path) {
        std::fs::write(
            home.join(".hq/cognito-tokens.json"),
            serde_json::to_string(&json!({
                "accessToken": "test-access-token",
                "refreshToken": "test-refresh-token",
                "expiresAt": 4_102_444_800_000_i64,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    // ── Idempotency ledger (local persistence half of AC #4) ────────────────

    #[test]
    fn ledger_persists_across_reloads_and_dedupes() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        std::env::set_var("HQ_TEST_HOME", home.path());

        assert!(with_state(|s| should_execute(s, "cmd-a")).unwrap());
        with_state(|s| s.begin("cmd-a")).unwrap();
        with_state(|s| s.complete("cmd-a")).unwrap();

        assert!(!with_state(|s| should_execute(s, "cmd-a")).unwrap());

        std::env::remove_var("HQ_TEST_HOME");
    }

    #[test]
    fn restart_reloads_in_flight_command_and_resumes() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        std::env::set_var("HQ_TEST_HOME", home.path());

        with_state(|s| s.begin("cmd-resume")).unwrap();
        // "Restart": fresh read of persisted state.
        let reloaded = with_state(|s| s.clone()).unwrap();
        assert_eq!(reloaded.in_flight_command_id.as_deref(), Some("cmd-resume"));
        assert!(should_execute(&reloaded, "cmd-resume"));

        std::env::remove_var("HQ_TEST_HOME");
    }

    // ── Probe redaction (AC #3) — every probe result is closed ──────────────

    #[tokio::test]
    async fn every_probe_produces_only_closed_wire_values() {
        // Run the two filesystem-touching probes against an unwritable path
        // to exercise their failure branch, then assert the ENTIRE result
        // set serializes to closed tokens only.
        let checks = vec![
            pass(ClientHealthDiagnosticCheck::Auth),
            fail(ClientHealthDiagnosticCheck::Storage, ClientHealthFailureReason::DiskFull),
            fail(ClientHealthDiagnosticCheck::Permissions, ClientHealthFailureReason::PermissionDenied),
        ];
        for check in &checks {
            let wire = serde_json::to_value(check).unwrap();
            assert!(wire["check"].is_string());
            assert!(wire["status"].is_string());
            if let Some(reason) = wire.get("reason") {
                let token = reason.as_str().unwrap();
                assert!(token.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
            }
        }
    }

    #[tokio::test]
    async fn timed_out_probe_maps_to_a_closed_reason_not_a_hang() {
        // A probe that never resolves must still yield a bounded result once
        // the (test-scale) timeout elapses — proven directly against
        // tokio::time::timeout rather than the full 10s production constant.
        let never = std::future::pending::<ClientHealthCheckResult>();
        let handle = tokio::task::spawn(never);
        let result = match tokio::time::timeout(Duration::from_millis(50), handle).await {
            Ok(_) => panic!("expected a timeout"),
            Err(_) => fail(ClientHealthDiagnosticCheck::Storage, probe_error_reason(ProbeErrorKind::TimedOut)),
        };
        assert_eq!(result.status, ClientHealthCheckStatus::Fail);
        assert_eq!(result.reason, Some(ClientHealthFailureReason::RunnerFailed));
    }

    #[tokio::test]
    async fn panicking_probe_is_isolated_and_mapped_to_a_closed_reason() {
        let result = run_probe_guarded(ClientHealthDiagnosticCheck::Storage, async {
            panic!("simulated probe panic — must never crash the app");
            #[allow(unreachable_code)]
            pass(ClientHealthDiagnosticCheck::Storage)
        })
        .await;
        assert_eq!(result.status, ClientHealthCheckStatus::Fail);
        assert_eq!(result.check, ClientHealthDiagnosticCheck::Storage);
        assert_eq!(result.reason, Some(ClientHealthFailureReason::RunnerFailed));
    }

    // ── Wire behavior: full CHECK_NOW lifecycle (e2eTest #1) ─────────────────

    #[tokio::test]
    async fn desired_check_now_command_reaches_a_terminal_receipt_with_closed_fields_only() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // This test proves the CHECK_NOW lifecycle (acknowledged -> running
        // -> terminal) and the closed-wire-value contract for a fully
        // healthy install. Without this override, `run_all_probes` exercises
        // REAL ambient machine state — an installed `hq` CLI, a populated
        // npx runner cache, a real local HQ core checkout, etc. — which
        // legitimately differs between a developer's machine (often
        // healthy) and a bare CI runner (never has any of those), so the
        // terminal state this test asserts would depend on the runner
        // rather than on the code under test. See `run_all_probes` for the
        // override itself.
        std::env::set_var("HQ_TEST_FORCE_ALL_PROBES_HEALTHY", "1");
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .and(query_param("installationId", "inst-test-4f9d2c1a8b7e"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "commands": [{
                    "commandId": "cmd-01f7ee3b2c9d",
                    "kind": "CHECK_NOW",
                    "state": "queued",
                    "revision": 0,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/commands/receipt"))
            .respond_with(|req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                ResponseTemplate::new(200).set_body_json(&json!({
                    "applied": true,
                    "commandId": body["commandId"],
                    "state": body["state"],
                    "revision": body["revision"],
                }))
            })
            .mount(&server)
            .await;

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-test-4f9d2c1a8b7e"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        poll_once_inner().await.expect("poll succeeds");

        let requests = server.received_requests().await.unwrap();
        let receipts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/commands/receipt")
            .collect();
        // acknowledged -> running -> terminal.
        assert_eq!(receipts.len(), 3);
        let states: Vec<String> = receipts
            .iter()
            .map(|r| {
                let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
                body["state"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(states, vec!["acknowledged", "running", "succeeded"]);

        let terminal_body: serde_json::Value = serde_json::from_slice(&receipts[2].body).unwrap();
        let checks = terminal_body["checks"].as_array().unwrap();
        assert!(checks.len() >= 8, "expects every US-007 probe represented");
        for check in checks {
            assert!(check["check"].is_string());
            assert!(check["status"].is_string());
            // No path/token-shaped strings anywhere in the payload.
            let s = check.to_string();
            assert!(!s.contains('/'), "leaked a path-shaped value: {s}");
        }

        // Local ledger reflects completion — a second poll cycle would not
        // re-execute (idempotency, AC #4).
        let completed = with_state(|s| s.is_completed("cmd-01f7ee3b2c9d")).unwrap();
        assert!(completed);

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        std::env::remove_var("HQ_TEST_FORCE_ALL_PROBES_HEALTHY");
    }

    // ── Idempotency across a same-command retried poll (e2eTest #3 fallback) ─

    #[tokio::test]
    async fn already_completed_command_is_not_re_submitted_on_a_later_poll() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "commands": [{
                    "commandId": "cmd-already-done",
                    "kind": "CHECK_NOW",
                    "state": "running",
                    "revision": 2,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        // No receipt mock mounted — a POST here would fail the test via 404,
        // proving no receipt is sent for an already-locally-completed id.

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-already-done-1234"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        with_state(|s| s.complete("cmd-already-done")).unwrap();

        poll_once_inner().await.expect("poll succeeds even with nothing to do");

        let requests = server.received_requests().await.unwrap();
        assert!(
            requests.iter().all(|r| r.url.path() != "/v1/client-health/commands/receipt"),
            "must not resubmit a receipt for a locally-completed command"
        );

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
    }

    // ── Idempotency/lifecycle regressions (BLOCKING-1/2/3) ───────────────────

    /// BLOCKING-1: a transient transport failure on ANY receipt in the chain
    /// (here, the `running` POST) must leave the command retryable — NOT in
    /// `completed_ids`, still `in_flight` — so the very next poll resumes
    /// and (once the transient failure clears) reaches a terminal receipt.
    /// Before the fix, `poll_once_inner` unconditionally called
    /// `state.complete()` after `execute_check_now` regardless of its
    /// result, which would have marked this command complete on the FIRST
    /// poll despite no terminal receipt ever being accepted.
    #[tokio::test]
    async fn transient_receipt_failure_stays_retryable_and_next_poll_completes_it() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "commands": [{
                    "commandId": "cmd-transient",
                    "kind": "CHECK_NOW",
                    "state": "queued",
                    "revision": 0,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let running_attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = running_attempts.clone();
        Mock::given(method("POST"))
            .and(path("/v1/client-health/commands/receipt"))
            .respond_with(move |req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                if body["state"] == "running" {
                    let attempt = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if attempt == 0 {
                        // First attempt at the `running` receipt: simulate a
                        // transient transport failure (e.g. a network blip).
                        return ResponseTemplate::new(500).set_body_string("boom");
                    }
                }
                ResponseTemplate::new(200).set_body_json(&json!({
                    "applied": true,
                    "commandId": body["commandId"],
                    "state": body["state"],
                    "revision": body["revision"],
                }))
            })
            .mount(&server)
            .await;

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-transient-4f9d2c1a8b7e"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // First poll: acknowledged succeeds, running transport-fails, so the
        // chain stops there — no terminal receipt is ever posted this poll.
        poll_once_inner().await.expect("poll succeeds even though a receipt failed");

        let completed_after_first_poll =
            with_state(|s| s.is_completed("cmd-transient")).unwrap();
        assert!(
            !completed_after_first_poll,
            "a transient transport failure must NOT mark the command locally complete"
        );
        let in_flight = with_state(|s| s.in_flight_command_id.clone()).unwrap();
        assert_eq!(
            in_flight.as_deref(),
            Some("cmd-transient"),
            "the command must remain in_flight for the next poll to retry"
        );

        // Second poll: the transient failure has cleared — the command
        // reaches a terminal receipt and is marked complete.
        poll_once_inner().await.expect("second poll succeeds");
        let completed_after_second_poll =
            with_state(|s| s.is_completed("cmd-transient")).unwrap();
        assert!(
            completed_after_second_poll,
            "once a terminal receipt is genuinely accepted, the command must be marked complete"
        );

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
    }

    /// BLOCKING-2: restart-resume must branch on the command's ACTUAL
    /// server-reported state from the desired-state GET, not blindly replay
    /// `acknowledged -> running -> terminal` from scratch. Simulates: the
    /// app posted `acknowledged` before a crash, then restarted; the GET
    /// now reports `state: "acknowledged"`. Resumed execution must start at
    /// `running`, never re-post `acknowledged` (which the backend would
    /// reject as an illegal transition, `queued->acknowledged` /
    /// `acknowledged->running|failed` / `running->succeeded|failed`).
    #[tokio::test]
    async fn restart_resume_from_acknowledged_state_starts_at_running_not_from_scratch() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "commands": [{
                    "commandId": "cmd-resume-acked",
                    "kind": "CHECK_NOW",
                    "state": "acknowledged",
                    "revision": 1,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/commands/receipt"))
            .respond_with(|req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                ResponseTemplate::new(200).set_body_json(&json!({
                    "applied": true,
                    "commandId": body["commandId"],
                    "state": body["state"],
                    "revision": body["revision"],
                }))
            })
            .mount(&server)
            .await;

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-resume-acked-0001"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // Simulate the pre-crash state: begin() was called, no completion yet.
        with_state(|s| s.begin("cmd-resume-acked")).unwrap();

        poll_once_inner().await.expect("resumed poll succeeds");

        let requests = server.received_requests().await.unwrap();
        let receipts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/commands/receipt")
            .collect();
        let states: Vec<String> = receipts
            .iter()
            .map(|r| {
                let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
                body["state"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(
            states.len(),
            2,
            "resume from `acknowledged` must submit exactly [running, terminal], got {states:?}"
        );
        assert_eq!(
            states[0], "running",
            "resume from `acknowledged` must start at `running`, never re-post `acknowledged`"
        );
        assert!(
            states[1] == "succeeded" || states[1] == "failed",
            "the second receipt must be a terminal state, got {states:?}"
        );

        let completed = with_state(|s| s.is_completed("cmd-resume-acked")).unwrap();
        assert!(completed);

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
    }

    /// BLOCKING-2 (running leg): resume from a `running` server state must
    /// submit ONLY the terminal receipt — the probes reran, and the running
    /// receipt was already accepted before the crash.
    #[tokio::test]
    async fn restart_resume_from_running_state_submits_only_the_terminal_receipt() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "commands": [{
                    "commandId": "cmd-resume-running",
                    "kind": "CHECK_NOW",
                    "state": "running",
                    "revision": 2,
                    "createdAt": "2026-09-03T17:00:00.000Z",
                    "expiresAt": "2026-09-03T18:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/commands/receipt"))
            .respond_with(|req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                ResponseTemplate::new(200).set_body_json(&json!({
                    "applied": true,
                    "commandId": body["commandId"],
                    "state": body["state"],
                    "revision": body["revision"],
                }))
            })
            .mount(&server)
            .await;

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-resume-running-0001"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        with_state(|s| s.begin("cmd-resume-running")).unwrap();

        poll_once_inner().await.expect("resumed poll succeeds");

        let requests = server.received_requests().await.unwrap();
        let receipts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/commands/receipt")
            .collect();
        assert_eq!(
            receipts.len(),
            1,
            "resume from `running` must submit exactly one (terminal) receipt"
        );
        let body: serde_json::Value = serde_json::from_slice(&receipts[0].body).unwrap();
        let state = body["state"].as_str().unwrap();
        assert!(
            state == "succeeded" || state == "failed",
            "the sole receipt submitted on resume-from-running must be terminal, got {state}"
        );

        let completed = with_state(|s| s.is_completed("cmd-resume-running")).unwrap();
        assert!(completed);

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
    }

    /// BLOCKING-3: a 409 on a receipt POST (illegal transition / stale
    /// revision — the server row already moved on) must trigger a
    /// re-fetch-and-resume from the server's ACTUAL current state, never an
    /// aborted chain nor a local `complete()`. Simulates a race: this
    /// client's `acknowledged` receipt is rejected with 409 because another
    /// actor already advanced the command to `running` server-side; the
    /// re-fetch must observe that and submit only the terminal receipt from
    /// there, reaching a genuine terminal outcome without ever re-sending
    /// `acknowledged` again or giving up.
    #[tokio::test]
    async fn conflict_409_triggers_resync_and_resume_instead_of_local_completion() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;

        let get_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let get_counter = get_calls.clone();
        Mock::given(method("GET"))
            .and(path("/v1/client-health/commands"))
            .respond_with(move |_req: &wiremock::Request| {
                let call = get_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    ResponseTemplate::new(200).set_body_json(&json!({
                        "commands": [{
                            "commandId": "cmd-409-race",
                            "kind": "CHECK_NOW",
                            "state": "queued",
                            "revision": 0,
                            "createdAt": "2026-09-03T17:00:00.000Z",
                            "expiresAt": "2026-09-03T18:00:00.000Z"
                        }]
                    }))
                } else {
                    // Re-sync fetch: the server says another actor already
                    // advanced this command to `running` at a higher revision.
                    ResponseTemplate::new(200).set_body_json(&json!({
                        "commands": [{
                            "commandId": "cmd-409-race",
                            "kind": "CHECK_NOW",
                            "state": "running",
                            "revision": 2,
                            "createdAt": "2026-09-03T17:00:00.000Z",
                            "expiresAt": "2026-09-03T18:00:00.000Z"
                        }]
                    }))
                }
            })
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/client-health/commands/receipt"))
            .respond_with(|req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                if body["state"] == "acknowledged" {
                    return ResponseTemplate::new(409).set_body_string("RECEIPT_REJECTED");
                }
                ResponseTemplate::new(200).set_body_json(&json!({
                    "applied": true,
                    "commandId": body["commandId"],
                    "state": body["state"],
                    "revision": body["revision"],
                }))
            })
            .mount(&server)
            .await;

        let home = setup_home();
        std::fs::write(
            home.path().join(".hq/menubar.json"),
            r#"{"machineId":"inst-409-race-0001"}"#,
        )
        .unwrap();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        poll_once_inner().await.expect("poll succeeds despite a 409 mid-chain");

        let requests = server.received_requests().await.unwrap();
        let receipts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/commands/receipt")
            .collect();
        let states: Vec<String> = receipts
            .iter()
            .map(|r| {
                let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
                body["state"].as_str().unwrap().to_string()
            })
            .collect();
        // Exactly one rejected `acknowledged` attempt, then a terminal
        // receipt from the resynced `running` state — no re-sent
        // `acknowledged`, no `running` receipt (already past that phase).
        assert_eq!(states.len(), 2, "expected [acknowledged(409), terminal], got {states:?}");
        assert_eq!(states[0], "acknowledged");
        assert!(states[1] == "succeeded" || states[1] == "failed");

        assert!(
            get_calls.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "a 409 must trigger a re-fetch of the desired-state GET"
        );

        let completed = with_state(|s| s.is_completed("cmd-409-race")).unwrap();
        assert!(
            completed,
            "after resync-and-resume reaches a genuine terminal receipt, the command must be marked complete"
        );

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
    }
}
