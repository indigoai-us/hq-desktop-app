//! Background warm-up of the npx cache for `@indigoai-us/hq-cloud`.
//!
//! ## Why this exists
//!
//! The sync path spawns
//! `npx -y --package=@indigoai-us/hq-cloud@<ver> hq-sync-runner …` (see
//! `commands::sync`). The *first* invocation after a fresh install — or
//! after bumping `sync::HQ_CLOUD_VERSION` — downloads the package into
//! npx's on-disk cache (`~/.npm/_npx/<hash>/`). That download takes
//! ~3–10s, which would otherwise pad the user's first click of
//! "Sync Now" and feel like the app is broken.
//!
//! By doing the same download in the background at app startup, the
//! cache is warm by the time the user actually triggers a sync. The
//! second and all subsequent syncs are then near-instant (~100ms npx
//! overhead). No-ops if the cache is already warm.
//!
//! ## Why fire-and-forget is safe
//!
//! Prewarm is a pure side-effect with no state to surface. If it
//! succeeds, the next sync is fast. If it fails (offline, npm registry
//! down), the next sync will either reuse whatever is cached or fail
//! with the same network error. Pre-warm failure and sync failure are
//! independent — there's nothing to roll back, retry, or report. We log
//! one stderr line per attempt for offline debugging and drop the
//! `JoinHandle`.
//!
//! ## Why cache materialization is locked
//!
//! `npx` writes a package tree below its shared cache. A launch-time prewarm
//! can otherwise race a foreground Sync Now or watch-daemon start against the
//! same tree, occasionally leaving npm to report an `EACCES` / exit-126-style
//! failure. Every runner launch therefore first calls the same materialization
//! helper below. The helper takes a cross-process advisory lock only while it
//! runs the trivial npx payload, then releases it before the real (possibly
//! long-lived) runner starts. Waiting is bounded, and an OS-released advisory
//! lock cannot remain stale after an app crash.
//!
//! ## Why `std::thread` and not tokio
//!
//! Tauri's `setup` callback runs synchronously on the main thread; we
//! need to return quickly so the tray icon appears. `std::thread::spawn`
//! is the simplest option — matches the existing pattern used for
//! feature-flagged daemon autostart in `main.rs`. No tokio runtime
//! dependency, no async-in-setup plumbing.
//!
//! ## What we spawn
//!
//! `npx -y --package=@indigoai-us/hq-cloud@<ver> -- node -e "process.exit(0)"`.
//! npx must materialise `--package=<pkg>` before running the command,
//! so the cache fills regardless of what we run afterwards. We use a
//! trivial `node` no-op rather than a runner bin so the payload is
//! immune to future `hq-sync-runner` argv changes and always exits 0.
//! Output is dropped; we only care about the side effect of filling
//! the cache.

use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;

use crate::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION};
use crate::paths;

/// Maximum time a foreground sync waits for another HQ process to finish
/// materializing the same npx package. We return a clear local diagnosis after
/// this rather than allowing an unlocked npx race.
const MATERIALIZATION_LOCK_WAIT: Duration = Duration::from_secs(30);
const MATERIALIZATION_LOCK_RETRY: Duration = Duration::from_millis(100);
const MATERIALIZATION_LOCK_TIMEOUT_MESSAGE: &str =
    "HQ Sync is still preparing its npm cache in another window. \
     Wait a moment, then try Sync again.";

/// `LockFileEx` reports lock contention with raw Win32 errors instead of
/// `ErrorKind::WouldBlock`: 32 is `ERROR_SHARING_VIOLATION` and 33 is
/// `ERROR_LOCK_VIOLATION`.
///
/// This is compiled for tests on every platform so the raw-code classification
/// is covered without a real Windows lock. Production callers use it only on
/// Windows through [`is_retryable_materialization_lock_error`].
#[cfg(any(windows, test))]
fn is_windows_lock_contention(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(32 | 33))
}

#[cfg(windows)]
fn is_retryable_materialization_lock_error(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::WouldBlock || is_windows_lock_contention(err)
}

#[cfg(not(windows))]
fn is_retryable_materialization_lock_error(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::WouldBlock
}

fn wait_for_materialization_lock(
    wait: Duration,
    mut try_lock: impl FnMut() -> std::io::Result<()>,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match try_lock() {
            Ok(()) => return Ok(()),
            Err(err) if is_retryable_materialization_lock_error(&err) => {
                if started.elapsed() >= wait {
                    return Err(MATERIALIZATION_LOCK_TIMEOUT_MESSAGE.to_string());
                }
                thread::sleep(MATERIALIZATION_LOCK_RETRY);
            }
            Err(err) => {
                return Err(format!(
                    "HQ Sync could not coordinate npm cache preparation: {err}"
                ));
            }
        }
    }
}

/// Hold the advisory lock only while npx creates/updates its shared package
/// cache. The file intentionally persists: advisory locks are released by the
/// OS on process exit, so a crash cannot leave a stale logical lock behind.
#[derive(Debug)]
struct MaterializationLock {
    file: File,
}

impl Drop for MaterializationLock {
    fn drop(&mut self) {
        // Best effort only. Closing the file immediately after this also
        // releases the advisory lock on every supported platform.
        let _ = self.file.unlock();
    }
}

fn acquire_materialization_lock_in(
    lock_path: &std::path::Path,
    wait: Duration,
) -> Result<MaterializationLock, String> {
    let parent = lock_path.parent().ok_or_else(|| {
        "HQ Sync could not determine where to coordinate the npm cache".to_string()
    })?;
    std::fs::create_dir_all(parent).map_err(|err| {
        format!(
            "HQ Sync cannot prepare its npm cache because {} is not writable: {err}",
            parent.display()
        )
    })?;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .map_err(|err| format!("HQ Sync could not open its npm cache lock: {err}"))?;
    wait_for_materialization_lock(wait, || file.try_lock_exclusive())?;
    Ok(MaterializationLock { file })
}

fn materialization_lock_path() -> Result<std::path::PathBuf, String> {
    Ok(paths::hq_config_dir()?.join("npx-hq-cloud-materialize.lock"))
}

fn npx_materialization_error(code: Option<i32>, stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("eacces") || lower.contains("permission denied") {
        return "HQ Sync cannot update its npm cache because this account cannot write to it. \
                Fix the npm cache permissions, then try Sync again."
            .to_string();
    }
    match code {
        Some(126) => {
            "HQ Sync cannot run the sync engine because the Node/npm installation is not executable. \
             Reinstall Node 20 or newer, then reopen HQ Sync."
                .to_string()
        }
        Some(127) => {
            "HQ Sync cannot start the sync engine because Node.js was not found. \
             Install Node 20 or newer, then reopen HQ Sync."
                .to_string()
        }
        Some(code) => format!(
            "HQ Sync could not prepare its npm cache (npx exited with code {code}). \
             Check your network and npm setup, then try Sync again."
        ),
        None => "HQ Sync could not prepare its npm cache because npx was interrupted. Try Sync again."
            .to_string(),
    }
}

/// Run `body` while holding the shared npx-cache materialization lock.
///
/// Exposed so the runner-target repair in [`crate::runner_target`] mutates the
/// same shared `_npx` tree under the same cross-process advisory lock, instead
/// of racing a concurrent materialization from another HQ window. Callers must
/// not nest: the lock is per-open-file-description, so a nested acquire would
/// block against itself until the bounded wait expires.
pub fn with_materialization_lock<T>(body: impl FnOnce() -> T) -> Result<T, String> {
    let lock_path = materialization_lock_path()?;
    let _lock = acquire_materialization_lock_in(&lock_path, MATERIALIZATION_LOCK_WAIT)?;
    Ok(body())
}

/// Materialize the exact `hq-cloud` npx package under a cross-process lock.
///
/// Foreground sync and the watch daemon call this before launching their real
/// runner, while [`spawn_prewarm`] calls it in the background at startup. The
/// lock guards only the short npx no-op, never the runner itself.
pub fn materialize_hq_cloud_cache() -> Result<(), String> {
    with_materialization_lock(run_materialization_payload)?
}

fn run_materialization_payload() -> Result<(), String> {
    let npx = paths::resolve_bin("npx");
    let package_spec = format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION);
    let path = paths::child_path();
    let output = paths::spawn_command(
        &npx,
        &["-y", &package_spec, "--", "node", "-e", "process.exit(0)"],
    )
    .env("PATH", &path)
    .output()
    .map_err(|err| {
        if err.kind() == ErrorKind::PermissionDenied {
            "HQ Sync cannot run npx because the Node/npm installation is not executable. \
             Reinstall Node 20 or newer, then reopen HQ Sync."
                .to_string()
        } else {
            format!("HQ Sync could not start npx to prepare its cache: {err}")
        }
    })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(npx_materialization_error(
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        ))
    }
}

/// Spawn a detached thread that warms the npx cache for
/// `@indigoai-us/hq-cloud@HQ_CLOUD_VERSION`. Returns immediately; the
/// caller never joins the thread.
///
/// Safe to call repeatedly — if the cache is already warm, npx is a
/// ~100ms no-op. Concurrent invocations serialize only the materialization
/// payload, preventing a shared-cache write race.
pub fn spawn_prewarm() {
    drop(spawn_prewarm_with(materialize_hq_cloud_cache));
}

/// Keep the background scheduling path injectable so tests can prove the
/// caller returns promptly without starting a real npm process.
fn spawn_prewarm_with(
    materialize: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let started = Instant::now();
        match materialize() {
            Ok(()) => {
                eprintln!(
                    "[prewarm] {}@{} warmed in {:.1}s",
                    HQ_CLOUD_PACKAGE,
                    HQ_CLOUD_VERSION,
                    started.elapsed().as_secs_f32(),
                );
            }
            Err(err) => {
                eprintln!(
                    "[prewarm] cache materialization failed after {:.1}s: {} — first sync will diagnose it",
                    started.elapsed().as_secs_f32(),
                    err,
                );
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an npx stand-in that records accidental execution without
    /// reading a package or writing npm cache data.
    #[cfg(unix)]
    fn fake_npx_home() -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let marker = home.path().join("fake-npx-started");
        let fake_npx = bin.join("npx");
        std::fs::write(
            &fake_npx,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake_npx, std::fs::Permissions::from_mode(0o755)).unwrap();
        (home, marker)
    }

    #[test]
    fn test_spawn_prewarm_is_non_blocking_without_launching_npx() {
        let _env = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        #[cfg(unix)]
        let (home, marker) = fake_npx_home();
        #[cfg(unix)]
        let _home = crate::test_support::ScopedEnv::set("HOME", home.path());

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        let worker = spawn_prewarm_with(move || {
            started_tx
                .send(())
                .map_err(|error| format!("test worker could not report start: {error}"))?;
            release_rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|error| format!("test worker was not released: {error}"))?;
            Ok(())
        });
        let elapsed = started.elapsed();
        assert!(
            elapsed.as_millis() < 500,
            "spawn_prewarm blocked for {elapsed:?} — must return immediately",
        );
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("background materializer did not start");
        release_tx.send(()).expect("background worker exited early");
        worker.join().expect("background worker panicked");

        #[cfg(unix)]
        assert!(
            !marker.exists(),
            "the prewarm smoke test launched npx; tests must not start a child process"
        );
    }

    #[test]
    fn materialization_lock_wait_is_bounded_and_released() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("cache.lock");
        let first = acquire_materialization_lock_in(&lock_path, Duration::ZERO).unwrap();
        let err = acquire_materialization_lock_in(&lock_path, Duration::ZERO).unwrap_err();
        assert!(err.contains("still preparing"));
        drop(first);
        assert!(acquire_materialization_lock_in(&lock_path, Duration::ZERO).is_ok());
    }

    #[test]
    fn windows_lock_contention_codes_are_classified_without_retrying_elsewhere() {
        let sharing_violation = std::io::Error::from_raw_os_error(32);
        let lock_violation = std::io::Error::from_raw_os_error(33);
        let permission_denied = std::io::Error::from(ErrorKind::PermissionDenied);

        assert!(is_windows_lock_contention(&sharing_violation));
        assert!(is_windows_lock_contention(&lock_violation));
        assert!(!is_windows_lock_contention(&permission_denied));

        #[cfg(windows)]
        {
            assert!(is_retryable_materialization_lock_error(&sharing_violation));
            assert!(is_retryable_materialization_lock_error(&lock_violation));
        }

        #[cfg(not(windows))]
        {
            assert!(!is_retryable_materialization_lock_error(&sharing_violation));
            assert!(!is_retryable_materialization_lock_error(&lock_violation));
        }
    }

    #[test]
    fn permanently_contended_lock_returns_the_timeout_message() {
        let mut attempts = 0;
        let err = wait_for_materialization_lock(Duration::ZERO, || {
            attempts += 1;
            Err(std::io::Error::new(
                ErrorKind::WouldBlock,
                "another HQ window holds the lock",
            ))
        })
        .unwrap_err();

        assert_eq!(err, MATERIALIZATION_LOCK_TIMEOUT_MESSAGE);
        assert_eq!(attempts, 1, "the retry budget must terminate the loop");
    }

    #[test]
    fn materialization_error_keeps_permission_and_exit_diagnoses_distinct() {
        let permission = npx_materialization_error(Some(126), "npm error code EACCES");
        assert!(permission.contains("cannot write"));

        let not_executable = npx_materialization_error(Some(126), "");
        assert!(not_executable.contains("not executable"));
    }
}
