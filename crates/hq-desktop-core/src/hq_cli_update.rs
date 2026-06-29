//! Pure and synchronous support for the HQ CLI update command layer.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;

/// npm package the menubar nags the user to keep current.
pub const HQ_CLI_PACKAGE: &str = "@indigoai-us/hq-cli@latest";

/// Payload emitted to the frontend and returned by `check_hq_cli_update`.
#[derive(Debug, Clone, Serialize)]
pub struct HqCliUpdateInfo {
    /// Locally-installed version (None if `hq` isn't on PATH).
    pub local: Option<String>,
    /// `latest` dist-tag from the npm registry.
    pub latest: String,
}

#[derive(Debug, Deserialize)]
pub struct NpmLatest {
    pub version: String,
}

/// Three-segment numeric semver compare ("X.Y.Z[-pre]"). Pre-release
/// suffixes are dropped before comparison since the npm `latest` tag is
/// always stable. Anything that fails to parse compares as zero — we'd
/// rather under-report an update than crash the checker.
pub fn cmp_semver(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (u64, u64, u64) {
        let core = v.split('-').next().unwrap_or(v);
        let mut parts = core.split('.');
        let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    }
    parse(a).cmp(&parse(b))
}

/// Read `package.json` at `pkg` and return its `version` **iff** the
/// package name is `@indigoai-us/hq-cli`. The name guard lets us walk a
/// binary's ancestor chain and stop only at the *right* package — never a
/// parent workspace's `package.json` that happens to sit above the install.
pub fn version_if_hq_cli(pkg: &Path) -> Option<String> {
    let bytes = std::fs::read(pkg).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if parsed.get("name").and_then(|n| n.as_str()) != Some("@indigoai-us/hq-cli") {
        return None;
    }
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Resolve the installed version by anchoring to the *actual `hq` binary the
/// user runs*. An npm global install lays down `<prefix>/bin/hq` as a symlink
/// into `<prefix>/lib/node_modules/@indigoai-us/hq-cli/<bin script>`, so once
/// we `canonicalize` the resolved path we land *inside* the package tree and
/// can walk `ancestors()` to its `package.json`.
///
/// This is the fix for the prefix-mismatch bug: it does NOT depend on which
/// `npm` the app resolved or what `npm root -g` reports — it reads the
/// version of the binary that's literally on the user's PATH.
pub fn version_from_hq_binary(hq_bin: &Path) -> Option<String> {
    let real = std::fs::canonicalize(hq_bin).ok()?;
    for ancestor in real.ancestors() {
        if let Some(v) = version_if_hq_cli(&ancestor.join("package.json")) {
            return Some(v);
        }
    }
    None
}

/// Parse `hq --version` output into a bare version string. Last-resort only:
/// the CLI's `index.ts` carries a hardcoded `.version("…")` string that can
/// lag the published npm version (same gotcha documented in
/// `util::hq_resolver`), so this may be stale. We still prefer a possibly-
/// stale number over returning None and silently disabling the nag.
pub fn hq_version_string(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let line = s.lines().next()?.trim().to_string();
    let cleaned = line.trim_start_matches('v').trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Resolve the installed `@indigoai-us/hq-cli` version. Returns `None`
/// only when the CLI genuinely isn't installed (or, rarely, is installed
/// but unreadable by every probe — `check_once` Sentry-captures that case).
///
/// Resolution order (first hit wins):
///   1. Binary-anchored — `version_from_hq_binary(resolve_bin("hq"))`.
///      Authoritative and prefix-independent.
///   2. `npm root -g` package.json — retained for non-symlink layouts.
///   3. `hq --version` — last resort (may lag; see `hq_version_string`).
pub fn get_local_version() -> Option<String> {
    // 1. Binary-anchored read — the primary path; fixes the prefix-mismatch
    //    silent-None bug by reading the version of the binary actually on PATH.
    let hq = paths::resolve_bin("hq");
    let hq_installed = hq != "hq";
    if hq_installed {
        if let Some(v) = version_from_hq_binary(Path::new(&hq)) {
            return Some(v);
        }
    }

    // 2. npm global package.json — same canonical source, located via
    //    `npm root -g`. Covers layouts where `hq` isn't a symlink into the
    //    package tree (e.g. a wrapper script).
    let npm = paths::resolve_bin("npm");
    if npm != "npm" {
        if let Some(v) = read_installed_version(&npm, &paths::child_path()) {
            return Some(v);
        }
    }

    // 3. `hq --version` — last resort, but better than silent None for a
    //    user who clearly has the CLI on PATH.
    if hq_installed {
        if let Some(v) = hq_version_string(Path::new(&hq)) {
            return Some(v);
        }
    }

    None
}

/// Read `cliAutoUpdate` directly from menubar.json (untyped) so the background
/// checker never blocks on a typed round-trip and picks up a Settings toggle
/// without a restart. Mirrors `dm_notify::dm_notifications_enabled`. Defaults
/// to true — the app keeps the CLI current unless the user opts out.
pub fn cli_auto_update_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let Ok(contents) = std::fs::read_to_string(dir.join("menubar.json")) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("cliAutoUpdate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// menubar.json key that records the most recent CLI version the user
/// dismissed the "update available" notice for. Read untyped (same leniency
/// as `cli_auto_update_enabled`) so the background loop picks it up without a
/// restart, and written through the untyped-merge path so it survives the
/// typed `save_settings` round-trip.
pub const DISMISSED_VERSION_KEY: &str = "cliUpdateDismissedVersion";

/// The version the user last dismissed the CLI-update notice for, if any.
/// `None` when the key is absent / unreadable — i.e. nothing dismissed, so
/// the notice is free to show.
pub fn dismissed_cli_version() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(DISMISSED_VERSION_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Pure dismissal decision: should the live "update available" banner be
/// suppressed for `latest` given the version the user last `dismissed`?
///
/// Per-version semantics: a dismissal is sticky for the version it was made
/// against and is re-shown only when a **strictly newer** `latest` appears —
/// dismissing 5.38.x stays dismissed until 5.39 (or any greater version) is
/// published. We compare with `cmp_semver` so a dismissed "5.38.2" suppresses
/// "5.38.2" (Equal) but not "5.39.0" (Greater → show again). A newly published
/// version is exactly the fix users are being emailed about, so re-surfacing
/// it once (still dismissible) is the intended non-nagging behavior.
pub fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool {
    match dismissed {
        Some(d) => cmp_semver(latest, d) != std::cmp::Ordering::Greater,
        None => false,
    }
}

/// Whether the live banner should be suppressed for `latest` because the user
/// already dismissed it. Reads the persisted dismissal then applies the pure
/// `suppress_for_dismissal` rule.
pub fn is_cli_update_dismissed(latest: &str) -> bool {
    suppress_for_dismissal(latest, dismissed_cli_version().as_deref())
}

/// Capture a Sentry event when `hq` is installed but every version probe
/// failed. Scrubbed by `sentry_scrub.rs` before send. This is the
/// "detection silently degraded" signal the team triages immediately —
/// the exact class that hid a stale CLI behind a missing banner.
pub fn report_unreadable_version(latest: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "version-unreadable");
            scope.set_tag("latest", latest);
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] hq is installed but its version could not be read \
                 (binary-anchor, npm root, and hq --version all failed)",
                sentry::Level::Warning,
            );
        },
    );
}

/// Whether an npm install failure is the EXPECTED "global npm prefix needs
/// sudo" condition — an `EACCES`/permission-denied against a root-owned prefix
/// (the classic `/usr/local/lib/node_modules`). The menubar app runs as the
/// user and cannot `sudo`, so `npm install -g` can NEVER succeed on these
/// machines; it is a client-side environment fault, not an app/server bug.
pub fn is_prefix_permission_failure(detail: &str) -> bool {
    detail.contains("EACCES") || detail.contains("permission denied")
}

/// Decide whether a CLI-install failure should be reported to Sentry, and with
/// what message. Returns `None` for the expected prefix-permission (EACCES)
/// case — the app already handles it gracefully (the UI falls back to the
/// copy-the-command path and the failure is kept in the local diagnostic log
/// for Connect diagnostics), so an Error-level capture on every auto-update
/// cycle is pure noise (HQ-SYNC-WEB-Y: exit 243, 180 events / 7 users, all
/// EACCES). Returns `Some(message)` for every genuine, unexpected failure
/// (network, disk, npm bugs, any other exit code) — that is the real signal we
/// want to stay loud at Error level.
pub fn install_failure_report(exit_code: Option<i32>, detail: &str) -> Option<String> {
    if is_prefix_permission_failure(detail) {
        return None;
    }
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    Some(format!("[hq-cli-update] install failed (exit {exit_str})"))
}

/// Capture an auto/manual CLI-install failure to Sentry — but only when it is a
/// genuine, unexpected failure (see `install_failure_report`). The expected
/// prefix-permission (EACCES) case is deliberately NOT captured: it floods
/// Sentry with an unactionable Error every auto-update cycle while the user
/// already has the copy-the-command fallback. The npm stderr tail (scrubbed of
/// tokens/home paths by `sentry_scrub`) rides along as the useful signal.
pub fn report_install_failure(exit_code: Option<i32>, detail: &str) {
    let Some(message) = install_failure_report(exit_code, detail) else {
        return;
    };
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("exit_code", exit_str.as_str());
            scope.set_tag("eacces", "false");
            scope.set_extra("npm_stderr", detail.to_string().into());
        },
        || {
            sentry::capture_message(&message, sentry::Level::Error);
        },
    );
}

/// Derive the npm global prefix from the exact `hq` binary the app resolved.
///
/// npm's global layout is `<prefix>/bin/hq` plus
/// `<prefix>/lib/node_modules/@indigoai-us/hq-cli/package.json`. Detection is
/// already anchored to `resolve_bin("hq")`, so the updater must write to that
/// same enclosing prefix or it can install a fresh CLI that the app never
/// executes. Deliberately avoid `canonicalize`: for symlinks we want the
/// symlink's own `<prefix>/bin/hq`, not the package-internal target path.
pub fn npm_prefix_from_hq_bin(hq_bin: &str) -> Option<String> {
    if hq_bin == "hq" {
        return None;
    }
    Path::new(hq_bin)
        .parent()?
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
}

/// Build the argv for the global install. Factored out so the unit test
/// can lock the shape without spawning npm. When we know the prefix that
/// contains the resolved `hq`, pass it explicitly so npm updates the binary
/// the app actually runs instead of npm's unrelated default global prefix.
pub fn install_argv(prefix: Option<&str>) -> Vec<String> {
    let mut argv = vec!["install".to_string(), "-g".to_string()];
    if let Some(prefix) = prefix {
        argv.push("--prefix".to_string());
        argv.push(prefix.to_string());
    }
    argv.push(HQ_CLI_PACKAGE.to_string());
    argv
}

/// Read the version field from the installed package.json inside the npm
/// global prefix. We do this instead of `hq --version` because the CLI's
/// `index.ts` carries a hardcoded `.version("5.5.0")`-style string that
/// has not been kept in sync with the published npm version (same gotcha
/// documented in `util::hq_resolver`). package.json is the canonical source.
///
/// `npm_bin` is the absolute path to the `npm` binary being queried; callers
/// pass the same beefed-up PATH used for child processes so node-backed npm
/// still starts under a Dock-launched app. This intentionally reads npm's
/// default global prefix and is only a fallback for version detection layouts
/// that cannot be resolved from the `hq` binary itself.
pub fn read_installed_version(npm_bin: &str, path: &str) -> Option<String> {
    let out = Command::new(npm_bin)
        .args(["root", "-g"])
        .env("PATH", path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    let pkg_json = std::path::Path::new(&root)
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let bytes = std::fs::read(&pkg_json).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn cmp_semver_compares_numerically_not_lexically() {
        // The whole point of a custom comparator — string compare would
        // say "5.10.0" < "5.2.0" because '1' < '2'.
        assert_eq!(cmp_semver("5.10.0", "5.2.0"), Ordering::Greater);
        assert_eq!(cmp_semver("5.10.10", "5.10.2"), Ordering::Greater);
    }

    #[test]
    fn cmp_semver_equal_and_less() {
        assert_eq!(cmp_semver("5.11.0", "5.11.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("5.12.1", "5.12.2"), Ordering::Less);
    }

    #[test]
    fn cmp_semver_handles_prerelease_suffix() {
        // npm `latest` is stable, but tolerate the suffix instead of
        // returning "no update" when the user is on a -beta or -rc.
        assert_eq!(cmp_semver("5.12.0-beta.1", "5.12.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0-rc.3", "5.12.0"), Ordering::Less);
    }

    /// Lock the npm argv shape so a typo (e.g., dropping `-g`, renaming
    /// the package) can't ship a non-global or wrong-package install.
    #[test]
    fn install_argv_targets_global_hq_cli() {
        let argv = install_argv(None);
        assert_eq!(argv[0], "install");
        assert_eq!(argv[1], "-g");
        assert!(
            argv[2].starts_with("@indigoai-us/hq-cli@"),
            "package arg must target @indigoai-us/hq-cli; got {}",
            argv[2],
        );
        // The banner button is the "update to current" path — pin must
        // resolve to `latest`, not a hardcoded version that would rot.
        assert!(
            argv[2].ends_with("@latest"),
            "package arg must request @latest; got {}",
            argv[2],
        );
    }

    #[test]
    fn install_argv_includes_prefix_when_available() {
        let argv = install_argv(Some("/tmp/hq-prefix"));
        assert_eq!(
            argv,
            vec![
                "install".to_string(),
                "-g".to_string(),
                "--prefix".to_string(),
                "/tmp/hq-prefix".to_string(),
                HQ_CLI_PACKAGE.to_string(),
            ]
        );
        let prefix_flag = argv.iter().position(|arg| arg == "--prefix").unwrap();
        assert_eq!(
            argv.get(prefix_flag + 1),
            Some(&"/tmp/hq-prefix".to_string())
        );
    }

    #[test]
    fn npm_prefix_from_resolved_hq_bin_uses_enclosing_prefix() {
        assert_eq!(
            npm_prefix_from_hq_bin(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
            ),
            Some(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global"
                    .to_string()
            )
        );
        assert_eq!(npm_prefix_from_hq_bin("hq"), None);
    }

    // The exact npm stderr behind HQ-SYNC-WEB-Y (exit 243, 7 users): a root-
    // owned global prefix the menubar app can't write to without sudo.
    const REAL_EACCES_STDERR: &str = "npm error code EACCES\n\
        npm error syscall mkdir\n\
        npm error path /usr/local/lib/node_modules/@indigoai-us\n\
        npm error errno -13\n\
        npm error Error: EACCES: permission denied, mkdir \
        '/usr/local/lib/node_modules/@indigoai-us'";

    #[test]
    fn prefix_permission_failure_detects_the_sudo_case() {
        assert!(is_prefix_permission_failure(REAL_EACCES_STDERR));
        assert!(is_prefix_permission_failure("npm error EACCES"));
        assert!(is_prefix_permission_failure(
            "Error: permission denied, mkdir '/opt/homebrew/lib/node_modules'"
        ));
    }

    #[test]
    fn prefix_permission_failure_false_for_genuine_failures() {
        // Genuine, unexpected failures must NOT be mistaken for the expected
        // sudo case — they are the real signal we keep capturing.
        assert!(!is_prefix_permission_failure(
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT"
        ));
        assert!(!is_prefix_permission_failure(
            "npm error code ENOSPC: no space left on device"
        ));
        assert!(!is_prefix_permission_failure(""));
    }

    #[test]
    fn install_failure_report_skips_expected_eacces() {
        // HQ-SYNC-WEB-Y: the exit-243 EACCES flood must NOT be reported to
        // Sentry — it's an expected client-side environment fault (root-owned
        // npm prefix needs sudo) with a copy-the-command UI fallback. `None`
        // here is exactly what makes `report_install_failure` skip the capture.
        assert_eq!(install_failure_report(Some(243), REAL_EACCES_STDERR), None);
    }

    #[test]
    fn install_failure_report_captures_genuine_failures() {
        // A real, unexpected failure stays loud — `Some(message)` drives the
        // Error-level capture.
        assert_eq!(
            install_failure_report(Some(1), "npm error network ETIMEDOUT"),
            Some("[hq-cli-update] install failed (exit 1)".to_string()),
        );
        // Killed by signal (no exit code) still reports, with the signal label.
        assert_eq!(
            install_failure_report(None, "npm error network ETIMEDOUT"),
            Some("[hq-cli-update] install failed (exit signal/none)".to_string()),
        );
    }

    #[test]
    fn dismissal_suppresses_same_and_older_versions() {
        // Nothing dismissed → always show.
        assert!(!suppress_for_dismissal("5.38.2", None));
        // Dismissed the exact current version → stay hidden.
        assert!(suppress_for_dismissal("5.38.2", Some("5.38.2")));
        // A version older than what was dismissed → also hidden (can't regress
        // the user back into a notice for something they already moved past).
        assert!(suppress_for_dismissal("5.38.1", Some("5.38.2")));
    }

    #[test]
    fn dismissal_clears_when_a_newer_version_appears() {
        // The headline example: dismissing 5.38.x stays dismissed until 5.39.
        assert!(!suppress_for_dismissal("5.39.0", Some("5.38.2")));
        // A patch bump past the dismissed version re-surfaces once (a freshly
        // published fix is exactly what stale users need to see) — still
        // dismissible afterwards.
        assert!(!suppress_for_dismissal("5.38.3", Some("5.38.2")));
        // Numeric, not lexical: 5.41 > 5.9 even though '4' < '9'.
        assert!(!suppress_for_dismissal("5.41.0", Some("5.9.0")));
    }

    #[test]
    fn cmp_semver_missing_segments_default_to_zero() {
        // Don't panic on weird inputs — under-report rather than crash.
        assert_eq!(cmp_semver("5", "5.0.0"), Ordering::Equal);
        assert_eq!(cmp_semver("", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("not-a-version", "0.0.0"), Ordering::Equal);
    }

    #[test]
    fn version_if_hq_cli_requires_matching_name() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // Wrong name → None, even with a version present.
        let wrong = tmp.path().join("wrong.json");
        std::fs::File::create(&wrong)
            .unwrap()
            .write_all(br#"{"name":"left-pad","version":"9.9.9"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&wrong), None);
        // Right name → version.
        let right = tmp.path().join("package.json");
        std::fs::File::create(&right)
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.12.3"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&right), Some("5.12.3".to_string()));
    }

    /// Direct regression test for the prefix-mismatch bug: an `hq` symlink in
    /// one prefix pointing into the package tree in another must still resolve
    /// the installed version, with no dependence on `npm root -g`.
    #[test]
    #[cfg(unix)]
    fn version_from_hq_binary_follows_symlink() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // npm-global-style tree:
        //   <tmp>/lib/node_modules/@indigoai-us/hq-cli/{package.json, bin/hq.js}
        //   <tmp>/bin/hq -> .../hq-cli/bin/hq.js
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("bin")).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.40.1"}"#)
            .unwrap();
        let real_bin = pkg_dir.join("bin/hq.js");
        std::fs::File::create(&real_bin)
            .unwrap()
            .write_all(b"#!/usr/bin/env node\n")
            .unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let link = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real_bin, &link).unwrap();

        assert_eq!(version_from_hq_binary(&link), Some("5.40.1".to_string()));
    }

    /// A bare `hq` (binary not found, resolver returned the literal name) must
    /// not be canonicalized into a bogus version.
    #[test]
    fn version_from_hq_binary_missing_returns_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(
            version_from_hq_binary(&tmp.path().join("does-not-exist/hq")),
            None
        );
    }
}
