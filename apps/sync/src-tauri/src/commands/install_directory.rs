use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

fn home_base() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        dirs::home_dir()
    }
}

/// Expand a leading `~/` or bare `~` into `$HOME`. Falls back to the literal
/// string if `$HOME` is not set, which on macOS effectively never happens.
fn expand_tilde(s: &str) -> PathBuf {
    if s == "~" {
        if let Some(home) = home_base() {
            return home;
        }
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = home_base() {
            return home.join(rest);
        }
    }
    PathBuf::from(s)
}

#[derive(Serialize)]
pub struct DetectHqResult {
    pub exists: bool,
    #[serde(rename = "isHq")]
    pub is_hq: bool,
    /// True when the path exists, is a directory, and already contains at
    /// least one entry. The onboarding Directory screen uses this (together
    /// with `is_hq`) to warn before installing on top of a non-empty folder
    /// that isn't already an HQ. Absent-or-false for missing paths.
    #[serde(rename = "nonEmpty")]
    pub non_empty: bool,
}

#[derive(Serialize, Debug)]
pub struct CreateDirectoryResult {
    /// Absolute path of the resulting directory (parent + name joined).
    pub path: String,
    /// True when the directory existed prior to this call. False when this
    /// call created it. Lets the frontend decide whether to surface a
    /// "directory already exists" state vs. a fresh creation.
    pub already_existed: bool,
    /// True when the directory was non-empty at the moment of creation.
    /// Frontend uses this to warn before installing on top of arbitrary files.
    pub non_empty: bool,
}

/// Create `{parent}/{name}` if missing and report what was found.
///
/// Mirrors the safety checks in `detect_hq`: callers can chain
/// `create_directory` → `detect_hq` to learn whether the resulting path is
/// fresh, an existing HQ, or a non-empty foreign directory.
#[tauri::command]
pub fn create_directory(parent: String, name: String) -> Result<CreateDirectoryResult, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("Folder name cannot contain path separators".to_string());
    }

    let parent_path = expand_tilde(&parent);
    if !parent_path.exists() {
        return Err(format!(
            "Parent directory does not exist: {}",
            parent_path.display()
        ));
    }

    let target = parent_path.join(trimmed_name);
    let already_existed = target.exists();
    if already_existed && !target.is_dir() {
        return Err(format!(
            "{} exists but is a file, not a folder",
            target.display()
        ));
    }
    if !already_existed {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create {}: {}", target.display(), e))?;
    }

    let non_empty = if target.is_dir() {
        match std::fs::read_dir(&target) {
            Ok(mut entries) => entries.next().is_some(),
            Err(_) => false,
        }
    } else {
        false
    };

    Ok(CreateDirectoryResult {
        path: target.to_string_lossy().into_owned(),
        already_existed,
        non_empty,
    })
}

/// Read the user's chosen HQ install path from `~/.hq/menubar.json` (`hqPath`),
/// if one was persisted during onboarding. Returns `None` when unset/empty or
/// the file can't be read, so callers fall back to the `~/hq` default.
fn persisted_install_path() -> Option<PathBuf> {
    let menubar_path = crate::util::paths::menubar_json_path().ok()?;
    let obj = hq_desktop_core::first_run::read_menubar_obj(&menubar_path);
    obj.get("hqPath")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| expand_tilde(s))
}

/// Resolve the HQ install directory, create it if absent, and return its
/// absolute path.
///
/// Honors the folder the user chose on the Directory screen (persisted to
/// `menubar.json` `hqPath` via [`set_hq_install_path`]); falls back to `~/hq`
/// when nothing has been chosen yet. Every onboarding setup stage (template
/// extraction, git init, personalize, sync) resolves through here, so the
/// chosen location is honored everywhere rather than silently defaulting to
/// `~/hq`.
#[tauri::command]
pub fn resolve_hq_path() -> Result<String, String> {
    let hq_path = persisted_install_path().unwrap_or_else(|| expand_tilde("~/hq"));
    if hq_path.exists() && !hq_path.is_dir() {
        return Err(format!(
            "{} exists but is a file, not a folder",
            hq_path.display()
        ));
    }
    if !hq_path.exists() {
        std::fs::create_dir_all(&hq_path)
            .map_err(|e| format!("Failed to create {}: {e}", hq_path.display()))?;
    }
    // Canonicalize to get an absolute, symlink-resolved path.
    // Fall back to the unresolved path if canonicalize fails (e.g. race).
    let canonical = hq_path.canonicalize().unwrap_or_else(|_| hq_path.clone());
    Ok(canonical.to_string_lossy().into_owned())
}

/// Persist the user's chosen HQ install directory to `~/.hq/menubar.json`
/// (`hqPath`) so the setup stages — and the long-lived sync agent — all target
/// the same folder. Called from the Directory screen whenever a path is
/// accepted (default or custom). Idempotent; safe to call repeatedly.
#[tauri::command]
pub fn set_hq_install_path(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Install path cannot be empty".to_string());
    }
    let expanded = expand_tilde(trimmed);
    let menubar_path = crate::util::paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &menubar_path,
        &[(
            "hqPath",
            serde_json::Value::String(expanded.to_string_lossy().into_owned()),
        )],
    )
}

#[tauri::command]
pub fn check_writable(path: String) -> Result<bool, String> {
    let dir = expand_tilde(&path);
    if dir.exists() && !dir.is_dir() {
        return Ok(false);
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return Ok(false);
    }

    let probe = dir.join(format!(
        ".hq-desktop-write-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    match std::fs::File::create(&probe).and_then(|mut f| f.write_all(b"ok")) {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(true)
        }
        Err(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn detect_hq(path: String) -> DetectHqResult {
    let p = PathBuf::from(&expand_tilde(&path));
    if !p.exists() {
        return DetectHqResult {
            exists: false,
            is_hq: false,
            non_empty: false,
        };
    }
    // Either marker is sufficient. `companies/manifest.yaml` is the strongest
    // signal (HQ-specific); `.claude/CLAUDE.md` covers older HQ trees that
    // didn't yet ship a manifest.
    let is_hq = p.join("companies/manifest.yaml").exists() || p.join(".claude/CLAUDE.md").exists();
    // Report whether the directory already holds any entries so the Directory
    // screen can warn before installing on top of an unrelated non-empty
    // folder. Mirrors the `non_empty` computation in `create_directory`.
    let non_empty = p.is_dir()
        && std::fs::read_dir(&p)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
    DetectHqResult {
        exists: true,
        is_hq,
        non_empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn detect_hq_missing_path_returns_exists_false() {
        let r = detect_hq("/definitely/does/not/exist/9f8a7b6c".to_string());
        assert!(!r.exists);
        assert!(!r.is_hq);
        assert!(!r.non_empty);
    }

    #[test]
    fn detect_hq_existing_empty_non_hq_dir() {
        let dir = tempdir().unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(!r.is_hq);
        assert!(!r.non_empty);
    }

    #[test]
    fn detect_hq_non_empty_foreign_dir_reports_non_empty() {
        // The case the Directory-screen warning must catch: a folder that has
        // files but is NOT an HQ. detect_hq must report non_empty so the
        // frontend guard fires.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), "junk").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(!r.is_hq);
        assert!(r.non_empty);
    }

    #[test]
    fn detect_hq_recognizes_manifest_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("companies")).unwrap();
        fs::write(dir.path().join("companies/manifest.yaml"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }

    #[test]
    fn detect_hq_recognizes_claude_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        fs::write(dir.path().join(".claude/CLAUDE.md"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }
}
