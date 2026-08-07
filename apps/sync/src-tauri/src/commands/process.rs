//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{self, BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
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

use crate::util::logfile::log;

#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
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
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE,
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
    OwnershipLost {
        handle: String,
        generation: u64,
        cleanup_error: Option<io::Error>,
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
            Self::OwnershipLost { cleanup_error, .. } => {
                cleanup_error.as_ref().map(io::Error::kind)
            }
        }
    }

    pub fn raw_os_error(&self) -> Option<i32> {
        match self {
            Self::Spawn { source, .. } => source.raw_os_error(),
            Self::Stream { source, .. } => source.raw_os_error(),
            Self::Wait { source } => source.raw_os_error(),
            Self::OwnershipLost { cleanup_error, .. } => {
                cleanup_error.as_ref().and_then(io::Error::raw_os_error)
            }
        }
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { cmd, source } => write!(f, "spawn '{cmd}': {source}"),
            Self::Stream { stream, source } => write!(f, "{stream}: {source}"),
            Self::Wait { source } => write!(f, "{source}"),
            Self::OwnershipLost {
                handle,
                generation,
                cleanup_error,
            } => {
                write!(
                    f,
                    "process generation {generation} lost ownership of handle {handle} before attachment"
                )?;
                if let Some(error) = cleanup_error {
                    write!(f, "; stale child cleanup failed: {error}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn { source, .. } => Some(source),
            Self::Stream { source, .. } => Some(source),
            Self::Wait { source } => Some(source),
            Self::OwnershipLost { cleanup_error, .. } => cleanup_error
                .as_ref()
                .map(|error| error as &(dyn std::error::Error + 'static)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessTerminalOwner {
    Running,
    TerminationClaimed,
    TerminalObserved,
}

struct ProcessEntry {
    /// A public handle can be reused after a cancelled run. Deferred cleanup
    /// must therefore carry this ownership token rather than only the handle.
    generation: u64,
    pid: Option<u32>,
    cancelled: bool,
    terminal_owner: ProcessTerminalOwner,
    termination_target: Option<ProcessTerminationTarget>,
}

impl ProcessEntry {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            pid: None,
            cancelled: false,
            terminal_owner: ProcessTerminalOwner::Running,
            termination_target: None,
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

#[derive(Default)]
struct CancellationRecordsState {
    records: HashMap<(String, u64), CancellationRecord>,
    pending_publications: HashSet<(String, u64)>,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();
static CANCELLATION_RECORDS: OnceLock<Arc<(Mutex<CancellationRecordsState>, Condvar)>> =
    OnceLock::new();
static NEXT_PROCESS_GENERATION: AtomicU64 = AtomicU64::new(0);
const CANCELLATION_PUBLICATION_TIMEOUT: Duration = Duration::from_secs(5);

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

fn cancellation_records() -> &'static Arc<(Mutex<CancellationRecordsState>, Condvar)> {
    CANCELLATION_RECORDS.get_or_init(|| {
        Arc::new((
            Mutex::new(CancellationRecordsState::default()),
            Condvar::new(),
        ))
    })
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
        entry.termination_target = Some(ProcessTerminationTarget::for_pid(pid));
        entry.generation
    } else {
        let generation = next_process_generation();
        let mut entry = ProcessEntry::new(generation);
        entry.pid = Some(pid);
        entry.termination_target = Some(ProcessTerminationTarget::for_pid(pid));
        reg.insert(handle.to_string(), entry);
        generation
    }
}

pub fn register_process(handle: &str, pid: u32) {
    let _ = register_process_gen(handle, pid);
}

fn close_process_entry(mut entry: ProcessEntry) {
    if let Some(target) = entry.termination_target.take() {
        close_termination_target(target);
    }
}

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
            .0
            .lock()
            .unwrap()
            .records
            .contains_key(&(handle.to_string(), generation))
}

/// Read the causal cancellation record for the exact terminal callback. The
/// map is never queried by bare handle, preventing an old callback from
/// classifying a successor's cancellation.
pub fn cancellation_record_for_generation(
    handle: &str,
    generation: u64,
) -> Option<CancellationRecord> {
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let state = records.lock().unwrap();
    let (state, timeout) = publication_completed
        .wait_timeout_while(state, CANCELLATION_PUBLICATION_TIMEOUT, |state| {
            state.pending_publications.contains(&key)
        })
        .unwrap();
    if timeout.timed_out() && state.pending_publications.contains(&key) {
        log(
            "process",
            &format!(
                "cancellation publication timed out for {handle} generation {generation}; retaining non-effective attribution"
            ),
        );
        return state.records.get(&key).copied().map(|mut record| {
            record.termination_effected = false;
            record
        });
    }
    state.records.get(&key).copied()
}

fn clear_cancellation_record(handle: &str, generation: u64) {
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    state.records.remove(&key);
    state.pending_publications.remove(&key);
    publication_completed.notify_all();
}

fn begin_cancellation_publication(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
) -> (bool, bool) {
    let key = (handle.to_string(), generation);
    let (records, _) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    let created = !state.records.contains_key(&key);
    let record = state.records.entry(key.clone()).or_default();
    if let Some(cause) = cause {
        record.cause.get_or_insert(cause);
    }
    let owns_publication = state.pending_publications.insert(key);
    (owns_publication, created)
}

fn begin_effect_publication_if_record(handle: &str, generation: u64) -> bool {
    let key = (handle.to_string(), generation);
    let (records, _) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    if !state.records.contains_key(&key) {
        return false;
    }
    state.pending_publications.insert(key)
}

fn complete_cancellation_publication(
    handle: &str,
    generation: u64,
    observed_effect: bool,
    attribution_allowed: bool,
) -> bool {
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    if let Some(record) = state.records.get_mut(&key) {
        record.termination_effected |= observed_effect && attribution_allowed;
    }
    let termination_effected = state
        .records
        .get(&key)
        .is_some_and(|record| record.termination_effected);
    state.pending_publications.remove(&key);
    publication_completed.notify_all();
    termination_effected
}

fn abandon_cancellation_publication(handle: &str, generation: u64, remove_record: bool) {
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    state.pending_publications.remove(&key);
    if remove_record {
        state.records.remove(&key);
    }
    publication_completed.notify_all();
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

/// Forces the Job Object attachment outcome for one exact handle so Windows CI
/// can drive a real child through the pid-tree fallback that a failing
/// `CreateJobObjectW` / `AssignProcessToJobObject` selects in production. It
/// forces only the attachment result: the termination that follows is the
/// unmodified production path, so a test asserting that a real child and its
/// real descendants disappeared is asserting production behaviour. Keyed by
/// handle rather than thread so a runner spawned on a worker thread is covered.
/// Test-only — it cannot exist in a shipped binary.
#[cfg(all(test, target_os = "windows"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestJobAssignmentOutcome {
    CreateFailed,
    AssignFailed,
}

#[cfg(all(test, target_os = "windows"))]
static TEST_JOB_ASSIGNMENTS: OnceLock<Mutex<HashMap<String, TestJobAssignmentOutcome>>> =
    OnceLock::new();

#[cfg(all(test, target_os = "windows"))]
fn test_job_assignments() -> &'static Mutex<HashMap<String, TestJobAssignmentOutcome>> {
    TEST_JOB_ASSIGNMENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(all(test, target_os = "windows"))]
fn force_test_job_assignment(handle: &str, outcome: TestJobAssignmentOutcome) {
    test_job_assignments()
        .lock()
        .unwrap()
        .insert(handle.to_string(), outcome);
}

#[cfg(all(test, target_os = "windows"))]
fn clear_test_job_assignment(handle: &str) {
    test_job_assignments().lock().unwrap().remove(handle);
}

#[cfg(all(test, target_os = "windows"))]
fn take_test_job_assignment(handle: &str) -> Option<TestJobAssignmentOutcome> {
    test_job_assignments().lock().unwrap().get(handle).copied()
}

#[cfg(target_os = "windows")]
fn assign_child_to_job(
    handle: &str,
    generation: u64,
    child: &std::process::Child,
) -> (Option<isize>, JobAssignment) {
    #[cfg(test)]
    if let Some(forced) = take_test_job_assignment(handle) {
        log(
            "process",
            &format!(
                "injected Job Object attachment failure ({forced:?}) for {handle} generation {generation}"
            ),
        );
        return (
            None,
            match forced {
                TestJobAssignmentOutcome::CreateFailed => JobAssignment::CreateFailed,
                TestJobAssignmentOutcome::AssignFailed => JobAssignment::AssignFailed,
            },
        );
    }
    let proc_handle = HANDLE(child.as_raw_handle());
    unsafe {
        match create_kill_on_close_job() {
            Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                Ok(()) => (Some(job.0 as isize), JobAssignment::Attached),
                Err(e) => {
                    let _ = CloseHandle(job);
                    log(
                        "process",
                        &format!(
                            "AssignProcessToJobObject failed for {handle} generation {generation}: {e}"
                        ),
                    );
                    (None, JobAssignment::AssignFailed)
                }
            },
            Err(e) => {
                log(
                    "process",
                    &format!(
                        "create_kill_on_close_job failed for {handle} generation {generation}: {e}"
                    ),
                );
                (None, JobAssignment::CreateFailed)
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn assign_child_to_job(
    _handle: &str,
    _generation: u64,
    _child: &std::process::Child,
) -> (Option<isize>, JobAssignment) {
    (None, JobAssignment::Attached)
}

/// Exact-generation OS termination authority. Windows handles are transferred
/// out of the registry when cancellation wins the terminal claim, so cleanup
/// cannot close or recycle them while the termination call is in flight.
#[derive(Default)]
struct ProcessTerminationTarget {
    pid: Option<u32>,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
    #[cfg(target_os = "windows")]
    process_handle: Option<isize>,
    #[cfg(target_os = "windows")]
    owns_handles: bool,
}

impl ProcessTerminationTarget {
    fn for_pid(pid: u32) -> Self {
        Self {
            pid: Some(pid),
            ..Self::default()
        }
    }
}

#[cfg(target_os = "windows")]
fn duplicate_child_process_handle(child: &std::process::Child) -> Option<isize> {
    let source_process = unsafe { GetCurrentProcess() };
    let source_handle = HANDLE(child.as_raw_handle());
    let mut duplicate = HANDLE::default();
    let result = unsafe {
        DuplicateHandle(
            source_process,
            source_handle,
            source_process,
            &mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    };
    match result {
        Ok(()) => Some(duplicate.0 as isize),
        Err(error) => {
            log(
                "process",
                &format!("DuplicateHandle failed for pid {}: {error}", child.id()),
            );
            None
        }
    }
}

fn prepare_termination_target(
    handle: &str,
    generation: u64,
    child: &std::process::Child,
) -> (ProcessTerminationTarget, JobAssignment) {
    let (job_handle, assignment) = assign_child_to_job(handle, generation, child);
    ProcessTerminationTarget::for_pid(child.id())
        .with_platform_handles(job_handle, child, assignment)
}

impl ProcessTerminationTarget {
    #[cfg(target_os = "windows")]
    fn with_platform_handles(
        mut self,
        job_handle: Option<isize>,
        child: &std::process::Child,
        assignment: JobAssignment,
    ) -> (Self, JobAssignment) {
        self.job_handle = job_handle;
        self.process_handle = duplicate_child_process_handle(child);
        self.owns_handles = true;
        (self, assignment)
    }

    #[cfg(not(target_os = "windows"))]
    fn with_platform_handles(
        self,
        _job_handle: Option<isize>,
        _child: &std::process::Child,
        assignment: JobAssignment,
    ) -> (Self, JobAssignment) {
        (self, assignment)
    }
}

#[cfg(target_os = "windows")]
fn close_termination_target(target: ProcessTerminationTarget) {
    if !target.owns_handles {
        return;
    }
    for raw in [target.job_handle, target.process_handle]
        .into_iter()
        .flatten()
    {
        unsafe {
            let _ = CloseHandle(HANDLE(raw as *mut std::ffi::c_void));
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn close_termination_target(_target: ProcessTerminationTarget) {}

fn pid_for_generation(handle: &str, generation: u64) -> Option<u32> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .filter(|entry| entry.generation == generation)
        .and_then(|entry| entry.pid)
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
fn terminate_windows_pid_tree(root_pid: u32, root_handle: Option<isize>) -> bool {
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
            Ok(()) => {}
            Err(error) => log(
                "process",
                &format!("TerminateProcess failed for pid {pid}: {error}"),
            ),
        }
    }

    if let Some(raw) = root_handle {
        return match unsafe { TerminateProcess(HANDLE(raw as *mut std::ffi::c_void), 1) } {
            Ok(()) => true,
            Err(error) => {
                log(
                    "process",
                    &format!("TerminateProcess failed for root pid {root_pid}: {error}"),
                );
                false
            }
        };
    }

    let process = match unsafe { OpenProcess(PROCESS_TERMINATE, false, root_pid) } {
        Ok(process) => process,
        Err(error) => {
            log(
                "process",
                &format!("OpenProcess(PROCESS_TERMINATE) failed for root pid {root_pid}: {error}"),
            );
            return false;
        }
    };
    let result = unsafe { TerminateProcess(process, 1) };
    unsafe {
        let _ = CloseHandle(process);
    }
    match result {
        Ok(()) => true,
        Err(error) => {
            log(
                "process",
                &format!("TerminateProcess failed for root pid {root_pid}: {error}"),
            );
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn terminate_target(target: ProcessTerminationTarget) -> bool {
    let result = terminate_windows_target(&target);
    close_termination_target(target);
    result
}

#[cfg(target_os = "windows")]
fn terminate_windows_target(target: &ProcessTerminationTarget) -> bool {
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
    target
        .pid
        .map(|pid| terminate_windows_pid_tree(pid, target.process_handle))
        .unwrap_or(false)
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

#[cfg(target_os = "windows")]
fn windows_target_has_exited(target: &ProcessTerminationTarget) -> Option<bool> {
    #[cfg(test)]
    if !target.owns_handles {
        return Some(false);
    }
    let raw = target.process_handle?;
    let observed = unsafe { WaitForSingleObject(HANDLE(raw as *mut std::ffi::c_void), 0) };
    if observed == WAIT_OBJECT_0 {
        Some(true)
    } else if observed == WAIT_TIMEOUT {
        Some(false)
    } else {
        log(
            "process",
            &format!(
                "WaitForSingleObject returned unexpected status {}",
                observed.0
            ),
        );
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn windows_target_has_exited(_target: &ProcessTerminationTarget) -> Option<bool> {
    Some(false)
}

enum ProcessAttachOutcome {
    Attached {
        generation: u64,
    },
    Cancelled {
        generation: u64,
        target: ProcessTerminationTarget,
        attribution_allowed: bool,
    },
    RefusedStale {
        generation: u64,
        target: ProcessTerminationTarget,
    },
}

/// Atomically attach the prepared OS target to the generation snapshotted
/// before spawn. A stale runner never writes its pid or handles into a
/// replacement entry. If cancellation already won, attachment transfers the
/// target directly to that cancellation instead of exposing it to cleanup.
fn attach_prepared_process(
    handle: &str,
    expected_generation: Option<u64>,
    target: ProcessTerminationTarget,
    _owns_cancellation_publication: bool,
) -> ProcessAttachOutcome {
    let pid = target
        .pid
        .expect("spawned process target must carry its pid");
    let mut registry = process_registry().lock().unwrap();

    let generation = if let Some(expected_generation) = expected_generation {
        let Some(entry) = registry
            .get_mut(handle)
            .filter(|entry| entry.generation == expected_generation && entry.pid.is_none())
        else {
            return ProcessAttachOutcome::RefusedStale {
                generation: expected_generation,
                target,
            };
        };
        entry.pid = Some(pid);
        // A cancellation may have observed this generation before the child had
        // a pid. Its publication can still be pending when the spawner reaches
        // this point, so publication ownership is not an attachment ownership
        // signal. Once the exact generation is marked cancelled, transfer the
        // newly attached target to the process-layer cancellation path.
        if entry.cancelled {
            match windows_target_has_exited(&target) {
                Some(true) => {
                    entry.terminal_owner = ProcessTerminalOwner::TerminalObserved;
                }
                observed_running => {
                    entry.terminal_owner = ProcessTerminalOwner::TerminationClaimed;
                    return ProcessAttachOutcome::Cancelled {
                        generation: expected_generation,
                        target,
                        attribution_allowed: observed_running == Some(false),
                    };
                }
            }
        }
        entry.termination_target = Some(target);
        expected_generation
    } else {
        use std::collections::hash_map::Entry;
        match registry.entry(handle.to_string()) {
            Entry::Occupied(_) => {
                return ProcessAttachOutcome::RefusedStale {
                    generation: 0,
                    target,
                };
            }
            Entry::Vacant(vacant) => {
                let generation = next_process_generation();
                let mut entry = ProcessEntry::new(generation);
                entry.pid = Some(pid);
                entry.termination_target = Some(target);
                vacant.insert(entry);
                generation
            }
        }
    };

    ProcessAttachOutcome::Attached { generation }
}

fn mark_terminal_observed(handle: &str, generation: u64) -> bool {
    let mut registry = process_registry().lock().unwrap();
    let Some(entry) = registry
        .get_mut(handle)
        .filter(|entry| entry.generation == generation)
    else {
        return false;
    };
    if entry.terminal_owner == ProcessTerminalOwner::Running {
        entry.terminal_owner = ProcessTerminalOwner::TerminalObserved;
        true
    } else {
        false
    }
}

fn close_child_pipes(child: &mut std::process::Child) {
    drop(child.stdin.take());
    drop(child.stdout.take());
    drop(child.stderr.take());
}

fn kill_child_directly_or_confirm_exited(child: &mut std::process::Child) -> io::Result<bool> {
    match child.kill() {
        Ok(()) => Ok(false),
        Err(kill_error) => match child.try_wait() {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Err(kill_error),
            Err(probe_error) => Err(io::Error::new(
                probe_error.kind(),
                format!(
                    "direct stale-child kill failed: {kill_error}; exit probe also failed: {probe_error}"
                ),
            )),
        },
    }
}

fn terminate_stale_spawn(
    child: &mut std::process::Child,
    target: ProcessTerminationTarget,
) -> io::Result<()> {
    close_child_pipes(child);
    #[cfg(unix)]
    let terminated = target
        .pid
        .is_some_and(|pid| signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL).is_ok());
    #[cfg(target_os = "windows")]
    let terminated = terminate_target(target);
    #[cfg(not(any(unix, target_os = "windows")))]
    let terminated = terminate_target(target);

    let already_reaped = if terminated {
        false
    } else {
        kill_child_directly_or_confirm_exited(child)?
    };
    if already_reaped {
        Ok(())
    } else {
        child.wait().map(|_| ())
    }
}

fn ownership_lost_error(
    handle: &str,
    generation: u64,
    cleanup_error: Option<io::Error>,
) -> ProcessError {
    ProcessError::OwnershipLost {
        handle: handle.to_string(),
        generation,
        cleanup_error,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

pub fn run_process_impl<F>(handle: &str, spawn: &SpawnArgs, on_event: F) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
{
    run_process_impl_inner(handle, generation_for_handle(handle), spawn, on_event)
}

pub(crate) fn run_process_impl_for_generation<F>(
    handle: &str,
    generation: u64,
    spawn: &SpawnArgs,
    on_event: F,
) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
{
    run_process_impl_inner(handle, Some(generation), spawn, on_event)
}

fn run_process_impl_inner<F>(
    handle: &str,
    pre_registered_generation: Option<u64>,
    spawn: &SpawnArgs,
    on_event: F,
) -> Result<(), ProcessError>
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
            if let Some(generation) = pre_registered_generation {
                let _ = deregister_generation(handle, generation);
                clear_cancellation_record(handle, generation);
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let prepared_generation = pre_registered_generation.unwrap_or(0);
    let (target, _job_assignment) = prepare_termination_target(handle, prepared_generation, &child);
    let owns_cancellation_publication = pre_registered_generation
        .is_some_and(|generation| begin_effect_publication_if_record(handle, generation));
    let generation = match attach_prepared_process(
        handle,
        pre_registered_generation,
        target,
        owns_cancellation_publication,
    ) {
        ProcessAttachOutcome::Attached { generation } => {
            if owns_cancellation_publication {
                let _ = complete_cancellation_publication(handle, generation, false, true);
            }
            generation
        }
        ProcessAttachOutcome::Cancelled {
            generation,
            target,
            attribution_allowed,
        } => {
            let _ = terminate_claimed_target_with(
                handle,
                generation,
                target,
                attribution_allowed,
                terminate_target,
            );
            generation
        }
        ProcessAttachOutcome::RefusedStale { generation, target } => {
            if owns_cancellation_publication && generation != 0 {
                let _ = complete_cancellation_publication(handle, generation, false, true);
            }
            let cleanup_error = terminate_stale_spawn(&mut child, target).err();
            return Err(ownership_lost_error(handle, generation, cleanup_error));
        }
    };

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
    let _ = mark_terminal_observed(handle, generation);
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
    run_process_with_stdin_impl_inner(
        handle,
        generation_for_handle(handle),
        spawn,
        on_event,
        on_spawn,
    )
}

pub(crate) fn run_process_with_stdin_impl_for_generation<F, S>(
    handle: &str,
    generation: u64,
    spawn: &SpawnArgs,
    on_event: F,
    on_spawn: S,
) -> Result<(), ProcessError>
where
    F: FnMut(ProcessEvent),
    S: FnOnce(&mut std::process::Child),
{
    run_process_with_stdin_impl_inner(handle, Some(generation), spawn, on_event, on_spawn)
}

fn run_process_with_stdin_impl_inner<F, S>(
    handle: &str,
    pre_registered_generation: Option<u64>,
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
            if let Some(generation) = pre_registered_generation {
                let _ = deregister_generation(handle, generation);
                clear_cancellation_record(handle, generation);
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };

    let prepared_generation = pre_registered_generation.unwrap_or(0);
    let (target, _job_assignment) = prepare_termination_target(handle, prepared_generation, &child);
    let owns_cancellation_publication = pre_registered_generation
        .is_some_and(|generation| begin_effect_publication_if_record(handle, generation));
    let generation = match attach_prepared_process(
        handle,
        pre_registered_generation,
        target,
        owns_cancellation_publication,
    ) {
        ProcessAttachOutcome::Attached { generation } => {
            if owns_cancellation_publication {
                let _ = complete_cancellation_publication(handle, generation, false, true);
            }
            generation
        }
        ProcessAttachOutcome::Cancelled {
            generation,
            target,
            attribution_allowed,
        } => {
            let _ = terminate_claimed_target_with(
                handle,
                generation,
                target,
                attribution_allowed,
                terminate_target,
            );
            generation
        }
        ProcessAttachOutcome::RefusedStale { generation, target } => {
            if owns_cancellation_publication && generation != 0 {
                let _ = complete_cancellation_publication(handle, generation, false, true);
            }
            let cleanup_error = terminate_stale_spawn(&mut child, target).err();
            return Err(ownership_lost_error(handle, generation, cleanup_error));
        }
    };

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

enum CancellationClaim {
    Stale,
    TerminalObserved,
    AlreadyClaimed,
    PendingAttachment,
    Target {
        target: ProcessTerminationTarget,
        attribution_allowed: bool,
    },
}

// Lock order is intentionally non-nesting: publication helpers release the
// cancellation-record mutex before this function acquires the registry mutex;
// a successful claim transfers the target out before the record mutex is taken
// again for the OS call. `TerminationClaimed` is the terminal linearization
// point. A terminal observation (or a signalled retained Windows process
// handle) that wins first stays natural; a cancellation claim that wins first
// exclusively owns the subsequent termination status.
fn claim_cancelled_generation(handle: &str, generation: u64) -> CancellationClaim {
    let mut registry = process_registry().lock().unwrap();
    let Some(entry) = registry
        .get_mut(handle)
        .filter(|entry| entry.generation == generation)
    else {
        return CancellationClaim::Stale;
    };
    match entry.terminal_owner {
        ProcessTerminalOwner::TerminalObserved => return CancellationClaim::TerminalObserved,
        ProcessTerminalOwner::TerminationClaimed => return CancellationClaim::AlreadyClaimed,
        ProcessTerminalOwner::Running => {}
    }
    let Some(target) = entry.termination_target.as_ref() else {
        entry.cancelled = true;
        return CancellationClaim::PendingAttachment;
    };
    match windows_target_has_exited(target) {
        Some(true) => {
            entry.terminal_owner = ProcessTerminalOwner::TerminalObserved;
            CancellationClaim::TerminalObserved
        }
        observed_running => {
            entry.cancelled = true;
            entry.terminal_owner = ProcessTerminalOwner::TerminationClaimed;
            CancellationClaim::Target {
                target: entry
                    .termination_target
                    .take()
                    .expect("claimed target must remain attached"),
                attribution_allowed: observed_running == Some(false),
            }
        }
    }
}

fn terminate_claimed_target_with<F>(
    handle: &str,
    generation: u64,
    target: ProcessTerminationTarget,
    attribution_allowed: bool,
    terminate: F,
) -> bool
where
    F: FnOnce(ProcessTerminationTarget) -> bool,
{
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    let observed = terminate(target);
    if let Some(record) = state.records.get_mut(&key) {
        record.termination_effected |= observed && attribution_allowed;
    }
    let termination_effected = state
        .records
        .get(&key)
        .is_some_and(|record| record.termination_effected);
    state.pending_publications.remove(&key);
    publication_completed.notify_all();
    termination_effected
}

/// Which branch a scheduled escalation actually took, published per exact
/// `(handle, generation)`. Escalation runs on its own thread after a delay, so
/// without this a cross-generation test could only guess at ordering; with it a
/// test blocks on the real outcome under a hard deadline. Test-only.
#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestEscalationOutcome {
    /// Read its own ownership and stopped — it never signalled anything.
    NotCancelled,
    NoPid,
    PublicationLost,
    Signalled {
        effected: bool,
    },
}

#[cfg(all(test, unix))]
#[derive(Default)]
struct TestEscalationState {
    gates: HashSet<(String, u64)>,
    outcomes: HashMap<(String, u64), TestEscalationOutcome>,
}

#[cfg(all(test, unix))]
static TEST_ESCALATIONS: OnceLock<Arc<(Mutex<TestEscalationState>, Condvar)>> = OnceLock::new();

#[cfg(all(test, unix))]
fn test_escalations() -> &'static Arc<(Mutex<TestEscalationState>, Condvar)> {
    TEST_ESCALATIONS
        .get_or_init(|| Arc::new((Mutex::new(TestEscalationState::default()), Condvar::new())))
}

/// Hold one exact generation's escalation before it reads ownership, so a test
/// can establish the replacement interleaving instead of racing it.
#[cfg(all(test, unix))]
fn arm_test_escalation_gate(handle: &str, generation: u64) {
    let (state, _) = &**test_escalations();
    state
        .lock()
        .unwrap()
        .gates
        .insert((handle.to_string(), generation));
}

#[cfg(all(test, unix))]
fn release_test_escalation_gate(handle: &str, generation: u64) {
    let (state, changed) = &**test_escalations();
    state
        .lock()
        .unwrap()
        .gates
        .remove(&(handle.to_string(), generation));
    changed.notify_all();
}

#[cfg(all(test, unix))]
fn await_test_escalation_gate(handle: &str, generation: u64) {
    let key = (handle.to_string(), generation);
    let (state, changed) = &**test_escalations();
    let mut guard = state.lock().unwrap();
    let start = std::time::Instant::now();
    while guard.gates.contains(&key) {
        // Bounded on purpose: a test that never releases must fail through its
        // own deadline rather than wedge a worker thread forever.
        let Some(remaining) = TEST_ESCALATION_GATE_TIMEOUT.checked_sub(start.elapsed()) else {
            break;
        };
        let (next, timeout) = changed
            .wait_timeout(guard, remaining)
            .expect("escalation gate mutex");
        guard = next;
        if timeout.timed_out() {
            break;
        }
    }
}

#[cfg(all(test, unix))]
const TEST_ESCALATION_GATE_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(all(test, unix))]
fn record_test_escalation_outcome(handle: &str, generation: u64, outcome: TestEscalationOutcome) {
    let (state, changed) = &**test_escalations();
    state
        .lock()
        .unwrap()
        .outcomes
        .insert((handle.to_string(), generation), outcome);
    changed.notify_all();
}

#[cfg(all(test, unix))]
fn await_test_escalation_outcome(
    handle: &str,
    generation: u64,
    deadline: Duration,
) -> Option<TestEscalationOutcome> {
    let key = (handle.to_string(), generation);
    let (state, changed) = &**test_escalations();
    let mut guard = state.lock().unwrap();
    let start = std::time::Instant::now();
    loop {
        if let Some(outcome) = guard.outcomes.get(&key).copied() {
            return Some(outcome);
        }
        let remaining = deadline.checked_sub(start.elapsed())?;
        if remaining.is_zero() {
            return None;
        }
        let (next, _) = changed
            .wait_timeout(guard, remaining)
            .expect("escalation outcome mutex");
        guard = next;
    }
}

#[cfg(all(test, unix))]
fn clear_test_escalation(handle: &str, generation: u64) {
    let (state, changed) = &**test_escalations();
    let mut guard = state.lock().unwrap();
    guard.gates.remove(&(handle.to_string(), generation));
    guard.outcomes.remove(&(handle.to_string(), generation));
    drop(guard);
    changed.notify_all();
}

#[cfg(unix)]
fn schedule_sigkill_escalation(handle: String, generation: u64, sigkill_delay: Duration) {
    thread::spawn(move || {
        thread::sleep(sigkill_delay);
        // Test-only ordering barrier. It cannot exist in a shipped binary and
        // never changes which branch production takes below; it only lets a
        // test establish a replacement generation first and then observe the
        // real decision this escalation makes about its own generation.
        #[cfg(test)]
        await_test_escalation_gate(&handle, generation);
        if !cancellation_requested_for_generation(&handle, generation) {
            #[cfg(test)]
            record_test_escalation_outcome(
                &handle,
                generation,
                TestEscalationOutcome::NotCancelled,
            );
            return;
        }
        let Some(pid) = pid_for_generation(&handle, generation) else {
            #[cfg(test)]
            record_test_escalation_outcome(&handle, generation, TestEscalationOutcome::NoPid);
            return;
        };
        if begin_effect_publication_if_record(&handle, generation) {
            let _effected = terminate_claimed_target_with(
                &handle,
                generation,
                ProcessTerminationTarget::for_pid(pid),
                true,
                |target| {
                    target.pid.is_some_and(|pid| {
                        signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL).is_ok()
                    })
                },
            );
            #[cfg(test)]
            record_test_escalation_outcome(
                &handle,
                generation,
                TestEscalationOutcome::Signalled {
                    effected: _effected,
                },
            );
        } else {
            #[cfg(test)]
            record_test_escalation_outcome(
                &handle,
                generation,
                TestEscalationOutcome::PublicationLost,
            );
        }
    });
}

fn cancel_registered_generation_with<P, F>(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
    sigkill_delay: Duration,
    after_publish: P,
    terminate: F,
) -> CancellationAttempt
where
    P: FnOnce(),
    F: FnOnce(ProcessTerminationTarget) -> bool,
{
    let (owns_publication, created_record) =
        begin_cancellation_publication(handle, generation, cause);
    if !owns_publication {
        let record = cancellation_record_for_generation(handle, generation).unwrap_or_default();
        return CancellationAttempt {
            executed: cancellation_requested_for_generation(handle, generation),
            termination_effected: record.termination_effected,
        };
    }

    // Test barriers pause here. Cause evidence is already visible while the
    // registry is not yet marked, so attachment either precedes the mark and is
    // claimed below or follows it and owns the process-layer completion.
    after_publish();
    let claim = claim_cancelled_generation(handle, generation);

    let (termination_effected, target_pid) = match claim {
        CancellationClaim::Stale | CancellationClaim::TerminalObserved => {
            abandon_cancellation_publication(handle, generation, created_record);
            return CancellationAttempt::default();
        }
        CancellationClaim::AlreadyClaimed => (
            complete_cancellation_publication(handle, generation, false, true),
            None,
        ),
        CancellationClaim::PendingAttachment => (
            complete_cancellation_publication(handle, generation, false, true),
            None,
        ),
        CancellationClaim::Target {
            target,
            attribution_allowed,
        } => {
            let target_pid = target.pid;
            (
                terminate_claimed_target_with(
                    handle,
                    generation,
                    target,
                    attribution_allowed,
                    terminate,
                ),
                target_pid,
            )
        }
    };

    #[cfg(unix)]
    if target_pid.is_some() {
        schedule_sigkill_escalation(handle.to_string(), generation, sigkill_delay);
    }
    #[cfg(not(unix))]
    let _ = (sigkill_delay, target_pid);

    CancellationAttempt {
        executed: true,
        termination_effected,
    }
}

fn cancel_registered_generation(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    cancel_registered_generation_with(
        handle,
        generation,
        cause,
        sigkill_delay,
        || {},
        terminate_target,
    )
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
        if begin_effect_publication_if_record(handle, *generation) {
            let _ = terminate_claimed_target_with(
                handle,
                *generation,
                ProcessTerminationTarget::for_pid(*pid),
                true,
                |target| {
                    target.pid.is_some_and(|pid| {
                        signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL).is_ok()
                    })
                },
            );
        }
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
            ..ProcessTerminationTarget::default()
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

    #[test]
    fn naturally_completed_windows_code_one_cannot_be_claimed_by_late_cancellation() {
        let handle = format!("windows-natural-exit-race-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        let mut command = build_spawn_command(
            "cmd.exe",
            &["/d".to_string(), "/c".to_string(), "exit /b 1".to_string()],
        );
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn natural code-one child");
        let (target, _) = prepare_termination_target(&handle, generation, &child);
        assert!(matches!(
            attach_prepared_process(&handle, Some(generation), target, false),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));

        let status = child.wait().expect("observe natural child exit");
        assert_eq!(status.code(), Some(1));
        let attempt = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );

        assert_eq!(
            attempt,
            CancellationAttempt::default(),
            "a signalled root-process handle proves the code-one exit predated cancellation"
        );
        assert!(
            cancellation_record_for_generation(&handle, generation).is_none(),
            "late cancellation must not create suppressible attribution"
        );
        assert!(
            !is_cancelled(&handle),
            "late cancellation must not rewrite a natural terminal state"
        );
        assert!(deregister_generation(&handle, generation));
    }

    #[test]
    fn claimed_windows_target_survives_registry_cleanup_until_termination_finishes() {
        let handle = format!("windows-cleanup-race-{}", Uuid::new_v4());
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
        let mut command = build_spawn_command(&spawn.cmd, &spawn.args);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn Windows fixture child");
        let (target, _) = prepare_termination_target(&handle, generation, &child);
        assert!(matches!(
            attach_prepared_process(&handle, Some(generation), target, false),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));

        let (claimed_tx, claimed_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let cancel_handle = handle.clone();
        let canceller = thread::spawn(move || {
            let attempt = cancel_registered_generation_with(
                &cancel_handle,
                generation,
                Some(SyncCancelCause::TimeoutWatchdog),
                Duration::ZERO,
                || {},
                |target| {
                    claimed_tx.send(()).expect("announce target claim");
                    resume_rx
                        .recv_timeout(Duration::from_secs(10))
                        .expect("cleanup must release termination barrier");
                    terminate_target(target)
                },
            );
            done_tx.send(attempt).expect("return cancellation result");
        });

        claimed_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("cancellation must claim the owned handles");
        assert!(
            deregister_generation(&handle, generation),
            "cleanup may remove registry bookkeeping after handle ownership transfers"
        );
        resume_tx.send(()).expect("resume Windows termination");
        let attempt = done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("termination must finish with the transferred handles");
        canceller.join().expect("canceller thread must not panic");
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: true,
            }
        );
        let status = child.wait().expect("reap terminated fixture child");
        assert_eq!(status.code(), Some(1));
        clear_cancellation_record(&handle, generation);
    }
}

/// Windows Job Object attachment can fail (`CreateJobObjectW` or
/// `AssignProcessToJobObject`), and the base app then cancelled nothing at all
/// while still reporting success. These regressions force each failure mode and
/// require the production pid-tree fallback to terminate a real child and its
/// real descendants, to leave everything outside that tree alone, and to keep an
/// ineffective termination alertable.
#[cfg(all(test, target_os = "windows"))]
mod windows_job_attachment_failure_tests {
    use super::*;
    use hq_desktop_core::sync_outcome::{
        classify_runner_exit_disposition_with_cancellation, RunnerExitDisposition,
    };

    /// Poll an observable condition under a hard deadline. Returns false on
    /// expiry so the caller fails with its own message instead of hanging.
    fn wait_until(deadline: Duration, mut ready: impl FnMut() -> bool) -> bool {
        let start = std::time::Instant::now();
        loop {
            if ready() {
                return true;
            }
            if start.elapsed() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Live-process probe over the same Toolhelp snapshot the production
    /// descendant walk uses. A terminated process leaves that snapshot, so this
    /// observes real disappearance rather than an injected boolean.
    fn pid_alive(pid: u32) -> bool {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .expect("process snapshot for the liveness probe");
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
        let mut found = false;
        while next.is_ok() {
            if entry.th32ProcessID == pid {
                found = true;
                break;
            }
            entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            next = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe {
            let _ = CloseHandle(snapshot);
        }
        found
    }

    fn spawn_detached(cmd: &str, args: &[String]) -> std::process::Child {
        let mut command = build_spawn_command(cmd, args);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.spawn().expect("spawn Windows fixture process")
    }

    fn long_lived_ping() -> Vec<String> {
        vec![
            "/d".to_string(),
            "/c".to_string(),
            "ping 127.0.0.1 -n 60 > nul".to_string(),
        ]
    }

    /// A root `cmd.exe` that spawns its own descendants, so the pid-tree walk
    /// has a real multi-level tree to enumerate rather than a single process.
    fn spawn_tree_root(dir: &std::path::Path) -> std::process::Child {
        let script = dir.join("descendant-tree.cmd");
        std::fs::write(
            &script,
            "@echo off\r\ncmd.exe /d /c ping 127.0.0.1 -n 60 > nul\r\n",
        )
        .expect("write descendant fixture");
        spawn_detached(
            "cmd.exe",
            &[
                "/d".to_string(),
                "/c".to_string(),
                script.to_string_lossy().into_owned(),
            ],
        )
    }

    fn assert_attachment_failure_terminates_real_tree(
        label: &str,
        forced: TestJobAssignmentOutcome,
        expected: JobAssignment,
    ) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let handle = format!("{label}-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        force_test_job_assignment(&handle, forced);

        // Never registered and outside the tree under test: the fallback must
        // not widen past the pid tree it was handed.
        let mut outsider = spawn_detached("cmd.exe", &long_lived_ping());
        let outsider_pid = outsider.id();

        let mut child = spawn_tree_root(tmp.path());
        let root_pid = child.id();
        let (target, assignment) = prepare_termination_target(&handle, generation, &child);
        assert_eq!(
            assignment, expected,
            "the seam must force exactly the production attachment failure under test"
        );
        assert!(matches!(
            attach_prepared_process(&handle, Some(generation), target, false),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));

        assert!(
            wait_until(Duration::from_secs(30), || !windows_descendants(root_pid)
                .is_empty()),
            "the fixture root must actually spawn a descendant to terminate"
        );
        let descendants = windows_descendants(root_pid);
        assert!(
            !descendants.is_empty(),
            "descendant snapshot must be stable"
        );
        assert!(
            pid_alive(outsider_pid),
            "the outsider must be running before cancellation"
        );

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
            },
            "a real pid-tree fallback termination is an observed effective stop"
        );

        let status = child.wait().expect("reap the terminated fixture root");
        assert_eq!(
            (status.code(), status.success()),
            (Some(1), false),
            "the app's own Windows termination has the exact code-1/no-signal shape HQ-DESKTOP-48 reports"
        );
        for pid in &descendants {
            assert!(
                wait_until(Duration::from_secs(30), || !pid_alive(*pid)),
                "descendant {pid} must be terminated by the production pid-tree fallback"
            );
        }
        assert!(
            pid_alive(outsider_pid),
            "the fallback must never terminate a process outside the registered pid tree"
        );

        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            Some(CancellationRecord {
                cause: Some(SyncCancelCause::TimeoutWatchdog),
                termination_effected: true,
            })
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                status.code(),
                None,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
            "an observed app termination of this exact generation is not a runner fault"
        );

        let _ = outsider.kill();
        let _ = outsider.wait();
        let _ = deregister_generation(&handle, generation);
        clear_cancellation_record(&handle, generation);
        clear_test_job_assignment(&handle);
    }

    #[test]
    fn windows_job_create_failure_terminates_the_real_child_tree_and_spares_outsiders() {
        assert_attachment_failure_terminates_real_tree(
            "windows-job-create-failed",
            TestJobAssignmentOutcome::CreateFailed,
            JobAssignment::CreateFailed,
        );
    }

    #[test]
    fn windows_job_assign_failure_terminates_the_real_child_tree_and_spares_outsiders() {
        assert_attachment_failure_terminates_real_tree(
            "windows-job-assign-failed",
            TestJobAssignmentOutcome::AssignFailed,
            JobAssignment::AssignFailed,
        );
    }

    #[test]
    fn windows_attachment_failure_with_ineffective_root_termination_stays_alertable() {
        let handle = format!("windows-attach-failure-ineffective-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        force_test_job_assignment(&handle, TestJobAssignmentOutcome::CreateFailed);

        let mut child = spawn_detached("cmd.exe", &long_lived_ping());
        let (target, assignment) = prepare_termination_target(&handle, generation, &child);
        assert_eq!(assignment, JobAssignment::CreateFailed);
        assert!(matches!(
            attach_prepared_process(&handle, Some(generation), target, false),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));

        // The fallback runs, but its root termination fails. An unobserved stop
        // must never be published as an effective one.
        set_test_windows_termination_results(vec![TestWindowsTerminationResult::OpenProcess(
            false,
        )]);
        let attempt = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: false,
            }
        );
        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            Some(CancellationRecord {
                cause: Some(SyncCancelCause::UserStop),
                termination_effected: false,
            })
        );
        assert_eq!(
            child.try_wait().expect("probe the surviving fixture child"),
            None,
            "an ineffective cancellation must leave the child running"
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(1),
                None,
                Some(SyncCancelCause::UserStop),
                false,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
            "without an observed effective termination the exit must stay alertable"
        );

        set_test_windows_termination_results(Vec::new());
        let _ = child.kill();
        let _ = child.wait();
        let _ = deregister_generation(&handle, generation);
        clear_cancellation_record(&handle, generation);
        clear_test_job_assignment(&handle);
    }

    #[test]
    fn windows_attachment_failure_runs_the_production_runner_to_a_cancelled_code_one_exit() {
        let handle = format!("windows-attach-failure-runner-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register test generation");
        force_test_job_assignment(&handle, TestJobAssignmentOutcome::AssignFailed);

        let spawn = SpawnArgs {
            cmd: "cmd.exe".to_string(),
            args: long_lived_ping(),
            cwd: None,
            env: None,
        };
        let (finished_tx, finished_rx) = mpsc::channel();
        let runner_handle = handle.clone();
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let outcome = run_process_impl(&runner_handle, &spawn, |event| {
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
                        cancellation_record_for_generation(&runner_handle, generation),
                    ));
                }
            });
            let _ = finished_tx.send((outcome.is_ok(), terminal));
        });

        assert!(
            wait_until(Duration::from_secs(30), || lookup_pid(&handle).is_some()),
            "the production runner must attach its child pid"
        );
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

        let (ran, terminal) = finished_rx
            .recv_timeout(Duration::from_secs(60))
            .expect("the production runner must finish within its deadline");
        runner.join().expect("runner thread must not panic");
        assert!(
            ran,
            "the production runner must complete without a process error"
        );
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
            )),
            "an unattached Job Object must still yield a suppressible app cancellation"
        );
        clear_test_job_assignment(&handle);
    }
}

#[cfg(test)]
mod registry_exit_order_tests {
    use super::*;

    #[cfg(any(unix, target_os = "windows"))]
    fn long_running_spawn() -> SpawnArgs {
        #[cfg(unix)]
        {
            SpawnArgs {
                cmd: "sh".to_string(),
                args: vec!["-c".to_string(), "exec sleep 30".to_string()],
                cwd: None,
                env: None,
            }
        }
        #[cfg(target_os = "windows")]
        {
            SpawnArgs {
                cmd: "cmd.exe".to_string(),
                args: vec![
                    "/d".to_string(),
                    "/c".to_string(),
                    "ping 127.0.0.1 -n 30 > nul".to_string(),
                ],
                cwd: None,
                env: None,
            }
        }
    }

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

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn ordinary_runner_refuses_stale_generation_attachment_without_touching_replacement() {
        let handle = format!("ordinary-stale-attach-test-{}", Uuid::new_v4());
        let stale = try_register_handle_gen(&handle).expect("stale generation acquires handle");
        assert!(deregister_generation(&handle, stale));
        let replacement =
            try_register_handle_gen(&handle).expect("replacement generation acquires handle");

        let mut events = Vec::new();
        let error =
            run_process_impl_for_generation(&handle, stale, &long_running_spawn(), |event| {
                events.push(event)
            })
            .expect_err("stale generation must be refused after its child spawns");

        assert!(matches!(
            error,
            ProcessError::OwnershipLost { generation, .. } if generation == stale
        ));
        assert!(events.is_empty());
        assert_eq!(generation_for_handle(&handle), Some(replacement));
        assert_eq!(lookup_pid(&handle), None);
        assert!(deregister_generation(&handle, replacement));
    }

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn stdin_runner_refuses_stale_generation_attachment_without_touching_replacement() {
        let handle = format!("stdin-stale-attach-test-{}", Uuid::new_v4());
        let stale = try_register_handle_gen(&handle).expect("stale generation acquires handle");
        assert!(deregister_generation(&handle, stale));
        let replacement =
            try_register_handle_gen(&handle).expect("replacement generation acquires handle");
        let on_spawn_called = AtomicBool::new(false);

        let error = run_process_with_stdin_impl_for_generation(
            &handle,
            stale,
            &long_running_spawn(),
            |_| {},
            |_| on_spawn_called.store(true, Ordering::Release),
        )
        .expect_err("stale stdin generation must be refused after its child spawns");

        assert!(matches!(
            error,
            ProcessError::OwnershipLost { generation, .. } if generation == stale
        ));
        assert!(!on_spawn_called.load(Ordering::Acquire));
        assert_eq!(generation_for_handle(&handle), Some(replacement));
        assert_eq!(lookup_pid(&handle), None);
        assert!(deregister_generation(&handle, replacement));
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

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn terminal_observation_refuses_a_late_cancellation() {
        let handle = format!("terminal-before-cancel-test-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register generation");
        #[cfg(unix)]
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "exit 1".to_string()],
            cwd: None,
            env: None,
        };
        #[cfg(target_os = "windows")]
        let spawn = SpawnArgs {
            cmd: "cmd.exe".to_string(),
            args: vec!["/d".to_string(), "/c".to_string(), "exit /b 1".to_string()],
            cwd: None,
            env: None,
        };

        let mut late_cancellation = None;
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit { code, .. } = event {
                assert_eq!(code, Some(1));
                let attempt = cancel_process_for_generation(
                    &handle,
                    generation,
                    SyncCancelCause::UserStop,
                    Duration::ZERO,
                );
                late_cancellation = Some((
                    attempt,
                    cancellation_record_for_generation(&handle, generation),
                ));
            }
        })
        .expect("natural code-one child should reach its terminal callback");

        assert_eq!(
            late_cancellation,
            Some((CancellationAttempt::default(), None)),
            "a cancellation observed after the terminal status cannot own that exit"
        );
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

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn publication_precedes_the_cancelled_mark_and_attached_child_is_terminated() {
        let handle = format!("publication-order-test-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register generation");
        let spawn = long_running_spawn();
        let mut command = build_spawn_command(&spawn.cmd, &spawn.args);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        put_in_own_process_group(&mut command);
        let mut child = command.spawn().expect("spawn publication-race fixture");
        let child_pid = child.id();
        let (target, _) = prepare_termination_target(&handle, generation, &child);
        let (published_tx, published_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let handle_in_thread = handle.clone();
        let canceller = thread::spawn(move || {
            let attempt = cancel_registered_generation_with(
                &handle_in_thread,
                generation,
                Some(SyncCancelCause::TimeoutWatchdog),
                Duration::ZERO,
                || {
                    published_tx.send(()).expect("announce publication");
                    resume_rx
                        .recv_timeout(Duration::from_secs(10))
                        .expect("attachment must release publication barrier");
                },
                |target| {
                    assert_eq!(target.pid, Some(child_pid));
                    terminate_target(target)
                },
            );
            done_tx.send(attempt).expect("return cancellation attempt");
        });

        published_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("canceller must publish before marking");
        {
            let state = cancellation_records().0.lock().unwrap();
            assert!(state.records.contains_key(&(handle.clone(), generation)));
            assert!(state
                .pending_publications
                .contains(&(handle.clone(), generation)));
        }
        assert!(!cancellation_requested_for_generation(&handle, generation));

        let owns_publication = begin_effect_publication_if_record(&handle, generation);
        assert!(
            !owns_publication,
            "the active canceller retains publication ownership"
        );
        assert!(matches!(
            attach_prepared_process(
                &handle,
                Some(generation),
                target,
                owns_publication,
            ),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));

        resume_tx.send(()).expect("resume canceller");
        let attempt = done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("canceller must finish after attachment");
        canceller.join().expect("canceller thread must not panic");
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: true,
            }
        );
        let status = child.wait().expect("reap publication-race fixture");
        assert!(
            !status.success(),
            "the attached child must actually terminate"
        );
        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            Some(CancellationRecord {
                cause: Some(SyncCancelCause::TimeoutWatchdog),
                termination_effected: true,
            })
        );

        assert!(deregister_generation(&handle, generation));
        clear_cancellation_record(&handle, generation);
    }

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn cancelled_mark_cannot_race_attachment_before_publication_completes() {
        let handle = format!("cancelled-mark-attach-race-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("register generation");
        let spawn = long_running_spawn();
        let mut command = build_spawn_command(&spawn.cmd, &spawn.args);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        put_in_own_process_group(&mut command);
        let mut child = command.spawn().expect("spawn cancellation-race fixture");
        let (target, _) = prepare_termination_target(&handle, generation, &child);

        let (published_tx, published_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let cancel_handle = handle.clone();
        let canceller = thread::spawn(move || {
            let attempt = cancel_registered_generation_with(
                &cancel_handle,
                generation,
                Some(SyncCancelCause::TimeoutWatchdog),
                Duration::ZERO,
                || {
                    published_tx.send(()).expect("announce publication");
                    resume_rx
                        .recv_timeout(Duration::from_secs(10))
                        .expect("test must resume cancellation");
                },
                terminate_target,
            );
            done_tx.send(attempt).expect("return cancellation result");
        });

        published_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("cancellation must publish its cause before marking");

        // The spawner first observes the already-pending record, then pauses
        // before attachment. Hold completion after the canceller marks the
        // generation so the attachment sees exactly that stale observation.
        let owns_publication = begin_effect_publication_if_record(&handle, generation);
        assert!(
            !owns_publication,
            "the in-flight cancellation must retain publication ownership"
        );
        let (records, _) = &**cancellation_records();
        let publication_guard = records.lock().unwrap();
        resume_tx
            .send(())
            .expect("resume canceller so it can mark the generation");
        let marked = (0..100).any(|_| {
            if cancellation_requested_for_generation(&handle, generation) {
                true
            } else {
                thread::sleep(Duration::from_millis(10));
                false
            }
        });
        assert!(marked, "canceller must mark before attachment races it");

        let outcome = attach_prepared_process(&handle, Some(generation), target, owns_publication);
        drop(publication_guard);

        let initial_attempt = done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("pending cancellation must finish publishing");
        canceller.join().expect("canceller thread must not panic");
        assert!(initial_attempt.executed);

        let attached_was_claimed = matches!(&outcome, ProcessAttachOutcome::Cancelled { .. });
        match outcome {
            ProcessAttachOutcome::Cancelled {
                target,
                attribution_allowed,
                ..
            } => {
                assert!(terminate_claimed_target_with(
                    &handle,
                    generation,
                    target,
                    attribution_allowed,
                    terminate_target,
                ));
            }
            ProcessAttachOutcome::Attached { .. } => {
                // Keep the RED test leak-free on the buggy implementation.
                let target = process_registry()
                    .lock()
                    .unwrap()
                    .get_mut(&handle)
                    .and_then(|entry| entry.termination_target.take())
                    .expect("attached fixture must retain a cleanup target");
                let _ = terminate_target(target);
            }
            ProcessAttachOutcome::RefusedStale { target, .. } => {
                let _ = terminate_target(target);
            }
        }
        let _ = child.wait().expect("reap cancellation-race fixture");
        let _ = deregister_generation(&handle, generation);
        clear_cancellation_record(&handle, generation);

        assert!(
            attached_was_claimed,
            "a marked generation must transfer the child to process-layer cancellation even while publication is pending"
        );
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

/// A cancelled run's SIGKILL escalation fires on its own thread after a delay,
/// by which time the public handle may already belong to a replacement run. The
/// base app gated that escalation on the handle alone and then deregistered by
/// handle, so a stale escalation could signal and evict its successor. These
/// regressions drive real children through the production escalation with the
/// interleaving established rather than raced.
#[cfg(all(test, unix))]
mod cross_generation_escalation_tests {
    use super::*;
    use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
    use std::process::Command as StdCommand;

    const SIGTERM_STATUS: i32 = 15;
    const SIGKILL_STATUS: i32 = 9;

    /// Probe existence without delivering a signal. True while the pid is live
    /// OR an unreaped zombie, so callers reap before asserting absence.
    fn alive(pid: u32) -> bool {
        signal::kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    fn wait_until(deadline: Duration, mut ready: impl FnMut() -> bool) -> bool {
        let start = std::time::Instant::now();
        loop {
            if ready() {
                return true;
            }
            if start.elapsed() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    enum SigtermPolicy {
        /// Dies on the cancellation's own SIGTERM.
        Obey,
        /// Survives SIGTERM, so only the escalation can end it.
        Ignore,
    }

    /// Spawn a real process-group leader and attach it through the production
    /// path, exactly as `run_process_impl` does for a sync runner.
    fn spawn_attached_generation(
        handle: &str,
        generation: u64,
        policy: SigtermPolicy,
        ready_marker: &std::path::Path,
    ) -> std::process::Child {
        let marker = ready_marker.display();
        let script = match policy {
            SigtermPolicy::Obey => format!(": > '{marker}'; exec sleep 30"),
            // Readiness is published only after the trap is installed, so the
            // cancellation below can never race the handler into place.
            SigtermPolicy::Ignore => {
                format!("trap '' TERM; : > '{marker}'; while :; do sleep 1; done")
            }
        };
        let child = StdCommand::new("sh")
            .arg("-c")
            .arg(script)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn real generation child");
        let (target, _) = prepare_termination_target(handle, generation, &child);
        assert!(matches!(
            attach_prepared_process(handle, Some(generation), target, false),
            ProcessAttachOutcome::Attached {
                generation: attached
            } if attached == generation
        ));
        assert!(
            wait_until(Duration::from_secs(30), || ready_marker.exists()),
            "the fixture child must publish readiness before it is cancelled"
        );
        child
    }

    #[test]
    fn stale_escalation_cannot_signal_or_deregister_a_handle_replacement() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let handle = format!("cross-generation-escalation-{}", Uuid::new_v4());

        let first = try_register_handle_gen(&handle).expect("generation A acquires the handle");
        let mut child_a = spawn_attached_generation(
            &handle,
            first,
            SigtermPolicy::Obey,
            &tmp.path().join("ready-a"),
        );
        let pid_a = child_a.id();

        // Hold A's escalation before it reads ownership, so the replacement is
        // established first and the interleaving is proven, never raced.
        arm_test_escalation_gate(&handle, first);
        let attempt = cancel_process_for_generation(
            &handle,
            first,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: true,
            }
        );

        // A really ends on its own SIGTERM, is reaped, and releases the handle.
        let status_a = child_a.wait().expect("reap generation A");
        assert_eq!(status_a.signal(), Some(SIGTERM_STATUS));
        assert!(deregister_generation(&handle, first));

        let second =
            try_register_handle_gen(&handle).expect("generation B acquires the same public handle");
        assert_ne!(second, first);
        let mut child_b = spawn_attached_generation(
            &handle,
            second,
            SigtermPolicy::Obey,
            &tmp.path().join("ready-b"),
        );
        let pid_b = child_b.id();
        assert_ne!(pid_b, pid_a);

        release_test_escalation_gate(&handle, first);
        assert_eq!(
            await_test_escalation_outcome(&handle, first, Duration::from_secs(60)),
            Some(TestEscalationOutcome::NotCancelled),
            "generation A's escalation must read its own ownership and stop without signalling"
        );

        // B is untouched: still the registered owner, uncancelled, unsignalled.
        assert_eq!(generation_for_handle(&handle), Some(second));
        assert!(!is_cancelled_for_generation(&handle, second));
        assert_eq!(cancellation_record_for_generation(&handle, second), None);
        assert_eq!(lookup_pid(&handle), Some(pid_b));
        assert_eq!(
            child_b.try_wait().expect("probe generation B"),
            None,
            "a stale escalation must never signal the replacement's process group"
        );
        assert!(alive(pid_b));

        // A's own evidence survives untouched and is never credited to B.
        assert_eq!(
            cancellation_record_for_generation(&handle, first),
            Some(CancellationRecord {
                cause: Some(SyncCancelCause::UserStop),
                termination_effected: true,
            })
        );

        // Tear B down normally and prove the handle, the registry entry, and
        // both cancellation records are fully released.
        let _ = child_b.kill();
        let _ = child_b.wait();
        assert!(deregister_generation(&handle, second));
        clear_cancellation_record(&handle, first);
        clear_test_escalation(&handle, first);
        assert_eq!(generation_for_handle(&handle), None);
        assert_eq!(cancellation_record_for_generation(&handle, first), None);

        let third =
            try_register_handle_gen(&handle).expect("a clean generation reuses the freed handle");
        assert_ne!(third, second);
        assert!(deregister_generation(&handle, third));
        assert_eq!(generation_for_handle(&handle), None);
    }

    #[test]
    fn escalation_still_sigkills_the_generation_it_actually_owns() {
        // Without this control the guard above could pass simply because the
        // escalation never works at all.
        let tmp = tempfile::tempdir().expect("tempdir");
        let handle = format!("owned-generation-escalation-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("generation acquires the handle");
        let mut child = spawn_attached_generation(
            &handle,
            generation,
            SigtermPolicy::Ignore,
            &tmp.path().join("ready"),
        );
        let pid = child.id();

        arm_test_escalation_gate(&handle, generation);
        let attempt = cancel_process_for_generation(
            &handle,
            generation,
            SyncCancelCause::AppQuit,
            Duration::ZERO,
        );
        assert_eq!(
            attempt,
            CancellationAttempt {
                executed: true,
                termination_effected: true,
            }
        );
        assert_eq!(
            child.try_wait().expect("probe the SIGTERM-immune child"),
            None,
            "the fixture must survive SIGTERM so only the escalation can end it"
        );

        release_test_escalation_gate(&handle, generation);
        assert_eq!(
            await_test_escalation_outcome(&handle, generation, Duration::from_secs(60)),
            Some(TestEscalationOutcome::Signalled { effected: true }),
            "an escalation that still owns its generation must signal it"
        );

        let status = child.wait().expect("reap the escalated child");
        assert_eq!(status.signal(), Some(SIGKILL_STATUS));
        assert!(wait_until(Duration::from_secs(30), || !alive(pid)));

        assert!(deregister_generation(&handle, generation));
        clear_cancellation_record(&handle, generation);
        clear_test_escalation(&handle, generation);
        assert_eq!(generation_for_handle(&handle), None);
        assert_eq!(
            cancellation_record_for_generation(&handle, generation),
            None
        );
    }
}
