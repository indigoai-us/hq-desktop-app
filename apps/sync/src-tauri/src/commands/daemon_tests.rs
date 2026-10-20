//! Unit tests for `daemon.rs`.
//!
//! Included from `daemon.rs` via `#[path = "daemon_tests.rs"] mod tests;`, so
//! this file is the parent module's `tests` child and `super::*` sees its
//! private items.

use super::*;
use crate::commands::process::{deregister_process, try_register_handle};
use crate::util::test_support::{scoped_home, ENV_MUTEX};
use tempfile::TempDir;

#[test]
fn stopping_while_host_selection_is_pending_uses_the_legacy_stop_path() {
    let mut hosted_called = false;
    let mut legacy_called = false;
    let result = stop_daemon_for_phase(
        crate::commands::hq_daemon_host::HostPhase::Pending,
        || {
            hosted_called = true;
            Ok(false)
        },
        || {
            legacy_called = true;
            Ok(true)
        },
    );
    assert_eq!(result, Ok(true));
    assert!(!hosted_called);
    assert!(legacy_called);
}

/// Terminal watch exits must reach the client-health recorder for every
/// genuine death (auth-expiry exit 0, crashes, fault signals), and for
/// nothing that is a deliberate stop: our own cancel or a bare SIGTERM
/// (app quit / OS logout) must never persist a failure across an
/// ordinary shutdown.
#[test]
fn watch_exit_health_recording_skips_deliberate_stops_only() {
    // Auth-expiry shape: exit 0, no signal, not cancelled — must record.
    assert!(watch_exit_should_record_health(false, None));
    // Crash / fault shapes must record.
    assert!(watch_exit_should_record_health(false, Some(SIGKILL)));
    assert!(watch_exit_should_record_health(false, Some(SIGSEGV)));
    // Deliberate stops must not.
    assert!(!watch_exit_should_record_health(true, None));
    assert!(!watch_exit_should_record_health(true, Some(SIGTERM)));
    assert!(!watch_exit_should_record_health(false, Some(SIGTERM)));
}

#[test]
fn hard_footprint_ceiling_preempts_before_the_observed_os_kill_floor() {
    use hq_desktop_core::daemon::{
        effective_watcher_footprint_ceiling_mb, OBSERVED_OS_KILL_FLOOR_MB,
        RUNNER_HEAP_CEILING_DEFAULT_MB, WATCHER_FOOTPRINT_CEILING_CONSECUTIVE,
        WATCHER_FOOTPRINT_CEILING_MB, WATCHER_FOOTPRINT_HARD_CEILING_GROWTH_MB_PER_SEC,
        WATCHER_FOOTPRINT_HARD_CEILING_MB, WATCHER_FOOTPRINT_MIN_WATCH_SECS,
        WATCHER_FOOTPRINT_OVERSHOOT_BUDGET_MB, WATCHER_FOOTPRINT_WORST_OBSERVED_GROWTH_MB_PER_SEC,
    };

    // Pin the deliberate split: the ordinary backstop remains anti-spike,
    // while the hard ceiling is the single-sample OS-kill safety guard. None of
    // the safety thresholds move in this reopen.
    assert_eq!(WATCHER_FOOTPRINT_CEILING_CONSECUTIVE, 2);
    assert_eq!(WATCHER_FOOTPRINT_CEILING_MB, 4608);
    assert_eq!(
        effective_watcher_footprint_ceiling_mb(RUNNER_HEAP_CEILING_DEFAULT_MB),
        5632
    );
    assert_eq!(WATCHER_FOOTPRINT_HARD_CEILING_MB, 5120);

    // Re-derived margin (HQ-DESKTOP-60). The prior pin sized the hard ceiling
    // against an ASSUMED 20 MB/s runaway over a full 30s gap (5,120 + 20*30 =
    // 5,720 < 5,900). Production measured 82.9 MB/s and 250 MB/s — 4x-12x faster —
    // so a real runaway crossed the ceiling mid-gap and was pre-empted only at
    // 7,949 MB, 2,049 MB ABOVE the OS-kill floor. The guard is now paired with an
    // adaptive sampling cadence: once growth is measured the gap shortens so no
    // more than one overshoot budget is added before the next sample. Pin the new
    // constants and re-derive the inequality against the WORST OBSERVED rate and
    // the armed sampling gap.
    assert_eq!(WATCHER_FOOTPRINT_OVERSHOOT_BUDGET_MB, 500);
    assert_eq!(WATCHER_FOOTPRINT_MIN_WATCH_SECS, 2);
    assert_eq!(WATCHER_FOOTPRINT_WORST_OBSERVED_GROWTH_MB_PER_SEC, 250);

    // The armed sampling gap (the floor) times the worst observed rate is exactly
    // the overshoot budget, by construction.
    assert_eq!(
        WATCHER_FOOTPRINT_MIN_WATCH_SECS
            * u64::from(WATCHER_FOOTPRINT_WORST_OBSERVED_GROWTH_MB_PER_SEC),
        u64::from(WATCHER_FOOTPRINT_OVERSHOOT_BUDGET_MB)
    );
    // The worst observed runaway, tracked at the armed sampling floor, is
    // pre-empted below the OS-kill floor: hard ceiling + worst_rate * armed_gap
    // (= hard ceiling + overshoot budget) < OS-kill floor.
    assert!(
        u64::from(WATCHER_FOOTPRINT_HARD_CEILING_MB)
            + u64::from(WATCHER_FOOTPRINT_WORST_OBSERVED_GROWTH_MB_PER_SEC)
                * WATCHER_FOOTPRINT_MIN_WATCH_SECS
            < u64::from(OBSERVED_OS_KILL_FLOOR_MB),
        "the worst observed runaway, tracked at the armed sampling floor, must pre-empt below the OS-kill floor"
    );
    assert!(
        u64::from(WATCHER_FOOTPRINT_HARD_CEILING_MB)
            + u64::from(WATCHER_FOOTPRINT_OVERSHOOT_BUDGET_MB)
            < u64::from(OBSERVED_OS_KILL_FLOOR_MB)
    );
    // The prior 20 MB/s assumption still holds as a lower bound and is retained
    // for context; the guard no longer relies on a fixed full-tick gap for it.
    assert_eq!(WATCHER_FOOTPRINT_HARD_CEILING_GROWTH_MB_PER_SEC, 20);
    assert!(
        u64::from(WATCHER_FOOTPRINT_HARD_CEILING_MB)
            + u64::from(WATCHER_FOOTPRINT_HARD_CEILING_GROWTH_MB_PER_SEC)
                * SUPERVISOR_INTERVAL.as_secs()
            < u64::from(OBSERVED_OS_KILL_FLOOR_MB)
    );
}

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

/// First-run VM report (v0.10.395): before setup finished, the app-launch
/// start and the supervisor respawn both reached sync preflight and the
/// runner pulled the cloud company into the default HQ folder. While HQ
/// is not installed every origin must refuse at the setup gate, before it
/// resolves a root, runs preflight, or writes anything under home.
#[test]
fn start_daemon_refuses_every_origin_while_setup_is_unfinished() {
    use crate::commands::lifecycle::{
        publish_sync_setup_gate, sync_held_for_setup, SYNC_HELD_FOR_SETUP_MESSAGE,
    };
    use hq_desktop_core::lifecycle::LifecycleState;

    let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().unwrap();
    let _home = scoped_home(tmp.path());
    publish_sync_setup_gate(LifecycleState::NeedsInstall);
    assert!(sync_held_for_setup());

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    for result in [
        start_daemon(handle.clone()),
        start_daemon_for_app_launch(handle.clone()),
        start_daemon_for_supervisor_respawn(handle.clone()),
    ] {
        assert_eq!(result.unwrap_err(), SYNC_HELD_FOR_SETUP_MESSAGE);
    }
    assert_eq!(
        crate::commands::sync::start_sync_gates(),
        Err(SYNC_HELD_FOR_SETUP_MESSAGE.to_string())
    );
    // No default HQ folder, and nothing else, was created under home.
    assert!(!tmp.path().join("hq").exists());
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);

    publish_sync_setup_gate(LifecycleState::SteadyState);
    assert!(!sync_held_for_setup());
}

/// The supervisor's tick does nothing (no owner inspection, preflight or
/// respawn) while setup is unfinished, and runs again once it finishes.
#[test]
fn supervisor_tick_waits_for_setup_and_runs_once_it_finishes() {
    use crate::commands::hq_daemon_host::HostPhase;
    assert!(!supervisor_tick_may_run(HostPhase::Legacy, true));
    assert!(supervisor_tick_may_run(HostPhase::Legacy, false));
    assert!(!supervisor_tick_may_run(HostPhase::Pending, false));
    assert!(!supervisor_tick_may_run(HostPhase::Daemon, false));
    assert!(!supervisor_tick_may_run(HostPhase::Daemon, true));
}

/// Owner decision 2026-10-13: a parked conflict copy has no desktop
/// surface. The watcher still reads the runner's `conflict` line (it is a
/// real protocol record and refreshes the watchdog) but never hands it to
/// a window.
#[test]
fn handle_watch_stdout_line_never_forwards_a_conflict_line_to_the_window() {
    use std::sync::Arc;
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let hq_folder = TempDir::new().unwrap();
    let totals = Mutex::new(RunTotals::default());
    let phase = Mutex::new(WatcherPhaseContext::default());

    let seen = Arc::new(Mutex::new(0usize));
    let seen_w = seen.clone();
    handle.listen("sync:conflict", move |_| {
        *seen_w.lock().unwrap() += 1;
    });

    let line = r#"{"type":"conflict","company":"indigo","path":"knowledge/readme.md","direction":"pull","resolution":"keep"}"#;
    assert!(handle_watch_stdout_line(
        &handle,
        hq_folder.path().to_str().unwrap(),
        &totals,
        &phase,
        line,
    ));
    std::thread::sleep(std::time::Duration::from_millis(30));

    assert_eq!(*seen.lock().unwrap(), 0);
}

#[test]
fn watcher_status_accepts_unknown_fields_and_scrubs_lock_holder_arguments() {
    let status = parse_watch_runner_status(
        r#"{"type":"status","state":"waiting-for-lock","holder":{"pid":42,"command":"/Users/alice/.local/bin/hq sync --token secret"},"future":true}"#,
    )
    .expect("known status with additive fields parses");
    assert_eq!(status.state, "waiting-for-lock");
    assert_eq!(status.holder_command.as_deref(), Some("hq sync"));
    assert_eq!(
        parse_watch_runner_status(
            r#"{"type":"status","state":"waiting-for-lock","holder":{"command":"/Users/alice/email@example.com/run --token abc"}}"#,
        )
        .expect("holder with path and options still has a bounded label")
        .holder_command
        .as_deref(),
        Some("run"),
        "do not skip options to expose a later argument"
    );
}

#[test]
fn waiting_for_lock_status_updates_watcher_state_and_emits_safe_app_detail() {
    use std::sync::Arc;
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let hq_folder = TempDir::new().unwrap();
    let totals = Mutex::new(RunTotals::default());
    let phase = Mutex::new(WatcherPhaseContext::default());
    let seen = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let seen_w = seen.clone();
    window.listen(crate::events::EVENT_SYNC_WATCHER_STATUS, move |event| {
        seen_w
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });

    assert!(handle_watch_stdout_line(
        &handle,
        hq_folder.path().to_str().unwrap(),
        &totals,
        &phase,
        r#"{"type":"status","state":"waiting-for-lock","holder":{"pid":42,"command":"/Users/alice/.local/bin/hq sync --token secret"}}"#,
    ));
    std::thread::sleep(Duration::from_millis(30));

    assert_eq!(
        phase
            .lock()
            .unwrap()
            .protocol_status
            .as_ref()
            .unwrap()
            .state,
        "waiting-for-lock"
    );
    assert!(!phase.lock().unwrap().first_pass_started);
    let seen_lock = seen.lock().unwrap();
    assert_eq!(seen_lock.len(), 1);
    assert_eq!(seen_lock[0]["state"], "waiting-for-lock");
    assert_eq!(seen_lock[0]["holderCommand"], "hq sync");
    drop(seen_lock);

    assert!(handle_watch_stdout_line(
        &handle,
        hq_folder.path().to_str().unwrap(),
        &totals,
        &phase,
        r#"{"type":"status","state":"running","passId":"pass-1"}"#,
    ));
    std::thread::sleep(Duration::from_millis(30));
    assert!(phase.lock().unwrap().first_pass_started);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1]["state"], "running");
}

#[test]
fn status_lines_mark_the_watcher_protocol_as_observed() {
    let app = tauri::test::mock_app();
    let hq_folder = TempDir::new().unwrap();
    let totals = Mutex::new(RunTotals::default());
    let phase = Mutex::new(WatcherPhaseContext::default());

    assert_eq!(phase.lock().unwrap().phase, RUNNER_PHASE_PRE_PROTOCOL);
    assert!(handle_watch_stdout_line(
        app.handle(),
        hq_folder.path().to_str().unwrap(),
        &totals,
        &phase,
        r#"{"type":"status","state":"waiting-for-lock"}"#,
    ));

    assert_eq!(phase.lock().unwrap().phase, "unknown");
}

#[test]
fn waiting_for_lock_status_reaches_the_visible_desktop_window() {
    use std::sync::Arc;
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let desktop = tauri::WebviewWindowBuilder::new(&app, "desktop-alt", Default::default())
        .build()
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let seen_w = seen.clone();
    desktop.listen(crate::events::EVENT_SYNC_WATCHER_STATUS, move |event| {
        seen_w
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });

    assert!(handle_watch_stdout_line(
        &handle,
        TempDir::new().unwrap().path().to_str().unwrap(),
        &Mutex::new(RunTotals::default()),
        &Mutex::new(WatcherPhaseContext::default()),
        r#"{"type":"status","state":"waiting-for-lock","holder":{"command":"hq sync"}}"#,
    ));
    std::thread::sleep(Duration::from_millis(30));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["state"], "waiting-for-lock");
    assert_eq!(seen[0]["holderCommand"], "hq sync");
}

#[test]
fn operation_lock_timeouts_are_excluded_from_client_health_failures() {
    assert!(!should_record_watcher_exit_health(
        Some(OPERATION_LOCKED_EXIT),
        None
    ));
    assert!(should_record_watcher_exit_health(Some(1), None));
    assert!(should_record_watcher_exit_health(None, None));
}

#[test]
fn watcher_exit_publishes_lock_clear_to_main_and_visible_desktop() {
    use std::sync::Arc;
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let desktop = tauri::WebviewWindowBuilder::new(&app, "desktop-alt", Default::default())
        .build()
        .unwrap();
    let observed = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    for window in [&main, &desktop] {
        let observed = observed.clone();
        window.listen(crate::events::EVENT_SYNC_WATCHER_STATUS, move |event| {
            observed
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
    }
    let mut effects = RecordingWatcherEffects::default();

    handle_watcher_exit_with_app(
        &handle,
        &mut effects,
        Some(0),
        None,
        true,
        false,
        "hq sync watch",
        None,
        TerminationHost::Posix,
        &WatcherExitCaptureContext::default(),
    );
    std::thread::sleep(Duration::from_millis(30));

    let observed = observed.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert!(observed.iter().all(|status| status["state"] == "stopped"));
}

#[test]
fn operation_lock_timeout_is_retried_without_counting_as_a_crash() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(OPERATION_LOCKED_EXIT),
        None,
        false,
        false,
        "npx",
        Some("operation lock timed out"),
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(effects.lock_timeouts, 1);
    assert_eq!(effects.consecutive, 0, "a lock timeout is not a crash");
    assert!(effects.in_backoff, "retry must wait for a backoff window");
    assert!(
        effects.captures.is_empty(),
        "lock timeout is not a crash report"
    );
    assert_eq!(
        effects.lifecycle,
        vec![(WatchDaemonState::Backoff, DaemonFailureCategory::None)]
    );
}

#[test]
fn only_the_operation_locked_exit_code_takes_the_lock_retry_path() {
    assert!(is_operation_lock_timeout_exit(Some(17), None));
    assert!(!is_operation_lock_timeout_exit(Some(17), Some(9)));
    assert!(!is_operation_lock_timeout_exit(Some(1), None));
}

#[test]
fn first_pass_stall_deadline_ignores_long_passes_that_have_started() {
    assert!(should_restart_watcher_before_first_pass(
        false,
        WATCHER_FIRST_PASS_START_DEADLINE
    ));
    assert!(!should_restart_watcher_before_first_pass(
        false,
        WATCHER_FIRST_PASS_START_DEADLINE - Duration::from_secs(1)
    ));
    assert!(!should_restart_watcher_before_first_pass(
        true,
        WATCHER_FIRST_PASS_START_DEADLINE * 4
    ));
}

/// hard-stop-readiness US-019 e2e: given a company over storage, when the
/// desktop app finishes an auto-sync pass, the desktop window hears the
/// notice and the paused set, the menu bar is handed the paused set with
/// the upgrade link, and the journal persists it instead of recording a
/// clean sync.
#[test]
fn a_pass_with_plan_limit_skips_reports_uploads_paused_everywhere() {
    use std::sync::Arc;
    use tauri::Listener;

    static TRAY_SNAPSHOTS: Mutex<Vec<Vec<hq_desktop_core::uploads_paused::UploadsPaused>>> =
        Mutex::new(Vec::new());

    let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let home = TempDir::new().unwrap();
    std::fs::create_dir_all(home.path().join(".hq")).unwrap();
    let _home = scoped_home(home.path());
    // Stands in for the tray module, which registers at setup.
    crate::commands::uploads_paused::set_tray_sink(|companies| {
        TRAY_SNAPSHOTS.lock().unwrap().push(companies);
    });

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let hq_folder = TempDir::new().unwrap();
    let folder = hq_folder.path().to_str().unwrap();
    let totals = Mutex::new(RunTotals::default());
    let phase = Mutex::new(WatcherPhaseContext::default());
    let company = "Acme US-019 daemon";
    let upgrade_url = "https://hq.computer/companies/acme/billing?upgrade=1";

    let plan_limit = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let plan_limit_w = plan_limit.clone();
    handle.listen_any(EVENT_SYNC_PLAN_LIMIT, move |event| {
        plan_limit_w
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    let paused = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let paused_w = paused.clone();
    handle.listen_any(
        crate::commands::uploads_paused::EVENT_SYNC_UPLOADS_PAUSED,
        move |event| {
            paused_w
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        },
    );

    let lines = [
        format!(r#"{{"type":"plan-limit","company":"{company}","upgradeUrl":"{upgrade_url}"}}"#),
        format!(
            r#"{{"type":"complete","company":"{company}","filesDownloaded":0,"bytesDownloaded":0,"filesSkipped":4,"conflicts":0,"aborted":false}}"#
        ),
        r#"{"type":"all-complete","companiesAttempted":1,"filesDownloaded":0,"bytesDownloaded":0,"errors":[]}"#
            .to_string(),
    ];
    for line in &lines {
        assert!(handle_watch_stdout_line(
            &handle, folder, &totals, &phase, line
        ));
    }
    std::thread::sleep(std::time::Duration::from_millis(50));

    // The desktop window hears the notice.
    let plan_limit = plan_limit.lock().unwrap();
    assert_eq!(plan_limit.len(), 1);
    assert_eq!(plan_limit[0]["company"], company);
    assert_eq!(plan_limit[0]["upgradeUrl"], upgrade_url);

    // The menu bar is handed the paused set, with the link.
    assert!(TRAY_SNAPSHOTS
        .lock()
        .unwrap()
        .iter()
        .any(|snapshot| snapshot
            .iter()
            .any(|entry| entry.company == company
                && entry.upgrade_url.as_deref() == Some(upgrade_url))));

    // The desktop window hears the paused set, with the link.
    let paused = paused.lock().unwrap();
    let last = paused.last().expect("uploads-paused was announced");
    let row = last["companies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["company"] == company)
        .expect("the over-storage company is paused");
    assert_eq!(row["upgradeUrl"], upgrade_url);
    assert!(crate::commands::uploads_paused::snapshot(Some(folder))
        .iter()
        .any(|entry| entry.company == company));
    assert_eq!(
        crate::commands::uploads_paused::upgrade_url_for(company).as_deref(),
        Some(upgrade_url)
    );

    // The journal records the pause, so status reads say "paused", not synced.
    let journal = std::fs::read_to_string(hq_folder.path().join(".hq-sync-journal.json")).unwrap();
    let journal: serde_json::Value = serde_json::from_str(&journal).unwrap();
    assert!(journal["uploadsPaused"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["company"] == company && row["upgradeUrl"] == upgrade_url));
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
fn handoff_lifecycle_requires_a_live_runner_process() {
    use WatchDaemonState::*;
    // Spawned and alive, even before the supervisor promotes the label.
    assert_eq!(handoff_lifecycle(Starting, true), Running);
    assert_eq!(handoff_lifecycle(Running, true), Running);
    // Preflight still running: nothing to hand off to yet.
    assert_eq!(handoff_lifecycle(Starting, false), Starting);
    // Recorded as running but the process is gone.
    assert_eq!(handoff_lifecycle(Running, false), Backoff);
    assert_eq!(handoff_lifecycle(Backoff, true), Backoff);
    assert_eq!(handoff_lifecycle(Stopped, true), Stopped);
    assert_eq!(handoff_lifecycle(Stopped, false), Stopped);
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
    assert_eq!(SIGKILL_DELAY, Duration::from_secs(9));
}

#[test]
fn watcher_stop_graces_exceed_runner_shutdown_deadline() {
    let runner_deadline = Duration::from_millis(7_500);
    assert!(SIGKILL_DELAY > runner_deadline);
    assert!(WATCH_OWNER_TERMINATION_GRACE > runner_deadline);
    assert_eq!(
        SIGKILL_DELAY,
        crate::commands::process::SYNC_RUNNER_STOP_GRACE
    );
    assert_eq!(
        WATCH_OWNER_TERMINATION_GRACE,
        crate::commands::process::SYNC_RUNNER_STOP_GRACE
    );
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
    lock_timeouts: u32,
    /// Mirrors the production episode streak: grows on every exit regardless
    /// of the fast/slow arm.
    slow_death_consecutive: u32,
    /// When set, model the production slow-death arm — `consecutive` is pinned
    /// to 1 (a generation that ran healthily then died) while
    /// `slow_death_consecutive` keeps growing. Default `false` keeps the
    /// fast-failure crash-loop behaviour (`consecutive` increments) that the
    /// existing episode tests rely on, and leaves the two streaks in lockstep.
    simulate_slow_death: bool,
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
    /// Captures handed to the deferred NON-fault runner-report read
    /// (HQ-DESKTOP-66). The double performs the SAME read + apply the worker does
    /// (synchronously, so a test can observe the MEASURED verdict), keeping them
    /// separate from `captures` so a test can prove the read is off the exit path.
    deferred_runner_report: Vec<RecordedCapture>,
    lifecycle: Vec<(WatchDaemonState, DaemonFailureCategory)>,
}

impl WatcherProcessEffects for RecordingWatcherEffects {
    fn note_watcher_crashed(&mut self) -> u32 {
        if self.simulate_slow_death {
            // Ran healthily, then died: production pins `consecutive` to 1.
            self.consecutive = 1;
        } else {
            self.consecutive = self.consecutive.saturating_add(1);
        }
        self.in_backoff = true;
        self.consecutive
    }

    fn note_operation_lock_timeout(&mut self) -> u32 {
        self.lock_timeouts = self.lock_timeouts.saturating_add(1);
        self.in_backoff = true;
        self.lock_timeouts
    }

    fn note_watcher_capture_policy_streak(
        &mut self,
        policy: WatcherExitCapturePolicy,
        global_consecutive: u32,
    ) -> u32 {
        self.exec_not_runnable_consecutive =
            next_exec_not_runnable_streak(self.exec_not_runnable_consecutive, policy);
        match policy {
            WatcherExitCapturePolicy::CaptureRateLimited => self.exec_not_runnable_consecutive,
            WatcherExitCapturePolicy::Capture
            | WatcherExitCapturePolicy::DeferSessionEndDecision => {
                // Episode streak advances only for the capture-eligible classes.
                self.slow_death_consecutive = self.slow_death_consecutive.saturating_add(1);
                self.slow_death_consecutive
            }
            WatcherExitCapturePolicy::LocalLogOnly => global_consecutive,
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
    ) -> (
        Option<Duration>,
        Option<u64>,
        Option<Duration>,
        Option<RssSampleKind>,
    ) {
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

    fn defer_runner_report_capture(
        &mut self,
        message: &str,
        fingerprint: &[&str],
        tags: &[(&str, String)],
        extras: &[(&str, sentry::protocol::Value)],
        report_dir: PathBuf,
    ) {
        // Mirror the production worker SYNCHRONOUSLY so a seam test observes the
        // MEASURED verdict: read + apply the report to a copy of the tags, then
        // record it in its own bucket — never `captures`, so the read is provably
        // off the immediate-send path.
        let mut applied: Vec<(String, String)> = tags
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect();
        apply_deferred_runner_report(&report_dir, &mut applied);
        let applied_refs: Vec<(&str, String)> = applied
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        self.deferred_runner_report.push(recorded_capture(
            message,
            fingerprint,
            &applied_refs,
            extras,
        ));
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

#[test]
fn unexpected_watcher_exit_21_capture_has_phase_tags() {
    let mut effects = RecordingWatcherEffects::default();
    let context = WatcherExitCaptureContext {
        runner_phase: "pull".to_string(),
        runner_phase_elapsed_bucket: "5m_to_30m".to_string(),
        runner_fatal_class: "disk_full".to_string(),
        ..WatcherExitCaptureContext::default()
    };

    handle_watcher_exit_with_effects(
        &mut effects,
        Some(21),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        Some("runner stopped after lease loss"),
        current_termination_host(),
        &context,
    );

    assert_eq!(effects.captures.len(), 1);
    let capture = &effects.captures[0];
    assert_eq!(recorded_tag(capture, "runner_phase"), "pull");
    assert_eq!(
        recorded_tag(capture, "runner_phase_elapsed_bucket"),
        "5m_to_30m"
    );
    assert_eq!(recorded_tag(capture, "exit_class"), "disk_full");
    assert!(
        capture.message.contains("disk is full"),
        "known disk-full cause should appear in the report title: {}",
        capture.message
    );
}

#[test]
fn stronger_crash_evidence_keeps_disk_full_stderr_out_of_the_disk_full_bucket() {
    for (code, saw_genuine_crash_fatal) in [(Some(21), true), (Some(0xC000_001Du32 as i32), false)]
    {
        let mut effects = RecordingWatcherEffects::default();
        let context = WatcherExitCaptureContext {
            runner_fatal_class: "disk_full".to_string(),
            saw_genuine_crash_fatal,
            ..WatcherExitCaptureContext::default()
        };

        handle_watcher_exit_with_effects(
            &mut effects,
            code,
            None,
            false,
            false,
            "/opt/homebrew/bin/npx",
            Some("unrecognised stderr"),
            current_termination_host(),
            &context,
        );

        let capture = &effects.captures[0];
        assert_eq!(recorded_tag(capture, "exit_class"), "other");
        assert!(capture.message.contains("exited unexpectedly"));
        assert!(!capture.message.contains("because the disk is full"));
    }
}

#[test]
fn unknown_watcher_exit_21_remains_in_the_unexpected_bucket() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(21),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        Some("unrecognised stderr"),
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );

    let capture = effects.captures.first().expect("unknown exit is captured");
    assert_eq!(recorded_tag(capture, "exit_class"), "other");
    assert!(capture.message.contains("exited unexpectedly"));
}

#[test]
fn sighup_watcher_exit_is_named_and_classified() {
    // HQ-DESKTOP-5Y: a macOS SIGHUP (code=None, signal=Some(1)) with none of
    // the self-teardown discriminators set is captured — but must now be named
    // 'killed by SIGHUP' and carry a queryable signal class + integer, not the
    // raw Debug tuple 'code=None signal=Some(1)' the issue observed.
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(1),
        false,
        false,
        "/opt/homebrew/bin/npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(effects.captures.len(), 1);
    let capture = &effects.captures[0];
    assert!(
        capture.message.contains("killed by SIGHUP"),
        "message did not name SIGHUP: {}",
        capture.message
    );
    assert!(
        !capture.message.contains("signal=Some(1)"),
        "message still leaked the raw Debug tuple: {}",
        capture.message
    );
    assert_eq!(recorded_tag(capture, "watcher_exit_signal_class"), "hangup");
    assert_eq!(recorded_number_extra(capture, "watcher_exit_signal"), 1);
    assert_eq!(capture.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(recorded_tag(capture, "exit_class"), "other");
}

#[test]
fn sighup_capture_and_lifecycle_behaviour_is_unchanged() {
    // Reporting-only scope: naming the signal must not change capture policy,
    // lifecycle category, or crash-streak accounting for (None, Some(1)).
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(1),
        false,
        false,
        "/opt/homebrew/bin/npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );
    // One capture, the same 'running -> backoff (crash)' lifecycle this issue
    // carried, and no exec-not-runnable streak extra — that tier belongs to the
    // 126/127 exec layer, whose shared streak SIGHUP must never consume.
    assert_eq!(effects.captures.len(), 1);
    assert_eq!(
        effects.lifecycle,
        vec![(WatchDaemonState::Backoff, DaemonFailureCategory::Crash)]
    );
    assert!(
        effects.captures[0]
            .extras
            .iter()
            .all(|(name, _)| name != "exec_not_runnable_streak"),
        "SIGHUP must not touch the exec-not-runnable streak"
    );
}

#[test]
fn malformed_dual_status_keeps_the_raw_rendering() {
    // describe_exit prefers `code` and would drop the signal, so the malformed
    // both-present shape must keep the raw rendering that preserves both values.
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(3),
        Some(9),
        false,
        false,
        "/opt/homebrew/bin/npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(effects.captures.len(), 1);
    let message = &effects.captures[0].message;
    assert!(
        message.contains("code=Some(3)") && message.contains("signal=Some(9)"),
        "malformed both-present exit dropped a value: {message}"
    );
}

#[test]
fn signal_class_tag_is_emitted_for_every_captured_shape() {
    // The class tag is present and correct on every captured watcher exit: a
    // SIGKILL is `fault`, a plain exit 221 is `none` — so it can never be absent
    // or wrong on a captured termination.
    let host = current_termination_host();
    for (code, signal, expected_class) in [(None, Some(9), "fault"), (Some(221), None, "none")] {
        let mut effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut effects,
            code,
            signal,
            false,
            false,
            "/opt/homebrew/bin/npx",
            None,
            host,
            &WatcherExitCaptureContext::default(),
        );
        assert_eq!(effects.captures.len(), 1, "code={code:?} signal={signal:?}");
        assert_eq!(
            recorded_tag(&effects.captures[0], "watcher_exit_signal_class"),
            expected_class,
            "code={code:?} signal={signal:?}"
        );
    }
}

#[test]
fn watcher_exit_signal_class_matches_is_fault_signal() {
    // The classifier's `fault` arm and daemon.rs is_fault_signal must name the
    // same signal set, or a future signal could be alerted by one path and
    // silently reclassified by the other.
    for sig in 1..=31 {
        assert_eq!(
            is_fault_signal(Some(sig)),
            watcher_exit_signal_class(Some(sig)) == "fault",
            "fault-set drift at signal {sig}"
        );
    }
    assert!(!is_fault_signal(None));
    assert_eq!(watcher_exit_signal_class(None), "none");
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
fn disk_full_watcher_exit_is_suppressed_and_reports_disk_full() {
    // HQ-DESKTOP-5D parity: the auto-sync watcher must not page for a full-disk
    // exit — not even on an otherwise-alertable (unknown 221) code — matching
    // the manual route's DiskFull disposition. The condition stays observable:
    // the local log and breadcrumb name runner_fatal_class=disk_full.
    let context = WatcherExitCaptureContext {
        runner_disk_exhaustion_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(221),
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &context,
    );
    assert!(
        effects.captures.is_empty(),
        "a full-disk watcher exit must not capture to Sentry"
    );
    let recorded = format!("{:?}{:?}", effects.logs, effects.breadcrumbs);
    assert!(
        recorded.contains("disk_full"),
        "watcher must still report runner_fatal_class=disk_full locally: {recorded}"
    );
}

#[test]
fn disk_full_watcher_gate_still_captures_a_crash_signal() {
    // A crash signal co-occurring with a disk-full content signal is NOT a
    // disk-full exit — the watcher must still capture it (gate d), mirroring
    // the manual route's crash-signal negative control.
    let context = WatcherExitCaptureContext {
        runner_disk_exhaustion_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGSEGV),
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &context,
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "a crash signal with a disk-full content signal must still capture"
    );
}

#[test]
fn disk_full_watcher_gate_still_captures_a_windows_native_fault() {
    // Finding 0 at the watcher boundary: a Windows native fault is reported in
    // `code` with signal=None; the disk-full content signal must not suppress it.
    let context = WatcherExitCaptureContext {
        runner_disk_exhaustion_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(0xC000_0005u32 as i32), // ACCESS_VIOLATION
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        TerminationHost::Windows,
        &context,
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "a Windows native fault with a disk-full content signal must still capture"
    );
}

#[test]
fn file_locked_watcher_exit_is_suppressed_and_reports_file_lock() {
    // HQ-DESKTOP-5R parity insurance: the auto-sync watcher must not page for a
    // transient-file-lock exit, matching the manual route's FileLocked
    // disposition. A code-1/2 no-signal exit is already benign, so this uses a
    // NON-benign code (243) — the case the new arm actually covers — to prove
    // the suppression comes from the file-lock recognizer, not is_benign. The
    // condition stays observable: the log and breadcrumb name
    // runner_error_class=ebusy.
    let context = WatcherExitCaptureContext {
        runner_file_lock_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(243),
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &context,
    );
    assert!(
        effects.captures.is_empty(),
        "a file-lock watcher exit must not capture to Sentry"
    );
    let recorded = format!("{:?}{:?}", effects.logs, effects.breadcrumbs);
    assert!(
        recorded.contains("ebusy"),
        "watcher must still report runner_error_class=ebusy locally: {recorded}"
    );
}

#[test]
fn file_locked_watcher_gate_still_captures_a_crash_signal() {
    // A crash signal co-occurring with a file-lock content signal is NOT a
    // file-lock exit — the watcher must still capture it, mirroring the manual
    // route's crash-signal negative control.
    let context = WatcherExitCaptureContext {
        runner_file_lock_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGSEGV),
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &context,
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "a crash signal with a file-lock content signal must still capture"
    );
}

#[test]
fn file_locked_watcher_gate_still_captures_a_windows_native_fault() {
    // A Windows native fault is reported in `code` with signal=None; the
    // file-lock content signal must not suppress it.
    let context = WatcherExitCaptureContext {
        runner_file_lock_content: true,
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(0xC000_0005u32 as i32), // ACCESS_VIOLATION
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        TerminationHost::Windows,
        &context,
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "a Windows native fault with a file-lock content signal must still capture"
    );
}

#[test]
fn file_lock_and_disk_full_watcher_signals_do_not_cross_wire() {
    // The two content signals are independent booleans: a disk-full-only context
    // reports disk_full (not ebusy), and a file-lock-only context reports ebusy
    // (not disk_full), so the watcher attributions can never be confused.
    let disk = WatcherExitCaptureContext {
        runner_disk_exhaustion_content: true,
        ..Default::default()
    };
    let mut disk_effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut disk_effects,
        Some(243),
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &disk,
    );
    let disk_recorded = format!("{:?}{:?}", disk_effects.logs, disk_effects.breadcrumbs);
    assert!(disk_recorded.contains("disk_full"));
    assert!(!disk_recorded.contains("ebusy"));

    let lock = WatcherExitCaptureContext {
        runner_file_lock_content: true,
        ..Default::default()
    };
    let mut lock_effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut lock_effects,
        Some(243),
        None,
        false,
        false,
        "npx hq-sync-runner",
        None,
        current_termination_host(),
        &lock,
    );
    let lock_recorded = format!("{:?}{:?}", lock_effects.logs, lock_effects.breadcrumbs);
    assert!(lock_recorded.contains("ebusy"));
    assert!(!lock_recorded.contains("disk_full"));
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
        vec!["sync-watcher-exit", "node_fatal"]
    );
    assert_eq!(recorded_tag(windows_capture, "exit_class"), "node_fatal");
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
        vec!["sync-watcher-exit", "other"]
    );
    // Post-fix: the plain exit code is named by describe_exit rather than
    // dumped as a raw Debug tuple. Grouping is unchanged (fingerprint above).
    assert!(unknown_capture.message.contains("with code 221"));
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
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
        vec!["sync-watcher-exit", "other"]
    );
    // Post-fix: named by describe_exit (a bare exit 134 is only a Node abort
    // on Windows; on POSIX it stays a plain exit code). Grouping unchanged.
    assert!(posix_134_capture.message.contains("with code 134"));
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
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
    assert_eq!(
        recorded_tag(capture, "watcher_job_process_count"),
        "unknown"
    );
    // `npx` is a direct launcher, not the runner, so its RSS is scoped away.
    assert_eq!(recorded_tag(capture, "watcher_child_kind"), "launcher");
    assert_eq!(recorded_tag(capture, "rss_scope"), "launcher");
    assert!(
        capture
            .tags
            .iter()
            .all(|(k, _)| k != "runner_fatal_syscall"),
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
    assert_eq!(
        recorded_number_extra(capture, "runner_stderr_line_count"),
        8
    );
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
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
        runner_error_causes: Some("vault_not_found:120,unknown_named:8".to_string()),
        runner_error_cause_signature: Some("1a2b3c4d5e6f:8".to_string()),
        runner_error_unknown_profiles: Some("key_value_led:160,lower_prose:8".to_string()),
        runner_error_residual_signature: Some("ea4e65576be5:8".to_string()),
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
        "vault_not_found:120,unknown_named:8"
    );
    // The cause-signature axis rides the SAME capture from the same shared
    // source, so the watcher route emits it alongside the cause axis.
    assert_eq!(
        recorded_tag(capture, "runner_error_cause_signature"),
        "1a2b3c4d5e6f:8"
    );
    // The unknown_unnamed residual axes (HQ-DESKTOP-61/62) ride the SAME capture
    // from the same shared source, pinning both-seams parity for them too.
    assert_eq!(
        recorded_tag(capture, "runner_error_unknown_profiles"),
        "key_value_led:160,lower_prose:8"
    );
    assert_eq!(
        recorded_tag(capture, "runner_error_residual_signature"),
        "ea4e65576be5:8"
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

// ── Runner diagnostic report — the crash-surviving third channel (HQ-DESKTOP-5W) ──

fn heap_oom_report_json() -> String {
    serde_json::json!({
        "header": {
            "trigger": "FatalError",
            "event": "Allocation failed - JavaScript heap out of memory"
        },
        "nativeStack": [
            { "pc": "0x1", "symbol": "node::OOMErrorHandler(char const*)" },
            { "pc": "0x2", "symbol": "v8::internal::V8::FatalProcessOutOfMemory(char const*)" }
        ]
    })
    .to_string()
}

fn report_tags_with_class(class: &str) -> Vec<(String, String)> {
    vec![
        ("runner_fatal_class".to_string(), class.to_string()),
        ("sync_route".to_string(), "watcher".to_string()),
        ("runner_stack_shape".to_string(), "all_redacted".to_string()),
        ("runner_stack_signature".to_string(), "unknown".to_string()),
        ("runner_fatal_source".to_string(), "none".to_string()),
        (
            "runner_report_read".to_string(),
            "report_absent".to_string(),
        ),
    ]
}

fn report_tag_of<'a>(tags: &'a [(String, String)], key: &str) -> &'a str {
    tags.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
}

fn unique_report_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("hq-report-{label}-{}-{nanos}", std::process::id()))
}

#[test]
fn apply_report_adopts_a_named_cause_only_when_stderr_named_none() {
    // The Windows-fault case: stderr named nothing, so the report's heap_oom is
    // adopted and runner_fatal_source flips to node_report.
    let report = hq_desktop_core::runner_diagnostic_report::parse_runner_diagnostic_report(
        heap_oom_report_json().as_bytes(),
    );
    assert!(report.named_cause());
    let mut tags = report_tags_with_class("none");
    apply_report_to_fault_tags(&mut tags, &report);
    assert_eq!(report_tag_of(&tags, "runner_fatal_class"), "heap_oom");
    assert_eq!(report_tag_of(&tags, "runner_fatal_source"), "node_report");
    assert_eq!(report_tag_of(&tags, "runner_report_read"), "report_read");
    assert_ne!(report_tag_of(&tags, "runner_stack_shape"), "all_redacted");
    assert_eq!(report_tag_of(&tags, "runner_stack_signature").len(), 16);
}

#[test]
fn apply_report_never_overrides_a_stderr_named_class() {
    // A stderr-derived class already named the cause: the report records its read
    // provenance but NEVER overrides the class, source, or shape (macOS heap_oom
    // and every stderr attribution keeps priority).
    let report = hq_desktop_core::runner_diagnostic_report::parse_runner_diagnostic_report(
        heap_oom_report_json().as_bytes(),
    );
    let mut tags = report_tags_with_class("libuv_assert");
    set_payload_tag(&mut tags, "runner_fatal_source", "stderr".to_string());
    set_payload_tag(
        &mut tags,
        "runner_stack_shape",
        "node_check_abort>v8_abort".to_string(),
    );
    apply_report_to_fault_tags(&mut tags, &report);
    assert_eq!(report_tag_of(&tags, "runner_fatal_class"), "libuv_assert");
    assert_eq!(report_tag_of(&tags, "runner_fatal_source"), "stderr");
    assert_eq!(
        report_tag_of(&tags, "runner_stack_shape"),
        "node_check_abort>v8_abort"
    );
    // Only the read provenance is recorded.
    assert_eq!(report_tag_of(&tags, "runner_report_read"), "report_read");
}

#[test]
fn apply_report_records_absence_without_naming_a_cause() {
    let mut tags = report_tags_with_class("none");
    apply_report_to_fault_tags(
        &mut tags,
        &hq_desktop_core::runner_diagnostic_report::RunnerDiagnosticReport::absent(),
    );
    assert_eq!(report_tag_of(&tags, "runner_fatal_class"), "none");
    assert_eq!(report_tag_of(&tags, "runner_fatal_source"), "none");
    assert_eq!(report_tag_of(&tags, "runner_report_read"), "report_absent");
}

#[test]
fn watcher_busy_exit_identifies_runner_and_owner_lease_result() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(20),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        Some("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=123, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting."),
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );

    let capture = effects.captures.first().expect("watcher exit capture");
    assert_eq!(recorded_tag(capture, "stderr_cause"), "already_owned");
    assert_eq!(recorded_tag(capture, "watch_owner_result"), "busy");
    assert_eq!(recorded_tag(capture, "exit_producer"), "runner");
    assert_eq!(recorded_tag(capture, "exit_class"), "already_owned");
    assert_eq!(recorded_tag(capture, "runner_fatal_class"), "none");
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_owner"),
        "hq-daemon"
    );
    assert_eq!(recorded_tag(capture, "watch_owner_holder_pid"), "123");
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_process"),
        "sync-runner"
    );
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_started_at"),
        "2026-10-04T08:10:11.123Z"
    );
    assert!(capture.message.starts_with("auto-sync watcher refused:"));
}

#[test]
fn watcher_exit_20_with_pre_holder_format_line_keeps_owner_and_pid() {
    // Runners published before hq-cloud #837 print only owner and pid. The
    // refusal must still classify, keep both fields, and report the fields it
    // does not carry as `unknown` rather than dropping the holder evidence.
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(hq_desktop_core::sync_outcome::RUNNER_ALREADY_OWNED_EXIT),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        Some("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=123); exiting."),
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );

    let capture = effects.captures.first().expect("watcher exit capture");
    assert_eq!(recorded_tag(capture, "exit_class"), "already_owned");
    assert_eq!(recorded_tag(capture, "stderr_cause"), "already_owned");
    assert_eq!(recorded_tag(capture, "watch_owner_result"), "busy");
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_owner"),
        "hq-daemon"
    );
    assert_eq!(recorded_tag(capture, "watch_owner_holder_pid"), "123");
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_process"),
        "unknown"
    );
    assert_eq!(
        recorded_tag(capture, "watch_owner_holder_started_at"),
        "unknown"
    );
    assert!(capture.message.starts_with("auto-sync watcher refused:"));
}

#[test]
fn watcher_exit_20_with_empty_stderr_stays_visible_as_already_owned() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(hq_desktop_core::sync_outcome::RUNNER_ALREADY_OWNED_EXIT),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );

    let capture = effects.captures.first().expect("exit 20 remains captured");
    assert_eq!(recorded_tag(capture, "exit_class"), "already_owned");
    assert_eq!(recorded_tag(capture, "runner_fatal_class"), "none");
    assert_eq!(recorded_tag(capture, "stderr_cause"), "already_owned");
    assert_eq!(recorded_tag(capture, "watch_owner_result"), "busy");
    assert_eq!(recorded_tag(capture, "exit_producer"), "runner");
    assert!(capture.message.starts_with("auto-sync watcher refused:"));
    assert!(!capture
        .tags
        .iter()
        .any(|(key, _)| key.starts_with("watch_owner_holder_")));
}

#[test]
fn watcher_lease_lost_exit_identifies_runner_and_lost_result() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(21),
        None,
        false,
        false,
        "/opt/homebrew/bin/npx",
        Some("[sync] watch-owner lease lost; stopping watch runner: fixture detail"),
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );

    let capture = effects.captures.first().expect("watcher exit capture");
    assert_eq!(recorded_tag(capture, "stderr_cause"), "owner_lease_lost");
    assert_eq!(recorded_tag(capture, "watch_owner_result"), "lost");
    assert_eq!(recorded_tag(capture, "exit_producer"), "runner");
    assert!(capture
        .tags
        .iter()
        .all(|(_, value)| !value.contains("fixture detail")));
}

#[test]
fn watcher_node_report_exposes_only_safe_error_identity_and_frame() {
    let report = hq_desktop_core::runner_diagnostic_report::parse_runner_diagnostic_report(
        serde_json::json!({
            "header": {
                "trigger": "Exception",
                "event": "Uncaught Error [ERR_MODULE_NOT_FOUND]: PRIVATE_MESSAGE_MARKER",
                "commandLine": [
                    "/opt/node/bin/node",
                    "/Users/alice/.npm/_npx/private/node_modules/@indigoai-us/hq-cloud/dist/bin/sync-runner.js",
                    "--watch"
                ]
            },
            "javascriptStack": {
                "message": "Uncaught Error [ERR_MODULE_NOT_FOUND]: PRIVATE_MESSAGE_MARKER",
                "stack": [{
                    "functionName": "privateFunction",
                    "scriptName": "/Users/alice/hq/secrets/private-file.js",
                    "lineNumber": 23,
                    "column": 17
                }]
            },
            "nativeStack": []
        })
        .to_string()
        .as_bytes(),
    );
    let mut tags = report_tags_with_class("none");
    set_payload_tag(&mut tags, "exit_producer", "unknown".to_string());
    apply_report_to_fault_tags(&mut tags, &report);

    assert_eq!(
        report_tag_of(&tags, "node_error_code"),
        "ERR_MODULE_NOT_FOUND"
    );
    assert_eq!(report_tag_of(&tags, "node_error_name"), "Error");
    // A frame outside our packages and node: internals reports only
    // "external", so a user's file name never leaves the machine.
    assert_eq!(report_tag_of(&tags, "node_top_frame"), "external");
    assert!(!rendered_contains_private_file(&tags));
    assert_eq!(report_tag_of(&tags, "exit_producer"), "runner");
    let rendered = tags
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("PRIVATE_MESSAGE_MARKER"));
    assert!(!report_tag_of(&tags, "node_top_frame").contains('/'));
    assert!(!report_tag_of(&tags, "node_top_frame").contains('\\'));
    assert!(!rendered.contains("/Users/alice"));
}

fn rendered_contains_private_file(tags: &[(String, String)]) -> bool {
    tags.iter()
        .any(|(_, value)| value.contains("private-file") || value.contains("privateFunction"))
}

#[test]
fn read_runner_diagnostic_report_reads_then_deletes_the_directory() {
    let dir = unique_report_dir("read");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(hq_desktop_core::daemon::RUNNER_DIAGNOSTIC_REPORT_FILENAME),
        heap_oom_report_json(),
    )
    .unwrap();
    let report = read_runner_diagnostic_report(&dir);
    assert_eq!(
        report.read,
        hq_desktop_core::runner_diagnostic_report::RunnerReportRead::Read
    );
    assert_eq!(report.fatal_class.as_str(), "heap_oom");
    // The reader removed the directory after reading, bounding disk.
    assert!(
        !dir.exists(),
        "report directory must be removed after the read"
    );
}

#[test]
fn read_runner_diagnostic_report_reports_absent_for_an_empty_dir() {
    let dir = unique_report_dir("empty");
    std::fs::create_dir_all(&dir).unwrap();
    let report = read_runner_diagnostic_report(&dir);
    assert_eq!(
        report.read,
        hq_desktop_core::runner_diagnostic_report::RunnerReportRead::Absent
    );
    assert!(!dir.exists());
}

#[test]
fn prune_stale_runner_report_siblings_keeps_current_and_one_prior() {
    // A route directory with three prior-generation siblings plus the current
    // one: the current dir is never pruned, and exactly ONE prior sibling (the
    // newest — the only one that could still have a deferred read pending)
    // survives, so leaks cannot accumulate.
    let base = unique_report_dir("prune");
    let current = base.join("current");
    let priors = [base.join("g1"), base.join("g2"), base.join("g3")];
    std::fs::create_dir_all(&current).unwrap();
    for prior in &priors {
        std::fs::create_dir_all(prior).unwrap();
    }
    prune_stale_runner_report_siblings(&current);
    assert!(current.exists(), "the current directory is never pruned");
    let survivors = priors.iter().filter(|prior| prior.exists()).count();
    assert_eq!(
        survivors, 1,
        "exactly the newest prior sibling survives; the rest are pruned"
    );
    let _ = std::fs::remove_dir_all(&base);
}

// ── Deferred runner-report capture wiring (HQ-DESKTOP-66) ──

#[test]
fn non_fault_watcher_exit_reads_and_applies_the_report_off_the_exit_path() {
    // The 0xFFFFFFFF indeterminate-status case: a report WAS requested but the exit
    // is non-fault, so the Windows-fault worker never runs. The capture's SEND is
    // deferred to a bounded worker that READS the report OFF the exit callback and
    // applies its measured verdict — runner_report_read becomes report_read, and the
    // report's class is adopted with runner_fatal_source=node_report because the
    // stderr channel named nothing. The capture is NOT sent immediately.
    reset_pending_runner_report_registry_for_test();
    let dir = unique_report_dir("nonfault-read");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(hq_desktop_core::daemon::RUNNER_DIAGNOSTIC_REPORT_FILENAME),
        heap_oom_report_json(),
    )
    .unwrap();
    let context = WatcherExitCaptureContext {
        runner_report_read: "report_absent".to_string(),
        runner_report_deferred_dir: Some(dir.clone()),
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    let disposition = handle_watcher_exit_with_effects(
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
    assert!(
        effects.captures.is_empty(),
        "a non-fault requested-report exit must NOT send on the exit path"
    );
    let held = effects
        .deferred_runner_report
        .first()
        .expect("non-fault capture deferred for its report read");
    assert_eq!(recorded_tag(held, "runner_report_read"), "report_read");
    assert_eq!(recorded_tag(held, "runner_fatal_class"), "heap_oom");
    assert_eq!(recorded_tag(held, "runner_fatal_source"), "node_report");
    assert_eq!(recorded_tag(held, "runner_stack_signature").len(), 16);
    // The stable class is computed before the deferred report read; the raw
    // Windows status remains in the message and windows_exit_status tag.
    assert_eq!(held.fingerprint, vec!["sync-watcher-exit", "minus_one"]);
    assert_eq!(recorded_tag(held, "exit_class"), "minus_one");
    assert!(held.message.contains("0xFFFFFFFF (origin unknown)"));
    // The deferred reader OWNS the directory and removed it after reading.
    assert_eq!(
        disposition,
        RunnerReportDirDisposition::OwnedByDeferredReader
    );
    assert!(
        !dir.exists(),
        "the report directory is removed after the read"
    );
}

#[test]
fn non_fault_watcher_exit_records_a_measured_absence_when_no_report_exists() {
    // Requested-and-absent: the token now provably comes from a PERFORMED read (the
    // directory is removed) rather than the pre-read seed — the exact ambiguity this
    // lane closed, since "requested, never read" and "read, missing" both emitted
    // report_absent on the base.
    reset_pending_runner_report_registry_for_test();
    let dir = unique_report_dir("nonfault-absent");
    std::fs::create_dir_all(&dir).unwrap();
    let context = WatcherExitCaptureContext {
        runner_report_read: "report_absent".to_string(),
        runner_report_deferred_dir: Some(dir.clone()),
        ..Default::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    let disposition = handle_watcher_exit_with_effects(
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
    let held = effects
        .deferred_runner_report
        .first()
        .expect("non-fault capture deferred for its report read");
    assert_eq!(recorded_tag(held, "runner_report_read"), "report_absent");
    assert_eq!(recorded_tag(held, "runner_fatal_class"), "none");
    assert!(
        !dir.exists(),
        "a performed read removes the directory even when the report is absent"
    );
    assert_eq!(
        disposition,
        RunnerReportDirDisposition::OwnedByDeferredReader
    );
}

#[test]
fn a_report_never_overrides_a_stderr_named_class_on_the_non_fault_path() {
    // A stderr-derived class already named the cause: the report records its read
    // provenance but NEVER overrides the class or source, exactly as on the fault
    // path and the manual route.
    reset_pending_runner_report_registry_for_test();
    let dir = unique_report_dir("nonfault-precedence");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(hq_desktop_core::daemon::RUNNER_DIAGNOSTIC_REPORT_FILENAME),
        heap_oom_report_json(),
    )
    .unwrap();
    let context = WatcherExitCaptureContext {
        runner_fatal_class: "libuv_assert".to_string(),
        runner_report_deferred_dir: Some(dir.clone()),
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
    let held = effects
        .deferred_runner_report
        .first()
        .expect("non-fault capture deferred for its report read");
    assert_eq!(recorded_tag(held, "runner_report_read"), "report_read");
    assert_eq!(recorded_tag(held, "runner_fatal_class"), "libuv_assert");
    assert_eq!(recorded_tag(held, "runner_fatal_source"), "stderr");
}

#[test]
fn a_not_requested_non_fault_exit_sends_immediately_and_cleans_on_the_exit_path() {
    // No report requested: the capture is sent immediately (no read to await) and
    // the exit callback owns any directory cleanup.
    let context = WatcherExitCaptureContext::default();
    let mut effects = RecordingWatcherEffects::default();
    let disposition = handle_watcher_exit_with_effects(
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
    assert!(effects.deferred_runner_report.is_empty());
    assert_eq!(disposition, RunnerReportDirDisposition::DeleteOnExitPath);
}

#[test]
fn watcher_exit_emits_the_job_survivor_discriminator() {
    // Always present on a captured watcher exit: `unavailable` (no count) when no
    // live-PID query ran, and a named token + bare count when it did — the
    // shim-vs-runner discriminator for the 0xFFFFFFFF exit shape.
    let context = WatcherExitCaptureContext::default();
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
    let event = effects.captures.first().expect("immediate capture");
    assert_eq!(recorded_tag(event, "watcher_job_survivors"), "unavailable");
    assert!(
        event
            .extras
            .iter()
            .all(|(key, _)| key != "watcher_job_survivor_count"),
        "no count extra is emitted when the live-PID query did not run"
    );

    let context = WatcherExitCaptureContext {
        watcher_job_survivors: "node_exe".to_string(),
        watcher_job_survivor_count: Some(2),
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
    let event = effects.captures.first().expect("immediate capture");
    assert_eq!(recorded_tag(event, "watcher_job_survivors"), "node_exe");
    assert_eq!(
        recorded_number_extra(event, "watcher_job_survivor_count"),
        2
    );
}

#[test]
fn deferred_runner_report_registry_resolves_each_capture_exactly_once() {
    // The registry mirrors the fault registry: a teardown flush drains an in-flight
    // capture, the worker's later claim is then a no-op, and a registration that
    // arrives AFTER the latch is handed back to send immediately.
    reset_pending_runner_report_registry_for_test();
    let payload = DeferredRunnerReportCapture::new(
        "auto-sync watcher exited unexpectedly",
        &["sync"],
        &[("runner_report_read", "report_absent".to_string())],
        &[],
        unique_report_dir("registry"),
    );
    let id = register_pending_runner_report_capture(payload).expect("queued");
    let drained = arm_shutdown_and_drain_pending_runner_report_captures();
    assert_eq!(drained.len(), 1, "the flush drained the in-flight capture");
    assert!(
        take_pending_runner_report_capture(id).is_none(),
        "the worker's later claim is a no-op once the flush drained it"
    );

    reset_pending_runner_report_registry_for_test();
    // Arm the shutdown latch, then prove a later registration is handed back.
    let _ = arm_shutdown_and_drain_pending_runner_report_captures();
    let payload = DeferredRunnerReportCapture::new(
        "auto-sync watcher exited unexpectedly",
        &["sync"],
        &[],
        &[],
        unique_report_dir("registry2"),
    );
    assert!(
        register_pending_runner_report_capture(payload).is_err(),
        "a registration after the shutdown latch is handed back for immediate send"
    );
    reset_pending_runner_report_registry_for_test();
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
            report_dir: None,
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
    assert_eq!(
        recorded_tag(held, "watcher_fault_faulting_image"),
        "unavailable"
    );
    assert_eq!(
        recorded_tag(held, "watcher_fault_read"),
        "seen:0,parsed:0,stale:0,rej_win:0,rej_code:0,sweeps:0,ms:0"
    );
    assert_eq!(
        recorded_tag(held, "watcher_fault_job_images"),
        "node_exe,cmd_exe"
    );
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
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
            &["sync-watcher-exit", "stack_buffer_overrun"],
            &[("watcher_fault_provenance", "deferred".to_string())],
            &[],
            WatcherFaultDeferredRead {
                sampled_pids: vec![],
                exception_code: 0xC000_0409,
                gen_start_ms: 0,
                gen_end_ms: 1,
                report_dir: None,
            },
        )
    };
    let first = register_pending_watcher_fault_capture(make());
    let second = register_pending_watcher_fault_capture(make());
    assert!(
        first.is_ok() && second.is_ok(),
        "registrations queue before shutdown"
    );
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
            &["sync-watcher-exit", "stack_buffer_overrun"],
            &[("watcher_fault_provenance", "deferred".to_string())],
            &[],
            WatcherFaultDeferredRead {
                sampled_pids: vec![],
                exception_code: 0xC000_0409,
                gen_start_ms: 0,
                gen_end_ms: 1,
                report_dir: None,
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
        &["sync-watcher-exit", "stack_buffer_overrun"],
        &[
            ("watcher_fault_provenance", "deferred".to_string()),
            ("watcher_fault_faulting_image", "unavailable".to_string()),
            (
                "watcher_fault_read",
                "seen:0,parsed:0,stale:0,rej_win:0,rej_code:0,sweeps:0,ms:0".to_string(),
            ),
        ],
        &[],
        WatcherFaultDeferredRead {
            sampled_pids: vec![6700],
            exception_code: 0xC000_0409,
            gen_start_ms: 1_000_000,
            gen_end_ms: 1_001_000,
            report_dir: None,
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
    let resolved =
        attribute_watcher_fault(&[record], &[6700], 1_000_000, 1_001_000, Some(0xC000_0409));
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
    assert_eq!(
        recorded_tag(capture, "runner_assert_source"),
        "libuv_win_async"
    );
    let signature = recorded_tag(capture, "runner_assert_signature");
    assert_eq!(signature.len(), 16);
    assert!(signature.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(recorded_number_extra(capture, "runner_assert_line"), 76);
    assert_eq!(
        recorded_number_extra(capture, "runner_stdout_line_count"),
        5
    );
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
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "sigkill"]);
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
                        let record =
                            cancellation_record_for_generation(DAEMON_HANDLE, daemon_generation);
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
        clear_cancellation_record_for_test, deregister_process, seed_cancellation_record_for_test,
        SpawnArgs,
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
                        let record =
                            cancellation_record_for_generation(DAEMON_HANDLE, daemon_generation);
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
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "sigkill"]);
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
fn posix_watcher_code_one_after_effective_app_cancellation_is_attributed_to_app_teardown() {
    // HQ-DESKTOP-5Z blast radius. The watcher boundary projects the SAME
    // classifier as the manual route, so a watcher torn down by the app whose
    // child collapsed our SIGTERM into exit 1 is now attributed to the app
    // (the silent teardown path at `handle_watcher_exit_with_effects`), exactly
    // when the manual route suppresses it — an app-owned cause, an observed
    // effective termination, and no alertable runner error. This is the same
    // correct intent, kept from drifting from the manual boundary.
    let effective = WatcherExitCaptureContext {
        cancellation_record_present: true,
        cancellation_record_cause: Some(SyncCancelCause::HeartbeatStall),
        cancellation_termination_effected: true,
        saw_alertable_error: false,
        ..Default::default()
    };
    assert!(
        effective.attributed_to_app_teardown(Some(1), None),
        "an effective app cancellation whose child exited code 1 is a silent teardown"
    );

    // Strip the effectiveness gate: an external kill / lost publication of the
    // identical code-1 shape must stay alertable — the invariant that keeps
    // external kills loud, unchanged by this fix.
    let ineffective = WatcherExitCaptureContext {
        cancellation_record_present: true,
        cancellation_record_cause: Some(SyncCancelCause::HeartbeatStall),
        cancellation_termination_effected: false,
        saw_alertable_error: false,
        ..Default::default()
    };
    assert!(
        !ineffective.attributed_to_app_teardown(Some(1), None),
        "termination_effected=false keeps a code-1 watcher exit alertable"
    );

    // A concurrent alertable runner fault also wins over attribution (gate 4),
    // preserving the cancelled-with-alertable-error class.
    let with_alertable = WatcherExitCaptureContext {
        cancellation_record_present: true,
        cancellation_record_cause: Some(SyncCancelCause::HeartbeatStall),
        cancellation_termination_effected: true,
        saw_alertable_error: true,
        ..Default::default()
    };
    assert!(
        !with_alertable.attributed_to_app_teardown(Some(1), None),
        "a concurrent alertable runner fault keeps a code-1 watcher exit alertable"
    );
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
        vec!["sync-watcher-exit", "sigkill"]
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
        runner_error_sites: totals.runner_error_sites.tag_value(),
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
    // The SITE axis reaches parity too (HQ-DESKTOP-5M): same rollup, same tag.
    assert_eq!(
        recorded_tag(event, "runner_error_sites"),
        "file:160,company:8"
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
        vec!["sync-watcher-exit", "minus_one"]
    );
    assert!(event.message.contains("0xFFFFFFFF (origin unknown)"));
    assert!(!event.message.contains("code=Some(-1)"));
}

#[test]
fn every_runner_error_class_fingerprint_token_survives_the_watcher_validator() {
    // The r2 regression this closes: the enum gained Enoent/Eexist/Enotempty/
    // Exdev but the old hand-written allow-list did not, so those four classes
    // degraded to "none" on the watcher route — the same token an error-free
    // pass emits. The validator is now derived from RunnerErrorClass::ALL, so
    // EVERY class token survives unchanged. This is the test whose absence let
    // the r2 degradation ship.
    for class in RunnerErrorClass::ALL {
        let token = class.fingerprint_token();
        assert_eq!(
            safe_runner_error_fingerprint_token(token),
            token,
            "class token {token:?} must survive the watcher validator unchanged"
        );
    }
    assert_eq!(safe_runner_error_fingerprint_token("none"), "none");
}

#[test]
fn every_runner_error_cause_fingerprint_token_survives_the_watcher_validator() {
    // The same completeness guarantee for the new cause axis over
    // RunnerErrorCause::ALL, so a future cause can never silently degrade to
    // "none" on the watcher route.
    for cause in RunnerErrorCause::ALL {
        let token = cause.as_str();
        assert_eq!(
            safe_runner_error_cause_fingerprint_token(token),
            token,
            "cause token {token:?} must survive the watcher validator unchanged"
        );
    }
    assert_eq!(safe_runner_error_cause_fingerprint_token("none"), "none");
}

#[test]
fn an_unrecognised_token_still_degrades_to_none() {
    // Fail-closed: anything not enum-owned (a raw path, host, message fragment,
    // or a plausible-but-unlisted token) degrades to "none" on both axes, so a
    // future caller cannot place a runner byte in a Sentry fingerprint through
    // a manually-constructed context.
    for bad in [
        "/Users/Ada/secret",
        "eperm ",
        "vault_permission_deniedX",
        "AUTH",
        "",
        "http_403",
    ] {
        assert_eq!(safe_runner_error_fingerprint_token(bad), "none", "{bad:?}");
        assert_eq!(
            safe_runner_error_cause_fingerprint_token(bad),
            "none",
            "{bad:?}"
        );
    }
}

#[test]
fn the_watcher_termination_fingerprint_stays_stable_when_cause_tags_change() {
    // Watcher grouping uses only the exit class. Runner-error cause remains
    // available as an aggregatable diagnostic tag, without splitting issues.
    let context = WatcherExitCaptureContext {
        runner_error_rollup: Some("AUTH:1".to_string()),
        runner_error_class: "auth",
        runner_error_cause: "vault_permission_denied",
        runner_error_causes: Some("vault_permission_denied:1".to_string()),
        runner_error_companies: 1,
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
    assert_eq!(
        effects.captures[0].fingerprint,
        vec!["sync-watcher-exit", "minus_one"]
    );
}

#[test]
fn the_watcher_termination_fingerprint_stays_stable_when_site_tags_change() {
    use crate::events::SyncErrorEvent;
    // Runner failure SITE remains available as an aggregatable tag, without
    // adding a path-shaped grouping axis to watcher events.
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(local-state)".to_string(),
        message: "journal state store is unreadable".to_string(),
    });
    let context = WatcherExitCaptureContext {
        runner_error_rollup: totals.runner_error_rollup.tag_value(),
        runner_error_class: totals.runner_error_rollup.fingerprint_token(),
        runner_error_cause: totals.runner_error_causes.fingerprint_token(),
        runner_error_site: totals.runner_error_sites.fingerprint_token(),
        runner_error_causes: totals.runner_error_causes.tag_value(),
        runner_error_sites: totals.runner_error_sites.tag_value(),
        runner_error_scope: totals.runner_error_scope(),
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
    // Site and scope diagnostics remain available outside the stable fingerprint.
    assert_eq!(recorded_tag(event, "runner_error_sites"), "local_state:1");
    assert_eq!(
        recorded_string_extra(event, "runner_error_scope"),
        "company:0,file:0,local_state:1"
    );
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "minus_one"]);
}

#[test]
fn the_watcher_fingerprint_carries_a_new_errno_class_not_none() {
    // The r2 watcher-seam degradation, closed end to end: an ENOENT fault whose
    // class token is "enoent" must survive the enum-derived validator and reach
    // the fingerprint, not silently collapse to the error-free "none".
    let context = WatcherExitCaptureContext {
        runner_error_rollup: Some("ENOENT:1".to_string()),
        runner_error_class: "enoent",
        runner_error_cause: "enoent",
        runner_error_causes: Some("enoent:1".to_string()),
        runner_error_companies: 1,
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
    assert_eq!(
        effects.captures[0].fingerprint,
        vec!["sync-watcher-exit", "minus_one"]
    );
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
        vec!["sync-watcher-exit", "minus_one"]
    );
    assert_eq!(
        effects.captures[1].fingerprint,
        vec!["sync-watcher-exit", "minus_one"]
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
        vec!["sync-watcher-exit", "dbg_terminate"]
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

/// HQ-DESKTOP-4N / HQ-DESKTOP-5J. The deferral still happens for all three
/// unattributed readings and the held-back payload is byte-identical to what
/// an immediate capture would have sent — that half is unchanged. What the
/// HQ-DESKTOP-5J fix adds: because a `DBG_TERMINATE_PROCESS` exit is an
/// externally-supplied termination, not a watcher fault, the deferral no
/// longer advances the consecutive-failure streak or arms respawn backoff, and
/// reports a clean Stopped/None lifecycle. The drop-first / escalate-second
/// disposition itself is proven at the resolver (see the resolve tests) and
/// end-to-end below.
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

        // Step 4a (restated contract): an OS-supplied session-terminate is not
        // a watcher failure. The held payload is still byte-identical to an
        // immediate capture (asserted above), but the deferral now reports a
        // clean Stopped/None lifecycle and does NOT advance the
        // consecutive-failure streak or arm respawn backoff.
        assert_eq!(
            effects.lifecycle,
            vec![(WatchDaemonState::Stopped, DaemonFailureCategory::None)],
            "{attribution:?} changed the lifecycle transition"
        );
        assert_eq!(
            effects.consecutive, 0,
            "{attribution:?} must not advance the consecutive-failure streak"
        );
        assert!(
            !effects.in_backoff,
            "{attribution:?} must not arm respawn backoff"
        );
        assert!(
            effects.logs.iter().any(|(_, message)| message
                .starts_with("session-terminate watcher exit #1 — capture deferred")),
            "{attribution:?} must record the deferral locally"
        );
    }
}

/// The fail-closed half of the same decision, updated for HQ-DESKTOP-5J: a
/// grace that elapses without a message AND without a probe confirmation
/// DROPS the first such exit per app run (the benign sign-out shape) and only
/// sends a repeat. Positive evidence still drops regardless.
#[test]
fn a_deferral_that_is_never_affirmed_drops_the_first_and_sends_a_repeat() {
    let payload = || {
        DeferredSessionEndCapture::new(
            "auto-sync watcher exited unexpectedly",
            &["sync-watcher-exit", "dbg_terminate"],
            &[(
                "windows_terminator",
                WindowsTerminatorAttribution::UnattributedNoSignal
                    .class_name()
                    .to_string(),
            )],
            &[],
        )
    };

    // With no probe confirmation (Unknown) the FIRST unconfirmed exit per app
    // run stays silent; a REPEAT (count >= 2) still reaches Sentry after the
    // grace, so a genuinely repeating external killer is never lost.
    for attribution in [
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        WindowsTerminatorAttribution::ObserverFailed,
        WindowsTerminatorAttribution::ObserverUnavailable,
    ] {
        assert_eq!(
            deferred_session_end_outcome(
                attribution,
                WindowsTeardownVerdict::Unknown,
                SessionEndLatchReading::Absent,
                1
            ),
            DeferredSessionEndOutcome::Drop,
            "{attribution:?}: the first unconfirmed per run stays silent"
        );
        assert_eq!(
            deferred_session_end_outcome(
                attribution,
                WindowsTeardownVerdict::Unknown,
                SessionEndLatchReading::Absent,
                2
            ),
            DeferredSessionEndOutcome::Capture,
            "{attribution:?}: a repeat must still reach Sentry after the grace"
        );
    }
    // Positive evidence drops regardless of the run count: an observed
    // message, a probe that confirmed the teardown, or a contemporaneous
    // latch. (`2` here proves it drops even where a repeat would otherwise
    // escalate.)
    assert_eq!(
        deferred_session_end_outcome(
            WindowsTerminatorAttribution::SessionEndObserved,
            WindowsTeardownVerdict::Unknown,
            SessionEndLatchReading::Absent,
            2
        ),
        DeferredSessionEndOutcome::Drop
    );
    assert_eq!(
        deferred_session_end_outcome(
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTeardownVerdict::Confirmed,
            SessionEndLatchReading::Absent,
            2
        ),
        DeferredSessionEndOutcome::Drop
    );
    // r3: a contemporaneous latch drops even an observer-fault reading with
    // an unknown probe — the case the recurrence would now suppress.
    assert_eq!(
        deferred_session_end_outcome(
            WindowsTerminatorAttribution::ObserverFailed,
            WindowsTeardownVerdict::Unknown,
            SessionEndLatchReading::Latched,
            2
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
        SessionEndLatchReading::Absent,
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
            // r3: the latch was consulted at resolution and held nothing.
            (
                "session_end_latch".to_string(),
                sentry::protocol::Value::String("absent".to_string())
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
        SessionEndLatchReading::Absent,
        // A repeat unconfirmed exit escalates (Capture); the first-per-run drop
        // is proved by the pure outcome matrix and the resolver test below.
        2,
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
        SessionEndLatchReading::Absent,
    );
    assert_eq!(
        recorded_string_tag(&sent, "windows_terminator"),
        "unattributed_no_teardown"
    );
    assert_eq!(
        recorded_deferred_extra(&sent, "session_end_latch"),
        "absent"
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
    let resolution =
        resolve_deferred_decision(Some(reading), confirmed, SessionEndLatchReading::Absent, 2);
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
    let resolution = resolve_deferred_decision(
        Some(reading),
        confirmed_by_log,
        SessionEndLatchReading::Absent,
        2,
    );
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
    let resolution = resolve_deferred_decision(
        Some(reading),
        initiation_only,
        SessionEndLatchReading::Absent,
        // A repeat unconfirmed exit escalates; the first-per-run drop is proved
        // by the pure outcome matrix and the end-to-end resolver test.
        2,
    );
    assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Capture);
    assert_eq!(resolution.verdict, WindowsTeardownVerdict::Unknown);

    // An observer that could not be consulted at all still fails closed even
    // with a confirmed teardown when there is no latch: nothing to rename, so
    // it sends.
    let resolution = resolve_deferred_decision(None, confirmed, SessionEndLatchReading::Absent, 2);
    assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Capture);
    assert_eq!(resolution.final_attribution, None);

    // r3: but a contemporaneous latch suppresses even with no observer reading
    // at all, and names itself so the suppressed alert carries a suppressing
    // tag — the durable evidence survives the observer's death.
    let resolution =
        resolve_deferred_decision(None, initiation_only, SessionEndLatchReading::Latched, 2);
    assert_eq!(resolution.outcome, DeferredSessionEndOutcome::Drop);
    assert_eq!(
        resolution.final_attribution,
        Some(WindowsTerminatorAttribution::SessionEndLatched)
    );
}

/// The r3 recurrence, replayed at the resolver: an `ObserverFailed` reading
/// (event 5bcd8d2aa8c047768419f18613426a59) resolved three ways. The latch
/// suppresses; a probe-confirmed teardown suppresses as `session_end_probed`;
/// and a verifiably-absent teardown with no latch SENDS with the honest
/// `observer_failed` tag intact — so every non-suppressed alert stays labelled
/// with which link failed.
#[test]
fn the_observer_failed_recurrence_resolves_by_latch_probe_or_honest_send() {
    let reading = SessionEndReading {
        attribution: WindowsTerminatorAttribution::ObserverFailed,
        readiness: "failed",
    };
    let absent = WindowsTeardownProbeReading {
        shuttingdown_at_exit: TeardownShuttingDown::No,
        shuttingdown_at_resolve: TeardownShuttingDown::No,
        log: TeardownLogReading::None,
    };
    let confirmed = WindowsTeardownProbeReading {
        shuttingdown_at_exit: TeardownShuttingDown::Yes,
        shuttingdown_at_resolve: TeardownShuttingDown::No,
        log: TeardownLogReading::None,
    };

    // (1) latch set -> suppressed and named session_end_latched.
    let latched =
        resolve_deferred_decision(Some(reading), absent, SessionEndLatchReading::Latched, 2);
    assert_eq!(latched.outcome, DeferredSessionEndOutcome::Drop);
    assert_eq!(
        latched.final_attribution,
        Some(WindowsTerminatorAttribution::SessionEndLatched)
    );

    // (2) no latch, probe Confirmed -> suppressed and named session_end_probed.
    let probed =
        resolve_deferred_decision(Some(reading), confirmed, SessionEndLatchReading::Absent, 2);
    assert_eq!(probed.outcome, DeferredSessionEndOutcome::Drop);
    assert_eq!(
        probed.final_attribution,
        Some(WindowsTerminatorAttribution::SessionEndProbed)
    );

    // (3) no latch, probe Absent -> a REPEAT SENDS, tag stays the honest
    // observer_failed. (The first per run drops; proved by the outcome matrix.)
    let sent = resolve_deferred_decision(Some(reading), absent, SessionEndLatchReading::Absent, 2);
    assert_eq!(sent.outcome, DeferredSessionEndOutcome::Capture);
    assert_eq!(
        sent.final_attribution,
        Some(WindowsTerminatorAttribution::ObserverFailed)
    );
    // The finalized payload carries the honest latch extra alongside it.
    let payload = DeferredSessionEndCapture::new(
        "auto-sync watcher exited unexpectedly",
        &["sync-watcher-exit", "dbg_terminate"],
        &[("windows_terminator", "observer_failed".to_string())],
        &[],
    );
    let finalized = finalize_deferred_session_end_payload(
        payload,
        sent.final_attribution,
        SESSION_END_GRACE_MS,
        "failed",
        "grace_elapsed",
        sent.verdict,
        absent,
        SessionEndLatchReading::Absent,
    );
    assert_eq!(
        recorded_string_tag(&finalized, "windows_terminator"),
        "observer_failed"
    );
    assert_eq!(
        recorded_deferred_extra(&finalized, "session_end_latch"),
        "absent"
    );
}

/// HQ-DESKTOP-5J core contract at the resolver: the reported envelope
/// (DBG_TERMINATE_PROCESS, observer alive but saw nothing, probe verifiably
/// absent, no latch) DROPS on its first per-run occurrence — the ordinary
/// Windows sign-out — and ESCALATES only on a repeat within the same app run,
/// under the same stable exit-class fingerprint with a re-titled message.
#[test]
fn an_unconfirmed_session_terminate_drops_first_then_escalates_within_a_run() {
    let reading = SessionEndReading {
        attribution: WindowsTerminatorAttribution::UnattributedNoSignal,
        readiness: "registered",
    };
    let absent = WindowsTeardownProbeReading {
        shuttingdown_at_exit: TeardownShuttingDown::No,
        shuttingdown_at_resolve: TeardownShuttingDown::No,
        log: TeardownLogReading::None,
    };

    // First unconfirmed exit this run: DROP, but the honest tag is still named.
    let first = resolve_deferred_decision(Some(reading), absent, SessionEndLatchReading::Absent, 1);
    assert_eq!(first.outcome, DeferredSessionEndOutcome::Drop);
    assert_eq!(first.verdict, WindowsTeardownVerdict::Absent);
    assert_eq!(
        first.final_attribution,
        Some(WindowsTerminatorAttribution::UnattributedNoTeardown)
    );

    // Second unconfirmed exit this run: ESCALATE in the message and tags,
    // while preserving the stable two-part fingerprint.
    let second =
        resolve_deferred_decision(Some(reading), absent, SessionEndLatchReading::Absent, 2);
    assert_eq!(second.outcome, DeferredSessionEndOutcome::Capture);

    // The escalation re-titles the held payload but leaves the stable exit
    // class grouping key unchanged.
    let held = DeferredSessionEndCapture::new(
        "auto-sync watcher exited unexpectedly (0x40010004 (session terminate)), \
             consecutive failure #1",
        &["sync-watcher-exit", "dbg_terminate"],
        &[("windows_terminator", "unattributed_no_signal".to_string())],
        &[],
    );
    let escalated = escalated_session_terminate_payload(held, 2);
    assert_eq!(
        escalated.fingerprint,
        vec!["sync-watcher-exit", "dbg_terminate"],
        "the escalation retains the stable exit-class fingerprint"
    );
    assert!(escalated.message.contains("2 times in one app run"));
    assert!(escalated.message.contains("not a sign-out"));
    assert!(!escalated.message.contains("consecutive failure"));
}

/// The per-app-run unconfirmed counter: it starts at zero (app/process start),
/// advances only on an unconfirmed session-terminate resolution, resets on a
/// confirmed session end, and resets on any ordinary watcher crash — and its
/// escalation predicate stays bounded to milestones so a repeating killer
/// alerts on 2, 4, 8 … rather than on every repeat.
#[test]
fn the_session_terminate_run_counter_advances_resets_and_bounds_escalation() {
    use hq_desktop_core::sync_outcome::unconfirmed_session_terminate_escalates;
    let _serial = GUARD_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    {
        let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
        *st = WatcherCrashState::default();
    }
    // App start: the first unconfirmed exit is silent, a second escalates.
    assert_eq!(bump_session_terminate_unconfirmed_run(), 1);
    assert!(!unconfirmed_session_terminate_escalates(1));
    assert_eq!(bump_session_terminate_unconfirmed_run(), 2);
    assert!(unconfirmed_session_terminate_escalates(2));
    // A confirmed session end resets the run.
    reset_session_terminate_unconfirmed_run();
    assert_eq!(bump_session_terminate_unconfirmed_run(), 1);
    assert!(!unconfirmed_session_terminate_escalates(1));
    // An ordinary watcher crash also breaks the run.
    note_watcher_crashed();
    {
        let st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            st.session_terminate_unconfirmed_run, 0,
            "an ordinary crash breaks the unconfirmed session-terminate run"
        );
    }
    // Past the second, escalation tracks the milestone limiter (never a loop).
    assert!(!unconfirmed_session_terminate_escalates(3));
    assert!(unconfirmed_session_terminate_escalates(4));
    {
        let mut st = crash_state().lock().unwrap_or_else(|e| e.into_inner());
        *st = WatcherCrashState::default();
    }
}

/// Step 4a end-to-end: a deferred session-terminate exit does NOT advance the
/// consecutive-failure streak or arm respawn backoff, while a genuine fault
/// exit still does.
#[test]
fn a_session_terminate_defer_does_not_advance_the_streak_but_a_fault_does() {
    const SESSION_TERMINATE: i32 = 1_073_807_364;
    let mut deferred = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut deferred,
        Some(SESSION_TERMINATE),
        None,
        false,
        false,
        "npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext {
            windows_terminator: Some(WindowsTerminatorAttribution::UnattributedNoSignal),
            ..Default::default()
        },
    );
    assert_eq!(
        deferred.deferred.len(),
        1,
        "the session-terminate still defers"
    );
    assert_eq!(
        deferred.consecutive, 0,
        "an OS-supplied termination must not advance the consecutive-failure streak"
    );
    assert!(
        !deferred.in_backoff,
        "an OS-supplied termination must not arm respawn backoff"
    );
    assert_eq!(
        deferred.lifecycle,
        vec![(WatchDaemonState::Stopped, DaemonFailureCategory::None)]
    );

    // A genuine fault exit (0xC0000409, STATUS_STACK_BUFFER_OVERRUN) still
    // advances the streak and arms backoff, so the guard does not go blind.
    let mut fault = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut fault,
        Some(0xC000_0409u32 as i32),
        None,
        false,
        false,
        "npx",
        None,
        current_termination_host(),
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(fault.captures.len(), 1, "a real fault still alerts");
    assert_eq!(fault.consecutive, 1, "a real fault advances the streak");
    assert!(fault.in_backoff, "a real fault arms respawn backoff");
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
            &["sync-watcher-exit", "dbg_terminate"],
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
        &["sync-watcher-exit", "dbg_terminate"],
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
        SessionEndLatchReading::Absent,
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
        "session_end_latch",
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
        &["sync-watcher-exit", "dbg_terminate"],
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
        SessionEndLatchReading::Absent,
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
        SessionEndLatchReading::Unavailable,
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
    // The app-quit flush consults nothing, so the latch reports unavailable —
    // exactly as the probe extras do on this path.
    assert_eq!(
        recorded_deferred_extra(&unread, "session_end_latch"),
        "unavailable"
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

/// r3 recurrence fix: an observer-fault reading on the session-terminate shape
/// must NO LONGER capture on the spot (the exact shape of recurrence event
/// 5bcd8d2aa8c047768419f18613426a59, windows_terminator=observer_failed). With
/// no contemporaneous latch it now DEFERS so the r2 probe and the latch get a
/// second look; with a latch it suppresses immediately.
#[test]
fn watcher_session_terminate_observer_fault_defers_and_a_latch_suppresses() {
    const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
    for attribution in [
        WindowsTerminatorAttribution::ObserverUnavailable,
        WindowsTerminatorAttribution::ObserverFailed,
    ] {
        // No latch: defer, do not send inline. The tag carried into the
        // deferral is the exit-time reading, resolved after the grace.
        let context = WatcherExitCaptureContext {
            windows_terminator: Some(attribution),
            session_end_latch: SessionEndLatchReading::Absent,
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
            "{attribution:?} must no longer send inline"
        );
        assert_eq!(
            effects.deferred.len(),
            1,
            "{attribution:?} must defer exactly one capture"
        );
        assert_eq!(
            effects.deferred[0]
                .tags
                .last()
                .map(|(_, value)| value.as_str()),
            Some(attribution.class_name())
        );

        // A contemporaneous latch is positive evidence: suppress immediately,
        // no send and no deferral, and self-diagnose as session_end_latched.
        let latched_context = WatcherExitCaptureContext {
            windows_terminator: Some(attribution),
            session_end_latch: SessionEndLatchReading::Latched,
            ..Default::default()
        };
        let mut latched_effects = RecordingWatcherEffects::default();
        handle_watcher_exit_with_effects(
            &mut latched_effects,
            Some(OBSERVED_SESSION_TERMINATE_EXIT),
            None,
            false,
            false,
            "npx",
            None,
            current_termination_host(),
            &latched_context,
        );
        assert!(
            latched_effects.captures.is_empty() && latched_effects.deferred.is_empty(),
            "{attribution:?} with a latch must suppress with no capture and no deferral"
        );
        assert!(
            latched_effects
                .logs
                .iter()
                .any(|(_, message)| message.starts_with("session-end-latched watcher exit")),
            "{attribution:?} with a latch must self-diagnose as session_end_latched"
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
        vec!["sync-watcher-exit", "dbg_terminate"]
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
        vec!["sync-watcher-exit", "dbg_terminate"]
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
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
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "other"]);
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
        *key == "runner_target_repair_attempted" && value == &sentry::protocol::Value::Bool(false)
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
        *key == "runner_target_repair_attempted" && value == &sentry::protocol::Value::Bool(true)
    }));

    // A non-exec exit that never emitted protocol from a direct executable
    // carries NO widened provenance (gate precision): neither 126/127 nor a
    // launcher-kind child.
    assert!(runner_exec_provenance_extras(Some(190), "/opt/homebrew/bin/node", &probed).is_none());
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
    assert_eq!(first.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(
        recorded_string_extra(first, "runner_exec_resolution"),
        "npx_cache"
    );
    assert_eq!(
        recorded_string_extra(first, "runner_exec_target_exists"),
        "false"
    );
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
    assert_eq!(fifth.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(recorded_number_extra(fifth, "exec_not_runnable_streak"), 4);
    assert_eq!(
        recorded_string_extra(fifth, "runner_exec_target_exists"),
        "false"
    );

    // #9 — a 127 leg at exec streak 8.
    assert!(
        ninth.message.contains("consecutive failure #9"),
        "{}",
        ninth.message
    );
    assert_eq!(ninth.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(recorded_number_extra(ninth, "exec_not_runnable_streak"), 8);
}

/// HQ-DESKTOP-4D base-red case. Ten consecutive SIGKILL slow deaths — each
/// generation outlived FAST_FAIL_WINDOW, so production pins `consecutive` at 1
/// forever (this is why all 1299 real events read "consecutive failure #1").
/// The episode streak must now rate-limit the flood to the 1,2,4,8 milestones
/// every other exit class already gets, and the emitted text must state the
/// TRUE episode length instead of a permanent #1. Fingerprint and the global
/// counter are unchanged, so grouping and respawn cadence do not move.
#[test]
fn slow_death_sigkill_loop_rate_limits_to_episode_milestones() {
    let mut effects = RecordingWatcherEffects {
        simulate_slow_death: true,
        ..RecordingWatcherEffects::default()
    };
    for _ in 0..10 {
        handle_watcher_exit_with_effects(
            &mut effects,
            None,
            Some(SIGKILL),
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
    }
    // Four captures — episode #1, #2, #4, #8 — not one per death.
    assert_eq!(
        effects.captures.len(),
        4,
        "slow-death loop must rate-limit to 1,2,4,8: {:?}",
        effects
            .captures
            .iter()
            .map(|capture| capture.message.clone())
            .collect::<Vec<_>>()
    );
    // The global counter stays pinned at 1 the whole episode (respawn cadence
    // is a function of `consecutive`, which the fix leaves untouched)...
    assert_eq!(effects.consecutive, 1);
    for capture in &effects.captures {
        assert!(
            capture.message.contains("consecutive failure #1"),
            "global counter must stay #1: {}",
            capture.message
        );
    }
    // ...while the honest episode length is rendered on every death past #1.
    assert!(
        !effects.captures[0].message.contains("episode failure"),
        "#1 needs no episode clause: {}",
        effects.captures[0].message
    );
    assert!(effects.captures[1].message.contains("(episode failure #2)"));
    assert!(effects.captures[2].message.contains("(episode failure #4)"));
    assert!(
        effects.captures[3].message.contains("(episode failure #8)"),
        "the tenth death must no longer read as a first failure: {}",
        effects.captures[3].message
    );
    // Grouping is stable: every captured SIGKILL keeps the signal:9 Capture
    // fingerprint, byte-identical across the episode.
    for capture in &effects.captures {
        assert_eq!(capture.fingerprint, vec!["sync-watcher-exit", "sigkill"]);
    }
}

/// The first occurrence of every fresh episode still alerts, even right after a
/// prior episode was muted — muting only ever applies to repeats WITHIN one
/// unbroken episode. Modelled by clearing the episode streak the way a
/// HEALTHY_RUN_WINDOW recovery does, then driving one more death.
#[test]
fn first_death_of_a_fresh_episode_always_captures() {
    let mut effects = RecordingWatcherEffects {
        simulate_slow_death: true,
        ..RecordingWatcherEffects::default()
    };
    // Episode A: three deaths capture at #1 and #2 only (#3 muted).
    for _ in 0..3 {
        handle_watcher_exit_with_effects(
            &mut effects,
            None,
            Some(SIGKILL),
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
    }
    assert_eq!(effects.captures.len(), 2, "episode A captures at #1, #2");
    // A genuinely healthy generation clears the episode streak (what
    // reset_crash_state_if_recovered does after HEALTHY_RUN_WINDOW).
    effects.slow_death_consecutive = 0;
    // Episode B: its very first death must alert again.
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGKILL),
        false,
        false,
        "npx",
        None,
        TerminationHost::Posix,
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(
        effects.captures.len(),
        3,
        "the first death of a fresh episode must capture"
    );
    assert!(!effects.captures[2].message.contains("episode failure"));
}

/// The episode streak clears only when a generation survives HEALTHY_RUN_WINDOW
/// (30m) — NOT the 60s FAST_FAIL_WINDOW a slow-death loop trivially outlives
/// every cycle. Both sides of the boundary, on the pure recovery predicate.
#[test]
fn healthy_run_window_governs_episode_streak_reset() {
    // Just short of the window keeps the streak; the fast-fail window does not.
    assert!(!should_reset_after_recovery(
        Some(HEALTHY_RUN_WINDOW - Duration::from_secs(1)),
        HEALTHY_RUN_WINDOW
    ));
    assert!(!should_reset_after_recovery(
        Some(FAST_FAIL_WINDOW),
        HEALTHY_RUN_WINDOW
    ));
    // Exactly the window, and beyond, clears it.
    assert!(should_reset_after_recovery(
        Some(HEALTHY_RUN_WINDOW),
        HEALTHY_RUN_WINDOW
    ));
    assert!(should_reset_after_recovery(
        Some(HEALTHY_RUN_WINDOW + Duration::from_secs(1)),
        HEALTHY_RUN_WINDOW
    ));
    // HEALTHY_RUN_WINDOW is the longest backoff the supervisor can impose, so a
    // generation that outlives it has genuinely recovered.
    assert_eq!(HEALTHY_RUN_WINDOW, RESPAWN_MAX_BACKOFF);
}

/// Failure classes stay isolated (Codex P2): a burst of LocalLogOnly
/// (disk/environmental) exits must NOT advance the episode streak, so the first
/// actionable SIGKILL after them still alerts at episode #1. With the streak
/// advanced on every exit this SIGKILL would land on #3 (a non-milestone) and be
/// silently muted — the exact regression this asserts against (fix → 1 capture,
/// pre-fix → 0).
#[test]
fn local_log_only_burst_does_not_mute_first_sigkill() {
    let mut effects = RecordingWatcherEffects {
        simulate_slow_death: true,
        ..RecordingWatcherEffects::default()
    };
    // Two environmental exits (exit code 1 → LocalLogOnly, breadcrumb-only)...
    for _ in 0..2 {
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(1),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
    }
    // ...then the first SIGKILL of the episode.
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGKILL),
        false,
        false,
        "npx",
        None,
        TerminationHost::Posix,
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "the LocalLogOnly burst must not capture and must not mute the SIGKILL"
    );
    assert_eq!(
        effects.captures[0].fingerprint,
        vec!["sync-watcher-exit", "sigkill"]
    );
    assert_eq!(recorded_tag(&effects.captures[0], "exit_class"), "sigkill");
    assert!(effects.captures[0]
        .message
        .contains("consecutive failure #1"));
    assert!(!effects.captures[0].message.contains("episode failure"));
}

/// The same isolation for the exec-not-runnable class: two 126/127 exits (exec
/// streak 1, 2 — below the 4-milestone so neither captures) must not advance the
/// episode streak, so the first SIGKILL still alerts at #1 (fix → 1 capture,
/// pre-fix → 0 because the SIGKILL would land on #3).
#[test]
fn exec_not_runnable_exits_do_not_mute_first_sigkill() {
    let mut effects = RecordingWatcherEffects {
        simulate_slow_death: true,
        ..RecordingWatcherEffects::default()
    };
    for _ in 0..2 {
        handle_watcher_exit_with_effects(
            &mut effects,
            Some(127),
            None,
            false,
            false,
            "npx",
            None,
            TerminationHost::Posix,
            &WatcherExitCaptureContext::default(),
        );
    }
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGKILL),
        false,
        false,
        "npx",
        None,
        TerminationHost::Posix,
        &WatcherExitCaptureContext::default(),
    );
    assert_eq!(
        effects.captures.len(),
        1,
        "the 126/127 exits must not capture (streak < 4) nor mute the SIGKILL"
    );
    assert_eq!(
        effects.captures[0].fingerprint,
        vec!["sync-watcher-exit", "sigkill"]
    );
    assert_eq!(recorded_tag(&effects.captures[0], "exit_class"), "sigkill");
    assert!(effects.captures[0]
        .message
        .contains("consecutive failure #1"));
}

/// A cancelled exit stays silent AND never touches the episode streak (it
/// returns before `note_watcher_crashed`), so a deliberate stop can never
/// advance the slow-death counter — the same early-return path an app-teardown
/// attribution takes, pinning the HQ-DESKTOP-4P invariant against the new
/// counter.
#[test]
fn cancelled_exit_never_touches_the_episode_streak() {
    let mut effects = RecordingWatcherEffects {
        simulate_slow_death: true,
        ..RecordingWatcherEffects::default()
    };
    // A cancelled SIGKILL: deliberate stop, no capture, streak untouched.
    handle_watcher_exit_with_effects(
        &mut effects,
        None,
        Some(SIGKILL),
        false,
        true, // cancelled
        "npx",
        None,
        TerminationHost::Posix,
        &WatcherExitCaptureContext::default(),
    );
    assert!(effects.captures.is_empty());
    assert_eq!(effects.slow_death_consecutive, 0, "cancel must not count");
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
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(
        recorded_string_extra(event, "runner_exec_resolution"),
        "npx_cache"
    );
    assert_eq!(
        recorded_string_extra(event, "runner_exec_target_exists"),
        "false"
    );
    assert_eq!(
        recorded_string_extra(event, "runner_exec_target_executable"),
        "false"
    );
    assert!(
        event
            .extras
            .iter()
            .any(|(key, value)| key == "runner_target_repair_attempted"
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
    assert_eq!(direct_event.fingerprint, vec!["sync-watcher-exit", "other"]);
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
    assert_eq!(exec_event.fingerprint, vec!["sync-watcher-exit", "other"]);
    assert_eq!(
        recorded_string_extra(exec_event, "runner_exec_target_exists"),
        "false"
    );
    assert_eq!(
        recorded_number_extra(exec_event, "exec_not_runnable_streak"),
        4
    );
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
            "HQ skipped Node provisioning because an attempt was already made recently".to_string()
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
        exit_diagnostic_suffix(
            Some(Duration::from_secs(120)),
            Some(48 * 1024),
            None,
            "tree"
        ),
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
    assert_eq!(
        resolve_rss_scope(Some(RssSampleKind::Single), "node"),
        "runner"
    );
}

#[test]
fn sum_job_working_set_kb_requires_root_counts_once_and_saturates() {
    // Root absent from the sample -> None, so the Windows caller falls back to
    // the single-PID sample rather than reporting a foreign/stale job's memory.
    assert_eq!(
        sum_job_working_set_kb(&[(200, Some(10)), (300, Some(20))], 100),
        None
    );
    // Root present -> the summed working set over the whole live tree.
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(10)), (200, Some(20)), (300, Some(30))], 100),
        Some(60)
    );
    // A duplicated PID is counted once (the live-PID list is unique in
    // practice, but the sum must never double a repeated id).
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(10)), (100, Some(10)), (200, Some(5))], 100),
        Some(15)
    );
    // An unreadable member contributes 0 rather than aborting the sum, as long
    // as some OTHER descendant was measured: one worker racing out of its read
    // never withholds the whole tree's footprint.
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(10)), (200, None), (300, Some(5))], 100),
        Some(15)
    );
    // Only the root (shim) was readable — the runner/descendants all raced out
    // of their per-PID reads — so the "tree" would be just the ~6MB shim.
    // Withhold (None) instead of mislabeling the shim as the complete tree.
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(6144)), (200, None)], 100),
        None
    );
    assert_eq!(sum_job_working_set_kb(&[(100, Some(6144))], 100), None);
    // A single readable descendant is enough to trust the tree even when other
    // members raced out — no over-withholding on worker churn.
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(6144)), (200, Some(1500)), (300, None)], 100),
        Some(7644)
    );
    // Saturating add: a pathological pair cannot overflow into a tiny wrong sum.
    assert_eq!(
        sum_job_working_set_kb(&[(100, Some(u64::MAX)), (200, Some(10))], 100),
        Some(u64::MAX)
    );
}

#[test]
fn windows_shim_tree_sample_renders_a_real_number_else_withholds_the_shim() {
    // Once the Windows job sum succeeds, the cmd_shim command still yields a
    // `tree` scope (Tree wins over the command-derived `shim`), so the withheld
    // `unattributed:shim` is replaced by a real number.
    assert_eq!(
        resolve_rss_scope(Some(RssSampleKind::Tree), r"C:\p\npx.cmd"),
        "tree"
    );
    assert_eq!(
        render_last_rss(312 * 1024, Some(Duration::from_secs(17)), "tree"),
        "last_rss=312MB (tree, sampled 17s before exit)"
    );
    // Fallback preservation: when the job sample fails, the cmd_shim child's
    // single-PID sample stays byte-identical to the shipped HQ-DESKTOP-4M
    // suffix — an honest withholding, never a wrong number.
    assert_eq!(
        resolve_rss_scope(Some(RssSampleKind::Single), r"C:\p\npx.cmd"),
        "shim"
    );
    assert_eq!(
        exit_diagnostic_suffix(
            Some(Duration::from_secs(1607)),
            Some(6 * 1024),
            Some(Duration::from_secs(17)),
            "shim",
        ),
        " [uptime=26m47s; last_rss=unattributed:shim (sampled 17s before exit)]"
    );
}

#[cfg(unix)]
#[test]
fn sum_pid_tree_rss_kb_sums_descendants_and_handles_edges() {
    // pid ppid rss command — root=100 with children 200/300 and grandchild 400.
    let table = "100 1 10 node\n200 100 20 node\n300 100 30 git\n400 200 40 node\n999 1 99 git\n";
    // root + 200 + 300 + 400 = 100 KB over 4 PIDs; the unrelated 999 is excluded,
    // and the largest single member is 400's 40 KB.
    assert_eq!(
        sum_pid_tree_rss_kb(table, 100),
        Some(TreeRssSample {
            total_kb: 100,
            pid_count: 4,
            largest_member_kb: 40,
            root_member_kb: 10,
            largest_node_member_kb: Some(40),
            largest_node_member_pid: Some(400),
            largest_child_member_kb: Some(40),
            largest_child_kind: Some(WatcherProcessKind::Node),
        })
    );
    // A leaf sums only itself.
    assert_eq!(
        sum_pid_tree_rss_kb(table, 400),
        Some(TreeRssSample {
            total_kb: 40,
            pid_count: 1,
            largest_member_kb: 40,
            root_member_kb: 40,
            largest_node_member_kb: Some(40),
            largest_node_member_pid: Some(400),
            largest_child_member_kb: None,
            largest_child_kind: None,
        })
    );
    // A missing root -> None, which drives the single-PID fallback unchanged.
    assert_eq!(sum_pid_tree_rss_kb(table, 12345), None);
    // Malformed rows are skipped, never fatal; a reparented (ppid 1) row is
    // just another descendant when reachable, or excluded when not.
    assert_eq!(
        sum_pid_tree_rss_kb("garbage\n100 1 10\n", 100),
        Some(TreeRssSample {
            total_kb: 10,
            pid_count: 1,
            largest_member_kb: 10,
            root_member_kb: 10,
            largest_node_member_kb: None,
            largest_node_member_pid: None,
            largest_child_member_kb: None,
            largest_child_kind: None,
        })
    );
}

#[cfg(unix)]
#[test]
fn sum_pid_tree_rss_kb_targets_node_and_records_largest_child_kind() {
    // The largest process is git, which cannot write Node's report. Preserve its
    // bounded kind while selecting the Node process as the signal target.
    let table = "100 1 10 /opt/node\n200 100 90 git\n300 100 80 node\n";
    let sample = sum_pid_tree_rss_kb(table, 100).expect("root is present");
    assert_eq!(sample.total_kb, 180);
    assert_eq!(sample.pid_count, 3);
    assert_eq!(sample.largest_member_kb, 90);
    assert_eq!(sample.largest_node_member_pid, Some(300));
    assert_eq!(sample.largest_node_member_kb, Some(80));
    assert_eq!(sample.largest_child_member_kb, Some(90));
    assert_eq!(sample.largest_child_kind, Some(WatcherProcessKind::Git));
    assert_eq!(WatcherProcessKind::Git.as_str(), "git");
    for helper in ["git-lfs", "git-index-pack", "git-pack-objects"] {
        assert_eq!(
            classify_watcher_process_kind(helper),
            WatcherProcessKind::Git
        );
    }
}

#[test]
fn watcher_memory_class_uses_supervisor_child_sample_when_child_dominates() {
    use hq_desktop_core::daemon::WatcherMemoryClass as Class;

    let sample = ScopedRssSample {
        kb: 3_000 * 1024,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(2),
        tree_largest_member_kb: Some(2_000 * 1024),
        tree_largest_node_member_pid: Some(100),
        tree_largest_node_member_kb: Some(1_000 * 1024),
        tree_root_member_kb: Some(1_000 * 1024),
        tree_largest_child_member_kb: Some(2_000 * 1024),
        tree_largest_child_kind: Some(WatcherProcessKind::Git),
    };
    assert_eq!(resolve_memory_class_from_sample(&sample), Class::ChildRss);

    let root_dominates = ScopedRssSample {
        tree_largest_child_member_kb: Some(900 * 1024),
        ..sample
    };
    assert_eq!(
        resolve_memory_class_from_sample(&root_dominates),
        Class::Unknown
    );
}

#[test]
fn watcher_memory_class_uses_largest_measured_node_report_component() {
    use hq_desktop_core::daemon::WatcherMemoryClass as Class;
    use hq_desktop_core::runner_diagnostic_report::RunnerReportMemoryClass as Report;

    let classify = |node_rss_mb: u64, report: Report| {
        let sample = ScopedRssSample {
            kb: node_rss_mb * 1024,
            kind: RssSampleKind::Tree,
            tree_pid_count: Some(2),
            tree_largest_member_kb: Some(node_rss_mb * 1024),
            tree_largest_node_member_pid: Some(100),
            tree_largest_node_member_kb: Some(node_rss_mb * 1024),
            tree_root_member_kb: Some(node_rss_mb * 1024),
            tree_largest_child_member_kb: Some(100 * 1024),
            tree_largest_child_kind: Some(WatcherProcessKind::Git),
        };
        resolve_memory_class_from_report(&sample, &report)
    };

    assert_eq!(
        classify(
            1_200,
            Report {
                js_heap_total_mb: Some(1_000),
                js_heap_used_mb: Some(800),
                external_memory_mb: Some(100),
                array_buffers_mb: Some(20),
                libuv_active_handles: Some(12),
            }
        ),
        Class::Heap
    );
    assert_eq!(
        classify(
            1_600,
            Report {
                js_heap_total_mb: Some(500),
                js_heap_used_mb: Some(300),
                external_memory_mb: Some(700),
                array_buffers_mb: Some(200),
                libuv_active_handles: None,
            }
        ),
        Class::External
    );
    assert_eq!(
        classify(
            1_600,
            Report {
                js_heap_total_mb: Some(500),
                js_heap_used_mb: Some(400),
                external_memory_mb: Some(900),
                array_buffers_mb: Some(800),
                libuv_active_handles: None,
            }
        ),
        Class::ArrayBuffers
    );
    assert_eq!(
        classify(
            2_000,
            Report {
                js_heap_total_mb: Some(500),
                js_heap_used_mb: Some(400),
                external_memory_mb: Some(200),
                array_buffers_mb: Some(50),
                libuv_active_handles: None,
            }
        ),
        Class::Native
    );

    let child_dominates_report = ScopedRssSample {
        kb: 2_100 * 1024,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(2),
        tree_largest_member_kb: Some(2_000 * 1024),
        tree_largest_node_member_pid: Some(100),
        tree_largest_node_member_kb: Some(1_200 * 1024),
        tree_root_member_kb: Some(100 * 1024),
        tree_largest_child_member_kb: Some(2_000 * 1024),
        tree_largest_child_kind: Some(WatcherProcessKind::Git),
    };
    assert_eq!(
        resolve_memory_class_from_report(
            &child_dominates_report,
            &Report {
                js_heap_total_mb: Some(1_000),
                js_heap_used_mb: Some(800),
                external_memory_mb: Some(100),
                array_buffers_mb: None,
                libuv_active_handles: None,
            }
        ),
        Class::ChildRss
    );
}

#[test]
fn node_child_rss_does_not_override_available_report_components() {
    use hq_desktop_core::daemon::WatcherMemoryClass as Class;
    use hq_desktop_core::runner_diagnostic_report::RunnerReportMemoryClass as Report;

    let sample = ScopedRssSample {
        kb: 1_200 * 1024,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(2),
        tree_largest_member_kb: Some(1_000 * 1024),
        tree_largest_node_member_pid: Some(300),
        tree_largest_node_member_kb: Some(1_000 * 1024),
        tree_root_member_kb: Some(200 * 1024),
        tree_largest_child_member_kb: Some(1_000 * 1024),
        tree_largest_child_kind: Some(WatcherProcessKind::Node),
    };
    let report = Report {
        js_heap_total_mb: Some(900),
        js_heap_used_mb: Some(800),
        external_memory_mb: Some(100),
        array_buffers_mb: Some(25),
        libuv_active_handles: None,
    };

    assert_eq!(
        resolve_memory_class_from_report(&sample, &report),
        Class::Heap
    );
}

#[test]
fn report_component_wins_when_non_node_child_exceeds_root_but_not_report() {
    use hq_desktop_core::daemon::WatcherMemoryClass as Class;
    use hq_desktop_core::runner_diagnostic_report::RunnerReportMemoryClass as Report;

    let sample = ScopedRssSample {
        kb: 2_000 * 1024,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(2),
        tree_largest_member_kb: Some(1_100 * 1024),
        tree_largest_node_member_pid: Some(100),
        tree_largest_node_member_kb: Some(1_000 * 1024),
        tree_root_member_kb: Some(1_000 * 1024),
        tree_largest_child_member_kb: Some(1_100 * 1024),
        tree_largest_child_kind: Some(WatcherProcessKind::Git),
    };
    let report = Report {
        js_heap_total_mb: None,
        js_heap_used_mb: Some(1_200),
        external_memory_mb: None,
        array_buffers_mb: None,
        libuv_active_handles: None,
    };

    assert_eq!(
        resolve_memory_class_from_report(&sample, &report),
        Class::Heap
    );
}

#[test]
fn zero_report_components_classify_as_unknown() {
    use hq_desktop_core::daemon::WatcherMemoryClass as Class;
    use hq_desktop_core::runner_diagnostic_report::RunnerReportMemoryClass as Report;

    let sample = ScopedRssSample {
        kb: 500 * 1024,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(2),
        tree_largest_member_kb: Some(500 * 1024),
        tree_largest_node_member_pid: Some(100),
        tree_largest_node_member_kb: None,
        tree_root_member_kb: Some(500 * 1024),
        tree_largest_child_member_kb: Some(400 * 1024),
        tree_largest_child_kind: Some(WatcherProcessKind::Git),
    };
    let report = Report {
        js_heap_total_mb: None,
        js_heap_used_mb: Some(0),
        external_memory_mb: Some(0),
        array_buffers_mb: Some(0),
        libuv_active_handles: None,
    };

    assert_eq!(
        resolve_memory_class_from_report(&sample, &report),
        Class::Unknown
    );
}

#[cfg(unix)]
#[test]
fn memory_report_signal_targets_largest_node_when_git_child_is_larger() {
    let tree = sum_pid_tree_rss_kb("100 1 10 /opt/node\n200 100 90 git\n300 100 80 node\n", 100)
        .expect("root is present");
    let sample = ScopedRssSample {
        kb: tree.total_kb,
        kind: RssSampleKind::Tree,
        tree_pid_count: Some(tree.pid_count),
        tree_largest_member_kb: Some(tree.largest_member_kb),
        tree_largest_node_member_pid: tree.largest_node_member_pid,
        tree_largest_node_member_kb: tree.largest_node_member_kb,
        tree_root_member_kb: Some(tree.root_member_kb),
        tree_largest_child_member_kb: tree.largest_child_member_kb,
        tree_largest_child_kind: tree.largest_child_kind,
    };
    assert_eq!(sample.tree_largest_member_kb, Some(90));
    assert_eq!(sample.tree_largest_node_member_kb, Some(80));

    let mut signalled_pid = None;
    assert_eq!(
        signal_largest_node_memory_report(&sample, |pid| {
            signalled_pid = Some(pid);
            true
        }),
        Some(true)
    );
    assert_eq!(signalled_pid, Some(300));
}

#[cfg(unix)]
#[test]
fn sum_pid_tree_rss_kb_is_cycle_safe() {
    // A pathological ppid cycle must terminate and count each PID once.
    let table = "100 200 10 node\n200 100 20 git\n";
    assert_eq!(
        sum_pid_tree_rss_kb(table, 100),
        Some(TreeRssSample {
            total_kb: 30,
            pid_count: 2,
            largest_member_kb: 20,
            root_member_kb: 10,
            largest_node_member_kb: Some(10),
            largest_node_member_pid: Some(100),
            largest_child_member_kb: Some(20),
            largest_child_kind: Some(WatcherProcessKind::Git),
        })
    );
}

#[cfg(unix)]
#[test]
fn read_fresh_memory_class_retries_a_mid_write_report_then_reads_it() {
    // The bounded read discipline behind resolve_watcher_memory_class (HQ-DESKTOP-60):
    // a mid-write report is RETRIED to the deadline and read once complete, rather
    // than mis-recorded as terminally unreadable the way r1 did on 100% of post-fix
    // events; a report that never completes is named honestly; and the wait never
    // blocks past its deadline.
    use hq_desktop_core::daemon::WatcherMemoryClassSource as Src;
    use std::io::Write;
    use tempfile::TempDir;

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("report.json");
    let complete = serde_json::json!({
        "header": { "trigger": "Signal" },
        "javascriptHeap": { "totalMemory": 3_758_096_384u64, "usedMemory": 3_221_225_472u64 }
    })
    .to_string();

    // 1) A complete report already carrying a class -> report_read immediately.
    std::fs::write(&path, &complete).unwrap();
    let (mc, data_source, report_source) = read_fresh_memory_class_within(
        &path,
        None,
        None,
        None,
        Instant::now() + Duration::from_secs(2),
    );
    assert_eq!(data_source, Src::ReportRead);
    assert_eq!(report_source, Src::ReportRead);
    assert_eq!(mc.js_heap_total_mb, Some(3584));

    // 2) A complete document with no memory class -> report_unreadable (honestly empty).
    std::fs::write(&path, br#"{"header":{"trigger":"Signal"}}"#).unwrap();
    let (_, data_source, report_source) = read_fresh_memory_class_within(
        &path,
        None,
        None,
        None,
        Instant::now() + Duration::from_secs(2),
    );
    assert_eq!(data_source, Src::ReportUnreadable);
    assert_eq!(report_source, Src::ReportUnreadable);

    // 3) A report that stays truncated until the deadline -> report_never_completed,
    //    NOT report_unreadable (r1's bug), and it never blocks past the deadline.
    std::fs::write(&path, &complete.as_bytes()[..complete.len() / 2]).unwrap();
    let start = Instant::now();
    let (_, data_source, report_source) =
        read_fresh_memory_class_within(&path, None, None, None, start + Duration::from_millis(300));
    assert_eq!(data_source, Src::ReportNeverCompleted);
    assert_eq!(report_source, Src::ReportNeverCompleted);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "must not block past the deadline"
    );

    // 4) Mid-write on first observation, complete before the deadline -> report_read.
    std::fs::write(&path, &complete.as_bytes()[..complete.len() / 2]).unwrap();
    let path_writer = path.clone();
    let complete_writer = complete.clone();
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        let mut f = std::fs::File::create(&path_writer).unwrap();
        f.write_all(complete_writer.as_bytes()).unwrap();
        f.flush().unwrap();
    });
    let (mc, data_source, report_source) = read_fresh_memory_class_within(
        &path,
        None,
        None,
        None,
        Instant::now() + Duration::from_secs(2),
    );
    writer.join().unwrap();
    assert_eq!(
        data_source,
        Src::ReportRead,
        "a mid-write report that completes must resolve to report_read"
    );
    assert_eq!(report_source, Src::ReportRead);
    assert_eq!(mc.js_heap_total_mb, Some(3584));

    // 5) No fresh report ever appears -> report_absent (distinct from never-completed).
    let empty_dir = TempDir::new().unwrap();
    let missing = empty_dir.path().join("nope.json");
    let (_, data_source, report_source) = read_fresh_memory_class_within(
        &missing,
        None,
        None,
        None,
        Instant::now() + Duration::from_millis(150),
    );
    assert_eq!(data_source, Src::ReportAbsent);
    assert_eq!(report_source, Src::ReportAbsent);
}

#[cfg(unix)]
#[test]
fn runner_memory_sidecar_reads_array_buffers_from_live_node() {
    use hq_desktop_core::daemon::WatcherMemoryClassSource as Src;
    use hq_desktop_core::runner_diagnostic_report::{
        install_runner_memory_class_helper, RUNNER_MEMORY_CLASS_FILENAME,
    };
    use std::process::Command;
    use tempfile::TempDir;

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let dir = TempDir::new().unwrap();
    let helper =
        install_runner_memory_class_helper(dir.path()).expect("install the embedded sampler");
    let ready_path = dir.path().join("ready");
    let node_script = "const buffer = Buffer.alloc(16 * 1024 * 1024); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => buffer[0], 1000);";
    let mut child = ChildGuard(
        Command::new("node")
            .arg("--report-on-signal")
            .arg(format!("--report-directory={}", dir.path().display()))
            .arg("--report-filename=runner-fatal.json")
            .arg("--require")
            .arg(helper)
            .arg("-e")
            .arg(node_script)
            .arg(&ready_path)
            .spawn()
            .expect("Node is installed for the desktop test suite"),
    );
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    while !ready_path.exists() && Instant::now() < ready_deadline {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "Node fixture exited before registering its signal handler"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(ready_path.exists(), "Node fixture should become ready");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.0.id() as i32),
        nix::sys::signal::Signal::SIGUSR2,
    )
    .expect("send the same signal the supervisor uses");

    let report_path = dir.path().join("runner-fatal.json");
    let array_buffers_path = dir.path().join(RUNNER_MEMORY_CLASS_FILENAME);
    let (report, data_source, report_source) = read_fresh_memory_class_within(
        &report_path,
        None,
        Some(&array_buffers_path),
        None,
        Instant::now() + Duration::from_secs(2),
    );
    assert_eq!(data_source, Src::ReportRead);
    assert_eq!(report_source, Src::ReportRead);
    assert!(
        report.array_buffers_mb.unwrap_or(0) >= 16,
        "process.memoryUsage().arrayBuffers should include the retained Buffer"
    );
    assert!(
        report_path.is_file(),
        "Node's signal report still gets written"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn sample_watcher_rss_scoped_reports_tree_for_the_live_process() {
    // The live test process is always in the `ps` table, so the scoped sampler
    // succeeds and reports the honest whole-tree scope with its decomposition.
    let sample = sample_watcher_rss_scoped(std::process::id())
        .expect("the live test process must be sampleable");
    assert!(sample.kb > 0, "a live process has a nonzero footprint");
    assert_eq!(sample.kind, RssSampleKind::Tree);
    assert!(
        sample.tree_pid_count.unwrap_or(0) >= 1,
        "a comparable tree sample carries a PID count"
    );
    assert!(
        sample.tree_largest_member_kb.unwrap_or(0) > 0,
        "a comparable tree sample carries a largest-member RSS"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn sample_watcher_rss_scoped_uses_libproc_without_spawning_ps() {
    use std::os::unix::process::CommandExt;

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let mut child = ChildGuard(
        Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("start process-group fixture"),
    );
    let before = PS_TREE_SAMPLE_SPAWNS.load(Ordering::Relaxed);
    let sample =
        sample_watcher_rss_scoped(child.0.id()).expect("the live process group must be sampleable");

    assert!(sample.kb > 0);
    assert_eq!(sample.kind, RssSampleKind::Tree);
    assert!(sample.tree_pid_count.unwrap_or(0) >= 1);
    assert_eq!(
        PS_TREE_SAMPLE_SPAWNS.load(Ordering::Relaxed),
        before,
        "sampling a live watcher process group must not spawn `ps`"
    );
    child.0.kill().expect("stop process-group fixture");
    child.0.wait().expect("reap process-group fixture");
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
        ..WatcherPhaseContext::default()
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
        SessionEndLatchReading::Unavailable,
        None,
        0,
        None,
        None,
    );
    assert_eq!(context.runner_oom_banner, Some("reached_heap_limit"));
    assert_eq!(context.runner_heap_used_mb, Some(48));
    assert_eq!(context.runner_heap_total_mb, Some(81));
    assert_eq!(context.runner_heap_peak_used_mb, Some(48));
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
        // Proves the tag takes the independently retained true maximum,
        // while the established numeric extra remains the final GC reading.
        runner_heap_peak_used_mb: Some(3000),
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

    // Heap evidence attaches: banner and true-peak-used bucket tags, a
    // class-scoped v8_* shape, and the established three integer extras.
    assert_eq!(
        recorded_tag(heap_capture, "runner_oom_banner"),
        "reached_heap_limit"
    );
    assert_eq!(
        recorded_tag(heap_capture, "runner_stack_shape"),
        "node_oom_handler>v8_report_oom>v8_runtime"
    );
    assert_eq!(
        recorded_tag(heap_capture, "runner_hq_cloud_version"),
        "unknown",
        "every watcher-exit event carries the runner version tag"
    );
    assert_eq!(
        recorded_tag(heap_capture, "runner_heap_peak_used_bucket"),
        "2_5gb_to_3gb"
    );
    assert_eq!(
        recorded_number_extra(heap_capture, "runner_heap_used_mb"),
        48
    );
    assert_eq!(
        recorded_number_extra(heap_capture, "runner_heap_total_mb"),
        81
    );
    assert_eq!(
        recorded_number_extra(heap_capture, "runner_oom_frame_count"),
        3
    );

    // The baseline (no heap evidence) carries none of them — absence never
    // renders as evidence.
    assert!(base_capture
        .tags
        .iter()
        .all(|(k, _)| k != "runner_oom_banner"));
    assert!(base_capture
        .tags
        .iter()
        .all(|(k, _)| k != "runner_heap_peak_used_bucket"));
    assert!(base_capture
        .extras
        .iter()
        .all(|(k, _)| k != "runner_heap_used_mb"));

    // Grouping is message-independent: the fingerprint is byte-identical with
    // and without heap evidence (the retitled RSS/heap lines cannot regroup).
    assert_eq!(heap_capture.fingerprint, base_capture.fingerprint);
    assert_eq!(heap_capture.fingerprint, vec!["sync-watcher-exit", "other"]);
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
        SessionEndLatchReading::Unavailable,
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
        SessionEndLatchReading::Unavailable,
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

#[test]
fn watcher_stderr_tail_preserves_owner_refusal_ahead_of_later_diagnostics() {
    let stderr_tail = Mutex::new(VecDeque::with_capacity(WATCHER_STDERR_TAIL_CAP));
    record_watcher_stderr_tail(
        &stderr_tail,
        "[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=123, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting.",
    );
    for index in 0..(WATCHER_STDERR_TAIL_CAP + 3) {
        record_watcher_stderr_tail(&stderr_tail, &format!("later diagnostic {index}"));
    }
    let tail = stderr_tail.lock().unwrap();
    let selected = tail
        .iter()
        .find(|line| line.contains("hq-sync-runner already owned"))
        .or_else(|| tail.back())
        .map(String::as_str)
        .expect("stderr evidence retained");
    assert_eq!(watcher_exit_stderr_diagnostics(Some(selected)).1, "busy");
    assert_eq!(
        parse_watch_owner_holder_fields(selected)
            .expect("holder fields retained")
            .pid,
        "123"
    );
    assert_eq!(tail.len(), WATCHER_STDERR_TAIL_CAP);
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
        ..WatcherPhaseContext::default()
    });
    let context = watcher_exit_capture_context(
        &Mutex::new(RunTotals::default()),
        false,
        &phase_context,
        &generation,
        0,
        &tail,
        None,
        SessionEndLatchReading::Unavailable,
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
        vec!["sync-watcher-exit", "stack_buffer_overrun"],
        "the native exit class is the sole grouping dimension"
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
            ..WatcherPhaseContext::default()
        }),
        &generation,
        0,
        &[],
        None,
        SessionEndLatchReading::Unavailable,
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
    assert_eq!(recorded_tag(event, "exit_class"), "stack_buffer_overrun");
    assert_eq!(
        event.fingerprint,
        vec!["sync-watcher-exit", "stack_buffer_overrun"]
    );
    assert_eq!(
        recorded_tag(event, "windows_fault_symbol"),
        "STATUS_STACK_BUFFER_OVERRUN"
    );
}

#[test]
fn access_violation_watcher_exit_uses_its_stable_class_fingerprint() {
    let mut effects = RecordingWatcherEffects::default();
    handle_watcher_exit_with_effects(
        &mut effects,
        Some(0xC000_0005u32 as i32),
        None,
        false,
        false,
        r"C:\Program Files\HQ\node.exe",
        None,
        TerminationHost::Windows,
        &WatcherExitCaptureContext::default(),
    );

    let event = effects
        .captures
        .first()
        .expect("a Windows access violation remains visible");
    assert_eq!(
        event.fingerprint,
        vec!["sync-watcher-exit", "access_violation"]
    );
    assert_eq!(recorded_tag(event, "exit_class"), "access_violation");
    assert_eq!(recorded_tag(event, "windows_exit_status"), "0xC0000005");
    assert_eq!(
        recorded_tag(event, "windows_fault_symbol"),
        "ACCESS_VIOLATION"
    );
}

#[test]
fn node_fatal_exit_has_stable_grouping_and_redacted_bounded_stderr_context() {
    let private_path = "/Users/ada/private/workspace/cache";
    let context = WatcherExitCaptureContext {
        runner_fatal_class: "node_fatal".to_string(),
        runner_fatal_lines: vec![format!("FATAL ERROR: Reached heap limit at {private_path}")],
        ..WatcherExitCaptureContext::default()
    };
    let mut effects = RecordingWatcherEffects::default();
    record_unexpected_watcher_exit(
        &mut effects,
        Some(7),
        None,
        1,
        1,
        WatcherExitCapturePolicy::Capture,
        "npx",
        None,
        TerminationHost::Posix,
        &context,
    );

    let event = effects
        .captures
        .first()
        .expect("Node fatal remains visible");
    assert_eq!(event.fingerprint, vec!["sync-watcher-exit", "node_fatal"]);
    assert_eq!(recorded_tag(event, "exit_class"), "node_fatal");
    assert_eq!(recorded_number_extra(event, "runner_fatal_line_count"), 1);
    let fatal_lines = recorded_string_extra(event, "runner_fatal_lines");
    assert!(fatal_lines.contains("FATAL ERROR: Reached heap limit"));
    assert!(fatal_lines.contains("[Filtered]"));
    assert!(!fatal_lines.contains(private_path));
}
