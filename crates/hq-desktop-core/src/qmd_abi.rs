//! Health of desktop-installed qmd's native sqlite addon.
//!
//! `qmd --version` does not load `better-sqlite3`. A copy built for another
//! Node ABI therefore looks healthy while `qmd search` / `qmd vsearch` /
//! `qmd update` crash with `ERR_DLOPEN_FAILED`. HQ's managed Node is pinned
//! to ABI 127 (Node 22); a leftover binary compiled for ABI 141 is the
//! reported Vitality Extracts failure.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Outcome of asking the current Node to load qmd's `better-sqlite3` addon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QmdAddonProbe {
    Loads,
    AbiMismatch,
    MissingAddon,
    OtherFailure,
}

/// True when Node refused a native addon because it was built for a different
/// `NODE_MODULE_VERSION` than the running interpreter.
pub fn looks_like_node_abi_mismatch(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("err_dlopen_failed") {
        return true;
    }
    if lower.contains("compiled against a different node.js version") {
        return true;
    }
    lower.contains("node_module_version") && lower.contains("requires node_module_version")
}

/// Locate `@tobilu/qmd`'s package directory from a `qmd` bin/shim path.
///
/// Handles the unix npm-global symlink (`<prefix>/bin/qmd` →
/// `.../node_modules/@tobilu/qmd/...`) and the Windows prefix layout
/// (`<prefix>/qmd.cmd` next to `node_modules/@tobilu/qmd`).
pub fn qmd_package_dir_from_bin(qmd_bin: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(qmd_bin).unwrap_or_else(|_| qmd_bin.to_path_buf());
    for ancestor in resolved.ancestors() {
        if ancestor.file_name().and_then(|s| s.to_str()) != Some("qmd") {
            continue;
        }
        let parent = ancestor.parent()?;
        if parent.file_name().and_then(|s| s.to_str()) == Some("@tobilu") {
            return Some(ancestor.to_path_buf());
        }
    }

    let file_name = resolved.file_name()?.to_string_lossy();
    if !file_name.starts_with("qmd") {
        return None;
    }
    let parent = resolved.parent()?;
    let prefix = if parent.file_name().and_then(|s| s.to_str()) == Some("bin") {
        parent.parent()?
    } else {
        parent
    };
    for rel in ["lib/node_modules/@tobilu/qmd", "node_modules/@tobilu/qmd"] {
        let pkg = prefix.join(rel);
        if pkg.is_dir() {
            return Some(pkg);
        }
    }
    None
}

/// Nested and hoisted locations of `better_sqlite3.node` under a qmd package.
pub fn qmd_better_sqlite3_addon(package_dir: &Path) -> Option<PathBuf> {
    let nested = package_dir
        .join("node_modules")
        .join("better-sqlite3")
        .join("build")
        .join("Release")
        .join("better_sqlite3.node");
    if nested.is_file() {
        return Some(nested);
    }
    let hoisted = package_dir
        .parent()?
        .parent()?
        .join("better-sqlite3")
        .join("build")
        .join("Release")
        .join("better_sqlite3.node");
    if hoisted.is_file() {
        return Some(hoisted);
    }
    None
}

/// Package trees `npm install -g --prefix <prefix> @tobilu/qmd` may create.
pub fn managed_qmd_package_dirs(prefix: &Path) -> [PathBuf; 2] {
    [
        prefix.join("lib/node_modules/@tobilu/qmd"),
        prefix.join("node_modules/@tobilu/qmd"),
    ]
}

pub fn require_addon_eval(addon: &Path) -> String {
    let encoded = serde_json::to_string(&addon.to_string_lossy()).unwrap_or_else(|_| "''".into());
    format!("require({encoded})")
}

pub fn classify_addon_require_output(success: bool, stderr: &str, stdout: &str) -> QmdAddonProbe {
    if success {
        return QmdAddonProbe::Loads;
    }
    let combined = format!("{stderr}\n{stdout}");
    if looks_like_node_abi_mismatch(&combined) {
        QmdAddonProbe::AbiMismatch
    } else {
        QmdAddonProbe::OtherFailure
    }
}

/// Rebuild when the pinned qmd is present but its sqlite addon cannot load
/// under the Node HQ is actually running.
pub fn qmd_needs_rebuild(version_matches_pin: bool, probe: QmdAddonProbe) -> bool {
    version_matches_pin
        && matches!(
            probe,
            QmdAddonProbe::AbiMismatch | QmdAddonProbe::MissingAddon
        )
}

pub fn probe_addon_with_node(node_program: &str, path_env: &str, addon: &Path) -> QmdAddonProbe {
    let mut cmd = Command::new(node_program);
    cmd.arg("-e")
        .arg(require_addon_eval(addon))
        .env("PATH", path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => classify_addon_require_output(
            out.status.success(),
            &String::from_utf8_lossy(&out.stderr),
            &String::from_utf8_lossy(&out.stdout),
        ),
        Err(_) => QmdAddonProbe::OtherFailure,
    }
}

pub fn probe_qmd_bin(qmd_bin: &Path, path_env: &str) -> QmdAddonProbe {
    let Some(pkg) = qmd_package_dir_from_bin(qmd_bin) else {
        return QmdAddonProbe::MissingAddon;
    };
    let Some(addon) = qmd_better_sqlite3_addon(&pkg) else {
        return QmdAddonProbe::MissingAddon;
    };
    probe_addon_with_node("node", path_env, &addon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    const REPORTER_ERROR: &str = "\
The module '.../Indigo HQ/toolchain/npm-global/lib/node_modules/@tobilu/qmd/node_modules/better-sqlite3/build/Release/better_sqlite3.node' \
was compiled against a different Node.js version using NODE_MODULE_VERSION 141. \
This version of Node.js requires NODE_MODULE_VERSION 127.\n\
code: 'ERR_DLOPEN_FAILED'";

    #[test]
    fn reporter_abi_mismatch_is_recognized() {
        assert!(looks_like_node_abi_mismatch(REPORTER_ERROR));
        assert!(looks_like_node_abi_mismatch(
            "Error: NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 127"
        ));
        assert!(!looks_like_node_abi_mismatch("qmd 2.5.3 (facd35e)"));
        assert!(!looks_like_node_abi_mismatch(
            "npm ERR! EACCES permission denied"
        ));
    }

    #[test]
    fn classify_require_output_splits_abi_from_other_failures() {
        assert_eq!(
            classify_addon_require_output(true, "", ""),
            QmdAddonProbe::Loads
        );
        assert_eq!(
            classify_addon_require_output(false, REPORTER_ERROR, ""),
            QmdAddonProbe::AbiMismatch
        );
        assert_eq!(
            classify_addon_require_output(false, "Cannot find module 'better-sqlite3'", ""),
            QmdAddonProbe::OtherFailure
        );
    }

    #[test]
    fn pinned_qmd_with_abi_mismatch_or_missing_addon_needs_rebuild() {
        assert!(qmd_needs_rebuild(true, QmdAddonProbe::AbiMismatch));
        assert!(qmd_needs_rebuild(true, QmdAddonProbe::MissingAddon));
        assert!(!qmd_needs_rebuild(true, QmdAddonProbe::Loads));
        assert!(!qmd_needs_rebuild(true, QmdAddonProbe::OtherFailure));
        assert!(!qmd_needs_rebuild(false, QmdAddonProbe::AbiMismatch));
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlink_layout_resolves_package_and_nested_addon() {
        let tmp = tempfile::tempdir().unwrap();
        let prefix = tmp.path();
        let pkg = prefix.join("lib/node_modules/@tobilu/qmd");
        let addon_dir = pkg.join("node_modules/better-sqlite3/build/Release");
        fs::create_dir_all(&addon_dir).unwrap();
        fs::create_dir_all(pkg.join("bin")).unwrap();
        fs::create_dir_all(prefix.join("bin")).unwrap();
        fs::write(pkg.join("bin/qmd.js"), "module.exports = {}\n").unwrap();
        let addon = addon_dir.join("better_sqlite3.node");
        fs::write(&addon, b"fake").unwrap();
        std::os::unix::fs::symlink(pkg.join("bin/qmd.js"), prefix.join("bin/qmd")).unwrap();

        let found_pkg = qmd_package_dir_from_bin(&prefix.join("bin/qmd")).unwrap();
        assert_eq!(
            found_pkg.canonicalize().unwrap(),
            pkg.canonicalize().unwrap()
        );
        assert_eq!(
            qmd_better_sqlite3_addon(&found_pkg)
                .unwrap()
                .canonicalize()
                .unwrap(),
            addon.canonicalize().unwrap()
        );
    }

    #[test]
    fn windows_prefix_layout_resolves_package_from_cmd_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let prefix = tmp.path();
        let pkg = prefix.join("node_modules/@tobilu/qmd");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(prefix.join("qmd.cmd"), "@echo off\n").unwrap();
        assert_eq!(
            qmd_package_dir_from_bin(&prefix.join("qmd.cmd")).unwrap(),
            pkg
        );
    }

    #[test]
    fn hoisted_better_sqlite3_is_found() {
        let tmp = tempfile::tempdir().unwrap();
        let modules = tmp.path().join("lib/node_modules");
        let pkg = modules.join("@tobilu/qmd");
        let addon_dir = modules.join("better-sqlite3/build/Release");
        fs::create_dir_all(&pkg).unwrap();
        fs::create_dir_all(&addon_dir).unwrap();
        let addon = addon_dir.join("better_sqlite3.node");
        fs::write(&addon, b"fake").unwrap();
        assert_eq!(
            qmd_better_sqlite3_addon(&pkg)
                .unwrap()
                .canonicalize()
                .unwrap(),
            addon.canonicalize().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn stub_node_abi_error_is_classified_as_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let node = tmp.path().join("node");
        fs::write(
            &node,
            "#!/bin/sh\necho \"compiled against a different Node.js version using NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 127\" >&2\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let addon = tmp.path().join("better_sqlite3.node");
        fs::write(&addon, b"fake").unwrap();
        let path = format!("{}:/usr/bin:/bin", tmp.path().display());
        assert_eq!(
            probe_addon_with_node("node", &path, &addon),
            QmdAddonProbe::AbiMismatch
        );
    }
}
