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
        force_foreground_macos(window);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = keep_on_top;
    }

    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn force_foreground_macos(window: &WebviewWindow) {
    use objc2::{class, msg_send, runtime::AnyObject};

    // Must run on the AppKit main thread (callers use run_on_main_thread for
    // the OAuth callback path; tray click handlers are already on main).
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
