//! Health of HQ's managed ("private") Node toolchain.
//!
//! The app ships its own Node under the managed toolchain directory and puts
//! it first on [`crate::paths::child_path`]. When that directory is
//! provisioned but its `node` executable is missing, nothing complains: the
//! runner's `env node` simply resolves to whatever else is on PATH. On one
//! reported machine that was a nvm-era Node 8, which sits below the runner's
//! floor, so every foreground sync and every 30-second daemon cycle bailed
//! with "Node too old" while the user's real Node was v24 and working fine.
//!
//! Classifying the toolchain is what lets the preflight tell those two very
//! different situations apart:
//!
//! * [`ManagedToolchain::NotProvisioned`] — HQ never installed a Node here, so
//!   falling back to the machine's own Node is correct and a too-old one is
//!   the user's to fix.
//! * [`ManagedToolchain::Incomplete`] — HQ installed a Node here and it is
//!   gone. Falling back is a silent downgrade, and the repair is HQ's job.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::paths;

/// State of the Node runtime HQ installs and owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedToolchain {
    /// No managed toolchain directory exists on this machine.
    NotProvisioned,
    /// A toolchain directory exists but its Node executable is missing.
    Incomplete { expected_node: PathBuf },
    /// The managed Node executable is present.
    Present { node: PathBuf },
}

/// Ownership-aware state used only when diagnosing a failed CLI spawn.
///
/// Unlike [`ManagedToolchain`], this never treats an unreadable path as an
/// absent path.  It keeps the existing sync-preflight classification stable
/// while giving the reporting path enough information to avoid silencing an
/// HQ-owned repair case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedRuntime {
    NotProvisioned,
    Incomplete { expected_node: PathBuf },
    Present { node: PathBuf },
    PresentMissingNpx { expected_npx: PathBuf },
    Unknown { reason: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathState {
    Present,
    Absent,
}

/// Use metadata instead of `Path::is_file`/`is_dir`, which turns every I/O
/// error into `false`. Only a path that is absent both when followed and when
/// inspected as a link is verified absent; type mismatches, dangling links,
/// and every non-NotFound error keep ownership unknown.
fn inspect_path(
    path: &Path,
    accepts: impl FnOnce(&Metadata) -> bool,
) -> Result<PathState, &'static str> {
    match std::fs::metadata(path) {
        Ok(metadata) if accepts(&metadata) => Ok(PathState::Present),
        Ok(_) => Err("path-uninspectable"),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match std::fs::symlink_metadata(path) {
                Ok(_) => Err("path-uninspectable"),
                Err(link_error) if link_error.kind() == ErrorKind::NotFound => {
                    Ok(PathState::Absent)
                }
                Err(_) => Err("path-uninspectable"),
            }
        }
        Err(_) => Err("path-uninspectable"),
    }
}

/// Classify managed runtime ownership for the spawn-failure diagnosis path.
///
/// Existing callers intentionally continue using [`classify`] and
/// [`classify_roots`], whose behavior is preserved for sync preflight.
pub fn classify_runtime() -> ManagedRuntime {
    let roots = match paths::managed_toolchain_roots_checked() {
        Ok(roots) => roots,
        Err(error) => {
            return ManagedRuntime::Unknown {
                reason: error.reason,
            }
        }
    };
    classify_runtime_roots(&roots)
}

fn classify_runtime_roots(roots: &[PathBuf]) -> ManagedRuntime {
    let mut missing_node: Option<PathBuf> = None;
    let mut missing_npx: Option<PathBuf> = None;

    for root in roots {
        match inspect_path(root, Metadata::is_dir) {
            Ok(PathState::Present) => {}
            Ok(PathState::Absent) => continue,
            Err(reason) => return ManagedRuntime::Unknown { reason },
        }

        let node_dir = paths::managed_node_dir_in(root);
        let node = paths::managed_node_executable_in(root);
        let node_dir_state = match inspect_path(&node_dir, Metadata::is_dir) {
            Ok(state) => state,
            Err(reason) => return ManagedRuntime::Unknown { reason },
        };
        let node_state = match inspect_path(&node, Metadata::is_file) {
            Ok(state) => state,
            Err(reason) => return ManagedRuntime::Unknown { reason },
        };

        if node_state == PathState::Present {
            let npx = paths::managed_npx_executable_in(root);
            match inspect_path(&npx, Metadata::is_file) {
                Ok(PathState::Present) => return ManagedRuntime::Present { node },
                Ok(PathState::Absent) if missing_npx.is_none() => missing_npx = Some(npx),
                Ok(PathState::Absent) => {}
                Err(reason) => return ManagedRuntime::Unknown { reason },
            }
        } else if node_dir_state == PathState::Present && missing_node.is_none() {
            missing_node = Some(node);
        }
    }

    match (missing_npx, missing_node) {
        (Some(expected_npx), _) => ManagedRuntime::PresentMissingNpx { expected_npx },
        (None, Some(expected_node)) => ManagedRuntime::Incomplete { expected_node },
        (None, None) => ManagedRuntime::NotProvisioned,
    }
}

impl ManagedToolchain {
    /// Where the managed Node executable *should* be, for the one state where
    /// that is a defect worth naming. `None` for every other state so callers
    /// can't accidentally report a path that is either fine or was never
    /// expected to exist.
    pub fn missing_node(&self) -> Option<&Path> {
        match self {
            Self::Incomplete { expected_node } => Some(expected_node.as_path()),
            Self::NotProvisioned | Self::Present { .. } => None,
        }
    }
}

/// Classify the managed toolchain on this machine.
pub fn classify() -> ManagedToolchain {
    classify_roots(&paths::managed_toolchain_roots())
}

/// Classify a specific set of toolchain roots, most-canonical first.
///
/// A usable Node in any root wins, because that is the one the child PATH will
/// find. Otherwise the first root with a Node *directory* is the one whose
/// missing executable gets reported.
///
/// The footprint has to be the `node` directory rather than the toolchain root:
/// the root is shared with HQ's managed git and rsync, and on Windows Node is
/// normally installed through Winget or Scoop and never lands under the root at
/// all. Keying off the root would report a missing HQ Node on any machine that
/// merely has managed git — inverting the blame this whole module exists to get
/// right.
pub fn classify_roots(roots: &[PathBuf]) -> ManagedToolchain {
    let mut missing: Option<PathBuf> = None;

    for root in roots {
        let node = paths::managed_node_executable_in(root);
        if node.is_file() {
            return ManagedToolchain::Present { node };
        }
        if missing.is_none() && paths::managed_node_dir_in(root).is_dir() {
            missing = Some(node);
        }
    }

    match missing {
        Some(expected_node) => ManagedToolchain::Incomplete { expected_node },
        None => ManagedToolchain::NotProvisioned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_node(root: &Path) -> PathBuf {
        let node = paths::managed_node_executable_in(root);
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(&node, b"#!/bin/sh\n").unwrap();
        node
    }

    #[test]
    fn no_toolchain_directory_is_not_provisioned() {
        let tmp = tempfile::TempDir::new().unwrap();
        let absent = tmp.path().join("never-installed");
        assert_eq!(
            classify_roots(&[absent]),
            ManagedToolchain::NotProvisioned,
            "a machine HQ never installed Node on must not be reported as broken"
        );
    }

    #[test]
    fn installed_toolchain_with_node_is_present() {
        let tmp = tempfile::TempDir::new().unwrap();
        let node = write_node(tmp.path());
        assert_eq!(
            classify_roots(&[tmp.path().to_path_buf()]),
            ManagedToolchain::Present { node }
        );
    }

    #[test]
    fn empty_toolchain_directory_is_incomplete() {
        // REGRESSION (B3): the reported machine had a toolchain directory whose
        // `node/bin` was empty since first install. That must be diagnosable,
        // not silently papered over by whatever Node is on PATH.
        let tmp = tempfile::TempDir::new().unwrap();
        let node = paths::managed_node_executable_in(tmp.path());
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();

        let state = classify_roots(&[tmp.path().to_path_buf()]);
        assert_eq!(
            state,
            ManagedToolchain::Incomplete {
                expected_node: node
            }
        );
        assert!(state.missing_node().is_some());
    }

    #[test]
    fn a_toolchain_holding_only_git_never_claims_a_missing_node() {
        // The toolchain root is shared with HQ's managed git and rsync, and on
        // Windows Node is normally installed via Winget/Scoop and never lands
        // under the root. Blaming HQ's Node because managed git exists would
        // invert the diagnosis on a large share of machines.
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("git").join("bin")).unwrap();

        assert_eq!(
            classify_roots(&[tmp.path().to_path_buf()]),
            ManagedToolchain::NotProvisioned
        );
    }

    #[test]
    fn a_usable_node_in_a_later_root_wins_over_an_empty_earlier_one() {
        // Windows keeps a legacy `Indigo HQ` root alongside the canonical
        // `IndigoHQ` one; the PATH finds whichever actually holds a Node.
        let tmp = tempfile::TempDir::new().unwrap();
        let empty = tmp.path().join("canonical");
        let populated = tmp.path().join("legacy");
        std::fs::create_dir_all(paths::managed_node_dir_in(&empty)).unwrap();
        let node = write_node(&populated);

        assert_eq!(
            classify_roots(&[empty, populated]),
            ManagedToolchain::Present { node }
        );
    }

    #[test]
    fn missing_node_is_only_reported_for_an_incomplete_toolchain() {
        let tmp = tempfile::TempDir::new().unwrap();
        let node = write_node(tmp.path());
        assert!(ManagedToolchain::Present { node }.missing_node().is_none());
        assert!(ManagedToolchain::NotProvisioned.missing_node().is_none());
    }

    #[test]
    fn runtime_diagnosis_requires_a_managed_npx_alongside_managed_node() {
        let tmp = tempfile::TempDir::new().unwrap();
        let node = write_node(tmp.path());
        let expected_npx = paths::managed_npx_executable_in(tmp.path());
        assert_eq!(
            classify_runtime_roots(&[tmp.path().to_path_buf()]),
            ManagedRuntime::PresentMissingNpx {
                expected_npx: expected_npx.clone(),
            },
            "a managed Node without its managed npx is HQ-owned corruption"
        );

        std::fs::write(&expected_npx, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            classify_runtime_roots(&[tmp.path().to_path_buf()]),
            ManagedRuntime::Present { node }
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_diagnosis_keeps_uninspectable_paths_unknown() {
        // `/dev/null/node` fails metadata with NotADirectory.  It must never
        // be collapsed into the NotProvisioned user-owned state.
        assert_eq!(
            classify_runtime_roots(&[PathBuf::from("/dev/null")]),
            ManagedRuntime::Unknown {
                reason: "path-uninspectable",
            }
        );
    }

    #[test]
    fn runtime_diagnosis_keeps_a_wrong_type_managed_root_unknown() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("toolchain");
        std::fs::write(&root, b"not a directory").unwrap();

        assert_eq!(
            classify_runtime_roots(&[root]),
            ManagedRuntime::Unknown {
                reason: "path-uninspectable",
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_diagnosis_keeps_a_dangling_managed_root_unknown() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("toolchain");
        symlink(tmp.path().join("missing-toolchain"), &root).unwrap();

        assert_eq!(
            classify_runtime_roots(&[root]),
            ManagedRuntime::Unknown {
                reason: "path-uninspectable",
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_diagnosis_keeps_a_dangling_managed_node_dir_unknown() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("toolchain");
        std::fs::create_dir(&root).unwrap();
        symlink(
            tmp.path().join("missing-node"),
            paths::managed_node_dir_in(&root),
        )
        .unwrap();

        assert_eq!(
            classify_runtime_roots(&[root]),
            ManagedRuntime::Unknown {
                reason: "path-uninspectable",
            }
        );
    }
}
