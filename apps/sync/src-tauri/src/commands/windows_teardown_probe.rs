//! Pull-based Windows session-teardown probe (HQ-DESKTOP-4N, r2).
//!
//! The push-only session-end observer can only ever attribute a watcher
//! `DBG_TERMINATE_PROCESS` exit that Windows *announced* with a window message
//! (`WM_QUERYENDSESSION` / `WM_ENDSESSION` / `WM_WTSSESSION_CHANGE`). A forced
//! end-session (`ExitWindowsEx(EWX_FORCE)`, forced logoff/restart) terminates a
//! windowless child WITHOUT delivering any of those, so the observer stays
//! `unattributed_no_signal` and the r1 deferral fails closed into a false
//! "watcher exited unexpectedly" alert.
//!
//! This module adds the missing evidence dimension: it *asks the OS* whether the
//! session is tearing down, rather than waiting to be told. Two sources, both
//! message-independent:
//!
//!  1. `GetSystemMetrics(SM_SHUTTINGDOWN)` — a synchronous, microsecond flag that
//!     answers "is this session shutting down" needing no message and no handle;
//!  2. a bounded, reverse `EvtQuery` over the System channel for the documented
//!     shutdown/logoff-initiation records (User32 1074, Kernel-General 13,
//!     Kernel-Power 109), modelled exactly on `query_wer_application_error_xml`
//!     in `process.rs` — own per-query and total budgets, every handle closed,
//!     returning `Unavailable` (not `None`) when the channel cannot be opened so
//!     "unreadable" stays distinct from "no record".
//!
//! All interpretation is pure and lives in `hq_desktop_core::sync_outcome`
//! (`teardown_verdict`, `classify_teardown_log_record`), so the decision table
//! and content-safety are unit-tested off Windows. Here is only the Win32 I/O.
//!
//! Every path is bounded by a compile-time budget: no poll loop without a
//! deadline, no unbounded wait. Nothing here runs on the watcher exit callback —
//! the log sweep is kicked at deferral registration and runs concurrently inside
//! the existing 6s grace, and the free `SM_SHUTTINGDOWN` flag is read at
//! resolution — so supervisor recovery and process teardown are never delayed.

use hq_desktop_core::sync_outcome::{
    teardown_verdict, ShuttingDownReading, TeardownLogClass, TeardownVerdict,
};

#[cfg(target_os = "windows")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "windows")]
use std::time::Duration;

/// The content-safe teardown reading a deferral resolves against. Every field
/// is a fixed-vocabulary token; nothing here can carry a path, host, user,
/// session id, timestamp, or raw event-log fragment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeardownReading {
    pub verdict: TeardownVerdict,
    pub shutting_down: ShuttingDownReading,
    pub log: TeardownLogClass,
}

impl TeardownReading {
    /// The reading for a platform or path that cannot consult the OS at all.
    /// Maps to `Unknown`, which fails closed to a capture.
    pub fn unavailable() -> Self {
        Self {
            verdict: TeardownVerdict::Unknown,
            shutting_down: ShuttingDownReading::Unavailable,
            log: TeardownLogClass::Unavailable,
        }
    }
}

// ── Windows implementation ──────────────────────────────────────────────────

/// Newest-first cap on System-channel records pulled per sweep. A handful is far
/// more than the one relevant initiation record while keeping the scan bounded.
#[cfg(target_os = "windows")]
const TEARDOWN_MAX_RECORDS: usize = 12;

/// Hard cap on the concurrent log sweep. It runs off the exit path, inside the
/// 6s grace, so this only bounds the sweep worker itself.
#[cfg(target_os = "windows")]
const TEARDOWN_READ_BUDGET: Duration = Duration::from_millis(4000);

/// Per-sweep budget for one EvtQuery/EvtNext/EvtRender pass.
#[cfg(target_os = "windows")]
const TEARDOWN_PER_QUERY_BUDGET: Duration = Duration::from_millis(500);

/// Sleep between sweeps while waiting for a record to be published.
#[cfg(target_os = "windows")]
const TEARDOWN_RETRY_INTERVAL: Duration = Duration::from_millis(300);

/// Only records within this window of the sweep are considered, so a stale
/// shutdown record from an earlier session can never confirm an unrelated kill.
/// Applied in the query itself via `timediff(@SystemTime)`.
#[cfg(target_os = "windows")]
const TEARDOWN_RECORD_MAX_AGE_MS: u64 = 180_000;

/// The cached result of the concurrent log sweep. `None` = sweep not completed
/// yet; `Some(class)` = completed with that class (which may itself be
/// `None`/`Unavailable`). Read at grace resolution.
#[cfg(target_os = "windows")]
static TEARDOWN_LOG_SWEEP: OnceLock<Mutex<Option<TeardownLogClass>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn teardown_log_sweep_slot() -> &'static Mutex<Option<TeardownLogClass>> {
    TEARDOWN_LOG_SWEEP.get_or_init(|| Mutex::new(None))
}

/// Kick the bounded System-channel log sweep on a worker thread. Called at
/// deferral registration so it completes concurrently INSIDE the existing 6s
/// grace; it never runs on the exit callback. Idempotent per deferral: it resets
/// the cache to "not yet swept" and repopulates it. A no-op on non-Windows.
#[cfg(target_os = "windows")]
pub fn kick_teardown_log_sweep() {
    {
        let mut slot = teardown_log_sweep_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = None;
    }
    std::thread::spawn(|| {
        let class = read_system_teardown_log_class();
        let mut slot = teardown_log_sweep_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(class);
    });
}

/// Read the current teardown reading: the free `SM_SHUTTINGDOWN` flag combined
/// with the cached concurrent log sweep. Handle-free, so the grace resolver can
/// call it without a Tauri handle.
#[cfg(target_os = "windows")]
pub fn read_teardown_reading() -> TeardownReading {
    let shutting_down = read_shutting_down_now();
    // If the sweep has not completed, treat the log half as unreadable — which
    // contributes `Unknown` unless `SM_SHUTTINGDOWN` alone already confirms.
    let log = teardown_log_sweep_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .unwrap_or(TeardownLogClass::Unavailable);
    let verdict = teardown_verdict(shutting_down, log);
    TeardownReading {
        verdict,
        shutting_down,
        log,
    }
}

/// Read `GetSystemMetrics(SM_SHUTTINGDOWN)`. Nonzero means the session is ending.
/// This never fails on Windows, so it is only ever `Yes`/`No` here.
#[cfg(target_os = "windows")]
fn read_shutting_down_now() -> ShuttingDownReading {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: `GetSystemMetrics` is a pure read of a global session metric; it
    // takes no handle, allocates nothing, and cannot fail here.
    let shutting_down = unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) };
    if shutting_down != 0 {
        ShuttingDownReading::Yes
    } else {
        ShuttingDownReading::No
    }
}

/// Sweep the System channel for a fresh shutdown/logoff-initiation record and
/// return its content-safe class. Polls within a bounded budget because the
/// record may be published slightly after the child dies; every handle it opens
/// it closes. `Unavailable` when the channel cannot be opened at all (so the
/// verdict cannot mistake "unreadable" for "verifiably not tearing down"),
/// `None` when the channel is readable but holds no bracketing record.
#[cfg(target_os = "windows")]
fn read_system_teardown_log_class() -> TeardownLogClass {
    use hq_desktop_core::sync_outcome::classify_teardown_log_record;
    let deadline = std::time::Instant::now() + TEARDOWN_READ_BUDGET;
    let mut query_ever_ran = false;
    loop {
        if let Some(xmls) =
            query_system_teardown_xml(TEARDOWN_MAX_RECORDS, TEARDOWN_PER_QUERY_BUDGET)
        {
            query_ever_ran = true;
            // Newest-first: the first bracketing record wins.
            for xml in &xmls {
                let class = classify_teardown_log_record(xml);
                if class.is_bracketing() {
                    return class;
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return if query_ever_ran {
                TeardownLogClass::None
            } else {
                TeardownLogClass::Unavailable
            };
        }
        std::thread::sleep(TEARDOWN_RETRY_INTERVAL);
    }
}

/// Query the System channel for the documented shutdown/logoff-initiation
/// records within `TEARDOWN_RECORD_MAX_AGE_MS`, newest-first, capped and
/// budgeted, rendering each to event XML for the pure classifier. Mirrors
/// `process::query_wer_application_error_xml` exactly. `None` means the channel
/// itself could not be opened (distinct from an empty-but-successful query).
#[cfg(target_os = "windows")]
fn query_system_teardown_xml(max_records: usize, budget: Duration) -> Option<Vec<String>> {
    use std::time::Instant;
    use windows_sys::Win32::System::EventLog::{
        EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryReverseDirection,
    };

    let channel = to_wide("System");
    let query = to_wide(&format!(
        "*[System[((Provider[@Name='User32'] and (EventID=1074)) \
         or (Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=13)) \
         or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=109))) \
         and TimeCreated[timediff(@SystemTime) <= {TEARDOWN_RECORD_MAX_AGE_MS}]]]"
    ));
    let deadline = Instant::now() + budget;
    let mut out: Vec<String> = Vec::new();

    // SAFETY: standard wevtapi query loop, mirroring process.rs. `results` and
    // each pulled event handle are closed exactly once; buffers are sized from
    // the API's own reported need.
    unsafe {
        let results = EvtQuery(
            0,
            channel.as_ptr(),
            query.as_ptr(),
            EvtQueryChannelPath | EvtQueryReverseDirection,
        );
        if results == 0 {
            // The channel could not be opened — absence of a reader, not of a
            // teardown. Kept distinct from an empty-but-successful query.
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
/// Two-call size-then-fill; returns `None` on any failure. Mirrors
/// `process::render_event_xml`.
#[cfg(target_os = "windows")]
unsafe fn render_event_xml(event: isize) -> Option<String> {
    use windows_sys::Win32::System::EventLog::{EvtRender, EvtRenderEventXml};
    let mut needed: u32 = 0;
    let mut props: u32 = 0;
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

// ── Non-Windows fallbacks ───────────────────────────────────────────────────

/// A no-op on non-Windows: there is no session-shutdown flag to sweep for.
#[cfg(not(target_os = "windows"))]
pub fn kick_teardown_log_sweep() {}

/// Non-Windows never has an OS teardown to read, so the reading is always
/// `Unavailable` → `Unknown`, which fails closed to a capture.
#[cfg(not(target_os = "windows"))]
pub fn read_teardown_reading() -> TeardownReading {
    TeardownReading::unavailable()
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    /// Real-OS read, no mocks: on a healthy CI runner the session is NOT
    /// shutting down, so `SM_SHUTTINGDOWN` reads 0 and the reading must be
    /// `Absent` or `Unknown` — and can NEVER be `Confirmed`. This runs under the
    /// windows-check job's `cargo test --target x86_64-pc-windows-msvc --bins`
    /// step against the real OS.
    #[test]
    fn a_healthy_runner_is_never_confirmed_tearing_down() {
        let shutting_down = read_shutting_down_now();
        assert_eq!(
            shutting_down,
            ShuttingDownReading::No,
            "a CI runner is not shutting down"
        );
        let reading = read_teardown_reading();
        assert_ne!(
            reading.verdict,
            TeardownVerdict::Confirmed,
            "the probe must never fabricate a confirmation on a healthy runner"
        );
    }

    /// Real EvtQuery against the System channel: it must open unelevated and
    /// return `Some(..)` (possibly empty) within its budget, closing every
    /// handle. This proves the reader works against a real Windows environment,
    /// and that an unreadable channel would fail closed to `Unavailable`.
    #[test]
    fn the_system_channel_opens_unelevated_and_closes_its_handles() {
        let xmls = query_system_teardown_xml(TEARDOWN_MAX_RECORDS, TEARDOWN_PER_QUERY_BUDGET);
        assert!(
            xmls.is_some(),
            "the System channel must open unelevated on a stock runner"
        );
        // A stock runner has not been forced-shut-down mid-test, so the recent
        // window holds no bracketing record; the class is None, never bracketing.
        let class = read_system_teardown_log_class();
        assert!(
            !class.is_bracketing(),
            "a healthy runner must not surface a bracketing teardown record"
        );
    }
}
