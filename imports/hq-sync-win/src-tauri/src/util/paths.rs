//! HQ filesystem path helpers (Windows).
//!
//! Windows resolution order for child-process PATH and binary discovery:
//!   1. `%LOCALAPPDATA%\IndigoHQ\toolchain\bin`         (managed toolchain — installed by hq-installer-win)
//!   2. `%LOCALAPPDATA%\IndigoHQ\toolchain\node`        (node.exe + npx.cmd from the same install)
//!   3. `%LOCALAPPDATA%\Indigo HQ\toolchain\bin`         (legacy install dir — pre-installer-fix)
//!   4. `%LOCALAPPDATA%\Indigo HQ\toolchain\node`        (legacy install dir — pre-installer-fix)
//!   5. `%USERPROFILE%\.hq\bin`                          (user-side per-project overrides)
//!   6. `%LOCALAPPDATA%\Microsoft\WindowsApps`           (winget shim dir)
//!   7. `%USERPROFILE%\scoop\shims`                      (scoop shim dir)
//!   8. system PATH (`%PATH%`)
//!
//! The managed toolchain dir is the canonical Windows install location and
//! mirrors hq-installer-win's `managed_toolchain_dir_in()`. Putting it
//! first means `hq`/`node`/`npx` resolved by hq-installer-win always win
//! over whatever the user has on their system PATH — exactly what we want
//! for reproducibility.
//!
//! `IndigoHQ` (no space) is the canonical form — Windows path-with-space
//! quoting bugs in child shell invocations were the reason the installer
//! moved off `Indigo HQ`. The legacy spaced dir is still searched so that
//! users with pre-fix installs don't lose their managed toolchain until
//! they re-install.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Path-separator character on this platform. Windows uses `;`, POSIX uses `:`.
#[cfg(target_os = "windows")]
const PATH_SEP: char = ';';
#[cfg(not(target_os = "windows"))]
const PATH_SEP: char = ':';

/// Executable extension on this platform. Empty on POSIX; `.exe` on Windows.
#[cfg(target_os = "windows")]
const EXE_EXT: &str = ".exe";
#[cfg(not(target_os = "windows"))]
const EXE_EXT: &str = "";

/// Returns the canonical managed HQ toolchain directory installed by
/// hq-installer-win: `%LOCALAPPDATA%\IndigoHQ\toolchain\`. Mirrors
/// `managed_toolchain_dir()` in hq-installer-win's `deps.rs`.
#[cfg(target_os = "windows")]
fn managed_toolchain_dir() -> Option<PathBuf> {
    let local_app = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local_app).join("IndigoHQ").join("toolchain"))
}

/// Legacy managed toolchain dir from before the installer dropped the
/// space in `Indigo HQ`. Some existing dogfood installs still have their
/// toolchain here; we search it as a lower-priority fallback so those
/// users don't lose binary resolution between installer + sync upgrades.
/// Drop this once the dogfood cohort is confirmed migrated.
#[cfg(target_os = "windows")]
fn legacy_managed_toolchain_dir() -> Option<PathBuf> {
    let local_app = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local_app).join("Indigo HQ").join("toolchain"))
}

#[cfg(not(target_os = "windows"))]
fn managed_toolchain_dir() -> Option<PathBuf> {
    None
}

#[cfg(not(target_os = "windows"))]
fn legacy_managed_toolchain_dir() -> Option<PathBuf> {
    None
}

/// Resolve the user's home directory.
///
/// In production this is the OS home directory (`dirs::home_dir()` — on
/// Windows the `FOLDERID_Profile` known folder, on macOS/Linux `$HOME`).
///
/// An explicit `HOME` override takes precedence. On macOS/Linux this is a
/// no-op (`dirs::home_dir()` already reads `$HOME`), but on Windows it is the
/// only way to redirect the home directory: `dirs::home_dir()` resolves via
/// the Known Folder API and ignores environment variables, so tests (and any
/// caller that deliberately sets `HOME`) could not otherwise fake it. A native
/// Windows app launched normally has no `HOME` set, so production behavior is
/// unchanged.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    dirs::home_dir()
}

/// Returns the `~/.hq/` directory path.
/// On Windows this resolves to `%USERPROFILE%\.hq\` via [`home_dir`].
pub fn hq_config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home.join(".hq"))
}

/// Returns the path to `~/.hq/config.json`.
pub fn config_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("config.json"))
}

/// Returns the path to `~/.hq/menubar.json`.
pub fn menubar_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("menubar.json"))
}

/// Returns the path to `~/.hq/deploy-prefs.json`.
///
/// This file is owned exclusively by hq-core's `/deploy` skill — it persists
/// `defaultOrg` and `deploy.preference`. hq-sync only touches it during the
/// one-shot legacy stub migration (see
/// `commands::config::migrate_legacy_config_stub`).
pub fn deploy_prefs_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("deploy-prefs.json"))
}

/// Compute the ordered set of directories to prepend to a child process'
/// PATH. Splits the priorities documented at the top of this module into
/// a Vec so `child_path` can deduplicate against the parent PATH and so
/// `resolve_bin` can walk the same set.
fn extended_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(toolchain) = managed_toolchain_dir() {
        // bin and node first — hq + node + npx live under one of these.
        dirs.push(toolchain.join("bin"));
        dirs.push(toolchain.join("node"));
    }
    // Legacy `Indigo HQ\toolchain` for pre-fix installs. Lower priority
    // so a side-by-side install prefers the canonical no-space dir.
    if let Some(legacy) = legacy_managed_toolchain_dir() {
        dirs.push(legacy.join("bin"));
        dirs.push(legacy.join("node"));
    }

    if let Some(home) = home_dir() {
        dirs.push(home.join(".hq").join("bin"));
        // Scoop default install dir; harmless on systems without Scoop.
        dirs.push(home.join("scoop").join("shims"));
    }

    if cfg!(target_os = "windows") {
        if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
            // winget shim dir — `winget install <pkg>` typically drops a
            // .exe shim here that's on the user's PATH but doesn't show
            // in standard tool lists. Worth checking.
            dirs.push(
                PathBuf::from(local_app)
                    .join("Microsoft")
                    .join("WindowsApps"),
            );
        }
    }

    dirs
}

/// Resolve a node-backed CLI binary (e.g. `hq-sync-runner`, `hq`, `npx`)
/// to an absolute path.
///
/// Tries each `extended_search_dirs()` entry in order, looking for both
/// `{name}` and `{name}.exe`. Falls back to a `where.exe` lookup on
/// Windows (system PATH-aware) before returning the bare name.
///
/// Returns the bare name as the last-ditch fallback so the caller's
/// `Command::new` will then error with the original "os error 2", which
/// surfaces as a sync error the UI can show. We don't invent a path
/// that doesn't exist.
pub fn resolve_bin(name: &str) -> String {
    let candidates = candidate_filenames(name);

    for dir in extended_search_dirs() {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.exists() {
                return full.to_string_lossy().to_string();
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("where.exe").arg(name).output() {
            if output.status.success() {
                // where.exe prints every match newline-delimited;
                // take the first.
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = stdout.lines().next() {
                    let trimmed = first.trim();
                    if !trimmed.is_empty() && Path::new(trimmed).exists() {
                        return trimmed.to_string();
                    }
                }
            }
        }
    }

    name.to_string()
}

/// Compute the filename candidates for a binary lookup. On Windows we
/// try both `{name}` (already-extensioned, e.g. `npx.cmd`) and
/// `{name}.exe` (the common case). On POSIX we only try the bare name.
fn candidate_filenames(name: &str) -> Vec<String> {
    // On POSIX `EXE_EXT` is empty, so `ends_with(EXE_EXT)` is always true and
    // we return the bare name. On Windows we skip re-extensioning a name that
    // already carries an executable suffix.
    if name.ends_with(EXE_EXT) || name.ends_with(".cmd") || name.ends_with(".bat") {
        vec![name.to_string()]
    } else {
        vec![format!("{name}{EXE_EXT}"), name.to_string()]
    }
}

/// Build a PATH value suitable for handing to a spawned child process.
///
/// Prepends the extended search dirs (managed HQ toolchain, ~/.hq/bin,
/// scoop, winget shims) to the parent PATH so node-shebanged scripts +
/// nested `Command::new('node')` lookups resolve to the managed
/// toolchain first. Deduplicates so a dir that's already on the parent
/// PATH doesn't appear twice.
pub fn child_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for dir in extended_search_dirs() {
        let s = dir.to_string_lossy().to_string();
        if !s.is_empty() && seen.insert(s.to_lowercase()) {
            parts.push(s);
        }
    }

    // Append standard Windows system dirs as a safety net for builds where
    // %PATH% is unusually trimmed (some Tauri-launched contexts inherit
    // only the minimal SYSTEM env). Harmless duplication is prevented by
    // the `seen` dedup.
    if cfg!(target_os = "windows") {
        if let Ok(windir) = std::env::var("SystemRoot") {
            for sub in ["system32", "System32\\WindowsPowerShell\\v1.0", ""] {
                let candidate = if sub.is_empty() {
                    PathBuf::from(&windir)
                } else {
                    PathBuf::from(&windir).join(sub)
                };
                let s = candidate.to_string_lossy().to_string();
                if !s.is_empty() && seen.insert(s.to_lowercase()) {
                    parts.push(s);
                }
            }
        }
    }

    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(PATH_SEP) {
            if p.is_empty() {
                continue;
            }
            if seen.insert(p.to_lowercase()) {
                parts.push(p.to_string());
            }
        }
    }

    parts.join(&PATH_SEP.to_string())
}

/// Resolve the HQ folder path with priority:
/// 1. menubar_override (from menubar.json hqPath)
/// 2. config_path (from config.json hqFolderPath)
/// 3. Discovery: scan likely locations for a folder containing a valid
///    `core.yaml` (the canonical hq-core marker — version + hqVersion fields).
///    Both v14+ (`core/core.yaml`) and legacy (`core.yaml` at root) layouts
///    are accepted; see `is_valid_hq_root`. First match wins.
/// 4. `%USERPROFILE%\HQ` default
pub fn resolve_hq_folder(config_path: Option<&str>, menubar_override: Option<&str>) -> PathBuf {
    if let Some(path) = menubar_override {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    if let Some(path) = config_path {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    if let Some(found) = discover_hq_folder_via_core_yaml() {
        return found;
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("HQ")
}

fn hq_discovery_candidates() -> Vec<PathBuf> {
    let home = match home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    vec![
        home.join("HQ"),
        home.join("hq"),
        home.join("Documents").join("HQ"),
        home.join("Documents").join("hq"),
        home.join("Desktop").join("HQ"),
        home.join("Desktop").join("hq"),
    ]
}

/// True iff the candidate folder contains a `core.yaml` (canonical or
/// legacy location) that parses as YAML and has the canonical hq-core
/// schema fields (`version` + `hqVersion`).
pub fn is_valid_hq_root(path: &Path) -> bool {
    let canonical = path.join("core").join("core.yaml");
    let legacy = path.join("core.yaml");
    let core_yaml = if canonical.is_file() {
        canonical
    } else if legacy.is_file() {
        legacy
    } else {
        return false;
    };
    let bytes = match std::fs::read(&core_yaml) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let parsed: serde_yaml::Value = match serde_yaml::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    parsed.get("version").is_some() && parsed.get("hqVersion").is_some()
}

pub fn discover_hq_folder_via_core_yaml() -> Option<PathBuf> {
    hq_discovery_candidates()
        .into_iter()
        .find(|p| is_valid_hq_root(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hq_config_dir() {
        let dir = hq_config_dir().unwrap();
        assert!(dir.ends_with(".hq"));
    }

    #[test]
    fn test_config_json_path() {
        let path = config_json_path().unwrap();
        assert!(path.ends_with("config.json"));
        assert!(path.parent().unwrap().ends_with(".hq"));
    }

    #[test]
    fn test_menubar_json_path() {
        let path = menubar_json_path().unwrap();
        assert!(path.ends_with("menubar.json"));
    }

    #[test]
    fn test_resolve_menubar_override_wins() {
        let result = resolve_hq_folder(Some("C:\\from\\config"), Some("C:\\from\\menubar"));
        assert_eq!(result, PathBuf::from("C:\\from\\menubar"));
    }

    #[test]
    fn test_resolve_config_path() {
        let result = resolve_hq_folder(Some("C:\\from\\config"), None);
        assert_eq!(result, PathBuf::from("C:\\from\\config"));
    }

    #[test]
    fn test_resolve_default() {
        let result = resolve_hq_folder(None, None);
        assert!(result.ends_with("HQ"));
    }

    #[test]
    fn test_resolve_empty_menubar_falls_through() {
        let result = resolve_hq_folder(Some("C:\\from\\config"), Some(""));
        assert_eq!(result, PathBuf::from("C:\\from\\config"));
    }

    #[test]
    fn test_resolve_empty_both_falls_to_default() {
        let result = resolve_hq_folder(Some(""), Some(""));
        assert!(result.ends_with("HQ"));
    }

    #[test]
    fn test_resolve_bin_returns_name_when_not_resolved() {
        let result = resolve_bin("hq-sync-nonexistent-xyz-123");
        assert_eq!(result, "hq-sync-nonexistent-xyz-123");
    }

    #[test]
    fn test_candidate_filenames_appends_exe_on_windows() {
        let cands = candidate_filenames("hq");
        if cfg!(target_os = "windows") {
            assert!(cands.contains(&"hq.exe".to_string()));
            assert!(cands.contains(&"hq".to_string()));
        } else {
            assert_eq!(cands, vec!["hq".to_string()]);
        }
    }

    #[test]
    fn test_candidate_filenames_preserves_existing_extension() {
        // .cmd / .bat / .exe should NOT get .exe appended.
        let cands = candidate_filenames("npx.cmd");
        assert_eq!(cands, vec!["npx.cmd".to_string()]);
        let cands = candidate_filenames("hq.exe");
        assert_eq!(cands, vec!["hq.exe".to_string()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_child_path_includes_managed_toolchain_first() {
        // Override LOCALAPPDATA so the test is deterministic regardless
        // of the real %LOCALAPPDATA%.
        let prev = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", "C:\\TEST_LOCALAPPDATA");

        let path = child_path();

        // The managed toolchain bin dir must come before any system dir.
        let managed = "C:\\TEST_LOCALAPPDATA\\IndigoHQ\\toolchain\\bin";
        let managed_pos = path
            .to_lowercase()
            .find(&managed.to_lowercase())
            .expect("managed toolchain dir must be in child_path");
        let system32_pos = path
            .to_lowercase()
            .find("system32")
            .map(|p| p as i64)
            .unwrap_or(-1);
        if system32_pos >= 0 {
            assert!(
                (managed_pos as i64) < system32_pos,
                "managed toolchain ({managed_pos}) must come before system32 ({system32_pos})"
            );
        }

        // Restore.
        match prev {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
    }

    /// The canonical `IndigoHQ` (no space) dir must rank higher than the
    /// legacy `Indigo HQ` (with space) dir. A user who has both — e.g.
    /// upgraded across the installer rename — should resolve to the new
    /// canonical install first.
    #[cfg(target_os = "windows")]
    #[test]
    fn test_canonical_managed_toolchain_outranks_legacy() {
        let prev = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", "C:\\TEST_LOCALAPPDATA");

        let path = child_path().to_lowercase();
        let canonical = "c:\\test_localappdata\\indigohq\\toolchain\\bin";
        let legacy = "c:\\test_localappdata\\indigo hq\\toolchain\\bin";

        let canonical_pos = path
            .find(canonical)
            .expect("canonical IndigoHQ dir must be in child_path");
        let legacy_pos = path
            .find(legacy)
            .expect("legacy Indigo HQ dir must be in child_path");
        assert!(
            canonical_pos < legacy_pos,
            "canonical ({canonical_pos}) must outrank legacy ({legacy_pos})"
        );

        match prev {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
    }
}
