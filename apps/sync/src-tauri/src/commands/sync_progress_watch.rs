//! Cross-process sync progress watcher.
//!
//! hq-cloud writes `~/.hq/sync-progress.json` on EVERY sync — the auto-sync
//! watch daemon, "Sync Now", and a CLI `hq sync`. This poller surfaces that
//! file to the popover so live progress shows for ANY sync, not just one the
//! menubar spawned and reads over stdout. The richer stdout path still drives a
//! manual Sync Now; the frontend gates these events out while a manual sync is
//! in flight so the two sources never fight.
//!
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

use hq_desktop_core::hq_daemon::{default_last_pass_path, read_last_pass, LastPassTracker};
use hq_desktop_core::paths::hq_config_dir;
use hq_desktop_core::sync_progress::SyncProgressSnapshot;
use tauri::{AppHandle, Emitter};

/// Poll cadence. The file is rewritten several times a second during a
/// transfer, so 1s is responsive without busy-looping.
const POLL_INTERVAL_MS: u64 = 1000;
const SYNC_PROGRESS_STALE_AFTER_SECS: u64 = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileRevision {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
}

fn file_revision(path: &Path) -> Option<FileRevision> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileRevision {
        len: metadata.len(),
        modified: metadata.modified().ok()?,
        #[cfg(unix)]
        device: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
        #[cfg(unix)]
        changed: {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        },
    })
}

#[derive(Debug)]
struct FileReadCache<T> {
    initialized: bool,
    revision: Option<FileRevision>,
    value: Option<T>,
}

impl<T: Clone> Default for FileReadCache<T> {
    fn default() -> Self {
        Self {
            initialized: false,
            revision: None,
            value: None,
        }
    }
}

impl<T: Clone> FileReadCache<T> {
    fn read_if_changed(&mut self, path: &Path, read: impl FnOnce(&Path) -> Option<T>) -> Option<T> {
        let revision = file_revision(path);
        if self.initialized && revision == self.revision {
            return self.value.clone();
        }

        self.initialized = true;
        self.revision = revision.clone();
        self.value = revision.and_then(|_| read(path));
        self.value.clone()
    }

    fn fresh_sync_progress(
        &self,
        snapshot: Option<SyncProgressSnapshot>,
    ) -> Option<SyncProgressSnapshot> {
        let modified = self.revision.as_ref()?.modified;
        let age = SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        (age.as_secs() <= SYNC_PROGRESS_STALE_AFTER_SECS)
            .then_some(snapshot)
            .flatten()
    }
}

/// Spawn the background poller. Emits `sync:external-progress` (the snapshot)
/// when an active sync advances, and `sync:external-idle` once it ends.
pub fn setup_sync_progress_watch(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(config_dir) = hq_config_dir() else {
            return;
        };
        let path = config_dir.join("sync-progress.json");
        let mut cache = FileReadCache::<SyncProgressSnapshot>::default();
        let mut was_active = false;
        // Dedup key — only emit when the snapshot actually moved.
        let mut last_key = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            let snapshot = cache.read_if_changed(&path, |path| {
                hq_desktop_core::sync_progress::read_fresh_snapshot_at(path)
            });
            let snapshot = cache.fresh_sync_progress(snapshot);
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

/// When hq daemon runs sync, the app does not read the runner's stdout. Poll
/// hq-cloud's end-of-pass record instead and run each finished pass through
/// the same per-pass handling (journal, notices, client health, git mirror).
pub fn setup_last_pass_watch(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(path) = default_last_pass_path() else {
            return;
        };
        let mut cache = FileReadCache::default();
        let mut tracker =
            LastPassTracker::starting_after(cache.read_if_changed(&path, read_last_pass));
        let mut last_notice_fingerprint = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            let pass = cache.read_if_changed(&path, read_last_pass);
            if let Some(record) = pass.as_ref() {
                let fingerprint = serde_json::to_string(&record.pending_conflict_notices)
                    .unwrap_or_default();
                if fingerprint != last_notice_fingerprint {
                    last_notice_fingerprint = fingerprint;
                    let _ = handle.emit_to(
                        crate::commands::desktop_alt::WINDOW_LABEL,
                        "sync:conflict-notices",
                        &record.pending_conflict_notices,
                    );
                    crate::commands::hq_daemon_host::notify_new_conflict_batch(
                        &handle,
                        &record.pending_conflict_notices,
                    );
                }
            }
            let Some(pass) = tracker.take_new(pass) else {
                continue;
            };
            let Ok(hq_folder) = hq_desktop_core::daemon::resolve_hq_folder_path() else {
                continue;
            };
            let app = handle.clone();
            // The handler writes the journal and starts the mirror; keep it off the async runtime.
            let _ = tauri::async_runtime::spawn_blocking(move || {
                crate::commands::hq_daemon_host::replay_last_pass(&app, &hq_folder, &pass);
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs, io::Write};

    fn temp_snapshot_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "hq-sync-progress-watch-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn unchanged_progress_file_is_not_reparsed_on_the_next_poll() {
        let path = temp_snapshot_path();
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(br#"{"pid":123,"phase":"pull","filesTotal":10,"filesDone":3,"conflicts":0,"startedAt":"start","updatedAt":"now","status":"syncing"}"#).unwrap();
        drop(file);

        let reads = Cell::new(0);
        let mut cache = FileReadCache::<SyncProgressSnapshot>::default();
        let read = |path: &Path| {
            reads.set(reads.get() + 1);
            let raw = fs::read_to_string(path).ok()?;
            serde_json::from_str(&raw).ok()
        };
        assert!(cache.read_if_changed(&path, read).is_some());
        assert!(cache.read_if_changed(&path, read).is_some());
        assert_eq!(
            reads.get(),
            1,
            "an unchanged one-second poll must skip JSON parsing"
        );

        fs::write(
            &path,
            br#"{"pid":123,"phase":"pull","filesTotal":10,"filesDone":4,"conflicts":0,"startedAt":"start","updatedAt":"later","status":"syncing"}"#,
        )
        .unwrap();
        assert_eq!(cache.read_if_changed(&path, read).unwrap().files_done, 4);
        assert_eq!(
            reads.get(),
            2,
            "a changed snapshot must be read on the next poll"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cached_progress_still_expires_after_the_existing_freshness_window() {
        let mut cache = FileReadCache::<SyncProgressSnapshot>::default();
        cache.initialized = true;
        cache.revision = Some(FileRevision {
            len: 1,
            modified: SystemTime::now() - Duration::from_secs(9),
            #[cfg(unix)]
            device: 0,
            #[cfg(unix)]
            inode: 0,
            #[cfg(unix)]
            changed: (0, 0),
        });
        let snapshot = serde_json::from_str(
            r#"{"pid":123,"phase":"pull","filesTotal":10,"filesDone":3,"conflicts":0,"startedAt":"start","updatedAt":"now","status":"syncing"}"#,
        )
        .unwrap();

        assert!(cache.fresh_sync_progress(Some(snapshot)).is_none());
    }
}
