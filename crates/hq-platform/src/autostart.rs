#[cfg(target_os = "macos")]
use std::path::PathBuf;

// Pure, platform-independent helpers (and the constants they need) are compiled
// on macOS and in any test build so their regression coverage runs on Linux CI
// too — the real filesystem/registry operations stay platform-gated below.
#[cfg(any(target_os = "macos", test))]
use std::path::Path;

#[cfg(any(target_os = "macos", test))]
use crate::launchagent::{CURRENT_BUNDLE_EXECUTABLE, LAUNCH_AGENT_LABEL};
/// Last-resort path, used only when the running executable can't be resolved.
/// It names the ACTUAL bundled binary (`hq-sync-menubar`) inside `HQ.app`, not
/// the product name `HQ` — the two differ, and assuming they were the same is
/// what pointed the LaunchAgent at a nonexistent `.../MacOS/HQ` and made
/// launchd exit EX_CONFIG.
#[cfg(any(target_os = "macos", test))]
const FALLBACK_APP_PATH: &str = CURRENT_BUNDLE_EXECUTABLE;

#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[cfg(target_os = "windows")]
const RUN_KEY_SUBPATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
const RUN_VALUE_NAME: &str = "HQSync";

/// Returns the path to ~/Library/LaunchAgents/{BUNDLE_ID}.plist.
#[cfg(target_os = "macos")]
fn plist_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", LAUNCH_AGENT_LABEL)))
}

/// The LaunchAgent must relaunch the exact binary that is running, so its
/// ProgramArguments path is the executable's own path taken verbatim. The file
/// name (e.g. `hq-sync-menubar`) must never be re-derived from the enclosing
/// `.app` bundle name (`HQ.app` → `HQ`): the bundle name and the binary name
/// differ for this app, and reconstructing it produced a path to a
/// nonexistent binary, so launchd exited EX_CONFIG and autosync never ran.
#[cfg(any(target_os = "macos", test))]
fn program_path_from_exe(exe: &Path) -> String {
    exe.to_string_lossy().to_string()
}

/// Resolve the LaunchAgent ProgramArguments path from the running executable.
/// Falls back to FALLBACK_APP_PATH only if the current exe can't be resolved.
#[cfg(target_os = "macos")]
fn resolve_app_path() -> String {
    match std::env::current_exe() {
        Ok(exe) => program_path_from_exe(&exe),
        Err(_) => FALLBACK_APP_PATH.to_string(),
    }
}

/// Extract the first `ProgramArguments` entry (or `Program`) from a LaunchAgent
/// plist. Returns None when the structure isn't present.
#[cfg(any(target_os = "macos", test))]
fn extract_program_path(plist: &str) -> Option<String> {
    crate::launchagent::registered_program_path(plist)
}

/// Generate the LaunchAgent plist XML content for the given app path.
#[cfg(any(target_os = "macos", test))]
fn generate_plist(app_path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#,
        LAUNCH_AGENT_LABEL, app_path
    )
}

/// Resolve the installed `HQ Sync.exe` path for the HKCU Run value.
#[cfg(target_os = "windows")]
fn resolve_app_path() -> String {
    if let Ok(exe) = std::env::current_exe() {
        return exe.to_string_lossy().to_string();
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(install_key) = hkcu.open_subkey("Software\\indigoai\\HQ Sync") {
        if let Ok(install_path) = install_key.get_value::<String, _>("InstallPath") {
            return install_path;
        }
    }
    let local_app = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Local"));
    format!("{}\\Programs\\HQ Sync\\HQ Sync.exe", local_app)
}

#[cfg(target_os = "windows")]
fn format_run_value(app_path: &str) -> String {
    format!("\"{}\"", app_path)
}

/// What launch-time autostart reconciliation should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Already in the desired state with a current path — do nothing.
    None,
    /// Register autostart (was off, should be on).
    Enable,
    /// Rewrite an existing registration that points at a stale executable path
    /// (the renamed-binary upgrade case that left autosync exiting EX_CONFIG).
    Refresh,
    /// Remove autostart (was on, explicit opt-out).
    Disable,
}

/// Pure decision for `ensure_autostart_on_launch`: given the desired state,
/// whether autostart is currently registered, and whether that registration
/// points at the current executable path, decide what to do. Both `Enable` and
/// `Refresh` are satisfied by writing a fresh registration (`set_enabled(true)`);
/// `Disable` by removing it. `path_is_current` is only meaningful when
/// `currently_enabled` is true (callers pass `true` otherwise).
pub fn reconcile_action(
    want_enabled: bool,
    currently_enabled: bool,
    path_is_current: bool,
) -> ReconcileAction {
    match (want_enabled, currently_enabled) {
        (true, false) => ReconcileAction::Enable,
        (true, true) if !path_is_current => ReconcileAction::Refresh,
        (true, true) => ReconcileAction::None,
        (false, true) => ReconcileAction::Disable,
        (false, false) => ReconcileAction::None,
    }
}

/// Whether an existing autostart registration points at the current executable.
///
/// Returns `Ok(false)` when autostart is not registered at all, or when it is
/// registered but points at a stale/renamed binary path — the exact upgrade
/// condition (`.../MacOS/HQ`) that this fix rewrites. `Ok(true)` only when the
/// registered path already matches the freshly-resolved executable path.
#[cfg(target_os = "macos")]
pub fn is_current() -> Result<bool, String> {
    let path = plist_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            Ok(extract_program_path(&content).as_deref() == Some(resolve_app_path().as_str()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("read LaunchAgent plist: {e}")),
    }
}

/// Windows counterpart of [`is_current`]: compare the stored HKCU Run value to
/// the freshly-resolved value.
#[cfg(target_os = "windows")]
pub fn is_current() -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match hkcu.open_subkey_with_flags(RUN_KEY_SUBPATH, KEY_READ) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("open HKCU Run key: {e}")),
    };
    match run_key.get_value::<String, _>(RUN_VALUE_NAME) {
        Ok(value) => Ok(value == format_run_value(&resolve_app_path())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("read Run/{RUN_VALUE_NAME}: {e}")),
    }
}

/// No autostart backend on other platforms — nothing can be stale.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn is_current() -> Result<bool, String> {
    Ok(true)
}

/// Check whether autostart is enabled.
pub fn is_enabled() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let path = plist_path()?;
        Ok(path.exists())
    }
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
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(false)
    }
}

/// Enable or disable autostart.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = plist_path()?;

        if enabled {
            // Ensure ~/Library/LaunchAgents/ exists
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create LaunchAgents directory: {}", e))?;
            }

            let app_path = resolve_app_path();
            let plist_content = generate_plist(&app_path);

            std::fs::write(&path, plist_content)
                .map_err(|e| format!("Failed to write LaunchAgent plist: {}", e))?;
        } else {
            // Remove the plist if it exists
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove LaunchAgent plist: {}", e))?;
            }
        }

        Ok(())
    }

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
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("delete Run/{RUN_VALUE_NAME}: {e}")),
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_plist_path_format() {
        let path = plist_path().unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("Library/LaunchAgents"));
        assert!(path_str.ends_with("ai.indigo.hq-sync-menubar.plist"));
    }

    #[test]
    fn test_generate_plist_content() {
        let plist = generate_plist("/Applications/HQ Sync.app/Contents/MacOS/HQ Sync");

        assert!(plist.contains("<?xml version=\"1.0\""));
        assert!(plist.contains("<!DOCTYPE plist"));
        assert!(plist.contains("<key>Label</key>"));
        assert!(plist.contains(&format!("<string>{}</string>", LAUNCH_AGENT_LABEL)));
        assert!(plist.contains("<key>ProgramArguments</key>"));
        assert!(plist.contains("<string>/Applications/HQ Sync.app/Contents/MacOS/HQ Sync</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
    }

    #[test]
    fn test_generate_plist_custom_path() {
        let custom = "/usr/local/bin/my-app";
        let plist = generate_plist(custom);
        assert!(plist.contains(&format!("<string>{}</string>", custom)));
    }

    #[test]
    fn test_resolve_app_path_uses_current_exe() {
        // resolve_app_path now returns the running executable's own path
        // verbatim (the value launchd needs to relaunch this exact binary),
        // rather than reconstructing a name from the .app bundle.
        let path = resolve_app_path();
        assert!(!path.is_empty());
        let exe = std::env::current_exe().unwrap();
        assert_eq!(path, exe.to_string_lossy());
    }

    #[test]
    fn test_plist_write_and_remove() {
        let tmp = TempDir::new().unwrap();
        let plist_file = tmp.path().join("ai.indigo.hq-sync-menubar.plist");

        // Write
        let content = generate_plist(FALLBACK_APP_PATH);
        std::fs::write(&plist_file, &content).unwrap();
        assert!(plist_file.exists());

        // Verify content
        let read_back = std::fs::read_to_string(&plist_file).unwrap();
        assert!(read_back.contains(LAUNCH_AGENT_LABEL));

        // Remove
        std::fs::remove_file(&plist_file).unwrap();
        assert!(!plist_file.exists());
    }

    #[test]
    fn test_plist_is_valid_xml() {
        let plist = generate_plist(FALLBACK_APP_PATH);
        // Basic XML validity checks
        assert!(plist.starts_with("<?xml"));
        assert!(plist.contains("<plist version=\"1.0\">"));
        assert!(plist.contains("</plist>"));
        assert!(plist.contains("<dict>"));
        assert!(plist.contains("</dict>"));
        assert!(plist.contains("<array>"));
        assert!(plist.contains("</array>"));
    }
}

/// Platform-independent regression coverage for the LaunchAgent path bug
/// (feedback_812a6727): the plist pointed at a nonexistent `.../MacOS/HQ` and
/// launchd exited EX_CONFIG. These run on every CI platform, including Linux.
#[cfg(test)]
mod pure_tests {
    use super::*;
    use std::path::Path;

    // The bundle folder (`HQ.app`) and the executable inside it
    // (`hq-sync-menubar`) have DIFFERENT names for this app.
    const REAL_EXE: &str = "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar";
    // The broken path older builds derived from the bundle name.
    const STALE_HQ_EXE: &str = "/Applications/HQ.app/Contents/MacOS/HQ";

    #[test]
    fn program_path_keeps_real_binary_name_not_bundle_name() {
        // Taken verbatim from the executable — must NOT collapse to `.../HQ`.
        let p = program_path_from_exe(Path::new(REAL_EXE));
        assert_eq!(p, REAL_EXE);
        assert!(
            !p.ends_with("/HQ"),
            "program path must not be re-derived from the .app bundle name"
        );
    }

    #[test]
    fn fallback_points_at_the_real_bundled_binary() {
        // The fallback itself must name the real binary, not the product name.
        assert_eq!(FALLBACK_APP_PATH, REAL_EXE);
    }

    #[test]
    fn extract_program_path_roundtrips_generated_plist() {
        let plist = generate_plist(REAL_EXE);
        assert_eq!(extract_program_path(&plist).as_deref(), Some(REAL_EXE));
    }

    #[test]
    fn extract_program_path_reads_stale_hq_path() {
        // A plist written by an older build points at the bad `.../HQ` path;
        // is_current compares this against the real binary and finds them
        // unequal, so the upgrade path rewrites it.
        let stale = generate_plist(STALE_HQ_EXE);
        assert_eq!(extract_program_path(&stale).as_deref(), Some(STALE_HQ_EXE));
        assert_ne!(extract_program_path(&stale).as_deref(), Some(REAL_EXE));
    }

    #[test]
    fn extract_program_path_none_on_garbage() {
        assert_eq!(extract_program_path("not a plist"), None);
    }

    #[test]
    fn reconcile_enables_when_off_but_wanted() {
        assert_eq!(reconcile_action(true, false, true), ReconcileAction::Enable);
    }

    #[test]
    fn reconcile_refreshes_stale_enabled_entry() {
        // The core upgrade fix: autostart is registered but the path is stale.
        assert_eq!(
            reconcile_action(true, true, false),
            ReconcileAction::Refresh
        );
    }

    #[test]
    fn reconcile_noop_when_enabled_and_current() {
        assert_eq!(reconcile_action(true, true, true), ReconcileAction::None);
    }

    #[test]
    fn reconcile_disables_on_explicit_optout() {
        assert_eq!(
            reconcile_action(false, true, true),
            ReconcileAction::Disable
        );
        // path currency is irrelevant when opting out.
        assert_eq!(
            reconcile_action(false, true, false),
            ReconcileAction::Disable
        );
    }

    #[test]
    fn reconcile_noop_when_off_and_unwanted() {
        assert_eq!(reconcile_action(false, false, true), ReconcileAction::None);
    }
}
