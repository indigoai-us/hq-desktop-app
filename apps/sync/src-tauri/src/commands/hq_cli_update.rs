//! "Update available" check for the `@indigoai-us/hq-cli` npm package.
//!
//! Mirrors `updater.rs` (which handles the menubar app itself) but targets
//! the user's globally-installed `hq` CLI. The two are decoupled releases:
//! the menubar pins a runner range via `util::hq_resolver::HQ_CLI_NPM_RANGE`
//! and self-heals via `npx` when the local `hq` falls below the floor, but
//! we still want to nag the user to upgrade their installed CLI so the
//! npx-fallback hot path isn't permanent.
//!
//! Flow:
//!   1. Resolve `hq` via `util::paths::resolve_bin`. If we get the bare
//!      name "hq" back, the user doesn't have it installed — `local` is
//!      None and we emit nothing (no nag for "you don't have it").
//!   2. Read the installed version by *anchoring to the resolved `hq`
//!      binary* — canonicalize it and walk up to the enclosing
//!      `@indigoai-us/hq-cli/package.json`. This is independent of which
//!      npm prefix the app resolved, which is the fix for the prefix-
//!      mismatch bug where a CLI installed under a different prefix than
//!      the app's `npm root -g` read back as "not installed" and silently
//!      suppressed the banner. Falls back to `npm root -g` then
//!      `hq --version` so an installed CLI never yields silent None.
//!   3. GET https://registry.npmjs.org/@indigoai-us/hq-cli/latest and
//!      pull the `version` field.
//!   4. Compare numerically. If latest > local, emit
//!      `hq-cli-update:available` with both versions. When `autoUpdate`
//!      is on (default), the background checker also installs it directly.
//!
//! A background task fires the check 4 minutes after launch (staggered
//! against the other launch-time checkers so they don't spike CPU and network
//! in lockstep), then every 6h. The result is also exposed as the
//! `check_hq_cli_update` Tauri command for on-demand polls.
//!
//! **Version floor.** Before that stagger the task runs a network-free probe
//! of the installed CLI's version. If it reads below
//! `hq_desktop_core::hq_cli_update::HQ_CLI_MIN_VERSION` — the same floor
//! hq-core's `30-ensure-hq-cli.sh` hook enforces on every prompt — the check
//! and install run immediately, and (like that hook, which has no opt-out)
//! the install ignores the `autoUpdate` toggle. Only a *readable* old version
//! triggers this: a missing or unreadable CLI keeps the scheduled cadence.
//!
//! The `install_hq_cli_update` command runs the upgrade directly by
//! spawning `npm install -g --prefix <resolved-hq-prefix>
//! @indigoai-us/hq-cli@latest` when `hq` resolves to `<prefix>/bin/hq`,
//! with the same beefed-up PATH used elsewhere for child processes
//! (`paths::child_path`). That keeps install, detection, and execution
//! anchored to the same prefix instead of letting npm's default prefix write
//! a second, shadowed copy. A `hq` that is NOT in a `bin/` directory (pnpm's
//! flat global dir, a hand-rolled wrapper) yields no prefix at all, so npm
//! uses its own — see `npm_prefix_from_hq_bin` for why inventing one there
//! wedged the updater in a permanent reinstall loop.
//!
//! A zero exit from npm is not accepted as success on its own. The version of
//! the binary the app will EXECUTE (`resolved_hq_version`, never the
//! `npm root -g` fallback) must have reached the target that was pinned before
//! the install ran. An install that completes without moving it is recorded in
//! `menubar.json`, skipped by the background loop until a newer version
//! publishes, and returned as a marked error the UI shows verbatim — the
//! copy-the-command remedy is wrong for that case, since that command is what
//! just failed to take.
//!
//! On success it re-checks and emits a fresh `hq-cli-update:cleared` event; on
//! failure it returns stderr so the UI can fall back to the manual
//! copy-the-command flow (typical failure: EACCES against a system-prefix npm
//! that needs sudo).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::install_deps::MANAGED_NODE_ABI;
use crate::commands::sync::ToolchainRepair;
use crate::util::logfile::log;
use crate::util::paths;

use hq_desktop_core::cli_update_lock::{
    acquire_cli_update_lock, CliUpdateLockAttempt, CliUpdateLockGuard,
};
use hq_desktop_core::toolchain::{classify_runtime, ManagedRuntime};

#[allow(unused_imports)]
pub use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, auto_install_allowed, auto_update_enabled,
    classify_install_failure, cli_below_floor, cli_below_floor_of, launch_cli_check,
    launch_cli_check_with_floor, LaunchCliCheck, HQ_CLI_MIN_VERSION,
    bun_home_from_hq_bin, bun_install_argv, classify_install_failure_with_environment,
    classify_install_failure_with_final_attempt,
    cli_auto_update_enabled, cli_install_needed, cmp_semver,
    decide_post_install, dismissed_cli_version, get_local_version, get_local_version_diagnostics,
    hq_cli_version_under_pnpm_root, hq_version_string, install_argv, install_converged,
    install_failure_detail, install_failure_detail_with_environment,
    install_failure_detail_with_final_attempt, install_failure_report,
    install_executor_for_first_install, install_executor_for_hq_bin,
    installed_hq_cli_version_in_bun_global,
    installed_hq_cli_version_in_pnpm_store, installed_hq_cli_version_in_prefix,
    is_cli_update_dismissed, is_missing_global_install_target, is_npm_bin_collision,
    is_pnpm_global_shim,
    is_prefix_permission_failure, is_windows_locked_binary_failure, legacy_marker_needs_recovery,
    non_convergent_cli_contract, non_convergent_cli_version, non_convergent_detail,
    non_convergent_episode_blocked, non_convergent_episode_key, non_convergent_episode_record,
    managed_retry_start_decision, non_convergent_episode_reported, npm_install_attempt_summary,
    npm_lifecycle_cause,
    colocated_npm_path, delivered_prefix_shim_for, executed_copy_aim_for, user_prefix_aim_decision,
    DeliveredPrefixShim, ExecutedCopyAim, UserPrefixAim,
    npm_prefix_from_hq_bin, partial_install_scope_from_npm_path, path_contains_dir, pnpm_child_path,
    pnpm_global_env,
    pnpm_global_ls_hq_cli_version, pnpm_install_argv, pnpm_store_family,
    read_installed_version, redact_home, redact_home_in, report_install_failure,
    report_install_failure_episode, report_install_failure_with_environment,
    report_install_failure_with_final_attempt, report_non_convergent_install,
    report_non_convergent_marker_unpersisted, report_npm_cache_setup_failure,
    report_unreadable_version, repair_managed_shadow, resolved_hq_version, should_auto_install,
    should_report_unreadable_version, suppress_for_dismissal, unattributed_install_stderr_origin,
    version_from_hq_binary,
    version_if_hq_cli, AsyncSingleFlight, HqCliUpdateInfo, InstallEnvironment, InstallExecutor,
    RequestedSpecKind,
    InstallFailureEpisode, InstallFailureKind, InterpreterRecovery, LocalVersionProbeDiagnostics,
    LocalVersionProbeResult, ManagedRepairDisposition, ManagedRetryOutcome, ManagedRetryStart,
    ManagedShadowRepairAction, ManagedShadowRepairOutcome, MissingTargetState,
    NonConvergenceKind, NonConvergentReport, NpmLatest,
    NpmToolchainSource, PnpmGlobalEnv, PnpmHomeSource, PnpmRunDiagnostics, PnpmStoreFamily,
    PostInstallContext, PostInstallCoreEffects, PostInstallOutcome, VersionProbeOutcome,
    DISMISSED_VERSION_KEY, HQ_CLI_PACKAGE, NON_CONVERGENT_CONTRACT_KEY,
    NON_CONVERGENT_ERROR_PREFIX, NON_CONVERGENT_VERSION_KEY, PINNED_MARKER_CONTRACT,
    STDERR_ORIGIN_NON_NPM,
};

/// npm registry endpoint that returns the dist-tag `latest` manifest. Cheap,
/// cached by the registry CDN, and returns a tiny JSON document.
const REGISTRY_URL: &str = "https://registry.npmjs.org/@indigoai-us/hq-cli/latest";

/// HTTP request timeout — keep tight so a flaky network doesn't stall the
/// background loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Offset from app launch before the first check fires. 15s vs. the app
/// updater's 10s so they don't spike CPU + network in lockstep on launch.
// Staggered against version_gate (90s), packages (8m), hq_core_state (12m).
const INITIAL_DELAY: Duration = Duration::from_secs(4 * 60);

/// Re-check cadence. Matches `updater::setup_update_checker` (6h).
const CHECK_INTERVAL: Duration = Duration::from_secs(21600);

/// One-shot backoff before retrying an install that failed because the Windows
/// `hq` binary was locked/in use (EPERM, HQ-DESKTOP-3N). The lock is usually
/// momentary — an antivirus scan finishing or another `hq` process exiting — so
/// a single short, bounded wait lets it clear before the lone retry. Bounded and
/// non-looping by design (one sleep, one retry).
const LOCKED_BINARY_RETRY_BACKOFF: Duration = Duration::from_secs(3);

async fn fetch_latest() -> Result<String, String> {
    // npm registry doesn't require a User-Agent but accepts one for telemetry —
    // we still want consistent client attribution across our outbound HTTP, so
    // we layer the timeout on top of the standard client-attribution headers.
    let client = reqwest::Client::builder()
        .default_headers(crate::util::client_info::client_headers())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("build client: {e}"))?;
    let resp = client
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("GET {REGISTRY_URL}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("registry returned HTTP {}", resp.status()));
    }
    let parsed: NpmLatest = resp
        .json()
        .await
        .map_err(|e| format!("parse registry JSON: {e}"))?;
    Ok(parsed.version)
}

/// Perform one check. Returns `Some(info)` when the machine needs `latest`
/// installed — an upgrade over a readable older version, or **no CLI installed
/// at all** — and `None` when the user is already current.
///
/// The no-CLI case is the one this used to drop on the floor: a user who has
/// never installed the CLI reported "no update available" forever, even though
/// the app is the natural place to put it on the machine. `info.local` is
/// `None` for it.
///
/// A binary that is present but whose version cannot be read is NOT included.
/// It may be our own install left broken by an interrupted global install, or
/// an unrelated program named `hq`, and nothing available here distinguishes
/// them; `should_report_unreadable_version` below reports it for triage instead.
pub async fn check_once(app: &AppHandle) -> Result<Option<HqCliUpdateInfo>, String> {
    let latest = fetch_latest().await?;
    let mut local_version = get_local_version_diagnostics();
    // A resolved CLI whose version no probe could read may just be missing its
    // Node interpreter. When HQ's managed Node is not provisioned, ask the
    // existing provisioner for one and re-probe — bounded to one provision and
    // one re-probe — before deciding anything or reporting.
    if should_report_unreadable_version(&local_version) {
        local_version = recover_unreadable_version_once(app, local_version).await;
    }
    let local = local_version.local.clone();
    // Now also true when NO `hq` is installed at all. Previously the
    // unreadable-version arm was unconditionally false, so a user with no CLI
    // reported "no update available" and the background installer below never
    // ran for them. `hq_installed` keeps a present-but-unreadable binary out of
    // it — see `cli_install_needed`.
    let update_available =
        cli_install_needed(local.as_deref(), &latest, local_version.hq_installed);
    log(
        "hq-cli-update",
        &format!(
            "check: local={:?} latest={} update_available={}",
            local, latest, update_available
        ),
    );
    // Triage signal: the CLI is on PATH but no probe could read its version.
    // This is the silent-failure class that hid a stale CLI behind a missing
    // banner — surface it so we can see how often detection degrades in the
    // field (vs. the benign "user simply has no CLI" case, which stays quiet).
    if should_report_unreadable_version(&local_version) {
        report_unreadable_version(&latest, &local_version.probes);
    }
    if !update_available {
        return Ok(None);
    }
    let info = HqCliUpdateInfo { local, latest };
    // Surface the live banner only when the user hasn't dismissed this version.
    // The emit drives the in-popover notice; suppressing it (not the return
    // value) keeps the notice non-nagging while leaving the background
    // auto-install path — which acts on the returned `Some` — untouched.
    if is_cli_update_dismissed(&info.latest) {
        log(
            "hq-cli-update",
            &format!(
                "update {} available but dismissed by user — suppressing banner",
                info.latest
            ),
        );
    } else {
        let _ = app.emit("hq-cli-update:available", &info);
    }
    Ok(Some(info))
}

/// Tauri command — synchronous one-shot check used by the tray
/// "Check for Updates" menu item, the popover on-focus refresh, and the
/// Settings panel.
///
/// Unlike the raw `check_once` (whose `Some` still drives the background
/// auto-installer), this filters out a dismissed version so the popover's
/// on-focus refresh clears/keeps-hidden the banner until a newer version is
/// published — the user-facing half of the non-nagging contract.
#[tauri::command]
pub async fn check_hq_cli_update(app: AppHandle) -> Result<Option<HqCliUpdateInfo>, String> {
    let result = check_once(&app).await?;
    Ok(result.filter(|info| !is_cli_update_dismissed(&info.latest)))
}

/// Fast, network-free identity probe for Settings/title surfaces.
///
/// `check_hq_cli_update` intentionally returns `None` both when the CLI is
/// current and when it is missing, so it cannot power an always-visible
/// version row by itself. Keep identity separate from update availability,
/// exactly like the desktop app and HQ Core rows.
#[tauri::command]
pub async fn get_hq_cli_version() -> Option<String> {
    match tokio::task::spawn_blocking(get_local_version).await {
        Ok(version) => version,
        Err(error) => {
            log(
                "hq-cli-update",
                &format!("installed-version probe task failed: {error}"),
            );
            None
        }
    }
}

/// Tauri command — record that the user dismissed the "CLI update available"
/// notice for `version`. Persists `cliUpdateDismissedVersion` through the
/// untyped-merge path (so it survives `save_settings`, which only writes typed
/// `MenubarPrefs` fields). The notice stays hidden for this version and any
/// older one, and re-appears once a strictly-newer `latest` is published — see
/// `is_cli_update_dismissed`.
#[tauri::command]
pub fn set_hq_cli_update_dismissed(version: String) -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    log(
        "hq-cli-update",
        &format!("user dismissed CLI-update notice for v{version}"),
    );
    crate::commands::first_run::merge_menubar_flags(
        &path,
        &[(DISMISSED_VERSION_KEY, Value::String(version))],
    )
}

/// Tauri command — runs `npm install -g @indigoai-us/hq-cli@latest` in a
/// blocking task using the same child PATH as the runner (so node-shebanged
/// npm and its own subprocess lookups succeed under the launchd-minimal
/// PATH a Dock-launched menubar app inherits). On success we re-check and
/// emit `hq-cli-update:cleared` so the frontend banner can disappear without
/// waiting for the 6h background loop.
///
/// Failure mode is deliberate: we surface the npm stderr verbatim to the
/// caller. The most common one — `EACCES: permission denied, mkdir
/// '/usr/local/lib/node_modules/@indigoai-us'` — means the user's npm
/// prefix needs sudo. The UI falls back to the previous copy-the-command
/// path for that case rather than prompting for a password.
/// Extract the most useful text from an npm run — stderr if present, else stdout.
fn npm_output_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// An EEXIST bin collision: an existing `<prefix>/bin/hq` that npm did not
/// create blocks the bin-link, so npm bails rather than clobber it. npm's own
/// documented remedy is a `--force` retry (HQ-SYNC-B).
fn is_bin_exists_failure(detail: &str, prefix: Option<&str>) -> bool {
    is_npm_bin_collision(detail, prefix)
}

/// An `ENOTEMPTY` partial/interrupted-install failure. npm updates a package by
/// renaming the existing package dir aside to a `.<name>-<rand>` staging dir;
/// when a prior install was interrupted it leaves a partial `hq-cli` package dir
/// (and/or an orphan `.hq-cli-*` staging dir) under
/// `<prefix>/lib/node_modules/@indigoai-us`, so that rename fails
/// `ENOTEMPTY: directory not empty`. Unlike the `EEXIST` bin collision, `--force`
/// does NOT clear this — the leftover partial state must be removed first (see
/// `clean_partial_hq_cli_install`). Left unhandled, every 6-hourly auto-update
/// wedges on the same error and the user's `hq` stays broken (ENOENT) until a
/// human runs `hq-heal` (field report feedback_44061f91).
fn is_partial_install_failure(detail: &str) -> bool {
    detail.contains("ENOTEMPTY")
}

/// The npm global scope dir that holds the `@indigoai-us/hq-cli` package for a
/// given prefix. Unix uses `<prefix>/lib/node_modules`; Windows uses
/// `<prefix>\node_modules`. Partial-install debris — the `hq-cli` package dir
/// and its `.hq-cli-*` temp staging dirs — lives directly under the resulting
/// `@indigoai-us` dir. Factored out so cleanup stays strictly scoped and both
/// path shapes are unit-testable without touching the filesystem.
fn partial_install_scope_dir_for(prefix: &str, windows_layout: bool) -> PathBuf {
    let root = Path::new(prefix);
    let node_modules = if windows_layout {
        root.join("node_modules")
    } else {
        root.join("lib").join("node_modules")
    };
    node_modules.join("@indigoai-us")
}

fn partial_install_scope_dir(prefix: &str) -> PathBuf {
    partial_install_scope_dir_for(prefix, cfg!(target_os = "windows"))
}

/// Remove partial `@indigoai-us/hq-cli` install debris left by an interrupted
/// npm install so a fresh `npm install -g` can lay the package down cleanly.
/// Scoped strictly to `<prefix>/lib/node_modules/@indigoai-us`: deletes the
/// `hq-cli` package dir and any `.hq-cli-*` temp staging dir, and touches
/// nothing else — sibling packages under the scope, and everything outside it,
/// are left intact. Best-effort: every removal is logged, but a failure does not
/// abort the caller's retry, since the subsequent install surfaces the real
/// error. Mirrors the manual remedy `hq-heal` applies (back up the partial
/// state, then reinstall).
fn clean_partial_hq_cli_install(prefix: &str) {
    clean_partial_hq_cli_install_scope(&partial_install_scope_dir(prefix));
}

/// Remove partial `hq-cli` install debris from an already-derived
/// `@indigoai-us` scope directory. Split out of [`clean_partial_hq_cli_install`]
/// so BOTH scope sources — the resolved install prefix and, when no prefix
/// resolved, the absolute path npm itself named
/// ([`partial_install_scope_from_npm_path`]) — share ONE deletion routine with
/// one blast radius. The deletion set is exactly as before: the `hq-cli` child
/// directory and any `.hq-cli-*` child directory, and nothing else — never the
/// scope directory itself, never a sibling package.
fn clean_partial_hq_cli_install_scope(scope: &Path) {
    let pkg = scope.join("hq-cli");
    if pkg.exists() {
        match std::fs::remove_dir_all(&pkg) {
            Ok(()) => log(
                "hq-cli-update",
                &format!("cleaned partial package dir {}", pkg.display()),
            ),
            Err(e) => log(
                "hq-cli-update",
                &format!(
                    "failed to remove partial package dir {}: {e}",
                    pkg.display()
                ),
            ),
        }
    }

    // Sweep orphan `.hq-cli-*` staging dirs npm left behind mid-rename. Reading
    // the scope dir may fail (e.g. it doesn't exist yet) — that's fine, there is
    // simply nothing to sweep.
    let Ok(entries) = std::fs::read_dir(scope) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(".hq-cli-") {
            let staging = entry.path();
            match std::fs::remove_dir_all(&staging) {
                Ok(()) => log(
                    "hq-cli-update",
                    &format!("cleaned temp staging dir {}", staging.display()),
                ),
                Err(e) => log(
                    "hq-cli-update",
                    &format!(
                        "failed to remove temp staging dir {}: {e}",
                        staging.display()
                    ),
                ),
            }
        }
    }
}

/// Resolve the `@indigoai-us` install-scope directory to CREATE for an ENOENT
/// missing-global-install-target failure (HQ-DESKTOP-5K), with the retry rung label
/// alongside it. Prefer the resolved install prefix
/// ([`partial_install_scope_dir_for`], both layouts selectable so the split is
/// testable off-platform); when none resolved — the same prefix-less state as the
/// ENOTEMPTY recovery — recover the scope from the ABSOLUTE path npm itself named
/// ([`partial_install_scope_from_npm_path`]), which fail-closes to `None` on any
/// ambiguity (a relative path, a missing marker, an `@indigoai-usx`-style near-miss).
/// Pure — no filesystem access — so scope resolution is unit-testable exactly like
/// the ENOTEMPTY recovery's.
fn missing_install_target_scope(
    prefix: Option<&str>,
    detail: &str,
    windows_layout: bool,
) -> Option<(PathBuf, &'static str)> {
    prefix
        .map(|target_prefix| {
            (
                partial_install_scope_dir_for(target_prefix, windows_layout),
                "mkdir-plain",
            )
        })
        .or_else(|| {
            partial_install_scope_from_npm_path(detail)
                .map(|scope| (PathBuf::from(scope), "mkdir-plain-npm-path"))
        })
}

/// Pure mapping from the install scope's ancestor existence to the diagnostic
/// [`MissingTargetState`], so it is unit-testable without touching the filesystem.
/// A present `scope` means nothing in the probed chain was actually missing (npm's
/// failing `mkdir` targeted a deeper path), which the create+retry records as
/// `CreatedAndRetried`; otherwise it names the deepest missing ancestor.
fn missing_target_state_from_existence(
    scope_exists: bool,
    node_modules_exists: bool,
    root_exists: bool,
) -> MissingTargetState {
    if scope_exists {
        MissingTargetState::CreatedAndRetried
    } else if node_modules_exists {
        MissingTargetState::ScopeMissing
    } else if root_exists {
        MissingTargetState::NodeModulesMissing
    } else {
        MissingTargetState::PrefixRootMissing
    }
}

/// Probe the derived install scope's ancestor chain, then `create_dir_all` the
/// scope and every absent ancestor. Returns the closed-enumeration state naming
/// which ancestor was missing, or [`MissingTargetState::CreateFailed`] when the
/// directory itself could not be created (an unreachable or permission-denied
/// parent — a dead mapped drive, an offline redirected UNC path). CREATION-ONLY: it
/// never deletes, so its blast radius is strictly smaller than the ENOTEMPTY
/// cleanup. The caller retries the plain install once on any state except
/// `CreateFailed`.
fn create_missing_install_scope(scope: &Path) -> MissingTargetState {
    let node_modules = scope.parent();
    let root = node_modules.and_then(Path::parent);
    let probed = missing_target_state_from_existence(
        scope.exists(),
        node_modules.is_some_and(|dir| dir.exists()),
        root.is_some_and(|dir| dir.exists()),
    );
    match std::fs::create_dir_all(scope) {
        Ok(()) => probed,
        Err(e) => {
            log(
                "hq-cli-update",
                &format!(
                    "failed to create missing install scope {}: {e}",
                    scope.display()
                ),
            );
            MissingTargetState::CreateFailed
        }
    }
}

/// Spawn `npm <args>` on the blocking pool with the beefed-up child PATH and
/// collect its Output. Errors map to a String (join / spawn failures only —
/// a non-zero npm exit is a successful run that returns a failing status).
async fn run_npm_install(
    npm: &str,
    path: &str,
    npm_cache: &Path,
    args: Vec<String>,
) -> Result<std::process::Output, String> {
    let npm = npm.to_string();
    let path = path.to_string();
    let npm_cache = npm_cache.to_path_buf();
    log(
        "hq-cli-update",
        &format!("install: spawning {} {}", npm, args.join(" ")),
    );
    tauri::async_runtime::spawn_blocking(move || {
        npm_install_command(&npm, &path, &npm_cache, &args).output()
    })
    .await
    .map_err(|e| format!("join blocking task: {e}"))?
    .map_err(|e| format!("spawn npm: {e}"))
}

const MAX_NPM_INSTALL_ATTEMPTS: usize = 4;

#[derive(Debug)]
struct NpmInstallAttempt {
    rung: &'static str,
    forced: bool,
    summary: String,
}

#[derive(Debug)]
struct NpmInstallRun {
    output: std::process::Output,
    final_attempt_forced: bool,
    /// The ordered rung labels of the attempts the ladder actually ran (`plain`,
    /// `cleanup-plain`, `cleanup-plain-npm-path`, …). Carried so the ladder tests
    /// can assert WHICH recovery path a run took — the prefix-derived
    /// `cleanup-plain` vs. the npm-path-derived `cleanup-plain-npm-path` — from
    /// the run itself, not just the on-disk side effects.
    #[allow(dead_code)]
    rungs: Vec<&'static str>,
    /// For a missing-global-install-target failure (HQ-DESKTOP-5K), which ancestor
    /// of the install scope the mkdir remedy found missing and how its creation
    /// went. Carried out to the caller so it can attach the closed-enumeration
    /// diagnostic to the reported event. [`MissingTargetState::Unknown`] whenever the
    /// remedy did not run.
    missing_target_state: MissingTargetState,
}

async fn run_recorded_npm_install_attempt(
    npm: &str,
    path: &str,
    npm_cache: &Path,
    prefix: Option<&str>,
    args: Vec<String>,
    rung: &'static str,
    forced: bool,
    ledger: &mut Vec<NpmInstallAttempt>,
) -> Result<std::process::Output, String> {
    let output = run_npm_install(npm, path, npm_cache, args).await?;
    let detail = npm_output_detail(&output);
    ledger.push(NpmInstallAttempt {
        rung,
        forced,
        summary: npm_install_attempt_summary(output.status.code(), &detail, prefix),
    });
    Ok(output)
}

fn log_npm_install_attempt_ledger(ledger: &[NpmInstallAttempt]) {
    let entries = ledger
        .iter()
        .map(|attempt| {
            format!(
                "rung={} forced={} {}",
                attempt.rung, attempt.forced, attempt.summary
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    log(
        "hq-cli-update",
        &format!("install attempt ledger (path-free): [{entries}]"),
    );
}

/// Build the npm child with the exact PATH and app-owned cache the updater
/// needs. Keeping this at the process boundary means every retry inherits the
/// same cache instead of falling back to a potentially root-owned `~/.npm`.
fn npm_install_command(
    npm: &str,
    path: &str,
    npm_cache: &Path,
    args: &[String],
) -> std::process::Command {
    let mut cmd = paths::spawn_command(npm, &[]);
    cmd.args(args)
        .env("PATH", path)
        .env("NPM_CONFIG_CACHE", npm_cache);
    cmd
}

/// Create the stable cache directory owned by this app rather than inheriting
/// npm's user-global cache. This deliberately never repairs, deletes, or
/// changes ownership of the user's existing npm cache.
fn prepare_app_npm_cache(app_cache_dir: PathBuf) -> Result<PathBuf, String> {
    let npm_cache = app_cache_dir.join("npm");
    std::fs::create_dir_all(&npm_cache).map_err(|e| format!("prepare app-owned npm cache: {e}"))?;
    Ok(npm_cache)
}

fn app_npm_cache(app: &AppHandle) -> Result<PathBuf, (&'static str, String)> {
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| ("resolve", format!("resolve app cache directory: {e}")))?;
    prepare_app_npm_cache(app_cache_dir).map_err(|e| ("create", e))
}

async fn run_npm_install_with_retries(
    npm: &str,
    path: &str,
    npm_cache: &Path,
    prefix: Option<&str>,
    base_args: Vec<String>,
) -> Result<NpmInstallRun, String> {
    let mut ledger = Vec::with_capacity(MAX_NPM_INSTALL_ATTEMPTS);
    // Set by the mkdir remedy below (HQ-DESKTOP-5K) and carried out to the caller so
    // it can tag the reported event. `Unknown` whenever that remedy did not run.
    let mut missing_target_state = MissingTargetState::Unknown;

    // First attempt: a plain (non-forced) global install.
    let mut output = run_recorded_npm_install_attempt(
        npm,
        path,
        npm_cache,
        prefix,
        base_args.clone(),
        "plain",
        false,
        &mut ledger,
    )
    .await?;

    // EEXIST bin collision: an existing `<prefix>/bin/hq` npm didn't create
    // blocks the bin-link, so npm bails rather than clobber it. Retry ONCE with
    // --force to overwrite the stale CLI the user is updating (HQ-SYNC-B) —
    // npm's own documented remedy. Only this specific failure arms the forced
    // retry; every other failure falls straight through to the error below.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_bin_exists_failure(&detail, prefix) && ledger.len() < MAX_NPM_INSTALL_ATTEMPTS {
            log(
                "hq-cli-update",
                &format!("install hit EEXIST bin collision; retrying with --force: {detail}"),
            );
            let mut forced = base_args.clone();
            forced.push("--force".to_string());
            output = run_recorded_npm_install_attempt(
                npm,
                path,
                npm_cache,
                prefix,
                forced,
                "forced-bin-collision",
                true,
                &mut ledger,
            )
            .await?;
        }
    }

    // ENOTEMPTY partial-install recovery: a prior interrupted install left a
    // partial `@indigoai-us/hq-cli` package dir (and/or a `.hq-cli-*` temp
    // staging dir) under `<prefix>/lib/node_modules/@indigoai-us`, so npm's
    // rename-aside step fails ENOTEMPTY and every auto-update wedges on it,
    // leaving `hq` broken (ENOENT) until a human runs hq-heal (feedback_44061f91).
    // `--force` does not clear this, so clean the leftover partial state (scoped
    // strictly to that dir) and retry the plain install ONCE — the same remedy
    // hq-heal applies by hand. The cleanup scope comes from the resolved prefix
    // when there is one; when no prefix resolved (HQ-DESKTOP-5B, npm_prefix_known
    // false in 61/61 events) it is recovered from the absolute `@indigoai-us`
    // path npm itself named, which fail-closes to None on any ambiguity so we
    // never delete outside the app's own scope. Only when neither yields a scope
    // is the failure left untouched.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_partial_install_failure(&detail) {
            // Resolve the cleanup scope. Prefer the resolved install prefix; when
            // no prefix resolved — the HQ-DESKTOP-5B state, where `hq` is bare or
            // non-npm-shaped so `hq_cli_install_prefix` returned None (true in
            // 61/61 recorded events) — fall back to the absolute `@indigoai-us`
            // scope npm itself named in its ENOTEMPTY error. That fallback
            // fail-closes to None on any ambiguity, so a path we do not recognise
            // performs no deletion and the failure is reported exactly as today.
            let cleanup_scope = prefix
                .map(|cleanup_prefix| (partial_install_scope_dir(cleanup_prefix), "cleanup-plain"))
                .or_else(|| {
                    partial_install_scope_from_npm_path(&detail)
                        .map(|scope| (PathBuf::from(scope), "cleanup-plain-npm-path"))
                });
            if let Some((scope, rung)) = cleanup_scope {
                log(
                    "hq-cli-update",
                    &format!(
                        "install hit ENOTEMPTY partial install; cleaning {} and retrying: {detail}",
                        scope.display()
                    ),
                );
                clean_partial_hq_cli_install_scope(&scope);
                output = run_recorded_npm_install_attempt(
                    npm,
                    path,
                    npm_cache,
                    prefix,
                    base_args.clone(),
                    rung,
                    false,
                    &mut ledger,
                )
                .await?;

                // Cleanup changes the on-disk package state. If its plain
                // retry exposes the same structured bin collision, the npm
                // remedy is newly armed once more. This is intentionally
                // distinct from the Windows backoff rung below: a later
                // EEXIST after EPERM remains loud because force did not
                // directly produce that final output.
                if !output.status.success()
                    && is_bin_exists_failure(&npm_output_detail(&output), prefix)
                    && ledger.len() < MAX_NPM_INSTALL_ATTEMPTS
                {
                    let mut forced = base_args.clone();
                    forced.push("--force".to_string());
                    output = run_recorded_npm_install_attempt(
                        npm,
                        path,
                        npm_cache,
                        prefix,
                        forced,
                        "cleanup-forced-bin-collision",
                        true,
                        &mut ledger,
                    )
                    .await?;
                }
            } else {
                log(
                    "hq-cli-update",
                    "install hit ENOTEMPTY but no resolved prefix or npm-reported scope; skipping cleanup retry",
                );
            }
        }
    }

    // ENOENT missing-global-install-target recovery (HQ-DESKTOP-5K): on a machine
    // whose npm global prefix directory chain does not exist, npm's own `mkdir` of
    // the install target fails ENOENT and every 6-hourly auto-update dies before it
    // can lay the package down, so the user's `hq` silently never updates. This is
    // the mirror image of the ENOTEMPTY cleanup above, but CREATION-ONLY: derive the
    // same `@indigoai-us` scope dir (from the resolved prefix when known, else the
    // absolute path npm itself named — fail-closed to None on any ambiguity),
    // `create_dir_all` it plus every absent ancestor, and retry the plain install
    // ONCE. It never deletes, so its blast radius is strictly smaller than the
    // ENOTEMPTY cleanup. When neither source yields a scope, or the creation itself
    // fails, nothing changes and the failure is reported exactly as today.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_missing_global_install_target(&detail, prefix) {
            if let Some((scope, rung)) =
                missing_install_target_scope(prefix, &detail, cfg!(target_os = "windows"))
            {
                // Probe + create OFF the async runtime: on an offline UNC prefix, a
                // dead mapped drive, or a redirected network profile these metadata
                // calls plus `create_dir_all` can block on an OS network timeout, so
                // keep the Tokio worker free (the surrounding npm work already runs on
                // the blocking pool). A join failure fails closed to `CreateFailed`.
                let scope_for_create = scope.clone();
                let state = tauri::async_runtime::spawn_blocking(move || {
                    create_missing_install_scope(&scope_for_create)
                })
                .await
                .unwrap_or(MissingTargetState::CreateFailed);
                missing_target_state = state;
                if state == MissingTargetState::CreateFailed {
                    log(
                        "hq-cli-update",
                        &format!(
                            "install hit ENOENT missing global install target but creating {} failed; skipping retry: {detail}",
                            scope.display()
                        ),
                    );
                } else if ledger.len() < MAX_NPM_INSTALL_ATTEMPTS {
                    log(
                        "hq-cli-update",
                        &format!(
                            "install hit ENOENT missing global install target; created {} and retrying: {detail}",
                            scope.display()
                        ),
                    );
                    output = run_recorded_npm_install_attempt(
                        npm,
                        path,
                        npm_cache,
                        prefix,
                        base_args.clone(),
                        rung,
                        false,
                        &mut ledger,
                    )
                    .await?;

                    // Creating the scope lets npm advance to bin-linking; on a machine
                    // that had BOTH a missing scope AND a pre-existing stale `hq` shim,
                    // that step can now fail EEXIST. The earlier `--force` rung already
                    // ran, so re-arm npm's supported collision remedy once here —
                    // mirroring the ENOTEMPTY cleanup rung above — still within the hard
                    // attempt cap.
                    if !output.status.success()
                        && is_bin_exists_failure(&npm_output_detail(&output), prefix)
                        && ledger.len() < MAX_NPM_INSTALL_ATTEMPTS
                    {
                        let mut forced = base_args.clone();
                        forced.push("--force".to_string());
                        output = run_recorded_npm_install_attempt(
                            npm,
                            path,
                            npm_cache,
                            prefix,
                            forced,
                            "mkdir-forced-bin-collision",
                            true,
                            &mut ledger,
                        )
                        .await?;
                    }
                }
            } else {
                log(
                    "hq-cli-update",
                    "install hit ENOENT missing global install target but no resolved prefix or npm-reported scope; skipping mkdir retry",
                );
            }
        }
    }

    // Windows EPERM locked-binary recovery (HQ-DESKTOP-3N): npm could not
    // replace the `hq` executable because it was locked or in use — a running
    // hq/terminal process, or antivirus holding the file. This is almost always
    // transient (the lock releases once the scan finishes or the other process
    // exits), so wait a short, bounded moment and retry the plain install ONCE.
    // A still-failing retry is classified as an expected local condition below
    // (no Sentry page) and surfaces the copy-the-command UI fallback. Only this
    // specific failure arms the backoff retry; everything else falls straight
    // through to the error handler.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_windows_locked_binary_failure(output.status.code(), &detail)
            && ledger.len() < MAX_NPM_INSTALL_ATTEMPTS
        {
            log(
                "hq-cli-update",
                &format!(
                    "install hit Windows EPERM locked-binary; retrying once after backoff: {detail}"
                ),
            );
            tokio::time::sleep(LOCKED_BINARY_RETRY_BACKOFF).await;
            output = run_recorded_npm_install_attempt(
                npm,
                path,
                npm_cache,
                prefix,
                base_args,
                "windows-backoff-plain",
                false,
                &mut ledger,
            )
            .await?;
        }
    }

    log_npm_install_attempt_ledger(&ledger);
    let final_attempt_forced = ledger.last().is_some_and(|attempt| attempt.forced);
    let rungs = ledger.iter().map(|attempt| attempt.rung).collect();
    Ok(NpmInstallRun {
        output,
        final_attempt_forced,
        rungs,
        missing_target_state,
    })
}

/// Hard cap on a single node/npm provenance probe. Bounded and non-looping.
const TOOL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// menubar.json key holding the machine's set of already-reported install-failure
/// episode keys, so an identical lifecycle failure stops re-paging Sentry on
/// every scheduled check. A set (not a single key) because this dependency
/// closure has more than one native module that can fail.
const INSTALL_FAILURE_EPISODE_KEYS: &str = "cliInstallFailureEpisodeKeys";

/// menubar.json key holding the machine's set of already-reported NON-BLOCKING
/// non-convergence episode keys (resolution shortfalls). Distinct from the durable
/// blocking marker `cliUpdateNonConvergentVersion`: this set only bounds Sentry
/// captures — it never stops auto-install — so a persistent environment shape (the
/// pnpm >=11 field layout that keeps failing to deliver) reports once per new
/// `latest` instead of on every check and every app restart.
const NON_CONVERGENT_EPISODE_KEYS: &str = "cliNonConvergentEpisodeKeys";

/// Run one bounded provenance probe (`node --version`, `node -p
/// process.versions.modules`, `npm --version`) and return its trimmed stdout, or
/// `None` on any failure or timeout. Runs through tokio's async child with
/// `kill_on_drop`, so a hung probe (e.g. a broken node/npm wrapper) is actually
/// terminated when `TOOL_PROBE_TIMEOUT` fires instead of leaking a stuck process
/// and a blocking-pool thread.
async fn probe_tool_line(bin: String, path: String, args: Vec<String>) -> Option<String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = paths::tokio_spawn_command(&bin, &arg_refs);
    cmd.env("PATH", &path).kill_on_drop(true);
    let output = tokio::time::timeout(TOOL_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()? // timed out -> future dropped -> child killed
        .ok()?; // spawn / exec error
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// Whether the resolved npm sits inside the app's managed toolchain. A path
/// comparison only; the reported value is the closed enum, never a path.
fn npm_toolchain_source(npm: &str) -> NpmToolchainSource {
    if npm == "npm" {
        return NpmToolchainSource::Unknown;
    }
    let npm_path = Path::new(npm);
    if paths::managed_toolchain_roots()
        .iter()
        .any(|root| npm_path.starts_with(root))
    {
        NpmToolchainSource::Managed
    } else {
        NpmToolchainSource::UserPath
    }
}

/// Best-effort toolchain provenance for a failed install — the Node/npm
/// versions, the Node ABI, and whether npm ran under the managed toolchain. This
/// is the evidence HQ-DESKTOP-4R / HQ-DESKTOP-4S never carried. Bounded and
/// non-blocking; a probe that fails leaves its field `None` (tagged `unknown`).
async fn probe_install_environment(
    npm: &str,
    path: &str,
    managed_toolchain_retry: bool,
) -> InstallEnvironment {
    // Probe the Node the failing install's PATH selects -- the same Node its
    // lifecycle children (`prebuild-install`, `node-gyp`) ran under -- by
    // invoking a bare `node` through that PATH, not an absolute
    // `resolve_bin("node")`. The two can differ (e.g. nvm ordered ahead of
    // `~/.npm-global`/system in `child_path()` vs. resolve_bin's order), and the
    // Node ABI is the exact provenance this change exists to diagnose.
    let node_version = probe_tool_line(
        "node".to_string(),
        path.to_string(),
        vec!["--version".to_string()],
    )
    .await;
    let node_abi = probe_tool_line(
        "node".to_string(),
        path.to_string(),
        vec!["-p".to_string(), "process.versions.modules".to_string()],
    )
    .await;
    let npm_version = probe_tool_line(
        npm.to_string(),
        path.to_string(),
        vec!["--version".to_string()],
    )
    .await;
    InstallEnvironment {
        node_version,
        node_abi,
        npm_version,
        toolchain_source: npm_toolchain_source(npm),
        managed_toolchain_retry,
        // A probe with `managed_toolchain_retry` set is, by construction, a retry
        // that RAN under HQ's managed toolchain, so it carries `Ran`. A user-path
        // probe starts `NotArmed`; the caller overrides it with the declined branch
        // when a self-heal was armed but did not run.
        managed_retry_outcome: if managed_toolchain_retry {
            ManagedRetryOutcome::Ran
        } else {
            ManagedRetryOutcome::NotArmed
        },
        // Defaults to `Unknown`; `install_hq_cli` overrides it with the mkdir
        // remedy's diagnostic (HQ-DESKTOP-5K) when that remedy ran.
        missing_target_state: MissingTargetState::Unknown,
        target_version: None,
        requested_spec_kind: RequestedSpecKind::Unknown,
    }
}

/// Read the machine's set of already-reported install-failure episode keys from
/// menubar.json, or an empty set if absent/unreadable. An unreadable marker
/// yields an empty set, which makes the repeat-guard fail closed (report) -- the
/// same fail-closed contract as the non-convergent marker.
fn install_failure_episode_markers() -> Vec<String> {
    let Ok(path) = paths::menubar_json_path() else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return Vec::new();
    };
    value
        .get(INSTALL_FAILURE_EPISODE_KEYS)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Persist the updated reported-key set so every already-reported key for the
/// current target version stays suppressed. Uses the same untyped-merge path as
/// `record_non_convergent_version`, so unknown future menubar.json keys survive.
fn record_install_failure_episode_markers(keys: &[String]) -> Result<(), String> {
    let array = Value::Array(keys.iter().map(|key| Value::String(key.clone())).collect());
    paths::menubar_json_path().and_then(|path| {
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[(INSTALL_FAILURE_EPISODE_KEYS, array)],
        )
    })
}

/// Read the machine's set of already-reported non-blocking non-convergence
/// episode keys from menubar.json, or an empty set if absent/unreadable. An
/// unreadable set makes the capture bound fail closed (report), mirroring the
/// install-failure marker contract.
fn non_convergent_episode_markers() -> Vec<String> {
    let Ok(path) = paths::menubar_json_path() else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return Vec::new();
    };
    value
        .get(NON_CONVERGENT_EPISODE_KEYS)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Persist the updated non-blocking episode set through the same untyped-merge
/// path as `record_non_convergent_version`, so unknown future menubar.json keys
/// survive. This NEVER writes the durable blocking marker — a shortfall must keep
/// retrying.
fn record_non_convergent_episode_markers(keys: &[String]) -> Result<(), String> {
    let array = Value::Array(keys.iter().map(|key| Value::String(key.clone())).collect());
    paths::menubar_json_path().and_then(|path| {
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[(NON_CONVERGENT_EPISODE_KEYS, array)],
        )
    })
}

/// Hard timeout for the pnpm verification subprocesses (`bin -g`, `ls -g`,
/// `root -g`). pnpm cold-starts slower than a bare `node --version`, so this is
/// looser than `TOOL_PROBE_TIMEOUT`, but every probe is still bounded: a hung
/// pnpm (e.g. a Corepack shim resolving a missing package-manager binary) is
/// killed when the timeout fires rather than blocking the install forever and
/// wedging the CLI-update single-flight for every later caller.
const PNPM_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// The global bin directory pnpm resolves NATIVELY (`pnpm bin -g`) under the same
/// environment the install used — deliberately WITHOUT the forced global-bin-dir
/// flag the install passes. The forced-flag probe the r2 fix
/// used was a tautology: it could only echo the value we handed it, so it "proved"
/// a match on both a build that honoured the flag and one that ignored it. Dropping
/// the flag makes the probe honest — it now reports where pnpm would write on its
/// own — but that answer is a DIAGNOSTIC ONLY and no longer gates any class: on the
/// pnpm >=11 nested layout the native dir is the flat home while the install
/// correctly writes the nested bin dir, so a mismatch here is the healthy shape.
/// Spawned only on the non-convergent path, so the converged happy path pays no
/// extra subprocess. Bounded by `PNPM_PROBE_TIMEOUT` with `kill_on_drop`, so a
/// hung pnpm is terminated instead of leaking. `None` on any spawn error, non-zero
/// exit, non-UTF-8 output, or timeout. Only the directory string is returned.
async fn pnpm_effective_global_bin_dir(
    pnpm_bin: &str,
    path: &str,
    pnpm_home: Option<&str>,
) -> Option<String> {
    let mut cmd = paths::tokio_spawn_command(pnpm_bin, &["bin", "-g"]);
    cmd.env("PATH", path).kill_on_drop(true);
    if let Some(home) = pnpm_home {
        cmd.env("PNPM_HOME", home);
    }
    let output = tokio::time::timeout(PNPM_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()? // timed out -> future dropped -> child killed
        .ok()?; // spawn / exec error
    if !output.status.success() {
        return None;
    }
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!dir.is_empty()).then_some(dir)
}

/// Run one bounded pnpm probe and return its trimmed stdout, or `None` on spawn
/// error, non-zero exit, or timeout. Every probe uses `kill_on_drop` + a
/// `PNPM_PROBE_TIMEOUT`, so a hung pnpm cannot block the install.
async fn pnpm_probe_line(
    pnpm_bin: &str,
    path: &str,
    pnpm_home: &str,
    args: &[&str],
) -> Option<String> {
    let mut cmd = paths::tokio_spawn_command(pnpm_bin, args);
    cmd.env("PATH", path)
        .env("PNPM_HOME", pnpm_home)
        .kill_on_drop(true);
    let output = tokio::time::timeout(PNPM_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The version pnpm actually delivered into its global store, taken from pnpm's
/// OWN answer rather than a guessed store layout. Runs on the non-convergent path
/// only, bounded and non-mutating, under exactly the PATH and PNPM_HOME the
/// install used:
///   1. `pnpm ls -g --depth 0 --json` — the authoritative reader.
///   2. `pnpm root -g` — scanned for the package in both the pnpm <=10 and pnpm
///      >=11 store shapes, which also yields the store-family diagnostic token.
///   3. the corrected candidate enumeration (`installed_hq_cli_version_in_pnpm_store`)
///      as the last-resort fallback.
/// Every subprocess is bounded by `PNPM_PROBE_TIMEOUT` with `kill_on_drop`.
/// Returns the delivered version (if any), the observed store family, and whether
/// pnpm's own answer (steps 1-2) succeeded. Total failure is "no evidence" — the
/// caller then retries and never blocks.
async fn pnpm_global_delivered_version(
    pnpm_bin: &str,
    path: &str,
    pnpm_home: &str,
) -> (Option<String>, PnpmStoreFamily, bool) {
    let ls_version = pnpm_probe_line(
        pnpm_bin,
        path,
        pnpm_home,
        &["ls", "-g", "--depth", "0", "--json"],
    )
    .await
    .and_then(|json| pnpm_global_ls_hq_cli_version(&json));

    // `pnpm root -g` gives the store root: used to locate the package when
    // `ls -g` did not answer, and to name the store family for telemetry.
    let root = pnpm_probe_line(pnpm_bin, path, pnpm_home, &["root", "-g"])
        .await
        .map(|line| line.trim().to_string())
        .filter(|root| !root.is_empty());

    let store_family = root
        .as_deref()
        .and_then(|root| {
            std::path::Path::new(root)
                .components()
                .rev()
                .find_map(|component| {
                    let name = component.as_os_str().to_str()?;
                    match pnpm_store_family(name) {
                        PnpmStoreFamily::Unknown => None,
                        family => Some(family),
                    }
                })
        })
        .unwrap_or(PnpmStoreFamily::Unknown);

    // The `root -g` scan and the last-resort enumeration are filesystem reads
    // (bounded read_dir, no subprocess), run off the async thread.
    let root_version = match (ls_version.is_none(), root.clone()) {
        (true, Some(root)) => tauri::async_runtime::spawn_blocking(move || {
            hq_cli_version_under_pnpm_root(std::path::Path::new(&root))
        })
        .await
        .ok()
        .flatten(),
        _ => None,
    };

    let authoritative = ls_version.or(root_version);
    let authoritative_query_ok = authoritative.is_some();
    let delivered = match authoritative {
        Some(version) => Some(version),
        None => {
            // Last resort: the corrected candidate enumeration, re-scanned fresh so
            // a changing pnpm 11 opaque-hash directory is handled.
            let home = pnpm_home.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                installed_hq_cli_version_in_pnpm_store(&home)
            })
            .await
            .ok()
            .flatten()
        }
    };
    (delivered, store_family, authoritative_query_ok)
}

/// Update a pnpm-managed `hq` with pnpm itself. npm cannot replace a shim in
/// pnpm's flat global dir — `npm install -g` writes an unrelated prefix, exits
/// 0, and the shim on PATH stays stale, which is exactly the non-convergent
/// loop the convergence gate below catches after the fact. Branching here fixes
/// it up front: the tool that owns the binary performs the update. Single
/// attempt on purpose — the npm retry ladder (EEXIST/ENOTEMPTY/EPERM) encodes
/// npm-specific failure shapes that don't apply to `pnpm add -g`.
async fn install_hq_cli_update_via_pnpm(
    app: &AppHandle,
    hq: &str,
    latest: &str,
    already_blocked: bool,
) -> Result<HqCliUpdateInfo, String> {
    const MANUAL_CMD: &str = "pnpm add -g @indigoai-us/hq-cli@latest";
    let pnpm = paths::resolve_bin("pnpm");
    if pnpm == "pnpm" {
        return Err(format!(
            "hq was installed with pnpm, but pnpm could not be found. \
             Update manually: {MANUAL_CMD}"
        ));
    }
    // Derive pnpm's home strictly from the shim we already resolved. An
    // underivable layout yields `None` and the child is spawned exactly as
    // before rather than being aimed at an invented directory.
    let pnpm_env = pnpm_global_env(hq);
    let home_source = pnpm_env
        .as_ref()
        .map(|env| env.source)
        .unwrap_or(PnpmHomeSource::Undetermined);
    let home_env_present = std::env::var_os("PNPM_HOME").is_some();
    let base_path = paths::child_path();
    let path = pnpm_child_path(
        &base_path,
        pnpm_env.as_ref().map(|env| env.global_bin_dir.as_str()),
    );
    let shim_dir = pnpm_env.as_ref().map(|env| env.global_bin_dir.clone());
    let path_has_shim_dir = shim_dir
        .as_deref()
        .is_some_and(|dir| path_contains_dir(&path, dir));
    // Pin the exact resolved version, mirroring the npm path: pnpm is asked for
    // the same string the app compared against, never the mutable `@latest` tag.
    // Force pnpm's global bin dir at the directory that actually holds the
    // resolved shim — left to itself pnpm treats PNPM_HOME AS the global bin dir,
    // so for the pnpm >=11 nested layout it writes the new shim flat into the
    // grandparent and never touches the nested shim the app executes. An
    // underivable layout passes `None` and spawns pnpm exactly as before.
    let args = pnpm_install_argv(
        Some(latest),
        pnpm_env.as_ref().map(|env| env.global_bin_dir.as_str()),
    );
    log(
        "hq-cli-update",
        &format!(
            "install: pnpm-managed hq detected — spawning pnpm {} (home_source={}, \
             path_has_shim_dir={path_has_shim_dir})",
            args.join(" "),
            home_source.telemetry_value()
        ),
    );
    let output = {
        let pnpm = pnpm.clone();
        let path = path.clone();
        let args = args.clone();
        let pnpm_home = pnpm_env.as_ref().map(|env| env.home.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = paths::spawn_command(&pnpm, &[]);
            cmd.args(&args).env("PATH", &path);
            // Without PNPM_HOME the child falls back to its own default, which
            // on a Dock-launched app is not necessarily the home that owns the
            // shim we are trying to replace.
            if let Some(home) = pnpm_home {
                cmd.env("PNPM_HOME", home);
            }
            cmd.output()
        })
        .await
        .map_err(|e| format!("join blocking task: {e}"))?
        .map_err(|e| format!("spawn pnpm: {e}"))?
    };
    let pnpm_output_len = output.stdout.len() + output.stderr.len();
    let pnpm_exit_status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        log(
            "hq-cli-update",
            &format!(
                "pnpm install failed (exit {:?}): {}",
                output.status.code(),
                redact_home(&detail)
            ),
        );
        return Err(format!(
            "pnpm could not update the HQ CLI: {detail}\nYou can run it manually: {MANUAL_CMD}"
        ));
    }
    // Same convergence gate as the npm path, and the same re-resolve: pnpm may
    // legitimately have moved which binary the app executes, and judging this
    // run against the stale pre-install shim would block an update that landed.
    let post_install_hq = paths::resolve_bin("hq");
    let resolved = {
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    // Installer-output evidence for the classifier, gathered ONLY when the run
    // did not converge so the converged happy path pays no extra subprocess.
    // `delivered` is pnpm's OWN answer for the version in its global store
    // (`pnpm ls -g --json` / `pnpm root -g` / corrected store enumeration), which
    // reads the pnpm >=11 store the base defect was blind to. `matches` is now the
    // native `pnpm bin -g` direction — a DIAGNOSTIC ONLY, spawned without the
    // forced global-bin-dir so it reports pnpm's own resolution rather than
    // echoing the value the install handed it. An underivable layout probes
    // nothing and stays foreign-managed.
    let converged = install_converged(resolved.as_deref(), latest);
    let (delivered_version, global_bin_dir_matches_shim_dir, store_family, authoritative_query_ok) =
        match (converged, pnpm_env.as_ref()) {
            (false, Some(env)) => {
                let (delivered, store_family, authoritative_query_ok) =
                    pnpm_global_delivered_version(&pnpm, &path, &env.home).await;
                let effective =
                    pnpm_effective_global_bin_dir(&pnpm, &path, Some(env.home.as_str())).await;
                let matches = effective.as_deref().map(|dir| {
                    std::path::Path::new(dir) == std::path::Path::new(&env.global_bin_dir)
                });
                (delivered, matches, store_family, authoritative_query_ok)
            }
            // Converged, or an underivable layout: nothing to probe or compare.
            _ => (None, None, PnpmStoreFamily::Unknown, false),
        };
    // The persisted non-blocking episode set bounds a resolution shortfall to one
    // capture per `(latest, executor, kind, home_source)` episode. Read only on
    // the non-convergent path; an unreadable set is an empty slice (fail-closed:
    // report). The converged happy path needs none.
    let nonblocking_episode_keys = if converged {
        Vec::new()
    } else {
        non_convergent_episode_markers()
    };
    let outcome = decide_post_install(&PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: hq,
        after_bin: &post_install_hq,
        // Diagnostic only on the npm path, where it separates an expected
        // shim-to-npm relocation from an in-place update. pnpm never relocates
        // resolution away from its own global dir, so skipping the extra
        // pre-install probe changes no decision — the post-install reading
        // remains the sole authority for blocking.
        before_version: None,
        after_version: resolved.as_deref(),
        latest,
        npm_prefix_passed: None,
        // Delivery evidence now gates the pnpm arm too: pnpm's own answer for the
        // version in its store. `None` on the converged happy path, where the
        // decision never consults it.
        delivered_version: delivered_version.as_deref(),
        installer_bin: &pnpm,
        already_blocked,
        nonblocking_episode_keys: &nonblocking_episode_keys,
        // pnpm never produces the npm same-root managed-shadow shape.
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        // pnpm never reaches the ForeignManaged arm, so the aim/shim gate is
        // never consulted; the resolution lane still rides the event honestly.
        executed_copy_aim: ExecutedCopyAim::Undrivable,
        hq_bin_lane: paths::resolution_source_of_bin(&post_install_hq),
        delivered_prefix_shim: DeliveredPrefixShim::Unknown,
        pnpm: Some(PnpmRunDiagnostics {
            home_source,
            home_env_present,
            path_has_shim_dir,
            global_bin_dir_matches_shim_dir,
            store_family,
            authoritative_query_ok,
            exit_status: pnpm_exit_status,
            output_len: pnpm_output_len,
        }),
    });
    log("hq-cli-update", &outcome.log_line);
    let result = apply_post_install_with_app(app, &outcome);
    // Persist the non-blocking episode key AFTER the capture, so a persistent
    // shortfall shape reports once per `latest` instead of on every check and
    // every app restart. Best-effort and never gates the capture (fail-loud):
    // a failed write simply means the next occurrence reports again.
    if let Some(key) = outcome.record_nonblocking_episode.as_deref() {
        let existing = non_convergent_episode_markers();
        let updated = non_convergent_episode_record(&existing, key, latest);
        if let Err(e) = record_non_convergent_episode_markers(&updated) {
            log(
                "hq-cli-update",
                &format!("could not persist non-convergent episode markers: {e}"),
            );
        }
    }
    result
}

/// Update a Bun-managed global CLI with the package manager that owns its shim.
/// `BUN_INSTALL` and PATH are derived from the already-resolved `hq`, so a
/// Dock-launched app updates the same global tree even without shell startup
/// files. A successful process exit still has to pass the shared convergence
/// gate before the app reports the update as installed.
async fn install_hq_cli_update_via_bun(
    app: &AppHandle,
    hq: &str,
    latest: &str,
    already_blocked: bool,
) -> Result<HqCliUpdateInfo, String> {
    const MANUAL_CMD: &str = "bun add -g @indigoai-us/hq-cli@latest";
    let bun_home = bun_home_from_hq_bin(Path::new(hq)).ok_or_else(|| {
        format!(
            "hq appears to be Bun-managed, but its BUN_INSTALL directory could not be derived. \
             Update manually: {MANUAL_CMD}"
        )
    })?;
    let bun = paths::resolve_bin("bun");
    if bun == "bun" {
        return Err(format!(
            "hq was installed with Bun, but bun could not be found. Update manually: {MANUAL_CMD}"
        ));
    }

    let shim_dir = Path::new(hq)
        .parent()
        .map(|path| path.to_string_lossy().to_string());
    let path = pnpm_child_path(&paths::child_path(), shim_dir.as_deref());
    let args = bun_install_argv(Some(latest));
    log(
        "hq-cli-update",
        &format!(
            "install: Bun-managed hq detected — spawning bun {}",
            args.join(" ")
        ),
    );
    let output = {
        let bun = bun.clone();
        let bun_home = bun_home.clone();
        let path = path.clone();
        let args = args.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = paths::spawn_command(&bun, &[]);
            cmd.args(&args)
                .env("PATH", &path)
                .env("BUN_INSTALL", &bun_home);
            cmd.output()
        })
        .await
        .map_err(|e| format!("join blocking task: {e}"))?
        .map_err(|e| format!("spawn bun: {e}"))?
    };
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        log(
            "hq-cli-update",
            &format!(
                "Bun install failed (exit {:?}): {}",
                output.status.code(),
                redact_home(&detail)
            ),
        );
        return Err(format!(
            "Bun could not update the HQ CLI: {detail}\nYou can run it manually: {MANUAL_CMD}"
        ));
    }

    let post_install_hq = paths::resolve_bin("hq");
    let resolved = {
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    let converged = install_converged(resolved.as_deref(), latest);
    let delivered_version = if converged {
        None
    } else {
        let bun_home = bun_home.clone();
        tauri::async_runtime::spawn_blocking(move || {
            installed_hq_cli_version_in_bun_global(&bun_home)
        })
        .await
        .ok()
        .flatten()
    };
    let nonblocking_episode_keys = if converged {
        Vec::new()
    } else {
        non_convergent_episode_markers()
    };
    let outcome = decide_post_install(&PostInstallContext {
        executor: InstallExecutor::Bun,
        before_bin: hq,
        after_bin: &post_install_hq,
        before_version: None,
        after_version: resolved.as_deref(),
        latest,
        npm_prefix_passed: None,
        delivered_version: delivered_version.as_deref(),
        installer_bin: &bun,
        already_blocked,
        nonblocking_episode_keys: &nonblocking_episode_keys,
        // Bun never produces the npm same-root managed-shadow shape.
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        // Bun never reaches the ForeignManaged arm, so the aim/shim gate is never
        // consulted; the resolution lane still rides the event honestly.
        executed_copy_aim: ExecutedCopyAim::Undrivable,
        hq_bin_lane: paths::resolution_source_of_bin(&post_install_hq),
        delivered_prefix_shim: DeliveredPrefixShim::Unknown,
        pnpm: None,
    });
    log("hq-cli-update", &outcome.log_line);
    let result = apply_post_install_with_app(app, &outcome);
    if let Some(key) = outcome.record_nonblocking_episode.as_deref() {
        let existing = non_convergent_episode_markers();
        let updated = non_convergent_episode_record(&existing, key, latest);
        if let Err(error) = record_non_convergent_episode_markers(&updated) {
            log(
                "hq-cli-update",
                &format!("could not persist non-convergent episode markers: {error}"),
            );
        }
    }
    result
}

/// Apply a post-install decision with the production effects. Both executors go
/// through this one function so the fail-closed marker ordering, the episode
/// bounding, and the capture rules cannot drift between them.
fn apply_post_install_with_app(
    app: &AppHandle,
    outcome: &PostInstallOutcome,
) -> Result<HqCliUpdateInfo, String> {
    let record = |version: String| record_non_convergent_version(&version);
    let clear = || clear_non_convergent_version();
    let capture = |report: NonConvergentReport| report_non_convergent_install(&report);
    let record_failure = |error: String| {
        log("hq-cli-update", &error);
        report_non_convergent_marker_unpersisted();
    };
    let emit_cleared = |info: HqCliUpdateInfo| {
        // Frontend uses this to drop the banner immediately on success.
        let _ = app.emit("hq-cli-update:cleared", &info);
    };
    let effects = PostInstallEffects {
        record: &record,
        clear: &clear,
        capture: &capture,
        record_failure: &record_failure,
        emit_cleared: &emit_cleared,
    };
    apply_post_install(outcome, &effects)
}

/// The side effects selected by the pure core post-install decision. Keeping
/// these injectable gives tests an exact ordering and call-count seam, and
/// keeps capture behind a successful durable marker write for foreign-managed
/// CLI layouts.
struct PostInstallEffects<'a> {
    record: &'a dyn Fn(String) -> Result<(), String>,
    clear: &'a dyn Fn(),
    capture: &'a dyn Fn(NonConvergentReport),
    record_failure: &'a dyn Fn(String),
    emit_cleared: &'a dyn Fn(HqCliUpdateInfo),
}

fn apply_post_install(
    outcome: &PostInstallOutcome,
    effects: &PostInstallEffects<'_>,
) -> Result<HqCliUpdateInfo, String> {
    let core_effects = PostInstallCoreEffects {
        record: effects.record,
        clear: effects.clear,
        capture: effects.capture,
        record_failure: effects.record_failure,
    };
    let success = apply_post_install_effects(outcome, &core_effects)?;
    let info = HqCliUpdateInfo {
        local: Some(success.local),
        latest: success.latest,
    };
    (effects.emit_cleared)(info.clone());
    Ok(info)
}

/// Take the cross-process cli-update lock before mutating the global
/// `@indigoai-us/hq-cli` install. Layering, deliberately kept distinct:
///
///   * `AsyncSingleFlight` dedupes concurrent callers INSIDE this app;
///   * this file lock (`hq_desktop_core::cli_update_lock` — path, JSON field
///     names, and staleness are a cross-repo CONTRACT with hq-cli's
///     TypeScript version gate) serializes writers ACROSS processes, closing
///     the mid-rename npm collision window;
///   * the non-convergence marker in `menubar.json` keeps governing the RETRY
///     policy after an install that didn't take.
///
/// A fresh, live holder means skip this cycle entirely — the mandatory
/// one-line log identifies the holder, and the returned `Err` reads the same
/// way in the background loop's "auto-update failed" line and in the UI. The
/// scheduled checker retries naturally.
pub(crate) fn acquire_cli_install_lock(
    app: &AppHandle,
    tool: &str,
) -> Result<CliUpdateLockGuard, String> {
    match acquire_cli_update_lock(tool, &app.package_info().version.to_string())? {
        CliUpdateLockAttempt::Acquired(guard) => Ok(guard),
        CliUpdateLockAttempt::Held { holder } => {
            let msg = format!(
                "another hq-cli install is already running ({holder}); skipping this cycle"
            );
            log("hq-cli-update", &msg);
            Err(msg)
        }
    }
}

static HQ_CLI_INSTALL_FLIGHT: OnceLock<AsyncSingleFlight<HqCliUpdateInfo>> = OnceLock::new();

fn hq_cli_install_flight() -> &'static AsyncSingleFlight<HqCliUpdateInfo> {
    HQ_CLI_INSTALL_FLIGHT.get_or_init(AsyncSingleFlight::new)
}

#[tauri::command]
pub async fn install_hq_cli_update(app: AppHandle) -> Result<HqCliUpdateInfo, String> {
    hq_cli_install_flight()
        .run(move || install_hq_cli_update_once(app))
        .await
}

async fn install_hq_cli_update_once(app: AppHandle) -> Result<HqCliUpdateInfo, String> {
    // Held for the WHOLE install — every executor path below (npm, pnpm, bun,
    // and the managed-toolchain retry) mutates the same global CLI layout, so
    // the guard must outlive them all. Drop (including panic unwind) releases.
    let _install_lock = acquire_cli_install_lock(&app, "hq-desktop-app-cli-update")?;
    let npm = paths::resolve_bin("npm");
    let path = paths::child_path();
    let hq_resolved = paths::resolve_bin_with_kind("hq");
    let hq = hq_resolved.path.clone();
    let mut first_install = false;
    let executor = match install_executor_for_hq_bin(Path::new(&hq)) {
        Some(executor) => executor,
        // Nothing identifiable at the resolved path. When nothing resolved AT
        // ALL there is no file to overwrite, so this is a first install rather
        // than the unrelated-command case the refusal guards; anything else
        // still refuses. See `install_executor_for_first_install`.
        None => {
            let executor =
                install_executor_for_first_install(hq_resolved.kind).ok_or_else(|| {
                    format!(
                        "The resolved `hq` at {hq} is not the @indigoai-us/hq-cli package. \
                         Refusing to overwrite an unrelated command."
                    )
                })?;
            first_install = true;
            executor
        }
    };
    // This must be sampled before the install, for either executor. An
    // unwritable marker reads as absent; the post-install gate then refuses to
    // capture unless this run successfully persists the first-episode marker.
    let non_convergent_version = non_convergent_cli_version();
    if executor != InstallExecutor::Npm {
        // Pin the target before spawning, same as the npm path below.
        let latest = fetch_latest().await?;
        let already_blocked =
            non_convergent_episode_blocked(non_convergent_version.as_deref(), &latest);
        return match executor {
            InstallExecutor::Pnpm => {
                install_hq_cli_update_via_pnpm(&app, &hq, &latest, already_blocked).await
            }
            InstallExecutor::Bun => {
                install_hq_cli_update_via_bun(&app, &hq, &latest, already_blocked).await
            }
            InstallExecutor::Npm => unreachable!("npm handled below"),
        };
    }
    // A machine with no CLI very often has no Node either — the population this
    // first-install path exists for is precisely the one least likely to have a
    // toolchain. And even when it HAS a user npm, that npm's default prefix is one
    // HQ never searches, so an install aimed there exits 0 yet never converges (the
    // Kevin recurrence: `hq` stays the bare sentinel and delivered_version is
    // None). On a first install, provision HQ's managed Node/npm whenever the
    // resolved npm is not already managed, so the very first spawn has an npm to
    // run AND the install runs under a runtime the app also executes.
    let managed_roots = paths::managed_toolchain_roots();
    let (npm, path) = if first_install && !npm_within_managed_root(&npm, &managed_roots) {
        provision_managed_npm_for_first_install(&app)
            .await
            .unwrap_or((npm, path))
    } else {
        (npm, path)
    };
    // Prefix selection. A FIRST install is aimed at HQ's OWN managed npm prefix,
    // which `paths::resolve_bin_in_dirs` searches before every user prefix, so the
    // post-install probe deterministically finds what was just installed instead of
    // an unreachable ambient default prefix. The ordinary (already-installed)
    // update path derives the prefix from the RUNTIME of the resolved npm, not `hq`
    // alone: if a prior episode provisioned HQ's managed Node but left no managed
    // `hq`, npm is now managed (Node 22) while `hq` still resolves the user's
    // Node-20 shim, and a user-derived prefix would receive ABI-127 artifacts that
    // runtime cannot load.
    let prefix = if first_install {
        // Aim at the managed prefix of the npm we will actually RUN — its own root
        // (canonical or the legacy `Indigo HQ` root), so the copy we write and the
        // copy resolution finds live in the SAME root. Only when npm is still
        // unmanaged (provisioning failed) fall back to the canonical managed prefix
        // as best effort. Taking `roots.first()` unconditionally would install into
        // the canonical root while a legacy-only managed npm keeps resolving the
        // legacy root — a cross-root split the classifier treats as ForeignManaged.
        hq_cli_install_prefix(&npm, &hq).or_else(|| first_install_prefix(&managed_roots))
    } else {
        hq_cli_install_prefix(&npm, &hq)
    };
    // Aim the ordinary update at the copy the app will actually EXECUTE. When the
    // resolved `hq` sits in a drivable user-owned prefix that ships its own npm,
    // install INTO that prefix and run THAT npm, so resolution finds the upgrade
    // in place instead of a managed copy the app never runs — the foreign-managed
    // non-convergence this closes. A managed npm never touches a user prefix (ABI
    // stays matched), and a FIRST install keeps aiming at HQ's own managed prefix.
    // Otherwise this is a no-op: the managed / hq-derived prefix and the resolved
    // npm stand exactly as before.
    let (prefix, npm, path) =
        match select_ordinary_install_aim(&hq, &managed_roots, paths::home_dir().as_deref()) {
            Some(aim) if !first_install => {
                // Prepend the aimed npm's own bin dir so its co-located Node
                // resolves (the shim is a `#!/usr/bin/env node` script), keeping
                // build runtime matched to execute runtime.
                let path = match Path::new(&aim.npm).parent() {
                    Some(hint) => paths::path_with_interpreter_hint(&path, hint),
                    None => path,
                };
                log(
                    "hq-cli-update",
                    &format!(
                        "aiming ordinary update at the executed copy's own prefix (npm={})",
                        redact_home(&aim.npm)
                    ),
                );
                (Some(aim.prefix), aim.npm, path)
            }
            _ => (prefix, npm, path),
        };
    // Pin the target BEFORE building the install argv. The app resolved `latest`
    // from the registry's /latest endpoint; it must ask npm for THAT EXACT
    // version, not the `@latest` dist-tag. npm re-resolves that tag through its
    // own app-private packument cache and the registry CDN edge, both of which
    // lag /latest for a short post-publish window — so the tag can still point at
    // N-1 while the app already read N. That is the registry race: npm installs
    // N-1, exits 0, and the convergence gate — comparing the fresher N — records
    // a marker that permanently wedges auto-install of a version nothing ever
    // attempted. Resolving once and pinning it makes the version the app compares
    // against and the version it asks npm to install the same string.
    let latest = fetch_latest().await?;
    let already_blocked =
        non_convergent_episode_blocked(non_convergent_version.as_deref(), &latest);
    let base_args = install_argv(prefix.as_deref(), Some(latest.as_str()));
    let npm_cache = app_npm_cache(&app).map_err(|(category, error)| {
        report_npm_cache_setup_failure(category);
        error
    })?;
    log(
        "hq-cli-update",
        &format!(
            "install: {} (prefix={})",
            base_args.join(" "),
            prefix.as_deref().unwrap_or("npm default prefix")
        ),
    );

    // Capture the pre-install execution-bound version for the decision seam.
    // It is diagnostic only; the post-install probe remains authoritative.
    let before_version = {
        let hq = hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };

    let install_run =
        run_npm_install_with_retries(&npm, &path, &npm_cache, prefix.as_deref(), base_args).await?;

    if !install_run.output.status.success() {
        let raw_detail = npm_output_detail(&install_run.output);
        // The stderr-origin attribution and self-heal decision (HQ-DESKTOP-56) MUST key
        // on the ACTUAL stderr, never `npm_output_detail`'s stdout fallback. When stderr
        // is empty but stdout is not, `raw_detail` holds stdout bytes; classifying those
        // as a `non-npm` stderr origin would wrongly arm the ~50MB managed-Node download
        // and give the event an attributed, repeat-suppressed signature, even though the
        // real stderr is empty and must stay genuinely shapeless (none:unknown:none,
        // unbounded). So the origin and the repeat-guarded report below key on
        // `raw_stderr`; `raw_detail` keeps the stdout fallback ONLY for the user-facing
        // message and the local diagnostic log.
        let raw_stderr = String::from_utf8_lossy(&install_run.output.stderr)
            .trim()
            .to_string();

        // Probe the user's failing toolchain ONCE, up front. The Node ABI is
        // retry-gate evidence — a run already on HQ's managed ABI, or a
        // disk-space/network cause, earns no provision — the SAME probe is the
        // provenance the original-path report attaches below, AND the Node version
        // is what lets an unsupported-runtime failure be told apart from a generic
        // one. `false`: this describes the user's own toolchain, never HQ's managed
        // retry.
        let mut install_env =
            probe_install_environment(&npm, &path, /* managed_toolchain_retry */ false).await;
        // Carry the mkdir remedy's diagnostic (HQ-DESKTOP-5K) onto the reported
        // event: which ancestor of the install scope was missing and how its
        // creation went. `Unknown` (→ no tag emitted) whenever that remedy did not
        // run, so a non-missing-target failure's tag set is unchanged.
        install_env.missing_target_state = install_run.missing_target_state;
        // Name the EXACT version install_argv pinned into base_args (HQ-DESKTOP-5Q),
        // so a reported E404 shows WHICH version npm was asked for. `base_args` was
        // built with `Some(latest)`, a pinned spec — never the `@latest` dist-tag.
        // Tag-only: never a fingerprint/signature/episode-key component.
        install_env = install_env.with_pinned_target_version(&latest);
        let failing_node_abi = install_env
            .node_abi
            .as_deref()
            .and_then(|abi| abi.trim().parse::<u32>().ok());

        // Classify WITH the probed environment. An unsupported-Node failure — npm
        // too old to even emit its structured error block, so the env-blind
        // classifier sees only the bare Node parse error and falls to `Unexpected`
        // — is recognised here as `UnsupportedNode`, which arms the managed-Node
        // self-heal below and reports under its own bounded signature at Warning.
        // Every supported-Node input keeps its env-blind kind unchanged.
        let failure_kind = classify_install_failure_with_environment(
            install_run.output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
            &install_env,
        );
        let lifecycle_cause = npm_lifecycle_cause(&raw_detail);
        // The markerless-stderr origin (HQ-DESKTOP-56 reopen): `Some("non-npm")` when
        // npm's own logger emitted nothing at all, so the user's npm/shim never really
        // ran — the subclass HQ's checksum-verified managed Node 22 + npm bypasses
        // entirely. `None` for every other failure (a shape npm characterised, an empty
        // stderr, or a below-floor Node already owned by UnsupportedNode). Computed ONCE
        // from the already-probed environment and threaded into the gate below, never
        // re-derived at the call site.
        let unattributed_origin = unattributed_install_stderr_origin(
            install_run.output.status.code(),
            &raw_stderr,
            prefix.as_deref(),
            install_run.final_attempt_forced,
            &install_env,
        );

        // Self-heal (HQ-DESKTOP-4V / HQ-DESKTOP-4W and HQ-DESKTOP-56). Three shapes
        // under the user's OWN Node are ones HQ can repair itself by provisioning
        // its checksum-verified managed Node 22: (1) a third-party native-build
        // lifecycle failure (better-sqlite3 / node-llama-cpp) whose ABI has no
        // prebuild and no Xcode CLT to build from source, (2) a Node older than
        // the CLI's floor, on which no install can ever converge, and (3) the
        // HQ-DESKTOP-56 reopen — a markerless failure whose stderr carried NO npm
        // line at all (`non-npm` origin), so the user's npm/shim never really ran and
        // HQ's managed npm bypasses it. Only user-path runs whose failing ABI differs
        // from HQ's managed one arm the bounded, one-shot managed-toolchain retry (so
        // a run already on the managed toolchain never retries into itself, and a
        // disk-space/network lifecycle cause is refused); every other kind/cause keeps
        // today's behaviour. HQ blames the user's toolchain (the copy below) only AFTER
        // its own repair was attempted and could not converge.
        if install_failure_earns_managed_retry(
            failure_kind,
            install_env.toolchain_source,
            lifecycle_cause,
            failing_node_abi,
            unattributed_origin,
        ) {
            match managed_toolchain_retry(
                &app,
                &hq,
                &latest,
                &npm_cache,
                before_version.as_deref(),
                already_blocked,
            )
            .await
            {
                // Converged under HQ's managed toolchain — the normal cleared /
                // convergence path already ran inside the finalize step. Emit NO
                // install-failure event; the self-heal worked.
                ManagedRetryAttempt::Converged(info) => return Ok(info),
                // The retry ran but did not converge (npm failed under the managed
                // toolchain, or exited 0 into an unreachable prefix). It already
                // reported exactly once — with managed provenance for a failure,
                // or as non-convergence for a shadowed exit-0 — so surface its
                // detail without a second capture.
                ManagedRetryAttempt::RanAndReported(detail) => return Err(detail),
                // The retry did not run. Record WHICH branch declined on the
                // user-path event so the next occurrence is self-diagnosing (the
                // HQ-DESKTOP-5E evidence gap), then fall through and report the
                // ORIGINAL user-path failure.
                ManagedRetryAttempt::Declined(outcome) => {
                    install_env.managed_retry_outcome = outcome;
                }
            }
        }

        // Report the original (user-path) failure through the repeat-guard so an
        // identical lifecycle failure that re-fires on every scheduled check pages
        // once, not forever. The raw npm output is passed so Sentry's diagnostic
        // extra is never replaced by the UI fallback text; expected environment
        // kinds still no-op in the reporter. `install_env` was probed above with
        // managed_toolchain_retry=false: this event describes the user's own
        // toolchain, never HQ's managed retry.
        let detail = install_failure_detail_with_environment(
            install_run.output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
            &install_env,
        );
        log(
            "hq-cli-update",
            &format!(
                "install failed (kind={}, exit {:?}); raw npm output retained locally: {raw_detail}",
                failure_kind.fingerprint_component(),
                install_run.output.status.code()
            ),
        );
        let reported_episode_keys = install_failure_episode_markers();
        // The Sentry capture keys on `raw_stderr`, not the stdout fallback: an empty
        // stderr must group as the genuinely shapeless none:unknown:none (unbounded,
        // never attributed), while a non-empty stderr keeps the identical envelope
        // (`raw_stderr == raw_detail` whenever stderr is non-empty). The user-facing
        // `detail` above still uses the stdout fallback so the UI/log lose nothing.
        persist_reported_episode(report_install_failure_episode(
            install_run.output.status.code(),
            &raw_stderr,
            prefix.as_deref(),
            install_run.final_attempt_forced,
            &install_env,
            &latest,
            &reported_episode_keys,
        ));
        return Err(detail);
    }

    // npm exit 0 only proves npm wrote a package somewhere; the shared finalize
    // step re-resolves the `hq` the app EXECUTES and routes the decision through
    // `decide_post_install`, so a zero exit into an unreachable prefix is still
    // recorded/reported as non-convergent rather than a silent "up to date" lie.
    finalize_convergence(
        &app,
        &hq,
        &npm,
        before_version.as_deref(),
        &latest,
        prefix.as_deref(),
        already_blocked,
    )
    .await
}

/// Whether a failed install is a shape HQ can self-heal by installing its managed
/// Node and retrying. Pure so the gate is unit-testable without an `AppHandle` or
/// a real install.
///
/// TWO runtime conditions are always required:
///   * `source` is the user's own toolchain (`UserPath`) — a run already on the
///     managed toolchain cannot be improved by installing it again;
///   * the failing runtime's ABI differs from HQ's managed-Node ABI. A run already
///     on ABI 127 gains nothing from provisioning Node 22. An UNKNOWN ABI (the
///     probe could not read it) is treated as "not the managed ABI", so the
///     reported Node-20 (ABI 115) and Node-6 (ABI 48) clusters still arm.
///
/// ...plus ONE of four repairable failure shapes:
///   * Shape 1 (HQ-DESKTOP-4V/4W) — a third-party native-build lifecycle failure
///     (`UnexpectedLifecycle`) whose `cause` a new runtime can fix. A full disk
///     (`disk-space`) or a dead network (`network`) would only waste a ~50MB Node
///     download — and a disk-space failure can be made worse by one — so those are
///     refused. Every other cause (including the reported `unknown` and
///     `toolchain-missing`) is eligible, because a missing prebuild for the user's
///     ABI is exactly what a runtime whose ABI *does* have prebuilds repairs.
///   * Shape 2 (HQ-DESKTOP-56) — an `UnsupportedNode` failure: the user's PATH
///     Node is below the CLI's floor, so no npm run can converge on it. There is
///     no lifecycle cause to consult (npm never ran a build); provisioning HQ's
///     managed Node 22 is the exact repair, and a converged retry emits no event.
///   * Shape 3 (HQ-DESKTOP-5K) — a `MissingGlobalInstallTarget` failure: npm could
///     not create its OWN global install-target directory (a broken/absent npm
///     PREFIX chain, not a runtime-version or prebuild fault). The
///     `failing_node_abi != Some(MANAGED_NODE_ABI)` clause deliberately does NOT
///     apply — a run on the identical managed ABI still repairs the machine because
///     `managed_toolchain_retry` rebuilds argv against a prefix HQ itself owns and
///     creates; its only runtime condition is the user's own toolchain.
///   * Shape 4 (HQ-DESKTOP-56 reopen) — an `Unexpected` failure whose stderr was
///     markerless with a `non-npm` origin: npm's own logger emitted NOTHING, so the
///     user's npm/shim never really ran. HQ's checksum-verified managed Node 22 +
///     npm bypasses a broken user npm/shim entirely, so it is the exact repair.
///     `unattributed_origin` carries `Some("non-npm")` for exactly this subclass and
///     `None` otherwise; an `npm-logger` origin (npm ran and reported) and an empty
///     stderr both decline — a new runtime is unlikely to help and would spend the
///     ~50MB download.
fn install_failure_earns_managed_retry(
    kind: InstallFailureKind,
    source: NpmToolchainSource,
    cause: &str,
    failing_node_abi: Option<u32>,
    unattributed_origin: Option<&str>,
) -> bool {
    // Only the user's OWN toolchain is ever worth replacing with HQ's managed one;
    // a run already under the managed toolchain cannot be improved by installing it
    // again. Shared by all four repairable shapes.
    let is_user_path = source == NpmToolchainSource::UserPath;
    // Shapes 1, 2 & 4 ADDITIONALLY require a runtime whose ABI differs from HQ's
    // managed one: a lifecycle/prebuild fault, a too-old runtime, or a markerless
    // non-npm failure cannot be fixed by re-provisioning the same ABI. An UNKNOWN ABI
    // is treated as not-managed.
    let repairable_runtime = is_user_path && failing_node_abi != Some(MANAGED_NODE_ABI);
    // Shape 1 (HQ-DESKTOP-4V/4W): a third-party native-build lifecycle failure
    // whose diagnosed cause a different runtime can actually fix.
    let repairable_lifecycle = kind == InstallFailureKind::UnexpectedLifecycle
        && !matches!(cause, "disk-space" | "network");
    // Shape 2 (HQ-DESKTOP-56): the user's PATH Node is below the CLI's floor, so
    // the install could never converge on it. npm never ran a build, so there is
    // no lifecycle cause to consult; installing HQ's managed Node 22 is the exact
    // repair, and a converged retry emits no event.
    let unsupported_node = kind == InstallFailureKind::UnsupportedNode;
    // Shape 3 (HQ-DESKTOP-5K): npm could not create its OWN global install-target
    // directory. This is a broken/absent npm PREFIX chain, not a runtime-version or
    // prebuild fault, so the `failing_node_abi != Some(MANAGED_NODE_ABI)` clause
    // deliberately does NOT apply — a run on the identical managed ABI still repairs
    // the machine, because `managed_toolchain_retry` rebuilds argv against
    // `paths::managed_npm_prefix_in`, a prefix HQ itself owns and CREATES. Its only
    // runtime condition is that the failing run used the user's own toolchain.
    let missing_global_install_target = kind == InstallFailureKind::MissingGlobalInstallTarget;
    // Shape 4 (HQ-DESKTOP-56 reopen): a markerless `Unexpected` failure whose stderr
    // origin is `non-npm` (npm's logger produced nothing at all). Only the non-npm
    // origin arms — an `npm-logger` origin or an empty stderr is folded into `None`
    // by the caller, so this can never fire for a failure npm actually reported.
    let unattributed_non_npm =
        kind == InstallFailureKind::Unexpected && unattributed_origin == Some(STDERR_ORIGIN_NON_NPM);
    // A `ForeignRegistryPackageMissing` (HQ-DESKTOP-5Q) is a registry
    // misconfiguration, NOT a runtime/prebuild or npm-prefix fault: provisioning a
    // different Node cannot make a registry that lacks the package carry it, and the
    // managed retry reuses the SAME machine npm registry config, so it would only
    // waste a ~50 MB provision and re-fail identically. It matches none of the four
    // repairable shapes, so it correctly earns no retry; a unit test locks it.
    (repairable_runtime && (repairable_lifecycle || unsupported_node || unattributed_non_npm))
        || (is_user_path && missing_global_install_target)
}

/// Pure selection of the ordinary install prefix from the RUNTIME of the resolved
/// `npm`. When npm is HQ's managed npm the install MUST target the managed prefix —
/// installing under managed Node (ABI 127) into the user's own prefix would write
/// native artifacts a user runtime (Node 20, ABI 115) cannot load. Otherwise use the
/// `hq`-derived prefix, exactly as before. Pure so the decision is unit-testable
/// without touching the filesystem.
fn prefer_managed_prefix(
    npm_is_managed: bool,
    managed_prefix: Option<String>,
    hq_derived_prefix: Option<String>,
) -> Option<String> {
    if npm_is_managed {
        managed_prefix.or(hq_derived_prefix)
    } else {
        hq_derived_prefix
    }
}

/// The install prefix for the ORDINARY (first-attempt) install, kept consistent with
/// the runtime of the resolved `npm`. This closes the cross-runtime corruption that
/// reopens on the run AFTER a managed provision leaves no usable managed `hq`: on
/// that run `resolve_bin("npm")` is already HQ's managed npm (Node 22) while
/// `resolve_bin("hq")` still selects the user's Node-20 shim, so deriving the prefix
/// from `hq` alone would install ABI-127 artifacts into the user's prefix — the very
/// corruption the managed-retry fix prevents. Detecting a managed npm (it lives
/// inside a managed toolchain root) and routing to the shared managed prefix keeps
/// build runtime and execute runtime matched on the ordinary path too. A healthy
/// user-path install (managed npm absent, or `hq` already in the managed prefix) is
/// unchanged.
fn hq_cli_install_prefix(npm: &str, hq: &str) -> Option<String> {
    let mut npm_is_managed = false;
    let mut managed_prefix: Option<String> = None;
    for root in paths::managed_toolchain_roots() {
        if Path::new(npm).starts_with(&root) {
            npm_is_managed = true;
            managed_prefix = Some(
                paths::managed_npm_prefix_in(&root)
                    .to_string_lossy()
                    .to_string(),
            );
            break;
        }
    }
    prefer_managed_prefix(npm_is_managed, managed_prefix, npm_prefix_from_hq_bin(hq))
}

/// Aim the ORDINARY update at the copy the app will actually EXECUTE. When the
/// resolved `hq` sits in a drivable user-owned prefix — outside every managed
/// root, inside `$HOME`, and not a system/Homebrew prefix
/// ([`paths::is_user_owned_prefix`]) — that ships its own co-located npm
/// (`<prefix>/bin/npm` on unix, `<prefix>\npm.cmd` on Windows), install INTO that
/// prefix and run THAT npm, so the very copy resolution returns is upgraded in
/// place instead of a managed copy the app never runs. That is what converges the
/// live nvm-under-managed-npm shape.
///
/// The ABI guarantee stays intact by construction: this only ever runs the
/// user's OWN co-located npm against the user's OWN prefix (matched runtimes), so
/// HQ's managed npm is never pointed at a user prefix. Returns `None` — keep the
/// managed / hq-derived prefix and the resolved npm, exactly as
/// [`prefer_managed_prefix`] already did — in every other case (a managed or
/// system prefix, a hand-rolled `hq` with no derivable prefix, or a user prefix
/// with no co-located npm). The filesystem is touched only to confirm the
/// co-located npm exists; the choice itself is the pure, core-tested
/// [`user_prefix_aim_decision`]. `home` is injected so the boundary is
/// unit-testable with a tempdir as `$HOME`.
fn select_ordinary_install_aim(
    hq: &str,
    managed_roots: &[PathBuf],
    home: Option<&Path>,
) -> Option<UserPrefixAim> {
    let hq_prefix = npm_prefix_from_hq_bin(hq)?;
    let hq_prefix_path = Path::new(&hq_prefix);
    let user_owned = paths::is_user_owned_prefix(hq_prefix_path, managed_roots, home);
    let colocated = colocated_npm_path(hq_prefix_path);
    let colocated_user_npm = colocated
        .exists()
        .then(|| colocated.to_string_lossy().to_string());
    user_prefix_aim_decision(
        Some(hq_prefix.as_str()),
        user_owned,
        colocated_user_npm.as_deref(),
    )
}

/// Whether the resolved `npm` lives inside one of HQ's managed toolchain roots —
/// i.e. it is HQ's own managed npm rather than a user (or unresolved) one. An
/// unresolved bare `npm` never starts with an absolute root, so it reads as not
/// managed and the first-install path provisions HQ's managed Node, exactly as
/// before. Pure so the provisioning gate is unit-testable without the filesystem.
fn npm_within_managed_root(npm: &str, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| Path::new(npm).starts_with(root))
}

/// The install prefix for a FIRST install (nothing resolved at all): HQ's OWN
/// managed npm prefix under the primary toolchain root. `paths::resolve_bin_in_dirs`
/// searches `<root>/npm-global/bin` before every user prefix, so aiming the first
/// install here makes the post-install probe deterministically find what was just
/// installed — instead of letting npm write into its ambient default prefix, which
/// HQ never searches (so the CLI would never converge). Pure so the selection is
/// unit-testable without the filesystem. `None` only when no managed root is
/// discoverable, in which case the caller falls back to the npm-derived prefix.
fn first_install_prefix(roots: &[PathBuf]) -> Option<String> {
    roots.first().map(|root| {
        paths::managed_npm_prefix_in(root)
            .to_string_lossy()
            .to_string()
    })
}

/// Convergence gate + post-install effects shared by the first install attempt
/// and the managed-toolchain retry. A zero npm exit only proves npm wrote a
/// package somewhere; this re-resolves the `hq` the app EXECUTES and routes the
/// decision through `decide_post_install`, so a retry that exits 0 into an
/// unreachable prefix is still recorded/reported as non-convergent, never as a
/// silent "up to date" lie. `installer_npm` is the npm that ran (the user's on
/// the first attempt, HQ's managed one on the retry) so the executor attribution
/// is honest.
async fn finalize_convergence(
    app: &AppHandle,
    before_bin: &str,
    installer_npm: &str,
    before_version: Option<&str>,
    latest: &str,
    prefix: Option<&str>,
    already_blocked: bool,
) -> Result<HqCliUpdateInfo, String> {
    let post_install_hq = paths::resolve_bin("hq");
    let resolved = {
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    // Delivery evidence for the classifier: the version the install actually wrote
    // INTO the prefix we aimed at, read straight from the manifest. A
    // foreign-managed layout passes no prefix and never reaches the targeted arm.
    let delivered_version = match prefix {
        Some(prefix) => {
            let prefix = prefix.to_string();
            let hq = post_install_hq.clone();
            tauri::async_runtime::spawn_blocking(move || {
                installed_hq_cli_version_in_prefix(&prefix, &hq)
            })
            .await
            .ok()
            .flatten()
        }
        None => None,
    };
    let managed_roots = paths::managed_toolchain_roots();
    // The persisted non-blocking episode set bounds a NON-blocking non-convergence
    // — a resolution shortfall, or the installer-unaimed shape an unresolved `hq`
    // now produces — to one capture per `(latest, executor, kind, home_source)`
    // episode, so a persistent shape does not re-page on every scheduled check.
    // Mirrors the pnpm/Bun paths; read only on the non-convergent path, empty when
    // converged (fail-closed: report).
    let converged = install_converged(resolved.as_deref(), latest);
    let nonblocking_episode_keys = if converged {
        Vec::new()
    } else {
        non_convergent_episode_markers()
    };
    // Close the lane ambiguity and gate the durable block on a drivable aim: name
    // the resolution lane of the executed `hq`, whether HQ aimed THIS run at that
    // copy in place (with its own npm), and whether the aimed prefix exposes its
    // `hq` shim after delivery. All three ride the closed-token contract — never a
    // raw path — and a ForeignManaged verdict now writes the durable marker only
    // when HQ either aimed at the executed copy or genuinely could not.
    let hq_bin_lane = paths::resolution_source_of_bin(&post_install_hq);
    let executed_copy_aim = executed_copy_aim_for(
        &post_install_hq,
        prefix,
        installer_npm,
        &managed_roots,
        paths::home_dir().as_deref(),
    );
    let delivered_prefix_shim = delivered_prefix_shim_for(prefix, delivered_version.as_deref());
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            before_bin,
            &post_install_hq,
            before_version,
            resolved.as_deref(),
            latest,
            prefix,
            installer_npm,
            already_blocked,
            delivered_version.as_deref(),
        )
        .with_managed_roots(&managed_roots)
        .with_nonblocking_episode_keys(&nonblocking_episode_keys)
        .with_executed_copy_aim(executed_copy_aim)
        .with_resolution_telemetry(hq_bin_lane, delivered_prefix_shim),
    );

    // Managed shadow: HQ owns BOTH copies (on Windows, `<root>\npm-prefix` was
    // written but `<root>\node\hq.cmd` still wins). Remove HQ's own stale copy and
    // re-decide against what the app now executes, instead of wedging auto-update
    // for a layout HQ can actually repair. Only reachable with a passed prefix —
    // the npm arm never classifies a shadow without one.
    if outcome.non_convergence_kind == Some(NonConvergenceKind::ManagedShadowed) {
        if let Some(prefix) = prefix {
            return repair_managed_shadow_and_refinalize(
                app,
                before_bin,
                installer_npm,
                before_version,
                latest,
                prefix,
                already_blocked,
                &managed_roots,
                &post_install_hq,
            )
            .await;
        }
    }

    log("hq-cli-update", &outcome.log_line);
    let result = apply_post_install_with_app(app, &outcome);
    // Persist the non-blocking episode key AFTER the capture (its OWN menubar key,
    // never the durable blocking marker), so a persistent installer-unaimed or
    // resolution-shortfall shape reports once per `latest` instead of on every
    // check. Best-effort and never gates the capture (fail-loud): a failed write
    // simply means the next occurrence reports again.
    if let Some(key) = outcome.record_nonblocking_episode.as_deref() {
        let existing = non_convergent_episode_markers();
        let updated = non_convergent_episode_record(&existing, key, latest);
        if let Err(error) = record_non_convergent_episode_markers(&updated) {
            log(
                "hq-cli-update",
                &format!("could not persist non-convergent episode markers: {error}"),
            );
        }
    }
    result
}

/// Map the removal action plus the post-removal convergence into the decision's
/// repair outcome. A removal that converges is a success; anything else — a
/// removal that ran but did not converge, an unlink error, or a
/// provenance-refused gate — degrades to the bounded foreign-managed capture with
/// the reason attached, so the durable marker is written only when HQ genuinely
/// could not fix the machine. Pure so the non-fatal mapping is unit-testable.
fn managed_shadow_repair_outcome(
    action: ManagedShadowRepairAction,
    converged: bool,
) -> ManagedShadowRepairOutcome {
    match action {
        ManagedShadowRepairAction::Removed if converged => ManagedShadowRepairOutcome::Converged,
        ManagedShadowRepairAction::Removed | ManagedShadowRepairAction::RemovalFailed => {
            ManagedShadowRepairOutcome::RepairFailed
        }
        ManagedShadowRepairAction::ProvenanceRefused => {
            ManagedShadowRepairOutcome::ProvenanceRefused
        }
    }
}

/// Remove HQ's own shadow copy of the CLI, re-resolve the binary the app now
/// executes, and route the result back through `decide_post_install` with the
/// repair outcome attached. A converged repair clears the marker and emits
/// `hq-cli-update:cleared` exactly like a normal success; a repair that could not
/// converge degrades to the bounded foreign-managed capture plus the durable
/// marker, tagged with why. Filesystem-only and non-fatal — a removal failure
/// never errors the install command, it just downgrades the outcome.
#[allow(clippy::too_many_arguments)]
async fn repair_managed_shadow_and_refinalize(
    app: &AppHandle,
    before_bin: &str,
    installer_npm: &str,
    before_version: Option<&str>,
    latest: &str,
    prefix: &str,
    already_blocked: bool,
    managed_roots: &[PathBuf],
    shadow_bin: &str,
) -> Result<HqCliUpdateInfo, String> {
    let action = {
        let shadow = shadow_bin.to_string();
        let prefix_owned = prefix.to_string();
        let latest_owned = latest.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            repair_managed_shadow(Path::new(&shadow), Path::new(&prefix_owned), &latest_owned)
        })
        .await
        .unwrap_or(ManagedShadowRepairAction::RemovalFailed)
    };
    log(
        "hq-cli-update",
        &format!(
            "managed-shadow repair: action={action:?} shadow_bin={}",
            redact_home(shadow_bin)
        ),
    );

    // Re-resolve the binary the app now executes after the removal.
    let post_install_hq = paths::resolve_bin("hq");
    let resolved = {
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    let delivered_version = {
        let prefix_owned = prefix.to_string();
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || {
            installed_hq_cli_version_in_prefix(&prefix_owned, &hq)
        })
        .await
        .ok()
        .flatten()
    };

    let repair_outcome =
        managed_shadow_repair_outcome(action, install_converged(resolved.as_deref(), latest));

    let outcome = decide_post_install(
        &PostInstallContext::npm(
            before_bin,
            &post_install_hq,
            before_version,
            resolved.as_deref(),
            latest,
            Some(prefix),
            installer_npm,
            already_blocked,
            delivered_version.as_deref(),
        )
        .with_managed_roots(managed_roots)
        .with_managed_shadow_repair(repair_outcome),
    );
    log("hq-cli-update", &outcome.log_line);
    apply_post_install_with_app(app, &outcome)
}

/// Apply the caller-side persistence half of a repeat-guarded install-failure
/// report. Extracted so the first attempt and the managed retry share one
/// fail-closed marker-write path.
fn persist_reported_episode(outcome: InstallFailureEpisode) {
    match outcome {
        InstallFailureEpisode::Reported {
            persist_keys: Some(keys),
        } => {
            if let Err(e) = record_install_failure_episode_markers(&keys) {
                log(
                    "hq-cli-update",
                    &format!("could not persist install-failure episode markers: {e}"),
                );
            }
        }
        InstallFailureEpisode::SuppressedRepeat => {
            log(
                "hq-cli-update",
                "install-failure episode already reported for this (version, package, cause); not re-paging",
            );
        }
        InstallFailureEpisode::Reported { persist_keys: None }
        | InstallFailureEpisode::NotReportable => {}
    }
}

/// Resolve, for the one-shot managed-toolchain retry: HQ's managed npm, a child
/// PATH that puts the managed Node bin directory first, and the managed npm
/// PREFIX the retry installs INTO (never the user's own prefix). Returns `None`
/// when no managed root is known or the managed npm is not present on disk (in
/// which case the caller reports the original failure rather than retrying into a
/// toolchain that is not actually there). Only the closed enum / path helpers are
/// used here; no managed-node URL or installer is referenced. The prefix comes
/// from the SHARED `paths::managed_npm_prefix_in`, the same definition the
/// first-run dependency installer uses, so the two can never target different
/// directories.
/// Whether `resolve_bin("npm")` found nothing and handed back the bare name.
///
/// `resolve_bin` returns the name itself as its unresolved marker (so
/// `Command::new` still errors readably), which means "npm" with no path
/// separator is exactly the not-found signal.
fn npm_unresolved(npm: &str) -> bool {
    Path::new(npm).components().count() <= 1
}

/// One-shot managed-Node provision + re-probe for a resolved-but-unreadable CLI.
///
/// The core version probe already retries through a managed Node that is
/// *present* (`hq_version_with_recovery`). This closes the other half: when the
/// interpreter is undiscoverable AND HQ's managed Node is not provisioned (or is
/// incomplete), ask the EXISTING provisioner for one — bounded to a single
/// attempt by `repair_managed_node`'s own cooldown — then re-probe exactly once.
/// Never a loop, never a second installer. The caller reports only if recovery
/// still cannot read a version.
async fn recover_unreadable_version_once(
    app: &AppHandle,
    mut probed: LocalVersionProbeResult,
) -> LocalVersionProbeResult {
    // Provision ONLY for an undiscoverable interpreter. A CLI that is present
    // but genuinely broken — a real nonzero exit, empty or invalid output — is
    // not an interpreter problem Node can repair. The core probe marks exactly
    // the recoverable-but-no-managed-Node case `ManagedNodeAbsent`; every other
    // unreadable outcome stays `NotNeeded`/`StillUnreadable`, so this never
    // downloads Node for a native or otherwise broken `hq`.
    if probed.probes.interpreter_recovery != InterpreterRecovery::ManagedNodeAbsent {
        return probed;
    }
    // And only when HQ owns the gap: a managed Node that was never installed or
    // is incomplete. (`ManagedNodeAbsent` also covers PresentMissingNpx and
    // Unknown, which are not cleanly provisionable, so gate on the two states
    // the provisioner can actually repair.)
    match classify_runtime() {
        ManagedRuntime::NotProvisioned | ManagedRuntime::Incomplete { .. } => {}
        _ => return probed,
    }

    match request_managed_node_repair(app).await {
        ToolchainRepair::Repaired => {}
        ToolchainRepair::Skipped => {
            log(
                "hq-cli-update",
                "unreadable version: managed-Node provisioning skipped (repair cooldown)",
            );
            probed.probes.interpreter_recovery = InterpreterRecovery::ProvisionSkippedCooldown;
            return probed;
        }
        ToolchainRepair::Failed(reason) => {
            log(
                "hq-cli-update",
                &format!("unreadable version: managed-Node provisioning failed: {reason}"),
            );
            probed.probes.interpreter_recovery = InterpreterRecovery::ProvisionFailed;
            return probed;
        }
    }

    // Re-probe exactly once. The core probe now sees a present managed Node and
    // recovers through it; if it still cannot read a version, report that.
    let mut reprobed = get_local_version_diagnostics();
    reprobed.probes.interpreter_recovery = if reprobed.local.is_some() {
        InterpreterRecovery::RecoveredWithManagedNode
    } else {
        InterpreterRecovery::StillUnreadable
    };
    reprobed
}

/// The ONE call into the managed-Node provisioning seam for this module.
///
/// Both consumers — the first-install path below and `managed_toolchain_retry`
/// — go through here, so the module keeps exactly one provisioning point rather
/// than growing a second installer per caller. `repair_managed_node` carries the
/// repair cooldown itself, which is also what bounds the two paths if they ever
/// meet in one invocation: a first install that provisions and then still fails
/// finds the retry's own request Skipped, so at most one provision actually
/// happens per run.
async fn request_managed_node_repair(app: &AppHandle) -> ToolchainRepair {
    crate::commands::sync::repair_managed_node(app).await
}

/// Provision HQ's managed Node so a first install has an npm to run — and one
/// whose runtime matches the managed prefix the first install is aimed at.
///
/// Used on the first-install path whenever the resolved npm is not already HQ's
/// managed npm (it has none, or only a user npm whose default prefix HQ never
/// searches). Returns the managed `(npm, PATH)` pair on success, or `None` when
/// provisioning is on cooldown or fails — in which case the caller proceeds with
/// the original npm and surfaces the ordinary spawn failure, exactly as before.
async fn provision_managed_npm_for_first_install(app: &AppHandle) -> Option<(String, String)> {
    log(
        "hq-cli-update",
        "first install with no npm on PATH — provisioning HQ's managed Node first",
    );
    match request_managed_node_repair(app).await {
        ToolchainRepair::Repaired => {}
        ToolchainRepair::Skipped => {
            log(
                "hq-cli-update",
                "managed Node provisioning skipped — a repair was attempted too recently",
            );
            return None;
        }
        ToolchainRepair::Failed(reason) => {
            log(
                "hq-cli-update",
                &format!("managed Node provisioning failed: {reason}"),
            );
            return None;
        }
    }
    let (managed_npm, managed_path, _prefix) = managed_toolchain_npm_and_path()?;
    log(
        "hq-cli-update",
        "managed Node provisioned — running the first install under it",
    );
    Some((managed_npm, managed_path))
}

fn managed_toolchain_npm_and_path() -> Option<(String, String, String)> {
    let root = paths::managed_toolchain_roots().into_iter().next()?;
    let node_exe = paths::managed_node_executable_in(&root);
    let bin_dir = node_exe.parent()?.to_path_buf();
    let npm_name = if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    };
    let managed_npm = bin_dir.join(npm_name);
    // A usable managed toolchain needs BOTH the managed npm AND the managed Node it
    // must run under — not npm alone. An incomplete provision can leave npm behind
    // without node (e.g. a Failed fresh provision that got partway), and the managed
    // PATH puts this bin dir FIRST but then falls through to the user's Node: running
    // that npm would build native dependencies for the USER's ABI inside the managed
    // prefix, pass convergence under the user's Node, and persist the managed prefix
    // to the shell — only to break once the managed Node is later repaired to a
    // different ABI. Require the node executable too, so a "managed" retry is always
    // genuinely managed (HQ-DESKTOP-5E review follow-up).
    if !managed_npm.exists() || !node_exe.exists() {
        return None;
    }
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let path = format!("{}{}{}", bin_dir.display(), sep, paths::child_path());
    let managed_prefix = paths::managed_npm_prefix_in(&root)
        .to_string_lossy()
        .to_string();
    Some((
        managed_npm.to_string_lossy().to_string(),
        path,
        managed_prefix,
    ))
}

/// The after-version the managed-retry convergence decision should use: the
/// EXECUTED version only when the resolved binary lives inside the managed prefix
/// (condition b), else `None` so `decide_post_install` is non-convergent. A `None`
/// executed version (condition c: the shim could not start) is likewise
/// non-convergent. Pure so both conditions are unit-testable without an install.
fn managed_retry_after_version<'a>(
    resolves_in_managed_prefix: bool,
    executed_version: Option<&'a str>,
) -> Option<&'a str> {
    if resolves_in_managed_prefix {
        executed_version
    } else {
        None
    }
}

/// Convergence gate for the managed-toolchain retry, with ABI/runtime evidence a
/// version-only check cannot provide (the P1 the automated review raised). A
/// managed retry counts as converged only when ALL THREE hold:
///   (a) the version npm delivered INTO the managed prefix reaches `latest`;
///   (b) the `hq` the app now RESOLVES lives inside the managed prefix — the copy
///       just written, not a stale user-path shim resolved ahead of it;
///   (c) that binary actually STARTS under the app's child PATH and reports a
///       version — an EXECUTION probe (never a package.json read), proving the
///       managed shim's `env node` selects a runtime that can run the CLI.
///
/// Anything short routes through the SHARED non-convergent path (`decide_post_install`
/// → marker + report), never a "healed" success: the executed version is fed as the
/// decision's after-version (so a shim that reads a fresh package.json but cannot
/// start is still non-convergent), gated on (b) (so a latest-but-outside-prefix
/// resolution is non-convergent too). `delivered_version` carries (a) for the
/// decision's own delivery evidence.
async fn managed_retry_converged(
    app: &AppHandle,
    before_bin: &str,
    installer_npm: &str,
    managed_prefix: &str,
    before_version: Option<&str>,
    latest: &str,
    already_blocked: bool,
) -> Result<HqCliUpdateInfo, String> {
    let post_install_hq = paths::resolve_bin("hq");

    // (b) The binary the app will EXECUTE must be the one just written INTO the
    // managed prefix.
    let resolves_in_managed_prefix = Path::new(&post_install_hq).starts_with(managed_prefix);

    // (c) EXECUTION probe: `hq_version_string` spawns the binary under the app's
    // child PATH, never reading a package.json. A shim that cannot start (ABI
    // mismatch, missing runtime) yields `None` and is non-convergent below.
    let executed_version = {
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || hq_version_string(Path::new(&hq)))
            .await
            .ok()
            .flatten()
    };

    // (a) Delivery evidence: the version npm actually wrote into the managed
    // prefix's manifest.
    let delivered_version = {
        let prefix = managed_prefix.to_string();
        let hq = post_install_hq.clone();
        tauri::async_runtime::spawn_blocking(move || {
            installed_hq_cli_version_in_prefix(&prefix, &hq)
        })
        .await
        .ok()
        .flatten()
    };

    // Convergence requires (b) AND (c): feed the EXECUTED version as the decision's
    // after-version, but only when the resolved binary lives in the managed prefix;
    // otherwise force `None` so `decide_post_install` is non-convergent. Record the
    // ABI provenance so a future divergence is observable rather than silent.
    log(
        "hq-cli-update",
        &format!(
            "managed retry convergence: resolved_in_managed_prefix={resolves_in_managed_prefix} \
             executed_version_present={} delivered_version_present={}",
            executed_version.is_some(),
            delivered_version.is_some()
        ),
    );
    let after_version =
        managed_retry_after_version(resolves_in_managed_prefix, executed_version.as_deref());
    // Thread the managed roots so a same-root shadow here is classified as such
    // (no durable marker, bounded capture) rather than misread as foreign-managed
    // and wedged; the next scheduled `finalize_convergence` self-repairs it.
    let managed_roots = paths::managed_toolchain_roots();
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            before_bin,
            &post_install_hq,
            before_version,
            after_version,
            latest,
            Some(managed_prefix),
            installer_npm,
            already_blocked,
            delivered_version.as_deref(),
        )
        .with_managed_roots(&managed_roots),
    );
    // A managed shadow reached from the retry is repairable exactly as it is from
    // the ordinary path: remove HQ's own stale copy and re-decide, so a successful
    // retry is not returned to the user as an error until a later install, and the
    // pre-repair event is never captured unbounded across manual retries.
    if outcome.non_convergence_kind == Some(NonConvergenceKind::ManagedShadowed) {
        return repair_managed_shadow_and_refinalize(
            app,
            before_bin,
            installer_npm,
            before_version,
            latest,
            managed_prefix,
            already_blocked,
            &managed_roots,
            &post_install_hq,
        )
        .await;
    }
    log("hq-cli-update", &outcome.log_line);
    apply_post_install_with_app(app, &outcome)
}

/// User-facing detail for a managed-toolchain retry that itself FAILED. Unlike the
/// user-path builder (`install_failure_detail_with_final_attempt`, deliberately
/// left untouched), this must never advise installing Node 22 or blame the user's
/// runtime: HQ already retried under its OWN managed Node, so that advice cannot
/// change the runtime or ABI. Provenance-aware wording, plus a copyable-command
/// escape hatch and a support-facing next step.
fn managed_retry_failure_detail(
    exit_code: Option<i32>,
    raw_detail: &str,
    prefix: Option<&str>,
) -> String {
    // If the managed retry ALSO hit a missing install target (HQ-DESKTOP-5K) — npm
    // could not create even HQ's own managed install folder, e.g. a broken/offline
    // filesystem — the failure is NOT a dependency build, so never tell the user a
    // build failed or that changing Node cannot help. Give the missing-folder copy.
    if is_missing_global_install_target(raw_detail, prefix) {
        return "HQ retried this update under its own managed toolchain, but npm's install folder still could not be created on this computer. Run the copied command in a terminal to finish the update; if that folder lives on a network or removed drive, reconnect it first.".to_string();
    }
    let lead = "HQ retried this update under its own managed Node and the dependency build still failed. Because that retry already used a supported Node, installing a different Node version will not change the result.";
    let trimmed = raw_detail.trim();
    if trimmed.is_empty() {
        let status = exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal/none".to_string());
        format!(
            "{lead} Run the copied command in a terminal to see the full build output, or contact HQ support with it. (npm exited with status {status}.)"
        )
    } else {
        format!(
            "{lead} Run the copied command in a terminal to see the full build output, or share it with HQ support.\n\n{trimmed}"
        )
    }
}

/// Make HQ's managed npm bin dir reachable from the user's interactive shell so a
/// terminal `hq` resolves the copy HQ just installed. Called ONLY after the managed
/// retry has CONVERGED. Deferring the persistent PATH change until convergence is a
/// correctness requirement, not a nicety: on a Mac without the profile marker,
/// prepending the managed Node 22 bin dir before a SUCCESSFUL managed CLI install
/// would make the user's still-working Node-20 `hq` shim resolve managed Node via
/// `#!/usr/bin/env node` and fail with an ABI mismatch — turning a working terminal
/// CLI into a broken one on a failed repair. Idempotent, marker-guarded and
/// append-only; a run whose PATH is already configured is a no-op.
fn configure_managed_shell_path(app: &AppHandle, managed_prefix: &str) {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = managed_prefix;
        if let Some(home) = paths::home_dir() {
            crate::commands::install_deps::ensure_shell_path_configured(&home, app);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        if let Err(e) =
            crate::commands::install_deps::append_user_path(std::path::Path::new(managed_prefix))
        {
            log(
                "hq-cli-update",
                &format!("managed-toolchain retry could not update the user PATH: {e}"),
            );
        }
    }
}

/// The disposition of a single, bounded managed-toolchain self-heal attempt,
/// communicated back to the caller so the reported user-path failure can name why
/// the retry did or did not run (HQ-DESKTOP-4V / 4W / 5E).
enum ManagedRetryAttempt {
    /// HQ's managed toolchain was used and the pinned install converged (delivery +
    /// managed-prefix resolution + a live executable probe); NO Sentry event was
    /// emitted — the self-heal worked.
    Converged(HqCliUpdateInfo),
    /// The retry RAN under HQ's managed toolchain but did not converge; it already
    /// reported exactly once (managed-provenance failure, or non-convergence), with
    /// provenance-aware wording that never re-blames the user's runtime. The caller
    /// surfaces this detail without a second capture.
    RanAndReported(String),
    /// No retry ran. The caller reports the original user-path failure, tagging this
    /// closed-enumeration outcome so the next occurrence names which branch declined.
    Declined(ManagedRetryOutcome),
}

/// Bounded, one-shot managed-toolchain self-heal for a third-party native-build
/// lifecycle failure under the user's own Node (HQ-DESKTOP-4V / 4W / 5E).
///
/// Provisioning goes through the shared `sync::repair_managed_node` seam — never
/// the lower-level Node installer directly — so the shared repair cooldown and the
/// single installer are preserved (the same contract HQ-DESKTOP-49 locked for the
/// Connect lane). The retry installs into HQ's OWN managed npm prefix (never the
/// user's), reusing the already-pinned `latest` — never `fetch_latest` again, so the
/// post-publish registry race commit 13ef8859 closed cannot reopen here. Exactly one
/// provision attempt and one re-run: there is no loop.
///
/// The HQ-DESKTOP-5E fix lives in the START decision. `repair_managed_node` reports
/// whether a FRESH provision happened, NOT whether a managed toolchain EXISTS: its
/// slot is a process-global single-flight shared with the sync/daemon/Connect lanes,
/// so a cooldown `Skipped` or a `Failed` disposition can occur on a machine that
/// already has HQ's managed Node installed and usable. The old code returned "no
/// retry" on `Skipped`/`Failed` before ever consulting the managed npm — abandoning
/// the one-shot retry, then blaming the user's toolchain in the UI for a repair it
/// never attempted. [`managed_retry_start_decision`] (pure, in hq-desktop-core,
/// tested on every platform) now PROCEEDS whenever a managed npm resolves, regardless
/// of the disposition, and declines only when none is resolvable — naming which
/// disposition left it absent.
async fn managed_toolchain_retry(
    app: &AppHandle,
    hq: &str,
    latest: &str,
    npm_cache: &Path,
    before_version: Option<&str>,
    already_blocked: bool,
) -> ManagedRetryAttempt {
    // Provision through the shared seam, then reduce its outcome to the disposition
    // the START decision turns on. A Failed provision still logs its reason (used
    // nowhere else) before being collapsed.
    let disposition = match request_managed_node_repair(app).await {
        ToolchainRepair::Repaired => ManagedRepairDisposition::Repaired,
        ToolchainRepair::Skipped => ManagedRepairDisposition::Deferred,
        ToolchainRepair::Failed(reason) => {
            log(
                "hq-cli-update",
                &format!("managed-toolchain retry: a fresh Node provision failed: {reason}"),
            );
            ManagedRepairDisposition::Failed
        }
    };

    // Consult the managed npm REGARDLESS of the disposition — a cooldown deferral or
    // a failed fresh provision is not evidence the managed toolchain is absent
    // (`install_node_macos` is idempotent and returns Ok when it already exists). The
    // pure decision proceeds whenever a managed npm resolves, and names which
    // disposition left it absent otherwise.
    let (managed_npm, managed_path, managed_prefix) =
        match managed_retry_start_decision(disposition, managed_toolchain_npm_and_path()) {
            ManagedRetryStart::Proceed { npm, path, prefix } => (npm, path, prefix),
            ManagedRetryStart::Decline(outcome) => {
                log(
                    "hq-cli-update",
                    &format!(
                        "managed-toolchain retry declined ({}) — reporting the user-path failure",
                        outcome.tag_value()
                    ),
                );
                return ManagedRetryAttempt::Declined(outcome);
            }
        };

    log(
        "hq-cli-update",
        "managed npm available — retrying the pinned install once under HQ's managed toolchain, into HQ's managed npm prefix",
    );

    // Rebuild the argv against HQ's MANAGED prefix (never the user's), reusing the
    // SAME pinned `latest`. The managed prefix is also handed to the retry ladder so
    // the EEXIST/ENOTEMPTY cleanup scope is confined to the managed tree and can
    // never delete inside the user's own prefix.
    let retry_args = install_argv(Some(managed_prefix.as_str()), Some(latest));
    let retry_run = match run_npm_install_with_retries(
        &managed_npm,
        &managed_path,
        npm_cache,
        Some(managed_prefix.as_str()),
        retry_args,
    )
    .await
    {
        Ok(run) => run,
        Err(e) => {
            log(
                "hq-cli-update",
                &format!("managed-toolchain retry could not spawn npm: {e}"),
            );
            return ManagedRetryAttempt::Declined(ManagedRetryOutcome::SpawnFailed);
        }
    };

    if retry_run.output.status.success() {
        // Judge convergence with ABI/runtime evidence, not version alone: the
        // installed binary must resolve INSIDE the managed prefix AND actually start
        // under the app's child PATH. Anything short routes through the shared
        // non-convergent path, never a "healed" success.
        let converged = managed_retry_converged(
            app,
            hq,
            &managed_npm,
            &managed_prefix,
            before_version,
            latest,
            already_blocked,
        )
        .await;
        return match converged {
            Ok(info) => {
                // Only NOW — with a managed CLI proven installed AND runnable — make
                // its bin dir reachable from the user's interactive shell. Deferring
                // the persistent PATH change until convergence means a FAILED retry
                // never shadows the user's still-working CLI under a mismatched Node.
                configure_managed_shell_path(app, &managed_prefix);
                ManagedRetryAttempt::Converged(info)
            }
            // Ran under the managed toolchain but did not converge; the non-convergent
            // path already reported exactly once.
            Err(detail) => ManagedRetryAttempt::RanAndReported(detail),
        };
    }

    // The retry failed under the managed toolchain. Report exactly once, carrying
    // managed provenance (npm_managed_toolchain_retry=true, toolchain_source=managed,
    // npm_managed_retry_outcome=ran) through the same repeat-guard, with
    // provenance-aware user-facing wording that never re-blames the user's own
    // runtime.
    let raw_detail = npm_output_detail(&retry_run.output);
    let detail = managed_retry_failure_detail(
        retry_run.output.status.code(),
        &raw_detail,
        Some(managed_prefix.as_str()),
    );
    log(
        "hq-cli-update",
        &format!(
            "managed-toolchain retry failed (exit {:?}); raw npm output retained locally: {raw_detail}",
            retry_run.output.status.code()
        ),
    );
    let mut install_env = probe_install_environment(
        &managed_npm,
        &managed_path,
        /* managed_toolchain_retry */ true,
    )
    .await;
    // Carry the managed retry's OWN mkdir diagnostic (HQ-DESKTOP-5K) onto this
    // managed-provenance event too, so `npm_missing_target_state` is not lost when
    // the managed attempt itself ran the mkdir rung and still failed.
    install_env.missing_target_state = retry_run.missing_target_state;
    // Carry the same pinned-version attribution onto the managed-provenance event
    // (HQ-DESKTOP-5Q): the retry installs the SAME resolved `latest`, pinned. Tag
    // only, never a grouping component.
    install_env = install_env.with_pinned_target_version(latest);
    let reported_episode_keys = install_failure_episode_markers();
    persist_reported_episode(report_install_failure_episode(
        retry_run.output.status.code(),
        &raw_detail,
        Some(managed_prefix.as_str()),
        retry_run.final_attempt_forced,
        &install_env,
        latest,
        &reported_episode_keys,
    ));
    ManagedRetryAttempt::RanAndReported(detail)
}

/// Persist the `latest` that installed cleanly but did not move the detected
/// version, so `setup_hq_cli_update_checker` stops auto-retrying it. Written
/// through the untyped-merge path for the same reason as the dismissal flag:
/// `save_settings` only writes typed `MenubarPrefs` fields and would drop it.
/// The caller must observe the failure before emitting a foreign-managed
/// capture. Otherwise an unwritable config directory converts every scheduled
/// retry into another apparent first episode.
fn record_non_convergent_version(latest: &str) -> Result<(), String> {
    paths::menubar_json_path()
        .and_then(|path| {
            hq_desktop_core::first_run::merge_menubar_flags(
                &path,
                // Stamp the pinned-contract tag beside the version. Its presence
                // marks this block as backed by delivery evidence, so it persists
                // permanently and is never given the legacy one-shot re-attempt.
                &[
                    (
                        NON_CONVERGENT_VERSION_KEY,
                        Value::String(latest.to_string()),
                    ),
                    (
                        NON_CONVERGENT_CONTRACT_KEY,
                        Value::String(PINNED_MARKER_CONTRACT.to_string()),
                    ),
                ],
            )
        })
        .map_err(|error| error.to_string())
}

/// Clear the non-convergent marker after an install that actually converged.
/// Both the version and the contract tag are cleared so no stale contract key
/// survives to mislabel a later marker.
fn clear_non_convergent_version() {
    if non_convergent_cli_version().is_none() && non_convergent_cli_contract().is_none() {
        return;
    }
    let write = paths::menubar_json_path().and_then(|path| {
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[
                (NON_CONVERGENT_VERSION_KEY, Value::Null),
                (NON_CONVERGENT_CONTRACT_KEY, Value::Null),
            ],
        )
    });
    if let Err(e) = write {
        log(
            "hq-cli-update",
            &format!("could not clear non-convergent marker: {e}"),
        );
    }
}

/// Background loop: first check 15s after launch, then every 6h.
/// Mirrors `updater::setup_update_checker`. Logs but does not propagate
/// errors — a flaky network shouldn't kill the loop.
///
/// When a check reports an update **and** `cliAutoUpdate` is on (default),
/// the loop installs it directly. The install never prompts for sudo — it
/// just fails `EACCES` on a system prefix — so "auto-install when safe" is
/// simply attempt + classify: success self-clears the banner via
/// `hq-cli-update:cleared`; any failure leaves the clickable banner that
/// `check_once` already emitted and Sentry-captures for triage. No fragile
/// prefix-guessing heuristic.
/// Heal a machine already wedged by HQ-DESKTOP-46: it carries the durable marker
/// `nonConvergentCliVersion == latest` written by the OLD foreign-managed
/// classification, so `should_auto_install` blocks the install and the
/// install-time repair can never run — auto-update stays disabled until the next
/// CLI publish or a manual click. This runs the filesystem-only shadow removal
/// DIRECTLY (no install), and ONLY when the resolved `hq` is a provable same-root
/// managed shadow and the managed prefix already holds `>= latest`. On convergence
/// it clears the marker and returns the healed info; otherwise it touches nothing.
/// Sync so the caller runs it off the async runtime.
/// The managed npm prefix for the root that owns a resolved shadow: the SAME
/// managed root must contain both the shadow's prefix and the npm prefix, and
/// they must differ. Pure so the same-root selection is unit-testable without
/// touching the machine's real toolchain. `None` when the resolved copy is not a
/// same-root managed shadow (a foreign layout, or already the prefix copy).
fn managed_prefix_for_shadow(active_prefix: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let active = Path::new(active_prefix);
    roots.iter().find_map(|root| {
        let prefix = paths::managed_npm_prefix_in(root);
        // "Same directory" is compared by components (case-insensitive on Windows)
        // via mutual containment, so a case-only difference cannot masquerade as a
        // distinct shadow.
        let same_dir =
            paths::path_is_within(active, &prefix) && paths::path_is_within(&prefix, active);
        (paths::path_is_within(active, root)
            && paths::path_is_within(&prefix, root)
            && !same_dir)
            .then_some(prefix)
    })
}

fn heal_blocked_managed_shadow(latest: &str) -> Option<HqCliUpdateInfo> {
    let resolved = paths::resolve_bin("hq");
    let active_prefix = npm_prefix_from_hq_bin(&resolved)?;
    // The managed prefix for the root that owns the resolved shadow — the same
    // same-root containment the install-time classifier uses.
    let managed_prefix =
        managed_prefix_for_shadow(&active_prefix, &paths::managed_toolchain_roots())?;
    // The managed prefix must already hold >= latest — the same delivery evidence
    // the classifier requires before treating this as a repairable shadow.
    let delivered =
        installed_hq_cli_version_in_prefix(&managed_prefix.to_string_lossy(), &resolved)?;
    if cmp_semver(&delivered, latest) == std::cmp::Ordering::Less {
        return None;
    }
    if repair_managed_shadow(Path::new(&resolved), &managed_prefix, latest)
        != ManagedShadowRepairAction::Removed
    {
        return None;
    }
    // Re-resolve and clear the marker ONLY when the app now executes >= latest.
    let after = paths::resolve_bin("hq");
    let after_version = resolved_hq_version(&after);
    if !install_converged(after_version.as_deref(), latest) {
        return None;
    }
    clear_non_convergent_version();
    Some(HqCliUpdateInfo {
        local: after_version,
        latest: latest.to_string(),
    })
}

pub fn setup_hq_cli_update_checker(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // One-time un-wedge for machines blocked by the pre-pin dist-tag race. A
        // non-convergent marker written before the pinned-install contract has no
        // contract tag; it may have been recorded when a transient registry lag
        // installed N-1 and then permanently disabled auto-install of N. Clear
        // such a legacy marker ONCE so the next check re-installs under the pinned
        // contract. A genuinely stuck layout then re-writes the marker WITH the
        // pinned tag (delivery-backed), which blocks permanently and is never
        // cleared again — so this cannot reopen the endless-reinstall loop.
        if legacy_marker_needs_recovery(
            non_convergent_cli_contract().as_deref(),
            non_convergent_cli_version().as_deref(),
        ) {
            log(
                "hq-cli-update",
                "clearing a legacy (pre-pin) non-convergent marker for one recovery re-attempt",
            );
            clear_non_convergent_version();
        }
        // Version floor: a readable installed version below HQ_CLI_MIN_VERSION
        // is repaired NOW rather than after the launch stagger. The probe is
        // network-free (anchored package.json / `hq --version`) and runs off
        // the async runtime.
        let launch = tauri::async_runtime::spawn_blocking(|| {
            launch_cli_check(get_local_version().as_deref())
        })
        .await
        .unwrap_or_else(|error| {
            log(
                "hq-cli-update",
                &format!("launch floor probe task failed; keeping the scheduled cadence: {error}"),
            );
            LaunchCliCheck::Scheduled
        });
        if let LaunchCliCheck::RepairNow { local } = launch {
            log(
                "hq-cli-update",
                &format!(
                    "installed hq CLI {local} is below the required minimum \
                     {HQ_CLI_MIN_VERSION}; checking and installing now instead of \
                     waiting {}s for the launch stagger",
                    INITIAL_DELAY.as_secs()
                ),
            );
            run_check_cycle(&handle, /* floor_repair */ true).await;
        }
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            run_check_cycle(&handle, /* floor_repair */ false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// One background check, plus the install it calls for. `floor_repair` marks
/// the launch-time pass taken because the installed CLI read below
/// [`HQ_CLI_MIN_VERSION`]; it is the only pass allowed to install past the
/// user's `autoUpdate` opt-out (see [`auto_install_allowed`]).
async fn run_check_cycle(handle: &AppHandle, floor_repair: bool) {
    match check_once(handle).await {
        Ok(Some(info)) => {
            // Gate on the master `autoUpdate` switch (default ON). The
            // legacy `cliAutoUpdate` key is superseded — one toggle now
            // governs the app, CLI, and core auto-installers. A floor
            // repair is exempt: below the floor the CLI cannot serve the
            // hq-core contract, so it is repaired like a missing one.
            let auto_update = auto_update_enabled();
            if auto_install_allowed(auto_update, floor_repair) {
                if floor_repair && !auto_update {
                    log(
                        "hq-cli-update",
                        &format!(
                            "autoUpdate is off, but installed hq CLI {} is below the \
                             required minimum {HQ_CLI_MIN_VERSION}; repairing anyway",
                            info.local.as_deref().unwrap_or("(unreadable)")
                        ),
                    );
                }
                if should_auto_install(&info.latest, non_convergent_cli_version().as_deref()) {
                    log("hq-cli-update", "auto-update enabled — installing");
                    match install_hq_cli_update(handle.clone()).await {
                        Ok(_) => log("hq-cli-update", "auto-update succeeded"),
                        Err(e) => log(
                            "hq-cli-update",
                            &format!("auto-update failed, banner remains: {e}"),
                        ),
                    }
                } else {
                    // The durable marker blocks the install. A machine
                    // already wedged by HQ-DESKTOP-46 carries that marker
                    // from the OLD foreign-managed classification, so the
                    // install-time repair can never run. Attempt the
                    // filesystem-only shadow heal directly; on success it
                    // clears the marker and re-enables auto-update without
                    // waiting for the next CLI publish. Anything that is
                    // not a provable same-root shadow is left untouched and
                    // the banner stays up for the manual fix.
                    let latest = info.latest.clone();
                    let healed = tauri::async_runtime::spawn_blocking(move || {
                        heal_blocked_managed_shadow(&latest)
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some(healed) = healed {
                        let _ = handle.emit("hq-cli-update:cleared", &healed);
                        log(
                            "hq-cli-update",
                            "healed a wedged managed-toolchain CLI shadow; \
                             auto-update re-enabled",
                        );
                    } else {
                        // This exact version already installed cleanly
                        // without moving the detected CLI, so repeating it
                        // cannot help. Stop here instead of reinstalling on
                        // every launch and every 6h; the banner stays up
                        // for the manual fix.
                        log(
                            "hq-cli-update",
                            &format!(
                                "auto-update skipped for {}: an earlier install completed \
                                 without changing the detected version",
                                info.latest
                            ),
                        );
                    }
                }
            }
        }
        Ok(None) => {}
        Err(e) => log("hq-cli-update", &format!("background check failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::ffi::{OsStr, OsString};
    #[cfg(unix)]
    use std::sync::{Mutex, OnceLock};

    // Serialize HOME mutation against every other test that reads or writes
    // the process-global HOME (launch.rs reveal-target tests, telemetry) by
    // sharing the crate-wide env mutex — a private lock here does not stop a
    // concurrent `dirs::home_dir()` reader from observing the poisoned home.
    #[cfg(unix)]
    static HOME_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[cfg(unix)]
    struct HomeEnvRestore(Option<OsString>);

    #[cfg(unix)]
    impl Drop for HomeEnvRestore {
        fn drop(&mut self) {
            if let Some(value) = self.0.as_ref() {
                std::env::set_var("HOME", value);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    #[test]
    fn managed_toolchain_retry_is_armed_only_by_a_repairable_user_path_lifecycle_failure() {
        // The reported cluster: a third-party native-build lifecycle failure under
        // the user's OWN Node 20 (ABI 115), for a cause a different runtime can fix.
        // HQ-DESKTOP-4V's cause='unknown' and 4W's cause='toolchain-missing' MUST
        // both arm.
        for cause in [
            "unknown",
            "toolchain-missing",
            "prebuild-unavailable",
            "postinstall-script",
        ] {
            assert!(
                install_failure_earns_managed_retry(
                    InstallFailureKind::UnexpectedLifecycle,
                    NpmToolchainSource::UserPath,
                    cause,
                    Some(115),
                    None,
                ),
                "cause {cause:?} on user-path Node 20 must arm the managed retry"
            );
        }

        // The exact HQ-DESKTOP-5E tuple: node-llama-cpp's postinstall script failing
        // under the user's OWN Node 24.14.0 (ABI 137). Its cause is `postinstall-script`
        // and its failing ABI (137) differs from HQ's managed ABI (127), so the
        // self-heal MUST arm — pinning that the shape which produced this issue is
        // exactly the shape the retry is meant to run for.
        assert!(
            install_failure_earns_managed_retry(
                InstallFailureKind::UnexpectedLifecycle,
                NpmToolchainSource::UserPath,
                "postinstall-script",
                Some(137),
                None,
            ),
            "the reported HQ-DESKTOP-5E tuple (postinstall-script, ABI 137, user-path) must arm the managed retry"
        );

        // A cause a NEW runtime cannot repair must NOT arm — provisioning a Node
        // would only waste a ~50MB download, and a full disk can be made worse.
        for cause in ["disk-space", "network"] {
            assert!(
                !install_failure_earns_managed_retry(
                    InstallFailureKind::UnexpectedLifecycle,
                    NpmToolchainSource::UserPath,
                    cause,
                    Some(115),
                    None,
                ),
                "cause {cause:?} must never arm the managed retry"
            );
        }

        // A run already on HQ's managed ABI (127) gains nothing from provisioning
        // Node 22 again, even for an otherwise-eligible cause.
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::UnexpectedLifecycle,
            NpmToolchainSource::UserPath,
            "unknown",
            Some(MANAGED_NODE_ABI),
            None,
        ));

        // An UNKNOWN ABI (the probe could not read it) is treated as not-managed,
        // so the retry still arms — the reported cluster must never be gated out by
        // a missing ABI probe.
        assert!(install_failure_earns_managed_retry(
            InstallFailureKind::UnexpectedLifecycle,
            NpmToolchainSource::UserPath,
            "unknown",
            None,
            None,
        ));

        // Same failure, but npm already ran under HQ's managed toolchain — a second
        // provision cannot help, so it must NOT retry regardless of cause/ABI.
        for source in [NpmToolchainSource::Managed, NpmToolchainSource::Unknown] {
            assert!(!install_failure_earns_managed_retry(
                InstallFailureKind::UnexpectedLifecycle,
                source,
                "unknown",
                Some(115),
                None,
            ));
        }

        // Every non-lifecycle kind keeps today's behaviour, even under user-path
        // Node with an eligible cause/ABI, so no expected/permission/Windows/
        // registry failure ever triggers a managed provision. `Unexpected` here has
        // no attributed origin (`None`), so it does not arm the reopen shape either.
        for kind in [
            InstallFailureKind::ExpectedPrefixPermission,
            InstallFailureKind::ExpectedWindowsAbort,
            InstallFailureKind::ExpectedWindowsLockedBinary,
            InstallFailureKind::ExpectedTransientRegistry,
            InstallFailureKind::ExpectedBinCollision,
            InstallFailureKind::ExpectedDiskFull,
            InstallFailureKind::Unexpected,
        ] {
            assert!(
                !install_failure_earns_managed_retry(
                    kind,
                    NpmToolchainSource::UserPath,
                    "unknown",
                    Some(115),
                    None,
                ),
                "kind {kind:?} must not arm the managed-toolchain retry"
            );
        }
    }

    #[test]
    fn unsupported_node_arms_the_same_bounded_managed_retry() {
        // HQ-DESKTOP-56: a PATH Node below the CLI's floor is a user-path runtime a
        // managed Node 22 can actually run, so it arms the SAME one-shot retry —
        // and, like the lifecycle shape, only under UserPath with a failing ABI
        // that differs from HQ's managed one. There is no lifecycle cause for this
        // shape, so the cause argument is irrelevant: a present and an empty cause
        // must arm identically.
        for cause in ["", "unknown", "toolchain-missing"] {
            assert!(
                install_failure_earns_managed_retry(
                    InstallFailureKind::UnsupportedNode,
                    NpmToolchainSource::UserPath,
                    cause,
                    Some(48), // the reported Node 6.17.1 ABI
                    None,
                ),
                "unsupported node on user-path Node 6 (ABI 48) must arm, cause {cause:?}"
            );
        }
        // An unknown ABI still arms — never gate the reported cluster out on a
        // missing probe...
        assert!(install_failure_earns_managed_retry(
            InstallFailureKind::UnsupportedNode,
            NpmToolchainSource::UserPath,
            "",
            None,
            None,
        ));
        // ...but a run already on HQ's managed ABI cannot be improved by
        // provisioning it again.
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::UnsupportedNode,
            NpmToolchainSource::UserPath,
            "",
            Some(MANAGED_NODE_ABI),
            None,
        ));
        // And a managed/unknown SOURCE never arms — only the user's own toolchain
        // is worth replacing.
        for source in [NpmToolchainSource::Managed, NpmToolchainSource::Unknown] {
            assert!(!install_failure_earns_managed_retry(
                InstallFailureKind::UnsupportedNode,
                source,
                "",
                Some(48),
                None,
            ));
        }
    }

    #[test]
    fn missing_global_install_target_arms_the_managed_retry_on_any_user_path_abi() {
        // HQ-DESKTOP-5K: a missing npm global install-target directory is a broken
        // PREFIX chain, not a runtime/prebuild fault, so `managed_toolchain_retry` —
        // which installs into HQ's OWN managed prefix — repairs it EVEN at the
        // identical managed ABI. So, unlike the lifecycle/unsupported-node shapes, it
        // arms regardless of the failing ABI; its only runtime condition is UserPath.
        for abi in [Some(MANAGED_NODE_ABI), Some(115), Some(127), None] {
            assert!(
                install_failure_earns_managed_retry(
                    InstallFailureKind::MissingGlobalInstallTarget,
                    NpmToolchainSource::UserPath,
                    "unknown",
                    abi,
                    None,
                ),
                "missing-target under user-path must arm the managed retry at ABI {abi:?}"
            );
        }
        // The `cause` argument is irrelevant for this shape (npm never ran a build),
        // so even a disk-space/network cause still arms — those only gate the
        // lifecycle shape.
        for cause in ["", "disk-space", "network", "toolchain-missing"] {
            assert!(install_failure_earns_managed_retry(
                InstallFailureKind::MissingGlobalInstallTarget,
                NpmToolchainSource::UserPath,
                cause,
                Some(MANAGED_NODE_ABI),
                None,
            ));
        }
        // A managed or unknown SOURCE never arms — only the user's own toolchain is
        // worth replacing.
        for source in [NpmToolchainSource::Managed, NpmToolchainSource::Unknown] {
            assert!(!install_failure_earns_managed_retry(
                InstallFailureKind::MissingGlobalInstallTarget,
                source,
                "unknown",
                Some(115),
                None,
            ));
        }
        // Arming the new shape must NOT relax the lifecycle shape's ABI gate: a
        // lifecycle failure already on HQ's managed ABI still does not arm.
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::UnexpectedLifecycle,
            NpmToolchainSource::UserPath,
            "unknown",
            Some(MANAGED_NODE_ABI),
            None,
        ));
    }

    #[test]
    fn unattributed_non_npm_markerless_failure_arms_the_managed_retry() {
        // HQ-DESKTOP-56 reopen: a markerless `Unexpected` failure whose stderr origin
        // is `non-npm` (npm's own logger emitted nothing) is a user-path runtime HQ's
        // managed npm can bypass, so it arms the SAME one-shot retry — under the
        // UNCHANGED runtime conditions (UserPath + failing ABI != managed ABI).
        assert!(install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::UserPath,
            "none",
            Some(147), // the reported Node 26.3.0 ABI
            Some("non-npm"),
        ));
        // An unknown ABI still arms — never gate the reported cluster out on a
        // missing probe.
        assert!(install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::UserPath,
            "none",
            None,
            Some("non-npm"),
        ));
        // An `npm-logger` origin (npm ran and reported) does NOT arm — a new runtime
        // is unlikely to help and would spend a ~50MB download.
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::UserPath,
            "none",
            Some(147),
            Some("npm-logger"),
        ));
        // Neither does an empty stderr (the caller folds it to `None`)...
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::UserPath,
            "none",
            Some(147),
            None,
        ));
        // ...nor a managed toolchain source, nor a run already on HQ's managed ABI.
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::Managed,
            "none",
            Some(147),
            Some("non-npm"),
        ));
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::Unexpected,
            NpmToolchainSource::UserPath,
            "none",
            Some(MANAGED_NODE_ABI),
            Some("non-npm"),
        ));
        // A non-Unexpected kind never arms via the non-npm origin, even if an origin
        // were somehow supplied (defense in depth against a caller mistake).
        assert!(!install_failure_earns_managed_retry(
            InstallFailureKind::ExpectedDiskFull,
            NpmToolchainSource::UserPath,
            "none",
            Some(147),
            Some("non-npm"),
        ));
    }

    #[test]
    fn foreign_registry_package_missing_never_arms_the_managed_retry() {
        // HQ-DESKTOP-5Q: a registry misconfiguration is NOT a runtime/prebuild or
        // npm-prefix fault — provisioning a different Node cannot make a registry that
        // lacks the package carry it, and the managed retry reuses the SAME machine
        // registry config, so it must never arm. Assert across every toolchain source,
        // every Node ABI (including HQ's own managed ABI), and every lifecycle-cause
        // value (irrelevant here — npm never ran a build).
        for source in [
            NpmToolchainSource::UserPath,
            NpmToolchainSource::Managed,
            NpmToolchainSource::Unknown,
        ] {
            for abi in [Some(MANAGED_NODE_ABI), Some(115), Some(127), Some(48), None] {
                for cause in ["", "unknown", "toolchain-missing", "disk-space", "network"] {
                    assert!(
                        !install_failure_earns_managed_retry(
                            InstallFailureKind::ForeignRegistryPackageMissing,
                            source,
                            cause,
                            abi,
                            None,
                        ),
                        "foreign-registry-404 must never arm (source={source:?} abi={abi:?} cause={cause})"
                    );
                }
            }
        }
    }

    #[test]
    fn managed_retry_argv_targets_the_managed_prefix_with_the_pinned_version() {
        // The retry rebuilds its argv against HQ's managed prefix and the SAME
        // pinned version — never the user's prefix, never a re-resolved @latest.
        let managed_prefix = "/managed/toolchain/npm-global";
        let user_prefix = "/Users/me/.nvm/versions/node/v20.19.5/lib/node_modules";
        let pinned = "5.97.2";

        let argv = install_argv(Some(managed_prefix), Some(pinned));

        // `--prefix` is immediately followed by the MANAGED prefix.
        let prefix_pos = argv
            .iter()
            .position(|arg| arg == "--prefix")
            .expect("retry argv carries --prefix");
        assert_eq!(
            argv.get(prefix_pos + 1).map(String::as_str),
            Some(managed_prefix)
        );
        // The pinned version is requested exactly (name@version); the mutable
        // @latest spec (HQ_CLI_PACKAGE already carries `@latest`) never is.
        let pinned_spec = format!(
            "{}@{pinned}",
            hq_desktop_core::hq_cli_update::HQ_CLI_PACKAGE_NAME
        );
        assert!(argv.iter().any(|arg| arg == &pinned_spec));
        assert!(argv.iter().all(|arg| arg != HQ_CLI_PACKAGE));
        // The user's own prefix appears nowhere in the retry argv.
        assert!(argv.iter().all(|arg| !arg.contains(user_prefix)));
    }

    /// The ABI-safe FALLBACK contract, paired with the new executed-copy aim.
    /// `select_ordinary_install_aim` may aim the ordinary update at a drivable
    /// user prefix, but only ever runs THAT prefix's own co-located npm — so
    /// `prefer_managed_prefix` remains the guarantee that HQ's MANAGED npm is
    /// never pointed at a user prefix (the ABI-127-into-a-Node-20-prefix
    /// corruption). This case must stay green: a managed npm still routes to the
    /// managed prefix, a user-path npm still derives from `hq`, and no `--prefix`
    /// stays None.
    #[test]
    fn ordinary_install_prefix_follows_the_npm_runtime_not_hq_alone() {
        let managed = "/managed/toolchain/npm-global".to_string();
        let user = "/Users/me/.nvm/versions/node/v20.19.5/lib/node_modules".to_string();

        // A MANAGED npm must install into the managed prefix, never the user's — the
        // guard against the run-after-provision cross-runtime corruption (ABI-127
        // artifacts landing in a Node-20 prefix the user runtime cannot load).
        assert_eq!(
            prefer_managed_prefix(true, Some(managed.clone()), Some(user.clone())),
            Some(managed.clone())
        );
        // A user-path npm keeps deriving the prefix from `hq`, exactly as before.
        assert_eq!(
            prefer_managed_prefix(false, Some(managed.clone()), Some(user.clone())),
            Some(user.clone())
        );
        // npm's default prefix (no `--prefix`) stays None on the user path.
        assert_eq!(prefer_managed_prefix(false, Some(managed), None), None);
    }

    /// Gold for the app-crate selector (RED on base ea307d53, which had no such
    /// selector; GREEN on the candidate): the exact live shape — an nvm prefix
    /// inside `$HOME`, outside every managed root, that ships its own co-located
    /// npm — is aimed at IN PLACE, installing into the nvm prefix and running the
    /// nvm npm, so the copy the app executes is upgraded and resolution converges.
    /// Scoped to unix because the live shape is a unix/nvm layout
    /// (`<prefix>/bin/{hq,npm}`); Windows uses the flat `<prefix>\*.cmd` layout,
    /// and its negative selector paths are covered by the sibling tests below.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn the_install_targets_the_executed_copys_own_prefix_and_npm() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let prefix = home.join(".nvm/versions/node/v24.20.0");
        let bin = prefix.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("hq"), "#!/bin/sh\n").unwrap();
        std::fs::write(bin.join("npm"), "#!/bin/sh\n").unwrap();
        let managed_roots = [home.join("Library/Application Support/Indigo HQ/toolchain")];

        let aim = select_ordinary_install_aim(
            &bin.join("hq").to_string_lossy(),
            &managed_roots,
            Some(home),
        );
        assert_eq!(
            aim,
            Some(UserPrefixAim {
                prefix: prefix.to_string_lossy().to_string(),
                npm: bin.join("npm").to_string_lossy().to_string(),
            }),
            "the ordinary update aims at the executed nvm copy's own prefix and npm"
        );
    }

    /// A system/Homebrew prefix is never user-owned, so the selector declines and
    /// the managed / hq-derived prefix + resolved npm stand exactly as before.
    #[test]
    fn a_system_or_homebrew_prefix_still_routes_to_the_managed_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let managed_roots = [home.join("Library/Application Support/Indigo HQ/toolchain")];
        for hq in ["/opt/homebrew/bin/hq", "/usr/local/bin/hq", "/usr/bin/hq"] {
            assert_eq!(
                select_ordinary_install_aim(hq, &managed_roots, Some(home)),
                None,
                "{hq} is a system prefix and must not be aimed at"
            );
        }
        // And the managed-npm ABI guarantee is unchanged.
        let managed = "/managed/toolchain/npm-global".to_string();
        assert_eq!(
            prefer_managed_prefix(true, Some(managed.clone()), Some("/opt/homebrew".to_string())),
            Some(managed)
        );
    }

    /// A user-owned prefix with NO co-located npm cannot be driven in place, so
    /// the selector declines (ABI safety: HQ never runs the managed npm here).
    #[test]
    fn a_user_prefix_without_a_colocated_npm_still_routes_to_the_managed_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let prefix = home.join(".nvm/versions/node/v24.20.0");
        let bin = prefix.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // Only `hq`, no co-located `npm`.
        std::fs::write(bin.join("hq"), "#!/bin/sh\n").unwrap();
        let managed_roots = [home.join("Library/Application Support/Indigo HQ/toolchain")];
        assert_eq!(
            select_ordinary_install_aim(
                &bin.join("hq").to_string_lossy(),
                &managed_roots,
                Some(home),
            ),
            None
        );
    }

    /// An `hq` already inside a managed root is not user-owned, so the new
    /// selector never claims it — the managed path handles it exactly as before.
    #[test]
    fn an_hq_already_inside_a_managed_root_is_unaffected_by_the_new_selector() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let root = home.join("Library/Application Support/Indigo HQ/toolchain");
        let bin = root.join("npm-global/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("hq"), "#!/bin/sh\n").unwrap();
        std::fs::write(bin.join("npm"), "#!/bin/sh\n").unwrap();
        let managed_roots = [root];
        assert_eq!(
            select_ordinary_install_aim(
                &bin.join("hq").to_string_lossy(),
                &managed_roots,
                Some(home),
            ),
            None,
            "a managed-root hq is driven by the managed path, not the new selector"
        );
    }

    /// The Kevin recurrence fix: a FIRST install is aimed at HQ's OWN managed npm
    /// prefix (the primary toolchain root's `npm-global`/`npm-prefix`), which the
    /// resolver searches before every user prefix, so the post-install probe finds
    /// what was just installed instead of an unreachable ambient default prefix.
    #[test]
    fn the_first_install_targets_the_managed_npm_prefix() {
        let root = PathBuf::from("/opt/IndigoHQ/toolchain");
        let roots = [root.clone(), PathBuf::from("/opt/Indigo HQ/toolchain")];
        assert_eq!(
            first_install_prefix(&roots),
            Some(
                paths::managed_npm_prefix_in(&root)
                    .to_string_lossy()
                    .to_string()
            ),
            "the first install aims at the PRIMARY managed root's npm prefix"
        );
        // No managed root discoverable -> None, so the caller falls back to the
        // ordinary npm-derived prefix.
        assert_eq!(first_install_prefix(&[]), None);
    }

    /// The provisioning gate: only HQ's own managed npm counts as managed. A user
    /// npm (any absolute path outside the roots) and the unresolved bare `npm`
    /// sentinel both read as NOT managed, so a first install provisions HQ's Node.
    #[test]
    fn npm_within_managed_root_distinguishes_managed_from_user_and_unresolved() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        assert!(npm_within_managed_root(
            "/opt/IndigoHQ/toolchain/node/bin/npm",
            &roots
        ));
        assert!(!npm_within_managed_root("/usr/local/bin/npm", &roots));
        assert!(
            !npm_within_managed_root("npm", &roots),
            "the unresolved bare sentinel is not managed, so a first install provisions"
        );
    }

    #[test]
    fn managed_retry_after_version_requires_managed_prefix_resolution() {
        // (b)+(c): the executed version counts only when the resolved binary lives
        // INSIDE the managed prefix. Outside it, the after-version is forced to
        // None so the shared decision is non-convergent (never healed).
        assert_eq!(
            managed_retry_after_version(true, Some("5.97.2")),
            Some("5.97.2")
        );
        assert_eq!(managed_retry_after_version(false, Some("5.97.2")), None);
        // A failed execution probe is non-convergent even inside the prefix.
        assert_eq!(managed_retry_after_version(true, None), None);
    }

    #[test]
    fn managed_retry_convergence_requires_runtime_evidence_not_version_alone() {
        let managed_prefix = "/managed/toolchain/npm-global";
        let managed_hq = "/managed/toolchain/npm-global/bin/hq";
        let managed_npm = "/managed/toolchain/node/bin/npm";
        let user_hq = "/Users/me/.nvm/versions/node/v20.19.5/bin/hq";
        let latest = "5.97.2";

        let decide = |after_bin: &str, after_version: Option<&str>| {
            decide_post_install(&PostInstallContext::npm(
                user_hq,
                after_bin,
                Some("5.90.0"),
                after_version,
                latest,
                Some(managed_prefix),
                managed_npm,
                false,
                Some(latest),
            ))
        };

        // (a)+(b)+(c) all satisfied: executed version reaches latest and the binary
        // resolves inside the managed prefix -> converged (success, clears marker,
        // no capture).
        let converged = decide(managed_hq, managed_retry_after_version(true, Some(latest)));
        assert!(converged.result.is_ok());
        assert!(converged.clear_non_convergent);
        assert!(converged.capture.is_none());

        // (c) fails: the execution probe returned nothing -> non-convergent even
        // though delivery reached latest. Never a healed success.
        let probe_failed = decide(managed_hq, managed_retry_after_version(true, None));
        assert!(probe_failed.result.is_err());
        assert!(!probe_failed.clear_non_convergent);

        // (b) fails: the app still resolves a user-path shim -> non-convergent.
        let wrong_prefix = decide(user_hq, managed_retry_after_version(false, Some(latest)));
        assert!(wrong_prefix.result.is_err());
        assert!(!wrong_prefix.clear_non_convergent);
    }

    #[test]
    fn managed_retry_failure_detail_is_provenance_aware_and_never_reblames_node() {
        let detail =
            managed_retry_failure_detail(Some(1), "npm error code 1\ngyp ERR! build error", None);
        let lower = detail.to_lowercase();
        // Provenance-aware: says HQ already retried under its managed Node.
        assert!(lower.contains("managed node"));
        // Never advises installing Node / Node 22, and never blames the user runtime.
        assert!(!lower.contains("install the supported node"));
        assert!(!detail.contains("version 22"));
        // Keeps the copyable-command escape hatch and a support next step.
        assert!(detail.contains("copied command"));
        assert!(lower.contains("support"));
        // The raw build output is retained for the terminal.
        assert!(detail.contains("gyp ERR! build error"));

        // Empty raw output still yields provenance-aware, actionable copy with no
        // Node-version advice.
        let empty = managed_retry_failure_detail(None, "   ", None);
        let empty_lower = empty.to_lowercase();
        assert!(empty_lower.contains("managed node"));
        assert!(empty.contains("copied command"));
        assert!(!empty.contains("version 22"));

        // A managed retry that ALSO hit a missing install target (HQ-DESKTOP-5K)
        // gets the missing-folder copy, never the "a dependency build failed /
        // changing Node won't help" wording.
        let missing = managed_retry_failure_detail(
            Some(-4058),
            "npm error code ENOENT\nnpm error syscall mkdir\nnpm error path /managed/npm-global/lib/node_modules/@indigoai-us/hq-cli",
            Some("/managed/npm-global"),
        );
        let missing_lower = missing.to_lowercase();
        assert!(missing_lower.contains("install folder"));
        assert!(!missing_lower.contains("dependency build"));
        assert!(missing.contains("copied command"));
    }

    #[test]
    fn prepare_app_npm_cache_is_stable_and_creates_only_the_app_cache_child() {
        let temp = tempfile::tempdir().unwrap();
        let app_cache = temp.path().join("app-cache");
        let expected = app_cache.join("npm");

        assert!(!expected.exists());
        assert_eq!(prepare_app_npm_cache(app_cache.clone()).unwrap(), expected);
        assert!(expected.is_dir());
        assert_eq!(prepare_app_npm_cache(app_cache).unwrap(), expected);
    }

    #[test]
    fn npm_install_command_uses_app_cache_without_changing_path_or_argv() {
        let args = install_argv(Some("/tmp/hq-prefix"), None);
        let command = npm_install_command(
            "npm",
            "/test/child-path",
            Path::new("/tmp/app-cache/npm"),
            &args,
        );
        let env_value = |name: &str| {
            command
                .get_envs()
                .find_map(|(key, value)| (key == OsStr::new(name)).then_some(value).flatten())
                .map(|value| value.to_os_string())
        };

        assert_eq!(env_value("PATH"), Some("/test/child-path".into()));
        assert_eq!(
            env_value("NPM_CONFIG_CACHE"),
            Some("/tmp/app-cache/npm".into())
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            args.iter().map(OsStr::new).collect::<Vec<_>>(),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn app_owned_cache_reaches_every_install_retry_attempt() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        for (mode, expected_attempts) in [
            ("plain", 1usize),
            ("eexist", 2),
            ("enotempty", 2),
            ("eperm", 2),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let npm = temp.path().join("fake-npm");
            let state = temp.path().join("state");
            let attempts = temp.path().join("attempts");
            let script = format!(
                r#"#!/bin/sh
state="{}"
attempts="{}"
count=0
if [ -f "$state" ]; then count=$(cat "$state"); fi
count=$((count + 1))
printf '%s' "$count" > "$state"
printf '%s|%s\n' "$NPM_CONFIG_CACHE" "$*" >> "$attempts"
case "{}:$count" in
  eexist:1) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq' >&2; exit 1 ;;
  enotempty:1) printf '%s\n' 'npm error code ENOTEMPTY' >&2; exit 1 ;;
  eperm:1) printf '%s\n' 'npm error code EPERM; npm error errno -4048' >&2; exit 1 ;;
esac
exit 0
"#,
                state.display(),
                attempts.display(),
                mode,
            );
            fs::write(&npm, script).unwrap();
            let mut permissions = fs::metadata(&npm).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&npm, permissions).unwrap();

            let npm_cache = temp.path().join("app-cache/npm");
            fs::create_dir_all(&npm_cache).unwrap();
            let prefix = temp.path().join("npm-prefix");
            let path = std::env::var("PATH").unwrap();
            let output = run_npm_install_with_retries(
                npm.to_str().unwrap(),
                &path,
                &npm_cache,
                Some(prefix.to_str().unwrap()),
                install_argv(Some(prefix.to_str().unwrap()), None),
            )
            .await
            .unwrap();

            assert!(
                output.output.status.success(),
                "{mode} retry path should recover"
            );
            let lines: Vec<_> = fs::read_to_string(&attempts)
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect();
            assert_eq!(lines.len(), expected_attempts, "{mode} attempt count");
            for line in lines {
                assert!(
                    line.starts_with(&format!("{}|", npm_cache.display())),
                    "{mode} lost its app-owned npm cache: {line}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prefix_less_enotempty_cleans_the_npm_reported_scope_and_recovers() {
        // HQ-DESKTOP-5B: on a machine whose `hq` is bare or non-npm-shaped the
        // updater resolves NO prefix (npm_prefix_known=false in 61/61 events), so
        // the pre-fix ENOTEMPTY rung took its else arm and left the wedge in place
        // forever. The remedy now derives the cleanup scope from the absolute path
        // npm itself named, cleans the debris, and the retry recovers — with the
        // deletion still confined to `hq-cli` + `.hq-cli-*`, never a sibling.
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        // A real global npm scope: <root>/lib/node_modules/@indigoai-us.
        let scope = temp.path().join("lib/node_modules/@indigoai-us");
        fs::create_dir_all(scope.join("hq-cli/dist")).unwrap();
        fs::write(scope.join("hq-cli/package.json"), "{}").unwrap();
        fs::create_dir_all(scope.join(".hq-cli-0DY3ww6z")).unwrap();
        fs::write(scope.join(".hq-cli-0DY3ww6z/partial"), "x").unwrap();
        // A sibling package and a loose file inside the scope that MUST survive.
        fs::create_dir_all(scope.join("hq-other")).unwrap();
        fs::write(scope.join("hq-other/package.json"), "{}").unwrap();
        fs::write(scope.join("keep.txt"), "keep").unwrap();

        let npm = temp.path().join("fake-npm");
        let state = temp.path().join("state");
        let attempts = temp.path().join("attempts");
        // Attempt 1 fails ENOTEMPTY naming the planted scope; attempt 2 succeeds.
        let script = format!(
            r#"#!/bin/sh
state="{}"
attempts="{}"
count=0
if [ -f "$state" ]; then count=$(cat "$state"); fi
count=$((count + 1))
printf '%s' "$count" > "$state"
printf '%s\n' "$*" >> "$attempts"
if [ "$count" -eq 1 ]; then
  printf '%s\n' 'npm error code ENOTEMPTY' 'npm error syscall rename' 'npm error path {}/hq-cli' >&2
  exit 1
fi
exit 0
"#,
            state.display(),
            attempts.display(),
            scope.display(),
        );
        fs::write(&npm, script).unwrap();
        let mut permissions = fs::metadata(&npm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm, permissions).unwrap();

        let npm_cache = temp.path().join("app-cache/npm");
        fs::create_dir_all(&npm_cache).unwrap();
        // The load-bearing part: NO prefix resolved, exactly like the 61 events.
        let run = run_npm_install_with_retries(
            npm.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &npm_cache,
            None,
            install_argv(None, None),
        )
        .await
        .unwrap();

        assert!(
            run.output.status.success(),
            "the npm-path cleanup retry must recover the install"
        );
        // Exactly two attempts — the failing plain install, then the npm-path
        // cleanup retry — and the ledger records that provenance.
        let lines: Vec<_> = fs::read_to_string(&attempts)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(lines.len(), 2, "one failure, one cleanup retry");
        assert_eq!(run.rungs, vec!["plain", "cleanup-plain-npm-path"]);

        // The debris is gone; the sibling package, the loose file, and the scope
        // directory itself all survive.
        assert!(!scope.join("hq-cli").exists(), "partial package dir removed");
        assert!(
            !scope.join(".hq-cli-0DY3ww6z").exists(),
            "temp staging dir removed"
        );
        assert!(scope.join("hq-other").exists(), "sibling package preserved");
        assert!(scope.join("keep.txt").exists(), "loose scope file preserved");
        assert!(scope.exists(), "the scope directory itself is never removed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_retry_ladder_rearms_force_only_after_cleanup() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let npm = temp.path().join("fake-npm");
        let state = temp.path().join("state");
        let attempts = temp.path().join("attempts");
        let script = format!(
            r#"#!/bin/sh
state="{}"
attempts="{}"
count=0
if [ -f "$state" ]; then count=$(cat "$state"); fi
count=$((count + 1))
printf '%s' "$count" > "$state"
printf '%s\n' "$*" >> "$attempts"
case "$count" in
  1) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq' >&2; exit 1 ;;
  2) printf '%s\n' 'npm error code ENOTEMPTY' >&2; exit 1 ;;
  3) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq' >&2; exit 1 ;;
  4) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq' >&2; exit 1 ;;
esac
exit 0
"#,
            state.display(),
            attempts.display(),
        );
        fs::write(&npm, script).unwrap();
        let mut permissions = fs::metadata(&npm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm, permissions).unwrap();

        let npm_cache = temp.path().join("app-cache/npm");
        fs::create_dir_all(&npm_cache).unwrap();
        let prefix = temp.path().join("npm-prefix");
        let run = run_npm_install_with_retries(
            npm.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &npm_cache,
            Some(prefix.to_str().unwrap()),
            install_argv(Some(prefix.to_str().unwrap()), None),
        )
        .await
        .unwrap();

        assert!(!run.output.status.success());
        assert!(run.final_attempt_forced);
        let lines: Vec<_> = fs::read_to_string(&attempts)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(lines.len(), 4, "retry work must stay within the hard cap");
        assert!(!lines[0].contains("--force"));
        assert!(lines[1].contains("--force"));
        assert!(!lines[2].contains("--force"));
        assert!(lines[3].contains("--force"));
        assert_eq!(
            classify_install_failure_with_final_attempt(
                run.output.status.code(),
                &npm_output_detail(&run.output),
                Some(prefix.to_str().unwrap()),
                run.final_attempt_forced,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn second_shim_eexist_arms_one_force_retry_and_stays_a_warning() {
        // HQ-DESKTOP-4Y: the collision npm reported was on the package's SECOND
        // declared shim, `hq-auth-refresh`. It must arm the SAME single `--force`
        // rung the `hq` collision uses — one retry, still within the hard cap,
        // the app-owned cache on every attempt — and, once force is exhausted,
        // classify as the visible-at-Warning ExpectedBinCollision rather than a
        // loud unexpected page.
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let npm = temp.path().join("fake-npm");
        let state = temp.path().join("state");
        let attempts = temp.path().join("attempts");
        let script = format!(
            r#"#!/bin/sh
state="{}"
attempts="{}"
count=0
if [ -f "$state" ]; then count=$(cat "$state"); fi
count=$((count + 1))
printf '%s' "$count" > "$state"
printf '%s|%s\n' "$NPM_CONFIG_CACHE" "$*" >> "$attempts"
case "$count" in
  1) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq-auth-refresh' >&2; exit 1 ;;
  2) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq-auth-refresh' >&2; exit 1 ;;
esac
exit 0
"#,
            state.display(),
            attempts.display(),
        );
        fs::write(&npm, script).unwrap();
        let mut permissions = fs::metadata(&npm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm, permissions).unwrap();

        let npm_cache = temp.path().join("app-cache/npm");
        fs::create_dir_all(&npm_cache).unwrap();
        let prefix = temp.path().join("npm-prefix");
        let run = run_npm_install_with_retries(
            npm.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &npm_cache,
            Some(prefix.to_str().unwrap()),
            install_argv(Some(prefix.to_str().unwrap()), None),
        )
        .await
        .unwrap();

        assert!(!run.output.status.success());
        assert!(run.final_attempt_forced);
        let lines: Vec<_> = fs::read_to_string(&attempts)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            lines.len(),
            2,
            "exactly one forced retry, within the hard cap"
        );
        assert!(!lines[0].contains("--force"));
        assert!(lines[1].contains("--force"));
        for line in &lines {
            assert!(
                line.starts_with(&format!("{}|", npm_cache.display())),
                "second-shim retry lost its app-owned npm cache: {line}"
            );
        }
        assert_eq!(
            classify_install_failure_with_final_attempt(
                run.output.status.code(),
                &npm_output_detail(&run.output),
                Some(prefix.to_str().unwrap()),
                run.final_attempt_forced,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn eexist_after_windows_backoff_is_not_silently_forced_or_suppressed() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let npm = temp.path().join("fake-npm");
        let state = temp.path().join("state");
        let attempts = temp.path().join("attempts");
        let script = format!(
            r#"#!/bin/sh
state="{}"
attempts="{}"
count=0
if [ -f "$state" ]; then count=$(cat "$state"); fi
count=$((count + 1))
printf '%s' "$count" > "$state"
printf '%s\n' "$*" >> "$attempts"
case "$count" in
  1) printf '%s\n' 'npm error code EPERM' 'npm error errno -4048' >&2; exit 1 ;;
  2) printf '%s\n' 'npm error code EEXIST' 'npm error path /tmp/bin/hq' >&2; exit 1 ;;
esac
exit 0
"#,
            state.display(),
            attempts.display(),
        );
        fs::write(&npm, script).unwrap();
        let mut permissions = fs::metadata(&npm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm, permissions).unwrap();

        let npm_cache = temp.path().join("app-cache/npm");
        fs::create_dir_all(&npm_cache).unwrap();
        let prefix = temp.path().join("npm-prefix");
        let run = run_npm_install_with_retries(
            npm.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &npm_cache,
            Some(prefix.to_str().unwrap()),
            install_argv(Some(prefix.to_str().unwrap()), None),
        )
        .await
        .unwrap();

        assert!(!run.output.status.success());
        assert!(!run.final_attempt_forced);
        let lines = fs::read_to_string(&attempts).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.lines().all(|line| !line.contains("--force")));
        assert_eq!(
            classify_install_failure_with_final_attempt(
                run.output.status.code(),
                &npm_output_detail(&run.output),
                Some(prefix.to_str().unwrap()),
                run.final_attempt_forced,
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_toolchain_npm_and_path_requires_node_not_just_npm() {
        use std::fs;
        // Serialize HOME mutation against every other env/home-touching test.
        let _env = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _home_lock = HOME_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let _restore_home = HomeEnvRestore(std::env::var_os("HOME"));

        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", temp.path());

        // The unix managed layout: <HOME>/Library/Application Support/Indigo HQ/
        // toolchain/node/bin/{node,npm}.
        let bin = temp
            .path()
            .join("Library/Application Support/Indigo HQ/toolchain/node/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("npm"), "#!/bin/sh\nexit 0\n").unwrap();

        // npm present but the managed Node ABSENT is an INCOMPLETE toolchain — not
        // usable, because the managed PATH would fall through to the user's Node.
        // The HQ-DESKTOP-5E retry must not proceed on it (review follow-up).
        assert!(
            managed_toolchain_npm_and_path().is_none(),
            "npm without a managed node next to it is not a usable managed toolchain"
        );

        // Once the managed Node exists too, it resolves.
        fs::write(bin.join("node"), "#!/bin/sh\nexit 0\n").unwrap();
        let (resolved_npm, resolved_path, _prefix) = managed_toolchain_npm_and_path()
            .expect("npm + node present must resolve a usable managed toolchain");
        let expected_npm = bin.join("npm").to_string_lossy().into_owned();
        let bin_str = bin.to_string_lossy().into_owned();
        assert_eq!(resolved_npm, expected_npm);
        assert!(resolved_path.starts_with(bin_str.as_str()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn app_owned_cache_avoids_a_read_only_home_npm_cache() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let _env = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _home_lock = HOME_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("poisoned-home");
        let poisoned_cache = home.join(".npm/_cacache");
        fs::create_dir_all(&poisoned_cache).unwrap();
        let mut permissions = fs::metadata(&poisoned_cache).unwrap().permissions();
        permissions.set_mode(0o555);
        fs::set_permissions(&poisoned_cache, permissions).unwrap();

        let _restore_home = HomeEnvRestore(std::env::var_os("HOME"));
        std::env::set_var("HOME", &home);

        let npm = temp.path().join("fake-npm");
        let attempts = temp.path().join("attempts");
        let script = format!(
            r#"#!/bin/sh
printf '%s|%s\n' "$HOME" "$NPM_CONFIG_CACHE" > "{}"
exit 0
"#,
            attempts.display(),
        );
        fs::write(&npm, script).unwrap();
        let mut permissions = fs::metadata(&npm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm, permissions).unwrap();

        let app_cache = temp.path().join("app-cache/npm");
        fs::create_dir_all(&app_cache).unwrap();
        let prefix = temp.path().join("npm-prefix");
        let output = run_npm_install_with_retries(
            npm.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &app_cache,
            Some(prefix.to_str().unwrap()),
            install_argv(Some(prefix.to_str().unwrap()), None),
        )
        .await
        .unwrap();

        assert!(
            output.output.status.success(),
            "the isolated-cache install must converge"
        );
        assert_eq!(
            fs::read_to_string(&attempts).unwrap().trim(),
            format!("{}|{}", home.display(), app_cache.display()),
            "npm must receive the app-owned cache, never HOME/.npm"
        );
    }

    #[test]
    fn unreadable_version_event_keeps_closed_diagnostics_after_scrubbing() {
        let probes = hq_desktop_core::hq_cli_update::LocalVersionProbeDiagnostics {
            binary_anchor: hq_desktop_core::hq_cli_update::VersionProbeOutcome::PackageNotFound,
            npm_root: hq_desktop_core::hq_cli_update::VersionProbeOutcome::NonzeroExit,
            hq_version: hq_desktop_core::hq_cli_update::VersionProbeOutcome::InvalidUtf8,
            binary_anchor_shape: hq_desktop_core::hq_cli_update::BinaryAnchorShape::FlatGlobalBin,
            resolved_program_kind:
                hq_desktop_core::hq_cli_update::ResolvedProgramKind::Extensionless,
            managed_runtime: hq_desktop_core::hq_cli_update::ManagedRuntimeState::NotProbed,
            interpreter_recovery: hq_desktop_core::hq_cli_update::InterpreterRecovery::NotNeeded,
            resolution_source: hq_desktop_core::hq_cli_update::ResolutionSource::NotResolved,
        };
        let events = sentry::test::with_captured_events(|| {
            sentry::configure_scope(|scope| {
                scope.set_extra("token", "fixture-token".into());
            });
            report_unreadable_version("5.77.7", &probes);
        });

        assert_eq!(events.len(), 1);
        let event = hq_telemetry::before_send(events.into_iter().next().unwrap()).unwrap();
        assert_eq!(event.level, sentry::Level::Warning);
        assert_eq!(
            event.message.as_deref(),
            Some(
                "[hq-cli-update] hq is installed but its version could not be read \
                 (binary-anchor, npm root, and hq --version all failed)"
            )
        );
        assert_eq!(event.tags["hq_cli_update_kind"], "version-unreadable");
        assert_eq!(event.tags["latest"], "5.77.7");
        assert_eq!(
            event.extra["hq_cli_version_probes"],
            serde_json::json!({
                "binary_anchor": "package_not_found",
                "npm_root": "nonzero_exit",
                "hq_version": "invalid_utf8",
                "binary_anchor_shape": "flat_global_bin",
                // A resolution Windows cannot execute survives scrubbing as a
                // closed enum value — never as the offending path.
                "resolved_program_kind": "extensionless",
                "managed_runtime": "not_probed",
                "interpreter_recovery": "not_needed",
                "resolution_source": "not_resolved",
            })
        );
        assert_eq!(event.extra["token"], serde_json::json!("[Filtered]"));

        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains("fixture-token"));
        assert!(!serialized.contains("/Users/fixture-home"));
        assert!(!serialized.contains("fixture-stdout"));
        assert!(!serialized.contains("fixture-stderr"));
    }

    // HQ-SYNC-B: an EEXIST bin collision (a stale `<prefix>/bin/hq` npm didn't
    // create) must be the ONLY failure that arms the forced retry. Other npm
    // failures (EACCES, network, empty) must fall straight through.
    #[test]
    fn eexist_is_the_only_failure_that_arms_the_forced_retry() {
        assert!(is_bin_exists_failure(
            "npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/hq",
            Some("/usr/local"),
        ));
        assert!(!is_bin_exists_failure(
            "npm ERR! code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
            Some("/usr/local"),
        ));
        assert!(!is_bin_exists_failure(
            "npm error code 1\nnpm error command failed\nscript output EEXIST",
            Some("/usr/local"),
        ));
        assert!(!is_bin_exists_failure(
            "npm ERR! network timeout",
            Some("/usr/local")
        ));
        assert!(!is_bin_exists_failure("", Some("/usr/local")));
    }

    // The forced retry reuses the base args plus `--force`, still targeting the
    // global hq-cli install — it just overwrites the stale bin link.
    #[test]
    fn forced_retry_args_add_force_to_a_global_install() {
        let mut forced = install_argv(None, None);
        forced.push("--force".to_string());
        assert!(
            forced.iter().any(|a| a == "--force"),
            "retry must carry --force"
        );
        assert_eq!(forced[0], "install");
        assert!(
            forced.iter().any(|a| a == "-g"),
            "must stay a global install"
        );
    }

    // feedback_44061f91: an ENOTEMPTY partial-install failure (leftover debris
    // from an interrupted install blocking npm's rename) must arm the cleanup +
    // retry path — and ONLY that failure, since the cleanup deletes files.
    #[test]
    fn partial_install_failure_detects_only_enotempty() {
        // The exact "Last Failing Tool Call" from the field report.
        const REAL_ENOTEMPTY_STDERR: &str = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global/lib/node_modules/@indigoai-us/hq-cli\n\
            npm error dest /Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global/lib/node_modules/@indigoai-us/.hq-cli-0DY3ww6z\n\
            npm error ENOTEMPTY: directory not empty, rename '.../hq-cli' -> '.../.hq-cli-0DY3ww6z'";
        assert!(is_partial_install_failure(REAL_ENOTEMPTY_STDERR));
        // EEXIST is handled by the --force retry; EACCES needs sudo; neither must
        // arm the destructive cleanup path.
        assert!(!is_partial_install_failure(
            "npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/hq"
        ));
        assert!(!is_partial_install_failure(
            "npm ERR! code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'"
        ));
        assert!(!is_partial_install_failure("npm ERR! network timeout"));
        assert!(!is_partial_install_failure(""));
    }

    // HQ-DESKTOP-3N: a Windows EPERM locked-binary failure (exit -4048, or the
    // same libuv errno surfaced in npm stderr) must be the ONLY thing that arms
    // the backoff retry. EACCES (sudo case) and network failures fall straight
    // through to the error handler unchanged.
    #[test]
    fn windows_eperm_locked_binary_arms_the_backoff_retry() {
        // The raw libuv errno propagated as the process exit code.
        assert!(is_windows_locked_binary_failure(Some(-4048), ""));
        // The same error bubbled through npm stderr with a different exit code.
        assert!(is_windows_locked_binary_failure(
            Some(1),
            "npm error code EPERM\nnpm error errno -4048\n\
             npm error EPERM: operation not permitted, unlink 'C:\\...\\hq.cmd'"
        ));
        // Must NOT arm on the EACCES sudo case or ordinary network failures.
        assert!(!is_windows_locked_binary_failure(
            Some(243),
            "npm error code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'"
        ));
        assert!(!is_windows_locked_binary_failure(
            Some(1),
            "npm ERR! network timeout"
        ));
        assert!(!is_windows_locked_binary_failure(Some(1), ""));
        // The backoff is bounded and short — a single wait before the lone retry.
        assert!(LOCKED_BINARY_RETRY_BACKOFF <= Duration::from_secs(10));
    }

    #[test]
    fn partial_install_scope_dir_is_the_npm_global_scope() {
        // npm's macOS global layout: <prefix>/lib/node_modules/<scope>.
        assert_eq!(
            partial_install_scope_dir_for(
                "/Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global",
                false,
            ),
            PathBuf::from(
                "/Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global/lib/node_modules/@indigoai-us"
            )
        );
    }

    #[test]
    fn partial_install_scope_dir_uses_windows_global_npm_layout() {
        assert_eq!(
            partial_install_scope_dir_for(
                "C:/Users/mike/AppData/Local/IndigoHQ/toolchain/npm-prefix",
                true,
            ),
            PathBuf::from(
                "C:/Users/mike/AppData/Local/IndigoHQ/toolchain/npm-prefix/node_modules/@indigoai-us"
            )
        );
    }

    #[test]
    fn missing_install_target_scope_resolves_prefix_then_npm_path_and_fails_closed() {
        // Prefix-known → the prefix-derived scope, for BOTH layouts, with the
        // prefix-derived rung label. No filesystem access — pure resolution.
        assert_eq!(
            missing_install_target_scope(Some("/Users/me/.npm-global"), "", false),
            Some((
                PathBuf::from("/Users/me/.npm-global/lib/node_modules/@indigoai-us"),
                "mkdir-plain"
            ))
        );
        assert_eq!(
            missing_install_target_scope(Some("C:/Users/me/AppData/Roaming/npm"), "", true),
            Some((
                PathBuf::from("C:/Users/me/AppData/Roaming/npm/node_modules/@indigoai-us"),
                "mkdir-plain"
            ))
        );
        // Prefix-less → recovered from the ABSOLUTE path npm itself named (case
        // preserved, backslashes normalised), with the npm-path rung label.
        let detail = "npm error code ENOENT\n\
            npm error syscall mkdir\n\
            npm error path C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli";
        assert_eq!(
            missing_install_target_scope(None, detail, true),
            Some((
                PathBuf::from("C:/Users/U/AppData/Roaming/npm/node_modules/@indigoai-us"),
                "mkdir-plain-npm-path"
            ))
        );
        // Prefix-less AND ambiguous/relative/near-miss/marker-less → no scope, so the
        // remedy performs no filesystem call at all and reports the failure as today.
        for ambiguous in [
            "npm error path relative/node_modules/@indigoai-us/hq-cli",
            "npm error path /var/tmp/node_modules/@indigoai-usx/hq-cli",
            "npm error code ENOENT\nnpm error syscall mkdir",
            "totally unstructured failure",
        ] {
            assert_eq!(missing_install_target_scope(None, ambiguous, false), None);
        }
    }

    #[test]
    fn missing_target_state_from_existence_names_the_deepest_missing_ancestor() {
        // Nothing in the probed chain missing → the create was a no-op; recorded as
        // created-and-retried.
        assert_eq!(
            missing_target_state_from_existence(true, true, true),
            MissingTargetState::CreatedAndRetried
        );
        // node_modules present, scope absent → scope-missing.
        assert_eq!(
            missing_target_state_from_existence(false, true, true),
            MissingTargetState::ScopeMissing
        );
        // the level above node_modules present, node_modules absent → node-modules-missing.
        assert_eq!(
            missing_target_state_from_existence(false, false, true),
            MissingTargetState::NodeModulesMissing
        );
        // even the top of the probed chain absent → prefix-root-missing.
        assert_eq!(
            missing_target_state_from_existence(false, false, false),
            MissingTargetState::PrefixRootMissing
        );
    }

    #[test]
    fn create_missing_install_scope_creates_the_chain_and_reports_the_missing_ancestor() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("hq-cli-mkdir-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        // Seed the prefix root plus its `lib` level, but NOT `node_modules`, so the
        // remedy has a concrete missing ancestor to name.
        fs::create_dir_all(base.join("lib")).unwrap();
        let scope = partial_install_scope_dir_for(base.to_str().unwrap(), false);
        assert!(!scope.exists());
        let state = create_missing_install_scope(&scope);
        // Creation only: the scope and every absent ancestor now exist...
        assert!(scope.exists(), "the scope and its ancestors must be created");
        // ...and the reported state names which ancestor was missing.
        assert_eq!(state, MissingTargetState::NodeModulesMissing);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn clean_partial_hq_cli_install_removes_only_hq_cli_debris() {
        use std::fs;
        // A throwaway npm global prefix seeded with partial hq-cli debris plus an
        // unrelated sibling package, to prove cleanup is surgically scoped.
        let base = std::env::temp_dir().join(format!("hq-cli-clean-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let scope = partial_install_scope_dir(base.to_str().unwrap());
        // Partial package dir + its temp staging dir (the ENOTEMPTY culprits).
        fs::create_dir_all(scope.join("hq-cli").join("dist")).unwrap();
        fs::write(scope.join("hq-cli").join("package.json"), "{}").unwrap();
        fs::create_dir_all(scope.join(".hq-cli-0DY3ww6z")).unwrap();
        fs::write(scope.join(".hq-cli-0DY3ww6z").join("partial"), "x").unwrap();
        // An unrelated sibling package that MUST survive the cleanup.
        fs::create_dir_all(scope.join("hq-other")).unwrap();
        fs::write(scope.join("hq-other").join("package.json"), "{}").unwrap();

        clean_partial_hq_cli_install(base.to_str().unwrap());

        assert!(
            !scope.join("hq-cli").exists(),
            "partial package dir must be removed"
        );
        assert!(
            !scope.join(".hq-cli-0DY3ww6z").exists(),
            "temp staging dir must be removed"
        );
        assert!(
            scope.join("hq-other").exists(),
            "unrelated sibling package must be preserved"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn clean_partial_hq_cli_install_is_a_noop_when_scope_is_absent() {
        // A never-installed prefix (no scope dir) must not panic.
        let base = std::env::temp_dir().join(format!("hq-cli-clean-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        clean_partial_hq_cli_install(base.to_str().unwrap());
    }

    #[test]
    fn failed_foreign_marker_write_never_calls_the_non_convergent_capture() {
        let records = Cell::new(0usize);
        let captures = Cell::new(0usize);
        let failures = Cell::new(0usize);

        for _ in 0..5 {
            let outcome = decide_post_install(&PostInstallContext::npm(
                "/Users/t/Library/pnpm/hq",
                "/Users/t/Library/pnpm/hq",
                Some("5.77.14"),
                Some("5.77.14"),
                "5.84.0",
                None,
                "/opt/homebrew/bin/npm",
                false,
                None,
            ));
            let record = |version: String| {
                records.set(records.get() + 1);
                assert_eq!(version, "5.84.0");
                Err("config directory is unwritable".to_string())
            };
            let clear = || panic!("a non-convergent install must not clear its marker");
            let capture = |_| captures.set(captures.get() + 1);
            let record_failure = |_error: String| failures.set(failures.get() + 1);
            let emit = |_| panic!("a non-convergent install must not emit cleared");
            let effects = PostInstallEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
                emit_cleared: &emit,
            };

            let result = apply_post_install(&outcome, &effects);
            assert!(
                matches!(result, Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX))
            );
        }

        assert_eq!(records.get(), 5);
        assert_eq!(captures.get(), 0);
        assert_eq!(failures.get(), 5);
    }

    #[test]
    fn converged_post_install_clears_and_emits_once() {
        let clears = Cell::new(0usize);
        let emits = Cell::new(0usize);
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.npm-global/bin/hq",
            "/Users/t/.npm-global/bin/hq",
            Some("5.77.14"),
            Some("5.84.0"),
            "5.84.0",
            Some("/Users/t/.npm-global"),
            "/opt/homebrew/bin/npm",
            true,
            Some("5.84.0"),
        ));
        let record = |_| panic!("a converged install must not record a non-convergence");
        let clear = || clears.set(clears.get() + 1);
        let capture = |_| panic!("a converged install must not capture non-convergence");
        let record_failure = |_error: String| panic!("a converged install has no marker failure");
        let emit = |info: HqCliUpdateInfo| {
            emits.set(emits.get() + 1);
            assert_eq!(info.local.as_deref(), Some("5.84.0"));
            assert_eq!(info.latest, "5.84.0");
        };
        let effects = PostInstallEffects {
            record: &record,
            clear: &clear,
            capture: &capture,
            record_failure: &record_failure,
            emit_cleared: &emit,
        };

        let result = apply_post_install(&outcome, &effects).unwrap();
        assert_eq!(result.local.as_deref(), Some("5.84.0"));
        assert_eq!(clears.get(), 1);
        assert_eq!(emits.get(), 1);
    }

    fn write_hq_cli_manifest(dir: &Path, version: &str) {
        let pkg = dir
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
        )
        .unwrap();
    }

    /// An npm-generated shim body that names the scoped package path, so the
    /// repair's per-shim ownership check recognizes it as HQ's own.
    const HQ_CLI_SHIM_FIXTURE: &str =
        "@ECHO off\r\n\"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*\r\n";

    /// The non-fatal mapping the orchestration relies on: only a removal that
    /// converges is a success; a removal that did not converge, an unlink error,
    /// or a provenance refusal all degrade to the bounded, marker-writing outcome
    /// rather than erroring the install.
    #[test]
    fn managed_shadow_repair_outcome_maps_action_and_convergence() {
        assert_eq!(
            managed_shadow_repair_outcome(ManagedShadowRepairAction::Removed, true),
            ManagedShadowRepairOutcome::Converged
        );
        assert_eq!(
            managed_shadow_repair_outcome(ManagedShadowRepairAction::Removed, false),
            ManagedShadowRepairOutcome::RepairFailed
        );
        assert_eq!(
            managed_shadow_repair_outcome(ManagedShadowRepairAction::RemovalFailed, false),
            ManagedShadowRepairOutcome::RepairFailed
        );
        assert_eq!(
            managed_shadow_repair_outcome(ManagedShadowRepairAction::RemovalFailed, true),
            ManagedShadowRepairOutcome::RepairFailed,
            "an unlink error is never reported as converged"
        );
        assert_eq!(
            managed_shadow_repair_outcome(ManagedShadowRepairAction::ProvenanceRefused, false),
            ManagedShadowRepairOutcome::ProvenanceRefused
        );
    }

    /// The repair the command runs removes exactly the HQ shims and the scoped
    /// package in the shadow directory, and leaves node.exe, npm.cmd, npx.cmd, and
    /// an unrelated global package byte-for-byte — plus the fresh managed copy.
    #[test]
    fn the_managed_shadow_repair_removes_the_shadow_and_spares_the_toolchain() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let node = root.join("node");
        let prefix = root.join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        for shim in [
            "hq",
            "hq.cmd",
            "hq.ps1",
            "hq-auth-refresh",
            "hq-auth-refresh.cmd",
        ] {
            std::fs::write(node.join(shim), HQ_CLI_SHIM_FIXTURE).unwrap();
        }
        write_hq_cli_manifest(&node, "5.101.0");
        write_hq_cli_manifest(&prefix, "5.101.7");
        for keep in ["node.exe", "npm.cmd", "npx.cmd"] {
            std::fs::write(node.join(keep), keep).unwrap();
        }
        let other = node.join("node_modules").join("left-pad");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("package.json"), "{}").unwrap();

        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
        assert_eq!(action, ManagedShadowRepairAction::Removed);
        for shim in [
            "hq",
            "hq.cmd",
            "hq.ps1",
            "hq-auth-refresh",
            "hq-auth-refresh.cmd",
        ] {
            assert!(!node.join(shim).exists(), "shim {shim} was removed");
        }
        assert!(!node
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists());
        for keep in ["node.exe", "npm.cmd", "npx.cmd"] {
            assert!(node.join(keep).exists(), "bystander {keep} survives");
        }
        assert!(
            other.join("package.json").exists(),
            "an unrelated global package survives"
        );
        assert!(prefix
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists());
    }

    /// The repair refuses (removes nothing) when the shadow is not @indigoai-us/hq-cli
    /// or when the managed prefix does not yet hold `>= latest`.
    #[test]
    fn the_managed_shadow_repair_refuses_an_unowned_shim_or_a_stale_prefix() {
        // Prefix lacks latest: refuse — removing the shadow would strand the user.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let node = root.join("node");
        let prefix = root.join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(node.join("hq.cmd"), "stale").unwrap();
        write_hq_cli_manifest(&node, "5.101.0");
        write_hq_cli_manifest(&prefix, "5.101.0");
        assert_eq!(
            repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7"),
            ManagedShadowRepairAction::ProvenanceRefused
        );
        assert!(node.join("hq.cmd").exists(), "nothing removed when refused");

        // Unowned shim: refuse — an unrelated `hq` is never removed.
        let temp2 = tempfile::tempdir().unwrap();
        let root2 = temp2.path();
        let node2 = root2.join("node");
        let prefix2 = root2.join("npm-prefix");
        std::fs::create_dir_all(&node2).unwrap();
        std::fs::create_dir_all(&prefix2).unwrap();
        std::fs::write(node2.join("hq.cmd"), "other hq").unwrap();
        let other = node2
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("package.json"),
            r#"{"name":"not-hq-cli","version":"9.9.9"}"#,
        )
        .unwrap();
        write_hq_cli_manifest(&prefix2, "5.101.7");
        assert_eq!(
            repair_managed_shadow(&node2.join("hq.cmd"), &prefix2, "5.101.7"),
            ManagedShadowRepairAction::ProvenanceRefused
        );
        assert!(node2.join("hq.cmd").exists(), "an unowned shim survives");
    }

    /// The same-root prefix selection that lets a wedged machine heal itself: it
    /// resolves the managed npm prefix for the root that owns the shadow, and
    /// refuses a foreign layout or the prefix copy itself.
    #[test]
    fn managed_prefix_for_shadow_finds_the_same_root_prefix_only() {
        let root = PathBuf::from("/opt/IndigoHQ/toolchain");
        let roots = [root.clone()];
        let node = root.join("node");
        let expected = paths::managed_npm_prefix_in(&root);
        // A shadow under <root>/node resolves the same-root managed prefix.
        assert_eq!(
            managed_prefix_for_shadow(&node.to_string_lossy(), &roots),
            Some(expected.clone())
        );
        // The prefix copy itself is not a shadow (active == prefix).
        assert_eq!(
            managed_prefix_for_shadow(&expected.to_string_lossy(), &roots),
            None
        );
        // A foreign layout outside every managed root is not a shadow.
        assert_eq!(managed_prefix_for_shadow("/opt/homebrew", &roots), None);
        // A cross-root split resolves the prefix of the root that actually owns the
        // shadow (the legacy root), never the current root's.
        let legacy = PathBuf::from("/opt/Indigo HQ/toolchain");
        let both = [root, legacy.clone()];
        assert_eq!(
            managed_prefix_for_shadow(&legacy.join("node").to_string_lossy(), &both),
            Some(paths::managed_npm_prefix_in(&legacy))
        );
    }
}
