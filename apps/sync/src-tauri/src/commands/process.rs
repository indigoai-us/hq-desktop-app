//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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
use windows::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
};

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
// ─────────────────────────────────────────────────────────────────────────────

/// Opaque identity for one ownership period of a reusable process handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessRegistration(u64);

impl ProcessRegistration {
    pub fn id(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub registration: ProcessRegistration,
    pub pid: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CancellationAttempt {
    pub executed: bool,
    pub current: Option<ProcessIdentity>,
}

struct ProcessEntry {
    registration: ProcessRegistration,
    pid: Option<u32>,
    cancelled: bool,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

impl ProcessEntry {
    fn new(registration: ProcessRegistration) -> Self {
        Self {
            registration,
            pid: None,
            cancelled: false,
            #[cfg(target_os = "windows")]
            job_handle: None,
        }
    }

    fn identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            registration: self.registration,
            pid: self.pid,
        }
    }
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();
static NEXT_PROCESS_REGISTRATION: AtomicU64 = AtomicU64::new(0);

fn process_registry() -> &'static Arc<Mutex<HashMap<String, ProcessEntry>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn next_process_registration() -> ProcessRegistration {
    let prior = NEXT_PROCESS_REGISTRATION
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |id| id.checked_add(1))
        .expect("process registration IDs exhausted");
    ProcessRegistration(prior + 1)
}

pub fn pre_register_handle(handle: &str) -> ProcessRegistration {
    let registration = next_process_registration();
    process_registry()
        .lock()
        .unwrap()
        .insert(handle.to_string(), ProcessEntry::new(registration));
    registration
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
            v.insert(ProcessEntry::new(next_process_registration()));
            true
        }
    }
}

pub fn registration_for_handle(handle: &str) -> Option<ProcessRegistration> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|entry| entry.registration)
}

pub fn process_identity_for(
    handle: &str,
    registration: ProcessRegistration,
) -> Option<ProcessIdentity> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .filter(|entry| entry.registration == registration)
        .map(ProcessEntry::identity)
}

/// Attach a child only if its owner still holds the registration. Returns
/// whether a matching registration had already been cancelled.
pub(crate) fn register_process(
    handle: &str,
    registration: ProcessRegistration,
    pid: u32,
) -> Option<bool> {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg
        .get_mut(handle)
        .filter(|e| e.registration == registration)
    {
        entry.pid = Some(pid);
        Some(entry.cancelled)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn register_job_handle(handle: &str, registration: ProcessRegistration, job: isize) -> bool {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg
        .get_mut(handle)
        .filter(|entry| entry.registration == registration)
    {
        entry.job_handle = Some(job);
        true
    } else {
        false
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

/// Remove only the exact registration that owns this wait path. A stale
/// runner must never erase a newer process that reused the public handle.
pub fn deregister_process_for(handle: &str, registration: ProcessRegistration) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut reg = process_registry().lock().unwrap();
        if reg
            .get(handle)
            .map(|entry| entry.registration != registration)
            .unwrap_or(true)
        {
            return false;
        }
        if let Some(entry) = reg.remove(handle) {
            if let Some(job) = entry.job_handle {
                unsafe {
                    let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
                }
            }
        }
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut reg = process_registry().lock().unwrap();
        let matches = reg
            .get(handle)
            .map(|entry| entry.registration == registration)
            .unwrap_or(false);
        if matches {
            reg.remove(handle);
        }
        matches
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

pub fn is_cancelled_for(handle: &str, registration: ProcessRegistration) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .filter(|entry| entry.registration == registration)
        .map(|entry| entry.cancelled)
        .unwrap_or(false)
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

/// A force-release can invalidate an owner while it is between spawn and
/// registry attachment. Do not let that obsolete owner leave a child behind.
#[cfg(unix)]
fn terminate_unregistered_child(child: &mut std::process::Child) {
    let _ = signal::kill(Pid::from_raw(-(child.id() as i32)), Signal::SIGKILL);
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_unregistered_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
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
fn assign_child_to_job(
    handle: &str,
    registration: ProcessRegistration,
    child: &std::process::Child,
) {
    let proc_handle = HANDLE(child.as_raw_handle());
    unsafe {
        match create_kill_on_close_job() {
            Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                Ok(()) => {
                    if !register_job_handle(handle, registration, job.0 as isize) {
                        // The owner expired between spawning and attaching its
                        // Job Object. Closing this kill-on-close job terminates
                        // that stale child instead of transferring ownership to
                        // a replacement using the same public handle.
                        let _ = CloseHandle(job);
                    }
                }
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
fn assign_child_to_job(
    _handle: &str,
    _registration: ProcessRegistration,
    _child: &std::process::Child,
) {
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

/// Deliver Exit before the matching wait owner releases its registry entry so
/// handlers can inspect cancellation provenance without a replacement race.
fn emit_exit_then_deregister<F>(
    handle: &str,
    registration: ProcessRegistration,
    event: ProcessEvent,
    on_event: &mut F,
) where
    F: FnMut(ProcessEvent),
{
    on_event(event);
    deregister_process_for(handle, registration);
}

pub fn run_process_impl<F>(
    handle: &str,
    registration: ProcessRegistration,
    spawn: &SpawnArgs,
    on_event: F,
) -> Result<(), String>
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
            deregister_process_for(handle, registration);
            return Err(format!("spawn '{}': {}", spawn.cmd, e));
        }
    };

    let pid = child.id();
    match register_process(handle, registration, pid) {
        Some(false) => {}
        Some(true) => {
            terminate_unregistered_child(&mut child);
            deregister_process_for(handle, registration);
            return Err(format!(
                "process registration was cancelled before '{}' could start",
                spawn.cmd
            ));
        }
        None => {
            terminate_unregistered_child(&mut child);
            return Err(format!(
                "process registration expired before '{}' could start",
                spawn.cmd
            ));
        }
    }
    assign_child_to_job(handle, registration, &child);

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    enum ReaderMsg {
        Event(ProcessEvent),
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
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
                    err = Some(e.to_string());
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
        let mut err: Option<String> = None;
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
                    err = Some(e.to_string());
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
    let mut first_stream_err: Option<String> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{}: {}", stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait().map_err(|e| e.to_string());

    if let Some(err) = first_stream_err {
        emit_exit_then_deregister(
            handle,
            registration,
            ProcessEvent::Exit {
                code: None,
                signal: None,
                success: false,
            },
            &mut on_event_mut,
        );
        return Err(err);
    }

    let status = match wait_result {
        Ok(status) => status,
        Err(err) => {
            deregister_process_for(handle, registration);
            return Err(err);
        }
    };
    emit_exit_then_deregister(
        handle,
        registration,
        ProcessEvent::Exit {
            code: status.code(),
            signal: exit_signal(&status),
            success: status.success(),
        },
        &mut on_event_mut,
    );

    Ok(())
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
    registration: ProcessRegistration,
    spawn: &SpawnArgs,
    on_event: F,
    on_spawn: S,
) -> Result<(), String>
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
            deregister_process_for(handle, registration);
            return Err(format!("spawn '{}': {}", spawn.cmd, e));
        }
    };

    let pid = child.id();
    match register_process(handle, registration, pid) {
        Some(false) => {}
        Some(true) => {
            terminate_unregistered_child(&mut child);
            deregister_process_for(handle, registration);
            return Err(format!(
                "process registration was cancelled before '{}' could start",
                spawn.cmd
            ));
        }
        None => {
            terminate_unregistered_child(&mut child);
            return Err(format!(
                "process registration expired before '{}' could start",
                spawn.cmd
            ));
        }
    }
    assign_child_to_job(handle, registration, &child);

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
            err: Option<String>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
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
                    err = Some(e.to_string());
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
        let mut err: Option<String> = None;
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
                    err = Some(e.to_string());
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
    let mut first_stream_err: Option<String> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{}: {}", stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait().map_err(|e| e.to_string());

    if let Some(err) = first_stream_err {
        emit_exit_then_deregister(
            handle,
            registration,
            ProcessEvent::Exit {
                code: None,
                signal: None,
                success: false,
            },
            &mut on_event_mut,
        );
        return Err(err);
    }

    let status = match wait_result {
        Ok(status) => status,
        Err(err) => {
            deregister_process_for(handle, registration);
            return Err(err);
        }
    };
    emit_exit_then_deregister(
        handle,
        registration,
        ProcessEvent::Exit {
            code: status.code(),
            signal: exit_signal(&status),
            success: status.success(),
        },
        &mut on_event_mut,
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Check the exact handle owner immediately before a delayed escalation. A
/// replacement must match both opaque registration and PID, not just handle.
fn should_escalate_cancellation(handle: &str, registration: ProcessRegistration, pid: u32) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|entry| {
            entry.registration == registration && entry.pid == Some(pid) && entry.cancelled
        })
        .unwrap_or(false)
}

fn cancel_process_matching(
    handle: &str,
    expected_registration: Option<ProcessRegistration>,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    let (attempt, pid) = {
        let mut reg = process_registry().lock().unwrap();
        let Some(entry) = reg.get_mut(handle) else {
            return CancellationAttempt {
                executed: false,
                current: None,
            };
        };
        let current = entry.identity();
        if expected_registration.is_some_and(|expected| expected != entry.registration) {
            return CancellationAttempt {
                executed: false,
                current: Some(current),
            };
        }
        entry.cancelled = true;
        (
            CancellationAttempt {
                executed: true,
                current: Some(current),
            },
            entry.pid,
        )
    };

    let registration = attempt
        .current
        .expect("a successful cancellation has an owner")
        .registration;

    #[cfg(target_os = "windows")]
    {
        let job_isize = process_registry()
            .lock()
            .unwrap()
            .get(handle)
            .filter(|entry| entry.registration == registration)
            .and_then(|entry| entry.job_handle);

        if let Some(job) = job_isize {
            unsafe {
                let job_handle = HANDLE(job as *mut std::ffi::c_void);
                let _ = TerminateJobObject(job_handle, 1);
            }
        } else if let Some(pid) = pid {
            // A cancellation can race the post-spawn Job Object attachment.
            // Preserve bounded teardown for that exact registered child rather
            // than letting a just-spawned process outlive its cancelled owner.
            unsafe {
                if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(process, 1);
                    let _ = CloseHandle(process);
                }
            }
        }
        let _ = sigkill_delay;
        return attempt;
    }

    #[cfg(unix)]
    {
        let Some(pid) = pid else {
            return attempt;
        };

        let _ = signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM);
        let handle_owned = handle.to_string();
        thread::spawn(move || {
            thread::sleep(sigkill_delay);
            if should_escalate_cancellation(&handle_owned, registration, pid) {
                let _ = signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
            }
        });
        return attempt;
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = sigkill_delay;
        attempt
    }
}

/// Attempt cancellation only if this exact registration still owns the handle.
/// A stale deferred action becomes an observable no-op.
pub fn cancel_process_for(
    handle: &str,
    registration: ProcessRegistration,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    cancel_process_matching(handle, Some(registration), sigkill_delay)
}

/// Cancel whichever process currently owns the handle. Immediate user and app
/// teardown use this; deferred watchdogs must use [`cancel_process_for`].
pub fn cancel_process_impl(handle: &str, sigkill_delay: Duration) -> bool {
    cancel_process_matching(handle, None, sigkill_delay).executed
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
pub fn terminate_all_for_exit(grace: Duration) {
    terminate_pids_for_exit(&registered_pids(), grace);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let handle = Uuid::new_v4().to_string();

    let registration = pre_register_handle(&handle);

    let handle_bg = handle.clone();
    thread::spawn(move || {
        if is_cancelled_for(&handle_bg, registration) {
            deregister_process_for(&handle_bg, registration);
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

        let result = run_process_impl(&handle_bg, registration, &args, |event| match event {
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

        if let Err(_e) = result {
            let _ = app.emit(
                &format!("process://{}/exit", handle_bg),
                ExitEvent {
                    code: Some(-1),
                    signal: None,
                    success: false,
                },
            );
        }
    });

    Ok(handle)
}

#[tauri::command]
pub fn cancel_process(handle: String) -> bool {
    cancel_process_impl(&handle, Duration::from_secs(5))
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[test]
    fn stale_registration_cannot_cancel_or_escalate_against_a_replacement() {
        let handle = "test-process-stale-registration";
        let old = pre_register_handle(handle);
        assert_eq!(register_process(handle, old, 41), Some(false));

        // This mirrors a bounded start-guard recovery: owner A is released,
        // then replacement B takes the same public handle.
        assert!(deregister_process_for(handle, old));
        let replacement = pre_register_handle(handle);
        assert_eq!(register_process(handle, replacement, 42), Some(false));

        let attempt = cancel_process_for(handle, old, Duration::ZERO);
        assert!(!attempt.executed, "the old owner must be a no-op");
        assert_eq!(
            attempt.current,
            Some(ProcessIdentity {
                registration: replacement,
                pid: Some(42),
            })
        );
        assert!(
            !is_cancelled_for(handle, replacement),
            "the replacement must not inherit cancellation state"
        );
        assert!(
            !should_escalate_cancellation(handle, old, 41),
            "a stale five-second escalation must not target the replacement"
        );
        assert!(deregister_process_for(handle, replacement));
    }

    #[test]
    fn matching_exit_observes_cancellation_before_single_owner_deregisters() {
        let handle = "test-process-exit-cancellation-provenance";
        let registration = pre_register_handle(handle);
        assert!(cancel_process_for(handle, registration, Duration::ZERO).executed);

        let mut observed_cancelled = false;
        emit_exit_then_deregister(
            handle,
            registration,
            ProcessEvent::Exit {
                code: None,
                signal: Some(15),
                success: false,
            },
            &mut |_| observed_cancelled = is_cancelled_for(handle, registration),
        );

        assert!(
            observed_cancelled,
            "Exit must see matching cancellation provenance before deregistration"
        );
        assert!(
            !is_registered(handle),
            "the wait owner deregisters immediately after Exit delivery"
        );
    }

    #[test]
    fn stale_wait_owner_cannot_deregister_a_replacement() {
        let handle = "test-process-stale-owner-deregister";
        let old = pre_register_handle(handle);
        assert!(deregister_process_for(handle, old));
        let replacement = pre_register_handle(handle);

        assert!(
            !deregister_process_for(handle, old),
            "an old wait thread must not remove a replacement"
        );
        assert_eq!(registration_for_handle(handle), Some(replacement));
        assert!(deregister_process_for(handle, replacement));
    }

    #[test]
    fn stale_owner_cannot_attach_a_pid_to_a_replacement() {
        let handle = "test-process-stale-owner-attach";
        let old = pre_register_handle(handle);
        assert!(deregister_process_for(handle, old));
        let replacement = pre_register_handle(handle);

        assert_eq!(
            register_process(handle, old, 41),
            None,
            "an owner released before attachment must not claim B's handle"
        );
        assert_eq!(register_process(handle, replacement, 42), Some(false));
        assert_eq!(
            process_identity_for(handle, replacement),
            Some(ProcessIdentity {
                registration: replacement,
                pid: Some(42),
            })
        );
        assert!(deregister_process_for(handle, replacement));
    }

    #[test]
    fn delayed_escalation_requires_the_original_pid_and_registration() {
        let handle = "test-process-delayed-escalation-identity";
        let registration = pre_register_handle(handle);
        assert_eq!(register_process(handle, registration, 41), Some(false));
        {
            let mut registry = process_registry().lock().unwrap();
            registry.get_mut(handle).expect("matching entry").cancelled = true;
        }
        assert!(should_escalate_cancellation(handle, registration, 41));

        // A reused PID field (or a replacement attached under the same
        // registration during a broken cleanup) cannot authorize escalation
        // against the old process group.
        assert_eq!(register_process(handle, registration, 42), Some(true));
        assert!(!should_escalate_cancellation(handle, registration, 41));
        assert!(should_escalate_cancellation(handle, registration, 42));
        assert!(deregister_process_for(handle, registration));
    }

    #[test]
    fn cancellation_before_attach_prevents_the_child_from_becoming_owned() {
        let handle = "test-process-cancel-before-attach";
        let registration = pre_register_handle(handle);
        {
            let mut registry = process_registry().lock().unwrap();
            registry.get_mut(handle).expect("matching entry").cancelled = true;
        }

        assert_eq!(register_process(handle, registration, 41), Some(true));
        assert_eq!(
            process_identity_for(handle, registration),
            Some(ProcessIdentity {
                registration,
                pid: Some(41),
            })
        );
        assert!(deregister_process_for(handle, registration));
    }
}

#[cfg(all(test, unix))]
mod runner_identity_tests {
    use super::*;
    use std::io::Write;

    fn shell_args(script: &str) -> SpawnArgs {
        SpawnArgs {
            cmd: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            cwd: None,
            env: None,
        }
    }

    #[test]
    fn stdout_stderr_runner_keeps_exit_cleanup_scoped_to_its_owner() {
        let handle = "test-process-stdout-stderr-owner";
        let registration = pre_register_handle(handle);
        let mut events = Vec::new();

        run_process_impl(
            handle,
            registration,
            &shell_args("printf stdout-line; printf stderr-line >&2"),
            |event| events.push(event),
        )
        .expect("fixture runner should exit normally");

        assert!(events
            .iter()
            .any(|event| matches!(event, ProcessEvent::Stdout(line) if line == "stdout-line")));
        assert!(events
            .iter()
            .any(|event| matches!(event, ProcessEvent::Stderr(line) if line == "stderr-line")));
        assert!(events
            .iter()
            .any(|event| matches!(event, ProcessEvent::Exit { success: true, .. })));
        assert!(!is_registered(handle));
    }

    #[test]
    fn stdin_runner_keeps_exit_cleanup_scoped_to_its_owner() {
        let handle = "test-process-stdin-owner";
        let registration = pre_register_handle(handle);
        let mut events = Vec::new();

        run_process_with_stdin_impl(
            handle,
            registration,
            &shell_args("read value; printf output-$value; printf error-$value >&2"),
            |event| events.push(event),
            |child| {
                let mut stdin = child.stdin.take().expect("stdin pipe");
                writeln!(stdin, "owned-input").expect("write stdin fixture");
            },
        )
        .expect("fixture stdin runner should exit normally");

        assert!(events.iter().any(
            |event| matches!(event, ProcessEvent::Stdout(line) if line == "output-owned-input")
        ));
        assert!(events.iter().any(
            |event| matches!(event, ProcessEvent::Stderr(line) if line == "error-owned-input")
        ));
        assert!(events
            .iter()
            .any(|event| matches!(event, ProcessEvent::Exit { success: true, .. })));
        assert!(!is_registered(handle));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_spawn_tests {
    use super::*;

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

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
