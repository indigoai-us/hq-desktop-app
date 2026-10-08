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
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use hq_desktop_core::daemon::{
    compose_runner_spawn_flags, effective_runner_heap_ceiling, is_autostart_enabled,
    is_instant_sync_enabled, is_pid_alive, is_realtime_sync_enabled, read_menubar_bool,
    resolve_hq_folder_path, sync_child_env, DaemonStatus,
};
use hq_desktop_core::hq_daemon::{
    after_daemon_exit, choose_sync_host, cli_supports_daemon_instant_sync, daemon_run_args,
    default_daemon_paths, read_daemon_state, running_daemon_pid, DaemonState, HostAction, LastPass,
    SyncHostMode, HQ_DAEMON_FLAG, HQ_DAEMON_HOST_MIN_CLI,
};
use hq_desktop_core::hq_resolver::{resolve_hq, HqInvocation};
use tauri::{AppHandle, Listener, Manager, Runtime};

use crate::commands::daemon::{handle_watch_stdout_line, WatcherPhaseContext};
use crate::commands::process::{
    app_exit_requested, attach_hosted_child, deregister_generation, try_register_handle_gen,
};
use crate::commands::sync::RunTotals;
use crate::util::logfile::log;

const LOG_TAG: &str = "hq-daemon-host";
const HQ_CLI_MISSING_MESSAGE: &str = "HQ CLI is unavailable. Install or update it, then retry.";
/// Process-registry handle, so app exit terminates the daemon and its services.
const HQ_DAEMON_HANDLE: &str = "hq-daemon";
/// How often the host re-reads sync settings that reach the daemon as env.
const ENV_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How long to wait before looking again while another daemon holds the lock.
const OTHER_DAEMON_RECHECK: Duration = Duration::from_secs(60);
/// A run this long resets the crash backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(600);
/// How long to wait while the process registry refuses the daemon (a desktop update is in progress).
const RESERVE_RETRY: Duration = Duration::from_secs(5);
const INSTANT_SYNC_UNSUPPORTED_MESSAGE: &str = "Instant Sync is off, but this HQ CLI version cannot apply that setting. Update HQ CLI to use Instant Sync controls.";
const HOST_PHASE_WAIT_SECONDS: u64 = 15;
const HOST_PHASE_RETRY_MESSAGE: &str = "Sync setup is still resolving. Try again in a moment.";
const HOST_FLAG_RETRY_INITIAL: Duration = Duration::from_secs(2);
const HOST_FLAG_RETRY_MAX: Duration = Duration::from_secs(60);
const HOST_FLAG_REFRESH_INTERVAL: Duration = Duration::from_secs(300);
const HOST_FLAG_CACHE_FILE: &str = "hq-daemon-host-flag.json";
const AUTH_SESSION_READY_EVENT: &str = "auth:session-ready";
const DAEMON_OFF_NEXT_LAUNCH_MESSAGE: &str =
    "desktop.hq-daemon turned off; the switch applies on the next launch (daemon-off-by-flag)";
/// Rollout gate for honoring the existing Sync on launch preference when
/// background Auto-sync is disabled. The lead creates this hq-flags key with
/// defaultValue=false before enabling the behavior.
pub const SYNC_ON_LAUNCH_RECONCILE_FLAG: &str = "desktop.sync-on-launch-reconcile-v1";
static INSTANT_SYNC_CLI_SUPPORTED: AtomicBool = AtomicBool::new(false);

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
static PHASE_WAIT_LOCK: Mutex<()> = Mutex::new(());
static PHASE_CHANGED: Condvar = Condvar::new();
static HOST_TRANSITION_LOCK: Mutex<()> = Mutex::new(());
/// Pid of the running daemon child, 0 when none.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);
/// Set to relaunch the child at once (its environment changed).
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);
/// Environment the current child was started with.
static CHILD_ENV: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
#[cfg(test)]
static TEST_DAEMON_COMMANDS_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static TEST_DAEMON_COMMANDS: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());
#[cfg(test)]
static TEST_PHASE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostFlagReason {
    FlagValue,
    CachedAfterReadFailure,
    UnreadableUsingDefault,
}

impl HostFlagReason {
    fn describe(self, enabled: bool) -> &'static str {
        match (self, enabled) {
            (Self::FlagValue, true) => "desktop.hq-daemon is on",
            (Self::FlagValue, false) => "desktop.hq-daemon is off",
            (Self::CachedAfterReadFailure, true) => {
                "hq-flags was unreadable; using the cached on value"
            }
            (Self::CachedAfterReadFailure, false) => {
                "hq-flags was unreadable; using the cached off value"
            }
            (Self::UnreadableUsingDefault, _) => {
                "hq-flags was unreadable and no value is cached; keeping the legacy default"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HostFlagResolution {
    enabled: bool,
    cache_write: Option<bool>,
    reason: HostFlagReason,
}

fn resolve_host_flag_read(
    read: Result<Option<bool>, ()>,
    cached_value: Option<bool>,
) -> HostFlagResolution {
    match read {
        Ok(value) => {
            let enabled = value.unwrap_or(false);
            HostFlagResolution {
                enabled,
                cache_write: Some(enabled),
                reason: HostFlagReason::FlagValue,
            }
        }
        Err(()) => match cached_value {
            Some(enabled) => HostFlagResolution {
                enabled,
                cache_write: None,
                reason: HostFlagReason::CachedAfterReadFailure,
            },
            None => HostFlagResolution {
                enabled: false,
                cache_write: None,
                reason: HostFlagReason::UnreadableUsingDefault,
            },
        },
    }
}

fn host_mode_for_flag_resolution(
    resolution: HostFlagResolution,
    cli_installed_locally: bool,
    cli_version: Option<&str>,
) -> SyncHostMode {
    choose_sync_host(resolution.enabled, cli_installed_locally, cli_version)
}

fn queue_auth_session_reresolve(sender: &tokio::sync::mpsc::UnboundedSender<()>) {
    let _ = sender.send(());
}

fn choose_sync_host_for_cli_probe(
    flag_enabled: bool,
    cli_installed_locally: bool,
    cli_version: Option<&str>,
) -> Option<SyncHostMode> {
    if !flag_enabled || !cli_installed_locally {
        return Some(choose_sync_host(flag_enabled, cli_installed_locally, None));
    }
    cli_version.map(|version| choose_sync_host(true, true, Some(version)))
}

fn launch_reconcile_for_host_selection(initial_selection: bool, configured: bool) -> bool {
    initial_selection && configured
}

fn should_defer_daemon_to_legacy(current: HostPhase, next: HostPhase) -> bool {
    current == HostPhase::Daemon && next == HostPhase::Legacy
}

fn next_host_flag_retry_delay(current: Duration, read_failed: bool, sign_in: bool) -> Duration {
    if !read_failed {
        HOST_FLAG_REFRESH_INTERVAL
    } else if sign_in {
        HOST_FLAG_RETRY_INITIAL
    } else {
        (current * 2).min(HOST_FLAG_RETRY_MAX)
    }
}

fn host_flag_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|path| path.join(HOST_FLAG_CACHE_FILE))
}

fn read_host_flag_cache(path: Option<&Path>) -> Result<Option<bool>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    contents
        .trim()
        .parse()
        .map(Some)
        .map_err(|error: std::str::ParseBoolError| error.to_string())
}

fn write_host_flag_cache(path: Option<&Path>, value: bool) -> Result<(), String> {
    let path = path.ok_or_else(|| "application data directory is unavailable".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "host flag cache has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    writeln!(file, "{value}").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn run_host_transition<StopLegacy, PauseDaemon, StartLegacy, StartDaemon>(
    from: HostPhase,
    to: HostPhase,
    stop_legacy: StopLegacy,
    pause_daemon: PauseDaemon,
    start_legacy: StartLegacy,
    start_daemon: StartDaemon,
) -> Result<(), String>
where
    StopLegacy: FnOnce() -> Result<(), String>,
    PauseDaemon: FnOnce() -> Result<(), String>,
    StartLegacy: FnOnce(),
    StartDaemon: FnOnce() -> Result<(), String>,
{
    match (from, to) {
        (current, next) if current == next => Ok(()),
        (HostPhase::Legacy, HostPhase::Daemon) => {
            stop_legacy()?;
            start_daemon()?;
            Ok(())
        }
        (HostPhase::Daemon, HostPhase::Legacy) => {
            drop(pause_daemon);
            Ok(())
        }
        (_, HostPhase::Legacy) => {
            start_legacy();
            Ok(())
        }
        (_, HostPhase::Daemon) => {
            start_daemon()?;
            Ok(())
        }
        (_, HostPhase::Pending) => Ok(()),
    }
}

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
    let _guard = PHASE_WAIT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    PHASE.store(value, Ordering::Release);
    PHASE_CHANGED.notify_all();
}

fn wait_for_phase_resolution(timeout: Duration) -> HostPhase {
    let deadline = Instant::now() + timeout;
    let mut guard = PHASE_WAIT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    while current_phase() == HostPhase::Pending {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next_guard, result) = PHASE_CHANGED
            .wait_timeout(guard, remaining)
            .unwrap_or_else(|error| error.into_inner());
        guard = next_guard;
        if result.timed_out() {
            break;
        }
    }
    current_phase()
}

fn phase_wait_timeout() -> Duration {
    let seconds = std::env::var("HQ_SYNC_HOST_PHASE_WAIT_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(HOST_PHASE_WAIT_SECONDS)
        .min(HOST_PHASE_WAIT_SECONDS);
    Duration::from_secs(seconds)
}

pub(crate) async fn resolved_phase_for_command() -> Result<HostPhase, String> {
    resolved_phase_for_command_with_timeout(phase_wait_timeout()).await
}

async fn resolved_phase_for_command_with_timeout(timeout: Duration) -> Result<HostPhase, String> {
    if current_phase() != HostPhase::Pending {
        return Ok(current_phase());
    }
    let phase = tauri::async_runtime::spawn_blocking(move || wait_for_phase_resolution(timeout))
        .await
        .map_err(|error| {
            log(
                LOG_TAG,
                &format!("waiting for sync host phase failed: {error}"),
            );
            HOST_PHASE_RETRY_MESSAGE.to_string()
        })?;
    if phase == HostPhase::Pending {
        Err(HOST_PHASE_RETRY_MESSAGE.to_string())
    } else {
        Ok(phase)
    }
}

#[cfg(test)]
fn dispatch_sync_host_phase<T, L, D>(phase: HostPhase, legacy: L, daemon: D) -> Result<T, String>
where
    L: FnOnce() -> Result<T, String>,
    D: FnOnce() -> Result<T, String>,
{
    match phase {
        HostPhase::Pending => Err(HOST_PHASE_RETRY_MESSAGE.to_string()),
        HostPhase::Legacy => legacy(),
        HostPhase::Daemon => daemon(),
    }
}

/// The app's own background services run only once the legacy host is chosen.
pub fn legacy_services_enabled(phase: HostPhase) -> bool {
    phase == HostPhase::Legacy
}

pub fn daemon_mode_active() -> bool {
    current_phase() == HostPhase::Daemon
}

pub fn daemon_sync_now_args() -> Vec<&'static str> {
    vec!["daemon", "sync", "now", "--json"]
}

pub(crate) fn daemon_sync_now_for_phase<F>(
    phase: HostPhase,
    company_slug: Option<&str>,
    request: F,
) -> Option<Result<String, String>>
where
    F: FnOnce() -> Result<(), String>,
{
    if phase != HostPhase::Daemon {
        return None;
    }
    if company_slug.is_some() {
        return Some(Err(
            "Company-specific Sync Now is unavailable while HQ daemon owns sync.".to_string(),
        ));
    }
    Some(request().map(|_| "hq-daemon-sync".to_string()))
}

pub fn daemon_sync_pause_args(pause: bool) -> Vec<&'static str> {
    vec![
        "daemon",
        "sync",
        if pause { "pause" } else { "resume" },
        "--json",
    ]
}

fn daemon_sync_resume_args() -> [Vec<&'static str>; 2] {
    [
        daemon_sync_pause_args(false),
        vec!["daemon", "enable", "sync"],
    ]
}

pub fn daemon_sync_mode_args<'a>(company: &'a str, mode: Option<&'a str>) -> Vec<&'a str> {
    match mode {
        Some(mode) => vec!["daemon", "sync", "mode", "set", company, mode, "--json"],
        None => vec!["daemon", "sync", "mode", "get", company, "--json"],
    }
}

fn daemon_sync_command_error(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("sync is paused") {
        return "Sync is paused. Resume sync to run it.";
    }
    if lower.contains("sync is disabled") {
        return "Sync is disabled for this machine. Enable sync to run it.";
    }
    if lower.contains("daemon")
        && (lower.contains("not running") || lower.contains("not installed"))
    {
        "HQ daemon is not running. Start it, then retry."
    } else {
        "HQ daemon could not complete that action. Tap to retry."
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonEnvChangeAction {
    None,
    PersistInstantSync(bool),
    RestartHostedDaemon,
}

fn daemon_env_change_action(
    phase: HostPhase,
    hosted_child: bool,
    previous: &HashMap<String, String>,
    next: &HashMap<String, String>,
) -> DaemonEnvChangeAction {
    if phase != HostPhase::Daemon || previous == next {
        return DaemonEnvChangeAction::None;
    }
    if previous.get("HQ_DAEMON_INSTANT_SYNC") != next.get("HQ_DAEMON_INSTANT_SYNC") {
        return match next.get("HQ_DAEMON_INSTANT_SYNC").map(String::as_str) {
            Some("0") => DaemonEnvChangeAction::PersistInstantSync(false),
            Some(_) => DaemonEnvChangeAction::PersistInstantSync(true),
            None => DaemonEnvChangeAction::None,
        };
    }
    if hosted_child {
        DaemonEnvChangeAction::RestartHostedDaemon
    } else {
        DaemonEnvChangeAction::None
    }
}

fn add_daemon_instant_sync_env(
    env: &mut HashMap<String, String>,
    cli_supports_setting: bool,
    enabled: bool,
) {
    if cli_supports_setting {
        env.insert(
            "HQ_DAEMON_INSTANT_SYNC".to_string(),
            if enabled { "1" } else { "0" }.to_string(),
        );
    }
}

/// The CLI exits successfully after queueing controls while the daemon is
/// absent. Keep that distinct from a completed action in the UI.
fn daemon_sync_action_error(output: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(output).ok()?;
    (value
        .get("daemonRunning")
        .and_then(|running| running.as_bool())
        == Some(false))
    .then_some("HQ daemon is not running. Start it, then retry.")
}

pub(crate) fn request_daemon_instant_sync_enabled(enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    let output =
        run_daemon_sync_command(&["daemon", "sync", "instant-sync", "set", state, "--json"])?;
    let value: serde_json::Value = serde_json::from_str(&output).map_err(|error| {
        log(
            LOG_TAG,
            &format!("could not parse Instant Sync response: {error}"),
        );
        "HQ daemon returned an unreadable Instant Sync response. Tap to retry.".to_string()
    })?;
    if value.get("persisted").and_then(|field| field.as_bool()) == Some(true)
        && value
            .get("instantSyncEnabled")
            .and_then(|field| field.as_bool())
            == Some(enabled)
    {
        Ok(())
    } else {
        Err("HQ daemon did not save the Instant Sync setting. Tap to retry.".to_string())
    }
}

/// Run one daemon control and keep transport details in the local log.
pub fn run_daemon_sync_command(args: &[&str]) -> Result<String, String> {
    #[cfg(test)]
    if TEST_DAEMON_COMMANDS_ENABLED.load(Ordering::Acquire) {
        TEST_DAEMON_COMMANDS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(args.iter().map(|value| (*value).to_string()).collect());
        if args.iter().any(|value| *value == "instant-sync") {
            let enabled = args.iter().any(|value| *value == "on");
            return Ok(format!(
                r#"{{"instantSyncEnabled":{enabled},"persisted":true,"daemonRestartRequested":true}}"#
            ));
        }
        if args.iter().any(|value| *value == "mode") {
            return Ok(
                r#"{"membershipId":"person#company","mode":"shared","isDefault":false}"#
                    .to_string(),
            );
        }
        if args.iter().any(|value| *value == "now") {
            return Ok(
                r#"{"accepted":true,"action":"restart-sync-runner","daemonRunning":true}"#
                    .to_string(),
            );
        }
        if args
            .iter()
            .any(|value| *value == "pause" || *value == "resume")
        {
            let paused = args.iter().any(|value| *value == "pause");
            return Ok(format!(
                r#"{{"paused":{paused},"persisted":true,"daemonRunning":true}}"#
            ));
        }
        return Ok("Services enabled".to_string());
    }
    let hq = local_hq().ok_or_else(|| HQ_CLI_MISSING_MESSAGE.to_string())?;
    let output = hq_desktop_core::paths::spawn_command(&hq, args)
        .env("PATH", hq_desktop_core::paths::child_path())
        .env("HQ_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            log(
                LOG_TAG,
                &format!("could not run daemon sync control: {error}"),
            );
            "HQ CLI could not complete that action. Tap to retry.".to_string()
        })?;
    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map(|value| value.trim().to_string())
            .map_err(|error| {
                log(
                    LOG_TAG,
                    &format!("daemon sync control returned invalid UTF-8: {error}"),
                );
                "HQ daemon returned an unreadable response. Tap to retry.".to_string()
            });
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    log(LOG_TAG, &format!("daemon sync control failed: {detail}"));
    Err(daemon_sync_command_error(&detail).to_string())
}

pub(crate) async fn run_daemon_sync_command_blocking(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
        run_daemon_sync_command(&borrowed)
    })
    .await
    .map_err(|error| {
        log(
            LOG_TAG,
            &format!("daemon sync command task failed: {error}"),
        );
        "HQ daemon could not complete that action. Tap to retry.".to_string()
    })?
}

pub fn parse_daemon_sync_mode(
    output: &str,
) -> Result<crate::commands::vault_client::MembershipSyncConfig, String> {
    let value: serde_json::Value = serde_json::from_str(output).map_err(|error| {
        log(
            LOG_TAG,
            &format!("could not parse daemon sync mode response: {error}"),
        );
        "HQ daemon returned an unreadable sync mode. Tap to retry.".to_string()
    })?;
    let membership_id = value.get("membershipId").and_then(|v| v.as_str());
    let mode = value.get("mode").and_then(|v| v.as_str());
    let is_default = value.get("isDefault").and_then(|v| v.as_bool());
    match (membership_id, mode, is_default) {
        (Some(membership_id), Some(sync_mode), Some(is_default)) => {
            Ok(crate::commands::vault_client::MembershipSyncConfig {
                membership_id: membership_id.to_string(),
                sync_mode: sync_mode.to_string(),
                is_default,
                custom_paths: None,
                updated_by: None,
            })
        }
        _ => Err("HQ daemon returned an incomplete sync mode. Tap to retry.".to_string()),
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSyncStatusDetails {
    pub running: bool,
    pub paused: bool,
    pub sync_owner: String,
    pub owner: Option<String>,
    pub last_heartbeat: Option<String>,
    pub last_pass_result: Option<serde_json::Value>,
    pub unit_status: String,
    pub reason: Option<String>,
    pub log_path: String,
}

pub fn parse_daemon_sync_status(output: &str) -> Result<DaemonSyncStatusDetails, String> {
    let value: serde_json::Value = serde_json::from_str(output).map_err(|error| {
        log(
            LOG_TAG,
            &format!("could not parse daemon sync status: {error}"),
        );
        "HQ daemon returned an unreadable sync status. Tap to retry.".to_string()
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| "HQ daemon returned an incomplete sync status. Tap to retry.".to_string())?;
    let paused = object
        .get("paused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let last_pass_result = object
        .get("lastPassResult")
        .filter(|value| value.is_object())
        .cloned();
    let unit_status = object
        .get("unitStatus")
        .and_then(|v| v.as_str())
        .unwrap_or(if paused { "paused" } else { "unknown" });
    let reason = object
        .get("reason")
        .and_then(|v| v.as_str())
        .filter(|_| unit_status == "failed" && !paused)
        .map(|_| {
            "The last daemon sync reported an error. See the daemon log for details.".to_string()
        });
    let log_path = object
        .get("logPath")
        .and_then(|v| v.as_str())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "HQ daemon returned an incomplete sync status. Tap to retry.".to_string())?;
    Ok(DaemonSyncStatusDetails {
        running: object
            .get("running")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        paused,
        sync_owner: object
            .get("syncOwner")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        owner: object
            .get("owner")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        last_heartbeat: object
            .get("lastHeartbeat")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        last_pass_result,
        unit_status: unit_status.to_string(),
        reason,
        log_path: log_path.to_string(),
    })
}

pub fn hosted_daemon_sync_status() -> Result<DaemonSyncStatusDetails, String> {
    let output = run_daemon_sync_command(&["daemon", "sync", "status", "--json"])?;
    let mut status = parse_daemon_sync_status(&output)?;
    if !INSTANT_SYNC_CLI_SUPPORTED.load(Ordering::Acquire) && !is_instant_sync_enabled() {
        status.reason = Some(INSTANT_SYNC_UNSUPPORTED_MESSAGE.to_string());
    }
    Ok(status)
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
        // The previous app may have exited during an automatic update after
        // pausing daemon sync. Resume before the hosted daemon starts new work.
        crate::updater::resume_daemon_sync_after_update(&handle).await;
        let cache_path = host_flag_cache_path(&handle);
        let mut auth_events = install_host_mode_auth_listener(&handle);
        let ((mode, flag_resolution), launch_reconcile_enabled) = tokio::join!(
            resolve_mode(cache_path.as_deref()),
            crate::commands::hq_pro::feature_flag_enabled(SYNC_ON_LAUNCH_RECONCILE_FLAG),
        );
        log_host_flag_resolution(flag_resolution);
        if let Some(mode) = mode {
            apply_host_mode(
                handle.clone(),
                mode,
                flag_resolution,
                launch_reconcile_enabled,
                true,
            );
        } else {
            start_initial_legacy_after_cli_probe_failure(handle.clone(), launch_reconcile_enabled);
        }

        let mut retry_delay = HOST_FLAG_RETRY_INITIAL;
        loop {
            let sign_in = tokio::select! {
                _ = tokio::time::sleep(retry_delay) => false,
                event = auth_events.recv() => event.is_some(),
            };
            if app_exit_requested() {
                return;
            }
            let (mode, resolution) = resolve_mode(cache_path.as_deref()).await;
            log_host_flag_resolution(resolution);
            if let Some(mode) = mode {
                apply_host_mode(
                    handle.clone(),
                    mode,
                    resolution,
                    launch_reconcile_enabled,
                    false,
                );
            } else {
                log(
                    LOG_TAG,
                    "HQ CLI version is unreadable; keeping the current sync host",
                );
            }
            let read_failed = matches!(
                resolution.reason,
                HostFlagReason::CachedAfterReadFailure | HostFlagReason::UnreadableUsingDefault
            );
            retry_delay = next_host_flag_retry_delay(retry_delay, read_failed, sign_in);
        }
    });
}

fn install_host_mode_auth_listener<R: Runtime>(
    app: &AppHandle<R>,
) -> tokio::sync::mpsc::UnboundedReceiver<()> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    app.listen(AUTH_SESSION_READY_EVENT, move |_| {
        queue_auth_session_reresolve(&sender);
    });
    receiver
}

fn log_host_flag_resolution(resolution: HostFlagResolution) {
    if matches!(
        resolution.reason,
        HostFlagReason::CachedAfterReadFailure | HostFlagReason::UnreadableUsingDefault
    ) {
        log(
            LOG_TAG,
            &format!(
                "host selection: {}",
                resolution.reason.describe(resolution.enabled)
            ),
        );
    }
}

fn start_initial_legacy_after_cli_probe_failure(handle: AppHandle, launch_reconcile_enabled: bool) {
    let _transition = HOST_TRANSITION_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if current_phase() != HostPhase::Pending {
        return;
    }
    log(
        LOG_TAG,
        "HQ CLI version is unreadable at startup; using the legacy sync host and retrying",
    );
    set_phase(HostPhase::Legacy);
    start_legacy_services(
        handle,
        launch_reconcile_for_host_selection(true, launch_reconcile_enabled),
    );
}

fn apply_host_mode(
    handle: AppHandle,
    mode: SyncHostMode,
    resolution: HostFlagResolution,
    launch_reconcile_enabled: bool,
    initial_selection: bool,
) {
    let (next, mode_reason) = match mode {
        SyncHostMode::Legacy(reason) => {
            let reason = if !resolution.enabled
                && matches!(
                    resolution.reason,
                    HostFlagReason::CachedAfterReadFailure | HostFlagReason::UnreadableUsingDefault
                ) {
                resolution.reason.describe(resolution.enabled).to_string()
            } else {
                reason.describe()
            };
            (HostPhase::Legacy, reason)
        }
        SyncHostMode::Daemon => (HostPhase::Daemon, "desktop.hq-daemon is on".to_string()),
    };
    let _transition = HOST_TRANSITION_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let previous = current_phase();
    if should_defer_daemon_to_legacy(previous, next) {
        log(LOG_TAG, DAEMON_OFF_NEXT_LAUNCH_MESSAGE);
        return;
    }
    if previous == next {
        return;
    }
    if next == HostPhase::Legacy {
        log(
            LOG_TAG,
            &format!("running the app's own sync services: {mode_reason}"),
        );
    } else {
        log(LOG_TAG, "hq daemon runs background services on this launch");
    }
    set_phase(HostPhase::Pending);
    let result = run_host_transition(
        previous,
        next,
        || {
            crate::commands::daemon::stop_watch_runner()
                .map(|_| ())
                .map_err(|error| format!("could not stop the legacy watch runner: {error}"))
        },
        || set_daemon_sync(false),
        || {
            set_phase(HostPhase::Legacy);
            start_legacy_services(
                handle.clone(),
                launch_reconcile_for_host_selection(initial_selection, launch_reconcile_enabled),
            );
        },
        || {
            set_phase(HostPhase::Daemon);
            let daemon_handle = handle.clone();
            let launch_sync = launch_reconcile_for_host_selection(
                initial_selection,
                hq_desktop_core::daemon::should_run_sync_on_launch(
                    launch_reconcile_enabled,
                    sync_on_launch_enabled(),
                    is_realtime_sync_enabled(),
                    is_autostart_enabled(),
                ),
            );
            std::thread::spawn(move || enter_daemon_mode(daemon_handle, launch_sync));
            Ok(())
        },
    );
    if let Err(error) = result {
        set_phase(previous);
        log(LOG_TAG, &format!("host mode transition failed: {error}"));
    }
}

async fn resolve_mode(cache_path: Option<&Path>) -> (Option<SyncHostMode>, HostFlagResolution) {
    let cached = match read_host_flag_cache(cache_path) {
        Ok(cached) => cached,
        Err(error) => {
            log(LOG_TAG, &format!("could not read host flag cache: {error}"));
            None
        }
    };
    let read = crate::commands::hq_pro::feature_flag_read(HQ_DAEMON_FLAG).await;
    let resolution = resolve_host_flag_read(read, cached);
    if let Some(value) = resolution.cache_write {
        if let Err(error) = write_host_flag_cache(cache_path, value) {
            log(
                LOG_TAG,
                &format!("could not write host flag cache: {error}"),
            );
        }
    }
    let flag_on = resolution.enabled;
    if !flag_on {
        return (
            Some(host_mode_for_flag_resolution(resolution, false, None)),
            resolution,
        );
    }
    let invocation = tauri::async_runtime::spawn_blocking(resolve_hq).await.ok();
    let local = matches!(invocation, Some(HqInvocation::Local(_)));
    let version = if local {
        crate::commands::hq_cli_update::get_hq_cli_version().await
    } else {
        None
    };
    match (local, version.as_deref()) {
        (true, Some(version)) => INSTANT_SYNC_CLI_SUPPORTED.store(
            cli_supports_daemon_instant_sync(Some(version)),
            Ordering::Release,
        ),
        (false, _) => INSTANT_SYNC_CLI_SUPPORTED.store(false, Ordering::Release),
        (true, None) => {}
    }
    (
        choose_sync_host_for_cli_probe(flag_on, local, version.as_deref()),
        resolution,
    )
}

/// Today's launch behaviour: warm the npx cache and start the watch runner.
fn start_legacy_services(handle: AppHandle, launch_reconcile_enabled: bool) {
    crate::commands::prewarm::spawn_prewarm();
    let dev_disable_auto_sync = std::env::var("HQ_DEV_DISABLE_AUTO_SYNC_ON_LAUNCH")
        .ok()
        .as_deref()
        == Some("1");
    if !dev_disable_auto_sync && (is_autostart_enabled() || is_realtime_sync_enabled()) {
        #[cfg(test)]
        crate::commands::process::record_sync_runner_spawn_attempt();
        std::thread::spawn(move || {
            // Small delay to let the app fully initialize
            std::thread::sleep(Duration::from_secs(2));
            let _ = crate::commands::daemon::start_daemon_for_app_launch(handle);
        });
    } else if !dev_disable_auto_sync
        && hq_desktop_core::daemon::should_run_sync_on_launch(
            launch_reconcile_enabled,
            sync_on_launch_enabled(),
            is_realtime_sync_enabled(),
            is_autostart_enabled(),
        )
    {
        schedule_sync_on_launch(handle);
    }
}

fn sync_on_launch_enabled() -> bool {
    read_menubar_bool(|prefs| prefs.sync_on_launch, true)
}

fn schedule_sync_on_launch(app: AppHandle) {
    std::thread::spawn(move || {
        // Let the app finish choosing its sync host before the one-shot pass.
        std::thread::sleep(Duration::from_secs(2));
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::commands::sync::start_sync_with_trigger(
                app,
                None,
                crate::commands::cdp_mirror::SyncTrigger::Auto,
            )
            .await
            {
                log(LOG_TAG, &format!("sync-on-launch pass failed: {error}"));
            }
        });
    });
}

/// Sync should run: Auto-sync on, cloud not paused, and no dev kill switch.
fn sync_wanted() -> bool {
    let dev_disable_auto_sync = std::env::var("HQ_DEV_DISABLE_AUTO_SYNC_ON_LAUNCH")
        .ok()
        .as_deref()
        == Some("1");
    !dev_disable_auto_sync
        && hq_desktop_core::daemon::ensure_sync_spawn_allowed().is_ok()
        && (is_autostart_enabled() || is_realtime_sync_enabled())
}

fn enter_daemon_mode(handle: AppHandle, launch_sync: bool) {
    // A watch runner from an earlier session would sync the same folder twice.
    if let Err(e) = crate::commands::daemon::stop_watch_runner() {
        log(
            LOG_TAG,
            &format!("could not stop an earlier watch runner: {e}"),
        );
    }
    // The mesh LaunchAgent this app installed keeps the daemon's mesh waiting.
    if let Err(e) =
        tauri::async_runtime::block_on(crate::commands::install_stages::retire_work_mesh_unit())
    {
        log(
            LOG_TAG,
            &format!("could not remove the separate Work Mesh unit: {e}"),
        );
    }
    std::thread::spawn(watch_env_changes);
    crate::commands::sync_progress_watch::setup_last_pass_watch(&handle);
    if let Err(e) = set_daemon_sync(sync_wanted()) {
        log(
            LOG_TAG,
            &format!("could not apply the Auto-sync setting: {e}"),
        );
    }
    if launch_sync {
        schedule_sync_on_launch(handle.clone());
    }
    host_loop();
}

/// Environment for the daemon; its services inherit it, sync included.
fn daemon_env() -> HashMap<String, String> {
    let hq_folder = resolve_hq_folder_path().unwrap_or_default();
    let mut env = sync_child_env(&hq_folder);
    add_daemon_instant_sync_env(
        &mut env,
        INSTANT_SYNC_CLI_SUPPORTED.load(Ordering::Acquire),
        is_instant_sync_enabled(),
    );
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
        HqInvocation::Npx | HqInvocation::NpxGlobalRuntime => None,
    }
}

/// Run the daemon's persisted pause/resume control.
pub fn set_daemon_sync(enable: bool) -> Result<(), String> {
    if enable {
        // Before #1102, the app paused sync with `daemon disable sync`. Resume
        // clears that persisted per-machine override as well as syncPaused.
        let commands = daemon_sync_resume_args();
        let resume_output = run_daemon_sync_command(&commands[0])?;
        run_daemon_sync_command(&commands[1])?;
        if let Some(message) = daemon_sync_action_error(&resume_output) {
            return Err(message.to_string());
        }
    } else {
        let output = run_daemon_sync_command(&daemon_sync_pause_args(true))?;
        if let Some(message) = daemon_sync_action_error(&output) {
            return Err(message.to_string());
        }
    }
    Ok(())
}

pub fn request_daemon_sync_now() -> Result<(), String> {
    let output = run_daemon_sync_command(&daemon_sync_now_args())?;
    if let Some(message) = daemon_sync_action_error(&output) {
        return Err(message.to_string());
    }
    Ok(())
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

/// Apply setting changes to a daemon whether this app spawned it or found it running.
fn watch_env_changes() {
    // Push the current preference once at startup too. A daemon already holding
    // the lock did not inherit this app's environment.
    let mut observed = HashMap::new();
    loop {
        std::thread::sleep(ENV_CHECK_INTERVAL);
        if app_exit_requested() {
            return;
        }
        let next = daemon_env();
        let has_hosted_child = CHILD_ENV
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        match daemon_env_change_action(current_phase(), has_hosted_child, &observed, &next) {
            DaemonEnvChangeAction::None => observed = next,
            DaemonEnvChangeAction::PersistInstantSync(enabled) => {
                let restarting_hosted_child = has_hosted_child;
                if restarting_hosted_child {
                    RESTART_REQUESTED.store(true, Ordering::Release);
                }
                if let Err(error) = request_daemon_instant_sync_enabled(enabled) {
                    if restarting_hosted_child {
                        RESTART_REQUESTED.store(false, Ordering::Release);
                    }
                    log(
                        LOG_TAG,
                        &format!("could not apply Instant Sync setting: {error}"),
                    );
                    continue;
                }
                observed = next;
            }
            DaemonEnvChangeAction::RestartHostedDaemon => {
                log(LOG_TAG, "sync settings changed; restarting hq daemon");
                RESTART_REQUESTED.store(true, Ordering::Release);
                terminate_child();
                observed = next;
            }
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
            log(
                LOG_TAG,
                "hq is no longer installed locally; hq daemon cannot run",
            );
            return;
        };

        // The registry refuses new children while a desktop update is stopping HQ processes.
        let Some(generation) = try_register_handle_gen(HQ_DAEMON_HANDLE) else {
            std::thread::sleep(RESERVE_RETRY);
            continue;
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
        let spawned = command.spawn().map_err(|e| {
            deregister_generation(HQ_DAEMON_HANDLE, generation);
            format!("could not start hq daemon: {e}")
        });
        let mut child = match spawned
            .and_then(|child| attach_hosted_child(HQ_DAEMON_HANDLE, generation, child))
        {
            Ok(child) => child,
            Err(e) => {
                log(LOG_TAG, &e);
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
        log(LOG_TAG, &format!("started hq daemon (pid {pid})"));

        let status = child.wait();
        CHILD_PID.store(0, Ordering::Release);
        deregister_generation(HQ_DAEMON_HANDLE, generation);
        if app_exit_requested() {
            return;
        }
        let code = status.as_ref().ok().and_then(|s| s.code());
        log(
            LOG_TAG,
            &format!("hq daemon (pid {pid}) exited with {code:?}"),
        );
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

    #[test]
    fn unreadable_flag_uses_cached_daemon_mode_and_keeps_the_read_failure_reason() {
        let resolution = resolve_host_flag_read(Err(()), Some(true));
        assert_eq!(resolution.enabled, true);
        assert_eq!(resolution.reason, HostFlagReason::CachedAfterReadFailure);
        assert_eq!(resolution.cache_write, None);
        assert_eq!(
            host_mode_for_flag_resolution(resolution, true, Some(HQ_DAEMON_HOST_MIN_CLI)),
            SyncHostMode::Daemon
        );
    }

    #[test]
    fn unreadable_flag_without_cache_uses_legacy_then_a_retry_can_select_daemon() {
        let initial = resolve_host_flag_read(Err(()), None);
        assert_eq!(initial.enabled, false);
        assert_eq!(initial.reason, HostFlagReason::UnreadableUsingDefault);
        assert_eq!(initial.cache_write, None);
        assert_eq!(
            host_mode_for_flag_resolution(initial, false, None),
            SyncHostMode::Legacy(hq_desktop_core::hq_daemon::LegacyReason::FlagOff)
        );

        let retry = resolve_host_flag_read(Ok(Some(true)), None);
        assert_eq!(retry.enabled, true);
        assert_eq!(retry.reason, HostFlagReason::FlagValue);
        assert_eq!(retry.cache_write, Some(true));
        assert_eq!(
            host_mode_for_flag_resolution(retry, true, Some(HQ_DAEMON_HOST_MIN_CLI)),
            SyncHostMode::Daemon
        );
    }

    #[test]
    fn successful_off_flag_read_is_cached_and_selects_legacy() {
        let resolution = resolve_host_flag_read(Ok(Some(false)), Some(true));
        assert_eq!(resolution.enabled, false);
        assert_eq!(resolution.reason, HostFlagReason::FlagValue);
        assert_eq!(resolution.cache_write, Some(false));
        assert_eq!(
            host_mode_for_flag_resolution(resolution, true, Some(HQ_DAEMON_HOST_MIN_CLI)),
            SyncHostMode::Legacy(hq_desktop_core::hq_daemon::LegacyReason::FlagOff)
        );
    }

    #[test]
    fn host_flag_cache_persists_successful_values_and_preserves_them_on_failures() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(HOST_FLAG_CACHE_FILE);
        assert_eq!(read_host_flag_cache(Some(&path)).unwrap(), None);

        let off = resolve_host_flag_read(Ok(Some(false)), None);
        write_host_flag_cache(Some(&path), off.cache_write.unwrap()).unwrap();
        assert_eq!(read_host_flag_cache(Some(&path)).unwrap(), Some(false));

        let failed = resolve_host_flag_read(Err(()), read_host_flag_cache(Some(&path)).unwrap());
        assert_eq!(failed.cache_write, None);
        assert_eq!(read_host_flag_cache(Some(&path)).unwrap(), Some(false));
    }

    #[test]
    fn sign_in_requests_a_fresh_host_mode_resolution() {
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        queue_auth_session_reresolve(&sender);
        assert!(events.try_recv().is_ok());
    }

    #[test]
    fn flag_reads_retry_with_a_bounded_backoff_and_poll_after_success() {
        assert_eq!(
            next_host_flag_retry_delay(HOST_FLAG_RETRY_INITIAL, true, false),
            Duration::from_secs(4)
        );
        assert_eq!(
            next_host_flag_retry_delay(HOST_FLAG_RETRY_MAX, true, false),
            HOST_FLAG_RETRY_MAX
        );
        assert_eq!(
            next_host_flag_retry_delay(HOST_FLAG_RETRY_MAX, true, true),
            HOST_FLAG_RETRY_INITIAL
        );
        assert_eq!(
            next_host_flag_retry_delay(HOST_FLAG_RETRY_MAX, false, false),
            HOST_FLAG_REFRESH_INTERVAL
        );
    }

    #[test]
    fn host_transition_stops_legacy_runner_before_daemon_sync_starts() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stop_events = events.clone();
        let pause_events = events.clone();
        let legacy_events = events.clone();
        let daemon_events = events.clone();
        let result = run_host_transition(
            HostPhase::Legacy,
            HostPhase::Daemon,
            || {
                stop_events.lock().unwrap().push("stop-legacy-runner");
                Ok(())
            },
            || {
                pause_events.lock().unwrap().push("pause-daemon-sync");
                Ok(())
            },
            || legacy_events.lock().unwrap().push("start-legacy"),
            || {
                daemon_events.lock().unwrap().push("start-daemon-sync");
                Ok(())
            },
        );

        assert!(result.is_ok());
        assert_eq!(
            *events.lock().unwrap(),
            ["stop-legacy-runner", "start-daemon-sync"]
        );
    }

    #[test]
    fn failed_legacy_stop_never_starts_daemon() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stop_events = events.clone();
        let start_events = events.clone();
        let stopped = run_host_transition(
            HostPhase::Legacy,
            HostPhase::Daemon,
            || Err("runner still active".to_string()),
            || Ok(()),
            || start_events.lock().unwrap().push("start-legacy"),
            || {
                stop_events.lock().unwrap().push("start-daemon");
                Ok(())
            },
        );
        assert_eq!(stopped, Err("runner still active".to_string()));
        assert!(events.lock().unwrap().is_empty());
    }
    #[test]
    fn daemon_host_keeps_running_when_refresh_reads_flag_off() {
        let resolution = resolve_host_flag_read(Ok(Some(false)), Some(true));
        assert_eq!(resolution.cache_write, Some(false));
        let mode = host_mode_for_flag_resolution(resolution, true, Some(HQ_DAEMON_HOST_MIN_CLI));
        assert_eq!(
            mode,
            SyncHostMode::Legacy(hq_desktop_core::hq_daemon::LegacyReason::FlagOff)
        );

        let events = Arc::new(Mutex::new(Vec::new()));
        let pause_events = events.clone();
        let legacy_events = events.clone();
        let defer = should_defer_daemon_to_legacy(HostPhase::Daemon, HostPhase::Legacy);
        assert!(defer);
        assert_eq!(
            DAEMON_OFF_NEXT_LAUNCH_MESSAGE,
            "desktop.hq-daemon turned off; the switch applies on the next launch (daemon-off-by-flag)"
        );
        // The transition itself must also be a no-op, so a caller that skips
        // the deferral check still never pauses the daemon or starts legacy.
        run_host_transition(
            HostPhase::Daemon,
            HostPhase::Legacy,
            || Ok(()),
            || {
                pause_events.lock().unwrap().push("pause-daemon");
                Ok(())
            },
            || legacy_events.lock().unwrap().push("start-legacy"),
            || Ok(()),
        )
        .unwrap();
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn unreadable_cli_version_keeps_the_current_mode_for_retry() {
        assert_eq!(choose_sync_host_for_cli_probe(true, true, None), None);
        assert_eq!(
            choose_sync_host_for_cli_probe(true, false, None),
            Some(SyncHostMode::Legacy(
                hq_desktop_core::hq_daemon::LegacyReason::CliNotInstalled
            ))
        );
    }

    #[test]
    fn launch_reconcile_runs_only_during_initial_host_selection() {
        assert!(launch_reconcile_for_host_selection(true, true));
        assert!(!launch_reconcile_for_host_selection(false, true));
    }

    // ── settings toggles change the daemon's saved config ────────────────

    #[test]
    fn desktop_sync_controls_use_daemon_sync_commands() {
        assert_eq!(
            daemon_sync_now_args(),
            vec!["daemon", "sync", "now", "--json"]
        );
        assert_eq!(
            daemon_sync_pause_args(true),
            vec!["daemon", "sync", "pause", "--json"]
        );
        assert_eq!(
            daemon_sync_pause_args(false),
            vec!["daemon", "sync", "resume", "--json"]
        );
        assert_eq!(
            daemon_sync_mode_args("acme", Some("shared")),
            vec!["daemon", "sync", "mode", "set", "acme", "shared", "--json"]
        );
        assert_eq!(
            daemon_sync_mode_args("acme", None),
            vec!["daemon", "sync", "mode", "get", "acme", "--json"]
        );
        assert_eq!(
            daemon_sync_resume_args(),
            [
                vec!["daemon", "sync", "resume", "--json"],
                vec!["daemon", "enable", "sync"]
            ]
        );
        let mut env = HashMap::new();
        add_daemon_instant_sync_env(&mut env, true, false);
        assert_eq!(
            env.get("HQ_DAEMON_INSTANT_SYNC").map(String::as_str),
            Some("0")
        );
        add_daemon_instant_sync_env(&mut env, true, true);
        assert_eq!(
            env.get("HQ_DAEMON_INSTANT_SYNC").map(String::as_str),
            Some("1")
        );
        env.clear();
        add_daemon_instant_sync_env(&mut env, false, false);
        assert!(!env.contains_key("HQ_DAEMON_INSTANT_SYNC"));
        let mut instant_off = HashMap::from([("HQ_ROOT".to_string(), "/tmp/hq".to_string())]);
        add_daemon_instant_sync_env(&mut instant_off, false, false);
        let mut instant_on = HashMap::from([("HQ_ROOT".to_string(), "/tmp/hq".to_string())]);
        add_daemon_instant_sync_env(&mut instant_on, false, true);
        assert_eq!(
            instant_off, instant_on,
            "unsupported settings must not restart the daemon"
        );
        assert_eq!(
            daemon_sync_action_error(
                r#"{"accepted":true,"action":"restart-sync-runner","daemonRunning":false}"#
            ),
            Some("HQ daemon is not running. Start it, then retry.")
        );
        assert_eq!(
            daemon_sync_action_error(r#"{"paused":false,"persisted":true,"daemonRunning":true}"#),
            None
        );
    }

    #[test]
    fn daemon_control_failures_use_recoverable_user_messages() {
        assert_eq!(
            daemon_sync_command_error("hq daemon is not running"),
            "HQ daemon is not running. Start it, then retry."
        );
        assert_eq!(
            daemon_sync_command_error("request failed with a transport detail"),
            "HQ daemon could not complete that action. Tap to retry."
        );
        assert_eq!(
            daemon_sync_command_error("sync is paused; run `hq daemon sync resume` first"),
            "Sync is paused. Resume sync to run it."
        );
        assert_eq!(
            daemon_sync_command_error(
                "sync is disabled for this machine; run `hq daemon enable sync` first"
            ),
            "Sync is disabled for this machine. Enable sync to run it."
        );
        assert_eq!(
            HQ_CLI_MISSING_MESSAGE,
            "HQ CLI is unavailable. Install or update it, then retry."
        );
    }

    #[test]
    fn daemon_sync_status_parser_reads_owner_health_last_pass_and_errors() {
        let status = parse_daemon_sync_status(r#"{"running":true,"paused":false,"syncOwner":"daemon","owner":"hq-daemon","lastHeartbeat":"2026-10-01T12:01:00Z","lastPassResult":{"status":"ok","completedAt":"2026-10-01T12:00:00Z","errors":1},"unitStatus":"running","reason":null,"logPath":"/tmp/hq-sync.log"}"#).unwrap();
        assert!(status.running);
        assert_eq!(status.sync_owner, "daemon");
        assert_eq!(status.owner.as_deref(), Some("hq-daemon"));
        assert_eq!(status.unit_status, "running");
        assert_eq!(
            status.last_heartbeat.as_deref(),
            Some("2026-10-01T12:01:00Z")
        );
        assert_eq!(
            status.last_pass_result.as_ref().unwrap()["completedAt"],
            "2026-10-01T12:00:00Z"
        );
        assert!(status.reason.is_none());
        assert_eq!(status.log_path, "/tmp/hq-sync.log");
    }

    #[test]
    fn daemon_sync_status_parser_rejects_invalid_json() {
        assert!(parse_daemon_sync_status("not json").is_err());
    }

    #[test]
    fn pause_and_lease_wait_reasons_are_state_not_sync_errors() {
        for reason in ["sync is paused", "waiting for sync lease"] {
            let output = format!(
                r#"{{"running":false,"paused":{},"syncOwner":"daemon","unitStatus":"waiting","reason":"{reason}","logPath":"/tmp/hq-sync.log"}}"#,
                reason == "sync is paused"
            );
            let status = parse_daemon_sync_status(&output).unwrap();
            assert!(
                status.reason.is_none(),
                "{reason} should not be shown as a failure"
            );
        }
    }

    #[test]
    fn daemon_sync_status_keeps_daemon_not_running_distinct_from_sync_not_running() {
        // Captured from `daemonSyncStatus`'s JSON contract in hq-cli:
        // daemon presence is conveyed by `unitStatus: not-running` plus null owner.
        let output = r#"{"running":false,"paused":false,"syncOwner":"daemon","owner":null,"runnerPid":null,"hqCloudVersion":null,"lastHeartbeat":null,"lastPassResult":null,"unitStatus":"not-running","reason":null,"logPath":"/tmp/hq-sync.log"}"#;
        let status = parse_daemon_sync_status(output).unwrap();
        assert!(!status.running);
        assert_eq!(status.unit_status, "not-running");
        assert!(status.owner.is_none());
    }

    #[test]
    fn daemon_sync_mode_parser_maps_cli_fields_to_the_existing_ui_contract() {
        let mode = parse_daemon_sync_mode(r#"{"companySlug":"acme","membershipId":"prs_x#cmp_a","mode":"shared","isDefault":false}"#).unwrap();
        assert_eq!(mode.membership_id, "prs_x#cmp_a");
        assert_eq!(mode.sync_mode, "shared");
        assert!(!mode.is_default);
    }

    #[test]
    fn daemon_sync_mode_parser_rejects_missing_fields() {
        assert!(parse_daemon_sync_mode(r#"{"mode":"shared"}"#).is_err());
    }

    #[test]
    fn instant_sync_changes_are_applied_when_the_existing_daemon_is_not_hosted_here() {
        let previous = HashMap::from([("HQ_DAEMON_INSTANT_SYNC".to_string(), "1".to_string())]);
        let changed = HashMap::from([("HQ_DAEMON_INSTANT_SYNC".to_string(), "0".to_string())]);

        assert_eq!(
            daemon_env_change_action(HostPhase::Daemon, false, &previous, &changed),
            DaemonEnvChangeAction::PersistInstantSync(false)
        );
        assert_eq!(
            daemon_env_change_action(HostPhase::Daemon, false, &HashMap::new(), &changed,),
            DaemonEnvChangeAction::PersistInstantSync(false)
        );
    }

    #[test]
    fn daemon_settings_change_restarts_only_the_hosted_daemon() {
        let previous = HashMap::from([("HQ_DAEMON_AUTOSTART".to_string(), "1".to_string())]);
        let changed = HashMap::from([("HQ_DAEMON_AUTOSTART".to_string(), "0".to_string())]);

        assert_eq!(
            daemon_env_change_action(HostPhase::Daemon, true, &previous, &changed),
            DaemonEnvChangeAction::RestartHostedDaemon
        );
        assert_eq!(
            daemon_env_change_action(HostPhase::Daemon, true, &previous, &previous),
            DaemonEnvChangeAction::None
        );
        assert_eq!(
            daemon_env_change_action(HostPhase::Legacy, true, &previous, &changed),
            DaemonEnvChangeAction::None
        );
    }

    #[test]
    fn daemon_sync_now_rejects_company_scope_instead_of_syncing_every_company() {
        let mut request_called = false;
        let result = daemon_sync_now_for_phase(HostPhase::Daemon, Some("acme"), || {
            request_called = true;
            request_daemon_sync_now()
        });

        assert_eq!(
            result,
            Some(Err(
                "Company-specific Sync Now is unavailable while HQ daemon owns sync.".to_string()
            ))
        );
        assert!(!request_called);
    }

    #[test]
    fn pending_phase_wait_resolves_to_legacy_and_runs_legacy_dispatch() {
        let _phase_guard = TEST_PHASE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        set_phase(HostPhase::Pending);
        let resolver = std::thread::spawn(|| set_phase(HostPhase::Legacy));
        let phase = wait_for_phase_resolution(Duration::from_secs(1));
        resolver.join().unwrap();

        assert_eq!(phase, HostPhase::Legacy);
        let mut legacy_called = false;
        let result = dispatch_sync_host_phase(
            phase,
            || {
                legacy_called = true;
                Ok("legacy".to_string())
            },
            || Ok("daemon".to_string()),
        );
        assert_eq!(result, Ok("legacy".to_string()));
        assert!(legacy_called);
    }

    #[test]
    fn pending_phase_wait_resolves_to_daemon_without_spawning_a_runner() {
        let _phase_guard = TEST_PHASE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        set_phase(HostPhase::Pending);
        let resolver = std::thread::spawn(|| set_phase(HostPhase::Daemon));
        let phase = wait_for_phase_resolution(Duration::from_secs(1));
        resolver.join().unwrap();

        TEST_DAEMON_COMMANDS_ENABLED.store(true, Ordering::Release);
        TEST_DAEMON_COMMANDS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        crate::commands::process::reset_sync_runner_spawn_attempts();
        let result = daemon_sync_now_for_phase(phase, None, request_daemon_sync_now);
        assert_eq!(result, Some(Ok("hq-daemon-sync".to_string())));
        assert_eq!(crate::commands::process::sync_runner_spawn_attempts(), 0);
        TEST_DAEMON_COMMANDS_ENABLED.store(false, Ordering::Release);
        set_phase(HostPhase::Legacy);
    }

    #[test]
    fn pending_phase_wait_timeout_returns_pending_for_retry_message() {
        let _phase_guard = TEST_PHASE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        set_phase(HostPhase::Pending);
        let error = tauri::async_runtime::block_on(resolved_phase_for_command_with_timeout(
            Duration::from_millis(1),
        ))
        .unwrap_err();
        assert_eq!(error, HOST_PHASE_RETRY_MESSAGE);
        assert!(!error.to_ascii_lowercase().contains("daemon"));
        set_phase(HostPhase::Legacy);
    }

    #[test]
    fn daemon_mode_controls_and_lifecycle_do_not_spawn_a_sync_runner() {
        let _phase_guard = TEST_PHASE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        TEST_DAEMON_COMMANDS_ENABLED.store(true, Ordering::Release);
        TEST_DAEMON_COMMANDS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        crate::commands::process::reset_sync_runner_spawn_attempts();
        set_phase(HostPhase::Daemon);

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let mut sync_now_called = false;
        assert_eq!(
            daemon_sync_now_for_phase(HostPhase::Daemon, None, || {
                sync_now_called = true;
                request_daemon_sync_now()
            }),
            Some(Ok("hq-daemon-sync".to_string()))
        );
        assert!(sync_now_called);
        assert_eq!(
            daemon_env_change_action(
                HostPhase::Daemon,
                false,
                &HashMap::from([("HQ_DAEMON_INSTANT_SYNC".to_string(), "1".to_string())]),
                &HashMap::from([("HQ_DAEMON_INSTANT_SYNC".to_string(), "0".to_string())]),
            ),
            DaemonEnvChangeAction::PersistInstantSync(false)
        );
        request_daemon_instant_sync_enabled(false).unwrap();
        assert!(!crate::commands::sync::cancel_sync());
        assert!(crate::commands::daemon::start_daemon(handle.clone()).is_ok());
        assert!(crate::commands::daemon::start_daemon_for_app_launch(handle.clone()).is_ok());
        assert!(
            crate::commands::daemon::start_daemon_for_supervisor_respawn(handle.clone()).is_ok()
        );
        assert!(crate::commands::daemon::stop_daemon().is_ok());
        assert!(set_daemon_sync(false).is_ok());
        assert!(set_daemon_sync(true).is_ok());
        assert!(
            tauri::async_runtime::block_on(crate::commands::sync_mode::get_sync_mode(
                "acme".to_string()
            ))
            .is_ok()
        );
        assert!(
            tauri::async_runtime::block_on(crate::commands::sync_mode::set_sync_mode(
                "acme".to_string(),
                "shared".to_string()
            ))
            .is_ok()
        );
        assert!(!legacy_services_enabled(current_phase()));
        assert_eq!(crate::commands::process::sync_runner_spawn_attempts(), 0);

        let calls = TEST_DAEMON_COMMANDS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "instant-sync", "set", "off", "--json"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "now", "--json"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "pause", "--json"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "resume", "--json"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "enable", "sync"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "mode", "get", "acme", "--json"]));
        assert!(calls
            .iter()
            .any(|args| args == &["daemon", "sync", "mode", "set", "acme", "shared", "--json"]));

        TEST_DAEMON_COMMANDS_ENABLED.store(false, Ordering::Release);
        set_phase(HostPhase::Legacy);
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
