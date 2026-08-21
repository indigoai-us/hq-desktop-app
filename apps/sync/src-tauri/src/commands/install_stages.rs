use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::commands::install_directory::resolve_hq_path;
use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::VaultClient;
use crate::util::{hq_resolver, paths};

/// Canonical default-package set is a product decision; empty for now —
/// populate with slugs to auto-install at onboarding.
const DEFAULT_PACKAGES: &[&str] = &[];
const STARTUP_READINESS_ARGS: &[&str] = &["doctor", "startup", "--publish", "--json"];
const STARTUP_READINESS_SOURCE: &str = "hq-desktop";
const COMPLETED_STARTUP_READINESS_EXITS: &[i32] = &[0, 10, 20, 30];

/// A resumed onboarding flow may request the launch more than once. One
/// process launches at most one observation; the CLI publisher lock remains
/// the cross-process serialization boundary when the app itself is restarted.
static STARTUP_READINESS_LAUNCHED: AtomicBool = AtomicBool::new(false);

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

async fn run_hq(args: &[&str], hq_root: &Path) -> Result<(), String> {
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
        .output()
        .await
        .map_err(|e| format!("Failed to spawn hq ({}): {e}", invocation.label()))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format_hq_failure(args, &output))
    }
}

fn claim_startup_readiness_launch(gate: &AtomicBool) -> bool {
    gate.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// Reset the in-process gate unless the CLI completed a recognized published
/// observation. This lease also resets during unwinding, so a failed or
/// panicking detached task cannot permanently suppress a resumed onboarding
/// attempt in the same app process.
struct StartupReadinessLaunchLease<'a> {
    gate: &'a AtomicBool,
    keep_claimed: bool,
}

impl<'a> StartupReadinessLaunchLease<'a> {
    fn new(gate: &'a AtomicBool) -> Self {
        Self {
            gate,
            keep_claimed: false,
        }
    }

    fn retain(&mut self) {
        self.keep_claimed = true;
    }
}

impl Drop for StartupReadinessLaunchLease<'_> {
    fn drop(&mut self) {
        if !self.keep_claimed {
            self.gate.store(false, Ordering::Release);
        }
    }
}

fn startup_readiness_invocation(
    program: paths::ResolvedProgram,
) -> Result<hq_resolver::HqInvocation, String> {
    if !program.is_resolved() {
        return Err("installed hq-cli was not found after dependency setup".to_string());
    }
    if cfg!(target_os = "windows") && !program.is_spawnable() {
        return Err("installed hq-cli is not directly executable on this platform".to_string());
    }
    Ok(hq_resolver::HqInvocation::Local(program.path))
}

fn startup_readiness_command(
    invocation: &hq_resolver::HqInvocation,
    hq_root: &Path,
    path_env: &str,
) -> tokio::process::Command {
    let mut command = invocation.command();
    command
        .args(STARTUP_READINESS_ARGS)
        .current_dir(hq_root)
        .env("PATH", path_env)
        .env("HQ_STARTUP_SOURCE", STARTUP_READINESS_SOURCE)
        // Dependency setup owns hq-cli installation. Keep the readiness bridge
        // offline and prevent the CLI's normal startup gate from self-updating.
        .env("HQ_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn is_completed_startup_readiness_exit(code: Option<i32>) -> bool {
    code.is_some_and(|code| COMPLETED_STARTUP_READINESS_EXITS.contains(&code))
}

async fn observe_startup_readiness(
    hq_root: PathBuf,
    invocation: hq_resolver::HqInvocation,
    path_env: String,
) -> bool {
    let invocation_label = invocation.label();
    let status = startup_readiness_command(&invocation, &hq_root, &path_env)
        .status()
        .await;

    match status {
        Ok(status) if is_completed_startup_readiness_exit(status.code()) => {
            crate::util::logfile::log(
                "startup-readiness",
                &format!(
                    "completed observation via {invocation_label} with exit {}",
                    status.code().unwrap_or_default()
                ),
            );
            true
        }
        Ok(status) => {
            let exit = status
                .code()
                .map_or_else(|| "no exit code".to_string(), |code| code.to_string());
            crate::util::logfile::log(
                "startup-readiness",
                &format!("unexpected exit via {invocation_label}: {exit}"),
            );
            false
        }
        Err(error) => {
            crate::util::logfile::log(
                "startup-readiness",
                &format!("spawn failed via {invocation_label}: {error}"),
            );
            false
        }
    }
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

/// Launch the CLI-owned startup-readiness observation without blocking or
/// failing onboarding. Rust deliberately does not parse the JSON or write any
/// readiness state; `hq doctor startup --publish` owns that contract.
#[tauri::command]
pub fn launch_startup_readiness() -> Result<(), String> {
    // Capture the exact root and child PATH at the post-git-init call boundary.
    // Do not use the generic resolver's npx self-heal fallback here: dependency
    // setup owns hq-cli installation, and this adapter must remain offline.
    let hq_root = match resolve_hq_path() {
        Ok(path) => PathBuf::from(path),
        Err(error) => {
            crate::util::logfile::log(
                "startup-readiness",
                &format!("launch failed: resolve HQ root: {error}"),
            );
            return Ok(());
        }
    };
    let invocation = match startup_readiness_invocation(paths::resolve_bin_with_kind("hq")) {
        Ok(invocation) => invocation,
        Err(error) => {
            crate::util::logfile::log("startup-readiness", &format!("launch failed: {error}"));
            return Ok(());
        }
    };
    let path_env = paths::child_path();

    if !claim_startup_readiness_launch(&STARTUP_READINESS_LAUNCHED) {
        crate::util::logfile::log(
            "startup-readiness",
            "launch skipped: observation already requested in this process",
        );
        return Ok(());
    }

    let mut lease = StartupReadinessLaunchLease::new(&STARTUP_READINESS_LAUNCHED);
    tauri::async_runtime::spawn(async move {
        if observe_startup_readiness(hq_root, invocation, path_env).await {
            lease.retain();
        }
    });
    Ok(())
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
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn git_init_path_creates_git_directory() {
        let dir = tempdir().unwrap();

        git_init_path(dir.path(), None, None).unwrap();

        assert!(dir.path().join(".git").is_dir());
    }

    #[test]
    fn startup_readiness_launch_is_idempotent_in_process() {
        let gate = AtomicBool::new(false);

        assert!(claim_startup_readiness_launch(&gate));
        assert!(!claim_startup_readiness_launch(&gate));
        assert!(!claim_startup_readiness_launch(&gate));
    }

    #[test]
    fn failed_startup_readiness_launch_can_be_retried() {
        let gate = AtomicBool::new(false);

        assert!(claim_startup_readiness_launch(&gate));
        drop(StartupReadinessLaunchLease::new(&gate));
        assert!(claim_startup_readiness_launch(&gate));

        let mut completed = StartupReadinessLaunchLease::new(&gate);
        completed.retain();
        drop(completed);
        assert!(!claim_startup_readiness_launch(&gate));
    }

    #[test]
    fn startup_readiness_requires_the_installed_cli() {
        assert!(startup_readiness_invocation(paths::ResolvedProgram::not_resolved("hq")).is_err());
        assert!(matches!(
            startup_readiness_invocation(paths::ResolvedProgram {
                path: "/test/bin/hq".to_string(),
                kind: paths::ResolvedProgramKind::Exe,
            }),
            Ok(hq_resolver::HqInvocation::Local(path)) if path == "/test/bin/hq"
        ));
    }

    #[test]
    fn startup_readiness_command_uses_cli_owned_contract() {
        let dir = tempdir().unwrap();
        let invocation = hq_resolver::HqInvocation::Local("/test/bin/hq".to_string());
        let command = startup_readiness_command(&invocation, dir.path(), "/test/child-path");
        let command = command.as_std();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let env = command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(args, STARTUP_READINESS_ARGS);
        assert_eq!(command.get_current_dir(), Some(dir.path()));
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/test/child-path")
        );
        assert_eq!(
            env.get("HQ_STARTUP_SOURCE").map(String::as_str),
            Some("hq-desktop")
        );
        assert_eq!(env.get("HQ_NO_UPDATE_CHECK").map(String::as_str), Some("1"));
    }

    #[test]
    fn startup_readiness_exit_allowlist_is_completed_observation() {
        for code in COMPLETED_STARTUP_READINESS_EXITS {
            assert!(is_completed_startup_readiness_exit(Some(*code)));
        }
        assert!(!is_completed_startup_readiness_exit(Some(1)));
        assert!(!is_completed_startup_readiness_exit(Some(31)));
        assert!(!is_completed_startup_readiness_exit(None));
    }
}
