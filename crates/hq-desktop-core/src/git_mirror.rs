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
//! Three properties this module is responsible for, all learned the hard way:
//!
//! 1. **A readable root's deletions are intentional.** Once the root can be
//!    read, the mirror stages and commits deletions in the same pass. It checks
//!    that the root is readable before and after staging so a missing or
//!    unreadable root remains an error instead of an empty snapshot. Scope
//!    quarantine moves are still restored to the index only when their copies
//!    match the original content and path history.
//! 2. **It must not wedge the repo.** Every git child here writes
//!    `.git/index.lock`, and a killed child leaves it behind — which then
//!    blocks *every* HQ git write, including the autocommit hook, until
//!    someone deletes the file by hand. Mutual exclusion is therefore a real
//!    cross-process advisory lock (not the process-local `Mutex` alone), git
//!    children run under a timeout with a kill path, and a stale-lock reaper
//!    runs at launch, before every mirror, and after a failed one.
//! 3. **It must not quietly change what the user tracks.** A repo that crosses
//!    [`MIRROR_SIZE_CAP_BYTES`] latches the mirror off ([`DISABLE_STATE_FILE`])
//!    and stays off until a human clears the latch. The earlier design instead
//!    kept itself under the ceiling by rewriting the root `.gitignore` and
//!    running `git rm -r --cached` on `workspace/` — untracking the user's own
//!    files from a background daemon, with an escalation ladder that only
//!    deferred the real problem by one rung. Stopping is the honest outcome:
//!    the vault still syncs, local history is untouched, and the log says
//!    exactly what to do.
//!
//! Note for reviewers: this module pushes the HQ root to its upstream, which
//! HQ's own `hq-root-never-push-remote` charter rule forbids for agent
//! sessions. That tension is deliberate and unresolved here — the guards
//! below make the existing behaviour safe; whether the push itself should
//! exist is an owner decision tracked separately.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Condvar, LazyLock, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::logfile::log;
use crate::paths;

const LOG_TAG: &str = "git-mirror";

/// Guards the index-touching local snapshot only. Pushes have their own lock so
/// a slow network operation never suppresses later local commits.
///
/// This only serializes threads inside one process. The cross-process half
/// is [`try_acquire_mirror_lock`].
static MIRROR_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct ScopeQuarantineGateState {
    generations: HashMap<u64, Option<(u64, bool)>>,
    first_mirror_decision: Option<bool>,
}

/// Sticky hq-flags snapshot shared by manual and daemon mirror passes. The
/// first pass waits for this snapshot; later passes use the latest delivered
/// value without waiting again.
struct ScopeQuarantineGate {
    state: Mutex<ScopeQuarantineGateState>,
    snapshot_ready: Condvar,
}

impl ScopeQuarantineGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(ScopeQuarantineGateState::default()),
            snapshot_ready: Condvar::new(),
        }
    }

    fn register_generation(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if generation == 0 || state.generations.contains_key(&generation) {
            return false;
        }
        state.generations.insert(generation, None);
        self.snapshot_ready.notify_all();
        true
    }

    fn set_snapshot(&self, generation: u64, revision: u64, enabled: bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(current) = state.generations.get_mut(&generation) else {
            return false;
        };
        if current.is_some_and(|(current_revision, _)| revision <= current_revision) {
            return false;
        }
        *current = Some((revision, enabled));
        self.snapshot_ready.notify_all();
        true
    }

    fn unregister_generation(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let removed = state.generations.remove(&generation).is_some();
        if removed {
            self.snapshot_ready.notify_all();
        }
        removed
    }

    fn effective_enabled(state: &ScopeQuarantineGateState) -> bool {
        !state.generations.is_empty()
            && state
                .generations
                .values()
                .all(|snapshot| snapshot.is_some_and(|(_, enabled)| enabled))
    }

    fn has_resolved_snapshot(state: &ScopeQuarantineGateState) -> bool {
        !state.generations.is_empty()
            && (state
                .generations
                .values()
                .any(|snapshot| snapshot.is_some_and(|(_, enabled)| !enabled))
                || state.generations.values().all(Option::is_some))
    }

    fn resolve_first_mirror(&self, timeout: Duration) -> ScopeQuarantineGateDecision {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.first_mirror_decision.is_some() {
            return ScopeQuarantineGateDecision {
                enabled: Self::effective_enabled(&state),
                timed_out: false,
            };
        }

        let deadline = Instant::now() + timeout;
        while !Self::has_resolved_snapshot(&state) {
            let now = Instant::now();
            if now >= deadline {
                state.first_mirror_decision = Some(false);
                return ScopeQuarantineGateDecision {
                    enabled: false,
                    timed_out: true,
                };
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, wait) = self
                .snapshot_ready
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
            if state.first_mirror_decision.is_some() {
                return ScopeQuarantineGateDecision {
                    enabled: Self::effective_enabled(&state),
                    timed_out: false,
                };
            }
            if wait.timed_out() && !Self::has_resolved_snapshot(&state) {
                state.first_mirror_decision = Some(false);
                return ScopeQuarantineGateDecision {
                    enabled: false,
                    timed_out: true,
                };
            }
        }

        let enabled = Self::effective_enabled(&state);
        state.first_mirror_decision = Some(enabled);
        ScopeQuarantineGateDecision {
            enabled,
            timed_out: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScopeQuarantineGateDecision {
    enabled: bool,
    timed_out: bool,
}

static SCOPE_QUARANTINE_GATE: LazyLock<ScopeQuarantineGate> =
    LazyLock::new(ScopeQuarantineGate::new);
static NEXT_SCOPE_QUARANTINE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Allocate and register a process-wide identity for one live adapter window.
pub fn register_scope_quarantine_move_not_deletion_generation() -> Result<u64, String> {
    let previous = NEXT_SCOPE_QUARANTINE_GENERATION
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .map_err(|_| "mirror quarantine generation space exhausted".to_string())?;
    let generation = previous + 1;
    if !SCOPE_QUARANTINE_GATE.register_generation(generation) {
        return Err("mirror quarantine generation was already registered".to_string());
    }
    Ok(generation)
}

/// Remove a closing/reloading adapter from the effective process-wide gate.
pub fn unregister_scope_quarantine_move_not_deletion_generation(generation: u64) {
    SCOPE_QUARANTINE_GATE.unregister_generation(generation);
}

/// Update the cached hq-flags value used by both manual and daemon mirrors.
/// A missing or unreadable flag is sent as `false` by the desktop adapter.
pub fn set_scope_quarantine_move_not_deletion_enabled(
    generation: u64,
    revision: u64,
    enabled: bool,
) {
    SCOPE_QUARANTINE_GATE.set_snapshot(generation, revision, enabled);
}

/// Guards pushes independently from local snapshots. Only one push may run at
/// a time, but `MIRROR_LOCK` remains available while it does.
static PUSH_LOCK: Mutex<()> = Mutex::new(());

/// Minimum spacing between mirror runs. The watch-driven daemon can emit
/// AllComplete every few seconds under heavy local churn (an active HQ session
/// plus autocommit hooks rewriting the tree). Without a floor, git-mirror runs
/// `git add -A` + commit every few seconds — burning CPU/disk and contending on
/// `.git/index.lock` with any other writer. One snapshot per minute is ample for
/// a versioned mirror; the next sync within the window catches up the tail.
const MIN_MIRROR_INTERVAL: Duration = Duration::from_secs(60);

/// Timestamp of the last mirror attempt, for the throttle above.
static LAST_MIRROR_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// Minimum interval between repeated warnings for one unrecoverable index-lock
/// wedge. The lock reporter has its own bounded escalation ladder below.
const WEDGE_REPORT_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);

/// Finite warning ages for one unrecoverable index-lock wedge.
const WEDGE_ESCALATION_AGES: [Duration; 2] = [
    Duration::from_secs(24 * 60 * 60),
    Duration::from_secs(7 * 24 * 60 * 60),
];

/// Name of the push-wedge record. Lives in the resolved git directory, so
/// `git add -A` must never see it.
const PUSH_BLOCK_STATE_FILE: &str = "hq-sync-mirror-push-block.json";

/// Name of the size latch. Once this file exists, the mirror does no git work at
/// all for this root — no staging, no measuring, no commit, no push — until a
/// human deletes it. Lives beside the other records in the resolved git
/// directory, so `git add -A` can never see it.
///
/// This replaces an earlier "size gate" that tried to stay under the cap on the
/// user's behalf: it rewrote the root `.gitignore` and ran `git rm -r --cached`
/// on `workspace/`, silently untracking the user's own files to buy headroom.
/// Automatically deciding which of someone's directories stop being versioned is
/// not a call this background daemon should make, and the escalation ladder only
/// ever deferred the real problem by one rung. Stopping is the honest outcome:
/// the vault still syncs, the local history is intact, and the log says exactly
/// what to do.
const DISABLE_STATE_FILE: &str = "hq-sync-mirror-disabled.json";

/// How long to stop pushing after a rejection that retrying cannot fix.
///
/// Some rejections are settled facts about history, not weather. A blob over
/// the remote's file-size limit is the case that motivated this: once such a
/// commit exists, *every* push is rejected until history is rewritten, and the
/// mirror was re-attempting one a minute — thousands of identical failures a
/// day, each appending a multi-line stderr block to the diagnostic log.
///
/// A cooldown rather than a permanent latch: the operator may fix the cause at
/// any time, and the mirror should discover that on its own without needing a
/// restart. Six hours turns ~1440 doomed pushes a day into 4 while still
/// self-healing the same day.
const PUSH_BLOCK_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);

/// Size ceiling for the mirrored repo's *staged content*. Crossing it does not
/// make the mirror shed content — it makes the mirror **stop**, permanently,
/// until an operator clears the latch. See [`DISABLE_STATE_FILE`].
///
/// The measurement is the summed blob size of the staged snapshot (the tree the
/// next commit would record), not the `.git` directory: measuring the staged
/// index rather than HEAD catches a newly-added oversized file before it is
/// committed and pushed into history, where nothing short of a history rewrite
/// could remove it. Content size is also a conservative proxy for the pushed
/// pack (text/JSON session logs compress several-fold), so tripping at 2 GiB
/// leaves margin under GitHub's 2 GB repo ceiling.
///
/// This governs the git mirror only. HQ cloud sync follows `.hqignore`/
/// `.hqinclude` and is unaffected — the vault keeps syncing after the mirror
/// latches off, because the mirror was only ever a secondary snapshot.
const MIRROR_SIZE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Operator/testing override for [`MIRROR_SIZE_CAP_BYTES`], expressed in whole
/// mebibytes. Tests set a tiny cap so the latch can trip on a small repo without
/// staging two gigabytes of scratch data.
const MIRROR_SIZE_CAP_ENV: &str = "HQ_MIRROR_SIZE_CAP_MB";

/// Resolve the tracked-content ceiling, honoring the [`MIRROR_SIZE_CAP_ENV`]
/// override when it parses as a whole number of mebibytes.
fn resolve_mirror_size_cap() -> u64 {
    if let Ok(raw) = std::env::var(MIRROR_SIZE_CAP_ENV) {
        if let Ok(mb) = raw.trim().parse::<u64>() {
            return mb.saturating_mul(1024 * 1024);
        }
    }
    MIRROR_SIZE_CAP_BYTES
}

/// Count of staged deletions, used only for the commit's aggregate log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StagedDeletions {
    count: usize,
}

/// Elapsed wall-clock time since a persisted stamp.
///
/// `None` for a stamp dated in the future — a clock that moved backwards, a
/// timezone/DST jump, or a copied `.git` must **re-arm** the banner rather than
/// latch it silent. Re-arming costs one extra event; latching loses the signal.
fn elapsed_since_wall(reported_at: DateTime<Utc>, now: DateTime<Utc>) -> Option<Duration> {
    now.signed_duration_since(reported_at).to_std().ok()
}

/// Whether a failed `git push` is worth trying again next cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PushFailure {
    /// A settled fact about the repository. Retrying changes nothing until a
    /// human intervenes, so the mirror backs off instead of hammering.
    Permanent { reason: String },
    /// Weather — DNS, timeout, contention, a race with another writer. The
    /// next cycle may well succeed, so nothing is recorded.
    Transient,
}

/// The push-wedge record, written when a rejection is classified permanent.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPushBlock {
    /// Wall clock, RFC3339. Chrono's serde integration is not enabled for this crate.
    blocked_at: String,
    reason: String,
}

/// Classify `git push` stderr.
///
/// Deliberately narrow. A false "permanent" silently stops mirroring, which is
/// strictly worse than a few wasted retries — so only rejections that are
/// provably unfixable by repetition qualify. Everything unrecognised, including
/// auth and non-fast-forward failures that often clear on their own, stays
/// transient.
fn classify_push_failure(stderr: &str) -> PushFailure {
    let haystack = stderr.to_ascii_lowercase();

    // A blob over the remote's per-file ceiling. The offending object is in
    // history, so every future push carries it too.
    const OVERSIZED_MARKERS: [&str; 3] = [
        "exceeds github's file size limit",
        "gh001",
        "large files detected",
    ];
    if OVERSIZED_MARKERS.iter().any(|m| haystack.contains(m)) {
        return PushFailure::Permanent {
            reason: oversized_reason(stderr),
        };
    }

    PushFailure::Transient
}

/// Pull the offending path out of a size-limit rejection so the log line is
/// actionable rather than just loud. Falls back to a generic description.
fn oversized_reason(stderr: &str) -> String {
    for line in stderr.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("exceeds") && lower.contains("file size limit") {
            // `remote: error: File <path> is 183.58 MB; this exceeds ...`
            if let Some(rest) = line.split("File ").nth(1) {
                if let Some(path) = rest.split(" is ").next() {
                    return format!("history contains a file over the remote's size limit: {path}");
                }
            }
        }
    }
    "history contains a file over the remote's size limit".to_string()
}

fn push_block_path(git_dir: &Path) -> PathBuf {
    git_dir.join(PUSH_BLOCK_STATE_FILE)
}

/// Is a recorded block still in force?
///
/// A stamp in the future means the clock moved backwards or the `.git` was
/// copied between machines. Treat that as "not blocked" and re-probe: an extra
/// doomed push costs one log line, whereas latching on a bad stamp would
/// silently stop mirroring forever.
fn push_block_is_active(block: Option<&PersistedPushBlock>, now: DateTime<Utc>) -> bool {
    let Some(block) = block else { return false };
    // An unparsable stamp re-probes for the same reason a future one does:
    // losing a push is recoverable, silently never pushing again is not.
    let Ok(blocked_at) = DateTime::parse_from_rfc3339(&block.blocked_at) else {
        return false;
    };
    match now
        .signed_duration_since(blocked_at.with_timezone(&Utc))
        .to_std()
    {
        Ok(elapsed) => elapsed < PUSH_BLOCK_COOLDOWN,
        Err(_) => false,
    }
}

/// Read the block record, or `None` when there is no usable one. Every failure
/// mode resolves to `None`: a bad observability file must never stop the mirror.
fn read_push_block(git_dir: &Path) -> Option<PersistedPushBlock> {
    let raw = fs::read_to_string(push_block_path(git_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_push_block(git_dir: &Path, block: &PersistedPushBlock) {
    let Ok(encoded) = serde_json::to_string(block) else {
        return;
    };
    // Publish via a same-directory rename so a crash cannot leave a torn block.
    let temp = git_dir.join(format!("{PUSH_BLOCK_STATE_FILE}.tmp"));
    if fs::write(&temp, encoded).is_ok() && fs::rename(&temp, push_block_path(git_dir)).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

fn clear_push_block(git_dir: &Path) {
    let _ = fs::remove_file(push_block_path(git_dir));
}

/// Why the latch was written. The two causes need *different* remedies, so the
/// notice cannot be one sentence for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DisableReason {
    /// The staged snapshot — the tree the next commit would record — is over the
    /// cap. Shrinking the working tree is a real fix: nothing oversized has been
    /// committed yet.
    StagedSnapshot,
    /// Objects already committed locally but not yet pushed are over the cap in
    /// packed form. Shrinking the working tree does *not* fix this: deleting the
    /// content only adds another commit, and the oversized objects stay in an
    /// unpushed ancestor that the next push would still send.
    UnpushedHistory,
}

/// The size latch: written once, when the repo first crosses the cap, and never
/// cleared by this program.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedDisable {
    /// Wall clock, RFC3339 — same convention as the other records here, since
    /// chrono's serde integration is not enabled for this crate.
    disabled_at: String,
    /// What was measured, and against what ceiling. Carried so the log line after
    /// a restart is as specific as the one that tripped it.
    measured_bytes: u64,
    cap_bytes: u64,
    /// `None` when the record could not be read or parsed, in which case the
    /// notice has to cover both remedies rather than guess one.
    #[serde(default)]
    reason: Option<DisableReason>,
}

fn disable_path(git_dir: &Path) -> PathBuf {
    git_dir.join(DISABLE_STATE_FILE)
}

/// Whether this root's mirror is latched off, and the record if it is.
///
/// Deliberately fails *closed*, unlike every other observability read in this
/// module: a latch file that exists but cannot be parsed still disables the
/// mirror. The other records only shape logging, so a bad one should be ignored;
/// this one is the guard that keeps an over-cap repo from being pushed, and
/// ignoring a corrupt one would resume exactly the behaviour it was written to
/// stop.
fn read_disable_latch(git_dir: &Path) -> Option<PersistedDisable> {
    let path = disable_path(git_dir);
    if !path.exists() {
        return None;
    }
    let unparsable = || PersistedDisable {
        disabled_at: String::new(),
        measured_bytes: 0,
        cap_bytes: resolve_mirror_size_cap(),
        reason: None,
    };
    match fs::read_to_string(&path) {
        Ok(raw) => Some(serde_json::from_str(&raw).unwrap_or_else(|_| unparsable())),
        // Present but unreadable — permissions, a bad mount. Still latched.
        Err(_) => Some(unparsable()),
    }
}

/// Latch the mirror off for this root. Best-effort: if the record cannot be
/// written we still refuse *this* pass, so the worst case is that the next pass
/// re-measures and refuses again rather than an oversized push slipping out.
fn write_disable_latch(
    git_dir: &Path,
    measured: u64,
    cap: u64,
    reason: DisableReason,
    now: DateTime<Utc>,
) {
    let record = PersistedDisable {
        disabled_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
        measured_bytes: measured,
        cap_bytes: cap,
        reason: Some(reason),
    };
    let Ok(encoded) = serde_json::to_string(&record) else {
        return;
    };
    // Same temp-then-rename shape as the records above, so a crash mid-write
    // cannot leave a torn file.
    let temp = git_dir.join(format!("{DISABLE_STATE_FILE}.tmp"));
    if fs::write(&temp, encoded).is_ok() && fs::rename(&temp, disable_path(git_dir)).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

/// Last time the disable notice was logged for a root. A latched mirror is
/// reached once per [`MIN_MIRROR_INTERVAL`] for as long as the app runs, and
/// appending the same paragraph to the diagnostic log 1440 times a day is the
/// exact flood shape the escalation ladder above exists to prevent. Empty at
/// process start, so a relaunch always logs once.
static DISABLE_NOTICE_AT: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Log [`disable_notice`] the first time this process sees a root latched, then
/// at most once per [`WEDGE_REPORT_COOLDOWN`] — often enough that someone opening the
/// log to ask "why has this stopped pushing?" finds the answer near the tail.
fn log_disable_notice(hq_folder: &str, git_dir: &Path, record: &PersistedDisable) {
    {
        let mut seen = DISABLE_NOTICE_AT.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(last) = seen.get(hq_folder) {
            if now.duration_since(*last) < WEDGE_REPORT_COOLDOWN {
                return;
            }
        }
        seen.insert(hq_folder.to_string(), now);
    }
    log(LOG_TAG, &disable_notice(hq_folder, git_dir, record));
}

/// The one paragraph a user needs to turn the mirror back on, with the real path
/// in it — and, crucially, the remedy that actually works for *this* cause.
///
/// Getting the remedy wrong is worse than saying nothing: someone told to "shrink
/// the repo" after an unpushed-history latch would delete the large content, clear
/// the latch, and watch the very next pass latch again, because the oversized
/// objects were never in the working tree — they were already in a commit.
fn disable_notice(hq_folder: &str, git_dir: &Path, record: &PersistedDisable) -> String {
    let measured = if record.measured_bytes == 0 {
        String::new()
    } else {
        let what = match record.reason {
            Some(DisableReason::UnpushedHistory) => "unpushed history measured",
            _ => "staged content measured",
        };
        format!(" ({what} {})", human_bytes(record.measured_bytes))
    };
    let remedy = match record.reason {
        Some(DisableReason::StagedSnapshot) => {
            "Shrink the working tree (or move the large content out of the repo), then delete \
             {path} to re-enable."
        }
        Some(DisableReason::UnpushedHistory) => {
            "The oversized objects are already in local commits, so deleting the content now \
             will not help — that only adds another commit on top of them. Reset or rewrite the \
             unpushed history first (`git reset --soft @{u}`, then recommit without the large \
             content), then delete {path} to re-enable."
        }
        // Unreadable record: we no longer know which cause it was, so name both
        // rather than send someone down the remedy that cannot work.
        None => {
            "Shrink the working tree, and if the large content is already in local commits that \
             have not been pushed, reset or rewrite those commits too. Then delete {path} to \
             re-enable."
        }
    }
    .replace("{path}", &disable_path(git_dir).display().to_string());
    format!(
        "{hq_folder}: git mirror is disabled — the repo crossed the {} size cap{measured}. \
         No commits and no pushes will be made. HQ vault sync is unaffected. {remedy}",
        human_bytes(record.cap_bytes),
    )
}

/// A persisted RFC3339 stamp, accepted only if it parses and is not in the
/// future. A stamp from the future means the clock moved backwards, a
/// DST/timezone jump, or a copied `.git`; every caller here would rather
/// re-arm (one extra banner) than latch silent for what could be years.
fn usable_stamp(
    raw: Option<&String>,
    now: DateTime<Utc>,
    path: &Path,
    what: &str,
) -> Option<DateTime<Utc>> {
    let raw = raw?;
    let parsed = match DateTime::parse_from_rfc3339(raw) {
        Ok(at) => at.with_timezone(&Utc),
        Err(err) => {
            log(
                LOG_TAG,
                &format!(
                    "{} carries an unparsable {what} {raw:?} ({err}) — discarding it",
                    path.display()
                ),
            );
            return None;
        }
    };
    if elapsed_since_wall(parsed, now).is_none() {
        log(
            LOG_TAG,
            &format!(
                "{} has a {what} dated in the future ({raw}) — discarding it",
                path.display()
            ),
        );
        return None;
    }
    Some(parsed)
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
const GIT_PUSH_TIMEOUT: Duration = Duration::from_secs(60 * 60);

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

/// The bounded escape hatch for the *non-empty* orphaned lock — the one state
/// [`should_reap_index_lock`] refuses forever, because a partial index (a writer
/// killed mid-write) and a live writer we failed to observe look identical from
/// outside. A real git index write completes in well under a second, so a lock
/// that stays byte-for-byte frozen (same mtime), unheld, with no git process
/// anywhere, continuously for *this* long is one no live writer could still own.
/// Far longer than [`STALE_LOCK_MIN_AGE`] precisely because the cost of being
/// wrong here is a corrupt index, so the window is measured in tens of minutes,
/// not the empty case's five.
const WEDGED_LOCK_HARD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Field-tuning override for [`WEDGED_LOCK_HARD_TIMEOUT`]. Same spelling
/// convention as the other env knobs in this module. Values below
/// [`STALE_LOCK_MIN_AGE`] are clamped up to it: the escape hatch must never fire
/// faster than the empty-lock grace, no matter how the knob is set.
const WEDGED_LOCK_HARD_TIMEOUT_ENV: &str = "HQ_INDEX_LOCK_HARD_TIMEOUT_SECS";

/// Resolve the hard timeout, honouring the override with a safety floor.
fn wedged_lock_hard_timeout() -> Duration {
    match std::env::var(WEDGED_LOCK_HARD_TIMEOUT_ENV) {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(secs) => Duration::from_secs(secs.max(STALE_LOCK_MIN_AGE.as_secs())),
            Err(_) => WEDGED_LOCK_HARD_TIMEOUT,
        },
        Err(_) => WEDGED_LOCK_HARD_TIMEOUT,
    }
}

/// How long a non-empty lock must have stood wedged before a warning is billed
/// to Sentry — the triage-visibility floor, deliberately equal to the *default*
/// [`WEDGED_LOCK_HARD_TIMEOUT`] and read independently of
/// [`wedged_lock_hard_timeout`]. A warning describes a state a human must act on:
/// a wedge HQ could not recover after the hard timeout. Because the gate is this
/// fixed constant rather than the env-tunable reap clock, lowering
/// [`WEDGED_LOCK_HARD_TIMEOUT_ENV`] to reap sooner can never bill a warning before
/// the wedge is genuinely, human-actionably old, and cannot blind triage: the
/// warning floor stays at 30 minutes whatever the knob says.
const WEDGE_WARN_AFTER: Duration = WEDGED_LOCK_HARD_TIMEOUT;

/// The observability record that lets the hard timeout span passes and restarts.
const WEDGE_STATE_FILE: &str = "hq-sync-mirror-index-wedge.json";

/// Cross-pass observation of a single wedged non-empty lock. The confirmation
/// clock the hard timeout measures lives here so it survives app restarts — a
/// clock kept only in memory would reset before tens of minutes could elapse.
/// Written via the same temp-then-rename shape as the other observability files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PersistedIndexLockWedge {
    /// Wall clock, RFC3339: the first pass this exact frozen lock was observed
    /// wedged. The hard timeout is measured from here, not from the file's own
    /// mtime, so a copied `.git` carrying an ancient mtime cannot mature into an
    /// instant reap — the clock only starts once *we* have watched it dead.
    first_seen_at: String,
    /// The lock file's mtime in unix nanoseconds — the identity of "this exact
    /// lock". If it advances between passes, a writer is alive and touching the
    /// index, so the clock resets.
    lock_mtime_nanos: i64,
    /// Forensic only: the lock's size when first seen. Never gates the decision.
    #[serde(default)]
    size_bytes: u64,
    /// Warnings this exact wedge has already billed to Sentry — its finite report
    /// budget, carried on the same durable record as the reap clock so it survives
    /// app restarts and auto-updates. Additive with `#[serde(default)]`: a record
    /// written by a build before this field existed reads as 0, i.e. "nothing
    /// reported yet" — the conservative default that earns the wedge its first
    /// warning rather than latching a live wedge silent across an upgrade.
    #[serde(default)]
    reports: usize,
    /// Wall clock, RFC3339: when the most recent warning for this wedge was billed
    /// — the cooldown-floor anchor. Absent until the first warning, and a
    /// future-dated stamp (a backwards clock) re-arms rather than latches, exactly
    /// like every other stamp in this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_report_at: Option<String>,
}

/// Observable facts about `.git/index.lock`, separated from the decision so
/// the decision is a pure function over all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexLockState {
    exists: bool,
    size_bytes: u64,
    /// `None` when the mtime is unreadable — treated as "unknown", never as
    /// "old enough".
    age: Option<Duration>,
    /// The lock's mtime in unix nanoseconds, `None` when unreadable. Absolute
    /// (independent of the injected `now`), so it is a stable identity for "this
    /// exact lock" that the wedge escape hatch compares across passes.
    mtime_nanos: Option<i64>,
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
                mtime_nanos: None,
                holder_present: false,
                git_process_running: false,
            }
        }
    };
    let modified = meta.modified().ok();
    let age = modified.and_then(|modified| now.duration_since(modified).ok());
    let mtime_nanos = modified
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|since_epoch| since_epoch.as_nanos() as i64);
    let (holder_present, git_process_running) = probe_lock_in_use(lock_path);
    IndexLockState {
        exists: true,
        size_bytes: meta.len(),
        age,
        mtime_nanos,
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

fn wedge_state_path(git_dir: &Path) -> PathBuf {
    git_dir.join(WEDGE_STATE_FILE)
}

/// Read the wedge record, or `None` when there is no usable one. Like every
/// other observability read here, a bad file resolves to `None` — the worst it
/// can do is restart the confirmation clock, never fire the escape hatch early.
fn read_wedge_state(git_dir: &Path) -> Option<PersistedIndexLockWedge> {
    let raw = fs::read_to_string(wedge_state_path(git_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_wedge_state(git_dir: &Path, record: &PersistedIndexLockWedge) {
    let Ok(encoded) = serde_json::to_string(record) else {
        return;
    };
    // Same temp-then-rename shape as the push-block record, so a
    // crash mid-write cannot leave a torn file that reads as a matured clock.
    let temp = git_dir.join(format!("{WEDGE_STATE_FILE}.tmp"));
    if fs::write(&temp, encoded).is_ok() && fs::rename(&temp, wedge_state_path(git_dir)).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

fn clear_wedge_state(git_dir: &Path) {
    let _ = fs::remove_file(wedge_state_path(git_dir));
}

/// What the escape hatch should do with a wedged non-empty lock this pass. Pure
/// over the prior observation and the current mtime so the timeout arithmetic is
/// unit-testable without a git repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WedgeDecision {
    /// First observation, or the mtime advanced (a writer touched the index), or
    /// the clock is otherwise unusable — (re)start it with `first_seen = now`.
    /// This is the conservative default: any uncertainty resets the clock.
    StartClock,
    /// Same byte-for-byte frozen lock, but the hard timeout has not elapsed.
    /// Keep refusing and keep the human signal.
    AwaitTimeout,
    /// Same frozen lock, dead the whole time, past the hard timeout. Safe to
    /// back up and auto-reap. Carries how long it stayed wedged, for the log.
    Reap { wedged_secs: u64 },
}

/// The escape-hatch decision. Every uncertain branch resolves to `StartClock`,
/// which only ever *delays* a reap — a single unreadable or ambiguous sample can
/// never mature into a removal.
fn decide_wedge_reap(
    prior: Option<&PersistedIndexLockWedge>,
    current_mtime_nanos: Option<i64>,
    wall_now: DateTime<Utc>,
    hard_timeout: Duration,
    state_path: &Path,
) -> WedgeDecision {
    // No readable mtime means we cannot prove the lock is frozen at all.
    let Some(mtime) = current_mtime_nanos else {
        return WedgeDecision::StartClock;
    };
    // No prior observation — this pass opens the clock.
    let Some(prior) = prior else {
        return WedgeDecision::StartClock;
    };
    // The lock's mtime advanced since we first saw it: a writer is alive and
    // touching the index. Not a corpse — reset the clock.
    if prior.lock_mtime_nanos != mtime {
        return WedgeDecision::StartClock;
    }
    // Same frozen lock. How long have we continuously observed it dead? A
    // missing, unparsable, or future-dated stamp is discarded by `usable_stamp`
    // (the shared future-clock guard), which resets the clock rather than
    // letting a bad stamp confirm an instant reap.
    let Some(first_seen) = usable_stamp(
        Some(&prior.first_seen_at),
        wall_now,
        state_path,
        "index-lock wedge stamp",
    ) else {
        return WedgeDecision::StartClock;
    };
    match elapsed_since_wall(first_seen, wall_now) {
        Some(elapsed) if elapsed >= hard_timeout => WedgeDecision::Reap {
            wedged_secs: elapsed.as_secs(),
        },
        _ => WedgeDecision::AwaitTimeout,
    }
}

/// What an unrecoverable-wedge observation should do about the Sentry channel.
/// Each variant has an explicit arm so a new emitting action cannot silently
/// variant, no catch-all, so a newly added emitting variant cannot silently
/// render as a fresh warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WedgeReportAction {
    /// Not yet a confirmed, unrecoverable wedge — either the warning floor has
    /// not elapsed or HQ has not exhausted recovery — so it stays in the local
    /// log only.
    AwaitConfirmation,
    /// Confirmed unrecoverable, but inside the cooldown floor or past the finite
    /// report budget.
    Suppress,
    /// The first warning for this wedge.
    ReportFirstConfirmed,
    /// A still-unrecoverable wedge crossing the next rung of the finite ladder —
    /// the bounded re-report that keeps a standing wedge visible without flooding.
    ReportEscalation,
}

impl WedgeReportAction {
    fn emits(self) -> bool {
        matches!(
            self,
            WedgeReportAction::ReportFirstConfirmed | WedgeReportAction::ReportEscalation
        )
    }

    /// Tag value, so triage can tell a first warning from a laddered re-warn.
    /// One explicit arm per variant on purpose, exactly as the sibling reporter
    /// documents: a catch-all would render any future emitting variant as
    /// `first-confirmed`.
    fn source(self) -> &'static str {
        match self {
            WedgeReportAction::AwaitConfirmation => "await-confirmation",
            WedgeReportAction::Suppress => "suppressed",
            WedgeReportAction::ReportFirstConfirmed => "first-confirmed",
            WedgeReportAction::ReportEscalation => "episode-escalation",
        }
    }
}

/// Pure warning decision for a wedged non-empty lock, modelled directly on
/// `decide_wedge_report`.
///
/// A warning describes a state a human must act on, so it fires only once BOTH
/// hold: the wedge has stood past `warn_after` (the fixed triage-visibility
/// floor, never the env-tunable reap clock, so field-tuning the escape hatch can
/// neither warn early nor blind triage) AND HQ has actually tried to recover it
/// and failed (`recovery_failed`). A wedge the escape hatch clears never reaches
/// here — that success is a distinct Info notice — so a self-healed episode bills
/// no warning at all.
///
/// Past that gate a finite budget decides, exactly like the sibling. `since_last_report`
/// floors two warnings for one wedge at `cooldown` apart whatever the ladder
/// asks; a never-warned wedge (`None`) has no anchor to floor against. The first
/// clearance always warns; afterwards the wedge re-warns only as its DURABLE age
/// crosses successive `escalation_ages`, and never more than
/// `escalation_ages.len() + 1` times however long it stays wedged. That is the
/// whole fix: an unchanged, already-warned wedge stops re-arming every pass.
///
/// Every threshold is an explicit parameter, so the arithmetic is unit-testable
/// with no git repo and no real clock.
fn decide_wedge_report(
    reports_so_far: usize,
    wedge_age: Duration,
    since_last_report: Option<Duration>,
    recovery_failed: bool,
    warn_after: Duration,
    cooldown: Duration,
    escalation_ages: &[Duration],
) -> WedgeReportAction {
    // Gate: a warning is only for a human-actionable, unrecoverable wedge.
    if !recovery_failed || wedge_age < warn_after {
        return WedgeReportAction::AwaitConfirmation;
    }
    // Cooldown floor: never two warnings for one wedge closer than this, whatever
    // the ladder below allows. A never-warned wedge (`None`) has no anchor.
    if since_last_report.is_some_and(|elapsed| elapsed < cooldown) {
        return WedgeReportAction::Suppress;
    }
    // The first confirmation is always warned.
    if reports_so_far == 0 {
        return WedgeReportAction::ReportFirstConfirmed;
    }
    // Afterwards this wedge re-warns only as it crosses the next rung, measured
    // against the durable wedge age; the ladder is finite by construction, so once
    // the budget is spent the wedge stays visible in the local log but stops
    // billing Sentry.
    if reports_so_far <= escalation_ages.len() && wedge_age >= escalation_ages[reports_so_far - 1] {
        return WedgeReportAction::ReportEscalation;
    }
    WedgeReportAction::Suppress
}

/// Copy a doomed non-empty lock aside before removing it, so a mis-judged
/// partial index stays recoverable for forensics. Lands in the git dir beside
/// the lock — untracked, exactly like the other observability files, so the
/// mirror's own `git add -A` never stages it. Best-effort with a hard rule: if
/// the copy fails we return `None` and the caller must NOT remove the lock, so
/// the only copy of a partial index is never destroyed.
fn back_up_wedged_lock(
    lock_path: &Path,
    git_dir: &Path,
    wall_now: DateTime<Utc>,
) -> Option<PathBuf> {
    // Colons are legal on the target filesystems but awkward everywhere else;
    // swap them so the backup name is portable.
    let stamp = wall_now
        .to_rfc3339_opts(SecondsFormat::Secs, true)
        .replace(':', "-");
    let backup = git_dir.join(format!("index.lock.reaped-{stamp}"));
    match fs::copy(lock_path, &backup) {
        Ok(_) => Some(backup),
        Err(err) => {
            log(
                LOG_TAG,
                &format!(
                    "could not back up {} before reaping ({err}) — leaving the lock in place",
                    lock_path.display()
                ),
            );
            None
        }
    }
}

/// The wedged-but-non-empty log line, shared across every pass that refuses so
/// the human signal stays identical whether the clock is opening, running, or
/// (backup-failed) still stuck. Now says "yet" and names the hard timeout: the
/// state is no longer permanent, but it is still actionable right now.
fn log_wedged_refusal(hq_folder: &str, lock_path: &Path, state: IndexLockState) {
    let message = format!(
        "{hq_folder}: {} is {}s old with no holder and no git process, but is not \
         empty ({}B), so HQ will not remove it yet — a partial index and a live writer \
         look identical from outside. HQ git writes stay blocked until it clears or the \
         hard timeout elapses. Quit HQ Sync, confirm no git is running, then delete {}.",
        lock_path.display(),
        state.age.map(|a| a.as_secs()).unwrap_or(0),
        state.size_bytes,
        lock_path.display(),
    );
    log(LOG_TAG, &message);
}

/// The wedged-but-non-empty branch: track the frozen lock across passes, keep
/// the human signal until the hard timeout, then — and only then — back it up
/// and auto-reap a lock proven dead. Returns whether a lock was removed.
fn handle_wedged_nonempty_lock(
    hq_folder: &str,
    git_dir: &Path,
    lock_path: &Path,
    state: IndexLockState,
    now: SystemTime,
) -> bool {
    let wall_now: DateTime<Utc> = now.into();
    let hard_timeout = wedged_lock_hard_timeout();
    let prior = read_wedge_state(git_dir);
    let decision = decide_wedge_reap(
        prior.as_ref(),
        state.mtime_nanos,
        wall_now,
        hard_timeout,
        &wedge_state_path(git_dir),
    );

    match decision {
        WedgeDecision::Reap { wedged_secs } => {
            // Back up before removing. A failed backup means we keep refusing —
            // never destroy the only copy of a possible partial index.
            let Some(backup) = back_up_wedged_lock(lock_path, git_dir, wall_now) else {
                // Recovery failed: HQ reached the reap but could not back the lock
                // up, so it stays wedged. This is the human-actionable state — bill
                // a warning if the finite budget allows, and persist the spend.
                log_wedged_refusal(hq_folder, lock_path, state);
                report_wedge_if_due(
                    git_dir,
                    prior.as_ref(),
                    wedged_secs,
                    state.size_bytes,
                    wall_now,
                );
                return false;
            };
            match fs::remove_file(lock_path) {
                Ok(()) => {
                    clear_wedge_state(git_dir);
                    log(
                        LOG_TAG,
                        &format!(
                            "{hq_folder}: auto-reaped wedged {} after {wedged_secs}s frozen \
                             (size={}B, mtime unchanged, no holder, no git process) — backed up \
                             to {} — HQ git writes unblocked",
                            lock_path.display(),
                            state.size_bytes,
                            backup.display()
                        ),
                    );
                    report_auto_reaped_index_lock(
                        state.size_bytes,
                        wedged_secs,
                        prior.as_ref().map(|p| p.reports).unwrap_or(0),
                    );
                    true
                }
                Err(err) => {
                    // Recovery failed the other way: the backup exists but the lock
                    // could not be removed (the Windows held-file case). Still an
                    // unrecoverable, human-actionable wedge — bill a warning if the
                    // finite budget allows.
                    log(
                        LOG_TAG,
                        &format!(
                            "{hq_folder}: could not remove wedged {}: {err} (backup at {})",
                            lock_path.display(),
                            backup.display()
                        ),
                    );
                    report_wedge_if_due(
                        git_dir,
                        prior.as_ref(),
                        wedged_secs,
                        state.size_bytes,
                        wall_now,
                    );
                    false
                }
            }
        }
        WedgeDecision::StartClock => {
            // Open (or reset) the confirmation clock — but only when we can pin
            // the lock's identity. Without a readable mtime we cannot prove it
            // stays frozen next pass, so drop any stale record instead.
            match state.mtime_nanos {
                Some(mtime) => write_wedge_state(
                    git_dir,
                    &PersistedIndexLockWedge {
                        first_seen_at: wall_now.to_rfc3339_opts(SecondsFormat::Secs, true),
                        lock_mtime_nanos: mtime,
                        size_bytes: state.size_bytes,
                        reports: 0,
                        last_report_at: None,
                    },
                ),
                None => clear_wedge_state(git_dir),
            }
            // Every refusing pass still logs in full on the machine it happened on;
            // only the Sentry channel now waits for a confirmed, unrecoverable
            // wedge (the reap-failure branches above). This is what turns one
            // self-healing episode from a warning per pass into zero.
            log_wedged_refusal(hq_folder, lock_path, state);
            false
        }
        WedgeDecision::AwaitTimeout => {
            // Still refusing, still inside the hard-timeout window: keep the local
            // signal but do not bill Sentry. The reap has not even been attempted,
            // so there is nothing unrecoverable to warn about yet.
            log_wedged_refusal(hq_folder, lock_path, state);
            false
        }
    }
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
            // The one immortal state — now bounded by a hard timeout that only
            // fires once a live writer is effectively impossible.
            return handle_wedged_nonempty_lock(hq_folder, git_dir, &lock_path, state, now);
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
        } else {
            // No lock at all — drop any wedge record left by a prior episode so
            // a fresh lock can never coincidentally match a stale mtime.
            clear_wedge_state(git_dir);
        }
        return false;
    }
    match fs::remove_file(&lock_path) {
        Ok(()) => {
            // An empty reap clears the same wedge record: whatever we just
            // removed, no wedge clock should outlive it.
            clear_wedge_state(git_dir);
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

/// The one lock state the reaper cannot safely clear even after the hard timeout.
/// Surfaced centrally so a wedged machine shows up in triage instead of only in a
/// local log file — but now on a finite budget (see [`decide_wedge_report`]), so
/// one standing wedge bills at most `escalation_ages.len() + 1` warnings rather
/// than one per mirror pass. `reports_before` is how many warnings this wedge had
/// already billed (0 for the first); `source` distinguishes the first warning from
/// a laddered re-warn. The `git_mirror_kind` and `lock_size_bytes` tags and the
/// message string are unchanged, so the existing issue group and any saved triage
/// query keep resolving.
fn report_wedged_index_lock(size_bytes: u64, reports_before: usize, source: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("git_mirror_kind", "index-lock-wedged");
            scope.set_tag("lock_size_bytes", size_bytes.to_string());
            scope.set_tag("wedge_reports", reports_before.to_string());
            scope.set_tag("source", source);
        },
        || {
            sentry::capture_message(
                "[git-mirror] .git/index.lock is orphaned but non-empty; HQ git writes are \
                 blocked and automatic recovery is unsafe until the hard timeout elapses",
                sentry::Level::Warning,
            );
        },
    );
}

/// The escape hatch fired: a non-empty lock stayed frozen and unheld past the
/// hard timeout, so HQ backed it up and removed it. A distinct signal from
/// [`report_wedged_index_lock`] so triage can tell "still wedged, watching" from
/// "recovered automatically". Emitted at `Info`, not `Warning`: HQ healed itself
/// with zero human action, so this must stay observable for rate analysis without
/// minting a new unresolved warning-level issue. `wedge_reports` carries how many
/// warnings the episode billed before recovering. The message string and the
/// `git_mirror_kind`, `lock_size_bytes` and `wedged_secs` tags are byte-identical
/// to before, so existing triage queries and dashboards keep resolving.
fn report_auto_reaped_index_lock(size_bytes: u64, wedged_secs: u64, wedge_reports: usize) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("git_mirror_kind", "index-lock-auto-reaped");
            scope.set_tag("lock_size_bytes", size_bytes.to_string());
            scope.set_tag("wedged_secs", wedged_secs.to_string());
            scope.set_tag("wedge_reports", wedge_reports.to_string());
        },
        || {
            sentry::capture_message(
                "[git-mirror] auto-reaped a non-empty .git/index.lock after the hard timeout: it \
                 stayed byte-for-byte frozen, unheld, with no git process the entire window, so \
                 HQ backed it up and removed it to unblock git writes",
                sentry::Level::Info,
            );
        },
    );
}

/// In-memory mirror of each wedge's report budget, keyed by resolved git dir.
///
/// Two failure modes the durable record alone cannot cover, both raised in review:
///   1. A full or read-only `.git` makes the best-effort [`write_wedge_state`]
///      fail, so the on-disk `reports` never advances and every subsequent pass
///      would re-emit `first-confirmed` — reopening the very flood this change
///      removes. The authoritative count lives here instead, so a failed disk
///      write cannot un-pace a wedge within a process.
///   2. [`reap_stale_index_lock_on_launch`] runs the reaper on its own thread
///      WITHOUT the cross-process mirror lock, so it can overlap a normal pass.
///      Holding this mutex across the whole read/decide/emit/write serialises
///      them, so two threads cannot both bill `first-confirmed` and lose an
///      increment.
///
/// The durable record remains the cross-restart carrier; this is seeded from it
/// and reconciled with it (the higher count and more recent anchor win), so
/// another app instance advancing the record is respected too. Keyed by git dir
/// with the wedge's `first_seen_at` stored inside, so a new wedge (a changed
/// `first_seen`, after a reset or a recovery) transparently starts a fresh budget
/// with no explicit teardown.
static WEDGE_REPORT_STATE: LazyLock<Mutex<HashMap<PathBuf, WedgeReportBudget>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The process-local half of one wedge's finite report budget. `first_seen_at`
/// is the wedge identity: a mismatch means this entry belongs to a prior wedge
/// and must be discarded before use.
#[derive(Debug, Clone, Default)]
struct WedgeReportBudget {
    first_seen_at: Option<String>,
    reports: usize,
    last_report_at: Option<DateTime<Utc>>,
}

/// Bill one wedge warning if the finite budget allows, and record the spend.
/// Called only from the reap-failure branches — the states where HQ tried to
/// recover a wedged non-empty lock and could not — so `recovery_failed` is always
/// true here; the pure [`decide_wedge_report`] takes it as a parameter for
/// testability. `wedged_secs` is the durable wedge age the reap decision measured.
/// A missing prior record (never expected past a reap, which only fires against a
/// matured record) is treated conservatively as "nothing to warn from", skipped.
///
/// The read/decide/emit/write runs under [`WEDGE_REPORT_STATE`], with the
/// in-memory budget authoritative and the durable record a cross-restart backup,
/// so neither a failed disk write nor an overlapping launch-thread reap can
/// re-open the flood.
fn report_wedge_if_due(
    git_dir: &Path,
    prior: Option<&PersistedIndexLockWedge>,
    wedged_secs: u64,
    size_bytes: u64,
    wall_now: DateTime<Utc>,
) {
    let Some(prior) = prior else {
        return;
    };
    let mut state = WEDGE_REPORT_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = state.entry(git_dir.to_path_buf()).or_default();
    // A budget carrying a different `first_seen` belongs to a prior wedge (a reset
    // clock, or a fresh wedge after a recovery) — discard it and start clean from
    // this wedge's durable record.
    if entry.first_seen_at.as_deref() != Some(prior.first_seen_at.as_str()) {
        *entry = WedgeReportBudget {
            first_seen_at: Some(prior.first_seen_at.clone()),
            reports: 0,
            last_report_at: None,
        };
    }
    // Reconcile with the durable record: the higher count and more recent anchor
    // win, so neither a failed in-process write nor another app instance's write
    // can under-count. A missing, unparsable or future-dated persisted stamp
    // resolves to `None` (the shared future-clock fail-safe, via `usable_stamp`).
    let disk_last = usable_stamp(
        prior.last_report_at.as_ref(),
        wall_now,
        &wedge_state_path(git_dir),
        "wedge report timestamp",
    );
    let reports = entry.reports.max(prior.reports);
    let last_report_at = match (entry.last_report_at, disk_last) {
        (Some(mem), Some(disk)) => Some(mem.max(disk)),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    };
    let since_last_report = last_report_at.and_then(|at| elapsed_since_wall(at, wall_now));
    let action = decide_wedge_report(
        reports,
        Duration::from_secs(wedged_secs),
        since_last_report,
        true,
        WEDGE_WARN_AFTER,
        WEDGE_REPORT_COOLDOWN,
        &WEDGE_ESCALATION_AGES,
    );
    if action.emits() {
        report_wedged_index_lock(size_bytes, reports, action.source());
        let new_reports = reports + 1;
        // In-memory first (cannot fail), then the durable record (best-effort), so
        // the spend is never lost even when `.git` cannot be written.
        entry.reports = new_reports;
        entry.last_report_at = Some(wall_now);
        write_wedge_state(
            git_dir,
            &PersistedIndexLockWedge {
                first_seen_at: prior.first_seen_at.clone(),
                lock_mtime_nanos: prior.lock_mtime_nanos,
                size_bytes: prior.size_bytes,
                reports: new_reports,
                last_report_at: Some(wall_now.to_rfc3339_opts(SecondsFormat::Secs, true)),
            },
        );
    }
}

/// The recovery outcome of one wedged-lock observation, for the test seam below.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, Copy)]
pub enum WedgeRecoveryOutcomeForTest {
    /// The escape hatch backed up and removed the lock: emit the Info notice.
    Recovered,
    /// Backup or removal failed: route through the finite warning budget.
    Failed,
}

/// Test-only production reporting seam for the wedged-index-lock path.
///
/// Drives the SAME [`decide_wedge_report`] budget decision and the SAME reporter
/// functions the mirror's reap-failure and reap-success branches use, over a
/// supplied report budget and clocks, without needing a git repo. An hq-telemetry
/// envelope test drives this through the real `before_send` scrubber and asserts
/// on the resulting envelopes, so it measures production behaviour rather than a
/// re-implementation of it. Returns the wedge's new report count so a caller can
/// chain observations of one standing wedge.
#[cfg(any(test, feature = "test-support"))]
pub fn drive_wedge_report_for_test(
    reports_so_far: usize,
    wedge_age_secs: u64,
    secs_since_last_report: Option<u64>,
    outcome: WedgeRecoveryOutcomeForTest,
    size_bytes: u64,
) -> usize {
    match outcome {
        WedgeRecoveryOutcomeForTest::Recovered => {
            report_auto_reaped_index_lock(size_bytes, wedge_age_secs, reports_so_far);
            reports_so_far
        }
        WedgeRecoveryOutcomeForTest::Failed => {
            let action = decide_wedge_report(
                reports_so_far,
                Duration::from_secs(wedge_age_secs),
                secs_since_last_report.map(Duration::from_secs),
                true,
                WEDGE_WARN_AFTER,
                WEDGE_REPORT_COOLDOWN,
                &WEDGE_ESCALATION_AGES,
            );
            if action.emits() {
                report_wedged_index_lock(size_bytes, reports_so_far, action.source());
                reports_so_far + 1
            } else {
                reports_so_far
            }
        }
    }
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

/// Advisory `flock` held for one git critical section. The file intentionally
/// persists: the OS releases advisory locks on process exit, so unlike
/// `.git/index.lock` this one cannot go stale after a crash.
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

fn push_lock_path(git_dir: &Path) -> PathBuf {
    git_dir.join("hq-sync-mirror-push.lock")
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
    mirror_after_sync_with_flag_snapshot_timeout(hq_folder, Duration::ZERO);
}

/// Wait for the first hq-flags snapshot before taking the first mirror image.
/// The app passes its existing startup watchdog bound; a timeout uses the old
/// default-off path for this pass and is logged once.
pub fn mirror_after_sync_with_flag_snapshot_timeout(hq_folder: &str, timeout: Duration) {
    mirror_after_sync_with_gate(hq_folder, timeout, &SCOPE_QUARANTINE_GATE);
}

fn mirror_after_sync_with_gate(hq_folder: &str, timeout: Duration, gate: &ScopeQuarantineGate) {
    if !Path::new(hq_folder).join(".git").exists() {
        return;
    }
    let gate_decision = gate.resolve_first_mirror(timeout);
    if gate_decision.timed_out {
        log(
            LOG_TAG,
            &format!(
                "{hq_folder}: mirror flag snapshot was not ready within {timeout:?}; using the default-off path for this first pass"
            ),
        );
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

    // Latched off by the size cap. Return before acquiring any lock or making
    // any git write: "disabled" has to mean the mirror leaves this repo alone,
    // down to the index-lock contention every git write costs.
    if let Some(record) = read_disable_latch(&git_dir) {
        log_disable_notice(hq_folder, &git_dir, &record);
        return;
    }

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

    let outcome = match run_mirror(hq_folder, &git_dir, gate_decision.enabled) {
        Ok(outcome) => outcome,
        Err(e) => {
            log(LOG_TAG, &format!("{hq_folder}: {e}"));
            // Failure path: our git child may have died holding `index.lock`. We
            // hold the mirror lock and every child we spawned has been reaped, so
            // an empty, unheld lock at this instant is ours and orphaned — no age
            // grace needed. The other conjuncts still apply.
            reap_index_lock_if_stale(hq_folder, &git_dir, Duration::ZERO, SystemTime::now());
            MirrorOutcome::NoPush
        }
    };

    // The local snapshot is complete. Release both mirror locks before the
    // network push, which may legitimately run for up to an hour.
    drop(_mirror_lock);
    drop(_guard);

    if outcome == MirrorOutcome::Push {
        push_after_mirror(hq_folder, &git_dir);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MirrorOutcome {
    NoPush,
    Push,
}

/// Render a byte count for a log line at the coarsest sensible unit.
fn human_bytes(bytes: u64) -> String {
    const GIB: f64 = (1024 * 1024 * 1024) as f64;
    const MIB: f64 = (1024 * 1024) as f64;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.2} GiB", b / GIB)
    } else {
        format!("{:.1} MiB", b / MIB)
    }
}

/// Sum the blob sizes of the *staged* snapshot — the tree the next commit would
/// record, i.e. the index after `run_mirror`'s `git add -A`. Measuring the index
/// rather than HEAD is what lets the gate catch a newly-added oversized file on
/// the same pass it appears, before it is ever committed and pushed into history
/// where untracking can no longer remove it.
///
/// `git write-tree` serializes the current index into a (dangling, gc-able) tree
/// object without touching HEAD or committing; `git ls-tree -l` then reports each
/// blob's size inline. A failed measurement fails CLOSED — it errors rather than
/// reporting 0 bytes, because a 0 would send `enforce_mirror_size_cap` down the
/// under-cap path and let an unmeasured, possibly-oversized index commit and push
/// (the same fail-closed rule used for unmeasurable mirror state). A genuinely
/// empty index still measures 0 via the success path (`write-tree` returns the
/// empty-tree id and `ls-tree` yields no rows). Non-blob entries (submodule /
/// knowledge gitlinks, mode 160000) carry a `-` size column and are skipped.
fn staged_content_bytes(hq_folder: &str) -> Result<u64, String> {
    let tree = git_output(hq_folder, &["write-tree"], GIT_INDEX_TIMEOUT)?;
    if !tree.status.success() {
        return Err(format!(
            "git write-tree failed while measuring the staged snapshot: {}",
            String::from_utf8_lossy(&tree.stderr).trim()
        ));
    }
    let tree_sha = String::from_utf8_lossy(&tree.stdout).trim().to_string();
    if tree_sha.is_empty() {
        return Err("git write-tree produced no tree id".to_string());
    }
    let out = git_output(
        hq_folder,
        &["ls-tree", "-r", "-l", "-z", &tree_sha],
        GIT_INDEX_TIMEOUT,
    )?;
    if !out.status.success() {
        return Err(format!(
            "git ls-tree failed while measuring the staged snapshot: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut total: u64 = 0;
    for record in out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        // Record shape: `<mode> SP <type> SP <sha> SP <size> TAB <path>`. Only
        // the metadata left of the TAB is needed; the path may hold arbitrary
        // bytes and is never parsed.
        let meta_end = match record.iter().position(|b| *b == b'\t') {
            Some(i) => i,
            None => continue,
        };
        let meta = String::from_utf8_lossy(&record[..meta_end]);
        let mut fields = meta.split_whitespace();
        let _mode = fields.next();
        let typ = fields.next();
        let _sha = fields.next();
        let size = fields.next();
        if typ != Some("blob") {
            continue;
        }
        if let Some(bytes) = size.and_then(|v| v.parse::<u64>().ok()) {
            total = total.saturating_add(bytes);
        }
    }
    Ok(total)
}

/// Refuse the pass and latch the mirror off when the staged snapshot has
/// crossed [`resolve_mirror_size_cap`].
///
/// This is the whole of the size policy now. There is no escalation ladder, no
/// `.gitignore` rewriting and no `git rm --cached`: an automated snapshot that
/// silently untracks a user's directories to stay under a ceiling is doing
/// something the user never asked for and would not find out about until they
/// went looking for the history. Over the cap, the mirror stops and says so.
///
/// Returns `true` when the pass must be abandoned. Fails **closed** — an
/// unmeasurable index refuses the pass without latching, since a measurement
/// error is not evidence of size.
fn size_latch_tripped(hq_folder: &str, git_dir: &Path) -> Result<bool, String> {
    let cap = resolve_mirror_size_cap();
    let staged = staged_content_bytes(hq_folder)?;
    if staged <= cap {
        return Ok(false);
    }
    write_disable_latch(
        git_dir,
        staged,
        cap,
        DisableReason::StagedSnapshot,
        Utc::now(),
    );
    log(
        LOG_TAG,
        &format!(
            "{hq_folder}: staged content {} crossed the {} cap — disabling the git mirror for this repo.",
            human_bytes(staged),
            human_bytes(cap),
        ),
    );
    // Re-read rather than reusing the in-memory record, so the notice reflects
    // what actually landed on disk (and still prints if the write failed).
    let record = read_disable_latch(git_dir).unwrap_or(PersistedDisable {
        disabled_at: String::new(),
        measured_bytes: staged,
        cap_bytes: cap,
        reason: Some(DisableReason::StagedSnapshot),
    });
    log_disable_notice(hq_folder, git_dir, &record);
    Ok(true)
}

/// Packed size of the objects reachable from HEAD but not from the upstream —
/// i.e. what a push would send. `None` when it can't be measured (no upstream, or
/// an older git without `rev-list --disk-usage`).
fn unpushed_pack_bytes(hq_folder: &str) -> Option<u64> {
    let out = git_output(
        hq_folder,
        &["rev-list", "--disk-usage", "--objects", "@{u}..HEAD"],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .ok()
}

/// Resolve whether to push after a mirror pass that committed. A commit with no
/// upstream → local-only snapshot.
fn push_decision(hq_folder: &str) -> Result<MirrorOutcome, String> {
    let upstream = git_output(
        hq_folder,
        &["rev-parse", "--abbrev-ref", "@{u}"],
        GIT_INDEX_TIMEOUT,
    )?;
    if !upstream.status.success() {
        log(LOG_TAG, &format!("{hq_folder}: no upstream, skipping push"));
        return Ok(MirrorOutcome::NoPush);
    }
    // The oversized-history backstop is enforced in `push_with_backoff`, right
    // before `git push` — that is after the mirror lock is released, so it re-reads
    // the true HEAD and can't be fooled by another writer advancing the branch
    // between this decision and the push.
    Ok(MirrorOutcome::Push)
}

/// The measured packed size when the objects a push would send exceed the cap,
/// `None` otherwise. The staged-snapshot latch only sees the tree the *next*
/// commit would record, so an oversized blob already sitting in an unpushed local
/// ancestor — committed by the HQ autocommit hook, or by the user directly —
/// would otherwise still reach the remote. Checked in `push_with_backoff` (not in
/// `push_decision`), so a branch advanced by another writer after the snapshot was
/// validated is still caught. Fail-open when it can't be measured (older git
/// without `rev-list --disk-usage`) — the remote's own size limit remains the hard
/// backstop.
///
/// Returns the byte count rather than a bool so the caller records the *same*
/// snapshot it decided on. Measuring a second time to fill in the record would
/// re-read a HEAD that a concurrent reset or rebase may have shrunk in between,
/// and could persist a permanent latch stamped with a now-under-cap figure — or
/// with 0, if the second read failed outright.
fn unpushed_history_over_cap(hq_folder: &str) -> Option<u64> {
    let bytes = unpushed_pack_bytes(hq_folder)?;
    (bytes > resolve_mirror_size_cap()).then_some(bytes)
}

fn stage_mirror_changes(hq_folder: &str) -> Result<(), String> {
    let out = git_output(hq_folder, &["add", "-A"], GIT_INDEX_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!(
            "git add -A failed (exit {}): {}",
            out.status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string()),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Git can return success after partially staging when a nested tracked
    // directory cannot be read. Treat those warnings as an error so the partial
    // index never turns an unreadable tree into a deletion commit.
    let stderr = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    if [
        "permission denied",
        "access is denied",
        "could not open directory",
        "unable to read",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
    {
        return Err(
            "git add -A reported an unreadable path; no mirror commit was made".to_string(),
        );
    }
    Ok(())
}

fn ensure_mirror_root_readable(hq_folder: &str) -> Result<(), String> {
    let entries =
        fs::read_dir(hq_folder).map_err(|error| format!("mirror root cannot be read: {error}"))?;
    for entry in entries {
        entry.map_err(|error| format!("mirror root cannot be read: {error}"))?;
    }
    Ok(())
}

fn run_mirror(
    hq_folder: &str,
    git_dir: &Path,
    scope_quarantine_moves_enabled: bool,
) -> Result<MirrorOutcome, String> {
    // Re-check the latch now that the mirror lock is held. `mirror_after_sync`
    // already checked, but that check happens *before* the lock, and the push
    // path deliberately runs *without* it — so `push_with_backoff` can latch this
    // root during the window between another invocation's pre-lock check and its
    // arrival here. Without this second read, that invocation would go on to
    // stage and commit into a repo that is already disabled.
    if let Some(record) = read_disable_latch(git_dir) {
        log_disable_notice(hq_folder, git_dir, &record);
        return Ok(MirrorOutcome::NoPush);
    }

    // Pre-run self-heal: clear an orphaned lock from an earlier killed run so
    // this cycle isn't the third one in a row to fail for the same reason.
    reap_index_lock_if_stale(hq_folder, git_dir, STALE_LOCK_MIN_AGE, SystemTime::now());

    // A failed root read must not be interpreted by Git as an empty tree.
    // Check before and after staging; Git command failures also propagate.
    // Stage the working tree first, then measure the *staged snapshot*, so a
    // newly-added oversized file is caught before it is committed — measuring
    // HEAD instead would let this pass commit and push it into history, where
    // nothing short of a history rewrite could remove it again.
    ensure_mirror_root_readable(hq_folder)?;
    stage_mirror_changes(hq_folder)?;
    ensure_mirror_root_readable(hq_folder)?;

    // The scope-shrink path preserves clean out-of-scope files under
    // `.hq/scope-quarantine/<journalSlug>/<original path>`. `.hq` is ignored,
    // so `git add -A` stages the source side as a deletion. When the registry
    // gate is enabled, restore only matching source entries in the index; the
    // worktree remains untouched and later mirror passes repeat this check.
    if scope_quarantine_moves_enabled {
        let restored = restore_scope_quarantine_move_index_entries(hq_folder)?;
        if restored > 0 {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: kept {restored} scope-quarantined file moves out of the mirror index"
                ),
            );
        }
    }

    // Over the cap: latch the mirror off. This pass commits nothing and pushes
    // nothing, and neither `mirror_after_sync` nor this function will get past
    // the latch again until it is cleared by hand.
    //
    // The index is left exactly as the `add -A` above left it. An earlier draft
    // ran `git reset -q` here to "restore" it, which was strictly worse for
    // anyone who had staged a selection by hand: `add -A` at least keeps their
    // staged content staged (as part of a superset), while the reset empties the
    // index outright — destroying that selection on a pass that otherwise changes
    // nothing. Measuring without disturbing the index at all would need a
    // separate temporary index, and seeding one per pass would re-hash the whole
    // working tree every cycle; on the repo sizes this guard exists for, that
    // cost is worse than the thing it avoids.
    if size_latch_tripped(hq_folder, git_dir)? {
        return Ok(MirrorOutcome::NoPush);
    }

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
            return Ok(MirrorOutcome::NoPush);
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

    let deletion_count = count_staged_deletions(hq_folder)?.count;

    // ISO-8601 to the second; sortable in `git log` without quoting issues.
    let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let msg = format!("hq-sync: {now_iso}");
    // `--no-gpg-sign` is not optional here. The mirror runs from a background
    // daemon with no TTY and no GUI session, so when the user has
    // `commit.gpgsign = true` globally, gpg cannot reach pinentry and the commit
    // dies with "gpg: signing failed: No pinentry" → "fatal: failed to write
    // commit object". An automated snapshot gains nothing from a signature.
    run_git(
        hq_folder,
        &["commit", "--no-gpg-sign", "--no-verify", "-m", &msg],
        GIT_INDEX_TIMEOUT,
    )?;
    if deletion_count > 0 {
        log(
            LOG_TAG,
            &format!("deletion commit: deleted_paths={deletion_count}"),
        );
    } else {
        log(LOG_TAG, &format!("{hq_folder}: committed \"{msg}\""));
    }

    // A commit landed; push if there is an upstream. Covers detached HEAD,
    // never-pushed branches, and one-off forks — user runs `git push -u` once,
    // then later syncs push.
    push_decision(hq_folder)
}

fn push_after_mirror(hq_folder: &str, git_dir: &Path) {
    let _guard = match PUSH_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log(
                LOG_TAG,
                &format!("{hq_folder}: previous push still in flight, skipping push"),
            );
            return;
        }
    };

    let _push_lock = match try_acquire_mirror_lock(&push_lock_path(git_dir)) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            log(
                LOG_TAG,
                &format!("{hq_folder}: another HQ process is pushing, skipping push"),
            );
            return;
        }
        Err(e) => {
            log(LOG_TAG, &format!("{hq_folder}: {e}"));
            return;
        }
    };

    push_with_backoff(hq_folder, git_dir, Utc::now());
}

/// Push, unless a recent rejection says it is pointless.
///
/// A push failure never fails the mirror: the commit already landed, and the
/// local snapshot is the part that matters. What changes here is *repetition* —
/// a rejection that retrying cannot fix backs the mirror off for
/// [`PUSH_BLOCK_COOLDOWN`] instead of recurring every cycle.
fn push_with_backoff(hq_folder: &str, git_dir: &Path, now: DateTime<Utc>) {
    // Size backstop, re-reading the true HEAD: the mirror lock was released after
    // the snapshot was validated, so another writer (the autocommit hook, a second
    // mirror) could have advanced the branch to a never-measured — possibly
    // oversized — commit. Latch off rather than push it: an oversized ancestor is
    // a settled fact about history that no later pass of this daemon can undo, so
    // retrying is pure noise.
    //
    // This runs *before* the push-backoff early return, not after. A permanent
    // rejection parks an active block for PUSH_BLOCK_COOLDOWN, and a check placed
    // after that return would simply never execute for six hours. Meanwhile
    // `run_mirror` keeps committing every cycle, so history committed-then-deleted
    // during the block can push the unpushed set over the cap while the working
    // tree stays comfortably under it — the exact case the latch exists for, going
    // unnoticed for the whole cooldown.
    if let Some(measured) = unpushed_history_over_cap(hq_folder) {
        let cap = resolve_mirror_size_cap();
        write_disable_latch(git_dir, measured, cap, DisableReason::UnpushedHistory, now);
        log(
            LOG_TAG,
            &format!(
                "{hq_folder}: unpushed history {} exceeds the {} cap in packed form — disabling the git mirror for this repo.",
                human_bytes(measured),
                human_bytes(cap),
            ),
        );
        let record = read_disable_latch(git_dir).unwrap_or(PersistedDisable {
            disabled_at: String::new(),
            measured_bytes: measured,
            cap_bytes: cap,
            reason: Some(DisableReason::UnpushedHistory),
        });
        log_disable_notice(hq_folder, git_dir, &record);
        return;
    }

    let existing = read_push_block(git_dir);
    if push_block_is_active(existing.as_ref(), now) {
        // One quiet line, not the full multi-line remote stderr — the loud,
        // actionable version was already logged when the block was recorded.
        if let Some(block) = existing {
            log(
                LOG_TAG,
                &format!("{hq_folder}: push skipped — {} (backing off)", block.reason),
            );
        }
        return;
    }

    let out = match git_output(hq_folder, &["push"], GIT_PUSH_TIMEOUT) {
        Ok(out) => out,
        Err(e) => {
            log(LOG_TAG, &format!("{hq_folder}: git push: {e}"));
            return;
        }
    };

    if out.status.success() {
        clear_push_block(git_dir);
        log(LOG_TAG, &format!("{hq_folder}: push ok"));
        return;
    }

    let stderr = String::from_utf8_lossy(&out.stderr);
    match classify_push_failure(&stderr) {
        PushFailure::Permanent { reason } => {
            write_push_block(
                git_dir,
                &PersistedPushBlock {
                    blocked_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
                    reason: reason.clone(),
                },
            );
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: push rejected and retrying cannot fix it — {reason}. \
                     Backing off {}h. Remove the file from history, then push by hand.",
                    PUSH_BLOCK_COOLDOWN.as_secs() / 3600
                ),
            );
        }
        PushFailure::Transient => {
            log(
                LOG_TAG,
                &format!(
                    "{hq_folder}: git push failed (exit {}): {}",
                    out.status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".to_string()),
                    stderr.trim()
                ),
            );
        }
    }
}

/// Count staged deletions. Rename detection keeps a content-preserving move
/// from appearing as a deletion in the commit log.
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
    Ok(StagedDeletions {
        count: count_nul_terminated(&out.stdout),
    })
}

#[derive(Debug)]
struct StagedDeletionRecord {
    mode: String,
    blob: String,
    path: String,
}

const SCOPE_QUARANTINE_HASH_CACHE_FILE: &str = "scope-quarantine-hash-cache.json";
const SCOPE_QUARANTINE_HASH_CACHE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct ScopeQuarantineHashCache {
    version: u32,
    entries: BTreeMap<String, ScopeQuarantineHashCacheEntry>,
}

impl Default for ScopeQuarantineHashCache {
    fn default() -> Self {
        Self {
            version: SCOPE_QUARANTINE_HASH_CACHE_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ScopeQuarantineHashCacheEntry {
    source_path: String,
    copy_path: String,
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
    clean_filter_context: String,
    blob: String,
}

struct ScopeQuarantineFilterContext {
    config_fingerprint: String,
    info_attributes_file: PathBuf,
    global_attributes_file: Option<PathBuf>,
    system_attributes_file: Option<PathBuf>,
}

/// Restore staged source paths only when a regular-file copy exists under a
/// scope-shrink journal and its lifecycle is newer than the last HEAD commit
/// containing that path. A file that returned to scope and was committed has a
/// newer path commit than its old quarantine directory, so a later deliberate
/// deletion remains staged for the mirror commit.
fn restore_scope_quarantine_move_index_entries(hq_folder: &str) -> Result<usize, String> {
    restore_scope_quarantine_move_index_entries_with_hasher(hq_folder, hash_quarantined_copy)
}

fn restore_scope_quarantine_move_index_entries_with_hasher<H>(
    hq_folder: &str,
    mut hash_copy: H,
) -> Result<usize, String>
where
    H: FnMut(&str, &str, &Path) -> Option<String>,
{
    let roots = scope_quarantine_journal_roots(Path::new(hq_folder));
    if roots.is_empty() {
        return Ok(0);
    }

    let records = staged_deletion_records(hq_folder)?;
    if records.is_empty() {
        return Ok(0);
    }

    let filter_context = scope_quarantine_filter_context(hq_folder);
    if filter_context.is_none() {
        log(
            LOG_TAG,
            "quarantine hash cache context unavailable; verifying copies with Git on every pass",
        );
    }
    let mut cache = read_scope_quarantine_hash_cache(hq_folder);
    let mut cache_changed = false;
    let mut seen_cache_keys = HashSet::new();
    let mut candidates = Vec::new();
    for record in records {
        // Symlinks and submodules have different Git blob semantics. Leave
        // them on the existing deletion path rather than guessing.
        if !matches!(record.mode.as_str(), "100644" | "100755") {
            continue;
        }
        let relative = Path::new(&record.path);
        if !is_normal_relative_path(relative) {
            continue;
        }

        // Keep the freshest matching copy when a path appears in more than one
        // journal. The containing directory's mtime records when this journal
        // entry was moved; the file's own mtime survives a rename and is not
        // useful provenance.
        let mut freshest_matching_move: Option<(&Path, SystemTime)> = None;
        for root in &roots {
            let Some(copy) = regular_file_below(root, relative) else {
                continue;
            };
            if !hash_quarantined_copy_cached(
                hq_folder,
                &record.path,
                &copy,
                filter_context.as_ref(),
                &mut cache,
                &mut cache_changed,
                &mut seen_cache_keys,
                &mut hash_copy,
            )
            .is_some_and(|blob| blob == record.blob)
            {
                continue;
            }
            let Some(modified) = copy
                .parent()
                .and_then(|parent| fs::metadata(parent).ok())
                .and_then(|metadata| metadata.modified().ok())
            else {
                continue;
            };
            if freshest_matching_move.map_or(true, |(_, current)| modified > current) {
                freshest_matching_move = Some((root.as_path(), modified));
            }
        }
        if let Some((_, journal_modified)) = freshest_matching_move {
            candidates.push((
                record.path,
                truncate_system_time_to_seconds(journal_modified),
            ));
        }
    }

    if filter_context.is_some() {
        let before = cache.entries.len();
        cache.entries.retain(|key, _| seen_cache_keys.contains(key));
        cache_changed |= cache.entries.len() != before;
        if cache_changed {
            write_scope_quarantine_hash_cache(hq_folder, &cache);
        }
    }

    if candidates.is_empty() {
        return Ok(0);
    }

    let Some(head_commit_time) = head_commit_time(hq_folder) else {
        // Provenance could not be established. Leave every source deletion on
        // the ordinary staged-deletion path rather than treating uncertainty as a move.
        return Ok(0);
    };
    let Some(head_moves_after_journal) = head_moves_after_journal(hq_folder, &candidates) else {
        // A missing or unreadable reflog cannot establish that HEAD stayed on
        // the same history, so preserve staged deletions conservatively.
        return Ok(0);
    };
    let uncertain = candidates
        .iter()
        .filter(|(path, journal_modified)| {
            journal_requires_path_history(*journal_modified, head_commit_time)
                || head_moves_after_journal.contains(path)
        })
        .collect::<Vec<_>>();
    let latest_commits = if uncertain.is_empty() {
        HashMap::new()
    } else {
        let paths = uncertain
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        let since = uncertain
            .iter()
            .map(|(_, modified)| *modified)
            .min()
            .unwrap_or(head_commit_time);
        let Some(latest_commits) = latest_path_commit_times(hq_folder, &paths, since) else {
            // If Git history cannot establish whether the path was later
            // returned to scope, preserve the staged deletion rather than
            // treating an unverified quarantine copy as current provenance.
            return Ok(0);
        };
        latest_commits
    };

    let restored_paths = candidates
        .into_iter()
        .filter_map(|(path, journal_modified)| {
            let last_path_commit = latest_commits.get(&path);
            let journal_is_current = journal_modified > head_commit_time
                || last_path_commit.map_or(true, |committed_at| journal_modified > *committed_at);
            // After checkout/reset/rebase, HEAD-only path history cannot prove
            // that this journal is current relative to the branch that was left.
            // Keep the deletion guarded even when the current history is older.
            (journal_is_current && !head_moves_after_journal.contains(&path)).then_some(path)
        })
        .collect::<Vec<_>>();

    reset_quarantined_mirror_paths(hq_folder, &restored_paths)
}

/// Reset only the selected source deletions to their HEAD entries. NUL-delimited
/// pathspec files avoid putting thousands of long filenames in Git's argv,
/// which exceeds Windows' command-line limit.
fn reset_quarantined_mirror_paths(hq_folder: &str, paths: &[String]) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let pathspec = write_pathspec_file(hq_folder, "mirror-quarantine-reset-", paths)?;
    let pathspec_arg = format!("--pathspec-from-file={}", pathspec.path().display());
    let out = git_output(
        hq_folder,
        &[
            "--literal-pathspecs",
            "reset",
            "-q",
            "HEAD",
            &pathspec_arg,
            "--pathspec-file-nul",
        ],
        GIT_INDEX_TIMEOUT,
    )
    .map_err(|_| "git reset of quarantined mirror paths failed to run".to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git reset of {} quarantined mirror paths failed (exit {})",
            paths.len(),
            out.status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string())
        ));
    }
    Ok(paths.len())
}

fn write_pathspec_file(
    hq_folder: &str,
    prefix: &str,
    paths: &[String],
) -> Result<tempfile::NamedTempFile, String> {
    let metadata_dir = Path::new(hq_folder).join(".hq");
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .tempfile_in(metadata_dir)
        .map_err(|_| "could not create a temporary Git pathspec file".to_string())?;
    for path in paths {
        file.write_all(path.as_bytes())
            .and_then(|()| file.write_all(&[0]))
            .map_err(|_| "could not write a temporary Git pathspec file".to_string())?;
    }
    file.flush()
        .map_err(|_| "could not flush a temporary Git pathspec file".to_string())?;
    Ok(file)
}

fn head_moves_after_journal(
    hq_folder: &str,
    candidates: &[(String, SystemTime)],
) -> Option<HashSet<String>> {
    if candidates.is_empty() {
        return Some(HashSet::new());
    }

    let reflog = git_output(
        hq_folder,
        &[
            "reflog",
            "show",
            "--date=raw",
            "--format=%gd%x00%gs%x00",
            "HEAD",
        ],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !reflog.status.success() {
        return None;
    }

    let cutoffs = candidates
        .iter()
        .map(|(path, modified)| {
            let seconds = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            (path.as_str(), seconds)
        })
        .collect::<HashMap<_, _>>();
    let fields = reflog.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut moved = HashSet::new();
    for pair in fields.chunks(2) {
        let [selector, subject] = pair else {
            continue;
        };
        let Some(seconds) = reflog_selector_seconds(selector) else {
            continue;
        };
        let subject = String::from_utf8_lossy(subject);
        if !is_head_history_move(subject.trim()) {
            continue;
        }
        for (path, cutoff) in &cutoffs {
            if seconds > *cutoff {
                moved.insert((*path).to_string());
            }
        }
    }
    Some(moved)
}

fn reflog_selector_seconds(selector: &[u8]) -> Option<u64> {
    let selector = std::str::from_utf8(selector).ok()?.trim();
    let date = selector.rsplit_once("@{")?.1.strip_suffix('}')?;
    date.split_whitespace().next()?.parse().ok()
}

fn is_head_history_move(subject: &str) -> bool {
    let subject = subject.trim().to_ascii_lowercase();
    [
        "reset:",
        "checkout:",
        "switch:",
        "rebase",
        "branch:",
        "pull --rebase:",
    ]
    .iter()
    .any(|prefix| subject.starts_with(prefix))
        || subject.contains(": moving from ")
}

fn head_commit_time(hq_folder: &str) -> Option<SystemTime> {
    let out = git_output(
        hq_folder,
        &["log", "-1", "--format=%ct", "HEAD"],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let seconds = String::from_utf8(out.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

fn journal_requires_path_history(
    journal_modified: SystemTime,
    head_commit_time: SystemTime,
) -> bool {
    truncate_system_time_to_seconds(journal_modified) <= head_commit_time
}

fn truncate_system_time_to_seconds(value: SystemTime) -> SystemTime {
    match value.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => UNIX_EPOCH
            .checked_add(Duration::from_secs(elapsed.as_secs()))
            .unwrap_or(value),
        Err(error) => {
            let elapsed = error.duration();
            let seconds = elapsed
                .as_secs()
                .saturating_add(u64::from(elapsed.subsec_nanos() > 0));
            UNIX_EPOCH
                .checked_sub(Duration::from_secs(seconds))
                .unwrap_or(value)
        }
    }
}

/// Return the newest commit timestamp for each requested path that changed
/// after `since`. One bounded-by-date Git history walk avoids one Git process
/// per quarantined file; unrelated paths are discarded while parsing.
fn latest_path_commit_times(
    hq_folder: &str,
    paths: &[String],
    since: SystemTime,
) -> Option<HashMap<String, SystemTime>> {
    let since_seconds = since
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_sub(1);
    let since_date = chrono::DateTime::<Utc>::from_timestamp(since_seconds as i64, 0)?
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let since_arg = format!("--since={since_date}");
    let out = git_output(
        hq_folder,
        &[
            "log",
            "-z",
            "--name-only",
            "--format=%x00%ct%x00",
            &since_arg,
            "HEAD",
        ],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }

    let wanted = paths
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let mut newest = HashMap::new();
    let mut timestamp = None;
    let fields = out.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;
    while index < fields.len() {
        if fields[index].is_empty() {
            index += 1;
            let Some(field) = fields.get(index) else {
                break;
            };
            let Some(seconds) = std::str::from_utf8(field).ok()?.trim().parse::<u64>().ok() else {
                break;
            };
            timestamp = UNIX_EPOCH.checked_add(Duration::from_secs(seconds));
            index += 1;
            // `git log --format` leaves one empty NUL field between the
            // formatted commit header and the first pathname.
            if fields.get(index).is_some_and(|field| field.is_empty()) {
                index += 1;
            }
            continue;
        }
        if let Some(committed_at) = timestamp {
            // `git log --format` separates the commit header from its first
            // NUL-delimited pathname with one newline. Remove only that framing
            // byte; a filename that itself starts with a newline remains intact.
            let path = fields[index].strip_prefix(b"\n").unwrap_or(fields[index]);
            if let Ok(path) = std::str::from_utf8(path) {
                if wanted.contains(path) {
                    newest.entry(path.to_string()).or_insert(committed_at);
                }
            }
        }
        index += 1;
    }
    Some(newest)
}

/// Read raw staged deletion metadata so each source path is paired with the
/// exact old blob id from the index diff. `-z` keeps filenames containing
/// whitespace or newlines unambiguous; non-UTF-8 names are conservatively left
/// to the existing bulk-deletion guard.
fn staged_deletion_records(hq_folder: &str) -> Result<Vec<StagedDeletionRecord>, String> {
    let out = git_output(
        hq_folder,
        &[
            "diff",
            "--cached",
            "--raw",
            "--no-abbrev",
            "--diff-filter=D",
            "-M",
            "-z",
        ],
        GIT_INDEX_TIMEOUT,
    )?;
    if !out.status.success() {
        return Err(format!(
            "git diff --cached --raw --diff-filter=D failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let fields: Vec<&[u8]> = out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    if !fields.len().is_multiple_of(2) {
        return Err("git diff --cached --raw returned an incomplete deletion record".to_string());
    }

    let mut records = Vec::new();
    for pair in fields.chunks_exact(2) {
        let Ok(metadata) = std::str::from_utf8(pair[0]) else {
            continue;
        };
        let columns: Vec<&str> = metadata.split_ascii_whitespace().collect();
        if columns.len() < 5 || columns[4] != "D" {
            continue;
        }
        let Some(mode) = columns[0].strip_prefix(':') else {
            continue;
        };
        let Ok(path) = std::str::from_utf8(pair[1]) else {
            continue;
        };
        records.push(StagedDeletionRecord {
            mode: mode.to_string(),
            blob: columns[2].to_string(),
            path: path.to_string(),
        });
    }
    Ok(records)
}

fn scope_quarantine_journal_roots(hq_folder: &Path) -> Vec<PathBuf> {
    let hq_metadata = fs::symlink_metadata(hq_folder.join(".hq")).ok();
    if !hq_metadata.is_some_and(|metadata| metadata.file_type().is_dir()) {
        return Vec::new();
    }
    let quarantine_root = hq_folder.join(".hq/scope-quarantine");
    let quarantine_metadata = fs::symlink_metadata(&quarantine_root).ok();
    if !quarantine_metadata.is_some_and(|metadata| metadata.file_type().is_dir()) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(quarantine_root) else {
        return Vec::new();
    };
    let mut roots = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots
}

fn is_normal_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

/// Return an ordinary file below a journal root, rejecting every symlink in
/// the relative path so a quarantine copy cannot resolve outside the mirror.
fn regular_file_below(root: &Path, relative: &Path) -> Option<PathBuf> {
    let mut candidate = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(std::path::Component::Normal(part)) = components.next() {
        candidate.push(part);
        let metadata = fs::symlink_metadata(&candidate).ok()?;
        let is_last = components.peek().is_none();
        let file_type = metadata.file_type();
        if is_last {
            if !file_type.is_file() {
                return None;
            }
        } else if !file_type.is_dir() {
            return None;
        }
    }
    Some(candidate)
}

/// Reuse an exact Git blob id while the quarantined copy and the attributes
/// that govern its clean conversion are unchanged. On a cache miss, the supplied
/// hasher still runs Git with --path=<original>, preserving clean filters and eol.
fn hash_quarantined_copy_cached<H>(
    hq_folder: &str,
    original_path: &str,
    copy: &Path,
    filter_context: Option<&ScopeQuarantineFilterContext>,
    cache: &mut ScopeQuarantineHashCache,
    cache_changed: &mut bool,
    seen_cache_keys: &mut HashSet<String>,
    hash_copy: &mut H,
) -> Option<String>
where
    H: FnMut(&str, &str, &Path) -> Option<String>,
{
    let signature = filter_context.and_then(|context| {
        scope_quarantine_hash_signature(hq_folder, original_path, copy, context)
    });
    if let Some(signature) = &signature {
        seen_cache_keys.insert(signature.key.clone());
        if let Some(entry) = cache.entries.get(&signature.key) {
            let mut expected = signature.entry.clone();
            expected.blob = entry.blob.clone();
            if entry == &expected {
                return Some(entry.blob.clone());
            }
        }
    }

    let blob = hash_copy(hq_folder, original_path, copy);
    if let Some(signature) = signature {
        if let Some(blob) = &blob {
            let mut entry = signature.entry;
            entry.blob = blob.clone();
            if cache.entries.get(&signature.key) != Some(&entry) {
                cache.entries.insert(signature.key, entry);
                *cache_changed = true;
            }
        } else if cache.entries.remove(&signature.key).is_some() {
            *cache_changed = true;
        }
    }
    blob
}

struct ScopeQuarantineHashSignature {
    key: String,
    entry: ScopeQuarantineHashCacheEntry,
}

fn scope_quarantine_hash_signature(
    hq_folder: &str,
    original_path: &str,
    copy: &Path,
    context: &ScopeQuarantineFilterContext,
) -> Option<ScopeQuarantineHashSignature> {
    let root = Path::new(hq_folder);
    let relative_copy = copy.strip_prefix(root).ok()?.to_str()?;
    let metadata = fs::metadata(copy).ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    let clean_filter_context =
        scope_quarantine_path_filter_fingerprint(hq_folder, original_path, context)?;

    let mut key_hash = Sha256::new();
    key_hash.update((original_path.len() as u64).to_be_bytes());
    key_hash.update(original_path.as_bytes());
    key_hash.update((relative_copy.len() as u64).to_be_bytes());
    key_hash.update(relative_copy.as_bytes());

    Some(ScopeQuarantineHashSignature {
        key: format!("{:x}", key_hash.finalize()),
        entry: ScopeQuarantineHashCacheEntry {
            source_path: original_path.to_string(),
            copy_path: relative_copy.to_string(),
            size: metadata.len(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
            clean_filter_context,
            blob: String::new(),
        },
    })
}

/// Include every path-specific and configured Git clean-conversion input. A
/// change to .gitattributes, the global/system attributes file, filter config,
/// or eol settings invalidates cached blob ids without hashing file contents.
fn scope_quarantine_filter_context(hq_folder: &str) -> Option<ScopeQuarantineFilterContext> {
    const FILTER_CONFIG_PATTERN: &str = r"^(filter\..*\.(clean|process|required)|core\.(autocrlf|eol|safecrlf|attributesfile|checkroundtripencoding))$";

    let config = git_output(
        hq_folder,
        &[
            "config",
            "--null",
            "--show-origin",
            "--get-regexp",
            FILTER_CONFIG_PATTERN,
        ],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !config.status.success() && config.status.code() != Some(1) {
        return None;
    }

    let global_attributes = git_output(
        hq_folder,
        &["config", "--null", "--path", "--get", "core.attributesFile"],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    let global_attributes_file = if global_attributes.status.success() {
        let bytes = global_attributes
            .stdout
            .strip_suffix(&[0])
            .unwrap_or(&global_attributes.stdout);
        Some(PathBuf::from(String::from_utf8(bytes.to_vec()).ok()?))
    } else if global_attributes.status.code() == Some(1) {
        default_global_attributes_file()
    } else {
        return None;
    };

    let exec_path = git_output(hq_folder, &["--exec-path"], GIT_INDEX_TIMEOUT).ok()?;
    if !exec_path.status.success() {
        return None;
    }
    let exec_path = PathBuf::from(String::from_utf8(exec_path.stdout).ok()?.trim());
    let system_attributes_file = resolve_system_attributes_file(hq_folder, &exec_path);
    let info_attributes_file = git_path(hq_folder, "info/attributes")?;

    Some(ScopeQuarantineFilterContext {
        config_fingerprint: format!("{:x}", Sha256::digest(config.stdout)),
        info_attributes_file,
        global_attributes_file,
        system_attributes_file,
    })
}

fn resolve_system_attributes_file(hq_folder: &str, exec_path: &Path) -> Option<PathBuf> {
    resolve_system_attributes_file_with(
        exec_path,
        std::env::var_os("GIT_ATTR_NOSYSTEM").is_some(),
        || {
            git_output(hq_folder, &["var", "GIT_ATTR_SYSTEM"], GIT_INDEX_TIMEOUT)
                .ok()
                .filter(|output| output.status.success())
                .map(|output| output.stdout)
        },
    )
}

fn resolve_system_attributes_file_with<F>(
    exec_path: &Path,
    system_disabled: bool,
    git_var: F,
) -> Option<PathBuf>
where
    F: FnOnce() -> Option<Vec<u8>>,
{
    if system_disabled {
        return None;
    }
    let fallback = exec_path
        .parent()
        .and_then(Path::parent)
        .map(|prefix| prefix.join("etc/gitattributes"));
    let configured = git_var()
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    configured.or(fallback)
}

fn git_path(hq_folder: &str, path: &str) -> Option<PathBuf> {
    let output = git_output(
        hq_folder,
        &["rev-parse", "--path-format=absolute", "--git-path", path],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let output = String::from_utf8(output.stdout).ok()?;
    let resolved = PathBuf::from(output.trim());
    Some(if resolved.is_absolute() {
        resolved
    } else {
        Path::new(hq_folder).join(resolved)
    })
}

fn default_global_attributes_file() -> Option<PathBuf> {
    let config_root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".config"))
        })?;
    Some(config_root.join("git/attributes"))
}

fn scope_quarantine_path_filter_fingerprint(
    hq_folder: &str,
    original_path: &str,
    context: &ScopeQuarantineFilterContext,
) -> Option<String> {
    let relative = Path::new(original_path);
    let components = relative.components().collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }

    let mut fingerprint = Sha256::new();
    fingerprint.update(context.config_fingerprint.as_bytes());
    fingerprint.update(
        std::env::var_os("GIT_ATTR_NOSYSTEM")
            .unwrap_or_default()
            .to_string_lossy()
            .as_bytes(),
    );

    let mut directory = PathBuf::from(hq_folder);
    update_filter_context_file(
        &mut fingerprint,
        "root attributes",
        &directory.join(".gitattributes"),
    )?;
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let std::path::Component::Normal(part) = component else {
            return None;
        };
        directory.push(part);
        update_filter_context_file(
            &mut fingerprint,
            "nested attributes",
            &directory.join(".gitattributes"),
        )?;
    }

    update_filter_context_file(
        &mut fingerprint,
        "repository info attributes",
        &context.info_attributes_file,
    )?;
    if let Some(path) = &context.global_attributes_file {
        update_filter_context_file(&mut fingerprint, "global attributes", path)?;
    }
    if let Some(path) = &context.system_attributes_file {
        update_filter_context_file(&mut fingerprint, "system attributes", path)?;
    }
    Some(format!("{:x}", fingerprint.finalize()))
}

/// Hash attribute-file bytes in memory only. Missing files are fingerprinted as
/// absent; unreadable files disable the cache so Git performs its normal check.
fn update_filter_context_file(fingerprint: &mut Sha256, label: &str, path: &Path) -> Option<()> {
    fingerprint.update((label.len() as u64).to_be_bytes());
    fingerprint.update(label.as_bytes());
    match fs::read(path) {
        Ok(bytes) => {
            fingerprint.update([1]);
            fingerprint.update((bytes.len() as u64).to_be_bytes());
            fingerprint.update(bytes);
            Some(())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fingerprint.update([0]);
            Some(())
        }
        Err(_) => None,
    }
}

fn read_scope_quarantine_hash_cache(hq_folder: &str) -> ScopeQuarantineHashCache {
    let path = Path::new(hq_folder)
        .join(".hq")
        .join(SCOPE_QUARANTINE_HASH_CACHE_FILE);
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<ScopeQuarantineHashCache>(&bytes) {
            Ok(cache) if cache.version == SCOPE_QUARANTINE_HASH_CACHE_VERSION => cache,
            _ => {
                log(
                    LOG_TAG,
                    "quarantine hash cache is invalid; rebuilding it with Git",
                );
                ScopeQuarantineHashCache::default()
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => ScopeQuarantineHashCache::default(),
        Err(_) => {
            log(
                LOG_TAG,
                "quarantine hash cache could not be read; rebuilding it with Git",
            );
            ScopeQuarantineHashCache::default()
        }
    }
}

/// The mirror lock serializes cache writers across this process and the
/// cross-process lock is held by the caller. Cache loss is safe: it only makes
/// the next pass recompute blob ids with Git.
fn write_scope_quarantine_hash_cache(hq_folder: &str, cache: &ScopeQuarantineHashCache) {
    let directory = Path::new(hq_folder).join(".hq");
    let path = directory.join(SCOPE_QUARANTINE_HASH_CACHE_FILE);
    let temp = directory.join(format!("{SCOPE_QUARANTINE_HASH_CACHE_FILE}.tmp"));
    let encoded = match serde_json::to_vec(cache) {
        Ok(encoded) => encoded,
        Err(_) => {
            log(LOG_TAG, "quarantine hash cache could not be encoded");
            return;
        }
    };
    if fs::write(&temp, encoded).is_err() {
        log(LOG_TAG, "quarantine hash cache could not be staged");
        return;
    }
    #[cfg(windows)]
    if path.exists() && fs::remove_file(&path).is_err() {
        log(LOG_TAG, "old quarantine hash cache could not be replaced");
        let _ = fs::remove_file(temp);
        return;
    }
    if fs::rename(&temp, &path).is_err() {
        log(LOG_TAG, "quarantine hash cache could not be published");
        let _ = fs::remove_file(temp);
    }
}

/// Use Git's clean filters for the original path, matching the blob id already
/// recorded at HEAD. Any unreadable or unhashable copy stays a deletion.
fn hash_quarantined_copy(hq_folder: &str, original_path: &str, copy: &Path) -> Option<String> {
    let path_attr = format!("--path={original_path}");
    let copy_path = copy.to_str()?;
    let out = git_output(
        hq_folder,
        &["hash-object", &path_attr, "--", copy_path],
        GIT_INDEX_TIMEOUT,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let hash = String::from_utf8(out.stdout).ok()?;
    let hash = hash.trim();
    (!hash.is_empty()).then(|| hash.to_string())
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
    // Own process group so the CPU throttle can address git and anything it
    // spawns (hooks, credential helpers) without touching the rest of HQ.
    put_git_in_own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn git: {e}"))?;

    // The mirror's `git add -A` hashes every changed file on a tree that can
    // hold hundreds of thousands of them, so it is the other half of what an
    // operator feels as "HQ is eating my machine". It shares one budget with
    // the sync runner rather than getting its own, so a mirror pass overlapping
    // a sync tightens both instead of doubling the ceiling. The guard is dropped
    // when this function returns — including the timeout-kill path — and its
    // drop resumes the group, so a stopped git is never left behind.
    //
    // Throttling multiplies wall time, so `timeout` is now a ceiling on elapsed
    // time for work that runs at a fraction of full speed. That is deliberate:
    // GIT_INDEX_TIMEOUT is minutes and the throttled commands are seconds.
    let _cpu_throttle = crate::cpu_throttle::CpuThrottle::attach(child.id() as i32);

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

#[cfg(unix)]
fn put_git_in_own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn put_git_in_own_process_group(_cmd: &mut Command) {}

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
    // The ceiling counts only time git was actually allowed to run. The CPU
    // throttle duty-cycles this child's process group, so plain wall time would
    // spend the whole allowance on stop windows and kill a healthy `git add -A`
    // over a large tree on every mirror pass. A genuinely wedged git is never
    // stopped, so it still trips the deadline on the original schedule.
    let deadline = crate::cpu_throttle::RunnableDeadline::start(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if deadline.expired() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {label} timed out after {}s of runnable time and was killed",
                        deadline.budget().as_secs()
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

    /// Serializes tests that read or write process-global probe state.
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

    /// Reset the process-global state the index-lock wedge suite touches, so its
    /// tests cannot race one another. The report budget is durable on disk in each
    /// test's own `TempDir`; the shared probe slot and timeout override are reset.
    fn reset_index_lock_report_state() {
        WEDGE_REPORT_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        set_probe_override(None);
        std::env::remove_var(WEDGED_LOCK_HARD_TIMEOUT_ENV);
    }

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
    fn counts_nul_terminated_records() {
        assert_eq!(count_nul_terminated(b""), 0);
        assert_eq!(count_nul_terminated(b"a\0"), 1);
        assert_eq!(count_nul_terminated(b"a\0b/c\0"), 2);
        assert_eq!(count_nul_terminated(b"we\nird\0"), 1);
    }

    fn lock_state(size: u64, age_secs: u64) -> IndexLockState {
        IndexLockState {
            exists: true,
            size_bytes: size,
            age: Some(Duration::from_secs(age_secs)),
            mtime_nanos: Some(0),
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
            mtime_nanos: None,
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

    /// Run git against `dir` with the developer's (or runner's) git
    /// configuration fully out of the way.
    ///
    /// `git` reads the system and global config files for EVERY invocation, so
    /// a machine-level `core.hooksPath` (a secret scanner, a commit-signing
    /// wrapper, any pre-commit hook) runs inside these fixtures too. That is
    /// what made these tests fail only under load: the inherited hook is a
    /// network client, and when several git-backed tests commit at once it
    /// rate-limits or fails auth, `git commit` exits non-zero, and the fixture
    /// blows up in `seed_repo` far away from anything the test is about.
    ///
    /// Pointing both config layers at /dev/null makes the fixture hermetic for
    /// real, which is what the comment in `init_repo` already claimed.
    fn git(dir: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available in test env")
    }

    /// Assert a fixture git command succeeded, and show its stderr when it did
    /// not — `assert!(… .status.success())` alone hid the hook's own error
    /// message, which is why this cost a full investigation to name.
    fn git_ok(dir: &Path, args: &[&str]) -> Output {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    fn git_at_seconds(dir: &Path, args: &[&str], seconds: u64) -> Output {
        let date = format!("@{seconds} +0000");
        Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available in test env")
    }

    fn git_ok_at_seconds(dir: &Path, args: &[&str], seconds: u64) -> Output {
        let out = git_at_seconds(dir, args, seconds);
        assert!(
            out.status.success(),
            "git {args:?} at {seconds} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    fn set_modified(path: &Path, modified: SystemTime) {
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .expect("open directory to set its timestamp")
        };
        #[cfg(not(windows))]
        let file = File::open(path).expect("open directory to set its timestamp");
        file.set_modified(modified)
            .expect("set directory timestamp");
    }

    fn future_test_second() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time is after the Unix epoch")
            .as_secs()
            + 86_400
    }

    fn init_repo(dir: &Path) {
        // An empty template dir keeps an inherited `init.templateDir` from
        // seeding hooks into the fixture at init time.
        git_ok(dir, &["init", "-q", "-b", "main", "--template="]);
        // Belt and braces next to the /dev/null config layers in `git`: even a
        // repo-local hooksPath cannot point anywhere real.
        git_ok(dir, &["config", "core.hooksPath", "/dev/null"]);
        // Test env may have no global git identity; pin one locally so
        // `git commit` doesn't bail with "Please tell me who you are".
        git_ok(dir, &["config", "user.email", "test@example.com"]);
        git_ok(dir, &["config", "user.name", "hq-sync-test"]);
        // Disable any inherited commit hooks/templates — keep the test
        // environment hermetic regardless of the dev's global ~/.gitconfig.
        git_ok(dir, &["config", "commit.gpgsign", "false"]);
    }

    /// Regression: a hostile machine-level git config must not reach these
    /// fixtures.
    ///
    /// This is the flake seen on CI run 35241483905 and reproduced locally: the
    /// dev machine's global config sets `core.hooksPath` to a secret-scanning
    /// pre-commit hook. Running one git-backed test is fine; running several at
    /// once makes that hook fail (rate limit / auth), `git commit` exits
    /// non-zero, and `seed_repo` trips an assertion that says nothing about the
    /// real cause. The test stands in a global config whose pre-commit hook
    /// always fails. Before the fix the seed commit runs it and the test fails;
    /// with the /dev/null config layers the fixture never sees it.
    #[test]
    fn a_hostile_global_git_config_cannot_reach_the_fixtures() {
        let _serial = serial();

        let home = TempDir::new().unwrap();
        let hooks = home.path().join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let pre_commit = hooks.join("pre-commit");
        fs::write(
            &pre_commit,
            "#!/bin/sh\necho 'scanner unavailable' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pre_commit, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let global = home.path().join("gitconfig");
        // Git config treats a backslash as an escape, so a raw Windows path
        // (C:\Users\...) makes the whole file unparseable. Other tests in this
        // module call git without the serial lock and inherit
        // GIT_CONFIG_GLOBAL while it is set here, so an invalid file fails them
        // with "bad config line 2". Git for Windows accepts forward slashes.
        let hooks_path = hooks.display().to_string().replace('\\', "/");
        fs::write(&global, format!("[core]\n\thooksPath = {hooks_path}\n")).unwrap();
        let parsed = Command::new("git")
            .args(["config", "--file"])
            .arg(&global)
            .args(["--get", "core.hooksPath"])
            .output()
            .unwrap();
        assert!(
            parsed.status.success(),
            "the stand-in global config must parse on every platform: {}",
            String::from_utf8_lossy(&parsed.stderr)
        );

        let previous = std::env::var_os("GIT_CONFIG_GLOBAL");
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);

        let repo = TempDir::new().unwrap();
        seed_repo(repo.path(), 3);
        let commits = rev_count(repo.path());

        match previous {
            Some(value) => std::env::set_var("GIT_CONFIG_GLOBAL", value),
            None => std::env::remove_var("GIT_CONFIG_GLOBAL"),
        }

        assert_eq!(
            commits, 1,
            "the seed commit must land despite a hostile global core.hooksPath"
        );
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
        git_ok(dir, &["add", "-A"]);
        git_ok(dir, &["commit", "-q", "-m", "seed"]);
    }

    /// Scope-shrink fixture: tracked files live below one company, alongside
    /// enough unaffected files to exercise quarantine move restoration.
    fn seed_scope_quarantine_repo(dir: &Path, moved_files: usize) {
        init_repo(dir);
        fs::write(dir.join(".gitignore"), ".hq/\n").unwrap();
        for i in 0..moved_files {
            let path = dir.join(format!("companies/indigo/file-{i:04}.md"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("indigo fixture {i}\n")).unwrap();
        }
        for i in 0..100 {
            let path = dir.join(format!("companies/retained/file-{i:04}.md"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("retained content {i}\n")).unwrap();
        }
        git_ok(dir, &["add", "-A"]);
        git_ok(dir, &["commit", "-q", "-m", "seed scope tree"]);
    }

    fn move_scope_files_to_quarantine(dir: &Path, count: usize, alter_contents: bool) {
        let quarantine = dir.join(".hq/scope-quarantine/journal-001");
        for i in 0..count {
            let relative = PathBuf::from(format!("companies/indigo/file-{i:04}.md"));
            let source = dir.join(&relative);
            let destination = quarantine.join(&relative);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::rename(&source, &destination).unwrap();
            if alter_contents {
                fs::write(&destination, format!("changed content {i}\n")).unwrap();
            }
        }
        let head_time = head_commit_time(dir.to_str().unwrap()).expect("fixture HEAD has a time");
        set_modified(
            &quarantine.join("companies/indigo"),
            head_time + Duration::from_secs(1),
        );
    }

    fn delete_files(dir: &Path, range: std::ops::Range<usize>) {
        for i in range {
            fs::remove_file(dir.join(format!("file-{i:04}.md"))).unwrap();
        }
    }

    /// `run_mirror` takes the resolved git directory; resolve it the same way
    /// production does so the tests exercise that path too.
    fn run_mirror_at(dir: &Path) -> Result<(), String> {
        run_mirror_at_with_quarantine_flag(dir, false)
    }

    fn run_mirror_at_with_quarantine_flag(dir: &Path, enabled: bool) -> Result<(), String> {
        let hq = dir.to_str().unwrap();
        let git_dir = resolve_git_dir(hq)?;
        let outcome = run_mirror(hq, &git_dir, enabled)?;
        if outcome == MirrorOutcome::Push {
            push_after_mirror(hq, &git_dir);
        }
        Ok(())
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
    fn matching_scope_quarantine_moves_are_ignored_on_repeated_mirror_passes() {
        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 20);
        move_scope_files_to_quarantine(tmp.path(), 20, false);
        let before = rev_count(tmp.path());

        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("matching quarantine copies preserve the move");
        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("the second pass repeats the quarantine check");

        assert_eq!(
            count_staged_deletions(tmp.path().to_str().unwrap())
                .expect("read staged deletions after mirror")
                .count,
            0,
            "matching quarantined paths are restored to the index as moves"
        );
        assert_eq!(rev_count(tmp.path()), before, "the move needs no commit");

        fs::remove_dir_all(tmp.path().join(".hq/scope-quarantine")).unwrap();
        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("without the matching copy, the source absence is a deletion");
        assert_eq!(rev_count(tmp.path()), before + 1);
        let show = git(tmp.path(), &["show", "--format=", "--name-status", "HEAD"]);
        assert!(show.status.success());
        assert_eq!(
            String::from_utf8_lossy(&show.stdout)
                .lines()
                .filter(|line| line.starts_with("D\t"))
                .count(),
            20,
            "removing the quarantine copies commits all source deletions"
        );
    }

    #[test]
    fn repeated_quarantine_passes_bound_git_processes_for_2000_files() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 2_000);
        move_scope_files_to_quarantine(tmp.path(), 2_000, false);
        git_ok(tmp.path(), &["add", "-A"]);

        let hq_folder = tmp.path().to_str().unwrap();
        let expected_blobs = staged_deletion_records(hq_folder)
            .expect("read seed blob ids")
            .into_iter()
            .map(|record| (record.path, record.blob))
            .collect::<HashMap<_, _>>();
        let hasher_calls = std::sync::atomic::AtomicUsize::new(0);
        let mut fixture_hasher = |_: &str, original: &str, _: &Path| {
            hasher_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            expected_blobs.get(original).cloned()
        };

        assert_eq!(
            restore_scope_quarantine_move_index_entries_with_hasher(hq_folder, &mut fixture_hasher)
                .expect("the first pass verifies and restores quarantine copies"),
            2_000
        );
        assert_eq!(
            hasher_calls.swap(0, std::sync::atomic::Ordering::Relaxed),
            2_000,
            "the first pass checks every uncached copy"
        );

        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries_with_hasher(hq_folder, &mut fixture_hasher)
                .expect("the second pass reuses unchanged verified copies"),
            2_000
        );
        let second_pass_hashes = hasher_calls.swap(0, std::sync::atomic::Ordering::Relaxed);
        assert!(
            second_pass_hashes <= 8,
            "second pass would spawn {second_pass_hashes} per-copy Git hash processes; expected at most 8"
        );
    }

    #[test]
    fn flag_off_quarantine_moves_commit_source_deletions() {
        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 20);
        move_scope_files_to_quarantine(tmp.path(), 20, false);
        let before = rev_count(tmp.path());

        run_mirror_at_with_quarantine_flag(tmp.path(), false)
            .expect("with the move restoration disabled, source absences are deletions");

        assert_eq!(rev_count(tmp.path()), before + 1);
        let show = git(tmp.path(), &["show", "--format=", "--name-status", "HEAD"]);
        assert!(show.status.success());
        assert_eq!(
            String::from_utf8_lossy(&show.stdout)
                .lines()
                .filter(|line| line.starts_with("D\t"))
                .count(),
            20,
            "the disabled move gate preserves the existing deletion behavior"
        );
    }

    #[test]
    fn quarantine_hash_cache_keeps_path_clean_filters_and_invalidates_attribute_changes() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());

        let company_path = ["companies", "indigo"].join("/");
        let source_path = format!("{company_path}/file-0000.md");
        fs::write(
            tmp.path().join(".gitattributes"),
            format!("{company_path}/*.md text eol=lf\n"),
        )
        .unwrap();
        fs::write(tmp.path().join(".gitignore"), ".hq/\n").unwrap();
        let source = tmp.path().join(&source_path);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"line one\r\nline two\r\n").unwrap();
        let changed_source = tmp.path().join(format!("{company_path}/file-0001.md"));
        fs::write(&changed_source, b"second file\r\n").unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(
            tmp.path(),
            &["commit", "-q", "-m", "seed clean-filter fixture"],
        );
        let head_blob = String::from_utf8(
            git(tmp.path(), &["rev-parse", &format!("HEAD:{source_path}")]).stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        move_scope_files_to_quarantine(tmp.path(), 2, false);
        git_ok(tmp.path(), &["add", "-A"]);
        let hq_folder = tmp.path().to_str().unwrap();
        let copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001")
            .join(&source_path);
        assert_eq!(
            hash_quarantined_copy(hq_folder, &source_path, &copy)
                .expect("Git hashes the copy with the original path attributes"),
            head_blob,
            "the cache miss uses the same clean-filtered blob id recorded at HEAD"
        );
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("first clean-filtered pass restores both moves"),
            2
        );

        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("unchanged clean-filtered copies use their cached blobs"),
            2
        );

        let changed_copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001")
            .join(format!("{company_path}/file-0001.md"));
        fs::write(&changed_copy, b"changed copy with a new size\r\n").unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("changed copy metadata forces a fresh Git hash"),
            1,
            "the unchanged copy restores while the changed copy stays a deletion"
        );
        assert_eq!(
            count_staged_deletions(hq_folder)
                .expect("read deletion for the changed copy")
                .count,
            1
        );

        fs::write(
            tmp.path().join(".gitattributes"),
            format!("{company_path}/*.md -text\n"),
        )
        .unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        assert_ne!(
            hash_quarantined_copy(hq_folder, &source_path, &copy)
                .expect("changed attributes are evaluated by Git"),
            head_blob,
            "the new no-conversion rule produces a different blob for CRLF content"
        );
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("attribute changes invalidate the cached conversion result"),
            0,
            "a stale cached blob must not restore a deletion after clean attributes change"
        );
        assert_eq!(
            count_staged_deletions(hq_folder)
                .expect("read source deletions after the attribute change")
                .count,
            2
        );
    }

    #[test]
    fn stale_same_size_same_mtime_cache_hit_keeps_the_quarantine_copy_as_a_move() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 1);
        move_scope_files_to_quarantine(tmp.path(), 1, false);
        git_ok(tmp.path(), &["add", "-A"]);

        let hq_folder = tmp.path().to_str().unwrap();
        let record = staged_deletion_records(hq_folder)
            .expect("read staged source blob")
            .into_iter()
            .next()
            .expect("one source deletion is staged");
        let copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001")
            .join(&record.path);
        let cached_metadata = fs::metadata(&copy).expect("read quarantined copy metadata");
        let cached_size = cached_metadata.len();
        let cached_modified = cached_metadata.modified().expect("read cached mtime");

        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("cache the verified copy"),
            1
        );
        git_ok(tmp.path(), &["add", "-A"]);

        let mut replacement = fs::read(&copy).expect("read quarantined copy");
        assert!(!replacement.is_empty());
        replacement[0] ^= 0xff;
        fs::write(&copy, &replacement).expect("rewrite copy without changing its length");
        fs::OpenOptions::new()
            .write(true)
            .open(&copy)
            .expect("open rewritten copy with attribute-write access")
            .set_modified(cached_modified)
            .expect("restore the cached mtime");
        let rewritten_metadata = fs::metadata(&copy).expect("read rewritten metadata");
        assert_eq!(rewritten_metadata.len(), cached_size);
        assert_eq!(
            rewritten_metadata.modified().expect("read rewritten mtime"),
            cached_modified
        );
        assert_ne!(
            hash_quarantined_copy(hq_folder, &record.path, &copy)
                .expect("hash changed bytes through Git"),
            record.blob,
            "the rewritten copy no longer hashes to the recorded blob"
        );
        git_ok(tmp.path(), &["add", "-A"]);

        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("the stale metadata-keyed hit preserves the move"),
            1,
            "a stale cache hit must keep the source as a move"
        );
        assert_eq!(
            count_staged_deletions(hq_folder)
                .expect("count deletions after restoring the index entry")
                .count,
            0,
            "a stale cache hit must not leave the source deletion staged"
        );
        let index_blob =
            String::from_utf8(git(tmp.path(), &["rev-parse", &format!(":{}", record.path)]).stdout)
                .expect("decode restored index blob");
        assert_eq!(index_blob.trim(), record.blob);
        assert_eq!(
            fs::read(&copy).expect("quarantine copy remains present"),
            replacement
        );
        assert!(
            !tmp.path().join(&record.path).exists(),
            "the out-of-scope source remains represented by its retained quarantine copy"
        );
    }

    #[test]
    fn quarantine_hash_cache_invalidates_equal_length_attribute_rewrites() {
        let _serial = serial();
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());

        let company_path = ["companies", "indigo"].join("/");
        let source_path = format!("{company_path}/file-0000.md");
        let original_attributes = format!("{company_path}/*.md text\n");
        let replacement_attributes = format!("{company_path}/*md -text\n");
        assert_eq!(
            original_attributes.len(),
            replacement_attributes.len(),
            "the changed rule must have the same byte length"
        );
        fs::write(tmp.path().join(".gitattributes"), &original_attributes).unwrap();
        fs::write(tmp.path().join(".gitignore"), ".hq/\n").unwrap();
        let source = tmp.path().join(&source_path);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"line one\r\nline two\r\n").unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(
            tmp.path(),
            &["commit", "-q", "-m", "seed equal-length attribute fixture"],
        );
        let head_blob = String::from_utf8(
            git(tmp.path(), &["rev-parse", &format!("HEAD:{source_path}")]).stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        move_scope_files_to_quarantine(tmp.path(), 1, false);
        git_ok(tmp.path(), &["add", "-A"]);
        let hq_folder = tmp.path().to_str().unwrap();
        let copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001")
            .join(&source_path);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("cache the blob produced by the original attributes"),
            1
        );
        git_ok(tmp.path(), &["add", "-A"]);

        fs::write(tmp.path().join(".gitattributes"), &replacement_attributes).unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        assert_ne!(
            hash_quarantined_copy(hq_folder, &source_path, &copy)
                .expect("hash under the replacement attributes"),
            head_blob,
            "the equal-length -text rule produces a different blob for CRLF content"
        );
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("attribute content change invalidates the cached blob"),
            0,
            "cache invalidation must compare attribute bytes even when file length is unchanged"
        );
        assert_eq!(
            count_staged_deletions(hq_folder)
                .expect("read staged source deletion after attribute change")
                .count,
            1
        );
    }

    #[test]
    fn system_attributes_path_prefers_git_var_and_falls_back_when_missing() {
        let exec_path = PathBuf::from("/git-prefix/libexec/git-core");
        let fallback = PathBuf::from("/git-prefix/etc/gitattributes");
        let configured = PathBuf::from("/explicit/git-system-attributes");
        assert_eq!(
            resolve_system_attributes_file_with(&exec_path, false, || {
                Some(b"/explicit/git-system-attributes\n".to_vec())
            }),
            Some(configured),
            "the path Git reports must win over a derived exec-path guess"
        );
        assert_eq!(
            resolve_system_attributes_file_with(&exec_path, false, || Some(b"\n".to_vec())),
            Some(fallback),
            "empty git var output falls back to the existing path derivation"
        );
        assert_eq!(
            resolve_system_attributes_file_with(&exec_path, true, || {
                panic!("GIT_ATTR_NOSYSTEM must skip the system path lookup")
            }),
            None,
            "GIT_ATTR_NOSYSTEM disables system attributes"
        );
    }

    #[test]
    fn linked_worktree_common_info_attributes_changes_invalidate_hash_cache() {
        let _serial = serial();
        let repo = TempDir::new().unwrap();
        seed_repo(repo.path(), 1);
        let linked = repo.path().join("linked-worktree");
        git_ok(
            repo.path(),
            &[
                "worktree",
                "add",
                "--detach",
                linked.to_str().unwrap(),
                "HEAD",
            ],
        );

        let hq_folder = linked.to_str().unwrap();
        let context = scope_quarantine_filter_context(hq_folder)
            .expect("resolve Git's active filter context in a linked worktree");
        let common_info_attributes = repo.path().join(".git/info/attributes");
        let before = scope_quarantine_path_filter_fingerprint(hq_folder, "file-0000.md", &context)
            .expect("fingerprint filter inputs before shared attributes exist");

        fs::create_dir_all(common_info_attributes.parent().unwrap()).unwrap();
        fs::write(&common_info_attributes, "*.md text\n").unwrap();
        let after_context = scope_quarantine_filter_context(hq_folder)
            .expect("refresh Git's active filter context after shared attributes change");
        let after =
            scope_quarantine_path_filter_fingerprint(hq_folder, "file-0000.md", &after_context)
                .expect("fingerprint changed shared attributes");
        assert_ne!(
            before, after,
            "a common info/attributes edit in a linked worktree invalidates cached blobs"
        );
    }

    #[test]
    fn different_scope_quarantine_content_is_committed_as_deletions() {
        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 20);
        move_scope_files_to_quarantine(tmp.path(), 20, true);
        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(tmp.path().to_str().unwrap())
                .expect("classify changed quarantine copies"),
            0,
            "changed quarantine content must not match a HEAD blob"
        );
        git_ok(tmp.path(), &["reset", "-q"]);
        let before = rev_count(tmp.path());

        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("mismatched copies are not restored as moves");

        assert_eq!(rev_count(tmp.path()), before + 1);
        let show = git(tmp.path(), &["show", "--format=", "--name-status", "HEAD"]);
        assert!(show.status.success());
        assert_eq!(
            String::from_utf8_lossy(&show.stdout)
                .lines()
                .filter(|line| line.starts_with("D\t"))
                .count(),
            20,
            "nonmatching quarantine copies do not protect source paths from deletion"
        );
    }

    #[test]
    fn pending_quarantine_flag_wait_is_bounded_and_late_snapshot_applies_next_pass() {
        let gate = std::sync::Arc::new(ScopeQuarantineGate::new());
        assert!(gate.register_generation(1));
        let waiter_gate = std::sync::Arc::clone(&gate);
        let (decision_tx, decision_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let decision = waiter_gate.resolve_first_mirror(Duration::from_millis(75));
            decision_tx.send(decision).unwrap();
        });

        assert!(matches!(
            decision_rx.recv_timeout(Duration::from_millis(15)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        let timed_out = decision_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the pending flag wait reaches its bound");
        assert_eq!(
            timed_out,
            ScopeQuarantineGateDecision {
                enabled: false,
                timed_out: true,
            },
            "timeout preserves the historical default-off path for this first pass"
        );
        assert!(gate.set_snapshot(1, 1, true));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO),
            ScopeQuarantineGateDecision {
                enabled: true,
                timed_out: false,
            },
            "a late snapshot is used by subsequent mirror passes"
        );
        waiter.join().expect("flag wait completes");
    }

    #[test]
    fn zero_timeout_without_a_snapshot_keeps_the_first_pass_flag_off() {
        let gate = ScopeQuarantineGate::new();
        assert!(gate.register_generation(1));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO),
            ScopeQuarantineGateDecision {
                enabled: false,
                timed_out: true,
            },
            "an unresolved zero-timeout snapshot must use the default-off first-pass decision"
        );
        assert!(gate.set_snapshot(1, 1, true));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO),
            ScopeQuarantineGateDecision {
                enabled: true,
                timed_out: false,
            },
            "the later resolved snapshot applies to subsequent passes"
        );
    }

    #[test]
    fn mirror_flag_generations_require_every_live_window_to_report_true() {
        let gate = ScopeQuarantineGate::new();
        assert!(gate.register_generation(1));
        assert!(gate.register_generation(2));
        assert!(gate.set_snapshot(1, 1, true));
        assert!(gate.set_snapshot(2, 1, true));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO).enabled,
            true,
            "the gate is on only after each live generation reports on"
        );
        assert!(gate.set_snapshot(1, 2, false));
        assert!(
            !gate.set_snapshot(1, 1, true),
            "a late lower revision within one generation must be ignored"
        );
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO).enabled,
            false,
            "one live window reporting off turns the process gate off"
        );
    }

    #[test]
    fn a_new_true_generation_cannot_override_another_live_false_generation() {
        let gate = ScopeQuarantineGate::new();
        assert!(gate.register_generation(1));
        assert!(gate.register_generation(2));
        assert!(gate.set_snapshot(1, 1, false));
        assert!(gate.set_snapshot(2, 1, true));
        assert!(gate.register_generation(3));
        assert!(gate.set_snapshot(3, 1, true));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO),
            ScopeQuarantineGateDecision {
                enabled: false,
                timed_out: false,
            },
            "another live generation's false snapshot keeps the process gate off"
        );
    }

    #[test]
    fn process_generation_allocator_returns_distinct_registered_ids() {
        let first = register_scope_quarantine_move_not_deletion_generation()
            .expect("allocate first webview generation");
        let second = register_scope_quarantine_move_not_deletion_generation()
            .expect("allocate second webview generation");
        assert_ne!(first, second, "separate webviews need distinct process IDs");
        unregister_scope_quarantine_move_not_deletion_generation(first);
        unregister_scope_quarantine_move_not_deletion_generation(second);
    }

    #[test]
    fn closing_one_window_then_receiving_off_from_the_survivor_keeps_gate_off() {
        let gate = ScopeQuarantineGate::new();
        assert!(gate.register_generation(1));
        assert!(gate.register_generation(2));
        assert!(gate.set_snapshot(1, 1, true));
        assert!(gate.set_snapshot(2, 1, true));
        assert!(gate.unregister_generation(2));
        assert!(gate.set_snapshot(1, 2, false));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO).enabled,
            false,
            "the surviving generation's flag-off update controls the remaining gate"
        );
    }

    #[test]
    fn closing_then_reopening_uses_only_the_live_generations() {
        let gate = ScopeQuarantineGate::new();
        assert!(gate.register_generation(1));
        assert!(gate.register_generation(2));
        assert!(gate.set_snapshot(1, 1, true));
        assert!(gate.set_snapshot(2, 1, true));
        assert!(gate.unregister_generation(1));
        assert!(gate.unregister_generation(2));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO).enabled,
            false,
            "the empty gate is off"
        );
        assert!(gate.register_generation(3));
        assert!(gate.set_snapshot(3, 1, true));
        assert_eq!(
            gate.resolve_first_mirror(Duration::ZERO).enabled,
            true,
            "a fresh generation can enable the gate after all old windows close"
        );
    }

    #[test]
    fn reset_after_quarantine_journal_routes_to_path_history_before_deletion() {
        let _serial = serial();

        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 1);
        let source = tmp.path().join("companies/indigo/file-0000.md");
        let copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001/companies/indigo/file-0000.md");
        let base_second = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time is after the Unix epoch")
            .as_secs()
            .saturating_sub(30);
        git_ok_at_seconds(
            tmp.path(),
            &["commit", "--amend", "--no-edit", "-q"],
            base_second,
        );
        move_scope_files_to_quarantine(tmp.path(), 1, false);
        let journal_second = base_second + 2;
        set_modified(
            copy.parent().unwrap(),
            UNIX_EPOCH + Duration::from_secs(journal_second),
        );

        fs::copy(&copy, &source).expect("return the copy so the next commit retains the path");
        fs::write(tmp.path().join("unrelated.txt"), "branch moved later\n").unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok_at_seconds(
            tmp.path(),
            &["commit", "-q", "-m", "newer branch commit"],
            journal_second + 1,
        );
        git_ok(tmp.path(), &["reset", "--hard", "HEAD~1"]);

        fs::remove_file(&source).expect("user deliberately deletes the path after reset");
        git_ok(tmp.path(), &["add", "-A"]);
        let hq_folder = tmp.path().to_str().unwrap();
        assert_eq!(
            restore_scope_quarantine_move_index_entries(hq_folder)
                .expect("consult path history after the HEAD rewind"),
            0,
            "a post-journal reset must not restore a deletion from the abandoned branch"
        );
        assert_eq!(
            count_staged_deletions(hq_folder)
                .expect("read the staged deletion after the reset")
                .count,
            1,
            "the quarantine classifier must leave a deliberate deletion staged for the mirror"
        );
    }

    #[test]
    fn stale_scope_quarantine_journal_does_not_restore_a_deliberate_deletion() {
        let _serial = serial();

        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 1);
        move_scope_files_to_quarantine(tmp.path(), 1, false);
        let source = tmp.path().join("companies/indigo/file-0000.md");
        let stale_copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001/companies/indigo/file-0000.md");

        // Record the old shrink operation, then return the exact content to the
        // tracked scope while the old journal copy remains behind.
        git_ok(tmp.path(), &["add", "-A"]);
        std::thread::sleep(Duration::from_secs(2));
        git_ok(tmp.path(), &["commit", "-q", "-m", "old scope shrink"]);
        fs::copy(&stale_copy, &source).expect("the file returns to current scope");
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(
            tmp.path(),
            &["commit", "-q", "-m", "file returned to scope"],
        );

        fs::remove_file(&source).expect("user deliberately deletes the returned file");
        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(tmp.path().to_str().unwrap())
                .expect("classify stale quarantine provenance"),
            0,
            "a stale journal must not reset a deletion after the path returned to scope"
        );
        assert_eq!(
            count_staged_deletions(tmp.path().to_str().unwrap())
                .expect("read staged deletion")
                .count,
            1,
            "the deliberate deletion remains staged"
        );
        git_ok(tmp.path(), &["reset", "-q"]);

        let before_delete_commit = rev_count(tmp.path());
        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("the deliberate deletion follows the ordinary mirror path");
        assert_eq!(
            rev_count(tmp.path()),
            before_delete_commit + 1,
            "the deliberate deletion is committed"
        );
        let show = git(
            tmp.path(),
            &[
                "show",
                "--format=",
                "--name-status",
                "HEAD",
                "--",
                "companies/indigo/file-0000.md",
            ],
        );
        assert!(show.status.success());
        assert_eq!(
            String::from_utf8_lossy(&show.stdout).trim(),
            "D\tcompanies/indigo/file-0000.md",
            "the resulting mirror commit records the source deletion"
        );
    }

    #[test]
    fn same_second_journal_is_routed_through_path_history() {
        let head_second = future_test_second();
        let head_commit_time = UNIX_EPOCH + Duration::from_secs(head_second);
        let journal_modified = head_commit_time + Duration::from_millis(700);

        assert!(
            journal_requires_path_history(journal_modified, head_commit_time),
            "a journal in the same whole second as HEAD must consult path history"
        );
    }

    #[test]
    fn same_second_journal_tie_preserves_the_deliberate_deletion() {
        let _serial = serial();

        let tmp = TempDir::new().unwrap();
        seed_scope_quarantine_repo(tmp.path(), 1);
        let source = tmp.path().join("companies/indigo/file-0000.md");
        move_scope_files_to_quarantine(tmp.path(), 1, false);
        let copy = tmp
            .path()
            .join(".hq/scope-quarantine/journal-001/companies/indigo/file-0000.md");
        let head_second = future_test_second();
        let journal_modified =
            UNIX_EPOCH + Duration::from_secs(head_second) + Duration::from_millis(700);

        git_ok(tmp.path(), &["add", "-A"]);
        git_ok_at_seconds(
            tmp.path(),
            &[
                "commit",
                "-q",
                "-m",
                "scope shrink before same-second return",
            ],
            head_second - 1,
        );
        set_modified(copy.parent().unwrap(), journal_modified);
        fs::copy(&copy, &source).expect("return the quarantined file to scope");
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok_at_seconds(
            tmp.path(),
            &[
                "commit",
                "-q",
                "-m",
                "file returned in journal timestamp second",
            ],
            head_second,
        );

        fs::remove_file(&source).expect("user deliberately deletes the returned file");
        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            restore_scope_quarantine_move_index_entries(tmp.path().to_str().unwrap())
                .expect("check same-second journal provenance"),
            0,
            "a same-second journal tie must not restore a later path deletion"
        );
        assert_eq!(
            count_staged_deletions(tmp.path().to_str().unwrap())
                .expect("read staged source deletion")
                .count,
            1,
            "the tie leaves the deliberate deletion staged for the mirror"
        );

        git_ok(tmp.path(), &["reset", "-q"]);
        let before_delete_commit = rev_count(tmp.path());
        run_mirror_at_with_quarantine_flag(tmp.path(), true)
            .expect("same-second provenance keeps the deletion on the ordinary mirror path");
        assert_eq!(
            rev_count(tmp.path()),
            before_delete_commit + 1,
            "the mirror commits the deliberate deletion"
        );
        let show = git(
            tmp.path(),
            &[
                "show",
                "--format=",
                "--name-status",
                "HEAD",
                "--",
                "companies/indigo/file-0000.md",
            ],
        );
        assert!(show.status.success());
        assert_eq!(
            String::from_utf8_lossy(&show.stdout).trim(),
            "D\tcompanies/indigo/file-0000.md",
            "the mirror commit records the source deletion"
        );
    }

    #[test]
    fn journal_one_second_after_head_keeps_the_fast_path() {
        let head_commit_time = UNIX_EPOCH + Duration::from_secs(future_test_second());
        let journal_modified = head_commit_time + Duration::from_secs(1);

        assert!(
            !journal_requires_path_history(journal_modified, head_commit_time),
            "a journal one whole second newer than HEAD must avoid the path-history lookup"
        );
    }

    #[test]
    fn quarantine_reset_handles_5000_long_paths_without_oversized_argv() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let long_directory = "d".repeat(100);
        let mut paths = Vec::with_capacity(5_000);
        for index in 0..5_000 {
            let relative = format!(
                "companies/{long_directory}/file-{index:04}-{}.md",
                "x".repeat(60)
            );
            let source = tmp.path().join(&relative);
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(&source, format!("large path fixture {index}\n")).unwrap();
            paths.push(relative);
        }
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(tmp.path(), &["commit", "-q", "-m", "seed long path tree"]);

        for path in &paths {
            fs::remove_file(tmp.path().join(path)).unwrap();
        }
        git_ok(tmp.path(), &["add", "-A"]);
        assert_eq!(
            count_staged_deletions(tmp.path().to_str().unwrap())
                .expect("read large staged deletion set")
                .count,
            5_000
        );
        assert_eq!(
            reset_quarantined_mirror_paths(tmp.path().to_str().unwrap(), &paths)
                .expect("reset large quarantine move set"),
            5_000,
            "all matching paths fit through Git's NUL-delimited pathspec file"
        );
        assert_eq!(
            count_staged_deletions(tmp.path().to_str().unwrap())
                .expect("read staged deletions after reset")
                .count,
            0,
            "the large path set is removed from the deletion set"
        );
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
        // `push_after_mirror` deliberately uses a process-global, non-blocking
        // lock. Keep this assertion from racing the test that holds that lock
        // to model an in-flight push.
        let _serial = serial();
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

    #[test]
    fn push_in_flight_does_not_block_the_next_local_snapshot() {
        let _serial = serial();
        let work = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
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

        *LAST_MIRROR_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let push_guard = PUSH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = rev_count(work.path());
        fs::write(work.path().join("while-pushing"), "new snapshot").unwrap();

        mirror_after_sync(work.path().to_str().unwrap());

        assert_eq!(
            rev_count(work.path()),
            before + 1,
            "an in-flight push must not suppress the next local snapshot"
        );
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
        let previous_local =
            String::from_utf8(git(work.path(), &["rev-parse", "HEAD^"]).stdout).unwrap();
        assert_eq!(
            remote_head.trim(),
            previous_local.trim(),
            "the overlapping push should be skipped while preserving the local commit"
        );

        drop(push_guard);
        *LAST_MIRROR_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    // ── size-gated mirror exclusions ─────────────────────────────────────

    /// Removes the size-cap override on drop so a panicking test can't leak a
    /// tiny cap into another (env vars are process-global; only `serial()` tests
    /// set this, and the non-serial git tests all track well under 1 MiB).
    struct CapEnvGuard;
    impl Drop for CapEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(MIRROR_SIZE_CAP_ENV);
        }
    }
    fn set_cap_mb(mb: &str) -> CapEnvGuard {
        std::env::set_var(MIRROR_SIZE_CAP_ENV, mb);
        CapEnvGuard
    }

    fn ls_files(dir: &Path, pathspec: &str) -> Vec<String> {
        let out = git(dir, &["ls-files", "--", pathspec]);
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    }

    /// What the repo actually *tracks* — the committed tree, not the index. The
    /// index picks up whatever `run_mirror`'s `add -A` staged, so it is the wrong
    /// place to ask whether a file was untracked; only a commit can do that.
    fn head_files(dir: &Path) -> Vec<String> {
        let out = git(dir, &["ls-tree", "-r", "--name-only", "HEAD"]);
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    }

    /// Paths the index has staged for *deletion* relative to HEAD. The latch path
    /// must never produce one: removing a tracked file from the index is the first
    /// half of the untracking behaviour this change exists to delete.
    fn staged_deletions(dir: &Path) -> Vec<String> {
        let out = git(dir, &["diff", "--cached", "--diff-filter=D", "--name-only"]);
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn size_cap_env_override_parses_mebibytes() {
        let _serial = serial();
        let _cap = set_cap_mb("2048");
        assert_eq!(resolve_mirror_size_cap(), 2048 * 1024 * 1024);
        // A non-numeric override falls back to the compiled default.
        std::env::set_var(MIRROR_SIZE_CAP_ENV, "not-a-number");
        assert_eq!(resolve_mirror_size_cap(), MIRROR_SIZE_CAP_BYTES);
    }

    #[test]
    fn mirror_is_inert_below_cap() {
        let _serial = serial();
        let _cap = set_cap_mb("64"); // 64 MiB, far above the tiny seed
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let logs = tmp.path().join("workspace/.session-logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("s1.jsonl"), "small\n").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(rev_count(tmp.path()), before, "under cap must not commit");
        assert!(
            !ls_files(tmp.path(), "workspace/.session-logs").is_empty(),
            "session-logs must stay tracked when under cap"
        );
        assert!(
            read_disable_latch(&resolve_git_dir(tmp.path().to_str().unwrap()).unwrap()).is_none(),
            "an under-cap pass must not latch"
        );
    }

    #[test]
    fn over_cap_latches_the_mirror_off_without_committing() {
        let _serial = serial();
        let _cap = set_cap_mb("1");

        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        let ws = tmp.path().join("workspace/.session-logs");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("big.jsonl"), vec![b'x'; 2 * 1024 * 1024]).unwrap();

        run_mirror_at(tmp.path()).expect("mirror ok");

        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();
        let latch = read_disable_latch(&git_dir).expect("over cap must latch the mirror off");
        assert!(latch.measured_bytes > latch.cap_bytes);
        assert_eq!(
            rev_count(tmp.path()),
            before,
            "a latched pass commits nothing"
        );
        // The index keeps whatever `add -A` staged — the latch path adds no
        // further mutation of its own. What it must never do is *remove* a
        // tracked path from the index, which is how the old ladder began.
        assert_eq!(
            staged_deletions(tmp.path()),
            Vec::<String>::new(),
            "a latched pass must not stage any deletion"
        );
        assert!(
            ls_files(tmp.path(), ".").contains(&"README".to_string()),
            "the previously tracked file must still be in the index"
        );
        assert!(
            ws.join("big.jsonl").exists(),
            "the user's file must not be touched"
        );
    }

    /// Regression pin on the behaviour this module deliberately gave up: the
    /// mirror used to stay under the cap by appending to the root `.gitignore`
    /// and running `git rm -r --cached workspace`, untracking the user's files
    /// from a background daemon. Going over the cap must now change nothing
    /// about what the repo tracks.
    #[test]
    fn over_cap_never_untracks_anything_or_edits_gitignore() {
        let _serial = serial();
        let _cap = set_cap_mb("1");

        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join(".gitignore"), "*.tmp\n").unwrap();
        let logs = tmp.path().join("workspace/.session-logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("s1.jsonl"), "tracked").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let tracked_before = head_files(tmp.path());

        // Push the staged snapshot over the cap.
        fs::write(logs.join("big.jsonl"), vec![b'x'; 2 * 1024 * 1024]).unwrap();

        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(
            head_files(tmp.path()),
            tracked_before,
            "going over the cap must not untrack anything"
        );
        assert_eq!(
            staged_deletions(tmp.path()),
            Vec::<String>::new(),
            "nor stage the removal that untracking would start with"
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "*.tmp\n",
            "the user's .gitignore must be left exactly as they wrote it"
        );
        let subjects =
            String::from_utf8_lossy(&git(tmp.path(), &["log", "--all", "--pretty=%s"]).stdout)
                .to_string();
        assert!(
            !subjects.contains("stop tracking"),
            "no exclusion commit may be made:\n{subjects}"
        );
    }

    #[test]
    fn a_latched_root_is_never_staged_or_committed() {
        let _serial = serial();
        let _cap = set_cap_mb("1");

        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();
        write_disable_latch(
            &git_dir,
            3 * 1024 * 1024,
            1024 * 1024,
            DisableReason::StagedSnapshot,
            Utc::now(),
        );
        let before = rev_count(tmp.path());

        // Ordinary, well-under-cap work that a healthy mirror would commit.
        fs::write(tmp.path().join("note.md"), "new").unwrap();
        *LAST_MIRROR_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        mirror_after_sync(tmp.path().to_str().unwrap());

        assert_eq!(
            rev_count(tmp.path()),
            before,
            "a latched root must not be committed to"
        );
        assert!(
            index_is_clean(tmp.path()),
            "a latched root must not even be staged"
        );
        assert!(
            read_disable_latch(&git_dir).is_some(),
            "the latch clears only by hand"
        );

        // Control: clearing the latch by hand — the only way back — restores the
        // mirror. Without this the assertions above would also pass if the run
        // had merely been throttled.
        fs::remove_file(disable_path(&git_dir)).unwrap();
        *LAST_MIRROR_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        mirror_after_sync(tmp.path().to_str().unwrap());
        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "clearing the latch must bring the mirror back"
        );
    }

    #[test]
    fn a_corrupt_latch_file_still_disables_the_mirror() {
        // Every other record here fails open, because a bad one only costs a log
        // line. This one is the guard, so it fails closed: present-but-garbage
        // must not read as "carry on".
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();
        fs::write(git_dir.join(DISABLE_STATE_FILE), "{ not json").unwrap();

        let latch = read_disable_latch(&git_dir).expect("a corrupt latch still disables");
        assert_eq!(latch.cap_bytes, resolve_mirror_size_cap());
        // The notice still names the file to delete, which is all a user needs.
        let notice = disable_notice(tmp.path().to_str().unwrap(), &git_dir, &latch);
        assert!(notice.contains(DISABLE_STATE_FILE), "{notice}");
    }

    #[test]
    fn oversized_unpushed_history_latches_the_mirror_off() {
        // The staged-snapshot measurement only sees the next commit. An oversized
        // blob already committed by another writer must stop the mirror at the
        // push, not be retried every minute.
        let _serial = serial();
        let _cap = set_cap_mb("1");

        let tmp = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        assert!(Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("git available")
            .status
            .success());
        init_repo(tmp.path());
        assert!(git(
            tmp.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()]
        )
        .status
        .success());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        assert!(git(tmp.path(), &["push", "-q", "-u", "origin", "main"])
            .status
            .success());

        // Another writer commits an oversized blob the mirror never measured.
        // `rev-list --disk-usage` reports PACKED size, so the payload has to be
        // incompressible — a run of one byte packs down to a few hundred and
        // would never cross the cap.
        fs::write(tmp.path().join("big.bin"), incompressible(3 * 1024 * 1024)).unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "someone else"])
            .status
            .success());
        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();
        let remote_head_before = remote_head(remote.path());

        push_with_backoff(tmp.path().to_str().unwrap(), &git_dir, Utc::now());

        let latch = read_disable_latch(&git_dir).expect("oversized history must latch off");
        assert_eq!(
            latch.reason,
            Some(DisableReason::UnpushedHistory),
            "the cause has to be recorded — it decides which remedy the notice gives"
        );
        // The record carries the byte count the decision was made on, not a
        // second, separately-taken reading.
        assert!(
            latch.measured_bytes > latch.cap_bytes,
            "measured {} must exceed cap {}",
            latch.measured_bytes,
            latch.cap_bytes
        );
        assert_eq!(
            remote_head(remote.path()),
            remote_head_before,
            "the oversized commit must not reach the remote"
        );
    }

    /// The size backstop runs before the push-backoff early return. A permanent
    /// rejection parks an active block for six hours; if the size check sat behind
    /// that return, an over-cap repo would keep committing for the whole cooldown
    /// without ever latching.
    #[test]
    fn an_active_push_block_does_not_hide_oversized_history() {
        let _serial = serial();
        let _cap = set_cap_mb("1");

        let tmp = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        assert!(Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("git available")
            .status
            .success());
        init_repo(tmp.path());
        assert!(git(
            tmp.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()]
        )
        .status
        .success());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        assert!(git(tmp.path(), &["push", "-q", "-u", "origin", "main"])
            .status
            .success());
        fs::write(tmp.path().join("big.bin"), incompressible(3 * 1024 * 1024)).unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "someone else"])
            .status
            .success());

        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();
        let now = Utc::now();
        // A permanent rejection recorded one minute ago: firmly inside the cooldown.
        write_push_block(
            &git_dir,
            &PersistedPushBlock {
                blocked_at: (now - chrono::Duration::minutes(1))
                    .to_rfc3339_opts(SecondsFormat::Secs, true),
                reason: "file too large".to_string(),
            },
        );
        assert!(
            push_block_is_active(read_push_block(&git_dir).as_ref(), now),
            "the block must really be active, or this test proves nothing"
        );

        push_with_backoff(tmp.path().to_str().unwrap(), &git_dir, now);

        assert_eq!(
            read_disable_latch(&git_dir).and_then(|l| l.reason),
            Some(DisableReason::UnpushedHistory),
            "an active push block must not stop the size backstop from latching"
        );
    }

    /// A history-caused latch cannot be cleared by deleting files: the oversized
    /// objects are already in commits. Telling someone to "shrink the repo" would
    /// send them round a loop that re-latches on the very next pass.
    #[test]
    fn a_history_latch_tells_the_user_to_rewrite_not_to_shrink() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();

        let history = PersistedDisable {
            disabled_at: String::new(),
            measured_bytes: 3 * 1024 * 1024,
            cap_bytes: 1024 * 1024,
            reason: Some(DisableReason::UnpushedHistory),
        };
        let notice = disable_notice("root", &git_dir, &history);
        assert!(notice.contains("unpushed history measured"), "{notice}");
        assert!(notice.contains("reset"), "{notice}");
        assert!(
            notice.contains("will not help"),
            "the notice must say outright that deleting content is not the fix:\n{notice}"
        );

        // The staged-snapshot cause keeps the remedy that does work for it.
        let staged = PersistedDisable {
            reason: Some(DisableReason::StagedSnapshot),
            ..history.clone()
        };
        let notice = disable_notice("root", &git_dir, &staged);
        assert!(notice.contains("Shrink the working tree"), "{notice}");
        assert!(
            !notice.contains("will not help"),
            "the two causes must not share one remedy:\n{notice}"
        );

        // An unreadable record knows neither cause, so it must name both rather
        // than pick one and be wrong half the time.
        let unknown = PersistedDisable {
            reason: None,
            ..history.clone()
        };
        let notice = disable_notice("root", &git_dir, &unknown);
        assert!(notice.contains("Shrink the working tree"), "{notice}");
        assert!(
            notice.contains("reset or rewrite those commits"),
            "{notice}"
        );
    }

    /// `mirror_after_sync` checks the latch before taking the mirror lock, but the
    /// push path runs *without* that lock and can latch mid-flight. `run_mirror`
    /// must therefore re-check under the lock, or a pass that cleared the pre-lock
    /// check would still commit into a repo that has since been disabled.
    #[test]
    fn a_latch_written_after_the_pre_lock_check_still_stops_the_pass() {
        let _serial = serial();

        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());
        let git_dir = resolve_git_dir(tmp.path().to_str().unwrap()).unwrap();

        // Stands in for the push path latching between another invocation's
        // pre-lock read and its call into `run_mirror`.
        fs::write(tmp.path().join("new.md"), "would be committed").unwrap();
        write_disable_latch(
            &git_dir,
            3 * 1024 * 1024,
            1024 * 1024,
            DisableReason::UnpushedHistory,
            Utc::now(),
        );

        let outcome = run_mirror(tmp.path().to_str().unwrap(), &git_dir, false).expect("mirror ok");

        assert_eq!(outcome, MirrorOutcome::NoPush);
        assert_eq!(
            rev_count(tmp.path()),
            before,
            "run_mirror must not commit into a latched repo"
        );
        assert!(
            index_is_clean(tmp.path()),
            "and must not stage it either — the re-check comes before `add -A`"
        );

        // Control: without the latch the same pass does commit, so the assertions
        // above are testing the re-check and not some unrelated refusal.
        fs::remove_file(disable_path(&git_dir)).unwrap();
        run_mirror(tmp.path().to_str().unwrap(), &git_dir, false).expect("mirror ok");
        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "the pass must be otherwise committable"
        );
    }

    /// `len` bytes zlib cannot shrink, from a fixed-seed xorshift so the test is
    /// deterministic and needs no dependency.
    fn incompressible(len: usize) -> Vec<u8> {
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    }

    fn remote_head(bare: &Path) -> String {
        String::from_utf8_lossy(
            &Command::new("git")
                .arg("-C")
                .arg(bare)
                .args(["rev-parse", "main"])
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string()
    }

    #[cfg(unix)]
    #[test]
    fn mirror_commits_bypass_pre_commit_hooks() {
        // A user pre-commit hook must not run for the automated mirror commit —
        // it could stage generated/ignored files after the size measurement, and
        // a failing hook would silently stop the mirror. `--no-verify` bypasses it.
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());

        // A pre-commit hook that always fails — a hook-respecting commit aborts.
        let hook = tmp.path().join(".git/hooks/pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

        let before = rev_count(tmp.path());
        fs::write(tmp.path().join("new.txt"), "x").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "--no-verify must bypass the failing pre-commit hook"
        );
    }

    // ── B1 regression: the 2026-07-30 mass-deletion shape ────────────────

    #[test]
    fn bulk_deletion_commits_in_the_first_mirror_pass() {
        let _serial = serial();

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        delete_files(tmp.path(), 0..60);
        let before = rev_count(tmp.path());

        run_mirror_at(tmp.path()).expect("mirror commits the observed deletion");

        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "a deletion above the old threshold commits in the first pass"
        );
        assert_eq!(head_files(tmp.path()).len(), 40);
        assert!(
            index_is_clean(tmp.path()),
            "the deletion commit leaves the index clean"
        );
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_snapshot() {
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 12);
        let git_dir = git_dir_of(tmp.path());
        let missing = tmp.path().join("missing-root");

        let result = run_mirror(missing.to_str().unwrap(), &git_dir, false);

        assert!(
            result.is_err(),
            "a missing root must keep the mirror on its error path"
        );
        assert_eq!(
            rev_count(tmp.path()),
            1,
            "a missing root must not commit deletions"
        );
        assert_eq!(
            head_files(tmp.path()).len(),
            12,
            "the tracked snapshot stays intact"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_tracked_subtree_cannot_commit_partial_deletions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let nested = tmp.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("tracked.md"), "nested content").unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(tmp.path(), &["commit", "-q", "-m", "add nested fixture"]);
        let before = rev_count(tmp.path());
        delete_files(tmp.path(), 0..5);
        let original_permissions = fs::metadata(&nested).unwrap().permissions();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0)).unwrap();

        let result = run_mirror_at(tmp.path());

        fs::set_permissions(&nested, original_permissions).unwrap();
        assert!(
            result.is_err(),
            "a partially unreadable tree must remain an error"
        );
        assert_eq!(
            rev_count(tmp.path()),
            before,
            "partial deletions must not be committed"
        );
        assert_eq!(
            head_files(tmp.path()).len(),
            101,
            "HEAD must retain the full snapshot"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_root_is_an_error_not_an_empty_snapshot() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 12);
        let git_dir = git_dir_of(tmp.path());
        let original_permissions = fs::metadata(tmp.path()).unwrap().permissions();
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0)).unwrap();

        let result = run_mirror(tmp.path().to_str().unwrap(), &git_dir, false);

        fs::set_permissions(tmp.path(), original_permissions).unwrap();
        assert!(
            result.is_err(),
            "an unreadable root must keep the mirror on its error path"
        );
        assert_eq!(
            rev_count(tmp.path()),
            1,
            "an unreadable root must not commit deletions"
        );
        assert_eq!(
            head_files(tmp.path()).len(),
            12,
            "the tracked snapshot stays intact"
        );
    }

    #[test]
    fn staged_deletion_count_tracks_paths() {
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        delete_files(tmp.path(), 0..50);
        assert!(git(tmp.path(), &["add", "-A"]).status.success());

        let staged = count_staged_deletions(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(staged.count, 50);
    }

    #[test]
    fn small_deletion_commits_in_one_pass() {
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let before = rev_count(tmp.path());
        delete_files(tmp.path(), 0..5);

        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(rev_count(tmp.path()), before + 1);
        assert!(index_is_clean(tmp.path()));
    }

    #[test]
    fn large_directory_move_is_committed() {
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 40);
        let before = rev_count(tmp.path());

        let moved = tmp.path().join("moved");
        fs::create_dir(&moved).unwrap();
        for i in 0..30 {
            let name = format!("file-{i:04}.md");
            fs::rename(tmp.path().join(&name), moved.join(&name)).unwrap();
        }
        run_mirror_at(tmp.path()).expect("mirror ok");

        assert_eq!(rev_count(tmp.path()), before + 1);
        assert!(index_is_clean(tmp.path()));
    }

    #[test]
    fn size_latch_still_precedes_deletion_commit() {
        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 100);
        let git_dir = git_dir_of(tmp.path());
        let before = rev_count(tmp.path());
        delete_files(tmp.path(), 0..60);
        fs::write(git_dir.join(DISABLE_STATE_FILE), "{ latched").unwrap();

        run_mirror_at(tmp.path()).expect("a size-latched pass is not an error");

        assert_eq!(
            rev_count(tmp.path()),
            before,
            "a size-latched root commits nothing"
        );
        assert!(
            index_is_clean(tmp.path()),
            "the latch returns before staging changes"
        );
    }

    #[test]
    fn stale_orphaned_lock_is_reaped_and_the_mirror_proceeds() {
        let _serial = serial();
        reset_index_lock_report_state();
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
        let mut reaped = false;
        let events = sentry::test::with_captured_events(|| {
            reaped = reap_index_lock_if_stale(
                tmp.path().to_str().unwrap(),
                &git_dir,
                STALE_LOCK_MIN_AGE,
                SystemTime::now() + Duration::from_secs(3600),
            );
        });
        set_probe_override(None);

        assert!(reaped, "an empty, unheld, aged lock must be reaped");
        assert!(!lock.exists());
        // An empty reap is routine self-heal, never a Sentry event.
        assert!(
            events.is_empty(),
            "reaping an empty orphaned lock must not capture anything"
        );

        fs::write(tmp.path().join("after-reap.md"), "content").unwrap();
        run_mirror_at(tmp.path()).expect("mirror ok");
        assert_eq!(rev_count(tmp.path()), before + 1);
    }

    #[test]
    fn fresh_lock_blocks_the_mirror_and_is_not_reaped() {
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let before = rev_count(tmp.path());

        let lock = index_lock_path(&git_dir_of(tmp.path()));
        fs::write(&lock, b"").unwrap();
        fs::write(tmp.path().join("blocked.md"), "content").unwrap();

        let mut result: Result<(), String> = Ok(());
        let events = sentry::test::with_captured_events(|| {
            result = run_mirror_at(tmp.path());
        });
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
        // A fresh lock is neither reaped nor wedged — a blocked pass must stay
        // silent in Sentry (the whole point: only a confirmed, unrecoverable
        // wedge warns).
        assert!(
            events.is_empty(),
            "a fresh lock that merely blocks a pass must not capture anything"
        );
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn nonempty_orphaned_lock_refuses_and_logs_but_does_not_yet_capture() {
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let now = SystemTime::now() + Duration::from_secs(3600);
        let state = read_index_lock_state(&lock, now);
        let mut reaped = true;
        let events = sentry::test::with_captured_events(|| {
            reaped = reap_index_lock_if_stale(
                tmp.path().to_str().unwrap(),
                &git_dir,
                STALE_LOCK_MIN_AGE,
                now,
            );
        });
        set_probe_override(None);

        assert!(
            is_orphaned_but_nonempty(state, STALE_LOCK_MIN_AGE),
            "this is the state that refuses rather than reaps"
        );
        assert!(!reaped, "a non-empty lock must never be removed");
        assert!(lock.exists());
        // The first observation opens the hard-timeout clock and refuses — it is
        // NOT yet an unrecoverable wedge, so it logs locally and captures nothing.
        // On the pre-fix code this exact pass captured a warning; that is the
        // over-reporting this fix removes.
        assert!(
            events.is_empty(),
            "the first refusing observation must not capture a Sentry event: {:?}",
            events.iter().map(|e| e.message.clone()).collect::<Vec<_>>()
        );
        // But it DID leave the durable clock behind, exactly as before.
        assert!(
            read_wedge_state(&git_dir).is_some(),
            "the wedge clock must open on the first observation"
        );
        fs::remove_file(&lock).unwrap();
    }

    // ── hard-timeout escape hatch for the wedged non-empty lock ───────────

    fn wedge_record(first_seen: DateTime<Utc>, mtime_nanos: i64) -> PersistedIndexLockWedge {
        PersistedIndexLockWedge {
            first_seen_at: first_seen.to_rfc3339_opts(SecondsFormat::Secs, true),
            lock_mtime_nanos: mtime_nanos,
            size_bytes: 42,
            reports: 0,
            last_report_at: None,
        }
    }

    #[test]
    fn wedge_decision_starts_the_clock_when_there_is_nothing_to_compare() {
        let now = epoch();
        let p = Path::new("state.json");
        // No prior observation: this pass opens the clock.
        assert_eq!(
            decide_wedge_reap(None, Some(100), now, WEDGED_LOCK_HARD_TIMEOUT, p),
            WedgeDecision::StartClock
        );
        // Unreadable current mtime cannot prove the lock is frozen, even against
        // a long-matured prior record.
        let matured = wedge_record(now - chrono::Duration::seconds(9999), 100);
        assert_eq!(
            decide_wedge_reap(Some(&matured), None, now, WEDGED_LOCK_HARD_TIMEOUT, p),
            WedgeDecision::StartClock
        );
    }

    #[test]
    fn wedge_decision_resets_when_the_mtime_advances() {
        let now = epoch();
        let p = Path::new("state.json");
        // Same episode on paper, but the live mtime moved: a writer touched the
        // index, so this is not a corpse — reset rather than reap.
        let prior = wedge_record(now - chrono::Duration::seconds(9999), 100);
        assert_eq!(
            decide_wedge_reap(Some(&prior), Some(200), now, WEDGED_LOCK_HARD_TIMEOUT, p),
            WedgeDecision::StartClock
        );
    }

    #[test]
    fn wedge_decision_awaits_within_the_window_then_reaps_past_it() {
        let now = epoch();
        let p = Path::new("state.json");
        // Same frozen lock, seen only briefly — keep waiting.
        let fresh = wedge_record(now - chrono::Duration::seconds(60), 100);
        assert_eq!(
            decide_wedge_reap(Some(&fresh), Some(100), now, WEDGED_LOCK_HARD_TIMEOUT, p),
            WedgeDecision::AwaitTimeout
        );
        // Same frozen lock, continuously dead past the hard timeout — reap.
        let matured = wedge_record(
            now - chrono::Duration::seconds(WEDGED_LOCK_HARD_TIMEOUT.as_secs() as i64 + 5),
            100,
        );
        match decide_wedge_reap(Some(&matured), Some(100), now, WEDGED_LOCK_HARD_TIMEOUT, p) {
            WedgeDecision::Reap { wedged_secs } => {
                assert!(wedged_secs >= WEDGED_LOCK_HARD_TIMEOUT.as_secs())
            }
            other => panic!("expected Reap past the hard timeout, got {other:?}"),
        }
    }

    #[test]
    fn wedge_decision_discards_a_future_stamp_rather_than_maturing_it() {
        let now = epoch();
        let p = Path::new("state.json");
        // A first_seen dated in the future (a backwards clock, DST jump, or a
        // copied `.git`) must re-open the clock, never confirm an instant reap —
        // the same fail-safe every stamp in this module obeys.
        let future = wedge_record(now + chrono::Duration::seconds(100), 100);
        assert_eq!(
            decide_wedge_reap(Some(&future), Some(100), now, WEDGED_LOCK_HARD_TIMEOUT, p),
            WedgeDecision::StartClock
        );
    }

    /// The injected `now` is pushed an hour ahead so the 300s age gate is met
    /// without rewriting the lock's mtime; the wedge clock is driven purely by
    /// the persisted `first_seen`, so these tests never sleep.
    fn future_now() -> SystemTime {
        SystemTime::now() + Duration::from_secs(3600)
    }

    #[test]
    fn wedged_lock_frozen_past_the_hard_timeout_is_backed_up_and_reaped() {
        let _serial = serial();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let now = future_now();
        let wall_now: DateTime<Utc> = now.into();
        let mtime = read_index_lock_state(&lock, now).mtime_nanos.unwrap();
        // Same frozen mtime, opened well past the hard timeout.
        write_wedge_state(
            &git_dir,
            &wedge_record(wall_now - chrono::Duration::seconds(2000), mtime),
        );

        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            now,
        );
        set_probe_override(None);

        assert!(
            reaped,
            "a lock proven dead past the hard timeout must be reaped"
        );
        assert!(!lock.exists(), "the wedged lock must be removed");

        // A forensic backup with the original bytes must survive beside it.
        let backups: Vec<_> = fs::read_dir(&git_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("index.lock.reaped-")
            })
            .collect();
        assert_eq!(
            backups.len(),
            1,
            "exactly one forensic backup must be written"
        );
        assert_eq!(
            fs::read(backups[0].path()).unwrap(),
            b"partial index data",
            "the backup must preserve the original (possibly partial) index bytes"
        );
        assert!(
            read_wedge_state(&git_dir).is_none(),
            "the wedge clock must be cleared once the lock is gone"
        );
    }

    #[test]
    fn wedged_lock_whose_mtime_advanced_resets_the_clock_and_is_not_reaped() {
        let _serial = serial();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let now = future_now();
        let wall_now: DateTime<Utc> = now.into();
        let mtime = read_index_lock_state(&lock, now).mtime_nanos.unwrap();
        // Record is old enough to reap, but its mtime differs from the live
        // file's — a writer touched the index since, so it must NOT be reaped.
        write_wedge_state(
            &git_dir,
            &wedge_record(wall_now - chrono::Duration::seconds(2000), mtime - 1),
        );

        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            now,
        );
        set_probe_override(None);

        assert!(
            !reaped,
            "an advancing mtime means a live writer; never reap"
        );
        assert!(lock.exists());
        // The clock reset to the live mtime and this pass's stamp.
        let rec = read_wedge_state(&git_dir).expect("the clock must restart");
        assert_eq!(rec.lock_mtime_nanos, mtime);
        assert_eq!(
            rec.first_seen_at,
            wall_now.to_rfc3339_opts(SecondsFormat::Secs, true)
        );
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn wedged_lock_with_a_holder_is_never_reaped_even_past_the_timeout() {
        let _serial = serial();
        // A holder is present: the fail-closed probe says a writer may be live.
        set_probe_override(Some((true, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let now = future_now();
        let wall_now: DateTime<Utc> = now.into();
        let mtime = read_index_lock_state(&lock, now).mtime_nanos.unwrap();
        write_wedge_state(
            &git_dir,
            &wedge_record(wall_now - chrono::Duration::seconds(2000), mtime),
        );

        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            now,
        );
        set_probe_override(None);

        assert!(
            !reaped,
            "an open handle means a possible live writer; the timeout must not override it"
        );
        assert!(lock.exists());
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn wedged_lock_before_the_hard_timeout_still_refuses_and_opens_the_clock() {
        let _serial = serial();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        // Past the 300s grace (via the injected future now) but with no prior
        // observation, so the hard-timeout clock only opens on this pass — the
        // pre-timeout window must behave exactly as before: refuse and signal.
        let now = future_now();
        let wall_now: DateTime<Utc> = now.into();
        assert!(read_wedge_state(&git_dir).is_none());

        let reaped = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            now,
        );
        assert!(
            !reaped,
            "the first observation must refuse, exactly as before"
        );
        assert!(
            lock.exists(),
            "the wedged lock stays until the hard timeout"
        );
        let rec = read_wedge_state(&git_dir).expect("the clock opens on first observation");
        assert_eq!(
            rec.first_seen_at,
            wall_now.to_rfc3339_opts(SecondsFormat::Secs, true)
        );

        // A second immediate pass is still inside the window: keep refusing, and
        // the clock must not restart (that would push the deadline out forever).
        let reaped2 = reap_index_lock_if_stale(
            tmp.path().to_str().unwrap(),
            &git_dir,
            STALE_LOCK_MIN_AGE,
            now,
        );
        set_probe_override(None);
        assert!(!reaped2);
        assert!(lock.exists());
        let rec2 = read_wedge_state(&git_dir).expect("the clock stays open");
        assert_eq!(
            rec2.first_seen_at, rec.first_seen_at,
            "the confirmation clock must not restart within the window"
        );
        fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn hard_timeout_override_is_honored_with_a_safety_floor() {
        let _serial = serial();
        // Default when unset.
        std::env::remove_var(WEDGED_LOCK_HARD_TIMEOUT_ENV);
        assert_eq!(wedged_lock_hard_timeout(), WEDGED_LOCK_HARD_TIMEOUT);
        // A larger value is taken verbatim, for field tuning.
        std::env::set_var(WEDGED_LOCK_HARD_TIMEOUT_ENV, "5400");
        assert_eq!(wedged_lock_hard_timeout(), Duration::from_secs(5400));
        // Below the empty-lock grace is clamped up to it: the escape hatch must
        // never fire faster than the routine reaper, whatever the knob says.
        std::env::set_var(WEDGED_LOCK_HARD_TIMEOUT_ENV, "5");
        assert_eq!(wedged_lock_hard_timeout(), STALE_LOCK_MIN_AGE);
        // Garbage falls back to the safe default rather than disabling the guard.
        std::env::set_var(WEDGED_LOCK_HARD_TIMEOUT_ENV, "not-a-number");
        assert_eq!(wedged_lock_hard_timeout(), WEDGED_LOCK_HARD_TIMEOUT);
        std::env::remove_var(WEDGED_LOCK_HARD_TIMEOUT_ENV);
    }

    // ── over-reporting fix: the wedge warning is paced, not per-pass ──────

    /// Count the captured events tagged as a wedged-lock warning.
    fn wedged_warnings(events: &[sentry::protocol::Event<'static>]) -> usize {
        events
            .iter()
            .filter(|e| {
                e.tags.get("git_mirror_kind").map(String::as_str) == Some("index-lock-wedged")
            })
            .count()
    }

    /// Force `back_up_wedged_lock` to fail deterministically by pre-creating the
    /// exact backup target it would write as a *directory* — `fs::copy` into an
    /// existing directory errors on every platform. The backup name is derived
    /// from `wall_now` at seconds resolution, so a fixed injected clock makes this
    /// stable for the whole pass.
    fn block_wedge_backup(git_dir: &Path, wall_now: DateTime<Utc>) {
        let stamp = wall_now
            .to_rfc3339_opts(SecondsFormat::Secs, true)
            .replace(':', "-");
        fs::create_dir_all(git_dir.join(format!("index.lock.reaped-{stamp}"))).unwrap();
    }

    #[test]
    fn wedge_report_decision_table() {
        let warn = WEDGE_WARN_AFTER;
        let cooldown = WEDGE_REPORT_COOLDOWN;
        let ladder = WEDGE_ESCALATION_AGES;
        let d = |reports, age: Duration, since: Option<Duration>, failed| {
            decide_wedge_report(reports, age, since, failed, warn, cooldown, &ladder)
        };
        let past_warn = warn + Duration::from_secs(60);

        // Recovery has NOT failed (the escape hatch cleared it, or has not run):
        // never a warning, whatever the age. A self-healed wedge bills none.
        assert_eq!(
            d(0, past_warn, None, false),
            WedgeReportAction::AwaitConfirmation
        );
        // Failed but younger than the fixed warning floor: not yet actionable.
        assert_eq!(
            d(0, warn - Duration::from_secs(1), None, true),
            WedgeReportAction::AwaitConfirmation
        );
        // Failed, past the floor, never warned: the first warning.
        assert_eq!(
            d(0, past_warn, None, true),
            WedgeReportAction::ReportFirstConfirmed
        );
        // Warned once, inside the cooldown floor: suppressed even though the age
        // would otherwise cross the first rung.
        assert_eq!(
            d(1, ladder[0], Some(cooldown - Duration::from_secs(1)), true),
            WedgeReportAction::Suppress
        );
        // Warned once, past the cooldown, past the first rung: escalate.
        assert_eq!(
            d(1, ladder[0], Some(cooldown), true),
            WedgeReportAction::ReportEscalation
        );
        // Warned once, past the cooldown, but NOT yet at the first rung: hold.
        assert_eq!(
            d(1, ladder[0] - Duration::from_secs(1), Some(cooldown), true),
            WedgeReportAction::Suppress
        );
        // Warned twice, past the cooldown, past the second rung: the last rung.
        assert_eq!(
            d(2, ladder[1], Some(cooldown), true),
            WedgeReportAction::ReportEscalation
        );
        // Budget exhausted: reports beyond the ladder never warn again, however
        // old the wedge gets.
        assert_eq!(
            d(ladder.len() + 1, ladder[1] * 100, Some(cooldown), true),
            WedgeReportAction::Suppress
        );
        // A future-dated last-report stamp resolves to `None` upstream (the shared
        // backwards-clock fail-safe in `elapsed_since_wall`), and `None` re-arms
        // rather than latches: an already-warned wedge still escalates when its
        // cooldown anchor is unusable, never goes silent.
        assert_eq!(
            d(1, ladder[0], None, true),
            WedgeReportAction::ReportEscalation
        );
        // The whole life of an unrecoverable wedge bills exactly len() + 1.
        let emitting = [
            d(0, past_warn, None, true),
            d(1, ladder[0], Some(cooldown), true),
            d(2, ladder[1], Some(cooldown), true),
        ];
        assert_eq!(
            emitting.iter().filter(|a| a.emits()).count(),
            WEDGE_ESCALATION_AGES.len() + 1
        );
    }

    #[test]
    fn one_mirror_pass_over_a_wedged_lock_captures_at_most_one_event() {
        // The reported cluster (HQ-DESKTOP-5F): one mirror pass makes TWO reaper
        // calls over a wedged non-empty lock — the pre-run reap in `run_mirror`
        // (min_age = STALE_LOCK_MIN_AGE) and, after `git add -A` fails on the
        // still-present lock, the failure-arm reap in `mirror_after_sync`
        // (min_age = ZERO). On the pre-fix code each captured a warning, so ONE
        // self-healing pass billed the observed 15:18:37 / 15:18:39 pair. The same
        // two calls must now capture nothing: neither is an unrecoverable wedge.
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let hq = tmp.path().to_str().unwrap();
        let now = future_now();
        let events = sentry::test::with_captured_events(|| {
            assert!(!reap_index_lock_if_stale(
                hq,
                &git_dir,
                STALE_LOCK_MIN_AGE,
                now
            ));
            assert!(!reap_index_lock_if_stale(hq, &git_dir, Duration::ZERO, now));
        });
        set_probe_override(None);

        assert!(lock.exists(), "a non-empty lock is never removed");
        assert!(
            events.is_empty(),
            "one mirror pass over a fresh wedge must capture zero events \
             (pre-fix: two warnings); got: {:?}",
            events
                .iter()
                .map(|e| (e.level, e.tags.get("git_mirror_kind").cloned()))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_self_healed_wedge_episode_bills_exactly_one_info_event() {
        // The full reported episode (HQ-DESKTOP-5F + 5G): two refusing passes then
        // the escape hatch reaps and heals ~1920s later. Pre-fix that billed three
        // events across two warning issues; it must now be exactly one Info notice.
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        // The reported lock size, so the preserved tag is proven byte-for-byte.
        fs::write(&lock, vec![b'x'; 5_767_168]).unwrap();

        let hq = tmp.path().to_str().unwrap();
        let now = future_now();
        // 1920s later, past the 30-minute hard timeout, without sleeping: the same
        // frozen lock carried on the same durable record.
        let later = now + Duration::from_secs(1920);

        let events = sentry::test::with_captured_events(|| {
            // Pass 1: pre-run reap opens the wedge clock (StartClock).
            assert!(!reap_index_lock_if_stale(
                hq,
                &git_dir,
                STALE_LOCK_MIN_AGE,
                now
            ));
            // Pass 2: post-`git add -A`-failure reap, same pass (AwaitTimeout).
            assert!(!reap_index_lock_if_stale(hq, &git_dir, Duration::ZERO, now));
            // A later pass past the hard timeout: the escape hatch heals it.
            assert!(reap_index_lock_if_stale(
                hq,
                &git_dir,
                STALE_LOCK_MIN_AGE,
                later
            ));
        });
        set_probe_override(None);

        assert!(!lock.exists(), "the escape hatch removed the healed lock");
        assert!(
            read_wedge_state(&git_dir).is_none(),
            "the clock was cleared"
        );

        assert_eq!(
            events.len(),
            1,
            "a self-healed episode bills exactly one event, got: {:?}",
            events
                .iter()
                .map(|e| (e.level, e.message.clone()))
                .collect::<Vec<_>>()
        );
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Info);
        assert_eq!(event.tags["git_mirror_kind"], "index-lock-auto-reaped");
        assert_eq!(event.tags["lock_size_bytes"], "5767168");
        assert_eq!(event.tags["wedge_reports"], "0");
        assert!(event.tags.contains_key("wedged_secs"));
        assert_eq!(
            wedged_warnings(&events),
            0,
            "a self-healed episode must bill zero warnings"
        );
    }

    #[test]
    fn an_unrecoverable_wedge_warns_once_then_respects_the_cooldown_floor() {
        // Backup fails, so the lock cannot be recovered: this is the genuinely
        // actionable state, and it must earn EXACTLY one warning across a burst of
        // refusing passes — the cooldown floor swallows the rest.
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let hq = tmp.path().to_str().unwrap();
        let now = future_now();
        let wall_now: DateTime<Utc> = now.into();
        let mtime = read_index_lock_state(&lock, now).mtime_nanos.unwrap();
        // A matured, frozen clock so the reap fires; backup forced to fail so the
        // pass takes the unrecoverable branch and the lock stays put.
        write_wedge_state(
            &git_dir,
            &wedge_record(wall_now - chrono::Duration::seconds(2000), mtime),
        );
        block_wedge_backup(&git_dir, wall_now);

        let events = sentry::test::with_captured_events(|| {
            for _ in 0..5 {
                assert!(!reap_index_lock_if_stale(
                    hq,
                    &git_dir,
                    STALE_LOCK_MIN_AGE,
                    now
                ));
            }
        });
        set_probe_override(None);

        assert!(lock.exists(), "an unrecoverable wedge is never removed");
        assert_eq!(
            wedged_warnings(&events),
            1,
            "an unrecoverable wedge warns exactly once, not every pass; got {}",
            events.len()
        );
        let warning = &events[0];
        assert_eq!(warning.level, sentry::Level::Warning);
        assert_eq!(warning.tags["git_mirror_kind"], "index-lock-wedged");
        assert_eq!(warning.tags["wedge_reports"], "0");
        assert_eq!(warning.tags["source"], "first-confirmed");
        assert_eq!(warning.tags["lock_size_bytes"], "18"); // "partial index data"
                                                           // The spent budget is persisted on the same record for the next pass.
        let rec = read_wedge_state(&git_dir).expect("record persists while wedged");
        assert_eq!(rec.reports, 1);
        assert!(rec.last_report_at.is_some());
    }

    #[test]
    fn a_standing_unrecoverable_wedge_climbs_a_finite_ladder_then_goes_quiet() {
        // Drives the production reap-failure reporter (`report_wedge_if_due`) at a
        // sequence of durable wedge ages, reading and rewriting the on-disk budget
        // each pass exactly as the reap-failure branch does, and pins the finite
        // 24h/7d ladder end to end.
        let _serial = serial();
        reset_index_lock_report_state();

        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "root");
        let start = epoch();
        write_wedge_state(&git_dir, &wedge_record(start, 12_345));

        let drive = |secs: i64| -> Vec<sentry::protocol::Event<'static>> {
            let wall_now = start + chrono::Duration::seconds(secs);
            sentry::test::with_captured_events(|| {
                let prior = read_wedge_state(&git_dir);
                report_wedge_if_due(&git_dir, prior.as_ref(), secs as u64, 18, wall_now);
            })
        };

        // t = 40 min: first warning (past the 30-minute floor).
        let first = drive(40 * 60);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].tags["wedge_reports"], "0");
        assert_eq!(first[0].tags["source"], "first-confirmed");

        // t = 1 h 40 min: inside the 6-hour cooldown and below the 24-hour rung.
        assert_eq!(drive(40 * 60 + 3600).len(), 0);

        // t = 24 h: crosses the first rung, past the cooldown — escalate.
        let rung1 = drive(24 * 60 * 60);
        assert_eq!(rung1.len(), 1);
        assert_eq!(rung1[0].tags["wedge_reports"], "1");
        assert_eq!(rung1[0].tags["source"], "episode-escalation");

        // t = 7 d: crosses the second (last) rung — escalate.
        let rung2 = drive(7 * 24 * 60 * 60);
        assert_eq!(rung2.len(), 1);
        assert_eq!(rung2[0].tags["wedge_reports"], "2");

        // t = 30 d: budget exhausted — no more warnings, ever.
        assert_eq!(drive(30 * 24 * 60 * 60).len(), 0);

        let rec = read_wedge_state(&git_dir).expect("record persists");
        assert_eq!(
            rec.reports,
            WEDGE_ESCALATION_AGES.len() + 1,
            "a standing wedge bills at most escalation_ages.len() + 1 for its life"
        );
    }

    #[test]
    fn a_cleared_lock_resets_the_report_budget() {
        // A healed root can never be latched permanently silent: after the record
        // is cleared, a later fresh wedge earns its first warning again.
        let _serial = serial();
        reset_index_lock_report_state();

        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "root");
        let start = epoch();
        write_wedge_state(&git_dir, &wedge_record(start, 111));

        let wall1 = start + chrono::Duration::seconds(40 * 60);
        let first = sentry::test::with_captured_events(|| {
            let prior = read_wedge_state(&git_dir);
            report_wedge_if_due(&git_dir, prior.as_ref(), 40 * 60, 18, wall1);
        });
        assert_eq!(first.len(), 1);
        assert_eq!(read_wedge_state(&git_dir).unwrap().reports, 1);

        // The lock clears (vanished, empty-reaped, or wedged-reaped): the record is
        // cleared, exactly as the production lifecycle does on recovery.
        clear_wedge_state(&git_dir);
        assert!(read_wedge_state(&git_dir).is_none());

        // A later, fresh wedge opens a fresh budget and warns again.
        let wall2 = wall1 + chrono::Duration::seconds(24 * 60 * 60);
        write_wedge_state(&git_dir, &wedge_record(wall2, 222));
        let second = sentry::test::with_captured_events(|| {
            let prior = read_wedge_state(&git_dir);
            report_wedge_if_due(
                &git_dir,
                prior.as_ref(),
                40 * 60,
                18,
                wall2 + chrono::Duration::seconds(40 * 60),
            );
        });
        assert_eq!(second.len(), 1, "a fresh wedge must earn its warning again");
        assert_eq!(second[0].tags["wedge_reports"], "0");
        assert_eq!(second[0].tags["source"], "first-confirmed");
    }

    #[test]
    fn a_legacy_wedge_record_without_the_new_fields_still_earns_its_warning() {
        // A record written by the pre-fix build lacks `reports`/`last_report_at`.
        // Those must read as "nothing reported yet" so an in-flight upgrade cannot
        // latch a live wedge silent.
        let _serial = serial();
        reset_index_lock_report_state();

        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "root");
        let start = epoch();
        let legacy = format!(
            r#"{{"first_seen_at":"{}","lock_mtime_nanos":999,"size_bytes":18}}"#,
            start.to_rfc3339_opts(SecondsFormat::Secs, true)
        );
        fs::write(wedge_state_path(&git_dir), legacy).unwrap();

        let loaded = read_wedge_state(&git_dir).expect("a legacy record still loads");
        assert_eq!(
            loaded.reports, 0,
            "a missing budget reads as nothing reported"
        );
        assert!(loaded.last_report_at.is_none());

        let wall_now = start + chrono::Duration::seconds(40 * 60);
        let events = sentry::test::with_captured_events(|| {
            report_wedge_if_due(&git_dir, Some(&loaded), 40 * 60, 18, wall_now);
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags["source"], "first-confirmed");
        assert_eq!(events[0].tags["wedge_reports"], "0");
    }

    #[test]
    fn a_stale_or_unpersisted_budget_does_not_reopen_the_flood() {
        // Covers both review findings: (1) a full or read-only `.git` makes the
        // durable write fail so the on-disk `reports` never advances, and (2) an
        // overlapping launch-thread reap can read the same pre-increment record a
        // normal pass did. Both reduce to "a later observation still carries a
        // reports=0 record"; the shared, mutex-guarded in-memory budget must pace
        // it to one warning rather than re-emit `first-confirmed` every pass.
        let _serial = serial();
        reset_index_lock_report_state();

        let tmp = TempDir::new().unwrap();
        let git_dir = scratch_git_dir(&tmp, "root");
        let start = epoch();
        // A record whose persisted budget never advances past zero — exactly what
        // the caller keeps reading when the disk write cannot land, or what a
        // racing thread reads before the first increment is written.
        let stale = wedge_record(start, 777);

        let mut warnings = 0;
        for i in 0..5 {
            let wall_now = start + chrono::Duration::seconds(40 * 60 + i);
            let events = sentry::test::with_captured_events(|| {
                report_wedge_if_due(&git_dir, Some(&stale), 40 * 60, 18, wall_now);
            });
            warnings += wedged_warnings(&events);
        }
        assert_eq!(
            warnings, 1,
            "a wedge whose budget is stale or unpersisted must still warn once, not every pass"
        );
        // The shared in-memory budget carries the spend the durable record could
        // not, so subsequent passes are floored by the cooldown.
        let carried = WEDGE_REPORT_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&git_dir)
            .map(|budget| budget.reports);
        assert_eq!(carried, Some(1));
    }

    #[test]
    fn every_refusing_pass_still_logs_locally_even_when_sentry_is_silent() {
        // The Sentry gate must never become a diagnostic gate: both intra-pass
        // reaps that now capture NOTHING still write the full refusal line to the
        // machine's own log.
        let _serial = serial();
        reset_index_lock_report_state();
        set_probe_override(Some((false, false)));

        let tmp = TempDir::new().unwrap();
        let log_path = tmp.path().join("hq-sync.log");
        let _log = crate::logfile::LogOverrideGuard::new(log_path.clone());

        seed_repo(tmp.path(), 5);
        let git_dir = git_dir_of(tmp.path());
        let lock = index_lock_path(&git_dir);
        fs::write(&lock, b"partial index data").unwrap();

        let hq = tmp.path().to_str().unwrap();
        let now = future_now();
        let events = sentry::test::with_captured_events(|| {
            assert!(!reap_index_lock_if_stale(
                hq,
                &git_dir,
                STALE_LOCK_MIN_AGE,
                now
            ));
            assert!(!reap_index_lock_if_stale(hq, &git_dir, Duration::ZERO, now));
        });
        set_probe_override(None);

        assert!(events.is_empty(), "the Sentry channel is paced");
        let logged = fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            logged.matches("will not remove it yet").count(),
            2,
            "both refusing passes must log locally even though neither captures"
        );
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
    fn pushes_are_allowed_to_run_for_one_hour() {
        assert_eq!(GIT_PUSH_TIMEOUT, Duration::from_secs(60 * 60));
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

    // ── B7: mirror commits are never gpg-signed ──────────────────────────

    /// Force signing on with a gpg program that always fails — exactly what a
    /// background daemon sees when the user has `commit.gpgsign = true`
    /// globally and gpg cannot reach pinentry without a TTY or GUI session.
    fn force_broken_gpg_signing(dir: &Path) {
        assert!(git(dir, &["config", "commit.gpgsign", "true"])
            .status
            .success());
        assert!(git(dir, &["config", "user.signingkey", "DEADBEEFDEADBEEF"])
            .status
            .success());
        assert!(git(dir, &["config", "gpg.program", "/bin/false"])
            .status
            .success());
    }

    #[test]
    fn commits_even_when_signing_is_forced_on_and_gpg_is_unusable() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let before = rev_count(tmp.path());

        force_broken_gpg_signing(tmp.path());
        fs::write(tmp.path().join("new-file.txt"), "hello").unwrap();

        run_mirror_at(tmp.path()).expect("an unavailable signer must not fail the mirror");

        assert_eq!(
            rev_count(tmp.path()),
            before + 1,
            "the mirror commit must land unsigned rather than be lost to \
             'gpg: signing failed: No pinentry' -> 'fatal: failed to write commit object'"
        );
    }

    // ── B8: push failure classification ──────────────────────────────────

    const GH001_STDERR: &str = "\
remote: error: GH001: Large files detected. You may want to try Git Large File Storage.
remote: error: See https://gh.io/lfs for more information.
remote: error: File workspace/.session-logs/dfd5ecb3.jsonl is 183.58 MB; this exceeds GitHub's file size limit of 100.00 MB
error: failed to push some refs to 'https://github.com/owner/repo.git'";

    #[test]
    fn oversized_blob_rejection_is_permanent_and_names_the_file() {
        match classify_push_failure(GH001_STDERR) {
            PushFailure::Permanent { reason } => assert!(
                reason.contains("workspace/.session-logs/dfd5ecb3.jsonl"),
                "the operator needs the offending path to act on, got: {reason}"
            ),
            other => panic!("a size-limit rejection can never be fixed by retrying, got {other:?}"),
        }
    }

    #[test]
    fn network_failures_stay_transient() {
        for stderr in [
            "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
            "fatal: unable to access 'https://github.com/o/r.git/': Operation timed out",
            "",
        ] {
            assert_eq!(
                classify_push_failure(stderr),
                PushFailure::Transient,
                "weather must keep retrying: {stderr}"
            );
        }
    }

    #[test]
    fn non_fast_forward_stays_transient() {
        let stderr = " ! [rejected]        main -> main (fetch first)\n\
error: failed to push some refs to 'https://github.com/o/r.git'\n\
hint: Updates were rejected because the remote contains work that you do not have.";
        assert_eq!(
            classify_push_failure(stderr),
            PushFailure::Transient,
            "a non-fast-forward clears once the next cycle pulls — never latch on it"
        );
    }

    // ── B9: push backoff record ──────────────────────────────────────────

    fn block_at(when: DateTime<Utc>) -> PersistedPushBlock {
        PersistedPushBlock {
            blocked_at: when.to_rfc3339_opts(SecondsFormat::Secs, true),
            reason: "history contains a file over the remote's size limit".to_string(),
        }
    }

    fn cooldown_secs() -> i64 {
        PUSH_BLOCK_COOLDOWN.as_secs() as i64
    }

    #[test]
    fn no_record_means_the_push_is_attempted() {
        assert!(!push_block_is_active(None, Utc::now()));
    }

    #[test]
    fn a_block_suppresses_pushes_then_expires_so_a_fix_self_heals() {
        let now = Utc::now();

        assert!(push_block_is_active(Some(&block_at(now)), now));
        assert!(push_block_is_active(
            Some(&block_at(
                now - chrono::Duration::seconds(cooldown_secs() - 60)
            )),
            now
        ));
        assert!(
            !push_block_is_active(
                Some(&block_at(
                    now - chrono::Duration::seconds(cooldown_secs() + 60)
                )),
                now
            ),
            "after the cooldown the mirror must re-probe, so a rewritten history \
             recovers without an app restart"
        );
    }

    #[test]
    fn a_future_stamp_re_arms_rather_than_latching() {
        let now = Utc::now();
        assert!(
            !push_block_is_active(Some(&block_at(now + chrono::Duration::hours(5))), now),
            "a backwards clock or a copied .git must never wedge the mirror silently"
        );
    }

    #[test]
    fn block_records_round_trip_and_a_successful_push_clears_them() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let git_dir = git_dir_of(tmp.path());
        let now = Utc::now();

        assert!(read_push_block(&git_dir).is_none());
        write_push_block(&git_dir, &block_at(now));
        assert!(push_block_is_active(
            read_push_block(&git_dir).as_ref(),
            now
        ));

        clear_push_block(&git_dir);
        assert!(
            read_push_block(&git_dir).is_none(),
            "a push that succeeds must clear the block"
        );
    }

    #[test]
    fn the_block_record_lives_in_the_git_dir_and_is_never_staged() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README"), "seed").unwrap();
        assert!(git(tmp.path(), &["add", "-A"]).status.success());
        assert!(git(tmp.path(), &["commit", "-q", "-m", "seed"])
            .status
            .success());
        let git_dir = git_dir_of(tmp.path());

        write_push_block(&git_dir, &block_at(Utc::now()));

        let status = git(
            tmp.path(),
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "the record must be invisible to `git add -A`, or the mirror would \
             commit its own bookkeeping"
        );
    }

    #[test]
    fn a_corrupt_block_record_never_wedges_the_mirror() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let git_dir = git_dir_of(tmp.path());
        fs::write(push_block_path(&git_dir), "{ not json").unwrap();

        assert!(read_push_block(&git_dir).is_none());
        assert!(!push_block_is_active(
            read_push_block(&git_dir).as_ref(),
            Utc::now()
        ));
    }
}
