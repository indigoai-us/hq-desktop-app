//! Real-npx-cache proof for the HQ-DESKTOP-4K runner-target probe and repair.
//!
//! The unit tests in `runner_target` drive a synthetic fixture. This test drives
//! the *actual* npx cache layout produced by the pinned
//! `@indigoai-us/hq-cloud` package, and asserts the whole causal chain the
//! Sentry issue reported:
//!
//! 1. The prewarm/preflight payload (`npx … -- node -e "process.exit(0)"`)
//!    exits 0 against a cache whose runner target has lost its executable bit —
//!    i.e. the shipped gate cannot see the failure at all.
//! 2. The real watcher payload (`npx … hq-sync-runner …`) exits 126 against that
//!    same cache — the observed crash-loop exit.
//! 3. The probe positively reports `NotExecutable` where the preflight reported
//!    success, and the bounded repair restores it.
//! 4. After the repair the real watcher payload no longer exits 126 — the
//!    self-heal genuinely unwedges the spawn the daemon performs.
//!
//! `#[ignore]` because it downloads from the npm registry and shells out to
//! npx: it is opt-in (`cargo test -p hq-desktop-core --test
//! runner_target_real_npx_cache -- --ignored`), never a silent skip. Windows has
//! no POSIX mode bit to clear, so the scenario is POSIX-only by construction.

#![cfg(not(target_os = "windows"))]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use hq_desktop_core::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};
use hq_desktop_core::runner_target::{
    probe_runner_target_in, repair_runner_target_in, RunnerTargetRepair, RunnerTargetState,
};

fn package_spec() -> String {
    format!("--package={HQ_CLOUD_PACKAGE}@{HQ_CLOUD_VERSION}")
}

fn npx(cache: &Path, args: &[&str]) -> std::process::Output {
    Command::new("npx")
        .env("npm_config_cache", cache)
        .args(args)
        .output()
        .expect("npx must be on PATH for this opt-in test")
}

/// The exact payload `prewarm::materialize_hq_cloud_cache` runs.
fn preflight_payload(cache: &Path) -> std::process::Output {
    npx(
        cache,
        &["-y", &package_spec(), "--", "node", "-e", "process.exit(0)"],
    )
}

/// The payload `build_watch_runner_args` actually spawns (argv trimmed to a
/// no-side-effect flag; the exec layer fails long before argument parsing).
fn watcher_payload(cache: &Path) -> std::process::Output {
    npx(cache, &["-y", &package_spec(), RUNNER_BIN, "--help"])
}

fn resolved_runner_target(cache: &Path) -> PathBuf {
    let npx_root = cache.join("_npx");
    let entries = std::fs::read_dir(&npx_root)
        .expect("materialized cache must have an _npx root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.join("node_modules")
                .join(HQ_CLOUD_PACKAGE)
                .join("package.json")
                .is_file()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        entries.len(),
        1,
        "expected exactly one materialized cache entry, got {entries:?}"
    );
    std::fs::canonicalize(
        entries[0]
            .join("node_modules")
            .join(".bin")
            .join(RUNNER_BIN),
    )
    .expect("the .bin shim must resolve to a real target")
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn mode_of(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
#[ignore = "downloads from the npm registry; run with --ignored"]
fn poisoned_npx_cache_reproduces_exit_126_and_the_repair_unwedges_it() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = tmp.path().join("npm-cache");
    std::fs::create_dir_all(&cache).unwrap();

    // Materialize the pinned package exactly as the app's prewarm does.
    let warmed = preflight_payload(&cache);
    assert!(
        warmed.status.success(),
        "cache materialization failed: {}",
        String::from_utf8_lossy(&warmed.stderr)
    );

    let npx_root = cache.join("_npx");
    let target = resolved_runner_target(&cache);
    assert_eq!(
        probe_runner_target_in(&npx_root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        RunnerTargetState::Runnable,
        "a freshly materialized cache must probe as runnable"
    );

    // Poison it the way the reporting machine's cache was poisoned.
    let healthy_mode = mode_of(&target);
    set_mode(&target, healthy_mode & !0o111);

    // (1) The shipped preflight still passes — this is the divergence.
    assert!(
        preflight_payload(&cache).status.success(),
        "the preflight payload must still exit 0 against the poisoned cache; \
         if this fails, the preflight/spawn divergence no longer exists"
    );

    // (2) The payload the daemon actually spawns is the one that fails.
    let poisoned_run = watcher_payload(&cache);
    assert_eq!(
        poisoned_run.status.code(),
        Some(126),
        "expected the observed HQ-DESKTOP-4K exit 126, stderr: {}",
        String::from_utf8_lossy(&poisoned_run.stderr)
    );
    assert!(
        String::from_utf8_lossy(&poisoned_run.stderr)
            .to_ascii_lowercase()
            .contains("permission denied"),
        "expected the reported exec-permission stderr class"
    );

    // (3) The probe sees what the preflight could not.
    assert_eq!(
        probe_runner_target_in(&npx_root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        RunnerTargetState::NotExecutable
    );
    assert_eq!(
        repair_runner_target_in(&npx_root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        RunnerTargetRepair::Restored
    );
    assert_eq!(
        probe_runner_target_in(&npx_root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        RunnerTargetState::Runnable
    );

    // (4) The self-heal actually unwedges the real spawn.
    let repaired_run = watcher_payload(&cache);
    assert_ne!(
        repaired_run.status.code(),
        Some(126),
        "the repaired cache must no longer fail in npx's exec layer, stderr: {}",
        String::from_utf8_lossy(&repaired_run.stderr)
    );
}
