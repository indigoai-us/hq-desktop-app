//! Native app lifecycle evidence attached to auto-sync watcher exit events.
//!
//! These values name signals observed by this app. A Windows query remains a
//! query (it can be vetoed); only a committed end or same-session logoff proves
//! that the OS is ending the session.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

const SESSION_EVIDENCE_TTL_MS: u64 = 120_000;
pub const SYSTEM_SLEEP_RESUME_WINDOW_SECONDS: u64 = 120;
const NO_TIMESTAMP: u64 = u64::MAX;
const SESSION_NONE: u8 = 0;
const SESSION_WINDOWS_QUERY: u8 = 1;
const SESSION_WINDOWS_COMMITTED: u8 = 2;
const SESSION_WINDOWS_LOGOFF: u8 = 3;
const SESSION_MAC_WILL_POWER_OFF: u8 = 4;

static SESSION_SIGNAL: AtomicU8 = AtomicU8::new(SESSION_NONE);
static SESSION_SIGNAL_AT_MS: AtomicU64 = AtomicU64::new(NO_TIMESTAMP);
static SYSTEM_POWER_OBSERVER_AVAILABLE: AtomicBool = AtomicBool::new(false);
static SESSION_END_OBSERVER_AVAILABLE: AtomicBool = AtomicBool::new(false);
static SYSTEM_SLEEPING: AtomicBool = AtomicBool::new(false);
static LAST_SYSTEM_RESUME_AT_MS: AtomicU64 = AtomicU64::new(NO_TIMESTAMP);
static PROCESS_STARTED_AT: OnceLock<Instant> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherExitLifecycleEvidence {
    pub session_ending: &'static str,
    pub system_sleep_resume_within_120_seconds: &'static str,
    pub system_power_observer: &'static str,
}

#[derive(Debug, Clone, Copy, Default)]
struct LifecycleState {
    power_observer_available: bool,
    session_end_observer_available: bool,
    last_resume_at_ms: Option<u64>,
    session_signal: u8,
    session_signal_at_ms: Option<u64>,
}

impl LifecycleState {
    fn snapshot_at(&self, now_ms: u64) -> WatcherExitLifecycleEvidence {
        let session_ending = match self.session_signal_at_ms {
            Some(at_ms)
                if self.session_signal != SESSION_NONE
                    && within_window(now_ms, at_ms, SESSION_EVIDENCE_TTL_MS) =>
            {
                session_signal_name(self.session_signal)
            }
            _ if self.session_end_observer_available => "none",
            _ => "unavailable",
        };
        let resume = if !self.power_observer_available {
            "unavailable"
        } else if self.last_resume_at_ms.is_some_and(|resumed_at| {
            within_window(
                now_ms,
                resumed_at,
                SYSTEM_SLEEP_RESUME_WINDOW_SECONDS.saturating_mul(1_000),
            )
        }) {
            "true"
        } else {
            "false"
        };
        let observer = if self.power_observer_available {
            "active"
        } else {
            "unavailable"
        };
        WatcherExitLifecycleEvidence {
            session_ending,
            system_sleep_resume_within_120_seconds: resume,
            system_power_observer: observer,
        }
    }

    fn note_session_signal(&mut self, signal: u8, now_ms: u64) {
        self.session_signal = signal;
        self.session_signal_at_ms = Some(now_ms);
    }

    fn note_windows_end_session(&mut self, ending: bool, now_ms: u64) {
        if ending {
            self.note_session_signal(SESSION_WINDOWS_COMMITTED, now_ms);
        } else if self.session_signal == SESSION_WINDOWS_QUERY {
            self.session_signal = SESSION_NONE;
            self.session_signal_at_ms = None;
        }
    }

    fn note_sleep(&mut self) {
        self.last_resume_at_ms = None;
    }

    fn note_resume(&mut self, at_ms: u64, was_sleeping: bool) {
        if was_sleeping {
            self.last_resume_at_ms = Some(at_ms);
        }
    }
}

fn session_signal_name(signal: u8) -> &'static str {
    match signal {
        SESSION_WINDOWS_QUERY => "wm_query_end_session",
        SESSION_WINDOWS_COMMITTED => "wm_end_session",
        SESSION_WINDOWS_LOGOFF => "wts_logoff",
        SESSION_MAC_WILL_POWER_OFF => "macos_will_power_off",
        _ => "none",
    }
}

fn within_window(now_ms: u64, event_ms: u64, window_ms: u64) -> bool {
    now_ms >= event_ms && now_ms - event_ms <= window_ms
}

pub fn initialize_watcher_exit_lifecycle() {
    let _ = PROCESS_STARTED_AT.get_or_init(Instant::now);
}

fn process_start_ms() -> u64 {
    PROCESS_STARTED_AT
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn current_state() -> LifecycleState {
    let session_signal = SESSION_SIGNAL.load(Ordering::Acquire);
    let session_at = SESSION_SIGNAL_AT_MS.load(Ordering::Acquire);
    let resume_at = LAST_SYSTEM_RESUME_AT_MS.load(Ordering::Acquire);
    LifecycleState {
        power_observer_available: SYSTEM_POWER_OBSERVER_AVAILABLE.load(Ordering::Acquire),
        session_end_observer_available: SESSION_END_OBSERVER_AVAILABLE.load(Ordering::Acquire),
        last_resume_at_ms: (resume_at != NO_TIMESTAMP).then_some(resume_at),
        session_signal,
        session_signal_at_ms: (session_at != NO_TIMESTAMP).then_some(session_at),
    }
}

pub fn current_watcher_exit_lifecycle_evidence() -> WatcherExitLifecycleEvidence {
    current_state().snapshot_at(process_start_ms())
}

pub fn set_system_power_observer_available(available: bool) {
    initialize_watcher_exit_lifecycle();
    SYSTEM_POWER_OBSERVER_AVAILABLE.store(available, Ordering::Release);
}

pub fn set_session_end_observer_available(available: bool) {
    initialize_watcher_exit_lifecycle();
    SESSION_END_OBSERVER_AVAILABLE.store(available, Ordering::Release);
}

pub fn note_system_sleep() {
    SYSTEM_SLEEPING.store(true, Ordering::Release);
    LAST_SYSTEM_RESUME_AT_MS.store(NO_TIMESTAMP, Ordering::Release);
}

pub fn note_system_resume() {
    if SYSTEM_SLEEPING.swap(false, Ordering::AcqRel) {
        LAST_SYSTEM_RESUME_AT_MS.store(process_start_ms(), Ordering::Release);
    }
}

pub fn note_windows_query_end_session() {
    set_session_signal(SESSION_WINDOWS_QUERY);
}

pub fn note_windows_end_session(ending: bool) {
    if ending {
        set_session_signal(SESSION_WINDOWS_COMMITTED);
    } else if SESSION_SIGNAL
        .compare_exchange(
            SESSION_WINDOWS_QUERY,
            SESSION_NONE,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
    {
        SESSION_SIGNAL_AT_MS.store(NO_TIMESTAMP, Ordering::Release);
    }
}

pub fn note_windows_logoff() {
    set_session_signal(SESSION_WINDOWS_LOGOFF);
}

fn set_session_signal(signal: u8) {
    SESSION_SIGNAL_AT_MS.store(process_start_ms(), Ordering::Relaxed);
    SESSION_SIGNAL.store(signal, Ordering::Release);
}

#[cfg(target_os = "macos")]
pub fn initialize_macos_power_observer() {
    use std::ffi::c_void;
    use std::ptr;
    static ATTEMPTED: AtomicBool = AtomicBool::new(false);
    static REGISTRATION: OnceLock<(usize, usize, u32)> = OnceLock::new();

    if ATTEMPTED.swap(true, Ordering::AcqRel) {
        return;
    }

    set_session_end_observer_available(initialize_macos_session_end_observer());

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IORegisterForSystemPower(
            refcon: *mut c_void,
            notification_port: *mut *mut c_void,
            callback: unsafe extern "C" fn(*mut c_void, u32, u32, *mut c_void),
            notifier: *mut u32,
        ) -> u32;
        fn IONotificationPortGetRunLoopSource(notification_port: *mut c_void) -> *mut c_void;
        fn IOAllowPowerChange(connect: u32, notification_id: isize) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRunLoopGetMain() -> *mut c_void;
        fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
        static kCFRunLoopDefaultMode: *const c_void;
    }

    unsafe extern "C" fn power_callback(
        _refcon: *mut c_void,
        _service: u32,
        message_type: u32,
        message_argument: *mut c_void,
    ) {
        const IO_MESSAGE_SYSTEM_WILL_SLEEP: u32 = 0x0000_0100;
        const IO_MESSAGE_CAN_SYSTEM_SLEEP: u32 = 0x0000_0102;
        const IO_MESSAGE_SYSTEM_HAS_POWERED_ON: u32 = 0x0000_0300;

        let connect = REGISTRATION
            .get()
            .map(|(connect, _, _)| *connect as u32)
            .unwrap_or(0);
        match message_type {
            IO_MESSAGE_SYSTEM_WILL_SLEEP => {
                note_system_sleep();
                if connect != 0 {
                    let _ = IOAllowPowerChange(connect, message_argument as isize);
                }
            }
            IO_MESSAGE_CAN_SYSTEM_SLEEP => {
                if connect != 0 {
                    let _ = IOAllowPowerChange(connect, message_argument as isize);
                }
            }
            IO_MESSAGE_SYSTEM_HAS_POWERED_ON => note_system_resume(),
            _ => {}
        }
    }

    let mut notification_port = ptr::null_mut();
    let mut notifier = 0;
    // SAFETY: the IOKit registration uses a process-lifetime callback and its
    // returned notification port is attached to the main CFRunLoop below.
    let connect = unsafe {
        IORegisterForSystemPower(
            ptr::null_mut(),
            &mut notification_port,
            power_callback,
            &mut notifier,
        )
    };
    if connect == 0 || notification_port.is_null() {
        set_system_power_observer_available(false);
        crate::util::logfile::log("session-end", "macOS power observer unavailable");
        return;
    }

    // SAFETY: both handles are returned by IOKit and the mode is a CoreFoundation
    // global. The main run loop is the app's event loop used by the native callback.
    let source = unsafe { IONotificationPortGetRunLoopSource(notification_port) };
    let run_loop = unsafe { CFRunLoopGetMain() };
    if source.is_null() || run_loop.is_null() {
        set_system_power_observer_available(false);
        crate::util::logfile::log("session-end", "macOS power run loop unavailable");
        return;
    }
    unsafe { CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode) };
    let _ = REGISTRATION.set((connect as usize, notification_port as usize, notifier));
    set_system_power_observer_available(true);
}

#[cfg(target_os = "macos")]
fn initialize_macos_session_end_observer() -> bool {
    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::CString;
    use std::ptr;

    // This process-lifetime observer is registered once at app startup. The
    // notification center owns its copied block; retain the returned token so
    // the registration remains valid for the life of this process.
    static OBSERVER_TOKEN: OnceLock<usize> = OnceLock::new();

    autoreleasepool(|_| unsafe {
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let notification_center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
        let notification_name = match CString::new("NSWorkspaceWillPowerOffNotification") {
            Ok(name) => name,
            Err(error) => {
                crate::util::logfile::log(
                    "session-end",
                    &format!("macOS will-power-off observer name invalid: {error}"),
                );
                return false;
            }
        };
        let notification_name: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: notification_name.as_ptr()];
        if notification_name.is_null() {
            crate::util::logfile::log(
                "session-end",
                "macOS will-power-off notification name unavailable",
            );
            return false;
        }

        let observer = RcBlock::new(|_notification: *mut AnyObject| {
            set_session_signal(SESSION_MAC_WILL_POWER_OFF);
        });
        let observer_token: Retained<AnyObject> = msg_send![
            &*notification_center,
            addObserverForName: notification_name
            object: ptr::null_mut::<AnyObject>()
            queue: ptr::null_mut::<AnyObject>()
            usingBlock: &*observer
        ];
        let token = Retained::into_raw(observer_token) as usize;
        if OBSERVER_TOKEN.set(token).is_err() {
            crate::util::logfile::log(
                "session-end",
                "macOS will-power-off observer token already initialized",
            );
        }
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_snapshot_names_windows_query_commit_and_veto_separately() {
        let mut state = LifecycleState::default();
        state.power_observer_available = true;
        state.session_end_observer_available = true;
        assert_eq!(state.snapshot_at(900).session_ending, "none");
        assert_eq!(
            state.snapshot_at(900).system_sleep_resume_within_120_seconds,
            "false"
        );
        state.note_session_signal(SESSION_WINDOWS_QUERY, 1_000);
        assert_eq!(state.snapshot_at(1_100).session_ending, "wm_query_end_session");

        state.note_windows_end_session(false, 1_200);
        assert_eq!(state.snapshot_at(1_300).session_ending, "none");

        state.note_session_signal(SESSION_WINDOWS_QUERY, 2_000);
        state.note_windows_end_session(true, 2_100);
        assert_eq!(state.snapshot_at(2_200).session_ending, "wm_end_session");
    }

    #[test]
    fn lifecycle_snapshot_expires_session_signals_and_reports_missing_observers() {
        let mut state = LifecycleState::default();
        assert_eq!(state.snapshot_at(5_000).session_ending, "unavailable");
        assert_eq!(
            state
                .snapshot_at(5_000)
                .system_sleep_resume_within_120_seconds,
            "unavailable"
        );

        state.power_observer_available = true;
        assert_eq!(state.snapshot_at(5_000).session_ending, "unavailable");
        state.session_end_observer_available = true;
        assert_eq!(state.snapshot_at(5_000).session_ending, "none");
        state.note_session_signal(SESSION_WINDOWS_LOGOFF, 1_000);
        assert_eq!(state.snapshot_at(121_000).session_ending, "wts_logoff");
        assert_eq!(state.snapshot_at(121_001).session_ending, "none");
    }

    #[test]
    fn sleep_resume_requires_an_observed_sleep_and_has_a_bounded_window() {
        let mut state = LifecycleState {
            power_observer_available: true,
            ..LifecycleState::default()
        };
        state.note_resume(1_000, false);
        assert_eq!(
            state.snapshot_at(1_100).system_sleep_resume_within_120_seconds,
            "false"
        );

        state.note_sleep();
        state.note_resume(2_000, true);
        assert_eq!(
            state.snapshot_at(122_000).system_sleep_resume_within_120_seconds,
            "true"
        );
        assert_eq!(
            state.snapshot_at(122_001).system_sleep_resume_within_120_seconds,
            "false"
        );
    }

    #[test]
    fn every_session_end_signal_has_a_stable_tag() {
        for (signal, expected) in [
            (SESSION_WINDOWS_QUERY, "wm_query_end_session"),
            (SESSION_WINDOWS_COMMITTED, "wm_end_session"),
            (SESSION_WINDOWS_LOGOFF, "wts_logoff"),
            (SESSION_MAC_WILL_POWER_OFF, "macos_will_power_off"),
        ] {
            assert_eq!(session_signal_name(signal), expected);
        }
    }
}
