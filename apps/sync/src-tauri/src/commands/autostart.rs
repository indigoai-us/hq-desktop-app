use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;

/// Check whether autostart is enabled.
#[tauri::command]
pub async fn get_autostart_enabled() -> Result<bool, String> {
    hq_platform::autostart::is_enabled()
}

/// Enable or disable autostart.
#[tauri::command]
pub async fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    hq_platform::autostart::set_enabled(enabled)
}

/// Resolve the effective `startAtLogin` preference.
///
/// Defaults to `true` when menubar.json is absent or the field is missing —
/// matching the Settings UI default (`settings.rs`) and the `realtime_sync`
/// default-on convention in `daemon.rs`. Only an explicit
/// `"startAtLogin": false` opts out. Kept pure (takes parsed prefs) so the
/// default semantics are unit-testable without touching the real home dir.
fn effective_start_at_login(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.start_at_login).unwrap_or(true)
}

/// Read `startAtLogin` from ~/.hq/menubar.json (best-effort), applying the
/// default-on semantics of `effective_start_at_login`.
fn start_at_login_pref() -> bool {
    let path = match paths::menubar_json_path() {
        Ok(p) => p,
        Err(_) => return true,
    };
    let prefs: Option<MenubarPrefs> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    effective_start_at_login(prefs.as_ref())
}

/// Idempotent launch-time autostart reconciliation.
///
/// Called from `main.rs` `.setup()`. Ensures the LaunchAgent plist matches
/// the effective `startAtLogin` preference so a fresh install autostarts by
/// default without the user having to open Settings — while still honouring
/// an explicit `"startAtLogin": false` opt-out (in which case a stale plist
/// is removed). Best-effort: every IO error is logged and swallowed so a
/// failure here can never abort app launch.
pub fn ensure_autostart_on_launch() {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let want_enabled = start_at_login_pref();

        #[cfg(target_os = "macos")]
        let currently_enabled = match hq_platform::autostart::is_enabled() {
            Ok(enabled) => enabled,
            Err(e) => {
                log(
                    "autostart",
                    &format!("ensure: cannot read current autostart state: {e}"),
                );
                return;
            }
        };

        #[cfg(target_os = "windows")]
        let currently_enabled = match hq_platform::autostart::is_enabled() {
            Ok(enabled) => enabled,
            Err(e) => {
                log(
                    "autostart",
                    &format!("ensure: cannot read current autostart state: {e}"),
                );
                false
            }
        };

        if want_enabled != currently_enabled {
            match hq_platform::autostart::set_enabled(want_enabled) {
                Ok(()) => {
                    if want_enabled {
                        #[cfg(target_os = "macos")]
                        log(
                            "autostart",
                            "ensure: created LaunchAgent plist (default-on)",
                        );
                        #[cfg(target_os = "windows")]
                        log("autostart", "ensure: created Run value (default-on)");
                    } else {
                        #[cfg(target_os = "macos")]
                        log(
                            "autostart",
                            "ensure: removed LaunchAgent plist (explicit opt-out)",
                        );
                        #[cfg(target_os = "windows")]
                        log("autostart", "ensure: removed Run value (explicit opt-out)");
                    }
                }
                Err(e) => log("autostart", &format!("ensure: set autostart failed: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prefs_with_start(start: Option<bool>) -> MenubarPrefs {
        MenubarPrefs {
            hq_path: None,
            sync_on_launch: None,
            notifications: None,
            start_at_login: start,
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
        }
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_absent() {
        // No menubar.json at all -> autostart on by default.
        assert!(effective_start_at_login(None));
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_field_missing() {
        // menubar.json exists but startAtLogin not set -> default on.
        let p = prefs_with_start(None);
        assert!(effective_start_at_login(Some(&p)));
    }

    #[test]
    fn test_effective_start_at_login_explicit_true() {
        let p = prefs_with_start(Some(true));
        assert!(effective_start_at_login(Some(&p)));
    }

    #[test]
    fn test_effective_start_at_login_explicit_false_opts_out() {
        // The one case that disables autostart: explicit opt-out.
        let p = prefs_with_start(Some(false));
        assert!(!effective_start_at_login(Some(&p)));
    }
}
