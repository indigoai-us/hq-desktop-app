//! Raise a Tauri webview above other apps after browser OAuth (macOS + Windows).
//!
//! Plain `WebviewWindow::set_focus()` is often a no-op once the system browser
//! holds activation/foreground. That leaves the installer / popover visible but
//! buried — and tray toggles then *hide* the already-visible window instead of
//! raising it.
//!
//! Platform strategies:
//! - **Windows:** Show/Restore, AttachThreadInput, brief TOPMOST pulse,
//!   SetForegroundWindow, then sticky `always_on_top` for the session.
//! - **macOS:** `NSApplication.activateIgnoringOtherApps` +
//!   `NSWindow.makeKeyAndOrderFront` / `orderFrontRegardless`.
//! - Other targets: show + set_focus.

use tauri::WebviewWindow;

/// Show `window` and pull it above other apps (best-effort on every OS).
pub fn bring_webview_to_front(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();

    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            force_foreground_hwnd(hwnd.0 as isize);
        }
        // Keep the raised surface above the browser for the rest of the
        // onboarding / popover session. Tray/popover paths already set this;
        // repeating it here is idempotent and covers first-run OAuth return.
        let _ = window.set_always_on_top(true);
    }

    #[cfg(target_os = "macos")]
    {
        force_foreground_macos(window);
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
    if hwnd == 0 {
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
        // Drop temporary TOPMOST; callers that need a sticky raise set
        // always_on_top via Tauri (see bring_webview_to_front).
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
