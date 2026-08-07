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

    pub fn is_ownership_lost(&self) -> bool {
        matches!(self, Self::OwnershipLost { .. })
    }

    pub fn ownership_cleanup_failed(&self) -> bool {
        matches!(
            self,
            Self::OwnershipLost {
                cleanup_error: Some(_),
                ..
            }
        )
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
                    "process generation {generation} was discarded while attaching to handle {handle}"
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

struct ProcessEntry {
    /// Monotonic ownership token for this handle registration. A handle string
    /// and a numeric PID are both reusable; their pair is not an ownership
    /// proof once a stale cleanup or escalation is scheduled.
    generation: u64,
    pid: Option<u32>,
    cancelled: bool,
    /// Published before Unix reaping makes `pid` / its process group reusable.
    /// Every registry-driven Unix signal checks this while holding the same
    /// mutex, so a later dispatch cannot target a recycled identity.
    signal_authority_revoked: bool,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

impl ProcessEntry {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            pid: None,
            cancelled: false,
            signal_authority_revoked: false,
            #[cfg(target_os = "windows")]
            job_handle: None,
        }
    }
}

struct RetiredProcessEntry {
    handle: String,
    entry: ProcessEntry,
}

#[derive(Default)]
struct ProcessRegistry {
    /// The one generation that currently owns each public handle.
    active: HashMap<String, ProcessEntry>,
    /// Generations whose public handle was released before their wait owner
    /// finished. Keeping their full entry preserves delayed escalation and
    /// cancellation evidence without exposing a replacement generation.
    retired: HashMap<u64, RetiredProcessEntry>,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<ProcessRegistry>>> = OnceLock::new();
static NEXT_PROCESS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Raised at the single application-exit choke point before child teardown.
/// The daemon reads this as exit evidence; it does not alter cancellation or
/// crash classification.
static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn app_exit_requested() -> bool {
    APP_EXIT_REQUESTED.load(Ordering::Acquire)
}

fn process_registry() -> &'static Arc<Mutex<ProcessRegistry>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(ProcessRegistry::default())))
}

fn entry_for_generation<'a>(
    registry: &'a ProcessRegistry,
    handle: &str,
    generation: u64,
) -> Option<&'a ProcessEntry> {
    registry
        .active
        .get(handle)
        .filter(|entry| entry.generation == generation)
        .or_else(|| {
            registry
                .retired
                .get(&generation)
                .filter(|retired| retired.handle == handle)
                .map(|retired| &retired.entry)
        })
}

fn entry_for_generation_mut<'a>(
    registry: &'a mut ProcessRegistry,
    handle: &str,
    generation: u64,
) -> Option<&'a mut ProcessEntry> {
    let active_matches = registry
        .active
        .get(handle)
        .is_some_and(|entry| entry.generation == generation);
    if active_matches {
        return registry.active.get_mut(handle);
    }
    registry
        .retired
        .get_mut(&generation)
        .filter(|retired| retired.handle == handle)
        .map(|retired| &mut retired.entry)
}

fn next_process_generation() -> u64 {
    let generation = NEXT_PROCESS_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    assert_ne!(generation, 0, "process registration generations exhausted");
    generation
}

/// Register a fresh generation without changing the legacy public helper's
/// signature. This intentionally retains `pre_register_handle`'s overwrite
/// semantics for its small set of pre-spawn callers.
pub fn pre_register_handle_gen(handle: &str) -> u64 {
    let generation = next_process_generation();
    process_registry()
        .lock()
        .unwrap()
        .active
        .insert(handle.to_string(), ProcessEntry::new(generation));
    generation
}

pub fn pre_register_handle(handle: &str) {
    let _ = pre_register_handle_gen(handle);
}

/// Atomically check-and-register a handle, returning the exact generation that
/// acquired it. Deferred cleanup must retain this value rather than looking a
/// handle up after it might have been reused.
pub fn try_register_handle_gen(handle: &str) -> Option<u64> {
    use std::collections::hash_map::Entry;
    let mut reg = process_registry().lock().unwrap();
    match reg.active.entry(handle.to_string()) {
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

/// Return the current generation while it is still registered. This is a
/// snapshot only; any actor that mutates state must pass the returned value
/// back to a generation-checked operation.
pub fn generation_for_handle(handle: &str) -> Option<u64> {
    process_registry()
        .lock()
        .unwrap()
        .active
        .get(handle)
        .map(|entry| entry.generation)
}

/// Attach a PID to the active generation and return that generation. Existing
/// callers retain `register_process` below; wait owners use this return value
/// to ensure their late cleanup cannot remove a replacement.
pub fn register_process_gen(handle: &str, pid: u32) -> u64 {
    let mut containment = ChildContainment::default();
    register_process_gen_with_containment(handle, pid, &mut containment)
}

fn register_process_gen_with_containment(
    handle: &str,
    pid: u32,
    containment: &mut ChildContainment,
) -> u64 {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.active.get_mut(handle) {
        entry.pid = Some(pid);
        containment.attach_to_entry(entry);
        entry.generation
    } else {
        let generation = next_process_generation();
        let mut entry = ProcessEntry::new(generation);
        entry.pid = Some(pid);
        containment.attach_to_entry(&mut entry);
        reg.active.insert(handle.to_string(), entry);
        generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessAttachOutcome {
    Attached,
    Cancelled,
    RefusedStale,
}

/// Attach `pid` only if the exact pre-spawn registration still owns `handle`.
/// A cancellation that won the same lock ordering records the PID but refuses
/// startup so the runner can terminate and reap that child before cleanup. A
/// stale runner must never overwrite a replacement generation's PID.
fn register_process_for_generation(
    handle: &str,
    generation: u64,
    pid: u32,
) -> ProcessAttachOutcome {
    let mut containment = ChildContainment::default();
    register_process_for_generation_with_containment(handle, generation, pid, &mut containment)
}

fn register_process_for_generation_with_containment(
    handle: &str,
    generation: u64,
    pid: u32,
    containment: &mut ChildContainment,
) -> ProcessAttachOutcome {
    let mut registry = process_registry().lock().unwrap();
    let Some(entry) = registry
        .active
        .get_mut(handle)
        .filter(|entry| entry.generation == generation)
    else {
        return ProcessAttachOutcome::RefusedStale;
    };
    if entry.signal_authority_revoked || entry.pid.is_some() {
        return ProcessAttachOutcome::RefusedStale;
    }
    entry.pid = Some(pid);
    if entry.cancelled {
        ProcessAttachOutcome::Cancelled
    } else {
        containment.attach_to_entry(entry);
        ProcessAttachOutcome::Attached
    }
}

pub fn register_process(handle: &str, pid: u32) {
    let _ = register_process_gen(handle, pid);
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
    let removed = process_registry().lock().unwrap().active.remove(handle);
    if let Some(entry) = removed {
        close_process_entry(entry);
    }
}

/// Release only `generation`'s public handle. If its wait owner has not yet
/// revoked signal authority, retain the full generation privately until that
/// owner completes. This lets a delayed escalation kill the old child without
/// ever resolving through a replacement generation's handle.
pub fn deregister_generation(handle: &str, generation: u64) -> bool {
    let (removed, matched) = {
        let mut reg = process_registry().lock().unwrap();
        let active_matches = reg
            .active
            .get(handle)
            .is_some_and(|entry| entry.generation == generation);
        if active_matches {
            let entry = reg
                .active
                .remove(handle)
                .expect("matching active generation must remain present");
            if entry.pid.is_some() && !entry.signal_authority_revoked {
                let replaced = reg.retired.insert(
                    generation,
                    RetiredProcessEntry {
                        handle: handle.to_string(),
                        entry,
                    },
                );
                debug_assert!(replaced.is_none(), "process generation must be unique");
                (None, true)
            } else {
                (Some(entry), true)
            }
        } else if reg
            .retired
            .get(&generation)
            .is_some_and(|retired| retired.handle == handle)
        {
            let retired = reg
                .retired
                .remove(&generation)
                .expect("matching retired generation must remain present");
            (Some(retired.entry), true)
        } else {
            (None, false)
        }
    };
    if let Some(entry) = removed {
        close_process_entry(entry);
    }
    matched
}

pub fn lookup_pid(handle: &str) -> Option<u32> {
    process_registry()
        .lock()
        .unwrap()
        .active
        .get(handle)
        .and_then(|e| e.pid)
}

pub fn is_registered(handle: &str) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .active
        .contains_key(handle)
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
        .active
        .get(handle)
        .map(|e| e.cancelled)
        .unwrap_or(false)
}

/// Generation-aware cancellation lookup for owners that can outlive a handle
/// reuse (notably the daemon watcher callback).
pub fn is_cancelled_for_generation(handle: &str, generation: u64) -> bool {
    let registry = process_registry().lock().unwrap();
    entry_for_generation(&registry, handle, generation)
        .map(|entry| entry.cancelled)
        .unwrap_or(false)
}

#[cfg(test)]
fn mark_cancelled(handle: &str) -> bool {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.active.get_mut(handle) {
        entry.cancelled = true;
        true
    } else {
        false
    }
}

fn revoke_signal_authority_for_generation(handle: &str, generation: u64) -> bool {
    let mut reg = process_registry().lock().unwrap();
    entry_for_generation_mut(&mut reg, handle, generation)
        .map(|entry| revoke_signal_authority_locked(entry, generation))
        .unwrap_or(false)
}

fn revoke_signal_authority_locked(entry: &mut ProcessEntry, generation: u64) -> bool {
    if entry.generation != generation {
        return false;
    }
    entry.signal_authority_revoked = true;
    true
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

// Test-only spawn boundary used by the real-child ownership regressions. Hooks
// are keyed by handle so parallel process tests cannot consume one another's
// synchronization point.
#[cfg(test)]
type TestPostSpawnHook = Box<dyn FnOnce(&std::process::Child) + Send + 'static>;

#[cfg(test)]
fn test_post_spawn_hooks() -> &'static Mutex<HashMap<String, TestPostSpawnHook>> {
    static HOOKS: OnceLock<Mutex<HashMap<String, TestPostSpawnHook>>> = OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_test_post_spawn_hook<F>(handle: &str, hook: F)
where
    F: FnOnce(&std::process::Child) + Send + 'static,
{
    test_post_spawn_hooks()
        .lock()
        .unwrap()
        .insert(handle.to_string(), Box::new(hook));
}

#[cfg(test)]
fn run_test_post_spawn_hook(handle: &str, child: &std::process::Child) {
    let hook = test_post_spawn_hooks().lock().unwrap().remove(handle);
    if let Some(hook) = hook {
        hook(child);
    }
}

#[cfg(not(test))]
fn run_test_post_spawn_hook(_handle: &str, _child: &std::process::Child) {}

#[cfg(test)]
fn test_stale_cleanup_failures() -> &'static Mutex<HashMap<String, io::ErrorKind>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, io::ErrorKind>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_test_stale_cleanup_failure(handle: &str, kind: io::ErrorKind) {
    test_stale_cleanup_failures()
        .lock()
        .unwrap()
        .insert(handle.to_string(), kind);
}

#[cfg(test)]
fn take_test_stale_cleanup_failure(handle: &str) -> Option<io::Error> {
    test_stale_cleanup_failures()
        .lock()
        .unwrap()
        .remove(handle)
        .map(|kind| io::Error::new(kind, "injected stale-child cleanup failure"))
}

#[cfg(test)]
type TestDegradedWaitHook = Box<dyn FnOnce() + Send + 'static>;

#[cfg(test)]
fn test_degraded_wait_hooks() -> &'static Mutex<HashMap<String, TestDegradedWaitHook>> {
    static HOOKS: OnceLock<Mutex<HashMap<String, TestDegradedWaitHook>>> = OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_test_degraded_wait_hook<F>(handle: &str, hook: F)
where
    F: FnOnce() + Send + 'static,
{
    test_degraded_wait_hooks()
        .lock()
        .unwrap()
        .insert(handle.to_string(), Box::new(hook));
}

#[cfg(test)]
fn run_test_degraded_wait_hook(handle: &str) {
    let hook = test_degraded_wait_hooks().lock().unwrap().remove(handle);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(not(test))]
fn run_test_degraded_wait_hook(_handle: &str) {}

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

#[derive(Default)]
struct ChildContainment {
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

impl ChildContainment {
    /// Put the child in a private kill-on-close job immediately after spawn,
    /// before any ownership decision can reject it. Descendants created while
    /// the spawn actor is checking its generation therefore inherit the same
    /// containment instead of escaping a later direct-parent cleanup.
    fn establish(handle: &str, child: &std::process::Child) -> Self {
        let mut containment = Self::default();
        #[cfg(target_os = "windows")]
        unsafe {
            let proc_handle = HANDLE(child.as_raw_handle());
            match create_kill_on_close_job() {
                Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                    Ok(()) => containment.job_handle = Some(job.0 as isize),
                    Err(error) => {
                        let _ = CloseHandle(job);
                        eprintln!(
                            "[process] AssignProcessToJobObject failed for handle {handle}: {error}"
                        );
                    }
                },
                Err(error) => {
                    eprintln!(
                        "[process] create_kill_on_close_job failed for handle {handle}: {error}"
                    );
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = (handle, child);
        containment
    }

    fn attach_to_entry(&mut self, entry: &mut ProcessEntry) {
        #[cfg(target_os = "windows")]
        {
            if let Some(job) = self.job_handle.take() {
                debug_assert!(entry.job_handle.is_none());
                entry.job_handle = Some(job);
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = entry;
    }

    /// Terminate a still-private Windows process tree. On other platforms the
    /// process-group cleanup below remains authoritative.
    fn terminate_tree(&mut self, handle: &str) -> bool {
        #[cfg(target_os = "windows")]
        {
            let Some(job) = self.job_handle.take() else {
                return false;
            };
            let job_handle = HANDLE(job as *mut std::ffi::c_void);
            let terminated = unsafe {
                match TerminateJobObject(job_handle, 1) {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!(
                            "[process] failed to terminate private stale-child job for handle {handle}: {error}"
                        );
                        false
                    }
                }
            };
            unsafe {
                if let Err(error) = CloseHandle(job_handle) {
                    eprintln!(
                        "[process] failed to close private stale-child job for handle {handle}: {error}"
                    );
                }
            }
            terminated
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = handle;
            false
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ChildContainment {
    fn drop(&mut self) {
        if let Some(job) = self.job_handle.take() {
            unsafe {
                if let Err(error) = CloseHandle(HANDLE(job as *mut std::ffi::c_void)) {
                    eprintln!("[process] failed to close pending child Job Object: {error}");
                }
            }
        }
    }
}

/// Terminate and reap a child whose spawn actor no longer owns the public
/// handle. Cleanup uses the still-owned `Child` identity directly and must not
/// inspect or mutate the replacement registered under the same handle.
fn terminate_stale_spawn(
    handle: &str,
    child: &mut std::process::Child,
    containment: &mut ChildContainment,
) -> io::Result<()> {
    #[cfg(test)]
    if let Some(error) = take_test_stale_cleanup_failure(handle) {
        return Err(error);
    }

    close_child_pipes(child);

    let already_reaped = if containment.terminate_tree(handle) {
        false
    } else {
        #[cfg(unix)]
        {
            match signal::kill(Pid::from_raw(-(child.id() as i32)), Signal::SIGKILL) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => false,
                Err(error) => {
                    eprintln!(
                        "[process] failed to terminate stale process group {}: {error}; falling back to direct child kill",
                        child.id()
                    );
                    kill_child_directly_or_confirm_exited(child)?
                }
            }
        }

        #[cfg(not(unix))]
        {
            kill_child_directly_or_confirm_exited(child)?
        }
    };

    if already_reaped {
        Ok(())
    } else {
        child.wait().map(|_| ())
    }
}

fn close_child_pipes(child: &mut std::process::Child) {
    drop(child.stdin.take());
    drop(child.stdout.take());
    drop(child.stderr.take());
}

/// Terminate a child whose PID was attached to `generation` without opening a
/// signal-after-reap window. The SIGKILL uses the checked registry authority,
/// and the shared terminal wait publishes revocation before it reaps.
#[cfg(unix)]
fn terminate_registered_spawn(
    child: &mut std::process::Child,
    handle: &str,
    generation: u64,
) -> io::Result<()> {
    close_child_pipes(child);
    let outcome = dispatch_signal_checked(handle, generation, child.id(), Signal::SIGKILL);
    let already_reaped = match outcome {
        SignalDispatch::Delivered | SignalDispatch::Esrch => false,
        SignalDispatch::RefusedStale | SignalDispatch::RefusedRevoked => {
            kill_child_directly_or_confirm_exited(child)?
        }
        SignalDispatch::Failed(_) => {
            kill_registered_child_directly_or_confirm_exited(child, handle, generation)?
        }
    };
    if already_reaped {
        Ok(())
    } else {
        wait_for_terminal_status(child, handle, generation).map(|_| ())
    }
}

#[cfg(unix)]
fn kill_registered_child_directly_or_confirm_exited(
    child: &mut std::process::Child,
    handle: &str,
    generation: u64,
) -> io::Result<bool> {
    match child.kill() {
        Ok(()) => Ok(false),
        Err(kill_error) => {
            let mut registry = process_registry().lock().unwrap();
            match child.try_wait() {
                Ok(Some(_)) => {
                    if let Some(entry) = entry_for_generation_mut(&mut registry, handle, generation)
                    {
                        let _ = revoke_signal_authority_locked(entry, generation);
                    }
                    Ok(true)
                }
                Ok(None) => Err(kill_error),
                Err(probe_error) => {
                    if let Some(entry) = entry_for_generation_mut(&mut registry, handle, generation)
                    {
                        let _ = revoke_signal_authority_locked(entry, generation);
                    }
                    Err(io::Error::new(
                        probe_error.kind(),
                        format!(
                            "direct registered-child kill failed: {kill_error}; exit probe also failed: {probe_error}"
                        ),
                    ))
                }
            }
        }
    }
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

fn ownership_lost_after_spawn(
    handle: &str,
    generation: u64,
    mut child: std::process::Child,
    attached_to_registry: bool,
    mut containment: ChildContainment,
) -> ProcessError {
    let cleanup_result = if attached_to_registry {
        #[cfg(unix)]
        {
            terminate_registered_spawn(&mut child, handle, generation)
        }
        #[cfg(not(unix))]
        {
            terminate_stale_spawn(handle, &mut child, &mut containment)
        }
    } else {
        terminate_stale_spawn(handle, &mut child, &mut containment)
    };

    match cleanup_result {
        Ok(()) => {
            if attached_to_registry {
                let _ = revoke_signal_authority_for_generation(handle, generation);
                let _ = deregister_generation(handle, generation);
            }
            ownership_lost_error(handle, generation, None)
        }
        Err(cleanup_error) => {
            spawn_ownership_cleanup_owner(
                handle.to_string(),
                generation,
                child,
                attached_to_registry,
                containment,
            );
            ownership_lost_error(handle, generation, Some(cleanup_error))
        }
    }
}

/// Preserve the sole `Child` wait/reap owner after an immediate stale-child
/// cleanup failure. The background owner retries teardown, then waits even if
/// that retry also fails; it never publishes terminal state for the replacement
/// generation and removes only the exact attached generation it was handed.
fn spawn_ownership_cleanup_owner(
    handle: String,
    generation: u64,
    mut child: std::process::Child,
    attached_to_registry: bool,
    mut containment: ChildContainment,
) {
    thread::spawn(move || {
        let retry = if attached_to_registry {
            #[cfg(unix)]
            {
                terminate_registered_spawn(&mut child, &handle, generation)
            }
            #[cfg(not(unix))]
            {
                terminate_stale_spawn(&handle, &mut child, &mut containment)
            }
        } else {
            terminate_stale_spawn(&handle, &mut child, &mut containment)
        };

        if let Err(retry_error) = retry {
            eprintln!(
                "[process] background stale-child cleanup retry failed for handle {handle} generation {generation}: {retry_error}; retaining wait owner"
            );
            close_child_pipes(&mut child);
            let wait_result = if attached_to_registry {
                wait_for_terminal_status(&mut child, &handle, generation).map(|_| ())
            } else {
                child.wait().map(|_| ())
            };
            if let Err(wait_error) = wait_result {
                eprintln!(
                    "[process] background stale-child wait failed for handle {handle} generation {generation}: {wait_error}"
                );
            }
        }

        if attached_to_registry {
            let _ = revoke_signal_authority_for_generation(&handle, generation);
            let _ = deregister_generation(&handle, generation);
        }
    });
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
// Unix wait / signal-identity boundary
// ─────────────────────────────────────────────────────────────────────────────

/// Wait until `pid` has exited without reaping it. `WNOWAIT` keeps the child
/// zombie (and therefore its PID/process-group identity reserved) until the
/// wait owner publishes revocation under the registry lock and performs the
/// actual `Child::wait`.
#[cfg(unix)]
fn observe_exit_without_reaping(pid: u32) -> io::Result<()> {
    loop {
        #[cfg(test)]
        if let Some(result) = take_test_observation_result() {
            match result {
                Err(error) if error.raw_os_error() == Some(libc::EINTR) => continue,
                result => return result,
            }
        }

        // Safety: `siginfo_t` is an out-parameter for waitid; a zeroed buffer
        // is valid input and libc initializes it before success is observed.
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        // Safety: the PID came from this `Child`; the pointer targets the
        // initialized local output buffer for the duration of the FFI call.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return Err(error);
    }
}

// Test-only observation seam. It deliberately feeds the same helper used by
// the production wait owner so the error lattice cannot diverge into a mocked
// side path.
#[cfg(all(unix, test))]
thread_local! {
    static TEST_OBSERVATION_RESULTS: std::cell::RefCell<std::collections::VecDeque<io::Result<()>>> =
        std::cell::RefCell::new(std::collections::VecDeque::new());
}

#[cfg(all(unix, test))]
fn set_test_observation_results(results: Vec<io::Result<()>>) {
    TEST_OBSERVATION_RESULTS.with(|outcomes| {
        *outcomes.borrow_mut() = results.into();
    });
}

#[cfg(all(unix, test))]
fn take_test_observation_result() -> Option<io::Result<()>> {
    TEST_OBSERVATION_RESULTS.with(|outcomes| outcomes.borrow_mut().pop_front())
}

/// The only Unix reaping path for registry-owned children.
///
/// On successful non-reaping observation, revocation is published before the
/// real reap. If another component has already reaped (`ECHILD`), revocation is
/// still published before bookkeeping. Other observation errors use a
/// lock-scoped `try_wait` loop: it retains cancellation authority while the
/// child still exists, then commits revocation in the same critical section as
/// the reap. There is deliberately no unrevoked plain-`wait` fallback.
#[cfg(unix)]
fn wait_for_terminal_status(
    child: &mut std::process::Child,
    handle: &str,
    generation: u64,
) -> io::Result<ExitStatus> {
    match observe_exit_without_reaping(child.id()) {
        Ok(()) => {
            let _ = revoke_signal_authority_for_generation(handle, generation);
            child.wait()
        }
        Err(error) if error.raw_os_error() == Some(libc::ECHILD) => {
            let _ = revoke_signal_authority_for_generation(handle, generation);
            // This is bookkeeping only. The child identity was already lost, so
            // no registry-driven signal may be sent while this call reports the
            // existing wait error through the normal terminal-event path.
            child.wait()
        }
        Err(observation_error) => {
            eprintln!(
                "[process] waitid observation failed for {handle} generation {generation}: {observation_error}; using lock-scoped try_wait"
            );
            loop {
                let still_running = {
                    let mut registry = process_registry().lock().unwrap();
                    match child.try_wait() {
                        Ok(None) => {
                            run_test_degraded_wait_hook(handle);
                            true
                        }
                        Ok(Some(status)) => {
                            if let Some(entry) =
                                entry_for_generation_mut(&mut registry, handle, generation)
                            {
                                let _ = revoke_signal_authority_locked(entry, generation);
                            }
                            return Ok(status);
                        }
                        Err(error) => {
                            if let Some(entry) =
                                entry_for_generation_mut(&mut registry, handle, generation)
                            {
                                let _ = revoke_signal_authority_locked(entry, generation);
                            }
                            return Err(error);
                        }
                    }
                };
                if still_running {
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
}

#[cfg(not(unix))]
fn wait_for_terminal_status(
    child: &mut std::process::Child,
    handle: &str,
    generation: u64,
) -> io::Result<ExitStatus> {
    let result = child.wait();
    let _ = revoke_signal_authority_for_generation(handle, generation);
    result
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

/// Run a child only while `generation` still owns `handle`.
///
/// The daemon acquires its singleton generation before asynchronous preflight
/// and spawn work. This internal seam lets that original owner be fenced from a
/// replacement that acquired the same public handle in the meantime.
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
                if !deregister_generation(handle, generation) {
                    return Err(ownership_lost_error(handle, generation, None));
                }
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };
    let mut containment = ChildContainment::establish(handle, &child);
    run_test_post_spawn_hook(handle, &child);

    let pid = child.id();
    let generation = if let Some(generation) = pre_registered_generation {
        match register_process_for_generation_with_containment(
            handle,
            generation,
            pid,
            &mut containment,
        ) {
            ProcessAttachOutcome::Attached => generation,
            ProcessAttachOutcome::Cancelled => {
                return Err(ownership_lost_after_spawn(
                    handle,
                    generation,
                    child,
                    true,
                    containment,
                ));
            }
            ProcessAttachOutcome::RefusedStale => {
                return Err(ownership_lost_after_spawn(
                    handle,
                    generation,
                    child,
                    false,
                    containment,
                ));
            }
        }
    } else {
        register_process_gen_with_containment(handle, pid, &mut containment)
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

    let wait_result = wait_for_terminal_status(&mut child, handle, generation);

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
                if !deregister_generation(handle, generation) {
                    return Err(ownership_lost_error(handle, generation, None));
                }
            }
            return Err(ProcessError::Spawn {
                cmd: spawn.cmd.clone(),
                source: e,
            });
        }
    };
    let mut containment = ChildContainment::establish(handle, &child);
    run_test_post_spawn_hook(handle, &child);

    let pid = child.id();
    let generation = if let Some(generation) = pre_registered_generation {
        match register_process_for_generation_with_containment(
            handle,
            generation,
            pid,
            &mut containment,
        ) {
            ProcessAttachOutcome::Attached => generation,
            ProcessAttachOutcome::Cancelled => {
                return Err(ownership_lost_after_spawn(
                    handle,
                    generation,
                    child,
                    true,
                    containment,
                ));
            }
            ProcessAttachOutcome::RefusedStale => {
                return Err(ownership_lost_after_spawn(
                    handle,
                    generation,
                    child,
                    false,
                    containment,
                ));
            }
        }
    } else {
        register_process_gen_with_containment(handle, pid, &mut containment)
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

    let wait_result = wait_for_terminal_status(&mut child, handle, generation);

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

/// Result of a registry-checked Unix signal attempt. Refusals are intentional
/// no-ops: they prove the caller held only a stale or already-reaped identity.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDispatch {
    Delivered,
    RefusedStale,
    RefusedRevoked,
    Esrch,
    Failed(i32),
}

#[cfg(unix)]
fn dispatch_signal_checked_locked<F>(
    entry: &mut ProcessEntry,
    generation: u64,
    pid: u32,
    signal_to_send: Signal,
    dispatch: F,
) -> SignalDispatch
where
    F: FnOnce(Pid, Signal) -> Result<(), nix::errno::Errno>,
{
    if entry.generation != generation || entry.pid != Some(pid) {
        return SignalDispatch::RefusedStale;
    }
    if entry.signal_authority_revoked {
        return SignalDispatch::RefusedRevoked;
    }

    // Keep the OS dispatch in this critical section. The wait owner uses this
    // same mutex to publish revocation before (or atomically with) a reap.
    match dispatch(Pid::from_raw(-(pid as i32)), signal_to_send) {
        Ok(()) => SignalDispatch::Delivered,
        Err(nix::errno::Errno::ESRCH) => {
            entry.signal_authority_revoked = true;
            SignalDispatch::Esrch
        }
        Err(error) => {
            eprintln!(
                "[process] failed to dispatch {signal_to_send:?} for generation {generation} pid {pid}: {error}"
            );
            SignalDispatch::Failed(error as i32)
        }
    }
}

#[cfg(unix)]
fn dispatch_signal_checked_with<F>(
    handle: &str,
    generation: u64,
    pid: u32,
    signal_to_send: Signal,
    dispatch: F,
) -> SignalDispatch
where
    F: FnOnce(Pid, Signal) -> Result<(), nix::errno::Errno>,
{
    let mut registry = process_registry().lock().unwrap();
    let Some(entry) = entry_for_generation_mut(&mut registry, handle, generation) else {
        return SignalDispatch::RefusedStale;
    };
    dispatch_signal_checked_locked(entry, generation, pid, signal_to_send, dispatch)
}

/// Mark a known generation as deliberately cancelled and dispatch its first
/// signal under one lock. App-exit teardown uses this too: it must never turn
/// its own SIGKILL escalation into an uncancelled watcher crash.
#[cfg(unix)]
fn dispatch_cancelled_checked(
    handle: &str,
    generation: u64,
    pid: u32,
    signal_to_send: Signal,
) -> SignalDispatch {
    let mut registry = process_registry().lock().unwrap();
    let Some(entry) = entry_for_generation_mut(&mut registry, handle, generation) else {
        return SignalDispatch::RefusedStale;
    };
    if entry.generation != generation || entry.pid != Some(pid) {
        return SignalDispatch::RefusedStale;
    }
    if entry.signal_authority_revoked {
        return SignalDispatch::RefusedRevoked;
    }
    let was_cancelled = entry.cancelled;
    entry.cancelled = true;
    let outcome =
        dispatch_signal_checked_locked(entry, generation, pid, signal_to_send, signal::kill);
    if matches!(outcome, SignalDispatch::Esrch) && !was_cancelled {
        // A vanished process group was not stopped by this actor. Keep a real
        // external SIGKILL eligible for reporting instead of claiming it as a
        // deliberate teardown after the fact.
        entry.cancelled = false;
    }
    outcome
}

#[cfg(unix)]
fn dispatch_signal_checked(
    handle: &str,
    generation: u64,
    pid: u32,
    signal_to_send: Signal,
) -> SignalDispatch {
    dispatch_signal_checked_with(handle, generation, pid, signal_to_send, signal::kill)
}

pub fn cancel_process_impl(handle: &str, sigkill_delay: Duration) -> bool {
    let Some(generation) = generation_for_handle(handle) else {
        return false;
    };
    cancel_process_generation_impl(handle, generation, sigkill_delay)
}

/// Cancel only the exact registration that scheduled the action.
///
/// Generation-aware daemon actors use this seam so a watchdog or force-clear
/// from generation N cannot retarget a replacement registered as N+1.
pub(crate) fn cancel_process_generation_impl(
    handle: &str,
    generation: u64,
    sigkill_delay: Duration,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut registry = process_registry().lock().unwrap();
        let Some(entry) = registry
            .active
            .get_mut(handle)
            .filter(|entry| entry.generation == generation)
        else {
            return false;
        };
        if entry.signal_authority_revoked {
            return false;
        }
        entry.cancelled = true;

        if let Some(job) = entry.job_handle {
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
        // Mark cancellation, capture the generation, and send SIGTERM under
        // one registry lock. Releasing the lock before dispatch would let the
        // wait owner reap and free this numeric process-group identity first.
        let target = {
            let mut registry = process_registry().lock().unwrap();
            let Some(entry) = registry
                .active
                .get_mut(handle)
                .filter(|entry| entry.generation == generation)
            else {
                return false;
            };
            if entry.signal_authority_revoked {
                return false;
            }
            let Some(pid) = entry.pid else {
                entry.cancelled = true;
                return true;
            };
            let was_cancelled = entry.cancelled;
            entry.cancelled = true;
            let outcome = dispatch_signal_checked_locked(
                entry,
                generation,
                pid,
                Signal::SIGTERM,
                signal::kill,
            );
            if matches!(outcome, SignalDispatch::Esrch) && !was_cancelled {
                entry.cancelled = false;
            }
            (generation, pid, outcome)
        };

        let (generation, pid, outcome) = target;
        if matches!(
            outcome,
            SignalDispatch::RefusedStale | SignalDispatch::RefusedRevoked | SignalDispatch::Esrch
        ) {
            return true;
        }

        let handle_owned = handle.to_string();
        thread::spawn(move || {
            thread::sleep(sigkill_delay);
            let _ = dispatch_signal_checked(&handle_owned, generation, pid, Signal::SIGKILL);
        });

        return true;
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let mut registry = process_registry().lock().unwrap();
        let Some(entry) = registry
            .active
            .get_mut(handle)
            .filter(|entry| entry.generation == generation)
        else {
            return false;
        };
        if entry.signal_authority_revoked {
            return false;
        }
        entry.cancelled = true;
        let _ = sigkill_delay;
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// App-exit teardown
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct RegisteredProcess {
    handle: String,
    pid: u32,
    generation: u64,
}

/// Snapshot every currently-registered child as `(handle, pid)`.
///
/// On Unix, each child is spawned with `.process_group(0)` and leads its own
/// process group. On Windows, the pid is paired with a Job Object handle in the
/// registry so cancellation can terminate the tree.
pub fn registered_pids() -> Vec<(String, u32)> {
    registered_processes()
        .into_iter()
        .map(|entry| (entry.handle, entry.pid))
        .collect()
}

fn registered_processes() -> Vec<RegisteredProcess> {
    process_registry()
        .lock()
        .unwrap()
        .active
        .iter()
        .filter_map(|(handle, entry)| {
            entry.pid.map(|pid| RegisteredProcess {
                handle: handle.clone(),
                pid,
                generation: entry.generation,
            })
        })
        .collect()
}

fn registered_processes_including_retired() -> Vec<RegisteredProcess> {
    let registry = process_registry().lock().unwrap();
    let mut processes: Vec<_> = registry
        .active
        .iter()
        .filter_map(|(handle, entry)| {
            entry.pid.map(|pid| RegisteredProcess {
                handle: handle.clone(),
                pid,
                generation: entry.generation,
            })
        })
        .collect();
    processes.extend(registry.retired.values().filter_map(|retired| {
        retired.entry.pid.map(|pid| RegisteredProcess {
            handle: retired.handle.clone(),
            pid,
            generation: retired.entry.generation,
        })
    }));
    processes
}

/// Re-resolve a legacy `(handle, pid)` snapshot to a generation while holding
/// the registry lock. Mismatched PIDs are stale and are intentionally never
/// signalled during app exit.
fn registered_process_for(handle: &str, pid: u32) -> Option<RegisteredProcess> {
    process_registry()
        .lock()
        .unwrap()
        .active
        .get(handle)
        .filter(|entry| entry.pid == Some(pid))
        .map(|entry| RegisteredProcess {
            handle: handle.to_string(),
            pid,
            generation: entry.generation,
        })
}

#[cfg(unix)]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], grace: Duration) {
    let processes: Vec<_> = pids
        .iter()
        .filter_map(|(handle, pid)| registered_process_for(handle, *pid))
        .collect();
    terminate_registered_processes_for_exit(&processes, grace);
}

#[cfg(unix)]
fn terminate_registered_processes_for_exit(processes: &[RegisteredProcess], grace: Duration) {
    for process in processes {
        let _ = dispatch_cancelled_checked(
            &process.handle,
            process.generation,
            process.pid,
            Signal::SIGTERM,
        );
    }
    if !processes.is_empty() {
        thread::sleep(grace);
    }
    for process in processes {
        let _ = dispatch_signal_checked(
            &process.handle,
            process.generation,
            process.pid,
            Signal::SIGKILL,
        );
        // The matching wait owner performs generation-scoped removal after its
        // terminal callback. Removing here would erase `cancelled` before the
        // reporting boundary can observe this deliberate app-exit teardown.
    }
}

#[cfg(target_os = "windows")]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], _grace: Duration) {
    let processes: Vec<_> = pids
        .iter()
        .filter_map(|(handle, pid)| registered_process_for(handle, *pid))
        .collect();
    terminate_registered_processes_for_exit(&processes, Duration::ZERO);
}

#[cfg(target_os = "windows")]
fn terminate_registered_processes_for_exit(processes: &[RegisteredProcess], _grace: Duration) {
    for process in processes {
        let _ = cancel_process_generation_impl(&process.handle, process.generation, Duration::ZERO);
        let _ = deregister_generation(&process.handle, process.generation);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], _grace: Duration) {
    let processes: Vec<_> = pids
        .iter()
        .filter_map(|(handle, pid)| registered_process_for(handle, *pid))
        .collect();
    terminate_registered_processes_for_exit(&processes, Duration::ZERO);
}

#[cfg(not(any(unix, target_os = "windows")))]
fn terminate_registered_processes_for_exit(processes: &[RegisteredProcess], _grace: Duration) {
    for process in processes {
        let _ = deregister_generation(&process.handle, process.generation);
    }
}

/// Tear down every spawned child on app exit. Call from the app's
/// `RunEvent::ExitRequested` handler so closing HQ Sync (tray Quit, `quit_app`,
/// or Cmd-Q) reliably stops the `--watch` sync daemon and any sidecar instead
/// of orphaning them.
pub fn terminate_all_for_exit(grace: Duration) {
    APP_EXIT_REQUESTED.store(true, Ordering::Release);
    terminate_registered_processes_for_exit(&registered_processes_including_retired(), grace);
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
            let _ = deregister_generation(&handle_bg, generation);
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
    fn stale_spawn_job_contains_descendant_before_ownership_check() {
        use std::sync::atomic::{AtomicU32, Ordering};

        fn powershell_quote(path: &std::path::Path) -> String {
            path.to_string_lossy().replace('\'', "''")
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        let descendant_script = tmp.path().join("descendant.ps1");
        let parent_script = tmp.path().join("parent.ps1");
        let descendant_pid_path = tmp.path().join("descendant.pid");
        std::fs::write(&descendant_script, "Start-Sleep -Seconds 120\r\n")
            .expect("write descendant fixture");
        std::fs::write(
            &parent_script,
            format!(
                "$child = Start-Process -PassThru -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{}')\r\nSet-Content -LiteralPath '{}' -Value $child.Id\r\nWait-Process -Id $child.Id\r\n",
                powershell_quote(&descendant_script),
                powershell_quote(&descendant_pid_path),
            ),
        )
        .expect("write parent fixture");

        let handle = format!("windows-stale-tree-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));
        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");

        let descendant_pid = Arc::new(AtomicU32::new(0));
        let hook_pid = descendant_pid.clone();
        let hook_path = descendant_pid_path.clone();
        set_test_post_spawn_hook(&handle, move |_| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                if let Ok(raw) = std::fs::read_to_string(&hook_path) {
                    if let Ok(pid) = raw.trim().parse::<u32>() {
                        hook_pid.store(pid, Ordering::Release);
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let result = run_process_impl_for_generation(
            &handle,
            stale_generation,
            &SpawnArgs {
                cmd: "powershell.exe".to_string(),
                args: vec![
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-File".to_string(),
                    parent_script.to_string_lossy().into_owned(),
                ],
                cwd: None,
                env: None,
            },
            |_| {},
        );

        assert!(matches!(result, Err(ProcessError::OwnershipLost { .. })));
        let pid = descendant_pid.load(Ordering::Acquire);
        assert_ne!(pid, 0, "the parent fixture must start its descendant");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hq_desktop_core::daemon::is_pid_alive(pid) && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        let descendant_survived = hq_desktop_core::daemon::is_pid_alive(pid);
        if descendant_survived {
            let pid_arg = pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", pid_arg.as_str(), "/T", "/F"])
                .status();
        }

        assert!(
            !descendant_survived,
            "a stale pre-attach child and every descendant must die with its private Job Object"
        );
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert!(deregister_generation(&handle, replacement_generation));
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
    fn stale_generation_cannot_cancel_replacement_before_attach() {
        let handle = format!("stale-cancel-generation-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));

        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");

        assert!(
            !cancel_process_generation_impl(&handle, stale_generation, Duration::ZERO),
            "a stale daemon actor must be refused instead of cancelling the replacement"
        );
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert!(
            !is_cancelled_for_generation(&handle, replacement_generation),
            "the replacement must retain its uncancelled state"
        );

        assert!(deregister_generation(&handle, replacement_generation));
    }

    #[cfg(unix)]
    #[test]
    fn stale_runner_cannot_attach_to_or_cleanup_replacement_generation() {
        let handle = format!("stale-runner-generation-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));

        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            cwd: None,
            env: None,
        };
        let mut events = Vec::new();

        let result = run_process_impl_for_generation(&handle, stale_generation, &spawn, |event| {
            events.push(event)
        });

        assert!(
            matches!(result, Err(ProcessError::OwnershipLost { .. })),
            "a runner whose registration was retired must report ownership loss"
        );
        assert!(
            events.is_empty(),
            "the stale runner must not emit terminal state for the replacement"
        );
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert_eq!(
            lookup_pid(&handle),
            None,
            "the stale child PID must never overwrite the replacement entry"
        );

        assert!(deregister_generation(&handle, replacement_generation));
    }

    #[cfg(unix)]
    #[test]
    fn stale_cleanup_failure_transfers_child_to_background_reaper() {
        let handle = format!("stale-cleanup-owner-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));
        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");

        let tmp = tempfile::tempdir().expect("tempdir");
        let pid_path = tmp.path().join("stale-child.pid");
        let mut env = HashMap::new();
        env.insert(
            "HQ_STALE_CHILD_PID_FILE".to_string(),
            pid_path.to_string_lossy().into_owned(),
        );
        let hook_path = pid_path.clone();
        set_test_post_spawn_hook(&handle, move |_| {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !hook_path.exists() && std::time::Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
        });
        set_test_stale_cleanup_failure(&handle, io::ErrorKind::PermissionDenied);

        let result = run_process_impl_for_generation(
            &handle,
            stale_generation,
            &SpawnArgs {
                cmd: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "trap '' TERM; echo $$ > \"$HQ_STALE_CHILD_PID_FILE\"; while :; do sleep 1; done"
                        .to_string(),
                ],
                cwd: None,
                env: Some(env),
            },
            |_| {},
        );

        assert!(matches!(
            result,
            Err(ProcessError::OwnershipLost {
                cleanup_error: Some(_),
                ..
            })
        ));
        let pid = std::fs::read_to_string(&pid_path)
            .expect("fixture must publish its pid")
            .trim()
            .parse::<i32>()
            .expect("fixture pid must be numeric");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let reaped = loop {
            match signal::kill(Pid::from_raw(pid), None) {
                Err(nix::errno::Errno::ESRCH) => break true,
                _ if std::time::Instant::now() >= deadline => break false,
                _ => thread::sleep(Duration::from_millis(20)),
            }
        };
        if !reaped {
            let _ = signal::kill(Pid::from_raw(-pid), Signal::SIGKILL);
            let mut status = 0;
            unsafe {
                libc::waitpid(pid, &mut status, 0);
            }
        }

        assert!(
            reaped,
            "a failed first cleanup attempt must transfer the Child to a background owner that kills and reaps it"
        );
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert!(deregister_generation(&handle, replacement_generation));
    }

    #[test]
    fn stale_runner_spawn_failure_cannot_retire_replacement_generation() {
        let handle = format!("stale-spawn-failure-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));
        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");
        let spawn = SpawnArgs {
            cmd: format!("/definitely/missing/hq-stale-spawn-{}", Uuid::new_v4()),
            args: Vec::new(),
            cwd: None,
            env: None,
        };

        let result = run_process_impl_for_generation(&handle, stale_generation, &spawn, |_| {});

        assert!(matches!(result, Err(ProcessError::OwnershipLost { .. })));
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert_eq!(lookup_pid(&handle), None);
        assert!(deregister_generation(&handle, replacement_generation));
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_generation_cannot_start_child_after_pre_spawn_cancel() {
        let handle = format!("cancel-before-attach-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("acquire process generation");
        assert!(cancel_process_generation_impl(
            &handle,
            generation,
            Duration::ZERO
        ));
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            cwd: None,
            env: None,
        };
        let mut events = Vec::new();

        let result = run_process_impl_for_generation(&handle, generation, &spawn, |event| {
            events.push(event)
        });

        assert!(matches!(result, Err(ProcessError::OwnershipLost { .. })));
        assert!(events.is_empty());
        assert_eq!(generation_for_handle(&handle), None);
        assert_eq!(lookup_pid(&handle), None);
    }

    #[test]
    fn app_exit_snapshot_includes_active_and_retired_generations() {
        let handle = format!("exit-retired-generation-{}", Uuid::new_v4());
        let retired_generation = pre_register_handle_gen(&handle);
        assert_eq!(
            register_process_for_generation(&handle, retired_generation, u32::MAX - 1),
            ProcessAttachOutcome::Attached
        );
        assert!(deregister_generation(&handle, retired_generation));

        let active_generation = pre_register_handle_gen(&handle);
        assert_eq!(
            register_process_for_generation(&handle, active_generation, u32::MAX),
            ProcessAttachOutcome::Attached
        );

        let snapshot = registered_processes_including_retired();
        assert!(snapshot.iter().any(|process| {
            process.handle == handle
                && process.generation == retired_generation
                && process.pid == u32::MAX - 1
        }));
        assert!(snapshot.iter().any(|process| {
            process.handle == handle
                && process.generation == active_generation
                && process.pid == u32::MAX
        }));

        assert!(revoke_signal_authority_for_generation(
            &handle,
            retired_generation
        ));
        assert!(deregister_generation(&handle, retired_generation));
        assert!(revoke_signal_authority_for_generation(
            &handle,
            active_generation
        ));
        assert!(deregister_generation(&handle, active_generation));
    }

    /// The SIGKILL escalation is a deliberate stop, not a watcher crash.  The
    /// exit callback is the reporting boundary, so the cancellation record has
    /// to remain observable there even when the child ignores SIGTERM and is
    /// eventually killed.
    #[cfg(unix)]
    #[test]
    fn escalation_sigkill_keeps_cancelled_observable_in_exit_callback() {
        let handle = format!("sigkill-cancel-observable-{}", Uuid::new_v4());
        pre_register_handle(&handle);
        // `echo ready` runs only after `trap` returns, so receiving it proves
        // the child is genuinely ignoring SIGTERM. A registered pid does not:
        // the child is registered the moment it is spawned, which is before
        // `sh` has interpreted its first command. Cancelling on that weaker
        // signal races the trap installation, and a SIGTERM that wins reaps the
        // child at signal 15 — the escalation to SIGKILL this test exists to
        // pin then never happens.
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "trap '' TERM; echo ready; while :; do sleep 1; done".to_string(),
            ],
            cwd: None,
            env: None,
        };
        let (ready_tx, ready_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let runner_handle = handle.clone();
        let runner = thread::spawn(move || {
            let callback_handle = runner_handle.clone();
            run_process_impl(&runner_handle, &spawn, move |event| match event {
                ProcessEvent::Stdout(line) if line == "ready" => {
                    ready_tx
                        .send(())
                        .expect("test readiness receiver must remain alive");
                }
                ProcessEvent::Exit { signal, .. } => {
                    let observed = (
                        is_registered(&callback_handle),
                        is_cancelled(&callback_handle),
                    );
                    exit_tx
                        .send((observed, signal))
                        .expect("test receiver must remain alive");
                }
                _ => {}
            })
        });

        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the child must install its SIGTERM trap before cancellation");
        assert!(
            lookup_pid(&handle).is_some(),
            "a child that has reported readiness must still be registered"
        );

        assert!(
            cancel_process_impl(&handle, Duration::from_millis(100)),
            "the registered child must accept cancellation"
        );
        let (observed, signal) = exit_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("the escalation must produce one terminal callback");
        runner
            .join()
            .expect("the process runner thread must not panic")
            .expect("the killed child must still complete the process runner");

        assert_eq!(signal, Some(Signal::SIGKILL as i32));
        assert_eq!(
            observed,
            (true, true),
            "the reporting callback must see the deliberately-cancelled generation"
        );
        assert!(!is_registered(&handle));
    }

    #[cfg(unix)]
    #[test]
    fn checked_dispatch_two_legal_lock_orderings() {
        use std::process::Command as StdCommand;
        use std::sync::atomic::AtomicUsize;

        // Ordering A: the dispatcher owns the registry lock before the wait
        // owner can publish revocation. Pause at the real kill seam, start the
        // wait owner, then release the signal. The target is demonstrably live
        // and unreaped when dispatch wins.
        let dispatch_first_handle = format!("dispatch-first-{}", Uuid::new_v4());
        let dispatch_first_generation =
            try_register_handle_gen(&dispatch_first_handle).expect("acquire test handle");
        let mut dispatch_first_child = StdCommand::new("sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .spawn()
            .expect("spawn live fixture");
        let dispatch_first_pid = dispatch_first_child.id();
        assert_eq!(
            register_process_gen(&dispatch_first_handle, dispatch_first_pid),
            dispatch_first_generation
        );

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let killer_handle = dispatch_first_handle.clone();
        let killer = thread::spawn(move || {
            dispatch_signal_checked_with(
                &killer_handle,
                dispatch_first_generation,
                dispatch_first_pid,
                Signal::SIGKILL,
                |target, signal_to_send| {
                    entered_tx
                        .send(())
                        .expect("ordering receiver must remain alive");
                    release_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("test must release the lock-held dispatcher");
                    signal::kill(target, signal_to_send)
                },
            )
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("dispatcher must reach the lock-held kill seam");
        assert!(
            dispatch_first_child
                .try_wait()
                .expect("probe live fixture")
                .is_none(),
            "ordering A must dispatch only while the target is still unreaped"
        );
        let waiter_handle = dispatch_first_handle.clone();
        let waiter = thread::spawn(move || {
            wait_for_terminal_status(
                &mut dispatch_first_child,
                &waiter_handle,
                dispatch_first_generation,
            )
        });
        release_tx.send(()).expect("release lock-held dispatcher");
        assert_eq!(
            killer.join().expect("dispatcher thread must not panic"),
            SignalDispatch::Delivered
        );
        let status = waiter
            .join()
            .expect("wait owner must not panic")
            .expect("wait owner must reap the signalled child");
        assert_eq!(exit_signal(&status), Some(Signal::SIGKILL as i32));
        assert!(deregister_generation(
            &dispatch_first_handle,
            dispatch_first_generation
        ));

        // Ordering B: the wait owner really reaps a second child and publishes
        // revocation before either cancellation dispatch. Neither immediate nor
        // delayed escalation may enter the recording kill seam afterwards.
        let reap_first_handle = format!("reap-first-{}", Uuid::new_v4());
        let reap_first_generation =
            try_register_handle_gen(&reap_first_handle).expect("acquire reap-first handle");
        let mut reap_first_child = StdCommand::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .expect("spawn reap-first fixture");
        let reap_first_pid = reap_first_child.id();
        assert_eq!(
            register_process_gen(&reap_first_handle, reap_first_pid),
            reap_first_generation
        );
        let status = wait_for_terminal_status(
            &mut reap_first_child,
            &reap_first_handle,
            reap_first_generation,
        )
        .expect("wait owner must reap before stale dispatches");
        assert!(status.success());

        let calls = AtomicUsize::new(0);
        let immediate = dispatch_signal_checked_with(
            &reap_first_handle,
            reap_first_generation,
            reap_first_pid,
            Signal::SIGTERM,
            |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        let delayed = dispatch_signal_checked_with(
            &reap_first_handle,
            reap_first_generation,
            reap_first_pid,
            Signal::SIGKILL,
            |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        assert_eq!(immediate, SignalDispatch::RefusedRevoked);
        assert_eq!(delayed, SignalDispatch::RefusedRevoked);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "refused paths must not kill"
        );
        assert!(deregister_generation(
            &reap_first_handle,
            reap_first_generation
        ));
    }

    #[cfg(unix)]
    #[test]
    fn observation_error_lattice_refuses_post_reservation_signals() {
        use std::process::Command as StdCommand;
        use std::sync::atomic::AtomicUsize;

        fn start_exiting_child(handle: &str) -> (u64, std::process::Child) {
            let generation = try_register_handle_gen(handle).expect("acquire handle");
            let child = StdCommand::new("sh")
                .args(["-c", "exit 0"])
                .process_group(0)
                .spawn()
                .expect("spawn short-lived fixture");
            assert_eq!(register_process_gen(handle, child.id()), generation);
            (generation, child)
        }

        fn assert_refused_after_revocation(handle: &str, generation: u64, pid: u32) {
            let calls = AtomicUsize::new(0);
            for signal_to_send in [Signal::SIGTERM, Signal::SIGKILL] {
                let outcome = dispatch_signal_checked_with(
                    handle,
                    generation,
                    pid,
                    signal_to_send,
                    |_, _| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                );
                assert_eq!(outcome, SignalDispatch::RefusedRevoked);
            }
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }

        // EINTR is retried inside the production observation helper. The next
        // successful observation revokes before the real reap.
        let eintr_handle = format!("observation-eintr-{}", Uuid::new_v4());
        let (eintr_generation, mut eintr_child) = start_exiting_child(&eintr_handle);
        let eintr_pid = eintr_child.id();
        set_test_observation_results(vec![Err(io::Error::from_raw_os_error(libc::EINTR)), Ok(())]);
        wait_for_terminal_status(&mut eintr_child, &eintr_handle, eintr_generation)
            .expect("EINTR must retry to the normal observation path");
        assert_refused_after_revocation(&eintr_handle, eintr_generation, eintr_pid);
        assert!(deregister_generation(&eintr_handle, eintr_generation));

        // ECHILD means some other reaper consumed the child. The helper must
        // revoke first and only then perform its bookkeeping wait.
        let echild_handle = format!("observation-echild-{}", Uuid::new_v4());
        let (echild_generation, mut echild_child) = start_exiting_child(&echild_handle);
        let echild_pid = echild_child.id();
        echild_child
            .wait()
            .expect("reap fixture before ECHILD path");
        set_test_observation_results(vec![Err(io::Error::from_raw_os_error(libc::ECHILD))]);
        let _ = wait_for_terminal_status(&mut echild_child, &echild_handle, echild_generation);
        assert_refused_after_revocation(&echild_handle, echild_generation, echild_pid);
        assert!(deregister_generation(&echild_handle, echild_generation));

        // An irrecoverable observation error uses the lock-scoped try_wait
        // fallback. While the child is still running the first poll proves
        // cancellation authority remains live; after the delivered SIGKILL the
        // same path atomically publishes revocation with the reap.
        let einval_handle = format!("observation-einval-{}", Uuid::new_v4());
        let einval_generation =
            try_register_handle_gen(&einval_handle).expect("acquire EINVAL handle");
        let mut einval_child = StdCommand::new("sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .spawn()
            .expect("spawn live EINVAL fixture");
        let einval_pid = einval_child.id();
        assert_eq!(
            register_process_gen(&einval_handle, einval_pid),
            einval_generation
        );
        let (poll_tx, poll_rx) = mpsc::channel();
        set_test_degraded_wait_hook(&einval_handle, move || {
            poll_tx
                .send(())
                .expect("degraded-wait receiver must remain alive");
        });
        let waiter_handle = einval_handle.clone();
        let einval_waiter = thread::spawn(move || {
            set_test_observation_results(vec![Err(io::Error::from_raw_os_error(libc::EINVAL))]);
            wait_for_terminal_status(&mut einval_child, &waiter_handle, einval_generation)
        });
        poll_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("live child must enter degraded polling");
        assert_eq!(
            dispatch_signal_checked(
                &einval_handle,
                einval_generation,
                einval_pid,
                Signal::SIGKILL,
            ),
            SignalDispatch::Delivered,
            "degraded observation must retain signal authority while the child is unreaped"
        );
        let status = einval_waiter
            .join()
            .expect("degraded wait owner must not panic")
            .expect("degraded wait path must still report the child status");
        assert_eq!(exit_signal(&status), Some(Signal::SIGKILL as i32));
        assert_refused_after_revocation(&einval_handle, einval_generation, einval_pid);
        assert!(deregister_generation(&einval_handle, einval_generation));
    }

    #[test]
    fn force_clear_then_replacement_survives_old_exit_callback() {
        let handle = format!("generation-replacement-{}", Uuid::new_v4());
        let old_generation = try_register_handle_gen(&handle).expect("acquire old generation");
        assert_eq!(register_process_gen(&handle, 41), old_generation);
        assert!(mark_cancelled(&handle));
        assert!(deregister_generation(&handle, old_generation));

        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");
        assert_eq!(register_process_gen(&handle, 42), replacement_generation);

        let mut replacement_visible_to_old_callback = false;
        emit_exit_then_deregister(
            &handle,
            old_generation,
            &mut |_| {
                replacement_visible_to_old_callback = is_registered(&handle)
                    && generation_for_handle(&handle) == Some(replacement_generation)
                    && is_cancelled_for_generation(&handle, old_generation)
                    && !is_cancelled_for_generation(&handle, replacement_generation);
            },
            ProcessEvent::Exit {
                code: None,
                signal: Some(9),
                success: false,
            },
        );

        assert!(replacement_visible_to_old_callback);
        assert_eq!(generation_for_handle(&handle), Some(replacement_generation));
        assert!(revoke_signal_authority_for_generation(
            &handle,
            replacement_generation
        ));
        assert!(deregister_generation(&handle, replacement_generation));
    }

    #[cfg(unix)]
    #[test]
    fn released_generation_keeps_escalation_authority_without_targeting_replacement() {
        use std::sync::atomic::AtomicUsize;

        let handle = format!("released-generation-escalation-{}", Uuid::new_v4());
        let old_generation = try_register_handle_gen(&handle).expect("acquire old generation");
        assert_eq!(register_process_gen(&handle, 41), old_generation);
        assert!(mark_cancelled(&handle));

        // Force-clear releases the public handle before the delayed SIGKILL.
        // The old generation must retain only its own signal capability so the
        // replacement can start immediately without making the old child
        // unkillable or exposing the replacement to the stale escalation.
        assert!(deregister_generation(&handle, old_generation));
        let replacement_generation =
            try_register_handle_gen(&handle).expect("acquire replacement generation");
        assert_eq!(register_process_gen(&handle, 42), replacement_generation);

        let calls = AtomicUsize::new(0);
        let old_dispatch = dispatch_signal_checked_with(
            &handle,
            old_generation,
            41,
            Signal::SIGKILL,
            |pid, signal| {
                assert_eq!(pid, Pid::from_raw(-41));
                assert_eq!(signal, Signal::SIGKILL);
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        assert_eq!(
            old_dispatch,
            SignalDispatch::Delivered,
            "releasing a public handle must not cancel its old generation's pending escalation"
        );

        let replacement_dispatch =
            dispatch_signal_checked_with(&handle, old_generation, 42, Signal::SIGKILL, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
        assert_eq!(replacement_dispatch, SignalDispatch::RefusedStale);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        assert!(revoke_signal_authority_for_generation(
            &handle,
            old_generation
        ));
        assert_eq!(
            dispatch_signal_checked_with(&handle, old_generation, 41, Signal::SIGKILL, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },),
            SignalDispatch::RefusedRevoked
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        assert!(deregister_generation(&handle, old_generation));
        assert!(revoke_signal_authority_for_generation(
            &handle,
            replacement_generation
        ));
        assert!(deregister_generation(&handle, replacement_generation));
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

        let pids: Vec<(String, u32)> = kids
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("exit-test-{i}"), c.id()))
            .collect();

        // App-exit teardown intentionally operates only on registry-owned
        // children; an arbitrary stale `(handle, pid)` pair must never be
        // signalled after numeric identity reuse.
        for (handle, pid) in &pids {
            register_process(handle, *pid);
        }

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
        for (handle, _) in &pids {
            deregister_process(handle);
        }
    }

    #[test]
    fn terminate_pids_for_exit_is_noop_when_empty() {
        // Must not sleep the grace period or panic when nothing is registered.
        terminate_pids_for_exit(&[], Duration::from_secs(30));
    }
}
