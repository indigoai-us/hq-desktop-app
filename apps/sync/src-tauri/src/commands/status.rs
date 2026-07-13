//! Sync status polling — invokes `hq sync status --json` or falls back to journal file.
//!
//! This is a one-shot synchronous query (not a streaming subprocess), so it uses
//! `std::process::Command` directly rather than the process registry.

use std::time::Duration;

use crate::commands::config::MenubarPrefs;
use crate::util::paths;

#[allow(unused_imports)]
pub use hq_desktop_core::status::{
    default_status, journal_for_sync_complete, parse_cli_output, parse_journal, try_journal_status,
    write_journal, SyncJournal, SyncStatus,
};

/// CLI command timeout (5 seconds).
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (same pattern as sync.rs)
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
// CLI status query
// ─────────────────────────────────────────────────────────────────────────────

/// Try to get sync status via `hq sync status --json`.
/// Returns Ok(SyncStatus) on success, Err(reason) on failure.
/// Times out after STATUS_TIMEOUT (5 seconds).
///
/// Not currently invoked (see `get_sync_status` doc comment). Retained
/// so Phase 8+ can re-enable if the split-binary runner grows a status
/// subcommand.
#[allow(dead_code)]
fn try_cli_status(hq_folder_path: &str) -> Result<SyncStatus, String> {
    let hq = paths::resolve_bin("hq");
    let mut cmd = paths::spawn_command(&hq, &[]);
    let mut child = cmd
        .args(["sync", "status", "--json", "--hq-path", hq_folder_path])
        .env("HQ_ROOT", hq_folder_path)
        .env("PATH", paths::child_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn hq CLI: {}", e))?;

    // Wait with timeout — kill the process if it takes too long
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_exit_status)) => break,
            Ok(None) => {
                if start.elapsed() >= STATUS_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err("hq sync status timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to wait for hq CLI: {}", e)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read hq CLI output: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "hq sync status exited with code {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    hq_desktop_core::status::parse_cli_output(&stdout)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command
// ─────────────────────────────────────────────────────────────────────────────

/// Get the current sync status.
///
/// Reads `{hq_folder}/.hq-sync-journal.json` — the canonical status source
/// post-ADR-0001 (split-binary). The old `hq sync status --json` CLI path
/// is retained in `try_cli_status` for potential Phase 8+ revival but is
/// not invoked: the split removed that subcommand, so calling it only
/// produced noisy "unknown option '--json'" errors every poll.
///
/// If the journal doesn't exist yet (pre-first-sync), returns a default
/// SyncStatus with everything zeroed/null.
#[tauri::command]
pub async fn get_sync_status() -> Result<SyncStatus, String> {
    let hq_folder_path = resolve_hq_folder_path()?;

    match hq_desktop_core::status::try_journal_status(&hq_folder_path) {
        Ok(status) => Ok(status),
        Err(_e) => {
            #[cfg(debug_assertions)]
            eprintln!("[status] Journal not available, returning default: {}", _e);
            Ok(hq_desktop_core::status::default_status())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── STATUS_TIMEOUT constant ──────────────────────────────────────────

    #[test]
    fn test_status_timeout_value() {
        assert_eq!(STATUS_TIMEOUT, Duration::from_secs(5));
    }
}
