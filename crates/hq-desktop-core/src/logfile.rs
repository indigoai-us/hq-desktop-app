//! Append-only diagnostic log at `~/.hq/logs/hq-sync.log`.
//!
//! All `eprintln!` checkpoints in the sync pipeline are gated on
//! `#[cfg(debug_assertions)]` and only land in the terminal where `tauri dev`
//! was launched. That is fine for active development but leaves zero
//! breadcrumbs when the menubar app is launched normally and a sync hangs.
//! This module gives those checkpoints a persistent destination so we can
//! diagnose stuck syncs after the fact.
//!
//! Design notes:
//! - **Best-effort, never panic.** A logging failure must not break sync —
//!   the file handle is opened lazily and any I/O error is swallowed.
//! - **Single global handle behind a `Mutex`.** Sync emits roughly one line
//!   per ndjson event; lock contention is irrelevant at that rate.
//! - **No rotation.** The file grows unbounded; users can `rm` it. A future
//!   nightly truncate is fine to add when this becomes an actual problem.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use chrono::SecondsFormat;

use super::paths::hq_config_dir;

#[cfg(any(test, feature = "test-support"))]
pub(crate) static LOG_PATH_TEST_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(any(test, feature = "test-support"))]
pub(crate) static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Returns `~/.hq/logs/hq-sync.log`. The directory is created on demand.
///
/// In test builds an override slot is consulted first so tests can redirect
/// the log to an isolated tempdir without mutating `HOME` (which `dirs::home_dir`
/// falls back to via passwd, so HOME-mutation isn't sufficient anyway).
pub fn log_path() -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "test-support"))]
    {
        if let Some(slot) = LOG_PATH_TEST_OVERRIDE.get() {
            if let Ok(guard) = slot.lock() {
                if let Some(p) = guard.clone() {
                    if let Some(parent) = p.parent() {
                        if !parent.exists() {
                            fs::create_dir_all(parent)
                                .map_err(|e| format!("create logs dir: {e}"))?;
                        }
                    }
                    return Ok(p);
                }
            }
        }
    }
    let dir = hq_config_dir()?.join("logs");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {e}"))?;
    }
    Ok(dir.join("hq-sync.log"))
}

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

fn handle() -> &'static Mutex<Option<File>> {
    LOG_FILE.get_or_init(|| Mutex::new(None))
}

#[cfg(any(test, feature = "test-support"))]
fn clear_cached_handle() {
    if let Some(slot) = LOG_FILE.get() {
        let mut handle = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *handle = None;
    }
}

/// Serialized override for the process-global log destination.
///
/// This is deliberately feature-gated: production builds have no mutable log
/// destination seam. Holding the guard also serializes every reset of the
/// cached file handle, including tests in sibling modules.
#[cfg(any(test, feature = "test-support"))]
pub struct LogOverrideGuard {
    previous: Option<PathBuf>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(any(test, feature = "test-support"))]
impl LogOverrideGuard {
    pub fn new(path: PathBuf) -> Self {
        Self::set(Some(path))
    }

    pub fn without_override() -> Self {
        Self::set(None)
    }

    fn set(path: Option<PathBuf>) -> Self {
        let lock = TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slot = LOG_PATH_TEST_OVERRIDE.get_or_init(|| Mutex::new(None));
        let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::mem::replace(&mut *slot, path);
        drop(slot);
        clear_cached_handle();
        Self {
            previous,
            _lock: lock,
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Drop for LogOverrideGuard {
    fn drop(&mut self) {
        let slot = LOG_PATH_TEST_OVERRIDE.get_or_init(|| Mutex::new(None));
        let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = self.previous.take();
        drop(slot);
        clear_cached_handle();
    }
}

fn ensure_open(slot: &mut Option<File>) {
    if slot.is_some() {
        return;
    }
    let path = match log_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
        *slot = Some(file);
    }
}

/// Append a single timestamped line tagged with `tag` to the log file.
///
/// Best-effort: any failure (no home dir, disk full, file vanished) is
/// silently swallowed. The shape is:
///
/// ```text
/// 2026-04-25T13:45:09.123Z [sync] start_sync invoked
/// ```
pub fn log(tag: &str, msg: &str) {
    let line = format!(
        "{} [{}] {}\n",
        chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        tag,
        msg,
    );
    let mutex = handle();
    let mut slot = match mutex.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    ensure_open(&mut slot);
    if let Some(file) = slot.as_mut() {
        let _ = file.write_all(line.as_bytes());
        // Flush each line so a hung sync still leaves a trail. The volume
        // is too low (one line per ndjson event) for fsync overhead to
        // matter.
        let _ = file.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_path_default_under_dot_hq_logs() {
        let _guard = LogOverrideGuard::without_override();

        let path = log_path().unwrap();
        assert!(
            path.ends_with(".hq/logs/hq-sync.log"),
            "default path must live under ~/.hq/logs, got {path:?}"
        );
    }

    #[test]
    fn test_log_appends_timestamped_line() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(path.clone());

        log("sync", "first message");
        log("sync", "second message");

        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("[sync] first message"));
        assert!(contents.contains("[sync] second message"));
        assert!(contents.starts_with("20"));
        assert!(contents.contains("Z [sync]"));
        assert_eq!(contents.matches('\n').count(), 2);
    }

    #[test]
    fn test_log_swallows_errors_when_path_unwritable() {
        // Point the override at a path inside a non-existent parent that
        // lives under a *file* (not a directory) — `create_dir_all` cannot
        // succeed because `/dev/null` is a character device. Best-effort
        // logging must swallow the error, not panic.
        let bad = std::path::PathBuf::from("/dev/null/cannot-create/hq-sync.log");
        let _guard = LogOverrideGuard::new(bad);

        log("sync", "should not panic");
    }
}
