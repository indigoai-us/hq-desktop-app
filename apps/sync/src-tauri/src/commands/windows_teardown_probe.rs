//! Pull-based Windows teardown probe (HQ-DESKTOP-4N, r2).
//!
//! The session-end observer is push-only: it can suppress a false "watcher
//! exited unexpectedly" alert only when Windows ANNOUNCED the teardown with a
//! `WM_QUERYENDSESSION`/`WM_ENDSESSION` message. A forced end-session
//! (`ExitWindowsEx` with `EWX_FORCE`, and the equivalent forced logoff/restart
//! paths) terminates a windowless child WITHOUT delivering any such message, so
//! the observer stays empty for the whole grace and the alert fails closed into
//! the same false report both post-r1 recurrences show.
//!
//! This module adds the missing evidence dimension by *asking the OS* rather
//! than waiting to be told, through two independent, bounded pull sources:
//!
//!   1. `GetSystemMetrics(SM_SHUTTINGDOWN)` — a synchronous, handle-free flag
//!      that answers "is this session shutting down" in microseconds, even when
//!      Windows sent no message. Sampled inline at exit and again at resolution.
//!   2. A bounded reverse `EvtQuery` over the **System** channel for the
//!      shutdown/logoff *initiation* records (User32 1074, Kernel-General 13,
//!      Kernel-Power 109), modelled exactly on
//!      [`crate::commands::process`]'s WER Application-Error reader — its own
//!      per-query and total budgets, every handle closed, and `None`
//!      (unreadable) kept distinct from `Some`-but-empty (readable, no record).
//!
//! The three-state verdict, the parser, and the bracketing-time comparison are
//! all pure and live in `hq_desktop_core::sync_outcome`; this module is only the
//! platform glue that feeds them real observations. Every path is bounded by a
//! compile-time budget — no poll loop without a deadline, no unbounded wait —
//! and nothing here runs inside the watcher-exit callback except the free
//! `SM_SHUTTINGDOWN` read.

use hq_desktop_core::sync_outcome::{TeardownLogReading, TeardownShuttingDown};
use std::sync::{Arc, OnceLock};

/// Read-only diagnostic command: the live session's current `SM_SHUTTINGDOWN`
/// state as a fixed content-safe token (`yes` / `no` / `unavailable`). It reports
/// only the free flag read — never a raw event-log record, path, user, host, or
/// timestamp — so it is safe to invoke from the E2E automation bridge against the
/// real built binary. On a healthy, non-shutting-down session it reports `no`,
/// which is what proves the probe answers to the OS state and not to any message:
/// a bare `WM_QUERYENDSESSION` delivered to the app does not set this flag.
/// Non-Windows builds report the `unavailable` sentinel.
#[tauri::command]
pub fn session_end_teardown_probe_status() -> &'static str {
    sample_shuttingdown().class_name()
}

/// A handle to a concurrently-running System-channel sweep whose result the
/// deferral's resolver reads once the grace has elapsed. Cheap to clone and
/// carried alongside the held-back payload; platform-agnostic so the deferral
/// machinery in `daemon.rs` stays free of `cfg` noise.
#[derive(Clone, Debug)]
pub struct TeardownSweepHandle {
    cell: Arc<OnceLock<TeardownLogReading>>,
}

impl TeardownSweepHandle {
    /// A sweep whose result has not been published yet. Only the Windows sweep
    /// producer creates one; every other platform hands back an `unavailable`
    /// handle directly.
    #[cfg(target_os = "windows")]
    fn pending() -> Self {
        Self {
            cell: Arc::new(OnceLock::new()),
        }
    }

    /// A handle that will never produce a reading. Used on non-Windows and as
    /// the default a payload carries before a sweep has been kicked, so a
    /// deferral that is never registered for a real sweep still reads
    /// `Unavailable` and therefore fails closed to a send.
    pub fn unavailable() -> Self {
        let cell = Arc::new(OnceLock::new());
        let _ = cell.set(TeardownLogReading::Unavailable);
        Self { cell }
    }

    /// Non-blocking read of the completed sweep. Returns `Unavailable` if the
    /// sweep has not published a result yet — never expected in production, where
    /// the sweep's total budget sits strictly inside the grace, but the safe
    /// fail-closed answer if it ever were.
    pub fn reading(&self) -> TeardownLogReading {
        self.cell
            .get()
            .copied()
            .unwrap_or(TeardownLogReading::Unavailable)
    }
}

impl Default for TeardownSweepHandle {
    fn default() -> Self {
        Self::unavailable()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows implementation
// ─────────────────────────────────────────────────────────────────────────────

/// Hard cap on the whole System-channel sweep. Chosen strictly under
/// [`SESSION_END_GRACE_MS`](hq_desktop_core::sync_outcome::SESSION_END_GRACE_MS)
/// (6000ms) so the sweep, kicked concurrently at deferral registration, always
/// completes and caches its verdict before the resolver reads it — the deferral
/// still resolves at exactly the grace and the probe never extends it.
#[cfg(target_os = "windows")]
const TEARDOWN_SWEEP_TOTAL_BUDGET: std::time::Duration = std::time::Duration::from_millis(4500);

/// Per-sweep budget for one `EvtQuery`/`EvtNext`/`EvtRender` pass.
#[cfg(target_os = "windows")]
const TEARDOWN_PER_QUERY_BUDGET: std::time::Duration = std::time::Duration::from_millis(500);

/// Sleep between sweeps while waiting for the OS to asynchronously publish a
/// shutdown/logoff record that may land a moment after the child already died.
#[cfg(target_os = "windows")]
const TEARDOWN_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(300);

/// Cap on records pulled per sweep. Only the newest few System-channel
/// teardown-id events can be contemporaneous; this bounds the reverse scan.
#[cfg(target_os = "windows")]
const TEARDOWN_MAX_RECORDS: usize = 16;

/// Read `GetSystemMetrics(SM_SHUTTINGDOWN)`. Free, handle-free, and cannot fail:
/// nonzero means the current session is shutting down. Safe to call inline in the
/// watcher-exit callback.
#[cfg(target_os = "windows")]
pub fn sample_shuttingdown() -> TeardownShuttingDown {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: a pure read of a process-global system flag. It takes no handle,
    // allocates nothing, closes nothing, and has no failure mode.
    let shutting_down = unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) };
    if shutting_down != 0 {
        TeardownShuttingDown::Yes
    } else {
        TeardownShuttingDown::No
    }
}

/// Kick the bounded System-channel sweep on a detached worker thread so it runs
/// concurrently with the grace and off the exit path. The returned handle's
/// cached result is read at resolution; the thread ends on its own within its
/// budget.
#[cfg(target_os = "windows")]
pub fn spawn_teardown_log_sweep() -> TeardownSweepHandle {
    let handle = TeardownSweepHandle::pending();
    let cell = handle.cell.clone();
    // Anchor the bracketing window on "now" ≈ the watcher exit instant.
    let exit_unix_ms = chrono::Utc::now().timestamp_millis();
    std::thread::spawn(move || {
        let reading = sweep_system_channel_for_teardown(exit_unix_ms);
        let _ = cell.set(reading);
    });
    handle
}

/// Poll the System channel within a bounded budget for a shutdown/logoff record
/// that brackets the watcher exit. Mirrors `read_and_attribute_wer`: it retries
/// while the record may not have been published yet, distinguishes a
/// never-openable channel (`Unavailable`) from a readable channel with no
/// bracketing record (`None`), and never suppresses on a stale historical record.
#[cfg(target_os = "windows")]
fn sweep_system_channel_for_teardown(exit_unix_ms: i64) -> TeardownLogReading {
    use hq_desktop_core::sync_outcome::{parse_teardown_record, teardown_record_brackets_exit};
    use std::time::Instant;

    let deadline = Instant::now() + TEARDOWN_SWEEP_TOTAL_BUDGET;
    let mut query_ever_ran = false;
    loop {
        if let Some(xmls) =
            query_system_teardown_xml(TEARDOWN_MAX_RECORDS, TEARDOWN_PER_QUERY_BUDGET)
        {
            query_ever_ran = true;
            let now_ms = chrono::Utc::now().timestamp_millis();
            for xml in &xmls {
                if let Some(record) = parse_teardown_record(xml) {
                    if teardown_record_brackets_exit(&record, exit_unix_ms, now_ms) {
                        return TeardownLogReading::Record(record.class);
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            // Out of budget: a readable channel with no bracketing record is a
            // genuine `None`; a channel that never opened stays `Unavailable` and
            // fails closed to `Unknown`.
            return if query_ever_ran {
                TeardownLogReading::None
            } else {
                TeardownLogReading::Unavailable
            };
        }
        std::thread::sleep(TEARDOWN_RETRY_INTERVAL);
    }
}

/// One bounded reverse `EvtQuery` over the System channel for the three
/// teardown-initiation EventIDs. Returns `None` when the channel itself could
/// not be opened (disabled, unreadable, throttled) so the caller preserves
/// `Unavailable`; `Some(vec)` — possibly empty — means the query ran. The
/// provider gate is deliberately left to the pure parser, which requires BOTH
/// the provider name and the id, so an unrelated event sharing one of these ids
/// is rejected content-safely.
#[cfg(target_os = "windows")]
fn query_system_teardown_xml(
    max_records: usize,
    budget: std::time::Duration,
) -> Option<Vec<String>> {
    use std::time::Instant;
    use windows_sys::Win32::System::EventLog::{
        EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryReverseDirection,
    };

    let channel = to_wide("System");
    let query = to_wide("*[System[(EventID=1074 or EventID=13 or EventID=109)]]");
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
/// Two-call size-then-fill; returns `None` on any failure. Mirrors the WER
/// reader's `render_event_xml`; kept local so this probe is a self-contained seam
/// and the shipped WER path is untouched.
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

// ─────────────────────────────────────────────────────────────────────────────
// Non-Windows fallbacks
// ─────────────────────────────────────────────────────────────────────────────

/// No such flag exists off Windows: report `Unavailable` so "the OS says no"
/// stays strictly distinct from "we could not ask".
#[cfg(not(target_os = "windows"))]
pub fn sample_shuttingdown() -> TeardownShuttingDown {
    TeardownShuttingDown::Unavailable
}

/// No System channel off Windows: hand back an already-`Unavailable` sweep so a
/// non-Windows deferral resolves exactly as it did before this probe existed.
#[cfg(not(target_os = "windows"))]
pub fn spawn_teardown_log_sweep() -> TeardownSweepHandle {
    TeardownSweepHandle::unavailable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::sync_outcome::{
        windows_teardown_verdict, WindowsTeardownProbeReading, WindowsTeardownVerdict,
    };

    #[test]
    fn an_unkicked_sweep_handle_reads_unavailable_and_fails_closed() {
        // The default a payload carries before a real sweep is kicked, and the
        // non-Windows path, both read `Unavailable`.
        assert_eq!(
            TeardownSweepHandle::default().reading(),
            TeardownLogReading::Unavailable
        );
        assert_eq!(
            TeardownSweepHandle::unavailable().reading(),
            TeardownLogReading::Unavailable
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn off_windows_every_source_is_unavailable_and_the_verdict_is_unknown() {
        assert_eq!(sample_shuttingdown(), TeardownShuttingDown::Unavailable);
        let sweep = spawn_teardown_log_sweep();
        assert_eq!(sweep.reading(), TeardownLogReading::Unavailable);
        let verdict = windows_teardown_verdict(WindowsTeardownProbeReading {
            shuttingdown_at_exit: sample_shuttingdown(),
            shuttingdown_at_resolve: sample_shuttingdown(),
            log: sweep.reading(),
        });
        // Fail closed: an all-unavailable probe never suppresses.
        assert_eq!(verdict, WindowsTeardownVerdict::Unknown);
        assert_ne!(verdict, WindowsTeardownVerdict::Confirmed);
    }

    // Real-Windows, no mocks: proves the probe performs genuine OS reads and that
    // a healthy runner (which is not shutting down and whose last boot is far
    // outside the bracketing window by the time this test runs — the full app
    // build precedes it by tens of minutes) reads as verifiably NOT tearing down,
    // never fabricating a confirmation.
    #[cfg(target_os = "windows")]
    #[test]
    fn real_windows_teardown_reads_are_absent_on_a_healthy_runner() {
        // SM_SHUTTINGDOWN on a live, non-shutting-down session is 0.
        assert_eq!(sample_shuttingdown(), TeardownShuttingDown::No);

        // A real bounded EvtQuery against the System channel opens unelevated and
        // returns a definite reading — `None` (opened, no bracketing record),
        // never `Unavailable`, and never a fabricated `Record` for "now".
        let now = chrono::Utc::now().timestamp_millis();
        let log = sweep_system_channel_for_teardown(now);
        assert_ne!(
            log,
            TeardownLogReading::Unavailable,
            "the System channel must open unelevated on a stock runner"
        );
        assert_eq!(
            log,
            TeardownLogReading::None,
            "a healthy runner has no teardown record bracketing this instant"
        );

        // The combined verdict is therefore Absent — verifiably not tearing down —
        // and can never be Confirmed on a healthy runner.
        let verdict = windows_teardown_verdict(WindowsTeardownProbeReading {
            shuttingdown_at_exit: sample_shuttingdown(),
            shuttingdown_at_resolve: sample_shuttingdown(),
            log,
        });
        assert_eq!(verdict, WindowsTeardownVerdict::Absent);
        assert_ne!(verdict, WindowsTeardownVerdict::Confirmed);
    }

    // The async path used in production caches a definite reading within its
    // budget (which sits inside the grace) — proving the concurrently-kicked
    // sweep is ready by the time the resolver reads it.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_spawned_sweep_publishes_a_reading_within_the_grace() {
        let handle = spawn_teardown_log_sweep();
        // Bounded wait: the sweep's own budget is 4.5s, strictly under the 6s
        // grace, so a definite reading must appear well before this hard deadline.
        let hard_deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        loop {
            let reading = handle.reading();
            if reading != TeardownLogReading::Unavailable {
                assert_eq!(reading, TeardownLogReading::None);
                return;
            }
            assert!(
                std::time::Instant::now() < hard_deadline,
                "spawned sweep did not publish a reading inside the grace"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
