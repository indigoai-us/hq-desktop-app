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
//!      `hq-cli-update:available` with both versions. When `cliAutoUpdate`
//!      is on (default), the background checker also installs it directly.
//!
//! A background task fires the check 15s after launch (offset from the
//! app updater's 10s so they don't both spike CPU at the same moment),
//! then every 6h. The result is also exposed as the `check_hq_cli_update`
//! Tauri command for on-demand polls.
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

#[allow(unused_imports)]
pub use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, auto_update_enabled, classify_install_failure,
    classify_install_failure_with_final_attempt, cli_auto_update_enabled, cmp_semver,
    decide_post_install, dismissed_cli_version, get_local_version, get_local_version_diagnostics,
    hq_cli_version_under_pnpm_root, hq_version_string, install_argv, install_converged,
    install_failure_detail, install_failure_detail_with_final_attempt, install_failure_report,
    installed_hq_cli_version_in_pnpm_store, installed_hq_cli_version_in_prefix,
    is_cli_update_dismissed, is_npm_bin_collision, is_pnpm_global_shim,
    is_prefix_permission_failure, is_windows_locked_binary_failure, legacy_marker_needs_recovery,
    non_convergent_cli_contract, non_convergent_cli_version, non_convergent_detail,
    non_convergent_episode_blocked, non_convergent_episode_key, non_convergent_episode_record,
    non_convergent_episode_reported, npm_install_attempt_summary, npm_lifecycle_cause,
    npm_prefix_from_hq_bin, path_contains_dir, pnpm_child_path, pnpm_global_env,
    pnpm_global_ls_hq_cli_version, pnpm_install_argv, pnpm_store_family,
    read_installed_version, redact_home, redact_home_in, report_install_failure,
    report_install_failure_episode, report_install_failure_with_environment,
    report_install_failure_with_final_attempt, report_non_convergent_install,
    report_non_convergent_marker_unpersisted, report_npm_cache_setup_failure,
    report_unreadable_version, resolved_hq_version, should_auto_install,
    should_report_unreadable_version, suppress_for_dismissal, version_from_hq_binary,
    version_if_hq_cli, AsyncSingleFlight, HqCliUpdateInfo, InstallEnvironment, InstallExecutor,
    InstallFailureEpisode, InstallFailureKind, LocalVersionProbeDiagnostics,
    LocalVersionProbeResult, NonConvergenceKind, NonConvergentReport, NpmLatest,
    NpmToolchainSource, PnpmGlobalEnv, PnpmHomeSource, PnpmRunDiagnostics, PnpmStoreFamily,
    PostInstallContext, PostInstallCoreEffects, PostInstallOutcome, VersionProbeOutcome,
    DISMISSED_VERSION_KEY,
    HQ_CLI_PACKAGE, NON_CONVERGENT_CONTRACT_KEY, NON_CONVERGENT_ERROR_PREFIX,
    NON_CONVERGENT_VERSION_KEY, PINNED_MARKER_CONTRACT,
};

/// npm registry endpoint that returns the dist-tag `latest` manifest. Cheap,
/// cached by the registry CDN, and returns a tiny JSON document.
const REGISTRY_URL: &str = "https://registry.npmjs.org/@indigoai-us/hq-cli/latest";

/// HTTP request timeout — keep tight so a flaky network doesn't stall the
/// background loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Offset from app launch before the first check fires. 15s vs. the app
/// updater's 10s so they don't spike CPU + network in lockstep on launch.
const INITIAL_DELAY: Duration = Duration::from_secs(15);

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

/// Perform one check. Returns `Some(info)` when an upgrade is available,
/// `None` when the user is already on the latest (or `hq` isn't installed
/// — we don't pester users who don't have the CLI).
pub async fn check_once(app: &AppHandle) -> Result<Option<HqCliUpdateInfo>, String> {
    let latest = fetch_latest().await?;
    let local_version = get_local_version_diagnostics();
    let local = local_version.local.clone();
    let update_available = match local.as_deref() {
        Some(l) => cmp_semver(l, &latest) == std::cmp::Ordering::Less,
        None => false,
    };
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
pub fn get_hq_cli_version() -> Option<String> {
    get_local_version()
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
    let scope = partial_install_scope_dir(prefix);

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
    let Ok(entries) = std::fs::read_dir(&scope) else {
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
    // hq-heal applies by hand. Requires a known prefix so we never delete outside
    // the app's own toolchain; with no prefix we leave the failure untouched.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_partial_install_failure(&detail) {
            if let Some(cleanup_prefix) = prefix {
                log(
                    "hq-cli-update",
                    &format!(
                        "install hit ENOTEMPTY partial install; cleaning and retrying: {detail}"
                    ),
                );
                clean_partial_hq_cli_install(cleanup_prefix);
                output = run_recorded_npm_install_attempt(
                    npm,
                    path,
                    npm_cache,
                    prefix,
                    base_args.clone(),
                    "cleanup-plain",
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
                    "install hit ENOTEMPTY but no resolved prefix; skipping cleanup retry",
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
    Ok(NpmInstallRun {
        output,
        final_attempt_forced,
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
        hq_desktop_core::first_run::merge_menubar_flags(&path, &[(NON_CONVERGENT_EPISODE_KEYS, array)])
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
async fn pnpm_probe_line(pnpm_bin: &str, path: &str, pnpm_home: &str, args: &[&str]) -> Option<String> {
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
    let ls_version = pnpm_probe_line(pnpm_bin, path, pnpm_home, &["ls", "-g", "--depth", "0", "--json"])
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
    let npm = paths::resolve_bin("npm");
    let path = paths::child_path();
    let hq = paths::resolve_bin("hq");
    // This must be sampled before the install, for either executor. An
    // unwritable marker reads as absent; the post-install gate then refuses to
    // capture unless this run successfully persists the first-episode marker.
    let non_convergent_version = non_convergent_cli_version();
    if is_pnpm_global_shim(&hq) {
        // Pin the target before spawning, same as the npm path below.
        let latest = fetch_latest().await?;
        let already_blocked =
            non_convergent_episode_blocked(non_convergent_version.as_deref(), &latest);
        return install_hq_cli_update_via_pnpm(&app, &hq, &latest, already_blocked).await;
    }
    // Derive the prefix from the RUNTIME of the resolved npm, not `hq` alone: if a
    // prior episode provisioned HQ's managed Node but left no managed `hq`, npm is
    // now managed (Node 22) while `hq` still resolves the user's Node-20 shim, and a
    // user-derived prefix would receive ABI-127 artifacts that runtime cannot load.
    let prefix = hq_cli_install_prefix(&npm, &hq);
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
        let failure_kind = classify_install_failure_with_final_attempt(
            install_run.output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
        );

        // Probe the user's failing toolchain ONCE, up front. The Node ABI is
        // retry-gate evidence — a run already on HQ's managed ABI, or a
        // disk-space/network cause, earns no provision — and the SAME probe is the
        // provenance the original-path report attaches below. `false`: this
        // describes the user's own toolchain, never HQ's managed retry.
        let install_env =
            probe_install_environment(&npm, &path, /* managed_toolchain_retry */ false).await;
        let failing_node_abi = install_env
            .node_abi
            .as_deref()
            .and_then(|abi| abi.trim().parse::<u32>().ok());
        let lifecycle_cause = npm_lifecycle_cause(&raw_detail);

        // HQ-DESKTOP-4V / HQ-DESKTOP-4W self-heal. A THIRD-PARTY native-build
        // lifecycle failure (better-sqlite3 / node-llama-cpp) under the user's OWN
        // Node is the one shape HQ can repair itself: the reported Node 20 arm64
        // Macs have no prebuilt binary for their ABI and no Xcode CLT to build from
        // source, while HQ already ships a checksum-verified managed Node 22 whose
        // ABI does have prebuilds. Only that shape — user-path, a cause a different
        // runtime can actually fix (never disk-space/network), and a failing ABI
        // that differs from HQ's managed one — arms the bounded, one-shot
        // managed-toolchain retry; every other kind/cause keeps today's behaviour.
        // Gating on UserPath + a differing ABI also means a run already on the
        // managed toolchain never retries into itself. HQ blames the user's
        // toolchain (the copy below) only AFTER its own repair was attempted and
        // could not converge.
        if install_failure_earns_managed_retry(
            failure_kind,
            install_env.toolchain_source,
            lifecycle_cause,
            failing_node_abi,
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
                Some(Ok(info)) => return Ok(info),
                // The retry ran but did not converge (npm failed under the managed
                // toolchain, or exited 0 into an unreachable prefix). It already
                // reported exactly once — with managed provenance for a failure,
                // or as non-convergence for a shadowed exit-0 — so surface its
                // detail without a second capture.
                Some(Err(detail)) => return Err(detail),
                // No retry happened (repair on cooldown, provisioning failed, or
                // the managed toolchain could not be resolved). Fall through and
                // report the ORIGINAL user-path failure exactly as today.
                None => {}
            }
        }

        // Report the original (user-path) failure through the repeat-guard so an
        // identical lifecycle failure that re-fires on every scheduled check pages
        // once, not forever. The raw npm output is passed so Sentry's diagnostic
        // extra is never replaced by the UI fallback text; expected environment
        // kinds still no-op in the reporter. `install_env` was probed above with
        // managed_toolchain_retry=false: this event describes the user's own
        // toolchain, never HQ's managed retry.
        let detail = install_failure_detail_with_final_attempt(
            install_run.output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
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
        persist_reported_episode(report_install_failure_episode(
            install_run.output.status.code(),
            &raw_detail,
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

/// Whether a failed install is the exact shape HQ can self-heal by installing its
/// managed Node and retrying: a third-party native-build lifecycle failure under
/// the user's OWN Node THAT A DIFFERENT RUNTIME CAN ACTUALLY REPAIR. Pure so the
/// gate is unit-testable without an `AppHandle` or a real install.
///
/// Four conditions, all required:
///   * `kind` is a third-party lifecycle failure (`UnexpectedLifecycle`);
///   * `source` is the user's own toolchain (`UserPath`) — a run already on the
///     managed toolchain cannot be improved by installing it again;
///   * `cause` is NOT one a new runtime cannot fix. A full disk (`disk-space`) or
///     a dead network (`network`) would only waste a ~50MB Node download — and a
///     disk-space failure can be made worse by one — so those are refused. Every
///     other cause (including the reported `unknown` and `toolchain-missing`) is
///     eligible, because a missing prebuild for the user's ABI is exactly what a
///     runtime whose ABI *does* have prebuilds repairs.
///   * the failing runtime's ABI differs from HQ's managed-Node ABI. A run already
///     on ABI 127 gains nothing from provisioning Node 22. An UNKNOWN ABI (the
///     probe could not read it) is treated as "not the managed ABI", so the
///     reported Node-20 (ABI 115) cluster still arms.
fn install_failure_earns_managed_retry(
    kind: InstallFailureKind,
    source: NpmToolchainSource,
    cause: &str,
    failing_node_abi: Option<u32>,
) -> bool {
    kind == InstallFailureKind::UnexpectedLifecycle
        && source == NpmToolchainSource::UserPath
        && !matches!(cause, "disk-space" | "network")
        && failing_node_abi != Some(MANAGED_NODE_ABI)
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
    let outcome = decide_post_install(&PostInstallContext::npm(
        before_bin,
        &post_install_hq,
        before_version,
        resolved.as_deref(),
        latest,
        prefix,
        installer_npm,
        already_blocked,
        delivered_version.as_deref(),
    ));
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
    if !managed_npm.exists() {
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
    let outcome = decide_post_install(&PostInstallContext::npm(
        before_bin,
        &post_install_hq,
        before_version,
        after_version,
        latest,
        Some(managed_prefix),
        installer_npm,
        already_blocked,
        delivered_version.as_deref(),
    ));
    log("hq-cli-update", &outcome.log_line);
    apply_post_install_with_app(app, &outcome)
}

/// User-facing detail for a managed-toolchain retry that itself FAILED. Unlike the
/// user-path builder (`install_failure_detail_with_final_attempt`, deliberately
/// left untouched), this must never advise installing Node 22 or blame the user's
/// runtime: HQ already retried under its OWN managed Node, so that advice cannot
/// change the runtime or ABI. Provenance-aware wording, plus a copyable-command
/// escape hatch and a support-facing next step.
fn managed_retry_failure_detail(exit_code: Option<i32>, raw_detail: &str) -> String {
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

/// Bounded, one-shot managed-toolchain self-heal for a third-party native-build
/// lifecycle failure under the user's own Node (HQ-DESKTOP-4V / HQ-DESKTOP-4W).
///
/// Returns:
///   * `Some(Ok(info))`    — HQ's managed Node was provisioned and the pinned
///     install converged (delivery + managed-prefix resolution + a live executable
///     probe) under it; NO Sentry event was emitted.
///   * `Some(Err(detail))` — the retry ran but did not converge; it already
///     reported exactly once (managed-provenance failure, or non-convergence), with
///     provenance-aware wording that never re-blames the user's runtime.
///   * `None`              — no retry happened (repair on cooldown, provisioning
///     failed, or the managed toolchain could not be resolved); the caller
///     reports the original user-path failure unchanged.
///
/// Provisioning goes through the shared `sync::repair_managed_node` seam — never
/// the lower-level Node installer directly — so the shared repair cooldown and the
/// single installer are preserved (the same contract HQ-DESKTOP-49 locked for the
/// Connect lane). The retry installs into HQ's OWN managed npm prefix (never the
/// user's), reusing the already-pinned `latest` — never `fetch_latest` again, so the
/// post-publish registry race commit 13ef8859 closed cannot reopen here. Exactly one
/// provision attempt and one re-run: there is no loop.
async fn managed_toolchain_retry(
    app: &AppHandle,
    hq: &str,
    latest: &str,
    npm_cache: &Path,
    before_version: Option<&str>,
    already_blocked: bool,
) -> Option<Result<HqCliUpdateInfo, String>> {
    // Provision through the shared seam. Only a fresh, successful provision earns
    // the retry; a cooldown-Skipped or a Failed repair falls straight through so
    // the caller still reports the original failure.
    match crate::commands::sync::repair_managed_node(app).await {
        ToolchainRepair::Repaired => {}
        ToolchainRepair::Skipped => {
            log(
                "hq-cli-update",
                "managed-toolchain retry skipped — a Node repair was attempted too recently",
            );
            return None;
        }
        ToolchainRepair::Failed(reason) => {
            log(
                "hq-cli-update",
                &format!(
                    "managed-toolchain retry unavailable — Node provisioning failed: {reason}"
                ),
            );
            return None;
        }
    }

    let (managed_npm, managed_path, managed_prefix) = managed_toolchain_npm_and_path()?;

    log(
        "hq-cli-update",
        "managed Node provisioned — retrying the pinned install once under HQ's managed toolchain, into HQ's managed npm prefix",
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
            return None;
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
        if converged.is_ok() {
            // Only NOW — with a managed CLI proven installed AND runnable — make its
            // bin dir reachable from the user's interactive shell. Deferring the
            // persistent PATH change until convergence means a FAILED retry never
            // shadows the user's still-working CLI under a mismatched Node.
            configure_managed_shell_path(app, &managed_prefix);
        }
        return Some(converged);
    }

    // The retry failed under the managed toolchain. Report exactly once, carrying
    // managed provenance (npm_managed_toolchain_retry=true, toolchain_source=
    // managed) through the same repeat-guard, with provenance-aware user-facing
    // wording that never re-blames the user's own runtime.
    let raw_detail = npm_output_detail(&retry_run.output);
    let detail = managed_retry_failure_detail(retry_run.output.status.code(), &raw_detail);
    log(
        "hq-cli-update",
        &format!(
            "managed-toolchain retry failed (exit {:?}); raw npm output retained locally: {raw_detail}",
            retry_run.output.status.code()
        ),
    );
    let install_env = probe_install_environment(
        &managed_npm,
        &managed_path,
        /* managed_toolchain_retry */ true,
    )
    .await;
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
    Some(Err(detail))
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
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            match check_once(&handle).await {
                Ok(Some(info)) => {
                    // Gate on the master `autoUpdate` switch (default ON). The
                    // legacy `cliAutoUpdate` key is superseded — one toggle now
                    // governs the app, CLI, and core auto-installers.
                    if auto_update_enabled() {
                        if should_auto_install(
                            &info.latest,
                            non_convergent_cli_version().as_deref(),
                        ) {
                            log("hq-cli-update", "auto-update enabled — installing");
                            match install_hq_cli_update(handle.clone()).await {
                                Ok(_) => log("hq-cli-update", "auto-update succeeded"),
                                Err(e) => log(
                                    "hq-cli-update",
                                    &format!("auto-update failed, banner remains: {e}"),
                                ),
                            }
                        } else {
                            // This exact version already installed cleanly
                            // without moving the detected CLI, so repeating it
                            // cannot help. Stop here instead of reinstalling on
                            // every launch and every 6h; the banner stays up for
                            // the manual fix.
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
                Ok(None) => {}
                Err(e) => log("hq-cli-update", &format!("background check failed: {e}")),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::ffi::{OsStr, OsString};

    // Serialize HOME mutation on the crate-wide env mutex so tests in other
    // modules that READ the process-global HOME (e.g. launch.rs reveal-target
    // tests, which lock the same mutex) never observe our temp poisoned-home.
    // A private lock here would only exclude this module's own tests.
    #[cfg(unix)]
    use crate::util::test_support::ENV_MUTEX as HOME_ENV_LOCK;

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
        for cause in ["unknown", "toolchain-missing", "prebuild-unavailable"] {
            assert!(
                install_failure_earns_managed_retry(
                    InstallFailureKind::UnexpectedLifecycle,
                    NpmToolchainSource::UserPath,
                    cause,
                    Some(115),
                ),
                "cause {cause:?} on user-path Node 20 must arm the managed retry"
            );
        }

        // A cause a NEW runtime cannot repair must NOT arm — provisioning a Node
        // would only waste a ~50MB download, and a full disk can be made worse.
        for cause in ["disk-space", "network"] {
            assert!(
                !install_failure_earns_managed_retry(
                    InstallFailureKind::UnexpectedLifecycle,
                    NpmToolchainSource::UserPath,
                    cause,
                    Some(115),
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
        ));

        // An UNKNOWN ABI (the probe could not read it) is treated as not-managed,
        // so the retry still arms — the reported cluster must never be gated out by
        // a missing ABI probe.
        assert!(install_failure_earns_managed_retry(
            InstallFailureKind::UnexpectedLifecycle,
            NpmToolchainSource::UserPath,
            "unknown",
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
            ));
        }

        // Every non-lifecycle kind keeps today's behaviour, even under user-path
        // Node with an eligible cause/ABI, so no expected/permission/Windows/
        // registry failure ever triggers a managed provision.
        for kind in [
            InstallFailureKind::ExpectedPrefixPermission,
            InstallFailureKind::ExpectedWindowsAbort,
            InstallFailureKind::ExpectedWindowsLockedBinary,
            InstallFailureKind::ExpectedTransientRegistry,
            InstallFailureKind::ExpectedBinCollision,
            InstallFailureKind::Unexpected,
        ] {
            assert!(
                !install_failure_earns_managed_retry(
                    kind,
                    NpmToolchainSource::UserPath,
                    "unknown",
                    Some(115),
                ),
                "kind {kind:?} must not arm the managed-toolchain retry"
            );
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
            managed_retry_failure_detail(Some(1), "npm error code 1\ngyp ERR! build error");
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
        let empty = managed_retry_failure_detail(None, "   ");
        let empty_lower = empty.to_lowercase();
        assert!(empty_lower.contains("managed node"));
        assert!(empty.contains("copied command"));
        assert!(!empty.contains("version 22"));
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
    #[tokio::test]
    async fn app_owned_cache_avoids_a_read_only_home_npm_cache() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let _home_lock = HOME_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
}
