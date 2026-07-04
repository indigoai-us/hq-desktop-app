//! Narrow IPC compatibility shims for legacy installer/secondary-window callers.
//!
//! The unified app owns the real onboarding and desktop surfaces now. These
//! commands keep old renderer code and smoke automation from failing at the IPC
//! boundary while delegating to the unified path or returning an explicit status.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::{ai_tools, cognito, content, install_directory};
use crate::util::paths;

const COGNITO_KEYCHAIN_SERVICE: &str = "cognito";
const COGNITO_KEYCHAIN_ACCOUNT: &str = "tokens";

fn guarded_install_path(path: &str, install_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(install_root);
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    if !hq_desktop_core::desktop_alt::is_within(&root, &candidate) {
        return Err(format!(
            "refusing path outside install root: {}",
            candidate.display()
        ));
    }
    Ok(candidate)
}

fn guarded_symlink_target(target: &str, link_path: &Path, root: &Path) -> Result<(), String> {
    let link_parent = link_path.parent().unwrap_or(root);
    let resolved = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        link_parent.join(target)
    };
    if !hq_desktop_core::desktop_alt::is_within(root, &resolved) {
        return Err(format!(
            "refusing symlink target outside install root: {}",
            resolved.display()
        ));
    }
    Ok(())
}

fn run_open_command(program: &str, args: &[&str]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {program}: {e}"))
}

/// Legacy installer alias for the unified AI-tool probe.
#[tauri::command]
pub fn check_ai_tools() -> ai_tools::AiTools {
    ai_tools::detect_ai_tools()
}

/// Legacy telemetry device id. The unified app uses the persisted machineId.
#[tauri::command]
pub fn device_fingerprint() -> Result<String, String> {
    crate::commands::config::ensure_machine_id()
}

/// Legacy keychain bridge for installer Cognito tokens.
///
/// The unified app persists the same token shape in `~/.hq/cognito-tokens.json`;
/// old callers that still invoke the keychain commands are mapped there.
#[tauri::command]
pub async fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
    if service != COGNITO_KEYCHAIN_SERVICE || account != COGNITO_KEYCHAIN_ACCOUNT {
        return Err("unsupported compat keychain entry".to_string());
    }
    let tokens: cognito::CognitoTokens =
        serde_json::from_str(&secret).map_err(|e| format!("invalid cognito token payload: {e}"))?;
    cognito::set_tokens(&tokens).await
}

/// Legacy keychain read mapped to the unified Cognito token file.
#[tauri::command]
pub async fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
    if service != COGNITO_KEYCHAIN_SERVICE || account != COGNITO_KEYCHAIN_ACCOUNT {
        return Ok(None);
    }
    cognito::get_tokens()
        .await?
        .map(|tokens| serde_json::to_string(&tokens).map_err(|e| e.to_string()))
        .transpose()
}

/// Legacy keychain delete mapped to unified sign-out token cleanup.
#[tauri::command]
pub async fn keychain_delete(service: String, account: String) -> Result<(), String> {
    if service == COGNITO_KEYCHAIN_SERVICE && account == COGNITO_KEYCHAIN_ACCOUNT {
        cognito::clear_tokens().await?;
    }
    Ok(())
}

/// Preserve the old installer telemetry toggle write.
#[tauri::command]
pub fn write_menubar_telemetry_pref(enabled: bool) -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[("telemetryEnabled", Value::Bool(enabled))],
    )
}

/// Preserve the old installer HQ-path write.
#[tauri::command]
pub fn write_menubar_hq_path(hq_path: String) -> Result<(), String> {
    install_directory::set_hq_install_path(hq_path)
}

/// Legacy installer home-dir helper.
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Legacy template extractor write helper. Kept root-confined.
#[tauri::command]
pub fn write_file(
    path: String,
    contents: Vec<u8>,
    install_root: String,
    mode: Option<u32>,
) -> Result<(), String> {
    let file_path = guarded_install_path(&path, &install_root)?;
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent directory: {e}"))?;
    }

    let tmp = file_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp, &contents).map_err(|e| format!("failed to write temp file: {e}"))?;
    std::fs::rename(&tmp, &file_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("failed to commit file {}: {e}", file_path.display())
    })?;

    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(mode & 0o7777))
            .map_err(|e| format!("failed to set file permissions: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;

    Ok(())
}

/// Legacy template extractor mkdir helper. Kept root-confined.
#[tauri::command]
pub fn make_dir(path: String, install_root: String) -> Result<(), String> {
    let dir_path = guarded_install_path(&path, &install_root)?;
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("failed to create directory {}: {e}", dir_path.display()))
}

/// Legacy template/import read helper. Kept root-confined.
#[tauri::command]
pub fn read_text_file(path: String, install_root: String) -> Result<String, String> {
    let file_path = guarded_install_path(&path, &install_root)?;
    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("failed to read file {}: {e}", file_path.display()))
}

/// Legacy template symlink helper. The unified extractor uses the same body.
#[tauri::command]
pub fn create_symlink(target: String, link_path: String, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let link = guarded_install_path(&link_path, &root)?;
    guarded_symlink_target(&target, &link, &root_path)?;
    content::create_symlink_impl(Path::new(&target), &link)
}

/// Legacy staging-toggle read alias.
#[tauri::command]
pub fn get_use_staging_source() -> Result<bool, String> {
    content::get_staging_source()
}

fn github_token_from_gh() -> Result<String, String> {
    let gh = paths::resolve_bin("gh");
    let output = Command::new(&gh)
        .args(["auth", "token"])
        .env("PATH", paths::child_path())
        .output()
        .map_err(|e| format!("failed to invoke `gh auth token`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`gh auth token` failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err("`gh auth token` returned empty output".to_string());
    }
    Ok(token)
}

/// Legacy staging tarball helper. New onboarding uses `fetch_and_extract_template`;
/// this preserves old automation that still asks Rust for the private tarball.
#[tauri::command]
pub fn download_staging_tarball() -> Result<Vec<u8>, String> {
    let token = github_token_from_gh()?;
    let url = "https://api.github.com/repos/indigoai-us/hq-core-staging/tarball/main";
    let response = reqwest::blocking::Client::new()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(
            reqwest::header::USER_AGENT,
            format!("hq-sync-menubar/{}", env!("CARGO_PKG_VERSION")),
        )
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("network error downloading staging template: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "GitHub staging tarball download failed: HTTP {status}"
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("failed to read staging template bytes: {e}"))
}

/// The unified app already owns single-instance behavior through the Tauri
/// plugin; old installer callers can treat this process as primary.
#[tauri::command]
pub fn is_primary_instance() -> bool {
    true
}

/// See [`is_primary_instance`].
#[tauri::command]
pub fn recheck_primary_instance() -> bool {
    true
}

/// Legacy installer post-install launch. In the unified app, show the running
/// menubar surface.
#[tauri::command]
pub async fn launch_menubar_app(app: AppHandle) -> Result<(), String> {
    crate::tray::show_window_at_tray(&app);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenubarStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub exe_path: Option<String>,
}

/// Legacy Windows installer status probe. The unified app is already running.
#[tauri::command]
pub fn menubar_installed() -> MenubarStatus {
    MenubarStatus {
        installed: true,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        exe_path: std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn launch_claude_desktop() -> Result<(), String> {
    run_open_command("open", &["-a", "Claude"])
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[tauri::command]
pub fn launch_claude_desktop() -> Result<(), String> {
    Err("Claude Desktop launch is not available on this platform".to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn launch_claude_desktop() -> Result<(), String> {
    run_open_command("cmd", &["/C", "start", "", "claude://"])
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn launch_codex_desktop() -> Result<(), String> {
    run_open_command("open", &["-a", "Codex"])
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[tauri::command]
pub fn launch_codex_desktop() -> Result<(), String> {
    Err("Codex Desktop launch is not available on this platform".to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn launch_codex_desktop() -> Result<(), String> {
    run_open_command("cmd", &["/C", "start", "", "codex://"])
}

#[tauri::command]
pub fn claude_desktop_installed() -> bool {
    ai_tools::detect_ai_tools().claude_desktop
}

#[cfg(windows)]
#[tauri::command]
pub fn add_claude_trusted_folder(_hq_path: String) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn open_developer_settings() -> Result<(), String> {
    crate::commands::long_paths::open_long_paths_settings()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn new_files_detail_capability_grants_legacy_permissions() {
        let path = manifest_dir()
            .join("capabilities")
            .join("new-files-detail.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(value["windows"], serde_json::json!(["new-files-detail"]));
        let permissions = value["permissions"].as_array().unwrap();
        for expected in [
            "core:default",
            "core:event:default",
            "core:window:allow-close",
            "core:window:allow-set-focus",
        ] {
            assert!(
                permissions.iter().any(|p| p == expected),
                "missing {expected}"
            );
        }
    }

    #[test]
    fn desktop_alt_capability_keeps_window_focus_and_close() {
        let path = manifest_dir().join("capabilities").join("desktop-alt.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let permissions = value["permissions"].as_array().unwrap();
        assert!(permissions.iter().any(|p| p == "core:window:allow-close"));
        assert!(permissions
            .iter()
            .any(|p| p == "core:window:allow-set-focus"));
    }

    #[test]
    fn compat_commands_are_registered_in_main_handler() {
        let main_rs = std::fs::read_to_string(manifest_dir().join("src/main.rs")).unwrap();
        for command in [
            "commands::notification_history::open_notification_history",
            "commands::packages::open_packages_window",
            "commands::packages::packages_window_ready",
            "commands::install_stages::git_probe_user",
            "commands::install_deps::install_pnpm",
            "commands::install_deps::install_rsync",
            "commands::install_deps::ensure_shims",
            "commands::compat::check_ai_tools",
            "commands::compat::device_fingerprint",
            "commands::compat::keychain_set",
            "commands::compat::keychain_get",
            "commands::compat::keychain_delete",
            "commands::oauth::oauth_cancel_listen",
            "commands::compat::write_menubar_telemetry_pref",
            "commands::compat::write_menubar_hq_path",
            "commands::compat::home_dir",
            "commands::compat::write_file",
            "commands::compat::make_dir",
            "commands::compat::read_text_file",
            "commands::compat::create_symlink",
            "commands::compat::get_use_staging_source",
            "commands::compat::download_staging_tarball",
            "commands::compat::is_primary_instance",
            "commands::compat::recheck_primary_instance",
            "commands::compat::launch_menubar_app",
            "commands::compat::menubar_installed",
            "commands::compat::launch_claude_desktop",
            "commands::compat::launch_codex_desktop",
            "commands::compat::claude_desktop_installed",
            "commands::compat::add_claude_trusted_folder",
            "commands::compat::open_developer_settings",
        ] {
            assert!(main_rs.contains(command), "missing handler for {command}");
        }
    }
}
