//! Feature-flagged daemon lifecycle — V2 prep.
//!
//! Wraps `hq sync start` / `hq sync stop` as Tauri commands.
//! Behind `AUTOSTART_DAEMON` feature flag in ~/.hq/menubar.json (default false).
//! Svelte UI does NOT expose these V1 — invocable only via Tauri devtools.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::commands::process::{
    cancel_process_impl, deregister_process, is_registered, run_process_impl, try_register_handle,
    ProcessEvent,
};
use crate::commands::status::{journal_for_daemon_sync_complete, write_journal};
use crate::commands::sync::RunTotals;
use crate::events::{SyncEvent, EVENT_SYNC_ALL_COMPLETE};
use crate::util::logfile::log;
use crate::util::paths;
use hq_desktop_core::sync_outcome::termination_fingerprint_token;

#[allow(unused_imports)]
pub use hq_desktop_core::daemon::{
    build_watch_runner_args, event_push_eligible, is_autostart_enabled, is_instant_sync_enabled,
    is_pid_alive, is_realtime_sync_enabled, read_daemon_json, read_menubar_bool, read_pid_file,
    resolve_hq_folder_path, should_cancel_stalled_daemon, should_event_push,
    should_force_clear_stalled_start, should_respawn_daemon, DaemonJson, DaemonStatus,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Singleton handle for daemon process.
const DAEMON_HANDLE: &str = "hq-sync-daemon";

/// SIGKILL delay after SIGTERM when stopping daemon.
const SIGKILL_DELAY: Duration = Duration::from_secs(5);

/// A healthy watch daemon emits protocol progress or completion records on
/// every pass. If no record arrives for this interval, terminate the process so
/// the existing supervisor can restart it instead of leaving its operation lock
/// wedged indefinitely.
const DAEMON_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DAEMON_HEARTBEAT_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// How long the singleton "starting" guard may be held with no live daemon
/// before the supervisor treats it as wedged and force-clears it. A healthy
/// start writes its PID within seconds, so this is comfortably longer than any
/// legitimate spawn + preflight yet far shorter than the multi-hour deadlock the
/// old unbounded guard produced (HQ-DESKTOP: respawn stuck on "Daemon is already
/// starting"). Recovery lands within one guard deadline instead of never.
const DAEMON_START_DEADLINE: Duration = Duration::from_secs(2 * 60);

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
) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let event: SyncEvent = match serde_json::from_str(trimmed) {
        Ok(e) => e,
        Err(_) => return false,
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
        let journal = journal_for_daemon_sync_complete(&now_iso, conflicts);
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
    true
}

fn start_daemon_heartbeat_watchdog(last_heartbeat: Arc<Mutex<Instant>>, finished: Arc<AtomicBool>) {
    thread::spawn(move || loop {
        thread::sleep(DAEMON_HEARTBEAT_CHECK_INTERVAL);
        if finished.load(Ordering::Acquire) {
            return;
        }
        let heartbeat_age = last_heartbeat
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .elapsed();
        if should_cancel_stalled_daemon(
            is_registered(DAEMON_HANDLE),
            heartbeat_age,
            DAEMON_HEARTBEAT_TIMEOUT,
        ) {
            log(
                "daemon.watchdog",
                &format!(
                    "no sync protocol heartbeat for {}s; cancelling stalled watch daemon",
                    heartbeat_age.as_secs()
                ),
            );
            cancel_process_impl(DAEMON_HANDLE, SIGKILL_DELAY);
            return;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start-guard deadline (respawn-deadlock backstop)
// ─────────────────────────────────────────────────────────────────────────────
//
// `start_daemon` takes the `DAEMON_HANDLE` singleton before doing anything, and
// only releases it when the start fails a preflight or the watcher process
// exits. If the watcher instead *wedges* (hung on an untimed network read, then
// cancelled by the watchdog but never reaped so `run_process_impl` never returns
// to deregister), the guard is held with no live daemon and the supervisor's
// respawn is refused with "Daemon is already starting" on every tick — forever.
//
// The guard carries a stamp so the supervisor can tell a legitimately in-flight
// start from a wedged one and force-clear only the latter. Two properties make
// that decision safe rather than destructive:
//
//   * The stamp is *refreshed* every tick the daemon is confirmed live, so
//     `daemon_guard_age` measures how long the daemon has been observed **down**,
//     not the uptime of a healthy generation. A single transient liveness misread
//     (a pid-file rewrite, or `kill(pid,0)` reporting an EPERM process as dead)
//     therefore cannot age a long-lived healthy daemon past the deadline — it
//     takes a sustained ~deadline of consecutive down observations. And the
//     force-clear re-probes liveness one more time immediately before the
//     destructive kill, aborting (and leaving a breadcrumb) if the daemon is
//     actually alive.
//   * Each acquisition carries a monotonic **generation** id and may only clear
//     its own stamp. That closes the deregister→clear gap where an exiting start
//     could otherwise wipe a newer respawn's fresh stamp and silently reopen the
//     very deadlock this backstop exists to break.

static DAEMON_GUARD_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct DaemonGuardStamp {
    /// Which start acquisition owns this stamp; only that generation may clear it.
    generation: u64,
    /// When the guard was acquired, or when the daemon was last confirmed live —
    /// a live confirmation refreshes this so the wedge deadline only ever measures
    /// time the daemon has been observed *down*, never a healthy generation's age.
    since: Instant,
}

static DAEMON_GUARD: OnceLock<Mutex<Option<DaemonGuardStamp>>> = OnceLock::new();

fn daemon_guard() -> &'static Mutex<Option<DaemonGuardStamp>> {
    DAEMON_GUARD.get_or_init(|| Mutex::new(None))
}

/// Stamp a new start acquiring the singleton guard. Returns the generation id so
/// the owning start thread can later clear *only its own* stamp.
fn mark_daemon_guard_acquired() -> u64 {
    let generation = DAEMON_GUARD_GEN
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    *daemon_guard().lock().unwrap_or_else(|p| p.into_inner()) = Some(DaemonGuardStamp {
        generation,
        since: Instant::now(),
    });
    generation
}

/// Refresh the stamp when the daemon is confirmed live, so the wedge deadline
/// only ever measures time the daemon has been observed *down*. Never *creates* a
/// stamp — a daemon we didn't start holds no guard to wedge — it only refreshes
/// an existing one, preserving its generation.
fn note_daemon_guard_alive() {
    if let Some(stamp) = daemon_guard()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
    {
        stamp.since = Instant::now();
    }
}

/// Clear the stamp unconditionally (the guard is being force-released).
fn clear_daemon_guard_stamp() {
    *daemon_guard().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Clear the stamp iff it still belongs to `generation`. Used by the owning start
/// thread on exit: `run_process_impl` has already deregistered the handle, so a
/// respawn may have re-acquired it and stamped a *newer* generation — clearing
/// only our own generation guarantees we never wipe that fresh stamp.
fn clear_daemon_guard_stamp_for(generation: u64) {
    let mut guard = daemon_guard().lock().unwrap_or_else(|p| p.into_inner());
    if guard.map(|s| s.generation) == Some(generation) {
        *guard = None;
    }
}

/// How long the singleton guard has been held with no live daemon — time since
/// acquisition or the last live confirmation, whichever is later.
fn daemon_guard_age() -> Option<Duration> {
    daemon_guard()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .map(|s| s.since.elapsed())
}

/// Best-effort liveness re-probe used right before the destructive force-clear.
/// Mirrors the supervisor's own `daemon_alive` computation (pid file → process
/// check) so a force-clear can bail if a liveness *flake* made the supervisor
/// briefly believe a healthy daemon was down.
fn daemon_appears_alive() -> bool {
    resolve_hq_folder_path()
        .ok()
        .and_then(|p| read_pid_file(&p))
        .map(is_pid_alive)
        .unwrap_or(false)
}

/// Release the guard on a failed start: clear the stamp, then deregister so the
/// next start can acquire it. Paired with every `start_daemon` preflight bail
/// (all synchronous, before the spawn thread — no other start can hold the
/// handle yet, so the unconditional clear is safe).
fn release_daemon_guard() {
    clear_daemon_guard_stamp();
    deregister_process(DAEMON_HANDLE);
}

/// Force-clear a guard the supervisor has judged wedged: terminate any lingering
/// (hung) watcher process still tracked under the handle, then release the guard
/// so the immediate respawn can proceed. Terminating first means the stale child
/// is reaped rather than orphaned — on Windows this closes the KILL_ON_JOB_CLOSE
/// job (killing the tree); on Unix it SIGTERM/SIGKILLs the process group.
fn force_clear_daemon_guard() {
    force_clear_daemon_guard_impl(daemon_appears_alive())
}

/// Force-clear with the liveness re-probe result injected, so the abort/kill
/// decision is unit-testable without a real pid file.
fn force_clear_daemon_guard_impl(daemon_alive_recheck: bool) {
    if daemon_alive_recheck {
        // The supervisor thought the daemon was down, but it is alive on
        // re-check — the "down" reading was a liveness flake. Aborting here is
        // what keeps a single flake non-destructive: `cancel_process_impl` sets
        // `is_cancelled`, so a mistaken force-kill would be logged by the Exit
        // handler as a *deliberate stop* (no crash capture) and be invisible.
        // Emit a distinct breadcrumb so the near-miss is observable instead.
        log(
            "daemon.supervisor",
            "force-clear aborted: watch daemon is alive on re-check — liveness flake suspected",
        );
        sentry::add_breadcrumb(sentry::Breadcrumb {
            category: Some("daemon.supervisor".into()),
            level: sentry::Level::Warning,
            message: Some(
                "force-clear aborted: live watcher on re-check (liveness flake suspected)".into(),
            ),
            ..Default::default()
        });
        // Count the confirmed-live probe as a heartbeat for the wedge deadline so
        // we don't immediately re-attempt the force-clear on the next tick.
        note_daemon_guard_alive();
        return;
    }
    // Genuinely down. Leave a distinct breadcrumb so even a residual mistaken
    // kill (a double-flake past this re-probe) is attributable to a force-clear
    // rather than indistinguishable from a normal deliberate stop.
    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some("daemon.supervisor".into()),
        level: sentry::Level::Info,
        message: Some("force-clearing wedged start guard (no live daemon on re-check)".into()),
        ..Default::default()
    });
    cancel_process_impl(DAEMON_HANDLE, SIGKILL_DELAY);
    release_daemon_guard();
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
    // Stamp the guard acquisition so the supervisor can bound how long a start
    // may hold it with no live daemon before treating it as wedged. The
    // generation lets this start's exit clear only its own stamp, never a
    // respawn's fresher one.
    let guard_generation = mark_daemon_guard_acquired();

    // A signed-out watcher can only emit auth-error and exit 0. Refuse that
    // known-dead loop up front; after a terminal auth event clears the token,
    // the supervisor will keep sync peacefully paused until reauth succeeds.
    match crate::commands::cognito::read_tokens_from_file() {
        Ok(Some(_)) => {}
        Ok(None) => {
            release_daemon_guard();
            return Err(crate::commands::cognito::REAUTH_MESSAGE.to_string());
        }
        Err(err) => {
            release_daemon_guard();
            return Err(err);
        }
    }

    let hq_folder_path = match resolve_hq_folder_path() {
        Ok(p) => p,
        Err(e) => {
            release_daemon_guard();
            return Err(e);
        }
    };

    // Pre-flight: check if daemon is already running from a previous session
    if let Some(pid) = read_pid_file(&hq_folder_path) {
        if is_pid_alive(pid) {
            release_daemon_guard();
            return Err(format!("Daemon is already running (PID {})", pid));
        }
    }

    // Runner-resolution preflight (HQ-DESKTOP-37 / HQ-DESKTOP-2R): bail before
    // spawning a watcher that can only exit 127 and get hot-respawned by the
    // supervisor. A missing Node/npm interpreter is an expected machine setup
    // gap, not an application failure: return the install guidance to the UI
    // and retain a local diagnostic, but do not send an error event to Sentry.
    if let Some(msg) = crate::commands::sync::preflight_runner_unresolvable() {
        match runner_preflight_capture_policy() {
            RunnerPreflightCapturePolicy::LocalLogOnly => log(
                "daemon",
                &format!("runner unresolvable — local-only preflight: {msg}"),
            ),
        }
        release_daemon_guard();
        return Err(msg);
    }

    // The startup prewarm and the first watch spawn can overlap. Complete the
    // same bounded, locked materialization preflight used by Sync Now before
    // starting the long-lived runner. This is deliberately local-log/UI
    // diagnosis only: an npx cache/permission failure is environmental, while
    // an unexplained later runner exit remains alertable below.
    if let Err(msg) = hq_desktop_core::prewarm::materialize_hq_cloud_cache() {
        log("daemon", &format!("npx cache materialization preflight failed: {msg}"));
        note_environment_preflight_failure();
        release_daemon_guard();
        return Err(msg);
    }

    let spawn_args = build_watch_runner_args(&hq_folder_path);

    log("daemon", "spawn: hq-sync-runner --watch");
    // Stamp the spawn so the Exit handler can tell a fast crash-loop failure
    // from a watcher that ran healthily and then died (HQ-SYNC-4).
    note_watcher_spawned();

    // Per-pass totals. Watch mode emits a full Complete/AllComplete cycle on
    // every chokidar tick + every 15-second poll, so we reset on each
    // AllComplete instead of accumulating forever.
    let totals: Arc<Mutex<RunTotals>> = Arc::new(Mutex::new(RunTotals::default()));
    let hq_folder = hq_folder_path.clone();
    let last_heartbeat = Arc::new(Mutex::new(Instant::now()));
    let daemon_finished = Arc::new(AtomicBool::new(false));
    start_daemon_heartbeat_watchdog(last_heartbeat.clone(), daemon_finished.clone());

    thread::spawn(move || {
        let process_heartbeat = last_heartbeat.clone();
        let process_finished = daemon_finished.clone();
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
                    if handle_watch_stdout_line(&app, &hq_folder, &totals, &line) {
                        *process_heartbeat
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
                    }
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
                    crate::commands::sync::handle_runner_stderr_line(&app, &totals, &line);
                }
                ProcessEvent::Exit {
                    code,
                    signal,
                    success,
                } => {
                    // Mark this generation complete before the process helper
                    // deregisters its shared handle. That prevents this
                    // generation's watchdog from ever cancelling a newly
                    // registered replacement during the restart handoff.
                    process_finished.store(true, Ordering::Release);
                    log(
                        "daemon",
                        &format!(
                            "exited: code={:?} signal={:?} success={}",
                            code, signal, success
                        ),
                    );
                    // Auto-sync runs unattended, so a crashed watcher was
                    // previously invisible (log-only). Capture genuine crashes
                    // to #hq-alerts — but NOT a deliberate stop (a bare SIGTERM
                    // from cancel_process_impl on app-quit / auto-sync-off /
                    // re-spawn), and rate-limit a crash-loop to ~log2(N) events
                    // instead of one per 30s respawn (HQ-SYNC-4 / HQ-SYNC-5).
                    let cancelled = crate::commands::process::is_cancelled(DAEMON_HANDLE);
                    if is_unexpected_watcher_exit(success, signal, cancelled) {
                        let consecutive = note_watcher_crashed();
                        if is_benign_watcher_exit(code, signal) {
                            log(
                                "daemon",
                                &format!(
                                    "benign watcher exit #{consecutive} — capture skipped \
                                     (code={:?} signal={:?})",
                                    code, signal
                                ),
                            );
                            sentry::add_breadcrumb(sentry::Breadcrumb {
                                category: Some("daemon.exit".into()),
                                level: sentry::Level::Info,
                                message: Some(format!(
                                    "benign auto-sync watcher exit #{consecutive}: \
                                     code={:?} signal={:?}",
                                    code, signal
                                )),
                                ..Default::default()
                            });
                        } else if should_capture_crash(consecutive) {
                            let (uptime, rss_kb, rss_age) = watcher_exit_diagnostics();
                            let diag = exit_diagnostic_suffix(uptime, rss_kb, rss_age);
                            let fingerprint_token = termination_fingerprint_token(code, signal);
                            let fingerprint =
                                ["sync", "auto-sync-watcher-termination", fingerprint_token.as_str()];
                            crate::commands::sync::capture_sync_error_with_fingerprint(
                                None,
                                "(auto-sync)",
                                &format!(
                                    "auto-sync watcher exited unexpectedly (code={:?} signal={:?}), \
                                     consecutive failure #{consecutive}{diag}",
                                    code, signal
                                ),
                                &fingerprint,
                            );
                        } else {
                            log(
                                "daemon",
                                &format!(
                                    "watcher crash #{consecutive} — capture rate-limited \
                                     (code={:?} signal={:?})",
                                    code, signal
                                ),
                            );
                        }
                    }
                }
            }
        });

        daemon_finished.store(true, Ordering::Release);
        // `run_process_impl` has returned, so it already deregistered the
        // handle: the guard is released. Drop the acquisition stamp too, so the
        // supervisor's wedge deadline only ever measures a genuinely in-flight
        // start (a hung watcher that never gets here is what the deadline is for).
        // Generation-scoped: between the deregister above and this clear a
        // supervisor respawn can already have re-acquired the freed handle and
        // stamped a *newer* generation — clearing only our own generation
        // guarantees we never wipe that fresh stamp (which would reopen the
        // deadlock for the new start if it wedged).
        clear_daemon_guard_stamp_for(guard_generation);

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

// ─────────────────────────────────────────────────────────────────────────────
// Crash-vs-teardown decision + crash-loop dampening (HQ-SYNC-4 / HQ-SYNC-5)
// ─────────────────────────────────────────────────────────────────────────────
//
// A watcher that keeps failing (the runner can't upload, or its exec target
// isn't runnable: exit 1/2/126) was respawned by the supervisor every
// SUPERVISOR_INTERVAL (30s) AND Sentry-captured on EVERY exit — turning one
// per-machine failure into a fleet-wide event flood plus an endless hot-respawn.
// We dampen BOTH legs without hiding the signal: the first crash still alerts,
// respawns back off exponentially, and the capture is rate-limited to ~log2(N)
// events. A bare SIGTERM (deliberate stop) is never treated as a crash.

/// SIGTERM that the watcher receives on a deliberate stop. Named so the
/// crash-vs-teardown decision reads intentionally.
const SIGTERM: i32 = 15;

const SIGABRT: i32 = 6;
const SIGBUS_LINUX: i32 = 7;
const SIGBUS_MACOS: i32 = 10;
const SIGILL: i32 = 4;
const SIGKILL: i32 = 9;
const SIGSEGV: i32 = 11;

/// Pure decision: should this watcher exit be Sentry-captured as an unexpected
/// crash? A genuine crash is a non-zero `exit(code)` or a fault signal
/// (SIGSEGV/SIGABRT/SIGBUS = real bug, SIGKILL = OOM/`kill -9`). A bare
/// **SIGTERM is never a crash** — it is the canonical "please stop" request from
/// our own `cancel_process_impl`, the app-quit teardown, or the OS on
/// logout/shutdown. Capturing it flooded #hq-alerts (HQ-SYNC-5). `cancelled`
/// (from the process registry) is the primary guard for our own stops; the
/// explicit `signal != SIGTERM` check is defense in depth for external SIGTERMs
/// and the narrow deregister-before-Exit race.
fn is_unexpected_watcher_exit(success: bool, signal: Option<i32>, cancelled: bool) -> bool {
    if success || cancelled {
        return false;
    }
    signal != Some(SIGTERM)
}

/// Pure signal classifier for fault-style terminations that must still alert.
fn is_fault_signal(signal: Option<i32>) -> bool {
    matches!(
        signal,
        Some(SIGABRT | SIGBUS_LINUX | SIGBUS_MACOS | SIGILL | SIGKILL | SIGSEGV)
    )
}

/// Pure classifier for runner exits that are environmental and not actionable
/// Sentry crashes: denied/not-provisioned/transient/ACL-scope skips surface as
/// code 1/2 with no signal.
fn is_benign_watcher_exit(code: Option<i32>, signal: Option<i32>) -> bool {
    matches!(code, Some(1 | 2)) && signal.is_none() && !is_fault_signal(signal)
}

/// Capture policy for a preflight which positively established that the Node
/// runner cannot resolve. This is an expected environment/setup gap; the UI
/// receives install guidance and the daemon logs it locally, but it must never
/// create an error-level Sentry event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunnerPreflightCapturePolicy {
    LocalLogOnly,
}

fn runner_preflight_capture_policy() -> RunnerPreflightCapturePolicy {
    RunnerPreflightCapturePolicy::LocalLogOnly
}

/// A non-zero exit this soon after spawn is a crash-loop failure — distinct from
/// a watcher that ran healthily for a while and then died.
const FAST_FAIL_WINDOW: Duration = Duration::from_secs(60);

/// Ceiling for the respawn backoff (a persistently-failing watcher backs off to
/// at most this between respawns instead of the 30s supervisor cadence).
const RESPAWN_MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);

/// Exponential respawn backoff after `consecutive` consecutive fast failures.
/// `0` → the base supervisor cadence; then ×2 per failure, capped at `cap`.
fn respawn_backoff(consecutive: u32, base: Duration, cap: Duration) -> Duration {
    if consecutive == 0 {
        return base;
    }
    // Cap the shift so the multiply can't overflow before the `.min(cap)`.
    let mult = 1u64.checked_shl(consecutive.min(32)).unwrap_or(u64::MAX);
    let secs = base.as_secs().saturating_mul(mult).min(cap.as_secs());
    Duration::from_secs(secs)
}

/// Whether to Sentry-capture this crash. Capture the 1st and then only at
/// exponential milestones (1, 2, 4, 8, 16, …) so a crash-loop ships ~log2(N)
/// actionable events instead of one-per-respawn.
fn should_capture_crash(consecutive: u32) -> bool {
    consecutive <= 1 || consecutive.is_power_of_two()
}

/// A non-zero exit `run` after spawn — is it a fast (crash-loop) failure?
fn is_fast_failure(run: Duration, window: Duration) -> bool {
    run < window
}

/// Pure decision: has a live watcher survived long enough to clear the
/// crash-loop state? Extracted so it is unit-testable without `Instant`.
fn should_reset_after_recovery(spawn_elapsed: Option<Duration>, window: Duration) -> bool {
    spawn_elapsed.map(|e| e >= window).unwrap_or(false)
}

/// Shared crash-loop state across the spawn (`start_daemon`), the watcher Exit
/// handler, and the supervisor.
#[derive(Default)]
struct WatcherCrashState {
    /// Consecutive fast failures (crash-loop length). Reset once a watcher
    /// survives `FAST_FAIL_WINDOW`.
    consecutive: u32,
    /// When the current watcher was spawned — drives the fast-failure decision
    /// and the "survived long enough to reset" check.
    spawn_at: Option<Instant>,
    /// The supervisor must not respawn before this instant (backoff window).
    backoff_until: Option<Instant>,
    /// Last RSS (KB) sampled from the live watcher, and when — enriches an
    /// unexpected-exit capture so a `signal=9` (jetsam/OOM vs manual kill) can be
    /// told apart after the fact. Best-effort; never changes whether a crash is
    /// captured. Cleared on each fresh spawn.
    last_rss_kb: Option<u64>,
    last_rss_at: Option<Instant>,
}

static CRASH_STATE: OnceLock<Mutex<WatcherCrashState>> = OnceLock::new();

fn crash_state() -> &'static Mutex<WatcherCrashState> {
    CRASH_STATE.get_or_init(|| Mutex::new(WatcherCrashState::default()))
}

/// Record that a watcher was just spawned (called from `start_daemon`).
fn note_watcher_spawned() {
    let mut st = crash_state().lock().unwrap();
    st.spawn_at = Some(Instant::now());
    // Fresh watcher — drop the previous watcher's RSS sample so a crash capture
    // never reports a stale footprint from a process that already died.
    st.last_rss_kb = None;
    st.last_rss_at = None;
}

/// Update the crash-loop state on an unexpected watcher exit and return the
/// consecutive-failure count so the caller can decide whether to capture.
fn note_watcher_crashed() -> u32 {
    let mut st = crash_state().lock().unwrap();
    let ran = st.spawn_at.map(|t| t.elapsed()).unwrap_or(Duration::ZERO);
    if is_fast_failure(ran, FAST_FAIL_WINDOW) {
        st.consecutive = st.consecutive.saturating_add(1);
    } else {
        // Ran healthily, then died — not a tight loop. Treat as a fresh first
        // failure: reset to 1 so it is captured and backs off lightly.
        st.consecutive = 1;
    }
    let consecutive = st.consecutive;
    st.backoff_until = Some(
        Instant::now() + respawn_backoff(consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF),
    );
    consecutive
}

/// Apply the same exponential retry dampening when a preflight positively
/// identifies a local npm/cache setup failure. No watcher was spawned, so it
/// must not create a Sentry event; the backoff merely prevents the supervisor
/// from retrying the same user-actionable diagnosis every 30 seconds.
fn note_environment_preflight_failure() {
    let mut st = crash_state().lock().unwrap();
    st.consecutive = st.consecutive.saturating_add(1);
    st.backoff_until = Some(
        Instant::now() + respawn_backoff(st.consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF),
    );
}

/// Record the latest RSS (KB) sampled from the live watcher (supervisor tick).
fn note_watcher_rss(kb: u64) {
    let mut st = crash_state().lock().unwrap();
    st.last_rss_kb = Some(kb);
    st.last_rss_at = Some(Instant::now());
}

/// Snapshot for enriching a crash capture: watcher uptime (since spawn), the
/// last RSS sample, and how long before now that sample was taken.
fn watcher_exit_diagnostics() -> (Option<Duration>, Option<u64>, Option<Duration>) {
    let st = crash_state().lock().unwrap();
    let uptime = st.spawn_at.map(|t| t.elapsed());
    let rss_age = st.last_rss_at.map(|t| t.elapsed());
    (uptime, st.last_rss_kb, rss_age)
}

/// Supervisor helper: is the watcher still inside its respawn-backoff window?
fn within_respawn_backoff() -> bool {
    let st = crash_state().lock().unwrap();
    st.backoff_until
        .map(|until| Instant::now() < until)
        .unwrap_or(false)
}

/// Supervisor helper: once a respawned watcher has survived `FAST_FAIL_WINDOW`,
/// clear the crash-loop state so backoff + capture rate-limiting reset for the
/// next failure episode.
fn reset_crash_state_if_recovered() {
    let mut st = crash_state().lock().unwrap();
    if should_reset_after_recovery(st.spawn_at.map(|t| t.elapsed()), FAST_FAIL_WINDOW) {
        st.consecutive = 0;
        st.backoff_until = None;
    }
}

/// Best-effort RSS (KB) of `pid` via `ps -o rss= -p <pid>`. Both macOS and Linux
/// report RSS here in 1-KB units. Returns `None` on any failure. Diagnostic only.
fn sample_pid_rss_kb(pid: u32) -> Option<u64> {
    let mut cmd = std::process::Command::new("ps");
    paths::no_window(&mut cmd);
    let out = cmd
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_rss_kb(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `ps -o rss=` output (RSS in KB, whitespace-padded, headerless) into KB.
fn parse_ps_rss_kb(out: &str) -> Option<u64> {
    out.trim().lines().next()?.trim().parse::<u64>().ok()
}

/// Human-readable RSS from KB (e.g. `182MB`, `1.4GB`).
fn format_rss_kb(kb: u64) -> String {
    if kb >= 1024 * 1024 {
        format!("{:.1}GB", kb as f64 / (1024.0 * 1024.0))
    } else if kb >= 1024 {
        format!("{}MB", kb / 1024)
    } else {
        format!("{kb}KB")
    }
}

/// Compact `Ns` / `Nm Ns` / `Nh Nm` duration formatter for diagnostics.
fn format_duration_secs(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else {
        format!("{}h{}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// Build the ` [uptime=…; last_rss=…]` suffix appended to an unexpected-exit
/// capture. Omits unknown pieces; returns `""` when nothing is known.
fn exit_diagnostic_suffix(
    uptime: Option<Duration>,
    rss_kb: Option<u64>,
    rss_age: Option<Duration>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(u) = uptime {
        parts.push(format!("uptime={}", format_duration_secs(u.as_secs())));
    }
    match (rss_kb, rss_age) {
        (Some(kb), Some(age)) => parts.push(format!(
            "last_rss={} (sampled {} before exit)",
            format_rss_kb(kb),
            format_duration_secs(age.as_secs())
        )),
        (Some(kb), None) => parts.push(format!("last_rss={}", format_rss_kb(kb))),
        _ => parts.push("last_rss=unsampled".to_string()),
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" [{}]", parts.join("; "))
    }
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
            let watcher_pid = resolve_hq_folder_path()
                .ok()
                .and_then(|p| read_pid_file(&p));
            let daemon_alive = watcher_pid.map(is_pid_alive).unwrap_or(false);
            if daemon_alive {
                // Once the watcher has survived the fast-fail window, clear the
                // crash-loop state so backoff + capture rate-limiting reset for
                // the next failure episode (HQ-SYNC-4).
                reset_crash_state_if_recovered();
                // Refresh the start-guard stamp against this confirmed-live
                // observation so the wedge deadline measures observed-*down*
                // time, not a healthy generation's uptime. Without this a
                // long-lived daemon's stamp is always past the deadline, and a
                // single transient liveness misread on a later tick would
                // force-clear (SIGKILL) a healthy watcher.
                note_daemon_guard_alive();
                // Sample the live watcher's RSS so if it is later killed by
                // signal=9, the crash capture can report the footprint it had
                // shortly before death (jetsam/OOM vs kill -9). Best-effort.
                if let Some(pid) = watcher_pid {
                    if let Some(kb) = sample_pid_rss_kb(pid) {
                        note_watcher_rss(kb);
                    }
                }
            } else if should_respawn_daemon(
                is_realtime_sync_enabled(),
                is_autostart_enabled(),
                daemon_alive,
            ) {
                // Crash-loop dampening: hold off respawning a watcher that just
                // crashed until its exponential backoff elapses, instead of
                // hot-respawning every 30s (HQ-SYNC-4).
                if within_respawn_backoff() {
                    log(
                        "daemon.supervisor",
                        "watch daemon down but within crash-loop backoff — holding off respawn",
                    );
                } else {
                    log(
                        "daemon.supervisor",
                        "watch daemon down but auto-sync is on — respawning",
                    );
                    match start_daemon(handle.clone()) {
                        Ok(_) => log("daemon.supervisor", "respawned watch daemon"),
                        Err(e) => {
                            log("daemon.supervisor", &format!("respawn skipped: {e}"));
                            // The classic deadlock: `start_daemon` refused with
                            // "Daemon is already starting" because a prior start
                            // still holds the singleton guard, yet no daemon is
                            // alive. If that guard has been held past the start
                            // deadline it is wedged (a hung, un-reaped watcher),
                            // and every future tick would loop on the same skip
                            // forever. Force-clear the stale guard so the NEXT
                            // tick's normal respawn can proceed. We deliberately
                            // don't respawn inline here: `force_clear_daemon_guard`
                            // may have just scheduled an async SIGKILL/deregister
                            // of the old watcher (Unix `cancel_process_impl`), and
                            // a same-tick re-register could be torn down by it.
                            // The next tick (≤30s) is well clear of that window.
                            if should_force_clear_stalled_start(
                                daemon_alive,
                                daemon_guard_age(),
                                DAEMON_START_DEADLINE,
                            ) {
                                log(
                                    "daemon.supervisor",
                                    "start guard wedged past deadline — force-clearing; respawn on next tick",
                                );
                                force_clear_daemon_guard();
                            }
                        }
                    }
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

    // ── Respawn-deadlock recovery (start-guard wedge) ────────────────────
    //
    // Regression for the supervisor crash-loop: a start that acquired the
    // singleton guard but whose watcher wedged (hung network read, cancelled
    // by the watchdog but never reaped) held the guard forever, so every
    // supervisor tick logged "respawn skipped: Daemon is already starting" and
    // sync never recovered (observed 7.5+ hours). These tests exercise the real
    // process registry + guard stamp on `DAEMON_HANDLE`, so serialize them.
    static GUARD_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn wedged_start_guard_is_cleared_so_respawn_proceeds() {
        use crate::commands::process::{deregister_process, try_register_handle};
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // A prior start took the guard and stamped its acquisition…
        assert!(try_register_handle(DAEMON_HANDLE));
        mark_daemon_guard_acquired();

        // …then wedged. The supervisor's respawn calls `start_daemon`, whose
        // `try_register_handle` is refused — this IS the "Daemon is already
        // starting" skip, with no live daemon behind it.
        assert!(
            !try_register_handle(DAEMON_HANDLE),
            "guard still held → respawn refused (already starting)"
        );
        assert!(
            daemon_guard_age().is_some(),
            "a start is recorded in flight"
        );

        // A guard that JUST acquired the lock must not be force-cleared — it is
        // a legitimately in-flight start, not a wedge.
        assert!(
            !should_force_clear_stalled_start(false, daemon_guard_age(), DAEMON_START_DEADLINE),
            "a fresh start must not be force-cleared"
        );

        // Once the deadline has elapsed with no live daemon, the guard is wedged.
        // (The time-based decision itself is unit-tested with explicit ages in
        // hq_desktop_core::daemon.) The supervisor then force-clears it — the
        // liveness re-probe reports no live daemon (injected here for
        // determinism), so it proceeds…
        force_clear_daemon_guard_impl(false);

        // …which releases both the stamp and the registry handle, so the very
        // next respawn succeeds instead of looping on "already starting".
        assert!(daemon_guard_age().is_none(), "stamp cleared on force-clear");
        assert!(
            try_register_handle(DAEMON_HANDLE),
            "respawn proceeds after the wedged guard is cleared"
        );

        // Cleanup.
        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
    }

    #[test]
    fn failed_start_releases_guard_immediately() {
        use crate::commands::process::{deregister_process, try_register_handle};
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // Simulate a start that acquired the guard then bailed a preflight.
        assert!(try_register_handle(DAEMON_HANDLE));
        mark_daemon_guard_acquired();
        assert!(daemon_guard_age().is_some());

        // The preflight-bail path releases the guard on the spot — no deadline,
        // no wedge — so the next start is free to proceed.
        release_daemon_guard();
        assert!(daemon_guard_age().is_none());
        assert!(try_register_handle(DAEMON_HANDLE));

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
    }

    // Major review finding: the acquisition stamp used to live for the daemon's
    // whole healthy lifetime, so `daemon_guard_age()` was permanently past the
    // deadline and a single transient liveness misread would force-clear (SIGKILL)
    // a healthy long-lived daemon. Refreshing the stamp on every confirmed-live
    // tick makes the deadline measure observed-*down* time, so one flake can't
    // reach it.
    #[test]
    fn live_confirmation_refreshes_stamp_so_a_single_flake_is_not_force_cleared() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // A start acquired the guard some time ago and the daemon went live.
        mark_daemon_guard_acquired();
        // Each live supervisor tick refreshes the stamp against "now"…
        note_daemon_guard_alive();

        // …so the guard age is the observed-down time (≈0 right after a live
        // confirmation), well under the deadline — even though the *acquisition*
        // may have been hours ago on a real long-lived daemon.
        let age = daemon_guard_age().expect("stamp present while a start is tracked");
        assert!(
            age < DAEMON_START_DEADLINE,
            "a freshly-confirmed-live stamp must be far under the wedge deadline"
        );

        // Therefore a single tick that misreads the daemon as down (daemon_alive
        // == false) does NOT force-clear it: the refreshed age is nowhere near
        // the deadline. This is the exact false-positive the review flagged.
        assert!(
            !should_force_clear_stalled_start(false, daemon_guard_age(), DAEMON_START_DEADLINE),
            "one liveness flake after a live confirmation must never force-clear a healthy daemon"
        );

        clear_daemon_guard_stamp();
    }

    // `note_daemon_guard_alive` must never *create* a stamp — a daemon we didn't
    // start (previous app session; handle not held here) holds no guard to wedge,
    // so it must not manufacture a wedge deadline for one.
    #[test]
    fn live_confirmation_does_not_create_a_stamp_when_none_is_held() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        assert!(daemon_guard_age().is_none());
        note_daemon_guard_alive();
        assert!(
            daemon_guard_age().is_none(),
            "no stamp is fabricated for a daemon this process never started"
        );
    }

    // Major/minor review finding: the destructive force-clear now re-probes
    // liveness and aborts if the daemon is actually alive, so a liveness flake at
    // the supervisor tick can never SIGKILL a healthy watcher — and the near-miss
    // is surfaced rather than silent.
    #[test]
    fn force_clear_aborts_and_preserves_guard_when_daemon_is_alive_on_recheck() {
        use crate::commands::process::{deregister_process, try_register_handle};
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        assert!(try_register_handle(DAEMON_HANDLE));
        mark_daemon_guard_acquired();

        // The supervisor thought the daemon was down, but the re-probe says it is
        // alive (a flake). Force-clear must abort: the guard stamp and the
        // registry handle both survive, so the live watcher is neither killed nor
        // deregistered.
        force_clear_daemon_guard_impl(true);
        assert!(
            daemon_guard_age().is_some(),
            "aborted force-clear must keep the stamp"
        );
        assert!(
            !try_register_handle(DAEMON_HANDLE),
            "aborted force-clear must keep the handle registered (watcher untouched)"
        );

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
    }

    // Minor review finding: the deregister→clear gap. An exiting start generation
    // must clear ONLY its own stamp, so it can never wipe a newer respawn's fresh
    // stamp (which would silently reopen the deadlock for that new start).
    #[test]
    fn exiting_generation_clear_does_not_clobber_a_newer_generations_stamp() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // Generation 1 acquires the guard, then its watcher exits.
        let gen1 = mark_daemon_guard_acquired();
        // In the gap between gen1 deregistering the handle and clearing its stamp,
        // a supervisor respawn re-acquires the freed handle and stamps gen2.
        let gen2 = mark_daemon_guard_acquired();
        assert_ne!(gen1, gen2, "each acquisition gets a fresh generation");

        // gen1's late, generation-scoped clear must be a no-op — gen2 owns the
        // stamp now.
        clear_daemon_guard_stamp_for(gen1);
        assert!(
            daemon_guard_age().is_some(),
            "gen2's fresh stamp must survive gen1's stale clear (no reopened deadlock)"
        );

        // gen2's own clear still works.
        clear_daemon_guard_stamp_for(gen2);
        assert!(daemon_guard_age().is_none());
    }

    // ── Constants ────────────────────────────────────────────────────────

    #[test]
    fn test_daemon_handle_constant() {
        assert_eq!(DAEMON_HANDLE, "hq-sync-daemon");
    }

    #[test]
    fn test_daemon_start_deadline_constant() {
        // Far longer than any real spawn+preflight, far shorter than the
        // multi-hour deadlock the unbounded guard produced.
        assert_eq!(DAEMON_START_DEADLINE, Duration::from_secs(2 * 60));
    }

    #[test]
    fn test_sigkill_delay_constant() {
        assert_eq!(SIGKILL_DELAY, Duration::from_secs(5));
    }

    // ── Crash-vs-teardown decision (HQ-SYNC-5) ───────────────────────────

    #[test]
    fn success_or_cancelled_exit_is_never_a_crash() {
        assert!(!is_unexpected_watcher_exit(true, None, false));
        assert!(!is_unexpected_watcher_exit(true, Some(9), false));
        assert!(!is_unexpected_watcher_exit(false, Some(11), true)); // cancelled
    }

    #[test]
    fn bare_sigterm_is_teardown_not_crash_but_other_signals_are() {
        // The HQ-SYNC-5 false-positive: signal=15 on app-quit must NOT capture.
        assert!(!is_unexpected_watcher_exit(false, Some(SIGTERM), false));
        // Fault/OOM signals and non-zero code ARE crashes.
        assert!(is_unexpected_watcher_exit(false, Some(SIGKILL), false)); // OOM/kill -9
        assert!(is_unexpected_watcher_exit(false, Some(SIGSEGV), false));
        assert!(is_unexpected_watcher_exit(false, None, false)); // exit(code)
    }

    #[test]
    fn fault_signal_classifier_covers_crash_signals_only() {
        for signal in [
            SIGABRT,
            SIGBUS_LINUX,
            SIGBUS_MACOS,
            SIGILL,
            SIGKILL,
            SIGSEGV,
        ] {
            assert!(
                is_fault_signal(Some(signal)),
                "expected fault signal {signal}"
            );
        }
        assert!(!is_fault_signal(None));
        assert!(!is_fault_signal(Some(SIGTERM)));
    }

    #[test]
    fn code_1_and_2_without_signal_are_benign_watcher_exits() {
        assert!(is_benign_watcher_exit(Some(1), None));
        assert!(is_benign_watcher_exit(Some(2), None));

        assert!(!is_benign_watcher_exit(Some(0), None));
        assert!(!is_benign_watcher_exit(Some(126), None));
        assert!(!is_benign_watcher_exit(Some(127), None));
        assert!(!is_benign_watcher_exit(None, None));
        assert!(!is_benign_watcher_exit(Some(1), Some(SIGSEGV)));
        assert!(!is_benign_watcher_exit(Some(2), Some(SIGKILL)));
    }

    #[test]
    fn watcher_exit_fingerprint_token_is_stable_per_exit_or_signal() {
        assert_eq!(termination_fingerprint_token(Some(126), None), "exit:126");
        assert_eq!(termination_fingerprint_token(Some(127), None), "exit:127");
        assert_eq!(
            termination_fingerprint_token(None, Some(SIGSEGV)),
            "signal:11"
        );
        assert_eq!(termination_fingerprint_token(None, None), "unknown");
    }

    // ── Crash-loop dampening (HQ-SYNC-4) ─────────────────────────────────

    #[test]
    fn respawn_backoff_is_base_then_exponential_capped() {
        let base = Duration::from_secs(30);
        let cap = Duration::from_secs(1800);
        assert_eq!(respawn_backoff(0, base, cap), base); // healthy cadence
        assert_eq!(respawn_backoff(1, base, cap), Duration::from_secs(60));
        assert_eq!(respawn_backoff(2, base, cap), Duration::from_secs(120));
        assert_eq!(respawn_backoff(3, base, cap), Duration::from_secs(240));
        // Caps out and never overflows even at absurd counts.
        assert_eq!(respawn_backoff(100, base, cap), cap);
        assert_eq!(respawn_backoff(u32::MAX, base, cap), cap);
    }

    #[test]
    fn capture_is_rate_limited_to_powers_of_two() {
        // 1st crash + exponential milestones alert; the noise in between is muted.
        for c in [1u32, 2, 4, 8, 16, 1024] {
            assert!(should_capture_crash(c), "expected capture at #{c}");
        }
        for c in [3u32, 5, 6, 7, 9, 15, 1000] {
            assert!(!should_capture_crash(c), "expected mute at #{c}");
        }
    }

    #[test]
    fn fast_failure_and_recovery_windows() {
        let window = FAST_FAIL_WINDOW;
        assert!(is_fast_failure(Duration::from_secs(5), window));
        assert!(!is_fast_failure(Duration::from_secs(120), window));
        // Recovery reset requires surviving at least the window.
        assert!(should_reset_after_recovery(Some(window), window));
        assert!(should_reset_after_recovery(
            Some(Duration::from_secs(120)),
            window
        ));
        assert!(!should_reset_after_recovery(
            Some(Duration::from_secs(5)),
            window
        ));
        assert!(!should_reset_after_recovery(None, window));
    }

    #[test]
    fn runner_unresolvable_preflight_is_local_log_only() {
        assert_eq!(
            runner_preflight_capture_policy(),
            RunnerPreflightCapturePolicy::LocalLogOnly
        );
    }

    // ── Exit diagnostics (HQ-SYNC-F) ─────────────────────────────────────

    #[test]
    fn parse_ps_rss_kb_reads_headerless_padded_output() {
        assert_eq!(parse_ps_rss_kb("  182340\n"), Some(182340));
        assert_eq!(parse_ps_rss_kb("512"), Some(512));
        assert_eq!(parse_ps_rss_kb(""), None);
        assert_eq!(parse_ps_rss_kb("not-a-number"), None);
    }

    #[test]
    fn format_rss_kb_scales_units() {
        assert_eq!(format_rss_kb(512), "512KB");
        assert_eq!(format_rss_kb(182 * 1024), "182MB");
        assert_eq!(format_rss_kb(1024 * 1024 + 512 * 1024), "1.5GB");
    }

    #[test]
    fn exit_diagnostic_suffix_omits_unknown_pieces() {
        assert_eq!(
            exit_diagnostic_suffix(None, None, None),
            " [last_rss=unsampled]"
        );
        assert_eq!(
            exit_diagnostic_suffix(Some(Duration::from_secs(5)), None, None),
            " [uptime=5s; last_rss=unsampled]"
        );
        let full = exit_diagnostic_suffix(
            Some(Duration::from_secs(90)),
            Some(182 * 1024),
            Some(Duration::from_secs(12)),
        );
        assert_eq!(
            full,
            " [uptime=1m30s; last_rss=182MB (sampled 12s before exit)]"
        );
    }
}
