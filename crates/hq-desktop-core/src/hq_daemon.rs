//! `hq daemon` hosted by the desktop app (flag `desktop.hq-daemon`).
//!
//! With the flag on, the app runs `hq daemon run --managed --host desktop` as
//! its child instead of its own sync runner, supervisor, npx prewarm, Work Mesh
//! installer and CLI updater. The daemon supervises sync, mesh, bots, search
//! indexing and updates itself. This module holds the pure pieces: when to use
//! the daemon, how to start and relaunch it, and the files the app shares with
//! it. The daemon's formats are defined in hq-cli (`src/lib/daemon/`); the
//! end-of-pass record is hq-cloud's `sync-last-pass.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// hq-flags key that turns the hosted daemon on.
pub const HQ_DAEMON_FLAG: &str = "desktop.hq-daemon";

/// First hq-cli release with `hq daemon run --host desktop`.
pub const HQ_DAEMON_HOST_MIN_CLI: &str = "5.266.0";

/// Exit code the daemon uses to ask its parent to start it again (after a CLI update).
pub const DAEMON_RESTART_EXIT_CODE: i32 = 75;

const RELAUNCH_BASE_SECS: u64 = 5;
const RELAUNCH_MAX_SECS: u64 = 300;

/// Why the app keeps running its own background services.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyReason {
    FlagOff,
    /// `hq` would run through npx; that copy is neither kept nor updated, so it cannot host a daemon.
    CliNotInstalled,
    CliTooOld { found: String },
}

impl LegacyReason {
    pub fn describe(&self) -> String {
        match self {
            LegacyReason::FlagOff => format!("{HQ_DAEMON_FLAG} is off"),
            LegacyReason::CliNotInstalled => "hq is not installed locally".to_string(),
            LegacyReason::CliTooOld { found } => {
                format!("hq {found} is older than {HQ_DAEMON_HOST_MIN_CLI}")
            }
        }
    }
}

/// Who runs the background services on this launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncHostMode {
    Legacy(LegacyReason),
    Daemon,
}

/// Decide the host once per launch from the flag and the installed CLI.
pub fn choose_sync_host(
    flag_on: bool,
    cli_installed_locally: bool,
    cli_version: Option<&str>,
) -> SyncHostMode {
    if !flag_on {
        return SyncHostMode::Legacy(LegacyReason::FlagOff);
    }
    if !cli_installed_locally {
        return SyncHostMode::Legacy(LegacyReason::CliNotInstalled);
    }
    let min = semver::Version::parse(HQ_DAEMON_HOST_MIN_CLI).expect("valid minimum version");
    match cli_version.map(|v| semver::Version::parse(v.trim().trim_start_matches('v'))) {
        Some(Ok(found)) if found >= min => SyncHostMode::Daemon,
        _ => SyncHostMode::Legacy(LegacyReason::CliTooOld {
            found: cli_version.unwrap_or("unknown").trim().to_string(),
        }),
    }
}

/// Arguments after `hq` that start the hosted daemon.
pub fn daemon_run_args() -> Vec<&'static str> {
    vec!["daemon", "run", "--managed", "--host", "desktop"]
}

/// What the host does after the daemon process exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAction {
    RelaunchNow,
    RelaunchAfter(Duration),
    GiveUp(String),
}

/// `consecutive_failures` counts earlier failed runs in a row (0 for the first).
pub fn after_daemon_exit(
    code: Option<i32>,
    consecutive_failures: u32,
    another_daemon_running: bool,
) -> HostAction {
    if code == Some(DAEMON_RESTART_EXIT_CODE) {
        return HostAction::RelaunchNow;
    }
    if another_daemon_running {
        return HostAction::GiveUp("another hq daemon is already running on this machine".into());
    }
    let factor = 1u64.checked_shl(consecutive_failures.min(16)).unwrap_or(u64::MAX);
    let secs = RELAUNCH_BASE_SECS.saturating_mul(factor).min(RELAUNCH_MAX_SECS);
    HostAction::RelaunchAfter(Duration::from_secs(secs))
}

/// The daemon's folder and the files the app reads or writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonPaths {
    pub root: PathBuf,
    pub lock: PathBuf,
    pub state: PathBuf,
    pub requests: PathBuf,
}

/// `~/.hq/daemon`, or `HQ_DAEMON_DIR` when set (as in hq-cli's `daemonPaths`).
pub fn daemon_paths(home: &Path, daemon_dir: Option<&str>) -> DaemonPaths {
    let root = match daemon_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => home.join(".hq").join("daemon"),
    };
    DaemonPaths {
        lock: root.join("daemon.pid"),
        state: root.join("state.json"),
        requests: root.join("requests"),
        root,
    }
}

/// Paths for this user, honouring `HQ_DAEMON_DIR` from the app's environment.
pub fn default_daemon_paths() -> Option<DaemonPaths> {
    let home = crate::paths::home_dir()?;
    let dir = std::env::var("HQ_DAEMON_DIR").ok();
    Some(daemon_paths(&home, dir.as_deref()))
}

/// The pid in the daemon's lock file (`pid=<n>\nts=<secs>`) when that process is alive.
pub fn running_daemon_pid(lock: &Path, alive: impl Fn(u32) -> bool) -> Option<u32> {
    let raw = fs::read_to_string(lock).ok()?;
    let pid = raw
        .lines()
        .find_map(|line| line.trim().strip_prefix("pid="))
        .and_then(|v| v.trim().parse::<u32>().ok())?;
    alive(pid).then_some(pid)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitState {
    pub id: String,
    pub service: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub started_at: Option<u64>,
}

/// hq-cli's `DaemonState` (`state.json`); fields the app does not use are ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub pid: u32,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub units: Vec<UnitState>,
}

impl DaemonState {
    pub fn unit(&self, id: &str) -> Option<&UnitState> {
        self.units.iter().find(|u| u.id == id)
    }
}

pub fn read_daemon_state(path: &Path) -> Option<DaemonState> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// A request the daemon picks up from its `requests/` folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum ControlRequest {
    Restart { unit: String },
    Stop { unit: String },
}

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write a request as `<15-digit ms>-<6-digit seq>-<hex>.json` (temp file, then
/// rename), the format hq-cli's `writeControlRequest` uses so the daemon
/// handles requests oldest first.
pub fn write_control_request(dir: &Path, request: &ControlRequest) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed) % 1_000_000;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("{ms:015}-{seq:06}-{}.json", &nonce[..8]);
    let body = serde_json::to_vec(request).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, body)?;
    let path = dir.join(name);
    fs::rename(&tmp, &path)?;
    Ok(path)
}

/// hq-cloud's `sync-last-pass.json`: the events of the last finished watch pass.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPass {
    pub pass_id: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub dropped_progress: u64,
    pub events: Vec<serde_json::Value>,
}

pub fn last_pass_path(state_dir: &Path) -> PathBuf {
    state_dir.join("sync-last-pass.json")
}

pub fn read_last_pass(path: &Path) -> Option<LastPass> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Hands out each pass once. A pass already on disk at launch was handled by
/// whoever ran then, so it is skipped.
#[derive(Debug, Default)]
pub struct LastPassTracker {
    seen: Option<String>,
}

impl LastPassTracker {
    pub fn starting_after(existing: Option<LastPass>) -> Self {
        Self {
            seen: existing.map(|p| p.pass_id),
        }
    }

    pub fn take_new(&mut self, pass: Option<LastPass>) -> Option<LastPass> {
        let pass = pass?;
        if self.seen.as_deref() == Some(pass.pass_id.as_str()) {
            return None;
        }
        self.seen = Some(pass.pass_id.clone());
        Some(pass)
    }
}
