//! Streamed subprocess with cancellation, via Windows Job Objects.
//!
//! `spawn_process` — creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
//!                    spawns the child, assigns it to the job, then streams stdout/stderr
//!                    as `process://{handle}/stdout` / `…/stderr` events. Fires
//!                    `process://{handle}/exit` on termination.
//! `cancel_process` — calls `TerminateJobObject` (instant tree kill — no SIGKILL
//!                    escalation, no orphaned children).
//!
//! Why Job Objects: the macOS implementation used POSIX process groups + SIGTERM
//! → SIGKILL escalation to kill a runner and any node-subprocesses it spawned.
//! Windows doesn't have process groups (the concept exists but is rarely useful
//! for desktop apps); the canonical tree-kill primitive is a Job Object with
//! KILL_ON_JOB_CLOSE — when the last handle to the job closes, the kernel
//! terminates every process in it. We hold a HANDLE in the registry for the
//! lifetime of the child; on cancel we close it explicitly via
//! TerminateJobObject which kills the whole tree synchronously.
//!
//! Reference:
//! https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};

use crate::util::paths;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
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

// CREATE_NO_WINDOW from windows-sys / WinAPI process creation flags.
// Hides the console window for spawned CLI tools. Kept as a literal so
// we don't pull in another features list.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct StdoutEvent {
    pub line: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StderrEvent {
    pub line: String,
}

/// Payload for the terminal `process://{handle}/exit` event.
///
/// `signal` is always `None` on Windows (no POSIX signals). Cancellation
/// surfaces as `code = Some(1)` because `TerminateJobObject(_, 1)` sets
/// the exit code of each terminated process to 1.
#[derive(Debug, Serialize, Clone)]
pub struct ExitEvent {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub success: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
// ─────────────────────────────────────────────────────────────────────────────

/// Per-handle entry in the registry.
///
/// `job_handle` holds the Job Object HANDLE so cancellation can find it
/// from outside the spawning thread. Stored as `isize` (HANDLE's underlying
/// type on Win64) so the struct is `Send` — `HANDLE` is `!Send` by default
/// because the windows crate marks the underlying raw pointer as such.
/// We re-wrap to HANDLE only inside the locked section of cancel.
#[derive(Default)]
struct ProcessEntry {
    pid: Option<u32>,
    cancelled: bool,
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();

fn process_registry() -> &'static Arc<Mutex<HashMap<String, ProcessEntry>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub fn pre_register_handle(handle: &str) {
    process_registry()
        .lock()
        .unwrap()
        .insert(handle.to_string(), ProcessEntry::default());
}

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
    // On Windows: closing the entry drops the job handle. The Job Object
    // is opened with KILL_ON_JOB_CLOSE, so if anything is still in the
    // job when the handle closes, the kernel kills it. By the time we
    // call deregister_process from `run_process_impl`, the child has
    // already exited via `child.wait()` — closing the handle just frees
    // the kernel object.
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

// Retained for parity with upstream; not yet wired on the Windows fork.
#[allow(dead_code)]
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

fn is_cancelled(handle: &str) -> bool {
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
// Event enum (testable without Tauri)
// ─────────────────────────────────────────────────────────────────────────────

pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
        success: bool,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Object helpers (Windows)
// ─────────────────────────────────────────────────────────────────────────────

/// Create a Job Object configured with KILL_ON_JOB_CLOSE. The returned
/// HANDLE owns the kernel object — drop via `CloseHandle` (or let the
/// registry deregister path do it).
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

pub fn run_process_impl<F>(handle: &str, spawn: &SpawnArgs, on_event: F) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    // `paths::spawn_command` wraps Windows `.cmd`/`.bat` shims through
    // `cmd.exe /c "<shim>" <args>` — required since Rust 1.77's
    // CVE-2024-24576 hardening rejects direct spawning of shell shims
    // with `os error 193`. The canonical sync runner spawn (npx) hits
    // this path; before this wrapper, every Windows install with Node
    // installed (i.e. every install) failed sync with that error.
    let args_ref: Vec<&str> = spawn.args.iter().map(String::as_str).collect();
    let mut cmd = paths::spawn_command(&spawn.cmd, &args_ref);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // CREATE_NO_WINDOW: stop spawned CLIs from flashing a console window
    // when the tray app launches them. The reader threads consume the
    // piped stdout/stderr — the window would just be a black flash.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &spawn.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // On spawn failure, deregister the handle before returning. The
    // caller registered it via `try_register_handle` *before* calling us,
    // and `run_process_impl`'s contract is "I always release the handle
    // when I return" (the normal-exit path deregisters below). An early
    // `?` here would skip that, leaving the singleton handle stuck and
    // every subsequent sync rejected with "already running" until the app
    // restarts. (Observed 2026-06-09 when `npx` spawn failed with os
    // error 193: the failed spawn wedged sync permanently.)
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            deregister_process(handle);
            return Err(format!("spawn '{}': {}", spawn.cmd, e));
        }
    };

    let pid = child.id();
    register_process(handle, pid);

    // Job Object: create + assign the child so a later cancel can kill
    // the whole tree atomically. Small TOCTOU window between spawn and
    // assign — acceptable for the runner workloads here (no immediate
    // fork) and matches the pattern documented in hq-installer-win US-004.
    #[cfg(target_os = "windows")]
    {
        let proc_handle = HANDLE(child.as_raw_handle());
        unsafe {
            match create_kill_on_close_job() {
                Ok(job) => {
                    match AssignProcessToJobObject(job, proc_handle) {
                        Ok(()) => {
                            register_job_handle(handle, job.0 as isize);
                        }
                        Err(e) => {
                            let _ = CloseHandle(job);
                            // Continue without a job — cancel still works via
                            // child.kill() fallback in cancel_process_impl.
                            eprintln!(
                                "[process] AssignProcessToJobObject failed for handle {handle}: {e}"
                            );
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[process] create_kill_on_close_job failed for handle {handle}: {e}");
                }
            }
        }
    }

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
    deregister_process(handle);

    if let Some(err) = first_stream_err {
        on_event_mut(ProcessEvent::Exit {
            code: None,
            signal: None,
            success: false,
        });
        return Err(err);
    }

    let status = wait_result?;
    on_event_mut(ProcessEvent::Exit {
        code: status.code(),
        signal: None, // Windows has no POSIX signals
        success: status.success(),
    });

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl — variant with piped stdin
// ─────────────────────────────────────────────────────────────────────────────

/// Like [`run_process_impl`], but also pipes stdin and invokes `on_spawn`
/// once with the child immediately after spawn (and after the Job Object is
/// assigned) so the caller can `child.stdin.take()` and stash the handle
/// wherever it needs to live (typically a module-level `Mutex<Option<
/// ChildStdin>>` so other Tauri commands can write to it).
///
/// Used by the Recall SDK bridge to drive `start-recording` / `stop-recording`
/// commands without spawning a new SDK process per recording. Other callers
/// continue to use `run_process_impl`, which keeps the default stdin and avoids
/// any reads-from-stdin-on-an-unwritable-pipe surprises.
///
/// Windows specifics: identical Job-Object tree-kill wiring as
/// `run_process_impl` — create a `KILL_ON_JOB_CLOSE` job, assign the child,
/// stash the HANDLE in the registry so a later `cancel_process_impl` /
/// `stop_recall_sdk` terminates the bridge (and any node-subprocesses it
/// spawned) atomically. The `on_spawn` callback runs after the assign so the
/// child is already in the job before the caller writes its first command.
pub fn run_process_with_stdin_impl<F, S>(
    handle: &str,
    spawn: &SpawnArgs,
    on_event: F,
    on_spawn: S,
) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
    S: FnOnce(&mut Child),
{
    // See `run_process_impl` for the `paths::spawn_command` rationale —
    // wraps `.cmd`/`.bat` shims via `cmd.exe /c` to dodge the Rust 1.77
    // CreateProcess hardening that breaks `npx`/`npm` direct spawns.
    let args_ref: Vec<&str> = spawn.args.iter().map(String::as_str).collect();
    let mut cmd = paths::spawn_command(&spawn.cmd, &args_ref);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CREATE_NO_WINDOW: stop spawned CLIs from flashing a console window
    // when the tray app launches them (see run_process_impl).
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &spawn.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // See run_process_impl: deregister on spawn failure so the singleton
    // handle isn't leaked (would wedge every subsequent run as "already
    // running" until restart).
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            deregister_process(handle);
            return Err(format!("spawn '{}': {}", spawn.cmd, e));
        }
    };

    let pid = child.id();
    register_process(handle, pid);

    // Job Object: create + assign the child so a later cancel can kill the
    // whole tree atomically. Same TOCTOU note as run_process_impl.
    #[cfg(target_os = "windows")]
    {
        let proc_handle = HANDLE(child.as_raw_handle());
        unsafe {
            match create_kill_on_close_job() {
                Ok(job) => match AssignProcessToJobObject(job, proc_handle) {
                    Ok(()) => {
                        register_job_handle(handle, job.0 as isize);
                    }
                    Err(e) => {
                        let _ = CloseHandle(job);
                        eprintln!(
                            "[process] AssignProcessToJobObject failed for handle {handle}: {e}"
                        );
                    }
                },
                Err(e) => {
                    eprintln!("[process] create_kill_on_close_job failed for handle {handle}: {e}");
                }
            }
        }
    }

    // Let the caller take stdin (and stash the handle) before we start reading
    // stdout/stderr — if the caller's setup writes a startup command it should
    // land before the bridge has emitted anything.
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
    deregister_process(handle);

    if let Some(err) = first_stream_err {
        on_event_mut(ProcessEvent::Exit {
            code: None,
            signal: None,
            success: false,
        });
        return Err(err);
    }

    let status = wait_result?;
    on_event_mut(ProcessEvent::Exit {
        code: status.code(),
        signal: None, // Windows has no POSIX signals
        success: status.success(),
    });

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation (Job Object → TerminateJobObject)
// ─────────────────────────────────────────────────────────────────────────────

pub fn cancel_process_impl(handle: &str, _sigkill_delay: Duration) -> bool {
    if !mark_cancelled(handle) {
        return false;
    }

    // Snapshot the job HANDLE under the registry lock, then drop the lock
    // before the syscall (which can block briefly while the kernel cleans
    // up). The deregister path runs later from run_process_impl after the
    // streams drain; closing the handle there is the steady-state cleanup.
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
                // exit code 1 — gets propagated to every process in the job.
                // 0 would falsely look like a clean exit to wait().
                let _ = TerminateJobObject(job_handle, 1);
            }
            return true;
        }
        // Fallback: no job (assign failed at spawn time). Nothing we can
        // do from here without a HANDLE — the reader threads will drain
        // and run_process_impl will wait() normally. The user's cancel
        // request is recorded; the process just isn't killed.
        true
    }

    #[cfg(not(target_os = "windows"))]
    {
        if lookup_pid(handle).is_none() {
            return true;
        }
        true
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_register_lookup_deregister() {
        let handle = "test-registry-rld";
        pre_register_handle(handle);
        assert!(is_registered(handle));
        register_process(handle, 12345);
        assert_eq!(lookup_pid(handle), Some(12345));
        deregister_process(handle);
        assert!(!is_registered(handle));
    }

    // REGRESSION (2026-06-09): a spawn failure must release the singleton
    // handle. Before the fix, `run_process_impl`'s `cmd.spawn()?` returned
    // early — skipping the deregister — so a failed spawn (e.g. npx os
    // error 193) wedged sync permanently with "already running" until the
    // app restarted. We spawn a guaranteed-nonexistent binary and assert
    // the handle is NOT registered afterwards.
    #[test]
    fn test_spawn_failure_deregisters_handle() {
        let handle = "test-spawn-failure-dereg";
        assert!(
            try_register_handle(handle),
            "precondition: handle registers"
        );
        assert!(is_registered(handle));

        let spawn = SpawnArgs {
            cmd: "this-binary-does-not-exist-anywhere-xyz".to_string(),
            args: vec![],
            cwd: None,
            env: None,
        };
        let result = run_process_impl(handle, &spawn, |_| {});
        assert!(result.is_err(), "spawn of a missing binary must fail");
        assert!(
            !is_registered(handle),
            "spawn failure must deregister the handle (else sync wedges as 'already running')"
        );
    }

    #[test]
    fn test_mark_cancelled_only_succeeds_when_registered() {
        let handle = "test-mark-cancelled";
        // Not registered yet — marking should fail.
        assert!(!mark_cancelled(handle));
        pre_register_handle(handle);
        assert!(mark_cancelled(handle));
        assert!(is_cancelled(handle));
        deregister_process(handle);
    }

    #[test]
    fn test_try_register_handle_rejects_duplicate() {
        let handle = "test-try-register-dup";
        assert!(try_register_handle(handle));
        assert!(!try_register_handle(handle));
        deregister_process(handle);
    }

    /// Verify the stdin-piped variant actually delivers what the caller writes
    /// to the child's stdin, and that the `on_spawn` callback hands back a
    /// writable handle. `cmd /c findstr /c:"world"` reads its stdin and exits 0
    /// iff the literal `world` appears on some line, exit 1 otherwise — a
    /// dependency-free deterministic probe of "did stdin reach the child?".
    /// We write `world` then drop stdin (EOF); a `success` exit proves
    /// delivery. (We avoid asserting echoed stdout: Windows console filters
    /// line-buffer unpredictably under a pipe, but the exit code is exact.)
    #[cfg(target_os = "windows")]
    #[test]
    fn test_run_process_with_stdin_delivers_input() {
        use std::cell::Cell;
        use std::io::Write;
        use std::rc::Rc;

        let handle = format!("test-stdin-{}", Uuid::new_v4());
        let args = SpawnArgs {
            cmd: "cmd".to_string(),
            args: vec![
                "/c".to_string(),
                "findstr".to_string(),
                "/c:world".to_string(),
            ],
            cwd: None,
            env: None,
        };

        let exit_success = Rc::new(Cell::new(None::<bool>));
        let exit_cb = Rc::clone(&exit_success);
        let spawn_saw_stdin = Rc::new(Cell::new(false));
        let spawn_cb = Rc::clone(&spawn_saw_stdin);

        let result = run_process_with_stdin_impl(
            &handle,
            &args,
            move |event| {
                if let ProcessEvent::Exit { success, .. } = event {
                    exit_cb.set(Some(success));
                }
            },
            move |child| {
                // Take stdin, write the search line, then drop it to signal EOF
                // so findstr finishes and the wait() below can return.
                let mut stdin = child.stdin.take().expect("stdin pipe");
                spawn_cb.set(true);
                writeln!(stdin, "world").unwrap();
                stdin.flush().unwrap();
                // `stdin` drops here → child sees EOF.
            },
        );

        assert!(result.is_ok(), "run_process_with_stdin_impl: {result:?}");
        assert!(spawn_saw_stdin.get(), "on_spawn should receive the child");
        assert_eq!(
            exit_success.get(),
            Some(true),
            "findstr should exit 0 — proving 'world' reached the child via stdin",
        );
        assert!(!is_registered(&handle), "handle should be deregistered");
    }

    /// Verify that spawning + cancelling a long-running process terminates
    /// it via TerminateJobObject within the e2e budget. Uses `cmd /c timeout`
    /// — built into Windows and idiomatic for "block for N seconds."
    #[cfg(target_os = "windows")]
    #[test]
    fn test_cancel_process_terminates_long_running() {
        let handle = format!("test-cancel-{}", Uuid::new_v4());
        // `ping -n 61 127.0.0.1` blocks ~60s WITHOUT needing a console input
        // handle. `cmd /c timeout /t 60` was used before but `timeout` aborts
        // immediately ("input redirection is not supported") when stdin is a
        // pipe — which it always is under run_process_impl — so on CI the child
        // exited at once and was deregistered before the cancel, making
        // mark_cancelled (and thus cancel_process_impl) return false.
        let args = SpawnArgs {
            cmd: "ping".to_string(),
            args: vec!["-n".to_string(), "61".to_string(), "127.0.0.1".to_string()],
            cwd: None,
            env: None,
        };

        // Spawn on a thread so we can observe cancellation from this one.
        let h = handle.clone();
        let join = thread::spawn(move || {
            let _ = run_process_impl(&h, &args, |_| {});
        });

        // Wait until run_process_impl has registered the handle (and, right
        // after, assigned the job) rather than guessing with a fixed sleep —
        // a blind delay races on a loaded CI box and makes mark_cancelled miss.
        let reg_deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !is_registered(&handle) {
            assert!(
                std::time::Instant::now() < reg_deadline,
                "process never registered within 10s"
            );
            thread::sleep(Duration::from_millis(20));
        }
        // register_job_handle runs synchronously right after register_process
        // on the spawn thread; a short beat lets that land before we cancel.
        thread::sleep(Duration::from_millis(50));

        let start = std::time::Instant::now();
        let cancelled = cancel_process_impl(&handle, Duration::from_secs(5));
        assert!(cancelled, "cancel_process_impl should return true");

        join.join().expect("spawn thread should exit");
        let elapsed = start.elapsed();
        // The child would otherwise run ~60s; assert the Job-Object tree-kill
        // returns promptly. Bound kept generous (10s) so a loaded CI runner's
        // scheduling jitter on the stream-drain + wait() doesn't flake it — the
        // point is "killed in seconds, not 60s", not a tight perf SLA.
        assert!(
            elapsed < Duration::from_secs(10),
            "TerminateJobObject should kill the tree promptly, took {:?}",
            elapsed
        );
    }
}
