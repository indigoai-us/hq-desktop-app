//! Feature-flagged daemon lifecycle — V2 prep.
//!
//! Wraps `hq sync start` / `hq sync stop` as Tauri commands.
//! Behind `AUTOSTART_DAEMON` feature flag in ~/.hq/menubar.json (default false).
//! Svelte UI does NOT expose these V1 — invocable only via Tauri devtools.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::commands::process::{
    cancel_process_impl, deregister_process, run_process_impl, try_register_handle, ProcessEvent,
};
use crate::commands::status::{journal_for_sync_complete, write_journal};
use crate::commands::sync::RunTotals;
use crate::events::{SyncEvent, EVENT_SYNC_ALL_COMPLETE};
use crate::util::logfile::log;

#[allow(unused_imports)]
pub use hq_desktop_core::daemon::{
    build_watch_runner_args, event_push_eligible, is_autostart_enabled, is_instant_sync_enabled,
    is_pid_alive, is_realtime_sync_enabled, read_daemon_json, read_menubar_bool, read_pid_file,
    resolve_hq_folder_path, should_event_push, should_respawn_daemon, DaemonJson, DaemonStatus,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Singleton handle for daemon process.
const DAEMON_HANDLE: &str = "hq-sync-daemon";

/// SIGKILL delay after SIGTERM when stopping daemon.
const SIGKILL_DELAY: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Watch-mode ndjson handler
// ─────────────────────────────────────────────────────────────────────────────

/// Process a single stdout line from `hq-sync-runner --watch`.
///
/// The watcher emits the same ndjson protocol as a manual sync (one full
/// fanout-plan → plan/progress/complete → all-complete cycle per pass).
/// `handle_sync_line` in `sync.rs` owns the rich manual-sync handling
/// (per-file progress events, reconcile, telemetry, sentry captures);
/// here we only do what the popover needs to surface auto-sync to the
/// user — keep the conflict tally up-to-date and, on each pass's
/// AllComplete, write the journal and emit the same `sync:all-complete`
/// event the frontend already listens for.
///
/// Failing to parse a line is non-fatal: blank lines arrive at runner
/// teardown, and any unknown variant the runner adds in the future
/// should not kill the watcher.
fn handle_watch_stdout_line(
    app: &AppHandle,
    hq_folder: &str,
    totals: &Mutex<RunTotals>,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let event: SyncEvent = match serde_json::from_str(trimmed) {
        Ok(e) => e,
        Err(_) => return,
    };
    {
        let mut t = totals.lock().unwrap_or_else(|e| e.into_inner());
        t.accumulate(&event);
    }
    // Record each per-file transfer into the session activity log (Recent
    // Changes window). The watch daemon is the primary instant-sync path, so
    // without this the activity log would only ever capture foreground
    // "Sync Now" runs (handle_sync_line) and stay empty in normal use.
    if let SyncEvent::Progress(payload) = &event {
        crate::commands::activity::record_progress(app, payload);
    }
    if let SyncEvent::AllComplete(payload) = &event {
        let conflicts = {
            let t = totals.lock().unwrap_or_else(|e| e.into_inner());
            t.conflicts
        };
        let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let journal = journal_for_sync_complete(&now_iso, conflicts);
        if let Err(e) = write_journal(hq_folder, &journal) {
            log("daemon", &format!("failed to write journal: {e}"));
        }
        log("daemon", &format!("all-complete (conflicts={conflicts})"));
        // Mirror to a git repo at the HQ root (if any). Fire-and-forget so
        // a slow `git push` can't stall the next watch pass; the mirror's
        // in-flight guard skips overlapping runs.
        crate::commands::git_mirror::spawn_mirror_after_sync(hq_folder);
        let _ = app.emit(EVENT_SYNC_ALL_COMPLETE, payload.clone());
        // Reset for the next pass — watch mode loops indefinitely.
        *totals.lock().unwrap_or_else(|e| e.into_inner()) = RunTotals::default();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Start the sync daemon via `hq sync start`.
///
/// Pre-flight: checks PID file to see if a daemon is already running from a
/// previous app session. If alive, returns an error without spawning.
///
/// Spawns the daemon subprocess in the background. The daemon writes its own
/// .hq-sync.pid and .hq-sync-daemon.json files. This command returns immediately
/// after spawning.
///
/// Returns the handle string on success.
#[tauri::command]
pub fn start_daemon(app: AppHandle) -> Result<String, String> {
    if !try_register_handle(DAEMON_HANDLE) {
        return Err("Daemon is already starting".to_string());
    }

    let hq_folder_path = match resolve_hq_folder_path() {
        Ok(p) => p,
        Err(e) => {
            deregister_process(DAEMON_HANDLE);
            return Err(e);
        }
    };

    // Pre-flight: check if daemon is already running from a previous session
    if let Some(pid) = read_pid_file(&hq_folder_path) {
        if is_pid_alive(pid) {
            deregister_process(DAEMON_HANDLE);
            return Err(format!("Daemon is already running (PID {})", pid));
        }
    }

    let spawn_args = build_watch_runner_args(&hq_folder_path);

    log("daemon", "spawn: hq-sync-runner --watch");

    // Per-pass totals. Watch mode emits a full Complete/AllComplete cycle on
    // every chokidar tick + every 15-second poll, so we reset on each
    // AllComplete instead of accumulating forever.
    let totals: Arc<Mutex<RunTotals>> = Arc::new(Mutex::new(RunTotals::default()));
    let hq_folder = hq_folder_path.clone();

    thread::spawn(move || {
        let result = run_process_impl(DAEMON_HANDLE, &spawn_args, move |event| {
            // Surface stderr and non-success exits unconditionally — they
            // are the only signals the user has when the watcher dies
            // (e.g. "Unknown argument: --watch" on a stale runner pin).
            // Stdout is parsed for ndjson SyncEvents so each watcher pass
            // updates `.hq-sync-journal.json` and refreshes the popover's
            // "Last synced" stat — without that, the UI only ever showed
            // the timestamp of the last manual `Sync Now` click.
            match event {
                ProcessEvent::Stdout(line) => {
                    handle_watch_stdout_line(&app, &hq_folder, &totals, &line);
                }
                ProcessEvent::Stderr(line) => {
                    log("daemon.stderr", &line);
                    // Accumulate as a Sentry breadcrumb so a crash capture at
                    // the Exit arm below ships with the runner's last words.
                    sentry::add_breadcrumb(sentry::Breadcrumb {
                        category: Some("daemon.stderr".into()),
                        level: sentry::Level::Warning,
                        message: Some(line.clone()),
                        ..Default::default()
                    });
                }
                ProcessEvent::Exit {
                    code,
                    signal,
                    success,
                } => {
                    log(
                        "daemon",
                        &format!(
                            "exited: code={:?} signal={:?} success={}",
                            code, signal, success
                        ),
                    );
                    // Auto-sync runs unattended, so a crashed watcher was
                    // previously invisible (log-only). Capture genuine crashes
                    // to #hq-alerts — but NOT a deliberate stop (SIGTERM from
                    // cancel_process_impl on app-quit / auto-sync-off / re-spawn).
                    if !success && !crate::commands::process::is_cancelled(DAEMON_HANDLE) {
                        crate::commands::sync::capture_sync_error(
                            None,
                            "(auto-sync)",
                            &format!(
                                "auto-sync watcher exited unexpectedly (code={:?} signal={:?})",
                                code, signal
                            ),
                        );
                    }
                }
            }
        });

        if let Err(e) = result {
            log("daemon", &format!("spawn failed: {e}"));
            // The watcher never started — Sync is silently dead until restart.
            crate::commands::sync::capture_sync_error(
                None,
                "(auto-sync)",
                &format!("auto-sync watcher failed to spawn: {e}"),
            );
        }
    });

    Ok(DAEMON_HANDLE.to_string())
}

/// Settle delay before the supervisor's first check (let the launch-time
/// `start_daemon` run first) and the interval between checks thereafter.
const SUPERVISOR_SETTLE: Duration = Duration::from_secs(30);
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(30);

/// Background supervisor: every `SUPERVISOR_INTERVAL`, ensure the watch daemon
/// is running whenever auto-sync is enabled — respawning it if it died (crash,
/// OOM, external kill, or a failed initial spawn). Without this a dead daemon
/// left sync silently quiet until a manual restart; the only tell was a stale
/// "Last synced N minutes ago". `run_process_impl` deregisters `DAEMON_HANDLE`
/// on exit, and `start_daemon`'s live-pid pre-flight makes a respawn a clean
/// no-op when the daemon is already healthy — so this is safe to poll.
pub fn setup_daemon_supervisor(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(SUPERVISOR_SETTLE);
        loop {
            let daemon_alive = resolve_hq_folder_path()
                .ok()
                .and_then(|p| read_pid_file(&p))
                .map(is_pid_alive)
                .unwrap_or(false);
            if should_respawn_daemon(
                is_realtime_sync_enabled(),
                is_autostart_enabled(),
                daemon_alive,
            ) {
                log(
                    "daemon.supervisor",
                    "watch daemon down but auto-sync is on — respawning",
                );
                match start_daemon(handle.clone()) {
                    Ok(_) => log("daemon.supervisor", "respawned watch daemon"),
                    Err(e) => log("daemon.supervisor", &format!("respawn skipped: {e}")),
                }
            }
            thread::sleep(SUPERVISOR_INTERVAL);
        }
    });
}

/// Stop the sync daemon via SIGTERM (graceful) → SIGKILL (timeout fallback).
///
/// Returns `true` if a stop was initiated. The watcher process owns its own
/// pid-file lifecycle; we don't shell out to a separate stop CLI here.
#[tauri::command]
pub fn stop_daemon() -> Result<bool, String> {
    let hq_folder_path = resolve_hq_folder_path()?;

    // Cancel via the process registry first — this signals the spawned
    // runner from `start_daemon` and cleans up the handle.
    let cancelled = cancel_process_impl(DAEMON_HANDLE, SIGKILL_DELAY);
    if cancelled {
        return Ok(true);
    }

    // Daemon from a previous app session — registry has no handle, but the
    // pid-file may point at a still-alive runner. SIGTERM directly so the
    // user can re-toggle Auto-sync without a process zombie.
    if let Some(pid) = read_pid_file(&hq_folder_path) {
        if is_pid_alive(pid) {
            #[cfg(unix)]
            {
                use nix::sys::signal::{self, Signal};
                use nix::unistd::Pid;
                let _ = signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::CloseHandle;
                use windows::Win32::System::Threading::{
                    OpenProcess, TerminateProcess, PROCESS_TERMINATE,
                };
                unsafe {
                    if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                        let _ = TerminateProcess(handle, 1);
                        let _ = CloseHandle(handle);
                    }
                }
            }
            #[cfg(not(any(unix, target_os = "windows")))]
            {
                let _ = pid;
            }
            return Ok(true);
        }
    }

    Ok(false)
}

/// Get daemon status by reading .hq-sync.pid and .hq-sync-daemon.json.
///
/// Does NOT shell out to `hq` — reads filesystem state directly for speed.
#[tauri::command]
pub fn daemon_status() -> Result<DaemonStatus, String> {
    let hq_folder_path = resolve_hq_folder_path()?;

    // Try .hq-sync-daemon.json first (richer info)
    if let Some(daemon) = read_daemon_json(&hq_folder_path) {
        let pid = daemon.pid.or_else(|| read_pid_file(&hq_folder_path));
        let running = pid.map(is_pid_alive).unwrap_or(false);
        return Ok(DaemonStatus {
            running,
            pid,
            started_at: daemon.started_at,
            watch_path: daemon.watch_path,
            source: "daemon_json".to_string(),
        });
    }

    // Fallback to .hq-sync.pid
    if let Some(pid) = read_pid_file(&hq_folder_path) {
        let running = is_pid_alive(pid);
        return Ok(DaemonStatus {
            running,
            pid: Some(pid),
            started_at: None,
            watch_path: None,
            source: "pid_file".to_string(),
        });
    }

    // No daemon state files found
    Ok(DaemonStatus {
        running: false,
        pid: None,
        started_at: None,
        watch_path: None,
        source: "none".to_string(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Double-start prevention ──────────────────────────────────────────

    #[test]
    fn test_double_register_prevented() {
        use crate::commands::process::{deregister_process, try_register_handle};
        let handle = "test-daemon-double-start";
        // First register succeeds
        assert!(try_register_handle(handle));
        // Second register fails (already registered)
        assert!(!try_register_handle(handle));
        // Cleanup
        deregister_process(handle);
        // After cleanup, register succeeds again
        assert!(try_register_handle(handle));
        deregister_process(handle);
    }

    // ── Constants ────────────────────────────────────────────────────────

    #[test]
    fn test_daemon_handle_constant() {
        assert_eq!(DAEMON_HANDLE, "hq-sync-daemon");
    }

    #[test]
    fn test_sigkill_delay_constant() {
        assert_eq!(SIGKILL_DELAY, Duration::from_secs(5));
    }
}
