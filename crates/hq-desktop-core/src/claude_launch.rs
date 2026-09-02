//! Claude Code Desktop deep-link preflight — bind HQ root project context and
//! verify hook-ready settings before dispatching `claude://code/new`.

use std::path::{Path, PathBuf};

use serde_json::Value;
use url::Url;

use crate::library_local::resolve_hq_folder;
use crate::paths::is_valid_hq_root;
use crate::win32_path::strip_windows_verbatim_prefix;

/// Render the resolved folder for the `folder` query parameter.
///
/// `std::fs::canonicalize` returns a Windows *verbatim* path (`\\?\C:\Users\
/// you\HQ`, or `\\?\UNC\server\share\HQ`). That form is for the Win32 API,
/// not for another application: Claude reads the leading `\\` as a UNC /
/// network path and refuses it — "UNC / network paths are not supported" —
/// so the HQ folder is never adopted and the session opens somewhere else.
///
/// `strip_windows_verbatim_prefix` returns the legacy Win32 spelling, and
/// deliberately keeps the prefix when the remainder cannot be named without
/// it (reserved DOS device, trailing dot/space, over MAX_PATH). Keeping the
/// prefix in those cases is still wrong for Claude, but it is the pre-existing
/// contract shared with Explorer Reveal and HQ-path persist, and a path that
/// legacy Win32 cannot name is not one Claude could open either.
///
/// No-op on macOS and Linux, where canonicalize has no such prefix.
fn deep_link_folder_value(folder: &Path) -> String {
    strip_windows_verbatim_prefix(&folder.to_string_lossy())
}

/// Returns the list of missing marker paths relative to `path`.
pub fn missing_claude_launch_markers(path: &Path) -> Vec<String> {
    let mut missing = missing_setup_repair_markers(path);
    if !path.join(".claude/settings.json").is_file() {
        missing.push(".claude/settings.json".to_string());
    }
    missing
}

fn missing_setup_repair_markers(path: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_hq_root(path) {
        missing.push("core/core.yaml (valid hq-core schema)".to_string());
    }
    if !path.join("companies/manifest.yaml").is_file() {
        missing.push("companies/manifest.yaml".to_string());
    }
    missing
}

pub fn has_claude_launch_hq_markers(path: &Path) -> bool {
    missing_claude_launch_markers(path).is_empty()
}

fn has_setup_repair_markers(path: &Path) -> bool {
    missing_setup_repair_markers(path).is_empty()
}

fn resolve_hq_root_with_markers(
    folder: &Path,
    has_markers: fn(&Path) -> bool,
    expected: &str,
) -> Result<PathBuf, String> {
    let start = std::fs::canonicalize(folder)
        .map_err(|error| format!("could not resolve Claude folder {:?}: {error}", folder))?;
    let mut current = start.as_path();
    loop {
        if has_markers(current) {
            return Ok(current.to_path_buf());
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Err(format!(
        "Claude Code must open at your HQ root, not a parent or child folder. \
         Expected markers ({expected}) under {:?}. Open Settings and re-tether your HQ folder, \
         or run `bash core/scripts/check-hq-hooks.sh --root <hq-root>` after repair.",
        start
    ))
}

/// Walk upward from `folder` to locate the nearest directory that looks like an
/// HQ root suitable for Claude Code Desktop project settings.
pub fn resolve_hq_root_for_claude_launch(folder: &Path) -> Result<PathBuf, String> {
    resolve_hq_root_with_markers(
        folder,
        has_claude_launch_hq_markers,
        ".claude/settings.json, core/core.yaml, companies/manifest.yaml",
    )
}

fn resolve_hq_root_for_setup_repair(folder: &Path) -> Result<PathBuf, String> {
    resolve_hq_root_with_markers(
        folder,
        has_setup_repair_markers,
        "core/core.yaml, companies/manifest.yaml",
    )
}

/// Runtime-independent hook readiness check mirroring `check-hq-hooks.sh`
/// (without `--require-ledger`, since Desktop does not dispatch SessionStart).
pub fn check_hq_hooks_ready(hq_root: &Path) -> Result<(), String> {
    let settings_path = hq_root.join(".claude/settings.json");
    let raw = std::fs::read_to_string(&settings_path).map_err(|_| {
        ".claude/settings.json is missing — run `hq rescue -y --paths .claude` in your HQ root"
            .to_string()
    })?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| {
        ".claude/settings.json is not valid JSON — run `hq rescue -y --paths .claude`".to_string()
    })?;
    for event in ["SessionStart", "PreToolUse"] {
        let has_command_hook = parsed
            .pointer(&format!("/hooks/{event}"))
            .and_then(|groups| groups.as_array())
            .map(|groups| {
                groups.iter().any(|group| {
                    group
                        .get("hooks")
                        .and_then(|hooks| hooks.as_array())
                        .map(|hooks| {
                            hooks.iter().any(|hook| {
                                hook.get("type").and_then(|v| v.as_str()) == Some("command")
                                    && hook
                                        .get("command")
                                        .and_then(|v| v.as_str())
                                        .map(|cmd| !cmd.trim().is_empty())
                                        .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !has_command_hook {
            return Err(format!(
                "{event} has no command hook in .claude/settings.json — \
                 run `hq rescue -y --paths .claude`, then open the HQ root itself \
                 (not a parent or child folder) in Claude Code Desktop"
            ));
        }
    }
    Ok(())
}

/// Resolve the HQ root that should back a Claude deep link, preferring an
/// upward walk from the URL folder and falling back to the configured HQ path.
pub fn bind_hq_root_for_claude_launch(folder: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(folder) = folder.filter(|p| !p.as_os_str().is_empty()) {
        if let Ok(root) = resolve_hq_root_for_claude_launch(folder) {
            return Ok(root);
        }
    }
    let configured = resolve_hq_folder();
    if has_claude_launch_hq_markers(&configured) {
        return Ok(configured);
    }
    let missing = missing_claude_launch_markers(&configured);
    Err(format!(
        "HQ folder is not ready for Claude Code Desktop ({}) — \
         re-tether in Settings or run `hq rescue -y --paths .claude`",
        missing.join(", ")
    ))
}

fn expand_user_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// `/setup` is the onboarding repair path. The ready screen launches Claude
/// with that prompt when a setup stage failed — often the template download,
/// which is exactly when `core/core.yaml` and `companies/manifest.yaml` are
/// missing. Requiring those markers here blocks the CTA that is supposed to
/// create them. Open the intended folder if it exists; only fail when we
/// have no directory to hand Claude.
fn existing_setup_repair_folder(folder: &Path) -> Option<PathBuf> {
    let expanded = expand_user_path(folder);
    if let Ok(canonical) = std::fs::canonicalize(&expanded) {
        if canonical.is_dir() {
            return Some(canonical);
        }
    }
    if expanded.is_dir() {
        return Some(expanded);
    }
    None
}

fn bind_hq_root_for_setup_repair(folder: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(folder) = folder.filter(|p| !p.as_os_str().is_empty()) {
        let expanded = expand_user_path(folder);
        if let Ok(root) = resolve_hq_root_for_setup_repair(&expanded) {
            return Ok(root);
        }
        if let Some(existing) = existing_setup_repair_folder(&expanded) {
            return Ok(existing);
        }
        return Err(format!(
            "HQ folder does not exist at {} — pick it in Settings or finish the installer download step",
            expanded.display()
        ));
    }
    let configured = resolve_hq_folder();
    if has_setup_repair_markers(&configured) {
        return Ok(configured);
    }
    if let Some(existing) = existing_setup_repair_folder(&configured) {
        return Ok(existing);
    }
    let missing = missing_setup_repair_markers(&configured);
    Err(format!(
        "HQ folder is not ready for Claude Code Desktop setup repair ({}) — \
         re-tether in Settings or finish onboarding",
        missing.join(", ")
    ))
}

/// Keep an authorized subfolder when it already lives under the resolved HQ
/// root; otherwise bind Claude to the HQ root itself for project settings.
fn rebound_claude_folder(original: Option<&Path>, hq_root: &Path) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(hq_root)
        .map_err(|error| format!("could not resolve HQ root {:?}: {error}", hq_root))?;
    if let Some(original) = original.filter(|path| !path.as_os_str().is_empty()) {
        if let Ok(canonical_original) = std::fs::canonicalize(original) {
            if canonical_original.starts_with(&canonical_root) {
                return Ok(canonical_original);
            }
        }
    }
    Ok(canonical_root)
}

/// Parse a validated `claude://code/new?...` URL, bind the `folder` parameter
/// to the HQ root, verify hook health, and return the rewritten URL.
pub fn preflight_claude_code_url(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|error| format!("invalid Claude URL: {error}"))?;
    let mut folder = parsed
        .query_pairs()
        .find(|(key, _)| key == "folder")
        .map(|(_, value)| PathBuf::from(value.as_ref()));
    let prompt = parsed
        .query_pairs()
        .find(|(key, _)| key == "q")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();

    let setup_repair = prompt.contains("/setup");
    let hq_root = if setup_repair {
        bind_hq_root_for_setup_repair(folder.as_deref())?
    } else {
        bind_hq_root_for_claude_launch(folder.as_deref())?
    };
    if !setup_repair {
        check_hq_hooks_ready(&hq_root)?;
    }

    folder = Some(rebound_claude_folder(folder.as_deref(), &hq_root)?);
    let mut rebound = Url::parse("claude://code/new")
        .map_err(|error| format!("failed to rebuild Claude URL: {error}"))?;
    {
        let mut pairs = rebound.query_pairs_mut();
        if !prompt.is_empty() {
            pairs.append_pair("q", &prompt);
        }
        pairs.append_pair("folder", &deep_link_folder_value(&folder.unwrap()));
    }
    Ok(rebound.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_core_yaml(root: &Path) {
        fs::create_dir_all(root.join("core")).unwrap();
        fs::write(
            root.join("core/core.yaml"),
            "version: 1\nhqVersion: \"15.0.0\"\n",
        )
        .unwrap();
    }

    fn write_settings(root: &Path) {
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::write(
            root.join(".claude/settings.json"),
            r#"{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "echo start"}]}],
    "PreToolUse": [{"hooks": [{"type": "command", "command": "echo pre"}]}]
  }
}"#,
        )
        .unwrap();
    }

    fn scaffold_hq(root: &Path) {
        write_core_yaml(root);
        write_settings(root);
        fs::create_dir_all(root.join("companies")).unwrap();
        fs::write(root.join("companies/manifest.yaml"), "companies: []\n").unwrap();
    }

    #[test]
    fn resolves_child_folder_to_hq_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("HQ");
        scaffold_hq(&root);
        let child = root.join("companies/indigo/projects/demo");
        fs::create_dir_all(&child).unwrap();
        let resolved = resolve_hq_root_for_claude_launch(&child).unwrap();
        assert_eq!(resolved, fs::canonicalize(&root).unwrap());
    }

    #[test]
    fn rejects_folder_without_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("not-hq");
        fs::create_dir_all(&bad).unwrap();
        assert!(resolve_hq_root_for_claude_launch(&bad).is_err());
    }

    #[test]
    fn hook_health_requires_session_start_and_pre_tool_use() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        scaffold_hq(root);
        assert!(check_hq_hooks_ready(root).is_ok());

        fs::write(
            root.join(".claude/settings.json"),
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo pre"}]}]}}"#,
        )
        .unwrap();
        assert!(check_hq_hooks_ready(root).is_err());
    }

    #[test]
    fn preflight_preserves_authorized_subfolder_under_hq_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("HQ");
        scaffold_hq(&root);
        let child = root.join("companies/indigo/projects/demo");
        fs::create_dir_all(&child).unwrap();
        let child = fs::canonicalize(&child).unwrap();
        let url = format!(
            "claude://code/new?q=hello&folder={}",
            child.to_string_lossy().replace(' ', "%20")
        );
        let rebound = preflight_claude_code_url(&url).unwrap();
        let parsed = Url::parse(&rebound).unwrap();
        let folder = parsed
            .query_pairs()
            .find(|(key, _)| key == "folder")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        assert_eq!(folder, child.to_string_lossy());
        assert!(parsed.query_pairs().any(|(key, _)| key == "q"));
    }

    #[test]
    fn preflight_allows_setup_repair_without_hook_health() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("HQ");
        write_core_yaml(&root);
        fs::create_dir_all(root.join("companies")).unwrap();
        fs::write(root.join("companies/manifest.yaml"), "companies: []\n").unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let url = format!(
            "claude://code/new?q=%2Fsetup&folder={}",
            root.to_string_lossy().replace(' ', "%20")
        );
        assert!(preflight_claude_code_url(&url).is_ok());
    }

    #[test]
    fn preflight_allows_setup_repair_without_hq_markers() {
        // Ready-screen "Open in Claude Code" after a failed content stage:
        // the install dir exists but core.yaml + manifest have not landed yet.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("hq");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let url = format!(
            "claude://code/new?q=%2Fsetup&folder={}",
            root.to_string_lossy().replace(' ', "%20")
        );
        let rebound =
            preflight_claude_code_url(&url).expect("setup repair must open an empty HQ dir");
        let parsed = Url::parse(&rebound).unwrap();
        let folder = parsed
            .query_pairs()
            .find(|(key, _)| key == "folder")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        assert_eq!(folder, root.to_string_lossy());
        assert!(parsed
            .query_pairs()
            .any(|(key, value)| key == "q" && value.contains("/setup")));
    }

    // Windows regression: `std::fs::canonicalize` returns a verbatim path,
    // and handing `\\?\C:\...` to Claude reads as a UNC / network path, which
    // it rejects — so the HQ folder was never adopted on Windows even though
    // the link opened. These are string-level assertions on the pure renderer
    // so Linux and macOS CI lock the Windows contract too (the same reason
    // `win32_path` is implemented as string checks rather than `dunce`).

    #[test]
    fn deep_link_folder_strips_the_windows_verbatim_prefix() {
        assert_eq!(
            deep_link_folder_value(Path::new(r"\\?\C:\Users\person\HQ")),
            r"C:\Users\person\HQ"
        );
        assert_eq!(
            deep_link_folder_value(Path::new(r"\\?\C:\HQ Setup")),
            r"C:\HQ Setup"
        );
    }

    #[test]
    fn deep_link_folder_rewrites_verbatim_unc_to_plain_unc() {
        assert_eq!(
            deep_link_folder_value(Path::new(r"\\?\UNC\server\share\HQ")),
            r"\\server\share\HQ"
        );
    }

    #[test]
    fn deep_link_folder_keeps_the_prefix_when_legacy_win32_cannot_name_it() {
        // Reserved DOS device and an over-MAX_PATH path must keep `\\?\` —
        // dropping it would name a different (or unnameable) target. Claude
        // cannot open either, but silently rewriting the path is worse than
        // handing over the one the OS actually resolved.
        assert_eq!(
            deep_link_folder_value(Path::new(r"\\?\C:\CON")),
            r"\\?\C:\CON"
        );
        let long = format!(r"\\?\C:\x\{}", "a".repeat(255));
        assert_eq!(deep_link_folder_value(Path::new(&long)), long);
    }

    #[test]
    fn deep_link_folder_leaves_posix_paths_alone() {
        assert_eq!(
            deep_link_folder_value(Path::new("/Users/person/HQ")),
            "/Users/person/HQ"
        );
        assert_eq!(
            deep_link_folder_value(Path::new("/Users/person/HQ Setup")),
            "/Users/person/HQ Setup"
        );
    }

    #[test]
    fn preflight_never_emits_a_verbatim_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("HQ");
        scaffold_hq(&root);
        let root = fs::canonicalize(&root).unwrap();
        let url = format!(
            "claude://code/new?q=%2Fsetup&folder={}",
            root.to_string_lossy().replace(' ', "%20")
        );
        let rebound = preflight_claude_code_url(&url).unwrap();
        let folder = Url::parse(&rebound)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "folder")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        assert!(
            !folder.starts_with(r"\\?\"),
            "deep link folder must not carry the Win32 verbatim prefix: {folder}"
        );
    }

    #[test]
    fn preflight_renders_the_folder_through_the_verbatim_strip() {
        // `preflight_never_emits_a_verbatim_folder` only bites on Windows,
        // where canonicalize actually produces the prefix. This gate bites
        // everywhere: it fails the moment the URL is rebuilt from a raw
        // `to_string_lossy()` again instead of the shared renderer.
        let src = include_str!("claude_launch.rs");
        let production = src.split("#[cfg(test)]").next().expect("production source");
        assert!(production.contains(r#"pairs.append_pair("folder", &deep_link_folder_value("#));
        assert!(production.contains("strip_windows_verbatim_prefix"));
    }

    #[test]
    fn preflight_setup_repair_names_missing_install_folder() {
        let missing =
            std::env::temp_dir().join(format!("hq-setup-repair-missing-{}", std::process::id()));
        let url = format!(
            "claude://code/new?q=%2Fsetup&folder={}",
            missing.to_string_lossy().replace(' ', "%20")
        );
        let err = preflight_claude_code_url(&url).expect_err("missing folder must fail");
        assert!(
            err.contains("does not exist"),
            "expected a path-not-found error, got: {err}"
        );
        assert!(
            !err.contains("core/core.yaml"),
            "must not blame missing HQ markers on a folder that is not there: {err}"
        );
    }
}
