//! Conflict resolution commands — resolve file conflicts and open in editor.

use std::process::Command;
use std::time::Duration;

use crate::commands::config::MenubarPrefs;
use crate::util::paths;
use hq_desktop_core::conflicts::{build_full_path, build_resolve_args, validate_strategy};

/// CLI command timeout (10 seconds).
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (same pattern as sync.rs / status.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the HQ folder path by reading config.json and menubar.json directly.
fn resolve_hq_folder_path() -> Result<String, String> {
    let menubar_path = paths::menubar_json_path()?;

    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    // Shared lenient reader: parse failures fall through to menubar/discovery,
    // but real IO errors still propagate as Err. Uniform across all four
    // `resolve_hq_folder_path` duplicates.
    let config = crate::commands::config::read_hq_config_lenient()?;

    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    Ok(hq_folder.to_string_lossy().to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve a file conflict using the specified strategy.
///
/// - `strategy` must be `"keep-local"` or `"keep-remote"`.
/// - Runs `hq sync resolve --strategy {strategy} --path {path} --hq-path {hq_folder}`.
/// - Times out after 10 seconds; the child process is killed if it exceeds this.
#[tauri::command]
pub fn resolve_conflict(path: String, strategy: String) -> Result<(), String> {
    validate_strategy(&strategy)?;

    let hq_folder = resolve_hq_folder_path()?;
    let args = build_resolve_args(&strategy, &path, &hq_folder);

    #[cfg(debug_assertions)]
    eprintln!("[conflicts] resolving {} with strategy {}", path, strategy);

    let mut child = Command::new(paths::resolve_bin("hq"))
        .args(&args)
        .env("HQ_ROOT", &hq_folder)
        .env("PATH", paths::child_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn hq CLI: {}", e))?;

    // Wait with timeout — kill the process if it takes too long
    let start = std::time::Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= RESOLVE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err("hq sync resolve timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to wait for hq CLI: {}", e)),
        }
    };

    if !exit_status.success() {
        let mut stderr_buf = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut stderr_buf);
        }
        return Err(format!(
            "hq sync resolve exited with code {}: {}",
            exit_status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr_buf.trim()
        ));
    }

    Ok(())
}

/// Open a file in the system default editor.
///
/// Resolves the HQ folder path, constructs the full path as `{hq_folder}/{path}`,
/// and uses macOS `open` command to launch the default application.
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    let hq_folder = resolve_hq_folder_path()?;
    let full_path = build_full_path(&hq_folder, &path)?;

    #[cfg(debug_assertions)]
    eprintln!("[conflicts] opening in editor: {}", full_path);

    let output = Command::new("open")
        .arg(&full_path)
        .output()
        .map_err(|e| format!("Failed to run open command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open command failed with code {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Timeout constant ────────────────────────────────────────────────

    #[test]
    fn test_resolve_timeout_value() {
        assert_eq!(RESOLVE_TIMEOUT, Duration::from_secs(10));
    }
}
