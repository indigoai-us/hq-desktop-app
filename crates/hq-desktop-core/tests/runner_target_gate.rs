//! End-to-end proof of the HQ-DESKTOP-4K pre-spawn gate against a real npx
//! cache layout, driven through the same environment resolution production
//! uses (`npm_config_cache` + `HOME`).
//!
//! The fixture reproduces the exact observed state: a materialized
//! `@indigoai-us/hq-cloud` npx entry whose `node_modules/.bin/hq-sync-runner`
//! symlink points at a package script that has lost its executable bit. A
//! bounded local reproduction confirmed that this state passes the daemon's
//! `materialize_hq_cloud_cache()` preflight (`npx … -- node -e "process.exit(0)"`
//! exits 0) while the payload the daemon actually spawns
//! (`npx … hq-sync-runner …`) exits 126 with
//! `sh: …/node_modules/.bin/hq-sync-runner: Permission denied`.
//!
//! This test needs no network: it asserts that the gate *sees* that state and
//! self-heals it, which is the behaviour the base SHA lacks entirely.
//!
//! Everything lives in one `#[test]` on purpose — it mutates process-wide
//! environment variables, and cargo runs tests within a binary in parallel.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use hq_desktop_core::runner_target::{
    ensure_runner_target_runnable, npx_cache_entry_hash, pinned_package_spec, probe_runner_target,
    runner_target_diagnosis, RunnerTargetRepair, RunnerTargetState,
};

/// Lay down the directory shape npm produces for `npx --package=<spec>`.
fn materialize_fixture_cache(cache_root: &Path, script_mode: u32) -> PathBuf {
    let entry = cache_root
        .join("_npx")
        .join(npx_cache_entry_hash(&pinned_package_spec()));
    let package = entry
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cloud")
        .join("dist")
        .join("bin");
    std::fs::create_dir_all(&package).unwrap();

    let script = package.join("sync-runner.js");
    std::fs::write(&script, b"#!/usr/bin/env node\nprocess.exit(0)\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(script_mode)).unwrap();

    let bin = entry.join("node_modules").join(".bin");
    std::fs::create_dir_all(&bin).unwrap();
    let shim = bin.join("hq-sync-runner");
    let _ = std::fs::remove_file(&shim);
    std::os::unix::fs::symlink(&script, &shim).unwrap();
    script
}

#[test]
fn pre_spawn_gate_sees_and_heals_the_poisoned_npx_cache() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_root = tmp.path().join("npm-cache");
    std::fs::create_dir_all(&cache_root).unwrap();
    // The materialization advisory lock lives under the HQ config dir.
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("npm_config_cache", &cache_root);

    // ── 1. The HQ-DESKTOP-4K state: present, but not executable ──────────────
    let script = materialize_fixture_cache(&cache_root, 0o644);
    assert_eq!(
        probe_runner_target(),
        RunnerTargetState::NotExecutable,
        "the gate must resolve the pinned npx entry through the real environment",
    );

    // ── 2. One bounded repair heals it and the spawn proceeds ────────────────
    let outcome = ensure_runner_target_runnable();
    assert_eq!(outcome.state, RunnerTargetState::Runnable);
    assert_eq!(outcome.repair, RunnerTargetRepair::ModeRestored);
    assert!(
        !outcome.refuses_spawn(),
        "a healed target must not stop auto-sync",
    );
    assert_eq!(
        std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o755,
        "the exec bit must be restored on the script the shell actually checks",
    );
    assert_eq!(probe_runner_target(), RunnerTargetState::Runnable);

    // ── 3. A healthy cache is left completely alone ──────────────────────────
    let healthy = ensure_runner_target_runnable();
    assert_eq!(healthy.state, RunnerTargetState::Runnable);
    assert_eq!(
        healthy.repair,
        RunnerTargetRepair::NotAttempted,
        "the repair must not run against a healthy cache",
    );

    // ── 4. An unresolvable cache degrades to today's spawn behaviour ─────────
    std::env::set_var("npm_config_cache", tmp.path().join("nothing-here"));
    let unresolved = ensure_runner_target_runnable();
    assert_eq!(unresolved.state, RunnerTargetState::Unresolved);
    assert_eq!(unresolved.repair, RunnerTargetRepair::NotAttempted);
    assert!(
        !unresolved.refuses_spawn(),
        "an unprobeable cache must never take a working machine's auto-sync offline",
    );

    // ── 5. The refusal diagnosis is user-actionable and leaks no path ────────
    let diagnosis = runner_target_diagnosis(RunnerTargetState::NotExecutable);
    assert!(diagnosis.contains("HQ Sync"));
    assert!(!diagnosis.contains(&tmp.path().display().to_string()));

    std::env::remove_var("npm_config_cache");
    std::env::remove_var("HOME");
}
