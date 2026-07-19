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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::SecondsFormat;
use hq_desktop_core::sync_outcome::{
    classify_error_event, describe_exit, should_alert_on_nonzero_exit,
    should_synthesize_all_complete,
};
use tauri::{AppHandle, Emitter};

use crate::commands::cognito;
use crate::commands::config::{ensure_machine_id, HqConfig, MenubarPrefs};
use crate::commands::process::{
    cancel_process_impl, deregister_process, is_registered, run_process_impl, try_register_handle,
    ProcessEvent, SpawnArgs,
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
/// runner's stderr breadcrumbs have already accumulated on the Sentry
/// scope (see `ProcessEvent::Stderr` arm), so the captured event ships
/// with a trail of "what the runner was doing right before it died".
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
    capture_sync_error_impl(company, path, message, None);
}

pub(crate) fn capture_sync_error_with_fingerprint(
    company: Option<&str>,
    path: &str,
    message: &str,
    fingerprint: &[&str],
) {
    capture_sync_error_impl(company, path, message, Some(fingerprint));
}

fn capture_sync_error_impl(
    company: Option<&str>,
    path: &str,
    message: &str,
    fingerprint: Option<&[&str]>,
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
        },
        || {
            sentry::capture_message(&format!("[sync] {message}"), sentry::Level::Error);
        },
    );
}

fn report_sync_error(app: &AppHandle, payload: SyncErrorEvent) -> tauri::Result<()> {
    capture_sync_error(payload.company.as_deref(), &payload.path, &payload.message);
    app.emit(EVENT_SYNC_ERROR, payload)
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
fn handle_sync_line(
    app: &AppHandle,
    hq_folder: &str,
    totals: &Mutex<RunTotals>,
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

/// Forward runner stderr protocol records that affect sync state.
///
/// Error records still feed the exit-alert classifier; auth failures are
/// emitted immediately because the runner deliberately exits 0 after them.
pub(crate) fn handle_runner_stderr_line(app: &AppHandle, totals: &Mutex<RunTotals>, line: &str) {
    if let Some(payload) = runner_stderr_needs_reauth(line) {
        {
            let mut t = totals.lock().unwrap_or_else(|e| e.into_inner());
            t.record_auth_error();
        }
        let _ = app.emit(EVENT_SYNC_AUTH_ERROR, payload);
    } else if let Ok(SyncEvent::Error(payload)) = serde_json::from_str(line.trim()) {
        let mut t = totals.lock().unwrap_or_else(|e| e.into_inner());
        t.record_error(&payload);
    }

    let mut t = totals.lock().unwrap_or_else(|e| e.into_inner());
    t.record_stderr_line(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

// ── Runner preflights (HQ-SYNC-2 / HQ-SYNC-E) ───────────────────────────────
//
// Proactive, best-effort checks run just before spawning the runner so a
// known-doomed spawn is turned into one clear, user-actionable message instead
// of a silent crash (a Node too old to start the runner, or node/npx not
// resolvable at all — which falls through to a bare shell and exits 127,
// crash-looping the watcher). Both are expected *environment* faults, never an
// hq-sync/hq-cloud defect, so they are NOT captured to Sentry. Every probe
// fails OPEN: one we couldn't run (missing binary, non-zero exit, unparseable
// output) returns `None`, so the preflight can only ever prevent a doomed
// spawn, never block a sync that would have worked.

/// Node major-version floor the sync runner requires — its deps use APIs added
/// in Node 20 and it crashes at startup on anything older.
const MIN_NODE_MAJOR: u32 = 20;

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
/// runner — names the floor, their current major, and the single fix.
fn node_too_old_message(current_major: u32) -> String {
    format!(
        "HQ Sync needs Node {MIN_NODE_MAJOR} or newer to sync — this computer is running Node {current_major}. \
         Please update Node (https://nodejs.org), then try Sync again."
    )
}

/// Construct the Node probe using the same platform rules as the runner.
/// Windows must execute the native `node.exe`; Unix keeps `env node` so
/// nvm/volta/asdf installations remain discoverable through `child_path()`.
fn node_version_command() -> std::process::Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let node = paths::resolve_bin("node");
        paths::spawn_command(&node, &["--version"])
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command = std::process::Command::new("/usr/bin/env");
        paths::no_window(&mut command);
        command.args(["node", "--version"]);
        command
    };

    cmd.env("PATH", paths::child_path());
    cmd
}

/// Execute a runtime preflight with enough breadcrumbs to diagnose GUI PATH
/// drift without exposing the full environment. Paths and version output are
/// safe operational metadata; tokens and command environments are never logged.
fn run_runner_probe(
    label: &str,
    mut command: std::process::Command,
) -> Option<std::process::Output> {
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
            Some(output)
        }
        Err(error) => {
            log(
                "sync.preflight",
                &format!(
                    "{label}: program={program:?} spawn_error_kind={:?} error={error}",
                    error.kind(),
                ),
            );
            None
        }
    }
}

/// Best-effort Node-version preflight. Returns `Some(major)` only when the Node
/// the runner would use is *positively* too old, else `None` (fails OPEN).
/// Resolves Node exactly as the runner's `#!/usr/bin/env node` shebang does
/// (`env node` against the same `child_path()` we hand the spawned `npx`), which
/// matters under nvm where that can differ from `resolve_bin("node")`.
fn preflight_node_too_old() -> Option<u32> {
    let output = run_runner_probe("node-version", node_version_command())?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let major = parse_node_major(&stdout)?;
    is_node_too_old(major).then_some(major)
}

/// Message when the runner's interpreter (node/npx) isn't resolvable at all —
/// the HQ-SYNC-E exit-127 `sh: hq-sync-runner: command not found` crash-loop.
fn runner_unresolvable_message() -> String {
    "HQ Sync can't start the sync engine — Node.js wasn't found on this computer. \
     Install Node 20 or newer (https://nodejs.org), then reopen HQ Sync."
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

/// Best-effort runner-resolution preflight. Returns `Some(message)` only when
/// the runner's interpreter is *positively* unresolvable (probed and missing);
/// fails OPEN otherwise. `pub(crate)` so the daemon watcher path can reuse it.
pub(crate) fn preflight_runner_unresolvable() -> Option<String> {
    let node_resolves = run_runner_probe("node-resolution", node_version_command())
        .map(|o| o.status.success())
        .unwrap_or(false);

    let npx_bin = paths::resolve_bin("npx");
    let mut npx_command = paths::spawn_command(&npx_bin, &["--version"]);
    npx_command.env("PATH", paths::child_path());
    let npx_resolves = run_runner_probe("npx-resolution", npx_command)
        .map(|o| o.status.success())
        .unwrap_or(false);

    runner_unresolvable_reason(node_resolves, npx_resolves)
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
    if !try_register_handle(SYNC_HANDLE) {
        log("sync", "BAIL: already running");
        #[cfg(debug_assertions)]
        eprintln!("[sync] BAIL: already running");
        return Err("Sync is already running".to_string());
    }

    // Best-effort machineId bootstrap — log on failure but do not abort sync.
    if let Err(e) = ensure_machine_id() {
        log("sync", &format!("ensure_machine_id failed: {e}"));
        eprintln!("ensure_machine_id failed: {e}");
    }

    // Runner preflights (HQ-SYNC-2 / HQ-SYNC-E): bail up front with one clear,
    // user-actionable message — surfaced via the command error the popover shows
    // — instead of a doomed spawn (crash-loop). Both fail OPEN and are expected
    // environment faults, so they are never captured to Sentry. Deregister the
    // handle we just took so a later, fixed-environment sync isn't blocked.
    if let Some(current_major) = preflight_node_too_old() {
        log("sync", &format!("BAIL: node too old (v{current_major})"));
        #[cfg(debug_assertions)]
        eprintln!("[sync] BAIL: node too old (v{current_major})");
        deregister_process(SYNC_HANDLE);
        return Err(node_too_old_message(current_major));
    }
    if let Some(msg) = preflight_runner_unresolvable() {
        log("sync", &format!("BAIL: runner unresolvable: {msg}"));
        #[cfg(debug_assertions)]
        eprintln!("[sync] BAIL: runner unresolvable: {msg}");
        deregister_process(SYNC_HANDLE);
        return Err(msg);
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
            deregister_process(SYNC_HANDLE);
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
            deregister_process(SYNC_HANDLE);
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
            log("sync", "PAUSE: session needs reauth before sync can continue");
            let _ = app.emit(
                EVENT_SYNC_AUTH_ERROR,
                SyncAuthErrorEvent {
                    message: cognito::REAUTH_MESSAGE.to_string(),
                },
            );
            deregister_process(SYNC_HANDLE);
            // Auth-required is a handled terminal state, not a process crash.
            // Returning success keeps the manual path aligned with the
            // runner's exit-0 auth-error contract and avoids red error UI.
            return Ok(SYNC_HANDLE.to_string());
        }
        Err(ResolveJwtError::Other(e)) => {
            log("sync", &format!("BAIL: resolve_jwt failed: {e}"));
            deregister_process(SYNC_HANDLE);
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
            deregister_process(SYNC_HANDLE);
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

    // Timeout watchdog — cancels sync after SYNC_TIMEOUT
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SYNC_TIMEOUT).await;
        if is_registered(SYNC_HANDLE) {
            log("sync", "timeout reached, cancelling");
            #[cfg(debug_assertions)]
            eprintln!("[sync] timeout reached, cancelling");
            cancel_process_impl(SYNC_HANDLE, SIGKILL_DELAY);
        }
    });

    // Background task: run the subprocess and stream events.
    // run_process_impl is a blocking sync function (mpsc::Receiver iteration +
    // child.wait()), so it must run on a dedicated OS thread via spawn_blocking,
    // not on a tokio worker thread.
    let app_bg = app.clone();
    let hq_folder_for_handler = hq_folder_path.clone();
    let jwt_for_handler = jwt.clone();
    // Fresh totals per run — no reset needed between runs.
    let totals: Arc<Mutex<RunTotals>> = Arc::new(Mutex::new(RunTotals::default()));
    tauri::async_runtime::spawn_blocking(move || {
        log("sync", "bg task: entering run_process_impl");
        #[cfg(debug_assertions)]
        eprintln!("[sync] bg task: entering run_process_impl");
        let result = run_process_impl(SYNC_HANDLE, &spawn_args, |event| match event {
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
                    &jwt_for_handler,
                    &line,
                );
            }
            ProcessEvent::Stderr(line) => {
                // Always log runner stderr — when sync gets stuck this is the
                // most likely place the cause shows up (npx download retry,
                // node uncaught exception, runner panic, etc.).
                log("runner.stderr", &line);
                // Catch-all error pipeline: every runner stderr line becomes
                // a Sentry breadcrumb attached to the current scope. If the
                // runner exits non-zero, the `report_sync_error` capture at
                // the exit site below will publish a single Sentry event with
                // these breadcrumbs as the trail of "what the runner was
                // doing right before it died". This is the design intent —
                // breadcrumbs accumulate noise for free, exit-time capture
                // converts that into a single alertable issue with context.
                //
                // PROTOCOL NOTE (2026-04-25): the runner originally emitted
                // structured per-file error events on STDOUT as ndjson; the
                // planned protocol change (@indigoai-us/hq-cloud PR #34) moved
                // all error-class events to STDERR so each becomes a breadcrumb
                // here automatically.
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    category: Some("runner.stderr".into()),
                    level: sentry::Level::Warning,
                    message: Some(line.clone()),
                    ..Default::default()
                });
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
                    // Not every non-zero exit is an actionable defect. The
                    // runner exits 2 whenever ANY error event was emitted mid-
                    // fanout — including the vault's correct 404 for a not-yet-
                    // provisioned company, transient network resets the next
                    // cycle recovers from, and expected per-file ACL-scope skips
                    // (403 SCOPE_EXCEEDS_PARENT) — and exit 17 when another sync
                    // already holds the lock. Those flooded this Sentry issue
                    // with un-actionable noise. Consult the run's error
                    // classification (accumulated from `error` events on EITHER
                    // channel — stdout via `handle_sync_line`, stderr via the
                    // arm above) and only capture a genuine defect. Every error
                    // event + stderr breadcrumb was already surfaced to the UI
                    // and the local sync log, so suppression loses no
                    // diagnostics — only the Sentry alert.
                    let (saw_error, saw_alertable, saw_node_too_old) = totals
                        .lock()
                        .map(|t| (t.saw_error, t.saw_alertable_error, t.saw_node_too_old))
                        .unwrap_or((false, false, false));
                    if should_alert_on_nonzero_exit(
                        code,
                        signal,
                        saw_error,
                        saw_alertable,
                        saw_node_too_old,
                    ) {
                        let _ = report_sync_error(
                            &app_bg,
                            crate::events::SyncErrorEvent {
                                company: None,
                                path: "(runner)".to_string(),
                                message: format!("hq-sync-runner exited {}", exit_desc),
                            },
                        );
                    } else if saw_node_too_old {
                        log(
                            "sync",
                            &format!(
                                "runner exited non-zero ({}) due to Node too old — surfacing update-Node message, not alerting",
                                exit_desc
                            ),
                        );
                        let _ = app_bg.emit(
                            EVENT_SYNC_ERROR,
                            crate::events::SyncErrorEvent {
                                company: None,
                                path: "(node)".to_string(),
                                message: format!(
                                    "HQ Sync needs Node {MIN_NODE_MAJOR} or newer to sync. \
                                     Please update Node (https://nodejs.org), then try Sync again."
                                ),
                            },
                        );
                    } else {
                        log(
                            "sync",
                            &format!(
                                "runner exited non-zero ({}) but fully explained by benign/transient conditions \
                                 (locked / not-provisioned / network reset) — not alerting",
                                exit_desc
                            ),
                        );
                    }
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
                        let line =
                            serde_json::to_string(&synthetic).unwrap_or_else(|_| "{}".to_string());
                        handle_sync_line(
                            &app_bg,
                            &hq_folder_for_handler,
                            &totals,
                            &jwt_for_handler,
                            &line,
                        );
                    }
                }
            }
        });

        if let Err(e) = result {
            log("sync", &format!("run_process_impl error: {e}"));
            // Spawn failures happen before the runner produces any
            // stderr/stdout, so there are no breadcrumbs to attach — capture an
            // explicit event (e.g. `npx` failing to resolve
            // `@indigoai-us/hq-cloud@<ver>`, a broken toolchain). Otherwise the
            // user clicks Sync Now, nothing happens, and nothing reaches
            // #hq-alerts.
            capture_sync_error(None, "(spawn)", &e);
            let _ = app_bg.emit(
                EVENT_SYNC_ERROR,
                crate::events::SyncErrorEvent {
                    company: None,
                    path: "(spawn)".to_string(),
                    message: e,
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
    cancel_process_impl(SYNC_HANDLE, SIGKILL_DELAY)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::cognito::CognitoTokens;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn resolve_vault_api_url_defaults_to_hq_computer() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".hq")).unwrap();

        std::env::remove_var("HQ_VAULT_API_URL");
        std::env::set_var("HOME", tmp.path());
        let base = resolve_vault_api_url().unwrap();
        std::env::remove_var("HOME");

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
        assert_eq!(env.len(), 2);
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
        let msg = node_too_old_message(18);
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
    fn runner_unresolvable_only_when_an_interpreter_is_missing() {
        // Both present → proceed; any missing → one actionable bail message.
        assert!(runner_unresolvable_reason(true, true).is_none());
        assert!(runner_unresolvable_reason(false, true).is_some());
        assert!(runner_unresolvable_reason(true, false).is_some());
        assert!(runner_unresolvable_reason(false, false).is_some());
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
}
