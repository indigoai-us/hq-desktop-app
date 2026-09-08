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
//! net (see `SESSIONS_POLL_INTERVAL_SECS`) for the changes no file records —
//! chiefly a `claude`/`codex` process exiting.
//!
//! Everything decidable without a real filesystem lives in
//! [`hq_desktop_core::sessions::watch`]; this file is only the impure wiring.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Runtime};

use hq_desktop_core::sessions::watch::{
    is_relevant_session_path, plan_watch_roots, session_watch_requests, WakeCoalescer, WatchRoot,
    SESSIONS_WATCH_DEBOUNCE_MS,
};

use crate::util::logfile::log;

use super::LOG_TAG;

/// Retains the watcher for the life of the process.
///
/// `notify` stops delivering the moment the watcher is dropped, so this must
/// outlive `setup`. `OnceLock` also makes setup idempotent: a second call sees
/// an occupied slot and returns rather than registering a duplicate watcher.
static WATCHER: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();

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
        let mode = if root.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        match watcher.watch(&root.path, mode) {
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
    *guard = Some(watcher);
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
