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

use crate::util::logfile::log;
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
    GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
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

/// Causality evidence retained through deregistration until the exact child
/// delivers its terminal callback. A *requested* cancellation is deliberately
/// separate from `termination_effected`: only an OS termination this app
/// observed taking effect may suppress the runner's non-zero exit capture.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CancellationRecord {
    pub cause: Option<SyncCancelCause>,
    pub termination_effected: bool,
}

/// Result returned to a generation-aware caller. `executed` means the exact
/// generation was still cancellable and has been marked; it does not claim
/// that a process actually died.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CancellationAttempt {
    pub executed: bool,
    pub termination_effected: bool,
}

/// The record map plus the set of generations whose termination effect is
/// still being determined. A terminal callback that arrives mid-cancellation
/// must wait for the observed effect rather than read a half-written record
/// and mistake a successful teardown for an ineffective one.
#[derive(Default)]
struct CancellationRecordsState {
    records: HashMap<(String, u64), CancellationRecord>,
    pending_publications: HashSet<(String, u64)>,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<ProcessRegistry>>> = OnceLock::new();
static CANCELLATION_RECORDS: OnceLock<Arc<(Mutex<CancellationRecordsState>, Condvar)>> =
    OnceLock::new();
static NEXT_PROCESS_GENERATION: AtomicU64 = AtomicU64::new(0);
/// A terminal callback never blocks indefinitely on a cancellation that is
/// still resolving. On expiry the attribution degrades to "not effected",
/// which keeps the exit alertable rather than silently suppressing it.
const CANCELLATION_PUBLICATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Raised at the single application-exit choke point before child teardown.
/// The daemon reads this as exit evidence; it does not alter cancellation or
/// crash classification.
static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Blocks new HQ-owned child registrations while a Windows update is
/// quiescing the process tree. The updater sets this before taking its process
/// snapshot, so a watcher cannot slip into the install window after the
/// snapshot but before the app exits.
static UPDATE_QUIESCE_REQUESTED: AtomicBool = AtomicBool::new(false);

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

fn process_registry() -> &'static Arc<Mutex<ProcessRegistry>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(ProcessRegistry::default())))
}

fn cancellation_records() -> &'static Arc<(Mutex<CancellationRecordsState>, Condvar)> {
    CANCELLATION_RECORDS.get_or_init(|| {
        Arc::new((
            Mutex::new(CancellationRecordsState::default()),
            Condvar::new(),
        ))
    })
}

/// Read the causal cancellation record for the exact terminal callback. The
/// map is never queried by bare handle, so an old callback cannot classify a
/// successor generation's cancellation as its own.
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

/// Publish the cause before any OS call, and claim the right to publish this
/// generation's termination effect. `owns_publication` is false when another
/// actor is already mid-cancellation for the same generation.
fn begin_cancellation_publication(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
) -> (bool, bool) {
    let key = (handle.to_string(), generation);
    let (records, _) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    let created = !state.records.contains_key(&key);
    // Claim the publication cycle first. Only the actor that owns it may stamp a
    // cause: a concurrent non-owner (e.g. the heartbeat watchdog racing an
    // in-flight causeless Cancelled/ForceClear teardown that has begun but not
    // yet marked the entry cancelled) must never relabel the initiating actor's
    // record, which would give a causeless teardown a durable cause it was never
    // meant to carry.
    let owns_publication = state.pending_publications.insert(key.clone());
    let record = state.records.entry(key).or_default();
    if owns_publication {
        if let Some(cause) = cause {
            record.cause.get_or_insert(cause);
        }
    }
    (owns_publication, created)
}

fn complete_cancellation_publication(handle: &str, generation: u64, observed_effect: bool) -> bool {
    let key = (handle.to_string(), generation);
    let (records, publication_completed) = &**cancellation_records();
    let mut state = records.lock().unwrap();
    if let Some(record) = state.records.get_mut(&key) {
        record.termination_effected |= observed_effect;
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

/// True when this exact generation has a cancellation recorded anywhere —
/// registry mark or retained record. Used only to answer a concurrent caller
/// whose own publication attempt lost the race.
fn cancellation_requested_for_generation(handle: &str, generation: u64) -> bool {
    if is_cancelled_for_generation(handle, generation) {
        return true;
    }
    cancellation_records()
        .0
        .lock()
        .unwrap()
        .records
        .contains_key(&(handle.to_string(), generation))
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
    if UPDATE_QUIESCE_REQUESTED.load(Ordering::Acquire) {
        return None;
    }
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
    if UPDATE_QUIESCE_REQUESTED.load(Ordering::Acquire) {
        // This generation registered before the updater closed the spawn gate
        // but did not attach its child until afterwards. Refuse that late
        // child and let the spawn owner terminate/reap it through the
        // containment it already established.
        entry.cancelled = true;
        ProcessAttachOutcome::Cancelled
    } else if entry.cancelled {
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

/// End a generation that will never receive a terminal child callback (for
/// example, a manual-sync preflight error). Unlike app-exit teardown there is
/// no child whose callback could still need this evidence, so drop the exact
/// cancellation record at the same time and keep the side map bounded.
pub fn abandon_process_generation(handle: &str, generation: u64) -> bool {
    let removed = deregister_generation(handle, generation);
    clear_cancellation_record(handle, generation);
    removed
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

/// Content-neutral accounting read from a watcher's retained Job Object at the
/// exit boundary. `peak_process_commit_bytes` is the job's peak single-process
/// COMMITTED memory (`JOBOBJECT_EXTENDED_LIMIT_INFORMATION::PeakProcessMemoryUsed`
/// is the peak commit charge, NOT the working set) — which still sees the Node
/// runner even though the registered child is the `cmd.exe` shim whose own
/// footprint hides it, and which spikes on a V8 heap-OOM. `total_processes`
/// counts every process that ran in the job, so a runner descendant is countable
/// even after it has exited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherJobAccounting {
    pub peak_process_commit_bytes: u64,
    pub total_processes: u32,
}

/// Read-only Job Object accounting for the EXACT `generation` under `handle`.
///
/// Resolving by generation — the active entry only if it still owns the handle
/// at this generation, else the retired entry parked by a `force_clear`/wait-
/// owner handoff — means the exit callback always reads its OWN watcher's job,
/// never a replacement that has since re-acquired `DAEMON_HANDLE`. The retained
/// job handle is read (and, on Windows, queried) while the registry lock is
/// held, so a concurrent `deregister`/`close_process_entry` cannot `CloseHandle`
/// the job between the lookup and the query. It is only ever queried — never
/// closed, terminated, duplicated out, or taken. Returns `None` when the exact
/// generation is absent, carries no job handle, the query fails, or the platform
/// is not Windows. Diagnostic-only: it never mutates registry, containment, or
/// lifecycle state.
#[cfg(target_os = "windows")]
pub fn watcher_job_accounting_for_generation(
    handle: &str,
    generation: u64,
) -> Option<WatcherJobAccounting> {
    let registry = process_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let job = registry
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
        .and_then(|entry| entry.job_handle)?;
    // SAFETY: `job` is this app's own retained Job Object handle and the registry
    // lock is held for the duration of the read, so it cannot be closed here.
    unsafe { query_job_accounting(job) }
}

#[cfg(not(target_os = "windows"))]
pub fn watcher_job_accounting_for_generation(
    _handle: &str,
    _generation: u64,
) -> Option<WatcherJobAccounting> {
    None
}

/// Query a Job Object's peak per-process working set and total process count.
/// Read-only: it issues two `QueryInformationJobObject` reads and closes
/// nothing. A function-local `use` keeps the raw `windows-sys` job symbols out
/// of module scope so they cannot collide with the high-level `windows` job
/// imports used by the spawn/teardown path.
#[cfg(target_os = "windows")]
unsafe fn query_job_accounting(job: isize) -> Option<WatcherJobAccounting> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    let hjob = job as windows_sys::Win32::Foundation::HANDLE;

    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    if QueryInformationJobObject(
        hjob,
        JobObjectExtendedLimitInformation,
        &mut extended as *mut _ as *mut core::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        core::ptr::null_mut(),
    ) == 0
    {
        return None;
    }

    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
    if QueryInformationJobObject(
        hjob,
        JobObjectBasicAccountingInformation,
        &mut accounting as *mut _ as *mut core::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
        core::ptr::null_mut(),
    ) == 0
    {
        return None;
    }

    Some(WatcherJobAccounting {
        peak_process_commit_bytes: extended.PeakProcessMemoryUsed as u64,
        total_processes: accounting.TotalProcesses,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Watcher fault provenance (HQ-DESKTOP-4X)
// ─────────────────────────────────────────────────────────────────────────────
//
// The watcher route reports `runner_fatal_class=none` because no fault-bearing
// stderr line ever reaches the app; the classifier arms (proven by the sibling
// manual-route issue) cannot converge on a line that never arrives. Instead of
// widening the stderr table again, read the operating system's own fault record:
// a Windows Error Reporting "Application Error" (Event ID 1000) entry naming the
// faulting executable and module. To bind that record to THIS watcher generation
// rather than a coincidental crash on the machine, the job's live process-id set
// is sampled on the heartbeat cadence and the record's faulting PID is matched
// against it (with a timestamp inside the generation lifetime). The reader is
// strictly diagnostic, bounded, read-only, and degrades to a fixed sentinel on
// any failure. All interpretation lives in `hq_desktop_core::watcher_fault` so it
// is unit-tested off Windows; here is only the Win32 I/O.

/// Max WER Application Error records pulled per exit query. Newest-first, so a
/// dozen is far more than the one relevant crash while keeping the scan bounded.
#[cfg(target_os = "windows")]
const WER_MAX_RECORDS: usize = 12;

/// The deferred fault read's total horizon (HQ-DESKTOP-4X). The read runs
/// entirely OFF the terminal exit callback — which now performs NO Event Log work
/// at all — so this can be far longer than the prior on-exit-path 4.5s cap
/// without ever holding up `emit_exit_then_deregister` or supervisor recovery. It
/// is the outer bound WER can realistically meet: the "Application Error"
/// (Event 1000) entry publishes asynchronously seconds after the child dies, and
/// a large Job Object commit charge makes WerFault slower still. Every wait under
/// it is itself bounded, so this is a deadline, never an unbounded poll.
#[cfg(target_os = "windows")]
const WATCHER_FAULT_DEFERRED_BUDGET: Duration = Duration::from_secs(60);

/// Per-sweep budget for one EvtQuery/EvtNext/EvtRender pass.
#[cfg(target_os = "windows")]
const WER_PER_QUERY_BUDGET: Duration = Duration::from_millis(500);

/// Sleep between sweeps while waiting for WER to asynchronously publish the
/// Event 1000 record after the child has already exited. A bounded 1s cadence
/// over the deferred horizon — never an unbounded poll.
#[cfg(target_os = "windows")]
const WATCHER_FAULT_DEFERRED_SWEEP: Duration = Duration::from_secs(1);

/// Cap on distinct PIDs retained per generation's sampled set. The watcher tree
/// is ~7 processes; this bounds pathological growth without losing the runner.
#[cfg(target_os = "windows")]
const WATCHER_PID_SAMPLE_CAP: usize = 256;

/// A generation's drained job sample: the live PIDs seen across its lifetime (for
/// binding a WER record) and the content-safe descriptor of the images those PIDs
/// ran (a tree observation that names a culprit candidate even when WER yields no
/// record). Platform-neutral; empty on non-Windows.
#[derive(Debug, Clone, Default)]
pub struct WatcherJobSample {
    pub pids: Vec<u32>,
    pub images: hq_desktop_core::watcher_fault::WatcherJobImageDescriptor,
}

/// Sampled live Job Object process images, keyed by process-registry generation
/// and then by PID. The value is the PID's image mapped through the allow-list AT
/// SAMPLE TIME — the fault read runs only after the tree dies, so the image must
/// be resolved while the process is still alive. `None` means the PID was seen but
/// its image could NOT be read (the process exited between the Job Object query
/// and the image query, or the query failed): the PID is still retained for WER
/// binding, but no image observation is recorded, so a failed lookup never
/// masquerades as an `other` culprit. Union of every heartbeat sample so the
/// runner descendant (dead by exit) is still describable at exit. Populated only
/// on Windows; drained at exit so it can never grow unbounded. Kept out of the
/// registry `Entry` so it cannot perturb job-accounting or containment paths.
static WATCHER_JOB_PID_SAMPLES: OnceLock<
    Mutex<HashMap<u64, HashMap<u32, Option<hq_desktop_core::watcher_fault::WatcherFaultBinary>>>>,
> = OnceLock::new();

#[allow(clippy::type_complexity)]
fn watcher_job_pid_samples() -> &'static Mutex<
    HashMap<u64, HashMap<u32, Option<hq_desktop_core::watcher_fault::WatcherFaultBinary>>>,
> {
    WATCHER_JOB_PID_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remove and return this generation's sample (PIDs + image descriptor). Called
/// once at exit both to read the sample and to release its memory, so the map can
/// never retain a generation key after the deferred read is handed its data.
pub fn take_watcher_job_sample(generation: u64) -> WatcherJobSample {
    let map = watcher_job_pid_samples()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&generation)
        .unwrap_or_default();
    let mut images = hq_desktop_core::watcher_fault::WatcherJobImageDescriptor::default();
    for image in map.values().copied() {
        // `None` (image unresolved) records nothing; every PID is still retained
        // below for WER binding. Absence never masquerades as an observation.
        images.record_optional(image);
    }
    WatcherJobSample {
        pids: map.into_keys().collect(),
        images,
    }
}

/// Resolve one live PID's executable image basename to a fixed allow-listed
/// token, content-safely. A dead PID (the runner is usually gone by exit) or one
/// that cannot be opened yields `None` — absence, never a guess. Read-only: it
/// opens the process for limited query, reads the image path, classifies it
/// through the closed allow-list (so no path byte escapes), and closes the
/// handle; it never terminates, duplicates, or writes anything.
#[cfg(target_os = "windows")]
fn resolve_process_image_token(
    pid: u32,
) -> Option<hq_desktop_core::watcher_fault::WatcherFaultBinary> {
    use hq_desktop_core::watcher_fault::classify_watcher_fault_binary;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: standard open-query-close. The handle is closed on every path; the
    // buffer is sized before the call and the returned length bounds the read.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 260]; // MAX_PATH
        let mut size = buffer.len() as u32;
        let query = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        query.ok()?;
        let end = (size as usize).min(buffer.len());
        let name = String::from_utf16_lossy(&buffer[..end]);
        Some(classify_watcher_fault_binary(&name))
    }
}

/// Sample the live process-id set of the EXACT `generation`'s retained Job
/// Object, resolve each PID's image while it is still alive, and union both into
/// that generation's sampled map. Called on the watcher heartbeat cadence so the
/// runner descendant is captured before it dies. Read-only and generation-scoped,
/// resolved exactly like [`watcher_job_accounting_for_generation`]; a no-op on
/// non-Windows or when the generation carries no job handle.
#[cfg(target_os = "windows")]
pub fn sample_watcher_job_pids_for_generation(handle: &str, generation: u64) {
    let registry = process_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let job = registry
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
        .and_then(|entry| entry.job_handle);
    let Some(job) = job else {
        return;
    };
    // SAFETY: `job` is this app's own retained Job Object handle and the registry
    // lock is held for the duration of the read, so it cannot be closed here. The
    // query is read-only; it never closes, terminates, or duplicates the handle.
    let pids = unsafe { query_job_live_pids(job) };
    drop(registry);
    let Some(pids) = pids else {
        return;
    };
    let mut samples = watcher_job_pid_samples()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let set = samples.entry(generation).or_default();
    for pid in pids {
        if set.len() >= WATCHER_PID_SAMPLE_CAP {
            break;
        }
        // Resolve the image once while alive. `None` means it could not be read
        // (the PID is gone or cannot be opened) — retain the PID for WER binding
        // but record NO image, and never let a later unresolved (or less specific)
        // sample downgrade a real live-tree reading.
        let image = resolve_process_image_token(pid);
        set.entry(pid)
            .and_modify(|existing| {
                *existing = hq_desktop_core::watcher_fault::more_specific_image(*existing, image);
            })
            .or_insert(image);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sample_watcher_job_pids_for_generation(_handle: &str, _generation: u64) {}

/// Best-effort working-set (KB) of one live PID via `OpenProcess` +
/// `GetProcessMemoryInfo`. Read-only: it opens the process for limited query,
/// reads `WorkingSetSize`, and closes the handle on every path. `None` when the
/// PID cannot be opened or queried (already exited, or access denied) — absence,
/// never a guess. Mirrors the daemon supervisor's single-PID sampler so the summed
/// and the fallback numbers carry the same unit.
#[cfg(target_os = "windows")]
fn sample_pid_working_set_kb(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    // SAFETY: standard open-query-close; the handle is closed on every path and the
    // counters struct is sized before the call.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let sample = GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .ok()
        .map(|_| counters.WorkingSetSize as u64 / 1024);
        let _ = CloseHandle(handle);
        sample
    }
}

/// Sample the working set of every live PID in the EXACT `generation`'s retained
/// Job Object (HQ-DESKTOP-4M). Resolved by generation exactly like
/// [`watcher_job_accounting_for_generation`] — the active entry only while it still
/// owns the handle at this generation, else the retired entry — so a replacement
/// watcher's job is never returned. The live-PID list is read while the registry
/// lock is held (so a concurrent `deregister`/`close_process_entry` cannot close
/// the job between lookup and query); the lock is then DROPPED before any
/// per-process `OpenProcess` work. Each entry is `(pid, Some(working_set_kb))`, or
/// `(pid, None)` when that one PID could not be read. Strictly diagnostic and
/// read-only: it never closes, terminates, duplicates, or takes the Job Object
/// handle, and never mutates registry/containment/lifecycle state. `None` when the
/// exact generation is absent, carries no job handle, the job query fails, or the
/// platform is not Windows — the caller then falls back to a single-PID sample.
#[cfg(target_os = "windows")]
pub fn watcher_job_working_set_samples(
    handle: &str,
    generation: u64,
) -> Option<Vec<(u32, Option<u64>)>> {
    let registry = process_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let job = registry
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
        .and_then(|entry| entry.job_handle);
    let Some(job) = job else {
        return None;
    };
    // SAFETY: `job` is this app's own retained Job Object handle and the registry
    // lock is held for the duration of the read, so it cannot be closed here. The
    // query is read-only; it never closes, terminates, or duplicates the handle.
    let pids = unsafe { query_job_live_pids(job) };
    drop(registry);
    let pids = pids?;
    // Per-process reads happen OUTSIDE the registry lock, matching
    // `sample_watcher_job_pids_for_generation`'s lock discipline exactly.
    Some(
        pids.into_iter()
            .map(|pid| (pid, sample_pid_working_set_kb(pid)))
            .collect(),
    )
}

#[cfg(not(target_os = "windows"))]
pub fn watcher_job_working_set_samples(
    _handle: &str,
    _generation: u64,
) -> Option<Vec<(u32, Option<u64>)>> {
    None
}

/// The production horizon for the deferred fault read, exposed cross-platform so
/// the daemon's deferred-capture worker can name it without touching the
/// windows-only constant. On non-Windows it is nominal and unused (no fault-exit
/// deferral fires there).
pub fn deferred_watcher_fault_budget() -> Duration {
    #[cfg(target_os = "windows")]
    {
        WATCHER_FAULT_DEFERRED_BUDGET
    }
    #[cfg(not(target_os = "windows"))]
    {
        Duration::from_secs(60)
    }
}

/// Read the Windows fault record for THIS watcher generation and attribute it,
/// content-safely, to a fixed faulting-image/module token plus a RESOLVED
/// provenance token and bounded read counters. It POLLS because WER publishes the
/// "Application Error" (Event 1000) entry asynchronously AFTER the child dies, so
/// a single immediate query usually finds nothing.
///
/// It runs on a DEFERRED worker thread entirely OFF the terminal exit callback —
/// which now performs NO Event Log work at all — under a hard bounded horizon, so
/// it never holds up `emit_exit_then_deregister` or supervisor recovery no matter
/// how slowly WER publishes. On budget expiry it renders a distinct token for
/// EACH failure mode (query unreadable, records unparsable, or the log stayed
/// empty until the deadline), so a second occurrence is self-diagnosing rather
/// than the ambiguous `no_record`/`unavailable` the prior fix could only emit.
/// `gen_start_ms`/`gen_end_ms` bound the generation lifetime in unix millis;
/// `observed_exception_code` is the fault status the exit itself carried.
#[cfg(target_os = "windows")]
pub fn read_watcher_fault(
    sampled_pids: &[u32],
    observed_exception_code: u32,
    gen_start_ms: i64,
    gen_end_ms: i64,
    total_budget: Duration,
) -> hq_desktop_core::watcher_fault::WatcherFaultOutcome {
    use hq_desktop_core::watcher_fault::{
        attribute_watcher_fault, parse_application_error_event, WatcherFaultOutcome,
        WatcherFaultProvenance, WatcherFaultReadCounters,
    };
    let start = std::time::Instant::now();
    let deadline = start + total_budget;
    let elapsed_ms =
        |from: std::time::Instant| from.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
    let mut query_ever_ran = false;
    let mut sweeps: u32 = 0;
    let mut max_seen: u32 = 0;
    // The best (most specific) non-binding diagnosis from any sweep that DID parse
    // records but could not bind them — kept so that if our in-window record never
    // publishes, the verdict is the honest "records existed, none were ours"
    // rather than a blank one. Never terminal on its own: WER can publish our
    // record AFTER an unrelated one, so a rejection must not end the poll early.
    let mut last_rejection: Option<hq_desktop_core::watcher_fault::WatcherFaultOutcome> = None;
    loop {
        sweeps = sweeps.saturating_add(1);
        if let Some(xmls) = query_wer_application_error_xml(WER_MAX_RECORDS, WER_PER_QUERY_BUDGET) {
            query_ever_ran = true;
            let seen = xmls.len().min(u32::MAX as usize) as u32;
            max_seen = max_seen.max(seen);
            let records: Vec<_> = xmls
                .iter()
                .filter_map(|xml| parse_application_error_event(xml))
                .collect();
            if !records.is_empty() {
                let outcome = attribute_watcher_fault(
                    &records,
                    sampled_pids,
                    gen_start_ms,
                    gen_end_ms,
                    Some(observed_exception_code),
                );
                // Only a concrete binding is terminal. A rejection is remembered
                // but does NOT end the poll: WER publishes our Event 1000 entry
                // asynchronously and may land after an unrelated record, so giving
                // up on the first rejection would reproduce the very early-give-up
                // failure this fix exists to remove.
                if outcome.provenance.is_bound() {
                    let mut counters = outcome.counters;
                    counters.records_seen = seen;
                    counters.sweeps = sweeps;
                    counters.ms_to_verdict = elapsed_ms(start);
                    return outcome.with_counters(counters);
                }
                // Retain the MOST actionable rejection across sweeps. A later sweep
                // whose newest-record set no longer contains the in-window
                // code-mismatch record must not overwrite a `rejected_code_mismatch`
                // verdict with a vaguer `rejected_out_of_window` one, else the final
                // provenance and counters would hide the more actionable finding.
                last_rejection = Some(match last_rejection {
                    Some(prev) => prev.stronger_rejection(outcome),
                    None => outcome,
                });
            }
        }
        if std::time::Instant::now() >= deadline {
            let ms_to_verdict = elapsed_ms(start);
            // Records existed across the read but none ever bound: report the
            // concrete rejection reason (out-of-window vs code-mismatch), with the
            // reader-measured counters folded onto the pure per-reason counts.
            if let Some(rejection) = last_rejection {
                let mut counters = rejection.counters;
                counters.records_seen = max_seen;
                counters.sweeps = sweeps;
                counters.ms_to_verdict = ms_to_verdict;
                return rejection.with_counters(counters);
            }
            let counters = WatcherFaultReadCounters {
                records_seen: max_seen,
                sweeps,
                ms_to_verdict,
                ..Default::default()
            };
            // No parseable record ever bound: resolve WHY into a distinct token.
            let provenance = if !query_ever_ran {
                WatcherFaultProvenance::QueryUnreadable
            } else if max_seen > 0 {
                // Event 1000 entries existed but none ever parsed as a valid
                // Application Error record.
                WatcherFaultProvenance::RejectedUnparsable
            } else {
                // The query ran but the log stayed empty for the whole horizon —
                // WER never published the entry in time.
                WatcherFaultProvenance::DeadlineExpired
            };
            return WatcherFaultOutcome::unresolved(provenance).with_counters(counters);
        }
        thread::sleep(WATCHER_FAULT_DEFERRED_SWEEP);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn read_watcher_fault(
    _sampled_pids: &[u32],
    _observed_exception_code: u32,
    _gen_start_ms: i64,
    _gen_end_ms: i64,
    _total_budget: Duration,
) -> hq_desktop_core::watcher_fault::WatcherFaultOutcome {
    hq_desktop_core::watcher_fault::WatcherFaultOutcome::not_applicable()
}

/// Read the live process-id list of a Job Object. A single read-only
/// `QueryInformationJobObject(JobObjectBasicProcessIdList)`; closes nothing. The
/// buffer holds a fixed cap of ids — the watcher tree is tiny — and a job larger
/// than the cap simply degrades to `None` (no sample this tick).
#[cfg(target_os = "windows")]
unsafe fn query_job_live_pids(job: isize) -> Option<Vec<u32>> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };
    const CAP: usize = 512;
    let hjob = job as windows_sys::Win32::Foundation::HANDLE;
    let bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
        + CAP * std::mem::size_of::<usize>();
    let mut buffer = vec![0u8; bytes];
    let list = buffer.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
    if QueryInformationJobObject(
        hjob,
        JobObjectBasicProcessIdList,
        list as *mut core::ffi::c_void,
        bytes as u32,
        core::ptr::null_mut(),
    ) == 0
    {
        return None;
    }
    let count = ((*list).NumberOfProcessIdsInList as usize).min(CAP);
    // The API writes a flexible array past the declared `[usize; 1]`, so take the
    // element pointer WITHOUT forming a `&[usize; 1]` reference (which would make
    // reading past index 0 undefined). The reads stay within the over-allocation.
    let first = core::ptr::addr_of!((*list).ProcessIdList) as *const usize;
    let mut pids = Vec::with_capacity(count);
    for index in 0..count {
        pids.push(*first.add(index) as u32);
    }
    Some(pids)
}

/// Query the Windows Application channel for recent WER "Application Error"
/// (Event ID 1000) records and render each to its event XML. Newest-first,
/// capped at `max_records`, and bounded by `budget`; every handle it opens it
/// closes. Returns rendered XML fragments for the pure parser — never any
/// interpreted bytes.
///
/// Returns `None` when the log could not be read at all (`EvtQuery` failed —
/// WER/Application channel disabled, unreadable, or throttled), so the caller can
/// preserve the `unavailable` provenance for that case rather than collapsing it
/// to `no_record`. `Some(vec)` — possibly empty — means the query ran.
#[cfg(target_os = "windows")]
fn query_wer_application_error_xml(max_records: usize, budget: Duration) -> Option<Vec<String>> {
    use std::time::Instant;
    use windows_sys::Win32::System::EventLog::{
        EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryReverseDirection,
    };

    let channel = to_wide("Application");
    let query = to_wide("*[System[Provider[@Name='Application Error'] and (EventID=1000)]]");
    let deadline = Instant::now() + budget;
    let mut out: Vec<String> = Vec::new();

    // SAFETY: standard wevtapi query loop. `results` and each pulled event handle
    // are closed exactly once; buffers are sized from the API's own reported need.
    unsafe {
        let results = EvtQuery(
            0,
            channel.as_ptr(),
            query.as_ptr(),
            EvtQueryChannelPath | EvtQueryReverseDirection,
        );
        if results == 0 {
            // The log itself could not be opened — absence of a reader, not of a
            // fault. Distinct from an empty-but-successful query below.
            return None;
        }
        while out.len() < max_records && Instant::now() < deadline {
            let mut event: isize = 0;
            let mut returned: u32 = 0;
            let ok = EvtNext(results, 1, &mut event as *mut isize, 250, 0, &mut returned);
            if ok == 0 || returned == 0 || event == 0 {
                break;
            }
            if let Some(xml) = render_event_xml(event) {
                out.push(xml);
            }
            EvtClose(event);
        }
        EvtClose(results);
    }
    Some(out)
}

/// Render one event handle to its XML text via `EvtRender(EvtRenderEventXml)`.
/// Two-call size-then-fill; returns `None` on any failure. The rendered UTF-16
/// is decoded lossily and trimmed at its terminating NUL.
#[cfg(target_os = "windows")]
unsafe fn render_event_xml(event: isize) -> Option<String> {
    use windows_sys::Win32::System::EventLog::{EvtRender, EvtRenderEventXml};
    let mut needed: u32 = 0;
    let mut props: u32 = 0;
    // Size probe: returns FALSE and reports the required byte count in `needed`.
    EvtRender(
        0,
        event,
        EvtRenderEventXml,
        0,
        core::ptr::null_mut(),
        &mut needed,
        &mut props,
    );
    if needed == 0 {
        return None;
    }
    let mut buffer: Vec<u16> = vec![0u16; (needed as usize).div_ceil(2)];
    let mut used: u32 = 0;
    let ok = EvtRender(
        0,
        event,
        EvtRenderEventXml,
        (buffer.len() * 2) as u32,
        buffer.as_mut_ptr() as *mut core::ffi::c_void,
        &mut used,
        &mut props,
    );
    if ok == 0 {
        return None;
    }
    let chars = (used as usize / 2).min(buffer.len());
    let slice = &buffer[..chars];
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    Some(String::from_utf16_lossy(&slice[..end]))
}

/// NUL-terminated UTF-16 for a Win32 wide-string argument.
#[cfg(target_os = "windows")]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
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

/// Seed a durable cancellation record for an exact generation through the real
/// publication helpers, so a boundary test can construct the `{cause,
/// termination_effected:false}` state an ESRCH / lost / timed-out publication
/// leaves — the shape that must stay alertable. `termination_effected:true`
/// mirrors an observed OS teardown. Crate-visible for the daemon boundary tests.
#[cfg(test)]
pub(crate) fn seed_cancellation_record_for_test(
    handle: &str,
    generation: u64,
    cause: SyncCancelCause,
    termination_effected: bool,
) {
    let (owns_publication, _created) =
        begin_cancellation_publication(handle, generation, Some(cause));
    assert!(
        owns_publication,
        "test seed must own the publication for {handle} generation {generation}"
    );
    complete_cancellation_publication(handle, generation, termination_effected);
}

/// Drop a seeded (or real) cancellation record so a boundary test leaves the
/// side map clean for the next serialized test.
#[cfg(test)]
pub(crate) fn clear_cancellation_record_for_test(handle: &str, generation: u64) {
    clear_cancellation_record(handle, generation);
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
fn run_test_post_spawn_hook(
    handle: &str,
    child: &mut std::process::Child,
    containment: &mut ChildContainment,
) {
    let hook = test_post_spawn_hooks().lock().unwrap().remove(handle);
    if let Some(hook) = hook {
        // Hooks deliberately create the test fixture's descendant while this
        // function still owns both the Child and its private Job Object. A
        // failed readiness assertion must not escape that ownership boundary:
        // terminate and reap the complete tree, then preserve the original
        // panic for the test runner.
        if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            hook(child);
        })) {
            if let Err(error) = terminate_stale_spawn(handle, child, containment) {
                eprintln!(
                    "[process] failed to reap a post-spawn test fixture after panic for {handle}: {error}"
                );
            }
            std::panic::resume_unwind(payload);
        }
    }
}

#[cfg(not(test))]
fn run_test_post_spawn_hook(
    _handle: &str,
    _child: &mut std::process::Child,
    _containment: &mut ChildContainment,
) {
}

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

/// Forces the Job Object attachment outcome for one exact handle so Windows CI
/// can drive a real child through the pid-tree fallback that a failing
/// `CreateJobObjectW` / `AssignProcessToJobObject` selects in production. It
/// forces only the attachment result; the termination that follows is the
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
    test_job_assignments().lock().unwrap().remove(handle)
}

/// Injection seam for the OS termination calls themselves. It exists so a
/// forced *root* termination failure can prove that an ineffective
/// cancellation keeps `termination_effected` false — i.e. that a failed
/// teardown can never become a false suppression signal. Test-only.
#[cfg(all(test, target_os = "windows"))]
#[derive(Clone, Copy)]
enum TestWindowsTerminationResult {
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

/// Enumerate the transitive children of `root_pid` via a process snapshot.
/// Only pids reachable from the registered root are returned, so the fallback
/// below can never widen past this app's own child tree.
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
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next.is_ok() {
        rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
        entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
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

/// Fall back to the registered root pid when no Job Object was attached.
///
/// Without this, a `CreateJobObjectW` / `AssignProcessToJobObject` failure
/// makes Windows cancellation a silent no-op: nothing is terminated and the
/// caller still reports success. Descendant failures are logged for diagnosis
/// but only the ROOT termination decides `termination_effected`, because it is
/// the runner's own terminal status that is classified afterwards.
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

    // Deepest-first: terminating a parent before its children can leave the
    // grandchild reparented and outside the next snapshot.
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
        if let Err(error) = result {
            log(
                "process",
                &format!("TerminateProcess failed for pid {pid}: {error}"),
            );
        }
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
        #[cfg(all(test, target_os = "windows"))]
        if let Some(forced) = take_test_job_assignment(handle) {
            // Force ONLY the attachment outcome. Everything downstream — the
            // registry entry with no job handle, the pid-tree fallback, the
            // real TerminateProcess calls — is the unmodified production path.
            log(
                "process",
                &format!("injected Job Object attachment failure ({forced:?}) for {handle}"),
            );
            return containment;
        }
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
            // No terminal callback follows this path, so nothing will ever read
            // this generation's cancellation evidence. Release it here.
            clear_cancellation_record(handle, generation);
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
        clear_cancellation_record(&handle, generation);
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
    run_test_post_spawn_hook(handle, &mut child, &mut containment);

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

    // Hold HQ's background work under its machine-wide CPU ceiling. The child
    // already runs in its own process group (`put_in_own_process_group` above),
    // and on Unix a group leader's pid IS its pgid, so this addresses the child
    // and everything it spawns — `npx` -> `node` -> the sync runner's workers.
    // The guard lives until this function returns, and dropping it always
    // resumes the group, so no exit path can strand a stopped child.
    let _cpu_throttle = hq_desktop_core::cpu_throttle::CpuThrottle::attach(pid as i32);

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
    // The callback is the one reader of this generation's cancellation
    // evidence, so the record is released only after it has been delivered.
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
    run_test_post_spawn_hook(handle, &mut child, &mut containment);

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
/// from generation N cannot retarget a replacement registered as N+1. It
/// records no manual-sync cause, so a cancellation made through this path can
/// never suppress a runner-exit capture on its own.
pub(crate) fn cancel_process_generation_impl(
    handle: &str,
    generation: u64,
    sigkill_delay: Duration,
) -> bool {
    cancel_registered_generation(handle, generation, None, sigkill_delay).executed
}

/// Cancel exactly the generation owned by a sync initiator, recording WHY.
///
/// The returned attempt separates "this app marked and signalled that exact
/// generation" from "this app observed the OS termination take effect". Only
/// the second may later suppress the runner's non-zero exit capture.
pub fn cancel_process_for_generation(
    handle: &str,
    generation: u64,
    cause: SyncCancelCause,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    cancel_registered_generation(handle, generation, Some(cause), sigkill_delay)
}

// Lock order is intentionally non-nesting: the publication helpers release the
// cancellation-record mutex before the registry mutex is acquired, and take it
// again only after the OS call has returned.
fn cancel_registered_generation(
    handle: &str,
    generation: u64,
    cause: Option<SyncCancelCause>,
    sigkill_delay: Duration,
) -> CancellationAttempt {
    let (owns_publication, created_record) =
        begin_cancellation_publication(handle, generation, cause);
    if !owns_publication {
        // Another actor is already resolving this exact generation. Report its
        // outcome rather than racing a second OS termination against it.
        let record = cancellation_record_for_generation(handle, generation).unwrap_or_default();
        return CancellationAttempt {
            executed: cancellation_requested_for_generation(handle, generation),
            termination_effected: record.termination_effected,
        };
    }

    match cancel_generation_os(handle, generation, sigkill_delay) {
        None => {
            abandon_cancellation_publication(handle, generation, created_record);
            CancellationAttempt::default()
        }
        Some(observed_effect) => CancellationAttempt {
            executed: true,
            termination_effected: complete_cancellation_publication(
                handle,
                generation,
                observed_effect,
            ),
        },
    }
}

/// Perform the platform cancellation for one exact generation.
///
/// `None` means the generation no longer owns the handle (or its signal
/// authority was already revoked) and nothing was marked — a stale watchdog is
/// an observable no-op. `Some(effected)` reports whether an OS termination was
/// OBSERVED to take effect.
fn cancel_generation_os(handle: &str, generation: u64, sigkill_delay: Duration) -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        let mut registry = process_registry().lock().unwrap();
        let entry = registry
            .active
            .get_mut(handle)
            .filter(|entry| entry.generation == generation)?;
        if entry.signal_authority_revoked {
            return None;
        }
        entry.cancelled = true;

        let effected = match (entry.job_handle, entry.pid) {
            (Some(job), _) => {
                let job_handle = HANDLE(job as *mut std::ffi::c_void);
                match unsafe { TerminateJobObject(job_handle, 1) } {
                    Ok(()) => true,
                    Err(error) => {
                        log(
                            "process",
                            &format!(
                                "TerminateJobObject failed for {handle} generation {generation}: {error}"
                            ),
                        );
                        false
                    }
                }
            }
            // No Job Object means attachment failed. Terminating nothing here
            // is what made an app-owned cancellation a silent no-op, so fall
            // back to the registered root pid and its descendants.
            (None, Some(pid)) => terminate_windows_pid_tree(pid),
            // Cancelled before the child was attached. The mark is retained and
            // the spawn path terminates the child when it attaches.
            (None, None) => false,
        };
        let _ = sigkill_delay;
        return Some(effected);
    }

    #[cfg(unix)]
    {
        // Mark cancellation, capture the generation, and send SIGTERM under
        // one registry lock. Releasing the lock before dispatch would let the
        // wait owner reap and free this numeric process-group identity first.
        let (pid, outcome) = {
            let mut registry = process_registry().lock().unwrap();
            let entry = registry
                .active
                .get_mut(handle)
                .filter(|entry| entry.generation == generation)?;
            if entry.signal_authority_revoked {
                return None;
            }
            let Some(pid) = entry.pid else {
                entry.cancelled = true;
                return Some(false);
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
                // A vanished process group was not stopped by this actor. Keep
                // a real external kill eligible for reporting instead of
                // claiming it as a deliberate teardown after the fact.
                entry.cancelled = false;
            }
            (pid, outcome)
        };

        let effected = matches!(outcome, SignalDispatch::Delivered);
        if matches!(
            outcome,
            SignalDispatch::RefusedStale | SignalDispatch::RefusedRevoked | SignalDispatch::Esrch
        ) {
            return Some(effected);
        }

        let handle_owned = handle.to_string();
        thread::spawn(move || {
            thread::sleep(sigkill_delay);
            // Generation-scoped: a replacement that acquired the same public
            // handle resolves to a different entry and is never signalled.
            let _ = dispatch_signal_checked(&handle_owned, generation, pid, Signal::SIGKILL);
        });

        return Some(effected);
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let mut registry = process_registry().lock().unwrap();
        let entry = registry
            .active
            .get_mut(handle)
            .filter(|entry| entry.generation == generation)?;
        if entry.signal_authority_revoked {
            return None;
        }
        entry.cancelled = true;
        let _ = sigkill_delay;
        Some(false)
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
    // Stamp the app-owned cause and claim the effect publication BEFORE the
    // first signal, so a terminal callback that lands mid-teardown waits for
    // the observed outcome instead of reading a half-written record.
    let mut sigterm_delivered = Vec::with_capacity(processes.len());
    for process in processes {
        let _ = begin_cancellation_publication(
            &process.handle,
            process.generation,
            Some(SyncCancelCause::AppQuit),
        );
        let outcome = dispatch_cancelled_checked(
            &process.handle,
            process.generation,
            process.pid,
            Signal::SIGTERM,
        );
        sigterm_delivered.push(matches!(outcome, SignalDispatch::Delivered));
    }
    if !processes.is_empty() {
        thread::sleep(grace);
    }
    for (index, process) in processes.iter().enumerate() {
        let outcome = dispatch_signal_checked(
            &process.handle,
            process.generation,
            process.pid,
            Signal::SIGKILL,
        );
        // Either of this app's own signals reaching the group is an effective
        // teardown: a child killed by the SIGTERM makes the later SIGKILL ESRCH.
        let effected = sigterm_delivered[index] || matches!(outcome, SignalDispatch::Delivered);
        let _ = complete_cancellation_publication(&process.handle, process.generation, effected);
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
        let _ = cancel_process_for_generation(
            &process.handle,
            process.generation,
            SyncCancelCause::AppQuit,
            Duration::ZERO,
        );
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
///
/// Windows session end (`WM_ENDSESSION`) never produces `ExitRequested`, so the
/// session-end branch of `RunEvent::Exit` calls this too. Idempotent by
/// construction: the registry empties as children are reaped, so a second call
/// on a path that already ran is a no-op.
pub fn terminate_all_for_exit(grace: Duration) {
    APP_EXIT_REQUESTED.store(true, Ordering::Release);
    terminate_registered_processes_for_exit(&registered_processes_including_retired(), grace);
}

/// RAII lease for the updater's process-quiescence window.
///
/// A failed update preparation drops the lease and allows normal child
/// spawning to resume. A successful preparation commits it, keeping the gate
/// closed until the parent process exits and the out-of-process helper starts
/// the installer.
pub struct UpdateQuiescenceGuard {
    committed: bool,
}

impl UpdateQuiescenceGuard {
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for UpdateQuiescenceGuard {
    fn drop(&mut self) {
        if !self.committed {
            UPDATE_QUIESCE_REQUESTED.store(false, Ordering::Release);
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_pid_alive(pid: u32) -> bool {
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE;
        let _ = CloseHandle(process);
        alive
    }
}

/// Stop every registered HQ-owned process and prove the Windows processes are
/// gone before the updater lets the parent exit. New registrations remain
/// blocked for the lifetime of the returned guard.
#[cfg(target_os = "windows")]
pub fn quiesce_for_update(timeout: Duration) -> Result<UpdateQuiescenceGuard, String> {
    UPDATE_QUIESCE_REQUESTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "update process quiescence is already in progress".to_string())?;
    let guard = UpdateQuiescenceGuard { committed: false };
    // The gate is already closed, so this check is race-free: a manual sync
    // that registered first wins and defers the update; a later registration
    // observes UPDATE_QUIESCE_REQUESTED and cannot enter the install window.
    if is_registered("hq-sync") {
        return Err("Update deferred while a sync is active".to_string());
    }
    let processes = registered_processes_including_retired();
    let pids: Vec<u32> = processes.iter().map(|process| process.pid).collect();
    terminate_registered_processes_for_exit(&processes, Duration::ZERO);

    let started = std::time::Instant::now();
    while pids.iter().copied().any(windows_pid_alive) {
        if started.elapsed() >= timeout {
            return Err(format!(
                "timed out after {}ms waiting for HQ processes to exit",
                timeout.as_millis()
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(guard)
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

/// CI-only entrypoint for the `--sync-cancel-probe` flag. Runs the probe, prints
/// its JSON result to stdout, and terminates the process with the matching exit
/// code — it never returns, so the menubar app is never initialized on a probe
/// invocation.
///
/// The `std::process::exit` lives here rather than in `main.rs` on purpose: the
/// only process exit `main.rs` is allowed to carry is the Windows session-end
/// fast path pinned by `scripts/native-seam-wiring.test.ts`. This whole path is
/// gated on the non-default `sync-cancel-probe` Cargo feature and can never
/// reach a shipped build, so it adds no shippable exit anywhere.
#[cfg(feature = "sync-cancel-probe")]
pub fn run_sync_cancel_probe_main() -> ! {
    use std::io::Write as _;
    match run_sync_cancel_probe() {
        Ok(result) => {
            println!("{result}");
            // Flush explicitly before exiting: the CI harness parses this line
            // from stdout, and `std::process::exit` skips end-of-run flushing.
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("sync-cancel-probe failed: {error}");
            let _ = std::io::stderr().flush();
            std::process::exit(1);
        }
    }
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

    let generation = try_register_handle_gen(&handle)
        .ok_or_else(|| "HQ process spawning is paused for an update".to_string())?;

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

/// A file-backed protocol for Windows process-tree fixtures.
///
/// The fixture root must first publish that it is waiting, then the test opens
/// the descendant-start gate, observes the descendant's own readiness PID in
/// the real Windows process tree, and only then opens the parent PID-publication
/// gate. This intentionally never treats a sleep or one Toolhelp snapshot as a
/// lifecycle acknowledgement. Every marker is unique to a `TempDir`, so
/// concurrent test runners cannot consume one another's state.
#[cfg(all(test, target_os = "windows"))]
mod windows_test_fixture {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub(super) const DEADLINE: Duration = Duration::from_secs(30);
    const POLL: Duration = Duration::from_millis(20);
    const STILL_ACTIVE: u32 = 259;

    pub(super) fn await_bounded<F>(what: &str, mut ready: F)
    where
        F: FnMut() -> bool,
    {
        let started = Instant::now();
        while started.elapsed() < DEADLINE {
            if ready() {
                return;
            }
            thread::sleep(POLL);
        }
        panic!("timed out after {DEADLINE:?} waiting for {what}");
    }

    pub(super) fn pid_alive(pid: u32) -> bool {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let alive = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE;
            let _ = CloseHandle(process);
            alive
        }
    }

    fn powershell_quote(path: &std::path::Path) -> String {
        path.to_string_lossy().replace('\'', "''")
    }

    fn try_read_pid(path: &std::path::Path) -> Option<u32> {
        std::fs::read_to_string(path)
            .ok()?
            .trim()
            .parse::<u32>()
            .ok()
    }

    /// A PID marker is ready only after its complete numeric contents are
    /// readable. `File::exists` observes the destination before a non-atomic
    /// writer necessarily completes, so it is not a publication acknowledgement.
    fn await_pid(path: &std::path::Path, description: &str) -> u32 {
        let mut pid = None;
        await_bounded(description, || {
            pid = try_read_pid(path);
            pid.is_some()
        });
        pid.expect("a successful PID readiness check must retain the parsed PID")
    }

    /// The fixture has explicit start, descendant-ready, PID-publication, and
    /// release/exit states. `exit_delay` is deliberately controlled by the
    /// child itself so a natural delayed exit is testable without timing races.
    pub(super) struct Protocol {
        _dir: tempfile::TempDir,
        start_gate: PathBuf,
        publish_gate: PathBuf,
        release_gate: PathBuf,
        parent_ready: PathBuf,
        descendant_ready: PathBuf,
        published_pid: PathBuf,
        exit_delay_ms: u64,
    }

    impl Protocol {
        pub(super) fn new(exit_delay: Duration) -> Self {
            Self::from_tempdir(
                tempfile::tempdir().expect("Windows fixture tempdir"),
                exit_delay,
            )
        }

        /// Makes the script path itself contain spaces, exercising the native
        /// child argument forwarding that `Start-Process` flattens into one
        /// command line on Windows.
        pub(super) fn new_in_path_with_spaces(exit_delay: Duration) -> Self {
            Self::from_tempdir(
                tempfile::Builder::new()
                    .prefix("hq fixture path with spaces ")
                    .tempdir()
                    .expect("Windows fixture tempdir with spaces"),
                exit_delay,
            )
        }

        fn from_tempdir(dir: tempfile::TempDir, exit_delay: Duration) -> Self {
            let path = |name: &str| dir.path().join(name);
            Self {
                start_gate: path("allow-descendant-start"),
                publish_gate: path("allow-pid-publication"),
                release_gate: path("allow-descendant-exit"),
                parent_ready: path("parent-ready.pid"),
                descendant_ready: path("descendant-ready.pid"),
                published_pid: path("descendant-published.pid"),
                exit_delay_ms: exit_delay.as_millis().min(u128::from(u64::MAX)) as u64,
                _dir: dir,
            }
        }

        pub(super) fn spawn_args(&self) -> SpawnArgs {
            let child_script = self._dir.path().join("descendant.ps1");
            let parent_script = self._dir.path().join("parent.ps1");
            std::fs::write(
                &child_script,
                r#"param(
    [string]$ReadyPath,
    [string]$ReleasePath,
    [int]$ExitDelayMs
)
function Write-PidAtomically([string]$Path, [uint32]$Value) {
    $temporaryPath = "$Path.$([System.Guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporaryPath, "$Value")
        [System.IO.File]::Move($temporaryPath, $Path)
    } finally {
        if ([System.IO.File]::Exists($temporaryPath)) {
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}
Write-PidAtomically -Path $ReadyPath -Value $PID
while (-not [System.IO.File]::Exists($ReleasePath)) { Start-Sleep -Milliseconds 10 }
if ($ExitDelayMs -gt 0) { Start-Sleep -Milliseconds $ExitDelayMs }
exit 0
"#,
            )
            .expect("write Windows descendant fixture");
            std::fs::write(
                &parent_script,
                format!(
                    r#"function Write-PidAtomically([string]$Path, [uint32]$Value) {{
    $temporaryPath = "$Path.$([System.Guid]::NewGuid().ToString('N')).tmp"
    try {{
        [System.IO.File]::WriteAllText($temporaryPath, "$Value")
        [System.IO.File]::Move($temporaryPath, $Path)
    }} finally {{
        if ([System.IO.File]::Exists($temporaryPath)) {{
            [System.IO.File]::Delete($temporaryPath)
        }}
    }}
}}
Write-PidAtomically -Path '{parent_ready}' -Value $PID
while (-not [System.IO.File]::Exists('{start_gate}')) {{ Start-Sleep -Milliseconds 10 }}
$child = Start-Process -PassThru -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"{child_script}"', '-ReadyPath', '"{descendant_ready}"', '-ReleasePath', '"{release_gate}"', '-ExitDelayMs', '{exit_delay_ms}')
while (-not [System.IO.File]::Exists('{descendant_ready}')) {{ Start-Sleep -Milliseconds 10 }}
while (-not [System.IO.File]::Exists('{publish_gate}')) {{ Start-Sleep -Milliseconds 10 }}
Write-PidAtomically -Path '{published_pid}' -Value $child.Id
$child.WaitForExit()
exit $child.ExitCode
"#,
                    parent_ready = powershell_quote(&self.parent_ready),
                    start_gate = powershell_quote(&self.start_gate),
                    child_script = powershell_quote(&child_script),
                    descendant_ready = powershell_quote(&self.descendant_ready),
                    release_gate = powershell_quote(&self.release_gate),
                    exit_delay_ms = self.exit_delay_ms,
                    publish_gate = powershell_quote(&self.publish_gate),
                    published_pid = powershell_quote(&self.published_pid),
                ),
            )
            .expect("write Windows parent fixture");

            SpawnArgs {
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
            }
        }

        pub(super) fn await_parent_ready(&self) {
            await_bounded("the fixture parent to acknowledge its start gate", || {
                self.parent_ready.exists()
            });
        }

        /// Drive the spawn handshake after the production runner registered the
        /// root. The assertions prove actual parent/child ownership rather than
        /// accepting a PID file from a process that escaped the private tree.
        pub(super) fn start_and_publish_descendant(&self, root_pid: u32) -> u32 {
            self.await_parent_ready();
            assert!(
                !self.descendant_ready.exists(),
                "the descendant must remain blocked until the test opens its start gate"
            );
            std::fs::write(&self.start_gate, "go").expect("open descendant start gate");
            let descendant = await_pid(&self.descendant_ready, "descendant readiness PID");
            assert!(pid_alive(descendant), "the ready descendant must be live");
            await_bounded("the ready descendant to belong to the fixture root", || {
                windows_descendants(root_pid).contains(&descendant)
            });
            assert!(
                !self.published_pid.exists(),
                "the parent must not publish its descendant PID before the publication gate"
            );
            std::fs::write(&self.publish_gate, "go").expect("open PID publication gate");
            assert_eq!(
                await_pid(&self.published_pid, "published descendant PID"),
                descendant,
                "the parent must publish the same live PID that acknowledged readiness"
            );
            descendant
        }

        pub(super) fn release_descendant(&self) {
            std::fs::write(&self.release_gate, "go").expect("open descendant release gate");
        }
    }

    #[test]
    fn await_pid_retries_until_a_complete_publication_is_readable() {
        let dir = tempfile::tempdir().expect("PID readiness tempdir");
        let path = dir.path().join("ready.pid");
        std::fs::write(&path, "").expect("publish an incomplete PID marker");

        let writer_path = path.clone();
        let writer = thread::spawn(move || {
            thread::sleep(POLL * 2);
            std::fs::write(writer_path, "4242").expect("finish PID publication");
        });

        assert_eq!(
            await_pid(&path, "a complete PID after an incomplete marker"),
            4242
        );
        writer.join().expect("PID writer must not panic");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_spawn_tests {
    use super::*;
    use hq_desktop_core::sync_outcome::{
        classify_windows_exit_status, is_windows_console_control_exit,
        termination_fingerprint_token, WindowsTermination, WINDOWS_CONTROL_C_EXIT,
    };

    /// A stale-spawn test deliberately installs a replacement generation that
    /// must survive the stale child's cleanup. Keep its removal panic-safe so
    /// repeated focused runs never inherit registry or hook state from a prior
    /// failed assertion.
    struct ReplacementGeneration {
        handle: String,
        generation: Option<u64>,
    }

    impl ReplacementGeneration {
        fn current(&self) -> u64 {
            self.generation
                .expect("the replacement generation must remain active")
        }

        fn finish(&mut self) {
            test_post_spawn_hooks().lock().unwrap().remove(&self.handle);
            let generation = self
                .generation
                .take()
                .expect("the replacement generation must be active until test completion");
            assert!(deregister_generation(&self.handle, generation));
        }
    }

    impl Drop for ReplacementGeneration {
        fn drop(&mut self) {
            test_post_spawn_hooks().lock().unwrap().remove(&self.handle);
            if let Some(generation) = self.generation.take() {
                let _ = deregister_generation(&self.handle, generation);
            }
        }
    }

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
        use super::windows_test_fixture::{await_bounded, pid_alive, Protocol};
        use std::sync::atomic::{AtomicU32, Ordering};

        let protocol = Arc::new(Protocol::new(Duration::ZERO));
        let spawn = protocol.spawn_args();

        let handle = format!("windows-stale-tree-{}", Uuid::new_v4());
        let stale_generation = try_register_handle_gen(&handle).expect("acquire stale generation");
        assert!(deregister_generation(&handle, stale_generation));
        let mut replacement = ReplacementGeneration {
            handle: handle.clone(),
            generation: Some(
                try_register_handle_gen(&handle).expect("acquire replacement generation"),
            ),
        };

        let descendant_pid = Arc::new(AtomicU32::new(0));
        let hook_pid = descendant_pid.clone();
        let hook_protocol = protocol.clone();
        set_test_post_spawn_hook(&handle, move |child| {
            // The hook sits between private Job creation and the stale
            // ownership refusal. It drives the same explicit protocol as the
            // accounting fixture, proving the Job contains the descendant
            // before stale cleanup—not merely that a PID file appeared later.
            let pid = hook_protocol.start_and_publish_descendant(child.id());
            hook_pid.store(pid, Ordering::Release);
        });

        let result = run_process_impl_for_generation(&handle, stale_generation, &spawn, |_| {});

        assert!(matches!(result, Err(ProcessError::OwnershipLost { .. })));
        let pid = descendant_pid.load(Ordering::Acquire);
        assert_ne!(pid, 0, "the parent fixture must start its descendant");
        await_bounded("the stale fixture descendant to disappear", || {
            !pid_alive(pid)
        });
        assert!(
            !pid_alive(pid),
            "a stale pre-attach child and every descendant must die with its private Job Object"
        );
        assert_eq!(generation_for_handle(&handle), Some(replacement.current()));
        replacement.finish();
    }

    #[test]
    fn process_tree_fixture_forwards_paths_with_spaces_and_waits_for_pid_publication() {
        use super::windows_test_fixture::{await_bounded, pid_alive, Protocol};
        use std::sync::atomic::{AtomicU32, Ordering};

        let protocol = Arc::new(Protocol::new_in_path_with_spaces(Duration::ZERO));
        let spawn = protocol.spawn_args();
        let handle = format!("windows-spaced-fixture-{}", Uuid::new_v4());
        let descendant_pid = Arc::new(AtomicU32::new(0));
        let hook_protocol = protocol.clone();
        let hook_descendant_pid = descendant_pid.clone();
        set_test_post_spawn_hook(&handle, move |child| {
            // This is the real PowerShell parent/child fixture, not a generated
            // source assertion. It passes every forwarded path through the
            // Start-Process boundary from a directory whose name contains spaces.
            let descendant = hook_protocol.start_and_publish_descendant(child.id());
            hook_descendant_pid.store(descendant, Ordering::Release);
            hook_protocol.release_descendant();
        });

        let mut exits = Vec::new();
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Exit {
                code,
                signal,
                success,
            } = event
            {
                exits.push((code, signal, success));
            }
        })
        .expect("the spaced-path fixture must complete through the production runner");

        let descendant = descendant_pid.load(Ordering::Acquire);
        assert_ne!(descendant, 0, "the quoted descendant must publish a PID");
        await_bounded("the released spaced-path descendant to exit", || {
            !pid_alive(descendant)
        });
        assert_eq!(exits, vec![(Some(0), None, true)]);
        assert!(
            !is_registered(&handle),
            "the completed spaced-path fixture must not leave a registry entry"
        );
    }

    #[test]
    fn post_spawn_fixture_panic_reaps_the_private_tree() {
        use super::windows_test_fixture::{await_bounded, pid_alive, Protocol};
        use std::panic::{catch_unwind, AssertUnwindSafe};
        use std::sync::atomic::{AtomicU32, Ordering};

        let protocol = Arc::new(Protocol::new(Duration::ZERO));
        let spawn = protocol.spawn_args();
        let handle = format!("windows-post-spawn-panic-{}", Uuid::new_v4());
        let root_pid = Arc::new(AtomicU32::new(0));
        let descendant_pid = Arc::new(AtomicU32::new(0));
        let hook_protocol = protocol.clone();
        let hook_root_pid = root_pid.clone();
        let hook_descendant_pid = descendant_pid.clone();
        set_test_post_spawn_hook(&handle, move |child| {
            hook_root_pid.store(child.id(), Ordering::Release);
            let descendant = hook_protocol.start_and_publish_descendant(child.id());
            hook_descendant_pid.store(descendant, Ordering::Release);
            panic!("injected post-spawn fixture panic");
        });

        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _ = run_process_impl(&handle, &spawn, |_| {});
        }));
        assert!(panic.is_err(), "the injected fixture panic must reach the test");

        let root = root_pid.load(Ordering::Acquire);
        let descendant = descendant_pid.load(Ordering::Acquire);
        assert_ne!(root, 0, "the fixture root must have been observed");
        assert_ne!(descendant, 0, "the fixture descendant must have been observed");
        await_bounded("the panicking fixture root to be reaped", || !pid_alive(root));
        await_bounded("the panicking fixture descendant to be reaped", || {
            !pid_alive(descendant)
        });
        assert!(!is_registered(&handle), "a panicking hook must not register a root");
    }
}

#[cfg(test)]
mod registry_exit_order_tests {
    use super::*;

    /// Regression: a non-owning publication must never relabel the initiating
    /// actor's record. A heartbeat teardown that races an in-flight causeless
    /// Cancelled/ForceClear teardown does not own the publication, so it must not
    /// stamp `HeartbeatStall` onto that teardown's causeless record — otherwise a
    /// causeless teardown would gain a durable cause it was never meant to carry,
    /// and the watcher boundary's durable-record gate could then attribute it.
    #[test]
    fn a_non_owning_publication_never_relabels_the_initiating_cause() {
        let handle = format!("relabel-guard-{}", Uuid::new_v4());
        let generation = 1;

        // A causeless (None) publication is in flight — mirrors a Cancelled or
        // ForceClear teardown that has begun but not yet completed.
        let (owns_first, _created_first) = begin_cancellation_publication(&handle, generation, None);
        assert!(owns_first, "the first publisher owns the cycle");

        // A racing heartbeat tries to stamp HeartbeatStall while the first actor
        // still owns the pending publication.
        let (owns_second, _created_second) = begin_cancellation_publication(
            &handle,
            generation,
            Some(SyncCancelCause::HeartbeatStall),
        );
        assert!(!owns_second, "the racing actor does not own the publication");

        let cause = {
            let (records, _) = &**cancellation_records();
            let state = records.lock().unwrap();
            state
                .records
                .get(&(handle.clone(), generation))
                .and_then(|record| record.cause)
        };
        assert_eq!(
            cause, None,
            "a non-owning publication must not relabel the initiating causeless record"
        );

        clear_cancellation_record(&handle, generation);
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

// ─────────────────────────────────────────────────────────────────────────────
// HQ-DESKTOP-48 — Windows Job-attachment failure drives the pid-tree fallback
// ─────────────────────────────────────────────────────────────────────────────

/// These are black-box regressions for the branch a failing `CreateJobObjectW`
/// / `AssignProcessToJobObject` selects. Before this fix that branch terminated
/// NOTHING and still reported success, so a Windows cancellation could be a
/// silent no-op. Every assertion below is on real processes disappearing (or
/// surviving), never on an injected boolean: the seam forces only the
/// attachment outcome and the termination that follows is production code.
#[cfg(all(test, target_os = "windows"))]
mod windows_job_attachment_failure_tests {
    use super::windows_test_fixture::{await_bounded, pid_alive, Protocol, DEADLINE};
    use super::*;
    use hq_desktop_core::sync_outcome::{
        classify_runner_exit_disposition_with_cancellation, RunnerExitDisposition,
    };
    use std::time::Instant;

    type Terminal = (Option<i32>, Option<i32>, Option<CancellationRecord>);

    /// Holds the runner immediately before it acknowledges terminal teardown.
    /// Normal fixtures start open; the closed form is a deterministic proof
    /// that cleanup never treats an absent acknowledgement as a completed join.
    #[derive(Clone)]
    struct TerminalAckGate {
        released: Arc<(Mutex<bool>, Condvar)>,
        waiting: Arc<(Mutex<bool>, Condvar)>,
    }

    impl TerminalAckGate {
        fn with_released(released: bool) -> Self {
            Self {
                released: Arc::new((Mutex::new(released), Condvar::new())),
                waiting: Arc::new((Mutex::new(false), Condvar::new())),
            }
        }

        fn open() -> Self {
            Self::with_released(true)
        }

        fn blocked() -> Self {
            Self::with_released(false)
        }

        fn wait(&self) {
            let (waiting, wake) = &*self.waiting;
            *waiting.lock().unwrap() = true;
            wake.notify_all();
            let (released, wake) = &*self.released;
            let _released = wake
                .wait_while(released.lock().unwrap(), |released| !*released)
                .unwrap();
        }

        fn wait_until_waiting(&self, deadline: Duration) -> bool {
            let (waiting, wake) = &*self.waiting;
            let (waiting, timeout) = wake
                .wait_timeout_while(waiting.lock().unwrap(), deadline, |waiting| !*waiting)
                .unwrap();
            !timeout.timed_out() && *waiting
        }

        fn release(&self) {
            let (released, wake) = &*self.released;
            *released.lock().unwrap() = true;
            wake.notify_all();
        }
    }

    /// Owns the deliberately unrelated sibling through its exact `Child`
    /// handle. `Child` does not kill on drop, so every exit path (including a
    /// panic before the scope assertion) must explicitly kill and wait it.
    struct ExactChildGuard {
        child: Option<std::process::Child>,
        pid: u32,
    }

    impl ExactChildGuard {
        fn spawn() -> Self {
            let child = Command::new("cmd.exe")
                .args(["/d", "/c", "ping 127.0.0.1 -n 600 > nul"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("sibling fixture must spawn");
            let pid = child.id();
            Self {
                child: Some(child),
                pid,
            }
        }

        fn pid(&self) -> u32 {
            self.pid
        }

        fn kill_and_wait(&mut self) -> io::Result<()> {
            let Some(child) = self.child.as_mut() else {
                return Ok(());
            };
            let result = match child.try_wait()? {
                Some(_) => Ok(()),
                None => {
                    child.kill()?;
                    child.wait().map(|_| ())
                }
            };
            if result.is_ok() {
                // Keep the exact handle until wait has confirmed reaping. A
                // failed kill/wait must leave it owned for Drop's retry and
                // its diagnostic abort path.
                let _ = self.child.take();
            }
            result
        }
    }

    impl Drop for ExactChildGuard {
        fn drop(&mut self) {
            if let Err(error) = self.kill_and_wait() {
                // An unowned ten-minute sibling is worse than aborting this
                // focused test process. Preserve the exact PID in the failure
                // before an unwind can discard the only `Child` wait owner.
                eprintln!(
                    "[process] failed to kill and reap unrelated sibling fixture pid {}: {error}",
                    self.pid
                );
                // Panicking from Drop would continue unwinding, then drop the
                // exact `Child` and lose the sole wait owner. Abort keeps the
                // diagnostic above and fails this test binary without a leak.
                std::process::abort();
            }
        }
    }

    /// The fixture owns the only `Child` wait owner on a runner thread. A
    /// terminal channel turns teardown into an acknowledgement protocol rather
    /// than letting test cleanup race an eventually-finished thread.
    struct RunningFixture {
        handle: String,
        generation: u64,
        root_pid: u32,
        descendant_pid: u32,
        protocol: Protocol,
        runner: Option<thread::JoinHandle<()>>,
        terminal_rx: mpsc::Receiver<(Result<(), ProcessError>, Option<Terminal>)>,
    }

    fn start_fixture(
        label: &str,
        forced: Option<TestJobAssignmentOutcome>,
        exit_delay: Duration,
    ) -> RunningFixture {
        start_fixture_with_terminal_ack(label, forced, exit_delay, TerminalAckGate::open())
    }

    fn start_fixture_with_terminal_ack(
        label: &str,
        forced: Option<TestJobAssignmentOutcome>,
        exit_delay: Duration,
        terminal_ack: TerminalAckGate,
    ) -> RunningFixture {
        let handle = format!("{label}-{}", Uuid::new_v4());
        let generation = try_register_handle_gen(&handle).expect("fresh probe handle");
        if let Some(forced) = forced {
            force_test_job_assignment(&handle, forced);
        }

        let protocol = Protocol::new(exit_delay);
        let spawn = protocol.spawn_args();
        let runner_handle = handle.clone();
        let (terminal_tx, terminal_rx) = mpsc::sync_channel(1);
        let runner = thread::spawn(move || {
            let mut terminal = None;
            let outcome =
                run_process_impl_for_generation(&runner_handle, generation, &spawn, |event| {
                    if let ProcessEvent::Exit { code, signal, .. } = event {
                        // The reporting boundary consumes cancellation evidence
                        // here in production. Sending only after the runner
                        // returns makes this an acknowledgement that the root
                        // was actually reaped and deregistered.
                        terminal = Some((
                            code,
                            signal,
                            cancellation_record_for_generation(&runner_handle, generation),
                        ));
                    }
                });
            terminal_ack.wait();
            let _ = terminal_tx.send((outcome, terminal));
        });

        // Construct the cleanup owner before the first readiness assertion. If
        // a marker, process query, or accounting assertion panics below, Drop
        // still owns the runner, the generation, and every PID learned so far.
        let mut fixture = RunningFixture {
            handle,
            generation,
            root_pid: 0,
            descendant_pid: 0,
            protocol,
            runner: Some(runner),
            terminal_rx,
        };

        await_bounded("the fixture root to register", || {
            lookup_pid(&fixture.handle).is_some()
        });
        let root_pid = lookup_pid(&fixture.handle).expect("registered fixture root PID");
        fixture.root_pid = root_pid;
        let descendant_pid = fixture.protocol.start_and_publish_descendant(root_pid);
        fixture.descendant_pid = descendant_pid;

        let attached = process_registry()
            .lock()
            .unwrap()
            .active
            .get(&fixture.handle)
            .and_then(|entry| entry.job_handle);
        assert_eq!(
            attached.is_some(),
            forced.is_none(),
            "the requested attachment mode must match the actual registry entry"
        );

        if forced.is_none() {
            await_bounded(
                "the real Job Object to account for the acknowledged tree",
                || {
                    watcher_job_working_set_samples(&fixture.handle, fixture.generation)
                        .is_some_and(|samples| {
                            samples.iter().any(|(pid, _)| *pid == root_pid)
                                && samples.iter().any(|(pid, _)| *pid == descendant_pid)
                        })
                },
            );
        }

        fixture
    }

    fn start_fixture_with_forced_attachment_failure(
        label: &str,
        forced: TestJobAssignmentOutcome,
    ) -> RunningFixture {
        start_fixture(label, Some(forced), Duration::ZERO)
    }

    fn start_fixture_with_real_job(label: &str) -> RunningFixture {
        start_fixture(label, None, Duration::ZERO)
    }

    impl RunningFixture {
        fn cancel(&self, cause: SyncCancelCause) -> CancellationAttempt {
            cancel_process_for_generation(&self.handle, self.generation, cause, Duration::ZERO)
        }

        fn tree_is_gone(&self) -> bool {
            (self.root_pid == 0 || !pid_alive(self.root_pid))
                && (self.descendant_pid == 0 || !pid_alive(self.descendant_pid))
        }

        fn wait_for_tree_to_disappear(&self, deadline: Duration) -> bool {
            let started = Instant::now();
            while started.elapsed() < deadline {
                if self.tree_is_gone() {
                    return true;
                }
                thread::sleep(Duration::from_millis(20));
            }
            self.tree_is_gone()
        }

        /// Reap only after the runner's terminal acknowledgement. The runner
        /// owns the exact `Child`; taking its JoinHandle before that proof
        /// would reintroduce the detached-runner hole this fixture guards.
        fn receive_and_join_terminal(&mut self, deadline: Duration) -> Result<Terminal, String> {
            let (outcome, terminal) = self.terminal_rx.recv_timeout(deadline).map_err(|error| {
                format!("runner did not acknowledge terminal teardown within {deadline:?}: {error}")
            })?;
            self.runner
                .take()
                .expect("runner must have one wait owner")
                .join()
                .map_err(|_| "runner thread panicked during fixture teardown".to_string())?;
            clear_test_job_assignment(&self.handle);
            outcome.map_err(|error| {
                format!("fixture runner failed while reporting teardown: {error}")
            })?;
            terminal.ok_or_else(|| "fixture runner exited without a terminal event".to_string())
        }

        /// Attempt complete teardown without discarding any owner on failure.
        /// The returned error deliberately leaves the runner, registration, and
        /// cancellation record in place so a caller can inspect diagnostics or
        /// retry; `Drop` escalates that failure instead of silently detaching.
        fn try_teardown(&mut self, deadline: Duration) -> Result<(), String> {
            if self.runner.is_none() {
                return Ok(());
            }

            let attempt = self.cancel(SyncCancelCause::AppQuit);
            // A successful Job Object termination is the stronger containment
            // proof. Do not follow it with a later raw-PID sweep (which could
            // observe a reused PID); raw fallback is reserved for the explicit
            // failure path and the final liveness wait is authoritative.
            let fallback_required = !attempt.termination_effected;
            let root_fallback = fallback_required
                && self.root_pid != 0
                && pid_alive(self.root_pid)
                && terminate_windows_pid_tree(self.root_pid);
            let descendant_fallback = fallback_required
                && self.descendant_pid != 0
                && pid_alive(self.descendant_pid)
                && terminate_windows_pid_tree(self.descendant_pid);
            if !self.wait_for_tree_to_disappear(deadline) {
                return Err(format!(
                    "fixture teardown left owned processes live (handle={}, generation={}, root_pid={}, descendant_pid={}, cancel_effected={}, root_fallback={}, descendant_fallback={})",
                    self.handle,
                    self.generation,
                    self.root_pid,
                    self.descendant_pid,
                    attempt.termination_effected,
                    root_fallback,
                    descendant_fallback,
                ));
            }

            self.receive_and_join_terminal(deadline).map(|_| ())
        }

        fn await_terminal(&mut self) -> Terminal {
            self.receive_and_join_terminal(DEADLINE)
                .expect("the runner must acknowledge terminal teardown before the deadline")
        }

        fn assert_tree_gone(&self) {
            assert_ne!(self.root_pid, 0, "fixture root PID must be acknowledged");
            assert_ne!(
                self.descendant_pid, 0,
                "fixture descendant PID must be acknowledged"
            );
            await_bounded("the fixture root to disappear", || {
                !pid_alive(self.root_pid)
            });
            await_bounded("the acknowledged fixture descendant to disappear", || {
                !pid_alive(self.descendant_pid)
            });
        }

        fn finish_cancelled(&mut self, cause: SyncCancelCause) -> Terminal {
            let attempt = self.cancel(cause);
            assert!(attempt.executed, "the exact generation must be cancellable");
            assert!(
                attempt.termination_effected,
                "the production tree teardown must report an observed termination"
            );
            let terminal = self.await_terminal();
            self.assert_tree_gone();
            terminal
        }

        fn finish_naturally(&mut self) -> Terminal {
            self.protocol.release_descendant();
            let terminal = self.await_terminal();
            self.assert_tree_gone();
            terminal
        }
    }

    impl Drop for RunningFixture {
        fn drop(&mut self) {
            // Assertion and panic paths must retain the only runner owner
            // until all fixture processes are gone and the runner is joined.
            // Never deregister or clear cancellation state after a failed
            // attempt: that would hide a live child with no cancellation
            // authority. An unreaped fixture aborts the focused test process
            // after printing every identity needed to diagnose it.
            if let Err(error) = self.try_teardown(DEADLINE) {
                eprintln!(
                    "[process] unreaped Windows fixture: handle={}, generation={}, root_pid={}, descendant_pid={}: {error}",
                    self.handle, self.generation, self.root_pid, self.descendant_pid,
                );
                // A panic would unwind through `JoinHandle::drop`, silently
                // detach the exact runner, and recreate the bug. Abort keeps
                // the emitted diagnostics and makes the fixture failure loud.
                std::process::abort();
            }
        }
    }

    fn assert_cancelled_by_app(
        code: Option<i32>,
        signal: Option<i32>,
        record: Option<CancellationRecord>,
        cause: SyncCancelCause,
    ) {
        assert_eq!(code, Some(1), "job-object termination shape is exit code 1");
        assert_eq!(signal, None, "Windows carries no signal");
        let record = record.expect("terminal callback must see the exact-generation record");
        assert_eq!(record.cause, Some(cause));
        assert!(
            record.termination_effected,
            "an observed pid-tree termination must be recorded as effective"
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                record.cause,
                record.termination_effected,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(cause),
        );
    }

    #[test]
    fn create_job_failure_falls_back_to_the_real_pid_tree() {
        let mut fixture = start_fixture_with_forced_attachment_failure(
            "job-create-failed",
            TestJobAssignmentOutcome::CreateFailed,
        );
        let (code, signal, record) = fixture.finish_cancelled(SyncCancelCause::UserStop);
        assert_cancelled_by_app(code, signal, record, SyncCancelCause::UserStop);
    }

    #[test]
    fn assign_job_failure_falls_back_to_the_real_pid_tree() {
        let mut fixture = start_fixture_with_forced_attachment_failure(
            "job-assign-failed",
            TestJobAssignmentOutcome::AssignFailed,
        );
        let (code, signal, record) = fixture.finish_cancelled(SyncCancelCause::TimeoutWatchdog);
        assert_cancelled_by_app(code, signal, record, SyncCancelCause::TimeoutWatchdog);
    }

    #[test]
    fn watcher_job_accounting_reads_the_live_tree_and_is_generation_scoped() {
        let mut fixture = start_fixture_with_real_job("watcher-job-accounting");

        // TotalProcesses is cumulative, and the protocol already proved the
        // exact acknowledged descendant belongs to this root before this
        // accounting read. A process count of two is therefore a real whole-tree
        // reading, not a racing Toolhelp snapshot.
        let accounting = watcher_job_accounting_for_generation(&fixture.handle, fixture.generation)
            .expect("a live job must report accounting");
        assert!(
            accounting.total_processes >= 2,
            "job must count the fixture root and its acknowledged descendant, got {}",
            accounting.total_processes
        );

        // Generation-scoped (finding 3): a different generation for the same
        // handle never resolves into a reading, so a replacement watcher's memory
        // can never be reported for this generation's exit — and an absent handle
        // is never fabricated either.
        assert!(watcher_job_accounting_for_generation(
            &fixture.handle,
            fixture.generation.wrapping_add(4096)
        )
        .is_none());
        assert!(watcher_job_accounting_for_generation(
            "watcher-job-accounting-absent",
            fixture.generation
        )
        .is_none());

        let _ = fixture.finish_cancelled(SyncCancelCause::UserStop);
        assert!(
            watcher_job_accounting_for_generation(&fixture.handle, fixture.generation).is_none(),
            "terminal acknowledgement must deregister and close the fixture Job Object"
        );
    }

    #[test]
    fn watcher_job_working_set_sums_the_live_tree_and_is_generation_scoped() {
        let mut fixture = start_fixture_with_real_job("watcher-job-working-set");

        let samples = watcher_job_working_set_samples(&fixture.handle, fixture.generation)
            .expect("a live job must yield working-set samples");
        // The job holds the cmd.exe shim root AND its ping descendant, so the live
        // sample carries at least two PIDs — the exact tree the single-PID sampler
        // cannot see past. This is the memory evidence HQ-DESKTOP-4M withheld.
        assert!(
            samples.len() >= 2,
            "job sample must include the shim and its descendant, got {}",
            samples.len()
        );
        // The registered root is present, so the caller's root-must-be-present
        // guard resolves to a real sum rather than falling back.
        assert!(
            samples.iter().any(|(pid, _)| *pid == fixture.root_pid),
            "the registered root pid must be in the job's live-pid sample"
        );
        assert!(
            samples
                .iter()
                .any(|(pid, _)| *pid == fixture.descendant_pid),
            "the explicitly acknowledged descendant must be in the job's live-pid sample"
        );
        // The summed working set over the whole tree is strictly larger than the
        // registered child's own single-PID working set — the number the shipped
        // Windows sampler could not see past the shim.
        let summed: u64 = samples.iter().map(|&(_, kb)| kb.unwrap_or(0)).sum();
        let root_single = sample_pid_working_set_kb(fixture.root_pid)
            .expect("the live root must report a single-PID working set");
        assert!(
            summed > root_single,
            "tree sum {summed}KB must exceed the shim's own {root_single}KB"
        );

        // Generation-scoped (matching the accounting read): a different generation
        // for the same handle, and an absent handle, both resolve to no sample — a
        // replacement watcher's job can never be attributed to this generation.
        assert!(watcher_job_working_set_samples(
            &fixture.handle,
            fixture.generation.wrapping_add(4096)
        )
        .is_none());
        assert!(watcher_job_working_set_samples(
            "watcher-job-working-set-absent",
            fixture.generation
        )
        .is_none());

        // The working-set read closed nothing: the job is still queryable, so the
        // accounting read that runs at the real exit boundary still succeeds.
        assert!(
            watcher_job_accounting_for_generation(&fixture.handle, fixture.generation).is_some(),
            "the working-set read must not have closed the job handle"
        );

        let _ = fixture.finish_cancelled(SyncCancelCause::UserStop);
    }

    #[test]
    fn fixture_protocol_acknowledges_a_delayed_descendant_exit() {
        // This is an injected child-side delayed exit, not a test sleep. The
        // runner can finish only after the child consumes the release gate and
        // the parent has waited for it, so this covers the acknowledgement path
        // that cancellation tests otherwise reach only by forceful teardown.
        let mut fixture = start_fixture("fixture-delayed-exit", None, Duration::from_millis(250));
        let (code, signal, record) = fixture.finish_naturally();
        assert_eq!(code, Some(0));
        assert_eq!(signal, None);
        assert_eq!(
            record, None,
            "a natural delayed exit must not gain cancellation evidence"
        );
    }

    #[test]
    fn fixture_protocol_isolated_under_repeated_parallel_use() {
        for cycle in 0..2 {
            let mut job = start_fixture(&format!("parallel-job-{cycle}"), None, Duration::ZERO);
            let mut fallback = start_fixture(
                &format!("parallel-fallback-{cycle}"),
                Some(TestJobAssignmentOutcome::AssignFailed),
                Duration::ZERO,
            );
            let job_handle = job.handle.clone();
            let job_generation = job.generation;
            let fallback_handle = fallback.handle.clone();
            let fallback_generation = fallback.generation;

            let (job_attempt, fallback_attempt) = thread::scope(|scope| {
                let job = scope.spawn(|| {
                    cancel_process_for_generation(
                        &job_handle,
                        job_generation,
                        SyncCancelCause::UserStop,
                        Duration::ZERO,
                    )
                });
                let fallback = scope.spawn(|| {
                    cancel_process_for_generation(
                        &fallback_handle,
                        fallback_generation,
                        SyncCancelCause::TimeoutWatchdog,
                        Duration::ZERO,
                    )
                });
                (
                    job.join()
                        .expect("parallel job cancellation must not panic"),
                    fallback
                        .join()
                        .expect("parallel fallback cancellation must not panic"),
                )
            });
            assert!(job_attempt.executed && job_attempt.termination_effected);
            assert!(fallback_attempt.executed && fallback_attempt.termination_effected);

            let (code, signal, record) = job.await_terminal();
            job.assert_tree_gone();
            assert_cancelled_by_app(code, signal, record, SyncCancelCause::UserStop);
            let (code, signal, record) = fallback.await_terminal();
            fallback.assert_tree_gone();
            assert_cancelled_by_app(code, signal, record, SyncCancelCause::TimeoutWatchdog);
        }
    }

    #[test]
    fn failed_root_termination_never_becomes_a_suppression_signal() {
        let mut fixture = start_fixture_with_forced_attachment_failure(
            "job-fallback-ineffective",
            TestJobAssignmentOutcome::CreateFailed,
        );

        // Force ONLY the root TerminateProcess to fail. The cancellation runs
        // on this thread, so the thread-local injection applies to it.
        set_test_windows_termination_results(vec![
            TestWindowsTerminationResult::OpenProcess(true),
            TestWindowsTerminationResult::TerminateProcess(false),
        ]);
        let attempt = cancel_process_for_generation(
            &fixture.handle,
            fixture.generation,
            SyncCancelCause::UserStop,
            Duration::ZERO,
        );
        set_test_windows_termination_results(Vec::new());

        assert!(
            attempt.executed,
            "the generation is still marked cancelled even when termination fails"
        );
        assert!(
            !attempt.termination_effected,
            "a failed root termination must never be reported as effective"
        );
        assert!(
            pid_alive(fixture.root_pid),
            "the injection must have prevented the real termination"
        );

        // Clean up for real through the production fallback, then prove the
        // ineffective cancellation still classifies as an alertable exit.
        let root_pid = fixture.root_pid;
        assert!(terminate_windows_pid_tree(root_pid));
        let (code, signal, record) = fixture.await_terminal();
        fixture.assert_tree_gone();
        assert_eq!(code, Some(1));
        assert_eq!(signal, None);
        let record = record.expect("record must survive to the terminal callback");
        assert_eq!(record.cause, Some(SyncCancelCause::UserStop));
        assert!(
            !record.termination_effected,
            "the app never observed its own termination take effect"
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                record.cause,
                record.termination_effected,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
        );
    }

    #[test]
    fn fixture_teardown_retains_ownership_when_every_termination_path_fails() {
        let mut fixture = start_fixture_with_forced_attachment_failure(
            "job-teardown-failure",
            TestJobAssignmentOutcome::CreateFailed,
        );

        // Inject failure into the exact-generation cancellation and both
        // fixture-only fallback attempts. This must return an error WITHOUT
        // detaching the runner or erasing the still-live generation's
        // cancellation evidence; a normal retry below owns the real cleanup.
        set_test_windows_termination_results(vec![
            TestWindowsTerminationResult::OpenProcess(true),
            TestWindowsTerminationResult::TerminateProcess(false),
            TestWindowsTerminationResult::OpenProcess(true),
            TestWindowsTerminationResult::TerminateProcess(false),
            TestWindowsTerminationResult::OpenProcess(true),
            TestWindowsTerminationResult::TerminateProcess(false),
        ]);
        let cleanup = fixture.try_teardown(Duration::from_millis(100));
        set_test_windows_termination_results(Vec::new());

        assert!(
            cleanup.is_err(),
            "teardown must not report success while either owned process is live"
        );
        assert!(
            fixture.runner.is_some(),
            "the sole runner owner must be retained"
        );
        assert!(
            pid_alive(fixture.root_pid),
            "the injected root must still be live"
        );
        assert!(
            pid_alive(fixture.descendant_pid),
            "the injected descendant must still be live"
        );
        assert_eq!(
            generation_for_handle(&fixture.handle),
            Some(fixture.generation),
            "failed teardown must retain the live generation rather than deregistering it"
        );
        assert!(
            cancellation_record_for_generation(&fixture.handle, fixture.generation).is_some(),
            "failed teardown must retain cancellation diagnostics for the retry"
        );

        fixture
            .try_teardown(DEADLINE)
            .expect("a retry without injected failures must kill, reap, and join");
        assert!(fixture.runner.is_none());
        assert!(fixture.tree_is_gone());
        assert_eq!(generation_for_handle(&fixture.handle), None);
        assert!(
            cancellation_record_for_generation(&fixture.handle, fixture.generation).is_none(),
            "only the acknowledged runner cleanup may release cancellation state"
        );
    }

    #[test]
    fn fixture_teardown_never_accepts_a_missing_runner_acknowledgement() {
        let terminal_ack = TerminalAckGate::blocked();
        let mut fixture = start_fixture_with_terminal_ack(
            "job-terminal-ack-missing",
            Some(TestJobAssignmentOutcome::AssignFailed),
            Duration::ZERO,
            terminal_ack.clone(),
        );

        // The real fallback kills both processes. The runner has reaped the
        // exact Child but remains blocked before its terminal send, proving a
        // missing acknowledgement cannot be mistaken for a joined runner.
        let (cleanup, gate_reached) = thread::scope(|scope| {
            let cleanup = scope.spawn(|| fixture.try_teardown(Duration::from_secs(1)));
            let gate_reached = terminal_ack.wait_until_waiting(DEADLINE);
            // If startup itself broke before the runner reached the fault
            // gate, open it before joining so this test reports that original
            // failure instead of deadlocking in the scoped worker.
            if !gate_reached {
                terminal_ack.release();
            }
            let cleanup = match cleanup.join() {
                Ok(cleanup) => cleanup,
                Err(_) => {
                    terminal_ack.release();
                    panic!("acknowledgement fault-injection cleanup must not panic");
                }
            };
            (cleanup, gate_reached)
        });
        let tree_is_gone = fixture.tree_is_gone();
        let runner_is_retained = fixture.runner.is_some();

        // The successful fault-injection path waits for `try_teardown` to
        // time out first, then opens the gate before any assertion can strand
        // the deliberately blocked runner in this test process.
        terminal_ack.release();
        fixture
            .try_teardown(DEADLINE)
            .expect("the released acknowledgement must permit an exact runner join");

        assert!(
            gate_reached,
            "runner did not reach the terminal acknowledgement fault gate"
        );
        assert!(
            cleanup.is_err(),
            "an absent runner acknowledgement must fail cleanup"
        );
        assert!(tree_is_gone, "the production fallback must reap the tree");
        assert!(
            runner_is_retained,
            "cleanup must retain the unjoined runner until it acknowledges"
        );
        assert!(fixture.runner.is_none());
    }

    #[test]
    fn unrelated_sibling_guard_kills_and_waits_during_unwind() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        use std::sync::atomic::{AtomicU32, Ordering};

        let sibling_pid = Arc::new(AtomicU32::new(0));
        let panic_pid = sibling_pid.clone();
        let panic_result = catch_unwind(AssertUnwindSafe(move || {
            let sibling = ExactChildGuard::spawn();
            panic_pid.store(sibling.pid(), Ordering::Release);
            panic!("injected assertion after unrelated sibling startup");
        }));

        assert!(panic_result.is_err(), "the injected assertion must unwind");
        let pid = sibling_pid.load(Ordering::Acquire);
        assert_ne!(pid, 0, "the sibling guard must publish its exact child PID");
        await_bounded("the unwound sibling guard to reap its exact child", || {
            !pid_alive(pid)
        });
    }

    #[test]
    fn pid_tree_fallback_never_widens_past_the_registered_tree() {
        // A sibling that is NOT part of the registered tree.
        let mut sibling = ExactChildGuard::spawn();
        let sibling_pid = sibling.pid();

        let mut fixture = start_fixture_with_forced_attachment_failure(
            "job-fallback-scope",
            TestJobAssignmentOutcome::AssignFailed,
        );
        assert!(
            fixture.descendant_pid != sibling_pid,
            "sibling must not be inside the registered tree"
        );
        let (code, signal, record) = fixture.finish_cancelled(SyncCancelCause::UserStop);

        assert!(
            pid_alive(sibling_pid),
            "the fallback must never terminate a process outside the registered tree"
        );

        assert_cancelled_by_app(code, signal, record, SyncCancelCause::UserStop);

        sibling
            .kill_and_wait()
            .expect("the exact sibling fixture must be reaped on the success path");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HQ-DESKTOP-48 — a stale generation can never reach a replacement handle
// ─────────────────────────────────────────────────────────────────────────────

/// Real-child proof that generation A's delayed SIGKILL escalation cannot
/// signal, cancel, or deregister generation B after B has acquired the same
/// public handle — and that A's own cancellation evidence stays A's.
#[cfg(all(test, unix))]
mod cross_generation_escalation_tests {
    use super::*;
    use std::time::Instant;

    const DEADLINE: Duration = Duration::from_secs(30);
    const POLL: Duration = Duration::from_millis(25);
    /// Long enough that A's escalation is still pending while B is registered,
    /// short enough that the bounded wait below stays well inside CI limits.
    const ESCALATION_DELAY: Duration = Duration::from_millis(750);

    fn await_bounded<F>(what: &str, mut ready: F)
    where
        F: FnMut() -> bool,
    {
        let started = Instant::now();
        while started.elapsed() < DEADLINE {
            if ready() {
                return;
            }
            thread::sleep(POLL);
        }
        panic!("timed out after {DEADLINE:?} waiting for {what}");
    }

    fn long_running() -> SpawnArgs {
        SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "sleep 600".to_string()],
            cwd: None,
            env: None,
        }
    }

    type Terminal = Option<(Option<i32>, Option<i32>, Option<CancellationRecord>)>;

    fn start_generation(
        handle: &str,
        generation: u64,
        spawn: SpawnArgs,
    ) -> thread::JoinHandle<Terminal> {
        let handle = handle.to_string();
        thread::spawn(move || {
            let mut terminal = None;
            let _ = run_process_impl_for_generation(&handle, generation, &spawn, |event| {
                if let ProcessEvent::Exit { code, signal, .. } = event {
                    terminal = Some((
                        code,
                        signal,
                        cancellation_record_for_generation(&handle, generation),
                    ));
                }
            });
            terminal
        })
    }

    fn pid_alive(pid: u32) -> bool {
        signal::kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    #[test]
    fn stale_escalation_cannot_reach_a_replacement_generation() {
        let handle = format!("cross-generation-{}", Uuid::new_v4());

        // ── Generation A: real child, cancelled with a real escalation armed ──
        let generation_a = try_register_handle_gen(&handle).expect("fresh handle");
        let runner_a = start_generation(&handle, generation_a, long_running());
        await_bounded("generation A to attach its child", || {
            lookup_pid(&handle).is_some()
        });
        let pid_a = lookup_pid(&handle).expect("generation A pid");

        let attempt = cancel_process_for_generation(
            &handle,
            generation_a,
            SyncCancelCause::UserStop,
            ESCALATION_DELAY,
        );
        assert!(attempt.executed);
        assert!(
            attempt.termination_effected,
            "SIGTERM was delivered to generation A's own process group"
        );

        // A's evidence must reach A's terminal callback and no one else's.
        let (code_a, signal_a, record_a) = runner_a
            .join()
            .expect("generation A runner must not panic")
            .expect("generation A must deliver a terminal exit");
        assert_eq!(code_a, None, "a SIGTERMed child carries no exit code");
        assert_eq!(signal_a, Some(libc::SIGTERM));
        let record_a = record_a.expect("generation A must see its own record");
        assert_eq!(record_a.cause, Some(SyncCancelCause::UserStop));
        assert!(record_a.termination_effected);
        await_bounded("generation A's child to be reaped", || !pid_alive(pid_a));

        // ── Generation B: same public handle, brand-new generation ──
        let generation_b = try_register_handle_gen(&handle).expect("handle must be reusable");
        assert_ne!(generation_a, generation_b);
        let runner_b = start_generation(&handle, generation_b, long_running());
        await_bounded("generation B to attach its child", || {
            lookup_pid(&handle).is_some()
        });
        let pid_b = lookup_pid(&handle).expect("generation B pid");
        assert_ne!(pid_a, pid_b);

        // The escalation's own body, invoked with A's retained identity while B
        // owns the handle: it must refuse rather than resolve through B.
        assert_eq!(
            dispatch_signal_checked(&handle, generation_a, pid_a, Signal::SIGKILL),
            SignalDispatch::RefusedStale,
            "a stale generation must never signal through a replacement handle"
        );

        // A's real escalation thread is still pending. Let it fire, then prove
        // it changed nothing about B. The wait is an upper bound on when the
        // escalation could run — a longer wait only makes this stricter.
        thread::sleep(ESCALATION_DELAY * 3);

        assert!(
            pid_alive(pid_b),
            "generation B's child must still be running"
        );
        assert_eq!(
            generation_for_handle(&handle),
            Some(generation_b),
            "generation B must still own the public handle"
        );
        assert!(
            !is_cancelled_for_generation(&handle, generation_b),
            "generation B must not inherit generation A's cancellation"
        );
        assert!(
            cancellation_record_for_generation(&handle, generation_b).is_none(),
            "generation B must have no cancellation evidence of its own"
        );
        assert!(
            cancellation_record_for_generation(&handle, generation_a).is_none(),
            "generation A's record must be released once its callback consumed it"
        );

        // Tear B down through its own generation and let it finish.
        let attempt_b = cancel_process_for_generation(
            &handle,
            generation_b,
            SyncCancelCause::TimeoutWatchdog,
            // Generous, so the SIGTERM this asserts on can never lose a race
            // with its own escalation. The test does not wait for it.
            Duration::from_secs(5),
        );
        assert!(attempt_b.executed);
        let (_, signal_b, record_b) = runner_b
            .join()
            .expect("generation B runner must not panic")
            .expect("generation B must deliver a terminal exit");
        assert_eq!(signal_b, Some(libc::SIGTERM));
        assert_eq!(
            record_b.expect("generation B record").cause,
            Some(SyncCancelCause::TimeoutWatchdog),
        );

        // ── Generation C: a clean run proves nothing leaked ──
        let generation_c = try_register_handle_gen(&handle).expect("handle must be free again");
        let runner_c = start_generation(
            &handle,
            generation_c,
            SpawnArgs {
                cmd: "sh".to_string(),
                args: vec!["-c".to_string(), "exit 0".to_string()],
                cwd: None,
                env: None,
            },
        );
        let (code_c, signal_c, record_c) = runner_c
            .join()
            .expect("generation C runner must not panic")
            .expect("generation C must deliver a terminal exit");
        assert_eq!(code_c, Some(0));
        assert_eq!(signal_c, None);
        assert!(
            record_c.is_none(),
            "an uncancelled generation must carry no cancellation record"
        );
        assert!(
            !is_registered(&handle),
            "the handle must be fully released after a clean run"
        );
        assert!(
            cancellation_records().0.lock().unwrap().records.is_empty()
                || cancellation_record_for_generation(&handle, generation_c).is_none(),
            "no cancellation record may outlive this handle"
        );
    }
}

/// Windows fault-provenance artifact E2E (HQ-DESKTOP-4X).
///
/// Runs the REAL `wevtapi` reader against the machine's REAL Windows Application
/// log and reproduces a genuine abort through the same `cmd.exe` batch-shim shape
/// production uses. Windows Error Reporting's asynchronous crash capture is not
/// guaranteed on a headless CI host (the plan's own risk register calls this
/// out), so the assertions prove what IS deterministic: the reader runs bounded
/// and panic-free against genuine OS output, and every token it produces is a
/// fixed allow-listed constant — never a raw record byte. A strong PID/code-scoped
/// attribution, when the runner's WER did capture our crash, is surfaced
/// best-effort and logged rather than gating the test.
#[cfg(all(test, target_os = "windows"))]
mod watcher_fault_e2e_tests {
    use super::*;
    use hq_desktop_core::watcher_fault::{parse_application_error_event, WatcherFaultBinary};

    fn is_allow_listed_token(token: &str) -> bool {
        WatcherFaultBinary::ALL
            .iter()
            .any(|binary| binary.as_str() == token)
    }

    /// Assert every image/module the parser extracts from the REAL log is a fixed
    /// allow-listed token — proof the reader can never copy a path, username, or
    /// product string out of genuine WER output — and that the query is bounded.
    fn assert_reader_is_content_safe_and_bounded() {
        let xmls =
            query_wer_application_error_xml(WER_MAX_RECORDS, Duration::from_secs(3)).unwrap_or_default();
        assert!(
            xmls.len() <= WER_MAX_RECORDS,
            "the reader must honour its record cap"
        );
        for xml in &xmls {
            let Some(record) = parse_application_error_event(xml) else {
                continue;
            };
            assert!(
                is_allow_listed_token(record.image.as_str()),
                "faulting image token escaped the allow-list: {}",
                record.image.as_str()
            );
            assert!(
                is_allow_listed_token(record.module.as_str()),
                "faulting module token escaped the allow-list: {}",
                record.module.as_str()
            );
        }
        eprintln!(
            "watcher-fault E2E: reader returned {} real Application Error record(s)",
            xmls.len()
        );
    }

    // These two spawn real processes and query the live Windows Application log,
    // so they are `#[ignore]`d out of the parallel `cargo test --bins` pool (where
    // they would starve the 30s-bounded real-process teardown regression) and run
    // only in their own isolated windows-check step via `--include-ignored`.
    #[test]
    #[ignore = "real-process + live-event-log E2E; run in the dedicated windows-check step"]
    fn the_real_reader_reads_the_real_application_log_content_safely() {
        assert_reader_is_content_safe_and_bounded();
    }

    #[test]
    #[ignore = "real-process + live-event-log E2E; run in the dedicated windows-check step"]
    fn a_node_child_aborts_and_the_reader_stays_content_safe_afterward() {
        // Reproduce the production mechanism: a Node runner that hard-aborts.
        // `process.abort()` terminates the child abnormally with a 0xC0000409-class
        // status; the exact code varies by CRT/Node version, so the deterministic
        // assertion is only that it did NOT exit cleanly. Node is invoked with
        // separate argv (no shell), so no fragile cmd quoting can turn a genuine
        // abort into a vacuous "module not found" pass.
        let status = Command::new("node")
            .args(["-e", "process.abort()"])
            .status()
            .expect("spawn node abort child");
        assert!(
            !status.success(),
            "the child must abort abnormally, got a clean exit"
        );
        eprintln!(
            "watcher-fault E2E: cmd-shim child aborted with status {:?}",
            status.code()
        );

        // Give WER a bounded moment, then run the real reader again. The assertion
        // is deterministic (content-safety on whatever records exist); a captured
        // node.exe 0xC0000409 abort is surfaced as the strong signal without
        // gating the test on WER having logged it on this particular host.
        thread::sleep(Duration::from_secs(2));
        let xmls =
            query_wer_application_error_xml(WER_MAX_RECORDS, Duration::from_secs(3)).unwrap_or_default();
        let mut named_node_abort = false;
        for xml in &xmls {
            let Some(record) = parse_application_error_event(xml) else {
                continue;
            };
            assert!(is_allow_listed_token(record.image.as_str()));
            assert!(is_allow_listed_token(record.module.as_str()));
            if record.image == WatcherFaultBinary::NodeExe
                && record.exception_code == Some(0xC000_0409)
            {
                named_node_abort = true;
            }
        }
        eprintln!(
            "watcher-fault E2E: node.exe 0xC0000409 record present in WER log = {named_node_abort}"
        );
    }

    /// The DEFERRED read runs bounded, panic-free, and resolves to a distinct
    /// non-binding token that NEVER names an image, against genuine OS output.
    /// With an empty sampled-PID set and a window in 1970 (nothing can bind), it
    /// must reach its own deadline within the horizon and render one of the
    /// resolved non-binding tokens — not the ambiguous old `no_record` — with the
    /// `unavailable` image sentinel and populated counters. This is the boundedness
    /// + content-safety half the plan gates deterministically; a real captured
    /// 0xC0000409 is the separate best-effort signal above.
    #[test]
    #[ignore = "real-process + live-event-log E2E; run in the dedicated windows-check step"]
    fn the_deferred_read_is_bounded_and_resolves_without_naming_an_image() {
        use hq_desktop_core::watcher_fault::WatcherFaultProvenance;
        let budget = Duration::from_secs(3);
        let started = std::time::Instant::now();
        let outcome = read_watcher_fault(&[], 0xC000_0409, 0, 1, budget);
        let elapsed = started.elapsed();
        assert!(
            elapsed <= budget + Duration::from_secs(5),
            "the deferred read must stay bounded by its horizon, took {elapsed:?}"
        );
        assert!(
            matches!(
                outcome.provenance,
                WatcherFaultProvenance::QueryUnreadable
                    | WatcherFaultProvenance::RejectedUnparsable
                    | WatcherFaultProvenance::DeadlineExpired
                    | WatcherFaultProvenance::RejectedOutOfWindow
                    | WatcherFaultProvenance::RejectedCodeMismatch
            ),
            "deferred read produced an unexpected provenance: {}",
            outcome.provenance_token()
        );
        assert!(!outcome.provenance.is_bound());
        assert_eq!(outcome.image_token(), "unavailable");
        assert_eq!(outcome.module_token(), "unavailable");
        assert!(outcome.counters.sweeps >= 1, "at least one sweep must have run");
        eprintln!(
            "watcher-fault E2E: deferred read resolved to {} in {}ms (counters {})",
            outcome.provenance_token(),
            outcome.counters.ms_to_verdict,
            outcome.counters_tag(),
        );
    }
}
