#![cfg(unix)]

use hq_desktop_core::lifecycle::{
    classify_lifecycle, require_local_toolchain, require_local_toolchain_for_startup,
    LifecycleInputs, LifecycleState,
};
use hq_desktop_core::paths::{resolve_bin_with_kind, ResolvedProgramKind};
use std::path::{Path, PathBuf};
use std::process::Command;

const CHILD_MODE: &str = "HQ_C167_NODE_RESOLUTION_CHILD";
const EXPECTED_NODE: &str = "HQ_C167_EXPECTED_NODE";

fn set_up_signed_in_inputs() -> LifecycleInputs {
    LifecycleInputs {
        install_completed: true,
        first_run_completed: true,
        had_machine_id: true,
        config_valid: false,
        hq_root_valid: true,
        has_auth: true,
        install_in_progress: false,
        consent_answered: true,
        evidence_unreadable: false,
        hq_root_recorded_by_prior_setup: false,
    }
}

fn write_executable(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn updater_launch_uses_node_from_the_runtime_child_path() {
    if std::env::var_os(CHILD_MODE).is_some() {
        let expected = PathBuf::from(std::env::var_os(EXPECTED_NODE).unwrap());
        let node = resolve_bin_with_kind("node");
        assert_eq!(
            node.kind,
            ResolvedProgramKind::Exe,
            "the setup gate must find the executable Node that child processes receive"
        );
        assert_eq!(PathBuf::from(node.path), expected);
        let verdict = require_local_toolchain(
            classify_lifecycle(set_up_signed_in_inputs()),
            node.kind != ResolvedProgramKind::NotResolved,
        );
        assert_eq!(
            verdict.state,
            LifecycleState::SteadyState,
            "a configured node executable must keep a signed-in setup machine steady"
        );
        return;
    }

    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path().join("home");
    let fake_bin = fixture.path().join("bin");
    let node = home.join(".nvm/versions/node/v22.0.0/bin/node");
    write_executable(&node, "#!/bin/sh\nexit 0\n");
    // The updater's login shell can be unavailable or fail to load user PATH
    // setup. This fake forces the resolver to use the runtime child PATH.
    write_executable(&fake_bin.join("zsh"), "#!/bin/sh\nexit 1\n");

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "updater_launch_uses_node_from_the_runtime_child_path",
            "--nocapture",
        ])
        .env_clear()
        .env("HOME", &home)
        .env("PATH", &fake_bin)
        .env("ZDOTDIR", fixture.path())
        .env(CHILD_MODE, "1")
        .env(EXPECTED_NODE, &node)
        .env("TMPDIR", std::env::var_os("TMPDIR").unwrap_or_default())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated updater resolver failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn a_set_up_machine_still_demotes_when_node_is_absent() {
    let verdict = require_local_toolchain_for_startup(
        classify_lifecycle(set_up_signed_in_inputs()),
        true,
        false,
        false,
    );
    assert_eq!(verdict.state, LifecycleState::NeedsInstall);
}
