//! Sync status parsing and journal I/O.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Response returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub last_sync_at: Option<String>, // ISO 8601 or null if never synced
    pub pending_files: u32,
    pub conflicts: u32,
    pub daemon_running: bool,
    pub source: String, // "cli", "journal", or "none"
}

/// Journal file structure at {HQ_FOLDER}/.hq-sync-journal.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJournal {
    pub last_sync_at: Option<String>,
    pub pending_files: Option<u32>,
    pub conflicts: Option<u32>,
    pub daemon_running: Option<bool>,
}

/// Parse CLI JSON output into SyncStatus.
pub fn parse_cli_output(stdout: &str) -> Result<SyncStatus, String> {
    let mut status: SyncStatus = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse CLI JSON output: {}", e))?;
    status.source = "cli".to_string();
    Ok(status)
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal fallback
// ─────────────────────────────────────────────────────────────────────────────

/// Read and parse the journal file at {hq_folder}/.hq-sync-journal.json.
pub fn try_journal_status(hq_folder_path: &str) -> Result<SyncStatus, String> {
    let journal_path = PathBuf::from(hq_folder_path).join(".hq-sync-journal.json");
    let contents = std::fs::read_to_string(&journal_path)
        .map_err(|e| format!("Failed to read journal file: {}", e))?;
    parse_journal(&contents)
}

/// Parse journal JSON content into SyncStatus.
pub fn parse_journal(contents: &str) -> Result<SyncStatus, String> {
    let journal: SyncJournal = serde_json::from_str(contents.trim())
        .map_err(|e| format!("Failed to parse journal JSON: {}", e))?;
    Ok(journal_to_status(journal))
}

/// Convert a SyncJournal into a SyncStatus with source="journal".
fn journal_to_status(journal: SyncJournal) -> SyncStatus {
    SyncStatus {
        last_sync_at: journal.last_sync_at,
        pending_files: journal.pending_files.unwrap_or(0),
        conflicts: journal.conflicts.unwrap_or(0),
        daemon_running: journal.daemon_running.unwrap_or(false),
        source: "journal".to_string(),
    }
}

/// Default status when neither CLI nor journal is available.
pub fn default_status() -> SyncStatus {
    SyncStatus {
        last_sync_at: None,
        pending_files: 0,
        conflicts: 0,
        daemon_running: false,
        source: "none".to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal writer
// ─────────────────────────────────────────────────────────────────────────────

/// Build a `SyncJournal` representing "sync just completed".
///
/// `conflicts` is the sum of per-company `Complete` event conflicts across
/// the run (see `RunTotals` in `sync.rs`). `pendingFiles` mirrors `conflicts`
/// — both represent files that need user attention before the next sync can
/// complete.
pub fn journal_for_sync_complete(now_iso: &str, conflicts: u32) -> SyncJournal {
    SyncJournal {
        last_sync_at: Some(now_iso.to_string()),
        pending_files: Some(conflicts),
        conflicts: Some(conflicts),
        daemon_running: Some(false),
    }
}

/// Write the journal to `{hq_folder_path}/.hq-sync-journal.json`.
///
/// Overwrites any existing file. Returns `Err` if serialization fails or the
/// path is not writable (e.g. HQ folder doesn't exist).
pub fn write_journal(hq_folder_path: &str, journal: &SyncJournal) -> Result<(), String> {
    let journal_path = PathBuf::from(hq_folder_path).join(".hq-sync-journal.json");
    let contents = serde_json::to_string_pretty(journal)
        .map_err(|e| format!("Failed to serialize journal: {}", e))?;
    std::fs::write(&journal_path, contents)
        .map_err(|e| format!("Failed to write journal file: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── SyncStatus serialization ──────────────────────────────────────────

    #[test]
    fn test_sync_status_serializes_camel_case() {
        let status = SyncStatus {
            last_sync_at: Some("2026-04-18T12:00:00Z".to_string()),
            pending_files: 3,
            conflicts: 1,
            daemon_running: true,
            source: "cli".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"lastSyncAt\""));
        assert!(json.contains("\"pendingFiles\""));
        assert!(json.contains("\"daemonRunning\""));
        assert!(!json.contains("\"last_sync_at\""));
        assert!(!json.contains("\"pending_files\""));
        assert!(!json.contains("\"daemon_running\""));
    }

    #[test]
    fn test_sync_status_roundtrip() {
        let status = SyncStatus {
            last_sync_at: Some("2026-04-18T12:00:00Z".to_string()),
            pending_files: 5,
            conflicts: 2,
            daemon_running: true,
            source: "cli".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        let parsed: SyncStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, parsed);
    }

    #[test]
    fn test_sync_status_null_last_sync() {
        let status = SyncStatus {
            last_sync_at: None,
            pending_files: 0,
            conflicts: 0,
            daemon_running: false,
            source: "none".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"lastSyncAt\":null"));
    }

    // ── SyncJournal deserialization ───────────────────────────────────────

    #[test]
    fn test_journal_deserialize_full() {
        let json = r#"{
            "lastSyncAt": "2026-04-18T10:30:00Z",
            "pendingFiles": 7,
            "conflicts": 2,
            "daemonRunning": true
        }"#;
        let journal: SyncJournal = serde_json::from_str(json).unwrap();
        assert_eq!(
            journal.last_sync_at,
            Some("2026-04-18T10:30:00Z".to_string())
        );
        assert_eq!(journal.pending_files, Some(7));
        assert_eq!(journal.conflicts, Some(2));
        assert_eq!(journal.daemon_running, Some(true));
    }

    #[test]
    fn test_journal_deserialize_minimal() {
        let json = r#"{}"#;
        let journal: SyncJournal = serde_json::from_str(json).unwrap();
        assert_eq!(journal.last_sync_at, None);
        assert_eq!(journal.pending_files, None);
        assert_eq!(journal.conflicts, None);
        assert_eq!(journal.daemon_running, None);
    }

    #[test]
    fn test_journal_deserialize_partial() {
        let json = r#"{"lastSyncAt": "2026-04-18T10:30:00Z", "daemonRunning": false}"#;
        let journal: SyncJournal = serde_json::from_str(json).unwrap();
        assert_eq!(
            journal.last_sync_at,
            Some("2026-04-18T10:30:00Z".to_string())
        );
        assert_eq!(journal.pending_files, None);
        assert_eq!(journal.conflicts, None);
        assert_eq!(journal.daemon_running, Some(false));
    }

    // ── Journal → SyncStatus conversion ──────────────────────────────────

    #[test]
    fn test_journal_to_status_full() {
        let journal = SyncJournal {
            last_sync_at: Some("2026-04-18T10:30:00Z".to_string()),
            pending_files: Some(3),
            conflicts: Some(1),
            daemon_running: Some(true),
        };
        let status = journal_to_status(journal);
        assert_eq!(
            status.last_sync_at,
            Some("2026-04-18T10:30:00Z".to_string())
        );
        assert_eq!(status.pending_files, 3);
        assert_eq!(status.conflicts, 1);
        assert!(status.daemon_running);
        assert_eq!(status.source, "journal");
    }

    #[test]
    fn test_journal_to_status_defaults() {
        let journal = SyncJournal {
            last_sync_at: None,
            pending_files: None,
            conflicts: None,
            daemon_running: None,
        };
        let status = journal_to_status(journal);
        assert_eq!(status.last_sync_at, None);
        assert_eq!(status.pending_files, 0);
        assert_eq!(status.conflicts, 0);
        assert!(!status.daemon_running);
        assert_eq!(status.source, "journal");
    }

    // ── parse_journal ────────────────────────────────────────────────────

    #[test]
    fn test_parse_journal_valid() {
        let contents = r#"{
            "lastSyncAt": "2026-04-18T10:30:00Z",
            "pendingFiles": 5,
            "conflicts": 0,
            "daemonRunning": true
        }"#;
        let status = parse_journal(contents).unwrap();
        assert_eq!(status.pending_files, 5);
        assert_eq!(status.conflicts, 0);
        assert!(status.daemon_running);
        assert_eq!(status.source, "journal");
    }

    #[test]
    fn test_parse_journal_invalid_json() {
        let result = parse_journal("not json");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse journal JSON"));
    }

    #[test]
    fn test_parse_journal_with_whitespace() {
        let contents = "  \n  {\"pendingFiles\": 2}  \n  ";
        let status = parse_journal(contents).unwrap();
        assert_eq!(status.pending_files, 2);
        assert_eq!(status.source, "journal");
    }

    // ── parse_cli_output ─────────────────────────────────────────────────

    #[test]
    fn test_parse_cli_output_valid() {
        let stdout = r#"{
            "lastSyncAt": "2026-04-18T12:00:00Z",
            "pendingFiles": 10,
            "conflicts": 3,
            "daemonRunning": true,
            "source": "ignored"
        }"#;
        let status = parse_cli_output(stdout).unwrap();
        assert_eq!(
            status.last_sync_at,
            Some("2026-04-18T12:00:00Z".to_string())
        );
        assert_eq!(status.pending_files, 10);
        assert_eq!(status.conflicts, 3);
        assert!(status.daemon_running);
        // source is overwritten to "cli"
        assert_eq!(status.source, "cli");
    }

    #[test]
    fn test_parse_cli_output_invalid() {
        let result = parse_cli_output("garbage output");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Failed to parse CLI JSON output"));
    }

    #[test]
    fn test_parse_cli_output_with_trailing_newline() {
        let stdout = "{\"lastSyncAt\":null,\"pendingFiles\":0,\"conflicts\":0,\"daemonRunning\":false,\"source\":\"cli\"}\n";
        let status = parse_cli_output(stdout).unwrap();
        assert_eq!(status.pending_files, 0);
        assert_eq!(status.source, "cli");
    }

    // ── default_status ───────────────────────────────────────────────────

    #[test]
    fn test_default_status() {
        let status = default_status();
        assert_eq!(status.last_sync_at, None);
        assert_eq!(status.pending_files, 0);
        assert_eq!(status.conflicts, 0);
        assert!(!status.daemon_running);
        assert_eq!(status.source, "none");
    }

    // ── journal_for_sync_complete ────────────────────────────────────────

    #[test]
    fn test_journal_for_sync_complete_sets_last_sync_at() {
        let journal = journal_for_sync_complete("2026-04-20T12:25:22.400Z", 0);
        assert_eq!(
            journal.last_sync_at,
            Some("2026-04-20T12:25:22.400Z".to_string())
        );
        assert_eq!(journal.pending_files, Some(0));
        assert_eq!(journal.conflicts, Some(0));
        assert_eq!(journal.daemon_running, Some(false));
    }

    #[test]
    fn test_journal_for_sync_complete_mirrors_conflicts_as_pending() {
        let journal = journal_for_sync_complete("2026-04-20T12:25:22.400Z", 5);
        assert_eq!(journal.pending_files, Some(5));
        assert_eq!(journal.conflicts, Some(5));
    }

    // ── write_journal ────────────────────────────────────────────────────

    #[test]
    fn test_write_journal_creates_file() {
        let tmp = tempfile::tempdir().unwrap();
        let hq_folder = tmp.path().to_str().unwrap();
        let journal = journal_for_sync_complete("2026-04-20T12:25:22.400Z", 0);
        write_journal(hq_folder, &journal).unwrap();
        let expected_path = tmp.path().join(".hq-sync-journal.json");
        assert!(expected_path.exists(), "journal file should exist");
    }

    #[test]
    fn test_write_journal_content_camel_case() {
        let tmp = tempfile::tempdir().unwrap();
        let hq_folder = tmp.path().to_str().unwrap();
        let journal = SyncJournal {
            last_sync_at: Some("2026-04-20T12:25:22.400Z".to_string()),
            pending_files: Some(3),
            conflicts: Some(1),
            daemon_running: Some(true),
        };
        write_journal(hq_folder, &journal).unwrap();
        let contents = std::fs::read_to_string(tmp.path().join(".hq-sync-journal.json")).unwrap();
        assert!(contents.contains("\"lastSyncAt\""));
        assert!(contents.contains("\"pendingFiles\""));
        assert!(contents.contains("\"conflicts\""));
        assert!(contents.contains("\"daemonRunning\""));
        assert!(!contents.contains("\"last_sync_at\""));
        assert!(!contents.contains("\"pending_files\""));
        assert!(!contents.contains("\"daemon_running\""));
    }

    #[test]
    fn test_write_journal_roundtrip_via_reader() {
        let tmp = tempfile::tempdir().unwrap();
        let hq_folder = tmp.path().to_str().unwrap();
        let journal = SyncJournal {
            last_sync_at: Some("2026-04-20T12:25:22.400Z".to_string()),
            pending_files: Some(3),
            conflicts: Some(1),
            daemon_running: Some(true),
        };
        write_journal(hq_folder, &journal).unwrap();
        let status = try_journal_status(hq_folder).unwrap();
        assert_eq!(status.last_sync_at, journal.last_sync_at);
        assert_eq!(status.pending_files, 3);
        assert_eq!(status.conflicts, 1);
        assert!(status.daemon_running);
        assert_eq!(status.source, "journal");
    }

    #[test]
    fn test_write_journal_overwrites_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let hq_folder = tmp.path().to_str().unwrap();
        let first = SyncJournal {
            last_sync_at: Some("2026-01-01T00:00:00Z".to_string()),
            pending_files: Some(5),
            conflicts: Some(0),
            daemon_running: Some(false),
        };
        write_journal(hq_folder, &first).unwrap();
        let second = SyncJournal {
            last_sync_at: Some("2026-04-20T12:25:22.400Z".to_string()),
            pending_files: Some(0),
            conflicts: Some(0),
            daemon_running: Some(false),
        };
        write_journal(hq_folder, &second).unwrap();
        let status = try_journal_status(hq_folder).unwrap();
        assert_eq!(status.last_sync_at, second.last_sync_at);
        assert_eq!(status.pending_files, 0);
    }

    #[test]
    fn test_write_journal_errors_on_nonexistent_folder() {
        let journal = journal_for_sync_complete("2026-04-20T12:25:22.400Z", 0);
        let result = write_journal("/nonexistent/path/that/does/not/exist", &journal);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to write"));
    }
}
