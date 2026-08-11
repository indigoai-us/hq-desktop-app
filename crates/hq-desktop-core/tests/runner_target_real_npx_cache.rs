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
    resolve_runner_target_in, RunnerTargetRepair, RunnerTargetState,
};
use hq_desktop_core::sync_outcome::{classify_runner_fatal_class, RunnerFatalClass};

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

    // ── THIS cluster's exit-127 leg (HQ-DESKTOP-52): the runner bin is MISSING.
    // Delete the .bin shim the daemon execs, leaving the entry resolvable. The
    // preflight stays blind (it never touches the bin), while the payload the
    // daemon actually spawns exits 127 with a not-found stderr line — and after
    // the bounded purge-and-re-materialize, the real spawn is unwedged again.
    let shim = resolve_runner_target_in(&npx_cache_dir().unwrap(), &pinned_package_spec())
        .expect("the re-materialized cache must resolve the runner target");
    std::fs::remove_file(&shim).expect("removing the .bin shim leaves the entry resolvable");
    assert!(
        preflight_payload().status.success(),
        "the preflight payload is blind to a missing runner bin too (same divergence)"
    );
    let missing = watcher_payload();
    assert_eq!(
        missing.status.code(),
        Some(127),
        "expected the observed HQ-DESKTOP-52 exit 127, stderr: {}",
        String::from_utf8_lossy(&missing.stderr)
    );
    let missing_stderr = String::from_utf8_lossy(&missing.stderr).to_ascii_lowercase();
    assert!(
        missing_stderr.contains("no such file") || missing_stderr.contains("not found"),
        "expected the reported exec not-found stderr class, stderr: {missing_stderr}"
    );
    assert_eq!(
        classify_runner_fatal_class(&String::from_utf8_lossy(&missing.stderr)),
        RunnerFatalClass::ExecNotFound,
        "the not-found shell line classifies as exec_not_found"
    );
    assert_eq!(probe_runner_target(), RunnerTargetState::Missing);

    let missing_outcome = ensure_runner_target_runnable();
    assert!(
        missing_outcome.repair.attempted(),
        "a Missing target must trigger the single bounded repair"
    );
    assert_ne!(
        missing_outcome.repair,
        RunnerTargetRepair::ModeRestored,
        "a Missing target is repaired by purge-and-re-materialize, not a mode bit"
    );
    let re_healed = watcher_payload();
    assert_ne!(
        re_healed.status.code(),
        Some(127),
        "the re-materialized cache must no longer fail not-found, stderr: {}",
        String::from_utf8_lossy(&re_healed.stderr)
    );

    // ── npm-relay SHAPE evidence (NOT causal proof for event f2f6c54b): npm
    // relays an arbitrary failing lifecycle status while printing only its own
    // `npm error …` lines, and the candidate classifier now names that shape
    // npm_install_relay instead of `none` — so the NEXT such occurrence
    // self-describes. The exit-190 producer itself stays unknown per the plan.
    let relay_pkg = tmp.path().join("relay-fixture");
    std::fs::create_dir_all(&relay_pkg).unwrap();
    std::fs::write(
        relay_pkg.join("package.json"),
        br#"{"name":"hq-relay-fixture","version":"1.0.0","scripts":{"preinstall":"exit 190"}}"#,
    )
    .unwrap();
    let relay = Command::new("npm")
        .args(["install", "--no-audit", "--no-fund"])
        .current_dir(&relay_pkg)
        .env("npm_config_cache", &cache)
        .output()
        .expect("npm must be on PATH for this opt-in test");
    assert_eq!(
        relay.status.code(),
        Some(190),
        "npm must relay the fixture's lifecycle exit status verbatim, stderr: {}",
        String::from_utf8_lossy(&relay.stderr)
    );
    let relay_stderr = String::from_utf8_lossy(&relay.stderr);
    let mut saw_npm_relay_line = false;
    for line in relay_stderr.lines() {
        let lowered = line.trim_start().to_ascii_lowercase();
        if lowered.starts_with("npm error ") || lowered.starts_with("npm err! ") {
            assert_eq!(
                classify_runner_fatal_class(line),
                RunnerFatalClass::NpmInstallRelay,
                "an npm own-prefixed line must classify as npm_install_relay: {line:?}"
            );
            saw_npm_relay_line = true;
        }
    }
    assert!(
        saw_npm_relay_line,
        "npm must emit at least one npm-error-prefixed line: {relay_stderr}"
    );
}
