//! Shared support for the HQ CLI update command layer: pure decision and
//! reporting helpers plus its async single-flight boundary.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;

/// Re-exported so probe diagnostics and their telemetry tests have a single
/// import path for the resolver's program classification and resolution lane.
pub use crate::paths::{ResolutionSource, ResolvedProgramKind};

/// npm package the menubar nags the user to keep current. The `@latest`
/// dist-tag is a MUTABLE pointer that npm re-resolves through its own
/// (app-private, persistent) packument cache and the registry CDN — a second,
/// independently-cacheable resolution of "what is latest" that can disagree
/// with the exact version the app already read from the registry's /latest
/// endpoint. Prefer [`hq_cli_package_spec`] with the resolved version; this
/// constant is the `None` fallback for call sites with no resolved target.
pub const HQ_CLI_PACKAGE: &str = "@indigoai-us/hq-cli@latest";

/// The bare package name, without any version or dist-tag suffix.
pub const HQ_CLI_PACKAGE_NAME: &str = "@indigoai-us/hq-cli";

/// Build the install spec the package manager is asked for. `Some(version)`
/// pins the EXACT version the app resolved, so the version the app compares
/// against and the version it asks npm/pnpm to install are the same string by
/// construction — no second, independently-cacheable dist-tag resolution.
/// `None` falls back to the `@latest` dist-tag only for call sites that
/// genuinely have no resolved target, so no caller silently loses its ability
/// to install.
pub fn hq_cli_package_spec(version: Option<&str>) -> String {
    match version {
        Some(version) => format!("{HQ_CLI_PACKAGE_NAME}@{version}"),
        None => HQ_CLI_PACKAGE.to_string(),
    }
}

/// Payload emitted to the frontend and returned by `check_hq_cli_update`.
#[derive(Debug, Clone, Serialize)]
pub struct HqCliUpdateInfo {
    /// Locally-installed version (None if `hq` isn't on PATH).
    pub local: Option<String>,
    /// `latest` dist-tag from the npm registry.
    pub latest: String,
}

#[derive(Debug, Deserialize)]
pub struct NpmLatest {
    pub version: String,
}

/// A closed, privacy-safe outcome for one installed-version probe. These
/// values are deliberately the only probe data allowed into Sentry: they
/// identify the failed stage without carrying a path, command output, account
/// name, environment value, or other machine-specific data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionProbeOutcome {
    NotAttempted,
    Succeeded,
    CanonicalizeFailed,
    PackageNotFound,
    ManifestReadOrParseFailed,
    /// The spawn failed for a reason none of the classified variants below
    /// cover. Kept as the residual bucket so the split is additive.
    ProcessSpawnFailed,
    /// The program exists but is not an executable image the loader accepts —
    /// Windows `ERROR_BAD_EXE_FORMAT` (os error 193) or Unix `ENOEXEC`. This is
    /// what an extensionless POSIX shim resolved on Windows produces.
    SpawnNotExecutable,
    /// The program itself was not found at the resolved path.
    SpawnProgramMissing,
    /// The program exists but this process may not execute it.
    SpawnAccessDenied,
    InterpreterNotFound,
    NonzeroExit,
    InvalidUtf8,
    EmptyOutput,
}

/// Windows `ERROR_BAD_EXE_FORMAT`: `CreateProcessW` was handed a file that is
/// not an executable image (an extensionless POSIX shim, a `.ps1`, …).
const ERROR_BAD_EXE_FORMAT: i32 = 193;
/// POSIX `ENOEXEC`, the same condition on Unix.
#[cfg(unix)]
const ENOEXEC: i32 = 8;

/// Split the spawn failure into the causes that mean different things.
///
/// Before this split every `Command::output()` error collapsed into
/// `ProcessSpawnFailed`, so a field event could not distinguish "the program is
/// absent" from "the program is present but Windows cannot execute it" from
/// "access denied" — which is exactly the ambiguity that made the Windows
/// resolver defect unreadable from telemetry.
pub fn classify_spawn_error(error: &std::io::Error) -> VersionProbeOutcome {
    match error.raw_os_error() {
        Some(ERROR_BAD_EXE_FORMAT) => return VersionProbeOutcome::SpawnNotExecutable,
        // Only Unix produces ENOEXEC; on Windows os error 8 is
        // ERROR_NOT_ENOUGH_MEMORY, an unrelated condition.
        #[cfg(unix)]
        Some(ENOEXEC) => return VersionProbeOutcome::SpawnNotExecutable,
        _ => {}
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => VersionProbeOutcome::SpawnProgramMissing,
        std::io::ErrorKind::PermissionDenied => VersionProbeOutcome::SpawnAccessDenied,
        _ => VersionProbeOutcome::ProcessSpawnFailed,
    }
}

/// A closed classification of the resolved hq binary's parent layout. This is
/// deliberately separate from the binary-anchor read outcome: a flat bin
/// directory is a normal reason the manifest lookup can miss, while an npm
/// prefix-shaped layout may still have an unreadable manifest for another
/// reason. No path is retained or sent to telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryAnchorShape {
    NotAttempted,
    NpmPrefix,
    FlatGlobalBin,
    UnresolvableParent,
}

/// Managed ("private") Node runtime state at the moment of a version probe,
/// projected into a closed, privacy-safe enum. Mirrors the variants of
/// [`crate::toolchain::ManagedRuntime`] WITHOUT its `PathBuf` payloads, so no
/// path can reach telemetry. `NotProbed` marks the paths that never classify
/// the runtime (a version read on the first try, or no `hq` at all).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRuntimeState {
    #[default]
    NotProbed,
    NotProvisioned,
    Incomplete,
    Present,
    PresentMissingNpx,
    Unknown,
}

impl ManagedRuntimeState {
    fn from_runtime(runtime: &crate::toolchain::ManagedRuntime) -> Self {
        use crate::toolchain::ManagedRuntime as R;
        match runtime {
            R::NotProvisioned => Self::NotProvisioned,
            R::Incomplete { .. } => Self::Incomplete,
            R::Present { .. } => Self::Present,
            R::PresentMissingNpx { .. } => Self::PresentMissingNpx,
            R::Unknown { .. } => Self::Unknown,
        }
    }
}

/// Outcome of the managed-Node interpreter recovery the version probe attempts
/// when a resolved `hq` cannot be read because its interpreter is
/// undiscoverable. Closed + path-free for telemetry. The core probe sets the
/// first four; the app's check flow overwrites with the `provision_*` variants
/// after it asks the existing provisioner for a managed Node and re-probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum InterpreterRecovery {
    /// No recovery was engaged — a version was read without it, or the failure
    /// is not an interpreter/spawn class a working Node could repair.
    #[default]
    NotNeeded,
    /// The version was read by retrying through HQ's managed Node.
    RecoveredWithManagedNode,
    /// Recovery was applicable but no managed Node is present to retry with.
    ManagedNodeAbsent,
    /// The check flow asked the existing provisioner to install a managed Node
    /// for a re-probe.
    ProvisionRequested,
    /// A provision was skipped because the provisioner's cooldown is active.
    ProvisionSkippedCooldown,
    /// A requested provision did not yield a usable managed Node.
    ProvisionFailed,
    /// Every recovery avenue ran and the version is still unreadable.
    StillUnreadable,
}

/// The three ordered probes used to discover an installed hq CLI version.
/// The shape remains fixed even when a successful earlier probe means a later
/// one must not execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalVersionProbeDiagnostics {
    pub binary_anchor: VersionProbeOutcome,
    pub npm_root: VersionProbeOutcome,
    pub hq_version: VersionProbeOutcome,
    pub binary_anchor_shape: BinaryAnchorShape,
    /// What kind of program the resolver actually landed on. A resolution the
    /// platform cannot execute (`extensionless`/`other_extension` on Windows)
    /// is the difference between "the CLI is broken" and "every probe happened
    /// to fail" — without it those two read identically in telemetry.
    pub resolved_program_kind: ResolvedProgramKind,
    /// The managed-Node runtime state when a recovery was considered. Lets the
    /// next occurrence say whether HQ owned the interpreter gap.
    pub managed_runtime: ManagedRuntimeState,
    /// What the managed-Node interpreter recovery did.
    pub interpreter_recovery: InterpreterRecovery,
    /// Which resolution lane produced the `hq` binary (settings PATH, managed
    /// toolchain, a user/system prefix, or the login-shell fallback).
    pub resolution_source: ResolutionSource,
}

impl LocalVersionProbeDiagnostics {
    fn not_attempted() -> Self {
        Self {
            binary_anchor: VersionProbeOutcome::NotAttempted,
            npm_root: VersionProbeOutcome::NotAttempted,
            hq_version: VersionProbeOutcome::NotAttempted,
            binary_anchor_shape: BinaryAnchorShape::NotAttempted,
            resolved_program_kind: ResolvedProgramKind::NotResolved,
            managed_runtime: ManagedRuntimeState::NotProbed,
            interpreter_recovery: InterpreterRecovery::NotNeeded,
            resolution_source: ResolutionSource::NotResolved,
        }
    }
}

fn binary_anchor_shape(hq_bin: &Path) -> BinaryAnchorShape {
    let Some(parent) = hq_bin
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return BinaryAnchorShape::UnresolvableParent;
    };
    let is_windows_npm_shim = hq_bin
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    if is_windows_npm_shim
        || matches!(
            parent.file_name().and_then(|name| name.to_str()),
            Some("bin")
        )
    {
        BinaryAnchorShape::NpmPrefix
    } else {
        BinaryAnchorShape::FlatGlobalBin
    }
}

/// The result of one version-discovery pass. `hq_installed` preserves the
/// absent-hq distinction so callers can stay quiet for people who do not have
/// the CLI while still reporting an installed-but-unreadable CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVersionProbeResult {
    pub local: Option<String>,
    pub hq_installed: bool,
    pub probes: LocalVersionProbeDiagnostics,
}

/// Three-segment numeric semver compare ("X.Y.Z[-pre]"). Pre-release
/// suffixes are dropped before comparison since the npm `latest` tag is
/// always stable. Anything that fails to parse compares as zero — we'd
/// rather under-report an update than crash the checker.
pub fn cmp_semver(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (u64, u64, u64) {
        let core = v.split('-').next().unwrap_or(v);
        let mut parts = core.split('.');
        let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    }
    parse(a).cmp(&parse(b))
}

/// Read `package.json` at `pkg` and return its `version` **iff** the
/// package name is `@indigoai-us/hq-cli`. The name guard lets us walk a
/// binary's ancestor chain and stop only at the *right* package — never a
/// parent workspace's `package.json` that happens to sit above the install.
pub fn version_if_hq_cli(pkg: &Path) -> Option<String> {
    match read_hq_cli_package_version(pkg) {
        Ok(version) => version,
        Err(()) => None,
    }
}

/// Read an hq-cli manifest while retaining enough information for the caller
/// to distinguish an absent package from an unreadable or malformed one. A
/// package for a different npm module is a normal ancestor-walk miss.
fn read_hq_cli_package_version(pkg: &Path) -> Result<Option<String>, ()> {
    let bytes = match std::fs::read(pkg) {
        Ok(bytes) => bytes,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err(()),
    };
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if parsed.get("name").and_then(|name| name.as_str()) != Some("@indigoai-us/hq-cli") {
        return Ok(None);
    }
    parsed
        .get("version")
        .and_then(|version| version.as_str())
        .map(|version| Some(version.to_string()))
        .ok_or(())
}

/// Resolve the installed version by anchoring to the *actual `hq` binary the
/// user runs*. An npm global install lays down `<prefix>/bin/hq` as a symlink
/// into `<prefix>/lib/node_modules/@indigoai-us/hq-cli/<bin script>`, so once
/// we `canonicalize` the resolved path we land *inside* the package tree and
/// can walk `ancestors()` to its `package.json`. Windows instead lays down
/// `<prefix>\hq.cmd` beside `<prefix>\node_modules`; that layout is read
/// directly from the resolved shim's parent.
///
/// This is the fix for the prefix-mismatch bug: it does NOT depend on which
/// `npm` the app resolved or what `npm root -g` reports — it reads the
/// version of the binary that's literally on the user's PATH.
pub fn version_from_hq_binary(hq_bin: &Path) -> Option<String> {
    version_from_hq_binary_probe(hq_bin).0
}

fn version_from_hq_binary_probe(hq_bin: &Path) -> (Option<String>, VersionProbeOutcome) {
    let real = match std::fs::canonicalize(hq_bin) {
        Ok(real) => real,
        Err(_) => return (None, VersionProbeOutcome::CanonicalizeFailed),
    };
    let mut saw_manifest_failure = false;
    for ancestor in real.ancestors() {
        match read_hq_cli_package_version(&ancestor.join("package.json")) {
            Ok(Some(version)) => return (Some(version), VersionProbeOutcome::Succeeded),
            Ok(None) => {}
            Err(()) => saw_manifest_failure = true,
        }
    }
    let hq_bin_str = hq_bin.to_string_lossy();
    // A pnpm-managed shim is a plain script, so canonicalize()+ancestors above can
    // never reach its package tree. Read the version from pnpm's own store, newest
    // among any lingering opaque-hash dirs so a stale leftover cannot shadow the
    // active install (pnpm points the shim at its newest global install). Done
    // before the npm-prefix fallback below so the read is anchored to the store,
    // not an arbitrary hash child in filesystem enumeration order.
    //
    // Version READING is deliberately decoupled from executor ROUTING: this tries
    // the pnpm store for ANY derivable home, not only one `is_pnpm_global_shim`
    // still routes to pnpm. A flat custom PNPM_HOME whose last component is
    // literally `bin` (store at `<home>/global` beside the shim) is a real
    // hq-cli that the collapsed router (correctly) drives with npm — but if we
    // could not read its version here, the provenance gate in
    // `install_executor_for_hq_bin` would refuse it as unidentifiable and disable
    // its update. `installed_hq_cli_version_in_pnpm_store` returns `None` when
    // there is no pnpm store beside the derived home, so npm and Bun layouts are
    // unaffected and fall through to their own reads below.
    if let Some(home) = pnpm_home_from_hq_bin(hq_bin) {
        if let Some(version) = installed_hq_cli_version_in_pnpm_store(&home.to_string_lossy()) {
            return (Some(version), VersionProbeOutcome::Succeeded);
        }
    }
    // Bun's global shim is also a plain script. Its package manifest lives in
    // `<BUN_INSTALL>/install/global/node_modules`, outside the shim's ancestor
    // chain, so read that exact global tree before considering npm layouts.
    if is_bun_global_shim(&hq_bin_str) {
        if let Some(home) = bun_home_from_hq_bin(hq_bin) {
            if let Some(version) = installed_hq_cli_version_in_bun_global(&home) {
                return (Some(version), VersionProbeOutcome::Succeeded);
            }
        }
    }
    // Windows npm does not create a symlink into the package tree. It writes
    // `<prefix>\hq.cmd` beside `<prefix>\node_modules`, so canonicalizing the
    // shim can never reach package.json through its ancestors. Anchor the
    // fallback to that exact shim's prefix instead of asking npm for its
    // unrelated default global root.
    if let Some(prefix) = npm_prefix_from_hq_bin(&hq_bin_str) {
        for package_json in hq_cli_package_json_candidates(Path::new(&prefix), hq_bin) {
            match read_hq_cli_package_version(&package_json) {
                Ok(Some(version)) => return (Some(version), VersionProbeOutcome::Succeeded),
                Ok(None) => {}
                Err(()) => saw_manifest_failure = true,
            }
        }
    }
    let outcome = if saw_manifest_failure {
        VersionProbeOutcome::ManifestReadOrParseFailed
    } else {
        VersionProbeOutcome::PackageNotFound
    };
    (None, outcome)
}

/// Parse `hq --version` output into a bare version string. Last-resort only:
/// the CLI's `index.ts` carries a hardcoded `.version("…")` string that can
/// lag the published npm version (same gotcha documented in
/// `util::hq_resolver`), so this may be stale. We still prefer a possibly-
/// stale number over returning None and silently disabling the nag.
pub fn hq_version_string(bin: &Path) -> Option<String> {
    hq_version_string_probe(bin, &paths::child_path()).0
}

fn hq_version_string_probe(bin: &Path, path: &str) -> (Option<String>, VersionProbeOutcome) {
    let bin = bin.to_string_lossy();
    let mut cmd = paths::spawn_command(&bin, &[]);
    let out = match cmd.arg("--version").env("PATH", path).output() {
        Ok(output) => output,
        Err(error) => return (None, classify_spawn_error(&error)),
    };
    if !out.status.success() {
        return (
            None,
            if out.status.code() == Some(127) {
                VersionProbeOutcome::InterpreterNotFound
            } else {
                VersionProbeOutcome::NonzeroExit
            },
        );
    }
    let s = match String::from_utf8(out.stdout) {
        Ok(stdout) => stdout,
        Err(_) => return (None, VersionProbeOutcome::InvalidUtf8),
    };
    let Some(line) = s.lines().next() else {
        return (None, VersionProbeOutcome::EmptyOutput);
    };
    let line = line.trim();
    let cleaned = line.trim_start_matches('v').trim();
    if cleaned.is_empty() {
        (None, VersionProbeOutcome::EmptyOutput)
    } else {
        (Some(cleaned.to_string()), VersionProbeOutcome::Succeeded)
    }
}

/// A `hq --version` failure a *working* Node interpreter could plausibly
/// repair: the shim resolved but its `#!/usr/bin/env node` interpreter was not
/// on the child PATH (exit 127 → `InterpreterNotFound`), or — on Unix, where
/// the resolver hands back anything it found — the shim could not be spawned at
/// all. Every other outcome (a real nonzero exit, empty/invalid output) is not
/// an interpreter problem, so recovery would be pointless and must not fire.
fn recovery_applicable(outcome: VersionProbeOutcome) -> bool {
    match outcome {
        VersionProbeOutcome::InterpreterNotFound => true,
        #[cfg(unix)]
        VersionProbeOutcome::SpawnProgramMissing | VersionProbeOutcome::SpawnNotExecutable => true,
        _ => false,
    }
}

/// The managed Node executable to recover with, for the one runtime state that
/// owns one. `None` for every other state, so recovery can never fabricate an
/// interpreter path from a runtime that has not got one.
fn managed_node_executable(runtime: &crate::toolchain::ManagedRuntime) -> Option<&Path> {
    match runtime {
        crate::toolchain::ManagedRuntime::Present { node } => Some(node.as_path()),
        _ => None,
    }
}

/// Whether the resolved program is a `#!` script whose interpreter line names
/// `node` (directly or via `env node`). Bounded read of only the first line;
/// any read failure or a non-node interpreter answers `false`, so the direct
/// `<node> <program>` invocation is gated to genuine node entrypoints and never
/// runs a Volta/asdf shim binary as if it were JavaScript.
#[cfg(unix)]
fn shebang_names_node(program: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(program) else {
        return false;
    };
    let mut head = [0u8; 128];
    let read = match file.read(&mut head) {
        Ok(read) => read,
        Err(_) => return false,
    };
    let head = &head[..read];
    if !head.starts_with(b"#!") {
        return false;
    }
    let first_line = head.split(|&byte| byte == b'\n').next().unwrap_or(head);
    let Ok(first_line) = std::str::from_utf8(first_line) else {
        return false;
    };
    // The interpreter is a whitespace token on the shebang line: `#!/usr/bin/node`,
    // `#!/usr/bin/env node`, and `#!/usr/bin/env -S node --flag` all carry a
    // `node`(or versioned `nodejs`) token. Requiring an explicit token means a
    // bare `#!/usr/bin/env` with only flags never qualifies.
    first_line
        .trim_start_matches("#!")
        .split_whitespace()
        .any(|token| {
            let name = Path::new(token)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(token);
            name == "node" || name == "nodejs"
        })
}

/// Parse a `node`/`hq --version` stdout line into a bare version string. Shared
/// by the direct-node recovery read.
#[cfg(unix)]
fn parse_version_line(stdout: &str) -> (Option<String>, VersionProbeOutcome) {
    let Some(line) = stdout.lines().next() else {
        return (None, VersionProbeOutcome::EmptyOutput);
    };
    let cleaned = line.trim().trim_start_matches('v').trim();
    if cleaned.is_empty() {
        (None, VersionProbeOutcome::EmptyOutput)
    } else {
        (Some(cleaned.to_string()), VersionProbeOutcome::Succeeded)
    }
}

/// Run `<node> <program> --version` directly, bypassing the shebang. Used only
/// when [`shebang_names_node`] confirmed the program is a node entrypoint but
/// the shebang's own interpreter lookup failed.
#[cfg(unix)]
fn hq_version_via_node(
    node: &Path,
    program: &Path,
    path: &str,
) -> (Option<String>, VersionProbeOutcome) {
    let node = node.to_string_lossy();
    let program = program.to_string_lossy();
    let mut cmd = paths::spawn_command(node.as_ref(), &[program.as_ref(), "--version"]);
    let out = match cmd.env("PATH", path).output() {
        Ok(output) => output,
        Err(error) => return (None, classify_spawn_error(&error)),
    };
    if !out.status.success() {
        return (
            None,
            if out.status.code() == Some(127) {
                VersionProbeOutcome::InterpreterNotFound
            } else {
                VersionProbeOutcome::NonzeroExit
            },
        );
    }
    match String::from_utf8(out.stdout) {
        Ok(stdout) => parse_version_line(&stdout),
        Err(_) => (None, VersionProbeOutcome::InvalidUtf8),
    }
}

/// Read `hq --version`, and when the read fails because the shim's interpreter
/// is undiscoverable, recover through HQ's managed Node before giving up.
///
/// Recovery is bounded and side-effect-free: at most one widened-PATH retry and
/// (for a node-shebanged shim on Unix) one direct `<node> <program>` retry, both
/// using the managed Node already on disk. It never installs anything —
/// provisioning a *missing* managed Node is the app check flow's job
/// (`recover_unreadable_version_once`). Returns the version, the probe outcome,
/// the projected managed-runtime state, and what the recovery did.
fn hq_version_with_recovery(
    hq: Option<&Path>,
    path: &str,
    managed: Option<&crate::toolchain::ManagedRuntime>,
) -> (
    Option<String>,
    VersionProbeOutcome,
    ManagedRuntimeState,
    InterpreterRecovery,
) {
    let Some(hq) = hq else {
        return (
            None,
            VersionProbeOutcome::NotAttempted,
            ManagedRuntimeState::NotProbed,
            InterpreterRecovery::NotNeeded,
        );
    };

    let (local, outcome) = hq_version_string_probe(hq, path);
    if local.is_some() || !recovery_applicable(outcome) {
        return (
            local,
            outcome,
            ManagedRuntimeState::NotProbed,
            InterpreterRecovery::NotNeeded,
        );
    }

    // The read failed on an interpreter/spawn class. Consult the managed runtime
    // the caller classified — tests inject a fixture, production passes the real
    // `classify_runtime()`. Absent (`None`) means the caller did not classify,
    // so there is nothing to recover with.
    let Some(managed) = managed else {
        return (
            local,
            outcome,
            ManagedRuntimeState::NotProbed,
            InterpreterRecovery::NotNeeded,
        );
    };
    let managed_state = ManagedRuntimeState::from_runtime(managed);
    let Some(node) = managed_node_executable(managed) else {
        return (
            local,
            outcome,
            managed_state,
            InterpreterRecovery::ManagedNodeAbsent,
        );
    };

    if let Some(node_bin) = node.parent() {
        // Retry 1: put the managed Node's own bin dir first on the child PATH so
        // the shim's `env node` resolves it.
        let widened = paths::path_with_interpreter_hint(path, node_bin);
        let (recovered, recovered_outcome) = hq_version_string_probe(hq, &widened);
        if recovered.is_some() {
            return (
                recovered,
                recovered_outcome,
                managed_state,
                InterpreterRecovery::RecoveredWithManagedNode,
            );
        }

        // Retry 2 (Unix): if the shim is a node entrypoint, run it under the
        // managed Node directly, bypassing the shebang lookup entirely.
        #[cfg(unix)]
        if shebang_names_node(hq) {
            let (recovered, recovered_outcome) = hq_version_via_node(node, hq, &widened);
            if recovered.is_some() {
                return (
                    recovered,
                    recovered_outcome,
                    managed_state,
                    InterpreterRecovery::RecoveredWithManagedNode,
                );
            }
        }
    }

    (
        local,
        outcome,
        managed_state,
        InterpreterRecovery::StillUnreadable,
    )
}

/// Resolve the installed `@indigoai-us/hq-cli` version. Returns `None`
/// only when the CLI genuinely isn't installed (or, rarely, is installed
/// but unreadable by every probe — `check_once` Sentry-captures that case).
///
/// Resolution order (first hit wins):
///   1. Binary-anchored — `version_from_hq_binary(resolve_bin("hq"))`.
///      Authoritative and prefix-independent.
///   2. `npm root -g` package.json — retained for non-symlink layouts.
///   3. `hq --version` — last resort (may lag; see `hq_version_string`).
pub fn get_local_version() -> Option<String> {
    get_local_version_diagnostics().local
}

/// Discover the local version once and retain the bounded outcomes needed to
/// diagnose the otherwise-undifferentiated None result.
pub fn get_local_version_diagnostics() -> LocalVersionProbeResult {
    // Keep the resolver call order unchanged: do not look up npm when the
    // binary-anchored package probe has already succeeded.
    //
    // The resolver's classification travels with the path. A Windows
    // resolution that exists but cannot be spawned stays `hq_installed` and
    // still reports — it is a broken CLI, not an absent one.
    let hq = paths::resolve_bin_with_kind("hq");
    // Attribute the resolution lane once, from the resolved path, and stamp it
    // onto whichever result the branches below produce. Best-effort telemetry
    // only — it never changes which binary was chosen.
    let resolution_source = if hq.is_resolved() {
        paths::resolution_source_of(Path::new(&hq.path))
    } else {
        ResolutionSource::NotResolved
    };

    let mut result = if hq.is_resolved() {
        let hq_path = Path::new(&hq.path);
        let binary_anchor_shape = binary_anchor_shape(hq_path);
        let (local, binary_anchor) = version_from_hq_binary_probe(hq_path);
        if let Some(local) = local {
            LocalVersionProbeResult {
                local: Some(local),
                hq_installed: true,
                probes: LocalVersionProbeDiagnostics {
                    binary_anchor,
                    binary_anchor_shape,
                    resolved_program_kind: hq.kind,
                    ..LocalVersionProbeDiagnostics::not_attempted()
                },
            }
        } else {
            let npm = paths::resolve_bin("npm");
            let npm = (npm != "npm").then_some(npm.as_str());
            // The binary-anchored read failed on a RESOLVED `hq`. Classify HQ's
            // managed Node once so the version probe can recover through it and
            // the diagnostics can say whether HQ owned the interpreter gap.
            let managed = crate::toolchain::classify_runtime();
            probe_local_version_after_binary(
                Some(hq_path),
                binary_anchor,
                binary_anchor_shape,
                hq.kind,
                Some(&managed),
                npm,
                &paths::child_path(),
            )
        }
    } else {
        // Preserve the legacy npm-root fallback even when `hq` is absent: an npm
        // package may exist before its bin-link is created. The result still
        // marks hq as absent, so an all-fail check remains a quiet no-op — and
        // no managed-Node recovery is attempted (there is no shim to run).
        let npm = paths::resolve_bin("npm");
        let npm = (npm != "npm").then_some(npm.as_str());
        probe_local_version_after_binary(
            None,
            VersionProbeOutcome::NotAttempted,
            BinaryAnchorShape::NotAttempted,
            ResolvedProgramKind::NotResolved,
            None,
            npm,
            &paths::child_path(),
        )
    };

    result.probes.resolution_source = resolution_source;
    result
}

#[cfg(test)]
fn probe_local_version(
    hq: Option<&Path>,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    // Unix resolution reports `Exe` for anything it found; see
    // `paths::resolve_bin_with_kind`.
    let kind = match hq {
        Some(_) => ResolvedProgramKind::Exe,
        None => ResolvedProgramKind::NotResolved,
    };
    probe_local_version_with_kind(hq, kind, npm, path)
}

#[cfg(test)]
fn probe_local_version_with_kind(
    hq: Option<&Path>,
    resolved_program_kind: ResolvedProgramKind,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    // Legacy seam: no managed Node injected, so no interpreter recovery runs and
    // the observable `local`/`hq_version` stay exactly as before this change.
    probe_local_version_with_managed(hq, resolved_program_kind, None, npm, path)
}

/// Test seam that also injects the managed-Node runtime, so the interpreter
/// recovery is exercisable with fixture paths and no real toolchain. Mirrors
/// `probe_local_version_with_kind`'s binary-anchor handling.
#[cfg(test)]
fn probe_local_version_with_managed(
    hq: Option<&Path>,
    resolved_program_kind: ResolvedProgramKind,
    managed: Option<&crate::toolchain::ManagedRuntime>,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    let (local, binary_anchor) = match hq {
        Some(hq) => version_from_hq_binary_probe(hq),
        None => (None, VersionProbeOutcome::NotAttempted),
    };
    let binary_anchor_shape = hq
        .map(binary_anchor_shape)
        .unwrap_or(BinaryAnchorShape::NotAttempted);
    if let Some(local) = local {
        return LocalVersionProbeResult {
            local: Some(local),
            hq_installed: hq.is_some(),
            probes: LocalVersionProbeDiagnostics {
                binary_anchor,
                binary_anchor_shape,
                resolved_program_kind,
                ..LocalVersionProbeDiagnostics::not_attempted()
            },
        };
    }
    probe_local_version_after_binary(
        hq,
        binary_anchor,
        binary_anchor_shape,
        resolved_program_kind,
        managed,
        npm,
        path,
    )
}

fn probe_local_version_after_binary(
    hq: Option<&Path>,
    binary_anchor: VersionProbeOutcome,
    binary_anchor_shape: BinaryAnchorShape,
    resolved_program_kind: ResolvedProgramKind,
    managed: Option<&crate::toolchain::ManagedRuntime>,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    let hq_installed = hq.is_some();
    let (npm_local, npm_root) = match npm {
        Some(npm) => read_installed_version_probe(npm, path),
        None => (None, VersionProbeOutcome::NotAttempted),
    };
    if let Some(local) = npm_local {
        return LocalVersionProbeResult {
            local: Some(local),
            hq_installed,
            probes: LocalVersionProbeDiagnostics {
                binary_anchor,
                npm_root,
                hq_version: VersionProbeOutcome::NotAttempted,
                binary_anchor_shape,
                resolved_program_kind,
                ..LocalVersionProbeDiagnostics::not_attempted()
            },
        };
    }

    let (local, hq_version, managed_runtime, interpreter_recovery) =
        hq_version_with_recovery(hq, path, managed);
    LocalVersionProbeResult {
        local,
        hq_installed,
        probes: LocalVersionProbeDiagnostics {
            binary_anchor,
            npm_root,
            hq_version,
            binary_anchor_shape,
            resolved_program_kind,
            managed_runtime,
            interpreter_recovery,
            resolution_source: ResolutionSource::NotResolved,
        },
    }
}

/// Does this machine need `latest` installed?
///
/// - A readable version older than `latest` — the ordinary update.
/// - No readable version **and no `hq` binary found at all** — the machine has
///   never had the CLI. This is the case the app previously ignored: the old
///   inline `match` in `check_once` returned false whenever the version was
///   unreadable, so a user with no CLI reported "no update available" and the
///   background installer never ran for them.
///
/// `hq_installed` is deliberately load-bearing. A binary that IS present but
/// whose version cannot be read is ambiguous — it may be our own install left
/// broken by an interrupted global install, or it may be an unrelated program
/// named `hq` — and this function cannot tell those apart from a version string.
/// Claiming an install is needed there would put the installer in front of a
/// decision it also cannot make safely, and (since it refuses) would retry
/// fruitlessly on every check. That case keeps today's behaviour and stays
/// visible through `should_report_unreadable_version`, which already reports it.
///
/// Extracted from `check_once` so the arm that a healthy environment never takes
/// is actually testable.
pub fn cli_install_needed(local: Option<&str>, latest: &str, hq_installed: bool) -> bool {
    match local {
        Some(installed) => cmp_semver(installed, latest) == std::cmp::Ordering::Less,
        None => !hq_installed,
    }
}

/// An unreadable version is actionable only when the hq resolver found a
/// binary. A missing hq remains a deliberate quiet no-op.
pub fn should_report_unreadable_version(result: &LocalVersionProbeResult) -> bool {
    result.local.is_none() && result.hq_installed
}

/// Read `cliAutoUpdate` directly from menubar.json (untyped) so the background
/// checker never blocks on a typed round-trip and picks up a Settings toggle
/// without a restart. Mirrors `dm_notify::dm_notifications_enabled`. Defaults
/// to true — the app keeps the CLI current unless the user opts out.
pub fn cli_auto_update_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let Ok(contents) = std::fs::read_to_string(dir.join("menubar.json")) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("cliAutoUpdate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Master automatic-updates switch (`autoUpdate` in menubar.json), default
/// ON. Read untyped like `cli_auto_update_enabled` so every updater (menubar
/// app, `hq` CLI, hq-core) picks the toggle up without a restart. This is the
/// single gate the CLI background auto-installer now uses; the app + core
/// silent installs gate on it frontend-side. A missing/corrupt config reads as
/// `true` — the same fail-open leniency `cli_auto_update_enabled` uses, which
/// matches the "keep everything current unless the user opts out" intent.
pub fn auto_update_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let Ok(contents) = std::fs::read_to_string(dir.join("menubar.json")) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("autoUpdate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// menubar.json key that records the most recent CLI version the user
/// dismissed the "update available" notice for. Read untyped (same leniency
/// as `cli_auto_update_enabled`) so the background loop picks it up without a
/// restart, and written through the untyped-merge path so it survives the
/// typed `save_settings` round-trip.
pub const DISMISSED_VERSION_KEY: &str = "cliUpdateDismissedVersion";

/// The version the user last dismissed the CLI-update notice for, if any.
/// `None` when the key is absent / unreadable — i.e. nothing dismissed, so
/// the notice is free to show.
pub fn dismissed_cli_version() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(DISMISSED_VERSION_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Pure dismissal decision: should the live "update available" banner be
/// suppressed for `latest` given the version the user last `dismissed`?
///
/// Per-version semantics: a dismissal is sticky for the version it was made
/// against and is re-shown only when a **strictly newer** `latest` appears —
/// dismissing 5.38.x stays dismissed until 5.39 (or any greater version) is
/// published. We compare with `cmp_semver` so a dismissed "5.38.2" suppresses
/// "5.38.2" (Equal) but not "5.39.0" (Greater → show again). A newly published
/// version is exactly the fix users are being emailed about, so re-surfacing
/// it once (still dismissible) is the intended non-nagging behavior.
pub fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool {
    match dismissed {
        Some(d) => cmp_semver(latest, d) != std::cmp::Ordering::Greater,
        None => false,
    }
}

/// Whether the live banner should be suppressed for `latest` because the user
/// already dismissed it. Reads the persisted dismissal then applies the pure
/// `suppress_for_dismissal` rule.
pub fn is_cli_update_dismissed(latest: &str) -> bool {
    suppress_for_dismissal(latest, dismissed_cli_version().as_deref())
}

/// menubar.json key recording a `latest` whose install npm reported as
/// successful but which left the detected local version untouched. Read/written
/// untyped through the same path as `DISMISSED_VERSION_KEY`.
pub const NON_CONVERGENT_VERSION_KEY: &str = "cliUpdateNonConvergentVersion";

/// The version an earlier install completed on without moving the detected
/// version, if any. `None` when the key is absent, `null`, or unreadable.
pub fn non_convergent_cli_version() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(NON_CONVERGENT_VERSION_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// menubar.json key recording WHICH contract wrote the non-convergent marker.
/// Present (== [`PINNED_MARKER_CONTRACT`]) only for markers written after the
/// installer began pinning the exact resolved version; absent on legacy markers
/// written under the racy `@latest` dist-tag contract. Its presence is what
/// separates a block backed by delivery evidence from one a transient registry
/// race may have produced.
pub const NON_CONVERGENT_CONTRACT_KEY: &str = "cliUpdateNonConvergentContract";

/// The contract tag a pinned-install non-convergence writes beside its version.
/// A marker carrying it represents a real, delivery-backed layout defect and
/// blocks auto-update permanently; a marker without it earns one recovery
/// re-attempt (see [`legacy_marker_needs_recovery`]).
pub const PINNED_MARKER_CONTRACT: &str = "pinned-v1";

/// The contract tag recorded beside the non-convergent version, if any. `None`
/// when the key is absent, `null`, or unreadable — i.e. a legacy marker.
pub fn non_convergent_cli_contract() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(NON_CONVERGENT_CONTRACT_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Does a persisted non-convergent marker predate the pinned-install contract
/// and therefore deserve exactly one recovery re-attempt? True iff a version is
/// recorded but it carries no pinned contract tag. Such a marker may have been
/// written by the `@latest` dist-tag race — a transient registry lag that
/// installed N-1 and then permanently disabled auto-install of N — so clearing
/// it once lets the next scheduled check re-install under the pinned contract.
/// A marker that IS pinned is backed by delivery evidence and keeps blocking, so
/// this returns false for it (no unbounded loop for a genuinely stuck layout).
pub fn legacy_marker_needs_recovery(contract: Option<&str>, version: Option<&str>) -> bool {
    version.is_some() && contract != Some(PINNED_MARKER_CONTRACT)
}

/// Version of the `hq` the app will actually **execute** — the only probe valid
/// for proving an install converged.
///
/// `get_local_version` deliberately falls back to `npm root -g`. That is right
/// for the banner (it answers "is something stale installed?") but fatal as a
/// convergence proof: when the resolved `hq` is a pnpm or Homebrew copy npm
/// cannot replace, an `npm install -g` moves the npm-root reading to `latest`
/// while the executable the app actually runs stays stale. Accepting that
/// reading would let the updater declare victory over an install it never
/// touched, mark the CLI current forever, and leave the app quietly running the
/// old binary — a quieter version of the same bug this module is fixing.
///
/// So this probe stays bound to the resolved binary: anchor into its own
/// package tree, and failing that ask the binary itself. Never `npm root -g`.
pub fn resolved_hq_version(hq_bin: &str) -> Option<String> {
    if hq_bin == "hq" {
        return None;
    }
    let path = Path::new(hq_bin);
    version_from_hq_binary(path).or_else(|| hq_version_string(path))
}

/// Replace every occurrence of the home directory with `~`. Sentry extras want
/// the install *layout* (`~/Library/pnpm/hq` tells us everything we need); the
/// account name in front of it is personal data we have no reason to ship.
///
/// Global replace, not a prefix strip: this also runs over npm stderr, where
/// home paths appear mid-string (`EACCES: permission denied, mkdir
/// '/Users/alice/…'`) rather than at the front. `/` as a home directory is
/// ignored — replacing every slash would destroy the text it is meant to
/// sanitise.
pub fn redact_home_in(text: &str, home: Option<&str>) -> String {
    match home {
        Some(h) if !h.is_empty() && h != "/" => text.replace(h, "~"),
        _ => text.to_string(),
    }
}

/// `redact_home_in` against this machine's real home directory.
pub fn redact_home(path: &str) -> String {
    let home = paths::home_dir().map(|h| h.to_string_lossy().to_string());
    redact_home_in(path, home.as_deref())
}

/// Did an install npm reported as successful actually move the version the app
/// detects?
///
/// A zero exit only proves npm wrote a package *somewhere*. When the resolved
/// `hq` is managed by something npm cannot replace — a pnpm shim, a Homebrew
/// formula, a copy shadowed earlier on PATH — npm writes a perfectly good
/// package into a prefix nothing reads, and `get_local_version` keeps returning
/// the old number. `after` is the post-install reading; convergence means it
/// reached `latest`. A reading that stands still, creeps to something still
/// short of `latest`, or goes blind entirely all mean the install did not take
/// effect where it counts.
pub fn install_converged(after: Option<&str>, latest: &str) -> bool {
    match after {
        Some(a) => cmp_semver(a, latest) != std::cmp::Ordering::Less,
        None => false,
    }
}

/// Result of comparing the binary resolved before an npm install with the one
/// resolved after it. A successful install can legitimately move resolution to
/// a newly-installed binary, so the post-install probe is authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvergenceVerdict {
    Converged,
    RelocatedAndConverged,
    NonConvergent,
}

/// Which package manager actually performed the install. Two executors reach
/// the same convergence gate, and before this tag existed a non-convergent
/// event could not say which one ran: the pnpm branch passed no prefix, so its
/// events rendered the npm branch's "npm default prefix" placeholder and read
/// as npm runs. Closed domain; never a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallExecutor {
    Npm,
    Pnpm,
    Bun,
}

impl InstallExecutor {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Bun => "bun",
        }
    }
}

/// Whether the installer we ran was aimed at the executable the desktop app
/// resolves after the install. This is deliberately derived from values the
/// updater already has; probing `npm root -g` here would create another process
/// boundary and could only make the convergence verdict less trustworthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonConvergenceKind {
    NpmTargeted,
    /// pnpm ran against the global home derived from the resolved shim and the
    /// target WAS delivered into pnpm's own global store, yet the executed shim
    /// still reports the old version — a genuine shadowing defect (a different
    /// `hq` copy earlier on PATH wins). Same class as `NpmTargeted`: the
    /// installer landed the target and the update still did not take effect where
    /// the app executes, so it stays loud instead of being bounded like a foreign
    /// layout. Whether pnpm's native `pnpm bin -g` happens to equal the shim dir
    /// is recorded as a diagnostic only; it is never a gate on this class, since
    /// on the pnpm >=11 nested layout the native global bin dir legitimately
    /// differs from the forced one the install (correctly) wrote to.
    PnpmTargeted,
    BunTargeted,
    ForeignManaged,
    /// npm delivered the target into HQ's managed npm prefix, yet the app still
    /// resolves a SECOND HQ-managed copy of the CLI from a different directory
    /// inside the SAME managed toolchain root (on Windows: `<root>\npm-prefix`
    /// was written but `<root>\node\hq.cmd` still wins resolution). This is not a
    /// foreign layout HQ cannot drive — HQ owns BOTH copies — so it is neither
    /// blindly bounded like a foreign layout nor left to wedge auto-update.
    /// Instead HQ removes its own shadow copy and re-resolves; the durable marker
    /// is written only if that self-repair could not converge (see
    /// [`ManagedShadowRepairOutcome`]).
    ManagedShadowed,
    /// npm was aimed at the resolved binary's own prefix, yet the target version
    /// was never delivered INTO that prefix — the manifest there does not report
    /// the version we asked for. That is not a layout defect (the installer had
    /// the right target); it is a transient registry/resolution shortfall: npm
    /// resolved the requested version to an older one, or the CDN/packument
    /// cache lagged the publish. It must NOT wedge auto-update — the next
    /// scheduled check simply retries.
    ResolutionShortfall,
    /// HQ never aimed the installer at the copy the app executes, so the install
    /// could not converge and HQ cannot prove a layout defect. Two shapes reach
    /// here: (1) the resolved `hq` is an npm **npx-cache** copy
    /// (`…/_npx/…/node_modules/.bin/hq`) — ephemeral and un-updatable by any
    /// global install, so no executor could ever move it; and (2) a pnpm/Bun run
    /// whose global home could not be derived from the resolved shim, so the
    /// child was spawned into the ambient environment and may have written a
    /// directory the app never reads. Unlike [`Self::ForeignManaged`] — a layout
    /// HQ provably aimed at and provably could not move — this is a shape HQ
    /// never aimed correctly, so it must stay observable but NEVER wedge
    /// auto-update: it writes no durable marker and is bounded to one capture per
    /// episode, exactly like [`Self::ResolutionShortfall`].
    InstallerUnaimed,
}

impl NonConvergenceKind {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::NpmTargeted => "npm-targeted",
            Self::PnpmTargeted => "pnpm-targeted",
            Self::BunTargeted => "bun-targeted",
            Self::ForeignManaged => "foreign-managed",
            Self::ManagedShadowed => "managed-shadowed",
            Self::ResolutionShortfall => "resolution-shortfall",
            Self::InstallerUnaimed => "installer-unaimed",
        }
    }

    /// Did we aim the installer at the binary the app resolves AND see the
    /// target delivered there? Targeted non-convergence is a genuine updater
    /// defect and is reported on every occurrence; a foreign layout is an
    /// environment shape we cannot drive and is bounded to one capture per
    /// episode. A resolution shortfall was aimed correctly but delivered
    /// nothing, so it is neither — it stays observable but never blocks.
    pub fn is_installer_targeted(self) -> bool {
        matches!(
            self,
            Self::NpmTargeted | Self::PnpmTargeted | Self::BunTargeted
        )
    }

    /// May a non-convergence of this kind persist the durable marker that stops
    /// the background auto-installer? Only a defect backed by evidence that the
    /// installer actually delivered the target INTO the store the app executes
    /// from may block. A resolution shortfall never delivered the target, and an
    /// installer-unaimed shape was never aimed at the executed copy at all, so
    /// both stay loud (bounded per episode) but must never block — otherwise a
    /// transient registry lag, or an un-updatable npx copy, would permanently
    /// disable auto-update.
    pub fn may_block_auto_update(self) -> bool {
        !matches!(self, Self::ResolutionShortfall | Self::InstallerUnaimed)
    }
}

/// What HQ's self-repair of a [`NonConvergenceKind::ManagedShadowed`] layout
/// achieved, as a CLOSED telemetry token (never a path). It is the input that
/// makes the managed-shadow blocking decision conditional: a run where the
/// removal is not yet attempted (or a caller that does not repair) writes NO
/// durable marker so the next check self-heals, while a run whose repair could
/// not converge falls back to the foreign-managed policy (bounded capture plus
/// the durable marker) so a machine HQ cannot repair stops re-paging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedShadowRepairOutcome {
    /// No removal was attempted for this decision — the pre-repair
    /// classification, and the value carried by every non-shadow kind.
    NotAttempted,
    /// The shadow was removed and the app now resolves the managed prefix copy
    /// at `latest`. (In that case the convergence verdict is itself successful,
    /// so this value never rides an emitted non-convergent event.)
    Converged,
    /// A removal ran but the machine is still shadowed — an unlink error (a
    /// Windows sharing violation while an `hq` process holds the file open) or a
    /// further copy the enumeration did not own.
    RepairFailed,
    /// A provenance/safety gate refused the removal: the shadow's own manifest
    /// is not `@indigoai-us/hq-cli`, or the managed prefix does not yet hold
    /// `>= latest`. Removing nothing is the safe outcome.
    ProvenanceRefused,
}

impl ManagedShadowRepairOutcome {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::NotAttempted => "not-attempted",
            Self::Converged => "converged",
            Self::RepairFailed => "repair-failed",
            Self::ProvenanceRefused => "provenance-refused",
        }
    }
}

/// The concrete result of the enumerated removal itself, distinct from the
/// post-re-resolve [`ManagedShadowRepairOutcome`] the caller derives once it has
/// re-checked what the app now executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedShadowRepairAction {
    /// Every enumerated shim and the scoped package directory are gone (or were
    /// already absent).
    Removed,
    /// A provenance/safety gate refused before any unlink ran.
    ProvenanceRefused,
    /// At least one unlink failed with an error other than "not found".
    RemovalFailed,
}

/// Classify a failed convergence without guessing a prefix. A flat pnpm/asdf
/// directory is intentionally foreign managed for the npm executor: npm has no
/// safe prefix to pass and may write a valid package somewhere the app will
/// never execute. The pnpm executor is targeted exactly when we derived its
/// global environment from the resolved shim and handed it to the child.
///
/// `target_delivered` is the delivery evidence for BOTH targeted arms: whether a
/// manifest inside the store the installer wrote reports the version we asked
/// for. When an installer was aimed at the resolved binary's location but the
/// target was never delivered, the "targeted" match is a tautology (the location
/// was itself derived from that same binary) covering a transient resolution
/// shortfall, not a layout defect — so it is classified as such and must not
/// block. For the pnpm arm this evidence now comes from pnpm's own answer
/// (`pnpm ls -g --json`, `pnpm root -g`, then the corrected store enumeration),
/// which reads both the pnpm <=10 and pnpm >=11 store layouts.
///
/// The direction of pnpm's native `pnpm bin -g` is deliberately NOT an input
/// here. The forced-flag probe that once fed this decision was a tautology (it
/// echoed the `--config.global-bin-dir` the install handed it), and once the
/// probe is made honest it legitimately disagrees with the shim dir on the pnpm
/// >=11 nested layout — where the install correctly forces the nested bin dir but
/// pnpm's native global bin dir is the flat home. Blocking is therefore gated on
/// real delivery evidence plus the post-install reading of the executed binary
/// alone; the native-direction observation survives only as a diagnostic tag.
/// `managed_roots` are the HQ-managed toolchain roots the CALLER discovered
/// (via `paths::managed_toolchain_roots()`); passing them in keeps this a pure,
/// filesystem-free decision. They are consulted only for the npm arm's
/// same-root shadow detection — an empty slice reproduces the prior behaviour
/// exactly, so every non-shadow caller and every existing test stays unchanged.
pub fn non_convergence_kind(
    executor: InstallExecutor,
    npm_prefix_passed: Option<&str>,
    pnpm_targeted: bool,
    post_install_hq_bin: &str,
    target_delivered: bool,
    managed_roots: &[PathBuf],
) -> NonConvergenceKind {
    // An npx-cache copy can never be updated by ANY executor: npm materialises it
    // per `npx` invocation, keyed by the invocation's package specs, not by any
    // global prefix. So whichever executor ran, still resolving one after the
    // install means HQ was never aimed at an updatable copy — classify it
    // non-blocking (installer-unaimed) rather than wedging auto-update on a
    // version no install can move. In production the `hq` resolver already skips
    // npx paths, so this is defence-in-depth plus the exact classification the
    // live macOS event carries.
    if paths::is_npx_cache_path(Path::new(post_install_hq_bin)) {
        return NonConvergenceKind::InstallerUnaimed;
    }
    match executor {
        InstallExecutor::Pnpm => {
            if !pnpm_targeted {
                // Underivable layout, or a child PATH that never saw the shim
                // dir: we could not aim pnpm at the executed copy, so this is the
                // ambient-spawn unaimed shape. It stays observable but must never
                // wedge auto-update — HQ never proved it aimed at this copy.
                NonConvergenceKind::InstallerUnaimed
            } else if target_delivered {
                // pnpm delivered the target into its own global store, yet the
                // executed shim still reports the old version: genuine shadowing,
                // the same defect class as `NpmTargeted`.
                NonConvergenceKind::PnpmTargeted
            } else {
                // Aimed at the right home but the target was never delivered — a
                // transient registry/resolution shortfall, exactly as the npm
                // arm treats an undelivered matching prefix.
                NonConvergenceKind::ResolutionShortfall
            }
        }
        InstallExecutor::Bun => {
            if !pnpm_targeted {
                // Same as the pnpm arm: an unaimed Bun run was never aimed at the
                // executed copy, so it stays observable but never blocks.
                NonConvergenceKind::InstallerUnaimed
            } else if target_delivered {
                NonConvergenceKind::BunTargeted
            } else {
                NonConvergenceKind::ResolutionShortfall
            }
        }
        InstallExecutor::Npm => match (
            npm_prefix_passed,
            npm_prefix_from_hq_bin(post_install_hq_bin),
        ) {
            (Some(passed), Some(active_prefix)) if passed == active_prefix => {
                // Aiming npm at the resolved binary's prefix is a tautology when
                // the binary did not move — the passed prefix was derived from
                // that same path. Only a manifest at the target INSIDE that
                // prefix proves the installer actually delivered it (genuine
                // shadowing). Without that evidence this is a transient
                // resolution shortfall and must not wedge auto-update.
                if target_delivered {
                    NonConvergenceKind::NpmTargeted
                } else {
                    NonConvergenceKind::ResolutionShortfall
                }
            }
            // The passed prefix and the prefix behind the resolved binary DIFFER,
            // the installer provably delivered the target into the one it aimed
            // at, and BOTH live inside the same HQ-managed toolchain root: HQ owns
            // both copies (on Windows, `<root>\npm-prefix` written vs `<root>\node`
            // resolved). That is a repairable managed shadow, not the foreign
            // layout HQ cannot drive. Same-root containment is compared by path
            // components with case-insensitive matching on Windows, never raw
            // string equality, so a trailing separator or mixed case cannot flip
            // it — and a cross-root split (`IndigoHQ` vs legacy `Indigo HQ`) is not
            // a single shadow and falls through to foreign-managed below.
            (Some(passed), Some(active_prefix))
                if target_delivered
                    && paths::both_within_same_managed_root(
                        Path::new(passed),
                        Path::new(active_prefix.as_str()),
                        managed_roots,
                    ) =>
            {
                NonConvergenceKind::ManagedShadowed
            }
            // The bare `hq` sentinel: nothing resolved at all after an npm install.
            // HQ passed no prefix (npm_prefix_from_hq_bin("hq") is None by
            // construction, so neither Some-Some arm above matched), cannot name the
            // file it executes, and has no delivery evidence — an unaimed first
            // install, not a foreign layout HQ could prove a defect against. It
            // stays observable but must never wedge auto-update. Scoped to the npm
            // arm: pnpm/Bun keep classifying on their own targeting/delivery
            // evidence. An absolute foreign layout keeps falling to ForeignManaged.
            _ if post_install_hq_bin == "hq" => NonConvergenceKind::InstallerUnaimed,
            _ => NonConvergenceKind::ForeignManaged,
        },
    }
}

/// How the pnpm home behind a resolved shim was derived. Closed domain — the
/// value names the LAYOUT we matched, never a path. `Undetermined` means we
/// refused to guess and spawned pnpm with the ambient environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PnpmHomeSource {
    /// `<pnpm-home>/hq` — the pre-11 flat layout, home directory named `pnpm`.
    FlatPnpmDir,
    /// `<pnpm-home>/bin/hq` — the pnpm >=11 nested layout.
    NestedBinDir,
    /// A custom `PNPM_HOME` identified by pnpm's `global/` store beside the
    /// shims rather than by directory name.
    GlobalStore,
    Undetermined,
}

impl PnpmHomeSource {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::FlatPnpmDir => "flat-pnpm-dir",
            Self::NestedBinDir => "nested-bin-dir",
            Self::GlobalStore => "global-store",
            Self::Undetermined => "undetermined",
        }
    }
}

/// The pnpm environment a `pnpm add -g` child needs so it writes to the SAME
/// global bin dir the app resolved `hq` from.
///
/// Derived strictly from the already-resolved shim path — never from a guessed
/// default. Inventing a home would move a user's global installs to a directory
/// they do not use, so an underivable layout yields `None` and the child is
/// spawned exactly as before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PnpmGlobalEnv {
    /// Value for the child's `PNPM_HOME`.
    pub home: String,
    /// The directory that holds the resolved shim; pnpm must land here.
    pub global_bin_dir: String,
    pub source: PnpmHomeSource,
}

/// Derive the pnpm home and global bin dir behind a resolved `hq` shim.
///
/// Mirrors the layout arms of [`is_pnpm_global_shim`] so detection and
/// targeting can never disagree: whatever shape routed the install to pnpm is
/// the shape whose home we hand the child.
pub fn pnpm_global_env(hq_bin: &str) -> Option<PnpmGlobalEnv> {
    if hq_bin.is_empty() || hq_bin == "hq" {
        return None;
    }
    let path = Path::new(hq_bin);
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty())?;
    let parent_name = parent.file_name().and_then(|n| n.to_str());

    // Flat: `<pnpm-home>/hq`. Home and global bin dir are the same directory.
    if parent_name == Some("pnpm") {
        return Some(PnpmGlobalEnv {
            home: parent.to_string_lossy().to_string(),
            global_bin_dir: parent.to_string_lossy().to_string(),
            source: PnpmHomeSource::FlatPnpmDir,
        });
    }

    // pnpm >=11 nested: `<pnpm-home>/bin/hq`. The home is the grandparent; the
    // shims live one level down, which is exactly the directory `pnpm add -g`
    // must write.
    if parent_name == Some("bin") {
        if let Some(grandparent) = parent.parent().filter(|p| !p.as_os_str().is_empty()) {
            let grandparent_is_pnpm =
                grandparent.file_name().and_then(|n| n.to_str()) == Some("pnpm");
            if grandparent_is_pnpm || grandparent.join("global").is_dir() {
                return Some(PnpmGlobalEnv {
                    home: grandparent.to_string_lossy().to_string(),
                    global_bin_dir: parent.to_string_lossy().to_string(),
                    source: if grandparent_is_pnpm {
                        PnpmHomeSource::NestedBinDir
                    } else {
                        PnpmHomeSource::GlobalStore
                    },
                });
            }
        }
        return None;
    }

    // Custom PNPM_HOME: pnpm keeps its `global/` store beside the shims.
    if parent.join("global").is_dir() {
        return Some(PnpmGlobalEnv {
            home: parent.to_string_lossy().to_string(),
            global_bin_dir: parent.to_string_lossy().to_string(),
            source: PnpmHomeSource::GlobalStore,
        });
    }

    None
}

#[cfg(target_os = "windows")]
const PATH_LIST_SEPARATOR: char = ';';
#[cfg(not(target_os = "windows"))]
const PATH_LIST_SEPARATOR: char = ':';

/// Does `path_value` (a PATH-shaped, separator-joined string) contain `dir`?
/// Used to record whether the child pnpm could even see the global bin dir that
/// holds the shim we expect it to replace.
pub fn path_contains_dir(path_value: &str, dir: &str) -> bool {
    if dir.is_empty() {
        return false;
    }
    path_value
        .split(PATH_LIST_SEPARATOR)
        .any(|entry| !entry.is_empty() && Path::new(entry) == Path::new(dir))
}

/// The PATH handed to the pnpm child, with the resolved shim's own global bin
/// dir in front when we could derive it.
///
/// `paths::child_path()` draws its user-level directories from `user_cli_dirs`,
/// which lists only the FLAT pnpm homes. A pnpm >=11 user's real global bin dir
/// (`<pnpm-home>/bin`) is therefore absent from the child environment, so the
/// pnpm we spawn can resolve a different global bin dir than the one the app
/// resolved `hq` from, install there, and exit 0 — leaving the shim on PATH
/// untouched. Prepending the dir is scoped to this one spawn on purpose; the
/// global search order stays owned by `paths`.
pub fn pnpm_child_path(base_path: &str, global_bin_dir: Option<&str>) -> String {
    match global_bin_dir {
        Some(dir) if !dir.is_empty() && !path_contains_dir(base_path, dir) => {
            if base_path.is_empty() {
                dir.to_string()
            } else {
                format!("{dir}{PATH_LIST_SEPARATOR}{base_path}")
            }
        }
        _ => base_path.to_string(),
    }
}

/// What the pnpm child was handed and what it reported back. Every field is a
/// closed category, a boolean, or a bounded string — this is what makes the
/// next occurrence self-diagnosing instead of ambiguous, and it must survive
/// the org data scrubber that reduced `npm_stderr` to `[Filtered]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PnpmRunDiagnostics {
    pub home_source: PnpmHomeSource,
    /// Was `PNPM_HOME` already present in the app's own environment? A
    /// Dock-launched app inherits launchd's minimal environment and normally
    /// has none, which is half of why the child resolved a different global
    /// dir than the app did.
    pub home_env_present: bool,
    /// Did the PATH we handed the child contain the directory holding the
    /// resolved shim?
    pub path_has_shim_dir: bool,
    /// Did pnpm's NATIVE global bin dir (a bounded `pnpm bin -g` WITHOUT the
    /// forced `--config.global-bin-dir`, under the same env the install used)
    /// equal the directory holding the executed shim? This is now a diagnostic
    /// ONLY — it is never a gate on any class. On the pnpm >=11 nested layout the
    /// install correctly forces the nested bin dir while pnpm's native resolution
    /// is the flat home, so `Some(false)` here is the normal healthy shape, not a
    /// defect. `None` means unprobed (a converged run, an underivable layout, or
    /// a failed probe). Only the closed boolean is retained — never the path pnpm
    /// printed.
    pub global_bin_dir_matches_shim_dir: Option<bool>,
    /// The pnpm global-store layout family observed while reading delivery
    /// evidence (`v11` / `numeric` / `unknown`). A closed token, never a path, so
    /// a residual event names whether it saw the pnpm >=11 store the base defect
    /// was blind to.
    pub store_family: PnpmStoreFamily,
    /// Did the authoritative pnpm delivery query (`pnpm ls -g --json` or
    /// `pnpm root -g`) return a version, as opposed to falling through to the
    /// guessed store enumeration? Lets a residual event say whether pnpm's own
    /// answer was available.
    pub authoritative_query_ok: bool,
    /// Bounded exit-status rendering, e.g. `0` or `signal/none`.
    pub exit_status: String,
    /// Length of pnpm's combined output. The text itself is never sent — only
    /// its size, so a talkative pnpm cannot smuggle paths into telemetry.
    pub output_len: usize,
}

impl PnpmRunDiagnostics {
    /// One bounded, closed summary line. Mirrors `npm_diagnostics_summary` so
    /// both executors expose a scrubber-proof diagnostic extra.
    pub fn summary(&self) -> String {
        format!(
            "home_source={} home_env_present={} path_has_shim_dir={} \
             global_bin_dir_matches_shim_dir={} store_family={} \
             authoritative_query_ok={} exit_status={} output_len={}",
            self.home_source.telemetry_value(),
            self.home_env_present,
            self.path_has_shim_dir,
            global_bin_dir_match_tag(self.global_bin_dir_matches_shim_dir),
            self.store_family.telemetry_value(),
            self.authoritative_query_ok,
            self.exit_status,
            self.output_len,
        )
    }
}

/// Data needed to make the post-install effects observable at the app seam.
/// None of these fields are sent to telemetry directly; the reporting helper
/// below remains responsible for closed, redacted payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonConvergentReport {
    pub executor: InstallExecutor,
    pub kind: NonConvergenceKind,
    pub latest: String,
    pub local: Option<String>,
    pub hq_bin: String,
    /// Only ever `Some` for the npm executor. pnpm and Bun pass no prefix and
    /// must not borrow npm's placeholder wording.
    pub npm_prefix: Option<String>,
    /// The installer binary that ran — `npm`, `pnpm`, or `bun`, per `executor`.
    pub installer_bin: String,
    pub hq_bin_changed: bool,
    /// The version the installer actually delivered INTO the passed prefix, if a
    /// manifest was readable there. `None` means no delivery evidence was found.
    /// Reported alongside the requested version so a residual occurrence names
    /// its own mechanism — a resolution shortfall (delivered < requested, or
    /// none) versus genuine shadowing (delivered == requested) — without further
    /// inference.
    pub delivered_version: Option<String>,
    pub pnpm: Option<PnpmRunDiagnostics>,
    /// For a [`NonConvergenceKind::ManagedShadowed`] event, what HQ's self-repair
    /// achieved. `NotAttempted` for every other kind. Emitted as the closed
    /// `managed_shadow_repair` tag so the slice is self-diagnosing.
    pub managed_shadow_repair: ManagedShadowRepairOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostInstallSuccess {
    pub local: String,
    pub latest: String,
}

/// Complete post-install decision. Keeping every user-visible consequence as
/// data prevents an edit to the Tauri command from accidentally moving the
/// capture ahead of the durable marker write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostInstallOutcome {
    pub verdict: ConvergenceVerdict,
    pub non_convergence_kind: Option<NonConvergenceKind>,
    pub record_non_convergent: Option<String>,
    pub clear_non_convergent: bool,
    pub capture: Option<NonConvergentReport>,
    pub capture_requires_durable_record: bool,
    /// For a NON-BLOCKING non-convergence (a resolution shortfall) that is being
    /// captured for the first time this episode: the episode key the caller must
    /// persist to the non-blocking episode set so the same environment shape does
    /// not re-page on the next check or app restart. `None` for every blocking
    /// class (which use the durable marker instead) and for a suppressed repeat.
    /// This is NEVER the durable blocking marker — persisting it does not stop
    /// auto-install.
    pub record_nonblocking_episode: Option<String>,
    pub log_line: String,
    pub result: Result<PostInstallSuccess, String>,
}

/// Injectable post-install effects shared by the app executor and telemetry
/// artifact tests. This is the production ordering seam: foreign-managed
/// capture cannot happen unless the marker write succeeds.
pub struct PostInstallCoreEffects<'a> {
    pub record: &'a dyn Fn(String) -> Result<(), String>,
    pub clear: &'a dyn Fn(),
    pub capture: &'a dyn Fn(NonConvergentReport),
    pub record_failure: &'a dyn Fn(String),
}

struct AsyncSingleFlightState<T> {
    next_generation: u64,
    active: Option<AsyncSingleFlightActive<T>>,
}

struct AsyncSingleFlightActive<T> {
    generation: u64,
    receiver: tokio::sync::watch::Receiver<Option<Result<T, String>>>,
}

/// Coalesce overlapping async operations into one execution and share its
/// result with every caller that arrived while it was in flight.
///
/// The worker runs independently of any one caller, so cancelling a waiting UI
/// request cannot abandon the operation or strand later waiters. Generation
/// identity prevents a late waiter for an older result from clearing a newer
/// flight.
pub struct AsyncSingleFlight<T> {
    state: Arc<tokio::sync::Mutex<AsyncSingleFlightState<T>>>,
}

impl<T> AsyncSingleFlight<T>
where
    T: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(AsyncSingleFlightState {
                next_generation: 0,
                active: None,
            })),
        }
    }

    pub async fn run<F, Fut>(&self, operation: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        let mut receiver = {
            let mut state = self.state.lock().await;
            if let Some(active) = state.active.as_ref() {
                active.receiver.clone()
            } else {
                state.next_generation = state.next_generation.wrapping_add(1);
                let generation = state.next_generation;
                let (sender, receiver) = tokio::sync::watch::channel(None);
                state.active = Some(AsyncSingleFlightActive {
                    generation,
                    receiver: receiver.clone(),
                });

                let shared_state = Arc::clone(&self.state);
                let worker = tokio::spawn(operation());
                tokio::spawn(async move {
                    let result = match worker.await {
                        Ok(result) => result,
                        Err(error) => Err(format!("shared async operation failed: {error}")),
                    };
                    // Retain the result even if every original caller was
                    // cancelled; a waiter that joined this generation can
                    // still observe the completed operation.
                    sender.send_replace(Some(result));

                    let mut state = shared_state.lock().await;
                    if state
                        .active
                        .as_ref()
                        .is_some_and(|active| active.generation == generation)
                    {
                        state.active = None;
                    }
                });
                receiver
            }
        };

        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            if receiver.changed().await.is_err() {
                return Err("shared async operation ended without a result".to_string());
            }
        }
    }
}

impl<T> Default for AsyncSingleFlight<T>
where
    T: Clone + Send + Sync + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

/// Decide whether an npm install reached the CLI the desktop app resolves
/// afterwards. `before` is diagnostic context only: it distinguishes the
/// expected shim-to-npm relocation from an ordinary in-place update, while the
/// decision to block remains bound exclusively to the post-install binary.
pub fn convergence_verdict(
    before: Option<&str>,
    after: Option<&str>,
    before_bin: &str,
    after_bin: &str,
    latest: &str,
) -> ConvergenceVerdict {
    if !install_converged(after, latest) {
        return ConvergenceVerdict::NonConvergent;
    }

    if before_bin != after_bin && !install_converged(before, latest) {
        ConvergenceVerdict::RelocatedAndConverged
    } else {
        ConvergenceVerdict::Converged
    }
}

/// Everything the post-install decision needs, for either executor. A struct
/// rather than a positional argument list because both executors now share the
/// seam and a silently-swapped `&str` would mislabel a real user's telemetry.
#[derive(Debug, Clone)]
pub struct PostInstallContext<'a> {
    pub executor: InstallExecutor,
    pub before_bin: &'a str,
    pub after_bin: &'a str,
    pub before_version: Option<&'a str>,
    pub after_version: Option<&'a str>,
    pub latest: &'a str,
    /// npm executor only; pnpm and Bun always pass `None`.
    pub npm_prefix_passed: Option<&'a str>,
    /// The version the installer delivered INTO `npm_prefix_passed`, read from
    /// the manifest there. `Some(v)` is the delivery evidence that turns an
    /// otherwise-tautological npm-targeted match into either a genuine shadowing
    /// defect (v reaches `latest`) or a transient resolution shortfall (v short
    /// of `latest`, or `None`). Ignored for the pnpm executor.
    pub delivered_version: Option<&'a str>,
    /// The installer binary that ran.
    pub installer_bin: &'a str,
    pub already_blocked: bool,
    /// The machine's persisted set of already-reported NON-BLOCKING
    /// non-convergence episode keys (see [`non_convergent_episode_key`]). Used to
    /// bound a resolution shortfall to one capture per `(latest, executor, kind,
    /// home_source)` episode. An empty slice always reports (fail-closed), which
    /// is what an unreadable set passes. The npm convenience constructor passes
    /// `&[]`, preserving the npm arm's report-every-occurrence behaviour.
    pub nonblocking_episode_keys: &'a [String],
    /// pnpm executor only. `Some` means pnpm ran; the diagnostics describe what
    /// environment it was handed and what it reported back.
    pub pnpm: Option<PnpmRunDiagnostics>,
    /// The HQ-managed toolchain roots the caller discovered
    /// (`paths::managed_toolchain_roots()`), threaded in so classification stays
    /// pure. Consulted only by the npm arm's same-root shadow detection; the
    /// `npm()` constructor and every existing caller default it to `&[]`, which
    /// reproduces the prior behaviour exactly.
    pub managed_roots: &'a [PathBuf],
    /// What HQ's managed-shadow self-repair achieved for THIS decision. The
    /// pre-repair decision passes `NotAttempted`; after a repair the caller
    /// re-decides with the real outcome, which is what makes the managed-shadow
    /// blocking policy conditional (see [`ManagedShadowRepairOutcome`]).
    pub managed_shadow_repair: ManagedShadowRepairOutcome,
}

impl<'a> PostInstallContext<'a> {
    /// Convenience constructor for the npm executor, which carries no pnpm
    /// diagnostics and is by far the most common call shape in tests.
    #[allow(clippy::too_many_arguments)]
    pub fn npm(
        before_bin: &'a str,
        after_bin: &'a str,
        before_version: Option<&'a str>,
        after_version: Option<&'a str>,
        latest: &'a str,
        npm_prefix_passed: Option<&'a str>,
        npm_bin: &'a str,
        already_blocked: bool,
        delivered_version: Option<&'a str>,
    ) -> Self {
        Self {
            executor: InstallExecutor::Npm,
            before_bin,
            after_bin,
            before_version,
            after_version,
            latest,
            npm_prefix_passed,
            delivered_version,
            installer_bin: npm_bin,
            already_blocked,
            // Default to an empty set: direct and test callers report every
            // occurrence. The production npm finalize path threads the persisted
            // episode set in via `with_nonblocking_episode_keys`, so a PERSISTENT
            // non-blocking shape (the installer-unaimed unresolved `hq`, or a
            // recurring shortfall) is bounded to one capture per episode exactly
            // like the pnpm/Bun paths, rather than re-paging on every check.
            nonblocking_episode_keys: &[],
            pnpm: None,
            // Defaults reproduce the prior npm behaviour: with no managed roots
            // the classifier can never see a same-root shadow, and no repair has
            // run. Callers that can detect and repair a managed shadow opt in via
            // the builders below.
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        }
    }

    /// Supply the HQ-managed toolchain roots so the npm arm can distinguish an
    /// HQ-owned same-root shadow from a genuinely foreign layout.
    pub fn with_managed_roots(mut self, managed_roots: &'a [PathBuf]) -> Self {
        self.managed_roots = managed_roots;
        self
    }

    /// Record the outcome of HQ's managed-shadow self-repair for a re-decide.
    pub fn with_managed_shadow_repair(mut self, outcome: ManagedShadowRepairOutcome) -> Self {
        self.managed_shadow_repair = outcome;
        self
    }

    /// Supply the already-reported non-blocking episode keys so a repeated
    /// non-blocking non-convergence (a resolution shortfall or an
    /// installer-unaimed shape) is suppressed after its first capture.
    pub fn with_nonblocking_episode_keys(mut self, keys: &'a [String]) -> Self {
        self.nonblocking_episode_keys = keys;
        self
    }
}

/// Decide the observable outcome of an install after re-resolving `hq`.
/// The caller performs the returned effects in order. In particular, a
/// foreign-managed non-convergence may be captured only after `record` reports
/// a durable marker write; an unreadable or unwritable marker must fail closed
/// instead of turning every six-hour retry into a new first episode.
pub fn decide_post_install(ctx: &PostInstallContext<'_>) -> PostInstallOutcome {
    let PostInstallContext {
        executor,
        before_bin,
        after_bin,
        before_version,
        after_version,
        latest,
        npm_prefix_passed,
        delivered_version,
        installer_bin,
        already_blocked,
        nonblocking_episode_keys,
        pnpm,
        managed_roots,
        managed_shadow_repair,
    } = ctx;
    let managed_roots = *managed_roots;
    let managed_shadow_repair = *managed_shadow_repair;
    let (executor, before_bin, after_bin, latest, installer_bin, already_blocked) = (
        *executor,
        *before_bin,
        *after_bin,
        *latest,
        *installer_bin,
        *already_blocked,
    );
    let (before_version, after_version, npm_prefix_passed, delivered_version) = (
        *before_version,
        *after_version,
        *npm_prefix_passed,
        *delivered_version,
    );
    let verdict = convergence_verdict(before_version, after_version, before_bin, after_bin, latest);
    if matches!(
        verdict,
        ConvergenceVerdict::Converged | ConvergenceVerdict::RelocatedAndConverged
    ) {
        // `convergence_verdict` can return a successful verdict only with a
        // version that passed `install_converged`; keep this total anyway so a
        // future edit cannot turn a user command into an `expect` panic.
        if let Some(local) = after_version {
            return PostInstallOutcome {
                verdict,
                non_convergence_kind: None,
                record_non_convergent: None,
                clear_non_convergent: true,
                capture: None,
                capture_requires_durable_record: false,
                record_nonblocking_episode: None,
                log_line: format!("install succeeded: local={local} latest={latest}"),
                result: Ok(PostInstallSuccess {
                    local: local.to_string(),
                    latest: latest.to_string(),
                }),
            };
        }
    }

    // pnpm counts as targeted only when we actually derived its home from the
    // resolved shim AND the child could see that shim's directory. Either half
    // missing means the child may have written a different global dir, which is
    // the foreign-managed shape.
    let nonblocking_episode_keys = *nonblocking_episode_keys;
    let pnpm_targeted = match executor {
        // Reaching the Bun branch requires a validated global Bun shim and the
        // caller derives BUN_INSTALL from that same path before spawning.
        InstallExecutor::Bun => true,
        _ => pnpm.as_ref().is_some_and(|diagnostics| {
            diagnostics.home_source != PnpmHomeSource::Undetermined
                && diagnostics.path_has_shim_dir
        }),
    };
    // Delivery evidence: did the installer write the target version INTO the
    // store it was aimed at? Only that separates genuine shadowing (delivered,
    // but a copy earlier on PATH still wins) from a transient resolution
    // shortfall (never delivered). For the pnpm arm this is now pnpm's own answer
    // (`pnpm ls -g --json` / `pnpm root -g` / corrected store enumeration), which
    // reads the pnpm >=11 store the base defect was blind to. A missing manifest
    // reads as not delivered, which fails safe toward retrying rather than toward
    // a durable block.
    let target_delivered = delivered_version
        .is_some_and(|delivered| cmp_semver(delivered, latest) != std::cmp::Ordering::Less);
    let kind = non_convergence_kind(
        executor,
        npm_prefix_passed,
        pnpm_targeted,
        after_bin,
        target_delivered,
        managed_roots,
    );
    let hq_display = if after_bin == "hq" { "PATH" } else { after_bin };
    let detail = match kind {
        // A resolution shortfall is transient and self-healing; the layout is
        // fine, so its remedy differs from the "shadowed copy" wording.
        NonConvergenceKind::ResolutionShortfall => {
            resolution_shortfall_detail(hq_display, after_version, latest)
        }
        // An HQ-owned shadow inside HQ's own toolchain: the "managed outside
        // npm's global prefix / update it with the tool that installed it" copy
        // is false here (HQ installed both copies and drives the repair itself),
        // so it gets its own accurate wording.
        NonConvergenceKind::ManagedShadowed => {
            managed_shadow_detail(hq_display, after_version, latest)
        }
        // HQ was never aimed at the executed copy (an npx-cache copy, or an
        // underivable pnpm/Bun home). The remedy is to install a real global
        // copy, not to "update it with the tool that installed it".
        NonConvergenceKind::InstallerUnaimed => {
            installer_unaimed_detail(hq_display, after_version, latest)
        }
        _ => non_convergent_detail(executor, hq_display, after_version, latest),
    };
    // A resolution shortfall stays observable but NEVER persists the blocking
    // marker — a propagation lag must not permanently disable auto-update. A
    // targeted defect stays loud on every occurrence and blocks; a foreign
    // layout is bounded to one durable-record-gated capture per episode.
    let pnpm_home_source = pnpm.as_ref().map(|diagnostics| diagnostics.home_source);
    let (
        record_non_convergent,
        should_capture,
        capture_requires_durable_record,
        record_nonblocking_episode,
    ) = if matches!(kind, NonConvergenceKind::ManagedShadowed) {
        // A managed shadow's blocking policy is CONDITIONAL on the repair outcome.
        match managed_shadow_repair {
            // A converged repair never reaches here — a latest after-version
            // returns a successful verdict above. Kept total: never marker, never
            // capture.
            ManagedShadowRepairOutcome::Converged => (None, false, false, None),
            // Pre-repair (the caller is about to remove the shadow) or a caller
            // that does not repair: observable ONCE per episode, but NEVER a
            // durable marker, so the next check — or the in-run repair — self-heals
            // instead of wedging auto-update for this version.
            ManagedShadowRepairOutcome::NotAttempted => {
                let episode_key =
                    non_convergent_episode_key(latest, executor, kind, pnpm_home_source);
                let first_episode =
                    !non_convergent_episode_reported(nonblocking_episode_keys, &episode_key);
                (None, first_episode, false, first_episode.then_some(episode_key))
            }
            // A removal ran and the machine is still shadowed (or a gate refused
            // it): fall back to the foreign-managed policy — one durable-record-
            // gated capture per episode plus the marker — so a machine HQ cannot
            // repair stops re-paging every cycle.
            ManagedShadowRepairOutcome::RepairFailed
            | ManagedShadowRepairOutcome::ProvenanceRefused => {
                let first_episode = !already_blocked;
                (
                    first_episode.then(|| latest.to_string()),
                    first_episode,
                    true,
                    None,
                )
            }
        }
    } else if !kind.may_block_auto_update() {
        // A resolution shortfall writes NO durable marker (it must keep retrying),
        // but is bounded to one capture per `(latest, executor, kind, home_source)`
        // episode so a persistent environment shape does not re-page on every
        // check and every restart. The caller persists the returned key only on
        // the first capture; an unreadable set passes an empty slice and reports.
        let episode_key = non_convergent_episode_key(latest, executor, kind, pnpm_home_source);
        let first_episode =
            !non_convergent_episode_reported(nonblocking_episode_keys, &episode_key);
        (None, first_episode, false, first_episode.then_some(episode_key))
    } else if kind.is_installer_targeted() {
        (Some(latest.to_string()), true, false, None)
    } else {
        let first_episode = !already_blocked;
        (
            first_episode.then(|| latest.to_string()),
            first_episode,
            true,
            None,
        )
    };
    let report = should_capture.then(|| NonConvergentReport {
        executor,
        kind,
        latest: latest.to_string(),
        local: after_version.map(str::to_owned),
        hq_bin: hq_display.to_string(),
        npm_prefix: npm_prefix_passed.map(str::to_owned),
        installer_bin: installer_bin.to_string(),
        hq_bin_changed: before_bin != after_bin,
        delivered_version: delivered_version.map(str::to_owned),
        pnpm: pnpm.clone(),
        managed_shadow_repair,
    });

    PostInstallOutcome {
        verdict: ConvergenceVerdict::NonConvergent,
        non_convergence_kind: Some(kind),
        record_non_convergent,
        clear_non_convergent: false,
        capture: report,
        capture_requires_durable_record,
        record_nonblocking_episode,
        log_line: format!(
            "{} completed, but the active HQ CLI is still {} (expected v{latest}); hq={hq_display}",
            executor.telemetry_value(),
            after_version
                .map(|version| format!("v{version}"))
                .unwrap_or_else(|| "unreadable".to_string())
        ),
        result: Err(detail),
    }
}

/// Apply the filesystem and telemetry effects selected by
/// [`decide_post_install`]. Keeping this executor in the core crate lets the
/// artifact harness prove the same fail-closed ordering used by the Tauri
/// command instead of reimplementing it in a test.
pub fn apply_post_install_effects(
    outcome: &PostInstallOutcome,
    effects: &PostInstallCoreEffects<'_>,
) -> Result<PostInstallSuccess, String> {
    let marker_persisted = match outcome.record_non_convergent.as_deref() {
        Some(version) => match (effects.record)(version.to_string()) {
            Ok(()) => true,
            Err(error) => {
                (effects.record_failure)(format!(
                    "could not record non-convergent version {version}: {error}"
                ));
                false
            }
        },
        None => true,
    };

    if outcome.clear_non_convergent {
        (effects.clear)();
    }

    if let Some(report) = outcome.capture.as_ref() {
        if !outcome.capture_requires_durable_record || marker_persisted {
            (effects.capture)(report.clone());
        }
    }

    outcome.result.clone()
}

/// Should the background loop auto-install `latest`?
///
/// `false` once an install of that exact version has already completed without
/// converging: repeating it cannot produce a different result, and the loop
/// would otherwise reinstall 15s after every launch and every 6h forever. A
/// newer `latest` clears the block on its own (the environment may have been
/// fixed in between), and the user-initiated "Update" button never consults
/// this — an explicit click should always be allowed to try again.
pub fn non_convergent_episode_blocked(non_convergent: Option<&str>, latest: &str) -> bool {
    non_convergent == Some(latest)
}

pub fn should_auto_install(latest: &str, non_convergent: Option<&str>) -> bool {
    !non_convergent_episode_blocked(non_convergent, latest)
}

/// Upper bound on the persisted non-blocking non-convergence episode set, so a
/// pathological environment cannot grow menubar.json without bound. Mirrors
/// [`MAX_INSTALL_FAILURE_EPISODE_KEYS`].
pub const MAX_NON_CONVERGENT_EPISODE_KEYS: usize = 32;

/// The episode key that bounds how often a NON-BLOCKING non-convergence (a
/// resolution shortfall) is captured. A persistent environment shape — the pnpm
/// >=11 field layout that keeps failing to deliver `latest` — would otherwise
/// re-page Sentry on every scheduled check and every app restart (the field's
/// 16:13/16:14 double-fire across an app self-update). Keying on `(latest,
/// executor, kind, pnpm home_source)` reports it once per new `latest`; a new CLI
/// publish resets the bound (its keys carry a different `latest|` prefix), so a
/// genuinely recurring defect is never hidden. This bound NEVER writes the durable
/// blocking marker — a shortfall must always keep retrying.
pub fn non_convergent_episode_key(
    latest: &str,
    executor: InstallExecutor,
    kind: NonConvergenceKind,
    pnpm_home_source: Option<PnpmHomeSource>,
) -> String {
    let home = pnpm_home_source
        .map(|source| source.telemetry_value())
        .unwrap_or("n/a");
    format!(
        "{latest}|{}|{}|{}",
        executor.telemetry_value(),
        kind.telemetry_value(),
        home
    )
}

/// Whether a non-blocking non-convergence episode identical to one already
/// reported for this target version is in the machine's persisted set. A caller
/// that cannot read its set passes an empty slice and therefore always reports —
/// fail-closed, staying loud. Mirrors [`install_failure_episode_blocked`].
pub fn non_convergent_episode_reported(reported_keys: &[String], current_key: &str) -> bool {
    reported_keys.iter().any(|key| key == current_key)
}

/// The set to persist after reporting `current_key`: keep only keys for the
/// CURRENT `latest` (a new target resets the set), append the new key, and bound
/// the result to the most recent [`MAX_NON_CONVERGENT_EPISODE_KEYS`]. Mirrors
/// [`install_failure_episode_record`].
pub fn non_convergent_episode_record(
    reported_keys: &[String],
    current_key: &str,
    latest: &str,
) -> Vec<String> {
    let prefix = format!("{latest}|");
    let mut kept: Vec<String> = reported_keys
        .iter()
        .filter(|key| key.starts_with(&prefix) && key.as_str() != current_key)
        .cloned()
        .collect();
    kept.push(current_key.to_string());
    if kept.len() > MAX_NON_CONVERGENT_EPISODE_KEYS {
        let overflow = kept.len() - MAX_NON_CONVERGENT_EPISODE_KEYS;
        kept.drain(0..overflow);
    }
    kept
}

/// Stable marker on the non-convergent error string. The UI keys off it to tell
/// this apart from an npm failure, because the two remedies are opposites: an
/// npm failure wants "retry, or copy the install command", whereas a
/// non-convergent install means that exact command has *already* been proven
/// unable to replace the selected CLI, so offering it again only repeats the
/// failure. Callers strip the marker before display.
pub const NON_CONVERGENT_ERROR_PREFIX: &str = "hq-cli-update/non-convergent: ";

/// The message shown (and logged) when an install completes without
/// converging. It has to name the specific binary that did not move: a machine
/// in this state usually has two or three `hq` copies, and knowing *which* one
/// the app resolves is the entire remedy.
pub fn non_convergent_detail(
    executor: InstallExecutor,
    hq_bin: &str,
    local: Option<&str>,
    latest: &str,
) -> String {
    let current = local.unwrap_or("an unreadable version");
    match executor {
        InstallExecutor::Npm => format!(
            "{NON_CONVERGENT_ERROR_PREFIX}hq {latest} installed successfully, but the app still \
             resolves hq {current} at {hq_bin}. That copy is managed outside npm's global prefix \
             (pnpm, Homebrew, or an earlier entry on PATH), so an npm install cannot replace it. \
             Update it with the tool that installed it, or remove it so the npm-managed copy \
             takes over."
        ),
        // "Update it with the tool that installed it" is a dead end here: we
        // just ran that tool. Point the user at the one thing that explains a
        // clean `pnpm add -g` that does not move the shim — pnpm writing a
        // different global bin dir than the one this binary sits in.
        InstallExecutor::Pnpm => format!(
            "{NON_CONVERGENT_ERROR_PREFIX}pnpm reported that hq {latest} installed, but the app \
             still resolves hq {current} at {hq_bin}. pnpm most likely wrote to a different \
             global bin directory than the one holding that copy. Run \
             `pnpm add -g @indigoai-us/hq-cli@latest` yourself and compare `pnpm bin -g` with \
             the path above, or remove that copy so a fresh install takes over."
        ),
        InstallExecutor::Bun => format!(
            "{NON_CONVERGENT_ERROR_PREFIX}Bun reported that hq {latest} installed, but the app \
             still resolves hq {current} at {hq_bin}. Run \
             `bun add -g @indigoai-us/hq-cli@latest` yourself, or remove that copy so a fresh \
             install can take over."
        ),
    }
}

/// The message for a managed shadow: HQ installed `latest` into its own managed
/// npm prefix, but the app still resolves a SECOND HQ-managed copy from another
/// directory inside the same toolchain. Both copies belong to HQ, so the npm
/// "managed outside npm's global prefix / update it with the tool that installed
/// it" wording is false and unactionable — HQ owns the tool that installed both.
/// The wording is deliberately outcome-neutral so it reads correctly whether the
/// self-repair was refused, failed, or a re-created stray is caught next cycle.
pub fn managed_shadow_detail(hq_bin: &str, local: Option<&str>, latest: &str) -> String {
    let current = local.unwrap_or("an unreadable version");
    format!(
        "{NON_CONVERGENT_ERROR_PREFIX}hq {latest} installed successfully into HQ's managed \
         toolchain, but the app still resolves a second HQ-managed copy (hq {current}) at \
         {hq_bin}. Both copies belong to HQ, so no other package manager is involved — HQ \
         removes the stale copy automatically. If this keeps happening, fully quit and reopen \
         HQ so nothing is holding the old file open."
    )
}

/// The message for a resolution shortfall: the installer was aimed correctly but
/// the registry had not finished publishing the requested version here, so it
/// delivered an older one. Unlike a layout defect this needs no manual fix — the
/// next scheduled check retries once the publish propagates — so it must not
/// tell the user to change or remove anything. It keeps the shared marker prefix
/// so the UI routes it through the same surface rather than the generic
/// "retry / copy the install command" copy.
pub fn resolution_shortfall_detail(hq_bin: &str, local: Option<&str>, latest: &str) -> String {
    let current = local.unwrap_or("an unreadable version");
    format!(
        "{NON_CONVERGENT_ERROR_PREFIX}hq {latest} was requested, but the npm registry has not \
         finished publishing it to this machine yet, so the installer delivered hq {current} at \
         {hq_bin}. This is a transient registry lag, not a problem with your install — HQ retries \
         automatically on the next check, and no action is needed."
    )
}

/// The message when HQ was never aimed at the copy the app runs — an npx-cache
/// copy (materialised per `npx` call and un-updatable by any global install), or
/// a pnpm/Bun install whose global home could not be derived. Telling the user
/// to "update it with the tool that installed it" is wrong here, so this names
/// the real remedy: install a real global copy (HQ does this automatically on a
/// machine with no other install). It keeps the shared marker prefix so the UI
/// routes it through the non-convergent surface, not the generic retry copy.
pub fn installer_unaimed_detail(hq_bin: &str, local: Option<&str>, latest: &str) -> String {
    let current = local.unwrap_or("an unreadable version");
    format!(
        "{NON_CONVERGENT_ERROR_PREFIX}hq {latest} installed, but the app still resolves hq \
         {current} at {hq_bin} — a temporary copy (an npx cache, or a location HQ could not aim \
         the installer at) that no global install can replace. Install a real global copy with \
         `npm install -g @indigoai-us/hq-cli@latest`, or remove that copy so a fresh install \
         takes over. HQ keeps auto-update on and retries on the next check."
    )
}

/// Capture the non-convergent-install signal. This is a distinct class from
/// `install-failed`: npm exited 0 and nothing threw, so nothing else in the
/// pipeline would ever notice. It is exactly the silent state that ran on a
/// prod install for weeks, reinstalling on every cycle while the detected
/// version stayed frozen, so it stays at Warning level with its own fingerprint
/// rather than folding into the install-failure bucket.
pub fn report_non_convergent_install(report: &NonConvergentReport) {
    let executor = report.executor;
    let hq_bin = report.hq_bin.as_str();
    let prefix = report.npm_prefix.as_deref();
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-non-convergent");
            // Which package manager ran. Without this the two executors were
            // indistinguishable in Sentry and a pnpm run read as an npm run
            // against npm's default prefix.
            scope.set_tag("install_executor", executor.telemetry_value());
            scope.set_tag("non_convergence_kind", report.kind.telemetry_value());
            // Closed self-diagnosing token: for a managed shadow it says what HQ's
            // self-repair achieved; `not-attempted` for every other kind. Never a
            // path.
            scope.set_tag(
                "managed_shadow_repair",
                report.managed_shadow_repair.telemetry_value(),
            );
            scope.set_tag("latest", report.latest.as_str());
            scope.set_tag("local", report.local.as_deref().unwrap_or("unreadable"));
            // Requested vs delivered: the version the installer was ASKED for
            // and the version it actually wrote into the prefix. For a
            // resolution shortfall these differ (or delivered is absent), which
            // names the mechanism without inference; both are bare semver
            // strings, never a path. `requested_version` mirrors `latest` for a
            // self-contained delivered-vs-requested pair.
            scope.set_tag("requested_version", report.latest.as_str());
            scope.set_tag(
                "delivered_version",
                report.delivered_version.as_deref().unwrap_or("none"),
            );
            scope.set_tag("hq_bin_source", bin_resolution_source(hq_bin));
            scope.set_tag(
                "installer_bin_source",
                bin_resolution_source(&report.installer_bin),
            );
            scope.set_tag(
                "hq_bin_changed",
                if report.hq_bin_changed {
                    "true"
                } else {
                    "false"
                },
            );
            scope.set_fingerprint(Some(&["hq-cli-update", "install-non-convergent"]));
            // Home-redacted: the install LAYOUT is the diagnostic
            // (`~/Library/pnpm/hq` says everything); the account name in front
            // of it is personal data. The shared `before_send` scrubber only
            // filters by key name, so ordinary string extras like these reach
            // Sentry verbatim unless redacted here.
            scope.set_extra("hq_bin", redact_home(hq_bin).into());

            match executor {
                InstallExecutor::Npm => {
                    // npm-only shape. `prefix_known=false` renders as the
                    // "npm default prefix" placeholder, which is meaningful
                    // for npm and meaningless for pnpm.
                    scope.set_tag(
                        "npm_bin_source",
                        bin_resolution_source(&report.installer_bin),
                    );
                    scope.set_tag(
                        "prefix_known",
                        if prefix.is_some() { "true" } else { "false" },
                    );
                    scope.set_extra(
                        "npm_prefix",
                        redact_home(prefix.unwrap_or("npm default prefix")).into(),
                    );
                }
                InstallExecutor::Pnpm => {
                    // No `npm_prefix` extra at all: pnpm never passes one, and
                    // emitting npm's placeholder here is what made the live
                    // 0.10.69 events read as npm default-prefix runs.
                    let diagnostics = report.pnpm.as_ref();
                    scope.set_tag(
                        "pnpm_home_source",
                        diagnostics
                            .map(|d| d.home_source)
                            .unwrap_or(PnpmHomeSource::Undetermined)
                            .telemetry_value(),
                    );
                    scope.set_tag(
                        "pnpm_home_env_present",
                        bool_tag(diagnostics.is_some_and(|d| d.home_env_present)),
                    );
                    scope.set_tag(
                        "pnpm_path_has_shim_dir",
                        bool_tag(diagnostics.is_some_and(|d| d.path_has_shim_dir)),
                    );
                    // The direction evidence that breaks the old pnpm tautology:
                    // did pnpm's effective global bin dir equal the dir holding
                    // the executed shim? A closed enum (`true`/`false`/`unprobed`)
                    // — never the path pnpm printed.
                    scope.set_tag(
                        "pnpm_global_bin_dir_matches_shim_dir",
                        global_bin_dir_match_tag(
                            diagnostics.and_then(|d| d.global_bin_dir_matches_shim_dir),
                        ),
                    );
                    // Self-diagnosing residual telemetry: which pnpm global-store
                    // family we saw, and whether pnpm's own delivery answer was
                    // available. Both are closed tokens, never a path.
                    scope.set_tag(
                        "pnpm_store_family",
                        diagnostics
                            .map(|d| d.store_family)
                            .unwrap_or(PnpmStoreFamily::Unknown)
                            .telemetry_value(),
                    );
                    scope.set_tag(
                        "pnpm_authoritative_query_ok",
                        bool_tag(diagnostics.is_some_and(|d| d.authoritative_query_ok)),
                    );
                    if let Some(diagnostics) = diagnostics {
                        scope.set_extra("pnpm_diagnostics", diagnostics.summary().into());
                    }
                }
                InstallExecutor::Bun => {
                    // Bun has no npm prefix and no pnpm-specific diagnostics.
                    // The executor tag plus the redacted resolved/installer
                    // sources retain the provenance without emitting paths.
                }
            }
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] install completed but the detected CLI version did not change",
                sentry::Level::Warning,
            );
        },
    );
}

fn bool_tag(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

/// Closed rendering of the `pnpm bin -g` direction probe. `None` (a converged
/// run, an underivable layout, or a failed probe) is its own value rather than
/// collapsing into `false`, so telemetry never conflates "pnpm wrote the wrong
/// dir" with "we did not measure the dir".
fn global_bin_dir_match_tag(matches: Option<bool>) -> &'static str {
    match matches {
        Some(true) => "true",
        Some(false) => "false",
        None => "unprobed",
    }
}

// A persistence failure may recur at the background check cadence. Keep the
// compensating diagnostic bounded by process lifetime so it cannot recreate the
// quota problem the durable-marker gate removes.
static MARKER_UNPERSISTED_CAPTURED: AtomicBool = AtomicBool::new(false);

/// Report that the sticky non-convergence marker could not be written. The
/// payload intentionally carries only closed categories, never a filesystem
/// path or raw I/O error, and is emitted at most once per app process.
pub fn report_non_convergent_marker_unpersisted() {
    if MARKER_UNPERSISTED_CAPTURED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "non-convergent-marker-unpersisted");
            scope.set_tag("marker_store", "menubar-json");
            scope.set_tag("marker_error_class", "persistence");
            scope.set_fingerprint(Some(&[
                "hq-cli-update",
                "non-convergent-marker-unpersisted",
            ]));
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] could not persist non-convergent update marker",
                sentry::Level::Warning,
            );
        },
    );
}

/// Test support for the process-lifetime capture bound. This is deliberately
/// hidden rather than public API for callers.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn reset_non_convergent_marker_unpersisted_capture_for_tests() {
    MARKER_UNPERSISTED_CAPTURED.store(false, Ordering::Release);
}

/// Reduce a resolved executable to a closed, path-free source category for
/// telemetry. On Unix, an absolute path outside the deterministic directories
/// can only have come from the login-shell fallback; Windows `where.exe`
/// results remain deliberately `unknown` rather than inferring a source.
pub fn bin_resolution_source(bin: &str) -> &'static str {
    if bin.is_empty() || bin == "hq" || bin == "npm" {
        return "unknown";
    }

    let path = Path::new(bin);
    if paths::managed_toolchain_roots()
        .iter()
        .any(|root| path.starts_with(root))
    {
        return "managed-toolchain";
    }

    // Name the npx cache before the login-shell catch-all so the next occurrence
    // identifies its own mechanism instead of masquerading as a login-shell
    // install. Closed token, never a path — and platform-independent, since an
    // npx-cache copy can be resolved on Windows too.
    if paths::is_npx_cache_path(path) {
        return "npx-cache";
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = paths::home_dir() {
            if path.starts_with(home.join(".npm-global").join("bin")) {
                return "npm-global";
            }
            if path.starts_with(home.join("Library").join("pnpm"))
                || path.starts_with(home.join(".local").join("share").join("pnpm"))
            {
                return "pnpm";
            }
        }
        if path.starts_with("/opt/homebrew/bin") {
            return "homebrew";
        }
        if path.starts_with("/usr/local/bin") {
            return "usr-local";
        }
        if path.is_absolute() {
            return "login-shell";
        }
    }

    "unknown"
}

/// Capture a Sentry event when `hq` is installed but every version probe
/// failed. Scrubbed by `hq_telemetry::before_send` before send. This is the
/// "detection silently degraded" signal the team triages immediately —
/// the exact class that hid a stale CLI behind a missing banner.
pub fn report_unreadable_version(latest: &str, probes: &LocalVersionProbeDiagnostics) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "version-unreadable");
            scope.set_tag("latest", latest);
            scope.set_extra(
                "hq_cli_version_probes",
                serde_json::json!({
                    "binary_anchor": probes.binary_anchor,
                    "npm_root": probes.npm_root,
                    "hq_version": probes.hq_version,
                    "binary_anchor_shape": probes.binary_anchor_shape,
                    "resolved_program_kind": probes.resolved_program_kind,
                    "managed_runtime": probes.managed_runtime,
                    "interpreter_recovery": probes.interpreter_recovery,
                    "resolution_source": probes.resolution_source,
                })
                .into(),
            );
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] hq is installed but its version could not be read \
                 (binary-anchor, npm root, and hq --version all failed)",
                sentry::Level::Warning,
            );
        },
    );
}

/// The executable shims the desktop updater's own package,
/// `@indigoai-us/hq-cli`, declares in its `bin` map. npm links one shim per
/// entry into `<prefix>/bin` (plus the Windows `.cmd` / `.ps1` wrappers), so a
/// pre-existing non-npm file at ANY of these names produces the same structured
/// `EEXIST` bin collision that npm's documented `--force` remedy clears — not
/// only the primary `hq` shim. Recognizing every declared shim is what arms the
/// forced retry and keeps a second-shim collision from misclassifying as an
/// unexpected updater defect.
///
/// This mirrors the `bin` map of `@indigoai-us/hq-cli` (verified against the
/// published 5.98.1 manifest and `repos/private/hq-workspace/apps/hq-cli/
/// package.json`). If that package ever declares a new bin, add it here so the
/// updater recognizes a collision on it and arms the same remedy — the desktop
/// repo cannot see that package.json at build time, so this constant is the
/// single source of truth for the shim names.
const HQ_CLI_BIN_NAMES: [&str; 2] = ["hq", "hq-auth-refresh"];

/// Whether an npm install failure is the EXPECTED "global npm prefix needs
/// sudo" condition. This is deliberately stricter than an `EACCES` string
/// check: npm and lifecycle scripts can report permission failures for its
/// cache, a package script, or an unrelated filesystem path. Only a write to
/// the exact prefix selected for this `hq` update is the known, non-actionable
/// user-machine setup failure.
///
/// npm uses `<prefix>/lib/node_modules` on Unix and `<prefix>/node_modules`
/// on Windows. It can also fail while linking any of the package's declared bin
/// shims (`<prefix>/bin/<name>` or a Windows shim form) — see
/// [`HQ_CLI_BIN_NAMES`]. Normalize separators so an event captured on either
/// platform follows the same rule.
pub fn is_prefix_permission_failure(detail: &str, prefix: Option<&str>) -> bool {
    let detail = detail.to_ascii_lowercase().replace('\\', "/");
    let is_permission_error = detail.contains("eacces") || detail.contains("permission denied");
    let Some(prefix) = prefix else {
        return false;
    };
    let prefix = prefix
        .trim()
        .trim_end_matches(['/', '\\'])
        .to_ascii_lowercase()
        .replace('\\', "/");
    if !is_permission_error || prefix.is_empty() {
        return false;
    }

    let node_modules_targets = [
        format!("{prefix}/lib/node_modules"),
        format!("{prefix}/node_modules"),
    ];
    let bin_targets = HQ_CLI_BIN_NAMES.iter().flat_map(|name| {
        [
            format!("{prefix}/bin/{name}"),
            format!("{prefix}/{name}"),
            format!("{prefix}/{name}.cmd"),
            format!("{prefix}/{name}.ps1"),
        ]
    });
    node_modules_targets
        .into_iter()
        .chain(bin_targets)
        .any(|target| detail.contains(target.as_str()))
}

/// Keep the cache-specific diagnostic distinct from an expected selected-prefix
/// failure. It intentionally does not treat an exit code alone as permission
/// evidence: unrelated exit-243 failures must remain reportable.
fn is_npm_permission_failure(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("eacces")
        || detail.contains("permission denied")
        || detail.contains("errno -13")
}

/// A path-free summary retained for the existing npm-cache telemetry contract.
/// Selected-prefix failures take precedence, so the two categories do not
/// overlap; all other shapes remain reportable as `other`.
fn npm_failure_site(detail: &str, prefix: Option<&str>) -> &'static str {
    if !is_npm_permission_failure(detail) {
        return "other";
    }
    if is_prefix_permission_failure(detail, prefix) {
        return "prefix";
    }
    if detail.to_ascii_lowercase().contains("_cacache") {
        return "cache";
    }
    "other"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NpmPathShape {
    SelectedPrefixNodeModules,
    GlobalLibNodeModules,
    BinHq,
    NpmCache,
    Other,
    None,
}

impl NpmPathShape {
    fn tag_value(self) -> &'static str {
        match self {
            Self::SelectedPrefixNodeModules => "selected-prefix-node-modules",
            Self::GlobalLibNodeModules => "global-lib-node-modules",
            Self::BinHq => "bin-hq",
            Self::NpmCache => "npm-cache",
            Self::Other => "other",
            Self::None => "none",
        }
    }
}

fn npm_path_value(detail: &str) -> Option<String> {
    detail.lines().find_map(|line| {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let marker = if lower.starts_with("npm error path ") {
            "npm error path "
        } else if lower.starts_with("npm err! path ") {
            "npm err! path "
        } else {
            return None;
        };
        Some(
            line[marker.len()..]
                .trim()
                .trim_matches(['\'', '\"', '`'])
                .replace('\\', "/"),
        )
    })
}

fn normalized_npm_path(detail: &str) -> Option<String> {
    npm_path_value(detail).map(|path| path.to_ascii_lowercase())
}

/// Whether a `/`-normalised path npm reported is ABSOLUTE: a POSIX/UNC root
/// (`/…`) or a Windows drive root (`C:/…`). A relative path can never anchor a
/// deletion scope, so this is the first fail-closed guard in
/// [`partial_install_scope_from_npm_path`].
fn npm_reported_path_is_absolute(path: &str) -> bool {
    path.starts_with('/')
        || path
            .split_once(":/")
            .is_some_and(|(drive, _)| drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic())
}

/// Derive the partial-install cleanup scope from the ABSOLUTE path npm itself
/// named in an `ENOTEMPTY` failure, for the prefix-less case where no install
/// prefix resolved (HQ-DESKTOP-5B: a bare or non-npm-shaped `hq`, so
/// `hq_cli_install_prefix` returns `None`). npm's own error line names the
/// directory whose rename failed, so the scope can be recovered from it even
/// when the app resolved no prefix — the exact directory the prefix-derived
/// remedy targets.
///
/// Returns the path truncated at and including the `@indigoai-us` scope
/// directory, but ONLY when npm named an absolute path that contains
/// `node_modules/@indigoai-us` as EXACT path components. Every ambiguity fails
/// closed to `None`: a relative path, a missing marker, a merely-substring match
/// such as `.../node_modules/@indigoai-usx/...`, a bare filesystem root, or
/// `@indigoai-us` appearing where its immediate parent component is not exactly
/// `node_modules`. The caller then performs no deletion and reports the failure
/// exactly as today.
///
/// Reuses [`npm_path_value`] (case-preserving; already normalises Windows
/// backslashes to `/`). Fail-closed by construction: the returned value only
/// ever BOUNDS a deletion whose set is itself fixed to the `hq-cli` and
/// `.hq-cli-*` children — it never widens it, never yields the scope directory's
/// parent, and never yields a sibling package.
pub fn partial_install_scope_from_npm_path(detail: &str) -> Option<String> {
    let path = npm_path_value(detail)?;
    if !npm_reported_path_is_absolute(&path) {
        return None;
    }
    let components: Vec<&str> = path.split('/').collect();
    // A QUALIFYING `@indigoai-us` scope is an exact `@indigoai-us` component whose
    // immediate parent is exactly `node_modules` AND which leads directly to the
    // hq-cli debris — either it IS the reported directory (the last component, the
    // scope dir itself) or its next component is `hq-cli` or a `.hq-cli-*` staging
    // dir. Exact component equality (never a substring) rejects `@indigoai-usx`;
    // the parent check rejects `@indigoai-us` as a plain file basename; the
    // debris-leader check rejects an unrelated OUTER `node_modules/@indigoai-us`
    // when the failing package lives under a DEEPER one (a nested path such as
    // `.../@indigoai-us/toolchain/lib/node_modules/@indigoai-us/hq-cli` must
    // resolve to the inner scope, never delete the outer scope's `hq-cli`).
    let qualifying: Vec<usize> = components
        .iter()
        .enumerate()
        .filter(|&(index, component)| {
            *component == "@indigoai-us"
                && index > 0
                && components[index - 1] == "node_modules"
                && match components.get(index + 1) {
                    None => true,
                    Some(&next) => next == "hq-cli" || next.starts_with(".hq-cli-"),
                }
        })
        .map(|(index, _)| index)
        .collect();
    // Fail closed on ambiguity: exactly one qualifying scope, or nothing — an
    // ambiguous path never widens the blast radius.
    let [scope_index] = qualifying[..] else {
        return None;
    };
    Some(components[..=scope_index].join("/"))
}

fn npm_path_shape(detail: &str, prefix: Option<&str>) -> NpmPathShape {
    let Some(path) = normalized_npm_path(detail) else {
        return NpmPathShape::None;
    };

    if path.contains("/.npm/_cacache") || path.contains("/npm-cache/") {
        return NpmPathShape::NpmCache;
    }

    if let Some(prefix) = prefix {
        let prefix = prefix
            .trim()
            .trim_end_matches(['/', '\\'])
            .to_ascii_lowercase()
            .replace('\\', "/");
        if !prefix.is_empty() {
            if [
                format!("{prefix}/lib/node_modules"),
                format!("{prefix}/node_modules"),
            ]
            .iter()
            .any(|target| path.contains(target))
            {
                return NpmPathShape::SelectedPrefixNodeModules;
            }
            if HQ_CLI_BIN_NAMES.iter().any(|name| {
                [
                    format!("{prefix}/bin/{name}"),
                    format!("{prefix}/{name}"),
                    format!("{prefix}/{name}.cmd"),
                    format!("{prefix}/{name}.ps1"),
                ]
                .iter()
                .any(|target| path == *target)
            }) {
                return NpmPathShape::BinHq;
            }
        }
    }

    if [
        "/lib/node_modules/@indigoai-us",
        "/node_modules/@indigoai-us",
    ]
    .iter()
    .any(|target| path.ends_with(target) || path.contains(&format!("{target}/hq-cli")))
    {
        NpmPathShape::GlobalLibNodeModules
    } else if HQ_CLI_BIN_NAMES.iter().any(|name| {
        [
            format!("/bin/{name}"),
            format!("/npm/{name}"),
            format!("/npm/{name}.cmd"),
            format!("/npm/{name}.ps1"),
        ]
        .iter()
        .any(|target| path.ends_with(target.as_str()))
    }) {
        NpmPathShape::BinHq
    } else {
        NpmPathShape::Other
    }
}

/// The `@indigoai-us/hq-cli` shim a bin-collision or prefix-permission event
/// names, reduced to a CLOSED enumeration: one of [`HQ_CLI_BIN_NAMES`] when the
/// reported path's basename is that shim (with or without a Windows `.cmd` /
/// `.ps1` wrapper), `other` when npm named some other path, or `none` when npm
/// reported no path at all. This lets a merged collision group still record
/// WHICH shim collided without adding a fingerprint dimension or leaking the
/// path: only the fixed enum value is ever tagged, so it keeps the same
/// scrub-safety guarantee as the other closed-enumeration tags.
fn npm_bin_target(detail: &str) -> &'static str {
    let Some(path) = normalized_npm_path(detail) else {
        return "none";
    };
    let basename = path.rsplit('/').next().unwrap_or("");
    let stem = basename
        .strip_suffix(".cmd")
        .or_else(|| basename.strip_suffix(".ps1"))
        .unwrap_or(basename);
    for name in HQ_CLI_BIN_NAMES {
        if name == stem {
            return name;
        }
    }
    "other"
}

fn npm_error_code(detail: &str) -> String {
    let code = detail.lines().find_map(|raw_line| {
        let line = raw_line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("npm error code ") {
            Some(&line["npm error code ".len()..])
        } else if lower.starts_with("npm err! code ") {
            Some(&line["npm err! code ".len()..])
        } else {
            None
        }
        .and_then(|value| value.split_whitespace().next())
    });

    match code {
        None => "none".to_string(),
        Some(code)
            if (1..=32).contains(&code.len())
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') =>
        {
            code.to_ascii_uppercase()
        }
        Some(_) => "unrecognized".to_string(),
    }
}

/// Temporary npm registry and resolution failures already retry on the next
/// scheduled update. Preserve this current-main classification while rebasing
/// the permission diagnostics so a telemetry fix cannot make them noisy again.
fn is_expected_transient_registry_failure(detail: &str) -> bool {
    matches!(
        npm_error_code(detail).as_str(),
        // EIDLETIMEOUT is the code npm's registry fetcher emits when a socket
        // goes idle past the configured timeout — the same transient network
        // class as the ETIMEDOUT / ERR_SOCKET_TIMEOUT entries beside it, and the
        // next scheduled check retries it away. HQ-DESKTOP-5C paged it at Error
        // only because it was absent from this allow-list. Add nothing else
        // speculatively; each further code needs its own evidence.
        "ETARGET"
            | "ECONNRESET"
            | "ETIMEDOUT"
            | "ENOTFOUND"
            | "EAI_AGAIN"
            | "ERR_SOCKET_TIMEOUT"
            | "EIDLETIMEOUT"
    )
}

fn npm_syscall(detail: &str) -> &'static str {
    let syscall = detail.lines().find_map(|line| {
        let line = line.trim().to_ascii_lowercase();
        line.strip_prefix("npm error syscall ")
            .or_else(|| line.strip_prefix("npm err! syscall "))
            .and_then(|value| value.split_whitespace().next())
            .map(str::to_string)
    });
    match syscall.as_deref() {
        Some("mkdir") => "mkdir",
        Some("open") => "open",
        Some("rename") => "rename",
        Some("unlink") => "unlink",
        Some("rmdir") => "rmdir",
        Some("write") => "write",
        _ => "unknown",
    }
}

/// Build the diagnostic Sentry can safely retain for an unexpected npm
/// install failure. Raw stderr is intentionally excluded: project default
/// scrubbing treats it as sensitive free text and replaces the whole value.
/// Every field here is either a closed enumeration, a boolean, or a number.
fn npm_diagnostics_summary(
    exit_code: &str,
    npm_errno: &str,
    detail: &str,
    path_shape: NpmPathShape,
    prefix_known: bool,
    eacces: bool,
) -> String {
    format!(
        "error_code={} syscall={} path_shape={} prefix_known={} eacces={} exit_code={} errno={} stderr_len={}",
        npm_error_code(detail),
        npm_syscall(detail),
        path_shape.tag_value(),
        prefix_known,
        eacces,
        exit_code,
        npm_errno,
        detail.len(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NpmLifecycleFailure {
    failed: bool,
    package: Option<String>,
}

fn is_safe_npm_package_part(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn is_safe_npm_package_name(value: &str) -> bool {
    if !(1..=64).contains(&value.len()) {
        return false;
    }
    if let Some(scoped) = value.strip_prefix('@') {
        let Some((scope, package)) = scoped.split_once('/') else {
            return false;
        };
        !package.contains('/')
            && is_safe_npm_package_part(scope)
            && is_safe_npm_package_part(package)
    } else {
        !value.contains('/') && is_safe_npm_package_part(value)
    }
}

fn npm_lifecycle_failure(detail: &str) -> NpmLifecycleFailure {
    // Treat this as a lifecycle failure only when npm supplied both of its
    // structured signals: a command-failed line and a lifecycle-specific
    // code. In particular, an OS errno (for example ENOENT or EACCES) that
    // happens to appear beside build output must stay on the Unexpected path.
    let npm_code = npm_error_code(detail);
    let lifecycle_code =
        npm_code.bytes().all(|byte| byte.is_ascii_digit()) || npm_code == "ELIFECYCLE";
    let command_failed = detail.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        line.starts_with("npm error command failed") || line.starts_with("npm err! command failed")
    });
    if !(lifecycle_code && command_failed) {
        return NpmLifecycleFailure {
            failed: false,
            package: None,
        };
    }

    let package = npm_path_value(detail)
        .and_then(|path| {
            path.rsplit_once("/node_modules/")
                .map(|(_, value)| value.to_string())
        })
        .and_then(|path| {
            let mut parts = path.split('/');
            let first = parts.next()?;
            if first.starts_with('@') {
                Some(format!("{first}/{}", parts.next()?))
            } else {
                Some(first.to_string())
            }
        })
        .filter(|package| is_safe_npm_package_name(package));

    NpmLifecycleFailure {
        failed: true,
        package,
    }
}

fn is_indigoai_owned_npm_package(package: &str) -> bool {
    package.starts_with("@indigoai-us/")
}

fn is_third_party_npm_lifecycle_failure(detail: &str) -> bool {
    let lifecycle = npm_lifecycle_failure(detail);
    lifecycle.failed
        && lifecycle
            .package
            .as_deref()
            .is_some_and(|package| !is_indigoai_owned_npm_package(package))
}

/// Diagnose WHY a native dependency's install lifecycle script failed, as a
/// CLOSED enumeration. This is the single field the reported events for
/// HQ-DESKTOP-4R / HQ-DESKTOP-4S never carried, and it is the whole reason the
/// specific per-machine reason could not be determined remotely.
///
/// The return type is `&'static str` on purpose: no attacker- or path-derived
/// text from `detail` can ever reach Sentry through this value. The raw npm
/// output stays in the local `log("hq-cli-update", …)` record only.
///
/// Matching is deliberately conservative and keys on the *actual failure
/// evidence* — prebuild-install's own "No prebuilt binaries found", node-gyp's
/// `gyp ERR!`, a libuv transport errno while fetching a prebuild, `ENOSPC` —
/// never on the mere presence of a build tool's name in the command line npm
/// echoes (`sh -c prebuild-install || node-gyp rebuild` names node-gyp but does
/// not mean the compiler is missing). Each cause requires its own distinctive
/// token(s); anything unrecognized returns the first-class value "unknown".
///
/// Ordering matters: disk exhaustion can masquerade as any other failure, and a
/// prebuild miss that then falls through to a failing `node-gyp rebuild` should
/// report the compiler as missing (the actionable cause) rather than the
/// prebuild gap, so `toolchain-missing` is checked before `prebuild-unavailable`.
///
/// Exposed (`pub`) because the desktop updater's managed-toolchain retry gate
/// consumes the diagnosed cause to refuse a provision a different runtime cannot
/// repair (`disk-space` / `network`). The return type stays a closed
/// `&'static str`, so widening the visibility leaks no attacker-derived text.
pub fn npm_lifecycle_cause(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();

    // Disk exhaustion is unambiguous and dominates: a full disk can present as a
    // truncated prebuild download or a failed compile, so it is decided first.
    if lower.contains("enospc") || lower.contains("no space left on device") {
        return "disk-space";
    }

    // A network fault while FETCHING the prebuilt binary. Requires a transport
    // errno AND download/fetch context — a bare "network" word is not enough,
    // and npm's own transient-registry errors are handled separately upstream.
    let transport_errno = [
        "etimedout",
        "enotfound",
        "eai_again",
        "econnreset",
        "econnrefused",
        "socket hang up",
    ]
    .iter()
    .any(|token| lower.contains(token));
    let fetch_context = [
        "prebuild",
        "download",
        "fetch",
        "https://",
        "http://",
        "getaddrinfo",
        "registry",
    ]
    .iter()
    .any(|token| lower.contains(token));
    if transport_errno && fetch_context {
        return "network";
    }

    // The compiler/toolchain is missing, so node-gyp / cmake-js could not build
    // from source. Match on the builders' OWN error output, never on the echoed
    // command line.
    let missing_tokens = [
        "not found",
        "cannot find",
        "not installed",
        "command not found",
        "enoent",
        "no such file",
    ];
    let missing_evidence = missing_tokens.iter().any(|token| lower.contains(token));
    let cmake_missing = (lower.contains("cmake") || lower.contains("cmake-js")) && missing_evidence;
    let compiler_missing = ["c++", "g++", "clang++", "cc1plus", "make: "]
        .iter()
        .any(|token| lower.contains(token))
        && (lower.contains("command not found") || lower.contains("no such file"));
    // A bare `gyp ERR!` is NOT proof the build toolchain is missing: node-gyp
    // emits it for ordinary compile errors and native-API mismatches too, and an
    // unconditional match would both mis-advise users to install tools they may
    // already have and override a preceding prebuild-miss message. Require
    // concrete missing-tool evidence alongside it (a missing interpreter, SDK, or
    // compiler). The explicit Xcode/CLT phrases are strong enough on their own.
    let gyp_missing_tool =
        lower.contains("gyp err!") && (lower.contains("find python") || missing_evidence);
    if lower.contains("xcode-select")
        || lower.contains("no xcodebuild")
        || lower.contains("command line tools")
        || lower.contains("no developer tools")
        || gyp_missing_tool
        || cmake_missing
        || compiler_missing
    {
        return "toolchain-missing";
    }

    // No prebuilt binary is published for this Node ABI / platform, so
    // prebuild-install reported a miss (its own message) or the download 404'd.
    // cmake-js-built packages (node-llama-cpp) have their OWN miss vocabulary for
    // the same underlying condition — no matching prebuilt for this runtime — so
    // recognize it here too, guarded on cmake-js context so it can never fire on
    // an unrelated "cmake not found" (that stays `toolchain-missing` above).
    let cmake_js_prebuilt_miss = lower.contains("cmake-js")
        && (lower.contains("no prebuilt")
            || lower.contains("no precompiled")
            || lower.contains("prebuilt binary not found")
            || lower.contains("no compatible prebuilt"));
    if lower.contains("no prebuilt binaries found")
        || (lower.contains("prebuild") && lower.contains("404"))
        || cmake_js_prebuilt_miss
    {
        return "prebuild-unavailable";
    }

    // A package's own (post)install script failed with NO native-builder output
    // at all — node-llama-cpp's `node ./dist/cli/cli.js postinstall` is the
    // reported node-llama-cpp shape. Requiring the `postinstall` lifecycle token
    // (never a build-tool NAME in the echoed `sh -c` command) keeps a bare
    // `prebuild-install || node-gyp rebuild` command echo classified as `unknown`,
    // while giving the previously-undiagnosable postinstall failure a first-class
    // cause. It drives only generic, tool-agnostic advice, so it can never
    // mis-tell a user to install tools they already have.
    if lower.contains("postinstall") && npm_lifecycle_builder(detail) == "postinstall-script" {
        return "postinstall-script";
    }

    "unknown"
}

/// Which native builder emitted the failing lifecycle output, as a CLOSED
/// enumeration: `prebuild-install | node-gyp | cmake-js | postinstall-script |
/// unknown`. Companion to [`npm_lifecycle_cause`] — the cause is WHY the build
/// failed, this is WHICH builder was running when it did. It closed the
/// diagnostic dead end where node-llama-cpp's cmake-js/postinstall failures had
/// no builder attribution and degraded to `cause=unknown`.
///
/// HARD rule: derived ONLY from a builder's own emitted output (its log prefix
/// or a distinctive message), NEVER from the `sh -c …` command line npm echoes.
/// `sh -c prebuild-install || node-gyp rebuild` names both prebuild-install and
/// node-gyp but proves neither ran, so matching the echo would mis-attribute
/// every such failure. `postinstall-script` is the residual: a lifecycle script
/// failed but no native builder produced any output, so the package's own
/// (post)install script is what broke. Returns `&'static str` so no path- or
/// attacker-derived text can reach Sentry through this value.
fn npm_lifecycle_builder(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();

    // node-gyp's own leveled log prefix (`gyp <level>`), never the `node-gyp`
    // token in the echoed command. A failing compile ends here even when a
    // prebuild miss preceded it, since node-gyp is the builder that actually ran.
    let node_gyp = [
        "gyp err!",
        "gyp info ",
        "gyp warn ",
        "gyp http ",
        "gyp verb ",
        "gyp sill ",
    ]
    .iter()
    .any(|token| lower.contains(token));
    if node_gyp {
        return "node-gyp";
    }

    // cmake / cmake-js real build output (CMake's own diagnostics, or cmake-js's
    // leveled log), never the echoed command. "cmake not found" is deliberately
    // NOT matched here — that is a package's own message, handled as a cause
    // (`toolchain-missing`) and left to the `postinstall-script` residual below.
    let cmake_js = [
        "cmake error",
        "cmake warning",
        "-- configuring",
        "-- generating",
        "cmake-js err",
        "cmake-js info",
        "cmake-js warn",
    ]
    .iter()
    .any(|token| lower.contains(token));
    if cmake_js {
        return "cmake-js";
    }

    // prebuild-install's own leveled log prefix, or its distinctive miss message.
    let prebuild = [
        "prebuild-install warn",
        "prebuild-install info",
        "prebuild-install http",
        "prebuild-install error",
    ]
    .iter()
    .any(|token| lower.contains(token))
        || lower.contains("no prebuilt binaries found");
    if prebuild {
        return "prebuild-install";
    }

    // A lifecycle script failed but no native builder emitted any output. Attribute
    // it to the package's own postinstall script ONLY with explicit evidence that
    // the postinstall STAGE is what failed — never merely that some lifecycle
    // script did. A bare `npm error command sh -c prebuild-install || node-gyp
    // rebuild` echo carries the lifecycle marker but names no stage and shows no
    // builder output, so it stays `unknown` rather than corrupting the builder
    // telemetry this change exists to make reliable.
    if has_npm_lifecycle_failure_marker(detail) && has_postinstall_stage_evidence(detail) {
        return "postinstall-script";
    }

    "unknown"
}

/// Explicit evidence that npm's POSTINSTALL lifecycle stage is what failed — not
/// merely that a lifecycle script failed. npm attributes the postinstall stage
/// three ways, and every one carries the literal `postinstall` token: its stage
/// line (`Failed at the …postinstall script`), its `<pkg>@<ver> postinstall:`
/// prefix, or the failing command echo when that command is itself the package's
/// postinstall entrypoint (node-llama-cpp's `node ./dist/cli/cli.js postinstall`).
/// A `sh -c prebuild-install || node-gyp rebuild` echo has no such token, so it
/// is deliberately NOT treated as postinstall evidence.
fn has_postinstall_stage_evidence(detail: &str) -> bool {
    detail.to_ascii_lowercase().contains("postinstall")
}

/// A normalized local-log record for an npm attempt. It deliberately contains
/// only bounded npm code and path-shape values, never raw npm output or paths.
pub fn npm_install_attempt_summary(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> String {
    let exit_code = exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    format!(
        "npm_code={} path_shape={} exit_code={}",
        npm_error_code(detail),
        npm_path_shape(detail, prefix).tag_value(),
        exit_code,
    )
}

fn has_eacces_evidence(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("eacces")
        || detail.contains("permission denied")
        || detail.contains("errno -13")
}

/// Detect the expected local permission failure at an npm global-install
/// target that is not covered by the derived-prefix comparison. This covers
/// both an unknown managed prefix and a known prefix that differs from npm's
/// actual global target. Keep the fallback narrow: it requires permission
/// evidence plus an npm global-install target and never suppresses cache or
/// unrelated-path failures.
pub fn is_global_prefix_permission_failure(_exit_code: Option<i32>, detail: &str) -> bool {
    has_eacces_evidence(detail)
        && matches!(
            npm_path_shape(detail, None),
            NpmPathShape::GlobalLibNodeModules | NpmPathShape::BinHq
        )
}

/// npm forwards negative libuv errnos through `process.exit`, and POSIX keeps
/// only the low eight bits of that status. Decode only the statuses that can
/// represent a negative errno and return an allow-listed name, never a raw
/// number. Windows preserves its native process codes and intentionally has no
/// POSIX errno interpretation here.
pub fn npm_errno_from_exit_status(exit_code: Option<i32>) -> &'static str {
    let Some(status) = exit_code else {
        return "unknown";
    };
    if !(129..=255).contains(&status) {
        return "unknown";
    }
    let errno = 256 - status;

    #[cfg(target_os = "macos")]
    match errno {
        libc::EACCES => "EACCES",
        libc::EPIPE => "EPIPE",
        libc::ENETDOWN => "ENETDOWN",
        libc::ENETRESET => "ENETRESET",
        libc::ECONNRESET => "ECONNRESET",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        _ => "unknown",
    }

    #[cfg(target_os = "linux")]
    match errno {
        libc::EACCES => "EACCES",
        libc::EPIPE => "EPIPE",
        libc::ENETDOWN => "ENETDOWN",
        libc::ENETRESET => "ENETRESET",
        libc::ECONNRESET => "ECONNRESET",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        _ => "unknown",
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = errno;
        "unknown"
    }
}

fn has_npm_lifecycle_failure_marker(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    // Recognise BOTH the modern (`npm error …`) and legacy (`npm err! …`)
    // spellings, mirroring the lifecycle parser (npm_lifecycle_failure) which
    // already supports `npm err!`. Without the legacy spelling an older npm's
    // `npm ERR! command failed` carrying a transient code (e.g. EIDLETIMEOUT)
    // would slip past this guard and be silently absorbed as a registry timeout,
    // even though it is a real build/lifecycle failure that must stay loud.
    detail.contains("npm error command failed")
        || detail.contains("npm err! command failed")
        || detail.contains("elifecycle")
        || detail.contains("npm error command sh -c")
        || detail.contains("npm err! command sh -c")
}

/// Windows reports an aborting child as an NTSTATUS in `ExitStatus::code()`.
/// Rust exposes the DWORD as a signed `i32`, hence these otherwise-surprising
/// negative values. They are both normal user-machine interruptions for an
/// npm subprocess: `STATUS_CONTROL_C_EXIT` means a user/session manager
/// stopped it, and `STATUS_STACK_BUFFER_OVERRUN` is Node's Windows abort path.
/// Neither identifies an HQ service or desktop-app defect.
const WINDOWS_CONTROL_C_EXIT: i32 = -1_073_741_510; // 0xC000013A
const WINDOWS_ABORT_EXIT: i32 = -1_073_740_791; // 0xC0000409

/// libuv encodes a Windows `EPERM` ("operation not permitted") as this signed
/// errno, and npm propagates it as the install process's exit code when it
/// cannot replace the `hq` executable because the file is locked or in use — a
/// running `hq`/terminal process, or antivirus/endpoint protection holding the
/// binary open. This is the same value Node surfaces as
/// `{ errno: -4048, code: 'EPERM' }`. Like the abort codes above, it is a
/// normal user-machine condition, not an HQ updater defect (HQ-DESKTOP-3N).
const WINDOWS_EPERM_EXIT: i32 = -4048;

/// Whether a failed npm install is the EXPECTED Windows "the `hq` binary is
/// locked / in use" condition (libuv `EPERM`). npm bubbles the same underlying
/// error two ways depending on where it aborts:
///   * as the install process's exit code — the raw libuv errno `-4048`, or
///   * in its stderr as `code EPERM` / `errno -4048` / "operation not
///     permitted" while renaming or unlinking the package it is replacing.
///
/// This is the Windows analogue of the `EACCES` sudo case: a local-machine
/// setup/interference fault the app already handles with the copy-the-command
/// UI fallback, not an updater defect. `EACCES` is classified by
/// `is_prefix_permission_failure`, so it is explicitly excluded here to keep the
/// two buckets disjoint. The `hq-cli` updater only ever runs
/// `npm install -g @indigoai-us/hq-cli@latest`, so an `EPERM` from that run is
/// the locked-binary case rather than an unrelated permission fault.
pub fn is_windows_locked_binary_failure(exit_code: Option<i32>, detail: &str) -> bool {
    if exit_code == Some(WINDOWS_EPERM_EXIT) {
        return true;
    }
    let detail = detail.to_ascii_lowercase();
    if detail.contains("eacces") {
        return false;
    }
    detail.contains("eperm")
        || detail.contains("operation not permitted")
        || detail.contains("errno -4048")
}

/// Whether a failed npm install is the EXPECTED "the machine's disk is full"
/// condition (`ENOSPC`). npm surfaces disk exhaustion two ways: as its own
/// structured `code ENOSPC` line when the install could not write a file (the
/// reported HQ-DESKTOP-53 shape: `code ENOSPC`, `syscall write`), or — for an
/// OS-level write that never produced a clean npm `code` line — as the literal
/// `no space left on device` errno text. Both are a local-machine condition the
/// user fixes by freeing space, not an updater defect: no code change can
/// install packages onto a full disk, and the app already falls back to the
/// copy-the-command UI while retaining the raw npm output in the local log.
///
/// Keyed on npm's OWN `ENOSPC` code (the same way [`is_npm_bin_collision`] keys
/// on `EEXIST`) so an unrelated defect whose stderr merely mentions `ENOSPC`
/// cannot be swallowed. The phrase fallback is additionally excluded whenever npm
/// reported a lifecycle failure — checked with `npm_lifecycle_failure`, which
/// recognizes BOTH the modern `npm error` and legacy `npm ERR!` spellings — so a
/// third-party build script that ran out of space keeps its lifecycle event, its
/// `disk-space` cause, and its per-package signature. (`has_npm_lifecycle_failure_marker`
/// alone misses the legacy `npm ERR! command failed` spelling, so the authoritative
/// lifecycle check is required.) npm reports an all-digit or `ELIFECYCLE` code for a
/// lifecycle failure, so the code clause can never match one either.
pub fn is_disk_exhaustion_failure(detail: &str) -> bool {
    if npm_error_code(detail) == "ENOSPC" {
        return true;
    }
    detail.to_ascii_lowercase().contains("no space left on device")
        && !has_npm_lifecycle_failure_marker(detail)
        && !npm_lifecycle_failure(detail).failed
}

/// Stable classification for a failed npm install. Expected local-machine
/// failures stay actionable in the UI/local log and normally do not page
/// Sentry. A bin collision that survived npm's forced remedy is the exception:
/// it stays observable at Warning under its own fingerprint. Third-party
/// lifecycle failures remain Error-level but have a separate fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFailureKind {
    ExpectedPrefixPermission,
    ExpectedWindowsAbort,
    ExpectedWindowsLockedBinary,
    ExpectedTransientRegistry,
    ExpectedBinCollision,
    ExpectedDiskFull,
    UnexpectedLifecycle,
    Unexpected,
    /// The user's PATH Node is older than [`MIN_NODE_MAJOR`], so the published
    /// CLI (whose own `engines.node` rules it out) can never install and npm dies
    /// before emitting its structured error block. A permanent per-machine
    /// runtime condition, not an updater defect — a strict refinement of
    /// `Unexpected`, applied only when the probed environment proves the runtime
    /// is too old.
    UnsupportedNode,
}

/// A bin collision is expected only when npm's documented `--force` remedy
/// was applied to the final attempt that produced this exact structured npm
/// failure. A bare EEXIST token elsewhere in stderr remains reportable.
pub fn is_npm_bin_collision(detail: &str, prefix: Option<&str>) -> bool {
    npm_error_code(detail) == "EEXIST" && npm_path_shape(detail, prefix) == NpmPathShape::BinHq
}

pub fn classify_install_failure(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> InstallFailureKind {
    classify_install_failure_with_final_attempt(exit_code, detail, prefix, false)
}

/// Classify a failed npm install with the retry-run's causal context. The
/// default classifier above intentionally uses `false`, so callers that did
/// not run the bounded retry ladder cannot suppress an EEXIST on assumption.
pub fn classify_install_failure_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> InstallFailureKind {
    // Disk exhaustion is decided FIRST, mirroring the precedence documented on
    // `npm_lifecycle_cause` ("disk exhaustion is unambiguous and dominates"). The
    // arms stay disjoint by construction: this one requires npm's own `ENOSPC`
    // code (or the unambiguous errno phrase with no lifecycle marker), while the
    // permission, Windows-EPERM and bin-collision arms require EACCES, EPERM/-4048
    // and EEXIST respectively.
    if is_disk_exhaustion_failure(detail) {
        InstallFailureKind::ExpectedDiskFull
    } else if is_prefix_permission_failure(detail, prefix)
        || is_global_prefix_permission_failure(exit_code, detail)
    {
        InstallFailureKind::ExpectedPrefixPermission
    } else if matches!(exit_code, Some(WINDOWS_CONTROL_C_EXIT | WINDOWS_ABORT_EXIT)) {
        InstallFailureKind::ExpectedWindowsAbort
    } else if is_windows_locked_binary_failure(exit_code, detail) {
        InstallFailureKind::ExpectedWindowsLockedBinary
    } else if !has_npm_lifecycle_failure_marker(detail)
        && is_expected_transient_registry_failure(detail)
    {
        InstallFailureKind::ExpectedTransientRegistry
    } else if final_attempt_forced && is_npm_bin_collision(detail, prefix) {
        InstallFailureKind::ExpectedBinCollision
    } else if is_third_party_npm_lifecycle_failure(detail) {
        InstallFailureKind::UnexpectedLifecycle
    } else {
        InstallFailureKind::Unexpected
    }
}

/// The minimum Node major the published `@indigoai-us/hq-cli` supports: its
/// `engines.node` is `>=20.0.0`, so no modern npm can install it under an older
/// runtime. This is the single source of truth for that floor — the Sync-lane
/// preflight (`commands/sync.rs`) consumes this same constant, so the updater's
/// unsupported-Node classifier and the preflight can never drift apart.
pub const MIN_NODE_MAJOR: u32 = 20;

/// Parse the major integer from an already-[`sanitized_version_token`]ed node
/// version. Returns `None` for `unknown` or anything without a leading numeric
/// component. The input has already crossed the scrub boundary, so the returned
/// integer is bounded and carries none of the caller's free text.
fn node_major_from_sanitized(sanitized: &str) -> Option<u32> {
    sanitized
        .split('.')
        .next()
        .filter(|head| !head.is_empty())
        .and_then(|head| head.parse::<u32>().ok())
}

/// The probed Node major for an install environment, or `None` when the probe
/// returned nothing parseable (absent, malformed, or `unknown`). Sanitizes
/// first, so this is the ONLY numeric read of a probed version and it inherits
/// [`sanitized_version_token`]'s scrub guarantee.
fn probed_node_major(env: &InstallEnvironment) -> Option<u32> {
    node_major_from_sanitized(&sanitized_version_token(env.node_version.as_deref()))
}

/// Classify a failed npm install WITH the probed toolchain environment. A strict
/// refinement of [`classify_install_failure_with_final_attempt`]: it delegates
/// first and rewrites the result ONLY when the delegate returned exactly
/// `Unexpected` AND the probed Node major parsed AND is strictly below
/// [`MIN_NODE_MAJOR`] — a runtime the CLI's own `engines.node` makes install
/// impossible on. Every expected/lifecycle kind is returned untouched, and a
/// machine on a supported Node (or one whose probe was unparseable) is
/// byte-identical to the env-blind classifier, so `InstallEnvironment::default()`
/// reproduces today's behaviour for every existing caller.
pub fn classify_install_failure_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> InstallFailureKind {
    let base =
        classify_install_failure_with_final_attempt(exit_code, detail, prefix, final_attempt_forced);
    if base == InstallFailureKind::Unexpected
        && probed_node_major(env).is_some_and(|major| major < MIN_NODE_MAJOR)
    {
        return InstallFailureKind::UnsupportedNode;
    }
    base
}

impl InstallFailureKind {
    /// A stable grouping key for diagnostics and Sentry. We intentionally keep
    /// expected local failures separate from actual updater defects; the
    /// post-force bin-collision exception remains visible at Warning while the
    /// other expected kinds are not sent by `report_install_failure`.
    pub fn fingerprint_component(self) -> &'static str {
        match self {
            Self::ExpectedPrefixPermission => "expected-prefix-permission",
            Self::ExpectedWindowsAbort => "expected-windows-abort",
            Self::ExpectedWindowsLockedBinary => "expected-windows-locked-binary",
            Self::ExpectedTransientRegistry => "expected-transient-registry",
            Self::ExpectedBinCollision => "expected-bin-collision",
            Self::ExpectedDiskFull => "expected-disk-full",
            Self::UnexpectedLifecycle => "unexpected-lifecycle",
            Self::Unexpected => "unexpected",
            Self::UnsupportedNode => "unsupported-node",
        }
    }
}

/// `npm_error_code` echoes npm's own `code` token verbatim. For a lifecycle
/// failure that token is the failed build script's numeric exit status ("1",
/// "7", …), which carries no classification power the event does not already
/// hold in its closed-enumeration tags — and using it for grouping would
/// reintroduce exactly the exit-status cardinality the signature exists to
/// remove. Collapse any purely numeric (or absent) code to `none`; symbolic
/// codes such as `ENOTDIR` or `EEXIST` are real discriminators and are kept.
fn symbolic_npm_error_code(detail: &str) -> String {
    let code = npm_error_code(detail);
    if code.bytes().all(|byte| byte.is_ascii_digit()) {
        return "none".to_string();
    }
    code
}

/// The grouping discriminator for a reportable install failure.
///
/// Every component is a closed enumeration or an npm package name already
/// validated by `is_safe_npm_package_name`, so the fingerprint keeps the same
/// scrub-safety guarantee as the tags: no free text, no raw npm stderr, no
/// filesystem path.
///
/// The process exit status is deliberately NOT part of it. npm reports a failed
/// build script's own status, so one broken dependency opened a new Sentry issue
/// per status (HQ-DESKTOP-4G exit 1 and HQ-DESKTOP-4H exit 7 are the same
/// better-sqlite3 build), and for an OS errno failure the status is only
/// `256 - errno` — a lossy restatement of `npm_error_code` plus `npm_syscall`
/// (HQ-DESKTOP-4J exit 236 is `ENOTDIR`). The same key also under-grouped:
/// unrelated dependencies merged whenever they happened to share a status. The
/// raw status stays on the `exit_code` tag and inside `npm_diagnostics`, where
/// it remains searchable without deciding the group.
fn install_failure_signature(
    kind: InstallFailureKind,
    detail: &str,
    prefix: Option<&str>,
) -> String {
    if kind == InstallFailureKind::UnexpectedLifecycle {
        // Classification already proved a third-party package was attributed,
        // so this branch keys on the dependency whose build actually failed AND
        // the diagnosed cause. Appending the cause (never substituting it for
        // the package, so the e0afe711 per-package split is preserved) stops a
        // prebuild gap and a missing compiler from sharing one issue. `cause` is
        // a closed enumeration, so cardinality stays bounded to package × cause.
        let package = npm_lifecycle_failure(detail).package;
        let package = package.as_deref().unwrap_or("unrecognized");
        let cause = npm_lifecycle_cause(detail);
        return format!("lifecycle:{package}:{cause}");
    }
    format!(
        "{}:{}:{}",
        symbolic_npm_error_code(detail),
        npm_syscall(detail),
        npm_path_shape(detail, prefix).tag_value(),
    )
}

/// The grouping discriminator including the probed environment. For the
/// unsupported-node shape it is `unsupported-node:<major>`, where `<major>` is
/// the parsed integer from [`probed_node_major`] and nothing else — so the group
/// is distinct from the genuinely-unknown `none:unknown:none` bucket while
/// staying free of any free text or filesystem path. Every other kind delegates
/// to the env-blind [`install_failure_signature`], unchanged.
fn install_failure_signature_with_environment(
    kind: InstallFailureKind,
    detail: &str,
    prefix: Option<&str>,
    env: &InstallEnvironment,
) -> String {
    if kind == InstallFailureKind::UnsupportedNode {
        let major = probed_node_major(env)
            .map(|major| major.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return format!("unsupported-node:{major}");
    }
    install_failure_signature(kind, detail, prefix)
}

/// Free-up-space guidance shared by BOTH disk-full paths — the lifecycle
/// `disk-space` cause arm (a build ran out of space) and the top-level
/// `ExpectedDiskFull` early return (npm itself hit `ENOSPC`). Reusing one literal
/// keeps the two paths in agreement and prevents drift, and keeps the "copied
/// command" UI escape hatch so a full disk never shows the user raw npm stderr.
const DISK_FULL_DETAIL: &str = "The install ran out of disk space while building a component hq needs. Free up disk space, then run the copied command in a terminal.";

/// User-facing fallback text for an install failure that did not include useful
/// npm stderr. The desktop UI always offers the copy-command escape hatch; the
/// Windows abort wording tells the user why retrying after closing competing
/// terminals/Node processes is worthwhile instead of presenting a raw NTSTATUS.
pub fn install_failure_detail(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> String {
    install_failure_detail_with_final_attempt(exit_code, detail, prefix, false)
}

pub fn install_failure_detail_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> String {
    install_failure_detail_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        &InstallEnvironment::default(),
    )
}

/// Like [`install_failure_detail_with_final_attempt`], but classifies with the
/// probed environment so an unsupported-Node failure shows the user the required
/// Node version instead of the raw Node parse error the empty-stderr passthrough
/// would otherwise surface. Default env reproduces the env-blind copy exactly.
pub fn install_failure_detail_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> String {
    let kind = classify_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    );
    if kind == InstallFailureKind::UnsupportedNode {
        // A local runtime the CLI's own engines field rules out. Name the
        // required Node instead of echoing the raw Node parse error. Placed
        // BEFORE the non-empty-stderr passthrough below so a Node-6 SyntaxError
        // is never shown to the user verbatim.
        return format!(
            "hq needs Node.js {MIN_NODE_MAJOR} or newer, but this computer's Node is too old to install it. Install the supported Node.js (version 22), then run the copied command in a terminal."
        );
    }
    if kind == InstallFailureKind::ExpectedTransientRegistry {
        return "npm's registry was temporarily unavailable or was mid-publish. The updater will retry automatically on its next scheduled check; you can also retry the copied command shortly."
            .to_string();
    }
    if kind == InstallFailureKind::ExpectedBinCollision {
        return format!(
            "An existing hq shim is blocking this update. Remove or rename the stale shim named in npm's output, then run the copied command in a fresh terminal.\n\n{}",
            detail.trim()
        );
    }
    if kind == InstallFailureKind::ExpectedDiskFull {
        // A full disk shows the free-up-space remedy, never the raw npm stderr
        // the passthrough below would otherwise surface.
        return DISK_FULL_DETAIL.to_string();
    }
    if npm_lifecycle_failure(detail).failed {
        // Cause-specific, actionable wording. Every branch keeps the copyable
        // command escape hatch ("copied command") so the UI fallback is intact
        // regardless of which cause was diagnosed.
        return match npm_lifecycle_cause(detail) {
            "toolchain-missing" => "A dependency needs to build a native component, but the build tools are missing. On macOS, install them by running `xcode-select --install`, then run the copied command in a terminal.",
            "prebuild-unavailable" => "Your installed Node.js version has no prebuilt binary for a component hq needs, so npm tried to build it from source and failed. Install the supported Node.js (version 22), then run the copied command in a terminal.",
            "network" => "A prebuilt component could not be downloaded while installing hq. Check your network or proxy, then run the copied command in a terminal to retry.",
            "disk-space" => DISK_FULL_DETAIL,
            _ => "A dependency build step failed while npm was installing hq. Run the copied command in a terminal to see the full build output and repair the local toolchain.",
        }
        .to_string();
    }
    if !detail.trim().is_empty() {
        return detail.trim().to_string();
    }
    match kind {
        InstallFailureKind::ExpectedPrefixPermission => {
            "npm cannot write its global prefix. Run the copied command in a terminal with a user-owned npm prefix (or use an administrator-approved install).".to_string()
        }
        InstallFailureKind::ExpectedWindowsAbort => {
            "npm's Windows child process was interrupted or aborted. Close competing npm/Node terminals, retry the copied command in a fresh terminal, and check endpoint protection if it keeps happening.".to_string()
        }
        InstallFailureKind::ExpectedWindowsLockedBinary => {
            "npm could not replace the hq program because the file is locked or in use (a running hq command or terminal, or antivirus/endpoint protection). Close any open hq processes and terminals, then retry the copied command in a fresh terminal; if it keeps happening, allow-list hq in your endpoint protection.".to_string()
        }
        InstallFailureKind::ExpectedTransientRegistry => {
            "npm's registry was temporarily unavailable or was mid-publish. The updater will retry automatically on its next scheduled check; you can also retry the copied command shortly.".to_string()
        }
        InstallFailureKind::ExpectedBinCollision => {
            "An existing hq shim is blocking this update. Remove or rename the stale shim, then run the copied command in a fresh terminal."
                .to_string()
        }
        // Unreachable in practice — `ExpectedDiskFull` returns early above,
        // before the empty-stderr fallback — but the match must stay exhaustive.
        InstallFailureKind::ExpectedDiskFull => DISK_FULL_DETAIL.to_string(),
        // `UnsupportedNode` returns its actionable copy early above; this arm
        // keeps the match exhaustive without ever being reached for it.
        InstallFailureKind::Unexpected
        | InstallFailureKind::UnexpectedLifecycle
        | InstallFailureKind::UnsupportedNode => format!(
            "npm install exited with status {}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal/none".to_string())
        ),
    }
}

/// Decide whether a CLI-install failure should be reported to Sentry, and with
/// what message. Returns `None` for expected local-machine failures except a
/// post-force bin collision, which is captured once at Warning — the
/// permission failure at the selected npm global prefix (HQ-SYNC-WEB-Y: exit
/// 243, 180 events / 7 users), the Windows child abort codes, the Windows
/// `EPERM` locked-binary condition (HQ-DESKTOP-3N: exit -4048), and a full disk
/// (HQ-DESKTOP-53: `ENOSPC`, where no code change can install packages onto a
/// full disk). The app already handles each gracefully (the UI falls back to the
/// copy-the-command path and the failure is kept in the local diagnostic log for
/// Connect diagnostics), so an Error-level capture on every auto-update cycle is
/// pure noise. Returns
/// `Some(message)` for every genuine, unexpected failure, including permission
/// errors at another path — that is the real signal we want to stay loud at
/// Error level.
pub fn install_failure_report(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> Option<String> {
    install_failure_report_with_final_attempt(exit_code, detail, prefix, false)
}

pub fn install_failure_report_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> Option<String> {
    install_failure_report_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        &InstallEnvironment::default(),
    )
}

/// Like [`install_failure_report_with_final_attempt`], but classifies with the
/// probed environment so an unsupported-Node failure stays observable under its
/// own bounded signature. Every expected kind still returns `None`; the
/// unsupported-node kind reports (downgraded to Warning by
/// [`report_install_failure_with_environment`], since it is a local-runtime
/// condition, not an updater defect). Default env reproduces the env-blind result
/// exactly.
pub fn install_failure_report_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> Option<String> {
    let kind = classify_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    );
    match kind {
        InstallFailureKind::ExpectedBinCollision => {
            return Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
        }
        InstallFailureKind::Unexpected
        | InstallFailureKind::UnexpectedLifecycle
        | InstallFailureKind::UnsupportedNode => {}
        InstallFailureKind::ExpectedPrefixPermission
        | InstallFailureKind::ExpectedWindowsAbort
        | InstallFailureKind::ExpectedWindowsLockedBinary
        | InstallFailureKind::ExpectedTransientRegistry
        | InstallFailureKind::ExpectedDiskFull => return None,
    }
    // Title the capture with the same signature the fingerprint groups on, so a
    // Sentry issue's title cannot drift across the events inside it. The raw
    // exit status stays on the `exit_code` tag and in `npm_diagnostics`.
    let signature = install_failure_signature_with_environment(kind, detail, prefix, env);
    Some(format!("[hq-cli-update] install failed ({signature})"))
}

/// Which toolchain the failing npm run used, as a CLOSED enumeration. The
/// caller decides this from whether the resolved npm/node path is inside the
/// app's managed toolchain directory; only the enum value ever reaches Sentry,
/// never a filesystem path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NpmToolchainSource {
    Managed,
    UserPath,
    #[default]
    Unknown,
}

impl NpmToolchainSource {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::UserPath => "user-path",
            Self::Unknown => "unknown",
        }
    }
}

/// Toolchain provenance for a failed hq-CLI install — the evidence the reported
/// HQ-DESKTOP-4R / HQ-DESKTOP-4S events lacked. Every version field is optional
/// because the updater probes them best-effort; a missing or malformed value is
/// tagged `unknown`. The version/ABI strings are raw here and are reduced to a
/// strictly bounded numeric token before they are ever tagged (see
/// [`sanitized_version_token`]), so no caller-supplied free text can reach
/// Sentry through them.
#[derive(Debug, Clone, Default)]
pub struct InstallEnvironment {
    pub node_version: Option<String>,
    pub node_abi: Option<String>,
    pub npm_version: Option<String>,
    pub toolchain_source: NpmToolchainSource,
    pub managed_toolchain_retry: bool,
}

/// Reduce a caller-supplied node/npm version or Node ABI to a strictly bounded
/// token (ASCII digits and dots, at least one digit, 1..=24 chars) or the
/// literal `unknown`. This is the ONLY path by which a probed version reaches
/// Sentry, so it is the scrub-safety boundary for those values: anything that
/// is empty, over-long, or contains any other byte collapses to `unknown`.
fn sanitized_version_token(raw: Option<&str>) -> String {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return "unknown".to_string();
    };
    let value = raw.strip_prefix('v').unwrap_or(raw);
    if (1..=24).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && value.bytes().any(|byte| byte.is_ascii_digit())
    {
        value.to_string()
    } else {
        "unknown".to_string()
    }
}

/// The provenance segment appended to `npm_diagnostics`. Its shape is constant
/// (always these five keys) so the extra stays trivially assertable; each value
/// is already a closed enumeration or a `sanitized_version_token` output.
fn install_environment_diagnostics_suffix(
    lifecycle_cause: Option<&str>,
    node_version: &str,
    node_abi: &str,
    npm_version: &str,
    toolchain_source: &str,
) -> String {
    format!(
        "lifecycle_cause={} node_version={} node_abi={} npm_version={} toolchain_source={}",
        lifecycle_cause.unwrap_or("none"),
        node_version,
        node_abi,
        npm_version,
        toolchain_source,
    )
}

/// Capture an auto/manual CLI-install failure to Sentry — but only when it is a
/// reportable failure (see `install_failure_report`). The expected permission
/// failure at the selected global prefix is deliberately NOT captured: it
/// floods Sentry with an unactionable Error every auto-update cycle while the
/// user already has the copy-the-command fallback. A post-force bin collision
/// is instead captured once at Warning. Captures include only a normalized,
/// closed-enumeration diagnostic summary; raw npm stderr remains in the local
/// diagnostic log and never reaches Sentry.
pub fn report_install_failure(exit_code: Option<i32>, detail: &str, prefix: Option<&str>) {
    report_install_failure_with_final_attempt(exit_code, detail, prefix, false);
}

pub fn report_install_failure_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) {
    report_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        &InstallEnvironment::default(),
    );
}

/// Like [`report_install_failure_with_final_attempt`], but also attaches the
/// toolchain provenance the reported HQ-DESKTOP-4R / HQ-DESKTOP-4S events were
/// missing — the diagnosed lifecycle cause, the Node version and ABI, the npm
/// version, whether npm ran under the app's managed toolchain, and whether a
/// managed-toolchain retry was armed. Every added value is a closed enumeration
/// or a strictly validated numeric token, so the capture keeps the same
/// scrub-safety guarantee as before.
pub fn report_install_failure_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) {
    let kind = classify_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    );
    let Some(message) = install_failure_report_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    ) else {
        return;
    };
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    let signature = install_failure_signature_with_environment(kind, detail, prefix, env);
    let eacces =
        has_eacces_evidence(detail) || kind == InstallFailureKind::ExpectedPrefixPermission;
    let npm_path_shape = npm_path_shape(detail, prefix);
    // Which declared hq-cli shim the event's path names, as a closed
    // enumeration. Kept OUT of the fingerprint (see `install_failure_signature`)
    // so grouping stays stable while a merged collision group can still tell a
    // `hq` collision from a `hq-auth-refresh` one.
    let npm_bin_target = npm_bin_target(detail);
    let npm_prefix_known = prefix.is_some();
    let npm_error_code = npm_error_code(detail);
    let npm_lifecycle = npm_lifecycle_failure(detail);
    let npm_stderr_len = detail.len().to_string();
    let npm_errno = npm_errno_from_exit_status(exit_code);
    // The lifecycle cause is meaningful only when npm actually reported a
    // lifecycle failure (parallel to `npm_lifecycle_package`); otherwise the
    // provenance suffix records it as `none`.
    let lifecycle_cause = if npm_lifecycle.failed {
        Some(npm_lifecycle_cause(detail))
    } else {
        None
    };
    // Which builder emitted the failure (closed enumeration), present exactly when
    // a lifecycle failure was reported. This makes node-llama-cpp's cmake-js /
    // postinstall failures self-diagnosing instead of degrading to `unknown`.
    let lifecycle_builder = if npm_lifecycle.failed {
        Some(npm_lifecycle_builder(detail))
    } else {
        None
    };
    let node_version = sanitized_version_token(env.node_version.as_deref());
    let node_abi = sanitized_version_token(env.node_abi.as_deref());
    let npm_version = sanitized_version_token(env.npm_version.as_deref());
    let toolchain_source = env.toolchain_source.tag_value();
    let npm_diagnostics = format!(
        "{} {}",
        npm_diagnostics_summary(
            exit_str.as_str(),
            npm_errno,
            detail,
            npm_path_shape,
            npm_prefix_known,
            eacces,
        ),
        install_environment_diagnostics_suffix(
            lifecycle_cause,
            &node_version,
            &node_abi,
            &npm_version,
            toolchain_source,
        ),
    );
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("install_failure_kind", kind.fingerprint_component());
            scope.set_tag("exit_code", exit_str.as_str());
            scope.set_tag("eacces", if eacces { "true" } else { "false" });
            scope.set_tag("npm_failure_site", npm_failure_site(detail, prefix));
            scope.set_tag("npm_error_code", npm_error_code.as_str());
            scope.set_tag("npm_syscall", npm_syscall(detail));
            scope.set_tag("npm_path_shape", npm_path_shape.tag_value());
            scope.set_tag("npm_bin_target", npm_bin_target);
            scope.set_tag(
                "npm_final_attempt_forced",
                if final_attempt_forced {
                    "true"
                } else {
                    "false"
                },
            );
            scope.set_tag(
                "npm_lifecycle_failed",
                if npm_lifecycle.failed {
                    "true"
                } else {
                    "false"
                },
            );
            if npm_lifecycle.failed {
                scope.set_tag(
                    "npm_lifecycle_package",
                    npm_lifecycle.package.as_deref().unwrap_or("unrecognized"),
                );
            }
            if let Some(cause) = lifecycle_cause {
                scope.set_tag("npm_lifecycle_cause", cause);
            }
            if let Some(builder) = lifecycle_builder {
                scope.set_tag("npm_lifecycle_builder", builder);
            }
            // Toolchain provenance — the fields the reported 4R/4S events lacked,
            // which make the next occurrence self-diagnosing. Each is a closed
            // enumeration or a validated numeric token.
            scope.set_tag("node_version", node_version.as_str());
            scope.set_tag("node_abi", node_abi.as_str());
            scope.set_tag("npm_version", npm_version.as_str());
            scope.set_tag("npm_toolchain_source", toolchain_source);
            scope.set_tag(
                "npm_managed_toolchain_retry",
                if env.managed_toolchain_retry {
                    "true"
                } else {
                    "false"
                },
            );
            scope.set_tag(
                "npm_prefix_known",
                if npm_prefix_known { "true" } else { "false" },
            );
            scope.set_tag("npm_stderr_len", npm_stderr_len.as_str());
            scope.set_tag("npm_errno", npm_errno);
            // Group on the failure's bounded signature, never on npm's exit
            // status — see `install_failure_signature`.
            let fingerprint = [
                "hq-cli-update",
                "install-failed",
                kind.fingerprint_component(),
                signature.as_str(),
            ];
            scope.set_fingerprint(Some(&fingerprint));
            scope.set_extra("npm_diagnostics", npm_diagnostics.into());
        },
        || {
            // A local-runtime condition, not an updater defect: an unsupported
            // Node is downgraded alongside the post-force bin collision, so it
            // stays observable without paging at Error.
            let level = if matches!(
                kind,
                InstallFailureKind::ExpectedBinCollision | InstallFailureKind::UnsupportedNode
            ) {
                sentry::Level::Warning
            } else {
                sentry::Level::Error
            };
            sentry::capture_message(&message, level);
        },
    );
}

/// Per-machine episode key for a reportable install failure, or `None` when the
/// failure is not a third-party lifecycle failure. Only lifecycle failures recur
/// identically on every scheduled check (the machine's Node ABI has no prebuild,
/// or its compiler is missing — a permanent per-machine condition), so only they
/// warrant repeat-suppression; every other reportable failure keeps paging as it
/// does today.
///
/// The key is the exact tuple that must change before the same machine pages
/// again: the CLI version being installed, the failing dependency, and the
/// diagnosed cause. Every component is a closed enumeration or an already
/// `is_safe_npm_package_name`-validated package name, so the key is safe to
/// persist and log. `latest` is a published npm version string the updater
/// resolved, not user input.
pub fn install_failure_episode_key(latest: &str, detail: &str) -> Option<String> {
    if !is_third_party_npm_lifecycle_failure(detail) {
        return None;
    }
    let package = npm_lifecycle_failure(detail).package;
    let package = package.as_deref().unwrap_or("unrecognized");
    let cause = npm_lifecycle_cause(detail);
    Some(format!("{latest}|{package}|{cause}"))
}

/// The repeat-guard key including toolchain provenance. A managed-toolchain retry
/// failure is a DISTINCT diagnostic episode from the user-path failure that
/// preceded it: without the `|managed` discriminator, a prior user-path report for
/// the same `(latest, package, cause)` — for example a run where provisioning was
/// skipped (cooldown) or failed, then retried and reported the user-path failure —
/// would suppress this managed-provenance event, and the whole point of retrying
/// under a known runtime is the diagnostic it emits. Pure so it is unit-testable
/// without sending anything; delegates the base key so the closed-set safety and
/// third-party-only minting are unchanged.
pub fn install_failure_episode_key_with_provenance(
    latest: &str,
    detail: &str,
    managed_toolchain_retry: bool,
) -> Option<String> {
    install_failure_episode_key(latest, detail).map(|key| {
        if managed_toolchain_retry {
            format!("{key}|managed")
        } else {
            key
        }
    })
}

/// The repeat-guard key including the probed environment. The unsupported-node
/// shape is a permanent per-machine condition — a runtime the CLI's own
/// `engines.node` rules out — so, like a third-party lifecycle failure, it must
/// page once per CLI target version rather than on every scheduled check. Its key
/// is `(latest × unsupported-node × node major [× managed])`; every component is a
/// closed literal or a bounded integer, so it is safe to persist and log. Every
/// other shape delegates to [`install_failure_episode_key_with_provenance`], so
/// third-party-lifecycle minting and its closed-set safety are unchanged, and a
/// default environment reproduces today's key exactly.
pub fn install_failure_episode_key_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    latest: &str,
    env: &InstallEnvironment,
) -> Option<String> {
    let kind = classify_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    );
    if kind == InstallFailureKind::UnsupportedNode {
        let major = probed_node_major(env)?;
        let key = format!("{latest}|unsupported-node|{major}");
        return Some(if env.managed_toolchain_retry {
            format!("{key}|managed")
        } else {
            key
        });
    }
    if kind == InstallFailureKind::Unexpected {
        // A genuinely unexpected install failure with a DISCRIMINATING shape recurs
        // identically on every 6-hourly check — the HQ-DESKTOP-5B ENOTEMPTY wedge is
        // the archetype: its debris survives (root-owned or locked) so the same
        // rename fails again, forever. Page it once per published CLI version, not
        // on every check. Key on the SAME closed-enumeration signature the Sentry
        // group already uses (`install_failure_signature`): symbolic error code ×
        // syscall × path shape. Every component is a validated closed value already
        // tagged today, so the key stays persist- and log-safe, and any change in
        // signature — or a newly published `latest` — mints a new key and pages a
        // first occurrence again. The `|managed` discriminator matches the other
        // shapes so a managed-retry event never collides with its user-path
        // predecessor.
        let code = symbolic_npm_error_code(detail);
        let syscall = npm_syscall(detail);
        let path_shape = npm_path_shape(detail, prefix).tag_value();
        // A fully SHAPELESS failure (`none:unknown:none` — npm structured nothing)
        // must NOT be repeat-suppressed: two entirely different root causes collapse
        // into that single empty signature, so bounding it would hide a newly
        // introduced updater failure behind an unrelated earlier one until the next
        // CLI version publishes. Such failures keep paging every time, exactly as
        // today; only a shape npm actually characterised earns the bound.
        if code == "none" && syscall == "unknown" && path_shape == "none" {
            return None;
        }
        let key = format!("{latest}|unexpected|{code}|{syscall}|{path_shape}");
        return Some(if env.managed_toolchain_retry {
            format!("{key}|managed")
        } else {
            key
        });
    }
    install_failure_episode_key_with_provenance(latest, detail, env.managed_toolchain_retry)
}

/// Whether a lifecycle-failure episode identical to one already reported on this
/// machine should be suppressed: the `current_key` is already in the machine's
/// reported-key set. Mirrors [`non_convergent_episode_blocked`], but over a SET
/// rather than a single last key — this dependency closure has more than one
/// native module that can fail (better-sqlite3, node-llama-cpp), and npm has run
/// lifecycle scripts concurrently since v7, so which one surfaces first varies
/// run to run. A single-slot marker let an A/B/A sequence overwrite itself and
/// re-page every check; keying on membership fixes that. A caller that cannot
/// read its marker passes an empty slice and therefore always reports —
/// fail-closed, staying loud (commit 3f52d298).
pub fn install_failure_episode_blocked(reported_keys: &[String], current_key: &str) -> bool {
    reported_keys.iter().any(|key| key == current_key)
}

/// Upper bound on the reported-key set persisted per machine, so a pathological
/// stream of distinct failures cannot grow menubar.json without limit.
pub const MAX_INSTALL_FAILURE_EPISODE_KEYS: usize = 32;

/// The reported-key set to persist after reporting `current_key`. Keeps only the
/// keys for the CURRENT target version (a new `latest` resets the set, since its
/// keys carry a different `latest|` prefix and could never match anyway), appends
/// the new key, and bounds the result to the most-recent
/// [`MAX_INSTALL_FAILURE_EPISODE_KEYS`]. Retaining every current-version key —
/// not just the last — is what keeps an A/B/A interleave suppressed.
pub fn install_failure_episode_record(
    reported_keys: &[String],
    current_key: &str,
    latest: &str,
) -> Vec<String> {
    let prefix = format!("{latest}|");
    let mut kept: Vec<String> = reported_keys
        .iter()
        .filter(|key| key.starts_with(&prefix) && key.as_str() != current_key)
        .cloned()
        .collect();
    kept.push(current_key.to_string());
    if kept.len() > MAX_INSTALL_FAILURE_EPISODE_KEYS {
        let overflow = kept.len() - MAX_INSTALL_FAILURE_EPISODE_KEYS;
        kept.drain(0..overflow);
    }
    kept
}

/// Outcome of [`report_install_failure_episode`], telling the caller both what
/// happened and whether it must persist an updated marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallFailureEpisode {
    /// An expected local condition; nothing was sent (as today).
    NotReportable,
    /// The failure was reported to Sentry. `persist_keys` is `Some(updated set)`
    /// for a lifecycle episode — the caller persists it so every already-reported
    /// key for this target version stays suppressed — and `None` for a
    /// non-lifecycle failure, which is never repeat-suppressed.
    Reported { persist_keys: Option<Vec<String>> },
    /// A lifecycle episode already present in the reported-key set; deliberately
    /// not sent, so a permanent per-machine build failure stops re-paging on every
    /// scheduled check. The caller still logs it locally and unconditionally.
    SuppressedRepeat,
}

/// Report a CLI-install failure with the repeat-guard applied. The first
/// occurrence of a `(latest × package × cause)` key reports at Error exactly as
/// today (with the provenance from `env`); a repeat of any key already in
/// `reported_keys` is suppressed; a new CLI target version, package, or cause
/// reports again.
///
/// Persistence is deliberately left to the caller (mirroring how the
/// non-convergent marker is read/written in the app layer): pass the machine's
/// current reported-key set in `reported_keys`, and on a
/// `Reported { persist_keys: Some(set) }` outcome persist that set. A caller that
/// cannot read its marker passes an empty slice and therefore reports
/// (fail-closed).
pub fn report_install_failure_episode(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
    latest: &str,
    reported_keys: &[String],
) -> InstallFailureEpisode {
    // Only failures that would actually be captured are subject to the guard.
    if install_failure_report_with_environment(exit_code, detail, prefix, final_attempt_forced, env)
        .is_none()
    {
        return InstallFailureEpisode::NotReportable;
    }
    match install_failure_episode_key_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        latest,
        env,
    ) {
        // A non-lifecycle reportable failure: report every time, as before.
        None => {
            report_install_failure_with_environment(
                exit_code,
                detail,
                prefix,
                final_attempt_forced,
                env,
            );
            InstallFailureEpisode::Reported { persist_keys: None }
        }
        Some(key) => {
            if install_failure_episode_blocked(reported_keys, &key) {
                InstallFailureEpisode::SuppressedRepeat
            } else {
                report_install_failure_with_environment(
                    exit_code,
                    detail,
                    prefix,
                    final_attempt_forced,
                    env,
                );
                let persist_keys = install_failure_episode_record(reported_keys, &key, latest);
                InstallFailureEpisode::Reported {
                    persist_keys: Some(persist_keys),
                }
            }
        }
    }
}

/// Report a failure to prepare the updater's app-owned npm cache without
/// sending the local cache path or the raw filesystem error to Sentry.
pub fn report_npm_cache_setup_failure(category: &'static str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "cache-setup-failed");
            scope.set_tag("npm_cache_setup_failure", category);
            scope.set_fingerprint(Some(&["hq-cli-update", "cache-setup-failed", category]));
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] app-owned npm cache could not be prepared",
                sentry::Level::Error,
            );
        },
    );
}

/// Derive the npm global prefix from the exact `hq` binary the app resolved.
///
/// Unix npm uses `<prefix>/bin/hq`; Windows npm writes `<prefix>\hq.cmd`.
/// Detection is already anchored to `resolve_bin("hq")`, so the updater must
/// write to that same enclosing prefix or it can install a fresh CLI that the
/// app never executes. Deliberately avoid `canonicalize`: for Unix symlinks we
/// want the symlink's own prefix, not the package-internal target path.
///
/// **The `bin` guard on the Unix branch is load-bearing.** `resolve_bin` also
/// searches package managers whose global bin directory is *flat* — pnpm's
/// `~/Library/pnpm` (macOS) and `~/.local/share/pnpm` (Linux) both hold the
/// shim directly. For those, walking up two levels lands on a directory npm has
/// never managed (plain `~/Library`), and npm will cheerfully honour `--prefix`
/// there: it creates `~/Library/bin` + `~/Library/lib/node_modules`, exits 0,
/// and the install is invisible to every detection path. The updater then
/// reinstalls on every launch and every 6h check, forever, logging success each
/// time. So a parent directory literally named `bin` is what proves the
/// grandparent is an npm prefix; without it we return `None` and let npm use
/// its own configured global prefix, which is at least internally consistent
/// with `npm root -g` (the fallback `get_local_version` reads).
pub fn npm_prefix_from_hq_bin(hq_bin: &str) -> Option<String> {
    if hq_bin == "hq" {
        return None;
    }
    let path = Path::new(hq_bin);
    let parent = path.parent()?;
    let is_windows_npm_shim = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    let prefix = if is_windows_npm_shim {
        // `<prefix>\hq.cmd` — the shim sits directly in the prefix.
        parent
    } else {
        // `<prefix>/bin/hq`. A parent named `bin` is the only thing that proves
        // the grandparent is an npm prefix; see the doc comment for the pnpm
        // flat-dir case this rejects.
        if !matches!(parent.file_name().and_then(|n| n.to_str()), Some("bin")) {
            return None;
        }
        parent.parent()?
    };
    if prefix.as_os_str().is_empty() {
        None
    } else {
        Some(prefix.to_string_lossy().to_string())
    }
}

/// Whether the resolved `hq` is a shim in one of pnpm's global bin directories
/// (`~/Library/pnpm` on macOS, `~/.local/share/pnpm` on Linux,
/// `%LOCALAPPDATA%\pnpm` on Windows, the pnpm >=11 nested `<home>/bin`, or a
/// custom `PNPM_HOME`). npm cannot update such an install: `npm install -g`
/// writes an unrelated prefix, exits
/// 0, and the shim on PATH stays stale — the exact non-convergent loop
/// `install_converged` guards. pnpm-managed installs must be updated with
/// pnpm itself (`pnpm add -g`), so the installer branches on this.
///
/// Defined as exactly `pnpm_global_env(hq_bin).is_some()` — ONE derivation, ONE
/// source of truth — so DETECTION (does this route to the pnpm executor?) and
/// TARGETING (can the child's pnpm home be derived from the shim?) can never
/// disagree again. They previously diverged on the `<dir>/bin/hq` shape where
/// `<dir>/bin/global` exists but the grandparent is neither literally named
/// `pnpm` nor holds a `global/` store: [`pnpm_global_env`]'s `bin` arm returns
/// early with `None`, while the old body fell through to a final
/// `parent.join("global")` test (`<dir>/bin/global`) and returned `true`. The
/// app then entered the pnpm branch with no derivable home, spawned `pnpm add
/// -g` unaimed, and wedged auto-update. Collapsing the two reroutes exactly that
/// one previously-broken class to the npm executor — where
/// [`npm_prefix_from_hq_bin`] derives the correct `--prefix` — while every
/// currently-derivable pnpm layout (flat, pnpm >=11 nested, custom PNPM_HOME)
/// still routes to pnpm unchanged.
pub fn is_pnpm_global_shim(hq_bin: &str) -> bool {
    pnpm_global_env(hq_bin).is_some()
}

/// Whether the resolved `hq` is Bun's global shim at
/// `<BUN_INSTALL>/bin/hq`. The default home is `~/.bun`; custom homes are
/// recognised only when Bun's `install/global` tree exists beside `bin`.
/// That filesystem proof keeps an unrelated `/opt/homebrew/bin/hq` from being
/// classified as Bun merely because every Unix package manager uses `bin/`.
pub fn is_bun_global_shim(hq_bin: &str) -> bool {
    bun_home_from_hq_bin(Path::new(hq_bin)).is_some()
}

/// Derive `BUN_INSTALL` from a resolved Bun global shim.
pub fn bun_home_from_hq_bin(hq_bin: &Path) -> Option<std::path::PathBuf> {
    let parent = hq_bin.parent().filter(|path| !path.as_os_str().is_empty())?;
    if parent.file_name().and_then(|name| name.to_str()) != Some("bin") {
        return None;
    }
    let home = parent.parent().filter(|path| !path.as_os_str().is_empty())?;
    let is_default = home.file_name().and_then(|name| name.to_str()) == Some(".bun");
    let has_global_store = home.join("install").join("global").is_dir();
    (is_default || has_global_store).then(|| home.to_path_buf())
}

/// argv for updating a pnpm-managed global install.
///
/// `global_bin_dir` forces pnpm to write the new shim into the directory that
/// actually holds the resolved shim. Left to its own devices, pnpm treats
/// `PNPM_HOME` AS the global bin dir, so for the pnpm >=11 nested layout
/// (`<home>/bin/hq`, PNPM_HOME derived as the grandparent `<home>`) it writes the
/// shim flat into `<home>` and never touches the nested `<home>/bin/hq` the app
/// executes — the install exits 0 and nothing converges. `--config.global-bin-dir`
/// pins that dir explicitly. `None` (an underivable layout) omits the flag and
/// spawns pnpm exactly as before, inventing nothing. For the flat layout the home
/// and the global bin dir are the same directory, so the flag is a no-op.
///
/// `target_version` pins the exact resolved version, mirroring [`install_argv`]:
/// both executors ask the package manager for the same string the app resolved.
pub fn pnpm_install_argv(
    target_version: Option<&str>,
    global_bin_dir: Option<&str>,
) -> Vec<String> {
    let mut argv = vec!["add".to_string(), "-g".to_string()];
    if let Some(dir) = global_bin_dir.filter(|dir| !dir.is_empty()) {
        argv.push(format!("--config.global-bin-dir={dir}"));
    }
    argv.push(hq_cli_package_spec(target_version));
    argv
}

/// argv for updating a Bun-managed global install, pinned to the exact version
/// the desktop app resolved from the registry.
pub fn bun_install_argv(target_version: Option<&str>) -> Vec<String> {
    vec![
        "add".to_string(),
        "-g".to_string(),
        hq_cli_package_spec(target_version),
    ]
}

/// pnpm's global home for a resolved pnpm shim.
///
/// The shims sit either directly in the home (`<pnpm-home>\hq.cmd`) or, since
/// pnpm 11, one level down (`<pnpm-home>\bin\hq.cmd`). Mirrors the two layouts
/// [`is_pnpm_global_shim`] recognizes so the manifest lookup and the installer
/// branch cannot disagree about where the install lives.
fn pnpm_home_from_hq_bin(hq_bin: &Path) -> Option<std::path::PathBuf> {
    let parent = hq_bin.parent().filter(|p| !p.as_os_str().is_empty())?;
    if parent.file_name().and_then(|name| name.to_str()) == Some("bin") {
        if let Some(grandparent) = parent.parent() {
            if grandparent.file_name().and_then(|name| name.to_str()) == Some("pnpm")
                || grandparent.join("global").is_dir()
            {
                return Some(grandparent.to_path_buf());
            }
        }
    }
    Some(parent.to_path_buf())
}

/// A pnpm global-store generation directory name parsed to a comparable number
/// so the newest store sorts first. pnpm <=10 names the store by a bare integer
/// (`5`); pnpm >=11 names it `v<n>` (`v11`). The base defect parsed `v11` with a
/// plain `u64::parse`, scoring it 0 and sorting it BEHIND any leftover pre-11
/// numeric store on a migrated machine, which entrenched a stale reading. Both
/// forms parse here; anything else scores 0 and sorts last.
fn pnpm_store_generation(name: &str) -> u64 {
    name.strip_prefix('v').unwrap_or(name).parse::<u64>().unwrap_or(0)
}

/// Closed telemetry token for the pnpm global-store layout family observed while
/// reading delivery evidence. Never a path — only the shape. Lets a residual
/// event name whether it saw the pnpm >=11 `v<n>` store, a pre-11 numeric store,
/// or nothing recognisable, without leaking any filesystem location.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PnpmStoreFamily {
    /// pnpm >=11: `<home>/global/v<n>/<opaque-hash>/node_modules`.
    V11,
    /// pnpm <=10: `<home>/global/<n>/node_modules`.
    Numeric,
    /// No store directory was found, or its name matched neither shape.
    Unknown,
}

impl PnpmStoreFamily {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::V11 => "v11",
            Self::Numeric => "numeric",
            Self::Unknown => "unknown",
        }
    }
}

/// Classify a pnpm global-store generation directory name (or the trailing
/// component of a `pnpm root -g` path) into its layout family. `v11` is the
/// pnpm >=11 shape; a bare integer is the pre-11 shape.
pub fn pnpm_store_family(name: &str) -> PnpmStoreFamily {
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match name.strip_prefix('v') {
        Some(rest) if all_digits(rest) => PnpmStoreFamily::V11,
        _ if all_digits(name) => PnpmStoreFamily::Numeric,
        _ => PnpmStoreFamily::Unknown,
    }
}

/// package.json candidates inside pnpm's global store.
///
/// pnpm keeps globals under `<pnpm-home>/global/<store-generation>/…`. The
/// generation directory changes with pnpm's store format, so the generations
/// present are enumerated (newest first) rather than guessed:
///   - pnpm <=10: `<home>/global/<n>/node_modules/@indigoai-us/hq-cli`
///   - pnpm >=11: `<home>/global/v<n>/<opaque-hash>/node_modules/@indigoai-us/hq-cli`
///
/// Both shapes are emitted for every generation. The pnpm 11 opaque-hash
/// directory changes on every install, so it is discovered by a bounded
/// single-level `read_dir` of the generation directory rather than cached; a
/// missing `global/` simply yields nothing.
fn pnpm_store_package_json_candidates(pnpm_home: &Path) -> Vec<std::path::PathBuf> {
    let global = pnpm_home.join("global");
    let suffix = Path::new("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");

    let mut stores: Vec<std::path::PathBuf> = std::fs::read_dir(&global)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    // Newest store generation first (parsing `v11` as 11 so it outranks a stale
    // `5`), then by name for a deterministic order regardless of how the
    // filesystem enumerated the directory.
    stores.sort_by_key(|path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        (std::cmp::Reverse(pnpm_store_generation(&name)), name)
    });

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for store in &stores {
        // pnpm <=10: the package sits directly under the generation's node_modules.
        candidates.push(store.join(&suffix));
        // pnpm >=11: one opaque-hash directory per install lives under the
        // generation, with the package beneath it. Enumerated fresh every call
        // because the hash changes on each install.
        if let Ok(entries) = std::fs::read_dir(store) {
            for entry in entries.flatten() {
                let child = entry.path();
                if child.is_dir() {
                    candidates.push(child.join(&suffix));
                }
            }
        }
    }
    // Some setups keep the store flat directly under `global/`.
    candidates.push(global.join(&suffix));
    candidates
}

/// The installed hq-cli version located from the path `pnpm root -g` reports,
/// accepting BOTH global-store shapes so a pnpm major bump cannot blind the read:
/// pnpm <=10 prints `<home>/global/<n>/node_modules` (the package sits directly
/// beneath), while pnpm >=11 prints `<home>/global/v<n>` with the package one
/// opaque-hash directory further down. A bounded single-level scan of the
/// reported root covers the pnpm 11 shape; the direct and `node_modules`-suffixed
/// joins cover the others. Returns `None` when no manifest is readable — absence
/// of evidence fails safe toward retrying, never toward a durable block.
pub fn hq_cli_version_under_pnpm_root(root: &Path) -> Option<String> {
    let pkg = Path::new("@indigoai-us").join("hq-cli").join("package.json");
    let nm_pkg = Path::new("node_modules").join(&pkg);
    let mut candidates: Vec<std::path::PathBuf> = vec![root.join(&pkg), root.join(&nm_pkg)];
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                candidates.push(child.join(&nm_pkg));
            }
        }
    }
    max_hq_cli_version(candidates)
}

/// The HIGHEST hq-cli version among a set of candidate manifest paths, read with
/// no subprocess. pnpm's `global/v<n>` can hold more than one opaque-hash
/// directory (a prior install pnpm has not pruned), and their filesystem
/// enumeration order is meaningless — so choosing the first readable manifest
/// could nondeterministically return a stale version. Choosing the newest is
/// deterministic AND correct: pnpm rewrites the shim to point at its newest
/// global install, so the highest version present is exactly the one the shim
/// executes, and for delivery evidence it answers "did pnpm deliver `latest`"
/// regardless of stale leftovers.
fn max_hq_cli_version<I>(candidates: I) -> Option<String>
where
    I: IntoIterator<Item = std::path::PathBuf>,
{
    candidates
        .into_iter()
        .filter_map(|candidate| read_hq_cli_package_version(&candidate).ok().flatten())
        .max_by(|a, b| cmp_semver(a, b))
}

/// Parse the installed `@indigoai-us/hq-cli` version out of `pnpm ls -g --depth 0
/// --json` output. pnpm answers with an array of one project object carrying a
/// `dependencies` map (pnpm 10 and 11 share this shape); a few setups emit a bare
/// object instead of a one-element array, so both are accepted. This is the
/// authoritative delivery reader: it takes pnpm's OWN answer for where the global
/// package lives rather than guessing a store layout. Returns `None` for empty,
/// malformed, or unexpected JSON — a parse miss is "no evidence", which fails safe
/// toward retrying and never blocks.
pub fn pnpm_global_ls_hq_cli_version(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let projects: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        object @ serde_json::Value::Object(_) => vec![object],
        _ => return None,
    };
    for project in projects {
        for section in ["dependencies", "devDependencies", "optionalDependencies"] {
            if let Some(version) = project
                .get(section)
                .and_then(|deps| deps.get("@indigoai-us/hq-cli"))
                .and_then(|entry| entry.get("version"))
                .and_then(|version| version.as_str())
                .filter(|version| !version.is_empty())
            {
                return Some(version.to_string());
            }
        }
    }
    None
}

fn hq_cli_package_json_candidates(prefix: &Path, hq_bin: &Path) -> Vec<std::path::PathBuf> {
    let is_windows_npm_shim = hq_bin
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    let windows = prefix
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let unix = prefix
        .join("lib")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let mut candidates = if is_windows_npm_shim {
        vec![windows, unix]
    } else {
        vec![unix, windows]
    };
    // A pnpm-managed install keeps its manifest in pnpm's own store, which
    // neither npm layout above can reach. Appended (never reordered) so npm
    // installs keep their exact existing candidate order.
    if is_pnpm_global_shim(&hq_bin.to_string_lossy()) {
        if let Some(pnpm_home) = pnpm_home_from_hq_bin(hq_bin) {
            candidates.extend(pnpm_store_package_json_candidates(&pnpm_home));
        }
    }
    candidates
}

/// The hq-cli version the installer actually wrote into `prefix`, read straight
/// from the package.json manifest with no subprocess. This is the delivery
/// evidence that separates a genuine shadowing defect (the installer DID deliver
/// the target into the prefix, but a copy earlier on PATH still wins) from a
/// transient resolution shortfall (the installer never delivered the target at
/// all). Reuses the same candidate enumeration detection uses, so it covers the
/// unix, Windows, and pnpm-store layouts in a fixed order. Returns `None` when
/// no manifest is readable — absence of delivery evidence must fail safe toward
/// retrying, never toward a durable block.
pub fn installed_hq_cli_version_in_prefix(prefix: &str, hq_bin: &str) -> Option<String> {
    let hq_path = Path::new(hq_bin);
    hq_cli_package_json_candidates(Path::new(prefix), hq_path)
        .into_iter()
        .find_map(|candidate| read_hq_cli_package_version(&candidate).ok().flatten())
}

fn remove_file_if_present(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        // Absent is success: the repair is idempotent and re-heals a re-created
        // stray on the next run.
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

fn remove_dir_all_if_present(path: &Path) -> bool {
    match std::fs::remove_dir_all(path) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Whether a shim file is HQ's OWN generated shim for `@indigoai-us/hq-cli`
/// rather than an unrelated command a user happens to have placed under the same
/// name. npm's generated shims (the unix wrapper plus the `.cmd`/`.ps1`/`.bat`
/// forms) all name the package's own path, e.g. `node_modules\@indigoai-us\hq-cli\…`,
/// so a content check for that scoped name is a reliable ownership signal. A
/// missing or unreadable file is treated as "not ours" and is left untouched.
fn shim_belongs_to_hq_cli(path: &Path, prefix: &Path) -> bool {
    // A SYMLINK is HQ's own ONLY when its canonical target resolves inside the
    // derived prefix's @indigoai-us/hq-cli package. The shim's CONTENT is never
    // trusted for a symlink: `std::fs::read` FOLLOWS the link, so an unrelated
    // wrapper whose target script merely names the package would otherwise be
    // accepted and unlinked — the exact case the containment rule must refuse.
    if std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return shim_symlink_targets_hq_cli_package(path, prefix);
    }
    // A regular file (npm's generated `.cmd`/`.ps1`/`.bat` wrappers and the unix
    // shell wrapper) names the scoped package in its OWN bytes, so a content check
    // for that scoped name is a reliable ownership signal.
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            text.contains("@indigoai-us") && text.contains("hq-cli")
        }
        Err(_) => false,
    }
}

/// Whether `path` is a symlink whose canonicalized target lies inside the derived
/// prefix's `@indigoai-us/hq-cli` package directory (the unix `lib/node_modules`
/// or the flat `node_modules` layout). Both the shim and each candidate package
/// root are canonicalized, so a `..`-relative link or a symlinked prefix cannot
/// defeat the containment test. A non-symlink, a broken link, or a target outside
/// the package is not ours.
fn shim_symlink_targets_hq_cli_package(path: &Path, prefix: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {}
        _ => return false,
    }
    let Ok(target) = std::fs::canonicalize(path) else {
        return false;
    };
    for pkg_root in [
        prefix
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli"),
        prefix
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli"),
    ] {
        if let Ok(canon_pkg) = std::fs::canonicalize(&pkg_root) {
            if paths::path_is_within(&target, &canon_pkg) {
                return true;
            }
        }
    }
    false
}

/// Remove an HQ-managed SHADOW copy of the CLI so the copy in the managed npm
/// prefix wins resolution. Filesystem-only and strictly enumerated: it deletes
/// ONLY [`HQ_CLI_BIN_NAMES`] shims (each name plus its `.cmd`/`.ps1`/`.bat` forms)
/// **whose own content proves they are HQ's** in the shim's own directory, and
/// the scoped package directory `<dir>/node_modules/@indigoai-us/hq-cli` (plus the
/// `<dir>/lib/node_modules/...` form on unix). `node.exe`, `npm`, `npx`, `git`,
/// `rsync`, and every unrelated global package or user-placed command are never
/// touched.
///
/// Gates before any unlink; if any refuses, nothing is removed and the outcome is
/// [`ManagedShadowRepairAction::ProvenanceRefused`]:
///   1. the shim's directory is DISJOINT from `managed_prefix` — never delete the
///      copy the install just wrote;
///   2. the managed prefix already holds `>= latest` — the good copy is proven in
///      place, so removing the shadow cannot strand the user;
///   3. the shadow directory holds an `@indigoai-us/hq-cli` manifest AND the
///      resolved shadow shim's own content names that package — provenance, so an
///      unrelated command that merely happens to be named `hq` (or an old package
///      dir beside a user-replaced command) is never removed.
///
/// Ordering matters for safety: shims are removed first, and the package is
/// removed ONLY if every targeted shim came out cleanly. If any shim removal
/// fails (a Windows sharing violation while an `hq` process holds the file), the
/// package is left in place and [`ManagedShadowRepairAction::RemovalFailed`] is
/// returned — a surviving shim must never be left pointing at a deleted package,
/// which would brick a previously-runnable CLI. Every removal failure is
/// non-fatal so the caller degrades to the bounded capture rather than erroring.
pub fn repair_managed_shadow(
    shadow_shim: &Path,
    managed_prefix: &Path,
    latest: &str,
) -> ManagedShadowRepairAction {
    // The shim's OWN directory holds the shims to enumerate and remove:
    // `<prefix>/bin` on unix, `<prefix>` on Windows.
    let Some(shadow_dir) = shadow_shim
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return ManagedShadowRepairAction::ProvenanceRefused;
    };

    // Derive the shadow's npm PREFIX from the shim, layout-aware: `<prefix>/bin/hq`
    // -> `<prefix>` on unix, `<prefix>\hq.cmd` -> `<prefix>` on Windows (where it
    // equals the shim's own directory, so behaviour there is unchanged). A shim we
    // cannot map to a prefix — a bare name, or a parent that is not a recognised
    // npm bin dir — is refused: HQ will not guess a prefix to delete a package
    // from.
    let Some(shadow_prefix) = npm_prefix_from_hq_bin(&shadow_shim.to_string_lossy()) else {
        return ManagedShadowRepairAction::ProvenanceRefused;
    };
    let shadow_prefix = Path::new(&shadow_prefix);

    // Gate 1: the shadow's PREFIX must be disjoint from the prefix the install
    // just wrote into. Compared by components (case-insensitive on Windows).
    if paths::path_is_within(shadow_prefix, managed_prefix)
        || paths::path_is_within(managed_prefix, shadow_prefix)
    {
        return ManagedShadowRepairAction::ProvenanceRefused;
    }

    // Gate 2: the managed prefix must already hold >= latest.
    let prefix_has_latest = installed_hq_cli_version_in_prefix(
        &managed_prefix.to_string_lossy(),
        &shadow_shim.to_string_lossy(),
    )
    .is_some_and(|delivered| cmp_semver(&delivered, latest) != std::cmp::Ordering::Less);
    if !prefix_has_latest {
        return ManagedShadowRepairAction::ProvenanceRefused;
    }

    // Gate 3: the shadow's PREFIX holds an @indigoai-us/hq-cli manifest AND the
    // shim the app actually resolves is provably HQ's own — its content names the
    // package, OR it is a symlink into that prefix's own hq-cli package dir. Both
    // together prove we are removing HQ's shadow, not deleting a package a user's
    // replacement command depends on.
    let shadow_has_manifest = installed_hq_cli_version_in_prefix(
        &shadow_prefix.to_string_lossy(),
        &shadow_shim.to_string_lossy(),
    )
    .is_some();
    if !shadow_has_manifest || !shim_belongs_to_hq_cli(shadow_shim, shadow_prefix) {
        return ManagedShadowRepairAction::ProvenanceRefused;
    }

    // Remove the enumerated shims first — but ONLY files that are provably HQ's own
    // shims for this package. A user's replacement of a command name (unlikely
    // inside HQ's managed directory, but never assumed) is left untouched.
    let mut shims_ok = true;
    for name in HQ_CLI_BIN_NAMES {
        let mut candidates = vec![shadow_dir.join(name)];
        for ext in ["cmd", "ps1", "bat"] {
            candidates.push(shadow_dir.join(format!("{name}.{ext}")));
        }
        for path in candidates {
            match std::fs::symlink_metadata(&path) {
                // Absent is fine — the repair is idempotent.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                // Could not even stat it: fail safe.
                Err(_) => shims_ok = false,
                Ok(_) => {
                    if shim_belongs_to_hq_cli(&path, shadow_prefix) && !remove_file_if_present(&path)
                    {
                        shims_ok = false;
                    }
                }
            }
        }
    }

    // Never delete the package while a shim removal failed: a surviving shim
    // pointing at a removed package would brick a previously-runnable CLI. Leave
    // everything and report failure — the CLI stays runnable (stale) and the next
    // check retries.
    if !shims_ok {
        return ManagedShadowRepairAction::RemovalFailed;
    }

    // Every targeted shim is gone, so the package is now unreachable through them.
    // It is removed from the DERIVED prefix (`<prefix>/lib/node_modules` on unix,
    // `<prefix>/node_modules` on the flat layout), never the shim's own directory.
    let mut pkg_ok = true;
    pkg_ok &= remove_dir_all_if_present(
        &shadow_prefix
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli"),
    );
    pkg_ok &= remove_dir_all_if_present(
        &shadow_prefix
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli"),
    );

    if pkg_ok {
        ManagedShadowRepairAction::Removed
    } else {
        ManagedShadowRepairAction::RemovalFailed
    }
}

/// The hq-cli version pnpm delivered into its OWN global store, read straight
/// from the store manifest with no subprocess.
///
/// Unlike [`installed_hq_cli_version_in_prefix`], this consults ONLY the pnpm
/// store candidates (`<pnpm-home>/global/<n>/node_modules/@indigoai-us/hq-cli`).
/// The shared reader enumerates npm-style candidates (`<prefix>/lib/node_modules`,
/// `<prefix>/node_modules`) BEFORE the pnpm store and stops at the first readable
/// manifest, so a stray npm-style manifest that happens to sit under the pnpm home
/// (e.g. a manual `npm install --prefix <pnpm-home>`) would shadow the store
/// reading and misreport delivery — turning a genuine pnpm delivery into an
/// apparent shortfall. The pnpm executor therefore reads its delivery evidence
/// from the store directly. Returns `None` when no store manifest is readable,
/// which fails safe toward retrying rather than a durable block.
pub fn installed_hq_cli_version_in_pnpm_store(pnpm_home: &str) -> Option<String> {
    // Newest-wins across any lingering opaque-hash dirs so a stale leftover cannot
    // shadow the active install or misreport delivery — see `max_hq_cli_version`.
    max_hq_cli_version(pnpm_store_package_json_candidates(Path::new(pnpm_home)))
}

/// The hq-cli version Bun delivered into its global package tree.
pub fn installed_hq_cli_version_in_bun_global(bun_home: &Path) -> Option<String> {
    let package_json = bun_home
        .join("install")
        .join("global")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    read_hq_cli_package_version(&package_json).ok().flatten()
}

/// Identify the package manager that owns a resolved HQ CLI binary.
///
/// Package provenance is mandatory: a different executable named `hq` (most
/// notably Homebrew's unrelated HTML-query formula) must never be overwritten
/// by an npm global install. A valid hq-cli installed under Homebrew's npm
/// prefix still passes because its canonical package manifest has the expected
/// scoped package name.
pub fn install_executor_for_hq_bin(hq_bin: &Path) -> Option<InstallExecutor> {
    version_from_hq_binary(hq_bin)?;
    let hq_bin = hq_bin.to_string_lossy();
    if is_pnpm_global_shim(&hq_bin) {
        Some(InstallExecutor::Pnpm)
    } else if is_bun_global_shim(&hq_bin) {
        Some(InstallExecutor::Bun)
    } else {
        Some(InstallExecutor::Npm)
    }
}

/// Which manager should install `latest` when [`install_executor_for_hq_bin`]
/// could not identify an existing install, i.e. no readable
/// `@indigoai-us/hq-cli` package was found at the resolved `hq`.
///
/// Exactly ONE situation qualifies: **nothing resolved at all**
/// (`ResolvedProgramKind::NotResolved`). No file exists, so there is nothing to
/// overwrite and no ambiguity about ownership — this is a first install, and npm
/// is the manager the app can provision a runtime for.
///
/// Everything else returns `None` (refuse), preserving today's behaviour.
///
/// It is tempting to also treat a resolved-but-unidentifiable `hq` under a pnpm
/// or Bun global root as "our own broken install" and reinstall it there. That
/// is wrong: a path inside `$PNPM_HOME` proves only that **pnpm** owns the
/// binary, not that **we** do. Any unrelated package exposing an `hq` bin,
/// installed with `pnpm add -g`, lands at exactly that path — so a path-shape
/// test would let auto-update (on by default) run `pnpm add -g @indigoai-us/hq-cli`
/// over a command that is not ours, which is precisely what the caller's
/// unrelated-command guard exists to prevent. Repairing a broken install needs
/// package-specific ownership evidence, which this does not have; until it does,
/// an unidentifiable binary is left alone.
pub fn install_executor_for_first_install(
    resolved: ResolvedProgramKind,
) -> Option<InstallExecutor> {
    (resolved == ResolvedProgramKind::NotResolved).then_some(InstallExecutor::Npm)
}

/// Build the argv for the global install. Factored out so the unit test
/// can lock the shape without spawning npm. When we know the prefix that
/// contains the resolved `hq`, pass it explicitly so npm updates the binary
/// the app actually runs instead of npm's unrelated default global prefix.
///
/// `target_version` pins the EXACT version the app resolved so npm installs
/// precisely what the app compared against, never re-resolving the `@latest`
/// dist-tag through its own lagging cache. `None` keeps the `@latest` fallback
/// for call sites without a resolved target.
pub fn install_argv(prefix: Option<&str>, target_version: Option<&str>) -> Vec<String> {
    let mut argv = vec!["install".to_string(), "-g".to_string()];
    if let Some(prefix) = prefix {
        argv.push("--prefix".to_string());
        argv.push(prefix.to_string());
    }
    argv.push(hq_cli_package_spec(target_version));
    argv
}

/// Read the version field from the installed package.json inside the npm
/// global prefix. We do this instead of `hq --version` because the CLI's
/// `index.ts` carries a hardcoded `.version("5.5.0")`-style string that
/// has not been kept in sync with the published npm version (same gotcha
/// documented in `util::hq_resolver`). package.json is the canonical source.
///
/// `npm_bin` is the absolute path to the `npm` binary being queried; callers
/// pass the same beefed-up PATH used for child processes so node-backed npm
/// still starts under a Dock-launched app. This intentionally reads npm's
/// default global prefix and is only a fallback for version detection layouts
/// that cannot be resolved from the `hq` binary itself.
pub fn read_installed_version(npm_bin: &str, path: &str) -> Option<String> {
    read_installed_version_probe(npm_bin, path).0
}

fn read_installed_version_probe(
    npm_bin: &str,
    path: &str,
) -> (Option<String>, VersionProbeOutcome) {
    let mut cmd = paths::spawn_command(npm_bin, &[]);
    let out = match cmd.args(["root", "-g"]).env("PATH", path).output() {
        Ok(output) => output,
        Err(error) => return (None, classify_spawn_error(&error)),
    };
    if !out.status.success() {
        return (
            None,
            if out.status.code() == Some(127) {
                VersionProbeOutcome::InterpreterNotFound
            } else {
                VersionProbeOutcome::NonzeroExit
            },
        );
    }
    let root = match String::from_utf8(out.stdout) {
        Ok(stdout) => stdout.trim().to_string(),
        Err(_) => return (None, VersionProbeOutcome::InvalidUtf8),
    };
    if root.is_empty() {
        return (None, VersionProbeOutcome::EmptyOutput);
    }
    let pkg_json = std::path::Path::new(&root)
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let bytes = match std::fs::read(&pkg_json) {
        Ok(bytes) => bytes,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return (None, VersionProbeOutcome::PackageNotFound)
        }
        Err(_) => return (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => return (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    };
    match parsed.get("version").and_then(|v| v.as_str()) {
        Some(version) => (Some(version.to_string()), VersionProbeOutcome::Succeeded),
        None => (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn cmp_semver_compares_numerically_not_lexically() {
        // The whole point of a custom comparator — string compare would
        // say "5.10.0" < "5.2.0" because '1' < '2'.
        assert_eq!(cmp_semver("5.10.0", "5.2.0"), Ordering::Greater);
        assert_eq!(cmp_semver("5.10.10", "5.10.2"), Ordering::Greater);
    }

    #[test]
    fn cmp_semver_equal_and_less() {
        assert_eq!(cmp_semver("5.11.0", "5.11.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("5.12.1", "5.12.2"), Ordering::Less);
    }

    #[test]
    fn cmp_semver_handles_prerelease_suffix() {
        // npm `latest` is stable, but tolerate the suffix instead of
        // returning "no update" when the user is on a -beta or -rc.
        assert_eq!(cmp_semver("5.12.0-beta.1", "5.12.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0-rc.3", "5.12.0"), Ordering::Less);
    }

    /// The defect this whole change closes: the installer must ask npm for the
    /// EXACT version the app resolved, not the mutable `@latest` dist-tag that
    /// npm re-resolves through its own lagging cache. On unmodified main the
    /// function took only a prefix and always emitted `@latest`, so this fails
    /// there for the right reason.
    #[test]
    fn install_argv_pins_the_exact_resolved_version_not_the_latest_dist_tag() {
        let argv = install_argv(Some("/tmp/hq-prefix"), Some("5.97.1"));
        assert_eq!(
            argv,
            vec![
                "install".to_string(),
                "-g".to_string(),
                "--prefix".to_string(),
                "/tmp/hq-prefix".to_string(),
                "@indigoai-us/hq-cli@5.97.1".to_string(),
            ]
        );
        // Still a global install of the right package, whatever the version.
        assert_eq!(argv[0], "install");
        assert_eq!(argv[1], "-g");
        assert!(argv.last().unwrap().starts_with("@indigoai-us/hq-cli@"));
        // The pinned spec must NOT carry the mutable dist-tag.
        assert!(
            !argv.iter().any(|arg| arg.ends_with("@latest")),
            "a pinned install must not request the @latest dist-tag: {argv:?}"
        );
    }

    /// The `None` arm still yields `@latest` for call sites with no resolved
    /// target, so no caller silently loses its ability to install.
    #[test]
    fn package_spec_falls_back_to_the_latest_tag_only_without_a_resolved_target() {
        assert_eq!(hq_cli_package_spec(None), "@indigoai-us/hq-cli@latest");
        assert_eq!(hq_cli_package_spec(None), HQ_CLI_PACKAGE);
        assert_eq!(
            hq_cli_package_spec(Some("5.97.1")),
            "@indigoai-us/hq-cli@5.97.1"
        );
        let latest_argv = install_argv(None, None);
        assert_eq!(
            latest_argv,
            vec![
                "install".to_string(),
                "-g".to_string(),
                HQ_CLI_PACKAGE.to_string(),
            ]
        );
    }

    #[test]
    fn install_argv_includes_prefix_when_available() {
        let argv = install_argv(Some("/tmp/hq-prefix"), None);
        assert_eq!(
            argv,
            vec![
                "install".to_string(),
                "-g".to_string(),
                "--prefix".to_string(),
                "/tmp/hq-prefix".to_string(),
                HQ_CLI_PACKAGE.to_string(),
            ]
        );
        let prefix_flag = argv.iter().position(|arg| arg == "--prefix").unwrap();
        assert_eq!(
            argv.get(prefix_flag + 1),
            Some(&"/tmp/hq-prefix".to_string())
        );
    }

    #[test]
    fn npm_prefix_from_resolved_hq_bin_uses_enclosing_prefix() {
        assert_eq!(
            npm_prefix_from_hq_bin(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
            ),
            Some(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global"
                    .to_string()
            )
        );
        assert_eq!(npm_prefix_from_hq_bin("hq"), None);
    }

    /// The stuck-auto-update regression, reproduced from a prod HQ.app whose
    /// `hq` resolved to pnpm's **flat** global bin directory
    /// (`~/Library/pnpm/hq` — `user_cli_dirs`' third candidate). npm's layout
    /// is `<prefix>/bin/hq`, so walking up two levels from a flat shim dir
    /// invents `~/Library` as the prefix. npm accepted it, created
    /// `~/Library/bin` + `~/Library/lib/node_modules`, and exited 0 — while
    /// every detection path kept reading the *other* install. Result: "install
    /// succeeded" on every cycle for weeks with the detected version frozen.
    ///
    /// A parent directory literally named `bin` is the only thing that proves
    /// the grandparent is an npm prefix. Without it we must return `None` and
    /// let npm use its own configured global prefix, which is at least
    /// internally consistent.
    #[test]
    fn npm_prefix_rejects_flat_shim_dirs_that_are_not_npm_prefixes() {
        // pnpm on macOS — the exact path from the field report.
        assert_eq!(npm_prefix_from_hq_bin("/Users/test/Library/pnpm/hq"), None);
        // pnpm on Linux.
        assert_eq!(
            npm_prefix_from_hq_bin("/Users/test/.local/share/pnpm/hq"),
            None
        );
        // Any other hand-rolled wrapper directory.
        assert_eq!(npm_prefix_from_hq_bin("/Users/test/.hq/shims/hq"), None);
    }

    /// The npm layouts that *do* yield a usable prefix must keep working —
    /// this is the half of the contract the fix must not regress.
    #[test]
    fn npm_prefix_still_accepts_real_npm_bin_layouts() {
        assert_eq!(
            npm_prefix_from_hq_bin("/opt/homebrew/bin/hq"),
            Some("/opt/homebrew".to_string())
        );
        assert_eq!(
            npm_prefix_from_hq_bin("/Users/test/.npm-global/bin/hq"),
            Some("/Users/test/.npm-global".to_string())
        );
    }

    /// A pnpm-managed `hq` must route the installer to `pnpm add -g` — npm
    /// cannot replace a shim in pnpm's flat global dir (the non-convergent
    /// class this whole module guards). Detection is by layout: the default
    /// pnpm homes on every OS, plus a custom PNPM_HOME via its `global/` store.
    #[test]
    fn pnpm_global_shim_detected_by_layout() {
        // Default pnpm homes (the field case: ~/Library/pnpm/hq at v5.77.4).
        assert!(is_pnpm_global_shim("/Users/test/Library/pnpm/hq"));
        assert!(is_pnpm_global_shim("/home/test/.local/share/pnpm/hq"));
        // Backslash separators only parse as components on Windows.
        #[cfg(windows)]
        assert!(is_pnpm_global_shim(
            "C:\\Users\\test\\AppData\\Local\\pnpm\\hq"
        ));
        // pnpm ≥11: shims nest under `<pnpm-home>/bin` — a parent literally
        // named `bin`, the same shape npm prefixes use. Regression from the
        // live smoke on 2026-08-05: pnpm 11.0.9 wrote ~/Library/pnpm/bin/hq
        // and the flat-dir checks above all missed it.
        assert!(is_pnpm_global_shim("/Users/test/Library/pnpm/bin/hq"));
        assert!(is_pnpm_global_shim("/home/test/.local/share/pnpm/bin/hq"));
        // Custom PNPM_HOME with the v11 nesting: global/ store marks the home.
        let tmp_v11 = tempfile::TempDir::new().unwrap();
        let home_v11 = tmp_v11.path().join("my-tools");
        std::fs::create_dir_all(home_v11.join("global")).unwrap();
        std::fs::create_dir_all(home_v11.join("bin")).unwrap();
        let shim_v11 = home_v11.join("bin").join("hq");
        std::fs::write(&shim_v11, "#!/bin/sh\n").unwrap();
        assert!(is_pnpm_global_shim(shim_v11.to_str().unwrap()));
        // Custom PNPM_HOME: shims beside a `global/` store dir.
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("my-tools");
        std::fs::create_dir_all(home.join("global")).unwrap();
        let shim = home.join("hq");
        std::fs::write(&shim, "#!/bin/sh\n").unwrap();
        assert!(is_pnpm_global_shim(shim.to_str().unwrap()));
    }

    #[test]
    fn pnpm_global_shim_false_for_npm_layouts_and_missing_hq() {
        assert!(!is_pnpm_global_shim("hq"));
        assert!(!is_pnpm_global_shim("/opt/homebrew/bin/hq"));
        assert!(!is_pnpm_global_shim("/Users/test/.npm-global/bin/hq"));
        assert!(!is_pnpm_global_shim(
            "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
        ));
    }

    /// The misroute that #353 closed, stated as an invariant rather than a
    /// history lesson: for every pnpm layout, `npm_prefix_from_hq_bin` would
    /// have handed npm a prefix inside pnpm's own home, so `is_pnpm_global_shim`
    /// is the only thing standing between a pnpm ≥11 user and era 1 all over
    /// again. If detection ever regresses, this fails loudly.
    #[test]
    fn nested_pnpm_shim_must_route_to_pnpm_not_to_an_npm_prefix_inside_the_pnpm_home() {
        for hq_bin in [
            "/Users/test/Library/pnpm/bin/hq",
            "/home/test/.local/share/pnpm/bin/hq",
        ] {
            assert!(
                is_pnpm_global_shim(hq_bin),
                "{hq_bin} must route to the pnpm executor"
            );
            // The npm branch would have aimed npm at `<pnpm-home>`, writing
            // `<pnpm-home>/{bin,lib}` and never moving the shim.
            assert!(
                npm_prefix_from_hq_bin(hq_bin).is_some(),
                "{hq_bin} reads as an npm prefix — detection is load-bearing"
            );
            // And the pnpm executor targets the directory the shim is in.
            let env = pnpm_global_env(hq_bin).expect("derivable pnpm env");
            assert_eq!(
                env.global_bin_dir,
                Path::new(hq_bin).parent().unwrap().to_string_lossy()
            );
        }
    }

    /// The pnpm home must come from the resolved shim, never from a guessed
    /// default: aiming `pnpm add -g` at a directory the user does not use would
    /// trade a silent non-convergence for a stray global install.
    #[test]
    fn pnpm_global_env_is_derived_from_the_resolved_shim_layout() {
        let flat = pnpm_global_env("/Users/test/Library/pnpm/hq").expect("flat layout");
        assert_eq!(flat.home, "/Users/test/Library/pnpm");
        assert_eq!(flat.global_bin_dir, "/Users/test/Library/pnpm");
        assert_eq!(flat.source, PnpmHomeSource::FlatPnpmDir);

        let nested = pnpm_global_env("/Users/test/Library/pnpm/bin/hq").expect("nested layout");
        assert_eq!(nested.home, "/Users/test/Library/pnpm");
        assert_eq!(nested.global_bin_dir, "/Users/test/Library/pnpm/bin");
        assert_eq!(nested.source, PnpmHomeSource::NestedBinDir);

        let linux = pnpm_global_env("/home/test/.local/share/pnpm/bin/hq").expect("linux nested");
        assert_eq!(linux.home, "/home/test/.local/share/pnpm");
        assert_eq!(linux.global_bin_dir, "/home/test/.local/share/pnpm/bin");

        // Custom PNPM_HOME, flat: identified by the `global/` store beside the
        // shims rather than by directory name.
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("my-tools");
        std::fs::create_dir_all(home.join("global")).unwrap();
        let shim = home.join("hq");
        std::fs::write(&shim, "#!/bin/sh\n").unwrap();
        let custom = pnpm_global_env(shim.to_str().unwrap()).expect("custom flat home");
        assert_eq!(custom.home, home.to_string_lossy());
        assert_eq!(custom.source, PnpmHomeSource::GlobalStore);

        // Custom PNPM_HOME with the v11 nesting.
        let tmp_v11 = tempfile::TempDir::new().unwrap();
        let home_v11 = tmp_v11.path().join("my-tools");
        std::fs::create_dir_all(home_v11.join("global")).unwrap();
        std::fs::create_dir_all(home_v11.join("bin")).unwrap();
        let shim_v11 = home_v11.join("bin").join("hq");
        std::fs::write(&shim_v11, "#!/bin/sh\n").unwrap();
        let custom_v11 = pnpm_global_env(shim_v11.to_str().unwrap()).expect("custom nested home");
        assert_eq!(custom_v11.home, home_v11.to_string_lossy());
        assert_eq!(
            custom_v11.global_bin_dir,
            home_v11.join("bin").to_string_lossy()
        );
        assert_eq!(custom_v11.source, PnpmHomeSource::GlobalStore);
    }

    /// When the home cannot be derived with confidence we must invent nothing —
    /// the child is spawned exactly as before, which is the conservative rule
    /// `npm_prefix_from_hq_bin` already applies for flat shim dirs.
    #[test]
    fn pnpm_global_env_is_none_when_the_layout_does_not_prove_a_home() {
        for hq_bin in [
            "hq",
            "",
            "/opt/homebrew/bin/hq",
            "/Users/test/.npm-global/bin/hq",
            "/Users/test/.asdf/shims/hq",
            "/usr/local/bin/hq",
        ] {
            assert_eq!(
                pnpm_global_env(hq_bin),
                None,
                "{hq_bin} must not yield an invented pnpm home"
            );
        }
    }

    #[test]
    fn pnpm_child_path_prepends_the_shim_dir_only_when_it_is_missing() {
        let sep = PATH_LIST_SEPARATOR;
        let base = format!("/usr/local/bin{sep}/usr/bin");
        // The era-2 candidate cause: `<pnpm-home>/bin` is absent from
        // `child_path()`, so the child pnpm resolves a different global dir.
        assert_eq!(
            pnpm_child_path(&base, Some("/Users/t/Library/pnpm/bin")),
            format!("/Users/t/Library/pnpm/bin{sep}{base}")
        );
        // Already present: no duplicate entry, no reordering.
        let with_dir = format!("/Users/t/Library/pnpm{sep}{base}");
        assert_eq!(
            pnpm_child_path(&with_dir, Some("/Users/t/Library/pnpm")),
            with_dir
        );
        // Underivable home: hand the child exactly what it had before.
        assert_eq!(pnpm_child_path(&base, None), base);
        assert_eq!(pnpm_child_path(&base, Some("")), base);
        assert!(path_contains_dir(&with_dir, "/Users/t/Library/pnpm"));
        assert!(!path_contains_dir(&base, "/Users/t/Library/pnpm"));
        assert!(!path_contains_dir(&base, ""));
    }

    /// Era 2 of HQ-DESKTOP-46, updated for the delivery/direction-gated contract
    /// (NOT weakened). Genuine pnpm shadowing — pnpm's effective global bin dir IS
    /// the dir holding the executed shim (`global_bin_dir_matches_shim_dir =
    /// Some(true)`) AND the target WAS delivered into the store — stays as loud as
    /// an npm-targeted non-convergence and keeps its durable block, on every
    /// occurrence, and it must say "pnpm", not borrow npm's wording.
    #[test]
    fn targeted_pnpm_non_convergence_is_its_own_loud_class() {
        let hq_bin = "/Users/t/Library/pnpm/bin/hq";
        let pnpm = PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: false,
            path_has_shim_dir: true,
            // A native-resolution diagnostic only; on a nested layout it would
            // legitimately be Some(false), and it no longer gates any class.
            global_bin_dir_matches_shim_dir: Some(true),
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: true,
            exit_status: "0".to_string(),
            output_len: 42,
        };
        // `already_blocked = true`: a targeted defect stays loud across
        // episodes exactly like `NpmTargeted`.
        let outcome = decide_post_install(&PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.93.0"),
            latest: "5.94.1",
            npm_prefix_passed: None,
            // Delivery evidence now gates the pnpm arm too: the target reached the
            // store, yet the executed shim is still stale — genuine shadowing.
            delivered_version: Some("5.94.1"),
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: true,
            nonblocking_episode_keys: &[],
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
            pnpm: Some(pnpm.clone()),
        });
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::PnpmTargeted)
        );
        assert!(!outcome.capture_requires_durable_record);
        let report = outcome.capture.as_ref().expect("targeted runs stay loud");
        assert_eq!(report.executor, InstallExecutor::Pnpm);
        assert_eq!(report.installer_bin, "/opt/homebrew/bin/pnpm");
        assert_eq!(report.npm_prefix, None, "pnpm passes no npm prefix");
        assert_eq!(report.pnpm.as_ref(), Some(&pnpm));
        assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.94.1"));
        assert!(outcome.log_line.starts_with("pnpm completed,"));
    }

    /// The live Kurts recurrence: a pnpm run HQ could not aim at the executed
    /// copy (underivable home, or a child PATH that never contained the shim
    /// dir). It is `InstallerUnaimed` — observable but NON-BLOCKING: no durable
    /// marker, capture NOT gated on a marker write, and bounded to one capture
    /// per episode. On the base commit this was `ForeignManaged`, which wrote the
    /// pinned marker and wedged auto-update on every publish.
    #[test]
    fn an_unaimed_pnpm_run_is_non_blocking_and_writes_no_marker() {
        // The exact Kurts field values plus the NestedBinDir/unaimed variant.
        for (hq_bin, home_source) in [
            ("/opt/homebrew/bin/hq", PnpmHomeSource::Undetermined),
            ("/Users/t/Library/pnpm/bin/hq", PnpmHomeSource::NestedBinDir),
        ] {
            let ctx = PostInstallContext {
                executor: InstallExecutor::Pnpm,
                before_bin: hq_bin,
                after_bin: hq_bin,
                before_version: None,
                after_version: Some("5.95.0"),
                latest: "5.103.18",
                npm_prefix_passed: None,
                delivered_version: None,
                installer_bin: "/opt/homebrew/bin/pnpm",
                already_blocked: false,
                nonblocking_episode_keys: &[],
                managed_roots: &[],
                managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
                pnpm: Some(PnpmRunDiagnostics {
                    home_source,
                    home_env_present: false,
                    path_has_shim_dir: false,
                    global_bin_dir_matches_shim_dir: None,
                    store_family: PnpmStoreFamily::Unknown,
                    authoritative_query_ok: false,
                    exit_status: "0".to_string(),
                    output_len: 0,
                }),
            };
            let outcome = decide_post_install(&ctx);
            assert_eq!(
                outcome.non_convergence_kind,
                Some(NonConvergenceKind::InstallerUnaimed),
                "home_source={home_source:?}"
            );
            assert_eq!(
                outcome.record_non_convergent, None,
                "an unaimed run must write no durable marker"
            );
            assert!(!outcome.capture_requires_durable_record);
            assert!(outcome.capture.is_some(), "it stays observable once");
            let key = non_convergent_episode_key(
                "5.103.18",
                InstallExecutor::Pnpm,
                NonConvergenceKind::InstallerUnaimed,
                Some(home_source),
            );
            assert_eq!(
                outcome.record_nonblocking_episode.as_deref(),
                Some(key.as_str()),
                "the first episode must return its non-blocking key to persist"
            );

            // A repeat with that key already present is suppressed — one capture
            // per episode, so Sentry volume cannot grow.
            let seen = [key];
            let repeat = decide_post_install(&PostInstallContext {
                nonblocking_episode_keys: &seen,
                ..ctx
            });
            assert!(repeat.capture.is_none(), "a repeat episode is suppressed");
            assert_eq!(repeat.record_nonblocking_episode, None);
        }
    }

    /// The live Zekes recurrence: npm delivered `latest` into HQ's managed
    /// prefix, but the app still resolves an npx-cache copy npm can never move.
    /// It is `InstallerUnaimed` — non-blocking, no durable marker, one capture
    /// per episode. On the base commit `npm_prefix_from_hq_bin` returns `None`
    /// for a `.bin` parent, so it fell through to `foreign-managed` and wedged.
    #[test]
    fn the_observed_macos_npx_cache_shape_is_non_blocking_and_writes_no_marker() {
        let npx_hq = "/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq";
        let managed_prefix = "/Users/z/Library/Application Support/Indigo HQ/toolchain/npm-global";
        let ctx = PostInstallContext::npm(
            npx_hq,
            npx_hq,
            Some("5.103.1"),
            Some("5.103.1"),
            "5.103.18",
            Some(managed_prefix),
            "/opt/homebrew/bin/npm",
            false,
            Some("5.103.18"),
        );
        let outcome = decide_post_install(&ctx);
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::InstallerUnaimed)
        );
        assert_eq!(outcome.record_non_convergent, None, "npx copy must not block");
        assert!(!outcome.capture_requires_durable_record);
        let key = non_convergent_episode_key(
            "5.103.18",
            InstallExecutor::Npm,
            NonConvergenceKind::InstallerUnaimed,
            None,
        );
        assert_eq!(
            outcome.record_nonblocking_episode.as_deref(),
            Some(key.as_str())
        );
    }

    /// The npx-cache non-convergence is bounded to one capture per episode, so
    /// the fix cannot increase Sentry volume: a second run that already sees the
    /// episode key captures nothing.
    #[test]
    fn the_new_kind_is_bounded_to_one_capture_per_episode() {
        let npx_hq = "/Users/z/.npm/_npx/abc/node_modules/.bin/hq";
        let key = non_convergent_episode_key(
            "5.103.18",
            InstallExecutor::Npm,
            NonConvergenceKind::InstallerUnaimed,
            None,
        );
        let seen = [key];
        let outcome = decide_post_install(&PostInstallContext::npm(
            npx_hq,
            npx_hq,
            Some("5.103.1"),
            Some("5.103.1"),
            "5.103.18",
            Some("/managed/npm-global"),
            "/opt/homebrew/bin/npm",
            false,
            Some("5.103.18"),
        ).with_nonblocking_episode_keys(&seen));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::InstallerUnaimed)
        );
        assert!(outcome.capture.is_none(), "a repeat episode captures nothing");
        assert_eq!(outcome.record_nonblocking_episode, None);
    }

    /// The Kevins-MacBook-Pro recurrence: a FIRST install on a machine where
    /// nothing resolves. npm exits 0 into its own ambient default prefix, `hq`
    /// still resolves to the bare `hq` sentinel (nothing HQ searches contains
    /// it), and there is no prefix to read delivery from. HQ never aimed at any
    /// copy and proved no layout defect, so this is `InstallerUnaimed` —
    /// observable but NON-BLOCKING (no durable marker). On the base commit the
    /// npm arm falls through to `ForeignManaged`, which writes the pinned marker
    /// and wedges auto-update for a copy HQ could not even name.
    #[test]
    fn an_unresolved_hq_after_an_npm_install_is_installer_unaimed_and_writes_no_marker() {
        // Classification is pure: the bare `hq` sentinel with no prefix passed is
        // installer-unaimed, not foreign-managed.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Npm, None, false, "hq", false, &[]),
            NonConvergenceKind::InstallerUnaimed,
        );
        let outcome = decide_post_install(&PostInstallContext::npm(
            "hq",
            "hq",
            None,
            None,
            "5.103.20",
            None,
            "/usr/local/bin/npm",
            false,
            None,
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::InstallerUnaimed)
        );
        assert_eq!(
            outcome.record_non_convergent, None,
            "an unaimed first install must write no durable marker"
        );
        assert!(!outcome.capture_requires_durable_record);
        assert!(outcome.capture.is_some(), "it stays observable once");
        assert_eq!(
            outcome.capture.as_ref().unwrap().hq_bin,
            "PATH",
            "the unresolved bin is reported as the closed PATH token, never a home path"
        );
    }

    /// An absolute foreign layout with a readable version is unchanged by the
    /// unaimed-sentinel arm: it still blocks and still writes the durable marker,
    /// because HQ resolved a concrete copy it could name (it simply cannot drive
    /// that layout).
    #[test]
    fn an_absolute_foreign_layout_is_unaffected_by_the_unaimed_sentinel_arm() {
        assert_eq!(
            non_convergence_kind(
                InstallExecutor::Npm,
                None,
                false,
                "/Users/t/.asdf/shims/hq",
                false,
                &[],
            ),
            NonConvergenceKind::ForeignManaged,
        );
    }

    /// The bare-sentinel override is scoped to the npm arm: a pnpm or Bun run that
    /// was aimed at the executed copy AND delivered the target keeps its targeted
    /// (blocking) classification even if the post-install shim momentarily resolves
    /// to the bare `hq` sentinel — the executor's own targeting/delivery evidence is
    /// never discarded by the npm-only sentinel exception.
    #[test]
    fn the_bare_sentinel_override_does_not_touch_targeted_pnpm_or_bun() {
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, true, "hq", true, &[]),
            NonConvergenceKind::PnpmTargeted,
        );
        assert_eq!(
            non_convergence_kind(InstallExecutor::Bun, None, true, "hq", true, &[]),
            NonConvergenceKind::BunTargeted,
        );
    }

    /// The pnpm detection/targeting collapse: `is_pnpm_global_shim(x)` is now
    /// exactly `pnpm_global_env(x).is_some()` for EVERY layout arm, so the two
    /// can never disagree again — the invariant the doc comment promised.
    #[test]
    fn pnpm_detection_and_targeting_agree_on_every_layout_arm() {
        // String-only arms (no filesystem needed).
        for hq_bin in [
            "hq",
            "",
            "/Users/t/Library/pnpm/hq",      // flat
            "/home/t/.local/share/pnpm/hq",  // flat linux
            "/Users/t/Library/pnpm/bin/hq",  // pnpm >=11 nested
            "/opt/homebrew/bin/hq",          // npm/homebrew
            "/Users/t/.npm-global/bin/hq",   // npm global
            "/Users/t/.asdf/shims/hq",       // asdf
        ] {
            assert_eq!(
                is_pnpm_global_shim(hq_bin),
                pnpm_global_env(hq_bin).is_some(),
                "detection/targeting disagree on {hq_bin}"
            );
        }
        // Filesystem arms: custom PNPM_HOME (flat + nested) and the previously
        // divergent `<dir>/bin/hq` where `<dir>/bin/global` exists but `<dir>`
        // is not a pnpm home.
        let tmp = tempfile::TempDir::new().unwrap();
        // Custom flat home with a `global/` store.
        let flat = tmp.path().join("tools");
        std::fs::create_dir_all(flat.join("global")).unwrap();
        std::fs::write(flat.join("hq"), "#!/bin/sh\n").unwrap();
        // Custom nested home with a `global/` store.
        let nested = tmp.path().join("tools-v11");
        std::fs::create_dir_all(nested.join("global")).unwrap();
        std::fs::create_dir_all(nested.join("bin")).unwrap();
        std::fs::write(nested.join("bin").join("hq"), "#!/bin/sh\n").unwrap();
        // The divergent shape: `<x>/bin/global` exists, `<x>/global` does not,
        // and `<x>` is not named `pnpm`.
        let divergent = tmp.path().join("x");
        std::fs::create_dir_all(divergent.join("bin").join("global")).unwrap();
        std::fs::write(divergent.join("bin").join("hq"), "#!/bin/sh\n").unwrap();
        for path in [
            flat.join("hq"),
            nested.join("bin").join("hq"),
            divergent.join("bin").join("hq"),
        ] {
            let p = path.to_str().unwrap();
            assert_eq!(
                is_pnpm_global_shim(p),
                pnpm_global_env(p).is_some(),
                "detection/targeting disagree on {p}"
            );
        }
    }

    /// The divergent `<dir>/bin/hq` shape (the class that used to disagree) now
    /// routes to the npm executor with the correct enclosing prefix, so npm
    /// updates the copy the app runs instead of `pnpm add -g` firing unaimed.
    #[test]
    fn the_divergent_bin_global_shape_routes_to_npm_with_the_enclosing_prefix() {
        let tmp = tempfile::TempDir::new().unwrap();
        let x = tmp.path().join("x");
        std::fs::create_dir_all(x.join("bin").join("global")).unwrap();
        let hq = x.join("bin").join("hq");
        std::fs::write(&hq, "#!/bin/sh\n").unwrap();
        let hq_str = hq.to_str().unwrap();
        // Not pnpm — so install_executor_for_hq_bin takes the npm branch.
        assert!(!is_pnpm_global_shim(hq_str));
        assert_eq!(pnpm_global_env(hq_str), None);
        // npm gets the enclosing prefix `<x>/bin`'s parent, `<x>`.
        assert_eq!(
            npm_prefix_from_hq_bin(hq_str),
            Some(x.to_string_lossy().to_string())
        );
        // The canonical Homebrew case the crate already asserts elsewhere.
        assert_eq!(
            npm_prefix_from_hq_bin("/opt/homebrew/bin/hq"),
            Some("/opt/homebrew".to_string())
        );
    }

    /// Guard against over-broadening: a genuinely foreign npm layout (no prefix
    /// to aim at) still classifies `ForeignManaged`, still blocks, and still
    /// writes the durable marker on its first episode. The unaimed/npx changes
    /// must not weaken this.
    #[test]
    fn a_genuinely_foreign_layout_still_blocks_and_still_writes_the_marker() {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.asdf/shims/hq",
            "/Users/t/.asdf/shims/hq",
            Some("5.95.0"),
            Some("5.95.0"),
            "5.103.18",
            None,
            "/opt/homebrew/bin/npm",
            false,
            None,
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ForeignManaged)
        );
        assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.103.18"));
        assert!(outcome.capture_requires_durable_record);
    }

    /// Regression (PR #512 review): a real hq-cli whose pnpm store sits beside a
    /// shim in a directory literally named `bin` (a flat custom PNPM_HOME) must
    /// stay VERSION-READABLE even though the collapsed router now drives it with
    /// npm. Version reading is decoupled from routing precisely so the provenance
    /// gate in `install_executor_for_hq_bin` does not refuse it as unidentifiable
    /// and disable its update.
    #[test]
    fn a_pnpm_store_beside_a_bin_named_shim_stays_version_readable_and_installable() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Flat custom PNPM_HOME whose last component is literally `bin`.
        let home = tmp.path().join("tools").join("bin");
        let hq = home.join("hq");
        let pkg = home
            .join("global")
            .join("5")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(&hq, "#!/bin/sh\n").unwrap();
        std::fs::write(
            pkg.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.103.18"}"#,
        )
        .unwrap();

        // The collapsed router sends this shape to npm (pnpm home not derivable
        // from the shim), consistent with the primary fix.
        assert!(!is_pnpm_global_shim(&hq.to_string_lossy()));
        // But its version is still read from the pnpm store beside the shim, so
        // the provenance gate passes and the executor is Npm — never a refusal.
        assert_eq!(version_from_hq_binary(&hq).as_deref(), Some("5.103.18"));
        assert_eq!(install_executor_for_hq_bin(&hq), Some(InstallExecutor::Npm));
    }

    /// The self-naming telemetry source: an npx-cache path reports `npx-cache`,
    /// not the `login-shell` catch-all it masqueraded as before.
    #[test]
    fn bin_resolution_source_names_an_npx_cache_path() {
        assert_eq!(
            bin_resolution_source("/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq"),
            "npx-cache"
        );
        // A non-npx absolute path is never mislabeled as npx-cache. The exact
        // source of `/opt/homebrew/bin/hq` is platform-specific (`homebrew` on
        // Unix, `unknown` on Windows where that branch is cfg'd out), so assert
        // the invariant that survives both.
        assert_ne!(bin_resolution_source("/opt/homebrew/bin/hq"), "npx-cache");
    }

    /// Every foreign-managed layout in the 31-event history classifies the same
    /// way, so a fix validated against the one observed pnpm ≥11 machine cannot
    /// silently special-case it.
    #[test]
    fn non_convergence_classification_covers_every_observed_layout() {
        for hq_bin in [
            "/Users/t/Library/pnpm/hq",
            "/Users/t/Library/pnpm/bin/hq",
            "/home/t/.local/share/pnpm/hq",
            "/Users/t/.asdf/shims/hq",
            "/Users/t/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq",
        ] {
            // npm with no prefix passed is foreign-managed for every one of
            // them: npm has nowhere safe to aim. Delivery evidence is irrelevant
            // — the prefix never matched, so it never reaches the delivery gate.
            assert_eq!(
                non_convergence_kind(InstallExecutor::Npm, None, false, hq_bin, false, &[]),
                NonConvergenceKind::ForeignManaged,
                "npm/{hq_bin}"
            );
            // pnpm aimed from the resolved shim AND the target delivered into
            // pnpm's store, yet the shim is stale: genuine shadowing. The native
            // `pnpm bin -g` direction is no longer an input — delivery evidence
            // plus the executed reading decide this class.
            assert_eq!(
                non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, true, &[]),
                NonConvergenceKind::PnpmTargeted,
                "pnpm-targeted/{hq_bin}"
            );
            // Aimed at the right home but the target was never delivered: a
            // transient resolution shortfall, exactly like the npm arm.
            assert_eq!(
                non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, false, &[]),
                NonConvergenceKind::ResolutionShortfall,
                "pnpm-shortfall/{hq_bin}"
            );
            // Not aimed at all (underivable / PATH without the shim dir): the
            // ambient-spawn unaimed shape — observable but non-blocking, never
            // the foreign-managed durable block it used to be.
            assert_eq!(
                non_convergence_kind(InstallExecutor::Pnpm, None, false, hq_bin, false, &[]),
                NonConvergenceKind::InstallerUnaimed,
                "pnpm-untargeted/{hq_bin}"
            );
        }
        // An npm prefix that matches the post-install binary's own prefix is the
        // one genuinely npm-targeted shape — but only WITH delivery evidence.
        assert_eq!(
            non_convergence_kind(
                InstallExecutor::Npm,
                Some("/Users/t/.npm-global"),
                false,
                "/Users/t/.npm-global/bin/hq",
                true,
                &[],
            ),
            NonConvergenceKind::NpmTargeted
        );
    }

    /// The exact Windows shape all 12 HQ-DESKTOP-46 events carry: npm delivered
    /// `latest` into `<root>\npm-prefix`, yet the app still resolves the stale
    /// `<root>\node\hq.cmd`. Both prefixes live in the SAME managed toolchain
    /// root, so this is a repairable managed shadow — NOT the foreign layout the
    /// base misclassifies it as. The pre-repair decision writes NO durable marker
    /// (so the next check self-heals) and its detail carries neither misleading
    /// phrase the base copy showed.
    #[test]
    fn the_observed_windows_managed_shadow_shape_classifies_managed_shadowed() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        let npm_prefix = "/opt/IndigoHQ/toolchain/npm-prefix";
        let after_bin = "/opt/IndigoHQ/toolchain/node/hq.cmd";
        // Classification is pure: the same field shape, decided directly.
        assert_eq!(
            non_convergence_kind(
                InstallExecutor::Npm,
                Some(npm_prefix),
                false,
                after_bin,
                true,
                &roots,
            ),
            NonConvergenceKind::ManagedShadowed,
        );
        let outcome = decide_post_install(
            &PostInstallContext::npm(
                after_bin,
                after_bin,
                Some("5.101.0"),
                Some("5.101.0"),
                "5.101.7",
                Some(npm_prefix),
                "/opt/IndigoHQ/toolchain/node/npm.cmd",
                false,
                Some("5.101.7"),
            )
            .with_managed_roots(&roots),
        );
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ManagedShadowed)
        );
        assert_eq!(
            outcome.record_non_convergent, None,
            "a repairable first episode must not wedge auto-update"
        );
        let detail = outcome.result.clone().unwrap_err();
        assert!(!detail.contains("managed outside npm's global prefix"));
        assert!(!detail.contains("Update it with the tool that installed it"));
        assert!(outcome.capture.is_some(), "the shadow stays observable once");
        assert_eq!(
            outcome.capture.as_ref().unwrap().managed_shadow_repair,
            ManagedShadowRepairOutcome::NotAttempted
        );
    }

    /// Narrowness: a delivered target in the managed prefix but a resolved `hq`
    /// OUTSIDE every managed root (Homebrew, `/usr/local`, a pnpm home) is not a
    /// shadow HQ can repair — it stays foreign-managed and DOES record the durable
    /// marker on its first episode, exactly as today.
    #[test]
    fn a_resolved_bin_outside_every_managed_root_stays_foreign_managed() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        for after_bin in [
            "/opt/homebrew/bin/hq",
            "/usr/local/bin/hq",
            "/Users/t/Library/pnpm/hq",
        ] {
            let outcome = decide_post_install(
                &PostInstallContext::npm(
                    after_bin,
                    after_bin,
                    Some("5.101.0"),
                    Some("5.101.0"),
                    "5.101.7",
                    Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                    "/opt/IndigoHQ/toolchain/node/npm.cmd",
                    false,
                    Some("5.101.7"),
                )
                .with_managed_roots(&roots),
            );
            assert_eq!(
                outcome.non_convergence_kind,
                Some(NonConvergenceKind::ForeignManaged),
                "{after_bin}"
            );
            assert_eq!(
                outcome.record_non_convergent.as_deref(),
                Some("5.101.7"),
                "a foreign first episode still blocks: {after_bin}"
            );
        }
    }

    /// A cross-root split — prefix under the current `IndigoHQ` root, resolved bin
    /// under the LEGACY `Indigo HQ` root — is two different roots, so it is NOT one
    /// repairable shadow and stays foreign-managed.
    #[test]
    fn a_cross_root_split_is_not_a_single_managed_shadow() {
        let roots = [
            PathBuf::from("/opt/IndigoHQ/toolchain"),
            PathBuf::from("/opt/Indigo HQ/toolchain"),
        ];
        assert_eq!(
            non_convergence_kind(
                InstallExecutor::Npm,
                Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                false,
                "/opt/Indigo HQ/toolchain/node/hq.cmd",
                true,
                &roots,
            ),
            NonConvergenceKind::ForeignManaged,
        );
    }

    /// The same same-root prefixes, but the installer did NOT deliver the target
    /// into the managed prefix: without delivery evidence this is not a proven
    /// shadow and must not be treated as one.
    #[test]
    fn the_shadow_shape_without_delivery_evidence_is_not_a_managed_shadow() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        assert_eq!(
            non_convergence_kind(
                InstallExecutor::Npm,
                Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                false,
                "/opt/IndigoHQ/toolchain/node/hq.cmd",
                false,
                &roots,
            ),
            NonConvergenceKind::ForeignManaged,
        );
    }

    fn write_hq_cli_pkg(dir: &Path, version: &str) {
        let pkg_dir = dir
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
        )
        .unwrap();
    }

    /// A realistic npm-generated shim body: it names the scoped package path, so
    /// the repair's per-shim ownership check recognizes it as HQ's own.
    const HQ_CLI_SHIM_FIXTURE: &str =
        "@ECHO off\r\n\"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*\r\n";

    fn write_hq_shim(path: &Path) {
        std::fs::write(path, HQ_CLI_SHIM_FIXTURE).unwrap();
    }

    /// The repair removes exactly the HQ_CLI_BIN_NAMES shims and the scoped
    /// package directory in the shadow dir, and leaves node.exe, npm.cmd, and an
    /// unrelated global package byte-for-byte intact — plus the fresh managed
    /// copy in the prefix.
    #[test]
    fn repair_removes_the_managed_shadow_and_spares_node_and_npm() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let node = root.join("node");
        let prefix = root.join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        write_hq_shim(&node.join("hq.cmd"));
        write_hq_shim(&node.join("hq.ps1"));
        write_hq_shim(&node.join("hq-auth-refresh.cmd"));
        write_hq_cli_pkg(&node, "5.101.0");
        write_hq_cli_pkg(&prefix, "5.101.7");
        write_hq_shim(&prefix.join("hq.cmd"));
        // Bystanders that must survive the repair untouched.
        std::fs::write(node.join("node.exe"), "node").unwrap();
        std::fs::write(node.join("npm.cmd"), "npm").unwrap();
        let unrelated = node.join("node_modules").join("left-pad");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(unrelated.join("package.json"), "{}").unwrap();

        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
        assert_eq!(action, ManagedShadowRepairAction::Removed);
        assert!(!node.join("hq.cmd").exists(), "stale shim removed");
        assert!(!node.join("hq.ps1").exists(), "stale ps1 removed");
        assert!(
            !node.join("hq-auth-refresh.cmd").exists(),
            "the second declared bin shim is removed too"
        );
        assert!(
            !node
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .exists(),
            "stale package removed"
        );
        assert!(node.join("node.exe").exists(), "node.exe survives");
        assert!(node.join("npm.cmd").exists(), "npm.cmd survives");
        assert!(
            unrelated.join("package.json").exists(),
            "an unrelated global package survives"
        );
        assert!(
            prefix.join("hq.cmd").exists(),
            "the fresh managed copy is never touched"
        );
    }

    /// Build the unix managed-toolchain layout npm ACTUALLY lays down and return
    /// `(node_prefix, node_bin, npm_global)`: `<node>/bin/hq` is a SYMLINK into
    /// `<node>/lib/node_modules/@indigoai-us/hq-cli/dist/index.js`, whose bytes
    /// name NEITHER token (matching the real package), and the fresh copy lives in
    /// `<npm_global>/lib/node_modules/...`.
    #[cfg(unix)]
    fn build_unix_managed_shadow(root: &Path, shadow_version: &str, prefix_version: &str) {
        use std::os::unix::fs::symlink;
        let node = root.join("node");
        let node_bin = node.join("bin");
        let shadow_pkg = node
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(shadow_pkg.join("dist").join("bin")).unwrap();
        std::fs::create_dir_all(&node_bin).unwrap();
        std::fs::write(
            shadow_pkg.join("package.json"),
            format!(
                r#"{{"name":"@indigoai-us/hq-cli","version":"{shadow_version}","bin":{{"hq":"dist/index.js","hq-auth-refresh":"dist/bin/hq-auth-refresh.js"}}}}"#
            ),
        )
        .unwrap();
        // A real hq-cli entrypoint names neither '@indigoai-us' nor 'hq-cli' in
        // its bytes, so the content-only ownership grep fails on a genuine shim.
        std::fs::write(
            shadow_pkg.join("dist").join("index.js"),
            "#!/usr/bin/env node\nrequire('./cli.js');\n",
        )
        .unwrap();
        std::fs::write(
            shadow_pkg.join("dist").join("bin").join("hq-auth-refresh.js"),
            "#!/usr/bin/env node\nrequire('../auth.js');\n",
        )
        .unwrap();
        symlink(shadow_pkg.join("dist").join("index.js"), node_bin.join("hq")).unwrap();
        symlink(
            shadow_pkg.join("dist").join("bin").join("hq-auth-refresh.js"),
            node_bin.join("hq-auth-refresh"),
        )
        .unwrap();
        // The managed toolchain's own Node runtime binaries — bystanders.
        for keep in ["node", "npm", "npx"] {
            std::fs::write(node_bin.join(keep), keep).unwrap();
        }
        // The fresh copy npm delivered into the managed npm prefix.
        let prefix_pkg = root
            .join("npm-global")
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&prefix_pkg).unwrap();
        std::fs::write(
            prefix_pkg.join("package.json"),
            format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{prefix_version}"}}"#),
        )
        .unwrap();
    }

    /// The Sonia recurrence (the macOS reopen): the unix managed-toolchain layout
    /// npm actually lays down — `<root>/node/bin/hq` a SYMLINK into
    /// `<root>/node/lib/node_modules/@indigoai-us/hq-cli/dist/index.js`, the fresh
    /// copy under `<root>/npm-global`. The layout-aware repair derives the prefix
    /// from the shim (`<root>/node`), proves ownership via the symlink target, and
    /// removes exactly HQ's shims and package. On the base commit the repair reads
    /// the prefix as the shim's parent (`<root>/node/bin`), finds no manifest
    /// there, and the followed symlink names neither token, so it refuses and the
    /// stale shim survives.
    #[cfg(unix)]
    #[test]
    fn the_unix_managed_toolchain_shadow_is_repaired_from_the_derived_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        build_unix_managed_shadow(root, "5.98.0", "5.103.20");
        let node_bin = root.join("node").join("bin");
        let npm_global = root.join("npm-global");

        let action = repair_managed_shadow(&node_bin.join("hq"), &npm_global, "5.103.20");
        assert_eq!(action, ManagedShadowRepairAction::Removed);
        assert!(
            std::fs::symlink_metadata(node_bin.join("hq")).is_err(),
            "the stale hq symlink is removed"
        );
        assert!(
            std::fs::symlink_metadata(node_bin.join("hq-auth-refresh")).is_err(),
            "the second declared bin shim is removed too"
        );
        assert!(
            !root
                .join("node")
                .join("lib")
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .exists(),
            "the shadow package is removed from the DERIVED prefix, not the shim dir"
        );
        for keep in ["node", "npm", "npx"] {
            assert!(node_bin.join(keep).exists(), "managed {keep} survives");
        }
        assert!(
            npm_global
                .join("lib")
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .exists(),
            "the fresh managed copy is never touched"
        );
    }

    /// A symlinked `hq` that points OUTSIDE the derived prefix's hq-cli package is
    /// never HQ's own shim: the repair refuses and removes nothing, even though a
    /// real hq-cli manifest sits in the prefix. Guards the broadened symlink
    /// ownership rule against deleting an unrelated command.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_shim_pointing_outside_the_hq_cli_package_is_refused() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        build_unix_managed_shadow(root, "5.98.0", "5.103.20");
        let node_bin = root.join("node").join("bin");
        // Repoint the resolved shim at an unrelated command outside the package —
        // and make its target CONTENT name the scoped package, the exact shape a
        // content-only ownership check (which follows the symlink) would wrongly
        // accept and unlink. Containment must refuse it regardless of content.
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(
            elsewhere.join("other"),
            "#!/bin/sh\n# an unrelated wrapper that merely mentions @indigoai-us/hq-cli\n",
        )
        .unwrap();
        std::fs::remove_file(node_bin.join("hq")).unwrap();
        symlink(elsewhere.join("other"), node_bin.join("hq")).unwrap();

        let action = repair_managed_shadow(&node_bin.join("hq"), &root.join("npm-global"), "5.103.20");
        assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
        assert!(
            std::fs::symlink_metadata(node_bin.join("hq")).is_ok(),
            "a symlink outside the package is left in place"
        );
        assert!(
            root.join("node")
                .join("lib")
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .exists(),
            "nothing is removed when ownership is refused"
        );
    }

    /// A shadow whose shim maps to no derivable npm prefix (a bare name, or a
    /// parent that is not a recognised npm bin dir) is refused: HQ will not guess a
    /// prefix to delete from.
    #[cfg(unix)]
    #[test]
    fn a_shadow_whose_prefix_is_underivable_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        build_unix_managed_shadow(root, "5.98.0", "5.103.20");
        // A bare name has no directory to derive a prefix from.
        assert_eq!(
            repair_managed_shadow(Path::new("hq"), &root.join("npm-global"), "5.103.20"),
            ManagedShadowRepairAction::ProvenanceRefused
        );
    }

    /// Gate 2 still holds on the unix layout: when the managed prefix does not yet
    /// hold `>= latest`, the repair refuses so the shadow removal cannot strand the
    /// user without a current copy.
    #[cfg(unix)]
    #[test]
    fn a_managed_prefix_below_latest_still_refuses_the_unix_repair() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        build_unix_managed_shadow(root, "5.98.0", "5.103.19");
        let node_bin = root.join("node").join("bin");
        let action = repair_managed_shadow(&node_bin.join("hq"), &root.join("npm-global"), "5.103.20");
        assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
        assert!(
            std::fs::symlink_metadata(node_bin.join("hq")).is_ok(),
            "nothing is removed when the good copy is not yet in place"
        );
    }

    /// If a shim cannot be removed (a Windows sharing violation, an antivirus
    /// lock), the package must NOT be deleted — a surviving shim pointing at a
    /// removed package would brick a runnable CLI. The repair leaves everything in
    /// place and reports RemovalFailed.
    #[cfg(unix)]
    #[test]
    fn repair_aborts_package_removal_when_a_shim_cannot_be_removed() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let node = tmp.path().join("node");
        let prefix = tmp.path().join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        write_hq_shim(&node.join("hq.cmd"));
        write_hq_cli_pkg(&node, "5.101.0");
        write_hq_cli_pkg(&prefix, "5.101.7");
        // Make the shim's directory read-only so unlinking the shim fails.
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o555)).unwrap();

        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");

        // Restore write so temp-dir cleanup and the assertions can read the tree.
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(action, ManagedShadowRepairAction::RemovalFailed);
        assert!(
            node.join("hq.cmd").exists(),
            "a shim that could not be removed is left in place"
        );
        assert!(
            node.join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .join("package.json")
                .exists(),
            "the package is NOT deleted while a shim removal failed, so the CLI stays runnable"
        );
    }

    /// A user-placed command that merely shares the `hq` name inside the managed
    /// directory (its content does NOT name the package) is never removed, even
    /// when a real hq-cli manifest sits beside it.
    #[test]
    fn repair_never_removes_a_shim_whose_content_is_not_hq_cli() {
        let tmp = tempfile::tempdir().unwrap();
        let node = tmp.path().join("node");
        let prefix = tmp.path().join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(node.join("hq.cmd"), "@echo off\r\necho not hq\r\n").unwrap();
        write_hq_cli_pkg(&node, "5.101.0");
        write_hq_cli_pkg(&prefix, "5.101.7");

        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
        assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
        assert!(
            node.join("hq.cmd").exists(),
            "an unowned command is never removed"
        );
        assert!(
            node.join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .exists(),
            "the package beside an unowned command is left intact"
        );
    }

    /// The repair refuses (removes nothing) when the shadow's own manifest is not
    /// @indigoai-us/hq-cli — an unrelated command named `hq` is never removed.
    #[test]
    fn repair_refuses_when_the_shadow_is_not_hq_cli() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let node = root.join("node");
        let prefix = root.join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(node.join("hq.cmd"), "some other hq").unwrap();
        let other = node
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("package.json"),
            r#"{"name":"some-other-hq","version":"9.9.9"}"#,
        )
        .unwrap();
        write_hq_cli_pkg(&prefix, "5.101.7");
        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
        assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
        assert!(
            node.join("hq.cmd").exists(),
            "an unowned shim is never removed"
        );
    }

    /// The repair refuses when the managed prefix does not yet hold `>= latest`:
    /// removing the shadow would strand the user without a current copy.
    #[test]
    fn repair_refuses_when_the_managed_prefix_lacks_latest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let node = root.join("node");
        let prefix = root.join("npm-prefix");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(node.join("hq.cmd"), "stale").unwrap();
        write_hq_cli_pkg(&node, "5.101.0");
        write_hq_cli_pkg(&prefix, "5.101.0");
        let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
        assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
        assert!(
            node.join("hq.cmd").exists(),
            "nothing is removed when the good copy is not in place"
        );
    }

    /// After a repair that could not converge, the managed shadow falls back to
    /// the foreign-managed policy — the durable marker AND a capture — tagged with
    /// the repair outcome so triage can tell "not repairable" from "not attempted".
    #[test]
    fn a_repair_that_did_not_converge_writes_the_marker_and_reports_the_outcome() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        let after_bin = "/opt/IndigoHQ/toolchain/node/hq.cmd";
        for repair in [
            ManagedShadowRepairOutcome::RepairFailed,
            ManagedShadowRepairOutcome::ProvenanceRefused,
        ] {
            let outcome = decide_post_install(
                &PostInstallContext::npm(
                    after_bin,
                    after_bin,
                    Some("5.101.0"),
                    Some("5.101.0"),
                    "5.101.7",
                    Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                    "/opt/IndigoHQ/toolchain/node/npm.cmd",
                    false,
                    Some("5.101.7"),
                )
                .with_managed_roots(&roots)
                .with_managed_shadow_repair(repair),
            );
            assert_eq!(
                outcome.non_convergence_kind,
                Some(NonConvergenceKind::ManagedShadowed)
            );
            assert_eq!(
                outcome.record_non_convergent.as_deref(),
                Some("5.101.7"),
                "{repair:?} falls back to the durable marker"
            );
            assert!(outcome.capture_requires_durable_record);
            assert_eq!(
                outcome.capture.as_ref().unwrap().managed_shadow_repair,
                repair
            );
        }
    }

    /// A repair that converged: the re-decide sees `latest` at the resolved copy,
    /// so the verdict is a plain relocated-success that CLEARS the marker and emits
    /// no non-convergent capture at all.
    #[test]
    fn a_converged_managed_shadow_repair_is_a_success_that_clears_the_marker() {
        let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
        let after_bin = "/opt/IndigoHQ/toolchain/npm-prefix/hq.cmd";
        let outcome = decide_post_install(
            &PostInstallContext::npm(
                "/opt/IndigoHQ/toolchain/node/hq.cmd",
                after_bin,
                Some("5.101.0"),
                Some("5.101.7"),
                "5.101.7",
                Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                "/opt/IndigoHQ/toolchain/node/npm.cmd",
                false,
                Some("5.101.7"),
            )
            .with_managed_roots(&roots)
            .with_managed_shadow_repair(ManagedShadowRepairOutcome::Converged),
        );
        assert!(outcome.clear_non_convergent);
        assert!(outcome.non_convergence_kind.is_none());
        assert!(outcome.capture.is_none());
        assert_eq!(outcome.record_non_convergent, None);
        assert!(outcome.result.is_ok());
    }

    /// The classifier defect at the heart of the regression: with the binary
    /// unmoved, `npm_prefix_passed == npm_prefix_from_hq_bin(after_bin)` is a
    /// tautology, so the same prefix that "proves" targeting is derived from the
    /// same path. Delivery evidence is what breaks the tautology — the loud,
    /// blocking `NpmTargeted` now requires the target to actually be present in
    /// the prefix; without it the same inputs are a non-blocking shortfall.
    #[test]
    fn npm_targeted_requires_delivery_evidence_and_is_no_longer_a_prefix_tautology() {
        let prefix = "/Users/t/.npm-global";
        let hq_bin = "/Users/t/.npm-global/bin/hq";
        // Same tautological (prefix, bin) pair, opposite delivery evidence.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Npm, Some(prefix), false, hq_bin, true, &[]),
            NonConvergenceKind::NpmTargeted,
            "delivered target in a matching prefix is genuine shadowing"
        );
        assert_eq!(
            non_convergence_kind(InstallExecutor::Npm, Some(prefix), false, hq_bin, false, &[]),
            NonConvergenceKind::ResolutionShortfall,
            "an undelivered target in a matching prefix is a resolution shortfall"
        );
        // Only the loud class blocks; the shortfall never disables auto-update.
        assert!(NonConvergenceKind::NpmTargeted.may_block_auto_update());
        assert!(!NonConvergenceKind::ResolutionShortfall.may_block_auto_update());
        assert!(!NonConvergenceKind::ResolutionShortfall.is_installer_targeted());
        assert_eq!(
            NonConvergenceKind::ResolutionShortfall.telemetry_value(),
            "resolution-shortfall"
        );
    }

    /// The npm remedy ("update it with the tool that installed it") is a dead
    /// end when the app just ran that tool. The pnpm message must differ while
    /// keeping the marker the Settings UI keys on to displace the generic
    /// copy-the-command text.
    #[test]
    fn pnpm_non_convergent_detail_has_its_own_remedy_and_keeps_the_ui_marker() {
        let hq_bin = "~/Library/pnpm/bin/hq";
        let pnpm_detail =
            non_convergent_detail(InstallExecutor::Pnpm, hq_bin, Some("5.93.0"), "5.94.1");
        assert!(pnpm_detail.starts_with(NON_CONVERGENT_ERROR_PREFIX));
        assert!(pnpm_detail.contains(hq_bin));
        assert!(pnpm_detail.contains("5.93.0") && pnpm_detail.contains("5.94.1"));
        assert!(
            !pnpm_detail.contains("Update it with the tool that installed it"),
            "the npm remedy is a dead end for a run pnpm itself performed"
        );
        assert!(pnpm_detail.contains("pnpm bin -g"));

        let npm_detail =
            non_convergent_detail(InstallExecutor::Npm, hq_bin, Some("5.93.0"), "5.94.1");
        assert!(npm_detail.starts_with(NON_CONVERGENT_ERROR_PREFIX));
        assert_ne!(npm_detail, pnpm_detail);

        // An unreadable local version must still produce a usable sentence.
        let unreadable = non_convergent_detail(InstallExecutor::Pnpm, hq_bin, None, "5.94.1");
        assert!(unreadable.contains("an unreadable version"));
    }

    /// The bounded pnpm summary is the extra that has to survive the org
    /// scrubber which reduced `npm_stderr` to `[Filtered]`. It carries closed
    /// categories, booleans and lengths — never pnpm's output itself.
    #[test]
    fn pnpm_diagnostics_summary_is_closed_and_carries_no_output_text() {
        let summary = PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: true,
            path_has_shim_dir: false,
            global_bin_dir_matches_shim_dir: Some(false),
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: true,
            exit_status: "0".to_string(),
            output_len: 1024,
        }
        .summary();
        assert_eq!(
            summary,
            "home_source=nested-bin-dir home_env_present=true path_has_shim_dir=false \
             global_bin_dir_matches_shim_dir=false store_family=v11 authoritative_query_ok=true \
             exit_status=0 output_len=1024"
        );
        assert!(!summary.contains('/'));

        // The `None` (unprobed) rendering is its own closed value, never a path.
        let unprobed = PnpmRunDiagnostics {
            home_source: PnpmHomeSource::Undetermined,
            home_env_present: false,
            path_has_shim_dir: false,
            global_bin_dir_matches_shim_dir: None,
            store_family: PnpmStoreFamily::Unknown,
            authoritative_query_ok: false,
            exit_status: "0".to_string(),
            output_len: 0,
        }
        .summary();
        assert!(unprobed.contains("global_bin_dir_matches_shim_dir=unprobed"));
        assert!(unprobed.contains("store_family=unknown"));
        assert!(unprobed.contains("authoritative_query_ok=false"));
        assert!(!unprobed.contains('/'));
    }

    /// The pnpm executor pins the exact resolved version too, so both executors
    /// ask the package manager for the same string the app compared against. With
    /// no global bin dir passed the argv keeps its historical shape.
    #[test]
    fn pnpm_install_argv_pins_the_exact_resolved_version() {
        let argv = pnpm_install_argv(Some("5.97.1"), None);
        assert_eq!(
            argv,
            vec![
                "add".to_string(),
                "-g".to_string(),
                "@indigoai-us/hq-cli@5.97.1".to_string(),
            ]
        );
        assert!(
            !argv.iter().any(|arg| arg.ends_with("@latest")),
            "a pinned pnpm install must not request the @latest dist-tag: {argv:?}"
        );
        // The `None` arms keep the dist-tag fallback for versionless callers and
        // add no global-bin-dir flag.
        assert_eq!(
            pnpm_install_argv(None, None),
            vec![
                "add".to_string(),
                "-g".to_string(),
                HQ_CLI_PACKAGE.to_string(),
            ]
        );
    }

    #[test]
    fn bun_global_install_is_detected_and_pins_the_exact_version() {
        assert!(is_bun_global_shim("/Users/test/.bun/bin/hq"));
        assert!(!is_bun_global_shim("/opt/homebrew/bin/hq"));
        assert!(!is_bun_global_shim("/Users/test/.npm-global/bin/hq"));
        assert_eq!(
            bun_install_argv(Some("5.101.2")),
            vec!["add", "-g", "@indigoai-us/hq-cli@5.101.2"]
        );
    }

    #[test]
    fn bun_global_manifest_is_delivery_evidence() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bun_home = tmp.path().join(".bun");
        let package_dir = bun_home
            .join("install/global/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&package_dir).unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
        )
        .unwrap();

        assert_eq!(
            installed_hq_cli_version_in_bun_global(&bun_home).as_deref(),
            Some("5.101.2")
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_executor_accepts_bun_and_homebrew_npm_but_rejects_unrelated_hq() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::TempDir::new().unwrap();
        let bun_home = tmp.path().join(".bun");
        let bun_bin = bun_home.join("bin");
        let bun_package = bun_home
            .join("install/global/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&bun_bin).unwrap();
        std::fs::create_dir_all(&bun_package).unwrap();
        std::fs::write(bun_bin.join("hq"), b"#!/bin/sh\n").unwrap();
        std::fs::write(
            bun_package.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
        )
        .unwrap();
        assert_eq!(
            install_executor_for_hq_bin(&bun_bin.join("hq")),
            Some(InstallExecutor::Bun)
        );

        let brew_npm_prefix = tmp.path().join("homebrew-npm");
        let brew_npm_package =
            brew_npm_prefix.join("lib/node_modules/@indigoai-us/hq-cli");
        let brew_npm_bin = brew_npm_prefix.join("bin");
        std::fs::create_dir_all(&brew_npm_package).unwrap();
        std::fs::create_dir_all(&brew_npm_bin).unwrap();
        std::fs::write(
            brew_npm_package.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
        )
        .unwrap();
        std::fs::write(brew_npm_package.join("index.js"), b"#!/usr/bin/env node\n").unwrap();
        symlink(
            brew_npm_package.join("index.js"),
            brew_npm_bin.join("hq"),
        )
        .unwrap();
        assert_eq!(
            install_executor_for_hq_bin(&brew_npm_bin.join("hq")),
            Some(InstallExecutor::Npm)
        );

        let brew_prefix = tmp.path().join("homebrew");
        let unrelated_package = brew_prefix.join("Cellar/hq/1.2.2");
        let brew_bin = brew_prefix.join("bin");
        std::fs::create_dir_all(&unrelated_package).unwrap();
        std::fs::create_dir_all(&brew_bin).unwrap();
        std::fs::write(unrelated_package.join("hq"), b"#!/bin/sh\n").unwrap();
        std::fs::write(
            unrelated_package.join("package.json"),
            br#"{"name":"hq","version":"1.2.2"}"#,
        )
        .unwrap();
        symlink(unrelated_package.join("hq"), brew_bin.join("hq")).unwrap();
        assert_eq!(install_executor_for_hq_bin(&brew_bin.join("hq")), None);
    }

    /// The core of the r2 fix: pnpm must be aimed at the directory that actually
    /// holds the resolved shim. On unmodified main `pnpm_install_argv` took only a
    /// version and never emitted `--config.global-bin-dir`, so the child pnpm
    /// resolved a different global bin dir than the app did — this fails there for
    /// the right reason.
    #[test]
    fn pnpm_install_is_aimed_at_the_directory_holding_the_resolved_shim() {
        // Nested pnpm >=11 layout: `<H>/bin/hq`. The home is the grandparent,
        // but the shim — and therefore the dir pnpm must write — is `<H>/bin`.
        let nested = pnpm_global_env("/Users/t/Library/pnpm/bin/hq").expect("nested layout");
        assert_eq!(nested.global_bin_dir, "/Users/t/Library/pnpm/bin");
        let nested_argv = pnpm_install_argv(Some("5.97.2"), Some(&nested.global_bin_dir));
        assert_eq!(
            nested_argv,
            vec![
                "add".to_string(),
                "-g".to_string(),
                "--config.global-bin-dir=/Users/t/Library/pnpm/bin".to_string(),
                "@indigoai-us/hq-cli@5.97.2".to_string(),
            ]
        );

        // Flat pre-11 layout: home == global bin dir, so the forced dir is the
        // home itself and the flag is behaviour-preserving.
        let flat = pnpm_global_env("/Users/t/Library/pnpm/hq").expect("flat layout");
        assert_eq!(flat.global_bin_dir, "/Users/t/Library/pnpm");
        let flat_argv = pnpm_install_argv(Some("5.97.2"), Some(&flat.global_bin_dir));
        assert_eq!(
            flat_argv[2],
            "--config.global-bin-dir=/Users/t/Library/pnpm".to_string()
        );
    }

    /// The safety rail on the aiming change: an underivable layout
    /// (`pnpm_global_env` -> None) must invent no directory. The child is spawned
    /// exactly as before, with no `--config.global-bin-dir` flag at all.
    #[test]
    fn an_underivable_pnpm_layout_pins_no_global_bin_dir() {
        for hq_bin in [
            "hq",
            "/opt/homebrew/bin/hq",
            "/Users/t/.asdf/shims/hq",
            "/usr/local/bin/hq",
        ] {
            assert_eq!(
                pnpm_global_env(hq_bin),
                None,
                "{hq_bin} must not derive a home"
            );
        }
        // With no derivable dir the app passes `None`, and the argv carries no
        // config flag — inventing nothing.
        let argv = pnpm_install_argv(Some("5.97.2"), None);
        assert!(
            !argv
                .iter()
                .any(|arg| arg.starts_with("--config.global-bin-dir")),
            "an underivable layout must not force a global bin dir: {argv:?}"
        );
        // An empty string is treated the same as absent — never an empty flag.
        let empty = pnpm_install_argv(Some("5.97.2"), Some(""));
        assert!(!empty
            .iter()
            .any(|arg| arg.starts_with("--config.global-bin-dir")));
    }

    /// A pnpm run diagnostics builder for the nested pnpm >=11 field layout. The
    /// `matches` argument is now a NATIVE-resolution diagnostic only — it no
    /// longer changes any class — but the builder keeps varying it so the tests
    /// prove exactly that.
    fn pnpm_field_diagnostics(matches: Option<bool>) -> PnpmRunDiagnostics {
        PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: false,
            path_has_shim_dir: true,
            global_bin_dir_matches_shim_dir: matches,
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: true,
            exit_status: "0".to_string(),
            output_len: 96,
        }
    }

    /// The pnpm class is now decided by delivery evidence plus the executed
    /// reading alone. The native `pnpm bin -g` direction is a diagnostic only:
    /// the SAME targeted+delivered inputs classify PnpmTargeted whether the native
    /// dir happens to match the shim dir or (as on every pnpm >=11 nested layout)
    /// does not — the exact tautology the base defect gated blocking on.
    #[test]
    fn pnpm_targeted_requires_delivery_evidence_only() {
        let hq_bin = "/Users/t/Library/pnpm/bin/hq";
        // Delivered => genuine shadowing (loud, blocks), regardless of direction.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, true, &[]),
            NonConvergenceKind::PnpmTargeted
        );
        // NOT delivered => transient shortfall (loud, never blocks).
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, false, &[]),
            NonConvergenceKind::ResolutionShortfall
        );
        // The direction diagnostic never promotes or demotes a class: a delivered
        // target with the native dir matching AND with it mismatching both stay
        // PnpmTargeted (via `decide_post_install`, which is what wires the probe).
        for matches in [Some(true), Some(false), None] {
            let outcome = decide_post_install(&PostInstallContext {
                executor: InstallExecutor::Pnpm,
                before_bin: hq_bin,
                after_bin: hq_bin,
                before_version: None,
                after_version: Some("5.93.0"),
                latest: "5.97.2",
                npm_prefix_passed: None,
                delivered_version: Some("5.97.2"),
                installer_bin: "/opt/homebrew/bin/pnpm",
                already_blocked: false,
                nonblocking_episode_keys: &[],
                managed_roots: &[],
                managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
                pnpm: Some(pnpm_field_diagnostics(matches)),
            });
            assert_eq!(
                outcome.non_convergence_kind,
                Some(NonConvergenceKind::PnpmTargeted),
                "delivered target stays PnpmTargeted for direction {matches:?}"
            );
            assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.97.2"));
        }
        assert!(NonConvergenceKind::PnpmTargeted.may_block_auto_update());
    }

    /// The heart of the r3 regression fix: the exact 2026-08-10 pnpm >=11 field
    /// shape that STILL fails to deliver (a genuine registry shortfall, not the
    /// converged happy path) is a ResolutionShortfall that writes NO durable
    /// marker AND is bounded to one capture per episode — so the 16:13:33 /
    /// 16:14:27 double-fire across an app self-update collapses to a single event
    /// instead of re-paging on every check and every restart. On unmodified main
    /// this same shape (with the forced-flag direction probe echoing a match) was
    /// captured on every single occurrence.
    #[test]
    fn a_pnpm_resolution_shortfall_is_bounded_to_one_capture_per_episode() {
        // The native direction is Some(false) on a nested layout — the healthy
        // shape post-fix — and it no longer forces a misdirected class. pnpm's own
        // answer said the target is NOT in its global store (a genuine shortfall).
        fn shortfall_ctx<'a>(
            hq_bin: &'a str,
            latest: &'a str,
            keys: &'a [String],
        ) -> PostInstallContext<'a> {
            PostInstallContext {
                executor: InstallExecutor::Pnpm,
                before_bin: hq_bin,
                after_bin: hq_bin,
                before_version: None,
                after_version: Some("5.93.0"),
                latest,
                npm_prefix_passed: None,
                delivered_version: Some("5.93.0"),
                installer_bin: "/opt/homebrew/bin/pnpm",
                already_blocked: false,
                nonblocking_episode_keys: keys,
                managed_roots: &[],
                managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
                pnpm: Some(pnpm_field_diagnostics(Some(false))),
            }
        }
        let hq_bin = "/Users/t/Library/pnpm/bin/hq";
        let latest = "5.97.2";

        // First occurrence (empty episode set): classified shortfall, captured,
        // NO durable block, and it hands back the episode key to persist.
        let first = decide_post_install(&shortfall_ctx(hq_bin, latest, &[]));
        assert_eq!(
            first.non_convergence_kind,
            Some(NonConvergenceKind::ResolutionShortfall)
        );
        assert_eq!(
            first.record_non_convergent, None,
            "a shortfall must never wedge auto-update"
        );
        assert!(first.capture.is_some(), "first occurrence stays loud");
        assert!(!first.capture_requires_durable_record);
        let key = first
            .record_nonblocking_episode
            .expect("the first capture returns an episode key to persist");
        assert_eq!(
            key,
            non_convergent_episode_key(
                latest,
                InstallExecutor::Pnpm,
                NonConvergenceKind::ResolutionShortfall,
                Some(PnpmHomeSource::NestedBinDir),
            )
        );

        // Second occurrence with that key already persisted (a later check, or the
        // 16:14 app-restart event): SAME shape, but NOT captured — the double-fire
        // is gone — and still never blocks.
        let keys = [key];
        let repeat = decide_post_install(&shortfall_ctx(hq_bin, latest, &keys));
        assert_eq!(
            repeat.non_convergence_kind,
            Some(NonConvergenceKind::ResolutionShortfall)
        );
        assert!(
            repeat.capture.is_none(),
            "a persistent shortfall episode is captured once, not on every occurrence"
        );
        assert_eq!(repeat.record_nonblocking_episode, None);
        assert_eq!(repeat.record_non_convergent, None);

        // A NEW `latest` re-arms the capture: its episode key carries a different
        // `latest|` prefix, so a genuinely recurring defect is never hidden.
        let after_publish = decide_post_install(&shortfall_ctx(hq_bin, "5.98.0", &keys));
        assert!(
            after_publish.capture.is_some(),
            "a new CLI publish reports the shortfall again"
        );
        assert!(after_publish.record_nonblocking_episode.is_some());
    }

    /// The invariant the fix must never break: a genuine pnpm shadowing defect —
    /// pnpm's effective global bin dir IS the dir holding the executed shim AND
    /// the target WAS delivered into the store, yet the shim still reports the old
    /// version — keeps reporting on every occurrence and keeps writing the durable
    /// block, even for an already-blocked episode.
    #[test]
    fn a_delivered_pnpm_target_in_the_matching_bin_dir_stays_loud_and_blocking() {
        let hq_bin = "/Users/t/Library/pnpm/bin/hq";
        let outcome = decide_post_install(&PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.93.0"),
            latest: "5.97.2",
            npm_prefix_passed: None,
            delivered_version: Some("5.97.2"), // delivered == target
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: true, // still loud + blocking anyway
            nonblocking_episode_keys: &[],
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
            pnpm: Some(pnpm_field_diagnostics(Some(true))),
        });
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::PnpmTargeted)
        );
        assert_eq!(
            outcome.record_non_convergent.as_deref(),
            Some("5.97.2"),
            "genuine shadowing keeps its durable block"
        );
        assert!(outcome.capture.is_some());
        assert!(!outcome.capture_requires_durable_record);
    }

    /// The pnpm delivery read must consult the pnpm store, never a stray
    /// npm-style manifest that happens to sit under the pnpm home. A manual
    /// `npm install --prefix <pnpm-home>` can leave `<home>/lib/node_modules`
    /// with an older version; the shared `installed_hq_cli_version_in_prefix`
    /// enumerates that npm candidate BEFORE the store and stops at the first hit,
    /// so it would misreport delivery. The pnpm executor reads the store directly.
    #[test]
    fn pnpm_store_delivery_read_ignores_a_stray_npm_manifest_under_the_pnpm_home() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        // The pnpm store manifest carries the freshly-delivered target.
        let store = home
            .join("global")
            .join("5")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(
            store.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.97.2"}"#,
        )
        .unwrap();
        // A stray npm-style manifest under the same home holds an OLD version.
        let stray = home
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(
            stray.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.93.0"}"#,
        )
        .unwrap();

        // The pnpm-store reader returns the STORE version, ignoring the stray.
        assert_eq!(
            installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
            Some("5.97.2")
        );
        // The shared reader, given the same home, is shadowed by the stray npm
        // manifest — which is exactly why the pnpm branch uses the store reader.
        let shim = home.join("bin").join("hq");
        assert_eq!(
            installed_hq_cli_version_in_prefix(home.to_str().unwrap(), shim.to_str().unwrap())
                .as_deref(),
            Some("5.93.0"),
            "the shared reader is shadowed by the stray npm manifest"
        );
    }

    /// r3 base-failure #1 (the recurrence's root): the exact pnpm >=11 store
    /// layout the field machine had. pnpm reports its global root as
    /// `<home>/global/v11`, with the delivered package one opaque-hash directory
    /// below. On base `fcdca79e` the store reader built only
    /// `<home>/global/<n>/node_modules/...`, so this returned None and every
    /// verification path read `delivered_version=none` while the install had
    /// actually landed. It must now be discovered — both directly and through the
    /// executed (non-symlink script) shim, so `local` stops freezing stale.
    #[test]
    fn pnpm11_store_delivery_is_discovered_under_the_v11_hash_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let pkg = home
            .join("global")
            .join("v11")
            .join("a1b2c3d4e5")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
        )
        .unwrap();
        assert_eq!(
            installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
            Some("5.98.0"),
            "the pnpm 11 v11/<hash> store manifest must be discovered"
        );

        // A pnpm global shim is a plain (non-symlink) script — reproduction proves
        // canonicalize()+ancestors() can never reach its package tree — yet the
        // executed reading now resolves the version via the store candidates.
        let shim = home.join("bin").join("hq");
        std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
        std::fs::write(&shim, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(
            version_from_hq_binary(&shim).as_deref(),
            Some("5.98.0"),
            "the executed pnpm 11 shim resolves its version from the v11 store"
        );
    }

    /// When `global/v11` holds MORE THAN ONE opaque-hash directory (a prior
    /// install pnpm has not pruned), the read must be deterministic and pick the
    /// NEWEST version present — never an arbitrary hash child in filesystem
    /// enumeration order, which could report a stale version or falsely declare
    /// convergence. Both the store reader and the executed-shim read must agree.
    #[test]
    fn pnpm11_multiple_hash_dirs_resolve_deterministically_to_the_newest() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let v11 = home.join("global").join("v11");
        for (hash, version) in [("olddir00", "5.93.0"), ("newdir99", "5.98.0")] {
            let pkg = v11
                .join(hash)
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli");
            std::fs::create_dir_all(&pkg).unwrap();
            std::fs::write(
                pkg.join("package.json"),
                format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
            )
            .unwrap();
        }
        // Newest present wins regardless of which hash dir enumerates first.
        assert_eq!(
            installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
            Some("5.98.0"),
            "a lingering older hash dir must not shadow the active install"
        );
        let shim = home.join("bin").join("hq");
        std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
        std::fs::write(&shim, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(
            version_from_hq_binary(&shim).as_deref(),
            Some("5.98.0"),
            "the executed reading agrees with the store's newest install"
        );
        // The `pnpm root -g` fallback is deterministic over the same shape.
        assert_eq!(
            hq_cli_version_under_pnpm_root(&v11).as_deref(),
            Some("5.98.0")
        );
    }

    /// r3 base-failure #2: store-generation ordering. The base sort parsed "v11"
    /// with `u64::parse`, scoring it 0, so a machine migrated from pnpm 10 with a
    /// leftover "5" store enumerated the STALE store first. `v11` must now outrank
    /// it — the end-to-end reader returns the v11 version when both are present.
    #[test]
    fn pnpm_store_generations_sort_v11_ahead_of_a_leftover_numeric_store() {
        assert_eq!(pnpm_store_generation("5"), 5);
        assert_eq!(pnpm_store_generation("v11"), 11);
        assert_eq!(pnpm_store_generation("not-a-store"), 0);
        assert!(pnpm_store_generation("v11") > pnpm_store_generation("5"));
        assert!(pnpm_store_generation("v11") > pnpm_store_generation("4"));

        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let numeric = home
            .join("global")
            .join("5")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&numeric).unwrap();
        std::fs::write(
            numeric.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.93.0"}"#,
        )
        .unwrap();
        let v11 = home
            .join("global")
            .join("v11")
            .join("deadbeef")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&v11).unwrap();
        std::fs::write(
            v11.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
        )
        .unwrap();
        assert_eq!(
            installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
            Some("5.98.0"),
            "v11 must outrank a stale leftover numeric store"
        );
    }

    /// The authoritative delivery parser over `pnpm ls -g --depth 0 --json`. Both
    /// the pnpm 10 and pnpm 11 payload shapes yield the installed version; empty,
    /// malformed and unexpected JSON yield None (no evidence → retry, never block).
    #[test]
    fn pnpm_global_ls_parser_reads_both_majors_and_fails_soft() {
        let pnpm11 = r#"[{"name":"global","path":"/h/global/v11","dependencies":{"@indigoai-us/hq-cli":{"from":"@indigoai-us/hq-cli","version":"5.98.0","resolved":"file:","path":"/h/global/v11/abc/node_modules/@indigoai-us/hq-cli"}}}]"#;
        assert_eq!(pnpm_global_ls_hq_cli_version(pnpm11).as_deref(), Some("5.98.0"));
        let pnpm10 = r#"[{"dependencies":{"@indigoai-us/hq-cli":{"version":"5.97.2"}}}]"#;
        assert_eq!(pnpm_global_ls_hq_cli_version(pnpm10).as_deref(), Some("5.97.2"));
        // A bare object rather than a one-element array (seen on some setups).
        let obj = r#"{"dependencies":{"@indigoai-us/hq-cli":{"version":"5.96.0"}}}"#;
        assert_eq!(pnpm_global_ls_hq_cli_version(obj).as_deref(), Some("5.96.0"));
        // No hq-cli present, empty, malformed, and a scalar all fail soft to None.
        assert_eq!(pnpm_global_ls_hq_cli_version(r#"[{"dependencies":{}}]"#), None);
        assert_eq!(pnpm_global_ls_hq_cli_version(""), None);
        assert_eq!(pnpm_global_ls_hq_cli_version("not json {"), None);
        assert_eq!(pnpm_global_ls_hq_cli_version("42"), None);
    }

    /// The `pnpm root -g` fallback accepts BOTH store shapes: the pnpm 10 root
    /// (`<home>/global/5/node_modules`, package directly beneath) and the pnpm 11
    /// root (`<home>/global/v11`, package under a per-install hash dir).
    #[test]
    fn hq_cli_version_under_pnpm_root_accepts_both_store_shapes() {
        let tmp10 = tempfile::TempDir::new().unwrap();
        let root10 = tmp10.path().join("global").join("5").join("node_modules");
        let pkg10 = root10.join("@indigoai-us").join("hq-cli");
        std::fs::create_dir_all(&pkg10).unwrap();
        std::fs::write(
            pkg10.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.97.2"}"#,
        )
        .unwrap();
        assert_eq!(
            hq_cli_version_under_pnpm_root(&root10).as_deref(),
            Some("5.97.2")
        );

        let tmp11 = tempfile::TempDir::new().unwrap();
        let root11 = tmp11.path().join("global").join("v11");
        let pkg11 = root11
            .join("f00ba7")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg11).unwrap();
        std::fs::write(
            pkg11.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
        )
        .unwrap();
        assert_eq!(
            hq_cli_version_under_pnpm_root(&root11).as_deref(),
            Some("5.98.0")
        );

        let empty = tempfile::TempDir::new().unwrap();
        assert_eq!(hq_cli_version_under_pnpm_root(empty.path()), None);
    }

    /// The pnpm global-store family token is a closed diagnostic, never a path.
    #[test]
    fn pnpm_store_family_classifies_the_generation_name() {
        assert_eq!(pnpm_store_family("v11"), PnpmStoreFamily::V11);
        assert_eq!(pnpm_store_family("v12"), PnpmStoreFamily::V11);
        assert_eq!(pnpm_store_family("5"), PnpmStoreFamily::Numeric);
        assert_eq!(pnpm_store_family("vfoo"), PnpmStoreFamily::Unknown);
        assert_eq!(pnpm_store_family(""), PnpmStoreFamily::Unknown);
        assert_eq!(PnpmStoreFamily::V11.telemetry_value(), "v11");
        assert_eq!(PnpmStoreFamily::Numeric.telemetry_value(), "numeric");
        assert_eq!(PnpmStoreFamily::Unknown.telemetry_value(), "unknown");
    }

    /// The non-blocking episode bound: keyed per `(latest, executor, kind,
    /// home_source)`, membership-tested, and reset by a new `latest`.
    #[test]
    fn non_convergent_episode_bounding_is_per_latest_and_membership_keyed() {
        let key = non_convergent_episode_key(
            "5.98.0",
            InstallExecutor::Pnpm,
            NonConvergenceKind::ResolutionShortfall,
            Some(PnpmHomeSource::NestedBinDir),
        );
        assert_eq!(key, "5.98.0|pnpm|resolution-shortfall|nested-bin-dir");
        assert!(!non_convergent_episode_reported(&[], &key));
        let recorded = non_convergent_episode_record(&[], &key, "5.98.0");
        assert!(non_convergent_episode_reported(&recorded, &key));

        // A new `latest` carries a different `latest|` prefix, so the old key is
        // dropped from the persisted set and the shortfall reports again.
        let newer_key = non_convergent_episode_key(
            "5.99.0",
            InstallExecutor::Pnpm,
            NonConvergenceKind::ResolutionShortfall,
            Some(PnpmHomeSource::NestedBinDir),
        );
        let after = non_convergent_episode_record(&recorded, &newer_key, "5.99.0");
        assert!(non_convergent_episode_reported(&after, &newer_key));
        assert!(
            !non_convergent_episode_reported(&after, &key),
            "keys for a superseded latest are reset"
        );

        // npm uses the executor token and no pnpm home source.
        assert_eq!(
            non_convergent_episode_key(
                "5.98.0",
                InstallExecutor::Npm,
                NonConvergenceKind::ResolutionShortfall,
                None,
            ),
            "5.98.0|npm|resolution-shortfall|n/a"
        );
    }

    /// Convergence is the property the old code never checked: npm exiting 0
    /// only proves a package was written *somewhere*, not that it landed where
    /// detection reads. `install_converged` is what turns "npm said fine" into
    /// "the CLI the app runs actually moved".
    #[test]
    fn install_converged_requires_detection_to_reach_latest() {
        assert!(install_converged(Some("5.79.0"), "5.79.0"));
        // Detection ahead of the registry (a beta/local build) still counts.
        assert!(install_converged(Some("5.80.0"), "5.79.0"));
        // The prod signature: npm exits 0, detection is unchanged.
        assert!(!install_converged(Some("5.77.10"), "5.79.0"));
        // Detection went blind right after an install — cannot prove anything.
        assert!(!install_converged(None, "5.79.0"));
    }

    #[test]
    fn post_install_relocation_counts_as_converged() {
        assert_eq!(
            convergence_verdict(
                Some("5.77.14"),
                Some("5.83.0"),
                "/Users/test/.asdf/shims/hq",
                "/opt/homebrew/bin/hq",
                "5.83.0",
            ),
            ConvergenceVerdict::RelocatedAndConverged
        );
    }

    #[test]
    fn genuinely_stale_post_install_resolution_still_blocks() {
        assert_eq!(
            convergence_verdict(
                Some("5.77.14"),
                Some("5.77.14"),
                "/Users/test/.asdf/shims/hq",
                "/Users/test/.asdf/shims/hq",
                "5.83.0",
            ),
            ConvergenceVerdict::NonConvergent
        );
        assert!(!should_auto_install("5.83.0", Some("5.83.0")));
    }

    #[test]
    fn bin_resolution_source_is_closed_and_path_free() {
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(bin_resolution_source("/opt/homebrew/bin/hq"), "homebrew");
            assert_eq!(bin_resolution_source("/usr/local/bin/npm"), "usr-local");
            assert_eq!(
                bin_resolution_source("/Users/test/.asdf/shims/hq"),
                "login-shell"
            );
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(bin_resolution_source("/opt/homebrew/bin/hq"), "unknown");
            assert_eq!(bin_resolution_source("/usr/local/bin/npm"), "unknown");
            assert_eq!(
                bin_resolution_source("/Users/test/.asdf/shims/hq"),
                "unknown"
            );
        }
        assert_eq!(bin_resolution_source("hq"), "unknown");
    }

    /// The arm that matters is the one a healthy machine never takes: no
    /// version readable AND no binary found means the user simply has no CLI.
    #[test]
    fn install_is_needed_when_no_cli_is_installed_at_all() {
        assert!(cli_install_needed(None, "5.103.1", /* hq_installed */ false));
    }

    /// A binary IS present but its version cannot be read. That is ambiguous —
    /// our own install left broken by an interrupted global install, or an
    /// unrelated program named `hq` — and a version string cannot tell them
    /// apart. Keep today's behaviour rather than sending the installer at a
    /// decision it also cannot make safely (it refuses, so claiming "needed"
    /// here would just retry fruitlessly on every check).
    #[test]
    fn an_unreadable_but_present_cli_is_left_alone() {
        assert!(!cli_install_needed(None, "5.103.1", /* hq_installed */ true));
    }

    #[test]
    fn install_is_needed_only_when_the_local_version_is_older() {
        assert!(cli_install_needed(Some("5.102.0"), "5.103.1", true));
        // Current, and ahead (a local dev build) — neither should trigger a
        // reinstall on every check.
        assert!(!cli_install_needed(Some("5.103.1"), "5.103.1", true));
        assert!(!cli_install_needed(Some("5.104.0"), "5.103.1", true));
    }

    #[test]
    fn install_need_compares_numerically_not_lexically() {
        // Guards the same trap `cmp_semver` exists for: "5.9.0" > "5.10.0" as
        // strings would silently stop upgrading past a two-digit minor.
        assert!(cli_install_needed(Some("5.9.0"), "5.10.0", true));
        assert!(!cli_install_needed(Some("5.10.0"), "5.9.0", true));
    }

    /// Nothing on PATH means nothing to overwrite, so the "refusing to
    /// overwrite an unrelated command" guard has nothing to protect and the
    /// user simply has no CLI. This is the plain first-install case.
    #[test]
    fn first_install_uses_npm_when_no_hq_resolves_at_all() {
        assert_eq!(
            install_executor_for_first_install(ResolvedProgramKind::NotResolved),
            Some(InstallExecutor::Npm)
        );
    }

    /// The protection this whole path exists for: a resolved binary we cannot
    /// identify must never be overwritten. In particular a path inside a pnpm
    /// or Bun global root proves only that THAT MANAGER owns the binary — any
    /// unrelated package exposing an `hq` bin installs to exactly there — so
    /// path shape is not ownership evidence and must not unlock an install.
    #[test]
    fn a_resolved_but_unidentifiable_hq_is_always_refused() {
        for kind in [
            ResolvedProgramKind::Exe,
            ResolvedProgramKind::CmdOrBat,
            ResolvedProgramKind::Extensionless,
            ResolvedProgramKind::OtherExtension,
        ] {
            assert_eq!(install_executor_for_first_install(kind), None);
        }
    }

    /// Without this gate the background loop reinstalls the same version 15s
    /// after every launch and every 6h forever — the observable "stuck" symptom.
    #[test]
    fn auto_install_stops_repeating_a_non_convergent_version() {
        // Nothing recorded → always allowed.
        assert!(should_auto_install("5.79.0", None));
        // Already proven not to move the needle → do not spin on it again.
        assert!(!should_auto_install("5.79.0", Some("5.79.0")));
        // A newly published version clears the block: the environment may have
        // changed, and this release is exactly what a stale user needs.
        assert!(should_auto_install("5.80.0", Some("5.79.0")));
    }

    /// The failure text is the whole remedy for a non-convergent install — it
    /// has to name the binary that did not move, or the user has no way to know
    /// which of several installed copies is shadowing the update. It also has
    /// to carry the marker, since the UI keys off it to suppress the
    /// copy-the-install-command action that would just repeat the failure.
    #[test]
    fn non_convergent_detail_names_the_binary_that_did_not_move() {
        let detail = non_convergent_detail(
            InstallExecutor::Npm,
            "/Users/test/Library/pnpm/hq",
            Some("5.38.2"),
            "5.79.0",
        );
        assert!(
            detail.starts_with(NON_CONVERGENT_ERROR_PREFIX),
            "UI keys off this marker; got {detail}"
        );
        assert!(detail.contains("5.79.0"), "must name the target version");
        assert!(detail.contains("5.38.2"), "must name the stuck version");
        assert!(
            detail.contains("/Users/test/Library/pnpm/hq"),
            "must name the shadowing binary; got {detail}"
        );
    }

    /// Convergence must be judged on the binary the app EXECUTES. Anchoring it
    /// to `get_local_version` would accept the `npm root -g` fallback — which,
    /// for exactly the pnpm/Homebrew layouts this PR is about, reports the copy
    /// npm just wrote while the resolved executable is untouched. That trades a
    /// loud reinstall loop for a silent "up to date" lie.
    #[test]
    #[cfg(unix)]
    fn resolved_hq_version_never_falls_back_to_the_npm_root_reading() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();

        // A pnpm-style FLAT shim: a real script, not a symlink into any package
        // tree, with no `@indigoai-us/hq-cli/package.json` above it.
        let shim_dir = tmp.path().join("Library/pnpm");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let shim = shim_dir.join("hq");
        std::fs::File::create(&shim)
            .unwrap()
            .write_all(b"#!/bin/sh\nexit 1\n")
            .unwrap();

        // A newer npm-global install sitting elsewhere on the same machine —
        // the copy `npm root -g` would report. It must NOT be picked up here.
        let pkg_dir = tmp
            .path()
            .join("npm-global/lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#)
            .unwrap();

        // Binary-anchoring fails and the shim exits non-zero, so both probes
        // come back empty rather than borrowing the unrelated 5.79.0.
        assert_eq!(resolved_hq_version(&shim.to_string_lossy()), None);
        // ...and an unresolved `hq` is never treated as a version.
        assert_eq!(resolved_hq_version("hq"), None);
    }

    /// A resolvable npm-layout binary still reads correctly — the half of the
    /// probe that must keep working for ordinary users.
    #[test]
    #[cfg(unix)]
    fn resolved_hq_version_reads_an_npm_layout_symlink() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#)
            .unwrap();
        let real = pkg_dir.join("dist/index.js");
        std::fs::File::create(&real)
            .unwrap()
            .write_all(b"#!/usr/bin/env node\n")
            .unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let link = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(
            resolved_hq_version(&link.to_string_lossy()),
            Some("5.79.0".to_string())
        );
    }

    /// Sentry extras carry the install layout, never the account name. The
    /// shared `before_send` scrubber filters by KEY name only, so ordinary
    /// string extras leak verbatim unless redacted at the call site.
    #[test]
    fn redact_home_strips_the_account_name_everywhere_it_appears() {
        let home = Some("/Users/alice");
        // A bare path value.
        assert_eq!(
            redact_home_in("/Users/alice/Library/pnpm/hq", home),
            "~/Library/pnpm/hq"
        );
        // npm stderr embeds paths mid-string — a prefix strip would miss these,
        // which is why this is a global replace.
        assert_eq!(
            redact_home_in(
                "npm error Error: EACCES: permission denied, mkdir '/Users/alice/Library/lib'",
                home,
            ),
            "npm error Error: EACCES: permission denied, mkdir '~/Library/lib'"
        );
        // Nothing to redact / no home known → unchanged.
        assert_eq!(
            redact_home_in("/opt/homebrew/bin/hq", home),
            "/opt/homebrew/bin/hq"
        );
        assert_eq!(redact_home_in("/Users/alice/x", None), "/Users/alice/x");
        // `/` as home would otherwise shred every path in the string.
        assert_eq!(
            redact_home_in("/Users/alice/x", Some("/")),
            "/Users/alice/x"
        );
    }

    #[test]
    fn npm_prefix_from_windows_hq_cmd_uses_its_parent_directory() {
        assert_eq!(
            npm_prefix_from_hq_bin(
                "C:/Users/test/AppData/Local/IndigoHQ/toolchain/npm-prefix/hq.cmd"
            ),
            Some("C:/Users/test/AppData/Local/IndigoHQ/toolchain/npm-prefix".to_string()),
            "Windows global npm shims live directly in <prefix>, not <prefix>/bin"
        );
    }

    #[test]
    fn version_from_windows_hq_cmd_reads_sibling_node_modules_package() {
        let tmp = tempfile::TempDir::new().unwrap();
        let prefix = tmp.path().join("npm-prefix");
        let pkg_dir = prefix.join("node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#,
        )
        .unwrap();
        let shim = prefix.join("hq.cmd");
        std::fs::write(
            &shim,
            b"@node \"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*\r\n",
        )
        .unwrap();

        assert_eq!(
            version_from_hq_binary(&shim),
            Some("5.79.0".to_string()),
            "Windows npm shims are siblings of node_modules, not symlinks into the package"
        );
    }

    // The exact npm stderr behind HQ-SYNC-WEB-Y (exit 243, 7 users): a root-
    // owned global prefix the menubar app can't write to without sudo.
    const REAL_EACCES_STDERR: &str = "npm error code EACCES\n\
        npm error syscall mkdir\n\
        npm error path /usr/local/lib/node_modules/@indigoai-us\n\
        npm error errno -13\n\
        npm error Error: EACCES: permission denied, mkdir \
        '/usr/local/lib/node_modules/@indigoai-us'";

    #[test]
    fn prefix_permission_failure_detects_the_sudo_case() {
        assert!(is_prefix_permission_failure(
            REAL_EACCES_STDERR,
            Some("/usr/local"),
        ));
        assert!(is_prefix_permission_failure(
            "Error: permission denied, mkdir 'C:\\Program Files\\nodejs\\node_modules'",
            Some("C:\\Program Files\\nodejs"),
        ));
    }

    #[test]
    fn prefix_permission_failure_requires_the_selected_npm_target_path() {
        // A bare EACCES and permission errors elsewhere must stay loud. The
        // previous broad match silently discarded these real failures.
        assert!(!is_prefix_permission_failure(
            "npm error EACCES",
            Some("/usr/local")
        ));
        assert!(!is_prefix_permission_failure(
            "Error: EACCES: permission denied, open '/Users/me/.npm/_cacache/index-v5'",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(
            "Error: permission denied, mkdir '/opt/homebrew/lib/node_modules'",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(REAL_EACCES_STDERR, None));
        assert!(!is_prefix_permission_failure(
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(
            "npm error code ENOSPC: no space left on device",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure("", Some("/usr/local")));
    }

    #[test]
    fn install_failure_report_skips_expected_eacces() {
        // HQ-SYNC-WEB-Y: the exit-243 EACCES flood must NOT be reported to
        // Sentry — it's an expected client-side environment fault (root-owned
        // npm prefix needs sudo) with a copy-the-command UI fallback. `None`
        // here is exactly what makes `report_install_failure` skip the capture.
        assert_eq!(
            install_failure_report(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            None
        );
    }

    #[test]
    fn exit_243_eacces_with_no_derived_prefix_is_expected_and_not_reported() {
        // HQ-DESKTOP-3Y: when `hq` cannot be resolved, npm picks its own
        // global prefix. An EACCES at that global-install target is still an
        // expected local-machine condition, not an updater defect.
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, None),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            install_failure_report(Some(243), REAL_EACCES_STDERR, None),
            None
        );
    }

    #[test]
    fn no_prefix_permission_failure_outside_the_npm_global_target_stays_loud() {
        for detail in [
            "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5",
            "npm error code EACCES\nnpm error path /Users/me/project/node_modules/other-package",
            "npm error code EACCES\nnpm error path /Users/me/project/lib/node_modules/unrelated-package",
        ] {
            assert_eq!(
                classify_install_failure(Some(243), detail, None),
                InstallFailureKind::Unexpected,
                "detail: {detail}"
            );
            assert!(install_failure_report(Some(243), detail, None).is_some());
        }
    }

    /// The exact reported HQ-DESKTOP-53 shape: npm's own `ENOSPC` code, a `write`
    /// syscall, no `npm error path` line (npm_path_shape=none), exit 1.
    const DISK_FULL_STDERR: &str = "npm error code ENOSPC\n\
        npm error syscall write\n\
        npm error errno -28\n\
        npm error ENOSPC: no space left on device, write";

    #[test]
    fn no_prefix_non_permission_nontransient_failures_stay_loud() {
        // EINTEGRITY and EEXIST are genuine, non-permission, non-transient
        // failures: they must stay loud (Unexpected) and keep reporting.
        for detail in [
            "npm error code EINTEGRITY\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code EEXIST\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        ] {
            assert_eq!(
                classify_install_failure(Some(1), detail, None),
                InstallFailureKind::Unexpected,
                "detail: {detail}"
            );
            assert!(
                install_failure_report(Some(1), detail, None).is_some(),
                "detail: {detail}"
            );
        }
        // ENOSPC now routes to the dedicated disk-full arm (a full disk is not an
        // updater defect). The property THIS test guards — the permission arm does
        // not over-widen onto a non-permission failure — is preserved verbatim:
        // ENOSPC classifies as ExpectedDiskFull, explicitly NOT ExpectedPrefixPermission.
        let enospc = "npm error code ENOSPC\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
        assert_eq!(
            classify_install_failure(Some(1), enospc, None),
            InstallFailureKind::ExpectedDiskFull
        );
        assert_ne!(
            classify_install_failure(Some(1), enospc, None),
            InstallFailureKind::ExpectedPrefixPermission
        );
    }

    #[test]
    fn the_reported_enospc_shape_is_disk_full_and_never_reports() {
        // HQ-DESKTOP-53. Across the prefixes the installer may pass and whether or
        // not npm's retry ladder forced a final attempt, npm's own `ENOSPC`
        // classifies ExpectedDiskFull and produces NO Sentry report.
        for prefix in [None, Some("/usr/local")] {
            for forced in [false, true] {
                assert_eq!(
                    classify_install_failure_with_final_attempt(
                        Some(1),
                        DISK_FULL_STDERR,
                        prefix,
                        forced
                    ),
                    InstallFailureKind::ExpectedDiskFull,
                    "prefix={prefix:?} forced={forced}"
                );
                assert_eq!(
                    install_failure_report_with_final_attempt(
                        Some(1),
                        DISK_FULL_STDERR,
                        prefix,
                        forced
                    ),
                    None,
                    "prefix={prefix:?} forced={forced}"
                );
            }
        }
    }

    #[test]
    fn a_disk_full_failure_shows_the_free_up_space_copy_not_raw_stderr() {
        // The user sees the actionable free-up-space remedy, never the raw npm
        // stderr the passthrough would otherwise surface.
        let detail = install_failure_detail(Some(1), DISK_FULL_STDERR, None);
        assert!(detail.contains("disk space"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
        assert!(
            !detail.contains("npm error"),
            "raw npm stderr leaked to the user: {detail}"
        );
    }

    #[test]
    fn disk_full_arm_leaves_every_other_classification_untouched() {
        // The disk-full arm is FIRST, so prove it did not widen onto any other
        // shape. Each keeps exactly the kind it had before this change.
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            classify_install_failure(
                Some(-4048),
                "npm error code EPERM\nnpm error errno -4048",
                None
            ),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
                None,
                true,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
        assert_eq!(
            classify_install_failure(
                Some(1),
                "npm error code ETARGET\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
                None,
            ),
            InstallFailureKind::ExpectedTransientRegistry
        );
        for detail in [
            "npm error code EINTEGRITY\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code ENOTDIR\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
        ] {
            assert_eq!(
                classify_install_failure(Some(1), detail, None),
                InstallFailureKind::Unexpected,
                "detail: {detail}"
            );
            assert!(
                install_failure_report(Some(1), detail, None).is_some(),
                "detail: {detail}"
            );
        }
    }

    #[test]
    fn third_party_lifecycle_failure_mentioning_enospc_stays_a_lifecycle_failure() {
        // A third-party build script that ran out of disk space carries npm's
        // lifecycle markers (an all-digit `code` and `command failed`), so the
        // disk-full arm's code clause cannot match and its phrase clause is gated
        // off by `!has_npm_lifecycle_failure_marker`. It must stay UnexpectedLifecycle,
        // keep reporting, and keep its per-package `disk-space` signature — the
        // disk-full arm must never widen onto the lifecycle path.
        let detail = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            gyp ERR! ENOSPC: no space left on device";
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::UnexpectedLifecycle
        );
        assert!(install_failure_report(Some(1), detail, Some("/usr/local")).is_some());
        assert_eq!(
            install_failure_signature(
                InstallFailureKind::UnexpectedLifecycle,
                detail,
                Some("/usr/local")
            ),
            "lifecycle:better-sqlite3:disk-space"
        );
    }

    #[test]
    fn legacy_npm_err_lifecycle_failure_mentioning_enospc_stays_a_lifecycle_failure() {
        // Regression for the LEGACY `npm ERR!` spelling.
        // `has_npm_lifecycle_failure_marker` only recognizes the modern `npm error`
        // spelling, so without the additional `npm_lifecycle_failure()` gate the
        // disk-full phrase fallback would swallow an old-npm build failure that ran
        // out of space. It must stay UnexpectedLifecycle, keep reporting, and keep
        // its per-package disk-space signature.
        let detail = "npm ERR! code 1\n\
            npm ERR! command failed\n\
            npm ERR! command sh -c prebuild-install || node-gyp rebuild\n\
            npm ERR! path /usr/local/lib/node_modules/better-sqlite3\n\
            gyp ERR! ENOSPC: no space left on device";
        assert!(!is_disk_exhaustion_failure(detail));
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::UnexpectedLifecycle
        );
        assert!(install_failure_report(Some(1), detail, Some("/usr/local")).is_some());
        assert_eq!(
            install_failure_signature(
                InstallFailureKind::UnexpectedLifecycle,
                detail,
                Some("/usr/local")
            ),
            "lifecycle:better-sqlite3:disk-space"
        );
    }

    #[test]
    fn transient_registry_failures_keep_the_current_expected_classification() {
        for detail in [
            "npm error code ETIMEDOUT\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code ECONNRESET\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            // HQ-DESKTOP-5C: a registry socket idle timeout is the same transient
            // class and must classify identically to its five siblings — both the
            // env-blind classifier and the environment-aware refinement.
            "npm error code EIDLETIMEOUT\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        ] {
            assert_eq!(
                classify_install_failure(Some(1), detail, None),
                InstallFailureKind::ExpectedTransientRegistry,
                "detail: {detail}"
            );
            assert_eq!(
                classify_install_failure_with_environment(
                    Some(1),
                    detail,
                    None,
                    false,
                    &InstallEnvironment::default(),
                ),
                InstallFailureKind::ExpectedTransientRegistry,
                "env-aware detail: {detail}"
            );
        }

        // The transient absorption must NOT leak into a failure that carries an
        // EIDLETIMEOUT code alongside a lifecycle marker: the `command failed`
        // marker keeps `has_npm_lifecycle_failure_marker` true, so the transient
        // arm is skipped and the failure stays LOUD (captured at Error) rather
        // than being silently absorbed — mirroring the ETARGET/ECONNRESET
        // lifecycle guard. It lands as `Unexpected` (a symbolic registry code is
        // not a numeric lifecycle script status, so no third-party package is
        // attributed), which still pages at Error.
        let lifecycle_with_eidletimeout = "npm error code EIDLETIMEOUT\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
        let lifecycle_kind = classify_install_failure(Some(1), lifecycle_with_eidletimeout, None);
        assert_ne!(lifecycle_kind, InstallFailureKind::ExpectedTransientRegistry);
        assert_eq!(lifecycle_kind, InstallFailureKind::Unexpected);

        // The LEGACY `npm ERR!` spelling of a lifecycle failure carrying EIDLETIMEOUT
        // must also stay loud: has_npm_lifecycle_failure_marker now recognises the
        // legacy marker, so an old npm's real build failure is NOT silently absorbed
        // as a registry timeout. It lands at Error as `Unexpected` (loud) — exactly
        // its pre-EIDLETIMEOUT-allow-list behaviour, so nothing is silenced.
        let legacy_lifecycle_with_eidletimeout = "npm ERR! code EIDLETIMEOUT\n\
            npm ERR! command failed\n\
            npm ERR! command sh -c prebuild-install || node-gyp rebuild\n\
            npm ERR! path /usr/local/lib/node_modules/better-sqlite3";
        let legacy_kind = classify_install_failure(Some(1), legacy_lifecycle_with_eidletimeout, None);
        assert_ne!(legacy_kind, InstallFailureKind::ExpectedTransientRegistry);
        assert_eq!(legacy_kind, InstallFailureKind::Unexpected);
        // And it is still reported (captured at Error), never dropped.
        assert!(install_failure_report(Some(1), legacy_lifecycle_with_eidletimeout, None).is_some());
    }

    #[test]
    fn exit_243_without_a_global_install_path_does_not_suppress() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/project/.cache/hq";
        assert!(!is_global_prefix_permission_failure(Some(243), detail));
        assert_eq!(
            classify_install_failure(Some(243), detail, None),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn exit_243_without_permission_evidence_at_a_global_path_stays_loud() {
        let detail = "npm error code 243\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
        assert!(!is_global_prefix_permission_failure(Some(243), detail));
        assert_eq!(
            classify_install_failure(Some(243), detail, None),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn no_prefix_permission_failure_recognizes_npm_global_bin_targets() {
        for detail in [
            "npm error code EACCES\nnpm error path /usr/local/bin/hq",
            "npm error code EACCES\nnpm error path C:\\Users\\me\\AppData\\Roaming\\npm\\hq.cmd",
        ] {
            assert!(is_global_prefix_permission_failure(Some(243), detail));
            assert_eq!(
                classify_install_failure(Some(243), detail, None),
                InstallFailureKind::ExpectedPrefixPermission
            );
        }
    }

    #[test]
    fn derived_prefix_classification_is_unchanged() {
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            classify_install_failure(
                Some(243),
                "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5",
                Some("/usr/local"),
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_an_unmatched_global_target_is_expected() {
        let detail =
            "npm error code EACCES\nnpm error path /opt/homebrew/lib/node_modules/@indigoai-us";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            install_failure_report(Some(243), detail, Some("/usr/local")),
            None
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_the_npm_cache_stays_loud() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_an_unrelated_path_stays_loud() {
        let detail =
            "npm error code EACCES\nnpm error path /Users/me/project/node_modules/other-package";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_without_a_path_stays_loud() {
        assert_eq!(
            classify_install_failure(Some(243), "npm error code EACCES", Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_disk_full_failure_at_an_unmatched_global_target_is_disk_full_not_permission() {
        // Formerly asserted ENOSPC -> Unexpected. ENOSPC now routes to the
        // dedicated disk-full arm, but the property this test guards is unchanged:
        // a non-permission failure at a global target that differs from the derived
        // prefix must NOT be swallowed by the permission arm.
        let detail =
            "npm error code ENOSPC\nnpm error path /opt/homebrew/lib/node_modules/@indigoai-us";
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::ExpectedDiskFull
        );
        assert_ne!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
    }

    #[test]
    fn npm_diagnostics_derivation_is_enumerated_and_path_free() {
        assert_eq!(npm_error_code(REAL_EACCES_STDERR), "EACCES");
        assert_eq!(npm_syscall(REAL_EACCES_STDERR), "mkdir");
        assert_eq!(
            npm_path_shape(REAL_EACCES_STDERR, Some("/usr/local")),
            NpmPathShape::SelectedPrefixNodeModules
        );
        assert_eq!(
            npm_path_shape(REAL_EACCES_STDERR, None),
            NpmPathShape::GlobalLibNodeModules
        );
        assert_eq!(
            npm_path_shape("npm error path /Users/me/.npm/_cacache/index-v5", None),
            NpmPathShape::NpmCache
        );
        assert_eq!(npm_error_code("npm error code EWHATEVER"), "EWHATEVER");
        assert_eq!(npm_syscall("npm error syscall chmod"), "unknown");
        assert!(has_eacces_evidence("npm error Error: permission denied"));
        assert!(has_eacces_evidence("npm error errno -13"));
        assert!(!has_eacces_evidence("npm error code ECONNRESET"));
    }

    #[test]
    fn npm_error_code_preserves_safe_real_tokens_without_widening_suppression() {
        assert_eq!(npm_error_code("npm error code E404"), "E404");
        assert_eq!(npm_error_code("npm error code ELIFECYCLE"), "ELIFECYCLE");
        assert_eq!(npm_error_code("npm error code 1"), "1");
        assert_eq!(npm_error_code("npm error syscall open"), "none");
        assert_eq!(
            npm_error_code("npm error code /Users/alice/private"),
            "unrecognized"
        );
        assert_eq!(npm_error_code("npm error code \"E404\""), "unrecognized");
        assert_eq!(
            npm_error_code("npm error code ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567"),
            "unrecognized"
        );

        for code in [
            "ETARGET",
            "ECONNRESET",
            "ETIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ERR_SOCKET_TIMEOUT",
            "EIDLETIMEOUT",
        ] {
            assert!(is_expected_transient_registry_failure(&format!(
                "npm error code {code}"
            )));
        }
        for code in ["E404", "ELIFECYCLE", "1", "ECONNREFUSED"] {
            assert!(!is_expected_transient_registry_failure(&format!(
                "npm error code {code}"
            )));
        }
    }

    #[test]
    fn lifecycle_tags_and_local_attempt_summaries_are_bounded_and_path_free() {
        let scoped = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/@scope/pkg";
        assert_eq!(
            npm_lifecycle_failure(scoped),
            NpmLifecycleFailure {
                failed: true,
                package: Some("@scope/pkg".to_string()),
            }
        );

        let unscoped = "npm error code ELIFECYCLE\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/better-sqlite3";
        assert_eq!(
            npm_lifecycle_failure(unscoped),
            NpmLifecycleFailure {
                failed: true,
                package: Some("better-sqlite3".to_string()),
            }
        );

        let malformed = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/@Scope/Package";
        assert_eq!(
            npm_lifecycle_failure(malformed),
            NpmLifecycleFailure {
                failed: true,
                package: None,
            }
        );
        assert_eq!(
            npm_lifecycle_failure("npm error code 1"),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            }
        );
        assert_eq!(
            npm_lifecycle_failure(
                "npm error code ENOENT\nnpm error command failed\nnpm error path /tmp/lib/node_modules/better-sqlite3"
            ),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            },
            "errno output must not be misclassified as a lifecycle failure"
        );
        assert_eq!(
            npm_lifecycle_failure(
                "npm error code 1\nnpm error path /tmp/lib/node_modules/better-sqlite3\nbuild output: npm error command failed"
            ),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            },
            "only npm's structured command-failed marker can classify a lifecycle failure"
        );

        let summary = npm_install_attempt_summary(Some(1), scoped, Some("/Users/alice/toolchain"));
        assert!(summary.contains("npm_code=1"));
        assert!(summary.contains("path_shape=selected-prefix-node-modules"));
        assert!(summary.contains("exit_code=1"));
        assert!(!summary.contains("/Users/"));
        assert!(!summary.contains("alice"));
    }

    #[test]
    fn forced_structured_bin_collision_is_the_only_new_expected_kind() {
        let bin_collision = "npm error code EEXIST\n\
            npm error path /usr/local/bin/hq";
        assert!(is_npm_bin_collision(bin_collision, Some("/usr/local")));
        for path in [
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq",
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq.cmd",
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq.ps1",
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert!(is_npm_bin_collision(&detail, None), "detail: {detail}");
        }
        let custom_windows_prefix = "C:\\Users\\alice\\AppData\\Local\\hq-tools";
        let custom_windows_collision =
            format!("npm error code EEXIST\nnpm error path {custom_windows_prefix}\\hq.ps1");
        assert!(is_npm_bin_collision(
            &custom_windows_collision,
            Some(custom_windows_prefix)
        ));
        let custom_windows_permission =
            format!("npm error code EACCES\nnpm error path {custom_windows_prefix}\\hq.cmd");
        assert_eq!(
            classify_install_failure(
                Some(243),
                &custom_windows_permission,
                Some(custom_windows_prefix)
            ),
            InstallFailureKind::ExpectedPrefixPermission,
            "a custom Windows npm prefix must retain permission suppression"
        );
        assert_eq!(
            classify_install_failure(Some(1), bin_collision, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                bin_collision,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
        assert_eq!(
            install_failure_report_with_final_attempt(
                Some(1),
                bin_collision,
                Some("/usr/local"),
                true,
            ),
            Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
        );

        let lifecycle_output = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/bin/hq\n\
            script output contains EEXIST";
        assert!(!is_npm_bin_collision(lifecycle_output, Some("/usr/local")));
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                lifecycle_output,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn every_declared_hq_cli_shim_is_recognized_as_a_bin_collision() {
        // Recognition must cover EVERY shim @indigoai-us/hq-cli declares, in all
        // four link forms, both with a known prefix and via the prefix-free
        // suffix path npm emits when the updater could not resolve a prefix.
        // Adding a name to HQ_CLI_BIN_NAMES is then the only edit a new bin needs.
        for name in HQ_CLI_BIN_NAMES {
            let prefix = "/usr/local";
            for path in [
                format!("{prefix}/bin/{name}"),
                format!("{prefix}/{name}"),
                format!("{prefix}/{name}.cmd"),
                format!("{prefix}/{name}.ps1"),
            ] {
                let detail = format!("npm error code EEXIST\nnpm error path {path}");
                assert_eq!(
                    npm_path_shape(&detail, Some(prefix)),
                    NpmPathShape::BinHq,
                    "prefix-anchored shape for {path}"
                );
                assert!(
                    is_npm_bin_collision(&detail, Some(prefix)),
                    "prefix-anchored collision for {path}"
                );
            }
            for path in [
                format!("/opt/homebrew/bin/{name}"),
                format!("C:/Users/alice/AppData/Roaming/npm/{name}"),
                format!("C:/Users/alice/AppData/Roaming/npm/{name}.cmd"),
                format!("C:/Users/alice/AppData/Roaming/npm/{name}.ps1"),
            ] {
                let detail = format!("npm error code EEXIST\nnpm error path {path}");
                assert_eq!(
                    npm_path_shape(&detail, None),
                    NpmPathShape::BinHq,
                    "prefix-free shape for {path}"
                );
                assert!(
                    is_npm_bin_collision(&detail, None),
                    "prefix-free collision for {path}"
                );
            }
        }
    }

    #[test]
    fn undeclared_neighbour_shims_do_not_widen_into_a_collision() {
        // The widening is strict: it must not swallow unrelated binaries whose
        // names merely start with `hq` or extend a declared name.
        for prefix in [Some("/usr/local"), None] {
            for path in [
                "/usr/local/bin/hq-other",
                "/usr/local/bin/hqx",
                "/usr/local/bin/hq-auth",
                "/usr/local/bin/hq-auth-refresh-2",
            ] {
                let detail = format!("npm error code EEXIST\nnpm error path {path}");
                assert_eq!(
                    npm_path_shape(&detail, prefix),
                    NpmPathShape::Other,
                    "path {path} with prefix {prefix:?} must stay Other"
                );
                assert!(
                    !is_npm_bin_collision(&detail, prefix),
                    "path {path} with prefix {prefix:?} must not be a collision"
                );
            }
        }
    }

    #[test]
    fn second_shim_bin_collision_arms_the_same_forced_remedy() {
        // HQ-DESKTOP-4Y: the reported collision was on the package's SECOND
        // declared shim, `hq-auth-refresh`, not `hq`. It must classify exactly
        // like a `hq` collision — Unexpected until npm's `--force` remedy ran,
        // ExpectedBinCollision once it did — and title on the recognized
        // `bin-hq` signature rather than the reported `EEXIST:unknown:other`.
        let second_shim = "npm error code EEXIST\n\
            npm error path /usr/local/bin/hq-auth-refresh";
        assert!(is_npm_bin_collision(second_shim, Some("/usr/local")));
        // The reported event carried no prefix; the prefix-free suffix path must
        // recognize it just the same.
        assert!(is_npm_bin_collision(second_shim, None));

        assert_eq!(
            classify_install_failure(Some(1), second_shim, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                second_shim,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
        assert_eq!(
            install_failure_report_with_final_attempt(
                Some(1),
                second_shim,
                Some("/usr/local"),
                true,
            ),
            Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
        );
        assert_eq!(
            install_failure_signature(
                InstallFailureKind::ExpectedBinCollision,
                second_shim,
                Some("/usr/local"),
            ),
            "EEXIST:unknown:bin-hq"
        );

        // An EACCES while linking the same second shim is the sudo case, not a
        // fresh page: it joins the existing prefix-permission bucket, with a
        // known prefix and via the global-target fallback when none was resolved.
        let second_shim_eacces = "npm error code EACCES\n\
            npm error path /usr/local/bin/hq-auth-refresh";
        assert!(is_prefix_permission_failure(
            second_shim_eacces,
            Some("/usr/local")
        ));
        assert_eq!(
            classify_install_failure(Some(243), second_shim_eacces, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert!(is_global_prefix_permission_failure(
            Some(243),
            second_shim_eacces
        ));
        assert_eq!(
            classify_install_failure(Some(243), second_shim_eacces, None),
            InstallFailureKind::ExpectedPrefixPermission
        );

        // A bare EEXIST token in lifecycle build output must still NOT be treated
        // as a bin collision — only npm's structured code+path pair may arm force.
        let lifecycle_output = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/bin/hq-auth-refresh\n\
            script output contains EEXIST";
        assert!(!is_npm_bin_collision(lifecycle_output, Some("/usr/local")));
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                lifecycle_output,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn npm_bin_target_is_a_closed_path_free_enumeration() {
        // Each declared shim resolves to its own name, in every link form, so a
        // merged collision group can still say WHICH shim collided.
        for name in HQ_CLI_BIN_NAMES {
            for path in [
                format!("/usr/local/bin/{name}"),
                format!("/usr/local/{name}"),
                format!("C:/Users/alice/AppData/Roaming/npm/{name}.cmd"),
                format!("C:/Users/alice/AppData/Roaming/npm/{name}.ps1"),
            ] {
                let detail = format!("npm error code EEXIST\nnpm error path {path}");
                assert_eq!(npm_bin_target(&detail), name, "path {path}");
            }
        }
        // An unrelated path is `other`; no path line at all is `none`.
        assert_eq!(
            npm_bin_target("npm error code EEXIST\nnpm error path /usr/local/bin/hq-other"),
            "other"
        );
        assert_eq!(
            npm_bin_target(
                "npm error code ENOTDIR\n\
                 npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli"
            ),
            "other"
        );
        assert_eq!(npm_bin_target("npm error code EEXIST"), "none");
        // The value is ALWAYS one of the closed set and never a raw path — even
        // when the reported path itself sits under a sensitive directory.
        for detail in [
            "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
            "npm error code EEXIST\nnpm error path /Users/alice/secret/hq-auth-refresh.cmd",
            "npm error code ENOTDIR\nnpm error path /Users/alice/.npm/_cacache",
            "",
        ] {
            let target = npm_bin_target(detail);
            assert!(
                HQ_CLI_BIN_NAMES.contains(&target) || target == "other" || target == "none",
                "npm_bin_target returned an out-of-enum value: {target:?}"
            );
            assert!(
                !target.contains('/'),
                "npm_bin_target leaked a path: {target:?}"
            );
        }
    }

    #[test]
    fn third_party_lifecycle_has_its_own_group_but_owned_or_unknown_packages_stay_unexpected() {
        let third_party = "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/better-sqlite3";
        assert_eq!(
            classify_install_failure(Some(1), third_party, Some("/usr/local")),
            InstallFailureKind::UnexpectedLifecycle
        );

        let owned = "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_eq!(
            classify_install_failure(Some(1), owned, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );

        let unattributable =
            "npm error code 1\nnpm error command failed\nnpm error path /usr/local/build/work";
        assert_eq!(
            classify_install_failure(Some(1), unattributable, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn bin_and_lifecycle_failures_have_actionable_user_fallbacks() {
        let bin_collision = "npm error code EEXIST\nnpm error path /usr/local/bin/hq";
        let detail = install_failure_detail_with_final_attempt(
            Some(1),
            bin_collision,
            Some("/usr/local"),
            true,
        );
        assert!(detail.contains("stale shim"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
        assert!(detail.contains("/usr/local/bin/hq"), "got: {detail}");

        let lifecycle = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3";
        let detail = install_failure_detail(Some(1), lifecycle, Some("/usr/local"));
        assert!(detail.contains("dependency build step"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
    }

    #[test]
    fn exit_one_permission_failure_outside_the_selected_prefix_is_captured() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5";
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            install_failure_report(Some(1), detail, Some("/usr/local")),
            Some("[hq-cli-update] install failed (EACCES:unknown:npm-cache)".to_string()),
        );
    }

    #[test]
    fn npm_permission_tags_classify_cache_prefix_and_other_without_paths() {
        let cache_detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/tmp";
        let prefix_detail =
            "npm error code EACCES\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
        let other_detail = "npm error code EACCES\nnpm error path /tmp/unrelated-file";

        assert!(is_npm_permission_failure(cache_detail));
        assert_eq!(npm_failure_site(cache_detail, Some("/usr/local")), "cache");
        assert_eq!(
            npm_failure_site(prefix_detail, Some("/usr/local")),
            "prefix"
        );
        assert_eq!(npm_failure_site(other_detail, Some("/usr/local")), "other");
        assert_eq!(
            npm_failure_site("npm error network ETIMEDOUT", None),
            "other"
        );
    }

    #[test]
    fn npm_error_code_tags_are_allow_listed_and_path_free() {
        assert_eq!(
            npm_error_code("npm error code EACCES\nnpm error path /Users/alice/.npm/_cacache"),
            "EACCES"
        );
        assert_eq!(
            npm_error_code("npm error code ETARGET\nnpm error notarget No matching version found"),
            "ETARGET"
        );
        assert_eq!(npm_error_code("npm ERR! code ECONNRESET"), "ECONNRESET");
        assert_eq!(
            npm_error_code("application output: npm error code ETARGET"),
            "none"
        );
        assert_eq!(
            npm_error_code("npm error code ../../Users/alice/.npm/_cacache"),
            "unrecognized"
        );
        assert_eq!(
            npm_error_code("npm error path /Users/alice/.npm/_cacache"),
            "none"
        );
    }

    #[test]
    fn unix_exit_status_decodes_libuv_errno() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_eq!(npm_errno_from_exit_status(Some(243)), "EACCES");
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert_eq!(npm_errno_from_exit_status(Some(243)), "unknown");
        assert_eq!(npm_errno_from_exit_status(Some(128)), "unknown");
        assert_eq!(npm_errno_from_exit_status(Some(1)), "unknown");

        #[cfg(target_os = "macos")]
        assert_eq!(npm_errno_from_exit_status(Some(202)), "ECONNRESET");

        #[cfg(target_os = "linux")]
        assert_eq!(npm_errno_from_exit_status(Some(152)), "ECONNRESET");
    }

    #[test]
    fn transient_errno_exit_without_stderr_stays_unexpected() {
        #[cfg(target_os = "macos")]
        let econnreset_exit = 202;
        #[cfg(target_os = "linux")]
        let econnreset_exit = 152;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let econnreset_exit = 202;

        assert_eq!(
            classify_install_failure(Some(econnreset_exit), "", None),
            InstallFailureKind::Unexpected
        );
        assert!(install_failure_report(Some(econnreset_exit), "", None).is_some());
    }

    #[test]
    fn lifecycle_exit_colliding_with_errno_stays_loud() {
        #[cfg(target_os = "macos")]
        let econnreset_exit = 202;
        #[cfg(target_os = "linux")]
        let econnreset_exit = 152;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let econnreset_exit = 202;

        let detail = "npm error command failed\nnpm error command sh -c node postinstall.js";
        assert_eq!(
            classify_install_failure(Some(econnreset_exit), detail, None),
            InstallFailureKind::Unexpected
        );
        assert!(install_failure_report(Some(econnreset_exit), detail, None).is_some());
    }

    #[test]
    fn lifecycle_failure_with_named_transient_code_stays_loud() {
        #[cfg(target_os = "macos")]
        let econnreset_exit = 202;
        #[cfg(target_os = "linux")]
        let econnreset_exit = 152;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let econnreset_exit = 202;

        let detail = "npm error code ECONNRESET\n\
            npm error command failed\n\
            npm error command sh -c node postinstall.js";
        assert_eq!(
            classify_install_failure(Some(econnreset_exit), detail, None),
            InstallFailureKind::Unexpected
        );
        assert!(install_failure_report(Some(econnreset_exit), detail, None).is_some());
    }

    #[test]
    fn bare_eacces_exit_is_not_suppressed_by_the_errno_route() {
        assert_eq!(
            classify_install_failure(Some(243), "", None),
            InstallFailureKind::Unexpected
        );
        assert!(install_failure_report(Some(243), "", None).is_some());
    }

    #[test]
    fn transient_registry_failures_are_suppressed_but_keep_actionable_ui_text() {
        const ETARGET_STDERR: &str = "npm error code ETARGET\n\
            npm error notarget No matching version found for @aws-sdk/core@^3.977.4";
        const ECONNRESET_STDERR: &str = "npm error code ECONNRESET\n\
            npm error network request to https://registry.npmjs.org failed";

        for detail in [ETARGET_STDERR, ECONNRESET_STDERR] {
            assert_eq!(
                classify_install_failure(Some(1), detail, Some("/usr/local")),
                InstallFailureKind::ExpectedTransientRegistry,
                "{detail}"
            );
            assert_eq!(
                install_failure_report(Some(1), detail, Some("/usr/local")),
                None,
                "{detail}"
            );
            let fallback = install_failure_detail(Some(1), detail, Some("/usr/local"));
            assert!(fallback.contains("temporarily unavailable or was mid-publish"));
            assert!(fallback.contains("retry automatically"));
        }
    }

    #[test]
    fn lifecycle_output_with_transient_tokens_stays_unexpected_and_loud() {
        let detail = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c node postinstall.js\n\
            application output: ETARGET ECONNRESET npm error network";

        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        // The title carries the bounded grouping signature, not npm's exit
        // status (main's `install_failure_signature`); the point of this test is
        // that a lifecycle failure wearing transient tokens stays Unexpected
        // and still reports.
        assert_eq!(
            install_failure_report(Some(1), detail, Some("/usr/local")),
            Some("[hq-cli-update] install failed (none:unknown:none)".to_string())
        );
    }

    #[test]
    fn existing_failure_buckets_take_priority_over_transient_markers() {
        let prefix_permission_with_network_text = "npm error code EACCES\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us\n\
            npm error network ETIMEDOUT";
        assert_eq!(
            classify_install_failure(
                Some(1),
                prefix_permission_with_network_text,
                Some("/usr/local")
            ),
            InstallFailureKind::ExpectedPrefixPermission
        );

        let windows_eperm_with_network_text = "npm error code EPERM\n\
            npm error errno -4048\n\
            npm error network ECONNRESET";
        assert_eq!(
            classify_install_failure(Some(1), windows_eperm_with_network_text, None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
    }

    #[test]
    fn install_failure_report_skips_expected_windows_abort_codes() {
        // Windows exposes NTSTATUS as a signed i32. These are local process
        // interruptions/Node aborts, not an HQ updater incident, and should
        // remain actionable only through the returned UI error and local log.
        for code in [WINDOWS_CONTROL_C_EXIT, WINDOWS_ABORT_EXIT] {
            assert_eq!(
                classify_install_failure(Some(code), "", None),
                InstallFailureKind::ExpectedWindowsAbort
            );
            assert_eq!(install_failure_report(Some(code), "", None), None);
            assert_eq!(
                InstallFailureKind::ExpectedWindowsAbort.fingerprint_component(),
                "expected-windows-abort"
            );
        }
    }

    #[test]
    fn empty_windows_abort_output_gets_actionable_recovery_text() {
        let detail = install_failure_detail(Some(WINDOWS_ABORT_EXIT), "", None);
        assert!(detail.contains("Windows child process"));
        assert!(detail.contains("fresh terminal"));
    }

    // HQ-DESKTOP-3N: a Windows `EPERM` install failure (exit -4048, the libuv
    // errno) means npm could not replace the locked/in-use `hq` binary. It is a
    // local-machine condition with the copy-the-command fallback — NOT an
    // updater defect — so it must classify as expected and never page Sentry.
    #[test]
    fn windows_eperm_exit_code_is_an_expected_locked_binary_failure() {
        // The exact event behind HQ-DESKTOP-3N: install exited -4048 with no
        // useful stderr tail. Old behavior classified this as Unexpected and
        // captured "[hq-cli-update] install failed (…)" at Error level.
        assert_eq!(
            classify_install_failure(Some(-4048), "", None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
        // Suppressed from Sentry (the regression: this used to return Some(...)).
        assert_eq!(install_failure_report(Some(-4048), "", None), None);
        assert_eq!(
            InstallFailureKind::ExpectedWindowsLockedBinary.fingerprint_component(),
            "expected-windows-locked-binary"
        );
        // Empty stderr falls back to actionable locked-binary recovery text.
        let detail = install_failure_detail(Some(-4048), "", None);
        assert!(detail.contains("locked or in use"), "got: {detail}");
        assert!(detail.contains("retry"), "got: {detail}");
    }

    #[test]
    fn windows_eperm_in_stderr_is_also_treated_as_locked_binary() {
        // npm can bubble the same libuv EPERM through stderr (with a non-4048
        // process code) while renaming/unlinking the package it is replacing.
        const EPERM_STDERR: &str = "npm error code EPERM\n\
            npm error syscall unlink\n\
            npm error errno -4048\n\
            npm error EPERM: operation not permitted, unlink \
            'C:\\Users\\me\\AppData\\Roaming\\npm\\hq.cmd'";
        assert_eq!(
            classify_install_failure(Some(1), EPERM_STDERR, None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
        assert_eq!(install_failure_report(Some(1), EPERM_STDERR, None), None);
        assert!(is_windows_locked_binary_failure(Some(1), EPERM_STDERR));
    }

    #[test]
    fn locked_binary_detection_excludes_eacces_and_unrelated_failures() {
        // EACCES (the root-owned-prefix sudo case) is a DIFFERENT expected kind,
        // classified by prefix-permission — it must not read as locked-binary.
        assert!(!is_windows_locked_binary_failure(
            Some(243),
            REAL_EACCES_STDERR
        ));
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        // Genuine unexpected failures (network, ENOSPC) stay loud.
        assert!(!is_windows_locked_binary_failure(
            Some(1),
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT"
        ));
        assert_eq!(
            classify_install_failure(Some(1), "npm error network ETIMEDOUT", None),
            InstallFailureKind::Unexpected
        );
        assert!(!is_windows_locked_binary_failure(Some(1), ""));
    }

    /// HQ-DESKTOP-4G / 4H / 4J: npm's exit status must never be the grouping
    /// key. These pin the signature helper that replaced it.
    #[test]
    fn numeric_npm_error_codes_collapse_so_they_cannot_re_key_the_group() {
        // npm echoes a failed build script's own status as its `code`. That is
        // the exit status by another name, so it must not discriminate.
        assert_eq!(symbolic_npm_error_code("npm error code 1"), "none");
        assert_eq!(symbolic_npm_error_code("npm error code 7"), "none");
        assert_eq!(symbolic_npm_error_code("npm error code 236"), "none");
        // No code line at all is already "none".
        assert_eq!(symbolic_npm_error_code("npm error network reset"), "none");
        // Symbolic codes carry real classification and are preserved.
        assert_eq!(symbolic_npm_error_code("npm error code ENOTDIR"), "ENOTDIR");
        assert_eq!(symbolic_npm_error_code("npm error code EEXIST"), "EEXIST");
        assert_eq!(
            symbolic_npm_error_code("npm error code ELIFECYCLE"),
            "ELIFECYCLE"
        );
    }

    #[test]
    fn lifecycle_signature_keys_on_the_failing_dependency_not_the_exit_status() {
        let stderr = |package: &str, status: &str| {
            format!(
                "npm error code {status}\n\
                 npm error command failed\n\
                 npm error path /Users/alice/.npm-global/lib/node_modules/{package}"
            )
        };
        let prefix = Some("/Users/alice/.npm-global");

        // HQ-DESKTOP-4G (exit/code 1) and HQ-DESKTOP-4H (exit/code 7) are the
        // same better-sqlite3 build; one signature, therefore one issue.
        let four_g = stderr("better-sqlite3", "1");
        let four_h = stderr("better-sqlite3", "7");
        assert_eq!(
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
            "lifecycle:better-sqlite3:unknown"
        );
        assert_eq!(
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_h, prefix),
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
        );

        // The under-grouping half of the defect: a different dependency that
        // happens to share an exit status must not share the issue.
        let other = stderr("node-llama-cpp", "1");
        assert_ne!(
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &other, prefix),
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
        );
    }

    #[test]
    fn non_lifecycle_signatures_stay_distinct_across_code_syscall_and_path_shape() {
        let signature = |detail: &str, prefix: Option<&str>| {
            install_failure_signature(InstallFailureKind::Unexpected, detail, prefix)
        };

        // HQ-DESKTOP-4J: ENOTDIR/mkdir at the global install target.
        let enotdir = "npm error code ENOTDIR\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_eq!(
            signature(enotdir, None),
            "ENOTDIR:mkdir:global-lib-node-modules"
        );

        // Each axis moves the signature independently.
        let same_code_other_syscall = "npm error code ENOTDIR\n\
            npm error syscall open\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_ne!(
            signature(same_code_other_syscall, None),
            signature(enotdir, None)
        );

        let same_code_other_shape = "npm error code ENOTDIR\n\
            npm error syscall mkdir\n\
            npm error path /Users/alice/.npm/_cacache/content-v2";
        assert_ne!(
            signature(same_code_other_shape, None),
            signature(enotdir, None)
        );

        let other_code = "npm error code EEXIST\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_ne!(signature(other_code, None), signature(enotdir, None));
    }

    #[test]
    fn no_signature_carries_an_exit_status_or_a_filesystem_path() {
        let cases: [(InstallFailureKind, &str, Option<&str>); 4] = [
            (
                InstallFailureKind::UnexpectedLifecycle,
                "npm error code 236\n\
                 npm error command failed\n\
                 npm error path /Users/alice/.npm-global/lib/node_modules/better-sqlite3",
                Some("/Users/alice/.npm-global"),
            ),
            (
                InstallFailureKind::Unexpected,
                "npm error code ENOTDIR\n\
                 npm error syscall mkdir\n\
                 npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
                None,
            ),
            (
                InstallFailureKind::ExpectedBinCollision,
                "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
                Some("/usr/local"),
            ),
            (InstallFailureKind::Unexpected, "", None),
        ];

        for (kind, detail, prefix) in cases {
            let signature = install_failure_signature(kind, detail, prefix);
            for status in ["1", "7", "190", "202", "236", "243", "-4048"] {
                assert!(
                    !signature.contains(status),
                    "signature {signature:?} carries exit status {status}"
                );
            }
            for leak in ["Users", "alice", "usr", "lib/node_modules", "npm error"] {
                assert!(
                    !signature.contains(leak),
                    "signature {signature:?} leaked {leak:?}"
                );
            }
        }
    }

    /// A scoped third-party package is the one signature component that is not
    /// a closed enumeration. It stays safe because `npm_lifecycle_failure`
    /// already gates it through `is_safe_npm_package_name` — the same value the
    /// `npm_lifecycle_package` tag has always carried.
    #[test]
    fn lifecycle_signature_only_ever_carries_a_validated_package_name() {
        let scoped = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/@vendor/native-addon";
        assert_eq!(
            install_failure_signature(
                InstallFailureKind::UnexpectedLifecycle,
                scoped,
                Some("/Users/alice/.npm-global")
            ),
            "lifecycle:@vendor/native-addon:unknown"
        );
        assert!(is_safe_npm_package_name("@vendor/native-addon"));

        // A package name npm did not hand us in a validatable form falls back
        // to a fixed literal rather than to free text.
        let unattributable = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/project/package.json";
        assert_eq!(
            install_failure_signature(
                InstallFailureKind::UnexpectedLifecycle,
                unattributable,
                None
            ),
            "lifecycle:unrecognized:unknown"
        );
    }

    #[test]
    fn npm_lifecycle_cause_classifies_each_closed_value_from_real_failure_evidence() {
        // prebuild-install's own miss message (the better-sqlite3 case: the
        // machine's Node ABI has no published prebuild).
        let prebuild = "npm error code 1\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            prebuild-install warn install No prebuilt binaries found (target=23.0.0 runtime=node arch=arm64)";
        assert_eq!(npm_lifecycle_cause(prebuild), "prebuild-unavailable");

        // node-gyp fell through to a source build with no compiler present.
        let gyp = "npm error code 1\n\
            gyp ERR! build error\n\
            gyp ERR! stack Error: not found: make\n\
            gyp ERR! System Darwin";
        assert_eq!(npm_lifecycle_cause(gyp), "toolchain-missing");

        // Command Line Tools absent — the macOS non-developer case.
        let clt = "npm error code 1\n\
            xcode-select: note: no developer tools were found, requesting install";
        assert_eq!(npm_lifecycle_cause(clt), "toolchain-missing");

        // node-llama-cpp's cmake-js build with cmake missing.
        let cmake = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
        assert_eq!(npm_lifecycle_cause(cmake), "toolchain-missing");

        // A transport errno WHILE fetching a prebuild is a network cause.
        let network = "npm error code 1\n\
            prebuild-install http request to https://github.com failed\n\
            Error: connect ETIMEDOUT 140.82.113.3:443";
        assert_eq!(npm_lifecycle_cause(network), "network");

        // Disk exhaustion dominates.
        let disk = "npm error code 1\n\
            gyp ERR! stack Error: ENOSPC: no space left on device";
        assert_eq!(npm_lifecycle_cause(disk), "disk-space");

        // The command echo alone (no failure evidence) must NOT be classified:
        // naming node-gyp in `sh -c prebuild-install || node-gyp rebuild` does
        // not mean the compiler is missing.
        let command_echo_only = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild";
        assert_eq!(npm_lifecycle_cause(command_echo_only), "unknown");
        assert_eq!(npm_lifecycle_cause(""), "unknown");

        // node-gyp reached the compiler and failed on the CODE, not a missing
        // tool. `gyp ERR!` alone must NOT be read as toolchain-missing (it would
        // mis-advise installing tools the user already has)...
        let gyp_compile_error = "npm error code 1\n\
            gyp ERR! build error\n\
            gyp ERR! stack Error: `make` failed with exit code 2\n\
            ../src/binding.cpp:14:3: error: use of undeclared identifier 'foo'";
        assert_eq!(npm_lifecycle_cause(gyp_compile_error), "unknown");
        // ...and it must not override a prebuild-miss message either.
        let prebuild_then_gyp_compile_error = "npm error code 1\n\
            prebuild-install warn install No prebuilt binaries found\n\
            gyp ERR! build error\n\
            ../src/binding.cpp:14:3: error: use of undeclared identifier 'foo'";
        assert_eq!(
            npm_lifecycle_cause(prebuild_then_gyp_compile_error),
            "prebuild-unavailable"
        );
    }

    #[test]
    fn npm_lifecycle_cause_only_ever_returns_a_closed_constant_even_for_adversarial_input() {
        let allowed = [
            "prebuild-unavailable",
            "toolchain-missing",
            "network",
            "disk-space",
            "postinstall-script",
            "unknown",
        ];
        for adversarial in [
            "npm error code 1\nnpm error path /Users/attacker/../../etc/passwd\nlifecycle_cause=INJECTED node_version=99",
            "gyp ERR! /home/victim/secret token=abc123 No prebuilt binaries found",
            "ENOSPC ETIMEDOUT prebuild download https:// cmake not found xcode-select",
            "\u{0}\u{1}\u{2} No PREBUILT Binaries Found \u{7f}",
            "random build noise with no recognizable failure token",
            "npm error command failed\nnpm error command sh -c node ./dist/cli/cli.js postinstall\ntoken=abc /Users/victim/secret",
        ] {
            let cause = npm_lifecycle_cause(adversarial);
            assert!(
                allowed.contains(&cause),
                "cause {cause:?} is not one of the closed constants"
            );
        }
    }

    #[test]
    fn npm_lifecycle_cause_diagnoses_a_bare_postinstall_script_failure() {
        // node-llama-cpp's reported shape WITHOUT a "cannot find cmake" line: a
        // postinstall script that failed with no native-builder output. This is
        // exactly the case that used to degrade to `unknown`.
        let postinstall = "npm error code 1\n\
            npm error path /usr/local/lib/node_modules/node-llama-cpp\n\
            npm error command failed\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: postinstall failed while resolving the local binary";
        assert_eq!(npm_lifecycle_cause(postinstall), "postinstall-script");

        // But a "cannot find cmake" postinstall stays the more-actionable
        // toolchain-missing (checked first), never downgraded to postinstall.
        let cmake_missing = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
        assert_eq!(npm_lifecycle_cause(cmake_missing), "toolchain-missing");

        // A command echo naming node-gyp is NOT a postinstall script failure and
        // must stay `unknown` — the postinstall arm needs the postinstall token.
        let command_echo_only = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild";
        assert_eq!(npm_lifecycle_cause(command_echo_only), "unknown");
    }

    #[test]
    fn npm_lifecycle_cause_recognizes_cmake_js_prebuilt_miss_vocabulary() {
        // cmake-js reporting no matching prebuilt for this runtime is the same
        // "your Node has no prebuild" condition as prebuild-install's own miss.
        let cmake_js_miss = "npm error code 1\n\
            npm error path /usr/local/lib/node_modules/node-llama-cpp\n\
            npm error command failed\n\
            cmake-js WARN No prebuilt binary available for this platform, building from source";
        assert_eq!(npm_lifecycle_cause(cmake_js_miss), "prebuild-unavailable");

        // The guard is real: a bare "no prebuilt" without cmake-js context must
        // still go through the prebuild-install message path, and "cmake not
        // found" (no cmake-js miss vocabulary) must NOT become prebuild-unavailable.
        let cmake_not_found = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
        assert_eq!(npm_lifecycle_cause(cmake_not_found), "toolchain-missing");
    }

    #[test]
    fn npm_lifecycle_builder_derives_only_from_builder_output_never_the_command_echo() {
        // node-gyp's own leveled log prefix.
        assert_eq!(
            npm_lifecycle_builder(
                "npm error command failed\ngyp ERR! stack Error: not found: make"
            ),
            "node-gyp"
        );
        // node-gyp wins over a preceding prebuild miss — it is the builder that
        // actually ran and failed.
        assert_eq!(
            npm_lifecycle_builder(
                "prebuild-install warn install No prebuilt binaries found\ngyp ERR! build error"
            ),
            "node-gyp"
        );
        // cmake-js / CMake's own build output.
        assert_eq!(
            npm_lifecycle_builder(
                "npm error command failed\nCMake Error: could not configure the project"
            ),
            "cmake-js"
        );
        // prebuild-install's own leveled log / miss message.
        assert_eq!(
            npm_lifecycle_builder(
                "prebuild-install warn install No prebuilt binaries found (target=23.0.0)"
            ),
            "prebuild-install"
        );
        // A lifecycle failure with NO native-builder output is the postinstall
        // residual.
        assert_eq!(
            npm_lifecycle_builder(
                "npm error command failed\nnpm error command sh -c node ./dist/cli/cli.js postinstall"
            ),
            "postinstall-script"
        );
        // The command echo alone names node-gyp/prebuild-install but proves
        // neither ran AND names no lifecycle stage, so it is attributed to no
        // builder at all — `unknown`, never the postinstall residual (which would
        // corrupt the builder telemetry this change makes reliable).
        assert_eq!(
            npm_lifecycle_builder(
                "npm error command failed\nnpm error command sh -c prebuild-install || node-gyp rebuild"
            ),
            "unknown"
        );
        // No lifecycle marker at all -> unknown builder.
        assert_eq!(npm_lifecycle_builder("npm error code ENOTDIR"), "unknown");
        assert_eq!(npm_lifecycle_builder(""), "unknown");
    }

    #[test]
    fn npm_lifecycle_builder_requires_explicit_postinstall_stage_evidence() {
        // node-llama-cpp's reported shape: a postinstall entrypoint command with no
        // native-builder output. The `postinstall` token is present, so it is the
        // postinstall residual.
        assert_eq!(
            npm_lifecycle_builder(
                "npm error code 1\n\
                 npm error command failed\n\
                 npm error command sh -c node ./dist/cli/cli.js postinstall"
            ),
            "postinstall-script"
        );
        // npm's explicit stage attribution line also counts (older-npm shape,
        // which carries the ELIFECYCLE marker alongside the stage line).
        assert_eq!(
            npm_lifecycle_builder(
                "npm error code ELIFECYCLE\n\
                 npm error Failed at the node-llama-cpp@3.18.1 postinstall script."
            ),
            "postinstall-script"
        );
        // The truncated better-sqlite3 echo carries the lifecycle marker but names
        // no stage and shows no builder output. It MUST stay `unknown` — this is
        // the P2 residual that used to mis-tag it postinstall-script.
        assert_eq!(
            npm_lifecycle_builder(
                "npm error command failed\n\
                 npm error command sh -c prebuild-install || node-gyp rebuild"
            ),
            "unknown"
        );
        // A lifecycle marker with neither builder output nor a postinstall token
        // stays `unknown` too.
        assert_eq!(
            npm_lifecycle_builder("npm error code ELIFECYCLE\nnpm error errno 1"),
            "unknown"
        );
    }

    #[test]
    fn npm_lifecycle_builder_only_ever_returns_a_closed_constant() {
        let allowed = [
            "prebuild-install",
            "node-gyp",
            "cmake-js",
            "postinstall-script",
            "unknown",
        ];
        for adversarial in [
            "gyp ERR! /home/victim/secret token=abc123",
            "cmake error /Users/attacker/../../etc/passwd",
            "npm error command failed\nnpm error command sh -c node ./x.js postinstall\n\u{0}\u{7f}",
            "random build noise with no recognizable builder token",
            "",
        ] {
            let builder = npm_lifecycle_builder(adversarial);
            assert!(
                allowed.contains(&builder),
                "builder {builder:?} is not one of the closed constants"
            );
        }
    }

    #[test]
    fn sanitized_version_token_accepts_only_bounded_numeric_tokens() {
        assert_eq!(sanitized_version_token(Some("22.17.0")), "22.17.0");
        assert_eq!(sanitized_version_token(Some("v22.17.0")), "22.17.0");
        assert_eq!(sanitized_version_token(Some(" 127 ")), "127");
        // Anything non-numeric, empty, absent, or over-long collapses to unknown
        // so no caller-supplied free text can reach Sentry through the tag.
        assert_eq!(sanitized_version_token(None), "unknown");
        assert_eq!(sanitized_version_token(Some("")), "unknown");
        assert_eq!(sanitized_version_token(Some("22.17.0-nightly")), "unknown");
        assert_eq!(sanitized_version_token(Some("/Users/alice")), "unknown");
        assert_eq!(sanitized_version_token(Some("22; rm -rf")), "unknown");
        assert_eq!(
            sanitized_version_token(Some("1234567890123456789012345")),
            "unknown"
        );
        assert_eq!(sanitized_version_token(Some("v")), "unknown");
    }

    #[test]
    fn npm_toolchain_source_tags_are_closed() {
        assert_eq!(NpmToolchainSource::Managed.tag_value(), "managed");
        assert_eq!(NpmToolchainSource::UserPath.tag_value(), "user-path");
        assert_eq!(NpmToolchainSource::Unknown.tag_value(), "unknown");
        assert_eq!(NpmToolchainSource::default(), NpmToolchainSource::Unknown);
    }

    #[test]
    fn install_failure_episode_key_is_only_minted_for_third_party_lifecycle_failures() {
        let better_sqlite3 = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
        assert_eq!(
            install_failure_episode_key("5.97.0", better_sqlite3).as_deref(),
            Some("5.97.0|better-sqlite3|prebuild-unavailable")
        );

        // An owned package, an unattributable build, and a plain non-lifecycle
        // failure never get a key — they keep paging every time.
        let owned = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_eq!(install_failure_episode_key("5.97.0", owned), None);
        assert_eq!(
            install_failure_episode_key("5.97.0", "npm error code ENOTDIR"),
            None
        );
    }

    #[test]
    fn partial_install_scope_from_npm_path_is_the_at_indigoai_us_scope_or_nothing() {
        let path_detail = |p: &str| format!("npm error path {p}");

        // The scope dir itself, the `hq-cli` package dir, and a `.hq-cli-*`
        // staging dir all resolve to the SAME `@indigoai-us` scope — the exact
        // directory the prefix-derived remedy targets.
        let scope = "/Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global/lib/node_modules/@indigoai-us";
        for suffix in ["", "/hq-cli", "/.hq-cli-0DY3ww6z"] {
            assert_eq!(
                partial_install_scope_from_npm_path(&path_detail(&format!("{scope}{suffix}")))
                    .as_deref(),
                Some(scope),
                "suffix {suffix:?}"
            );
        }

        // The real HQ-DESKTOP-5B stderr (path + dest lines): npm_path_value reads
        // the `path` line, which truncates to the scope dir.
        let real = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli\n\
            npm error dest /usr/local/lib/node_modules/@indigoai-us/.hq-cli-0DY3ww6z\n\
            npm error ENOTEMPTY: directory not empty, rename";
        assert_eq!(
            partial_install_scope_from_npm_path(real).as_deref(),
            Some("/usr/local/lib/node_modules/@indigoai-us")
        );

        // A Windows drive path (backslashes already normalised by npm_path_value)
        // resolves too, keeping the drive root.
        assert_eq!(
            partial_install_scope_from_npm_path(&path_detail(
                "C:\\Users\\mike\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli"
            ))
            .as_deref(),
            Some("C:/Users/mike/AppData/Roaming/npm/node_modules/@indigoai-us")
        );

        // Every ambiguity fails closed to None — a path npm reported that fails the
        // component check yields no scope, so no deletion and no retry happen.
        for adversarial in [
            // Relative path — cannot anchor a deletion.
            "node_modules/@indigoai-us/hq-cli",
            // No node_modules component at all.
            "/usr/local/lib/@indigoai-us/hq-cli",
            // A merely-substring match, not an exact component.
            "/usr/local/lib/node_modules/@indigoai-usx/hq-cli",
            // A bare filesystem root.
            "/",
            // `@indigoai-us` as a plain file basename whose parent is not
            // node_modules.
            "/Users/mike/@indigoai-us",
            // The marker is present but the parent component is wrong.
            "/usr/local/node_modules_backup/@indigoai-us/hq-cli",
            // A valid scope pair, but it leads to an UNRELATED package, not hq-cli
            // or its staging dir — never our debris, so no scope.
            "/usr/local/lib/node_modules/@indigoai-us/some-other-pkg",
        ] {
            assert_eq!(
                partial_install_scope_from_npm_path(&path_detail(adversarial)),
                None,
                "adversarial: {adversarial}"
            );
        }

        // A NESTED path with two `node_modules/@indigoai-us` pairs resolves to the
        // INNER one that actually leads to hq-cli — never the unrelated outer scope.
        assert_eq!(
            partial_install_scope_from_npm_path(&path_detail(
                "/work/node_modules/@indigoai-us/toolchain/lib/node_modules/@indigoai-us/hq-cli"
            ))
            .as_deref(),
            Some("/work/node_modules/@indigoai-us/toolchain/lib/node_modules/@indigoai-us")
        );

        // Genuinely AMBIGUOUS — two pairs each lead to hq-cli — fails closed to None
        // so an ambiguous path never widens the blast radius.
        assert_eq!(
            partial_install_scope_from_npm_path(&path_detail(
                "/a/node_modules/@indigoai-us/hq-cli/x/node_modules/@indigoai-us/hq-cli"
            )),
            None
        );

        // No `npm error path` line at all yields nothing.
        assert_eq!(
            partial_install_scope_from_npm_path("npm error code ENOTEMPTY"),
            None
        );
    }

    #[test]
    fn unexpected_install_failure_episode_key_pages_once_per_version_and_signature() {
        // The HQ-DESKTOP-5B ENOTEMPTY wedge with no resolved prefix — the exact
        // shape 61/61 events took. It is a plain `Unexpected` failure, so it now
        // mints the bounded repeat-guard key from its closed-enumeration signature.
        let enotempty = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli\n\
            npm error dest /usr/local/lib/node_modules/@indigoai-us/.hq-cli-0DY3ww6z";
        let latest = "5.103.17";
        // The recorded 5B environment: node 22.23.1, npm 10.9.8, user-path.
        let env = InstallEnvironment {
            node_version: Some("22.23.1".to_string()),
            node_abi: Some("127".to_string()),
            npm_version: Some("10.9.8".to_string()),
            toolchain_source: NpmToolchainSource::UserPath,
            managed_toolchain_retry: false,
        };
        let key =
            install_failure_episode_key_with_environment(Some(190), enotempty, None, false, latest, &env)
                .expect("an unexpected ENOTEMPTY wedge mints an episode key");
        assert_eq!(key, "5.103.17|unexpected|ENOTEMPTY|rename|global-lib-node-modules");

        // A second identical report under the same target version is suppressed —
        // the noise bound the fix exists to add.
        assert!(install_failure_episode_blocked(&[key.clone()], &key));

        // A newer published CLI version mints a DISTINCT key, so the same wedge
        // pages a first occurrence again and the bound never hides it.
        let bumped = install_failure_episode_key_with_environment(
            Some(190),
            enotempty,
            None,
            false,
            "5.103.18",
            &env,
        );
        assert_eq!(
            bumped.as_deref(),
            Some("5.103.18|unexpected|ENOTEMPTY|rename|global-lib-node-modules")
        );
        assert!(!install_failure_episode_blocked(&[key.clone()], bumped.as_deref().unwrap()));

        // A different signature (here the syscall) is a different key.
        let different_syscall = "npm error code ENOTEMPTY\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        let other = install_failure_episode_key_with_environment(
            Some(190),
            different_syscall,
            None,
            false,
            latest,
            &env,
        );
        assert_eq!(
            other.as_deref(),
            Some("5.103.17|unexpected|ENOTEMPTY|mkdir|global-lib-node-modules")
        );
        assert!(!install_failure_episode_blocked(&[key.clone()], other.as_deref().unwrap()));

        // Managed provenance mints a distinct key, so a managed-retry event never
        // collides with its user-path predecessor.
        let mut managed_env = env.clone();
        managed_env.managed_toolchain_retry = true;
        let managed = install_failure_episode_key_with_environment(
            Some(190),
            enotempty,
            None,
            false,
            latest,
            &managed_env,
        );
        assert_eq!(
            managed.as_deref(),
            Some("5.103.17|unexpected|ENOTEMPTY|rename|global-lib-node-modules|managed")
        );

        // The pre-existing shapes are unchanged: a third-party lifecycle failure
        // still mints its package/cause key, and an expected transient failure
        // (now including EIDLETIMEOUT) still mints nothing.
        let lifecycle = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(1),
                lifecycle,
                None,
                false,
                latest,
                &InstallEnvironment::default(),
            )
            .as_deref(),
            Some("5.103.17|better-sqlite3|prebuild-unavailable")
        );
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(1),
                "npm error code EIDLETIMEOUT",
                None,
                false,
                latest,
                &InstallEnvironment::default(),
            ),
            None
        );

        // A fully SHAPELESS unexpected failure (no npm code / syscall / path — the
        // `none:unknown:none` signature) is deliberately NOT bounded: it mints no
        // key and keeps paging every check, so a different newly introduced failure
        // sharing that empty signature is never hidden behind an earlier one.
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(1),
                "SyntaxError: Unexpected token export",
                None,
                false,
                latest,
                &InstallEnvironment::default(),
            ),
            None
        );
    }

    #[test]
    fn managed_toolchain_retry_is_a_distinct_repeat_guard_episode() {
        let better_sqlite3 = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";

        // Same (version, package, cause), but the managed retry carries a DISTINCT
        // key so its provenance-bearing event can never collide with the user-path
        // failure that preceded it.
        let user_key = install_failure_episode_key_with_provenance("5.97.0", better_sqlite3, false);
        let managed_key =
            install_failure_episode_key_with_provenance("5.97.0", better_sqlite3, true);
        assert_eq!(
            user_key.as_deref(),
            Some("5.97.0|better-sqlite3|prebuild-unavailable")
        );
        assert_eq!(
            managed_key.as_deref(),
            Some("5.97.0|better-sqlite3|prebuild-unavailable|managed")
        );
        assert_ne!(user_key, managed_key);

        // A prior user-path report for this (version, package, cause) must NOT
        // suppress the managed retry — otherwise the managed provenance the retry
        // exists to emit is silently dropped.
        let reported = [user_key.clone().unwrap()];
        assert!(install_failure_episode_blocked(
            &reported,
            user_key.as_deref().unwrap()
        ));
        assert!(!install_failure_episode_blocked(
            &reported,
            managed_key.as_deref().unwrap()
        ));

        // A REPEATED managed failure is still suppressed — the guard keeps working
        // within the managed provenance, so a permanent managed-build failure stops
        // re-paging on every scheduled check.
        let after =
            install_failure_episode_record(&reported, managed_key.as_deref().unwrap(), "5.97.0");
        assert!(after.contains(user_key.as_ref().unwrap()));
        assert!(install_failure_episode_blocked(
            &after,
            managed_key.as_deref().unwrap()
        ));

        // A non-lifecycle failure gets no key regardless of provenance — it keeps
        // paging every time, whichever toolchain ran it.
        assert_eq!(
            install_failure_episode_key_with_provenance("5.97.0", "npm error code ENOTDIR", true),
            None
        );
    }

    #[test]
    fn install_failure_episode_blocked_suppresses_only_a_key_in_the_reported_set() {
        let reported = [
            "5.97.0|better-sqlite3|prebuild-unavailable".to_string(),
            "5.97.0|node-llama-cpp|toolchain-missing".to_string(),
        ];
        // Any key already in the set is suppressed...
        assert!(install_failure_episode_blocked(
            &reported,
            "5.97.0|better-sqlite3|prebuild-unavailable"
        ));
        assert!(install_failure_episode_blocked(
            &reported,
            "5.97.0|node-llama-cpp|toolchain-missing"
        ));
        // ...while a changed version, package, or cause is not.
        assert!(!install_failure_episode_blocked(
            &reported,
            "5.98.0|better-sqlite3|prebuild-unavailable"
        ));
        assert!(!install_failure_episode_blocked(
            &reported,
            "5.97.0|better-sqlite3|toolchain-missing"
        ));
        // An empty (unreadable) marker → nothing blocked → fail-closed (report).
        assert!(!install_failure_episode_blocked(
            &[],
            "5.97.0|better-sqlite3|prebuild-unavailable"
        ));
    }

    #[test]
    fn install_failure_episode_record_retains_every_current_version_key() {
        let a = "5.97.0|better-sqlite3|prebuild-unavailable".to_string();
        let b = "5.97.0|node-llama-cpp|toolchain-missing".to_string();

        // Recording A then B keeps BOTH for the version, so an A/B/A interleave
        // (the exact failure mode of a single-slot marker) stays suppressed.
        let after_a = install_failure_episode_record(&[], &a, "5.97.0");
        assert_eq!(after_a, vec![a.clone()]);
        let after_b = install_failure_episode_record(&after_a, &b, "5.97.0");
        assert!(after_b.contains(&a) && after_b.contains(&b));
        assert!(install_failure_episode_blocked(&after_b, &a));
        // Re-recording A does not duplicate it.
        let after_aba = install_failure_episode_record(&after_b, &a, "5.97.0");
        assert_eq!(
            after_aba.iter().filter(|k| **k == a).count(),
            1,
            "a re-reported key must not be duplicated"
        );

        // A new target version resets the set: prior-version keys are dropped.
        let bumped = install_failure_episode_record(
            &after_b,
            "5.98.0|better-sqlite3|prebuild-unavailable",
            "5.98.0",
        );
        assert_eq!(bumped, vec!["5.98.0|better-sqlite3|prebuild-unavailable"]);

        // The set is bounded to MAX_INSTALL_FAILURE_EPISODE_KEYS.
        let mut acc: Vec<String> = Vec::new();
        for i in 0..(MAX_INSTALL_FAILURE_EPISODE_KEYS + 5) {
            acc = install_failure_episode_record(&acc, &format!("9.0.0|pkg{i}|unknown"), "9.0.0");
        }
        assert_eq!(acc.len(), MAX_INSTALL_FAILURE_EPISODE_KEYS);
        assert!(
            acc.iter().all(|k| k.starts_with("9.0.0|")),
            "bounded set must only hold current-version keys"
        );
    }

    #[test]
    fn cause_specific_install_failure_detail_stays_actionable_with_the_copyable_command() {
        let base = |cause_body: &str| {
            format!(
                "npm error code 1\n\
                 npm error command failed\n\
                 npm error path /usr/local/lib/node_modules/better-sqlite3\n\
                 {cause_body}"
            )
        };
        let toolchain = base("gyp ERR! stack Error: not found: make");
        let detail = install_failure_detail(Some(1), &toolchain, Some("/usr/local"));
        assert!(detail.contains("xcode-select --install"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");

        let prebuild = base("prebuild-install warn install No prebuilt binaries found");
        let detail = install_failure_detail(Some(1), &prebuild, Some("/usr/local"));
        assert!(detail.contains("version 22"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");

        let network = base("prebuild-install download https:// failed: connect ETIMEDOUT");
        let detail = install_failure_detail(Some(1), &network, Some("/usr/local"));
        assert!(detail.contains("could not be downloaded"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");

        let disk = base("gyp ERR! ENOSPC: no space left on device");
        let detail = install_failure_detail(Some(1), &disk, Some("/usr/local"));
        assert!(detail.contains("disk space"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");

        // The unclassified case keeps the original generic-but-actionable copy.
        let unknown = base("some build noise with no recognizable cause");
        let detail = install_failure_detail(Some(1), &unknown, Some("/usr/local"));
        assert!(detail.contains("dependency build step"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
    }

    #[test]
    fn lifecycle_signature_splits_a_prebuild_gap_from_a_missing_compiler() {
        let path = "npm error path /usr/local/lib/node_modules/better-sqlite3";
        let prebuild = format!(
            "npm error code 1\nnpm error command failed\n{path}\nprebuild-install warn install No prebuilt binaries found"
        );
        let toolchain = format!(
            "npm error code 1\nnpm error command failed\n{path}\ngyp ERR! stack Error: not found: make"
        );
        let prefix = Some("/usr/local");
        let prebuild_sig =
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &prebuild, prefix);
        let toolchain_sig =
            install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &toolchain, prefix);
        assert_eq!(
            prebuild_sig,
            "lifecycle:better-sqlite3:prebuild-unavailable"
        );
        assert_eq!(toolchain_sig, "lifecycle:better-sqlite3:toolchain-missing");
        assert_ne!(
            prebuild_sig, toolchain_sig,
            "a prebuild gap and a missing compiler must not share one issue"
        );
    }

    #[test]
    fn install_failure_report_captures_genuine_failures() {
        // A real, unexpected failure stays loud — `Some(message)` drives the
        // Error-level capture.
        assert_eq!(
            install_failure_report(Some(1), "npm error network ETIMEDOUT", None),
            Some("[hq-cli-update] install failed (none:unknown:none)".to_string()),
        );
        // Killed by signal (no exit code) still reports — and now lands in the
        // same group as the exit-1 run, because the cause is the same.
        assert_eq!(
            install_failure_report(None, "npm error network ETIMEDOUT", None),
            install_failure_report(Some(1), "npm error network ETIMEDOUT", None),
        );
        assert_eq!(
            classify_install_failure(Some(1), "npm error network ETIMEDOUT", None),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            InstallFailureKind::Unexpected.fingerprint_component(),
            "unexpected"
        );
    }

    #[test]
    fn dismissal_suppresses_same_and_older_versions() {
        // Nothing dismissed → always show.
        assert!(!suppress_for_dismissal("5.38.2", None));
        // Dismissed the exact current version → stay hidden.
        assert!(suppress_for_dismissal("5.38.2", Some("5.38.2")));
        // A version older than what was dismissed → also hidden (can't regress
        // the user back into a notice for something they already moved past).
        assert!(suppress_for_dismissal("5.38.1", Some("5.38.2")));
    }

    #[test]
    fn dismissal_clears_when_a_newer_version_appears() {
        // The headline example: dismissing 5.38.x stays dismissed until 5.39.
        assert!(!suppress_for_dismissal("5.39.0", Some("5.38.2")));
        // A patch bump past the dismissed version re-surfaces once (a freshly
        // published fix is exactly what stale users need to see) — still
        // dismissible afterwards.
        assert!(!suppress_for_dismissal("5.38.3", Some("5.38.2")));
        // Numeric, not lexical: 5.41 > 5.9 even though '4' < '9'.
        assert!(!suppress_for_dismissal("5.41.0", Some("5.9.0")));
    }

    #[test]
    fn cmp_semver_missing_segments_default_to_zero() {
        // Don't panic on weird inputs — under-report rather than crash.
        assert_eq!(cmp_semver("5", "5.0.0"), Ordering::Equal);
        assert_eq!(cmp_semver("", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("not-a-version", "0.0.0"), Ordering::Equal);
    }

    #[test]
    fn version_if_hq_cli_requires_matching_name() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // Wrong name → None, even with a version present.
        let wrong = tmp.path().join("wrong.json");
        std::fs::File::create(&wrong)
            .unwrap()
            .write_all(br#"{"name":"left-pad","version":"9.9.9"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&wrong), None);
        // Right name → version.
        let right = tmp.path().join("package.json");
        std::fs::File::create(&right)
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.12.3"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&right), Some("5.12.3".to_string()));
    }

    /// Direct regression test for the prefix-mismatch bug: an `hq` symlink in
    /// one prefix pointing into the package tree in another must still resolve
    /// the installed version, with no dependence on `npm root -g`.
    #[test]
    #[cfg(unix)]
    fn version_from_hq_binary_follows_symlink() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // npm-global-style tree:
        //   <tmp>/lib/node_modules/@indigoai-us/hq-cli/{package.json, bin/hq.js}
        //   <tmp>/bin/hq -> .../hq-cli/bin/hq.js
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("bin")).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.40.1"}"#)
            .unwrap();
        let real_bin = pkg_dir.join("bin/hq.js");
        std::fs::File::create(&real_bin)
            .unwrap()
            .write_all(b"#!/usr/bin/env node\n")
            .unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let link = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real_bin, &link).unwrap();

        assert_eq!(version_from_hq_binary(&link), Some("5.40.1".to_string()));
    }

    /// A bare `hq` (binary not found, resolver returned the literal name) must
    /// not be canonicalized into a bogus version.
    #[test]
    fn version_from_hq_binary_missing_returns_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(
            version_from_hq_binary(&tmp.path().join("does-not-exist/hq")),
            None
        );
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_version_result_keeps_probe_failures_distinct() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hq = tmp.path().join("bin/hq");
        let npm = tmp.path().join("bin/npm");
        std::fs::create_dir_all(hq.parent().unwrap()).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 9\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert!(result.hq_installed);
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NonzeroExit);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NonzeroExit);
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix,
        );
        assert!(should_report_unreadable_version(&result));
    }

    #[test]
    fn absent_hq_stays_quiet_even_when_every_probe_fails() {
        let result = probe_local_version(None, None, "");

        assert_eq!(result.local, None);
        assert!(!result.hq_installed);
        assert_eq!(result.probes, LocalVersionProbeDiagnostics::not_attempted());
        assert!(!should_report_unreadable_version(&result));
    }

    #[test]
    #[cfg(unix)]
    fn successful_binary_anchor_still_short_circuits_npm_root_and_hq_version() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("bin")).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.77.7"}"#,
        )
        .unwrap();
        let real_hq = pkg_dir.join("bin/hq.js");
        write_executable(&real_hq, "#!/bin/sh\nexit 99\n");
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let hq = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real_hq, &hq).unwrap();

        let result = probe_local_version(Some(&hq), None, "");

        assert_eq!(result.local.as_deref(), Some("5.77.7"));
        assert_eq!(result.probes.binary_anchor, VersionProbeOutcome::Succeeded);
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NotAttempted);
    }

    #[test]
    #[cfg(unix)]
    fn npm_root_fallback_preserves_precedence_over_hq_version() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let hq = bin_dir.join("hq");
        let npm = bin_dir.join("npm");
        let npm_root = tmp.path().join("npm-root");
        let package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(
            &package,
            br#"{"name":"@indigoai-us/hq-cli","version":"5.77.8"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 99\n");
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local.as_deref(), Some("5.77.8"));
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::Succeeded);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NotAttempted);
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_fallback_runs_only_after_earlier_probes_fail() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let hq = bin_dir.join("hq");
        let npm = bin_dir.join("npm");
        std::fs::create_dir_all(&bin_dir).unwrap();
        write_executable(&hq, "#!/bin/sh\nprintf 'v5.77.9\\n'\n");
        write_executable(&npm, "#!/bin/sh\nexit 7\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local.as_deref(), Some("5.77.9"));
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NonzeroExit);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_uses_the_injected_child_path_for_node_shebang_resolution() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let interpreter_dir = tmp.path().join("fixture-interpreters");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        std::fs::create_dir_all(&interpreter_dir).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(
            &interpreter_dir.join("hq-fixture-node"),
            "#!/bin/sh\nprintf 'v5.88.1\\n'\n",
        );
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(
            Some(&hq),
            Some(npm.to_str().unwrap()),
            interpreter_dir.to_str().unwrap(),
        );

        assert_eq!(result.local.as_deref(), Some("5.88.1"));
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
        assert!(!should_report_unreadable_version(&result));
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_reports_interpreter_not_found_when_the_shebang_interpreter_is_absent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert_eq!(
            result.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert!(should_report_unreadable_version(&result));
    }

    // ---- HQ-DESKTOP-3P: managed-Node interpreter recovery ------------------

    /// HQ-DESKTOP-3P reproduction: a resolved `hq` shim in an npm-prefix `bin`
    /// dir whose `env node` interpreter is not on the child PATH, with no npm
    /// and no managed Node, produces the EXACT production quadruple and reports.
    /// Injecting `managed = None` keeps this identical to the base commit's
    /// behaviour, so it anchors the byte-identical field set the recovery test
    /// then flips.
    #[test]
    #[cfg(unix)]
    fn unreadable_version_reproduces_the_production_quadruple_and_reports() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let hq = bin.join("hq");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env node\n");

        let result =
            probe_local_version_with_managed(Some(&hq), ResolvedProgramKind::Exe, None, None, "");

        assert_eq!(result.local, None);
        assert!(result.hq_installed);
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
        assert_eq!(
            result.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix
        );
        assert_eq!(result.probes.resolved_program_kind, ResolvedProgramKind::Exe);
        assert!(should_report_unreadable_version(&result));
    }

    /// HQ-DESKTOP-3P fix: with HQ's managed Node present, the same otherwise
    /// unreadable shim reads its version by retrying with the managed Node's bin
    /// dir on the child PATH — so NO unreadable-version event is emitted. The
    /// four non-`hq_version` fields keep their production meaning; only
    /// `hq_version` flips to Succeeded.
    #[test]
    #[cfg(unix)]
    fn recovers_version_through_managed_node_when_env_node_is_absent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let hq = bin.join("hq");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env node\n");

        // Managed Node: a `node` in its own bin dir that answers `--version`.
        let managed_bin = tmp.path().join("managed/node/bin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        let node = managed_bin.join("node");
        write_executable(&node, "#!/bin/sh\nprintf 'v5.99.0\\n'\n");
        let managed = crate::toolchain::ManagedRuntime::Present { node };

        let result = probe_local_version_with_managed(
            Some(&hq),
            ResolvedProgramKind::Exe,
            Some(&managed),
            None,
            "",
        );

        assert_eq!(result.local.as_deref(), Some("5.99.0"));
        assert!(!should_report_unreadable_version(&result));
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
        assert_eq!(result.probes.managed_runtime, ManagedRuntimeState::Present);
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::RecoveredWithManagedNode
        );
        // The four original fields keep their production meaning.
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix
        );
        assert_eq!(result.probes.resolved_program_kind, ResolvedProgramKind::Exe);
    }

    /// The direct `<node> <program>` retry recovers when the shim names node but
    /// the managed Node executable is NOT itself named `node` — so `env node` on
    /// the widened PATH still misses and only the direct invocation works. This
    /// isolates the second retry from the first.
    #[test]
    #[cfg(unix)]
    fn recovers_via_direct_managed_node_when_env_node_lookup_still_misses() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let hq = bin.join("hq");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env node\n");

        let managed_bin = tmp.path().join("managed/node/bin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        let node = managed_bin.join("hqnode");
        write_executable(&node, "#!/bin/sh\nprintf 'v6.0.1\\n'\n");
        let managed = crate::toolchain::ManagedRuntime::Present { node };

        let result = probe_local_version_with_managed(
            Some(&hq),
            ResolvedProgramKind::Exe,
            Some(&managed),
            None,
            "",
        );

        assert_eq!(result.local.as_deref(), Some("6.0.1"));
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::RecoveredWithManagedNode
        );
        assert!(!should_report_unreadable_version(&result));
    }

    /// With `ManagedRuntime::NotProvisioned` the outcome stays
    /// `InterpreterNotFound`, the recovery is `ManagedNodeAbsent`, and the event
    /// STILL reports — no silent swallow of the unreadable-version signal.
    #[test]
    #[cfg(unix)]
    fn unprovisioned_managed_node_keeps_reporting_and_names_the_gap() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let hq = bin.join("hq");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env node\n");

        let managed = crate::toolchain::ManagedRuntime::NotProvisioned;
        let result = probe_local_version_with_managed(
            Some(&hq),
            ResolvedProgramKind::Exe,
            Some(&managed),
            None,
            "",
        );

        assert_eq!(result.local, None);
        assert_eq!(
            result.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert_eq!(
            result.probes.managed_runtime,
            ManagedRuntimeState::NotProvisioned
        );
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::ManagedNodeAbsent
        );
        assert!(should_report_unreadable_version(&result));
    }

    /// The direct `<node> <program>` invocation is never attempted when the
    /// resolved program has no node-naming shebang; only the widened-PATH retry
    /// runs. A managed Node that WOULD answer `--version` makes a `StillUnreadable`
    /// outcome proof that the direct invocation did not fire.
    #[test]
    #[cfg(unix)]
    fn direct_managed_node_is_skipped_when_the_shim_has_no_node_shebang() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let hq = bin.join("hq");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");

        let managed_bin = tmp.path().join("managed/node/bin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        let node = managed_bin.join("node");
        write_executable(&node, "#!/bin/sh\nprintf 'v9.9.9\\n'\n");
        let managed = crate::toolchain::ManagedRuntime::Present { node };

        let result = probe_local_version_with_managed(
            Some(&hq),
            ResolvedProgramKind::Exe,
            Some(&managed),
            None,
            "",
        );

        assert_eq!(
            result.local, None,
            "a non-node shim must never be run under node"
        );
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::StillUnreadable
        );
        assert!(should_report_unreadable_version(&result));
    }

    /// A resolved-but-absent program (`SpawnProgramMissing`) routes through the
    /// same recovery gate, but its reported spawn outcome is unchanged when
    /// recovery cannot read a version.
    #[test]
    #[cfg(unix)]
    fn a_missing_shim_routes_through_recovery_without_changing_its_outcome() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hq = tmp.path().join("bin/hq"); // deliberately never created
        let managed_bin = tmp.path().join("managed/node/bin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        let node = managed_bin.join("node");
        write_executable(&node, "#!/bin/sh\nprintf 'v1.2.3\\n'\n");
        let managed = crate::toolchain::ManagedRuntime::Present { node };

        let result = probe_local_version_with_managed(
            Some(&hq),
            ResolvedProgramKind::Exe,
            Some(&managed),
            None,
            "",
        );

        assert_eq!(result.local, None);
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::StillUnreadable
        );
        assert_eq!(
            result.probes.hq_version,
            VersionProbeOutcome::SpawnProgramMissing
        );
        assert!(should_report_unreadable_version(&result));
    }

    /// A machine with no `hq` at all stays completely silent — hq_installed
    /// false, no report, no recovery — unchanged from today.
    #[test]
    fn no_hq_at_all_stays_silent() {
        let result = probe_local_version_with_managed(
            None,
            ResolvedProgramKind::NotResolved,
            None,
            None,
            "",
        );

        assert_eq!(result.local, None);
        assert!(!result.hq_installed);
        assert!(!should_report_unreadable_version(&result));
        assert_eq!(
            result.probes.interpreter_recovery,
            InterpreterRecovery::NotNeeded
        );
        assert_eq!(result.probes.managed_runtime, ManagedRuntimeState::NotProbed);
    }

    /// The direct-node gate recognizes node entrypoints only — the exact set of
    /// shebang shapes that decide whether the `<node> <program>` retry may run.
    #[test]
    #[cfg(unix)]
    fn shebang_names_node_recognizes_node_entrypoints_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cases = [
            ("env-node", "#!/usr/bin/env node\n", true),
            ("abs-node", "#!/usr/local/bin/node --enable-source-maps\n", true),
            ("env-dash-s", "#!/usr/bin/env -S node --experimental\n", true),
            ("env-nodejs", "#!/usr/bin/env nodejs\n", true),
            ("env-other", "#!/usr/bin/env hq-fixture-node\n", false),
            ("sh", "#!/bin/sh\n", false),
            ("bare-env", "#!/usr/bin/env\n", false),
            ("no-shebang", "console.log(1)\n", false),
        ];
        for (name, body, expected) in cases {
            let path = tmp.path().join(name);
            write_executable(&path, body);
            assert_eq!(shebang_names_node(&path), expected, "case {name}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_still_reports_nonzero_exit_for_a_genuine_failing_cli() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 5\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NonzeroExit);
    }

    #[test]
    #[cfg(unix)]
    fn field_triple_from_production_events_reproduces_on_base_and_resolves_on_candidate() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let interpreter_dir = tmp.path().join("fixture-interpreters");
        let npm_root = tmp.path().join("unrelated-npm-root");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        std::fs::create_dir_all(&interpreter_dir).unwrap();
        std::fs::create_dir_all(&npm_root).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(
            &interpreter_dir.join("hq-fixture-node"),
            "#!/bin/sh\nprintf 'v5.88.2\\n'\n",
        );
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '{}\\n'\n", npm_root.display()),
        );

        let without_child_path = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");
        assert_eq!(without_child_path.local, None);
        assert_eq!(
            without_child_path.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            without_child_path.probes.npm_root,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            without_child_path.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert!(should_report_unreadable_version(&without_child_path));

        let with_child_path = probe_local_version(
            Some(&hq),
            Some(npm.to_str().unwrap()),
            interpreter_dir.to_str().unwrap(),
        );
        assert_eq!(with_child_path.local.as_deref(), Some("5.88.2"));
        assert_eq!(
            with_child_path.probes.hq_version,
            VersionProbeOutcome::Succeeded
        );
        assert!(!should_report_unreadable_version(&with_child_path));
    }

    #[test]
    fn binary_anchor_shape_distinguishes_npm_prefix_flat_global_bin_and_unresolvable_parent() {
        assert_eq!(
            binary_anchor_shape(Path::new("/opt/homebrew/bin/hq")),
            BinaryAnchorShape::NpmPrefix,
        );
        assert_eq!(
            binary_anchor_shape(Path::new("/Users/fixture/Library/pnpm/hq")),
            BinaryAnchorShape::FlatGlobalBin,
        );
        assert_eq!(
            binary_anchor_shape(Path::new("")),
            BinaryAnchorShape::UnresolvableParent,
        );
    }

    #[test]
    #[cfg(unix)]
    fn binary_anchor_diagnostics_classify_canonicalize_package_and_manifest_failures() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing/hq");
        assert_eq!(
            version_from_hq_binary_probe(&missing).1,
            VersionProbeOutcome::CanonicalizeFailed
        );

        let standalone = tmp.path().join("standalone-hq");
        write_executable(&standalone, "#!/bin/sh\nexit 0\n");
        assert_eq!(
            version_from_hq_binary_probe(&standalone).1,
            VersionProbeOutcome::PackageNotFound
        );

        let bad_package = tmp.path().join("package.json");
        std::fs::write(&bad_package, b"not json").unwrap();
        assert_eq!(
            version_from_hq_binary_probe(&standalone).1,
            VersionProbeOutcome::ManifestReadOrParseFailed
        );
    }

    #[test]
    #[cfg(unix)]
    fn command_probe_diagnostics_classify_spawn_status_utf8_and_empty_output() {
        let tmp = tempfile::TempDir::new().unwrap();
        // An absent program is now named as such rather than folded into the
        // undifferentiated spawn-failure bucket.
        let missing = tmp.path().join("missing-hq");
        assert_eq!(
            hq_version_string_probe(&missing, "").1,
            VersionProbeOutcome::SpawnProgramMissing
        );

        // Present but not an executable image — the Unix ENOEXEC form of the
        // Windows os error 193 an extensionless POSIX shim produces.
        let not_executable = tmp.path().join("not-executable-hq");
        write_executable(&not_executable, "\u{0}\u{1}not-an-executable-image\n");
        assert_eq!(
            hq_version_string_probe(&not_executable, "").1,
            enoexec_fixture_outcome()
        );

        // Present, but this process may not execute it.
        let access_denied = tmp.path().join("access-denied-hq");
        std::fs::write(&access_denied, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(
            hq_version_string_probe(&access_denied, "").1,
            VersionProbeOutcome::SpawnAccessDenied
        );

        let nonzero = tmp.path().join("nonzero-hq");
        let invalid_utf8 = tmp.path().join("invalid-utf8-hq");
        let empty = tmp.path().join("empty-hq");
        write_executable(&nonzero, "#!/bin/sh\nexit 5\n");
        write_executable(&invalid_utf8, "#!/bin/sh\nprintf '\\377'\n");
        write_executable(&empty, "#!/bin/sh\nprintf '\\n'\n");
        assert_eq!(
            hq_version_string_probe(&nonzero, "").1,
            VersionProbeOutcome::NonzeroExit
        );
        assert_eq!(
            hq_version_string_probe(&invalid_utf8, "").1,
            VersionProbeOutcome::InvalidUtf8
        );
        assert_eq!(
            hq_version_string_probe(&empty, "").1,
            VersionProbeOutcome::EmptyOutput
        );
    }

    #[test]
    fn post_install_foreign_managed_repeat_is_suppressed_but_remains_actionable() {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/Library/pnpm/hq",
            "/Users/t/Library/pnpm/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            "5.84.0",
            None,
            "/opt/homebrew/bin/npm",
            true,
            None,
        ));
        assert_eq!(outcome.verdict, ConvergenceVerdict::NonConvergent);
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ForeignManaged)
        );
        assert!(outcome.record_non_convergent.is_none());
        assert!(outcome.capture.is_none());
        assert!(outcome.capture_requires_durable_record);
        assert!(
            matches!(outcome.result, Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX))
        );
    }

    #[test]
    fn non_convergent_episode_block_requires_the_exact_latest_version() {
        assert!(non_convergent_episode_blocked(Some("5.84.0"), "5.84.0"));
        assert!(!non_convergent_episode_blocked(Some("5.83.0"), "5.84.0"));
        assert!(!non_convergent_episode_blocked(None, "5.84.0"));
    }

    #[test]
    fn post_install_version_rollover_starts_and_closes_a_new_episode() {
        let latest = "5.84.0";
        let old_marker = Some("5.83.0");
        let first_episode_blocked = non_convergent_episode_blocked(old_marker, latest);
        assert!(!first_episode_blocked);

        let first = decide_post_install(&PostInstallContext::npm(
            "/Users/t/Library/pnpm/hq",
            "/Users/t/Library/pnpm/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            latest,
            None,
            "/opt/homebrew/bin/npm",
            first_episode_blocked,
            None,
        ));
        assert_eq!(first.record_non_convergent.as_deref(), Some(latest));
        assert!(first.capture.is_some());
        assert!(first.capture_requires_durable_record);

        let durable_marker = first.record_non_convergent.as_deref();
        let repeat_episode_blocked = non_convergent_episode_blocked(durable_marker, latest);
        assert!(repeat_episode_blocked);

        let repeat = decide_post_install(&PostInstallContext::npm(
            "/Users/t/Library/pnpm/hq",
            "/Users/t/Library/pnpm/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            latest,
            None,
            "/opt/homebrew/bin/npm",
            repeat_episode_blocked,
            None,
        ));
        assert!(repeat.record_non_convergent.is_none());
        assert!(repeat.capture.is_none());
        assert!(repeat.capture_requires_durable_record);
    }

    #[tokio::test]
    async fn overlapping_first_episode_installs_share_one_claim_and_capture() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Arc;
        use tokio::sync::Notify;

        let flight = AsyncSingleFlight::<PostInstallSuccess>::new();
        let installs = Arc::new(AtomicUsize::new(0));
        let records = Arc::new(AtomicUsize::new(0));
        let captures = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let make_operation = || {
            let installs = Arc::clone(&installs);
            let records = Arc::clone(&records);
            let captures = Arc::clone(&captures);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            move || async move {
                installs.fetch_add(1, AtomicOrdering::SeqCst);
                entered.notify_one();
                release.notified().await;
                let outcome = decide_post_install(&PostInstallContext::npm(
                    "/Users/t/Library/pnpm/hq",
                    "/Users/t/Library/pnpm/hq",
                    Some("5.77.14"),
                    Some("5.77.14"),
                    "5.84.0",
                    None,
                    "/opt/homebrew/bin/npm",
                    false,
                    None,
                ));
                let record = |_version: String| {
                    records.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(())
                };
                let clear = || panic!("non-convergence must not clear the marker");
                let capture = |_report| {
                    captures.fetch_add(1, AtomicOrdering::SeqCst);
                };
                let record_failure = |_error| panic!("the marker write must succeed");
                apply_post_install_effects(
                    &outcome,
                    &PostInstallCoreEffects {
                        record: &record,
                        clear: &clear,
                        capture: &capture,
                        record_failure: &record_failure,
                    },
                )
            }
        };
        let first = flight.run(make_operation());
        let second = flight.run(make_operation());
        let release_when_overlapped = async {
            entered.notified().await;
            tokio::task::yield_now().await;
            release.notify_waiters();
        };

        let (first_result, second_result, ()) =
            tokio::join!(first, second, release_when_overlapped);
        assert!(matches!(
            first_result,
            Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
        ));
        assert_eq!(first_result.err(), second_result.err());
        assert_eq!(installs.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(records.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(captures.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn post_install_first_foreign_managed_episode_requires_a_durable_record() {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.asdf/shims/hq",
            "/Users/t/.asdf/shims/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            "5.84.0",
            None,
            "/opt/homebrew/bin/npm",
            false,
            None,
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ForeignManaged)
        );
        assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.84.0"));
        assert!(outcome.capture.is_some());
        assert!(outcome.capture_requires_durable_record);
    }

    #[test]
    fn post_install_npm_targeted_non_convergence_stays_loud() {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.npm-global/bin/hq",
            "/Users/t/.npm-global/bin/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            "5.84.0",
            Some("/Users/t/.npm-global"),
            "/opt/homebrew/bin/npm",
            true,
            // Delivery evidence present: the target reached the prefix, so a
            // shadowing copy on PATH is a genuine, loud, blocking defect.
            Some("5.84.0"),
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::NpmTargeted)
        );
        assert!(outcome.capture.is_some());
        assert!(!outcome.capture_requires_durable_record);
    }

    /// Genuine shadowing: npm delivered the target INTO the prefix, but a copy
    /// earlier on PATH still wins, so the resolved binary stays stale. A real
    /// updater defect — loud on every occurrence and blocking, so the loop stops
    /// reinstalling a version it cannot make win.
    #[test]
    fn a_delivered_target_that_the_binary_does_not_reflect_stays_loud_and_blocking() {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.npm-global/bin/hq",
            "/Users/t/.npm-global/bin/hq",
            Some("5.97.0"),
            Some("5.97.0"),
            "5.97.1",
            Some("/Users/t/.npm-global"),
            "/opt/homebrew/bin/npm",
            false,
            Some("5.97.1"), // delivered == target
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::NpmTargeted)
        );
        assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.97.1"));
        assert!(!outcome.capture_requires_durable_record);
        let report = outcome.capture.expect("genuine shadowing stays loud");
        assert_eq!(report.delivered_version.as_deref(), Some("5.97.1"));
    }

    /// The registry race: npm exited 0 into the right prefix but delivered N-1
    /// (the target never propagated), so no manifest at the target exists. That
    /// is a resolution shortfall, not a layout defect: it must NEVER persist the
    /// blocking marker, so the next scheduled check retries rather than the
    /// version being wedged forever.
    #[test]
    fn an_undelivered_target_is_a_resolution_shortfall_and_never_blocks_auto_install() {
        for delivered in [Some("5.97.0"), None] {
            let outcome = decide_post_install(&PostInstallContext::npm(
                "/Users/t/.npm-global/bin/hq",
                "/Users/t/.npm-global/bin/hq",
                Some("5.97.0"),
                Some("5.97.0"),
                "5.97.1",
                Some("/Users/t/.npm-global"),
                "/opt/homebrew/bin/npm",
                false,
                delivered, // short of, or absent, the target
            ));
            assert_eq!(
                outcome.non_convergence_kind,
                Some(NonConvergenceKind::ResolutionShortfall),
                "delivered={delivered:?}"
            );
            assert!(
                outcome.record_non_convergent.is_none(),
                "a shortfall must never wedge auto-update (delivered={delivered:?})"
            );
            // Still observable, and its detail self-describes as transient rather
            // than telling the user to change or remove anything.
            let report = outcome.capture.as_ref().expect("a shortfall still signals");
            assert_eq!(report.delivered_version.as_deref(), delivered);
            assert!(matches!(
                &outcome.result,
                Err(detail)
                    if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
                        && detail.contains("transient registry lag")
            ));
        }
    }

    /// Un-wedging already-affected machines is bounded. A legacy (unversioned)
    /// marker earns exactly one recovery re-attempt; a marker written under the
    /// pinned contract is delivery-backed and keeps blocking, so a genuinely
    /// stuck layout re-blocks after its single re-attempt rather than looping.
    #[test]
    fn a_legacy_unversioned_marker_permits_exactly_one_reattempt() {
        assert!(legacy_marker_needs_recovery(None, Some("5.97.1")));
        assert!(legacy_marker_needs_recovery(
            Some("some-older-tag"),
            Some("5.97.1")
        ));
        // No marker → nothing to recover.
        assert!(!legacy_marker_needs_recovery(None, None));
        assert!(!legacy_marker_needs_recovery(
            Some(PINNED_MARKER_CONTRACT),
            None
        ));
    }

    #[test]
    fn a_marker_written_under_the_pinned_contract_keeps_blocking() {
        // A pinned-contract marker is delivery-backed: never re-attempted...
        assert!(!legacy_marker_needs_recovery(
            Some(PINNED_MARKER_CONTRACT),
            Some("5.97.1")
        ));
        // ...and the shared block predicate still blocks that exact version, so
        // the background loop skips it.
        assert!(non_convergent_episode_blocked(Some("5.97.1"), "5.97.1"));
        assert!(!should_auto_install("5.97.1", Some("5.97.1")));
    }

    /// A pinned install of a not-yet-propagated version fails with ETARGET,
    /// already an expected transient registry failure: it is not reported as an
    /// install failure and touches no marker (that path is exit-0 only), so
    /// auto-update stays armed and simply retries on the next check.
    #[test]
    fn etarget_on_a_pinned_install_is_an_expected_transient_and_writes_no_marker() {
        let etarget = "npm error code ETARGET\n\
            npm error notarget No matching version found for @indigoai-us/hq-cli@5.97.1";
        assert!(is_expected_transient_registry_failure(etarget));
        for detail in [
            "npm error code ECONNRESET",
            "npm error code ETIMEDOUT",
            "npm error code ENOTFOUND",
        ] {
            assert!(is_expected_transient_registry_failure(detail));
        }
        // A genuine, non-transient failure must NOT be swept into the transient
        // bucket, or a real defect would be silently retried forever.
        assert!(!is_expected_transient_registry_failure(
            "npm error code EACCES"
        ));
    }

    #[test]
    fn post_install_exit_202_stays_unexpected_without_corrobating_stderr() {
        assert_eq!(
            classify_install_failure(Some(202), "", None),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    #[cfg(unix)]
    fn npm_root_probe_diagnostics_classify_output_and_manifest_failures() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing-npm");
        assert_eq!(
            read_installed_version_probe(missing.to_str().unwrap(), "").1,
            VersionProbeOutcome::SpawnProgramMissing
        );

        let not_executable = tmp.path().join("not-executable-npm");
        write_executable(&not_executable, "\u{0}\u{1}not-an-executable-image\n");
        assert_eq!(
            read_installed_version_probe(not_executable.to_str().unwrap(), "").1,
            enoexec_fixture_outcome()
        );

        let nonzero = tmp.path().join("nonzero-npm");
        let missing_interpreter = tmp.path().join("missing-interpreter-npm");
        let invalid_utf8 = tmp.path().join("invalid-utf8-npm");
        let empty = tmp.path().join("empty-npm");
        let absent_package = tmp.path().join("absent-package-npm");
        let non_directory_root = tmp.path().join("non-directory-root");
        let non_directory_package = tmp.path().join("non-directory-package-npm");
        let malformed_package = tmp.path().join("malformed-package-npm");
        write_executable(&nonzero, "#!/bin/sh\nexit 5\n");
        write_executable(&missing_interpreter, "#!/bin/sh\nexit 127\n");
        write_executable(&invalid_utf8, "#!/bin/sh\nprintf '\\377'\n");
        write_executable(&empty, "#!/bin/sh\nprintf '\\n'\n");
        write_executable(
            &absent_package,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", tmp.path().display()),
        );
        std::fs::write(&non_directory_root, b"not a directory").unwrap();
        write_executable(
            &non_directory_package,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\n",
                non_directory_root.display()
            ),
        );
        let npm_root = tmp.path().join("npm-root");
        let package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(&package, b"not json").unwrap();
        write_executable(
            &malformed_package,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );

        assert_eq!(
            read_installed_version_probe(nonzero.to_str().unwrap(), "").1,
            VersionProbeOutcome::NonzeroExit
        );
        assert_eq!(
            read_installed_version_probe(missing_interpreter.to_str().unwrap(), "").1,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert_eq!(
            read_installed_version_probe(invalid_utf8.to_str().unwrap(), "").1,
            VersionProbeOutcome::InvalidUtf8
        );
        assert_eq!(
            read_installed_version_probe(empty.to_str().unwrap(), "").1,
            VersionProbeOutcome::EmptyOutput
        );
        assert_eq!(
            read_installed_version_probe(absent_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            read_installed_version_probe(non_directory_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            read_installed_version_probe(malformed_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::ManifestReadOrParseFailed
        );
    }

    /// `get_local_version` is the compatibility wrapper over
    /// `get_local_version_diagnostics().local`. Exercise the old ordered
    /// algorithm independently so the diagnostic refactor cannot change its
    /// return value while preserving only the new result's internal shape.
    #[test]
    #[cfg(unix)]
    fn get_local_version_return_shape_is_unchanged_across_the_ordered_scenarios() {
        let absent = probe_local_version(None, None, "");
        assert_eq!(
            legacy_local_version(None, None, ""),
            absent.local,
            "absent hq"
        );

        let binary_tmp = tempfile::TempDir::new().unwrap();
        let package = binary_tmp
            .path()
            .join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(
            package.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.80.1"}"#,
        )
        .unwrap();
        let real_hq = package.join("bin/hq.js");
        write_executable(&real_hq, "#!/bin/sh\nexit 91\n");
        let binary_hq = binary_tmp.path().join("bin/hq");
        std::fs::create_dir_all(binary_hq.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real_hq, &binary_hq).unwrap();
        let binary = probe_local_version(Some(&binary_hq), None, "");
        assert_eq!(
            legacy_local_version(Some(&binary_hq), None, ""),
            binary.local,
            "binary-anchor hit"
        );

        let npm_tmp = tempfile::TempDir::new().unwrap();
        let npm_hq = npm_tmp.path().join("bin/hq");
        let npm = npm_tmp.path().join("bin/npm");
        let npm_root = npm_tmp.path().join("npm-root");
        let npm_package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(npm_hq.parent().unwrap()).unwrap();
        std::fs::create_dir_all(npm_package.parent().unwrap()).unwrap();
        write_executable(&npm_hq, "#!/bin/sh\nexit 92\n");
        std::fs::write(
            &npm_package,
            br#"{"name":"@indigoai-us/hq-cli","version":"5.80.2"}"#,
        )
        .unwrap();
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );
        let npm_bin = npm.to_str().unwrap();
        let npm_result = probe_local_version(Some(&npm_hq), Some(npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&npm_hq), Some(npm_bin), ""),
            npm_result.local,
            "npm-root hit"
        );

        let version_tmp = tempfile::TempDir::new().unwrap();
        let version_hq = version_tmp.path().join("bin/hq");
        let failing_npm = version_tmp.path().join("bin/npm");
        std::fs::create_dir_all(version_hq.parent().unwrap()).unwrap();
        write_executable(&version_hq, "#!/bin/sh\nprintf 'v5.80.3\\n'\n");
        write_executable(&failing_npm, "#!/bin/sh\nexit 93\n");
        let failing_npm_bin = failing_npm.to_str().unwrap();
        let hq_version = probe_local_version(Some(&version_hq), Some(failing_npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&version_hq), Some(failing_npm_bin), ""),
            hq_version.local,
            "hq --version hit"
        );

        let failure_tmp = tempfile::TempDir::new().unwrap();
        let failing_hq = failure_tmp.path().join("bin/hq");
        let failing_npm = failure_tmp.path().join("bin/npm");
        std::fs::create_dir_all(failing_hq.parent().unwrap()).unwrap();
        write_executable(&failing_hq, "#!/bin/sh\nexit 94\n");
        write_executable(&failing_npm, "#!/bin/sh\nexit 95\n");
        let failing_npm_bin = failing_npm.to_str().unwrap();
        let all_fail = probe_local_version(Some(&failing_hq), Some(failing_npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&failing_hq), Some(failing_npm_bin), ""),
            all_fail.local,
            "all probes fail"
        );
    }

    #[cfg(unix)]
    fn legacy_local_version(hq: Option<&Path>, npm: Option<&str>, path: &str) -> Option<String> {
        if let Some(hq) = hq {
            if let Some(version) = version_from_hq_binary(hq) {
                return Some(version);
            }
        }
        if let Some(npm) = npm {
            if let Some(version) = read_installed_version(npm, path) {
                return Some(version);
            }
        }
        hq.and_then(hq_version_string)
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// What spawning an exec-bit file whose content is not a valid executable
    /// image actually produces on THIS host.
    ///
    /// Linux answers `ENOEXEC` straight from the spawn, which is the faithful
    /// analogue of the Windows `ERROR_BAD_EXE_FORMAT` (os error 193) the field
    /// events come from. macOS and the BSDs do not: their libc `execvp` retries
    /// such a file under `/bin/sh`, so the spawn SUCCEEDS and the shell exits
    /// nonzero instead. The fixture is therefore platform-dependent; the
    /// 193/`ENOEXEC` mapping itself is pinned platform-independently by
    /// `classify_spawn_error_splits_the_process_spawn_failed_bucket`.
    #[cfg(unix)]
    fn enoexec_fixture_outcome() -> VersionProbeOutcome {
        if cfg!(target_os = "linux") {
            VersionProbeOutcome::SpawnNotExecutable
        } else {
            VersionProbeOutcome::NonzeroExit
        }
    }

    // ── HQ-DESKTOP-3P: a Windows resolution that exists but cannot be spawned ──

    /// Every spawn failure used to collapse into `ProcessSpawnFailed`, so the
    /// field event could not say whether the program was absent, present but
    /// not an executable image, or blocked by permissions.
    #[test]
    fn classify_spawn_error_splits_the_process_spawn_failed_bucket() {
        use std::io::{Error, ErrorKind};

        // Windows ERROR_BAD_EXE_FORMAT — the exact code an extensionless POSIX
        // shim produces when CreateProcessW is handed it. Pinned on every
        // platform so a Windows-only regression is caught by the macOS/Linux
        // legs too.
        assert_eq!(
            classify_spawn_error(&Error::from_raw_os_error(193)),
            VersionProbeOutcome::SpawnNotExecutable
        );
        #[cfg(unix)]
        assert_eq!(
            classify_spawn_error(&Error::from_raw_os_error(8)),
            VersionProbeOutcome::SpawnNotExecutable,
            "ENOEXEC is the Unix form of the same condition"
        );
        assert_eq!(
            classify_spawn_error(&Error::from(ErrorKind::NotFound)),
            VersionProbeOutcome::SpawnProgramMissing
        );
        assert_eq!(
            classify_spawn_error(&Error::from(ErrorKind::PermissionDenied)),
            VersionProbeOutcome::SpawnAccessDenied
        );
        assert_eq!(
            classify_spawn_error(&Error::from(ErrorKind::Interrupted)),
            VersionProbeOutcome::ProcessSpawnFailed,
            "unclassified spawn errors must keep the original residual bucket"
        );
    }

    /// **The anti-silencing pin.** A resolved-but-non-spawnable `hq` is a
    /// broken CLI, not an absent one. Dropping such a resolution back to the
    /// bare name would flip `hq_installed` to false and silence the event, the
    /// banner, and the regression watermark while the user's CLI stays broken.
    #[test]
    fn marked_non_spawnable_resolution_still_reports_and_carries_its_kind() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // A real file the loader cannot execute — the cross-platform stand-in
        // for the extensionless POSIX shim resolved on the field host.
        let hq = bin.join("hq");
        std::fs::write(&hq, "#!/usr/bin/env sh\n").unwrap();

        let result =
            probe_local_version_with_kind(Some(&hq), ResolvedProgramKind::Extensionless, None, "");

        assert_eq!(result.local, None);
        assert!(result.hq_installed, "a broken CLI is still installed");
        assert!(
            should_report_unreadable_version(&result),
            "silencing an installed-but-unusable CLI is prohibited"
        );
        assert_eq!(
            result.probes.resolved_program_kind,
            ResolvedProgramKind::Extensionless,
            "the resolver classification must reach the diagnostics"
        );
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix
        );
    }

    /// The genuinely-absent CLI stays a quiet no-op — kept as its own case so
    /// the anti-silencing pin above can never be satisfied by reporting on
    /// everyone.
    #[test]
    fn absent_hq_reports_the_not_resolved_kind_and_stays_quiet() {
        let result = probe_local_version(None, None, "");

        assert!(!result.hq_installed);
        assert!(!should_report_unreadable_version(&result));
        assert_eq!(
            result.probes.resolved_program_kind,
            ResolvedProgramKind::NotResolved
        );
    }

    /// Reproduces the exact production probe quadruple on the base commit
    /// (`package_not_found` / `npm_prefix` / `package_not_found` /
    /// `process_spawn_failed`) using the Unix ENOEXEC analogue of Windows os
    /// error 193, and pins that the spawn no longer collapses into the
    /// undifferentiated bucket.
    ///
    /// The base-red half is Linux-specific by necessity — see
    /// [`enoexec_fixture_outcome`] for why macOS cannot produce the fixture —
    /// but the three surrounding field outcomes and the reporting decision are
    /// asserted on every Unix leg.
    #[test]
    #[cfg(unix)]
    fn field_shape_spawn_failure_is_classified_as_not_executable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        let npm_root = tmp.path().join("npm-root");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&npm_root).unwrap();

        // Executable bit set, but the content is not a valid executable image
        // (no shebang, not ELF) — execve answers ENOEXEC, exactly as
        // CreateProcessW answers ERROR_BAD_EXE_FORMAT for a POSIX shim.
        let hq = bin.join("hq");
        write_executable(&hq, "\u{0}\u{1}not-an-executable-image\n");
        // npm resolves a global root that does not contain the package.
        let npm = bin.join("npm");
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert!(result.hq_installed);
        assert!(should_report_unreadable_version(&result));
        // The three field-matching outcomes are unchanged…
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::PackageNotFound);
        // …and the fourth now names the cause instead of the bucket. This is
        // the assertion that runs RED on the base commit, where every spawn
        // failure collapsed into `process_spawn_failed`.
        assert_ne!(
            result.probes.hq_version,
            VersionProbeOutcome::ProcessSpawnFailed,
            "an unexecutable program must not report as an undifferentiated spawn failure"
        );
        assert_eq!(result.probes.hq_version, enoexec_fixture_outcome());
    }

    /// End-to-end at the seam that owns the recovery: the selector picks the
    /// spawnable `hq.cmd` from a later search directory over the bare shim that
    /// used to shadow it, and that selection reads a version with no report.
    #[test]
    fn recovered_spawnable_selection_reads_a_version_and_stays_quiet() {
        let tmp = tempfile::TempDir::new().unwrap();
        let early = tmp.path().join("git-usr-bin");
        let npm_prefix = tmp.path().join("npm-prefix");
        let package = npm_prefix.join("node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&early).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(early.join("hq"), "not-an-executable-image\n").unwrap();
        std::fs::write(npm_prefix.join("hq.cmd"), "@echo off\n").unwrap();
        std::fs::write(
            package.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.94.1"}"#,
        )
        .unwrap();

        let selected = paths::select_program_in_dirs(
            &[early.clone(), npm_prefix.clone()],
            &[
                "hq.exe".to_string(),
                "hq.cmd".to_string(),
                "hq.bat".to_string(),
                "hq".to_string(),
            ],
            &|path| path.exists(),
        )
        .expect("the spawnable shim must be selected");
        assert_eq!(selected.path, npm_prefix.join("hq.cmd").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::CmdOrBat);

        let result =
            probe_local_version_with_kind(Some(Path::new(&selected.path)), selected.kind, None, "");

        assert_eq!(result.local.as_deref(), Some("5.94.1"));
        assert_eq!(result.probes.binary_anchor, VersionProbeOutcome::Succeeded);
        assert!(
            !should_report_unreadable_version(&result),
            "a recovered, readable CLI must produce no event"
        );
    }

    /// pnpm keeps its globals in its own store, which neither npm candidate
    /// layout can reach — so a pnpm-managed Windows install read as unreadable
    /// even though its manifest was sitting on disk.
    #[test]
    fn pnpm_windows_store_layouts_read_a_version_without_spawning() {
        fn write_store(home: &Path, store_version: &str, version: &str) {
            let package = home
                .join("global")
                .join(store_version)
                .join("node_modules/@indigoai-us/hq-cli");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(
                package.join("package.json"),
                format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
            )
            .unwrap();
        }

        // 1. Flat pnpm home: `<pnpm-home>\hq.cmd`.
        let tmp = tempfile::TempDir::new().unwrap();
        let flat = tmp.path().join("pnpm");
        std::fs::create_dir_all(&flat).unwrap();
        let flat_shim = flat.join("hq.cmd");
        std::fs::write(&flat_shim, "@echo off\n").unwrap();
        write_store(&flat, "5", "5.90.0");
        assert_eq!(
            version_from_hq_binary_probe(&flat_shim),
            (Some("5.90.0".to_string()), VersionProbeOutcome::Succeeded)
        );

        // 2. pnpm >= 11 nests the shims: `<pnpm-home>\bin\hq.cmd`.
        let nested_home = tmp.path().join("pnpm-nested");
        let nested_bin = nested_home.join("bin");
        std::fs::create_dir_all(&nested_bin).unwrap();
        write_store(&nested_home, "6", "5.91.0");
        let nested_shim = nested_bin.join("hq.cmd");
        std::fs::write(&nested_shim, "@echo off\n").unwrap();
        assert_eq!(
            version_from_hq_binary_probe(&nested_shim),
            (Some("5.91.0".to_string()), VersionProbeOutcome::Succeeded)
        );

        // 3. Custom PNPM_HOME, identified by the `global/` store beside the
        //    shims, and with more than one store version present the newest
        //    format wins.
        let custom = tmp.path().join("custom-pnpm-home");
        std::fs::create_dir_all(&custom).unwrap();
        write_store(&custom, "5", "5.10.0");
        write_store(&custom, "10", "5.92.0");
        let custom_shim = custom.join("hq.cmd");
        std::fs::write(&custom_shim, "@echo off\n").unwrap();
        assert_eq!(
            version_from_hq_binary_probe(&custom_shim),
            (Some("5.92.0".to_string()), VersionProbeOutcome::Succeeded)
        );
    }

    /// npm layouts must keep their exact candidate order — the pnpm additions
    /// are appended, never interleaved.
    #[test]
    fn npm_candidate_order_is_unchanged_by_the_pnpm_widening() {
        let prefix = Path::new("/prefix");
        let unix = Path::new("/prefix/lib/node_modules/@indigoai-us/hq-cli/package.json");
        let windows = Path::new("/prefix/node_modules/@indigoai-us/hq-cli/package.json");

        assert_eq!(
            hq_cli_package_json_candidates(prefix, Path::new("/prefix/bin/hq")),
            vec![unix.to_path_buf(), windows.to_path_buf()]
        );
        assert_eq!(
            hq_cli_package_json_candidates(prefix, Path::new("/prefix/hq.cmd")),
            vec![windows.to_path_buf(), unix.to_path_buf()]
        );
    }

    // --- HQ-DESKTOP-56: unsupported-Node classification ------------------------

    /// A Node-6 machine's stderr: modern npm cannot even parse under Node 6, so it
    /// dies with a bare Node `SyntaxError` and NONE of npm's structured
    /// `npm error` markers — exactly the reported shape (npm_error_code=none,
    /// npm_syscall=unknown, npm_path_shape=none, npm_lifecycle_failed=false), which
    /// the env-blind classifier can only read as `Unexpected`.
    fn node_six_stderr() -> &'static str {
        "/usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/lib/arborist/index.js:1\n\
         export { Arborist }\n\
         ^^^^^^\n\
         SyntaxError: Unexpected token export\n\
             at createScript (vm.js:56:10)\n\
             at Object.runInThisContext (vm.js:97:10)\n\
             at Module._compile (module.js:549:28)\n\
             at Object.Module._extensions..js (module.js:586:10)\n\
             at Module.load (module.js:494:32)\n\
             at tryModuleLoad (module.js:453:12)\n\
             at Function.Module._load (module.js:445:3)"
    }

    fn unsupported_node_env(version: Option<&str>, abi: Option<&str>) -> InstallEnvironment {
        InstallEnvironment {
            node_version: version.map(str::to_string),
            node_abi: abi.map(str::to_string),
            npm_version: None,
            toolchain_source: NpmToolchainSource::UserPath,
            managed_toolchain_retry: false,
        }
    }

    #[test]
    fn unsupported_node_reclassifies_only_a_below_floor_probe() {
        let stderr = node_six_stderr();
        // The exact reported shape: Node 6.17.1 (ABI 48), no npm markers, prefix
        // known -> UnsupportedNode.
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                stderr,
                Some("/usr/local"),
                false,
                &unsupported_node_env(Some("v6.17.1"), Some("48")),
            ),
            InstallFailureKind::UnsupportedNode
        );
        // A supported or unreadable Node keeps today's `Unexpected` for the
        // identical stderr — the refinement requires a parsed major strictly below
        // the floor and otherwise fails open to current behaviour. `v20`/`v22` are
        // AT/above the floor; `None`/`unknown` never parse a major.
        for node in [None, Some("unknown"), Some("v20.11.0"), Some("v22.17.0")] {
            assert_eq!(
                classify_install_failure_with_environment(
                    Some(1),
                    stderr,
                    Some("/usr/local"),
                    false,
                    &unsupported_node_env(node, None),
                ),
                InstallFailureKind::Unexpected,
                "node {node:?} must stay Unexpected"
            );
        }
    }

    #[test]
    fn unsupported_node_never_overrides_an_expected_or_lifecycle_kind() {
        // Even on a Node-6 machine, every already-classified kind is preserved:
        // the refinement touches ONLY the `Unexpected` fallback, so no existing
        // suppression or grouping is disturbed.
        let old_node = unsupported_node_env(Some("v6.17.1"), Some("48"));
        let cases: &[(Option<i32>, &str, Option<&str>, bool, InstallFailureKind)] = &[
            (
                Some(1),
                "npm error code ENOSPC\nnpm error syscall write\nnpm error ENOSPC: no space left on device, write",
                None,
                false,
                InstallFailureKind::ExpectedDiskFull,
            ),
            (
                Some(1),
                "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@indigoai-us\nnpm error errno -13",
                None,
                false,
                InstallFailureKind::ExpectedPrefixPermission,
            ),
            (Some(WINDOWS_ABORT_EXIT), "", None, false, InstallFailureKind::ExpectedWindowsAbort),
            (
                Some(-4048),
                "npm error code EPERM\nnpm error syscall unlink\nnpm error path /usr/local/bin/hq",
                Some("/usr/local"),
                false,
                InstallFailureKind::ExpectedWindowsLockedBinary,
            ),
            (Some(1), "npm error code ETARGET", None, false, InstallFailureKind::ExpectedTransientRegistry),
            (
                Some(1),
                "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
                Some("/usr/local"),
                true,
                InstallFailureKind::ExpectedBinCollision,
            ),
            (
                Some(1),
                "npm error code 1\nnpm error path /root/.npm-global/lib/node_modules/better-sqlite3\nnpm error command failed\nnpm error command sh -c prebuild-install || node-gyp rebuild",
                Some("/root/.npm-global"),
                false,
                InstallFailureKind::UnexpectedLifecycle,
            ),
        ];
        for (exit, detail, prefix, forced, expected) in cases {
            assert_eq!(
                classify_install_failure_with_environment(*exit, detail, *prefix, *forced, &old_node),
                *expected,
                "detail {detail:?} must keep its kind on a Node-6 machine"
            );
        }
    }

    #[test]
    fn env_blind_wrappers_are_behaviour_preserving_for_a_node_6_stderr() {
        let stderr = node_six_stderr();
        // Every env-blind entrypoint returns TODAY's values for the Node-6 stderr —
        // the reported `Unexpected` / `none:unknown:none` / raw-passthrough shape —
        // proving default-env delegation changed nothing for existing callers.
        assert_eq!(
            classify_install_failure(Some(1), stderr, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            classify_install_failure_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            install_failure_report_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
            Some("[hq-cli-update] install failed (none:unknown:none)".to_string())
        );
        // The env-blind detail still shows the raw stderr passthrough...
        assert_eq!(
            install_failure_detail_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
            stderr.trim()
        );
        // ...while the env-aware detail, given the Node-6 probe, names the required
        // Node instead of echoing the raw parse error.
        let actionable = install_failure_detail_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            &unsupported_node_env(Some("v6.17.1"), Some("48")),
        );
        assert!(
            actionable.contains("Node.js 20") && !actionable.contains("SyntaxError"),
            "unsupported-node copy must name the floor and never echo raw stderr: {actionable}"
        );
    }

    #[test]
    fn unsupported_node_signature_is_bounded_and_free_text_cannot_enter() {
        let stderr = node_six_stderr();
        // The signature is `unsupported-node:<parsed major>` and nothing else.
        assert_eq!(
            install_failure_signature_with_environment(
                InstallFailureKind::UnsupportedNode,
                stderr,
                Some("/usr/local"),
                &unsupported_node_env(Some("v6.17.1"), Some("48")),
            ),
            "unsupported-node:6"
        );
        // A probed version carrying free text collapses through
        // `sanitized_version_token` to `unknown`, so no major parses and NO
        // reclassification happens — caller free text can never reach the group.
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                stderr,
                Some("/usr/local"),
                false,
                &unsupported_node_env(Some("6.x nightly; rm -rf /"), Some("48")),
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn unsupported_node_episode_key_pages_once_per_target_version() {
        let stderr = node_six_stderr();
        let latest = "5.101.7";
        let env6 = unsupported_node_env(Some("v6.17.1"), Some("48"));
        let key = install_failure_episode_key_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            latest,
            &env6,
        )
        .expect("unsupported-node mints an episode key");
        assert_eq!(key, "5.101.7|unsupported-node|6");
        // A second identical failure for the same target version + major is a
        // suppressed repeat, so a permanent per-machine condition stops re-paging.
        assert!(install_failure_episode_blocked(&[key.clone()], &key));
        // A new CLI target version, a different Node major, and managed provenance
        // each mint a DISTINCT key, so a genuinely different episode still reports.
        let new_latest = install_failure_episode_key_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            "5.102.0",
            &env6,
        );
        assert_eq!(new_latest.as_deref(), Some("5.102.0|unsupported-node|6"));
        let node8 = install_failure_episode_key_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            latest,
            &unsupported_node_env(Some("v8.17.0"), Some("57")),
        );
        assert_eq!(node8.as_deref(), Some("5.101.7|unsupported-node|8"));
        let mut managed_env = env6.clone();
        managed_env.managed_toolchain_retry = true;
        let managed = install_failure_episode_key_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            latest,
            &managed_env,
        );
        assert_eq!(managed.as_deref(), Some("5.101.7|unsupported-node|6|managed"));
        // The env-blind shape (no probed Node) is a plain `Unexpected` failure whose
        // signature is fully shapeless (`none:unknown:none`) — npm structured
        // nothing — so it is deliberately NOT repeat-suppressed and mints no key: it
        // keeps paging every check, exactly as before this change, so an unrelated
        // new failure sharing the empty signature is never hidden behind it.
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(1),
                stderr,
                Some("/usr/local"),
                false,
                latest,
                &InstallEnvironment::default(),
            ),
            None
        );
    }
}
