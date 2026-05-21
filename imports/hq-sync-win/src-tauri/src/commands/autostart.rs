//! Windows autostart wiring.
//!
//! US-002 stripped the macOS LaunchAgents implementation. US-006 fills in
//! the Windows replacement: a Run-key entry under
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\HQSync` via the
//! `winreg` crate.
//!
//! For now this file exports stub `get_autostart_enabled` /
//! `set_autostart_enabled` / `ensure_autostart_on_launch` so the Tauri
//! `invoke_handler` registration in `main.rs` keeps compiling. The pure
//! `effective_start_at_login` helper is preserved (it just reads JSON, no
//! platform dependency).

use crate::commands::config::MenubarPrefs;

/// Resolve the effective `startAtLogin` preference.
///
/// Defaults to `true` when menubar.json is absent or the field is missing —
/// matching the Settings UI default (`settings.rs`) and the `realtime_sync`
/// default-on convention in `daemon.rs`. Only an explicit
/// `"startAtLogin": false` opts out. Kept pure (takes parsed prefs) so the
/// default semantics are unit-testable without touching the real home dir.
pub fn effective_start_at_login(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.start_at_login).unwrap_or(true)
}

/// Check whether autostart is enabled. US-006 implements via Registry Run key.
#[tauri::command]
pub async fn get_autostart_enabled() -> Result<bool, String> {
    Err("autostart: not implemented yet (US-006 wires Registry Run key)".to_string())
}

/// Enable or disable autostart. US-006 implements via Registry Run key.
#[tauri::command]
pub async fn set_autostart_enabled(_enabled: bool) -> Result<(), String> {
    Err("autostart: not implemented yet (US-006 wires Registry Run key)".to_string())
}

/// Idempotent launch-time autostart reconciliation. US-006 implements.
///
/// Best-effort: every error is logged and swallowed so a failure here can
/// never abort app launch.
pub fn ensure_autostart_on_launch() {
    // No-op stub until US-006 lands the Registry implementation.
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
