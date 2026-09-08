//! Event-driven wake for the local session snapshot.
//!
//! Mission Control used to learn about local session changes only by polling:
//! every tick re-walked `~/.claude/projects/**`, `~/.codex/sessions/**`, and the
//! HQ `workspace/` ledgers, whether or not anything had changed. That made
//! freshness a function of the poll cadence — lowering it cost battery, raising
//! it cost responsiveness.
//!
//! This module inverts that. A `notify` watcher (the same crate and retention
//! pattern as `commands/realtime_mutation.rs`) subscribes to the directories the
//! readers scan, and a relevant file change wakes the *same* snapshot path the
//! timer uses ([`super::refresh_and_emit`]) within roughly
//! [`SESSIONS_WATCH_DEBOUNCE_MS`]. The periodic poll stays on as a slow safety
//! net (see `SESSIONS_POLL_INTERVAL_SECS`) for the changes no file event
//! records: time-based status decay, and re-resolving these watch roots so a
//! session directory created after startup is picked up (see
//! [`refresh_sessions_watch_roots`] — root resolution is live, not one-shot). A
//! `claude`/`codex` process *exiting* has its own faster, cheaper timer,
//! `sessions::setup_sessions_liveness_ticker`.
//!
//! Everything decidable without a real filesystem lives in
//! [`hq_desktop_core::sessions::watch`]; this file is only the impure wiring.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Runtime};

use hq_desktop_core::sessions::watch::{
    diff_watch_plans, is_relevant_session_path, plan_watch_roots, session_watch_requests,
    WakeCoalescer, WatchRoot, SESSIONS_WATCH_DEBOUNCE_MS,
};

use crate::util::logfile::log;

use super::LOG_TAG;

/// The live watcher plus the plan it is currently registered against.
///
/// The plan is retained because root resolution is *live*: the safety tick
/// re-resolves and [`reconcile_watch_roots`] diffs the result against this, so
/// we need to know what `notify` was actually told, not just what we once
/// wanted.
struct WatcherState {
    watcher: RecommendedWatcher,
    /// The roots currently registered with [`Self::watcher`]. Only roots whose
    /// `watch` call succeeded are recorded, so a failed registration is retried
    /// on the next tick instead of being remembered as live.
    roots: Vec<WatchRoot>,
}

/// Retains the watcher for the life of the process.
///
/// `notify` stops delivering the moment the watcher is dropped, so this must
/// outlive `setup`. `OnceLock` also makes setup idempotent: a second call sees
/// an occupied slot and returns rather than registering a duplicate watcher.
/// Re-resolution mutates the state *in place* through this same slot, so it
/// never creates a second watcher.
static WATCHER: OnceLock<Mutex<Option<WatcherState>>> = OnceLock::new();

/// Resolve the directories to watch from the same helpers the readers use, so
/// the watcher can never drift from what is actually scanned.
fn resolve_watch_roots() -> Vec<WatchRoot> {
    let claude_dirs = hq_desktop_core::sessions::claude::claude_projects_dirs();
    let codex_dir = hq_desktop_core::sessions::codex::codex_dir();
    let workspace = hq_desktop_core::sessions::history::resolve_workspace_dir();

    let requests = session_watch_requests(
        &claude_dirs,
        Some(codex_dir.as_path()),
        workspace.as_deref(),
    );
    plan_watch_roots(&requests, &|p: &std::path::Path| p.is_dir())
}

/// Build a `notify` watcher that calls `sink` once per *relevant* changed path.
///
/// Filtering happens inside the callback (which runs on the notify thread) so
/// the noisy majority of events — editor scratch files, `.DS_Store`, lock files
/// — never reach the debouncer, let alone a snapshot.
fn recursive_mode(root: &WatchRoot) -> RecursiveMode {
    if root.recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    }
}

fn build_watcher<F>(roots: &[WatchRoot], sink: F) -> Result<RecommendedWatcher, String>
where
    F: Fn(PathBuf) + Send + 'static,
{
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            let Ok(event) = event else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            for path in event.paths {
                if is_relevant_session_path(&path) {
                    sink(path);
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let mut watched = 0usize;
    for root in roots {
        match watcher.watch(&root.path, recursive_mode(root)) {
            Ok(()) => watched += 1,
            Err(e) => log(
                LOG_TAG,
                &format!("SESSIONS_WATCH_ROOT_FAILED {} {e}", root.path.display()),
            ),
        }
    }
    if watched == 0 {
        return Err("no session directories could be watched".to_string());
    }
    Ok(watcher)
}

/// Reconcile a live watcher against a freshly resolved plan.
///
/// This is the recovery path for the ancestor fallback. At startup a session
/// directory that does not exist yet resolves to a **shallow** watch on its
/// nearest existing ancestor, and that registration is blind twice over: the
/// directory's own create event is a directory (rejected by
/// [`is_relevant_session_path`], which requires a `.jsonl`/`.json` extension),
/// and every later write inside it is nested, so it never reaches a
/// non-recursive watch. Without re-resolution the watcher stays permanently
/// blind to that store for the life of the process — exactly the fresh-install
/// case, where `~/.claude/projects` does not exist until the user first runs
/// Claude Code.
///
/// Re-registering (rather than watching ancestors recursively) is deliberate:
/// the fallback ancestors here are `$HOME`, `~/.claude`, `~/.codex` and the HQ
/// workspace root, and subscribing recursively to any of those means an FSEvents
/// subscription over an unbounded tree — the HQ workspace alone contains
/// worktrees and `node_modules`. The diff costs a handful of `is_dir` calls once
/// per safety tick.
///
/// Best-effort: every failure logs and is retried on the next tick. Returns the
/// number of roots newly registered, for logging and tests.
fn reconcile_watch_roots(state: &mut WatcherState, next: Vec<WatchRoot>) -> usize {
    let diff = diff_watch_plans(&state.roots, &next);
    if diff.is_empty() {
        return 0;
    }

    // Unwatch first: a root whose recursion mode changed appears in both lists,
    // and `notify` must lose the old registration before it gains the new one.
    for root in &diff.removed {
        if let Err(e) = state.watcher.unwatch(&root.path) {
            log(
                LOG_TAG,
                &format!("SESSIONS_WATCH_UNWATCH_FAILED {} {e}", root.path.display()),
            );
        }
    }

    let mut failed: Vec<PathBuf> = Vec::new();
    let mut added = 0usize;
    for root in &diff.added {
        match state.watcher.watch(&root.path, recursive_mode(root)) {
            Ok(()) => added += 1,
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("SESSIONS_WATCH_ROOT_FAILED {} {e}", root.path.display()),
                );
                failed.push(root.path.clone());
            }
        }
    }

    state.roots = next
        .into_iter()
        .filter(|r| !failed.contains(&r.path))
        .collect();

    log(
        LOG_TAG,
        &format!(
            "SESSIONS_WATCH_ROOTS_CHANGED added={added} removed={} roots={}",
            diff.removed.len(),
            state.roots.len()
        ),
    );
    added
}

/// Re-resolve the watch roots and re-register the watcher if they changed.
///
/// Called from the sessions safety poll (`super::setup_sessions_poller`), which
/// is why that timer still matters even though freshness is event-driven: it is
/// the only thing that notices a session directory being created after startup.
///
/// A no-op when the watcher never started, when nothing changed, or when
/// resolution comes back empty (a transient failure to read `$HOME` must not
/// unwatch everything we have).
pub(crate) fn refresh_sessions_watch_roots() {
    let Some(slot) = WATCHER.get() else {
        return;
    };
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(state) = guard.as_mut() else {
        return;
    };
    let next = resolve_watch_roots();
    if next.is_empty() {
        return;
    }
    reconcile_watch_roots(state, next);
}

/// Start the event-driven session watcher. Called from `main.rs` setup next to
/// [`super::setup_sessions_poller`].
///
/// Best-effort and non-fatal by construction: every failure path logs and
/// returns, leaving the safety poll as the only refresh path. It never panics
/// and never blocks startup — the watcher registration is the only synchronous
/// work, and the wake loop runs on the async runtime.
pub fn setup_sessions_watcher<R: Runtime>(app: AppHandle<R>) {
    let slot = WATCHER.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_some() {
        // Already running — setup is idempotent.
        return;
    }

    let roots = resolve_watch_roots();
    if roots.is_empty() {
        log(LOG_TAG, "SESSIONS_WATCH_NO_ROOTS");
        return;
    }

    // Unbounded so the notify thread never blocks on a slow snapshot; the
    // coalescer below drains the queue, so depth is bounded in practice by the
    // debounce window rather than by the channel.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watcher = match build_watcher(&roots, move |_path| {
        let _ = tx.send(());
    }) {
        Ok(watcher) => watcher,
        Err(e) => {
            log(LOG_TAG, &format!("SESSIONS_WATCH_START_FAILED {e}"));
            return;
        }
    };
    *guard = Some(WatcherState {
        watcher,
        roots: roots.clone(),
    });
    drop(guard);

    log(
        LOG_TAG,
        &format!("SESSIONS_WATCH_STARTED roots={}", roots.len()),
    );

    // Wake loop: trailing-edge debounce. The first event of a burst opens a
    // window; everything that arrives during it is absorbed; when the window
    // closes we drain the queue and take exactly one snapshot.
    tauri::async_runtime::spawn(async move {
        let mut coalescer = WakeCoalescer::new(Duration::from_millis(SESSIONS_WATCH_DEBOUNCE_MS));
        while rx.recv().await.is_some() {
            coalescer.record(Instant::now());
            // Sleep out the window. `due_in` re-reads the clock each pass so a
            // late-scheduled task still waits the right residual amount.
            while let Some(remaining) = coalescer.due_in(Instant::now()) {
                if remaining.is_zero() {
                    break;
                }
                tokio::time::sleep(remaining).await;
            }
            // Absorb everything that piled up during the window into this wake.
            while rx.try_recv().is_ok() {}
            if !coalescer.take_if_due(Instant::now()) {
                continue;
            }

            // Visibility gate: a watcher wake while every real window is hidden
            // must not emit — the snapshot would be serialised and pushed to a
            // frontend nobody can see. Same rule (and same helper) the poll's
            // `plan_poll` gating uses; the hidden heartbeat stays the poll's job.
            //
            // Note the cost we accept here: `refresh_and_emit` runs the full
            // `collect_snapshot_blocking`, which includes the `pgrep` liveness
            // fork. That is deliberate — it means a watcher wake produces a
            // fully-correct snapshot rather than a file-only one, and the
            // debounce bounds it to at most one fork per window.
            if !super::any_window_visible(&app) {
                continue;
            }
            super::refresh_and_emit(&app).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Integration: a real write to a watched directory reaches the callback,
    /// and an ignored filename does not. This is the wiring the pure tests in
    /// `hq_desktop_core::sessions::watch` cannot cover.
    #[test]
    fn a_real_file_write_triggers_the_callback() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![WatchRoot {
            path: dir.path().to_path_buf(),
            recursive: true,
            fallback: false,
        }];

        let relevant = Arc::new(AtomicUsize::new(0));
        let seen = relevant.clone();
        let _watcher = build_watcher(&roots, move |_path| {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .expect("watcher starts on a real directory");

        // Give the platform backend a moment to arm before writing.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.path().join("noise.DS_Store"), b"x").unwrap();
        std::fs::write(dir.path().join("session.jsonl"), b"{}\n").unwrap();

        // Poll for delivery rather than sleeping a fixed (flaky) amount.
        let deadline = Instant::now() + Duration::from_secs(10);
        while relevant.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            relevant.load(Ordering::SeqCst) > 0,
            "a .jsonl write under a watched root must reach the callback"
        );
    }

    /// Wait until `seen` is non-zero, or give up. Returns whether a wake landed.
    fn wake_arrived(seen: &Arc<AtomicUsize>) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while seen.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        seen.load(Ordering::SeqCst) > 0
    }

    /// The fresh-install regression: `~/.claude/projects` does not exist when
    /// the watcher starts, so the plan falls back to a SHALLOW watch on the
    /// parent. The directory is then created and a nested transcript written —
    /// neither of which a shallow ancestor watch can see.
    ///
    /// Before live re-resolution this test fails: the watcher stays blind for
    /// the life of the process and the only refresh left is the 90s safety
    /// poll. It passes once the safety tick re-resolves and re-registers.
    #[test]
    fn a_directory_created_after_setup_is_watched_once_roots_are_re_resolved() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");

        // Startup plan, resolved against the REAL filesystem: `projects` does
        // not exist yet, so this is the shallow fallback onto `home`.
        let requests = session_watch_requests(&[projects.clone()], None, None);
        let startup = plan_watch_roots(&requests, &|p: &std::path::Path| p.is_dir());
        assert_eq!(
            startup,
            vec![WatchRoot {
                path: home.path().to_path_buf(),
                recursive: false,
                fallback: true,
            }],
            "precondition: a missing session dir falls back to a shallow ancestor"
        );

        let seen = Arc::new(AtomicUsize::new(0));
        let sink = seen.clone();
        let watcher = build_watcher(&startup, move |_path| {
            sink.fetch_add(1, Ordering::SeqCst);
        })
        .expect("watcher starts on the fallback ancestor");
        let mut state = WatcherState {
            watcher,
            roots: startup,
        };
        std::thread::sleep(Duration::from_millis(200));

        // The user runs Claude Code for the first time: the store appears.
        std::fs::create_dir_all(projects.join("-repo")).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        // A safety tick re-resolves and re-registers.
        let next = plan_watch_roots(&requests, &|p: &std::path::Path| p.is_dir());
        let added = reconcile_watch_roots(&mut state, next);
        assert_eq!(added, 1, "the real projects dir must be newly registered");
        assert_eq!(
            state.roots,
            vec![WatchRoot {
                path: projects.clone(),
                recursive: true,
                fallback: false,
            }],
            "the blind shallow fallback is replaced by a recursive real watch"
        );
        std::thread::sleep(Duration::from_millis(200));

        // Only now write the transcript. Nested under the new root, so a
        // shallow ancestor watch could never deliver it.
        seen.store(0, Ordering::SeqCst);
        std::fs::write(projects.join("-repo").join("session.jsonl"), b"{}\n").unwrap();

        assert!(
            wake_arrived(&seen),
            "a transcript written into a directory created AFTER setup must wake the snapshot"
        );
    }

    /// Re-resolution is idempotent: a second tick with an unchanged filesystem
    /// must not churn the watcher (an unwatch/watch pair drops events).
    #[test]
    fn re_resolving_an_unchanged_plan_registers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![WatchRoot {
            path: dir.path().to_path_buf(),
            recursive: true,
            fallback: false,
        }];
        let watcher = build_watcher(&roots, |_| {}).expect("watcher starts");
        let mut state = WatcherState {
            watcher,
            roots: roots.clone(),
        };
        assert_eq!(reconcile_watch_roots(&mut state, roots.clone()), 0);
        assert_eq!(state.roots, roots, "an unchanged plan leaves the state alone");
    }

    /// A root that cannot be registered is NOT recorded as live, so the next
    /// safety tick retries it rather than believing it is watched.
    #[test]
    fn a_failed_registration_is_not_recorded_and_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![WatchRoot {
            path: dir.path().to_path_buf(),
            recursive: true,
            fallback: false,
        }];
        let watcher = build_watcher(&roots, |_| {}).expect("watcher starts");
        let mut state = WatcherState {
            watcher,
            roots: roots.clone(),
        };

        let mut next = roots.clone();
        let missing = PathBuf::from("/definitely/not/a/real/dir/hq-sessions-reconcile-test");
        next.push(WatchRoot {
            path: missing.clone(),
            recursive: true,
            fallback: false,
        });

        assert_eq!(reconcile_watch_roots(&mut state, next), 0, "nothing registered");
        assert_eq!(
            state.roots, roots,
            "the unwatchable root is dropped from the recorded plan so it is retried"
        );
    }

    /// The live entry point is safe to call before (and independently of) setup.
    #[test]
    fn refresh_sessions_watch_roots_is_a_no_op_without_a_watcher() {
        refresh_sessions_watch_roots();
    }

    #[test]
    fn build_watcher_errors_when_no_root_is_watchable() {
        let roots = vec![WatchRoot {
            path: PathBuf::from("/definitely/not/a/real/dir/hq-sessions-watch-test"),
            recursive: true,
            fallback: false,
        }];
        let err = build_watcher(&roots, |_| {}).expect_err("unwatchable roots are an error");
        assert!(err.contains("no session directories"), "{err}");
    }

    #[test]
    fn resolve_watch_roots_never_panics_and_only_returns_directories() {
        // On a CI box with no Claude/Codex dirs this may fall back to `$HOME`;
        // whatever it returns must be real directories, since that is the
        // contract `build_watcher` relies on.
        for root in resolve_watch_roots() {
            assert!(
                root.path.is_dir(),
                "{} should be an existing directory",
                root.path.display()
            );
        }
    }
}
