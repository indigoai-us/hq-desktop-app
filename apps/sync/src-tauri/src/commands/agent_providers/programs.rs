//! Resolve the program path for each agent CLI.
//!
//! Extracted verbatim from the former `agent_session::{claude,codex,grok}`
//! modules; the launch allowlist stays the single place a tool name becomes a
//! program to run.

use std::path::PathBuf;

use hq_desktop_core::paths;

pub fn claude_program() -> String {
    claude_lookup().path
}

/// Whether a program lookup actually FOUND a binary, and what it landed on.
///
/// [`paths::resolve_bin_with_kind`] falls back to the bare name when it finds
/// nothing, so `claude_program()` alone cannot tell "installed here" from
/// "nowhere on this Mac" — spawning the bare name just fails with os error 2,
/// which the probe used to fold into "not signed in". Callers that must report
/// the difference read `found`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramLookup {
    pub path: String,
    pub found: bool,
}

pub fn claude_lookup() -> ProgramLookup {
    #[cfg(windows)]
    {
        let resolved = resolve_claude_in_dirs(&current_claude_search_dirs())
            .unwrap_or_else(|| paths::ResolvedProgram::not_resolved("claude"));
        return select_claude_lookup(resolved, || crate::commands::launch::bundled_claude_bin());
    }
    #[cfg(not(windows))]
    {
        select_claude_lookup(paths::resolve_bin_with_kind("claude"), || {
            crate::commands::launch::bundled_claude_bin()
        })
    }
}

/// The Claude probe receives the current Windows user PATH as well as the
/// app's inherited child PATH. The registry value is re-read for each probe so
/// Retry observes a CLI installed or added to PATH after HQ started.
pub(super) fn claude_probe_path() -> String {
    #[cfg(windows)]
    {
        let inherited =
            std::env::split_paths(std::ffi::OsStr::new(&paths::child_path())).collect::<Vec<_>>();
        let dirs = claude_search_dirs(
            inherited,
            current_user_path_dirs(),
            std::env::var_os("USERPROFILE").map(PathBuf::from),
            Vec::new(),
        );
        return std::env::join_paths(dirs)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| paths::child_path());
    }
    #[cfg(not(windows))]
    {
        paths::child_path()
    }
}

/// Compose Claude-only Windows search paths. Shared path resolution is
/// intentionally untouched so hq, git, node, and sync-runner lookup retain
/// their existing behavior.
fn claude_search_dirs(
    mut existing: Vec<PathBuf>,
    current_user_path: Vec<PathBuf>,
    user_profile: Option<PathBuf>,
    inherited_path: Vec<PathBuf>,
) -> Vec<PathBuf> {
    // The user's current persisted PATH is authoritative over the stale copy
    // captured in the desktop process at launch.
    existing.extend(current_user_path);
    if let Some(profile) = user_profile {
        existing.push(profile.join(".local").join("bin"));
    }
    existing.extend(inherited_path);

    let mut seen = std::collections::HashSet::new();
    existing.retain(|dir| seen.insert(dir.to_string_lossy().to_lowercase()));
    let (mut real_candidates, windows_apps): (Vec<_>, Vec<_>) = existing
        .into_iter()
        .partition(|dir| !is_windows_apps_dir(dir));
    real_candidates.extend(windows_apps);
    real_candidates
}

fn is_windows_apps_dir(path: &std::path::Path) -> bool {
    let mut components = path.components().rev();
    let is_windows_apps = components.next().is_some_and(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("WindowsApps")
    });
    let is_microsoft = components.next().is_some_and(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("Microsoft")
    });
    is_windows_apps && is_microsoft
}

fn resolve_claude_in_dirs(dirs: &[PathBuf]) -> Option<paths::ResolvedProgram> {
    let candidates = paths::candidate_filenames("claude");
    let matches = dirs
        .iter()
        .flat_map(|dir| candidates.iter().map(move |candidate| dir.join(candidate)))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let references = matches.iter().map(String::as_str).collect::<Vec<_>>();
    paths::pick_spawnable_program(&references)
}

#[cfg(windows)]
fn current_claude_search_dirs() -> Vec<PathBuf> {
    let inherited = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    claude_search_dirs(
        paths::program_search_dirs(),
        current_user_path_dirs(),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
        inherited,
    )
}

#[cfg(windows)]
fn current_user_path_dirs() -> Vec<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let user_path = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .and_then(|key| key.get_value::<String, _>("Path"))
        .map(|path| expand_windows_environment_variables(&path))
        .unwrap_or_default();
    std::env::split_paths(std::ffi::OsStr::new(&user_path)).collect()
}

#[cfg(windows)]
fn expand_windows_environment_variables(value: &str) -> String {
    let mut expanded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('%') else {
            expanded.push_str(&rest[start..]);
            return expanded;
        };
        let name = &after_start[..end];
        if name.is_empty() {
            expanded.push('%');
        } else if let Some(replacement) = std::env::var_os(name) {
            expanded.push_str(&replacement.to_string_lossy());
        } else {
            expanded.push_str(&rest[start..=start + end + 1]);
        }
        rest = &after_start[end + 1..];
    }
    expanded.push_str(rest);
    expanded
}

pub fn codex_lookup() -> ProgramLookup {
    let binary = crate::commands::launch::cli_binary_for("codex").unwrap_or("codex");
    select_codex_lookup(crate::commands::launch::bundled_codex_bin(), || {
        paths::resolve_bin_with_kind(binary)
    })
}

pub fn grok_lookup() -> ProgramLookup {
    let binary = crate::commands::launch::cli_binary_for("grok").unwrap_or("grok");
    let resolved = paths::resolve_bin_with_kind(binary);
    ProgramLookup {
        found: resolved.is_resolved(),
        path: resolved.path,
    }
}

/// A resolved `claude`, else the CLI Claude Desktop manages under Application
/// Support, else the bare name marked NOT found.
///
/// The bundled copy still counts as installed — sessions spawn that binary
/// directly — but when neither exists the lookup must say so rather than hand
/// back a bare `claude` that fails to spawn and reads as "signed out".
fn select_claude_lookup(
    resolved: paths::ResolvedProgram,
    bundled: impl FnOnce() -> Option<PathBuf>,
) -> ProgramLookup {
    if resolved.is_resolved() {
        return ProgramLookup {
            path: resolved.path,
            found: true,
        };
    }
    match bundled() {
        Some(bundled) => ProgramLookup {
            path: bundled.to_string_lossy().into_owned(),
            found: true,
        },
        None => ProgramLookup {
            path: resolved.path,
            found: false,
        },
    }
}

fn select_codex_lookup(
    bundled: Option<PathBuf>,
    fallback: impl FnOnce() -> paths::ResolvedProgram,
) -> ProgramLookup {
    match bundled {
        Some(bundled) => ProgramLookup {
            path: bundled.to_string_lossy().into_owned(),
            found: true,
        },
        None => {
            let resolved = fallback();
            ProgramLookup {
                found: resolved.is_resolved(),
                path: resolved.path,
            }
        }
    }
}

// Through the launch allowlist even though the names are literals here: the
// allowlist is the one place a tool name becomes a program to run, and a second
// spelling of that rule is a second place to get it wrong. Both live in the
// `*_lookup` functions above, which these thin wrappers read.
pub fn codex_program() -> String {
    codex_lookup().path
}

pub fn grok_program() -> String {
    grok_lookup().path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_prefers_bundled_runtime_over_stale_path_cli() {
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        let found = select_codex_lookup(Some(bundled.clone()), || panic!("PATH must not win"));
        assert_eq!(found.path, bundled.to_string_lossy());
        assert!(found.found);

        let on_path = select_codex_lookup(None, || paths::ResolvedProgram {
            path: "/usr/local/bin/codex".into(),
            kind: paths::ResolvedProgramKind::Exe,
        });
        assert_eq!(on_path.path, "/usr/local/bin/codex");
        assert!(on_path.found);
    }

    /// The whole point of the lookup: nothing on disk is NOT "signed out".
    #[test]
    fn an_unresolved_codex_is_reported_as_not_found() {
        let missing = select_codex_lookup(None, || paths::ResolvedProgram::not_resolved("codex"));
        assert_eq!(missing.path, "codex");
        assert!(!missing.found);
    }

    #[test]
    fn claude_falls_back_to_the_bundled_cli_before_reporting_absent() {
        let bundled = PathBuf::from("/Users/x/Library/Application Support/Claude/claude");
        let from_bundle =
            select_claude_lookup(paths::ResolvedProgram::not_resolved("claude"), || {
                Some(bundled.clone())
            });
        assert_eq!(from_bundle.path, bundled.to_string_lossy());
        assert!(from_bundle.found);

        let on_path = select_claude_lookup(
            paths::ResolvedProgram {
                path: "/opt/homebrew/bin/claude".into(),
                kind: paths::ResolvedProgramKind::Exe,
            },
            || panic!("a resolved CLI must win over the bundle"),
        );
        assert_eq!(on_path.path, "/opt/homebrew/bin/claude");
        assert!(on_path.found);

        let nowhere = select_claude_lookup(paths::ResolvedProgram::not_resolved("claude"), || None);
        assert_eq!(nowhere.path, "claude");
        assert!(!nowhere.found);
    }

    #[cfg(windows)]
    #[test]
    fn claude_lookup_finds_the_windows_user_local_bin_installer() {
        let temp = tempfile::tempdir().expect("temporary home");
        let local_bin = temp.path().join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).expect("create installer directory");
        let executable = local_bin.join("claude.exe");
        std::fs::write(&executable, b"fixture").expect("write executable fixture");

        let dirs = claude_search_dirs(
            Vec::new(),
            Vec::new(),
            Some(temp.path().to_path_buf()),
            Vec::new(),
        );
        let resolved = resolve_claude_in_dirs(&dirs);
        assert!(
            resolved.is_some(),
            "Claude Code in user-local installer path"
        );
        let resolved = resolved.unwrap();
        assert_eq!(resolved.path, executable.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn claude_lookup_uses_the_refreshed_user_path_on_retry() {
        let temp = tempfile::tempdir().expect("temporary home");
        let stale = temp.path().join("stale-path");
        let refreshed = temp.path().join("new-user-path");
        std::fs::create_dir_all(&stale).expect("create stale path");
        std::fs::create_dir_all(&refreshed).expect("create refreshed user path");
        let executable = refreshed.join("claude.exe");
        std::fs::write(&executable, b"fixture").expect("write executable fixture");

        let before_retry = claude_search_dirs(Vec::new(), Vec::new(), None, vec![stale.clone()]);
        assert!(resolve_claude_in_dirs(&before_retry).is_none());

        let after_retry = claude_search_dirs(Vec::new(), vec![refreshed], None, vec![stale]);
        let resolved = resolve_claude_in_dirs(&after_retry);
        assert!(resolved.is_some(), "refreshed PATH finds Claude");
        let resolved = resolved.unwrap();
        assert_eq!(resolved.path, executable.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn claude_lookup_prefers_real_cli_over_windows_apps_alias() {
        let temp = tempfile::tempdir().expect("temporary search root");
        let windows_apps = temp.path().join("Microsoft").join("WindowsApps");
        let npm_global = temp.path().join("AppData").join("npm");
        std::fs::create_dir_all(&windows_apps).expect("create alias directory");
        std::fs::create_dir_all(&npm_global).expect("create npm directory");
        let alias = windows_apps.join("claude.exe");
        let real_cli = npm_global.join("claude.cmd");
        std::fs::write(&alias, b"app execution alias fixture").expect("write alias fixture");
        std::fs::write(&real_cli, "@echo off\r\necho {\"loggedIn\":true}\r\n")
            .expect("write npm shim fixture");

        let dirs = claude_search_dirs(vec![windows_apps], vec![npm_global], None, Vec::new());
        let resolved = resolve_claude_in_dirs(&dirs);
        assert!(resolved.is_some(), "resolve real Claude Code candidate");
        assert_eq!(resolved.unwrap().path, real_cli.to_string_lossy());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn signed_in_cli_from_user_local_bin_becomes_a_signed_in_runtime() {
        let temp = tempfile::tempdir().expect("temporary home");
        let local_bin = temp.path().join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).expect("create installer directory");
        let shim = local_bin.join("claude.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\necho {\"loggedIn\":true}\r\nexit /b 0\r\n",
        )
        .expect("write fake Claude CLI shim");

        let dirs = claude_search_dirs(
            Vec::new(),
            Vec::new(),
            Some(temp.path().to_path_buf()),
            Vec::new(),
        );
        let resolved = resolve_claude_in_dirs(&dirs);
        assert!(resolved.is_some(), "resolve Claude shim");
        let resolved = resolved.unwrap();
        let status = super::super::classify_runtime(
            true,
            super::super::probe_detail(super::super::SessionTool::Claude, &resolved.path).await,
            Vec::new,
        );
        assert_eq!(status, super::super::RuntimeStatus::SignedIn);
    }
}
