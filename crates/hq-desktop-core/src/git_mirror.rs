//! After-sync git mirror.
//!
//! When the HQ folder root is itself a git repo, commit any local changes
//! and push to the tracked upstream (if any) so the user's HQ doubles as a
//! versioned snapshot. Triggered fire-and-forget from the AllComplete arms
//! of both the manual sync (`commands/sync.rs`) and the auto-sync watcher
//! (`commands/daemon.rs`).
//!
//! All output goes to the persistent diagnostic log under the `git-mirror`
//! tag — never to the popover. The HQ sync itself is authoritative; a git
//! mirror failure must never block sync.
//!
//! ## Safety
//!
//! Two properties this module is responsible for, both learned the hard way:
//!
//! 1. **It must not mass-delete.** `git add -A` cannot tell "the user deleted
//!    these files" from "these files are not on disk *right now*" (mid-pull,
//!    partial restore, moved HQ root, unmounted volume). Committing and
//!    pushing that reading propagates the accident to every other machine.
//!    [`bulk_delete_verdict`] ports the sync engine's bulk-asymmetry circuit
//!    breaker (`hq-cloud` `share.ts`: ratio 10%, absolute floor 10, same
//!    `HQ_SYNC_DELETE_BULK_OVERRIDE` operator knob) onto this path so the two
//!    layers refuse for the same reasons under one knob name.
//! 2. **It must not wedge the repo.** Every git child here writes
//!    `.git/index.lock`, and a killed child leaves it behind — which then
//!    blocks *every* HQ git write, including the autocommit hook, until
//!    someone deletes the file by hand. Mutual exclusion is therefore a real
//!    cross-process advisory lock (not the process-local `Mutex` alone), git
//!    children run under a timeout with a kill path, and a stale-lock reaper
//!    runs at launch, before every mirror, and after a failed one.
//!
//! Note for reviewers: this module pushes the HQ root to its upstream, which
//! HQ's own `hq-root-never-push-remote` charter rule forbids for agent
//! sessions. That tension is deliberate and unresolved here — the guards
//! below make the existing behaviour safe; whether the push itself should
//! exist is an owner decision tracked separately.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use chrono::SecondsFormat;
use fs2::FileExt;

use crate::logfile::log;
use crate::paths;

const LOG_TAG: &str = "git-mirror";

/// Guards against overlapping mirror runs. The auto-sync watcher fires
/// AllComplete every 10 minutes; on a slow network a single push could run
/// longer than that. `try_lock` lets the second pass skip rather than
/// race a still-running `git push`, and the guard auto-releases on scope
/// exit so a panic mid-run never strands the lock.
///
/// This only serializes threads inside one process. The cross-process half
/// is [`try_acquire_mirror_lock`].
static MIRROR_LOCK: Mutex<()> = Mutex::new(());

/// Minimum spacing between mirror runs. The watch-driven daemon can emit
/// AllComplete every few seconds under heavy local churn (an active HQ session
/// plus autocommit hooks rewriting the tree). Without a floor, git-mirror runs
/// `git add -A` + commit every few seconds — burning CPU/disk and contending on
/// `.git/index.lock` with any other writer. One snapshot per minute is ample for
/// a versioned mirror; the next sync within the window catches up the tail.
const MIN_MIRROR_INTERVAL: Duration = Duration::from_secs(60);

/// Timestamp of the last mirror attempt, for the throttle above.
static LAST_MIRROR_AT: Mutex<Option<Instant>> = Mutex::new(None);

// ─────────────────────────────────────────────────────────────────────────────
// Bulk-delete circuit breaker (ported from hq-cloud `share.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/// Refuse when **both** hold: staged deletions are at least this fraction of
/// the tree tracked at HEAD, and there are at least [`BULK_ASYMMETRY_MIN_ABS`]
/// of them. Same values as the engine's breaker so operators reason about one
/// threshold, not two.
const BULK_ASYMMETRY_RATIO: f64 = 0.10;

/// The absolute floor is what lets ordinary cleanup through: deleting one file
/// from a five-file repo is 20% but one absolute deletion, and never trips.
const BULK_ASYMMETRY_MIN_ABS: usize = 10;

/// Operator rollback knob. Deliberately the same variable the engine honours
/// (`hq-cloud` `share.ts`), so a legitimate mass-delete is unblocked once for
/// both layers instead of twice with different names.
const BULK_OVERRIDE_ENV: &str = "HQ_SYNC_DELETE_BULK_OVERRIDE";

/// What the breaker decided about a staged change set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BulkDeleteVerdict {
    /// Deletion volume is normal (or explicitly overridden) — commit it.
    Allow,
    /// Deletion volume looks like a broken tree rather than user intent.
    Refuse,
}

/// Pure breaker decision, extracted so the thresholds are unit-testable
/// without a git repo (same shape as [`should_skip_for_throttle`]).
///
/// `tracked` is the file count of the tree at HEAD — i.e. what the mirror
/// believed existed before this run, the git analogue of the engine's
/// in-scope journal entries.
fn bulk_delete_verdict(deletions: usize, tracked: usize, override_on: bool) -> BulkDeleteVerdict {
    if deletions == 0 || override_on {
        return BulkDeleteVerdict::Allow;
    }
    if deletions < BULK_ASYMMETRY_MIN_ABS {
        return BulkDeleteVerdict::Allow;
    }
    // No tree at HEAD (unborn branch) means no ratio to reason about; there is
    // also nothing to delete, so this is unreachable in practice.
    if tracked == 0 {
        return BulkDeleteVerdict::Allow;
    }
    if deletions as f64 / tracked as f64 >= BULK_ASYMMETRY_RATIO {
        BulkDeleteVerdict::Refuse
    } else {
        BulkDeleteVerdict::Allow
    }
}

/// Truthy spellings accepted by the engine, matched case-insensitively.
fn parse_bulk_override(raw: Option<&str>) -> bool {
    matches!(
        raw.unwrap_or_default().trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

fn is_bulk_override_set() -> bool {
    parse_bulk_override(std::env::var(BULK_OVERRIDE_ENV).ok().as_deref())
}

// ─────────────────────────────────────────────────────────────────────────────
// git child execution
// ─────────────────────────────────────────────────────────────────────────────

/// Ceiling for index-touching git commands (`add`, `diff`, `commit`, `reset`).
/// Generous enough for a very large HQ tree on a cold page cache, short enough
/// that a wedged child is killed rather than holding `.git/index.lock` for the
/// life of the app.
const GIT_INDEX_TIMEOUT: Duration = Duration::from_secs(120);

/// Push crosses the network, so it gets its own, longer ceiling. It does not
/// hold the index lock, so a slow push is far less dangerous than a slow `add`.
const GIT_PUSH_TIMEOUT: Duration = Duration::from_secs(300);

const GIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long to wait for a child's pipes to reach EOF once the child itself has
/// exited. Descendants that inherited the descriptors can outlive git, so this
/// wait is bounded like every other one here.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(10);

// ─────────────────────────────────────────────────────────────────────────────
// Stale `.git/index.lock` reaping
// ─────────────────────────────────────────────────────────────────────────────

/// A lock must be at least this old before routine self-heal will remove it.
/// Field-validated value from the containment script users shipped themselves;
/// anything younger is presumed to belong to a live writer we simply cannot
/// see yet.
const STALE_LOCK_MIN_AGE: Duration = Duration::from_secs(300);

/// Observable facts about `.git/index.lock`, separated from the decision so
/// the decision is a pure function over all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexLockState {
    exists: bool,
    size_bytes: u64,
    /// `None` when the mtime is unreadable — treated as "unknown", never as
    /// "old enough".
    age: Option<Duration>,
    /// Some process has the file open (unix `lsof`).
    holder_present: bool,
    /// A process named exactly `git` is running.
    git_process_running: bool,
}

/// The reaper's safety conjunction. Every clause must hold; any unknown
/// resolves to "do not reap". A naive `rm -f index.lock` corrupts a live
/// index, so this errs toward leaving a lock in place.
fn should_reap_index_lock(state: IndexLockState, min_age: Duration) -> bool {
    state.exists
        && state.size_bytes == 0
        && !state.holder_present
        && !state.git_process_running
        && state.age.map(|age| age >= min_age).unwrap_or(false)
}

/// Resolve the repository's git directory. In a linked worktree (and in a
/// submodule) `.git` is a *file* pointing elsewhere, so appending to it yields
/// "Not a directory" — which would silently disable the mirror for those
/// shapes. Ask git rather than assuming the layout.
fn resolve_git_dir(hq_folder: &str) -> Result<PathBuf, String> {
    let out = git_output(
        hq_folder,
        &["rev-parse", "--absolute-git-dir"],
        GIT_INDEX_TIMEOUT,
    )?;
    if !out.status.success() {
        return Err(format!(
            "git rev-parse --absolute-git-dir failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dir.is_empty() {
        return Err("git rev-parse --absolute-git-dir returned nothing".to_string());
    }
    Ok(PathBuf::from(dir))
}

fn index_lock_path(git_dir: &Path) -> PathBuf {
    git_dir.join("index.lock")
}

/// `(holder_present, git_process_running)`. Both probes fail closed: if we
/// cannot answer, we answer "in use".
#[cfg(test)]
static PROBE_OVERRIDE: Mutex<Option<(bool, bool)>> = Mutex::new(None);

fn probe_lock_in_use(lock_path: &Path) -> (bool, bool) {
    #[cfg(test)]
    {
        if let Some(forced) = *PROBE_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) {
            return forced;
        }
    }
    (holder_present(lock_path), git_process_running())
}

#[cfg(unix)]
fn holder_present(lock_path: &Path) -> bool {
    let mut cmd = Command::new("lsof");
    paths::no_window(&mut cmd);
    match cmd.arg("-t").arg("--").arg(lock_path).output() {
        // `lsof -t` prints holder PIDs and exits 0; exit 1 means no holder.
        Ok(out) => !out.stdout.is_empty(),
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn holder_present(_lock_path: &Path) -> bool {
    // Windows has no lsof, but it also refuses to unlink a file another
    // process holds open — the failed `remove_file` is the equivalent guard.
    false
}

/// Exact-name process match. A substring match on `git` produces false
/// positives from unrelated application framework paths, which is how the
/// original field diagnosis of this bug went briefly wrong.
#[cfg(unix)]
fn git_process_running() -> bool {
    let mut cmd = Command::new("pgrep");
    paths::no_window(&mut cmd);
    match cmd.args(["-x", "git"]).output() {
        Ok(out) => out.status.code() == Some(0),
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn git_process_running() -> bool {
    let mut cmd = Command::new("tasklist");
    paths::no_window(&mut cmd);
    match cmd
        .args(["/FI", "IMAGENAME eq git.exe", "/NH", "/FO", "CSV"])
        .output()
    {
        // CSV quotes the image name, so `"git.exe"` cannot match `"gitk.exe"`.
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("\"git.exe\""),
        Err(_) => true,
    }
}

fn read_index_lock_state(lock_path: &Path, now: SystemTime) -> IndexLockState {
    let meta = match fs::metadata(lock_path) {
        Ok(meta) => meta,
        Err(_) => {
            return IndexLockState {
                exists: false,
                size_bytes: 0,
                age: None,
                holder_present: false,
                git_process_running: false,
            }
        }
    };
    let age = meta
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok());
    let (holder_present, git_process_running) = probe_lock_in_use(lock_path);
    IndexLockState {
        exists: true,
        size_bytes: meta.len(),
        age,
        holder_present,
        git_process_running,
    }
}

/// A lock that is demonstrably orphaned (unheld, no git process, past the
/// grace period) but *not* empty. We deliberately do not remove it: a writer
/// killed mid-write leaves a partial index behind, and so does a live writer
/// we failed to observe — the two are indistinguishable from the outside, and
/// guessing wrong corrupts the index. But this is the wedged state, so it gets
/// an actionable signal rather than another routine log line.
fn is_orphaned_but_nonempty(state: IndexLockState, min_age: Duration) -> bool {
    state.exists
        && state.size_bytes > 0
        && !state.holder_present
        && !state.git_process_running
        && state.age.map(|age| age >= min_age).unwrap_or(false)
}

/// Remove `.git/index.lock` when — and only when — the full safety
/// conjunction holds. Returns whether a lock was actually removed.
fn reap_index_lock_if_stale(
    hq_folder: &str,
    git_dir: &Path,
    min_age: Duration,
    now: SystemTime,
) -> bool {
    let lock_path = index_lock_path(git_dir);
    let state = read_index_lock_state(&lock_path, now);
    if !should_reap_index_lock(state, min_age) {
        if is_orphaned_but_nonempty(state, min_age) {
            let message = format!(
                "{hq_folder}: {} is {}s old with no holder and no git process, but is not \
                 empty ({}B), so HQ will not remove it automatically — a partial index and a \
                 live writer look identical from outside. Every HQ git write stays blocked \
                 until it is deleted. Quit HQ Sync, confirm no git is running, then delete {}.",
                lock_path.display(),
                state.age.map(|a| a.as_secs()).unwrap_or(0),
                state.size_bytes,
                lock_path.display(),
            );
            log(LOG_TAG, &message);
            report_wedged_index_lock(state.size_bytes);
        } else if state.exists {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: leaving {} in place (size={}B, age={}, holder={}, git-running={})",
                    lock_path.display(),
                    state.size_bytes,
                    state
                        .age
                        .map(|a| format!("{}s", a.as_secs()))
                        .unwrap_or_else(|| "unknown".to_string()),
                    state.holder_present,
                    state.git_process_running,
                ),
            );
        }
        return false;
    }
    match fs::remove_file(&lock_path) {
        Ok(()) => {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: reaped orphaned {} \
                     (0 bytes, no holder, no git process, age {}s) — HQ git writes unblocked",
                    lock_path.display(),
                    state.age.map(|a| a.as_secs()).unwrap_or(0)
                ),
            );
            true
        }
        Err(err) => {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: could not remove stale {}: {err}",
                    lock_path.display()
                ),
            );
            false
        }
    }
}

/// The one lock state the reaper cannot safely clear. Surfaced centrally so a
/// wedged machine shows up in triage instead of only in a local log file.
fn report_wedged_index_lock(size_bytes: u64) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("git_mirror_kind", "index-lock-wedged");
            scope.set_tag("lock_size_bytes", size_bytes.to_string());
        },
        || {
            sentry::capture_message(
                "[git-mirror] .git/index.lock is orphaned but non-empty; HQ git writes are \
                 blocked and automatic recovery is unsafe",
                sentry::Level::Warning,
            );
        },
    );
}

/// Launch-time self-heal. A lock orphaned by a killed run blocks every HQ git
/// write — including the autocommit hook — and the app is the only party that
/// knows the run died, so it clears the wreckage before doing anything else.
///
/// Resolves the HQ folder from `~/.hq/config.json`. A missing or unconfigured
/// config means there is nothing to heal yet; the pre-run reap in
/// [`run_mirror`] covers every later cycle regardless.
pub fn reap_stale_index_lock_on_launch() {
    let hq_folder = match crate::config::read_hq_config_lenient() {
        Ok(Some(config)) => config.hq_folder_path,
        _ => None,
    };
    let Some(hq_folder) = hq_folder else { return };
    if !Path::new(&hq_folder).join(".git").exists() {
        return;
    }
    match resolve_git_dir(&hq_folder) {
        Ok(git_dir) => {
            reap_index_lock_if_stale(&hq_folder, &git_dir, STALE_LOCK_MIN_AGE, SystemTime::now());
        }
        Err(e) => log(LOG_TAG, &format!("{hq_folder}: {e}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process mirror lock
// ─────────────────────────────────────────────────────────────────────────────

/// Advisory `flock` held for the whole git critical section. The file
/// intentionally persists: the OS releases advisory locks on process exit, so
/// unlike `.git/index.lock` this one cannot go stale after a crash.
#[derive(Debug)]
struct MirrorLock {
    file: File,
}

impl Drop for MirrorLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn mirror_lock_path(git_dir: &Path) -> PathBuf {
    git_dir.join("hq-sync-mirror.lock")
}

/// "Someone else holds this lock" is spelled differently per platform: unix
/// `flock` yields `EWOULDBLOCK`, while Windows `LockFileEx` yields
/// `ERROR_LOCK_VIOLATION`, which Rust does not map to `WouldBlock`. Checking
/// only the `ErrorKind` turns routine contention into a hard error on Windows.
fn is_lock_contended(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::WouldBlock
        || (err.raw_os_error().is_some()
            && err.raw_os_error() == fs2::lock_contended_error().raw_os_error())
}

/// `Ok(None)` means another process is mid-mirror and this run should skip.
fn try_acquire_mirror_lock(lock_path: &Path) -> Result<Option<MirrorLock>, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|err| format!("open mirror lock {}: {err}", lock_path.display()))?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(MirrorLock { file })),
        Err(err) if is_lock_contended(&err) => Ok(None),
        Err(err) => Err(format!("acquire mirror lock: {err}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/// Pure throttle decision: skip when the previous mirror was under
/// `MIN_MIRROR_INTERVAL` ago. Extracted so it's unit-testable without the global.
fn should_skip_for_throttle(last: Option<Instant>, now: Instant) -> bool {
    match last {
        Some(t) => now.duration_since(t) < MIN_MIRROR_INTERVAL,
        None => false,
    }
}

/// Spawn the mirror on a background thread so the AllComplete handler
/// returns immediately and the sync stdout reader keeps draining.
pub fn spawn_mirror_after_sync(hq_folder: &str) {
    let hq_folder = hq_folder.to_string();
    std::thread::spawn(move || {
        mirror_after_sync(&hq_folder);
    });
}

/// Synchronous entry point. Returns immediately if `<hq_folder>/.git` is
/// absent or if a previous mirror is still running — in this process or any
/// other. Never panics, never propagates errors — everything ends up in the
/// log under `git-mirror`.
pub fn mirror_after_sync(hq_folder: &str) {
    if !Path::new(hq_folder).join(".git").exists() {
        return;
    }
    let _guard = match MIRROR_LOCK.try_lock() {
        Ok(g) => g,
        Err(_) => {
            log(
                LOG_TAG,
                &format!("{hq_folder}: previous mirror still in flight, skipping"),
            );
            return;
        }
    };

    // Throttle: at most one mirror per MIN_MIRROR_INTERVAL, so a watch-driven
    // burst of AllComplete events doesn't commit (and lock the index) every few
    // seconds. We stamp the attempt time before running so concurrent callers
    // that got past the lock still see the floor.
    {
        let mut last = LAST_MIRROR_AT.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if should_skip_for_throttle(*last, now) {
            let ago = last.map(|t| now.duration_since(t).as_secs()).unwrap_or(0);
            log(
                LOG_TAG,
                &format!("{hq_folder}: throttled (last mirror {ago}s ago)"),
            );
            return;
        }
        *last = Some(now);
    }

    // Every lock path hangs off the real git directory, which is not
    // `<hq_folder>/.git` in a linked worktree or a submodule.
    let git_dir = match resolve_git_dir(hq_folder) {
        Ok(dir) => dir,
        Err(e) => {
            log(LOG_TAG, &format!("{hq_folder}: {e}"));
            return;
        }
    };

    // Cross-process exclusion. A second HQ process (a stale menubar instance,
    // a relaunch mid-run) would otherwise race us for `index.lock` and leave
    // one behind.
    let _mirror_lock = match try_acquire_mirror_lock(&mirror_lock_path(&git_dir)) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            log(
                LOG_TAG,
                &format!("{hq_folder}: another HQ process is mirroring, skipping"),
            );
            return;
        }
        Err(e) => {
            log(LOG_TAG, &format!("{hq_folder}: {e}"));
            return;
        }
    };

    if let Err(e) = run_mirror(hq_folder, &git_dir) {
        log(LOG_TAG, &format!("{hq_folder}: {e}"));
        // Failure path: our git child may have died holding `index.lock`. We
        // hold the mirror lock and every child we spawned has been reaped, so
        // an empty, unheld lock at this instant is ours and orphaned — no age
        // grace needed. The other conjuncts still apply.
        reap_index_lock_if_stale(hq_folder, &git_dir, Duration::ZERO, SystemTime::now());
    }
}

fn run_mirror(hq_folder: &str, git_dir: &Path) -> Result<(), String> {
    // Pre-run self-heal: clear an orphaned lock from an earlier killed run so
    // this cycle isn't the third one in a row to fail for the same reason.
    reap_index_lock_if_stale(hq_folder, git_dir, STALE_LOCK_MIN_AGE, SystemTime::now());

    run_git(hq_folder, &["add", "-A"], GIT_INDEX_TIMEOUT)?;

    // `diff --cached --quiet` exits 0 when index == HEAD, 1 when staged
    // changes exist. Anything else is unexpected (signal, missing HEAD on
    // a brand-new repo, etc.) and gets logged but isn't fatal.
    let staged = git_output(hq_folder, &["diff", "--cached", "--quiet"], GIT_INDEX_TIMEOUT)?;
    match staged.status.code() {
        Some(0) => {
            log(LOG_TAG, &format!("{hq_folder}: nothing to commit"));
            return Ok(());
        }
        Some(1) => {} // staged changes — proceed to commit
        Some(code) => {
            return Err(format!(
                "git diff --cached unexpected exit {code}: {}",
                String::from_utf8_lossy(&staged.stderr).trim()
            ));
        }
        None => return Err("git diff --cached killed by signal".to_string()),
    }

    if guard_bulk_deletions(hq_folder)? == BulkDeleteVerdict::Refuse {
        return Ok(());
    }

    // ISO-8601 to the second; sortable in `git log` without quoting issues.
    let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let msg = format!("hq-sync: {now_iso}");
    run_git(hq_folder, &["commit", "-m", &msg], GIT_INDEX_TIMEOUT)?;
    log(LOG_TAG, &format!("{hq_folder}: committed \"{msg}\""));

    // No upstream → skip push. Covers detached HEAD, never-pushed branches,
    // and one-off forks. User runs `git push -u` once; later syncs push.
    let upstream = git_output(
        hq_folder,
        &["rev-parse", "--abbrev-ref", "@{u}"],
        GIT_INDEX_TIMEOUT,
    )?;
    if upstream.status.success() {
        run_git(hq_folder, &["push"], GIT_PUSH_TIMEOUT)?;
        log(LOG_TAG, &format!("{hq_folder}: push ok"));
    } else {
        log(LOG_TAG, &format!("{hq_folder}: no upstream, skipping push"));
    }

    Ok(())
}

/// Apply the bulk-asymmetry breaker to what `git add -A` just staged. On
/// refusal the index is reset so nothing is left half-staged for the next
/// writer, and the reason is logged loudly plus reported to Sentry — a guard
/// that refuses silently only moves the mystery.
fn guard_bulk_deletions(hq_folder: &str) -> Result<BulkDeleteVerdict, String> {
    let deletions = count_staged_deletions(hq_folder)?;
    if deletions == 0 {
        return Ok(BulkDeleteVerdict::Allow);
    }
    let tracked = count_tracked_at_head(hq_folder)?;
    let override_on = is_bulk_override_set();
    let verdict = bulk_delete_verdict(deletions, tracked, override_on);

    if verdict == BulkDeleteVerdict::Allow {
        if override_on && deletions >= BULK_ASYMMETRY_MIN_ABS {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: {BULK_OVERRIDE_ENV} is set — committing {deletions} \
                     deletions of {tracked} tracked files without the volume check"
                ),
            );
        }
        return Ok(verdict);
    }

    let percent = (deletions as f64 / tracked as f64 * 100.0).round() as u64;
    let reason = format!(
        "{hq_folder}: REFUSING to mirror — {deletions} of {tracked} tracked files \
         ({percent}%) are staged as deletions, at or over the {}% / {} bulk-delete \
         threshold. This is what a partial restore, an interrupted pull, a moved HQ \
         folder or an unmounted volume looks like — not a cleanup. Nothing was \
         committed or pushed. If the deletions are real, re-run with \
         {BULK_OVERRIDE_ENV}=1.",
        (BULK_ASYMMETRY_RATIO * 100.0) as u64,
        BULK_ASYMMETRY_MIN_ABS,
    );
    log(LOG_TAG, &reason);
    report_bulk_refusal(deletions, tracked);

    // Unstage everything so the refused deletions aren't left sitting in the
    // index for the next writer (ours or the autocommit hook) to commit. This
    // only rewinds the index to HEAD; the working tree is untouched.
    if let Err(e) = run_git(hq_folder, &["reset", "-q"], GIT_INDEX_TIMEOUT) {
        log(
            LOG_TAG,
            &format!("{hq_folder}: index reset after refusal failed: {e}"),
        );
    }
    Ok(BulkDeleteVerdict::Refuse)
}

/// One banner-grade signal per refusal. B1 was found by reading `git log`
/// after the fact; a refusal nobody hears about repeats that.
fn report_bulk_refusal(deletions: usize, tracked: usize) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("git_mirror_kind", "bulk-delete-refused");
            scope.set_tag("deletions", deletions.to_string());
            scope.set_tag("tracked", tracked.to_string());
        },
        || {
            sentry::capture_message(
                "[git-mirror] refused to commit a bulk deletion of the HQ folder",
                sentry::Level::Warning,
            );
        },
    );
}

/// Staged deletions, rename-aware. `-M` matters: a large directory move is
/// content-preserving and must not read as a mass delete.
fn count_staged_deletions(hq_folder: &str) -> Result<usize, String> {
    let out = git_output(
        hq_folder,
        &[
            "diff",
            "--cached",
            "--name-only",
            "--diff-filter=D",
            "-M",
            "-z",
        ],
        GIT_INDEX_TIMEOUT,
    )?;
    if !out.status.success() {
        return Err(format!(
            "git diff --cached --diff-filter=D failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(count_nul_terminated(&out.stdout))
}

/// Size of the tree at HEAD — the denominator. An unborn HEAD (brand-new repo,
/// first mirror commit) has no tree and yields 0.
fn count_tracked_at_head(hq_folder: &str) -> Result<usize, String> {
    let out = git_output(
        hq_folder,
        &["ls-tree", "-r", "--name-only", "-z", "HEAD"],
        GIT_INDEX_TIMEOUT,
    )?;
    if !out.status.success() {
        return Ok(0);
    }
    Ok(count_nul_terminated(&out.stdout))
}

/// `-z` output is NUL-*terminated*, so the record count is the NUL count.
/// Counting lines instead would miscount paths containing newlines.
fn count_nul_terminated(bytes: &[u8]) -> usize {
    bytes.iter().filter(|b| **b == 0).count()
}

fn run_git(cwd: &str, args: &[&str], timeout: Duration) -> Result<(), String> {
    let out = git_output(cwd, args, timeout)?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed (exit {}): {}",
            args.join(" "),
            out.status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string()),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Run git with a hard ceiling. The mirror runs on a detached thread with no
/// supervision, so an unbounded `.output()` here is how `.git/index.lock` ends
/// up held for hours.
fn git_output(cwd: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    paths::no_window(&mut cmd);
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn git: {e}"))?;

    // Drain both pipes on their own threads. Polling `try_wait` while the
    // child blocks on a full pipe buffer would hang until the timeout even
    // for commands that finished their work — and `git ls-tree` on a large
    // HQ tree easily exceeds the buffer.
    //
    // The readers report through channels rather than `join`, because killing
    // git kills only git: a hook, a credential helper or an ssh ControlMaster
    // it spawned inherits these descriptors and can hold them open long after
    // its parent is gone. Joining would then block forever, stranding the
    // mirror thread and both of its locks — the timeout would be advertised
    // but never actually returned.
    let label = args.join(" ");
    let stdout_rx = drain_pipe(child.stdout.take());
    let stderr_rx = drain_pipe(child.stderr.take());

    let status = wait_with_timeout(&mut child, timeout, &label)?;

    // A stalled drain must never look like empty output: `count_staged_
    // deletions` reading an empty stdout as "zero deletions" would wave a mass
    // delete straight through the guard. Fail the run instead.
    let stdout = stdout_rx
        .recv_timeout(PIPE_DRAIN_GRACE)
        .map_err(|_| {
            format!(
                "git {label} exited but its output could not be read within {}s \
                 (a helper process is still holding the pipe)",
                PIPE_DRAIN_GRACE.as_secs()
            )
        })?;
    // stderr is diagnostic only, so a stall there must not fail a command that
    // otherwise succeeded.
    let stderr = stderr_rx.recv_timeout(PIPE_DRAIN_GRACE).unwrap_or_default();

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Read a child pipe to EOF on its own thread and deliver the bytes over a
/// channel. The thread is deliberately never joined — see [`git_output`].
fn drain_pipe<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Poll a child to completion, killing it once `timeout` elapses. Extracted so
/// the kill path is testable against a child that genuinely blocks.
fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
    label: &str,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {label} timed out after {}s and was killed",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(GIT_POLL_INTERVAL);
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait for git {label}: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    use tempfile::TempDir;

    /// Serializes the tests that read or write process-global state — the
    /// `HQ_SYNC_DELETE_BULK_OVERRIDE` env var and the probe override slot.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn set_probe_override(value: Option<(bool, bool)>) {
        *PROBE_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }

    #[test]
    fn throttle_skips_within_interval_and_allows_after() {
        let now = Instant::now();
        // No prior mirror → never throttled.
        assert!(!should_skip_for_throttle(None, now));
        // A mirror that just happened → throttled.
        assert!(should_skip_for_throttle(Some(now), now));
        // Just under the interval → still throttled.
        let recent = now.checked_sub(MIN_MIRROR_INTERVAL - Duration::from_secs(1));
        if let Some(recent) = recent {
            assert!(should_skip_for_throttle(Some(recent), now));
        }
        // Past the interval → allowed.
        let old = now.checked_sub(MIN_MIRROR_INTERVAL + Duration::from_secs(1));
        if let Some(old) = old {
            assert!(!should_skip_for_throttle(Some(old), now));
        }
    }

    // ── B1: bulk-delete breaker ──────────────────────────────────────────

    #[test]
    fn bulk_verdict_allows_normal_change_sets() {
        // Nothing deleted.
        assert_eq!(bulk_delete_verdict(0, 100, false), BulkDeleteVerdict::Allow);
        // Under the absolute floor, even at a high ratio — ordinary cleanup of
        // a tiny repo must keep working.
        assert_eq!(bulk_delete_verdict(9, 20, false), BulkDeleteVerdict::Allow);
        assert_eq!(bulk_delete_verdict(1, 5, false), BulkDeleteVerdict::Allow);
        // Over the floor but a small slice of a large tree.
        assert_eq!(
            bulk_delete_verdict(50, 10_000, false),
            BulkDeleteVerdict::Allow
        );
    }

    #[test]
    fn bulk_verdict_refuses_when_both_thresholds_are_met() {
        // Exactly at both thresholds.
        assert_eq!(bulk_delete_verdict(10, 100, false), BulkDeleteVerdict::Refuse);
        assert_eq!(bulk_delete_verdict(50, 100, false), BulkDeleteVerdict::Refuse);
        // The reported incident's shape: 1,108 of ~4,347.
        assert_eq!(
            bulk_delete_verdict(1_108, 4_347, false),
            BulkDeleteVerdict::Refuse
        );
    }

    #[test]
    fn bulk_verdict_honors_the_operator_override() {
        assert_eq!(bulk_delete_verdict(1_108, 4_347, true), BulkDeleteVerdict::Allow);
    }

    #[test]
    fn bulk_verdict_allows_when_head_is_unborn() {
        assert_eq!(bulk_delete_verdict(10, 0, false), BulkDeleteVerdict::Allow);
    }

    #[test]
    fn bulk_override_parses_the_same_spellings_as_the_engine() {
        for truthy in ["1", "true", "TRUE", "Yes", " yes "] {
            assert!(parse_bulk_override(Some(truthy)), "{truthy} should be truthy");
        }
        for falsy in [None, Some(""), Some("0"), Some("false"), Some("no"), Some("on")] {
            assert!(!parse_bulk_override(falsy), "{falsy:?} should be falsy");
        }
    }

    #[test]
    fn counts_nul_terminated_records() {
        assert_eq!(count_nul_terminated(b""), 0);
        assert_eq!(count_nul_terminated(b"a\0"), 1);
        assert_eq!(count_nul_terminated(b"a\0b/c\0"), 2);
        // A path containing a newline is still one record.
        assert_eq!(count_nul_terminated(b"we\nird\0"), 1);
    }

    // ── B2: stale index.lock predicate ───────────────────────────────────

    fn lock_state(size: u64, age_secs: u64) -> IndexLockState {
        IndexLockState {
            exists: true,
            size_bytes: size,
            age: Some(Duration::from_secs(age_secs)),
            holder_present: false,
            git_process_running: false,
        }
    }

    #[test]
    fn reaps_only_a_zero_byte_unheld_aged_lock() {
        assert!(should_reap_index_lock(lock_state(0, 600), STALE_LOCK_MIN_AGE));
    }

    #[test]
    fn refuses_to_reap_anything_that_might_be_live() {
        // Missing lock.
        let missing = IndexLockState {
            exists: false,
            size_bytes: 0,
            age: None,
            holder_present: false,
            git_process_running: false,
        };
        assert!(!should_reap_index_lock(missing, STALE_LOCK_MIN_AGE));
        // Non-empty: a real writer has begun writing the new index.
        assert!(!should_reap_index_lock(lock_state(64, 600), STALE_LOCK_MIN_AGE));
        // Too fresh.
        assert!(!should_reap_index_lock(lock_state(0, 10), STALE_LOCK_MIN_AGE));
        // Someone holds the file open.
        let held = IndexLockState {
            holder_present: true,
            ..lock_state(0, 600)
        };
        assert!(!should_reap_index_lock(held, STALE_LOCK_MIN_AGE));
        // A git process is running.
        let git_running = IndexLockState {
            git_process_running: true,
            ..lock_state(0, 600)
        };
        assert!(!should_reap_index_lock(git_running, STALE_LOCK_MIN_AGE));
        // Unreadable mtime is "unknown", never "old enough".
        let unknown_age = IndexLockState {
            age: None,
            ..lock_state(0, 600)
        };
        assert!(!should_reap_index_lock(unknown_age, STALE_LOCK_MIN_AGE));
    }

    #[test]
    fn zero_min_age_still_requires_the_other_conjuncts() {
        // The failure path drops the age grace, nothing else.
        assert!(should_reap_index_lock(lock_state(0, 0), Duration::ZERO));
        assert!(!should_reap_index_lock(lock_state(64, 0), Duration::ZERO));
        let git_running = IndexLockState {
            git_process_running: true,
            ..lock_state(0, 0)
        };
        assert!(!should_reap_index_lock(git_running, Duration::ZERO));
    }

    // ── git-backed integration tests ─────────────────────────────────────

    fn git(dir: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available in test env")
    }

    fn init_repo(dir: &Path) {
        assert!(git(dir, &["init", "-q", "-b", "main"]).status.success());
        // Test env may have no global git identity; pin one locally so
        // `git commit` doesn't bail with "Please tell me who you are".
        assert!(git(dir, &["config", "user.email", "test@example.com"])
            .status
            .success());
        assert!(git(dir, &["config", "user.name", "hq-sync-test"])
            .status
            .success());
        // Disable any inherited commit hooks/templates — keep the test
        // environment hermetic regardless of the dev's global ~/.gitconfig.
        assert!(git(dir, &["config", "commit.gpgsign", "false"])
            .status
            .success());
    }

    fn rev_count(dir: &Path) -> usize {
        let out = git(dir, &["rev-list", "--count", "HEAD"]);
        if !out.status.success() {
            return 0;
        }
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    }

    fn index_is_clean(dir: &Path) -> bool {
        git(dir, &["diff", "--cached", "--quiet"]).status.success()
    }

    /// Seed `count` committed files so deletion ratios are meaningful.
    fn seed_repo(dir: &Path, count: usize) {
        init_repo(dir);
        for i in 0..count {
            fs::write(dir.join(format!("file-{i:04}.md")), format!("content {i}")).unwrap();
        }
        assert!(git(dir, &["add", "-A"]).status.success());
        assert!(git(dir, &["commit", "-q", "-m", "seed"]).status.success());
    }

    fn delete_files(dir: &Path, range: std::ops::Range<usize>) {
        for i in range {
            fs::remove_file(dir.join(format!("file-{i:04}.md"))).unwrap();
        }
    }

    /// `run_mirror` takes the resolved git directory; resolve it the same way
    /// production does so the tests exercise that path too.
    fn run_mirror_at(dir: &Path) -> Result<(), String> {
        let hq = dir.to_str().unwrap();
        let git_dir = resolve_git_dir(hq)?;
        run_mirror(hq, &git_dir)
    }

    fn git_dir_of(dir: &Path) -> PathBuf {
        resolve_git_dir(dir.to_str().unwrap()).expect("git dir resolves")
    }

    /// Most tests bypass `mirror_after_sync` and call `run_mirror` directly
    /// so the process-wide `MIRROR_LOCK` doesn't make parallel cargo-test
    /// threads race each other. The single test that does exercise the
    /// outer entry point only hits the no-`.git` early-return, which doesn't
    /// touch the lock.

    #[test]
    fn no_git_dir_is_noop() {
        let tmp = TempDir::new().unwrap();
        // Should not panic, should not create anything.
        mirror_after_sync(tmp.path().to_str().unwrap());
        assert!(!tmp.path().join(".git").exists());
    }

    #[test]
    fn no_changes_means_no_commit() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        // Seed an initial commit so HEAD exists.
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());

        let before = rev_count(tmp.path());
        run_mirror_at(tmp.path()).expect("mirror ok");
        let after = rev_count(tmp.path());
        assert_eq!(before, after, "no-change mirror must not add commits");
    }

    #[test]
    fn untracked_file_is_committed() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        fs::write(tmp.path().join("new-file.txt"), "hello").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");

        let after = rev_count(tmp.path());
        assert_eq!(after, before + 1, "expected exactly one new commit");

        let log_out = git(tmp.path(), &["log", "-1", "--pretty=%s"]);
        let subject = String::from_utf8_lossy(&log_out.stdout);
        assert!(
            subject.starts_with("hq-sync: "),
            "expected `hq-sync: <iso>` subject, got: {subject}"
        );
    }

    #[test]
    fn modified_tracked_file_is_committed() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let f = tmp.path().join("README");
        fs::write(&f, "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        fs::write(&f, "edited").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn no_upstream_means_commit_without_push() {
        // Pin the contract explicitly: with no remote configured, the
        // mirror still commits locally and reports success.
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        // No `git remote add`, no upstream branch.
        fs::write(tmp.path().join("x"), "y").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");
        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn pushes_to_configured_upstream() {
        let work = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        // Bare repo acts as the remote so `git push` has somewhere to land.
        assert!(Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("git available")
            .status
            .success());

        init_repo(work.path());
        let remote_url = remote.path().to_str().unwrap();
        assert!(git(work.path(), &["remote", "add", "origin", remote_url])
            .status
            .success());
        fs::write(work.path().join("README"), "seed").unwrap();
        assert!(git(work.path(), &["add", "-A"]).status.success());
        assert!(git(work.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        assert!(git(work.path(), &["push", "-q", "-u", "origin", "main"])
            .status
            .success());

        fs::write(work.path().join("new"), "data").unwrap();
        run_mirror_at(work.path()).expect("mirror ok");

        // Remote (bare repo) should now have the same HEAD as local.
        let local_head =
            String::from_utf8(git(work.path(), &["rev-parse", "HEAD"]).stdout).unwrap();
        let remote_head = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(remote.path())
                .args(["rev-parse", "main"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(local_head.trim(), remote_head.trim());
    }

    // ── B1 regression: the 2026-07-30 mass-deletion shape ────────────────

    #[test]
    fn mass_deletion_is_refused_and_the_index_is_left_clean() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());

        delete_files(tmp.path(), 0..50);
        run_mirror_at(tmp.path()).expect("mirror reports success");

        assert_eq!(
            rev_count(tmp.path()),
            before,
            "a 50%-of-tree deletion must not produce a commit"
        );
        assert!(
            index_is_clean(tmp.path()),
            "refusal must reset the index, not leave deletions staged"
        );
        // The working tree is the user's; refusing must not restore files.
        assert!(!tmp.path().join("file-0000.md").exists());
    }

    #[test]
    fn small_deletion_below_the_floor_still_commits() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());

        // 5 deletions: 5% of the tree and under the absolute floor.
        delete_files(tmp.path(), 0..5);
        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn override_env_lets_a_real_mass_deletion_through() {
        let _serial = serial();
        std::env::set_var(BULK_OVERRIDE_ENV, "1");

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());

        delete_files(tmp.path(), 0..50);
        let result = run_mirror_at(tmp.path());

        std::env::remove_var(BULK_OVERRIDE_ENV);
        result.expect("mirror ok");
        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn large_directory_move_is_not_read_as_deletion() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 40);
        let before = rev_count(tmp.path());

        // Move 30 of 40 files into a subdirectory. Content is preserved, so
        // rename detection must keep this out of the deletion count.
        let moved = tmp.path().join("moved");
        fs::create_dir(&moved).unwrap();
        for i in 0..30 {
            let name = format!("file-{i:04}.md");
            fs::rename(tmp.path().join(&name), moved.join(&name)).unwrap();
        }
        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "a content-preserving move must still be mirrored"
        );
    }

    // ── B2 regression: orphaned index.lock ───────────────────────────────

    #[test]
    fn stale_orphaned_lock_is_reaped_and_the_mirror_proceeds() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let before = rev_count(tmp.path());

        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"").unwrap();
        assert!(lock.exists());

        // The lock was just created, so simulate the age gate by asking as if
        // it were an hour from now rather than by rewriting its mtime.
        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            SystemTime::now() + Duration::from_secs(3600),
        );
        set_probe_override(None);

        assert!(reaped, "an empty, unheld, aged lock must be reaped");
        assert!(!lock.exists());

        fs::write(tmp.path().join("after-reap.md"), "content").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");
        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn fresh_lock_blocks_the_mirror_and_is_not_reaped() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let before = rev_count(tmp.path());

        let lock = index_lock_path(&git_dir_of(tmp.path()));
        fs::write(&lock, b"").unwrap();
        fs::write(tmp.path().join("blocked.md"), "content").unwrap();

        let result = run_mirror_at(tmp.path());
        set_probe_override(None);

        assert!(
            result.is_err(),
            "git add must fail while a live lock is present"
        );
        assert!(
            lock.exists(),
            "a lock younger than the grace period must survive"
        );
        assert_eq!(rev_count(tmp.path()), before);
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn nonempty_orphaned_lock_is_reported_but_never_removed() {
        let _serial = serial();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let state = read_index_lock_state(&lock, SystemTime::now() + Duration::from_secs(3600));
        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            SystemTime::now() + Duration::from_secs(3600),
        );
        set_probe_override(None);

        assert!(
            is_orphaned_but_nonempty(state, STALE_LOCK_MIN_AGE),
            "this is the state that gets escalated rather than reaped"
        );
        assert!(!reaped, "a non-empty lock must never be removed");
        assert!(lock.exists());
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn lock_paths_follow_a_linked_worktree() {
        // In a linked worktree `.git` is a file, so appending `.git/…` would
        // yield "Not a directory" and silently disable the mirror.
        let main = TempDir::new().unwrap();
        let trees = TempDir::new().unwrap();
        seed_repo(main.path(), 3);
        let wt = trees.path().join("wt");
        assert!(
            git(main.path(), &["worktree", "add", "-q", wt.to_str().unwrap()])
                .status
                .success()
        );
        assert!(wt.join(".git").is_file(), "expected a linked worktree");

        // Compared by trailing components, not prefix: macOS resolves the
        // tempdir's `/var` through a symlink to `/private/var`, so the
        // absolute prefix legitimately differs from `main.path()`.
        let git_dir = git_dir_of(&wt);
        assert!(
            git_dir.ends_with(Path::new("worktrees").join("wt")),
            "worktree git dir must resolve to the main repo's per-worktree dir, got {git_dir:?}"
        );
        assert!(
            git_dir.is_dir(),
            "the resolved git dir must be a real directory, not the `.git` file"
        );
        assert!(
            index_lock_path(&git_dir).parent() == Some(git_dir.as_path())
                && mirror_lock_path(&git_dir).parent() == Some(git_dir.as_path())
        );

        // And the mirror still works there.
        fs::write(wt.join("new.md"), "content").unwrap();
        let before = rev_count(&wt);
        run_mirror_at(&wt).expect("mirror ok in a linked worktree");
        assert_eq!(rev_count(&wt), before + 1);
    }

    #[test]
    fn mirror_lock_is_exclusive_across_holders_and_released_on_drop() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let path = mirror_lock_path(&git_dir_of(tmp.path()));

        let first = try_acquire_mirror_lock(&path).unwrap();
        assert!(first.is_some(), "first acquirer must win the lock");
        assert!(
            try_acquire_mirror_lock(&path).unwrap().is_none(),
            "a second acquirer must be told to skip, not block"
        );

        drop(first);
        assert!(
            try_acquire_mirror_lock(&path).unwrap().is_some(),
            "the lock must be released when the guard drops"
        );
    }

    #[test]
    fn a_child_that_outruns_its_timeout_is_killed() {
        // `git hash-object --stdin` blocks until stdin reaches EOF. Holding
        // the write end open makes the child genuinely hang, so the timeout
        // branch is exercised without depending on machine speed.
        let mut child = Command::new("git")
            .args(["hash-object", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("git available in test env");
        let _stdin = child.stdin.take().expect("piped stdin");

        let err = wait_with_timeout(&mut child, Duration::from_millis(200), "hash-object --stdin")
            .expect_err("a blocked child must time out");

        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(
            child.try_wait().expect("try_wait").is_some(),
            "the timed-out child must have been killed and reaped"
        );
    }
}
