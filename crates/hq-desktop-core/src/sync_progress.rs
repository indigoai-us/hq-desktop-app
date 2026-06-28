use serde::{Deserialize, Serialize};
use std::time::SystemTime;

use crate::paths::hq_config_dir;

/// If the snapshot hasn't been touched in this long, the sync has ended.
const STALE_AFTER_SECS: u64 = 8;

/// Mirrors hq-cloud's `SyncProgressSnapshot` (camelCase on the wire). Unknown
/// fields (e.g. `schema`) are ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressSnapshot {
    pub pid: i64,
    pub company: Option<String>,
    pub phase: String,
    pub files_total: u64,
    pub files_done: u64,
    pub conflicts: u64,
    pub current_file: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub status: String,
}

/// Read the snapshot only if it's fresh (file mtime within `STALE_AFTER_SECS`).
pub fn read_fresh_snapshot() -> Option<SyncProgressSnapshot> {
    let path = hq_config_dir().ok()?.join("sync-progress.json");
    read_fresh_snapshot_at(&path)
}

/// Path-injectable core of [`read_fresh_snapshot`] — kept separate so it's unit
/// testable without touching the real `~/.hq`.
pub fn read_fresh_snapshot_at(path: &std::path::Path) -> Option<SyncProgressSnapshot> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
    if age.as_secs() > STALE_AFTER_SECS {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SyncProgressSnapshot>(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_file(name: &str, contents: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "hq-sync-progress-test-{}-{}.json",
            std::process::id(),
            name
        ));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        p
    }

    // A snapshot exactly as hq-cloud's createSyncProgressRecorder writes it
    // (camelCase, includes `schema` which we ignore).
    const SAMPLE: &str = r#"{"schema":1,"pid":123,"company":"acme","phase":"pull","filesTotal":10,"filesDone":3,"conflicts":0,"currentFile":"docs/a.md","startedAt":"2026-06-21T00:00:00.000Z","updatedAt":"2026-06-21T00:00:01.000Z","status":"syncing"}"#;

    #[test]
    fn parses_a_fresh_snapshot_ignoring_unknown_fields() {
        let p = tmp_file("fresh", SAMPLE);
        let snap = read_fresh_snapshot_at(&p).expect("a just-written file is fresh");
        assert_eq!(snap.company.as_deref(), Some("acme"));
        assert_eq!(snap.phase, "pull");
        assert_eq!(snap.files_total, 10);
        assert_eq!(snap.files_done, 3);
        assert_eq!(snap.current_file.as_deref(), Some("docs/a.md"));
        assert_eq!(snap.status, "syncing");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn parses_personal_scope_null_company() {
        let p = tmp_file(
            "personal",
            r#"{"schema":1,"pid":1,"company":null,"phase":"push","filesTotal":5,"filesDone":0,"conflicts":0,"currentFile":null,"startedAt":"x","updatedAt":"y","status":"syncing"}"#,
        );
        let snap = read_fresh_snapshot_at(&p).expect("parses");
        assert_eq!(snap.company, None);
        assert_eq!(snap.phase, "push");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_is_none() {
        let mut p = std::env::temp_dir();
        p.push("hq-sync-progress-test-definitely-absent.json");
        let _ = std::fs::remove_file(&p);
        assert!(read_fresh_snapshot_at(&p).is_none());
    }

    #[test]
    fn malformed_json_is_none() {
        let p = tmp_file("bad", "{ not valid json");
        assert!(read_fresh_snapshot_at(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }
}
