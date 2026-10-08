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
//! The startup task still has no user-facing result or join handle. Its
//! completion state lets an opted-in automatic Core update wait before it
//! attempts the same cache materialization. Once prewarm finishes, success
//! lets the update continue and failure leaves the next materialization to
//! produce its normal diagnosis. The task logs one stderr line per attempt.
//!
//! ## Why cache materialization is locked
//!
//! `npx` writes a package tree below its shared cache. A launch-time prewarm
//! can otherwise race a foreground Sync Now or watch-daemon start against the
//! same tree, occasionally leaving npm to report an `EACCES` / exit-126-style
//! failure. Every runner launch therefore first calls the same materialization
//! helper below. That lock covers only the npx cache write. The process
//! supervisor then holds a second shared lease for the runner's lifetime;
//! startup refresh takes that lease exclusively and skips while a runner is
//! active. Both locks are released by the OS after a crash.
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
use std::io::{ErrorKind, Read};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use tokio::sync::watch;

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
const REGISTRY_METADATA_TIMEOUT: Duration = Duration::from_secs(15);

/// Maximum time an automatic Core update waits for this process's startup
/// prewarm. On expiry the update is deferred to the next automatic cycle.
pub const AUTOMATIC_UPDATE_PREWARM_WAIT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrewarmWaitOutcome {
    NotRunning,
    Completed,
    TimedOut,
}

/// Broadcasts whether one or more startup prewarm tasks are still active.
/// Automatic update waiters do not acquire the materialization lock until this
/// reports completion, so prewarm never waits on an update that is waiting for
/// prewarm.
#[derive(Clone)]
pub struct PrewarmCoordinator {
    in_flight: watch::Sender<usize>,
}

impl Default for PrewarmCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl PrewarmCoordinator {
    pub fn new() -> Self {
        let (in_flight, _receiver) = watch::channel(0);
        Self { in_flight }
    }

    pub fn prewarm_started(&self) {
        self.in_flight
            .send_modify(|count| *count = count.saturating_add(1));
    }

    pub fn prewarm_finished(&self) {
        self.in_flight
            .send_modify(|count| *count = count.saturating_sub(1));
    }

    pub async fn wait_for_active(&self, wait: Duration) -> PrewarmWaitOutcome {
        let mut receiver = self.in_flight.subscribe();
        if *receiver.borrow() == 0 {
            return PrewarmWaitOutcome::NotRunning;
        }

        let completed = tokio::time::timeout(wait, async move {
            while *receiver.borrow() > 0 {
                if receiver.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;

        match completed {
            Ok(()) => PrewarmWaitOutcome::Completed,
            Err(_) => PrewarmWaitOutcome::TimedOut,
        }
    }
}

static PREWARM_COORDINATOR: OnceLock<PrewarmCoordinator> = OnceLock::new();
static AUTOMATIC_UPDATE_DEFERRALS: AtomicU64 = AtomicU64::new(0);
static STARTUP_RUNNER_REFRESH_STARTED: AtomicBool = AtomicBool::new(false);

fn claim_startup_runner_refresh(started: &AtomicBool) -> bool {
    !started.swap(true, Ordering::AcqRel)
}

fn process_prewarm_coordinator() -> &'static PrewarmCoordinator {
    PREWARM_COORDINATOR.get_or_init(PrewarmCoordinator::new)
}

pub async fn wait_for_active_prewarm(wait: Duration) -> PrewarmWaitOutcome {
    process_prewarm_coordinator().wait_for_active(wait).await
}

pub fn record_automatic_update_deferral() -> u64 {
    AUTOMATIC_UPDATE_DEFERRALS.fetch_add(1, Ordering::Relaxed) + 1
}

pub fn automatic_update_deferral_count() -> u64 {
    AUTOMATIC_UPDATE_DEFERRALS.load(Ordering::Relaxed)
}

struct PrewarmCompletionGuard(PrewarmCoordinator);

impl Drop for PrewarmCompletionGuard {
    fn drop(&mut self) {
        self.0.prewarm_finished();
    }
}

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

fn open_materialization_lock_file() -> Result<(File, std::path::PathBuf), String> {
    let lock_path = materialization_lock_path()?;
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
        .open(&lock_path)
        .map_err(|err| format!("HQ Sync could not open its npm cache lock: {err}"))?;
    Ok((file, lock_path))
}

#[derive(Debug)]
pub struct RunnerCacheUseLock {
    file: File,
}

impl Drop for RunnerCacheUseLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn runner_cache_use_lock_path() -> Result<std::path::PathBuf, String> {
    Ok(paths::hq_config_dir()?.join("npx-hq-cloud-runner-use.lock"))
}

/// Keep the shared cache stable while an npx-launched runner is using it.
/// Startup refresh takes the exclusive side and skips when this lease is held.
pub fn acquire_runner_cache_use_lock() -> Result<RunnerCacheUseLock, String> {
    acquire_runner_cache_use_lock_in(&runner_cache_use_lock_path()?, MATERIALIZATION_LOCK_WAIT)
}

fn try_acquire_runner_cache_refresh_lock() -> Result<Option<RunnerCacheUseLock>, String> {
    try_acquire_runner_cache_refresh_lock_in(&runner_cache_use_lock_path()?)
}

fn acquire_runner_cache_use_lock_in(
    lock_path: &std::path::Path,
    wait: Duration,
) -> Result<RunnerCacheUseLock, String> {
    let file = open_lock_file_at(lock_path, "runner-cache use")?;
    wait_for_materialization_lock(wait, || FileExt::try_lock_shared(&file))?;
    Ok(RunnerCacheUseLock { file })
}

fn try_acquire_runner_cache_refresh_lock_in(
    lock_path: &std::path::Path,
) -> Result<Option<RunnerCacheUseLock>, String> {
    let file = open_lock_file_at(lock_path, "runner-cache use")?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(RunnerCacheUseLock { file })),
        Err(err) if is_retryable_materialization_lock_error(&err) => Ok(None),
        Err(err) => Err(format!(
            "HQ Sync could not coordinate runner-cache use: {err}"
        )),
    }
}

fn try_acquire_materialization_lock() -> Result<Option<MaterializationLock>, String> {
    let (file, _) = open_materialization_lock_file()?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(MaterializationLock { file })),
        Err(err) if is_retryable_materialization_lock_error(&err) => Ok(None),
        Err(err) => Err(format!(
            "HQ Sync could not coordinate npm cache preparation: {err}"
        )),
    }
}

fn open_lock_file_at(lock_path: &std::path::Path, purpose: &str) -> Result<File, String> {
    let parent = lock_path
        .parent()
        .ok_or_else(|| format!("HQ Sync could not determine where to coordinate {purpose}"))?;
    std::fs::create_dir_all(parent).map_err(|err| {
        format!(
            "HQ Sync cannot coordinate {purpose} because {} is not writable: {err}",
            parent.display()
        )
    })?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .map_err(|err| format!("HQ Sync could not open its {purpose} lock: {err}"))
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

/// Refresh the exact cached runner once at app startup so a newer patch in
/// the same requested range reaches existing desktops without a pin bump. The
/// old entry remains available until npm has materialized its replacement.
pub fn refresh_hq_cloud_cache_at_startup() -> Result<(), String> {
    let Some(npx_cache_dir) = crate::runner_target::npx_cache_dir() else {
        return materialize_hq_cloud_cache();
    };
    let package_spec = crate::runner_target::pinned_package_spec();
    let entry = npx_cache_dir.join(crate::runner_target::npx_cache_entry_hash(&package_spec));
    if !entry.exists() {
        return with_materialization_lock(|| {
            recover_refresh_backup(&entry)?;
            if entry.exists() {
                return Ok(());
            }
            run_materialization_payload()
        })?;
    }

    let installed = match installed_hq_cloud_version(&entry) {
        Ok(version) => version,
        Err(error) => {
            eprintln!("[prewarm] cannot read cached hq-cloud version; keeping cache: {error}");
            return Ok(());
        }
    };
    let latest = match registry_max_satisfying_version() {
        Ok(version) => version,
        Err(error) => {
            eprintln!("[prewarm] registry version check failed; keeping cached runner: {error}");
            return Ok(());
        }
    };
    if latest <= installed {
        return Ok(());
    }

    // Another desktop process may be running this package tree. A process-level
    // shared lock covers runners started by current releases; the process-table
    // check also protects a runner left by an older release that predates it.
    if runner_process_uses_entry(&entry) {
        eprintln!("[prewarm] cached runner is active; skipping this launch's refresh");
        return Ok(());
    }
    let Some(_runner_use_lock) = try_acquire_runner_cache_refresh_lock()? else {
        eprintln!("[prewarm] npm cache is in use; skipping this launch's refresh");
        return Ok(());
    };
    let Some(_materialization_lock) = try_acquire_materialization_lock()? else {
        eprintln!("[prewarm] npm cache materialization is active; skipping this launch's refresh");
        return Ok(());
    };
    recover_refresh_backup(&entry)?;
    let _ = maybe_refresh_cache_entry(
        &entry,
        Ok(latest),
        runner_process_uses_entry(&entry),
        || run_materialization_payload_with_preference(true),
        run_materialization_payload,
    )?;
    Ok(())
}

fn maybe_refresh_cache_entry(
    entry: &std::path::Path,
    latest_result: Result<semver::Version, String>,
    runner_is_active: bool,
    refresh: impl FnOnce() -> Result<(), String>,
    fallback: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let latest = match latest_result {
        Ok(version) => version,
        Err(error) => {
            eprintln!("[prewarm] registry version check failed; keeping cached runner: {error}");
            return Ok(false);
        }
    };
    let installed = match installed_hq_cloud_version(entry) {
        Ok(version) => version,
        Err(error) => {
            eprintln!("[prewarm] cannot read cached hq-cloud version; keeping cache: {error}");
            return Ok(false);
        }
    };
    if latest <= installed || runner_is_active {
        return Ok(false);
    }
    refresh_cache_entry(entry, refresh, fallback)?;
    Ok(true)
}

fn installed_hq_cloud_version(entry: &std::path::Path) -> Result<semver::Version, String> {
    let manifest = entry
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cloud")
        .join("package.json");
    let contents = std::fs::read_to_string(&manifest)
        .map_err(|err| format!("could not read cached package manifest: {err}"))?;
    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|err| format!("could not parse cached package manifest: {err}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "cached package manifest has no version string".to_string())?;
    semver::Version::parse(version)
        .map_err(|err| format!("cached package version is invalid: {err}"))
}

fn registry_max_satisfying_version() -> Result<semver::Version, String> {
    let spec = format!("{}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION);
    let mut child = Command::new(paths::resolve_bin("npm"))
        .args(["view", &spec, "version", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start npm metadata request: {err}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < REGISTRY_METADATA_TIMEOUT => {
                thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("npm metadata request exceeded the 15 second timeout".to_string());
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("could not wait for npm metadata request: {err}"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "npm metadata stdout reader failed".to_string())?
        .map_err(|err| format!("could not read npm metadata response: {err}"))?;
    let _stderr = stderr_reader
        .join()
        .map_err(|_| "npm metadata stderr reader failed".to_string())?
        .map_err(|err| format!("could not read npm metadata error: {err}"))?;
    if !status.success() {
        return Err(format!(
            "npm metadata request exited with code {:?}",
            status.code()
        ));
    }
    max_satisfying_version_from_metadata(&stdout)
}

fn max_satisfying_version_from_metadata(stdout: &[u8]) -> Result<semver::Version, String> {
    let value: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|err| format!("could not parse npm metadata response: {err}"))?;
    let versions: Vec<&str> = match &value {
        serde_json::Value::String(version) => vec![version.as_str()],
        serde_json::Value::Array(versions) => versions.iter().filter_map(|v| v.as_str()).collect(),
        _ => Vec::new(),
    };
    let range = semver::VersionReq::parse(HQ_CLOUD_VERSION)
        .map_err(|err| format!("invalid HQ cloud package range: {err}"))?;
    versions
        .into_iter()
        .filter_map(|version| semver::Version::parse(version).ok())
        .filter(|version| range.matches(version))
        .max()
        .ok_or_else(|| "npm metadata response contained no matching versions".to_string())
}

#[cfg(unix)]
fn runner_process_uses_entry(entry: &std::path::Path) -> bool {
    let entry = match entry.canonicalize() {
        Ok(entry) => entry,
        Err(_) => return true,
    };
    let entry = entry.to_string_lossy();
    let output = match Command::new("/bin/ps")
        .args(["-eww", "-o", "args="])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return true,
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|args| args.contains(entry.as_ref()) && args.contains("hq-cloud"))
}

#[cfg(windows)]
fn runner_process_uses_entry(_entry: &std::path::Path) -> bool {
    false
}

fn refresh_cache_entry(
    entry: &std::path::Path,
    refresh: impl FnOnce() -> Result<(), String>,
    fallback: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let parent = entry
        .parent()
        .ok_or_else(|| "HQ Sync cannot locate its npm cache entry".to_string())?;
    let name = entry
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "HQ Sync cannot name its npm cache entry".to_string())?;
    let mut suffix = 0u32;
    let backup = loop {
        let candidate = parent.join(format!(
            ".{name}.hq-refresh-{}-{suffix}",
            std::process::id()
        ));
        if !candidate.exists() {
            break candidate;
        }
        suffix = suffix.saturating_add(1);
    };
    std::fs::rename(entry, &backup).map_err(|err| {
        format!("HQ Sync could not preserve its cached runner before refresh: {err}")
    })?;

    match refresh() {
        Ok(()) if entry.exists() => {
            remove_cache_path(&backup)?;
            Ok(())
        }
        Ok(()) => {
            std::fs::rename(&backup, entry).map_err(|err| {
                format!("HQ Sync could not restore its cached runner after an empty refresh: {err}")
            })?;
            fallback().map_err(|fallback_error| {
                format!("HQ Sync's online runner refresh produced no cache entry and the cached runner could not be used: {fallback_error}")
            })
        }
        Err(refresh_error) => {
            if entry.exists() {
                remove_cache_path(entry)?;
            }
            std::fs::rename(&backup, entry).map_err(|err| {
                format!("HQ Sync could not restore its cached runner after refresh failed: {err}")
            })?;
            match fallback() {
                Ok(()) => {
                    eprintln!("[prewarm] online runner refresh failed; kept the cached runner: {refresh_error}");
                    Ok(())
                }
                Err(fallback_error) => Err(format!(
                    "HQ Sync could not refresh the runner ({refresh_error}) or use the cached runner ({fallback_error})"
                )),
            }
        }
    }
}

fn recover_refresh_backup(entry: &std::path::Path) -> Result<(), String> {
    let parent = entry
        .parent()
        .ok_or_else(|| "HQ Sync cannot locate its npm cache entry".to_string())?;
    let name = entry
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "HQ Sync cannot name its npm cache entry".to_string())?;
    let prefix = format!(".{name}.hq-refresh-");
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("HQ Sync could not inspect its npm cache: {error}"));
        }
    };
    let mut backups = entries
        .flatten()
        .filter(|item| item.file_name().to_string_lossy().starts_with(&prefix))
        .map(|item| item.path())
        .collect::<Vec<_>>();
    backups.sort();
    if entry.exists() {
        for backup in backups {
            remove_cache_path(&backup)?;
        }
    } else if let Some(backup) = backups.first() {
        std::fs::rename(backup, entry).map_err(|err| {
            format!(
                "HQ Sync could not recover its cached runner after an interrupted refresh: {err}"
            )
        })?;
        for backup in backups.iter().skip(1) {
            remove_cache_path(backup)?;
        }
    }
    Ok(())
}

fn remove_cache_path(path: &std::path::Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|err| format!("HQ Sync could not inspect its npm cache entry: {err}"))?;
    if metadata.file_type().is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|err| format!("HQ Sync could not remove an obsolete npm cache entry: {err}"))
}

fn run_materialization_payload() -> Result<(), String> {
    run_materialization_payload_with_preference(false)
}

fn run_materialization_payload_with_preference(prefer_online: bool) -> Result<(), String> {
    let npx = paths::resolve_bin("npx");
    let path = paths::child_path();
    let args = materialization_args(prefer_online);
    let output = paths::spawn_command(&npx, &args.iter().map(String::as_str).collect::<Vec<_>>())
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

fn materialization_args(prefer_online: bool) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        "--".to_string(),
        "node".to_string(),
        "-e".to_string(),
        "process.exit(0)".to_string(),
    ];
    if prefer_online {
        args.insert(0, "--prefer-online".to_string());
    }
    args
}

/// Spawn a detached thread that warms the npx cache for
/// `@indigoai-us/hq-cloud@HQ_CLOUD_VERSION`. Returns immediately; the
/// caller never joins the thread.
///
/// Safe to call repeatedly — if the cache is already warm, npx is a
/// ~100ms no-op. Concurrent invocations serialize only the materialization
/// payload, preventing a shared-cache write race.
fn spawn_prewarm_body_with(
    coordinator: PrewarmCoordinator,
    body: impl FnOnce() + Send + 'static,
) -> thread::JoinHandle<()> {
    spawn_prewarm_with_spawner(coordinator, body, |task| thread::spawn(task))
}

fn spawn_prewarm_with_spawner(
    coordinator: PrewarmCoordinator,
    body: impl FnOnce() + Send + 'static,
    spawn_thread: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> thread::JoinHandle<()>,
) -> thread::JoinHandle<()> {
    coordinator.prewarm_started();
    spawn_thread(Box::new(move || {
        let _completion = PrewarmCompletionGuard(coordinator);
        body();
    }))
}

fn spawn_prewarm_with(
    coordinator: PrewarmCoordinator,
    materialize: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> thread::JoinHandle<()> {
    spawn_prewarm_body_with(coordinator, move || {
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

pub fn spawn_prewarm() {
    if !claim_startup_runner_refresh(&STARTUP_RUNNER_REFRESH_STARTED) {
        return;
    }
    let coordinator = process_prewarm_coordinator().clone();
    drop(spawn_prewarm_with(
        coordinator,
        refresh_hq_cloud_cache_at_startup,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future as _;
    use std::sync::mpsc;

    #[test]
    fn startup_refresh_is_claimed_once_per_process_launch() {
        let started = AtomicBool::new(false);
        assert!(claim_startup_runner_refresh(&started));
        assert!(!claim_startup_runner_refresh(&started));
    }

    #[test]
    fn startup_refresh_recovery_is_a_noop_before_the_npx_cache_exists() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("not-created-yet").join("target-hash");
        recover_refresh_backup(&entry).unwrap();
        assert!(!entry.parent().unwrap().exists());
    }

    #[test]
    fn startup_refresh_requests_latest_in_the_existing_range() {
        let args = materialization_args(true);
        assert!(args.iter().any(|arg| arg == "--prefer-online"));
        assert!(args
            .iter()
            .any(|arg| { arg == &format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION) }));
    }

    fn write_cached_hq_cloud(entry: &std::path::Path, version: &str) {
        let package = entry
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cloud");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            serde_json::json!({"name": "@indigoai-us/hq-cloud", "version": version}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn startup_refresh_does_not_rename_or_materialize_when_cache_is_registry_max() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir_all(&entry).unwrap();
        write_cached_hq_cloud(&entry, "6.18.60");
        let mut refresh_calls = 0;

        let refreshed = maybe_refresh_cache_entry(
            &entry,
            Ok(semver::Version::parse("6.18.60").unwrap()),
            false,
            || {
                refresh_calls += 1;
                Ok(())
            },
            || Ok(()),
        )
        .unwrap();

        assert!(!refreshed);
        assert_eq!(refresh_calls, 0);
        assert_eq!(
            installed_hq_cloud_version(&entry).unwrap().to_string(),
            "6.18.60"
        );
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

    #[test]
    fn startup_refresh_metadata_failure_keeps_cache_without_rename() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir_all(&entry).unwrap();
        write_cached_hq_cloud(&entry, "6.18.59");
        let mut refresh_calls = 0;

        let refreshed = maybe_refresh_cache_entry(
            &entry,
            Err("registry unavailable".to_string()),
            false,
            || {
                refresh_calls += 1;
                Ok(())
            },
            || Ok(()),
        )
        .unwrap();

        assert!(!refreshed);
        assert_eq!(refresh_calls, 0);
        assert_eq!(
            installed_hq_cloud_version(&entry).unwrap().to_string(),
            "6.18.59"
        );
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

    #[test]
    fn startup_refresh_skips_when_runner_is_using_the_cache_entry() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir_all(&entry).unwrap();
        write_cached_hq_cloud(&entry, "6.18.59");
        let mut refresh_calls = 0;

        let refreshed = maybe_refresh_cache_entry(
            &entry,
            Ok(semver::Version::parse("6.18.60").unwrap()),
            true,
            || {
                refresh_calls += 1;
                Ok(())
            },
            || Ok(()),
        )
        .unwrap();

        assert!(!refreshed);
        assert_eq!(refresh_calls, 0);
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

    #[test]
    fn runner_use_lock_makes_startup_refresh_skip_without_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp.path().join("runner-use.lock");
        let _runner = acquire_runner_cache_use_lock_in(&lock_path, Duration::ZERO).unwrap();

        assert!(try_acquire_runner_cache_refresh_lock_in(&lock_path)
            .unwrap()
            .is_none());
    }

    #[test]
    fn registry_metadata_uses_the_highest_version_inside_the_pinned_range() {
        let latest =
            max_satisfying_version_from_metadata(br#"["6.18.59","6.19.0","6.18.61"]"#).unwrap();

        assert_eq!(latest, semver::Version::parse("6.18.61").unwrap());
    }

    #[test]
    fn newer_in_range_runner_replaces_the_cached_older_runner_at_startup() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir(&entry).unwrap();
        std::fs::write(entry.join("version"), "old").unwrap();

        refresh_cache_entry(
            &entry,
            || {
                std::fs::create_dir(&entry).unwrap();
                std::fs::write(entry.join("version"), "new").unwrap();
                Ok(())
            },
            || panic!("successful refresh must not use the fallback"),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(entry.join("version")).unwrap(),
            "new"
        );
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

    #[test]
    fn startup_refresh_uses_cached_runner_when_online_command_produces_no_entry() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir(&entry).unwrap();
        std::fs::write(entry.join("version"), "cached").unwrap();

        refresh_cache_entry(
            &entry,
            || Ok(()),
            || {
                assert_eq!(
                    std::fs::read_to_string(entry.join("version")).unwrap(),
                    "cached"
                );
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(entry.join("version")).unwrap(),
            "cached"
        );
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

    #[test]
    fn startup_refresh_restores_cached_runner_when_registry_refresh_fails() {
        let cache = tempfile::tempdir().unwrap();
        let entry = cache.path().join("target-hash");
        std::fs::create_dir(&entry).unwrap();
        std::fs::write(entry.join("version"), "cached").unwrap();

        refresh_cache_entry(
            &entry,
            || {
                std::fs::create_dir(&entry).unwrap();
                std::fs::write(entry.join("partial"), "incomplete").unwrap();
                Err("registry offline".to_string())
            },
            || {
                assert_eq!(
                    std::fs::read_to_string(entry.join("version")).unwrap(),
                    "cached"
                );
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(entry.join("version")).unwrap(),
            "cached"
        );
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 1);
    }

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

        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let started = Instant::now();
        let worker = spawn_prewarm_with(PrewarmCoordinator::new(), move || {
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

    /// Smoke test: spawning the detached prewarm body must not block the
    /// caller. The injected no-op keeps this test independent of npx.
    #[test]
    fn test_spawn_prewarm_body_with_is_non_blocking() {
        let started = Instant::now();
        let handle = spawn_prewarm_body_with(PrewarmCoordinator::new(), || {});
        let elapsed = started.elapsed();
        // 500ms is generous; the call should return in microseconds.
        // If this fails, the testable spawn path stopped returning promptly.
        assert!(
            elapsed.as_millis() < 500,
            "spawn_prewarm_with blocked for {:?} — must return immediately",
            elapsed,
        );
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn spawned_prewarm_tracks_body_until_it_returns() {
        let coordinator = PrewarmCoordinator::new();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let handle = spawn_prewarm_body_with(coordinator.clone(), move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        });

        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(*coordinator.in_flight.subscribe().borrow(), 1);

        let mut update_wait = Box::pin(coordinator.wait_for_active(Duration::from_secs(1)));
        let first_poll = std::future::poll_fn(|context| {
            std::task::Poll::Ready(update_wait.as_mut().poll(context))
        })
        .await;
        assert!(first_poll.is_pending());

        release_tx.send(()).unwrap();
        assert_eq!(update_wait.await, PrewarmWaitOutcome::Completed);
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn spawned_prewarm_clears_active_count_when_body_panics() {
        let coordinator = PrewarmCoordinator::new();
        let handle = spawn_prewarm_body_with(coordinator.clone(), || {
            panic!("intentional prewarm body panic");
        });

        assert!(handle.join().is_err(), "the test body must panic");
        assert_eq!(*coordinator.in_flight.subscribe().borrow(), 0);
        assert_eq!(
            coordinator.wait_for_active(Duration::from_secs(1)).await,
            PrewarmWaitOutcome::NotRunning,
        );
    }

    #[tokio::test]
    async fn prewarm_is_registered_before_thread_starts() {
        let coordinator = PrewarmCoordinator::new();
        let coordinator_at_spawn = coordinator.clone();
        let (spawn_checked_tx, spawn_checked_rx) = mpsc::channel();
        let (start_task_tx, start_task_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();

        let handle = spawn_prewarm_with_spawner(
            coordinator.clone(),
            move || {
                entered_tx.send(()).unwrap();
            },
            move |task| {
                assert_eq!(
                    *coordinator_at_spawn.in_flight.subscribe().borrow(),
                    1,
                    "prewarm must be registered before thread::spawn is called",
                );
                spawn_checked_tx.send(()).unwrap();
                thread::spawn(move || {
                    start_task_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                    task();
                })
            },
        );

        spawn_checked_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let mut update_wait = Box::pin(coordinator.wait_for_active(Duration::from_secs(1)));
        let first_poll = std::future::poll_fn(|context| {
            std::task::Poll::Ready(update_wait.as_mut().poll(context))
        })
        .await;
        assert!(first_poll.is_pending());

        start_task_tx.send(()).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(update_wait.await, PrewarmWaitOutcome::Completed);
        handle.join().unwrap();
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

    #[tokio::test(start_paused = true)]
    async fn automatic_update_waits_past_the_original_thirty_second_lock_timeout() {
        let coordinator = PrewarmCoordinator::new();
        let materialization_lock = tokio::sync::Mutex::new(());
        let prewarm_lock_guard = materialization_lock.lock().await;
        coordinator.prewarm_started();

        let mut update_wait = Box::pin(coordinator.wait_for_active(AUTOMATIC_UPDATE_PREWARM_WAIT));
        let first_poll = std::future::poll_fn(|context| {
            std::task::Poll::Ready(update_wait.as_mut().poll(context))
        })
        .await;
        assert!(first_poll.is_pending());

        tokio::time::advance(Duration::from_secs(31)).await;
        let after_thirty_one_seconds = std::future::poll_fn(|context| {
            std::task::Poll::Ready(update_wait.as_mut().poll(context))
        })
        .await;
        assert!(after_thirty_one_seconds.is_pending());

        // The update does not try to take the materialization lock while it
        // waits. Prewarm releases that lock before publishing completion.
        drop(prewarm_lock_guard);
        coordinator.prewarm_finished();
        assert_eq!(
            update_wait.await,
            PrewarmWaitOutcome::Completed,
            "an in-process prewarm lasting beyond the old 30s lock wait must not fail the update",
        );
        assert!(materialization_lock.try_lock().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn automatic_update_prewarm_wait_is_bounded() {
        let coordinator = PrewarmCoordinator::new();
        coordinator.prewarm_started();

        let mut update_wait = Box::pin(coordinator.wait_for_active(AUTOMATIC_UPDATE_PREWARM_WAIT));
        let first_poll = std::future::poll_fn(|context| {
            std::task::Poll::Ready(update_wait.as_mut().poll(context))
        })
        .await;
        assert!(first_poll.is_pending());

        tokio::time::advance(AUTOMATIC_UPDATE_PREWARM_WAIT).await;
        assert_eq!(update_wait.await, PrewarmWaitOutcome::TimedOut);
    }

    #[tokio::test]
    async fn automatic_update_does_not_wait_when_prewarm_never_started() {
        let coordinator = PrewarmCoordinator::new();
        assert_eq!(
            coordinator
                .wait_for_active(AUTOMATIC_UPDATE_PREWARM_WAIT)
                .await,
            PrewarmWaitOutcome::NotRunning,
        );
    }
}
