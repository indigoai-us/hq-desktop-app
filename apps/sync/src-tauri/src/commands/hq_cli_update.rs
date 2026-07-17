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
//! a second, shadowed copy. On success it re-checks and emits a fresh
//! `hq-cli-update:cleared` event; on failure it returns stderr so the UI can
//! fall back to the manual copy-the-command flow (typical failure: EACCES
//! against a system-prefix npm that needs sudo).

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::util::logfile::log;
use crate::util::paths;

#[allow(unused_imports)]
pub use hq_desktop_core::hq_cli_update::{
    auto_update_enabled, cli_auto_update_enabled, cmp_semver, dismissed_cli_version,
    get_local_version,
    hq_version_string, install_argv, install_failure_report, is_cli_update_dismissed,
    is_prefix_permission_failure, npm_prefix_from_hq_bin, read_installed_version,
    report_install_failure, report_unreadable_version, suppress_for_dismissal,
    version_from_hq_binary, version_if_hq_cli, HqCliUpdateInfo, NpmLatest, DISMISSED_VERSION_KEY,
    HQ_CLI_PACKAGE,
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
    let local = get_local_version();
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
    if local.is_none() && paths::resolve_bin("hq") != "hq" {
        report_unreadable_version(&latest);
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
fn is_bin_exists_failure(detail: &str) -> bool {
    detail.contains("EEXIST")
}

/// Spawn `npm <args>` on the blocking pool with the beefed-up child PATH and
/// collect its Output. Errors map to a String (join / spawn failures only —
/// a non-zero npm exit is a successful run that returns a failing status).
async fn run_npm_install(
    npm: &str,
    path: &str,
    args: Vec<String>,
) -> Result<std::process::Output, String> {
    let npm = npm.to_string();
    let path = path.to_string();
    log("hq-cli-update", &format!("install: spawning {} {}", npm, args.join(" ")));
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = paths::spawn_command(&npm, &[]);
        cmd.args(&args).env("PATH", path).output()
    })
    .await
    .map_err(|e| format!("join blocking task: {e}"))?
    .map_err(|e| format!("spawn npm: {e}"))
}

#[tauri::command]
pub async fn install_hq_cli_update(app: AppHandle) -> Result<HqCliUpdateInfo, String> {
    let npm = paths::resolve_bin("npm");
    let path = paths::child_path();
    let hq = paths::resolve_bin("hq");
    let prefix = npm_prefix_from_hq_bin(&hq);
    let base_args = install_argv(prefix.as_deref());
    log(
        "hq-cli-update",
        &format!(
            "install: {} (prefix={})",
            base_args.join(" "),
            prefix.as_deref().unwrap_or("npm default prefix")
        ),
    );

    // First attempt: a plain (non-forced) global install.
    let mut output = run_npm_install(&npm, &path, base_args.clone()).await?;

    // EEXIST bin collision: an existing `<prefix>/bin/hq` npm didn't create
    // blocks the bin-link, so npm bails rather than clobber it. Retry ONCE with
    // --force to overwrite the stale CLI the user is updating (HQ-SYNC-B) —
    // npm's own documented remedy. Only this specific failure arms the forced
    // retry; every other failure falls straight through to the error below.
    if !output.status.success() {
        let detail = npm_output_detail(&output);
        if is_bin_exists_failure(&detail) {
            log(
                "hq-cli-update",
                &format!("install hit EEXIST bin collision; retrying with --force: {detail}"),
            );
            let mut forced = base_args.clone();
            forced.push("--force".to_string());
            output = run_npm_install(&npm, &path, forced).await?;
        }
    }

    if !output.status.success() {
        let detail = npm_output_detail(&output);
        log(
            "hq-cli-update",
            &format!("install failed (exit {:?}): {detail}", output.status.code()),
        );
        report_install_failure(output.status.code(), &detail);
        return Err(if detail.is_empty() {
            format!("npm install exited with status {:?}", output.status.code())
        } else {
            detail
        });
    }

    // npm exit 0 means the @latest tag installed successfully. Read back the
    // version through the same binary-anchored path used by normal detection
    // so the cleared event reflects the `hq` the app will actually execute.
    // `read_installed_version` asks npm's default global prefix, which may be
    // different from the explicit `--prefix` used above.
    let latest = fetch_latest().await?;
    let local = tauri::async_runtime::spawn_blocking(get_local_version)
        .await
        .ok()
        .flatten()
        .or_else(|| Some(latest.clone()));
    log(
        "hq-cli-update",
        &format!("install succeeded: local={:?} latest={}", local, latest),
    );
    let info = HqCliUpdateInfo {
        local,
        latest: latest.clone(),
    };
    // Frontend uses this to drop the banner immediately on success.
    let _ = app.emit("hq-cli-update:cleared", &info);
    Ok(info)
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
                Ok(Some(_)) => {
                    // Gate on the master `autoUpdate` switch (default ON). The
                    // legacy `cliAutoUpdate` key is superseded — one toggle now
                    // governs the app, CLI, and core auto-installers.
                    if auto_update_enabled() {
                        log("hq-cli-update", "auto-update enabled — installing");
                        match install_hq_cli_update(handle.clone()).await {
                            Ok(_) => log("hq-cli-update", "auto-update succeeded"),
                            Err(e) => log(
                                "hq-cli-update",
                                &format!("auto-update failed, banner remains: {e}"),
                            ),
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

    // HQ-SYNC-B: an EEXIST bin collision (a stale `<prefix>/bin/hq` npm didn't
    // create) must be the ONLY failure that arms the forced retry. Other npm
    // failures (EACCES, network, empty) must fall straight through.
    #[test]
    fn eexist_is_the_only_failure_that_arms_the_forced_retry() {
        assert!(is_bin_exists_failure(
            "npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/hq"
        ));
        assert!(!is_bin_exists_failure(
            "npm ERR! code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'"
        ));
        assert!(!is_bin_exists_failure("npm ERR! network timeout"));
        assert!(!is_bin_exists_failure(""));
    }

    // The forced retry reuses the base args plus `--force`, still targeting the
    // global hq-cli install — it just overwrites the stale bin link.
    #[test]
    fn forced_retry_args_add_force_to_a_global_install() {
        let mut forced = install_argv(None);
        forced.push("--force".to_string());
        assert!(forced.iter().any(|a| a == "--force"), "retry must carry --force");
        assert_eq!(forced[0], "install");
        assert!(forced.iter().any(|a| a == "-g"), "must stay a global install");
    }
}
