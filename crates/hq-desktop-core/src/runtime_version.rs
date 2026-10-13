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

/// The host platform the resource-dir rules are evaluated for. Explicit so
/// every platform's rule is unit-testable from any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostOs {
    MacOs,
    Linux,
    Windows,
}

impl HostOs {
    /// The platform this binary was compiled for.
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::MacOs
        } else if cfg!(target_os = "linux") {
            HostOs::Linux
        } else {
            HostOs::Windows
        }
    }
}

/// Best-effort resource-dir guess from the running executable's own path, for
/// use before a Tauri `AppHandle` exists. macOS bundles put resources at
/// `<App>.app/Contents/Resources` relative to `Contents/MacOS/<exe>`;
/// Windows/NSIS installs place resources next to the exe. Returns `None` if
/// `current_exe()` fails (callers fall through to the compile-time value).
///
/// Linux callers should use [`resources_dir_for_product`] instead: an
/// installed `.deb` keeps resources under `/usr/lib/<productName>`, which this
/// product-agnostic form cannot see, so here Linux resolves to the exe dir.
pub fn resources_dir_from_current_exe() -> Option<PathBuf> {
    resources_dir_for_product("")
}

/// [`resources_dir_from_current_exe`] with the Tauri `productName`, so the
/// Linux package layout (`/usr/lib/<productName>`) is resolved too. macOS and
/// Windows ignore `product_name`.
pub fn resources_dir_for_product(product_name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    resources_dir_from_exe(&exe, product_name)
}

/// Resource dir for the executable at `exe` on the current platform.
pub fn resources_dir_from_exe(exe: &Path, product_name: &str) -> Option<PathBuf> {
    resources_dir_from_exe_on(exe, product_name, HostOs::current())
}

/// Resource dir for the executable at `exe` as `os` would lay it out.
///
/// - macOS: `<exe_dir>/../Resources` (`Contents/MacOS` → `Contents/Resources`).
/// - Linux: `<exe_dir>/../lib/<product_name>` when that directory exists (the
///   `.deb`/AppImage layout Tauri's own `resource_dir` uses for an exe outside
///   a cargo target dir), else `<exe_dir>` (bare `cargo build`, `tauri dev`).
/// - Windows: `<exe_dir>`.
pub fn resources_dir_from_exe_on(exe: &Path, product_name: &str, os: HostOs) -> Option<PathBuf> {
    let exe_dir = exe.parent()?;
    match os {
        HostOs::MacOs => exe_dir.parent().map(|contents| contents.join("Resources")),
        HostOs::Linux => {
            if !product_name.is_empty() {
                if let Some(lib) = exe_dir
                    .parent()
                    .map(|prefix| prefix.join("lib").join(product_name))
                {
                    if lib.is_dir() {
                        return Some(lib);
                    }
                }
            }
            Some(exe_dir.to_path_buf())
        }
        HostOs::Windows => Some(exe_dir.to_path_buf()),
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

    /// A scratch directory tree for exe-relative resource-dir tests.
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hq-runtime-resources-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn linux_resources_dir_is_the_lib_product_dir_of_an_installed_package() {
        // `.deb` layout: /usr/bin/<exe> with resources in /usr/lib/<productName>
        // (Tauri's `resource_dir_from` rule for a non-cargo exe dir).
        let root = scratch("linux-installed");
        let exe = root.join("usr").join("bin").join("hq-sync-menubar");
        let lib = root.join("usr").join("lib").join("HQ");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        assert_eq!(
            resources_dir_from_exe_on(&exe, "HQ", HostOs::Linux),
            Some(lib)
        );
        cleanup(&root);
    }

    #[test]
    fn linux_resources_dir_falls_back_to_the_exe_dir_without_a_lib_dir() {
        // Bare `cargo build` / `tauri dev`: target/release/<exe>, no lib dir.
        let root = scratch("linux-bare");
        let exe_dir = root.join("target").join("release");
        let exe = exe_dir.join("hq-sync-menubar");
        std::fs::create_dir_all(&exe_dir).unwrap();
        assert_eq!(
            resources_dir_from_exe_on(&exe, "HQ", HostOs::Linux),
            Some(exe_dir)
        );
        cleanup(&root);
    }

    #[test]
    fn linux_resources_dir_resolves_inside_a_mounted_appimage() {
        // AppImage layout once mounted: /tmp/.mount_HQxxxx/usr/bin/<exe> with
        // the bundle resources in /tmp/.mount_HQxxxx/usr/lib/<productName>,
        // the same `../lib/<productName>` rule as the installed .deb.
        let root = scratch("linux-appimage").join(".mount_HQabc123");
        let exe = root.join("usr").join("bin").join("hq-sync-menubar");
        let lib = root.join("usr").join("lib").join("HQ");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(lib.join("ui")).unwrap();
        assert_eq!(
            resources_dir_from_exe_on(&exe, "HQ", HostOs::Linux),
            Some(lib)
        );
        cleanup(root.parent().unwrap());
    }

    #[test]
    fn linux_resources_dir_ignores_an_empty_product_name() {
        let root = scratch("linux-no-name");
        let exe = root.join("usr").join("bin").join("hq-sync-menubar");
        std::fs::create_dir_all(root.join("usr").join("lib")).unwrap();
        assert_eq!(
            resources_dir_from_exe_on(&exe, "", HostOs::Linux),
            Some(root.join("usr").join("bin"))
        );
        cleanup(&root);
    }

    #[test]
    fn macos_resources_dir_is_contents_resources_regardless_of_lib_dirs() {
        // No directories are created: the macOS rule is purely path-based.
        let root = PathBuf::from("/Applications/HQ.app");
        let exe = root.join("Contents").join("MacOS").join("HQ");
        assert_eq!(
            resources_dir_from_exe_on(&exe, "HQ", HostOs::MacOs),
            Some(root.join("Contents").join("Resources"))
        );
    }

    #[test]
    fn windows_resources_dir_is_the_exe_dir() {
        let exe = PathBuf::from("C:/Program Files/HQ/HQ.exe");
        assert_eq!(
            resources_dir_from_exe_on(&exe, "HQ", HostOs::Windows),
            Some(PathBuf::from("C:/Program Files/HQ"))
        );
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
