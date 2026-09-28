//! Runs `hq daemon` as the app's child when the `desktop.hq-daemon` flag is on,
//! in place of the app's own background services.
//!
//! At launch [`setup_sync_host`] resolves the flag and the installed CLI once.
//! Legacy keeps today's services (watch runner, its supervisor, the npx
//! prewarm, the Work Mesh installer and the scheduled CLI updater). Daemon
//! runs `hq daemon run --managed --host desktop` instead and relaunches it when
//! it exits; the daemon runs sync, mesh, bots, search indexing and updates.
//! Until the choice is made neither side starts, so the two never overlap.
//!
//! The app's per-pass work (journal, conflict and plan-limit notices, client
//! health, git mirror, Recent Changes) is driven from hq-cloud's
//! `sync-last-pass.json` through the same handler the watch runner's stdout
//! feeds (see `sync_progress_watch`).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hq_desktop_core::daemon::{
    compose_runner_spawn_flags, effective_runner_heap_ceiling, is_autostart_enabled,
    is_pid_alive, is_realtime_sync_enabled, resolve_hq_folder_path, sync_child_env, DaemonStatus,
};
use hq_desktop_core::hq_daemon::{
    after_daemon_exit, choose_sync_host, daemon_run_args, default_daemon_paths,
    read_daemon_state, running_daemon_pid, DaemonState, HostAction, LastPass, SyncHostMode,
    HQ_DAEMON_FLAG,
};
use hq_desktop_core::hq_resolver::{resolve_hq, HqInvocation};
use tauri::{AppHandle, Runtime};

use crate::commands::daemon::{handle_watch_stdout_line, WatcherPhaseContext};
use crate::commands::process::{app_exit_requested, deregister_process, register_process};
use crate::commands::sync::RunTotals;
use crate::util::logfile::log;

const LOG_TAG: &str = "hq-daemon-host";
/// Process-registry handle, so app exit terminates the daemon and its services.
const HQ_DAEMON_HANDLE: &str = "hq-daemon";
/// How often the host re-reads sync settings that reach the daemon as env.
const ENV_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How long to wait before looking again while another daemon holds the lock.
const OTHER_DAEMON_RECHECK: Duration = Duration::from_secs(60);
/// A run this long resets the crash backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPhase {
    /// The flag is still resolving at launch.
    Pending,
    Legacy,
    Daemon,
}

/// Starts Pending in the app. Unit tests of the app's own services run as the
/// legacy host, which is what production uses whenever the flag is off.
static PHASE: AtomicU8 = AtomicU8::new(if cfg!(test) { 1 } else { 0 });
/// Pid of the running daemon child, 0 when none.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);
/// Set to relaunch the child at once (its environment changed).
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);
/// Environment the current child was started with.
static CHILD_ENV: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn current_phase() -> HostPhase {
    match PHASE.load(Ordering::Acquire) {
        1 => HostPhase::Legacy,
        2 => HostPhase::Daemon,
        _ => HostPhase::Pending,
    }
}

fn set_phase(phase: HostPhase) {
    let value = match phase {
        HostPhase::Pending => 0,
        HostPhase::Legacy => 1,
        HostPhase::Daemon => 2,
    };
    PHASE.store(value, Ordering::Release);
}

/// The app's own background services run only once the legacy host is chosen.
pub fn legacy_services_enabled(phase: HostPhase) -> bool {
    phase == HostPhase::Legacy
}

pub fn daemon_mode_active() -> bool {
    current_phase() == HostPhase::Daemon
}

/// `hq` arguments that turn the daemon's sync service on or off. Saved in the
/// daemon's config, so the choice survives daemon restarts.
pub fn sync_toggle_args(enable: bool) -> Vec<&'static str> {
    vec!["daemon", if enable { "enable" } else { "disable" }, "sync"]
}

/// `daemon_status` in daemon mode: the daemon's sync service.
pub fn daemon_status_from_state(state: Option<&DaemonState>, daemon_alive: bool) -> DaemonStatus {
    let sync = state
        .filter(|_| daemon_alive)
        .and_then(|s| s.unit("sync"))
        .filter(|u| u.status == "running");
    DaemonStatus {
        running: sync.is_some(),
        pid: sync.and_then(|u| u.pid),
        started_at: sync
            .and_then(|u| u.started_at)
            .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64))
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        watch_path: None,
        source: "hq_daemon".to_string(),
        failure_category: None,
    }
}

/// Run a finished pass's events through the handler the watch runner's stdout
/// feeds, so the app does the same per-pass work for the daemon's sync.
pub fn replay_last_pass<R: Runtime>(app: &AppHandle<R>, hq_folder: &str, pass: &LastPass) {
    let totals = Mutex::new(RunTotals::default());
    let phase = Mutex::new(WatcherPhaseContext::default());
    for event in &pass.events {
        handle_watch_stdout_line(app, hq_folder, &totals, &phase, &event.to_string());
    }
    if pass.dropped_progress > 0 {
        log(
            LOG_TAG,
            &format!(
                "pass {} changed {} more files than Recent Changes records",
                pass.pass_id, pass.dropped_progress
            ),
        );
    }
}

/// Decide who runs background services on this launch, then start them.
pub fn setup_sync_host(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match resolve_mode().await {
            SyncHostMode::Legacy(reason) => {
                log(LOG_TAG, &format!("running the app's own sync services: {}", reason.describe()));
                set_phase(HostPhase::Legacy);
                start_legacy_services(handle);
            }
            SyncHostMode::Daemon => {
                log(LOG_TAG, "hq daemon runs background services on this launch");
                set_phase(HostPhase::Daemon);
                std::thread::spawn(move || enter_daemon_mode(handle));
            }
        }
    });
}

async fn resolve_mode() -> SyncHostMode {
    let flag_on = crate::commands::hq_pro::feature_flag_enabled(HQ_DAEMON_FLAG).await;
    if !flag_on {
        return choose_sync_host(false, false, None);
    }
    let invocation = tauri::async_runtime::spawn_blocking(resolve_hq).await.ok();
    let local = matches!(invocation, Some(HqInvocation::Local(_)));
    let version = if local {
        crate::commands::hq_cli_update::get_hq_cli_version().await
    } else {
        None
    };
    choose_sync_host(true, local, version.as_deref())
}

/// Today's launch behaviour: warm the npx cache and start the watch runner.
fn start_legacy_services(handle: AppHandle) {
    crate::commands::prewarm::spawn_prewarm();
    let dev_disable_auto_sync =
        std::env::var("HQ_DEV_DISABLE_AUTO_SYNC_ON_LAUNCH").ok().as_deref() == Some("1");
    if !dev_disable_auto_sync && (is_autostart_enabled() || is_realtime_sync_enabled()) {
        std::thread::spawn(move || {
            // Small delay to let the app fully initialize
            std::thread::sleep(Duration::from_secs(2));
            let _ = crate::commands::daemon::start_daemon_for_app_launch(handle);
        });
    }
}

/// Sync should run: Auto-sync on, cloud not paused, and no dev kill switch.
fn sync_wanted() -> bool {
    let dev_disable_auto_sync =
        std::env::var("HQ_DEV_DISABLE_AUTO_SYNC_ON_LAUNCH").ok().as_deref() == Some("1");
    !dev_disable_auto_sync
        && hq_desktop_core::daemon::ensure_sync_spawn_allowed().is_ok()
        && (is_autostart_enabled() || is_realtime_sync_enabled())
}

fn enter_daemon_mode(handle: AppHandle) {
    // A watch runner from an earlier session would sync the same folder twice.
    if let Err(e) = crate::commands::daemon::stop_watch_runner() {
        log(LOG_TAG, &format!("could not stop an earlier watch runner: {e}"));
    }
    // The mesh LaunchAgent this app installed keeps the daemon's mesh waiting.
    if let Err(e) =
        tauri::async_runtime::block_on(crate::commands::install_stages::retire_work_mesh_unit())
    {
        log(LOG_TAG, &format!("could not remove the separate Work Mesh unit: {e}"));
    }
    if let Err(e) = set_daemon_sync(sync_wanted()) {
        log(LOG_TAG, &format!("could not apply the Auto-sync setting: {e}"));
    }
    std::thread::spawn(watch_env_changes);
    crate::commands::sync_progress_watch::setup_last_pass_watch(&handle);
    host_loop();
}

/// Environment for the daemon; its services inherit it, sync included.
fn daemon_env() -> HashMap<String, String> {
    let hq_folder = resolve_hq_folder_path().unwrap_or_default();
    let mut env = sync_child_env(&hq_folder);
    if hq_folder.is_empty() {
        // The daemon falls back to the HQ folder in its own config.
        env.remove("HQ_ROOT");
    }
    let inherited = std::env::var("NODE_OPTIONS").ok();
    let flags = compose_runner_spawn_flags(
        inherited.as_deref(),
        Some(effective_runner_heap_ceiling()),
        None,
    );
    if let Some(node_options) = flags.node_options {
        env.insert("NODE_OPTIONS".to_string(), node_options);
    }
    env
}

fn local_hq() -> Option<String> {
    match resolve_hq() {
        HqInvocation::Local(path) => Some(path),
        HqInvocation::Npx => None,
    }
}

/// Run `hq daemon enable|disable sync`.
pub fn set_daemon_sync(enable: bool) -> Result<(), String> {
    let hq = local_hq().ok_or("hq is not installed locally")?;
    let output = hq_desktop_core::paths::spawn_command(&hq, &sync_toggle_args(enable))
        .env("PATH", hq_desktop_core::paths::child_path())
        .env("HQ_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("run hq daemon: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// `start_daemon` / `stop_daemon` in daemon mode.
pub fn set_sync_enabled(enable: bool) -> Result<bool, String> {
    if enable {
        hq_desktop_core::daemon::ensure_sync_spawn_allowed()?;
    }
    set_daemon_sync(enable)?;
    Ok(true)
}

/// `daemon_status` in daemon mode.
pub fn hosted_daemon_status() -> DaemonStatus {
    let paths = default_daemon_paths();
    let alive = paths
        .as_ref()
        .and_then(|p| running_daemon_pid(&p.lock, is_pid_alive))
        .is_some();
    let state = paths.as_ref().and_then(|p| read_daemon_state(&p.state));
    daemon_status_from_state(state.as_ref(), alive)
}

/// Relaunch the daemon when settings that reach it as env change.
fn watch_env_changes() {
    loop {
        std::thread::sleep(ENV_CHECK_INTERVAL);
        if app_exit_requested() {
            return;
        }
        let current = CHILD_ENV.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(current) = current else { continue };
        if daemon_env() != current {
            log(LOG_TAG, "sync settings changed; restarting hq daemon");
            RESTART_REQUESTED.store(true, Ordering::Release);
            terminate_child();
        }
    }
}

fn terminate_child() {
    let pid = CHILD_PID.load(Ordering::Acquire);
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        // The daemon stops its services on SIGTERM and releases its lock.
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
}

fn host_loop() {
    let Some(paths) = default_daemon_paths() else {
        log(LOG_TAG, "no home folder; hq daemon cannot run");
        return;
    };
    let mut failures = 0u32;
    let mut reported_other: Option<u32> = None;
    loop {
        if app_exit_requested() {
            return;
        }
        if let Some(pid) = running_daemon_pid(&paths.lock, is_pid_alive) {
            if reported_other != Some(pid) {
                log(
                    LOG_TAG,
                    &format!("another hq daemon (pid {pid}) is running; leaving services to it"),
                );
                reported_other = Some(pid);
            }
            std::thread::sleep(OTHER_DAEMON_RECHECK);
            continue;
        }
        reported_other = None;
        let Some(hq) = local_hq() else {
            log(LOG_TAG, "hq is no longer installed locally; hq daemon cannot run");
            return;
        };

        let env = daemon_env();
        let mut command = hq_desktop_core::paths::spawn_command(&hq, &daemon_run_args());
        command
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group, so app exit can stop the daemon and its services together.
            command.process_group(0);
        }
        let started = Instant::now();
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                log(LOG_TAG, &format!("could not start hq daemon: {e}"));
                let HostAction::RelaunchAfter(delay) = after_daemon_exit(None, failures, false)
                else {
                    unreachable!("a failed start is never a restart request")
                };
                failures += 1;
                std::thread::sleep(delay);
                continue;
            }
        };
        let pid = child.id();
        CHILD_PID.store(pid, Ordering::Release);
        *CHILD_ENV.lock().unwrap_or_else(|e| e.into_inner()) = Some(env);
        register_process(HQ_DAEMON_HANDLE, pid);
        log(LOG_TAG, &format!("started hq daemon (pid {pid})"));

        let status = child.wait();
        CHILD_PID.store(0, Ordering::Release);
        deregister_process(HQ_DAEMON_HANDLE);
        if app_exit_requested() {
            return;
        }
        let code = status.as_ref().ok().and_then(|s| s.code());
        log(LOG_TAG, &format!("hq daemon (pid {pid}) exited with {code:?}"));
        if RESTART_REQUESTED.swap(false, Ordering::AcqRel) {
            failures = 0;
            continue;
        }
        if started.elapsed() >= HEALTHY_RUN {
            failures = 0;
        }
        let other = running_daemon_pid(&paths.lock, is_pid_alive).is_some_and(|p| p != pid);
        match after_daemon_exit(code, failures, other) {
            HostAction::RelaunchNow => failures = 0,
            HostAction::RelaunchAfter(delay) => {
                failures += 1;
                std::thread::sleep(delay);
            }
            HostAction::GiveUp(reason) => log(LOG_TAG, &reason),
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    use tempfile::TempDir;

    use crate::events::{EVENT_SYNC_ALL_COMPLETE, EVENT_SYNC_CONFLICT};
    use hq_desktop_core::hq_daemon::{DaemonState, LastPass};

    // ── which services run ───────────────────────────────────────────────

    #[test]
    fn the_apps_own_services_run_only_once_the_legacy_host_is_chosen() {
        // Pending covers the few seconds while the flag resolves at launch:
        // nothing starts until the choice is made, so the two never overlap.
        assert!(!legacy_services_enabled(HostPhase::Pending));
        assert!(legacy_services_enabled(HostPhase::Legacy));
        assert!(!legacy_services_enabled(HostPhase::Daemon));
    }

    // ── settings toggles change the daemon's saved config ────────────────

    #[test]
    fn turning_auto_sync_on_or_off_enables_or_disables_the_daemons_sync_service() {
        // Saved in ~/.hq/daemon/config.json, so a paused sync stays paused when
        // the daemon restarts (a stop request would not survive a CLI update).
        assert_eq!(sync_toggle_args(true), vec!["daemon", "enable", "sync"]);
        assert_eq!(sync_toggle_args(false), vec!["daemon", "disable", "sync"]);
    }

    // ── status ───────────────────────────────────────────────────────────

    fn state(sync_status: &str, sync_pid: Option<u32>) -> DaemonState {
        let pid = sync_pid
            .map(|p| format!(r#","pid":{p}"#))
            .unwrap_or_default();
        serde_json::from_str(&format!(
            r#"{{"version":1,"pid":4242,"startedAt":1700000000000,"updatedAt":2,"machineType":"desktop","host":"desktop",
                "units":[{{"id":"sync","service":"sync","kind":"long-running","description":"sync","status":"{sync_status}"{pid},"restarts":0}}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn status_reports_the_daemons_sync_unit() {
        let running = daemon_status_from_state(Some(&state("running", Some(4300))), true);
        assert!(running.running);
        assert_eq!(running.pid, Some(4300));
        assert_eq!(running.source, "hq_daemon");

        let waiting = daemon_status_from_state(Some(&state("waiting", None)), true);
        assert!(!waiting.running);
        assert_eq!(waiting.pid, None);
    }

    #[test]
    fn status_is_stopped_when_the_daemon_is_not_running() {
        let stale = daemon_status_from_state(Some(&state("running", Some(4300))), false);
        assert!(!stale.running);
        let none = daemon_status_from_state(None, false);
        assert!(!none.running);
        assert_eq!(none.source, "hq_daemon");
    }

    // ── per-pass work driven by hq-cloud's end-of-pass record ────────────

    #[test]
    fn a_finished_pass_emits_the_same_events_the_watch_runner_output_did() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let hq_folder = TempDir::new().unwrap();

        let conflicts = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let completes = Arc::new(Mutex::new(0usize));
        {
            let conflicts = conflicts.clone();
            handle.listen(EVENT_SYNC_CONFLICT, move |event| {
                conflicts
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(event.payload()).unwrap());
            });
            let completes = completes.clone();
            handle.listen(EVENT_SYNC_ALL_COMPLETE, move |_| {
                *completes.lock().unwrap() += 1;
            });
        }

        let pass: LastPass = serde_json::from_str(
            r#"{"schema":1,"pid":4300,"passId":"p-1","completedAt":"2026-09-28T00:00:00.000Z","droppedProgress":0,
                "events":[{"type":"conflict","company":"indigo","path":"knowledge/readme.md","direction":"pull","resolution":"keep"},
                          {"type":"all-complete","companiesAttempted":1,"filesDownloaded":0,"bytesDownloaded":0,"filesUploaded":0,"bytesUploaded":0,"conflictPaths":[],"errors":[]}]}"#,
        )
        .unwrap();

        replay_last_pass(&handle, hq_folder.path().to_str().unwrap(), &pass);
        std::thread::sleep(std::time::Duration::from_millis(30));

        let conflicts = conflicts.lock().unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["path"], "knowledge/readme.md");
        assert_eq!(*completes.lock().unwrap(), 1);
    }
}
