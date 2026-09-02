//! Windows session-end attribution readers, shared by BOTH child-exit capture
//! seams.
//!
//! A `DBG_TERMINATE_PROCESS`/no-signal child exit is the one shape that may be a
//! Windows session teardown rather than a genuine crash. Naming which one it was
//! needs two content-safe readers:
//!
//! - [`current_windows_terminator_attribution`] — the message-driven session-end
//!   observer's current attribution (and it installs the deferral re-read probe);
//! - [`current_session_end_latch_reading_for_exit`] — the durable, process-global
//!   session-end latch, read only on that one exit shape.
//!
//! Both were private to the daemon (auto-sync watcher) route; the manual `Sync
//! Now` runner-exit seam needs the SAME two readers so a manual runner torn down
//! at Windows session end names its terminator exactly as the watcher route does
//! (HQ-DESKTOP-5X). Extracting them here — bodies unchanged, cfg gates unchanged
//! — lets both seams call one shared source instead of one route hand-rolling a
//! copy. The deferral lifecycle (the probe re-read that resolves a held-back
//! send) stays owned by the watcher route: the manual seam is a pure reader and
//! never registers a deferral.

use std::sync::OnceLock;

use tauri::AppHandle;
// `try_state` is a `tauri::Manager` method, so the trait must be in scope. Only
// the Windows reader calls it, so the import (like the reader) is Windows-gated.
#[cfg(target_os = "windows")]
use tauri::Manager;

use hq_desktop_core::sync_outcome::{SessionEndLatchReading, WindowsTerminatorAttribution};
// Only the Windows arms compare against this status; gate it so a non-Windows
// build does not warn on an unused import.
#[cfg(target_os = "windows")]
use hq_desktop_core::sync_outcome::WINDOWS_SESSION_TERMINATE_EXIT;

#[cfg(target_os = "windows")]
use crate::commands::session_end_observer::SessionEndObserverHandle;

/// One read of the session-end observer: the attribution capture policy
/// consumes, plus the readiness that explains it. Both are fixed-vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionEndReading {
    pub(crate) attribution: WindowsTerminatorAttribution,
    pub(crate) readiness: &'static str,
}

#[cfg(target_os = "windows")]
fn read_session_end_attribution<R: tauri::Runtime>(app: &AppHandle<R>) -> SessionEndReading {
    match app.try_state::<SessionEndObserverHandle>() {
        Some(observer) => SessionEndReading {
            attribution: observer.tracker().attribution_now(),
            readiness: observer.tracker().readiness().class_name(),
        },
        None => SessionEndReading {
            attribution: WindowsTerminatorAttribution::ObserverUnavailable,
            readiness: "unavailable",
        },
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn current_windows_terminator_attribution<R: tauri::Runtime>(
    app: &AppHandle<R>,
    code: Option<i32>,
    signal: Option<i32>,
) -> Option<WindowsTerminatorAttribution> {
    if code != Some(WINDOWS_SESSION_TERMINATE_EXIT) || signal.is_some() {
        return None;
    }
    // Install the re-read probe from the same handle that produces the reading
    // below, so a deferral created downstream can ask this same observer again
    // once its grace has elapsed. Idempotent, and deliberately sited here: this
    // is the one function that both owns an `AppHandle` and runs before any
    // deferral can exist, so the probe can never be missing when one is.
    install_session_end_attribution_probe(app);
    Some(read_session_end_attribution(app).attribution)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn current_windows_terminator_attribution<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    _code: Option<i32>,
    _signal: Option<i32>,
) -> Option<WindowsTerminatorAttribution> {
    None
}

/// Read the durable session-end latch at the exit boundary, but ONLY on the
/// `DBG_TERMINATE_PROCESS`/no-signal shape — the one exit that may consult it, so
/// a genuine fault on any other code can never be suppressed by a coincident
/// session end. The latch is a process-global, so this needs no `AppHandle`.
#[cfg(target_os = "windows")]
pub(crate) fn current_session_end_latch_reading_for_exit(
    code: Option<i32>,
    signal: Option<i32>,
) -> SessionEndLatchReading {
    if code != Some(WINDOWS_SESSION_TERMINATE_EXIT) || signal.is_some() {
        return SessionEndLatchReading::Unavailable;
    }
    crate::commands::session_end_latch::current_session_end_latch_reading()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn current_session_end_latch_reading_for_exit(
    _code: Option<i32>,
    _signal: Option<i32>,
) -> SessionEndLatchReading {
    SessionEndLatchReading::Unavailable
}

/// Re-read the observer after a grace, from wherever the deferral resolves.
///
/// The exit callback owns an `AppHandle`; the bounded task that resolves the
/// deferral does not, and threading one through every watcher-exit signature
/// would put a Tauri handle in the pure decision path. A process-global probe
/// keeps that path handle-free while still asking the real observer.
type SessionEndAttributionProbe = Box<dyn Fn() -> Option<SessionEndReading> + Send + Sync>;

static SESSION_END_ATTRIBUTION_PROBE: OnceLock<SessionEndAttributionProbe> = OnceLock::new();

#[cfg(target_os = "windows")]
fn install_session_end_attribution_probe<R: tauri::Runtime>(app: &AppHandle<R>) {
    if SESSION_END_ATTRIBUTION_PROBE.get().is_some() {
        return;
    }
    let app = app.clone();
    let _ = SESSION_END_ATTRIBUTION_PROBE
        .set(Box::new(move || Some(read_session_end_attribution(&app))));
}

/// The reading a deferral resolves against. `None` means no observer could be
/// consulted at all, which fails closed: the held-back event is sent.
pub(crate) fn current_session_end_reading() -> Option<SessionEndReading> {
    SESSION_END_ATTRIBUTION_PROBE
        .get()
        .and_then(|probe| probe())
}
