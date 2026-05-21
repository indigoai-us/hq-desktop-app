//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — terminates the process tree.
//!
//! ## US-002 state
//!
//! Stripped: `nix::sys::signal::{self, Signal}`, `nix::unistd::Pid`,
//! `std::os::unix::process::CommandExt::process_group`,
//! `std::os::unix::process::ExitStatusExt::signal`. US-004 rewrites
//! `run_process_impl` + `cancel_process_impl` on top of Job Objects
//! (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `TerminateJobObject`) so child
//! processes can be killed as a tree without POSIX signal escalation.
//!
//! Until US-004 lands, both `run_process_impl` and `cancel_process_impl`
//! return errors / no-op respectively, and a small wrapper `cargo check`
//! suite exercises the registry only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Arguments for `spawn_process`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

/// Payload for `process://{handle}/stdout` events.
#[derive(Debug, Serialize, Clone)]
pub struct StdoutEvent {
    pub line: String,
}

/// Payload for `process://{handle}/stderr` events.
#[derive(Debug, Serialize, Clone)]
pub struct StderrEvent {
    pub line: String,
}

/// Payload for the terminal `process://{handle}/exit` event.
///
/// `signal` is `Some(N)` on POSIX when the OS killed the process with a
/// signal. On Windows there are no Unix signals, so `signal` is always
/// `None` and `code` carries the `GetExitCodeProcess` value (cancellation
/// surfaces as `code = Some(-1)` set by `cancel_process_impl`).
#[derive(Debug, Serialize, Clone)]
pub struct ExitEvent {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub success: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ProcessEntry {
    pid: Option<u32>,
    cancelled: bool,
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
            },
        );
    }
}

pub fn deregister_process(handle: &str) {
    process_registry().lock().unwrap().remove(handle);
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
// Pure impl (US-004 fills in)
// ─────────────────────────────────────────────────────────────────────────────

pub fn run_process_impl<F>(_handle: &str, _spawn: &SpawnArgs, _on_event: F) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    Err("process: run_process_impl not implemented yet (US-004 wires Job Objects)".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation (US-004 fills in)
// ─────────────────────────────────────────────────────────────────────────────

pub fn cancel_process_impl(handle: &str, _sigkill_delay: Duration) -> bool {
    // Mark the registry entry cancelled so a slow-start spawn sees the
    // cancellation. The actual TerminateJobObject call lands in US-004.
    if !mark_cancelled(handle) {
        return false;
    }
    if lookup_pid(handle).is_none() {
        return true;
    }
    true
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
