//! Auto-provision the Codex CLI (`@openai/codex`) into HQ's managed
//! npm-global prefix.
//!
//! Why the app installs a third-party CLI at all: "Open in Codex" can only
//! hand the Codex desktop app a workspace through the CLI's `codex app
//! <path>` subcommand. Every other route was tested and does not work — the
//! bare `codex://threads/new?cwd=…` deep link is honored only when the CLI
//! itself dispatches it, and a folder passed as an open-document is ignored
//! (the app sits on "Choose project"). So on a machine without the CLI the
//! button can only open a blank Codex, and the owner's call was: ship the
//! CLI with the app so the button just works.
//!
//! Where it installs: the managed npm-global prefix
//! (`<toolchain>/npm-global`), whose bin directory the installer already
//! exports onto the user's shell PATH and `extended_search_path()` already
//! reaches. That means one install makes codex visible to the login-shell
//! detection probe, `launch_codex_workspace`, and the user's own terminal —
//! no additional wiring.
//!
//! What it deliberately does NOT do: version convergence, dist-tag pinning,
//! shadow healing — the `hq_cli_update` machinery. Codex only needs to be
//! PRESENT; its own `codex update` handles freshness. One provisioning
//! attempt per app launch, gated on the master auto-update toggle, skipped
//! entirely when any codex is already resolvable.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use tauri::AppHandle;

use crate::commands::install_deps::extended_search_path;
use crate::util::logfile::log;

const CODEX_PACKAGE: &str = "@openai/codex";
const INITIAL_DELAY: Duration = Duration::from_secs(120);

/// The managed npm-global prefix (`<toolchain>/npm-global`).
fn managed_npm_global_prefix() -> Option<PathBuf> {
    let root = crate::util::paths::managed_toolchain_roots()
        .into_iter()
        .next()?;
    Some(hq_desktop_core::paths::managed_npm_prefix_in(&root))
}

/// Where a managed-prefix codex lands: `<prefix>/bin/codex` on unix, the
/// prefix root's `codex.cmd` on Windows (npm's global-bin layout).
pub fn managed_codex_bin() -> Option<PathBuf> {
    let prefix = managed_npm_global_prefix()?;
    #[cfg(windows)]
    {
        Some(prefix.join("codex.cmd"))
    }
    #[cfg(not(windows))]
    {
        Some(prefix.join("bin").join("codex"))
    }
}

/// Pure decision: provision only when nothing resolvable exists and the
/// master auto-update switch is on. Split out for tests.
pub fn should_provision(
    codex_cli_detected: bool,
    managed_bin_exists: bool,
    auto_update_on: bool,
) -> bool {
    auto_update_on && !codex_cli_detected && !managed_bin_exists
}

/// Pure argv builder, pinned by tests: a plain latest install into the
/// managed prefix. No dist-tag pin — presence, not convergence, is the goal.
pub fn codex_install_argv(prefix: &str) -> Vec<String> {
    vec![
        "install".to_string(),
        "-g".to_string(),
        "--prefix".to_string(),
        prefix.to_string(),
        CODEX_PACKAGE.to_string(),
    ]
}

fn managed_npm() -> Option<PathBuf> {
    let root = crate::util::paths::managed_toolchain_roots()
        .into_iter()
        .next()?;
    let npm = hq_desktop_core::paths::managed_npm_bin_in(&root).join(if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    });
    npm.exists().then_some(npm)
}

fn run_codex_install() -> Result<(), String> {
    let prefix = managed_npm_global_prefix()
        .ok_or_else(|| "no managed toolchain root resolved".to_string())?;
    let npm = managed_npm().ok_or_else(|| "managed npm not present".to_string())?;
    std::fs::create_dir_all(&prefix)
        .map_err(|e| format!("could not create npm-global prefix: {e}"))?;

    let output = Command::new(&npm)
        .args(codex_install_argv(&prefix.to_string_lossy()))
        // The managed npm must find its own node first, whatever launchd
        // gave the GUI process.
        .env("PATH", extended_search_path())
        .output()
        .map_err(|e| format!("failed to spawn managed npm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "npm install {CODEX_PACKAGE} failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim().chars().take(400).collect::<String>()
        ));
    }
    // A zero exit is not proof — the binary must actually be where the
    // launch path will look for it.
    match managed_codex_bin() {
        Some(bin) if bin.exists() => Ok(()),
        Some(bin) => Err(format!(
            "npm reported success but {} does not exist",
            bin.display()
        )),
        None => Err("managed codex bin path unresolvable after install".to_string()),
    }
}

/// One background provisioning attempt per app launch.
///
/// Delayed past the startup rush (sync prewarm, hq-cli checker). Skips when
/// any codex is already resolvable — the login-shell probe finds user
/// installs (pnpm home, homebrew, npm global), and the managed bin covers
/// prior runs of this provisioner. Failures log and stop; the next app
/// launch retries. If the managed Node itself is absent this logs and waits
/// for the toolchain provisioning that the hq-cli path performs, rather than
/// racing it with a second Node download.
pub fn setup_codex_provisioner(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;

        let auto = hq_desktop_core::hq_cli_update::auto_update_enabled();
        let detected = crate::commands::ai_tools::detect_ai_tools().codex_cli;
        let managed = managed_codex_bin().map(|b| b.exists()).unwrap_or(false);
        if !should_provision(detected, managed, auto) {
            log(
                "codex-provision",
                &format!(
                    "skip (auto_update={auto} detected={detected} managed={managed})"
                ),
            );
            return;
        }

        log(
            "codex-provision",
            "no codex resolvable — installing @openai/codex into the managed prefix",
        );

        // A fresh machine has no managed Node yet, and nothing else is
        // guaranteed to provision one (the hq-cli path only does so on ITS
        // first install). The first shipped version of this provisioner gave
        // up here — which on a clean VM meant "never" — so provision Node
        // through the same cooldown-guarded repair the hq-cli path uses.
        if managed_npm().is_none() {
            log(
                "codex-provision",
                "managed npm absent — provisioning the managed Node first",
            );
            match crate::commands::sync::repair_managed_node(&handle).await {
                crate::commands::sync::ToolchainRepair::Repaired => {}
                crate::commands::sync::ToolchainRepair::Skipped => {
                    log(
                        "codex-provision",
                        "Node provisioning on cooldown — retrying next launch",
                    );
                    return;
                }
                crate::commands::sync::ToolchainRepair::Failed(reason) => {
                    log(
                        "codex-provision",
                        &format!("Node provisioning failed: {reason}"),
                    );
                    return;
                }
            }
        }

        let result = tauri::async_runtime::spawn_blocking(run_codex_install).await;
        match result {
            Ok(Ok(())) => log("codex-provision", "codex CLI provisioned"),
            Ok(Err(e)) => log("codex-provision", &format!("provisioning failed: {e}")),
            Err(e) => log("codex-provision", &format!("provisioning task join: {e}")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisions_only_when_nothing_resolvable_and_auto_update_on() {
        // The one true provisioning case.
        assert!(should_provision(false, false, true));
        // Any resolvable codex wins — user install or a prior managed one.
        assert!(!should_provision(true, false, true));
        assert!(!should_provision(false, true, true));
        // The master switch is honored: opting out of auto-installs opts out
        // of this one too.
        assert!(!should_provision(false, false, false));
    }

    #[test]
    fn install_argv_targets_the_managed_prefix_without_a_version_pin() {
        let argv = codex_install_argv("/managed/npm-global");
        assert_eq!(
            argv,
            vec![
                "install",
                "-g",
                "--prefix",
                "/managed/npm-global",
                "@openai/codex",
            ]
        );
        // Presence, not convergence: a pin here would recreate the
        // hq_cli_update dist-tag race for a CLI that self-updates.
        assert!(!argv.iter().any(|a| a.contains('@') && a != "@openai/codex"));
    }
}
