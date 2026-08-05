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
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.active.get_mut(handle) {
        entry.pid = Some(pid);
        entry.generation
    } else {
        let generation = next_process_generation();
        let mut entry = ProcessEntry::new(generation);
        entry.pid = Some(pid);
        reg.active.insert(handle.to_string(), entry);
        generation
    }
}

pub fn register_process(handle: &str, pid: u32) {
    let _ = register_process_gen(handle, pid);
}

#[cfg(target_os = "windows")]
fn register_job_handle(handle: &str, job: isize) {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.active.get_mut(handle) {
        entry.job_handle = Some(job);
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
                        Ok(None) => true,
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
    let _ = generation;
    run_process_impl(handle, spawn, on_event)
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
                let _ = deregister_generation(handle, generation);
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
    #[cfg(target_os = "windows")]
    {
        if !mark_cancelled(handle) {
            return false;
        }
        let job_isize = process_registry()
            .lock()
            .unwrap()
            .active
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
        // Mark cancellation, capture the generation, and send SIGTERM under
        // one registry lock. Releasing the lock before dispatch would let the
        // wait owner reap and free this numeric process-group identity first.
        let target = {
            let mut registry = process_registry().lock().unwrap();
            let Some(entry) = registry.active.get_mut(handle) else {
                return false;
            };
            if entry.signal_authority_revoked {
                return false;
            }
            let Some(pid) = entry.pid else {
                entry.cancelled = true;
                return true;
            };
            let generation = entry.generation;
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
        if !mark_cancelled(handle) {
            return false;
        }
        let _ = sigkill_delay;
        true
    }
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
    let _ = generation;
    cancel_process_impl(handle, sigkill_delay)
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
    for process in &processes {
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
    for (handle, pid) in pids {
        let Some(process) = registered_process_for(handle, *pid) else {
            continue;
        };
        let _ = cancel_process_impl(&process.handle, Duration::ZERO);
        let _ = deregister_generation(&process.handle, process.generation);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn terminate_pids_for_exit(pids: &[(String, u32)], _grace: Duration) {
    for (handle, pid) in pids {
        if let Some(process) = registered_process_for(handle, *pid) {
            let _ = deregister_generation(&process.handle, process.generation);
        }
    }
}

/// Tear down every spawned child on app exit. Call from the app's
/// `RunEvent::ExitRequested` handler so closing HQ Sync (tray Quit, `quit_app`,
/// or Cmd-Q) reliably stops the `--watch` sync daemon and any sidecar instead
/// of orphaning them.
pub fn terminate_all_for_exit(grace: Duration) {
    APP_EXIT_REQUESTED.store(true, Ordering::Release);
    terminate_pids_for_exit(&registered_pids(), grace);
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
            result.is_err(),
            "a runner whose registration was retired must not become active again"
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

    /// The SIGKILL escalation is a deliberate stop, not a watcher crash.  The
    /// exit callback is the reporting boundary, so the cancellation record has
    /// to remain observable there even when the child ignores SIGTERM and is
    /// eventually killed.
    #[cfg(unix)]
    #[test]
    fn escalation_sigkill_keeps_cancelled_observable_in_exit_callback() {
        let handle = format!("sigkill-cancel-observable-{}", Uuid::new_v4());
        pre_register_handle(&handle);
        let spawn = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "trap '' TERM; while :; do sleep 1; done".to_string(),
            ],
            cwd: None,
            env: None,
        };
        let (exit_tx, exit_rx) = mpsc::channel();
        let runner_handle = handle.clone();
        let runner = thread::spawn(move || {
            let callback_handle = runner_handle.clone();
            run_process_impl(&runner_handle, &spawn, move |event| {
                if let ProcessEvent::Exit { signal, .. } = event {
                    let observed = (
                        is_registered(&callback_handle),
                        is_cancelled(&callback_handle),
                    );
                    exit_tx
                        .send((observed, signal))
                        .expect("test receiver must remain alive");
                }
            })
        });

        let start = std::time::Instant::now();
        while lookup_pid(&handle).is_none() {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "runner did not register its child within the bounded test window"
            );
            thread::sleep(Duration::from_millis(10));
        }

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

        let handle = format!("dispatch-order-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("acquire test handle");
        let mut child = StdCommand::new("sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .spawn()
            .expect("spawn live fixture");
        assert_eq!(register_process_gen(&handle, child.id()), generation);
        assert!(
            child.try_wait().expect("probe live fixture").is_none(),
            "ordering A must dispatch only while the target is still unreaped"
        );

        let calls = AtomicUsize::new(0);
        let delivered = dispatch_signal_checked_with(
            &handle,
            generation,
            child.id(),
            Signal::SIGTERM,
            |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        assert_eq!(delivered, SignalDispatch::Delivered);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Ordering B models the wait owner committing revoke+reap before either
        // cancellation dispatch. Neither immediate nor delayed escalation may
        // enter the kill seam after that point.
        assert!(revoke_signal_authority_for_generation(&handle, generation));
        let immediate = dispatch_signal_checked_with(
            &handle,
            generation,
            child.id(),
            Signal::SIGTERM,
            |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        let delayed = dispatch_signal_checked_with(
            &handle,
            generation,
            child.id(),
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
            1,
            "refused paths must not kill"
        );

        signal::kill(Pid::from_raw(-(child.id() as i32)), Signal::SIGKILL)
            .expect("clean up live fixture process group");
        child.wait().expect("reap live fixture");
        assert!(deregister_generation(&handle, generation));
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
        // fallback; it publishes revocation in that critical section once the
        // fixture becomes waitable.
        let einval_handle = format!("observation-einval-{}", Uuid::new_v4());
        let (einval_generation, mut einval_child) = start_exiting_child(&einval_handle);
        let einval_pid = einval_child.id();
        set_test_observation_results(vec![Err(io::Error::from_raw_os_error(libc::EINVAL))]);
        wait_for_terminal_status(&mut einval_child, &einval_handle, einval_generation)
            .expect("degraded wait path must still report the child status");
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
