//! Runtime app-version resolution for the prebuilt-shell release pipeline
//! (see `scripts/stamp-version.mjs` and `docs/RELEASE.md` "Prebuilt shell").
//!
//! The compiled shell is built once and reused across releases, so the
//! release version is not known at compile time — `env!("APP_VERSION")`
//! (sourced from `package.json` by `build.rs`) would report the shell's
//! *build-time* version, not the version being shipped. `stamp-version.mjs`
//! writes the release version into the bundle at *assemble* time (after the
//! cached shell is downloaded, before signing), and this module is the single
//! place that reads it back. Every app-version read in the desktop app goes
//! through `resolve_app_version` (via the app crate's `app_version` module).
//!
//! Resolution order:
//! 1. `HQ_APP_VERSION` env var — test/dev escape hatch only.
//! 2. macOS: the stamped `CFBundleShortVersionString` in the bundle's
//!    `Contents/Info.plist` (the sibling of `Contents/Resources`). This is
//!    the value macOS itself shows in Finder/About, so it is authoritative.
//! 3. `<resources_dir>/version.json` (`{"version":"X.Y.Z"}`) — the portable
//!    source assemble writes on every platform.
//! 4. The compile-time fallback passed in by the binary
//!    (`env!("APP_VERSION")`) — only for `tauri dev` / `cargo run` / tests,
//!    which never go through the assemble step.
//!
//! A source whose value is empty or not a plausible version is skipped, so a
//! malformed stamp falls through to the next source instead of reporting
//! garbage.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Which source a resolved version came from (for startup logging and tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionSource {
    EnvOverride,
    InfoPlist,
    VersionJson,
    CompileTime,
}

fn plausible_version(v: &str) -> Option<String> {
    let v = v.trim();
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.chars().next().is_some_and(|c| c.is_ascii_digit())
        && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    ok.then(|| v.to_string())
}

/// Extract `CFBundleShortVersionString` from an XML plist's text. A plain
/// key/next-string scan (the same shape `stamp-version.mjs` patches), so no
/// plist dependency is needed.
pub fn short_version_from_info_plist(plist: &str) -> Option<String> {
    let key = "<key>CFBundleShortVersionString</key>";
    let after_key = &plist[plist.find(key)? + key.len()..];
    let open = after_key.find("<string>")?;
    // Only accept a <string> that directly follows the key (whitespace only).
    if !after_key[..open].trim().is_empty() {
        return None;
    }
    let value = &after_key[open + "<string>".len()..];
    let close = value.find("</string>")?;
    plausible_version(&value[..close])
}

/// Extract `version` from the assemble-written `version.json`.
pub fn version_from_json(contents: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(contents).ok()?;
    plausible_version(parsed.get("version")?.as_str()?)
}

fn info_plist_path(resources_dir: &Path) -> Option<PathBuf> {
    // <App>.app/Contents/Resources -> <App>.app/Contents/Info.plist
    resources_dir.parent().map(|contents| contents.join("Info.plist"))
}

/// Resolve without caching. `read_plist` is false off macOS (only macOS
/// bundles carry a stamped Info.plist).
pub fn resolve_from(
    resources_dir: Option<&Path>,
    compile_time_fallback: &str,
    read_plist: bool,
) -> (String, VersionSource) {
    if let Some(v) = std::env::var("HQ_APP_VERSION").ok().as_deref().and_then(plausible_version) {
        return (v, VersionSource::EnvOverride);
    }
    if let Some(dir) = resources_dir {
        if read_plist {
            if let Some(v) = info_plist_path(dir)
                .and_then(|p| std::fs::read_to_string(p).ok())
                .as_deref()
                .and_then(short_version_from_info_plist)
            {
                return (v, VersionSource::InfoPlist);
            }
        }
        if let Some(v) = std::fs::read_to_string(dir.join("version.json"))
            .ok()
            .as_deref()
            .and_then(version_from_json)
        {
            return (v, VersionSource::VersionJson);
        }
    }
    (compile_time_fallback.to_string(), VersionSource::CompileTime)
}

/// Best-effort resource-dir guess from the running executable's own path, for
/// use before a Tauri `AppHandle` exists. macOS bundles put resources at
/// `<App>.app/Contents/Resources` relative to `Contents/MacOS/<exe>`;
/// Windows/NSIS installs place resources next to the exe. Returns `None` if
/// `current_exe()` fails (callers fall through to the compile-time value).
pub fn resources_dir_from_current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        exe_dir.parent().map(|contents| contents.join("Resources"))
    } else {
        Some(exe_dir.to_path_buf())
    }
}

static RESOLVED: OnceLock<(String, VersionSource)> = OnceLock::new();

/// Resolve the running app's version once per process and cache it. The
/// first call wins; later calls return the cached value regardless of their
/// arguments. `compile_time_fallback` should be `env!("APP_VERSION")` from
/// the binary crate (this crate has no build.rs of its own).
pub fn resolve_app_version(resources_dir: Option<&Path>, compile_time_fallback: &str) -> &'static str {
    resolve_app_version_with_source(resources_dir, compile_time_fallback).0.as_str()
}

/// As [`resolve_app_version`], also reporting which source won.
pub fn resolve_app_version_with_source(
    resources_dir: Option<&Path>,
    compile_time_fallback: &str,
) -> &'static (String, VersionSource) {
    RESOLVED.get_or_init(|| {
        resolve_from(resources_dir, compile_time_fallback, cfg!(target_os = "macos"))
    })
}

/// `HQ_APP_VERSION` is process-global; tests in this crate that resolve a
/// version (or set the override) hold this lock.
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use super::TEST_ENV_LOCK as ENV_LOCK;

    const FALLBACK: &str = "0.0.0-fallback";

    fn plist(version: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>{version}</string>\n\t<key>CFBundleVersion</key>\n\t<string>{version}</string>\n</dict>\n</plist>\n"
        )
    }

    /// A fake `<App>.app/Contents/Resources` with optional stamped sources.
    fn bundle(name: &str, plist_version: Option<&str>, json: Option<&str>) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hq-runtime-version-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let resources = root.join("Contents").join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        if let Some(v) = plist_version {
            std::fs::write(root.join("Contents").join("Info.plist"), plist(v)).unwrap();
        }
        if let Some(j) = json {
            std::fs::write(resources.join("version.json"), j).unwrap();
        }
        resources
    }

    fn cleanup(resources: &Path) {
        std::fs::remove_dir_all(resources.parent().unwrap().parent().unwrap()).ok();
    }

    #[test]
    fn stamped_plist_beats_version_json_beats_compile_time() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("HQ_APP_VERSION");

        let all = bundle("all", Some("1.2.3"), Some(r#"{"version":"4.5.6"}"#));
        assert_eq!(
            resolve_from(Some(&all), FALLBACK, true),
            ("1.2.3".to_string(), VersionSource::InfoPlist)
        );
        // Off macOS the plist is not consulted; version.json wins.
        assert_eq!(
            resolve_from(Some(&all), FALLBACK, false),
            ("4.5.6".to_string(), VersionSource::VersionJson)
        );
        cleanup(&all);

        let json_only = bundle("json", None, Some(r#"{"version":"4.5.6"}"#));
        assert_eq!(
            resolve_from(Some(&json_only), FALLBACK, true),
            ("4.5.6".to_string(), VersionSource::VersionJson)
        );
        cleanup(&json_only);

        let empty = bundle("empty", None, None);
        assert_eq!(
            resolve_from(Some(&empty), FALLBACK, true),
            (FALLBACK.to_string(), VersionSource::CompileTime)
        );
        cleanup(&empty);
        assert_eq!(
            resolve_from(None, FALLBACK, true),
            (FALLBACK.to_string(), VersionSource::CompileTime)
        );
    }

    #[test]
    fn malformed_stamps_fall_through_to_the_next_source() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("HQ_APP_VERSION");
        let bad_plist = bundle("badplist", Some(""), Some(r#"{"version":"4.5.6"}"#));
        assert_eq!(
            resolve_from(Some(&bad_plist), FALLBACK, true).1,
            VersionSource::VersionJson
        );
        cleanup(&bad_plist);
        let bad_json = bundle("badjson", None, Some("not json"));
        assert_eq!(
            resolve_from(Some(&bad_json), FALLBACK, true).1,
            VersionSource::CompileTime
        );
        cleanup(&bad_json);
        let garbage = bundle("garbage", None, Some(r#"{"version":"<script>"}"#));
        assert_eq!(
            resolve_from(Some(&garbage), FALLBACK, true).1,
            VersionSource::CompileTime
        );
        cleanup(&garbage);
    }

    #[test]
    fn env_override_wins_over_everything() {
        let _guard = ENV_LOCK.lock().unwrap();
        let all = bundle("env", Some("1.2.3"), Some(r#"{"version":"4.5.6"}"#));
        std::env::set_var("HQ_APP_VERSION", "9.9.9-beta.1");
        assert_eq!(
            resolve_from(Some(&all), FALLBACK, true),
            ("9.9.9-beta.1".to_string(), VersionSource::EnvOverride)
        );
        std::env::remove_var("HQ_APP_VERSION");
        cleanup(&all);
    }

    #[test]
    fn plist_parser_reads_only_the_short_version_string() {
        assert_eq!(short_version_from_info_plist(&plist("0.10.400")).as_deref(), Some("0.10.400"));
        assert_eq!(short_version_from_info_plist("<dict></dict>"), None);
        // A key not directly followed by <string> is rejected.
        assert_eq!(
            short_version_from_info_plist(
                "<key>CFBundleShortVersionString</key><integer>1</integer><string>2.0.0</string>"
            ),
            None
        );
    }
}
