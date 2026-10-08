//! Cross-process recording activity marker.
//!
//! `recordings-ledger.json` deliberately outlives a process so launch
//! reconciliation can recover a recording. This file has the opposite
//! lifetime: it only says that this *running* desktop process is recording,
//! allowing external updaters to defer a relaunch safely.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::paths::hq_config_dir;

pub const VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    pub recording_id: String,
    pub window_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingActivity {
    pub version: u8,
    pub pid: u32,
    pub updated_at: String,
    pub recordings: Vec<ActiveRecording>,
}

pub fn path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("recording-active.json"))
}

/// Atomically write the active state, or remove it once the last recording
/// ends. The temporary-file pattern matches the adjacent durable ledgers.
pub fn write(recordings: Vec<ActiveRecording>, now: DateTime<Utc>) -> Result<(), String> {
    let target = path()?;
    write_at(&target, std::process::id(), recordings, now)
}

fn write_at(
    target: &std::path::Path,
    pid: u32,
    recordings: Vec<ActiveRecording>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    if recordings.is_empty() {
        if target.exists() {
            fs::remove_file(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec(&RecordingActivity {
        version: VERSION,
        pid,
        updated_at: now.to_rfc3339(),
        recordings,
    })
    .map_err(|e| e.to_string())?;
    let tmp = target.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&body).map_err(|e| e.to_string())?;
    file.sync_all().ok();
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// A new app process must never inherit a predecessor's activity claim.
pub fn cleanup_on_boot() -> Result<(), String> {
    let target = path()?;
    cleanup_at(&target)
}

fn cleanup_at(target: &std::path::Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_file(&target).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_hook_contract() {
        let state = RecordingActivity {
            version: VERSION,
            pid: 42,
            updated_at: "2026-10-07T21:44:00Z".to_string(),
            recordings: vec![ActiveRecording {
                recording_id: "rec-1".to_string(),
                window_id: "win-1".to_string(),
                started_at: "2026-10-07T21:00:00Z".to_string(),
            }],
        };
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["pid"], 42);
        assert_eq!(value["recordings"][0]["recordingId"], "rec-1");
        assert_eq!(value["recordings"][0]["windowId"], "win-1");
    }

    fn recording(id: &str, window: &str) -> ActiveRecording {
        ActiveRecording { recording_id: id.into(), window_id: window.into(), started_at: "2026-10-07T21:00:00Z".into() }
    }

    #[test]
    fn writes_refreshes_shrinks_and_removes_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("recording-active.json");
        let now = DateTime::parse_from_rfc3339("2026-10-07T21:44:00Z").unwrap().with_timezone(&Utc);
        write_at(&marker, 42, vec![recording("rec-1", "win-1"), recording("rec-2", "win-2")], now).unwrap();
        let initial: RecordingActivity = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(initial.recordings.len(), 2);
        write_at(&marker, 42, vec![recording("rec-2", "win-2")], now + chrono::Duration::minutes(1)).unwrap();
        let shrunk: RecordingActivity = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(shrunk.updated_at, "2026-10-07T21:45:00+00:00");
        assert_eq!(shrunk.recordings, vec![recording("rec-2", "win-2")]);
        write_at(&marker, 42, Vec::new(), now).unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn boot_cleanup_removes_stale_marker() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("recording-active.json");
        write_at(&marker, 42, vec![recording("rec-1", "win-1")], Utc::now()).unwrap();
        cleanup_at(&marker).unwrap();
        assert!(!marker.exists());
    }
}
