//! Probe — and bounded self-repair — of the npx-cached runner target that the
//! watch daemon actually execs.
//!
//! ## Why this exists
//!
//! [`crate::prewarm::materialize_hq_cloud_cache`] is the only pre-spawn gate the
//! watch daemon had for cache health, and it validates a *different* payload
//! than the one the daemon spawns:
//!
//! * preflight runs `npx -y --package=<pkg>@<ver> -- node -e "process.exit(0)"`
//! * the watcher runs `npx -y --package=<pkg>@<ver> hq-sync-runner --watch …`
//!
//! The preflight proves that npx runs, that the package tree materialized, and
//! that `node` runs. It never touches `node_modules/.bin/hq-sync-runner`. So a
//! cache whose runner target is present but has lost its executable bit passes
//! preflight, and the watcher is spawned into `sh: …/hq-sync-runner: Permission
//! denied` — exit 126 at uptime 0s — which the supervisor then respawns forever
//! (HQ-DESKTOP-4K).
//!
//! This module closes that divergence by probing the target the watcher will
//! actually exec, attempting one bounded repair, and letting the caller refuse
//! honestly instead of hot-looping.
//!
//! ## Why the cache entry can be resolved deterministically
//!
//! npm keys each `_npx` entry by `sha512(<sorted package specs joined by \n>)`
//! truncated to 16 hex characters. Both payloads above pass the identical
//! `--package` list, so both resolve to the same entry, and we can compute it
//! without shelling out. npm owns that derivation, so
//! [`resolve_runner_target_in`] falls back to a scan and refuses to guess when
//! the scan is ambiguous — an unresolvable cache degrades to today's behaviour
//! rather than producing a wrong verdict.
//!
//! ## Safety properties
//!
//! * Every value that can reach a Sentry tag/extra is a fixed-vocabulary token.
//!   No filesystem path, username or package path leaves this module.
//! * The probe is best-effort. Any error degrades to [`RunnerTargetState::Unreadable`]
//!   or [`RunnerTargetState::Unresolved`], both of which keep the current
//!   spawn-anyway behaviour and the existing `"unknown"` provenance.
//! * Repair is bounded to one attempt per spawn, runs under the same
//!   cross-process advisory lock as cache materialization, and only ever
//!   touches the HQ-owned `_npx` entry for the pinned package.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha512};

use crate::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};
use crate::paths;
use crate::prewarm;

const UNKNOWN_RUNNER_HQ_CLOUD_VERSION: &str = "unknown";
const MAX_RUNNER_PACKAGE_JSON_BYTES: u64 = 64 * 1024;
const MAX_RUNNER_HQ_CLOUD_VERSION_LEN: usize = 128;
/// A startup probe must be long enough for a healthy Node process to boot, but
/// never long enough to stall automatic sync. Match the repository's existing
/// bounded version-probe deadline and process containment behavior.
const NPM_CACHE_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// The provenance of the npm cache root retained for a watcher generation.
///
/// Repair needs a path even when npm cannot start, so it may use an assumed
/// platform default. Attribution, however, may only inspect a root npm or the
/// environment positively established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NpmCacheRoot {
    Established(PathBuf),
    Assumed(PathBuf),
}

impl NpmCacheRoot {
    fn path(&self) -> &Path {
        match self {
            Self::Established(path) | Self::Assumed(path) => path,
        }
    }

    fn established_path(&self) -> Option<&Path> {
        match self {
            Self::Established(path) => Some(path),
            Self::Assumed(_) => None,
        }
    }
}

/// The runner invocation chosen for one watcher generation.
///
/// The npx variant retains both the repair root and whether it was positively
/// established before spawn. An assumed platform default remains valid for
/// repair, but is deliberately unavailable to child-environment injection and
/// crash attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerSpawnTarget {
    Local { script: String },
    Npx { cache_root: NpmCacheRoot },
}

impl RunnerSpawnTarget {
    /// Construct the compatibility target used only by the legacy args
    /// builder. It deliberately skips the npm probe, so it cannot change
    /// where a caller's npx command installs packages.
    pub(crate) fn npx_with_assumed_cache_root() -> Self {
        Self::Npx {
            cache_root: NpmCacheRoot::Assumed(assumed_npm_cache_root()),
        }
    }

    fn repair_npx_cache_dir(&self) -> Option<PathBuf> {
        match self {
            Self::Local { .. } => None,
            Self::Npx { cache_root } => Some(cache_root.path().join("_npx")),
        }
    }

    fn attribution_npx_cache_dir(&self) -> Option<PathBuf> {
        match self {
            Self::Local { .. } => None,
            Self::Npx { cache_root } => cache_root
                .established_path()
                .map(|cache_root| cache_root.join("_npx")),
        }
    }

    /// Cache root that npm or an explicit environment setting established for
    /// this generation. Only this root may be injected into the npx child.
    pub fn established_npm_cache_root(&self) -> Option<&Path> {
        match self {
            Self::Local { .. } => None,
            Self::Npx { cache_root } => cache_root.established_path(),
        }
    }
}

/// Return the non-empty local runner override selected by the watcher spawn
/// builder. Keeping this decision here gives the spawn and attribution paths a
/// single source of truth.
pub fn local_runner_override() -> Option<String> {
    std::env::var("HQ_CLOUD_LOCAL_RUNNER")
        .ok()
        .filter(|path| !path.is_empty())
}

/// Snapshot the exact runner source for a watcher generation before it starts.
///
/// This is intentionally called on the startup path, never from crash
/// reporting. When npm's resolved cache cannot be established, the target
/// retains an assumed platform default for repair; npx keeps its normal
/// configuration and provenance remains `unknown`.
pub fn runner_spawn_target() -> RunnerSpawnTarget {
    match local_runner_override() {
        Some(script) => RunnerSpawnTarget::Local { script },
        None => RunnerSpawnTarget::Npx {
            cache_root: npm_cache_root(),
        },
    }
}

/// Fixed-vocabulary state of the runner target the watcher would exec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetState {
    /// Present and executable under this platform's semantics.
    Runnable,
    /// Present, but the exec bit is clear. This is the HQ-DESKTOP-4K state.
    NotExecutable,
    /// Resolved a cache entry, but the runner target is not there.
    Missing,
    /// The target could not be inspected (permission or I/O error).
    Unreadable,
    /// No cache entry could be resolved at all, so nothing can be asserted.
    Unresolved,
}

impl RunnerTargetState {
    /// Stable, content-safe token for logs.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Runnable => "runnable",
            Self::NotExecutable => "not_executable",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
            Self::Unresolved => "unresolved",
        }
    }

    /// Value for the `runner_exec_target_exists` Sentry extra. Keeps the
    /// pre-existing `"unknown"` vocabulary for the genuinely unprobeable case
    /// instead of inventing a new token.
    pub fn exists_token(self) -> &'static str {
        match self {
            Self::Runnable | Self::NotExecutable => "true",
            Self::Missing => "false",
            Self::Unreadable | Self::Unresolved => "unknown",
        }
    }

    /// Value for the `runner_exec_target_executable` Sentry extra.
    pub fn executable_token(self) -> &'static str {
        match self {
            Self::Runnable => "true",
            Self::NotExecutable | Self::Missing => "false",
            Self::Unreadable | Self::Unresolved => "unknown",
        }
    }
}

/// Whether a file's exec bit is meaningful on the host being probed.
///
/// Kept as an explicit parameter rather than a `cfg` so both behaviours stay
/// testable on every platform, matching how this crate pins Windows wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutableSemantics {
    /// Unix mode bits are authoritative.
    UnixModeBits,
    /// Windows: presence is all that can be asserted; a mode bit means nothing.
    PresenceOnly,
}

/// The semantics that apply to the current host.
pub fn current_executable_semantics() -> ExecutableSemantics {
    if cfg!(target_os = "windows") {
        ExecutableSemantics::PresenceOnly
    } else {
        ExecutableSemantics::UnixModeBits
    }
}

/// What the pre-spawn gate should do with a probe result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetGate {
    /// Proceed with the spawn (also the degraded/ambiguous outcome).
    Spawn,
    /// Attempt the single bounded repair, then re-probe.
    Repair,
    /// Positively broken after the repair — refuse rather than hot-loop.
    Refuse,
}

/// Decision table for the pre-spawn gate.
///
/// Only a *positively identified* broken target after the single repair attempt
/// refuses the spawn. Every ambiguous or error result keeps today's behaviour,
/// so a probe bug can never take a working machine's auto-sync offline.
pub fn runner_target_gate(state: RunnerTargetState, repair_attempted: bool) -> RunnerTargetGate {
    match state {
        RunnerTargetState::Runnable
        | RunnerTargetState::Unreadable
        | RunnerTargetState::Unresolved => RunnerTargetGate::Spawn,
        RunnerTargetState::NotExecutable | RunnerTargetState::Missing => {
            if repair_attempted {
                RunnerTargetGate::Refuse
            } else {
                RunnerTargetGate::Repair
            }
        }
    }
}

/// Which bounded repair ran, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerTargetRepair {
    NotAttempted,
    /// The executable bit was restored on the cached target.
    ModeRestored,
    /// The HQ-owned `_npx` entry was purged and re-materialized.
    Rematerialized,
    /// A repair was attempted and did not succeed.
    Failed,
}

impl RunnerTargetRepair {
    /// Stable, content-safe token for logs and the Sentry extra.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::NotAttempted => "not_attempted",
            Self::ModeRestored => "mode_restored",
            Self::Rematerialized => "rematerialized",
            Self::Failed => "failed",
        }
    }

    pub fn attempted(self) -> bool {
        self != Self::NotAttempted
    }
}

/// Final result of the pre-spawn gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerTargetOutcome {
    pub state: RunnerTargetState,
    pub repair: RunnerTargetRepair,
}

impl RunnerTargetOutcome {
    /// Degraded default used whenever nothing can be asserted.
    pub fn unresolved() -> Self {
        Self {
            state: RunnerTargetState::Unresolved,
            repair: RunnerTargetRepair::NotAttempted,
        }
    }

    pub fn refuses_spawn(self) -> bool {
        runner_target_gate(self.state, self.repair.attempted()) == RunnerTargetGate::Refuse
    }
}

/// User-actionable local diagnosis for a refused spawn. Deliberately carries no
/// path: the concrete location stays in the local log.
pub fn runner_target_diagnosis(state: RunnerTargetState) -> String {
    match state {
        RunnerTargetState::NotExecutable => {
            "HQ Sync cannot start auto-sync because its cached sync engine is not executable, \
             and repairing it did not work. Fix your npm cache permissions, then reopen HQ Sync."
                .to_string()
        }
        RunnerTargetState::Missing => {
            "HQ Sync cannot start auto-sync because its cached sync engine is missing and could \
             not be reinstalled. Check your network and npm setup, then reopen HQ Sync."
                .to_string()
        }
        _ => "HQ Sync cannot start auto-sync because its cached sync engine is not usable. \
              Check your npm setup, then reopen HQ Sync."
            .to_string(),
    }
}

/// The exact `<package>@<version>` spec both npx payloads pass.
pub fn pinned_package_spec() -> String {
    format!("{}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION)
}

/// npm's `_npx` cache key: `sha512(<specs joined by \n>)` truncated to 16 hex
/// characters. HQ passes exactly one `--package`, so the join is the spec.
pub fn npx_cache_entry_hash(package_spec: &str) -> String {
    let digest = Sha512::digest(package_spec.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

enum NpmCacheEnvironment {
    NotSet,
    Resolved(PathBuf),
    Uncertain,
}

/// Resolve the environment's `npm_config_cache` setting exactly as npm treats
/// config names: case-insensitively. Multiple differently-cased values cannot
/// be tied safely to the child npm process, so they deliberately do not
/// establish an attribution root.
fn npm_cache_root_from_environment<I>(environment: I) -> NpmCacheEnvironment
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
{
    let mut selected: Option<std::ffi::OsString> = None;
    for (name, value) in environment {
        if !name
            .to_string_lossy()
            .eq_ignore_ascii_case("npm_config_cache")
        {
            continue;
        }
        if value.is_empty() {
            return NpmCacheEnvironment::Uncertain;
        }
        match &selected {
            None => selected = Some(value),
            Some(existing) if existing == &value => {}
            Some(_) => return NpmCacheEnvironment::Uncertain,
        }
    }
    selected.map_or(NpmCacheEnvironment::NotSet, |cache| {
        NpmCacheEnvironment::Resolved(PathBuf::from(cache))
    })
}

/// Read the effective cache root from npm before a watcher starts.
///
/// `npm config get cache` applies the same current-working-directory, user,
/// global, and built-in npmrc precedence as the npx command we run. The result
/// is retained in [`RunnerSpawnTarget`] and injected into the child, so this
/// subprocess is never needed from the crash path.
fn npm_cache_root_from_npm() -> Option<PathBuf> {
    let npm = paths::resolve_bin("npm");
    let mut command = paths::spawn_command(&npm, &["config", "get", "cache"]);
    command.env("PATH", paths::child_path());
    npm_cache_root_from_npm_command(&mut command, NPM_CACHE_PROBE_TIMEOUT)
}

/// Run an npm cache probe with the same bounded process-tree containment used
/// by the CLI version probes. A timeout, spawn failure, nonzero exit, or
/// malformed output is not evidence about provenance and therefore returns no
/// established root.
fn npm_cache_root_from_npm_command(
    command: &mut std::process::Command,
    timeout: Duration,
) -> Option<PathBuf> {
    let output = crate::hq_cli_update::output_with_timeout(command, timeout).ok()??;
    if !output.status.success() {
        return None;
    }
    npm_cache_root_from_npm_output(&output.stdout)
}

/// Parse the single path that `npm config get cache` emitted after applying its
/// npmrc precedence. Multiple lines or invalid text are not trustworthy runner
/// provenance and therefore degrade to `unknown`.
fn npm_cache_root_from_npm_output(output: &[u8]) -> Option<PathBuf> {
    let output = std::str::from_utf8(output).ok()?;
    let mut lines = output.split_terminator('\n');
    let cache = lines.next()?;
    let cache = cache.strip_suffix('\r').unwrap_or(cache);
    if cache.is_empty() || lines.next().is_some() {
        return None;
    }
    Some(PathBuf::from(cache))
}

/// Platform-default npm cache root for repair when no root was established.
///
/// This mirrors the previous cache-root fallback. A missing home directory is
/// exceptionally rare, but still produces a relative `.npm` path so repair
/// keeps its best-effort, never-refuse behavior instead of becoming unresolved.
fn assumed_npm_cache_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        if !local_app_data.is_empty() {
            return PathBuf::from(local_app_data).join("npm-cache");
        }
    }
    paths::home_dir()
        .map(|home| home.join(".npm"))
        .unwrap_or_else(|| PathBuf::from(".npm"))
}

/// Root of npm's cache, honouring case-insensitive environment configuration
/// first and otherwise asking npm to apply its own npmrc precedence. Repair
/// receives the platform default whenever neither source establishes a root;
/// attribution treats that state as unknown.
fn npm_cache_root_with<I, F>(environment: I, npm_probe: F) -> NpmCacheRoot
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    F: FnOnce() -> Option<PathBuf>,
{
    match npm_cache_root_from_environment(environment) {
        NpmCacheEnvironment::Resolved(cache) => NpmCacheRoot::Established(cache),
        NpmCacheEnvironment::Uncertain => NpmCacheRoot::Assumed(assumed_npm_cache_root()),
        NpmCacheEnvironment::NotSet => npm_probe()
            .map(NpmCacheRoot::Established)
            .unwrap_or_else(|| NpmCacheRoot::Assumed(assumed_npm_cache_root())),
    }
}

fn npm_cache_root() -> NpmCacheRoot {
    npm_cache_root_with(std::env::vars_os(), npm_cache_root_from_npm)
}

/// Directory holding npx's per-spec package trees.
pub fn npx_cache_dir() -> Option<PathBuf> {
    Some(npm_cache_root().path().join("_npx"))
}

/// Candidate filenames that establish presence on a host with no exec bit.
/// npm writes the extensionless shell script plus `.cmd`/`.ps1` shims, and
/// which one exists is an npm implementation detail — accept any of them so a
/// healthy Windows cache is never mistaken for a missing one.
fn presence_candidates(path: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![path.to_path_buf()];
    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        for extension in ["cmd", "bat", "exe", "ps1"] {
            candidates.push(path.with_file_name(format!("{name}.{extension}")));
        }
    }
    candidates
}

#[cfg(unix)]
fn mode_is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn mode_is_executable(_metadata: &std::fs::Metadata) -> bool {
    // No mode bits to consult. Callers on this platform use `PresenceOnly`;
    // this arm exists only so the pure probe compiles everywhere.
    true
}

/// Probe one resolved runner target.
///
/// `std::fs::metadata` follows symlinks on purpose: npm's `.bin` entry is a
/// symlink into the package, and a dangling link is exactly as unrunnable as a
/// missing file.
pub fn probe_runner_target_at(path: &Path, semantics: ExecutableSemantics) -> RunnerTargetState {
    match semantics {
        ExecutableSemantics::PresenceOnly => {
            let mut unreadable = false;
            for candidate in presence_candidates(path) {
                match std::fs::metadata(&candidate) {
                    Ok(_) => return RunnerTargetState::Runnable,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => unreadable = true,
                }
            }
            if unreadable {
                RunnerTargetState::Unreadable
            } else {
                RunnerTargetState::Missing
            }
        }
        ExecutableSemantics::UnixModeBits => match std::fs::metadata(path) {
            Ok(metadata) => {
                if mode_is_executable(&metadata) {
                    RunnerTargetState::Runnable
                } else {
                    RunnerTargetState::NotExecutable
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => RunnerTargetState::Missing,
            Err(_) => RunnerTargetState::Unreadable,
        },
    }
}

/// Resolve the runner target inside an `_npx` cache directory.
///
/// Prefers npm's deterministic hash entry. If that entry is absent — npm owns
/// the derivation and may change it — fall back to a scan and accept the result
/// only when exactly one entry carries the HQ runner bin, so an ambiguous cache
/// degrades instead of producing a wrong verdict.
pub fn resolve_runner_target_in(npx_cache_dir: &Path, package_spec: &str) -> Option<PathBuf> {
    let hashed = npx_cache_dir.join(npx_cache_entry_hash(package_spec));
    if hashed.join("node_modules").is_dir() {
        return Some(runner_bin_in_entry(&hashed));
    }

    let mut found: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(npx_cache_dir).ok()?.flatten() {
        let candidate = runner_bin_in_entry(&entry.path());
        if presence_candidates(&candidate)
            .iter()
            .any(|path| path.symlink_metadata().is_ok())
        {
            found.push(candidate);
        }
    }
    match found.len() {
        1 => found.pop(),
        _ => None,
    }
}

/// Resolve only the deterministic `_npx/<hash>` entry for one package spec.
///
/// Attribution cannot use the repair path's unique-entry fallback: that entry
/// may have been created for a previous pin and npx will not select it for the
/// current launch. Presence of the runner shim establishes that the exact entry
/// is complete enough to be the runner source; every other state is unknown.
fn resolve_exact_runner_target_in(npx_cache_dir: &Path, package_spec: &str) -> Option<PathBuf> {
    let entry = npx_cache_dir.join(npx_cache_entry_hash(package_spec));
    if !entry.join("node_modules").is_dir() {
        return None;
    }
    let target = runner_bin_in_entry(&entry);
    presence_candidates(&target)
        .iter()
        .any(|candidate| candidate.symlink_metadata().is_ok())
        .then_some(target)
}

/// Resolve the hq-cloud version from the exact `_npx` entry whose runner target
/// npx selects. This is crash-report metadata only: every cache, file, JSON, or
/// version-validation failure becomes the fixed `"unknown"` sentinel.
pub fn runner_hq_cloud_version_in(npx_cache_dir: &Path, package_spec: &str) -> String {
    let Some(target) = resolve_exact_runner_target_in(npx_cache_dir, package_spec) else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    let Some(entry) = npx_entry_dir_for(npx_cache_dir, &target) else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    let manifest = entry
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cloud")
        .join("package.json");
    let Ok(file) = std::fs::File::open(manifest) else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    let mut contents = String::new();
    let Ok(read) = file
        .take(MAX_RUNNER_PACKAGE_JSON_BYTES + 1)
        .read_to_string(&mut contents)
    else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    if read > MAX_RUNNER_PACKAGE_JSON_BYTES as usize {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    }
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    let Some(version) = manifest.get("version").and_then(|value| value.as_str()) else {
        return UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string();
    };
    if valid_runner_hq_cloud_version(version) {
        version.to_string()
    } else {
        UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string()
    }
}

/// Read the hq-cloud version for the exact watcher target selected at startup.
///
/// The caller supplies the retained [`RunnerSpawnTarget`], not live process
/// configuration, because crash reporting must not spawn npm or infer a runner
/// from a cache that a later launch might select.
pub fn runner_hq_cloud_version(target: &RunnerSpawnTarget) -> String {
    target.attribution_npx_cache_dir().map_or_else(
        || UNKNOWN_RUNNER_HQ_CLOUD_VERSION.to_string(),
        |cache_dir| runner_hq_cloud_version_in(&cache_dir, &pinned_package_spec()),
    )
}

fn valid_runner_hq_cloud_version(value: &str) -> bool {
    value.len() <= MAX_RUNNER_HQ_CLOUD_VERSION_LEN
        && value.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && semver::Version::parse(value).is_ok()
}

fn runner_bin_in_entry(entry: &Path) -> PathBuf {
    entry.join("node_modules").join(".bin").join(RUNNER_BIN)
}

/// The `_npx/<hash>` entry that owns `target`, verified to be a direct child of
/// `npx_cache_dir`. Returns `None` for anything outside the cache so the purge
/// path can never escape it.
pub fn npx_entry_dir_for(npx_cache_dir: &Path, target: &Path) -> Option<PathBuf> {
    // Defense in depth: refuse to derive a purge target from anything that is
    // not an npx cache, so a mis-derived cache root cannot widen the blast
    // radius beyond npm's own directory.
    if npx_cache_dir.file_name() != Some(std::ffi::OsStr::new("_npx")) {
        return None;
    }
    let mut current = target;
    loop {
        let parent = current.parent()?;
        if parent == npx_cache_dir {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
}

/// Grant exec exactly where read is already granted (`chmod a+X` semantics), so
/// the repair never widens access beyond what the file already exposes.
#[cfg(unix)]
pub fn executable_mode_for(mode: u32) -> u32 {
    mode | ((mode & 0o444) >> 2)
}

#[cfg(unix)]
fn restore_executable_bit(target: &Path) -> Result<(), String> {
    // Follow the `.bin` symlink: npm points it at the package's real script,
    // and that is the file whose mode the shell actually checks.
    let real = std::fs::canonicalize(target)
        .map_err(|err| format!("could not resolve the cached runner target: {err}"))?;
    let metadata = std::fs::metadata(&real)
        .map_err(|err| format!("could not inspect the cached runner target: {err}"))?;
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = metadata.permissions();
    permissions.set_mode(executable_mode_for(permissions.mode()));
    std::fs::set_permissions(&real, permissions)
        .map_err(|err| format!("could not restore the cached runner target's exec bit: {err}"))
}

#[cfg(not(unix))]
fn restore_executable_bit(_target: &Path) -> Result<(), String> {
    Err("exec bits are not meaningful on this platform".to_string())
}

/// Purge only the HQ-owned `_npx` entry, then re-run the normal materialization.
fn purge_and_rematerialize(npx_cache_dir: &Path, target: &Path) -> Result<(), String> {
    let entry = npx_entry_dir_for(npx_cache_dir, target)
        .ok_or_else(|| "the cached runner target is outside the npx cache".to_string())?;
    prewarm::with_materialization_lock(|| std::fs::remove_dir_all(&entry))?
        .map_err(|err| format!("could not clear the cached sync engine: {err}"))?;
    prewarm::materialize_hq_cloud_cache()
}

fn repair_runner_target(
    npx_cache_dir: &Path,
    target: &Path,
    state: RunnerTargetState,
) -> RunnerTargetRepair {
    if state == RunnerTargetState::NotExecutable {
        // Prefer restoring the mode bit over deleting a materialized tree.
        if let Ok(Ok(())) = prewarm::with_materialization_lock(|| restore_executable_bit(target)) {
            return RunnerTargetRepair::ModeRestored;
        }
    }
    match purge_and_rematerialize(npx_cache_dir, target) {
        Ok(()) => RunnerTargetRepair::Rematerialized,
        Err(_) => RunnerTargetRepair::Failed,
    }
}

/// Probe the runner target the watcher would exec and, when it is positively
/// broken, attempt exactly one bounded repair before re-probing.
///
/// Never panics and never blocks beyond the materialization lock's existing
/// bounded wait. Any failure degrades to a state the gate treats as "spawn".
pub fn ensure_runner_target_runnable_for(target: &RunnerSpawnTarget) -> RunnerTargetOutcome {
    let semantics = current_executable_semantics();
    let Some(cache_dir) = target.repair_npx_cache_dir() else {
        return RunnerTargetOutcome::unresolved();
    };
    let package_spec = pinned_package_spec();
    let Some(target) = resolve_runner_target_in(&cache_dir, &package_spec) else {
        return RunnerTargetOutcome::unresolved();
    };

    let state = probe_runner_target_at(&target, semantics);
    if runner_target_gate(state, false) != RunnerTargetGate::Repair {
        return RunnerTargetOutcome {
            state,
            repair: RunnerTargetRepair::NotAttempted,
        };
    }

    let repair = repair_runner_target(&cache_dir, &target, state);
    // Re-resolve: a purge-and-rematerialize can move the entry from a scanned
    // location to npm's hashed one.
    let state = match resolve_runner_target_in(&cache_dir, &package_spec) {
        Some(target) => probe_runner_target_at(&target, semantics),
        None => RunnerTargetState::Unresolved,
    };
    RunnerTargetOutcome { state, repair }
}

/// Compatibility wrapper for callers that do not retain a launch snapshot.
/// Watcher startup uses [`ensure_runner_target_runnable_for`] so its repair
/// target and crash provenance share one resolved cache directory.
pub fn ensure_runner_target_runnable() -> RunnerTargetOutcome {
    ensure_runner_target_runnable_for(&runner_spawn_target())
}

/// Probe only — no repair. Used at the Sentry capture seam so a 126/127 exit
/// reports what the target actually is instead of the literal `"unknown"`.
pub fn probe_runner_target_for(target: &RunnerSpawnTarget) -> RunnerTargetState {
    let Some(cache_dir) = target.attribution_npx_cache_dir() else {
        return RunnerTargetState::Unresolved;
    };
    match resolve_runner_target_in(&cache_dir, &pinned_package_spec()) {
        Some(target) => probe_runner_target_at(&target, current_executable_semantics()),
        None => RunnerTargetState::Unresolved,
    }
}

/// Compatibility wrapper for non-watcher diagnostics. The watcher exit path
/// uses [`probe_runner_target_for`] and never resolves npm configuration late.
pub fn probe_runner_target() -> RunnerTargetState {
    probe_runner_target_for(&runner_spawn_target())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_runner(entry: &Path, mode: u32) -> PathBuf {
        let package = entry
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cloud")
            .join("dist")
            .join("bin");
        std::fs::create_dir_all(&package).unwrap();
        let script = package.join("sync-runner.js");
        std::fs::write(&script, b"#!/usr/bin/env node\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let _ = mode;

        let bin = entry.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join(RUNNER_BIN);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&script, &shim).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&shim, b"shim").unwrap();
        shim
    }

    fn write_hq_cloud_manifest(entry: &Path, contents: &str) {
        let manifest = entry
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cloud")
            .join("package.json");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(manifest, contents).unwrap();
    }

    fn npm_cache_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        std::env::vars_os()
            .filter(|(name, _)| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case("npm_config_cache")
            })
            .collect()
    }

    fn clear_npm_cache_environment() {
        for (name, _) in npm_cache_environment() {
            std::env::remove_var(name);
        }
    }

    fn restore_npm_cache_environment(prior: Vec<(std::ffi::OsString, std::ffi::OsString)>) {
        clear_npm_cache_environment();
        for (name, value) in prior {
            std::env::set_var(name, value);
        }
    }

    /// Pins npm's `_npx` cache-key derivation against the entry observed in the
    /// HQ-DESKTOP-4K reproduction. If npm ever changes it, this fails loudly
    /// and `resolve_runner_target_in` falls back to its scan.
    #[test]
    fn npx_cache_entry_hash_matches_observed_npm_entry() {
        assert_eq!(
            npx_cache_entry_hash("@indigoai-us/hq-cloud@~6.14.47"),
            "f72697f8e89f117e",
        );
        assert_eq!(npx_cache_entry_hash(&pinned_package_spec()).len(), 16);
    }

    /// npm derives `_npx` directories from the literal input spec. A floor bump
    /// must therefore change this hash, or a cached runner can never pick up a
    /// patch that still satisfies the previous tilde range.
    #[test]
    fn npx_cache_key_is_sha512_of_the_input_spec_and_changes_with_the_floor() {
        assert_eq!(
            npx_cache_entry_hash("@indigoai-us/hq-cloud@~6.16.6"),
            "36f3a23156e2fcea",
        );
        assert_eq!(
            npx_cache_entry_hash("@indigoai-us/hq-cloud@~6.16.11"),
            "a483dd3663414ee8",
        );
        assert_ne!(
            npx_cache_entry_hash("@indigoai-us/hq-cloud@~6.16.6"),
            npx_cache_entry_hash("@indigoai-us/hq-cloud@~6.16.11"),
        );
    }

    #[test]
    fn pinned_package_spec_matches_the_spec_both_npx_payloads_pass() {
        assert_eq!(
            pinned_package_spec(),
            format!("{}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        );
    }

    /// The exact HQ-DESKTOP-4K state: target present, exec bit cleared.
    #[cfg(unix)]
    #[test]
    fn probe_reports_not_executable_for_a_poisoned_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_runner(tmp.path(), 0o600);
        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::NotExecutable,
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_runnable_for_a_healthy_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_runner(tmp.path(), 0o755);
        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::Runnable,
        );
    }

    #[test]
    fn probe_reports_missing_when_the_target_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let absent = tmp
            .path()
            .join("node_modules")
            .join(".bin")
            .join(RUNNER_BIN);
        assert_eq!(
            probe_runner_target_at(&absent, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::Missing,
        );
        assert_eq!(
            probe_runner_target_at(&absent, ExecutableSemantics::PresenceOnly),
            RunnerTargetState::Missing,
        );
    }

    /// A dangling `.bin` symlink is exactly as unrunnable as a missing file.
    #[cfg(unix)]
    #[test]
    fn probe_reports_missing_for_a_dangling_bin_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join(RUNNER_BIN);
        std::os::unix::fs::symlink(tmp.path().join("gone.js"), &shim).unwrap();
        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::Missing,
        );
    }

    /// Windows has no exec bit, so a present target must never be reported as
    /// not-executable — that would refuse the spawn on a healthy machine.
    #[test]
    fn presence_only_semantics_never_report_not_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_runner(tmp.path(), 0o600);
        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::PresenceOnly),
            RunnerTargetState::Runnable,
        );
    }

    /// npm may write only the `.cmd` shim; that is still a healthy cache.
    #[test]
    fn presence_only_semantics_accept_a_cmd_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(format!("{RUNNER_BIN}.cmd")), b"@echo off").unwrap();
        assert_eq!(
            probe_runner_target_at(&bin.join(RUNNER_BIN), ExecutableSemantics::PresenceOnly),
            RunnerTargetState::Runnable,
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_unreadable_when_the_target_cannot_be_inspected() {
        use std::os::unix::fs::PermissionsExt;
        // Root ignores directory permissions, so this can only be asserted as
        // an unprivileged user.
        if unsafe { libc_geteuid() } == 0 {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_runner(tmp.path(), 0o755);
        let bin = shim.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o000)).unwrap();
        let state = probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits);
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(state, RunnerTargetState::Unreadable);
        // Unreadable must degrade, never refuse.
        assert_eq!(
            runner_target_gate(state, true),
            RunnerTargetGate::Spawn,
            "an unprobeable target must keep today's spawn behaviour",
        );
    }

    #[cfg(unix)]
    extern "C" {
        #[link_name = "geteuid"]
        fn libc_geteuid() -> u32;
    }

    #[test]
    fn resolve_prefers_npms_deterministic_hash_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = "@indigoai-us/hq-cloud@~6.14.47";
        let entry = tmp.path().join(npx_cache_entry_hash(spec));
        write_runner(&entry, 0o755);
        // A decoy entry must not be selected while the hashed entry exists.
        write_runner(&tmp.path().join("0000000000000000"), 0o755);

        let resolved = resolve_runner_target_in(tmp.path(), spec).unwrap();
        assert!(resolved.starts_with(&entry), "resolved {resolved:?}");
        assert_eq!(resolved.file_name().unwrap(), RUNNER_BIN);
    }

    #[test]
    fn resolve_falls_back_to_a_unique_scanned_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("some-other-key");
        write_runner(&entry, 0o755);
        let resolved =
            resolve_runner_target_in(tmp.path(), "@indigoai-us/hq-cloud@~9.9.9").unwrap();
        assert!(resolved.starts_with(&entry));
    }

    #[test]
    fn resolve_refuses_to_guess_between_ambiguous_entries() {
        let tmp = tempfile::tempdir().unwrap();
        write_runner(&tmp.path().join("entry-a"), 0o755);
        write_runner(&tmp.path().join("entry-b"), 0o755);
        assert!(resolve_runner_target_in(tmp.path(), "@indigoai-us/hq-cloud@~9.9.9").is_none());
    }

    #[test]
    fn resolve_returns_none_for_an_absent_cache() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_runner_target_in(
            &tmp.path().join("no-such-cache"),
            &pinned_package_spec()
        )
        .is_none());
    }

    #[test]
    fn runner_hq_cloud_version_reads_the_resolved_npx_entry_and_fails_soft() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("_npx");
        let spec = "@indigoai-us/hq-cloud@~6.16.11";
        let entry = cache.join(npx_cache_entry_hash(spec));
        write_runner(&entry, 0o755);
        write_hq_cloud_manifest(&entry, r#"{"version":"6.16.11"}"#);
        assert_eq!(runner_hq_cloud_version_in(&cache, spec), "6.16.11");
        assert_eq!(
            runner_hq_cloud_version(&RunnerSpawnTarget::Npx {
                cache_root: NpmCacheRoot::Established(tmp.path().to_path_buf()),
            }),
            "6.16.11",
            "the npx launch snapshot reports the version from its exact cache entry"
        );

        // Every bad cache input is reporting-only and must fail soft rather than
        // changing the watcher crash path.
        assert_eq!(
            runner_hq_cloud_version_in(&cache.join("missing"), spec),
            "unknown"
        );

        let missing_manifest = cache.join(npx_cache_entry_hash("@indigoai-us/hq-cloud@~9.9.1"));
        write_runner(&missing_manifest, 0o755);
        assert_eq!(
            runner_hq_cloud_version_in(&cache, "@indigoai-us/hq-cloud@~9.9.1"),
            "unknown"
        );

        let missing_runner = cache.join(npx_cache_entry_hash("@indigoai-us/hq-cloud@~9.9.5"));
        write_hq_cloud_manifest(&missing_runner, r#"{"version":"9.9.5"}"#);
        assert_eq!(
            runner_hq_cloud_version_in(&cache, "@indigoai-us/hq-cloud@~9.9.5"),
            "unknown",
            "a manifest without the exact runner shim is an incomplete cache entry"
        );

        let malformed = cache.join(npx_cache_entry_hash("@indigoai-us/hq-cloud@~9.9.2"));
        write_runner(&malformed, 0o755);
        write_hq_cloud_manifest(&malformed, "not json");
        assert_eq!(
            runner_hq_cloud_version_in(&cache, "@indigoai-us/hq-cloud@~9.9.2"),
            "unknown"
        );

        let non_semver = cache.join(npx_cache_entry_hash("@indigoai-us/hq-cloud@~9.9.3"));
        write_runner(&non_semver, 0o755);
        write_hq_cloud_manifest(
            &non_semver,
            r#"{"version":"FATAL ERROR: /Users/Ada/secret"}"#,
        );
        assert_eq!(
            runner_hq_cloud_version_in(&cache, "@indigoai-us/hq-cloud@~9.9.3"),
            "unknown"
        );

        let too_long = cache.join(npx_cache_entry_hash("@indigoai-us/hq-cloud@~9.9.4"));
        write_runner(&too_long, 0o755);
        write_hq_cloud_manifest(
            &too_long,
            &format!(r#"{{"version":"{}"}}"#, "9".repeat(129)),
        );
        assert_eq!(
            runner_hq_cloud_version_in(&cache, "@indigoai-us/hq-cloud@~9.9.4"),
            "unknown"
        );
    }

    #[test]
    fn local_runner_override_never_attributes_a_populated_npx_cache() {
        use crate::test_support::ENV_MUTEX;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("npm-cache");
        let cache = cache_root.join("_npx");
        let spec = pinned_package_spec();
        let entry = cache.join(npx_cache_entry_hash(&spec));
        write_runner(&entry, 0o755);
        write_hq_cloud_manifest(&entry, r#"{"version":"6.16.11"}"#);

        let prior_local_runner = std::env::var_os("HQ_CLOUD_LOCAL_RUNNER");
        let prior_npm_cache = npm_cache_environment();
        clear_npm_cache_environment();
        std::env::set_var("HQ_CLOUD_LOCAL_RUNNER", tmp.path().join("sync-runner.js"));
        std::env::set_var("npm_config_cache", &cache_root);
        let target = runner_spawn_target();
        let actual = runner_hq_cloud_version(&target);
        match prior_local_runner {
            Some(value) => std::env::set_var("HQ_CLOUD_LOCAL_RUNNER", value),
            None => std::env::remove_var("HQ_CLOUD_LOCAL_RUNNER"),
        }
        restore_npm_cache_environment(prior_npm_cache);

        assert!(matches!(target, RunnerSpawnTarget::Local { .. }));
        assert_eq!(actual, UNKNOWN_RUNNER_HQ_CLOUD_VERSION);
    }

    #[test]
    fn attribution_refuses_a_unique_fallback_cache_entry_but_repair_keeps_it() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = "@indigoai-us/hq-cloud@~6.16.11";
        let cache = tmp.path().join("_npx");
        let stale_entry = cache.join("4df8f075c5c7872e");
        write_runner(&stale_entry, 0o755);
        write_hq_cloud_manifest(&stale_entry, r#"{"version":"6.16.0"}"#);

        let repair_outcome = ensure_runner_target_runnable_for(&RunnerSpawnTarget::Npx {
            cache_root: NpmCacheRoot::Established(tmp.path().to_path_buf()),
        });
        assert_eq!(
            repair_outcome.state,
            RunnerTargetState::Runnable,
            "repair must retain its unique-entry fallback"
        );
        assert_eq!(
            runner_hq_cloud_version_in(&cache, spec),
            UNKNOWN_RUNNER_HQ_CLOUD_VERSION,
            "attribution must never infer the current runner from a non-current cache entry"
        );
    }

    #[test]
    fn npx_cache_dir_honors_uppercase_and_mixed_case_environment_overrides() {
        use crate::test_support::ENV_MUTEX;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let prior = npm_cache_environment();
        clear_npm_cache_environment();

        let uppercase_cache = tmp.path().join("uppercase-cache");
        std::env::set_var("NPM_CONFIG_CACHE", &uppercase_cache);
        let uppercase_actual = npx_cache_dir();

        clear_npm_cache_environment();
        let mixed_case_cache = tmp.path().join("mixed-case-cache");
        std::env::set_var("NpM_cOnFiG_cAcHe", &mixed_case_cache);
        let mixed_case_actual = npx_cache_dir();

        restore_npm_cache_environment(prior);

        assert_eq!(uppercase_actual, Some(uppercase_cache.join("_npx")));
        assert_eq!(mixed_case_actual, Some(mixed_case_cache.join("_npx")));
    }

    #[test]
    fn npm_config_lookup_output_preserves_the_npmrc_resolved_cache_root() {
        let tmp = tempfile::tempdir().unwrap();
        let npmrc_resolved_cache = tmp.path().join("cache-from-npmrc");
        let output = format!("{}\n", npmrc_resolved_cache.display());

        assert_eq!(
            npm_cache_root_from_npm_output(output.as_bytes()),
            Some(npmrc_resolved_cache),
            "the startup snapshot must retain npm's user/global/project npmrc result"
        );
        assert!(
            npm_cache_root_from_npm_output(b"/first-cache\n/second-cache\n").is_none(),
            "ambiguous npm output must not select a cache root"
        );
    }

    /// An unavailable npm process must not turn off the preflight that repairs
    /// a poisoned platform-default cache, but that assumed location is never
    /// strong enough evidence to attribute a runner version.
    #[cfg(unix)]
    #[test]
    fn assumed_default_cache_repairs_while_attribution_stays_unknown() {
        use crate::test_support::ENV_MUTEX;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let prior_home = std::env::var_os("HOME");
        let prior_npm_cache = npm_cache_environment();
        clear_npm_cache_environment();
        std::env::set_var("HOME", tmp.path());

        let target = RunnerSpawnTarget::Npx {
            cache_root: npm_cache_root_with(
                Vec::<(std::ffi::OsString, std::ffi::OsString)>::new(),
                || None,
            ),
        };
        let expected_root = tmp.path().join(".npm");
        let entry = expected_root
            .join("_npx")
            .join(npx_cache_entry_hash(&pinned_package_spec()));
        write_runner(&entry, 0o644);
        write_hq_cloud_manifest(&entry, r#"{"version":"6.16.11"}"#);

        let attributed_version = runner_hq_cloud_version(&target);
        let repair_outcome = ensure_runner_target_runnable_for(&target);
        let cache_root = match &target {
            RunnerSpawnTarget::Npx {
                cache_root: NpmCacheRoot::Assumed(cache_root),
            } => cache_root.clone(),
            other => panic!("expected an assumed npx cache root, got {other:?}"),
        };

        match prior_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
        restore_npm_cache_environment(prior_npm_cache);

        assert_eq!(cache_root, expected_root);
        assert_eq!(attributed_version, UNKNOWN_RUNNER_HQ_CLOUD_VERSION);
        assert_eq!(repair_outcome.repair, RunnerTargetRepair::ModeRestored);
        assert_eq!(repair_outcome.state, RunnerTargetState::Runnable);
    }

    #[cfg(unix)]
    #[test]
    fn npm_cache_probe_timeout_returns_unknown_and_reaps_the_child() {
        use std::time::Instant;

        let tmp = tempfile::tempdir().unwrap();
        let child_pid_path = tmp.path().join("npm-cache-probe-child.pid");
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait")
            .arg("npm-cache-probe")
            .arg(&child_pid_path);

        let started = Instant::now();
        assert_eq!(
            npm_cache_root_from_npm_command(&mut command, Duration::from_millis(50)),
            None,
            "a timed-out probe must not establish cache provenance"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the bounded cache probe must return promptly"
        );

        let child_pid = std::fs::read_to_string(&child_pid_path)
            .expect("the stub recorded its child process")
            .trim()
            .parse::<i32>()
            .expect("the stub recorded a numeric child PID");
        let reaped_by = Instant::now() + Duration::from_millis(500);
        while unsafe { libc::kill(child_pid, 0) } == 0 && Instant::now() < reaped_by {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(
            unsafe { libc::kill(child_pid, 0) },
            0,
            "the timeout containment must not leave the npm probe child running"
        );
    }

    /// The pre-spawn decision table, including every degrade-to-spawn case.
    #[test]
    fn gate_refuses_only_a_positively_broken_target_after_one_repair() {
        use RunnerTargetGate::*;
        use RunnerTargetState::*;
        let table = [
            (Runnable, false, Spawn),
            (Runnable, true, Spawn),
            (NotExecutable, false, Repair),
            (NotExecutable, true, Refuse),
            (Missing, false, Repair),
            (Missing, true, Refuse),
            (Unreadable, false, Spawn),
            (Unreadable, true, Spawn),
            (Unresolved, false, Spawn),
            (Unresolved, true, Spawn),
        ];
        for (state, repair_attempted, expected) in table {
            assert_eq!(
                runner_target_gate(state, repair_attempted),
                expected,
                "state={state:?} repair_attempted={repair_attempted}",
            );
        }
    }

    #[test]
    fn outcome_refuses_spawn_only_after_a_repair_attempt() {
        assert!(!RunnerTargetOutcome {
            state: RunnerTargetState::NotExecutable,
            repair: RunnerTargetRepair::NotAttempted,
        }
        .refuses_spawn());
        assert!(RunnerTargetOutcome {
            state: RunnerTargetState::NotExecutable,
            repair: RunnerTargetRepair::Failed,
        }
        .refuses_spawn());
        assert!(!RunnerTargetOutcome {
            state: RunnerTargetState::Runnable,
            repair: RunnerTargetRepair::ModeRestored,
        }
        .refuses_spawn());
        assert!(!RunnerTargetOutcome::unresolved().refuses_spawn());
    }

    /// Provenance vocabulary: real facts where we have them, the pre-existing
    /// `"unknown"` where we genuinely do not.
    #[test]
    fn provenance_tokens_stay_fixed_vocabulary() {
        use RunnerTargetState::*;
        let table = [
            (Runnable, "true", "true"),
            (NotExecutable, "true", "false"),
            (Missing, "false", "false"),
            (Unreadable, "unknown", "unknown"),
            (Unresolved, "unknown", "unknown"),
        ];
        for (state, exists, executable) in table {
            assert_eq!(state.exists_token(), exists, "{state:?}");
            assert_eq!(state.executable_token(), executable, "{state:?}");
        }
        for state in [Runnable, NotExecutable, Missing, Unreadable, Unresolved] {
            assert!(state
                .class_name()
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }

    #[test]
    fn repair_tokens_stay_fixed_vocabulary() {
        for repair in [
            RunnerTargetRepair::NotAttempted,
            RunnerTargetRepair::ModeRestored,
            RunnerTargetRepair::Rematerialized,
            RunnerTargetRepair::Failed,
        ] {
            assert!(repair
                .class_name()
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_'));
        }
        assert!(!RunnerTargetRepair::NotAttempted.attempted());
        assert!(RunnerTargetRepair::Failed.attempted());
    }

    #[test]
    fn diagnosis_is_actionable_and_carries_no_path() {
        for state in [RunnerTargetState::NotExecutable, RunnerTargetState::Missing] {
            let message = runner_target_diagnosis(state);
            assert!(message.contains("HQ Sync"));
            assert!(!message.contains('/'), "{message}");
            assert!(!message.contains('\\'), "{message}");
        }
    }

    /// The purge path must be unable to escape the npx cache.
    #[test]
    fn npx_entry_dir_is_scoped_to_the_cache() {
        let cache = Path::new("/home/u/.npm/_npx");
        assert_eq!(
            npx_entry_dir_for(
                cache,
                Path::new("/home/u/.npm/_npx/abc/node_modules/.bin/x")
            ),
            Some(cache.join("abc")),
        );
        assert_eq!(
            npx_entry_dir_for(cache, Path::new("/home/u/.npm/_npx/abc")),
            Some(cache.join("abc")),
        );
        assert_eq!(
            npx_entry_dir_for(cache, Path::new("/home/u/.npm/other/x")),
            None
        );
        assert_eq!(npx_entry_dir_for(cache, Path::new("/etc/passwd")), None);
        assert_eq!(npx_entry_dir_for(cache, cache), None);
        assert_eq!(npx_entry_dir_for(cache, Path::new("/home/u/.npm")), None);
        // Never derive a purge target from a directory that is not an npx cache.
        assert_eq!(
            npx_entry_dir_for(Path::new("/home/u"), Path::new("/home/u/Documents/keep")),
            None,
        );
    }

    /// `chmod a+X`: grant exec exactly where read is already granted.
    #[cfg(unix)]
    #[test]
    fn executable_mode_never_widens_beyond_existing_read_access() {
        assert_eq!(executable_mode_for(0o600), 0o700);
        assert_eq!(executable_mode_for(0o644), 0o755);
        assert_eq!(executable_mode_for(0o640), 0o750);
        assert_eq!(executable_mode_for(0o755), 0o755);
        // No read bit means no new exec bit — never invent access.
        assert_eq!(executable_mode_for(0o200), 0o200);
    }

    /// The mode restore is the cheap repair for the observed HQ-DESKTOP-4K
    /// state and must leave the resolved script executable again.
    #[cfg(unix)]
    #[test]
    fn restore_executable_bit_follows_the_bin_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_runner(tmp.path(), 0o644);
        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::NotExecutable,
        );

        restore_executable_bit(&shim).unwrap();

        assert_eq!(
            probe_runner_target_at(&shim, ExecutableSemantics::UnixModeBits),
            RunnerTargetState::Runnable,
        );
        let real = std::fs::canonicalize(&shim).unwrap();
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o755,
            "the package script itself must be executable, not just the shim",
        );
    }
}
