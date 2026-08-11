//! Windows Error Reporting fault-provenance reader (HQ-DESKTOP-4X).
//!
//! On the watcher route the app receives no fault-bearing stderr line, so the
//! sticky `runner_fatal_class` stays `none` across a whole generation and the
//! identity of the process that actually faulted in the 7-process watcher tree
//! is never determined. This module reads the operating system's OWN fault
//! record — the `Application Error` / Event ID 1000 entry Windows Error
//! Reporting writes to the Application log — to recover the faulting executable
//! and module.
//!
//! This file is deliberately thin: it is only the bounded Win32 query. EVERY
//! content-safety decision — the allow-list mapping, the record parse, the
//! provenance state machine — lives in `hq_desktop_core::watcher_fault` and is
//! unit-tested on the Linux fix host. Here we merely fetch the OS-rendered event
//! XML and the generation's sampled Job Object pid set and hand both to the core
//! resolver.
//!
//! Invariants: it runs strictly off the terminal callback, under a HARD bounded
//! timeout, never blocks past that bound, never retries unboundedly, never
//! mutates the exit path, and degrades to the `unavailable` sentinel on any
//! failure (non-Windows, a failed/timed-out query, or WER disabled).

use hq_desktop_core::watcher_fault::{resolve_watcher_fault_attribution, WatcherFaultAttribution};
use std::time::Duration;

/// Hard upper bound on the whole Application-log read at a watcher exit. On
/// timeout the attribution degrades to `unavailable`; the exit path never blocks
/// past this.
pub const WATCHER_FAULT_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Resolve the content-safe fault attribution for the watcher generation that
/// just exited. Reads this generation's last sampled Job Object pid set and the
/// best qualifying in-window `Application Error` record, then delegates the
/// decision to the platform-neutral core resolver.
///
/// The OS query runs on a detached helper thread joined under
/// [`WATCHER_FAULT_QUERY_TIMEOUT`], so the caller (the exit-capture snapshot) is
/// bounded and panic-free: a timeout, a query failure, or a non-Windows target
/// all yield `unavailable`.
#[cfg(target_os = "windows")]
pub fn read_watcher_fault_attribution(
    handle: &str,
    generation: u64,
    lifetime: Duration,
) -> WatcherFaultAttribution {
    // Sampled while the tree was alive; read here before the generation is
    // finished. `None` when sampling never captured a set (→ window_only at most).
    let sampled =
        crate::commands::process::watcher_job_sampled_pids_for_generation(handle, generation);

    // Run the event-log read OFF this thread and join under a hard deadline, so a
    // slow or wedged Application channel can never stall the exit path.
    let (tx, rx) = std::sync::mpsc::sync_channel::<WerQueryOutcome>(1);
    std::thread::Builder::new()
        .name("watcher-fault-wer".into())
        .spawn(move || {
            let _ = tx.send(read_application_error_record(lifetime));
        })
        .ok();

    let (query_ok, record) = match rx.recv_timeout(WATCHER_FAULT_QUERY_TIMEOUT) {
        Ok(WerQueryOutcome::Read(record)) => (true, record),
        Ok(WerQueryOutcome::Failed) => (false, None),
        // Timed out or the helper thread died: fail closed to `unavailable`.
        Err(_) => (false, None),
    };
    resolve_watcher_fault_attribution(query_ok, record.as_ref(), sampled.as_ref())
}

#[cfg(not(target_os = "windows"))]
pub fn read_watcher_fault_attribution(
    _handle: &str,
    _generation: u64,
    _lifetime: Duration,
) -> WatcherFaultAttribution {
    WatcherFaultAttribution::unavailable()
}

/// Outcome of one bounded Application-log read.
#[cfg(target_os = "windows")]
enum WerQueryOutcome {
    /// The channel was read successfully; the best in-window record, if any.
    Read(Option<hq_desktop_core::watcher_fault::WerApplicationError>),
    /// The channel could not be opened/read (unavailable / disabled).
    Failed,
}

/// Query the Application log for the most recent in-window `Application Error`
/// (Event ID 1000) record. Newest-first; stops at the first record whose
/// timestamp falls inside the generation lifetime, and bounds total work with a
/// small event cap so it always returns promptly.
#[cfg(target_os = "windows")]
fn read_application_error_record(lifetime: Duration) -> WerQueryOutcome {
    use hq_desktop_core::watcher_fault::{parse_wer_application_error, wer_record_in_window};
    use std::time::SystemTime;
    use windows_sys::Win32::System::EventLog::{
        EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryReverseDirection,
    };

    let channel = to_wide("Application");
    // Provider + event id filter, resolved to the newest matching records first.
    let query = to_wide("*[System[Provider[@Name='Application Error'] and (EventID=1000)]]");

    // SAFETY: `results` and every event handle are owned by this function and
    // closed on every path; the render buffers are sized by EvtRender's two-pass
    // protocol. No handle outlives the call.
    unsafe {
        let results = EvtQuery(
            0,
            channel.as_ptr(),
            query.as_ptr(),
            (EvtQueryChannelPath | EvtQueryReverseDirection) as u32,
        );
        if results == 0 {
            // The Application channel could not be opened (disabled/unreadable).
            return WerQueryOutcome::Failed;
        }

        let now = SystemTime::now();
        // Bound the scan: our fault caused the exit moments ago, so it is among
        // the very newest matching records. This also caps work if the machine is
        // producing many unrelated crashes.
        const MAX_EVENTS: usize = 64;
        let mut best = None;
        for _ in 0..MAX_EVENTS {
            let mut event: isize = 0;
            let mut returned: u32 = 0;
            // Short per-batch timeout so the whole read stays well under the outer
            // bound even if the channel is momentarily slow.
            if EvtNext(results, 1, &mut event, 200, 0, &mut returned) == 0 || returned == 0 {
                break;
            }
            let parsed = render_event_xml(event).and_then(|xml| parse_wer_application_error(&xml));
            EvtClose(event);
            if let Some(record) = parsed {
                if wer_record_in_window(record.created, now, lifetime) {
                    best = Some(record);
                    break; // newest-first: the first in-window record is the one
                }
                // Records are newest-first; once we pass a record that is provably
                // older than the window, nothing further can be in-window.
                if let Some(created) = record.created {
                    if now
                        .duration_since(created)
                        .map(|age| age > lifetime + Duration::from_secs(60))
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
            }
        }
        EvtClose(results);
        WerQueryOutcome::Read(best)
    }
}

/// Render one event handle to its XML form via EvtRender's two-pass size probe.
/// Returns `None` on any failure; the returned string is opaque to this module
/// (only the core parser inspects it).
#[cfg(target_os = "windows")]
unsafe fn render_event_xml(event: isize) -> Option<String> {
    use windows_sys::Win32::System::EventLog::{EvtRender, EvtRenderEventXml};

    let mut used: u32 = 0;
    let mut props: u32 = 0;
    // First pass: probe the required buffer size (in bytes).
    EvtRender(
        0,
        event,
        EvtRenderEventXml as u32,
        0,
        core::ptr::null_mut(),
        &mut used,
        &mut props,
    );
    if used == 0 {
        return None;
    }
    // `used` is a byte count; the rendered XML is UTF-16.
    let u16_len = (used as usize + 1) / 2;
    let mut buffer = vec![0u16; u16_len];
    let mut used2: u32 = 0;
    if EvtRender(
        0,
        event,
        EvtRenderEventXml as u32,
        (buffer.len() * 2) as u32,
        buffer.as_mut_ptr() as *mut core::ffi::c_void,
        &mut used2,
        &mut props,
    ) == 0
    {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// UTF-16, NUL-terminated encoding for a Win32 wide-string argument.
#[cfg(target_os = "windows")]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
