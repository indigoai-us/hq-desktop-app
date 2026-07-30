//! Raise a Tauri webview above other apps after browser OAuth (macOS + Windows).
//!
//! Plain `WebviewWindow::set_focus()` is often a no-op once the system browser
//! holds activation/foreground. That leaves the installer / popover visible but
//! buried — and tray toggles then *hide* the already-visible window instead of
//! raising it.
//!
//! Platform strategies:
//! - **Windows:** Show/Restore, AttachThreadInput, brief TOPMOST pulse,
//!   SetForegroundWindow. Sticky `always_on_top` is reserved for the
//!   post-OAuth path only (see `bring_webview_to_front_after_oauth`) so
//!   first-run onboarding does not cover the system browser.
//! - **macOS:** `NSApplication.activateIgnoringOtherApps` +
//!   `NSWindow.makeKeyAndOrderFront` / `orderFrontRegardless`.
//! - Other targets: show + set_focus.

#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::WebviewWindow;

/// Show `window` and pull it above other apps (best-effort on every OS).
///
/// Does **not** leave the window sticky-topmost — first-run onboarding calls
/// this before OAuth, and a sticky raise would cover the provider login page.
pub fn bring_webview_to_front(window: &WebviewWindow) {
    raise_webview(window, /*keep_on_top=*/ false);
}

/// Raise after a successful OAuth callback and keep the window above the
/// browser for the rest of the onboarding / popover session (Windows).
pub fn bring_webview_to_front_after_oauth(window: &WebviewWindow) {
    raise_webview(window, /*keep_on_top=*/ true);
}

/// Clear sticky topmost before opening the system browser for OAuth so a
/// previously raised popover cannot intercept clicks on the provider page.
pub fn clear_sticky_topmost(window: &WebviewWindow) {
    let _ = window.set_always_on_top(false);
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
        // Drop temporary TOPMOST; sticky raise is applied separately via
        // `set_always_on_top` only on the post-OAuth path.
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
    #[test]
    fn module_compiles_on_all_targets() {
        // Smoke marker so the util stays in the test graph on every CI OS
        // where platform-specific bodies are cfg'd out.
        assert!(true);
    }
}
