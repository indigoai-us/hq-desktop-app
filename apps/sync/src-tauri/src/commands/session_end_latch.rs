//! Durable, process-global Windows session-end latch (HQ-DESKTOP r3).
//!
//! The r1 deferral and the r2 pull-based teardown probe both hung off ONE gate —
//! the observer's live attribution. At a real Windows session end the OS destroys
//! the observer's window, so by the time a `DBG_TERMINATE_PROCESS` watcher exit is
//! attributed the observer thread is often already `Stopped` and
//! `attribution_now` reports `ObserverFailed`, discarding a committed
//! `affirmed_end_ms` recorded while the window was alive. That reading skipped
//! the deferral entirely and fired a false alert.
//!
//! This latch makes the app's positive session-end knowledge DURABLE and
//! process-global, independent of the observer thread's life. It is a single
//! monotonic-millis timestamp, written ONLY from positive OS session-end
//! evidence:
//!
//! - a committed `WM_ENDSESSION(TRUE)` or a same-session WTS logoff, via the
//!   session-end observer's tracker; and
//! - the app's own non-app-initiated `RunEvent::Exit` session-end branch, set as
//!   the FIRST thing that branch does so a capture that races the one-shot drop
//!   sweep still sees it.
//!
//! Its contemporaneity is judged by the PURE
//! [`session_end_latch_reading`](hq_desktop_core::sync_outcome::session_end_latch_reading)
//! on the SAME 20s TTL as an observer affirmation, so a latch from a session end
//! minutes ago can never suppress an unrelated later crash. Reading and writing
//! are lock-free, allocation-free and panic-free, because the write path runs
//! inside a Windows window procedure against Windows' `WaitToKillAppTimeout`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use hq_desktop_core::sync_outcome::{session_end_latch_reading, SessionEndLatchReading};

/// Sentinel meaning "no session end has ever been latched". A real monotonic
/// offset from the process-fixed origin is not going to reach `u64::MAX`
/// milliseconds (~584 million years) in any realistic runtime, so it can never
/// collide with a genuine latch value.
const UNSET: u64 = u64::MAX;

/// The durable latch: the monotonic-millis instant of the most recent positive
/// Windows session-end signal, or [`UNSET`].
static SESSION_END_LATCH_MS: AtomicU64 = AtomicU64::new(UNSET);

/// Process-fixed monotonic origin for the latch. Kept independent of the
/// observer tracker's own clock so the write path (observer thread / window
/// procedure) and the read path (daemon exit callback / deferral resolver, which
/// hold no tracker) compare against ONE consistent clock.
fn latch_origin() -> Instant {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    *ORIGIN.get_or_init(Instant::now)
}

/// Milliseconds since [`latch_origin`], saturating rather than wrapping.
fn latch_now_ms() -> u64 {
    latch_origin()
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

/// Prime the monotonic origin early (called from `main.rs` setup) so the first
/// write — which may land inside a window procedure — is a bare atomic store
/// against an already-initialised origin. Idempotent and cheap; omitting it only
/// means the first writer initialises the origin itself.
pub fn init() {
    let _ = latch_origin();
}

/// Record positive Windows session-end evidence. Allocation-free, syscall-light
/// (one monotonic read), panic-free: safe to call from the `RunEvent::Exit`
/// window-procedure teardown.
pub fn note_windows_session_end() {
    SESSION_END_LATCH_MS.store(latch_now_ms(), Ordering::Release);
}

/// The raw latched instant, or `None` when the latch has never been set.
pub fn windows_session_end_latched_at() -> Option<u64> {
    match SESSION_END_LATCH_MS.load(Ordering::Acquire) {
        UNSET => None,
        latched => Some(latched),
    }
}

/// The content-safe latch reading at the current instant, judged by the pure
/// contemporaneity rule. `Absent` covers both "never set" and "expired past the
/// TTL"; only a fresh latch reads `Latched`.
pub fn current_session_end_latch_reading() -> SessionEndLatchReading {
    session_end_latch_reading(windows_session_end_latched_at(), latch_now_ms())
}

/// Read-only diagnostic command: the durable session-end latch reading as a
/// fixed, content-safe token (`latched` / `absent` / `unavailable`). Exposed for
/// the live Windows session-end proof and future self-diagnosis; it carries no
/// timestamp, host name, session id, or any other identifier.
#[tauri::command]
pub fn session_end_latch_status() -> &'static str {
    current_session_end_latch_reading().class_name()
}

/// Where a positive session-end signal is written. Injected into the observer's
/// tracker so unit tests can observe the write without touching the durable
/// process-global (which the daemon reads), and so a tracker built without a
/// latch simply does not write one.
pub trait SessionEndLatchSink: Send + Sync {
    fn note_session_end(&self);
}

/// Production sink: writes the durable process-global latch.
pub struct GlobalSessionEndLatch;

impl SessionEndLatchSink for GlobalSessionEndLatch {
    fn note_session_end(&self) {
        note_windows_session_end();
    }
}

/// Default sink for a tracker built without an explicit latch (every existing
/// unit test): records nothing, so those tests can never pollute the durable
/// global that the daemon reads.
pub struct NoopSessionEndLatch;

impl SessionEndLatchSink for NoopSessionEndLatch {
    fn note_session_end(&self) {}
}

#[cfg(test)]
pub fn reset_for_test() {
    SESSION_END_LATCH_MS.store(UNSET, Ordering::Release);
}

/// A recording sink for tests (e.g. the session-end observer's) that counts the
/// session-end writes it is handed WITHOUT touching the durable process-global,
/// so those tests stay deterministic and never pollute the latch the daemon
/// reads.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSessionEndLatch {
    writes: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl RecordingSessionEndLatch {
    pub fn writes(&self) -> usize {
        self.writes.load(Ordering::Acquire)
    }
}

#[cfg(test)]
impl SessionEndLatchSink for RecordingSessionEndLatch {
    fn note_session_end(&self) {
        self.writes.fetch_add(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Serialises the handful of tests that touch the ONE durable global so they
    /// cannot race each other. No other test in this binary writes the global —
    /// every tracker outside these tests uses [`NoopSessionEndLatch`].
    static LATCH_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn note_then_read_latches_and_survives_repeated_reads() {
        let _guard = LATCH_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_for_test();
        assert_eq!(
            current_session_end_latch_reading(),
            SessionEndLatchReading::Absent,
            "an unset latch reads Absent"
        );
        assert!(windows_session_end_latched_at().is_none());

        note_windows_session_end();
        assert!(windows_session_end_latched_at().is_some());
        // Read repeatedly: the latch is durable, not consumed by a read, and
        // stays contemporaneous well inside the 20s TTL.
        for _ in 0..3 {
            assert_eq!(
                current_session_end_latch_reading(),
                SessionEndLatchReading::Latched,
                "a just-set latch reads Latched on every read"
            );
        }
        reset_for_test();
    }

    #[test]
    fn the_global_sink_writes_the_durable_latch_and_the_noop_sink_does_not() {
        let _guard = LATCH_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_for_test();

        NoopSessionEndLatch.note_session_end();
        assert!(
            windows_session_end_latched_at().is_none(),
            "the no-op sink must never latch"
        );

        GlobalSessionEndLatch.note_session_end();
        assert_eq!(
            current_session_end_latch_reading(),
            SessionEndLatchReading::Latched,
            "the production sink must set the durable latch"
        );
        reset_for_test();
    }

    #[test]
    fn a_recording_sink_counts_only_the_writes_it_is_handed() {
        let sink = Arc::new(RecordingSessionEndLatch::default());
        assert_eq!(sink.writes(), 0);
        sink.note_session_end();
        sink.note_session_end();
        assert_eq!(sink.writes(), 2);
        // The recording sink is inert against the durable global.
        let _guard = LATCH_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_for_test();
        sink.note_session_end();
        assert!(windows_session_end_latched_at().is_none());
    }
}
