use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::commands::install_directory::resolve_hq_path;
use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::VaultClient;
use crate::util::paths;

fn git_command(git: &str, path_env: &str) -> Command {
    let mut cmd = Command::new(git);
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

/// Initialise the resolved HQ root as a git repository and copy any global git
/// identity into local repo config. Idempotent: `git init` on an existing repo
/// reuses the repository.
#[tauri::command]
pub fn git_init() -> Result<String, String> {
    let hq_root = resolve_hq_path()?;
    let git = paths::resolve_bin("git");
    let path_env = paths::child_path();
    let name = read_global_git_config(&git, &path_env, "user.name")?;
    let email = read_global_git_config(&git, &path_env, "user.email")?;

    git_init_path(Path::new(&hq_root), name.as_deref(), email.as_deref())?;

    Ok(format!("initialised {hq_root}"))
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
