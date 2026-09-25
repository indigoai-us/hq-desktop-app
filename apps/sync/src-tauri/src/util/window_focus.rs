//! Raise a Tauri webview above other apps after browser OAuth (macOS + Windows).
//!
//! Plain `WebviewWindow::set_focus()` is often a no-op once the system browser
//! holds activation/foreground. That leaves the installer / popover visible but
//! buried — and tray toggles then *hide* the already-visible window instead of
//! raising it.
//!
//! Platform strategies:
//! - **Windows:** Show/Restore, AttachThreadInput, brief TOPMOST pulse,
//!   SetForegroundWindow. The `always_on_top` flag is only ever applied
//!   *transiently* (see [`raise_transiently_topmost`]): it comes off again the
//!   first time the window gains or loses focus, or after
//!   [`TRANSIENT_TOPMOST_TIMEOUT`] at the latest. A window that stayed
//!   `WS_EX_TOPMOST` for the rest of the process is what made Alt+Tab unable
//!   to bring any other app in front of HQ after a sign-in (the desktop
//!   workspace window was raised sticky after the OAuth callback and nothing
//!   cleared it).
//! - **macOS:** `NSApplication.activateIgnoringOtherApps` +
//!   `NSWindow.makeKeyAndOrderFront` / `orderFrontRegardless`.
//! - Other targets: show + set_focus.

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;
use tauri::WebviewWindow;

/// Upper bound on how long a transient topmost raise may keep the window
/// above every other app when neither a focus-in nor a focus-out event ever
/// arrives (e.g. the raise was refused by the OS and the window never became
/// foreground).
pub const TRANSIENT_TOPMOST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Show `window` and pull it above other apps (best-effort on every OS).
///
/// Does **not** leave the window sticky-topmost — first-run onboarding calls
/// this before OAuth, and a sticky raise would cover the provider login page.
pub fn bring_webview_to_front(window: &WebviewWindow) {
    raise_webview(window, /*keep_on_top=*/ false);
}

/// Raise after a successful OAuth callback so the window comes above the
/// browser once. On Windows the raise is transiently topmost — see
/// [`raise_transiently_topmost`]; it must never stay sticky.
pub fn bring_webview_to_front_after_oauth(window: &WebviewWindow) {
    raise_transiently_topmost(window);
}

/// Raise `window` above every other app and, on Windows, hold it there only
/// until the raise has visibly landed.
///
/// A plain foreground pulse is sometimes undone by the system browser
/// re-activating right after the OAuth redirect, so the window is marked
/// `always_on_top` for a moment. The flag is released — exactly once — on the
/// first of:
///
/// * `WindowEvent::Focused(true)`: the window is foreground, normal z-order
///   keeps it visible now;
/// * `WindowEvent::Focused(false)`: the user moved on to another app, which
///   must be allowed to come in front;
/// * [`TRANSIENT_TOPMOST_TIMEOUT`] elapsing, as a bound when neither fires.
///
/// macOS behaviour is unchanged (AppKit activation, no topmost flag).
pub fn raise_transiently_topmost(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        transient_topmost::raise(window);
    }
    #[cfg(not(target_os = "windows"))]
    {
        raise_webview(window, /*keep_on_top=*/ false);
    }
}

/// Clear sticky topmost before opening the system browser for OAuth so a
/// previously raised popover cannot intercept clicks on the provider page.
pub fn clear_sticky_topmost(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    transient_topmost::disarm(window);
    let _ = window.set_always_on_top(false);
}

/// Why a transient topmost raise is being released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopmostRelease {
    /// The window became foreground; ordinary z-order keeps it visible.
    Focused,
    /// Focus moved to another window; that window must be allowed in front.
    Blurred,
    /// The bounded timer for the raise with this generation elapsed.
    Timeout { generation: u64 },
    /// An explicit clear (e.g. before opening the browser for OAuth).
    Explicit,
}

/// Pure decision state for one window's transient topmost flag.
///
/// `arm` records a new raise and returns its generation; `release` reports
/// whether the caller must clear the OS topmost flag *now*. Clearing is
/// idempotent (a second release is a no-op) and a stale timeout from an
/// earlier raise cannot cut a newer raise short.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TransientTopmost {
    generation: u64,
    armed: bool,
}

impl TransientTopmost {
    /// Record that the window was just raised topmost. Returns the generation
    /// the caller should hand to its timeout so a late timer from an older
    /// raise is ignored.
    pub fn arm(&mut self) -> u64 {
        self.generation += 1;
        self.armed = true;
        self.generation
    }

    /// True while the OS topmost flag is expected to be set.
    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// Decide whether the OS topmost flag must be cleared in response to
    /// `why`. Returns `true` at most once per `arm`.
    pub fn release(&mut self, why: TopmostRelease) -> bool {
        if !self.armed {
            return false;
        }
        if let TopmostRelease::Timeout { generation } = why {
            if generation != self.generation {
                return false;
            }
        }
        self.armed = false;
        true
    }
}

#[cfg(target_os = "windows")]
mod transient_topmost {
    //! Windows plumbing for [`super::raise_transiently_topmost`]: one
    //! [`TransientTopmost`] per native window, a single focus listener per
    //! native window, and a bounded timer per raise.

    use super::{TopmostRelease, TransientTopmost, TRANSIENT_TOPMOST_TIMEOUT};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::{Manager, WebviewWindow, WindowEvent};

    type Guard = Arc<Mutex<TransientTopmost>>;

    /// Keyed by HWND rather than label: a window that is destroyed and
    /// re-created under the same label (the desktop workspace can be) gets a
    /// fresh guard and its own focus listener instead of inheriting a
    /// listener bound to the dead window.
    static GUARDS: OnceLock<Mutex<HashMap<isize, Guard>>> = OnceLock::new();

    fn hwnd_key(window: &WebviewWindow) -> Option<isize> {
        window.hwnd().ok().map(|h| h.0 as isize)
    }

    fn lock_guard(guard: &Guard) -> std::sync::MutexGuard<'_, TransientTopmost> {
        guard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Fetch (or create, registering the focus listener once) the guard for
    /// this native window.
    fn guard_for(window: &WebviewWindow, key: isize) -> Guard {
        let registry = GUARDS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut map = registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = map.get(&key) {
            return existing.clone();
        }
        let guard: Guard = Arc::new(Mutex::new(TransientTopmost::default()));
        map.insert(key, guard.clone());
        drop(map);

        let listener_window = window.clone();
        let listener_guard = guard.clone();
        window.on_window_event(move |event| {
            let why = match event {
                WindowEvent::Focused(true) => TopmostRelease::Focused,
                WindowEvent::Focused(false) => TopmostRelease::Blurred,
                _ => return,
            };
            release(&listener_window, &listener_guard, why);
        });
        guard
    }

    /// Clear the OS flag if the state machine says so. Window ops run on the
    /// UI thread; every caller here already is (event listener, or a
    /// `run_on_main_thread` hop).
    fn release(window: &WebviewWindow, guard: &Guard, why: TopmostRelease) {
        let must_clear = lock_guard(guard).release(why);
        if must_clear {
            let _ = window.set_always_on_top(false);
            crate::util::logfile::log(
                "window-focus",
                &format!(
                    "transient topmost released ({why:?}) for `{}`",
                    window.label()
                ),
            );
        }
    }

    pub(super) fn raise(window: &WebviewWindow) {
        let Some(key) = hwnd_key(window) else {
            // No native handle: nothing to hold topmost either.
            super::raise_webview(window, /*keep_on_top=*/ false);
            return;
        };
        let guard = guard_for(window, key);

        // Set the flag *before* arming: SetForegroundWindow can deliver
        // `Focused(true)` synchronously inside the raise, and an armed guard
        // would then clear the flag a moment before `raise_webview` sets it —
        // leaving it stuck with nothing left to release it.
        super::raise_webview(window, /*keep_on_top=*/ true);
        let generation = lock_guard(&guard).arm();

        // Bounded backstop: whichever of focus-in / focus-out / timer comes
        // first releases; the rest are no-ops.
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        let timer_guard = guard.clone();
        std::thread::spawn(move || {
            std::thread::sleep(TRANSIENT_TOPMOST_TIMEOUT);
            let app_on_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = app_on_main.get_webview_window(&label) {
                    if hwnd_key(&win) == Some(key) {
                        release(&win, &timer_guard, TopmostRelease::Timeout { generation });
                    }
                }
            });
        });
    }

    /// Forget any pending raise for this window (the caller clears the OS
    /// flag itself).
    pub(super) fn disarm(window: &WebviewWindow) {
        let Some(key) = hwnd_key(window) else { return };
        let Some(registry) = GUARDS.get() else { return };
        let guard = registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .cloned();
        if let Some(guard) = guard {
            let _ = lock_guard(&guard).release(TopmostRelease::Explicit);
        }
    }
}

fn raise_webview(window: &WebviewWindow, keep_on_top: bool) {
    let _ = window.unminimize();
    let _ = window.show();

    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            force_foreground_hwnd(hwnd.0 as isize);
        }
        if keep_on_top {
            let _ = window.set_always_on_top(true);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = keep_on_top;
        force_foreground_macos_on_main(window);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = keep_on_top;
    }

    let _ = window.set_focus();
}

/// True when the caller is on the AppKit main thread.
#[cfg(target_os = "macos")]
fn is_main_thread() -> bool {
    use objc2::{class, msg_send};

    // SAFETY: `+[NSThread isMainThread]` is a public class method that is
    // explicitly safe to send from any thread — asking the question cannot
    // itself be a threading violation.
    unsafe { msg_send![class!(NSThread), isMainThread] }
}

/// Run the raw AppKit activation on the main thread, hopping if necessary.
///
/// **This guard is load-bearing — do not inline it away.** `force_foreground_macos`
/// sends `makeKeyAndOrderFront:` / `activateIgnoringOtherApps:` directly. On
/// macOS 26 AppKit hard-traps those off the main thread with
/// `EXC_BREAKPOINT` + "Must only be used from the main thread", killing the
/// process — it is not a warning and not best-effort.
///
/// Every `async` `#[tauri::command]` body runs on a tokio worker, not the main
/// thread, and three of them reach here:
///
///   * `commands::banner::show_main_window`          (the update banner's action)
///   * `commands::compat::launch_menubar_app`
///   * `commands::notification_history::open_notification_history`
///
/// That is how a user clicking **Update** crashed HQ 0.10.35: the banner action
/// invoked `show_main_window`, which called straight through to AppKit from a
/// worker thread. Non-async commands (`bring_main_window_to_front`,
/// `open_settings_window`, `show_main_window_at_tray`) already run on the main
/// thread, and the OAuth / tray / auth paths hop explicitly — so the defect was
/// only ever the async trio.
///
/// The guard lives here, at the one place that genuinely requires the main
/// thread, rather than in each caller: that fixes all three at once and means a
/// future async caller cannot reintroduce the crash.
#[cfg(target_os = "macos")]
fn force_foreground_macos_on_main(window: &WebviewWindow) {
    if is_main_thread() {
        force_foreground_macos(window);
        return;
    }

    // Re-resolve the window by label on the main thread rather than sending a
    // `WebviewWindow` across: it keeps the closure `Send` without relying on
    // the handle staying valid, and a window that closed in between simply
    // does nothing instead of touching a stale `NSWindow`.
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let hop = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window(&label) {
            force_foreground_macos(&win);
        }
    });
    if hop.is_err() {
        // Better a window that did not come forward than a dead process.
        crate::util::logfile::log(
            "window-focus",
            "raise: could not reach the main thread; skipped AppKit activation",
        );
    }
}

#[cfg(target_os = "macos")]
fn force_foreground_macos(window: &WebviewWindow) {
    use objc2::{class, msg_send, runtime::AnyObject};

    // MAIN THREAD ONLY — reached via `force_foreground_macos_on_main`, which
    // enforces that. macOS 26 traps these selectors off the main thread.
    debug_assert!(
        is_main_thread(),
        "force_foreground_macos must run on the AppKit main thread"
    );
    unsafe {
        let app_cls = class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if !app.is_null() {
            // Pull HQ ahead of Safari/Chrome after the OAuth redirect lands.
            let _: () = msg_send![app, activateIgnoringOtherApps: true];
        }

        if let Ok(ns_win_raw) = window.ns_window() {
            let ns_win = ns_win_raw as *mut AnyObject;
            if !ns_win.is_null() {
                let nil: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![ns_win, makeKeyAndOrderFront: nil];
                // orderFrontRegardless works even when the app is not active yet
                // (accessory / menubar policy) — needed after browser OAuth.
                let _: () = msg_send![ns_win, orderFrontRegardless];
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn force_foreground_hwnd(hwnd_raw: isize) {
    use windows_sys::Win32::Foundation::{FALSE, TRUE};
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
    };

    let hwnd = hwnd_raw as windows_sys::Win32::Foundation::HWND;
    if hwnd.is_null() {
        return;
    }

    hq_telemetry::record_native_panic_seam(hq_telemetry::NativePanicSeam::WindowForceForeground);

    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }

        let foreground = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
        let cur_thread = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != cur_thread;
        if attached {
            let _ = AttachThreadInput(fg_thread, cur_thread, TRUE);
        }

        let _ = BringWindowToTop(hwnd);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = SetForegroundWindow(hwnd);
        // Drop the temporary TOPMOST pulse. A longer-lived flag is only ever
        // applied by `raise_transiently_topmost`, which releases it again on
        // the first focus change or after a bounded timeout.
        let _ = SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );

        if attached {
            let _ = AttachThreadInput(fg_thread, cur_thread, FALSE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TopmostRelease, TransientTopmost, TRANSIENT_TOPMOST_TIMEOUT};

    // Regression coverage for the Windows "HQ stays above every app after
    // sign-in / Alt+Tab cannot bring anything in front" bug: the topmost flag
    // applied by the post-OAuth raise must be released exactly once, on the
    // first focus change or on the bounded timeout, and never linger.

    #[test]
    fn fresh_guard_is_not_armed_and_has_nothing_to_release() {
        let mut guard = TransientTopmost::default();
        assert!(!guard.is_armed());
        assert!(!guard.release(TopmostRelease::Blurred));
        assert!(!guard.release(TopmostRelease::Focused));
        assert!(!guard.release(TopmostRelease::Timeout { generation: 0 }));
        assert!(!guard.release(TopmostRelease::Explicit));
    }

    #[test]
    fn raised_window_is_cleared_on_first_blur_then_idempotent() {
        let mut guard = TransientTopmost::default();
        guard.arm();
        assert!(guard.is_armed());
        assert!(
            guard.release(TopmostRelease::Blurred),
            "first blur must clear"
        );
        assert!(!guard.is_armed());
        assert!(
            !guard.release(TopmostRelease::Blurred),
            "second blur is a no-op"
        );
        assert!(!guard.release(TopmostRelease::Focused));
    }

    #[test]
    fn raised_window_is_cleared_once_it_has_been_focused() {
        let mut guard = TransientTopmost::default();
        guard.arm();
        assert!(guard.release(TopmostRelease::Focused));
        assert!(!guard.release(TopmostRelease::Blurred));
    }

    #[test]
    fn raised_window_is_cleared_by_its_own_timeout() {
        let mut guard = TransientTopmost::default();
        let generation = guard.arm();
        assert!(guard.release(TopmostRelease::Timeout { generation }));
        assert!(!guard.is_armed());
        assert!(!guard.release(TopmostRelease::Timeout { generation }));
    }

    #[test]
    fn stale_timeout_from_an_earlier_raise_does_not_cut_a_newer_raise_short() {
        let mut guard = TransientTopmost::default();
        let first = guard.arm();
        assert!(guard.release(TopmostRelease::Blurred));
        let second = guard.arm();
        assert_ne!(first, second);
        assert!(
            !guard.release(TopmostRelease::Timeout { generation: first }),
            "the first raise's timer must not release the second raise"
        );
        assert!(guard.is_armed());
        assert!(guard.release(TopmostRelease::Timeout { generation: second }));
    }

    #[test]
    fn re_arming_while_armed_keeps_a_single_pending_release() {
        let mut guard = TransientTopmost::default();
        guard.arm();
        let second = guard.arm();
        assert!(guard.release(TopmostRelease::Timeout { generation: second }));
        assert!(!guard.release(TopmostRelease::Blurred));
    }

    #[test]
    fn explicit_clear_disarms_so_later_events_do_nothing() {
        let mut guard = TransientTopmost::default();
        let generation = guard.arm();
        assert!(guard.release(TopmostRelease::Explicit));
        assert!(!guard.release(TopmostRelease::Timeout { generation }));
        assert!(!guard.release(TopmostRelease::Blurred));
    }

    #[test]
    fn timeout_bound_is_short() {
        // The flag may only ever outlive the raise by a few seconds; a longer
        // bound would reintroduce a window that Alt+Tab cannot get past.
        assert!(TRANSIENT_TOPMOST_TIMEOUT <= std::time::Duration::from_secs(5));
        assert!(TRANSIENT_TOPMOST_TIMEOUT >= std::time::Duration::from_millis(500));
    }
}
