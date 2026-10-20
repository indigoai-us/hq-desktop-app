//! Shared support for the HQ CLI update command layer: pure decision and
//! reporting helpers plus its async single-flight boundary.

use std::future::Future;
#[cfg(not(unix))]
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as WindowsCommandExt;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

use crate::paths;
use crate::watcher_fault::{UnmatchedStderrShape, UnmatchedStderrShapeRollup};

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

/// Environment applied to desktop-spawned npm/pnpm/Bun installs. node-llama-cpp
/// supports this flag to skip its optional download/build postinstall work. That
/// work is not needed to install or run the HQ CLI and must not abort an update.
pub const NPM_INSTALL_CHILD_ENV: [(&str, &str); 2] = [
    ("NODE_LLAMA_CPP_SKIP_DOWNLOAD", "true"),
    // A package without a prebuilt binary must fail the install, never fall
    // back to a node-gyp compile that needs python3, make and clang.
    ("npm_config_build_from_source", "false"),
];

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
    /// The child exceeded the bounded version-probe deadline and was killed.
    TimedOut,
}

const VERSION_PROCESS_TIMEOUT: Duration = Duration::from_secs(1);
const VERSION_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

const VERSION_OUTPUT_LIMIT: u64 = 64 * 1024;

#[cfg(unix)]
fn read_probe_output(file: std::fs::File) -> std::io::Result<Vec<u8>> {
    use std::os::unix::fs::FileExt;
    // The child inherits the same open file description. Seeking here would
    // also rewind a descendant that is still writing during group shutdown.
    let mut bytes = vec![0; VERSION_OUTPUT_LIMIT as usize];
    let mut length = 0;
    while length < bytes.len() {
        match file.read_at(&mut bytes[length..], length as u64) {
            Ok(0) => break,
            Ok(count) => length += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    bytes.truncate(length);
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_probe_output(mut file: std::fs::File) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(VERSION_OUTPUT_LIMIT).read_to_end(&mut bytes)?;
    Ok(bytes)
}

struct VersionProbeContainment {
    #[cfg(unix)]
    process_group: Option<i32>,
    #[cfg(target_os = "windows")]
    job: Option<HANDLE>,
}

impl VersionProbeContainment {
    fn prepare(cmd: &mut std::process::Command) {
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(paths::CREATE_NO_WINDOW | CREATE_SUSPENDED.0);
        #[cfg(not(any(unix, target_os = "windows")))]
        let _ = cmd;
    }

    fn establish(child: &std::process::Child) -> std::io::Result<Self> {
        #[cfg(unix)]
        return Ok(Self {
            process_group: Some(child.id() as i32),
        });

        #[cfg(target_os = "windows")]
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(std::io::Error::other(error.to_string()));
            }
            if let Err(error) = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) {
                let _ = CloseHandle(job);
                return Err(std::io::Error::other(error.to_string()));
            }
            if let Err(error) = resume_windows_process(child.id()) {
                let _ = TerminateJobObject(job, 1);
                let _ = CloseHandle(job);
                return Err(error);
            }
            return Ok(Self { job: Some(job) });
        }

        #[cfg(not(any(unix, target_os = "windows")))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(process_group) = self.process_group.take() {
            unsafe {
                libc::killpg(process_group, libc::SIGKILL);
            }
        }
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job.take() {
            unsafe {
                let _ = TerminateJobObject(job, 1);
                let _ = CloseHandle(job);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn resume_windows_process(process_id: u32) -> std::io::Result<()> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut next = Thread32First(snapshot, &mut entry);
        while next.is_ok() {
            if entry.th32OwnerProcessID == process_id {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    .map_err(|error| std::io::Error::other(error.to_string()));
                let result = match thread {
                    Ok(thread) => {
                        let resume_result = ResumeThread(thread);
                        let _ = CloseHandle(thread);
                        if resume_result == u32::MAX {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(())
                        }
                    }
                    Err(error) => Err(error),
                };
                let _ = CloseHandle(snapshot);
                return result;
            }
            entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            next = Thread32Next(snapshot, &mut entry);
        }
        let _ = CloseHandle(snapshot);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "suspended version probe thread was not found",
    ))
}

impl Drop for VersionProbeContainment {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// True when creating a tempfile or spawning the version-probe child failed for
/// a reason the next attempt can recover from. Two families qualify:
///
/// - Resource exhaustion, mirroring the daemon's spawn-failure policy (Linux
///   EAGAIN/ENOMEM/ENFILE/EMFILE, macOS EAGAIN/ENOMEM/ENFILE/EMFILE).
/// - `ETXTBSY`, where the program file is momentarily held open for writing by
///   another process (see [`paths::is_text_file_busy`]).
///
/// Neither family is evidence about the child, and both clear on their own, so
/// letting either one through would report `ProcessSpawnFailed` for a program
/// that is perfectly runnable. `Interrupted` is deliberately excluded:
/// `try_wait` can surface EINTR after the child is already running, and
/// retrying the whole probe would leak that process group.
fn is_transient_probe_io_error(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::OutOfMemory
    ) {
        return true;
    }
    if paths::is_text_file_busy(error) {
        return true;
    }
    match error.raw_os_error() {
        #[cfg(target_os = "linux")]
        Some(11 | 12 | 23 | 24) => true,
        #[cfg(target_os = "macos")]
        Some(12 | 23 | 24 | 35) => true,
        _ => false,
    }
}

fn retry_transient_io<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut attempt = 0u32;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) if is_transient_probe_io_error(&error) && attempt < 3 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20 * u64::from(attempt)));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Marks an `io::Error` as having come from the probe HARNESS -- our own
/// tempfile, `dup`, `wait` or output-read plumbing -- rather than from the
/// child's `exec`.
///
/// Without this tag every failure inside [`output_with_timeout`] reached
/// [`classify_spawn_error`], which reads the errno as a statement ABOUT THE
/// CHILD. A `dup` that failed with `EMFILE` was therefore reported as
/// `ProcessSpawnFailed` even though no spawn verdict existed, and -- worse -- a
/// plumbing errno that happens to collide with `ENOEXEC`/`ERROR_BAD_EXE_FORMAT`
/// would have been reported as "the program is not an executable image", a
/// claim the probe never established.
#[derive(Debug)]
struct ProbeHarnessIoError(std::io::Error);

impl std::fmt::Display for ProbeHarnessIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "version probe harness I/O failed: {}", self.0)
    }
}

impl std::error::Error for ProbeHarnessIoError {}

/// Tag a harness-stage failure so it can never be read as the child's spawn
/// errno. The `kind` is preserved so the transient-retry predicate still works.
fn harness_io(error: std::io::Error) -> std::io::Error {
    let kind = error.kind();
    std::io::Error::new(kind, ProbeHarnessIoError(error))
}

fn is_probe_harness_io_error(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<ProbeHarnessIoError>())
}

/// Classify an [`output_with_timeout`] failure. Only a genuine spawn failure is
/// allowed to reach [`classify_spawn_error`]; a harness failure keeps the
/// undifferentiated residual bucket, because the child never got a verdict.
pub fn classify_probe_error(error: &std::io::Error) -> VersionProbeOutcome {
    if is_probe_harness_io_error(error) {
        return VersionProbeOutcome::ProcessSpawnFailed;
    }
    classify_spawn_error(error)
}

/// Poll a `try_wait`-shaped operation, absorbing `EINTR` in place.
///
/// `EINTR` here means "a signal arrived while we asked about an ALREADY RUNNING
/// child", which says nothing about the child. Retrying the whole probe would
/// leak that child's process group, so the interrupt is absorbed at the poll
/// itself and the surrounding deadline loop keeps its own bound.
fn poll_child_status<F>(mut op: F) -> std::io::Result<Option<std::process::ExitStatus>>
where
    F: FnMut() -> std::io::Result<Option<std::process::ExitStatus>>,
{
    loop {
        match op() {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// Run a tiny version command with a hard process boundary. `Command::output`
/// has no timeout and can strand both the process and its blocking worker; this
/// helper kills and reaps the child before returning `None` on timeout.
pub(crate) fn output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> std::io::Result<Option<Output>> {
    // Regular temporary files make the read independent of descendant handle
    // lifetime. A background process may inherit the handles, but unlike a
    // pipe an open regular file still returns EOF at its current length. The
    // byte cap also bounds a descendant that continuously writes.
    let stdout = retry_transient_io(tempfile::tempfile).map_err(harness_io)?;
    let stderr = retry_transient_io(tempfile::tempfile).map_err(harness_io)?;
    // `dup` is as fd-pressure-sensitive as the tempfile creation above it, so it
    // gets the same transient retry. Unretried, an `EMFILE` here surfaced as a
    // spawn verdict for a child that was never spawned.
    let child_stdout = retry_transient_io(|| stdout.try_clone()).map_err(harness_io)?;
    let child_stderr = retry_transient_io(|| stderr.try_clone()).map_err(harness_io)?;
    cmd.stdout(Stdio::from(child_stdout))
        .stderr(Stdio::from(child_stderr))
        // Give the child a null stdin. A version probe never feeds input, and an
        // inherited stdin lets a name-collision `hq` that reads stdin (the common
        // shape for a foreign jq-like `hq`) block for the full deadline and report
        // the opaque `timed_out` (HQ-DESKTOP-3P) instead of a classifiable
        // outcome. The real CLI and `npm root -g` never read stdin, so their
        // behaviour is unchanged.
        .stdin(Stdio::null());
    VersionProbeContainment::prepare(cmd);
    let mut child = retry_transient_io(|| cmd.spawn())?;
    let mut containment = match VersionProbeContainment::establish(&child) {
        Ok(containment) => containment,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(harness_io(error));
        }
    };
    let started = Instant::now();
    let status = loop {
        let polled = match poll_child_status(|| child.try_wait()) {
            Ok(polled) => polled,
            Err(error) => {
                containment.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(harness_io(error));
            }
        };
        if let Some(status) = polled {
            containment.terminate();
            break Some(status);
        }
        if started.elapsed() >= timeout {
            containment.terminate();
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(VERSION_PROCESS_POLL_INTERVAL);
    };

    // Re-reads from offset 0 on every attempt, so the retry is idempotent.
    let stdout =
        retry_transient_io(|| read_probe_output(stdout.try_clone()?)).map_err(harness_io)?;
    let stderr =
        retry_transient_io(|| read_probe_output(stderr.try_clone()?)).map_err(harness_io)?;

    Ok(status.map(|status| Output {
        status,
        stdout,
        stderr,
    }))
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

/// Whether the resolved `hq` is backed by a reachable `@indigoai-us/hq-cli`
/// package manifest — the sub-case that distinguishes the populations of an
/// unreadable-version occurrence. Closed and path-free for telemetry, and
/// ADDITIVE beside the existing probe fields: the event's message and grouping
/// are unchanged, so this cluster's regression watermark stays comparable.
///
/// `NotProbed` is the default the paths that never classify keep — no `hq`
/// resolved, or a manifest read that was INDETERMINATE (a permission/AV hold)
/// rather than a definitive absence. `Backed` means an hq-cli manifest was
/// reachable. `UnbackedManaged`/`UnbackedForeign` mean the manifest was
/// DEFINITIVELY absent, split by whether the shim sits inside one of HQ's own
/// managed-toolchain roots (HQ's orphaned shim, the largest reported population)
/// or outside them (an unrelated program named `hq`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HqBacking {
    #[default]
    NotProbed,
    Backed,
    UnbackedManaged,
    UnbackedForeign,
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
    /// Whether the resolved `hq` is backed by a reachable `@indigoai-us/hq-cli`
    /// manifest, and if not, whether it is HQ's own managed-toolchain orphan or
    /// an unrelated foreign program. Additive: names the sub-case of a recurrence
    /// without changing any existing field's name, position, or value.
    pub hq_backing: HqBacking,
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
            hq_backing: HqBacking::NotProbed,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestProbeFailure {
    Invalid,
    Unreadable,
}

fn read_hq_cli_package_version(pkg: &Path) -> Result<Option<String>, ()> {
    read_hq_cli_package_version_detailed(pkg).map_err(|_| ())
}

fn read_hq_cli_package_version_detailed(
    pkg: &Path,
) -> Result<Option<String>, ManifestProbeFailure> {
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
        Err(_) => return Err(ManifestProbeFailure::Unreadable),
    };
    let parsed: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| ManifestProbeFailure::Invalid)?;
    if parsed.get("name").and_then(|name| name.as_str()) != Some("@indigoai-us/hq-cli") {
        return Ok(None);
    }
    parsed
        .get("version")
        .and_then(|version| version.as_str())
        .map(|version| Some(version.to_string()))
        .ok_or(ManifestProbeFailure::Invalid)
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
    let (version, outcome, _) = version_from_hq_binary_probe_detailed(hq_bin);
    (version, outcome)
}

fn version_from_hq_binary_probe_detailed(
    hq_bin: &Path,
) -> (Option<String>, VersionProbeOutcome, paths::CandidateBacking) {
    let real = match std::fs::canonicalize(hq_bin) {
        Ok(real) => real,
        Err(_) => {
            return (
                None,
                VersionProbeOutcome::CanonicalizeFailed,
                paths::CandidateBacking::Indeterminate,
            )
        }
    };
    let mut saw_manifest_invalid = false;
    let mut saw_manifest_unreadable = false;
    for ancestor in real.ancestors() {
        match read_hq_cli_package_version_detailed(&ancestor.join("package.json")) {
            Ok(Some(version)) => {
                return (
                    Some(version),
                    VersionProbeOutcome::Succeeded,
                    paths::CandidateBacking::Backed,
                )
            }
            Ok(None) => {}
            Err(ManifestProbeFailure::Invalid) => saw_manifest_invalid = true,
            Err(ManifestProbeFailure::Unreadable) => saw_manifest_unreadable = true,
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
            return (
                Some(version),
                VersionProbeOutcome::Succeeded,
                paths::CandidateBacking::Backed,
            );
        }
    }
    // Bun's global shim is also a plain script. Its package manifest lives in
    // `<BUN_INSTALL>/install/global/node_modules`, outside the shim's ancestor
    // chain, so read that exact global tree before considering npm layouts.
    if is_bun_global_shim(&hq_bin_str) {
        if let Some(home) = bun_home_from_hq_bin(hq_bin) {
            if let Some(version) = installed_hq_cli_version_in_bun_global(&home) {
                return (
                    Some(version),
                    VersionProbeOutcome::Succeeded,
                    paths::CandidateBacking::Backed,
                );
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
            match read_hq_cli_package_version_detailed(&package_json) {
                Ok(Some(version)) => {
                    return (
                        Some(version),
                        VersionProbeOutcome::Succeeded,
                        paths::CandidateBacking::Backed,
                    )
                }
                Ok(None) => {}
                Err(ManifestProbeFailure::Invalid) => saw_manifest_invalid = true,
                Err(ManifestProbeFailure::Unreadable) => saw_manifest_unreadable = true,
            }
        }
    }
    let outcome = if saw_manifest_invalid || saw_manifest_unreadable {
        VersionProbeOutcome::ManifestReadOrParseFailed
    } else {
        VersionProbeOutcome::PackageNotFound
    };
    let backing = match (saw_manifest_invalid, saw_manifest_unreadable) {
        (true, false) => paths::CandidateBacking::ManifestInvalid,
        (false, true) => paths::CandidateBacking::ManifestUnreadable,
        (false, false) => paths::CandidateBacking::AbsentDefinitive,
        (true, true) => paths::CandidateBacking::Indeterminate,
    };
    (None, outcome, backing)
}

/// Whether an `@indigoai-us/hq-cli` package manifest is reachable from a resolved
/// `hq` binary — the resolver's "is this a real hq-cli install, not a foreign or
/// orphaned program named `hq`" question. It reuses the EXACT layout walk the
/// version probe uses ([`version_from_hq_binary_probe`]), so a candidate
/// classified [`CandidateBacking::Backed`] here is precisely one the version
/// probe can read a version from — backing and version-reading can never
/// disagree. Bounded filesystem reads only: no child process, no network.
///
/// [`CandidateBacking::AbsentDefinitive`] requires a definitive "package is not
/// here" answer from every reachable location. A manifest that could not be READ
/// or parsed (a permission lock, an antivirus hold) or a binary that could not be
/// canonicalized is [`CandidateBacking::Indeterminate`] — the resolver must never
/// reject or demote on that, or a transient blip turns a working machine into a
/// reinstall. This is the same `Ok(None)`-vs-`Err(())` distinction
/// [`read_hq_cli_package_version`] already draws.
pub fn hq_cli_backing(hq_bin: &Path) -> paths::CandidateBacking {
    version_from_hq_binary_probe_detailed(hq_bin).2
}

/// Map an already-computed binary-anchor outcome for a resolved `hq` into the
/// closed telemetry backing token — with NO second filesystem walk, since the
/// anchor probe already answered the reachability question. `Backed` on a
/// manifest read, `Unbacked{Managed,Foreign}` on a DEFINITIVE absence (split by
/// managed-toolchain provenance), `NotProbed` for no `hq` or an indeterminate
/// read. Mirrors [`hq_cli_backing`]'s mapping so the resolver's decision and the
/// reported sub-case can never disagree.
fn classify_hq_backing(hq: Option<&Path>, binary_anchor: VersionProbeOutcome) -> HqBacking {
    let Some(hq) = hq else {
        return HqBacking::NotProbed;
    };
    match binary_anchor {
        VersionProbeOutcome::Succeeded => HqBacking::Backed,
        VersionProbeOutcome::PackageNotFound => {
            if paths::hq_bin_in_managed_root(hq) {
                HqBacking::UnbackedManaged
            } else {
                HqBacking::UnbackedForeign
            }
        }
        _ => HqBacking::NotProbed,
    }
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
    hq_version_string_probe_with_timeout(bin, path, VERSION_PROCESS_TIMEOUT)
}

fn hq_version_string_probe_with_timeout(
    bin: &Path,
    path: &str,
    timeout: Duration,
) -> (Option<String>, VersionProbeOutcome) {
    let bin = bin.to_string_lossy();
    let mut cmd = paths::spawn_command(&bin, &[]);
    let out = match output_with_timeout(
        cmd.arg("--version").env("PATH", path),
        timeout,
    ) {
        Ok(Some(output)) => output,
        Ok(None) => return (None, VersionProbeOutcome::TimedOut),
        Err(error) => return (None, classify_probe_error(&error)),
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
fn hq_version_via_node_with_timeout(
    node: &Path,
    program: &Path,
    path: &str,
    timeout: Duration,
) -> (Option<String>, VersionProbeOutcome) {
    let node = node.to_string_lossy();
    let program = program.to_string_lossy();
    let mut cmd = paths::spawn_command(node.as_ref(), &[program.as_ref(), "--version"]);
    let out = match output_with_timeout(cmd.env("PATH", path), timeout) {
        Ok(Some(output)) => output,
        Ok(None) => return (None, VersionProbeOutcome::TimedOut),
        Err(error) => return (None, classify_probe_error(&error)),
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
fn hq_version_with_recovery_timeout(
    hq: Option<&Path>,
    path: &str,
    managed: Option<&crate::toolchain::ManagedRuntime>,
    timeout: Duration,
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

    let (local, outcome) = hq_version_string_probe_with_timeout(hq, path, timeout);
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
        let (recovered, recovered_outcome) =
            hq_version_string_probe_with_timeout(hq, &widened, timeout);
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
            let (recovered, recovered_outcome) =
                hq_version_via_node_with_timeout(node, hq, &widened, timeout);
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
                    hq_backing: classify_hq_backing(Some(hq_path), binary_anchor),
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
fn probe_local_version_with_timeout(
    hq: Option<&Path>,
    npm: Option<&str>,
    path: &str,
    hq_version_timeout: Duration,
) -> LocalVersionProbeResult {
    let kind = match hq {
        Some(_) => ResolvedProgramKind::Exe,
        None => ResolvedProgramKind::NotResolved,
    };
    probe_local_version_with_managed_and_timeout(
        hq,
        kind,
        None,
        npm,
        path,
        hq_version_timeout,
    )
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
    probe_local_version_with_managed_and_timeout(
        hq,
        resolved_program_kind,
        managed,
        npm,
        path,
        VERSION_PROCESS_TIMEOUT,
    )
}

#[cfg(test)]
fn probe_local_version_with_managed_and_timeout(
    hq: Option<&Path>,
    resolved_program_kind: ResolvedProgramKind,
    managed: Option<&crate::toolchain::ManagedRuntime>,
    npm: Option<&str>,
    path: &str,
    hq_version_timeout: Duration,
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
                hq_backing: classify_hq_backing(hq, binary_anchor),
                ..LocalVersionProbeDiagnostics::not_attempted()
            },
        };
    }
    probe_local_version_after_binary_with_timeout(
        hq,
        binary_anchor,
        binary_anchor_shape,
        resolved_program_kind,
        managed,
        npm,
        path,
        hq_version_timeout,
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
    probe_local_version_after_binary_with_timeout(
        hq,
        binary_anchor,
        binary_anchor_shape,
        resolved_program_kind,
        managed,
        npm,
        path,
        VERSION_PROCESS_TIMEOUT,
    )
}

fn probe_local_version_after_binary_with_timeout(
    hq: Option<&Path>,
    binary_anchor: VersionProbeOutcome,
    binary_anchor_shape: BinaryAnchorShape,
    resolved_program_kind: ResolvedProgramKind,
    managed: Option<&crate::toolchain::ManagedRuntime>,
    npm: Option<&str>,
    path: &str,
    hq_version_timeout: Duration,
) -> LocalVersionProbeResult {
    let hq_installed = hq.is_some();
    // The backing sub-case is derived from the binary-anchor outcome already in
    // hand (no extra filesystem walk); it names why a resolved `hq` is unreadable.
    let hq_backing = classify_hq_backing(hq, binary_anchor);
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
                hq_backing,
                ..LocalVersionProbeDiagnostics::not_attempted()
            },
        };
    }

    let (local, hq_version, managed_runtime, interpreter_recovery) =
        hq_version_with_recovery_timeout(hq, path, managed, hq_version_timeout);
    // Make `hq_installed` truthful for the definitively-foreign case. A resolved
    // `hq` we could read NO version from (npm-root and `hq --version` both failed)
    // AND whose backing is a DEFINITIVE package-absent OUTSIDE every managed root
    // is not an hq-cli install — it is an unrelated program named `hq`
    // (HQ-DESKTOP-3P). Reporting it as installed both fires the false
    // unreadable-version warning on every launch and BLOCKS the installer
    // (`cli_install_needed(None, latest, true)` is false), so the machine can
    // never converge. Flipping it to false silences the false alarm and lets the
    // already-shipped installer put the real CLI on the machine, after which the
    // resolver's backed preference selects HQ's own copy. Every OTHER case keeps
    // reporting: an INDETERMINATE read (`HqBacking::NotProbed` — an unreadable or
    // unparseable manifest, a canonicalize failure, an AV/permission hold) and an
    // `UnbackedManaged` orphan both stay `hq_installed = true`, and a version read
    // via the npm-root fallback (which returned above) keeps it true too — the
    // flip is gated on `local.is_none()`.
    let hq_installed =
        hq_installed && !(local.is_none() && hq_backing == HqBacking::UnbackedForeign);
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
            hq_backing,
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

/// Minimum `@indigoai-us/hq-cli` version the desktop app accepts as current
/// enough to leave alone until the next *scheduled* check.
///
/// 5.345.46 adds the Codex hook trust step and `HQ_ROOT` / `CLAUDE_PROJECT_DIR`
/// environment for global Claude hooks, alongside the `install --global
/// --runtime` and matching uninstall commands used by HQ Anywhere.
pub const HQ_CLI_MIN_VERSION: &str = "5.345.46";

/// Is a *readable* installed version below [`HQ_CLI_MIN_VERSION`]?
///
/// `None` — no CLI, or a present-but-unreadable binary — is NOT below the
/// floor. Those arms keep their existing handling (`cli_install_needed`,
/// `should_report_unreadable_version`) and the scheduled cadence; the floor
/// only accelerates the case where the app can *see* an old version.
pub fn cli_below_floor(local: Option<&str>) -> bool {
    cli_below_floor_of(local, HQ_CLI_MIN_VERSION)
}

/// [`cli_below_floor`] against an explicit floor, so the comparison is testable
/// independently of the shipped constant.
pub fn cli_below_floor_of(local: Option<&str>, floor: &str) -> bool {
    local.is_some_and(|installed| cmp_semver(installed, floor) == std::cmp::Ordering::Less)
}

/// What the background CLI checker does at launch, before its scheduled
/// stagger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchCliCheck {
    /// The installed CLI reads below [`HQ_CLI_MIN_VERSION`]: run the check and
    /// the install immediately instead of waiting out the launch stagger.
    RepairNow {
        /// The below-floor version that was read, for the log line.
        local: String,
    },
    /// Current, missing, or unreadable: nothing to accelerate — wait for the
    /// scheduled cadence exactly as before.
    Scheduled,
}

/// Decide the launch behaviour from the network-free local version probe.
pub fn launch_cli_check(local: Option<&str>) -> LaunchCliCheck {
    launch_cli_check_with_floor(local, HQ_CLI_MIN_VERSION)
}

/// [`launch_cli_check`] against an explicit floor.
pub fn launch_cli_check_with_floor(local: Option<&str>, floor: &str) -> LaunchCliCheck {
    match local {
        Some(installed) if cli_below_floor_of(Some(installed), floor) => {
            LaunchCliCheck::RepairNow {
                local: installed.to_string(),
            }
        }
        _ => LaunchCliCheck::Scheduled,
    }
}

/// May the background loop install right now?
///
/// The user's `autoUpdate` opt-out is honoured for an ordinary "a newer version
/// exists" upgrade. A floor repair is not an upgrade in that sense: below
/// [`HQ_CLI_MIN_VERSION`] the CLI cannot serve the hq-core contract, so — like
/// the hq-core hook, which has no opt-out — the repair runs regardless of the
/// toggle. The non-convergent marker is still consulted by the caller.
pub fn auto_install_allowed(auto_update_enabled: bool, floor_repair: bool) -> bool {
    auto_update_enabled || floor_repair
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

/// Whether HQ aimed this install at the copy the app now executes — the closed
/// input that makes the durable ForeignManaged block CONDITIONAL. A residual
/// foreign-managed verdict may write the durable marker only when HQ either
/// aimed at the executed copy in place (and still could not converge) or could
/// not aim at all (an undrivable layout). A drivable copy HQ did NOT aim at this
/// run stays observable and episode-bounded so the corrected aim converges on
/// the next cycle instead of wedging auto-update. Default is
/// [`Self::Undrivable`] so every existing caller keeps today's
/// block-on-foreign behaviour unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecutedCopyAim {
    /// The install was aimed at the executed copy's own user-owned prefix and
    /// run with that copy's own co-located npm. A residual ForeignManaged
    /// verdict is a genuinely undrivable layout and blocks exactly as before.
    Aimed,
    /// The executed copy is not one HQ can drive in place: a system/Homebrew
    /// prefix, a managed cross-root split, or a user-owned prefix with no
    /// co-located npm. A ForeignManaged verdict blocks as before.
    #[default]
    Undrivable,
    /// A drivable user-owned prefix HQ did NOT aim at this run (the pre-install
    /// resolution did not identify it). A ForeignManaged verdict stays
    /// observable and episode-bounded — no durable marker — so the corrected aim
    /// converges on the next cycle.
    NotYetAimed,
}

impl ExecutedCopyAim {
    /// Closed path-free token used by the install-non-convergent event.
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::Aimed => "aimed",
            Self::Undrivable => "undrivable",
            Self::NotYetAimed => "not_yet_aimed",
        }
    }

    /// Whether a ForeignManaged verdict under this aim may write the durable
    /// marker. Only [`Self::NotYetAimed`] must stay non-blocking.
    pub fn foreign_verdict_may_block(self) -> bool {
        !matches!(self, Self::NotYetAimed)
    }
}

/// Closed classification of the prefix containing the `hq` binary that the
/// desktop resolves after an install. This is diagnostic only; it never changes
/// resolution or the installer target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResolvedPrefixClass {
    ManagedToolchain,
    User,
    System,
    Other,
    #[default]
    Unresolved,
}

impl ResolvedPrefixClass {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::ManagedToolchain => "managed_toolchain",
            Self::User => "user",
            Self::System => "system",
            Self::Other => "other",
            Self::Unresolved => "unresolved",
        }
    }
}

/// Safe, path-free facts about the resolved CLI prefix. Raw paths are consumed
/// only while deriving these values and are never retained in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResolvedPrefixTelemetry {
    pub class: ResolvedPrefixClass,
    pub under_home: bool,
    pub colocated_npm: bool,
    pub matches_installer_prefix: bool,
}

pub fn resolved_prefix_telemetry(
    hq_bin: &str,
    installer_prefix: Option<&str>,
    managed_roots: &[PathBuf],
    home: Option<&Path>,
    source: paths::ResolutionSource,
) -> ResolvedPrefixTelemetry {
    let Some(prefix) = npm_prefix_from_hq_bin(hq_bin) else {
        return ResolvedPrefixTelemetry::default();
    };
    let path = PathBuf::from(&prefix);
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let canonical_roots: Vec<PathBuf> = managed_roots
        .iter()
        .map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| root.clone()))
        .collect();
    let canonical_home =
        home.map(|home| std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()));
    let class = if canonical_roots
        .iter()
        .any(|root| paths::path_is_within(&path, root))
    {
        ResolvedPrefixClass::ManagedToolchain
    } else if paths::is_user_owned_prefix(&path, managed_roots, canonical_home.as_deref()) {
        ResolvedPrefixClass::User
    } else if source == paths::ResolutionSource::SystemPrefix {
        ResolvedPrefixClass::System
    } else {
        ResolvedPrefixClass::Other
    };
    let matches_installer_prefix = installer_prefix.is_some_and(|installer| {
        let installer = PathBuf::from(installer);
        let installer = std::fs::canonicalize(&installer).unwrap_or(installer);
        paths::path_is_within(&path, &installer) && paths::path_is_within(&installer, &path)
    });
    ResolvedPrefixTelemetry {
        class,
        under_home: canonical_home
            .as_deref()
            .is_some_and(|home| paths::path_is_within(&path, home)),
        colocated_npm: colocated_npm_path(&path).exists(),
        matches_installer_prefix,
    }
}

/// Result of the single corrective attempt to install into a deferred,
/// foreign-managed CLI copy's own user prefix. These values are closed and
/// path-free because they are attached to the non-convergence event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecutedCopyReaim {
    #[default]
    NotAttempted,
    Converged,
    StillForeign,
    PreparationFailed,
    InstallFailed,
    SpawnFailed,
    RefusedNoAim,
}

impl ExecutedCopyReaim {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::NotAttempted => "not-attempted",
            Self::Converged => "converged",
            Self::StillForeign => "still-foreign",
            Self::PreparationFailed => "preparation-failed",
            Self::InstallFailed => "install-failed",
            Self::SpawnFailed => "spawn-failed",
            Self::RefusedNoAim => "refused-no-aim",
        }
    }
}

/// Pure gate for the in-run foreign-copy re-aim. A drivable copy that was not
/// selected by the original install is the only eligible shape; aimed,
/// undrivable, and non-foreign outcomes keep their existing finalization path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutedCopyReaimGate {
    Attempt,
    RefusedNotForeign,
    RefusedNotDeferred,
    RefusedNoAim,
}

pub fn executed_copy_reaim_gate(
    kind: Option<NonConvergenceKind>,
    executed_copy_aim: ExecutedCopyAim,
    user_aim_available: bool,
) -> ExecutedCopyReaimGate {
    if kind != Some(NonConvergenceKind::ForeignManaged) {
        return ExecutedCopyReaimGate::RefusedNotForeign;
    }
    if executed_copy_aim != ExecutedCopyAim::NotYetAimed {
        return ExecutedCopyReaimGate::RefusedNotDeferred;
    }
    if !user_aim_available {
        return ExecutedCopyReaimGate::RefusedNoAim;
    }
    ExecutedCopyReaimGate::Attempt
}

pub fn executed_copy_reaim_outcome(
    gate: ExecutedCopyReaimGate,
    install_exit_ok: Option<bool>,
    converged: bool,
) -> ExecutedCopyReaim {
    match gate {
        ExecutedCopyReaimGate::RefusedNoAim => ExecutedCopyReaim::RefusedNoAim,
        ExecutedCopyReaimGate::Attempt => match install_exit_ok {
            None => ExecutedCopyReaim::SpawnFailed,
            Some(false) => ExecutedCopyReaim::InstallFailed,
            Some(true) if converged => ExecutedCopyReaim::Converged,
            Some(true) => ExecutedCopyReaim::StillForeign,
        },
        ExecutedCopyReaimGate::RefusedNotForeign | ExecutedCopyReaimGate::RefusedNotDeferred => {
            ExecutedCopyReaim::NotAttempted
        }
    }
}

/// Whether the shim the aimed prefix should expose after a delivered install is
/// present. A closed, path-free telemetry token (the `delivered_prefix_shim`
/// tag) that ALSO gates the durable block: a ForeignManaged verdict whose aimed
/// prefix delivered the target but exposes no shim is HQ's OWN incomplete
/// install, not a foreign layout HQ cannot drive — kept non-blocking and
/// episode-bounded so the next scheduled check reinstalls. Default
/// [`Self::Unknown`] (no prefix, or delivery not proven) preserves today's
/// blocking behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveredPrefixShim {
    #[default]
    Unknown,
    Present,
    Absent,
}

impl DeliveredPrefixShim {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Present => "present",
            Self::Absent => "absent",
        }
    }
}

/// What HQ's in-run repair of a settings-PATH foreign shadow achieved, as a
/// CLOSED telemetry token (never a path). It is the input that makes the
/// ForeignManaged blocking decision conditional for the settings-PATH shape: a
/// run whose repair rewrote the winning `.claude` settings file's `env.PATH`
/// (hoisting HQ's managed toolchain ahead of the stale foreign copy) writes NO
/// durable marker, so the next resolution lands HQ's own current copy and
/// converges; every refusal or write-failure keeps today's blocking behaviour
/// byte-for-byte. Mirrors [`ManagedShadowRepairOutcome`]; default
/// [`Self::NotAttempted`] so every existing caller is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsPathRepair {
    /// No settings-PATH repair was attempted for this decision — the value every
    /// non-settings-PATH run carries, and the pre-repair classification.
    #[default]
    NotAttempted,
    /// The winning settings file's `env.PATH` was rewritten managed-first. HQ
    /// owns the fix, so this run must not wedge auto-update for this version.
    Rewritten,
    /// The executed copy did not come from the settings-PATH lane, so rewriting
    /// the settings PATH could not change what resolves. Nothing was written.
    RefusedNotSettingsLane,
    /// HQ's managed prefix exposes no runnable `hq` to hoist ahead of the foreign
    /// copy. Nothing was written.
    RefusedNoManagedCopy,
    /// The executed copy is not strictly older than HQ's managed copy, so a hoist
    /// would not change the resolved version — a deliberate same-or-newer foreign
    /// copy is left where the user put it. Nothing was written.
    RefusedNotStale,
    /// The rewrite was attempted but the settings file could not be written (an
    /// I/O error, a symlink escaping the HQ folder, or a non-object document).
    WriteFailed,
}

impl SettingsPathRepair {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::NotAttempted => "not-attempted",
            Self::Rewritten => "rewritten",
            Self::RefusedNotSettingsLane => "refused-not-settings-lane",
            Self::RefusedNoManagedCopy => "refused-no-managed-copy",
            Self::RefusedNotStale => "refused-not-stale",
            Self::WriteFailed => "write-failed",
        }
    }
}

/// Whether the winning `.claude` settings file's `env.PATH` lists HQ's managed
/// npm-global bin dir at all — the `managed_bin_in_settings_path` telemetry
/// token, so a residual settings-PATH event names whether the file the resolver
/// reads even mentioned the managed CLI's directory. Closed and path-free;
/// default [`Self::Unknown`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ManagedBinInSettingsPath {
    Present,
    Absent,
    #[default]
    Unknown,
}

impl ManagedBinInSettingsPath {
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
        }
    }
}

/// Classify whether the winning settings PATH lists HQ's managed npm-global bin
/// dir. `Unknown` when no settings file supplies a PATH; otherwise `Present`
/// exactly when `managed_bin` is among the resolved settings dirs. Pure so the
/// tag is unit-testable with fixture dirs.
pub fn managed_bin_in_settings_path(
    file: paths::SettingsPathFile,
    settings_dirs: &[PathBuf],
    managed_bin: &Path,
) -> ManagedBinInSettingsPath {
    if file == paths::SettingsPathFile::None {
        return ManagedBinInSettingsPath::Unknown;
    }
    if settings_dirs.iter().any(|dir| dir == managed_bin) {
        ManagedBinInSettingsPath::Present
    } else {
        ManagedBinInSettingsPath::Absent
    }
}

/// The closed settings-PATH telemetry triple a non-convergent event carries:
/// which file won ([`paths::SettingsPathFile`]), whether it listed the managed
/// bin dir, and what the in-run repair achieved. Report-only except `repair`,
/// which also gates the durable ForeignManaged block. `Copy` + `Default`
/// (`NotAttempted` / `None` / `Unknown`) so every existing `PostInstallContext`
/// keeps today's behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SettingsPathTelemetry {
    pub repair: SettingsPathRepair,
    pub file: paths::SettingsPathFile,
    pub managed_bin: ManagedBinInSettingsPath,
    pub executed_copy_aim: ExecutedCopyAim,
    pub resolved_prefix: ResolvedPrefixTelemetry,
}

/// Whether HQ should attempt the settings-PATH repair, or the closed reason it
/// must not. Pure over the facts the caller gathered — the executed copy's
/// resolution lane, HQ's runnable managed copy version, and the executed version
/// — so the gate is unit-testable without touching the filesystem. Only
/// [`Self::Attempt`] proceeds to rewrite the winning settings file; every refusal
/// maps to the matching [`SettingsPathRepair`] value and leaves today's blocking
/// behaviour unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsPathRepairGate {
    Attempt,
    RefusedNotSettingsLane,
    RefusedNoManagedCopy,
    RefusedNotStale,
}

pub fn settings_path_repair_gate(
    hq_bin_lane: paths::ResolutionSource,
    managed_copy_version: Option<&str>,
    executed_version: Option<&str>,
) -> SettingsPathRepairGate {
    // Only the settings-PATH lane is repairable by rewriting the settings PATH: a
    // login-shell or managed-toolchain copy would resolve the same whatever the
    // settings file lists.
    if hq_bin_lane != paths::ResolutionSource::SettingsPath {
        return SettingsPathRepairGate::RefusedNotSettingsLane;
    }
    let Some(managed) = managed_copy_version else {
        return SettingsPathRepairGate::RefusedNoManagedCopy;
    };
    // The managed copy must be STRICTLY newer than the executed (shadowing) copy,
    // else hoisting HQ's toolchain ahead of the foreign dir would not change the
    // resolved version. An unreadable executed version cannot be proven stale, so
    // it refuses too.
    match executed_version {
        Some(executed) if cmp_semver(managed, executed) == std::cmp::Ordering::Greater => {
            SettingsPathRepairGate::Attempt
        }
        _ => SettingsPathRepairGate::RefusedNotStale,
    }
}

/// Map a [`SettingsPathRepairGate`] plus whether the rewrite actually wrote into
/// the [`SettingsPathRepair`] telemetry outcome. Pure so the non-fatal mapping is
/// unit-testable. Mirrors `managed_shadow_repair_outcome`.
pub fn settings_path_repair_outcome(
    gate: SettingsPathRepairGate,
    wrote: bool,
) -> SettingsPathRepair {
    match gate {
        SettingsPathRepairGate::Attempt if wrote => SettingsPathRepair::Rewritten,
        SettingsPathRepairGate::Attempt => SettingsPathRepair::WriteFailed,
        SettingsPathRepairGate::RefusedNotSettingsLane => {
            SettingsPathRepair::RefusedNotSettingsLane
        }
        SettingsPathRepairGate::RefusedNoManagedCopy => SettingsPathRepair::RefusedNoManagedCopy,
        SettingsPathRepairGate::RefusedNotStale => SettingsPathRepair::RefusedNotStale,
    }
}

/// The ordinary-update install aim: the prefix to install INTO and the npm to
/// RUN, chosen so HQ upgrades the copy the app will actually execute. Returned
/// by [`user_prefix_aim_decision`] only when the executed copy sits in a
/// drivable user-owned prefix that ships its own npm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPrefixAim {
    /// The prefix to pass to npm's `--prefix` — the executed copy's own prefix.
    pub prefix: String,
    /// The npm binary to RUN — the executed copy's own co-located npm, so build
    /// ABI and execute ABI match and HQ's managed npm never writes here.
    pub npm: String,
}

/// Keep a managed-toolchain retry aimed at the executable copy when that copy's
/// Node ABI is known to match HQ's managed Node. The retry still uses HQ's npm,
/// but identical ABIs mean the package it writes is safe for the user's selected
/// runtime. An unknown or different ABI must stay out of the user's prefix: a
/// native dependency built for HQ's runtime could otherwise break their CLI.
///
/// `executed_user_aim` is only produced after package ownership, a user-owned
/// prefix, and a co-located npm have already been proven by the caller. This
/// helper deliberately cannot invent a target from a raw path.
pub fn managed_retry_user_prefix_aim(
    executed_user_aim: Option<&UserPrefixAim>,
    executed_node_abi: Option<u32>,
    managed_node_abi: u32,
) -> Option<UserPrefixAim> {
    (executed_node_abi == Some(managed_node_abi))
        .then(|| executed_user_aim.cloned())
        .flatten()
}

/// User-facing guidance when HQ can identify the executable user-owned CLI but
/// cannot safely install packages built by its managed runtime into that prefix.
/// Kept in the core module so the app's action text has a platform-independent
/// regression test.
pub fn managed_retry_user_copy_detail() -> String {
    "HQ could not safely update the `hq` command this Mac is using because its Node runtime is incompatible with HQ's managed updater. Install or select Node 22 LTS, then reinstall the CLI with that runtime. If you use nvm, run `nvm install 22 && nvm use 22 && npm install -g @indigoai-us/hq-cli@latest`. HQ left that command unchanged.".to_string()
}

/// Pure core of the ordinary-update selector: choose to aim at the executed
/// copy's own user-owned prefix (running that prefix's co-located npm) exactly
/// when all three hold — a derivable hq prefix, that prefix is user-owned
/// ([`paths::is_user_owned_prefix`]), and a co-located npm exists there. `None`
/// means "no user aim": keep the managed / hq-derived prefix and the resolved
/// npm, i.e. every case [`prefer_managed_prefix`] already handled. Pure over its
/// inputs (the caller resolves ownership + existence) so the choice is
/// unit-testable without touching the filesystem.
pub fn user_prefix_aim_decision(
    hq_derived_prefix: Option<&str>,
    hq_prefix_is_user_owned: bool,
    colocated_user_npm: Option<&str>,
) -> Option<UserPrefixAim> {
    match (
        hq_derived_prefix,
        hq_prefix_is_user_owned,
        colocated_user_npm,
    ) {
        (Some(prefix), true, Some(npm)) if !prefix.is_empty() && !npm.is_empty() => {
            Some(UserPrefixAim {
                prefix: prefix.to_string(),
                npm: npm.to_string(),
            })
        }
        _ => None,
    }
}

/// The npm binary co-located with a global prefix: `<prefix>/bin/npm` on unix,
/// `<prefix>\npm.cmd` on Windows (npm writes its shims flat into the prefix).
pub fn colocated_npm_path(prefix: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        prefix.join("npm.cmd")
    }
    #[cfg(not(target_os = "windows"))]
    {
        prefix.join("bin").join("npm")
    }
}

/// The `hq` shim a global prefix should expose after a delivered install:
/// `<prefix>/bin/hq` on unix, `<prefix>\hq.cmd` on Windows.
fn prefix_hq_shim_path(prefix: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        prefix.join("hq.cmd")
    }
    #[cfg(not(target_os = "windows"))]
    {
        prefix.join("bin").join("hq")
    }
}

/// Classify, against the copy the app EXECUTES after the install, whether HQ
/// aimed this run at it in place. Touches the filesystem only to confirm the
/// co-located npm exists, so it lives in the core crate where it is unit-testable
/// with tempdirs (the app crate cannot be built on every host). See
/// [`ExecutedCopyAim`] for how the result gates the durable ForeignManaged block.
pub fn executed_copy_aim_for(
    post_install_hq: &str,
    aimed_prefix: Option<&str>,
    installer_npm: &str,
    managed_roots: &[PathBuf],
    home: Option<&Path>,
) -> ExecutedCopyAim {
    // No derivable prefix behind the executed copy (an asdf-style shim dir, or
    // the bare sentinel) means HQ cannot aim in place — undrivable.
    let Some(executed_prefix) = npm_prefix_from_hq_bin(post_install_hq) else {
        return ExecutedCopyAim::Undrivable;
    };
    let executed_prefix_path = Path::new(&executed_prefix);
    let user_owned = paths::is_user_owned_prefix(executed_prefix_path, managed_roots, home);
    let colocated = colocated_npm_path(executed_prefix_path);
    if !user_owned || !colocated.exists() {
        // A system/Homebrew prefix, a managed cross-root split, or a user prefix
        // with no co-located npm: a residual ForeignManaged verdict is a genuine
        // undrivable layout and blocks as before.
        return ExecutedCopyAim::Undrivable;
    }
    // Drivable: did THIS run aim at exactly this copy's own prefix with its own
    // co-located npm?
    let aimed_here =
        aimed_prefix == Some(executed_prefix.as_str()) && Path::new(installer_npm) == colocated;
    if aimed_here {
        ExecutedCopyAim::Aimed
    } else {
        ExecutedCopyAim::NotYetAimed
    }
}

/// Whether the aimed prefix exposes its `hq` shim after a delivered install.
/// Only meaningful once HQ aimed at a concrete prefix AND proved it delivered
/// the target there; otherwise [`DeliveredPrefixShim::Unknown`]. Core-crate and
/// filesystem-touching so it is locally unit-testable.
pub fn delivered_prefix_shim_for(
    aimed_prefix: Option<&str>,
    delivered_version: Option<&str>,
) -> DeliveredPrefixShim {
    match (aimed_prefix, delivered_version) {
        (Some(prefix), Some(_)) if !prefix.is_empty() => {
            // Existence alone is not enough: a `bin/hq` that is a directory or a
            // non-executable file is skipped by resolution, so the app still
            // resolves a stale copy and the run reads ForeignManaged. Treating
            // that as `Present` would permit the durable marker and suppress the
            // retry that repairs the partial install, so require the same
            // runnable-shim contract resolution uses.
            if paths::is_runnable_shim(&prefix_hq_shim_path(Path::new(prefix))) {
                DeliveredPrefixShim::Present
            } else {
                DeliveredPrefixShim::Absent
            }
        }
        _ => DeliveredPrefixShim::Unknown,
    }
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
    /// Which resolution lane produced the executed `hq` — a closed, path-free
    /// token ([`paths::ResolutionSource`]) emitted as `hq_bin_lane`. Names
    /// settings-PATH parity vs a user/system/login-shell copy so a residual
    /// occurrence identifies its own lane without another planning round.
    pub hq_bin_lane: paths::ResolutionSource,
    /// Whether the aimed prefix exposes its `hq` shim after a delivered install,
    /// emitted as the closed `delivered_prefix_shim` tag. Distinguishes a
    /// foreign layout HQ cannot drive from HQ's own incomplete install.
    pub delivered_prefix_shim: DeliveredPrefixShim,
    /// The closed settings-PATH telemetry triple — which `.claude` file supplied
    /// the winning `env.PATH`, whether it listed HQ's managed bin dir, and what
    /// the in-run repair achieved — emitted as `settings_path_file`,
    /// `managed_bin_in_settings_path`, and `settings_path_repair`. Names a
    /// settings-PATH foreign shadow's own mechanism without another planning
    /// round (HQ-DESKTOP-46).
    pub settings_path: SettingsPathTelemetry,
    /// Outcome of the bounded in-run attempt to re-aim an install into a
    /// deferred foreign-managed CLI copy's own user prefix (HQ-DESKTOP-46).
    pub executed_copy_reaim: ExecutedCopyReaim,
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
    /// Whether HQ aimed this install at the copy the app now executes. Gates the
    /// durable ForeignManaged block: a [`ExecutedCopyAim::NotYetAimed`] run stays
    /// observable and episode-bounded so the corrected aim converges next cycle.
    /// The `npm()` constructor defaults it to [`ExecutedCopyAim::Undrivable`], so
    /// every existing caller keeps today's block-on-foreign behaviour.
    pub executed_copy_aim: ExecutedCopyAim,
    /// The resolution lane of the executed `hq`, for the `hq_bin_lane` tag.
    /// Report-only; the `npm()` constructor defaults it to `NotResolved`.
    pub hq_bin_lane: paths::ResolutionSource,
    /// Whether the aimed prefix exposes its `hq` shim after a delivered install.
    /// Gates the durable block for the partial-install shape (delivered but shim
    /// absent stays non-blocking) AND rides the `delivered_prefix_shim` tag. The
    /// `npm()` constructor defaults it to [`DeliveredPrefixShim::Unknown`].
    pub delivered_prefix_shim: DeliveredPrefixShim,
    /// The settings-PATH telemetry triple. Its `repair` field gates the durable
    /// ForeignManaged block (a `Rewritten` repair stays non-blocking so the next
    /// resolution converges); all three ride the non-convergent event. The
    /// `npm()` constructor defaults it to [`SettingsPathTelemetry::default`]
    /// (`NotAttempted` / `None` / `Unknown`), so every existing caller is
    /// unchanged.
    pub settings_path: SettingsPathTelemetry,
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
            // Defaults preserve today's behaviour exactly: a ForeignManaged
            // verdict blocks (Undrivable), no resolution lane is asserted, and no
            // shim state is known. The production finalize path threads the real
            // values in via the builders below.
            executed_copy_aim: ExecutedCopyAim::Undrivable,
            hq_bin_lane: paths::ResolutionSource::NotResolved,
            delivered_prefix_shim: DeliveredPrefixShim::Unknown,
            // No settings-PATH repair attempted and no settings telemetry known:
            // preserves today's block-on-foreign behaviour and emits the
            // not-attempted / none / unknown tokens.
            settings_path: SettingsPathTelemetry::default(),
        }
    }

    /// Supply the HQ-managed toolchain roots so the npm arm can distinguish an
    /// HQ-owned same-root shadow from a genuinely foreign layout.
    pub fn with_managed_roots(mut self, managed_roots: &'a [PathBuf]) -> Self {
        self.managed_roots = managed_roots;
        self
    }

    /// Attach the settings-PATH telemetry triple (repair outcome, winning file,
    /// managed-bin presence) for a re-decide after the in-run settings-PATH
    /// repair. `repair == Rewritten` relaxes the durable ForeignManaged block;
    /// the other two are report-only tags.
    pub fn with_settings_path(mut self, settings_path: SettingsPathTelemetry) -> Self {
        self.settings_path = settings_path;
        self
    }

    /// Record whether HQ aimed this install at the copy the app now executes, so
    /// the durable ForeignManaged block can stay conditional on a drivable aim.
    pub fn with_executed_copy_aim(mut self, aim: ExecutedCopyAim) -> Self {
        self.executed_copy_aim = aim;
        self
    }

    /// Attach the executed `hq`'s resolution lane and the aimed prefix's shim
    /// state — the two closed telemetry tokens that ride the non-convergent event
    /// and (for the shim) gate the partial-install block.
    pub fn with_resolution_telemetry(
        mut self,
        hq_bin_lane: paths::ResolutionSource,
        delivered_prefix_shim: DeliveredPrefixShim,
    ) -> Self {
        self.hq_bin_lane = hq_bin_lane;
        self.delivered_prefix_shim = delivered_prefix_shim;
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

/// Whether a ForeignManaged verdict may write the durable marker, given whether
/// HQ aimed at the executed copy and whether the aimed prefix exposes its shim.
/// Only ForeignManaged is gated — every other kind reaches its own branch in
/// [`decide_post_install`] and is never routed through this, so they always read
/// as "may block". A ForeignManaged run stays non-blocking (episode-bounded)
/// when HQ did NOT yet aim at a drivable executed copy
/// ([`ExecutedCopyAim::NotYetAimed`]) OR when it delivered into a prefix missing
/// its shim ([`DeliveredPrefixShim::Absent`], HQ's own incomplete install). An
/// aimed-and-still-foreign layout, or a genuinely undrivable one, blocks as
/// before. Pure so the gate is unit-testable in isolation.
fn foreign_verdict_may_block(
    kind: NonConvergenceKind,
    aim: ExecutedCopyAim,
    shim: DeliveredPrefixShim,
    settings_path_repair: SettingsPathRepair,
) -> bool {
    if kind != NonConvergenceKind::ForeignManaged {
        return true;
    }
    // A run whose settings-PATH shadow HQ just rewrote stays non-blocking and
    // episode-bounded: the next resolution reads the rewritten managed-first PATH
    // and converges on HQ's own current copy, so a durable marker would wedge the
    // very machine HQ just fixed. Every other settings-PATH outcome (not
    // attempted, or a refusal / write-failure) keeps today's behaviour.
    if settings_path_repair == SettingsPathRepair::Rewritten {
        return false;
    }
    aim.foreign_verdict_may_block() && shim != DeliveredPrefixShim::Absent
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
        executed_copy_aim,
        hq_bin_lane,
        delivered_prefix_shim,
        settings_path,
    } = ctx;
    let managed_roots = *managed_roots;
    let managed_shadow_repair = *managed_shadow_repair;
    let executed_copy_aim = *executed_copy_aim;
    let hq_bin_lane = *hq_bin_lane;
    let delivered_prefix_shim = *delivered_prefix_shim;
    let settings_path = *settings_path;
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
            diagnostics.home_source != PnpmHomeSource::Undetermined && diagnostics.path_has_shim_dir
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
                (
                    None,
                    first_episode,
                    false,
                    first_episode.then_some(episode_key),
                )
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
        (
            None,
            first_episode,
            false,
            first_episode.then_some(episode_key),
        )
    } else if kind.is_installer_targeted() {
        (Some(latest.to_string()), true, false, None)
    } else if !foreign_verdict_may_block(
        kind,
        executed_copy_aim,
        delivered_prefix_shim,
        settings_path.repair,
    ) {
        // ForeignManaged, but HQ did not yet aim at the drivable copy the app
        // executes (the pre-install resolution did not identify it), it delivered
        // into a prefix that is missing its shim (HQ's OWN incomplete install),
        // or HQ just rewrote the winning settings PATH managed-first so the next
        // resolution converges. None is a foreign layout HQ cannot drive. Stay
        // observable and episode-bounded, write NO durable marker, so the
        // corrected aim / rewritten PATH converges on the next cycle instead of
        // wedging auto-update for this version. Uses the same non-blocking
        // episode bound as a resolution shortfall so a persistent environment
        // does not re-page every 6h.
        let episode_key = non_convergent_episode_key(latest, executor, kind, pnpm_home_source);
        let first_episode =
            !non_convergent_episode_reported(nonblocking_episode_keys, &episode_key);
        (
            None,
            first_episode,
            false,
            first_episode.then_some(episode_key),
        )
    } else {
        // ForeignManaged, aimed-or-undrivable: a layout HQ provably aimed at and
        // could not move, or one it genuinely cannot drive in place — block
        // exactly as before (one durable-record-gated capture per episode plus
        // the marker), so a machine HQ cannot repair keeps its stop-paging
        // behaviour.
        let first_episode = !already_blocked;
        (
            first_episode.then(|| latest.to_string()),
            first_episode,
            true,
            None,
        )
    };
    let report = should_capture.then(|| {
        let mut settings_path = settings_path;
        settings_path.executed_copy_aim = executed_copy_aim;
        settings_path.resolved_prefix = resolved_prefix_telemetry(
            hq_display,
            npm_prefix_passed,
            managed_roots,
            paths::home_dir().as_deref(),
            hq_bin_lane,
        );
        if settings_path.file == paths::SettingsPathFile::None
            && settings_path.managed_bin == ManagedBinInSettingsPath::Unknown
        {
            let hq_root = paths::resolved_hq_folder();
            let settings_file = paths::winning_settings_path_file(&hq_root);
            let managed_bin = managed_roots
                .first()
                .map(|root| paths::managed_npm_bin_in(root))
                .unwrap_or_default();
            settings_path.file = settings_file;
            settings_path.managed_bin = managed_bin_in_settings_path(
                settings_file,
                &paths::settings_path_dirs_in(&hq_root),
                &managed_bin,
            );
        }
        NonConvergentReport {
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
            hq_bin_lane,
            delivered_prefix_shim,
            settings_path,
            executed_copy_reaim: ExecutedCopyReaim::NotAttempted,
        }
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
            // Close the lane ambiguity permanently: which resolution lane
            // produced the executed `hq` (settings-PATH parity vs a
            // user/system/login-shell copy), and whether the aimed prefix
            // exposed its `hq` shim after delivery. Both are closed, path-free
            // tokens, so a residual occurrence names its own mechanism —
            // settings-PATH parity versus a partial install — without another
            // planning round. They ride the existing `before_send` scrubber
            // contract; no raw path is ever added.
            scope.set_tag("hq_bin_lane", report.hq_bin_lane.telemetry_value());
            scope.set_tag(
                "delivered_prefix_shim",
                report.delivered_prefix_shim.telemetry_value(),
            );
            // Settings-PATH triple: which `.claude` file supplied the winning
            // env.PATH, whether it listed HQ's managed bin dir, and what the
            // in-run settings-PATH repair achieved. All three are closed,
            // path-free tokens, so a residual settings-PATH shadow names its own
            // mechanism — a stale file HQ could not repair vs one it did — without
            // another planning round (HQ-DESKTOP-46).
            scope.set_tag(
                "settings_path_file",
                report.settings_path.file.telemetry_value(),
            );
            scope.set_tag(
                "managed_bin_in_settings_path",
                report.settings_path.managed_bin.telemetry_value(),
            );
            scope.set_tag(
                "settings_path_repair",
                report.settings_path.repair.telemetry_value(),
            );
            scope.set_tag(
                "executed_copy_reaim",
                report.executed_copy_reaim.telemetry_value(),
            );
            scope.set_tag(
                "executed_copy_aim",
                report.settings_path.executed_copy_aim.telemetry_value(),
            );
            scope.set_tag(
                "resolved_prefix_class",
                report.settings_path.resolved_prefix.class.telemetry_value(),
            );
            scope.set_tag(
                "resolved_under_home",
                bool_tag(report.settings_path.resolved_prefix.under_home),
            );
            scope.set_tag(
                "resolved_colocated_npm",
                bool_tag(report.settings_path.resolved_prefix.colocated_npm),
            );
            scope.set_tag(
                "resolved_matches_installer_prefix",
                bool_tag(
                    report
                        .settings_path
                        .resolved_prefix
                        .matches_installer_prefix,
                ),
            );
            // The class is the existing closed `non_convergence_kind` tag, so a
            // foreign-managed shadow has one stable group independent of paths,
            // versions, or the installer binary that happened to run.
            scope.set_fingerprint(Some(&[
                "hq-cli-update",
                "install-non-convergent",
                report.kind.telemetry_value(),
            ]));
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

static REGISTRY_SERVING_LAG_MARKER_UNPERSISTED_CAPTURED: AtomicBool = AtomicBool::new(false);

/// Keep a failed registry-lag deferral-marker write visible without allowing a
/// repeated npm failure to flood Sentry when menubar.json remains unwritable.
pub fn report_registry_serving_lag_marker_unpersisted() {
    if REGISTRY_SERVING_LAG_MARKER_UNPERSISTED_CAPTURED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    sentry::with_scope(
        |scope| {
            scope.set_tag(
                "hq_cli_update_kind",
                "registry-serving-lag-marker-unpersisted",
            );
            scope.set_tag("marker_store", "menubar-json");
            scope.set_tag("marker_error_class", "persistence");
            scope.set_fingerprint(Some(&[
                "hq-cli-update",
                "registry-serving-lag-marker-unpersisted",
            ]));
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] could not persist registry serving-lag deferral marker",
                sentry::Level::Warning,
            );
        },
    );
}

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn reset_registry_serving_lag_marker_unpersisted_capture_for_tests() {
    REGISTRY_SERVING_LAG_MARKER_UNPERSISTED_CAPTURED.store(false, Ordering::Release);
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
                    "hq_backing": probes.hq_backing,
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

/// Select a bounded set of regular files for a Windows Restart Manager query.
/// `is_file` is supplied by the filesystem caller so selection stays pure and testable.
pub fn select_rm_file_resources(
    candidates: impl IntoIterator<Item = (std::path::PathBuf, bool)>,
) -> Vec<std::path::PathBuf> {
    candidates
        .into_iter()
        .filter_map(|(path, is_file)| is_file.then_some(path))
        .take(32)
        .collect()
}

/// Extract npm's reported rename resources and their in-prefix parents for a
/// Windows Restart Manager query. Returned paths stay in process memory and
/// must never cross the telemetry boundary.
pub fn npm_reported_target_resources(prefix: &str, npm_detail: &str) -> Vec<std::path::PathBuf> {
    fn normalized(value: &str) -> String {
        value
            .trim()
            .trim_matches(|character| character == '\'' || character == '"')
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    let prefix_text = normalized(prefix).trim_end_matches('\\').to_string();
    let mut resources = Vec::new();
    for line in npm_detail.lines() {
        let Some(path) = line
            .strip_prefix("npm error path ")
            .or_else(|| line.strip_prefix("npm error dest "))
        else {
            continue;
        };
        let path_text = normalized(path);
        if path_text.contains("\\..\\")
            || path_text.ends_with("\\..")
            || path_text.contains("\\.\\")
            || (path_text != prefix_text && !path_text.starts_with(&format!("{prefix_text}\\")))
        {
            continue;
        }
        let mut current = path
            .trim()
            .trim_matches(|character| character == '\'' || character == '"')
            .to_string();
        loop {
            if resources.len() >= 32 {
                break;
            }
            resources.push(std::path::PathBuf::from(&current));
            let Some((parent, _)) = current.rsplit_once('\\') else {
                break;
            };
            let parent_text = normalized(parent);
            if parent_text == prefix_text {
                resources.push(std::path::PathBuf::from(parent));
                break;
            }
            if !parent_text.starts_with(&format!("{prefix_text}\\")) {
                break;
            }
            current = parent.to_string();
        }
    }
    resources.sort();
    resources.dedup();
    resources
}

#[cfg(test)]
mod npm_reported_target_resources_tests {
    use super::npm_reported_target_resources;

    #[test]
    fn rm_resource_selection_excludes_directories() {
        let candidates = [
            (std::path::PathBuf::from(r"C:\npm\target"), false),
            (std::path::PathBuf::from(r"C:\npm\target\file.js"), true),
        ];
        let selected = super::select_rm_file_resources(candidates);

        assert_eq!(selected, [std::path::PathBuf::from(r"C:\npm\target\file.js")]);
    }

    #[test]
    fn rm_resource_selection_caps_registered_files_at_32() {
        let candidates = (0..40).map(|index| {
            (
                std::path::PathBuf::from(format!(r"C:\npm\node_modules\pkg\file-{index}.js")),
                true,
            )
        });
        let selected = super::select_rm_file_resources(candidates);

        assert_eq!(selected.len(), 32);
    }

    #[test]
    fn busy_query_registers_npm_rename_targets_and_each_parent_inside_the_prefix() {
        let resources = npm_reported_target_resources(
            r"C:\npm",
            concat!(
                "npm error path C:\\npm\\node_modules\\@indigoai-us\\hq-cli\n",
                "npm error dest C:\\npm\\node_modules\\@indigoai-us\\.hq-cli-X\n",
                "npm error path C:\\private\\outside.exe\n",
                "npm error dest C:\\npm\\..\\private\\outside.exe\n",
            ),
        );
        let path_strings = resources
            .iter()
            .map(|path| path.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        for expected in [
            r"c:\npm\node_modules\@indigoai-us\hq-cli",
            r"c:\npm\node_modules\@indigoai-us",
            r"c:\npm\node_modules",
            r"c:\npm",
            r"c:\npm\node_modules\@indigoai-us\.hq-cli-x",
        ] {
            assert!(
                path_strings.iter().any(|path| path == expected),
                "{expected}"
            );
        }
        assert!(!path_strings.iter().any(|path| path.contains("private")));
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
///
/// This is the ENV-BLIND code allow-list and must stay one: it never contains
/// E404. The env-aware [`classify_install_failure_with_environment`] separately
/// maps a pinned npmjs tarball 404 to `ExpectedTransientRegistry` (HQ-DESKTOP-6D,
/// the tarball-layer twin of the ETARGET lag) via
/// [`is_npmjs_pinned_tarball_not_yet_served`], WITHOUT widening this list — so
/// every env-blind caller and `InstallEnvironment::default()` keep today's exact
/// behaviour.
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

// --- E404 registry attribution (HQ-DESKTOP-5Q) -------------------------------
//
// An npm E404 means the package or version was absent from the registry npm
// actually queried. npm emits neither a `syscall` nor a `path` line for a 404,
// so the generic `symbolic_code:syscall:path_shape` signature degenerates to
// `E404:unknown:none` and the event names neither the registry nor the spec. The
// two closed enums below recover the ONLY attribution npm's own 404 line carries
// — which registry origin it named and which resource it was fetching. The
// parsed host and URL are consumed ONLY to derive those enums and are never
// stored, returned, logged into telemetry, or tagged: only the enum value ever
// crosses the Sentry boundary, so the scrub-safety guarantee is identical to the
// other closed-enumeration tags (npm_error_code, npm_syscall, npm_path_shape).

/// Which registry npm resolved through for a 404, as a CLOSED enumeration
/// derived ONLY from npm's own `404 Not Found - GET <url>` error line. The host
/// is compared against `registry.npmjs.org` and then discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NpmRegistryOrigin {
    Npmjs,
    Foreign,
    Unknown,
}

impl NpmRegistryOrigin {
    fn tag_value(self) -> &'static str {
        match self {
            Self::Npmjs => "npmjs",
            Self::Foreign => "foreign",
            Self::Unknown => "unknown",
        }
    }
}

/// Which resource npm's 404 named, as a CLOSED enumeration derived ONLY from the
/// same `404 ... GET <url>` line's path: the package document (`packument`), a
/// `/-/…​.tgz` tarball (`tarball`), any other parseable path (`other`), or no
/// parseable 404 line at all (`none`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Npm404Resource {
    Packument,
    Tarball,
    Other,
    None,
}

impl Npm404Resource {
    fn tag_value(self) -> &'static str {
        match self {
            Self::Packument => "packument",
            Self::Tarball => "tarball",
            Self::Other => "other",
            Self::None => "none",
        }
    }
}

/// The URL npm named in its `404 Not Found - GET <url>` line, if any. Uses the
/// same line-prefix discipline as [`npm_error_code`] / [`npm_syscall`]: a trimmed
/// line whose lowercase form starts with `npm error 404 ` or `npm err! 404 ` and
/// contains ` - get http`. Kept private and transient — the borrowed slice is
/// consumed only to derive the closed enums above and never reaches Sentry.
fn npm_404_get_url(detail: &str) -> Option<&str> {
    detail.lines().find_map(|raw_line| {
        let line = raw_line.trim();
        let lower = line.to_ascii_lowercase();
        if !(lower.starts_with("npm error 404 ") || lower.starts_with("npm err! 404 ")) {
            return None;
        }
        // Locate " - get " case-insensitively. Byte indices align between `lower`
        // and `line` because `to_ascii_lowercase` is length-preserving, so the
        // index is valid in the original-case slice; take the next whitespace
        // token and require an http(s) scheme.
        let idx = lower.find(" - get ")?;
        let token = line[idx + " - get ".len()..].split_whitespace().next()?;
        let lower_token = token.to_ascii_lowercase();
        (lower_token.starts_with("https://") || lower_token.starts_with("http://")).then_some(token)
    })
}

/// The lowercased host (authority with any userinfo/port stripped) of an http(s)
/// URL, or None. Transient: used only to compare against `registry.npmjs.org`.
fn url_host_lower(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let after_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

/// npm's registry origin for a 404 (see [`NpmRegistryOrigin`]). A host that
/// parses to exactly `registry.npmjs.org` is `Npmjs`; any other host is
/// `Foreign`; a 404 line that is absent or unparseable is `Unknown` (fail-loud —
/// an Unknown-origin E404 keeps its Error level).
fn npm_registry_origin(detail: &str) -> NpmRegistryOrigin {
    let Some(url) = npm_404_get_url(detail) else {
        return NpmRegistryOrigin::Unknown;
    };
    match url_host_lower(url) {
        Some(host) if host == "registry.npmjs.org" => NpmRegistryOrigin::Npmjs,
        Some(_) => NpmRegistryOrigin::Foreign,
        None => NpmRegistryOrigin::Unknown,
    }
}

/// Which resource npm's 404 named (see [`Npm404Resource`]).
fn npm_404_resource(detail: &str) -> Npm404Resource {
    let Some(url) = npm_404_get_url(detail) else {
        return Npm404Resource::None;
    };
    let lower = url.to_ascii_lowercase();
    let Some(after_scheme) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return Npm404Resource::None;
    };
    // The path component: strip the authority, drop any query/fragment.
    let path = match after_scheme.find('/') {
        Some(idx) => &after_scheme[idx..],
        None => return Npm404Resource::Other,
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    // A tarball request: npm's `/-/` tarball path ending in `.tgz`.
    if path.contains("/-/") && path.ends_with(".tgz") {
        return Npm404Resource::Tarball;
    }
    // A packument request names the package document itself. A scoped package
    // carries the encoded `%2f` scope separator in that final segment
    // (`/@indigoai-us%2fhq-cli`, even behind a foreign registry's path prefix);
    // an unscoped packument is a single bare path segment. Anything deeper (e.g. a
    // per-version metadata document) is `Other`.
    let last = path.rsplit('/').find(|part| !part.is_empty()).unwrap_or("");
    let trimmed = path.trim_matches('/');
    if last.contains("%2f") || (!trimmed.is_empty() && !trimmed.contains('/')) {
        return Npm404Resource::Packument;
    }
    Npm404Resource::Other
}

/// The (origin, resource) pair shared by BOTH an E404 install failure's Sentry
/// signature and its repeat-guard episode key, so the group and the key can never
/// name different attribution. Both components are closed enumerations.
fn e404_discriminator(detail: &str) -> (NpmRegistryOrigin, Npm404Resource) {
    (npm_registry_origin(detail), npm_404_resource(detail))
}

/// The bounded signature for a foreign-registry E404
/// (`foreign-registry-404:<resource>`): its origin is definitionally `Foreign`,
/// so only WHICH resource npm's 404 named varies. Derived from the shared
/// [`e404_discriminator`] so the Sentry group and the episode key agree.
fn foreign_registry_404_signature(detail: &str) -> String {
    format!(
        "foreign-registry-404:{}",
        e404_discriminator(detail).1.tag_value()
    )
}

/// The bounded signature for an E404 that stayed `Unexpected`
/// (`E404:<origin>:<resource>`) — a npmjs- or unknown-origin 404 that keeps its
/// Error level. Distinct from the foreign-registry group above, so the two E404
/// populations can never share a Sentry issue; `syscall`/`path_shape` are
/// definitionally `unknown`/`none` for a 404 and carry no discriminating power.
/// Derived from the shared [`e404_discriminator`] so the group and the episode
/// key agree.
///
/// An npmjs TARBALL 404 reaches this signature (`E404:npmjs:tarball`) ONLY when it
/// is NOT the pinned-version serving lag — an unpinned/default env, or a pin for a
/// different version — because [`classify_install_failure_with_environment`]
/// reclassifies the pinned case to `ExpectedTransientRegistry` upstream
/// (HQ-DESKTOP-6D), so it never stays `Unexpected` and never reaches here.
fn unexpected_e404_signature(detail: &str) -> String {
    let (origin, resource) = e404_discriminator(detail);
    format!("E404:{}:{}", origin.tag_value(), resource.tag_value())
}

/// Whether npm's 404 GET line names the requested `@indigoai-us/hq-cli`
/// PACKUMENT document itself — not a tarball, a transitive dependency, or a
/// deeper resource. A missing PACKUMENT for the exact package the updater asked
/// for is strong evidence that the registry npm resolved through does not carry
/// hq; a missing tarball or dependency on a foreign host, by contrast, can be a
/// broken published release artifact that must stay loud at Error. Matches the
/// percent-encoded scope form npm emits (`@indigoai-us%2fhq-cli`) and the
/// unencoded fallback, case-insensitively. The parsed path is consumed only for
/// this boolean and never reaches Sentry.
fn npm_404_names_hq_cli_packument(detail: &str) -> bool {
    let Some(url) = npm_404_get_url(detail) else {
        return false;
    };
    let lower = url.to_ascii_lowercase();
    let Some(after_scheme) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let Some(slash) = after_scheme.find('/') else {
        return false;
    };
    let path = after_scheme[slash..]
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    path.ends_with("/@indigoai-us%2fhq-cli") || path.ends_with("/@indigoai-us/hq-cli")
}

/// Whether npm's 404 GET line names the requested `@indigoai-us/hq-cli` TARBALL
/// object for EXACTLY `version` — a path ending in
/// `/@indigoai-us/hq-cli/-/hq-cli-<version>.tgz` on whatever host the 404 line
/// named. The tarball-layer companion to [`npm_404_names_hq_cli_packument`]:
/// registry.npmjs.org lists a version in the packument only once its publish PUT
/// landed, so a 404 for that same version's own tarball object is a serving lag
/// (HQ-DESKTOP-6D), not an absent version. `version` is the exact string the
/// updater pinned into [`install_argv`] (`env.target_version`); an empty version,
/// or an absent/unparseable 404 URL, returns false. Uses the same line-prefix and
/// path-parsing discipline as [`npm_404_names_hq_cli_packument`] — lowercase the
/// URL, strip scheme+authority, drop any query/fragment and trailing slash — and
/// lowercases `version` so a case difference cannot hide a match. The parsed path
/// is consumed only for this boolean and never reaches Sentry.
fn npm_404_names_hq_cli_tarball_for(detail: &str, version: &str) -> bool {
    let version = version.trim().to_ascii_lowercase();
    if version.is_empty() {
        return false;
    }
    let Some(url) = npm_404_get_url(detail) else {
        return false;
    };
    let lower = url.to_ascii_lowercase();
    let Some(after_scheme) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let Some(slash) = after_scheme.find('/') else {
        return false;
    };
    let path = after_scheme[slash..]
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    path.ends_with(&format!("/@indigoai-us/hq-cli/-/hq-cli-{version}.tgz"))
}

/// Package named by npm's npmjs tarball URL, reduced to a validated package
/// name. The URL and tarball filename are discarded; only this bounded identity
/// is eligible for a diagnostic tag or local episode key.
fn npm_404_tarball_package(detail: &str) -> Option<String> {
    if npm_404_resource(detail) != Npm404Resource::Tarball
        || npm_registry_origin(detail) != NpmRegistryOrigin::Npmjs
    {
        return None;
    }
    let url = npm_404_get_url(detail)?;
    let lower = url.to_ascii_lowercase();
    let after_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let slash = after_scheme.find('/')?;
    let path = after_scheme[slash..].split(['?', '#']).next()?;
    let package_path = path.split("/-/").next()?.trim_matches('/');
    let package = package_path.replace("%2f", "/");
    is_safe_npm_package_name(&package).then_some(package)
}

/// Whether a failed npm install is the "this machine's npm resolves the
/// `@indigoai-us` scope through a registry that does not carry hq-cli" condition:
/// an E404 whose own 404 line names a non-npmjs host AND the requested
/// `@indigoai-us/hq-cli` PACKUMENT, with no lifecycle failure. A permanent LOCAL
/// registry misconfiguration — a corporate mirror, an air-gapped proxy, or an
/// auth-gated 403 masked as a 404 — that no updater code change can install
/// through, so it is reported at Warning under its own attributed group.
///
/// Keyed on npm's OWN structured signals and disjoint from every other arm: it
/// requires a FOREIGN origin, so it cannot overlap the env-aware npmjs-pinned
/// tarball transient ([`is_npmjs_pinned_tarball_not_yet_served`], the only other
/// arm that matches `code == E404`, which requires the npmjs origin); the
/// lifecycle exclusion keeps a third-party build failure whose stderr merely
/// mentions 404 on its own per-package lifecycle attribution. The packument gate
/// is deliberately narrow: a foreign-host 404 for a TARBALL or a transitive
/// DEPENDENCY (rather than the hq-cli package document itself) is NOT proof the
/// configured registry lacks hq — it can be a broken published artifact — so it
/// stays `Unexpected` at Error under its own `E404:foreign:<resource>` signature.
fn is_foreign_registry_package_missing(detail: &str) -> bool {
    npm_error_code(detail) == "E404"
        && npm_registry_origin(detail) == NpmRegistryOrigin::Foreign
        && npm_404_names_hq_cli_packument(detail)
        && !has_npm_lifecycle_failure_marker(detail)
        && !npm_lifecycle_failure(detail).failed
}

/// Whether a failed npm install is the "registry.npmjs.org lists the version the
/// updater just resolved but is not yet serving its tarball object" condition
/// (HQ-DESKTOP-6D): an E404 whose own 404 line names registry.npmjs.org and a
/// safely parsed tarball package, with no lifecycle failure. For hq-cli itself,
/// the tarball must match the EXACT version the updater pinned (`env.target_version`);
/// a dependency tarball is part of that pinned install's resolved tree. This is
/// the tarball-layer twin of the ETARGET packument lag that
/// [`is_expected_transient_registry_failure`] already absorbs. A listed-but-
/// unserved tarball is a bounded serving-lag transient; a recurring failure is
/// escalated through the visible install-failure report.
///
/// An npmjs packument 404, a foreign-host 404, an unpinned/default environment,
/// an hq-cli tarball whose version differs from the pin, and any E404 with a
/// lifecycle marker stay loud at Error. The pin requirement confines the
/// downgrade to an install whose CLI version HQ itself resolved from `/latest`.
/// The parsed package name is bounded and the URL never reaches Sentry.
fn is_npmjs_pinned_tarball_not_yet_served(detail: &str, env: &InstallEnvironment) -> bool {
    npm_error_code(detail) == "E404"
        && env.requested_spec_kind == RequestedSpecKind::PinnedVersion
        && npm_404_tarball_package(detail).is_some_and(|package| {
            package != HQ_CLI_PACKAGE_NAME
                || env
                    .target_version
                    .as_deref()
                    .is_some_and(|version| npm_404_names_hq_cli_tarball_for(detail, version))
        })
        && !has_npm_lifecycle_failure_marker(detail)
        && !npm_lifecycle_failure(detail).failed
}

// --- end E404 registry attribution -------------------------------------------

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

/// A more precise closed stage for node-llama-cpp's optional postinstall. This
/// tag is only attached to that package's `postinstall-script` failure, and the
/// classifier never returns stderr text or paths.
fn npm_lifecycle_postinstall_stage(detail: &str) -> Option<&'static str> {
    let lifecycle = npm_lifecycle_failure(detail);
    if lifecycle.package.as_deref() != Some("node-llama-cpp")
        || npm_lifecycle_cause(detail) != "postinstall-script"
    {
        return None;
    }

    let lower = detail.to_ascii_lowercase();
    Some(if lower.contains("rosetta") {
        "rosetta"
    } else if lower.contains("failed to load a prebuilt")
        || lower.contains("failed to load prebuilt")
        || lower.contains("dlopen")
    {
        "prebuilt-load-failed"
    } else if lower.contains("no prebuilt") || lower.contains("prebuilt binary was not found") {
        "prebuilt-missing"
    } else if lower.contains("cannot find module") || lower.contains("module not found") {
        "module-load-failed"
    } else if lower.contains("building from source")
        || lower.contains("source build")
        || lower.contains("cmake")
    {
        "source-build-attempted"
    } else {
        "unknown"
    })
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
const WINDOWS_EBUSY_EXIT: i32 = -4082;

/// Closed classification written for Restart Manager results. Values are
/// intentionally short labels: raw process names, file paths, usernames, and
/// process IDs never cross the Sentry boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NpmLockHolderClass {
    None,
    HqSyncRunner,
    McpOrWatcherChild,
    UserTerminalHqCli,
    DefenderOrIndexer,
    Other,
    #[default]
    Unknown,
}

impl NpmLockHolderClass {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::HqSyncRunner => "hq-sync-runner",
            Self::McpOrWatcherChild => "mcp-or-watcher-child",
            Self::UserTerminalHqCli => "user-terminal-hq-cli",
            Self::DefenderOrIndexer => "defender-or-indexer",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// Restart Manager names plus local-only process context. `image_name` must be
/// a basename; none of these fields are copied to logs, Sentry tags, or extras.
#[derive(Clone, PartialEq, Eq)]
pub struct RestartManagerProcessResult {
    pub process_id: u32,
    pub process_start_time: u64,
    pub application_name: String,
    pub service_short_name: String,
    pub image_name: Option<String>,
    pub has_terminal_ancestor: bool,
    pub app_child_kind: Option<AppOwnedProcessKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppOwnedProcessKind {
    HqSyncRunner,
    McpOrWatcherChild,
    Other,
}

/// A process identity retained only in memory so a PID reuse cannot cause the
/// updater to wait on an unrelated process. These values are never serialized.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RestartManagerProcessIdentity {
    pub process_id: u32,
    pub process_start_time: u64,
}

pub struct RestartManagerHolderClassification {
    pub class: NpmLockHolderClass,
    pub count: u16,
    owned_processes: Vec<RestartManagerProcessIdentity>,
    image_basename: Option<String>,
}

impl RestartManagerHolderClassification {
    pub fn owned_processes(&self) -> &[RestartManagerProcessIdentity] {
        &self.owned_processes
    }

    pub fn includes_owned_process(&self, process_id: u32, process_start_time: u64) -> bool {
        self.owned_processes.iter().any(|identity| {
            identity.process_id == process_id && identity.process_start_time == process_start_time
        })
    }

    pub fn image_basename(&self) -> Option<&str> {
        self.image_basename.as_deref()
    }
}

fn is_scanner_process_name(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "mpsvc"
            | "windefend"
            | "wdnissvc"
            | "wsearch"
            | "mpcmdrun.exe"
            | "msmpeng.exe"
            | "nissrv.exe"
            | "searchfilterhost.exe"
            | "searchindexer.exe"
            | "searchprotocolhost.exe"
            | "windows search"
            | "microsoft windows search filter host"
            | "antimalware service executable"
            | "windows defender"
    )
}

fn is_terminal_hq_cli_process(image_name: Option<&str>, has_terminal_ancestor: bool) -> bool {
    has_terminal_ancestor
        && image_name.is_some_and(|image| {
            matches!(
                image.trim().to_ascii_lowercase().as_str(),
                "node.exe" | "hq.exe" | "hq-cli.exe"
            )
        })
}

fn restart_manager_result_class(result: &RestartManagerProcessResult) -> NpmLockHolderClass {
    if let Some(kind) = result.app_child_kind {
        return match kind {
            AppOwnedProcessKind::HqSyncRunner => NpmLockHolderClass::HqSyncRunner,
            AppOwnedProcessKind::McpOrWatcherChild => NpmLockHolderClass::McpOrWatcherChild,
            AppOwnedProcessKind::Other => NpmLockHolderClass::Other,
        };
    }
    if is_terminal_hq_cli_process(result.image_name.as_deref(), result.has_terminal_ancestor) {
        return NpmLockHolderClass::UserTerminalHqCli;
    }
    if result
        .image_name
        .as_deref()
        .is_some_and(is_scanner_process_name)
        || is_scanner_process_name(&result.application_name)
        || is_scanner_process_name(&result.service_short_name)
    {
        return NpmLockHolderClass::DefenderOrIndexer;
    }
    NpmLockHolderClass::Other
}

/// Pure aggregation/classification over Restart Manager's process results and
/// local process-tree facts. If results contain multiple kinds, a terminal
/// hq-cli holder wins so an update is deferred without disturbing that session.
pub fn classify_restart_manager_holders(
    results: &[RestartManagerProcessResult],
) -> RestartManagerHolderClassification {
    let mut identities = Vec::new();
    let mut owned_processes = Vec::new();
    let mut selected = NpmLockHolderClass::None;
    let mut selected_image_basename: Option<String> = None;
    for result in results {
        if result.process_id == 0 {
            continue;
        }
        let identity = RestartManagerProcessIdentity {
            process_id: result.process_id,
            process_start_time: result.process_start_time,
        };
        if identities.contains(&identity) {
            continue;
        }
        identities.push(identity);
        if result.app_child_kind.is_some() {
            owned_processes.push(identity);
        }
        let class = restart_manager_result_class(result);
        let priority = |value| match value {
            NpmLockHolderClass::UserTerminalHqCli => 6,
            NpmLockHolderClass::HqSyncRunner => 5,
            NpmLockHolderClass::McpOrWatcherChild => 4,
            NpmLockHolderClass::DefenderOrIndexer => 3,
            NpmLockHolderClass::Other => 2,
            NpmLockHolderClass::Unknown => 1,
            NpmLockHolderClass::None => 0,
        };
        if priority(class) > priority(selected) {
            selected = class;
            selected_image_basename = result
                .image_name
                .as_deref()
                .and_then(telemetry_image_basename);
        } else if class == selected {
            if let Some(image_basename) = result
                .image_name
                .as_deref()
                .and_then(telemetry_image_basename)
            {
                if selected_image_basename
                    .as_ref()
                    .is_none_or(|current| image_basename < *current)
                {
                    selected_image_basename = Some(image_basename);
                }
            }
        }
    }
    RestartManagerHolderClassification {
        class: selected,
        count: identities.len().min(u16::MAX as usize) as u16,
        owned_processes,
        image_basename: selected_image_basename,
    }
}

fn telemetry_image_basename(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 96
        || value.contains('/')
        || value.contains('\\')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(value.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NpmLockHolderQueryOutcome {
    Complete,
    NoFilesSampled,
    Truncated,
    #[default]
    Unavailable,
}

impl NpmLockHolderQueryOutcome {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::NoFilesSampled => "no-files-sampled",
            Self::Truncated => "truncated",
            Self::Unavailable => "unavailable",
        }
    }
}

pub struct RestartManagerHolderObservation {
    pub class: NpmLockHolderClass,
    pub count: u16,
    pub query_outcome: NpmLockHolderQueryOutcome,
    owned_processes: Vec<RestartManagerProcessIdentity>,
    image_basename: Option<String>,
}

impl RestartManagerHolderObservation {
    pub fn from_results(
        results: &[RestartManagerProcessResult],
        query_outcome: NpmLockHolderQueryOutcome,
    ) -> Self {
        Self::from_results_with_count(results, query_outcome, None)
    }

    /// Build the telemetry-safe view while preserving Restart Manager's full
    /// count when its bounded process sample was truncated.
    pub fn from_results_with_count(
        results: &[RestartManagerProcessResult],
        query_outcome: NpmLockHolderQueryOutcome,
        reported_count: Option<u32>,
    ) -> Self {
        let classification = classify_restart_manager_holders(results);
        let class = if query_outcome == NpmLockHolderQueryOutcome::Complete {
            classification.class
        } else {
            NpmLockHolderClass::Unknown
        };
        Self {
            class,
            count: reported_count
                .map(|count| count.min(u16::MAX as u32) as u16)
                .unwrap_or(classification.count),
            query_outcome,
            owned_processes: classification.owned_processes,
            image_basename: if query_outcome == NpmLockHolderQueryOutcome::Complete {
                classification.image_basename
            } else {
                None
            },
        }
    }

    pub fn diagnostic(&self) -> NpmLockHolderDiagnostic {
        NpmLockHolderDiagnostic {
            class: self.class,
            count: self.count,
            query_outcome: self.query_outcome,
            image_basename: self.image_basename.clone(),
        }
    }

    pub fn owned_processes(&self) -> &[RestartManagerProcessIdentity] {
        &self.owned_processes
    }

    pub fn includes_owned_process(&self, process_id: u32, process_start_time: u64) -> bool {
        self.owned_processes.iter().any(|identity| {
            identity.process_id == process_id && identity.process_start_time == process_start_time
        })
    }
}

/// Telemetry-safe holder summary. It carries no PID or path; the only process
/// identifier is a validated basename with a bounded ASCII vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NpmLockHolderDiagnostic {
    pub class: NpmLockHolderClass,
    pub count: u16,
    pub query_outcome: NpmLockHolderQueryOutcome,
    pub image_basename: Option<String>,
}

pub const WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES: usize = 3;
/// After this many consecutive same-target deferrals, surface the existing
/// install failure again instead of extending the quiet period.
pub const WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS: u8 = 3;
const WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNGS: [&str; WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES] = [
    "windows-busy-install-target-backoff-1",
    "windows-busy-install-target-backoff-2",
    "windows-busy-install-target-backoff-3",
];

/// Four total npm attempts use three bounded waits with a 50-second ceiling.
pub fn windows_busy_install_target_retry_delay(retry_number: usize) -> Option<std::time::Duration> {
    match retry_number {
        1 => Some(std::time::Duration::from_secs(5)),
        2 => Some(std::time::Duration::from_secs(15)),
        3 => Some(std::time::Duration::from_secs(30)),
        _ => None,
    }
}

pub fn windows_busy_install_target_retry_rung(retry_number: usize) -> Option<&'static str> {
    WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNGS
        .get(retry_number.checked_sub(1)?)
        .copied()
}

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

/// Detect the Windows npm package-target lock reported as EBUSY/rename. This is
/// distinct from EPERM while replacing the `hq` shim: the locked target can be a
/// package directory under the selected prefix's node_modules. All structured
/// fields must agree before the updater arms its bounded retry ladder.
pub fn is_windows_locked_install_target_failure(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> bool {
    exit_code == Some(WINDOWS_EBUSY_EXIT)
        && npm_error_code(detail) == "EBUSY"
        && npm_syscall(detail) == "rename"
        && npm_path_shape(detail, prefix) == NpmPathShape::SelectedPrefixNodeModules
        && !has_npm_lifecycle_failure_marker(detail)
        && !npm_lifecycle_failure(detail).failed
}

/// First retry label retained for callers that use the original retry seam.
pub const WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNG: &str = WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNGS[0];

/// Decide whether the app may arm another retry for a Windows locked install
/// target. The pure seam keeps the failure classifier, bounded retry ledger,
/// and total attempt cap together so the app cannot retry another EBUSY shape
/// or loop after the retry budget is exhausted.
pub fn should_retry_windows_busy_install_target(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    attempted_rungs: &[&str],
    max_attempts: usize,
) -> bool {
    let retries_already_run = attempted_rungs
        .iter()
        .filter(|rung| WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNGS.contains(rung))
        .count();
    is_windows_locked_install_target_failure(exit_code, detail, prefix)
        && retries_already_run < WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES
        && attempted_rungs.len() < max_attempts
}

/// A small, per-user marker for consecutive same-target EBUSY deferrals. It
/// contains only a published version and a bounded counter, never a path or
/// machine identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsBusyDeferralMarker {
    pub target_version: String,
    pub attempts: u8,
}

impl WindowsBusyDeferralMarker {
    pub fn attempts_for(&self, target_version: &str) -> u8 {
        if self.target_version == target_version {
            self.attempts.min(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS)
        } else {
            0
        }
    }
}

/// Decode the stored marker. Corrupt state is an error so callers preserve the
/// current failure behavior instead of resetting the counter and deferring
/// forever. Missing/null state means this is the first attempt for a target.
pub fn parse_windows_busy_deferral_marker(
    value: Option<&Value>,
) -> Result<Option<WindowsBusyDeferralMarker>, &'static str> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(target_version) = value.get("target_version").and_then(Value::as_str) else {
        return Err("missing target version");
    };
    let valid_version = !target_version.is_empty()
        && target_version.len() <= 64
        && target_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'));
    if !valid_version {
        return Err("invalid target version");
    }
    let Some(attempts) = value
        .get("attempts")
        .and_then(Value::as_u64)
        .filter(|attempts| {
            (1..=u64::from(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS)).contains(attempts)
        })
    else {
        return Err("invalid attempt count");
    };
    Ok(Some(WindowsBusyDeferralMarker {
        target_version: target_version.to_string(),
        attempts: attempts as u8,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsBusyDeferralDecision {
    Deferred { attempts: u8 },
    Exhausted { attempts: u8 },
}

/// Confirm that the installed CLI stayed on the same resolved version after a
/// failed update. The manifest-anchored resolver is the authoritative version
/// source on both sides; `hq --version` only proves the command still responds,
/// since its embedded version can lag the package manifest.
pub fn windows_busy_cli_version_unchanged(
    before_resolved_version: Option<&str>,
    after_resolved_version: Option<&str>,
    command_liveness_version: Option<&str>,
) -> bool {
    let (Some(before), Some(after), Some(_)) = (
        before_resolved_version,
        after_resolved_version,
        command_liveness_version,
    ) else {
        return false;
    };
    before == after
}

/// Defer only the proven no-holder selected-prefix rename failure after all
/// existing retries, and only if the old CLI still answers its version probe.
/// Every other shape continues down today's install-failure path.
pub fn windows_busy_deferral_decision(
    old_cli_still_works: bool,
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    retry_attempts: Option<u8>,
    retry_outcome: WindowsBusyRetryOutcome,
    holder: Option<NpmLockHolderDiagnostic>,
    marker: Option<&WindowsBusyDeferralMarker>,
    target_version: &str,
) -> Option<WindowsBusyDeferralDecision> {
    let no_holder_was_confirmed = holder.is_some_and(|diagnostic| {
        diagnostic.class == NpmLockHolderClass::None
            && diagnostic.count == 0
            && diagnostic.query_outcome == NpmLockHolderQueryOutcome::Complete
    });
    if !old_cli_still_works
        || retry_attempts != Some(WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES as u8)
        || retry_outcome != WindowsBusyRetryOutcome::Failed
        || !no_holder_was_confirmed
        || !is_windows_locked_install_target_failure(exit_code, detail, prefix)
    {
        return None;
    }

    let attempts = marker
        .map(|marker| marker.attempts_for(target_version))
        .unwrap_or(0)
        .saturating_add(1)
        .min(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS);
    if attempts >= WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS {
        Some(WindowsBusyDeferralDecision::Exhausted { attempts })
    } else {
        Some(WindowsBusyDeferralDecision::Deferred { attempts })
    }
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
    detail
        .to_ascii_lowercase()
        .contains("no space left on device")
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
    WindowsLockedInstallTarget,
    ExpectedTransientRegistry,
    ExpectedBinCollision,
    ExpectedDiskFull,
    UnexpectedLifecycle,
    Unexpected,
    /// A known native Node crash from HQ's managed runtime while the Node ABI
    /// and npm version probes both failed. HQ can repair that managed toolchain
    /// and retry once, so this remains an actionable install failure.
    NativeCrash,
    /// The user's PATH Node is older than [`MIN_NODE_MAJOR`], so the published
    /// CLI (whose own `engines.node` rules it out) can never install and npm dies
    /// before emitting its structured error block. A permanent per-machine
    /// runtime condition, not an updater defect — a strict refinement of
    /// `Unexpected`, applied only when the probed environment proves the runtime
    /// is too old.
    UnsupportedNode,
    /// npm could not create its OWN global install-target directory: on a machine
    /// whose npm global prefix directory chain does not exist, `npm install -g
    /// @indigoai-us/hq-cli@latest` dies with `code ENOENT` / `syscall mkdir` at a
    /// global-install path before it can lay the package down, so the user's CLI
    /// silently never updates (HQ-DESKTOP-5K). A broken/absent LOCAL npm prefix,
    /// not an updater defect — but it stops the update dead, so (unlike the other
    /// expected local conditions) it stays observable at Warning under its own
    /// bounded group, and only AFTER HQ's own mkdir + managed-toolchain repair have
    /// been attempted and declined. A strict refinement of `Unexpected`, applied
    /// only when npm's own structured code/syscall/path shape prove this exact
    /// shape and no lifecycle failure was reported.
    MissingGlobalInstallTarget,
    /// npm resolved the `@indigoai-us` scope through a registry that does not
    /// carry `@indigoai-us/hq-cli`, so `npm install -g @indigoai-us/hq-cli@<v>`
    /// dies with `code E404` naming a non-npmjs host (HQ-DESKTOP-5Q). A permanent
    /// LOCAL registry misconfiguration — a corporate mirror, an air-gapped proxy,
    /// or an auth-gated 403 the registry masks as a 404 — that no updater code
    /// change can install through, so (like the other permanent local conditions)
    /// it stays observable at Warning under its own attributed group. A strict
    /// refinement of `Unexpected`, applied only when npm's own 404 line proves a
    /// non-npmjs registry origin and no lifecycle failure was reported.
    ForeignRegistryPackageMissing,
}

/// A bin collision is expected only when npm's documented `--force` remedy
/// was applied to the final attempt that produced this exact structured npm
/// failure. A bare EEXIST token elsewhere in stderr remains reportable.
pub fn is_npm_bin_collision(detail: &str, prefix: Option<&str>) -> bool {
    npm_error_code(detail) == "EEXIST" && npm_path_shape(detail, prefix) == NpmPathShape::BinHq
}

/// Whether a failed npm install is the "npm's own global install target directory
/// does not exist" condition (HQ-DESKTOP-5K): npm's `mkdir` of the install target
/// fails `ENOENT` because the machine's npm global prefix directory chain is
/// absent, so `npm install -g @indigoai-us/hq-cli@latest` dies before it can
/// create the package and the user's CLI silently never updates.
///
/// Keyed on npm's OWN structured signals exactly as [`is_disk_exhaustion_failure`]
/// keys on `ENOSPC` and [`is_npm_bin_collision`] keys on `EEXIST` — never a bare
/// `detail.contains("ENOENT")`, which would swallow both the better-sqlite3
/// lifecycle fixture (`code ENOENT` WITH `command failed`) and any unrelated defect
/// whose stderr merely mentions `ENOENT`. It requires ALL of:
///   * npm's `code ENOENT` AND `syscall mkdir` (the exact make-the-target-dir shape);
///   * a global-install path shape — the top of the install tree, either
///     [`NpmPathShape::GlobalLibNodeModules`] (no prefix resolved) or
///     [`NpmPathShape::SelectedPrefixNodeModules`] (a resolved prefix);
///   * the ABSENCE of BOTH lifecycle signals, so a third-party native build that
///     happens to `mkdir`-fail keeps its own per-package lifecycle attribution and
///     is never collapsed into this bucket.
///
/// Disjoint by construction from every other classifier arm: `ENOSPC`/`EACCES`/
/// `EPERM`/`EEXIST`/`EIDLETIMEOUT` all carry a different `code`, and a genuine
/// lifecycle failure carries a lifecycle marker this predicate excludes.
pub fn is_missing_global_install_target(detail: &str, prefix: Option<&str>) -> bool {
    npm_error_code(detail) == "ENOENT"
        && npm_syscall(detail) == "mkdir"
        && matches!(
            npm_path_shape(detail, prefix),
            NpmPathShape::GlobalLibNodeModules | NpmPathShape::SelectedPrefixNodeModules
        )
        && npm_reported_path_is_global_install_root(detail)
        && !has_npm_lifecycle_failure_marker(detail)
        && !npm_lifecycle_failure(detail).failed
}

/// Whether npm's reported path terminates AT the global install root — the
/// `@indigoai-us` scope directory, or the `@indigoai-us/hq-cli` package directory
/// itself — rather than some DEEPER path inside an already-created package (e.g.
/// `.../@indigoai-us/hq-cli/node_modules/foo/cache`). The HQ-DESKTOP-5K shape is a
/// missing directory at the TOP of the global install tree; a `mkdir` ENOENT deeper
/// than the package root means the prefix chain already exists and is a DIFFERENT
/// failure, which must not be misfiled as a missing prefix and then subjected to a
/// no-op mkdir, needless managed-Node provisioning, a Warning downgrade, and
/// repeat-suppression. `npm_path_shape` alone matches any path CONTAINING the
/// selected prefix's `node_modules` (or `/node_modules/@indigoai-us/hq-cli`), so
/// this terminal check narrows the classifier to the actual root. Keyed on the
/// normalized path's exact terminal components (never a substring).
fn npm_reported_path_is_global_install_root(detail: &str) -> bool {
    let Some(path) = normalized_npm_path(detail) else {
        return false;
    };
    let path = path.trim_end_matches('/');
    path.ends_with("/node_modules/@indigoai-us")
        || path.ends_with("/node_modules/@indigoai-us/hq-cli")
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
    } else if is_windows_locked_install_target_failure(exit_code, detail, prefix) {
        InstallFailureKind::WindowsLockedInstallTarget
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
    } else if is_foreign_registry_package_missing(detail) {
        // Placed AFTER the lifecycle arm so a third-party build failure whose
        // stderr mentions 404 keeps its per-package attribution, and BEFORE the
        // missing-global-install-target arm — the same placement rationale that arm
        // documents. npm resolved the `@indigoai-us` scope through a registry that
        // does not carry the package: a permanent local registry misconfiguration,
        // reported at Warning under its own attributed group. Disjoint from every
        // other arm in this env-blind ladder; the only other E404 arm — the
        // env-aware npmjs-pinned tarball transient — lives in
        // `classify_install_failure_with_environment` and requires the npmjs origin
        // this Foreign arm excludes.
        InstallFailureKind::ForeignRegistryPackageMissing
    } else if is_missing_global_install_target(detail, prefix) {
        // Placed AFTER the lifecycle arm so a third-party build failure keeps its
        // per-package attribution; the predicate additionally excludes both
        // lifecycle signals, so the ordering is belt-and-suspenders. npm could not
        // create its own global install-target dir — a broken local npm prefix,
        // reported at Warning under its own bounded group once HQ's own repair
        // (mkdir + managed toolchain) has been attempted and declined.
        InstallFailureKind::MissingGlobalInstallTarget
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
/// first and rewrites the result ONLY from a base of exactly `Unexpected`, in two
/// disjoint cases —
///   * [`is_npmjs_pinned_tarball_not_yet_served`] holds (HQ-DESKTOP-6D): an npmjs
///     tarball 404 in a pinned install is the mid-publish serving-lag twin of
///     ETARGET, so it becomes `ExpectedTransientRegistry` until the recurrence
///     window expires; OR
///   * the probed Node major parsed AND is strictly below [`MIN_NODE_MAJOR`] — a
///     runtime the CLI's own `engines.node` makes install impossible on — so it
///     becomes `UnsupportedNode`.
///
/// The tarball refinement is checked FIRST: npm's own structured 404 proves npm
/// ran and resolved the packument for this attempt, so the Node-floor inference
/// (which fires when npm dies BEFORE emitting a structured block) does not apply;
/// once the serving lag clears, the next check reclassifies exactly as today.
/// Every expected/lifecycle kind is returned untouched. The tarball arm requires
/// a pinned target version (absent by default), and the Node arm a sub-floor probe,
/// so `InstallEnvironment::default()` stays byte-identical to the env-blind
/// classifier for every existing caller.
pub fn classify_install_failure_with_environment(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> InstallFailureKind {
    classify_install_failure_with_environment_and_stderr(
        exit_code,
        detail,
        detail,
        prefix,
        final_attempt_forced,
        env,
    )
}

/// Classify a failed install while keeping the actual stderr separate from the
/// detail shown to the user. `detail` may include stdout as a fallback; native
/// process-crash evidence must use stderr because Node can emit ordinary stdout
/// before Windows terminates it with an access violation.
pub fn classify_install_failure_with_environment_and_stderr(
    exit_code: Option<i32>,
    detail: &str,
    raw_stderr: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> InstallFailureKind {
    if env.toolchain_source == NpmToolchainSource::Managed
        && env.node_abi.is_none()
        && env.npm_version.is_none()
        && is_windows_native_crash_status(exit_code)
        && node_crash_kind(exit_code, raw_stderr).kind != NodeCrashKind::None
    {
        // HQ-DESKTOP-56: a managed Node access violation with failed runtime
        // probes is evidence that HQ's own extracted toolchain is broken. Keep
        // the event reportable under a closed crash tag and let the app use its
        // existing bounded managed repair and one-shot retry.
        return InstallFailureKind::NativeCrash;
    }

    let base = classify_install_failure_with_final_attempt(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
    );
    if base == InstallFailureKind::Unexpected
        && !env.registry_serving_lag_recurred
        && is_npmjs_pinned_tarball_not_yet_served(detail, env)
    {
        // HQ-DESKTOP-6D: registry.npmjs.org lists the version the updater just
        // resolved but is not yet serving its tarball object — the tarball-layer
        // twin of the ETARGET packument lag. It self-heals on the next scheduled
        // check and no updater change can install through it, so reuse the existing
        // transient-registry disposition (no Sentry capture, transient UI copy,
        // scheduled retry). Refined BEFORE the unsupported-Node arm: npm's own
        // structured 404 proves npm ran for this attempt, so the Node-floor
        // inference does not apply.
        return InstallFailureKind::ExpectedTransientRegistry;
    }
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
            Self::WindowsLockedInstallTarget => "windows-locked-install-target",
            Self::ExpectedTransientRegistry => "expected-transient-registry",
            Self::ExpectedBinCollision => "expected-bin-collision",
            Self::ExpectedDiskFull => "expected-disk-full",
            Self::UnexpectedLifecycle => "unexpected-lifecycle",
            Self::Unexpected => "unexpected",
            Self::NativeCrash => "native_crash",
            Self::UnsupportedNode => "unsupported-node",
            Self::MissingGlobalInstallTarget => "missing-global-install-target",
            Self::ForeignRegistryPackageMissing => "foreign-registry-404",
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

/// The env-blind signature every fully markerless install failure collapses to:
/// npm structured no error code, no syscall, and no path. It is simultaneously the
/// Sentry title and the 4th fingerprint component, so historically two unrelated
/// markerless causes shared one permanently-Error issue (HQ-DESKTOP-56). The new
/// attributed-signature arm and the episode-key arm both key off this exact string,
/// so they can never disagree about which failures are "shapeless".
const SHAPELESS_INSTALL_SIGNATURE: &str = "none:unknown:none";

/// The closed origin vocabulary for a markerless install stderr — WHERE the bytes
/// came from, decided purely by whether npm's own logger emitted any line. `empty`
/// is folded out of the attributed subclass (an empty stderr stays the
/// genuinely-shapeless `none:unknown:none`), leaving `npm-logger` and `non-npm` as
/// the two attributed origins.
pub const STDERR_ORIGIN_EMPTY: &str = "empty";
pub const STDERR_ORIGIN_NPM_LOGGER: &str = "npm-logger";
pub const STDERR_ORIGIN_NON_NPM: &str = "non-npm";

/// Closed classification for a Node process that died before npm's logger
/// produced an error. Values are safe for tags and bounded grouping keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeCrashKind {
    None,
    V8HeapOom,
    V8Fatal,
    NativeAssertion,
    AccessViolation,
    StackBufferOverrun,
    Abort,
    Breakpoint,
}

impl NodeCrashKind {
    fn tag_value(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::V8HeapOom => "v8_heap_oom",
            Self::V8Fatal => "v8_fatal",
            Self::NativeAssertion => "native_assertion",
            Self::AccessViolation => "access_violation",
            Self::StackBufferOverrun => "stack_buffer_overrun",
            Self::Abort => "abort",
            Self::Breakpoint => "breakpoint",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NodeCrashClassification {
    kind: NodeCrashKind,
    evidence: &'static str,
}

impl NodeCrashClassification {
    const NONE: Self = Self {
        kind: NodeCrashKind::None,
        evidence: "none",
    };
}

/// Recognize known Node crash statuses paired with stable Node/V8 stderr
/// signatures. Windows access violations are also identifiable by status alone
/// when the process produced no stderr. Arbitrary exit codes remain `none`.
fn node_crash_kind(exit_code: Option<i32>, stderr: &str) -> NodeCrashClassification {
    const NODE_ABORT: i32 = 134;
    const STATUS_BREAKPOINT: i32 = -2_147_483_645;
    const STATUS_ACCESS_VIOLATION: i32 = -1_073_741_819;
    const STATUS_STACK_BUFFER_OVERRUN: i32 = -1_073_740_791;

    let Some(code) = exit_code else {
        return NodeCrashClassification::NONE;
    };
    if !matches!(
        code,
        NODE_ABORT
            | STATUS_BREAKPOINT
            | STATUS_ACCESS_VIOLATION
            | STATUS_STACK_BUFFER_OVERRUN
            | -1
    ) {
        return NodeCrashClassification::NONE;
    }

    // Windows can terminate Node with STATUS_ACCESS_VIOLATION before writing
    // any stderr. The exit status itself is the stable evidence for this case.
    if code == STATUS_ACCESS_VIOLATION && stderr.trim().is_empty() {
        return NodeCrashClassification {
            kind: NodeCrashKind::AccessViolation,
            evidence: "exit_status_access_violation",
        };
    }

    // npm's own marker proves this is not the pre-logger failure class, and
    // matching only line prefixes avoids treating echoed input as Node evidence.
    if has_any_npm_marker_line(stderr) {
        return NodeCrashClassification::NONE;
    }
    let mut oom = false;
    let mut fatal = false;
    let mut assertion = false;
    let mut native_trace = false;
    for line in stderr.lines() {
        let line = line.trim().to_ascii_lowercase();
        fatal |= line.starts_with("fatal error:");
        oom |= line.starts_with("fatal error:")
            && line.contains("javascript heap out of memory");
        assertion |= line.starts_with("assertion failed");
        native_trace |= line.starts_with("node::") || line.starts_with("native stack trace");
    }
    if !(oom || fatal || assertion || native_trace) {
        return NodeCrashClassification::NONE;
    }

    let evidence = if oom {
        "javascript_heap_oom"
    } else if assertion {
        "assertion_failed"
    } else if fatal {
        "fatal_error_marker"
    } else {
        "node_native_trace"
    };
    let kind = if oom {
        NodeCrashKind::V8HeapOom
    } else if code == STATUS_BREAKPOINT {
        NodeCrashKind::Breakpoint
    } else if code == STATUS_ACCESS_VIOLATION {
        NodeCrashKind::AccessViolation
    } else if code == STATUS_STACK_BUFFER_OVERRUN {
        NodeCrashKind::StackBufferOverrun
    } else if assertion {
        NodeCrashKind::NativeAssertion
    } else if fatal {
        NodeCrashKind::V8Fatal
    } else {
        NodeCrashKind::Abort
    };
    NodeCrashClassification { kind, evidence }
}

/// Windows NTSTATUS crash exits that the existing Node crash classifier knows
/// how to attribute. POSIX signal exits stay on their existing classification
/// path and do not trigger a Windows-only forced replacement.
fn is_windows_native_crash_status(exit_code: Option<i32>) -> bool {
    matches!(
        exit_code,
        Some(-2_147_483_645 | -1_073_741_819 | -1_073_740_791)
    )
}

/// Whether one stderr line is an npm-logger line (`npm error …` / `npm ERR! …`,
/// case-insensitively). These are the lines npm's own error reporter writes; their
/// presence proves npm ran and reported, even when it never emitted the structured
/// `code`/`syscall`/`path` trio the signature keys on.
fn is_npm_marker_line(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    lower.starts_with("npm error ") || lower.starts_with("npm err! ")
}

/// True when ANY line of the stderr is an npm-logger line. Tells an `npm-logger`
/// origin (npm printed something) from a `non-npm` one (npm's logger produced
/// nothing at all — the user's npm/shim never really ran).
fn has_any_npm_marker_line(detail: &str) -> bool {
    detail.lines().any(is_npm_marker_line)
}

/// The origin of a markerless install stderr, as the closed
/// `empty | npm-logger | non-npm` enumeration. A pure function of `detail`, so it
/// crosses no app/core boundary and needs no new [`InstallEnvironment`] field.
fn stderr_origin(detail: &str) -> &'static str {
    if detail.trim().is_empty() {
        STDERR_ORIGIN_EMPTY
    } else if has_any_npm_marker_line(detail) {
        STDERR_ORIGIN_NPM_LOGGER
    } else {
        STDERR_ORIGIN_NON_NPM
    }
}

/// A bounded, content-safe structural profile of a NON-EMPTY markerless install
/// stderr: its origin, the dominant unmatched-shape token, and a bounded top-N
/// `shape:count` render. Built by reusing the reviewed, content-free
/// [`UnmatchedStderrShapeRollup`] vocabulary (HQ-DESKTOP-5H) rather than inventing a
/// second telemetry primitive. Only structure is inspected; not one stderr byte is
/// retained.
struct UnattributedStderrProfile {
    origin: &'static str,
    dominant_shape: &'static str,
    /// The bounded `shape:count` tag render. Always non-empty here because a profile
    /// is only ever built for a non-empty stderr.
    shapes_tag: String,
}

/// Build the structural profile for a non-empty stderr. Splits on newlines
/// (trimming a trailing carriage return so Windows CRLF output does not scatter the
/// shapes — [`str::lines`] does exactly this), skips npm-logger lines so the profile
/// describes what npm did NOT characterise, and classifies each remaining line
/// through the closed shape vocabulary. If every line was an npm-logger line (a pure
/// `npm-logger` origin), it falls back to classifying the marker lines themselves,
/// so the dominant shape is always a real bounded token and the group cardinality
/// stays exactly origins × shapes.
fn unattributed_stderr_profile(detail: &str) -> UnattributedStderrProfile {
    let origin = stderr_origin(detail);
    let mut rollup = UnmatchedStderrShapeRollup::default();
    let mut recorded_non_marker = false;
    for line in detail.lines() {
        if is_npm_marker_line(line) {
            continue;
        }
        rollup.record(line);
        recorded_non_marker = true;
    }
    if !recorded_non_marker {
        // Every line was an npm-logger line; classify them so a pure npm-logger
        // stderr still yields a bounded dominant shape instead of an empty rollup.
        for line in detail.lines() {
            rollup.record(line);
        }
    }
    let dominant_shape = rollup
        .dominant()
        .unwrap_or(UnmatchedStderrShape::Other)
        .as_str();
    let shapes_tag = rollup.tag_value().unwrap_or_else(|| "none".to_string());
    UnattributedStderrProfile {
        origin,
        dominant_shape,
        shapes_tag,
    }
}

/// The structural profile IFF this failure is the newly attributed subclass: an
/// `Unexpected` failure whose env-blind signature is the shapeless
/// `none:unknown:none`, whose stderr is non-empty, AND for which npm reported NO
/// lifecycle failure. `None` for every other failure:
///   * an EMPTY stderr stays genuinely shapeless (keeps today's `none:unknown:none`
///     envelope and unbounded paging);
///   * any shape npm actually characterised keeps its existing discriminating
///     signature;
///   * a lifecycle failure whose numeric build-script status collapsed to
///     `none:unknown:none` is a DIFFERENT mechanism (npm DID recognise a lifecycle
///     failure and the event already carries `npm_lifecycle_cause`), so it keeps its
///     existing envelope — the reopen population this fix targets is precisely the
///     one where npm reported nothing at all (`npm_lifecycle_failed=false`).
fn install_failure_unattributed_profile(
    kind: InstallFailureKind,
    detail: &str,
    prefix: Option<&str>,
) -> Option<UnattributedStderrProfile> {
    let attributed = kind == InstallFailureKind::Unexpected
        && install_failure_signature(kind, detail, prefix) == SHAPELESS_INSTALL_SIGNATURE
        && !detail.trim().is_empty()
        && !npm_lifecycle_failure(detail).failed;
    attributed.then(|| unattributed_stderr_profile(detail))
}

/// The stderr origin of an attributed markerless install failure, for the
/// managed-toolchain retry decision. `Some(origin)` ONLY when this is the newly
/// attributed subclass (see [`install_failure_unattributed_profile`]); `None`
/// otherwise, so the retry gate can never arm on a shape npm characterised or on a
/// genuinely empty stderr. The returned origin is `npm-logger` or `non-npm` — the
/// `empty` case is folded into `None`. Pure so the app-side gate stays unit-testable
/// from a value instead of re-deriving the classification at the call site.
pub fn unattributed_install_stderr_origin(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
) -> Option<&'static str> {
    let kind = classify_install_failure_with_environment(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
    );
    install_failure_unattributed_profile(kind, detail, prefix).map(|profile| profile.origin)
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
    if kind == InstallFailureKind::MissingGlobalInstallTarget {
        // Its OWN bounded group, so it leaves the `unexpected` catch-all. The
        // predicate already fixed `code == ENOENT` and `syscall == mkdir`, so those
        // carry no discriminating power here; the only varying closed dimension is
        // WHICH global-install path shape npm named (a resolved-prefix target vs. a
        // prefix-less one), which is kept. Mirrors the `unsupported-node:<major>`
        // precedent: `<fingerprint-component>:<closed-discriminator>`.
        return format!(
            "missing-global-install-target:{}",
            npm_path_shape(detail, prefix).tag_value(),
        );
    }
    if kind == InstallFailureKind::ForeignRegistryPackageMissing {
        // Its OWN bounded group, so it leaves the `unexpected` catch-all. The
        // predicate already fixed origin == Foreign, so only WHICH resource npm's
        // 404 named varies (at most four values). Mirrors the
        // `missing-global-install-target:<shape>` precedent.
        return foreign_registry_404_signature(detail);
    }
    if kind == InstallFailureKind::Unexpected && npm_error_code(detail) == "E404" {
        // An E404 that stayed `Unexpected` (npmjs- or unknown-origin): give it an
        // attributed signature distinct from the foreign-registry group, so the two
        // E404 populations can never share a Sentry issue. This is an INTENTIONAL
        // fingerprint change for E404 only (HQ-DESKTOP-5Q) — the old
        // `E404:unknown:none` group goes quiet and any recurrence opens a new,
        // attributed group. Every non-E404 signature stays byte-identical.
        return unexpected_e404_signature(detail);
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
    if kind == InstallFailureKind::NativeCrash {
        return "native-crash".to_string();
    }
    // A NON-EMPTY markerless `Unexpected` failure (HQ-DESKTOP-56 reopen): npm
    // structured nothing, so the env-blind signature would collapse to the empty
    // `none:unknown:none` bucket where unrelated causes merged into one permanently
    // Error issue. Give it a bounded structural signature — `unattributed:<origin>:
    // <dominant shape>`, at most 2 origins × 8 shapes = 16 groups — so distinct
    // causes stop colliding and the next occurrence is self-diagnosing. The report
    // boundary may refine a non-npm signature to `node-crash:<kind>` when both a
    // known process status and a stable Node/V8 marker agree. An EMPTY stderr is
    // deliberately excluded (returns `None` from the profile), so it keeps the
    // byte-identical `none:unknown:none` envelope and its pinned test.
    if let Some(profile) = install_failure_unattributed_profile(kind, detail, prefix) {
        return format!("unattributed:{}:{}", profile.origin, profile.dominant_shape);
    }
    install_failure_signature(kind, detail, prefix)
}

/// Add a crash-specific signature only to non-npm markerless failures. The
/// classifier requires both a known crash status and a stable Node/V8 marker;
/// ordinary npm errors and unknown crashes retain their existing signature.
fn install_failure_signature_with_exit_code(
    exit_code: Option<i32>,
    kind: InstallFailureKind,
    detail: &str,
    prefix: Option<&str>,
    env: &InstallEnvironment,
) -> String {
    let crash = node_crash_kind(exit_code, detail);
    if matches!(kind, InstallFailureKind::Unexpected | InstallFailureKind::NativeCrash)
        && crash.kind != NodeCrashKind::None
    {
        return format!("node-crash:{}", crash.kind.tag_value());
    }
    install_failure_signature_with_environment(kind, detail, prefix, env)
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
    if kind == InstallFailureKind::WindowsLockedInstallTarget {
        return "Windows could not replace a package in npm's selected install folder because it is still in use. Close the terminal or application using that package, wait briefly, then retry the copied command. HQ will retry once automatically.".to_string();
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
    if kind == InstallFailureKind::MissingGlobalInstallTarget {
        // npm's own global install folder does not exist on this machine and HQ's
        // automatic repair could not create it. Name the condition and hand the
        // user the copy-the-command escape hatch — never the raw npm stderr, which
        // carries the machine's filesystem path. Placed BEFORE the non-empty-stderr
        // passthrough so the path is never surfaced verbatim.
        return "hq could not update because npm's global install folder is missing on this computer and it couldn't be created automatically. Run the copied command in a terminal to finish the update; if that folder lives on a network or removed drive, reconnect it first.".to_string();
    }
    if kind == InstallFailureKind::ForeignRegistryPackageMissing {
        // This machine's npm resolves the @indigoai-us scope through a registry that
        // does not carry hq. Name the condition and the fix; never echo the registry
        // host or the raw npm stderr (which carries the URL). Placed BEFORE the
        // non-empty-stderr passthrough so the host is never surfaced verbatim, and it
        // keeps the "copied command" escape hatch every other arm keeps.
        return "hq could not update because this computer's npm is set to use a package registry that does not carry hq. Point npm at the public npm registry for the @indigoai-us scope (or reconnect to your company VPN if it uses an internal mirror), then run the copied command in a terminal.".to_string();
    }
    if kind == InstallFailureKind::NativeCrash && detail.trim().is_empty() {
        return "The Node.js process used to install hq crashed before npm could report an error. HQ's automatic managed-runtime repair and retry did not complete the update. Run the copied command in a terminal if the update still fails.".to_string();
    }
    if npm_lifecycle_failure(detail).failed {
        // Cause-specific, actionable wording. Every branch keeps the copyable
        // command escape hatch ("copied command") so the UI fallback is intact
        // regardless of which cause was diagnosed.
        return match npm_lifecycle_cause(detail) {
            "toolchain-missing" => "A dependency needs to build a native component, but this computer has no build tools for it. Run the copied command in a terminal to see the full build output.",
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
        InstallFailureKind::WindowsLockedInstallTarget => {
            "Windows could not replace a package in npm's selected install folder because it is still in use. Close the terminal or application using that package, wait briefly, then retry the copied command. HQ will retry once automatically.".to_string()
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
        InstallFailureKind::NativeCrash => "The Node.js process used to install hq crashed before npm could report an error. HQ's automatic managed-runtime repair and retry did not complete the update. Run the copied command in a terminal if the update still fails.".to_string(),
        // `UnsupportedNode`, `MissingGlobalInstallTarget`, and
        // `ForeignRegistryPackageMissing` return their actionable copy early above;
        // these arms keep the match exhaustive without ever being reached for them.
        InstallFailureKind::Unexpected
        | InstallFailureKind::UnexpectedLifecycle
        | InstallFailureKind::UnsupportedNode
        | InstallFailureKind::MissingGlobalInstallTarget
        | InstallFailureKind::ForeignRegistryPackageMissing => format!(
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
    if env.windows_busy_retry_outcome == WindowsBusyRetryOutcome::DeferredUserCli
        || env.windows_busy_deferral_outcome == WindowsBusyDeferralOutcome::Deferred
    {
        return None;
    }
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
        | InstallFailureKind::NativeCrash
        | InstallFailureKind::UnexpectedLifecycle
        | InstallFailureKind::UnsupportedNode
        | InstallFailureKind::WindowsLockedInstallTarget
        | InstallFailureKind::MissingGlobalInstallTarget
        | InstallFailureKind::ForeignRegistryPackageMissing => {}
        InstallFailureKind::ExpectedPrefixPermission
        | InstallFailureKind::ExpectedWindowsAbort
        | InstallFailureKind::ExpectedWindowsLockedBinary
        | InstallFailureKind::ExpectedTransientRegistry
        | InstallFailureKind::ExpectedDiskFull => return None,
    }
    // Title the capture with the same signature the fingerprint groups on, so a
    // Sentry issue's title cannot drift across the events inside it. The raw
    // exit status stays on the `exit_code` tag and in `npm_diagnostics`.
    let signature =
        install_failure_signature_with_exit_code(exit_code, kind, detail, prefix, env);
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

/// Whether the failing `npm install` pinned an exact CLI version or asked for the
/// `latest` dist-tag, as a CLOSED enumeration carried on [`InstallEnvironment`]
/// and tagged on the reported event. TAG ONLY — never a fingerprint, signature,
/// or episode-key component. Defaults to [`RequestedSpecKind::Unknown`], which is
/// emitted as NO tag at all, so every existing caller reproduces today's exact
/// tag set until it opts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RequestedSpecKind {
    PinnedVersion,
    LatestTag,
    #[default]
    Unknown,
}

impl RequestedSpecKind {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::PinnedVersion => "pinned-version",
            Self::LatestTag => "latest-tag",
            Self::Unknown => "unknown",
        }
    }
}

/// Why the one-shot managed-toolchain retry did or did not run, as a CLOSED
/// enumeration carried on [`InstallEnvironment`] and tagged on the reported
/// install failure. This is the evidence HQ-DESKTOP-5E lacked: the wire could not
/// distinguish "the self-heal was never armed" from "it was armed and declined",
/// nor which branch declined. Every value maps to a fixed `&'static str`, so no
/// free text ever reaches Sentry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ManagedRetryOutcome {
    /// The reported failure was not a shape that arms the managed retry
    /// (`install_failure_earns_managed_retry` returned false). The default, so an
    /// `InstallEnvironment` that never considered a retry tags itself honestly.
    #[default]
    NotArmed,
    /// The retry ran npm under HQ's managed toolchain (this is the provenance of a
    /// managed-site failure report; a converged retry emits no event at all).
    Ran,
    /// Armed, and a fresh managed-Node provision completed, but HQ's managed npm
    /// still could not be resolved on disk — so no retry ran.
    NoManagedNpm,
    /// Armed, but the shared Node repair slot was claimed too recently
    /// (cooldown deferral), so no repair-dependent retry ran. Ordinary user-path
    /// recovery may still use an existing managed npm; a managed-crash retry does
    /// not reuse the runtime that just crashed.
    ProvisionDeferred,
    /// Armed, but a fresh managed-Node provision failed, so no repair-dependent
    /// retry ran. Ordinary user-path recovery may still use an existing managed npm.
    ProvisionFailed,
    /// Armed and a managed npm resolved, but npm itself could not be spawned.
    SpawnFailed,
    /// The managed runtime was repaired, but the retry could not safely write
    /// into a user-owned CLI prefix because its Node ABI was unknown or different.
    UnsafeUserTarget,
}

impl ManagedRetryOutcome {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::NotArmed => "not-armed",
            Self::Ran => "ran",
            Self::NoManagedNpm => "no-managed-npm",
            Self::ProvisionDeferred => "provision-deferred",
            Self::ProvisionFailed => "provision-failed",
            Self::SpawnFailed => "spawn-failed",
            Self::UnsafeUserTarget => "unsafe-user-target",
        }
    }
}

/// Outcome of the bounded Windows EBUSY package-target retry. This is separate
/// from [`ManagedRetryOutcome`], which describes Node/npm repair and cannot
/// release a process holding the selected install target open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowsBusyRetryOutcome {
    /// The install did not finish with the selected-prefix EBUSY/rename shape.
    #[default]
    NotApplicable,
    /// The shape matched, but no retry was available or safe to start.
    NotArmed,
    /// A bounded retry completed successfully.
    Succeeded,
    /// One or more bounded retries ran and the install still failed with EBUSY.
    Failed,
    /// A bounded retry failed, but its final output no longer identifies the
    /// selected install target as locked.
    OtherFailure,
    /// A terminal-started HQ CLI owns the package files. Leave it running and
    /// let the next scheduled update check retry after that session exits.
    DeferredUserCli,
}

impl WindowsBusyRetryOutcome {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::NotApplicable => "not-applicable",
            Self::NotArmed => "not-armed",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::OtherFailure => "other-failure",
            Self::DeferredUserCli => "deferred-user-cli",
        }
    }

    /// The final install output still proves that a process holds the target.
    pub fn lock_holder_class(self) -> Option<&'static str> {
        match self {
            Self::NotArmed | Self::Failed => Some("unknown"),
            Self::NotApplicable | Self::Succeeded | Self::OtherFailure | Self::DeferredUserCli => {
                None
            }
        }
    }
}

/// Closed telemetry outcome for the no-holder deferral. The
/// first two deferrals are breadcrumbs only; `Exhausted` is attached to the
/// existing Error report on the bounded terminal attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowsBusyDeferralOutcome {
    #[default]
    NotApplicable,
    Deferred,
    Exhausted,
}

impl WindowsBusyDeferralOutcome {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::NotApplicable => "not-applicable",
            Self::Deferred => "deferred",
            Self::Exhausted => "exhausted",
        }
    }
}

#[cfg(test)]
mod windows_busy_deferral_tests {
    use super::*;

    const PREFIX: &str = r"C:\Users\me\AppData\Roaming\npm";
    const DETAIL: &str = "npm error code EBUSY\n\
        npm error errno -4082\n\
        npm error syscall rename\n\
        npm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli";
    const TARGET: &str = "5.208.0";

    fn confirmed_no_holder() -> NpmLockHolderDiagnostic {
        NpmLockHolderDiagnostic {
            class: NpmLockHolderClass::None,
            count: 0,
            query_outcome: NpmLockHolderQueryOutcome::Complete,
            image_basename: None,
        }
    }

    fn decide(
        old_cli_still_works: bool,
        holder: NpmLockHolderDiagnostic,
        marker: Option<&WindowsBusyDeferralMarker>,
    ) -> Option<WindowsBusyDeferralDecision> {
        windows_busy_deferral_decision(
            old_cli_still_works,
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            Some(WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES as u8),
            WindowsBusyRetryOutcome::Failed,
            Some(holder),
            marker,
            TARGET,
        )
    }

    #[test]
    fn marker_parser_rejects_corruption_and_resets_for_a_new_target() {
        let stored = serde_json::json!({"target_version": TARGET, "attempts": 2});
        let marker = parse_windows_busy_deferral_marker(Some(&stored))
            .unwrap()
            .unwrap();
        assert_eq!(marker.attempts_for(TARGET), 2);
        assert_eq!(marker.attempts_for("5.209.0"), 0);
        assert_eq!(parse_windows_busy_deferral_marker(None).unwrap(), None);
        assert!(parse_windows_busy_deferral_marker(Some(&serde_json::json!({
            "target_version": "../private",
            "attempts": 2
        })))
        .is_err());
        assert!(parse_windows_busy_deferral_marker(Some(&serde_json::json!({
            "target_version": TARGET,
            "attempts": 4
        })))
        .is_err());
    }

    #[test]
    fn exact_no_holder_ebusy_defers_then_reports_on_the_third_attempt() {
        assert_eq!(
            decide(true, confirmed_no_holder(), None),
            Some(WindowsBusyDeferralDecision::Deferred { attempts: 1 })
        );
        let prior = WindowsBusyDeferralMarker {
            target_version: TARGET.to_string(),
            attempts: 2,
        };
        assert_eq!(
            decide(true, confirmed_no_holder(), Some(&prior)),
            Some(WindowsBusyDeferralDecision::Exhausted { attempts: 3 })
        );
        let old_target = WindowsBusyDeferralMarker {
            target_version: "5.207.0".to_string(),
            attempts: 2,
        };
        assert_eq!(
            decide(true, confirmed_no_holder(), Some(&old_target)),
            Some(WindowsBusyDeferralDecision::Deferred { attempts: 1 })
        );
        assert_eq!(
            decide(
                true,
                confirmed_no_holder(),
                Some(&WindowsBusyDeferralMarker {
                    target_version: TARGET.to_string(),
                    attempts: 3,
                })
            ),
            Some(WindowsBusyDeferralDecision::Exhausted { attempts: 3 })
        );
    }

    #[test]
    fn manifest_version_mismatch_with_cli_output_does_not_block_deferral() {
        let before_manifest_version = "5.207.0";
        let after_manifest_version = "5.207.0";
        let command_version = "5.206.0";
        assert_ne!(before_manifest_version, command_version);

        let old_cli_unchanged = windows_busy_cli_version_unchanged(
            Some(before_manifest_version),
            Some(after_manifest_version),
            Some(command_version),
        );
        assert!(old_cli_unchanged);
        assert_eq!(
            decide(old_cli_unchanged, confirmed_no_holder(), None),
            Some(WindowsBusyDeferralDecision::Deferred { attempts: 1 })
        );
    }

    #[test]
    fn changed_resolved_version_keeps_existing_install_failure_path() {
        let before_resolved_version = "5.207.0";
        let after_resolved_version = "5.208.0";
        let command_liveness_version = "5.207.0";

        let old_cli_unchanged = windows_busy_cli_version_unchanged(
            Some(before_resolved_version),
            Some(after_resolved_version),
            Some(command_liveness_version),
        );
        assert!(!old_cli_unchanged);
        assert_eq!(decide(old_cli_unchanged, confirmed_no_holder(), None), None);
        assert!(install_failure_report(Some(-4082), DETAIL, Some(PREFIX)).is_some());
    }

    #[test]
    fn each_missing_version_probe_input_fails_closed() {
        let version = "5.207.0";

        assert!(!windows_busy_cli_version_unchanged(
            None,
            Some(version),
            Some(version),
        ));
        assert!(!windows_busy_cli_version_unchanged(
            Some(version),
            None,
            Some(version),
        ));
        assert!(!windows_busy_cli_version_unchanged(
            Some(version),
            Some(version),
            None,
        ));
    }

    #[test]
    fn no_flag_source_does_not_suppress_confirmed_no_holder_deferral() {
        assert_eq!(
            decide(true, confirmed_no_holder(), None),
            Some(WindowsBusyDeferralDecision::Deferred { attempts: 1 }),
            "a missing feature flag source must not disable this bug fix"
        );
    }

    #[test]
    fn real_holder_incomplete_query_or_unusable_cli_keeps_existing_path() {
        let no_holder = confirmed_no_holder();
        assert_eq!(decide(false, no_holder, None), None);

        let real_holder = NpmLockHolderDiagnostic {
            class: NpmLockHolderClass::DefenderOrIndexer,
            count: 1,
            query_outcome: NpmLockHolderQueryOutcome::Complete,
            image_basename: Some("MsMpEng.exe".into()),
        };
        assert_eq!(decide(true, real_holder.clone(), None), None);
        let incomplete_query = NpmLockHolderDiagnostic {
            class: NpmLockHolderClass::None,
            count: 0,
            query_outcome: NpmLockHolderQueryOutcome::Unavailable,
            image_basename: None,
        };
        assert_eq!(decide(true, incomplete_query, None), None);
        assert!(install_failure_report(Some(-4082), DETAIL, Some(PREFIX)).is_some());
    }

    #[test]
    fn exhausted_deferral_keeps_error_level_and_emits_bounded_count_tags() {
        let env = InstallEnvironment {
            windows_busy_retry_attempts: Some(WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES as u8),
            windows_busy_retry_outcome: WindowsBusyRetryOutcome::Failed,
            lock_holder_diagnostic: Some(confirmed_no_holder()),
            ..InstallEnvironment::default()
        }
        .with_windows_busy_deferral(3, WindowsBusyDeferralOutcome::Exhausted);
        let unchanged = InstallEnvironment {
            windows_busy_retry_attempts: Some(WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES as u8),
            windows_busy_retry_outcome: WindowsBusyRetryOutcome::Failed,
            lock_holder_diagnostic: Some(confirmed_no_holder()),
            ..InstallEnvironment::default()
        };
        let expected =
            install_failure_report_with_environment(Some(-4082), DETAIL, Some(PREFIX), false, &env)
                .unwrap();
        assert_eq!(
            expected,
            install_failure_report_with_environment(
                Some(-4082),
                DETAIL,
                Some(PREFIX),
                false,
                &unchanged,
            )
            .unwrap(),
            "deferral telemetry must not change the existing Error message"
        );
        let kind = classify_install_failure_with_environment(
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            false,
            &env,
        );
        assert_eq!(
            install_failure_signature_with_environment(kind, DETAIL, Some(PREFIX), &env),
            install_failure_signature_with_environment(kind, DETAIL, Some(PREFIX), &unchanged),
            "deferral telemetry must not change the existing fingerprint signature"
        );
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(-4082),
                DETAIL,
                Some(PREFIX),
                false,
                "5.208.0",
                &env,
            ),
            install_failure_episode_key_with_environment(
                Some(-4082),
                DETAIL,
                Some(PREFIX),
                false,
                "5.208.0",
                &unchanged,
            ),
            "deferral telemetry must not change the existing repeat-guard key"
        );
        let events = sentry::test::with_captured_events(|| {
            report_install_failure_with_environment(Some(-4082), DETAIL, Some(PREFIX), false, &env);
        });
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(event.message.as_deref(), Some(expected.as_str()));
        assert_eq!(event.tags["npm_windows_busy_deferral_attempts"], "3");
        assert_eq!(event.tags["npm_windows_busy_deferral_outcome"], "exhausted");
    }

    #[test]
    fn running_cli_version_tag_is_bounded_semver_or_unknown_and_path_free() {
        let events = sentry::test::with_captured_events(|| {
            let path_value = InstallEnvironment::default()
                .with_running_cli_version(Some(r"C:\Users\Alice\hq-cli\5.210.0"));
            report_install_failure_with_environment(
                Some(-4082),
                DETAIL,
                Some(PREFIX),
                false,
                &path_value,
            );
            let semver_value = InstallEnvironment::default()
                .with_running_cli_version(Some("5.211.0-beta.1"));
            report_install_failure_with_environment(
                Some(-4082),
                DETAIL,
                Some(PREFIX),
                false,
                &semver_value,
            );
        });
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tags["hq_cli_running_version"], "unknown");
        assert_eq!(events[1].tags["hq_cli_running_version"], "5.211.0-beta.1");
        assert!(!events[0].tags["hq_cli_running_version"].contains("Users"));
    }

    #[test]
    fn a_deferral_is_not_reported_but_exhaustion_remains_reportable() {
        let stderr = DETAIL;
        let deferred = InstallEnvironment::default()
            .with_windows_busy_deferral(1, WindowsBusyDeferralOutcome::Deferred);
        assert!(install_failure_report_with_environment(
            Some(-4082),
            stderr,
            Some(PREFIX),
            false,
            &deferred,
        )
        .is_none());

        let exhausted = InstallEnvironment::default()
            .with_windows_busy_deferral(3, WindowsBusyDeferralOutcome::Exhausted);
        assert!(install_failure_report_with_environment(
            Some(-4082),
            stderr,
            Some(PREFIX),
            false,
            &exhausted,
        )
        .is_some());
    }
}

#[cfg(test)]
mod windows_busy_retry_outcome_tests {
    use super::WindowsBusyRetryOutcome;

    #[test]
    fn lock_holder_is_unknown_only_when_the_lock_still_matches_the_final_outcome() {
        assert_eq!(
            WindowsBusyRetryOutcome::NotArmed.lock_holder_class(),
            Some("unknown")
        );
        assert_eq!(
            WindowsBusyRetryOutcome::Failed.lock_holder_class(),
            Some("unknown")
        );
        for outcome in [
            WindowsBusyRetryOutcome::NotApplicable,
            WindowsBusyRetryOutcome::Succeeded,
            WindowsBusyRetryOutcome::OtherFailure,
            WindowsBusyRetryOutcome::DeferredUserCli,
        ] {
            assert_eq!(outcome.lock_holder_class(), None);
        }
    }
}

#[cfg(test)]
mod restart_manager_holder_tests {
    use super::*;

    fn result(
        process_id: u32,
        application_name: &str,
        image_name: Option<&str>,
        has_terminal_ancestor: bool,
        app_child_kind: Option<AppOwnedProcessKind>,
    ) -> RestartManagerProcessResult {
        RestartManagerProcessResult {
            process_id,
            process_start_time: u64::from(process_id) * 10,
            application_name: application_name.to_string(),
            service_short_name: String::new(),
            image_name: image_name.map(str::to_string),
            has_terminal_ancestor,
            app_child_kind,
        }
    }

    #[test]
    fn restart_manager_results_map_to_the_closed_holder_classes_and_unique_count() {
        let cases = [
            (
                result(
                    1,
                    "HQ Sync",
                    Some("hq-sync.exe"),
                    false,
                    Some(AppOwnedProcessKind::HqSyncRunner),
                ),
                NpmLockHolderClass::HqSyncRunner,
            ),
            (
                result(
                    2,
                    "MCP",
                    Some("node.exe"),
                    false,
                    Some(AppOwnedProcessKind::McpOrWatcherChild),
                ),
                NpmLockHolderClass::McpOrWatcherChild,
            ),
            (
                result(3, "Node.js", Some("node.exe"), true, None),
                NpmLockHolderClass::UserTerminalHqCli,
            ),
            (
                result(
                    4,
                    "Antimalware Service Executable",
                    Some("MsMpEng.exe"),
                    false,
                    None,
                ),
                NpmLockHolderClass::DefenderOrIndexer,
            ),
            (
                result(
                    5,
                    "Unrecognized application",
                    Some("other.exe"),
                    false,
                    None,
                ),
                NpmLockHolderClass::Other,
            ),
        ];
        for (input, expected) in cases {
            let classification = classify_restart_manager_holders(&[input]);
            assert_eq!(classification.class, expected);
            assert_eq!(classification.count, 1);
        }

        let duplicate = result(6, "Node.js", Some("node.exe"), true, None);
        let classification = classify_restart_manager_holders(&[duplicate.clone(), duplicate]);
        assert_eq!(classification.class, NpmLockHolderClass::UserTerminalHqCli);
        assert_eq!(classification.count, 1);
        assert_eq!(classification.image_basename(), Some("node.exe"));
        let mut windows_search = result(7, "Windows Search", Some("svchost.exe"), false, None);
        windows_search.service_short_name = "WSearch".to_string();
        assert_eq!(
            classify_restart_manager_holders(&[windows_search]).class,
            NpmLockHolderClass::DefenderOrIndexer
        );
        assert_eq!(
            classify_restart_manager_holders(&[]).class,
            NpmLockHolderClass::None
        );
    }

    #[test]
    fn holder_telemetry_has_only_a_safe_basename_and_never_a_path_or_message() {
        let safe = RestartManagerHolderObservation::from_results(
            &[result(9, "untrusted message", Some("node.exe"), true, None)],
            NpmLockHolderQueryOutcome::Complete,
        )
        .diagnostic();
        assert_eq!(safe.class, NpmLockHolderClass::UserTerminalHqCli);
        let safe_output = format!("{safe:?}");
        assert!(safe_output.contains("image_basename: Some(\"node.exe\")"));

        let path_shaped = RestartManagerHolderObservation::from_results(
            &[result(
                10,
                "untrusted message",
                Some(r"C:\Users\private\node.exe"),
                true,
                None,
            )],
            NpmLockHolderQueryOutcome::Complete,
        )
        .diagnostic();
        let path_shaped_output = format!("{path_shaped:?}");
        assert!(path_shaped_output.contains("image_basename: None"));
        assert!(!format!("{safe_output} {path_shaped_output}").contains("untrusted message"));
        let serialized = format!("{safe_output} {path_shaped_output}");
        assert!(!serialized.contains('/'));
        assert!(!serialized.contains('\\'));
    }

    #[test]
    fn an_owned_restart_manager_holder_is_included_in_the_quiescence_wait_set() {
        let observation = RestartManagerHolderObservation::from_results(
            &[
                result(
                    41,
                    "HQ Sync",
                    Some("node.exe"),
                    false,
                    Some(AppOwnedProcessKind::HqSyncRunner),
                ),
                result(42, "Search Indexer", Some("SearchIndexer.exe"), false, None),
            ],
            NpmLockHolderQueryOutcome::Complete,
        );
        assert!(observation.includes_owned_process(41, 410));
        assert!(!observation.includes_owned_process(41, 411));
        assert!(!observation.includes_owned_process(42, 420));
    }
}

#[cfg(test)]
mod windows_busy_backoff_tests {
    use super::*;

    const PREFIX: &str = r"C:\Users\me\AppData\Roaming\npm";
    const DETAIL: &str = "npm error code EBUSY\nnpm error errno -4082\nnpm error syscall rename\nnpm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli";

    #[test]
    fn windows_busy_backoff_is_unconditional_and_bounded() {
        let delays = (1..=WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES)
            .map(|retry| windows_busy_install_target_retry_delay(retry).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            delays,
            [
                std::time::Duration::from_secs(5),
                std::time::Duration::from_secs(15),
                std::time::Duration::from_secs(30),
            ]
        );
        assert!(windows_busy_install_target_retry_delay(4).is_none());
        assert_eq!(
            delays
                .iter()
                .map(|delay| delay.as_secs())
                .sum::<u64>(),
            50
        );
    }

    #[test]
    fn windows_busy_backoff_runs_three_bounded_retries_over_fifty_seconds() {
        let delays = (1..=WINDOWS_BUSY_INSTALL_TARGET_MAX_RETRIES)
            .map(|retry| windows_busy_install_target_retry_delay(retry).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            delays,
            [
                std::time::Duration::from_secs(5),
                std::time::Duration::from_secs(15),
                std::time::Duration::from_secs(30),
            ]
        );
        assert_eq!(delays.iter().map(|delay| delay.as_secs()).sum::<u64>(), 50);
        assert!(windows_busy_install_target_retry_delay(4).is_none());

        let first_retry = windows_busy_install_target_retry_rung(1).unwrap();
        let second_retry = windows_busy_install_target_retry_rung(2).unwrap();
        let third_retry = windows_busy_install_target_retry_rung(3).unwrap();
        assert!(should_retry_windows_busy_install_target(
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            &["plain"],
            4
        ));
        assert!(should_retry_windows_busy_install_target(
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            &["plain", first_retry],
            4
        ));
        assert!(should_retry_windows_busy_install_target(
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            &["plain", first_retry, second_retry],
            4
        ));
        assert!(!should_retry_windows_busy_install_target(
            Some(-4082),
            DETAIL,
            Some(PREFIX),
            &["plain", first_retry, second_retry, third_retry],
            4
        ));
    }
}

#[cfg(test)]
mod deferred_user_cli_report_tests {
    use super::*;

    #[test]
    fn deferred_user_cli_outcome_does_not_create_an_error_event() {
        const PREFIX: &str = r"C:\Users\me\AppData\Roaming\npm";
        let detail = "npm error code EBUSY\nnpm error errno -4082\nnpm error syscall rename\nnpm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli";
        let env = InstallEnvironment {
            windows_busy_retry_attempts: Some(0),
            windows_busy_retry_outcome: WindowsBusyRetryOutcome::DeferredUserCli,
            lock_holder_diagnostic: Some(NpmLockHolderDiagnostic {
                class: NpmLockHolderClass::UserTerminalHqCli,
                count: 1,
                query_outcome: NpmLockHolderQueryOutcome::Complete,
                image_basename: Some("node.exe".into()),
            }),
            ..InstallEnvironment::default()
        };
        assert!(install_failure_report_with_environment(
            Some(-4082),
            detail,
            Some(PREFIX),
            false,
            &env
        )
        .is_none());
        assert_eq!(
            report_install_failure_episode_at(
                Some(-4082),
                detail,
                Some(PREFIX),
                false,
                &env,
                "5.174.0",
                &[],
                0
            ),
            InstallFailureEpisode::NotReportable
        );
    }
}

/// Which ancestor of the derived `@indigoai-us` install scope the mkdir remedy
/// (HQ-DESKTOP-5K) found missing, and how its creation went — the evidence that
/// makes a non-converging occurrence self-diagnosing without the unreachable local
/// `hq-sync.log`. A CLOSED enumeration carried on [`InstallEnvironment`] and, like
/// [`ManagedRetryOutcome`], emitted ONLY as a tag and an `npm_diagnostics` key —
/// never a fingerprint, signature, or repeat-guard component — so grouping is
/// untouched. Every value maps to a fixed `&'static str`; no filesystem path ever
/// reaches Sentry through it. The default [`Self::Unknown`] means the remedy did not
/// run (the failure was not this shape, or no scope resolved), so an
/// `InstallEnvironment` that never considered the remedy tags itself honestly and is
/// emitted as no extra tag at all (see `report_install_failure_with_environment`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MissingTargetState {
    /// The remedy did not run: the failure was not the missing-target shape, or no
    /// install scope could be resolved to create. The default.
    #[default]
    Unknown,
    /// The resolved install prefix root itself did not exist.
    PrefixRootMissing,
    /// The prefix existed but its `[lib/]node_modules` directory did not.
    NodeModulesMissing,
    /// `node_modules` existed but the `@indigoai-us` scope directory did not.
    ScopeMissing,
    /// The scope (and every absent ancestor) was created successfully and the plain
    /// install was retried. Reported when nothing in the probed ancestor chain was
    /// actually missing — npm's failing `mkdir` targeted some deeper path — so the
    /// creation was a no-op and the retry still ran.
    CreatedAndRetried,
    /// `create_dir_all` of the scope itself failed (an unreachable or permission-
    /// denied parent — a dead mapped drive, an offline redirected UNC path); nothing
    /// was changed and the failure fell through to reporting.
    CreateFailed,
}

impl MissingTargetState {
    pub fn tag_value(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::PrefixRootMissing => "prefix-root-missing",
            Self::NodeModulesMissing => "node-modules-missing",
            Self::ScopeMissing => "scope-missing",
            Self::CreatedAndRetried => "created-and-retried",
            Self::CreateFailed => "create-failed",
        }
    }
}

/// The disposition of the shared managed-Node repair, reduced to the three cases
/// the retry START decision turns on. The app crate maps its `ToolchainRepair`
/// onto this (dropping the failure-reason string it only logs), so the decision
/// stays pure and platform-independent — testable on every target, including the
/// Linux CI job and off-device, not only the macOS app-crate runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedRepairDisposition {
    /// A fresh managed-Node provision just completed.
    Repaired,
    /// The shared repair slot was claimed too recently; provisioning was deferred.
    Deferred,
    /// A fresh managed-Node provision was attempted and failed.
    Failed,
}

/// The START decision for the one-shot managed-toolchain retry: either run it with
/// a resolved managed `(npm, PATH, prefix)` triple, or decline with a closed reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedRetryStart {
    /// Run the one-shot retry under this managed toolchain.
    Proceed {
        npm: String,
        path: String,
        prefix: String,
    },
    /// Do not run the retry; the caller reports the user-path failure tagging this
    /// outcome.
    Decline(ManagedRetryOutcome),
}

/// Pure START decision for the one-shot managed-toolchain retry, given the shared
/// Node repair's disposition and the already-resolved managed toolchain triple.
///
/// This is the seam the HQ-DESKTOP-5E fix turns on. `ToolchainRepair` reports
/// whether a FRESH provision happened, NOT whether a managed toolchain EXISTS:
/// `repair_managed_node`'s slot is a process-global single-flight shared with the
/// sync/daemon/Connect lanes, so a `Deferred` (cooldown) or `Failed` disposition
/// can occur on a machine that already has HQ's managed Node installed and usable.
/// The old code returned "no retry" on `Deferred`/`Failed` before ever consulting
/// the managed npm, abandoning the one-shot retry — and then blaming the user's
/// toolchain in the UI for a repair it never attempted.
///
/// So: whenever a managed npm resolves, PROCEED regardless of the repair
/// disposition (it is idempotent — an already-present managed Node needs no fresh
/// provision). Decline only when no managed npm is resolvable at all, naming which
/// disposition left it absent so the next occurrence is self-diagnosing. Free of
/// `AppHandle`, IO and the app-crate `ToolchainRepair` type, so it compiles and
/// tests on every platform.
pub fn managed_retry_start_decision(
    disposition: ManagedRepairDisposition,
    resolved_managed: Option<(String, String, String)>,
) -> ManagedRetryStart {
    match resolved_managed {
        Some((npm, path, prefix)) => ManagedRetryStart::Proceed { npm, path, prefix },
        None => ManagedRetryStart::Decline(match disposition {
            ManagedRepairDisposition::Repaired => ManagedRetryOutcome::NoManagedNpm,
            ManagedRepairDisposition::Deferred => ManagedRetryOutcome::ProvisionDeferred,
            ManagedRepairDisposition::Failed => ManagedRetryOutcome::ProvisionFailed,
        }),
    }
}

/// START decision for repairing a managed toolchain that just suffered a known
/// native crash. Unlike a retry from the user's PATH, a deferred or failed repair
/// must not fall back to the same managed runtime that crashed.
pub fn managed_crash_retry_start_decision(
    disposition: ManagedRepairDisposition,
    resolved_managed: Option<(String, String, String)>,
) -> ManagedRetryStart {
    match disposition {
        ManagedRepairDisposition::Repaired => {
            managed_retry_start_decision(disposition, resolved_managed)
        }
        ManagedRepairDisposition::Deferred => {
            ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionDeferred)
        }
        ManagedRepairDisposition::Failed => {
            ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionFailed)
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
    /// Why HQ's one-shot managed-toolchain retry did or did not run for this
    /// failure. A pure tag/diagnostic addition (never a fingerprint or signature
    /// component), defaulting to [`ManagedRetryOutcome::NotArmed`] so every existing
    /// caller reproduces today's grouping and only gains the new descriptive tag.
    pub managed_retry_outcome: ManagedRetryOutcome,
    /// Number of Windows EBUSY package-target retries the install actually
    /// started. Present only for the selected-prefix EBUSY/rename failure.
    pub windows_busy_retry_attempts: Option<u8>,
    /// Whether the bounded Windows EBUSY retry was not applicable, unarmed,
    /// successful, or still failing. Tag/diagnostic only; never a grouping key.
    pub windows_busy_retry_outcome: WindowsBusyRetryOutcome,
    /// Consecutive same-target no-holder deferrals carried to the terminal
    /// report. Bounded by `WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS`.
    pub windows_busy_deferral_attempts: Option<u8>,
    /// Closed outcome for the no-holder deferral path. Omitted from telemetry
    /// for callers that did not enter that path.
    pub windows_busy_deferral_outcome: WindowsBusyDeferralOutcome,
    /// Closed, path-free Restart Manager result attached only to a final EBUSY
    /// failure. Process names, paths, usernames, and PIDs stay in memory.
    pub lock_holder_diagnostic: Option<NpmLockHolderDiagnostic>,
    /// For a missing-global-install-target failure (HQ-DESKTOP-5K), which ancestor
    /// of the install scope the mkdir remedy found missing and how its creation
    /// went. A pure tag/diagnostic addition (never a fingerprint, signature, or
    /// repeat-guard component), defaulting to [`MissingTargetState::Unknown`] — which
    /// is emitted as NO tag at all — so every existing caller reproduces today's
    /// grouping AND today's exact tag set and `npm_diagnostics` string.
    pub missing_target_state: MissingTargetState,
    /// The exact CLI version the failing `npm install` targeted (the `@<version>`
    /// [`install_argv`] pinned), so an operator can see WHICH version npm was asked
    /// for (HQ-DESKTOP-5Q). Reduced to a bounded token by [`sanitized_version_token`]
    /// before it is tagged as `hq_cli_target_version`. TAG/EXTRA ONLY — never a
    /// fingerprint, signature, or episode-key component, because a new CLI version
    /// publishes most days and would make grouping unbounded. Defaults to `None`,
    /// emitted as NO tag, so every existing caller reproduces today's exact tag set.
    pub target_version: Option<String>,
    /// The CLI version resolved when the updater observed failure. Tag-only,
    /// never a grouping component. Opt-in callers with no readable version emit
    /// `unknown`.
    pub running_cli_version: Option<String>,
    /// Whether the failing install pinned an exact version or asked for the `latest`
    /// dist-tag. TAG ONLY, defaulting to [`RequestedSpecKind::Unknown`] (emitted as
    /// NO tag), so every existing caller's tag set is unchanged until it opts in.
    pub requested_spec_kind: RequestedSpecKind,
    /// True only after a pinned npmjs tarball 404 has recurred at least thirty
    /// minutes after its first persisted observation. This lifts the temporary
    /// serving-lag classification so a persistent missing object remains visible.
    pub registry_serving_lag_recurred: bool,
}

impl InstallEnvironment {
    /// Attach bounded no-holder deferral telemetry to the terminal failure.
    pub fn with_windows_busy_deferral(
        mut self,
        attempts: u8,
        outcome: WindowsBusyDeferralOutcome,
    ) -> Self {
        self.windows_busy_deferral_attempts =
            Some(attempts.min(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS));
        self.windows_busy_deferral_outcome = outcome;
        self
    }

    /// Record that the failing `npm install` pinned this EXACT resolved CLI version
    /// (HQ-DESKTOP-5Q). The updater resolves `latest` from the registry's `/latest`
    /// endpoint and pins that string into `install_argv`, so a reported failure —
    /// an E404 in particular — should name the exact version npm was asked for, not
    /// the mutable `@latest` tag. Sets [`RequestedSpecKind::PinnedVersion`]; the
    /// version is a pure tag (reduced by [`sanitized_version_token`] at report
    /// time), never a fingerprint, signature, or episode-key component. Shared by
    /// the two apps/sync report sites so their attribution can never drift.
    pub fn with_pinned_target_version(mut self, version: &str) -> Self {
        self.target_version = Some(version.to_string());
        self.requested_spec_kind = RequestedSpecKind::PinnedVersion;
        self
    }

    /// Attach the CLI version that was running when the updater observed failure.
    /// The report boundary reduces it to a bounded SemVer token or `unknown`.
    pub fn with_running_cli_version(mut self, version: Option<&str>) -> Self {
        self.running_cli_version = Some(version.unwrap_or("unknown").to_string());
        self
    }
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

/// Reduce the requested CLI target version to a bounded token that PRESERVES a
/// valid SemVer prerelease/build identifier (for example `6.0.0-beta.1`), unlike
/// [`sanitized_version_token`] — which accepts only digits and dots and is the
/// scrub boundary for the PROBED node/npm versions and must stay unchanged. The
/// target version is a published npm version string the updater resolved from the
/// registry's dist-tag, so it can legitimately carry `-`, `+`, and alphanumeric
/// prerelease identifiers; bound it to the SemVer character set (`[0-9A-Za-z.+-]`)
/// and a safe length, requiring at least one digit, so no free text, path, or
/// space can reach Sentry. Anything else collapses to `unknown`.
fn sanitized_target_version_token(raw: Option<&str>) -> String {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return "unknown".to_string();
    };
    let value = raw.strip_prefix('v').unwrap_or(raw);
    if (1..=48).contains(&value.len()) && semver::Version::parse(value).is_ok() {
        value.to_string()
    } else {
        "unknown".to_string()
    }
}

/// The provenance segment appended to `npm_diagnostics`. Its shape is constant
/// (always these six keys) so the extra stays trivially assertable; each value
/// is already a closed enumeration or a `sanitized_version_token` output.
fn install_environment_diagnostics_suffix(
    lifecycle_cause: Option<&str>,
    node_version: &str,
    node_abi: &str,
    npm_version: &str,
    toolchain_source: &str,
    managed_retry_outcome: &str,
) -> String {
    format!(
        "lifecycle_cause={} node_version={} node_abi={} npm_version={} toolchain_source={} managed_retry_outcome={}",
        lifecycle_cause.unwrap_or("none"),
        node_version,
        node_abi,
        npm_version,
        toolchain_source,
        managed_retry_outcome,
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
    let signature =
        install_failure_signature_with_exit_code(exit_code, kind, detail, prefix, env);
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
    let lifecycle_postinstall_stage = npm_lifecycle_postinstall_stage(detail);
    let node_version = sanitized_version_token(env.node_version.as_deref());
    let node_abi = sanitized_version_token(env.node_abi.as_deref());
    let npm_version = sanitized_version_token(env.npm_version.as_deref());
    let toolchain_source = env.toolchain_source.tag_value();
    // E404 registry attribution (HQ-DESKTOP-5Q). Derive the closed enums ONLY when
    // npm reported an E404, from the SAME shared discriminator the signature and
    // episode key use, so the tags, the Sentry group, and the repeat-guard key can
    // never disagree. A non-E404 event is untouched.
    let npm_error_is_e404 = npm_error_code == "E404";
    let (e404_origin_tag, e404_resource_tag) = if npm_error_is_e404 {
        let (origin, resource) = e404_discriminator(detail);
        (Some(origin.tag_value()), Some(resource.tag_value()))
    } else {
        (None, None)
    };
    let npm_404_package_tag = npm_error_is_e404
        .then(|| npm_404_tarball_package(detail))
        .flatten();
    // The exact version npm was asked to install, and whether it was pinned or the
    // `latest` tag. Tag-only (never a grouping component) and emitted ONLY when the
    // caller opted in (a non-default value), so a default InstallEnvironment keeps
    // today's exact tag set.
    let hq_cli_target_version: Option<String> = env
        .target_version
        .as_deref()
        .map(|version| sanitized_target_version_token(Some(version)));
    let hq_cli_running_version: Option<String> = env
        .running_cli_version
        .as_deref()
        .map(|version| sanitized_target_version_token(Some(version)));
    let requested_spec_kind_tag = if env.requested_spec_kind != RequestedSpecKind::Unknown {
        Some(env.requested_spec_kind.tag_value())
    } else {
        None
    };
    // Structural attribution for a NON-EMPTY markerless failure (HQ-DESKTOP-56):
    // `Some` only for the attributed subclass, so every other event's tags and the
    // diagnostics extra stay byte-identical to today.
    let unattributed_profile = install_failure_unattributed_profile(kind, detail, prefix);
    let crash_kind = if matches!(
        kind,
        InstallFailureKind::Unexpected | InstallFailureKind::NativeCrash
    ) {
        node_crash_kind(exit_code, detail)
    } else {
        NodeCrashClassification::NONE
    };
    let crash_diag_suffix = if crash_kind.kind == NodeCrashKind::None {
        String::new()
    } else {
        format!(
            " node_crash_kind={} node_crash_evidence={}",
            crash_kind.kind.tag_value(),
            crash_kind.evidence
        )
    };
    // Append the origin + shape render to the diagnostics extra ONLY for the
    // attributed subclass, so the extra stays a fixed-shape string within each class
    // (the six-key provenance suffix is unchanged for every other event).
    let unattributed_diag_suffix = match &unattributed_profile {
        Some(profile) => {
            format!(
                " stderr_origin={} stderr_shapes={}",
                profile.origin, profile.shapes_tag
            )
        }
        None => String::new(),
    };
    let mut npm_diagnostics = format!(
        "{} {}{}{}",
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
            env.managed_retry_outcome.tag_value(),
        ),
        unattributed_diag_suffix,
        crash_diag_suffix,
    );
    // Append the missing-target diagnostic ONLY when the mkdir remedy actually ran
    // (state != Unknown). The default keeps every existing event's `npm_diagnostics`
    // string byte-identical, so no pre-existing exact-string assertion changes.
    if env.missing_target_state != MissingTargetState::Unknown {
        npm_diagnostics.push_str(&format!(
            " missing_target_state={}",
            env.missing_target_state.tag_value()
        ));
    }
    if let Some(stage) = lifecycle_postinstall_stage {
        npm_diagnostics.push_str(&format!(" postinstall_stage={stage}"));
    }
    // Attribute the E404 in the diagnostic extra too (closed enums only, never the
    // host or URL). Appended ONLY for an E404, so every non-E404 event's
    // `npm_diagnostics` string stays byte-identical.
    if let (Some(origin), Some(resource)) = (e404_origin_tag, e404_resource_tag) {
        npm_diagnostics.push_str(&format!(
            " registry_origin={origin} npm_404_resource={resource}"
        ));
    }
    if let Some(package) = npm_404_package_tag.as_deref() {
        npm_diagnostics.push_str(&format!(" npm_404_package={package}"));
    }
    if env.registry_serving_lag_recurred {
        npm_diagnostics.push_str(" registry_serving_lag=escalated");
    }
    if let Some(attempts) = env.windows_busy_retry_attempts {
        if matches!(
            env.windows_busy_retry_outcome,
            WindowsBusyRetryOutcome::NotArmed | WindowsBusyRetryOutcome::Failed
        ) {
            let diagnostic = env.lock_holder_diagnostic.clone().unwrap_or_default();
            npm_diagnostics.push_str(&format!(
                " lock_holder_class={} lock_holder_count={} lock_holder_query_outcome={}",
                diagnostic.class.tag_value(),
                diagnostic.count,
                diagnostic.query_outcome.tag_value(),
            ));
        }
        npm_diagnostics.push_str(&format!(
            " windows_busy_retry_attempts={attempts} windows_busy_retry_outcome={}",
            env.windows_busy_retry_outcome.tag_value(),
        ));
    }
    if let Some(attempts) = env.windows_busy_deferral_attempts {
        npm_diagnostics.push_str(&format!(
            " windows_busy_deferral_attempts={} windows_busy_deferral_outcome={}",
            attempts.min(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS),
            env.windows_busy_deferral_outcome.tag_value(),
        ));
    }
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("install_failure_kind", kind.fingerprint_component());
            scope.set_tag("node_crash_kind", crash_kind.kind.tag_value());
            scope.set_tag("node_crash_evidence", crash_kind.evidence);
            scope.set_tag("exit_code", exit_str.as_str());
            scope.set_tag("eacces", if eacces { "true" } else { "false" });
            scope.set_tag("npm_failure_site", npm_failure_site(detail, prefix));
            scope.set_tag("npm_error_code", npm_error_code.as_str());
            scope.set_tag("npm_syscall", npm_syscall(detail));
            scope.set_tag("npm_path_shape", npm_path_shape.tag_value());
            // E404 registry attribution (HQ-DESKTOP-5Q): which registry origin npm's
            // own 404 line named and which resource it was fetching. Closed enums
            // only — never the host or URL. Present ONLY for an E404, so a non-E404
            // event's tag set is unchanged.
            if let Some(origin) = e404_origin_tag {
                scope.set_tag("npm_registry_origin", origin);
            }
            if let Some(resource) = e404_resource_tag {
                scope.set_tag("npm_404_resource", resource);
            }
            if let Some(package) = npm_404_package_tag.as_deref() {
                scope.set_tag("npm_404_package", package);
            }
            if env.registry_serving_lag_recurred {
                scope.set_tag("npm_registry_serving_lag", "escalated");
            }
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
            if let Some(stage) = lifecycle_postinstall_stage {
                scope.set_tag("npm_lifecycle_postinstall_stage", stage);
            }
            // Toolchain provenance — the fields the reported 4R/4S events lacked,
            // which make the next occurrence self-diagnosing. Each is a closed
            // enumeration or a validated numeric token.
            scope.set_tag("node_version", node_version.as_str());
            scope.set_tag("node_abi", node_abi.as_str());
            scope.set_tag("npm_version", npm_version.as_str());
            scope.set_tag("npm_toolchain_source", toolchain_source);
            // The exact version npm was asked for, and whether it was pinned or the
            // `latest` tag (HQ-DESKTOP-5Q). Tag-only, never a grouping component;
            // present only when the caller opted in, so a default InstallEnvironment
            // keeps today's exact tag set.
            if let Some(target_version) = hq_cli_target_version.as_deref() {
                scope.set_tag("hq_cli_target_version", target_version);
            }
            if let Some(running_version) = hq_cli_running_version.as_deref() {
                scope.set_tag("hq_cli_running_version", running_version);
            }
            if let Some(spec_kind) = requested_spec_kind_tag {
                scope.set_tag("npm_requested_spec_kind", spec_kind);
            }
            scope.set_tag(
                "npm_managed_toolchain_retry",
                if env.managed_toolchain_retry {
                    "true"
                } else {
                    "false"
                },
            );
            // Why HQ's one-shot managed-toolchain retry did or did not run — the
            // evidence HQ-DESKTOP-5E lacked. A tag and diagnostics key only; never a
            // fingerprint or signature component, so the group is unchanged.
            scope.set_tag(
                "npm_managed_retry_outcome",
                env.managed_retry_outcome.tag_value(),
            );
            if let Some(attempts) = env.windows_busy_retry_attempts {
                if matches!(
                    env.windows_busy_retry_outcome,
                    WindowsBusyRetryOutcome::NotArmed | WindowsBusyRetryOutcome::Failed
                ) {
                    let diagnostic = env.lock_holder_diagnostic.clone().unwrap_or_default();
                    scope.set_tag("npm_lock_holder_class", diagnostic.class.tag_value());
                    scope.set_tag("npm_lock_holder_count", diagnostic.count.to_string());
                    scope.set_tag(
                        "npm_lock_holder_query_outcome",
                        diagnostic.query_outcome.tag_value(),
                    );
                    if let Some(image_basename) = diagnostic.image_basename.as_deref() {
                        scope.set_tag("npm_lock_holder_image_basename", image_basename);
                    }
                }
                scope.set_tag("npm_windows_busy_retry_attempts", attempts.to_string());
                scope.set_tag(
                    "npm_windows_busy_retry_outcome",
                    env.windows_busy_retry_outcome.tag_value(),
                );
            }
            if let Some(attempts) = env.windows_busy_deferral_attempts {
                scope.set_tag(
                    "npm_windows_busy_deferral_attempts",
                    attempts
                        .min(WINDOWS_BUSY_INSTALL_TARGET_MAX_DEFERRALS)
                        .to_string(),
                );
                scope.set_tag(
                    "npm_windows_busy_deferral_outcome",
                    env.windows_busy_deferral_outcome.tag_value(),
                );
            }
            // Which ancestor of the install scope was missing and how the mkdir
            // remedy went (HQ-DESKTOP-5K). Like `npm_managed_retry_outcome`, a tag
            // and `npm_diagnostics` key only — never a fingerprint, signature, or
            // repeat-guard component. Emitted ONLY when the remedy ran, so an event
            // that never considered it keeps its exact existing tag set.
            if env.missing_target_state != MissingTargetState::Unknown {
                scope.set_tag(
                    "npm_missing_target_state",
                    env.missing_target_state.tag_value(),
                );
            }
            scope.set_tag(
                "npm_prefix_known",
                if npm_prefix_known { "true" } else { "false" },
            );
            scope.set_tag("npm_stderr_len", npm_stderr_len.as_str());
            scope.set_tag("npm_errno", npm_errno);
            // Structural attribution for a NON-EMPTY markerless failure
            // (HQ-DESKTOP-56): the stderr origin (closed 3-value enum) and a bounded
            // `shape:count` render of its unmatched-shape mix. Present ONLY for the
            // attributed subclass. These fields never enter the fingerprint: generic
            // markerless events group on `unattributed:<origin>:<dominant shape>`,
            // while recognized Node crashes use their closed `node-crash:<kind>` key.
            if let Some(profile) = &unattributed_profile {
                scope.set_tag("npm_stderr_origin", profile.origin);
                scope.set_tag("npm_stderr_shapes", profile.shapes_tag.as_str());
                let failure_stage = match profile.origin {
                    STDERR_ORIGIN_NON_NPM => "before-npm-logger",
                    STDERR_ORIGIN_NPM_LOGGER => "npm-logger-output",
                    _ => "unknown",
                };
                scope.set_tag("npm_failure_stage", failure_stage);
            }
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
            // A local-machine condition, not an updater defect: an unsupported
            // Node, a missing npm global install target, and a foreign-registry E404
            // are downgraded alongside the post-force bin collision, so they stay
            // observable without paging at Error. The missing-target shape is only
            // ever reported AFTER HQ's own mkdir + managed-toolchain repair has been
            // attempted and declined, so at report time it genuinely describes a
            // broken local npm prefix; the foreign-registry downgrade fires ONLY when
            // npm's own 404 line names a non-npmjs host, so a npmjs- or unknown-origin
            // E404 stays at Error (see report_install_failure_with_environment's E404
            // arm and install_failure_signature) — EXCEPT the pinned npmjs tarball
            // serving lag (HQ-DESKTOP-6D), which classify_install_failure_with_environment
            // reclassifies to ExpectedTransientRegistry upstream, so it returns None
            // from the report and never reaches this level decision at all.
            let level = if matches!(
                kind,
                InstallFailureKind::ExpectedBinCollision
                    | InstallFailureKind::UnsupportedNode
                    | InstallFailureKind::MissingGlobalInstallTarget
                    | InstallFailureKind::ForeignRegistryPackageMissing
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
    if matches!(
        kind,
        InstallFailureKind::Unexpected | InstallFailureKind::NativeCrash
    ) {
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
        //
        // An E404 that stayed `Unexpected` (npmjs- or unknown-origin) keys on the
        // SAME attributed signature its Sentry group now uses, derived from the
        // shared `e404_discriminator`, so the group and this key can never disagree.
        // This preserves today's once-per-published-version cadence for E404 (the
        // reported HQ-DESKTOP-5Q count was bounded that way) while carrying the new
        // origin/resource attribution. E404 is never the shapeless `none` shape, so
        // the carve-out below cannot swallow it. (The pinned npmjs tarball serving
        // lag, HQ-DESKTOP-6D, is ExpectedTransientRegistry rather than Unexpected, so
        // it is NotReportable and never mints a key here.)
        if npm_error_code(detail) == "E404" {
            let key = format!("{latest}|unexpected|{}", unexpected_e404_signature(detail));
            return Some(if env.managed_toolchain_retry {
                format!("{key}|managed")
            } else {
                key
            });
        }
        // A NON-EMPTY markerless failure (HQ-DESKTOP-56) now carries a bounded
        // structural signature, so it CAN be episode-bounded: page once per published
        // CLI version per distinct `(origin, dominant shape)` instead of on every
        // ~6-hourly check. Recognized Node crashes use `(node-crash, kind)` for both
        // the key and Sentry signature; other profiles keep `(origin, dominant shape)`.
        // `|managed` matches the other shapes so a managed-retry event never collides
        // with its user-path predecessor.
        let crash = node_crash_kind(exit_code, detail);
        if crash.kind != NodeCrashKind::None {
            let key = format!("{latest}|node-crash|{}", crash.kind.tag_value());
            return Some(if env.managed_toolchain_retry {
                format!("{key}|managed")
            } else {
                key
            });
        }
        if let Some(profile) = install_failure_unattributed_profile(kind, detail, prefix) {
            let key = format!(
                "{latest}|unattributed|{}|{}",
                profile.origin, profile.dominant_shape
            );
            return Some(if env.managed_toolchain_retry {
                format!("{key}|managed")
            } else {
                key
            });
        }
        let code = symbolic_npm_error_code(detail);
        let syscall = npm_syscall(detail);
        let path_shape = npm_path_shape(detail, prefix).tag_value();
        if code == "none" && syscall == "unknown" && path_shape == "none" {
            // A GENUINELY shapeless failure the profile did NOT attribute — an empty
            // stderr, or a lifecycle failure whose numeric build-script status
            // collapsed to the empty signature — must NOT be repeat-suppressed (commit
            // e24e7a45): its signature carries no discriminator, so bounding it would
            // hide a newly introduced failure behind an unrelated earlier one until the
            // next CLI publish. It keeps paging every check, exactly as today.
            return None;
        }
        let key = format!("{latest}|unexpected|{code}|{syscall}|{path_shape}");
        return Some(if env.managed_toolchain_retry {
            format!("{key}|managed")
        } else {
            key
        });
    }
    if kind == InstallFailureKind::MissingGlobalInstallTarget {
        // A broken/absent local npm prefix recurs identically on every 6-hourly
        // check once HQ's own mkdir + managed-toolchain repair has declined, so page
        // it ONCE per published CLI version rather than forever — the same treatment
        // as the `Unexpected` and `UnsupportedNode` shapes. Key on the SAME closed
        // path shape the group already uses (`code`/`syscall` are definitionally
        // `ENOENT`/`mkdir` for this kind, so they add nothing); the predicate makes a
        // fully shapeless `none` impossible, so — unlike the `Unexpected` branch — no
        // shapeless-carve-out is needed. The `|managed` discriminator matches the
        // other shapes so a managed-retry event never collides with its user-path
        // predecessor.
        let path_shape = npm_path_shape(detail, prefix).tag_value();
        let key = format!("{latest}|missing-global-install-target|{path_shape}");
        return Some(if env.managed_toolchain_retry {
            format!("{key}|managed")
        } else {
            key
        });
    }
    if kind == InstallFailureKind::ForeignRegistryPackageMissing {
        // A permanent local registry misconfiguration recurs identically on every
        // scheduled check, so page it ONCE per published CLI version — the same
        // treatment as the `Unexpected`, `UnsupportedNode`, and
        // `MissingGlobalInstallTarget` shapes. Key on the SAME closed 404-resource
        // discriminator the group uses (origin is definitionally `Foreign` for this
        // kind), derived from the shared `e404_discriminator` so the Sentry group and
        // this key can never disagree. Without this arm the kind would fall through to
        // `install_failure_episode_key_with_provenance`, return `None` for a
        // non-lifecycle failure, and re-page on every ~6-hourly check.
        let key = format!(
            "{latest}|foreign-registry-404|{}",
            e404_discriminator(detail).1.tag_value()
        );
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
    /// A pinned npmjs tarball 404 is deferred until its first observation has
    /// aged past the serving-lag window. The first observation carries marker
    /// keys for the caller to persist; repeats before the deadline do not rewrite
    /// the original timestamp.
    DeferredTransient { persist_keys: Option<Vec<String>> },
}

/// How long a pinned npmjs tarball 404 may remain deferred before the next
/// observation is classified and reported as an unexpected install failure.
pub const REGISTRY_SERVING_LAG_RECURRENCE_GAP_MINUTES: u64 = 30;

fn unix_minutes_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 60)
        .unwrap_or_default()
}

fn registry_serving_lag_first_seen(
    reported_keys: &[String],
    latest: &str,
    package: &str,
) -> Option<u64> {
    let prefix = format!("{latest}|registry-serving-lag|{package}|");
    reported_keys
        .iter()
        .filter_map(|key| key.strip_prefix(&prefix)?.parse::<u64>().ok())
        .min()
}

/// Whether the same pinned npmjs tarball failure has a persisted first-seen
/// marker older than the bounded serving-lag window. This is a pure seam so the
/// first/deferred/escalated boundaries can be tested with synthetic time.
pub fn registry_serving_lag_recurred_for_detail(
    reported_keys: &[String],
    latest: &str,
    detail: &str,
    now_minutes: u64,
) -> bool {
    if !is_npmjs_pinned_tarball_not_yet_served(
        detail,
        &InstallEnvironment {
            target_version: Some(latest.to_string()),
            requested_spec_kind: RequestedSpecKind::PinnedVersion,
            ..InstallEnvironment::default()
        },
    ) {
        return false;
    }
    let Some(package) = npm_404_tarball_package(detail) else {
        return false;
    };
    registry_serving_lag_first_seen(reported_keys, latest, &package).is_some_and(|first_seen| {
        now_minutes >= first_seen
            && now_minutes - first_seen >= REGISTRY_SERVING_LAG_RECURRENCE_GAP_MINUTES
    })
}

fn registry_serving_lag_marker_record(
    reported_keys: &[String],
    latest: &str,
    package: &str,
    now_minutes: u64,
) -> Vec<String> {
    if registry_serving_lag_first_seen(reported_keys, latest, package).is_some() {
        return reported_keys.to_vec();
    }
    let key = format!("{latest}|registry-serving-lag|{package}|{now_minutes}");
    install_failure_episode_record(reported_keys, &key, latest)
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
    report_install_failure_episode_at(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
        latest,
        reported_keys,
        unix_minutes_now(),
    )
}

/// Deterministic form of [`report_install_failure_episode`] for boundary tests.
/// The first pinned npmjs tarball observation is persisted locally and deferred;
/// once the same package/version recurs after the gap, it follows the normal
/// visible install-failure reporting path with an escalation tag.
pub fn report_install_failure_episode_at(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
    env: &InstallEnvironment,
    latest: &str,
    reported_keys: &[String],
    now_minutes: u64,
) -> InstallFailureEpisode {
    if !env.registry_serving_lag_recurred && is_npmjs_pinned_tarball_not_yet_served(detail, env) {
        let Some(package) = npm_404_tarball_package(detail) else {
            return report_install_failure_episode_inner(
                exit_code,
                detail,
                prefix,
                final_attempt_forced,
                env,
                latest,
                reported_keys,
            );
        };
        let first_seen = registry_serving_lag_first_seen(reported_keys, latest, &package);
        let has_recurred =
            registry_serving_lag_recurred_for_detail(reported_keys, latest, detail, now_minutes);
        if !has_recurred {
            let persist_keys = first_seen.is_none().then(|| {
                registry_serving_lag_marker_record(reported_keys, latest, &package, now_minutes)
            });
            return InstallFailureEpisode::DeferredTransient { persist_keys };
        }
        let mut escalated_env = env.clone();
        escalated_env.registry_serving_lag_recurred = true;
        return report_install_failure_episode_inner(
            exit_code,
            detail,
            prefix,
            final_attempt_forced,
            &escalated_env,
            latest,
            reported_keys,
        );
    }
    report_install_failure_episode_inner(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
        env,
        latest,
        reported_keys,
    )
}

fn report_install_failure_episode_inner(
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

/// Why an automatic HQ CLI update attempt failed, for retry scheduling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoUpdateFailureKind {
    PackageUseLeaseTimeout,
    Other,
}

/// A package-use lease timeout earns up to three retries ten minutes apart;
/// every other failure waits for the regular check.
pub fn auto_update_retry_delay(
    failure: AutoUpdateFailureKind,
    retries_scheduled: u8,
) -> Option<Duration> {
    (failure == AutoUpdateFailureKind::PackageUseLeaseTimeout && retries_scheduled < 3)
        .then_some(Duration::from_secs(10 * 60))
}

pub fn package_use_lease_retry_attempt_tag(attempt: u8) -> &'static str {
    match attempt {
        0 => "0",
        1 => "1",
        2 => "2",
        _ => "3",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderRootRelation {
    Same,
    Older,
    Legacy,
    Unknown,
}

impl HolderRootRelation {
    pub const fn as_tag(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::Older => "older",
            Self::Legacy => "legacy",
            Self::Unknown => "unknown",
        }
    }
}

/// Report a bounded timeout while waiting for active HQ CLI processes to
/// release the package-use lease. The fixed message, tag, and fingerprint
/// intentionally exclude local paths and process details.
pub fn report_package_use_lease_timeout(
    summary: &crate::package_use_lease::PackageUseLeaseTimeoutSummary,
    retry_attempt: u8,
) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("install_failure_kind", "package_use_lease_timeout");
            scope.set_tag("hq_cli_update_stage", "package_use_lease_timeout");
            scope.set_tag(
                "lease_retry_attempt",
                package_use_lease_retry_attempt_tag(retry_attempt),
            );
            scope.set_tag(
                "holder_live_count_bucket",
                summary.live_holder_count.as_tag(),
            );
            scope.set_tag(
                "holder_same_root_live_count_bucket",
                summary.same_root_live_holder_count.as_tag(),
            );
            scope.set_tag(
                "holder_other_root_live_count_bucket",
                summary.other_root_live_holder_count.as_tag(),
            );
            scope.set_tag("holder_version_bucket", summary.holder_version.as_tag());
            scope.set_tag(
                "oldest_holder_age_bucket",
                summary.oldest_holder_age.as_tag(),
            );
            scope.set_tag(
                "oldest_holder_purpose",
                summary.oldest_holder_purpose.as_tag(),
            );
            // This updater currently mutates only the legacy npm-installed root.
            scope.set_tag(
                "holder_root_relation",
                HolderRootRelation::Legacy.as_tag(),
            );
            scope.set_fingerprint(Some(&[
                "hq-cli-update",
                "install-failed",
                "package_use_lease_timeout",
            ]));
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] timed out waiting for active HQ CLI package use",
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
    let parent = hq_bin
        .parent()
        .filter(|path| !path.as_os_str().is_empty())?;
    if parent.file_name().and_then(|name| name.to_str()) != Some("bin") {
        return None;
    }
    let home = parent
        .parent()
        .filter(|path| !path.as_os_str().is_empty())?;
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
    name.strip_prefix('v')
        .unwrap_or(name)
        .parse::<u64>()
        .unwrap_or(0)
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
    let pkg = Path::new("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
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

/// Resolve package directories that can contain the installed `hq` binary.
///
/// Restart Manager needs files from the package directory, while the resolved
/// command may be an npm shim, a Bun shim, a pnpm shim, or a symlink into the
/// package itself. Keep the layout rules here beside version resolution so the
/// holder query can inspect the same owned package without guessing from a
/// package-manager default prefix.
pub fn hq_cli_package_directories_from_bin(hq_bin: &Path) -> Vec<std::path::PathBuf> {
    const PACKAGE_JSON_CANDIDATE_LIMIT: usize = 128;
    const PACKAGE_DIRECTORY_CANDIDATE_LIMIT: usize = 16;

    let mut package_json_candidates = Vec::new();
    if let Ok(real_bin) = hq_bin.canonicalize() {
        package_json_candidates.extend(
            real_bin
                .ancestors()
                .take(PACKAGE_JSON_CANDIDATE_LIMIT)
                .map(|ancestor| ancestor.join("package.json")),
        );
    }

    let hq_bin_string = hq_bin.to_string_lossy();
    if let Some(prefix) = npm_prefix_from_hq_bin(&hq_bin_string) {
        package_json_candidates.extend(hq_cli_package_json_candidates(Path::new(&prefix), hq_bin));
    }
    if is_pnpm_global_shim(&hq_bin_string) {
        if let Some(home) = pnpm_home_from_hq_bin(hq_bin) {
            package_json_candidates.extend(pnpm_store_package_json_candidates(&home));
        }
    }
    if let Some(home) = bun_home_from_hq_bin(hq_bin) {
        package_json_candidates.push(
            home.join("install")
                .join("global")
                .join("node_modules")
                .join("@indigoai-us")
                .join("hq-cli")
                .join("package.json"),
        );
    }

    let mut package_directories = Vec::new();
    for manifest in package_json_candidates
        .into_iter()
        .take(PACKAGE_JSON_CANDIDATE_LIMIT)
    {
        if version_if_hq_cli(&manifest).is_none() {
            continue;
        }
        let Some(package_directory) = manifest.parent() else {
            continue;
        };
        if !package_directories
            .iter()
            .any(|candidate| candidate == package_directory)
        {
            package_directories.push(package_directory.to_path_buf());
            if package_directories.len() == PACKAGE_DIRECTORY_CANDIDATE_LIMIT {
                break;
            }
        }
    }
    package_directories
}

#[cfg(test)]
mod hq_cli_package_directory_tests {
    use super::*;

    fn write_hq_cli_manifest(package_directory: &Path) {
        std::fs::create_dir_all(package_directory).unwrap();
        std::fs::write(
            package_directory.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli","version":"5.99.0"}"#,
        )
        .unwrap();
    }

    #[test]
    fn resolves_the_selected_windows_npm_package_root() {
        let temp = tempfile::tempdir().unwrap();
        let prefix = temp.path().join("npm-global");
        let package = prefix.join("node_modules/@indigoai-us/hq-cli");
        write_hq_cli_manifest(&package);
        let shim = prefix.join("hq.cmd");

        assert_eq!(hq_cli_package_directories_from_bin(&shim), vec![package]);
    }

    #[test]
    fn resolves_pnpm_v11_package_roots_from_the_global_store() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("pnpm");
        let package = home.join("global/v11/hash/node_modules/@indigoai-us/hq-cli");
        write_hq_cli_manifest(&package);
        let shim = home.join("bin/hq");

        assert_eq!(hq_cli_package_directories_from_bin(&shim), vec![package]);
    }

    #[test]
    fn resolves_bun_package_root_from_the_global_install_tree() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join(".bun");
        let package = home.join("install/global/node_modules/@indigoai-us/hq-cli");
        write_hq_cli_manifest(&package);
        let shim = home.join("bin/hq");

        assert_eq!(hq_cli_package_directories_from_bin(&shim), vec![package]);
    }
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
                    if shim_belongs_to_hq_cli(&path, shadow_prefix)
                        && !remove_file_if_present(&path)
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
    let out = match output_with_timeout(
        cmd.args(["root", "-g"]).env("PATH", path),
        VERSION_PROCESS_TIMEOUT,
    ) {
        Ok(Some(output)) => output,
        Ok(None) => return (None, VersionProbeOutcome::TimedOut),
        Err(error) => return (None, classify_probe_error(&error)),
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
#[path = "hq_cli_update_tests.rs"]
mod tests;
