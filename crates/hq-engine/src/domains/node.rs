//! Managed Node.js, install, package, daemon, and sync-runner command owner.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use hq_engine_protocol::method;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::local::CoreBackend;
use crate::{CancellationFlag, EngineError, EngineEventBus};

#[path = "node_integrity.rs"]
mod node_integrity;
use node_integrity::{
    atomic_write_bytes, compute_checksums_at, parse_locked_paths, settings_json_with_env_path,
    validate_locked_restore_path,
};

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    "cancel_content_download",
    "cancel_install",
    "cancel_process",
    "cancel_sync",
    "check_dep",
    "check_core_state",
    "check_hq_cli_update",
    "check_pack_update",
    "check_package_updates",
    "compute_checksums",
    "configure_claude_settings_path",
    method::CONNECT_WORKSPACE_TO_CLOUD,
    "download_staging_tarball",
    "fetch_and_extract_template",
    "install_claude_code",
    "install_default_packages",
    "install_deps",
    "install_gh",
    "install_git",
    "install_homebrew",
    "install_hq_cli",
    "install_hq_cli_update",
    "install_hq_core_update",
    "install_marketplace_pack",
    "install_node",
    "install_package",
    "install_qmd",
    "install_yq",
    "list_packages",
    "register_search_index",
    "resolve_conflict",
    "restore_from_upstream",
    "run_replace_from_staging",
    "spawn_process",
    "start_daemon",
    "start_initial_cloud_sync",
    "start_sync",
    "stop_daemon",
    method::SUBMIT_BUG_REPORT,
    "uninstall_package",
    "update_package",
    "update_packs",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessSpec {
    program: PathBuf,
    args: Vec<OsString>,
    current_dir: PathBuf,
    env: Vec<(String, OsString)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const PROCESS_TERM_GRACE: Duration = Duration::from_secs(2);
const EXTERNAL_SYNC_PROGRESS_POLL_INTERVAL: Duration = Duration::from_secs(1);

type SyncProgressReader =
    Arc<dyn Fn() -> Option<hq_desktop_core::sync_progress::SyncProgressSnapshot> + Send + Sync>;

#[derive(Debug)]
pub(crate) struct ExternalSyncProgressWatcher {
    shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ExternalSyncProgressWatcher {
    pub(crate) fn shutdown(&self) {
        if let Some(shutdown_tx) = self
            .shutdown_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = shutdown_tx.send(());
        }
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExternalSyncProgressKey {
    pid: i64,
    phase: String,
    files_done: u64,
    files_total: u64,
    current_file: Option<String>,
}

fn spawn_external_sync_progress_watcher(
    bus: EngineEventBus,
    poll_interval: Duration,
    reader: SyncProgressReader,
) -> Arc<ExternalSyncProgressWatcher> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("hq-external-sync-progress".to_string())
        .spawn(move || {
            let mut was_active = false;
            let mut last_key: Option<ExternalSyncProgressKey> = None;
            loop {
                match shutdown_rx.recv_timeout(poll_interval) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }

                match reader() {
                    Some(snapshot) if snapshot.status == "syncing" => {
                        let key = ExternalSyncProgressKey {
                            pid: snapshot.pid,
                            phase: snapshot.phase.clone(),
                            files_done: snapshot.files_done,
                            files_total: snapshot.files_total,
                            current_file: snapshot.current_file.clone(),
                        };
                        if last_key.as_ref() != Some(&key) {
                            last_key = Some(key);
                            if let Ok(data) = serde_json::to_value(&snapshot) {
                                bus.emit(crate::EngineDomainEvent::new(
                                    None,
                                    "sync:external-progress",
                                    data,
                                ));
                            }
                        }
                        was_active = true;
                    }
                    _ => {
                        if was_active {
                            was_active = false;
                            last_key = None;
                            bus.emit(crate::EngineDomainEvent::new(
                                None,
                                "sync:external-idle",
                                Value::Null,
                            ));
                        }
                    }
                }
            }
        })
        .expect("external sync progress watcher thread should spawn");
    Arc::new(ExternalSyncProgressWatcher {
        shutdown_tx: Mutex::new(Some(shutdown_tx)),
        worker: Mutex::new(Some(worker)),
    })
}

pub(crate) fn start_external_sync_progress_watcher(
    bus: EngineEventBus,
) -> Arc<ExternalSyncProgressWatcher> {
    spawn_external_sync_progress_watcher(
        bus,
        EXTERNAL_SYNC_PROGRESS_POLL_INTERVAL,
        Arc::new(hq_desktop_core::sync_progress::read_fresh_snapshot),
    )
}

#[derive(Debug, Clone, Default)]
struct OutputRedactor {
    secrets: Vec<String>,
}

impl OutputRedactor {
    fn from_env(env: &[(String, OsString)]) -> Self {
        let mut secrets = env
            .iter()
            .filter(|(key, _)| is_sensitive_env_key(key))
            .filter_map(|(_, value)| {
                let value = value.to_string_lossy().into_owned();
                (value.len() >= 4).then_some(value)
            })
            .collect::<Vec<_>>();
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        secrets.dedup();
        Self { secrets }
    }

    fn redact(&self, line: &str) -> String {
        let mut redacted = line.to_string();
        for secret in &self.secrets {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
        for marker in [
            "Bearer ",
            "bearer ",
            "access_token=",
            "accessToken=",
            "refresh_token=",
            "refreshToken=",
            "id_token=",
            "idToken=",
            "token=",
            "password=",
            "secret=",
        ] {
            redacted = redact_value_after_marker(&redacted, marker);
        }
        redacted
    }
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "AUTH",
        "API_KEY",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn redact_value_after_marker(input: &str, marker: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(marker) {
        let (before, matched_and_after) = rest.split_at(index);
        output.push_str(before);
        output.push_str(marker);
        let after = &matched_and_after[marker.len()..];
        if let Some(already_redacted) = after.strip_prefix("[REDACTED]") {
            output.push_str("[REDACTED]");
            rest = already_redacted;
            continue;
        }
        output.push_str("[REDACTED]");
        let token_end = after
            .find(|character: char| {
                character.is_whitespace()
                    || matches!(character, ',' | ';' | '"' | '\'' | ')' | ']' | '}')
            })
            .unwrap_or(after.len());
        rest = &after[token_end..];
    }
    output.push_str(rest);
    output
}

fn gui_safe_path() -> String {
    hq_desktop_core::paths::child_path()
}

fn find_executable(tool: &str, search_path: &str) -> Option<PathBuf> {
    if tool.contains(std::path::MAIN_SEPARATOR) {
        let path = PathBuf::from(tool);
        return path.is_file().then_some(path);
    }
    std::env::split_paths(search_path)
        .map(|directory| directory.join(tool))
        .find(|candidate| candidate.is_file())
}

fn check_dep_in(tool: &str, search_path: &str) -> Value {
    let Some(path) = find_executable(tool, search_path) else {
        return json!({"installed":false,"version":null,"path":null});
    };

    #[cfg(target_os = "macos")]
    if tool == "git" && path == Path::new("/usr/bin/git") {
        let command_line_tools_are_present = Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !command_line_tools_are_present {
            return json!({"installed":false,"version":null,"path":null});
        }
    }

    let version = Command::new(&path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
        .and_then(|output| {
            let bytes = if !output.stdout.is_empty() {
                output.stdout
            } else {
                output.stderr
            };
            String::from_utf8(bytes)
                .ok()
                .and_then(|text| text.lines().next().map(str::trim).map(str::to_string))
                .filter(|line| !line.is_empty())
        });
    json!({
        "installed": true,
        "version": version,
        "path": path.to_string_lossy()
    })
}

fn parse_spawn_process_spec(
    params: &Value,
    default_cwd: &Path,
) -> Result<ProcessSpec, EngineError> {
    let outer = params.as_object().ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            "`spawn_process` params must be a JSON object",
            false,
        )
    })?;
    let object = outer
        .get("args")
        .and_then(Value::as_object)
        .unwrap_or(outer);
    let cmd = object.get("cmd").and_then(Value::as_str).ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            "`spawn_process` requires string param `args.cmd`",
            false,
        )
    })?;
    if cmd.trim().is_empty() {
        return Err(EngineError::new(
            "invalid_params",
            "`spawn_process` command cannot be empty",
            false,
        ));
    }
    let args = object
        .get("args")
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`spawn_process.args.args` must be an array of strings",
                        false,
                    )
                })?
                .iter()
                .map(|value| {
                    value.as_str().map(OsString::from).ok_or_else(|| {
                        EngineError::new(
                            "invalid_params",
                            "`spawn_process.args.args` must contain only strings",
                            false,
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let current_dir = object
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_cwd.to_path_buf());
    if !current_dir.is_dir() {
        return Err(EngineError::new(
            "invalid_params",
            format!(
                "`spawn_process` working directory does not exist: {}",
                current_dir.display()
            ),
            false,
        ));
    }
    let mut env = object
        .get("env")
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`spawn_process.args.env` must be an object of strings",
                        false,
                    )
                })?
                .iter()
                .map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), OsString::from(value)))
                        .ok_or_else(|| {
                            EngineError::new(
                                "invalid_params",
                                "`spawn_process.args.env` values must be strings",
                                false,
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if !env.iter().any(|(key, _)| key == "PATH") {
        env.push(("PATH".to_string(), gui_safe_path().into()));
    }
    Ok(ProcessSpec {
        program: PathBuf::from(cmd),
        args,
        current_dir,
        env,
    })
}

fn parse_sync_event_line(line: &str) -> Option<(&'static str, Value)> {
    use hq_desktop_core::events::{
        SyncEvent, EVENT_SYNC_ALL_COMPLETE, EVENT_SYNC_AUTH_ERROR, EVENT_SYNC_COMPLETE,
        EVENT_SYNC_DELETE_REFUSED_STALE_ETAG, EVENT_SYNC_ERROR, EVENT_SYNC_FANOUT_PLAN,
        EVENT_SYNC_NEW_FILES, EVENT_SYNC_PLAN, EVENT_SYNC_PROGRESS, EVENT_SYNC_SETUP_NEEDED,
    };

    let event = serde_json::from_str::<SyncEvent>(line.trim()).ok()?;
    match event {
        SyncEvent::SetupNeeded => Some((EVENT_SYNC_SETUP_NEEDED, Value::Null)),
        SyncEvent::AuthError(payload) => {
            Some((EVENT_SYNC_AUTH_ERROR, serde_json::to_value(payload).ok()?))
        }
        SyncEvent::FanoutPlan(payload) => {
            Some((EVENT_SYNC_FANOUT_PLAN, serde_json::to_value(payload).ok()?))
        }
        SyncEvent::Plan(payload) => Some((EVENT_SYNC_PLAN, serde_json::to_value(payload).ok()?)),
        SyncEvent::Progress(payload) => {
            Some((EVENT_SYNC_PROGRESS, serde_json::to_value(payload).ok()?))
        }
        SyncEvent::Error(payload) => Some((EVENT_SYNC_ERROR, serde_json::to_value(payload).ok()?)),
        SyncEvent::Complete(payload) => {
            Some((EVENT_SYNC_COMPLETE, serde_json::to_value(payload).ok()?))
        }
        SyncEvent::DeleteRefusedStaleEtag(payload) => Some((
            EVENT_SYNC_DELETE_REFUSED_STALE_ETAG,
            serde_json::to_value(payload).ok()?,
        )),
        SyncEvent::NewFiles(payload) => {
            Some((EVENT_SYNC_NEW_FILES, serde_json::to_value(payload).ok()?))
        }
        SyncEvent::AllComplete(payload) => {
            Some((EVENT_SYNC_ALL_COMPLETE, serde_json::to_value(payload).ok()?))
        }
    }
}

#[derive(Debug)]
struct ManagedProcessState {
    cancelled: Arc<AtomicBool>,
    pid: Option<u32>,
}

#[derive(Debug, Default)]
pub(crate) struct ManagedProcessRegistry {
    shutting_down: AtomicBool,
    processes: Mutex<HashMap<String, ManagedProcessState>>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl ManagedProcessRegistry {
    fn reserve(&self, handle: &str) -> Result<Arc<AtomicBool>, EngineError> {
        let mut processes = self
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(EngineError::new(
                "process_registry_shutting_down",
                "Managed processes cannot start while the engine is shutting down",
                false,
            ));
        }
        if processes.contains_key(handle) {
            return Err(EngineError::new(
                "process_already_running",
                format!("Process `{handle}` is already running"),
                false,
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        processes.insert(
            handle.to_string(),
            ManagedProcessState {
                cancelled: Arc::clone(&cancelled),
                pid: None,
            },
        );
        Ok(cancelled)
    }

    fn register_pid(&self, handle: &str, pid: u32) {
        let mut processes = self
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(state) = processes.get_mut(handle) {
            state.pid = Some(pid);
        }
    }

    fn deregister(&self, handle: &str) {
        self.processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(handle);
    }

    fn cancel(&self, handle: &str) -> bool {
        let (cancelled, pid) = {
            let processes = self
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(state) = processes.get(handle) else {
                return false;
            };
            (Arc::clone(&state.cancelled), state.pid)
        };
        cancelled.store(true, Ordering::Release);
        if let Some(pid) = pid {
            let _ = terminate_process_group(pid, false);
        }
        true
    }

    fn track_worker(&self, worker: thread::JoinHandle<()>) {
        let mut finished = Vec::new();
        {
            let mut workers = self
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    finished.push(workers.swap_remove(index));
                } else {
                    index += 1;
                }
            }
            if self.shutting_down.load(Ordering::Acquire) {
                finished.push(worker);
            } else {
                workers.push(worker);
            }
        }
        for worker in finished {
            let _ = worker.join();
        }
    }

    pub(crate) fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let active = self
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|state| (Arc::clone(&state.cancelled), state.pid))
            .collect::<Vec<_>>();
        for (cancelled, pid) in active {
            cancelled.store(true, Ordering::Release);
            if let Some(pid) = pid {
                let _ = terminate_process_group(pid, false);
            }
        }

        let workers = std::mem::take(
            &mut *self
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for worker in workers {
            let _ = worker.join();
        }
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(pid: u32, force: bool) -> Result<(), EngineError> {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    const SIGTERM: c_int = 15;
    const SIGKILL: c_int = 9;
    let signal = if force { SIGKILL } else { SIGTERM };
    let result = unsafe { kill(-(pid as c_int), signal) };
    if result == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(3) {
            Ok(())
        } else {
            Err(EngineError::new(
                "process_terminate_failed",
                format!("Could not terminate managed process {pid}: {error}"),
                true,
            ))
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: u32, _force: bool) -> Result<(), EngineError> {
    Err(EngineError::new(
        "process_terminate_unsupported",
        "Managed process termination is unsupported on this platform",
        false,
    ))
}

#[derive(Debug, Clone)]
enum StreamEventMode {
    Process {
        bus: EngineEventBus,
        handle: String,
    },
    Install {
        bus: EngineEventBus,
        handle: String,
    },
    Packages {
        bus: EngineEventBus,
        operation: String,
        name: String,
    },
    Marketplace {
        bus: EngineEventBus,
        source: String,
        scope: String,
    },
    Sync {
        backend: CoreBackend,
        planned_files: Arc<Mutex<u64>>,
    },
    PersonalFirstPush {
        backend: CoreBackend,
        state: Arc<Mutex<PersonalFirstPushState>>,
    },
}

#[derive(Debug, Default)]
struct PersonalFirstPushState {
    files_total: u64,
    files_done: u64,
    terminal_event_seen: bool,
}

fn parse_personal_first_push_line(
    line: &str,
    state: &mut PersonalFirstPushState,
) -> Option<(&'static str, Value)> {
    let event = serde_json::from_str::<Value>(line.trim()).ok()?;
    match event.get("type").and_then(Value::as_str)? {
        "plan" => {
            let upload = event
                .get("filesToUpload")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let skipped = event
                .get("filesToSkip")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            state.files_total = upload.saturating_add(skipped);
            state.files_done = 0;
            Some((
                "sync:personal-first-push-scan",
                json!({
                    "personUid":"personal",
                    "filesScanned":state.files_total,
                    "filesTotal":state.files_total,
                    "currentFile":Value::Null
                }),
            ))
        }
        "progress" => {
            let path = event
                .get("path")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())?;
            state.files_done = state.files_done.saturating_add(1);
            state.files_total = state.files_total.max(state.files_done);
            Some((
                "sync:personal-first-push-progress",
                json!({
                    "personUid":"personal",
                    "filesDone":state.files_done,
                    "filesTotal":state.files_total,
                    "currentFile":path
                }),
            ))
        }
        "complete" => {
            let uploaded = event.get("filesUploaded").and_then(Value::as_u64)?;
            let skipped = event
                .get("filesSkipped")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            state.terminal_event_seen = true;
            Some((
                "sync:personal-first-push-complete",
                json!({
                    "personUid":"personal",
                    "filesUploaded":uploaded,
                    "filesSkipped":skipped
                }),
            ))
        }
        "fatal" => {
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())?;
            state.terminal_event_seen = true;
            Some((
                "sync:error",
                json!({
                    "company":"personal",
                    "path":"(initial-sync)",
                    "message":message
                }),
            ))
        }
        "error" => {
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())?;
            Some((
                "sync:error",
                json!({
                    "company":"personal",
                    "path":event.get("path").and_then(Value::as_str).unwrap_or("(initial-sync)"),
                    "message":message
                }),
            ))
        }
        _ => None,
    }
}

impl StreamEventMode {
    fn emit_line(&self, stdout: bool, line: &str) {
        match self {
            Self::Process { bus, handle } => {
                let stream = if stdout { "stdout" } else { "stderr" };
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    format!("process://{handle}/{stream}"),
                    json!({"line":line}),
                ));
            }
            Self::Install { bus, handle } => {
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    "install:progress",
                    json!({
                        "handle":handle,
                        "line":line,
                        "finished":false,
                        "error":null
                    }),
                ));
            }
            Self::Packages {
                bus,
                operation,
                name,
            } => {
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    "packages:progress",
                    json!({"op":operation,"name":name,"line":line}),
                ));
            }
            Self::Marketplace { bus, source, scope } => {
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    "marketplace:install-progress",
                    json!({"source":source,"scope":scope,"line":line}),
                ));
            }
            Self::Sync {
                backend,
                planned_files,
            } if stdout => {
                if let Some((name, payload)) = parse_sync_event_line(line) {
                    backend.record_sync_activity(name, &payload);
                    backend.emit_domain_event(None, name, payload.clone());
                    if name == "sync:plan" {
                        let increment = ["filesToDownload", "filesToUpload", "filesToDelete"]
                            .iter()
                            .filter_map(|key| payload.get(*key).and_then(Value::as_u64))
                            .sum::<u64>();
                        let total = {
                            let mut total = planned_files
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            *total = total.saturating_add(increment);
                            *total
                        };
                        backend.emit_domain_event(None, "sync:totals", json!({"totalFiles":total}));
                    }
                }
            }
            Self::Sync { .. } => {}
            Self::PersonalFirstPush { backend, state } if !stdout => {
                let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
                if let Some((name, payload)) = parse_personal_first_push_line(line, &mut state) {
                    backend.record_sync_activity(name, &payload);
                    backend.emit_domain_event(None, name, payload);
                }
            }
            Self::PersonalFirstPush { .. } => {}
        }
    }

    fn emit_terminal(&self, output: &ProcessOutput, error: Option<&str>) {
        match self {
            Self::Sync { .. } => {}
            Self::PersonalFirstPush { backend, state } => {
                let state = state.lock().unwrap_or_else(|error| error.into_inner());
                if !state.terminal_event_seen {
                    backend.emit_domain_event(
                        None,
                        "sync:error",
                        json!({
                            "company":"personal",
                            "path":"(initial-sync)",
                            "message":error.unwrap_or(if output.success {
                                "HQ CLI exited without a personal first-push completion event"
                            } else {
                                "HQ CLI personal first-push failed"
                            })
                        }),
                    );
                }
            }
            Self::Process { bus, handle } => {
                let signal = None::<i32>;
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    format!("process://{handle}/exit"),
                    json!({
                        "code": output.code,
                        "signal": signal,
                        "success": output.success
                    }),
                ));
            }
            Self::Install { bus, handle } => {
                bus.emit(crate::EngineDomainEvent::new(
                    None,
                    "install:progress",
                    json!({
                        "handle":handle,
                        "line":"",
                        "finished":true,
                        "error":error
                    }),
                ));
            }
            Self::Packages {
                bus,
                operation,
                name,
            } => {
                let (event, data) = match error {
                    Some(message) => (
                        "packages:error",
                        json!({"op":operation,"name":name,"message":message}),
                    ),
                    None => ("packages:complete", json!({"op":operation,"name":name})),
                };
                bus.emit(crate::EngineDomainEvent::new(None, event, data));
            }
            Self::Marketplace { bus, source, scope } => {
                let (event, data) = match error {
                    Some(message) => (
                        "marketplace:install-error",
                        json!({"source":source,"scope":scope,"message":message}),
                    ),
                    None => (
                        "marketplace:install-complete",
                        json!({"source":source,"scope":scope}),
                    ),
                };
                bus.emit(crate::EngineDomainEvent::new(None, event, data));
            }
        }
    }
}

fn append_capped(target: &mut Vec<u8>, line: &str) {
    if target.len() >= MAX_CAPTURE_BYTES {
        return;
    }
    let remaining = MAX_CAPTURE_BYTES - target.len();
    let bytes = line.as_bytes();
    target.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    if target.len() < MAX_CAPTURE_BYTES {
        target.push(b'\n');
    }
}

fn drain_stream_lines<R>(
    reader: R,
    stdout: bool,
    emitter: StreamEventMode,
    redactor: OutputRedactor,
) -> thread::JoinHandle<Result<Vec<u8>, EngineError>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut captured = Vec::new();
        for line in BufReader::new(reader).lines() {
            let line = line.map_err(|error| {
                EngineError::new(
                    "process_pipe_failed",
                    format!("Failed reading child output: {error}"),
                    true,
                )
            })?;
            let line = redactor.redact(&line);
            append_capped(&mut captured, &line);
            emitter.emit_line(stdout, &line);
        }
        Ok(captured)
    })
}

fn join_stream_lines(
    task: thread::JoinHandle<Result<Vec<u8>, EngineError>>,
    label: &str,
) -> Result<Vec<u8>, EngineError> {
    task.join().map_err(|_| {
        EngineError::new(
            "process_pipe_failed",
            format!("{label} reader thread panicked"),
            false,
        )
    })?
}

fn run_reserved_managed_process(
    registry: &ManagedProcessRegistry,
    handle: &str,
    spec: &ProcessSpec,
    request_cancellation: &CancellationFlag,
    process_cancellation: Arc<AtomicBool>,
    emitter: StreamEventMode,
) -> Result<ProcessOutput, EngineError> {
    request_cancellation.check()?;
    let redactor = OutputRedactor::from_env(&spec.env);
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| {
        registry.deregister(handle);
        EngineError::new(
            "process_spawn_failed",
            format!("Failed to spawn `{}`: {error}", spec.program.display()),
            true,
        )
    })?;
    registry.register_pid(handle, child.id());
    let stdout = child.stdout.take().ok_or_else(|| {
        EngineError::new(
            "process_pipe_failed",
            "Spawned process did not expose stdout",
            false,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        EngineError::new(
            "process_pipe_failed",
            "Spawned process did not expose stderr",
            false,
        )
    })?;
    let stdout_task = drain_stream_lines(stdout, true, emitter.clone(), redactor.clone());
    let stderr_task = drain_stream_lines(stderr, false, emitter.clone(), redactor);
    let mut cancellation_started = None;
    let mut force_sent = false;

    let status = loop {
        let should_cancel =
            request_cancellation.is_cancelled() || process_cancellation.load(Ordering::Acquire);
        if should_cancel {
            if cancellation_started.is_none() {
                let _ = terminate_process_group(child.id(), false);
                cancellation_started = Some(Instant::now());
            } else if !force_sent
                && cancellation_started
                    .is_some_and(|started| started.elapsed() >= PROCESS_TERM_GRACE)
            {
                let _ = terminate_process_group(child.id(), true);
                force_sent = true;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(error) => {
                let _ = terminate_process_group(child.id(), true);
                let _ = child.wait();
                registry.deregister(handle);
                let _ = join_stream_lines(stdout_task, "stdout");
                let _ = join_stream_lines(stderr_task, "stderr");
                return Err(EngineError::new(
                    "process_wait_failed",
                    format!(
                        "Failed while waiting for `{}`: {error}",
                        spec.program.display()
                    ),
                    true,
                ));
            }
        }
    };
    let stdout = join_stream_lines(stdout_task, "stdout")?;
    let stderr = join_stream_lines(stderr_task, "stderr")?;
    let was_cancelled =
        request_cancellation.is_cancelled() || process_cancellation.load(Ordering::Acquire);
    registry.deregister(handle);
    let output = ProcessOutput {
        success: status.success() && !was_cancelled,
        code: status.code(),
        stdout,
        stderr,
    };
    let error_message = if was_cancelled {
        Some("Cancelled by user".to_string())
    } else if output.success {
        None
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Some(if detail.is_empty() {
            format!("Process exited with code {}", output.code.unwrap_or(-1))
        } else {
            format!(
                "Process exited with code {}: {detail}",
                output.code.unwrap_or(-1)
            )
        })
    };
    emitter.emit_terminal(&output, error_message.as_deref());
    if was_cancelled {
        Err(EngineError::cancelled())
    } else {
        Ok(output)
    }
}

fn run_managed_process(
    registry: &ManagedProcessRegistry,
    handle: &str,
    spec: &ProcessSpec,
    cancellation: &CancellationFlag,
    emitter: StreamEventMode,
) -> Result<ProcessOutput, EngineError> {
    let process_cancellation = registry.reserve(handle)?;
    run_reserved_managed_process(
        registry,
        handle,
        spec,
        cancellation,
        process_cancellation,
        emitter,
    )
}

fn spawn_background_process(
    registry: Arc<ManagedProcessRegistry>,
    handle: String,
    spec: ProcessSpec,
    emitter: StreamEventMode,
) -> Result<String, EngineError> {
    let process_cancellation = registry.reserve(&handle)?;
    let worker_handle = handle.clone();
    let worker_registry = Arc::clone(&registry);
    let worker = thread::Builder::new()
        .name(format!("hq-process-{handle}"))
        .spawn(move || {
            let result = run_reserved_managed_process(
                &worker_registry,
                &worker_handle,
                &spec,
                &CancellationFlag::default(),
                process_cancellation,
                emitter.clone(),
            );
            if let Err(error) = result {
                if error.code == "process_spawn_failed" {
                    let output = ProcessOutput {
                        success: false,
                        code: Some(-1),
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                    };
                    emitter.emit_terminal(&output, Some(&error.message));
                }
                worker_registry.deregister(&worker_handle);
            }
        })
        .map_err(|error| {
            registry.deregister(&handle);
            EngineError::new(
                "process_worker_failed",
                format!("Could not start managed process worker: {error}"),
                true,
            )
        })?;
    registry.track_worker(worker);
    Ok(handle)
}

fn hq_process_spec(
    hq_root: &Path,
    args: impl IntoIterator<Item = impl Into<OsString>>,
) -> ProcessSpec {
    let path = gui_safe_path();
    let hq = find_executable("hq", &path).unwrap_or_else(|| PathBuf::from("hq"));
    ProcessSpec {
        program: hq,
        args: args.into_iter().map(Into::into).collect(),
        current_dir: hq_root.to_path_buf(),
        env: vec![
            ("PATH".to_string(), path.into()),
            ("HQ_NO_UPDATE_CHECK".to_string(), "1".into()),
            ("HQ_ROOT".to_string(), hq_root.as_os_str().to_os_string()),
        ],
    }
}

fn run_required_process<R: ProcessRunner>(
    runner: &R,
    spec: &ProcessSpec,
    cancellation: &CancellationFlag,
    error_code: &str,
) -> Result<ProcessOutput, EngineError> {
    let output = runner.run(spec, cancellation)?;
    if output.success {
        Ok(output)
    } else {
        let redactor = OutputRedactor::from_env(&spec.env);
        Err(EngineError::new(
            error_code,
            process_failure_message(spec, &output, &redactor),
            true,
        ))
    }
}

fn run_json_process<R: ProcessRunner>(
    runner: &R,
    spec: &ProcessSpec,
    cancellation: &CancellationFlag,
    error_code: &str,
) -> Result<Value, EngineError> {
    let output = run_required_process(runner, spec, cancellation, error_code)?;
    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        EngineError::new(
            error_code,
            format!("Command returned non-UTF-8 JSON: {error}"),
            false,
        )
    })?;
    serde_json::from_str(stdout.trim()).map_err(|error| {
        EngineError::new(
            error_code,
            format!("Command returned invalid JSON: {error}"),
            false,
        )
    })
}

fn gather_packages<R: ProcessRunner>(
    runner: &R,
    hq_root: &Path,
    cancellation: &CancellationFlag,
    check_updates: bool,
) -> Value {
    let mut pack_args = vec!["packs", "list", "--json"];
    if check_updates {
        pack_args.push("--check-updates");
    }
    let packs_result = run_json_process(
        runner,
        &hq_process_spec(hq_root, pack_args),
        cancellation,
        "list_packages_failed",
    );
    let (packs, error) = match packs_result {
        Ok(value) => (value, Value::Null),
        Err(error) => (Value::Null, Value::String(error.message)),
    };
    let registry = run_json_process(
        runner,
        &hq_process_spec(hq_root, ["packages", "list", "--json"]),
        cancellation,
        "list_packages_failed",
    )
    .unwrap_or(Value::Null);
    json!({"packs":packs,"registry":registry,"error":error})
}

fn pack_update_summary(packs: &Value) -> Value {
    let names = packs
        .get("installed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("updateAvailable").and_then(Value::as_bool) == Some(true))
        .filter_map(|entry| entry.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    json!({"count":names.len(),"names":names})
}

fn stream_hq_operation<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    hq_root: &Path,
    operation: &str,
    name: &str,
    args: Vec<String>,
    cancellation: &CancellationFlag,
) -> Result<(), EngineError> {
    let spec = hq_process_spec(hq_root, args);
    let handle = format!("hq-package-{}", uuid::Uuid::new_v4());
    let output = runner.run_streaming(
        &spec,
        cancellation,
        &handle,
        StreamEventMode::Packages {
            bus: backend.event_bus(),
            operation: operation.to_string(),
            name: name.to_string(),
        },
    )?;
    if output.success {
        Ok(())
    } else {
        let redactor = OutputRedactor::from_env(&spec.env);
        Err(EngineError::new(
            "package_command_failed",
            process_failure_message(&spec, &output, &redactor),
            true,
        ))
    }
}

fn manual_sync_spec(
    hq_root: &Path,
    company_slug: Option<&str>,
) -> Result<ProcessSpec, EngineError> {
    use hq_desktop_core::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};

    let path = gui_safe_path();
    let npx = find_executable("npx", &path).unwrap_or_else(|| PathBuf::from("npx"));
    let mut args = vec![
        OsString::from("-y"),
        OsString::from(format!("--package={HQ_CLOUD_PACKAGE}@{HQ_CLOUD_VERSION}")),
        OsString::from(RUNNER_BIN),
    ];
    if let Some(slug) = company_slug {
        let slug = slug.trim();
        if !hq_desktop_core::marketplace::is_safe_company_slug(slug) {
            return Err(EngineError::new(
                "invalid_params",
                format!("Invalid company slug: {slug:?}"),
                false,
            ));
        }
        args.extend([
            OsString::from("--company"),
            OsString::from(slug),
            OsString::from("--skip-personal"),
        ]);
    } else {
        args.push(OsString::from("--companies"));
    }
    args.extend([
        "--direction".into(),
        "both".into(),
        "--on-conflict".into(),
        "keep".into(),
        "--hq-root".into(),
        hq_root.as_os_str().to_os_string(),
    ]);
    Ok(ProcessSpec {
        program: npx,
        args,
        current_dir: hq_root.to_path_buf(),
        env: vec![
            ("PATH".to_string(), path.into()),
            ("HQ_ROOT".to_string(), hq_root.as_os_str().to_os_string()),
        ],
    })
}

fn daemon_process_spec(hq_root: &Path) -> ProcessSpec {
    let args = hq_desktop_core::daemon::build_watch_runner_args(&hq_root.to_string_lossy());
    ProcessSpec {
        program: PathBuf::from(args.cmd),
        args: args.args.into_iter().map(OsString::from).collect(),
        current_dir: args
            .cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| hq_root.to_path_buf()),
        env: args
            .env
            .unwrap_or_default()
            .into_iter()
            .map(|(key, value)| (key, value.into()))
            .collect(),
    }
}

fn personal_first_push_spec_for(
    hq_root: &Path,
    invocation: hq_desktop_core::hq_resolver::HqInvocation,
) -> ProcessSpec {
    use hq_desktop_core::hq_resolver::{HqInvocation, HQ_CLI_NPM_RANGE};

    let path = gui_safe_path();
    let (program, mut args) = match invocation {
        HqInvocation::Local(program) => (PathBuf::from(program), Vec::new()),
        HqInvocation::Npx => (
            find_executable("npx", &path).unwrap_or_else(|| PathBuf::from("npx")),
            vec![
                "-y".into(),
                "--package".into(),
                format!("@indigoai-us/hq-cli@{HQ_CLI_NPM_RANGE}").into(),
                "hq".into(),
            ],
        ),
    };
    args.extend([
        "sync".into(),
        "push".into(),
        "--personal".into(),
        "--json".into(),
        "--hq-root".into(),
        hq_root.as_os_str().to_os_string(),
    ]);
    ProcessSpec {
        program,
        args,
        current_dir: hq_root.to_path_buf(),
        env: vec![
            ("PATH".to_string(), path.into()),
            ("HQ_NO_UPDATE_CHECK".to_string(), "1".into()),
            ("HQ_ROOT".to_string(), hq_root.as_os_str().to_os_string()),
        ],
    }
}

fn personal_first_push_spec(hq_root: &Path) -> ProcessSpec {
    personal_first_push_spec_for(hq_root, hq_desktop_core::hq_resolver::resolve_hq())
}

const MANAGED_NODE_VERSION: &str = "v22.17.0";
const MANAGED_NODE_SHA256_ARM64: &str =
    "615dda58b5fb41fad2be43940b6398ca56554cbe05800953afadc724729cb09e";
const MANAGED_NODE_SHA256_X64: &str =
    "c39c8ec3cdadedfcc75de0cb3305df95ae2aecebc5db8d68a9b67bd74616d2ad";
const MANAGED_GIT_RELEASE: &str = "v2.53.0-3";
const MANAGED_GIT_BUILD: &str = "v2.53.0-f49d009";
const MANAGED_GIT_SHA256_ARM64: &str =
    "e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437";
const MANAGED_GIT_SHA256_X64: &str =
    "caf27c36b8834969550535bcd5e58186f970e080d1e175e76d9c1de3aac409ed";
const YQ_BINARY_VERSION: &str = "v4.53.2";
const YQ_BINARY_SHA256_AMD64: &str =
    "616b0a0f6a5b79d746f05a169c2b9bb40dee00c605ef165b9a1c1681bba738ac";
const YQ_BINARY_SHA256_ARM64: &str =
    "541ba2287560df70f561955e2d7f7e1cd00cf2a15a884f6b5c87a4bfa887bc07";
const MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const PROD_HQ_CORE_REPO: &str = "indigoai-us/hq-core";
const STAGING_HQ_CORE_REPO: &str = "indigoai-us/hq-core-staging";
const PROD_HQ_CORE_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/indigoai-us/hq-core/releases/latest";

fn user_home() -> Result<PathBuf, EngineError> {
    std::env::var_os("HQ_TEST_HOME")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            EngineError::new(
                "home_directory_unavailable",
                "Could not resolve the current user's home directory",
                false,
            )
        })
}

fn managed_toolchain_dir(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Indigo HQ")
        .join("toolchain")
}

fn managed_node_dir(home: &Path) -> PathBuf {
    managed_toolchain_dir(home).join("node")
}

fn managed_git_dir(home: &Path) -> PathBuf {
    managed_toolchain_dir(home).join("git")
}

fn managed_npm_prefix(home: &Path) -> PathBuf {
    managed_toolchain_dir(home).join("npm-global")
}

fn install_progress(
    backend: &CoreBackend,
    handle: &str,
    line: impl Into<String>,
    finished: bool,
    error: Option<&str>,
) {
    backend.emit_domain_event(
        None,
        "install:progress",
        json!({
            "handle":handle,
            "line":line.into(),
            "finished":finished,
            "error":error
        }),
    );
}

fn download_bytes(
    url: &str,
    cancellation: &CancellationFlag,
    process_cancellation: &AtomicBool,
    progress: impl Fn(u64, Option<u64>),
) -> Result<Vec<u8>, EngineError> {
    cancellation.check()?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .user_agent("hq-native-macos")
        .build()
        .map_err(|error| {
            EngineError::new(
                "download_failed",
                format!("Could not create the download client: {error}"),
                true,
            )
        })?;
    let mut response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            EngineError::new("download_failed", format!("Download failed: {error}"), true)
        })?;
    let total = response.content_length();
    if total.is_some_and(|length| length > MAX_DOWNLOAD_BYTES as u64) {
        return Err(EngineError::new(
            "download_too_large",
            format!(
                "Download exceeds the {} byte safety limit",
                MAX_DOWNLOAD_BYTES
            ),
            false,
        ));
    }
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(MAX_DOWNLOAD_BYTES as u64) as usize);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        if cancellation.is_cancelled() || process_cancellation.load(Ordering::Acquire) {
            return Err(EngineError::cancelled());
        }
        let read = response.read(&mut chunk).map_err(|error| {
            EngineError::new(
                "download_failed",
                format!("Failed while reading the download: {error}"),
                true,
            )
        })?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_DOWNLOAD_BYTES {
            return Err(EngineError::new(
                "download_too_large",
                format!(
                    "Download exceeds the {} byte safety limit",
                    MAX_DOWNLOAD_BYTES
                ),
                false,
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

fn download_bytes_with_bearer(
    url: &str,
    bearer_token: Option<&str>,
    cancellation: &CancellationFlag,
    process_cancellation: &AtomicBool,
    progress: impl Fn(u64, Option<u64>),
) -> Result<Vec<u8>, EngineError> {
    cancellation.check()?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .user_agent("hq-native-macos")
        .build()
        .map_err(|error| {
            EngineError::new(
                "download_failed",
                format!("Could not create the download client: {error}"),
                true,
            )
        })?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json");
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let mut response = request
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            EngineError::new("download_failed", format!("Download failed: {error}"), true)
        })?;
    let total = response.content_length();
    if total.is_some_and(|length| length > MAX_DOWNLOAD_BYTES as u64) {
        return Err(EngineError::new(
            "download_too_large",
            format!(
                "Download exceeds the {} byte safety limit",
                MAX_DOWNLOAD_BYTES
            ),
            false,
        ));
    }
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(MAX_DOWNLOAD_BYTES as u64) as usize);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        if cancellation.is_cancelled() || process_cancellation.load(Ordering::Acquire) {
            return Err(EngineError::cancelled());
        }
        let read = response.read(&mut chunk).map_err(|error| {
            EngineError::new(
                "download_failed",
                format!("Failed while reading the download: {error}"),
                true,
            )
        })?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_DOWNLOAD_BYTES {
            return Err(EngineError::new(
                "download_too_large",
                format!(
                    "Download exceeds the {} byte safety limit",
                    MAX_DOWNLOAD_BYTES
                ),
                false,
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

struct ReservedOperationHandle {
    registry: Arc<ManagedProcessRegistry>,
    handle: String,
    cancelled: Arc<AtomicBool>,
}

impl ReservedOperationHandle {
    fn reserve(registry: Arc<ManagedProcessRegistry>, handle: String) -> Result<Self, EngineError> {
        let cancelled = registry.reserve(&handle)?;
        Ok(Self {
            registry,
            handle,
            cancelled,
        })
    }
}

impl Drop for ReservedOperationHandle {
    fn drop(&mut self) {
        self.registry.deregister(&self.handle);
    }
}

fn content_progress(
    backend: &CoreBackend,
    handle: &str,
    phase: &str,
    received_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: impl Into<String>,
) {
    let percent = received_bytes
        .zip(total_bytes)
        .filter(|(_, total)| *total > 0)
        .map(|(received, total)| ((received as f64 / total as f64) * 100.0).min(100.0));
    backend.emit_domain_event(
        None,
        "content:progress",
        json!({
            "handle": handle,
            "phase": phase,
            "receivedBytes": received_bytes,
            "totalBytes": total_bytes,
            "percent": percent,
            "slow": false,
            "stalled": false,
            "message": message.into()
        }),
    );
}

fn github_token_from_gh<R: ProcessRunner>(
    runner: &R,
    hq_root: &Path,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let path = gui_safe_path();
    let gh = find_executable("gh", &path).unwrap_or_else(|| PathBuf::from("gh"));
    let output = run_required_process(
        runner,
        &ProcessSpec {
            program: gh,
            args: vec!["auth".into(), "token".into()],
            current_dir: hq_root.to_path_buf(),
            env: vec![("PATH".to_string(), path.into())],
        },
        cancellation,
        "github_auth_failed",
    )?;
    let token = String::from_utf8(output.stdout)
        .map_err(|_| {
            EngineError::new(
                "github_auth_failed",
                "`gh auth token` returned non-UTF-8 output",
                false,
            )
        })?
        .trim()
        .to_string();
    if token.is_empty() {
        Err(EngineError::new(
            "github_auth_failed",
            "`gh auth token` returned empty output",
            false,
        ))
    } else {
        Ok(token)
    }
}

fn fetch_and_extract_template<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    requested_handle: Option<&str>,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let hq_root = backend.hq_root()?;
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&backend.menubar_path()?);
    let staging = menubar
        .get("stagingSource")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let handle = requested_handle
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let operation = ReservedOperationHandle::reserve(backend.managed_processes(), handle.clone())?;

    let (version, tarball_url, token, label) = if staging {
        (
            "main".to_string(),
            format!("https://api.github.com/repos/{STAGING_HQ_CORE_REPO}/tarball/main"),
            Some(github_token_from_gh(runner, &hq_root, cancellation)?),
            "staging main",
        )
    } else {
        let release = fetch_json_url(
            PROD_HQ_CORE_LATEST_RELEASE_URL,
            "fetch_template_release_failed",
        )?;
        let version = release
            .get("tag_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                EngineError::new(
                    "fetch_template_release_failed",
                    "Latest hq-core release is missing tag_name",
                    false,
                )
            })?
            .to_string();
        let tarball_url = release
            .get("tarball_url")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                EngineError::new(
                    "fetch_template_release_failed",
                    "Latest hq-core release is missing tarball_url",
                    false,
                )
            })?
            .to_string();
        (version, tarball_url, None, "latest stable release")
    };

    content_progress(
        backend,
        &handle,
        "download",
        Some(0),
        None,
        format!("Downloading HQ template ({label})"),
    );
    let bytes = download_bytes_with_bearer(
        &tarball_url,
        token.as_deref(),
        cancellation,
        &operation.cancelled,
        |received, total| {
            content_progress(
                backend,
                &handle,
                "download",
                Some(received),
                total,
                "Downloading HQ template",
            );
        },
    )?;
    content_progress(
        backend,
        &handle,
        "extract",
        Some(0),
        Some(bytes.len() as u64),
        "Extracting HQ template",
    );
    extract_tar_gz(&bytes, &hq_root, 1, cancellation, &operation.cancelled)?;
    content_progress(
        backend,
        &handle,
        "extract",
        Some(bytes.len() as u64),
        Some(bytes.len() as u64),
        "Extracted HQ template",
    );
    let _ = compute_checksums_at(&hq_root);
    content_progress(
        backend,
        &handle,
        "complete",
        None,
        None,
        "HQ template ready",
    );
    Ok(version)
}

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) -> Result<(), EngineError> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(EngineError::new(
            "checksum_mismatch",
            format!("{label} checksum mismatch"),
            false,
        ))
    }
}

fn safe_archive_path(path: &Path, strip_components: usize) -> Result<PathBuf, EngineError> {
    use std::path::Component;

    let mut safe = PathBuf::new();
    let mut normal_index = 0_usize;
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                if normal_index >= strip_components {
                    safe.push(part);
                }
                normal_index += 1;
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(EngineError::new(
                    "unsafe_archive",
                    format!("Archive entry escapes the destination: {}", path.display()),
                    false,
                ));
            }
        }
    }
    if safe.as_os_str().is_empty() {
        return Err(EngineError::new(
            "empty_archive_path",
            "Archive entry has no path after stripping its root directory",
            false,
        ));
    }
    Ok(safe)
}

fn safe_link_target(root: &Path, entry_path: &Path, target: &Path) -> Result<(), EngineError> {
    use std::path::Component;

    if target.is_absolute() {
        return Err(EngineError::new(
            "unsafe_archive",
            format!(
                "Archive link {} has an absolute target",
                entry_path.display()
            ),
            false,
        ));
    }
    let mut stack = entry_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    for component in target.components() {
        match component {
            Component::Normal(part) => stack.push(part.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return Err(EngineError::new(
                        "unsafe_archive",
                        format!(
                            "Archive link {} escapes the destination",
                            entry_path.display()
                        ),
                        false,
                    ));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(EngineError::new(
                    "unsafe_archive",
                    format!(
                        "Archive link {} escapes the destination",
                        entry_path.display()
                    ),
                    false,
                ));
            }
        }
    }
    let resolved = stack
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err(EngineError::new(
            "unsafe_archive",
            format!(
                "Archive link {} escapes the destination",
                entry_path.display()
            ),
            false,
        ))
    }
}

fn extract_tar_gz(
    bytes: &[u8],
    destination: &Path,
    strip_components: usize,
    cancellation: &CancellationFlag,
    process_cancellation: &AtomicBool,
) -> Result<(), EngineError> {
    fs::create_dir_all(destination).map_err(|error| {
        EngineError::new(
            "extract_failed",
            format!(
                "Could not create extraction directory {}: {error}",
                destination.display()
            ),
            false,
        )
    })?;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        EngineError::new(
            "extract_failed",
            format!("Could not read archive entries: {error}"),
            false,
        )
    })?;
    let mut count = 0_usize;
    let mut expanded = 0_u64;
    for entry in entries {
        if cancellation.is_cancelled() || process_cancellation.load(Ordering::Acquire) {
            return Err(EngineError::cancelled());
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(EngineError::new(
                "archive_too_large",
                "Archive contains too many entries",
                false,
            ));
        }
        let mut entry = entry.map_err(|error| {
            EngineError::new(
                "extract_failed",
                format!("Could not read an archive entry: {error}"),
                false,
            )
        })?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_EXTRACTED_BYTES {
            return Err(EngineError::new(
                "archive_too_large",
                "Archive expands beyond the extraction safety limit",
                false,
            ));
        }
        let original = entry.path().map_err(|error| {
            EngineError::new(
                "unsafe_archive",
                format!("Archive entry has an invalid path: {error}"),
                false,
            )
        })?;
        let safe = match safe_archive_path(&original, strip_components) {
            Ok(path) => path,
            Err(error) if error.code == "empty_archive_path" => continue,
            Err(error) => return Err(error),
        };
        if let Some(target) = entry.link_name().map_err(|error| {
            EngineError::new(
                "unsafe_archive",
                format!("Archive link has an invalid target: {error}"),
                false,
            )
        })? {
            safe_link_target(destination, &safe, &target)?;
        }
        let output_path = destination.join(&safe);
        entry.unpack(&output_path).map_err(|error| {
            EngineError::new(
                "extract_failed",
                format!("Could not extract {}: {error}", safe.display()),
                false,
            )
        })?;
    }
    Ok(())
}

fn unique_sibling_path(target: &Path, suffix: &str) -> Result<PathBuf, EngineError> {
    let parent = target.parent().ok_or_else(|| {
        EngineError::new(
            "install_failed",
            format!("Target has no parent: {}", target.display()),
            false,
        )
    })?;
    let name = target.file_name().ok_or_else(|| {
        EngineError::new(
            "install_failed",
            format!("Target has no filename: {}", target.display()),
            false,
        )
    })?;
    Ok(parent.join(format!(
        ".{}.{}.{}",
        name.to_string_lossy(),
        suffix,
        uuid::Uuid::new_v4()
    )))
}

fn atomic_replace_path(staged: &Path, target: &Path, directory: bool) -> Result<(), EngineError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            EngineError::new(
                "install_failed",
                format!("Could not create {}: {error}", parent.display()),
                false,
            )
        })?;
    }
    if !target.exists() {
        return fs::rename(staged, target).map_err(|error| {
            EngineError::new(
                "install_failed",
                format!(
                    "Could not activate {} at {}: {error}",
                    staged.display(),
                    target.display()
                ),
                false,
            )
        });
    }
    let backup = unique_sibling_path(target, "backup")?;
    fs::rename(target, &backup).map_err(|error| {
        EngineError::new(
            "install_failed",
            format!("Could not back up {}: {error}", target.display()),
            false,
        )
    })?;
    match fs::rename(staged, target) {
        Ok(()) => {
            let cleanup = if directory {
                fs::remove_dir_all(&backup)
            } else {
                fs::remove_file(&backup)
            };
            cleanup.map_err(|error| {
                EngineError::new(
                    "install_failed",
                    format!("Could not remove backup {}: {error}", backup.display()),
                    false,
                )
            })
        }
        Err(error) => {
            let restore = fs::rename(&backup, target);
            Err(EngineError::new(
                "install_failed",
                match restore {
                    Ok(()) => format!(
                        "Could not activate {} at {}: {error}",
                        staged.display(),
                        target.display()
                    ),
                    Err(restore_error) => format!(
                        "Could not activate {}: {error}; restore also failed: {restore_error}",
                        target.display()
                    ),
                },
                false,
            ))
        }
    }
}

fn managed_archive_coordinates(
    tool: &str,
) -> Result<(&'static str, String, &'static str, usize), EngineError> {
    match (tool, std::env::consts::ARCH) {
        ("node", "aarch64") => Ok((
            MANAGED_NODE_VERSION,
            format!(
                "https://nodejs.org/dist/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-arm64.tar.gz"
            ),
            MANAGED_NODE_SHA256_ARM64,
            1,
        )),
        ("node", "x86_64") => Ok((
            MANAGED_NODE_VERSION,
            format!(
                "https://nodejs.org/dist/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-x64.tar.gz"
            ),
            MANAGED_NODE_SHA256_X64,
            1,
        )),
        ("git", "aarch64") => Ok((
            MANAGED_GIT_RELEASE,
            format!(
                "https://github.com/desktop/dugite-native/releases/download/{MANAGED_GIT_RELEASE}/dugite-native-{MANAGED_GIT_BUILD}-macOS-arm64.tar.gz"
            ),
            MANAGED_GIT_SHA256_ARM64,
            0,
        )),
        ("git", "x86_64") => Ok((
            MANAGED_GIT_RELEASE,
            format!(
                "https://github.com/desktop/dugite-native/releases/download/{MANAGED_GIT_RELEASE}/dugite-native-{MANAGED_GIT_BUILD}-macOS-x64.tar.gz"
            ),
            MANAGED_GIT_SHA256_X64,
            0,
        )),
        _ => Err(EngineError::new(
            "unsupported_architecture",
            format!(
                "{tool} has no managed build for architecture {}",
                std::env::consts::ARCH
            ),
            false,
        )),
    }
}

fn install_managed_archive(
    backend: &CoreBackend,
    tool: &str,
    target: &Path,
    expected_binary: &Path,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    if expected_binary.is_file() {
        return Ok(format!(
            "{tool} already installed at {}",
            expected_binary.display()
        ));
    }
    let (version, url, checksum, strip_components) = managed_archive_coordinates(tool)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let managed_processes = backend.managed_processes();
    let process_cancellation = managed_processes.reserve(&handle)?;
    install_progress(
        backend,
        &handle,
        format!("[{tool}] downloading {url}"),
        false,
        None,
    );
    let result = (|| {
        let bytes = download_bytes(&url, cancellation, &process_cancellation, |done, total| {
            if done == total.unwrap_or(u64::MAX) || done % (4 * 1024 * 1024) < 64 * 1024 {
                install_progress(
                    backend,
                    &handle,
                    format!(
                        "[{tool}] downloaded {}{}",
                        done,
                        total.map_or_else(String::new, |total| format!("/{total} bytes"))
                    ),
                    false,
                    None,
                );
            }
        })?;
        verify_sha256(&bytes, checksum, tool)?;
        let staging = unique_sibling_path(target, "install")?;
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|error| {
                EngineError::new(
                    "install_failed",
                    format!("Could not clear staging directory: {error}"),
                    false,
                )
            })?;
        }
        install_progress(
            backend,
            &handle,
            format!("[{tool}] verified {version}; extracting"),
            false,
            None,
        );
        if let Err(error) = extract_tar_gz(
            &bytes,
            &staging,
            strip_components,
            cancellation,
            &process_cancellation,
        ) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        if !staging
            .join(
                expected_binary
                    .strip_prefix(target)
                    .unwrap_or(expected_binary),
            )
            .is_file()
            && !expected_binary.is_file()
        {
            let _ = fs::remove_dir_all(&staging);
            return Err(EngineError::new(
                "install_failed",
                format!(
                    "{tool} archive did not contain {}",
                    expected_binary.display()
                ),
                false,
            ));
        }
        atomic_replace_path(&staging, target, true)?;
        Ok(format!("{tool} installed at {}", expected_binary.display()))
    })();
    managed_processes.deregister(&handle);
    match &result {
        Ok(message) => install_progress(backend, &handle, message, true, None),
        Err(error) => install_progress(backend, &handle, "", true, Some(&error.message)),
    }
    result
}

fn install_streaming_command<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    spec: ProcessSpec,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let handle = uuid::Uuid::new_v4().to_string();
    let output = runner.run_streaming(
        &spec,
        cancellation,
        &handle,
        StreamEventMode::Install {
            bus: backend.event_bus(),
            handle: handle.clone(),
        },
    )?;
    if output.success {
        Ok(handle)
    } else {
        Err(EngineError::new(
            "install_failed",
            process_failure_message(&spec, &output, &OutputRedactor::from_env(&spec.env)),
            true,
        ))
    }
}

fn npm_install_spec(
    hq_root: &Path,
    package: &str,
    force: bool,
) -> Result<ProcessSpec, EngineError> {
    let home = user_home()?;
    let prefix = managed_npm_prefix(&home);
    fs::create_dir_all(&prefix).map_err(|error| {
        EngineError::new(
            "install_failed",
            format!("Could not create npm prefix {}: {error}", prefix.display()),
            false,
        )
    })?;
    let path = gui_safe_path();
    let npm = find_executable("npm", &path).ok_or_else(|| {
        EngineError::new(
            "missing_prerequisite",
            "npm is not installed. Install Node.js first.",
            false,
        )
    })?;
    let mut args = vec![
        "install".into(),
        "-g".into(),
        "--prefix".into(),
        prefix.into_os_string(),
        package.into(),
    ];
    if force {
        args.push("--force".into());
    }
    Ok(ProcessSpec {
        program: npm,
        args,
        current_dir: hq_root.to_path_buf(),
        env: vec![("PATH".to_string(), path.into())],
    })
}

fn install_yq_binary(
    backend: &CoreBackend,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let (arch, checksum) = match std::env::consts::ARCH {
        "aarch64" => ("arm64", YQ_BINARY_SHA256_ARM64),
        "x86_64" => ("amd64", YQ_BINARY_SHA256_AMD64),
        other => {
            return Err(EngineError::new(
                "unsupported_architecture",
                format!("yq has no managed build for architecture {other}"),
                false,
            ))
        }
    };
    let home = user_home()?;
    let bin_dir = home.join(".local").join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| {
        EngineError::new(
            "install_failed",
            format!("Could not create {}: {error}", bin_dir.display()),
            false,
        )
    })?;
    let target = bin_dir.join("yq");
    if target.is_file() {
        return Ok(format!("yq already installed at {}", target.display()));
    }
    let handle = uuid::Uuid::new_v4().to_string();
    let managed_processes = backend.managed_processes();
    let process_cancellation = managed_processes.reserve(&handle)?;
    let url = format!(
        "https://github.com/mikefarah/yq/releases/download/{YQ_BINARY_VERSION}/yq_darwin_{arch}"
    );
    install_progress(
        backend,
        &handle,
        format!("[yq] downloading {url}"),
        false,
        None,
    );
    let result = (|| {
        let bytes = download_bytes(&url, cancellation, &process_cancellation, |_, _| {})?;
        verify_sha256(&bytes, checksum, "yq")?;
        let staged = unique_sibling_path(&target, "install")?;
        fs::write(&staged, bytes).map_err(|error| {
            EngineError::new(
                "install_failed",
                format!("Could not write staged yq binary: {error}"),
                false,
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).map_err(|error| {
                EngineError::new(
                    "install_failed",
                    format!("Could not make staged yq executable: {error}"),
                    false,
                )
            })?;
        }
        let output = Command::new(&staged)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map_err(|error| {
                EngineError::new(
                    "install_failed",
                    format!("Could not run staged yq: {error}"),
                    false,
                )
            })?;
        let version_output = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if !output.status.success() || !version_output.contains(YQ_BINARY_VERSION) {
            let _ = fs::remove_file(&staged);
            return Err(EngineError::new(
                "install_failed",
                format!("Staged yq version check failed: expected {YQ_BINARY_VERSION}"),
                false,
            ));
        }
        atomic_replace_path(&staged, &target, false)?;
        Ok(format!("yq installed at {}", target.display()))
    })();
    managed_processes.deregister(&handle);
    match &result {
        Ok(message) => install_progress(backend, &handle, message, true, None),
        Err(error) => install_progress(backend, &handle, "", true, Some(&error.message)),
    }
    result
}

fn install_named_dependency<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    hq_root: &Path,
    dependency: &str,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    match dependency {
        "node" => {
            let home = user_home()?;
            let target = managed_node_dir(&home);
            let binary = target.join("bin").join("node");
            install_managed_archive(backend, "node", &target, &binary, cancellation)
        }
        "git" => {
            let home = user_home()?;
            let target = managed_git_dir(&home);
            let binary = target.join("bin").join("git");
            install_managed_archive(backend, "git", &target, &binary, cancellation)
        }
        "yq" => install_yq_binary(backend, cancellation),
        "claude-code" => install_streaming_command(
            backend,
            runner,
            npm_install_spec(hq_root, "@anthropic-ai/claude-code", false)?,
            cancellation,
        ),
        "qmd" => install_streaming_command(
            backend,
            runner,
            npm_install_spec(hq_root, "@tobilu/qmd", false)?,
            cancellation,
        ),
        "hq-cli" => install_streaming_command(
            backend,
            runner,
            npm_install_spec(hq_root, "@indigoai-us/hq-cli", false)?,
            cancellation,
        ),
        "gh" => {
            let path = gui_safe_path();
            let brew = find_executable("brew", &path).ok_or_else(|| {
                EngineError::new(
                    "missing_prerequisite",
                    "GitHub CLI automatic install requires Homebrew",
                    false,
                )
            })?;
            install_streaming_command(
                backend,
                runner,
                ProcessSpec {
                    program: brew,
                    args: vec!["install".into(), "gh".into()],
                    current_dir: hq_root.to_path_buf(),
                    env: vec![("PATH".to_string(), path.into())],
                },
                cancellation,
            )
        }
        "homebrew" => install_streaming_command(
            backend,
            runner,
            ProcessSpec {
                program: PathBuf::from("/bin/bash"),
                args: vec![
                    "-c".into(),
                    r#"NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#.into(),
                ],
                current_dir: hq_root.to_path_buf(),
                env: vec![("PATH".to_string(), gui_safe_path().into())],
            },
            cancellation,
        ),
        _ => Err(EngineError::new(
            "invalid_params",
            format!("No installer is registered for {dependency}"),
            false,
        )),
    }
}

fn fetch_json_url(url: &str, error_code: &str) -> Result<Value, EngineError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("hq-native-macos")
        .build()
        .and_then(|client| client.get(url).send())
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::json)
        .map_err(|error| {
            EngineError::new(
                error_code,
                format!("Request to {url} failed: {error}"),
                true,
            )
        })
}

fn installed_hq_cli_version() -> Option<String> {
    let path = gui_safe_path();
    let hq = find_executable("hq", &path)?;
    hq_desktop_core::hq_cli_update::version_from_hq_binary(&hq)
        .or_else(|| hq_desktop_core::hq_cli_update::hq_version_string(&hq))
}

fn fetch_latest_hq_cli_version() -> Result<String, EngineError> {
    fetch_json_url(
        "https://registry.npmjs.org/@indigoai-us/hq-cli/latest",
        "check_hq_cli_update_failed",
    )?
    .get("version")
    .and_then(Value::as_str)
    .map(str::to_string)
    .filter(|version| !version.trim().is_empty())
    .ok_or_else(|| {
        EngineError::new(
            "check_hq_cli_update_failed",
            "npm registry response did not include a version",
            false,
        )
    })
}

fn check_hq_cli_update(backend: &CoreBackend) -> Result<Value, EngineError> {
    let latest = fetch_latest_hq_cli_version()?;
    let local = installed_hq_cli_version();
    let update_available = local.as_deref().is_some_and(|local| {
        hq_desktop_core::hq_cli_update::cmp_semver(local, &latest) == std::cmp::Ordering::Less
    });
    if !update_available || hq_desktop_core::hq_cli_update::is_cli_update_dismissed(&latest) {
        return Ok(Value::Null);
    }
    let info = json!({"local":local,"latest":latest});
    backend.emit_domain_event(None, "hq-cli-update:available", info.clone());
    Ok(info)
}

fn install_hq_cli_update<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    hq_root: &Path,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let path = gui_safe_path();
    let npm = find_executable("npm", &path).ok_or_else(|| {
        EngineError::new(
            "install_hq_cli_update_failed",
            "npm is not installed. Install Node.js first.",
            false,
        )
    })?;
    let hq = find_executable("hq", &path);
    let prefix = hq.as_ref().and_then(|binary| {
        hq_desktop_core::hq_cli_update::npm_prefix_from_hq_bin(binary.to_string_lossy().as_ref())
    });
    let base_args = hq_desktop_core::hq_cli_update::install_argv(prefix.as_deref());
    let make_spec = |args: Vec<String>| ProcessSpec {
        program: npm.clone(),
        args: args.into_iter().map(OsString::from).collect(),
        current_dir: hq_root.to_path_buf(),
        env: vec![("PATH".to_string(), path.clone().into())],
    };
    let first_spec = make_spec(base_args.clone());
    let mut output = runner.run(&first_spec, cancellation)?;
    if !output.success {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        if detail.contains("EEXIST") {
            let mut forced = base_args;
            forced.push("--force".to_string());
            output = runner.run(&make_spec(forced), cancellation)?;
        }
    }
    if !output.success {
        return Err(EngineError::new(
            "install_hq_cli_update_failed",
            process_failure_message(
                &first_spec,
                &output,
                &OutputRedactor::from_env(&first_spec.env),
            ),
            true,
        ));
    }
    let latest = fetch_latest_hq_cli_version()?;
    let local = installed_hq_cli_version().or_else(|| Some(latest.clone()));
    let info = json!({"local":local,"latest":latest});
    backend.emit_domain_event(None, "hq-cli-update:cleared", info.clone());
    Ok(info)
}

fn fetch_latest_hq_core_version() -> Result<String, EngineError> {
    fetch_json_url(
        "https://api.github.com/repos/indigoai-us/hq-core/releases/latest",
        "install_hq_core_update_failed",
    )?
    .get("tag_name")
    .and_then(Value::as_str)
    .map(|tag| tag.trim_start_matches('v').to_string())
    .filter(|version| !version.trim().is_empty())
    .ok_or_else(|| {
        EngineError::new(
            "install_hq_core_update_failed",
            "GitHub latest release response did not include a tag",
            false,
        )
    })
}

fn looks_like_hq_root(path: &Path) -> bool {
    path.join("companies").is_dir()
        && [".claude", "core", "personal"]
            .iter()
            .any(|directory| path.join(directory).is_dir())
}

fn tail_lines(text: &str, count: usize) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn hq_core_version_at(hq_root: &Path) -> Option<String> {
    let canonical = hq_root.join("core").join("core.yaml");
    let legacy = hq_root.join("core.yaml");
    let path = if canonical.is_file() {
        canonical
    } else {
        legacy
    };
    let bytes = fs::read(path).ok()?;
    let value = serde_yaml::from_slice::<serde_yaml::Value>(&bytes).ok()?;
    value
        .get("hqVersion")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

fn hq_core_floor_at(hq_root: &Path, expected_source: &str) -> Option<String> {
    let canonical = hq_root.join("core").join("core.yaml");
    let legacy = hq_root.join("core.yaml");
    let path = if canonical.is_file() {
        canonical
    } else {
        legacy
    };
    let value = serde_yaml::from_slice::<serde_yaml::Value>(&fs::read(path).ok()?).ok()?;
    let stamp = value
        .get("replaced_from_source")
        .or_else(|| value.get("replaced_from_staging"))?;
    if stamp.get("source").and_then(serde_yaml::Value::as_str) != Some(expected_source) {
        return None;
    }
    stamp
        .get("last_sync_sha")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
        .map(str::to_string)
}

fn fetch_github_json(
    url: &str,
    bearer: Option<&str>,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("hq-native-macos")
        .build()
        .map_err(|error| {
            EngineError::new(
                "check_core_state_failed",
                format!("Could not initialize GitHub client: {error}"),
                true,
            )
        })?;
    let request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let request = match bearer {
        Some(token) => request.bearer_auth(token),
        None => request,
    };
    let response = request
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            EngineError::new(
                "check_core_state_failed",
                format!("GitHub request failed: {error}"),
                true,
            )
        })?;
    cancellation.check()?;
    response.json().map_err(|error| {
        EngineError::new(
            "check_core_state_failed",
            format!("GitHub returned invalid JSON: {error}"),
            true,
        )
    })
}

fn github_commit_sha(
    repo: &str,
    reference: &str,
    bearer: Option<&str>,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    fetch_github_json(
        &format!("https://api.github.com/repos/{repo}/commits/{reference}"),
        bearer,
        cancellation,
    )?
    .get("sha")
    .and_then(Value::as_str)
    .filter(|sha| sha.len() >= 40)
    .map(str::to_string)
    .ok_or_else(|| {
        EngineError::new(
            "check_core_state_failed",
            "GitHub commit response is missing `sha`",
            false,
        )
    })
}

fn github_tree(
    repo: &str,
    reference: &str,
    bearer: Option<&str>,
    cancellation: &CancellationFlag,
) -> Result<BTreeMap<String, (String, u64)>, EngineError> {
    let body = fetch_github_json(
        &format!("https://api.github.com/repos/{repo}/git/trees/{reference}?recursive=1"),
        bearer,
        cancellation,
    )?;
    if body
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(EngineError::new(
            "check_core_state_failed",
            "GitHub returned a truncated HQ core tree",
            true,
        ));
    }
    let mut tree = BTreeMap::new();
    for entry in body
        .get("tree")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if entry.get("type").and_then(Value::as_str) != Some("blob") {
            continue;
        }
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(sha) = entry.get("sha").and_then(Value::as_str) else {
            continue;
        };
        tree.insert(
            path.to_string(),
            (
                sha.to_string(),
                entry.get("size").and_then(Value::as_u64).unwrap_or(0),
            ),
        );
    }
    Ok(tree)
}

fn core_version_is_behind(local: &str, target: &str) -> bool {
    let parse = |value: &str| {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|component| {
                component
                    .split(|character: char| !character.is_ascii_digit())
                    .next()
                    .unwrap_or("")
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    parse(local) < parse(target)
}

fn check_core_state<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    use hq_desktop_core::drift_scope::{
        excluded_scope_paths, is_conflict_artifact, path_in_excluded_scope, path_in_locked_scope,
        read_locked_paths, walk_local_under_scope,
    };

    let hq_root = backend.hq_root()?;
    let local_version = hq_core_version_at(&hq_root);
    let locked = read_locked_paths(&hq_root);
    if local_version.is_none() && locked.is_empty() {
        return Ok(Value::Null);
    }
    let menubar = backend
        .menubar_path()
        .ok()
        .map(|path| hq_desktop_core::first_run::read_menubar_obj(&path))
        .unwrap_or_default();
    let email = backend.identity_email()?.unwrap_or_default();
    let is_eligible = email
        .rsplit_once('@')
        .is_some_and(|(_, domain)| domain.eq_ignore_ascii_case("getindigo.ai"));
    let explicit_staging_repo = menubar
        .get("driftStagingRepo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|repo| !repo.is_empty());
    let staging_enabled = menubar
        .get("stagingChannel")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut channel = if explicit_staging_repo.is_some() || (is_eligible && staging_enabled) {
        "staging"
    } else {
        "release"
    };
    let mut target_repo = explicit_staging_repo
        .unwrap_or("indigoai-us/hq-core-staging")
        .to_string();
    if !valid_github_repo(&target_repo) {
        return Err(EngineError::new(
            "check_core_state_failed",
            "Configured staging repository is invalid",
            false,
        ));
    }
    let mut token = if channel == "staging" {
        github_token_from_gh(runner, &hq_root, cancellation).ok()
    } else {
        None
    };
    if channel == "staging" && token.is_none() {
        channel = "release";
        target_repo = PROD_HQ_CORE_REPO.to_string();
    }
    if channel == "release" {
        target_repo = PROD_HQ_CORE_REPO.to_string();
        token = None;
    }

    let (target_ref, target_version) = if channel == "staging" {
        let sha = github_commit_sha(&target_repo, "main", token.as_deref(), cancellation)?;
        (sha.clone(), sha.chars().take(7).collect::<String>())
    } else {
        let tag = fetch_github_json(PROD_HQ_CORE_LATEST_RELEASE_URL, None, cancellation)?
            .get("tag_name")
            .and_then(Value::as_str)
            .filter(|tag| !tag.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                EngineError::new(
                    "check_core_state_failed",
                    "Latest HQ core release is missing `tag_name`",
                    false,
                )
            })?;
        (tag.clone(), tag.trim_start_matches('v').to_string())
    };
    let target_commit =
        github_commit_sha(&target_repo, &target_ref, token.as_deref(), cancellation)?;
    let floor_sha = hq_core_floor_at(&hq_root, &target_repo).or_else(|| {
        (channel == "release")
            .then_some(local_version.as_deref())
            .flatten()
            .and_then(|version| {
                github_commit_sha(
                    &target_repo,
                    &format!("v{version}"),
                    token.as_deref(),
                    cancellation,
                )
                .ok()
            })
    });

    let scanned_at = chrono::Utc::now().to_rfc3339();
    let mut modified = Vec::new();
    let mut missing = Vec::new();
    let mut added = Vec::new();
    let mut unchanged_count = 0_u32;
    if !locked.is_empty() {
        let excluded = excluded_scope_paths();
        let local = walk_local_under_scope(&hq_root, &locked)
            .into_iter()
            .filter(|(path, _)| !path_in_excluded_scope(path, &excluded))
            .filter(|(path, _)| !is_conflict_artifact(path))
            .collect::<BTreeMap<_, _>>();
        let target = github_tree(&target_repo, &target_ref, token.as_deref(), cancellation)?
            .into_iter()
            .filter(|(path, _)| path_in_locked_scope(path, &locked))
            .filter(|(path, _)| !path_in_excluded_scope(path, &excluded))
            .collect::<BTreeMap<_, _>>();
        let floor = floor_sha
            .as_deref()
            .and_then(|sha| github_tree(&target_repo, sha, token.as_deref(), cancellation).ok())
            .map(|tree| {
                tree.into_iter()
                    .filter(|(path, _)| path_in_locked_scope(path, &locked))
                    .filter(|(path, _)| !path_in_excluded_scope(path, &excluded))
                    .collect::<BTreeMap<_, _>>()
            });
        let target_paths = target.keys().collect::<BTreeSet<_>>();
        let local_paths = local.keys().collect::<BTreeSet<_>>();
        for path in target_paths.intersection(&local_paths) {
            let (target_sha, _) = &target[*path];
            let (local_sha, size) = &local[*path];
            let classification_sha = floor
                .as_ref()
                .and_then(|tree| tree.get(*path))
                .map(|(sha, _)| sha)
                .unwrap_or(target_sha);
            if local_sha == classification_sha {
                unchanged_count += 1;
            } else {
                modified.push(json!({
                    "path":*path,
                    "size":size,
                    "gitShaLocal":local_sha,
                    "gitShaUpstream":target_sha
                }));
            }
        }
        for path in target_paths.difference(&local_paths) {
            let (target_sha, size) = &target[*path];
            missing.push(json!({
                "path":*path,
                "size":size,
                "gitShaLocal":null,
                "gitShaUpstream":target_sha
            }));
        }
        for path in local_paths.difference(&target_paths) {
            let (local_sha, size) = &local[*path];
            match floor.as_ref().and_then(|tree| tree.get(*path)) {
                Some((floor_sha, _)) if local_sha == floor_sha => unchanged_count += 1,
                Some(_) => modified.push(json!({
                    "path":*path,
                    "size":size,
                    "gitShaLocal":local_sha,
                    "gitShaUpstream":null
                })),
                None => added.push(json!({
                    "path":*path,
                    "size":size,
                    "gitShaLocal":local_sha,
                    "gitShaUpstream":null
                })),
            }
        }
    }
    let version_behind = if floor_sha.as_deref() == Some(target_commit.as_str()) {
        false
    } else if channel == "staging" {
        floor_sha.as_deref() != Some(target_commit.as_str())
    } else {
        local_version
            .as_deref()
            .is_some_and(|local| core_version_is_behind(local, &target_version))
    };
    let drift_report = json!({
        "count":modified.len(),
        "modified":modified,
        "missing":missing,
        "added":added,
        "scannedAt":scanned_at,
        "hqVersion":if channel == "staging" {
            format!("{target_repo}@{target_ref}")
        } else {
            target_version.clone()
        },
        "targetRepo":target_repo,
        "targetRef":target_ref
    });
    let state = json!({
        "channel":channel,
        "targetRepo":target_repo,
        "targetVersion":target_version,
        "targetRef":target_ref,
        "localVersion":local_version,
        "floorSha":floor_sha,
        "isEligible":is_eligible,
        "versionBehind":version_behind,
        "driftReport":drift_report,
        "unchangedCount":unchanged_count,
        "userOnlyCount":drift_report["added"].as_array().map_or(0, Vec::len),
        "scannedAt":scanned_at
    });
    backend.emit_domain_event(None, "core-state:changed", state.clone());
    backend.emit_domain_event(None, "drift:report", drift_report);
    Ok(state)
}

fn install_hq_core_update<R: ProcessRunner>(
    runner: &R,
    hq_root: &Path,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    if !looks_like_hq_root(hq_root) {
        return Err(EngineError::new(
            "install_hq_core_update_failed",
            format!("HQ folder at {} is not a valid HQ root", hq_root.display()),
            false,
        ));
    }
    let latest = fetch_latest_hq_core_version()?;
    let path = gui_safe_path();
    let npx = find_executable("npx", &path).ok_or_else(|| {
        EngineError::new(
            "install_hq_core_update_failed",
            "npx is not installed. Install Node.js first.",
            false,
        )
    })?;
    let mut args = vec![
        "-y".into(),
        format!(
            "--package={}@{}",
            hq_desktop_core::hq_cloud::HQ_CLOUD_PACKAGE,
            hq_desktop_core::hq_cloud::HQ_CLOUD_VERSION
        )
        .into(),
        "hq-rescue".into(),
        "--hq-root".into(),
        hq_root.as_os_str().to_os_string(),
        "--source".into(),
        "indigoai-us/hq-core".into(),
        "--ref".into(),
        format!("v{latest}").into(),
        "--yes".into(),
    ];
    if let Some(local) = hq_core_version_at(hq_root) {
        if let Ok(reference) = fetch_json_url(
            &format!("https://api.github.com/repos/indigoai-us/hq-core/git/ref/tags/v{local}"),
            "install_hq_core_update_failed",
        ) {
            if let Some(sha) = reference
                .pointer("/object/sha")
                .and_then(Value::as_str)
                .filter(|sha| sha.len() >= 40)
            {
                args.extend(["--floor-sha".into(), sha.into()]);
            }
        }
    }
    let spec = ProcessSpec {
        program: npx,
        args,
        current_dir: hq_root.to_path_buf(),
        env: vec![
            ("PATH".to_string(), path.into()),
            ("HQ_ROOT".to_string(), hq_root.as_os_str().to_os_string()),
        ],
    };
    let output = runner.run(&spec, cancellation)?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let log_path = std::env::temp_dir().join(format!(
        "hq-native-core-update-{}-{}.log",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&log_path, combined.as_bytes()).map_err(|error| {
        EngineError::new(
            "install_hq_core_update_failed",
            format!("Could not write update log: {error}"),
            false,
        )
    })?;
    Ok(json!({
        "exitCode":output.code.unwrap_or(-1),
        "logTail":tail_lines(&combined, 40),
        "logPath":log_path.to_string_lossy()
    }))
}

fn valid_github_repo(repo: &str) -> bool {
    let mut segments = repo.split('/');
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 100
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    matches!(
        (segments.next(), segments.next(), segments.next()),
        (Some(owner), Some(name), None) if valid_segment(owner) && valid_segment(name)
    )
}

fn valid_github_ref(reference: &str) -> bool {
    !reference.is_empty()
        && reference.len() <= 128
        && !reference.contains("..")
        && !reference.starts_with('/')
        && !reference.ends_with('/')
        && reference
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
}

fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn restore_from_upstream(
    backend: &CoreBackend,
    path: &str,
    expected_upstream_sha: Option<&str>,
    target_repo: Option<&str>,
    target_ref: Option<&str>,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let hq_root = backend.hq_root()?;
    let repo = target_repo.unwrap_or(PROD_HQ_CORE_REPO);
    if !valid_github_repo(repo) {
        return Err(EngineError::new(
            "restore_from_upstream_failed",
            format!("Invalid GitHub repository {repo:?}"),
            false,
        ));
    }
    let reference = match target_ref {
        Some(reference) => reference.to_string(),
        None => hq_core_version_at(&hq_root)
            .map(|version| format!("v{}", version.trim_start_matches('v')))
            .ok_or_else(|| {
                EngineError::new(
                    "restore_from_upstream_failed",
                    "hqVersion is not detectable; cannot resolve the upstream tag",
                    false,
                )
            })?,
    };
    if !valid_github_ref(&reference) {
        return Err(EngineError::new(
            "restore_from_upstream_failed",
            format!("Invalid GitHub ref {reference:?}"),
            false,
        ));
    }
    let manifest_path = hq_root.join("core/core.yaml");
    let manifest = fs::read_to_string(&manifest_path).map_err(|error| {
        EngineError::new(
            "restore_from_upstream_failed",
            format!("Could not read {}: {error}", manifest_path.display()),
            false,
        )
    })?;
    let locked = parse_locked_paths(&manifest)?;
    let relative = validate_locked_restore_path(path, &locked)?;
    let path_for_url = relative.to_string_lossy().replace('\\', "/");
    let url = format!("https://raw.githubusercontent.com/{repo}/{reference}/{path_for_url}");
    let operation_cancelled = AtomicBool::new(false);
    let bytes = download_bytes(
        &url,
        cancellation,
        &operation_cancelled,
        |_received, _total| {},
    )
    .map_err(|error| {
        EngineError::new(
            "restore_from_upstream_failed",
            error.message,
            error.retryable,
        )
    })?;
    if let Some(expected) = expected_upstream_sha {
        let expected = expected.trim().to_ascii_lowercase();
        if expected.len() != 40 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(EngineError::new(
                "restore_from_upstream_failed",
                "Expected upstream SHA is not a 40-character Git object id",
                false,
            ));
        }
        let actual = git_blob_sha(&bytes);
        if actual != expected {
            return Err(EngineError::new(
                "restore_from_upstream_failed",
                format!(
                    "Upstream content SHA mismatch: expected {expected}, got {actual}; refusing to write"
                ),
                false,
            ));
        }
    }
    atomic_write_bytes(&hq_root.join(relative), &bytes).map_err(|error| {
        EngineError::new(
            "restore_from_upstream_failed",
            error.message,
            error.retryable,
        )
    })?;
    Ok(Value::Null)
}

fn resolve_staging_repo(backend: &CoreBackend) -> Result<String, EngineError> {
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&backend.menubar_path()?);
    if let Some(repo) = menubar
        .get("driftStagingRepo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !valid_github_repo(repo) {
            return Err(EngineError::new(
                "run_replace_from_staging_failed",
                format!("Invalid staging repository {repo:?}"),
                false,
            ));
        }
        return Ok(repo.to_string());
    }
    let channel_enabled = menubar
        .get("stagingChannel")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let eligible =
        hq_desktop_core::feature_gate::is_allowed_email(backend.identity_email()?.as_deref());
    if !channel_enabled {
        return Err(EngineError::new(
            "run_replace_from_staging_failed",
            "Staging channel is disabled in Settings",
            false,
        ));
    }
    if !eligible {
        return Err(EngineError::new(
            "run_replace_from_staging_failed",
            "No staging repository is configured for this account",
            false,
        ));
    }
    Ok(STAGING_HQ_CORE_REPO.to_string())
}

fn run_replace_from_staging<R: ProcessRunner>(
    backend: &CoreBackend,
    runner: &R,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    use hq_desktop_core::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION};

    let hq_root = backend.hq_root()?;
    if !looks_like_hq_root(&hq_root) {
        return Err(EngineError::new(
            "run_replace_from_staging_failed",
            format!("{} is not a valid HQ root", hq_root.display()),
            false,
        ));
    }
    let repo = resolve_staging_repo(backend)?;
    let token = github_token_from_gh(runner, &hq_root, cancellation)?;
    let path = gui_safe_path();
    let npx = find_executable("npx", &path).unwrap_or_else(|| PathBuf::from("npx"));
    let spec = ProcessSpec {
        program: npx,
        args: vec![
            "-y".into(),
            format!("--package={HQ_CLOUD_PACKAGE}@{HQ_CLOUD_VERSION}").into(),
            "hq-rescue".into(),
            "--hq-root".into(),
            hq_root.as_os_str().to_os_string(),
            "--source".into(),
            repo.into(),
            "--yes".into(),
        ],
        current_dir: hq_root,
        env: vec![
            ("PATH".to_string(), path.into()),
            ("GH_TOKEN".to_string(), token.into()),
        ],
    };
    let output = runner.run(&spec, cancellation)?;
    let redactor = OutputRedactor::from_env(&spec.env);
    let stdout = redactor.redact(&String::from_utf8_lossy(&output.stdout));
    let stderr = redactor.redact(&String::from_utf8_lossy(&output.stderr));
    let combined = if stderr.trim().is_empty() {
        stdout
    } else if stdout.trim().is_empty() {
        stderr
    } else {
        format!("{stdout}\n{stderr}")
    };
    let log_path = std::env::temp_dir().join(format!(
        "hq-native-replace-from-staging-{}.log",
        uuid::Uuid::new_v4()
    ));
    atomic_write_bytes(&log_path, combined.as_bytes()).map_err(|error| {
        EngineError::new(
            "run_replace_from_staging_failed",
            error.message,
            error.retryable,
        )
    })?;
    Ok(json!({
        "exit_code": output.code.unwrap_or(-1),
        "log_tail": tail_lines(&combined, 40),
        "log_path": log_path.to_string_lossy()
    }))
}

fn configure_claude_settings_path(hq_path: &Path) -> Result<Value, EngineError> {
    let settings_path = hq_path.join(".claude/settings.json");
    let contents = match fs::read_to_string(&settings_path) {
        Ok(contents) => contents,
        Err(error) => {
            return Ok(Value::String(format!(
                "[path] no settings.json at {} - skipped ({error})",
                settings_path.display()
            )));
        }
    };
    let rendered = settings_json_with_env_path(&contents, &gui_safe_path())?;
    atomic_write_bytes(&settings_path, rendered.as_bytes()).map_err(|error| {
        EngineError::new(
            "configure_claude_settings_path_failed",
            error.message,
            error.retryable,
        )
    })?;
    Ok(Value::String(format!(
        "[path] wrote managed toolchain PATH into {}",
        settings_path.display()
    )))
}

fn download_staging_tarball<R: ProcessRunner>(
    runner: &R,
    hq_root: &Path,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let token = github_token_from_gh(runner, hq_root, cancellation)?;
    let cancelled = AtomicBool::new(false);
    let bytes = download_bytes_with_bearer(
        "https://api.github.com/repos/indigoai-us/hq-core-staging/tarball/main",
        Some(&token),
        cancellation,
        &cancelled,
        |_received, _total| {},
    )
    .map_err(|error| {
        EngineError::new(
            "download_staging_tarball_failed",
            error.message,
            error.retryable,
        )
    })?;
    serde_json::to_value(bytes).map_err(|error| {
        EngineError::new(
            "download_staging_tarball_failed",
            format!("Could not encode staging tarball bytes: {error}"),
            false,
        )
    })
}

trait ProcessRunner {
    fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
    ) -> Result<ProcessOutput, EngineError>;

    fn run_with_timeout(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
        _timeout: Duration,
    ) -> Result<ProcessOutput, EngineError> {
        self.run(spec, cancellation)
    }

    fn run_streaming(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
        handle: &str,
        emitter: StreamEventMode,
    ) -> Result<ProcessOutput, EngineError> {
        let output = self.run(spec, cancellation)?;
        let redactor = OutputRedactor::from_env(&spec.env);
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            emitter.emit_line(true, &redactor.redact(line));
        }
        for line in String::from_utf8_lossy(&output.stderr).lines() {
            emitter.emit_line(false, &redactor.redact(line));
        }
        let error = (!output.success).then(|| process_failure_message(spec, &output, &redactor));
        emitter.emit_terminal(&output, error.as_deref());
        let _ = handle;
        Ok(output)
    }
}

trait CompanyProvisioner {
    fn provision(
        &self,
        slug: &str,
        display_name: &str,
        hq_root: &Path,
        cancellation: &CancellationFlag,
    ) -> Result<(), EngineError>;
}

#[derive(Default)]
struct CancellableProcessRunner {
    managed_processes: Arc<ManagedProcessRegistry>,
}

impl ProcessRunner for CancellableProcessRunner {
    fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
    ) -> Result<ProcessOutput, EngineError> {
        run_cancellable_process(spec, cancellation, None)
    }

    fn run_with_timeout(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
        timeout: Duration,
    ) -> Result<ProcessOutput, EngineError> {
        run_cancellable_process(spec, cancellation, Some(timeout))
    }

    fn run_streaming(
        &self,
        spec: &ProcessSpec,
        cancellation: &CancellationFlag,
        handle: &str,
        emitter: StreamEventMode,
    ) -> Result<ProcessOutput, EngineError> {
        run_managed_process(&self.managed_processes, handle, spec, cancellation, emitter)
    }
}

fn run_cancellable_process(
    spec: &ProcessSpec,
    cancellation: &CancellationFlag,
    timeout: Option<Duration>,
) -> Result<ProcessOutput, EngineError> {
    cancellation.check()?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| {
        EngineError::new(
            "process_spawn_failed",
            format!("Failed to spawn `{}`: {error}", spec.program.display()),
            true,
        )
    })?;
    let stdout_reader = child.stdout.take().ok_or_else(|| {
        EngineError::new(
            "process_pipe_failed",
            "Spawned process did not expose stdout",
            false,
        )
    })?;
    let stderr_reader = child.stderr.take().ok_or_else(|| {
        EngineError::new(
            "process_pipe_failed",
            "Spawned process did not expose stderr",
            false,
        )
    })?;
    let stdout_task = drain_pipe(stdout_reader);
    let stderr_task = drain_pipe(stderr_reader);
    let started_at = Instant::now();

    let status = loop {
        if cancellation.is_cancelled() {
            let _ = terminate_process_group(child.id(), false);
            thread::sleep(Duration::from_millis(25));
            if child.try_wait().ok().flatten().is_none() {
                let _ = terminate_process_group(child.id(), true);
            }
            let _ = child.wait();
            let _ = join_pipe(stdout_task, "stdout");
            let _ = join_pipe(stderr_task, "stderr");
            return Err(EngineError::cancelled());
        }
        if timeout.is_some_and(|deadline| started_at.elapsed() >= deadline) {
            let _ = terminate_process_group(child.id(), false);
            thread::sleep(Duration::from_millis(25));
            if child.try_wait().ok().flatten().is_none() {
                let _ = terminate_process_group(child.id(), true);
            }
            let _ = child.wait();
            let _ = join_pipe(stdout_task, "stdout");
            let _ = join_pipe(stderr_task, "stderr");
            return Err(EngineError::new(
                "process_timeout",
                format!(
                    "`{}` exceeded its {:?} execution deadline",
                    spec.program.display(),
                    timeout.expect("checked as some")
                ),
                true,
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(error) => {
                let _ = terminate_process_group(child.id(), true);
                let _ = child.wait();
                let _ = join_pipe(stdout_task, "stdout");
                let _ = join_pipe(stderr_task, "stderr");
                return Err(EngineError::new(
                    "process_wait_failed",
                    format!(
                        "Failed while waiting for `{}`: {error}",
                        spec.program.display()
                    ),
                    true,
                ));
            }
        }
    };

    Ok(ProcessOutput {
        success: status.success(),
        code: status.code(),
        stdout: join_pipe(stdout_task, "stdout")?,
        stderr: join_pipe(stderr_task, "stderr")?,
    })
}

fn process_failure_message(
    spec: &ProcessSpec,
    output: &ProcessOutput,
    redactor: &OutputRedactor,
) -> String {
    let stderr = redactor.redact(String::from_utf8_lossy(&output.stderr).trim());
    let stdout = redactor.redact(String::from_utf8_lossy(&output.stdout).trim());
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".to_string()
    };
    format!(
        "`{}` exited {}: {detail}",
        spec.program.display(),
        output.code.unwrap_or(-1)
    )
}

fn drain_pipe<R>(mut reader: R) -> thread::JoinHandle<std::io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn join_pipe(
    task: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    label: &str,
) -> Result<Vec<u8>, EngineError> {
    task.join()
        .map_err(|_| {
            EngineError::new(
                "process_pipe_failed",
                format!("{label} reader thread panicked"),
                false,
            )
        })?
        .map_err(|error| {
            EngineError::new(
                "process_pipe_failed",
                format!("Failed reading child {label}: {error}"),
                true,
            )
        })
}

struct CliCompanyProvisioner;

impl CompanyProvisioner for CliCompanyProvisioner {
    fn provision(
        &self,
        slug: &str,
        display_name: &str,
        hq_root: &Path,
        cancellation: &CancellationFlag,
    ) -> Result<(), EngineError> {
        cancellation.check()?;
        let slug = slug.to_string();
        let display_name = display_name.to_string();
        let hq_root = hq_root.to_path_buf();
        let cancellation = cancellation.clone();

        thread::Builder::new()
            .name("hq-cloud-provision".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| {
                        EngineError::new(
                            "connect_workspace_to_cloud_failed",
                            format!("Could not start the HQ CLI runtime: {error}"),
                            true,
                        )
                    })?;
                runtime.block_on(async move {
                    let operation = hq_desktop_core::run_cli_provision::run_cli_provision(
                        &slug,
                        Some(&display_name),
                        &hq_root,
                    );
                    tokio::pin!(operation);
                    loop {
                        tokio::select! {
                            result = &mut operation => {
                                return result.map(|_| ()).map_err(|error| {
                                    let retryable = matches!(
                                        error,
                                        hq_desktop_core::run_cli_provision::CliProvisionError::Network(_)
                                            | hq_desktop_core::run_cli_provision::CliProvisionError::LocalEnv { .. }
                                            | hq_desktop_core::run_cli_provision::CliProvisionError::Sync { .. }
                                    );
                                    EngineError::new(
                                        "connect_workspace_to_cloud_failed",
                                        format!("hq CLI failed for '{slug}': {error}"),
                                        retryable,
                                    )
                                });
                            }
                            _ = tokio::time::sleep(Duration::from_millis(25)) => {
                                if cancellation.is_cancelled() {
                                    return Err(EngineError::cancelled());
                                }
                            }
                        }
                    }
                })
            })
            .map_err(|error| {
                EngineError::new(
                    "connect_workspace_to_cloud_failed",
                    format!("Could not start the HQ CLI worker: {error}"),
                    true,
                )
            })?
            .join()
            .map_err(|_| {
                EngineError::new(
                    "connect_workspace_to_cloud_failed",
                    "The HQ CLI worker panicked",
                    false,
                )
            })?
    }
}

struct TemporaryFeedbackBody {
    path: PathBuf,
}

impl TemporaryFeedbackBody {
    fn create(body: &str) -> Result<Self, EngineError> {
        for _ in 0..8 {
            let path = std::env::temp_dir().join(format!(
                "hq-native-feedback-{}-{}.md",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(body.as_bytes()).map_err(|error| {
                        EngineError::new(
                            "submit_bug_report_failed",
                            format!("Could not write the temporary feedback body: {error}"),
                            false,
                        )
                    })?;
                    file.sync_all().map_err(|error| {
                        EngineError::new(
                            "submit_bug_report_failed",
                            format!("Could not flush the temporary feedback body: {error}"),
                            false,
                        )
                    })?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(EngineError::new(
                        "submit_bug_report_failed",
                        format!("Could not create the temporary feedback body: {error}"),
                        false,
                    ));
                }
            }
        }
        Err(EngineError::new(
            "submit_bug_report_failed",
            "Could not reserve a unique temporary feedback body path",
            false,
        ))
    }
}

impl Drop for TemporaryFeedbackBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let runner = CancellableProcessRunner {
        managed_processes: backend.managed_processes(),
    };
    execute_with_dependencies(
        backend,
        method,
        params,
        cancellation,
        &runner,
        &CliCompanyProvisioner,
    )
}

fn execute_with_dependencies<R, P>(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    runner: &R,
    provisioner: &P,
) -> Result<Value, EngineError>
where
    R: ProcessRunner,
    P: CompanyProvisioner,
{
    cancellation.check()?;
    let raw_params = params;
    let params = raw_params.as_object().ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` params must be a JSON object"),
            false,
        )
    })?;

    match method {
        "compute_checksums" => {
            let install_path = params
                .get("installPath")
                .or_else(|| params.get("install_path"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`compute_checksums` requires string param `installPath`",
                        false,
                    )
                })?;
            compute_checksums_at(Path::new(install_path))
        }
        "configure_claude_settings_path" => {
            let hq_path = required_string(params, "hqPath", method)?;
            configure_claude_settings_path(Path::new(hq_path))
        }
        "fetch_and_extract_template" => fetch_and_extract_template(
            backend,
            runner,
            params.get("handle").and_then(Value::as_str),
            cancellation,
        )
        .map(Value::String),
        "cancel_content_download" => {
            let handle = required_string(params, "handle", method)?;
            Ok(Value::Bool(backend.managed_processes().cancel(handle)))
        }
        "download_staging_tarball" => {
            let hq_root = backend.hq_root()?;
            download_staging_tarball(runner, &hq_root, cancellation)
        }
        "restore_from_upstream" => restore_from_upstream(
            backend,
            required_string(params, "path", method)?,
            params.get("expectedUpstreamSha").and_then(Value::as_str),
            params.get("targetRepo").and_then(Value::as_str),
            params.get("targetRef").and_then(Value::as_str),
            cancellation,
        ),
        "run_replace_from_staging" => run_replace_from_staging(backend, runner, cancellation),
        "check_dep" => {
            let tool = required_string(params, "tool", method)?;
            Ok(check_dep_in(tool, &gui_safe_path()))
        }
        "check_core_state" => check_core_state(backend, runner, cancellation),
        "spawn_process" => {
            let hq_root = backend.hq_root().or_else(|_| {
                std::env::current_dir().map_err(|error| {
                    EngineError::new(
                        "process_working_directory_unavailable",
                        format!("Could not resolve a process working directory: {error}"),
                        false,
                    )
                })
            })?;
            let spec = parse_spawn_process_spec(raw_params, &hq_root)?;
            let handle = uuid::Uuid::new_v4().to_string();
            let emitter = StreamEventMode::Process {
                bus: backend.event_bus(),
                handle: handle.clone(),
            };
            Ok(Value::String(spawn_background_process(
                backend.managed_processes(),
                handle,
                spec,
                emitter,
            )?))
        }
        "cancel_process" | "cancel_install" => {
            let handle = required_string(params, "handle", method)?;
            Ok(Value::Bool(backend.managed_processes().cancel(handle)))
        }
        "cancel_sync" => {
            let managed_processes = backend.managed_processes();
            let sync_cancelled = managed_processes.cancel("hq-sync");
            let initial_cancelled = managed_processes.cancel("hq-personal-first-push");
            Ok(Value::Bool(sync_cancelled || initial_cancelled))
        }
        "start_initial_cloud_sync" => {
            let hq_root = backend.hq_root()?;
            let handle = "hq-personal-first-push".to_string();
            spawn_background_process(
                backend.managed_processes(),
                handle,
                personal_first_push_spec(&hq_root),
                StreamEventMode::PersonalFirstPush {
                    backend: backend.clone(),
                    state: Arc::new(Mutex::new(PersonalFirstPushState::default())),
                },
            )?;
            Ok(Value::Null)
        }
        "start_sync" => {
            let hq_root = backend.hq_root()?;
            let company_slug = params.get("companySlug").and_then(Value::as_str);
            let spec = manual_sync_spec(&hq_root, company_slug)?;
            let handle = "hq-sync".to_string();
            Ok(Value::String(spawn_background_process(
                backend.managed_processes(),
                handle,
                spec,
                StreamEventMode::Sync {
                    backend: backend.clone(),
                    planned_files: Arc::new(Mutex::new(0)),
                },
            )?))
        }
        "resolve_conflict" => {
            const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

            let path = required_string(params, "path", method)?;
            let strategy = required_string(params, "strategy", method)?;
            hq_desktop_core::conflicts::validate_strategy(strategy)
                .map_err(|message| EngineError::new("invalid_conflict_strategy", message, false))?;
            let hq_root = backend.hq_root()?;
            let hq_root_string = hq_root.to_string_lossy().into_owned();
            let spec = hq_process_spec(
                &hq_root,
                hq_desktop_core::conflicts::build_resolve_args(strategy, path, &hq_root_string),
            );
            let output = runner
                .run_with_timeout(&spec, cancellation, RESOLVE_TIMEOUT)
                .map_err(|error| {
                    if error.code == "process_timeout" {
                        EngineError::new(
                            "resolve_conflict_timed_out",
                            "hq sync resolve timed out after 10 seconds",
                            true,
                        )
                    } else {
                        error
                    }
                })?;
            if !output.success {
                return Err(EngineError::new(
                    "resolve_conflict_failed",
                    process_failure_message(&spec, &output, &OutputRedactor::from_env(&spec.env)),
                    true,
                ));
            }
            Ok(Value::Null)
        }
        "start_daemon" => {
            let hq_root = backend.hq_root()?;
            if let Some(pid) = hq_desktop_core::daemon::read_pid_file(&hq_root.to_string_lossy()) {
                if hq_desktop_core::daemon::is_pid_alive(pid) {
                    return Err(EngineError::new(
                        "daemon_already_running",
                        format!("Daemon is already running (PID {pid})"),
                        false,
                    ));
                }
            }
            let handle = "hq-sync-daemon".to_string();
            Ok(Value::String(spawn_background_process(
                backend.managed_processes(),
                handle,
                daemon_process_spec(&hq_root),
                StreamEventMode::Sync {
                    backend: backend.clone(),
                    planned_files: Arc::new(Mutex::new(0)),
                },
            )?))
        }
        "stop_daemon" => {
            if backend.managed_processes().cancel("hq-sync-daemon") {
                return Ok(Value::Bool(true));
            }
            let hq_root = backend.hq_root()?;
            let stopped = hq_desktop_core::daemon::read_pid_file(&hq_root.to_string_lossy())
                .filter(|pid| hq_desktop_core::daemon::is_pid_alive(*pid))
                .is_some_and(|pid| terminate_process_group(pid, false).is_ok());
            Ok(Value::Bool(stopped))
        }
        "list_packages" => {
            let hq_root = backend.hq_root()?;
            Ok(gather_packages(runner, &hq_root, cancellation, false))
        }
        "check_package_updates" => {
            let hq_root = backend.hq_root()?;
            let packages = gather_packages(runner, &hq_root, cancellation, true);
            backend.emit_domain_event(None, "packages:updates", packages);
            Ok(Value::Null)
        }
        "check_pack_update" => {
            let hq_root = backend.hq_root()?;
            let packs = run_json_process(
                runner,
                &hq_process_spec(&hq_root, ["packs", "list", "--json", "--check-updates"]),
                cancellation,
                "check_pack_update_failed",
            )?;
            let summary = pack_update_summary(&packs);
            if summary.get("count").and_then(Value::as_u64).unwrap_or(0) > 0 {
                backend.emit_domain_event(None, "pack-update:available", summary.clone());
                Ok(summary)
            } else {
                backend.emit_domain_event(None, "pack-update:cleared", Value::Null);
                Ok(Value::Null)
            }
        }
        "check_hq_cli_update" => check_hq_cli_update(backend),
        "install_hq_cli_update" => {
            let hq_root = backend.hq_root()?;
            install_hq_cli_update(backend, runner, &hq_root, cancellation)
        }
        "install_hq_core_update" => {
            let hq_root = backend.hq_root()?;
            install_hq_core_update(runner, &hq_root, cancellation)
        }
        "install_package" => {
            let hq_root = backend.hq_root()?;
            let source = required_string(params, "source", method)?;
            let args = if params
                .get("registry")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                vec![
                    "packages".to_string(),
                    "install".to_string(),
                    source.to_string(),
                ]
            } else {
                vec![
                    "install".to_string(),
                    source.to_string(),
                    "--allow-hooks".to_string(),
                ]
            };
            stream_hq_operation(
                backend,
                runner,
                &hq_root,
                "install",
                source,
                args,
                cancellation,
            )?;
            Ok(Value::Null)
        }
        "update_package" => {
            let hq_root = backend.hq_root()?;
            let name = required_string(params, "name", method)?;
            stream_hq_operation(
                backend,
                runner,
                &hq_root,
                "update",
                name,
                vec![
                    "packs".to_string(),
                    "update".to_string(),
                    name.to_string(),
                    "--yes".to_string(),
                ],
                cancellation,
            )?;
            Ok(Value::Null)
        }
        "update_packs" => {
            let hq_root = backend.hq_root()?;
            let names = params
                .get("names")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`update_packs` requires array param `names`",
                        false,
                    )
                })?;
            for name in names {
                let name = name.as_str().ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`update_packs.names` must contain only strings",
                        false,
                    )
                })?;
                stream_hq_operation(
                    backend,
                    runner,
                    &hq_root,
                    "update",
                    name,
                    vec![
                        "packs".to_string(),
                        "update".to_string(),
                        name.to_string(),
                        "--yes".to_string(),
                    ],
                    cancellation,
                )?;
            }
            Ok(Value::Null)
        }
        "uninstall_package" => {
            let hq_root = backend.hq_root()?;
            let name = required_string(params, "name", method)?;
            run_json_process(
                runner,
                &hq_process_spec(&hq_root, ["packs", "uninstall", name, "--yes", "--json"]),
                cancellation,
                "uninstall_package_failed",
            )
        }
        "register_search_index" => {
            let hq_root = backend.hq_root()?;
            run_required_process(
                runner,
                &hq_process_spec(&hq_root, ["reindex"]),
                cancellation,
                "register_search_index_failed",
            )?;
            Ok(Value::Null)
        }
        "install_default_packages" => {
            // The canonical product default set is intentionally empty. Keep
            // this command as a real orchestration boundary so adding a default
            // later is one constant change rather than a UI migration.
            const DEFAULT_PACKAGES: &[&str] = &[];
            let hq_root = backend.hq_root()?;
            for package in DEFAULT_PACKAGES {
                run_required_process(
                    runner,
                    &hq_process_spec(&hq_root, ["packages", "install", package]),
                    cancellation,
                    "install_default_packages_failed",
                )?;
            }
            Ok(Value::Null)
        }
        "install_node"
        | "install_git"
        | "install_gh"
        | "install_yq"
        | "install_claude_code"
        | "install_qmd"
        | "install_hq_cli"
        | "install_homebrew" => {
            let hq_root = backend.hq_root()?;
            let dependency = match method {
                "install_node" => "node",
                "install_git" => "git",
                "install_gh" => "gh",
                "install_yq" => "yq",
                "install_claude_code" => "claude-code",
                "install_qmd" => "qmd",
                "install_hq_cli" => "hq-cli",
                "install_homebrew" => "homebrew",
                _ => unreachable!(),
            };
            Ok(Value::String(install_named_dependency(
                backend,
                runner,
                &hq_root,
                dependency,
                cancellation,
            )?))
        }
        "install_deps" => {
            let hq_root = backend.hq_root()?;
            for (dependency, binary) in [
                ("node", "node"),
                ("yq", "yq"),
                ("git", "git"),
                ("qmd", "qmd"),
                ("hq-cli", "hq"),
            ] {
                cancellation.check()?;
                if check_dep_in(binary, &gui_safe_path())["installed"] == Value::Bool(true) {
                    continue;
                }
                install_named_dependency(backend, runner, &hq_root, dependency, cancellation)?;
                if check_dep_in(binary, &gui_safe_path())["installed"] != Value::Bool(true) {
                    return Err(EngineError::new(
                        "install_deps_failed",
                        format!("{dependency} was not found after installation"),
                        false,
                    ));
                }
            }
            Ok(Value::Null)
        }
        "install_marketplace_pack" => {
            let hq_root = backend.hq_root()?;
            let slug = required_string(params, "slug", method)?;
            let version = params.get("version").and_then(Value::as_str);
            let source = hq_desktop_core::marketplace::marketplace_source(slug, version).map_err(
                |message| EngineError::new("install_marketplace_pack_failed", message, false),
            )?;
            let scope_value = params.get("scope").cloned().ok_or_else(|| {
                EngineError::new(
                    "invalid_params",
                    "`install_marketplace_pack` requires object param `scope`",
                    false,
                )
            })?;
            let scope =
                serde_json::from_value::<hq_desktop_core::marketplace::InstallScope>(scope_value)
                    .map_err(|error| {
                    EngineError::new(
                        "invalid_params",
                        format!("Invalid marketplace install scope: {error}"),
                        false,
                    )
                })?;
            if let hq_desktop_core::marketplace::InstallScope::Company { slug } = &scope {
                hq_desktop_core::marketplace::resolve_company_dir(&hq_root, slug).map_err(
                    |message| EngineError::new("install_marketplace_pack_failed", message, false),
                )?;
            }
            let scope_label = match &scope {
                hq_desktop_core::marketplace::InstallScope::Personal => "personal".to_string(),
                hq_desktop_core::marketplace::InstallScope::Company { slug } => {
                    format!("company:{slug}")
                }
            };
            let spec = hq_process_spec(
                &hq_root,
                hq_desktop_core::marketplace::install_argv(&source, &scope),
            );
            let handle = format!("hq-marketplace-{}", uuid::Uuid::new_v4());
            let output = runner.run_streaming(
                &spec,
                cancellation,
                &handle,
                StreamEventMode::Marketplace {
                    bus: backend.event_bus(),
                    source: source.clone(),
                    scope: scope_label,
                },
            )?;
            if !output.success {
                return Err(EngineError::new(
                    "install_marketplace_pack_failed",
                    process_failure_message(&spec, &output, &OutputRedactor::from_env(&spec.env)),
                    true,
                ));
            }
            Ok(Value::Null)
        }
        method::SUBMIT_BUG_REPORT => {
            let title = required_string(params, "title", method)?;
            let body = required_string(params, "body", method)?;
            let hq_root = backend.hq_root()?;
            let body_file = TemporaryFeedbackBody::create(body)?;
            let spec = ProcessSpec {
                program: PathBuf::from("hq"),
                args: vec![
                    "feedback".into(),
                    "bug".into(),
                    "--title".into(),
                    title.into(),
                    "--body-file".into(),
                    body_file.path.as_os_str().to_owned(),
                ],
                current_dir: hq_root.clone(),
                env: vec![
                    (
                        "PATH".to_string(),
                        OsString::from(hq_desktop_core::paths::child_path()),
                    ),
                    ("HQ_NO_UPDATE_CHECK".to_string(), "1".into()),
                    ("HQ_ROOT".to_string(), hq_root.into_os_string()),
                ],
            };
            let output = runner.run(&spec, cancellation)?;
            if output.success {
                Ok(Value::Null)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(EngineError::new(
                    "submit_bug_report_failed",
                    format!(
                        "`hq feedback` exited {}: {}",
                        output
                            .code
                            .map_or_else(|| "after a signal".to_string(), |code| code.to_string()),
                        stderr.trim()
                    ),
                    true,
                ))
            }
        }
        method::CONNECT_WORKSPACE_TO_CLOUD => {
            let slug = required_string(params, "slug", method)?;
            if slug.is_empty() {
                return Err(EngineError::new(
                    "connect_workspace_to_cloud_failed",
                    "slug is required",
                    false,
                ));
            }
            if slug == "personal" {
                return Err(EngineError::new(
                    "connect_workspace_to_cloud_failed",
                    "the Personal vault is auto-provisioned — no manual connect needed",
                    false,
                ));
            }

            let hq_root = backend.hq_root()?;
            let (folder, manifest_name) = match hq_desktop_core::workspaces::read_manifest(&hq_root)
            {
                hq_desktop_core::workspaces::ManifestLoad::Present(entries) => entries
                    .into_iter()
                    .find(|entry| entry.slug == slug)
                    .map(|entry| (entry.path, entry.display_name))
                    .unwrap_or_else(|| (hq_root.join("companies").join(slug), None)),
                hq_desktop_core::workspaces::ManifestLoad::Absent
                | hq_desktop_core::workspaces::ManifestLoad::Failed(_) => {
                    (hq_root.join("companies").join(slug), None)
                }
            };
            if !folder.is_dir() {
                return Err(EngineError::new(
                    "connect_workspace_to_cloud_failed",
                    format!(
                        "no local folder at {} — cannot connect a missing directory",
                        folder.display()
                    ),
                    false,
                ));
            }
            let display_name = manifest_name
                .or_else(|| hq_desktop_core::workspaces::read_local_company_name(&hq_root, slug))
                .unwrap_or_else(|| hq_desktop_core::workspaces::humanize_slug(slug));
            provisioner.provision(slug, &display_name, &hq_root, cancellation)?;
            Ok(Value::Null)
        }
        _ => Err(EngineError::new(
            "method_not_found",
            format!("Node/install/sync method `{method}` is not implemented"),
            false,
        )),
    }
}

fn required_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
    method: &str,
) -> Result<&'a str, EngineError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` requires string param `{key}`"),
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::*;

    #[derive(Debug, Clone)]
    struct RecordedProcess {
        program: PathBuf,
        args: Vec<String>,
        current_dir: PathBuf,
        env: Vec<(String, String)>,
        body: Option<String>,
    }

    struct RecordingRunner {
        result: Result<ProcessOutput, EngineError>,
        recorded: Mutex<Vec<RecordedProcess>>,
    }

    impl RecordingRunner {
        fn success() -> Self {
            Self {
                result: Ok(ProcessOutput {
                    success: true,
                    code: Some(0),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                }),
                recorded: Mutex::new(Vec::new()),
            }
        }

        fn json(value: Value) -> Self {
            Self {
                result: Ok(ProcessOutput {
                    success: true,
                    code: Some(0),
                    stdout: serde_json::to_vec(&value).unwrap(),
                    stderr: Vec::new(),
                }),
                recorded: Mutex::new(Vec::new()),
            }
        }
    }

    impl ProcessRunner for RecordingRunner {
        fn run(
            &self,
            spec: &ProcessSpec,
            _cancellation: &CancellationFlag,
        ) -> Result<ProcessOutput, EngineError> {
            let body_path = spec
                .args
                .iter()
                .position(|arg| arg == "--body-file")
                .and_then(|index| spec.args.get(index + 1))
                .map(PathBuf::from);
            self.recorded.lock().unwrap().push(RecordedProcess {
                program: spec.program.clone(),
                args: spec
                    .args
                    .iter()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect(),
                current_dir: spec.current_dir.clone(),
                env: spec
                    .env
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_string_lossy().into_owned()))
                    .collect(),
                body: body_path
                    .as_deref()
                    .map(std::fs::read_to_string)
                    .transpose()
                    .unwrap(),
            });
            self.result.clone()
        }
    }

    #[derive(Default)]
    struct RecordingProvisioner {
        calls: Mutex<Vec<(String, String, PathBuf)>>,
        error: Mutex<Option<EngineError>>,
    }

    impl CompanyProvisioner for RecordingProvisioner {
        fn provision(
            &self,
            slug: &str,
            display_name: &str,
            hq_root: &Path,
            _cancellation: &CancellationFlag,
        ) -> Result<(), EngineError> {
            self.calls.lock().unwrap().push((
                slug.to_string(),
                display_name.to_string(),
                hq_root.to_path_buf(),
            ));
            match self.error.lock().unwrap().clone() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    fn backend(root: &Path) -> CoreBackend {
        CoreBackend::with_roots(root, root.join(".claude"), root.join(".codex"))
    }

    #[test]
    fn bug_report_uses_the_canonical_cli_contract_and_deletes_the_body_file() {
        let temp = tempfile::tempdir().unwrap();
        let runner = RecordingRunner::success();
        let provisioner = RecordingProvisioner::default();

        let result = execute_with_dependencies(
            &backend(temp.path()),
            "submit_bug_report",
            &json!({
                "title": "Meetings stuck",
                "body": "line one\nline two"
            }),
            &CancellationFlag::default(),
            &runner,
            &provisioner,
        )
        .unwrap();

        assert_eq!(result, Value::Null);
        let recorded = runner.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        let command = &recorded[0];
        assert_eq!(command.program, PathBuf::from("hq"));
        assert_eq!(
            &command.args[..5],
            [
                "feedback",
                "bug",
                "--title",
                "Meetings stuck",
                "--body-file"
            ]
        );
        assert_eq!(command.current_dir, temp.path());
        assert_eq!(command.body.as_deref(), Some("line one\nline two"));
        assert!(command
            .env
            .iter()
            .any(|(key, value)| key == "HQ_NO_UPDATE_CHECK" && value == "1"));
        assert!(command
            .env
            .iter()
            .any(|(key, value)| { key == "HQ_ROOT" && Path::new(value) == temp.path() }));
        let body_path = PathBuf::from(command.args.last().unwrap());
        drop(recorded);
        assert!(
            !body_path.exists(),
            "temporary report body must be removed after the subprocess returns"
        );
    }

    #[test]
    fn bug_report_surfaces_the_exit_code_and_stderr_without_leaking_the_body() {
        let temp = tempfile::tempdir().unwrap();
        let runner = RecordingRunner {
            result: Ok(ProcessOutput {
                success: false,
                code: Some(17),
                stdout: b"ignored".to_vec(),
                stderr: b"authentication required\n".to_vec(),
            }),
            recorded: Mutex::new(Vec::new()),
        };

        let error = execute_with_dependencies(
            &backend(temp.path()),
            "submit_bug_report",
            &json!({"title":"Broken","body":"private diagnostic body"}),
            &CancellationFlag::default(),
            &runner,
            &RecordingProvisioner::default(),
        )
        .expect_err("non-zero hq feedback exit must fail");

        assert_eq!(error.code, "submit_bug_report_failed");
        assert!(error.message.contains("exited 17"));
        assert!(error.message.contains("authentication required"));
        assert!(!error.message.contains("private diagnostic body"));
    }

    #[test]
    fn connect_workspace_validates_then_provisions_the_manifest_folder() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("teams/studio")).unwrap();
        std::fs::create_dir_all(temp.path().join("companies")).unwrap();
        std::fs::write(
            temp.path().join("companies/manifest.yaml"),
            "companies:\n  creative-studio:\n    name: Creative Studio HQ\n    path: teams/studio\n",
        )
        .unwrap();
        let provisioner = RecordingProvisioner::default();

        let result = execute_with_dependencies(
            &backend(temp.path()),
            "connect_workspace_to_cloud",
            &json!({"slug":"creative-studio"}),
            &CancellationFlag::default(),
            &RecordingRunner::success(),
            &provisioner,
        )
        .unwrap();

        assert_eq!(result, Value::Null);
        assert_eq!(
            *provisioner.calls.lock().unwrap(),
            vec![(
                "creative-studio".to_string(),
                "Creative Studio HQ".to_string(),
                temp.path().to_path_buf(),
            )]
        );
    }

    #[test]
    fn connect_workspace_rejects_reserved_or_missing_local_targets_without_spawning() {
        let temp = tempfile::tempdir().unwrap();
        let provisioner = RecordingProvisioner::default();
        let runner = RecordingRunner::success();

        for (slug, expected) in [
            ("", "slug is required"),
            ("personal", "Personal vault is auto-provisioned"),
            ("missing", "cannot connect a missing directory"),
        ] {
            let error = execute_with_dependencies(
                &backend(temp.path()),
                "connect_workspace_to_cloud",
                &json!({"slug":slug}),
                &CancellationFlag::default(),
                &runner,
                &provisioner,
            )
            .expect_err("invalid local target must fail before provisioning");
            assert!(
                error.message.contains(expected),
                "unexpected message for {slug:?}: {}",
                error.message
            );
        }

        assert!(provisioner.calls.lock().unwrap().is_empty());
        assert!(runner.recorded.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn production_runner_kills_a_child_when_the_request_is_cancelled() {
        let cancellation = CancellationFlag::default();
        let cancellation_for_thread = cancellation.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            cancellation_for_thread.cancel();
        });
        let spec = ProcessSpec {
            program: PathBuf::from("/bin/sleep"),
            args: vec!["5".into()],
            current_dir: std::env::temp_dir(),
            env: Vec::new(),
        };

        let started = Instant::now();
        let error = CancellableProcessRunner::default()
            .run(&spec, &cancellation)
            .expect_err("cancellation must terminate the child");
        canceller.join().unwrap();

        assert_eq!(error.code, "request_cancelled");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancelled process was not reaped promptly"
        );
    }

    #[cfg(unix)]
    #[test]
    fn dependency_probe_uses_only_the_injected_search_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("native-probe");
        std::fs::write(&executable, "#!/bin/sh\nprintf 'native-probe 7.4.1\\n'\n").unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let status = check_dep_in("native-probe", &temp.path().to_string_lossy());

        assert_eq!(
            status,
            json!({
                "installed": true,
                "version": "native-probe 7.4.1",
                "path": executable.to_string_lossy()
            })
        );
        assert_eq!(
            check_dep_in("definitely-absent", &temp.path().to_string_lossy()),
            json!({"installed":false,"version":null,"path":null})
        );
    }

    #[test]
    fn subprocess_redaction_covers_sensitive_env_values_and_bearer_tokens() {
        let redactor = OutputRedactor::from_env(&[
            ("PATH".to_string(), OsString::from("/bin")),
            (
                "HQ_ACCESS_TOKEN".to_string(),
                OsString::from("top-secret-value"),
            ),
        ]);

        let line = redactor.redact(
            "failed token=top-secret-value Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        );

        assert!(!line.contains("top-secret-value"));
        assert!(!line.contains("eyJhbGci"));
        assert!(line.contains("[REDACTED]"));
    }

    #[test]
    fn spawn_process_contract_accepts_the_legacy_nested_args_shape() {
        let temp = tempfile::tempdir().unwrap();
        let spec = parse_spawn_process_spec(
            &json!({
                "args": {
                    "cmd": "/usr/bin/printf",
                    "args": ["hello", "%s"],
                    "cwd": temp.path(),
                    "env": {"SAFE_FLAG": "1"}
                }
            }),
            temp.path(),
        )
        .unwrap();

        assert_eq!(spec.program, PathBuf::from("/usr/bin/printf"));
        assert_eq!(
            spec.args,
            vec![OsString::from("hello"), OsString::from("%s")]
        );
        assert_eq!(spec.current_dir, temp.path());
        assert!(spec
            .env
            .iter()
            .any(|(key, value)| key == "SAFE_FLAG" && value == "1"));
    }

    #[test]
    fn sync_ndjson_maps_only_typed_runner_events() {
        assert_eq!(
            parse_sync_event_line(
                r#"{"type":"progress","company":"acme","path":"docs/a.md","bytes":12}"#
            )
            .unwrap(),
            (
                "sync:progress",
                json!({"company":"acme","path":"docs/a.md","bytes":12})
            )
        );
        assert!(parse_sync_event_line("not-json").is_none());
        assert!(parse_sync_event_line(r#"{"type":"made-up"}"#).is_none());
    }

    #[test]
    fn sync_plan_stream_emits_cumulative_transfer_totals() {
        let temp = tempfile::tempdir().unwrap();
        let backend = backend(temp.path());
        let mut events = backend.event_bus().subscribe();
        let mode = StreamEventMode::Sync {
            backend,
            planned_files: Arc::new(Mutex::new(0)),
        };

        mode.emit_line(
            true,
            r#"{"type":"plan","company":"acme","filesToDownload":2,"bytesToDownload":20,"filesToUpload":3,"bytesToUpload":30,"filesToSkip":1,"filesToConflict":0,"filesToDelete":1}"#,
        );
        mode.emit_line(
            true,
            r#"{"type":"plan","company":"beta","filesToDownload":4,"bytesToDownload":40,"filesToUpload":0,"bytesToUpload":0,"filesToSkip":0,"filesToConflict":0}"#,
        );

        let observed = (0..4)
            .map(|_| events.try_recv().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            observed
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            ["sync:plan", "sync:totals", "sync:plan", "sync:totals"]
        );
        assert_eq!(observed[1].data, json!({"totalFiles":6}));
        assert_eq!(observed[3].data, json!({"totalFiles":10}));
    }

    #[test]
    fn external_sync_progress_watcher_deduplicates_transitions_and_stops_cleanly() {
        use hq_desktop_core::sync_progress::SyncProgressSnapshot;
        use std::sync::atomic::AtomicUsize;

        fn snapshot(files_done: u64, current_file: &str) -> SyncProgressSnapshot {
            SyncProgressSnapshot {
                pid: 42,
                company: Some("acme".to_string()),
                phase: "pull".to_string(),
                files_total: 3,
                files_done,
                conflicts: 0,
                current_file: Some(current_file.to_string()),
                started_at: "2026-07-27T00:00:00Z".to_string(),
                updated_at: format!("2026-07-27T00:00:0{files_done}Z"),
                status: "syncing".to_string(),
            }
        }

        let snapshots = Arc::new(Mutex::new(std::collections::VecDeque::from([
            Some(snapshot(1, "docs/a.md")),
            Some(snapshot(1, "docs/a.md")),
            Some(snapshot(2, "docs/b.md")),
            None,
        ])));
        let reads = Arc::new(AtomicUsize::new(0));
        let reader_snapshots = Arc::clone(&snapshots);
        let reader_reads = Arc::clone(&reads);
        let reader: SyncProgressReader = Arc::new(move || {
            reader_reads.fetch_add(1, Ordering::AcqRel);
            reader_snapshots.lock().unwrap().pop_front().flatten()
        });
        let bus = EngineEventBus::bounded(16);
        let mut events = bus.subscribe();
        let watcher = spawn_external_sync_progress_watcher(bus, Duration::from_millis(5), reader);

        let deadline = Instant::now() + Duration::from_secs(1);
        let mut observed = Vec::new();
        while observed.len() < 3 && Instant::now() < deadline {
            match events.try_recv() {
                Ok(event) => observed.push(event),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("unexpected event receive failure: {error}"),
            }
        }

        assert_eq!(
            observed
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            [
                "sync:external-progress",
                "sync:external-progress",
                "sync:external-idle"
            ]
        );
        assert_eq!(observed[0].data["filesDone"], 1);
        assert_eq!(observed[1].data["filesDone"], 2);
        assert_eq!(observed[2].data, Value::Null);

        watcher.shutdown();
        let reads_after_shutdown = reads.load(Ordering::Acquire);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(reads.load(Ordering::Acquire), reads_after_shutdown);
    }

    #[cfg(unix)]
    #[test]
    fn managed_process_streams_redacted_output_and_external_cancel_reaps_it() {
        let bus = EngineEventBus::bounded(16);
        let mut events = bus.subscribe();
        let handle = format!("node-test-{}", uuid::Uuid::new_v4());
        let spec = ProcessSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".into(),
                "printf 'token=super-secret\\n'; sleep 5".into(),
            ],
            current_dir: std::env::temp_dir(),
            env: vec![(
                "HQ_ACCESS_TOKEN".to_string(),
                OsString::from("super-secret"),
            )],
        };
        let worker_handle = handle.clone();
        let worker_bus = bus.clone();
        let managed_processes = Arc::new(ManagedProcessRegistry::default());
        let worker_processes = Arc::clone(&managed_processes);
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            run_managed_process(
                &worker_processes,
                &worker_handle,
                &spec,
                &CancellationFlag::default(),
                StreamEventMode::Process {
                    bus: worker_bus,
                    handle: worker_handle.clone(),
                },
            )
        });

        let wait_started = Instant::now();
        while !managed_processes
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&handle)
        {
            assert!(wait_started.elapsed() < Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(5));
        }
        let stdout = loop {
            match events.try_recv() {
                Ok(event) if event.name.ends_with("/stdout") => break event,
                Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    assert!(wait_started.elapsed() < Duration::from_secs(1));
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("unexpected event receive failure: {error}"),
            }
        };
        assert!(managed_processes.cancel(&handle));
        let result = worker.join().unwrap();
        assert_eq!(result.unwrap_err().code, "request_cancelled");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!managed_processes.cancel(&handle));

        let mut observed = Vec::new();
        while let Ok(event) = events.try_recv() {
            observed.push(event);
        }
        assert_eq!(stdout.data, json!({"line":"token=[REDACTED]"}));
        assert!(observed.iter().any(|event| {
            event.name.ends_with("/exit") && event.data.get("success") == Some(&Value::Bool(false))
        }));
    }

    #[test]
    fn managed_process_registry_reaps_finished_workers_and_rejects_post_shutdown_work() {
        let registry = ManagedProcessRegistry::default();

        for _ in 0..3 {
            let (done_tx, done_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                done_tx.send(()).unwrap();
            });
            registry.track_worker(worker);
            done_rx.recv().unwrap();
            while !registry
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .all(thread::JoinHandle::is_finished)
            {
                thread::yield_now();
            }
        }

        assert_eq!(
            registry
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            1,
            "tracking a new worker must reap previously finished handles"
        );

        registry.shutdown();
        assert_eq!(
            registry.reserve("after-shutdown").unwrap_err().code,
            "process_registry_shutting_down"
        );
    }

    #[test]
    fn package_snapshot_uses_both_canonical_json_commands() {
        let temp = tempfile::tempdir().unwrap();
        let runner = RecordingRunner::json(json!({"installed":[]}));

        let result = execute_with_dependencies(
            &backend(temp.path()),
            "list_packages",
            &json!({}),
            &CancellationFlag::default(),
            &runner,
            &RecordingProvisioner::default(),
        )
        .unwrap();

        assert_eq!(result["packs"], json!({"installed":[]}));
        assert_eq!(result["registry"], json!({"installed":[]}));
        assert_eq!(result["error"], Value::Null);
        let recorded = runner.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].args, ["packs", "list", "--json"]);
        assert_eq!(recorded[1].args, ["packages", "list", "--json"]);
        assert!(recorded.iter().all(|command| {
            command
                .env
                .iter()
                .any(|(key, value)| key == "HQ_NO_UPDATE_CHECK" && value == "1")
        }));
    }

    #[test]
    fn update_packs_runs_named_updates_sequentially_and_emits_completion() {
        let temp = tempfile::tempdir().unwrap();
        let backend = backend(temp.path());
        let mut events = backend.event_bus().subscribe();
        let runner = RecordingRunner::success();

        let result = execute_with_dependencies(
            &backend,
            "update_packs",
            &json!({"names":["alpha","beta"]}),
            &CancellationFlag::default(),
            &runner,
            &RecordingProvisioner::default(),
        )
        .unwrap();

        assert_eq!(result, Value::Null);
        let recorded = runner.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].args, ["packs", "update", "alpha", "--yes"]);
        assert_eq!(recorded[1].args, ["packs", "update", "beta", "--yes"]);
        drop(recorded);
        let first = events.try_recv().unwrap();
        let second = events.try_recv().unwrap();
        assert_eq!(first.name, "packages:complete");
        assert_eq!(first.data, json!({"op":"update","name":"alpha"}));
        assert_eq!(second.name, "packages:complete");
        assert_eq!(second.data, json!({"op":"update","name":"beta"}));
    }

    #[test]
    fn manual_sync_builder_pins_runner_and_scopes_company_without_a_shell() {
        let temp = tempfile::tempdir().unwrap();
        let spec = manual_sync_spec(temp.path(), Some("acme")).unwrap();
        let args = spec
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "--company")
                .count(),
            1
        );
        assert!(args.windows(2).any(|pair| pair == ["--company", "acme"]));
        assert!(args.iter().any(|arg| arg == "--skip-personal"));
        assert!(args
            .iter()
            .any(|arg| arg.starts_with("--package=@indigoai-us/hq-cloud@")));
        assert!(!args.iter().any(|arg| arg == "-c"));
        assert_eq!(spec.current_dir, temp.path());
    }

    #[test]
    fn pack_update_summary_ignores_malformed_and_false_rows() {
        assert_eq!(
            pack_update_summary(&json!({
                "installed":[
                    {"name":"one","updateAvailable":true},
                    {"name":"two","updateAvailable":false},
                    {"updateAvailable":true},
                    {"name":"three","updateAvailable":"yes"}
                ]
            })),
            json!({"count":1,"names":["one"]})
        );
    }

    #[test]
    fn checksum_refresh_hashes_locked_content_and_preserves_yaml_comments() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("core")).unwrap();
        std::fs::create_dir_all(temp.path().join("locked/sub")).unwrap();
        std::fs::write(temp.path().join("locked/a.txt"), b"alpha\n").unwrap();
        std::fs::write(temp.path().join("locked/sub/b.txt"), b"beta\n").unwrap();
        std::fs::write(
            temp.path().join("core/core.yaml"),
            "hqVersion: 1.2.3\n# retain me\nupdatedAt: \"old\"\nrules:\n  locked:\n    - locked/\n    - missing.txt\n    - core/core.yaml\nchecksums:\n  stale: deadbeef\n",
        )
        .unwrap();

        let result = compute_checksums_at(temp.path()).unwrap();
        let rendered = std::fs::read_to_string(temp.path().join("core/core.yaml")).unwrap();

        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert_eq!(result["entries"][0]["path"], "locked");
        assert_eq!(result["missing"], json!(["missing.txt"]));
        assert!(result["updatedAt"].as_str().unwrap().ends_with('Z'));
        assert!(rendered.contains("# retain me"));
        assert!(rendered.contains("checksums:\n  locked: "));
        assert!(!rendered.contains("stale: deadbeef"));
    }

    #[test]
    fn claude_settings_path_update_preserves_existing_keys() {
        let updated = settings_json_with_env_path(
            r#"{"permissions":{"allow":["Read"]},"env":{"SAFE":"1","PATH":"/old"}}"#,
            "/managed:/usr/bin",
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&updated).unwrap();

        assert_eq!(parsed["permissions"]["allow"][0], "Read");
        assert_eq!(parsed["env"]["SAFE"], "1");
        assert_eq!(parsed["env"]["PATH"], "/managed:/usr/bin");
    }

    #[test]
    fn restore_path_must_be_safe_and_inside_a_locked_scope() {
        let locked = vec!["core/".to_string(), "AGENTS.md".to_string()];

        assert!(validate_locked_restore_path("core/docs/guide.md", &locked).is_ok());
        assert!(validate_locked_restore_path("AGENTS.md", &locked).is_ok());
        assert!(validate_locked_restore_path("../outside", &locked).is_err());
        assert!(validate_locked_restore_path("personal/profile.md", &locked).is_err());
        assert!(validate_locked_restore_path("/tmp/outside", &locked).is_err());
    }

    #[test]
    fn personal_first_push_spec_uses_the_pinned_cli_contract_without_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let spec = personal_first_push_spec_for(
            temp.path(),
            hq_desktop_core::hq_resolver::HqInvocation::Npx,
        );
        let args = spec
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            args,
            [
                "-y",
                "--package",
                "@indigoai-us/hq-cli@^5.10.0",
                "hq",
                "sync",
                "push",
                "--personal",
                "--json",
                "--hq-root",
                temp.path().to_string_lossy().as_ref(),
            ]
        );
        assert!(spec.env.iter().all(|(key, _)| !is_sensitive_env_key(key)));
    }

    #[test]
    fn personal_first_push_jsonl_maps_plan_progress_complete_and_fatal() {
        let mut state = PersonalFirstPushState::default();

        assert_eq!(
            parse_personal_first_push_line(
                r#"{"type":"plan","filesToUpload":2,"filesToSkip":3}"#,
                &mut state,
            ),
            Some((
                "sync:personal-first-push-scan",
                json!({
                    "personUid":"personal",
                    "filesScanned":5,
                    "filesTotal":5,
                    "currentFile":null
                })
            ))
        );
        assert_eq!(
            parse_personal_first_push_line(
                r#"{"type":"progress","path":"personal/profile.md","bytes":12}"#,
                &mut state,
            ),
            Some((
                "sync:personal-first-push-progress",
                json!({
                    "personUid":"personal",
                    "filesDone":1,
                    "filesTotal":5,
                    "currentFile":"personal/profile.md"
                })
            ))
        );
        assert_eq!(
            parse_personal_first_push_line(
                r#"{"type":"complete","filesUploaded":2,"filesSkipped":3}"#,
                &mut state,
            ),
            Some((
                "sync:personal-first-push-complete",
                json!({
                    "personUid":"personal",
                    "filesUploaded":2,
                    "filesSkipped":3
                })
            ))
        );
        assert_eq!(
            parse_personal_first_push_line(
                r#"{"type":"fatal","message":"session expired"}"#,
                &mut state,
            ),
            Some((
                "sync:error",
                json!({
                    "company":"personal",
                    "path":"(initial-sync)",
                    "message":"session expired"
                })
            ))
        );
        assert!(state.terminal_event_seen);
        assert!(parse_personal_first_push_line("not-json", &mut state).is_none());
    }

    #[test]
    fn resolve_conflict_validates_and_runs_the_exact_cli_contract() {
        let temp = tempfile::tempdir().unwrap();
        let runner = RecordingRunner::success();

        let result = execute_with_dependencies(
            &backend(temp.path()),
            "resolve_conflict",
            &json!({"path":"companies/acme/docs/plan.md","strategy":"keep-remote"}),
            &CancellationFlag::default(),
            &runner,
            &RecordingProvisioner::default(),
        )
        .unwrap();

        assert_eq!(result, Value::Null);
        let recorded = runner.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0].args,
            [
                "sync",
                "resolve",
                "--strategy",
                "keep-remote",
                "--path",
                "companies/acme/docs/plan.md",
                "--hq-path",
                temp.path().to_string_lossy().as_ref(),
            ]
        );
        assert!(recorded[0].env.iter().any(
            |(key, value)| key == "HQ_ROOT" && value == temp.path().to_string_lossy().as_ref()
        ));
        drop(recorded);

        let error = execute_with_dependencies(
            &backend(temp.path()),
            "resolve_conflict",
            &json!({"path":"docs/plan.md","strategy":"merge"}),
            &CancellationFlag::default(),
            &runner,
            &RecordingProvisioner::default(),
        )
        .expect_err("unknown conflict strategies must be rejected before spawning");
        assert_eq!(error.code, "invalid_conflict_strategy");
        assert_eq!(runner.recorded.lock().unwrap().len(), 1);
    }

    #[test]
    fn core_state_reads_only_matching_floor_stamps_and_compares_semver_numerically() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("core")).unwrap();
        std::fs::write(
            temp.path().join("core/core.yaml"),
            "hqVersion: 14.9.0\nreplaced_from_source:\n  source: indigoai-us/hq-core\n  last_sync_sha: abc123\n",
        )
        .unwrap();

        assert_eq!(hq_core_version_at(temp.path()).as_deref(), Some("14.9.0"));
        assert_eq!(
            hq_core_floor_at(temp.path(), "indigoai-us/hq-core").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            hq_core_floor_at(temp.path(), "indigoai-us/hq-core-staging"),
            None
        );
        assert!(core_version_is_behind("14.9.0", "14.10.0"));
        assert!(!core_version_is_behind("14.10.0", "14.9.0"));
    }
}
