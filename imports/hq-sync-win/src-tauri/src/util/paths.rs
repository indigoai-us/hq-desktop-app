//! HQ filesystem path helpers.
//!
//! ## US-002 state
//!
//! Stripped: Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) candidates,
//! `~/Library/Application Support/Indigo HQ/toolchain/` managed toolchain
//! dir, the `zsh -lc command -v` login-shell fallback. US-008 wires the
//! Windows equivalents: `%LOCALAPPDATA%\Indigo HQ\toolchain\bin`,
//! `%LOCALAPPDATA%\Microsoft\WindowsApps` (winget shim dir), Scoop shim
//! dir, and PowerShell-based PATH lookup. Cross-platform helpers
//! (`hq_config_dir`, `menubar_json_path`, `resolve_hq_folder`, etc.) stay
//! as-is — `dirs::home_dir()` returns the right value on both platforms.

use std::path::{Path, PathBuf};

/// Returns the ~/.hq/ directory path.
///
/// On Windows this resolves to `%USERPROFILE%\.hq\` via `dirs::home_dir()`.
pub fn hq_config_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home.join(".hq"))
}

/// Resolve a node-backed CLI binary (e.g. `hq-sync-runner`, `hq`) to an
/// absolute path.
///
/// US-008 wires the Windows resolution order:
///   1. `%LOCALAPPDATA%\Indigo HQ\toolchain\bin\{name}.exe`
///   2. `%USERPROFILE%\.hq\bin\{name}.exe`
///   3. winget shim dir `%LOCALAPPDATA%\Microsoft\WindowsApps\{name}.exe`
///   4. Scoop shim dir `%USERPROFILE%\scoop\shims\{name}.exe`
///   5. `where.exe {name}` fallback
///
/// Until US-008 lands this returns the bare name unchanged — `Command::new`
/// then does its own PATH lookup, which is correct for `node`/`npx` if they
/// happen to be on the system PATH already.
pub fn resolve_bin(name: &str) -> String {
    name.to_string()
}

/// Build a PATH value suitable for handing to a spawned child process.
///
/// US-008 wires a Windows-appropriate PATH (semicolon-delimited) that
/// prepends the managed HQ toolchain, winget shims, and Scoop shims.
/// Until then we forward the parent process PATH verbatim — Tauri apps
/// launched via Start menu / Explorer inherit the user's PATH by default
/// on Windows, so this works for typical dev setups.
pub fn child_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Returns the path to ~/.hq/config.json.
pub fn config_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("config.json"))
}

/// Returns the path to ~/.hq/menubar.json.
pub fn menubar_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("menubar.json"))
}

/// Returns the path to ~/.hq/deploy-prefs.json.
///
/// This file is owned exclusively by hq-core's `/deploy` skill — it persists
/// `defaultOrg` and `deploy.preference`. hq-sync only touches it during the
/// one-shot legacy stub migration (see
/// `commands::config::migrate_legacy_config_stub`).
pub fn deploy_prefs_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("deploy-prefs.json"))
}

/// Resolve the HQ folder path with priority:
/// 1. menubar_override (from menubar.json hqPath)
/// 2. config_path (from config.json hqFolderPath)
/// 3. Discovery: scan likely locations for a folder containing a valid
///    `core.yaml` (the canonical hq-core marker — version + hqVersion fields).
///    Both v14+ (`core/core.yaml`) and legacy (`core.yaml` at root) layouts
///    are accepted; see `is_valid_hq_root`. First match wins. This is the
///    safety net for installs that didn't write the path back to menubar.json
///    (older installer flows).
/// 4. ~/HQ default
pub fn resolve_hq_folder(
    config_path: Option<&str>,
    menubar_override: Option<&str>,
) -> PathBuf {
    // Priority 1: menubar.json override
    if let Some(path) = menubar_override {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    // Priority 2: config.json hqFolderPath
    if let Some(path) = config_path {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    // Priority 3: discover via core.yaml signature.
    if let Some(found) = discover_hq_folder_via_core_yaml() {
        return found;
    }

    // Priority 4: ~/HQ default
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("HQ")
}

/// Candidate parent paths the installer wizard typically uses (or that users
/// commonly choose). First entry that contains a valid `core.yaml` wins.
/// Order matters — most-likely first to avoid scanning the entire home dir.
fn hq_discovery_candidates() -> Vec<PathBuf> {
    let home = match dirs::home_dir() {
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
/// schema fields (`version` + `hqVersion`). Validates beyond mere presence
/// so a random folder named `core.yaml` (config file from another tool,
/// abandoned scratch) won't false-match.
///
/// File location is layout-aware:
///   * **canonical (v14+):** `<path>/core/core.yaml`
///   * **legacy (pre-v14):** `<path>/core.yaml`
///
/// The v14 hq-core release moved `core.yaml` one level deeper (see
/// `apps/hq-core/MIGRATION.md` — "Root core.yaml; canonical location is
/// core/core.yaml"). Before that fix, Priority 3 discovery silently
/// rejected every v14+ HQ folder and fell through to the `~/HQ` default.
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
    // Both fields must be present per the hq-core schema (see
    // indigoai-us/hq-core core/core.yaml). `version` is the schema version,
    // `hqVersion` is the template version. Random YAML files won't have both.
    parsed.get("version").is_some() && parsed.get("hqVersion").is_some()
}

/// Scan the well-known candidate locations for an HQ folder. Returns the
/// first valid root found, or None. Cheap — a few `stat` calls plus one
/// small YAML parse on a hit; no fs walk.
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
        let result = resolve_hq_folder(
            Some("C:\\from\\config"),
            Some("C:\\from\\menubar"),
        );
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
        // US-008 fills in Windows resolution. Stub returns bare name.
        let result = resolve_bin("hq-sync-nonexistent-xyz-123");
        assert_eq!(result, "hq-sync-nonexistent-xyz-123");
    }
}
