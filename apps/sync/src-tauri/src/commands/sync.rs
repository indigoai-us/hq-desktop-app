//! Tauri commands for spawning and cancelling `hq-sync-runner` syncs.
//!
//! Uses [`crate::commands::process`] for subprocess lifecycle (spawn, stream,
//! SIGTERM→SIGKILL). Emits typed sync events to the Svelte renderer.
//!
//! Phase 7 (ADR-0001, 2026-04-19): switched from `hq sync --json` (never
//! shipped) to `hq-sync-runner --companies`. The runner is the canonical
//! machine-targeted entrypoint from `@indigoai-us/hq-cloud` ≥5.1.0 — ndjson is
//! the default and only output mode. See:
//!   packages/hq-cloud/src/bin/sync-runner.ts
//!
//! ## Binary resolution: `npx` (not a global install)
//!
//! We spawn `npx -y --package=@indigoai-us/hq-cloud@<ver> hq-sync-runner ...`
//! instead of requiring `hq-sync-runner` to be on PATH. This keeps the
//! install story simple: the HQ Sync DMG needs Node.js on the machine
//! (already enforced by the installer's deps step) and nothing else — the
//! runner is downloaded into npx's on-disk cache (`~/.npm/_npx/`) on first
//! use and reused forever after.
//!
//! **Why not a global `npm install -g`?** Tried it twice; both times a
//! later UX-polish pass decided "hq-cloud isn't really a prereq" and
//! removed it from the installer's DEPS list, re-breaking every fresh
//! install. Putting the dependency at the spawn site (this file) means
//! there's no separate list to forget. See PRs #9 / #15 in hq-installer.
//!
//! **Version selection:** `HQ_CLOUD_VERSION` below is authoritative. It is
//! a tilde-prefixed semver range (`~MAJOR.MINOR.0`) — npx resolves it to
//! the newest published patch in that minor line at spawn time. So
//! patch-only bug fixes ship to users on their next sync without a Rust
//! rebuild, while bumping the minor line (e.g. `~5.19.0` → `~5.20.0`) is
//! the deliberate "ship a new behavior set" lever and still requires an
//! HQ Sync release. See `commands::prewarm` for the on-startup background
//! fetch that keeps first-click-Sync-Now latency near zero after either
//! kind of bump.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::SecondsFormat;
#[cfg(test)]
use hq_desktop_core::sync_outcome::classify_runner_exit_disposition;
use hq_desktop_core::sync_outcome::{
    classify_error_event, classify_runner_error_class,
    classify_runner_exit_disposition_with_cancellation, classify_runner_fatal_class,
    classify_windows_exit_status, describe_exit, runner_phase_elapsed_bucket,
    runner_phase_from_event, runner_stack_shape, should_synthesize_all_complete,
    termination_fingerprint_token, windows_exit_status_hex, windows_fault_symbol, RunnerErrorClass,
    RunnerExitDisposition, SyncCancelCause,
};
use hq_desktop_core::toolchain::ManagedToolchain;
use tauri::{AppHandle, Emitter};

use crate::commands::cognito;
use crate::commands::config::{ensure_machine_id, HqConfig, MenubarPrefs};
#[cfg(test)]
use crate::commands::process::run_process_impl;
use crate::commands::process::{
    abandon_process_generation, app_exit_requested, cancel_process_for_generation,
    cancellation_record_for_generation, generation_for_handle, is_cancelled_for_generation,
    run_process_impl_for_generation, try_register_handle_gen, CancellationRecord, ProcessEvent,
    SpawnArgs,
};
use crate::commands::status::{journal_for_sync_complete, write_journal};
use crate::commands::vault_client::VaultClient;
use crate::events::{
    SyncAllCompleteEvent, SyncAuthErrorEvent, SyncCompanyProvisionedEvent, SyncErrorEvent,
    SyncEvent, EVENT_SYNC_ALL_COMPLETE, EVENT_SYNC_AUTH_ERROR, EVENT_SYNC_COMPANY_PROVISIONED,
    EVENT_SYNC_COMPLETE, EVENT_SYNC_DELETE_REFUSED_STALE_ETAG, EVENT_SYNC_ERROR,
    EVENT_SYNC_FANOUT_PLAN, EVENT_SYNC_NEW_FILES, EVENT_SYNC_PLAN, EVENT_SYNC_PROGRESS,
    EVENT_SYNC_SETUP_NEEDED,
};
use crate::util::logfile::log;
use crate::util::paths;

/// Singleton handle — only one sync at a time.
const SYNC_HANDLE: &str = "hq-sync";

/// Hard timeout for a sync run (1 hour).
const SYNC_TIMEOUT: Duration = Duration::from_secs(3600);

/// SIGKILL delay after SIGTERM on cancel.
const SIGKILL_DELAY: Duration = Duration::from_secs(5);

pub use hq_desktop_core::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};
pub use hq_desktop_core::sync_outcome::RunTotals;

// ─────────────────────────────────────────────────────────────────────────────
// Error reporting
// ─────────────────────────────────────────────────────────────────────────────

/// Emit a `sync:error` Tauri event AND capture the message to Sentry.
///
/// Used at exactly one call site today: the runner non-zero exit handler
/// in `start_sync`'s background task. By the time we reach that site, the
/// runner's content-safe stderr breadcrumbs have already accumulated on the
/// Sentry scope (see `ProcessEvent::Stderr` arm), so the captured event ships
/// with a classified, counted trail and no raw process output.
///
/// Other emit sites (`personal first-push`, runner-emitted ndjson `error`
/// events on stdout, `run_process_impl` spawn failures) intentionally
/// only call `app.emit(...)` — see the comments at each site for why.
/// In short: those failure modes either happen before the runner is up
/// (no breadcrumbs to attach) or are per-file errors that don't terminate
/// the run. If they prove to be recurring silent failures, add an explicit
/// `report_sync_error(...)` call at the relevant site.
///
/// History: prior to this helper, the `hq-sync-runner exited with code …`
/// path surfaced in the UI but never reached Sentry, so `#hq-alerts` was
/// silent during prod sync failures. See the broader silent-prod-error
/// fix for hq-onboarding (Cognito `invalid_client`) for the incident
/// context.
/// Capture a sync failure to Sentry (tags: company, path) — no UI event.
/// Shared by `report_sync_error` (manual Sync Now) and the auto-sync daemon so
/// BOTH paths surface runner failures in #hq-alerts.
pub(crate) fn capture_sync_error(company: Option<&str>, path: &str, message: &str) {
    capture_sync_error_impl(company, path, message, None, &[], &[]);
}

pub(crate) fn capture_sync_error_with_fingerprint(
    company: Option<&str>,
    path: &str,
    message: &str,
    fingerprint: &[&str],
) {
    capture_sync_error_impl(company, path, message, Some(fingerprint), &[], &[]);
}

/// Capture a sync error with content-safe context for a single diagnostic
/// boundary. Tags and extras are deliberately passed separately from the
/// fingerprint: caller-supplied paths or raw messages must never affect
/// grouping.
pub(crate) fn capture_sync_error_with_fingerprint_and_context(
    company: Option<&str>,
    path: &str,
    message: &str,
    fingerprint: &[&str],
    tags: &[(&str, String)],
    extras: &[(&str, sentry::protocol::Value)],
) {
    capture_sync_error_impl(company, path, message, Some(fingerprint), tags, extras);
}

fn capture_sync_error_impl(
    company: Option<&str>,
    path: &str,
    message: &str,
    fingerprint: Option<&[&str]>,
    tags: &[(&str, String)],
    extras: &[(&str, sentry::protocol::Value)],
) {
    sentry::with_scope(
        |scope| {
            if let Some(c) = company {
                scope.set_tag("company", c);
            }
            scope.set_tag("path", path);
            if let Some(fingerprint) = fingerprint {
                scope.set_fingerprint(Some(fingerprint));
            }
            for (key, value) in tags {
                scope.set_tag(*key, value.as_str());
            }
            for (key, value) in extras {
                scope.set_extra(*key, value.clone());
            }
        },
        || {
            sentry::capture_message(&format!("[sync] {message}"), sentry::Level::Error);
        },
    );
}

#[derive(Debug, Clone)]
struct RunnerPhaseContext {
    phase: &'static str,
    observed_at: Instant,
}

impl Default for RunnerPhaseContext {
    fn default() -> Self {
        Self {
            phase: "unknown",
            observed_at: Instant::now(),
        }
    }
}

fn observe_manual_runner_phase(phase_context: &Mutex<RunnerPhaseContext>, event: &SyncEvent) {
    let Some(phase) = runner_phase_from_event(event) else {
        return;
    };
    let now = Instant::now();
    let mut context = phase_context
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if context.phase != phase {
        context.phase = phase;
        context.observed_at = now;
    }
}

const RUNNER_STDERR_TAIL_CAP: usize = 8;

fn push_runner_stderr_tail(tail: &mut VecDeque<String>, line: String) {
    if tail.len() == RUNNER_STDERR_TAIL_CAP {
        tail.pop_front();
    }
    tail.push_back(line);
}

#[derive(Debug, Clone)]
struct ManualRunnerExitContext {
    sync_scope: String,
    runner_phase: String,
    runner_phase_elapsed_bucket: String,
    stderr_tail: Vec<String>,
}

impl Default for ManualRunnerExitContext {
    fn default() -> Self {
        Self {
            sync_scope: "all".to_string(),
            runner_phase: "unknown".to_string(),
            runner_phase_elapsed_bucket: "under_1m".to_string(),
            stderr_tail: Vec::new(),
        }
    }
}

fn manual_runner_exit_context(
    scope: &SyncRunScope,
    phase_context: &Mutex<RunnerPhaseContext>,
    stderr_tail: &Mutex<VecDeque<String>>,
) -> ManualRunnerExitContext {
    let phase_context = phase_context
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stderr_tail = stderr_tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ManualRunnerExitContext {
        sync_scope: match scope {
            SyncRunScope::All => "all",
            SyncRunScope::Company(_) => "single_company",
        }
        .to_string(),
        runner_phase: phase_context.phase.to_string(),
        runner_phase_elapsed_bucket: runner_phase_elapsed_bucket(
            phase_context.observed_at.elapsed(),
        )
        .to_string(),
        stderr_tail: stderr_tail.iter().cloned().collect(),
    }
}

fn runner_exit_telemetry_context(
    code: Option<i32>,
    totals: &RunTotals,
    context: &ManualRunnerExitContext,
    sync_termination_reason: &'static str,
) -> (
    Vec<(&'static str, String)>,
    Vec<(&'static str, sentry::protocol::Value)>,
) {
    let stack = runner_stack_shape(&context.stderr_tail);
    let mut tags = vec![
        ("sync_route", "manual".to_string()),
        ("sync_scope", context.sync_scope.clone()),
        ("runner_phase", context.runner_phase.clone()),
        ("runner_stack_shape", stack.shape),
        ("runner_stack_signature", stack.signature),
    ];
    if let Some(rollup) = totals.runner_error_rollup.tag_value() {
        tags.push(("runner_error_rollup", rollup));
    }
    if let Some(operations) = totals.runner_error_ops.tag_value() {
        tags.push(("runner_error_ops", operations));
    }
    tags.push((
        "runner_fatal_class",
        totals.runner_fatal_class.as_str().to_string(),
    ));
    tags.push((
        "sync_termination_reason",
        sync_termination_reason.to_string(),
    ));
    if let Some(code) = code {
        let termination = classify_windows_exit_status(code);
        if termination.is_windows_status() {
            tags.push(("windows_exit_status", windows_exit_status_hex(code)));
            tags.push(("windows_exit_class", termination.class_name().to_string()));
        }
        if let Some(symbol) = windows_fault_symbol(code) {
            tags.push(("windows_fault_symbol", symbol.to_string()));
        }
    }
    let extras = vec![
        (
            "saw_alertable_error",
            sentry::protocol::Value::Bool(totals.saw_alertable_error),
        ),
        (
            "saw_node_too_old",
            sentry::protocol::Value::Bool(totals.saw_node_too_old),
        ),
        (
            "saw_fatal_runner_signature",
            sentry::protocol::Value::Bool(totals.saw_fatal_runner_signature),
        ),
        (
            "runner_error_companies",
            sentry::protocol::Value::Number(totals.runner_error_company_count().into()),
        ),
        (
            "runner_phase_elapsed_bucket",
            sentry::protocol::Value::String(context.runner_phase_elapsed_bucket.clone()),
        ),
        ("runner_stack_depth", serde_json::json!(stack.depth)),
        (
            "runner_stack_redacted_frames",
            serde_json::json!(stack.redacted_frames),
        ),
    ];
    (tags, extras)
}

fn capture_runner_exit_error(
    code: Option<i32>,
    signal: Option<i32>,
    totals: &RunTotals,
    payload: &SyncErrorEvent,
    context: &ManualRunnerExitContext,
) {
    capture_runner_exit_error_with_termination_reason(
        code,
        signal,
        totals,
        payload,
        context,
        "uncancelled",
    );
}

fn capture_runner_exit_error_with_termination_reason(
    code: Option<i32>,
    signal: Option<i32>,
    totals: &RunTotals,
    payload: &SyncErrorEvent,
    context: &ManualRunnerExitContext,
    sync_termination_reason: &'static str,
) {
    let termination = termination_fingerprint_token(code, signal);
    let error_class = totals.runner_error_rollup.fingerprint_token();
    let fingerprint = [
        "sync",
        "runner-termination",
        termination.as_str(),
        error_class,
    ];
    let (tags, extras) =
        runner_exit_telemetry_context(code, totals, context, sync_termination_reason);
    capture_sync_error_with_fingerprint_and_context(
        payload.company.as_deref(),
        &payload.path,
        &payload.message,
        &fingerprint,
        &tags,
        &extras,
    );
}

/// A Windows console-control exit is benign telemetry-wise, but a manual sync
/// can receive it before the runner emits any protocol event. Emit the existing
/// terminal renderer event without capturing to Sentry so both desktop surfaces
/// leave their active-sync state instead of remaining stuck on "syncing".
fn terminal_sync_error_for_windows_console_control() -> SyncErrorEvent {
    SyncErrorEvent {
        company: None,
        path: "(runner)".to_string(),
        message: "Sync stopped by Windows. Please try Sync Now again.".to_string(),
    }
}

const TRANSIENT_RETRY_SYNC_ERROR_MESSAGE: &str =
    "Sync could not reach HQ. Please try Sync Now again.";

/// The generic terminal event ends the renderer's active-sync state while the
/// runner reports its retryable exit contract. It must never include
/// runner-supplied output, paths, or arguments.
fn terminal_sync_error_for_transient_retry() -> SyncErrorEvent {
    SyncErrorEvent {
        company: None,
        path: "(runner)".to_string(),
        message: TRANSIENT_RETRY_SYNC_ERROR_MESSAGE.to_string(),
    }
}

fn terminal_sync_error_for_cancelled_by_app(cause: SyncCancelCause) -> SyncErrorEvent {
    let message = match cause {
        SyncCancelCause::TimeoutWatchdog => "Sync was stopped after reaching the one-hour limit.",
        SyncCancelCause::UserStop | SyncCancelCause::AppQuit => "Sync was stopped.",
        // Only ever published by the auto-sync daemon watchdog against
        // DAEMON_HANDLE, so a manual sync's terminal boundary never actually
        // reads it; the arm keeps the match exhaustive with a plain message.
        SyncCancelCause::HeartbeatStall => "Sync was stopped after it stopped responding.",
    };
    SyncErrorEvent {
        company: None,
        path: "(runner)".to_string(),
        message: message.to_string(),
    }
}

/// Read only exact-generation evidence for the manual sync's terminal event.
/// App-exit remains a defensive fallback for a legacy cancellation that was
/// recorded before explicit causes existed; normal app-exit teardown stamps the
/// cause through `cancel_process_for_generation`.
fn cancellation_for_runner_exit(generation: u64) -> CancellationRecord {
    let mut record =
        cancellation_record_for_generation(SYNC_HANDLE, generation).unwrap_or_default();
    if record.cause.is_none()
        && app_exit_requested()
        && is_cancelled_for_generation(SYNC_HANDLE, generation)
    {
        record.cause = Some(SyncCancelCause::AppQuit);
    }
    record
}

/// Safe vocabulary on residual captures. `uncancelled` means no cancellation
/// cause was recorded. An effective cancellation whose status does not match
/// the app-owned termination shape remains loud and receives its own truthful
/// fixed value rather than being mislabeled as uncancelled.
fn residual_sync_termination_reason(
    cancellation: CancellationRecord,
    totals: &RunTotals,
) -> &'static str {
    match cancellation {
        CancellationRecord {
            cause: Some(_),
            termination_effected: true,
        } if totals.saw_alertable_error => "cancelled-with-alertable-error",
        CancellationRecord {
            cause: Some(_),
            termination_effected: false,
        } => "cancel-ineffective",
        CancellationRecord {
            cause: Some(_),
            termination_effected: true,
        } => "cancel-status-mismatch",
        _ => "uncancelled",
    }
}

/// Capture and surface the terminal runner error exactly once. The renderer
/// receives this event for UI state only; it deliberately does not submit a
/// second Sentry event for the same native capture.
fn report_runner_exit_error(
    app: &AppHandle,
    code: Option<i32>,
    signal: Option<i32>,
    totals: &RunTotals,
    payload: SyncErrorEvent,
    context: &ManualRunnerExitContext,
    sync_termination_reason: &'static str,
) -> tauri::Result<()> {
    capture_runner_exit_error_with_termination_reason(
        code,
        signal,
        totals,
        &payload,
        context,
        sync_termination_reason,
    );
    app.emit(EVENT_SYNC_ERROR, payload)
}

/// Effects performed after the shared core classifier decides how a manual
/// runner exit ends. Keeping effects behind this narrow seam lets the
/// real-child regression test exercise production routing without a live Tauri
/// app or Sentry transport.
trait RunnerExitEffects {
    fn log(&mut self, message: &str);
    fn capture_and_emit_exit(
        &mut self,
        code: Option<i32>,
        signal: Option<i32>,
        totals: &RunTotals,
        payload: SyncErrorEvent,
        context: &ManualRunnerExitContext,
    );
    fn emit_sync_error(&mut self, payload: SyncErrorEvent);
}

struct ProductionRunnerExitEffects<'a> {
    app: &'a AppHandle,
    sync_termination_reason: &'static str,
}

impl RunnerExitEffects for ProductionRunnerExitEffects<'_> {
    fn log(&mut self, message: &str) {
        log("sync", message);
    }

    fn capture_and_emit_exit(
        &mut self,
        code: Option<i32>,
        signal: Option<i32>,
        totals: &RunTotals,
        payload: SyncErrorEvent,
        context: &ManualRunnerExitContext,
    ) {
        let _ = report_runner_exit_error(
            self.app,
            code,
            signal,
            totals,
            payload,
            context,
            self.sync_termination_reason,
        );
    }

    fn emit_sync_error(&mut self, payload: SyncErrorEvent) {
        let _ = self.app.emit(EVENT_SYNC_ERROR, payload);
    }
}

/// Apply the single core disposition at the manual-sync boundary. The
/// classifier owns all code/signal/run-total branching; this function owns only
/// the corresponding capture, terminal-event, and local-log effects.
fn apply_runner_exit_disposition<E: RunnerExitEffects>(
    effects: &mut E,
    disposition: RunnerExitDisposition,
    code: Option<i32>,
    signal: Option<i32>,
    exit_desc: &str,
    totals: &RunTotals,
    context: &ManualRunnerExitContext,
) {
    match disposition {
        RunnerExitDisposition::Alert => effects.capture_and_emit_exit(
            code,
            signal,
            totals,
            SyncErrorEvent {
                company: None,
                path: "(runner)".to_string(),
                message: format!("hq-sync-runner exited {exit_desc}"),
            },
            context,
        ),
        RunnerExitDisposition::NodeTooOld => {
            effects.log(&format!(
                "runner exited non-zero ({exit_desc}) due to Node too old — surfacing update-Node message, not alerting"
            ));
            effects.emit_sync_error(SyncErrorEvent {
                company: None,
                path: "(node)".to_string(),
                message: format!(
                    "HQ Sync needs Node {MIN_NODE_MAJOR} or newer to sync. \
                     Please update Node (https://nodejs.org), then try Sync again."
                ),
            });
        }
        RunnerExitDisposition::WindowsConsoleControl => {
            effects.log(&format!(
                "runner exited non-zero ({exit_desc}) from a Windows console-control event \
                 — ending Sync Now UI state without alerting"
            ));
            effects.emit_sync_error(terminal_sync_error_for_windows_console_control());
        }
        RunnerExitDisposition::TransientRetry => {
            effects.log(&format!(
                "runner exited non-zero ({exit_desc}) for a transient HQ network retry — ending Sync Now UI state without alerting"
            ));
            effects.emit_sync_error(terminal_sync_error_for_transient_retry());
        }
        RunnerExitDisposition::CancelledByApp(cause) => {
            effects.log(&format!(
                "runner exited non-zero ({exit_desc}) after app-owned {} cancellation \
                 — ending Sync Now UI state without alerting",
                cause.as_str(),
            ));
            effects.emit_sync_error(terminal_sync_error_for_cancelled_by_app(cause));
        }
        RunnerExitDisposition::Ignore => effects.log(&format!(
            "runner exited non-zero ({exit_desc}) but fully explained by benign conditions \
             (cancelled / locked / not-provisioned / network reset) — not alerting"
        )),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (inline — avoids calling async Tauri command)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the HQ folder path by reading config.json and menubar.json directly.
fn resolve_hq_folder_path() -> Result<String, String> {
    let menubar_path = paths::menubar_json_path()?;

    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    // Shared lenient reader: parse failures fall through to menubar/discovery,
    // but real IO errors still propagate as Err. Uniform across all four
    // `resolve_hq_folder_path` duplicates.
    let config = crate::commands::config::read_hq_config_lenient()?;

    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    Ok(hq_folder.to_string_lossy().to_string())
}

/// Resolve the vault API URL. Precedence (highest to lowest):
///   1. `HQ_VAULT_API_URL` env var — dev/test override.
///   2. `~/.hq/config.json` `vault_api_url` field — legacy installer-provisioned
///      setups continue to work without migration. Read errors fall through
///      to the default rather than aborting (the file may be partial/stale).
///   3. Hardcoded canonical hq.computer URL — lets create-hq users (and anyone
///      with `companies/{slug}/company.yaml: { cloud: true }` but no global
///      config) run hq-sync directly. `provision_missing_companies` then
///      walks the YAMLs and writes per-company `.hq/config.json` files
///      itself, so the global config.json is no longer required.
///
/// See hq-pro ADR-0003 for the canonical-stage rationale.
pub(crate) fn resolve_vault_api_url() -> Result<String, String> {
    const DEFAULT_VAULT_API_URL: &str = "https://hqapi.hq.computer";

    if let Ok(url) = std::env::var("HQ_VAULT_API_URL") {
        if !url.is_empty() {
            return Ok(url);
        }
    }

    let config_path = paths::config_json_path()?;
    if config_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<HqConfig>(&contents) {
                return Ok(config.vault_api_url);
            }
        }
    }

    Ok(DEFAULT_VAULT_API_URL.to_string())
}

/// Testable core: given a pre-fetched token result and a refresh function,
/// return a fresh access token (refreshing if expired).
///
/// The `tokens = refreshed;` reassignment is the critical line that routes the
/// returned token through the refreshed struct — removing it causes the function
/// to return the stale access_token. `test_start_sync_jwt_fetch_uses_refreshed_token`
/// asserts this.
async fn resolve_jwt_impl<F, Fut>(
    tokens_result: Result<Option<cognito::CognitoTokens>, String>,
    refresh_fn: F,
) -> Result<String, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<cognito::CognitoTokens, String>>,
{
    let mut tokens =
        tokens_result?.ok_or_else(|| "Not signed in — please complete setup first".to_string())?;
    if cognito::is_expired(&tokens) {
        let refreshed = refresh_fn(tokens.refresh_token).await?;
        tokens = refreshed;
    }
    Ok(tokens.access_token)
}

#[derive(Debug, PartialEq, Eq)]
enum ResolveJwtError {
    NeedsReauth,
    Other(String),
}

/// Fetch the current JWT from the on-disk token cache, refreshing and
/// persisting it if expired. Terminal refresh rejection invalidates only the
/// rejected token generation; a temporary failure preserves it but still
/// routes this run to the reauth surface after the built-in retry is exhausted.
async fn resolve_jwt_classified() -> Result<String, ResolveJwtError> {
    let tokens = cognito::get_tokens()
        .await
        .map_err(ResolveJwtError::Other)?
        .ok_or(ResolveJwtError::NeedsReauth)?;
    if !cognito::is_expired(&tokens) {
        return Ok(tokens.access_token);
    }

    match cognito::refresh_access_token_classified(&tokens.refresh_token).await {
        Ok(refreshed) => {
            let access_token = refreshed.access_token.clone();
            cognito::set_tokens(&refreshed)
                .await
                .map_err(ResolveJwtError::Other)?;
            Ok(access_token)
        }
        Err(err) => {
            if err.requires_reauth {
                cognito::invalidate_tokens(&tokens)
                    .await
                    .map_err(ResolveJwtError::Other)?;
            }
            Err(ResolveJwtError::NeedsReauth)
        }
    }
}

/// Shared auth helper used by non-sync commands. Keep the long-standing
/// string-error contract while the manual sync path consumes the structured
/// result above to distinguish handled reauth from an operational failure.
pub async fn resolve_jwt() -> Result<String, String> {
    resolve_jwt_classified().await.map_err(|err| match err {
        ResolveJwtError::NeedsReauth => cognito::REAUTH_MESSAGE.to_string(),
        ResolveJwtError::Other(message) => message,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// SpawnArgs builder (testable)
// ─────────────────────────────────────────────────────────────────────────────

/// Scope of a single sync run: fan out to every membership (`All`) or restrict
/// to one company by slug (`Company`). A scoped run emits `--company <slug>`
/// (mutually exclusive with `--companies` in the runner) and never touches the
/// personal vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncRunScope {
    All,
    Company(String),
}

impl SyncRunScope {
    /// True when this scope includes the given company slug.
    pub fn includes(&self, slug: &str) -> bool {
        match self {
            SyncRunScope::All => true,
            SyncRunScope::Company(c) => c == slug,
        }
    }

    pub fn is_all(&self) -> bool {
        matches!(self, SyncRunScope::All)
    }
}

/// Validate a caller-supplied company slug for a scoped sync. `None` => `All`.
/// Slugs are lowercase alphanumeric + hyphen, non-empty, and never `personal`
/// (the personal vault has its own sync path/toggle, not a company scope).
pub fn parse_sync_scope(company_slug: Option<String>) -> Result<SyncRunScope, String> {
    match company_slug {
        None => Ok(SyncRunScope::All),
        Some(s) => {
            let slug = s.trim();
            if slug.is_empty() {
                return Err("company slug must not be empty".to_string());
            }
            if slug == "personal" {
                return Err("personal vault cannot be company-scoped".to_string());
            }
            if !slug
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return Err(format!("invalid company slug: {slug}"));
            }
            Ok(SyncRunScope::Company(slug.to_string()))
        }
    }
}

/// Inject `HQ_SYNC_SKIP_COMPANIES` for All-scope runs so the runner drops
/// companies the user paused via per-workspace Off toggles.
fn apply_skip_companies_env(env: &mut HashMap<String, String>, scope: &SyncRunScope) {
    if !scope.is_all() {
        return;
    }
    let disabled = hq_desktop_core::workspaces::disabled_workspace_sync_slugs();
    if disabled.is_empty() {
        return;
    }
    env.insert("HQ_SYNC_SKIP_COMPANIES".to_string(), disabled.join(","));
}

/// Build the SpawnArgs for `npx … hq-sync-runner --companies` or a scoped
/// `npx … hq-sync-runner --company <slug>` run.
///
/// The command line we spawn looks like:
/// ```text
/// npx -y --package=@indigoai-us/hq-cloud@~5.19.0 hq-sync-runner \
///   <--companies | --company <slug>> --direction both --on-conflict keep \
///   --hq-root <path>
/// ```
///
/// npx flags:
/// - `-y` / `--yes` — auto-confirm the "Need to install the following
///   packages — Ok to proceed?" prompt. Without this, npx blocks on stdin
///   (our Tauri subprocess has no interactive stdin → hang).
/// - `--package=<pkg>@<ver>` — tells npx which package provides the bin,
///   since the bin name (`hq-sync-runner`) doesn't match the package
///   name (`@indigoai-us/hq-cloud`). The `@<ver>` pin makes the cache
///   key deterministic: same pin → same cache hit → no redownload.
///
/// Runner flags:
/// - `--companies` — fan out to every membership the caller has
/// - `--company <slug>` — restrict the run to one company
/// - `--direction both` — bidirectional sync: push local changes first,
///   then pull remote. Added in hq-cloud 5.1.11. Runner default is `pull`
///   for back-compat; the menubar explicitly opts into `both` so a single
///   "Sync Now" click broadcasts local edits AND pulls remote updates.
/// - `--on-conflict keep` — preserve local edits when a divergent file is
///   detected, instead of aborting the company-wide sync. With `abort`, a
///   single conflicting file halted every other file's progress. `keep`
///   keeps the user's local copy as-is and continues syncing the rest.
/// - `--hq-root <path>` — local HQ directory
///
/// `HQ_ROOT` is also set in the child env as defense-in-depth (matches the
/// pre-Phase-7 pattern).
///
/// `personal_sync_enabled` toggles the personal-vault target in an all-company
/// fanout. When false, `--skip-personal` is appended so the spawned runner's
/// `resolveSkipPersonal()` drops the personal slot. Company-scoped runs always
/// append `--skip-personal`. Sourced from `MenubarPrefs.personal_sync_enabled`
/// (defaults to true in get_settings).
pub fn build_sync_spawn_args(
    hq_folder_path: &str,
    personal_sync_enabled: bool,
    scope: &SyncRunScope,
) -> SpawnArgs {
    let mut env = HashMap::new();
    env.insert("HQ_ROOT".to_string(), hq_folder_path.to_string());
    // The runner is a Node script with `#!/usr/bin/env node`, and npx itself
    // is `#!/usr/bin/env node`. Without a real PATH, `env` can't find node on
    // Dock-launched apps and either process exits with code 127. See
    // `paths::child_path`.
    env.insert("PATH".to_string(), paths::child_path());
    // Per-company Off toggles persist in menubar.json; honor them on All-scope
    // fanout so Sync Now does not upload/download paused companies.
    apply_skip_companies_env(&mut env, scope);

    let mut args = vec![
        "-y".to_string(),
        format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        RUNNER_BIN.to_string(),
    ];
    match scope {
        SyncRunScope::All => args.push("--companies".to_string()),
        SyncRunScope::Company(slug) => {
            args.push("--company".to_string());
            args.push(slug.clone());
        }
    }
    args.extend([
        "--direction".to_string(),
        "both".to_string(),
        "--on-conflict".to_string(),
        "keep".to_string(),
        "--hq-root".to_string(),
        hq_folder_path.to_string(),
    ]);
    if !personal_sync_enabled || !scope.is_all() {
        // Append rather than insert mid-args so reading the joined command
        // line in logs / Sentry tags is predictable (toggle state shows at
        // the end, after the canonical args).
        args.push("--skip-personal".to_string());
    }

    SpawnArgs {
        // Resolve npx via known install prefixes + login-shell PATH fallback.
        // See `paths::resolve_bin` — GUI-launched Tauri apps get a minimal
        // launchd PATH and would otherwise fail with os error 2 on `npx`
        // (which lives in /opt/homebrew/bin or ~/.npm-global/bin, not in
        // /usr/bin). npx is part of npm, which is a listed installer prereq.
        cmd: paths::resolve_bin("npx"),
        args,
        cwd: None,
        env: Some(env),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ndjson line handler (testable)
// ─────────────────────────────────────────────────────────────────────────────

/// Parse a single ndjson line and emit the corresponding Tauri event.
/// Unknown/malformed lines are silently skipped (logged in debug builds).
///
/// Per-company `Complete` events also accumulate into `totals`. On
/// `all-complete`, the aggregated totals are persisted to
/// `{hq_folder}/.hq-sync-journal.json` so `get_sync_status` surfaces a real
/// `lastSyncAt` and conflict count instead of "never" / zero.
fn handle_sync_line<R: tauri::Runtime>(
    app: &AppHandle<R>,
    hq_folder: &str,
    totals: &Mutex<RunTotals>,
    phase_context: &Mutex<RunnerPhaseContext>,
    jwt: &str,
    line: &str,
) {
    // The runner can emit blank lines at process teardown. Skip those cheaply
    // rather than logging a parse error.
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let event: SyncEvent = match serde_json::from_str(trimmed) {
        Ok(e) => e,
        Err(_e) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[sync] skipping unparseable line: {} | line: {}",
                _e, trimmed
            );
            return;
        }
    };

    observe_manual_runner_phase(phase_context, &event);

    // Accumulate per-run counters before emitting. Poisoned locks shouldn't
    // happen in practice (no panics while the mutex is held), but we recover
    // by using the inner value rather than crashing the sync thread.
    {
        let mut t = totals.lock().unwrap_or_else(|e| e.into_inner());
        t.accumulate(&event);
    }

    // Unit struct variants (SetupNeeded) serialize to `()` when emitted via
    // Tauri's `emit(...)` — the frontend gets the event name and an empty
    // payload, which is exactly what we want for a "caller has no person
    // entity" signal.
    let result = match &event {
        SyncEvent::SetupNeeded => app.emit(EVENT_SYNC_SETUP_NEEDED, ()),
        SyncEvent::AuthError(payload) => app.emit(EVENT_SYNC_AUTH_ERROR, payload.clone()),
        SyncEvent::FanoutPlan(payload) => app.emit(EVENT_SYNC_FANOUT_PLAN, payload.clone()),
        // Per-company / per-direction Stage-1 totals from `hq-sync-runner`
        // (≥hq-cloud@5.5.0). Forwarded to the Svelte frontend so it can
        // refine the progress denominator established by EVENT_SYNC_TOTALS
        // before any per-file Progress events arrive. When connected to an
        // older runner that doesn't emit Plan, this branch is simply never
        // taken — the existing TOTALS-based denominator stays authoritative.
        SyncEvent::Plan(payload) => app.emit(EVENT_SYNC_PLAN, payload.clone()),
        SyncEvent::Progress(payload) => {
            // Record into the session activity log (uploaded/downloaded with a
            // timestamp) and live-append to the Recent Changes window if open.
            crate::commands::activity::record_progress(app, payload);
            app.emit(EVENT_SYNC_PROGRESS, payload.clone())
        }
        SyncEvent::Error(payload) => {
            // `classify_error_event` is the test-covered classification boundary;
            // the dispatch logic here (Some → COMPLETE, None → ERROR) is intentionally
            // kept to these two lines so it is visually auditable without a harness.
            if let Some(complete_event) = classify_error_event(payload) {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[sync] company '{}' not yet on S3 — treating as empty sync: {}",
                    complete_event.company, payload.message
                );
                // Synthetic completes are excluded from RunTotals by design:
                // all fields are zero so accumulate would be a no-op today, and
                // these companies have no real files to count.
                app.emit(EVENT_SYNC_COMPLETE, complete_event)
            } else {
                // Per-file ndjson `error` events from the runner. These are
                // *not* captured to Sentry here — the runner-level error
                // (likely visible in stderr breadcrumbs) will surface via the
                // `report_sync_error` capture at the non-zero-exit site below
                // if the run terminates because of these. Per-file errors that
                // co-exist with a clean exit (`success=true, errors[] in
                // all-complete`) are intentionally renderer-only.
                app.emit(EVENT_SYNC_ERROR, payload.clone())
            }
        }
        SyncEvent::Complete(payload) => app.emit(EVENT_SYNC_COMPLETE, payload.clone()),
        // hq-cloud ≥5.24.0. Emitted only by the `currency-gated` policy;
        // pre-5.24 runners silently never emit this and the branch is dead.
        // Forward to the renderer as a warning row — the file was kept on
        // remote because peer drift or a missing journal etag made the
        // delete unsafe to propagate.
        SyncEvent::DeleteRefusedStaleEtag(payload) => {
            app.emit(EVENT_SYNC_DELETE_REFUSED_STALE_ETAG, payload.clone())
        }
        SyncEvent::NewFiles(payload) => {
            // Reconcile into the activity log: mark these paths as "added" (vs
            // the default "updated") and back-fill author from `addedBy` where
            // the per-file progress event carried none. Lands after the rows'
            // progress events, so this back-fills + re-emits to the open window.
            crate::commands::activity::record_new_files(app, payload);
            app.emit(EVENT_SYNC_NEW_FILES, payload.clone())
        }
        SyncEvent::AllComplete(payload) => {
            // Persist summary journal before emitting — the frontend's
            // SyncStats refresh reads this file on popover mount.
            let conflicts = totals.lock().unwrap_or_else(|e| e.into_inner()).conflicts;
            let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            let journal = journal_for_sync_complete(&now_iso, conflicts);
            if let Err(_e) = write_journal(hq_folder, &journal) {
                log("sync", &format!("failed to write journal: {_e}"));
                #[cfg(debug_assertions)]
                eprintln!("[sync] failed to write journal: {}", _e);
            }
            log("sync", &format!("all-complete (conflicts={conflicts})"));
            // Mirror the HQ folder into its own git repo (if any) so the
            // sync also captures a versioned snapshot. Fire-and-forget;
            // never blocks the AllComplete handler.
            crate::commands::git_mirror::spawn_mirror_after_sync(hq_folder);
            let emit_result = app.emit(EVENT_SYNC_ALL_COMPLETE, payload.clone());
            let app_clone = app.clone();
            let hq = hq_folder.to_string();
            let jwt_owned = jwt.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::telemetry::send_telemetry_if_opted_in(
                    &app_clone, &hq, &jwt_owned,
                )
                .await;
            });
            // Reconcile manifest with on-disk reality. The runner downloads
            // cloud-only companies into `companies/{slug}/` as a side effect of
            // file writes — the manifest needs to learn about those folders so
            // they don't render as "Cloud Only" forever after. Best-effort and
            // fire-and-forget; failures are logged but don't surface to the UI.
            let hq_for_reconcile = hq_folder.to_string();
            let jwt_for_reconcile = jwt.to_string();
            tauri::async_runtime::spawn(async move {
                let vault_url = match crate::commands::sync::resolve_vault_api_url() {
                    Ok(u) => u,
                    Err(e) => {
                        log("sync", &format!("reconcile skipped: vault url: {e}"));
                        return;
                    }
                };
                let vault =
                    crate::commands::vault_client::VaultClient::new(&vault_url, &jwt_for_reconcile);
                match crate::commands::workspaces::reconcile_manifest_after_sync(
                    std::path::Path::new(&hq_for_reconcile),
                    &vault,
                )
                .await
                {
                    Ok(0) => {} // nothing new — common case, stay quiet
                    Ok(n) => log(
                        "sync",
                        &format!("reconcile: added {n} new manifest entries"),
                    ),
                    Err(e) => log("sync", &format!("reconcile failed (non-fatal): {e}")),
                }
            });
            emit_result
        }
    };

    if let Err(_e) = result {
        #[cfg(debug_assertions)]
        eprintln!("[sync] failed to emit event: {}", _e);
    }
}

/// Return the re-authentication signal encoded in a runner stderr line.
///
/// The runner's normal protocol is tagged with `type`, but some auth refresh
/// failures are logged with `level` instead. Both shapes must reach the
/// renderer: the runner exits successfully after an unrecoverable refresh
/// failure, so waiting for a non-zero exit drops the sign-in prompt.
pub(crate) fn runner_stderr_needs_reauth(line: &str) -> Option<SyncAuthErrorEvent> {
    if let Ok(SyncEvent::AuthError(payload)) = serde_json::from_str(line.trim()) {
        return Some(payload);
    }

    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let is_auth_error = ["type", "level"]
        .iter()
        .any(|field| value.get(*field).and_then(serde_json::Value::as_str) == Some("auth-error"));
    if !is_auth_error {
        return None;
    }

    Some(SyncAuthErrorEvent {
        message: value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(cognito::REAUTH_MESSAGE)
            .to_string(),
    })
}

fn runner_stderr_breadcrumb(sequence: u32, line: &str) -> sentry::Breadcrumb {
    let error_class = match classify_runner_error_class(line) {
        RunnerErrorClass::Eperm => "eperm",
        RunnerErrorClass::Eacces => "eacces",
        RunnerErrorClass::Enospc => "enospc",
        RunnerErrorClass::Ebusy => "ebusy",
        RunnerErrorClass::Network => "network",
        RunnerErrorClass::Auth => "auth",
        RunnerErrorClass::Other => "other",
    };
    let fatal_class = classify_runner_fatal_class(line).as_str();
    sentry::Breadcrumb {
        category: Some("runner.stderr".into()),
        level: sentry::Level::Warning,
        message: Some(format!(
            "runner stderr #{sequence} ({error_class};{fatal_class})"
        )),
        ..Default::default()
    }
}

fn update_runner_stderr_totals(
    totals: &Mutex<RunTotals>,
    line: &str,
) -> Option<SyncAuthErrorEvent> {
    let reauth = runner_stderr_needs_reauth(line);
    let runner_error = if reauth.is_none() {
        serde_json::from_str::<SyncEvent>(line.trim())
            .ok()
            .and_then(|event| match event {
                SyncEvent::Error(payload) => Some(payload),
                _ => None,
            })
    } else {
        None
    };

    let mut totals = totals.lock().unwrap_or_else(|e| e.into_inner());
    if reauth.is_some() {
        totals.record_auth_error();
    } else if let Some(payload) = runner_error.as_ref() {
        totals.record_error(payload);
    }
    totals.record_stderr_line(line);
    reauth
}

/// Forward runner stderr protocol records that affect sync state.
///
/// Error records still feed the exit-alert classifier; auth failures are
/// emitted immediately because the runner deliberately exits 0 after them.
pub(crate) fn handle_runner_stderr_line<R: tauri::Runtime>(
    app: &AppHandle<R>,
    totals: &Mutex<RunTotals>,
    line: &str,
) {
    if let Some(payload) = update_runner_stderr_totals(totals, line) {
        let _ = app.emit(EVENT_SYNC_AUTH_ERROR, payload);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

// ── Runner preflights (HQ-SYNC-2 / HQ-SYNC-E / HQ-DESKTOP-B3) ───────────────
//
// Proactive, best-effort checks run just before spawning the runner so a
// known-doomed spawn is turned into one clear, user-actionable message instead
// of a silent crash (a Node too old to start the runner, or node/npx not
// resolvable at all — which falls through to a bare shell and exits 127,
// crash-looping the watcher). Every probe fails OPEN: one we couldn't run
// (missing binary, non-zero exit, unparseable output) returns `None`, so the
// preflight can only ever prevent a doomed spawn, never block a sync that
// would have worked.
//
// A machine with no usable Node is an expected *environment* fault and stays
// local-only. HQ's own managed Node disappearing is not: the runner then falls
// back to whatever Node is on PATH, which on one reported machine was a
// nvm-era v8, so every sync bailed "Node too old" while the user's real Node
// was v24. That case is repaired here rather than reported as the user's
// problem, and it is the one preflight failure that alarms (see the daemon's
// capture policy).

/// Node major-version floor the sync runner requires — its deps use APIs added
/// in Node 20 and it crashes at startup on anything older.
const MIN_NODE_MAJOR: u32 = 20;

/// Minimum gap between managed-Node repair attempts. A machine that cannot
/// install (offline, locked down, out of disk) must not re-download the
/// runtime on every click of Sync Now.
const TOOLCHAIN_REPAIR_COOLDOWN: Duration = Duration::from_secs(15 * 60);

/// Parse the major from `node --version` output (`v20.11.1` → `20`).
fn parse_node_major(version_output: &str) -> Option<u32> {
    let s = version_output.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    s.split('.').next()?.parse::<u32>().ok()
}

fn is_node_too_old(major: u32) -> bool {
    major < MIN_NODE_MAJOR
}

/// Clear, non-technical message when the user's Node is too old to run the
/// runner — names the floor, their current major, where it came from, and the
/// single fix.
fn node_too_old_message(current_major: u32, node_path: Option<&str>) -> String {
    let found = match node_path {
        Some(path) => format!(" (Node {current_major} at {path})"),
        None => format!(" (Node {current_major})"),
    };
    format!(
        "HQ Sync needs Node {MIN_NODE_MAJOR} or newer to sync — this computer is running Node {current_major}{found}. \
         Please update Node (https://nodejs.org), then try Sync again."
    )
}

/// The half of the message that holds however the repair went: HQ's own Node
/// is the missing piece, and what the runner reached for in its place.
///
/// Naming both paths is the whole point — the reported user's system Node was
/// fine, and being told to update it sent them nowhere.
fn managed_node_diagnosis(
    expected_node: &str,
    found_major: Option<u32>,
    found_path: Option<&str>,
) -> String {
    let Some(found_major) = found_major else {
        return format!(
            "HQ Sync's own Node runtime is missing from {expected_node} and this computer has no \
             other Node to fall back to, so sync can't start"
        );
    };
    let found = match found_path {
        Some(path) => format!("Node {found_major} at {path}"),
        None => format!("Node {found_major}"),
    };
    format!(
        "HQ Sync's own Node runtime is missing from {expected_node}, so sync fell back to the {found} \
         already on this computer — too old to run the sync engine. Your own Node install is fine; \
         HQ's copy is the broken one"
    )
}

/// The case the generic "update Node" advice gets wrong, before HQ has tried to
/// put its runtime back.
fn managed_node_missing_message(
    expected_node: &str,
    found_major: Option<u32>,
    found_path: Option<&str>,
) -> String {
    format!(
        "{}. Click Sync Now to let HQ reinstall it.",
        managed_node_diagnosis(expected_node, found_major, found_path)
    )
}

/// Same diagnosis, after HQ tried to reinstall its runtime and could not.
fn managed_node_repair_failed_message(
    expected_node: &str,
    found_major: Option<u32>,
    found_path: Option<&str>,
    reason: &str,
) -> String {
    format!(
        "{}. HQ could not reinstall it: {reason}. Reinstall HQ Sync, or install Node \
         {MIN_NODE_MAJOR} or newer (https://nodejs.org).",
        managed_node_diagnosis(expected_node, found_major, found_path)
    )
}

/// Construct a Node probe using the same platform rules as the runner.
/// Windows must execute the native `node.exe`; Unix keeps `env node` so
/// nvm/volta/asdf installations remain discoverable through `child_path()`.
fn node_command(args: &[&str]) -> std::process::Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let node = paths::resolve_bin("node");
        paths::spawn_command(&node, args)
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command = std::process::Command::new("/usr/bin/env");
        paths::no_window(&mut command);
        command.arg("node");
        command.args(args);
        command
    };

    cmd.env("PATH", paths::child_path());
    cmd
}

fn node_version_command() -> std::process::Command {
    node_command(&["--version"])
}

/// Execute a runtime preflight with enough breadcrumbs to diagnose GUI PATH
/// drift without exposing the full environment. Paths and version output are
/// safe operational metadata; tokens and command environments are never logged.
enum RunnerProbe {
    Output(std::process::Output),
    SpawnError(std::io::ErrorKind),
}

fn run_runner_probe(label: &str, mut command: std::process::Command) -> RunnerProbe {
    let program = command.get_program().to_string_lossy().to_string();
    match command.output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            log(
                "sync.preflight",
                &format!(
                    "{label}: program={program:?} success={} code={:?} stdout={version:?}",
                    output.status.success(),
                    output.status.code(),
                ),
            );
            RunnerProbe::Output(output)
        }
        Err(error) => {
            log(
                "sync.preflight",
                &format!(
                    "{label}: program={program:?} spawn_error_kind={:?} error={error}",
                    error.kind(),
                ),
            );
            RunnerProbe::SpawnError(error.kind())
        }
    }
}

/// Resolution result for a preflight command. `Indeterminate` is deliberately
/// fail-open: only a conventional command-not-found result proves that the
/// runtime is absent rather than merely unavailable to this probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunnerResolution {
    Resolved,
    Missing,
    Indeterminate,
}

fn runner_probe_resolution(probe: RunnerProbe) -> RunnerResolution {
    match probe {
        RunnerProbe::Output(output) if output.status.success() => RunnerResolution::Resolved,
        RunnerProbe::Output(output) if output.status.code() == Some(127) => {
            RunnerResolution::Missing
        }
        RunnerProbe::SpawnError(std::io::ErrorKind::NotFound) => RunnerResolution::Missing,
        RunnerProbe::Output(_) | RunnerProbe::SpawnError(_) => RunnerResolution::Indeterminate,
    }
}

/// Best-effort Node-version probe: the major version the runner would get, or
/// `None` when no Node answered at all (missing binary, non-zero exit,
/// unparseable output).
///
/// Resolves Node exactly as the runner's `#!/usr/bin/env node` shebang does
/// (`env node` against the same `child_path()` we hand the spawned `npx`), which
/// matters under nvm where that can differ from `resolve_bin("node")`.
fn probe_node_major() -> (Option<u32>, RunnerResolution) {
    match run_runner_probe("node-version", node_version_command()) {
        RunnerProbe::Output(output) if output.status.success() => (
            parse_node_major(&String::from_utf8_lossy(&output.stdout)),
            RunnerResolution::Resolved,
        ),
        probe => (None, runner_probe_resolution(probe)),
    }
}

/// Which Node actually answered. `env node` reports `/usr/bin/env` as the
/// program it ran, so the interpreter's own `execPath` is the only honest way
/// to name the binary in an error message. Run only on the failing path, where
/// one more spawn costs nothing.
fn probe_node_exec_path() -> Option<String> {
    let RunnerProbe::Output(output) =
        run_runner_probe("node-exec-path", node_command(&["-p", "process.execPath"]))
    else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// What the runtime preflight concluded about the Node the runner would run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NodePreflight {
    /// Usable, or not positively diagnosable — the preflight fails OPEN.
    Usable,
    /// HQ's own Node is gone and whatever answered in its place — an older
    /// Node, or nothing at all — can't run the engine. HQ owns both the
    /// breakage and the repair.
    ManagedNodeMissing {
        expected_node: String,
        found_major: Option<u32>,
        found_path: Option<String>,
    },
    /// Neither HQ nor the machine has a Node runtime. HQ ships one, so this
    /// is a provisioning gap that it can repair rather than a terminal
    /// instruction to install Node manually.
    NodeUnprovisioned,
    /// HQ never managed a Node here and the machine's own Node is too old.
    TooOld { major: u32, path: Option<String> },
}

/// Pure classification of a probe result against the managed toolchain's
/// state, extracted so the whole decision table is testable without spawning.
///
/// A modern Node keeps the run going whatever shape the toolchain is in: a
/// missing managed runtime is worth repairing, but never worth blocking a sync
/// that would have worked.
fn classify_node_preflight(
    toolchain: &ManagedToolchain,
    probed_major: Option<u32>,
    probed_path: Option<String>,
    node_resolution: RunnerResolution,
    npx_resolution: RunnerResolution,
) -> NodePreflight {
    if probed_major.is_some_and(|major| !is_node_too_old(major)) {
        return NodePreflight::Usable;
    }

    match toolchain.missing_node() {
        // HQ's Node is gone. Whether PATH offered an older one or nothing at
        // all, the diagnosis and the repair are identical — and "nothing at
        // all" is the *common* shape of this fault, since HQ's Node is the only
        // one on plenty of machines.
        Some(expected_node) => NodePreflight::ManagedNodeMissing {
            expected_node: expected_node.to_string_lossy().into_owned(),
            found_major: probed_major,
            found_path: probed_path,
        },
        None => match probed_major {
            Some(major) => NodePreflight::TooOld {
                major,
                path: probed_path,
            },
            // The only time we provision instead of failing open: HQ has
            // never installed a runtime and `env node` positively found none.
            // A usable Node always returned above, so this cannot shadow a
            // healthy system installation.
            None if node_resolution == RunnerResolution::Missing
                && npx_resolution == RunnerResolution::Missing
                && matches!(toolchain, ManagedToolchain::NotProvisioned) =>
            {
                NodePreflight::NodeUnprovisioned
            }
            // Keep unknown/probe-failure states fail-open. The runner
            // resolution preflight owns the user-facing message for these.
            None => NodePreflight::Usable,
        },
    }
}

/// Probe the runner's Node and classify it against the managed toolchain.
fn preflight_node() -> NodePreflight {
    let (probed_major, node_resolution) = probe_node_major();
    // Only worth a second spawn on the failing path, and only when something
    // actually answered.
    let probed_path = probed_major
        .filter(|major| is_node_too_old(*major))
        .and_then(|_| probe_node_exec_path());
    // Preserve the modern-Node fast path: a working system Node continues
    // without an extra probe or any attempt to provision HQ's runtime.
    let npx_resolution = if probed_major.is_some_and(|major| !is_node_too_old(major)) {
        RunnerResolution::Resolved
    } else {
        probe_npx_resolution()
    };
    classify_node_preflight(
        &hq_desktop_core::toolchain::classify(),
        probed_major,
        probed_path,
        node_resolution,
        npx_resolution,
    )
}

/// Why a preflight refused to start the runner. The daemon uses this to decide
/// whether a bail is worth a central alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreflightFailure {
    /// HQ's own Node runtime vanished — HQ's defect, and repairable by HQ.
    ManagedNodeMissing,
    /// Neither HQ nor the machine has a runtime. HQ can provision this state.
    NodeUnprovisioned,
    /// The machine's Node is below the floor and HQ never managed one here.
    NodeTooOld,
    /// Neither node nor npx resolves at all — a machine setup gap.
    RunnerUnresolvable,
}

/// A refused preflight: the user-facing message plus why it was refused.
pub(crate) struct PreflightBail {
    pub(crate) message: String,
    pub(crate) failure: PreflightFailure,
}

impl NodePreflight {
    fn into_bail(self) -> Option<PreflightBail> {
        match self {
            NodePreflight::Usable => None,
            NodePreflight::ManagedNodeMissing {
                expected_node,
                found_major,
                found_path,
            } => Some(PreflightBail {
                message: managed_node_missing_message(
                    &expected_node,
                    found_major,
                    found_path.as_deref(),
                ),
                failure: PreflightFailure::ManagedNodeMissing,
            }),
            NodePreflight::NodeUnprovisioned => Some(PreflightBail {
                message: node_unprovisioned_message(),
                failure: PreflightFailure::NodeUnprovisioned,
            }),
            NodePreflight::TooOld { major, path } => Some(PreflightBail {
                message: node_too_old_message(major, path.as_deref()),
                failure: PreflightFailure::NodeTooOld,
            }),
        }
    }
}

/// Node-runtime preflight for the daemon. Returns the named condition so the
/// daemon can schedule non-blocking provisioning when HQ has never installed
/// its runtime, or `None` when the runner's Node is fine.
pub(crate) fn preflight_node_bail() -> Option<PreflightBail> {
    preflight_node().into_bail()
}

/// Message when the runner's interpreter (node/npx) isn't resolvable at all —
/// the HQ-SYNC-E exit-127 `sh: hq-sync-runner: command not found` crash-loop.
fn runner_unresolvable_message() -> String {
    "HQ Sync can't start the sync engine — Node.js wasn't found on this computer. \
     Install Node 20 or newer (https://nodejs.org), then reopen HQ Sync."
        .to_string()
}

/// Message for the only no-Node state HQ can repair automatically.
fn node_unprovisioned_message() -> String {
    "HQ Sync is installing its managed Node.js runtime before sync can start. \
     Auto-sync will retry when provisioning finishes."
        .to_string()
}

/// Pure policy for the runner-resolution preflight, extracted so it's
/// unit-testable without spawning: bail with a message unless BOTH node and npx
/// resolve on the child PATH the runner would use.
fn runner_unresolvable_reason(node_resolves: bool, npx_resolves: bool) -> Option<String> {
    if node_resolves && npx_resolves {
        None
    } else {
        Some(runner_unresolvable_message())
    }
}

/// Check whether `npx` resolves on the exact child PATH the runner receives.
/// It is kept separate from the Node version probe because a missing Node
/// version is only a provisioning diagnosis when npx is absent too.
fn probe_npx_resolution() -> RunnerResolution {
    let npx_bin = paths::resolve_bin("npx");
    let mut npx_command = paths::spawn_command(&npx_bin, &["--version"]);
    npx_command.env("PATH", paths::child_path());
    runner_probe_resolution(run_runner_probe("npx-resolution", npx_command))
}

/// Best-effort runner-resolution preflight. Returns `Some(message)` only when
/// the runner's interpreter is *positively* unresolvable (probed and missing);
/// fails OPEN otherwise. `pub(crate)` so the daemon watcher path can reuse it.
pub(crate) fn preflight_runner_unresolvable() -> Option<String> {
    let node_resolves =
        runner_probe_resolution(run_runner_probe("node-resolution", node_version_command()));
    let npx_resolves = probe_npx_resolution();

    let (
        RunnerResolution::Resolved | RunnerResolution::Missing,
        RunnerResolution::Resolved | RunnerResolution::Missing,
    ) = (node_resolves, npx_resolves)
    else {
        return None;
    };

    runner_unresolvable_reason(
        node_resolves == RunnerResolution::Resolved,
        npx_resolves == RunnerResolution::Resolved,
    )
}

/// Outcome of an attempt to provision HQ's managed Node.
///
/// `pub(crate)` because the Connect path (`commands::workspaces`) reuses the
/// same repair rather than adding a second installer: a machine with no Node
/// runtime breaks sync and Connect identically, and HQ ships its own Node, so
/// both lanes should repair before asking the user to install anything.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ToolchainRepair {
    Repaired,
    Failed(String),
    /// Suppressed by the cooldown — a previous attempt was too recent.
    Skipped,
}

static LAST_TOOLCHAIN_REPAIR: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

/// Pure cooldown decision, extracted so it is testable without a clock.
fn repair_is_due(since_last_attempt: Option<Duration>, cooldown: Duration) -> bool {
    since_last_attempt.map_or(true, |elapsed| elapsed >= cooldown)
}

/// Take the repair slot if the cooldown has elapsed, stamping the attempt.
fn claim_repair_slot(cooldown: Duration) -> bool {
    let mut last = LAST_TOOLCHAIN_REPAIR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !repair_is_due(last.map(|at| at.elapsed()), cooldown) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

/// Provision HQ's managed Node.
///
/// This is the same installer onboarding runs: it checksums the download,
/// extracts to a staging directory, verifies the version, and only then
/// activates by atomic replacement — so a failed attempt leaves the machine in
/// the (already broken) state it was in rather than a half-install.
///
/// Generic over the Tauri runtime because the auto-sync watcher reaches this
/// through `start_daemon_with_origin<R>`, while Connect and Sync Now hold a
/// concrete `AppHandle`. Generifying is source-compatible for those callers.
pub(crate) async fn repair_managed_node<R: tauri::Runtime>(app: &AppHandle<R>) -> ToolchainRepair {
    if !claim_repair_slot(TOOLCHAIN_REPAIR_COOLDOWN) {
        log(
            "sync",
            "managed Node provisioning skipped — attempted too recently",
        );
        return ToolchainRepair::Skipped;
    }
    log("sync", "managed Node runtime unavailable — provisioning");
    match crate::commands::install_deps::install_node(app.clone()).await {
        Ok(detail) => {
            log("sync", &format!("managed Node provisioning: {detail}"));
            ToolchainRepair::Repaired
        }
        Err(e) => {
            log("sync", &format!("managed Node provisioning failed: {e}"));
            ToolchainRepair::Failed(e)
        }
    }
}

/// Provision a Node runtime for the daemon without blocking its command path.
/// The shared repair slot prevents the 30-second supervisor cadence from
/// issuing repeated downloads. A successful install must still pass the same
/// preflight the runner will use before the next supervisor cycle can spawn.
pub(crate) async fn provision_unprovisioned_node<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let repair = repair_managed_node(app).await;
    // Only re-probe when something was actually installed: the preflight costs
    // two spawns and cannot have changed for Skipped or Failed.
    let usable_after =
        repair == ToolchainRepair::Repaired && matches!(preflight_node(), NodePreflight::Usable);
    provision_outcome(repair, usable_after)
}

/// Pure mapping from a repair attempt to the daemon-facing outcome, extracted
/// so every arm is unit-testable without an `AppHandle` or a real download.
///
/// Every failure arm must stay actionable *and* must never hand the work back
/// to the user: this whole path exists because HQ can install the runtime
/// itself, so "install Node 20 yourself" is exactly the message it replaces.
fn provision_outcome(repair: ToolchainRepair, usable_after: bool) -> Result<(), String> {
    match repair {
        ToolchainRepair::Repaired if usable_after => Ok(()),
        ToolchainRepair::Repaired => Err(
            "HQ installed its Node runtime, but it still is not usable by the sync engine"
                .to_string(),
        ),
        ToolchainRepair::Skipped => Err(
            "HQ skipped Node provisioning because an attempt was already made recently".to_string(),
        ),
        ToolchainRepair::Failed(reason) => Err(unprovisioned_node_repair_failed_message(&reason)),
    }
}

fn unprovisioned_node_repair_failed_message(reason: &str) -> String {
    format!("HQ tried to install its Node runtime and could not: {reason}")
}

/// Spawn `hq-sync-runner` for all companies or one company as a child process.
///
/// - Only one sync can run at a time (singleton handle).
/// - Emits typed sync events (see `events.rs`) to the Svelte renderer as
///   ndjson lines arrive.
/// - Hard timeout of 1 hour; the sync is cancelled if it exceeds this.
///
/// Returns the handle string on success (always `"hq-sync"`).
#[tauri::command]
pub async fn start_sync(app: AppHandle, company_slug: Option<String>) -> Result<String, String> {
    let scope = parse_sync_scope(company_slug)?;
    log("sync", &format!("scope={scope:?}"));
    log("sync", "start_sync invoked");
    #[cfg(debug_assertions)]
    eprintln!("[sync] start_sync invoked");

    // Atomically check-and-register to prevent concurrent syncs (TOCTOU-safe)
    let Some(sync_generation) = try_register_handle_gen(SYNC_HANDLE) else {
        log("sync", "BAIL: already running");
        #[cfg(debug_assertions)]
        eprintln!("[sync] BAIL: already running");
        return Err("Sync is already running".to_string());
    };

    // Best-effort machineId bootstrap — log on failure but do not abort sync.
    if let Err(e) = ensure_machine_id() {
        log("sync", &format!("ensure_machine_id failed: {e}"));
        eprintln!("ensure_machine_id failed: {e}");
    }

    // Runner preflights (HQ-SYNC-2 / HQ-SYNC-E / HQ-DESKTOP-B3): bail up front
    // with one clear, user-actionable message — surfaced via the command error
    // the popover shows — instead of a doomed spawn (crash-loop). Both fail
    // OPEN. Deregister the handle we just took so a later, fixed-environment
    // sync isn't blocked.
    match preflight_node() {
        NodePreflight::Usable => {}
        NodePreflight::ManagedNodeMissing {
            expected_node,
            found_major,
            found_path,
        } => {
            // Do not accept the downgrade silently: HQ shipped this runtime,
            // so reinstall it and re-probe before deciding anything is wrong
            // with the user's machine.
            log(
                "sync",
                &format!(
                    "managed Node missing at {expected_node} — PATH fell back to {}",
                    match found_major {
                        Some(major) => format!(
                            "v{major} at {}",
                            found_path.as_deref().unwrap_or("an unknown path")
                        ),
                        None => "no Node at all".to_string(),
                    }
                ),
            );
            let repair = repair_managed_node(&app).await;
            let recovered = matches!(repair, ToolchainRepair::Repaired)
                && matches!(preflight_node(), NodePreflight::Usable);
            if !recovered {
                let message = match repair {
                    // The user just clicked Sync Now, so never answer with
                    // "click Sync Now" — say what actually happened.
                    ToolchainRepair::Skipped => managed_node_repair_failed_message(
                        &expected_node,
                        found_major,
                        found_path.as_deref(),
                        "a reinstall was already attempted recently",
                    ),
                    ToolchainRepair::Failed(reason) => managed_node_repair_failed_message(
                        &expected_node,
                        found_major,
                        found_path.as_deref(),
                        &reason,
                    ),
                    ToolchainRepair::Repaired => managed_node_repair_failed_message(
                        &expected_node,
                        found_major,
                        found_path.as_deref(),
                        "the reinstalled runtime still isn't usable",
                    ),
                };
                log("sync", &format!("BAIL: {message}"));
                #[cfg(debug_assertions)]
                eprintln!("[sync] BAIL: managed node missing at {expected_node}");
                let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
                return Err(message);
            }
            log("sync", "managed Node runtime repaired — continuing");
        }
        NodePreflight::NodeUnprovisioned => {
            log(
                "sync",
                "no Node runtime found — provisioning HQ managed Node",
            );
            if let Err(message) = provision_unprovisioned_node(&app).await {
                log("sync", &format!("BAIL: {message}"));
                let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
                return Err(message);
            }
            log("sync", "managed Node runtime provisioned — continuing");
        }
        NodePreflight::TooOld { major, path } => {
            log("sync", &format!("BAIL: node too old (v{major})"));
            #[cfg(debug_assertions)]
            eprintln!("[sync] BAIL: node too old (v{major})");
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(node_too_old_message(major, path.as_deref()));
        }
    }
    if let Some(msg) = preflight_runner_unresolvable() {
        log("sync", &format!("BAIL: runner unresolvable: {msg}"));
        #[cfg(debug_assertions)]
        eprintln!("[sync] BAIL: runner unresolvable: {msg}");
        let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
        return Err(msg);
    }

    // Prewarm runs at launch, but it used to race the first real npx launch
    // while both were writing the same cache tree. Materialize the exact
    // runner package under the shared, bounded lock before starting any sync.
    // A failure here is a positively diagnosed local Node/npm/cache problem:
    // return it to the popover without a Sentry error, rather than spawning a
    // process that often terminates as exit 126/127 and floods alerts.
    match tauri::async_runtime::spawn_blocking(hq_desktop_core::prewarm::materialize_hq_cloud_cache)
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => {
            log("sync", &format!("BAIL: npx cache materialization: {msg}"));
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(msg);
        }
        Err(err) => {
            let msg = format!("HQ Sync could not prepare its npm cache: {err}");
            log(
                "sync",
                &format!("BAIL: npx cache materialization task: {err}"),
            );
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(msg);
        }
    }

    // Resolve HQ folder — deregister on failure so future syncs aren't blocked
    let hq_folder_path = match resolve_hq_folder_path() {
        Ok(p) => {
            log("sync", &format!("hq_folder resolved: {p}"));
            p
        }
        Err(e) => {
            log("sync", &format!("BAIL: resolve_hq_folder_path failed: {e}"));
            #[cfg(debug_assertions)]
            eprintln!("[sync] BAIL: resolve_hq_folder_path failed: {}", e);
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(e);
        }
    };

    // Resolve the personal-sync toggle ONCE for the duration of this sync
    // run — same flag drives (a) whether we run the personal first-push pass
    // and (b) whether `--skip-personal` gets appended to the spawned runner.
    // Defaults to true (preserve pre-5.25 behavior) when get_settings fails,
    // since a stale-prefs read shouldn't accidentally disable a feature the
    // user expects to be on. The setting can be flipped at any time from
    // Settings; next sync picks it up on the next read here.
    let personal_sync_enabled: bool = match crate::commands::settings::get_settings().await {
        Ok(prefs) => prefs.personal_sync_enabled.unwrap_or(true),
        Err(e) => {
            log(
                "sync",
                &format!("get_settings failed; assuming personal_sync_enabled=true: {e}"),
            );
            true
        }
    };
    log(
        "sync",
        &format!("personal_sync_enabled={}", personal_sync_enabled),
    );

    // Resolve vault URL from ~/.hq/config.json
    let vault_api_url = match resolve_vault_api_url() {
        Ok(u) => {
            log("sync", &format!("vault_api_url resolved: {u}"));
            u
        }
        Err(e) => {
            log("sync", &format!("BAIL: resolve_vault_api_url failed: {e}"));
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(e);
        }
    };

    // Fetch (and if needed refresh) the Cognito JWT
    let jwt = match resolve_jwt_classified().await {
        Ok(j) => {
            log("sync", "jwt resolved");
            j
        }
        Err(ResolveJwtError::NeedsReauth) => {
            log(
                "sync",
                "PAUSE: session needs reauth before sync can continue",
            );
            let _ = app.emit(
                EVENT_SYNC_AUTH_ERROR,
                SyncAuthErrorEvent {
                    message: cognito::REAUTH_MESSAGE.to_string(),
                },
            );
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            // Auth-required is a handled terminal state, not a process crash.
            // Returning success keeps the manual path aligned with the
            // runner's exit-0 auth-error contract and avoids red error UI.
            return Ok(SYNC_HANDLE.to_string());
        }
        Err(ResolveJwtError::Other(e)) => {
            log("sync", &format!("BAIL: resolve_jwt failed: {e}"));
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(e);
        }
    };

    // "Preparing sync…" — walk every push-side target, hash each file,
    // compare to journal, and count the ACTUAL number of uploads the
    // runner will perform. The runner only emits `progress` events for
    // transfers (not skips), so this count is the real denominator.
    //
    // Pull-side downloads aren't counted here yet (would need an S3 LIST
    // per bucket). For steady-state syncs the journal already tells the
    // runner there's nothing to download → 0. For first syncs the bucket
    // is empty → 0. Mid-life out-of-band changes may slightly under-count;
    // the UI's honest fallback handles overshoot gracefully.
    {
        let prep_root = std::path::PathBuf::from(&hq_folder_path);
        let (local_companies, _) =
            crate::commands::workspaces::discover_local_companies(&prep_root);
        let slugs: Vec<String> = local_companies
            .iter()
            .map(|e| e.slug.clone())
            .filter(|s| scope.includes(s))
            .collect();
        let prep_start = std::time::Instant::now();
        let to_transfer = crate::commands::personal::count_files_to_transfer(&prep_root, &slugs);
        let elapsed = prep_start.elapsed().as_millis();
        log(
            "sync",
            &format!("preparing: {to_transfer} files to transfer ({elapsed}ms)"),
        );
        let _ = app.emit(
            crate::events::EVENT_SYNC_TOTALS,
            serde_json::json!({ "totalFiles": to_transfer }),
        );
    }

    // Provision any cloud: true companies that haven't been provisioned yet
    log("sync", "phase: provision_missing_companies");
    let vault = VaultClient::new(&vault_api_url, &jwt);
    let companies = match crate::commands::provision::provision_missing_companies(
        &std::path::PathBuf::from(&hq_folder_path),
        &vault,
        &vault_api_url,
    )
    .await
    {
        Ok(c) => {
            log(
                "sync",
                &format!(
                    "provisioned {} new companies: {:?}",
                    c.len(),
                    c.iter().map(|x| &x.slug).collect::<Vec<_>>()
                ),
            );
            c
        }
        Err(e) => {
            log(
                "sync",
                &format!("BAIL: provision_missing_companies failed: {e}"),
            );
            let _ = abandon_process_generation(SYNC_HANDLE, sync_generation);
            return Err(e);
        }
    };
    // Provisioning stays global, but first-push is filtered to this run's scope.
    for company in companies.iter().filter(|c| scope.includes(&c.slug)) {
        if let Err(_e) = app.emit(
            EVENT_SYNC_COMPANY_PROVISIONED,
            SyncCompanyProvisionedEvent {
                company_uid: company.uid.clone(),
                company_slug: company.slug.clone(),
                bucket_name: company.bucket_name.clone(),
            },
        ) {
            log("sync", &format!("failed to emit company-provisioned: {_e}"));
            #[cfg(debug_assertions)]
            eprintln!("[sync] failed to emit company-provisioned: {}", _e);
        }
        // First-push: upload every local file for the newly-provisioned company.
        log("sync", &format!("phase: first_push {}", company.slug));
        if let Err(e) = crate::commands::first_push::first_push_company(
            &app,
            &vault,
            &std::path::PathBuf::from(&hq_folder_path),
            company,
        )
        .await
        {
            log(
                "sync",
                &format!("first_push failed for {}: {e}", company.slug),
            );
            // Terminal failure for this company's first sync — surface it.
            capture_sync_error(
                Some(company.slug.as_str()),
                "(first-push)",
                &format!("first-push failed: {e}"),
            );
            #[cfg(debug_assertions)]
            eprintln!("[sync] first_push failed for {}: {}", company.slug, e);
            let _ = app.emit(
                crate::events::EVENT_SYNC_COMPANY_FIRST_PUSH_FAILED,
                crate::events::SyncCompanyFirstPushFailedEvent {
                    company_uid: company.uid.clone(),
                    company_slug: company.slug.clone(),
                    error: e,
                },
            );
        }
    }

    // Personal first-push: provision + upload personal HQ files via /sts/vend-self.
    // Skipped for company-scoped runs and when the user has flipped off "Sync
    // personal vault". Running it anyway would populate a bucket outside this
    // run's scope, then re-walk the same tree with `--skip-personal`.
    if personal_sync_enabled && scope.is_all() {
        log("sync", "phase: personal first-push");
        if let Err(e) = crate::commands::personal::ensure_personal_bucket_and_first_push(
            &app,
            &vault,
            &std::path::PathBuf::from(&hq_folder_path),
        )
        .await
        {
            log("sync", &format!("personal first-push failed: {e}"));
            #[cfg(debug_assertions)]
            eprintln!("[sync] personal first-push failed: {}", e);
            // NOT captured to Sentry: personal first-push happens before the
            // runner spawns, so it has no stderr breadcrumb context, and the
            // exit-time `report_sync_error` capture below won't fire because we
            // continue past this and let the runner take over. If this path ever
            // becomes a recurring silent failure, add an explicit capture here.
            let _ = app.emit(
                EVENT_SYNC_ERROR,
                SyncErrorEvent {
                    company: None,
                    path: "personal".to_string(),
                    message: format!("personal first-push failed: {e}"),
                },
            );
        }
    } else if !personal_sync_enabled {
        log(
            "sync",
            "phase: personal first-push skipped (personal_sync_enabled=false)",
        );
    } else {
        log(
            "sync",
            "phase: personal first-push skipped (company-scoped run)",
        );
    }

    let spawn_args = build_sync_spawn_args(&hq_folder_path, personal_sync_enabled, &scope);
    log(
        "sync",
        &format!(
            "about to spawn: cmd={} args={:?} hq_root={}",
            spawn_args.cmd, spawn_args.args, hq_folder_path
        ),
    );
    #[cfg(debug_assertions)]
    eprintln!(
        "[sync] about to spawn: cmd={} args={:?} hq_root={}",
        spawn_args.cmd, spawn_args.args, hq_folder_path
    );

    // Timeout watchdog — cancellation is bound to this run's immutable
    // generation, so an old watchdog cannot stop a newer sync that reused the
    // public handle.
    let watchdog_generation = sync_generation;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SYNC_TIMEOUT).await;
        let attempt = cancel_process_for_generation(
            SYNC_HANDLE,
            watchdog_generation,
            SyncCancelCause::TimeoutWatchdog,
            SIGKILL_DELAY,
        );
        if attempt.executed {
            log("sync", "timeout reached, cancelling");
            #[cfg(debug_assertions)]
            eprintln!("[sync] timeout reached, cancelling");
        } else {
            log(
                "sync",
                "timeout reached for stale sync generation; no cancellation sent",
            );
        }
    });

    // Background task: run the subprocess and stream events.
    // run_process_impl is a blocking sync function (mpsc::Receiver iteration +
    // child.wait()), so it must run on a dedicated OS thread via spawn_blocking,
    // not on a tokio worker thread.
    let app_bg = app.clone();
    let hq_folder_for_handler = hq_folder_path.clone();
    let jwt_for_handler = jwt.clone();
    let sync_generation_for_runner = sync_generation;
    // Fresh totals per run — no reset needed between runs.
    let totals: Arc<Mutex<RunTotals>> = Arc::new(Mutex::new(RunTotals::default()));
    let runner_phase: Arc<Mutex<RunnerPhaseContext>> =
        Arc::new(Mutex::new(RunnerPhaseContext::default()));
    let runner_stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(RUNNER_STDERR_TAIL_CAP)));
    let mut runner_stderr_sequence = 0_u32;
    tauri::async_runtime::spawn_blocking(move || {
        log("sync", "bg task: entering run_process_impl");
        #[cfg(debug_assertions)]
        eprintln!("[sync] bg task: entering run_process_impl");
        let result = run_process_impl_for_generation(
            SYNC_HANDLE,
            sync_generation_for_runner,
            &spawn_args,
            |event| match event {
                ProcessEvent::Stdout(line) => {
                    // Always mirror runner stdout to the log file — this is the
                    // ndjson protocol stream and the only durable record of what
                    // the runner did. The eprintln! is dev-only / verbose.
                    log("runner.stdout", &line);
                    #[cfg(debug_assertions)]
                    eprintln!("[sync stdout] {}", line);
                    handle_sync_line(
                        &app_bg,
                        &hq_folder_for_handler,
                        &totals,
                        &runner_phase,
                        &jwt_for_handler,
                        &line,
                    );
                }
                ProcessEvent::Stderr(line) => {
                    // Always log runner stderr — when sync gets stuck this is the
                    // most likely place the cause shows up (npx download retry,
                    // node uncaught exception, runner panic, etc.).
                    log("runner.stderr", &line);
                    // Preserve temporal shape in Sentry without copying untrusted
                    // process output. Raw lines stay local in hq-sync.log; Sentry
                    // receives only a monotonic sequence and fixed error class.
                    runner_stderr_sequence = runner_stderr_sequence.saturating_add(1);
                    sentry::add_breadcrumb(runner_stderr_breadcrumb(runner_stderr_sequence, &line));
                    push_runner_stderr_tail(
                        &mut runner_stderr_tail
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()),
                        line.clone(),
                    );
                    // Re-ingest stderr protocol records. Error events feed the
                    // benign-vs-alertable exit classification, while auth-error
                    // emits the re-authentication signal even though the runner
                    // intentionally exits 0 after a failed token refresh.
                    handle_runner_stderr_line(&app_bg, &totals, &line);
                    #[cfg(debug_assertions)]
                    eprintln!("[sync stderr] {}", line);
                }
                ProcessEvent::Exit {
                    code,
                    signal,
                    success,
                } => {
                    let exit_desc = describe_exit(code, signal);
                    log(
                        "sync",
                        &format!("runner exited: success={} {}", success, exit_desc),
                    );
                    // The runner exits 0 for recoverable conditions (setup-needed,
                    // auth-error) — those surface as ndjson events before exit, so
                    // the frontend already knows. A non-zero exit means the runner
                    // bailed before emitting a useful protocol stream.
                    if !success {
                        let totals_snapshot =
                            totals.lock().unwrap_or_else(|e| e.into_inner()).clone();
                        let cancellation = cancellation_for_runner_exit(sync_generation_for_runner);
                        let disposition = classify_runner_exit_disposition_with_cancellation(
                            code,
                            signal,
                            cancellation.cause,
                            cancellation.termination_effected,
                            totals_snapshot.saw_error,
                            totals_snapshot.saw_alertable_error,
                            totals_snapshot.saw_node_too_old,
                        );
                        let sync_termination_reason =
                            residual_sync_termination_reason(cancellation, &totals_snapshot);
                        let exit_context =
                            manual_runner_exit_context(&scope, &runner_phase, &runner_stderr_tail);
                        let mut effects = ProductionRunnerExitEffects {
                            app: &app_bg,
                            sync_termination_reason,
                        };
                        apply_runner_exit_disposition(
                            &mut effects,
                            disposition,
                            code,
                            signal,
                            &exit_desc,
                            &totals_snapshot,
                            &exit_context,
                        );
                    } else {
                        // Successful exit but no AllComplete observed (e.g.
                        // runner bailed on setup-needed for a brand-new account
                        // with no companies yet). Emit a synthetic AllComplete
                        // so the UI returns to idle and the local sync-state.json
                        // gets stamped with "just now" — otherwise the popover
                        // sits in "syncing" forever and the top SyncStats card
                        // shows "never" while the personal first-push (which DID
                        // run) updated everything else.
                        let (saw_complete, saw_auth_error) = totals
                            .lock()
                            .map(|t| (t.all_complete_seen, t.saw_auth_error))
                            .unwrap_or((false, false));
                        if should_synthesize_all_complete(success, saw_complete, saw_auth_error) {
                            log("sync", "runner exited without AllComplete — synthesizing");
                            let synthetic = SyncEvent::AllComplete(SyncAllCompleteEvent {
                                companies_attempted: 0,
                                files_downloaded: 0,
                                bytes_downloaded: 0,
                                errors: Vec::new(),
                            });
                            let line = serde_json::to_string(&synthetic)
                                .unwrap_or_else(|_| "{}".to_string());
                            handle_sync_line(
                                &app_bg,
                                &hq_folder_for_handler,
                                &totals,
                                &runner_phase,
                                &jwt_for_handler,
                                &line,
                            );
                        }
                    }
                }
            },
        );

        if let Err(e) = result {
            log("sync", &format!("run_process_impl error: {e}"));
            // Only a typed Spawn error means no child existed. Stream/wait
            // errors have already sent ProcessEvent::Exit{code:None}, whose
            // handler owns the single terminal capture.
            let (path, message) = if e.is_spawn() {
                let message = e.to_string();
                capture_sync_error(None, "(spawn)", &message);
                ("(spawn)", message)
            } else {
                // Preserve the existing user-visible error text. The typed
                // path distinguishes the lifecycle stage without rewriting it.
                ("(process)", e.to_string())
            };
            let _ = app_bg.emit(
                EVENT_SYNC_ERROR,
                crate::events::SyncErrorEvent {
                    company: None,
                    path: path.to_string(),
                    message,
                },
            );
        }
    });

    Ok(SYNC_HANDLE.to_string())
}

/// Cancel a running sync.
///
/// Sends SIGTERM to the process group. If the process doesn't exit within 5
/// seconds, SIGKILL is sent.
///
/// Returns `true` if a sync was running and cancellation was initiated.
#[tauri::command]
pub fn cancel_sync() -> bool {
    generation_for_handle(SYNC_HANDLE)
        .map(|generation| {
            cancel_process_for_generation(
                SYNC_HANDLE,
                generation,
                SyncCancelCause::UserStop,
                SIGKILL_DELAY,
            )
            .executed
        })
        .unwrap_or(false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::cognito::CognitoTokens;
    use crate::util::test_support::{scoped_home, ENV_MUTEX};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_vault_api_url_defaults_to_hq_computer() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".hq")).unwrap();

        let _home = scoped_home(tmp.path());
        std::env::remove_var("HQ_VAULT_API_URL");
        let base = resolve_vault_api_url().unwrap();

        assert_eq!(base, "https://hqapi.hq.computer");
    }

    // ── resolve_jwt_impl ─────────────────────────────────────────────────────────

    fn make_tokens(access: &str, refresh: &str, expires_at: i64) -> CognitoTokens {
        CognitoTokens {
            access_token: access.to_string(),
            id_token: None,
            refresh_token: refresh.to_string(),
            expires_at,
        }
    }

    /// The `tokens = refreshed;` reassignment is critical: without it the function
    /// returns the stale access_token even after a successful refresh.
    #[tokio::test]
    async fn test_start_sync_jwt_fetch_uses_refreshed_token() {
        let expired = make_tokens("EXPIRED_ACCESS", "REFRESH_TOKEN", 0); // expires_at=0 → is_expired==true
        let fresh = make_tokens("FRESH_ACCESS", "REFRESH_TOKEN", i64::MAX);

        let result = resolve_jwt_impl(Ok(Some(expired)), |_rt| async move { Ok(fresh) })
            .await
            .unwrap();

        assert_eq!(
            result, "FRESH_ACCESS",
            "resolve_jwt must return the refreshed access_token, not the expired one"
        );
    }

    #[tokio::test]
    async fn test_resolve_jwt_impl_no_refresh_when_not_expired() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let valid = make_tokens("VALID_ACCESS", "REFRESH_TOKEN", now_ms + 600_000);

        let result = resolve_jwt_impl(Ok(Some(valid)), |_rt| async move {
            panic!("refresh_fn must not be called when token is valid")
        })
        .await
        .unwrap();

        assert_eq!(result, "VALID_ACCESS");
    }

    #[tokio::test]
    async fn test_resolve_jwt_impl_none_tokens_returns_err() {
        let result = resolve_jwt_impl(
            Ok(None),
            |_rt| async move { panic!("should not reach refresh") },
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_sync_scope() {
        assert_eq!(parse_sync_scope(None), Ok(SyncRunScope::All));
        assert_eq!(
            parse_sync_scope(Some("indigo".to_string())),
            Ok(SyncRunScope::Company("indigo".to_string()))
        );
        assert_eq!(
            parse_sync_scope(Some("  indigo  ".to_string())),
            Ok(SyncRunScope::Company("indigo".to_string()))
        );
        assert!(parse_sync_scope(Some(String::new())).is_err());
        assert!(parse_sync_scope(Some("personal".to_string())).is_err());
        assert!(parse_sync_scope(Some("Bad_Slug".to_string())).is_err());
    }

    #[test]
    fn test_sync_run_scope_helpers() {
        let all = SyncRunScope::All;
        assert!(all.includes("indigo"));
        assert!(all.includes("other"));
        assert!(all.is_all());

        let company = SyncRunScope::Company("indigo".to_string());
        assert!(company.includes("indigo"));
        assert!(!company.includes("other"));
        assert!(!company.is_all());
    }

    #[test]
    fn test_build_sync_spawn_args_company_scope() {
        let args = build_sync_spawn_args(
            "/Users/test/HQ",
            true,
            &SyncRunScope::Company("indigo".to_string()),
        );
        let company_index = args
            .args
            .iter()
            .position(|arg| arg == "--company")
            .expect("company-scoped args must include `--company`");
        assert_eq!(
            args.args.get(company_index + 1).map(String::as_str),
            Some("indigo")
        );
        assert!(!args.args.iter().any(|arg| arg == "--companies"));
        assert!(args.args.iter().any(|arg| arg == "--skip-personal"));
    }

    #[test]
    fn test_build_sync_spawn_args_cmd() {
        let args = build_sync_spawn_args("/Users/test/HQ", true, &SyncRunScope::All);
        // `resolve_bin` may return an absolute path or a bare name. Windows
        // resolves npm's command shim (`npx.cmd`); Unix resolves `npx`.
        let expected = if cfg!(target_os = "windows") {
            "npx.cmd"
        } else {
            "npx"
        };
        let actual = std::path::Path::new(&args.cmd)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&args.cmd);
        assert!(
            actual.eq_ignore_ascii_case(expected),
            "expected command filename `{expected}`, got `{}`",
            args.cmd
        );
    }

    #[test]
    fn test_build_sync_spawn_args_flags() {
        let args = build_sync_spawn_args("/Users/test/HQ", true, &SyncRunScope::All);
        assert_eq!(
            args.args,
            vec![
                "-y".to_string(),
                format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
                RUNNER_BIN.to_string(),
                "--companies".to_string(),
                "--direction".to_string(),
                "both".to_string(),
                "--on-conflict".to_string(),
                "keep".to_string(),
                "--hq-root".to_string(),
                "/Users/test/HQ".to_string(),
            ]
        );
    }

    /// Personal-sync toggle ON (default) must NOT include `--skip-personal`.
    /// Pinning the negative explicitly so a future regression that toggles
    /// the flag in the wrong direction (e.g. inverted check) surfaces here.
    #[test]
    fn test_build_sync_spawn_args_omits_skip_personal_when_enabled() {
        let args = build_sync_spawn_args("/Users/test/HQ", true, &SyncRunScope::All);
        assert!(
            !args.args.iter().any(|a| a == "--skip-personal"),
            "expected NO `--skip-personal` when personal_sync_enabled=true, got: {:?}",
            args.args
        );
    }

    /// Personal-sync toggle OFF appends `--skip-personal` at the end so the
    /// spawned hq-sync-runner drops the personal slot from its fanout plan
    /// (resolveSkipPersonal in sync-runner.ts treats the flag as truthy via
    /// the parsed-args path, equivalent to HQ_SYNC_SKIP_PERSONAL=1).
    #[test]
    fn test_build_sync_spawn_args_appends_skip_personal_when_disabled() {
        let args = build_sync_spawn_args("/Users/test/HQ", false, &SyncRunScope::All);
        assert_eq!(
            args.args.last().map(String::as_str),
            Some("--skip-personal"),
            "expected `--skip-personal` as last arg when personal_sync_enabled=false, got: {:?}",
            args.args
        );
        // The canonical args must still be present in the same order — the
        // toggle should ONLY append, not reorder or omit anything.
        assert!(args.args.contains(&"--companies".to_string()));
        assert!(args.args.contains(&"--direction".to_string()));
        assert!(args.args.contains(&"both".to_string()));
    }

    #[test]
    fn test_build_sync_spawn_args_sets_skip_companies_env_for_all_scope() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"workspaceSyncEnabled":{"acme":false,"zeta":true}}"#,
        )
        .unwrap();
        let _home = scoped_home(tmp.path());
        let args = build_sync_spawn_args("/Users/test/HQ", true, &SyncRunScope::All);
        let scoped = build_sync_spawn_args(
            "/Users/test/HQ",
            true,
            &SyncRunScope::Company("zeta".into()),
        );

        let env = args.env.expect("env");
        assert_eq!(
            env.get("HQ_SYNC_SKIP_COMPANIES").map(String::as_str),
            Some("acme")
        );
        assert!(
            scoped
                .env
                .as_ref()
                .and_then(|e| e.get("HQ_SYNC_SKIP_COMPANIES"))
                .is_none(),
            "company-scoped runs must not set HQ_SYNC_SKIP_COMPANIES"
        );
    }

    /// Sync Now must use `--on-conflict keep` so a divergent local file
    /// preserves the user's edits instead of aborting the company-wide sync.
    /// Regressing to `abort` would cause a single conflicting file to halt
    /// every other file's progress on the affected company.
    #[test]
    fn test_build_sync_spawn_args_on_conflict_is_keep() {
        let args = build_sync_spawn_args("/tmp", true, &SyncRunScope::All);
        let joined = args.args.join(" ");
        assert!(
            joined.contains("--on-conflict keep"),
            "spawn args must include `--on-conflict keep`: {:?}",
            args.args,
        );
    }

    /// Sync Now is bidirectional — the spawn must opt into `--direction both`.
    /// Guards against a future refactor silently dropping back to pull-only.
    #[test]
    fn test_build_sync_spawn_args_opts_into_direction_both() {
        let args = build_sync_spawn_args("/tmp", true, &SyncRunScope::All);
        let joined = args.args.join(" ");
        assert!(
            joined.contains("--direction both"),
            "spawn args must include `--direction both`: {:?}",
            args.args,
        );
    }

    /// Guards against the regression that broke fresh installs twice: the
    /// runner is ONLY available via this npx invocation. If a future refactor
    /// decides to drop the `--package=` arg, every sync fails with "npm
    /// package `hq-sync-runner` not found". This test makes that failure
    /// obvious in CI, not at runtime on users' machines.
    #[test]
    fn test_build_sync_spawn_args_pins_hq_cloud_package() {
        let args = build_sync_spawn_args("/tmp", true, &SyncRunScope::All);
        let expected_pin = format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION);
        assert!(
            args.args.contains(&expected_pin),
            "spawn args must pin the hq-cloud package (missing `{}`): {:?}",
            expected_pin,
            args.args,
        );
        assert!(
            args.args.contains(&"-y".to_string()),
            "spawn args must include `-y` so npx doesn't block on stdin: {:?}",
            args.args,
        );
        assert!(
            args.args.contains(&RUNNER_BIN.to_string()),
            "spawn args must invoke `{}` after the package pin: {:?}",
            RUNNER_BIN,
            args.args,
        );
    }

    #[test]
    fn test_build_sync_spawn_args_env_sets_hq_root() {
        let args = build_sync_spawn_args("/Users/test/HQ", true, &SyncRunScope::All);
        let env = args.env.unwrap();
        assert_eq!(env.get("HQ_ROOT"), Some(&"/Users/test/HQ".to_string()));
        assert!(
            env.get("PATH").is_some_and(|path| !path.is_empty()),
            "PATH must be present so npx and its node shebang resolve"
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_build_sync_spawn_args_env_sets_path_with_homebrew() {
        let args = build_sync_spawn_args("/tmp", true, &SyncRunScope::All);
        let env = args.env.unwrap();
        let path = env
            .get("PATH")
            .expect("PATH must be set so shebang can find node");
        // Must include homebrew so `#!/usr/bin/env node` resolves on Dock launches.
        assert!(
            path.contains("/opt/homebrew/bin"),
            "PATH missing /opt/homebrew/bin: {}",
            path
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_build_sync_spawn_args_env_sets_windows_path() {
        let args = build_sync_spawn_args(r"C:\HQ", true, &SyncRunScope::All);
        let env = args.env.unwrap();
        let path = env
            .get("PATH")
            .expect("PATH must be set so npx.cmd can find node");
        assert!(
            path.to_ascii_lowercase().contains(r"windows\system32"),
            "PATH missing Windows system32: {path}",
        );
    }

    #[test]
    fn test_build_sync_spawn_args_no_cwd() {
        let args = build_sync_spawn_args("/any/path", true, &SyncRunScope::All);
        assert!(args.cwd.is_none());
    }

    #[test]
    fn test_parse_progress_ndjson() {
        let line = r#"{"type":"progress","company":"indigo","path":"docs/a.md","bytes":42}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::Progress(p) => {
                assert_eq!(p.company, "indigo");
                assert_eq!(p.path, "docs/a.md");
                assert_eq!(p.bytes, 42);
                assert_eq!(p.message, None);
            }
            _ => panic!("Expected Progress event"),
        }
    }

    #[test]
    fn test_parse_setup_needed_ndjson() {
        let line = r#"{"type":"setup-needed"}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        assert_eq!(event, SyncEvent::SetupNeeded);
    }

    #[test]
    fn test_parse_auth_error_ndjson() {
        let line = r#"{"type":"auth-error","message":"Token expired"}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::AuthError(e) => assert_eq!(e.message, "Token expired"),
            _ => panic!("Expected AuthError event"),
        }
    }

    #[test]
    fn stderr_auth_error_raises_needs_reauth_when_runner_exits_zero() {
        let stderr_stream = [
            "runner: refreshing token",
            r#"{"type":"error","level":"auth-error","message":"Token refresh failed"}"#,
        ];
        let exit_code = 0;

        let needs_reauth = stderr_stream
            .iter()
            .find_map(|line| runner_stderr_needs_reauth(line));

        assert_eq!(exit_code, 0);
        assert_eq!(
            needs_reauth,
            Some(SyncAuthErrorEvent {
                message: "Token refresh failed".to_string(),
            })
        );
    }

    #[test]
    fn test_parse_fanout_plan_ndjson() {
        let line = r#"{"type":"fanout-plan","companies":[{"uid":"cmp_1","slug":"indigo"}]}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::FanoutPlan(p) => {
                assert_eq!(p.companies.len(), 1);
                assert_eq!(p.companies[0].slug, "indigo");
            }
            _ => panic!("Expected FanoutPlan event"),
        }
    }

    /// Stage-1 plan event from hq-cloud@5.5.0 runner. Forwarded to the
    /// frontend as `sync:plan` so the menubar can refine the progress
    /// denominator before any per-file events arrive.
    #[test]
    fn test_parse_plan_ndjson() {
        let line = r#"{"type":"plan","company":"indigo","filesToDownload":7,"bytesToDownload":4096,"filesToUpload":2,"bytesToUpload":1024,"filesToSkip":3,"filesToConflict":1}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::Plan(p) => {
                assert_eq!(p.company, "indigo");
                assert_eq!(p.files_to_download, 7);
                assert_eq!(p.bytes_to_download, 4096);
                assert_eq!(p.files_to_upload, 2);
                assert_eq!(p.bytes_to_upload, 1024);
                assert_eq!(p.files_to_skip, 3);
                assert_eq!(p.files_to_conflict, 1);
            }
            _ => panic!("Expected Plan event"),
        }
    }

    /// A pull-only plan (push counts zero) must still parse cleanly.
    /// Mirrors what `sync()` emits in pull-only direction.
    #[test]
    fn test_parse_plan_ndjson_pull_only() {
        let line = r#"{"type":"plan","company":"indigo","filesToDownload":5,"bytesToDownload":2048,"filesToUpload":0,"bytesToUpload":0,"filesToSkip":0,"filesToConflict":0}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::Plan(p) => {
                assert_eq!(p.files_to_download, 5);
                assert_eq!(p.files_to_upload, 0);
            }
            _ => panic!("Expected Plan event"),
        }
    }

    #[test]
    fn test_parse_error_ndjson() {
        let line =
            r#"{"type":"error","company":"indigo","path":"docs/x.md","message":"Access denied"}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::Error(e) => {
                assert_eq!(e.company, Some("indigo".to_string()));
                assert_eq!(e.path, "docs/x.md");
                assert_eq!(e.message, "Access denied");
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn test_parse_complete_ndjson() {
        let line = r#"{"type":"complete","company":"indigo","filesDownloaded":7,"bytesDownloaded":204800,"filesSkipped":1,"conflicts":0,"aborted":false}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::Complete(c) => {
                assert_eq!(c.company, "indigo");
                assert_eq!(c.files_downloaded, 7);
                assert_eq!(c.bytes_downloaded, 204800);
                assert!(!c.aborted);
            }
            _ => panic!("Expected Complete event"),
        }
    }

    #[test]
    fn test_parse_all_complete_ndjson() {
        let line = r#"{"type":"all-complete","companiesAttempted":2,"filesDownloaded":10,"bytesDownloaded":999,"errors":[]}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::AllComplete(a) => {
                assert_eq!(a.companies_attempted, 2);
                assert!(a.errors.is_empty());
            }
            _ => panic!("Expected AllComplete event"),
        }
    }

    #[test]
    fn test_parse_new_files_ndjson() {
        let line = r#"{"type":"new-files","company":"indigo","files":[{"path":"docs/new.md","bytes":1024,"addedBy":"stefan@example.com"},{"path":"docs/other.md","bytes":512}]}"#;
        let event: SyncEvent = serde_json::from_str(line).unwrap();
        match event {
            SyncEvent::NewFiles(nf) => {
                assert_eq!(nf.company, "indigo");
                assert_eq!(nf.files.len(), 2);
                assert_eq!(nf.files[0].path, "docs/new.md");
                assert_eq!(nf.files[0].bytes, 1024);
                assert_eq!(nf.files[0].added_by, Some("stefan@example.com".to_string()));
                assert_eq!(nf.files[1].path, "docs/other.md");
                assert_eq!(nf.files[1].bytes, 512);
                assert_eq!(nf.files[1].added_by, None);
            }
            _ => panic!("Expected NewFiles event"),
        }
    }

    #[test]
    fn test_unknown_event_type_skipped() {
        let line = r#"{"type":"metrics","cpu":50}"#;
        let result: Result<SyncEvent, _> = serde_json::from_str(line);
        assert!(result.is_err(), "Unknown type should fail to parse");
    }

    #[test]
    fn test_malformed_json_skipped() {
        let line = "not json at all";
        let result: Result<SyncEvent, _> = serde_json::from_str(line);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_line_skipped() {
        let line = "";
        let result: Result<SyncEvent, _> = serde_json::from_str(line);
        assert!(result.is_err());
    }

    #[test]
    fn test_sync_handle_constant() {
        assert_eq!(SYNC_HANDLE, "hq-sync");
    }

    #[test]
    fn windows_console_control_disposition_ends_manual_sync_without_sentry_capture() {
        let event = terminal_sync_error_for_windows_console_control();
        assert_eq!(event.company, None);
        assert_eq!(event.path, "(runner)");
        assert_eq!(
            event.message,
            "Sync stopped by Windows. Please try Sync Now again."
        );
    }

    #[test]
    fn app_cancelled_runner_exit_ends_sync_once_without_sentry_capture() {
        let totals = RunTotals::default();
        let mut effects = RecordingRunnerExitEffects::default();
        apply_runner_exit_disposition(
            &mut effects,
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
            Some(1),
            None,
            "with code 1",
            &totals,
            &ManualRunnerExitContext::default(),
        );

        assert!(effects.captures.is_empty());
        assert_eq!(effects.terminal_events.len(), 1);
        assert_eq!(
            effects.terminal_events[0].message,
            "Sync was stopped after reaching the one-hour limit."
        );
        assert!(effects.logs[0].contains("timeout-watchdog"));
    }

    #[test]
    fn residual_termination_reason_preserves_only_safe_causality_classes() {
        let ordinary = RunTotals::default();
        assert_eq!(
            residual_sync_termination_reason(CancellationRecord::default(), &ordinary),
            "uncancelled"
        );
        assert_eq!(
            residual_sync_termination_reason(
                CancellationRecord {
                    cause: Some(SyncCancelCause::UserStop),
                    termination_effected: false,
                },
                &ordinary,
            ),
            "cancel-ineffective"
        );
        let mut alertable = RunTotals::default();
        alertable.saw_alertable_error = true;
        assert_eq!(
            residual_sync_termination_reason(
                CancellationRecord {
                    cause: Some(SyncCancelCause::AppQuit),
                    termination_effected: true,
                },
                &alertable,
            ),
            "cancelled-with-alertable-error"
        );
        assert_eq!(
            residual_sync_termination_reason(
                CancellationRecord {
                    cause: Some(SyncCancelCause::TimeoutWatchdog),
                    termination_effected: true,
                },
                &ordinary,
            ),
            "cancel-status-mismatch",
            "an effective cancellation that remains capture-worthy is not uncancelled"
        );
    }

    #[test]
    fn cancelled_by_app_terminal_message_covers_every_cause() {
        assert_eq!(
            terminal_sync_error_for_cancelled_by_app(SyncCancelCause::TimeoutWatchdog).message,
            "Sync was stopped after reaching the one-hour limit."
        );
        assert_eq!(
            terminal_sync_error_for_cancelled_by_app(SyncCancelCause::UserStop).message,
            "Sync was stopped."
        );
        assert_eq!(
            terminal_sync_error_for_cancelled_by_app(SyncCancelCause::AppQuit).message,
            "Sync was stopped."
        );
        // Only ever published against DAEMON_HANDLE by the daemon watchdog, so a
        // manual sync never actually renders it; the arm keeps the match
        // exhaustive with a plain, content-safe message.
        assert_eq!(
            terminal_sync_error_for_cancelled_by_app(SyncCancelCause::HeartbeatStall).message,
            "Sync was stopped after it stopped responding."
        );
    }

    #[test]
    fn residual_runner_capture_includes_the_safe_termination_reason_tag() {
        let payload = SyncErrorEvent {
            company: None,
            path: "(runner)".to_string(),
            message: "hq-sync-runner exited with code 2".to_string(),
        };
        for reason in [
            "uncancelled",
            "cancel-ineffective",
            "cancelled-with-alertable-error",
            "cancel-status-mismatch",
        ] {
            let captures = sentry::test::with_captured_events(|| {
                capture_runner_exit_error_with_termination_reason(
                    Some(2),
                    None,
                    &RunTotals::default(),
                    &payload,
                    &ManualRunnerExitContext::default(),
                    reason,
                );
            });
            let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
                .expect("runner capture remains sendable");
            assert_eq!(event.tags["sync_termination_reason"], reason);
        }
    }

    #[derive(Default)]
    struct RecordingRunnerExitEffects {
        logs: Vec<String>,
        captures: Vec<SyncErrorEvent>,
        terminal_events: Vec<SyncErrorEvent>,
    }

    impl RunnerExitEffects for RecordingRunnerExitEffects {
        fn log(&mut self, message: &str) {
            self.logs.push(message.to_string());
        }

        fn capture_and_emit_exit(
            &mut self,
            _code: Option<i32>,
            _signal: Option<i32>,
            _totals: &RunTotals,
            payload: SyncErrorEvent,
            _context: &ManualRunnerExitContext,
        ) {
            self.captures.push(payload.clone());
            self.terminal_events.push(payload);
        }

        fn emit_sync_error(&mut self, payload: SyncErrorEvent) {
            self.terminal_events.push(payload);
        }
    }

    fn run_real_transient_retry_runner() -> (RunTotals, (Option<i32>, Option<i32>, bool)) {
        #[cfg(unix)]
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                concat!(
                    "printf '%s\\n' '{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic one\"}' >&2; ",
                    "printf '%s\\n' '{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic two\"}' >&2; ",
                    "printf '%s\\n' '{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic three\"}' >&2; ",
                    "exit 75"
                )
                .to_string(),
            ],
            cwd: None,
            env: None,
        };
        #[cfg(windows)]
        let spawn = SpawnArgs {
            cmd: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                concat!(
                    "[Console]::Error.WriteLine('{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic one\"}'); ",
                    "[Console]::Error.WriteLine('{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic two\"}'); ",
                    "[Console]::Error.WriteLine('{\"type\":\"error\",\"diagnostic\":true,\"path\":\"(runner)\",\"message\":\"diagnostic three\"}'); ",
                    "exit 75"
                )
                .to_string(),
            ],
            cwd: None,
            env: None,
        };
        let totals = Mutex::new(RunTotals::default());
        let mut terminal = None;

        run_process_impl(
            "manual-runner-transient-retry",
            &spawn,
            |event| match event {
                ProcessEvent::Stderr(line) => {
                    assert!(update_runner_stderr_totals(&totals, &line).is_none());
                }
                ProcessEvent::Exit {
                    code,
                    signal,
                    success,
                } => terminal = Some((code, signal, success)),
                ProcessEvent::Stdout(_) => {}
            },
        )
        .expect("real fake runner should run");

        let totals = totals.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let terminal = terminal.expect("real child must emit its terminal event");
        (totals, terminal)
    }

    #[test]
    fn real_child_exit_75_uses_the_no_capture_transient_retry_effect_path() {
        let (totals, (code, signal, success)) = run_real_transient_retry_runner();
        assert_eq!(code, Some(75));
        assert_eq!(signal, None);
        assert!(!success);
        assert!(totals.saw_error);
        assert!(totals.saw_alertable_error);
        assert_eq!(
            totals.runner_error_rollup.tag_value().as_deref(),
            Some("OTHER:3")
        );

        let disposition = classify_runner_exit_disposition(
            code,
            signal,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
        );
        assert_eq!(disposition, RunnerExitDisposition::TransientRetry);

        let mut effects = RecordingRunnerExitEffects::default();
        apply_runner_exit_disposition(
            &mut effects,
            disposition,
            code,
            signal,
            &describe_exit(code, signal),
            &totals,
            &ManualRunnerExitContext::default(),
        );

        assert!(
            effects.captures.is_empty(),
            "exit 75 must not capture to Sentry"
        );
        assert_eq!(effects.terminal_events.len(), 1);
        assert_eq!(effects.terminal_events[0].company, None);
        assert_eq!(effects.terminal_events[0].path, "(runner)");
        assert_eq!(
            effects.terminal_events[0].message,
            TRANSIENT_RETRY_SYNC_ERROR_MESSAGE
        );
        let recorded = format!("{:?}{:?}", effects.logs, effects.terminal_events);
        for runner_supplied in ["diagnostic one", "diagnostic two", "diagnostic three"] {
            assert!(
                !recorded.contains(runner_supplied),
                "transient retry effect must not copy runner content: {runner_supplied}"
            );
        }
    }

    #[test]
    fn manual_runner_exit_capture_is_content_safe_and_keeps_context_and_grouping() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let raw_messages = [
            format!(
                "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
            ),
            format!(
                "EPERM: operation not permitted, rename '{private_path}.hq-tmp-c3d4' -> '{private_path}'"
            ),
        ];
        let stderr_lines: Vec<String> = raw_messages
            .iter()
            .map(|message| {
                serde_json::json!({
                    "type": "error",
                    "company": "personal",
                    "path": private_path,
                    "message": message,
                })
                .to_string()
            })
            .collect();
        let totals = Mutex::new(RunTotals::default());

        let captures = sentry::test::with_captured_events(|| {
            for (index, line) in stderr_lines.iter().enumerate() {
                sentry::add_breadcrumb(runner_stderr_breadcrumb((index + 1) as u32, line));
                assert!(update_runner_stderr_totals(&totals, line).is_none());
            }

            let totals = totals.lock().unwrap_or_else(|e| e.into_inner()).clone();
            assert!(hq_desktop_core::sync_outcome::should_alert_on_nonzero_exit(
                Some(2),
                None,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old,
            ));
            capture_runner_exit_error(
                Some(2),
                None,
                &totals,
                &SyncErrorEvent {
                    company: None,
                    path: "(runner)".to_string(),
                    message: "hq-sync-runner exited with code 2".to_string(),
                },
                &ManualRunnerExitContext::default(),
            );
        });

        assert_eq!(captures.len(), 1);
        let captured = captures.into_iter().next().unwrap();
        assert_eq!(
            captured
                .breadcrumbs
                .values
                .iter()
                .filter_map(|breadcrumb| breadcrumb.message.as_deref())
                .collect::<Vec<_>>(),
            vec![
                "runner stderr #1 (eperm;none)",
                "runner stderr #2 (eperm;none)"
            ]
        );
        let captured_serialized =
            serde_json::to_string(&captured).expect("serialize captured event");
        for forbidden in [
            "secret-plan.md",
            "operation not permitted",
            "hq-tmp",
            "personal",
        ] {
            assert!(!captured_serialized.contains(forbidden));
        }

        let scrubbed = hq_telemetry::before_send(captured).expect("event remains sendable");
        let serialized = serde_json::to_string(&scrubbed).expect("serialize final event");
        assert_eq!(
            scrubbed
                .breadcrumbs
                .values
                .iter()
                .filter_map(|breadcrumb| breadcrumb.message.as_deref())
                .collect::<Vec<_>>(),
            vec![
                "runner stderr #1 (eperm;none)",
                "runner stderr #2 (eperm;none)"
            ]
        );
        assert_eq!(scrubbed.tags["runner_error_rollup"], "EPERM:2");
        assert_eq!(scrubbed.tags["runner_error_ops"], "rename:2");
        assert_eq!(
            scrubbed.extra["runner_error_companies"],
            sentry::protocol::Value::Number(1.into())
        );
        assert_eq!(
            scrubbed.extra["saw_alertable_error"],
            sentry::protocol::Value::Bool(true)
        );
        assert_eq!(
            scrubbed.extra["saw_node_too_old"],
            sentry::protocol::Value::Bool(false)
        );
        assert_eq!(
            scrubbed.extra["saw_fatal_runner_signature"],
            sentry::protocol::Value::Bool(false)
        );
        assert_eq!(
            scrubbed.fingerprint,
            vec!["sync", "runner-termination", "exit:2", "eperm"]
        );
        for forbidden in [
            "secret-plan.md",
            "operation not permitted",
            "hq-tmp",
            "personal",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn exit_two_captures_are_grouped_by_runner_error_class_not_exit_code_alone() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let mut eperm_totals = RunTotals::default();
        eperm_totals.record_error(&SyncErrorEvent {
            company: Some("personal".to_string()),
            path: private_path.to_string(),
            message: format!(
                "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
            ),
        });
        let mut auth_totals = RunTotals::default();
        auth_totals.record_error(&SyncErrorEvent {
            company: Some("health".to_string()),
            path: private_path.to_string(),
            message: "Unauthorized: cognito token rejected".to_string(),
        });
        let no_error_totals = RunTotals::default();
        assert!(hq_desktop_core::sync_outcome::should_alert_on_nonzero_exit(
            Some(2),
            None,
            no_error_totals.saw_error,
            no_error_totals.saw_alertable_error,
            no_error_totals.saw_node_too_old,
        ));
        let payload = SyncErrorEvent {
            company: None,
            path: "(runner)".to_string(),
            message: "hq-sync-runner exited with code 2".to_string(),
        };

        let captures = sentry::test::with_captured_events(|| {
            let context = ManualRunnerExitContext::default();
            capture_runner_exit_error(Some(2), None, &eperm_totals, &payload, &context);
            capture_runner_exit_error(Some(2), None, &auth_totals, &payload, &context);
            capture_runner_exit_error(Some(2), None, &no_error_totals, &payload, &context);
        });

        assert_eq!(captures.len(), 3);
        let fingerprints = captures
            .into_iter()
            .map(|event| event.fingerprint)
            .collect::<Vec<_>>();
        assert_eq!(
            fingerprints,
            vec![
                vec!["sync", "runner-termination", "exit:2", "eperm"],
                vec!["sync", "runner-termination", "exit:2", "auth"],
                vec!["sync", "runner-termination", "exit:2", "none"],
            ]
        );
    }

    #[test]
    fn manual_runner_abort_capture_keeps_only_the_fatal_class() {
        const WINDOWS_STACK_BUFFER_OVERRUN: i32 = 0xC000_0409u32 as i32;
        let private_path = r"C:\\Users\\Ada\\hq\\companies\\personal\\secret-plan.md";
        let raw_stderr = format!(
            "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76: {private_path}"
        );
        let totals = Mutex::new(RunTotals::default());

        let captures = sentry::test::with_captured_events(|| {
            sentry::add_breadcrumb(runner_stderr_breadcrumb(1, &raw_stderr));
            assert!(update_runner_stderr_totals(&totals, &raw_stderr).is_none());
            let totals = totals.lock().unwrap_or_else(|e| e.into_inner()).clone();
            capture_runner_exit_error(
                Some(WINDOWS_STACK_BUFFER_OVERRUN),
                None,
                &totals,
                &SyncErrorEvent {
                    company: None,
                    path: "(runner)".to_string(),
                    message: "hq-sync-runner exited abnormally".to_string(),
                },
                &ManualRunnerExitContext::default(),
            );
        });

        let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
            .expect("manual runner event remains sendable");
        let serialized = serde_json::to_string(&event).expect("serialize event");
        assert_eq!(
            event.breadcrumbs.values[0].message.as_deref(),
            Some("runner stderr #1 (other;libuv_assert)")
        );
        assert_eq!(event.tags["runner_fatal_class"], "libuv_assert");
        assert_eq!(
            event.fingerprint,
            vec![
                "sync",
                "runner-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("UV_HANDLE_CLOSING"));
    }

    #[test]
    fn test_runner_bin_constant() {
        assert_eq!(RUNNER_BIN, "hq-sync-runner");
    }

    #[test]
    fn test_hq_cloud_package_constant() {
        assert_eq!(HQ_CLOUD_PACKAGE, "@indigoai-us/hq-cloud");
    }

    /// Belt-and-braces: fail loudly if someone pastes an unbounded range
    /// into the version const. The canonical shape is `~MAJOR.MINOR.PATCH`
    /// (tilde-prefixed minor floor — auto-applies patches, not minors).
    /// A bare `MAJOR.MINOR.PATCH` is grandfathered in for callers that
    /// genuinely want an exact pin. `latest` / `*` / empty are rejected:
    /// they defeat the deliberate minor-line selection and make first
    /// sync a roulette wheel.
    #[test]
    fn test_hq_cloud_version_is_pinned_semver() {
        assert!(
            !HQ_CLOUD_VERSION.is_empty(),
            "HQ_CLOUD_VERSION must not be empty"
        );
        assert_ne!(
            HQ_CLOUD_VERSION, "latest",
            "HQ_CLOUD_VERSION must select a minor line, not `latest`"
        );
        assert_ne!(
            HQ_CLOUD_VERSION, "*",
            "HQ_CLOUD_VERSION must select a minor line, not `*`"
        );

        // Strip a leading semver-range prefix (`~` for patch-float, `^`
        // for minor-float) before validating the M.m.p shape. Anything
        // else in the prefix slot fails fast.
        let core = match HQ_CLOUD_VERSION.as_bytes().first() {
            Some(b'~') | Some(b'^') => &HQ_CLOUD_VERSION[1..],
            Some(b) if b.is_ascii_digit() => HQ_CLOUD_VERSION,
            _ => panic!(
                "HQ_CLOUD_VERSION must start with `~`, `^`, or a digit — got `{}`",
                HQ_CLOUD_VERSION
            ),
        };

        // Rough semver shape: three dot-separated numeric segments.
        let parts: Vec<&str> = core.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "HQ_CLOUD_VERSION core should look like MAJOR.MINOR.PATCH, got `{}` (full `{}`)",
            core,
            HQ_CLOUD_VERSION
        );
        for part in &parts {
            assert!(
                !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                "HQ_CLOUD_VERSION segment `{}` is not a number — got `{}`",
                part,
                HQ_CLOUD_VERSION
            );
        }
    }

    /// Positive coverage for the tilde-range pattern that ships patch
    /// fixes automatically. If the const ever drifts off this shape,
    /// callers reading `HQ_CLOUD_VERSION` as a "semver range" string
    /// (e.g. the docs, the prewarm log lines) will go stale silently.
    #[test]
    fn test_hq_cloud_version_floats_patch_within_minor() {
        assert!(
            HQ_CLOUD_VERSION.starts_with('~'),
            "HQ_CLOUD_VERSION should be a tilde range so patches auto-apply, \
             got `{}`. Use `~MAJOR.MINOR.0` (e.g. `~5.19.0`). If you genuinely \
             need an exact pin, also update this test.",
            HQ_CLOUD_VERSION
        );
    }

    // ── Runner preflights (HQ-SYNC-2 / HQ-SYNC-E) ────────────────────────

    #[test]
    fn parse_node_major_reads_versions() {
        assert_eq!(parse_node_major("v20.11.1\n"), Some(20));
        assert_eq!(parse_node_major("18.19.0"), Some(18));
        assert_eq!(parse_node_major("v22"), Some(22));
        assert_eq!(parse_node_major(""), None);
        assert_eq!(parse_node_major("not-a-version"), None);
    }

    #[test]
    fn node_floor_is_20_and_message_names_both_majors() {
        assert!(is_node_too_old(18));
        assert!(is_node_too_old(MIN_NODE_MAJOR - 1));
        assert!(!is_node_too_old(MIN_NODE_MAJOR));
        assert!(!is_node_too_old(22));
        let msg = node_too_old_message(18, None);
        assert!(
            msg.contains("Node 20"),
            "message must name the floor: {msg}"
        );
        assert!(
            msg.contains("Node 18"),
            "message must name the current major: {msg}"
        );
    }

    #[test]
    fn node_too_old_message_names_the_binary_that_answered() {
        let msg = node_too_old_message(8, Some("/usr/local/bin/node"));
        assert!(
            msg.contains("/usr/local/bin/node"),
            "message must name which Node was selected: {msg}"
        );
    }

    #[test]
    fn runner_unresolvable_only_when_an_interpreter_is_missing() {
        // Both present → proceed; any missing → one actionable bail message.
        assert!(runner_unresolvable_reason(true, true).is_none());
        assert!(runner_unresolvable_reason(false, true).is_some());
        assert!(runner_unresolvable_reason(true, false).is_some());
        assert!(runner_unresolvable_reason(false, false).is_some());
    }

    #[test]
    fn probe_errors_are_indeterminate_not_missing() {
        assert_eq!(
            runner_probe_resolution(RunnerProbe::SpawnError(std::io::ErrorKind::NotFound)),
            RunnerResolution::Missing
        );
        assert_eq!(
            runner_probe_resolution(RunnerProbe::SpawnError(
                std::io::ErrorKind::PermissionDenied
            )),
            RunnerResolution::Indeterminate
        );
    }

    // ── Managed Node runtime (HQ-DESKTOP-B3) ─────────────────────────────

    fn provisioned_but_empty() -> ManagedToolchain {
        ManagedToolchain::Incomplete {
            expected_node: std::path::PathBuf::from(
                "/Users/x/Library/Application Support/Indigo HQ/toolchain/node/bin/node",
            ),
        }
    }

    #[test]
    fn a_modern_node_is_usable_whatever_the_toolchain_looks_like() {
        // Fail OPEN stays fail OPEN: a missing managed runtime is worth
        // repairing, never worth blocking a sync that would have worked.
        for toolchain in [
            ManagedToolchain::NotProvisioned,
            provisioned_but_empty(),
            ManagedToolchain::Present {
                node: std::path::PathBuf::from("/toolchain/node/bin/node"),
            },
        ] {
            assert_eq!(
                classify_node_preflight(
                    &toolchain,
                    Some(22),
                    None,
                    RunnerResolution::Resolved,
                    RunnerResolution::Resolved,
                ),
                NodePreflight::Usable,
                "{toolchain:?} with Node 22 must proceed"
            );
        }
    }

    #[test]
    fn no_node_anywhere_is_a_repairable_provisioning_gap() {
        // This is the exact previous dead end: there is no managed runtime and
        // neither Node nor npx resolves, so the generic runner message must
        // not send the user to install Node themselves.
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                None,
                None,
                RunnerResolution::Missing,
                RunnerResolution::Missing,
            ),
            NodePreflight::NodeUnprovisioned
        );
    }

    #[test]
    fn npx_without_a_resolvable_node_stays_in_runner_resolution() {
        // Provisioning requires a positive no-node-and-no-npx diagnosis. Do
        // not change the existing ambiguous runner-resolution path.
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                None,
                None,
                RunnerResolution::Missing,
                RunnerResolution::Resolved,
            ),
            NodePreflight::Usable
        );
    }

    #[test]
    fn indeterminate_probe_results_stay_fail_open() {
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                None,
                None,
                RunnerResolution::Indeterminate,
                RunnerResolution::Missing,
            ),
            NodePreflight::Usable
        );
    }

    #[test]
    fn hqs_node_vanishing_is_diagnosed_even_when_nothing_answers() {
        // On a machine where HQ's Node was the *only* Node, its disappearance
        // leaves no fallback to be "too old" — the probe simply gets nothing.
        // Reading that as usable would skip the repair entirely and leave the
        // resolution preflight telling the user to install a Node that HQ was
        // supposed to have provided.
        let preflight = classify_node_preflight(
            &provisioned_but_empty(),
            None,
            None,
            RunnerResolution::Missing,
            RunnerResolution::Missing,
        );
        assert_eq!(
            preflight,
            NodePreflight::ManagedNodeMissing {
                expected_node:
                    "/Users/x/Library/Application Support/Indigo HQ/toolchain/node/bin/node"
                        .to_string(),
                found_major: None,
                found_path: None,
            }
        );
        assert_eq!(
            preflight.clone().into_bail().unwrap().failure,
            PreflightFailure::ManagedNodeMissing
        );

        let NodePreflight::ManagedNodeMissing { expected_node, .. } = preflight else {
            unreachable!()
        };
        let msg = managed_node_missing_message(&expected_node, None, None);
        assert!(
            msg.contains("no other Node"),
            "message must say nothing was there to fall back to: {msg}"
        );
        assert!(
            !msg.contains("Node 0"),
            "must not invent a version nobody reported: {msg}"
        );
    }

    #[test]
    fn an_empty_managed_toolchain_blames_hq_not_the_user() {
        // REGRESSION (B3): the reported machine had an empty managed
        // `node/bin`, so `env node` found a nvm-era v8 and every cycle bailed
        // "Node too old" — pointing the user at nodejs.org while their own
        // Node was v24 and fine.
        let preflight = classify_node_preflight(
            &provisioned_but_empty(),
            Some(8),
            Some("/usr/local/bin/node".to_string()),
            RunnerResolution::Resolved,
            RunnerResolution::Resolved,
        );
        let NodePreflight::ManagedNodeMissing {
            expected_node,
            found_major,
            found_path,
        } = preflight
        else {
            panic!("expected a managed-runtime diagnosis, got {preflight:?}");
        };
        assert_eq!(found_major, Some(8));
        assert_eq!(found_path.as_deref(), Some("/usr/local/bin/node"));

        let msg = managed_node_missing_message(&expected_node, found_major, found_path.as_deref());
        assert!(
            msg.contains("toolchain/node/bin/node"),
            "message must name HQ's own missing runtime: {msg}"
        );
        assert!(
            msg.contains("/usr/local/bin/node"),
            "message must name the Node that answered instead: {msg}"
        );
        assert!(
            !msg.contains("nodejs.org"),
            "the user's Node is fine — do not send them to nodejs.org: {msg}"
        );
    }

    #[test]
    fn an_old_node_without_a_managed_toolchain_is_the_users_to_fix() {
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                Some(8),
                None,
                RunnerResolution::Resolved,
                RunnerResolution::Resolved,
            ),
            NodePreflight::TooOld {
                major: 8,
                path: None
            }
        );
    }

    #[test]
    fn a_failed_repair_says_so_instead_of_promising_another() {
        let msg = managed_node_repair_failed_message(
            "/toolchain/node/bin/node",
            Some(8),
            Some("/usr/local/bin/node"),
            "checksum verification failed",
        );
        assert!(msg.contains("checksum verification failed"), "{msg}");
        assert!(
            !msg.contains("Click Sync Now"),
            "must not loop the user back into a repair that just failed: {msg}"
        );
    }

    #[test]
    fn failed_first_time_provisioning_is_honest_and_not_manual_install_guidance() {
        let msg = unprovisioned_node_repair_failed_message("checksum verification failed");
        assert!(msg.contains("tried to install its Node runtime"), "{msg}");
        assert!(msg.contains("checksum verification failed"), "{msg}");
        assert!(
            !msg.contains("Install Node 20"),
            "a failed HQ install must not shift work back to the user: {msg}"
        );
    }

    #[test]
    fn every_provisioning_outcome_is_distinct_and_never_blames_the_user() {
        assert_eq!(provision_outcome(ToolchainRepair::Repaired, true), Ok(()));

        let installed_but_unusable = provision_outcome(ToolchainRepair::Repaired, false)
            .expect_err("an install that did not take must not report success");
        let skipped = provision_outcome(ToolchainRepair::Skipped, false)
            .expect_err("a cooldown-suppressed attempt is not a success");
        let failed = provision_outcome(ToolchainRepair::Failed("no space left".into()), false)
            .expect_err("a failed install is not a success");

        assert!(
            installed_but_unusable.contains("not usable"),
            "{installed_but_unusable}"
        );
        assert!(skipped.contains("already made recently"), "{skipped}");
        assert!(failed.contains("no space left"), "{failed}");

        // Distinct, so the captured Sentry message says which arm happened.
        assert_ne!(installed_but_unusable, skipped);
        assert_ne!(skipped, failed);
        assert_ne!(installed_but_unusable, failed);

        // This lane exists precisely because HQ can install Node itself.
        for msg in [&installed_but_unusable, &skipped, &failed] {
            assert!(
                !msg.contains("Install Node 20") && !msg.contains("nodejs.org"),
                "a state HQ owns must never send the user to install Node: {msg}"
            );
        }
    }

    #[test]
    fn a_repair_that_did_not_run_is_never_reported_as_provisioned() {
        // `usable_after` is only meaningful for Repaired. Even if a stale probe
        // said the runtime was fine, Skipped/Failed must not resolve to Ok — a
        // watcher spawned on that basis would crash-loop instead of backing off.
        assert!(provision_outcome(ToolchainRepair::Skipped, true).is_err());
        assert!(provision_outcome(ToolchainRepair::Failed("boom".into()), true).is_err());
    }

    #[test]
    fn the_shared_cooldown_bounds_a_machine_that_cannot_install() {
        // The supervisor retries every 30s. Without the shared slot, a machine
        // that can never install (offline, MDM-locked, no disk) would download
        // on a loop. Claiming twice in a row must yield exactly one attempt.
        let cooldown = TOOLCHAIN_REPAIR_COOLDOWN;
        assert!(claim_repair_slot(cooldown), "first attempt takes the slot");
        assert!(
            !claim_repair_slot(cooldown),
            "a second attempt inside the cooldown must not issue another download"
        );
        // Zero cooldown proves the gate is the elapsed time, not a one-shot latch.
        assert!(claim_repair_slot(Duration::from_secs(0)));
    }

    #[test]
    fn each_bail_carries_the_failure_that_decides_whether_to_alert() {
        assert!(NodePreflight::Usable.into_bail().is_none());
        assert_eq!(
            classify_node_preflight(
                &provisioned_but_empty(),
                Some(8),
                None,
                RunnerResolution::Resolved,
                RunnerResolution::Resolved,
            )
            .into_bail()
            .unwrap()
            .failure,
            PreflightFailure::ManagedNodeMissing
        );
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                Some(8),
                None,
                RunnerResolution::Resolved,
                RunnerResolution::Resolved,
            )
            .into_bail()
            .unwrap()
            .failure,
            PreflightFailure::NodeTooOld
        );
        assert_eq!(
            classify_node_preflight(
                &ManagedToolchain::NotProvisioned,
                None,
                None,
                RunnerResolution::Missing,
                RunnerResolution::Missing,
            )
            .into_bail()
            .unwrap()
            .failure,
            PreflightFailure::NodeUnprovisioned
        );
    }

    #[test]
    fn repair_waits_out_its_cooldown() {
        let cooldown = TOOLCHAIN_REPAIR_COOLDOWN;
        assert!(repair_is_due(None, cooldown), "first attempt always runs");
        assert!(repair_is_due(Some(cooldown), cooldown));
        assert!(repair_is_due(Some(cooldown * 2), cooldown));
        assert!(
            !repair_is_due(Some(Duration::from_secs(30)), cooldown),
            "a machine that cannot install must not re-download every sync"
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn node_version_probe_uses_native_windows_node() {
        let command = node_version_command();
        let program = std::path::Path::new(command.get_program())
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        assert_eq!(program.to_ascii_lowercase(), "node.exe");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn node_version_probe_preserves_env_lookup_on_unix() {
        let command = node_version_command();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("/usr/bin/env"));
    }

    #[test]
    fn manual_runner_capture_reports_its_own_route_scope_phase_windows_and_stack_shape() {
        const WINDOWS_STACK_BUFFER_OVERRUN: i32 = 0xC000_0409u32 as i32;
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let hq_folder = TempDir::new().expect("temporary HQ folder");
        let totals = Mutex::new(RunTotals::default());
        let phase = Mutex::new(RunnerPhaseContext::default());
        // Feed the runner's actual stdout seam. Calling the phase helper
        // directly would not prove that handle_sync_line continues to update
        // the manual run's isolated phase context.
        handle_sync_line(
            &handle,
            hq_folder.path().to_str().expect("UTF-8 temporary path"),
            &totals,
            &phase,
            "test-jwt",
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"up"}"#,
        );

        let private_path = r"C:\Users\Ada\hq\companies\private-company\secret-plan.md";
        let stderr_tail = Mutex::new(std::collections::VecDeque::new());
        {
            let mut tail = stderr_tail
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            push_runner_stderr_tail(
                &mut tail,
                format!(
                    "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76: {private_path}"
                ),
            );
            push_runner_stderr_tail(&mut tail, "at node:fs:12:4".to_string());
        }
        let context = manual_runner_exit_context(
            &SyncRunScope::Company("private-company".to_string()),
            &phase,
            &stderr_tail,
        );
        let totals = totals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        let captures = sentry::test::with_captured_events(|| {
            capture_runner_exit_error(
                Some(WINDOWS_STACK_BUFFER_OVERRUN),
                None,
                &totals,
                &SyncErrorEvent {
                    company: None,
                    path: "(runner)".to_string(),
                    message: "hq-sync-runner exited abnormally".to_string(),
                },
                &context,
            );
        });
        let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
            .expect("manual event remains sendable");
        let serialized = serde_json::to_string(&event).expect("serialize event");

        assert_eq!(event.tags["sync_route"], "manual");
        assert_eq!(event.tags["sync_scope"], "single_company");
        assert_eq!(event.tags["runner_phase"], "push");
        assert_eq!(event.tags["windows_exit_status"], "0xC0000409");
        assert_eq!(event.tags["windows_exit_class"], "fault");
        assert_eq!(
            event.tags["windows_fault_symbol"],
            "STATUS_STACK_BUFFER_OVERRUN"
        );
        assert_eq!(event.tags["runner_stack_shape"], "libuv_win_async>node_fs");
        assert_eq!(
            event.extra["runner_phase_elapsed_bucket"],
            sentry::protocol::Value::String("under_1m".to_string())
        );
        assert_eq!(event.extra["runner_stack_depth"], serde_json::json!(2));
        assert_eq!(
            event.fingerprint,
            vec![
                "sync",
                "runner-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
        assert!(!serialized.contains("private-company"));
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("UV_HANDLE_CLOSING"));
    }

    #[test]
    fn manual_runner_phase_context_cannot_bleed_between_runs() {
        let first = Mutex::new(RunnerPhaseContext::default());
        let second = Mutex::new(RunnerPhaseContext::default());
        let push: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"up"}"#,
        )
        .expect("progress event");
        observe_manual_runner_phase(&first, &push);

        let empty_tail = Mutex::new(std::collections::VecDeque::new());
        let first_context = manual_runner_exit_context(&SyncRunScope::All, &first, &empty_tail);
        let second_context = manual_runner_exit_context(&SyncRunScope::All, &second, &empty_tail);
        assert_eq!(first_context.runner_phase, "push");
        assert_eq!(second_context.runner_phase, "unknown");
    }
}
