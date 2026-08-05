//! Windows session-end observation for watcher-exit attribution.
//!
//! `DBG_TERMINATE_PROCESS` alone does not establish why Windows ended a child.
//! This module records only committed, same-session end signals and keeps the
//! decision typed and fail-closed until daemon capture policy consumes it.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use hq_desktop_core::sync_outcome::{session_end_affirms, WindowsTerminatorAttribution};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

/// Monotonic time source injected into the tracker so attribution boundaries
/// can be tested without process-global state or wall-clock races.
pub trait MonotonicClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

/// Process-local monotonic clock for the shipped observer.
pub struct ProcessStartClock {
    started_at: Instant,
}

impl ProcessStartClock {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl Default for ProcessStartClock {
    fn default() -> Self {
        Self::new()
    }
}

impl MonotonicClock for ProcessStartClock {
    fn now_millis(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }
}

/// Fixed-vocabulary lifecycle state exposed by the status command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObserverReadiness {
    Starting,
    Registered,
    Recovering,
    Failed,
    Stopped,
}

impl ObserverReadiness {
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Registered => "registered",
            Self::Recovering => "recovering",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug)]
struct TrackerState {
    pending_query_ms: Option<u64>,
    affirmed_end_ms: Option<u64>,
    readiness: ObserverReadiness,
}

/// Per-app session-end state. A query is deliberately represented separately
/// from an affirmation: Windows can later revoke a query with WM_ENDSESSION(0).
pub struct SessionEndTracker {
    clock: Arc<dyn MonotonicClock>,
    state: Mutex<TrackerState>,
}

impl SessionEndTracker {
    pub fn new(clock: Arc<dyn MonotonicClock>) -> Self {
        Self {
            clock,
            state: Mutex::new(TrackerState {
                pending_query_ms: None,
                affirmed_end_ms: None,
                readiness: ObserverReadiness::Starting,
            }),
        }
    }

    pub fn note_query_end_session(&self) {
        let now = self.clock.now_millis();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.pending_query_ms = Some(now);
    }

    pub fn note_end_session(&self, ending: bool) {
        let now = self.clock.now_millis();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if ending {
            state.affirmed_end_ms = Some(now);
            state.pending_query_ms = None;
        } else {
            // A vetoed query is not a session end. Do not clear a previously
            // committed WM_ENDSESSION(TRUE), which remains valid until TTL.
            state.pending_query_ms = None;
        }
    }

    pub fn note_wts_logoff_same_session(&self) {
        let now = self.clock.now_millis();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.affirmed_end_ms = Some(now);
    }

    pub fn set_readiness(&self, readiness: ObserverReadiness) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.readiness = readiness;
    }

    pub fn readiness(&self) -> ObserverReadiness {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .readiness
    }

    /// Return an attribution that is safe to feed directly to capture policy.
    /// Failed or stopped observation wins over an otherwise fresh affirmation.
    pub fn attribution_now(&self) -> WindowsTerminatorAttribution {
        let now = self.clock.now_millis();
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match state.readiness {
            ObserverReadiness::Failed | ObserverReadiness::Stopped => {
                WindowsTerminatorAttribution::ObserverFailed
            }
            ObserverReadiness::Starting
            | ObserverReadiness::Registered
            | ObserverReadiness::Recovering => {
                if session_end_affirms(state.affirmed_end_ms, now) {
                    WindowsTerminatorAttribution::SessionEndObserved
                } else {
                    WindowsTerminatorAttribution::Unattributed
                }
            }
        }
    }
}

/// Read-only diagnostic command. It never exposes timestamps, session IDs, or
/// host-specific details, and non-Windows builds intentionally report only the
/// fixed unavailable vocabulary.
#[tauri::command]
pub fn session_end_observer_status(app: tauri::AppHandle) -> &'static str {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        app.try_state::<SessionEndObserverHandle>()
            .map(|handle| handle.tracker().readiness().class_name())
            .unwrap_or("unavailable")
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        "unavailable"
    }
}

#[cfg(target_os = "windows")]
mod windows_observer {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use windows::core::{w, Error, PCWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CLASS_ALREADY_EXISTS, HANDLE, HINSTANCE, HWND, LPARAM,
        LRESULT, WAIT_FAILED, WAIT_OBJECT_0, WPARAM,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
        NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, OpenEventW, SetEvent, SYNCHRONIZATION_SYNCHRONIZE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindowLongPtrW,
        MsgWaitForMultipleObjectsEx, PeekMessageW, PostQuitMessage, RegisterClassW,
        SetWindowLongPtrW, TranslateMessage, GWLP_USERDATA, HMENU, MSG, MWMO_INPUTAVAILABLE,
        PM_REMOVE, QS_ALLINPUT, WM_CLOSE, WM_DESTROY, WM_ENDSESSION, WM_QUERYENDSESSION, WM_QUIT,
        WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED, WTS_SESSION_LOGOFF,
    };

    use super::{ObserverReadiness, SessionEndTracker};

    const TERMSRV_READY_WAIT: Duration = Duration::from_secs(10);
    const STEADY_TICK: Duration = Duration::from_secs(60);
    const RPC_S_INVALID_BINDING_HRESULT: u32 = 0x8007_06A6;

    /// A manual-reset event shared between the app thread and observer thread.
    /// The event is created before spawn so shutdown cannot miss an early phase.
    struct ShutdownEvent(HANDLE);

    unsafe impl Send for ShutdownEvent {}
    unsafe impl Sync for ShutdownEvent {}

    impl ShutdownEvent {
        fn create() -> Result<Self, Error> {
            // Manual reset, initially unsignaled.
            unsafe { CreateEventW(None, true, false, PCWSTR::null()).map(Self) }
        }

        fn signal(&self) {
            if unsafe { SetEvent(self.0) }.is_err() {
                crate::util::logfile::log(
                    "session-end",
                    "session-end observer shutdown event failed",
                );
            }
        }

        fn handle(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for ShutdownEvent {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    struct ObserverShared {
        tracker: Arc<SessionEndTracker>,
        shutdown_requested: AtomicBool,
        shutdown_event: Option<ShutdownEvent>,
        hwnd: AtomicIsize,
    }

    struct WindowContext {
        tracker: Arc<SessionEndTracker>,
        session_id: u32,
        destroyed: AtomicBool,
    }

    /// Managed Tauri state for the observer. Shutdown is explicitly bounded;
    /// its join handle is never joined unconditionally on the app quit path.
    pub struct SessionEndObserverHandle {
        shared: Arc<ObserverShared>,
        thread: Mutex<Option<JoinHandle<()>>>,
    }

    impl SessionEndObserverHandle {
        pub fn start(tracker: Arc<SessionEndTracker>) -> Self {
            let shutdown_event = match ShutdownEvent::create() {
                Ok(event) => Some(event),
                Err(_) => {
                    tracker.set_readiness(ObserverReadiness::Failed);
                    crate::util::logfile::log(
                        "session-end",
                        "session-end observer event unavailable",
                    );
                    None
                }
            };

            let shared = Arc::new(ObserverShared {
                tracker,
                shutdown_requested: AtomicBool::new(false),
                shutdown_event,
                hwnd: AtomicIsize::new(0),
            });
            if shared.shutdown_event.is_none() {
                return Self {
                    shared,
                    thread: Mutex::new(None),
                };
            }
            let thread_shared = Arc::clone(&shared);
            let thread = thread::Builder::new()
                .name("hq-session-end-observer".to_string())
                .spawn(move || observer_thread(thread_shared));

            match thread {
                Ok(thread) => Self {
                    shared,
                    thread: Mutex::new(Some(thread)),
                },
                Err(_) => {
                    shared.tracker.set_readiness(ObserverReadiness::Failed);
                    crate::util::logfile::log(
                        "session-end",
                        "session-end observer thread unavailable",
                    );
                    Self {
                        shared,
                        thread: Mutex::new(None),
                    }
                }
            }
        }

        pub fn tracker(&self) -> &Arc<SessionEndTracker> {
            &self.shared.tracker
        }

        /// Request a level-triggered shutdown and wait only through the supplied
        /// bound. A timed-out observer is detached rather than delaying app exit.
        pub fn shutdown(&self, deadline: Duration) {
            if self.shared.shutdown_requested.swap(true, Ordering::AcqRel) {
                return;
            }
            if let Some(event) = &self.shared.shutdown_event {
                event.signal();
            }

            let handle = self
                .thread
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(handle) = handle else {
                return;
            };

            let until = Instant::now() + deadline;
            while !handle.is_finished() && Instant::now() < until {
                thread::sleep(Duration::from_millis(10));
            }

            if handle.is_finished() {
                if handle.join().is_err() {
                    crate::util::logfile::log(
                        "session-end",
                        "session-end observer thread panicked",
                    );
                }
            } else {
                crate::util::logfile::log(
                    "session-end",
                    "session-end observer shutdown timed out; thread detached",
                );
            }
        }
    }

    fn is_termsrv_not_ready(error: &Error) -> bool {
        error.code().0 as u32 == RPC_S_INVALID_BINDING_HRESULT
    }

    unsafe fn register_session_notifications(hwnd: HWND) -> Result<(), Error> {
        WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)
    }

    unsafe fn open_termsrv_ready_event() -> Option<HANDLE> {
        OpenEventW(
            SYNCHRONIZATION_SYNCHRONIZE,
            false,
            w!("Global\\TermSrvReadyEvent"),
        )
        .ok()
    }

    fn close_optional_handle(handle: &mut Option<HANDLE>) {
        if let Some(handle) = handle.take() {
            let _ = unsafe { CloseHandle(handle) };
        }
    }

    fn wait_millis_until(deadline: Instant) -> u32 {
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(u32::MAX)) as u32
    }

    unsafe extern "system" fn observer_wndproc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let context = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowContext;
        if context.is_null() {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        let context = &*context;
        match message {
            WM_QUERYENDSESSION => {
                context.tracker.note_query_end_session();
                LRESULT(1)
            }
            WM_ENDSESSION => {
                context.tracker.note_end_session(wparam.0 != 0);
                LRESULT(0)
            }
            WM_WTSSESSION_CHANGE => {
                if wparam.0 as u32 == WTS_SESSION_LOGOFF && lparam.0 as u32 == context.session_id {
                    context.tracker.note_wts_logoff_same_session();
                }
                LRESULT(0)
            }
            WM_CLOSE => LRESULT(0),
            WM_DESTROY => {
                context.destroyed.store(true, Ordering::Release);
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn observer_thread(shared: Arc<ObserverShared>) {
        let Some(shutdown_event) = shared.shutdown_event.as_ref() else {
            shared.tracker.set_readiness(ObserverReadiness::Failed);
            return;
        };
        if shared.shutdown_requested.load(Ordering::Acquire) {
            shared.tracker.set_readiness(ObserverReadiness::Stopped);
            return;
        }

        let class_name = w!("HQSessionEndObserverWindow");
        let instance = unsafe {
            match GetModuleHandleW(PCWSTR::null()) {
                Ok(module) => HINSTANCE(module.0),
                Err(_) => {
                    shared.tracker.set_readiness(ObserverReadiness::Failed);
                    crate::util::logfile::log(
                        "session-end",
                        "session-end observer module unavailable",
                    );
                    return;
                }
            }
        };
        let class = WNDCLASSW {
            hInstance: instance,
            lpszClassName: class_name,
            lpfnWndProc: Some(observer_wndproc),
            ..Default::default()
        };
        let class_result = unsafe { RegisterClassW(&class) };
        if class_result == 0 && unsafe { GetLastError() } != ERROR_CLASS_ALREADY_EXISTS {
            shared.tracker.set_readiness(ObserverReadiness::Failed);
            crate::util::logfile::log("session-end", "session-end observer class unavailable");
            return;
        }

        let hwnd = unsafe {
            match CreateWindowExW(
                Default::default(),
                class_name,
                class_name,
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                HWND::default(),
                HMENU::default(),
                instance,
                None::<*const c_void>,
            ) {
                Ok(hwnd) => hwnd,
                Err(_) => {
                    shared.tracker.set_readiness(ObserverReadiness::Failed);
                    crate::util::logfile::log(
                        "session-end",
                        "session-end observer window unavailable",
                    );
                    return;
                }
            }
        };

        let mut session_id = u32::MAX;
        if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) }.is_err() {
            crate::util::logfile::log(
                "session-end",
                "session-end observer session lookup unavailable",
            );
        }
        let context = WindowContext {
            tracker: Arc::clone(&shared.tracker),
            session_id,
            destroyed: AtomicBool::new(false),
        };
        unsafe {
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                (&context as *const WindowContext) as isize,
            );
        }
        shared.hwnd.store(hwnd.0 as isize, Ordering::Release);

        if shared.shutdown_requested.load(Ordering::Acquire) {
            owner_thread_teardown(&shared, hwnd, &context, false, None);
            return;
        }

        let mut registered = false;
        let mut recovery_deadline = None;
        let mut termsrv_ready_event = None;
        match unsafe { register_session_notifications(hwnd) } {
            Ok(()) => {
                registered = true;
                shared.tracker.set_readiness(ObserverReadiness::Registered);
            }
            Err(error) if is_termsrv_not_ready(&error) => {
                shared.tracker.set_readiness(ObserverReadiness::Recovering);
                recovery_deadline = Some(Instant::now() + TERMSRV_READY_WAIT);
                termsrv_ready_event = unsafe { open_termsrv_ready_event() };
            }
            Err(_) => {
                shared.tracker.set_readiness(ObserverReadiness::Failed);
                crate::util::logfile::log(
                    "session-end",
                    "session-end observer registration failed",
                );
            }
        }

        let mut quit_seen = false;
        let mut recovery_retry_requested = false;
        while !quit_seen && !shared.shutdown_requested.load(Ordering::Acquire) {
            unsafe {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                    if message.message == WM_QUIT {
                        quit_seen = true;
                        break;
                    }
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            if quit_seen || shared.shutdown_requested.load(Ordering::Acquire) {
                break;
            }

            if recovery_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                recovery_retry_requested = true;
            }
            if recovery_retry_requested {
                recovery_retry_requested = false;
                recovery_deadline = None;
                close_optional_handle(&mut termsrv_ready_event);
                match unsafe { register_session_notifications(hwnd) } {
                    Ok(()) => {
                        registered = true;
                        shared.tracker.set_readiness(ObserverReadiness::Registered);
                    }
                    Err(_) => {
                        shared.tracker.set_readiness(ObserverReadiness::Failed);
                        crate::util::logfile::log(
                            "session-end",
                            "session-end observer recovery failed",
                        );
                    }
                }
            }

            let mut handles = vec![shutdown_event.handle()];
            if recovery_deadline.is_some() {
                if let Some(event) = termsrv_ready_event {
                    handles.push(event);
                }
            }
            let timeout = recovery_deadline
                .map(wait_millis_until)
                .unwrap_or(STEADY_TICK.as_millis() as u32);
            let result = unsafe {
                MsgWaitForMultipleObjectsEx(
                    Some(&handles),
                    timeout,
                    QS_ALLINPUT,
                    MWMO_INPUTAVAILABLE,
                )
            };
            if result == WAIT_OBJECT_0 {
                break;
            }
            if result == WAIT_FAILED {
                shared.tracker.set_readiness(ObserverReadiness::Failed);
                crate::util::logfile::log("session-end", "session-end observer wait failed");
                break;
            }
            if recovery_deadline.is_some() && result.0 == WAIT_OBJECT_0.0 + 1 {
                recovery_retry_requested = true;
            }
        }

        owner_thread_teardown(&shared, hwnd, &context, registered, termsrv_ready_event);
    }

    fn owner_thread_teardown(
        shared: &ObserverShared,
        hwnd: HWND,
        context: &WindowContext,
        registered: bool,
        mut termsrv_ready_event: Option<HANDLE>,
    ) {
        if registered && !context.destroyed.load(Ordering::Acquire) {
            if unsafe { WTSUnRegisterSessionNotification(hwnd) }.is_err() {
                crate::util::logfile::log("session-end", "session-end observer unregister failed");
            }
        }
        shared.hwnd.store(0, Ordering::Release);
        close_optional_handle(&mut termsrv_ready_event);
        if !context.destroyed.load(Ordering::Acquire) {
            if unsafe { DestroyWindow(hwnd) }.is_err() {
                crate::util::logfile::log(
                    "session-end",
                    "session-end observer window teardown failed",
                );
            }
        }
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, HWND::default(), 0, 0, PM_REMOVE).as_bool() {}
        }
        shared.tracker.set_readiness(ObserverReadiness::Stopped);
    }

    pub use SessionEndObserverHandle as ExportedSessionEndObserverHandle;
}

#[cfg(target_os = "windows")]
pub use windows_observer::ExportedSessionEndObserverHandle as SessionEndObserverHandle;

#[cfg(test)]
struct TestClock(AtomicU64);

#[cfg(test)]
impl Default for TestClock {
    fn default() -> Self {
        Self(AtomicU64::new(0))
    }
}

#[cfg(test)]
impl TestClock {
    fn set(&self, value: u64) {
        self.0.store(value, AtomicOrdering::Release);
    }
}

#[cfg(test)]
impl MonotonicClock for TestClock {
    fn now_millis(&self) -> u64 {
        self.0.load(AtomicOrdering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::sync_outcome::WindowsTerminatorAttribution;
    use std::sync::Arc;

    #[test]
    fn query_end_session_is_never_an_affirmation_and_a_veto_clears_pending_state() {
        let clock = Arc::new(TestClock::default());
        let tracker = SessionEndTracker::new(clock.clone());

        tracker.note_query_end_session();
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::Unattributed
        );

        clock.set(20_001);
        tracker.note_end_session(false);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::Unattributed
        );
    }

    #[test]
    fn only_committed_end_or_same_session_logoff_affirms_within_the_ttl() {
        let clock = Arc::new(TestClock::default());
        let tracker = SessionEndTracker::new(clock.clone());

        tracker.note_end_session(true);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::SessionEndObserved
        );
        clock.set(20_000);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::Unattributed
        );

        tracker.note_wts_logoff_same_session();
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::SessionEndObserved
        );

        tracker.note_query_end_session();
        tracker.note_end_session(false);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::SessionEndObserved,
            "a false end only revokes its pending query, not a committed end"
        );
    }

    #[test]
    fn failed_or_stopped_observer_fails_closed_even_after_a_fresh_affirmation() {
        let clock = Arc::new(TestClock::default());
        let tracker = SessionEndTracker::new(clock);
        tracker.note_end_session(true);

        tracker.set_readiness(ObserverReadiness::Failed);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::ObserverFailed
        );
        tracker.set_readiness(ObserverReadiness::Stopped);
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::ObserverFailed
        );
    }

    #[test]
    fn readiness_status_uses_only_fixed_vocabulary() {
        assert_eq!(ObserverReadiness::Starting.class_name(), "starting");
        assert_eq!(ObserverReadiness::Registered.class_name(), "registered");
        assert_eq!(ObserverReadiness::Recovering.class_name(), "recovering");
        assert_eq!(ObserverReadiness::Failed.class_name(), "failed");
        assert_eq!(ObserverReadiness::Stopped.class_name(), "stopped");
    }
}
