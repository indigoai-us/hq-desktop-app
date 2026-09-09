use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::commands::install_directory::resolve_hq_path;
use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::VaultClient;
use crate::util::{hq_resolver, paths};

/// Canonical default-package set is a product decision; empty for now —
/// populate with slugs to auto-install at onboarding.
const DEFAULT_PACKAGES: &[&str] = &[];

const FAILED_DEPENDENCIES: &[&str] = &[
    "node",
    "yq",
    "jq",
    "git",
    "qmd",
    "hq-cli",
    "path-write",
    "unknown",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnboardingErrorCategory {
    Network,
    Checksum,
    Permission,
    NotFound,
    Timeout,
    SpawnFailed,
    ExitNonzero,
    UnsupportedPlatform,
    Disk,
    Unknown,
}

impl OnboardingErrorCategory {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Checksum => "checksum",
            Self::Permission => "permission",
            Self::NotFound => "not-found",
            Self::Timeout => "timeout",
            Self::SpawnFailed => "spawn-failed",
            Self::ExitNonzero => "exit-nonzero",
            Self::UnsupportedPlatform => "unsupported-platform",
            Self::Disk => "disk",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnboardingFailureScope {
    pub setup_run_id: String,
    pub attempt_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OnboardingFailureDetailKey {
    stage: String,
    scope: OnboardingFailureScope,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnboardingFailureDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_dependency: Option<String>,
    pub error_category: String,
}

static ONBOARDING_FAILURE_DETAILS: OnceLock<
    Mutex<HashMap<OnboardingFailureDetailKey, OnboardingFailureDetail>>,
> = OnceLock::new();

fn onboarding_failure_details(
) -> &'static Mutex<HashMap<OnboardingFailureDetailKey, OnboardingFailureDetail>> {
    ONBOARDING_FAILURE_DETAILS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn onboarding_failure_detail_key(
    stage: &str,
    failure_scope: &OnboardingFailureScope,
) -> OnboardingFailureDetailKey {
    OnboardingFailureDetailKey {
        stage: stage.to_string(),
        scope: failure_scope.clone(),
    }
}

pub(crate) fn clear_onboarding_failure_detail(
    stage: &str,
    failure_scope: Option<&OnboardingFailureScope>,
) {
    let Some(failure_scope) = failure_scope else {
        return;
    };
    onboarding_failure_details()
        .lock()
        .unwrap()
        .remove(&onboarding_failure_detail_key(stage, failure_scope));
}

pub(crate) fn record_onboarding_failure_detail(
    stage: &str,
    failure_scope: Option<&OnboardingFailureScope>,
    failed_dependency: Option<&str>,
    error_category: OnboardingErrorCategory,
) {
    let Some(failure_scope) = failure_scope else {
        return;
    };
    let failed_dependency = failed_dependency.map(|value| {
        if FAILED_DEPENDENCIES.contains(&value) {
            value.to_string()
        } else {
            "unknown".to_string()
        }
    });
    let mut details = onboarding_failure_details().lock().unwrap();
    if details.len() == 32 {
        details.clear();
    }
    let key = onboarding_failure_detail_key(stage, failure_scope);
    if details
        .get(&key)
        .and_then(|detail| detail.failed_dependency.as_deref())
        == Some("path-write")
    {
        return;
    }
    details.insert(
        key,
        OnboardingFailureDetail {
            failed_dependency,
            error_category: error_category.as_str().to_string(),
        },
    );
}

#[tauri::command]
pub fn take_onboarding_failure_detail(
    stage: String,
    setup_run_id: String,
    attempt_count: u32,
) -> Option<OnboardingFailureDetail> {
    onboarding_failure_details().lock().unwrap().remove(&OnboardingFailureDetailKey {
        stage,
        scope: OnboardingFailureScope {
            setup_run_id,
            attempt_count,
        },
    })
}

#[derive(Debug)]
struct StageCommandFailure {
    message: String,
    error_category: OnboardingErrorCategory,
}

impl StageCommandFailure {
    fn from_spawn_error(command: &str, error: std::io::Error) -> Self {
        let error_category = match error.kind() {
            std::io::ErrorKind::PermissionDenied => OnboardingErrorCategory::Permission,
            std::io::ErrorKind::NotFound => OnboardingErrorCategory::NotFound,
            std::io::ErrorKind::TimedOut => OnboardingErrorCategory::Timeout,
            _ => OnboardingErrorCategory::SpawnFailed,
        };
        Self {
            message: format!("Failed to spawn {command}: {error}"),
            error_category,
        }
    }

    fn from_output(command: &str, args: &[&str], output: &Output) -> Self {
        Self {
            message: format_hq_failure(args, output).replace("hq ", &format!("{command} ")),
            error_category: OnboardingErrorCategory::ExitNonzero,
        }
    }
}

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

fn run_git(
    git: &str,
    path_env: &str,
    args: Vec<OsString>,
) -> Result<Output, StageCommandFailure> {
    let output = git_command(git, path_env)
        .args(&args)
        .output()
        .map_err(|error| StageCommandFailure::from_spawn_error("git", error))?;

    if output.status.success() {
        Ok(output)
    } else {
        Err(StageCommandFailure {
            message: format_git_failure(&args, &output),
            error_category: OnboardingErrorCategory::ExitNonzero,
        })
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

async fn run_hq_output(
    args: &[&str],
    hq_root: &Path,
) -> Result<Output, StageCommandFailure> {
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
        .map_err(|error| {
            StageCommandFailure::from_spawn_error(
                &format!("hq ({})", invocation.label()),
                error,
            )
        })?;

    if output.status.success() {
        Ok(output)
    } else {
        Err(StageCommandFailure::from_output("hq", args, &output))
    }
}

async fn run_hq(args: &[&str], hq_root: &Path) -> Result<(), StageCommandFailure> {
    run_hq_output(args, hq_root).await.map(|_| ())
}

async fn run_hq_json(
    args: &[&str],
    hq_root: &Path,
) -> Result<serde_json::Value, StageCommandFailure> {
    let output = run_hq_output(args, hq_root).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|error| StageCommandFailure {
        message: format!("parse `hq {}` JSON: {error}", args.join(" ")),
        error_category: OnboardingErrorCategory::Unknown,
    })
}

fn read_global_git_config(
    git: &str,
    path_env: &str,
    key: &str,
) -> Result<Option<String>, StageCommandFailure> {
    let output = git_command(git, path_env)
        .args(["config", "--global", key])
        .output()
        .map_err(|error| {
            StageCommandFailure::from_spawn_error(&format!("git config --global {key}"), error)
        })?;

    if !output.status.success() && output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(StageCommandFailure {
            message: format_git_failure(
                &[
                    OsString::from("config"),
                    OsString::from("--global"),
                    OsString::from(key),
                ],
                &output,
            ),
            error_category: OnboardingErrorCategory::ExitNonzero,
        });
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn git_init_path(
    path: &Path,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<(), StageCommandFailure> {
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
    failure_scope: Option<OnboardingFailureScope>,
) -> Result<String, String> {
    clear_onboarding_failure_detail("git-init", failure_scope.as_ref());
    let result = (|| -> Result<String, StageCommandFailure> {
        let hq_root = normalize_optional_git_config(path)
            .map_or_else(resolve_hq_path, Ok)
            .map_err(|message| StageCommandFailure {
                message,
                error_category: OnboardingErrorCategory::Unknown,
            })?;
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
    })();

    match result {
        Ok(message) => Ok(message),
        Err(error) => {
            record_onboarding_failure_detail(
                "git-init",
                failure_scope.as_ref(),
                None,
                error.error_category,
            );
            Err(error.message)
        }
    }
}

/// Read global git user identity for legacy installer UI pre-fill.
#[tauri::command]
pub fn git_probe_user() -> Result<Option<GitUser>, String> {
    let git = paths::resolve_bin("git");
    let path_env = paths::child_path();
    let name = read_global_git_config(&git, &path_env, "user.name").map_err(|e| e.message)?;
    let email = read_global_git_config(&git, &path_env, "user.email").map_err(|e| e.message)?;
    if name.is_none() && email.is_none() {
        Ok(None)
    } else {
        Ok(Some(GitUser { name, email }))
    }
}

/// Build the local search index and refresh CLI-generated registries.
#[tauri::command]
pub async fn register_search_index(
    failure_scope: Option<OnboardingFailureScope>,
) -> Result<(), String> {
    clear_onboarding_failure_detail("indexing", failure_scope.as_ref());
    let hq_root = PathBuf::from(resolve_hq_path()?);
    match run_hq(&["reindex"], &hq_root).await {
        Ok(()) => Ok(()),
        Err(error) => {
            record_onboarding_failure_detail(
                "indexing",
                failure_scope.as_ref(),
                None,
                error.error_category,
            );
            Err(error.message)
        }
    }
}

/// Install configured default HQ packages during onboarding.
#[tauri::command]
pub async fn install_default_packages() -> Result<(), String> {
    let hq_root = PathBuf::from(resolve_hq_path()?);

    let mut failures = Vec::new();
    for slug in DEFAULT_PACKAGES {
        if let Err(error) = run_hq(&["packages", "install", slug], &hq_root).await {
            failures.push(format!("{slug}: {}", error.message));
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

fn personalize_hq_at(hq_root: &Path) -> Result<(), String> {
    let personal = hq_root.join("personal");
    let settings = personal.join("settings");
    let workers = personal.join("workers");

    fs::create_dir_all(&settings)
        .map_err(|_| "Could not prepare personal settings.".to_string())?;
    fs::create_dir_all(&workers).map_err(|_| "Could not prepare personal workers.".to_string())?;

    let cognito = settings.join("cognito.json");
    if !cognito.exists() {
        fs::write(&cognito, "{}\n")
            .map_err(|_| "Could not create personal settings.".to_string())?;
    }

    for path in [settings.join(".gitkeep"), workers.join(".gitkeep")] {
        if !path.exists() {
            fs::write(&path, "")
                .map_err(|_| "Could not prepare personal workspace files.".to_string())?;
        }
    }

    // TODO: render personal/profile.md once the onboarding wizard collects PersonalizationAnswers.
    Ok(())
}

/// Scaffold top-level personal state expected by HQ.
#[tauri::command]
pub fn personalize_hq() -> Result<(), String> {
    let hq_root = resolve_hq_path()
        .map(PathBuf::from)
        .map_err(|_| "Could not resolve the HQ folder for personalization.".to_string())?;
    personalize_hq_at(&hq_root)
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
    run_hq(MESH_DAEMON_INSTALL_ARGS, &hq_root)
        .await
        .map_err(|error| error.message)?;
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
    let status_value = run_hq_json(MESH_DAEMON_STATUS_ARGS, &hq_root)
        .await
        .map_err(|error| error.message)?;
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
        Err(command_failure) => {
            let err = command_failure.message;
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

fn initial_cloud_sync_failure_message(error: Option<&str>) -> String {
    let is_transient = error.is_some_and(|message| {
        let normalized = message.to_ascii_lowercase();
        [
            "network",
            "timeout",
            "timed out",
            "temporary",
            "temporarily",
            "econnreset",
            "econnaborted",
            "etimedout",
            "enotfound",
            "eai_again",
            "dns",
            "socket",
            "connection reset",
            "connection closed",
            "connection refused",
            "tls",
            "ssl",
            "rate limit",
            "429",
        ]
        .iter()
        .any(|signal| normalized.contains(signal))
    });

    if is_transient {
        "Initial cloud sync encountered a temporary network error. Please retry this setup step."
            .to_string()
    } else {
        "Initial cloud sync could not be verified. Please retry this setup step.".to_string()
    }
}

/// Provision and verify the first personal-vault cloud sync.
///
/// The frontend has the stage's bounded timeout. This command therefore waits
/// for the provisioning and first-push result instead of reporting success for
/// a detached task whose outcome is not known yet.
#[tauri::command]
pub async fn start_initial_cloud_sync(app: tauri::AppHandle) -> Result<(), String> {
    let jwt = resolve_jwt()
        .await
        .map_err(|_| initial_cloud_sync_failure_message(None))?;
    let vault_url =
        resolve_vault_api_url().map_err(|_| initial_cloud_sync_failure_message(None))?;
    let vault = VaultClient::new(&vault_url, &jwt);
    let hq_root =
        PathBuf::from(resolve_hq_path().map_err(|_| initial_cloud_sync_failure_message(None))?);

    crate::commands::personal::ensure_personal_bucket_and_first_push(&app, &vault, &hq_root)
        .await
        .map_err(|error| initial_cloud_sync_failure_message(Some(&error)))
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
    fn stage_failure_categories_use_real_spawn_error_kinds() {
        let permission = StageCommandFailure::from_spawn_error(
            "git",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        let not_found = StageCommandFailure::from_spawn_error(
            "hq",
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        let timeout = StageCommandFailure::from_spawn_error(
            "hq",
            std::io::Error::from(std::io::ErrorKind::TimedOut),
        );
        let spawn_failed = StageCommandFailure::from_spawn_error(
            "hq",
            std::io::Error::from(std::io::ErrorKind::Other),
        );

        assert_eq!(permission.error_category, OnboardingErrorCategory::Permission);
        assert_eq!(not_found.error_category, OnboardingErrorCategory::NotFound);
        assert_eq!(timeout.error_category, OnboardingErrorCategory::Timeout);
        assert_eq!(
            spawn_failed.error_category,
            OnboardingErrorCategory::SpawnFailed
        );
    }

    #[test]
    fn personalize_hq_reports_filesystem_failures() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("personal"), "not a directory").unwrap();

        let result = personalize_hq_at(dir.path());

        assert_eq!(
            result,
            Err("Could not prepare personal settings.".to_string())
        );
    }

    #[test]
    fn failure_detail_cache_is_scoped_to_each_run_and_attempt() {
        let first_scope = OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 1,
        };
        let retry_scope = OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 2,
        };
        let path_write_scope = OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 3,
        };
        clear_onboarding_failure_detail("deps", Some(&first_scope));
        clear_onboarding_failure_detail("deps", Some(&retry_scope));
        clear_onboarding_failure_detail("deps", Some(&path_write_scope));
        record_onboarding_failure_detail(
            "deps",
            Some(&first_scope),
            Some("unrecognized-private-tool"),
            OnboardingErrorCategory::Network,
        );
        record_onboarding_failure_detail(
            "deps",
            Some(&retry_scope),
            Some("qmd"),
            OnboardingErrorCategory::Timeout,
        );
        record_onboarding_failure_detail(
            "deps",
            Some(&path_write_scope),
            Some("path-write"),
            OnboardingErrorCategory::Unknown,
        );
        record_onboarding_failure_detail(
            "deps",
            Some(&path_write_scope),
            Some("node"),
            OnboardingErrorCategory::Unknown,
        );

        assert_eq!(
            take_onboarding_failure_detail(
                "deps".to_string(),
                first_scope.setup_run_id.clone(),
                first_scope.attempt_count,
            ),
            Some(OnboardingFailureDetail {
                failed_dependency: Some("unknown".to_string()),
                error_category: "network".to_string(),
            })
        );
        assert_eq!(
            take_onboarding_failure_detail(
                "deps".to_string(),
                retry_scope.setup_run_id.clone(),
                retry_scope.attempt_count,
            ),
            Some(OnboardingFailureDetail {
                failed_dependency: Some("qmd".to_string()),
                error_category: "timeout".to_string(),
            })
        );
        assert_eq!(
            take_onboarding_failure_detail(
                "deps".to_string(),
                retry_scope.setup_run_id,
                retry_scope.attempt_count,
            ),
            None
        );
        assert_eq!(
            take_onboarding_failure_detail(
                "deps".to_string(),
                path_write_scope.setup_run_id,
                path_write_scope.attempt_count,
            ),
            Some(OnboardingFailureDetail {
                failed_dependency: Some("path-write".to_string()),
                error_category: "unknown".to_string(),
            })
        );
    }

    #[test]
    fn initial_sync_waits_for_the_provisioning_result() {
        let src = include_str!("install_stages.rs");
        let initial_sync_start = src
            .find("pub async fn start_initial_cloud_sync")
            .expect("initial cloud sync command must exist");
        let tests_start = src
            .find("#[cfg(test)]")
            .expect("install stage tests must exist");
        let initial_sync = &src[initial_sync_start..tests_start];

        assert!(
            initial_sync.contains("ensure_personal_bucket_and_first_push(&app, &vault, &hq_root)")
        );
        assert!(!initial_sync.contains("tauri::async_runtime::spawn"));
    }

    #[test]
    fn initial_sync_sanitizes_errors_and_preserves_transient_retry_signal() {
        assert_eq!(
            initial_cloud_sync_failure_message(Some("request timed out")),
            "Initial cloud sync encountered a temporary network error. Please retry this setup step."
        );
        assert_eq!(
            initial_cloud_sync_failure_message(Some("permission denied")),
            "Initial cloud sync could not be verified. Please retry this setup step."
        );
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
