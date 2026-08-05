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

    fn now_millis(&self) -> u64 {
        self.clock.now_millis()
    }

    #[cfg(test)]
    fn pending_query_millis_for_test(&self) -> Option<u64> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending_query_ms
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

    const TERMSRV_READY_WAIT_MS: u64 = 10_000;
    const STEADY_TICK_MS: u32 = 60_000;
    const RPC_S_INVALID_BINDING_HRESULT: u32 = 0x8007_06A6;

    type RegistrationSeam = Box<dyn Fn(HWND) -> Result<(), Error> + Send + Sync>;
    type ReadyEventSeam = Box<dyn Fn() -> Option<HANDLE> + Send + Sync>;
    type ThreadHook = Box<dyn FnOnce() + Send>;
    type WindowHook = Box<dyn FnOnce(HWND) + Send>;

    struct ObserverSeams {
        register: RegistrationSeam,
        unregister: RegistrationSeam,
        open_termsrv_ready_event: ReadyEventSeam,
        on_thread_start: Option<ThreadHook>,
        after_window_created: Option<WindowHook>,
    }

    impl ObserverSeams {
        fn production() -> Self {
            Self {
                register: Box::new(|hwnd| unsafe { register_session_notifications(hwnd) }),
                unregister: Box::new(|hwnd| unsafe { WTSUnRegisterSessionNotification(hwnd) }),
                open_termsrv_ready_event: Box::new(|| unsafe { open_termsrv_ready_event() }),
                on_thread_start: None,
                after_window_created: None,
            }
        }
    }

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
        session_id: Option<u32>,
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
            Self::start_with(tracker, ObserverSeams::production())
        }

        fn start_with(tracker: Arc<SessionEndTracker>, seams: ObserverSeams) -> Self {
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
                .spawn(move || observer_thread(thread_shared, seams));

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

    fn wait_millis_until(deadline_ms: u64, now_ms: u64) -> u32 {
        deadline_ms.saturating_sub(now_ms).min(u64::from(u32::MAX)) as u32
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
                if wparam.0 as u32 == WTS_SESSION_LOGOFF
                    && context.session_id == Some(lparam.0 as u32)
                {
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

    fn observer_thread(shared: Arc<ObserverShared>, mut seams: ObserverSeams) {
        if let Some(hook) = seams.on_thread_start.take() {
            hook();
        }
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

        let mut raw_session_id = 0;
        let session_id = if unsafe {
            ProcessIdToSessionId(GetCurrentProcessId(), &mut raw_session_id)
        }
        .is_ok()
        {
            Some(raw_session_id)
        } else {
            crate::util::logfile::log(
                "session-end",
                "session-end observer session lookup unavailable",
            );
            None
        };
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
        if let Some(hook) = seams.after_window_created.take() {
            hook(hwnd);
        }

        if shared.shutdown_requested.load(Ordering::Acquire) {
            owner_thread_teardown(&shared, hwnd, &context, false, None, &seams);
            return;
        }

        let mut registered = false;
        let mut recovery_deadline = None;
        let mut termsrv_ready_event = None;
        match (seams.register)(hwnd) {
            Ok(()) => {
                registered = true;
                shared.tracker.set_readiness(ObserverReadiness::Registered);
            }
            Err(error) if is_termsrv_not_ready(&error) => {
                shared.tracker.set_readiness(ObserverReadiness::Recovering);
                recovery_deadline = Some(
                    shared
                        .tracker
                        .now_millis()
                        .saturating_add(TERMSRV_READY_WAIT_MS),
                );
                termsrv_ready_event = (seams.open_termsrv_ready_event)();
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

            let now_ms = shared.tracker.now_millis();
            if recovery_deadline.is_some_and(|deadline| now_ms >= deadline) {
                recovery_retry_requested = true;
            }
            if recovery_retry_requested {
                recovery_retry_requested = false;
                recovery_deadline = None;
                close_optional_handle(&mut termsrv_ready_event);
                match (seams.register)(hwnd) {
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
                .map(|deadline| wait_millis_until(deadline, shared.tracker.now_millis()))
                .unwrap_or(STEADY_TICK_MS);
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
            if recovery_deadline.is_some()
                && termsrv_ready_event.is_some()
                && result.0 == WAIT_OBJECT_0.0 + 1
            {
                recovery_retry_requested = true;
            }
        }

        owner_thread_teardown(
            &shared,
            hwnd,
            &context,
            registered,
            termsrv_ready_event,
            &seams,
        );
    }

    fn owner_thread_teardown(
        shared: &ObserverShared,
        hwnd: HWND,
        context: &WindowContext,
        registered: bool,
        mut termsrv_ready_event: Option<HANDLE>,
        seams: &ObserverSeams,
    ) {
        if registered && !context.destroyed.load(Ordering::Acquire) {
            if (seams.unregister)(hwnd).is_err() {
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

    #[cfg(test)]
    mod windows_tests {
        use super::super::TestClock;
        use super::*;
        use hq_desktop_core::sync_outcome::WindowsTerminatorAttribution;
        use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering as TestOrdering};
        use std::sync::{mpsc, Arc, Mutex};
        use std::thread;
        use std::time::{Duration, Instant};
        use windows::core::HRESULT;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SendMessageW, WTS_SESSION_LOCK};

        static WINDOWS_OBSERVER_TEST_LOCK: Mutex<()> = Mutex::new(());
        const TEST_WAIT: Duration = Duration::from_secs(5);
        const REAL_REGISTRATION_WAIT: Duration = Duration::from_secs(15);

        struct AdvancingTestClock {
            started_at: Instant,
            offset_ms: AtomicU64,
        }

        impl Default for AdvancingTestClock {
            fn default() -> Self {
                Self {
                    started_at: Instant::now(),
                    offset_ms: AtomicU64::new(0),
                }
            }
        }

        impl AdvancingTestClock {
            fn advance_by(&self, millis: u64) {
                self.offset_ms.fetch_add(millis, TestOrdering::AcqRel);
            }
        }

        impl super::super::MonotonicClock for AdvancingTestClock {
            fn now_millis(&self) -> u64 {
                let elapsed = self
                    .started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64;
                elapsed.saturating_add(self.offset_ms.load(TestOrdering::Acquire))
            }
        }

        fn test_guard() -> std::sync::MutexGuard<'static, ()> {
            WINDOWS_OBSERVER_TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        fn tracker() -> (Arc<TestClock>, Arc<SessionEndTracker>) {
            let clock = Arc::new(TestClock::default());
            let tracker = Arc::new(SessionEndTracker::new(clock.clone()));
            (clock, tracker)
        }

        fn wait_until(deadline: Duration, message: &str, mut predicate: impl FnMut() -> bool) {
            let until = Instant::now() + deadline;
            while !predicate() {
                assert!(Instant::now() < until, "{message}");
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn wait_for_readiness(
            handle: &SessionEndObserverHandle,
            expected: ObserverReadiness,
            deadline: Duration,
        ) {
            wait_until(deadline, "observer readiness deadline expired", || {
                handle.tracker().readiness() == expected
            });
        }

        fn observer_hwnd(handle: &SessionEndObserverHandle) -> HWND {
            wait_until(TEST_WAIT, "observer did not publish its window", || {
                handle.shared.hwnd.load(Ordering::Acquire) != 0
            });
            HWND(handle.shared.hwnd.load(Ordering::Acquire) as *mut c_void)
        }

        fn send_message_bounded(
            hwnd: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            let hwnd_raw = hwnd.0 as isize;
            let (done_tx, done_rx) = mpsc::sync_channel(1);
            let sender = thread::spawn(move || {
                let hwnd = HWND(hwnd_raw as *mut c_void);
                let result = unsafe { SendMessageW(hwnd, message, wparam, lparam) };
                let _ = done_tx.send(result.0);
            });
            let result = done_rx
                .recv_timeout(TEST_WAIT)
                .expect("observer did not dispatch a window message before the deadline");
            wait_until(TEST_WAIT, "message sender did not finish", || {
                sender.is_finished()
            });
            sender.join().expect("message sender panicked");
            LRESULT(result)
        }

        fn termsrv_not_ready_error() -> Error {
            Error::from_hresult(HRESULT(RPC_S_INVALID_BINDING_HRESULT as i32))
        }

        fn test_seams(
            register: impl Fn(HWND) -> Result<(), Error> + Send + Sync + 'static,
            unregister: impl Fn(HWND) -> Result<(), Error> + Send + Sync + 'static,
        ) -> ObserverSeams {
            ObserverSeams {
                register: Box::new(register),
                unregister: Box::new(unregister),
                open_termsrv_ready_event: Box::new(|| None),
                on_thread_start: None,
                after_window_created: None,
            }
        }

        #[test]
        fn message_input_without_a_termsrv_event_does_not_consume_the_final_retry() {
            let _guard = test_guard();
            let (_clock, tracker) = tracker();
            let register_calls = Arc::new(AtomicUsize::new(0));
            let calls = Arc::clone(&register_calls);
            let seams = test_seams(
                move |_| {
                    calls.fetch_add(1, TestOrdering::AcqRel);
                    Err(termsrv_not_ready_error())
                },
                |_| Ok(()),
            );
            let handle = SessionEndObserverHandle::start_with(Arc::clone(&tracker), seams);

            wait_for_readiness(&handle, ObserverReadiness::Recovering, TEST_WAIT);
            let hwnd = observer_hwnd(&handle);
            assert_eq!(
                send_message_bounded(hwnd, WM_QUERYENDSESSION, WPARAM(0), LPARAM(0)),
                LRESULT(1)
            );
            wait_until(TEST_WAIT, "query message was not recorded", || {
                tracker.pending_query_millis_for_test() == Some(0)
            });
            thread::sleep(Duration::from_millis(50));
            let calls_after_message = register_calls.load(TestOrdering::Acquire);

            handle.shutdown(Duration::from_millis(500));

            assert_eq!(calls_after_message, 1);
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }

        #[test]
        fn injected_recovery_deadline_allows_exactly_one_final_retry() {
            let _guard = test_guard();
            let (clock, tracker) = tracker();
            let register_calls = Arc::new(AtomicUsize::new(0));
            let calls = Arc::clone(&register_calls);
            let seams = test_seams(
                move |_| {
                    calls.fetch_add(1, TestOrdering::AcqRel);
                    Err(termsrv_not_ready_error())
                },
                |_| Ok(()),
            );
            let handle = SessionEndObserverHandle::start_with(Arc::clone(&tracker), seams);
            wait_for_readiness(&handle, ObserverReadiness::Recovering, TEST_WAIT);
            let hwnd = observer_hwnd(&handle);

            clock.set(TERMSRV_READY_WAIT_MS);
            send_message_bounded(hwnd, WM_QUERYENDSESSION, WPARAM(0), LPARAM(0));
            wait_for_readiness(&handle, ObserverReadiness::Failed, TEST_WAIT);
            assert_eq!(register_calls.load(TestOrdering::Acquire), 2);

            send_message_bounded(hwnd, WM_QUERYENDSESSION, WPARAM(0), LPARAM(0));
            thread::sleep(Duration::from_millis(50));
            let calls_after_failure = register_calls.load(TestOrdering::Acquire);
            handle.shutdown(Duration::from_millis(500));

            assert_eq!(calls_after_failure, 2);
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }

        #[test]
        fn shutdown_before_window_publication_creates_no_window_and_joins() {
            let _guard = test_guard();
            let (_clock, tracker) = tracker();
            let (entered_tx, entered_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let windows_created = Arc::new(AtomicUsize::new(0));
            let created = Arc::clone(&windows_created);
            let mut seams = test_seams(|_| Ok(()), |_| Ok(()));
            seams.on_thread_start = Some(Box::new(move || {
                let _ = entered_tx.send(());
                release_rx
                    .recv_timeout(TEST_WAIT)
                    .expect("test did not release observer thread");
            }));
            seams.after_window_created = Some(Box::new(move |_| {
                created.fetch_add(1, TestOrdering::AcqRel);
            }));
            let handle = Arc::new(SessionEndObserverHandle::start_with(tracker, seams));
            entered_rx
                .recv_timeout(TEST_WAIT)
                .expect("observer did not enter the start hook");

            let (shutdown_done_tx, shutdown_done_rx) = mpsc::sync_channel(1);
            let shutdown_handle = Arc::clone(&handle);
            let shutdown_thread = thread::spawn(move || {
                shutdown_handle.shutdown(Duration::from_millis(500));
                let _ = shutdown_done_tx.send(());
            });
            wait_until(TEST_WAIT, "shutdown flag was not published", || {
                handle.shared.shutdown_requested.load(Ordering::Acquire)
            });
            release_tx.send(()).expect("failed to release observer");
            shutdown_done_rx
                .recv_timeout(TEST_WAIT)
                .expect("bounded shutdown did not return");
            wait_until(TEST_WAIT, "shutdown caller did not finish", || {
                shutdown_thread.is_finished()
            });
            shutdown_thread.join().expect("shutdown caller panicked");

            assert_eq!(windows_created.load(TestOrdering::Acquire), 0);
            assert_eq!(handle.shared.hwnd.load(Ordering::Acquire), 0);
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }

        #[test]
        fn shutdown_during_recovery_never_registers_after_teardown_or_unregisters() {
            let _guard = test_guard();
            let (_clock, tracker) = tracker();
            let register_calls = Arc::new(AtomicUsize::new(0));
            let late_register_calls = Arc::new(AtomicUsize::new(0));
            let unregister_calls = Arc::new(AtomicUsize::new(0));
            let teardown_started = Arc::new(AtomicBool::new(false));
            let calls = Arc::clone(&register_calls);
            let late_calls = Arc::clone(&late_register_calls);
            let teardown = Arc::clone(&teardown_started);
            let unregistrations = Arc::clone(&unregister_calls);
            let seams = test_seams(
                move |_| {
                    calls.fetch_add(1, TestOrdering::AcqRel);
                    if teardown.load(TestOrdering::Acquire) {
                        late_calls.fetch_add(1, TestOrdering::AcqRel);
                    }
                    Err(termsrv_not_ready_error())
                },
                move |_| {
                    unregistrations.fetch_add(1, TestOrdering::AcqRel);
                    Ok(())
                },
            );
            let handle = SessionEndObserverHandle::start_with(tracker, seams);
            wait_for_readiness(&handle, ObserverReadiness::Recovering, TEST_WAIT);

            teardown_started.store(true, TestOrdering::Release);
            handle.shutdown(Duration::from_millis(500));

            assert!((1..=2).contains(&register_calls.load(TestOrdering::Acquire)));
            assert_eq!(late_register_calls.load(TestOrdering::Acquire), 0);
            assert_eq!(unregister_calls.load(TestOrdering::Acquire), 0);
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }

        #[test]
        fn registered_teardown_unregisters_on_the_owner_thread_before_destroy() {
            let _guard = test_guard();
            let (_clock, tracker) = tracker();
            let registration_thread = Arc::new(Mutex::new(None));
            let unregister_calls = Arc::new(AtomicUsize::new(0));
            let unregistered_on_owner = Arc::new(AtomicBool::new(false));
            let window_alive_during_unregister = Arc::new(AtomicBool::new(false));
            let register_thread = Arc::clone(&registration_thread);
            let unregister_thread = Arc::clone(&registration_thread);
            let calls = Arc::clone(&unregister_calls);
            let same_thread = Arc::clone(&unregistered_on_owner);
            let alive = Arc::clone(&window_alive_during_unregister);
            let seams = test_seams(
                move |_| {
                    *register_thread
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        Some(thread::current().id());
                    Ok(())
                },
                move |hwnd| {
                    calls.fetch_add(1, TestOrdering::AcqRel);
                    let owner = unregister_thread
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    same_thread.store(
                        owner.is_some_and(|owner| owner == thread::current().id()),
                        TestOrdering::Release,
                    );
                    alive.store(unsafe { IsWindow(hwnd).as_bool() }, TestOrdering::Release);
                    Ok(())
                },
            );
            let handle = SessionEndObserverHandle::start_with(tracker, seams);
            wait_for_readiness(&handle, ObserverReadiness::Registered, TEST_WAIT);

            handle.shutdown(Duration::from_millis(500));

            assert_eq!(unregister_calls.load(TestOrdering::Acquire), 1);
            assert!(unregistered_on_owner.load(TestOrdering::Acquire));
            assert!(window_alive_during_unregister.load(TestOrdering::Acquire));
            assert_eq!(handle.shared.hwnd.load(Ordering::Acquire), 0);
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }

        #[test]
        fn shutdown_acknowledgement_is_bounded_and_a_second_call_is_a_noop() {
            let _guard = test_guard();
            let (_clock, tracker) = tracker();
            let (entered_tx, entered_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let mut seams = test_seams(|_| Ok(()), |_| Ok(()));
            seams.after_window_created = Some(Box::new(move |_| {
                let _ = entered_tx.send(());
                release_rx
                    .recv_timeout(TEST_WAIT)
                    .expect("test did not release window-created hook");
            }));
            let handle = SessionEndObserverHandle::start_with(tracker, seams);
            entered_rx
                .recv_timeout(TEST_WAIT)
                .expect("observer did not reach window-created hook");

            let started = Instant::now();
            handle.shutdown(Duration::from_millis(100));
            let first_elapsed = started.elapsed();
            let second_started = Instant::now();
            handle.shutdown(Duration::from_secs(1));
            let second_elapsed = second_started.elapsed();
            release_tx.send(()).expect("failed to release observer");
            wait_for_readiness(&handle, ObserverReadiness::Stopped, TEST_WAIT);

            assert!(first_elapsed < Duration::from_millis(500));
            assert!(second_elapsed < Duration::from_millis(50));
        }

        #[test]
        fn real_window_registration_dispatches_only_committed_same_session_end_signals() {
            let _guard = test_guard();
            let clock = Arc::new(AdvancingTestClock::default());
            let tracker = Arc::new(SessionEndTracker::new(clock.clone()));
            let handle = SessionEndObserverHandle::start(Arc::clone(&tracker));
            wait_for_readiness(
                &handle,
                ObserverReadiness::Registered,
                REAL_REGISTRATION_WAIT,
            );
            let hwnd = observer_hwnd(&handle);

            let before_query_ms = super::super::MonotonicClock::now_millis(clock.as_ref());
            assert_eq!(
                send_message_bounded(hwnd, WM_QUERYENDSESSION, WPARAM(0), LPARAM(0)),
                LRESULT(1)
            );
            let after_query_ms = super::super::MonotonicClock::now_millis(clock.as_ref());
            assert!(
                tracker
                    .pending_query_millis_for_test()
                    .is_some_and(|stamp| { (before_query_ms..=after_query_ms).contains(&stamp) }),
                "query timestamp must come from the injected monotonic clock"
            );
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::Unattributed
            );

            send_message_bounded(hwnd, WM_ENDSESSION, WPARAM(0), LPARAM(0));
            assert_eq!(tracker.pending_query_millis_for_test(), None);
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::Unattributed
            );

            send_message_bounded(hwnd, WM_ENDSESSION, WPARAM(1), LPARAM(0));
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::SessionEndObserved
            );
            clock.advance_by(20_001);
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::Unattributed
            );

            let mut own_session_id = 0;
            unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut own_session_id) }
                .expect("current process session id must resolve");
            send_message_bounded(
                hwnd,
                WM_WTSSESSION_CHANGE,
                WPARAM(WTS_SESSION_LOCK as usize),
                LPARAM(own_session_id as isize),
            );
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::Unattributed
            );
            send_message_bounded(
                hwnd,
                WM_WTSSESSION_CHANGE,
                WPARAM(WTS_SESSION_LOGOFF as usize),
                LPARAM(own_session_id.wrapping_add(1) as isize),
            );
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::Unattributed
            );
            send_message_bounded(
                hwnd,
                WM_WTSSESSION_CHANGE,
                WPARAM(WTS_SESSION_LOGOFF as usize),
                LPARAM(own_session_id as isize),
            );
            assert_eq!(
                tracker.attribution_now(),
                WindowsTerminatorAttribution::SessionEndObserved
            );

            handle.shutdown(Duration::from_millis(500));
            assert_eq!(handle.tracker().readiness(), ObserverReadiness::Stopped);
        }
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
        assert_eq!(tracker.pending_query_millis_for_test(), Some(0));
        assert_eq!(
            tracker.attribution_now(),
            WindowsTerminatorAttribution::Unattributed
        );

        clock.set(20_001);
        tracker.note_end_session(false);
        assert_eq!(tracker.pending_query_millis_for_test(), None);
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
