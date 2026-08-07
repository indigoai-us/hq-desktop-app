//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

use std::collections::HashMap;
use std::fmt;
use std::io::{self, BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

pub use hq_desktop_core::process_types::{
    ExitEvent, ProcessEvent, SpawnArgs, StderrEvent, StdoutEvent,
};
#[cfg(unix)]
use nix::{
    sys::signal::{self, Signal},
    unistd::Pid,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// The point in the process lifecycle that failed.
///
/// Callers must not infer this from the rendered message: a stream or wait
/// failure happens after a child existed, while only `Spawn` means no watcher
/// ever started. The spawn Display text intentionally remains byte-for-byte
/// compatible with the previous string return value.
#[derive(Debug)]
pub enum ProcessError {
    Spawn {
        cmd: String,
        source: io::Error,
    },
    Stream {
        stream: &'static str,
        source: io::Error,
    },
    Wait {
        source: io::Error,
    },
}

impl ProcessError {
    pub fn is_spawn(&self) -> bool {
        matches!(self, Self::Spawn { .. })
    }

    pub fn error_kind(&self) -> Option<io::ErrorKind> {
        match self {
            Self::Spawn { source, .. } => Some(source.kind()),
            Self::Stream { source, .. } => Some(source.kind()),
            Self::Wait { source } => Some(source.kind()),
        }
    }

    pub fn raw_os_error(&self) -> Option<i32> {
        match self {
            Self::Spawn { source, .. } => source.raw_os_error(),
            Self::Stream { source, .. } => source.raw_os_error(),
            Self::Wait { source } => source.raw_os_error(),
        }
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { cmd, source } => write!(f, "spawn '{cmd}': {source}"),
            Self::Stream { stream, source } => write!(f, "{stream}: {source}"),
            Self::Wait { source } => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for ProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn { source, .. } => Some(source),
            Self::Stream { source, .. } => Some(source),
            Self::Wait { source } => Some(source),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ProcessEntry {
    pid: Option<u32>,
    cancelled: bool,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();

/// Raised at the single application-exit choke point before child teardown.
/// The daemon reads this as exit evidence; it does not alter cancellation or
/// crash classification.
static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn app_exit_requested() -> bool {
    APP_EXIT_REQUESTED.load(Ordering::Acquire)
}

/// Raised only by the app's `RunEvent::ExitRequested` arm, i.e. only when the
/// *app* asked to quit (tray Quit, `quit_app`, Cmd-Q, last window closed).
///
/// This is deliberately NOT `APP_EXIT_REQUESTED`: that flag is set inside
/// `terminate_all_for_exit`, which the Windows session-end path also calls, so
/// it cannot tell the two exits apart. This one can, because
/// `RunEvent::ExitRequested` is never emitted for a Windows `WM_ENDSESSION`
/// (tauri-runtime-wry raises it only when the last window is destroyed or on
/// `Message::RequestExit`) — so `RunEvent::Exit` with this flag still false
/// means the OS is ending the desktop session.
static APP_INITIATED_EXIT: AtomicBool = AtomicBool::new(false);

/// Latch the app-initiated quit. One-way: an exit is never un-requested.
pub fn note_app_initiated_exit() {
    APP_INITIATED_EXIT.store(true, Ordering::Release);
}

/// Read by the Windows-only `RunEvent::Exit` arm (and by this crate's tests on
/// every host); gated so a macOS/Linux release build does not carry it as dead
/// code.
#[cfg(any(target_os = "windows", test))]
pub fn app_initiated_exit() -> bool {
    APP_INITIATED_EXIT.load(Ordering::Acquire)
}

fn process_registry() -> &'static Arc<Mutex<HashMap<String, ProcessEntry>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub fn pre_register_handle(handle: &str) {
    process_registry()
        .lock()
        .unwrap()
        .insert(handle.to_string(), ProcessEntry::default());
}

/// Atomically check-and-register a handle. Returns `true` if the handle was
/// newly registered, `false` if it was already present (i.e. a process is
/// already running under this handle).
pub fn try_register_handle(handle: &str) -> bool {
    use std::collections::hash_map::Entry;
    let mut reg = process_registry().lock().unwrap();
    match reg.entry(handle.to_string()) {
        Entry::Occupied(_) => false,
        Entry::Vacant(v) => {
            v.insert(ProcessEntry::default());
            true
        }
    }
}

pub fn register_process(handle: &str, pid: u32) {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.pid = Some(pid);
    } else {
        reg.insert(
            handle.to_string(),
            ProcessEntry {
                pid: Some(pid),
                cancelled: false,
                #[cfg(target_os = "windows")]
                job_handle: None,
            },
        );
    }
}

#[cfg(target_os = "windows")]
fn register_job_handle(handle: &str, job: isize) {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.job_handle = Some(job);
    }
}

pub fn deregister_process(handle: &str) {
    #[cfg(target_os = "windows")]
    {
        let mut reg = process_registry().lock().unwrap();
        if let Some(entry) = reg.remove(handle) {
            if let Some(job) = entry.job_handle {
                unsafe {
                    let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        process_registry().lock().unwrap().remove(handle);
    }
}

pub fn lookup_pid(handle: &str) -> Option<u32> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|e| e.pid)
}

pub fn is_registered(handle: &str) -> bool {
    process_registry().lock().unwrap().contains_key(handle)
}

/// Whether the process under `handle` was deliberately cancelled (SIGTERM sent
/// via [`cancel_process_impl`], e.g. on app quit) rather than exiting on its own.
///
/// Read inside an [`ProcessEvent::Exit`] handler to distinguish an orderly
/// shutdown from an unexpected crash: the entry is still present at exit time
/// (it is `deregister`'d only after the exit event fires), so the `cancelled`
/// flag is observable. `recall_sdk` uses this so it only synthesizes terminal
/// `recording:error` events on an *unexpected* sidecar death, not when the app
/// is intentionally tearing the SDK down.
pub fn is_cancelled(handle: &str) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|e| e.cancelled)
        .unwrap_or(false)
}

fn mark_cancelled(handle: &str) -> bool {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.cancelled = true;
        true
    } else {
        false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform helpers
// ─────────────────────────────────────────────────────────────────────────────

fn build_spawn_command(path: &str, args: &[String]) -> Command {
    // Keep the target and arguments structured. On Windows, Rust performs the
    // required batch dispatch for .cmd/.bat files with batch-aware escaping;
    // routing them through a hand-built `cmd.exe /c` command line would turn
    // caller-controlled HQ paths and package ranges into shell syntax.
    let mut cmd = Command::new(path);
    cmd.args(args);
    // Shared CREATE_NO_WINDOW helper — daemons, probes, and other background
    // children stay invisible. Explicit user-requested terminals do not use
    // this spawn path.
    crate::util::paths::no_window(&mut cmd);
    cmd
}

#[cfg(unix)]
fn put_in_own_process_group(cmd: &mut Command) {
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn put_in_own_process_group(_cmd: &mut Command) {}

#[cfg(unix)]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

#[cfg(target_os = "windows")]
unsafe fn create_kill_on_close_job() -> Result<HANDLE, String> {
    let job = CreateJobObjectW(None, PCWSTR::null())
        .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;

    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

    SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const std::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    )
    .map_err(|e| {
        let _ = CloseHandle(job);
        format!("SetInformationJobObject (KILL_ON_JOB_CLOSE) failed: {e}")
    })?;

    Ok(job)
}

#[cfg(target_os = "windows")]
fn assign_child_to_job(handle: &str, child: &std::process::Child) {
    let proc_handle = HANDLE(child.as_raw_handle());
    unsafe {
        match create_kill_on_close_job() {
            Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                Ok(()) => register_job_handle(handle, job.0 as isize),
                Err(e) => {
                    let _ = CloseHandle(job);
                    eprintln!("[process] AssignProcessToJobObject failed for handle {handle}: {e}");
                }
            },
            Err(e) => {
                eprintln!("[process] create_kill_on_close_job failed for handle {handle}: {e}");
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn assign_child_to_job(_handle: &str, _child: &std::process::Child) {}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

pub fn run_process_impl<F>(handle: &str, spawn: &SpawnArgs, on_event: F) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
{
    let mut cmd = build_spawn_command(&spawn.cmd, &spawn.args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    put_in_own_process_group(&mut cmd);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &spawn.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            deregister_process(handle);
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let pid = child.id();
    register_process(handle, pid);
    assign_child_to_job(handle, &child);

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    enum ReaderMsg {
        Event(ProcessEvent),
        Done {
            stream: &'static str,
            err: Option<io::Error>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<io::Error> = None;
        for line_result in BufReader::new(stdout).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stdout
                        .send(ReaderMsg::Event(ProcessEvent::Stdout(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        let _ = tx_stdout.send(ReaderMsg::Done {
            stream: "stdout",
            err,
        });
    });

    let tx_stderr = tx.clone();
    thread::spawn(move || {
        let mut err: Option<io::Error> = None;
        for line_result in BufReader::new(stderr).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stderr
                        .send(ReaderMsg::Event(ProcessEvent::Stderr(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        let _ = tx_stderr.send(ReaderMsg::Done {
            stream: "stderr",
            err,
        });
    });

    drop(tx);

    let mut on_event_mut = on_event;
    let mut first_stream_err: Option<(&'static str, io::Error)> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some((stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait();

    if let Some((stream, source)) = first_stream_err {
        emit_exit_then_deregister(
            handle,
            &mut on_event_mut,
            ProcessEvent::Exit {
                code: None,
                signal: None,
                success: false,
            },
        );
        return Err(ProcessError::Stream { stream, source });
    }

    let status = match wait_result {
        Ok(status) => status,
        Err(source) => {
            // The child did start, so callers must route this through their
            // termination path rather than mislabel it as a spawn failure.
            emit_exit_then_deregister(
                handle,
                &mut on_event_mut,
                ProcessEvent::Exit {
                    code: None,
                    signal: None,
                    success: false,
                },
            );
            return Err(ProcessError::Wait { source });
        }
    };
    emit_exit_then_deregister(
        handle,
        &mut on_event_mut,
        ProcessEvent::Exit {
            code: status.code(),
            signal: exit_signal(&status),
            success: status.success(),
        },
    );

    Ok(())
}

/// Keep the registry entry alive through the terminal callback so consumers
/// can observe whether cancellation was requested for this exact process
/// generation. The child has already been reaped, and registry cleanup happens
/// immediately after the callback returns.
fn emit_exit_then_deregister<F>(handle: &str, on_event: &mut F, event: ProcessEvent)
where
    F: FnMut(ProcessEvent),
{
    on_event(event);
    deregister_process(handle);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl — variant with piped stdin
// ─────────────────────────────────────────────────────────────────────────────

/// Like [`run_process_impl`], but also pipes stdin and invokes `on_spawn`
/// once with the child's `ChildStdin` immediately after spawn.
///
/// The callback receives `&mut Child` so it can `child.stdin.take()` and
/// stash the handle wherever it needs to live (typically a module-level
/// `Mutex<Option<ChildStdin>>` so other Tauri commands can write to it).
///
/// Used by the Recall SDK bridge to drive `start-recording` /
/// `stop-recording` commands without spawning a new SDK process per
/// recording. Other callers continue to use `run_process_impl`, which
/// keeps the existing stdin=inherit default and avoids any
/// reads-from-stdin-on-an-unwriter-pipe surprises.
pub fn run_process_with_stdin_impl<F, S>(
    handle: &str,
    spawn: &SpawnArgs,
    on_event: F,
    on_spawn: S,
) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
    S: FnOnce(&mut std::process::Child),
{
    let mut cmd = build_spawn_command(&spawn.cmd, &spawn.args);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    put_in_own_process_group(&mut cmd);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &spawn.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            deregister_process(handle);
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let pid = child.id();
    register_process(handle, pid);
    assign_child_to_job(handle, &child);

    // Let the caller take stdin (and stash the handle) before we start
    // reading stdout/stderr — if the caller's setup writes a startup
    // command, it should land before the bridge has emitted anything.
    on_spawn(&mut child);

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    enum ReaderMsg {
        Event(ProcessEvent),
        Done {
            stream: &'static str,
            err: Option<io::Error>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<io::Error> = None;
        for line_result in BufReader::new(stdout).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stdout
                        .send(ReaderMsg::Event(ProcessEvent::Stdout(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        let _ = tx_stdout.send(ReaderMsg::Done {
            stream: "stdout",
            err,
        });
    });

    let tx_stderr = tx.clone();
    thread::spawn(move || {
        let mut err: Option<io::Error> = None;
        for line_result in BufReader::new(stderr).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stderr
                        .send(ReaderMsg::Event(ProcessEvent::Stderr(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        let _ = tx_stderr.send(ReaderMsg::Done {
            stream: "stderr",
            err,
        });
    });

    drop(tx);

    let mut on_event_mut = on_event;
    let mut first_stream_err: Option<(&'static str, io::Error)> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some((stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait();

    if let Some((stream, source)) = first_stream_err {
        emit_exit_then_deregister(
            handle,
            &mut on_event_mut,
            ProcessEvent::Exit {
                code: None,
                signal: None,
                success: false,
            },
        );
        return Err(ProcessError::Stream { stream, source });
    }

    let status = match wait_result {
        Ok(status) => status,
        Err(source) => {
            // Keep the post-spawn failure on the terminal-event path so a
            // caller cannot emit a second, misleading "failed to spawn" alert.
            emit_exit_then_deregister(
                handle,
                &mut on_event_mut,
                ProcessEvent::Exit {
                    code: None,
                    signal: None,
                    success: false,
                },
            );
            return Err(ProcessError::Wait { source });
        }
    };
    emit_exit_then_deregister(
        handle,
        &mut on_event_mut,
        ProcessEvent::Exit {
            code: status.code(),
            signal: exit_signal(&status),
            success: status.success(),
        },
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

pub fn cancel_process_impl(handle: &str, sigkill_delay: Duration) -> bool {
    if !mark_cancelled(handle) {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let job_isize = process_registry()
            .lock()
            .unwrap()
            .get(handle)
            .and_then(|e| e.job_handle);

        if let Some(job) = job_isize {
            unsafe {
                let job_handle = HANDLE(job as *mut std::ffi::c_void);
                let _ = TerminateJobObject(job_handle, 1);
            }
        }
        let _ = sigkill_delay;
        return true;
    }

    #[cfg(unix)]
    {
        let pid = match lookup_pid(handle) {
            Some(p) => p,
            None => return true,
        };

        let pgid = Pid::from_raw(-(pid as i32));
        let _ = signal::kill(pgid, Signal::SIGTERM);

        let handle_owned = handle.to_string();
        thread::spawn(move || {
            thread::sleep(sigkill_delay);
            if is_registered(&handle_owned) {
                let _ = signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
                deregister_process(&handle_owned);
            }
        });

        return true;
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = sigkill_delay;
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// App-exit teardown
// ─────────────────────────────────────────────────────────────────────────────

/// Snapshot every currently-registered child as `(handle, pid)`.
///
/// On Unix, each child is spawned with `.process_group(0)` and leads its own
/// process group. On Windows, the pid is paired with a Job Object handle in the
/// registry so cancellation can terminate the tree.
pub fn registered_pids() -> Vec<(String, u32)> {
    process_registry()
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(h, e)| e.pid.map(|p| (h.clone(), p)))
        .collect()
}

#[cfg(unix)]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], grace: Duration) {
    for (_handle, pid) in pids {
        let _ = signal::kill(Pid::from_raw(-(*pid as i32)), Signal::SIGTERM);
    }
    if !pids.is_empty() {
        thread::sleep(grace);
    }
    for (handle, pid) in pids {
        let _ = signal::kill(Pid::from_raw(-(*pid as i32)), Signal::SIGKILL);
        deregister_process(handle);
    }
}

#[cfg(target_os = "windows")]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], _grace: Duration) {
    for (handle, _pid) in pids {
        let _ = cancel_process_impl(handle, Duration::ZERO);
        deregister_process(handle);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], _grace: Duration) {
    for (handle, _pid) in pids {
        deregister_process(handle);
    }
}

/// Tear down every spawned child on app exit. Call from the app's
/// `RunEvent::ExitRequested` handler so closing HQ Sync (tray Quit, `quit_app`,
/// or Cmd-Q) reliably stops the `--watch` sync daemon and any sidecar instead
/// of orphaning them.
///
/// Windows session end (`WM_ENDSESSION`) never produces `ExitRequested`, so the
/// session-end branch of `RunEvent::Exit` calls this too. Idempotent by
/// construction: the registry empties as children are reaped, so a second call
/// on a path that already ran is a no-op.
pub fn terminate_all_for_exit(grace: Duration) {
    APP_EXIT_REQUESTED.store(true, Ordering::Release);
    terminate_pids_for_exit(&registered_pids(), grace);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-end ownership report
// ─────────────────────────────────────────────────────────────────────────────

/// Env var naming the file the Windows session-end teardown writes its
/// ownership report to.
///
/// Unset in every shipped build, so the whole path below is inert in
/// production. The session-end artifact proof
/// (`apps/sync/e2e/desktop-alt/windows-session-end.spec.ts`) points it at a
/// temp file and reads the result back, which buys it two things nothing else
/// can:
///
/// - the file existing at all proves the Windows `RunEvent::Exit` teardown
///   really ran — delete the arm, its cfg gate, or the teardown call and the
///   proof goes red even when the registry happens to be empty; and
/// - the pids it lists are exactly the children this app claims to own, so the
///   proof can assert the teardown's actual claim instead of guessing at
///   process names from an image-name blocklist. The app is the only thing
///   that knows what it spawned through `run_process_impl`; anything else is
///   inference over a `ParentProcessId` query whose pid is reusable the
///   instant the app exits.
pub const SESSION_END_OWNED_PIDS_ENV: &str = "HQ_SYNC_SESSION_END_OWNED_PIDS";

/// Resolve the report destination from a raw env value.
///
/// Split out from the env read itself so both branches stay unit testable
/// without a test mutating process-wide state out from under its neighbours.
pub fn owned_pids_report_path(raw: Option<std::ffi::OsString>) -> Option<std::path::PathBuf> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(raw))
}

/// Render a registry snapshot as the ownership report.
///
/// Content-safe by construction: handles are UUIDs or the fixed singleton
/// names (`hq-sync`, `hq-sync-daemon`) and pids are integers. No paths,
/// arguments, or user identifiers, so CI may print the whole thing.
pub fn owned_pids_report_json(pids: &[(String, u32)]) -> String {
    let owned: Vec<serde_json::Value> = pids
        .iter()
        .map(|(handle, pid)| serde_json::json!({ "handle": handle, "pid": pid }))
        .collect();
    serde_json::json!({ "pids": owned }).to_string()
}

/// Write the ownership report: one small write, no fsync, no retry.
pub fn write_owned_pids_report(path: &std::path::Path, pids: &[(String, u32)]) -> io::Result<()> {
    std::fs::write(path, owned_pids_report_json(pids))
}

/// Best-effort ownership report — never panics and never propagates.
///
/// This runs inside a Windows window procedure during the session-end
/// teardown, where an unwind aborts the process exactly the way HQ-DESKTOP-44
/// did. A failed write is logged and the teardown continues; the proof reads
/// the missing file as a failure, and the log line says why it is missing.
pub fn report_owned_pids_to(path: Option<&std::path::Path>, pids: &[(String, u32)]) {
    let Some(path) = path else {
        return;
    };
    if let Err(err) = write_owned_pids_report(path, pids) {
        crate::util::logfile::log(
            "process",
            &format!("SESSION_END_OWNED_PIDS report write failed: {err}"),
        );
    }
}

/// Env-gated entry point for the Windows session-end teardown.
///
/// Call it immediately BEFORE `terminate_all_for_exit`, while the registry
/// still holds the children that are about to be terminated — afterwards the
/// registry has emptied and the report would name nothing.
#[cfg(any(target_os = "windows", test))]
pub fn report_session_end_owned_pids() {
    let path = owned_pids_report_path(std::env::var_os(SESSION_END_OWNED_PIDS_ENV));
    report_owned_pids_to(path.as_deref(), &registered_pids());
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let handle = Uuid::new_v4().to_string();

    pre_register_handle(&handle);

    let handle_bg = handle.clone();
    thread::spawn(move || {
        if is_cancelled(&handle_bg) {
            deregister_process(&handle_bg);
            let _ = app.emit(
                &format!("process://{}/exit", handle_bg),
                ExitEvent {
                    code: Some(-1),
                    signal: None,
                    success: false,
                },
            );
            return;
        }

        let result = run_process_impl(&handle_bg, &args, |event| match event {
            ProcessEvent::Stdout(line) => {
                let _ = app.emit(
                    &format!("process://{}/stdout", handle_bg),
                    StdoutEvent { line },
                );
            }
            ProcessEvent::Stderr(line) => {
                let _ = app.emit(
                    &format!("process://{}/stderr", handle_bg),
                    StderrEvent { line },
                );
            }
            ProcessEvent::Exit {
                code,
                signal,
                success,
            } => {
                let _ = app.emit(
                    &format!("process://{}/exit", handle_bg),
                    ExitEvent {
                        code,
                        signal,
                        success,
                    },
                );
            }
        });

        if let Err(error) = result {
            // Stream/wait failures already emitted their single terminal event
            // from run_process_impl. Only a spawn-stage failure has no event.
            if error.is_spawn() {
                let _ = app.emit(
                    &format!("process://{}/exit", handle_bg),
                    ExitEvent {
                        code: Some(-1),
                        signal: None,
                        success: false,
                    },
                );
            }
        }
    });

    Ok(handle)
}

#[tauri::command]
pub fn cancel_process(handle: String) -> bool {
    cancel_process_impl(&handle, Duration::from_secs(5))
}

#[cfg(all(test, target_os = "windows"))]
mod windows_spawn_tests {
    use super::*;
    use hq_desktop_core::sync_outcome::{
        classify_windows_exit_status, is_windows_console_control_exit,
        termination_fingerprint_token, WindowsTermination, WINDOWS_CONTROL_C_EXIT,
    };

    #[test]
    fn batch_launcher_preserves_metacharacter_arguments() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("echo-args.cmd");
        std::fs::write(&script, "@echo off\r\necho \"%~1\"\r\necho \"%~2\"\r\n")
            .expect("write batch fixture");

        let hq_path = r"C:\HQ & Research".to_string();
        let package = "@indigoai-us/hq-cli@^5.10.0".to_string();
        let output = build_spawn_command(
            script.to_str().expect("UTF-8 batch path"),
            &[hq_path.clone(), package.clone()],
        )
        .output()
        .expect("Rust batch dispatch should start the fixture");

        assert!(
            output.status.success(),
            "batch fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let lines: Vec<_> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| line.trim_matches('"').to_string())
            .collect();
        assert_eq!(lines, vec![hq_path, package]);
    }

    #[test]
    fn production_runner_reports_windows_console_control_exit_status() {
        // An independent literal pins the status Windows reports. Do not derive
        // this expectation from the production constant: that would let an
        // accidental change to the classifier's constant pass unnoticed.
        const EXPECTED_WINDOWS_CONTROL_C_EXIT: i32 = -1073741510;
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("control-c-exit.cmd");
        // CI cannot reliably inject a real console control event into a hidden
        // child. `exit /b` gives cmd.exe the same documented status through the
        // production batch dispatcher, CREATE_NO_WINDOW spawn path, and Job
        // Object setup without skipping the process-status observation seam.
        std::fs::write(
            &script,
            format!("@echo off\r\nexit /b {EXPECTED_WINDOWS_CONTROL_C_EXIT}\r\n"),
        )
        .expect("write batch fixture");

        let spawn = SpawnArgs {
            cmd: script.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: None,
            env: None,
        };
        let mut exits = Vec::new();
        run_process_impl("windows-control-c-exit-test", &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success,
            } = event
            {
                exits.push((code, signal, success));
            }
        })
        .expect("batch fixture should run through production process runner");

        assert_eq!(exits.len(), 1, "the child must emit exactly one exit event");
        let (code, signal, success) = exits[0];
        assert_eq!(
            (code, signal, success),
            (Some(EXPECTED_WINDOWS_CONTROL_C_EXIT), None, false),
            "Windows must report STATUS_CONTROL_C_EXIT as the signed exit code"
        );
        assert_eq!(WINDOWS_CONTROL_C_EXIT, EXPECTED_WINDOWS_CONTROL_C_EXIT);
        assert!(
            is_windows_console_control_exit(code, signal),
            "the production classifier must suppress the status observed through the real runner"
        );
    }

    #[test]
    fn production_runner_reports_indeterminate_windows_status() {
        // This is the exact raw status from HQ-DESKTOP-42, kept independent of
        // the production constant so a future classifier edit cannot make the
        // black-box expectation self-fulfilling. The fixture deliberately
        // produces the value itself, proving the raw status cannot identify an
        // external terminator without separate provenance.
        const EXPECTED_INDETERMINATE_STATUS: i32 = -1;
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("indeterminate-status.cmd");
        std::fs::write(
            &script,
            format!("@echo off\r\nexit /b {EXPECTED_INDETERMINATE_STATUS}\r\n"),
        )
        .expect("write batch fixture");

        let spawn = SpawnArgs {
            cmd: script.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: None,
            env: None,
        };
        let mut exits = Vec::new();
        run_process_impl("windows-indeterminate-status-test", &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success,
            } = event
            {
                exits.push((code, signal, success));
            }
        })
        .expect("batch fixture should run through production process runner");

        assert_eq!(
            exits,
            vec![(Some(EXPECTED_INDETERMINATE_STATUS), None, false)]
        );
        let (code, signal, _) = exits[0];
        assert_eq!(
            classify_windows_exit_status(code.expect("Windows exit code")),
            WindowsTermination::IndeterminateStatus
        );
        assert_eq!(
            termination_fingerprint_token(code, signal),
            "windows:status-ffffffff"
        );
    }
}

#[cfg(test)]
mod registry_exit_order_tests {
    use super::*;

    #[test]
    fn exit_callback_observes_cancelled_registry_entry_until_it_returns() {
        let handle = format!("exit-order-test-{}", Uuid::new_v4());
        pre_register_handle(&handle);
        assert!(mark_cancelled(&handle));

        let mut observed = None;
        emit_exit_then_deregister(
            &handle,
            &mut |event| {
                assert!(matches!(event, ProcessEvent::Exit { .. }));
                observed = Some((is_registered(&handle), is_cancelled(&handle)));
            },
            ProcessEvent::Exit {
                code: Some(-1),
                signal: None,
                success: false,
            },
        );

        assert_eq!(observed, Some((true, true)));
        assert!(!is_registered(&handle));
        assert!(!is_cancelled(&handle));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod process_error_tests {
    use super::*;

    #[test]
    fn typed_spawn_error_keeps_the_legacy_display_text() {
        let source = io::Error::from_raw_os_error(2);
        let expected = format!("spawn '/opt/homebrew/bin/npx': {source}");
        let error = ProcessError::Spawn {
            cmd: "/opt/homebrew/bin/npx".to_string(),
            source,
        };

        assert_eq!(error.to_string(), expected);
        assert!(error.is_spawn());
        assert_eq!(error.error_kind(), Some(io::ErrorKind::NotFound));
        assert_eq!(error.raw_os_error(), Some(2));
    }

    #[test]
    fn typed_stream_and_wait_errors_are_not_spawn_errors() {
        let stream = ProcessError::Stream {
            stream: "stdout",
            source: io::Error::other("read failed"),
        };
        let wait = ProcessError::Wait {
            source: io::Error::other("wait failed"),
        };

        assert!(!stream.is_spawn());
        assert!(!wait.is_spawn());
        assert_eq!(stream.to_string(), "stdout: read failed");
        assert_eq!(wait.to_string(), "wait failed");
    }

    #[cfg(unix)]
    #[test]
    fn real_child_exit_127_reaches_the_terminal_event_path() {
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "exit 127".to_string()],
            cwd: None,
            env: None,
        };
        let mut events = Vec::new();

        run_process_impl("process-exit-127-test", &spawn, |event| events.push(event))
            .expect("real shell child should run");

        assert!(matches!(
            events.as_slice(),
            [ProcessEvent::Exit {
                code: Some(127),
                signal: None,
                success: false,
            }]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn real_missing_command_is_typed_spawn_error_with_path_free_policy_token() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("missing-runner").display().to_string();
        let spawn = SpawnArgs {
            cmd: missing,
            args: Vec::new(),
            cwd: None,
            env: None,
        };

        let error = run_process_impl("process-missing-command-test", &spawn, |_| {})
            .expect_err("missing executable must fail at spawn");

        assert!(error.is_spawn());
        assert_eq!(error.error_kind(), Some(io::ErrorKind::NotFound));
        assert_eq!(error.raw_os_error(), Some(2));
        let token = hq_desktop_core::sync_outcome::spawn_failure_fingerprint_token(
            error.error_kind().expect("typed spawn kind"),
            error.raw_os_error(),
        );
        assert_eq!(
            hq_desktop_core::sync_outcome::spawn_failure_capture_policy(
                error.error_kind().expect("typed spawn kind"),
                error.raw_os_error(),
            ),
            hq_desktop_core::sync_outcome::SpawnFailureCapturePolicy::CaptureRateLimited
        );
        assert_eq!(token, "not-found");
        assert!(!token.contains(tmp.path().to_string_lossy().as_ref()));
    }
}

#[cfg(test)]
mod app_initiated_exit_tests {
    use super::*;

    /// The Windows session-end fix hangs off exactly one bit: was this exit
    /// asked for by the app, or forced by the OS? This is the ONLY test in the
    /// crate that writes `APP_INITIATED_EXIT`, and it asserts the unset state
    /// before it writes — so the latch is proven to start false and to be
    /// observable afterwards regardless of how the harness interleaves tests.
    #[test]
    fn app_initiated_exit_latches_once_the_exit_requested_arm_notes_it() {
        assert!(
            !app_initiated_exit(),
            "a process that never reached ExitRequested must read as OS-forced"
        );

        note_app_initiated_exit();

        assert!(
            app_initiated_exit(),
            "the Exit arm must observe the flag the ExitRequested arm set"
        );

        // One-way: re-noting cannot clear it.
        note_app_initiated_exit();
        assert!(app_initiated_exit());
    }
}

#[cfg(test)]
mod session_end_owned_pids_tests {
    use super::*;

    fn reported(json: &str) -> Vec<(String, u32)> {
        let parsed: serde_json::Value = serde_json::from_str(json).expect("report is valid JSON");
        parsed["pids"]
            .as_array()
            .expect("report carries a pids array")
            .iter()
            .map(|entry| {
                (
                    entry["handle"]
                        .as_str()
                        .expect("every entry names its handle")
                        .to_string(),
                    entry["pid"].as_u64().expect("every entry carries a pid") as u32,
                )
            })
            .collect()
    }

    /// The production gate. An unset (or blank) variable must resolve to no
    /// destination at all, so a shipped build never touches the filesystem on
    /// the session-end teardown path.
    #[test]
    fn the_report_is_written_only_when_the_env_var_names_a_path() {
        assert_eq!(owned_pids_report_path(None), None);
        assert_eq!(
            owned_pids_report_path(Some(std::ffi::OsString::from(""))),
            None
        );
        assert_eq!(
            owned_pids_report_path(Some(std::ffi::OsString::from("/tmp/owned.json"))),
            Some(std::path::PathBuf::from("/tmp/owned.json"))
        );

        // No destination resolved ⇒ nothing is written and nothing throws.
        let tmp = tempfile::tempdir().expect("temp dir");
        let unwritten = tmp.path().join("never-written.json");
        report_owned_pids_to(None, &[("hq-sync".to_string(), 42)]);
        assert!(!unwritten.exists());

        // The composed entry point is what main.rs calls; with the ambient
        // environment it must stay panic-free either way.
        report_session_end_owned_pids();
    }

    /// The report has to name exactly what the registry holds — no more (which
    /// would make the proof assert ownership of something the teardown cannot
    /// kill) and no fewer (which would let a real orphan pass unnoticed).
    #[test]
    fn the_report_contains_exactly_the_registered_pids() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let path = tmp.path().join("owned.json");
        let pids = vec![
            ("hq-sync".to_string(), 4321_u32),
            ("hq-sync-daemon".to_string(), 8765_u32),
        ];

        report_owned_pids_to(Some(path.as_path()), &pids);

        let written = std::fs::read_to_string(&path).expect("report was written");
        assert_eq!(reported(&written), pids);

        // An empty registry is a legitimate outcome, and it must still produce
        // a file: its existence is what proves the teardown ran. It reads as
        // `owned=0`, never as "nothing to check, therefore green".
        let empty_path = tmp.path().join("owned-empty.json");
        report_owned_pids_to(Some(empty_path.as_path()), &[]);
        let empty = std::fs::read_to_string(&empty_path).expect("empty report was written");
        assert_eq!(reported(&empty), Vec::<(String, u32)>::new());
    }

    /// The diagnostic runs inside a Windows window procedure. A write failure
    /// there must not unwind — that is the exact shape of the crash this whole
    /// branch exists to stop.
    #[test]
    fn a_failed_write_is_swallowed_rather_than_propagated() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let unwritable = tmp.path().join("no-such-dir").join("owned.json");

        assert!(
            write_owned_pids_report(unwritable.as_path(), &[("hq-sync".to_string(), 1)]).is_err(),
            "writing into a missing directory must genuinely fail"
        );

        // …and the best-effort wrapper absorbs that failure.
        report_owned_pids_to(Some(unwritable.as_path()), &[("hq-sync".to_string(), 1)]);
        assert!(!unwritable.exists());
    }
}

#[cfg(all(test, unix))]
mod exit_teardown_tests {
    use super::*;
    use std::process::Command as StdCommand;

    /// Probe existence without delivering a signal (signal 0). True while the
    /// pid is live OR a not-yet-reaped zombie; callers must reap first.
    fn alive(pid: u32) -> bool {
        signal::kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    #[test]
    fn terminate_pids_for_exit_kills_detached_process_groups() {
        // Spawn children each leading their OWN process group — the same shape
        // as run_process_impl's `.process_group(0)` sync daemon. Regression
        // guard: closing the app must stop these, not orphan them to PID 1.
        let mut kids: Vec<std::process::Child> = (0..2)
            .map(|_| {
                StdCommand::new("sleep")
                    .arg("30")
                    .process_group(0)
                    .spawn()
                    .expect("spawn sleep")
            })
            .collect();

        let pids: Vec<(String, u32)> = kids
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("exit-test-{i}"), c.id()))
            .collect();

        for (_, pid) in &pids {
            assert!(alive(*pid), "child {pid} should be alive before teardown");
        }

        terminate_pids_for_exit(&pids, Duration::from_millis(200));

        // Reap so the existence probe reflects reality (a killed-but-unwaited
        // child lingers as a zombie), then assert every group is gone.
        for kid in &mut kids {
            let _ = kid.wait();
        }
        for (_, pid) in &pids {
            assert!(!alive(*pid), "child {pid} must be dead after teardown");
        }
    }

    #[test]
    fn terminate_pids_for_exit_is_noop_when_empty() {
        // Must not sleep the grace period or panic when nothing is registered.
        terminate_pids_for_exit(&[], Duration::from_secs(30));
    }
}
