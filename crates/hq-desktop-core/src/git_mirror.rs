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

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

/// A still-broken working tree must remain visible to triage, but reporting it
/// every mirror pass turns one actionable condition into an event flood. This
/// keeps a sustained refusal to one banner every six hours **per HQ root**.
const REFUSAL_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);

/// How many refusing passes an episode needs before it earns a Sentry event.
///
/// A single refusing pass is the dominant field shape and the least actionable:
/// the mirror samples the tree mid-sync, between a delete and its restore, and
/// the next pass is clean. [`MIN_MIRROR_INTERVAL`] already spaces passes at
/// least 60s apart, so a condition that is actually real is confirmed within
/// about a minute. Every refusal — confirmed or not — is still logged in full
/// on the machine it happened on; only the Sentry channel waits.
const REFUSAL_CONFIRM_OCCURRENCES: usize = 2;

/// An episode with no refusing pass for this long is over — its root either
/// recovered without the mirror observing it, or stopped being mirrored at all.
///
/// Deliberately longer than [`REFUSAL_COOLDOWN`]: a live episode refuses about
/// once a minute, so this only ever collects abandoned entries, and the slack
/// guarantees an episode can never be dropped at the very moment its cooldown
/// re-arms (which would silently restart its confirmation gate instead).
const REFUSAL_EPISODE_IDLE_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// Ceiling on the depth-1 prefix histogram carried by a report, so a
/// pathologically wide tree cannot inflate the payload.
const REFUSAL_PREFIX_CAP: usize = 10;

/// Deletions sitting directly at the repository root have no directory prefix.
/// They are counted under this sentinel rather than under their own file name,
/// which would be exactly the user data the payload must not carry.
const ROOT_PREFIX_LABEL: &str = "<root>";

/// One contiguous run of refusing mirror passes for a single HQ root.
///
/// The deletion digest is episode **data**, never part of the suppression key.
/// Keying suppression on the digest (the first fix) meant a churning tree minted
/// a never-before-seen key almost every pass — and a new key only had to clear a
/// five-minute floor, so the flood came back one event per five minutes.
#[derive(Debug, Clone)]
struct RefusalEpisode {
    opened_at: Instant,
    last_refusal_at: Instant,
    occurrences: usize,
    distinct_sets: usize,
    last_digest: String,
    suppressed_since_report: usize,
    reported_at: Option<Instant>,
}

/// Open refusal episodes, one per HQ root. A root that has not refused for a
/// full [`REFUSAL_EPISODE_IDLE_TTL`] has its entry dropped, so a long-lived app
/// cannot grow this without bound. That TTL is deliberately longer than the
/// cooldown — pruning on the cooldown would drop an episode at the very moment
/// it re-arms. Recover a poisoned lock so this observability path can never
/// wedge the detached mirror thread.
static REFUSAL_EPISODES: LazyLock<Mutex<HashMap<String, RefusalEpisode>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Name of the per-root episode record. It lives inside the *resolved git
/// directory*, beside this module's own `hq-sync-mirror.lock` — so `git add -A`
/// can never see it, and it can never feed back into the very deletion
/// accounting it describes.
const REFUSAL_STATE_FILE: &str = "hq-sync-mirror-refusal.json";

/// The slice of refusal state that has to outlive the process.
///
/// The first fix kept all of it in memory, on the reasoning that "an app restart
/// should re-arm the first banner". On a fleet that shipped twelve releases in
/// four days, that meant every auto-update re-armed every wedged install — which
/// is what kept reopening the issue. Reversing that choice is the point.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedRefusalState {
    /// Wall clock, RFC3339: the cooldown anchor that survives a restart.
    last_reported_at: String,
    /// Snapshot of the episode that produced that report. Forensic only — it
    /// never feeds the suppression decision.
    episode_opened_at: String,
    occurrences: usize,
    distinct_sets: usize,
}

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

/// Staged deletions and a stable identity for their path set. The digest is
/// deliberately independent of the tracked-file denominator: that value can
/// drift when another writer commits, even when the missing paths are unchanged.
#[derive(Debug, PartialEq, Eq)]
struct StagedDeletions {
    count: usize,
    digest: String,
    /// Depth-1 prefixes of the missing paths, most-frequent first and capped at
    /// [`REFUSAL_PREFIX_CAP`].
    prefixes: Vec<(String, usize)>,
    /// How many distinct prefixes existed *before* the cap, so a truncated
    /// histogram can never be misread as a complete one.
    prefix_groups: usize,
}

/// Bound on a single rendered prefix, so one absurdly long directory name
/// cannot dominate the payload.
const PREFIX_LABEL_MAX_CHARS: usize = 64;

/// Depth-1 path prefixes of a NUL-terminated Git path record set, ranked
/// most-frequent first and capped. Returns `(ranked, distinct_before_cap)`.
///
/// Depth 1 **only**, deliberately: `companies/<slug>/<file>` renders as
/// `companies`, so the payload carries the *shape* of the loss — which subtree
/// went missing — without carrying a company slug, a file name, or any path
/// separator. That is the distinction three triage rounds have lacked, at the
/// only granularity that is safe to ship.
fn deletion_prefixes(records: &[u8]) -> (Vec<(String, usize)>, usize) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for path in records.split(|byte| *byte == 0).filter(|p| !p.is_empty()) {
        // Git spells the separator `/` in its own output on every platform.
        let label = match path.iter().position(|byte| *byte == b'/') {
            Some(0) | None => ROOT_PREFIX_LABEL.to_string(),
            Some(index) => String::from_utf8_lossy(&path[..index])
                .chars()
                .take(PREFIX_LABEL_MAX_CHARS)
                .collect(),
        };
        *counts.entry(label).or_insert(0) += 1;
    }
    let distinct = counts.len();
    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    // Count descending, then name ascending, so the payload is deterministic.
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(REFUSAL_PREFIX_CAP);
    (ranked, distinct)
}

/// Hash NUL-terminated Git path records after sorting their raw bytes. Git
/// permits non-UTF-8 paths, so hashing bytes rather than strings preserves the
/// exact deletion-set identity; the NUL separator keeps adjacent paths distinct.
fn deletion_set_digest(records: &[u8]) -> String {
    let mut paths: Vec<&[u8]> = records
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    paths.sort_unstable();

    let mut hasher = Sha256::new();
    for path in paths {
        hasher.update(path);
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

/// What a refusal should do about the Sentry channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefusalReportAction {
    /// Too few refusing passes so far — this still looks like a transient
    /// mid-sync sample, so it stays in the local log only.
    AwaitConfirmation,
    /// Confirmed, but this root is inside its cooldown.
    Suppress,
    /// The first report of this episode.
    ReportFirstConfirmed,
    /// A sustained episode whose cooldown has now expired.
    ReportCooldownRearm,
}

impl RefusalReportAction {
    fn emits(self) -> bool {
        matches!(
            self,
            RefusalReportAction::ReportFirstConfirmed | RefusalReportAction::ReportCooldownRearm
        )
    }

    /// Tag value, so triage can tell a fresh condition from a still-wedged one.
    fn source(self) -> &'static str {
        match self {
            RefusalReportAction::ReportCooldownRearm => "cooldown-rearm",
            _ => "first-confirmed",
        }
    }
}

/// Pure refusal-report decision, over one HQ root's episode.
///
/// `since_last_report` is the elapsed time since the *later* of this root's two
/// report anchors — the in-process monotonic one and the persisted wall-clock
/// one — so neither an app restart nor a wall clock that moved can shorten the
/// cooldown. Note what is deliberately absent: the deletion digest. A refusing
/// tree churns, and keying on the churn is what produced the flood.
fn decide_refusal_report(
    occurrences: usize,
    already_reported_in_episode: bool,
    since_last_report: Option<Duration>,
    confirm_after: usize,
    cooldown: Duration,
) -> RefusalReportAction {
    if occurrences < confirm_after {
        return RefusalReportAction::AwaitConfirmation;
    }
    match since_last_report {
        None => RefusalReportAction::ReportFirstConfirmed,
        Some(elapsed) if elapsed >= cooldown => {
            if already_reported_in_episode {
                RefusalReportAction::ReportCooldownRearm
            } else {
                RefusalReportAction::ReportFirstConfirmed
            }
        }
        Some(_) => RefusalReportAction::Suppress,
    }
}

/// Elapsed wall-clock time since a persisted stamp.
///
/// `None` for a stamp dated in the future — a clock that moved backwards, a
/// timezone/DST jump, or a copied `.git` must **re-arm** the banner rather than
/// latch it silent. Re-arming costs one extra event; latching loses the signal.
fn elapsed_since_wall(reported_at: DateTime<Utc>, now: DateTime<Utc>) -> Option<Duration> {
    now.signed_duration_since(reported_at).to_std().ok()
}

/// The later of two report anchors is the *smaller* elapsed time. Expressed
/// this way because a monotonic `Instant` and a wall-clock `DateTime` cannot be
/// compared directly — only their distances from "now" can.
fn later_report_elapsed(
    in_memory: Option<Duration>,
    persisted: Option<Duration>,
) -> Option<Duration> {
    match (in_memory, persisted) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

fn refusal_state_path(git_dir: &Path) -> PathBuf {
    git_dir.join(REFUSAL_STATE_FILE)
}

/// Wall-clock stamp of this root's last report, or `None` when there is no
/// usable one.
///
/// Missing, unreadable, unparsable and future-dated records all resolve to
/// `None` — i.e. treat the cooldown as re-armed. Every failure is logged and
/// swallowed: the mirror must never fail or stall because an observability file
/// went bad.
fn read_persisted_report_at(git_dir: &Path, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let path = refusal_state_path(git_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => {
            if err.kind() != ErrorKind::NotFound {
                log(
                    LOG_TAG,
                    &format!(
                        "could not read {}: {err} — treating the refusal cooldown as re-armed",
                        path.display()
                    ),
                );
            }
            return None;
        }
    };
    let parsed: PersistedRefusalState = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            log(
                LOG_TAG,
                &format!(
                    "{} is not readable refusal state ({err}) — treating the cooldown as re-armed",
                    path.display()
                ),
            );
            return None;
        }
    };
    let reported_at = match DateTime::parse_from_rfc3339(&parsed.last_reported_at) {
        Ok(at) => at.with_timezone(&Utc),
        Err(err) => {
            log(
                LOG_TAG,
                &format!(
                    "{} carries an unparsable timestamp {:?} ({err}) — treating the cooldown as \
                     re-armed",
                    path.display(),
                    parsed.last_reported_at
                ),
            );
            return None;
        }
    };
    // A stamp from the future means the clock moved backwards, a DST/timezone
    // jump, or a copied `.git`. Re-arm rather than latch silent for what could
    // be years.
    if elapsed_since_wall(reported_at, now).is_none() {
        log(
            LOG_TAG,
            &format!(
                "{} is dated in the future ({}) — treating the cooldown as re-armed",
                path.display(),
                parsed.last_reported_at
            ),
        );
        return None;
    }
    Some(reported_at)
}

/// Persist this root's report anchor via a same-directory temp file plus an
/// atomic rename, so a crash or a second process can never observe a torn
/// record. Callers hold the cross-process mirror lock, which is what makes the
/// fixed temp file name safe.
///
/// Best-effort throughout: failing to persist costs exactly one re-armed banner.
fn write_persisted_report_at(git_dir: &Path, state: &PersistedRefusalState) {
    let path = refusal_state_path(git_dir);
    let temp = git_dir.join(format!("{REFUSAL_STATE_FILE}.tmp"));
    let encoded = match serde_json::to_string(state) {
        Ok(encoded) => encoded,
        Err(err) => {
            log(LOG_TAG, &format!("could not encode refusal state: {err}"));
            return;
        }
    };
    if let Err(err) = fs::write(&temp, encoded) {
        log(
            LOG_TAG,
            &format!("could not stage {}: {err}", temp.display()),
        );
        return;
    }
    if let Err(err) = fs::rename(&temp, &path) {
        log(
            LOG_TAG,
            &format!("could not publish {}: {err}", path.display()),
        );
        let _ = fs::remove_file(&temp);
    }
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
    let staged = git_output(
        hq_folder,
        &["diff", "--cached", "--quiet"],
        GIT_INDEX_TIMEOUT,
    )?;
    match staged.status.code() {
        Some(0) => {
            log(LOG_TAG, &format!("{hq_folder}: nothing to commit"));
            // A clean pass ends any refusal episode: the condition was
            // transient, so the next one deserves its own confirmation.
            note_mirror_recovered(hq_folder);
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

    if guard_bulk_deletions(hq_folder, git_dir)? == BulkDeleteVerdict::Refuse {
        return Ok(());
    }

    // ISO-8601 to the second; sortable in `git log` without quoting issues.
    let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let msg = format!("hq-sync: {now_iso}");
    run_git(hq_folder, &["commit", "-m", &msg], GIT_INDEX_TIMEOUT)?;
    log(LOG_TAG, &format!("{hq_folder}: committed \"{msg}\""));
    // The mirror committed, so this root is healthy again.
    note_mirror_recovered(hq_folder);

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
fn guard_bulk_deletions(hq_folder: &str, git_dir: &Path) -> Result<BulkDeleteVerdict, String> {
    let deletions = count_staged_deletions(hq_folder)?;
    if deletions.count == 0 {
        return Ok(BulkDeleteVerdict::Allow);
    }
    let tracked = count_tracked_at_head(hq_folder)?;
    let override_on = is_bulk_override_set();
    let verdict = bulk_delete_verdict(deletions.count, tracked, override_on);

    if verdict == BulkDeleteVerdict::Allow {
        if override_on && deletions.count >= BULK_ASYMMETRY_MIN_ABS {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: {BULK_OVERRIDE_ENV} is set — committing {} \
                     deletions of {tracked} tracked files without the volume check",
                    deletions.count
                ),
            );
        }
        return Ok(verdict);
    }

    let percent = (deletions.count as f64 / tracked as f64 * 100.0).round() as u64;
    let reason = format!(
        "{hq_folder}: REFUSING to mirror — {} of {tracked} tracked files \
         ({percent}%) are staged as deletions, at or over the {}% / {} bulk-delete \
         threshold. This is what a partial restore, an interrupted pull, a moved HQ \
         folder or an unmounted volume looks like — not a cleanup. Nothing was \
         committed or pushed. If the deletions are real, re-run with \
         {BULK_OVERRIDE_ENV}=1.",
        deletions.count,
        (BULK_ASYMMETRY_RATIO * 100.0) as u64,
        BULK_ASYMMETRY_MIN_ABS,
    );
    log(LOG_TAG, &reason);
    report_bulk_refusal(&RefusalReport {
        hq_folder,
        git_dir,
        deletions: &deletions,
        tracked,
        has_upstream: repo_has_upstream(hq_folder),
    });

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

/// Everything one refusing pass knows about itself. Grouped so the reporter's
/// signature stays readable as the evidence set grows.
struct RefusalReport<'a> {
    hq_folder: &'a str,
    /// Resolved git directory — where this root's episode record lives.
    git_dir: &'a Path,
    deletions: &'a StagedDeletions,
    tracked: usize,
    has_upstream: bool,
}

/// What the reporter decided, lifted out of the state lock so no Sentry work
/// happens while the episode map is held.
struct RefusalOutcome {
    action: RefusalReportAction,
    occurrences: usize,
    distinct_sets: usize,
    suppressed_since_report: usize,
    episode_age: Duration,
    since_last_report: Option<Duration>,
    episode_opened_at_wall: DateTime<Utc>,
}

/// One banner-grade signal per HQ root per [`REFUSAL_COOLDOWN`]. B1 was found by
/// reading `git log` after the fact, so a refusal nobody hears about repeats
/// that — but a *sustained* refusal must not capture a new event per mirror
/// pass, per churned deletion set, or per app restart.
fn report_bulk_refusal(report: &RefusalReport<'_>) {
    report_bulk_refusal_at(report, Instant::now(), Utc::now());
}

/// Returns whether an event was captured. Both clocks are injected so the gate
/// is testable across a six-hour cooldown without waiting six hours.
fn report_bulk_refusal_at(
    report: &RefusalReport<'_>,
    now: Instant,
    wall_now: DateTime<Utc>,
) -> bool {
    // Read the persisted anchor before taking the lock: it is file I/O, and the
    // episode map must never be held across it.
    let persisted_report_at = read_persisted_report_at(report.git_dir, wall_now);

    let outcome = {
        let mut episodes = REFUSAL_EPISODES
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Collect abandoned episodes so a long-lived app cannot grow this map.
        episodes.retain(|_, episode| {
            now.duration_since(episode.last_refusal_at) < REFUSAL_EPISODE_IDLE_TTL
        });

        let episode = episodes
            .entry(report.hq_folder.to_string())
            .or_insert_with(|| RefusalEpisode {
                opened_at: now,
                last_refusal_at: now,
                occurrences: 0,
                distinct_sets: 0,
                last_digest: String::new(),
                suppressed_since_report: 0,
                reported_at: None,
            });

        episode.last_refusal_at = now;
        episode.occurrences += 1;
        // A changed path set is recorded as evidence about this episode — it is
        // explicitly *not* a new condition deserving its own banner.
        if episode.distinct_sets == 0 || episode.last_digest != report.deletions.digest {
            episode.distinct_sets += 1;
            episode.last_digest.clone_from(&report.deletions.digest);
        }

        let since_last_report = later_report_elapsed(
            episode.reported_at.map(|at| now.duration_since(at)),
            persisted_report_at.and_then(|at| elapsed_since_wall(at, wall_now)),
        );
        let action = decide_refusal_report(
            episode.occurrences,
            episode.reported_at.is_some(),
            since_last_report,
            REFUSAL_CONFIRM_OCCURRENCES,
            REFUSAL_COOLDOWN,
        );

        let episode_age = now.duration_since(episode.opened_at);
        let suppressed_since_report = if action.emits() {
            let suppressed = episode.suppressed_since_report;
            episode.reported_at = Some(now);
            episode.suppressed_since_report = 0;
            suppressed
        } else {
            episode.suppressed_since_report += 1;
            episode.suppressed_since_report
        };

        RefusalOutcome {
            action,
            occurrences: episode.occurrences,
            distinct_sets: episode.distinct_sets,
            suppressed_since_report,
            episode_age,
            since_last_report,
            // The wall-clock instant this episode opened, reconstructed from its
            // monotonic age. Persisted as forensic context only.
            episode_opened_at_wall: wall_now
                - chrono::Duration::from_std(episode_age)
                    .unwrap_or_else(|_| chrono::Duration::zero()),
        }
    };

    let hq_folder = report.hq_folder;
    if !outcome.action.emits() {
        match outcome.action {
            RefusalReportAction::AwaitConfirmation => log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: refusal not yet confirmed (pass {} of {REFUSAL_CONFIRM_OCCURRENCES}); \
                     holding the Sentry banner in case the next pass is clean",
                    outcome.occurrences
                ),
            ),
            _ => log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: refusal already reported {}s ago; suppressing duplicate Sentry \
                     event ({} refusals since last report, {} distinct deletion set(s) this episode)",
                    outcome
                        .since_last_report
                        .map(|elapsed| elapsed.as_secs())
                        .unwrap_or(0),
                    outcome.suppressed_since_report,
                    outcome.distinct_sets
                ),
            ),
        }
        return false;
    }

    let deletion_set_stable = outcome.distinct_sets <= 1;
    let prefixes: serde_json::Map<String, serde_json::Value> = report
        .deletions
        .prefixes
        .iter()
        .map(|(prefix, count)| (prefix.clone(), serde_json::Value::from(*count)))
        .collect();

    sentry::with_scope(
        |scope| {
            scope.set_tag("git_mirror_kind", "bulk-delete-refused");
            scope.set_tag("deletions", report.deletions.count.to_string());
            scope.set_tag("tracked", report.tracked.to_string());
            scope.set_tag(
                "refusals_since_last_report",
                outcome.suppressed_since_report.to_string(),
            );
            // Is the same part of the tree missing every pass? A stable set on a
            // hours-old episode is a wedged mirror and a real deletion; an
            // unstable set on a young episode is a mid-sync sample.
            scope.set_tag("deletion_set_stable", deletion_set_stable.to_string());
            scope.set_tag("distinct_deletion_sets", outcome.distinct_sets.to_string());
            scope.set_tag("episode_occurrences", outcome.occurrences.to_string());
            scope.set_tag(
                "episode_age_secs",
                outcome.episode_age.as_secs().to_string(),
            );
            scope.set_tag(
                "since_last_report_secs",
                outcome
                    .since_last_report
                    .map(|elapsed| elapsed.as_secs().to_string())
                    .unwrap_or_else(|| "never".to_string()),
            );
            scope.set_tag("report_source", outcome.action.source());
            // A refusing root with no upstream is only losing local history; one
            // with an upstream has silently stopped publishing.
            scope.set_tag("has_upstream", report.has_upstream.to_string());
            scope.set_extra("deletion_prefixes", serde_json::Value::Object(prefixes));
            scope.set_extra(
                "deletion_prefix_groups",
                serde_json::Value::from(report.deletions.prefix_groups),
            );
        },
        || {
            sentry::capture_message(
                "[git-mirror] refused to commit a bulk deletion of the HQ folder",
                sentry::Level::Warning,
            );
        },
    );

    write_persisted_report_at(
        report.git_dir,
        &PersistedRefusalState {
            last_reported_at: wall_now.to_rfc3339_opts(SecondsFormat::Secs, true),
            episode_opened_at: outcome
                .episode_opened_at_wall
                .to_rfc3339_opts(SecondsFormat::Secs, true),
            occurrences: outcome.occurrences,
            distinct_sets: outcome.distinct_sets,
        },
    );
    true
}

/// Close this root's refusal episode.
///
/// Called from every non-refusing exit of [`run_mirror`], so an episode spans a
/// contiguous run of refusing passes and a healthy tree resets the lane. The
/// *persisted* cooldown anchor is deliberately left in place: a tree that flaps
/// between refusing and healthy must not earn a fresh banner on every flap.
fn note_mirror_recovered(hq_folder: &str) {
    let mut episodes = REFUSAL_EPISODES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(episode) = episodes.remove(hq_folder) {
        log(
            LOG_TAG,
            &format!(
                "{hq_folder}: mirror recovered — closing refusal episode after {} refusing pass(es) \
                 across {} distinct deletion set(s)",
                episode.occurrences, episode.distinct_sets
            ),
        );
    }
}

/// Whether the current branch has a tracked upstream.
///
/// Unlike the commit path's check, a failure here resolves to `false` rather
/// than aborting: this only annotates a report, and an observability probe must
/// never turn into a mirror failure.
fn repo_has_upstream(hq_folder: &str) -> bool {
    git_output(
        hq_folder,
        &["rev-parse", "--abbrev-ref", "@{u}"],
        GIT_INDEX_TIMEOUT,
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
}

/// Staged deletions, rename-aware. `-M` matters: a large directory move is
/// content-preserving and must not read as a mass delete.
fn count_staged_deletions(hq_folder: &str) -> Result<StagedDeletions, String> {
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
    let (prefixes, prefix_groups) = deletion_prefixes(&out.stdout);
    Ok(StagedDeletions {
        count: count_nul_terminated(&out.stdout),
        digest: deletion_set_digest(&out.stdout),
        prefixes,
        prefix_groups,
    })
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
    let stdout = stdout_rx.recv_timeout(PIPE_DRAIN_GRACE).map_err(|_| {
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

    /// Drop every in-memory episode. Also stands in for an app relaunch: the
    /// process-local state is gone, whatever is on disk is not.
    fn reset_refusal_report_state() {
        REFUSAL_EPISODES
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    /// A deletion set with the shape the reporter needs, without a git repo.
    fn staged(digest: &str, count: usize, records: &[u8]) -> StagedDeletions {
        let (prefixes, prefix_groups) = deletion_prefixes(records);
        StagedDeletions {
            count,
            digest: digest.to_string(),
            prefixes,
            prefix_groups,
        }
    }

    /// Drive one refusing pass through the reporter at an injected instant.
    /// `wall_now` only matters where a persisted stamp is in play.
    fn refuse_at(
        hq_folder: &str,
        git_dir: &Path,
        deletions: &StagedDeletions,
        tracked: usize,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> bool {
        report_bulk_refusal_at(
            &RefusalReport {
                hq_folder,
                git_dir,
                deletions,
                tracked,
                has_upstream: true,
            },
            now,
            wall_now,
        )
    }

    /// A scratch git dir for the persisted episode record. The reporter only
    /// ever reads and writes a file there, so a plain directory is enough.
    /// `name` keeps two roots in one test genuinely independent — sharing a git
    /// dir would (correctly) mean sharing a cooldown.
    fn scratch_git_dir(tmp: &TempDir, name: &str) -> PathBuf {
        let dir = tmp.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn epoch() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-06T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
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

    /// Replaces the r1 predicate test. That predicate re-armed on a
    /// never-before-seen deletion digest after only `REFUSAL_MIN_SPACING`, which
    /// is the escape hatch the production flood came through; the digest is no
    /// longer an input at all.
    #[test]
    fn refusal_gate_confirms_first_then_holds_one_banner_per_cooldown() {
        let confirm = REFUSAL_CONFIRM_OCCURRENCES;
        let cooldown = REFUSAL_COOLDOWN;

        // A single refusing pass is a candidate, not a signal.
        assert_eq!(
            decide_refusal_report(1, false, None, confirm, cooldown),
            RefusalReportAction::AwaitConfirmation
        );
        // The second confirms it.
        assert_eq!(
            decide_refusal_report(2, false, None, confirm, cooldown),
            RefusalReportAction::ReportFirstConfirmed
        );
        // Everything after it, however long the episode runs, is suppressed…
        assert_eq!(
            decide_refusal_report(3, true, Some(Duration::from_secs(1)), confirm, cooldown),
            RefusalReportAction::Suppress
        );
        assert_eq!(
            decide_refusal_report(
                9_999,
                true,
                Some(cooldown - Duration::from_secs(1)),
                confirm,
                cooldown
            ),
            RefusalReportAction::Suppress
        );
        // …until the cooldown expires, which re-arms exactly one banner.
        assert_eq!(
            decide_refusal_report(9_999, true, Some(cooldown), confirm, cooldown),
            RefusalReportAction::ReportCooldownRearm
        );
        // A fresh episode whose root reported recently (a restart, or a tree
        // that flapped) still waits out that root's cooldown.
        assert_eq!(
            decide_refusal_report(2, false, Some(Duration::from_secs(30)), confirm, cooldown),
            RefusalReportAction::Suppress
        );
        assert_eq!(
            decide_refusal_report(2, false, Some(cooldown), confirm, cooldown),
            RefusalReportAction::ReportFirstConfirmed
        );
    }

    #[test]
    fn cooldown_anchors_to_the_more_recent_of_the_two_clocks() {
        let five_min = Duration::from_secs(300);
        let one_hour = Duration::from_secs(3_600);

        assert_eq!(later_report_elapsed(None, None), None);
        assert_eq!(later_report_elapsed(Some(five_min), None), Some(five_min));
        assert_eq!(later_report_elapsed(None, Some(one_hour)), Some(one_hour));
        // Smaller elapsed == later report: a restart cannot shorten a cooldown
        // by presenting an empty in-memory anchor, and a stale persisted anchor
        // cannot extend one past a live in-process report.
        assert_eq!(
            later_report_elapsed(Some(one_hour), Some(five_min)),
            Some(five_min)
        );
        assert_eq!(
            later_report_elapsed(Some(five_min), Some(one_hour)),
            Some(five_min)
        );
    }

    #[test]
    fn a_future_dated_stamp_rearms_rather_than_latching_silent() {
        let now = epoch();
        assert_eq!(
            elapsed_since_wall(now - chrono::Duration::seconds(90), now),
            Some(Duration::from_secs(90))
        );
        assert_eq!(elapsed_since_wall(now, now), Some(Duration::ZERO));
        // A clock that moved backwards, a DST jump, or a copied `.git`.
        assert_eq!(
            elapsed_since_wall(now + chrono::Duration::hours(9), now),
            None,
            "a stamp from the future must be treated as absent"
        );
    }

    #[test]
    fn deletion_prefixes_are_depth_one_ranked_and_capped() {
        let mut records = Vec::new();
        for i in 0..5 {
            records.extend_from_slice(format!("companies/acme-corp/notes/{i}.md\0").as_bytes());
        }
        records.extend_from_slice(b"repos/private/thing/src/main.rs\0");
        records.extend_from_slice(b"repos/public/other/lib.rs\0");
        records.extend_from_slice(b"README.md\0");

        let (ranked, distinct) = deletion_prefixes(&records);
        assert_eq!(distinct, 3);
        assert_eq!(
            ranked,
            vec![
                ("companies".to_string(), 5),
                ("repos".to_string(), 2),
                (ROOT_PREFIX_LABEL.to_string(), 1),
            ],
            "depth-1 segments only, most-frequent first; a root-level file must \
             never render as its own name"
        );

        // Wider than the cap: the histogram truncates but the distinct count
        // still tells the truth about how much was dropped.
        let mut wide = Vec::new();
        for i in 0..25 {
            wide.extend_from_slice(format!("dir-{i:02}/file.md\0").as_bytes());
        }
        let (capped, wide_distinct) = deletion_prefixes(&wide);
        assert_eq!(capped.len(), REFUSAL_PREFIX_CAP);
        assert_eq!(wide_distinct, 25);
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
        assert_eq!(
            bulk_delete_verdict(10, 100, false),
            BulkDeleteVerdict::Refuse
        );
        assert_eq!(
            bulk_delete_verdict(50, 100, false),
            BulkDeleteVerdict::Refuse
        );
        // The reported incident's shape: 1,108 of ~4,347.
        assert_eq!(
            bulk_delete_verdict(1_108, 4_347, false),
            BulkDeleteVerdict::Refuse
        );
    }

    #[test]
    fn bulk_verdict_honors_the_operator_override() {
        assert_eq!(
            bulk_delete_verdict(1_108, 4_347, true),
            BulkDeleteVerdict::Allow
        );
    }

    #[test]
    fn bulk_verdict_allows_when_head_is_unborn() {
        assert_eq!(bulk_delete_verdict(10, 0, false), BulkDeleteVerdict::Allow);
    }

    #[test]
    fn bulk_override_parses_the_same_spellings_as_the_engine() {
        for truthy in ["1", "true", "TRUE", "Yes", " yes "] {
            assert!(
                parse_bulk_override(Some(truthy)),
                "{truthy} should be truthy"
            );
        }
        for falsy in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("on"),
        ] {
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

    #[test]
    fn deletion_set_digest_is_order_independent_but_path_sensitive() {
        let first = deletion_set_digest(b"alpha.md\0nested/beta.md\0");
        let reordered = deletion_set_digest(b"nested/beta.md\0alpha.md\0");
        let changed = deletion_set_digest(b"alpha.md\0nested/gamma.md\0");

        // The digest is now episode *evidence* (it drives `distinct_deletion_
        // sets` / `deletion_set_stable`), not a suppression key — so it must
        // still identify a path set exactly, and still ignore git's ordering.
        assert_eq!(
            first, reordered,
            "git output ordering must not read as a changed condition"
        );
        assert_ne!(
            first, changed,
            "a changed deleted-path set must be visible as churn"
        );
    }

    #[test]
    fn confirmed_episode_reports_exactly_once_then_suppresses() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let set = staged("set-a", 50, b"companies/acme/a.md\0");
        let start = Instant::now();
        let wall = epoch();

        let events = sentry::test::with_captured_events(|| {
            for pass in 0..6u64 {
                refuse_at(
                    "/hq",
                    &git_dir,
                    &set,
                    100,
                    start + Duration::from_secs(pass * 60),
                    wall + chrono::Duration::seconds((pass * 60) as i64),
                );
            }
        });
        reset_refusal_report_state();

        assert_eq!(
            events.len(),
            1,
            "a sustained episode is one banner, however many passes it runs for"
        );
        assert_eq!(
            events[0].tags.get("report_source").map(String::as_str),
            Some("first-confirmed")
        );
        assert_eq!(
            events[0]
                .tags
                .get("episode_occurrences")
                .map(String::as_str),
            Some("2"),
            "the banner fires on the confirming pass, not the first sample"
        );
        assert_eq!(
            events[0]
                .tags
                .get("refusals_since_last_report")
                .map(String::as_str),
            Some("1"),
            "the unconfirmed first pass is counted as suppressed, not lost"
        );
    }

    #[test]
    fn a_sustained_episode_rearms_one_banner_per_cooldown() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let set = staged("set-a", 50, b"companies/acme/a.md\0");
        let start = Instant::now();
        let wall = epoch();

        let events = sentry::test::with_captured_events(|| {
            refuse_at("/hq", &git_dir, &set, 100, start, wall);
            refuse_at(
                "/hq",
                &git_dir,
                &set,
                100,
                start + Duration::from_secs(60),
                wall + chrono::Duration::seconds(60),
            );
            // Four more refusing passes inside the cooldown. They emit nothing,
            // but they must be *counted* — the rearm event is the only place
            // triage learns how wedged this root was while it stayed quiet.
            for pass in 2..=5u64 {
                refuse_at(
                    "/hq",
                    &git_dir,
                    &set,
                    100,
                    start + Duration::from_secs(pass * 60),
                    wall + chrono::Duration::seconds((pass * 60) as i64),
                );
            }
            // Still wedged six hours later.
            refuse_at(
                "/hq",
                &git_dir,
                &set,
                100,
                start + Duration::from_secs(60) + REFUSAL_COOLDOWN,
                wall + chrono::Duration::seconds(60) + chrono::Duration::hours(6),
            );
        });
        reset_refusal_report_state();

        assert_eq!(events.len(), 2, "one banner per cooldown, not none");
        assert_eq!(
            events[1].tags.get("report_source").map(String::as_str),
            Some("cooldown-rearm")
        );
        assert_eq!(
            events[1]
                .tags
                .get("since_last_report_secs")
                .map(String::as_str),
            Some(REFUSAL_COOLDOWN.as_secs().to_string().as_str())
        );
        // Restores the coverage the r1 test `reported_refusal_carries_the_
        // suppressed_occurrence_count` held before this change deleted it: the
        // counter accumulates every suppressed pass and resets on each report.
        // Without the reset the rearm would read 5 (the unconfirmed pass plus
        // the four suppressed ones); without the accumulation it would read 0.
        assert_eq!(
            events[0]
                .tags
                .get("refusals_since_last_report")
                .map(String::as_str),
            Some("1"),
            "the first banner carries only the unconfirmed pass it waited on"
        );
        assert_eq!(
            events[1]
                .tags
                .get("refusals_since_last_report")
                .map(String::as_str),
            Some("4"),
            "the rearm carries the passes suppressed since the previous banner"
        );
    }

    /// Replaces the r1 test `alternating_deletion_sets_keep_each_key_in_its_own_
    /// cooldown`, which asserted the defect: that a changed path set re-arms
    /// after five minutes. This is the exact CAIO-PC-NAVE / hq-sync-win@0.10.58
    /// shape — one install, one process, three refusals 7m36s and 5m25s apart
    /// with the missing-path set changing every pass.
    #[test]
    fn churning_deletion_sets_are_recorded_as_data_not_a_new_banner() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let start = Instant::now();
        let wall = epoch();

        let events = sentry::test::with_captured_events(|| {
            for (offset, digest, count) in [
                (0u64, "set-a", 576usize),
                (456, "set-b", 1531),
                (781, "set-c", 916),
            ] {
                refuse_at(
                    "/hq",
                    &git_dir,
                    &staged(digest, count, b"companies/acme/a.md\0"),
                    4274,
                    start + Duration::from_secs(offset),
                    wall + chrono::Duration::seconds(offset as i64),
                );
            }
        });
        reset_refusal_report_state();

        assert_eq!(
            events.len(),
            1,
            "one HQ root with one open condition is one banner, however much the \
             deletion set churns"
        );
        assert_eq!(
            events[0]
                .tags
                .get("distinct_deletion_sets")
                .map(String::as_str),
            Some("2"),
            "the churn is preserved as evidence on the surviving event"
        );
        assert_eq!(
            events[0]
                .tags
                .get("deletion_set_stable")
                .map(String::as_str),
            Some("false")
        );
    }

    #[test]
    fn restart_does_not_rearm_the_banner_within_the_cooldown() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let set = staged("set-a", 50, b"companies/acme/a.md\0");
        let start = Instant::now();
        let wall = epoch();

        let events = sentry::test::with_captured_events(|| {
            refuse_at("/hq", &git_dir, &set, 100, start, wall);
            refuse_at(
                "/hq",
                &git_dir,
                &set,
                100,
                start + Duration::from_secs(60),
                wall + chrono::Duration::seconds(60),
            );

            // An auto-update relaunch: the process-local episode is gone, the
            // broken tree and the persisted anchor on disk are not.
            reset_refusal_report_state();
            for pass in 1..=2i64 {
                refuse_at(
                    "/hq",
                    &git_dir,
                    &set,
                    100,
                    start + Duration::from_secs(120 + pass as u64 * 60),
                    wall + chrono::Duration::seconds(120 + pass * 60),
                );
            }
        });
        reset_refusal_report_state();

        assert_eq!(
            events.len(),
            1,
            "a relaunch must not re-arm the banner for a condition already reported"
        );
    }

    #[test]
    fn a_restart_past_the_cooldown_does_rearm() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let set = staged("set-a", 50, b"companies/acme/a.md\0");
        let start = Instant::now();
        let wall = epoch();

        let events = sentry::test::with_captured_events(|| {
            refuse_at("/hq", &git_dir, &set, 100, start, wall);
            refuse_at(
                "/hq",
                &git_dir,
                &set,
                100,
                start + Duration::from_secs(60),
                wall + chrono::Duration::seconds(60),
            );

            // Relaunched a day later, still wedged. Suppression must not latch
            // forever — the persisted anchor is now older than the cooldown.
            reset_refusal_report_state();
            let later = wall + chrono::Duration::hours(24);
            refuse_at("/hq", &git_dir, &set, 100, start, later);
            refuse_at(
                "/hq",
                &git_dir,
                &set,
                100,
                start + Duration::from_secs(60),
                later + chrono::Duration::seconds(60),
            );
        });
        reset_refusal_report_state();

        assert_eq!(events.len(), 2, "an aged persisted anchor must re-arm");
        assert_eq!(
            events[1].tags.get("report_source").map(String::as_str),
            Some("first-confirmed"),
            "the relaunched process has no in-memory report of its own"
        );
    }

    #[test]
    fn corrupt_absent_or_future_dated_state_rearms_and_never_panics() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let set = staged("set-a", 50, b"companies/acme/a.md\0");
        let wall = epoch();
        let path = refusal_state_path(&git_dir);

        // Absent, unparsable JSON, valid JSON with a junk timestamp, and a
        // stamp dated in the future must all behave identically: re-arm.
        let states: [Option<&str>; 4] = [
            None,
            Some("{not json at all"),
            Some(
                r#"{"last_reported_at":"whenever","episode_opened_at":"","occurrences":1,"distinct_sets":1}"#,
            ),
            Some(
                r#"{"last_reported_at":"2126-08-06T10:00:00Z","episode_opened_at":"2126-08-06T10:00:00Z","occurrences":1,"distinct_sets":1}"#,
            ),
        ];

        for (index, contents) in states.into_iter().enumerate() {
            reset_refusal_report_state();
            match contents {
                Some(raw) => fs::write(&path, raw).unwrap(),
                None => {
                    let _ = fs::remove_file(&path);
                }
            }
            // A bad record must not be read as "already reported".
            assert_eq!(
                read_persisted_report_at(&git_dir, wall),
                None,
                "case {index}"
            );

            let events = sentry::test::with_captured_events(|| {
                let start = Instant::now();
                refuse_at("/hq", &git_dir, &set, 100, start, wall);
                refuse_at(
                    "/hq",
                    &git_dir,
                    &set,
                    100,
                    start + Duration::from_secs(60),
                    wall + chrono::Duration::seconds(60),
                );
            });
            assert_eq!(
                events.len(),
                1,
                "case {index} must re-arm exactly one banner"
            );
            // …and the reporter must have replaced the bad record with a good one.
            assert!(
                read_persisted_report_at(&git_dir, wall + chrono::Duration::seconds(60)).is_some(),
                "case {index} must have replaced the bad record with a usable one"
            );
        }
        reset_refusal_report_state();
    }

    #[test]
    fn report_carries_stability_and_prefix_evidence() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        let start = Instant::now();
        let wall = epoch();
        let records = b"companies/acme/a.md\0companies/acme/b.md\0repos/private/x/c.rs\0";

        // A stable episode: the same subtree missing on every pass.
        reset_refusal_report_state();
        let stable_dir = scratch_git_dir(&tmp, "stable-git-dir");
        let stable = sentry::test::with_captured_events(|| {
            for pass in 0..3u64 {
                refuse_at(
                    "/hq/stable",
                    &stable_dir,
                    &staged("set-a", 162, records),
                    1356,
                    start + Duration::from_secs(pass * 60),
                    wall + chrono::Duration::seconds((pass * 60) as i64),
                );
            }
        });

        assert_eq!(stable.len(), 1);
        let event = &stable[0];
        for tag in [
            "deletion_set_stable",
            "distinct_deletion_sets",
            "episode_occurrences",
            "episode_age_secs",
            "since_last_report_secs",
            "report_source",
            "has_upstream",
        ] {
            assert!(
                event.tags.contains_key(tag),
                "a captured refusal must carry the {tag} evidence tag"
            );
        }
        assert_eq!(
            event.tags.get("deletion_set_stable").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            event.tags.get("distinct_deletion_sets").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            event.tags.get("episode_age_secs").map(String::as_str),
            Some("60"),
            "the banner fires on the confirming pass, one minute into the episode"
        );
        assert_eq!(
            event.tags.get("since_last_report_secs").map(String::as_str),
            Some("never")
        );
        assert_eq!(
            event.tags.get("has_upstream").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            event.extra.get("deletion_prefixes"),
            Some(&serde_json::json!({"companies": 2, "repos": 1})),
            "the histogram names subtrees, and only subtrees"
        );
        assert_eq!(
            event.extra.get("deletion_prefix_groups"),
            Some(&serde_json::json!(2))
        );

        // A churning episode on a different root, for contrast.
        reset_refusal_report_state();
        let churn_dir = scratch_git_dir(&tmp, "churn-git-dir");
        let churning = sentry::test::with_captured_events(|| {
            for (pass, digest) in ["set-a", "set-b", "set-c"].into_iter().enumerate() {
                refuse_at(
                    "/hq/churn",
                    &churn_dir,
                    &staged(digest, 162, records),
                    1356,
                    start + Duration::from_secs(pass as u64 * 60),
                    wall + chrono::Duration::seconds(pass as i64 * 60),
                );
            }
        });
        reset_refusal_report_state();

        assert_eq!(churning.len(), 1);
        assert_eq!(
            churning[0]
                .tags
                .get("deletion_set_stable")
                .map(String::as_str),
            Some("false"),
            "a set that changed between passes reads as a mid-sync sample"
        );
    }

    #[test]
    fn prefix_histogram_is_depth_one_and_leaks_nothing_deeper() {
        let _serial = serial();
        reset_refusal_report_state();
        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "git-dir");
        let start = Instant::now();
        let wall = epoch();
        let records =
            b"companies/acme-corp/knowledge/salaries.md\0companies/acme-corp/x.md\0secret-notes.md\0";

        let events = sentry::test::with_captured_events(|| {
            for pass in 0..2u64 {
                refuse_at(
                    "/hq",
                    &git_dir,
                    &staged("set-a", 3, records),
                    30,
                    start + Duration::from_secs(pass * 60),
                    wall + chrono::Duration::seconds((pass * 60) as i64),
                );
            }
        });
        reset_refusal_report_state();

        assert_eq!(events.len(), 1);
        let encoded = serde_json::to_string(&events[0]).expect("event serializes");
        for forbidden in [
            "acme-corp",    // a company slug
            "salaries",     // a file name
            "secret-notes", // a root-level file name
            "knowledge",    // a depth-2 segment
            "companies/",   // any separator below depth 1
        ] {
            assert!(
                !encoded.contains(forbidden),
                "the payload must not carry {forbidden:?}; got {encoded}"
            );
        }
        assert!(
            encoded.contains("companies"),
            "the depth-1 shape of the loss must survive"
        );
        assert!(
            encoded.contains(ROOT_PREFIX_LABEL),
            "root-level deletions must be counted under the sentinel"
        );
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
        assert!(should_reap_index_lock(
            lock_state(0, 600),
            STALE_LOCK_MIN_AGE
        ));
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
        assert!(!should_reap_index_lock(
            lock_state(64, 600),
            STALE_LOCK_MIN_AGE
        ));
        // Too fresh.
        assert!(!should_reap_index_lock(
            lock_state(0, 10),
            STALE_LOCK_MIN_AGE
        ));
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

    /// Put back exactly what [`delete_files`] removed, byte for byte, so the
    /// working tree matches HEAD again — a restore finishing, or the other half
    /// of the mid-sync sample.
    fn restore_files(dir: &Path, range: std::ops::Range<usize>) {
        for i in range {
            fs::write(dir.join(format!("file-{i:04}.md")), format!("content {i}")).unwrap();
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
        reset_refusal_report_state();

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
        reset_refusal_report_state();
    }

    #[test]
    fn repeated_unchanged_bulk_deletion_emits_one_sentry_event() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        delete_files(tmp.path(), 0..50);

        let events = sentry::test::with_captured_events(|| {
            for _ in 0..5 {
                run_mirror_at(tmp.path()).expect("mirror reports a refused deletion safely");
            }
        });
        reset_refusal_report_state();

        assert_eq!(
            events.len(),
            1,
            "an unchanged deletion set must capture one Sentry event across five mirror cycles"
        );
        let event = &events[0];
        assert_eq!(
            event.message.as_deref(),
            Some("[git-mirror] refused to commit a bulk deletion of the HQ folder")
        );
        assert_eq!(event.level, sentry::Level::Warning);
        assert_eq!(
            event.tags.get("git_mirror_kind").map(String::as_str),
            Some("bulk-delete-refused")
        );
        assert_eq!(event.tags.get("deletions").map(String::as_str), Some("50"));
        assert_eq!(event.tags.get("tracked").map(String::as_str), Some("100"));
        assert_eq!(
            event
                .tags
                .get("refusals_since_last_report")
                .map(String::as_str),
            Some("1"),
            "the banner fires on the confirming pass, so pass one is counted as \
             suppressed rather than lost"
        );
        assert_eq!(
            event.tags.get("deletion_set_stable").map(String::as_str),
            Some("true"),
            "the same 50 files were missing on every pass"
        );
    }

    /// The gold-standard regression: this compiles and FAILS at the r1 base
    /// (which captures one event on the very first refusing pass), and passes
    /// here. A refusal that heals on the next pass is the dominant field shape
    /// and the least actionable one.
    #[test]
    fn single_pass_transient_refusal_is_not_reported() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());
        delete_files(tmp.path(), 0..50);

        let events = sentry::test::with_captured_events(|| {
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
            restore_files(tmp.path(), 0..50);
            run_mirror_at(tmp.path()).expect("mirror ok");
        });

        assert_eq!(
            events.len(),
            0,
            "a refusal that heals on the very next pass must not reach Sentry"
        );
        assert!(
            !refusal_state_path(&git_dir_of(tmp.path())).exists(),
            "an unreported episode must not persist a cooldown anchor"
        );
        assert_eq!(
            rev_count(tmp.path()),
            before,
            "the restored tree matches HEAD, so there is nothing to commit"
        );
        // The episode must be closed, not merely quiet.
        assert!(!REFUSAL_EPISODES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tmp.path().to_str().unwrap()));
        reset_refusal_report_state();
    }

    /// The field shape, end to end through real git children: the
    /// Jets-Mac-mini.local event (162 of 1356 tracked = 11.9%) followed by a
    /// churned second pass — a different 162 files missing, as CAIO-PC-NAVE saw.
    #[test]
    fn run_mirror_on_real_repo_with_field_shaped_bulk_delete() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 1_356);
        let before = rev_count(tmp.path());

        let events = sentry::test::with_captured_events(|| {
            delete_files(tmp.path(), 0..162);
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
            assert!(index_is_clean(tmp.path()), "refusal must reset the index");

            // A different 162 files missing on the next pass: the deletion set
            // churns, which at r1 minted a brand-new suppression key.
            restore_files(tmp.path(), 0..162);
            delete_files(tmp.path(), 500..662);
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
        });

        assert_eq!(
            rev_count(tmp.path()),
            before,
            "nothing may be committed or pushed while the breaker refuses"
        );
        assert!(index_is_clean(tmp.path()), "refusal must reset the index");
        assert_eq!(
            events.len(),
            1,
            "two refusing passes with different missing files are one condition"
        );
        let event = &events[0];
        assert_eq!(event.tags.get("deletions").map(String::as_str), Some("162"));
        assert_eq!(event.tags.get("tracked").map(String::as_str), Some("1356"));
        assert_eq!(
            event.tags.get("deletion_set_stable").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            event.tags.get("distinct_deletion_sets").map(String::as_str),
            Some("2")
        );
        assert_eq!(
            event.tags.get("has_upstream").map(String::as_str),
            Some("false"),
            "this scratch repo has no upstream, so it is only losing local history"
        );
        // Every deleted path here sits at the repository root.
        assert_eq!(
            event.extra.get("deletion_prefixes"),
            Some(&serde_json::json!({ ROOT_PREFIX_LABEL: 162 }))
        );
        reset_refusal_report_state();
    }

    #[test]
    fn recovery_closes_the_episode_and_a_fresh_one_still_honors_the_cooldown() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());

        let events = sentry::test::with_captured_events(|| {
            // Episode one: confirmed, reported.
            delete_files(tmp.path(), 0..50);
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
            run_mirror_at(tmp.path()).expect("a refusal is not an error");

            // The tree heals and the mirror commits an unrelated change.
            restore_files(tmp.path(), 0..50);
            fs::write(tmp.path().join("new.md"), "content").unwrap();
            run_mirror_at(tmp.path()).expect("mirror ok");

            // Episode two, inside the cooldown.
            delete_files(tmp.path(), 0..50);
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
        });
        reset_refusal_report_state();

        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "exactly the one healthy pass may commit"
        );
        assert_eq!(
            events.len(),
            1,
            "closing and reopening an episode must not re-arm the banner inside \
             the per-root cooldown"
        );
    }

    #[test]
    fn episode_state_file_is_invisible_to_the_mirror() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        delete_files(tmp.path(), 0..50);

        sentry::test::with_captured_events(|| {
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
            run_mirror_at(tmp.path()).expect("a refusal is not an error");
        });

        let state_file = refusal_state_path(&git_dir_of(tmp.path()));
        assert!(
            state_file.is_file(),
            "a confirmed report must persist its cooldown anchor"
        );
        // It lives inside the git dir, so git cannot see it — which is what
        // keeps it from feeding back into the deletion accounting it describes.
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        let staged_paths = git(
            tmp.path(),
            &["diff", "--cached", "--name-only", "--diff-filter=A", "-z"],
        );
        let staged_paths = String::from_utf8_lossy(&staged_paths.stdout);
        assert!(
            !staged_paths.contains(REFUSAL_STATE_FILE),
            "the episode record must never be staged, got {staged_paths:?}"
        );
        assert!(
            !String::from_utf8_lossy(&git(tmp.path(), &["status", "--porcelain"]).stdout)
                .contains(REFUSAL_STATE_FILE),
            "the episode record must never appear in git status"
        );
        reset_refusal_report_state();
    }

    #[test]
    fn episode_state_is_anchored_per_linked_worktree() {
        let _serial = serial();
        std::env::remove_var(BULK_OVERRIDE_ENV);
        reset_refusal_report_state();

        let main = TempDir::new().unwrap();
        let trees = TempDir::new().unwrap();
        seed_repo(main.path(), 100);
        let wt = trees.path().join("wt");
        assert!(git(
            main.path(),
            &["worktree", "add", "-q", wt.to_str().unwrap()]
        )
        .status
        .success());
        assert!(wt.join(".git").is_file(), "expected a linked worktree");

        delete_files(&wt, 0..50);
        sentry::test::with_captured_events(|| {
            run_mirror_at(&wt).expect("a refusal is not an error");
            run_mirror_at(&wt).expect("a refusal is not an error");
        });

        let worktree_state = refusal_state_path(&git_dir_of(&wt));
        assert!(
            worktree_state.is_file(),
            "the episode record must land in the per-worktree git dir"
        );
        assert!(
            !refusal_state_path(&git_dir_of(main.path())).exists(),
            "a linked worktree must not write into the parent .git"
        );
        reset_refusal_report_state();
    }

    #[test]
    fn staged_deletion_count_and_digest_follow_the_actual_path_set() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        delete_files(tmp.path(), 0..50);
        assert!(git(tmp.path(), &["add", "-A"]).status.success());

        let staged = count_staged_deletions(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(staged.count, 50, "the breaker numerator is unchanged");
        assert_eq!(
            staged.digest,
            deletion_set_digest(
                &git(
                    tmp.path(),
                    &[
                        "diff",
                        "--cached",
                        "--name-only",
                        "--diff-filter=D",
                        "-M",
                        "-z",
                    ],
                )
                .stdout
            )
        );
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
        assert!(git(
            main.path(),
            &["worktree", "add", "-q", wt.to_str().unwrap()]
        )
        .status
        .success());
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

        let err = wait_with_timeout(
            &mut child,
            Duration::from_millis(200),
            "hash-object --stdin",
        )
        .expect_err("a blocked child must time out");

        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(
            child.try_wait().expect("try_wait").is_some(),
            "the timed-out child must have been killed and reaped"
        );
    }
}
