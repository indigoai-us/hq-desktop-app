//! macOS Dock icon presence.
//!
//! HQ ships with a Dock icon by default. The bundle stays `LSUIElement=true`
//! (see `Info.plist`) so the process still *launches* as an accessory — that
//! keeps the login-item start silent and means a user who has opted out never
//! sees a Dock icon flash before we demote the policy. The effective posture is
//! then decided at runtime from the `dockIcon` preference:
//!
//!   * `dockIcon: true` (default, absent → true) → `ActivationPolicy::Regular`.
//!     Dock icon, Cmd-Tab entry, standard app menu bar. Promoting an
//!     `LSUIElement` process with `-[NSApplication setActivationPolicy:]` is
//!     the supported way to do this; it's the same technique every menubar app
//!     with a "Show in Dock" preference uses.
//!   * `dockIcon: false` → `ActivationPolicy::Accessory`. The classic
//!     menubar-only posture this app shipped with: the tray icon is the only
//!     surface.
//!
//! The Dock icon *image* is already registered at launch — `main.rs` calls
//! `set_app_icon_from_bytes` with the bundled HQ mark, so the Dock renders the
//! HQ glyph rather than a generic bundle icon.
//!
//! ## Why the widget is unaffected
//!
//! `commands/widget.rs` documents its non-activating behaviour as
//! `.focusable(false)` *paired with* `ActivationPolicy::Accessory`. The load
//! bearing half is `.focusable(false)`: it makes the NSWindow refuse key
//! status, so hover/clicks on the floating wordmark cannot steal focus no
//! matter which activation policy the app runs under. Regular policy therefore
//! does not regress the widget.
//!
//! ## Prefs
//!
//! Typed as `MenubarPrefs::dock_icon` so the Settings toggle round-trips
//! through `get_settings` / `save_settings` without being wiped, and read
//! straight off disk here so the toggle takes effect without a restart —
//! mirroring `autostart::start_at_login_pref`.

use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "dock";

/// Resolve the effective `dockIcon` preference.
///
/// Default-ON: `None` prefs (no menubar.json at all) and a missing `dockIcon`
/// key both mean "show the Dock icon", so upgrading installs pick the icon up
/// without touching Settings. Only an explicit `false` opts out.
///
/// Kept pure (takes parsed prefs) so the default contract is unit testable on
/// any platform, without a Tauri runtime or a real `~/.hq/menubar.json`.
pub fn effective_dock_icon(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.dock_icon).unwrap_or(true)
}

/// Read `dockIcon` from ~/.hq/menubar.json (best-effort), applying the
/// default-on semantics of [`effective_dock_icon`].
///
/// Any failure to locate, read, or parse the file resolves to the default
/// (icon shown) rather than silently demoting the app to accessory — a
/// corrupt prefs file must not make HQ disappear from the Dock. The read
/// failure is logged so the Connect diagnostics surface still shows it.
pub fn dock_icon_pref() -> bool {
    effective_dock_icon(read_prefs().as_ref())
}

/// Best-effort parse of ~/.hq/menubar.json.
///
/// `None` covers both "no preferences yet" (fresh install — the default
/// applies) and "preferences unreadable". The unreadable cases are logged
/// rather than swallowed, so a corrupt prefs file shows up in the diagnostic
/// log instead of silently presenting as a never-configured install.
fn read_prefs() -> Option<MenubarPrefs> {
    let path = match paths::menubar_json_path() {
        Ok(path) => path,
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json path unresolved: {e}"));
            return None;
        }
    };
    if !path.exists() {
        return None;
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json read failed: {e}"));
            return None;
        }
    };
    match serde_json::from_str::<MenubarPrefs>(&contents) {
        Ok(prefs) => Some(prefs),
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json parse failed: {e}"));
            None
        }
    }
}

/// Apply the stored `dockIcon` preference to the running app.
///
/// Called once from `main.rs` `.setup()` and again by the Settings toggle
/// (after `save_settings` persists the new value) so flipping the switch takes
/// effect immediately instead of at next launch.
///
/// No manual main-thread hop: unlike the NSWindow work in
/// `apply_widget_settings`, `AppHandle::set_activation_policy` posts a
/// `Message::SetActivationPolicy` through the wry runtime, which is handled on
/// the event-loop (main) thread — inline when the caller already is the main
/// thread. Errors are returned so the Settings UI can surface a failed apply
/// (disk is already authoritative at that point).
#[tauri::command]
pub async fn apply_dock_icon(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        set_activation_policy(&app, dock_icon_pref())
    }

    // Windows/Linux have no activation policy; the taskbar entry is owned by
    // the window manager. Accept the call so the shared Settings surface can
    // stay platform-agnostic.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Set the app's activation policy from a resolved preference.
///
/// Split out from the command so the launch path (`main.rs` `.setup()`) and the
/// toggle path share one implementation and one log line.
#[cfg(target_os = "macos")]
pub fn set_activation_policy(app: &tauri::AppHandle, show_dock_icon: bool) -> Result<(), String> {
    let policy = if show_dock_icon {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    app.set_activation_policy(policy)
        .map_err(|e| format!("set_activation_policy failed: {e}"))?;

    log(
        LOG_TAG,
        if show_dock_icon {
            "activation policy = Regular (Dock icon shown)"
        } else {
            "activation policy = Accessory (Dock icon hidden)"
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs_with_dock(dock_icon: Option<bool>) -> MenubarPrefs {
        MenubarPrefs {
            hq_path: None,
            sync_on_launch: None,
            notifications: None,
            start_at_login: None,
            autostart_daemon: None,
            realtime_sync: None,
            personal_sync_enabled: None,
            instant_sync: None,
            drift_staging_repo: None,
            share_notifications: None,
            dm_notifications: None,
            cli_auto_update: None,
            auto_update: None,
            staging_channel: None,
            release_channel: None,
            meeting_detect_notify: None,
            default_recording_company_uid: None,
            telemetry_enabled: None,
            widget_enabled: None,
            widget_display: None,
            dock_icon,
        }
    }

    #[test]
    fn test_effective_dock_icon_defaults_on_when_no_prefs() {
        // No menubar.json at all (fresh install) -> Dock icon shown.
        assert!(effective_dock_icon(None));
    }

    #[test]
    fn test_effective_dock_icon_defaults_on_when_field_missing() {
        // menubar.json exists but predates the pref -> Dock icon shown, so
        // upgrading installs gain the icon without touching Settings.
        assert!(effective_dock_icon(Some(&prefs_with_dock(None))));
    }

    #[test]
    fn test_effective_dock_icon_explicit_true() {
        assert!(effective_dock_icon(Some(&prefs_with_dock(Some(true)))));
    }

    #[test]
    fn test_effective_dock_icon_explicit_false_opts_out() {
        // The ONLY way back to the menubar-only accessory posture.
        assert!(!effective_dock_icon(Some(&prefs_with_dock(Some(false)))));
    }

    #[test]
    fn test_dock_icon_absent_from_serialized_prefs_when_none() {
        // `skip_serializing_if` keeps the key out of menubar.json until the
        // user actually touches the toggle, so "never chosen" stays
        // distinguishable from "explicitly enabled" on disk.
        let json = serde_json::to_string(&prefs_with_dock(None)).expect("serialize");
        assert!(!json.contains("dockIcon"), "unexpected key in {json}");
    }

    #[test]
    fn test_dock_icon_round_trips_as_camel_case() {
        let json = serde_json::to_string(&prefs_with_dock(Some(false))).expect("serialize");
        assert!(
            json.contains("\"dockIcon\":false"),
            "unexpected shape: {json}"
        );

        let parsed: MenubarPrefs = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.dock_icon, Some(false));
        assert!(!effective_dock_icon(Some(&parsed)));
    }
}
