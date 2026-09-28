//! The desktop app can run `hq daemon` as its child (flag `desktop.hq-daemon`)
//! in place of its own background services. These tests pin the pure pieces:
//! when the daemon is used, how it is started and relaunched, and the files the
//! app shares with it (the daemon's lock, state and request files, and
//! hq-cloud's end-of-pass record).

use std::fs;
use std::path::Path;
use std::time::Duration;

use hq_desktop_core::hq_daemon::{
    after_daemon_exit, choose_sync_host, daemon_paths, daemon_run_args, last_pass_path,
    read_daemon_state, read_last_pass, running_daemon_pid, sync_state_dir, write_control_request,
    ControlRequest, HostAction, LastPassTracker, LegacyReason, SyncHostMode, HQ_DAEMON_FLAG,
    HQ_DAEMON_HOST_MIN_CLI,
};
use tempfile::TempDir;

#[test]
fn the_flag_is_desktop_hq_daemon() {
    assert_eq!(HQ_DAEMON_FLAG, "desktop.hq-daemon");
}

// ── choosing the sync host ───────────────────────────────────────────────

#[test]
fn flag_off_keeps_the_apps_own_services() {
    let choice = choose_sync_host(false, true, Some(HQ_DAEMON_HOST_MIN_CLI));
    assert_eq!(choice, SyncHostMode::Legacy(LegacyReason::FlagOff));
}

#[test]
fn flag_on_needs_an_installed_cli_because_an_npx_copy_is_not_kept_or_updated() {
    let choice = choose_sync_host(true, false, Some(HQ_DAEMON_HOST_MIN_CLI));
    assert_eq!(choice, SyncHostMode::Legacy(LegacyReason::CliNotInstalled));
}

#[test]
fn flag_on_needs_a_cli_that_knows_host_desktop() {
    let choice = choose_sync_host(true, true, Some("5.115.4"));
    assert_eq!(
        choice,
        SyncHostMode::Legacy(LegacyReason::CliTooOld {
            found: "5.115.4".to_string()
        })
    );
    let unreadable = choose_sync_host(true, true, None);
    assert_eq!(
        unreadable,
        SyncHostMode::Legacy(LegacyReason::CliTooOld {
            found: "unknown".to_string()
        })
    );
}

#[test]
fn flag_on_with_a_new_enough_installed_cli_uses_the_daemon() {
    assert_eq!(
        choose_sync_host(true, true, Some(HQ_DAEMON_HOST_MIN_CLI)),
        SyncHostMode::Daemon
    );
    assert_eq!(
        choose_sync_host(true, true, Some("99.0.0")),
        SyncHostMode::Daemon
    );
}

// ── starting and relaunching ─────────────────────────────────────────────

#[test]
fn the_daemon_runs_managed_and_hosted_by_the_desktop_app() {
    assert_eq!(
        daemon_run_args(),
        vec!["daemon", "run", "--managed", "--host", "desktop"]
    );
}

#[test]
fn exit_75_is_the_daemons_restart_request_and_relaunches_at_once() {
    assert_eq!(
        after_daemon_exit(Some(75), 3, false),
        HostAction::RelaunchNow
    );
}

#[test]
fn another_running_daemon_is_left_alone() {
    // An hq daemon installed as an OS unit (or a second app instance) holds the
    // lock; starting ours again would only fail again.
    assert!(matches!(
        after_daemon_exit(Some(1), 0, true),
        HostAction::GiveUp(_)
    ));
}

#[test]
fn a_crashing_daemon_is_relaunched_with_growing_delays() {
    assert_eq!(
        after_daemon_exit(Some(1), 0, false),
        HostAction::RelaunchAfter(Duration::from_secs(5))
    );
    assert_eq!(
        after_daemon_exit(None, 1, false),
        HostAction::RelaunchAfter(Duration::from_secs(10))
    );
    assert_eq!(
        after_daemon_exit(Some(1), 3, false),
        HostAction::RelaunchAfter(Duration::from_secs(40))
    );
    assert_eq!(
        after_daemon_exit(Some(1), 20, false),
        HostAction::RelaunchAfter(Duration::from_secs(300))
    );
}

// ── the daemon's files ───────────────────────────────────────────────────

#[test]
fn daemon_files_live_under_hq_daemon_unless_hq_daemon_dir_is_set() {
    let home = Path::new("/Users/someone");
    let default = daemon_paths(home, None);
    assert_eq!(default.root, home.join(".hq").join("daemon"));
    assert_eq!(default.lock, default.root.join("daemon.pid"));
    assert_eq!(default.state, default.root.join("state.json"));
    assert_eq!(default.requests, default.root.join("requests"));

    let custom = daemon_paths(home, Some("/tmp/hq-daemon"));
    assert_eq!(custom.root, Path::new("/tmp/hq-daemon"));
}

#[test]
fn running_daemon_pid_reads_the_lock_and_checks_the_process() {
    let dir = TempDir::new().unwrap();
    let lock = dir.path().join("daemon.pid");
    assert_eq!(running_daemon_pid(&lock, |_| true), None);

    fs::write(&lock, "pid=4242\nts=1700000000\n").unwrap();
    assert_eq!(running_daemon_pid(&lock, |pid| pid == 4242), Some(4242));
    assert_eq!(running_daemon_pid(&lock, |_| false), None);

    fs::write(&lock, "garbage").unwrap();
    assert_eq!(running_daemon_pid(&lock, |_| true), None);
}

#[test]
fn reads_the_daemon_state_it_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("state.json");
    assert!(read_daemon_state(&path).is_none());

    fs::write(
        &path,
        r#"{"version":1,"pid":4242,"startedAt":1,"updatedAt":2,"machineType":"desktop","host":"desktop",
            "units":[{"id":"sync","service":"sync","kind":"long-running","description":"sync","status":"running","pid":4300,"restarts":0},
                     {"id":"mesh","service":"mesh","kind":"long-running","description":"mesh","status":"waiting","reason":"not signed in","restarts":0}]}"#,
    )
    .unwrap();
    let state = read_daemon_state(&path).expect("state parses");
    assert_eq!(state.pid, 4242);
    assert_eq!(state.host.as_deref(), Some("desktop"));
    let sync = state.unit("sync").expect("sync unit");
    assert_eq!(sync.status, "running");
    assert_eq!(sync.pid, Some(4300));
    let mesh = state.unit("mesh").expect("mesh unit");
    assert_eq!(mesh.reason.as_deref(), Some("not signed in"));
    assert!(state.unit("bots").is_none());
}

#[test]
fn control_requests_use_the_daemons_file_format_and_sort_oldest_first() {
    let dir = TempDir::new().unwrap();
    let requests = dir.path().join("requests");

    let first = write_control_request(
        &requests,
        &ControlRequest::Stop {
            unit: "sync".into(),
        },
    )
    .unwrap();
    let second = write_control_request(
        &requests,
        &ControlRequest::Restart {
            unit: "sync".into(),
        },
    )
    .unwrap();

    let name = first.file_name().unwrap().to_str().unwrap().to_string();
    let parts: Vec<&str> = name.trim_end_matches(".json").split('-').collect();
    let well_formed = name.ends_with(".json")
        && parts.len() == 3
        && parts[0].len() == 15
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].len() == 6
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && !parts[2].is_empty()
        && parts[2]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    assert!(well_formed, "unexpected request file name {name}");
    assert!(first.file_name() < second.file_name());

    let body: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&first).unwrap()).unwrap();
    assert_eq!(body, serde_json::json!({"action": "stop", "unit": "sync"}));
    let body: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&second).unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"action": "restart", "unit": "sync"})
    );

    let leftovers: Vec<_> = fs::read_dir(&requests)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().ends_with(".json"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind");
}

// ── hq-cloud's end-of-pass record ────────────────────────────────────────

const PASS: &str = r#"{"schema":1,"pid":4300,"passId":"p-1","completedAt":"2026-09-28T00:00:00.000Z","droppedProgress":2,
  "events":[{"type":"conflict","company":"acme","path":"c.md","direction":"pull"},
            {"type":"all-complete","companiesAttempted":1,"filesDownloaded":0,"bytesDownloaded":0,"filesUploaded":0,"bytesUploaded":0,"conflictPaths":[],"errors":[]}]}"#;

#[test]
fn the_end_of_pass_record_is_read_from_hq_clouds_state_dir() {
    // hq-cloud writes it under `HQ_STATE_DIR || ~/.hq`; the daemon inherits the
    // app's environment, so the app must look in the same place.
    let home = Path::new("/Users/someone");
    assert_eq!(sync_state_dir(home, None), home.join(".hq"));
    assert_eq!(sync_state_dir(home, Some("")), home.join(".hq"));
    assert_eq!(
        sync_state_dir(home, Some("/tmp/hq-state")),
        Path::new("/tmp/hq-state")
    );
    assert_eq!(
        last_pass_path(&sync_state_dir(home, Some("/tmp/hq-state"))),
        Path::new("/tmp/hq-state/sync-last-pass.json")
    );
}

#[test]
fn reads_hq_clouds_end_of_pass_record() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("sync-last-pass.json");
    assert!(read_last_pass(&path).is_none());

    fs::write(&path, PASS).unwrap();
    let pass = read_last_pass(&path).expect("pass parses");
    assert_eq!(pass.pass_id, "p-1");
    assert_eq!(pass.dropped_progress, 2);
    assert_eq!(pass.events.len(), 2);
    assert_eq!(pass.events[1]["type"], "all-complete");

    fs::write(&path, "{not json").unwrap();
    assert!(read_last_pass(&path).is_none());
}

#[test]
fn each_pass_is_handled_once_and_a_pass_from_before_launch_is_not_replayed() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("sync-last-pass.json");
    fs::write(&path, PASS).unwrap();

    let mut tracker = LastPassTracker::starting_after(read_last_pass(&path));
    assert!(tracker.take_new(read_last_pass(&path)).is_none());

    fs::write(&path, PASS.replace("p-1", "p-2")).unwrap();
    let next = tracker.take_new(read_last_pass(&path)).expect("new pass");
    assert_eq!(next.pass_id, "p-2");
    assert!(tracker.take_new(read_last_pass(&path)).is_none());
    assert!(tracker.take_new(None).is_none());
}

#[test]
fn the_first_pass_after_a_clean_launch_is_handled() {
    let mut tracker = LastPassTracker::starting_after(None);
    let pass: hq_desktop_core::hq_daemon::LastPass = serde_json::from_str(PASS).unwrap();
    assert_eq!(
        tracker.take_new(Some(pass)).map(|p| p.pass_id),
        Some("p-1".to_string())
    );
}
