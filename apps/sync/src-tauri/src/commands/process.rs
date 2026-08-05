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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

pub use hq_desktop_core::process_types::{
    ExitEvent, ProcessEvent, SpawnArgs, StderrEvent, StdoutEvent,
};
use hq_desktop_core::sync_outcome::SyncCancelCause;
#[cfg(unix)]
use nix::{
    sys::signal::{self, Signal},
    unistd::Pid,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use crate::util::logfile::log;

#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

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

struct ProcessEntry {
    /// A public handle can be reused after a cancelled run. Deferred cleanup
    /// must therefore carry this ownership token rather than only the handle.
    generation: u64,
    pid: Option<u32>,
    cancelled: bool,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

impl ProcessEntry {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            pid: None,
            cancelled: false,
            #[cfg(target_os = "windows")]
            job_handle: None,
        }
    }
}

/// Causality evidence retained through deregistration until the exact child
/// delivers its terminal callback. A requested cancellation is deliberately
/// separate from `termination_effected`: only an observed OS termination may
/// suppress the runner's non-zero exit capture.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CancellationRecord {
    pub cause: Option<SyncCancelCause>,
    pub termination_effected: bool,
}

/// Result returned to a generation-aware caller. `executed` means the exact
/// generation was still current and marked cancelled; it does not claim that a
/// process actually died.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CancellationAttempt {
    pub executed: bool,
    pub termination_effected: bool,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();
static CANCELLATION_RECORDS: OnceLock<Arc<Mutex<HashMap<(String, u64), CancellationRecord>>>> =
    OnceLock::new();
static NEXT_PROCESS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Raised at the single application-exit choke point before child teardown.
/// The daemon reads this as exit evidence; it does not alter cancellation or
/// crash classification.
static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn app_exit_requested() -> bool {
    APP_EXIT_REQUESTED.load(Ordering::Acquire)
}

fn process_registry() -> &'static Arc<Mutex<HashMap<String, ProcessEntry>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn cancellation_records() -> &'static Arc<Mutex<HashMap<(String, u64), CancellationRecord>>> {
    CANCELLATION_RECORDS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn next_process_generation() -> u64 {
    let generation = NEXT_PROCESS_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    assert_ne!(generation, 0, "process registration generations exhausted");
    generation
}

/// Register a handle before spawning and return the token required by any
/// future cancellation or cleanup. This retains the legacy helper's overwrite
/// behavior for callers that intentionally pre-register a private UUID.
pub fn pre_register_handle_gen(handle: &str) -> u64 {
    let generation = next_process_generation();
    process_registry()
        .lock()
        .unwrap()
        .insert(handle.to_string(), ProcessEntry::new(generation));
    generation
}

pub fn pre_register_handle(handle: &str) {
    let _ = pre_register_handle_gen(handle);
}

/// Atomically acquire a handle and return its immutable ownership generation.
pub fn try_register_handle_gen(handle: &str) -> Option<u64> {
    use std::collections::hash_map::Entry;
    let mut reg = process_registry().lock().unwrap();
    match reg.entry(handle.to_string()) {
        Entry::Occupied(_) => None,
        Entry::Vacant(v) => {
            let generation = next_process_generation();
            v.insert(ProcessEntry::new(generation));
            Some(generation)
        }
    }
}

/// Atomically check-and-register a handle. Returns `true` if the handle was
/// newly registered, `false` if it was already present (i.e. a process is
/// already running under this handle).
pub fn try_register_handle(handle: &str) -> bool {
    try_register_handle_gen(handle).is_some()
}

/// Snapshot the active generation. Callers must pass it back to a checked
/// operation; it is not itself an ownership guarantee after this function
/// returns.
pub fn generation_for_handle(handle: &str) -> Option<u64> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|entry| entry.generation)
}

/// Attach a child pid to the active generation and return that generation for
/// the terminal callback. Spawn paths that did not pre-register still receive a
/// fresh generation without changing their public API.
pub fn register_process_gen(handle: &str, pid: u32) -> u64 {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.pid = Some(pid);
        entry.generation
    } else {
        let generation = next_process_generation();
        let mut entry = ProcessEntry::new(generation);
        entry.pid = Some(pid);
        reg.insert(handle.to_string(), entry);
        generation
    }
}

pub fn register_process(handle: &str, pid: u32) {
    let _ = register_process_gen(handle, pid);
}

#[cfg(target_os = "windows")]
fn register_job_handle(handle: &str, generation: u64, job: isize) -> bool {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg
        .get_mut(handle)
        .filter(|entry| entry.generation == generation)
    {
        entry.job_handle = Some(job);
        true
    } else {
        false
    }
}

#[cfg(target_os = "windows")]
fn close_process_entry(entry: ProcessEntry) {
    if let Some(job) = entry.job_handle {
        unsafe {
            let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn close_process_entry(_entry: ProcessEntry) {}

pub fn deregister_process(handle: &str) {
    let removed = process_registry().lock().unwrap().remove(handle);
    if let Some(entry) = removed {
        // The legacy force-clear API has no exact terminal callback owner.
        // Generation-aware teardown uses `deregister_generation` instead and
        // deliberately retains its record until that callback returns.
        clear_cancellation_record(handle, entry.generation);
        close_process_entry(entry);
    }
}

/// Remove only the exact generation. Its cancellation record intentionally
/// remains available for a late terminal callback and is cleared by that
/// callback after consumers have observed it.
pub fn deregister_generation(handle: &str, generation: u64) -> bool {
    let removed = {
        let mut reg = process_registry().lock().unwrap();
        if reg
            .get(handle)
            .is_some_and(|entry| entry.generation == generation)
        {
            reg.remove(handle)
        } else {
            None
        }
    };
    if let Some(entry) = removed {
        close_process_entry(entry);
        true
    } else {
        false
    }
}

pub fn lookup_pid(handle: &str) -> Option<u32> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|e| e.pid)
}

/// End a generation that will never receive a terminal child callback (for
/// example, a manual-sync preflight error). Unlike app-exit teardown,
/// preflight has no child whose callback could need this evidence, so clear the
/// exact cancellation record at the same time to keep the side map bounded.
pub fn abandon_process_generation(handle: &str, generation: u64) -> bool {
    let removed = deregister_generation(handle, generation);
    clear_cancellation_record(handle, generation);
    removed
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

/// Whether this precise ownership generation has been deliberately cancelled,
/// including after app-exit teardown removed its active registry entry.
pub fn is_cancelled_for_generation(handle: &str, generation: u64) -> bool {
    let registry_cancelled = {
        process_registry()
            .lock()
            .unwrap()
            .get(handle)
            .is_some_and(|entry| entry.generation == generation && entry.cancelled)
    };
    registry_cancelled
        || cancellation_records()
            .lock()
            .unwrap()
            .contains_key(&(handle.to_string(), generation))
}

/// Read the causal cancellation record for the exact terminal callback. The
/// map is never queried by bare handle, preventing an old callback from
/// classifying a successor's cancellation.
pub fn cancellation_record_for_generation(
    handle: &str,
    generation: u64,
) -> Option<CancellationRecord> {
    cancellation_records()
        .lock()
        .unwrap()
        .get(&(handle.to_string(), generation))
        .copied()
}

fn clear_cancellation_record(handle: &str, generation: u64) {
    cancellation_records()
        .lock()
        .unwrap()
        .remove(&(handle.to_string(), generation));
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobAssignment {
    Attached,
    CreateFailed,
    AssignFailed,
}

#[cfg(target_os = "windows")]
fn assign_child_to_job(
    handle: &str,
    generation: u64,
    child: &std::process::Child,
) -> JobAssignment {
    let proc_handle = HANDLE(child.as_raw_handle());
    unsafe {
        match create_kill_on_close_job() {
            Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                Ok(()) if register_job_handle(handle, generation, job.0 as isize) => {
                    JobAssignment::Attached
                }
                Ok(()) => {
                    let _ = CloseHandle(job);
                    log(
                        "process",
                        &format!(
                            "job attachment lost ownership for {handle} generation {generation}"
                        ),
                    );
                    JobAssignment::AssignFailed
                }
                Err(e) => {
                    let _ = CloseHandle(job);
                    log(
                        "process",
                        &format!(
                            "AssignProcessToJobObject failed for {handle} generation {generation}: {e}"
                        ),
                    );
                    JobAssignment::AssignFailed
                }
            },
            Err(e) => {
                log(
                    "process",
                    &format!(
                        "create_kill_on_close_job failed for {handle} generation {generation}: {e}"
                    ),
                );
                JobAssignment::CreateFailed
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn assign_child_to_job(
    _handle: &str,
    _generation: u64,
    _child: &std::process::Child,
) -> JobAssignment {
    JobAssignment::Attached
}

/// Snapshot of an exact generation's OS termination handles. It is copied
/// while holding the registry mutex and used only after that mutex is released;
/// record publication and the OS call deliberately happen under the separate
/// cancellation-record mutex so an Exit callback cannot see a half-published
/// result.
#[derive(Clone, Copy, Default)]
struct ProcessTerminationTarget {
    pid: Option<u32>,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

fn target_for_generation(handle: &str, generation: u64) -> Option<ProcessTerminationTarget> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .filter(|entry| entry.generation == generation)
        .map(|entry| ProcessTerminationTarget {
            pid: entry.pid,
            #[cfg(target_os = "windows")]
            job_handle: entry.job_handle,
        })
}

fn cancellation_requested_for_generation(handle: &str, generation: u64) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .is_some_and(|entry| entry.generation == generation && entry.cancelled)
}

// The injection seam feeds the same production helpers below. It never exists
// in a shipped binary and lets Windows CI prove that a failed Job/Object pid
// termination cannot become a false suppression signal.
#[cfg(all(test, target_os = "windows"))]
#[derive(Clone, Copy)]
enum TestWindowsTerminationResult {
    Job(bool),
    OpenProcess(bool),
    TerminateProcess(bool),
}

#[cfg(all(test, target_os = "windows"))]
thread_local! {
    static TEST_WINDOWS_TERMINATION_RESULTS: std::cell::RefCell<std::collections::VecDeque<TestWindowsTerminationResult>> =
        std::cell::RefCell::new(std::collections::VecDeque::new());
}

#[cfg(all(test, target_os = "windows"))]
fn set_test_windows_termination_results(results: Vec<TestWindowsTerminationResult>) {
    TEST_WINDOWS_TERMINATION_RESULTS.with(|outcomes| {
        *outcomes.borrow_mut() = results.into();
    });
}

#[cfg(all(test, target_os = "windows"))]
fn take_test_windows_job_result() -> Option<bool> {
    TEST_WINDOWS_TERMINATION_RESULTS.with(|outcomes| {
        let mut outcomes = outcomes.borrow_mut();
        match outcomes.front().copied() {
            Some(TestWindowsTerminationResult::Job(result)) => {
                outcomes.pop_front();
                Some(result)
            }
            _ => None,
        }
    })
}

#[cfg(all(test, target_os = "windows"))]
fn take_test_windows_open_process_result() -> Option<bool> {
    TEST_WINDOWS_TERMINATION_RESULTS.with(|outcomes| {
        let mut outcomes = outcomes.borrow_mut();
        match outcomes.front().copied() {
            Some(TestWindowsTerminationResult::OpenProcess(result)) => {
                outcomes.pop_front();
                Some(result)
            }
            _ => None,
        }
    })
}

#[cfg(all(test, target_os = "windows"))]
fn take_test_windows_terminate_process_result() -> Option<bool> {
    TEST_WINDOWS_TERMINATION_RESULTS.with(|outcomes| {
        let mut outcomes = outcomes.borrow_mut();
        match outcomes.front().copied() {
            Some(TestWindowsTerminationResult::TerminateProcess(result)) => {
                outcomes.pop_front();
                Some(result)
            }
            _ => None,
        }
    })
}

#[cfg(target_os = "windows")]
fn windows_descendants(root_pid: u32) -> Vec<u32> {
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(snapshot) => snapshot,
        Err(error) => {
            log(
                "process",
                &format!("CreateToolhelp32Snapshot failed for pid {root_pid}: {error}"),
            );
            return Vec::new();
        }
    };

    let mut rows = Vec::new();
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next.is_ok() {
        rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
        entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }

    let mut descendants = Vec::new();
    let mut frontier = vec![root_pid];
    while let Some(parent) = frontier.pop() {
        for (pid, parent_pid) in &rows {
            if *parent_pid == parent && *pid != root_pid && !descendants.contains(pid) {
                descendants.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    descendants
}

/// Fall back to the registered root pid when a Job Object was not available.
/// Descendant failures are logged for diagnosis but only the root termination
/// determines `termination_effected`, because it is the runner's terminal
/// status that is later classified.
#[cfg(target_os = "windows")]
fn terminate_windows_pid_tree(root_pid: u32) -> bool {
    #[cfg(test)]
    if let Some(opened) = take_test_windows_open_process_result() {
        if !opened {
            log(
                "process",
                &format!("injected OpenProcess failure for pid {root_pid}"),
            );
            return false;
        }
        if let Some(terminated) = take_test_windows_terminate_process_result() {
            if !terminated {
                log(
                    "process",
                    &format!("injected TerminateProcess failure for pid {root_pid}"),
                );
            }
            return terminated;
        }
    }

    let mut pids = windows_descendants(root_pid);
    pids.reverse();
    pids.push(root_pid);
    let mut root_terminated = false;

    for pid in pids {
        let process = match unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) } {
            Ok(process) => process,
            Err(error) => {
                log(
                    "process",
                    &format!("OpenProcess(PROCESS_TERMINATE) failed for pid {pid}: {error}"),
                );
                continue;
            }
        };
        let result = unsafe { TerminateProcess(process, 1) };
        unsafe {
            let _ = CloseHandle(process);
        }
        match result {
            Ok(()) if pid == root_pid => root_terminated = true,
            Ok(()) => {}
            Err(error) => log(
                "process",
                &format!("TerminateProcess failed for pid {pid}: {error}"),
            ),
        }
    }
    root_terminated
}

#[cfg(target_os = "windows")]
fn terminate_target(target: ProcessTerminationTarget) -> bool {
    if let Some(job) = target.job_handle {
        #[cfg(test)]
        if let Some(terminated) = take_test_windows_job_result() {
            if !terminated {
                log("process", "injected TerminateJobObject failure");
            }
            return terminated;
        }
        let result = unsafe { TerminateJobObject(HANDLE(job as *mut std::ffi::c_void), 1) };
        return match result {
            Ok(()) => true,
            Err(error) => {
                log("process", &format!("TerminateJobObject failed: {error}"));
                false
            }
        };
    }
    target.pid.map(terminate_windows_pid_tree).unwrap_or(false)
}

#[cfg(unix)]
fn terminate_target(target: ProcessTerminationTarget) -> bool {
    target
        .pid
        .map(|pid| signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM).is_ok())
        .unwrap_or(false)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn terminate_target(_target: ProcessTerminationTarget) -> bool {
    false
}

/// Complete a cancellation that was recorded before the child had a pid or a
/// Job Object. The registry is sampled first and released before the record
/// lock is acquired; the record lock then spans the OS call and publication so
/// the terminal callback cannot observe a requested-but-not-yet-published kill.
fn complete_pre_spawn_cancellation(handle: &str, generation: u64) {
    if !cancellation_requested_for_generation(handle, generation) {
        return;
    }
    let Some(target) = target_for_generation(handle, generation) else {
        return;
    };
    let key = (handle.to_string(), generation);
    let mut records = cancellation_records().lock().unwrap();
    if let Some(record) = records.get_mut(&key) {
        record.termination_effected |= terminate_target(target);
    } else {
        // Legacy handle-scoped callers can cancel a pre-registered process too;
        // preserve their termination behavior without inventing a sync cause.
        let _ = terminate_target(target);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

pub fn run_process_impl<F>(handle: &str, spawn: &SpawnArgs, on_event: F) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
{
    let pre_registered_generation = generation_for_handle(handle);
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
            if let Some(generation) = pre_registered_generation {
                let _ = deregister_generation(handle, generation);
                clear_cancellation_record(handle, generation);
            } else {
                deregister_process(handle);
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let pid = child.id();
    let generation = register_process_gen(handle, pid);
    let _job_assignment = assign_child_to_job(handle, generation, &child);
    complete_pre_spawn_cancellation(handle, generation);

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
            generation,
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
                generation,
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
        generation,
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
fn emit_exit_then_deregister<F>(
    handle: &str,
    generation: u64,
    on_event: &mut F,
    event: ProcessEvent,
) where
    F: FnMut(ProcessEvent),
{
    on_event(event);
    let _ = deregister_generation(handle, generation);
    clear_cancellation_record(handle, generation);
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
    let pre_registered_generation = generation_for_handle(handle);
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
            if let Some(generation) = pre_registered_generation {
                let _ = deregister_generation(handle, generation);
                clear_cancellation_record(handle, generation);
            } else {
                deregister_process(handle);
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let pid = child.id();
    let generation = register_process_gen(handle, pid);
    let _job_assignment = assign_child_to_job(handle, generation, &child);
    complete_pre_spawn_cancellation(handle, generation);

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
            generation,
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
                generation,
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
        generation,
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

fn mark_cancelled_generation(handle: &str, generation: u64) -> Option<ProcessTerminationTarget> {
    let mut registry = process_registry().lock().unwrap();
    let entry = registry
        .get_mut(handle)
        .filter(|entry| entry.generation == generation)?;
    entry.cancelled = true;
    Some(ProcessTerminationTarget {
        pid: entry.pid,
        #[cfg(target_os = "windows")]
        job_handle: entry.job_handle,
    })
}

#[cfg(unix)]
fn schedule_sigkill_escalation(handle: String, generation: u64, sigkill_delay: Duration) {
    thread::spawn(move || {
        thread::sleep(sigkill_delay);
        if !cancellation_requested_for_generation(&handle, generation) {
            return;
        }
        let Some(target) = target_for_generation(&handle, generation) else {
            return;
        };
        let Some(pid) = target.pid else {
            return;
        };
        let key = (handle.clone(), generation);
        let mut records = cancellation_records().lock().unwrap();
        let effect = signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL).is_ok();
        if let Some(record) = records.get_mut(&key) {
            record.termination_effected |= effect;
        }
    });
}

fn cancel_registered_generation(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    let Some(target) = mark_cancelled_generation(handle, generation) else {
        return CancellationAttempt::default();
    };

    // The registry mutex is released before taking this lock. Keep this lock
    // across the termination syscall and the observed-result write so a wait
    // callback cannot classify an exit against a partially published record.
    let key = (handle.to_string(), generation);
    let mut records = cancellation_records().lock().unwrap();
    let record = records.entry(key).or_default();
    if let Some(cause) = cause {
        // Preserve the first explicit initiator: an app-exit teardown racing a
        // user Stop must not rewrite the cause that actually began the stop.
        record.cause.get_or_insert(cause);
    }
    let observed = terminate_target(target);
    record.termination_effected |= observed;
    let termination_effected = record.termination_effected;
    drop(records);

    #[cfg(unix)]
    if target.pid.is_some() {
        schedule_sigkill_escalation(handle.to_string(), generation, sigkill_delay);
    }
    #[cfg(not(unix))]
    let _ = sigkill_delay;

    CancellationAttempt {
        executed: true,
        termination_effected,
    }
}

/// Cancel exactly the generation owned by a sync initiator. A stale watchdog is
/// an observable no-op, while a pre-attach cancellation is retained for the
/// process-layer checkpoint to complete after the child receives its pid/job.
pub fn cancel_process_for_generation(
    handle: &str,
    generation: u64,
    cause: SyncCancelCause,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    cancel_registered_generation(handle, generation, Some(cause), sigkill_delay)
}

/// Legacy handle-scoped cancellation for daemon, recall-sdk, and the Tauri
/// generic process command. It preserves their boolean API and does not invent
/// a manual-sync cause.
pub fn cancel_process_impl(handle: &str, sigkill_delay: Duration) -> bool {
    let Some(generation) = generation_for_handle(handle) else {
        return false;
    };
    cancel_registered_generation(handle, generation, None, sigkill_delay).executed
}

// ─────────────────────────────────────────────────────────────────────────────
// App-exit teardown
// ─────────────────────────────────────────────────────────────────────────────

/// Snapshot every currently-registered child as `(handle, pid, generation)`.
///
/// On Unix, each child is spawned with `.process_group(0)` and leads its own
/// process group. On Windows, the pid is paired with a Job Object handle in the
/// registry so cancellation can terminate the tree.
pub fn registered_pids() -> Vec<(String, u32, u64)> {
    process_registry()
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(h, e)| e.pid.map(|p| (h.clone(), p, e.generation)))
        .collect()
}

/// Snapshot registrations that have acquired the public handle but not yet a
/// child pid. App exit must stamp these too: otherwise a close racing the
/// spawn/attach window can leave a newly-spawned runner with no AppQuit record
/// for the process-layer checkpoint to complete.
fn registered_unattached_generations() -> Vec<(String, u64)> {
    process_registry()
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(handle, entry)| {
            entry
                .pid
                .is_none()
                .then(|| (handle.clone(), entry.generation))
        })
        .collect()
}

fn cancel_unattached_generations_for_exit(grace: Duration) {
    for (handle, generation) in registered_unattached_generations() {
        let _ = cancel_process_for_generation(&handle, generation, SyncCancelCause::AppQuit, grace);
    }
}

#[cfg(unix)]
pub fn terminate_pids_for_exit(pids: &[(String, u32, u64)], grace: Duration) {
    for (handle, _pid, generation) in pids {
        let _ = cancel_process_for_generation(handle, *generation, SyncCancelCause::AppQuit, grace);
    }
    if !pids.is_empty() {
        thread::sleep(grace);
    }
    for (handle, pid, generation) in pids {
        let key = (handle.clone(), *generation);
        let mut records = cancellation_records().lock().unwrap();
        let effect = signal::kill(Pid::from_raw(-(*pid as i32)), Signal::SIGKILL).is_ok();
        if let Some(record) = records.get_mut(&key) {
            record.termination_effected |= effect;
        }
        drop(records);
        let _ = deregister_generation(handle, *generation);
    }
}

#[cfg(target_os = "windows")]
pub fn terminate_pids_for_exit(pids: &[(String, u32, u64)], _grace: Duration) {
    for (handle, _pid, generation) in pids {
        let _ = cancel_process_for_generation(
            handle,
            *generation,
            SyncCancelCause::AppQuit,
            Duration::ZERO,
        );
        let _ = deregister_generation(handle, *generation);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn terminate_pids_for_exit(pids: &[(String, u32, u64)], _grace: Duration) {
    for (handle, _pid, generation) in pids {
        let _ = deregister_generation(handle, *generation);
    }
}

/// Tear down every spawned child on app exit. Call from the app's
/// `RunEvent::ExitRequested` handler so closing HQ Sync (tray Quit, `quit_app`,
/// or Cmd-Q) reliably stops the `--watch` sync daemon and any sidecar instead
/// of orphaning them.
pub fn terminate_all_for_exit(grace: Duration) {
    APP_EXIT_REQUESTED.store(true, Ordering::Release);
    // Keep an unattached generation registered after stamping it. If its
    // spawn has already crossed the OS boundary, `run_process_impl` sees this
    // exact pre-spawn cancellation after pid/job attachment and terminates the
    // child rather than letting an app that is quitting launch a live runner.
    cancel_unattached_generations_for_exit(grace);
    terminate_pids_for_exit(&registered_pids(), grace);
}

/// CI-only built-artifact probe for the exact Windows mechanism reported by
/// HQ-DESKTOP-48. It starts a real fixture child through the production
/// registry, cancels it through the generation-aware path, observes the actual
/// exit callback, and emits only a fixed-shape JSON result from `main.rs`.
#[cfg(feature = "sync-cancel-probe")]
pub fn run_sync_cancel_probe() -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("sync-cancel-probe is Windows-only".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use hq_desktop_core::sync_outcome::{
            classify_runner_exit_disposition_with_cancellation, RunnerExitDisposition,
        };

        let handle = format!("sync-cancel-probe-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle)
            .ok_or_else(|| "probe handle unexpectedly registered".to_string())?;
        let spawn = SpawnArgs {
            cmd: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/c".to_string(),
                "ping 127.0.0.1 -n 30 > nul".to_string(),
            ],
            cwd: None,
            env: None,
        };
        let cancel_handle = handle.clone();
        thread::spawn(move || {
            // The fixture runs for roughly thirty seconds, so this bounded
            // delay lets production registration and Job attachment finish.
            thread::sleep(Duration::from_millis(250));
            let _ = cancel_process_for_generation(
                &cancel_handle,
                generation,
                SyncCancelCause::TimeoutWatchdog,
                Duration::ZERO,
            );
        });

        let mut terminal = None;
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success: _,
            } = event
            {
                terminal = Some((
                    code,
                    signal,
                    cancellation_record_for_generation(&handle, generation),
                ));
            }
        })
        .map_err(|error| format!("probe runner failed: {error}"))?;

        let (exit_code, signal, record) =
            terminal.ok_or_else(|| "probe saw no exit".to_string())?;
        let record = record.ok_or_else(|| "probe saw no cancellation record".to_string())?;
        let disposition = classify_runner_exit_disposition_with_cancellation(
            exit_code,
            signal,
            record.cause,
            record.termination_effected,
            false,
            false,
            false,
        );
        let decision = if matches!(
            disposition,
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog)
        ) {
            "suppress"
        } else {
            "capture"
        };
        Ok(serde_json::json!({
            "exit_code": exit_code,
            "cause": record.cause.map(SyncCancelCause::as_str),
            "terminated": record.termination_effected,
            "decision": decision,
        }))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let handle = Uuid::new_v4().to_string();

    let generation = pre_register_handle_gen(&handle);

    let handle_bg = handle.clone();
    thread::spawn(move || {
        if is_cancelled_for_generation(&handle_bg, generation) {
            let _ = abandon_process_generation(&handle_bg, generation);
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

    #[test]
    fn injected_windows_termination_failures_never_claim_effective_cancellation() {
        set_test_windows_termination_results(vec![TestWindowsTerminationResult::Job(false)]);
        assert!(!terminate_target(ProcessTerminationTarget {
            pid: None,
            job_handle: Some(1),
        }));

        for outcomes in [
            vec![TestWindowsTerminationResult::OpenProcess(false)],
            vec![
                TestWindowsTerminationResult::OpenProcess(true),
                TestWindowsTerminationResult::TerminateProcess(false),
            ],
        ] {
            let handle = format!("windows-injected-cancel-{}", Uuid::new_v4());
            let generation = try_register_handle_gen(&handle).expect("register test generation");
            let _ = register_process_gen(&handle, 424_242);
            set_test_windows_termination_results(outcomes);
            let attempt = cancel_process_for_generation(
                &handle,
                generation,
                SyncCancelCause::TimeoutWatchdog,
                Duration::ZERO,
            );
            assert!(attempt.executed);
            assert!(!attempt.termination_effected);
            assert_eq!(
                cancellation_record_for_generation(&handle, generation),
                Some(CancellationRecord {
                    cause: Some(SyncCancelCause::TimeoutWatchdog),
                    termination_effected: false,
                })
            );
            let _ = deregister_generation(&handle, generation);
            clear_cancellation_record(&handle, generation);
        }

        // No Job Object means the production cancellation path uses the root
        // pid-tree fallback. The injected root success is observed as an
        // effective stop without touching a real test pid.
        let handle = format!("windows-pid-fallback-success-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        let _ = register_process_gen(&handle, 424_243);
        set_test_windows_termination_results(vec![
            TestWindowsTerminationResult::OpenProcess(true),
            TestWindowsTerminationResult::TerminateProcess(true),
        ]);
        let attempt = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::TimeoutWatchdog,
            Duration::ZERO,
        );
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: true,
            }
        );
        let _ = deregister_generation(&handle, generation);
        clear_cancellation_record(&handle, generation);
    }

    #[test]
    fn real_windows_job_cancellation_observes_code_one_and_exact_record() {
        let handle = format!("windows-real-cancel-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        let spawn = SpawnArgs {
            cmd: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/c".to_string(),
                "ping 127.0.0.1 -n 30 > nul".to_string(),
            ],
            cwd: None,
            env: None,
        };
        let cancellation_handle = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            let _ = cancel_process_for_generation(
                &cancellation_handle,
                generation,
                SyncCancelCause::TimeoutWatchdog,
                Duration::ZERO,
            );
        });

        let mut terminal = None;
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success,
            } = event
            {
                terminal = Some((
                    code,
                    signal,
                    success,
                    cancellation_record_for_generation(&handle, generation),
                ));
            }
        })
        .expect("real Windows fixture should terminate through the process runner");

        assert_eq!(
            terminal,
            Some((
                Some(1),
                None,
                false,
                Some(CancellationRecord {
                    cause: Some(SyncCancelCause::TimeoutWatchdog),
                    termination_effected: true,
                }),
            ))
        );
    }
}

#[cfg(test)]
mod registry_exit_order_tests {
    use super::*;

    #[test]
    fn exit_callback_observes_cancelled_registry_entry_until_it_returns() {
        let handle = format!("exit-order-test-{}", Uuid::new_v4());
        let generation = pre_register_handle_gen(&handle);
        assert!(mark_cancelled(&handle));

        let mut observed = None;
        emit_exit_then_deregister(
            &handle,
            generation,
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

    #[test]
    fn stale_generation_cancellation_cannot_touch_a_handle_replacement() {
        let handle = format!("stale-generation-test-{}", Uuid::new_v4());
        let first = try_register_handle_gen(&handle).expect("first generation acquires handle");
        assert!(deregister_generation(&handle, first));
        let second = try_register_handle_gen(&handle).expect("replacement acquires handle");

        let stale = cancel_process_for_generation(
            &handle,
            first,
            SyncCancelCause::TimeoutWatchdog,
            Duration::ZERO,
        );
        assert_eq!(stale, CancellationAttempt::default());
        assert!(!is_cancelled_for_generation(&handle, second));
        assert!(cancellation_record_for_generation(&handle, first).is_none());

        assert!(deregister_generation(&handle, second));
    }

    #[test]
    fn cancelled_generation_tombstone_survives_deregistration_until_callback_cleanup() {
        let handle = format!("cancelled-tombstone-test-{}", Uuid::new_v4());
        let generation = pre_register_handle_gen(&handle);
        assert!(cancel_process_impl(&handle, Duration::ZERO));
        assert!(deregister_generation(&handle, generation));

        assert!(is_cancelled_for_generation(&handle, generation));
        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            Some(CancellationRecord::default())
        );

        clear_cancellation_record(&handle, generation);
        assert!(!is_cancelled_for_generation(&handle, generation));
    }

    #[test]
    fn old_terminal_callback_cannot_deregister_a_replacement_generation() {
        let handle = format!("generation-replacement-test-{}", Uuid::new_v4());
        let first = try_register_handle_gen(&handle).expect("first generation acquires handle");
        let _ = cancel_process_for_generation(
            &handle,
            first,
            SyncCancelCause::TimeoutWatchdog,
            Duration::ZERO,
        );
        assert!(deregister_generation(&handle, first));

        let second = try_register_handle_gen(&handle).expect("replacement acquires handle");
        let mut replacement_visible = false;
        emit_exit_then_deregister(
            &handle,
            first,
            &mut |_| {
                replacement_visible = generation_for_handle(&handle) == Some(second)
                    && is_cancelled_for_generation(&handle, first)
                    && !is_cancelled_for_generation(&handle, second);
            },
            ProcessEvent::Exit {
                code: None,
                signal: None,
                success: false,
            },
        );

        assert!(replacement_visible);
        assert_eq!(generation_for_handle(&handle), Some(second));
        assert!(deregister_generation(&handle, second));
    }

    #[test]
    fn first_explicit_cancellation_cause_is_not_rewritten_by_app_exit() {
        let handle = format!("cause-order-test-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register generation");
        let _ = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );
        let _ = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::AppQuit,
            Duration::ZERO,
        );
        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            Some(CancellationRecord {
                cause: Some(SyncCancelCause::UserStop),
                termination_effected: false,
            })
        );
        let _ = deregister_generation(&handle, generation);
        clear_cancellation_record(&handle, generation);
    }

    #[test]
    fn abandoned_preflight_generation_clears_its_exact_cancellation_record() {
        let handle = format!("abandoned-generation-test-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register generation");
        let attempt = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );
        assert!(attempt.executed);
        assert!(cancellation_record_for_generation(&handle, generation).is_some());

        assert!(abandon_process_generation(&handle, generation));
        assert!(!is_registered(&handle));
        assert!(cancellation_record_for_generation(&handle, generation).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn pre_spawn_sync_cancellation_is_completed_by_the_process_layer() {
        let handle = format!("pre-spawn-cancel-test-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("sync generation acquires handle");
        let initial = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::TimeoutWatchdog,
            Duration::from_secs(1),
        );
        assert_eq!(
            initial,
            CancellationAttempt {
                executed: true,
                termination_effected: false,
            }
        );

        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "exec sleep 30".to_string()],
            cwd: None,
            env: None,
        };
        let mut observed = None;
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit { code, signal, .. } = event {
                observed = Some((
                    code,
                    signal,
                    cancellation_record_for_generation(&handle, generation),
                ));
            }
        })
        .expect("cancelled child still produces one terminal event");

        assert_eq!(
            observed,
            Some((
                None,
                Some(hq_desktop_core::sync_outcome::SIGTERM_SIGNAL),
                Some(CancellationRecord {
                    cause: Some(SyncCancelCause::TimeoutWatchdog),
                    termination_effected: true,
                }),
            ))
        );
        assert!(cancellation_record_for_generation(&handle, generation).is_none());
        assert!(!is_registered(&handle));
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

        let pids: Vec<(String, u32, u64)> = kids
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("exit-test-{i}"), c.id(), i as u64 + 1))
            .collect();

        for (_, pid, _) in &pids {
            assert!(alive(*pid), "child {pid} should be alive before teardown");
        }

        terminate_pids_for_exit(&pids, Duration::from_millis(200));

        // Reap so the existence probe reflects reality (a killed-but-unwaited
        // child lingers as a zombie), then assert every group is gone.
        for kid in &mut kids {
            let _ = kid.wait();
        }
        for (_, pid, _) in &pids {
            assert!(!alive(*pid), "child {pid} must be dead after teardown");
        }
    }

    #[test]
    fn terminate_pids_for_exit_is_noop_when_empty() {
        // Must not sleep the grace period or panic when nothing is registered.
        terminate_pids_for_exit(&[], Duration::from_secs(30));
    }
}
