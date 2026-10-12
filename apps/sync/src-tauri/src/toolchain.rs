//! Claude Code in the app's managed toolchain (US-010).
//!
//! Bots started by the app run `claude`. On a clean Mac nothing has installed
//! it, so the app installs `@anthropic-ai/claude-code` into the SAME npm prefix
//! it installs hq-cli into — `<toolchain>/npm-global` (macOS:
//! `~/Library/Application Support/Indigo HQ/toolchain/npm-global`) — so
//! `toolchain/npm-global/bin/claude` exists and hq-cli's bot runtime finds it
//! first (contract section 3, "Claude resolution for bots").
//!
//! Cadence: the hq-cli update checker (`commands::hq_cli_update`) calls
//! [`ensure_claude_toolchain`] at launch (install only when absent, no network
//! when present) and again after every hq-cli check cycle (update when the
//! registry's `latest` is newer). So Claude Code is installed on first run and
//! kept current on exactly the hq-cli cadence.
//!
//! Every failure here is logged and swallowed: a missing Claude Code is the
//! setup bot's problem to explain, never a reason for the app to fail.
//!
//! The install decision ([`decide_claude_install`]) is pure so it is tested
//! without a network or an npm.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;

use crate::commands::hq_cli_update::{app_npm_cache, managed_toolchain_npm_and_path, npm_install_command};
use crate::util::logfile::log;
use hq_desktop_core::hq_cli_update::redact_home;

const LOG_TAG: &str = "claude-toolchain";

/// The npm package the toolchain carries.
pub const CLAUDE_CODE_PACKAGE: &str = "@anthropic-ai/claude-code";
const CLAUDE_CODE_REGISTRY_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(10);
/// A first install downloads a sizeable package; give npm room but never hang
/// the checker loop forever.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What one pass may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureMode {
    /// Launch: install only when the binary is absent. No network otherwise.
    InstallIfAbsent,
    /// Update cadence: also move a present install to the registry's latest.
    Update,
}

/// Why a pass installs or stands down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeInstallDecision {
    Install(&'static str),
    Skip(&'static str),
}

/// Pure install decision.
///
/// * absent → install, in every mode and regardless of the auto-update
///   toggle: a bot cannot run without it, so this is a first install, not an
///   update.
/// * present, `Update` mode, a readable installed version below a known
///   `latest`, auto-update on → install.
/// * everything else → skip, with the reason.
pub fn decide_claude_install(
    mode: EnsureMode,
    present: bool,
    installed: Option<&str>,
    latest: Option<&str>,
    auto_update: bool,
) -> ClaudeInstallDecision {
    if !present {
        return ClaudeInstallDecision::Install("absent");
    }
    if mode == EnsureMode::InstallIfAbsent {
        return ClaudeInstallDecision::Skip("present");
    }
    if !auto_update {
        return ClaudeInstallDecision::Skip("auto-update off");
    }
    let (Some(installed), Some(latest)) = (installed, latest) else {
        return ClaudeInstallDecision::Skip("version unknown");
    };
    match hq_desktop_core::hq_cli_update::cmp_semver(installed, latest) {
        std::cmp::Ordering::Less => ClaudeInstallDecision::Install("outdated"),
        _ => ClaudeInstallDecision::Skip("current"),
    }
}

/// Where npm puts the `claude` shim under a managed prefix.
pub fn claude_bin_in(prefix: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        prefix.join("claude.cmd")
    }
    #[cfg(not(target_os = "windows"))]
    {
        prefix.join("bin").join("claude")
    }
}

/// `package.json` of the installed package under a managed prefix.
pub fn claude_package_json_in(prefix: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let scope = prefix.join("node_modules");
    #[cfg(not(target_os = "windows"))]
    let scope = prefix.join("lib").join("node_modules");
    scope
        .join("@anthropic-ai")
        .join("claude-code")
        .join("package.json")
}

#[derive(Deserialize)]
struct PackageJson {
    version: Option<String>,
}

/// Installed version read from the package's own `package.json`, no process
/// spawn. `None` when absent or unreadable.
pub fn installed_claude_version(prefix: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(claude_package_json_in(prefix)).ok()?;
    serde_json::from_str::<PackageJson>(&raw)
        .ok()?
        .version
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The shim exists and (on unix) resolves to a real file.
pub fn claude_present(prefix: &Path) -> bool {
    std::fs::metadata(claude_bin_in(prefix)).map(|m| m.is_file()).unwrap_or(false)
}

/// Exact npm argv for the install.
pub fn claude_install_args(prefix: &str) -> Vec<String> {
    vec![
        "install".into(),
        "-g".into(),
        "--prefix".into(),
        prefix.into(),
        format!("{CLAUDE_CODE_PACKAGE}@latest"),
    ]
}

async fn fetch_latest_claude_version() -> Result<String, String> {
    #[derive(Deserialize)]
    struct Latest {
        version: String,
    }
    let client = reqwest::Client::builder()
        .default_headers(crate::util::client_info::client_headers())
        .timeout(REGISTRY_TIMEOUT)
        .build()
        .map_err(|e| format!("build client: {e}"))?;
    let response = client
        .get(CLAUDE_CODE_REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("GET registry: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("registry returned HTTP {}", response.status()));
    }
    let parsed: Latest = response
        .json()
        .await
        .map_err(|e| format!("parse registry JSON: {e}"))?;
    Ok(parsed.version)
}

/// Install or update Claude Code in the managed prefix per
/// [`decide_claude_install`]. Never returns an error: outcomes are logged.
pub async fn ensure_claude_toolchain(app: &AppHandle, mode: EnsureMode) {
    if !crate::scratch_build::launch_side_effect_allowed("Claude Code toolchain install") {
        return;
    }
    let Some((npm, path, prefix)) = managed_toolchain_npm_and_path() else {
        log(LOG_TAG, "managed Node/npm not provisioned yet; Claude Code install deferred to the next pass");
        return;
    };
    let prefix_path = PathBuf::from(&prefix);
    let present = claude_present(&prefix_path);
    let installed = installed_claude_version(&prefix_path);
    let latest = if present && mode == EnsureMode::Update {
        match fetch_latest_claude_version().await {
            Ok(version) => Some(version),
            Err(error) => {
                log(LOG_TAG, &format!("latest version lookup failed: {error}"));
                None
            }
        }
    } else {
        None
    };
    let auto_update = hq_desktop_core::hq_cli_update::auto_update_enabled();
    let decision = decide_claude_install(mode, present, installed.as_deref(), latest.as_deref(), auto_update);
    let reason = match decision {
        ClaudeInstallDecision::Skip(reason) => {
            log(
                LOG_TAG,
                &format!(
                    "{mode:?}: skip ({reason}); installed={} latest={} at {}",
                    installed.as_deref().unwrap_or("-"),
                    latest.as_deref().unwrap_or("-"),
                    redact_home(&prefix)
                ),
            );
            return;
        }
        ClaudeInstallDecision::Install(reason) => reason,
    };
    log(
        LOG_TAG,
        &format!(
            "{mode:?}: installing {CLAUDE_CODE_PACKAGE} ({reason}; installed={} latest={}) into {}",
            installed.as_deref().unwrap_or("-"),
            latest.as_deref().unwrap_or("-"),
            redact_home(&prefix)
        ),
    );
    let npm_cache = match app_npm_cache(app) {
        Ok(cache) => cache,
        Err((_, error)) => {
            log(LOG_TAG, &format!("npm cache unavailable: {error}"));
            return;
        }
    };
    let args = claude_install_args(&prefix);
    let run = tauri::async_runtime::spawn_blocking(move || {
        npm_install_command(&npm, &path, &npm_cache, &args).output()
    });
    let output = match tokio::time::timeout(INSTALL_TIMEOUT, run).await {
        Err(_) => {
            log(LOG_TAG, "install timed out; will retry on the next pass");
            return;
        }
        Ok(Err(error)) => {
            log(LOG_TAG, &format!("install task failed: {error}"));
            return;
        }
        Ok(Ok(Err(error))) => {
            log(LOG_TAG, &format!("spawn npm failed: {error}"));
            return;
        }
        Ok(Ok(Ok(output))) => output,
    };
    if output.status.success() && claude_present(&prefix_path) {
        log(
            LOG_TAG,
            &format!(
                "installed {CLAUDE_CODE_PACKAGE} {} at {}",
                installed_claude_version(&prefix_path).unwrap_or_else(|| "?".into()),
                redact_home(&claude_bin_in(&prefix_path).to_string_lossy())
            ),
        );
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        log(
            LOG_TAG,
            &format!(
                "install failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                redact_home(detail.trim())
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_installs_in_every_mode_even_with_auto_update_off() {
        for mode in [EnsureMode::InstallIfAbsent, EnsureMode::Update] {
            assert_eq!(
                decide_claude_install(mode, false, None, None, false),
                ClaudeInstallDecision::Install("absent"),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn present_at_launch_never_touches_the_network_or_installs() {
        assert_eq!(
            decide_claude_install(EnsureMode::InstallIfAbsent, true, Some("1.0.0"), Some("9.0.0"), true),
            ClaudeInstallDecision::Skip("present")
        );
    }

    #[test]
    fn outdated_installs_on_the_update_cadence() {
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, Some("1.0.0"), Some("1.0.1"), true),
            ClaudeInstallDecision::Install("outdated")
        );
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, Some("1.2.0"), Some("1.2.0"), true),
            ClaudeInstallDecision::Skip("current")
        );
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, Some("2.0.0"), Some("1.9.9"), true),
            ClaudeInstallDecision::Skip("current")
        );
    }

    #[test]
    fn update_honours_the_auto_update_toggle_and_unknown_versions() {
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, Some("1.0.0"), Some("2.0.0"), false),
            ClaudeInstallDecision::Skip("auto-update off")
        );
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, None, Some("2.0.0"), true),
            ClaudeInstallDecision::Skip("version unknown")
        );
        assert_eq!(
            decide_claude_install(EnsureMode::Update, true, Some("1.0.0"), None, true),
            ClaudeInstallDecision::Skip("version unknown")
        );
    }

    #[test]
    fn presence_and_version_come_from_the_managed_prefix_layout() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = dir.path();
        assert!(!claude_present(prefix));
        assert!(installed_claude_version(prefix).is_none());

        let pkg = claude_package_json_in(prefix);
        std::fs::create_dir_all(pkg.parent().unwrap()).unwrap();
        std::fs::write(&pkg, r#"{"name":"@anthropic-ai/claude-code","version":"1.2.3"}"#).unwrap();
        let bin = claude_bin_in(prefix);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/usr/bin/env node\n").unwrap();

        assert!(claude_present(prefix));
        assert_eq!(installed_claude_version(prefix).as_deref(), Some("1.2.3"));
        #[cfg(not(target_os = "windows"))]
        assert!(bin.ends_with("bin/claude"));
        #[cfg(not(target_os = "windows"))]
        assert!(prefix.join("npm-global").parent().is_some());
    }

    #[test]
    fn install_argv_targets_the_same_prefix_as_hq_cli() {
        assert_eq!(
            claude_install_args("/Users/x/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            vec![
                "install",
                "-g",
                "--prefix",
                "/Users/x/Library/Application Support/Indigo HQ/toolchain/npm-global",
                "@anthropic-ai/claude-code@latest",
            ]
        );
    }

    #[test]
    fn a_decision_test_never_spawns_or_fetches() {
        // Guard: the pure decision takes versions, so tests above run with no
        // npm and no network. If someone makes it async or hands it an
        // AppHandle, this file stops compiling the way it is written.
        let _: fn(EnsureMode, bool, Option<&str>, Option<&str>, bool) -> ClaudeInstallDecision =
            decide_claude_install;
    }
}
