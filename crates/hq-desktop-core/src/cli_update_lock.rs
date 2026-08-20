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
use std::time::Duration;

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
}
