//! Real-registry proof of the HQ-DESKTOP-4K gate, driven through the public
//! entry points production calls.
//!
//! `runner_target_gate.rs` proves the gate against a hand-laid fixture and needs
//! no network. This test proves the same chain against the *actual* npx cache
//! npm produces for the pinned `@indigoai-us/hq-cloud` spec, and adds the two
//! assertions a fixture cannot make:
//!
//! 1. The daemon's shipped preflight payload
//!    (`npx … -- node -e "process.exit(0)"`, what
//!    `prewarm::materialize_hq_cloud_cache` runs) really does exit 0 against a
//!    cache whose runner target has lost its executable bit — so the gate that
//!    was supposed to catch this is blind to it by construction, not by
//!    accident.
//! 2. After the bounded repair, the payload the daemon actually spawns
//!    (`npx … hq-sync-runner …`) no longer exits 126 — i.e. the self-heal
//!    genuinely unwedges the real spawn, not just the probe's opinion of it.
//!
//! `#[ignore]` because it reaches the npm registry and shells out to npx: it is
//! opt-in (`cargo test -p hq-desktop-core --test runner_target_real_npx_cache --
//! --ignored`), never a silent skip. One `#[test]`, like the fixture gate test,
//! because it mutates process-wide environment variables.
//!
//! Windows has no POSIX mode bit to clear, so the scenario is POSIX-only.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use hq_desktop_core::hq_cloud::RUNNER_BIN;
use hq_desktop_core::runner_target::{
    ensure_runner_target_runnable, npx_cache_dir, pinned_package_spec, probe_runner_target,
    resolve_runner_target_in, RunnerTargetState,
};

fn npx(args: &[&str]) -> Output {
    Command::new("npx")
        .args(args)
        .output()
        .expect("npx must be on PATH for this opt-in test")
}

fn package_flag() -> String {
    format!("--package={}", pinned_package_spec())
}

/// The exact payload `prewarm::materialize_hq_cloud_cache` runs.
fn preflight_payload() -> Output {
    npx(&["-y", &package_flag(), "--", "node", "-e", "process.exit(0)"])
}

/// The payload `build_watch_runner_args` spawns. The argv is trimmed to a
/// no-side-effect flag; npx's exec layer fails long before argument parsing.
fn watcher_payload() -> Output {
    npx(&["-y", &package_flag(), RUNNER_BIN, "--help"])
}

fn resolved_target() -> PathBuf {
    let cache_dir = npx_cache_dir().expect("npm_config_cache is set for this test");
    let target = resolve_runner_target_in(&cache_dir, &pinned_package_spec())
        .expect("a materialized cache must resolve the runner target");
    std::fs::canonicalize(target).expect("the .bin shim must resolve to a real file")
}

fn mode_of(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
#[ignore = "reaches the npm registry; run with --ignored"]
fn real_npx_cache_reproduces_exit_126_and_the_gate_unwedges_it() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = tmp.path().join("npm-cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::env::set_var("npm_config_cache", &cache);

    let warmed = preflight_payload();
    assert!(
        warmed.status.success(),
        "cache materialization failed: {}",
        String::from_utf8_lossy(&warmed.stderr)
    );

    let target = resolved_target();
    assert_eq!(
        probe_runner_target(),
        RunnerTargetState::Runnable,
        "a freshly materialized cache must probe as runnable"
    );

    // Poison it the way the reporting machine's cache was poisoned.
    set_mode(&target, mode_of(&target) & !0o111);

    // (1) The shipped preflight is blind to it — this is the divergence.
    assert!(
        preflight_payload().status.success(),
        "the preflight payload must still exit 0 against the poisoned cache; \
         if this fails, the preflight/spawn divergence no longer exists and this \
         test is no longer measuring the reported defect"
    );

    // (2) The payload the daemon actually spawns is the one that fails.
    let poisoned = watcher_payload();
    assert_eq!(
        poisoned.status.code(),
        Some(126),
        "expected the observed HQ-DESKTOP-4K exit 126, stderr: {}",
        String::from_utf8_lossy(&poisoned.stderr)
    );
    assert!(
        String::from_utf8_lossy(&poisoned.stderr)
            .to_ascii_lowercase()
            .contains("permission denied"),
        "expected the reported exec-permission stderr class"
    );

    // (3) The probe sees what the preflight could not.
    assert_eq!(probe_runner_target(), RunnerTargetState::NotExecutable);

    // (4) The pre-spawn gate self-heals it in one bounded attempt.
    let outcome = ensure_runner_target_runnable();
    assert!(outcome.repair.attempted(), "the gate must attempt a repair");
    assert_eq!(outcome.state, RunnerTargetState::Runnable);
    assert!(!outcome.refuses_spawn());

    // (5) And the real spawn is genuinely unwedged, not merely re-probed.
    let repaired = watcher_payload();
    assert_ne!(
        repaired.status.code(),
        Some(126),
        "the repaired cache must no longer fail in npx's exec layer, stderr: {}",
        String::from_utf8_lossy(&repaired.stderr)
    );
}
