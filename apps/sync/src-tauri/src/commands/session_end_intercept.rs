//! HQ-DESKTOP-44 (regression reopen — the re-entrant path).
//!
//! The prior fix (the `RunEvent::Exit` fast path in `main.rs`) closes the
//! session-end panic ONLY when tao's event handler is free: `WM_ENDSESSION`
//! moves the runner to `Destroyed`, tao dispatches `LoopDestroyed`,
//! tauri-runtime-wry maps it to `RunEvent::Exit`, and the app exits before the
//! next dispatch. But `WM_ENDSESSION` can also arrive while the handler is
//! already TAKEN — the main thread is inside a nested Win32 message pump that
//! wry runs during WebView2 environment/controller creation
//! (`webview2_com::wait_with_pump` looping on `GetMessageW`). tao's
//! `WM_ENDSESSION` arm then calls `loop_destroyed()` re-entrantly,
//! `call_event_handler` does `event_handler.take().expect(...)` on a `None`, and
//! tao panics `either event handler is re-entrant (likely), or no event handler
//! is registered (very unlikely)` out of an `extern "system"` window procedure —
//! aborting the process. `RunEvent::Exit` never runs on that path, so the
//! app-level fast path can never fire.
//!
//! The remedy is a seam BEFORE tao's arm: a thread-local `WH_CALLWNDPROC` hook
//! installed on the event-loop thread. The system calls a `WH_CALLWNDPROC` hook
//! for every message SENT to a window on that thread, before the destination
//! window procedure — and `WM_ENDSESSION` is a sent message. The hook sees the
//! committed `WM_ENDSESSION(TRUE)`, runs the same bounded session-end teardown
//! the `RunEvent::Exit` arm runs, and exits — regardless of whether tao's
//! handler is currently taken. The `RunEvent::Exit` arm stays in place as the
//! fallback for the non-re-entrant path.
//!
//! The decision function and the teardown once-latch are pure and host-agnostic
//! (compiled on Windows and under `test`, exactly like `crate::handle_run_event_exit`)
//! so both are unit-testable on any host with no app instance and no real
//! session end. Everything that touches Win32 is `#[cfg(target_os = "windows")]`;
//! macOS and Linux binaries are behaviourally unaffected.

/// `WM_ENDSESSION` message id (0x0016). Defined locally so the decision table is
/// host-agnostic and unit-testable off Windows; equals
/// `windows::Win32::UI::WindowsAndMessaging::WM_ENDSESSION` (asserted in
/// `windows_tests`).
#[cfg(any(target_os = "windows", test))]
const WM_ENDSESSION: u32 = 0x0016;

/// What the intercept must do with a window message seen at the
/// `WH_CALLWNDPROC` boundary, before tao's own window procedure runs.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterceptAction {
    /// A committed Windows session end — run the bounded teardown and exit the
    /// process before tao's re-entrant handler can panic.
    EndSession,
    /// Anything else — call the next hook with the message untouched.
    PassThrough,
}

/// Pure decision, the single source of truth for what the hook acts on.
///
/// Only a COMMITTED `WM_ENDSESSION` (wParam != 0) is a real session end.
/// `WM_ENDSESSION(FALSE)` is a revoked/aborted end, `WM_QUERYENDSESSION`
/// (0x0011) is only a query Windows can still revoke with a later
/// `WM_ENDSESSION(FALSE)`, and every other message passes through. Keeping this
/// pure is what lets the existing bare-`WM_QUERYENDSESSION` live proof stay
/// green: a query is never intercepted.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn session_end_intercept_action(message: u32, wparam: usize) -> InterceptAction {
    if message == WM_ENDSESSION && wparam != 0 {
        InterceptAction::EndSession
    } else {
        InterceptAction::PassThrough
    }
}

/// Process-wide once-latch for the session-end teardown. The `WH_CALLWNDPROC`
/// intercept and the `RunEvent::Exit` fallback both route their teardown through
/// here, so a second entry — the fallback firing after the intercept already
/// ran, or a duplicate `WM_ENDSESSION` — is a no-op.
#[cfg(any(target_os = "windows", test))]
static SESSION_END_TEARDOWN_RAN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Run `teardown` at most once for the life of the process. Returns `true` when
/// this call actually ran it, `false` when a prior call already did. The
/// compare-exchange is the atomic gate, so concurrent callers still run the body
/// exactly once.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn run_session_end_teardown_once(teardown: impl FnOnce()) -> bool {
    use std::sync::atomic::Ordering;
    if SESSION_END_TEARDOWN_RAN
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    teardown();
    true
}

#[cfg(test)]
fn reset_session_end_teardown_latch_for_test() {
    SESSION_END_TEARDOWN_RAN.store(false, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(target_os = "windows")]
pub use win::{install_session_end_intercept, set_app_handle, windows_session_end_teardown};

#[cfg(all(target_os = "windows", feature = "e2e-automation"))]
pub use win::maybe_arm_reentrancy_probe;

#[cfg(target_os = "windows")]
mod win {
    use super::{run_session_end_teardown_once, session_end_intercept_action, InterceptAction};
    use std::sync::OnceLock;
    use tauri::Manager;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, SetWindowsHookExW, CWPSTRUCT, HHOOK, WH_CALLWNDPROC,
    };

    /// `AppHandle` captured in `.setup()`, read by the intercept teardown to reach
    /// the session-end observer. `None` before setup runs (a `WM_ENDSESSION` during
    /// very early startup, before the config windows exist) — the teardown then
    /// simply skips the observer step, which is bounded and optional.
    static SESSION_END_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Capture the app handle for the intercept teardown. Called once from
    /// `.setup()`. A second call is ignored.
    pub fn set_app_handle(handle: tauri::AppHandle) {
        let _ = SESSION_END_APP.set(handle);
    }

    /// Bounded, panic-free Windows session-end teardown, shared by the
    /// `WH_CALLWNDPROC` intercept and the `RunEvent::Exit` fallback and run at most
    /// once per process (see [`run_session_end_teardown_once`]).
    ///
    /// Step ORDER and caps are load-bearing and pinned by
    /// `scripts/native-seam-wiring.test.ts`: the durable latch first, the
    /// owned-pid report before `terminate_all_for_exit`, children terminated
    /// before the capped Sentry flush, each step individually capped so the total
    /// stays under Windows' 5s `WaitToKillAppTimeout`. It touches no tauri
    /// window/webview state (only `AppHandle::try_state`, the process registry,
    /// files, and the Sentry flush), so it is safe to run one level deeper than
    /// the `RunEvent::Exit` arm — inside wry's `wait_with_pump`.
    pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {
        run_session_end_teardown_once(|| {
            use crate::commands::session_end_observer::SessionEndObserverHandle;
            use hq_desktop_core::sync_outcome::WindowsTerminatorAttribution;

            // FIRST: make the durable session-end latch positive BEFORE the
            // one-shot capture sweep, so a watcher capture built microseconds
            // later — after the sweep, during its own grace — still sees positive
            // OS evidence at resolution and suppresses (HQ-DESKTOP r3). One
            // monotonic read and one atomic store: safe inside a window procedure.
            crate::commands::session_end_latch::note_windows_session_end();

            hq_telemetry::record_native_panic_seam(
                hq_telemetry::NativePanicSeam::AppSessionEndExit,
            );

            // Reaching the teardown IS the affirmation a deferred session-end
            // watcher capture was waiting for: drop the benign held-back event
            // rather than let it race the teardown.
            crate::commands::daemon::drop_pending_session_end_captures();
            // A deferred FAULT capture names a real 0xC0000409-class crash, not a
            // benign session end — flush it with its honest `deferred` provenance
            // ahead of the capped Sentry flush below.
            crate::commands::daemon::flush_pending_watcher_fault_captures("session_end_flush");
            // A deferred NON-fault report capture (HQ-DESKTOP-66) names a measured
            // crash — read + flush it (a fast local-file read) ahead of the flush.
            crate::commands::daemon::flush_pending_runner_report_captures("session_end_flush");

            // Corroborating signal, read BEFORE the observer is shut down (shutdown
            // moves its readiness out of the affirming states). Recorded alongside
            // — never instead of — the branch marker.
            if let Some(app) = app {
                if let Some(observer) = app.try_state::<SessionEndObserverHandle>() {
                    if observer.tracker().attribution_now()
                        == WindowsTerminatorAttribution::SessionEndObserved
                    {
                        hq_telemetry::record_native_panic_seam(
                            hq_telemetry::NativePanicSeam::AppSessionEndObserved,
                        );
                    }
                    observer.shutdown(std::time::Duration::from_millis(500));
                }
            }

            // Ownership report, emitted while the registry still holds the children
            // about to be terminated. Env-gated (`HQ_SYNC_SESSION_END_OWNED_PIDS`),
            // inert in every shipped build; the live proof points it at a temp
            // file. Its existence is what tells that proof this teardown ran, and
            // the pids it lists are what the proof then requires to be dead — so it
            // MUST precede `terminate_all_for_exit`.
            crate::commands::process::report_session_end_owned_pids();

            crate::commands::process::terminate_all_for_exit(std::time::Duration::from_millis(
                500,
            ));

            // Leaving the process here skips the `ClientInitGuard` drop that
            // normally flushes Sentry, so flush by hand under a hard cap.
            hq_telemetry::flush_within(std::time::Duration::from_millis(750));
        });
    }

    /// Run the bounded session-end teardown and exit, from inside the
    /// `WH_CALLWNDPROC` hook, for a committed `WM_ENDSESSION`. Reuses
    /// `handle_run_event_exit` so the app-initiated discriminator is exactly the
    /// one the `RunEvent::Exit` arm uses: a coincident app-initiated quit takes
    /// the no-op branch and lets the normal quit path (with `cleanup_before_exit`)
    /// run. The teardown is wrapped in `catch_unwind` so no unwind can escape the
    /// `extern "system"` hook proc, and the process exit follows unconditionally.
    ///
    /// Compiled out of `test` builds: there the hook dispatches to a recorder
    /// (`dispatch_intercept`) instead, so a test can exercise the hook without the
    /// process exit this performs.
    #[cfg(not(test))]
    fn session_end_intercept() {
        hq_telemetry::set_native_panic_phase(hq_telemetry::NativePanicPhase::Destroyed);
        hq_telemetry::record_native_panic_seam(
            hq_telemetry::NativePanicSeam::AppSessionEndIntercepted,
        );
        crate::handle_run_event_exit(
            crate::commands::process::app_initiated_exit(),
            || {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    windows_session_end_teardown(SESSION_END_APP.get());
                }));
            },
            || std::process::exit(0),
        );
    }

    /// In `test` builds the intercept records a hit instead of tearing down and
    /// exiting, so the hook-delivery test can assert the decision without killing
    /// the test process. In real builds it runs the production intercept.
    #[cfg(test)]
    static TEST_INTERCEPT_HITS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    #[cfg(not(test))]
    #[inline]
    fn dispatch_intercept() {
        session_end_intercept();
    }

    #[cfg(test)]
    #[inline]
    fn dispatch_intercept() {
        TEST_INTERCEPT_HITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// `WH_CALLWNDPROC` hook procedure. Runs for every message SENT to a window on
    /// the event-loop thread, before the target window procedure. The pass-through
    /// path does no allocation, no locking, no I/O and cannot panic: it reads the
    /// message id and wParam out of the `CWPSTRUCT` and calls the next hook. Only a
    /// committed `WM_ENDSESSION(TRUE)` diverts into the bounded teardown + exit,
    /// which is why it beats tao's re-entrant handler that would otherwise panic.
    ///
    /// # Safety
    /// A valid `HOOKPROC`: `code >= 0` guards the `CWPSTRUCT` read (a negative code
    /// forbids interpreting the parameters), the pointer is checked non-null, and
    /// `CallNextHookEx` is always called so the hook chain is never broken.
    unsafe extern "system" fn call_wnd_proc_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            inspect_and_maybe_intercept(lparam.0 as *const CWPSTRUCT);
        }
        CallNextHookEx(HHOOK(std::ptr::null_mut()), code, wparam, lparam)
    }

    /// The message-inspection half of the hook, split out so it is unit-testable
    /// without a real hook chain: it reads the message id and wParam out of the
    /// `CWPSTRUCT` and dispatches the intercept ONLY for a committed
    /// `WM_ENDSESSION(TRUE)`. Every other message is left untouched.
    ///
    /// # Safety
    /// `info` must be null or a valid `CWPSTRUCT` pointer (null is checked).
    unsafe fn inspect_and_maybe_intercept(info: *const CWPSTRUCT) {
        if info.is_null() {
            return;
        }
        if let InterceptAction::EndSession =
            session_end_intercept_action((*info).message, (*info).wParam.0)
        {
            dispatch_intercept();
        }
    }

    /// Install the thread-local `WH_CALLWNDPROC` intercept on the current
    /// (event-loop) thread. Call from `main()` BEFORE `tauri::Builder::build()` so
    /// it also covers a `WM_ENDSESSION` landing during the config-window / widget
    /// WebView2 creation tauri performs inside the `RunEvent::Ready` dispatch. A
    /// failure is logged and a bounded Sentry warning is emitted, but is never
    /// fatal — the `RunEvent::Exit` fallback still covers the non-re-entrant path.
    pub fn install_session_end_intercept() {
        // SAFETY: `call_wnd_proc_hook` is a valid `extern "system"` `HOOKPROC` in
        // this binary, and the hook is thread-local (`dwThreadId` = this thread),
        // so a NULL `hMod` is correct per `SetWindowsHookExW`'s contract for a
        // same-process hook procedure. Windows removes the hook automatically when
        // the thread ends, so the returned handle is not retained.
        let installed = unsafe {
            SetWindowsHookExW(
                WH_CALLWNDPROC,
                Some(call_wnd_proc_hook),
                HINSTANCE(std::ptr::null_mut()),
                GetCurrentThreadId(),
            )
        };
        match installed {
            Ok(_hook) => {
                crate::util::logfile::log(
                    "session-end",
                    "WH_CALLWNDPROC session-end intercept installed on the event-loop thread",
                );
            }
            Err(error) => {
                crate::util::logfile::log(
                    "session-end",
                    &format!(
                        "WH_CALLWNDPROC session-end intercept install failed: {error}; \
                         RunEvent::Exit fallback still covers the non-re-entrant path"
                    ),
                );
                hq_telemetry::capture_warning(
                    "windows session-end WH_CALLWNDPROC intercept install failed",
                );
            }
        }
    }

    /// Deterministic re-entrancy proof, compiled ONLY under `e2e-automation` (off
    /// in every shipped build) and armed ONLY when
    /// `HQ_SYNC_SESSION_END_REENTRANCY_PROBE=<marker path>` is set. It parks the
    /// main thread inside a `wait_with_pump`-shaped nested message pump, reached
    /// through `run_on_main_thread` (which routes through tao's user-event dispatch,
    /// so the handler is taken — the exact production shape), until the harness
    /// deletes the marker or a hard 30s deadline elapses.
    #[cfg(feature = "e2e-automation")]
    pub fn maybe_arm_reentrancy_probe(app: &tauri::AppHandle) {
        let marker = match std::env::var_os("HQ_SYNC_SESSION_END_REENTRANCY_PROBE") {
            Some(value) if !value.is_empty() => std::path::PathBuf::from(value),
            _ => return,
        };
        let app = app.clone();
        // Off the main thread first: `run_on_main_thread` then routes the probe
        // BACK onto the event-loop thread through tao's user-event dispatch, so it
        // runs with the tao handler taken — the production shape of the bug.
        std::thread::spawn(move || {
            let _ = app.run_on_main_thread(move || {
                run_reentrancy_probe_pump(&marker);
            });
        });
    }

    /// The nested pump itself: write the marker (so the harness knows the pump is
    /// live), then loop on `GetMessageW` with a periodic timer so it wakes to
    /// re-check the marker and the hard deadline. Sent messages such as the
    /// harness's `WM_ENDSESSION` are delivered into this `GetMessageW` by the
    /// kernel, driving the re-entrant path. Bounded and panic-free.
    #[cfg(feature = "e2e-automation")]
    fn run_reentrancy_probe_pump(marker: &std::path::Path) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, KillTimer, SetTimer, TranslateMessage, MSG,
        };

        if std::fs::write(marker, b"armed").is_err() {
            return;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        // SAFETY: a standard nested message pump on the current (main) thread. The
        // thread timer is created and killed on this thread and no handle outlives
        // the loop.
        unsafe {
            // NULL hwnd + no callback => a thread timer whose id is the RETURN
            // value; `nidevent` is ignored in that case.
            let timer = SetTimer(HWND(std::ptr::null_mut()), 0, 250, None);
            let mut message = MSG::default();
            loop {
                if !marker.exists() || std::time::Instant::now() >= deadline {
                    break;
                }
                let got = GetMessageW(&mut message, HWND(std::ptr::null_mut()), 0, 0);
                // -1 is an error, 0 is WM_QUIT; either way stop pumping.
                if got.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if timer != 0 {
                let _ = KillTimer(HWND(std::ptr::null_mut()), timer);
            }
        }
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(all(test, target_os = "windows"))]
    mod windows_tests {
        use super::{inspect_and_maybe_intercept, TEST_INTERCEPT_HITS};
        use std::sync::atomic::Ordering;
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{CWPSTRUCT, WM_QUERYENDSESSION};

        // The locally-defined message id the decision table uses must equal the
        // Win32 constant the hook actually reads out of the CWPSTRUCT.
        #[test]
        fn local_wm_endsession_matches_the_windows_crate() {
            use windows::Win32::UI::WindowsAndMessaging::WM_ENDSESSION as CRATE_WM_ENDSESSION;
            assert_eq!(super::super::WM_ENDSESSION, CRATE_WM_ENDSESSION);
            assert_eq!(0x0011_u32, WM_QUERYENDSESSION);
        }

        // Drive the hook's message inspection directly with a synthetic
        // `CWPSTRUCT`, proving it reads the message id + wParam out of the struct
        // the kernel hands a `WH_CALLWNDPROC` proc and dispatches the intercept
        // ONLY for a committed `WM_ENDSESSION(TRUE)`. Real cross-process delivery
        // of `WM_ENDSESSION` into the nested pump is proved by the live e2e; this
        // isolates the hook-proc decision from tao and cannot hang.
        #[test]
        fn hook_dispatches_only_on_a_committed_end_session() {
            let dispatched = |message: u32, wparam: usize| -> u32 {
                TEST_INTERCEPT_HITS.store(0, Ordering::SeqCst);
                let info = CWPSTRUCT {
                    lParam: LPARAM(0),
                    wParam: WPARAM(wparam),
                    message,
                    hwnd: HWND(std::ptr::null_mut()),
                };
                // SAFETY: `&info` is a live, valid CWPSTRUCT pointer for this call.
                unsafe { inspect_and_maybe_intercept(&info as *const CWPSTRUCT) };
                TEST_INTERCEPT_HITS.load(Ordering::SeqCst)
            };

            assert_eq!(dispatched(super::super::WM_ENDSESSION, 1), 1, "committed end");
            assert_eq!(dispatched(super::super::WM_ENDSESSION, 0), 0, "revoked end");
            assert_eq!(dispatched(WM_QUERYENDSESSION, 0), 0, "bare query");
            assert_eq!(dispatched(WM_QUERYENDSESSION, 1), 0, "query with wParam");
            assert_eq!(dispatched(0x000F, 1), 0, "WM_PAINT");

            // A null CWPSTRUCT pointer (which a negative hook code would forbid
            // reading anyway) must be a no-op, never a deref.
            TEST_INTERCEPT_HITS.store(0, Ordering::SeqCst);
            unsafe { inspect_and_maybe_intercept(std::ptr::null()) };
            assert_eq!(TEST_INTERCEPT_HITS.load(Ordering::SeqCst), 0, "null is inert");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // WM_* ids used below (host-agnostic literals): WM_PAINT 0x000F, WM_CLOSE
    // 0x0010, WM_QUERYENDSESSION 0x0011, WM_ENDSESSION 0x0016.
    #[test]
    fn decision_only_fires_on_a_committed_end_session() {
        // Committed WM_ENDSESSION(TRUE) — the one case that ends the process.
        assert_eq!(
            session_end_intercept_action(0x0016, 1),
            InterceptAction::EndSession
        );
        assert_eq!(
            session_end_intercept_action(0x0016, usize::MAX),
            InterceptAction::EndSession
        );

        // Revoked end, bare query, and unrelated messages all pass through — so a
        // WM_QUERYENDSESSION the user later vetoes never ends the process.
        assert_eq!(
            session_end_intercept_action(0x0016, 0),
            InterceptAction::PassThrough,
            "WM_ENDSESSION(FALSE) is a revoked end"
        );
        assert_eq!(
            session_end_intercept_action(0x0011, 1),
            InterceptAction::PassThrough,
            "WM_QUERYENDSESSION is only a query"
        );
        assert_eq!(
            session_end_intercept_action(0x0011, 0),
            InterceptAction::PassThrough
        );
        assert_eq!(
            session_end_intercept_action(0x000F, 1),
            InterceptAction::PassThrough,
            "WM_PAINT"
        );
        assert_eq!(
            session_end_intercept_action(0x0010, 1),
            InterceptAction::PassThrough,
            "WM_CLOSE"
        );
        assert_eq!(
            session_end_intercept_action(0x0000, 0),
            InterceptAction::PassThrough,
            "WM_NULL"
        );
    }

    // The shared teardown must run at most once, whichever seam (intercept or the
    // RunEvent::Exit fallback) reaches it first.
    #[test]
    fn teardown_runs_at_most_once() {
        reset_session_end_teardown_latch_for_test();
        let mut runs = 0u32;
        assert!(
            run_session_end_teardown_once(|| runs += 1),
            "the first entry runs the teardown"
        );
        assert!(
            !run_session_end_teardown_once(|| runs += 1),
            "a second entry is a no-op"
        );
        assert!(!run_session_end_teardown_once(|| runs += 1));
        assert_eq!(runs, 1, "the teardown body runs exactly once per process");
        reset_session_end_teardown_latch_for_test();
    }
}
