//! Pre-spawn probe (and bounded repair) for the npx-cached runner target.
//!
//! ## Why this exists
//!
//! [`crate::prewarm::materialize_hq_cloud_cache`] proves that npx runs, that the
//! pinned package tree materialized, and that `node` runs — it executes
//! `npx -y --package=<pkg>@<ver> -- node -e "process.exit(0)"`. It never touches
//! `node_modules/.bin/<RUNNER_BIN>`, which is the payload the watch daemon
//! actually spawns. Those are two different payloads against one cache.
//!
//! When the cached runner target exists but has lost its executable bit, the
//! preflight returns `Ok` and the watcher is spawned anyway. npx then fails in
//! its shell exec layer with exit 126 (`Permission denied`) at uptime 0s, the
//! supervisor respawns, and the loop repeats forever with no environmental
//! diagnosis — because the only gate that could have produced one already
//! passed. This module closes that divergence: it inspects the target the
//! daemon is about to run, not a stand-in for it.
//!
//! ## Fixed vocabulary, never environment text
//!
//! [`RunnerTargetState`] is a closed enum and every accessor returns a
//! `&'static str`. No filesystem path, username or npm output can reach a
//! Sentry tag, fingerprint or extra through this module — the same discipline
//! `safe_runner_error_fingerprint_token` applies at the capture seam.
//!
//! ## Best effort, fail open
//!
//! Every ambiguity degrades to [`RunnerTargetState::Unreadable`], which callers
//! must treat as "behave exactly as before this module existed". A probe is a
//! diagnostic; it may never be the reason a machine stops syncing, and it never
//! decides whether a crash is captured.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::hq_cloud::{HQ_CLOUD_PACKAGE, RUNNER_BIN};

/// What the pre-spawn probe positively established about the runner target.
///
/// `Unreadable` is the deliberate catch-all for *every* ambiguity: an
/// unresolvable cache entry, an IO error, disagreeing candidate entries, or a
/// platform where the executable bit carries no meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetState {
    /// The target resolved and is executable.
    Runnable,
    /// The target resolved, exists, and positively is not executable.
    NotExecutable,
    /// The cache entry resolved but the runner shim is absent (or dangling).
    Missing,
    /// Nothing was positively established. Callers must not act on this.
    Unreadable,
}

impl RunnerTargetState {
    /// Stable token for the `runner_exec_target_exists` Sentry extra. Keeps the
    /// pre-existing `"unknown"` vocabulary for the genuinely unprobeable case
    /// rather than inventing a new one.
    pub fn exists_token(self) -> &'static str {
        match self {
            Self::Runnable | Self::NotExecutable => "true",
            Self::Missing => "false",
            Self::Unreadable => "unknown",
        }
    }

    /// Stable token for the `runner_exec_target_executable` Sentry extra.
    pub fn executable_token(self) -> &'static str {
        match self {
            Self::Runnable => "true",
            Self::NotExecutable | Self::Missing => "false",
            Self::Unreadable => "unknown",
        }
    }

    /// Stable, content-safe name for logs.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Runnable => "runnable",
            Self::NotExecutable => "not_executable",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
        }
    }
}

/// What the daemon should do with a probe result before spawning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetDecision {
    /// Proceed with the spawn exactly as before.
    Spawn,
    /// Attempt exactly one bounded repair, then re-probe.
    RepairThenReprobe,
    /// Do not spawn a watcher that can only exit 126 and be hot-respawned.
    RefuseSpawn,
}

/// Outcome of the bounded repair attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetRepair {
    /// The executable bit was restored on the resolved target.
    Restored,
    /// Nothing to repair, or repair is not meaningful on this platform.
    NotAttempted,
    /// A repair was attempted and did not succeed.
    Failed,
}

/// Decide the pre-spawn action for a probe result.
///
/// Only a *positively identified* `NotExecutable` may ever stop a spawn, and
/// only after the single repair attempt has already been made. `Missing` is
/// deliberately not a refusal: an unusual npx layout (a global install, a
/// pnpm/corepack-managed npx, a relocated cache) can produce it on a machine
/// whose watcher would otherwise run fine, and refusing there would convert a
/// working install into a stopped one. Every ambiguous result spawns.
pub fn runner_target_spawn_decision(
    state: RunnerTargetState,
    repair_attempted: bool,
) -> RunnerTargetDecision {
    match state {
        RunnerTargetState::NotExecutable if !repair_attempted => {
            RunnerTargetDecision::RepairThenReprobe
        }
        RunnerTargetState::NotExecutable => RunnerTargetDecision::RefuseSpawn,
        RunnerTargetState::Runnable
        | RunnerTargetState::Missing
        | RunnerTargetState::Unreadable => RunnerTargetDecision::Spawn,
    }
}

/// User-actionable local diagnosis for a refused spawn. Content-safe: it names
/// no path, so it is equally safe in the app log and the popover.
pub fn not_executable_diagnosis() -> String {
    "HQ Sync cannot start auto-sync because its cached sync engine is not executable, \
     and HQ Sync could not restore it. Clear your npm cache (npm cache clean --force), \
     then reopen HQ Sync."
        .to_string()
}

/// Root of npx's per-spec package cache (`<npm cache>/_npx`).
///
/// Honors npm's own `npm_config_cache` override before falling back to the
/// platform default, so a scratch-cache reproduction resolves the same entry
/// the runner would.
pub fn npx_cache_root() -> Option<PathBuf> {
    if let Some(cache) = env_npm_cache() {
        return Some(cache.join("_npx"));
    }
    default_npm_cache_root().map(|cache| cache.join("_npx"))
}

fn env_npm_cache() -> Option<PathBuf> {
    for key in ["npm_config_cache", "NPM_CONFIG_CACHE"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn default_npm_cache_root() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value).join("npm-cache"))
}

#[cfg(not(target_os = "windows"))]
fn default_npm_cache_root() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value).join(".npm"))
}

/// Every `_npx/<hash>` entry that materialized `package`.
///
/// npx keys its cache by a hash of the resolved spec, and that hashing has
/// changed across npm versions, so the hash is never recomputed here. The entry
/// is identified by what it contains instead: a package tree for `package`.
fn candidate_entries(npx_root: &Path, package: &str) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(npx_root)? {
        let path = entry?.path();
        if !path
            .join("node_modules")
            .join(package)
            .join("package.json")
            .is_file()
        {
            continue;
        }
        entries.push(path);
    }
    entries.sort();
    Ok(entries)
}

fn bin_path(entry: &Path, bin: &str) -> PathBuf {
    entry.join("node_modules").join(".bin").join(bin)
}

/// Probe the runner target inside an explicit `_npx` root. Pure with respect to
/// process state, so tests drive it against a fixture cache.
pub fn probe_runner_target_in(npx_root: &Path, package: &str, bin: &str) -> RunnerTargetState {
    let entries = match candidate_entries(npx_root, package) {
        Ok(entries) => entries,
        // A missing/unreadable cache root establishes nothing about the target.
        Err(_) => return RunnerTargetState::Unreadable,
    };
    if entries.is_empty() {
        return RunnerTargetState::Unreadable;
    }

    let mut verdict: Option<RunnerTargetState> = None;
    for entry in entries {
        let state = probe_bin_path(&bin_path(&entry, bin));
        match verdict {
            None => verdict = Some(state),
            // Several pinned specs can coexist in one cache. If they disagree we
            // cannot say which one npx will select, so establish nothing.
            Some(previous) if previous != state => return RunnerTargetState::Unreadable,
            Some(_) => {}
        }
    }
    verdict.unwrap_or(RunnerTargetState::Unreadable)
}

/// Probe the runner target for the pinned HQ package in the ambient npx cache.
pub fn probe_runner_target() -> RunnerTargetState {
    match npx_cache_root() {
        Some(root) => probe_runner_target_in(&root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        None => RunnerTargetState::Unreadable,
    }
}

/// Classify one resolved shim path.
///
/// `metadata` follows symlinks deliberately: npm installs `.bin/<bin>` as a
/// symlink into the package tree, and it is the *target's* mode bit that npx's
/// shell exec honors — that is exactly the bit the observed failure had lost.
#[cfg(not(target_os = "windows"))]
fn probe_bin_path(path: &Path) -> RunnerTargetState {
    use std::os::unix::fs::PermissionsExt;

    match std::fs::metadata(path) {
        Ok(metadata) => {
            if metadata.permissions().mode() & 0o111 != 0 {
                RunnerTargetState::Runnable
            } else {
                RunnerTargetState::NotExecutable
            }
        }
        // Absent, or a dangling symlink — both mean npx has nothing to exec.
        Err(err) if err.kind() == ErrorKind::NotFound => RunnerTargetState::Missing,
        Err(_) => RunnerTargetState::Unreadable,
    }
}

/// Windows has no POSIX mode bit, so executability is never asserted there.
/// Existence is still a fact worth recording, and a present shim yields
/// `Runnable` — which the decision table treats as "spawn", i.e. unchanged
/// behaviour.
#[cfg(target_os = "windows")]
fn probe_bin_path(path: &Path) -> RunnerTargetState {
    let mut saw_error = false;
    for candidate in windows_bin_candidates(path) {
        match std::fs::metadata(&candidate) {
            Ok(_) => return RunnerTargetState::Runnable,
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(_) => saw_error = true,
        }
    }
    if saw_error {
        RunnerTargetState::Unreadable
    } else {
        RunnerTargetState::Missing
    }
}

#[cfg(target_os = "windows")]
fn windows_bin_candidates(path: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![path.to_path_buf()];
    for extension in ["cmd", "exe", "bat", "ps1"] {
        let mut name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        name.push('.');
        name.push_str(extension);
        candidates.push(path.with_file_name(name));
    }
    candidates
}

/// Restore the executable bit on the cached runner target, once.
///
/// Scope guarantees, in order:
/// 1. Acts only on a positively identified `NotExecutable` target.
/// 2. Resolves the symlink and canonicalizes both sides, then refuses unless the
///    real target is contained in the caller-supplied `_npx` root — so a
///    poisoned symlink cannot redirect the chmod outside the npx cache.
/// 3. Adds execute only where read is already permitted (plus owner execute),
///    so a deliberately private mode is never widened.
///
/// Never deletes anything: purging a shared cache tree could destroy a
/// concurrent npx invocation's working directory, and a refused spawn with a
/// user-actionable diagnosis is the safer fallback when the mode restore fails.
#[cfg(not(target_os = "windows"))]
pub fn repair_runner_target_in(npx_root: &Path, package: &str, bin: &str) -> RunnerTargetRepair {
    use std::os::unix::fs::PermissionsExt;

    if probe_runner_target_in(npx_root, package, bin) != RunnerTargetState::NotExecutable {
        return RunnerTargetRepair::NotAttempted;
    }
    let Ok(entries) = candidate_entries(npx_root, package) else {
        return RunnerTargetRepair::Failed;
    };
    let Ok(root) = std::fs::canonicalize(npx_root) else {
        return RunnerTargetRepair::Failed;
    };

    let mut repaired = false;
    for entry in entries {
        let Ok(target) = std::fs::canonicalize(bin_path(&entry, bin)) else {
            return RunnerTargetRepair::Failed;
        };
        if !target.starts_with(&root) {
            return RunnerTargetRepair::Failed;
        }
        let Ok(metadata) = std::fs::metadata(&target) else {
            return RunnerTargetRepair::Failed;
        };
        let mode = metadata.permissions().mode();
        let restored = mode | 0o100 | ((mode & 0o444) >> 2);
        if std::fs::set_permissions(&target, std::fs::Permissions::from_mode(restored)).is_err() {
            return RunnerTargetRepair::Failed;
        }
        repaired = true;
    }

    if repaired {
        RunnerTargetRepair::Restored
    } else {
        RunnerTargetRepair::NotAttempted
    }
}

/// Windows shims carry no mode bit, so there is nothing to restore.
#[cfg(target_os = "windows")]
pub fn repair_runner_target_in(_npx_root: &Path, _package: &str, _bin: &str) -> RunnerTargetRepair {
    RunnerTargetRepair::NotAttempted
}

/// Repair the pinned HQ runner target in the ambient npx cache.
pub fn repair_runner_target() -> RunnerTargetRepair {
    match npx_cache_root() {
        Some(root) => repair_runner_target_in(&root, HQ_CLOUD_PACKAGE, RUNNER_BIN),
        None => RunnerTargetRepair::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE: &str = "@indigoai-us/hq-cloud";
    const BIN: &str = "hq-sync-runner";

    /// Build a fixture with npm's real npx layout: a package tree plus a
    /// `.bin` symlink into it, exactly as the reproduced cache had.
    fn fixture_entry(npx_root: &Path, hash: &str) -> PathBuf {
        let entry = npx_root.join(hash);
        let package_dir = entry.join("node_modules").join(PACKAGE);
        let bin_dir = package_dir.join("dist").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(package_dir.join("package.json"), "{}").unwrap();
        std::fs::write(bin_dir.join("sync-runner.js"), "#!/usr/bin/env node\n").unwrap();
        std::fs::create_dir_all(entry.join("node_modules").join(".bin")).unwrap();
        entry
    }

    #[cfg(not(target_os = "windows"))]
    fn link_bin(entry: &Path) {
        std::os::unix::fs::symlink(
            Path::new("..")
                .join(PACKAGE)
                .join("dist/bin/sync-runner.js"),
            bin_path(entry, BIN),
        )
        .unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    fn set_mode(entry: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        let target = std::fs::canonicalize(bin_path(entry, BIN)).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    fn mode_of(entry: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(bin_path(entry, BIN))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn probe_reports_not_executable_for_the_reproduced_hq_desktop_4k_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "f72697f8e89f117e");
        link_bin(&entry);

        set_mode(&entry, 0o755);
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Runnable
        );

        // The exact HQ-DESKTOP-4K state: the shim resolves, the target exists,
        // and `chmod a-x` has cleared the bit npx's shell exec needs.
        set_mode(&entry, 0o600);
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::NotExecutable
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn probe_reports_missing_for_absent_and_dangling_shims() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "aaaa000000000000");

        // Package tree materialized but no `.bin` shim at all.
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Missing
        );

        // A dangling symlink is equally unexecutable by npx.
        std::os::unix::fs::symlink(Path::new("../does-not-exist.js"), bin_path(&entry, BIN))
            .unwrap();
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Missing
        );
    }

    /// Windows npm writes `.cmd`/`.ps1` shims and carries no POSIX mode bit, so
    /// executability is never asserted there — only existence is a fact, and a
    /// present shim must resolve to `Runnable` (i.e. unchanged spawn behaviour).
    #[test]
    #[cfg(target_os = "windows")]
    fn windows_probe_reports_existence_only() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "f72697f8e89f117e");

        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Missing
        );

        let shim = bin_path(&entry, BIN).with_file_name(format!("{BIN}.cmd"));
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Runnable
        );

        // Nothing to restore where there is no mode bit.
        assert_eq!(
            repair_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetRepair::NotAttempted
        );
    }

    #[test]
    fn probe_degrades_to_unreadable_when_nothing_can_be_established() {
        let tmp = tempfile::tempdir().unwrap();

        // No cache root at all.
        assert_eq!(
            probe_runner_target_in(&tmp.path().join("_npx"), PACKAGE, BIN),
            RunnerTargetState::Unreadable
        );

        // A cache root with no entry for this package (global install, a
        // pnpm/corepack-managed npx, a relocated cache).
        let npx_root = tmp.path().join("empty-npx");
        std::fs::create_dir_all(npx_root.join("deadbeef").join("node_modules")).unwrap();
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Unreadable
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn probe_degrades_to_unreadable_when_candidate_entries_disagree() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");

        let healthy = fixture_entry(&npx_root, "1111111111111111");
        link_bin(&healthy);
        set_mode(&healthy, 0o755);

        let poisoned = fixture_entry(&npx_root, "2222222222222222");
        link_bin(&poisoned);
        set_mode(&poisoned, 0o600);

        // Two pins coexist and disagree; which one npx selects is unknowable
        // from the layout, so nothing may be asserted.
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Unreadable
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn repair_restores_the_executable_bit_without_widening_access() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "f72697f8e89f117e");
        link_bin(&entry);
        set_mode(&entry, 0o600);

        assert_eq!(
            repair_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetRepair::Restored
        );
        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::Runnable
        );
        // A private 0600 target becomes 0700 — owner-executable, still private.
        assert_eq!(mode_of(&entry), 0o700);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn repair_is_a_no_op_when_the_target_is_not_positively_not_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "f72697f8e89f117e");
        link_bin(&entry);
        set_mode(&entry, 0o755);

        assert_eq!(
            repair_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetRepair::NotAttempted
        );
        assert_eq!(mode_of(&entry), 0o755);

        // Unresolvable cache: nothing to attempt, nothing touched.
        assert_eq!(
            repair_runner_target_in(&tmp.path().join("absent"), PACKAGE, BIN),
            RunnerTargetRepair::NotAttempted
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn repair_refuses_a_target_that_escapes_the_npx_cache_root() {
        let tmp = tempfile::tempdir().unwrap();
        let npx_root = tmp.path().join("_npx");
        let entry = fixture_entry(&npx_root, "f72697f8e89f117e");

        // A shim pointing outside the cache: the repair must never chmod it.
        let outside = tmp.path().join("outside.js");
        std::fs::write(&outside, "#!/usr/bin/env node\n").unwrap();
        set_mode_at(&outside, 0o600);
        std::os::unix::fs::symlink(&outside, bin_path(&entry, BIN)).unwrap();

        assert_eq!(
            probe_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetState::NotExecutable
        );
        assert_eq!(
            repair_runner_target_in(&npx_root, PACKAGE, BIN),
            RunnerTargetRepair::Failed
        );
        assert_eq!(
            mode_at(&outside),
            0o600,
            "path outside the npx cache was modified"
        );
    }

    #[cfg(not(target_os = "windows"))]
    fn set_mode_at(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    fn mode_at(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn spawn_decision_table_refuses_only_a_repaired_not_executable_target() {
        use RunnerTargetDecision::*;
        use RunnerTargetState::*;

        assert_eq!(runner_target_spawn_decision(Runnable, false), Spawn);
        assert_eq!(runner_target_spawn_decision(Runnable, true), Spawn);
        assert_eq!(
            runner_target_spawn_decision(NotExecutable, false),
            RepairThenReprobe
        );
        assert_eq!(
            runner_target_spawn_decision(NotExecutable, true),
            RefuseSpawn
        );
        // Ambiguous and missing results keep the pre-existing spawn behaviour.
        assert_eq!(runner_target_spawn_decision(Missing, false), Spawn);
        assert_eq!(runner_target_spawn_decision(Missing, true), Spawn);
        assert_eq!(runner_target_spawn_decision(Unreadable, false), Spawn);
        assert_eq!(runner_target_spawn_decision(Unreadable, true), Spawn);
    }

    #[test]
    fn state_tokens_are_fixed_vocabulary_and_keep_unknown_for_the_unprobeable_case() {
        let table = [
            (RunnerTargetState::Runnable, "true", "true", "runnable"),
            (
                RunnerTargetState::NotExecutable,
                "true",
                "false",
                "not_executable",
            ),
            (RunnerTargetState::Missing, "false", "false", "missing"),
            (
                RunnerTargetState::Unreadable,
                "unknown",
                "unknown",
                "unreadable",
            ),
        ];
        for (state, exists, executable, class) in table {
            assert_eq!(state.exists_token(), exists);
            assert_eq!(state.executable_token(), executable);
            assert_eq!(state.class_name(), class);
        }
    }

    #[test]
    fn diagnosis_names_no_path_or_account() {
        let message = not_executable_diagnosis();
        for marker in ['/', '\\'] {
            assert!(
                !message.contains(marker),
                "diagnosis leaked a path separator: {message}"
            );
        }
    }
}
