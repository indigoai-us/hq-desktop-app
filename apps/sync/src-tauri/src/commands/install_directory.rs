use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::util::win32_path::strip_windows_verbatim_prefix;

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
    // H8: with the paired root flow on, only `initialize` may create a root.
    if crate::commands::personal_root::paired_root_gate_enabled() {
        return Err("HQ creates this folder during setup.".to_string());
    }
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

    let non_empty = target.is_dir() && has_foreign_entries(&target);

    Ok(CreateDirectoryResult {
        path: target.to_string_lossy().into_owned(),
        already_existed,
        non_empty,
    })
}

/// Entries that do not make a folder "already has files" for the location
/// step: HQ's own `.hq` state folder, which HQ writes into the folder it is
/// set up in, and the Finder's `.DS_Store`. Neither is something the person
/// put there, so a folder holding only these is offered as is instead of
/// pushing the install into a nested `hq` folder.
const SETUP_IGNORED_ENTRIES: &[&str] = &[".hq", ".DS_Store"];

/// True when `dir` holds at least one entry the person (or another program)
/// put there. Unreadable folders report false, as before.
fn has_foreign_entries(dir: &std::path::Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(Result::ok).any(|entry| {
            let name = entry.file_name();
            !SETUP_IGNORED_ENTRIES
                .iter()
                .any(|ignored| name.to_str() == Some(*ignored))
        }),
        Err(_) => false,
    }
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

/// The HQ folder when it already exists (the configured one, else a
/// discovered HQ root, else `~/hq`),
/// canonicalised like `resolve_hq_path`. Never creates it: callers that only
/// read HQ (the first-run context scan) report "no HQ folder" instead.
pub fn existing_hq_path() -> Option<String> {
    let hq_path = default_install_path();
    if !hq_path.is_dir() {
        return None;
    }
    let canonical = std::fs::canonicalize(&hq_path).unwrap_or(hq_path);
    Some(strip_windows_verbatim_prefix(&canonical.to_string_lossy()))
}

/// Resolve the HQ install directory, create it if absent, and return its
/// absolute path.
///
/// Honors the folder the user chose on the Directory screen (persisted to
/// `menubar.json` `hqPath` via [`set_hq_install_path`]); when nothing has been
/// chosen yet, adopts an existing HQ root found by discovery, else `~/hq`. Every onboarding setup stage (template
/// extraction, git init, personalize, sync) resolves through here, so the
/// chosen location is honored everywhere rather than silently defaulting to
/// `~/hq`.
pub fn resolve_hq_path() -> Result<String, String> {
    // H8 (gated): with the paired root flow on, stages never create the root.
    // `initialize` already created it, or setup stops here.
    if crate::commands::personal_root::paired_root_gate_enabled() {
        return resolve_existing_hq_path();
    }
    resolve_hq_path_with(true)
}

/// Resolve the chosen HQ folder only when it already exists. Never creates it.
pub fn resolve_existing_hq_path() -> Result<String, String> {
    let path = default_install_path();
    if !path.is_dir() {
        return Err(format!("{} is not set up yet", path.display()));
    }
    resolve_hq_path_at(path, false)
}

/// Tauri entry point for [`resolve_hq_path`]. It only creates the folder when
/// the caller passes `create: true`. The setup wizard asks for the default
/// before the person has chosen a location, and recovery screens only display
/// the path, so neither may create it. The setup stages create the folder
/// through the Rust [`resolve_hq_path`], not this command.
pub mod command {
    #[tauri::command]
    pub fn resolve_hq_path(create: Option<bool>) -> Result<String, String> {
        super::resolve_hq_path_with(create.unwrap_or(false))
    }
}

fn resolve_hq_path_with(create: bool) -> Result<String, String> {
    resolve_hq_path_at(default_install_path(), create)
}

/// The HQ folder onboarding targets: the recorded `hqPath`, else an existing
/// launchable HQ root found at a discovery candidate, else `~/hq`. Adopting
/// the existing root keeps a fresh install from creating a second one.
fn default_install_path() -> PathBuf {
    install_path_from(
        persisted_install_path(),
        hq_desktop_core::paths::discover_launchable_hq_root(),
        expand_tilde("~/hq"),
    )
}

fn install_path_from(
    persisted: Option<PathBuf>,
    discovered: Option<PathBuf>,
    default: PathBuf,
) -> PathBuf {
    persisted.or(discovered).unwrap_or(default)
}

/// Resolve a known HQ folder path; create it only when `create` is true.
fn resolve_hq_path_at(hq_path: PathBuf, create: bool) -> Result<String, String> {
    if hq_path.exists() && !hq_path.is_dir() {
        return Err(format!(
            "{} exists but is a file, not a folder",
            hq_path.display()
        ));
    }
    if !hq_path.exists() {
        if !create {
            return Ok(strip_windows_verbatim_prefix(&hq_path.to_string_lossy()));
        }
        std::fs::create_dir_all(&hq_path)
            .map_err(|e| format!("Failed to create {}: {e}", hq_path.display()))?;
    }
    // Realpath, then drop `\\?\` only when legacy Win32 can name the path.
    // Same portable gate as Copy/Explorer — reserved DOS names, trailing
    // dots/spaces, oversize components, and MAX_PATH keep the prefix.
    let canonical = std::fs::canonicalize(&hq_path).unwrap_or(hq_path);
    Ok(strip_windows_verbatim_prefix(&canonical.to_string_lossy()))
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
    // Persist a Win32 verbatim prefix only when stripping it would be unsafe
    // (reserved DOS names, trailing dots/spaces, MAX_PATH). Older installs
    // may still have `\\?\` in hqPath; resolve_hq_path uses the same gate.
    let stored = strip_windows_verbatim_prefix(&expanded.to_string_lossy());
    let menubar_path = crate::util::paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &menubar_path,
        &[("hqPath", serde_json::Value::String(stored))],
    )
}

/// Whether HQ could create or write the folder at `path`, checked without
/// changing anything on disk.
///
/// The folder picker and the Install button both call this before setup. It
/// never creates the folder, its parents, or a probe file: an existing folder
/// is checked directly, and an absent one is checked through its nearest
/// existing ancestor. The setup stages still create the folder when they run.
#[tauri::command]
pub fn check_writable(path: String) -> Result<bool, String> {
    Ok(writable_without_creating(&expand_tilde(&path)))
}

fn writable_without_creating(target: &Path) -> bool {
    let mut current = target;
    loop {
        match std::fs::metadata(current) {
            // Whatever exists first on the way up must be a writable folder.
            // A file in the way (at the target or above it) means no.
            Ok(meta) => return meta.is_dir() && directory_accepts_writes(current, &meta),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => match current.parent() {
                Some(parent) if parent != current && !parent.as_os_str().is_empty() => {
                    current = parent;
                }
                _ => return false,
            },
            Err(_) => return false,
        }
    }
}

#[cfg(unix)]
fn directory_accepts_writes(dir: &Path, _meta: &std::fs::Metadata) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `access` reads a NUL-terminated path and has no other effects.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn directory_accepts_writes(_dir: &Path, meta: &std::fs::Metadata) -> bool {
    !meta.permissions().readonly()
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
    let non_empty = p.is_dir() && has_foreign_entries(&p);
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

    /// A folder holding only HQ's own `.hq` state (and Finder's `.DS_Store`)
    /// is not "a location that already has files", so the location step does
    /// not push a new user into a nested `hq` folder because of it.
    #[test]
    fn detect_hq_ignores_hq_state_and_finder_metadata() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".hq")).unwrap();
        fs::write(dir.path().join(".hq/config.json"), "{}").unwrap();
        fs::write(dir.path().join(".DS_Store"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(!r.is_hq);
        assert!(!r.non_empty);

        // Anything else still counts.
        fs::write(dir.path().join("notes.txt"), "mine").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.non_empty);
    }

    /// Resolving without `create` returns the path and leaves the folder
    /// absent; resolving with it creates the folder. Runs on every platform.
    #[test]
    fn resolve_hq_path_at_creates_the_folder_only_when_asked() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("hq");

        let resolved = resolve_hq_path_at(root.clone(), false).unwrap();
        assert_eq!(
            PathBuf::from(&resolved),
            PathBuf::from(strip_windows_verbatim_prefix(&root.to_string_lossy()))
        );
        assert!(!root.exists());

        let created = resolve_hq_path_at(root.clone(), true).unwrap();
        assert!(root.is_dir());
        assert_eq!(
            fs::canonicalize(PathBuf::from(created)).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
    }

    /// The setup wizard's default-folder lookup and the error screen's path
    /// display must not create the folder. Only an explicit `create: true`
    /// does; the setup stages create it through the Rust resolver.
    /// Unix only: the default folder hangs off `$HOME`, which `scoped_home`
    /// can redirect. On Windows the home folder comes from the known-folder
    /// API, so this test would resolve (and create) the runner's real
    /// `%USERPROFILE%\hq`. The test above covers the create switch there.
    #[cfg(unix)]
    #[test]
    fn resolve_hq_path_command_without_create_leaves_the_folder_absent() {
        let _g = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        let _home = crate::util::test_support::scoped_home(home.path());
        let default_root = home.path().join("hq");

        let resolved = command::resolve_hq_path(Some(false)).unwrap();
        assert_eq!(PathBuf::from(&resolved), default_root);
        assert!(!default_root.exists());

        // Omitting `create` (the error screen's call) no longer creates it.
        let resolved = command::resolve_hq_path(None).unwrap();
        assert_eq!(PathBuf::from(&resolved), default_root);
        assert!(!default_root.exists());

        let created = command::resolve_hq_path(Some(true)).unwrap();
        assert!(default_root.is_dir());
        assert_eq!(
            fs::canonicalize(PathBuf::from(created)).unwrap(),
            fs::canonicalize(&default_root).unwrap()
        );
    }

    /// Create a folder that passes `is_launchable_hq_root`.
    fn scaffold_launchable_root(root: &std::path::Path) {
        fs::create_dir_all(root.join("companies")).unwrap();
        fs::write(root.join("companies/manifest.yaml"), "companies: {}\n").unwrap();
        fs::create_dir_all(root.join("core")).unwrap();
        fs::write(
            root.join("core/core.yaml"),
            "version: 1\nhqVersion: 15.0.0\n",
        )
        .unwrap();
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::write(root.join(".claude/settings.json"), "{}").unwrap();
    }

    /// With nothing recorded, an existing HQ root found by discovery is the
    /// install target, so onboarding does not create a second `~/hq`.
    #[test]
    fn existing_valid_root_at_candidate_is_adopted_not_duplicated() {
        let home = tempdir().unwrap();
        let existing = home.path().join("Documents").join("HQ");
        scaffold_launchable_root(&existing);
        let default_root = home.path().join("hq");

        let target = install_path_from(None, Some(existing.clone()), default_root.clone());
        assert_eq!(target, existing);

        let resolved = resolve_hq_path_at(target, true).unwrap();
        assert_eq!(
            fs::canonicalize(PathBuf::from(resolved)).unwrap(),
            fs::canonicalize(&existing).unwrap()
        );
        assert!(!default_root.exists(), "a second HQ root was created");
    }

    /// The folder the person chose still wins over a discovered root.
    #[test]
    fn recorded_path_still_wins_over_discovered_root() {
        let home = tempdir().unwrap();
        let existing = home.path().join("Documents").join("HQ");
        let chosen = home.path().join("chosen");
        let target =
            install_path_from(Some(chosen.clone()), Some(existing), home.path().join("hq"));
        assert_eq!(target, chosen);
    }

    /// End to end through the Tauri command: a fresh machine (no `hqPath`)
    /// with an HQ root under `~/Documents/HQ` resolves to that root and
    /// leaves `~/hq` absent. Unix only for the same reason as the test above.
    #[cfg(unix)]
    #[test]
    fn resolve_hq_path_command_adopts_a_discovered_root() {
        let _g = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        let _home = crate::util::test_support::scoped_home(home.path());
        let existing = home.path().join("Documents").join("HQ");
        scaffold_launchable_root(&existing);
        let default_root = home.path().join("hq");

        let resolved = command::resolve_hq_path(None).unwrap();
        assert_eq!(
            fs::canonicalize(PathBuf::from(&resolved)).unwrap(),
            fs::canonicalize(&existing).unwrap()
        );
        assert!(!default_root.exists(), "a second HQ root was created");
        assert_eq!(
            existing_hq_path()
                .map(PathBuf::from)
                .map(|p| fs::canonicalize(p).unwrap()),
            Some(fs::canonicalize(&existing).unwrap())
        );
    }

    #[test]
    fn resolve_and_persist_use_win32_safety_gate() {
        let src = include_str!("install_directory.rs");
        let production = src.split("#[cfg(test)]").next().expect("production source");
        assert!(production.contains("std::fs::canonicalize(&hq_path)"));
        assert!(production.contains("strip_windows_verbatim_prefix"));
        assert!(!production.contains("dunce::canonicalize"));
        assert!(!production.contains("dunce::simplified"));
        assert!(!production.contains("hq_path.canonicalize"));
    }

    #[test]
    fn persist_keeps_verbatim_when_legacy_win32_cannot_name_path() {
        use crate::util::win32_path::strip_windows_verbatim_prefix;
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\C:\CON"), r"\\?\C:\CON");
        let long = format!(r"\\?\C:\x\{}", "a".repeat(255));
        assert_eq!(strip_windows_verbatim_prefix(&long), long);
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\person\hq"),
            r"C:\Users\person\hq"
        );
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

    fn tree(dir: &std::path::Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            for entry in fs::read_dir(&next).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
        out.sort();
        out
    }

    /// H8: the picker and the Install button check an absent folder without
    /// creating it, its parent, or a probe file.
    #[test]
    fn check_writable_creates_nothing_for_an_absent_folder() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("Projects").join("hq");
        let before = tree(dir.path());

        assert_eq!(
            check_writable(target.to_string_lossy().into_owned()),
            Ok(true)
        );
        assert_eq!(
            check_writable(target.join("hq").to_string_lossy().into_owned()),
            Ok(true)
        );
        assert_eq!(tree(dir.path()), before);
        assert!(!target.exists());
        assert!(!dir.path().join("Projects").exists());
    }

    /// An existing folder is checked in place, with nothing written into it.
    #[test]
    fn check_writable_leaves_an_existing_folder_untouched() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), "mine").unwrap();
        let before = tree(dir.path());
        assert_eq!(
            check_writable(dir.path().to_string_lossy().into_owned()),
            Ok(true)
        );
        assert_eq!(tree(dir.path()), before);
    }

    #[test]
    fn check_writable_rejects_a_file_in_the_way() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("hq");
        fs::write(&file, "not a folder").unwrap();
        assert_eq!(
            check_writable(file.to_string_lossy().into_owned()),
            Ok(false)
        );
        assert_eq!(
            check_writable(file.join("child").to_string_lossy().into_owned()),
            Ok(false)
        );
    }

    #[cfg(unix)]
    #[test]
    fn check_writable_rejects_a_read_only_ancestor_without_creating_anything() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        // Root ignores mode bits; the check is only meaningful for a user.
        let is_root = unsafe { libc::geteuid() } == 0;
        let result = check_writable(locked.join("hq").to_string_lossy().into_owned());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if !is_root {
            assert_eq!(result, Ok(false));
        }
        assert!(!locked.join("hq").exists());
    }

    /// H8 regression for the fresh-install path with the paired gate off: the
    /// Directory step no longer creates the folder, and the first setup stage
    /// still does, through the Rust resolver every stage uses.
    #[cfg(unix)]
    #[test]
    fn fresh_install_still_creates_the_folder_at_the_setup_stage() {
        let _g = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        let _home = crate::util::test_support::scoped_home(home.path());
        let chosen = home.path().join("Work").join("hq");

        // Directory step: persist the choice and validate it.
        set_hq_install_path(chosen.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            check_writable(chosen.to_string_lossy().into_owned()),
            Ok(true)
        );
        assert!(
            !chosen.exists(),
            "the Directory step must not create the folder"
        );

        // Setup stage (content, git-init, personalize, sync) resolver.
        let resolved = resolve_hq_path().unwrap();
        assert!(chosen.is_dir(), "the setup stage creates the folder");
        assert_eq!(
            fs::canonicalize(PathBuf::from(resolved)).unwrap(),
            fs::canonicalize(&chosen).unwrap()
        );
    }

    /// H8 (gated): with the paired root flow on, no stage resolver or IPC
    /// creates the root. Only the wrapper's `initialize` may.
    #[cfg(unix)]
    #[test]
    fn with_the_paired_gate_on_nothing_creates_the_root() {
        let _g = crate::util::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        let _home = crate::util::test_support::scoped_home(home.path());
        let _gate = crate::commands::personal_root::GateOverride::set(true);
        let chosen = home.path().join("Work").join("hq");
        set_hq_install_path(chosen.to_string_lossy().into_owned()).unwrap();

        assert!(resolve_hq_path().is_err());
        assert!(resolve_existing_hq_path().is_err());
        assert!(create_directory(
            home.path().join("Work").to_string_lossy().into_owned(),
            "hq".to_string()
        )
        .is_err());
        assert!(!chosen.exists());
        assert!(!home.path().join("Work").exists());
    }
}
