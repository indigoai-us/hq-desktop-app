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
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::util::logfile::log;
use crate::util::paths;

#[allow(unused_imports)]
pub use hq_desktop_core::hq_cli_update::{
    auto_update_enabled, classify_install_failure, classify_install_failure_with_final_attempt,
    cli_auto_update_enabled, cmp_semver, dismissed_cli_version, get_local_version,
    get_local_version_diagnostics, hq_version_string, install_argv, install_converged,
    install_failure_detail, install_failure_detail_with_final_attempt, install_failure_report,
    is_cli_update_dismissed, is_npm_bin_collision, is_pnpm_global_shim, is_prefix_permission_failure,
    is_windows_locked_binary_failure, non_convergent_cli_version, non_convergent_detail,
    npm_install_attempt_summary, npm_prefix_from_hq_bin, pnpm_install_argv, read_installed_version,
    redact_home,
    redact_home_in, report_install_failure, report_install_failure_with_final_attempt,
    report_non_convergent_install, report_npm_cache_setup_failure, report_unreadable_version,
    resolved_hq_version, should_auto_install, should_report_unreadable_version,
    suppress_for_dismissal, version_from_hq_binary, version_if_hq_cli, HqCliUpdateInfo,
    InstallFailureKind, LocalVersionProbeDiagnostics, LocalVersionProbeResult, NpmLatest,
    VersionProbeOutcome, DISMISSED_VERSION_KEY, HQ_CLI_PACKAGE, NON_CONVERGENT_ERROR_PREFIX,
    NON_CONVERGENT_VERSION_KEY,
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

fn verify_active_cli_version(local: Option<String>, latest: &str) -> Result<String, String> {
    match local {
        Some(local) if install_converged(Some(&local), latest) => Ok(local),
        Some(local) => Err(format!(
            "npm completed, but the active HQ CLI is still v{local} (expected v{latest}). \
             The update was not applied to the CLI on PATH."
        )),
        None => Err(format!(
            "npm completed, but the active HQ CLI version could not be verified \
             (expected v{latest})."
        )),
    }
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
) -> Result<HqCliUpdateInfo, String> {
    const MANUAL_CMD: &str = "pnpm add -g @indigoai-us/hq-cli@latest";
    let pnpm = paths::resolve_bin("pnpm");
    if pnpm == "pnpm" {
        return Err(format!(
            "hq was installed with pnpm, but pnpm could not be found. \
             Update manually: {MANUAL_CMD}"
        ));
    }
    let path = paths::child_path();
    let args = pnpm_install_argv();
    log(
        "hq-cli-update",
        &format!("install: pnpm-managed hq detected — spawning pnpm {}", args.join(" ")),
    );
    let output = {
        let pnpm = pnpm.clone();
        let path = path.clone();
        let args = args.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = paths::spawn_command(&pnpm, &[]);
            cmd.args(&args).env("PATH", &path);
            cmd.output()
        })
        .await
        .map_err(|e| format!("join blocking task: {e}"))?
        .map_err(|e| format!("spawn pnpm: {e}"))?
    };
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
    // Same convergence gate as the npm path: a zero exit must have moved the
    // binary the app actually resolves.
    let resolved = {
        let hq = hq.to_string();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    let local = match verify_active_cli_version(resolved.clone(), latest) {
        Ok(version) => version,
        Err(reason) => {
            log(
                "hq-cli-update",
                &format!("{reason} — pnpm path, hq={} — recording as non-convergent", redact_home(hq)),
            );
            record_non_convergent_version(latest);
            report_non_convergent_install(latest, resolved.as_deref(), hq, None);
            return Err(non_convergent_detail(hq, resolved.as_deref(), latest));
        }
    };
    clear_non_convergent_version();
    log(
        "hq-cli-update",
        &format!("pnpm install succeeded: local={local} latest={latest}"),
    );
    let info = HqCliUpdateInfo {
        local: Some(local),
        latest: latest.to_string(),
    };
    let _ = app.emit("hq-cli-update:cleared", &info);
    Ok(info)
}

#[tauri::command]
pub async fn install_hq_cli_update(app: AppHandle) -> Result<HqCliUpdateInfo, String> {
    let npm = paths::resolve_bin("npm");
    let path = paths::child_path();
    let hq = paths::resolve_bin("hq");
    if is_pnpm_global_shim(&hq) {
        // Pin the target before spawning, same as the npm path below.
        let latest = fetch_latest().await?;
        return install_hq_cli_update_via_pnpm(&app, &hq, &latest).await;
    }
    let prefix = npm_prefix_from_hq_bin(&hq);
    let base_args = install_argv(prefix.as_deref());
    let npm_cache = app_npm_cache(&app).map_err(|(category, error)| {
        report_npm_cache_setup_failure(category);
        error
    })?;

    // Pin the target BEFORE spawning npm. Reading `latest` afterwards races a
    // publish: npm can resolve `@latest` to A while a post-install fetch returns
    // a freshly-published B, and we would then judge the installed A against B,
    // call it non-convergent, and permanently block auto-installs of a version
    // nothing ever attempted. Resolving first keeps the comparison and the
    // recorded block bound to the version this run actually asked npm for.
    let latest = fetch_latest().await?;
    log(
        "hq-cli-update",
        &format!(
            "install: {} (prefix={})",
            base_args.join(" "),
            prefix.as_deref().unwrap_or("npm default prefix")
        ),
    );

    let install_run =
        run_npm_install_with_retries(&npm, &path, &npm_cache, prefix.as_deref(), base_args).await?;
    let output = install_run.output;

    if !output.status.success() {
        let raw_detail = npm_output_detail(&output);
        let failure_kind = classify_install_failure_with_final_attempt(
            output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
        );
        let detail = install_failure_detail_with_final_attempt(
            output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
        );
        log(
            "hq-cli-update",
            &format!(
                "install failed (kind={}, exit {:?}); raw npm output retained locally: {raw_detail}",
                failure_kind.fingerprint_component(),
                output.status.code()
            ),
        );
        // Report using the original npm output so Sentry's diagnostic extra is
        // never replaced by the UI fallback text. Expected environment kinds
        // deliberately no-op inside `report_install_failure`.
        report_install_failure_with_final_attempt(
            output.status.code(),
            &raw_detail,
            prefix.as_deref(),
            install_run.final_attempt_forced,
        );
        return Err(detail);
    }

    // npm exit 0 means the @latest tag installed successfully. Read back the
    // version through the same binary-anchored path used by normal detection
    // so the cleared event reflects the `hq` the app will actually execute.
    // `read_installed_version` asks npm's default global prefix, which may be
    // different from the explicit `--prefix` used above.
    // Convergence gate. A zero exit only proves npm wrote a package somewhere;
    // it does NOT prove the write landed on the CLI this app runs. When the
    // resolved `hq` is managed by something npm cannot replace — a pnpm shim, a
    // Homebrew formula, a copy earlier on PATH — npm installs into an unrelated
    // prefix and exits 0. Without this check the loop reinstalls 15s after every
    // launch and every 6h forever, logging "install succeeded" each time while
    // the user stays stale.
    //
    // The probe is `resolved_hq_version`, NOT `get_local_version`: the latter
    // falls back to `npm root -g`, which in exactly this situation reports the
    // freshly-installed copy in npm's own prefix while the executable the app
    // resolves is untouched. Accepting that would trade a loud loop for a silent
    // lie — "up to date" forever, while the app keeps running the old binary.
    let resolved = {
        let hq = hq.clone();
        tauri::async_runtime::spawn_blocking(move || resolved_hq_version(&hq))
            .await
            .ok()
            .flatten()
    };
    let local = match verify_active_cli_version(resolved.clone(), &latest) {
        Ok(version) => version,
        Err(reason) => {
            // Re-running cannot change this, so record the version and let the
            // background loop stop retrying it. `non_convergent_detail` carries
            // the marker + remedy the UI shows in place of the generic
            // copy-the-command text, which here would just repeat the failure.
            let hq_display = if hq == "hq" { "PATH" } else { hq.as_str() };
            log(
                "hq-cli-update",
                &format!(
                    "{reason} — hq={hq_display} prefix={} — recording as non-convergent",
                    prefix.as_deref().unwrap_or("npm default prefix"),
                ),
            );
            record_non_convergent_version(&latest);
            report_non_convergent_install(
                &latest,
                resolved.as_deref(),
                hq_display,
                prefix.as_deref(),
            );
            return Err(non_convergent_detail(
                hq_display,
                resolved.as_deref(),
                &latest,
            ));
        }
    };

    // A convergent install clears any earlier block so a future version is
    // never gated by a condition the user has since fixed.
    clear_non_convergent_version();
    log(
        "hq-cli-update",
        &format!("install succeeded: local={} latest={}", local, latest),
    );
    let info = HqCliUpdateInfo {
        local: Some(local),
        latest: latest.clone(),
    };
    // Frontend uses this to drop the banner immediately on success.
    let _ = app.emit("hq-cli-update:cleared", &info);
    Ok(info)
}

/// Persist the `latest` that installed cleanly but did not move the detected
/// version, so `setup_hq_cli_update_checker` stops auto-retrying it. Written
/// through the untyped-merge path for the same reason as the dismissal flag:
/// `save_settings` only writes typed `MenubarPrefs` fields and would drop it.
/// Failures are logged, not propagated — losing the marker only costs us a
/// redundant retry, and must never mask the real error being returned.
fn record_non_convergent_version(latest: &str) {
    let write = paths::menubar_json_path().and_then(|path| {
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[(
                NON_CONVERGENT_VERSION_KEY,
                Value::String(latest.to_string()),
            )],
        )
    });
    if let Err(e) = write {
        log(
            "hq-cli-update",
            &format!("could not record non-convergent version {latest}: {e}"),
        );
    }
}

/// Clear the non-convergent marker after an install that actually converged.
fn clear_non_convergent_version() {
    if non_convergent_cli_version().is_none() {
        return;
    }
    let write = paths::menubar_json_path().and_then(|path| {
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[(NON_CONVERGENT_VERSION_KEY, Value::Null)],
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
    use std::ffi::{OsStr, OsString};
    #[cfg(unix)]
    use std::sync::{Mutex, OnceLock};

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
        let args = install_argv(Some("/tmp/hq-prefix"));
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
                install_argv(Some(prefix.to_str().unwrap())),
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
            install_argv(Some(prefix.to_str().unwrap())),
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
            install_argv(Some(prefix.to_str().unwrap())),
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
            install_argv(Some(prefix.to_str().unwrap())),
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
        let mut forced = install_argv(None);
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
    fn active_cli_verification_rejects_the_stale_post_install_loop() {
        assert_eq!(
            verify_active_cli_version(Some("5.79.0".to_string()), "5.79.0"),
            Ok("5.79.0".to_string())
        );
        let stale = verify_active_cli_version(Some("5.77.7".to_string()), "5.79.0").unwrap_err();
        assert!(stale.contains("still v5.77.7"), "{stale}");
        assert!(stale.contains("not applied to the CLI on PATH"), "{stale}");
        let missing = verify_active_cli_version(None, "5.79.0").unwrap_err();
        assert!(missing.contains("could not be verified"), "{missing}");
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
}
