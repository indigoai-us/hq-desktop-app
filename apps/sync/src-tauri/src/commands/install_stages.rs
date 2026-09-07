use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::{Deserialize, Serialize};

use crate::commands::install_directory::resolve_hq_path;
use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::VaultClient;
use crate::util::{hq_resolver, paths};

/// Canonical default-package set is a product decision; empty for now —
/// populate with slugs to auto-install at onboarding.
const DEFAULT_PACKAGES: &[&str] = &[];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

fn git_command(git: &str, path_env: &str) -> Command {
    let mut cmd = Command::new(git);
    paths::no_window(&mut cmd);
    cmd.env("PATH", path_env);
    cmd
}

fn format_git_failure(args: &[OsString], output: &Output) -> String {
    let argv = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".to_string()
    };

    format!(
        "git {argv} failed with status {}: {detail}",
        output.status.code().unwrap_or(-1)
    )
}

fn run_git(git: &str, path_env: &str, args: Vec<OsString>) -> Result<Output, String> {
    let output = git_command(git, path_env)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to spawn git: {e}"))?;

    if output.status.success() {
        Ok(output)
    } else {
        Err(format_git_failure(&args, &output))
    }
}

fn format_hq_failure(args: &[&str], output: &Output) -> String {
    let argv = args.join(" ");
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".to_string()
    };
    const MAX_DETAIL_CHARS: usize = 2_000;
    if detail.chars().count() > MAX_DETAIL_CHARS {
        detail = detail.chars().take(MAX_DETAIL_CHARS).collect();
        detail.push_str("...");
    }

    format!(
        "hq {argv} failed with status {}: {detail}",
        output.status.code().unwrap_or(-1)
    )
}

async fn run_hq_output(args: &[&str], hq_root: &Path) -> Result<Output, String> {
    let invocation = hq_resolver::resolve_hq();
    let path_env = paths::child_path();
    // Serialize concurrent npx self-heal installs against the shared
    // ~/.npm/_npx cache (HQ-SYNC-6); no-op on the resolved-local fast path.
    let _npx_guard = invocation.npx_serial_guard().await;
    let mut cmd = invocation.command();
    let output = cmd
        .args(args)
        .current_dir(hq_root)
        .env("PATH", &path_env)
        // Keep mid-call CLI self-updates from racing the command we asked for.
        .env("HQ_NO_UPDATE_CHECK", "1")
        .output()
        .await
        .map_err(|e| format!("Failed to spawn hq ({}): {e}", invocation.label()))?;

    if output.status.success() {
        Ok(output)
    } else {
        Err(format_hq_failure(args, &output))
    }
}

async fn run_hq(args: &[&str], hq_root: &Path) -> Result<(), String> {
    run_hq_output(args, hq_root).await.map(|_| ())
}

async fn run_hq_json(args: &[&str], hq_root: &Path) -> Result<serde_json::Value, String> {
    let output = run_hq_output(args, hq_root).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse `hq {}` JSON: {e}", args.join(" ")))
}

fn read_global_git_config(git: &str, path_env: &str, key: &str) -> Result<Option<String>, String> {
    let output = git_command(git, path_env)
        .args(["config", "--global", key])
        .output()
        .map_err(|e| format!("Failed to spawn git config --global {key}: {e}"))?;

    if !output.status.success() && output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(format_git_failure(
            &[
                OsString::from("config"),
                OsString::from("--global"),
                OsString::from(key),
            ],
            &output,
        ));
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn git_init_path(path: &Path, name: Option<&str>, email: Option<&str>) -> Result<(), String> {
    let git = paths::resolve_bin("git");
    let path_env = paths::child_path();

    run_git(
        &git,
        &path_env,
        vec![OsString::from("init"), path.as_os_str().to_os_string()],
    )?;

    if let Some(name) = name {
        run_git(
            &git,
            &path_env,
            vec![
                OsString::from("-C"),
                path.as_os_str().to_os_string(),
                OsString::from("config"),
                OsString::from("user.name"),
                OsString::from(name),
            ],
        )?;
    }

    if let Some(email) = email {
        run_git(
            &git,
            &path_env,
            vec![
                OsString::from("-C"),
                path.as_os_str().to_os_string(),
                OsString::from("config"),
                OsString::from("user.email"),
                OsString::from(email),
            ],
        )?;
    }

    Ok(())
}

fn normalize_optional_git_config(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Initialise an HQ root as a git repository. Backward-compatible with the
/// legacy installer contract: old callers may pass `path`, `name`, and `email`;
/// unified onboarding passes no args and uses the resolved HQ path plus global
/// git identity when available.
#[tauri::command]
pub fn git_init(
    path: Option<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    let hq_root = normalize_optional_git_config(path).map_or_else(resolve_hq_path, Ok)?;
    let git = paths::resolve_bin("git");
    let path_env = paths::child_path();
    let explicit_name = normalize_optional_git_config(name);
    let explicit_email = normalize_optional_git_config(email);
    let name = match explicit_name {
        Some(name) => Some(name),
        None => read_global_git_config(&git, &path_env, "user.name")?,
    };
    let email = match explicit_email {
        Some(email) => Some(email),
        None => read_global_git_config(&git, &path_env, "user.email")?,
    };

    git_init_path(Path::new(&hq_root), name.as_deref(), email.as_deref())?;

    Ok(format!("initialised {hq_root}"))
}

/// Read global git user identity for legacy installer UI pre-fill.
#[tauri::command]
pub fn git_probe_user() -> Result<Option<GitUser>, String> {
    let git = paths::resolve_bin("git");
    let path_env = paths::child_path();
    let name = read_global_git_config(&git, &path_env, "user.name")?;
    let email = read_global_git_config(&git, &path_env, "user.email")?;
    if name.is_none() && email.is_none() {
        Ok(None)
    } else {
        Ok(Some(GitUser { name, email }))
    }
}

/// Build the local search index and refresh CLI-generated registries.
#[tauri::command]
pub async fn register_search_index() -> Result<(), String> {
    let hq_root = PathBuf::from(resolve_hq_path()?);

    run_hq(&["reindex"], &hq_root).await
}

/// Install configured default HQ packages during onboarding.
#[tauri::command]
pub async fn install_default_packages() -> Result<(), String> {
    let hq_root = PathBuf::from(resolve_hq_path()?);

    let mut failures = Vec::new();
    for slug in DEFAULT_PACKAGES {
        if let Err(e) = run_hq(&["packages", "install", slug], &hq_root).await {
            failures.push(format!("{slug}: {e}"));
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "default package install failed: {}",
            failures.join("; ")
        ))
    }
}

/// Scaffold top-level personal state expected by HQ.
#[tauri::command]
pub fn personalize_hq() -> Result<(), String> {
    let hq_root = match resolve_hq_path() {
        Ok(path) => PathBuf::from(path),
        Err(e) => {
            crate::util::logfile::log("personalize", &format!("resolve HQ root failed: {e}"));
            return Ok(());
        }
    };
    let personal = hq_root.join("personal");
    let settings = personal.join("settings");
    let workers = personal.join("workers");

    if let Err(e) = fs::create_dir_all(&settings) {
        crate::util::logfile::log("personalize", &format!("create personal/settings: {e}"));
    }
    if let Err(e) = fs::create_dir_all(&workers) {
        crate::util::logfile::log("personalize", &format!("create personal/workers: {e}"));
    }

    let cognito = settings.join("cognito.json");
    if !cognito.exists() {
        if let Err(e) = fs::write(&cognito, "{}\n") {
            crate::util::logfile::log("personalize", &format!("write cognito.json: {e}"));
        }
    }

    for path in [settings.join(".gitkeep"), workers.join(".gitkeep")] {
        if !path.exists() {
            if let Err(e) = fs::write(&path, "") {
                crate::util::logfile::log("personalize", &format!("write {}: {e}", path.display()));
            }
        }
    }

    // TODO: render personal/profile.md once the onboarding wizard collects PersonalizationAnswers.
    Ok(())
}

/// Placeholder for importing an existing setup from legacy installer state.
#[tauri::command]
pub async fn import_existing_setup() -> Result<(), String> {
    crate::util::logfile::log(
        "import",
        "import stage skipped — existing-setup import not yet wired (see imports/hq-installer-react/src/lib/import-existing.ts)",
    );
    // TODO: wire the import mechanism and verification before porting the
    // installer scan/spawn process from import-existing.ts.
    Ok(())
}

/// No-op install-stage handoff for the unified app.
///
/// The unified desktop app is already the menu-bar/tray agent, so there is no
/// separate menubar app to download, extract, copy, or launch. The actual tray
/// handoff happens when onboarding finishes: `mark_first_run_complete` updates
/// first-run state and `App.svelte` switches into the normal tray workflow.
#[tauri::command]
pub async fn install_menubar_app() -> Result<(), String> {
    Ok(())
}

/// Argv for the Work Mesh Live daemon install (hq-cli). Not the retired pack listen path.
pub const MESH_DAEMON_INSTALL_ARGS: &[&str] = &["mesh", "daemon", "install"];

const MESH_DAEMON_STATUS_ARGS: &[&str] = &["mesh", "daemon", "status", "--json"];
const MESH_DAEMON_AUTO_INSTALL_MARKER: &str = "mesh-daemon-auto-install.json";

/// Status payload from `hq mesh daemon status --json`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DaemonStatus {
    pub running: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub dest: Option<String>,
}

/// Persisted auto-install attempt under `~/.hq/menubar/`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoInstallMarker {
    pub cli_version: String,
    pub attempted_at: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of [`ensure_work_mesh_daemon`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureOutcome {
    pub installed: bool,
    pub already_installed: bool,
    pub skipped: bool,
    pub reason: String,
}

/// Install the Work Mesh Live daemon (`hq mesh daemon install`).
///
/// Replaces the retired pack listen installer and its LaunchAgent.
/// Fresh installs do not require the pack to be present on disk.
#[tauri::command]
pub async fn install_work_mesh() -> Result<(), String> {
    // Serialize with the SteadyState launch path so the wizard stage and
    // `ensure_work_mesh_daemon` never install concurrently or overwrite each
    // other's marker.
    let _guard = MESH_INSTALL_LOCK.lock().await;
    let hq_root = PathBuf::from(resolve_hq_path()?);
    run_hq(MESH_DAEMON_INSTALL_ARGS, &hq_root).await?;
    // Record the wizard install in the same marker the launch path reads, so a
    // later deliberate `hq mesh daemon uninstall` is not undone on next launch.
    let cli_version = crate::commands::hq_cli_update::get_hq_cli_version()
        .await
        .unwrap_or_else(|| "unknown".to_string());
    record_mesh_install_ok(&cli_version);
    Ok(())
}

/// One lock for every code path that installs the Work Mesh daemon
/// (onboarding wizard stage and SteadyState launch), held across the whole
/// status → decide → install → write-marker sequence.
static MESH_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Best-effort: write an `ok` auto-install marker for `cli_version`.
fn record_mesh_install_ok(cli_version: &str) {
    let Ok(marker_path) = mesh_daemon_auto_install_marker_path() else {
        return;
    };
    let marker = AutoInstallMarker {
        cli_version: cli_version.to_string(),
        attempted_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        outcome: "ok".to_string(),
        error: None,
    };
    if let Err(e) = write_auto_install_marker(&marker_path, &marker) {
        crate::util::logfile::log("work-mesh", &format!("mesh install marker not written: {e}"));
    }
}

fn mesh_daemon_auto_install_marker_path() -> Result<PathBuf, String> {
    Ok(paths::hq_config_dir()?
        .join("menubar")
        .join(MESH_DAEMON_AUTO_INSTALL_MARKER))
}

fn unit_not_installed(status: &DaemonStatus) -> bool {
    if status.running {
        return false;
    }
    let message_not_installed = status
        .message
        .to_ascii_lowercase()
        .contains("not installed");
    let dest_missing = match status.dest.as_deref() {
        Some(path) => !Path::new(path).exists(),
        None => false,
    };
    message_not_installed || dest_missing
}

/// Decide whether SteadyState auto-install should run for this CLI version.
///
/// Installs only when the unit is not installed and there is no successful
/// marker for the current CLI version. A deliberate uninstall after a prior
/// `ok` marker is left alone; a `failed` marker does not block retry.
pub fn should_auto_install(
    status: &DaemonStatus,
    marker: Option<&AutoInstallMarker>,
    cli_version: &str,
) -> bool {
    match marker {
        // A successful install for this CLI version was recorded (by the wizard
        // or by us). If the unit is gone now, the person removed it on purpose.
        Some(m) if m.cli_version == cli_version && m.outcome == "ok" => false,
        // Our last attempt for this CLI version failed. Retry even if it left a
        // partial unit behind; `hq mesh daemon install` is idempotent.
        Some(m) if m.cli_version == cli_version && m.outcome == "failed" => true,
        // No marker (or one from another CLI version): install only when the
        // unit is actually missing.
        _ => unit_not_installed(status),
    }
}

fn read_auto_install_marker(path: &Path) -> Option<AutoInstallMarker> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_auto_install_marker(path: &Path, marker: &AutoInstallMarker) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create mesh auto-install marker dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(marker)
        .map_err(|e| format!("serialize mesh auto-install marker: {e}"))?;
    fs::write(path, json).map_err(|e| format!("write mesh auto-install marker: {e}"))
}

/// Ensure the Work Mesh Live daemon is installed for already-onboarded machines.
///
/// Runs once per launch from SteadyState. Never re-installs after a successful
/// auto-install for the same CLI version (marker outcome `ok`).
#[tauri::command]
pub async fn ensure_work_mesh_daemon() -> Result<EnsureOutcome, String> {
    let _guard = MESH_INSTALL_LOCK.lock().await;
    let hq_root = PathBuf::from(resolve_hq_path()?);
    let status_value = run_hq_json(MESH_DAEMON_STATUS_ARGS, &hq_root).await?;
    let status: DaemonStatus = serde_json::from_value(status_value)
        .map_err(|e| format!("parse mesh daemon status: {e}"))?;

    let cli_version = crate::commands::hq_cli_update::get_hq_cli_version()
        .await
        .unwrap_or_else(|| "unknown".to_string());
    let marker_path = mesh_daemon_auto_install_marker_path()?;
    let marker = read_auto_install_marker(&marker_path);

    if !should_auto_install(&status, marker.as_ref(), &cli_version) {
        if !unit_not_installed(&status) {
            return Ok(EnsureOutcome {
                installed: false,
                already_installed: true,
                skipped: false,
                reason: "daemon already installed".to_string(),
            });
        }
        return Ok(EnsureOutcome {
            installed: false,
            already_installed: false,
            skipped: true,
            reason: format!(
                "skipped: prior ok auto-install marker for cli {cli_version}"
            ),
        });
    }

    let attempted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    match run_hq(MESH_DAEMON_INSTALL_ARGS, &hq_root).await {
        Ok(()) => {
            let marker = AutoInstallMarker {
                cli_version: cli_version.clone(),
                attempted_at,
                outcome: "ok".to_string(),
                error: None,
            };
            write_auto_install_marker(&marker_path, &marker)?;
            crate::util::logfile::log(
                "work-mesh",
                &format!("auto-installed mesh daemon for cli {cli_version}"),
            );
            Ok(EnsureOutcome {
                installed: true,
                already_installed: false,
                skipped: false,
                reason: "installed".to_string(),
            })
        }
        Err(err) => {
            let marker = AutoInstallMarker {
                cli_version: cli_version.clone(),
                attempted_at,
                outcome: "failed".to_string(),
                error: Some(err.clone()),
            };
            // Best-effort marker so the next launch can still retry; surface
            // the install error either way.
            let _ = write_auto_install_marker(&marker_path, &marker);
            crate::util::logfile::log(
                "work-mesh",
                &format!("auto-install mesh daemon failed for cli {cli_version}: {err}"),
            );
            Err(err)
        }
    }
}

/// Start the first personal-vault cloud sync in the background.
///
/// Setup only needs to provision and kick off the initial push; the long-lived
/// tray process owns continuous reconciliation after onboarding completes.
#[tauri::command]
pub async fn start_initial_cloud_sync(app: tauri::AppHandle) -> Result<(), String> {
    let jwt = resolve_jwt().await?;
    let vault_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&vault_url, &jwt);
    let hq_root = PathBuf::from(resolve_hq_path()?);

    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            crate::commands::personal::ensure_personal_bucket_and_first_push(&app, &vault, &hq_root)
                .await
        {
            crate::util::logfile::log("initial-sync", &format!("personal first-push failed: {e}"));
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn not_installed_status() -> DaemonStatus {
        DaemonStatus {
            running: false,
            message: "LaunchAgent not installed".to_string(),
            dest: Some("/tmp/hq-mesh-daemon-missing.plist".to_string()),
        }
    }

    fn installed_status(dir: &Path) -> DaemonStatus {
        let dest = dir.join("hq-mesh-daemon.plist");
        fs::write(&dest, "unit").unwrap();
        DaemonStatus {
            running: false,
            message: "loaded but not running".to_string(),
            dest: Some(dest.to_string_lossy().to_string()),
        }
    }

    fn ok_marker(version: &str) -> AutoInstallMarker {
        AutoInstallMarker {
            cli_version: version.to_string(),
            attempted_at: "2026-09-07T00:00:00Z".to_string(),
            outcome: "ok".to_string(),
            error: None,
        }
    }

    fn failed_marker(version: &str) -> AutoInstallMarker {
        AutoInstallMarker {
            cli_version: version.to_string(),
            attempted_at: "2026-09-07T00:00:00Z".to_string(),
            outcome: "failed".to_string(),
            error: Some("boom".to_string()),
        }
    }

    #[test]
    fn git_init_path_creates_git_directory() {
        let dir = tempdir().unwrap();

        git_init_path(dir.path(), None, None).unwrap();

        assert!(dir.path().join(".git").is_dir());
    }

    #[test]
    fn install_work_mesh_invokes_hq_mesh_daemon_install() {
        assert_eq!(MESH_DAEMON_INSTALL_ARGS, &["mesh", "daemon", "install"]);
        // Onboarding must call hq-cli, not the retired pack listen installer.
        // Needles are built at runtime so this source file does not embed them
        // (the guard reads this file via include_str!).
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/install_stages.rs"
        ));
        assert!(src.contains("MESH_DAEMON_INSTALL_ARGS"));
        assert!(src.contains("pub async fn install_work_mesh"));
        let retired_sh = format!("{}-listen.sh", "install");
        let retired_mjs = format!("{}.mjs listen", "work-mesh");
        assert!(!src.contains(&retired_sh));
        assert!(!src.contains(&retired_mjs));
    }

    #[test]
    fn should_auto_install_when_not_installed_and_no_marker() {
        assert!(should_auto_install(
            &not_installed_status(),
            None,
            "5.100.0"
        ));
    }

    #[test]
    fn should_not_auto_install_when_ok_marker_matches_cli_version() {
        assert!(!should_auto_install(
            &not_installed_status(),
            Some(&ok_marker("5.100.0")),
            "5.100.0"
        ));
    }

    #[test]
    fn should_auto_install_when_ok_marker_is_older_cli_version() {
        assert!(should_auto_install(
            &not_installed_status(),
            Some(&ok_marker("5.90.0")),
            "5.100.0"
        ));
    }

    #[test]
    fn should_auto_install_when_failed_marker_exists() {
        // A failed attempt must not permanently wedge SteadyState installs.
        assert!(should_auto_install(
            &not_installed_status(),
            Some(&failed_marker("5.100.0")),
            "5.100.0"
        ));
    }

    #[test]
    fn should_auto_install_when_failed_marker_and_partial_unit_exists() {
        // A failed attempt may leave a unit file behind; the failed marker for
        // this CLI version must still allow a retry.
        let dir = tempdir().unwrap();
        let status = installed_status(dir.path());
        let marker = failed_marker("5.108.20");
        assert!(should_auto_install(&status, Some(&marker), "5.108.20"));
    }

    #[test]
    fn should_not_auto_install_when_ok_marker_and_unit_removed_deliberately() {
        let marker = ok_marker("5.108.20");
        assert!(!should_auto_install(&not_installed_status(), Some(&marker), "5.108.20"));
    }

    #[test]
    fn install_paths_share_one_lock_and_wizard_records_marker() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/install_stages.rs"
        ));
        // Needles are built at runtime so this test's own source (included via
        // include_str!) does not match itself.
        let lock_needle = format!("{}.lock().await", "MESH_INSTALL_LOCK");
        let marker_needle = format!("{}(&cli_version);", "record_mesh_install_ok");
        // Both install paths take the same lock.
        assert_eq!(src.matches(lock_needle.as_str()).count(), 2);
        // The wizard stage records the same marker the launch path reads.
        assert!(src.contains(marker_needle.as_str()));
    }

    #[test]
    fn should_not_auto_install_when_unit_already_installed() {
        let dir = tempdir().unwrap();
        assert!(!should_auto_install(
            &installed_status(dir.path()),
            None,
            "5.100.0"
        ));
    }

    #[test]
    fn ensure_work_mesh_daemon_is_registered_in_main() {
        let main = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs"));
        assert!(
            main.contains("commands::install_stages::ensure_work_mesh_daemon"),
            "main.rs must register ensure_work_mesh_daemon next to install_work_mesh"
        );
    }
}
