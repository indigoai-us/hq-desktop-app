//! Settings › Storage: how much disk HQ backups use, and pruning old ones.
//!
//! Shells out to `hq storage status --json`, `hq storage prune ... --json` and
//! `hq storage offload ... --json` (Big files: move big idle files and old
//! copies of big files to HQ cloud storage, leaving `.hqcloud` placeholders).
//! The CLI owns the git and S3 work; this module only builds argv, runs the
//! command off the main thread, and parses the JSON into typed structs.
//!
//! Status, big files and the offload preview are slow scans (`hq-storage.sh
//! report` and `large` under the CLI; minutes on a big HQ). Newer CLIs leave
//! the big-file scan out of `status` (`big_files_included: false`) and run it
//! as `hq storage big-files --json`, so the summary shows without waiting on
//! it. An older CLI has no `big-files` (it answers "unknown command", mapped to
//! `update-hq`) and puts big files in `status` as before. Each scan goes
//! through a single flight: a second request joins the running one instead of
//! starting another, the scan runs on its own task so leaving the screen does
//! not cancel or duplicate it, and a timeout stops the whole process group
//! (hq and the scripts it started), not only `hq`. The last good status is
//! kept in memory and in `~/.hq/desktop/storage-status.json` so the screen can
//! show it at once while a fresh scan runs. Status stays read-only: it never
//! runs reclaim, gc or prune.
//!
//! A missing `hq` binary or a CLI that predates the `storage` command maps to
//! the `update-hq` error code so the UI can say "Update HQ to manage storage"
//! instead of showing raw CLI output.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::commands::feedback::resolve_hq_folder;
use crate::util::logfile::log;
use crate::util::paths;

/// Error code the UI maps to "Update HQ to manage storage".
pub const UPDATE_HQ_ERROR: &str = "update-hq";

/// Error code the UI maps to a plain "took too long, try again" message when
/// `hq storage` does not finish in time.
pub const TIMEOUT_ERROR: &str = "storage-timeout";
/// `hq storage` refused because the `hq-storage` flag is off for this person
/// (CLI JSON `{"code":"feature_disabled"}`). Allowlist gate, owner hold
/// 2026-10-11: the UI hides Settings > Storage on this code.
pub const FEATURE_DISABLED_ERROR: &str = "storage-feature-disabled";

/// True when stdout is the CLI's structured `feature_disabled` refusal.
pub fn is_feature_disabled(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(|c| c == "feature_disabled"))
        .unwrap_or(false)
}

/// `hq storage status`. A cold status lists every cloud file version of each
/// company (about 2 minutes for 2.4M versions; the CLI then keeps the figures
/// for 15 minutes), so the cap leaves room for that while still ending a
/// stuck CLI.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Dry runs never use cached figures (a prune preview lists every cloud version
/// live and adds the local estimate), so they get a longer cap than status.
const READ_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Real prune, offload and fetch move data and can take a while, but still
/// get a ceiling.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How long `run_hq` waits for the given `hq` argv before giving up.
pub fn timeout_for(args: &[OsString]) -> Duration {
    if args.get(1).is_some_and(|a| a == "status" || a == "big-files") {
        return STATUS_TIMEOUT;
    }
    if args.iter().any(|a| a == "--dry-run") {
        READ_TIMEOUT
    } else {
        WRITE_TIMEOUT
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalTranche {
    pub id: String,
    pub label: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub commit_count: u64,
    pub est_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalStorage {
    pub available: bool,
    pub reason: Option<String>,
    pub root: Option<String>,
    pub git_dir_bytes: u64,
    pub working_tree_bytes: u64,
    pub commit_count: u64,
    pub oldest_commit_at: Option<String>,
    pub newest_commit_at: Option<String>,
    pub tranches: Vec<LocalTranche>,
    /// Refs (tool bookmarks such as refs/cmux/last-turn/*) that prune clears.
    pub extra_refs: u64,
    /// Branches, tags or a stash that still reach old history, so pruning
    /// it frees nothing until they move.
    pub holding_refs: Vec<HoldingRef>,
    pub holding_refs_count: Option<u64>,
    /// Bytes an undo backup still holds, freed at `reclaim_after`.
    pub pending_reclaim_bytes: Option<u64>,
    pub reclaim_after: Option<String>,
}

/// A branch, tag or stash that keeps old history alive.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct HoldingRef {
    pub name: String,
    pub commit_date: Option<String>,
}

/// Top-level `reclaim`: the CLI dropped expired undo backups first.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Reclaim {
    pub available: bool,
    pub dropped: Option<u64>,
    pub freed_bytes: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudTranche {
    pub id: String,
    pub label: String,
    pub count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudStorage {
    pub company: String,
    pub available: bool,
    pub error: Option<String>,
    pub current_bytes: u64,
    pub noncurrent_bytes: u64,
    pub noncurrent_count: u64,
    pub delete_markers: u64,
    pub tranches: Vec<CloudTranche>,
    /// Whether this person may delete old versions (owners and admins).
    /// `None` on CLIs that predate it; the UI then treats it as "no".
    pub can_delete: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CountBytes {
    pub count: u64,
    pub bytes: u64,
}

/// `status --json` → `offload`: big files that could move to HQ cloud, and
/// placeholders already there. Absent on CLIs that predate offload.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OffloadStatus {
    /// Old copies of big files in local backup history.
    pub history_candidates: CountBytes,
    /// Big files in the HQ folder not opened or changed for a while.
    pub current_candidates: CountBytes,
    /// `.hqcloud` placeholders on this computer.
    pub placeholders: CountBytes,
    /// `false` when big-file moves can't run at all (old HQ, old HQ sync).
    pub available: Option<bool>,
    pub reason: Option<String>,
    /// `true` only once the CLI can move current files. Absent means it
    /// can't, so `current_candidates` is not offered.
    pub current_available: Option<bool>,
    /// Why current files can't move yet; the UI never shows it raw.
    pub current_reason: Option<String>,
    /// Old big files a linked worktree still uses, so they can't be freed.
    pub history_held: Option<HistoryHeld>,
}

/// `offload.history_held`: count, bytes and the worktree paths holding them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct HistoryHeld {
    pub count: u64,
    pub bytes: u64,
    pub worktrees: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StorageStatus {
    pub local: LocalStorage,
    pub cloud: Vec<CloudStorage>,
    pub offload: Option<OffloadStatus>,
    /// Cloud history could not be read at all (e.g. signed out).
    pub cloud_error: Option<String>,
    pub generated_at: Option<String>,
    pub reclaim: Option<Reclaim>,
    /// `Some(false)`: this CLI left the big-file scan out of status; get it
    /// from `hq storage big-files`. `None` on older CLIs, whose status always
    /// carries `offload` (or predates it).
    pub big_files_included: Option<bool>,
}

/// `hq storage big-files --json`: the big-file scan on its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StorageBigFiles {
    pub offload: Option<OffloadStatus>,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OffloadHistory {
    pub uploaded: u64,
    pub bytes: u64,
    pub freed_bytes: u64,
    /// Blobs that would move (dry run) or were eligible (real run).
    pub candidates: Option<u64>,
    pub candidate_bytes: Option<u64>,
    /// `Some(false)` with a `reason` when this half could not run.
    pub available: Option<bool>,
    pub reason: Option<String>,
    /// Undo backup the rewrite kept (normally none: offload frees at once).
    pub backup_ref: Option<String>,
    /// When `pending_reclaim_bytes` are freed (dry run: an estimate).
    pub reclaim_after: Option<String>,
    pub pending_reclaim_bytes: Option<u64>,
    /// Old versions a linked worktree still uses: left in place, not freed.
    pub held_by_worktrees: Option<CountBytes>,
    /// Worktree paths that still use old history.
    pub worktree_holders: Option<Vec<String>>,
    /// Set when the run stopped before changing anything (nothing_to_free).
    pub refused: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OffloadedFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OffloadCurrent {
    pub offloaded: Vec<OffloadedFile>,
    pub freed_bytes: u64,
    /// `Some(false)` with a `reason` while current-file moves are blocked.
    pub available: Option<bool>,
    pub reason: Option<String>,
}

/// `hq storage offload --json` (with `--dry-run`: what would move).
/// `errors` items are passed through untyped; the UI only counts them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OffloadResult {
    pub history: OffloadHistory,
    pub current: OffloadCurrent,
    pub errors: Vec<serde_json::Value>,
    pub dry_run: bool,
    pub reclaim: Option<Reclaim>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GitDirSize {
    pub git_dir_bytes: u64,
}

/// `core/scripts/hq-storage.sh prune --json`, passed through by the CLI with
/// `available` added. A dry run reports `would_remove_commits` / `est_bytes`;
/// a real run reports `removed_commits` and the git dir size before and after.
/// `retained_refs` counts refs other than the current branch (tags, stash,
/// tool markers) that can keep old history from being freed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalPruneResult {
    pub available: bool,
    pub reason: Option<String>,
    pub would_remove_commits: u64,
    pub est_bytes: u64,
    pub removed_commits: u64,
    pub total_commits_before: u64,
    pub flattened_merges: u64,
    pub retained_refs: u64,
    /// Dry run: extra refs prune would delete.
    pub refs_to_remove: u64,
    /// Real run: extra refs prune deleted.
    pub refs_removed: u64,
    pub refs_to_remove_sample: Vec<String>,
    pub before: Option<GitDirSize>,
    pub after: Option<GitDirSize>,
    /// `nothing_to_free` when branches, tags or a stash still reach the old
    /// history; nothing was changed.
    pub refused: Option<String>,
    pub holding_refs: Vec<HoldingRef>,
    pub holding_refs_count: Option<u64>,
    /// Real run: bytes freed right away.
    pub freed_bytes: Option<u64>,
    /// The 24 h undo backup, and when the bytes it holds are freed.
    pub backup_ref: Option<String>,
    pub reclaim_after: Option<String>,
    pub pending_reclaim_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudPruneResult {
    pub company: String,
    pub deleted_count: u64,
    pub deleted_bytes: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PruneResult {
    pub local: Option<LocalPruneResult>,
    pub cloud: Vec<CloudPruneResult>,
    pub dry_run: bool,
    pub reclaim: Option<Reclaim>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PruneRequest {
    /// `YYYY-MM-DD`; local snapshots older than this go.
    pub local_before: Option<String>,
    /// `YYYY-MM-DD`; old cloud file versions older than this go.
    pub cloud_before: Option<String>,
    /// Limit cloud pruning to one company.
    pub company: Option<String>,
}

fn is_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub fn status_args() -> Vec<OsString> {
    ["storage", "status", "--json"]
        .iter()
        .map(OsString::from)
        .collect()
}

/// `hq storage big-files --json`: read-only, like status.
pub fn big_files_args() -> Vec<OsString> {
    ["storage", "big-files", "--json"]
        .iter()
        .map(OsString::from)
        .collect()
}

pub fn parse_big_files(stdout: &str) -> Result<StorageBigFiles, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage big-files: {e}"))
}

pub fn prune_args(req: &PruneRequest, dry_run: bool) -> Result<Vec<OsString>, String> {
    if req.local_before.is_none() && req.cloud_before.is_none() {
        return Err("nothing-selected".to_string());
    }
    let mut args: Vec<OsString> = vec!["storage".into(), "prune".into()];
    for (flag, value) in [
        ("--local-before", &req.local_before),
        ("--cloud-before", &req.cloud_before),
    ] {
        if let Some(date) = value {
            if !is_iso_date(date) {
                return Err(format!("invalid-date: {date}"));
            }
            args.push(flag.into());
            args.push(date.into());
        }
    }
    if let Some(company) = &req.company {
        args.push("--company".into());
        args.push(company.into());
    }
    args.push(if dry_run { "--dry-run" } else { "--yes" }.into());
    args.push("--json".into());
    Ok(args)
}

/// `hq storage offload` with the CLI defaults (50 MB, 14 idle days, history
/// and current files).
pub fn offload_args(dry_run: bool) -> Vec<OsString> {
    [
        "storage",
        "offload",
        if dry_run { "--dry-run" } else { "--yes" },
        "--json",
    ]
    .iter()
    .map(OsString::from)
    .collect()
}

pub fn parse_offload(stdout: &str) -> Result<OffloadResult, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage offload: {e}"))
}

/// True when stderr says the CLI does not know the `storage` command.
fn is_old_cli(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("unknown command")
        || s.contains("unknown subcommand")
        || s.contains("unknown option '--dry-run'")
}

pub fn parse_status(stdout: &str) -> Result<StorageStatus, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage status: {e}"))
}

pub fn parse_prune(stdout: &str) -> Result<PruneResult, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage prune: {e}"))
}

/// Await `fut` for at most `limit`; on expiry log it and return the
/// `storage-timeout` code instead of raw text.
async fn run_with_timeout<F: std::future::Future>(
    fut: F,
    limit: Duration,
) -> Result<F::Output, String> {
    tokio::time::timeout(limit, fut).await.map_err(|_| {
        log(
            "storage",
            &format!("hq storage timed out after {}s", limit.as_secs()),
        );
        TIMEOUT_ERROR.to_string()
    })
}

pub(crate) async fn run_hq(args: Vec<OsString>) -> Result<String, String> {
    let hq = paths::resolve_bin("hq");
    let folder = resolve_hq_folder();
    let limit = timeout_for(&args);
    let mut cmd = paths::tokio_spawn_command(&hq, &[]);
    cmd.args(&args)
        .env("PATH", paths::child_path())
        .current_dir(&folder)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Last resort if this future is dropped mid-run.
        .kill_on_drop(true);
    // hq leads its own process group so a timeout can stop the
    // `hq-storage.sh report|large` scripts it started too; killing only hq
    // left them running and piling up.
    #[cfg(unix)]
    cmd.process_group(0);
    let output = run_child(cmd, limit).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    // Checked before any parse, whatever the exit status: a refusal must
    // never be read as an empty status or a partial prune.
    if is_feature_disabled(&stdout) {
        log("storage", "hq storage refused: feature_disabled");
        return Err(FEATURE_DISABLED_ERROR.to_string());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log(
            "storage",
            &format!(
                "hq storage exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr.trim()
            ),
        );
        if is_old_cli(&stderr) {
            return Err(UPDATE_HQ_ERROR.to_string());
        }
        // Prune can exit non-zero on partial failure but still report per-company
        // errors as JSON; let the caller parse it when stdout has JSON.
        if stdout.trim_start().starts_with('{') {
            return Ok(stdout);
        }
        return Err(format!("hq storage failed: {}", stderr.trim()));
    }
    Ok(stdout)
}

/// Spawn `cmd` (already set to lead its own process group on Unix), collect
/// its output, and on timeout stop the whole group so no scan outlives it.
async fn run_child(
    mut cmd: tokio::process::Command,
    limit: Duration,
) -> Result<std::process::Output, String> {
    let mut child = cmd.spawn().map_err(|e| {
        log("storage", &format!("spawn hq failed: {e}"));
        UPDATE_HQ_ERROR.to_string()
    })?;
    let pgid = child.id().map(|p| p as i32);
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let read_out = async move {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut buf).await;
        }
        buf
    };
    let read_err = async move {
        let mut buf = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut buf).await;
        }
        buf
    };
    let run = async {
        let (stdout, stderr, status) = tokio::join!(read_out, read_err, child.wait());
        (stdout, stderr, status)
    };
    let finished = run_with_timeout(run, limit).await;
    match finished {
        Ok((stdout, stderr, status)) => {
            let status = status.map_err(|e| {
                log("storage", &format!("wait hq failed: {e}"));
                UPDATE_HQ_ERROR.to_string()
            })?;
            Ok(std::process::Output { status, stdout, stderr })
        }
        Err(code) => {
            // hq and every script in its group, so no scan outlives the cap.
            crate::commands::import_scan::stop_child(&mut child, pgid).await;
            Err(code)
        }
    }
}

// ── Single flight and last-known status ─────────────────────────────────────

type Flight<T> = Shared<BoxFuture<'static, Result<T, String>>>;

struct Running<T> {
    id: u64,
    started: Instant,
    flight: Flight<T>,
}

/// At most one run of a scan at a time. A request joins the running scan
/// unless that scan started before `not_before` (e.g. before a prune finished),
/// in which case the new run waits for the old one and then starts, so two
/// never overlap. The work runs on its own task: callers going away (the
/// Storage screen closing) neither cancels it nor lets a re-open start another.
pub struct SingleFlight<T: Clone + Send + Sync + 'static> {
    slot: Mutex<Option<Running<T>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// True while a run is in progress.
    #[cfg(test)]
    pub fn in_flight(&self) -> bool {
        self.slot.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    pub fn run<F, Fut>(
        &'static self,
        not_before: Option<Instant>,
        make: F,
    ) -> Flight<T>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        let mut slot = self.slot.lock().unwrap_or_else(|p| p.into_inner());
        let previous = match slot.as_ref() {
            Some(r) if not_before.is_none_or(|t| r.started >= t) => return r.flight.clone(),
            Some(r) => Some(r.flight.clone()),
            None => None,
        };
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let task = tokio::spawn(async move {
            if let Some(prev) = previous {
                let _ = prev.await;
            }
            let result = make().await;
            let mut slot = self.slot.lock().unwrap_or_else(|p| p.into_inner());
            if slot.as_ref().is_some_and(|r| r.id == id) {
                *slot = None;
            }
            result
        });
        let flight: Flight<T> = async move {
            task.await
                .unwrap_or_else(|e| Err(format!("storage scan task failed: {e}")))
        }
        .boxed()
        .shared();
        *slot = Some(Running {
            id,
            started: Instant::now(),
            flight: flight.clone(),
        });
        flight
    }
}

static STATUS_FLIGHT: SingleFlight<StorageStatus> = SingleFlight::new();
static BIG_FILES_FLIGHT: SingleFlight<StorageBigFiles> = SingleFlight::new();
static OFFLOAD_PREVIEW_FLIGHT: SingleFlight<OffloadResult> = SingleFlight::new();
/// When the last prune or offload finished; scans started before it are stale.
static LAST_WRITE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_STATUS: Mutex<Option<CachedStatus>> = Mutex::new(None);
/// Last good big-file result per HQ root, for a status that lands after it.
static LAST_BIG_FILES: Mutex<Option<(String, OffloadStatus)>> = Mutex::new(None);
/// Status and big files both rewrite the cache file; one at a time.
static CACHE_WRITE: Mutex<()> = Mutex::new(());

fn last_write() -> Option<Instant> {
    *LAST_WRITE.lock().unwrap_or_else(|p| p.into_inner())
}

fn note_write() {
    *LAST_WRITE.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
}

/// The last good `hq storage status`, with when it was read and for which HQ.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CachedStatus {
    pub status: StorageStatus,
    /// RFC 3339 time the scan finished.
    pub fetched_at: String,
    pub hq_root: String,
}

fn cache_file() -> PathBuf {
    hq_desktop_core::journal::state_dir()
        .join("desktop")
        .join("storage-status.json")
}

/// The cached status for `root`, from memory or else `file`.
pub fn read_cached(file: &Path, root: &str) -> Option<CachedStatus> {
    let mem = LAST_STATUS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let cached = mem.or_else(|| {
        let text = std::fs::read_to_string(file).ok()?;
        serde_json::from_str::<CachedStatus>(&text).ok()
    })?;
    (cached.hq_root == root).then_some(cached)
}

pub fn write_cached(file: &Path, cached: CachedStatus) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string(&cached) {
        Ok(text) => {
            let tmp = file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, file);
            }
        }
        Err(e) => log("storage", &format!("cache status: {e}")),
    }
    *LAST_STATUS.lock().unwrap_or_else(|p| p.into_inner()) = Some(cached);
}

/// Fail closed: once the flag says no, nothing cached stays to be shown.
pub fn clear_cached(file: &Path) {
    *LAST_STATUS.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *LAST_BIG_FILES.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let _ = std::fs::remove_file(file);
}

/// Cache a fresh status. A status without big files (newer CLI) keeps the
/// big files already known for this HQ, so the next open shows them at once.
fn cache_status(file: &Path, root: String, status: &StorageStatus) {
    let _w = CACHE_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    let mut status = status.clone();
    if status.offload.is_none() && status.big_files_included == Some(false) {
        let from_big_files = LAST_BIG_FILES
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .filter(|(r, _)| *r == root)
            .map(|(_, o)| o);
        status.offload =
            from_big_files.or_else(|| read_cached(file, &root).and_then(|c| c.status.offload));
    }
    write_cached(
        file,
        CachedStatus {
            status,
            fetched_at: chrono::Utc::now().to_rfc3339(),
            hq_root: root,
        },
    );
}

/// Put fresh big files into the cached status (when there is one yet).
fn cache_big_files(file: &Path, root: String, offload: OffloadStatus) {
    let _w = CACHE_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    *LAST_BIG_FILES.lock().unwrap_or_else(|p| p.into_inner()) =
        Some((root.clone(), offload.clone()));
    if let Some(mut cached) = read_cached(file, &root) {
        cached.status.offload = Some(offload);
        write_cached(file, cached);
    }
}

/// Status through the single flight, storing a good result in the cache (on
/// the scan's own task, so it lands even when the screen has closed).
pub(crate) fn status_flight<F, Fut>(file: PathBuf, root: String, fetch: F) -> Flight<StorageStatus>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<StorageStatus, String>> + Send + 'static,
{
    STATUS_FLIGHT.run(last_write(), move || async move {
        let res = fetch().await;
        match &res {
            Ok(status) => cache_status(&file, root, status),
            Err(e) if e == FEATURE_DISABLED_ERROR => clear_cached(&file),
            Err(_) => {}
        }
        res
    })
}

/// Big files through their own single flight (independent of status, so the
/// summary never waits on them), storing a good result in the cache.
pub(crate) fn big_files_flight<F, Fut>(
    file: PathBuf,
    root: String,
    fetch: F,
) -> Flight<StorageBigFiles>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<StorageBigFiles, String>> + Send + 'static,
{
    BIG_FILES_FLIGHT.run(last_write(), move || async move {
        let res = fetch().await;
        match &res {
            Ok(StorageBigFiles {
                offload: Some(o), ..
            }) => cache_big_files(&file, root, o.clone()),
            Err(e) if e == FEATURE_DISABLED_ERROR => clear_cached(&file),
            _ => {}
        }
        res
    })
}

/// Last known status for this HQ, or null. Never runs a scan.
#[tauri::command]
pub async fn get_cached_storage_status() -> Result<Option<CachedStatus>, String> {
    let root = resolve_hq_folder().to_string_lossy().into_owned();
    Ok(read_cached(&cache_file(), &root))
}

/// `hq storage status --json`.
#[tauri::command]
pub async fn get_storage_status() -> Result<StorageStatus, String> {
    let root = resolve_hq_folder().to_string_lossy().into_owned();
    status_flight(cache_file(), root, || async {
        let stdout = run_hq(status_args()).await?;
        parse_status(&stdout)
    })
    .await
}

/// `hq storage big-files --json`. An older CLI without it fails with
/// `update-hq`; its `status` already carries big files.
#[tauri::command]
pub async fn get_storage_big_files() -> Result<StorageBigFiles, String> {
    let root = resolve_hq_folder().to_string_lossy().into_owned();
    big_files_flight(cache_file(), root, || async {
        let stdout = run_hq(big_files_args()).await?;
        parse_big_files(&stdout)
    })
    .await
}

/// `hq storage prune ... --dry-run --json`: what would be deleted.
#[tauri::command]
pub async fn preview_storage_prune(request: PruneRequest) -> Result<PruneResult, String> {
    let stdout = run_hq(prune_args(&request, true)?).await?;
    parse_prune(&stdout)
}

/// `hq storage prune ... --yes --json`: deletes for real.
#[tauri::command]
pub async fn run_storage_prune(request: PruneRequest) -> Result<PruneResult, String> {
    log("storage", &format!("prune requested: {request:?}"));
    let res = run_hq(prune_args(&request, false)?).await;
    note_write();
    parse_prune(&res?)
}

/// `hq storage offload --dry-run --json`: what "Move to cloud" would move.
#[tauri::command]
pub async fn preview_storage_offload() -> Result<OffloadResult, String> {
    OFFLOAD_PREVIEW_FLIGHT
        .run(last_write(), || async {
            let stdout = run_hq(offload_args(true)).await?;
            parse_offload(&stdout)
        })
        .await
}

/// `hq storage offload --yes --json`: uploads, verifies, then frees space.
#[tauri::command]
pub async fn run_storage_offload() -> Result<OffloadResult, String> {
    log("storage", "offload requested");
    let res = run_hq(offload_args(false)).await;
    note_write();
    parse_offload(&res?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    const STATUS: &str = r#"{
      "local": {"available": true, "root": "/p", "git_dir_bytes": 81927340032,
        "working_tree_bytes": 1200, "commit_count": 4200,
        "oldest_commit_at": "2025-01-01T00:00:00Z", "newest_commit_at": "2026-10-09T00:00:00Z",
        "tranches": [
          {"id": "7d", "label": "Last 7 days", "from": "2026-10-02T00:00:00Z", "to": "2026-10-09T00:00:00Z", "commit_count": 40, "est_bytes": 1000},
          {"id": "older", "label": "Older than a year", "from": "2025-01-01T00:00:00Z", "to": "2025-10-09T00:00:00Z", "commit_count": 3000, "est_bytes": 50000}
        ]},
      "cloud": [
        {"company": "indigo", "available": true, "current_bytes": 10, "noncurrent_bytes": 20,
         "noncurrent_count": 3, "delete_markers": 2,
         "tranches": [{"id": "7d", "label": "Last 7 days", "count": 1, "bytes": 5}]},
        {"company": "acme", "available": false, "error": "access denied"}
      ],
      "generated_at": "2026-10-09T12:00:00Z"
    }"#;

    #[test]
    fn parses_full_status() {
        let s = parse_status(STATUS).unwrap();
        assert!(s.local.available);
        assert_eq!(s.local.git_dir_bytes, 81_927_340_032);
        assert_eq!(s.local.tranches.len(), 2);
        assert_eq!(s.local.tranches[1].id, "older");
        assert_eq!(s.local.tranches[1].commit_count, 3000);
        assert_eq!(s.local.extra_refs, 0);
        assert_eq!(s.cloud.len(), 2);
        assert_eq!(s.cloud[0].delete_markers, 2);
        assert_eq!(s.cloud[0].tranches[0].bytes, 5);
        assert!(!s.cloud[1].available);
        assert_eq!(s.cloud[1].error.as_deref(), Some("access denied"));
        assert!(s.cloud[1].tranches.is_empty());
    }

    #[test]
    fn parses_unavailable_local() {
        let s = parse_status(
            r#"{"local":{"available":false,"reason":"HQ is too old"},"cloud":[],"generated_at":"x"}"#,
        )
        .unwrap();
        assert!(!s.local.available);
        assert_eq!(s.local.reason.as_deref(), Some("HQ is too old"));
        assert!(s.local.tranches.is_empty());
    }

    #[test]
    fn rejects_non_json_status() {
        assert!(parse_status("Usage: hq storage").is_err());
    }

    // Shapes copied from hq-cli `storage prune --json` (src/commands/storage.ts)
    // and hq-core `core/scripts/hq-storage.sh prune --json`.
    #[test]
    fn parses_dry_run_prune() {
        let r = parse_prune(
            r#"{"local":{"available":true,"would_remove_commits":3990,"est_bytes":52000000000,
                 "flattened_merges":2,"retained_refs":5,"refs_to_remove":3,
                 "refs_to_remove_sample":["refs/cmux/last-turn/a"]},
                "cloud":[{"company":"indigo","deleted_count":12,"deleted_bytes":4096,"errors":[]}],
                "dry_run":true}"#,
        )
        .unwrap();
        assert!(r.dry_run);
        let local = r.local.unwrap();
        assert!(local.available);
        assert_eq!(local.would_remove_commits, 3990);
        assert_eq!(local.est_bytes, 52_000_000_000);
        assert_eq!(local.retained_refs, 5);
        assert_eq!(local.refs_to_remove, 3);
        assert!(local.before.is_none());
        assert_eq!(r.cloud[0].deleted_bytes, 4096);
        assert!(r.cloud[0].errors.is_empty());
    }

    #[test]
    fn parses_real_prune_with_errors() {
        let r = parse_prune(
            r#"{"local":{"available":true,"removed_commits":3990,"total_commits_before":4200,
                 "flattened_merges":2,"retained_refs":5,"refs_removed":3,
                 "before":{"git_dir_bytes":81927340032},"after":{"git_dir_bytes":30000000000}},
                "cloud":[{"company":"indigo","deleted_count":2,"deleted_bytes":7,"errors":[]},
                         {"company":"acme","deleted_count":0,"deleted_bytes":0,
                          "errors":["Access denied deleting old versions."]}],
                "dry_run":false}"#,
        )
        .unwrap();
        let local = r.local.unwrap();
        assert_eq!(local.removed_commits, 3990);
        assert_eq!(local.refs_removed, 3);
        assert_eq!(local.before.unwrap().git_dir_bytes, 81_927_340_032);
        assert_eq!(local.after.unwrap().git_dir_bytes, 30_000_000_000);
        assert_eq!(r.cloud[0].deleted_count, 2);
        assert_eq!(r.cloud[1].errors.len(), 1);
    }

    #[test]
    fn parses_cloud_only_prune_and_unavailable_local() {
        let r = parse_prune(r#"{"local":null,"cloud":[],"dry_run":true}"#).unwrap();
        assert!(r.local.is_none());
        let r = parse_prune(
            r#"{"local":{"available":false,"reason":"update HQ"},"cloud":[],"dry_run":true}"#,
        )
        .unwrap();
        let local = r.local.unwrap();
        assert!(!local.available);
        assert_eq!(local.reason.as_deref(), Some("update HQ"));
    }

    #[test]
    fn detects_the_cli_feature_disabled_refusal() {
        let refusal = r#"{"ok":false,"code":"feature_disabled","message":"Storage tools aren't available on your account yet."}"#;
        assert!(is_feature_disabled(refusal));
        assert!(is_feature_disabled(&format!("  {refusal}\n")));
        assert!(!is_feature_disabled(STATUS));
        assert!(!is_feature_disabled(r#"{"code":"other"}"#));
        assert!(!is_feature_disabled("Storage tools aren't available on your account yet."));
        assert!(!is_feature_disabled(""));
        assert_eq!(FEATURE_DISABLED_ERROR, "storage-feature-disabled");
    }

    #[test]
    fn status_args_shape() {
        assert_eq!(rendered(&status_args()), ["storage", "status", "--json"]);
    }

    #[test]
    fn prune_args_preview_and_run() {
        let req = PruneRequest {
            local_before: Some("2026-09-01".into()),
            cloud_before: Some("2026-07-01".into()),
            company: Some("indigo".into()),
        };
        assert_eq!(
            rendered(&prune_args(&req, true).unwrap()),
            [
                "storage",
                "prune",
                "--local-before",
                "2026-09-01",
                "--cloud-before",
                "2026-07-01",
                "--company",
                "indigo",
                "--dry-run",
                "--json"
            ]
        );
        let run = rendered(&prune_args(&req, false).unwrap());
        assert!(run.contains(&"--yes".to_string()));
        assert!(!run.contains(&"--dry-run".to_string()));
    }

    #[test]
    fn prune_args_requires_a_cutoff_and_valid_dates() {
        assert!(prune_args(&PruneRequest::default(), true).is_err());
        let bad = PruneRequest {
            local_before: Some("2026-9-1; rm".into()),
            ..Default::default()
        };
        assert!(prune_args(&bad, true).is_err());
        let local_only = PruneRequest {
            local_before: Some("2026-09-01".into()),
            ..Default::default()
        };
        let args = rendered(&prune_args(&local_only, false).unwrap());
        assert!(!args.contains(&"--cloud-before".to_string()));
    }

    #[test]
    fn parses_offload_status_and_its_absence() {
        let s = parse_status(
            r#"{"local":{"available":true},"cloud":[],
                "offload":{"history_candidates":{"count":660,"bytes":55900000000},
                           "current_candidates":{"count":3,"bytes":900000000},
                           "placeholders":{"count":2,"bytes":1048576000}}}"#,
        )
        .unwrap();
        let o = s.offload.unwrap();
        assert_eq!(o.history_candidates.count, 660);
        assert_eq!(o.history_candidates.bytes, 55_900_000_000);
        assert_eq!(o.current_candidates.bytes, 900_000_000);
        assert_eq!(o.placeholders.count, 2);
        assert!(parse_status(STATUS).unwrap().offload.is_none());
    }

    // Real `hq storage ... --json` output captured from hq-cli feat/hq-storage
    // against a fixture HQ (packages/ui/src/settings/__fixtures__/storage).
    const FIXTURES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/ui/src/settings/__fixtures__/storage/"
    );

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}{name}")).unwrap()
    }

    /// Every key the CLI sent must come back out of the typed struct, so a
    /// field serde would drop fails here instead of in the UI.
    fn assert_passthrough<T: serde::de::DeserializeOwned + Serialize>(raw: &str) {
        let wire: serde_json::Value = serde_json::from_str(raw).unwrap();
        let typed: T = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_value(typed).unwrap();
        assert_subset(&wire, &back, "$");
    }

    fn assert_subset(wire: &serde_json::Value, back: &serde_json::Value, at: &str) {
        match (wire, back) {
            (serde_json::Value::Object(w), serde_json::Value::Object(b)) => {
                for (k, v) in w {
                    let path = format!("{at}.{k}");
                    let got = b
                        .get(k)
                        .unwrap_or_else(|| panic!("{path} dropped by serde"));
                    assert_subset(v, got, &path);
                }
            }
            (serde_json::Value::Array(w), serde_json::Value::Array(b)) => {
                assert_eq!(w.len(), b.len(), "{at} length");
                for (i, (wv, bv)) in w.iter().zip(b).enumerate() {
                    assert_subset(wv, bv, &format!("{at}[{i}]"));
                }
            }
            _ => assert_eq!(wire, back, "{at}"),
        }
    }

    #[test]
    fn wire_contract_round_trips_captured_cli_json() {
        assert_passthrough::<StorageStatus>(&fixture("status.json"));
        assert_passthrough::<StorageStatus>(&fixture("status-after-offload.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-dry.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-real.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-dry.json"));
        // Round-2 e2e captures (backup and holder fields).
        assert_passthrough::<StorageStatus>(&fixture("status-holders.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-dry-holders.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-dry-clean.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-real-clean-backup.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-real-holders-r2.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-real-backup.json"));
        // Round-3 contract shapes (reclaim, refusal, pending bytes).
        assert_passthrough::<StorageStatus>(&fixture("status-r3.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-dry-r3.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-real-r3.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-refused-r3.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-dry-r3.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-real-r3.json"));
        // Round-4 shapes: old versions other worktrees still use.
        assert_passthrough::<StorageStatus>(&fixture("status-held-r4.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-dry-held-r4.json"));
        assert_passthrough::<OffloadResult>(&fixture("offload-refused-r4.json"));
        assert_passthrough::<PruneResult>(&fixture("prune-refused-worktree-r4.json"));
        // Round-5 shapes: status without big files, and big files on their own.
        assert_passthrough::<StorageStatus>(&fixture("status-fast-r5.json"));
        assert_passthrough::<StorageStatus>(&fixture("status-big-files-r5.json"));
        assert_passthrough::<StorageBigFiles>(&fixture("big-files-r5.json"));
    }

    #[test]
    fn parses_fast_status_and_big_files() {
        let fast = parse_status(&fixture("status-fast-r5.json")).unwrap();
        assert_eq!(fast.big_files_included, Some(false));
        assert!(fast.offload.is_none());
        assert!(fast.local.available);
        let full = parse_status(&fixture("status-big-files-r5.json")).unwrap();
        assert_eq!(full.big_files_included, Some(true));
        let big = parse_big_files(&fixture("big-files-r5.json")).unwrap();
        assert_eq!(big.offload, full.offload);
        assert_eq!(big.offload.unwrap().history_candidates.count, 4);
        // An older CLI's status: no marker, big files inline.
        let old = parse_status(&fixture("status-held-r4.json")).unwrap();
        assert_eq!(old.big_files_included, None);
        assert!(old.offload.is_some());
        assert!(parse_big_files("error: unknown command 'big-files'").is_err());
    }

    #[test]
    fn big_files_args_shape_and_read_only() {
        let args = rendered(&big_files_args());
        assert_eq!(args, ["storage", "big-files", "--json"]);
        for word in ["reclaim", "gc", "prune", "drop-backups", "offload", "--yes"] {
            assert!(!args.iter().any(|a| a.contains(word)), "big files must not run {word}");
        }
        assert_eq!(timeout_for(&big_files_args()), STATUS_TIMEOUT);
    }

    #[test]
    fn parses_worktree_held_history_and_offload_refusal() {
        let s = parse_status(&fixture("status-held-r4.json")).unwrap();
        let held = s.offload.unwrap().history_held.unwrap();
        assert_eq!(held.count, 2);
        assert_eq!(held.worktrees, vec![".claude/worktrees/old-ui".to_string()]);
        let r = parse_offload(&fixture("offload-refused-r4.json")).unwrap();
        assert_eq!(r.history.refused.as_deref(), Some("nothing_to_free"));
        assert!(r.history.message.unwrap().contains("Nothing was uploaded"));
        assert_eq!(r.history.held_by_worktrees.unwrap().count, 2);
        let d = parse_offload(&fixture("offload-dry-held-r4.json")).unwrap();
        assert_eq!(
            d.history.worktree_holders.unwrap(),
            vec![".claude/worktrees/old-ui".to_string()]
        );
        // Older CLI output has none of these and still parses.
        let old = parse_offload(&fixture("offload-dry-r3.json")).unwrap();
        assert!(old.history.refused.is_none() && old.history.held_by_worktrees.is_none());
    }

    #[test]
    fn prune_refusal_and_backup_fields_survive() {
        let r = parse_prune(&fixture("prune-refused-r3.json")).unwrap();
        let local = r.local.unwrap();
        assert!(local.available);
        assert_eq!(local.refused.as_deref(), Some("nothing_to_free"));
        assert_eq!(local.holding_refs_count, Some(6));
        assert_eq!(local.holding_refs[0].name, "refs/stash");
        assert!(local.freed_bytes.is_none());
        let r = parse_prune(&fixture("prune-real-r3.json")).unwrap();
        let local = r.local.unwrap();
        assert_eq!(local.freed_bytes, Some(16384));
        assert_eq!(local.pending_reclaim_bytes, Some(125_921_912));
        assert_eq!(local.reclaim_after.as_deref(), Some("2026-10-10T21:26:58Z"));
        assert!(local
            .backup_ref
            .unwrap()
            .starts_with("refs/hq-storage/backup/"));
        let s = parse_status(&fixture("status-r3.json")).unwrap();
        assert_eq!(s.local.pending_reclaim_bytes, Some(125_921_912));
        assert_eq!(s.local.holding_refs.len(), 6);
        assert!(s.offload.unwrap().current_reason.is_some());
        assert_eq!(s.reclaim.unwrap().dropped, Some(0));
    }

    #[test]
    fn dry_run_offload_keeps_candidates() {
        let r = parse_offload(&fixture("offload-dry.json")).unwrap();
        assert!(r.dry_run);
        assert_eq!(r.history.uploaded, 0);
        assert_eq!(r.history.candidates, Some(6));
        assert_eq!(r.history.candidate_bytes, Some(378_535_936));
    }

    #[test]
    fn real_offload_keeps_errors_and_unavailable_halves() {
        let r = parse_offload(&fixture("offload-real.json")).unwrap();
        assert_eq!(r.history.uploaded, 6);
        assert_eq!(r.history.freed_bytes, 0);
        assert_eq!(r.errors.len(), 1);
        // The CLI marks blocked halves unavailable; that must survive parsing.
        let mut v: serde_json::Value = serde_json::from_str(&fixture("offload-real.json")).unwrap();
        v["current"]["available"] = false.into();
        v["current"]["reason"] = "blocked".into();
        v["history"]["available"] = false.into();
        v["history"]["reason"] = "update HQ sync".into();
        assert_passthrough::<OffloadResult>(&v.to_string());
        let r = parse_offload(&v.to_string()).unwrap();
        assert_eq!(r.current.available, Some(false));
        assert_eq!(r.current.reason.as_deref(), Some("blocked"));
        assert_eq!(r.history.available, Some(false));
        assert_eq!(r.history.reason.as_deref(), Some("update HQ sync"));
        assert!(parse_offload("error: unknown command 'offload'").is_err());
    }

    #[test]
    fn status_keeps_can_delete_and_offload_availability() {
        let mut v: serde_json::Value = serde_json::from_str(&fixture("status.json")).unwrap();
        v["cloud"] = serde_json::json!([{
            "company": "indigo", "available": true, "can_delete": false,
            "current_bytes": 0, "noncurrent_bytes": 0, "noncurrent_count": 0,
            "delete_markers": 0, "tranches": []
        }]);
        v["cloud_error"] = "signed out".into();
        v["offload"]["available"] = false.into();
        v["offload"]["reason"] = "update HQ sync".into();
        assert_passthrough::<StorageStatus>(&v.to_string());
        let s = parse_status(&v.to_string()).unwrap();
        assert_eq!(s.cloud[0].can_delete, Some(false));
        assert_eq!(s.cloud_error.as_deref(), Some("signed out"));
        let o = s.offload.unwrap();
        assert_eq!(o.available, Some(false));
        assert_eq!(o.current_available, None);
    }

    #[test]
    fn offload_args_shape() {
        assert_eq!(
            rendered(&offload_args(true)),
            ["storage", "offload", "--dry-run", "--json"]
        );
        assert_eq!(
            rendered(&offload_args(false)),
            ["storage", "offload", "--yes", "--json"]
        );
    }

    #[test]
    fn timeout_is_short_for_reads_and_bounded_for_writes() {
        assert_eq!(timeout_for(&status_args()), STATUS_TIMEOUT);
        assert_eq!(timeout_for(&offload_args(true)), READ_TIMEOUT);
        assert_eq!(timeout_for(&offload_args(false)), WRITE_TIMEOUT);
        let req = PruneRequest {
            local_before: Some("2026-01-01".into()),
            ..Default::default()
        };
        assert_eq!(timeout_for(&prune_args(&req, true).unwrap()), READ_TIMEOUT);
        assert_eq!(timeout_for(&prune_args(&req, false).unwrap()), WRITE_TIMEOUT);
        assert!(STATUS_TIMEOUT < READ_TIMEOUT);
        assert!(READ_TIMEOUT < WRITE_TIMEOUT);
        // A cold status on a large vault takes about 2 minutes.
        assert!(STATUS_TIMEOUT >= Duration::from_secs(4 * 60));
    }

    #[tokio::test]
    async fn stuck_call_returns_plain_timeout_code() {
        let never = std::future::pending::<()>();
        let err = run_with_timeout(never, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(err, TIMEOUT_ERROR);
        let ok = run_with_timeout(async { 7 }, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(ok, 7);
    }

    #[test]
    fn old_cli_detection() {
        assert!(is_old_cli("error: unknown command 'storage'"));
        // What hq 5.345.89 prints for `hq storage big-files --json`.
        assert!(is_old_cli("error: unknown command 'big-files'"));
        assert!(!is_old_cli("network timeout"));
    }

    // ── Single flight, cache, and process-group stop (slow Storage screen) ──

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn leak<T: Clone + Send + Sync + 'static>() -> &'static SingleFlight<T> {
        Box::leak(Box::new(SingleFlight::new()))
    }

    #[tokio::test]
    async fn second_request_joins_the_running_scan() {
        let flight = leak::<u32>();
        let runs = Arc::new(AtomicUsize::new(0));
        let mk = |runs: Arc<AtomicUsize>| {
            move || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(7)
            }
        };
        let a = flight.run(None, mk(runs.clone()));
        let b = flight.run(None, mk(runs.clone()));
        let c = flight.run(None, mk(runs.clone()));
        assert_eq!((a.await, b.await, c.await), (Ok(7), Ok(7), Ok(7)));
        assert_eq!(runs.load(Ordering::SeqCst), 1, "only one scan may run");
    }

    #[tokio::test]
    async fn a_new_request_after_the_scan_ends_runs_again() {
        let flight = leak::<u32>();
        let runs = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let r = runs.clone();
            let got = flight
                .run(None, move || async move { Ok(r.fetch_add(1, Ordering::SeqCst) as u32) })
                .await;
            assert!(got.is_ok());
        }
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert!(!flight.in_flight());
    }

    #[tokio::test]
    async fn leaving_the_screen_does_not_cancel_or_duplicate_the_scan() {
        let flight = leak::<u32>();
        let runs = Arc::new(AtomicUsize::new(0));
        let r = runs.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        // The screen asks, then goes away (drops its future).
        drop(flight.run(None, move || async move {
            r.fetch_add(1, Ordering::SeqCst);
            let _ = rx.await;
            Ok(1)
        }));
        tokio::task::yield_now().await;
        assert!(flight.in_flight(), "the scan keeps running on its own task");
        // Re-opening joins it instead of starting a second scan.
        let r2 = runs.clone();
        let again = flight.run(None, move || async move {
            r2.fetch_add(1, Ordering::SeqCst);
            Ok(2)
        });
        tx.send(()).unwrap();
        assert_eq!(again.await, Ok(1));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(!flight.in_flight(), "the slot clears when the scan ends");
    }

    #[tokio::test]
    async fn a_stale_scan_is_followed_not_overlapped() {
        let flight = leak::<u32>();
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mk = |v: u32, live: Arc<AtomicUsize>, peak: Arc<AtomicUsize>| {
            move || async move {
                let n = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                live.fetch_sub(1, Ordering::SeqCst);
                Ok(v)
            }
        };
        let first = flight.run(None, mk(1, live.clone(), peak.clone()));
        // A prune finished after the first scan started: its figures are old.
        let not_before = Some(Instant::now());
        let second = flight.run(not_before, mk(2, live.clone(), peak.clone()));
        // A third request with the same bar joins the fresh run.
        let third = flight.run(not_before, mk(3, live.clone(), peak.clone()));
        assert_eq!(first.await, Ok(1));
        assert_eq!(second.await, Ok(2));
        assert_eq!(third.await, Ok(2));
        assert_eq!(peak.load(Ordering::SeqCst), 1, "scans never overlap");
    }

    static CACHE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn temp_cache() -> PathBuf {
        std::env::temp_dir()
            .join(format!("hq-storage-cache-test-{}-{}", std::process::id(), rand_suffix()))
            .join("storage-status.json")
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn good_status_is_cached_for_the_next_open() {
        let _g = CACHE_TEST_LOCK.lock().await;
        clear_cached(&temp_cache());
        let file = temp_cache();
        let got = status_flight(file.clone(), "/hq".into(), || async { parse_status(STATUS) }).await;
        assert!(got.is_ok());
        let cached = read_cached(&file, "/hq").expect("cached in memory");
        assert_eq!(cached.status, parse_status(STATUS).unwrap());
        assert!(!cached.fetched_at.is_empty());
        // Another HQ folder never sees it.
        assert!(read_cached(&file, "/other").is_none());
        // After an app restart (memory empty) it comes back from disk.
        *LAST_STATUS.lock().unwrap() = None;
        assert_eq!(read_cached(&file, "/hq").map(|c| c.status), Some(parse_status(STATUS).unwrap()));
        clear_cached(&file);
    }

    #[tokio::test]
    async fn feature_disabled_clears_the_cache_fail_closed() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        write_cached(
            &file,
            CachedStatus {
                status: parse_status(STATUS).unwrap(),
                fetched_at: "2026-10-11T00:00:00Z".into(),
                hq_root: "/hq".into(),
            },
        );
        let got = status_flight(file.clone(), "/hq".into(), || async {
            Err(FEATURE_DISABLED_ERROR.to_string())
        })
        .await;
        assert_eq!(got, Err(FEATURE_DISABLED_ERROR.to_string()));
        assert!(read_cached(&file, "/hq").is_none());
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn failed_scan_keeps_the_last_good_status() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        status_flight(file.clone(), "/hq".into(), || async { parse_status(STATUS) })
            .await
            .unwrap();
        let got = status_flight(file.clone(), "/hq".into(), || async {
            Err(TIMEOUT_ERROR.to_string())
        })
        .await;
        assert!(got.is_err());
        assert!(read_cached(&file, "/hq").is_some());
        clear_cached(&file);
    }

    fn big(count: u64) -> StorageBigFiles {
        StorageBigFiles {
            offload: Some(OffloadStatus {
                history_candidates: CountBytes { count, bytes: count * 100 },
                ..Default::default()
            }),
            generated_at: Some("2026-10-12T00:00:00Z".into()),
        }
    }

    fn fast_status() -> StorageStatus {
        parse_status(&fixture("status-fast-r5.json")).unwrap()
    }

    #[tokio::test]
    async fn big_files_have_their_own_single_flight() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        let runs = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let r = runs.clone();
        let first = big_files_flight(file.clone(), "/hq".into(), move || async move {
            r.fetch_add(1, Ordering::SeqCst);
            let _ = rx.await;
            Ok(big(3))
        });
        // The summary is not held up by the running big-file scan.
        let summary = status_flight(file.clone(), "/hq".into(), || async { Ok(fast_status()) }).await;
        assert!(summary.is_ok());
        // A second big-files request joins the running one.
        let r2 = runs.clone();
        let second = big_files_flight(file.clone(), "/hq".into(), move || async move {
            r2.fetch_add(1, Ordering::SeqCst);
            Ok(big(9))
        });
        tx.send(()).unwrap();
        assert_eq!(first.await, Ok(big(3)));
        assert_eq!(second.await, Ok(big(3)));
        assert_eq!(runs.load(Ordering::SeqCst), 1, "only one big-file scan may run");
        clear_cached(&file);
    }

    #[tokio::test]
    async fn big_files_fill_the_cache_and_survive_the_next_summary() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        status_flight(file.clone(), "/hq".into(), || async { Ok(fast_status()) }).await.unwrap();
        assert!(read_cached(&file, "/hq").unwrap().status.offload.is_none());
        big_files_flight(file.clone(), "/hq".into(), || async { Ok(big(4)) }).await.unwrap();
        assert_eq!(read_cached(&file, "/hq").unwrap().status.offload, big(4).offload);
        // A later summary without big files keeps the known ones, also after a restart.
        *LAST_STATUS.lock().unwrap() = None;
        *LAST_BIG_FILES.lock().unwrap() = None;
        status_flight(file.clone(), "/hq".into(), || async { Ok(fast_status()) }).await.unwrap();
        let cached = read_cached(&file, "/hq").unwrap();
        assert_eq!(cached.status.offload, big(4).offload);
        assert_eq!(cached.status.big_files_included, Some(false));
        clear_cached(&file);
    }

    #[tokio::test]
    async fn first_open_big_files_before_any_summary_are_kept() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        // No cache yet: big files land first, then the summary.
        big_files_flight(file.clone(), "/hq".into(), || async { Ok(big(2)) }).await.unwrap();
        assert!(read_cached(&file, "/hq").is_none());
        status_flight(file.clone(), "/hq".into(), || async { Ok(fast_status()) }).await.unwrap();
        assert_eq!(read_cached(&file, "/hq").unwrap().status.offload, big(2).offload);
        // Another HQ folder never gets them.
        clear_cached(&file);
        big_files_flight(file.clone(), "/hq".into(), || async { Ok(big(2)) }).await.unwrap();
        status_flight(file.clone(), "/other".into(), || async { Ok(fast_status()) }).await.unwrap();
        assert!(read_cached(&file, "/other").unwrap().status.offload.is_none());
        clear_cached(&file);
    }

    #[tokio::test]
    async fn older_cli_status_is_cached_as_is() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        let old = parse_status(&fixture("status-held-r4.json")).unwrap();
        // The big-files read fails on an older CLI and leaves the cache alone.
        let got = big_files_flight(file.clone(), "/hq".into(), || async { Err(UPDATE_HQ_ERROR.to_string()) }).await;
        assert_eq!(got, Err(UPDATE_HQ_ERROR.to_string()));
        let o = old.clone();
        status_flight(file.clone(), "/hq".into(), move || async move { Ok(o) }).await.unwrap();
        assert_eq!(read_cached(&file, "/hq").unwrap().status, old);
        clear_cached(&file);
    }

    #[tokio::test]
    async fn feature_disabled_from_big_files_clears_the_cache() {
        let _g = CACHE_TEST_LOCK.lock().await;
        let file = temp_cache();
        clear_cached(&file);
        status_flight(file.clone(), "/hq".into(), || async { Ok(fast_status()) }).await.unwrap();
        let got = big_files_flight(file.clone(), "/hq".into(), || async {
            Err(FEATURE_DISABLED_ERROR.to_string())
        })
        .await;
        assert_eq!(got, Err(FEATURE_DISABLED_ERROR.to_string()));
        assert!(read_cached(&file, "/hq").is_none());
        assert!(!file.exists());
    }

    #[test]
    fn status_stays_read_only() {
        let args = rendered(&status_args());
        for word in ["reclaim", "gc", "prune", "drop-backups", "--yes"] {
            assert!(!args.iter().any(|a| a.contains(word)), "status must not run {word}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_the_scripts_hq_started_too() {
        let dir = std::env::temp_dir().join(format!("hq-storage-pg-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("child.pid");
        // Stands in for hq starting `hq-storage.sh large`, which outlived hq.
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let res = run_child(cmd, Duration::from_millis(300)).await;
        assert_eq!(res.unwrap_err(), TIMEOUT_ERROR);
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        let mut gone = false;
        for _ in 0..50 {
            // Reaped by init or a zombie we cannot see: kill(pid, 0) fails.
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(gone, "the grandchild scan must not outlive the timeout");
    }
}
