use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

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
                crate::util::logfile::log(
                    "personalize",
                    &format!("write {}: {e}", path.display()),
                );
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
    use tempfile::tempdir;

    #[test]
    fn git_init_path_creates_git_directory() {
        let dir = tempdir().unwrap();

        git_init_path(dir.path(), None, None).unwrap();

        assert!(dir.path().join(".git").is_dir());
    }
}
