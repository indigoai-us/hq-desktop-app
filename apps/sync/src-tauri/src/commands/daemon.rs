//! Feature-flagged daemon lifecycle — V2 prep.
//!
//! Wraps `hq sync start` / `hq sync stop` as Tauri commands.
//! Behind `AUTOSTART_DAEMON` feature flag in ~/.hq/menubar.json (default false).
//! Svelte UI does NOT expose these V1 — invocable only via Tauri devtools.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use crate::commands::process::{
    app_exit_requested, cancel_process_for_generation, cancel_process_generation_impl,
    cancellation_record_for_generation, deregister_generation, generation_for_handle,
    is_cancelled_for_generation, is_registered, lookup_pid, run_process_impl,
    run_process_impl_for_generation, try_register_handle_gen, CancellationRecord, ProcessError,
    ProcessEvent,
};
#[cfg(target_os = "windows")]
use crate::commands::session_end_observer::SessionEndObserverHandle;
use crate::commands::status::{journal_for_daemon_sync_complete, write_journal};
use crate::commands::sync::{PreflightFailure, ProvisionAttempt, RunTotals};
use hq_desktop_core::sync_outcome::{runner_assertion_for_class, RUNNER_PHASE_PRE_PROTOCOL};
use crate::events::{SyncEvent, EVENT_SYNC_ALL_COMPLETE};
use crate::util::logfile::log;
use crate::util::paths;
use hq_desktop_core::daemon::{
    derive_watch_daemon_state, is_daemon_alive_for_supervisor, should_terminate_job_on_path,
};
use hq_desktop_core::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};
use hq_desktop_core::runner_error_shape::classify_runner_stack_input;
use hq_desktop_core::runner_target::RunnerTargetState;
use hq_desktop_core::watcher_fault::{
    UnmatchedStderrShapeRollup, WatcherFaultProvenance, WatcherFaultReadCounters,
    WATCHER_FAULT_UNAVAILABLE,
};
use hq_desktop_core::sync_outcome::{
    classify_runner_fatal_signature, classify_windows_exit_status, current_termination_host,
    deferred_session_end_outcome, describe_exit, is_windows_console_control_exit,
    normalized_abort_description, resolved_session_end_attribution, runner_phase_elapsed_bucket,
    runner_phase_from_event, runner_stack_shape, runner_stack_shape_for_exit,
    session_end_grace_waited_bucket, should_capture_watcher_exit, spawn_failure_capture_policy,
    spawn_failure_fingerprint_token, termination_fingerprint_token,
    termination_fingerprint_token_for_host, watcher_exit_attributed_to_app_teardown,
    watcher_exit_capture_policy, watcher_exit_capture_policy_with_attribution,
    windows_exit_status_hex, windows_fault_symbol, windows_teardown_verdict,
    DeferredSessionEndOutcome, SpawnFailureCapturePolicy, SyncCancelCause, TeardownLogReading,
    TeardownShuttingDown, TerminationHost, WatcherExitCapturePolicy, WindowsTeardownProbeReading,
    WindowsTeardownVerdict, WindowsTermination, WindowsTerminatorAttribution, SESSION_END_GRACE_MS,
    WINDOWS_SESSION_TERMINATE_EXIT,
};
use crate::commands::windows_teardown_probe::{
    sample_shuttingdown, spawn_teardown_log_sweep, TeardownSweepHandle,
};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::CloseHandle;
#[cfg(target_os = "windows")]
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

#[allow(unused_imports)]
pub use hq_desktop_core::daemon::{
    build_watch_runner_args, event_push_eligible, is_autostart_enabled, is_instant_sync_enabled,
    is_pid_alive, is_realtime_sync_enabled, read_daemon_json, read_menubar_bool, read_pid_file,
    resolve_hq_folder_path, should_cancel_stalled_daemon, should_event_push,
    should_force_clear_stalled_start, should_respawn_daemon, should_respawn_daemon_gated,
    DaemonFailureCategory, DaemonJson, DaemonStatus, WatchDaemonState,
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

/// Multiple of [`DAEMON_HEARTBEAT_TIMEOUT`] at which the heartbeat is judged on
/// plain wall time regardless of throttling. Bounds the CPU-bound-wedge case
/// that runnable-time accounting cannot see; deliberately generous so it never
/// binds on healthy throttled work.
const HEARTBEAT_WALL_BACKSTOP: f32 = 8.0;

/// How long the singleton "starting" guard may be held with no live daemon
/// before the supervisor treats it as wedged and force-clears it. A healthy
/// start writes its PID within seconds, so this is comfortably longer than any
/// legitimate spawn + preflight yet far shorter than the multi-hour deadlock the
/// old unbounded guard produced (HQ-DESKTOP: respawn stuck on "Daemon is already
/// starting"). Recovery lands within one guard deadline instead of never.
const DAEMON_START_DEADLINE: Duration = Duration::from_secs(2 * 60);
const WATCHER_STDERR_TAIL_CAP: usize = 8;

/// Slack added after the generation's exit instant when time-bounding a Windows
/// Error Reporting record. WER writes the "Application Error" entry shortly AFTER
/// the faulting process dies, so a record landing a little past exit is still
/// this generation's; the PID-membership check remains the strong discriminator,
/// so this only widens the weaker `window_only` binding, never `pid_matched`.
const WATCHER_FAULT_WINDOW_SLACK_MS: i64 = 120_000;

/// Only WER records within this lookback of the terminal exit are eligible for
/// attribution. The fault that killed the watcher is the terminal one, so an
/// older descendant fault — or a PID reused since early in a long-running
/// generation — is excluded rather than over-claimed as `pid_matched`.
const WATCHER_FAULT_TERMINAL_LOOKBACK_MS: i64 = 600_000;

/// Wall-clock now in unix milliseconds, saturating at 0 before the epoch. Used to
/// bound a Windows fault record to the watcher generation lifetime; a benign
/// clock read that never affects capture or lifecycle.
fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Retain the exact bounded, ordered stderr tail that the watcher exit path
/// normalizes. This is intentionally the only mutation seam for watcher stderr
/// retention, so production and regression coverage cannot diverge into a
/// last-line-only path.
fn record_watcher_stderr_tail(stderr_tail: &Mutex<VecDeque<String>>, line: &str) {
    let mut tail = stderr_tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if tail.len() == WATCHER_STDERR_TAIL_CAP {
        tail.pop_front();
    }
    tail.push_back(line.to_string());
}

/// True only while the supervisor is issuing a respawn request. Capturing the
/// value at process exit makes the ordering explicit instead of inferring it
/// from a stale lifecycle breadcrumb.
static SUPERVISOR_RESPAWN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Set immediately before the heartbeat watchdog requests its one process-tree
/// cancellation. It remains set until the next spawn, so an exit diagnostic can
/// distinguish a watchdog-initiated teardown from an external termination.
static HEARTBEAT_STALL_TERMINATION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Whether the pre-spawn runner-target gate repaired the cached target before
/// the current generation started. Recorded at spawn because the repair happened
/// there; an exit-time re-probe cannot tell whether the state it sees is the
/// original one or the repaired one. Reset on every spawn.
static RUNNER_TARGET_REPAIR_ATTEMPTED: AtomicBool = AtomicBool::new(false);

fn note_runner_target_repair_attempted(attempted: bool) {
    RUNNER_TARGET_REPAIR_ATTEMPTED.store(attempted, Ordering::Release);
}

fn runner_target_repair_attempted() -> bool {
    RUNNER_TARGET_REPAIR_ATTEMPTED.load(Ordering::Acquire)
}

/// Reporting-only gate for exec-layer target provenance. Strictly ADDITIVE over
/// the pre-existing 126/127 arm so no exit that already carried provenance loses
/// it: keep every 126/127 (the POSIX permission/not-found legs AND the Windows
/// `npx.cmd` shim dispatch), and ALSO cover a launcher-kind child (`npx` /
/// `npx.exe`) that died before emitting any runner protocol with a nonzero exit
/// — that widened arm is what makes the still-unattributed exit-190 leg
/// (HQ-DESKTOP-51) self-describe. This never influences whether an exit is
/// captured; it only decides whether target facts are attached.
fn should_report_exec_provenance(
    code: Option<i32>,
    watcher_command: &str,
    runner_phase: &str,
) -> bool {
    matches!(code, Some(126 | 127))
        || (matches!(code, Some(nonzero) if nonzero != 0)
            && watcher_child_kind(watcher_command) == "launcher"
            && runner_phase == RUNNER_PHASE_PRE_PROTOCOL)
}

/// Probe the runner target only for the exec-layer fast-fails whose provenance
/// is in question. Diagnostics must never touch the filesystem on the ordinary
/// path, and must never influence whether a crash is captured.
fn current_runner_exec_target_state(
    code: Option<i32>,
    watcher_command: &str,
    runner_phase: &str,
) -> Option<RunnerTargetState> {
    should_report_exec_provenance(code, watcher_command, runner_phase)
        .then(hq_desktop_core::runner_target::probe_runner_target)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatcherLaunchOrigin {
    Renderer,
    AppLaunch,
    SupervisorRespawn,
}

impl WatcherLaunchOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Renderer => "renderer",
            Self::AppLaunch => "app_launch",
            Self::SupervisorRespawn => "supervisor_respawn",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WatcherGeneration {
    id: u64,
    launch_origin: WatcherLaunchOrigin,
}

static WATCHER_GENERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static WATCHER_GENERATION: OnceLock<Mutex<Option<WatcherGeneration>>> = OnceLock::new();

fn watcher_generation_state() -> &'static Mutex<Option<WatcherGeneration>> {
    WATCHER_GENERATION.get_or_init(|| Mutex::new(None))
}

/// The only production factory for watcher generations. The returned value is
/// copied into the process closure, so exit attribution always comes from the
/// generation that died rather than a global sampled later.
fn begin_watcher_generation(origin: WatcherLaunchOrigin) -> WatcherGeneration {
    let generation = WatcherGeneration {
        id: WATCHER_GENERATION_SEQUENCE
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1),
        launch_origin: origin,
    };
    *watcher_generation_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(generation);
    generation
}

fn finish_watcher_generation(generation: &WatcherGeneration) {
    let mut current = watcher_generation_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current
        .as_ref()
        .is_some_and(|current| current.id == generation.id)
    {
        *current = None;
    }
}

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
fn handle_watch_stdout_line<R: tauri::Runtime>(
    app: &AppHandle<R>,
    hq_folder: &str,
    totals: &Mutex<RunTotals>,
    phase_context: &Mutex<WatcherPhaseContext>,
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
    observe_watcher_phase_from_event(phase_context, &event);
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

fn start_daemon_heartbeat_watchdog(
    generation: u64,
    last_heartbeat: Arc<Mutex<hq_desktop_core::cpu_throttle::RunnableMark>>,
    finished: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        thread::sleep(DAEMON_HEARTBEAT_CHECK_INTERVAL);
        if finished.load(Ordering::Acquire) {
            return;
        }
        // The watch daemon runs under HQ's CPU ceiling, so wall time since the
        // last protocol record overstates how much work the pass actually got
        // to do: on a small machine a five-minute window can buy well under a
        // minute of runnable time, and a healthy large-tree pass that emits no
        // record during a heavy phase would be killed and restarted forever.
        // Charge the heartbeat only for runnable time, and keep an absolute
        // wall-clock backstop so a wedge that spins on CPU — which the governor
        // keeps stopping, and would otherwise be credited stop windows without
        // end — is still caught.
        let heartbeat_age = {
            let since = last_heartbeat
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let wall = since.wall_elapsed();
            if wall >= DAEMON_HEARTBEAT_TIMEOUT.mul_f32(HEARTBEAT_WALL_BACKSTOP) {
                wall
            } else {
                since.runnable_elapsed()
            }
        };
        if should_cancel_stalled_daemon(
            generation_for_handle(DAEMON_HANDLE) == Some(generation),
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
            // Exactly-once Job Object / process-group teardown for this generation.
            HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(true, Ordering::Release);
            if !terminate_daemon_generation_once(generation, DaemonFailureCategory::HeartbeatStall)
            {
                HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(false, Ordering::Release);
            }
            return;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle state + content-safe Sentry diagnostics (US-002)
// ─────────────────────────────────────────────────────────────────────────────

static LIFECYCLE_STATE: OnceLock<Mutex<WatchDaemonState>> = OnceLock::new();

fn lifecycle_state_lock() -> &'static Mutex<WatchDaemonState> {
    LIFECYCLE_STATE.get_or_init(|| Mutex::new(WatchDaemonState::Stopped))
}

fn current_lifecycle_state() -> WatchDaemonState {
    *lifecycle_state_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Transition the watch-daemon lifecycle state and emit content-safe diagnostics
/// (state names + failure category only — never argv, tokens, or file contents).
fn set_lifecycle_state(next: WatchDaemonState, category: DaemonFailureCategory) {
    let mut guard = lifecycle_state_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let prev = *guard;
    if prev == next && category == DaemonFailureCategory::None {
        return;
    }
    *guard = next;
    drop(guard);

    log(
        "daemon.lifecycle",
        &format!(
            "state {} → {} category={}",
            prev.as_str(),
            next.as_str(),
            category.as_str()
        ),
    );

    let mut data = std::collections::BTreeMap::new();
    data.insert(
        "from".to_string(),
        sentry::protocol::Value::String(prev.as_str().to_string()),
    );
    data.insert(
        "to".to_string(),
        sentry::protocol::Value::String(next.as_str().to_string()),
    );
    data.insert(
        "category".to_string(),
        sentry::protocol::Value::String(category.as_str().to_string()),
    );
    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some("daemon.lifecycle".into()),
        level: match category {
            DaemonFailureCategory::None | DaemonFailureCategory::Cancelled => sentry::Level::Info,
            DaemonFailureCategory::Backoff | DaemonFailureCategory::Preflight => {
                sentry::Level::Warning
            }
            _ => sentry::Level::Error,
        },
        message: Some(format!(
            "watch daemon {} → {} ({})",
            prev.as_str(),
            next.as_str(),
            category.as_str()
        )),
        data,
        ..Default::default()
    });
}

/// Terminate the daemon process tree at most once per generation.
/// Uses the process-registry cancelled flag so crash / stall / cancel /
/// force-clear / backoff paths never double-`TerminateJobObject`.
fn terminate_daemon_once(category: DaemonFailureCategory) -> bool {
    terminate_daemon_once_with_delay(category, SIGKILL_DELAY)
}

/// Testable core of [`terminate_daemon_once`]. Production always supplies the
/// five-second grace period; native process tests shorten only the wait while
/// exercising the identical cancellation and lifecycle path.
fn terminate_daemon_once_with_delay(
    category: DaemonFailureCategory,
    sigkill_delay: Duration,
) -> bool {
    let Some(generation) = generation_for_handle(DAEMON_HANDLE) else {
        return false;
    };
    terminate_daemon_generation_once_with_delay(generation, category, sigkill_delay)
}

fn terminate_daemon_generation_once(generation: u64, category: DaemonFailureCategory) -> bool {
    terminate_daemon_generation_once_with_delay(generation, category, SIGKILL_DELAY)
}

fn terminate_daemon_generation_once_with_delay(
    generation: u64,
    category: DaemonFailureCategory,
    sigkill_delay: Duration,
) -> bool {
    let already = is_cancelled_for_generation(DAEMON_HANDLE, generation);
    if !should_terminate_job_on_path(already, category) {
        return false;
    }
    // Only the heartbeat-stall watchdog stamps a durable cause: it is the one
    // daemon teardown the watcher's terminal boundary may later attribute to the
    // app. The cause is published before any OS call, so an ESRCH/lost-publication
    // outcome retains {cause, termination_effected:false} and stays alertable.
    // Every other category keeps the causeless seam, so it can never suppress a
    // runner-exit capture on its own.
    let cancelled = match category {
        DaemonFailureCategory::HeartbeatStall => {
            cancel_process_for_generation(
                DAEMON_HANDLE,
                generation,
                SyncCancelCause::HeartbeatStall,
                sigkill_delay,
            )
            .executed
        }
        _ => cancel_process_generation_impl(DAEMON_HANDLE, generation, sigkill_delay),
    };
    if cancelled {
        match category {
            DaemonFailureCategory::HeartbeatStall => {
                set_lifecycle_state(WatchDaemonState::Stopped, category);
            }
            DaemonFailureCategory::ForceClear => {
                set_lifecycle_state(WatchDaemonState::Stopped, category);
            }
            DaemonFailureCategory::Cancelled => {
                set_lifecycle_state(WatchDaemonState::Stopped, category);
            }
            DaemonFailureCategory::Backoff => {
                set_lifecycle_state(WatchDaemonState::Backoff, category);
            }
            DaemonFailureCategory::Crash => {
                set_lifecycle_state(WatchDaemonState::Stopped, category);
            }
            _ => {}
        }
    }
    cancelled
}

/// Observe app-owned registry + optional inherited PID file.
/// After spawn the registered child PID is authoritative; the HQ PID file is
/// only a recovery signal when this process holds no handle.
fn observe_daemon_liveness() -> (bool, bool, bool, Option<u32>) {
    let app_owned_registered = is_registered(DAEMON_HANDLE);
    let app_pid = lookup_pid(DAEMON_HANDLE);
    let registered_child_alive = app_pid.map(is_pid_alive).unwrap_or(false);
    let pid_file_pid = resolve_hq_folder_path()
        .ok()
        .and_then(|p| read_pid_file(&p));
    let pid_file_alive = pid_file_pid.map(is_pid_alive).unwrap_or(false);
    let alive = is_daemon_alive_for_supervisor(
        app_owned_registered,
        registered_child_alive,
        pid_file_alive,
    );
    // RSS must stay generation-scoped to the app-owned registry entry. A PID
    // file is sufficient as a recovery liveness signal, but can be stale or
    // reused and therefore must never select the process whose memory we
    // attribute to this watcher generation.
    let sample_pid = app_owned_rss_sample_pid(app_pid, pid_file_pid);
    (
        app_owned_registered,
        registered_child_alive,
        alive,
        sample_pid,
    )
}

fn app_owned_rss_sample_pid(app_pid: Option<u32>, _pid_file_pid: Option<u32>) -> Option<u32> {
    app_pid
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
    /// Process-registry generation acquired by the same start. Keeping the two
    /// tokens in one stamp prevents force-clear from pairing owners across a
    /// concurrent respawn.
    registration: u64,
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
fn mark_daemon_guard_acquired(registration: u64) -> u64 {
    let generation = DAEMON_GUARD_GEN
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    *daemon_guard().lock().unwrap_or_else(|p| p.into_inner()) = Some(DaemonGuardStamp {
        generation,
        registration,
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
/// Mirrors the supervisor's own `daemon_alive` computation: app-owned registered
/// child is authoritative after spawn; PID file is only a recovery fallback.
/// A force-clear can bail if a liveness *flake* made the supervisor briefly
/// believe a healthy daemon was down.
fn daemon_appears_alive() -> bool {
    let (_reg, _child, alive, _pid) = observe_daemon_liveness();
    alive
}

/// Release a failed start only when it still owns both generations. A stale
/// preflight bail must not erase a replacement watcher or its newer guard stamp.
fn release_daemon_guard(registration: u64, guard_generation: u64) {
    clear_daemon_guard_stamp_for(guard_generation);
    let _ = deregister_generation(DAEMON_HANDLE, registration);
}

/// Force-clear a guard the supervisor has judged wedged: terminate any lingering
/// (hung) watcher process still tracked under the handle, then release the guard
/// so the immediate respawn can proceed. Terminating first means the stale child
/// is reaped rather than orphaned — on Windows this closes the KILL_ON_JOB_CLOSE
/// job (killing the tree); on Unix it SIGTERM/SIGKILLs the process group.
fn force_clear_daemon_guard() {
    force_clear_daemon_guard_with_probe(daemon_appears_alive)
}

fn force_clear_daemon_guard_with_probe<F>(daemon_alive_probe: F)
where
    F: FnOnce() -> bool,
{
    // Capture the actor that crossed the wedge deadline before probing. A
    // replacement may register while the liveness check runs; the stale actor
    // must keep its original tokens rather than re-resolving that replacement.
    let ownership = *daemon_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    force_clear_daemon_guard_impl(ownership, daemon_alive_probe())
}

/// Force-clear with the liveness re-probe result injected, so the abort/kill
/// decision is unit-testable without a real pid file.
fn force_clear_daemon_guard_impl(ownership: Option<DaemonGuardStamp>, daemon_alive_recheck: bool) {
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
    force_clear_daemon_generation(ownership);
}

/// Complete a force-clear using the ownership snapshots captured by its actor.
/// If either token is stale, the generation-scoped operations are no-ops and a
/// replacement watcher/guard remains untouched.
fn force_clear_daemon_generation(ownership: Option<DaemonGuardStamp>) {
    let Some(ownership) = ownership else {
        return;
    };
    let _ =
        terminate_daemon_generation_once(ownership.registration, DaemonFailureCategory::ForceClear);
    let _ = deregister_generation(DAEMON_HANDLE, ownership.registration);
    clear_daemon_guard_stamp_for(ownership.generation);
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
pub fn start_daemon<R: tauri::Runtime>(app: AppHandle<R>) -> Result<String, String> {
    start_daemon_with_origin(app, WatcherLaunchOrigin::Renderer)
}

pub fn start_daemon_for_app_launch<R: tauri::Runtime>(app: AppHandle<R>) -> Result<String, String> {
    start_daemon_with_origin(app, WatcherLaunchOrigin::AppLaunch)
}

fn start_daemon_for_supervisor_respawn<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<String, String> {
    start_daemon_with_origin(app, WatcherLaunchOrigin::SupervisorRespawn)
}

fn start_daemon_with_origin<R: tauri::Runtime>(
    app: AppHandle<R>,
    launch_origin: WatcherLaunchOrigin,
) -> Result<String, String> {
    // V2 Cloud Off (US-001 / US-016): while the user has Cloud paused, NO watch
    // daemon may start — renderer request, app-launch autostart, or supervisor
    // respawn. Instant/event push is an argument of this watcher, so gating
    // here pauses it too. Checked before taking the singleton guard so a
    // paused refusal never wedges a later, unpaused start.
    hq_desktop_core::daemon::ensure_cloud_sync_allowed()?;
    // Generation-scoped registration: every later release/terminate/cancel this
    // start performs is bound to the generation it acquired here, so a stale
    // actor can never operate on a replacement watcher (HQ-DESKTOP-3J).
    let Some(daemon_generation) = try_register_handle_gen(DAEMON_HANDLE) else {
        return Err("Daemon is already starting".to_string());
    };
    // Stamp the guard acquisition so the supervisor can bound how long a start
    // may hold it with no live daemon before treating it as wedged. The
    // generation lets this start's exit clear only its own stamp, never a
    // respawn's fresher one.
    let guard_generation = mark_daemon_guard_acquired(daemon_generation);
    let watcher_generation = begin_watcher_generation(launch_origin);
    set_lifecycle_state(WatchDaemonState::Starting, DaemonFailureCategory::None);

    // A signed-out watcher can only emit auth-error and exit 0. Refuse that
    // known-dead loop up front; after a terminal auth event clears the token,
    // the supervisor will keep sync peacefully paused until reauth succeeds.
    match crate::commands::cognito::read_tokens_from_file() {
        Ok(Some(_)) => {}
        Ok(None) => {
            release_daemon_guard(daemon_generation, guard_generation);
            set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::Preflight);
            return Err(crate::commands::cognito::REAUTH_MESSAGE.to_string());
        }
        Err(err) => {
            release_daemon_guard(daemon_generation, guard_generation);
            set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::Preflight);
            return Err(err);
        }
    }

    let hq_folder_path = match resolve_hq_folder_path() {
        Ok(p) => p,
        Err(e) => {
            release_daemon_guard(daemon_generation, guard_generation);
            set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::Preflight);
            return Err(e);
        }
    };

    // Pre-flight: check if daemon is already running from a previous session
    if let Some(pid) = read_pid_file(&hq_folder_path) {
        if is_pid_alive(pid) {
            release_daemon_guard(daemon_generation, guard_generation);
            // Inherited runner is live — surface Running without taking ownership.
            set_lifecycle_state(WatchDaemonState::Running, DaemonFailureCategory::None);
            return Err(format!("Daemon is already running (PID {})", pid));
        }
    }

    // Node-runtime preflight (HQ-DESKTOP-B3). The daemon previously checked
    // only runner *resolvability*, so a machine whose managed Node had vanished
    // — leaving `env node` to find an ancient one on PATH — started a watcher
    // that could only fail later. Fail honestly up front instead.
    // Capture the probed Node major from the SAME preflight so a watcher-exit
    // capture can name the runtime a libuv abort came from, without a new spawn.
    let node_preflight = crate::commands::sync::preflight_node_outcome();
    let watcher_node_major = node_preflight.node_major;
    if let Some(bail) = node_preflight.bail {
        if bail.failure == PreflightFailure::NodeUnprovisioned {
            // This command is synchronous, so do not hold its singleton guard
            // across a network install. The supervisor will retry on its next
            // cadence after the shared repair slot completes.
            release_daemon_guard(daemon_generation, guard_generation);
            set_lifecycle_state(WatchDaemonState::Backoff, DaemonFailureCategory::Preflight);
            let provisioning_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let outcome =
                    crate::commands::sync::provision_unprovisioned_node(&provisioning_app).await;
                report_provisioning_outcome(outcome);
            });
            return Err(bail.message);
        }
        report_preflight_bail(bail.failure, &bail.message);
        release_daemon_guard(daemon_generation, guard_generation);
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::Preflight);
        return Err(bail.message);
    }

    // Runner-resolution preflight (HQ-DESKTOP-37 / HQ-DESKTOP-2R): bail before
    // spawning a watcher that can only exit 127 and get hot-respawned by the
    // supervisor.
    if let Some(msg) = crate::commands::sync::preflight_runner_unresolvable() {
        report_preflight_bail(PreflightFailure::RunnerUnresolvable, &msg);
        release_daemon_guard(daemon_generation, guard_generation);
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::Preflight);
        return Err(msg);
    }

    // The startup prewarm and the first watch spawn can overlap. Complete the
    // same bounded, locked materialization preflight used by Sync Now before
    // starting the long-lived runner. This is deliberately local-log/UI
    // diagnosis only: an npx cache/permission failure is environmental, while
    // an unexplained later runner exit remains alertable below.
    if let Err(msg) = hq_desktop_core::prewarm::materialize_hq_cloud_cache() {
        log(
            "daemon",
            &format!("npx cache materialization preflight failed: {msg}"),
        );
        note_environment_preflight_failure();
        release_daemon_guard(daemon_generation, guard_generation);
        set_lifecycle_state(WatchDaemonState::Backoff, DaemonFailureCategory::Preflight);
        return Err(msg);
    }

    // Probe — and bounded self-repair — of the runner target the watcher will
    // ACTUALLY exec, which the materialization preflight above never touches (it
    // validates `node -e`, not node_modules/.bin/hq-sync-runner). A cache whose
    // runner target is missing or not executable therefore passes materialization
    // and the watcher is spawned into an exit-127/126 hot-respawn loop
    // (HQ-DESKTOP-52 / HQ-DESKTOP-4K). Fail open: only a POSITIVELY identified
    // Missing/NotExecutable target, after the single bounded repair, refuses;
    // every ambiguous/error probe result spawns as before, so a probe bug can
    // never take a healthy machine's auto-sync offline. A refusal is
    // environmental — local diagnosis + Backoff, no Sentry event — exactly like
    // the materialization failure above.
    let runner_target = hq_desktop_core::runner_target::ensure_runner_target_runnable();
    note_runner_target_repair_attempted(runner_target.repair.attempted());
    if runner_target.refuses_spawn() {
        log(
            "daemon",
            &format!(
                "runner-target preflight refused spawn: state={} repair={}",
                runner_target.state.class_name(),
                runner_target.repair.class_name()
            ),
        );
        note_environment_preflight_failure();
        release_daemon_guard(daemon_generation, guard_generation);
        set_lifecycle_state(WatchDaemonState::Backoff, DaemonFailureCategory::Preflight);
        return Err(hq_desktop_core::runner_target::runner_target_diagnosis(
            runner_target.state,
        ));
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
    let watcher_phase = Arc::new(Mutex::new(WatcherPhaseContext::default()));
    let hq_folder = hq_folder_path.clone();
    let last_heartbeat = Arc::new(Mutex::new(
        hq_desktop_core::cpu_throttle::RunnableMark::now(),
    ));
    let daemon_finished = Arc::new(AtomicBool::new(false));
    // Bounded and generation-local. Raw lines remain process-local; only the
    // fixed-vocabulary stack shape derived at exit can leave the process.
    let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(
        WATCHER_STDERR_TAIL_CAP,
    )));
    // Per-generation stderr diagnostics that must survive the AllComplete reset
    // of `totals` (reset each pass): the true stderr line count and a structural
    // rollup of the lines the fatal classifier did not recognise. Both are
    // content-safe — only a count and fixed-vocabulary tokens leave the process.
    let stderr_line_count = Arc::new(AtomicU64::new(0));
    let unmatched_stderr = Arc::new(Mutex::new(UnmatchedStderrShapeRollup::default()));
    // Wall-clock start of this generation, to time-bound its Windows fault record.
    let generation_started_ms = now_unix_ms();
    let watcher_command = spawn_args.cmd.clone();
    start_daemon_heartbeat_watchdog(
        daemon_generation,
        last_heartbeat.clone(),
        daemon_finished.clone(),
    );

    thread::spawn(move || {
        let process_heartbeat = last_heartbeat.clone();
        let process_finished = daemon_finished.clone();
        let process_stderr_tail = stderr_tail.clone();
        let process_stderr_line_count = stderr_line_count.clone();
        let process_unmatched_stderr = unmatched_stderr.clone();
        let process_watcher_phase = watcher_phase.clone();
        // Monotonic count of stdout (protocol) lines this watcher generation
        // emitted, mirroring the manual route, so the exit capture can tell
        // "died before any protocol" from "died mid-work".
        let mut watcher_stdout_line_count = 0_u32;
        let result = run_process_impl_for_generation(
            DAEMON_HANDLE,
            daemon_generation,
            &spawn_args,
            move |event| {
                // Surface stderr and non-success exits unconditionally — they
                // are the only signals the user has when the watcher dies
                // (e.g. "Unknown argument: --watch" on a stale runner pin).
                // Stdout is parsed for ndjson SyncEvents so each watcher pass
                // updates `.hq-sync-journal.json` and refreshes the popover's
                // "Last synced" stat — without that, the UI only ever showed
                // the timestamp of the last manual `Sync Now` click.
                match event {
                    ProcessEvent::Stdout(line) => {
                        if handle_watch_stdout_line(
                            &app,
                            &hq_folder,
                            &totals,
                            &process_watcher_phase,
                            &line,
                        ) {
                            // Count only parsed protocol lines (mirrors the
                            // manual route): a blank or unparseable teardown line
                            // is not protocol output, so it must not read as work.
                            watcher_stdout_line_count =
                                watcher_stdout_line_count.saturating_add(1);
                            *process_heartbeat
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                                hq_desktop_core::cpu_throttle::RunnableMark::now();
                            // Heartbeat cadence: sample the live Job Object PID set
                            // so a runner descendant that later faults is bindable
                            // to this generation at exit. Windows-only; a no-op
                            // elsewhere and purely additive diagnostics.
                            crate::commands::process::sample_watcher_job_pids_for_generation(
                                DAEMON_HANDLE,
                                daemon_generation,
                            );
                        }
                    }
                    ProcessEvent::Stderr(line) => {
                        log("daemon.stderr", &line);
                        record_watcher_stderr_tail(&process_stderr_tail, &line);
                        // Raw stderr can contain user paths and messages. Keep it
                        // in the local log; the capture path receives only the
                        // fixed-vocabulary rollup recorded from parsed errors.
                        crate::commands::sync::handle_runner_stderr_line(&app, &totals, &line);
                        // Per-generation counters (survive the AllComplete reset of
                        // `totals`): the true stderr line count, and a structural
                        // rollup of the lines the fatal classifier did not recognise.
                        // Content-safe — only a count and fixed tokens ever escape.
                        process_stderr_line_count.fetch_add(1, Ordering::Relaxed);
                        process_unmatched_stderr
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .record_if_unmatched(&line);
                        // Also sample the Job Object PID set here: a startup
                        // fast-fail can abort before any parseable protocol event, so
                        // relying on the stdout heartbeat alone would leave the
                        // sampled set empty for exactly the early-crash class this
                        // instruments. Windows-only; a no-op elsewhere.
                        crate::commands::process::sample_watcher_job_pids_for_generation(
                            DAEMON_HANDLE,
                            daemon_generation,
                        );
                        // A protocol event delivered on stderr still proves the
                        // runner emitted protocol; route it through the phase
                        // observer so the never-observed sentinel is cleared.
                        if let Ok(event) = serde_json::from_str::<SyncEvent>(line.trim()) {
                            observe_watcher_phase_from_event(&process_watcher_phase, &event);
                        }
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
                        // Generation-scoped: this exit's own registration carries
                        // the cancellation evidence, so a watchdog SIGKILL of THIS
                        // watcher stays attributable through the terminal callback
                        // (HQ-DESKTOP-3J / HQ-DESKTOP-4D).
                        let cancelled =
                            is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation);
                        // Read the durable cancellation record for this exact
                        // generation too. It survives the deregistration that can
                        // lose the ephemeral `cancelled` flag before this terminal
                        // read, so the app's own watchdog teardown stays
                        // attributable (and every still-alertable exit carries a
                        // self-assigning readout). Bounded by
                        // CANCELLATION_PUBLICATION_TIMEOUT, degrading to
                        // termination_effected=false — identical to the shipped
                        // manual-sync boundary.
                        let cancellation_record =
                            cancellation_record_for_generation(DAEMON_HANDLE, daemon_generation);
                        let stderr_tail = process_stderr_tail
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>();
                        // Reporting-only: probe the runner target the watcher
                        // actually execs, for the exec-layer fast-fails whose
                        // provenance is in question (126/127 and the launcher
                        // pre-protocol nonzero leg). Read the phase this exit
                        // resolved to so the widened arm is gated on the SAME
                        // pre_protocol sentinel the context records.
                        let runner_phase_at_exit = watcher_phase
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .phase;
                        let runner_exec_target = current_runner_exec_target_state(
                            code,
                            &watcher_command,
                            runner_phase_at_exit,
                        );
                        let mut exit_context = watcher_exit_capture_context(
                            &totals,
                            cancelled,
                            &watcher_phase,
                            &watcher_generation,
                            daemon_generation,
                            &stderr_tail,
                            current_windows_terminator_attribution(&app, code, signal),
                            cancellation_record,
                            watcher_stdout_line_count,
                            watcher_node_major,
                            runner_exec_target,
                        );
                        // Additive per-generation diagnostics, set after the content
                        // snapshot. None of these is consulted by capture policy.
                        exit_context.runner_stderr_line_count = Some(
                            process_stderr_line_count
                                .load(Ordering::Relaxed)
                                .min(u32::MAX as u64) as u32,
                        );
                        exit_context.runner_unmatched_stderr_shapes = process_unmatched_stderr
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .tag_value();
                        // Drain this generation's sampled Job Object tree (PIDs +
                        // the images resolved while those PIDs were alive). Fast,
                        // synchronous, and unconditional so the sampled-PID map can
                        // never retain a generation key. The images give a named
                        // culprit CANDIDATE even if WER never yields a record; the
                        // PIDs feed the deferred OS fault read below.
                        let job_sample =
                            crate::commands::process::take_watcher_job_sample(daemon_generation);
                        if job_sample.images.images_tag().is_some() {
                            exit_context.watcher_fault_job_images =
                                job_sample.images.images_tag();
                            exit_context.watcher_fault_job_culprit_candidate =
                                Some(job_sample.images.culprit_candidate_token().to_string());
                            exit_context.watcher_fault_job_image_provenance =
                                Some(job_sample.images.provenance_token().to_string());
                        }
                        // Only a genuine Windows fault exit warrants reading the OS
                        // fault record; every other exit and platform is not
                        // applicable and keeps the honest sentinels.
                        let observed_exception_code =
                            code.filter(|_| signal.is_none()).and_then(|code| {
                                match classify_windows_exit_status(code) {
                                    WindowsTermination::Fault(raw) => Some(raw),
                                    _ => None,
                                }
                            });
                        match observed_exception_code {
                            Some(exception_code) => {
                                // DEFER the OS fault read entirely off this terminal
                                // exit callback: it publishes asynchronously seconds
                                // after the child dies and the old on-exit-path 4.5s
                                // wait could never outlast it. The exit path now does
                                // ZERO Event Log work, so emit_exit_then_deregister —
                                // and supervisor recovery — is no longer held up.
                                // Seed the honest "not read yet" provenance; the
                                // deferred worker upgrades it, or a teardown flush
                                // emits it as-is.
                                let fault_window_end = now_unix_ms()
                                    .saturating_add(WATCHER_FAULT_WINDOW_SLACK_MS);
                                let fault_window_start = generation_started_ms.max(
                                    fault_window_end
                                        .saturating_sub(WATCHER_FAULT_TERMINAL_LOOKBACK_MS),
                                );
                                exit_context.watcher_fault_provenance =
                                    WatcherFaultProvenance::Deferred.as_str().to_string();
                                exit_context.watcher_fault_faulting_image =
                                    WATCHER_FAULT_UNAVAILABLE.to_string();
                                exit_context.watcher_fault_faulting_module =
                                    WATCHER_FAULT_UNAVAILABLE.to_string();
                                exit_context.watcher_fault_read_counters =
                                    Some(WatcherFaultReadCounters::default().tag_value());
                                exit_context.watcher_fault_deferred_read =
                                    Some(WatcherFaultDeferredRead {
                                        sampled_pids: job_sample.pids,
                                        exception_code,
                                        gen_start_ms: fault_window_start,
                                        gen_end_ms: fault_window_end,
                                    });
                            }
                            None => {
                                exit_context.watcher_fault_provenance =
                                    WatcherFaultProvenance::NotApplicable.as_str().to_string();
                            }
                        }
                        let last_stderr = stderr_tail.last().map(String::as_str);
                        handle_watcher_exit(
                            code,
                            signal,
                            success,
                            cancelled,
                            &watcher_command,
                            last_stderr,
                            &exit_context,
                        );
                    }
                }
            },
        );

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

        if let Err(error) = result {
            record_watcher_process_error(error);
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
// events. A bare POSIX SIGTERM is a deliberate stop; Windows status handling
// is explicit below, rather than pretending a Windows process can expose a
// Unix signal.

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
/// explicit `signal != SIGTERM` check is defense in depth for externally
/// delivered SIGTERMs.
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

/// Pure classifier for watcher exits that are expected environment/teardown
/// outcomes rather than actionable crashes. The Windows carve-out is exactly
/// `STATUS_CONTROL_C_EXIT`; all other Windows statuses remain alertable.
fn is_benign_watcher_exit(code: Option<i32>, signal: Option<i32>) -> bool {
    is_windows_console_control_exit(code, signal)
        || (matches!(code, Some(1 | 2)) && signal.is_none() && !is_fault_signal(signal))
}

/// The live 221 is intentionally not classified. Its capture carries only
/// fixed-vocabulary runner identity, never the machine-specific invocation or
/// raw stderr, so the next occurrence is useful without exposing local data.
fn is_unrecognized_watcher_exit(code: Option<i32>, signal: Option<i32>) -> bool {
    signal.is_none()
        && !matches!(code, Some(0 | 1 | 2 | 126 | 127))
        && code
            .map(|code| !classify_windows_exit_status(code).is_windows_status())
            .unwrap_or(true)
}

/// What the deferred fault-read worker needs to complete a Windows fault exit's
/// attribution off the terminal exit callback: the generation's sampled live
/// PIDs, the fault code the exit carried, and the binding window. Platform-neutral
/// data (just integers), drained synchronously at exit so the sampled-PID map
/// cannot leak.
#[derive(Debug, Clone)]
struct WatcherFaultDeferredRead {
    sampled_pids: Vec<u32>,
    exception_code: u32,
    gen_start_ms: i64,
    gen_end_ms: i64,
}

#[derive(Debug, Clone)]
struct WatcherExitCaptureContext {
    lifecycle_state: String,
    app_quit_in_progress: bool,
    supervisor_respawn_in_flight: bool,
    heartbeat_stall_termination_in_flight: bool,
    cancelled: bool,
    fatal_runner_signature_seen: bool,
    runner_fatal_class: String,
    /// Allow-listed libuv syscall identifier and integer errno for the last
    /// recognised libuv fatal-syscall stderr line, when present. Content-safe:
    /// the syscall is a fixed constant, the errno a bare integer.
    runner_fatal_syscall: Option<String>,
    runner_fatal_errno: Option<i64>,
    /// Content-safe identity of the last recognised assertion line this pass,
    /// read from the SAME RunTotals source the manual route reads. Present only
    /// for an assertion fatal class; the source is a fixed token, the line an
    /// integer, the signature a 16-hex digest. Fallback for the capture builder,
    /// which prefers the last actual stderr line (totals reset each pass).
    runner_assert_source: Option<String>,
    runner_assert_line: Option<i64>,
    runner_assert_signature: Option<String>,
    /// Total stdout (protocol) lines this watcher generation emitted before it
    /// died, so "died before doing any work" is separable from "died mid-work".
    runner_stdout_line_count: u32,
    /// The runner's Node major from the daemon's existing Node preflight (no new
    /// spawn), or `None` when nothing answered. Reporting-only provenance.
    runner_node_major: Option<u32>,
    /// Bucketed peak per-process COMMITTED memory and total process count read
    /// from the watcher's retained Windows Job Object at the exit boundary. The
    /// job sees the Node runner even though the registered child is the cmd.exe
    /// shim whose own footprint hides it. `"unknown"` when unavailable
    /// (non-Windows or a failed query); reporting-only, never gates capture.
    watcher_job_peak_commit_bucket: String,
    watcher_job_process_count: String,
    runner_error_rollup: Option<String>,
    runner_error_class: &'static str,
    runner_error_ops: Option<String>,
    runner_error_shapes: Option<String>,
    runner_error_path_roots: Option<String>,
    runner_error_http: Option<String>,
    runner_error_causes: Option<String>,
    runner_error_scope: Option<String>,
    runner_error_companies: u32,
    runner_phase: String,
    runner_phase_elapsed_bucket: String,
    watcher_launch_origin: String,
    runner_stack_shape: String,
    runner_stack_signature: String,
    runner_stack_depth: u8,
    runner_stack_redacted_frames: u8,
    runner_stack_input: String,
    /// Retained V8 heap-OOM evidence (HQ-DESKTOP-55), read from the shared
    /// `RunTotals` at the exit boundary. All four are `None` unless the runner
    /// aborted on a heap OOM this pass; absence never renders as evidence. The
    /// banner is a fixed constant, the MB/frame figures bare integers.
    runner_oom_banner: Option<&'static str>,
    runner_heap_used_mb: Option<u64>,
    runner_heap_total_mb: Option<u64>,
    runner_oom_frame_count: Option<u32>,
    windows_terminator: Option<WindowsTerminatorAttribution>,
    /// Durable cancellation-record readout for this exact generation, read at the
    /// terminal boundary alongside the ephemeral cancelled flag. These three make
    /// the next occurrence self-assigning between an external kill and a lost
    /// ephemeral flag, and drive the durable-record attribution gate.
    cancellation_record_present: bool,
    cancellation_record_cause: Option<SyncCancelCause>,
    cancellation_termination_effected: bool,
    /// Snapshot of whether this pass saw an alertable runner error. A concurrent
    /// alertable fault must win over durable-record attribution, exactly as at
    /// the manual-sync boundary.
    saw_alertable_error: bool,
    /// Total stderr lines this generation received, at parity with the manual
    /// route's `runner_stderr_line_count` extra, so the 8-line tail ring is not
    /// misread as the real line count. `None` renders nothing.
    runner_stderr_line_count: Option<u32>,
    /// Bounded, fixed-vocabulary structural rollup of stderr lines the fatal
    /// classifier did NOT recognise (`ndjson_record:6,stack_frame:2`), so a silent
    /// runner is distinguishable from a noisy-but-unrecognised one. `None` when no
    /// unmatched line was seen this generation.
    runner_unmatched_stderr_shapes: Option<String>,
    /// Windows Error Reporting fault attribution for this generation. The image
    /// and module are allow-listed tokens (or `unavailable`); provenance is an
    /// honesty token; the code and offset are bare integers. Every field degrades
    /// to its sentinel on non-Windows or a failed/absent query, so absence never
    /// renders as evidence. Diagnostic-only: never consulted by any capture or
    /// attribution decision.
    watcher_fault_provenance: String,
    watcher_fault_faulting_image: String,
    watcher_fault_faulting_module: String,
    watcher_fault_exception_code: Option<u32>,
    watcher_fault_offset: Option<u64>,
    /// The rendered read-counters rollup (`seen:N,parsed:N,...`) for the fault
    /// read; `None` for a non-fault exit so no counters tag is emitted. Seeded
    /// all-zero on the exit path and refreshed by the deferred worker's verdict.
    watcher_fault_read_counters: Option<String>,
    /// WER-independent job-image tree observation (HQ-DESKTOP-4X): the allow-listed
    /// image set the generation's Job Object was seen to run, a non-shim culprit
    /// CANDIDATE, and a tree-observation honesty token — never a fault attribution.
    /// `None` when nothing was sampled alive, so absence never renders as evidence.
    watcher_fault_job_images: Option<String>,
    watcher_fault_job_culprit_candidate: Option<String>,
    watcher_fault_job_image_provenance: Option<String>,
    /// Present only for a Windows fault exit whose OS fault read is deferred off
    /// this terminal callback. Carries what the deferred worker needs to complete
    /// the read; its presence is what tells the capture seam to defer the send
    /// rather than emit now with the seeded `deferred` provenance.
    watcher_fault_deferred_read: Option<WatcherFaultDeferredRead>,
    /// Exit-time probe of the runner target the watcher execs. Populated only for
    /// the exec-layer fast-fails whose provenance is in question (126/127 and the
    /// launcher pre-protocol nonzero leg); `None` — reported as `"unknown"` — for
    /// every other exit and for a genuinely unprobeable cache.
    runner_exec_target: Option<RunnerTargetState>,
    /// Whether the pre-spawn gate attempted a bounded repair before this
    /// generation started. Carried independently of the exit-time probe so a
    /// divergent pair is itself diagnostic rather than misleading (TOCTOU-safe).
    runner_target_repair_attempted: bool,
}

impl WatcherExitCaptureContext {
    /// The durable cancellation record's verdict on this exit: `true` only when
    /// the record proves the app itself terminated this watcher, through the exact
    /// four gates the manual-sync boundary applies (cause present, termination
    /// observed, exit shape matching an app teardown, no alertable runner error).
    ///
    /// It deliberately never consults `HEARTBEAT_STALL_TERMINATION_IN_FLIGHT`:
    /// that flag remains a diagnostic extra, never an attribution input. An
    /// ESRCH/lost/timed-out publication leaves `cancellation_termination_effected`
    /// false, so this refuses attribution and the exit stays alertable.
    fn attributed_to_app_teardown(&self, code: Option<i32>, signal: Option<i32>) -> bool {
        watcher_exit_attributed_to_app_teardown(
            code,
            signal,
            self.cancellation_record_cause,
            self.cancellation_termination_effected,
            self.saw_alertable_error,
        )
    }
}

impl Default for WatcherExitCaptureContext {
    fn default() -> Self {
        Self {
            lifecycle_state: "unknown".to_string(),
            app_quit_in_progress: false,
            supervisor_respawn_in_flight: false,
            heartbeat_stall_termination_in_flight: false,
            cancelled: false,
            fatal_runner_signature_seen: false,
            runner_fatal_class: "none".to_string(),
            runner_fatal_syscall: None,
            runner_fatal_errno: None,
            runner_assert_source: None,
            runner_assert_line: None,
            runner_assert_signature: None,
            runner_stdout_line_count: 0,
            runner_node_major: None,
            watcher_job_peak_commit_bucket: "unknown".to_string(),
            watcher_job_process_count: "unknown".to_string(),
            runner_error_rollup: None,
            runner_error_class: "none",
            runner_error_ops: None,
            runner_error_shapes: None,
            runner_error_path_roots: None,
            runner_error_http: None,
            runner_error_causes: None,
            runner_error_scope: None,
            runner_error_companies: 0,
            runner_phase: RUNNER_PHASE_PRE_PROTOCOL.to_string(),
            runner_phase_elapsed_bucket: "under_1m".to_string(),
            watcher_launch_origin: "renderer".to_string(),
            runner_stack_shape: "all_redacted".to_string(),
            runner_stack_signature: "unknown".to_string(),
            runner_stack_depth: 0,
            runner_stack_redacted_frames: 0,
            runner_stack_input: "empty".to_string(),
            runner_oom_banner: None,
            runner_heap_used_mb: None,
            runner_heap_total_mb: None,
            runner_oom_frame_count: None,
            windows_terminator: None,
            cancellation_record_present: false,
            cancellation_record_cause: None,
            cancellation_termination_effected: false,
            saw_alertable_error: false,
            runner_stderr_line_count: None,
            runner_unmatched_stderr_shapes: None,
            // No Windows fault read applies by default (non-Windows, or a clean /
            // non-fault exit); the image/module keep the `unavailable` sentinel.
            watcher_fault_provenance: WatcherFaultProvenance::NotApplicable.as_str().to_string(),
            watcher_fault_faulting_image: WATCHER_FAULT_UNAVAILABLE.to_string(),
            watcher_fault_faulting_module: WATCHER_FAULT_UNAVAILABLE.to_string(),
            watcher_fault_exception_code: None,
            watcher_fault_offset: None,
            watcher_fault_read_counters: None,
            watcher_fault_job_images: None,
            watcher_fault_job_culprit_candidate: None,
            watcher_fault_job_image_provenance: None,
            watcher_fault_deferred_read: None,
            runner_exec_target: None,
            runner_target_repair_attempted: false,
        }
    }
}

#[derive(Debug, Clone)]
struct WatcherPhaseContext {
    phase: &'static str,
    observed_at: Instant,
}

impl Default for WatcherPhaseContext {
    fn default() -> Self {
        Self {
            // Never-observed sentinel, mirroring the manual route: a watcher
            // generation starts here until the runner emits a protocol event.
            phase: RUNNER_PHASE_PRE_PROTOCOL,
            observed_at: Instant::now(),
        }
    }
}

fn observe_watcher_phase_from_event(phase_context: &Mutex<WatcherPhaseContext>, event: &SyncEvent) {
    let now = Instant::now();
    let mut context = phase_context
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match runner_phase_from_event(event) {
        Some(phase) => {
            if context.phase != phase {
                context.phase = phase;
                context.observed_at = now;
            }
        }
        // A parsed protocol event that maps to no work phase still proves the
        // runner emitted protocol, so leave the never-observed sentinel behind
        // (mirrors the manual route): `pre_protocol` means no protocol at all.
        None => {
            if context.phase == RUNNER_PHASE_PRE_PROTOCOL {
                context.phase = "unknown";
                context.observed_at = now;
            }
        }
    }
}

/// Snapshot content-safe state before the exit path mutates lifecycle state.
#[allow(clippy::too_many_arguments)]
fn watcher_exit_capture_context(
    totals: &Mutex<RunTotals>,
    cancelled: bool,
    phase_context: &Mutex<WatcherPhaseContext>,
    generation: &WatcherGeneration,
    process_generation: u64,
    stderr_tail: &[String],
    windows_terminator: Option<WindowsTerminatorAttribution>,
    cancellation_record: Option<CancellationRecord>,
    stdout_line_count: u32,
    node_major: Option<u32>,
    runner_exec_target: Option<RunnerTargetState>,
) -> WatcherExitCaptureContext {
    let totals = totals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let phase_context = phase_context
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Prefer the class-scoped heap-OOM shape when this pass retained one, else the
    // generic tail shape byte-identically — the same seam the manual route uses.
    let stack = runner_stack_shape_for_exit(&totals, stderr_tail);
    // Read the retained Job Object accounting for THIS exact watcher generation
    // BEFORE `run_process_impl` deregisters (and closes) the handle. Resolving by
    // generation means a replacement that already re-acquired DAEMON_HANDLE can
    // never have its memory reported for this exit. Strictly diagnostic — it
    // never closes the handle or changes capture.
    let job_accounting = crate::commands::process::watcher_job_accounting_for_generation(
        DAEMON_HANDLE,
        process_generation,
    );
    finish_watcher_generation(generation);
    WatcherExitCaptureContext {
        lifecycle_state: current_lifecycle_state().as_str().to_string(),
        app_quit_in_progress: app_exit_requested(),
        supervisor_respawn_in_flight: SUPERVISOR_RESPAWN_IN_FLIGHT.load(Ordering::Acquire),
        heartbeat_stall_termination_in_flight: HEARTBEAT_STALL_TERMINATION_IN_FLIGHT
            .load(Ordering::Acquire),
        cancelled,
        fatal_runner_signature_seen: totals.saw_fatal_runner_signature,
        runner_fatal_class: totals.runner_fatal_class.as_str().to_string(),
        runner_fatal_syscall: totals.runner_fatal_syscall().map(|s| s.to_string()),
        runner_fatal_errno: totals.runner_fatal_errno(),
        // Assertion identity from the SAME RunTotals source as the manual route;
        // the capture builder prefers the last actual stderr line and falls back
        // to these (totals reset each watch pass).
        runner_assert_source: totals.runner_assert_source().map(|s| s.to_string()),
        runner_assert_line: totals.runner_assert_line(),
        runner_assert_signature: totals.runner_assert_signature().map(|s| s.to_string()),
        runner_stdout_line_count: stdout_line_count,
        runner_node_major: node_major,
        watcher_job_peak_commit_bucket: job_accounting
            .map(|acc| watcher_job_peak_commit_bucket(acc.peak_process_commit_bytes).to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        watcher_job_process_count: job_accounting
            .map(|acc| acc.total_processes.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        runner_error_rollup: totals.runner_error_rollup.tag_value(),
        runner_error_class: totals.runner_error_rollup.fingerprint_token(),
        runner_error_ops: totals.runner_error_ops.tag_value(),
        // Shared attribution axes — the watcher route reads the SAME RunTotals
        // source as the manual route so the two can never drift apart.
        runner_error_shapes: totals.runner_error_shapes.tag_value(),
        runner_error_path_roots: totals.runner_error_path_roots.tag_value(),
        runner_error_http: totals.runner_error_http.tag_value(),
        runner_error_causes: totals.runner_error_causes.tag_value(),
        runner_error_scope: totals.runner_error_scope(),
        runner_error_companies: totals.runner_error_company_count(),
        runner_phase: phase_context.phase.to_string(),
        runner_phase_elapsed_bucket: runner_phase_elapsed_bucket(
            phase_context.observed_at.elapsed(),
        )
        .to_string(),
        watcher_launch_origin: generation.launch_origin.as_str().to_string(),
        runner_stack_shape: stack.shape,
        runner_stack_signature: stack.signature,
        runner_stack_depth: stack.depth,
        runner_stack_redacted_frames: stack.redacted_frames,
        runner_stack_input: classify_runner_stack_input(stderr_tail)
            .as_str()
            .to_string(),
        // Retained heap-OOM evidence from the SAME RunTotals source the manual
        // route reads, so both routes attach identical heap attribution.
        runner_oom_banner: totals.runner_heap_oom_banner(),
        runner_heap_used_mb: totals.runner_heap_used_total_mb().map(|(used, _)| used),
        runner_heap_total_mb: totals.runner_heap_used_total_mb().map(|(_, total)| total),
        runner_oom_frame_count: totals.runner_heap_oom_frame_count(),
        windows_terminator,
        cancellation_record_present: cancellation_record.is_some(),
        cancellation_record_cause: cancellation_record.and_then(|record| record.cause),
        cancellation_termination_effected: cancellation_record
            .map(|record| record.termination_effected)
            .unwrap_or(false),
        saw_alertable_error: totals.saw_alertable_error,
        // The per-generation stderr diagnostics and Windows fault provenance are
        // filled by the exit callback after this snapshot (they need the exit code
        // and the sampled PID set); default them here so the snapshot is complete.
        runner_stderr_line_count: None,
        runner_unmatched_stderr_shapes: None,
        watcher_fault_provenance: WatcherFaultProvenance::NotApplicable.as_str().to_string(),
        watcher_fault_faulting_image: WATCHER_FAULT_UNAVAILABLE.to_string(),
        watcher_fault_faulting_module: WATCHER_FAULT_UNAVAILABLE.to_string(),
        watcher_fault_exception_code: None,
        watcher_fault_offset: None,
        watcher_fault_read_counters: None,
        watcher_fault_job_images: None,
        watcher_fault_job_culprit_candidate: None,
        watcher_fault_job_image_provenance: None,
        watcher_fault_deferred_read: None,
        runner_exec_target,
        runner_target_repair_attempted: runner_target_repair_attempted(),
    }
}

/// One read of the session-end observer: the attribution capture policy
/// consumes, plus the readiness that explains it. Both are fixed-vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionEndReading {
    attribution: WindowsTerminatorAttribution,
    readiness: &'static str,
}

#[cfg(target_os = "windows")]
fn read_session_end_attribution<R: tauri::Runtime>(app: &AppHandle<R>) -> SessionEndReading {
    match app.try_state::<SessionEndObserverHandle>() {
        Some(observer) => SessionEndReading {
            attribution: observer.tracker().attribution_now(),
            readiness: observer.tracker().readiness().class_name(),
        },
        None => SessionEndReading {
            attribution: WindowsTerminatorAttribution::ObserverUnavailable,
            readiness: "unavailable",
        },
    }
}

#[cfg(target_os = "windows")]
fn current_windows_terminator_attribution<R: tauri::Runtime>(
    app: &AppHandle<R>,
    code: Option<i32>,
    signal: Option<i32>,
) -> Option<WindowsTerminatorAttribution> {
    if code != Some(WINDOWS_SESSION_TERMINATE_EXIT) || signal.is_some() {
        return None;
    }
    // Install the re-read probe from the same handle that produces the reading
    // below, so a deferral created downstream can ask this same observer again
    // once its grace has elapsed. Idempotent, and deliberately sited here: this
    // is the one function that both owns an `AppHandle` and runs before any
    // deferral can exist, so the probe can never be missing when one is.
    install_session_end_attribution_probe(app);
    Some(read_session_end_attribution(app).attribution)
}

#[cfg(not(target_os = "windows"))]
fn current_windows_terminator_attribution<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    _code: Option<i32>,
    _signal: Option<i32>,
) -> Option<WindowsTerminatorAttribution> {
    None
}

/// Re-read the observer after a grace, from wherever the deferral resolves.
///
/// The exit callback owns an `AppHandle`; the bounded task that resolves the
/// deferral does not, and threading one through every watcher-exit signature
/// would put a Tauri handle in the pure decision path. A process-global probe
/// keeps that path handle-free while still asking the real observer.
type SessionEndAttributionProbe = Box<dyn Fn() -> Option<SessionEndReading> + Send + Sync>;

static SESSION_END_ATTRIBUTION_PROBE: OnceLock<SessionEndAttributionProbe> = OnceLock::new();

#[cfg(target_os = "windows")]
fn install_session_end_attribution_probe<R: tauri::Runtime>(app: &AppHandle<R>) {
    if SESSION_END_ATTRIBUTION_PROBE.get().is_some() {
        return;
    }
    let app = app.clone();
    let _ = SESSION_END_ATTRIBUTION_PROBE
        .set(Box::new(move || Some(read_session_end_attribution(&app))));
}

/// The reading a deferral resolves against. `None` means no observer could be
/// consulted at all, which fails closed: the held-back event is sent.
fn current_session_end_reading() -> Option<SessionEndReading> {
    SESSION_END_ATTRIBUTION_PROBE
        .get()
        .and_then(|probe| probe())
}

/// A watcher-exit capture held back while the session-end decision is re-read.
///
/// It carries the payload exactly as the exit path built it. Nothing about the
/// exit itself is deferred — only this send.
#[derive(Debug, Clone)]
struct DeferredSessionEndCapture {
    message: String,
    fingerprint: Vec<String>,
    tags: Vec<(String, String)>,
    extras: Vec<(String, sentry::protocol::Value)>,
    deferred_at: Instant,
    /// `SM_SHUTTINGDOWN` sampled inline at exit-attribution time — the free half
    /// of the pull-based teardown probe. `Unavailable` until a production
    /// deferral stamps it (and on every non-Windows build).
    shuttingdown_at_exit: TeardownShuttingDown,
    /// The concurrently-running System-channel sweep, kicked at registration and
    /// read at resolution. `Unavailable` until a production deferral kicks it.
    teardown_sweep: TeardownSweepHandle,
}

impl DeferredSessionEndCapture {
    fn new(
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    ) -> Self {
        Self {
            message: message.to_string(),
            fingerprint: fingerprint.iter().map(|part| (*part).to_string()).collect(),
            tags: tags
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            extras: extras
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            deferred_at: Instant::now(),
            shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
            teardown_sweep: TeardownSweepHandle::unavailable(),
        }
    }

    /// Record the free exit-time `SM_SHUTTINGDOWN` read. Kept a separate builder
    /// so test payloads built with [`Self::new`] stay unchanged and only
    /// production stamps a real reading.
    fn with_exit_teardown(mut self, shuttingdown_at_exit: TeardownShuttingDown) -> Self {
        self.shuttingdown_at_exit = shuttingdown_at_exit;
        self
    }
}

static PENDING_SESSION_END_CAPTURES: OnceLock<Mutex<Vec<(u64, DeferredSessionEndCapture)>>> =
    OnceLock::new();
static SESSION_END_DEFERRAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn pending_session_end_captures() -> &'static Mutex<Vec<(u64, DeferredSessionEndCapture)>> {
    PENDING_SESSION_END_CAPTURES.get_or_init(|| Mutex::new(Vec::new()))
}

fn register_pending_session_end_capture(payload: DeferredSessionEndCapture) -> u64 {
    let id = SESSION_END_DEFERRAL_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1;
    pending_session_end_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push((id, payload));
    id
}

/// Claim one pending capture. Returns `None` when an exit path already took it,
/// which is what makes a deferral resolve exactly once.
fn take_pending_session_end_capture(id: u64) -> Option<DeferredSessionEndCapture> {
    let mut pending = pending_session_end_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let index = pending
        .iter()
        .position(|(pending_id, _)| *pending_id == id)?;
    Some(pending.remove(index).1)
}

fn take_all_pending_session_end_captures() -> Vec<DeferredSessionEndCapture> {
    pending_session_end_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain(..)
        .map(|(_, payload)| payload)
        .collect()
}

/// Send every capture still held back by a session-end grace.
///
/// The app-initiated quit path calls this. A user who quits a few seconds after
/// a genuine external kill must not silently swallow that alert — and an
/// app-initiated quit is not a session end, so nothing here has been affirmed.
/// Bounded and panic-free: it drains a vector and sends what it took.
pub fn flush_pending_session_end_captures() -> usize {
    let flushed = flush_pending_session_end_captures_with(|payload| {
        let waited_ms = payload
            .deferred_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        // Neither the observer NOR the teardown probe is consulted here. An
        // app-initiated quit is not a session end, so there is nothing to
        // affirm; the probe extras honestly report `unavailable`/`teardown_unknown`
        // and the alert is sent, exactly as it was before the probe existed.
        send_deferred_session_end_capture(
            payload,
            None,
            waited_ms,
            "not_read",
            "app_quit_flush",
            WindowsTeardownVerdict::Unknown,
            WindowsTeardownProbeReading {
                shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
                shuttingdown_at_resolve: TeardownShuttingDown::Unavailable,
                log: TeardownLogReading::Unavailable,
            },
        );
    });
    if flushed > 0 {
        log(
            "daemon",
            &format!("flushed {flushed} deferred session-end watcher capture(s) on app quit"),
        );
    }
    flushed
}

/// The flush itself, with its sender injected. Splitting it here is what lets a
/// test prove the app-quit path SENDS what the session-end path DISCARDS —
/// the asymmetry is the whole point, so it is pinned rather than incidental.
fn flush_pending_session_end_captures_with<F>(mut send: F) -> usize
where
    F: FnMut(DeferredSessionEndCapture),
{
    let pending = take_all_pending_session_end_captures();
    let flushed = pending.len();
    for payload in pending {
        send(payload);
    }
    flushed
}

/// Discard every capture still held back by a session-end grace.
///
/// The Windows session-end teardown calls this: the OS has now told the app
/// directly that the session is ending, which is the affirmation the deferral
/// was waiting for. Bounded and panic-free — it drains a vector and does no
/// I/O, so it adds no uncapped work to a teardown that runs inside a window
/// procedure.
pub fn drop_pending_session_end_captures() -> usize {
    let dropped = take_all_pending_session_end_captures().len();
    if dropped > 0 {
        log(
            "daemon",
            &format!(
                "session-end-observed watcher exit — {dropped} deferred capture(s) dropped \
                 at the Windows session-end teardown"
            ),
        );
    }
    dropped
}

/// Hand a session-end capture to a bounded task that re-reads the attribution
/// once the grace has elapsed.
///
/// Only the Sentry send is deferred. Every inline effect of the exit — the
/// crash counter, the capture-policy streak, the lifecycle transition, the
/// breadcrumb, `process_finished`, `daemon_finished` and the guard-stamp clear
/// — has already run, unchanged, before this is reached. Nothing sleeps inside
/// the exit callback.
fn spawn_deferred_session_end_capture(mut payload: DeferredSessionEndCapture) {
    // Kick the bounded System-channel sweep NOW so it runs concurrently with the
    // grace and has cached a verdict before the resolver reads it. It runs on its
    // own worker thread — off this exit path — and its total budget sits strictly
    // inside the grace, so the deferral still resolves at exactly
    // SESSION_END_GRACE_MS and the probe never extends it.
    payload.teardown_sweep = spawn_teardown_log_sweep();
    let id = register_pending_session_end_capture(payload);
    tauri::async_runtime::spawn(async move {
        // A fixed compile-time grace, not a poll loop and not an unbounded
        // wait: it elapses once and the decision is made.
        tokio::time::sleep(Duration::from_millis(SESSION_END_GRACE_MS)).await;
        resolve_deferred_session_end_capture(id);
    });
}

/// The full resolution of a deferred capture, computed purely from its two
/// re-read evidence sources: the observer's message-derived attribution and the
/// pull-based teardown probe. Extracted from the resolver's I/O so a test can
/// drive the exact recurrence shape without any real syscall or Sentry send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DeferredResolution {
    outcome: DeferredSessionEndOutcome,
    /// The attribution stamped on the resolved payload's `windows_terminator`
    /// tag. `None` only when the observer could not be consulted at all, which
    /// fails closed to a send with the tag left as its exit-time value.
    final_attribution: Option<WindowsTerminatorAttribution>,
    verdict: WindowsTeardownVerdict,
}

/// Combine the re-read observer attribution and the teardown verdict into a
/// single resolution. The Drop/Capture decision and the resolved tag are kept in
/// lockstep by the pure core, so a suppressed alert always carries a suppressing
/// tag and a sent alert always carries a sending one.
fn resolve_deferred_decision(
    reading: Option<SessionEndReading>,
    teardown: WindowsTeardownProbeReading,
) -> DeferredResolution {
    let verdict = windows_teardown_verdict(teardown);
    let outcome = reading
        .map(|reading| deferred_session_end_outcome(reading.attribution, verdict))
        // Fail closed: an observer that cannot be consulted never suppresses.
        .unwrap_or(DeferredSessionEndOutcome::Capture);
    let final_attribution =
        reading.map(|reading| resolved_session_end_attribution(reading.attribution, verdict));
    DeferredResolution {
        outcome,
        final_attribution,
        verdict,
    }
}

/// Resolve one deferral: re-read the observer attribution AND the pull-based OS
/// teardown probe, then either drop the held-back event (Windows affirmed the
/// session end, by message or by probe) or send it unchanged.
fn resolve_deferred_session_end_capture(id: u64) {
    let Some(payload) = take_pending_session_end_capture(id) else {
        // An exit path already claimed it — flushed on an app-initiated quit,
        // or dropped at a Windows session end. Both are deliberate, and neither
        // may resolve twice.
        return;
    };
    let waited_ms = payload
        .deferred_at
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let reading = current_session_end_reading();
    let readiness = reading
        .map(|reading| reading.readiness)
        .unwrap_or("unknown");

    // Second evidence dimension: the exit-time SM_SHUTTINGDOWN read carried on
    // the payload, a fresh resolve-time read six seconds later, and the
    // System-channel sweep that ran concurrently inside the grace. All three
    // reads are free or already complete, so resolution adds no latency.
    let teardown = WindowsTeardownProbeReading {
        shuttingdown_at_exit: payload.shuttingdown_at_exit,
        shuttingdown_at_resolve: sample_shuttingdown(),
        log: payload.teardown_sweep.reading(),
    };
    let resolution = resolve_deferred_decision(reading, teardown);

    match resolution.outcome {
        DeferredSessionEndOutcome::Drop => {
            let waited = session_end_grace_waited_bucket(waited_ms);
            // Name whichever positive source suppressed the alert: an observed
            // message (session_end_observed) or the probe (session_end_probed).
            let terminator = resolution
                .final_attribution
                .map(|attribution| attribution.class_name())
                .unwrap_or("session_end_observed");
            log(
                "daemon",
                &format!(
                    "session-end watcher exit — capture skipped after the grace \
                     (windows_terminator={terminator} observer_readiness={readiness} \
                     grace_waited={waited})"
                ),
            );
            sentry::add_breadcrumb(sentry::Breadcrumb {
                category: Some("daemon.exit".into()),
                level: sentry::Level::Info,
                message: Some(format!(
                    "session-end auto-sync watcher exit: \
                     windows_terminator={terminator} grace_waited={waited}"
                )),
                ..Default::default()
            });
        }
        DeferredSessionEndOutcome::Capture => {
            send_deferred_session_end_capture(
                payload,
                resolution.final_attribution,
                waited_ms,
                readiness,
                "grace_elapsed",
                resolution.verdict,
                teardown,
            );
        }
    }
}

/// Stamp a deferral's resolution onto its held-back payload.
///
/// The message and the fingerprint are untouched, so grouping is exactly what
/// an undeferred capture would have produced. The `windows_terminator` tag is
/// refreshed to the attribution read AFTER the grace, because that is the
/// authoritative answer to "which link of the chain failed"; the reading taken
/// at exit time is preserved alongside it as an extra, so nothing is lost.
fn finalize_deferred_session_end_payload(
    mut payload: DeferredSessionEndCapture,
    final_attribution: Option<WindowsTerminatorAttribution>,
    waited_ms: u64,
    readiness: &str,
    resolution: &str,
    verdict: WindowsTeardownVerdict,
    teardown: WindowsTeardownProbeReading,
) -> DeferredSessionEndCapture {
    let at_exit = payload
        .tags
        .iter()
        .find(|(key, _)| key == "windows_terminator")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "unknown".to_string());

    if let Some(attribution) = final_attribution {
        let class_name = attribution.class_name().to_string();
        // Resolve the index first: taking a mutable iterator into `tags` and
        // pushing to `tags` in the other arm would hold two borrows at once.
        match payload
            .tags
            .iter()
            .position(|(key, _)| key == "windows_terminator")
        {
            Some(index) => payload.tags[index].1 = class_name,
            None => payload
                .tags
                .push(("windows_terminator".to_string(), class_name)),
        }
    }

    for (key, value) in [
        ("session_end_decision", resolution.to_string()),
        ("session_end_attribution_at_exit", at_exit),
        (
            "session_end_grace_waited",
            session_end_grace_waited_bucket(waited_ms).to_string(),
        ),
        ("session_end_observer_readiness", readiness.to_string()),
        // Pull-based teardown probe (HQ-DESKTOP-4N r2): the OS's own answer to
        // "was this a Windows session teardown", independent of any message. All
        // three are fixed content-safe tokens — never a raw event-log fragment.
        (
            "windows_teardown_probe_verdict",
            verdict.class_name().to_string(),
        ),
        (
            "windows_teardown_probe_shuttingdown",
            teardown_shuttingdown_extra(teardown).to_string(),
        ),
        (
            "windows_teardown_probe_log",
            teardown.log.class_name().to_string(),
        ),
    ] {
        payload
            .extras
            .push((key.to_string(), sentry::protocol::Value::String(value)));
    }
    payload
}

/// Summarise the two `SM_SHUTTINGDOWN` reads into one content-safe token for the
/// `windows_teardown_probe_shuttingdown` extra: `yes` if either read positive,
/// `no` only if both read negative, `unavailable` otherwise (e.g. the app-quit
/// flush path, which consults nothing, or a non-Windows build).
fn teardown_shuttingdown_extra(teardown: WindowsTeardownProbeReading) -> &'static str {
    match (
        teardown.shuttingdown_at_exit,
        teardown.shuttingdown_at_resolve,
    ) {
        (TeardownShuttingDown::Yes, _) | (_, TeardownShuttingDown::Yes) => "yes",
        (TeardownShuttingDown::No, TeardownShuttingDown::No) => "no",
        _ => "unavailable",
    }
}

fn send_deferred_session_end_capture(
    payload: DeferredSessionEndCapture,
    final_attribution: Option<WindowsTerminatorAttribution>,
    waited_ms: u64,
    readiness: &str,
    resolution: &str,
    verdict: WindowsTeardownVerdict,
    teardown: WindowsTeardownProbeReading,
) {
    let payload = finalize_deferred_session_end_payload(
        payload,
        final_attribution,
        waited_ms,
        readiness,
        resolution,
        verdict,
        teardown,
    );
    let fingerprint: Vec<&str> = payload.fingerprint.iter().map(String::as_str).collect();
    let tags: Vec<(&str, String)> = payload
        .tags
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    let extras: Vec<(&str, sentry::protocol::Value)> = payload
        .extras
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    let mut effects = ProductionWatcherProcessEffects;
    effects.capture(&payload.message, &fingerprint, &tags, &extras);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred watcher-fault capture (HQ-DESKTOP-4X)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Windows fault record publishes asynchronously seconds after the child
// dies — far later than the terminal exit callback can wait without holding up
// supervisor recovery. So the fault-exit capture's SEND is deferred to a bounded
// worker thread that performs the read OFF the exit path, patches ONLY the
// watcher_fault_* fields with the resolved provenance, and sends. Nothing else
// about the exit — crash counter, lifecycle, capture policy, fingerprint — is
// deferred; all of that already ran, unchanged, before this is reached.
//
// A pending registry lets an app-quit or Windows session-end teardown FLUSH any
// in-flight deferred capture IMMEDIATELY with its current honest `deferred`
// provenance, so a genuine fault event is never lost to the horizon. Unlike the
// session-end capture (which a session end DROPS as benign), a fault capture is
// always emitted — it names a real crash — so BOTH teardown seams flush it.

/// A fault-exit capture held back while its deferred OS fault read runs. It
/// carries the payload exactly as the exit path built it (with the seeded
/// `deferred` provenance) plus the read parameters the worker needs.
#[derive(Debug, Clone)]
struct DeferredWatcherFaultCapture {
    message: String,
    fingerprint: Vec<String>,
    tags: Vec<(String, String)>,
    extras: Vec<(String, sentry::protocol::Value)>,
    read: WatcherFaultDeferredRead,
    deferred_at: Instant,
}

impl DeferredWatcherFaultCapture {
    fn new(
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
        read: WatcherFaultDeferredRead,
    ) -> Self {
        Self {
            message: message.to_string(),
            fingerprint: fingerprint.iter().map(|part| (*part).to_string()).collect(),
            tags: tags
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            extras: extras
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            read,
            deferred_at: Instant::now(),
        }
    }
}

/// The deferred fault-capture registry plus a one-way shutdown latch. The latch is
/// armed by the FIRST teardown flush and closes a shutdown race: once a flush has
/// drained, a watcher-exit callback that was still building its payload could
/// otherwise `register` a fresh ~60s deferral into a vector nothing will ever drain
/// again, silently losing the fault report at shutdown. With the latch, a
/// registration that arrives after a flush is handed back to its caller to emit
/// IMMEDIATELY instead of being deferred. The flag and the vector live under ONE
/// mutex so arming-and-draining is atomic against a concurrent registration.
#[derive(Default)]
struct PendingWatcherFaultRegistry {
    /// Set once a teardown flush has run; never cleared in production (the process
    /// is exiting). A later registration must send immediately, not defer.
    shutting_down: bool,
    items: Vec<(u64, DeferredWatcherFaultCapture)>,
}

static PENDING_WATCHER_FAULT_CAPTURES: OnceLock<Mutex<PendingWatcherFaultRegistry>> =
    OnceLock::new();
static WATCHER_FAULT_DEFERRAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn pending_watcher_fault_captures() -> &'static Mutex<PendingWatcherFaultRegistry> {
    PENDING_WATCHER_FAULT_CAPTURES
        .get_or_init(|| Mutex::new(PendingWatcherFaultRegistry::default()))
}

/// Register a capture for deferred resolution, or — when a teardown flush has
/// already armed the shutdown latch — hand the payload BACK so the caller emits it
/// immediately. `Ok(id)` means it was queued and a worker owns it; `Err(payload)`
/// means shutdown is under way and it must be sent now, never deferred.
fn register_pending_watcher_fault_capture(
    payload: DeferredWatcherFaultCapture,
) -> Result<u64, DeferredWatcherFaultCapture> {
    let mut registry = pending_watcher_fault_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if registry.shutting_down {
        return Err(payload);
    }
    let id = WATCHER_FAULT_DEFERRAL_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1;
    registry.items.push((id, payload));
    Ok(id)
}

/// Claim one pending capture. Returns `None` when a teardown flush already took
/// it, which is what makes a deferral resolve EXACTLY once.
fn take_pending_watcher_fault_capture(id: u64) -> Option<DeferredWatcherFaultCapture> {
    let mut registry = pending_watcher_fault_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let index = registry
        .items
        .iter()
        .position(|(pending_id, _)| *pending_id == id)?;
    Some(registry.items.remove(index).1)
}

/// Arm the shutdown latch AND drain every in-flight capture in one locked step, so
/// no registration can slip in between the arm and the drain. After this returns,
/// every later `register` sees the latch and its caller sends immediately.
fn arm_shutdown_and_drain_pending_watcher_fault_captures() -> Vec<DeferredWatcherFaultCapture> {
    let mut registry = pending_watcher_fault_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.shutting_down = true;
    registry
        .items
        .drain(..)
        .map(|(_, payload)| payload)
        .collect()
}

/// Test-only: clear the registry and disarm the shutdown latch so each test that
/// exercises the shared static starts from a known state.
#[cfg(test)]
fn reset_pending_watcher_fault_registry_for_test() {
    let mut registry = pending_watcher_fault_captures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.shutting_down = false;
    registry.items.clear();
}

/// Emit every deferred fault capture still in flight, IMMEDIATELY, with its
/// current honest `deferred` provenance. Both exit teardowns (app-initiated quit
/// and Windows session end) call this: a fault event names a real crash and must
/// not be lost to the deferral horizon. Bounded and panic-free — it drains a
/// vector and sends what it took, doing NO Event Log work, so it adds no uncapped
/// work to a teardown that may run inside a Windows window procedure.
pub fn flush_pending_watcher_fault_captures(reason: &str) -> usize {
    let flushed = flush_pending_watcher_fault_captures_with(|payload| {
        // The read never completed; keep the seeded `deferred` provenance and
        // stamp WHY it is being sent now (which teardown seam) so the event is
        // self-explaining.
        send_deferred_watcher_fault_capture(payload, None, reason);
    });
    if flushed > 0 {
        log(
            "daemon",
            &format!("flushed {flushed} deferred watcher-fault capture(s) at {reason}"),
        );
    }
    flushed
}

/// The flush itself, with its sender injected so a test can prove exactly-once
/// draining without writing a real Sentry event.
fn flush_pending_watcher_fault_captures_with<F>(mut send: F) -> usize
where
    F: FnMut(DeferredWatcherFaultCapture),
{
    let pending = arm_shutdown_and_drain_pending_watcher_fault_captures();
    let flushed = pending.len();
    for payload in pending {
        send(payload);
    }
    flushed
}

/// Extra the OUTER supervisor waits beyond the reader's own bounded horizon before
/// giving up on a verdict. `read_watcher_fault` polls under its own deadline, but
/// the wevtapi calls it makes (`EvtQuery`/`EvtRender`) take NO timeout — only
/// `EvtNext` does — so a stalled Event Log service could wedge the reader thread
/// past its deadline and it would never return. This grace cleanly separates a
/// normal slow return (≤ budget + one sweep) from a genuine wedge.
const WATCHER_FAULT_READ_SUPERVISOR_GRACE: Duration = Duration::from_secs(5);

/// Hand a fault capture to a bounded worker that performs the deferred OS fault
/// read OFF the exit path, then resolves and sends it. Two guards make it robust:
///
/// 1. **Shutdown barrier.** If a teardown flush already armed the latch,
///    `register` returns the payload back and it is sent IMMEDIATELY rather than
///    deferred into a registry nothing will drain again — so a shutdown that races
///    a just-detected fault cannot lose the report.
/// 2. **Outer supervisor bound.** The blocking read runs on an INNER thread and
///    reports over a channel; a supervisor waits at most `budget + grace` for the
///    verdict and then claims and sends the capture itself with honest unresolved
///    provenance. A wevtapi call with no timeout can therefore never hang the
///    capture forever or leak the pending payload — the wedged reader thread is
///    abandoned (never joined); it holds no lock and is bounded in count by fault
///    frequency. std threads (not tokio tasks): nothing awaits them and the exit
///    callback has already fully returned.
fn spawn_deferred_watcher_fault_capture(payload: DeferredWatcherFaultCapture) {
    let read = payload.read.clone();
    let id = match register_pending_watcher_fault_capture(payload) {
        Ok(id) => id,
        Err(payload) => {
            // Teardown latch already armed: emit now with honest `deferred`
            // provenance instead of deferring into an abandoned registry.
            send_deferred_watcher_fault_capture(payload, None, "shutdown_immediate");
            return;
        }
    };
    let _supervisor = std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        // Inner reader — may block in a timeout-less wevtapi call if the Event Log
        // service stalls. Abandoned if it outlasts the supervisor bound below.
        let _reader = std::thread::spawn(move || {
            let outcome = crate::commands::process::read_watcher_fault(
                &read.sampled_pids,
                read.exception_code,
                read.gen_start_ms,
                read.gen_end_ms,
                crate::commands::process::deferred_watcher_fault_budget(),
            );
            // Ignore a send error: the supervisor may have already timed out and
            // dropped the receiver, in which case the capture has already shipped.
            let _ = tx.send(outcome);
        });
        // Bounded outer wait: a verdict, or the supervisor deadline, whichever
        // comes first. `None` means the reader wedged or died before reporting.
        let bound = crate::commands::process::deferred_watcher_fault_budget()
            + WATCHER_FAULT_READ_SUPERVISOR_GRACE;
        let outcome = rx.recv_timeout(bound).ok();
        // Claim send-rights EXACTLY once. If a teardown flush already claimed it,
        // this is a no-op — the event has already shipped with honest provenance.
        if let Some(payload) = take_pending_watcher_fault_capture(id) {
            let resolution = if outcome.is_some() {
                "read_resolved"
            } else {
                "read_supervisor_timeout"
            };
            send_deferred_watcher_fault_capture(payload, outcome, resolution);
        }
    });
}

/// Patch ONLY the `watcher_fault_*` fields of a held-back payload with a resolved
/// read outcome (or keep the seeded `deferred` provenance when the read did not
/// complete) and stamp the resolution and deferral latency. Pure so a test can
/// prove the patch without writing a real Sentry event. The message and
/// fingerprint are untouched, so grouping is exactly what an immediate capture
/// would have produced — only the watcher_fault_* fields and the resolution
/// markers differ.
fn finalize_watcher_fault_payload(
    mut payload: DeferredWatcherFaultCapture,
    outcome: Option<hq_desktop_core::watcher_fault::WatcherFaultOutcome>,
    resolution: &str,
) -> DeferredWatcherFaultCapture {
    if let Some(outcome) = outcome {
        set_payload_tag(
            &mut payload.tags,
            "watcher_fault_provenance",
            outcome.provenance_token().to_string(),
        );
        set_payload_tag(
            &mut payload.tags,
            "watcher_fault_faulting_image",
            outcome.image_token().to_string(),
        );
        set_payload_tag(
            &mut payload.tags,
            "watcher_fault_faulting_module",
            outcome.module_token().to_string(),
        );
        set_payload_tag(&mut payload.tags, "watcher_fault_read", outcome.counters_tag());
        set_payload_string_extra(
            &mut payload.extras,
            "watcher_fault_exception_code",
            outcome.exception_code.map(|code| code.to_string()),
        );
        set_payload_string_extra(
            &mut payload.extras,
            "watcher_fault_offset",
            outcome.fault_offset.map(|offset| offset.to_string()),
        );
    }
    let waited_ms = payload
        .deferred_at
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    payload.extras.push((
        "watcher_fault_read_resolution".to_string(),
        sentry::protocol::Value::String(resolution.to_string()),
    ));
    payload.extras.push((
        "watcher_fault_deferred_ms".to_string(),
        sentry::protocol::Value::Number(waited_ms.into()),
    ));
    payload
}

fn send_deferred_watcher_fault_capture(
    payload: DeferredWatcherFaultCapture,
    outcome: Option<hq_desktop_core::watcher_fault::WatcherFaultOutcome>,
    resolution: &str,
) {
    let payload = finalize_watcher_fault_payload(payload, outcome, resolution);
    let fingerprint: Vec<&str> = payload.fingerprint.iter().map(String::as_str).collect();
    let tags: Vec<(&str, String)> = payload
        .tags
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    let extras: Vec<(&str, sentry::protocol::Value)> = payload
        .extras
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    let mut effects = ProductionWatcherProcessEffects;
    effects.capture(&payload.message, &fingerprint, &tags, &extras);
}

/// Overwrite (or insert) one tag in a held-back payload's tag list.
fn set_payload_tag(tags: &mut Vec<(String, String)>, key: &str, value: String) {
    match tags.iter().position(|(existing, _)| existing == key) {
        Some(index) => tags[index].1 = value,
        None => tags.push((key.to_string(), value)),
    }
}

/// Set or remove one string extra in a held-back payload. `None` removes the key
/// so an unresolved read never carries a stale code/offset.
fn set_payload_string_extra(
    extras: &mut Vec<(String, sentry::protocol::Value)>,
    key: &str,
    value: Option<String>,
) {
    extras.retain(|(existing, _)| existing != key);
    if let Some(value) = value {
        extras.push((key.to_string(), sentry::protocol::Value::String(value)));
    }
}

/// Effects used by the production watcher handlers.
///
/// Keeping crash state, lifecycle, logging, breadcrumbs and capture behind one
/// small seam lets process-level tests drive the exact production decisions
/// without writing real Sentry events or mutating the global supervisor state.
trait WatcherProcessEffects {
    fn note_watcher_crashed(&mut self) -> u32;
    fn note_watcher_capture_policy_streak(
        &mut self,
        policy: WatcherExitCapturePolicy,
        global_consecutive: u32,
    ) -> u32;
    fn reset_exec_not_runnable_failure_streak(&mut self);
    fn within_respawn_backoff(&self) -> bool;
    fn set_lifecycle_state(&mut self, next: WatchDaemonState, category: DaemonFailureCategory);
    fn watcher_exit_diagnostics(
        &self,
    ) -> (Option<Duration>, Option<u64>, Option<Duration>, Option<RssSampleKind>);
    fn log(&mut self, target: &str, message: &str);
    fn add_breadcrumb(&mut self, category: &str, level: sentry::Level, message: String);
    fn capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    );
    /// Hold this capture back for [`SESSION_END_GRACE_MS`], then re-read the
    /// session-end attribution and either drop it or send it. Never cancels a
    /// capture on its own.
    fn defer_session_end_capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    );
    /// Hold this fault-exit capture back while the deferred OS fault read runs off
    /// the terminal callback (HQ-DESKTOP-4X). The worker patches ONLY the
    /// `watcher_fault_*` fields with the resolved provenance, then sends; a
    /// teardown flush may preempt it and send the honest `deferred` provenance.
    /// Never cancels a capture on its own.
    fn defer_watcher_fault_capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
        read: WatcherFaultDeferredRead,
    );
}

struct ProductionWatcherProcessEffects;

impl WatcherProcessEffects for ProductionWatcherProcessEffects {
    fn note_watcher_crashed(&mut self) -> u32 {
        note_watcher_crashed()
    }

    fn note_watcher_capture_policy_streak(
        &mut self,
        policy: WatcherExitCapturePolicy,
        global_consecutive: u32,
    ) -> u32 {
        note_watcher_capture_policy_streak(policy, global_consecutive)
    }

    fn reset_exec_not_runnable_failure_streak(&mut self) {
        reset_exec_not_runnable_failure_streak();
    }

    fn within_respawn_backoff(&self) -> bool {
        within_respawn_backoff()
    }

    fn set_lifecycle_state(&mut self, next: WatchDaemonState, category: DaemonFailureCategory) {
        set_lifecycle_state(next, category);
    }

    fn watcher_exit_diagnostics(
        &self,
    ) -> (Option<Duration>, Option<u64>, Option<Duration>, Option<RssSampleKind>) {
        watcher_exit_diagnostics()
    }

    fn log(&mut self, target: &str, message: &str) {
        log(target, message);
    }

    fn add_breadcrumb(&mut self, category: &str, level: sentry::Level, message: String) {
        sentry::add_breadcrumb(sentry::Breadcrumb {
            category: Some(category.into()),
            level,
            message: Some(message),
            ..Default::default()
        });
    }

    fn capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    ) {
        if tags.is_empty() && extras.is_empty() {
            crate::commands::sync::capture_sync_error_with_fingerprint(
                None,
                "(auto-sync)",
                message,
                fingerprint,
            );
        } else {
            crate::commands::sync::capture_sync_error_with_fingerprint_and_context(
                None,
                "(auto-sync)",
                message,
                fingerprint,
                tags,
                extras,
            );
        }
    }

    fn defer_session_end_capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    ) {
        // The free half of the probe: sample SM_SHUTTINGDOWN inline in the exit
        // callback (a handle-free syscall, the only new work permitted here) so a
        // teardown already flagged at exit is on record. The bounded event-log
        // sweep is kicked off this path, at registration, by
        // `spawn_deferred_session_end_capture`.
        spawn_deferred_session_end_capture(
            DeferredSessionEndCapture::new(message, fingerprint, tags, extras)
                .with_exit_teardown(sample_shuttingdown()),
        );
    }

    fn defer_watcher_fault_capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
        read: WatcherFaultDeferredRead,
    ) {
        spawn_deferred_watcher_fault_capture(DeferredWatcherFaultCapture::new(
            message,
            fingerprint,
            tags,
            extras,
            read,
        ));
    }
}

/// Fixed-vocabulary bucket for a Job Object's peak per-process COMMITTED memory
/// (`PeakProcessMemoryUsed` is the peak commit charge, not the working set —
/// see `WatcherJobAccounting`). Buckets (never raw bytes) keep the channel
/// content-safe and stable: a V8 heap-OOM abort commits a large charge and lands
/// in a high bucket while a small-footprint abort lands in `under_128mb`, so the
/// two become separable even though the registered child is the cmd.exe shim.
fn watcher_job_peak_commit_bucket(peak_process_commit_bytes: u64) -> &'static str {
    const MB: u64 = 1024 * 1024;
    match peak_process_commit_bytes / MB {
        0..=127 => "under_128mb",
        128..=511 => "128mb_to_512mb",
        512..=1023 => "512mb_to_1gb",
        1024..=2047 => "1gb_to_2gb",
        _ => "over_2gb",
    }
}

/// What the registered/waited/sampled watcher process actually is, relative to
/// the Node runner it stands in for. Derived from the spawn program basename
/// (matching `runner_exec_resolution`):
/// - `cmd_shim`: a `.cmd`/`.bat` batch shim (e.g. `npx.cmd`) that Rust's
///   `std::process::Command` dispatches through `cmd.exe` — the registered child
///   is the shim, not the runner.
/// - `launcher`: a direct `npx` executable. `build_watch_runner_args` always
///   launches `npx`, which resolves and spawns `hq-sync-runner` as a DESCENDANT,
///   so the registered PID is still not the runner itself.
/// - `direct_executable`: anything else (a hypothetical direct runner binary).
///
/// So `last_rss` and the exit status are never read as the runner's own for the
/// npx-based watcher. Returns a fixed constant; no command bytes escape.
fn watcher_child_kind(watcher_command: &str) -> &'static str {
    let program = watcher_command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if program.ends_with(".cmd") || program.ends_with(".bat") {
        "cmd_shim"
    } else if program == "npx" || program == "npx.exe" {
        "launcher"
    } else {
        "direct_executable"
    }
}

/// Which process the sampled RSS actually describes: the `cmd.exe` `shim`, a
/// direct npx `launcher`, or the `runner` directly. `shim`/`launcher` both mean
/// the sampled PID is not the runner. Reuses PR #360's `shim`/`runner` spelling
/// and extends it for the launcher case.
fn rss_scope(watcher_command: &str) -> &'static str {
    match watcher_child_kind(watcher_command) {
        "cmd_shim" => "shim",
        "launcher" => "launcher",
        _ => "runner",
    }
}

/// The RSS scope actually emitted (HQ-DESKTOP-55): `tree` when the summed
/// descendant sample succeeded, else today's command-derived scope for a
/// single-PID sample or no sample. `runner` is never produced by inference — it
/// stays reserved for the command shape whose registered child IS the runner, so
/// a launcher/shim single-PID footprint can never be mislabeled the runner's.
fn resolve_rss_scope(kind: Option<RssSampleKind>, watcher_command: &str) -> &'static str {
    match kind {
        Some(RssSampleKind::Tree) => "tree",
        Some(RssSampleKind::Single) | None => rss_scope(watcher_command),
    }
}

fn handle_watcher_exit(
    code: Option<i32>,
    signal: Option<i32>,
    success: bool,
    cancelled: bool,
    watcher_command: &str,
    last_stderr: Option<&str>,
    context: &WatcherExitCaptureContext,
) {
    let mut effects = ProductionWatcherProcessEffects;
    handle_watcher_exit_with_effects(
        &mut effects,
        code,
        signal,
        success,
        cancelled,
        watcher_command,
        last_stderr,
        current_termination_host(),
        context,
    );
}

fn handle_watcher_exit_with_effects<E: WatcherProcessEffects>(
    effects: &mut E,
    code: Option<i32>,
    signal: Option<i32>,
    success: bool,
    cancelled: bool,
    watcher_command: &str,
    last_stderr: Option<&str>,
    host: TerminationHost,
    context: &WatcherExitCaptureContext,
) {
    if cancelled {
        // Deliberate stop path already recorded lifecycle.
        effects.reset_exec_not_runnable_failure_streak();
        return;
    }

    if context.attributed_to_app_teardown(code, signal) {
        // The durable cancellation record proves the app's own watchdog tore this
        // watcher down, even though the ephemeral `cancelled` flag was lost before
        // this terminal read (a post-revocation entry drop). Take the exact same
        // silent path as the ephemeral-flag stop above: `terminate` already
        // recorded the lifecycle transition, so this is not a new event, not a
        // lifecycle change, and never references the stall in-flight flag.
        effects.reset_exec_not_runnable_failure_streak();
        return;
    }

    if !is_unexpected_watcher_exit(success, signal, cancelled) {
        effects.reset_exec_not_runnable_failure_streak();
        effects.set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
        return;
    }

    let consecutive = effects.note_watcher_crashed();
    let capture_policy = if is_benign_watcher_exit(code, signal) {
        WatcherExitCapturePolicy::LocalLogOnly
    } else {
        watcher_exit_capture_policy_with_attribution(code, signal, context.windows_terminator)
    };
    let policy_consecutive =
        effects.note_watcher_capture_policy_streak(capture_policy, consecutive);
    let lifecycle_state = if effects.within_respawn_backoff() {
        WatchDaemonState::Backoff
    } else {
        WatchDaemonState::Stopped
    };
    effects.set_lifecycle_state(
        lifecycle_state,
        if capture_policy == WatcherExitCapturePolicy::LocalLogOnly {
            DaemonFailureCategory::None
        } else {
            DaemonFailureCategory::Crash
        },
    );
    record_unexpected_watcher_exit(
        effects,
        code,
        signal,
        consecutive,
        policy_consecutive,
        capture_policy,
        watcher_command,
        last_stderr,
        host,
        context,
    );
}

/// Record one unexpected watcher exit after the lifecycle path has determined
/// its consecutive-failure count. Pure policy stays in hq-desktop-core; this is
/// the only app-facing Sentry seam.
fn record_unexpected_watcher_exit<E: WatcherProcessEffects>(
    effects: &mut E,
    code: Option<i32>,
    signal: Option<i32>,
    consecutive: u32,
    policy_consecutive: u32,
    capture_policy: WatcherExitCapturePolicy,
    watcher_command: &str,
    last_stderr: Option<&str>,
    host: TerminationHost,
    context: &WatcherExitCaptureContext,
) {
    if capture_policy == WatcherExitCapturePolicy::LocalLogOnly {
        if code == Some(WINDOWS_SESSION_TERMINATE_EXIT)
            && signal.is_none()
            && context.windows_terminator == Some(WindowsTerminatorAttribution::SessionEndObserved)
        {
            effects.log(
                "daemon",
                &format!("session-end-observed watcher exit #{consecutive} — capture skipped"),
            );
            effects.add_breadcrumb(
                "daemon.exit",
                sentry::Level::Info,
                format!(
                    "session-end-observed auto-sync watcher exit #{consecutive}: \
                     windows_terminator=session_end_observed"
                ),
            );
        } else {
            effects.log(
                "daemon",
                &format!(
                    "environmental watcher exit #{consecutive} — capture skipped \
                     (code={code:?} signal={signal:?})"
                ),
            );
            effects.add_breadcrumb(
                "daemon.exit",
                sentry::Level::Info,
                format!(
                    "environmental auto-sync watcher exit #{consecutive}: \
                     code={code:?} signal={signal:?}"
                ),
            );
        }
        return;
    }

    if !should_capture_watcher_exit(capture_policy, policy_consecutive) {
        effects.log(
            "daemon",
            &format!(
                "watcher exit #{consecutive} — capture rate-limited \
                 (code={code:?} signal={signal:?})"
            ),
        );
        if capture_policy == WatcherExitCapturePolicy::CaptureRateLimited {
            effects.add_breadcrumb(
                "daemon.exit",
                sentry::Level::Info,
                format!(
                    "exec-not-runnable auto-sync watcher exit #{policy_consecutive}: \
                     code={code:?} signal={signal:?}"
                ),
            );
        }
        return;
    }

    let (uptime, rss_kb, rss_age, rss_kind) = effects.watcher_exit_diagnostics();
    // The emitted scope: `tree` only when the descendant-sum sample succeeded, else
    // today's command-derived scope. `runner` is never produced by inference.
    let resolved_rss_scope = resolve_rss_scope(rss_kind, watcher_command);
    let diag = exit_diagnostic_suffix(uptime, rss_kb, rss_age, resolved_rss_scope);
    let raw_fingerprint_token = termination_fingerprint_token(code, signal);
    let fingerprint_token = termination_fingerprint_token_for_host(code, signal, host);
    let runner_error_class = safe_runner_error_fingerprint_token(context.runner_error_class);
    let fingerprint = [
        "sync",
        "auto-sync-watcher-termination",
        fingerprint_token.as_str(),
        runner_error_class,
    ];
    let windows_termination = code
        .map(classify_windows_exit_status)
        .filter(|termination| termination.is_windows_status());
    let normalized_abort = normalized_abort_description(code, signal, host);
    let message = if let Some(exit_description) = normalized_abort {
        format!(
            "auto-sync watcher exited unexpectedly ({exit_description}), \
             consecutive failure #{consecutive}{diag}"
        )
    } else if windows_termination.is_some() {
        let exit_description = describe_exit(code, signal);
        format!(
            "auto-sync watcher exited unexpectedly ({exit_description}), \
             consecutive failure #{consecutive}{diag}"
        )
    } else {
        format!(
            "auto-sync watcher exited unexpectedly (code={code:?} signal={signal:?}), \
             consecutive failure #{consecutive}{diag}"
        )
    };

    // Prefer the last actual stderr line's signature (class + libuv syscall +
    // errno) when it recognises a fatal shape, else fall back to the run's
    // accumulated context. All three come from one source so they always
    // describe the same line — the same discipline the manual route uses.
    let last_stderr_signature = last_stderr
        .map(classify_runner_fatal_signature)
        .filter(|signature| signature.class.seen());
    let (runner_fatal_class, runner_fatal_syscall, runner_fatal_errno) =
        match last_stderr_signature {
            Some(signature) => (
                signature.class.as_str().to_string(),
                signature.syscall.map(|syscall| syscall.to_string()),
                signature.errno,
            ),
            None => (
                context.runner_fatal_class.clone(),
                context.runner_fatal_syscall.clone(),
                context.runner_fatal_errno,
            ),
        };
    let runner_fatal_class_seen = runner_fatal_class != "none";

    // Assertion identity (HQ-DESKTOP-50), derived from the SAME source as the
    // fatal class above so all four describe one line: prefer the last actual
    // stderr line, else the run's accumulated context. Manual/watcher parity is
    // guaranteed by both routes reading `runner_assertion_for_class`.
    let (runner_assert_source, runner_assert_line, runner_assert_signature) =
        match last_stderr_signature {
            Some(signature) => match last_stderr
                .and_then(|line| runner_assertion_for_class(signature.class, line))
            {
                Some(assertion) => (
                    Some(assertion.source.to_string()),
                    assertion.line,
                    Some(assertion.signature),
                ),
                None => (None, None, None),
            },
            None => (
                context.runner_assert_source.clone(),
                context.runner_assert_line,
                context.runner_assert_signature.clone(),
            ),
        };

    let mut tags = vec![
        ("runner_fatal_class", runner_fatal_class),
        ("sync_route", "watcher".to_string()),
        ("runner_stack_shape", context.runner_stack_shape.clone()),
        (
            "runner_stack_signature",
            context.runner_stack_signature.clone(),
        ),
    ];
    // Symmetric with the manual route: attach the libuv syscall + errno wherever
    // runner_fatal_class is attached. Both are fixed/integer; absent when the
    // fatal class is not a libuv fatal syscall.
    if let Some(syscall) = runner_fatal_syscall {
        tags.push(("runner_fatal_syscall", syscall));
    }
    if let Some(errno) = runner_fatal_errno {
        tags.push(("runner_fatal_errno", errno.to_string()));
    }
    // Symmetric with the manual route: attach the assertion source + expression
    // signature wherever the fatal class is. Fixed vocabulary + 16-hex digest;
    // absent unless the fatal class is an assertion class.
    if let Some(source) = runner_assert_source {
        tags.push(("runner_assert_source", source));
    }
    if let Some(signature) = runner_assert_signature {
        tags.push(("runner_assert_signature", signature));
    }
    // Whole-tree Job Object memory + process count, plus the child-kind/rss-scope
    // labels: a heap-OOM abort becomes separable from a small-footprint one, and
    // last_rss / the exit status are never re-read as the runner's own. Fixed
    // vocabulary throughout; `unknown` when the job query was unavailable.
    tags.push((
        "watcher_job_peak_commit_bucket",
        context.watcher_job_peak_commit_bucket.clone(),
    ));
    tags.push((
        "watcher_job_process_count",
        context.watcher_job_process_count.clone(),
    ));
    tags.push((
        "watcher_child_kind",
        watcher_child_kind(watcher_command).to_string(),
    ));
    tags.push(("rss_scope", resolved_rss_scope.to_string()));
    // V8 heap-OOM banner (HQ-DESKTOP-55), only when this pass retained one. A
    // fixed constant; absent otherwise so absence never renders as evidence.
    if let Some(banner) = context.runner_oom_banner {
        tags.push(("runner_oom_banner", banner.to_string()));
    }
    // Windows fault provenance (HQ-DESKTOP-4X): the faulting image + module read
    // from the OS's own crash record, plus an honesty token for how confidently
    // the record is bound to this generation. Always present so `unavailable` (no
    // reader ran) and `no_record` (reader ran, nothing bound) stay visibly
    // distinct from a real `pid_matched`/`window_only` attribution.
    tags.push((
        "watcher_fault_provenance",
        context.watcher_fault_provenance.clone(),
    ));
    tags.push((
        "watcher_fault_faulting_image",
        context.watcher_fault_faulting_image.clone(),
    ));
    tags.push((
        "watcher_fault_faulting_module",
        context.watcher_fault_faulting_module.clone(),
    ));
    // Bounded read counters (`seen:N,parsed:N,...`), so a second failure states
    // exactly why attribution failed rather than repeating a blind retry. Only
    // present for a fault exit whose read was performed/deferred.
    if let Some(counters) = &context.watcher_fault_read_counters {
        tags.push(("watcher_fault_read", counters.clone()));
    }
    // WER-independent job-image tree observation: names a culprit CANDIDATE from
    // the app's own process-tree sampling even when WER contributes no record.
    // Its own provenance token marks it a tree observation, never an attribution;
    // absent when nothing was sampled alive, so absence never renders as evidence.
    if let Some(images) = &context.watcher_fault_job_images {
        tags.push(("watcher_fault_job_images", images.clone()));
    }
    if let Some(candidate) = &context.watcher_fault_job_culprit_candidate {
        tags.push(("watcher_fault_job_culprit_candidate", candidate.clone()));
    }
    if let Some(provenance) = &context.watcher_fault_job_image_provenance {
        tags.push(("watcher_fault_job_image_provenance", provenance.clone()));
    }
    // Structural rollup of stderr lines the fatal classifier did not recognise,
    // so "silent" is separable from "noisy but unrecognised". Only when nonempty.
    if let Some(shapes) = &context.runner_unmatched_stderr_shapes {
        tags.push(("runner_unmatched_stderr_shapes", shapes.clone()));
    }
    if let (Some(code), Some(termination)) = (code, windows_termination) {
        tags.push(("windows_exit_status", windows_exit_status_hex(code)));
        tags.push(("windows_exit_class", termination.class_name().to_string()));
    }
    if let Some(code) = code {
        if let Some(symbol) = windows_fault_symbol(code) {
            tags.push(("windows_fault_symbol", symbol.to_string()));
        }
    }
    if let Some(rollup) = &context.runner_error_rollup {
        tags.push(("runner_error_rollup", rollup.clone()));
    }
    if let Some(operations) = &context.runner_error_ops {
        tags.push(("runner_error_ops", operations.clone()));
    }
    if let Some(shapes) = &context.runner_error_shapes {
        tags.push(("runner_error_shapes", shapes.clone()));
    }
    if let Some(path_roots) = &context.runner_error_path_roots {
        tags.push(("runner_error_path_roots", path_roots.clone()));
    }
    // Route parity: the manual seam emits these two from the same RunTotals
    // source, so the watcher route must too or the routes would disagree.
    if let Some(http) = &context.runner_error_http {
        tags.push(("runner_error_http", http.clone()));
    }
    if let Some(causes) = &context.runner_error_causes {
        tags.push(("runner_error_causes", causes.clone()));
    }
    if code == Some(WINDOWS_SESSION_TERMINATE_EXIT) && signal.is_none() {
        if let Some(attribution) = context.windows_terminator {
            tags.push(("windows_terminator", attribution.class_name().to_string()));
        }
    }

    let mut extras = watcher_exit_context_extras(context, runner_fatal_class_seen);
    // The integer source line for an assertion abort, kept consistent with the
    // source/signature computed above (present only when an assertion parsed).
    if let Some(line) = runner_assert_line {
        extras.push((
            "runner_assert_line",
            sentry::protocol::Value::Number(line.into()),
        ));
    }
    if normalized_abort.is_some() {
        extras.push((
            "termination_status_raw",
            sentry::protocol::Value::String(raw_fingerprint_token),
        ));
    }
    if let Some(exec_extras) = runner_exec_provenance_extras(code, watcher_command, context) {
        extras.extend(exec_extras);
    }
    // Per-event attribution ONLY: the exec-not-runnable streak that released this
    // rate-limited capture. It reveals how many suppressed same-class failures
    // preceded this one (first capture at 4, then power-of-two milestones).
    // Emitted solely on CaptureRateLimited (126/127) captures, and makes NO
    // cross-issue correlation claim: a non-126/127 exit resets the streak by
    // design, so it cannot span a 190→127 episode. Episode correlation is
    // carried by the global consecutive counter printed in the event message.
    if capture_policy == WatcherExitCapturePolicy::CaptureRateLimited {
        extras.push((
            "exec_not_runnable_streak",
            sentry::protocol::Value::Number(policy_consecutive.into()),
        ));
    }
    if is_unrecognized_watcher_exit(code, signal) {
        extras.extend(unrecognized_watcher_exit_extras());
    }

    // The only branch: a session-terminate exit the observer could not yet
    // attribute holds its SEND back for the grace and asks again. Everything
    // about the payload — message, fingerprint, tags, extras — is already
    // built and is handed over exactly as an immediate capture would send it.
    if capture_policy == WatcherExitCapturePolicy::DeferSessionEndDecision {
        effects.log(
            "daemon",
            &format!(
                "session-terminate watcher exit #{consecutive} — capture deferred \
                 {SESSION_END_GRACE_MS}ms pending session-end attribution"
            ),
        );
        effects.defer_session_end_capture(&message, &fingerprint, &tags, &extras);
        return;
    }
    // A Windows fault exit whose OS fault read was deferred off the terminal
    // callback (HQ-DESKTOP-4X): hand the fully-built payload to the deferred
    // worker, which performs the bounded read, patches ONLY the watcher_fault_*
    // fields with the resolved provenance, and sends. If a teardown flush preempts
    // it, the event still ships with the honest `deferred` provenance. Capture
    // policy, fingerprint, message, and every other tag/extra are already decided
    // and unchanged — only WHEN this event is sent and WHAT provenance it carries
    // differ from an immediate send.
    if let Some(read) = &context.watcher_fault_deferred_read {
        effects.defer_watcher_fault_capture(&message, &fingerprint, &tags, &extras, read.clone());
        return;
    }
    effects.capture(&message, &fingerprint, &tags, &extras);
}

/// Context is constructed from the core's closed-vocabulary rollup. Keep this
/// fail-closed boundary so a future caller cannot place arbitrary runner text
/// in a Sentry fingerprint through a manually-constructed context.
fn safe_runner_error_fingerprint_token(candidate: &'static str) -> &'static str {
    match candidate {
        "eperm" | "eacces" | "enospc" | "ebusy" | "network" | "auth" | "other" | "none" => {
            candidate
        }
        _ => "none",
    }
}

fn watcher_exit_context_extras(
    context: &WatcherExitCaptureContext,
    runner_fatal_class_seen: bool,
) -> Vec<(&'static str, sentry::protocol::Value)> {
    let mut extras = vec![
        (
            "watcher_lifecycle_state",
            sentry::protocol::Value::String(context.lifecycle_state.clone()),
        ),
        (
            "app_quit_in_progress",
            sentry::protocol::Value::String(context.app_quit_in_progress.to_string()),
        ),
        (
            "supervisor_respawn_in_flight",
            sentry::protocol::Value::String(context.supervisor_respawn_in_flight.to_string()),
        ),
        (
            "heartbeat_stall_termination_in_flight",
            sentry::protocol::Value::String(
                context.heartbeat_stall_termination_in_flight.to_string(),
            ),
        ),
        (
            "watcher_cancelled",
            sentry::protocol::Value::String(context.cancelled.to_string()),
        ),
        (
            "fatal_runner_signature_seen",
            sentry::protocol::Value::String(context.fatal_runner_signature_seen.to_string()),
        ),
        (
            "runner_fatal_class_seen",
            sentry::protocol::Value::Bool(runner_fatal_class_seen),
        ),
        (
            "runner_error_companies",
            sentry::protocol::Value::Number(context.runner_error_companies.into()),
        ),
        (
            "runner_phase",
            sentry::protocol::Value::String(context.runner_phase.clone()),
        ),
        (
            "runner_phase_elapsed_bucket",
            sentry::protocol::Value::String(context.runner_phase_elapsed_bucket.clone()),
        ),
        // Mirrors the manual route: stdout (protocol) line count and the runner's
        // Node major, so "died before any work" and the runtime provenance land
        // on the watcher route too.
        (
            "runner_stdout_line_count",
            sentry::protocol::Value::Number(context.runner_stdout_line_count.into()),
        ),
        (
            "runner_node_major",
            match context.runner_node_major {
                Some(major) => sentry::protocol::Value::String(major.to_string()),
                None => sentry::protocol::Value::String("unknown".to_string()),
            },
        ),
        (
            "watcher_launch_origin",
            sentry::protocol::Value::String(context.watcher_launch_origin.clone()),
        ),
        (
            "runner_stack_depth",
            serde_json::json!(context.runner_stack_depth),
        ),
        (
            "runner_stack_redacted_frames",
            serde_json::json!(context.runner_stack_redacted_frames),
        ),
        (
            "cancellation_record_present",
            sentry::protocol::Value::String(context.cancellation_record_present.to_string()),
        ),
        (
            "cancellation_record_cause",
            sentry::protocol::Value::String(
                context
                    .cancellation_record_cause
                    .map(SyncCancelCause::as_str)
                    .unwrap_or("none")
                    .to_string(),
            ),
        ),
        (
            "cancellation_termination_effected",
            sentry::protocol::Value::String(context.cancellation_termination_effected.to_string()),
        ),
        (
            "runner_stack_input",
            sentry::protocol::Value::String(context.runner_stack_input.clone()),
        ),
    ];
    // Company-scope vs per-file split, only when a runner error was recorded.
    if let Some(scope) = &context.runner_error_scope {
        extras.push((
            "runner_error_scope",
            sentry::protocol::Value::String(scope.clone()),
        ));
    }
    // Total stderr lines this generation received, at parity with the manual
    // route's `runner_stderr_line_count` extra, so the 8-line tail ring is not
    // misread as the real count. A bare integer — content-safe by type.
    if let Some(count) = context.runner_stderr_line_count {
        extras.push((
            "runner_stderr_line_count",
            sentry::protocol::Value::Number(count.into()),
        ));
    }
    // Faulting exception code + offset as bare decimal integers (never the hex
    // bytes copied from the record), present only when the OS fault record
    // supplied them. Emitted as digit strings so the hq-telemetry egress
    // validator can independently shape-check them.
    if let Some(exception_code) = context.watcher_fault_exception_code {
        extras.push((
            "watcher_fault_exception_code",
            sentry::protocol::Value::String(exception_code.to_string()),
        ));
    }
    if let Some(offset) = context.watcher_fault_offset {
        extras.push((
            "watcher_fault_offset",
            sentry::protocol::Value::String(offset.to_string()),
        ));
    }
    // V8 heap-OOM heap figures + captured-frame count (HQ-DESKTOP-55), as bare
    // integers, present only when this pass retained a heap OOM. used/total are
    // both-or-neither; the frame count is present whenever a banner was seen (0
    // when the banner arrived with no frames). Absent otherwise so absence never
    // renders as evidence.
    if let Some(used) = context.runner_heap_used_mb {
        extras.push((
            "runner_heap_used_mb",
            sentry::protocol::Value::Number(used.into()),
        ));
    }
    if let Some(total) = context.runner_heap_total_mb {
        extras.push((
            "runner_heap_total_mb",
            sentry::protocol::Value::Number(total.into()),
        ));
    }
    if let Some(frames) = context.runner_oom_frame_count {
        extras.push((
            "runner_oom_frame_count",
            sentry::protocol::Value::Number(frames.into()),
        ));
    }
    extras
}

/// The selected spawn command determines the fixed-vocabulary resolution token;
/// the exit-time probe carried on the context supplies the target facts. Where
/// nothing could be probed the pre-existing `"unknown"` vocabulary is kept — the
/// exit status is never re-read to infer target state. Gated by
/// [`should_report_exec_provenance`], which is strictly additive over the old
/// 126/127 arm, so this only ever ADDS information and never suppresses.
fn runner_exec_provenance_extras(
    code: Option<i32>,
    watcher_command: &str,
    context: &WatcherExitCaptureContext,
) -> Option<Vec<(&'static str, sentry::protocol::Value)>> {
    if !should_report_exec_provenance(code, watcher_command, &context.runner_phase) {
        return None;
    }
    let exists = context
        .runner_exec_target
        .map(RunnerTargetState::exists_token)
        .unwrap_or("unknown");
    let executable = context
        .runner_exec_target
        .map(RunnerTargetState::executable_token)
        .unwrap_or("unknown");
    Some(vec![
        (
            "runner_exec_resolution",
            sentry::protocol::Value::String(runner_exec_resolution(watcher_command).to_string()),
        ),
        (
            "runner_exec_target_exists",
            sentry::protocol::Value::String(exists.to_string()),
        ),
        (
            "runner_exec_target_executable",
            sentry::protocol::Value::String(executable.to_string()),
        ),
        (
            "runner_target_repair_attempted",
            sentry::protocol::Value::Bool(context.runner_target_repair_attempted),
        ),
    ])
}

fn runner_exec_resolution(watcher_command: &str) -> &'static str {
    let command = watcher_command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if command == "npx" || command == "npx.cmd" {
        "npx_cache"
    } else if command == "node" || command == "node.exe" {
        "local_runner"
    } else {
        "unknown"
    }
}

fn unrecognized_watcher_exit_extras() -> Vec<(&'static str, sentry::protocol::Value)> {
    vec![
        (
            "watcher_hq_cloud_package",
            sentry::protocol::Value::String(HQ_CLOUD_PACKAGE.to_string()),
        ),
        (
            "watcher_hq_cloud_version",
            sentry::protocol::Value::String(HQ_CLOUD_VERSION.to_string()),
        ),
        (
            "watcher_runner_binary",
            sentry::protocol::Value::String(RUNNER_BIN.to_string()),
        ),
    ]
}

/// Process errors after an owned child has started flow through the Exit arm.
/// Ownership loss is local-only because that actor must not publish terminal
/// state for a replacement. Only the typed Spawn variant may use a "failed to
/// spawn" capture, preventing stream/wait errors from being captured twice
/// under a false spawn label.
fn record_watcher_process_error(error: ProcessError) {
    let mut effects = ProductionWatcherProcessEffects;
    record_watcher_process_error_with_effects(&mut effects, error);
}

fn record_watcher_process_error_with_effects<E: WatcherProcessEffects>(
    effects: &mut E,
    error: ProcessError,
) {
    if error.ownership_cleanup_failed() {
        let kind = error.error_kind().unwrap_or(std::io::ErrorKind::Other);
        let raw_os_error = error.raw_os_error();
        effects.reset_exec_not_runnable_failure_streak();
        let consecutive = effects.note_watcher_crashed();
        let lifecycle_state = if effects.within_respawn_backoff() {
            WatchDaemonState::Backoff
        } else {
            WatchDaemonState::Stopped
        };
        effects.set_lifecycle_state(lifecycle_state, DaemonFailureCategory::Crash);
        effects.log(
            "daemon",
            &format!(
                "stale watcher cleanup failed; background wait owner retained without touching its replacement: {error}"
            ),
        );
        if should_capture_crash(consecutive) {
            effects.capture(
                &format!(
                    "auto-sync watcher stale-child cleanup failed \
                     (kind={kind:?} raw_os_error={raw_os_error:?}, consecutive #{consecutive})"
                ),
                &["sync", "auto-sync-watcher-ownership-cleanup"],
                &[],
                &[],
            );
        } else {
            effects.log(
                "daemon",
                &format!("stale watcher cleanup failure #{consecutive} — capture rate-limited"),
            );
        }
        return;
    }
    if error.is_ownership_lost() {
        effects.log(
            "daemon",
            &format!("stale watcher spawn discarded without touching its replacement: {error}"),
        );
        return;
    }
    if !error.is_spawn() {
        effects.log(
            "daemon",
            &format!(
                "watcher process failed after spawn: {error}; terminal exit handler owns capture"
            ),
        );
        return;
    }

    // Preserve the detailed local diagnostic that existed before spawn errors
    // gained classification and stable Sentry grouping.
    effects.log("daemon", &format!("spawn failed: {error}"));

    let kind = error.error_kind().unwrap_or(std::io::ErrorKind::Other);
    let raw_os_error = error.raw_os_error();
    let policy = spawn_failure_capture_policy(kind, raw_os_error);
    // A native spawn error is a different failure class from a child that
    // actually ran and exited 126/127, so it breaks that class-specific streak.
    effects.reset_exec_not_runnable_failure_streak();
    let consecutive = effects.note_watcher_crashed();
    let lifecycle_state = if effects.within_respawn_backoff() {
        WatchDaemonState::Backoff
    } else {
        WatchDaemonState::Stopped
    };
    effects.set_lifecycle_state(lifecycle_state, DaemonFailureCategory::SpawnFailed);

    if policy == SpawnFailureCapturePolicy::RetryAndLog {
        effects.log(
            "daemon",
            &format!(
                "transient watcher spawn resource exhaustion #{consecutive} — retrying via supervisor: {error}"
            ),
        );
        effects.add_breadcrumb(
            "daemon.spawn",
            sentry::Level::Info,
            format!(
                "transient auto-sync watcher spawn failure #{consecutive}: kind={kind:?} raw_os_error={raw_os_error:?}"
            ),
        );
        return;
    }

    if should_capture_crash(consecutive) {
        let token = spawn_failure_fingerprint_token(kind, raw_os_error);
        let fingerprint = ["sync", "auto-sync-watcher-spawn", token];
        effects.capture(
            &format!("auto-sync watcher failed to spawn: {error}"),
            &fingerprint,
            &[],
            &[],
        );
    } else {
        effects.log(
            "daemon",
            &format!("watcher spawn failure #{consecutive} — capture rate-limited: {error}"),
        );
    }
}

/// Capture policy for a preflight that positively refused to start the watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunnerPreflightCapturePolicy {
    LocalLogOnly,
    CaptureRateLimited,
}

/// Which preflight refusals are worth a central alert.
///
/// A machine with no Node, or an old Node HQ never installed, is a setup gap
/// the user fixes; alerting on it flooded #hq-alerts, and with auto-sync
/// retrying every 30 seconds that silence (`0cfae9cc`) has to stay. But it was
/// applied to the whole preflight, which also silenced the case where HQ's
/// *own* Node runtime disappeared. That one is an HQ defect, it is invisible to
/// the user (the daemon just never completes a cycle), and it ran for days with
/// nothing paging — so it alerts again, rate-limited exactly like a crash-loop.
fn runner_preflight_capture_policy(failure: PreflightFailure) -> RunnerPreflightCapturePolicy {
    match failure {
        PreflightFailure::RunnerUnresolvable | PreflightFailure::NodeTooOld => {
            RunnerPreflightCapturePolicy::LocalLogOnly
        }
        PreflightFailure::ManagedNodeMissing | PreflightFailure::NodeUnprovisioned => {
            RunnerPreflightCapturePolicy::CaptureRateLimited
        }
    }
}

/// Whether a finished provisioning attempt is worth reporting as a preflight
/// failure at all — the pure decision, so it stays directly unit-testable.
///
/// A *successful* self-heal is the fix working, and a *deferral* (another lane
/// already holds the shared repair slot — a single-flight cooldown) is that
/// guard doing its job. Neither is a fault. Reporting either would send
/// `sentry::Level::Error` to #hq-alerts and — worse — advance the
/// consecutive-preflight-failure counter that `should_capture_crash` uses, so a
/// machine HQ healed or merely deferred would inflate the rate limiter for
/// machines it could not repair (HQ-DESKTOP-4Z). Only an HQ-repairable state
/// that HQ actually *failed* to repair may page, and only rate-limited.
fn provisioning_bail_to_report(outcome: ProvisionAttempt) -> Option<String> {
    match outcome {
        ProvisionAttempt::Provisioned | ProvisionAttempt::Deferred(_) => None,
        ProvisionAttempt::Failed(reason) => Some(reason),
    }
}

/// Log a finished managed-Node provisioning attempt, alerting only on a genuine
/// failure.
///
/// Every finished attempt is logged locally (including a deferral's reason) for
/// Connect diagnostics, but only `Failed` reaches `report_preflight_bail` — the
/// one path that pages and advances the rate-limiting streak.
fn report_provisioning_outcome(outcome: ProvisionAttempt) {
    match &outcome {
        ProvisionAttempt::Provisioned => log(
            "daemon",
            "managed Node provisioned — auto-sync will retry on the next supervisor cadence",
        ),
        ProvisionAttempt::Deferred(reason) => log(
            "daemon",
            &format!(
                "managed Node provisioning deferred — another lane holds the shared repair slot: {reason}"
            ),
        ),
        // Failure is logged (and, when it clears the rate limit, captured) by
        // report_preflight_bail below.
        ProvisionAttempt::Failed(_) => {}
    }
    if let Some(reason) = provisioning_bail_to_report(outcome) {
        report_preflight_bail(PreflightFailure::NodeUnprovisioned, &reason);
    }
}

/// Log — and, for the arms that warrant it, alert on — a refused preflight.
fn report_preflight_bail(failure: PreflightFailure, message: &str) {
    match runner_preflight_capture_policy(failure) {
        RunnerPreflightCapturePolicy::LocalLogOnly => log(
            "daemon",
            &format!("preflight refused ({failure:?}) — local-only: {message}"),
        ),
        RunnerPreflightCapturePolicy::CaptureRateLimited => {
            let consecutive = note_runner_preflight_failure();
            if should_capture_crash(consecutive) {
                crate::commands::sync::capture_sync_error(
                    None,
                    "(auto-sync)",
                    &format!(
                        "auto-sync watcher cannot start ({failure:?}): {message} \
                         (consecutive #{consecutive}, further repeats rate-limited)"
                    ),
                );
            } else {
                log(
                    "daemon",
                    &format!(
                        "preflight refused ({failure:?}) #{consecutive} — capture rate-limited: {message}"
                    ),
                );
            }
        }
    }
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

/// Which process footprint a watcher RSS sample actually describes.
///
/// `Tree` is the honest sum over the registered PID AND its descendants (the Node
/// runner that npx spawns), so the number is the runner's real footprint. `Single`
/// is the fallback single-registered-PID sample, which for the npx launcher/shim
/// measures the launcher, not the runner — the exit renderer withholds it. `runner`
/// is NEVER produced by inference: a pid/ppid/rss row carries no process identity,
/// so `Single` keeps today's command-derived scope label rather than claiming the
/// sample is the runner's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RssSampleKind {
    Tree,
    Single,
}

/// Shared crash-loop state across the spawn (`start_daemon`), the watcher Exit
/// handler, and the supervisor.
#[derive(Default)]
struct WatcherCrashState {
    /// Consecutive fast failures (crash-loop length). Reset once a watcher
    /// survives `FAST_FAIL_WINDOW`.
    consecutive: u32,
    /// Consecutive exec-not-runnable (126/127) exits. This stays separate from
    /// `consecutive`: unrelated fast exits must never turn one 126/127 blip
    /// into an escalated capture.
    exec_not_runnable_consecutive: u32,
    /// When the current watcher was spawned — drives the fast-failure decision
    /// and the "survived long enough to reset" check.
    spawn_at: Option<Instant>,
    /// The supervisor must not respawn before this instant (backoff window).
    backoff_until: Option<Instant>,
    /// Consecutive alertable preflight refusals. Tracked separately from
    /// `consecutive` because these happen before a watcher is ever spawned.
    preflight_fails: u32,
    /// Last RSS (KB) sampled from the live watcher, and when — enriches an
    /// unexpected-exit capture so a `signal=9` (jetsam/OOM vs manual kill) can be
    /// told apart after the fact. Best-effort; never changes whether a crash is
    /// captured. Cleared on each fresh spawn.
    last_rss_kb: Option<u64>,
    last_rss_at: Option<Instant>,
    /// Which footprint the last sample measured (HQ-DESKTOP-55): the honest
    /// descendant-`Tree` sum, or the `Single`-PID fallback. Drives the exit
    /// renderer's scope so a launcher-only number is never printed as the runner's.
    /// Moves in lockstep with `last_rss_kb`; cleared on each fresh spawn.
    last_rss_kind: Option<RssSampleKind>,
}

static CRASH_STATE: OnceLock<Mutex<WatcherCrashState>> = OnceLock::new();

fn crash_state() -> &'static Mutex<WatcherCrashState> {
    CRASH_STATE.get_or_init(|| Mutex::new(WatcherCrashState::default()))
}

/// Record that a watcher was just spawned (called from `start_daemon`).
fn note_watcher_spawned() {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    st.spawn_at = Some(Instant::now());
    // A spawn proves the runtime resolved, so the preflight failure streak is
    // over and a future episode gets a fresh first alert.
    st.preflight_fails = 0;
    // Fresh watcher — drop the previous watcher's RSS sample so a crash capture
    // never reports a stale footprint from a process that already died.
    st.last_rss_kb = None;
    st.last_rss_at = None;
    st.last_rss_kind = None;
    HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(false, Ordering::Release);
}

/// Record an alertable preflight refusal and return the consecutive count so
/// the caller can rate-limit captures.
fn note_runner_preflight_failure() -> u32 {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    st.preflight_fails = st.preflight_fails.saturating_add(1);
    st.preflight_fails
}

/// Update the crash-loop state on an unexpected watcher exit and return the
/// consecutive-failure count so the caller can decide whether to capture.
fn note_watcher_crashed() -> u32 {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
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

/// Return the streak relevant to the selected capture policy. The global
/// crash-loop counter still owns backoff and ordinary crash milestones; only
/// the 126/127 escalation needs its own failure-class streak.
fn note_watcher_capture_policy_streak(
    policy: WatcherExitCapturePolicy,
    global_consecutive: u32,
) -> u32 {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    if policy == WatcherExitCapturePolicy::CaptureRateLimited {
        st.exec_not_runnable_consecutive =
            next_exec_not_runnable_streak(st.exec_not_runnable_consecutive, policy);
        st.exec_not_runnable_consecutive
    } else {
        st.exec_not_runnable_consecutive =
            next_exec_not_runnable_streak(st.exec_not_runnable_consecutive, policy);
        global_consecutive
    }
}

fn next_exec_not_runnable_streak(previous: u32, policy: WatcherExitCapturePolicy) -> u32 {
    if policy == WatcherExitCapturePolicy::CaptureRateLimited {
        previous.saturating_add(1)
    } else {
        0
    }
}

fn reset_exec_not_runnable_failure_streak() {
    crash_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .exec_not_runnable_consecutive = 0;
}

/// Apply the same exponential retry dampening when a preflight positively
/// identifies a local npm/cache setup failure. No watcher was spawned, so it
/// must not create a Sentry event; the backoff merely prevents the supervisor
/// from retrying the same user-actionable diagnosis every 30 seconds.
fn note_environment_preflight_failure() {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    st.consecutive = st.consecutive.saturating_add(1);
    st.backoff_until = Some(
        Instant::now() + respawn_backoff(st.consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF),
    );
}

/// Record the latest RSS (KB) sampled from the live watcher (supervisor tick),
/// together with which footprint it measured (descendant `Tree` or `Single`).
fn note_watcher_rss(kb: u64, kind: RssSampleKind) {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    st.last_rss_kb = Some(kb);
    st.last_rss_at = Some(Instant::now());
    st.last_rss_kind = Some(kind);
}

/// Snapshot for enriching a crash capture: watcher uptime (since spawn), the
/// last RSS sample, how long before now that sample was taken, and which
/// footprint it measured (so the exit renderer can scope the number honestly).
fn watcher_exit_diagnostics() -> (
    Option<Duration>,
    Option<u64>,
    Option<Duration>,
    Option<RssSampleKind>,
) {
    let st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    let uptime = st.spawn_at.map(|t| t.elapsed());
    let rss_age = st.last_rss_at.map(|t| t.elapsed());
    (uptime, st.last_rss_kb, rss_age, st.last_rss_kind)
}

/// Supervisor helper: is the watcher still inside its respawn-backoff window?
fn within_respawn_backoff() -> bool {
    let st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    st.backoff_until
        .map(|until| Instant::now() < until)
        .unwrap_or(false)
}

/// Supervisor helper: once a respawned watcher has survived `FAST_FAIL_WINDOW`,
/// clear the crash-loop state so backoff + capture rate-limiting reset for the
/// next failure episode.
fn reset_crash_state_if_recovered() {
    let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
    if should_reset_after_recovery(st.spawn_at.map(|t| t.elapsed()), FAST_FAIL_WINDOW) {
        st.consecutive = 0;
        st.exec_not_runnable_consecutive = 0;
        st.backoff_until = None;
    }
}

/// Best-effort scoped RSS sample of the registered watcher (HQ-DESKTOP-55).
///
/// On Unix it sums the registered PID AND its transitive descendants — the Node
/// runner that the npx launcher spawns — via ONE `ps -eo pid=,ppid=,rss=`, so the
/// reported footprint is the runner's, tagged `Tree`. On ANY failure (spawn,
/// parse, or the root PID missing from the table) it falls back to today's
/// single-PID sample tagged `Single`, so the failure mode is the status quo, never
/// a mislabeled number. Windows keeps its single-PID sampler (the Job Object
/// already carries whole-tree memory), reported `Single`. Best-effort throughout —
/// it never changes whether a crash is captured. One `ps` spawn per supervisor
/// tick, replacing (not adding to) the existing one.
#[cfg(not(target_os = "windows"))]
fn sample_watcher_rss_scoped(pid: u32) -> Option<(u64, RssSampleKind)> {
    match sample_pid_tree_rss_kb(pid) {
        Some(sum) => Some((sum, RssSampleKind::Tree)),
        None => sample_pid_rss_kb(pid).map(|kb| (kb, RssSampleKind::Single)),
    }
}

#[cfg(target_os = "windows")]
fn sample_watcher_rss_scoped(pid: u32) -> Option<(u64, RssSampleKind)> {
    sample_pid_rss_kb(pid).map(|kb| (kb, RssSampleKind::Single))
}

/// Sum RSS (KB) over `root` and its transitive descendants in a captured
/// `ps -eo pid=,ppid=,rss=` table. Cycle-safe via a visited set. Returns `None`
/// only when `root` is absent from the table, so the caller falls back to a
/// single-PID sample rather than reporting a wrong sum. Pure so it can be
/// unit-tested against captured macOS and Linux `ps` output, including
/// reparented (ppid 1) descendants.
#[cfg(not(target_os = "windows"))]
fn sum_pid_tree_rss_kb(ps_table: &str, root: u32) -> Option<u64> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut rss_by_pid: HashMap<u32, u64> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in ps_table.lines() {
        let mut columns = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(kb)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Ok(kb)) =
            (pid.parse::<u32>(), ppid.parse::<u32>(), kb.parse::<u64>())
        else {
            continue;
        };
        rss_by_pid.insert(pid, kb);
        children.entry(ppid).or_default().push(pid);
    }
    if !rss_by_pid.contains_key(&root) {
        return None;
    }
    let mut total = 0_u64;
    let mut visited: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        total = total.saturating_add(rss_by_pid.get(&pid).copied().unwrap_or(0));
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    Some(total)
}

/// Best-effort whole-tree RSS (KB) for the registered watcher PID: one bounded
/// `ps -eo pid=,ppid=,rss=` invocation summed by [`sum_pid_tree_rss_kb`]. `None`
/// on spawn/exit/parse failure or a missing root, so the caller falls back to the
/// single-PID sample.
#[cfg(not(target_os = "windows"))]
fn sample_pid_tree_rss_kb(root: u32) -> Option<u64> {
    let mut cmd = std::process::Command::new("ps");
    paths::no_window(&mut cmd);
    let out = cmd.args(["-eo", "pid=,ppid=,rss="]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    sum_pid_tree_rss_kb(&String::from_utf8_lossy(&out.stdout), root)
}

/// Best-effort RSS (KB) of the registered watcher. On Unix this uses `ps`,
/// which reports RSS in 1-KB units. Returns `None` on any failure; diagnostic
/// sampling never changes whether a crash is captured.
#[cfg(not(target_os = "windows"))]
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

/// Best-effort Windows working-set sample for the app-owned watcher PID. The
/// PID is obtained from the process registry, so this opens the current
/// generation's registered child rather than guessing from a stale PID file.
#[cfg(target_os = "windows")]
fn sample_pid_rss_kb(pid: u32) -> Option<u64> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let sample = GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .ok()
        .map(|_| counters.WorkingSetSize as u64 / 1024);
        let _ = CloseHandle(handle);
        sample
    }
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
///
/// The `last_rss` piece is scope-aware (HQ-DESKTOP-55): a `runner`-scoped sample
/// renders byte-identically to the historical suffix; a `tree`-scoped sample
/// qualifies the honest whole-tree number; and any non-runner single-PID scope
/// WITHHOLDS the number (it measures the launcher/shim, not the runner) and names
/// the scope as `unattributed:<scope>` instead — so neither an impossible 32KB nor
/// a plausible-looking launcher footprint can ever read as the runner's. The
/// no-sample arms are unchanged and scope-independent.
fn exit_diagnostic_suffix(
    uptime: Option<Duration>,
    rss_kb: Option<u64>,
    rss_age: Option<Duration>,
    rss_scope: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(u) = uptime {
        parts.push(format!("uptime={}", format_duration_secs(u.as_secs())));
    }
    match (rss_kb, rss_age) {
        (Some(kb), age) => parts.push(render_last_rss(kb, age, rss_scope)),
        _ if uptime.is_some_and(|elapsed| {
            elapsed < SUPERVISOR_SETTLE.saturating_add(SUPERVISOR_INTERVAL)
        }) =>
        {
            parts.push("last_rss=not-yet-sampled".to_string())
        }
        _ => parts.push("last_rss=unsampled".to_string()),
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" [{}]", parts.join("; "))
    }
}

/// Render the scope-aware `last_rss=…` piece. `runner` keeps the historical
/// plain-number strings exactly; `tree` folds a `tree` qualifier into the sampled
/// clause; every other (non-runner single-PID) scope withholds the number as
/// `unattributed:<scope>`. `age` present means "(sampled … before exit)".
fn render_last_rss(kb: u64, age: Option<Duration>, rss_scope: &str) -> String {
    let sampled = age.map(|age| format!(" (sampled {} before exit)", format_duration_secs(age.as_secs())));
    match rss_scope {
        "runner" => match &sampled {
            Some(clause) => format!("last_rss={}{clause}", format_rss_kb(kb)),
            None => format!("last_rss={}", format_rss_kb(kb)),
        },
        "tree" => match age {
            Some(age) => format!(
                "last_rss={} (tree, sampled {} before exit)",
                format_rss_kb(kb),
                format_duration_secs(age.as_secs())
            ),
            None => format!("last_rss={} (tree)", format_rss_kb(kb)),
        },
        other => match &sampled {
            Some(clause) => format!("last_rss=unattributed:{other}{clause}"),
            None => format!("last_rss=unattributed:{other}"),
        },
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
/// "Last synced N minutes ago".
///
/// **US-002:** After spawn the app-owned process-registry handle is
/// authoritative. A healthy long-lived runner that never writes `.hq-sync.pid`
/// stays `Running` and is not force-cleared. The PID file is only used to
/// recover a runner inherited from a previous app session.
pub fn setup_daemon_supervisor(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(SUPERVISOR_SETTLE);
        loop {
            let (app_owned, registered_child_alive, daemon_alive, sample_pid) =
                observe_daemon_liveness();
            let within_backoff = within_respawn_backoff();
            let pid_file_alive = resolve_hq_folder_path()
                .ok()
                .and_then(|p| read_pid_file(&p))
                .map(is_pid_alive)
                .unwrap_or(false);
            let _state = derive_watch_daemon_state(
                app_owned,
                registered_child_alive,
                pid_file_alive,
                within_backoff,
            );

            if daemon_alive {
                // Promote Starting → Running once the registered child is live
                // (no HQ PID file required).
                if current_lifecycle_state() != WatchDaemonState::Running {
                    set_lifecycle_state(WatchDaemonState::Running, DaemonFailureCategory::None);
                }
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
                // shortly before death (jetsam/OOM vs kill -9). Scoped to the
                // whole descendant tree so the runner's real footprint is seen
                // through the npx launcher, with an honest single-PID fallback.
                // Best-effort.
                if let Some(pid) = sample_pid {
                    if let Some((kb, kind)) = sample_watcher_rss_scoped(pid) {
                        note_watcher_rss(kb, kind);
                    }
                }
            } else if should_respawn_daemon_gated(
                is_realtime_sync_enabled(),
                is_autostart_enabled(),
                daemon_alive,
                hq_desktop_core::daemon::is_cloud_paused(),
            ) {
                // Crash-loop dampening: hold off respawning a watcher that just
                // crashed until its exponential backoff elapses, instead of
                // hot-respawning every 30s (HQ-SYNC-4).
                if within_backoff {
                    if current_lifecycle_state() != WatchDaemonState::Backoff {
                        set_lifecycle_state(
                            WatchDaemonState::Backoff,
                            DaemonFailureCategory::Backoff,
                        );
                    }
                    log(
                        "daemon.supervisor",
                        "watch daemon down but within crash-loop backoff — holding off respawn",
                    );
                } else {
                    log(
                        "daemon.supervisor",
                        "watch daemon down but auto-sync is on — respawning",
                    );
                    SUPERVISOR_RESPAWN_IN_FLIGHT.store(true, Ordering::Release);
                    let respawn = start_daemon_for_supervisor_respawn(handle.clone());
                    SUPERVISOR_RESPAWN_IN_FLIGHT.store(false, Ordering::Release);
                    match respawn {
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
                            // tick's normal respawn can proceed.
                            //
                            // US-002: `daemon_alive` is true for a healthy
                            // app-owned child without a PID file, so force-clear
                            // does not fire against a live registered runner.
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
    // runner from `start_daemon` and cleans up the handle. Exactly-once
    // Job Object teardown for this generation.
    let cancelled = terminate_daemon_once(DaemonFailureCategory::Cancelled);
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
    use crate::commands::process::{deregister_process, try_register_handle};
    use crate::util::test_support::{scoped_home, ENV_MUTEX};
    use tempfile::TempDir;

    // ── Cloud Off gating (V2 US-001 / US-016) ─────────────────────────────

    /// The watch daemon (auto-sync + the instant/event-push runner it hosts)
    /// must refuse to start while Cloud is paused — for every launch origin,
    /// since renderer, app-launch, and supervisor-respawn all funnel through
    /// `start_daemon_with_origin`, whose first statement is the gate.
    #[test]
    fn test_start_daemon_refuses_while_cloud_paused() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"cloudPaused":true}"#,
        )
        .unwrap();
        let _home = scoped_home(tmp.path());

        let app = tauri::test::mock_app();
        let err = start_daemon(app.handle().clone())
            .expect_err("paused cloud must refuse to start the watch daemon");
        assert_eq!(err, hq_desktop_core::daemon::CLOUD_PAUSED_MESSAGE);
        // NOTE: the refusal happens before the singleton guard is taken (the
        // gate is the first statement of `start_daemon_with_origin`), so a
        // later unpaused start is never wedged by a paused attempt. Not
        // asserted via `try_register_handle` here because DAEMON_HANDLE is
        // process-global and other tests exercise it concurrently.
    }

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

    // ── US-002: app-owned handle authoritative without PID file ──────────

    #[test]
    fn app_owned_live_child_without_pid_file_is_not_force_cleared() {
        use crate::commands::process::{deregister_process, register_process, try_register_handle};
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // Simulate a spawned watch runner that never wrote .hq-sync.pid.
        assert!(try_register_handle(DAEMON_HANDLE));
        register_process(DAEMON_HANDLE, std::process::id());
        mark_daemon_guard_acquired(
            generation_for_handle(DAEMON_HANDLE).expect("registered daemon generation"),
        );

        let (app_owned, child_alive, daemon_alive, sample_pid) = observe_daemon_liveness();
        assert!(app_owned, "handle is registered");
        assert!(child_alive, "current process is alive");
        assert!(daemon_alive, "app-owned live child is authoritative");
        assert_eq!(sample_pid, Some(std::process::id()));

        // Even past the start deadline, force-clear must not fire.
        assert!(
            !should_force_clear_stalled_start(
                daemon_alive,
                Some(DAEMON_START_DEADLINE * 10),
                DAEMON_START_DEADLINE
            ),
            "healthy registered child without PID file must never be force-cleared"
        );

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    #[test]
    fn rss_sampling_never_falls_back_to_the_recovery_pid_file() {
        assert_eq!(app_owned_rss_sample_pid(Some(42), Some(99)), Some(42));
        assert_eq!(app_owned_rss_sample_pid(Some(42), None), Some(42));
        assert_eq!(
            app_owned_rss_sample_pid(None, Some(99)),
            None,
            "a PID-file-only recovery observation must stay unsampled"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_rss_sampler_records_a_live_working_set_in_exit_diagnostics() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        note_watcher_spawned();

        let rss_kb = sample_pid_rss_kb(std::process::id())
            .expect("GetProcessMemoryInfo should sample the live test process");
        assert!(rss_kb > 0, "a live process must have a nonzero working set");
        note_watcher_rss(rss_kb, RssSampleKind::Single);

        let (_uptime, sampled_rss_kb, sampled_age, sampled_kind) = watcher_exit_diagnostics();
        assert_eq!(sampled_rss_kb, Some(rss_kb));
        assert_eq!(sampled_kind, Some(RssSampleKind::Single));
        assert!(
            sampled_age.is_some(),
            "sample age must reach exit diagnostics"
        );

        // Clear the process-global sample so adjacent tests cannot observe it.
        note_watcher_spawned();
    }

    #[test]
    fn lifecycle_transitions_stopped_starting_running() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Stopped);

        set_lifecycle_state(WatchDaemonState::Starting, DaemonFailureCategory::None);
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Starting);

        set_lifecycle_state(WatchDaemonState::Running, DaemonFailureCategory::None);
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Running);

        set_lifecycle_state(WatchDaemonState::Backoff, DaemonFailureCategory::Crash);
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Backoff);

        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    #[test]
    fn terminate_daemon_once_is_idempotent() {
        use crate::commands::process::{deregister_process, try_register_handle};
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        assert!(try_register_handle(DAEMON_HANDLE));
        // First cancel path succeeds (marks cancelled); second is a no-op.
        let first = terminate_daemon_once(DaemonFailureCategory::Cancelled);
        assert!(first, "first termination should mark cancelled");
        let second = terminate_daemon_once(DaemonFailureCategory::HeartbeatStall);
        assert!(
            !second,
            "second termination must not re-fire Job Object kill"
        );

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    #[test]
    fn stale_watchdog_and_force_clear_cannot_touch_replacement_generation() {
        use crate::commands::process::{deregister_process, try_register_handle_gen};

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();

        let stale_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire stale daemon generation");
        let stale_guard_generation = mark_daemon_guard_acquired(stale_generation);
        let stale_ownership = *daemon_guard().lock().unwrap_or_else(|p| p.into_inner());
        assert!(deregister_generation(DAEMON_HANDLE, stale_generation));
        let replacement_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire replacement daemon generation");
        let replacement_guard_generation = mark_daemon_guard_acquired(replacement_generation);

        assert!(
            !terminate_daemon_generation_once_with_delay(
                stale_generation,
                DaemonFailureCategory::HeartbeatStall,
                Duration::ZERO,
            ),
            "a stale watchdog must not cancel the replacement"
        );
        force_clear_daemon_generation(stale_ownership);

        assert_eq!(
            generation_for_handle(DAEMON_HANDLE),
            Some(replacement_generation)
        );
        assert!(
            !is_cancelled_for_generation(DAEMON_HANDLE, replacement_generation),
            "stale daemon actors must leave replacement cancellation state unchanged"
        );
        let surviving_guard = daemon_guard()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .expect("replacement guard must survive stale force-clear");
        assert_eq!(surviving_guard.generation, replacement_guard_generation);
        assert_eq!(surviving_guard.registration, replacement_generation);
        assert_ne!(stale_guard_generation, replacement_guard_generation);

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    #[test]
    fn force_clear_keeps_the_stamp_that_triggered_its_liveness_probe() {
        use crate::commands::process::{deregister_process, try_register_handle_gen};

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();

        let stale_registration =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire stale daemon generation");
        let stale_guard = mark_daemon_guard_acquired(stale_registration);
        assert!(deregister_generation(DAEMON_HANDLE, stale_registration));

        let mut replacement = None;
        force_clear_daemon_guard_with_probe(|| {
            let registration = try_register_handle_gen(DAEMON_HANDLE)
                .expect("replacement must acquire the released handle");
            let guard = mark_daemon_guard_acquired(registration);
            replacement = Some((registration, guard));
            false
        });

        let (replacement_registration, replacement_guard) =
            replacement.expect("the probe must install a replacement generation");
        assert_eq!(
            generation_for_handle(DAEMON_HANDLE),
            Some(replacement_registration),
            "a force-clear actor must not re-resolve and remove the generation installed during its probe"
        );
        let surviving_guard = daemon_guard()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .expect("the replacement guard must survive the stale force-clear");
        assert_eq!(surviving_guard.registration, replacement_registration);
        assert_eq!(surviving_guard.generation, replacement_guard);
        assert_ne!(surviving_guard.generation, stale_guard);

        deregister_process(DAEMON_HANDLE);
        clear_daemon_guard_stamp();
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
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
        mark_daemon_guard_acquired(
            generation_for_handle(DAEMON_HANDLE).expect("registered daemon generation"),
        );

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
        force_clear_daemon_guard_with_probe(|| false);

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
        use crate::commands::process::{
            deregister_process, try_register_handle, try_register_handle_gen,
        };
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_daemon_guard_stamp();

        // Simulate a start that acquired the guard then bailed a preflight.
        let registration = try_register_handle_gen(DAEMON_HANDLE).expect("acquire daemon handle");
        let guard_generation = mark_daemon_guard_acquired(registration);
        assert!(daemon_guard_age().is_some());

        // The preflight-bail path releases the guard on the spot — no deadline,
        // no wedge — so the next start is free to proceed.
        release_daemon_guard(registration, guard_generation);
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
        mark_daemon_guard_acquired(0);
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
        mark_daemon_guard_acquired(
            generation_for_handle(DAEMON_HANDLE).expect("registered daemon generation"),
        );

        // The supervisor thought the daemon was down, but the re-probe says it is
        // alive (a flake). Force-clear must abort: the guard stamp and the
        // registry handle both survive, so the live watcher is neither killed nor
        // deregistered.
        force_clear_daemon_guard_with_probe(|| true);
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
        let gen1 = mark_daemon_guard_acquired(101);
        // In the gap between gen1 deregistering the handle and clearing its stamp,
        // a supervisor respawn re-acquires the freed handle and stamps gen2.
        let gen2 = mark_daemon_guard_acquired(102);
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
    fn signal_exit_policy_suppresses_only_sigterm_across_capture_seams() {
        for (signal, should_capture) in [(SIGTERM, false), (SIGSEGV, true)] {
            assert_eq!(
                is_unexpected_watcher_exit(false, Some(signal), false),
                should_capture,
                "watcher classifier disagreed for signal {signal}"
            );
            assert_eq!(
                hq_desktop_core::sync_outcome::should_alert_on_nonzero_exit(
                    None,
                    Some(signal),
                    false,
                    false,
                    false,
                ),
                should_capture,
                "manual-sync classifier disagreed for signal {signal}"
            );

            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                None,
                Some(signal),
                false,
                false,
                "npx",
                None,
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );
            assert_eq!(
                effects.captures.len(),
                usize::from(should_capture),
                "production watcher capture seam disagreed for signal {signal}"
            );
        }
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
    fn watcher_exit_policy_keeps_exec_failures_local_then_escalates() {
        assert_eq!(
            watcher_exit_capture_policy(Some(1), None),
            WatcherExitCapturePolicy::LocalLogOnly
        );
        assert_eq!(
            watcher_exit_capture_policy(Some(2), None),
            WatcherExitCapturePolicy::LocalLogOnly
        );
        // Exit 126/127 can race a successful start-time preflight. Treat the
        // first occurrence as the same environmental class, but do not make a
        // persistently unrunnable HQ command invisible forever.
        for code in [126, 127] {
            let policy = watcher_exit_capture_policy(Some(code), None);
            assert_eq!(policy, WatcherExitCapturePolicy::CaptureRateLimited);
            assert!(!should_capture_watcher_exit(policy, 1));
            assert!(should_capture_watcher_exit(policy, 4));
        }
        assert_eq!(
            watcher_exit_capture_policy(Some(221), None),
            WatcherExitCapturePolicy::Capture
        );
        assert_eq!(
            watcher_exit_capture_policy(Some(2), Some(SIGKILL)),
            WatcherExitCapturePolicy::Capture
        );
    }

    /// Serial number for the handles minted by [`run_real_watcher_exit`].
    ///
    /// The process registry is global and `cargo test` runs these cases on
    /// parallel threads, so a handle derived only from the exit code is shared
    /// by every caller of that helper — and `real_child_exit_statuses_…` and
    /// `real_child_crash_flood_…` both spawn exit code 221. When they overlap,
    /// the second spawn resolves the first's live registration through
    /// `generation_for_handle`, fails its ownership check against a PID it does
    /// not own, and returns `OwnershipLost`. The handle identity is incidental
    /// to what these tests assert, so mint a fresh one per invocation.
    #[cfg(unix)]
    static NEXT_REAL_EXIT_HANDLE: AtomicU64 = AtomicU64::new(0);

    #[cfg(unix)]
    fn run_real_watcher_exit(code: i32) -> (Option<i32>, Option<i32>, bool) {
        use hq_desktop_core::process_types::SpawnArgs;

        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), format!("exit {code}")],
            cwd: None,
            env: None,
        };
        let serial = NEXT_REAL_EXIT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let handle = format!("watcher-policy-real-exit-{code}-{serial}");
        let mut terminal = None;
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success,
            } = event
            {
                terminal = Some((code, signal, success));
            }
        })
        .expect("real shell child should run");

        terminal.expect("real child must emit one terminal event")
    }

    #[derive(Debug)]
    struct RecordedCapture {
        message: String,
        fingerprint: Vec<String>,
        tags: Vec<(String, String)>,
        extras: Vec<(String, sentry::protocol::Value)>,
    }

    #[derive(Default)]
    struct RecordingWatcherEffects {
        consecutive: u32,
        exec_not_runnable_consecutive: u32,
        in_backoff: bool,
        logs: Vec<(String, String)>,
        breadcrumbs: Vec<(String, String, String)>,
        captures: Vec<RecordedCapture>,
        /// Captures handed to the session-end grace instead of being sent.
        /// Kept separate from `captures` so a test cannot mistake a held-back
        /// event for a sent one.
        deferred: Vec<RecordedCapture>,
        /// Captures handed to the deferred watcher-fault read instead of being
        /// sent now, with their seeded `deferred` provenance. Separate so a test
        /// can prove the fault read is off the exit path.
        deferred_watcher_fault: Vec<RecordedCapture>,
        lifecycle: Vec<(WatchDaemonState, DaemonFailureCategory)>,
    }

    impl WatcherProcessEffects for RecordingWatcherEffects {
        fn note_watcher_crashed(&mut self) -> u32 {
            self.consecutive = self.consecutive.saturating_add(1);
            self.in_backoff = true;
            self.consecutive
        }

        fn note_watcher_capture_policy_streak(
            &mut self,
            policy: WatcherExitCapturePolicy,
            global_consecutive: u32,
        ) -> u32 {
            self.exec_not_runnable_consecutive =
                next_exec_not_runnable_streak(self.exec_not_runnable_consecutive, policy);
            if policy == WatcherExitCapturePolicy::CaptureRateLimited {
                self.exec_not_runnable_consecutive
            } else {
                global_consecutive
            }
        }

        fn reset_exec_not_runnable_failure_streak(&mut self) {
            self.exec_not_runnable_consecutive = 0;
        }

        fn within_respawn_backoff(&self) -> bool {
            self.in_backoff
        }

        fn set_lifecycle_state(&mut self, next: WatchDaemonState, category: DaemonFailureCategory) {
            self.lifecycle.push((next, category));
        }

        fn watcher_exit_diagnostics(
            &self,
        ) -> (Option<Duration>, Option<u64>, Option<Duration>, Option<RssSampleKind>) {
            (Some(Duration::from_secs(1)), None, None, None)
        }

        fn log(&mut self, target: &str, message: &str) {
            self.logs.push((target.to_string(), message.to_string()));
        }

        fn add_breadcrumb(&mut self, category: &str, level: sentry::Level, message: String) {
            self.breadcrumbs
                .push((category.to_string(), format!("{level:?}"), message));
        }

        fn capture(
            &mut self,
            message: &str,
            fingerprint: &[&str],
            tags: &[(&str, String)],
            extras: &[(&str, sentry::protocol::Value)],
        ) {
            self.captures
                .push(recorded_capture(message, fingerprint, tags, extras));
        }

        fn defer_session_end_capture(
            &mut self,
            message: &str,
            fingerprint: &[&str],
            tags: &[(&str, String)],
            extras: &[(&str, sentry::protocol::Value)],
        ) {
            self.deferred
                .push(recorded_capture(message, fingerprint, tags, extras));
        }

        fn defer_watcher_fault_capture(
            &mut self,
            message: &str,
            fingerprint: &[&str],
            tags: &[(&str, String)],
            extras: &[(&str, sentry::protocol::Value)],
            _read: WatcherFaultDeferredRead,
        ) {
            self.deferred_watcher_fault
                .push(recorded_capture(message, fingerprint, tags, extras));
        }
    }

    fn recorded_capture(
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
    ) -> RecordedCapture {
        RecordedCapture {
            message: message.to_string(),
            fingerprint: fingerprint.iter().map(|part| (*part).to_string()).collect(),
            tags: tags
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            extras: extras
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
        }
    }

    fn recorded_string_extra<'a>(capture: &'a RecordedCapture, key: &str) -> &'a str {
        capture
            .extras
            .iter()
            .find_map(|(name, value)| {
                if name != key {
                    return None;
                }
                match value {
                    sentry::protocol::Value::String(value) => Some(value.as_str()),
                    _ => None,
                }
            })
            .unwrap_or_else(|| panic!("missing string extra {key}"))
    }

    fn recorded_number_extra(capture: &RecordedCapture, key: &str) -> u64 {
        capture
            .extras
            .iter()
            .find_map(|(name, value)| {
                if name != key {
                    return None;
                }
                match value {
                    sentry::protocol::Value::Number(value) => value.as_u64(),
                    _ => None,
                }
            })
            .unwrap_or_else(|| panic!("missing number extra {key}"))
    }

    fn recorded_tag<'a>(capture: &'a RecordedCapture, key: &str) -> &'a str {
        capture
            .tags
            .iter()
            .find_map(|(name, value)| (name == key).then_some(value.as_str()))
            .unwrap_or_else(|| panic!("missing tag {key}"))
    }

    #[cfg(unix)]
    #[test]
    fn real_child_exit_statuses_drive_the_production_handler() {
        for exit_code in [0, 2, 126, 127, 221] {
            let (code, signal, success) = run_real_watcher_exit(exit_code);
            assert_eq!(code, Some(exit_code));
            assert_eq!(signal, None);

            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                code,
                signal,
                success,
                false,
                "/opt/homebrew/bin/npx",
                Some("runner ended without a documented code"),
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );

            assert_eq!(effects.captures.len(), usize::from(exit_code == 221));
            match exit_code {
                0 => assert_eq!(
                    effects.lifecycle,
                    vec![(WatchDaemonState::Stopped, DaemonFailureCategory::None)]
                ),
                2 => {
                    assert_eq!(
                        effects.lifecycle,
                        vec![(WatchDaemonState::Backoff, DaemonFailureCategory::None)]
                    );
                    assert!(effects
                        .breadcrumbs
                        .iter()
                        .any(|(category, _, _)| category == "daemon.exit"));
                }
                126 | 127 => {
                    assert_eq!(
                        effects.lifecycle,
                        vec![(WatchDaemonState::Backoff, DaemonFailureCategory::Crash)]
                    );
                    assert!(effects
                        .breadcrumbs
                        .iter()
                        .any(|(category, _, message)| category == "daemon.exit"
                            && message.contains("exec-not-runnable")));
                }
                221 => {
                    assert_eq!(
                        effects.lifecycle,
                        vec![(WatchDaemonState::Backoff, DaemonFailureCategory::Crash)]
                    );
                    let capture = &effects.captures[0];
                    assert!(!capture
                        .extras
                        .iter()
                        .any(|(key, _)| *key == "watcher_runner_command"
                            || *key == "watcher_last_stderr"));
                    assert!(capture.message.contains("last_rss=not-yet-sampled"));
                    assert!(!capture.fingerprint.iter().any(|part| part.contains('/')));
                }
                _ => unreachable!(),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn real_child_crash_flood_keeps_power_of_two_capture_bound() {
        let mut effects = RecordingWatcherEffects::default();
        for _ in 1..=32 {
            let (code, signal, success) = run_real_watcher_exit(221);
            assert!(!success);
            handle_watcher_exit_with_effects(
                &mut effects,
                code,
                signal,
                success,
                false,
                "npx",
                Some("unknown runner exit"),
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );
        }

        assert_eq!(
            effects.captures.len(),
            6,
            "only failures 1, 2, 4, 8, 16 and 32 capture"
        );
        assert!(effects
            .lifecycle
            .iter()
            .all(|(state, category)| *state == WatchDaemonState::Backoff
                && *category == DaemonFailureCategory::Crash));
    }

    #[test]
    fn unknown_exit_handler_exposes_only_fixed_vocabulary_diagnostics() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let raw_stderr = format!(
            "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
        );
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(221),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd --private-flag",
            Some(&raw_stderr),
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );
        let capture = &effects.captures[0];
        assert_eq!(
            recorded_string_extra(capture, "watcher_hq_cloud_package"),
            HQ_CLOUD_PACKAGE
        );
        assert_eq!(
            recorded_string_extra(capture, "watcher_hq_cloud_version"),
            HQ_CLOUD_VERSION
        );
        assert_eq!(
            recorded_string_extra(capture, "watcher_runner_binary"),
            RUNNER_BIN
        );
        assert!(
            !capture
                .extras
                .iter()
                .any(|(key, _)| *key == "watcher_runner_command" || *key == "watcher_last_stderr"),
            "raw command and stderr extras must not reach Sentry"
        );
        let serialized = serde_json::to_string(&capture.extras).expect("serialize extras");
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("private-flag"));
        assert!(!serialized.contains("hq-tmp-a1b2"));
        assert!(!serialized.contains("operation not permitted"));
    }

    #[test]
    fn watcher_abort_encodings_share_a_group_and_keep_safe_raw_provenance() {
        let companion = r"  #  C:\WINDOWS\system32\cmd.exe [44452]: char *__cdecl node::Realloc<char>(char *,unsigned __int64) at c:\ws\src\util-inl.h:378";
        let assertion = "  #  Assertion failed: !(n > 0) || (ret != nullptr)";
        let stderr_marker = "watcher-abort-private-stderr-marker";
        let watcher_command = r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd --private-flag";

        let mut totals = RunTotals::default();
        for line in [companion, assertion, stderr_marker] {
            totals.record_stderr_line(line);
        }
        let windows_context = WatcherExitCaptureContext {
            runner_fatal_class: totals.runner_fatal_class.as_str().to_string(),
            ..Default::default()
        };

        let mut windows = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut windows,
            Some(134),
            None,
            false,
            false,
            watcher_command,
            Some(stderr_marker),
            TerminationHost::Windows,
            &windows_context,
        );
        let windows_capture = windows.captures.first().expect("Windows abort captures");
        assert_eq!(
            windows_capture.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "abort:sigabrt",
                "none"
            ]
        );
        assert!(windows_capture.message.starts_with(
            "auto-sync watcher exited unexpectedly (aborted (Node abort exit code 134)), consecutive failure #"
        ));
        assert!(!windows_capture.message.contains("code=Some(134)"));
        assert_eq!(
            recorded_tag(windows_capture, "runner_fatal_class"),
            "node_check_abort"
        );
        assert_eq!(
            recorded_string_extra(windows_capture, "termination_status_raw"),
            "exit:134"
        );
        assert_eq!(
            recorded_string_extra(windows_capture, "watcher_hq_cloud_package"),
            HQ_CLOUD_PACKAGE
        );
        assert_eq!(
            recorded_string_extra(windows_capture, "watcher_hq_cloud_version"),
            HQ_CLOUD_VERSION
        );
        assert_eq!(
            recorded_string_extra(windows_capture, "watcher_runner_binary"),
            RUNNER_BIN
        );

        let posix_context = WatcherExitCaptureContext {
            runner_fatal_class: "node_fatal".to_string(),
            ..Default::default()
        };
        let mut posix = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut posix,
            None,
            Some(SIGABRT),
            false,
            false,
            watcher_command,
            Some("libc++abi: terminating due to uncaught exception"),
            TerminationHost::Posix,
            &posix_context,
        );
        let posix_capture = posix.captures.first().expect("POSIX abort captures");
        assert_eq!(posix_capture.fingerprint, windows_capture.fingerprint);
        assert!(posix_capture.message.starts_with(
            "auto-sync watcher exited unexpectedly (aborted with SIGABRT), consecutive failure #"
        ));
        assert!(!posix_capture.message.contains("signal=Some(6)"));
        assert_eq!(
            recorded_string_extra(posix_capture, "termination_status_raw"),
            "signal:6"
        );

        for capture in [windows_capture, posix_capture] {
            let mut wire_strings = vec![capture.message.as_str()];
            wire_strings.extend(capture.fingerprint.iter().map(String::as_str));
            wire_strings.extend(capture.tags.iter().map(|(_, value)| value.as_str()));
            wire_strings.extend(capture.extras.iter().filter_map(|(_, value)| match value {
                sentry::protocol::Value::String(value) => Some(value.as_str()),
                _ => None,
            }));
            for private_value in [stderr_marker, "/Users/", r"C:\Users\", "private-flag"] {
                assert!(
                    wire_strings
                        .iter()
                        .all(|wire_value| !wire_value.contains(private_value)),
                    "wire capture leaked {private_value}"
                );
            }
            assert!(capture
                .fingerprint
                .iter()
                .all(|part| { !part.contains('/') && !part.contains('\\') }));
            assert!(!recorded_string_extra(capture, "termination_status_raw").contains('/'));
            assert!(!recorded_string_extra(capture, "termination_status_raw").contains('\\'));
            for (name, value) in &capture.extras {
                if let sentry::protocol::Value::String(value) = value {
                    if value.contains('/') || value.contains('\\') {
                        assert_eq!(name, "watcher_hq_cloud_package");
                        assert_eq!(value, HQ_CLOUD_PACKAGE);
                    }
                }
            }
        }
    }

    #[test]
    fn watcher_abort_normalization_leaves_capture_policy_and_non_abort_wire_values_unchanged() {
        for (code, signal) in [(Some(134), None), (None, Some(SIGABRT)), (Some(221), None)] {
            let policy = watcher_exit_capture_policy(code, signal);
            assert_eq!(policy, WatcherExitCapturePolicy::Capture);
            assert!(should_capture_watcher_exit(policy, 1));
        }

        let mut posix_unknown = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut posix_unknown,
            Some(221),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
        let unknown_capture = posix_unknown.captures.first().expect("exit 221 captures");
        assert_eq!(
            unknown_capture.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:221", "none"]
        );
        assert!(unknown_capture
            .message
            .contains("code=Some(221) signal=None"));
        assert!(unknown_capture
            .extras
            .iter()
            .all(|(name, _)| name != "termination_status_raw"));

        let windows_fault = 0xC000_0409u32 as i32;
        let mut windows_status = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut windows_status,
            Some(windows_fault),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Windows,
            &WatcherExitCaptureContext::default(),
        );
        let windows_capture = windows_status
            .captures
            .first()
            .expect("Windows fault captures");
        assert_eq!(
            windows_capture.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
        assert!(windows_capture.message.contains("0xC0000409 (fault)"));
        assert_eq!(
            recorded_tag(windows_capture, "windows_exit_status"),
            "0xC0000409"
        );
        assert!(windows_capture
            .extras
            .iter()
            .all(|(name, _)| name != "termination_status_raw"));

        let mut posix_134 = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut posix_134,
            Some(134),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
        let posix_134_capture = posix_134.captures.first().expect("POSIX 134 captures");
        assert_eq!(
            posix_134_capture.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:134", "none"]
        );
        assert!(posix_134_capture
            .message
            .contains("code=Some(134) signal=None"));
        assert!(posix_134_capture
            .extras
            .iter()
            .all(|(name, _)| name != "termination_status_raw"));
    }

    #[test]
    fn windows_fastfail_watcher_capture_attributes_libuv_fatal_syscall_and_labels_the_shim() {
        // The exact live-event stderr (HQ-DESKTOP-4X): base classified this to
        // `none`/`all_redacted`; the candidate recovers the syscall + errno.
        let libuv_line = "ReadDirectoryChangesW: (5) Access is denied.";
        let mut totals = RunTotals::default();
        totals.record_stderr_line(libuv_line);
        // The production builder computes the job buckets on Windows at exit; a
        // unit test supplies the already-bucketed values it would carry.
        let context = WatcherExitCaptureContext {
            runner_fatal_class: totals.runner_fatal_class.as_str().to_string(),
            runner_fatal_syscall: totals.runner_fatal_syscall().map(|s| s.to_string()),
            runner_fatal_errno: totals.runner_fatal_errno(),
            watcher_job_peak_commit_bucket: "512mb_to_1gb".to_string(),
            watcher_job_process_count: "2".to_string(),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd",
            Some(libuv_line),
            TerminationHost::Windows,
            &context,
        );
        let capture = effects.captures.first().expect("fastfail captures");
        // Grouping continuity: the family fingerprint is untouched — none of the
        // new tokens may enter it, or the six-week history fragments again.
        assert_eq!(
            capture.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
        assert_eq!(
            recorded_tag(capture, "runner_fatal_class"),
            "libuv_fatal_syscall"
        );
        assert_eq!(
            recorded_tag(capture, "runner_fatal_syscall"),
            "ReadDirectoryChangesW"
        );
        assert_eq!(recorded_tag(capture, "runner_fatal_errno"), "5");
        assert_eq!(
            recorded_tag(capture, "watcher_job_peak_commit_bucket"),
            "512mb_to_1gb"
        );
        assert_eq!(recorded_tag(capture, "watcher_job_process_count"), "2");
        assert_eq!(recorded_tag(capture, "watcher_child_kind"), "cmd_shim");
        assert_eq!(recorded_tag(capture, "rss_scope"), "shim");
        // Pre-existing channels are unchanged.
        assert_eq!(recorded_tag(capture, "sync_route"), "watcher");
        assert_eq!(recorded_tag(capture, "windows_exit_status"), "0xC0000409");
    }

    #[test]
    fn watcher_capture_always_reports_job_and_child_channels_even_when_unknown() {
        // A direct executable with no libuv line: the job/child channels are still
        // present (as `unknown`/`direct_executable`) so `silent` is distinguishable
        // from `spoke but unrecognised`, and no syscall/errno tags are attached.
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Windows,
            &WatcherExitCaptureContext::default(),
        );
        let capture = effects.captures.first().expect("captures");
        assert_eq!(
            recorded_tag(capture, "watcher_job_peak_commit_bucket"),
            "unknown"
        );
        assert_eq!(recorded_tag(capture, "watcher_job_process_count"), "unknown");
        // `npx` is a direct launcher, not the runner, so its RSS is scoped away.
        assert_eq!(recorded_tag(capture, "watcher_child_kind"), "launcher");
        assert_eq!(recorded_tag(capture, "rss_scope"), "launcher");
        assert!(
            capture.tags.iter().all(|(k, _)| k != "runner_fatal_syscall"),
            "no libuv line -> no syscall tag"
        );
        assert!(capture.tags.iter().all(|(k, _)| k != "runner_fatal_errno"));
    }

    #[test]
    fn watcher_capture_reports_windows_fault_provenance_and_stderr_diagnostics() {
        // A generation whose OS fault record named node.exe/ntdll.dll and bound to
        // it by PID: the new content-safe fields ride the capture, additive to the
        // untouched classifier channels. Codes/offsets are bare decimal integers.
        let context = WatcherExitCaptureContext {
            watcher_fault_provenance: "pid_matched".to_string(),
            watcher_fault_faulting_image: "node_exe".to_string(),
            watcher_fault_faulting_module: "ntdll_dll".to_string(),
            watcher_fault_exception_code: Some(0xC000_0409),
            watcher_fault_offset: Some(0x2a1b3),
            runner_stderr_line_count: Some(8),
            runner_unmatched_stderr_shapes: Some("ndjson_record:6,stack_frame:2".to_string()),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd",
            None,
            TerminationHost::Windows,
            &context,
        );
        let capture = effects.captures.first().expect("fault captures");
        assert_eq!(
            recorded_tag(capture, "watcher_fault_provenance"),
            "pid_matched"
        );
        assert_eq!(
            recorded_tag(capture, "watcher_fault_faulting_image"),
            "node_exe"
        );
        assert_eq!(
            recorded_tag(capture, "watcher_fault_faulting_module"),
            "ntdll_dll"
        );
        assert_eq!(
            recorded_tag(capture, "runner_unmatched_stderr_shapes"),
            "ndjson_record:6,stack_frame:2"
        );
        assert_eq!(recorded_number_extra(capture, "runner_stderr_line_count"), 8);
        assert_eq!(
            recorded_string_extra(capture, "watcher_fault_exception_code"),
            "3221226505"
        );
        assert_eq!(
            recorded_string_extra(capture, "watcher_fault_offset"),
            "172467"
        );
        // Grouping continuity: the new fields never enter the family fingerprint.
        assert_eq!(
            capture.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
    }

    #[test]
    fn watcher_capture_emits_the_http_and_cause_axes_alongside_shape_and_path_root() {
        // Route parity: the watcher seam pushes the two additive axes from the
        // SAME RunTotals fields the manual seam reads. The desktop-alt e2e spec
        // pins that both seams read `totals.runner_error_http`/`_causes`; this
        // proves the watcher-route tag-push wiring emits them on the capture.
        let context = WatcherExitCaptureContext {
            runner_error_shapes: Some("presigned_get_failed:40,unknown:8".to_string()),
            runner_error_path_roots: Some("knowledge:120,repos:40".to_string()),
            runner_error_http: Some("http_500:40,http_403:8".to_string()),
            runner_error_causes: Some("unknown:160,access_denied:8".to_string()),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(221),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &context,
        );
        let capture = effects
            .captures
            .first()
            .expect("unexpected watcher exit captures");
        assert_eq!(
            recorded_tag(capture, "runner_error_http"),
            "http_500:40,http_403:8"
        );
        assert_eq!(
            recorded_tag(capture, "runner_error_causes"),
            "unknown:160,access_denied:8"
        );
        // The pre-existing axes still ride the same capture unchanged.
        assert_eq!(
            recorded_tag(capture, "runner_error_shapes"),
            "presigned_get_failed:40,unknown:8"
        );
        assert_eq!(
            recorded_tag(capture, "runner_error_path_roots"),
            "knowledge:120,repos:40"
        );
    }

    #[test]
    fn watcher_capture_reports_not_applicable_fault_provenance_by_default() {
        // No Windows fault read applies to a default context (no deferred read
        // seeded): provenance renders the honest `not_applicable` token — no longer
        // masquerading as the overloaded `unavailable` — while image + module keep
        // the `unavailable` sentinel and no code/offset extras are attached, so
        // absence never renders as an attribution.
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Windows,
            &WatcherExitCaptureContext::default(),
        );
        // No deferred read on a default context, so the capture is sent, not held.
        assert!(effects.deferred_watcher_fault.is_empty());
        let capture = effects.captures.first().expect("captures");
        assert_eq!(
            recorded_tag(capture, "watcher_fault_provenance"),
            "not_applicable"
        );
        assert_eq!(
            recorded_tag(capture, "watcher_fault_faulting_image"),
            "unavailable"
        );
        assert_eq!(
            recorded_tag(capture, "watcher_fault_faulting_module"),
            "unavailable"
        );
        assert!(capture
            .tags
            .iter()
            .all(|(k, _)| k != "runner_unmatched_stderr_shapes"));
        assert!(capture
            .extras
            .iter()
            .all(|(k, _)| k != "watcher_fault_exception_code"));
        assert!(capture
            .extras
            .iter()
            .all(|(k, _)| k != "watcher_fault_offset"));
    }

    // ── Deferred watcher-fault capture wiring (HQ-DESKTOP-4X) ──

    #[test]
    fn watcher_fault_deferred_read_is_held_off_the_exit_path() {
        // A Windows fault exit whose OS fault read is deferred: the capture is
        // HELD, not sent, carrying the honest `deferred` provenance, the seeded
        // all-zero counters, and the WER-independent job-image tree observation.
        // The exit callback itself performs zero Event Log work — the read runs on
        // the deferred worker, so emit_exit_then_deregister is never delayed by it.
        let context = WatcherExitCaptureContext {
            watcher_fault_provenance: WatcherFaultProvenance::Deferred.as_str().to_string(),
            watcher_fault_read_counters: Some(WatcherFaultReadCounters::default().tag_value()),
            watcher_fault_job_images: Some("node_exe,cmd_exe".to_string()),
            watcher_fault_job_culprit_candidate: Some("node_exe".to_string()),
            watcher_fault_job_image_provenance: Some("job_tree_observed".to_string()),
            watcher_fault_deferred_read: Some(WatcherFaultDeferredRead {
                sampled_pids: vec![6700],
                exception_code: 0xC000_0409,
                gen_start_ms: 1_000_000,
                gen_end_ms: 1_001_000,
            }),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd",
            None,
            TerminationHost::Windows,
            &context,
        );
        assert!(
            effects.captures.is_empty(),
            "a deferred fault read must NOT send on the exit path"
        );
        let held = effects
            .deferred_watcher_fault
            .first()
            .expect("fault capture deferred off the exit path");
        assert_eq!(recorded_tag(held, "watcher_fault_provenance"), "deferred");
        assert_eq!(recorded_tag(held, "watcher_fault_faulting_image"), "unavailable");
        assert_eq!(
            recorded_tag(held, "watcher_fault_read"),
            "seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:0,ms:0"
        );
        assert_eq!(recorded_tag(held, "watcher_fault_job_images"), "node_exe,cmd_exe");
        assert_eq!(
            recorded_tag(held, "watcher_fault_job_culprit_candidate"),
            "node_exe"
        );
        assert_eq!(
            recorded_tag(held, "watcher_fault_job_image_provenance"),
            "job_tree_observed"
        );
        // Grouping continuity: the deferred event's fingerprint is byte-identical
        // to what an immediate capture for the same inputs would have produced.
        assert_eq!(
            held.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
        // Lifecycle recovery ran synchronously and is unaffected by the deferral.
        assert!(effects
            .lifecycle
            .iter()
            .any(|(state, _)| matches!(state, WatchDaemonState::Stopped | WatchDaemonState::Backoff)));
    }

    #[test]
    fn watcher_fault_deferred_registry_flushes_exactly_once() {
        // The pending registry drains take-once: a teardown flush emits every
        // in-flight capture exactly once, and a second flush drains nothing, so a
        // completing worker can never double-send.
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_pending_watcher_fault_registry_for_test();
        let make = || {
            DeferredWatcherFaultCapture::new(
                "auto-sync watcher exited unexpectedly",
                &["sync", "auto-sync-watcher-termination", "windows:fault:0xC0000409", "none"],
                &[("watcher_fault_provenance", "deferred".to_string())],
                &[],
                WatcherFaultDeferredRead {
                    sampled_pids: vec![],
                    exception_code: 0xC000_0409,
                    gen_start_ms: 0,
                    gen_end_ms: 1,
                },
            )
        };
        let first = register_pending_watcher_fault_capture(make());
        let second = register_pending_watcher_fault_capture(make());
        assert!(first.is_ok() && second.is_ok(), "registrations queue before shutdown");
        let mut sent: Vec<DeferredWatcherFaultCapture> = Vec::new();
        assert_eq!(
            flush_pending_watcher_fault_captures_with(|payload| sent.push(payload)),
            2
        );
        assert_eq!(sent.len(), 2);
        // Nothing left: the completing workers' takes will all return None.
        assert_eq!(
            flush_pending_watcher_fault_captures_with(|payload| sent.push(payload)),
            0
        );
        assert!(take_pending_watcher_fault_capture(first.unwrap()).is_none());
        reset_pending_watcher_fault_registry_for_test();
    }

    #[test]
    fn watcher_fault_flush_is_a_barrier_against_later_registration() {
        // The shutdown race Codex flagged: once a teardown flush has drained, a
        // watcher-exit callback that was still building its payload could `register`
        // a fresh deferral into a vector nothing will drain again. The armed latch
        // must reject that registration so the caller emits it immediately instead.
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_pending_watcher_fault_registry_for_test();
        let make = || {
            DeferredWatcherFaultCapture::new(
                "auto-sync watcher exited unexpectedly",
                &["sync", "auto-sync-watcher-termination", "windows:fault:0xC0000409", "none"],
                &[("watcher_fault_provenance", "deferred".to_string())],
                &[],
                WatcherFaultDeferredRead {
                    sampled_pids: vec![],
                    exception_code: 0xC000_0409,
                    gen_start_ms: 0,
                    gen_end_ms: 1,
                },
            )
        };
        // Before any flush a registration queues normally.
        assert!(register_pending_watcher_fault_capture(make()).is_ok());
        // The flush arms the latch and drains the one queued capture.
        assert_eq!(
            flush_pending_watcher_fault_captures_with(|_| {}),
            1,
            "the flush drains the pre-registered capture"
        );
        // A registration arriving AFTER the flush is refused, handing the payload
        // back so `spawn_deferred_watcher_fault_capture` sends it immediately rather
        // than losing it to an abandoned registry.
        match register_pending_watcher_fault_capture(make()) {
            Err(returned) => {
                assert_eq!(returned.message, "auto-sync watcher exited unexpectedly");
            }
            Ok(_) => panic!("registration after a flush must be refused by the shutdown latch"),
        }
        // The refused registration was NOT queued: a further flush drains nothing.
        assert_eq!(flush_pending_watcher_fault_captures_with(|_| {}), 0);
        reset_pending_watcher_fault_registry_for_test();
    }

    #[test]
    fn watcher_fault_deferred_finalize_resolves_or_keeps_provenance() {
        use hq_desktop_core::watcher_fault::{
            attribute_watcher_fault, WatcherFaultBinary, WerApplicationError,
        };
        let base = DeferredWatcherFaultCapture::new(
            "auto-sync watcher exited unexpectedly",
            &["sync", "auto-sync-watcher-termination", "windows:fault:0xC0000409", "none"],
            &[
                ("watcher_fault_provenance", "deferred".to_string()),
                ("watcher_fault_faulting_image", "unavailable".to_string()),
                ("watcher_fault_read", "seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:0,ms:0".to_string()),
            ],
            &[],
            WatcherFaultDeferredRead {
                sampled_pids: vec![6700],
                exception_code: 0xC000_0409,
                gen_start_ms: 1_000_000,
                gen_end_ms: 1_001_000,
            },
        );
        let tag = |payload: &DeferredWatcherFaultCapture, key: &str| {
            payload
                .tags
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let has_extra = |payload: &DeferredWatcherFaultCapture, key: &str| {
            payload.extras.iter().any(|(k, _)| k == key)
        };

        // A resolved read patches ONLY the watcher_fault_* fields and stamps the
        // resolution; the fingerprint is untouched.
        let record = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0x2a1b3),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_500),
        };
        let resolved = attribute_watcher_fault(&[record], &[6700], 1_000_000, 1_001_000, Some(0xC000_0409));
        let out = finalize_watcher_fault_payload(base.clone(), Some(resolved), "read_resolved");
        assert_eq!(tag(&out, "watcher_fault_provenance"), "pid_matched");
        assert_eq!(tag(&out, "watcher_fault_faulting_image"), "node_exe");
        assert_eq!(tag(&out, "watcher_fault_faulting_module"), "ntdll_dll");
        assert!(has_extra(&out, "watcher_fault_exception_code"));
        assert!(has_extra(&out, "watcher_fault_read_resolution"));
        assert_eq!(out.fingerprint, base.fingerprint);

        // An unresolved (teardown-flushed) payload keeps the honest `deferred`
        // provenance and never names an image, only stamping the resolution.
        let flushed = finalize_watcher_fault_payload(base.clone(), None, "teardown_flush");
        assert_eq!(tag(&flushed, "watcher_fault_provenance"), "deferred");
        assert_eq!(tag(&flushed, "watcher_fault_faulting_image"), "unavailable");
        assert!(!has_extra(&flushed, "watcher_fault_exception_code"));
        assert!(has_extra(&flushed, "watcher_fault_read_resolution"));
    }

    #[test]
    fn libuv_fatal_syscall_capture_never_leaks_raw_stderr_path_or_argv() {
        // A machine-specific libuv line + a private argv. The class/syscall/errno
        // are recovered, but only the allow-listed constant, the integer, and
        // fixed labels escape — no path, message body, or argv reaches the wire.
        let private_line =
            r"ReadDirectoryChangesW: (5) C:\Users\Ada\companies\personal\secret-plan.md denied";
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd --private-secret-arg",
            Some(private_line),
            TerminationHost::Windows,
            &WatcherExitCaptureContext::default(),
        );
        let capture = effects.captures.first().expect("captures");
        assert_eq!(
            recorded_tag(capture, "runner_fatal_class"),
            "libuv_fatal_syscall"
        );
        assert_eq!(
            recorded_tag(capture, "runner_fatal_syscall"),
            "ReadDirectoryChangesW"
        );
        assert_eq!(recorded_tag(capture, "runner_fatal_errno"), "5");

        let mut wire = vec![capture.message.as_str()];
        wire.extend(capture.fingerprint.iter().map(String::as_str));
        wire.extend(capture.tags.iter().map(|(_, value)| value.as_str()));
        wire.extend(capture.extras.iter().filter_map(|(_, value)| match value {
            sentry::protocol::Value::String(value) => Some(value.as_str()),
            _ => None,
        }));
        for secret in [
            "secret-plan",
            "Ada",
            "companies",
            "personal",
            "private-secret-arg",
            r"C:\Users",
        ] {
            assert!(
                wire.iter().all(|value| !value.contains(secret)),
                "wire capture leaked {secret}"
            );
        }
    }

    #[test]
    fn windows_watcher_capture_attributes_assertion_identity_from_the_shared_helper() {
        // HQ-DESKTOP-50 parity: the watcher route recovers the SAME assertion
        // identity as the manual route (both call runner_assertion_for_class),
        // plus the stdout count and Node major, without leaking the private tail.
        let private = r"C:\Users\Ada\companies\personal\secret-plan.md";
        let assertion_line = format!(
            "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76: {private}"
        );
        let mut totals = RunTotals::default();
        totals.record_stderr_line(&assertion_line);
        let context = WatcherExitCaptureContext {
            runner_fatal_class: totals.runner_fatal_class.as_str().to_string(),
            runner_assert_source: totals.runner_assert_source().map(|s| s.to_string()),
            runner_assert_line: totals.runner_assert_line(),
            runner_assert_signature: totals.runner_assert_signature().map(|s| s.to_string()),
            runner_stdout_line_count: 5,
            runner_node_major: Some(20),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(0xC000_0409u32 as i32),
            None,
            false,
            false,
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd",
            Some(&assertion_line),
            TerminationHost::Windows,
            &context,
        );
        let capture = effects.captures.first().expect("captures");
        assert_eq!(recorded_tag(capture, "sync_route"), "watcher");
        assert_eq!(recorded_tag(capture, "runner_fatal_class"), "libuv_assert");
        assert_eq!(recorded_tag(capture, "runner_assert_source"), "libuv_win_async");
        let signature = recorded_tag(capture, "runner_assert_signature");
        assert_eq!(signature.len(), 16);
        assert!(signature.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(recorded_number_extra(capture, "runner_assert_line"), 76);
        assert_eq!(recorded_number_extra(capture, "runner_stdout_line_count"), 5);
        assert_eq!(recorded_string_extra(capture, "runner_node_major"), "20");

        // The private tail never reaches the wire through any new field.
        let mut wire = vec![capture.message.as_str()];
        wire.extend(capture.fingerprint.iter().map(String::as_str));
        wire.extend(capture.tags.iter().map(|(_, value)| value.as_str()));
        wire.extend(capture.extras.iter().filter_map(|(_, value)| match value {
            sentry::protocol::Value::String(value) => Some(value.as_str()),
            _ => None,
        }));
        for secret in ["secret-plan", "Ada", "UV_HANDLE_CLOSING", "async.c"] {
            assert!(
                wire.iter().all(|value| !value.contains(secret)),
                "wire capture leaked {secret}"
            );
        }
    }

    #[test]
    fn watcher_job_and_child_helpers_are_fixed_vocabulary() {
        assert_eq!(watcher_job_peak_commit_bucket(0), "under_128mb");
        assert_eq!(
            watcher_job_peak_commit_bucket(127 * 1024 * 1024),
            "under_128mb"
        );
        assert_eq!(
            watcher_job_peak_commit_bucket(128 * 1024 * 1024),
            "128mb_to_512mb"
        );
        assert_eq!(
            watcher_job_peak_commit_bucket(700 * 1024 * 1024),
            "512mb_to_1gb"
        );
        assert_eq!(
            watcher_job_peak_commit_bucket(1500 * 1024 * 1024),
            "1gb_to_2gb"
        );
        assert_eq!(
            watcher_job_peak_commit_bucket(4u64 * 1024 * 1024 * 1024),
            "over_2gb"
        );

        // Batch shim, direct npx launcher, and a hypothetical direct runner.
        assert_eq!(watcher_child_kind(r"C:\p\npx.cmd"), "cmd_shim");
        assert_eq!(watcher_child_kind("/usr/local/bin/setup.BAT"), "cmd_shim");
        assert_eq!(watcher_child_kind("/opt/homebrew/bin/npx"), "launcher");
        assert_eq!(watcher_child_kind("npx.exe"), "launcher");
        assert_eq!(watcher_child_kind("node"), "direct_executable");
        assert_eq!(rss_scope(r"C:\p\npx.cmd"), "shim");
        assert_eq!(rss_scope("/opt/homebrew/bin/npx"), "launcher");
        assert_eq!(rss_scope("node"), "runner");
    }

    #[cfg(unix)]
    #[test]
    fn real_spawn_failure_drives_capture_grouping_log_and_backoff() {
        use hq_desktop_core::process_types::SpawnArgs;

        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("missing-runner").display().to_string();
        let spawn = SpawnArgs {
            cmd: missing.clone(),
            args: Vec::new(),
            cwd: None,
            env: None,
        };
        let error = run_process_impl("watcher-policy-real-spawn-error", &spawn, |_| {})
            .expect_err("missing executable must fail at spawn");
        let mut effects = RecordingWatcherEffects::default();

        record_watcher_process_error_with_effects(&mut effects, error);

        assert_eq!(effects.captures.len(), 1);
        assert_eq!(
            effects.lifecycle,
            vec![(
                WatchDaemonState::Backoff,
                DaemonFailureCategory::SpawnFailed
            )]
        );
        assert!(effects.logs.iter().any(|(target, message)| {
            target == "daemon" && message.starts_with("spawn failed: spawn '")
        }));
        let capture = &effects.captures[0];
        assert!(capture.message.contains(&missing));
        assert_eq!(
            capture.fingerprint,
            vec![
                "sync".to_string(),
                "auto-sync-watcher-spawn".to_string(),
                "not-found".to_string(),
            ]
        );
        assert!(!capture
            .fingerprint
            .iter()
            .any(|part| part.contains(tmp.path().to_string_lossy().as_ref())));
    }

    #[test]
    fn transient_spawn_exhaustion_retries_with_breadcrumb_log_and_backoff() {
        let error = ProcessError::Spawn {
            cmd: "/opt/homebrew/bin/npx".to_string(),
            source: std::io::Error::new(std::io::ErrorKind::WouldBlock, "resource unavailable"),
        };
        let mut effects = RecordingWatcherEffects::default();

        record_watcher_process_error_with_effects(&mut effects, error);

        assert!(effects.captures.is_empty());
        assert_eq!(
            effects.lifecycle,
            vec![(
                WatchDaemonState::Backoff,
                DaemonFailureCategory::SpawnFailed
            )]
        );
        assert!(effects.logs.iter().any(|(target, message)| {
            target == "daemon" && message.starts_with("spawn failed: spawn '")
        }));
        assert!(effects.breadcrumbs.iter().any(|(category, _, message)| {
            category == "daemon.spawn" && message.contains("transient auto-sync watcher")
        }));
    }

    #[test]
    fn post_spawn_process_errors_cannot_capture_twice_or_claim_spawn_failure() {
        let errors = [
            ProcessError::Stream {
                stream: "stdout",
                source: std::io::Error::other("read failed"),
            },
            ProcessError::Wait {
                source: std::io::Error::other("wait failed"),
            },
        ];

        for error in errors {
            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                None,
                None,
                false,
                false,
                "npx",
                None,
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );
            assert_eq!(effects.captures.len(), 1, "terminal Exit owns capture");

            record_watcher_process_error_with_effects(&mut effects, error);

            assert_eq!(
                effects.captures.len(),
                1,
                "process error must not recapture"
            );
            assert!(!effects
                .captures
                .iter()
                .any(|capture| capture.message.contains("failed to spawn")));
            assert!(effects.logs.iter().any(|(target, message)| {
                target == "daemon"
                    && message.contains("failed after spawn")
                    && message.contains("terminal exit handler owns capture")
            }));
        }
    }

    #[test]
    fn stale_spawn_ownership_loss_is_local_log_only() {
        let mut effects = RecordingWatcherEffects::default();

        record_watcher_process_error_with_effects(
            &mut effects,
            ProcessError::OwnershipLost {
                handle: DAEMON_HANDLE.to_string(),
                generation: 41,
                cleanup_error: None,
            },
        );

        assert!(effects.captures.is_empty());
        assert!(effects.lifecycle.is_empty());
        assert!(effects.logs.iter().any(|(target, message)| {
            target == "daemon"
                && message.contains("stale watcher spawn discarded")
                && message.contains("generation 41")
        }));
        assert!(!effects
            .logs
            .iter()
            .any(|(_, message)| { message.contains("terminal exit handler owns capture") }));
    }

    #[test]
    fn stale_spawn_cleanup_failure_is_captured_and_enters_backoff() {
        let mut effects = RecordingWatcherEffects::default();

        record_watcher_process_error_with_effects(
            &mut effects,
            ProcessError::OwnershipLost {
                handle: DAEMON_HANDLE.to_string(),
                generation: 42,
                cleanup_error: Some(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected cleanup failure",
                )),
            },
        );

        assert_eq!(
            effects.lifecycle,
            vec![(WatchDaemonState::Backoff, DaemonFailureCategory::Crash)],
            "failed cleanup is an internal watcher fault, not a successful stale discard"
        );
        assert_eq!(effects.captures.len(), 1);
        assert_eq!(
            effects.captures[0].fingerprint,
            vec!["sync", "auto-sync-watcher-ownership-cleanup"]
        );
        assert!(effects.captures[0]
            .message
            .contains("stale-child cleanup failed"));
        assert!(effects.logs.iter().any(|(target, message)| {
            target == "daemon"
                && message.contains("stale watcher cleanup failed")
                && message.contains("generation 42")
        }));
        assert!(!effects.logs.iter().any(|(_, message)| {
            message.contains("stale watcher spawn discarded without touching its replacement")
        }));
    }

    #[test]
    fn exec_not_runnable_escalation_counts_its_own_failure_class_only() {
        let exec_policy = WatcherExitCapturePolicy::CaptureRateLimited;

        // A global crash-loop already at #4 (for example, three prior code-1
        // exits) must not cause this first 127 to page immediately.
        let first_exec = next_exec_not_runnable_streak(0, exec_policy);
        assert_eq!(first_exec, 1);
        assert!(!should_capture_watcher_exit(exec_policy, first_exec));

        let mut streak = first_exec;
        for expected in [2, 3, 4] {
            streak = next_exec_not_runnable_streak(streak, exec_policy);
            assert_eq!(streak, expected);
        }
        assert!(should_capture_watcher_exit(exec_policy, 4));

        // Any non-126/127 exit ends the class-specific episode.
        assert_eq!(
            next_exec_not_runnable_streak(streak, WatcherExitCapturePolicy::LocalLogOnly),
            0
        );
        assert_eq!(next_exec_not_runnable_streak(0, exec_policy), 1);
    }

    #[test]
    fn windows_console_control_exit_is_the_only_benign_windows_status() {
        const WINDOWS_CONTROL_C_EXIT: i32 = -1073741510;
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        assert!(is_benign_watcher_exit(Some(WINDOWS_CONTROL_C_EXIT), None));
        assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);

        for code in [
            OBSERVED_SESSION_TERMINATE_EXIT,
            -1073741509, // adjacent non-control NTSTATUS
            -1073741819, // 0xC0000005 access violation
            -1073741571, // 0xC00000FD stack overflow
            0,
            17,
            126,
            127,
        ] {
            assert!(
                !is_benign_watcher_exit(Some(code), None),
                "status {code} must still take the crash path"
            );
        }
        assert!(!is_benign_watcher_exit(
            Some(WINDOWS_CONTROL_C_EXIT),
            Some(SIGTERM)
        ));
    }

    #[test]
    fn watcher_console_control_exit_skips_sentry_but_crashes_still_capture() {
        const WINDOWS_CONTROL_C_EXIT: i32 = -1073741510;
        let mut suppressed = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut suppressed,
            Some(WINDOWS_CONTROL_C_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );
        assert!(
            suppressed.captures.is_empty(),
            "STATUS_CONTROL_C_EXIT must remain a local breadcrumb, never an error event"
        );

        let mut crashes = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut crashes,
            Some(-1),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );
        assert_eq!(
            crashes.captures.len(),
            1,
            "an unexplained runner exit must continue to capture"
        );
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_escalation_records_no_capture() {
        use crate::commands::process::{deregister_process, SpawnArgs};
        use std::sync::mpsc;

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(true, Ordering::Release);

        let daemon_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire daemon generation");
        let (ready_tx, ready_rx) = mpsc::channel();
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let captures = sentry::test::with_captured_events(|| {
                run_process_impl(
                    DAEMON_HANDLE,
                    &SpawnArgs {
                        cmd: "sh".to_string(),
                        args: vec![
                            "-c".to_string(),
                            "trap '' TERM; echo ready; while :; do sleep 1; done".to_string(),
                        ],
                        cwd: None,
                        env: None,
                    },
                    |event| match event {
                        ProcessEvent::Stdout(line) if line == "ready" => {
                            ready_tx
                                .send(())
                                .expect("watchdog readiness receiver must remain alive");
                        }
                        ProcessEvent::Exit {
                            code,
                            signal,
                            success,
                        } => {
                            let cancelled =
                                is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation);
                            handle_watcher_exit(
                                code,
                                signal,
                                success,
                                cancelled,
                                "npx",
                                None,
                                &WatcherExitCaptureContext::default(),
                            );
                            terminal = Some((code, signal, success, cancelled));
                        }
                        _ => {}
                    },
                )
                .expect("watchdog fixture must reach its terminal callback");
            });
            (
                terminal.expect("watchdog fixture must emit one terminal event"),
                captures,
            )
        });

        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("watchdog fixture must install its SIGTERM trap before cancellation");
        assert!(lookup_pid(DAEMON_HANDLE).is_some());

        assert!(terminate_daemon_once_with_delay(
            DaemonFailureCategory::HeartbeatStall,
            Duration::from_millis(100),
        ));
        let ((code, signal, success, cancelled), captures) = runner
            .join()
            .expect("watchdog process runner must not panic");
        HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(false, Ordering::Release);

        assert_eq!((code, signal, success), (None, Some(9), false));
        assert!(
            cancelled,
            "the terminal reporting boundary must see cancellation"
        );
        assert!(
            captures.is_empty(),
            "the real watcher capture path must stay silent for watchdog SIGKILL escalation"
        );
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Stopped);
        assert!(!is_registered(DAEMON_HANDLE));
    }

    #[cfg(unix)]
    #[test]
    fn uncancelled_real_sigkill_reaches_the_production_capture_boundary() {
        use crate::commands::process::{deregister_process, SpawnArgs};
        use nix::{
            sys::signal::{self, Signal},
            unistd::Pid,
        };
        use std::sync::mpsc;

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        note_watcher_spawned();
        let daemon_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire daemon generation");
        let (ready_tx, ready_rx) = mpsc::channel();
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let captures = sentry::test::with_captured_events(|| {
                run_process_impl_for_generation(
                    DAEMON_HANDLE,
                    daemon_generation,
                    &SpawnArgs {
                        cmd: "sh".to_string(),
                        args: vec![
                            "-c".to_string(),
                            "echo ready; while :; do sleep 1; done".to_string(),
                        ],
                        cwd: None,
                        env: None,
                    },
                    |event| match event {
                        ProcessEvent::Stdout(line) if line == "ready" => {
                            ready_tx
                                .send(())
                                .expect("SIGKILL readiness receiver must remain alive");
                        }
                        ProcessEvent::Exit {
                            code,
                            signal,
                            success,
                        } => {
                            let cancelled =
                                is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation);
                            let context = WatcherExitCaptureContext {
                                lifecycle_state: "running".to_string(),
                                runner_fatal_class: "none".to_string(),
                                runner_error_class: "none",
                                runner_phase: "unknown".to_string(),
                                runner_phase_elapsed_bucket: "under_1m".to_string(),
                                ..Default::default()
                            };
                            handle_watcher_exit(
                                code, signal, success, cancelled, "npx", None, &context,
                            );
                            terminal = Some((code, signal, success, cancelled));
                        }
                        _ => {}
                    },
                )
                .expect("externally killed fixture must reach its terminal callback");
            });
            (
                terminal.expect("externally killed fixture must emit one terminal event"),
                captures,
            )
        });

        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("fixture must become ready before the external kill");
        let pid = lookup_pid(DAEMON_HANDLE).expect("fixture must publish its pid");
        signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL)
            .expect("external SIGKILL must reach the process group");

        let ((code, signal, success, cancelled), captures) = runner
            .join()
            .expect("external-SIGKILL runner must not panic");
        assert_eq!((code, signal, success), (None, Some(9), false));
        assert!(!cancelled, "the external kill must remain unclaimed");
        assert_eq!(
            captures.len(),
            1,
            "the real capture boundary must emit once"
        );
        let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
            .expect("external SIGKILL event remains sendable");
        assert_eq!(
            event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "signal:9", "none"]
        );
        assert_eq!(event.tags["runner_fatal_class"], "none");
        assert_eq!(
            event.extra["watcher_cancelled"],
            sentry::protocol::Value::String("false".to_string())
        );
        assert!(!is_registered(DAEMON_HANDLE));
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    /// Base-red / candidate-green. Reproduces the production signature — an
    /// exact-shape (None, Some(9)) watcher exit reported as uncancelled while a
    /// heartbeat-stall teardown was in flight — by dropping the public handle in
    /// the terminal callback AFTER the wait owner has revoked signal authority,
    /// which is exactly the post-revocation entry loss the events hit. On the
    /// base the ephemeral flag is gone and the causeless record cannot attribute,
    /// so it captures; on the candidate the durable record now carries the
    /// HeartbeatStall cause and the exit is attributed silently.
    #[cfg(unix)]
    #[test]
    fn watchdog_escalation_attributes_via_durable_record_when_entry_dropped() {
        use crate::commands::process::{
            clear_cancellation_record_for_test, deregister_process, SpawnArgs,
        };
        use std::sync::mpsc;

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(true, Ordering::Release);

        let daemon_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire daemon generation");
        let (ready_tx, ready_rx) = mpsc::channel();
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let captures = sentry::test::with_captured_events(|| {
                run_process_impl(
                    DAEMON_HANDLE,
                    &SpawnArgs {
                        cmd: "sh".to_string(),
                        args: vec![
                            "-c".to_string(),
                            "trap '' TERM; echo ready; while :; do sleep 1; done".to_string(),
                        ],
                        cwd: None,
                        env: None,
                    },
                    |event| match event {
                        ProcessEvent::Stdout(line) if line == "ready" => {
                            ready_tx
                                .send(())
                                .expect("watchdog readiness receiver must remain alive");
                        }
                        ProcessEvent::Exit {
                            code,
                            signal,
                            success,
                        } => {
                            // By callback time the wait owner has already revoked
                            // signal authority, so releasing the public handle
                            // here takes the shipped drop-not-retire branch and
                            // the ephemeral `cancelled` flag can no longer be
                            // read — modeling the production flag loss. The durable
                            // record lives in a separate map and survives.
                            deregister_generation(DAEMON_HANDLE, daemon_generation);
                            let cancelled =
                                is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation);
                            let record = cancellation_record_for_generation(
                                DAEMON_HANDLE,
                                daemon_generation,
                            );
                            let context = WatcherExitCaptureContext {
                                cancellation_record_present: record.is_some(),
                                cancellation_record_cause: record.and_then(|r| r.cause),
                                cancellation_termination_effected: record
                                    .map(|r| r.termination_effected)
                                    .unwrap_or(false),
                                ..Default::default()
                            };
                            handle_watcher_exit(
                                code, signal, success, cancelled, "npx", None, &context,
                            );
                            terminal = Some((code, signal, success, cancelled, record));
                        }
                        _ => {}
                    },
                )
                .expect("watchdog fixture must reach its terminal callback");
            });
            (
                terminal.expect("watchdog fixture must emit one terminal event"),
                captures,
            )
        });

        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("watchdog fixture must install its SIGTERM trap before cancellation");
        assert!(lookup_pid(DAEMON_HANDLE).is_some());

        assert!(terminate_daemon_once_with_delay(
            DaemonFailureCategory::HeartbeatStall,
            Duration::from_millis(100),
        ));
        let ((code, signal, success, cancelled, record), captures) = runner
            .join()
            .expect("watchdog process runner must not panic");
        HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(false, Ordering::Release);
        clear_cancellation_record_for_test(DAEMON_HANDLE, daemon_generation);

        assert_eq!((code, signal, success), (None, Some(9), false));
        assert!(
            !cancelled,
            "the post-revocation entry drop must lose the ephemeral cancelled flag"
        );
        let record = record.expect("the durable cancellation record survives the entry drop");
        assert!(
            record.termination_effected,
            "the app observed SIGTERM delivery to the trapped group"
        );
        assert_eq!(
            record.cause,
            Some(SyncCancelCause::HeartbeatStall),
            "the watchdog teardown published its cause through the durable record"
        );
        assert!(
            captures.is_empty(),
            "the durable record attributes the app's own teardown despite the lost flag"
        );
        assert!(!is_registered(DAEMON_HANDLE));
        assert_eq!(current_lifecycle_state(), WatchDaemonState::Stopped);
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    /// Pins invariant 1: an external SIGKILL whose durable record carries a cause
    /// but `termination_effected=false` (what ESRCH / a lost or timed-out
    /// publication publishes) stays alertable, and the still-alertable capture
    /// carries the three fixed-vocabulary extras that make the next production
    /// event self-assigning.
    #[cfg(unix)]
    #[test]
    fn external_kill_with_stall_record_stays_alertable() {
        use crate::commands::process::{
            clear_cancellation_record_for_test, deregister_process,
            seed_cancellation_record_for_test, SpawnArgs,
        };
        use nix::{
            sys::signal::{self, Signal},
            unistd::Pid,
        };
        use std::sync::mpsc;

        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        deregister_process(DAEMON_HANDLE);
        note_watcher_spawned();
        let daemon_generation =
            try_register_handle_gen(DAEMON_HANDLE).expect("acquire daemon generation");
        // Seed the record the watchdog's own cancellation publishes on ESRCH / a
        // lost or timed-out publication: cause known, OS teardown NOT observed.
        seed_cancellation_record_for_test(
            DAEMON_HANDLE,
            daemon_generation,
            SyncCancelCause::HeartbeatStall,
            false,
        );
        let (ready_tx, ready_rx) = mpsc::channel();
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let captures = sentry::test::with_captured_events(|| {
                run_process_impl_for_generation(
                    DAEMON_HANDLE,
                    daemon_generation,
                    &SpawnArgs {
                        cmd: "sh".to_string(),
                        args: vec![
                            "-c".to_string(),
                            "echo ready; while :; do sleep 1; done".to_string(),
                        ],
                        cwd: None,
                        env: None,
                    },
                    |event| match event {
                        ProcessEvent::Stdout(line) if line == "ready" => {
                            ready_tx
                                .send(())
                                .expect("SIGKILL readiness receiver must remain alive");
                        }
                        ProcessEvent::Exit {
                            code,
                            signal,
                            success,
                        } => {
                            let cancelled =
                                is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation);
                            let record = cancellation_record_for_generation(
                                DAEMON_HANDLE,
                                daemon_generation,
                            );
                            let context = WatcherExitCaptureContext {
                                lifecycle_state: "running".to_string(),
                                runner_fatal_class: "none".to_string(),
                                runner_error_class: "none",
                                runner_phase: "unknown".to_string(),
                                runner_phase_elapsed_bucket: "under_1m".to_string(),
                                cancellation_record_present: record.is_some(),
                                cancellation_record_cause: record.and_then(|r| r.cause),
                                cancellation_termination_effected: record
                                    .map(|r| r.termination_effected)
                                    .unwrap_or(false),
                                ..Default::default()
                            };
                            handle_watcher_exit(
                                code, signal, success, cancelled, "npx", None, &context,
                            );
                            terminal = Some((code, signal, success, cancelled));
                        }
                        _ => {}
                    },
                )
                .expect("externally killed fixture must reach its terminal callback");
            });
            (
                terminal.expect("externally killed fixture must emit one terminal event"),
                captures,
            )
        });

        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("fixture must become ready before the external kill");
        let pid = lookup_pid(DAEMON_HANDLE).expect("fixture must publish its pid");
        signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL)
            .expect("external SIGKILL must reach the process group");

        let ((code, signal, success, cancelled), captures) = runner
            .join()
            .expect("external-SIGKILL runner must not panic");
        clear_cancellation_record_for_test(DAEMON_HANDLE, daemon_generation);
        assert_eq!((code, signal, success), (None, Some(9), false));
        assert!(!cancelled, "the external kill must remain unclaimed");
        assert_eq!(
            captures.len(),
            1,
            "termination_effected=false keeps the exit alertable under the existing fingerprint"
        );
        let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
            .expect("external SIGKILL event remains sendable");
        assert_eq!(
            event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "signal:9", "none"]
        );
        assert_eq!(
            event.extra["cancellation_record_present"],
            sentry::protocol::Value::String("true".to_string())
        );
        assert_eq!(
            event.extra["cancellation_record_cause"],
            sentry::protocol::Value::String("heartbeat-stall".to_string())
        );
        assert_eq!(
            event.extra["cancellation_termination_effected"],
            sentry::protocol::Value::String("false".to_string())
        );
        assert_eq!(
            event.extra["watcher_cancelled"],
            sentry::protocol::Value::String("false".to_string())
        );
        assert!(!is_registered(DAEMON_HANDLE));
        set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_sigkill_skips_capture_but_uncancelled_sigkill_still_captures() {
        let mut deliberate_stop = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut deliberate_stop,
            None,
            Some(9),
            false,
            true,
            "npx",
            None,
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );
        assert!(
            deliberate_stop.captures.is_empty(),
            "our own escalated SIGKILL must stop at the deliberate-stop boundary"
        );

        let mut external_kill = RecordingWatcherEffects::default();
        let external_context = WatcherExitCaptureContext {
            lifecycle_state: "running".to_string(),
            runner_fatal_class: "none".to_string(),
            runner_error_class: "none",
            runner_phase: "unknown".to_string(),
            runner_phase_elapsed_bucket: "under_1m".to_string(),
            ..Default::default()
        };
        handle_watcher_exit_with_effects(
            &mut external_kill,
            None,
            Some(9),
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &external_context,
        );
        assert_eq!(
            external_kill.captures.len(),
            1,
            "a never-cancelled SIGKILL must remain visible as a real crash"
        );
        assert!(external_kill.captures[0]
            .message
            .contains("auto-sync watcher exited unexpectedly"));
        assert_eq!(
            external_kill.captures[0].fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "signal:9", "none"]
        );
        assert!(external_kill.captures[0]
            .tags
            .contains(&("runner_fatal_class".to_string(), "none".to_string())));
        assert!(external_kill.captures[0].extras.contains(&(
            "watcher_cancelled".to_string(),
            sentry::protocol::Value::String("false".to_string())
        )));
    }

    #[test]
    fn watcher_exit_emits_the_shared_shape_path_and_scope_attribution() {
        use crate::events::SyncErrorEvent;

        // Feed the SAME error flood the manual-seam artifact test uses, through
        // the SAME RunTotals source, and prove the watcher route emits the
        // identical fixed-vocabulary attribution — the two seams cannot drift.
        let mut totals = RunTotals::default();
        for i in 0..120 {
            totals.record_error(&SyncErrorEvent {
                company: Some("acme".to_string()),
                path: format!("knowledge/secret-a{i}.md"),
                message: "download skipped: local parent escaped the sync root".to_string(),
            });
        }
        for i in 0..40 {
            totals.record_error(&SyncErrorEvent {
                company: Some("acme".to_string()),
                path: format!("repos/secret-b{i}"),
                message: format!("presigned GET failed for repos/secret-b{i}: 500"),
            });
        }
        for _ in 0..8 {
            totals.record_error(&SyncErrorEvent {
                company: Some("acme".to_string()),
                path: "(company)".to_string(),
                message: "Entity cmp_SECRET NOT FOUND".to_string(),
            });
        }
        let ndjson_tail = vec![
            r#"{"type":"error","company":"acme","path":"(company)","message":"Entity cmp_SECRET NOT FOUND"}"#
                .to_string(),
        ];

        // Exactly the expressions watcher_exit_capture_context() uses to read the
        // shared source.
        let context = WatcherExitCaptureContext {
            runner_error_rollup: totals.runner_error_rollup.tag_value(),
            runner_error_ops: totals.runner_error_ops.tag_value(),
            runner_error_shapes: totals.runner_error_shapes.tag_value(),
            runner_error_path_roots: totals.runner_error_path_roots.tag_value(),
            runner_error_scope: totals.runner_error_scope(),
            runner_stack_input: classify_runner_stack_input(&ndjson_tail)
                .as_str()
                .to_string(),
            ..Default::default()
        };

        let mut effects = RecordingWatcherEffects::default();
        // An external SIGKILL is an unexpected crash that captures.
        handle_watcher_exit_with_effects(
            &mut effects,
            None,
            Some(9),
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &context,
        );

        assert_eq!(effects.captures.len(), 1);
        let event = &effects.captures[0];
        assert_eq!(recorded_tag(event, "sync_route"), "watcher");
        // Identical to the manual seam's values for the same RunTotals.
        assert_eq!(recorded_tag(event, "runner_error_rollup"), "OTHER:168");
        assert_eq!(recorded_tag(event, "runner_error_ops"), "other:168");
        assert_eq!(
            recorded_tag(event, "runner_error_shapes"),
            "containment_escape:120,presigned_get_failed:40,unknown:8"
        );
        assert_eq!(
            recorded_tag(event, "runner_error_path_roots"),
            "knowledge:120,repos:40"
        );
        assert_eq!(
            recorded_string_extra(event, "runner_error_scope"),
            "company:8,file:160"
        );
        assert_eq!(
            recorded_string_extra(event, "runner_stack_input"),
            "ndjson_error_records"
        );

        // No seeded path/message bytes reach the wire.
        let mut wire_strings: Vec<&str> = event.tags.iter().map(|(_, v)| v.as_str()).collect();
        for (_, value) in &event.extras {
            if let sentry::protocol::Value::String(text) = value {
                wire_strings.push(text.as_str());
            }
        }
        for forbidden in [
            "secret-a",
            "secret-b",
            "cmp_SECRET",
            "acme",
            "escaped the sync root",
        ] {
            assert!(
                wire_strings.iter().all(|value| !value.contains(forbidden)),
                "watcher wire leaked seeded content: {forbidden}"
            );
        }
    }

    #[test]
    fn watcher_indeterminate_windows_status_captures_safe_evidence() {
        let context = WatcherExitCaptureContext {
            lifecycle_state: "running".to_string(),
            app_quit_in_progress: false,
            supervisor_respawn_in_flight: false,
            heartbeat_stall_termination_in_flight: false,
            cancelled: false,
            fatal_runner_signature_seen: true,
            runner_fatal_class: "none".to_string(),
            runner_error_rollup: Some("EPERM:2,EACCES:1".to_string()),
            runner_error_class: "eperm",
            runner_error_ops: Some("rename:2,open:1".to_string()),
            runner_error_companies: 2,
            runner_phase: "unknown".to_string(),
            runner_phase_elapsed_bucket: "under_1m".to_string(),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(-1),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &context,
        );

        assert_eq!(effects.captures.len(), 1);
        let event = &effects.captures[0];
        assert_eq!(recorded_tag(event, "windows_exit_status"), "0xFFFFFFFF");
        assert_eq!(
            recorded_tag(event, "windows_exit_class"),
            "indeterminate_status"
        );
        assert_eq!(
            recorded_tag(event, "runner_error_rollup"),
            "EPERM:2,EACCES:1"
        );
        assert_eq!(recorded_tag(event, "runner_error_ops"), "rename:2,open:1");
        assert_eq!(recorded_number_extra(event, "runner_error_companies"), 2);
        assert_eq!(
            recorded_string_extra(event, "watcher_lifecycle_state"),
            "running"
        );
        assert_eq!(
            recorded_string_extra(event, "fatal_runner_signature_seen"),
            "true"
        );
        assert_eq!(
            event
                .fingerprint
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:status-ffffffff",
                "eperm"
            ]
        );
        assert!(event.message.contains("0xFFFFFFFF (origin unknown)"));
        assert!(!event.message.contains("code=Some(-1)"));
    }

    #[test]
    fn watcher_termination_fingerprint_carries_runner_error_class() {
        let eperm_context = WatcherExitCaptureContext {
            runner_error_class: "eperm",
            runner_error_ops: Some("rename:1".to_string()),
            runner_error_companies: 1,
            ..Default::default()
        };
        let auth_context = WatcherExitCaptureContext {
            runner_error_class: "auth",
            runner_error_ops: Some("other:1".to_string()),
            runner_error_companies: 2,
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();

        handle_watcher_exit_with_effects(
            &mut effects,
            Some(-1),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &eperm_context,
        );
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(-1),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &auth_context,
        );

        assert_eq!(effects.captures.len(), 2);
        assert_eq!(
            effects.captures[0].fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:status-ffffffff",
                "eperm"
            ]
        );
        assert_eq!(
            effects.captures[1].fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:status-ffffffff",
                "auth"
            ]
        );
        assert_eq!(
            recorded_tag(&effects.captures[0], "runner_error_ops"),
            "rename:1"
        );
        assert_eq!(
            recorded_number_extra(&effects.captures[1], "runner_error_companies"),
            2
        );
    }

    #[test]
    fn watcher_session_terminate_captures_fixed_vocabulary_context() {
        // The observed Sentry wire value is decimal 1073807364, which is the
        // Windows status 0x40010004. It must stay alertable while carrying
        // enough fixed-vocabulary context to identify the terminator next time.
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
        let context = WatcherExitCaptureContext {
            lifecycle_state: "running".to_string(),
            app_quit_in_progress: false,
            supervisor_respawn_in_flight: true,
            heartbeat_stall_termination_in_flight: false,
            cancelled: false,
            fatal_runner_signature_seen: true,
            runner_fatal_class: "none".to_string(),
            runner_error_rollup: Some("EPERM:1".to_string()),
            runner_error_class: "eperm",
            runner_error_ops: Some("rename:1".to_string()),
            runner_error_companies: 1,
            runner_phase: "unknown".to_string(),
            runner_phase_elapsed_bucket: "under_1m".to_string(),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            false,
            "npx",
            Some("untrusted runner output stays local"),
            current_termination_host(),
            &context,
        );

        assert_eq!(
            effects.captures.len(),
            1,
            "session termination stays alertable"
        );
        let event = &effects.captures[0];
        assert_eq!(recorded_tag(event, "windows_exit_status"), "0x40010004");
        assert_eq!(
            recorded_tag(event, "windows_exit_class"),
            "session_terminate"
        );
        assert_eq!(recorded_tag(event, "runner_error_rollup"), "EPERM:1");
        assert_eq!(recorded_tag(event, "runner_error_ops"), "rename:1");
        assert_eq!(recorded_number_extra(event, "runner_error_companies"), 1);
        assert_eq!(
            recorded_string_extra(event, "watcher_lifecycle_state"),
            "running"
        );
        assert_eq!(
            recorded_string_extra(event, "app_quit_in_progress"),
            "false"
        );
        assert_eq!(
            recorded_string_extra(event, "supervisor_respawn_in_flight"),
            "true"
        );
        assert_eq!(
            recorded_string_extra(event, "heartbeat_stall_termination_in_flight"),
            "false"
        );
        assert_eq!(recorded_string_extra(event, "watcher_cancelled"), "false");
        assert_eq!(
            recorded_string_extra(event, "fatal_runner_signature_seen"),
            "true"
        );
        assert_eq!(
            event.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:session-terminate",
                "eperm"
            ]
        );
        assert!(event.message.contains("0x40010004 (session terminate)"));
        assert!(!event.message.contains("1073807364"));

        let mut deliberate_stop = RecordingWatcherEffects::default();
        let app_quit_context = WatcherExitCaptureContext {
            app_quit_in_progress: true,
            cancelled: true,
            ..Default::default()
        };
        handle_watcher_exit_with_effects(
            &mut deliberate_stop,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            true,
            "npx",
            None,
            current_termination_host(),
            &app_quit_context,
        );
        assert!(
            deliberate_stop.captures.is_empty(),
            "a cancelled app-quit path remains deliberately silent"
        );
    }

    #[test]
    fn watcher_session_terminate_with_observed_session_end_is_local_log_only() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        let context = WatcherExitCaptureContext {
            windows_terminator: Some(WindowsTerminatorAttribution::SessionEndObserved),
            ..Default::default()
        };
        let mut effects = RecordingWatcherEffects::default();

        handle_watcher_exit_with_effects(
            &mut effects,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &context,
        );

        assert!(effects.captures.is_empty());
        assert_eq!(
            effects.logs,
            vec![(
                "daemon".to_string(),
                "session-end-observed watcher exit #1 — capture skipped".to_string(),
            )]
        );
        assert_eq!(
            effects.breadcrumbs,
            vec![(
                "daemon.exit".to_string(),
                "Info".to_string(),
                "session-end-observed auto-sync watcher exit #1: windows_terminator=session_end_observed"
                    .to_string(),
            )]
        );
        assert_eq!(
            effects.lifecycle,
            vec![(WatchDaemonState::Backoff, DaemonFailureCategory::None)]
        );
    }

    /// HQ-DESKTOP-4N. The regression: a `DBG_TERMINATE_PROCESS` exit the
    /// observer could not attribute used to be captured on the spot, so an
    /// affirmation arriving even one millisecond later could not suppress it.
    /// It must now hold the SEND back — and the held-back payload must be
    /// byte-identical to what an immediate capture would have sent.
    #[test]
    fn watcher_session_terminate_unattributed_defers_the_send_it_used_to_make() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        let mut baseline = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut baseline,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );
        assert_eq!(baseline.captures.len(), 1);
        let baseline = &baseline.captures[0];

        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        ] {
            let context = WatcherExitCaptureContext {
                windows_terminator: Some(attribution),
                ..Default::default()
            };
            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                Some(OBSERVED_SESSION_TERMINATE_EXIT),
                None,
                false,
                false,
                "npx",
                None,
                current_termination_host(),
                &context,
            );

            assert!(
                effects.captures.is_empty(),
                "{attribution:?} must not send inline any more"
            );
            assert_eq!(
                effects.deferred.len(),
                1,
                "{attribution:?} must hand exactly one capture to the grace"
            );
            let deferred = &effects.deferred[0];

            // Same event, just held back: grouping and content are unchanged.
            assert_eq!(deferred.message, baseline.message);
            assert_eq!(deferred.fingerprint, baseline.fingerprint);
            assert_eq!(deferred.extras, baseline.extras);
            assert_eq!(deferred.tags.len(), baseline.tags.len() + 1);
            assert_eq!(
                &deferred.tags[..baseline.tags.len()],
                baseline.tags.as_slice()
            );
            assert_eq!(
                deferred.tags.last(),
                Some(&(
                    "windows_terminator".to_string(),
                    attribution.class_name().to_string()
                ))
            );

            // Lifecycle, failure category and crash counting are untouched —
            // only the send moved. Respawn and backoff timing must not shift.
            assert_eq!(
                effects.lifecycle,
                vec![(WatchDaemonState::Backoff, DaemonFailureCategory::Crash)],
                "{attribution:?} changed the lifecycle transition"
            );
            assert_eq!(effects.consecutive, 1, "{attribution:?}");
            assert!(
                effects.logs.iter().any(|(_, message)| message
                    .starts_with("session-terminate watcher exit #1 — capture deferred")),
                "{attribution:?} must record the deferral locally"
            );
        }
    }

    /// The fail-closed half of the same decision: a grace that elapses without a
    /// message AND without a probe confirmation sends the event it was holding.
    #[test]
    fn a_deferral_that_is_never_affirmed_sends_the_event_it_held() {
        let payload = || {
            DeferredSessionEndCapture::new(
                "auto-sync watcher exited unexpectedly",
                &["sync", "auto-sync-watcher-termination"],
                &[(
                    "windows_terminator",
                    WindowsTerminatorAttribution::UnattributedNoSignal
                        .class_name()
                        .to_string(),
                )],
                &[],
            )
        };

        // With no probe confirmation (Unknown) every non-observed attribution
        // still reaches Sentry after the grace.
        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
            WindowsTerminatorAttribution::ObserverFailed,
            WindowsTerminatorAttribution::ObserverUnavailable,
        ] {
            assert_eq!(
                deferred_session_end_outcome(attribution, WindowsTeardownVerdict::Unknown),
                DeferredSessionEndOutcome::Capture,
                "{attribution:?} must still reach Sentry after the grace"
            );
        }
        // Only positive evidence drops it: an observed message, or a probe that
        // confirmed the teardown.
        assert_eq!(
            deferred_session_end_outcome(
                WindowsTerminatorAttribution::SessionEndObserved,
                WindowsTeardownVerdict::Unknown
            ),
            DeferredSessionEndOutcome::Drop
        );
        assert_eq!(
            deferred_session_end_outcome(
                WindowsTerminatorAttribution::UnattributedNoSignal,
                WindowsTeardownVerdict::Confirmed
            ),
            DeferredSessionEndOutcome::Drop
        );

        // The probe was UNAVAILABLE (Unknown): the wire keeps unattributed_no_signal
        // exactly as before, and the three probe extras report honestly that
        // nothing could be established. This is the fail-closed regression pin.
        let unknown_teardown = WindowsTeardownProbeReading {
            shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
            shuttingdown_at_resolve: TeardownShuttingDown::Unavailable,
            log: TeardownLogReading::Unavailable,
        };
        let sent = finalize_deferred_session_end_payload(
            payload(),
            Some(WindowsTerminatorAttribution::UnattributedNoSignal),
            SESSION_END_GRACE_MS,
            "registered",
            "grace_elapsed",
            WindowsTeardownVerdict::Unknown,
            unknown_teardown,
        );
        assert_eq!(
            sent.tags,
            vec![(
                "windows_terminator".to_string(),
                "unattributed_no_signal".to_string()
            )]
        );
        assert_eq!(
            sent.extras,
            vec![
                (
                    "session_end_decision".to_string(),
                    sentry::protocol::Value::String("grace_elapsed".to_string())
                ),
                (
                    "session_end_attribution_at_exit".to_string(),
                    sentry::protocol::Value::String("unattributed_no_signal".to_string())
                ),
                (
                    "session_end_grace_waited".to_string(),
                    sentry::protocol::Value::String("at_or_over_6s".to_string())
                ),
                (
                    "session_end_observer_readiness".to_string(),
                    sentry::protocol::Value::String("registered".to_string())
                ),
                (
                    "windows_teardown_probe_verdict".to_string(),
                    sentry::protocol::Value::String("teardown_unknown".to_string())
                ),
                (
                    "windows_teardown_probe_shuttingdown".to_string(),
                    sentry::protocol::Value::String("unavailable".to_string())
                ),
                (
                    "windows_teardown_probe_log".to_string(),
                    sentry::protocol::Value::String("unavailable".to_string())
                ),
            ]
        );

        // Second base failure: the probe ran and the OS was verifiably NOT
        // tearing down (Absent). The alert still sends, now carrying the honest
        // discriminator windows_terminator=unattributed_no_teardown, which the
        // base has no value for.
        let absent_teardown = WindowsTeardownProbeReading {
            shuttingdown_at_exit: TeardownShuttingDown::No,
            shuttingdown_at_resolve: TeardownShuttingDown::No,
            log: TeardownLogReading::None,
        };
        let resolution = resolve_deferred_decision(
            Some(SessionEndReading {
                attribution: WindowsTerminatorAttribution::UnattributedNoSignal,
                readiness: "registered",
            }),
            absent_teardown,
        );
        assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Capture);
        assert_eq!(resolution.verdict, WindowsTeardownVerdict::Absent);
        let sent = finalize_deferred_session_end_payload(
            payload(),
            resolution.final_attribution,
            SESSION_END_GRACE_MS,
            "registered",
            "grace_elapsed",
            resolution.verdict,
            absent_teardown,
        );
        assert_eq!(
            recorded_string_tag(&sent, "windows_terminator"),
            "unattributed_no_teardown"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "windows_teardown_probe_verdict"),
            "teardown_absent"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "windows_teardown_probe_shuttingdown"),
            "no"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "windows_teardown_probe_log"),
            "none"
        );
    }

    /// The suppressing half of the new dimension: the exact recurrence shape both
    /// post-fix events reported — registered observer, no message — but now with
    /// the OS itself confirming the teardown through the probe. It DROPS and the
    /// resolved tag names the probe as the suppressor.
    #[test]
    fn a_probe_confirmed_teardown_suppresses_a_no_signal_deferral() {
        let reading = SessionEndReading {
            attribution: WindowsTerminatorAttribution::UnattributedNoSignal,
            readiness: "registered",
        };
        // SM_SHUTTINGDOWN was set at exit — the strongest single confirmation.
        let confirmed = WindowsTeardownProbeReading {
            shuttingdown_at_exit: TeardownShuttingDown::Yes,
            shuttingdown_at_resolve: TeardownShuttingDown::No,
            log: TeardownLogReading::None,
        };
        let resolution = resolve_deferred_decision(Some(reading), confirmed);
        assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Drop);
        assert_eq!(resolution.verdict, WindowsTeardownVerdict::Confirmed);
        assert_eq!(
            resolution.final_attribution,
            Some(WindowsTerminatorAttribution::SessionEndProbed)
        );

        // A bracketing COMMITTED System-channel record (the OS actually shut
        // down) confirms just as well as the flag. An initiation-only 1074 does
        // NOT — that case is covered by the pure verdict test.
        let confirmed_by_log = WindowsTeardownProbeReading {
            shuttingdown_at_exit: TeardownShuttingDown::No,
            shuttingdown_at_resolve: TeardownShuttingDown::No,
            log: TeardownLogReading::Record(
                hq_desktop_core::sync_outcome::TeardownLogClass::KernelGeneral,
            ),
        };
        let resolution = resolve_deferred_decision(Some(reading), confirmed_by_log);
        assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Drop);
        assert_eq!(
            resolution.final_attribution,
            Some(WindowsTerminatorAttribution::SessionEndProbed)
        );

        // An initiation-only record with no live flag fails closed to a send —
        // an aborted shutdown must not suppress a coincident real crash.
        let initiation_only = WindowsTeardownProbeReading {
            shuttingdown_at_exit: TeardownShuttingDown::No,
            shuttingdown_at_resolve: TeardownShuttingDown::No,
            log: TeardownLogReading::Record(
                hq_desktop_core::sync_outcome::TeardownLogClass::User32Initiated,
            ),
        };
        let resolution = resolve_deferred_decision(Some(reading), initiation_only);
        assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Capture);
        assert_eq!(resolution.verdict, WindowsTeardownVerdict::Unknown);

        // An observer that could not be consulted at all still fails closed even
        // with a confirmed teardown: nothing to rename, so it sends.
        let resolution = resolve_deferred_decision(None, confirmed);
        assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Capture);
        assert_eq!(resolution.final_attribution, None);
    }

    /// A deferral is resolved by exactly one claimant. The registry is what
    /// makes the app-quit flush and the session-end drop mutually exclusive
    /// with the grace's own timer.
    #[test]
    fn a_pending_deferral_is_flushed_on_app_quit_and_dropped_at_a_session_end() {
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        take_all_pending_session_end_captures();

        let payload = || {
            DeferredSessionEndCapture::new(
                "auto-sync watcher exited unexpectedly",
                &["sync", "auto-sync-watcher-termination"],
                &[("windows_terminator", "unattributed_no_signal".to_string())],
                &[],
            )
        };

        // App-initiated quit: the alert is NOT a session end, so it is taken
        // and handed to the sender rather than silently discarded.
        let quit_id = register_pending_session_end_capture(payload());
        let mut sent: Vec<DeferredSessionEndCapture> = Vec::new();
        assert_eq!(
            flush_pending_session_end_captures_with(|payload| sent.push(payload)),
            1
        );
        assert_eq!(sent.len(), 1, "an app quit must SEND the held-back event");
        assert_eq!(
            recorded_string_tag(&sent[0], "windows_terminator"),
            "unattributed_no_signal"
        );
        assert!(
            take_pending_session_end_capture(quit_id).is_none(),
            "a flushed deferral must not still be claimable"
        );
        // And its own timer, arriving afterwards, must be a no-op rather than
        // a second send.
        resolve_deferred_session_end_capture(quit_id);
        assert_eq!(sent.len(), 1, "a resolved deferral must not send twice");

        // Windows session end: reaching that teardown IS the affirmation, so
        // the same payload is discarded — nothing reaches a sender at all.
        let session_end_id = register_pending_session_end_capture(payload());
        assert_eq!(drop_pending_session_end_captures(), 1);
        assert!(take_pending_session_end_capture(session_end_id).is_none());
        resolve_deferred_session_end_capture(session_end_id);
        let mut after_drop: Vec<DeferredSessionEndCapture> = Vec::new();
        assert_eq!(
            flush_pending_session_end_captures_with(|payload| after_drop.push(payload)),
            0
        );
        assert!(
            after_drop.is_empty(),
            "a dropped deferral must never reach a sender"
        );

        // Both are idempotent on an empty registry.
        assert_eq!(flush_pending_session_end_captures(), 0);
        assert_eq!(drop_pending_session_end_captures(), 0);

        // Distinct deferrals are claimed independently.
        let first = register_pending_session_end_capture(payload());
        let second = register_pending_session_end_capture(payload());
        assert_ne!(first, second);
        assert!(take_pending_session_end_capture(first).is_some());
        assert!(take_pending_session_end_capture(first).is_none());
        assert!(take_pending_session_end_capture(second).is_some());
        assert_eq!(drop_pending_session_end_captures(), 0);
    }

    /// The deferral must not put anything outside the fixed vocabulary on the
    /// wire, and must not resurrect the undiscriminated `unattributed` token.
    #[test]
    fn deferred_session_end_wire_values_stay_in_their_fixed_vocabulary() {
        let private_marker = r"C:\Users\Ada\hq-private-marker";
        let payload = DeferredSessionEndCapture::new(
            "auto-sync watcher exited unexpectedly",
            &["sync", "auto-sync-watcher-termination"],
            &[("windows_terminator", "unattributed_query_only".to_string())],
            &[],
        );
        // `readiness` is the only value that reaches the wire from outside this
        // module's own vocabulary, so it is the one worth proving cannot carry
        // host text. Production only ever passes `ObserverReadiness::class_name`
        // or a literal; this drives a hostile value through the same path. The
        // probe reading is `Unknown` here — the fail-closed default — so the
        // discriminated value is preserved.
        let sent = finalize_deferred_session_end_payload(
            payload,
            Some(WindowsTerminatorAttribution::UnattributedQueryOnly),
            1_500,
            "registered",
            "grace_elapsed",
            WindowsTeardownVerdict::Unknown,
            WindowsTeardownProbeReading {
                shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
                shuttingdown_at_resolve: TeardownShuttingDown::Unavailable,
                log: TeardownLogReading::Unavailable,
            },
        );

        let terminator = sent
            .tags
            .iter()
            .find(|(key, _)| key == "windows_terminator")
            .map(|(_, value)| value.as_str())
            .expect("a deferred session-end capture keeps its terminator tag");
        assert_eq!(terminator, "unattributed_query_only");
        assert_ne!(terminator, "unattributed");

        for (_, value) in &sent.tags {
            assert!(
                value
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == ':'),
                "tag value {value} left the fixed vocabulary"
            );
        }
        // Every probe extra is a fixed content-safe token — never raw event-log
        // text, a path, a host, a user, or a timestamp.
        for key in [
            "windows_teardown_probe_verdict",
            "windows_teardown_probe_shuttingdown",
            "windows_teardown_probe_log",
        ] {
            let value = recorded_deferred_extra(&sent, key);
            assert!(
                value
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "probe extra {key}={value} left the fixed vocabulary"
            );
        }
        let serialized = serde_json::to_string(&sent.extras).expect("serialize extras");
        assert!(!serialized.contains(private_marker));
        assert!(!serialized.contains('\\'));
        assert!(serialized.contains("1s_to_3s"));
        assert!(serialized.contains("teardown_unknown"));
    }

    /// The grace refreshes the terminator tag to the reading taken AFTER it,
    /// because that is the authoritative answer to which link failed — while
    /// preserving the exit-time reading and leaving grouping alone.
    #[test]
    fn a_deferral_reports_the_attribution_read_after_the_grace() {
        let payload = DeferredSessionEndCapture::new(
            "auto-sync watcher exited unexpectedly",
            &[
                "sync",
                "auto-sync-watcher-termination",
                "windows:session-terminate",
            ],
            &[
                ("sync_route", "watcher".to_string()),
                ("windows_terminator", "unattributed_no_signal".to_string()),
            ],
            &[],
        );
        let sent = finalize_deferred_session_end_payload(
            payload.clone(),
            Some(WindowsTerminatorAttribution::UnattributedQueryOnly),
            5_000,
            "recovering",
            "grace_elapsed",
            WindowsTeardownVerdict::Unknown,
            WindowsTeardownProbeReading {
                shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
                shuttingdown_at_resolve: TeardownShuttingDown::Unavailable,
                log: TeardownLogReading::Unavailable,
            },
        );

        assert_eq!(sent.message, payload.message);
        assert_eq!(sent.fingerprint, payload.fingerprint);
        assert_eq!(
            recorded_string_tag(&sent, "windows_terminator"),
            "unattributed_query_only",
            "the tag must name the link that failed, as read after the grace"
        );
        assert_eq!(
            recorded_string_tag(&sent, "sync_route"),
            "watcher",
            "every other tag is untouched"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "session_end_attribution_at_exit"),
            "unattributed_no_signal",
            "the exit-time reading is preserved, not overwritten"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "session_end_grace_waited"),
            "3s_to_6s"
        );
        assert_eq!(
            recorded_deferred_extra(&sent, "session_end_observer_readiness"),
            "recovering"
        );

        // An observer that could not be consulted at all leaves the exit-time
        // tag in place rather than inventing a reading — and the app-quit flush
        // says so, instead of claiming a grace it never waited out.
        let unread = finalize_deferred_session_end_payload(
            payload,
            None,
            0,
            "not_read",
            "app_quit_flush",
            WindowsTeardownVerdict::Unknown,
            WindowsTeardownProbeReading {
                shuttingdown_at_exit: TeardownShuttingDown::Unavailable,
                shuttingdown_at_resolve: TeardownShuttingDown::Unavailable,
                log: TeardownLogReading::Unavailable,
            },
        );
        assert_eq!(
            recorded_string_tag(&unread, "windows_terminator"),
            "unattributed_no_signal"
        );
        assert_eq!(
            recorded_deferred_extra(&unread, "session_end_grace_waited"),
            "under_1s"
        );
        assert_eq!(
            recorded_deferred_extra(&unread, "session_end_decision"),
            "app_quit_flush"
        );
        assert_eq!(
            recorded_deferred_extra(&unread, "session_end_observer_readiness"),
            "not_read"
        );
    }

    fn recorded_string_tag<'a>(payload: &'a DeferredSessionEndCapture, key: &str) -> &'a str {
        payload
            .tags
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
            .unwrap_or_else(|| panic!("missing tag {key}"))
    }

    fn recorded_deferred_extra<'a>(payload: &'a DeferredSessionEndCapture, key: &str) -> &'a str {
        payload
            .extras
            .iter()
            .find_map(|(name, value)| match (name.as_str() == key, value) {
                (true, sentry::protocol::Value::String(value)) => Some(value.as_str()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing extra {key}"))
    }

    #[test]
    fn watcher_session_terminate_observer_unavailable_and_failed_fail_closed() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        for attribution in [
            WindowsTerminatorAttribution::ObserverUnavailable,
            WindowsTerminatorAttribution::ObserverFailed,
        ] {
            let context = WatcherExitCaptureContext {
                windows_terminator: Some(attribution),
                ..Default::default()
            };
            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                Some(OBSERVED_SESSION_TERMINATE_EXIT),
                None,
                false,
                false,
                "npx",
                None,
                current_termination_host(),
                &context,
            );

            assert_eq!(effects.captures.len(), 1);
            assert_eq!(
                recorded_tag(&effects.captures[0], "windows_terminator"),
                attribution.class_name()
            );
        }
    }

    #[test]
    fn watcher_session_terminate_without_attribution_keeps_the_existing_capture_shape() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );

        assert_eq!(effects.captures.len(), 1);
        assert_eq!(
            effects.captures[0].fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:session-terminate",
                "none"
            ]
        );
        assert!(effects.captures[0]
            .tags
            .iter()
            .all(|(name, _)| *name != "windows_terminator"));
    }

    #[test]
    fn affirmed_attribution_does_not_suppress_or_tag_any_other_exit_shape() {
        let context = WatcherExitCaptureContext {
            windows_terminator: Some(WindowsTerminatorAttribution::SessionEndObserved),
            ..Default::default()
        };
        let cases = [
            (Some(1), None, false),
            (Some(2), None, false),
            (Some(126), None, false),
            (Some(127), None, false),
            (Some(221), None, true),
            (Some(0xC000_0409u32 as i32), None, true),
            (Some(-1), None, true),
            (Some(WINDOWS_SESSION_TERMINATE_EXIT), Some(9), true),
        ];

        for (code, signal, should_capture) in cases {
            let mut effects = RecordingWatcherEffects::default();
            handle_watcher_exit_with_effects(
                &mut effects,
                code,
                signal,
                false,
                false,
                "npx",
                None,
                current_termination_host(),
                &context,
            );

            assert_eq!(
                effects.captures.len(),
                usize::from(should_capture),
                "code={code:?} signal={signal:?}"
            );
            for capture in &effects.captures {
                assert!(
                    capture
                        .tags
                        .iter()
                        .all(|(name, _)| name != "windows_terminator"),
                    "code={code:?} signal={signal:?}"
                );
            }
            if matches!(code, Some(1 | 2)) {
                assert!(effects.logs.iter().any(|(_, message)| {
                    message.starts_with("environmental watcher exit #1 — capture skipped")
                }));
                assert!(effects.breadcrumbs.iter().any(|(_, _, message)| {
                    message.starts_with("environmental auto-sync watcher exit #1")
                }));
            }
        }
    }

    #[test]
    fn production_session_terminate_capture_and_before_send_remove_raw_stderr_content() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let raw_message = format!(
            "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
        );
        let context = WatcherExitCaptureContext {
            lifecycle_state: "running".to_string(),
            runner_error_rollup: Some("EPERM:1".to_string()),
            runner_error_class: "eperm",
            runner_error_ops: Some("rename:1".to_string()),
            runner_error_companies: 1,
            ..Default::default()
        };

        let captures = sentry::test::with_captured_events(|| {
            // Model an ambient breadcrumb left by an older watcher generation;
            // the production before-send boundary must still fail closed.
            sentry::add_breadcrumb(sentry::Breadcrumb {
                category: Some("daemon.stderr".into()),
                level: sentry::Level::Warning,
                message: Some(raw_message.clone()),
                ..Default::default()
            });
            let mut effects = ProductionWatcherProcessEffects;
            record_unexpected_watcher_exit(
                &mut effects,
                Some(OBSERVED_SESSION_TERMINATE_EXIT),
                None,
                1,
                1,
                WatcherExitCapturePolicy::Capture,
                "npx",
                Some(&raw_message),
                current_termination_host(),
                &context,
            );
        });

        assert_eq!(captures.len(), 1);
        let scrubbed = hq_telemetry::before_send(captures.into_iter().next().unwrap())
            .expect("watcher event remains sendable");
        let serialized = serde_json::to_string(&scrubbed).expect("serialize final event");
        assert_eq!(
            scrubbed.breadcrumbs.values[0].message.as_deref(),
            Some("[Filtered]")
        );
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("hq-tmp-a1b2"));
        assert!(!serialized.contains("operation not permitted"));
        assert_eq!(scrubbed.tags["windows_exit_status"], "0x40010004");
        assert_eq!(scrubbed.tags["windows_exit_class"], "session_terminate");
        assert_eq!(scrubbed.tags["runner_error_rollup"], "EPERM:1");
        assert_eq!(scrubbed.tags["runner_error_ops"], "rename:1");
        assert_eq!(
            scrubbed.extra["runner_error_companies"],
            sentry::protocol::Value::Number(1.into())
        );
        assert_eq!(
            scrubbed.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:session-terminate",
                "eperm"
            ]
        );
    }

    #[test]
    fn production_watcher_abort_capture_keeps_libuv_class_and_windows_symbol_content_safe() {
        const WINDOWS_STACK_BUFFER_OVERRUN: i32 = 0xC000_0409u32 as i32;
        let private_path = r"C:\\Users\\Ada\\hq\\companies\\personal\\secret-plan.md";
        let raw_stderr = format!(
            "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76: {private_path}"
        );

        let captures = sentry::test::with_captured_events(|| {
            let mut effects = ProductionWatcherProcessEffects;
            record_unexpected_watcher_exit(
                &mut effects,
                Some(WINDOWS_STACK_BUFFER_OVERRUN),
                None,
                1,
                1,
                WatcherExitCapturePolicy::Capture,
                "npx",
                Some(&raw_stderr),
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );
        });

        let event = hq_telemetry::before_send(captures.into_iter().next().expect("capture"))
            .expect("watcher event remains sendable");
        let serialized = serde_json::to_string(&event).expect("serialize event");
        assert_eq!(event.tags["runner_fatal_class"], "libuv_assert");
        assert_eq!(
            event.tags["windows_fault_symbol"],
            "STATUS_STACK_BUFFER_OVERRUN"
        );
        assert_eq!(
            event.extra["runner_fatal_class_seen"],
            sentry::protocol::Value::Bool(true)
        );
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("UV_HANDLE_CLOSING"));
        assert_eq!(
            event.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none"
            ]
        );
    }

    #[test]
    fn watcher_exec_permission_denied_has_fixed_npx_cache_provenance() {
        let private_path = "/Users/ada/.npm/_npx/hash/node_modules/.bin/hq-sync-runner";
        let raw_stderr = format!("sh: {private_path}: Permission denied");
        let mut effects = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut effects,
            Some(126),
            None,
            4,
            4,
            WatcherExitCapturePolicy::CaptureRateLimited,
            "npx",
            Some(&raw_stderr),
            current_termination_host(),
            &WatcherExitCaptureContext::default(),
        );

        let event = effects
            .captures
            .first()
            .expect("exit 126 captures at milestone");
        assert_eq!(
            recorded_tag(event, "runner_fatal_class"),
            "exec_permission_denied"
        );
        assert_eq!(
            recorded_string_extra(event, "runner_exec_resolution"),
            "npx_cache"
        );
        assert_eq!(
            recorded_string_extra(event, "runner_exec_target_exists"),
            "unknown",
            "exit 126 does not prove target existence"
        );
        assert_eq!(
            recorded_string_extra(event, "runner_exec_target_executable"),
            "unknown",
            "exit 126 does not prove target executability"
        );
        let serialized = serde_json::to_string(&event.extras).expect("serialize extras");
        assert!(!serialized.contains(private_path));
        assert_eq!(
            event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:126", "none"]
        );
    }

    #[test]
    fn watcher_phase_context_uses_only_its_own_events_and_buckets_time() {
        let push: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"up"}"#,
        )
        .expect("progress event");
        let pull: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"down"}"#,
        )
        .expect("progress event");
        let unknown: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"sideways"}"#,
        )
        .expect("progress event");
        assert_eq!(runner_phase_from_event(&push), Some("push"));
        assert_eq!(runner_phase_from_event(&pull), Some("pull"));
        assert_eq!(runner_phase_from_event(&unknown), Some("unknown"));

        let context = Mutex::new(WatcherPhaseContext::default());
        observe_watcher_phase_from_event(&context, &pull);
        assert_eq!(context.lock().expect("phase context").phase, "pull");
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(59)),
            "under_1m"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(60)),
            "1m_to_5m"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(5 * 60)),
            "5m_to_30m"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(30 * 60)),
            "30m_to_2h"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(2 * 60 * 60)),
            "over_2h"
        );
    }

    #[test]
    fn exec_provenance_uses_the_actual_spawn_mode_and_never_infers_file_state() {
        // Unprobed context: the exit status alone infers nothing, so both target
        // facts stay the pre-existing `"unknown"` vocabulary (never a bool).
        let unprobed = WatcherExitCaptureContext::default();
        let npx = runner_exec_provenance_extras(
            Some(126),
            r"C:\\Users\\Ada\\AppData\\Roaming\\npm\\npx.cmd",
            &unprobed,
        )
        .expect("exec exit gets provenance");
        assert!(npx.iter().any(|(key, value)| {
            *key == "runner_exec_resolution"
                && value == &sentry::protocol::Value::String("npx_cache".to_string())
        }));
        assert!(npx.iter().all(|(key, value)| {
            !((*key == "runner_exec_target_exists" || *key == "runner_exec_target_executable")
                && matches!(value, sentry::protocol::Value::Bool(_)))
        }));
        assert!(npx.iter().any(|(key, value)| {
            *key == "runner_exec_target_exists"
                && value == &sentry::protocol::Value::String("unknown".to_string())
        }));
        // The repair-attempted extra is always a bool, defaulting to false.
        assert!(npx.iter().any(|(key, value)| {
            *key == "runner_target_repair_attempted"
                && value == &sentry::protocol::Value::Bool(false)
        }));

        let local = runner_exec_provenance_extras(Some(127), "/opt/dev/node", &unprobed)
            .expect("exec exit gets provenance");
        assert!(local.iter().any(|(key, value)| {
            *key == "runner_exec_resolution"
                && value == &sentry::protocol::Value::String("local_runner".to_string())
        }));

        // A probe result is what turns the facts into real values: a target that
        // exists but is not executable reports exists=true, executable=false.
        let probed = WatcherExitCaptureContext {
            runner_exec_target: Some(RunnerTargetState::NotExecutable),
            runner_target_repair_attempted: true,
            ..WatcherExitCaptureContext::default()
        };
        let probed_npx = runner_exec_provenance_extras(Some(126), "npx", &probed)
            .expect("exec exit gets provenance");
        assert!(probed_npx.iter().any(|(key, value)| {
            *key == "runner_exec_target_exists"
                && value == &sentry::protocol::Value::String("true".to_string())
        }));
        assert!(probed_npx.iter().any(|(key, value)| {
            *key == "runner_exec_target_executable"
                && value == &sentry::protocol::Value::String("false".to_string())
        }));
        assert!(probed_npx.iter().any(|(key, value)| {
            *key == "runner_target_repair_attempted"
                && value == &sentry::protocol::Value::Bool(true)
        }));

        // A non-exec exit that never emitted protocol from a direct executable
        // carries NO widened provenance (gate precision): neither 126/127 nor a
        // launcher-kind child.
        assert!(
            runner_exec_provenance_extras(Some(190), "/opt/homebrew/bin/node", &probed).is_none()
        );
    }

    /// Black-box replay of the exact observed episode: one exit 190 followed by
    /// eight exit 127s in a tight crash loop. This REPLACES a presence-only streak
    /// assertion (plan-review blocker 2). It pins that captures occur at exactly
    /// global #1, #5, #9 and nowhere else; that the 190 leg captures under Capture
    /// with fingerprint exit:190, the widened provenance, and NO exec_not_runnable
    /// streak (a 190 is not 126/127, and the streak legitimately resets across it);
    /// that the 127 legs capture under CaptureRateLimited at exec streaks 4 and 8
    /// with fingerprint exit:127 and the streak extra; and that the global
    /// consecutive counter rendered into the messages is the single series 1..9 —
    /// so episode correlation rests on that already-shipped counter, never on the
    /// per-event streak.
    #[test]
    fn the_observed_190_then_127x8_episode_captures_at_exactly_1_5_and_9() {
        // A launcher child that died before any protocol, with a probed-broken
        // target: the widened provenance arm and the exec streak both apply.
        let context = WatcherExitCaptureContext {
            runner_exec_target: Some(RunnerTargetState::Missing),
            runner_phase: RUNNER_PHASE_PRE_PROTOCOL.to_string(),
            ..WatcherExitCaptureContext::default()
        };
        let mut effects = RecordingWatcherEffects::default();

        for &code in &[190, 127, 127, 127, 127, 127, 127, 127, 127] {
            handle_watcher_exit_with_effects(
                &mut effects,
                Some(code),
                None,
                false,
                false,
                "npx",
                None,
                TerminationHost::Posix,
                &context,
            );
        }

        assert_eq!(
            effects.captures.len(),
            3,
            "the episode must capture at exactly #1, #5, #9: {:?}",
            effects.captures
        );
        let first = &effects.captures[0];
        let fifth = &effects.captures[1];
        let ninth = &effects.captures[2];

        // #1 — the 190 leg: Capture, exit:190, widened provenance, NO streak.
        assert!(
            first.message.contains("consecutive failure #1"),
            "{}",
            first.message
        );
        assert_eq!(
            first.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:190", "none"]
        );
        assert_eq!(recorded_string_extra(first, "runner_exec_resolution"), "npx_cache");
        assert_eq!(recorded_string_extra(first, "runner_exec_target_exists"), "false");
        assert!(
            !first
                .extras
                .iter()
                .any(|(key, _)| key == "exec_not_runnable_streak"),
            "the 190 leg carries no exec-not-runnable streak (it is not 126/127)"
        );

        // #5 — a 127 leg at exec streak 4: CaptureRateLimited, exit:127, streak=4.
        assert!(
            fifth.message.contains("consecutive failure #5"),
            "{}",
            fifth.message
        );
        assert_eq!(
            fifth.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:127", "none"]
        );
        assert_eq!(recorded_number_extra(fifth, "exec_not_runnable_streak"), 4);
        assert_eq!(recorded_string_extra(fifth, "runner_exec_target_exists"), "false");

        // #9 — a 127 leg at exec streak 8.
        assert!(
            ninth.message.contains("consecutive failure #9"),
            "{}",
            ninth.message
        );
        assert_eq!(
            ninth.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:127", "none"]
        );
        assert_eq!(recorded_number_extra(ninth, "exec_not_runnable_streak"), 8);
    }

    /// Gate precision for the REPORTING-ONLY widened exec provenance (plan-review
    /// blocker 1 treatment for the 190 class): a launcher-kind child that died
    /// before any protocol carries the probed target facts on a 190 exit, with
    /// its exit:190 fingerprint unchanged, while a non-launcher child and a
    /// post-protocol exit carry no widened provenance at all. Capture behaviour
    /// and fingerprints are untouched throughout.
    #[test]
    fn widened_exec_provenance_is_gated_to_launcher_pre_protocol_fast_fails() {
        let host = TerminationHost::Posix;
        let probed = WatcherExitCaptureContext {
            runner_exec_target: Some(RunnerTargetState::Missing),
            runner_target_repair_attempted: true,
            runner_phase: RUNNER_PHASE_PRE_PROTOCOL.to_string(),
            ..WatcherExitCaptureContext::default()
        };

        // (a) launcher + pre_protocol + 190 → widened provenance, exit:190 intact.
        let mut launcher = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut launcher,
            Some(190),
            None,
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "npx",
            None,
            host,
            &probed,
        );
        let event = launcher
            .captures
            .first()
            .expect("a 190 launcher fast-fail captures at #1");
        assert_eq!(
            event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:190", "none"]
        );
        assert_eq!(recorded_string_extra(event, "runner_exec_resolution"), "npx_cache");
        assert_eq!(recorded_string_extra(event, "runner_exec_target_exists"), "false");
        assert_eq!(
            recorded_string_extra(event, "runner_exec_target_executable"),
            "false"
        );
        assert!(
            event.extras.iter().any(|(key, value)| key
                == "runner_target_repair_attempted"
                && *value == sentry::protocol::Value::Bool(true)),
            "the spawn-time repair outcome rides alongside the exit-time probe"
        );

        // (b) a DIRECT executable (node) with the same pre-protocol 190 exit gets
        //     NO widened provenance — it is not a launcher.
        let mut direct = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut direct,
            Some(190),
            None,
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "/opt/homebrew/bin/node",
            None,
            host,
            &probed,
        );
        let direct_event = direct.captures.first().expect("still captured at #1");
        assert_eq!(
            direct_event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:190", "none"]
        );
        assert!(
            !direct_event
                .extras
                .iter()
                .any(|(key, _)| key == "runner_exec_resolution"),
            "a non-launcher child gets no widened exec provenance"
        );

        // (c) a launcher that DID emit protocol (post-protocol phase) then exited
        //     190 also carries no widened provenance (gate precision).
        let post_protocol = WatcherExitCaptureContext {
            runner_exec_target: Some(RunnerTargetState::Missing),
            runner_phase: "scan".to_string(),
            ..WatcherExitCaptureContext::default()
        };
        let mut post = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut post,
            Some(190),
            None,
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "npx",
            None,
            host,
            &post_protocol,
        );
        let post_event = post.captures.first().expect("still captured at #1");
        assert!(
            !post_event
                .extras
                .iter()
                .any(|(key, _)| key == "runner_exec_resolution"),
            "a post-protocol exit gets no widened exec provenance"
        );

        // (d) the additive 126/127 base arm is UNCHANGED — a 127 carries probed
        //     provenance regardless of phase, with its exit:127 fingerprint.
        let mut exec = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut exec,
            Some(127),
            None,
            4,
            4,
            WatcherExitCapturePolicy::CaptureRateLimited,
            "npx",
            None,
            host,
            &post_protocol,
        );
        let exec_event = exec.captures.first().expect("127 captures at streak 4");
        assert_eq!(
            exec_event.fingerprint,
            vec!["sync", "auto-sync-watcher-termination", "exit:127", "none"]
        );
        assert_eq!(
            recorded_string_extra(exec_event, "runner_exec_target_exists"),
            "false"
        );
        assert_eq!(recorded_number_extra(exec_event, "exec_not_runnable_streak"), 4);
    }

    #[test]
    fn production_unrecognized_exit_capture_omits_raw_runner_content_before_send() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let watcher_command = r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd --private-flag";
        let raw_stderr = format!(
            "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
        );

        let captures = sentry::test::with_captured_events(|| {
            let mut effects = ProductionWatcherProcessEffects;
            record_unexpected_watcher_exit(
                &mut effects,
                Some(221),
                None,
                1,
                1,
                WatcherExitCapturePolicy::Capture,
                watcher_command,
                Some(&raw_stderr),
                current_termination_host(),
                &WatcherExitCaptureContext::default(),
            );
        });

        assert_eq!(captures.len(), 1);
        let scrubbed = hq_telemetry::before_send(captures.into_iter().next().unwrap())
            .expect("unrecognized watcher event remains sendable");
        let serialized = serde_json::to_string(&scrubbed).expect("serialize final event");

        assert!(!scrubbed.extra.contains_key("watcher_runner_command"));
        assert!(!scrubbed.extra.contains_key("watcher_last_stderr"));
        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("private-flag"));
        assert!(!serialized.contains("hq-tmp-a1b2"));
        assert!(!serialized.contains("operation not permitted"));
        assert_eq!(
            scrubbed.extra["watcher_hq_cloud_package"],
            sentry::protocol::Value::String(HQ_CLOUD_PACKAGE.to_string())
        );
        assert_eq!(
            scrubbed.extra["watcher_runner_binary"],
            sentry::protocol::Value::String(RUNNER_BIN.to_string())
        );
    }

    #[test]
    fn watcher_exit_fingerprint_token_is_stable_per_exit_or_signal() {
        assert_eq!(termination_fingerprint_token(Some(126), None), "exit:126");
        assert_eq!(termination_fingerprint_token(Some(127), None), "exit:127");
        assert_eq!(
            termination_fingerprint_token(None, Some(SIGSEGV)),
            "signal:11"
        );
        assert_eq!(
            termination_fingerprint_token(Some(-1), None),
            "windows:status-ffffffff"
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

    // ── Preflight capture policy (HQ-DESKTOP-B3) ─────────────────────────
    //
    // These replace `runner_unresolvable_preflight_is_local_log_only`, which
    // asserted that *every* preflight refusal stayed local. That assertion was
    // deliberately narrowed, not weakened: the silence it pinned is still
    // required for a machine that simply has no Node, but it also hid HQ's own
    // Node runtime going missing — a defect that left a whole team with no
    // background sync for days and paged nobody.

    #[test]
    fn each_preflight_failure_has_an_explicit_capture_policy() {
        // Auto-sync retries every 30s, so user-owned configuration stays
        // local-only. Both HQ-owned repair states are rate-limited captures.
        for failure in [
            PreflightFailure::RunnerUnresolvable,
            PreflightFailure::NodeTooOld,
        ] {
            assert_eq!(
                runner_preflight_capture_policy(failure),
                RunnerPreflightCapturePolicy::LocalLogOnly,
                "{failure:?} is the user's environment — it must not page anyone"
            );
        }
        for failure in [
            PreflightFailure::ManagedNodeMissing,
            PreflightFailure::NodeUnprovisioned,
        ] {
            assert_eq!(
                runner_preflight_capture_policy(failure),
                RunnerPreflightCapturePolicy::CaptureRateLimited,
                "{failure:?} is repairable by HQ and must reach #hq-alerts"
            );
        }
    }

    #[test]
    fn a_successful_self_provision_is_not_a_preflight_failure() {
        // The whole point of this lane is that HQ repairs the machine itself.
        // Reporting the repair would page #hq-alerts at Level::Error on the
        // *fix* working, and would advance the consecutive-failure counter
        // `should_capture_crash` rate-limits on — so a fleet HQ successfully
        // healed would suppress the alerts for machines it could not heal.
        assert_eq!(
            provisioning_bail_to_report(ProvisionAttempt::Provisioned),
            None
        );
    }

    #[test]
    fn a_cooldown_deferral_is_not_a_preflight_failure_and_does_not_advance_the_streak() {
        // HQ-DESKTOP-4Z regression guard. A shared-slot cooldown deferral
        // (another lane is already installing) is single-flight working as
        // designed — not a provisioning failure. It must not page…
        assert_eq!(
            provisioning_bail_to_report(ProvisionAttempt::Deferred(
                "HQ skipped Node provisioning because an attempt was already made recently"
                    .to_string()
            )),
            None,
            "a cooldown deferral must not be reported as a preflight failure",
        );

        // …and — critically — it must not advance the consecutive-preflight-
        // failure counter should_capture_crash rate-limits genuine alerts with,
        // or a machine HQ merely deferred would suppress alerts for a machine it
        // could not repair.
        //
        // Serialize against every test that mutates the process-global crash
        // state: GUARD_TEST_LOCK is the suite's shared lock, and several of the
        // tests it guards call note_watcher_spawned(), which resets
        // preflight_fails — so a dedicated lock would not exclude them and this
        // exact-count assertion could flake from 2 to 1.
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        // From a reset streak, driving a deferral through the reporting seam
        // leaves the counter at 0, so the next genuine failure is still #1.
        {
            let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
            *st = WatcherCrashState::default();
        }
        report_provisioning_outcome(ProvisionAttempt::Deferred(
            "HQ skipped Node provisioning because an attempt was already made recently".to_string(),
        ));
        assert_eq!(
            note_runner_preflight_failure(),
            1,
            "a cooldown deferral must not advance the preflight-failure streak",
        );

        // A genuine failure, by contrast, DOES advance it, so repeats
        // rate-limit exactly as an unrepairable machine should.
        {
            let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
            *st = WatcherCrashState::default();
        }
        report_provisioning_outcome(ProvisionAttempt::Failed("no disk".to_string()));
        assert_eq!(
            note_runner_preflight_failure(),
            2,
            "a failed provision advances the streak (its report was #1, this call is #2)",
        );
    }

    #[test]
    fn a_failed_self_provision_still_reports_its_reason() {
        // A machine HQ cannot repair (offline, MDM-locked, no disk) is the one
        // state that must still surface — carrying why, not a generic bail.
        assert_eq!(
            provisioning_bail_to_report(ProvisionAttempt::Failed("download timed out".to_string())),
            Some("download timed out".to_string()),
        );
        // …and it routes through the rate-limited policy, never local-only.
        assert_eq!(
            runner_preflight_capture_policy(PreflightFailure::NodeUnprovisioned),
            RunnerPreflightCapturePolicy::CaptureRateLimited,
        );
    }

    #[test]
    fn preflight_failure_streak_resets_after_a_successful_spawn() {
        // Shares the suite-wide crash-state lock so a concurrent
        // note_watcher_spawned() cannot reset preflight_fails mid-assertion.
        let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        {
            let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
            *st = WatcherCrashState::default();
        }
        assert_eq!(note_runner_preflight_failure(), 1);
        assert_eq!(note_runner_preflight_failure(), 2);
        note_watcher_spawned();
        assert_eq!(
            note_runner_preflight_failure(),
            1,
            "a healthy spawn must let the next episode alert again"
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
        // No-sample arms are scope-independent and byte-identical to before.
        assert_eq!(
            exit_diagnostic_suffix(None, None, None, "runner"),
            " [last_rss=unsampled]"
        );
        assert_eq!(
            exit_diagnostic_suffix(Some(Duration::from_secs(5)), None, None, "launcher"),
            " [uptime=5s; last_rss=not-yet-sampled]"
        );
        // A runner-scoped sample renders exactly as it always has.
        let full = exit_diagnostic_suffix(
            Some(Duration::from_secs(90)),
            Some(182 * 1024),
            Some(Duration::from_secs(12)),
            "runner",
        );
        assert_eq!(
            full,
            " [uptime=1m30s; last_rss=182MB (sampled 12s before exit)]"
        );
    }

    #[test]
    fn exit_diagnostic_suffix_is_scope_aware_for_samples() {
        // The honest whole-tree sum is qualified, not withheld.
        assert_eq!(
            exit_diagnostic_suffix(
                Some(Duration::from_secs(120)),
                Some(48 * 1024),
                Some(Duration::from_secs(8)),
                "tree",
            ),
            " [uptime=2m0s; last_rss=48MB (tree, sampled 8s before exit)]"
        );
        assert_eq!(
            exit_diagnostic_suffix(Some(Duration::from_secs(120)), Some(48 * 1024), None, "tree"),
            " [uptime=2m0s; last_rss=48MB (tree)]"
        );
        // A launcher/shim single-PID sample WITHHOLDS the number — neither the
        // impossible 32KB nor a plausible launcher footprint can read as the
        // runner's — and names the scope instead.
        assert_eq!(
            exit_diagnostic_suffix(
                Some(Duration::from_secs(2123)),
                Some(32),
                Some(Duration::from_secs(8)),
                "launcher",
            ),
            " [uptime=35m23s; last_rss=unattributed:launcher (sampled 8s before exit)]"
        );
        assert_eq!(
            exit_diagnostic_suffix(Some(Duration::from_secs(60)), Some(71 * 1024), None, "shim"),
            " [uptime=1m0s; last_rss=unattributed:shim]"
        );
    }

    #[test]
    fn resolve_rss_scope_prefers_tree_else_command_scope() {
        // The honest whole-tree sum is `tree`.
        assert_eq!(resolve_rss_scope(Some(RssSampleKind::Tree), "npx"), "tree");
        // A single-PID sample (or no sample) keeps today's command-derived scope;
        // `runner` is never produced by inference for a launcher/shim.
        assert_eq!(
            resolve_rss_scope(Some(RssSampleKind::Single), "/opt/homebrew/bin/npx"),
            "launcher"
        );
        assert_eq!(
            resolve_rss_scope(Some(RssSampleKind::Single), r"C:\p\npx.cmd"),
            "shim"
        );
        assert_eq!(resolve_rss_scope(None, "/opt/homebrew/bin/npx"), "launcher");
        // Only a command whose registered child IS the runner keeps `runner`.
        assert_eq!(resolve_rss_scope(Some(RssSampleKind::Single), "node"), "runner");
    }

    #[cfg(unix)]
    #[test]
    fn sum_pid_tree_rss_kb_sums_descendants_and_handles_edges() {
        // pid ppid rss — root=100 with children 200/300 and grandchild 400.
        let table = "100 1 10\n200 100 20\n300 100 30\n400 200 40\n999 1 99\n";
        // root + 200 + 300 + 400 = 100; the unrelated 999 is excluded.
        assert_eq!(sum_pid_tree_rss_kb(table, 100), Some(100));
        // A leaf sums only itself.
        assert_eq!(sum_pid_tree_rss_kb(table, 400), Some(40));
        // A missing root -> None, which drives the single-PID fallback.
        assert_eq!(sum_pid_tree_rss_kb(table, 12345), None);
        // Malformed rows are skipped, never fatal; a reparented (ppid 1) row is
        // just another descendant when reachable, or excluded when not.
        assert_eq!(sum_pid_tree_rss_kb("garbage\n100 1 10\n", 100), Some(10));
    }

    #[cfg(unix)]
    #[test]
    fn sum_pid_tree_rss_kb_is_cycle_safe() {
        // A pathological ppid cycle must terminate and count each PID once.
        let table = "100 200 10\n200 100 20\n";
        assert_eq!(sum_pid_tree_rss_kb(table, 100), Some(30));
    }

    #[cfg(unix)]
    #[test]
    fn sample_watcher_rss_scoped_reports_tree_for_the_live_process() {
        // The live test process is always in the `ps` table, so the scoped sampler
        // succeeds and reports the honest whole-tree scope.
        let (kb, kind) = sample_watcher_rss_scoped(std::process::id())
            .expect("the live test process must be sampleable");
        assert!(kb > 0, "a live process has a nonzero footprint");
        assert_eq!(kind, RssSampleKind::Tree);
    }

    /// The minimal heap-OOM stderr both wiring tests feed through the shared
    /// `RunTotals` seam: a GC line, the banner, the marker, then three frames
    /// (`node::OOMErrorHandler` → `ReportOOMFailure` → `Runtime_NewArray`).
    const HEAP_OOM_MINIMAL_STDERR: &[&str] = &[
        "[1:0x1]  47.7 (80.5) -> 47.7 (80.5) MB, tail",
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        "----- Native stack trace -----",
        " 1: 0xe46bbe node::OOMErrorHandler(char const*) [node]",
        " 2: 0x1243740 v8::Utils::ReportOOMFailure(char const*) [node]",
        " 3: 0x1889f5d v8::internal::Runtime_NewArray(int) [node]",
    ];

    #[test]
    fn watcher_exit_capture_context_reads_heap_oom_evidence_from_totals() {
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = begin_watcher_generation(WatcherLaunchOrigin::SupervisorRespawn);
        let mut totals = RunTotals::default();
        for line in HEAP_OOM_MINIMAL_STDERR {
            totals.record_stderr_line(line);
        }
        let phase_context = Mutex::new(WatcherPhaseContext {
            phase: "pull",
            observed_at: Instant::now(),
        });
        // An EMPTY tail proves the class-scoped shape comes from the retained
        // evidence, not from the generic tail path.
        let context = watcher_exit_capture_context(
            &Mutex::new(totals),
            false,
            &phase_context,
            &generation,
            0,
            &[],
            None,
            None,
            0,
            None,
            None,
        );
        assert_eq!(context.runner_oom_banner, Some("reached_heap_limit"));
        assert_eq!(context.runner_heap_used_mb, Some(48));
        assert_eq!(context.runner_heap_total_mb, Some(81));
        assert_eq!(context.runner_oom_frame_count, Some(3));
        assert_eq!(
            context.runner_stack_shape,
            "node_oom_handler>v8_report_oom>v8_runtime"
        );
        assert_ne!(context.runner_stack_signature, "unknown");
        assert_eq!(context.runner_stack_depth, 3);
    }

    #[test]
    fn heap_oom_watcher_capture_emits_banner_and_extras_without_moving_fingerprint() {
        let with_heap = WatcherExitCaptureContext {
            runner_oom_banner: Some("reached_heap_limit"),
            runner_heap_used_mb: Some(48),
            runner_heap_total_mb: Some(81),
            runner_oom_frame_count: Some(3),
            runner_stack_shape: "node_oom_handler>v8_report_oom>v8_runtime".to_string(),
            runner_stack_signature: "0123456789abcdef".to_string(),
            runner_stack_depth: 3,
            ..WatcherExitCaptureContext::default()
        };
        let baseline = WatcherExitCaptureContext::default();

        // A heap OOM aborts with SIGABRT (signal 6) — the exact HQ-DESKTOP-55 exit.
        let mut heap_effects = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut heap_effects,
            None,
            Some(6),
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "npx",
            None,
            current_termination_host(),
            &with_heap,
        );
        let mut base_effects = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut base_effects,
            None,
            Some(6),
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "npx",
            None,
            current_termination_host(),
            &baseline,
        );

        let heap_capture = heap_effects.captures.first().expect("heap capture");
        let base_capture = base_effects.captures.first().expect("baseline capture");

        // Heap evidence attaches: banner tag, class-scoped v8_* shape, and the
        // three integer extras.
        assert_eq!(
            recorded_tag(heap_capture, "runner_oom_banner"),
            "reached_heap_limit"
        );
        assert_eq!(
            recorded_tag(heap_capture, "runner_stack_shape"),
            "node_oom_handler>v8_report_oom>v8_runtime"
        );
        assert_eq!(recorded_number_extra(heap_capture, "runner_heap_used_mb"), 48);
        assert_eq!(recorded_number_extra(heap_capture, "runner_heap_total_mb"), 81);
        assert_eq!(recorded_number_extra(heap_capture, "runner_oom_frame_count"), 3);

        // The baseline (no heap evidence) carries none of them — absence never
        // renders as evidence.
        assert!(base_capture.tags.iter().all(|(k, _)| k != "runner_oom_banner"));
        assert!(base_capture
            .extras
            .iter()
            .all(|(k, _)| k != "runner_heap_used_mb"));

        // Grouping is message-independent: the fingerprint is byte-identical with
        // and without heap evidence (the retitled RSS/heap lines cannot regroup).
        assert_eq!(heap_capture.fingerprint, base_capture.fingerprint);
        assert_eq!(heap_capture.fingerprint.len(), 4);
        assert_eq!(heap_capture.fingerprint[0], "sync");
        assert_eq!(
            heap_capture.fingerprint[1],
            "auto-sync-watcher-termination"
        );
    }

    fn assert_signed_out_entry_point_records_origin(
        name: &str,
        expected_origin: WatcherLaunchOrigin,
        start: impl FnOnce(AppHandle<tauri::test::MockRuntime>) -> Result<String, String>,
    ) {
        let app = tauri::test::mock_app();
        let result = start(app.handle().clone());
        assert_eq!(
            result,
            Err(crate::commands::cognito::REAUTH_MESSAGE.to_string()),
            "{name} must stop at the signed-out preflight"
        );

        let generation = watcher_generation_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .expect("the production entry point must publish a generation");
        assert_eq!(generation.launch_origin, expected_origin, "{name}");
        assert!(
            try_register_handle(DAEMON_HANDLE),
            "{name} must release the daemon guard after refusing signed-out startup"
        );
        deregister_process(DAEMON_HANDLE);
        finish_watcher_generation(&generation);
    }

    #[test]
    fn production_watcher_entry_points_publish_their_own_origins_before_signed_out_preflight() {
        // The production entry points acquire DAEMON_HANDLE before reaching
        // the signed-out preflight. Share the guard-test lock with the
        // existing lifecycle tests so cargo's parallel runner cannot observe
        // that short-lived handle ownership as a spurious double start.
        let _guard = GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let temp_home = TempDir::new().expect("temporary signed-out home");
        std::fs::create_dir_all(temp_home.path().join(".hq")).expect("create .hq directory");
        let _home = scoped_home(temp_home.path());
        *watcher_generation_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        deregister_process(DAEMON_HANDLE);

        assert_signed_out_entry_point_records_origin(
            "renderer",
            WatcherLaunchOrigin::Renderer,
            start_daemon,
        );
        assert_signed_out_entry_point_records_origin(
            "app launch",
            WatcherLaunchOrigin::AppLaunch,
            start_daemon_for_app_launch,
        );
        assert_signed_out_entry_point_records_origin(
            "supervisor respawn",
            WatcherLaunchOrigin::SupervisorRespawn,
            start_daemon_for_supervisor_respawn,
        );
    }

    #[test]
    fn watcher_generation_origin_is_durable_after_transient_flags_clear() {
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = begin_watcher_generation(WatcherLaunchOrigin::SupervisorRespawn);
        // A later generation may become globally current before this one exits;
        // attribution must still come from the generation captured by its
        // process closure, never from process-global state sampled at exit.
        let _newer_generation = begin_watcher_generation(WatcherLaunchOrigin::AppLaunch);
        SUPERVISOR_RESPAWN_IN_FLIGHT.store(false, Ordering::Release);
        HEARTBEAT_STALL_TERMINATION_IN_FLIGHT.store(false, Ordering::Release);
        let context = watcher_exit_capture_context(
            &Mutex::new(RunTotals::default()),
            false,
            &Mutex::new(WatcherPhaseContext::default()),
            &generation,
            0,
&[],
            None,
            None,
            0,
            None,
            None,
        );

        assert_eq!(context.watcher_launch_origin, "supervisor_respawn");
        assert!(!context.supervisor_respawn_in_flight);
    }

    #[test]
    fn watcher_capture_normalizes_the_dying_generations_full_stderr_tail() {
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = begin_watcher_generation(WatcherLaunchOrigin::AppLaunch);
        let totals = Mutex::new(RunTotals::default());
        let stderr_tail = Mutex::new(VecDeque::with_capacity(WATCHER_STDERR_TAIL_CAP));
        for line in [
            "at node:internal/modules/cjs/loader:1218:14",
            "at C:\\Users\\Ada\\private-company\\secret-plan.md:10:2",
            "at node:fs:242:9",
            "private application frame",
        ] {
            record_watcher_stderr_tail(&stderr_tail, line);
        }
        let tail = stderr_tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let context = watcher_exit_capture_context(
            &totals,
            false,
            &Mutex::new(WatcherPhaseContext::default()),
            &generation,
            0,
&tail,
            None,
            None,
            0,
            None,
            None,
        );
        let mut effects = RecordingWatcherEffects::default();
        record_unexpected_watcher_exit(
            &mut effects,
            Some(221),
            None,
            1,
            1,
            WatcherExitCapturePolicy::Capture,
            "npx",
            tail.last().map(String::as_str),
            current_termination_host(),
            &context,
        );

        let event = effects.captures.first().expect("watcher capture");
        assert_eq!(recorded_tag(event, "sync_route"), "watcher");
        assert_eq!(
            recorded_tag(event, "runner_stack_shape"),
            "node_cjs_loader>app>node_fs>app"
        );
        assert_eq!(
            recorded_string_extra(event, "watcher_launch_origin"),
            "app_launch"
        );
        assert_eq!(
            event
                .extras
                .iter()
                .find(|(key, _)| key == "runner_stack_depth")
                .map(|(_, value)| value),
            Some(&serde_json::json!(4))
        );
        assert_eq!(
            event
                .extras
                .iter()
                .find(|(key, _)| key == "runner_stack_redacted_frames")
                .map(|(_, value)| value),
            Some(&serde_json::json!(2))
        );
        let serialized = serde_json::to_string(&event.extras).expect("serialize extras");
        assert!(!serialized.contains("private-company"));
        assert!(!serialized.contains("secret-plan"));
    }

    /// The exact Sentry status behind HQ-DESKTOP-3S (raw `Some(-1073740791)`)
    /// and HQ-DESKTOP-4C (decoded `0xC0000409 (fault)`): one NTSTATUS split
    /// across two issues by a message-format change.
    const WINDOWS_FASTFAIL_EXIT: i32 = 0xC000_0409u32 as i32;

    /// Drive the production capture seam with the observed Windows fast-fail so
    /// the attribution the live HQ-DESKTOP-4C event lacked is pinned end to end:
    /// which entry point started the dying generation, which route it ran, and
    /// what the runner's stderr looked like at the moment it aborted. The
    /// pre-existing Windows classification, phase and fingerprint must survive
    /// untouched — this lane only ever adds information.
    #[test]
    fn windows_fastfail_watcher_capture_attributes_route_origin_and_multiline_stack() {
        assert_eq!(
            WINDOWS_FASTFAIL_EXIT, -1_073_740_791,
            "the decoded status and the raw code in the cluster are one value"
        );
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = begin_watcher_generation(WatcherLaunchOrigin::SupervisorRespawn);
        let stderr_tail = Mutex::new(VecDeque::with_capacity(WATCHER_STDERR_TAIL_CAP));
        // A real Node fatal-error abort is a banner plus frames. Only the last
        // line reached the classifier before this lane, which is why the live
        // event reported runner_fatal_class=none with no fault-site detail.
        for line in [
            "<--- Last few GCs --->",
            "FATAL ERROR: Ineffective mark-compacts near heap limit \
             Allocation failed - JavaScript heap out of memory",
            "at Module._compile (node:internal/modules/cjs/loader:1356:14)",
            "at node:fs:242:9",
        ] {
            record_watcher_stderr_tail(&stderr_tail, line);
        }
        let tail = stderr_tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let phase_context = Mutex::new(WatcherPhaseContext {
            phase: "scan",
            observed_at: Instant::now(),
        });
        let context = watcher_exit_capture_context(
            &Mutex::new(RunTotals::default()),
            false,
            &phase_context,
            &generation,
            0,
&tail,
            None,
            None,
            0,
            None,
            None,
        );

        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(WINDOWS_FASTFAIL_EXIT),
            None,
            false,
            false,
            "npx",
            tail.last().map(String::as_str),
            TerminationHost::Windows,
            &context,
        );

        let event = effects
            .captures
            .first()
            .expect("a Windows fast-fail watcher exit must still be captured");

        // New attribution: the four channels the live event was missing.
        assert_eq!(recorded_tag(event, "sync_route"), "watcher");
        assert_eq!(
            recorded_string_extra(event, "watcher_launch_origin"),
            "supervisor_respawn",
            "the origin must come from the generation that actually died"
        );
        assert_eq!(
            recorded_tag(event, "runner_stack_shape"),
            "app>app>node_cjs_loader>node_fs",
            "the whole bounded tail is normalized, not just its last line"
        );
        let signature = recorded_tag(event, "runner_stack_signature");
        assert_ne!(signature, "unknown");
        assert_eq!(signature.len(), 16);
        assert!(signature.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(recorded_number_extra(event, "runner_stack_depth"), 4);
        assert_eq!(
            recorded_number_extra(event, "runner_stack_redacted_frames"),
            2
        );

        // Preserved: everything the capture already carried on main.
        assert_eq!(recorded_tag(event, "windows_exit_status"), "0xC0000409");
        assert_eq!(recorded_tag(event, "windows_exit_class"), "fault");
        assert_eq!(
            recorded_tag(event, "windows_fault_symbol"),
            "STATUS_STACK_BUFFER_OVERRUN"
        );
        assert_eq!(recorded_string_extra(event, "runner_phase"), "scan");
        assert_eq!(
            recorded_string_extra(event, "runner_phase_elapsed_bucket"),
            "under_1m"
        );
        assert_eq!(
            event.fingerprint,
            vec![
                "sync",
                "auto-sync-watcher-termination",
                "windows:fault:0xC0000409",
                "none",
            ],
            "grouping continuity: neither cluster issue may regroup"
        );
        assert!(event
            .message
            .contains("with Windows status 0xC0000409 (fault)"));

        // Egress safety: the banner and its frames stay process-local.
        let serialized = format!(
            "{}{}{}",
            event.message,
            serde_json::to_string(&event.tags).expect("serialize tags"),
            serde_json::to_string(&event.extras).expect("serialize extras"),
        );
        for forbidden in [
            "JavaScript heap out of memory",
            "Module._compile",
            "node:internal/modules/cjs/loader",
            "Last few GCs",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "raw stderr must never reach the capture: {forbidden}"
            );
        }
    }

    /// A Windows `__fastfail` can terminate the runner before anything is
    /// flushed. That is itself a discriminating datum, so the degraded stack
    /// must be reported honestly rather than fabricated — and route, origin and
    /// phase must still land, because they do not depend on stderr at all.
    #[test]
    fn windows_fastfail_watcher_capture_reports_a_silent_stderr_tail_honestly() {
        let _environment = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = begin_watcher_generation(WatcherLaunchOrigin::Renderer);
        let context = watcher_exit_capture_context(
            &Mutex::new(RunTotals::default()),
            false,
            &Mutex::new(WatcherPhaseContext {
                phase: "idle",
                observed_at: Instant::now(),
            }),
            &generation,
            0,
&[],
            None,
            None,
            0,
            None,
            None,
        );

        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(WINDOWS_FASTFAIL_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Windows,
            &context,
        );

        let event = effects
            .captures
            .first()
            .expect("a silent Windows fast-fail must still be captured");
        assert_eq!(recorded_tag(event, "runner_stack_shape"), "all_redacted");
        assert_eq!(recorded_tag(event, "runner_stack_signature"), "unknown");
        assert_eq!(recorded_number_extra(event, "runner_stack_depth"), 0);
        assert_eq!(
            recorded_number_extra(event, "runner_stack_redacted_frames"),
            0
        );
        assert_eq!(recorded_tag(event, "sync_route"), "watcher");
        assert_eq!(
            recorded_string_extra(event, "watcher_launch_origin"),
            "renderer"
        );
        assert_eq!(recorded_string_extra(event, "runner_phase"), "idle");
        assert_eq!(recorded_tag(event, "windows_exit_status"), "0xC0000409");
        assert_eq!(
            recorded_tag(event, "windows_fault_symbol"),
            "STATUS_STACK_BUFFER_OVERRUN"
        );
    }
}
