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
/// find. Otherwise the first root that exists on disk is the one whose missing
/// Node gets reported — a root directory is the installer's own footprint, so
/// its presence is what distinguishes "HQ's Node vanished" from "HQ never put
/// a Node here".
pub fn classify_roots(roots: &[PathBuf]) -> ManagedToolchain {
    let mut missing: Option<PathBuf> = None;

    for root in roots {
        let node = paths::managed_node_executable_in(root);
        if node.is_file() {
            return ManagedToolchain::Present { node };
        }
        if missing.is_none() && root.is_dir() {
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
        assert_eq!(state, ManagedToolchain::Incomplete { expected_node: node });
        assert!(state.missing_node().is_some());
    }

    #[test]
    fn toolchain_root_without_a_node_subdirectory_is_incomplete() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert!(classify_roots(&[tmp.path().to_path_buf()])
            .missing_node()
            .is_some());
    }

    #[test]
    fn a_usable_node_in_a_later_root_wins_over_an_empty_earlier_one() {
        // Windows keeps a legacy `Indigo HQ` root alongside the canonical
        // `IndigoHQ` one; the PATH finds whichever actually holds a Node.
        let tmp = tempfile::TempDir::new().unwrap();
        let empty = tmp.path().join("canonical");
        let populated = tmp.path().join("legacy");
        std::fs::create_dir_all(&empty).unwrap();
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
}
