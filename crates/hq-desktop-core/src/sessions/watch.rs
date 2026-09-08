//! Pure policy for the event-driven local-session watcher.
//!
//! The app crate owns the impure half (the `notify` watcher, the tokio wake
//! task, the Tauri emit); everything that can be decided without touching a real
//! filesystem lives here so it is unit-testable:
//!
//! * [`is_relevant_session_path`] — which filesystem events are worth a wake.
//! * [`resolve_watch_root`] / [`plan_watch_roots`] — where to point the watcher,
//!   including the "directory does not exist yet" ancestor fallback.
//! * [`diff_watch_plans`] — what changed between the registered plan and a
//!   freshly resolved one, so the watcher can be re-registered when a session
//!   directory finally appears (or disappears).
//! * [`WakeCoalescer`] — the ~300ms debounce that collapses an append storm
//!   (a CLI writing a transcript fires many events per second) into one wake.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Debounce window for filesystem wakes.
///
/// Long enough that a burst of appends to one transcript collapses into a single
/// snapshot (a snapshot is thousands of `stat`s plus a `pgrep` fork — see
/// `commands/sessions.rs`), short enough that the UI still feels immediate.
pub const SESSIONS_WATCH_DEBOUNCE_MS: u64 = 300;

/// File extensions that carry local session state. Claude transcripts and Codex
/// rollouts are `.jsonl`; HQ thread files are `.json`.
const RELEVANT_EXTENSIONS: &[&str] = &["jsonl", "json"];

/// Is this path worth waking the snapshot for?
///
/// Filters out the noise that shares these directories: editor/atomic-write
/// scratch files, macOS metadata, lock files, and anything without a session
/// extension. Case-insensitive on the extension because macOS filesystems are.
pub fn is_relevant_session_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    // Hidden/metadata files (`.DS_Store`, `.#lock`, editor dotfiles).
    if name.starts_with('.') {
        return false;
    }
    // Atomic-write scratch and editor backups. These land next to the real file
    // and are immediately followed by a rename of the real file, so ignoring
    // them costs no freshness.
    if name.ends_with('~') || name.ends_with(".tmp") || name.ends_with(".swp") {
        return false;
    }
    if name.contains(".tmp.") || name.ends_with(".lock") || name.ends_with(".part") {
        return false;
    }

    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            RELEVANT_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// One directory the watcher should register, after existence resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchRoot {
    /// The directory actually handed to `notify`.
    pub path: PathBuf,
    /// Whether to watch it recursively.
    pub recursive: bool,
    /// True when [`path`](Self::path) is a stand-in ancestor because the
    /// requested directory does not exist yet.
    ///
    /// A fallback watch is deliberately weak: it is non-recursive, and the
    /// create event for the requested directory is a *directory* create, which
    /// [`is_relevant_session_path`] rejects (no `.jsonl`/`.json` extension). So
    /// the directory appearing does **not** wake the snapshot, and nothing
    /// written inside it ever reaches a non-recursive watch.
    ///
    /// Recovery is therefore the safety tick's job, not the event stream's: the
    /// poller re-runs root resolution, [`diff_watch_plans`] reports the fallback
    /// as removed and the real directory as added, and the watcher is
    /// re-registered onto it. See `commands/sessions/watch.rs`.
    pub fallback: bool,
}

/// A directory we *want* to watch, before existence is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchRequest {
    pub path: PathBuf,
    pub recursive: bool,
}

impl WatchRequest {
    pub fn recursive(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            recursive: true,
        }
    }

    pub fn shallow(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            recursive: false,
        }
    }
}

/// Resolve one request into a watchable directory.
///
/// * The directory exists → watch it as requested.
/// * It does not → walk up to the nearest existing ancestor and watch that
///   **non-recursively**, so the directory appearing later still wakes us
///   without subscribing to a whole home directory recursively.
/// * No ancestor exists at all → `None` (skip it).
///
/// `dir_exists` is injected so this is testable without a real filesystem.
pub fn resolve_watch_root(
    request: &WatchRequest,
    dir_exists: &dyn Fn(&Path) -> bool,
) -> Option<WatchRoot> {
    if dir_exists(&request.path) {
        return Some(WatchRoot {
            path: request.path.clone(),
            recursive: request.recursive,
            fallback: false,
        });
    }
    let mut current = request.path.parent();
    while let Some(dir) = current {
        if dir_exists(dir) {
            return Some(WatchRoot {
                path: dir.to_path_buf(),
                recursive: false,
                fallback: true,
            });
        }
        current = dir.parent();
    }
    None
}

/// Resolve every request, dropping unresolvable ones and de-duplicating the
/// result. When two requests collapse onto the same directory (common with the
/// ancestor fallback), the more permissive registration wins — a recursive watch
/// subsumes a shallow one, and a real root subsumes a fallback.
pub fn plan_watch_roots(
    requests: &[WatchRequest],
    dir_exists: &dyn Fn(&Path) -> bool,
) -> Vec<WatchRoot> {
    let mut out: Vec<WatchRoot> = Vec::new();
    for request in requests {
        let Some(root) = resolve_watch_root(request, dir_exists) else {
            continue;
        };
        match out.iter_mut().find(|r| r.path == root.path) {
            Some(existing) => {
                existing.recursive |= root.recursive;
                existing.fallback &= root.fallback;
            }
            None => out.push(root),
        }
    }
    out
}

/// A change between the currently registered watch plan and a freshly resolved
/// one, expressed as the `notify` calls needed to reconcile them.
///
/// Registration identity is `(path, recursive)`: those are the only two things
/// handed to `notify::Watcher::watch`, so a root whose *only* difference is the
/// [`WatchRoot::fallback`] bookkeeping flag needs no re-registration, while a
/// directory that switched between shallow and recursive does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchPlanDiff {
    /// Roots to `watch` (new directories, or a changed recursion mode).
    pub added: Vec<WatchRoot>,
    /// Roots to `unwatch` (gone, or superseded by a different recursion mode).
    pub removed: Vec<WatchRoot>,
}

impl WatchPlanDiff {
    /// True when the plans are registration-equivalent and nothing must change.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

fn registration_key(root: &WatchRoot) -> (&Path, bool) {
    (root.path.as_path(), root.recursive)
}

/// Diff the registered plan against a freshly resolved one.
///
/// This is what makes root resolution *live*: at startup a directory that does
/// not exist yet resolves to a shallow ancestor fallback, and when it is later
/// created a re-resolution produces the real recursive root. Diffing the two
/// plans yields exactly the `unwatch`/`watch` pair that swaps the blind fallback
/// for a real watch, without tearing down and rebuilding the whole watcher.
///
/// `removed` is emitted before `added` is applied by the caller, so a path that
/// appears in both (recursion mode changed) is unwatched first and then
/// re-registered.
pub fn diff_watch_plans(current: &[WatchRoot], next: &[WatchRoot]) -> WatchPlanDiff {
    let current_keys: BTreeSet<(&Path, bool)> = current.iter().map(registration_key).collect();
    let next_keys: BTreeSet<(&Path, bool)> = next.iter().map(registration_key).collect();

    WatchPlanDiff {
        added: next
            .iter()
            .filter(|r| !current_keys.contains(&registration_key(r)))
            .cloned()
            .collect(),
        removed: current
            .iter()
            .filter(|r| !next_keys.contains(&registration_key(r)))
            .cloned()
            .collect(),
    }
}

/// Build the watch requests for the local session stores.
///
/// Pure over its inputs: the caller supplies the resolved Claude projects
/// directories, the Codex root (`~/.codex`), and the HQ `workspace` directory,
/// so this can be exercised against a fixture tree.
///
/// Covered:
/// * every Claude projects dir (recursive — transcripts are nested per project),
/// * `<codex>/sessions` and `<codex>/archived_sessions` (recursive — rollouts are
///   nested by date),
/// * `<codex>` itself, shallow, for `session_index.jsonl`,
/// * `<workspace>/threads` and `<workspace>/metrics`, shallow — both are flat
///   directories of files.
pub fn session_watch_requests(
    claude_projects_dirs: &[PathBuf],
    codex_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
) -> Vec<WatchRequest> {
    let mut requests = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for dir in claude_projects_dirs {
        if seen.insert(dir.clone()) {
            requests.push(WatchRequest::recursive(dir.clone()));
        }
    }
    if let Some(codex) = codex_dir {
        for nested in ["sessions", "archived_sessions"] {
            let path = codex.join(nested);
            if seen.insert(path.clone()) {
                requests.push(WatchRequest::recursive(path));
            }
        }
        // `session_index.jsonl` lives directly in `~/.codex`.
        if seen.insert(codex.to_path_buf()) {
            requests.push(WatchRequest::shallow(codex.to_path_buf()));
        }
    }
    if let Some(workspace) = workspace_dir {
        for nested in ["threads", "metrics"] {
            let path = workspace.join(nested);
            if seen.insert(path.clone()) {
                requests.push(WatchRequest::shallow(path));
            }
        }
    }
    requests
}

/// Collapses a burst of filesystem events into at most one wake per window.
///
/// Trailing-edge: the first event of a burst opens a window, every later event
/// inside it is absorbed, and the wake fires when the window closes. That means
/// a change is reflected within roughly one window (~300ms) while a CLI
/// streaming a transcript costs one snapshot rather than dozens.
#[derive(Debug, Clone)]
pub struct WakeCoalescer {
    window: Duration,
    pending_since: Option<Instant>,
}

impl WakeCoalescer {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            pending_since: None,
        }
    }

    /// The debounce window this coalescer collapses events into.
    pub fn window(&self) -> Duration {
        self.window
    }

    /// Record a relevant filesystem event.
    ///
    /// Returns `true` when this event opened a new window (i.e. the caller
    /// should start waiting for it), `false` when it was absorbed into a window
    /// that is already open.
    pub fn record(&mut self, now: Instant) -> bool {
        if self.pending_since.is_some() {
            return false;
        }
        self.pending_since = Some(now);
        true
    }

    /// How long until the pending wake is due. `None` when nothing is pending;
    /// `Some(ZERO)` when it is due right now.
    pub fn due_in(&self, now: Instant) -> Option<Duration> {
        let since = self.pending_since?;
        Some(self.window.saturating_sub(now.saturating_duration_since(since)))
    }

    /// Consume the pending wake if its window has closed. Returns `true` exactly
    /// once per burst, at which point the caller should refresh the snapshot.
    pub fn take_if_due(&mut self, now: Instant) -> bool {
        match self.due_in(now) {
            Some(remaining) if remaining.is_zero() => {
                self.pending_since = None;
                true
            }
            _ => false,
        }
    }

    /// Is a wake currently pending?
    pub fn is_pending(&self) -> bool {
        self.pending_since.is_some()
    }
}

impl Default for WakeCoalescer {
    fn default() -> Self {
        Self::new(Duration::from_millis(SESSIONS_WATCH_DEBOUNCE_MS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Event filter ────────────────────────────────────────────────────────

    #[test]
    fn relevant_paths_are_session_files() {
        for path in [
            "/home/u/.claude/projects/-repo/1b2c.jsonl",
            "/home/u/.codex/sessions/2026/09/rollout-abc.jsonl",
            "/home/u/.codex/session_index.jsonl",
            "/hq/workspace/threads/thread-1.json",
            "/hq/workspace/metrics/audit-log.jsonl",
            "/hq/workspace/metrics/AUDIT-LOG.JSONL",
        ] {
            assert!(
                is_relevant_session_path(Path::new(path)),
                "{path} should wake the snapshot"
            );
        }
    }

    #[test]
    fn irrelevant_paths_are_ignored() {
        for path in [
            "/home/u/.claude/projects/-repo/.DS_Store",
            "/home/u/.claude/projects/-repo/1b2c.jsonl~",
            "/home/u/.claude/projects/-repo/1b2c.jsonl.tmp",
            "/home/u/.claude/projects/-repo/.1b2c.jsonl.swp",
            "/home/u/.codex/sessions/rollout.jsonl.lock",
            "/home/u/.codex/sessions/rollout.jsonl.part",
            "/home/u/.codex/sessions/notes.md",
            "/home/u/.codex/sessions/binary",
            "/",
        ] {
            assert!(
                !is_relevant_session_path(Path::new(path)),
                "{path} should be ignored"
            );
        }
    }

    // ── Root resolution ─────────────────────────────────────────────────────

    fn existing(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| paths.iter().any(|e| Path::new(e) == p)
    }

    #[test]
    fn existing_dir_is_watched_as_requested() {
        let exists = existing(&["/home/u/.claude/projects"]);
        let root = resolve_watch_root(
            &WatchRequest::recursive("/home/u/.claude/projects"),
            &exists,
        )
        .expect("resolves");
        assert_eq!(root.path, PathBuf::from("/home/u/.claude/projects"));
        assert!(root.recursive);
        assert!(!root.fallback);
    }

    #[test]
    fn missing_dir_falls_back_to_nearest_existing_ancestor_shallowly() {
        // `~/.codex` exists but `archived_sessions` has never been created.
        let exists = existing(&["/home/u", "/home/u/.codex"]);
        let root =
            resolve_watch_root(&WatchRequest::recursive("/home/u/.codex/archived_sessions"), &exists)
                .expect("falls back");
        assert_eq!(root.path, PathBuf::from("/home/u/.codex"));
        assert!(
            !root.recursive,
            "a fallback ancestor must not be watched recursively"
        );
        assert!(root.fallback);
    }

    #[test]
    fn unresolvable_request_is_skipped() {
        let exists = existing(&[]);
        assert!(
            resolve_watch_root(&WatchRequest::recursive("/nope/at/all"), &exists).is_none(),
            "nothing exists, so nothing is watched"
        );
    }

    #[test]
    fn plan_dedupes_and_keeps_the_most_permissive_registration() {
        // `sessions` exists (recursive), `archived_sessions` does not and falls
        // back to `~/.codex`, which is also requested shallowly for the index.
        let exists = existing(&["/home/u", "/home/u/.codex", "/home/u/.codex/sessions"]);
        let requests = session_watch_requests(&[], Some(Path::new("/home/u/.codex")), None);
        let roots = plan_watch_roots(&requests, &exists);

        let paths: Vec<_> = roots.iter().map(|r| r.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/home/u/.codex/sessions"),
                PathBuf::from("/home/u/.codex"),
            ],
            "one entry per directory, in request order"
        );
        assert!(roots[0].recursive && !roots[0].fallback);
        // `~/.codex` was reached both as a fallback and as a real shallow request;
        // the real request wins, so it is not marked as a fallback.
        assert!(!roots[1].recursive);
        assert!(!roots[1].fallback);
    }

    #[test]
    fn missing_roots_are_skipped_entirely_when_no_ancestor_exists() {
        let exists = existing(&["/hq/workspace"]);
        let requests = session_watch_requests(
            &[PathBuf::from("/gone/claude/projects")],
            None,
            Some(Path::new("/hq/workspace")),
        );
        let roots = plan_watch_roots(&requests, &exists);
        assert_eq!(
            roots.iter().map(|r| r.path.clone()).collect::<Vec<_>>(),
            vec![PathBuf::from("/hq/workspace")],
            "the unreachable Claude dir is dropped; threads+metrics both fall back to workspace"
        );
        assert!(roots[0].fallback);
    }

    #[test]
    fn requests_cover_every_local_session_store() {
        let requests = session_watch_requests(
            &[PathBuf::from("/home/u/.claude/projects")],
            Some(Path::new("/home/u/.codex")),
            Some(Path::new("/hq/workspace")),
        );
        let described: Vec<(PathBuf, bool)> = requests
            .iter()
            .map(|r| (r.path.clone(), r.recursive))
            .collect();
        assert_eq!(
            described,
            vec![
                (PathBuf::from("/home/u/.claude/projects"), true),
                (PathBuf::from("/home/u/.codex/sessions"), true),
                (PathBuf::from("/home/u/.codex/archived_sessions"), true),
                (PathBuf::from("/home/u/.codex"), false),
                (PathBuf::from("/hq/workspace/threads"), false),
                (PathBuf::from("/hq/workspace/metrics"), false),
            ]
        );
    }

    #[test]
    fn duplicate_claude_dirs_are_requested_once() {
        let dir = PathBuf::from("/home/u/.claude/projects");
        let requests = session_watch_requests(&[dir.clone(), dir.clone()], None, None);
        assert_eq!(requests.len(), 1);
    }

    // ── Live re-resolution (plan diffing) ───────────────────────────────────

    #[test]
    fn diff_detects_a_root_that_appeared_after_startup() {
        // Startup: `~/.claude/projects` does not exist, so the request falls
        // back to a SHALLOW watch on `~/.claude` — which can never see a nested
        // transcript write.
        let requests = session_watch_requests(&[PathBuf::from("/home/u/.claude/projects")], None, None);
        let at_startup = plan_watch_roots(&requests, &existing(&["/home/u", "/home/u/.claude"]));
        assert_eq!(at_startup.len(), 1);
        assert_eq!(at_startup[0].path, PathBuf::from("/home/u/.claude"));
        assert!(at_startup[0].fallback && !at_startup[0].recursive);

        // The user runs Claude Code for the first time and `projects/` appears.
        let now = plan_watch_roots(
            &requests,
            &existing(&["/home/u", "/home/u/.claude", "/home/u/.claude/projects"]),
        );

        let diff = diff_watch_plans(&at_startup, &now);
        assert!(!diff.is_empty(), "an appearing root must force a re-registration");
        assert_eq!(
            diff.added,
            vec![WatchRoot {
                path: PathBuf::from("/home/u/.claude/projects"),
                recursive: true,
                fallback: false,
            }],
            "the real projects dir is registered recursively"
        );
        assert_eq!(
            diff.removed,
            vec![WatchRoot {
                path: PathBuf::from("/home/u/.claude"),
                recursive: false,
                fallback: true,
            }],
            "the blind ancestor fallback is dropped"
        );
    }

    #[test]
    fn diff_is_empty_when_nothing_changed() {
        let requests = session_watch_requests(&[], Some(Path::new("/home/u/.codex")), None);
        let exists = existing(&["/home/u", "/home/u/.codex", "/home/u/.codex/sessions"]);
        let a = plan_watch_roots(&requests, &exists);
        let b = plan_watch_roots(&requests, &exists);
        let diff = diff_watch_plans(&a, &b);
        assert!(diff.is_empty(), "a stable filesystem must not churn the watcher");
        assert_eq!(diff, WatchPlanDiff::default());
    }

    #[test]
    fn diff_ignores_the_fallback_flag_alone_but_not_the_recursion_mode() {
        let path = PathBuf::from("/home/u/.codex");
        let as_fallback = vec![WatchRoot { path: path.clone(), recursive: false, fallback: true }];
        let as_real = vec![WatchRoot { path: path.clone(), recursive: false, fallback: false }];
        assert!(
            diff_watch_plans(&as_fallback, &as_real).is_empty(),
            "same (path, mode) → notify is already registered correctly"
        );

        let recursive = vec![WatchRoot { path: path.clone(), recursive: true, fallback: false }];
        let diff = diff_watch_plans(&as_real, &recursive);
        assert_eq!(diff.removed, as_real, "shallow registration must be unwatched first");
        assert_eq!(diff.added, recursive, "…then re-registered recursively");
    }

    #[test]
    fn diff_reports_a_disappearing_root_as_removed() {
        let present = vec![WatchRoot {
            path: PathBuf::from("/hq/workspace/threads"),
            recursive: false,
            fallback: false,
        }];
        let diff = diff_watch_plans(&present, &[]);
        assert_eq!(diff.removed, present);
        assert!(diff.added.is_empty());
    }

    // ── Debounce ────────────────────────────────────────────────────────────

    #[test]
    fn a_burst_of_events_produces_exactly_one_wake() {
        let window = Duration::from_millis(300);
        let mut coalescer = WakeCoalescer::new(window);
        let t0 = Instant::now();

        // 50 appends spread across 200ms — well inside one window.
        let mut opened = 0;
        for i in 0..50u64 {
            if coalescer.record(t0 + Duration::from_millis(i * 4)) {
                opened += 1;
            }
        }
        assert_eq!(opened, 1, "only the first event opens the window");

        // Still inside the window → no wake yet.
        assert!(!coalescer.take_if_due(t0 + Duration::from_millis(299)));
        // Window closed → exactly one wake.
        assert!(coalescer.take_if_due(t0 + window));
        assert!(!coalescer.is_pending());
        // …and it does not fire twice.
        assert!(!coalescer.take_if_due(t0 + Duration::from_secs(5)));
    }

    #[test]
    fn a_later_burst_opens_a_fresh_window() {
        let window = Duration::from_millis(300);
        let mut coalescer = WakeCoalescer::new(window);
        let t0 = Instant::now();

        assert!(coalescer.record(t0));
        assert!(coalescer.take_if_due(t0 + window));

        let t1 = t0 + Duration::from_secs(10);
        assert!(coalescer.record(t1), "a new burst opens a new window");
        assert!(!coalescer.take_if_due(t1 + Duration::from_millis(10)));
        assert!(coalescer.take_if_due(t1 + window));
    }

    #[test]
    fn due_in_counts_down_and_is_none_when_idle() {
        let window = Duration::from_millis(300);
        let mut coalescer = WakeCoalescer::new(window);
        let t0 = Instant::now();
        assert_eq!(coalescer.due_in(t0), None, "nothing pending when idle");

        coalescer.record(t0);
        assert_eq!(coalescer.due_in(t0), Some(window));
        assert_eq!(
            coalescer.due_in(t0 + Duration::from_millis(100)),
            Some(Duration::from_millis(200))
        );
        assert_eq!(
            coalescer.due_in(t0 + Duration::from_secs(1)),
            Some(Duration::ZERO),
            "an overdue wake saturates at zero rather than underflowing"
        );
    }

    #[test]
    fn default_window_is_the_documented_debounce() {
        assert_eq!(
            WakeCoalescer::default().window(),
            Duration::from_millis(SESSIONS_WATCH_DEBOUNCE_MS)
        );
        assert_eq!(SESSIONS_WATCH_DEBOUNCE_MS, 300);
    }
}
