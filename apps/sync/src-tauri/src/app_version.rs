//! The running app's version, resolved at runtime.
//!
//! The prebuilt shell is compiled once and reused across releases, so the
//! compile-time `env!("APP_VERSION")` / `CARGO_PKG_VERSION` /
//! `package_info().version` are the *shell's* build version, not the release
//! being shipped. Every app-version read goes through here instead. Source
//! order (stamped Info.plist → `Resources/version.json` → compile-time) lives
//! in `hq_desktop_core::runtime_version`.

use hq_desktop_core::runtime_version;

/// The compile-time version, used only when nothing was stamped at assemble
/// time (`tauri dev`, `cargo run`, unit tests).
pub const COMPILE_TIME: &str = env!("APP_VERSION");

/// The running app's version string (resolved once per process).
pub fn current() -> &'static str {
    runtime_version::resolve_app_version(
        runtime_version::resources_dir_from_current_exe().as_deref(),
        COMPILE_TIME,
    )
}

/// Which source [`current`] came from.
pub fn source() -> runtime_version::VersionSource {
    runtime_version::resolve_app_version_with_source(
        runtime_version::resources_dir_from_current_exe().as_deref(),
        COMPILE_TIME,
    )
    .1
}

/// Parse a version string as SemVer, falling back to the compile-time
/// version. The resolver only returns plausible versions, so the fallback
/// only guards against a stamp that is not strict SemVer.
pub fn parse_or_compile_time(version: &str) -> semver::Version {
    semver::Version::parse(version).unwrap_or_else(|_| {
        semver::Version::parse(COMPILE_TIME).expect("APP_VERSION is valid SemVer")
    })
}

/// [`current`] as SemVer — what `app.package_info().version` used to give
/// callers. `main` also writes this into Tauri's `PackageInfo` so the updater
/// plugin's own "current version" matches.
pub fn semver() -> semver::Version {
    parse_or_compile_time(current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_time_fallback_is_valid_semver() {
        assert!(semver::Version::parse(COMPILE_TIME).is_ok());
    }

    #[test]
    fn non_semver_stamp_falls_back_to_compile_time() {
        assert_eq!(parse_or_compile_time("1.2.3").to_string(), "1.2.3");
        assert_eq!(parse_or_compile_time("1.2").to_string(), COMPILE_TIME);
    }

    #[test]
    fn unstamped_test_binary_reports_compile_time_version() {
        // Test binaries run from target/*/deps with no Info.plist or
        // version.json beside them.
        if std::env::var_os("HQ_APP_VERSION").is_none() {
            assert_eq!(current(), COMPILE_TIME);
            assert_eq!(source(), runtime_version::VersionSource::CompileTime);
        }
    }
}
