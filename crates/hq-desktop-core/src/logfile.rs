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
//! - **Size-based rotation.** The active log rotates at
//!   [`DEFAULT_MAX_LOG_BYTES`] and [`KEEP_GENERATIONS`] older generations are
//!   retained, bounding the whole set. Rotation is best-effort like everything
//!   else here: if a rename fails, logging keeps appending rather than failing.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rotate the active log once it reaches this size.
///
/// Three generations at 32 MiB caps the whole log set at ~128 MiB, which is
/// roughly five weeks of history at observed sync volume. Before rotation
/// existed this file was found at 420 MiB after ~3 months, which is what
/// motivated the ceiling.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;

/// Rotated generations kept beside the active log: `hq-sync.log.1` … `.3`.
pub const KEEP_GENERATIONS: usize = 3;

use chrono::SecondsFormat;

use super::paths::hq_config_dir;

#[cfg(any(test, feature = "test-support"))]
pub(crate) static LOG_PATH_TEST_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(any(test, feature = "test-support"))]
pub(crate) static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(any(test, feature = "test-support"))]
pub(crate) static MAX_BYTES_TEST_OVERRIDE: OnceLock<Mutex<Option<u64>>> = OnceLock::new();

/// Rotation threshold, honouring the test-only override when one is installed.
fn max_log_bytes() -> u64 {
    #[cfg(any(test, feature = "test-support"))]
    {
        if let Some(slot) = MAX_BYTES_TEST_OVERRIDE.get() {
            if let Ok(guard) = slot.lock() {
                if let Some(bytes) = *guard {
                    return bytes;
                }
            }
        }
    }
    DEFAULT_MAX_LOG_BYTES
}

/// `hq-sync.log` + 2 → `hq-sync.log.2`.
fn generation_path(path: &Path, n: usize) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{n}"));
    path.with_file_name(name)
}

/// Shift the generation chain down one slot and move the active log to `.1`.
///
/// Entirely best-effort: every step ignores its error. A rotation that cannot
/// complete (a rename target occupied by a directory, a read-only parent) must
/// leave logging working rather than take the sync pipeline down with it.
fn rotate(path: &Path) {
    // Drop the oldest generation so the chain stays bounded.
    let _ = fs::remove_file(generation_path(path, KEEP_GENERATIONS));
    for n in (1..KEEP_GENERATIONS).rev() {
        let from = generation_path(path, n);
        if from.exists() {
            let _ = fs::rename(&from, generation_path(path, n + 1));
        }
    }
    let _ = fs::rename(path, generation_path(path, 1));
}

/// The open log plus the bookkeeping rotation needs.
///
/// `bytes` is seeded from the file's real length on open, so a log left
/// oversized by a previous run rotates on the first write of the next one.
struct ActiveLog {
    file: File,
    bytes: u64,
    /// Set when a rotation ran but the file is still over the ceiling — the
    /// rename is blocked, so stop retrying it on every single line.
    rotation_disabled: bool,
}

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

static LOG_FILE: OnceLock<Mutex<Option<ActiveLog>>> = OnceLock::new();

fn handle() -> &'static Mutex<Option<ActiveLog>> {
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
    previous_max: Option<u64>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(any(test, feature = "test-support"))]
impl LogOverrideGuard {
    pub fn new(path: PathBuf) -> Self {
        Self::set(Some(path), None)
    }

    pub fn without_override() -> Self {
        Self::set(None, None)
    }

    /// Redirect the log *and* lower the rotation ceiling, so rotation can be
    /// exercised without writing tens of megabytes.
    pub fn with_max_bytes(path: PathBuf, max_bytes: u64) -> Self {
        Self::set(Some(path), Some(max_bytes))
    }

    fn set(path: Option<PathBuf>, max_bytes: Option<u64>) -> Self {
        let lock = TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slot = LOG_PATH_TEST_OVERRIDE.get_or_init(|| Mutex::new(None));
        let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::mem::replace(&mut *slot, path);
        drop(slot);

        let max_slot = MAX_BYTES_TEST_OVERRIDE.get_or_init(|| Mutex::new(None));
        let mut max_slot = max_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_max = std::mem::replace(&mut *max_slot, max_bytes);
        drop(max_slot);

        clear_cached_handle();
        Self {
            previous,
            previous_max,
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

        let max_slot = MAX_BYTES_TEST_OVERRIDE.get_or_init(|| Mutex::new(None));
        let mut max_slot = max_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *max_slot = self.previous_max.take();
        drop(max_slot);

        clear_cached_handle();
    }
}

fn ensure_open(slot: &mut Option<ActiveLog>) {
    if slot.is_some() {
        return;
    }
    let path = match log_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
        let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        *slot = Some(ActiveLog {
            file,
            bytes,
            rotation_disabled: false,
        });
    }
}

/// Rotate when the active log has reached the ceiling, then reopen.
///
/// Checked before the write rather than after, so an already-oversized log
/// inherited from a previous run is rotated on the very first line instead of
/// growing by one more.
fn rotate_if_needed(slot: &mut Option<ActiveLog>) {
    let max = max_log_bytes();
    match slot.as_ref() {
        Some(active) if !active.rotation_disabled && active.bytes >= max => {}
        _ => return,
    }
    let path = match log_path() {
        Ok(p) => p,
        Err(_) => return,
    };

    rotate(&path);
    *slot = None;
    ensure_open(slot);

    if let Some(reopened) = slot.as_mut() {
        // Still oversized means the rename never happened. Keep appending, but
        // stop paying for a doomed rotation attempt on every line.
        if reopened.bytes >= max {
            reopened.rotation_disabled = true;
        }
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
    rotate_if_needed(&mut slot);
    if let Some(active) = slot.as_mut() {
        if active.file.write_all(line.as_bytes()).is_ok() {
            active.bytes += line.len() as u64;
        }
        // Flush each line so a hung sync still leaves a trail. The volume
        // is too low (one line per ndjson event) for fsync overhead to
        // matter.
        let _ = active.file.flush();
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

    // ---- rotation -----------------------------------------------------------
    //
    // Production keeps 32 MiB × 3 generations. These tests lower the threshold
    // to a few hundred bytes via `LogOverrideGuard::with_max_bytes` so the suite
    // never writes megabytes to disk — the rename-chain logic under test is
    // size-independent.

    fn gen_path(dir: &Path, n: usize) -> PathBuf {
        dir.join(format!("hq-sync.log.{n}"))
    }

    /// Emit `count` padded lines so the byte counter crosses a small threshold
    /// predictably.
    fn write_lines(count: usize) {
        for i in 0..count {
            log("sync", &format!("line {i} padded with filler to add bytes"));
        }
    }

    /// Concatenate the active log and every surviving generation.
    fn all_generations(dir: &Path) -> String {
        let mut out = fs::read_to_string(dir.join("hq-sync.log")).unwrap_or_default();
        for n in 1..=KEEP_GENERATIONS {
            let p = gen_path(dir, n);
            if p.exists() {
                out.push_str(&fs::read_to_string(&p).unwrap_or_default());
            }
        }
        out
    }

    #[test]
    fn test_default_ceiling_is_32mib_times_three_generations() {
        assert_eq!(DEFAULT_MAX_LOG_BYTES, 32 * 1024 * 1024);
        assert_eq!(KEEP_GENERATIONS, 3);
    }

    #[test]
    fn test_no_rotation_below_threshold() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _guard = LogOverrideGuard::with_max_bytes(tmp.path().join("hq-sync.log"), 1_000_000);

        write_lines(5);

        assert!(tmp.path().join("hq-sync.log").exists());
        assert!(
            !gen_path(tmp.path(), 1).exists(),
            "must not rotate before the threshold is crossed"
        );
    }

    #[test]
    fn test_crossing_threshold_rotates_to_generation_one() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let active = tmp.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::with_max_bytes(active.clone(), 200);

        write_lines(20);

        assert!(active.exists(), "a fresh active log must be reopened");
        assert!(
            gen_path(tmp.path(), 1).exists(),
            "the pre-rotation log must be preserved as .1"
        );
        assert!(
            fs::metadata(&active).unwrap().len() < 800,
            "the active log must start over rather than keep growing"
        );
    }

    #[test]
    fn test_rotated_content_is_preserved_not_discarded() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _guard = LogOverrideGuard::with_max_bytes(tmp.path().join("hq-sync.log"), 200);

        log("sync", "EARLY-MARKER-must-survive-rotation");
        // Just enough to cross the threshold once. Rotating many more times
        // would legitimately age the early marker out past the generation cap,
        // which is retention working, not content being lost.
        write_lines(3);
        log("sync", "LATE-MARKER-after-rotation");

        // The early line moved into a rotated generation, the late one is in
        // the active file. A single rotation must lose neither.
        let all = all_generations(tmp.path());
        assert!(all.contains("EARLY-MARKER-must-survive-rotation"));
        assert!(all.contains("LATE-MARKER-after-rotation"));
    }

    #[test]
    fn test_generations_cascade_and_are_capped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _guard = LogOverrideGuard::with_max_bytes(tmp.path().join("hq-sync.log"), 200);

        // Enough churn to force several rotations.
        write_lines(200);

        for n in 1..=KEEP_GENERATIONS {
            assert!(
                gen_path(tmp.path(), n).exists(),
                "generation .{n} should exist after repeated rotation"
            );
        }
        assert!(
            !gen_path(tmp.path(), KEEP_GENERATIONS + 1).exists(),
            "retention must cap at {KEEP_GENERATIONS} generations — an unbounded \
             chain is the bug being fixed"
        );
    }

    #[test]
    fn test_oldest_generation_is_dropped_on_overflow() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Seed a distinctive oldest generation, then rotate past the cap.
        fs::write(
            gen_path(tmp.path(), KEEP_GENERATIONS),
            "OLDEST-SHOULD-BE-DROPPED\n",
        )
        .unwrap();
        let _guard = LogOverrideGuard::with_max_bytes(tmp.path().join("hq-sync.log"), 200);

        write_lines(200);

        assert!(
            !all_generations(tmp.path()).contains("OLDEST-SHOULD-BE-DROPPED"),
            "the oldest generation must be discarded, not retained forever"
        );
    }

    #[test]
    fn test_preexisting_oversized_log_rotates_on_first_write() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let active = tmp.path().join("hq-sync.log");
        // The real-world case: the app starts and finds a log that already blew
        // past the ceiling during a previous run.
        fs::write(&active, "x".repeat(5_000)).unwrap();
        let _guard = LogOverrideGuard::with_max_bytes(active.clone(), 200);

        log("sync", "first line of the new run");

        assert!(
            gen_path(tmp.path(), 1).exists(),
            "an already-oversized log must rotate instead of growing further"
        );
        let contents = fs::read_to_string(&active).unwrap();
        assert!(contents.contains("first line of the new run"));
        assert!(
            contents.len() < 5_000,
            "the new active log must not inherit the old contents"
        );
    }

    #[test]
    fn test_rotation_never_panics_when_generation_is_unwritable() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Occupy *every* generation slot with a non-empty directory. Renaming
        // onto a non-empty directory fails, so no step of the chain can
        // succeed — including the final `hq-sync.log` → `.1` move. Logging is
        // best-effort: a wholly failed rotation must degrade to "keep
        // appending", never crash the sync pipeline.
        for n in 1..=KEEP_GENERATIONS {
            let blocked = gen_path(tmp.path(), n);
            fs::create_dir_all(&blocked).unwrap();
            fs::write(blocked.join("occupant"), "blocks the rename").unwrap();
        }
        let active = tmp.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::with_max_bytes(active.clone(), 200);

        write_lines(50);

        // Still alive, still recording — the log grew past the ceiling because
        // rotation could not run, which beats losing the diagnostics entirely.
        assert!(active.exists());
        let contents = fs::read_to_string(&active).unwrap();
        assert!(contents.contains("line 49"), "logging must keep working");
    }
}
