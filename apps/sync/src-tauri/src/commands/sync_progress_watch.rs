//! Cross-process sync progress watcher.
//!
//! hq-cloud writes `~/.hq/sync-progress.json` on EVERY sync — the auto-sync
//! watch daemon, "Sync Now", and a CLI `hq sync`. This poller surfaces that
//! file to the popover so live progress shows for ANY sync, not just one the
//! menubar spawned and reads over stdout. The richer stdout path still drives a
//! manual Sync Now; the frontend gates these events out while a manual sync is
//! in flight so the two sources never fight.
//!
use std::time::Duration;

use hq_desktop_core::sync_progress::{read_fresh_snapshot, SyncProgressSnapshot};
use tauri::{AppHandle, Emitter};

/// Poll cadence. The file is rewritten several times a second during a
/// transfer, so 1s is responsive without busy-looping.
const POLL_INTERVAL_MS: u64 = 1000;

/// Spawn the background poller. Emits `sync:external-progress` (the snapshot)
/// when an active sync advances, and `sync:external-idle` once it ends.
pub fn setup_sync_progress_watch(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut was_active = false;
        // Dedup key — only emit when the snapshot actually moved.
        let mut last_key = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            let snapshot: Option<SyncProgressSnapshot> = read_fresh_snapshot();
            match snapshot {
                Some(snap) if snap.status == "syncing" => {
                    let key = format!(
                        "{}|{}|{}|{}|{}",
                        snap.pid,
                        snap.phase,
                        snap.files_done,
                        snap.files_total,
                        snap.current_file.as_deref().unwrap_or("")
                    );
                    if key != last_key {
                        last_key = key;
                        let _ = handle.emit("sync:external-progress", &snap);
                    }
                    was_active = true;
                }
                _ => {
                    if was_active {
                        was_active = false;
                        last_key.clear();
                        let _ = handle.emit("sync:external-idle", ());
                    }
                }
            }
        }
    });
}
