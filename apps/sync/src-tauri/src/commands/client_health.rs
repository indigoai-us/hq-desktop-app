//! Authoritative desktop + sync health reporter
//! (client-sync-health-control-plane US-002).
//!
//! Sends an authenticated heartbeat to `POST /v1/client-health/heartbeat`
//! (hq-pro US-001) on startup, every five minutes while the app runs, and
//! immediately after sync, updater, authentication, pause, conflict, or
//! repair state changes. The wire contract is the US-000 Rust adapter
//! (`hq_desktop_core::client_health`) — every outgoing payload is
//! self-checked against `parse_client_health_heartbeat` before it leaves the
//! process, so a payload that violates the closed contract (free-form text, a
//! path, a secret-shaped value) is dropped locally, never sent.
//!
//! Design invariants:
//!
//! * **Operational, consent-free.** This channel is installation health, not
//!   product analytics. It never consults the skill-telemetry opt-in and
//!   never posts to `/v1/telemetry/events` or `/v1/usage` (test-enforced).
//! * **Attempt vs success.** The sync journal's `lastSyncAt` records
//!   *completion*, not success. This module persists the last sync ATTEMPT
//!   separately and advances `lastSyncSuccessAt` only on a genuine success —
//!   including a no-change run — never after an aborted, partial, conflicted,
//!   auth-failed, or crashed run (`run_was_genuine_success`).
//! * **Stable random installation identity.** `~/.hq/client-health.json`
//!   pins the installation ID on first use (preferring the existing stable
//!   random `machineId` from `~/.hq/menubar.json`, else a fresh v4 UUID). It
//!   survives restarts and is NOT a hardware fingerprint.
//! * **Updater state survives the process.** `PendingUpdateStatus` is
//!   in-memory; the last observed state is persisted here so `unchecked`
//!   (updater has not run) and `up_to_date` (a successful check confirmed no
//!   update) stay distinct across restarts and on the wire.
//! * **Monotonic sequence.** The persisted per-installation sequence is
//!   bumped before every send, so the server's conditional write can drop
//!   late/replayed heartbeats.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use hq_desktop_core::client_health::{
    parse_client_health_heartbeat, ClientHealthArch, ClientHealthFailureReason,
    ClientHealthHeartbeat, ClientHealthPlatform, ClientHealthSource, ClientHealthSyncState,
    ClientHealthUpdaterState, ClientHealthVersions, CLIENT_HEALTH_CONTRACT_VERSION,
    CLIENT_HEALTH_MAX_CONFLICT_COUNT, CLIENT_HEALTH_MAX_CONSECUTIVE_FAILURES,
};
use hq_desktop_core::sync_outcome::RunTotals;

use crate::commands::sync::resolve_vault_api_url;
use crate::commands::vault_client::VaultClientError;
use crate::updater::PendingUpdateStatus;
use crate::util::client_info::build_client;
use crate::util::paths;

// ─── Cadence + wire constants ────────────────────────────────────────────────

/// Steady-state heartbeat interval while the app is running (AC: five minutes).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Fast retry while no signed-in session exists — the startup heartbeat lands
/// within seconds of sign-in instead of waiting a full interval.
const HEARTBEAT_SESSION_RETRY: Duration = Duration::from_secs(30);
/// Short debounce after a state-change trigger so one user action that flips
/// several flags (pause + workspace toggles) coalesces into one heartbeat.
const STATE_CHANGE_DEBOUNCE: Duration = Duration::from_millis(1500);
/// Same GTM-mapped client name the version heartbeat uses.
const CLIENT_HEALTH_CLIENT_NAME: &str = "hq-desktop-app";
/// Contract ceiling for `sequence` (JS `Number.MAX_SAFE_INTEGER`).
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

// ─── Persistent per-installation state (~/.hq/client-health.json) ────────────

/// Locally persisted health bookkeeping. Everything here is either generated
/// by this module (identity, sequence, ISO timestamps) or a closed wire token
/// — never free-form text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ClientHealthState {
    /// Stable random installation identity — NOT a hardware fingerprint.
    installation_id: String,
    /// Monotonic per-installation heartbeat sequence.
    sequence: u64,
    /// Last time a sync RUN started — distinct from completion or success.
    last_sync_attempt_at: Option<String>,
    /// Advances only on genuine success (including no-change runs).
    last_sync_success_at: Option<String>,
    consecutive_failures: u64,
    /// Conflict count from the last non-successful run (0 after a success).
    conflict_count: u64,
    /// True when the most recent completed run was not a genuine success.
    sync_run_failed: bool,
    /// Closed `ClientHealthFailureReason` wire token from the last failed run.
    last_failure_reason: Option<String>,
    /// Closed `ClientHealthUpdaterState` wire token of the last observed
    /// updater transition. `None` = never observed → reported `unchecked`.
    updater_state: Option<String>,
}

fn client_health_home_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        if !home.is_empty() {
            return Some(home.into());
        }
    }
    paths::home_dir()
}

fn state_file_path() -> Option<PathBuf> {
    client_health_home_dir().map(|home| home.join(".hq/client-health.json"))
}

fn state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_state(path: &PathBuf) -> ClientHealthState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_state(path: &PathBuf, state: &ClientHealthState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    // Atomic write: stage + rename, matching the menubar.json discipline.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Serialize one read-modify-write of the persisted state. The installation
/// ID is pinned on first use so it survives restarts unchanged.
fn with_state<T>(mutate: impl FnOnce(&mut ClientHealthState) -> T) -> Result<T, String> {
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let path = state_file_path().ok_or_else(|| "home dir unavailable".to_string())?;
    let mut state = load_state(&path);
    if state.installation_id.is_empty() {
        state.installation_id = new_installation_id();
    }
    let out = mutate(&mut state);
    save_state(&path, &state)?;
    Ok(out)
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$` — the contract's installation-identity
/// shape (mirrors the private validator in `hq_desktop_core::client_health`;
/// the pre-send contract self-check re-verifies it).
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

/// Prefer the app's existing stable random `machineId` (a v4 UUID persisted in
/// `~/.hq/menubar.json` by `ensure_machine_id`) so client-health rows correlate
/// with the usage/version feeds; fall back to a fresh v4 UUID. Both are stable
/// random values — neither derives from hardware.
fn new_installation_id() -> String {
    let from_menubar = client_health_home_dir()
        .map(|home| home.join(".hq/menubar.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| {
            value
                .get("machineId")
                .and_then(|id| id.as_str())
                .map(str::to_string)
        });
    match from_menubar {
        Some(id) if is_wire_id(&id) => id,
        _ => uuid::Uuid::new_v4().to_string(),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ─── Live (in-memory) signals ────────────────────────────────────────────────

/// True while a manual/launch sync runner is executing (set by the sync
/// command seams below).
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

fn state_change_notify() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

/// Ask the heartbeat loop to emit soon (debounced). Call after any sync,
/// updater, authentication, pause, conflict, or repair state change.
pub(crate) fn notify_client_health_state_changed() {
    state_change_notify().notify_one();
}

// ─── Recorders (called from the sync / updater / settings seams) ─────────────

/// A sync run is starting: persist the ATTEMPT timestamp (distinct from
/// completion or success) and heartbeat immediately.
pub(crate) fn record_sync_attempt_started() {
    SYNC_RUNNING.store(true, Ordering::SeqCst);
    let now = now_iso();
    if let Err(e) = with_state(|state| {
        state.last_sync_attempt_at = Some(now.clone());
    }) {
        eprintln!("[client-health] record-attempt failed: {e}");
    }
    notify_client_health_state_changed();
}

/// Genuine success = the runner exited cleanly with zero error events, zero
/// auth errors, and zero conflicts. A no-change run satisfies this; an
/// aborted, partial, conflicted, or failed run never does (AC).
fn run_was_genuine_success(exit_success: bool, totals: &RunTotals) -> bool {
    exit_success && !totals.saw_error && !totals.saw_auth_error && totals.conflicts == 0
}

/// Map a non-successful run to ONE closed reason code — class tokens only,
/// never paths or raw logs (the classification inputs are `RunTotals`' fixed
/// vocabulary, not runner output).
fn failure_reason_for_run(totals: &RunTotals) -> ClientHealthFailureReason {
    if totals.saw_auth_error {
        ClientHealthFailureReason::AuthExpired
    } else if totals.conflicts > 0 {
        ClientHealthFailureReason::ConflictBlocked
    } else if totals.runner_error_rollup.is_exclusively_disk_full() {
        ClientHealthFailureReason::DiskFull
    } else if totals.runner_error_rollup.has_permission_error() {
        ClientHealthFailureReason::PermissionDenied
    } else {
        ClientHealthFailureReason::RunnerFailed
    }
}

/// Shared success/failure bookkeeping for a completed run — the ONLY writer
/// of `lastSyncSuccessAt`, used by both the manual seam and the watch/auto
/// seam so their success discipline can never diverge.
fn apply_run_outcome(state: &mut ClientHealthState, success: bool, totals: &RunTotals, now: &str) {
    if success {
        state.last_sync_success_at = Some(now.to_string());
        state.consecutive_failures = 0;
        state.conflict_count = 0;
        state.sync_run_failed = false;
        state.last_failure_reason = None;
    } else {
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        state.conflict_count = u64::from(totals.conflicts);
        state.sync_run_failed = true;
        state.last_failure_reason = Some(failure_reason_for_run(totals).wire_value().to_string());
    }
}

/// A sync run ended. Advances `lastSyncSuccessAt` ONLY on genuine success
/// (including a no-change run); every other completion records a closed
/// failure reason and increments the consecutive-failure counter.
pub(crate) fn record_sync_run_ended(exit_success: bool, totals: &RunTotals) {
    SYNC_RUNNING.store(false, Ordering::SeqCst);
    let now = now_iso();
    let success = run_was_genuine_success(exit_success, totals);
    if let Err(e) = with_state(|state| apply_run_outcome(state, success, totals, &now)) {
        eprintln!("[client-health] record-run-ended failed: {e}");
    }
    notify_client_health_state_changed();
}

/// A watch-daemon (auto-sync) pass reached `AllComplete`. The watch path has
/// no observable pass-start seam — a pass is only visible once its events
/// arrive — so the ATTEMPT is recorded at the same completion boundary. The
/// success discipline is the manual path's exactly (`run_was_genuine_success`
/// + `apply_run_outcome`): `AllComplete` with zero error events, zero auth
/// errors, and zero conflicts — including a no-change poll pass — advances
/// `lastSyncSuccessAt`; anything else records a closed failure reason and
/// increments the consecutive-failure counter. Without this seam an install
/// that only ever auto-syncs would report `never_synced` forever.
///
/// Watch passes recur on every chokidar tick and every 15-second poll, so an
/// immediate state-change heartbeat fires only when the derived health
/// actually transitions (first-ever success, any failure, or recovery from a
/// failure). Steady-state no-change passes update the persisted timestamps
/// silently and ride the five-minute cadence — otherwise auto-sync would
/// heartbeat the control plane every pass.
pub(crate) fn record_auto_sync_pass_completed(totals: &RunTotals) {
    let now = now_iso();
    let success = run_was_genuine_success(true, totals);
    let transitioned = with_state(|state| {
        let was_failed = state.sync_run_failed;
        let first_success = state.last_sync_success_at.is_none();
        state.last_sync_attempt_at = Some(now.clone());
        apply_run_outcome(state, success, totals, &now);
        !success || was_failed || first_success
    });
    match transitioned {
        Ok(true) => notify_client_health_state_changed(),
        Ok(false) => {}
        Err(e) => eprintln!("[client-health] record-auto-pass failed: {e}"),
    }
}

/// Wire mapping of the in-memory updater ledger. `Unchecked` (has not run)
/// and `Absent` (a successful check confirmed no update → up to date) are
/// distinct closed values and must never collapse.
pub(crate) fn updater_wire_state(status: &PendingUpdateStatus) -> ClientHealthUpdaterState {
    match status {
        PendingUpdateStatus::Unchecked => ClientHealthUpdaterState::Unchecked,
        PendingUpdateStatus::Absent => ClientHealthUpdaterState::UpToDate,
        PendingUpdateStatus::Pending(_) => ClientHealthUpdaterState::UpdateAvailable,
    }
}

fn persist_updater_state(state: ClientHealthUpdaterState) {
    if let Err(e) = with_state(|persisted| {
        persisted.updater_state = Some(state.wire_value().to_string());
    }) {
        eprintln!("[client-health] record-updater-state failed: {e}");
    }
    notify_client_health_state_changed();
}

/// The updater ledger transitioned (check completed, update discovered or
/// cleared): persist it so the state survives restarts, then heartbeat.
pub(crate) fn record_updater_status(status: &PendingUpdateStatus) {
    persist_updater_state(updater_wire_state(status));
}

/// A desktop update install failed.
pub(crate) fn record_updater_install_failed() {
    persist_updater_state(ClientHealthUpdaterState::UpdateFailed);
}

// ─── Snapshot derivation (pure) ──────────────────────────────────────────────

fn derive_sync_state(
    paused: bool,
    syncing: bool,
    state: &ClientHealthState,
) -> ClientHealthSyncState {
    if paused {
        ClientHealthSyncState::Paused
    } else if syncing {
        ClientHealthSyncState::Syncing
    } else if state.conflict_count > 0 {
        ClientHealthSyncState::ConflictBlocked
    } else if state.sync_run_failed {
        ClientHealthSyncState::Error
    } else if state.last_sync_attempt_at.is_none() && state.last_sync_success_at.is_none() {
        ClientHealthSyncState::NeverSynced
    } else {
        ClientHealthSyncState::Idle
    }
}

/// Parse a persisted closed wire token back to the enum. Unknown/stale tokens
/// fail closed to `None` (the caller substitutes the safe default).
fn failure_reason_from_wire(value: &str) -> Option<ClientHealthFailureReason> {
    use ClientHealthFailureReason as R;
    Some(match value {
        "SYNC_PAUSED" => R::SyncPaused,
        "CONFLICT_BLOCKED" => R::ConflictBlocked,
        "DESKTOP_OUTDATED" => R::DesktopOutdated,
        "CLI_OUTDATED" => R::CliOutdated,
        "CORE_OUTDATED" => R::CoreOutdated,
        "AUTH_EXPIRED" => R::AuthExpired,
        "UPDATE_FAILED" => R::UpdateFailed,
        "RUNNER_FAILED" => R::RunnerFailed,
        "PERMISSION_DENIED" => R::PermissionDenied,
        "DISK_FULL" => R::DiskFull,
        "HEARTBEAT_STALE" => R::HeartbeatStale,
        _ => return None,
    })
}

fn updater_state_from_wire(value: &str) -> Option<ClientHealthUpdaterState> {
    use ClientHealthUpdaterState as U;
    Some(match value {
        "unchecked" => U::Unchecked,
        "up_to_date" => U::UpToDate,
        "update_available" => U::UpdateAvailable,
        "update_downloading" => U::UpdateDownloading,
        "update_ready" => U::UpdateReady,
        "update_failed" => U::UpdateFailed,
        "unsupported" => U::Unsupported,
        _ => return None,
    })
}

/// The desktop always ships an updater, so a never-observed ledger reports
/// the closed value `unchecked` — never field absence (absence means "a
/// client too old to report it", which this client is not).
fn reported_updater_state(state: &ClientHealthState) -> ClientHealthUpdaterState {
    state
        .updater_state
        .as_deref()
        .and_then(updater_state_from_wire)
        .unwrap_or(ClientHealthUpdaterState::Unchecked)
}

fn derive_failure_reason(
    sync_state: ClientHealthSyncState,
    state: &ClientHealthState,
) -> Option<ClientHealthFailureReason> {
    match sync_state {
        ClientHealthSyncState::Paused => Some(ClientHealthFailureReason::SyncPaused),
        ClientHealthSyncState::ConflictBlocked => Some(ClientHealthFailureReason::ConflictBlocked),
        ClientHealthSyncState::Error => Some(
            state
                .last_failure_reason
                .as_deref()
                .and_then(failure_reason_from_wire)
                .unwrap_or(ClientHealthFailureReason::RunnerFailed),
        ),
        _ => {
            if reported_updater_state(state) == ClientHealthUpdaterState::UpdateFailed {
                Some(ClientHealthFailureReason::UpdateFailed)
            } else {
                None
            }
        }
    }
}

fn current_platform() -> ClientHealthPlatform {
    if cfg!(target_os = "macos") {
        ClientHealthPlatform::Macos
    } else if cfg!(target_os = "windows") {
        ClientHealthPlatform::Windows
    } else {
        ClientHealthPlatform::Linux
    }
}

fn current_arch() -> ClientHealthArch {
    if cfg!(target_arch = "aarch64") {
        ClientHealthArch::Arm64
    } else {
        ClientHealthArch::X64
    }
}

/// Only strict SemVer crosses the wire. Anything else — "unknown", an error
/// string, a path — is omitted rather than sent (fail closed on our own
/// values, matching the contract's `assert_version`).
fn sanitized_version(raw: &str) -> Option<String> {
    let stripped = hq_desktop_core::hq_version::strip_v_prefix(raw.trim());
    if stripped.is_empty() || stripped.len() > 64 {
        return None;
    }
    semver::Version::parse(stripped).ok()?;
    Some(stripped.to_string())
}

/// The four versions: desktop (this build), CLI (installed hq), Core (local
/// core.yaml), sync runner (resolved hq-cloud runner install).
async fn collect_versions() -> ClientHealthVersions {
    let cli = crate::commands::hq_cli_update::get_hq_cli_version().await;
    let (core, sync_runner) = tokio::task::spawn_blocking(|| {
        let core = hq_desktop_core::hq_version::get_local_version();
        let target = hq_desktop_core::runner_target::runner_spawn_target();
        let runner = hq_desktop_core::runner_target::runner_hq_cloud_version(&target);
        (core, runner)
    })
    .await
    .map(|(core, runner)| (core, Some(runner)))
    .unwrap_or((None, None));

    ClientHealthVersions {
        desktop: sanitized_version(env!("APP_VERSION")),
        cli: cli.as_deref().and_then(sanitized_version),
        core: core.as_deref().and_then(sanitized_version),
        sync_runner: sync_runner.as_deref().and_then(sanitized_version),
    }
}

/// Assemble one heartbeat from persisted + live state. Pure so tests can
/// drive every state/reason combination without the filesystem.
fn build_heartbeat_payload(
    state: &ClientHealthState,
    versions: ClientHealthVersions,
    paused: bool,
    syncing: bool,
    sent_at: String,
) -> ClientHealthHeartbeat {
    let sync_state = derive_sync_state(paused, syncing, state);
    ClientHealthHeartbeat {
        contract_version: CLIENT_HEALTH_CONTRACT_VERSION,
        installation_id: state.installation_id.clone(),
        source: ClientHealthSource::Desktop,
        platform: current_platform(),
        arch: current_arch(),
        sent_at,
        sequence: state.sequence,
        versions,
        sync_state,
        last_sync_attempt_at: state.last_sync_attempt_at.clone(),
        last_sync_success_at: state.last_sync_success_at.clone(),
        consecutive_failures: state
            .consecutive_failures
            .min(CLIENT_HEALTH_MAX_CONSECUTIVE_FAILURES),
        conflict_count: Some(state.conflict_count.min(CLIENT_HEALTH_MAX_CONFLICT_COUNT)),
        updater_state: Some(reported_updater_state(state)),
        failure_reason: derive_failure_reason(sync_state, state),
    }
}

/// Bump + persist the monotonic sequence, build the payload, and self-check
/// it against the US-000 contract parser. A violating payload is REJECTED
/// here (fail closed) — it never leaves the process.
fn prepare_heartbeat(versions: ClientHealthVersions) -> Result<ClientHealthHeartbeat, String> {
    let paused = hq_desktop_core::daemon::is_cloud_paused();
    let syncing = SYNC_RUNNING.load(Ordering::SeqCst);
    let sent_at = now_iso();
    let state = with_state(|state| {
        state.sequence = state.sequence.saturating_add(1).min(MAX_SEQUENCE);
        state.clone()
    })?;
    let heartbeat = build_heartbeat_payload(&state, versions, paused, syncing, sent_at);
    let value = serde_json::to_value(&heartbeat).map_err(|e| e.to_string())?;
    // Contract errors render code + field only — never the offending value.
    parse_client_health_heartbeat(&value).map_err(|e| e.to_string())?;
    Ok(heartbeat)
}

// ─── Transport ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatOutcome {
    Sent,
    NoSession,
    Failed,
    InvalidPayload,
}

fn next_heartbeat_delay(outcome: HeartbeatOutcome) -> Duration {
    match outcome {
        HeartbeatOutcome::NoSession => HEARTBEAT_SESSION_RETRY,
        HeartbeatOutcome::Sent | HeartbeatOutcome::Failed | HeartbeatOutcome::InvalidPayload => {
            HEARTBEAT_INTERVAL
        }
    }
}

fn heartbeat_error_is_retryable(err: &VaultClientError) -> bool {
    matches!(err, VaultClientError::Request(_))
}

async fn post_client_health_heartbeat(
    api_url: &str,
    jwt: &str,
    heartbeat: &ClientHealthHeartbeat,
) -> Result<(), VaultClientError> {
    let resp = build_client()
        .post(format!(
            "{}/v1/client-health/heartbeat",
            api_url.trim_end_matches('/')
        ))
        .header("x-hq-client-name", CLIENT_HEALTH_CLIENT_NAME)
        .header("x-hq-device-id", heartbeat.installation_id.as_str())
        .bearer_auth(jwt)
        .json(heartbeat)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(VaultClientError::Http {
            status: status.as_u16(),
            body,
        });
    }
    Ok(())
}

/// One retry, transport errors only — an HTTP status is an answer, not a
/// transient network fault.
async fn post_with_retry(
    api_url: &str,
    jwt: &str,
    heartbeat: &ClientHealthHeartbeat,
) -> Result<(), VaultClientError> {
    match post_client_health_heartbeat(api_url, jwt, heartbeat).await {
        Ok(()) => Ok(()),
        Err(err) if heartbeat_error_is_retryable(&err) => {
            post_client_health_heartbeat(api_url, jwt, heartbeat).await
        }
        Err(err) => Err(err),
    }
}

async fn emit_client_health_heartbeat_once() -> HeartbeatOutcome {
    emit_client_health_heartbeat_with_desktop(None).await
}

/// `desktop_override` replaces the compile-time `env!("APP_VERSION")` of THIS
/// (possibly dying) process — used by the post-update heartbeat, where the
/// truthful desktop version is the freshly INSTALLED target, not the build
/// that is about to exit. A non-SemVer override fails closed to omission
/// (never falls back to the stale compile-time value).
async fn emit_client_health_heartbeat_with_desktop(
    desktop_override: Option<&str>,
) -> HeartbeatOutcome {
    let access_token = match crate::commands::cognito::get_valid_access_token().await {
        Ok(token) => token,
        Err(_) => return HeartbeatOutcome::NoSession,
    };
    let api_url = match resolve_vault_api_url() {
        Ok(url) => url,
        Err(_) => return HeartbeatOutcome::Failed,
    };
    let mut versions = collect_versions().await;
    if let Some(installed) = desktop_override {
        versions.desktop = sanitized_version(installed);
    }
    let heartbeat = match prepare_heartbeat(versions) {
        Ok(heartbeat) => heartbeat,
        Err(e) => {
            eprintln!("[client-health] payload rejected before send: {e}");
            return HeartbeatOutcome::InvalidPayload;
        }
    };
    match post_with_retry(&api_url, &access_token, &heartbeat).await {
        Ok(()) => {
            eprintln!("[client-health] heartbeat seq={} ok", heartbeat.sequence);
            HeartbeatOutcome::Sent
        }
        Err(_) => {
            eprintln!("[client-health] heartbeat seq={} failed", heartbeat.sequence);
            HeartbeatOutcome::Failed
        }
    }
}

/// Best-effort heartbeat immediately after a desktop update installs, awaited
/// by the updater so the request can land before restart/exit. Failures are
/// swallowed — an update must never block on reporting.
///
/// The heartbeat must describe the POST-update installation, not the dying
/// process: `installed_version` (the same value
/// `emit_version_heartbeat_after_update` receives) replaces this build's
/// compile-time `versions.desktop`, and the persisted updater state advances
/// from `update_available`/`update_ready` to `up_to_date` FIRST, so the
/// server never sees "old desktop version + update still available" after a
/// successful install — and a crash before the relaunched build's first
/// heartbeat cannot resurrect the stale pending state from disk.
pub async fn emit_client_health_after_update(installed_version: &str) {
    if let Err(e) = with_state(|state| {
        state.updater_state = Some(ClientHealthUpdaterState::UpToDate.wire_value().to_string());
    }) {
        eprintln!("[client-health] post-update state clear failed: {e}");
    }
    let _ = emit_client_health_heartbeat_with_desktop(Some(installed_version)).await;
}

/// Fire-and-forget startup + 5-minute health heartbeat loop. State-change
/// triggers (`notify_client_health_state_changed`) wake it immediately, with
/// a short debounce so a burst of related changes sends one heartbeat.
pub fn setup_client_health_heartbeat() {
    tauri::async_runtime::spawn(async move {
        loop {
            let outcome = emit_client_health_heartbeat_once().await;
            let delay = next_heartbeat_delay(outcome);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = state_change_notify().notified() => {
                    tokio::time::sleep(STATE_CHANGE_DEBOUNCE).await;
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;
    use hq_desktop_core::events::SyncErrorEvent;
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn setup_home() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        tmp
    }

    fn write_menubar(home: &std::path::Path, content: &str) {
        std::fs::write(home.join(".hq/menubar.json"), content).unwrap();
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

    fn error_totals(message: &str) -> RunTotals {
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "companies/example".to_string(),
            message: message.to_string(),
        });
        totals
    }

    fn state_with_id(sequence: u64) -> ClientHealthState {
        ClientHealthState {
            installation_id: "inst-test-4f9d2c1a8b7e".to_string(),
            sequence,
            ..ClientHealthState::default()
        }
    }

    fn full_versions() -> ClientHealthVersions {
        ClientHealthVersions {
            desktop: Some("1.42.3".to_string()),
            cli: Some("5.106.2".to_string()),
            core: Some("3.18.0".to_string()),
            sync_runner: Some("5.106.2".to_string()),
        }
    }

    // ── Cadence (AC: startup, 5 minutes, immediate on change) ────────────────

    #[test]
    fn heartbeat_cadence_is_5_minutes_with_30s_no_session_retry() {
        assert_eq!(
            next_heartbeat_delay(HeartbeatOutcome::Sent),
            Duration::from_secs(300),
            "steady-state cadence is five minutes"
        );
        assert_eq!(
            next_heartbeat_delay(HeartbeatOutcome::Failed),
            Duration::from_secs(300)
        );
        assert_eq!(
            next_heartbeat_delay(HeartbeatOutcome::InvalidPayload),
            Duration::from_secs(300)
        );
        assert_eq!(
            next_heartbeat_delay(HeartbeatOutcome::NoSession),
            Duration::from_secs(30),
            "sign-in lands a heartbeat within 30s, not a full interval"
        );
        assert!(STATE_CHANGE_DEBOUNCE < Duration::from_secs(5));
    }

    // ── Success discipline (AC: lastSuccessfulSyncAt) ────────────────────────

    #[test]
    fn no_change_clean_run_is_a_genuine_success() {
        // AllComplete with zero files, zero errors, zero conflicts — a
        // no-change run — must advance lastSyncSuccessAt.
        let totals = RunTotals::default();
        assert!(run_was_genuine_success(true, &totals));
    }

    #[test]
    fn aborted_partial_conflicted_and_failed_runs_are_never_success() {
        // Aborted / crashed: non-success exit.
        assert!(!run_was_genuine_success(false, &RunTotals::default()));

        // Partial: error events during the run.
        let mut errored = RunTotals::default();
        errored.saw_error = true;
        assert!(!run_was_genuine_success(true, &errored));

        // Auth-failed (runner deliberately exits 0 after auth errors).
        let mut auth = RunTotals::default();
        auth.record_auth_error();
        assert!(!run_was_genuine_success(true, &auth));

        // Conflicted.
        let mut conflicted = RunTotals::default();
        conflicted.conflicts = 2;
        assert!(!run_was_genuine_success(true, &conflicted));
    }

    // ── Closed reason codes (AC: no paths, no raw logs) ──────────────────────

    #[test]
    fn failure_reasons_map_to_closed_codes() {
        let mut auth = RunTotals::default();
        auth.record_auth_error();
        assert_eq!(
            failure_reason_for_run(&auth),
            ClientHealthFailureReason::AuthExpired
        );

        let mut conflicted = RunTotals::default();
        conflicted.conflicts = 3;
        assert_eq!(
            failure_reason_for_run(&conflicted),
            ClientHealthFailureReason::ConflictBlocked
        );

        assert_eq!(
            failure_reason_for_run(&error_totals("ENOSPC: no space left on device")),
            ClientHealthFailureReason::DiskFull,
            "disk exhaustion maps to DISK_FULL"
        );
        assert_eq!(
            failure_reason_for_run(&error_totals("EACCES: permission denied")),
            ClientHealthFailureReason::PermissionDenied,
        );
        assert_eq!(
            failure_reason_for_run(&error_totals("EPERM: operation not permitted")),
            ClientHealthFailureReason::PermissionDenied,
        );
        assert_eq!(
            failure_reason_for_run(&error_totals("something exploded")),
            ClientHealthFailureReason::RunnerFailed,
            "unclassified runner exits map to RUNNER_FAILED"
        );
    }

    #[test]
    fn reason_codes_never_carry_paths_or_prose() {
        // Every reason this module can emit is a fixed wire token.
        for reason in [
            ClientHealthFailureReason::SyncPaused,
            ClientHealthFailureReason::ConflictBlocked,
            ClientHealthFailureReason::AuthExpired,
            ClientHealthFailureReason::UpdateFailed,
            ClientHealthFailureReason::RunnerFailed,
            ClientHealthFailureReason::PermissionDenied,
            ClientHealthFailureReason::DiskFull,
        ] {
            let token = reason.wire_value();
            assert!(
                token
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_'),
                "reason token must be a closed code, got {token}"
            );
            assert_eq!(failure_reason_from_wire(token), Some(reason));
        }
        assert_eq!(failure_reason_from_wire("disk was full at /Users/jane"), None);
    }

    // ── Sync-state + reason derivation ───────────────────────────────────────

    #[test]
    fn paused_wins_and_maps_to_sync_paused() {
        let state = state_with_id(1);
        let sync_state = derive_sync_state(true, false, &state);
        assert_eq!(sync_state, ClientHealthSyncState::Paused);
        assert_eq!(
            derive_failure_reason(sync_state, &state),
            Some(ClientHealthFailureReason::SyncPaused)
        );
    }

    #[test]
    fn conflict_blocked_is_first_class_and_derived_from_conflict_count() {
        let mut state = state_with_id(1);
        state.conflict_count = 3;
        state.sync_run_failed = true;
        state.last_failure_reason = Some("CONFLICT_BLOCKED".to_string());
        let sync_state = derive_sync_state(false, false, &state);
        assert_eq!(sync_state, ClientHealthSyncState::ConflictBlocked);
        assert_eq!(
            derive_failure_reason(sync_state, &state),
            Some(ClientHealthFailureReason::ConflictBlocked)
        );
    }

    #[test]
    fn never_synced_error_and_idle_states_derive_correctly() {
        let fresh = state_with_id(1);
        assert_eq!(
            derive_sync_state(false, false, &fresh),
            ClientHealthSyncState::NeverSynced
        );
        assert_eq!(
            derive_sync_state(false, true, &fresh),
            ClientHealthSyncState::Syncing
        );

        let mut failed = state_with_id(1);
        failed.last_sync_attempt_at = Some("2026-09-03T17:00:00.000Z".to_string());
        failed.sync_run_failed = true;
        failed.last_failure_reason = Some("AUTH_EXPIRED".to_string());
        let sync_state = derive_sync_state(false, false, &failed);
        assert_eq!(sync_state, ClientHealthSyncState::Error);
        assert_eq!(
            derive_failure_reason(sync_state, &failed),
            Some(ClientHealthFailureReason::AuthExpired)
        );

        let mut idle = state_with_id(1);
        idle.last_sync_attempt_at = Some("2026-09-03T17:00:00.000Z".to_string());
        idle.last_sync_success_at = Some("2026-09-03T17:00:00.000Z".to_string());
        assert_eq!(
            derive_sync_state(false, false, &idle),
            ClientHealthSyncState::Idle
        );
        assert_eq!(derive_failure_reason(ClientHealthSyncState::Idle, &idle), None);
    }

    #[test]
    fn updater_failure_surfaces_as_update_failed_reason_when_sync_is_healthy() {
        let mut state = state_with_id(1);
        state.last_sync_attempt_at = Some("2026-09-03T17:00:00.000Z".to_string());
        state.last_sync_success_at = Some("2026-09-03T17:00:00.000Z".to_string());
        state.updater_state = Some("update_failed".to_string());
        assert_eq!(
            derive_failure_reason(ClientHealthSyncState::Idle, &state),
            Some(ClientHealthFailureReason::UpdateFailed)
        );
    }

    // ── Updater state (AC: persist; Unchecked ≠ Absent) ──────────────────────

    #[test]
    fn updater_states_map_to_distinct_closed_values() {
        assert_eq!(
            updater_wire_state(&PendingUpdateStatus::Unchecked),
            ClientHealthUpdaterState::Unchecked
        );
        assert_eq!(
            updater_wire_state(&PendingUpdateStatus::Absent),
            ClientHealthUpdaterState::UpToDate
        );
        assert_eq!(
            updater_wire_state(&PendingUpdateStatus::Pending(crate::updater::UpdateInfo {
                version: "0.10.200".to_string(),
                body: None,
                date: None,
                detected_at: "2026-09-03T17:00:00.000Z".to_string(),
            })),
            ClientHealthUpdaterState::UpdateAvailable
        );
        // The load-bearing distinction: has-not-checked vs confirmed-current.
        assert_ne!(
            updater_wire_state(&PendingUpdateStatus::Unchecked).wire_value(),
            updater_wire_state(&PendingUpdateStatus::Absent).wire_value(),
        );
    }

    #[test]
    fn never_observed_updater_reports_unchecked_not_absent_field() {
        let state = state_with_id(1);
        let heartbeat =
            build_heartbeat_payload(&state, full_versions(), false, false, now_iso());
        assert_eq!(
            heartbeat.updater_state,
            Some(ClientHealthUpdaterState::Unchecked),
            "this client HAS an updater — absence would claim it is too old to report one"
        );
    }

    // ── Payload shape (e2e: four versions + platform in the snapshot) ────────

    #[test]
    fn heartbeat_reports_all_four_versions_platform_and_arch() {
        let mut state = state_with_id(412);
        state.last_sync_attempt_at = Some("2026-09-03T17:00:00.000Z".to_string());
        state.last_sync_success_at = Some("2026-09-03T17:00:00.000Z".to_string());
        state.updater_state = Some("up_to_date".to_string());
        let heartbeat = build_heartbeat_payload(
            &state,
            full_versions(),
            false,
            false,
            "2026-09-03T17:05:00.000Z".to_string(),
        );
        let wire = serde_json::to_value(&heartbeat).unwrap();
        assert_eq!(wire["versions"]["desktop"], "1.42.3");
        assert_eq!(wire["versions"]["cli"], "5.106.2");
        assert_eq!(wire["versions"]["core"], "3.18.0");
        assert_eq!(wire["versions"]["syncRunner"], "5.106.2");
        assert!(wire.get("platform").is_some());
        assert!(wire.get("arch").is_some());
        assert_eq!(wire["source"], "desktop");
        assert_eq!(wire["sequence"], 412);
        assert_eq!(wire["syncState"], "idle");
        assert_eq!(wire["updaterState"], "up_to_date");
    }

    #[test]
    fn every_derivable_heartbeat_passes_the_us000_contract() {
        // The pre-send self-check must accept every state this module can
        // produce — paused, conflicted, errored, never-synced, healthy.
        let scenarios: Vec<ClientHealthState> = vec![
            state_with_id(1),
            {
                let mut s = state_with_id(2);
                s.conflict_count = 3;
                s.sync_run_failed = true;
                s.consecutive_failures = 2;
                s.last_failure_reason = Some("CONFLICT_BLOCKED".to_string());
                s.last_sync_attempt_at = Some("2026-09-03T16:55:00.000Z".to_string());
                s.last_sync_success_at = Some("2026-09-02T11:40:00.000Z".to_string());
                s
            },
            {
                let mut s = state_with_id(3);
                s.sync_run_failed = true;
                s.consecutive_failures = 4;
                s.last_failure_reason = Some("AUTH_EXPIRED".to_string());
                s.last_sync_attempt_at = Some("2026-09-03T16:50:00.000Z".to_string());
                s.updater_state = Some("update_failed".to_string());
                s
            },
        ];
        for (index, state) in scenarios.iter().enumerate() {
            for paused in [false, true] {
                let heartbeat = build_heartbeat_payload(
                    state,
                    full_versions(),
                    paused,
                    false,
                    now_iso(),
                );
                let value = serde_json::to_value(&heartbeat).unwrap();
                let parsed = parse_client_health_heartbeat(&value);
                assert!(
                    parsed.is_ok(),
                    "scenario {index} (paused={paused}) violated the contract: {parsed:?}"
                );
            }
        }
    }

    #[test]
    fn unsafe_or_unknown_versions_are_omitted_not_sent() {
        assert_eq!(sanitized_version("unknown"), None);
        assert_eq!(sanitized_version("/Users/jane/Library/HQ"), None);
        assert_eq!(sanitized_version("ERROR sync failed"), None);
        assert_eq!(sanitized_version(""), None);
        assert_eq!(sanitized_version("v5.106.2"), Some("5.106.2".to_string()));
        assert_eq!(sanitized_version("0.10.179"), Some("0.10.179".to_string()));
    }

    // ── Persistence (AC: stable installation ID; attempt vs success) ─────────

    #[test]
    fn installation_id_is_stable_random_and_survives_reloads() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-stable-1234-abcd"}"#);
        std::env::set_var("HQ_TEST_HOME", home.path());

        let first = with_state(|s| s.installation_id.clone()).unwrap();
        let second = with_state(|s| s.installation_id.clone()).unwrap();

        std::env::remove_var("HQ_TEST_HOME");

        assert_eq!(first, "mid-stable-1234-abcd", "reuses the stable random machineId");
        assert_eq!(first, second, "identity survives reloads");
        assert!(is_wire_id(&first));
    }

    #[test]
    fn installation_id_falls_back_to_uuid_when_machine_id_is_unsafe() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"bad id/with path"}"#);
        std::env::set_var("HQ_TEST_HOME", home.path());

        let id = with_state(|s| s.installation_id.clone()).unwrap();
        let again = with_state(|s| s.installation_id.clone()).unwrap();

        std::env::remove_var("HQ_TEST_HOME");

        assert!(is_wire_id(&id), "generated id must satisfy the wire shape: {id}");
        assert_eq!(id, again, "generated identity is pinned, not re-rolled");
    }

    #[test]
    fn success_advances_last_success_and_failure_does_not() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        std::env::set_var("HQ_TEST_HOME", home.path());

        record_sync_attempt_started();
        let after_attempt = with_state(|s| s.clone()).unwrap();
        assert!(after_attempt.last_sync_attempt_at.is_some());
        assert!(
            after_attempt.last_sync_success_at.is_none(),
            "an attempt is not a success"
        );
        assert!(SYNC_RUNNING.load(Ordering::SeqCst));

        // Genuine no-change success advances lastSyncSuccessAt.
        record_sync_run_ended(true, &RunTotals::default());
        let after_success = with_state(|s| s.clone()).unwrap();
        assert!(after_success.last_sync_success_at.is_some());
        assert_eq!(after_success.consecutive_failures, 0);
        assert!(!after_success.sync_run_failed);
        assert!(!SYNC_RUNNING.load(Ordering::SeqCst));
        let success_stamp = after_success.last_sync_success_at.clone();

        // A conflicted run must NOT advance it, and records the blocker.
        record_sync_attempt_started();
        let mut conflicted = RunTotals::default();
        conflicted.conflicts = 3;
        record_sync_run_ended(true, &conflicted);
        let after_conflict = with_state(|s| s.clone()).unwrap();
        assert_eq!(
            after_conflict.last_sync_success_at, success_stamp,
            "conflicted run must not advance lastSyncSuccessAt"
        );
        assert_eq!(after_conflict.conflict_count, 3);
        assert_eq!(after_conflict.consecutive_failures, 1);
        assert_eq!(
            after_conflict.last_failure_reason.as_deref(),
            Some("CONFLICT_BLOCKED")
        );

        // A crashed run does not advance it either.
        record_sync_attempt_started();
        record_sync_run_ended(false, &RunTotals::default());
        let after_crash = with_state(|s| s.clone()).unwrap();
        assert_eq!(after_crash.last_sync_success_at, success_stamp);
        assert_eq!(after_crash.consecutive_failures, 2);
        assert_eq!(
            after_crash.last_failure_reason.as_deref(),
            Some("RUNNER_FAILED")
        );

        std::env::remove_var("HQ_TEST_HOME");
    }

    #[test]
    fn updater_state_persists_across_reloads() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        std::env::set_var("HQ_TEST_HOME", home.path());

        record_updater_status(&PendingUpdateStatus::Absent);
        let stored = with_state(|s| s.updater_state.clone()).unwrap();
        assert_eq!(stored.as_deref(), Some("up_to_date"));

        record_updater_install_failed();
        let failed = with_state(|s| s.clone()).unwrap();
        assert_eq!(failed.updater_state.as_deref(), Some("update_failed"));
        assert_eq!(
            reported_updater_state(&failed),
            ClientHealthUpdaterState::UpdateFailed
        );

        std::env::remove_var("HQ_TEST_HOME");
    }

    // ── Wire behavior (e2e: consent-free operational reporting) ──────────────

    #[tokio::test]
    async fn heartbeat_reaches_server_with_analytics_consent_off_and_emits_no_analytics() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/heartbeat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "applied": true, "installationId": "mid-consent-off-1234", "sequence": 1,
                "receivedAt": "2026-09-03T17:05:00.000Z"
            })))
            .mount(&server)
            .await;

        let home = setup_home();
        // Analytics consent OFF — operational health must still report.
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-consent-off-1234","telemetryEnabled":false}"#,
        );
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let first = emit_client_health_heartbeat_once().await;
        let second = emit_client_health_heartbeat_once().await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(first, HeartbeatOutcome::Sent);
        assert_eq!(second, HeartbeatOutcome::Sent);

        let requests = server.received_requests().await.unwrap();
        for request in &requests {
            assert_eq!(
                request.url.path(),
                "/v1/client-health/heartbeat",
                "health heartbeat must not touch analytics endpoints ({} was hit)",
                request.url.path()
            );
        }
        assert!(
            !requests.iter().any(|r| r.url.path() == "/v1/usage/opt-in"),
            "operational health must not consult analytics consent"
        );

        let posts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/heartbeat")
            .collect();
        assert_eq!(posts.len(), 2);
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        assert_eq!(body["installationId"], "mid-consent-off-1234");
        assert_eq!(body["source"], "desktop");
        assert_eq!(body["contractVersion"], 1);
        assert_eq!(body["sequence"], 1);
        assert_eq!(body["syncState"], "never_synced");
        // Monotonic sequence across sends.
        let second_body: Value = serde_json::from_slice(&posts[1].body).unwrap();
        assert_eq!(second_body["sequence"], 2);
        // The server never receives caller-selected identity fields.
        assert!(body.get("personUid").is_none());
        let client_name = posts[0]
            .headers
            .get("x-hq-client-name")
            .and_then(|v| v.to_str().ok());
        assert_eq!(client_name, Some(CLIENT_HEALTH_CLIENT_NAME));
        let device_id = posts[0]
            .headers
            .get("x-hq-device-id")
            .and_then(|v| v.to_str().ok());
        assert_eq!(device_id, Some("mid-consent-off-1234"));
    }

    // ── Auto-sync (watch daemon) seam — review finding 1 ─────────────────────

    #[test]
    fn auto_sync_all_complete_advances_last_success_and_failed_pass_does_not() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        std::env::set_var("HQ_TEST_HOME", home.path());

        // A clean auto-sync AllComplete pass (no-change is a genuine success)
        // records both the attempt AND the success — an auto-sync-only
        // install must not stay never_synced.
        record_auto_sync_pass_completed(&RunTotals::default());
        let after_success = with_state(|s| s.clone()).unwrap();
        assert!(after_success.last_sync_attempt_at.is_some());
        assert!(
            after_success.last_sync_success_at.is_some(),
            "auto-sync AllComplete must advance lastSyncSuccessAt"
        );
        assert!(!after_success.sync_run_failed);
        assert_eq!(after_success.consecutive_failures, 0);
        assert_ne!(
            derive_sync_state(false, false, &after_success),
            ClientHealthSyncState::NeverSynced,
            "an install that only auto-syncs must leave never_synced"
        );
        let success_stamp = after_success.last_sync_success_at.clone();

        // A failed auto pass (error events during the run) must NOT advance
        // it, and records the closed reason + failure counter.
        record_auto_sync_pass_completed(&error_totals("EACCES: permission denied"));
        let after_failure = with_state(|s| s.clone()).unwrap();
        assert_eq!(
            after_failure.last_sync_success_at, success_stamp,
            "failed auto run must not advance lastSyncSuccessAt"
        );
        assert!(after_failure.sync_run_failed);
        assert_eq!(after_failure.consecutive_failures, 1);
        assert_eq!(
            after_failure.last_failure_reason.as_deref(),
            Some("PERMISSION_DENIED")
        );
        assert_eq!(
            derive_sync_state(false, false, &after_failure),
            ClientHealthSyncState::Error
        );

        // A conflicted auto pass maps to CONFLICT_BLOCKED, same as manual.
        let mut conflicted = RunTotals::default();
        conflicted.conflicts = 2;
        record_auto_sync_pass_completed(&conflicted);
        let after_conflict = with_state(|s| s.clone()).unwrap();
        assert_eq!(after_conflict.last_sync_success_at, success_stamp);
        assert_eq!(after_conflict.conflict_count, 2);
        assert_eq!(after_conflict.consecutive_failures, 2);

        // Recovery: the next clean pass advances success and clears failure.
        record_auto_sync_pass_completed(&RunTotals::default());
        let recovered = with_state(|s| s.clone()).unwrap();
        assert_ne!(recovered.last_sync_success_at, None);
        assert!(!recovered.sync_run_failed);
        assert_eq!(recovered.consecutive_failures, 0);

        std::env::remove_var("HQ_TEST_HOME");
    }

    // ── Post-update heartbeat — review finding 2 ─────────────────────────────

    #[tokio::test]
    async fn post_update_heartbeat_reports_installed_version_and_clears_updater_state() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/heartbeat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "applied": true, "installationId": "mid-post-update-1234", "sequence": 1,
                "receivedAt": "2026-09-03T17:05:00.000Z"
            })))
            .mount(&server)
            .await;

        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-post-update-1234"}"#);
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // The dying process observed a pending update before installing it.
        record_updater_status(&PendingUpdateStatus::Pending(crate::updater::UpdateInfo {
            version: "9.9.9".to_string(),
            body: None,
            date: None,
            detected_at: "2026-09-03T17:00:00.000Z".to_string(),
        }));
        assert_eq!(
            with_state(|s| s.updater_state.clone()).unwrap().as_deref(),
            Some("update_available")
        );

        emit_client_health_after_update("9.9.9").await;

        let persisted = with_state(|s| s.updater_state.clone()).unwrap();
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        // Persisted state advanced — a relaunch (or crash) can never
        // resurrect update_available for the already-installed version.
        assert_eq!(persisted.as_deref(), Some("up_to_date"));

        let requests = server.received_requests().await.unwrap();
        let posts: Vec<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/v1/client-health/heartbeat")
            .collect();
        assert!(!posts.is_empty(), "post-update heartbeat must be sent");
        let body: Value = serde_json::from_slice(&posts.last().unwrap().body).unwrap();
        assert_eq!(
            body["versions"]["desktop"], "9.9.9",
            "heartbeat must report the INSTALLED target version, not the dying build"
        );
        assert_ne!(
            body["versions"]["desktop"],
            env!("APP_VERSION"),
            "compile-time version of the dying process must not cross the wire"
        );
        assert_eq!(
            body["updaterState"], "up_to_date",
            "server must never see installed version + still-available update"
        );
    }

    #[tokio::test]
    async fn missing_session_does_not_post() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-no-session-1234"}"#);
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let outcome = emit_client_health_heartbeat_once().await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(outcome, HeartbeatOutcome::NoSession);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn transport_error_retries_once_and_http_error_does_not() {
        // Transport (connection refused) → one retry, still an error.
        let heartbeat = build_heartbeat_payload(
            &state_with_id(1),
            full_versions(),
            false,
            false,
            now_iso(),
        );
        let result = post_with_retry("http://127.0.0.1:1", "tok", &heartbeat).await;
        assert!(result.is_err());
        assert!(heartbeat_error_is_retryable(result.as_ref().unwrap_err()));

        // HTTP status answers are terminal — no retry.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/client-health/heartbeat"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .expect(1)
            .mount(&server)
            .await;
        let result = post_with_retry(&server.uri(), "tok", &heartbeat).await;
        match result {
            Err(VaultClientError::Http { status, .. }) => assert_eq!(status, 503),
            other => panic!("expected HTTP error, got {other:?}"),
        }
    }
}
