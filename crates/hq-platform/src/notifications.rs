//! OS-level notification permission primitives.
//!
//! The app already *fires* notifications, but it needs to report the real
//! OS-level authorization so UI state is honest. These helpers expose a stable
//! tri-state string contract:
//!
//!   * read the current permission status, and
//!   * request authorization when the OS supports prompting.
//!
//! ## macOS
//!
//! `tauri-plugin-notification` 2.3.3's desktop implementation hardcodes both
//! `permission_state()` and `request_permission()` to granted. Instead, query
//! `UNUserNotificationCenter` directly via `objc2` and map its
//! `authorizationStatus` to the app contract.
//!
//! `requestAuthorizationWithOptions:completionHandler:` shows the system dialog
//! only while the status is `notDetermined`; once granted or denied it returns
//! the existing status silently.
//!
//! `UNUserNotificationCenter.currentNotificationCenter()` requires a bundled
//! `.app`. Under local dev with a nil `bundleIdentifier`, it traps, so macOS
//! helpers return `"unknown"` when unbundled instead of crashing.

#[cfg(target_os = "windows")]
const NOTIFICATION_AUMID: &str = "ai.indigo.hq-sync-menubar";

/// Stable string contract for the frontend:
/// `"granted" | "denied" | "prompt" | "unknown"`.
///
/// `UNAuthorizationStatus` raw values (from `UserNotifications.framework`):
/// 0 = notDetermined, 1 = denied, 2 = authorized, 3 = provisional, 4 = ephemeral.
/// We treat provisional/ephemeral as effectively granted (notifications deliver),
/// notDetermined as `prompt` (a request would show the dialog), and any
/// unexpected value as `unknown` so the UI can stay neutral rather than lie.
fn auth_status_to_str(status: isize) -> &'static str {
    match status {
        2 | 3 | 4 => "granted",
        1 => "denied",
        0 => "prompt",
        _ => "unknown",
    }
}

/// Read the current OS notification authorization without prompting.
/// Returns `"granted" | "denied" | "prompt" | "unknown"`.
pub fn permission_state() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::read_authorization_status()
    }
    #[cfg(target_os = "windows")]
    {
        windows::permission_state()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

/// Request OS notification authorization. On macOS this shows the system dialog
/// only when the status is not yet determined; afterwards it silently returns
/// the existing status. Returns the freshly-read state
/// `"granted" | "denied" | "prompt" | "unknown"`.
pub fn request_permission() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::request_authorization();
        // Re-read the real status — more truthful than the request callback's
        // bool (which only reflects the just-made decision, not denials made
        // earlier in System Settings).
        macos::read_authorization_status()
    }
    #[cfg(target_os = "windows")]
    {
        windows::request_permission()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

/// Synchronous, side-effect-free read of the current notification authorization
/// status. Unlike `request_permission`, this never shows the system dialog.
pub fn permission_state_without_app() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::read_authorization_status()
    }
    #[cfg(target_os = "windows")]
    {
        windows::permission_state_without_app()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::NOTIFICATION_AUMID;
    use hq_desktop_core::logfile::log;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    fn read_permission_state() -> String {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let subkey = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{NOTIFICATION_AUMID}"
        );
        match hkcu.open_subkey(&subkey) {
            Ok(key) => match key.get_value::<u32, _>("Enabled") {
                Ok(0) => "denied".to_string(),
                Ok(_) => "granted".to_string(),
                Err(_) => "granted".to_string(),
            },
            Err(_) => "granted".to_string(),
        }
    }

    pub fn permission_state() -> String {
        read_permission_state()
    }

    pub fn permission_state_without_app() -> String {
        read_permission_state()
    }

    pub fn request_permission() -> String {
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.arg("ms-settings:notifications");
        hq_desktop_core::paths::no_window(&mut cmd);
        match cmd.spawn() {
            Ok(_) => log("notifications", "opened ms-settings:notifications"),
            Err(e) => log(
                "notifications",
                &format!("failed to open ms-settings:notifications: {e}"),
            ),
        }
        permission_state()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::auth_status_to_str;
    use block2::RcBlock;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use std::sync::mpsc;
    use std::time::Duration;

    /// `UNUserNotificationCenter.currentNotificationCenter()` traps when the
    /// main bundle has no `bundleIdentifier` (unbundled dev binary). Guard on it.
    fn is_bundled() -> bool {
        unsafe {
            let bundle_cls = class!(NSBundle);
            let main: *mut AnyObject = msg_send![bundle_cls, mainBundle];
            if main.is_null() {
                return false;
            }
            let ident: *mut AnyObject = msg_send![main, bundleIdentifier];
            !ident.is_null()
        }
    }

    /// Read `UNUserNotificationCenter` authorization status, mapped to our
    /// tri-state contract. Returns `"unknown"` when unbundled, when the center
    /// is unavailable, or when the async callback doesn't fire within 2s.
    pub fn read_authorization_status() -> String {
        if !is_bundled() {
            return "unknown".to_string();
        }
        let (tx, rx) = mpsc::channel::<isize>();
        unsafe {
            let center_cls = class!(UNUserNotificationCenter);
            let center: *mut AnyObject = msg_send![center_cls, currentNotificationCenter];
            if center.is_null() {
                return "unknown".to_string();
            }
            // RcBlock is heap-allocated + retained by the framework for the
            // duration of the async call, so a late callback (after our recv
            // timeout returns) can't use-after-free a stack block.
            let handler = RcBlock::new(move |settings: *mut AnyObject| {
                let status: isize = if settings.is_null() {
                    -1
                } else {
                    msg_send![settings, authorizationStatus]
                };
                let _ = tx.send(status);
            });
            let _: () = msg_send![center, getNotificationSettingsWithCompletionHandler: &*handler];
        }
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(status) => auth_status_to_str(status).to_string(),
            Err(_) => "unknown".to_string(),
        }
    }

    /// Request authorization (alert | badge | sound). Shows the system dialog
    /// only when status is `notDetermined`. Best-effort: returns once the
    /// callback fires or after a 2s timeout. The caller re-reads the real state.
    pub fn request_authorization() {
        if !is_bundled() {
            return;
        }
        // UNAuthorizationOptions: badge=1, sound=2, alert=4.
        const OPTIONS: usize = 1 | 2 | 4;
        let (tx, rx) = mpsc::channel::<bool>();
        unsafe {
            let center_cls = class!(UNUserNotificationCenter);
            let center: *mut AnyObject = msg_send![center_cls, currentNotificationCenter];
            if center.is_null() {
                return;
            }
            let handler = RcBlock::new(move |granted: Bool, _err: *mut AnyObject| {
                let _ = tx.send(granted.as_bool());
            });
            let _: () = msg_send![
                center,
                requestAuthorizationWithOptions: OPTIONS,
                completionHandler: &*handler
            ];
        }
        // Block until the user dismisses the dialog (or a generous timeout):
        // the dialog is modal-ish, so allow longer than the read path.
        let _ = rx.recv_timeout(Duration::from_secs(60));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::auth_status_to_str;

    #[test]
    fn maps_un_authorization_status_to_tristate() {
        // 0 notDetermined -> prompt
        assert_eq!(auth_status_to_str(0), "prompt");
        // 1 denied -> denied (the old hardcoded "granted" hid this case)
        assert_eq!(auth_status_to_str(1), "denied");
        // 2 authorized -> granted
        assert_eq!(auth_status_to_str(2), "granted");
        // 3 provisional, 4 ephemeral -> granted (notifications still deliver)
        assert_eq!(auth_status_to_str(3), "granted");
        assert_eq!(auth_status_to_str(4), "granted");
        // unexpected / sentinel -> unknown (UI stays neutral, never lies)
        assert_eq!(auth_status_to_str(-1), "unknown");
        assert_eq!(auth_status_to_str(99), "unknown");
    }
}
