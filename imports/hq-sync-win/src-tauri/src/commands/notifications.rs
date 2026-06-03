//! Notification-permission surface for HQ Sync.
//!
//! The app fires toast notifications (share events in `share_notify.rs` —
//! `tauri-plugin-notification` / WinRT on Windows, `mac-notification-sys` on
//! macOS). These two commands let the frontend inspect and act on the OS-level
//! notification state so the Settings monitor pill reflects reality instead of
//! a hardcoded "granted".
//!
//! We wrap the platform logic in our own commands rather than exposing the
//! plugin's IPC permissions to the webview — keeps the capability grant minimal
//! and gives the frontend a stable tri-state string contract
//! (`"granted" | "denied" | "prompt"`) independent of the plugin's serde repr.
//!
//! ## Platform behaviour
//!
//! * **macOS** — `request_permission()` maps to `UNUserNotificationCenter`
//!   authorization: the system dialog shows only while the status is *not
//!   determined* (`prompt`); afterwards it silently returns the existing
//!   status, so the frontend can call it on every launch without re-nagging.
//!   State is read through `tauri-plugin-notification`.
//!
//! * **Windows** — there is no per-app runtime permission *prompt*; toasts are
//!   enabled by default and the user turns them off in
//!   Settings → System → Notifications. We therefore report the REAL state by
//!   reading the same registry value that the Settings toggle writes
//!   (`…\Notifications\Settings\<AUMID>\Enabled`), and `request_permission`
//!   deep-links to `ms-settings:notifications` rather than showing a dialog
//!   that doesn't exist. This fixes the "hardcoded granted" problem
//!   (`tauri-plugin-notification::permission_state()` returns `Granted`
//!   unconditionally on desktop).

use tauri::AppHandle;

/// AppUserModelID under which Windows tracks this app's toast settings. Matches
/// the bundle `identifier` in `tauri.conf.json`; Tauri registers toasts under
/// it, and Settings → Notifications writes the per-app `Enabled` DWORD beneath
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AUMID>`.
#[cfg(target_os = "windows")]
const NOTIFICATION_AUMID: &str = "ai.indigo.hq-sync-win";

/// Read the current OS notification authorization without prompting.
/// Returns `"granted" | "denied" | "prompt"`.
#[tauri::command]
pub async fn notification_permission_state(app: AppHandle) -> Result<String, String> {
    platform::permission_state(&app)
}

/// Request OS notification authorization. macOS shows the system dialog only
/// when the status is not yet determined; Windows has no such dialog, so this
/// opens the Notifications page in Settings. Returns the resulting tri-state.
#[tauri::command]
pub async fn notification_request_permission(app: AppHandle) -> Result<String, String> {
    platform::request_permission(&app)
}

// ── Windows ───────────────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::NOTIFICATION_AUMID;
    use crate::util::logfile::log;
    use tauri::AppHandle;

    /// Reads `…\Notifications\Settings\<AUMID>\Enabled`. The value is written by
    /// Settings → System → Notifications when the user toggles this app off/on.
    ///
    /// * `Enabled == 0` → user disabled toasts → `"denied"`.
    /// * `Enabled == 1` → explicitly enabled → `"granted"`.
    /// * key/value absent → never toggled → notifications are on by default on
    ///   Windows, so `"granted"`. (The subkey only materializes after the first
    ///   toast or an explicit toggle.)
    pub fn permission_state(_app: &AppHandle) -> Result<String, String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let subkey = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{NOTIFICATION_AUMID}"
        );
        match hkcu.open_subkey(&subkey) {
            Ok(key) => match key.get_value::<u32, _>("Enabled") {
                Ok(0) => Ok("denied".to_string()),
                Ok(_) => Ok("granted".to_string()),
                // Subkey exists but no Enabled value — default-on.
                Err(_) => Ok("granted".to_string()),
            },
            // Subkey absent — app has never been toggled; default-on.
            Err(_) => Ok("granted".to_string()),
        }
    }

    /// No runtime permission dialog exists on Windows — deep-link to the
    /// Notifications settings page so the user can flip the per-app toggle,
    /// then report the (current) state. `explorer.exe` resolves `ms-settings:`
    /// URIs.
    pub fn request_permission(app: &AppHandle) -> Result<String, String> {
        match std::process::Command::new("explorer.exe")
            .arg("ms-settings:notifications")
            .spawn()
        {
            Ok(_) => log("notifications", "opened ms-settings:notifications"),
            Err(e) => log(
                "notifications",
                &format!("failed to open ms-settings:notifications: {e}"),
            ),
        }
        permission_state(app)
    }
}

// ── macOS / other ─────────────────────────────────────────────────────────────
#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;
    use tauri_plugin_notification::{NotificationExt, PermissionState};

    /// Stable tri-state contract for the frontend. `prompt` collapses both
    /// `Prompt` and the Android-only `PromptWithRationale`.
    fn state_to_str(state: PermissionState) -> &'static str {
        match state {
            PermissionState::Granted => "granted",
            PermissionState::Denied => "denied",
            _ => "prompt",
        }
    }

    pub fn permission_state(app: &AppHandle) -> Result<String, String> {
        let state = app
            .notification()
            .permission_state()
            .map_err(|e| format!("Failed to read notification permission: {e}"))?;
        Ok(state_to_str(state).to_string())
    }

    pub fn request_permission(app: &AppHandle) -> Result<String, String> {
        let state = app
            .notification()
            .request_permission()
            .map_err(|e| format!("Failed to request notification permission: {e}"))?;
        Ok(state_to_str(state).to_string())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    //! The registry read is exercised against the live HKCU hive in
    //! integration/e2e; here we just assert the absent-key default path: an
    //! AUMID that cannot exist must fail to open (our code maps that → granted).
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    #[test]
    fn absent_aumid_subkey_errors() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let bogus = "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\ai.indigo.hq-sync-win.__definitely_absent__";
        assert!(hkcu.open_subkey(bogus).is_err());
    }
}
