//! Staged, swap-in install of the `@indigoai-us/hq-cli` npm package.
//!
//! An in-place `npm install -g` deletes the live `<prefix>/bin/hq` link (and
//! on Windows the `hq.cmd`/`hq.ps1` shims) before it lays the new package
//! down, so a session that runs `hq` during that window gets
//! "command not found: hq". The updater instead installs into a staging
//! prefix next to the live one, verifies the staged copy, and swaps it in:
//!
//! * The package directory is exchanged with the staged one in a single
//!   atomic call (`renamex_np(RENAME_SWAP)` on macOS,
//!   `renameat2(RENAME_EXCHANGE)` on Linux). The live bin links/shims point at
//!   the package directory by a relative path that does not change, so they
//!   never disappear and resolve to the old or the new package, never to
//!   nothing.
//! * Bin entries the staged install has and the live prefix lacks (or whose
//!   target differs) are written beside the live entry and renamed over it,
//!   which is atomic on every platform.
//! * Where no atomic exchange exists (Windows, or a filesystem that refuses
//!   it), the live package directory is renamed aside and the staged one
//!   renamed in: two back-to-back renames. The shims stay in place the whole
//!   time, so `hq` is always found; a process that starts inside the
//!   two-rename window can fail to load the package and is covered by the
//!   hq-cli update-request wait-and-re-exec path.
//!
//! The package-use lease and update request are held by the caller for the
//! whole stage-verify-swap sequence; nothing here touches them.

use std::path::{Path, PathBuf};

pub const HQ_CLI_PACKAGE_NAME: &str = "@indigoai-us/hq-cli";

/// Bin entry names npm writes for hq-cli, per platform layout.
pub fn hq_cli_bin_entries(windows_layout: bool) -> &'static [&'static str] {
    if windows_layout {
        &[
            "hq",
            "hq.cmd",
            "hq.ps1",
            "hq-auth-refresh",
            "hq-auth-refresh.cmd",
            "hq-auth-refresh.ps1",
        ]
    } else {
        &["hq", "hq-auth-refresh"]
    }
}

/// Directory that holds the global bin links/shims. Unix: `<prefix>/bin`.
/// Windows: the prefix itself.
pub fn npm_global_bin_dir(prefix: &Path, windows_layout: bool) -> PathBuf {
    if windows_layout {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    }
}

/// `<prefix>/lib/node_modules/@indigoai-us/hq-cli` (Unix) or
/// `<prefix>\node_modules\@indigoai-us\hq-cli` (Windows).
pub fn hq_cli_package_dir(prefix: &Path, windows_layout: bool) -> PathBuf {
    let node_modules = if windows_layout {
        prefix.join("node_modules")
    } else {
        prefix.join("lib").join("node_modules")
    };
    node_modules.join("@indigoai-us").join("hq-cli")
}

/// Staging prefix for one update: a hidden sibling directory inside the live
/// prefix, so the staged package is on the same filesystem and can be renamed
/// into place.
pub fn staging_prefix_for(prefix: &Path, nonce: &str) -> PathBuf {
    prefix.join(format!(".hq-cli-staging-{nonce}"))
}

/// The staged hq entry point to run for verification.
pub fn staged_hq_bin(staging: &Path, windows_layout: bool) -> PathBuf {
    let dir = npm_global_bin_dir(staging, windows_layout);
    if windows_layout {
        dir.join("hq.cmd")
    } else {
        dir.join("hq")
    }
}

/// Check the staged install is complete before it is swapped in: the package
/// directory has a readable `package.json` naming hq-cli, every bin entry it
/// declares exists, and the `hq` entry point exists in the staging bin dir.
/// Returns the staged version.
pub fn verify_staged_install(staging: &Path, windows_layout: bool) -> Result<String, String> {
    let package_dir = hq_cli_package_dir(staging, windows_layout);
    let manifest_path = package_dir.join("package.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("read staged {}: {error}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse staged package.json: {error}"))?;
    if manifest.get("name").and_then(|v| v.as_str()) != Some(HQ_CLI_PACKAGE_NAME) {
        return Err("staged package.json does not name @indigoai-us/hq-cli".into());
    }
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .ok_or("staged package.json has no version")?
        .to_string();
    if let Some(bins) = manifest.get("bin").and_then(|v| v.as_object()) {
        for (name, rel) in bins {
            let rel = rel
                .as_str()
                .ok_or_else(|| format!("bin {name} is not a path"))?;
            if !package_dir.join(rel).is_file() {
                return Err(format!("staged bin {name} target {rel} is missing"));
            }
        }
    }
    let entry = staged_hq_bin(staging, windows_layout);
    if std::fs::metadata(&entry).is_err() {
        return Err(format!("staged entry point {} is missing", entry.display()));
    }
    Ok(version)
}

/// How the package directory was swapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapMode {
    /// One atomic exchange; the live path was never empty.
    AtomicExchange,
    /// Two renames back to back (Windows, or exchange unsupported).
    TwoRename,
}

/// Exchange two existing paths atomically. `Ok(false)` means the platform or
/// filesystem has no atomic exchange and nothing was changed.
pub fn exchange_paths(a: &Path, b: &Path) -> std::io::Result<bool> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let ca = CString::new(a.as_os_str().as_bytes())?;
        let cb = CString::new(b.as_os_str().as_bytes())?;
        // SAFETY: both pointers are valid NUL-terminated strings for the call.
        let rc = unsafe { libc::renamex_np(ca.as_ptr(), cb.as_ptr(), libc::RENAME_SWAP) };
        if rc == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOTSUP) | Some(libc::EINVAL) => Ok(false),
            _ => Err(error),
        };
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let ca = CString::new(a.as_os_str().as_bytes())?;
        let cb = CString::new(b.as_os_str().as_bytes())?;
        // SAFETY: both pointers are valid NUL-terminated strings for the call.
        let rc = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                ca.as_ptr(),
                libc::AT_FDCWD,
                cb.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        if rc == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::ENOTSUP) => Ok(false),
            _ => Err(error),
        };
    }
    #[allow(unreachable_code)]
    {
        let _ = (a, b);
        Ok(false)
    }
}

fn swap_package_dir(
    live: &Path,
    staged: &Path,
    windows_layout: bool,
    nonce: &str,
) -> Result<SwapMode, String> {
    if !windows_layout {
        match exchange_paths(live, staged) {
            Ok(true) => return Ok(SwapMode::AtomicExchange),
            Ok(false) => {}
            Err(error) => return Err(format!("exchange package directory: {error}")),
        }
    }
    // Fallback: rename the live package aside, then the staged one in. The
    // staged path ends up holding the old package so the caller cleans up the
    // same way in both modes.
    let parent = live.parent().ok_or("live package dir has no parent")?;
    let aside = parent.join(format!(".hq-cli-previous-{nonce}"));
    std::fs::rename(live, &aside).map_err(|error| format!("move live package aside: {error}"))?;
    if let Err(error) = std::fs::rename(staged, live) {
        // Put the old package back so the live install keeps working.
        let restore = std::fs::rename(&aside, live);
        return Err(format!(
            "move staged package in: {error}{}",
            restore
                .err()
                .map(|e| format!("; restore failed: {e}"))
                .unwrap_or_default()
        ));
    }
    std::fs::rename(&aside, staged)
        .map_err(|error| format!("park previous package for cleanup: {error}"))?;
    Ok(SwapMode::TwoRename)
}

fn bin_entry_matches(live: &Path, staged: &Path) -> bool {
    let (Ok(live_meta), Ok(staged_meta)) = (
        std::fs::symlink_metadata(live),
        std::fs::symlink_metadata(staged),
    ) else {
        return false;
    };
    if staged_meta.file_type().is_symlink() {
        return live_meta.file_type().is_symlink()
            && std::fs::read_link(live).ok() == std::fs::read_link(staged).ok();
    }
    !live_meta.file_type().is_symlink() && std::fs::read(live).ok() == std::fs::read(staged).ok()
}

/// Write `staged` beside `live` and rename it over `live` (atomic replace).
fn replace_bin_entry(live: &Path, staged: &Path, nonce: &str) -> Result<(), String> {
    let parent = live.parent().ok_or("bin entry has no parent")?;
    let name = live
        .file_name()
        .ok_or("bin entry has no name")?
        .to_string_lossy();
    let temp = parent.join(format!(".{name}.hq-swap-{nonce}"));
    let _ = std::fs::remove_file(&temp);
    let meta = std::fs::symlink_metadata(staged)
        .map_err(|error| format!("inspect staged {}: {error}", staged.display()))?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(staged)
            .map_err(|error| format!("read staged link {}: {error}", staged.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &temp)
            .map_err(|error| format!("create {}: {error}", temp.display()))?;
        #[cfg(not(unix))]
        {
            let _ = target;
            return Err(format!("cannot recreate link {} here", staged.display()));
        }
    } else {
        std::fs::copy(staged, &temp)
            .map_err(|error| format!("copy {}: {error}", staged.display()))?;
    }
    std::fs::rename(&temp, live).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("install {}: {error}", live.display())
    })
}

/// Swap a verified staged install into the live prefix. On success the
/// staging directory holds the previous package and is removed. On failure
/// before the package swap, the live install is untouched.
pub fn swap_staged_install(
    live_prefix: &Path,
    staging: &Path,
    windows_layout: bool,
    nonce: &str,
) -> Result<SwapMode, String> {
    let live_pkg = hq_cli_package_dir(live_prefix, windows_layout);
    let staged_pkg = hq_cli_package_dir(staging, windows_layout);
    if !live_pkg.is_dir() {
        return Err(format!("no live package at {}", live_pkg.display()));
    }
    let mode = swap_package_dir(&live_pkg, &staged_pkg, windows_layout, nonce)?;

    // The package is live. Bring bin entries in line with the staged install;
    // identical entries (the normal case) are left alone so they never blink.
    let live_bin = npm_global_bin_dir(live_prefix, windows_layout);
    let staged_bin = npm_global_bin_dir(staging, windows_layout);
    for name in hq_cli_bin_entries(windows_layout) {
        let staged_entry = staged_bin.join(name);
        if std::fs::symlink_metadata(&staged_entry).is_err() {
            continue;
        }
        let live_entry = live_bin.join(name);
        if bin_entry_matches(&live_entry, &staged_entry) {
            continue;
        }
        replace_bin_entry(&live_entry, &staged_entry, nonce)?;
    }
    remove_staging(staging);
    Ok(mode)
}

/// Best-effort removal of a staging prefix.
pub fn remove_staging(staging: &Path) {
    let _ = std::fs::remove_dir_all(staging);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_install(prefix: &Path, windows: bool, version: &str) {
        let pkg = hq_cli_package_dir(prefix, windows);
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(
                r#"{{"name":"@indigoai-us/hq-cli","version":"{version}","bin":{{"hq":"dist/index.js"}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(pkg.join("dist/index.js"), format!("// {version}")).unwrap();
        let bin = npm_global_bin_dir(prefix, windows);
        std::fs::create_dir_all(&bin).unwrap();
        if windows {
            std::fs::write(
                bin.join("hq.cmd"),
                "@\"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*",
            )
            .unwrap();
        } else {
            #[cfg(unix)]
            std::os::unix::fs::symlink(
                "../lib/node_modules/@indigoai-us/hq-cli/dist/index.js",
                bin.join("hq"),
            )
            .unwrap();
        }
    }

    fn live_version(prefix: &Path, windows: bool) -> String {
        let raw = std::fs::read_to_string(hq_cli_package_dir(prefix, windows).join("package.json"))
            .unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["version"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn layouts_match_npm_global_conventions() {
        let p = Path::new("/p");
        assert_eq!(
            hq_cli_package_dir(p, false),
            Path::new("/p/lib/node_modules/@indigoai-us/hq-cli")
        );
        assert_eq!(
            hq_cli_package_dir(p, true),
            Path::new("/p/node_modules/@indigoai-us/hq-cli")
        );
        assert_eq!(npm_global_bin_dir(p, false), Path::new("/p/bin"));
        assert_eq!(npm_global_bin_dir(p, true), Path::new("/p"));
        assert_eq!(staged_hq_bin(Path::new("/s"), true), Path::new("/s/hq.cmd"));
        assert!(staging_prefix_for(p, "x").starts_with(p));
    }

    #[test]
    fn verify_rejects_incomplete_stage() {
        let dir = tempfile::tempdir().unwrap();
        assert!(verify_staged_install(dir.path(), false).is_err());
        write_install(dir.path(), false, "1.2.3");
        std::fs::remove_file(hq_cli_package_dir(dir.path(), false).join("dist/index.js")).unwrap();
        assert!(verify_staged_install(dir.path(), false)
            .unwrap_err()
            .contains("missing"));
    }

    #[test]
    fn verify_accepts_complete_stage_both_layouts() {
        for windows in [false, true] {
            if !windows && !cfg!(unix) {
                continue;
            }
            let dir = tempfile::tempdir().unwrap();
            write_install(dir.path(), windows, "5.345.110");
            assert_eq!(
                verify_staged_install(dir.path(), windows).unwrap(),
                "5.345.110"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_swap_keeps_bin_link_and_installs_new_package() {
        let live = tempfile::tempdir().unwrap();
        write_install(live.path(), false, "1.0.0");
        let staging = staging_prefix_for(live.path(), "t1");
        write_install(&staging, false, "2.0.0");
        let link_before = std::fs::read_link(live.path().join("bin/hq")).unwrap();

        let mode = swap_staged_install(live.path(), &staging, false, "t1").unwrap();

        if cfg!(any(
            target_os = "macos",
            all(target_os = "linux", target_env = "gnu")
        )) {
            assert_eq!(mode, SwapMode::AtomicExchange);
        }
        assert_eq!(live_version(live.path(), false), "2.0.0");
        assert_eq!(
            std::fs::read_link(live.path().join("bin/hq")).unwrap(),
            link_before
        );
        assert_eq!(
            std::fs::read_to_string(live.path().join("bin/hq")).unwrap(),
            "// 2.0.0"
        );
        assert!(!staging.exists(), "staging is cleaned up");
    }

    #[cfg(unix)]
    #[test]
    fn unix_swap_adds_missing_bin_entry_by_rename() {
        let live = tempfile::tempdir().unwrap();
        write_install(live.path(), false, "1.0.0");
        std::fs::remove_file(live.path().join("bin/hq")).unwrap();
        let staging = staging_prefix_for(live.path(), "t2");
        write_install(&staging, false, "2.0.0");
        swap_staged_install(live.path(), &staging, false, "t2").unwrap();
        assert_eq!(
            std::fs::read_to_string(live.path().join("bin/hq")).unwrap(),
            "// 2.0.0"
        );
        let leftovers: Vec<_> = std::fs::read_dir(live.path().join("bin"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("hq-swap"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn windows_layout_swap_keeps_shims_and_uses_two_renames() {
        let live = tempfile::tempdir().unwrap();
        write_install(live.path(), true, "1.0.0");
        let shim_before = std::fs::read(live.path().join("hq.cmd")).unwrap();
        let staging = staging_prefix_for(live.path(), "t3");
        write_install(&staging, true, "2.0.0");

        let mode = swap_staged_install(live.path(), &staging, true, "t3").unwrap();

        assert_eq!(mode, SwapMode::TwoRename);
        assert_eq!(live_version(live.path(), true), "2.0.0");
        assert_eq!(
            std::fs::read(live.path().join("hq.cmd")).unwrap(),
            shim_before
        );
        assert!(!staging.exists());
        let scope = live.path().join("node_modules/@indigoai-us");
        assert_eq!(
            std::fs::read_dir(scope).unwrap().count(),
            1,
            "no parked copy left"
        );
    }

    #[test]
    fn swap_without_live_package_leaves_everything_untouched() {
        let live = tempfile::tempdir().unwrap();
        let staging = staging_prefix_for(live.path(), "t4");
        write_install(&staging, true, "2.0.0");
        assert!(swap_staged_install(live.path(), &staging, true, "t4").is_err());
        assert!(hq_cli_package_dir(&staging, true).exists());
    }

    #[test]
    fn two_rename_failure_restores_live_package() {
        let live = tempfile::tempdir().unwrap();
        write_install(live.path(), true, "1.0.0");
        // Staged package missing: the second rename fails and must roll back.
        let staging = staging_prefix_for(live.path(), "t5");
        let err = swap_package_dir(
            &hq_cli_package_dir(live.path(), true),
            &hq_cli_package_dir(&staging, true),
            true,
            "t5",
        )
        .unwrap_err();
        assert!(err.contains("move staged package in"));
        assert_eq!(live_version(live.path(), true), "1.0.0");
    }
}
