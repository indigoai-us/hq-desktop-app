//! Cross-process lock serializing global `@indigoai-us/hq-cli` installs.
//!
//! Multiple independent actors run `npm install -g @indigoai-us/hq-cli`
//! against the SAME global prefix with no coordination: this app's background
//! updater (`hq_cli_update`), its first-install provisioning (`install_deps`),
//! and hq-cli's own self-update gate (`src/utils/version-gate.ts`, which runs
//! a synchronous `npm install -g` pre-parse on every CLI invocation). npm
//! stages a global update by renaming the package dir aside to a hidden
//! `.hq-cli-XXXX` dir and moving the new tree in; two overlapping installs can
//! collide mid-rename and gut the install entirely — no `package.json`, no
//! `bin/hq` — which is exactly what happened on a customer machine on
//! 2026-08-18, leaving the CLI unreachable for ~24h. The existing convergence
//! gate in `hq_cli_update` detects that an install didn't take AFTER the fact;
//! it cannot prevent two writers from corrupting the tree mid-flight. This
//! lock closes that gap: it guards the WRITE, while the non-convergence
//! marker keeps guarding the RETRY policy — complementary, not overlapping.
//!
//! ## Cross-repo contract — do not change unilaterally
//!
//! The lock file's path, JSON field names, and staleness semantics are a
//! CONTRACT shared with hq-cli's TypeScript implementation (companion change
//! in the hq-cli repo). Any edit here must land in lockstep there:
//!
//!   * Path: `$HOME/.hq/locks/cli-update.lock`. The directory component is
//!     overridable via the `HQ_LOCK_DIR` env var (tests must never touch the
//!     real `~/.hq`); the file name is fixed.
//!   * Content, exact field names:
//!     `{"pid": <u32>, "startedAt": "<RFC3339>", "tool": "<string>",
//!       "version": "<string>"}`.
//!   * Acquisition is an atomic create-new (`O_CREAT | O_EXCL`). An existing
//!     file is parsed and treated as STALE when `startedAt` is ≥ 10 minutes
//!     old OR the holder pid is dead (`kill(pid, 0)`; `EPERM` counts as
//!     alive — the pid exists under another uid). An unparseable file is
//!     stale (a crash between create and write leaves an empty file). On
//!     non-unix targets there is no cheap pid liveness probe, so staleness
//!     degrades to age-only. A stale lock is removed and acquisition retried
//!     exactly once; a fresh lock means DO NOT INSTALL — the caller logs one
//!     line identifying the holder and skips the cycle (the scheduled checker
//!     retries naturally).
//!
//! Release goes through a `Drop` guard so a panic on the install path still
//! deletes the lock file; the 10-minute age ceiling covers SIGKILL and power
//! loss, where no destructor runs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

/// Fixed lock file name under the lock directory. Contract — matches hq-cli.
pub const CLI_UPDATE_LOCK_FILE: &str = "cli-update.lock";

/// Env var overriding the lock DIRECTORY (not the file name). Contract —
/// matches hq-cli. Exists so tests never write into the real `~/.hq`.
pub const LOCK_DIR_ENV: &str = "HQ_LOCK_DIR";

/// A lock whose `startedAt` is at least this old is stale regardless of the
/// holder pid: no healthy `npm install -g` of this package runs 10 minutes.
/// Contract — matches hq-cli.
pub const CLI_UPDATE_LOCK_STALE_AFTER: Duration = Duration::from_secs(600);

/// Fixed inter-attempt backoff for the setup-deps WAITING acquire
/// ([`acquire_cli_update_lock_waiting`]). Fixed, not exponential: the goal is to
/// ride out a brief concurrent install cycle, not to be polite. The crate seam
/// takes the step explicitly (so its own tests stay hermetic and race-free); the
/// app-crate caller supplies this value in production and zeroes it under
/// cfg(test) with an env opt-in, mirroring `install_deps::swap_backoff`.
pub const CLI_INSTALL_LOCK_WAIT_BACKOFF: Duration = Duration::from_secs(3);

/// Total wall-clock budget the setup-deps path waits for a concurrent hq-cli
/// install to finish before giving up and reporting the skip. STRICTLY less than
/// [`CLI_UPDATE_LOCK_STALE_AFTER`] so a waiter can never outlive the window in
/// which a dead holder's lock is reclaimed (asserted in tests).
pub const CLI_INSTALL_LOCK_WAIT_BUDGET: Duration = Duration::from_secs(90);

/// The lock file's JSON body. Field names are the cross-repo contract —
/// hq-cli parses these exact keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateLockInfo {
    pub pid: u32,
    pub started_at: String,
    pub tool: String,
    pub version: String,
}

impl CliUpdateLockInfo {
    /// One-line description of the holder for the mandatory skip log line.
    /// Never includes the lock path (which embeds `$HOME`).
    pub fn holder_line(&self) -> String {
        format!(
            "pid {} ({}, version {}, since {})",
            self.pid, self.tool, self.version, self.started_at
        )
    }
}

/// Held-lock guard. Dropping it (including during a panic unwind) removes the
/// lock file. Deletion failures are swallowed: the file will read as stale
/// after the age ceiling, and there is nothing useful a destructor can do.
#[derive(Debug)]
pub struct CliUpdateLockGuard {
    path: PathBuf,
}

impl Drop for CliUpdateLockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Outcome of an acquisition attempt.
#[derive(Debug)]
pub enum CliUpdateLockAttempt {
    /// This process now holds the lock; keep the guard alive for the whole
    /// install (spawn through convergence probe).
    Acquired(CliUpdateLockGuard),
    /// Another live process holds a fresh lock. Do not install; log the
    /// holder and skip this cycle.
    Held { holder: String },
}

/// Outcome of a bounded acquire that may be cancelled by the caller.
#[derive(Debug)]
pub enum CliUpdateLockWaitAttempt {
    Acquired(CliUpdateLockGuard),
    Held { holder: String },
    Cancelled,
}

/// Resolve the lock directory: `HQ_LOCK_DIR` when set, else `~/.hq/locks`.
fn lock_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(LOCK_DIR_ENV) {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".hq").join("locks"))
        .ok_or_else(|| "could not resolve home directory for the cli-update lock".to_string())
}

/// Acquire the shared cli-update lock for this process.
///
/// `tool` identifies the writer (e.g. `hq-desktop-app-cli-update`) and
/// `version` is this app's version — both are diagnostic content for whoever
/// finds the lock, not part of the staleness decision.
pub fn acquire_cli_update_lock(tool: &str, version: &str) -> Result<CliUpdateLockAttempt, String> {
    acquire_cli_update_lock_in(&lock_dir()?, tool, version)
}

/// Directory-explicit acquisition seam so tests exercise the full algorithm
/// against a temp dir without mutating process env.
pub fn acquire_cli_update_lock_in(
    dir: &Path,
    tool: &str,
    version: &str,
) -> Result<CliUpdateLockAttempt, String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("could not create lock dir {}: {e}", dir.display()))?;
    let path = dir.join(CLI_UPDATE_LOCK_FILE);
    // At most two create attempts: the initial one, plus one retry after a
    // stale takeover. Losing the post-takeover race to another acquirer is a
    // fresh, live lock — report Held rather than looping.
    for attempt in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let info = CliUpdateLockInfo {
                    pid: std::process::id(),
                    started_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                    tool: tool.to_string(),
                    version: version.to_string(),
                };
                let body = serde_json::to_string(&info)
                    .map_err(|e| format!("could not serialize cli-update lock: {e}"))?;
                // A write failure must not leave a zero-byte lock that blocks
                // nobody but confuses everybody — remove it and bail.
                if let Err(e) = file.write_all(body.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("could not write cli-update lock: {e}"));
                }
                return Ok(CliUpdateLockAttempt::Acquired(CliUpdateLockGuard { path }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = read_lock_info(&path);
                let stale = existing
                    .as_ref()
                    .map(|info| lock_is_stale(info, Utc::now()))
                    // Unparseable → stale: an interrupted writer left junk.
                    .unwrap_or(true);
                if stale && attempt == 0 {
                    // Remove and retry once. A racing remove is fine — the
                    // create_new above is the only authority.
                    let _ = fs::remove_file(&path);
                    continue;
                }
                let holder = existing
                    .map(|info| info.holder_line())
                    .unwrap_or_else(|| "unknown holder (unparseable lock)".to_string());
                return Ok(CliUpdateLockAttempt::Held { holder });
            }
            Err(e) => {
                return Err(format!(
                    "could not create cli-update lock {}: {e}",
                    path.display()
                ));
            }
        }
    }
    unreachable!("the second create attempt always returns");
}

/// Bounded, caller-side WAITING acquire for the setup deps path.
///
/// Repeatedly calls the unchanged atomic [`acquire_cli_update_lock_in`] behind a
/// fixed `backoff` until it acquires or the `budget` elapses, then returns the
/// same [`CliUpdateLockAttempt`]. This is PURE caller-side retry: the lock file
/// path, JSON body, staleness rules, and the `O_CREAT | O_EXCL` acquire are all
/// untouched, so the cross-repo contract with hq-cli's TypeScript version gate is
/// unchanged and needs no companion change there.
///
/// `on_wait(holder)` fires once before each backoff sleep (never after the final
/// attempt), so a caller can surface progress. A zero `backoff` performs exactly
/// one attempt and never sleeps, which keeps hermetic tests bounded.
pub fn acquire_cli_update_lock_waiting(
    tool: &str,
    version: &str,
    budget: Duration,
    backoff: Duration,
    on_wait: impl FnMut(&str),
) -> Result<CliUpdateLockAttempt, String> {
    match acquire_cli_update_lock_waiting_cancellable(
        tool,
        version,
        budget,
        backoff,
        || false,
        on_wait,
    )? {
        CliUpdateLockWaitAttempt::Acquired(guard) => Ok(CliUpdateLockAttempt::Acquired(guard)),
        CliUpdateLockWaitAttempt::Held { holder } => Ok(CliUpdateLockAttempt::Held { holder }),
        CliUpdateLockWaitAttempt::Cancelled => {
            unreachable!("the non-cancellable wait never cancels")
        }
    }
}

/// Cancellable variant of [`acquire_cli_update_lock_waiting`]. The predicate is
/// checked before each acquire, immediately after acquisition, and during the
/// retry backoff, so a cancelled setup cannot begin an install after its
/// competing holder releases the lock.
pub fn acquire_cli_update_lock_waiting_cancellable(
    tool: &str,
    version: &str,
    budget: Duration,
    backoff: Duration,
    is_cancelled: impl FnMut() -> bool,
    on_wait: impl FnMut(&str),
) -> Result<CliUpdateLockWaitAttempt, String> {
    acquire_cli_update_lock_waiting_cancellable_in(
        &lock_dir()?,
        tool,
        version,
        budget,
        backoff,
        is_cancelled,
        on_wait,
    )
}

/// Directory-explicit seam for [`acquire_cli_update_lock_waiting`] so tests drive
/// the full wait against a temp dir with an explicit budget/backoff — no process
/// env and no wall-clock races. The loop makes at most `budget / backoff`
/// attempts, so it always terminates well inside [`CLI_UPDATE_LOCK_STALE_AFTER`]
/// when `budget` is (see [`CLI_INSTALL_LOCK_WAIT_BUDGET`]).
pub fn acquire_cli_update_lock_waiting_in(
    dir: &Path,
    tool: &str,
    version: &str,
    budget: Duration,
    backoff: Duration,
    on_wait: impl FnMut(&str),
) -> Result<CliUpdateLockAttempt, String> {
    match acquire_cli_update_lock_waiting_cancellable_in(
        dir,
        tool,
        version,
        budget,
        backoff,
        || false,
        on_wait,
    )? {
        CliUpdateLockWaitAttempt::Acquired(guard) => Ok(CliUpdateLockAttempt::Acquired(guard)),
        CliUpdateLockWaitAttempt::Held { holder } => Ok(CliUpdateLockAttempt::Held { holder }),
        CliUpdateLockWaitAttempt::Cancelled => {
            unreachable!("the non-cancellable wait never cancels")
        }
    }
}

/// Directory-explicit cancellable waiting seam. The retry sleep is split into
/// short slices so a registered frontend cancellation does not wait for an
/// entire production backoff interval before being observed.
pub fn acquire_cli_update_lock_waiting_cancellable_in(
    dir: &Path,
    tool: &str,
    version: &str,
    budget: Duration,
    backoff: Duration,
    mut is_cancelled: impl FnMut() -> bool,
    mut on_wait: impl FnMut(&str),
) -> Result<CliUpdateLockWaitAttempt, String> {
    let started = Instant::now();
    loop {
        if is_cancelled() {
            return Ok(CliUpdateLockWaitAttempt::Cancelled);
        }
        match acquire_cli_update_lock_in(dir, tool, version)? {
            CliUpdateLockAttempt::Acquired(guard) => {
                if is_cancelled() {
                    drop(guard);
                    return Ok(CliUpdateLockWaitAttempt::Cancelled);
                }
                return Ok(CliUpdateLockWaitAttempt::Acquired(guard));
            }
            CliUpdateLockAttempt::Held { holder } => {
                // Wait only while another (backoff + attempt) still fits inside
                // the budget. A zero backoff means one attempt, no sleep — which
                // keeps hermetic unit tests bounded and free of wall-clock races.
                if backoff.is_zero() || started.elapsed() + backoff >= budget {
                    return Ok(CliUpdateLockWaitAttempt::Held { holder });
                }
                on_wait(&holder);
                if is_cancelled() {
                    return Ok(CliUpdateLockWaitAttempt::Cancelled);
                }
                let sleep_started = Instant::now();
                while sleep_started.elapsed() < backoff {
                    let remaining = backoff.saturating_sub(sleep_started.elapsed());
                    std::thread::sleep(remaining.min(Duration::from_millis(50)));
                    if is_cancelled() {
                        return Ok(CliUpdateLockWaitAttempt::Cancelled);
                    }
                }
            }
        }
    }
}

fn read_lock_info(path: &Path) -> Option<CliUpdateLockInfo> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Contract staleness: age ≥ 10 minutes, or the holder pid is dead. An
/// unparseable `startedAt` is stale — the field is CONTENT this side must be
/// able to trust, and a writer that produced junk is not a live installer we
/// can identify. A `startedAt` in the future (clock skew) is treated as fresh
/// by age (elapsed clamps to zero) and left to the pid probe.
fn lock_is_stale(info: &CliUpdateLockInfo, now: DateTime<Utc>) -> bool {
    let started = match DateTime::parse_from_rfc3339(&info.started_at) {
        Ok(t) => t.with_timezone(&Utc),
        Err(_) => return true,
    };
    let age = (now - started).to_std().unwrap_or(Duration::ZERO);
    if age >= CLI_UPDATE_LOCK_STALE_AFTER {
        return true;
    }
    pid_is_dead(info.pid)
}

/// `kill(pid, 0)` liveness probe. `EPERM` means the pid exists under another
/// uid → alive. Only compiled where the crate links libc (macOS/Linux — see
/// Cargo.toml); elsewhere staleness degrades to age-only per the contract.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn pid_is_dead(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        // Not a representable pid on this platform — nothing to probe.
        return false;
    };
    // SAFETY: signal 0 performs error checking only; no signal is sent.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn pid_is_dead(_pid: u32) -> bool {
    // Documented degradation: no cheap cross-uid liveness probe here, so only
    // the 10-minute age ceiling retires an abandoned lock.
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeDelta;

    fn temp_lock_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hq-cli-update-lock-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lock_path(dir: &Path) -> PathBuf {
        dir.join(CLI_UPDATE_LOCK_FILE)
    }

    fn write_lock(dir: &Path, info: &CliUpdateLockInfo) {
        fs::write(lock_path(dir), serde_json::to_string(info).unwrap()).unwrap();
    }

    fn rfc3339_secs_ago(secs: i64) -> String {
        (Utc::now() - TimeDelta::seconds(secs)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    #[test]
    fn acquire_writes_the_exact_contract_field_names() {
        let dir = temp_lock_dir("contract");
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        assert!(matches!(attempt, CliUpdateLockAttempt::Acquired(_)));
        let raw = fs::read_to_string(lock_path(&dir)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Exact key set — the TypeScript side parses these names verbatim.
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["pid", "startedAt", "tool", "version"]);
        assert_eq!(json["pid"].as_u64().unwrap(), u64::from(std::process::id()));
        assert_eq!(json["tool"], "hq-desktop-app-cli-update");
        assert_eq!(json["version"], "1.2.3");
        DateTime::parse_from_rfc3339(json["startedAt"].as_str().unwrap())
            .expect("startedAt must be RFC3339");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_live_lock_reports_held_and_is_not_removed() {
        let dir = temp_lock_dir("contention");
        let holder = CliUpdateLockInfo {
            pid: std::process::id(), // this process: definitely alive
            started_at: rfc3339_secs_ago(30),
            tool: "hq-cli-version-gate".into(),
            version: "5.99.0".into(),
        };
        write_lock(&dir, &holder);
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        match attempt {
            CliUpdateLockAttempt::Held { holder: line } => {
                assert!(line.contains("hq-cli-version-gate"), "holder line: {line}");
                assert!(line.contains(&std::process::id().to_string()));
            }
            other => panic!("expected Held, got {other:?}"),
        }
        // The fresh holder's lock must survive the losing attempt untouched.
        let raw = fs::read_to_string(lock_path(&dir)).unwrap();
        let survived: CliUpdateLockInfo = serde_json::from_str(&raw).unwrap();
        assert_eq!(survived.tool, "hq-cli-version-gate");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_past_the_age_ceiling_is_taken_over_even_from_a_live_pid() {
        let dir = temp_lock_dir("stale-age");
        let holder = CliUpdateLockInfo {
            pid: std::process::id(), // alive — age alone must retire it
            started_at: rfc3339_secs_ago(601),
            tool: "hq-cli-version-gate".into(),
            version: "5.99.0".into(),
        };
        write_lock(&dir, &holder);
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        let CliUpdateLockAttempt::Acquired(_guard) = attempt else {
            panic!("expected takeover of an over-age lock");
        };
        let raw = fs::read_to_string(lock_path(&dir)).unwrap();
        let taken: CliUpdateLockInfo = serde_json::from_str(&raw).unwrap();
        assert_eq!(taken.tool, "hq-desktop-app-cli-update");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_fresh_lock_from_a_dead_pid_is_taken_over() {
        let dir = temp_lock_dir("stale-pid");
        // Spawn-and-reap a child so the pid is REAL but certainly dead.
        let mut child = std::process::Command::new("true").spawn().expect("spawn");
        let dead_pid = child.id();
        child.wait().expect("reap");
        let holder = CliUpdateLockInfo {
            pid: dead_pid,
            started_at: rfc3339_secs_ago(5), // well inside the age window
            tool: "hq-cli-version-gate".into(),
            version: "5.99.0".into(),
        };
        write_lock(&dir, &holder);
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        assert!(
            matches!(attempt, CliUpdateLockAttempt::Acquired(_)),
            "a dead holder must not block acquisition"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparseable_lock_is_taken_over() {
        let dir = temp_lock_dir("stale-junk");
        // An interrupted writer leaves an empty or truncated file.
        fs::write(lock_path(&dir), "").unwrap();
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        assert!(matches!(attempt, CliUpdateLockAttempt::Acquired(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_the_guard_removes_the_lock_file() {
        let dir = temp_lock_dir("release");
        let attempt = acquire_cli_update_lock_in(&dir, "hq-desktop-app-cli-update", "1.2.3")
            .expect("acquire");
        let CliUpdateLockAttempt::Acquired(guard) = attempt else {
            panic!("expected acquisition");
        };
        assert!(lock_path(&dir).exists());
        drop(guard);
        assert!(!lock_path(&dir).exists(), "release must delete the file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_while_holding_the_guard_still_releases() {
        let dir = temp_lock_dir("panic-release");
        let dir_for_panic = dir.clone();
        let result = std::panic::catch_unwind(move || {
            let attempt =
                acquire_cli_update_lock_in(&dir_for_panic, "hq-desktop-app-cli-update", "1.2.3")
                    .expect("acquire");
            let CliUpdateLockAttempt::Acquired(_guard) = attempt else {
                panic!("expected acquisition");
            };
            panic!("install path exploded while holding the lock");
        });
        assert!(result.is_err(), "the closure must actually panic");
        assert!(
            !lock_path(&dir).exists(),
            "unwind must run the Drop guard and delete the lock"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hq_lock_dir_env_overrides_the_default_lock_directory() {
        // The only test that touches process env — it owns HQ_LOCK_DIR for
        // its whole body and restores it after.
        let dir = temp_lock_dir("env-override");
        let previous = std::env::var_os(LOCK_DIR_ENV);
        std::env::set_var(LOCK_DIR_ENV, &dir);
        let attempt =
            acquire_cli_update_lock("hq-desktop-app-cli-update", "1.2.3").expect("acquire");
        let CliUpdateLockAttempt::Acquired(guard) = attempt else {
            panic!("expected acquisition");
        };
        assert!(
            lock_path(&dir).exists(),
            "the lock must land in HQ_LOCK_DIR, not ~/.hq/locks"
        );
        drop(guard);
        match previous {
            Some(v) => std::env::set_var(LOCK_DIR_ENV, v),
            None => std::env::remove_var(LOCK_DIR_ENV),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    fn fresh_live_holder() -> CliUpdateLockInfo {
        CliUpdateLockInfo {
            pid: std::process::id(), // this process: definitely alive
            started_at: rfc3339_secs_ago(5),
            tool: "hq-cli-version-gate".into(),
            version: "5.99.0".into(),
        }
    }

    #[test]
    fn a_lock_released_mid_budget_is_acquired_rather_than_skipped() {
        let dir = temp_lock_dir("wait-release");
        // Pre-seed a FRESH, live holder so the FIRST attempt deterministically
        // observes Held — real critical-section overlap, asserted by the callback
        // firing, not by wall-clock timing.
        write_lock(&dir, &fresh_live_holder());

        let mut observed_held = 0u32;
        let dir_for_cb = dir.clone();
        let attempt = acquire_cli_update_lock_waiting_in(
            &dir,
            "hq-desktop-app-install-deps",
            "1.2.3",
            Duration::from_secs(10),
            Duration::from_millis(1),
            |holder| {
                observed_held += 1;
                assert!(holder.contains("hq-cli-version-gate"), "holder: {holder}");
                // Simulate the holder's guard drop deterministically AFTER the
                // first observed Held — the next attempt then acquires. No race.
                if observed_held == 1 {
                    fs::remove_file(lock_path(&dir_for_cb)).unwrap();
                }
            },
        )
        .expect("acquire");
        assert!(
            matches!(attempt, CliUpdateLockAttempt::Acquired(_)),
            "a lock released mid-budget must be acquired, not skipped"
        );
        assert_eq!(
            observed_held, 1,
            "first attempt observes Held, then acquires"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancelled_waiter_does_not_acquire_a_lock_released_after_cancellation() {
        let dir = temp_lock_dir("wait-cancelled");
        write_lock(&dir, &fresh_live_holder());

        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancelled_for_wait = std::sync::Arc::clone(&cancelled);
        let dir_for_wait = dir.clone();
        let attempt = acquire_cli_update_lock_waiting_cancellable_in(
            &dir,
            "hq-desktop-app-install-deps",
            "1.2.3",
            Duration::from_secs(10),
            Duration::from_millis(1),
            || cancelled.load(std::sync::atomic::Ordering::SeqCst),
            |_| {
                cancelled_for_wait.store(true, std::sync::atomic::Ordering::SeqCst);
                fs::remove_file(lock_path(&dir_for_wait)).unwrap();
            },
        )
        .expect("acquire");

        assert!(
            matches!(attempt, CliUpdateLockWaitAttempt::Cancelled),
            "a cancelled waiter must not acquire a lock released after cancellation"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_held_for_the_whole_budget_still_skips_within_the_bound() {
        let dir = temp_lock_dir("wait-held");
        write_lock(&dir, &fresh_live_holder());

        let budget = Duration::from_millis(60);
        let started = Instant::now();
        let mut retries = 0u32;
        let attempt = acquire_cli_update_lock_waiting_in(
            &dir,
            "hq-desktop-app-install-deps",
            "1.2.3",
            budget,
            Duration::from_millis(10),
            |_| retries += 1,
        )
        .expect("acquire");
        let elapsed = started.elapsed();
        match attempt {
            CliUpdateLockAttempt::Held { holder } => {
                assert!(holder.contains("hq-cli-version-gate"), "holder: {holder}");
            }
            other => panic!("expected Held after the whole budget, got {other:?}"),
        }
        assert!(retries >= 1, "the waiter must have retried at least once");
        assert!(elapsed < CLI_UPDATE_LOCK_STALE_AFTER, "elapsed {elapsed:?}");
        // The fresh holder's lock must survive the losing waiter untouched.
        let raw = fs::read_to_string(lock_path(&dir)).unwrap();
        let survived: CliUpdateLockInfo = serde_json::from_str(&raw).unwrap();
        assert_eq!(survived.tool, "hq-cli-version-gate");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cli_install_wait_budget_stays_inside_the_stale_ceiling() {
        // A waiter must never outlive the window in which a dead holder's lock is
        // reclaimed, or a crashed holder could hang the wait until the ceiling.
        assert!(
            CLI_INSTALL_LOCK_WAIT_BUDGET < CLI_UPDATE_LOCK_STALE_AFTER,
            "wait budget {CLI_INSTALL_LOCK_WAIT_BUDGET:?} must stay under the {CLI_UPDATE_LOCK_STALE_AFTER:?} stale ceiling"
        );
        assert!(
            !CLI_INSTALL_LOCK_WAIT_BACKOFF.is_zero(),
            "the production backoff must be non-zero or the wait busy-loops"
        );
    }

    #[test]
    fn the_waiting_acquire_writes_the_same_contract_body_as_the_plain_acquire() {
        // On a free dir the waiting acquire takes the lock on the first attempt
        // and must write the byte-identical contract body the plain acquire does,
        // so the cross-repo contract with hq-cli is provably unchanged.
        let dir = temp_lock_dir("wait-contract");
        let attempt = acquire_cli_update_lock_waiting_in(
            &dir,
            "hq-desktop-app-cli-update",
            "1.2.3",
            Duration::from_secs(1),
            Duration::from_millis(1),
            |_| panic!("must not wait on a free lock"),
        )
        .expect("acquire");
        assert!(matches!(attempt, CliUpdateLockAttempt::Acquired(_)));
        let raw = fs::read_to_string(lock_path(&dir)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["pid", "startedAt", "tool", "version"]);
        assert_eq!(json["pid"].as_u64().unwrap(), u64::from(std::process::id()));
        assert_eq!(json["tool"], "hq-desktop-app-cli-update");
        assert_eq!(json["version"], "1.2.3");
        DateTime::parse_from_rfc3339(json["startedAt"].as_str().unwrap())
            .expect("startedAt must be RFC3339");
        drop(attempt);
        let _ = fs::remove_dir_all(&dir);
    }
}
