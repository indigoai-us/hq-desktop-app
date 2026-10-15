//! First-launch install of the hq-cli bundled inside the macOS app (US-006).
//!
//! The app ships `Resources/hq-cli/darwin-<arch>/`: hq-cli plus the pinned
//! Node runtime, with a manifest of per-file checksums. On launch, before the
//! lifecycle decides which screen to show, [`ensure_on_launch`] verifies the
//! bundle for this machine's arch and copies it into the managed toolchain
//! (see `hq_desktop_core::bundled_hq_cli`). `hq --version` then works offline.
//!
//! The result is recorded once per launch. The install queue reads it to mark
//! the hq-cli item `bundled`; a missing or bad bundle leaves the queue on the
//! registry install. The status is diagnostic for the lifecycle: it never
//! changes the lifecycle state (see the v0.10.259 regression note in
//! `lifecycle.rs`).

use std::path::Path;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

#[cfg(not(windows))]
use hq_desktop_core::bundled_hq_cli::{self as core_bundle, InstallOutcome, InstallPaths};
#[cfg(not(windows))]
use hq_desktop_core::cli_update_lock::{acquire_cli_update_lock_in, CliUpdateLockAttempt};

const LOG_TAG: &str = "bundled-hq-cli";
const LOCK_TOOL: &str = "hq-desktop-app-bundled-cli";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundledStatus {
    /// The bundle was verified and copied into the toolchain on this launch.
    Installed { version: String },
    /// The same bundle was already installed.
    AlreadyInstalled { version: String },
    /// A newer hq-cli from the updater was installed and left in place.
    KeptExisting { existing_version: String },
    /// No usable bundle; hq-cli comes from the registry install.
    Fallback { code: &'static str, reason: String },
}

impl BundledStatus {
    /// The hq-cli version the bundle provides, when it satisfies hq-cli.
    pub fn satisfied_version(&self) -> Option<&str> {
        match self {
            BundledStatus::Installed { version } | BundledStatus::AlreadyInstalled { version } => {
                Some(version)
            }
            BundledStatus::KeptExisting { existing_version } => Some(existing_version),
            BundledStatus::Fallback { .. } => None,
        }
    }

    fn mode(&self) -> &'static str {
        match self {
            BundledStatus::Installed { .. } | BundledStatus::AlreadyInstalled { .. } => "bundled",
            BundledStatus::KeptExisting { .. } => "bundled_kept_existing",
            BundledStatus::Fallback { .. } => "registry_fallback",
        }
    }
}

static STATUS: OnceLock<BundledStatus> = OnceLock::new();

/// This launch's result, once [`ensure_on_launch`] has run.
pub fn status() -> Option<&'static BundledStatus> {
    STATUS.get()
}

/// `(ready, mode)` for lifecycle logs and Sentry tags. Diagnostics only.
pub fn bundled_hq_cli_diagnostics() -> (bool, &'static str) {
    diagnostics_for(status())
}

fn diagnostics_for(status: Option<&BundledStatus>) -> (bool, &'static str) {
    match status {
        None => (false, "bundled_pending"),
        Some(status) => (status.satisfied_version().is_some(), status.mode()),
    }
}

/// Verify and install the bundle for this launch. Synchronous: it runs before
/// the lifecycle probes so they see the installed `hq`. The common relaunch
/// takes the no-hash fast path.
pub fn ensure_on_launch(app: &AppHandle) {
    if STATUS.get().is_some() {
        return;
    }
    let started = std::time::Instant::now();
    let result = run_on_launch(app);
    crate::util::logfile::log(
        LOG_TAG,
        &format!(
            "status={:?} elapsed_ms={}",
            result,
            started.elapsed().as_millis()
        ),
    );
    let _ = STATUS.set(result);
}

#[cfg(windows)]
fn run_on_launch(_app: &AppHandle) -> BundledStatus {
    BundledStatus::Fallback {
        code: "unsupported_platform",
        reason: "the bundled hq-cli ships on macOS only".into(),
    }
}

#[cfg(not(windows))]
fn run_on_launch(app: &AppHandle) -> BundledStatus {
    let allowed = crate::scratch_build::launch_side_effect_allowed("bundled hq-cli install");
    let resource_root = app.path().resource_dir().ok().map(|dir| dir.join("hq-cli"));
    let Some(home) = dirs::home_dir() else {
        return BundledStatus::Fallback {
            code: "no_home",
            reason: "no home folder".into(),
        };
    };
    let lock_dir = match hq_desktop_core::cli_update_lock::default_lock_dir() {
        Ok(dir) => dir,
        Err(reason) => {
            return BundledStatus::Fallback {
                code: "lock_error",
                reason,
            }
        }
    };
    ensure_blocking(resource_root.as_deref(), &home, &lock_dir, allowed)
}

#[cfg(not(windows))]
fn install_paths(home: &Path) -> InstallPaths {
    let toolchain_dir = hq_desktop_core::paths::managed_toolchain_dir_in(home);
    let npm_prefix = hq_desktop_core::paths::managed_npm_prefix_in(&toolchain_dir);
    InstallPaths {
        toolchain_dir,
        npm_prefix,
    }
}

/// The launch decision with every machine path injected, so tests run against
/// a temp home and lock dir.
#[cfg(not(windows))]
pub(crate) fn ensure_blocking(
    resource_root: Option<&Path>,
    home: &Path,
    lock_dir: &Path,
    allowed: bool,
) -> BundledStatus {
    let fallback = |code: &'static str, reason: String| BundledStatus::Fallback { code, reason };
    if !allowed {
        return fallback("scratch_build", "installs are off in this test build".into());
    }
    let Some(arch) = core_bundle::host_arch() else {
        return fallback("unsupported_arch", std::env::consts::ARCH.into());
    };
    let Some(resource_root) = resource_root.filter(|root| root.is_dir()) else {
        return fallback("bundle_missing", "no hq-cli resource directory".into());
    };
    let paths = install_paths(home);
    if let Some(outcome) = core_bundle::bundled_install_current(resource_root, arch, &paths) {
        return from_outcome(outcome);
    }
    let _guard = match acquire_cli_update_lock_in(
        lock_dir,
        LOCK_TOOL,
        &crate::app_version::current().to_string(),
    ) {
        Ok(CliUpdateLockAttempt::Acquired(guard)) => guard,
        Ok(CliUpdateLockAttempt::Held { holder }) => return fallback("lock_busy", holder),
        Err(reason) => return fallback("lock_error", reason),
    };
    match core_bundle::ensure_bundled_install(resource_root, arch, &paths) {
        Ok(outcome) => from_outcome(outcome),
        Err(error) => fallback(error.code(), error.to_string()),
    }
}

#[cfg(not(windows))]
fn from_outcome(outcome: InstallOutcome) -> BundledStatus {
    match outcome {
        InstallOutcome::Installed { version } => BundledStatus::Installed { version },
        InstallOutcome::AlreadyInstalled { version } => BundledStatus::AlreadyInstalled { version },
        InstallOutcome::KeptExisting { existing_version } => {
            BundledStatus::KeptExisting { existing_version }
        }
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Copy the parity fixture (written by the build script's manifest helper)
    /// into a temp Resources dir under this host's arch. The fixture is an
    /// arm64 bundle; on x64 the manifest arch is restamped by rewriting it.
    fn resources(temp: &Path) -> PathBuf {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../crates/hq-desktop-core/tests/fixtures/bundled-hq-cli/darwin-arm64");
        let arch = core_bundle::host_arch().unwrap();
        let root = temp.join("Resources/hq-cli");
        let dst = root.join(core_bundle::arch_dir_name(arch));
        fs::create_dir_all(&dst).unwrap();
        for entry in walkdir::WalkDir::new(&fixture).min_depth(1) {
            let entry = entry.unwrap();
            let rel = entry.path().strip_prefix(&fixture).unwrap();
            if entry.file_type().is_dir() {
                fs::create_dir_all(dst.join(rel)).unwrap();
            } else {
                fs::copy(entry.path(), dst.join(rel)).unwrap();
            }
        }
        if arch != "arm64" {
            let manifest = dst.join("manifest.json");
            let raw = fs::read_to_string(&manifest).unwrap();
            fs::write(&manifest, raw.replace("\"arch\": \"arm64\"", &format!("\"arch\": \"{arch}\""))).unwrap();
        }
        root
    }

    fn hq_version(home: &Path) -> String {
        let hq = hq_desktop_core::paths::managed_npm_prefix_in(
            &hq_desktop_core::paths::managed_toolchain_dir_in(home),
        )
        .join("bin/hq");
        let out = std::process::Command::new(hq)
            .arg("--version")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn good_bundle_installs_then_takes_the_fast_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = resources(temp.path());
        let home = temp.path().join("home");
        let locks = temp.path().join("locks");

        let first = ensure_blocking(Some(&root), &home, &locks, true);
        assert_eq!(first, BundledStatus::Installed { version: "0.0.1".into() });
        assert_eq!(hq_version(&home), "0.0.1");
        assert_eq!(diagnostics_for(Some(&first)), (true, "bundled"));

        let second = ensure_blocking(Some(&root), &home, &locks, true);
        assert_eq!(second, BundledStatus::AlreadyInstalled { version: "0.0.1".into() });
        assert!(fs::read_dir(&locks).unwrap().next().is_none(), "lock released");
    }

    #[test]
    fn bad_checksum_falls_back_and_installs_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let root = resources(temp.path());
        let arch = core_bundle::host_arch().unwrap();
        fs::write(
            root.join(core_bundle::arch_dir_name(arch)).join("package/dist/index.js"),
            "tampered\n",
        )
        .unwrap();
        let home = temp.path().join("home");

        let got = ensure_blocking(Some(&root), &home, &temp.path().join("locks"), true);
        assert!(
            matches!(got, BundledStatus::Fallback { code: "bad_checksum", .. }),
            "{got:?}"
        );
        assert_eq!(got.satisfied_version(), None);
        assert_eq!(diagnostics_for(Some(&got)), (false, "registry_fallback"));
        assert!(!home.join("Library").exists());
    }

    #[test]
    fn missing_bundle_falls_back_to_the_registry_queue() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let locks = temp.path().join("locks");
        for root in [None, Some(temp.path().join("Resources/hq-cli"))] {
            let got = ensure_blocking(root.as_deref(), &home, &locks, true);
            assert!(
                matches!(got, BundledStatus::Fallback { code: "bundle_missing", .. }),
                "{got:?}"
            );
            assert_eq!(
                hq_desktop_core::install_queue::hq_cli_bundled_outcome(got.satisfied_version()),
                None,
                "the queue runs the registry install"
            );
        }
        // An empty arch directory set: resource dir exists, arch bundle missing.
        let root = temp.path().join("Resources/hq-cli");
        fs::create_dir_all(&root).unwrap();
        let got = ensure_blocking(Some(&root), &home, &locks, true);
        assert!(
            matches!(got, BundledStatus::Fallback { code: "missing_bundle", .. }),
            "{got:?}"
        );
    }

    #[test]
    fn verified_bundle_marks_the_queue_item_bundled() {
        let temp = tempfile::tempdir().unwrap();
        let root = resources(temp.path());
        let got = ensure_blocking(Some(&root), &temp.path().join("home"), &temp.path().join("locks"), true);
        assert_eq!(
            hq_desktop_core::install_queue::hq_cli_bundled_outcome(got.satisfied_version()),
            Some(hq_desktop_core::install_queue::ItemOutcome::Skipped(
                hq_desktop_core::install_queue::SKIP_BUNDLED.into()
            ))
        );
    }

    #[test]
    fn held_lock_and_scratch_build_fall_back_without_touching_home() {
        let temp = tempfile::tempdir().unwrap();
        let root = resources(temp.path());
        let home = temp.path().join("home");
        let locks = temp.path().join("locks");

        let got = ensure_blocking(Some(&root), &home, &locks, false);
        assert!(matches!(got, BundledStatus::Fallback { code: "scratch_build", .. }));

        let held = match acquire_cli_update_lock_in(&locks, "other-writer", "1.0.0").unwrap() {
            CliUpdateLockAttempt::Acquired(guard) => guard,
            CliUpdateLockAttempt::Held { .. } => panic!("fresh temp lock dir"),
        };
        let got = ensure_blocking(Some(&root), &home, &locks, true);
        assert!(matches!(got, BundledStatus::Fallback { code: "lock_busy", .. }), "{got:?}");
        assert!(!home.join("Library").exists());
        drop(held);
    }

    #[test]
    fn pending_status_is_reported_as_pending() {
        assert_eq!(diagnostics_for(None), (false, "bundled_pending"));
        let kept = BundledStatus::KeptExisting { existing_version: "5.130.0".into() };
        assert_eq!(diagnostics_for(Some(&kept)), (true, "bundled_kept_existing"));
    }
}
