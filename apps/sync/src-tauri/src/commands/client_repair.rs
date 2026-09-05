//! Desktop safe-repair dispatcher
//! (client-sync-health-control-plane US-010).
//!
//! The US-007 poller ([`crate::commands::client_diagnostics`]) fetches
//! desired-state commands and runs `CHECK_NOW` locally. US-009 widened the
//! server allowlist to the six repair kinds; this module is the desktop side
//! that reconciles them. It is invoked from the poller's dispatch for every
//! non-`CHECK_NOW` kind and reuses the SHARED lifecycle harness
//! ([`crate::commands::client_diagnostics::execute_command_lifecycle`]): the
//! ledger, `acknowledged -> running -> terminal` chain, 409-resync, panic
//! isolation and restart-resume are all inherited — this module only decides
//! the terminal outcome per kind.
//!
//! ## Non-negotiable safety boundaries (PRD + wave-2 plan)
//!
//! * **Server text is NEVER executed.** The wire carries a closed
//!   [`ClientHealthRepairKind`] and closed args only; each kind maps to a
//!   pre-existing, app-managed local implementation (`start_sync`, the settings
//!   pause seam, the CLI/Core updaters, the minisign-verified desktop updater,
//!   `app.restart()`). There is no code path from a server string to a shell.
//! * **Conflict-blocked RETRY_SYNC fails CLOSED.** A conflict-blocked
//!   installation is NEVER force-synced or auto-resolved — the dispatcher
//!   surfaces the existing user-owned local/remote/compare workflow and reports
//!   [`ClientHealthFailureReason::ConflictBlocked`].
//! * **Version installs are proven.** REPAIR_CLI / UPDATE_CORE read the
//!   installed version back AFTER the install and only report `succeeded` when
//!   it matches/advances; the read-back rides the receipt postcondition.
//! * **No silent Windows desktop install until US-012.** APPLY_DESKTOP_UPDATE
//!   uses the platform updater's own attestation; on Windows it currently
//!   returns a closed `manual_action_required` (paired with
//!   [`ClientHealthFailureReason::ManualActionRequired`]) rather than install,
//!   per the story note and decision ledger #7.
//! * **Disruptive kinds are gated + visible.** RESUME_SYNC and RESTART_APP
//!   require the server-derived `consequence` confirmation and display a
//!   customer notice; RESTART_APP flushes its terminal receipt BEFORE the
//!   (countdown-then-automatic) restart so the outcome is durable.
//! * **Receipts are scrubbed.** Postconditions carry only closed enums and
//!   SemVer tokens (the contract parser rejects anything else) — never a path
//!   or a log line.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use hq_desktop_core::client_diagnostics::ClientHealthDesiredCommand;
use hq_desktop_core::client_health::{
    ClientHealthCommandPostcondition, ClientHealthCommandState, ClientHealthConfirmationLevel,
    ClientHealthFailureReason, ClientHealthRepairKind, ClientHealthSyncState, ClientHealthVersions,
};

use crate::commands::client_diagnostics::{
    execute_command_lifecycle, repair_app_handle, ExecutionOutcome, TerminalReceiptContent,
};
use crate::util::logfile::log;

const LOG_TAG: &str = "client-repair";

/// Frontend event carrying a customer-visible repair notice (RESUME_SYNC /
/// RESTART_APP). `desktop-alt/repair-notice.svelte` listens for it.
pub const EVENT_REPAIR_NOTICE: &str = "client-repair:notice";
/// Frontend event asking the shell to surface the EXISTING user-owned conflict
/// workflow (local/remote/compare) — a conflict-blocked RETRY_SYNC raises this
/// instead of ever force-syncing.
pub const EVENT_REPAIR_CONFLICTS_REQUIRED: &str = "client-repair:conflicts-required";

/// Seconds a RESTART_APP notice counts down before the automatic restart
/// (decision ledger #4: visible countdown then automatic restart).
const RESTART_COUNTDOWN_SECONDS: u64 = 5;

/// The customer-visible payload for [`EVENT_REPAIR_NOTICE`]. Closed shape; no
/// server-provided text is ever placed here — copy is fixed client-side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairNotice {
    /// Wire spelling of the repair kind (`"RESUME_SYNC"` / `"RESTART_APP"`).
    pub kind: String,
    pub title: String,
    pub message: String,
    /// Countdown before an automatic action (RESTART_APP); `0` when none.
    pub countdown_seconds: u64,
    /// True when support changed an intentional local setting (RESUME_SYNC
    /// flips an intentional Cloud-off pause) — the notice says so explicitly.
    pub changed_local_setting: bool,
}

// ─── Post-terminal action (runs only AFTER the terminal receipt is flushed) ──

/// What to do once the terminal receipt has been durably accepted. RESTART_APP
/// and an APPLY_DESKTOP_UPDATE that will install both restart the process, so
/// the terminal receipt MUST be flushed first (US-010 AC: RESTART_APP flushes
/// the receipt before restarting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PostAction {
    None,
    Restart,
    InstallDesktopUpdate,
}

impl PostAction {
    fn to_u8(self) -> u8 {
        match self {
            PostAction::None => 0,
            PostAction::Restart => 1,
            PostAction::InstallDesktopUpdate => 2,
        }
    }
    fn from_u8(value: u8) -> Self {
        match value {
            1 => PostAction::Restart,
            2 => PostAction::InstallDesktopUpdate,
            _ => PostAction::None,
        }
    }
}

// ─── Entry point (called by the poller for every non-CHECK_NOW kind) ─────────

/// Drive one repair command to a terminal receipt through the shared lifecycle,
/// then — only if it genuinely reached `Done` — perform any process-restarting
/// post-action whose receipt is now safely flushed.
pub(crate) async fn execute_repair(
    api_url: &str,
    jwt: &str,
    installation_id: &str,
    command: &ClientHealthDesiredCommand,
) -> ExecutionOutcome {
    // AtomicU8 (not a Cell) because the enclosing poll future must stay `Send`.
    let post_action = AtomicU8::new(PostAction::None.to_u8());
    let outcome = execute_command_lifecycle(api_url, jwt, installation_id, command, || async {
        let (content, action) = run_repair_action(command).await;
        post_action.store(action.to_u8(), Ordering::SeqCst);
        content
    })
    .await;

    // ONLY `Done` — a terminal receipt THIS client durably flushed — may arm a
    // process-restarting post-action. `Superseded` (a 409 on our terminal
    // receipt, then the command gone from desired-state: admin cancel / newer
    // revision raced us) marks the command complete but leaves NO accepted
    // receipt behind, so restarting/installing on it would both defy the
    // admin's cancel and restart without a flushed receipt (US-010 AC).
    if let ExecutionOutcome::Done = outcome {
        match PostAction::from_u8(post_action.load(Ordering::SeqCst)) {
            PostAction::Restart => spawn_restart_after_flush(RESTART_COUNTDOWN_SECONDS),
            PostAction::InstallDesktopUpdate => spawn_install_desktop_update(),
            PostAction::None => {}
        }
    }
    outcome
}

// ─── Per-kind terminal action ────────────────────────────────────────────────

/// Decide the terminal outcome for one repair kind by mapping it to a
/// pre-existing local implementation. Returns the closed receipt content plus
/// any process-restarting post-action to run once the receipt is flushed.
async fn run_repair_action(command: &ClientHealthDesiredCommand) -> (TerminalReceiptContent, PostAction) {
    match command.kind {
        ClientHealthRepairKind::CheckNow => {
            // CHECK_NOW never reaches here (the poller routes it to the US-007
            // diagnostics path); fail closed if it somehow does.
            (failed(None), PostAction::None)
        }
        ClientHealthRepairKind::RetrySync => (retry_sync().await, PostAction::None),
        ClientHealthRepairKind::ResumeSync => (resume_sync(command).await, PostAction::None),
        ClientHealthRepairKind::RepairCli => (repair_cli().await, PostAction::None),
        ClientHealthRepairKind::UpdateCore => (update_core().await, PostAction::None),
        ClientHealthRepairKind::ApplyDesktopUpdate => apply_desktop_update().await,
        ClientHealthRepairKind::RestartApp => restart_app(command).await,
    }
}

// ─── RETRY_SYNC ──────────────────────────────────────────────────────────────

/// Safe re-drive of sync. Conflict-blocked installs are surfaced to the
/// user-owned workflow and NEVER force-synced ([`plan_retry_sync`]).
async fn retry_sync() -> TerminalReceiptContent {
    let (sync_state, _reason, conflict_count) = read_sync_snapshot();
    match plan_retry_sync(sync_state, conflict_count) {
        RetrySyncPlan::SurfaceConflicts => {
            // Fail closed: open/raise the existing conflict workflow, do NOT
            // sync, and report the closed CONFLICT_BLOCKED reason.
            surface_conflicts_workflow(conflict_count);
            failed(Some(ClientHealthFailureReason::ConflictBlocked))
        }
        RetrySyncPlan::AttemptSync => {
            // The normal, cloud-gated sync path (refuses when Cloud is paused).
            match trigger_sync().await {
                Ok(()) => {
                    let (observed, _, _) = read_sync_snapshot();
                    succeeded_with_sync_state(observed)
                }
                // Cloud is paused: RETRY_SYNC does not override an intentional
                // pause (that is RESUME_SYNC's job) — report it, don't force.
                Err(SyncTriggerError::CloudPaused) => {
                    failed(Some(ClientHealthFailureReason::SyncPaused))
                }
                Err(SyncTriggerError::Other) => {
                    failed(Some(ClientHealthFailureReason::RunnerFailed))
                }
            }
        }
    }
}

/// Whether a RETRY_SYNC may attempt a sync at all. A conflict-blocked state (or
/// any outstanding conflict count) is user-owned: fail closed, never force.
pub(crate) enum RetrySyncPlan {
    SurfaceConflicts,
    AttemptSync,
}

pub(crate) fn plan_retry_sync(sync_state: ClientHealthSyncState, conflict_count: u64) -> RetrySyncPlan {
    if sync_state == ClientHealthSyncState::ConflictBlocked || conflict_count > 0 {
        RetrySyncPlan::SurfaceConflicts
    } else {
        RetrySyncPlan::AttemptSync
    }
}

// ─── RESUME_SYNC ─────────────────────────────────────────────────────────────

/// Support-initiated resume of an intentionally paused install. Requires the
/// server-derived `consequence` confirmation (defense in depth), flips the
/// Cloud-off pause, shows a customer notice recording that support changed an
/// intentional local setting, and re-triggers sync.
async fn resume_sync(command: &ClientHealthDesiredCommand) -> TerminalReceiptContent {
    if !consequence_confirmed(command.required_confirmation) {
        log(LOG_TAG, "RESUME_SYNC missing consequence confirmation; failing closed");
        return failed(None);
    }

    // Customer notice: support changed an intentional local setting.
    emit_notice(RepairNotice {
        kind: ClientHealthRepairKind::ResumeSync.wire_value().to_string(),
        title: "Support resumed syncing".to_string(),
        message: "HQ support turned Cloud sync back on for this device to recover an incident. \
                  You can pause it again anytime from Settings."
            .to_string(),
        countdown_seconds: 0,
        changed_local_setting: true,
    });
    record_local_repair("RESUME_SYNC resumed cloud sync (support-initiated)");

    if let Err(e) = clear_cloud_pause().await {
        log(LOG_TAG, &format!("RESUME_SYNC could not clear cloud pause: {e}"));
        return failed(Some(ClientHealthFailureReason::RunnerFailed));
    }

    match trigger_sync().await {
        Ok(()) | Err(SyncTriggerError::CloudPaused) => {
            // CloudPaused should not occur right after clearing the pause, but
            // if it races, the postcondition still reflects the observed state.
            let (observed, _, _) = read_sync_snapshot();
            succeeded_with_sync_state(observed)
        }
        Err(SyncTriggerError::Other) => failed(Some(ClientHealthFailureReason::RunnerFailed)),
    }
}

/// Server-derived consequence gate (RESUME_SYNC / RESTART_APP). The server is
/// the sole authority; the client only refuses if it is absent.
pub(crate) fn consequence_confirmed(level: Option<ClientHealthConfirmationLevel>) -> bool {
    level == Some(ClientHealthConfirmationLevel::Consequence)
}

// ─── REPAIR_CLI / UPDATE_CORE (version read-back gate) ───────────────────────

async fn repair_cli() -> TerminalReceiptContent {
    let before = read_cli_version().await;
    if let Err(e) = install_cli_update().await {
        log(LOG_TAG, &format!("REPAIR_CLI install failed: {e}"));
        return failed(Some(ClientHealthFailureReason::CliOutdated));
    }
    let after = read_cli_version().await;
    if version_readback_verified(before.as_deref(), after.as_deref()) {
        succeeded_with_versions(ClientHealthVersions {
            cli: after,
            ..Default::default()
        })
    } else {
        // Installed but the version did not read back as expected — never
        // report success on an unproven install.
        failed(Some(ClientHealthFailureReason::CliOutdated))
    }
}

async fn update_core() -> TerminalReceiptContent {
    let before = read_core_version();
    if let Err(e) = install_core_update().await {
        log(LOG_TAG, &format!("UPDATE_CORE install failed: {e}"));
        return failed(Some(ClientHealthFailureReason::CoreOutdated));
    }
    let after = read_core_version();
    if version_readback_verified(before.as_deref(), after.as_deref()) {
        succeeded_with_versions(ClientHealthVersions {
            core: after,
            ..Default::default()
        })
    } else {
        failed(Some(ClientHealthFailureReason::CoreOutdated))
    }
}

/// Version read-back gate: `succeeded` only if a version reads back AFTER the
/// install and it did not regress below the pre-install baseline. An
/// unreadable/absent post-version, or a non-SemVer value, is never a success.
pub(crate) fn version_readback_verified(before: Option<&str>, after: Option<&str>) -> bool {
    let after = match after.and_then(|v| semver::Version::parse(v).ok()) {
        Some(v) => v,
        None => return false,
    };
    match before.and_then(|v| semver::Version::parse(v).ok()) {
        // Matches or advances the prior version.
        Some(before) => after >= before,
        // No readable baseline: a readable installed version is proof enough.
        None => true,
    }
}

// ─── APPLY_DESKTOP_UPDATE (platform-attested; Windows gated to US-012) ───────

async fn apply_desktop_update() -> (TerminalReceiptContent, PostAction) {
    match plan_desktop_update(cfg!(target_os = "windows")) {
        DesktopUpdatePlan::ManualActionRequired => {
            // Windows: no silent install until US-012 passes live Windows
            // verification (story note). Closed manual-action outcome.
            log(LOG_TAG, "APPLY_DESKTOP_UPDATE on Windows requires manual action until US-012");
            (manual_action_required(), PostAction::None)
        }
        DesktopUpdatePlan::UsePlatformUpdater => match check_desktop_update().await {
            // An update the platform updater attests (its signature is verified
            // on download) is available: flush a succeeded receipt, then the
            // post-action installs + restarts.
            Ok(Some(version)) => (
                succeeded_with_versions(ClientHealthVersions {
                    desktop: Some(version),
                    ..Default::default()
                }),
                PostAction::InstallDesktopUpdate,
            ),
            // Already current — nothing to install, no restart.
            Ok(None) => (
                succeeded_with_versions(ClientHealthVersions {
                    desktop: read_desktop_version(),
                    ..Default::default()
                }),
                PostAction::None,
            ),
            Err(e) => {
                log(LOG_TAG, &format!("APPLY_DESKTOP_UPDATE check failed: {e}"));
                (failed(Some(ClientHealthFailureReason::UpdateFailed)), PostAction::None)
            }
        },
    }
}

/// Platform gate for APPLY_DESKTOP_UPDATE. Windows stays manual until US-012;
/// every other platform uses the signature-verifying platform updater.
pub(crate) enum DesktopUpdatePlan {
    ManualActionRequired,
    UsePlatformUpdater,
}

pub(crate) fn plan_desktop_update(is_windows: bool) -> DesktopUpdatePlan {
    if is_windows {
        DesktopUpdatePlan::ManualActionRequired
    } else {
        DesktopUpdatePlan::UsePlatformUpdater
    }
}

// ─── RESTART_APP ─────────────────────────────────────────────────────────────

/// Support-initiated restart. Requires the server-derived `consequence`
/// confirmation, shows a visible countdown notice, and returns a succeeded
/// terminal outcome — the actual restart runs as the post-action AFTER the
/// receipt is flushed (decision ledger #4).
async fn restart_app(command: &ClientHealthDesiredCommand) -> (TerminalReceiptContent, PostAction) {
    if !consequence_confirmed(command.required_confirmation) {
        log(LOG_TAG, "RESTART_APP missing consequence confirmation; failing closed");
        return (failed(None), PostAction::None);
    }
    emit_notice(RepairNotice {
        kind: ClientHealthRepairKind::RestartApp.wire_value().to_string(),
        title: "HQ is restarting".to_string(),
        message: "HQ support is restarting this app to recover an incident. \
                  It will reopen automatically."
            .to_string(),
        countdown_seconds: RESTART_COUNTDOWN_SECONDS,
        changed_local_setting: false,
    });
    record_local_repair("RESTART_APP restart (support-initiated)");
    // Succeeded proof is verified: the receipt is flushed before the restart,
    // and restart-resume reconciles the terminal state on relaunch.
    (
        TerminalReceiptContent {
            state: ClientHealthCommandState::Succeeded,
            checks: None,
            failure_reason: None,
            postcondition: Some(ClientHealthCommandPostcondition {
                verified: true,
                versions: None,
                sync_state: None,
            }),
            manual_action_required: None,
        },
        PostAction::Restart,
    )
}

// ─── Terminal-content builders ───────────────────────────────────────────────

fn failed(reason: Option<ClientHealthFailureReason>) -> TerminalReceiptContent {
    TerminalReceiptContent {
        state: ClientHealthCommandState::Failed,
        checks: None,
        failure_reason: reason,
        postcondition: None,
        manual_action_required: None,
    }
}

fn manual_action_required() -> TerminalReceiptContent {
    TerminalReceiptContent {
        state: ClientHealthCommandState::Failed,
        checks: None,
        failure_reason: Some(ClientHealthFailureReason::ManualActionRequired),
        postcondition: None,
        manual_action_required: Some(true),
    }
}

fn succeeded_with_sync_state(sync_state: ClientHealthSyncState) -> TerminalReceiptContent {
    TerminalReceiptContent {
        state: ClientHealthCommandState::Succeeded,
        checks: None,
        failure_reason: None,
        postcondition: Some(ClientHealthCommandPostcondition {
            verified: true,
            versions: None,
            sync_state: Some(sync_state),
        }),
        manual_action_required: None,
    }
}

fn succeeded_with_versions(versions: ClientHealthVersions) -> TerminalReceiptContent {
    TerminalReceiptContent {
        state: ClientHealthCommandState::Succeeded,
        checks: None,
        failure_reason: None,
        postcondition: Some(ClientHealthCommandPostcondition {
            verified: true,
            versions: Some(versions),
            sync_state: None,
        }),
        manual_action_required: None,
    }
}

// ─── Effect + snapshot seams (real in production, injectable/gated in tests) ─

/// A minimal, closed classification of a sync-trigger failure.
enum SyncTriggerError {
    CloudPaused,
    Other,
}

/// Read the local sync snapshot (state + conflict count). In `#[cfg(test)]`
/// builds an `HQ_TEST_REPAIR_SYNC="state:conflicts"` override injects a
/// deterministic snapshot so the decision logic can be asserted without real
/// ambient sync state.
fn read_sync_snapshot() -> (ClientHealthSyncState, Option<ClientHealthFailureReason>, u64) {
    #[cfg(test)]
    if let Some(injected) = test_env("HQ_TEST_REPAIR_SYNC") {
        return parse_injected_sync(&injected);
    }
    crate::commands::client_health::diagnostics_sync_snapshot()
        .unwrap_or((ClientHealthSyncState::Error, Some(ClientHealthFailureReason::RunnerFailed), 0))
}

/// Trigger the normal, cloud-gated sync path. Effect is skipped when there is
/// no AppHandle (unit/mock tests): the injected snapshot drives the outcome.
async fn trigger_sync() -> Result<(), SyncTriggerError> {
    #[cfg(test)]
    if let Some(v) = test_env("HQ_TEST_REPAIR_SYNC_RESULT") {
        return match v.as_str() {
            "paused" => Err(SyncTriggerError::CloudPaused),
            "error" => Err(SyncTriggerError::Other),
            _ => Ok(()),
        };
    }
    let Some(app) = repair_app_handle() else {
        // No handle (headless/test): nothing to drive.
        return Ok(());
    };
    match crate::commands::sync::start_sync(app, None).await {
        Ok(_) => Ok(()),
        Err(e) => {
            if e == hq_desktop_core::daemon::CLOUD_PAUSED_MESSAGE {
                Err(SyncTriggerError::CloudPaused)
            } else {
                log(LOG_TAG, &format!("start_sync failed: {e}"));
                Err(SyncTriggerError::Other)
            }
        }
    }
}

/// Flip the Cloud-off pause to false at the settings seam.
async fn clear_cloud_pause() -> Result<(), String> {
    #[cfg(test)]
    if test_env("HQ_TEST_REPAIR_SYNC").is_some() {
        return Ok(());
    }
    let mut prefs = crate::commands::settings::get_settings().await?;
    prefs.cloud_paused = Some(false);
    crate::commands::settings::save_settings(prefs).await
}

async fn read_cli_version() -> Option<String> {
    #[cfg(test)]
    if let Some(v) = test_env("HQ_TEST_REPAIR_CLI_VERSION") {
        return non_empty(v);
    }
    crate::commands::hq_cli_update::get_hq_cli_version().await
}

async fn install_cli_update() -> Result<(), String> {
    #[cfg(test)]
    if test_env("HQ_TEST_REPAIR_CLI_VERSION").is_some() {
        return Ok(());
    }
    let Some(app) = repair_app_handle() else {
        return Ok(());
    };
    crate::commands::hq_cli_update::install_hq_cli_update(app)
        .await
        .map(|_| ())
}

fn read_core_version() -> Option<String> {
    #[cfg(test)]
    if let Some(v) = test_env("HQ_TEST_REPAIR_CORE_VERSION") {
        return non_empty(v);
    }
    crate::commands::hq_core_update::get_hq_version()
}

async fn install_core_update() -> Result<(), String> {
    #[cfg(test)]
    if test_env("HQ_TEST_REPAIR_CORE_VERSION").is_some() {
        return Ok(());
    }
    if repair_app_handle().is_none() {
        return Ok(());
    }
    crate::commands::hq_core_update::install_hq_core_update()
        .await
        .map(|_| ())
}

fn read_desktop_version() -> Option<String> {
    #[cfg(test)]
    if let Some(v) = test_env("HQ_TEST_REPAIR_DESKTOP_VERSION") {
        return non_empty(v);
    }
    repair_app_handle().map(|app| app.package_info().version.to_string())
}

/// Ask the platform updater whether a (signature-verified) desktop update is
/// available. `Ok(Some(version))` = an update to install; `Ok(None)` = current.
async fn check_desktop_update() -> Result<Option<String>, String> {
    #[cfg(test)]
    if let Some(v) = test_env("HQ_TEST_REPAIR_DESKTOP_UPDATE") {
        return match v.as_str() {
            "none" => Ok(None),
            "error" => Err("injected updater error".to_string()),
            other => Ok(non_empty(other.to_string())),
        };
    }
    let Some(app) = repair_app_handle() else {
        return Ok(None);
    };
    crate::updater::check_for_updates(app)
        .await
        .map(|maybe| maybe.map(|info| info.version))
}

// ─── Frontend notices + local record + conflict surfacing ────────────────────

fn emit_notice(notice: RepairNotice) {
    if let Some(app) = repair_app_handle() {
        let _ = app.emit(EVENT_REPAIR_NOTICE, &notice);
    } else {
        log(LOG_TAG, &format!("repair notice ({}) suppressed: no app handle", notice.kind));
    }
}

/// Surface the EXISTING user-owned conflict workflow. Never resolves or
/// force-syncs — it only raises the shell's conflict attention path.
fn surface_conflicts_workflow(conflict_count: u64) {
    if let Some(app) = repair_app_handle() {
        let _ = app.emit(
            EVENT_REPAIR_CONFLICTS_REQUIRED,
            &serde_json::json!({ "conflictCount": conflict_count }),
        );
    }
    log(LOG_TAG, "RETRY_SYNC blocked by conflicts; surfaced the user-owned workflow (no force-sync)");
}

/// Append a bounded local record that a support repair changed local state
/// (decision ledger #3: desktop notice + local record). Best-effort; a write
/// failure never fails the repair.
fn record_local_repair(summary: &str) {
    let Some(home) = repair_home_dir() else { return };
    let path = home.join(".hq/client-repair-log.json");
    let entry = serde_json::json!({ "at": now_iso(), "summary": summary });
    let mut entries: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    entries.push(entry);
    // Bounded FIFO — never grow unbounded.
    while entries.len() > 50 {
        entries.remove(0);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_string_pretty(&entries) {
        let _ = std::fs::write(&path, body);
    }
}

// ─── Process-restarting post-actions (run only after the receipt is flushed) ─

fn spawn_restart_after_flush(countdown_seconds: u64) {
    let Some(app) = repair_app_handle() else {
        log(LOG_TAG, "RESTART_APP: no app handle; restart skipped");
        return;
    };
    tauri::async_runtime::spawn(async move {
        // The countdown notice is already visible; hold it, then restart. The
        // terminal receipt was flushed before this task was spawned.
        tokio::time::sleep(Duration::from_secs(countdown_seconds)).await;
        log(LOG_TAG, "RESTART_APP: restarting now (receipt already flushed)");
        app.restart();
    });
}

fn spawn_install_desktop_update() {
    let Some(app) = repair_app_handle() else {
        log(LOG_TAG, "APPLY_DESKTOP_UPDATE: no app handle; install skipped");
        return;
    };
    tauri::async_runtime::spawn(async move {
        // The platform updater verifies the signature on download and restarts
        // the app itself. The succeeded receipt was flushed before this ran.
        if let Err(e) = crate::updater::install_update(app).await {
            log(LOG_TAG, &format!("APPLY_DESKTOP_UPDATE install failed post-flush: {e}"));
        }
    });
}

// ─── Small shared helpers ────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn repair_home_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        if !home.is_empty() {
            return Some(home.into());
        }
    }
    hq_desktop_core::paths::home_dir()
}

#[cfg(test)]
fn test_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
fn non_empty(value: String) -> Option<String> {
    if value.is_empty() || value == "none" {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
fn parse_injected_sync(
    injected: &str,
) -> (ClientHealthSyncState, Option<ClientHealthFailureReason>, u64) {
    let mut parts = injected.splitn(2, ':');
    let state_token = parts.next().unwrap_or("idle");
    let conflicts: u64 = parts.next().and_then(|c| c.parse().ok()).unwrap_or(0);
    let state = match state_token {
        "idle" => ClientHealthSyncState::Idle,
        "syncing" => ClientHealthSyncState::Syncing,
        "paused" => ClientHealthSyncState::Paused,
        "conflict_blocked" => ClientHealthSyncState::ConflictBlocked,
        "never_synced" => ClientHealthSyncState::NeverSynced,
        _ => ClientHealthSyncState::Error,
    };
    let reason = match state {
        ClientHealthSyncState::ConflictBlocked => Some(ClientHealthFailureReason::ConflictBlocked),
        ClientHealthSyncState::Paused => Some(ClientHealthFailureReason::SyncPaused),
        _ => None,
    };
    (state, reason, conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Pure decision helpers (the safety-critical logic) ───────────────────

    #[test]
    fn conflict_blocked_retry_sync_never_attempts_a_sync() {
        assert!(matches!(
            plan_retry_sync(ClientHealthSyncState::ConflictBlocked, 0),
            RetrySyncPlan::SurfaceConflicts
        ));
        // Any outstanding conflict count is user-owned too, even if the state
        // reads otherwise.
        assert!(matches!(
            plan_retry_sync(ClientHealthSyncState::Idle, 2),
            RetrySyncPlan::SurfaceConflicts
        ));
    }

    #[test]
    fn clean_state_retry_sync_may_attempt_a_sync() {
        assert!(matches!(
            plan_retry_sync(ClientHealthSyncState::Idle, 0),
            RetrySyncPlan::AttemptSync
        ));
        assert!(matches!(
            plan_retry_sync(ClientHealthSyncState::Error, 0),
            RetrySyncPlan::AttemptSync
        ));
    }

    #[test]
    fn version_readback_gates_success_only_on_a_matching_or_advancing_version() {
        // Advanced: verified.
        assert!(version_readback_verified(Some("5.106.2"), Some("5.107.0")));
        // Unchanged (repair confirmed the already-current version): verified.
        assert!(version_readback_verified(Some("3.18.0"), Some("3.18.0")));
        // Regressed: never a success.
        assert!(!version_readback_verified(Some("5.107.0"), Some("5.106.2")));
        // Unreadable after the install: never a success.
        assert!(!version_readback_verified(Some("5.106.2"), None));
        // Non-SemVer after: never a success.
        assert!(!version_readback_verified(Some("5.106.2"), Some("not-a-version")));
        // No baseline but a readable install: verified.
        assert!(version_readback_verified(None, Some("5.106.2")));
    }

    #[test]
    fn windows_desktop_update_stays_manual_until_us012() {
        assert!(matches!(
            plan_desktop_update(true),
            DesktopUpdatePlan::ManualActionRequired
        ));
        assert!(matches!(
            plan_desktop_update(false),
            DesktopUpdatePlan::UsePlatformUpdater
        ));
    }

    #[test]
    fn consequence_gate_requires_the_server_derived_consequence_level() {
        assert!(consequence_confirmed(Some(ClientHealthConfirmationLevel::Consequence)));
        assert!(!consequence_confirmed(Some(ClientHealthConfirmationLevel::None)));
        assert!(!consequence_confirmed(None));
    }

    // ── Terminal-content builders serialize to closed, scrubbed wire ────────

    #[test]
    fn manual_action_required_content_is_closed_and_paired_with_the_reason() {
        let content = manual_action_required();
        assert_eq!(content.state, ClientHealthCommandState::Failed);
        assert_eq!(content.manual_action_required, Some(true));
        assert_eq!(
            content.failure_reason,
            Some(ClientHealthFailureReason::ManualActionRequired)
        );
    }

    #[test]
    fn succeeded_postconditions_carry_only_closed_tokens() {
        let sync = succeeded_with_sync_state(ClientHealthSyncState::Idle);
        let wire = serde_json::to_string(&sync.postcondition.unwrap()).unwrap();
        assert_eq!(wire, r#"{"verified":true,"syncState":"idle"}"#);

        let versions = succeeded_with_versions(ClientHealthVersions {
            cli: Some("5.106.2".to_string()),
            ..Default::default()
        });
        let wire = serde_json::to_string(&versions.postcondition.unwrap()).unwrap();
        assert!(!wire.contains('/'), "no path may appear in a postcondition: {wire}");
        assert_eq!(wire, r#"{"verified":true,"versions":{"cli":"5.106.2"}}"#);
    }
}
