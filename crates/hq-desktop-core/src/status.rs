//! Sync status parsing and journal I/O.

use std::io::Read;
use std::path::{Path, PathBuf};

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

// ─────────────────────────────────────────────────────────────────────────────
// Engine journal reconciliation
// ─────────────────────────────────────────────────────────────────────────────
//
// `{hq_folder}/.hq-sync-journal.json` is written only when *this app* completes
// a run, while the sync engine records every run — including a `hq sync` typed
// into a terminal — in its own per-company `sync-journal.<slug>.json` under the
// state directory. A user whose daemon can't start therefore sees "Never
// synced" forever even after a manual sync visibly succeeded. Folding the
// engine's stamp into the status the badge reads makes it honest without
// inventing a new status source: `SyncStatus.source` already distinguishes
// `"cli"` from `"journal"`.

/// How much of an engine journal is read looking for its `lastSync` stamp.
///
/// The engine writes `version` and `lastSync` ahead of the `files` map, and
/// that map runs to megabytes on a populated vault — the status surface is
/// polled continuously, so it reads the head rather than parsing the document.
const JOURNAL_HEAD_BYTES: u64 = 8 * 1024;

/// Pull the `lastSync` stamp out of the head of an engine journal.
///
/// Returns `None` for a journal that has never synced (the engine writes an
/// empty string), for a non-string value, and for a head too short to contain
/// the field — all of which leave the desktop journal's own answer standing.
pub fn extract_last_sync(head: &str) -> Option<String> {
    const KEY: &str = "\"lastSync\"";
    let after_key = &head[head.find(KEY)? + KEY.len()..];
    let after_colon = &after_key[after_key.find(':')? + 1..];
    let quote = after_colon.find('"')?;
    if !after_colon[..quote].trim().is_empty() {
        return None;
    }
    let value = &after_colon[quote + 1..];
    let stamp = &value[..value.find('"')?];
    (!stamp.is_empty()).then(|| stamp.to_string())
}

/// Read the head of a journal as text, tolerating a cut mid-character.
///
/// The byte limit lands wherever it lands, and a vault with non-ASCII filenames
/// puts multibyte sequences well inside it. Decoding strictly would reject the
/// whole head — including the `lastSync` sitting in its first hundred bytes —
/// and leave the badge stale for exactly the users most likely to hit it, so a
/// trailing partial character is dropped instead.
fn read_journal_head(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(JOURNAL_HEAD_BYTES).read_to_end(&mut bytes).ok()?;
    Some(match String::from_utf8(bytes) {
        Ok(head) => head,
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).ok()?
        }
    })
}

/// Is `candidate` a later timestamp than `current`?
///
/// RFC 3339 comparison, falling back to a lexicographic one when either side
/// doesn't parse — journals are written by two codebases, so an unexpected
/// format must degrade rather than throw the newer stamp away.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(candidate),
        chrono::DateTime::parse_from_rfc3339(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => candidate > current,
    }
}

/// Newest `lastSync` across the engine's per-company journals in `state_dir`.
pub fn newest_engine_sync_at_in(state_dir: &Path) -> Option<String> {
    let mut newest: Option<String> = None;
    for entry in std::fs::read_dir(state_dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // `sync-journal.<slug>.json` only — never the `.tmp` a write is
        // staging through, nor a `.last-good` snapshot beside it.
        if !(name.starts_with("sync-journal.") && name.ends_with(".json")) {
            continue;
        }
        let Some(stamp) = read_journal_head(&entry.path()).as_deref().and_then(extract_last_sync)
        else {
            continue;
        };
        if newest.as_deref().map_or(true, |current| is_newer(&stamp, current)) {
            newest = Some(stamp);
        }
    }
    newest
}

/// Newest `lastSync` the sync engine has recorded on this machine.
pub fn newest_engine_sync_at() -> Option<String> {
    newest_engine_sync_at_in(&crate::journal::state_dir())
}

/// Fold the engine's newest sync stamp into a desktop status.
///
/// Only `lastSyncAt` is taken: pending/conflict counts and daemon liveness are
/// this app's own observations and stay as they were. The engine's stamp wins
/// only when it is genuinely newer (or the app has never recorded one), so a
/// fresh in-app sync is never rolled back to an older terminal run.
pub fn merge_engine_sync_at(mut status: SyncStatus, engine_last_sync: Option<String>) -> SyncStatus {
    let Some(engine) = engine_last_sync else {
        return status;
    };
    let supersedes = match status.last_sync_at.as_deref() {
        None => true,
        Some(current) => is_newer(&engine, current),
    };
    if supersedes {
        status.last_sync_at = Some(engine);
        status.source = "cli".to_string();
    }
    status
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
    journal_for_completed_sync(now_iso, conflicts, false)
}

/// Build the journal record written after an auto-sync daemon pass.
///
/// Unlike a foreground "Sync Now" run, the watch daemon remains alive after
/// it emits `all-complete`. Persisting that fact prevents the status surface
/// from reporting `daemonRunning: false` while the healthy watcher is still
/// responsible for the next cycle.
pub fn journal_for_daemon_sync_complete(now_iso: &str, conflicts: u32) -> SyncJournal {
    journal_for_completed_sync(now_iso, conflicts, true)
}

fn journal_for_completed_sync(now_iso: &str, conflicts: u32, daemon_running: bool) -> SyncJournal {
    SyncJournal {
        last_sync_at: Some(now_iso.to_string()),
        pending_files: Some(conflicts),
        conflicts: Some(conflicts),
        daemon_running: Some(daemon_running),
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

    #[test]
    fn test_journal_for_daemon_sync_complete_marks_daemon_running() {
        let journal = journal_for_daemon_sync_complete("2026-04-20T12:25:22.400Z", 0);
        assert_eq!(journal.daemon_running, Some(true));
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

    // ── Engine journal reconciliation ────────────────────────────────────

    fn engine_journal(last_sync: &str) -> String {
        format!(
            r#"{{"version":"1","lastSync":"{last_sync}","files":{{"README.md":{{"hash":"abc","size":1,"syncedAt":"{last_sync}","direction":"up"}}}}}}"#
        )
    }

    #[test]
    fn test_extract_last_sync_reads_the_engine_stamp() {
        assert_eq!(
            extract_last_sync(&engine_journal("2026-07-30T18:04:11Z")),
            Some("2026-07-30T18:04:11Z".to_string())
        );
    }

    #[test]
    fn test_extract_last_sync_treats_never_synced_as_absent() {
        // The engine writes an empty string before its first successful run.
        assert_eq!(extract_last_sync(&engine_journal("")), None);
    }

    #[test]
    fn test_extract_last_sync_ignores_a_non_string_value() {
        assert_eq!(extract_last_sync(r#"{"lastSync":null,"files":{}}"#), None);
    }

    #[test]
    fn test_extract_last_sync_ignores_a_truncated_head() {
        assert_eq!(extract_last_sync(r#"{"version":"1","lastSy"#), None);
    }

    #[test]
    fn test_newest_engine_sync_at_picks_the_latest_company() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("sync-journal.audiohook.json"),
            engine_journal("2026-07-29T09:00:00Z"),
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("sync-journal.indigo.json"),
            engine_journal("2026-07-30T18:04:11Z"),
        )
        .unwrap();
        // Neither a staging temp file nor a snapshot is a live journal.
        std::fs::write(
            tmp.path().join("sync-journal.indigo.json.tmp"),
            engine_journal("2027-01-01T00:00:00Z"),
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("sync-journal.indigo.json.last-good"),
            engine_journal("2028-01-01T00:00:00Z"),
        )
        .unwrap();

        assert_eq!(
            newest_engine_sync_at_in(tmp.path()),
            Some("2026-07-30T18:04:11Z".to_string())
        );
    }

    #[test]
    fn test_a_multibyte_journal_still_yields_its_stamp() {
        // The head cut lands wherever it lands, and a vault with non-ASCII
        // filenames puts multibyte sequences across it. Rejecting the whole
        // head would strand the badge for exactly those users.
        let tmp = tempfile::tempdir().unwrap();
        let padding = "é".repeat(JOURNAL_HEAD_BYTES as usize);
        std::fs::write(
            tmp.path().join("sync-journal.indigo.json"),
            format!(
                r#"{{"version":"1","lastSync":"2026-07-30T18:04:11Z","files":{{"{padding}.md":{{"hash":"abc"}}}}}}"#
            ),
        )
        .unwrap();

        assert_eq!(
            newest_engine_sync_at_in(tmp.path()),
            Some("2026-07-30T18:04:11Z".to_string())
        );
    }

    #[test]
    fn test_newest_engine_sync_at_is_none_without_journals() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(newest_engine_sync_at_in(tmp.path()), None);
        assert_eq!(
            newest_engine_sync_at_in(&tmp.path().join("missing")),
            None,
            "an absent state dir must not be an error"
        );
    }

    #[test]
    fn test_merge_reports_a_terminal_sync_the_app_never_saw() {
        // REGRESSION (B3): a machine whose daemon can never start has no
        // desktop journal at all, so the badge read "Never synced" even
        // straight after a successful `hq sync` in a terminal.
        let merged = merge_engine_sync_at(
            default_status(),
            Some("2026-07-30T18:04:11Z".to_string()),
        );
        assert_eq!(merged.last_sync_at, Some("2026-07-30T18:04:11Z".to_string()));
        assert_eq!(merged.source, "cli");
    }

    #[test]
    fn test_merge_keeps_a_newer_in_app_sync() {
        let status = SyncStatus {
            last_sync_at: Some("2026-07-30T20:00:00Z".to_string()),
            pending_files: 2,
            conflicts: 1,
            daemon_running: true,
            source: "journal".to_string(),
        };
        let merged =
            merge_engine_sync_at(status.clone(), Some("2026-07-30T18:04:11Z".to_string()));
        assert_eq!(merged, status, "an older engine stamp must not win");
    }

    #[test]
    fn test_merge_preserves_app_owned_fields() {
        let status = SyncStatus {
            last_sync_at: Some("2026-07-29T09:00:00Z".to_string()),
            pending_files: 4,
            conflicts: 3,
            daemon_running: true,
            source: "journal".to_string(),
        };
        let merged = merge_engine_sync_at(status, Some("2026-07-30T18:04:11Z".to_string()));
        assert_eq!(merged.last_sync_at, Some("2026-07-30T18:04:11Z".to_string()));
        assert_eq!(merged.pending_files, 4);
        assert_eq!(merged.conflicts, 3);
        assert!(merged.daemon_running);
    }

    #[test]
    fn test_merge_without_an_engine_stamp_is_a_no_op() {
        let status = default_status();
        assert_eq!(merge_engine_sync_at(status.clone(), None), status);
    }

    #[test]
    fn test_is_newer_falls_back_to_lexicographic_on_unparseable_input() {
        assert!(is_newer("2026-07-30T18:04:11Z", "2026-07-29T09:00:00Z"));
        assert!(!is_newer("2026-07-29T09:00:00Z", "2026-07-30T18:04:11Z"));
        assert!(is_newer("2026-07-30 18:04", "2026-07-29 09:00"));
    }

    #[test]
    fn test_write_journal_errors_on_nonexistent_folder() {
        let journal = journal_for_sync_complete("2026-04-20T12:25:22.400Z", 0);
        let result = write_journal("/nonexistent/path/that/does/not/exist", &journal);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to write"));
    }
}
