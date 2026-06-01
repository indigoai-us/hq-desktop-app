//! Windows autostart via the HKCU Registry Run key.
//!
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\HQSync` ->
//! the absolute path of `HQ Sync.exe`. When the user logs in, Windows
//! shell launches anything in that key. User-scoped, no admin/UAC.
//! User can audit + disable via Task Manager -> Startup tab.
//!
//! Mirrors the macOS LaunchAgents semantics:
//!   - Default-on (a freshly-installed app autostarts at next login)
//!   - Explicit opt-out via `"startAtLogin": false` in menubar.json
//!   - Idempotent — re-running with the same value is a no-op

use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;

#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
#[cfg(target_os = "windows")]
use winreg::RegKey;

/// Registry path (relative to HKCU) of the Run key.
#[cfg(target_os = "windows")]
const RUN_KEY_SUBPATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// Name of the value under the Run key. Tauri MSI/NSIS installers use
/// this same identifier on uninstall to clean up — keep stable.
#[cfg(target_os = "windows")]
const RUN_VALUE_NAME: &str = "HQSync";

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

/// Read `startAtLogin` from `~/.hq/menubar.json` (best-effort), applying
/// the default-on semantics of `effective_start_at_login`.
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

/// Resolve the installed `HQ Sync.exe` path. Try `std::env::current_exe()`
/// first (the running binary — correct after MSI/NSIS install) and fall
/// back to a HKCU-side install record the MSI writes at install time.
/// Final fallback is `%ProgramFiles%\HQ Sync\HQ Sync.exe` so a manually
/// extracted install still autostarts from a sensible default.
#[cfg(target_os = "windows")]
fn resolve_app_path() -> String {
    if let Ok(exe) = std::env::current_exe() {
        return exe.to_string_lossy().to_string();
    }
    // MSI/NSIS bundler writes installer-side metadata under
    // HKCU\Software\indigoai\HQ Sync (we configure this in US-009).
    // Look it up so a relocated install still resolves.
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(install_key) = hkcu.open_subkey("Software\\indigoai\\HQ Sync") {
        if let Ok(install_path) = install_key.get_value::<String, _>("InstallPath") {
            return install_path;
        }
    }
    // Last-ditch — matches the default NSIS currentUser install path
    // (per tauri.conf.json bundle.windows.nsis.installMode 'currentUser').
    let local_app = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Local"));
    format!("{}\\Programs\\HQ Sync\\HQ Sync.exe", local_app)
}

#[cfg(not(target_os = "windows"))]
fn resolve_app_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Format the Run-key value the OS shell expects. Quote the exe path
/// so paths with spaces (e.g. 'C:\Program Files\HQ Sync\HQ Sync.exe')
/// don't break shell-style arg splitting.
fn format_run_value(app_path: &str) -> String {
    format!("\"{}\"", app_path)
}

/// Check whether autostart is enabled by reading the Run-key value.
#[tauri::command]
pub async fn get_autostart_enabled() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run_key = hkcu
            .open_subkey_with_flags(RUN_KEY_SUBPATH, KEY_READ)
            .map_err(|e| format!("open HKCU Run key: {e}"))?;
        match run_key.get_value::<String, _>(RUN_VALUE_NAME) {
            Ok(value) => Ok(!value.trim().is_empty()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("read Run/{RUN_VALUE_NAME}: {e}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("autostart: only supported on Windows".to_string())
    }
}

/// Enable or disable autostart by creating or deleting the Run-key value.
/// Idempotent — set_autostart_enabled(true) when already enabled (with
/// the same path) is a no-op; set_autostart_enabled(false) when already
/// absent is a no-op.
#[tauri::command]
pub async fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if enabled {
            let (run_key, _disp) = hkcu
                .create_subkey(RUN_KEY_SUBPATH)
                .map_err(|e| format!("create HKCU Run key: {e}"))?;
            let value = format_run_value(&resolve_app_path());
            run_key
                .set_value(RUN_VALUE_NAME, &value)
                .map_err(|e| format!("write Run/{RUN_VALUE_NAME}: {e}"))?;
            Ok(())
        } else {
            let run_key = match hkcu.open_subkey_with_flags(RUN_KEY_SUBPATH, KEY_SET_VALUE) {
                Ok(k) => k,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(format!("open HKCU Run key for delete: {e}")),
            };
            match run_key.delete_value(RUN_VALUE_NAME) {
                Ok(()) => Ok(()),
                // Already absent — nothing to do.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("delete Run/{RUN_VALUE_NAME}: {e}")),
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("autostart: only supported on Windows".to_string())
    }
}

/// Idempotent launch-time autostart reconciliation. Called from `main.rs`
/// `.setup()`. Ensures the Run-key value matches the effective
/// `startAtLogin` preference so a fresh install autostarts by default
/// without the user having to open Settings — while still honouring an
/// explicit `"startAtLogin": false` opt-out (stale Run value removed).
///
/// Best-effort: every error logs and swallows so a failure here never
/// aborts app launch.
pub fn ensure_autostart_on_launch() {
    #[cfg(target_os = "windows")]
    {
        let want_enabled = start_at_login_pref();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // Read current state.
        let current: Option<String> = hkcu
            .open_subkey_with_flags(RUN_KEY_SUBPATH, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(RUN_VALUE_NAME).ok());
        let currently_set = current.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);

        if want_enabled && !currently_set {
            let value = format_run_value(&resolve_app_path());
            match hkcu.create_subkey(RUN_KEY_SUBPATH) {
                Ok((run_key, _)) => match run_key.set_value(RUN_VALUE_NAME, &value) {
                    Ok(()) => log(
                        "autostart",
                        &format!("ensure: created Run\\{RUN_VALUE_NAME}={value} (default-on)"),
                    ),
                    Err(e) => log("autostart", &format!("ensure: write Run value failed: {e}")),
                },
                Err(e) => log("autostart", &format!("ensure: open Run key failed: {e}")),
            }
        } else if !want_enabled && currently_set {
            if let Ok(run_key) = hkcu.open_subkey_with_flags(RUN_KEY_SUBPATH, KEY_SET_VALUE) {
                match run_key.delete_value(RUN_VALUE_NAME) {
                    Ok(()) => log(
                        "autostart",
                        &format!("ensure: removed Run\\{RUN_VALUE_NAME} (explicit opt-out)"),
                    ),
                    Err(e) => log("autostart", &format!("ensure: delete Run value failed: {e}")),
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // No-op on non-Windows; Tauri commands above already gate platform.
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
        }
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_absent() {
        assert!(effective_start_at_login(None));
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_field_missing() {
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
        let p = prefs_with_start(Some(false));
        assert!(!effective_start_at_login(Some(&p)));
    }

    #[test]
    fn test_format_run_value_quotes_path() {
        // Paths with spaces are the common case for %ProgramFiles% installs.
        let value = format_run_value("C:\\Program Files\\HQ Sync\\HQ Sync.exe");
        assert_eq!(value, "\"C:\\Program Files\\HQ Sync\\HQ Sync.exe\"");
    }

    #[test]
    fn test_format_run_value_handles_short_path() {
        let value = format_run_value("C:\\HQ Sync.exe");
        assert_eq!(value, "\"C:\\HQ Sync.exe\"");
    }

    /// Round-trip: set autostart, read it back, then disable it, then
    /// confirm get_autostart_enabled returns false. Idempotent — re-runs
    /// of either branch are no-ops.
    ///
    /// Marked Windows-only because the registry is the OS surface this
    /// touches. The test mutates HKCU\Software\Microsoft\Windows\
    /// CurrentVersion\Run\HQSync briefly — runs serial within the
    /// process (#[test]s run on isolated threads but the registry write
    /// is global). We always restore the original state in the cleanup
    /// step so the user's real autostart pref is preserved.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn test_set_and_get_autostart_roundtrip() {
        // Capture original state.
        let original = get_autostart_enabled().await.unwrap_or(false);

        // Disable, verify disabled.
        set_autostart_enabled(false).await.expect("disable should succeed");
        assert!(!get_autostart_enabled().await.unwrap_or(true));

        // Enable, verify enabled.
        set_autostart_enabled(true).await.expect("enable should succeed");
        assert!(get_autostart_enabled().await.unwrap_or(false));

        // Idempotent re-enable.
        set_autostart_enabled(true).await.expect("re-enable should be no-op");
        assert!(get_autostart_enabled().await.unwrap_or(false));

        // Disable, verify disabled. Idempotent re-disable.
        set_autostart_enabled(false).await.expect("disable should succeed");
        set_autostart_enabled(false).await.expect("re-disable should be no-op");
        assert!(!get_autostart_enabled().await.unwrap_or(true));

        // Restore original state.
        set_autostart_enabled(original).await.expect("restore");
    }
}
