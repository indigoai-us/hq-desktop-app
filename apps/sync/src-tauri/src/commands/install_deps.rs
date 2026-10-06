//! Dependency probe and install commands for the HQ installer.
//!
//! Each installer streams stdout lines to the frontend via `install:progress`
//! events and supports cancellation through a shared handle registry. Required
//! tools use a user-local HQ-managed toolchain when possible; Homebrew remains
//! an optional system package-manager provider.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
use std::mem::size_of;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(not(windows))]
use std::time::Instant;

use futures_util::future::join_all;
#[cfg(unix)]
use nix::sys::signal::{self, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ};
#[cfg(windows)]
use winreg::{RegKey, RegValue};

use crate::commands::install_stages::{
    clear_onboarding_failure_detail, record_onboarding_failure_detail,
    record_onboarding_failure_detail_with_kind, OnboardingErrorCategory, OnboardingFailureScope,
};
use crate::util::logfile::log;

tokio::task_local! {
    static ACTIVE_ONBOARDING_FAILURE_SCOPE: OnboardingFailureScope;
}

fn current_setup_run_id() -> Option<String> {
    ACTIVE_ONBOARDING_FAILURE_SCOPE
        .try_with(|scope| scope.setup_run_id.clone())
        .ok()
}

tokio::task_local! {
    static ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR: SetupDiagnosticCollector;
}

/// The dependency currently executing inside the setup orchestrator. Streaming
/// installers use this to report a cleanup failure immediately, rather than
/// waiting for a child process that may never exit after a failed signal.
tokio::task_local! {
    static ACTIVE_SETUP_DEPENDENCY: &'static str;
}

/// Retains the terminal process failure for one dependency. An installer can
/// retry internally; only a dependency that ultimately fails emits it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SetupCommandDiagnostic {
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    error: String,
}

#[derive(Clone)]
struct SetupDiagnosticCollector {
    command_failure: Arc<Mutex<Option<SetupCommandDiagnostic>>>,
}

/// Return the guard after a panic. Callers assign one value, update one map
/// entry, or clone. A diagnostic tail caught mid-append is still a string.
fn recover_lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SetupDiagnosticCollector {
    fn new() -> Self {
        Self { command_failure: Arc::new(Mutex::new(None)) }
    }

    fn record(&self, diagnostic: SetupCommandDiagnostic) {
        *recover_lock(&self.command_failure) = Some(diagnostic);
    }

    fn take(&self) -> Option<SetupCommandDiagnostic> {
        recover_lock(&self.command_failure).take()
    }

    fn current(&self) -> Option<SetupCommandDiagnostic> {
        recover_lock(&self.command_failure).clone()
    }

    fn clear(&self) {
        let _ = recover_lock(&self.command_failure).take();
    }
}

/// The two typed outcomes a user-initiated cancellation can have. Rendering the
/// user-facing error stays separate from this type so Sentry classification
/// cannot accidentally depend on an error-message substring.
#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallCancellation {
    UserCancelled,
    CleanupFailed(CancellationCleanupFailure),
}

impl InstallCancellation {
    fn user_message(&self) -> String {
        match self {
            Self::UserCancelled => "Cancelled by user".to_string(),
            Self::CleanupFailed(cleanup) => {
                format!("Cancelled by user; {}", cleanup.description())
            }
        }
    }
}

/// The cleanup operation that could not stop an installer. On Unix, the
/// process group gets a signal; Windows uses the Job Object termination API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancellationCleanupSignal {
    #[cfg(unix)]
    Sigterm,
    #[cfg(unix)]
    Sigkill,
    #[cfg(windows)]
    TerminateJobObject,
}

impl CancellationCleanupSignal {
    fn as_str(self) -> &'static str {
        match self {
            #[cfg(unix)]
            Self::Sigterm => "SIGTERM",
            #[cfg(unix)]
            Self::Sigkill => "SIGKILL",
            #[cfg(windows)]
            Self::TerminateJobObject => "TerminateJobObject",
        }
    }
}

/// OS-level failure that prevented cancellation cleanup. This retains the
/// structured error class separately from its UI rendering and never stores a
/// machine-specific process ID in a Sentry fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancellationCleanupErrorKind {
    #[cfg(unix)]
    Unix(nix::errno::Errno),
    #[cfg(windows)]
    Windows {
        kind: std::io::ErrorKind,
        raw_os_error: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CancellationCleanupFailure {
    signal: CancellationCleanupSignal,
    os_error_kind: CancellationCleanupErrorKind,
    description: String,
}

impl CancellationCleanupFailure {
    #[cfg(unix)]
    fn from_unix_signal(signal: Signal, error: nix::errno::Errno) -> Self {
        let signal = match signal {
            Signal::SIGTERM => CancellationCleanupSignal::Sigterm,
            Signal::SIGKILL => CancellationCleanupSignal::Sigkill,
            _ => unreachable!("install cancellation only sends SIGTERM or SIGKILL"),
        };
        Self {
            signal,
            os_error_kind: CancellationCleanupErrorKind::Unix(error),
            description: error.to_string(),
        }
    }

    #[cfg(windows)]
    fn from_windows_error(error: std::io::Error) -> Self {
        Self {
            signal: CancellationCleanupSignal::TerminateJobObject,
            os_error_kind: CancellationCleanupErrorKind::Windows {
                kind: error.kind(),
                raw_os_error: error.raw_os_error(),
            },
            description: error.to_string(),
        }
    }

    fn os_error_kind_token(&self) -> String {
        match self.os_error_kind {
            #[cfg(unix)]
            CancellationCleanupErrorKind::Unix(error) => format!("{error:?}"),
            #[cfg(windows)]
            CancellationCleanupErrorKind::Windows {
                kind: _,
                raw_os_error: Some(raw_os_error),
            } => format!("os-error-{raw_os_error}"),
            #[cfg(windows)]
            CancellationCleanupErrorKind::Windows {
                kind,
                raw_os_error: None,
            } => format!("{kind:?}"),
        }
    }

    fn description(&self) -> String {
        match self.signal {
            #[cfg(unix)]
            CancellationCleanupSignal::Sigterm | CancellationCleanupSignal::Sigkill => {
                format!(
                    "failed to send {} to install process group: {}",
                    self.signal.as_str(),
                    self.description
                )
            }
            #[cfg(windows)]
            CancellationCleanupSignal::TerminateJobObject => {
                format!("TerminateJobObject failed: {}", self.description)
            }
        }
    }
}

/// Carries a typed cancellation from a streamed command to its dependency's
/// aggregation task without changing the public Tauri command's String error.
#[derive(Clone)]
struct InstallCancellationCollector {
    cancellation: Arc<Mutex<Option<InstallCancellation>>>,
    cleanup_failure_reported: Arc<Mutex<bool>>,
}

impl InstallCancellationCollector {
    fn new() -> Self {
        Self {
            cancellation: Arc::new(Mutex::new(None)),
            cleanup_failure_reported: Arc::new(Mutex::new(false)),
        }
    }

    fn record(&self, cancellation: InstallCancellation) -> bool {
        let mut slot = recover_lock(&self.cancellation);
        if slot.is_none() {
            *slot = Some(cancellation);
            true
        } else {
            false
        }
    }

    fn take(&self) -> Option<InstallCancellation> {
        recover_lock(&self.cancellation).take()
    }

    fn mark_cleanup_failure_reported(&self) {
        *recover_lock(&self.cleanup_failure_reported) = true;
    }

    fn cleanup_failure_reported(&self) -> bool {
        *recover_lock(&self.cleanup_failure_reported)
    }
}

tokio::task_local! {
    static ACTIVE_INSTALL_CANCELLATION_COLLECTOR: InstallCancellationCollector;
}

fn record_install_cancellation(cancellation: InstallCancellation) {
    let collector = ACTIVE_INSTALL_CANCELLATION_COLLECTOR
        .try_with(|collector| collector.clone())
        .ok();
    let newly_recorded = collector
        .as_ref()
        .map(|collector| collector.record(cancellation.clone()))
        .unwrap_or(true);
    if !newly_recorded {
        return;
    }

    let (level, message) = match &cancellation {
        InstallCancellation::UserCancelled => (
            sentry::Level::Info,
            "setup dependency installation cancelled by user".to_string(),
        ),
        InstallCancellation::CleanupFailed(cleanup) => (
            sentry::Level::Warning,
            format!(
                "setup dependency installation cancelled by user; cleanup failed to send {} ({})",
                cleanup.signal.as_str(),
                cleanup.os_error_kind_token()
            ),
        ),
    };
    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some("setup.install-cancel".into()),
        level,
        message: Some(message),
        ..Default::default()
    });

    if let InstallCancellation::CleanupFailed(cleanup) = cancellation {
        if report_active_setup_cancellation_cleanup_failure(cleanup) {
            if let Some(collector) = collector {
                collector.mark_cleanup_failure_reported();
            }
        }
    }
}

fn record_setup_command_failure(program: &str, args: &[&str], exit_code: Option<i32>, stdout: String, stderr: String, error: String) {
    let command = std::iter::once(program).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
    let diagnostic = SetupCommandDiagnostic {
        command,
        exit_code,
        stdout: hq_telemetry::setup_diagnostic_tail(&stdout),
        stderr: hq_telemetry::setup_diagnostic_tail(&stderr),
        error,
    };
    let _ = ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.try_with(|collector| collector.record(diagnostic));
}

/// The next installer path is a recovery attempt. Its terminal error, not the
/// command failure it recovered from, must describe any eventual Sentry event.
fn clear_recovered_setup_command_failure() {
    let _ = ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.try_with(SetupDiagnosticCollector::clear);
}

fn append_setup_diagnostic_tail(stream: &mut String, line: &str) {
    if !stream.is_empty() {
        stream.push('\n');
    }
    stream.push_str(line);
    *stream = hq_telemetry::setup_diagnostic_tail(stream);
}

mod which {
    use std::env;
    use std::ffi::{OsStr, OsString};
    use std::io;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    pub fn which_in<T, U, V>(binary_name: T, paths: Option<U>, cwd: V) -> io::Result<PathBuf>
    where
        T: AsRef<OsStr>,
        U: AsRef<OsStr>,
        V: AsRef<Path>,
    {
        let binary_name = binary_name.as_ref();
        let binary_path = Path::new(binary_name);
        let binary_name_string = binary_name.to_string_lossy();
        let has_separator = binary_name_string.contains('/') || binary_name_string.contains('\\');

        if binary_path.is_absolute() || has_separator {
            let candidate = if binary_path.is_absolute() {
                binary_path.to_path_buf()
            } else {
                cwd.as_ref().join(binary_path)
            };
            return executable_candidate(&candidate)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "executable not found"));
        }

        let path_value = paths
            .map(|p| p.as_ref().to_os_string())
            .or_else(|| env::var_os("PATH"))
            .unwrap_or_else(OsString::new);

        for dir in env::split_paths(&path_value) {
            let base = if dir.as_os_str().is_empty() {
                cwd.as_ref().to_path_buf()
            } else {
                dir
            };
            let candidate = base.join(binary_path);
            if let Some(found) = executable_candidate(&candidate) {
                return Ok(found);
            }
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "executable not found",
        ))
    }

    fn executable_candidate(candidate: &Path) -> Option<PathBuf> {
        #[cfg(windows)]
        {
            // Only a PATHEXT extension makes a file spawnable by CreateProcess.
            // npm, qmd, and hq all ship an extensionless POSIX script next to
            // their `.cmd` shim; accepting the bare file spawns it directly and
            // fails with ERROR_BAD_EXE_FORMAT (os error 193), so a bare name
            // must resolve through PATHEXT instead.
            let pathext =
                env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
            let ext_matches = |path: &Path| {
                path.extension().is_some_and(|ext| {
                    let ext = ext.to_string_lossy();
                    pathext
                        .to_string_lossy()
                        .split(';')
                        .any(|pe| pe.trim_start_matches('.').eq_ignore_ascii_case(&ext))
                })
            };
            if candidate.extension().is_some() {
                if ext_matches(candidate) && is_executable_file(candidate) {
                    return Some(candidate.to_path_buf());
                }
                return None;
            }
            for ext in pathext.to_string_lossy().split(';') {
                if ext.is_empty() {
                    continue;
                }
                let ext = ext.trim_start_matches('.');
                let with_ext = candidate.with_extension(ext);
                if is_executable_file(&with_ext) {
                    return Some(with_ext);
                }
            }
            None
        }

        #[cfg(not(windows))]
        {
            if is_executable_file(candidate) {
                Some(candidate.to_path_buf())
            } else {
                None
            }
        }
    }

    fn is_executable_file(path: &Path) -> bool {
        let Ok(metadata) = path.metadata() else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel registry
// ─────────────────────────────────────────────────────────────────────────────

/// Global map from install-handle → cancellation state and process-tree kill target.
static CANCEL_REGISTRY: std::sync::OnceLock<Arc<Mutex<HashMap<String, CancelState>>>> =
    std::sync::OnceLock::new();

#[derive(Default)]
struct CancelState {
    cancelled: bool,
    cleanup_failure: Option<CancellationCleanupFailure>,
    #[cfg(unix)]
    pgid: Option<i32>,
    #[cfg(windows)]
    job: Option<Arc<JobHandle>>,
}

fn cancel_registry() -> &'static Arc<Mutex<HashMap<String, CancelState>>> {
    CANCEL_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Register a new cancel handle (called at the start of every install).
/// Exposed publicly so the test suite can exercise `cancel_install` without
/// spawning a real Tauri runtime.
pub fn register_cancel_handle(handle: String) {
    recover_lock(cancel_registry()).insert(handle, CancelState::default());
}

fn is_cancelled(handle: &str) -> bool {
    recover_lock(cancel_registry())
        .get(handle)
        .map(|state| state.cancelled)
        .unwrap_or(false)
}

fn deregister_handle(handle: &str) {
    recover_lock(cancel_registry()).remove(handle);
}

/// A non-process phase (such as waiting for the CLI update lock) still needs a
/// frontend-visible installer handle. Keeping this registration alive through
/// the following streamed install closes the hand-off gap between the wait and
/// npm: cancellation can reach either phase through the one existing registry.
struct InstallCancellationRegistration {
    handle: String,
}

impl InstallCancellationRegistration {
    fn new<R: tauri::Runtime>(app: &AppHandle<R>) -> Self {
        let handle = Uuid::new_v4().to_string();
        register_cancel_handle(handle.clone());
        emit_install_handle_started(app, &handle);
        Self { handle }
    }

    fn is_cancelled(&self) -> bool {
        is_cancelled(&self.handle)
    }

    /// Convert a cancellation observed before a streaming child is started
    /// into the same typed outcome that `run_streaming` records. This covers
    /// the CLI-update lock wait and the small hand-off window after the lock.
    fn reject_if_cancelled(&self) -> Result<(), String> {
        if self.is_cancelled() {
            let cancellation = InstallCancellation::UserCancelled;
            record_install_cancellation(cancellation.clone());
            return Err(cancellation.user_message());
        }
        Ok(())
    }

    fn finish<R: tauri::Runtime>(&self, app: &AppHandle<R>, error: Option<&str>) {
        deregister_handle(&self.handle);
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: self.handle.clone(),
                line: String::new(),
                finished: true,
                error: error.map(str::to_string),
            },
        );
    }
}

impl Drop for InstallCancellationRegistration {
    fn drop(&mut self) {
        deregister_handle(&self.handle);
    }
}

async fn acquire_cli_install_lock_for_setup(
    app: &AppHandle,
    cancellation: &InstallCancellationRegistration,
    on_wait: impl Fn(&AppHandle, &str) + Send + 'static,
) -> Result<hq_desktop_core::cli_update_lock::CliUpdateLockGuard, String> {
    acquire_cli_install_lock_for_setup_with_budget(
        app,
        cancellation,
        hq_desktop_core::cli_update_lock::CLI_INSTALL_LOCK_WAIT_BUDGET,
        on_wait,
    )
    .await
}

async fn acquire_cli_install_lock_for_setup_with_budget(
    app: &AppHandle,
    cancellation: &InstallCancellationRegistration,
    budget: Duration,
    on_wait: impl Fn(&AppHandle, &str) + Send + 'static,
) -> Result<hq_desktop_core::cli_update_lock::CliUpdateLockGuard, String> {
    let lock_app = app.clone();
    let cancel_handle = cancellation.handle.clone();
    let install_lock = tokio::task::spawn_blocking(move || {
        crate::commands::hq_cli_update::acquire_cli_install_lock_waiting(
            &lock_app,
            "hq-desktop-app-install-deps",
            budget,
            || is_cancelled(&cancel_handle),
            |line| on_wait(&lock_app, line),
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("cli-install lock wait task join failed: {e}")));

    cancellation.reject_if_cancelled()?;
    install_lock
}

#[cfg(unix)]
fn register_process_group(handle: &str, pgid: i32) {
    if let Some(state) = recover_lock(cancel_registry()).get_mut(handle) {
        state.pgid = Some(pgid);
    }
}

#[cfg(windows)]
fn register_job_handle(handle: &str, job: Arc<JobHandle>) {
    if let Some(state) = recover_lock(cancel_registry()).get_mut(handle) {
        state.job = Some(job);
    }
}

fn record_cleanup_failure(handle: &str, failure: CancellationCleanupFailure) {
    if let Some(state) = recover_lock(cancel_registry()).get_mut(handle) {
        // Preserve the first failed cleanup attempt. It is normally SIGTERM;
        // retaining it prevents a later SIGKILL attempt from hiding the
        // original failure that could leave the process tree running.
        if state.cleanup_failure.is_none() {
            state.cleanup_failure = Some(failure);
        }
    }
}

fn take_cleanup_failure(handle: &str) -> Option<CancellationCleanupFailure> {
    recover_lock(cancel_registry())
        .get_mut(handle)
        .and_then(|state| state.cleanup_failure.take())
}

fn cleanup_failure(handle: &str) -> Option<CancellationCleanupFailure> {
    recover_lock(cancel_registry())
        .get(handle)
        .and_then(|state| state.cleanup_failure.clone())
}

#[cfg(unix)]
fn signal_process_group_with_probe<F, P>(
    pgid: i32,
    signal_kind: Signal,
    dispatch: F,
    has_live_members: P,
) -> Result<(), CancellationCleanupFailure>
where
    F: FnOnce(Pid, Signal) -> Result<(), nix::errno::Errno>,
    P: FnOnce(i32) -> Result<bool, std::io::Error>,
{
    match dispatch(Pid::from_raw(-pgid), signal_kind) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(nix::errno::Errno::EPERM) if signal_kind == Signal::SIGTERM => {
            match has_live_members(pgid) {
                Ok(false) => Ok(()),
                Ok(true) | Err(_) => Err(CancellationCleanupFailure::from_unix_signal(
                    signal_kind,
                    nix::errno::Errno::EPERM,
                )),
            }
        }
        Err(error) => Err(CancellationCleanupFailure::from_unix_signal(
            signal_kind,
            error,
        )),
    }
}

/// Check the complete group, not only its leader: an exited unreaped leader can
/// coexist with a running child that must keep the cleanup failure visible.
/// `ps` reports zombie state on both supported Unix targets. Probe errors or a
/// timeout keep the original EPERM report.
#[cfg(unix)]
fn unix_process_group_has_live_members(pgid: i32) -> Result<bool, std::io::Error> {
    const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
    let mut probe = Command::new("/bin/ps")
        .args(["-axo", "pgid=,stat="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = probe
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "ps stdout was not piped"))?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        Read::take(stdout, MAX_OUTPUT_BYTES + 1).read_to_end(&mut output)?;
        Ok::<_, std::io::Error>(output)
    });

    let deadline = Instant::now() + Duration::from_secs(1);
    let status = loop {
        match probe.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(None) => {
                let _ = probe.kill();
                let _ = probe.wait();
                let _ = reader.join();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "process group liveness probe timed out",
                ));
            }
            Err(error) => {
                let _ = probe.kill();
                let _ = probe.wait();
                let _ = reader.join();
                return Err(error);
            }
        }
    };
    let output = reader
        .join()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "ps reader panicked"))??;
    if output.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "process group liveness output exceeded its bound",
        ));
    }
    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "ps process group query failed",
        ));
    }
    let output = String::from_utf8(output).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "ps output was not UTF-8")
    })?;
    let mut saw_process = false;
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        saw_process = true;
        let mut columns = line.split_whitespace();
        let group = columns
            .next()
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "ps output did not contain a process group id",
                )
            })?;
        let state = columns.next().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ps output did not contain a process state",
            )
        })?;
        if group != pgid {
            continue;
        }
        if !state.starts_with('Z') {
            return Ok(true);
        }
    }
    if !saw_process {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "ps returned no process entries",
        ))
    } else {
        // A successful complete listing with no matching group also proves
        // that no process in the group remains to be signaled.
        Ok(false)
    }
}

#[cfg(unix)]
fn terminate_process_tree(
    handle: &str,
    signal_kind: Signal,
) -> Result<(), CancellationCleanupFailure> {
    let pgid = recover_lock(cancel_registry())
        .get(handle)
        .and_then(|state| state.pgid);
    let Some(pgid) = pgid else {
        return Ok(());
    };

    signal_process_group_with_probe(
        pgid,
        signal_kind,
        signal::kill,
        unix_process_group_has_live_members,
    )
}

#[cfg(windows)]
fn terminate_process_tree(handle: &str) -> Result<(), CancellationCleanupFailure> {
    let job = recover_lock(cancel_registry())
        .get(handle)
        .and_then(|state| state.job.clone());
    let Some(job) = job else {
        return Ok(());
    };

    let result = unsafe { TerminateJobObject(job.0, 1) };
    if result == 0 {
        return Err(CancellationCleanupFailure::from_windows_error(
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
struct JobHandle(HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn create_job_object() -> Result<JobHandle, String> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "CreateJobObjectW failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let result = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if result == 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(format!("SetInformationJobObject failed: {err}"));
    }

    Ok(JobHandle(job))
}

#[cfg(windows)]
fn assign_process_to_job(job: HANDLE, process: HANDLE) -> Result<(), String> {
    let result = unsafe { AssignProcessToJobObject(job, process) };
    if result == 0 {
        return Err(format!(
            "AssignProcessToJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/// Result returned by `check_dep`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DepStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<PathBuf>,
}

/// Progress event payload emitted on `install:progress`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    /// Unique install handle.
    pub handle: String,
    /// Setup identity keeps unrelated installer output from refreshing setup's timer.
    #[serde(rename = "setupRunId", skip_serializing_if = "Option::is_none")]
    pub setup_run_id: Option<String>,
    /// A single line of stdout from the install process.
    pub line: String,
    /// True on the final event for this handle.
    pub finished: bool,
    /// Non-None when the install ended in an error.
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic logging (env-gated)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` when `HQ_INSTALLER_DEBUG_DEPS=1`. Any other value — including
/// `"0"`, `"true"`, empty, or unset — returns `false`. This is the ONLY gate
/// for `[hq-deps]` stderr output; production builds stay silent unless the
/// user explicitly opts in via the env var.
///
/// Exposed publicly so integration tests can verify the gate contract without
/// needing to capture stderr.
pub fn is_deps_debug_enabled() -> bool {
    std::env::var("HQ_INSTALLER_DEBUG_DEPS").ok().as_deref() == Some("1")
}

/// Captures what happened during a `shell_login_path()` probe attempt.
///
/// The enum exists so the pure `format_shell_probe_log` formatter can render
/// each outcome consistently — keeping the `[hq-deps]` log contract in one
/// place and unit-testable without stderr capture.
#[cfg(not(windows))]
pub enum ShellProbeOutcome {
    /// Shell exited 0 and returned a non-empty PATH. `bytes` is the length
    /// of the trimmed stdout.
    Success { bytes: usize },
    /// Shell exited with a non-zero status. stderr is not retained so the
    /// log line stays compact; the exit code is usually enough to diagnose.
    NonZeroExit { code: i32 },
    /// Shell exited 0 but returned zero bytes (rare — e.g. `PATH=""` or
    /// profile scripts that erase PATH). Distinct from `Success` so support
    /// docs can call this case out specifically.
    EmptyOutput,
    /// `Command::spawn` failed before the shell ever ran (bad `$SHELL`,
    /// permission denied, etc.). `msg` is the underlying io::Error message.
    SpawnError { msg: String },
}

/// Produce the `[hq-deps]` log line describing a shell-login-path probe.
///
/// Pure formatter — does not emit anything itself. The caller decides whether
/// to `eprintln!` based on `is_deps_debug_enabled()`. Keeping the render pure
/// lets unit tests assert the log format without capturing stderr.
#[cfg(not(windows))]
pub fn format_shell_probe_log(shell: &str, outcome: &ShellProbeOutcome) -> String {
    match outcome {
        ShellProbeOutcome::Success { bytes } => format!(
            "[hq-deps] shell_login_path shell={} exit=0 bytes={}",
            shell, bytes
        ),
        ShellProbeOutcome::NonZeroExit { code } => {
            format!("[hq-deps] shell_login_path shell={} exit={}", shell, code)
        }
        ShellProbeOutcome::EmptyOutput => format!(
            "[hq-deps] shell_login_path shell={} exit=0 bytes=0 empty=true",
            shell
        ),
        ShellProbeOutcome::SpawnError { msg } => format!(
            "[hq-deps] shell_login_path shell={} spawn=error msg={}",
            shell, msg
        ),
    }
}

/// Compute per-source directory counts for the PATH log line.
///
/// `shell_path` is the raw colon-joined PATH string returned by
/// `shell_login_path()` — counted by splitting on `:`. The other three
/// are pushed counts tracked by the caller (extras is a static array
/// length; home and vm are incremented as entries are appended).
///
/// Exposed `pub` for hermetic unit testing of the counting logic — no
/// stderr capture needed.
#[cfg(not(windows))]
pub fn compute_path_counts(
    shell_path: &str,
    extras_count: usize,
    home_count: usize,
    vm_count: usize,
) -> (usize, usize, usize, usize) {
    let shell_count = if shell_path.is_empty() {
        0
    } else {
        shell_path.split(':').count()
    };
    (shell_count, extras_count, home_count, vm_count)
}

/// Produce the `[hq-deps]` log line describing the final composed PATH.
///
/// `counts` is `(shell, extras, home_local, version_managers)` — the number of
/// directories contributed by each source. The PATH is truncated to 500 chars
/// so copy-pasted support logs stay readable; truncation counts characters
/// (not bytes) to avoid slicing in the middle of a multi-byte UTF-8 codepoint.
#[cfg(not(windows))]
pub fn format_path_log(path: &str, counts: (usize, usize, usize, usize)) -> String {
    let truncated: String = path.chars().take(500).collect();
    let (shell, extras, home, vm) = counts;
    format!(
        "[hq-deps] extended_search_path shell={} extras={} home={} vm={} PATH={}",
        shell, extras, home, vm, truncated
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// check_dep
// ─────────────────────────────────────────────────────────────────────────────

/// One-shot cache for the user's login-shell PATH. See `shell_login_path`.
#[cfg(not(windows))]
static SHELL_LOGIN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Capture the user's login-shell `$PATH` once per process.
///
/// A GUI-launched Tauri app on macOS inherits only `/usr/bin:/bin:/usr/sbin:/sbin`
/// from LaunchServices. Users install CLI tools via all sorts of managers —
/// nvm, fnm, asdf, volta, mise, direnv, manual prefixes — that only wire
/// their bin dirs into `$PATH` via the shell's profile (`.zshrc`, `.zprofile`,
/// `.bash_profile`, etc.). So the only portable way to find `qmd`, `claude`,
/// `hq-sync-runner` etc. is to invoke the login shell and read what PATH it
/// assembles.
///
/// Cached with `OnceLock` — the subprocess spawn is ~100 ms the first time
/// and free on subsequent calls within the app lifetime.
///
/// Emits a single `[hq-deps]` stderr line when `HQ_INSTALLER_DEBUG_DEPS=1`
/// (via `is_deps_debug_enabled()`); fires at most once per process thanks to
/// the OnceLock cache. Format is treated as a semi-public contract so
/// support paste-backs stay greppable.
#[cfg(not(windows))]
pub(crate) fn shell_login_path() -> &'static str {
    SHELL_LOGIN_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let spawn_result = Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .output();

        let (path, outcome) = match spawn_result {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8(out.stdout)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let outcome = if s.is_empty() {
                    ShellProbeOutcome::EmptyOutput
                } else {
                    ShellProbeOutcome::Success { bytes: s.len() }
                };
                (s, outcome)
            }
            Ok(out) => {
                let code = out.status.code().unwrap_or(-1);
                (String::new(), ShellProbeOutcome::NonZeroExit { code })
            }
            Err(e) => (
                String::new(),
                ShellProbeOutcome::SpawnError { msg: e.to_string() },
            ),
        };

        if is_deps_debug_enabled() {
            eprintln!("{}", format_shell_probe_log(&shell, &outcome));
        }
        path
    })
}

/// Build a PATH string that includes macOS install prefixes a GUI-launched
/// app does NOT inherit from the user's shell (brew, user-local installs,
/// Claude Code, qmd). Without this, `which brew` fails even though the
/// user has Homebrew installed, because LaunchServices-launched apps only
/// get `/usr/bin:/bin:/usr/sbin:/sbin`.
#[cfg(not(windows))]
pub fn extended_search_path() -> String {
    extended_search_path_in(None)
}

/// Same composition as `extended_search_path()` but accepts an explicit
/// home-directory override so tests can exercise version-manager discovery
/// against a fixture directory without mutating process-global HOME.
///
/// When `home` is `None`, resolves via `dirs::home_dir()` (production path).
#[cfg(not(windows))]
pub fn extended_search_path_in(home: Option<&std::path::Path>) -> String {
    let mut dirs: Vec<String> = Vec::new();
    // Prefer the managed HQ toolchain first when it exists. This keeps later
    // qmd/npx runs on the same Node ABI the installer provisioned, even if the
    // user's shell has an older Node earlier in PATH.
    let home_buf = home.map(|p| p.to_path_buf()).or_else(dirs::home_dir);
    let mut home_count: usize = 0;
    if let Some(home) = home_buf.as_deref() {
        for p in managed_tool_paths_in(home) {
            dirs.push(p);
            home_count += 1;
        }
    }
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            dirs.push(existing);
        }
    }
    // Seed from the user's login shell — picks up nvm/fnm/asdf/volta/mise etc.
    // that inject node-version-manager bin dirs via profile scripts. This is
    // the only reliable way to find tools installed via `npm i -g` on systems
    // where the global prefix is under ~/.nvm/versions/node/<v>/bin or similar.
    let shell_path = shell_login_path();
    if !shell_path.is_empty() {
        dirs.push(shell_path.to_string());
    }
    // Standard macOS install locations that GUI app PATH misses.
    let extras = [
        "/opt/homebrew/bin", // Apple Silicon Homebrew
        "/opt/homebrew/sbin",
        "/usr/local/bin", // Intel Homebrew + generic
        "/usr/local/sbin",
    ];
    for e in extras {
        dirs.push(e.to_string());
    }
    // User-local installs (~/.claude/bin, ~/.cargo/bin, ~/.local/bin, ~/bin).
    if let Some(home) = home_buf.as_deref() {
        for rel in [".claude/bin", ".cargo/bin", ".local/bin", "bin"] {
            let p = home.join(rel);
            dirs.push(p.to_string_lossy().into_owned());
            home_count += 1;
        }
    }
    // Node version managers — enumerate installed Node versions so CLIs
    // installed via `npm i -g` under nvm/fnm (plus volta and pnpm's global
    // bin) are detected even when the shell-login PATH probe returns empty
    // (GUI launch without inherited SHELL). Each block tolerates missing
    // dirs and read_dir errors silently; a failed probe never blocks other
    // managers from being tried.
    let mut vm_count: usize = 0;
    if let Some(home) = home_buf.as_deref() {
        for d in version_manager_dirs(home) {
            dirs.push(d);
            vm_count += 1;
        }
    }
    let joined = dirs.join(":");
    // Env-gated diagnostic — emits at most one line per call when
    // HQ_INSTALLER_DEBUG_DEPS=1. Silent for any other value of the env var.
    // shell_path is colon-joined; count individual dirs so support can
    // see how many dirs the login-shell actually contributed.
    if is_deps_debug_enabled() {
        eprintln!(
            "{}",
            format_path_log(
                &joined,
                compute_path_counts(shell_path, extras.len(), home_count, vm_count)
            )
        );
    }
    joined
}

/// Collect bin directories from Node version managers present under `home`.
///
/// Covers: nvm (~/.nvm/versions/node/<v>/bin), fnm
/// (~/.fnm/node-versions/<v>/installation/bin), volta (~/.volta/bin),
/// pnpm (~/Library/pnpm — macOS location).
///
/// Missing dirs, permission errors, and stale version entries without a
/// `/bin` subdir are silently skipped. This function never panics.
#[cfg(not(windows))]
fn version_manager_dirs(home: &std::path::Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // nvm: enumerate ~/.nvm/versions/node/*/bin
    // read_dir order is filesystem-defined (unspecified). We sort descending by
    // parsed version tuple so which::which_in resolves to the newest toolchain
    // first — otherwise install_claude_code / install_qmd could target an older
    // global prefix on multi-version systems.
    let nvm_root = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut collected: Vec<((u32, u32, u32), String)> = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let bin = p.join("bin");
                if bin.exists() {
                    let name = entry.file_name();
                    let version = parse_node_version(&name.to_string_lossy());
                    collected.push((version, bin.to_string_lossy().into_owned()));
                }
            }
        }
        collected.sort_by_key(|b| std::cmp::Reverse(b.0));
        for (_, path) in collected {
            out.push(path);
        }
    }

    // fnm: enumerate ~/.fnm/node-versions/*/installation/bin
    // Same descending-version sort as the nvm block above.
    let fnm_root = home.join(".fnm").join("node-versions");
    if let Ok(entries) = std::fs::read_dir(&fnm_root) {
        let mut collected: Vec<((u32, u32, u32), String)> = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let bin = p.join("installation").join("bin");
                if bin.exists() {
                    let name = entry.file_name();
                    let version = parse_node_version(&name.to_string_lossy());
                    collected.push((version, bin.to_string_lossy().into_owned()));
                }
            }
        }
        collected.sort_by_key(|b| std::cmp::Reverse(b.0));
        for (_, path) in collected {
            out.push(path);
        }
    }

    // volta: single dir ~/.volta/bin
    let volta_bin = home.join(".volta").join("bin");
    if volta_bin.is_dir() {
        out.push(volta_bin.to_string_lossy().into_owned());
    }

    // pnpm global bin on macOS: ~/Library/pnpm
    let pnpm_bin = home.join("Library").join("pnpm");
    if pnpm_bin.is_dir() {
        out.push(pnpm_bin.to_string_lossy().into_owned());
    }

    out
}

/// Parse a Node version directory name like `v22.17.0` or `20.10.1` into a
/// `(major, minor, patch)` tuple for ordering. Strips a leading `v`, splits
/// on `.`, and takes the first 3 components. Any unparseable component (or
/// missing component) becomes `0` so malformed names sort last. Never panics.
#[cfg(not(windows))]
fn parse_node_version(dir_name: &str) -> (u32, u32, u32) {
    let trimmed = dir_name.strip_prefix('v').unwrap_or(dir_name);
    let mut parts = trimmed.split('.');
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

// ─────────────────────────────────────────────────────────────────────────────
// Managed HQ toolchain
// ─────────────────────────────────────────────────────────────────────────────

/// Pinned Node LTS used for admin-free fresh installs.
///
/// This intentionally moves slower than Node latest. HQ needs a stable Node 22+
/// runtime for npx/qmd/Claude Code, not the newest dist-tag.
#[cfg(not(windows))]
const MANAGED_NODE_VERSION: &str = "v22.17.0";

/// Node's ABI (`process.versions.modules`) for HQ's managed Node major line. A
/// prebuilt native module built for this ABI loads under the managed Node and only
/// under it, so the hq-CLI updater's retry gate refuses a managed provision when
/// the failing runtime ALREADY reports this ABI (a fresh Node 22 could not help).
/// Node 22.x — both `MANAGED_NODE_VERSION` (macOS v22.17.0) and
/// `WINDOWS_MANAGED_NODE_VERSION` (v22.12.0) — is ABI 127. Not platform-gated (the
/// gate runs on every platform), and tied to those pins by
/// `managed_node_abi_matches_pinned_versions` so a Node bump that changes the ABI
/// cannot silently desync the gate.
pub(crate) const MANAGED_NODE_ABI: u32 = 127;

#[cfg(not(windows))]
const MANAGED_NODE_SHA256_ARM64: &str =
    "615dda58b5fb41fad2be43940b6398ca56554cbe05800953afadc724729cb09e";
#[cfg(not(windows))]
const MANAGED_NODE_SHA256_X64: &str =
    "c39c8ec3cdadedfcc75de0cb3305df95ae2aecebc5db8d68a9b67bd74616d2ad";

/// Pinned portable Git from dugite-native (GitHub Desktop's embedded Git).
/// Self-contained — runs with no Xcode Command Line Tools, Homebrew, or admin.
/// HQ requires the git CLI for autocommit, repo work, agents, and pack install,
/// so we provision it into the managed toolchain like Node/qmd rather than
/// leaving the user to install it. Bump deliberately and refresh BOTH per-arch
/// SHA-256s from the release's `*.tar.gz.sha256` assets.
#[cfg(not(windows))]
const MANAGED_GIT_RELEASE: &str = "v2.53.0-3";
#[cfg(not(windows))]
const MANAGED_GIT_BUILD: &str = "v2.53.0-f49d009";
#[cfg(not(windows))]
const MANAGED_GIT_SHA256_ARM64: &str =
    "e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437";
#[cfg(not(windows))]
const MANAGED_GIT_SHA256_X64: &str =
    "caf27c36b8834969550535bcd5e58186f970e080d1e175e76d9c1de3aac409ed";

fn unique_sibling_path(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("target has no parent: {}", target.display()))?;
    let name = target
        .file_name()
        .ok_or_else(|| format!("target has no file name: {}", target.display()))?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{suffix}.{}", Uuid::new_v4())))
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded retry for the managed-toolchain directory swap (HQ-DESKTOP-5N / 5P)
// ─────────────────────────────────────────────────────────────────────────────
//
// atomic_replace_dir / atomic_replace_file rename the freshly staged,
// checksum- and version-verified toolchain into place. On Windows a single
// ERROR_ACCESS_DENIED (os error 5) — an AV/EDR or Search-indexer scan of the
// just-extracted tree, a process whose CWD is inside it, Controlled Folder
// Access, or a still-mapped node.exe image — used to be terminal on the FIRST
// try: no retry, no fallback. That turned a transient handle into a 15-minute
// NodeUnprovisioned outage plus an #hq-alerts page (HQ-DESKTOP-5N), and a
// backup that could not be deleted AFTER the new tree was already live turned a
// COMPLETED install into the same paging failure (HQ-DESKTOP-5P).
//
// These give every swap rename the same bounded retry the download leg already
// has. NOT platform-gated: the macOS/Linux Node and managed-git activation path
// uses the identical helpers, so the resilience — and the portable tests that
// prove it in the rust-macos lane — cover every platform.

/// How many times each swap filesystem step is attempted before giving up.
const SWAP_ATTEMPTS: u32 = 5;

/// Fixed backoff before the retry after attempt N (index 0 -> after attempt 1).
/// Fixed, not exponential: the repair slot is short and the goal is to ride out
/// a brief handle, not to be polite. Holds at least `SWAP_ATTEMPTS - 1` entries
/// (asserted in `the_swap_budget_stays_inside_the_repair_slot`). Total worst-
/// case backoff is 15s, well inside the 15-minute repair slot.
const SWAP_BACKOFF: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];

/// The backoff to sleep before the attempt after `attempt_index` (0-based).
/// Hermetic by default in test builds (unit tests never sleep 1-8s), mirroring
/// `download_backoff`; production (never compiled with cfg(test)) always uses
/// the real table. The Windows real-handle artifact E2E opts into a genuine
/// backoff window via `HQ_SWAP_TEST_BACKOFF_MS` so a handle a thread releases
/// mid-budget is actually ridden out.
fn swap_backoff(attempt_index: usize) -> Duration {
    if cfg!(test) {
        return std::env::var("HQ_SWAP_TEST_BACKOFF_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::ZERO);
    }
    SWAP_BACKOFF
        .get(attempt_index)
        .copied()
        .unwrap_or(Duration::from_secs(8))
}

/// Which filesystem step of the swap a failure came from, for attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwapPhase {
    Backup,
    Activate,
    Restore,
    Cleanup,
}

impl SwapPhase {
    fn as_str(self) -> &'static str {
        match self {
            SwapPhase::Backup => "backup",
            SwapPhase::Activate => "activate",
            SwapPhase::Restore => "restore",
            SwapPhase::Cleanup => "cleanup",
        }
    }
}

/// True for an OS error that a directory rename/remove can plausibly recover
/// from on a retry: a held handle or a lock that clears once the AV / indexer /
/// other process lets go. Built to be fed REAL `std::io::Error` values.
///
/// Windows raw codes: 5 ERROR_ACCESS_DENIED, 32 ERROR_SHARING_VIOLATION,
/// 33 ERROR_LOCK_VIOLATION, 145 ERROR_DIR_NOT_EMPTY (a concurrent scanner
/// re-creating entries under a directory being removed). `PermissionDenied`
/// also covers unix EACCES so the same predicate is meaningful in the portable
/// tests. `NotFound` is never retryable — the source is simply gone.
fn is_retryable_swap_error(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::NotFound {
        return false;
    }
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    // These bare numbers are Windows sharing/lock violations. On macOS/Linux the
    // SAME numbers mean unrelated, usually terminal errors (e.g. unix EIO=5,
    // EPIPE=32), and this helper is shared with the non-Windows managed-toolchain
    // paths — so off Windows we must rely only on the portable ErrorKind checks
    // above and never retry a raw code, or a terminal FS failure would burn the
    // whole 15s budget before failing.
    #[cfg(windows)]
    {
        matches!(
            err.raw_os_error(),
            Some(5) | Some(32) | Some(33) | Some(145)
        )
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// A terminal swap-step failure carrying the evidence the single-shot version
/// could not: which phase failed, the raw OS error code, how many attempts ran,
/// and how long the retry budget took.
struct SwapError {
    phase: SwapPhase,
    err: std::io::Error,
    attempts: u32,
    elapsed: Duration,
}

impl SwapError {
    /// Render the io error followed by the structured attribution suffix. The
    /// caller prepends its existing leading shape (e.g. `backup existing X -> Y
    /// failed: `) so the Sentry fingerprint's head stays stable while the suffix
    /// makes the next occurrence self-diagnosing. `target_state` is the observed
    /// occupant of the target path (dir | file | symlink | absent | ...).
    fn describe(&self, target_state: &str) -> String {
        format!(
            "{} [phase={} os_error={} attempts={} of {} elapsed_ms={} target_state={}]",
            self.err,
            self.phase.as_str(),
            self.err
                .raw_os_error()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "none".to_string()),
            self.attempts,
            SWAP_ATTEMPTS,
            self.elapsed.as_millis(),
            target_state,
        )
    }
}

/// Run one filesystem step up to `SWAP_ATTEMPTS` times, retrying ONLY errors
/// `is_retryable_swap_error` accepts (a `NotFound` or any other terminal error
/// fails on the first attempt). `op` is a closure so the retry/attribution
/// logic is proven hermetically against real `io::Error`s, exactly the way
/// `fetch_asset_with` proves the download retry.
fn retry_swap_op<F>(phase: SwapPhase, mut op: F) -> Result<(), SwapError>
where
    F: FnMut() -> std::io::Result<()>,
{
    let started = std::time::Instant::now();
    let mut attempts = 0u32;
    let mut last: Option<std::io::Error> = None;
    for attempt in 1..=SWAP_ATTEMPTS {
        attempts = attempt;
        match op() {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = is_retryable_swap_error(&e);
                last = Some(e);
                if !retryable || attempt == SWAP_ATTEMPTS {
                    break;
                }
                std::thread::sleep(swap_backoff((attempt - 1) as usize));
            }
        }
    }
    Err(SwapError {
        phase,
        err: last.expect("a completed loop only breaks with an error; Ok returns early"),
        attempts,
        elapsed: started.elapsed(),
    })
}

/// Classify the current occupant of a path WITHOUT following a symlink, for the
/// attribution suffix. A dangling reparse point reads as `symlink`, not
/// `absent`, which is exactly the state the single-shot message could not tell
/// apart from a real directory.
fn describe_target_state(target: &Path) -> String {
    match std::fs::symlink_metadata(target) {
        Ok(m) if m.is_dir() => "dir".to_string(),
        Ok(m) if m.file_type().is_symlink() => "symlink".to_string(),
        Ok(m) if m.is_file() => "file".to_string(),
        Ok(_) => "other".to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "absent".to_string(),
        Err(e) => format!("metadata-error:{:?}", e.kind()),
    }
}

/// Remove a stray non-directory entry at `path`: a plain file or a symlink is
/// `remove_file`; a directory symlink / reparse point needs `remove_dir`.
fn remove_non_directory_entry(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // Preserve a retryable error (a held handle's sharing/access violation)
        // so retry_swap_op can still retry it; only fall back to remove_dir when
        // remove_file's failure is that the entry is a directory (a directory
        // symlink / reparse point). Masking the retryable error behind a
        // remove_dir NotADirectory would defeat the retry (Codex review).
        Err(e) if is_retryable_swap_error(&e) => Err(e),
        Err(_) => std::fs::remove_dir(path),
    }
}

/// Debug logger available on every platform (the download leg's `debug_log` is
/// Windows-only). Gated on the same `HQ_INSTALLER_DEBUG_DEPS` switch.
fn swap_debug_log(msg: &str) {
    if is_deps_debug_enabled() {
        eprintln!("[hq-deps] {msg}");
    }
}

fn atomic_replace_file(staged: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    if !target.exists() {
        return retry_swap_op(SwapPhase::Activate, || std::fs::rename(staged, target)).map_err(
            |se| {
                format!(
                    "rename {} -> {} failed: {}",
                    staged.display(),
                    target.display(),
                    se.describe("absent")
                )
            },
        );
    }

    let backup = unique_sibling_path(target, "bak")?;
    retry_swap_op(SwapPhase::Backup, || std::fs::rename(target, &backup)).map_err(|se| {
        format!(
            "backup existing {} -> {} failed: {}",
            target.display(),
            backup.display(),
            se.describe(&describe_target_state(target))
        )
    })?;

    match retry_swap_op(SwapPhase::Activate, || std::fs::rename(staged, target)) {
        Ok(()) => {
            // The new file is live by construction. Removing the old copy is
            // cleanup, NEVER a success criterion (HQ-DESKTOP-5P): retry it, and
            // if it still fails, log the orphan and return Ok anyway.
            if let Err(se) = retry_swap_op(SwapPhase::Cleanup, || std::fs::remove_file(&backup)) {
                swap_debug_log(&format!(
                    "activation succeeded but backup {} could not be removed; left for sweep: {}",
                    backup.display(),
                    se.describe("file")
                ));
            }
            Ok(())
        }
        Err(activate_se) => {
            // Roll back to the pre-existing file; the restore rename is retried
            // too so a transient handle does not lose the old copy.
            match retry_swap_op(SwapPhase::Restore, || std::fs::rename(&backup, target)) {
                Ok(()) => Err(format!(
                    "rename {} -> {} failed: {}",
                    staged.display(),
                    target.display(),
                    activate_se.describe("restored")
                )),
                Err(restore_se) => Err(format!(
                    "rename {} -> {} failed: {}; restore {} -> {} failed: {}",
                    staged.display(),
                    target.display(),
                    activate_se.describe("restore-failed"),
                    backup.display(),
                    target.display(),
                    restore_se.describe("restore-failed")
                )),
            }
        }
    }
}

fn atomic_replace_dir(staged: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    // Classify the current occupant of the target path WITHOUT following a
    // symlink, so a dangling reparse point is handled as an entry rather than as
    // "absent" (which would let the activate rename collide with it).
    match std::fs::symlink_metadata(target) {
        // Nothing there: a single retried activate rename is the whole job.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return retry_swap_op(SwapPhase::Activate, || std::fs::rename(staged, target)).map_err(
                |se| {
                    format!(
                        "rename {} -> {} failed: {}",
                        staged.display(),
                        target.display(),
                        se.describe("absent")
                    )
                },
            );
        }
        // A stray file / symlink / reparse point is NOT a managed toolchain and
        // must never be preserved as a backup. Removing it without a backup is
        // the one sanctioned exception to the never-delete-without-a-successful-
        // backup invariant (a non-directory cannot be a Node/git install), then
        // activate. Removal + activation are each retried.
        Ok(meta) if !meta.is_dir() => {
            let state = if meta.file_type().is_symlink() {
                "symlink"
            } else {
                "file"
            };
            // Remove by entry type: a plain FILE goes through remove_file so a
            // held handle's retryable sharing/access error survives for
            // retry_swap_op, instead of being masked by a remove_dir fallback.
            let is_plain_file = meta.is_file();
            retry_swap_op(SwapPhase::Backup, || {
                if is_plain_file {
                    std::fs::remove_file(target)
                } else {
                    remove_non_directory_entry(target)
                }
            })
            .map_err(|se| {
                format!(
                    "remove stray non-directory {} failed: {}",
                    target.display(),
                    se.describe(state)
                )
            })?;
            return retry_swap_op(SwapPhase::Activate, || std::fs::rename(staged, target)).map_err(
                |se| {
                    format!(
                        "rename {} -> {} failed: {}",
                        staged.display(),
                        target.display(),
                        se.describe(&describe_target_state(target))
                    )
                },
            );
        }
        // A real directory, or an entry we could not stat: take the
        // backup -> activate -> cleanup path, preserving whatever is there.
        _ => {}
    }

    let backup = unique_sibling_path(target, "bak")?;
    retry_swap_op(SwapPhase::Backup, || std::fs::rename(target, &backup)).map_err(|se| {
        format!(
            "backup existing {} -> {} failed: {}",
            target.display(),
            backup.display(),
            se.describe(&describe_target_state(target))
        )
    })?;

    match retry_swap_op(SwapPhase::Activate, || std::fs::rename(staged, target)) {
        Ok(()) => {
            // The new tree is live by construction. Removing the old copy is
            // cleanup, NEVER a success criterion (HQ-DESKTOP-5P): retry it, and
            // if it still fails, log the orphan for the next sweep and return Ok.
            if let Err(se) = retry_swap_op(SwapPhase::Cleanup, || std::fs::remove_dir_all(&backup))
            {
                swap_debug_log(&format!(
                    "activation succeeded but backup {} could not be removed; left for sweep: {}",
                    backup.display(),
                    se.describe("dir")
                ));
            }
            Ok(())
        }
        Err(activate_se) => {
            // Roll back to the pre-existing install; the restore rename is
            // retried too so a transient handle does not lose the old copy.
            match retry_swap_op(SwapPhase::Restore, || std::fs::rename(&backup, target)) {
                Ok(()) => Err(format!(
                    "rename {} -> {} failed: {}",
                    staged.display(),
                    target.display(),
                    activate_se.describe("restored")
                )),
                Err(restore_se) => Err(format!(
                    "rename {} -> {} failed: {}; restore {} -> {} failed: {}",
                    staged.display(),
                    target.display(),
                    activate_se.describe("restore-failed"),
                    backup.display(),
                    target.display(),
                    restore_se.describe("restore-failed")
                )),
            }
        }
    }
}

/// Activate a freshly staged managed directory, and — unlike a bare
/// `atomic_replace_dir(...)?` — clean up the staged tree if the swap fails
/// terminally, so a failed repair never strands the ~35 MB extracted payload as
/// a `.node-install-<uuid>` sibling in the toolchain root. Every earlier error
/// arm of `install_managed_node` already removes its staged dir; this closes
/// the one arm that did not. Platform-neutral so the macOS/Linux Node and
/// managed-git paths get the same guarantee and the portable test proves it in
/// the rust-macos lane.
fn activate_staged_dir(staged: &Path, target: &Path) -> Result<(), String> {
    match atomic_replace_dir(staged, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(staged);
            Err(e)
        }
    }
}

/// True when a usable managed Node already sits at `node_exe` — a concurrently
/// provisioned target we should accept rather than fight to overwrite. The
/// repair slot is a process-local static and cannot serialize two HQ processes,
/// so a target that appeared between preflight and the swap is a real, reachable
/// state. Gated on the SAME version check the staged tree had to pass
/// (`version_ok`), so a stale, corrupt, or wrong-version install is NOT waved
/// through. `version_ok` is injected so the decision is testable off-Windows
/// without a node.exe subprocess.
#[cfg_attr(not(windows), allow(dead_code))]
fn managed_node_already_usable<F>(node_exe: &Path, version_ok: F) -> bool
where
    F: FnOnce(&Path) -> bool,
{
    node_exe.is_file() && version_ok(node_exe)
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn managed_node_should_be_reused<F>(
    replace_existing: bool,
    node_exe: &Path,
    version_ok: F,
) -> bool
where
    F: FnOnce(&Path) -> bool,
{
    !replace_existing && managed_node_already_usable(node_exe, version_ok)
}

/// Hash a managed Node executable so a forced repair can distinguish its
/// original target from a valid replacement installed by another HQ process.
/// A forced repair must replace the original executable even when it reports
/// the expected version, but may accept a different, version-verified file
/// after losing a concurrent swap.
fn managed_node_sha256(path: &Path) -> Result<Option<String>, String> {
    use sha2::{Digest, Sha256};

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(Some(format!("{:x}", digest.finalize())))
}

fn managed_node_changed_since_repair_started(
    original_digest: Option<&str>,
    current_digest: Option<&str>,
) -> bool {
    current_digest.is_some() && original_digest != current_digest
}

/// Name+age predicate for the stale-sibling sweep, split out so it is tested
/// without depending on filesystem mtime timing. A `.node.bak.*` or
/// `.node-install-*` entry is swept only when it is at least `min_age` old, so a
/// concurrently running install's in-flight staged tree (always newer than one
/// repair slot) is never removed.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_stale_toolchain_sibling(name: &str, age: Option<Duration>, min_age: Duration) -> bool {
    // Only staging trees are aged by mtime. A fresh extraction has a recent
    // mtime, so a concurrent install's in-flight `.node-install-*` is never
    // swept, and a stranded staging tree is never a restore source. A
    // `.node.bak.*` backup is deliberately NOT swept: a rename preserves the OLD
    // directory's mtime, so a concurrent swap's actively-used rollback backup
    // would be misjudged as stale and deleted out from under its restore, losing
    // the previous runtime (Codex review, PR #548).
    if !name.starts_with(".node-install-") {
        return false;
    }
    matches!(age, Some(a) if a >= min_age)
}

/// Best-effort, never-fatal removal of stale `.node.bak.*` and `.node-install-*`
/// siblings left by an earlier interrupted or denied swap, so repeated repairs
/// cannot accumulate extracted Node trees in the toolchain root. Only entries
/// older than `min_age` are touched (see `is_stale_toolchain_sibling`).
#[cfg_attr(not(windows), allow(dead_code))]
fn sweep_stale_toolchain_siblings(toolchain_dir: &Path, min_age: Duration) {
    let Ok(entries) = std::fs::read_dir(toolchain_dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok());
        if !is_stale_toolchain_sibling(&name, age, min_age) {
            continue;
        }
        let path = entry.path();
        let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
    }
}

#[cfg(not(windows))]
fn managed_toolchain_dir_in(home: &std::path::Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Indigo HQ")
        .join("toolchain")
}

#[cfg(not(windows))]
fn managed_node_dir_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("node")
}

#[cfg(not(windows))]
fn managed_node_bin_in(home: &std::path::Path) -> PathBuf {
    managed_node_dir_in(home).join("bin")
}

#[cfg(not(windows))]
fn managed_npm_prefix_in(home: &std::path::Path) -> PathBuf {
    // Single source of truth shared with the hq-CLI updater's managed retry, so
    // the first-run installer and the updater can never drift to different prefixes.
    hq_desktop_core::paths::managed_npm_prefix_in(&managed_toolchain_dir_in(home))
}

#[cfg(not(windows))]
fn managed_npm_bin_in(home: &std::path::Path) -> PathBuf {
    hq_desktop_core::paths::managed_npm_bin_in(&managed_toolchain_dir_in(home))
}

#[cfg(not(windows))]
fn managed_git_dir_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("git")
}

#[cfg(not(windows))]
fn managed_git_bin_in(home: &std::path::Path) -> PathBuf {
    managed_git_dir_in(home).join("bin")
}

/// Compatibility wrapper for the shared managed-Git environment helper.
///
/// The core helper checks the Git selected by the child PATH, rather than only
/// whether HQ's portable Git exists, before returning its configuration.
/// Exposed for unit tests.
#[cfg(not(windows))]
pub fn managed_git_env_in(home: &std::path::Path) -> Vec<(String, String)> {
    hq_desktop_core::paths::managed_git_env_in(home)
}

/// Production wrapper over the core helper, retained for existing call sites.
#[cfg(not(windows))]
pub fn managed_git_env() -> Vec<(String, String)> {
    hq_desktop_core::paths::managed_git_env()
}

/// User-local tool paths owned by HQ Installer. Exposed for unit tests.
#[cfg(not(windows))]
pub fn managed_tool_paths_in(home: &std::path::Path) -> Vec<String> {
    vec![
        managed_node_bin_in(home).to_string_lossy().into_owned(),
        managed_npm_bin_in(home).to_string_lossy().into_owned(),
        managed_git_bin_in(home).to_string_lossy().into_owned(),
    ]
}

/// Map Rust's `std::env::consts::ARCH` values to Node's darwin tarball names.
/// Exposed for unit tests so the download URL stays deterministic.
#[cfg(not(windows))]
pub fn node_dist_arch_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("x64"),
        _ => None,
    }
}

#[cfg(not(windows))]
fn managed_node_url_for_base(arch: &str, dist_base: &str) -> Option<String> {
    let node_arch = node_dist_arch_for(arch)?;
    Some(format!(
        "{}/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-{node_arch}.tar.gz",
        dist_base.trim_end_matches('/')
    ))
}

/// Where the managed Node tarball is fetched from.
///
/// `HQ_NODE_DIST_URL` exists so a test build can serve the pinned tarball from
/// loopback instead of reaching nodejs.org. It is honoured ONLY in debug
/// builds: in a shipped app it would let anyone who can set the process
/// environment choose the download origin, and defence-in-depth is cheaper than
/// relying solely on the checksum gate below to catch that. The gate still runs
/// unconditionally either way — `install_node_macos` refuses any arch without a
/// pinned SHA-256 and verifies the download against it before activation — so a
/// redirected origin can still only ever deliver the exact pinned build.
#[cfg(not(windows))]
fn managed_node_dist_base() -> String {
    const DEFAULT: &str = "https://nodejs.org/dist";
    #[cfg(debug_assertions)]
    {
        std::env::var("HQ_NODE_DIST_URL").unwrap_or_else(|_| DEFAULT.to_string())
    }
    #[cfg(not(debug_assertions))]
    {
        DEFAULT.to_string()
    }
}

#[cfg(not(windows))]
fn managed_node_url_for(arch: &str) -> Option<String> {
    managed_node_url_for_base(arch, &managed_node_dist_base())
}

#[cfg(not(windows))]
fn managed_node_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some(MANAGED_NODE_SHA256_ARM64),
        "x86_64" => Some(MANAGED_NODE_SHA256_X64),
        _ => None,
    }
}

/// dugite-native publishes per-arch macOS tarballs as `...-macOS-{arm64,x64}`.
/// Reuses `node_dist_arch_for` since dugite uses the same arch tokens as Node.
#[cfg(not(windows))]
fn managed_git_url_for(arch: &str) -> Option<String> {
    let git_arch = node_dist_arch_for(arch)?;
    Some(format!(
        "https://github.com/desktop/dugite-native/releases/download/{MANAGED_GIT_RELEASE}/dugite-native-{MANAGED_GIT_BUILD}-macOS-{git_arch}.tar.gz"
    ))
}

/// Pinned SHA-256 for the dugite-native tarball, per arch.
#[cfg(not(windows))]
fn managed_git_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some(MANAGED_GIT_SHA256_ARM64),
        "x86_64" => Some(MANAGED_GIT_SHA256_X64),
        _ => None,
    }
}

#[cfg(not(windows))]
fn home_dir_or_err<R: tauri::Runtime>(app: &AppHandle<R>, tool: &str) -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| {
        let msg = format!("[{tool}] could not resolve home directory");
        emit_preflight_line(app, &msg);
        msg
    })
}

#[cfg(not(windows))]
fn npm_global_prefix_arg(app: &AppHandle, tool: &str) -> Result<String, String> {
    let home = home_dir_or_err(app, tool)?;
    let prefix = managed_npm_prefix_in(&home);
    if let Err(e) = std::fs::create_dir_all(&prefix) {
        let msg = format!(
            "[{tool}] failed to create npm prefix {}: {e}",
            prefix.display()
        );
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    ensure_shell_path_configured(&home, app);
    Ok(prefix.to_string_lossy().into_owned())
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell profile PATH injection
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(windows))]
const SHELL_PATH_MARKER: &str = "# Indigo HQ managed toolchain";

/// Resolve which shell profile file to modify.
///
/// Modern macOS defaults to zsh (since Catalina 10.15), so `.zshrc` is the
/// primary target. Falls back to `.bash_profile` for bash users or `.profile`
/// for anything else. Exposed for testing.
#[cfg(not(windows))]
pub fn shell_profile_path_in(home: &std::path::Path) -> PathBuf {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let profile_name = if shell.ends_with("/zsh") {
        ".zshrc"
    } else if shell.ends_with("/bash") {
        ".bash_profile"
    } else {
        ".profile"
    };
    home.join(profile_name)
}

/// Check whether the managed toolchain PATH block has already been written to
/// a shell profile. Exposed for testing.
#[cfg(not(windows))]
pub fn is_shell_path_configured(profile_path: &std::path::Path) -> bool {
    std::fs::read_to_string(profile_path)
        .map(|contents| contents.contains(SHELL_PATH_MARKER))
        .unwrap_or(false)
}

/// Build the block that gets appended to the shell profile. Exposed for
/// testing so assertions don't depend on the home directory.
#[cfg(not(windows))]
pub fn shell_path_block() -> String {
    // Every managed bin dir a user-facing tool lands in — node, the npm
    // global prefix (qmd, hq, claude), the portable dugite git, and
    // ~/.local/bin (yq's direct-binary fallback). The git dir MUST come
    // before /usr/bin: on a Mac without Xcode CLT, /usr/bin/git is a stub
    // that pops the "install developer tools" dialog. The install matrix
    // (sonoma-consumer:bare:full-fresh-install, 2026-09-03) caught both
    // `yq: command not found` and the stub git after a reported-OK install.
    format!(
        "\n{SHELL_PATH_MARKER}\nexport PATH=\"$HOME/Library/Application Support/Indigo HQ/toolchain/node/bin:$HOME/Library/Application Support/Indigo HQ/toolchain/npm-global/bin:$HOME/Library/Application Support/Indigo HQ/toolchain/git-shim:$HOME/.local/bin:$PATH\"\n"
    )
}

/// Ensure the portable Git wrapper for an explicit home directory.
///
/// The health gate lives in `hq-desktop-core::paths` with the rescue PATH
/// selection it protects, so both the installer and core updates reject the
/// same partial managed-Git install.
#[cfg(not(windows))]
pub fn ensure_managed_git_shim_in(home: &std::path::Path) -> Result<PathBuf, String> {
    hq_desktop_core::paths::ensure_managed_git_shim_in(home)
}

#[cfg(not(windows))]
pub fn managed_git_shim_dir_in(home: &std::path::Path) -> PathBuf {
    hq_desktop_core::paths::managed_git_shim_dir_in(home)
}

/// Profile files the PATH block must land in for this shell.
///
/// zsh reads `.zshrc` only for INTERACTIVE shells; login-but-non-interactive
/// shells (`zsh -lc`, launchd, hooks, subprocesses spawned by `hq`) read
/// `.zprofile` instead. Writing only `.zshrc` made the toolchain vanish for
/// every non-terminal caller — the matrix `path.non-interactive-shell`
/// check. Exposed for testing.
#[cfg(not(windows))]
pub fn shell_profile_paths_in(home: &std::path::Path) -> Vec<PathBuf> {
    let primary = shell_profile_path_in(home);
    let mut paths = vec![primary.clone()];
    if primary.file_name().and_then(|n| n.to_str()) == Some(".zshrc") {
        paths.push(home.join(".zprofile"));
    }
    paths
}

/// Ensure the managed toolchain bin directories are present in the user's
/// shell profile so that `hq`, `qmd`, `claude`, and `node`/`npm` are
/// discoverable from interactive terminal sessions.
///
/// This is the macOS equivalent of writing the install path to the Windows
/// system PATH environment variable. On macOS, PATH is configured per-shell
/// via profile scripts (`.zshrc`, `.bash_profile`, `.profile`).
///
/// Idempotent — checks for a marker comment before writing. Failures are
/// non-fatal and logged via `emit_preflight_line`.
#[cfg(not(windows))]
pub(crate) fn ensure_shell_path_configured(home: &std::path::Path, app: &AppHandle) {
    match ensure_managed_git_shim_in(home) {
        Ok(p) => emit_preflight_line(app, &format!("[path] portable git shim at {}", p.display())),
        Err(reason) => emit_preflight_line(
            app,
            &format!("[path] portable git shim unavailable: {reason}"),
        ),
    }
    let block = shell_path_block();
    for profile_path in shell_profile_paths_in(home) {
        if is_shell_path_configured(&profile_path) {
            continue;
        }
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&profile_path)
        {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(block.as_bytes()) {
                    emit_preflight_line(
                        app,
                        &format!("[path] failed to write to {}: {e}", profile_path.display()),
                    );
                } else {
                    emit_preflight_line(
                        app,
                        &format!(
                            "[path] added HQ toolchain to {} — restart your terminal or run: source {}",
                            profile_path.display(),
                            profile_path.display()
                        ),
                    );
                }
            }
            Err(e) => {
                emit_preflight_line(
                    app,
                    &format!("[path] failed to open {}: {e}", profile_path.display()),
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude settings.json PATH injection
// ─────────────────────────────────────────────────────────────────────────────

/// Compose the PATH value written into a scaffolded HQ's
/// `.claude/settings.json` `env.PATH`.
///
/// Claude Code's `env` block does a literal assignment with no `$PATH`
/// expansion and overrides the inherited environment for every hook and
/// subagent shell. The hq-core template historically shipped a
/// system-dirs-only value, so a fresh install whose only qmd/node/hq live in
/// the managed toolchain resolved none of them until setup.sh re-snapshotted
/// PATH on first Claude startup. Composing and writing the value at install
/// time closes that day-one gap.
///
/// Order: managed toolchain dirs first, then the user's login-shell PATH, then
/// whatever the template already listed, then a baseline of system dirs so the
/// result is safe even when the login-shell probe returns empty. Deduped, first
/// occurrence wins, empty segments dropped.
#[cfg(not(windows))]
pub fn composed_settings_env_path(
    home: &std::path::Path,
    login_path: &str,
    existing: Option<&str>,
) -> String {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let mut push = |segment: &str| {
        if !segment.is_empty() && seen.insert(segment.to_string()) {
            out.push(segment.to_string());
        }
    };
    for dir in managed_tool_paths_in(home) {
        push(&dir);
    }
    for seg in login_path.split(':') {
        push(seg);
    }
    if let Some(existing) = existing {
        for seg in existing.split(':') {
            push(seg);
        }
    }
    for seg in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(seg);
    }
    out.join(":")
}

/// Return `settings_json` with `.env.PATH` set to `new_path`, preserving every
/// other key. Creates the `env` object when absent. Errors when the document
/// is not a JSON object.
pub fn settings_json_with_env_path(settings_json: &str, new_path: &str) -> Result<String, String> {
    let mut doc: serde_json::Value = serde_json::from_str(settings_json)
        .map_err(|e| format!("settings.json is not valid JSON: {e}"))?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;
    let env = obj
        .entry("env")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let env_obj = env
        .as_object_mut()
        .ok_or_else(|| "settings.json 'env' is not an object".to_string())?;
    env_obj.insert(
        "PATH".to_string(),
        serde_json::Value::String(new_path.to_string()),
    );
    let mut rendered = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("failed to serialize settings.json: {e}"))?;
    rendered.push('\n');
    Ok(rendered)
}

/// The result of writing the composed managed-toolchain PATH into the winning
/// `.claude` settings file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SettingsPathWriteOutcome {
    /// Wrote the composed PATH into this settings file.
    Wrote(PathBuf),
    /// No settings file to write into (the target file is absent). A skip, not an
    /// error, so an already-installed machine without a base settings.json is not
    /// treated as a failure.
    Skipped(String),
}

/// Compose the managed-toolchain-first PATH and write it into the `.claude`
/// settings file the resolver actually READS for `hq_root` — settings.local.json
/// when it defines a non-empty `env.PATH`, else settings.json — resolved through
/// the single source of truth [`hq_desktop_core::paths::winning_settings_path_file`].
///
/// Unix composes the managed dirs, login-shell PATH and existing entries;
/// Windows composes its managed toolchain dirs with the native `;` separator.
/// Both paths update only the file selected by the resolver's shared winning-file
/// rule, so a stale foreign copy cannot continue shadowing the managed CLI.
///
/// Reuses the existing staged-sibling + [`atomic_replace_file`] so a partial
/// write is impossible, and canonicalizes the resolved file to require it stay
/// inside the resolved HQ folder — a symlinked settings file cannot redirect the
/// write outside the HQ tree. Pure enough to unit-test with a tempdir HQ root and
/// home (no `AppHandle`).
pub(crate) fn write_managed_toolchain_settings_path(
    hq_root: &Path,
    home: &Path,
    login_path: &str,
) -> Result<SettingsPathWriteOutcome, String> {
    #[cfg(windows)]
    let _ = (home, login_path);

    let file = match hq_desktop_core::paths::winning_settings_path_file(hq_root) {
        hq_desktop_core::paths::SettingsPathFile::Local => "settings.local.json",
        // Base or None both write the generated base file, exactly as before the
        // fix: the reader consults settings.json in both cases.
        hq_desktop_core::paths::SettingsPathFile::Base
        | hq_desktop_core::paths::SettingsPathFile::None => "settings.json",
    };
    let settings_path = hq_root.join(".claude").join(file);
    let contents = match std::fs::read_to_string(&settings_path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(SettingsPathWriteOutcome::Skipped(format!(
                "no {file} at {} - skipped ({e})",
                settings_path.display()
            )));
        }
    };

    // Canonicalization guard: the file exists (we just read it), so canonicalize
    // it — a symlink resolves to its true location — and require it to stay inside
    // the resolved HQ folder. A settings file symlinked out of the HQ tree is
    // refused rather than followed, so the write cannot clobber an unrelated file.
    let canonical_root = std::fs::canonicalize(hq_root)
        .map_err(|e| format!("cannot canonicalize HQ folder {}: {e}", hq_root.display()))?;
    let canonical_file = std::fs::canonicalize(&settings_path)
        .map_err(|e| format!("cannot canonicalize {}: {e}", settings_path.display()))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(format!(
            "refusing to write settings PATH outside the HQ folder: {} is not within {}",
            canonical_file.display(),
            canonical_root.display()
        ));
    }

    let existing_env_path = serde_json::from_str::<serde_json::Value>(&contents)
        .ok()
        .and_then(|v| v.get("env")?.get("PATH")?.as_str().map(|s| s.to_string()));
    #[cfg(not(windows))]
    let composed = composed_settings_env_path(home, login_path, existing_env_path.as_deref());
    #[cfg(windows)]
    let composed = hq_desktop_core::paths::compose_windows_settings_env_path(
        &hq_desktop_core::paths::managed_toolchain_roots(),
        existing_env_path.as_deref(),
    );
    let updated = settings_json_with_env_path(&contents, &composed)?;

    let staged = unique_sibling_path(&settings_path, "pathfix")?;
    std::fs::write(&staged, &updated)
        .map_err(|e| format!("failed to stage {}: {e}", staged.display()))?;
    if let Err(e) = atomic_replace_file(&staged, &settings_path) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    Ok(SettingsPathWriteOutcome::Wrote(settings_path))
}

/// Write the composed toolchain PATH into the winning `.claude` settings file
/// (settings.local.json when it defines env.PATH, else settings.json) and
/// re-ensure the shell-profile PATH block.
///
/// Invoked by the setup orchestrator after the deps stage on every installer
/// pass, including reinstalls where all deps are already present. A missing
/// target settings file is a skip rather than an error.
#[cfg(not(windows))]
#[tauri::command]
pub async fn configure_claude_settings_path(
    app: AppHandle,
    hq_path: String,
) -> Result<String, String> {
    let home = home_dir_or_err(&app, "path")?;
    ensure_shell_path_configured(&home, &app);

    match write_managed_toolchain_settings_path(Path::new(&hq_path), &home, shell_login_path()) {
        Ok(SettingsPathWriteOutcome::Wrote(path)) => {
            let msg = format!("[path] wrote managed toolchain PATH into {}", path.display());
            emit_preflight_line(&app, &msg);
            Ok(msg)
        }
        Ok(SettingsPathWriteOutcome::Skipped(reason)) => {
            let msg = format!("[path] {reason}");
            emit_preflight_line(&app, &msg);
            Ok(msg)
        }
        Err(e) => Err(e),
    }
}

/// Windows no-op. The managed toolchain dirs land on the user PATH via the
/// registry there, which hooks and subagents inherit directly.
#[cfg(windows)]
#[tauri::command]
pub async fn configure_claude_settings_path(
    _app: AppHandle,
    _hq_path: String,
) -> Result<String, String> {
    Ok("[path] skipped - PATH is registry-managed on Windows".to_string())
}

/// Internal implementation shared by `check_dep` (uses real PATH) and
/// `check_dep_in` (uses a caller-supplied search path — useful for tests).
/// True when `(tool, bin_path)` is the macOS `/usr/bin/git` CLT shim. Pure so
/// the path classification is unit-tested without filesystem/xcode-select; the
/// caller layers the CLT-presence check on top to decide "usable or not".
#[cfg(not(windows))]
pub fn is_macos_git_shim(tool: &str, bin_path: &std::path::Path) -> bool {
    tool == "git" && bin_path == std::path::Path::new("/usr/bin/git")
}

#[cfg(not(windows))]
pub fn check_dep_impl(tool: &str, search_path: Option<&str>) -> DepStatus {
    // Locate the binary.
    let cwd = std::env::current_dir().unwrap_or_default();
    let bin_path = match search_path {
        Some(p) => which::which_in(tool, Some(p), cwd),
        // GUI apps inherit a minimal PATH — extend with common install dirs.
        None => which::which_in(tool, Some(extended_search_path()), cwd),
    };

    let bin_path = match bin_path {
        Ok(p) => p,
        Err(_) => {
            return DepStatus {
                installed: false,
                version: None,
                path: None,
            }
        }
    };

    // macOS ships a non-functional `git` shim at /usr/bin/git that forwards to
    // the Xcode Command Line Tools. With no CLT installed it can't run git — it
    // errors and pops the "install developer tools" dialog. Treat it as NOT
    // installed so the managed (dugite) git gets provisioned instead. Detected
    // via path + `xcode-select -p` so we never RUN the shim (running it is what
    // pops the dialog). Once the toolchain git is installed, which_in resolves
    // to it first (toolchain is ahead of /usr/bin), so this guard stops firing.
    if is_macos_git_shim(tool, &bin_path) {
        let clt_present = Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !clt_present {
            return DepStatus {
                installed: false,
                version: None,
                path: None,
            };
        }
    }

    // Run `<tool> --version` and capture the first line of stdout.
    //
    // PATH is set to the same search path used to locate the tool: npm-global
    // bins (qmd, hq, claude) are `#!/usr/bin/env node` scripts, and a GUI
    // app's minimal PATH has no node, so the probe used to report
    // `version: None` for a perfectly healthy qmd. A non-zero exit is a
    // FAILED probe — a leftover stub that prints and exits 97 must not be
    // mistaken for a working tool (install matrix `stale-toolchain`, 2026-09-03).
    let probe_path = search_path
        .map(str::to_owned)
        .unwrap_or_else(extended_search_path);
    let version = Command::new(&bin_path)
        .arg("--version")
        .env("PATH", probe_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                // Prefer stdout; fall back to stderr (e.g. git)
                let raw = if !out.stdout.is_empty() {
                    out.stdout
                } else {
                    out.stderr
                };
                String::from_utf8(raw)
                    .ok()
                    .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                    .filter(|s| !s.is_empty())
            } else {
                None
            }
        });

    DepStatus {
        installed: true,
        version,
        path: Some(bin_path),
    }
}

/// Probe whether `tool` is available on PATH.
///
/// Uses `which` to locate the binary then runs `<tool> --version` to capture
/// the version string.  Returns a `DepStatus` that is safe to serialise and
/// send to the frontend.
#[tauri::command]
pub fn check_dep(tool: String) -> DepStatus {
    check_dep_impl(&tool, None)
}

/// Same as `check_dep` but searches only within `path_dirs`.
///
/// Exposed for hermetic unit tests so they don't need to mutate `PATH`.
#[cfg(not(windows))]
pub fn check_dep_in(tool: &str, path_dirs: &str) -> DepStatus {
    check_dep_impl(tool, Some(path_dirs))
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel_install
// ─────────────────────────────────────────────────────────────────────────────

/// Set the cancel flag for the given handle.
///
/// Returns `true` if the handle was registered (i.e. an install was in
/// progress), `false` otherwise.
#[tauri::command]
pub fn cancel_install(handle: String) -> bool {
    let mut reg = recover_lock(cancel_registry());
    let Some(state) = reg.get_mut(&handle) else {
        return false;
    };
    state.cancelled = true;
    drop(reg);

    #[cfg(unix)]
    if let Err(e) = terminate_process_tree(&handle, Signal::SIGTERM) {
        record_cleanup_failure(&handle, e);
    }
    #[cfg(windows)]
    if let Err(e) = terminate_process_tree(&handle) {
        record_cleanup_failure(&handle, e);
    }

    true
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal streaming helper
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn `program` with `args`, stream stdout line-by-line as
/// `install:progress` events, and respect the cancel flag.
///
/// Both stdout and stderr are drained concurrently:
///   - stdout lines are forwarded verbatim as progress events.
///   - stderr lines are forwarded as progress events AND retained so the
///     final error message carries actual context. Many installers (npm,
///     brew) write EACCES / registry / post-install-script failures to
///     stderr, not stdout — without draining stderr the installer just
///     said "exit code 1" and the user was stuck.
///   - Draining stderr in a thread also prevents the child from blocking
///     on a full stderr pipe (macOS default pipe buffer is 32 KB).
///
/// The spawned child inherits `PATH = extended_search_path()` so that any
/// sub-tools invoked by the installer (npm post-install scripts reaching
/// for `node`, `git`, `python3`, etc.) can be resolved from the full set
/// of macOS locations a GUI-launched Tauri app does NOT inherit.
///
/// Returns `Ok(handle)` on success or `Err(message)` on failure.
fn setup_npm_command(program: &str, search_path: &str, npm_cache: &Path, args: &[&str]) -> Command {
    let owned_args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    crate::commands::hq_cli_update::npm_install_command(
        program,
        search_path,
        npm_cache,
        &owned_args,
    )
}

#[cfg(not(windows))]
async fn run_streaming<R: tauri::Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    run_streaming_with_npm_cache(app, program, args, None).await
}

#[cfg(not(windows))]
async fn run_streaming_with_npm_cache<R: tauri::Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
    npm_cache: Option<&Path>,
) -> Result<String, String> {
    let setup_run_id = current_setup_run_id();
    let handle_id = Uuid::new_v4().to_string();
    register_cancel_handle(handle_id.clone());

    let mut command = if let Some(npm_cache) = npm_cache {
        setup_npm_command(program, &extended_search_path(), npm_cache, args)
    } else {
        let mut command = Command::new(program);
        command.args(args).env("PATH", extended_search_path());
        command
    };
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            deregister_handle(&handle_id);
            let error = format!("Failed to spawn '{}': {}", program, e);
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };
    register_process_group(&handle_id, child.id() as i32);
    emit_install_handle_started(app, &handle_id);

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            deregister_handle(&handle_id);
            let error = "no stdout".to_string();
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            deregister_handle(&handle_id);
            let error = "no stderr".to_string();
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };

    enum ReaderMsg {
        Stdout(String),
        Stderr,
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    // Drain stderr in a background thread — see the function doc above for why.
    let stdout_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let (tx, rx) = mpsc::channel::<ReaderMsg>();
    let stdout_thread = {
        let tx = tx.clone();
        let stdout_tail = Arc::clone(&stdout_tail);
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stdout).lines() {
                match line_result {
                    Ok(line) => {
                        append_setup_diagnostic_tail(&mut recover_lock(&stdout_tail), &line);
                        if tx.send(ReaderMsg::Stdout(line)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stdout",
                err,
            });
        })
    };
    let stderr_thread = {
        let app = app.clone();
        let handle_id = handle_id.clone();
        let setup_run_id = setup_run_id.clone();
        let stderr_lines = Arc::clone(&stderr_lines);
        let stderr_tail = Arc::clone(&stderr_tail);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stderr).lines() {
                match line_result {
                    Ok(line) => {
                        recover_lock(&stderr_lines).push(line.clone());
                        append_setup_diagnostic_tail(&mut recover_lock(&stderr_tail), &line);
                        let _ = app.emit(
                            "install:progress",
                            InstallProgress {
                                setup_run_id: setup_run_id.clone(),
                                handle: handle_id.clone(),
                                line: line.clone(),
                                finished: false,
                                error: None,
                            },
                        );
                        if tx.send(ReaderMsg::Stderr).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stderr",
                err,
            });
        })
    };
    drop(tx);

    let mut done_count = 0;
    let mut first_stream_err: Option<String> = None;
    let mut status = None;
    let mut cancel_started: Option<Instant> = None;
    let mut sigkill_sent = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(ReaderMsg::Stdout(line)) => {
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        setup_run_id: current_setup_run_id(),
                        handle: handle_id.clone(),
                        line,
                        finished: false,
                        error: None,
                    },
                );
            }
            Ok(ReaderMsg::Stderr) => {}
            Ok(ReaderMsg::Done { stream, err }) => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{stream}: {e}"));
                    }
                }
                done_count += 1;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if is_cancelled(&handle_id) {
            if cancel_started.is_none() {
                if let Err(e) = terminate_process_tree(&handle_id, Signal::SIGTERM) {
                    record_cleanup_failure(&handle_id, e);
                }
                cancel_started = Some(Instant::now());
            } else if !sigkill_sent
                && cancel_started
                    .map(|started| started.elapsed() >= Duration::from_secs(2))
                    .unwrap_or(false)
            {
                if let Err(e) = terminate_process_tree(&handle_id, Signal::SIGKILL) {
                    record_cleanup_failure(&handle_id, e);
                }
                sigkill_sent = true;
            }

            if let Some(cleanup) = cleanup_failure(&handle_id) {
                // Do not wait for `try_wait` or the output readers. A failed
                // signal can be exactly what leaves this child running.
                record_install_cancellation(InstallCancellation::CleanupFailed(cleanup));
            }
        }

        if status.is_none() {
            status = child.try_wait().map_err(|e| e.to_string())?;
        }
        if status.is_some() && done_count >= 2 {
            break;
        }
        if done_count >= 2 && status.is_none() {
            status = Some(child.wait().map_err(|e| e.to_string())?);
            break;
        }
    }

    let status = match status {
        Some(status) => status,
        None => child.wait().map_err(|e| e.to_string())?,
    };

    let stdout_join = stdout_thread
        .join()
        .map_err(|_| "stdout reader thread panicked".to_string());
    let stderr_join = stderr_thread
        .join()
        .map_err(|_| "stderr reader thread panicked".to_string());

    let was_cancelled = is_cancelled(&handle_id);
    let cleanup_failure = take_cleanup_failure(&handle_id);
    deregister_handle(&handle_id);

    if let Err(e) = stdout_join.and(stderr_join) {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }

    if was_cancelled {
        let cancellation = cleanup_failure
            .map(InstallCancellation::CleanupFailed)
            .unwrap_or(InstallCancellation::UserCancelled);
        record_install_cancellation(cancellation.clone());
        let msg = cancellation.user_message();
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    if let Some(err) = first_stream_err {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

    if status.success() {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: None,
            },
        );
        Ok(handle_id)
    } else {
        let code = status.code().unwrap_or(-1);
        let stdout = recover_lock(&stdout_tail).clone();
        let captured = recover_lock(&stderr_lines).clone();
        let stderr = recover_lock(&stderr_tail).clone();
        let msg = format_install_error(code, &captured);
        let user_msg = hq_desktop_core::installer_disk_space::user_facing_install_error(
            program, &stderr, &msg,
        );
        record_setup_command_failure(program, args, Some(code), stdout, stderr, msg.clone());
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(user_msg.clone()),
            },
        );
        Err(user_msg)
    }
}

/// Emit a single progress line to the frontend before a preflight check
/// rejects the install.
///
/// The DepsInstall screen routes `install:progress` lines into the active
/// tool's terminal panel by `activeToolRef`, not by handle — so emitting here
/// surfaces useful context in the UI even though no real process ever ran.
/// Without this, `install_node` / `install_gh` return a bare `Err(…)` and
/// the panel is empty: the user sees "Installation failed" with no clue why.
///
/// Only the macOS install path emits preflight lines; the Windows installers
/// surface their own progress, so this is `#[cfg(not(windows))]` to avoid a
/// dead-code warning on Windows.
#[cfg(not(windows))]
fn emit_preflight_line<R: tauri::Runtime>(app: &AppHandle<R>, msg: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            setup_run_id: current_setup_run_id(),
            handle: "preflight".to_string(),
            line: msg.to_string(),
            finished: false,
            error: None,
        },
    );
}

/// Format a human-friendly error message from an exit code plus the stderr
/// lines captured by `run_streaming`. Keeps the last few non-empty lines so
/// the UI stays readable when tools dump multi-KB of output.
///
/// Exposed for unit tests; no Tauri runtime needed.
pub fn format_install_error(exit_code: i32, stderr_lines: &[String]) -> String {
    let mut tail: Vec<String> = stderr_lines
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(5)
        .cloned()
        .collect();
    tail.reverse();
    if tail.is_empty() {
        format!("Process exited with code {}", exit_code)
    } else {
        format!(
            "Process exited with code {}: {}",
            exit_code,
            tail.join(" | ")
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// install_homebrew
// ─────────────────────────────────────────────────────────────────────────────

/// Install Homebrew using the official curl-pipe-bash installer.
///
/// The canonical Homebrew install command is:
///   `/bin/bash -c "$(curl -fsSL https://.../install.sh)"`
///
/// That relies on a *parent* shell to evaluate `$(curl …)` before invoking
/// `/bin/bash -c`. When we spawn `/bin/bash -c …` directly from Rust there
/// is no parent shell: the substitution happens inside bash itself, but the
/// resulting script text is then a bare quoted-string expression — not a
/// command — and bash tries to exec the first word (`#!/bin/bash`), producing
/// "No such file or directory".
///
/// The nested form below restores the two-shell semantics: the *outer* bash
/// evaluates `"$(curl …)"` and hands the expanded script to the *inner*
/// `bash -c` for execution. `NONINTERACTIVE=1` is set so the installer
/// skips the "press RETURN to continue" prompt that would otherwise hang
/// silently in our Stdio::piped setup.
///
/// Returns the install handle so the frontend can correlate progress events.
#[cfg(not(windows))]
#[tauri::command]
pub async fn install_homebrew(app: AppHandle) -> Result<String, String> {
    run_streaming(
        &app,
        "/bin/bash",
        &[
            "-c",
            r#"NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#,
        ],
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_node
// ─────────────────────────────────────────────────────────────────────────────

/// `node --version` output of an on-disk managed node, or `None` if it does
/// not run / exits non-zero. Pure over the given path; exposed for testing.
#[cfg(not(windows))]
pub fn managed_node_reported_version(node_bin: &std::path::Path) -> Option<String> {
    let out = Command::new(node_bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// macOS setup npm installs must use the Node/npm pair from HQ's pinned
/// toolchain. A system Node can meet the broad runtime floor while remaining
/// too old for the system npm that happens to be on PATH.
#[cfg(not(windows))]
fn managed_node_toolchain_is_usable(home: &std::path::Path) -> bool {
    let Some(expected_arch) = node_dist_arch_for(std::env::consts::ARCH) else {
        return false;
    };
    let node = managed_node_bin_in(home).join("node");
    let npm = managed_node_bin_in(home).join("npm");
    if !node.is_file()
        || !managed_node_reported_version(&node)
            .is_some_and(|version| version.trim() == MANAGED_NODE_VERSION)
        || !hq_desktop_core::toolchain::node_binary_has_arch(&node, expected_arch)
        || !npm.is_file()
    {
        return false;
    }

    let mut child = match Command::new(npm)
        .arg("--version")
        .env("PATH", extended_search_path_in(Some(home)))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Install Node.js into HQ's user-local managed toolchain.
///
/// The installer used to require Homebrew here, which stranded fresh Macs
/// where the first user was not an Administrator. Node/npm/npx do not require
/// a system package manager, so we download the official darwin tarball into:
/// `~/Library/Application Support/Indigo HQ/toolchain/node`.
#[cfg(not(windows))]
async fn install_node_macos<R: tauri::Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let home = home_dir_or_err(&app, "node")?;
    let toolchain_dir = managed_toolchain_dir_in(&home);
    let node_dir = managed_node_dir_in(&home);
    let node_bin = managed_node_bin_in(&home).join("node");

    if managed_node_toolchain_is_usable(&home) {
        emit_preflight_line(
            &app,
            &format!(
                "[node] managed Node {} and bundled npm already present at {}",
                MANAGED_NODE_VERSION,
                node_bin.display()
            ),
        );
        return Ok(format!("node already installed at {}", node_bin.display()));
    }
    if node_dir.exists() {
        emit_preflight_line(
            &app,
            &format!(
                "[node] managed Node/npm toolchain at {} is incomplete or unusable — re-provisioning {}",
                node_dir.display(),
                MANAGED_NODE_VERSION
            ),
        );
        if let Err(e) = std::fs::remove_dir_all(&node_dir) {
            let msg = format!(
                "[node] failed to remove stale toolchain {}: {e}",
                node_dir.display()
            );
            emit_preflight_line(&app, &msg);
            return Err(msg);
        }
    }

    let arch = std::env::consts::ARCH;
    let Some(url) = managed_node_url_for(arch) else {
        let msg = format!(
            "[node] unsupported arch '{}' — cannot install managed Node",
            arch
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };
    let Some(expected_sha) = managed_node_sha256_for(arch) else {
        let msg = format!("[node] no pinned checksum for arch '{arch}'");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };

    if let Err(e) = std::fs::create_dir_all(&toolchain_dir) {
        let msg = format!(
            "[node] failed to create toolchain dir {}: {e}",
            toolchain_dir.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let archive = toolchain_dir.join(format!(
        ".node-{MANAGED_NODE_VERSION}-darwin.{}.tar.gz.tmp",
        Uuid::new_v4()
    ));
    let archive_str = archive.to_string_lossy().into_owned();
    let staged_dir = toolchain_dir.join(format!(".node-install-{}", Uuid::new_v4()));
    let staged_bin = staged_dir.join("bin").join("node");
    let staged_dir_str = staged_dir.to_string_lossy().into_owned();

    emit_preflight_line(
        &app,
        &format!("[node] downloading {url} → {}", archive.display()),
    );
    run_streaming(&app, "/usr/bin/curl", &["-fsSL", "-o", &archive_str, &url]).await?;

    let check_path = toolchain_dir.join(format!(".node-{MANAGED_NODE_VERSION}.sha256"));
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {archive_str}\n")) {
        let _ = std::fs::remove_file(&archive);
        let msg = format!("[node] failed to write checksum file: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, "[node] verifying checksum");
    if let Err(e) = run_streaming(&app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[node] checksum verification failed: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    if let Err(e) = std::fs::create_dir_all(&staged_dir) {
        let _ = std::fs::remove_file(&archive);
        let msg = format!("[node] failed to create staging dir: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        &app,
        &format!("[node] extracting to {}", staged_dir.display()),
    );
    run_streaming(
        &app,
        "/usr/bin/tar",
        &[
            "-xzf",
            &archive_str,
            "-C",
            &staged_dir_str,
            "--strip-components",
            "1",
        ],
    )
    .await?;
    let _ = std::fs::remove_file(&archive);

    if !staged_bin.exists() {
        let _ = std::fs::remove_dir_all(&staged_dir);
        let msg = format!(
            "[node] install completed but node binary was not found at {}",
            staged_bin.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    if !staged_dir.join("bin").join("npm").is_file() {
        let _ = std::fs::remove_dir_all(&staged_dir);
        let msg = format!(
            "[node] install completed but bundled npm was not found at {}",
            staged_dir.join("bin").join("npm").display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let output = Command::new(&staged_bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("[node] failed to run staged node --version: {e}"))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || version != MANAGED_NODE_VERSION {
        let _ = std::fs::remove_dir_all(&staged_dir);
        let msg = format!(
            "[node] staged node version check failed: expected {MANAGED_NODE_VERSION}, got '{version}'"
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    activate_staged_dir(&staged_dir, &node_dir).map_err(|e| {
        let msg = format!("[node] failed to activate staged Node install: {e}");
        emit_preflight_line(&app, &msg);
        msg
    })?;

    Ok(format!("node installed at {}", node_bin.display()))
}


// ─────────────────────────────────────────────────────────────────────────────
// install_git
// ─────────────────────────────────────────────────────────────────────────────

/// Install git via `brew install git`.
#[cfg(not(windows))]
async fn install_git_macos(app: AppHandle) -> Result<String, String> {
    let home = home_dir_or_err(&app, "git")?;
    let toolchain_dir = managed_toolchain_dir_in(&home);
    let git_dir = managed_git_dir_in(&home);
    let git_bin = managed_git_bin_in(&home).join("git");

    if git_bin.exists() {
        emit_preflight_line(
            &app,
            &format!("[git] managed Git already present at {}", git_bin.display()),
        );
        return Ok(format!("git already installed at {}", git_bin.display()));
    }

    let arch = std::env::consts::ARCH;
    let Some(url) = managed_git_url_for(arch) else {
        let msg = format!("[git] unsupported arch '{arch}' — cannot install managed Git");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };
    let Some(expected_sha) = managed_git_sha256_for(arch) else {
        let msg = format!("[git] no pinned checksum for arch '{arch}'");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };

    if let Err(e) = std::fs::create_dir_all(&git_dir) {
        let msg = format!("[git] failed to create {}: {e}", git_dir.display());
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let archive = toolchain_dir.join("dugite-git.tar.gz");
    let archive_str = archive.to_string_lossy().into_owned();
    let git_dir_str = git_dir.to_string_lossy().into_owned();

    emit_preflight_line(
        &app,
        &format!(
            "[git] downloading portable Git {url} → {}",
            archive.display()
        ),
    );
    run_streaming(&app, "/usr/bin/curl", &["-fsSL", "-o", &archive_str, &url]).await?;

    // Verify SHA-256 before trusting a binary we put on PATH. `shasum -c` exits
    // non-zero on mismatch, which run_streaming surfaces as Err. The checksum
    // file uses the archive's absolute path so cwd doesn't matter.
    let check_path = toolchain_dir.join("dugite-git.sha256");
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {archive_str}\n")) {
        let msg = format!("[git] failed to write checksum file: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, "[git] verifying checksum");
    if let Err(e) = run_streaming(&app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[git] checksum verification failed: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    // dugite tarballs extract flat (bin/, libexec/, share/ at the root), so no
    // --strip-components — git lands at <git_dir>/bin/git.
    emit_preflight_line(&app, &format!("[git] extracting to {}", git_dir.display()));
    run_streaming(
        &app,
        "/usr/bin/tar",
        &["-xzf", &archive_str, "-C", &git_dir_str],
    )
    .await?;
    let _ = std::fs::remove_file(&archive);

    if !git_bin.exists() {
        let msg = format!(
            "[git] install completed but git binary not found at {}",
            git_bin.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        &app,
        &format!("[git] portable Git installed at {}", git_bin.display()),
    );
    Ok(format!("git installed at {}", git_bin.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_gh
// ─────────────────────────────────────────────────────────────────────────────

/// Install the GitHub CLI via `brew install gh`.
#[cfg(not(windows))]
async fn install_gh_macos(app: AppHandle) -> Result<String, String> {
    let brew = match which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "GitHub CLI is optional. Install Homebrew later if you want hq-installer to add gh automatically.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "gh"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_yq
// ─────────────────────────────────────────────────────────────────────────────

/// Pinned `mikefarah/yq` version for the binary fallback. Matches what
/// Homebrew was shipping at the time this fallback was added; bump alongside
/// installer releases so support reproductions stay deterministic.
#[cfg(not(windows))]
const YQ_BINARY_VERSION: &str = "v4.53.2";
#[cfg(not(windows))]
const YQ_BINARY_SHA256_AMD64: &str =
    "616b0a0f6a5b79d746f05a169c2b9bb40dee00c605ef165b9a1c1681bba738ac";
#[cfg(not(windows))]
const YQ_BINARY_SHA256_ARM64: &str =
    "541ba2287560df70f561955e2d7f7e1cd00cf2a15a884f6b5c87a4bfa887bc07";

#[cfg(not(windows))]
fn yq_binary_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "amd64" => Some(YQ_BINARY_SHA256_AMD64),
        "arm64" => Some(YQ_BINARY_SHA256_ARM64),
        _ => None,
    }
}

/// Install yq.
///
/// Strategy: try `brew install yq` first, fall back to a direct binary
/// download from `mikefarah/yq`'s GitHub releases when brew fails or is
/// missing.
///
/// **Why the fallback exists:** the Homebrew formula declares `pandoc` as a
/// build-time dep (just for the man page). On macOS configs without prebuilt
/// bottles available (Tier 2/3 — older OS, outdated Command Line Tools),
/// brew falls through to building pandoc from source, which drags in
/// `cabal-install` + `ghc` and fails. yq itself is a single static Go
/// binary, so we sidestep the Haskell toolchain by grabbing the prebuilt
/// asset directly.
///
/// The fallback writes to `~/.local/bin/yq`, which is already on
/// `extended_search_path()` — the post-install `which yq` check picks it up
/// without PATH wiring. No sudo required.
///
/// Required by the Workspace integrity scripts (compute-checksums.sh,
/// core-integrity.sh) that read/write scripts/core.yaml.
#[cfg(not(windows))]
async fn install_yq_macos(app: AppHandle) -> Result<String, String> {
    if let Ok(brew) = which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        let brew_str = brew.to_str().unwrap_or("brew").to_string();
        match run_streaming(&app, &brew_str, &["install", "yq"]).await {
            Ok(out) => return Ok(out),
            Err(brew_err) => {
                let first_line = brew_err.lines().next().unwrap_or("error");
                emit_preflight_line(
                    &app,
                    &format!(
                        "[yq] brew install failed ({first_line}); falling back to direct binary download"
                    ),
                );
                clear_recovered_setup_command_failure();
            }
        }
    } else {
        emit_preflight_line(
            &app,
            "[yq] Homebrew not found; installing via direct binary download",
        );
    }

    install_yq_via_binary(&app).await
}

/// Download `mikefarah/yq`'s prebuilt darwin binary into `~/.local/bin/yq`.
///
/// `~/.local/bin` is already part of `extended_search_path()` (see the
/// `extras` block there), so the installer's existing `which yq` probe picks
/// the binary up the same way it would a brew-installed yq. No sudo, no
/// PATH wiring on the user's side.
#[cfg(not(windows))]
async fn install_yq_via_binary(app: &AppHandle) -> Result<String, String> {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => {
            let msg =
                format!("[yq] unsupported arch '{other}' — cannot install yq via binary fallback");
            emit_preflight_line(app, &msg);
            return Err(msg);
        }
    };
    let Some(expected_sha) = yq_binary_sha256_for(arch) else {
        let msg = format!("[yq] no pinned checksum for arch '{arch}'");
        emit_preflight_line(app, &msg);
        return Err(msg);
    };

    let url = format!(
        "https://github.com/mikefarah/yq/releases/download/{YQ_BINARY_VERSION}/yq_darwin_{arch}"
    );

    let Some(home) = dirs::home_dir() else {
        let msg = "[yq] could not resolve home directory".to_string();
        emit_preflight_line(app, &msg);
        return Err(msg);
    };
    let bin_dir = home.join(".local").join("bin");
    let target = bin_dir.join("yq");
    let staged = bin_dir.join(format!(".yq.{}.tmp", Uuid::new_v4()));

    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        let msg = format!("[yq] failed to create {}: {e}", bin_dir.display());
        emit_preflight_line(app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        app,
        &format!("[yq] downloading {url} → {}", staged.display()),
    );

    let staged_str = staged.to_string_lossy().into_owned();

    // curl flags: -f fails on HTTP error (so a 404 surfaces instead of
    // writing an HTML error page to disk and chmod'ing it +x), -sS keeps
    // the progress bar quiet but still emits errors to stderr (which
    // `run_streaming` captures), -L follows redirects (GitHub redirects
    // release assets to S3).
    run_streaming(app, "curl", &["-fsSL", "-o", &staged_str, &url]).await?;

    let check_path = bin_dir.join(format!(".yq-{YQ_BINARY_VERSION}.sha256"));
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {staged_str}\n")) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!("[yq] failed to write checksum file: {e}");
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    emit_preflight_line(app, "[yq] verifying checksum");
    if let Err(e) = run_streaming(app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&staged);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[yq] checksum verification failed: {e}");
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    run_streaming(app, "chmod", &["+x", &staged_str]).await?;

    let output = Command::new(&staged)
        .arg("--version")
        .output()
        .map_err(|e| format!("[yq] failed to run staged yq --version: {e}"))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !combined.contains(YQ_BINARY_VERSION) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!(
            "[yq] staged yq version check failed: expected {YQ_BINARY_VERSION}, got '{}'",
            combined.lines().next().unwrap_or("").trim()
        );
        emit_preflight_line(app, &msg);
        return Err(msg);
    }

    atomic_replace_file(&staged, &target).map_err(|e| {
        let msg = format!("[yq] failed to activate staged binary: {e}");
        emit_preflight_line(app, &msg);
        msg
    })?;

    Ok(format!("yq installed at {}", target.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_jq (direct binary, macOS)
// ─────────────────────────────────────────────────────────────────────────────

/// Pinned `jqlang/jq` release. HQ's hooks and `core/scripts/setup.sh` require
/// jq; Sonoma ships none (Tahoe does), so a fresh Sonoma Mac failed setup.sh
/// right after a reported-OK dependency install (install matrix, 2026-09-03).
#[cfg(not(windows))]
const JQ_BINARY_VERSION: &str = "jq-1.8.2";
#[cfg(not(windows))]
const JQ_BINARY_SHA256_AMD64: &str =
    "e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0";
#[cfg(not(windows))]
const JQ_BINARY_SHA256_ARM64: &str =
    "2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e";

#[cfg(not(windows))]
async fn install_jq_macos(app: AppHandle) -> Result<String, String> {
    let (arch, expected_sha) = match std::env::consts::ARCH {
        "aarch64" => ("arm64", JQ_BINARY_SHA256_ARM64),
        "x86_64" => ("amd64", JQ_BINARY_SHA256_AMD64),
        other => {
            let msg = format!("[jq] unsupported arch '{other}' — cannot install jq");
            emit_preflight_line(&app, &msg);
            return Err(msg);
        }
    };
    let url = format!(
        "https://github.com/jqlang/jq/releases/download/{JQ_BINARY_VERSION}/jq-macos-{arch}"
    );
    let Some(home) = dirs::home_dir() else {
        let msg = "[jq] could not resolve home directory".to_string();
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };
    let bin_dir = home.join(".local").join("bin");
    let target = bin_dir.join("jq");
    let staged = bin_dir.join(format!(".jq.{}.tmp", Uuid::new_v4()));
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        let msg = format!("[jq] failed to create {}: {e}", bin_dir.display());
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, &format!("[jq] downloading {url} → {}", staged.display()));
    let staged_str = staged.to_string_lossy().into_owned();
    run_streaming(&app, "curl", &["-fsSL", "-o", &staged_str, &url]).await?;

    let check_path = bin_dir.join(format!(".{JQ_BINARY_VERSION}.sha256"));
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {staged_str}\n")) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!("[jq] failed to write checksum file: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, "[jq] verifying checksum");
    if let Err(e) = run_streaming(&app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&staged);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[jq] checksum verification failed: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);
    run_streaming(&app, "chmod", &["+x", &staged_str]).await?;

    let output = Command::new(&staged)
        .arg("--version")
        .output()
        .map_err(|e| format!("[jq] failed to run staged jq --version: {e}"))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !combined.contains(JQ_BINARY_VERSION) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!(
            "[jq] staged jq version check failed: expected {JQ_BINARY_VERSION}, got '{}'",
            combined.lines().next().unwrap_or("").trim()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    atomic_replace_file(&staged, &target).map_err(|e| {
        let msg = format!("[jq] failed to activate staged binary: {e}");
        emit_preflight_line(&app, &msg);
        msg
    })?;
    Ok(format!("jq installed at {}", target.display()))
}

#[tauri::command]
pub async fn install_jq(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_jq_macos(app).await
    }
    #[cfg(windows)]
    {
        let _ = app;
        Err("jq is not provisioned by the Windows installer yet".to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// install_claude_code
// ─────────────────────────────────────────────────────────────────────────────

/// Install the Claude Code CLI via `npm install -g @anthropic-ai/claude-code`.
///
/// Errors if npm is not available.
#[cfg(not(windows))]
async fn install_claude_code_macos(app: AppHandle) -> Result<String, String> {
    let prefix = npm_global_prefix_arg(&app, "claude")?;
    if clear_unusable_npm_bin(std::path::Path::new(&prefix), "claude") {
        emit_preflight_line(&app, "[claude] removed an unusable leftover bin entry before reinstalling");
    }
    let npm = match which::which_in(
        "npm",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "npm is not installed. Install Node.js first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    npm_install_global_managed(
        &app,
        npm.to_str().unwrap_or("npm"),
        &prefix,
        "@anthropic-ai/claude-code",
        "@anthropic-ai/claude-code",
        "claude",
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_qmd
// ─────────────────────────────────────────────────────────────────────────────

/// Remove a bin entry under the managed npm-global prefix that npm did not
/// create (a plain file instead of npm's symlink into lib/node_modules, or a
/// dangling symlink). npm refuses with EEXIST to overwrite such a file, so a
/// stale stub left by a broken earlier install blocked every re-install
/// (install matrix `stale-toolchain`, 2026-09-03). Returns true if removed.
/// Pure over the given prefix; exposed for testing.
#[cfg(not(windows))]
pub fn clear_unusable_npm_bin(prefix: &std::path::Path, bin: &str) -> bool {
    let path = prefix.join("bin").join(bin);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return false;
    };
    let unusable = if meta.file_type().is_symlink() {
        std::fs::metadata(&path).is_err() // dangling
    } else {
        true // a real file: npm never writes those here
    };
    if unusable {
        let _ = std::fs::remove_file(&path);
    }
    unusable
}

/// Only registry/network-shaped npm failures justify retrying against the
/// public registry; EACCES, ENOSPC, or a broken node must surface as-is.
pub fn looks_like_registry_failure(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    ["enotfound", "eai_again", "econnrefused", "econnreset", "etimedout", "e404", "e403", "e401", "e502", "e503", "eproto", "cert", "registry", "proxy", "fetch failed", "network"]
        .iter()
        .any(|k| e.contains(k))
}

fn npm_package_name_from_spec(spec: &str) -> Option<String> {
    if spec.starts_with('/')
        || spec.starts_with('.')
        || spec.contains('\\')
        || spec.contains("://")
    {
        return None;
    }
    let end = if spec.starts_with('@') {
        spec[1..]
            .find('@')
            .map(|index| index + 1)
            .unwrap_or(spec.len())
    } else {
        spec.find('@').unwrap_or(spec.len())
    };
    let package_name = &spec[..end];
    (!package_name.is_empty() && package_name != "@").then(|| package_name.to_string())
}

pub(crate) fn npm_args_with_option(args: &[String], spec: &str, option: &str) -> Vec<String> {
    let mut retry = args.to_vec();
    let insert_at = retry
        .iter()
        .rposition(|arg| arg == spec)
        .unwrap_or(retry.len());
    retry.insert(insert_at, option.to_string());
    retry
}

/// Add the configured public-registry overrides before the final package spec.
/// Shared by setup installs and the HQ CLI updater so both recover from the
/// same stale or incomplete npm registry metadata.
pub(crate) fn npm_args_with_public_registry(args: &[String]) -> Vec<String> {
    let mut retry = args.to_vec();
    let insert_at = retry.len().saturating_sub(1);
    retry.splice(
        insert_at..insert_at,
        [
            "--registry=https://registry.npmjs.org/",
            "--@indigoai-us:registry=https://registry.npmjs.org/",
            "--@tobilu:registry=https://registry.npmjs.org/",
            "--@anthropic-ai:registry=https://registry.npmjs.org/",
            "--@openai:registry=https://registry.npmjs.org/",
            "--@xai-official:registry=https://registry.npmjs.org/",
        ]
        .into_iter()
        .map(str::to_string),
    );
    retry
}

const NPM_PACKAGE_LOOKUP_RETRY_BACKOFF_SECONDS: [u64; 3] = [30, 45, 75];
const NPM_RETRY_CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(250);

async fn sleep_for_npm_retry_or_cancelled<CheckCancelled>(
    delay: Duration,
    check_cancelled: &mut CheckCancelled,
) -> Result<(), String>
where
    CheckCancelled: FnMut() -> Result<(), String>,
{
    let deadline = tokio::time::Instant::now() + delay;
    loop {
        check_cancelled()?;
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        tokio::time::sleep(remaining.min(NPM_RETRY_CANCELLATION_POLL_INTERVAL)).await;
    }
}

/// Read npm's machine-stable resolution code from its output. The package name
/// is checked separately so a missing transitive or unrelated package cannot
/// arm retries for the requested global install.
fn npm_package_lookup_error_code(detail: &str) -> Option<&'static str> {
    detail.lines().find_map(|line| {
        let line = line.to_ascii_lowercase();
        let tokens = line.split_whitespace().collect::<Vec<_>>();
        let code = tokens
            .windows(2)
            .find_map(|pair| match pair {
                ["code", "e404"] => Some("E404"),
                ["code", "etarget"] => Some("ETARGET"),
                _ => None,
            });
        code.or_else(|| {
            let npm_error_line = line.contains("npm error ") || line.contains("npm err! ");
            let http_not_found = tokens
                .windows(2)
                .any(|pair| pair[0] == "404" && pair[1] == "not");
            (npm_error_line && http_not_found).then_some("E404")
        })
    })
}

fn npm_error_mentions_package(detail: &str, package_name: &str) -> bool {
    let normalized = detail
        .to_ascii_lowercase()
        .replace("%2f", "/")
        .replace("%40", "@");
    let package_name = package_name.to_ascii_lowercase();
    normalized.match_indices(&package_name).any(|(start, matched)| {
        let before_is_boundary = normalized[..start]
            .chars()
            .next_back()
            .map(|character| !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_' | '.'))
            .unwrap_or(true);
        let after_is_boundary = normalized[start + matched.len()..]
            .chars()
            .next()
            .map(|character| !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_' | '.'))
            .unwrap_or(true);
        before_is_boundary && after_is_boundary
    })
}

fn is_package_lookup_failure(detail: &str, package_name: &str) -> bool {
    npm_package_lookup_error_code(detail).is_some()
        && npm_error_mentions_package(detail, package_name)
}

/// Run one setup-path npm install and apply its narrowly classified recovery
/// policy. The runner and side effects are injected so retries can be tested
/// without a Tauri runtime or a real npm registry.
async fn run_setup_npm_install_with_retries<
    Run,
    RunFuture,
    Cleanup,
    Preflight,
    Clear,
    CheckCancelled,
>(
    run: &mut Run,
    cleanup: &mut Cleanup,
    preflight: &mut Preflight,
    clear_failure: &mut Clear,
    check_cancelled: &mut CheckCancelled,
    prefix: &str,
    windows_layout: bool,
    spec: &str,
    package_name: &str,
    tag: &str,
    base_args: Vec<String>,
    public_registry_args: Option<Vec<String>>,
) -> Result<String, String>
where
    Run: FnMut(Vec<String>) -> RunFuture,
    RunFuture: Future<Output = Result<String, String>>,
    Cleanup: FnMut(&Path, &str),
    Preflight: FnMut(String),
    Clear: FnMut(),
    CheckCancelled: FnMut() -> Result<(), String>,
{
    check_cancelled()?;
    let first_error = match run(base_args.clone()).await {
        Ok(output) => return Ok(output),
        Err(error) => error,
    };

    if crate::commands::hq_cli_update::is_partial_install_failure(&first_error) {
        let scope = crate::commands::hq_cli_update::npm_global_package_scope_dir_for(
            prefix,
            windows_layout,
            package_name,
        );
        preflight(format!(
            "[{tag}] npm reported ENOTEMPTY for {package_name}; cleaning {} and retrying once",
            scope.display()
        ));
        cleanup(&scope, package_name);
        clear_failure();
        return run(base_args).await.map_err(|second_error| {
            format!(
                "{first_error}\n[{tag}] ENOTEMPTY cleanup retry also failed: {second_error}"
            )
        });
    }

    if let Some(code) = npm_package_lookup_error_code(&first_error) {
        if npm_error_mentions_package(&first_error, package_name) {
            let mut attempt_errors = vec![first_error.clone()];
            for (retry_index, delay_seconds) in
                NPM_PACKAGE_LOOKUP_RETRY_BACKOFF_SECONDS.iter().enumerate()
            {
                preflight(format!(
                    "[{tag}] npm reported {code} while resolving {package_name}; continuing dependency setup and retrying in {delay_seconds}s ({}/{})",
                    retry_index + 1,
                    NPM_PACKAGE_LOOKUP_RETRY_BACKOFF_SECONDS.len()
                ));
                sleep_for_npm_retry_or_cancelled(
                    Duration::from_secs(*delay_seconds),
                    check_cancelled,
                )
                .await?;
                check_cancelled()?;
                clear_failure();

                let retry_args = if retry_index == 0 && code == "ETARGET" {
                    npm_args_with_option(&base_args, spec, "--prefer-online")
                } else {
                    base_args.clone()
                };
                match run(retry_args).await {
                    Ok(output) => return Ok(output),
                    Err(error) => {
                        if !is_package_lookup_failure(&error, package_name) {
                            if let Some(public_registry_args) = public_registry_args.clone() {
                                attempt_errors.push(error);
                                preflight(format!(
                                    "[{tag}] npm install retry failed; trying the public registry https://registry.npmjs.org/ once"
                                ));
                                clear_failure();
                                return run(public_registry_args).await.map_err(|fallback_error| {
                                    format!(
                                        "{}\n[{tag}] retry with the public registry also failed: {fallback_error}",
                                        attempt_errors.join("\n")
                                    )
                                });
                            }
                            return Err(error);
                        }
                        attempt_errors.push(error);
                    }
                }
            }

            if let Some(public_registry_args) = public_registry_args.clone() {
                preflight(format!(
                    "[{tag}] npm package lookup retries were exhausted; trying the public registry https://registry.npmjs.org/ once"
                ));
                clear_failure();
                return run(public_registry_args).await.map_err(|fallback_error| {
                    attempt_errors.push(fallback_error.clone());
                    format!(
                        "{}\n[{tag}] final public-registry attempt also failed: {fallback_error}",
                        attempt_errors.join("\n")
                    )
                });
            }

            return Err(attempt_errors.join("\n"));
        }
    }

    if let Some(public_registry_args) = public_registry_args {
        if looks_like_registry_failure(&first_error) {
            preflight(format!(
                "[{tag}] install via the configured npm registry failed; retrying with the public registry https://registry.npmjs.org/"
            ));
            clear_failure();
            return run(public_registry_args).await.map_err(|second_error| {
                format!(
                    "{first_error}\n[{tag}] retry with the public registry also failed: {second_error}"
                )
            });
        }
    }

    Err(first_error)
}

/// `npm install -g --prefix <managed> <spec>` honouring the user's npm config
/// first, then using the existing public-registry fallback when appropriate.
///
/// A `~/.npmrc` pointing at a corporate mirror that does not carry HQ's
/// packages (or is unreachable off-VPN) made qmd/hq installs die with npm's
/// generic "you are behind a proxy" text (Sentry HQ-DESKTOP-5Q; install
/// matrix `corporate-npmrc` profile). Windows already forces the public
/// registry for hq-cli; macOS now tries the user's registry, then falls back
/// and says so, so the failure is attributed and usually recovered.
fn npm_install_args(prefix: &str, spec: &str, extra_args: &[&str]) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "-g".to_string(),
        "--prefix".to_string(),
        prefix.to_string(),
    ];
    args.extend(extra_args.iter().map(|arg| (*arg).to_string()));
    args.push(spec.to_string());
    args
}

fn npm_public_registry_args(prefix: &str, spec: &str, extra_args: &[&str]) -> Vec<String> {
    let args = npm_install_args(prefix, spec, extra_args);
    npm_args_with_public_registry(&args)
}

async fn run_managed_npm_install<R: tauri::Runtime>(
    app: &AppHandle<R>,
    npm: &str,
    prefix: &str,
    spec: &str,
    package_name: &str,
    tag: &str,
    extra_args: &[&str],
    retry_public_registry: bool,
) -> Result<String, String> {
    let cancellation = InstallCancellationRegistration::new(app);
    let result = run_managed_npm_install_with_cancellation(
        app,
        npm,
        prefix,
        spec,
        package_name,
        tag,
        extra_args,
        retry_public_registry,
        &cancellation,
    )
    .await;
    cancellation.finish(app, result.as_ref().err().map(String::as_str));
    result
}

async fn run_managed_npm_install_with_cancellation<R: tauri::Runtime>(
    app: &AppHandle<R>,
    npm: &str,
    prefix: &str,
    spec: &str,
    package_name: &str,
    tag: &str,
    extra_args: &[&str],
    retry_public_registry: bool,
    cancellation: &InstallCancellationRegistration,
) -> Result<String, String> {
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache directory: {e}"))?;
    hq_desktop_core::installer_disk_space::ensure_setup_disk_space_at(Path::new(prefix))?;
    hq_desktop_core::installer_disk_space::ensure_setup_disk_space_at(&app_cache_dir)?;
    let npm_cache = crate::commands::hq_cli_update::app_npm_cache(app).map_err(|(_, error)| {
        emit_install_line(
            app,
            &format!("[{tag}] failed to prepare the app-owned npm cache: {error}"),
        );
        error
    })?;
    let base_args = npm_install_args(prefix, spec, extra_args);
    let public_registry_args = retry_public_registry
        .then(|| npm_public_registry_args(prefix, spec, extra_args));
    let npm_cache = npm_cache.as_path();
    let mut run = |args: Vec<String>| async move {
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        run_streaming_with_npm_cache(app, npm, &arg_refs, Some(npm_cache)).await
    };
    let mut cleanup = |scope: &Path, package_name: &str| {
        crate::commands::hq_cli_update::clean_partial_install_scope(scope, package_name);
    };
    let mut preflight = |line: String| emit_install_line(app, &line);
    let mut clear_failure = || clear_recovered_setup_command_failure();
    let mut check_cancelled = || cancellation.reject_if_cancelled();

    run_setup_npm_install_with_retries(
        &mut run,
        &mut cleanup,
        &mut preflight,
        &mut clear_failure,
        &mut check_cancelled,
        prefix,
        cfg!(target_os = "windows"),
        spec,
        package_name,
        tag,
        base_args,
        public_registry_args,
    )
    .await
}

#[cfg(not(windows))]
async fn npm_install_global_managed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    npm: &str,
    prefix: &str,
    spec: &str,
    package_name: &str,
    tag: &str,
) -> Result<String, String> {
    run_managed_npm_install(app, npm, prefix, spec, package_name, tag, &[], true).await
}

/// Pinned qmd version. MUST match `core/scripts/setup.sh` (`QMD_VERSION`),
/// `core/scripts/install-deps.allow`, and the `@tobilu/qmd` dependency in
/// hq-cli's package.json. Installing `latest` here produced a live three-way
/// skew (2.8.3 vs 2.5.3 vs 1.0.7) that the install matrix caught on
/// 2026-09-03 — `setup.sh` then "downgraded" what the app had just installed.
pub const MANAGED_QMD_VERSION: &str = "2.5.3";

/// Install qmd via `npm install -g @tobilu/qmd@<pin>`.
///
/// Errors if npm is not available.
#[cfg(not(windows))]
async fn install_qmd_macos(app: AppHandle) -> Result<String, String> {
    let npm = match npm_bin_or_install_node(&app, "qmd").await {
        Ok(path) => path,
        Err(msg) => {
            emit_preflight_line(&app, &msg);
            return Err(msg);
        }
    };
    let prefix = npm_global_prefix_arg(&app, "qmd")?;
    if clear_unusable_npm_bin(std::path::Path::new(&prefix), "qmd") {
        emit_preflight_line(&app, "[qmd] removed an unusable leftover bin entry before reinstalling");
    }
    // Same-version npm install is a no-op and would leave a better-sqlite3
    // binary compiled for a previous Node ABI in place. Wipe the package
    // first so the install actually rebuilds native addons.
    remove_managed_qmd_package(std::path::Path::new(&prefix));
    npm_install_global_managed(
        &app,
        npm.to_str().unwrap_or("npm"),
        &prefix,
        &format!("@tobilu/qmd@{MANAGED_QMD_VERSION}"),
        "@tobilu/qmd",
        "qmd",
    )
    .await
}

/// Use only HQ's paired npm so every setup package install runs under the
/// managed Node whose ABI the desktop app puts first on PATH.
#[cfg(not(windows))]
fn preferred_npm_binary() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| {
        "[npm] managed Node.js/npm toolchain not found: home directory is unavailable.".to_string()
    })?;
    if managed_node_toolchain_is_usable(&home) {
        return Ok(managed_node_bin_in(&home).join("npm"));
    }
    Err(format!(
        "[npm] managed Node.js {MANAGED_NODE_VERSION}/npm toolchain not found or incomplete; retry setup to provision Node.js before installing npm packages."
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_hq_cli
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(windows))]
const HQ_CLI_REGISTRY_SPEC: &str = "@indigoai-us/hq-cli";
#[cfg(not(windows))]
const BUNDLED_HQ_CLI_RESOURCE_PATH: &str = "hq-cli/hq-cli.tgz";

/// Pick the fixed, app-bundled HQ CLI tarball when it exists.
///
/// Canonicalizing both paths rejects a symlink at the fixed resource slot that
/// escapes the signed application resources directory. Missing resources and
/// path-resolution failures deliberately preserve the ordinary release path.
#[cfg(not(windows))]
fn hq_cli_install_spec_with_mode(resource_dir: Option<&Path>) -> (String, &'static str) {
    let Some(resource_dir) = resource_dir.and_then(|path| path.canonicalize().ok()) else {
        return (HQ_CLI_REGISTRY_SPEC.to_string(), "registry_fallback");
    };
    let Some(package) = resource_dir
        .join(BUNDLED_HQ_CLI_RESOURCE_PATH)
        .canonicalize()
        .ok()
    else {
        return (HQ_CLI_REGISTRY_SPEC.to_string(), "registry_fallback");
    };

    if package.is_file() && package.starts_with(&resource_dir) {
        match package.into_os_string().into_string() {
            Ok(spec) => (spec, "resource"),
            Err(_) => (HQ_CLI_REGISTRY_SPEC.to_string(), "registry_fallback"),
        }
    } else {
        (HQ_CLI_REGISTRY_SPEC.to_string(), "registry_fallback")
    }
}

#[cfg(not(windows))]
fn hq_cli_install_spec(resource_dir: Option<&Path>) -> String {
    hq_cli_install_spec_with_mode(resource_dir).0
}

/// A test/release bundle can require its own CLI version. Keep the marker
/// alongside the package inside signed resources; never consult a neighboring kit.
#[cfg(not(windows))]
pub fn bundled_hq_cli_ready(app: &AppHandle) -> bool {
    bundled_hq_cli_diagnostics(app).0
}

#[cfg(not(windows))]
pub fn bundled_hq_cli_diagnostics(app: &AppHandle) -> (bool, &'static str) {
    let resource_dir = app.path().resource_dir().ok();
    let (spec, mode) = hq_cli_install_spec_with_mode(resource_dir.as_deref());
    if mode == "registry_fallback" {
        return (true, mode);
    }
    let expected = Path::new(&spec).parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("version.txt")).ok());
    let actual = check_dep_impl("hq", None).version;
    (bundled_cli_version_matches(expected.as_deref(), actual.as_deref()), mode)
}

#[cfg(not(windows))]
fn bundled_cli_version_matches(expected: Option<&str>, actual: Option<&str>) -> bool {
    match (expected, actual) {
        (Some(expected), Some(actual)) if !expected.trim().is_empty() =>
            expected.trim() == actual.trim(),
        _ => false,
    }
}

/// Install the HQ CLI from the app-bundled package when present, otherwise via
/// `npm install -g @indigoai-us/hq-cli`.
///
/// Errors if npm is not available.
#[cfg(not(windows))]
async fn install_hq_cli_macos(app: AppHandle) -> Result<String, String> {
    // Cross-process cli-update lock (contract with hq-cli's version gate — see
    // hq_desktop_core::cli_update_lock). A concurrent updater or `hq` self-update
    // writing the same global package can collide with npm's mid-rename staging
    // and gut the install, so overlapping writers must not run.
    //
    // On the SETUP deps path a held lock is almost always a benign collision with
    // the app's OWN background CLI updater, so instead of failing the deps stage
    // (and paging Sentry — HQ-DESKTOP-6J) we WAIT the holder out for a bounded
    // budget and converge. The blocking wait runs off the async worker via
    // spawn_blocking so the rest of the dependency wave keeps installing
    // concurrently; the guard is held through the streamed install below.
    let cancellation = InstallCancellationRegistration::new(&app);
    let result = async {
        let _install_lock = acquire_cli_install_lock_for_setup(
            &app,
            &cancellation,
            |app, line| emit_preflight_line(app, line),
        )
        .await?;
        install_hq_cli_after_lock(
            || hq_cli_dependency_is_satisfied(&app),
            || async {
                cancellation.reject_if_cancelled()?;
                let prefix = npm_global_prefix_arg(&app, "hq")?;
                let npm = match npm_bin_or_install_node(&app, "hq").await {
                    Ok(path) => path,
                    Err(ref msg) => {
                        emit_preflight_line(&app, msg);
                        return Err(msg.clone());
                    }
                };
                if clear_unusable_npm_bin(std::path::Path::new(&prefix), "hq") {
                    emit_preflight_line(&app, "[hq] removed an unusable leftover bin entry before reinstalling");
                }
                let resource_dir = app.path().resource_dir().ok();
                let install_spec = hq_cli_install_spec(resource_dir.as_deref());
                if install_spec != HQ_CLI_REGISTRY_SPEC {
                    emit_preflight_line(&app, "[hq] installing the CLI bundled with this HQ app");
                }
                run_managed_npm_install_with_cancellation(
                    &app,
                    npm.to_str().unwrap_or("npm"),
                    &prefix,
                    &install_spec,
                    "@indigoai-us/hq-cli",
                    "hq",
                    &[],
                    true,
                    &cancellation,
                )
                .await
            },
        )
        .await
    }
    .await;
    cancellation.finish(&app, result.as_ref().err().map(String::as_str));
    result
}

// NOTE (2026-04-21): `install_hq_cloud` was removed along with the
// `hq-cloud` DEPS row in 04-deps.tsx. The HQ Sync menubar app now spawns
// the runner via `npx -y --package=@indigoai-us/hq-cloud@<ver>
// hq-sync-runner …` (see hq-sync/src-tauri/src/commands/sync.rs), which
// removes the need for a global install. Do NOT re-add this command
// unless you're also re-adding a frontend invocation — the previous
// backend-only re-add stranded a dead Tauri handler.

// ─────────────────────────────────────────────────────────────────────────────
// Shared install command wrappers
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn install_node<R: tauri::Runtime>(app: AppHandle<R>) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_node_macos(app).await
    }
    #[cfg(windows)]
    {
        install_node_windows(app, false).await
    }
}

/// Provision managed Node as part of the bounded repair flow. Native crashes
/// request replacement of the existing Windows runtime because `--version`
/// alone does not prove that the ABI and npm probes can run.
pub(crate) async fn install_node_for_repair<R: tauri::Runtime>(
    app: AppHandle<R>,
    replace_existing: bool,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = replace_existing;
        install_node_macos(app).await
    }
    #[cfg(windows)]
    {
        install_node_windows(app, replace_existing).await
    }
}

#[tauri::command]
pub async fn install_git(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_git_macos(app).await
    }
    #[cfg(windows)]
    {
        install_git_windows(app).await
    }
}

#[tauri::command]
pub async fn install_gh(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_gh_macos(app).await
    }
    #[cfg(windows)]
    {
        install_gh_windows(app).await
    }
}

#[tauri::command]
pub async fn install_yq(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_yq_macos(app).await
    }
    #[cfg(windows)]
    {
        install_yq_windows(app).await
    }
}

#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_claude_code_macos(app).await
    }
    #[cfg(windows)]
    {
        install_claude_code_windows(app).await
    }
}

/// npm spec + bin name for a sessions provider. Unknown tools fail closed.
pub fn session_provider_npm_spec(tool: &str) -> Result<(&'static str, &'static str), String> {
    match tool {
        "claude" => Ok(("@anthropic-ai/claude-code", "claude")),
        "codex" => Ok(("@openai/codex", "codex")),
        "grok" => Ok(("@xai-official/grok", "grok")),
        _ => Err("Unknown agent. Choose Claude, Codex, or Grok.".into()),
    }
}

fn emit_session_install_line(app: &AppHandle, msg: &str) {
    #[cfg(not(windows))]
    emit_preflight_line(app, msg);
    #[cfg(windows)]
    emit_progress(app, msg);
}

async fn npm_bin_or_install_node(app: &AppHandle, tag: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(not(windows))]
    {
        if let Ok(path) = preferred_npm_binary() {
            return Ok(path);
        }
        emit_session_install_line(
            app,
            &format!(
                "[{tag}] HQ's managed Node.js/npm toolchain is missing. Installing Node.js before installing npm packages."
            ),
        );
        install_node(app.clone()).await?;
        return preferred_npm_binary().map_err(|_| {
            format!("[{tag}] managed npm was not found after installing Node.js.")
        });
    }

    #[cfg(windows)]
    {
        let lookup = || {
            which::which_in(
                "npm",
                Some(extended_search_path()),
                std::env::current_dir().unwrap_or_default(),
            )
        };
        if let Ok(path) = lookup() {
            return Ok(path);
        }
        emit_session_install_line(
            app,
            &format!("[{tag}] npm is not installed. Installing Node.js first so the agent CLI can be set up in-app."),
        );
        install_node(app.clone()).await?;
        lookup().map_err(|_| {
            format!("[{tag}] npm was not found after installing Node.js. Open Settings → Agents and try again.")
        })
    }
}

#[cfg(not(windows))]
async fn install_npm_cli_macos(
    app: AppHandle,
    spec: &str,
    bin: &str,
    tag: &str,
) -> Result<String, String> {
    let prefix = npm_global_prefix_arg(&app, tag)?;
    if clear_unusable_npm_bin(std::path::Path::new(&prefix), bin) {
        emit_preflight_line(
            &app,
            &format!("[{tag}] removed an unusable leftover bin entry before reinstalling"),
        );
    }
    let npm = npm_bin_or_install_node(&app, tag).await?;
    let package_name = npm_package_name_from_spec(spec)
        .ok_or_else(|| format!("[{tag}] npm package spec is not a registry package: {spec}"))?;
    npm_install_global_managed(
        &app,
        npm.to_str().unwrap_or("npm"),
        &prefix,
        spec,
        &package_name,
        tag,
    )
    .await
}

#[cfg(windows)]
async fn install_npm_cli_windows(
    app: AppHandle,
    spec: &str,
    bin: &str,
    tag: &str,
) -> Result<String, String> {
    emit_progress(&app, &format!("Installing {tag} via npm..."));
    let _ = npm_bin_or_install_node(&app, tag).await?;
    let prefix = managed_npm_prefix();
    let prefix = prefix.to_string_lossy().into_owned();
    let package_name = npm_package_name_from_spec(spec)
        .ok_or_else(|| format!("[{tag}] npm package spec is not a registry package: {spec}"))?;
    let result = run_managed_npm_install(
        &app,
        "npm",
        &prefix,
        spec,
        &package_name,
        tag,
        &[],
        false,
    )
    .await?;
    append_user_path(&managed_npm_bin())?;
    let _ = bin;
    Ok(result)
}

/// Install the Codex CLI via `npm install -g @openai/codex`.
#[tauri::command]
pub async fn install_codex(app: AppHandle) -> Result<String, String> {
    let (spec, bin) = session_provider_npm_spec("codex")?;
    #[cfg(not(windows))]
    {
        install_npm_cli_macos(app, spec, bin, "codex").await
    }
    #[cfg(windows)]
    {
        install_npm_cli_windows(app, spec, bin, "codex").await
    }
}

/// Install the Grok CLI via `npm install -g @xai-official/grok`.
#[tauri::command]
pub async fn install_grok(app: AppHandle) -> Result<String, String> {
    let (spec, bin) = session_provider_npm_spec("grok")?;
    #[cfg(not(windows))]
    {
        install_npm_cli_macos(app, spec, bin, "grok").await
    }
    #[cfg(windows)]
    {
        install_npm_cli_windows(app, spec, bin, "grok").await
    }
}

/// In-app sessions setup: install the selected provider CLI without the user
/// hunting binaries. Ensures npm/Node first, then the provider package.
#[tauri::command]
pub async fn install_session_provider(app: AppHandle, tool: String) -> Result<String, String> {
    match tool.as_str() {
        "claude" => {
            let _ = npm_bin_or_install_node(&app, "claude").await?;
            install_claude_code(app).await
        }
        "codex" | "grok" => {
            let (spec, bin) = session_provider_npm_spec(&tool)?;
            #[cfg(not(windows))]
            {
                install_npm_cli_macos(app, spec, bin, &tool).await
            }
            #[cfg(windows)]
            {
                install_npm_cli_windows(app, spec, bin, &tool).await
            }
        }
        _ => Err("Unknown agent. Choose Claude, Codex, or Grok.".into()),
    }
}

#[tauri::command]
pub async fn install_qmd(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_qmd_macos(app).await
    }
    #[cfg(windows)]
    {
        install_qmd_windows(app).await
    }
}

#[tauri::command]
pub async fn install_hq_cli(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_hq_cli_macos(app).await
    }
    #[cfg(windows)]
    {
        install_hq_cli_windows(app).await
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows dependency implementation
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_VERSION: &str = "v22.12.0";
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_SHA256_X64: &str =
    "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8";
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_SHA256_ARM64: &str =
    "17401720af48976e3f67c41e8968a135fb49ca1f88103a92e0e8c70605763854";
#[cfg(windows)]
const WINDOWS_YQ_VERSION: &str = "v4.53.2";
#[cfg(windows)]
const WINDOWS_YQ_SHA256_AMD64: &str =
    "2aee32f1de46a20672f48c25df3018839798bd509143f2ce05fdab1550ff5592";
#[cfg(windows)]
const WINDOWS_YQ_SHA256_ARM64: &str =
    "448208550332ca33ef816e4cee49fc1e79987b8a08a451c6ae529703c8cfc8a9";
#[cfg(windows)]
const RSYNC_BUNDLE_SHA256: &str =
    "0e1d90ab60c2fd6c24debe6b59bd4b23ea65009a408976f94b916dcad8332f1d";

// Portable Git (MinGit) — the fallback when neither winget nor scoop is present.
// MinGit ships a single 64-bit build; on arm64 Windows it runs under x64
// emulation, so the same asset serves every supported arch. git is a REQUIRED
// dep (autocommit, repos, agents, pack-install), so this keeps it installable
// without a system package manager rather than hard-failing.
#[cfg(windows)]
const WINDOWS_MINGIT_VERSION: &str = "2.54.0";
#[cfg(windows)]
const WINDOWS_MINGIT_URL: &str = "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-64-bit.zip";
#[cfg(windows)]
const WINDOWS_MINGIT_SHA256: &str =
    "04f937e1f0918b17b9be6f2294cb2bb66e96e1d9832d1c298e2de088a1d0e668";

#[cfg(windows)]
fn debug_log(msg: &str) {
    if is_deps_debug_enabled() {
        eprintln!("[hq-deps] {msg}");
    }
}

#[cfg(windows)]
#[derive(Debug, Clone)]
struct DownloadedAsset {
    status: u16,
    bytes: Vec<u8>,
}

#[cfg(windows)]
fn require_http_success(status: u16, label: &str) -> Result<(), String> {
    if (200..=299).contains(&status) {
        Ok(())
    } else {
        Err(format!("{label} download returned HTTP status {status}"))
    }
}

// --- Managed-toolchain download resilience (HQ-DESKTOP-5A) -----------------
//
// The shipped helper made exactly ONE attempt with a default reqwest blocking
// client whose total request timeout is 30s. On Windows the 34.87 MB Node zip
// needs a link that sustains ~9.3 Mbit/s for the whole request, so any single
// transient blip aborted the body read and turned into a terminal
// NodeUnprovisioned bail — auto-sync dead for the full 15-minute repair
// cooldown and one #hq-alerts page per window. These constants give every
// managed-asset download a bounded retry with explicit per-attempt timeouts.

/// How many times each managed-asset download is attempted before giving up.
#[cfg(windows)]
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// Per-attempt overall request timeout — covers TLS handshake, TTFB and the
/// full body read. reqwest's blocking default is 30s, which cannot pull the
/// 34.87 MB Node zip on an ordinary link; 180s lowers the required sustained
/// rate from ~9.3 Mbit/s to ~1.6 Mbit/s while still bounding every wait.
#[cfg(windows)]
const DOWNLOAD_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(180);

/// TCP+TLS connect timeout per attempt. Bites well before the read budget so an
/// offline / DNS-broken machine fails fast (~20s per attempt) instead of
/// burning the full 180s waiting on a body that will never arrive.
#[cfg(windows)]
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Fixed backoff before attempt N+1 (index 0 -> after attempt 1, etc.). Fixed,
/// not exponential: the repair slot is short and the goal is to ride out a
/// brief blip, not to be polite to an overloaded origin. Must hold at least
/// `DOWNLOAD_ATTEMPTS - 1` entries — asserted in
/// `the_total_download_budget_stays_inside_the_repair_slot`.
#[cfg(windows)]
const DOWNLOAD_BACKOFF: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(15)];

/// Retryable HTTP statuses: request timeout, too-many-requests, and any 5xx.
/// Everything else non-2xx (404, 403, ...) is terminal — the asset is gone or
/// forbidden and retrying cannot help.
#[cfg(windows)]
fn is_retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..=599).contains(&status)
}

/// The backoff to sleep before the attempt after `attempt_index` (0-based).
/// Zeroed in test builds so the hermetic retry tests do not sleep 5-20s;
/// production (never compiled with cfg(test)) always uses the real values.
#[cfg(windows)]
fn download_backoff(attempt_index: usize) -> Duration {
    if cfg!(test) {
        return Duration::ZERO;
    }
    DOWNLOAD_BACKOFF
        .get(attempt_index)
        .copied()
        .unwrap_or(Duration::from_secs(15))
}

/// Render an error and its full `source()` chain as `"top: cause: root"`.
///
/// reqwest collapses a blocking-client timeout and a mid-stream body error into
/// the same `Kind::Decode`, whose `Display` is the causeless string "error
/// decoding response body"; the real cause (timed out / connection reset) is
/// reachable only through `source()`, which a plain `{e}` discards. Walking the
/// chain here is what lets the next occurrence name the transport fault instead
/// of the useless top-level string.
#[cfg(windows)]
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

/// Fetch an asset's bytes, retrying transient failures.
///
/// `fetch` is called up to `DOWNLOAD_ATTEMPTS` times. A closure `Err`
/// (connect/TLS/read/decode fault) is retryable; a 2xx returns the bytes; a
/// retryable status (see `is_retryable_status`) is retried; every other non-2xx
/// returns terminally on the first attempt through the existing
/// `require_http_success` message. The closure stays `FnMut` with a `String`
/// error so all four callers and the hermetic tests compile unchanged.
#[cfg(windows)]
fn fetch_asset_with<F>(url: &str, label: &str, mut fetch: F) -> Result<Vec<u8>, String>
where
    F: FnMut(&str) -> Result<DownloadedAsset, String>,
{
    let started = std::time::Instant::now();
    let mut last_err = format!("{label} download failed before any attempt completed");
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        let retryable_err = match fetch(url) {
            Ok(asset) => match require_http_success(asset.status, label) {
                Ok(()) => return Ok(asset.bytes),
                Err(msg) if is_retryable_status(asset.status) => msg,
                // Terminal non-2xx: fail on the first attempt with the existing
                // message that `yq_download_status_and_staged_write_are_hermetic`
                // pins.
                Err(msg) => return Err(msg),
            },
            Err(e) => e,
        };
        last_err = retryable_err;
        debug_log(&format!(
            "{label} download attempt {attempt} of {DOWNLOAD_ATTEMPTS} failed: {last_err}"
        ));
        if attempt < DOWNLOAD_ATTEMPTS {
            std::thread::sleep(download_backoff((attempt - 1) as usize));
        }
    }
    Err(format!(
        "{last_err} (attempt {DOWNLOAD_ATTEMPTS} of {DOWNLOAD_ATTEMPTS}, {}s elapsed)",
        started.elapsed().as_secs()
    ))
}

#[cfg(windows)]
fn download_bytes_checked(url: &str, label: &str) -> Result<Vec<u8>, String> {
    fetch_asset_with(url, label, |url| {
        // An explicitly bounded client: the connect timeout fails an offline
        // machine fast, and the per-attempt timeout bounds a slow-but-alive
        // link without the 30s cap the shipped `reqwest::blocking::get` carried.
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
            .timeout(DOWNLOAD_ATTEMPT_TIMEOUT)
            .build()
            .map_err(|e| {
                format!(
                    "Failed to build {label} download client: {}",
                    error_chain(&e)
                )
            })?;
        // No error_for_status(): a non-2xx flows through as DownloadedAsset so
        // fetch_asset_with can decide retryability from the status itself.
        let response = client
            .get(url)
            .send()
            .map_err(|e| format!("Failed to fetch {label}: {}", error_chain(&e)))?;
        let status = response.status().as_u16();
        // Classify on status BEFORE consuming the body. A terminal (403/404) or
        // retryable (5xx) response must reach fetch_asset_with as a status, not
        // be recast as a generic retryable read error if a proxy's error body
        // stalls mid-stream — that would retry a 404/403 for ~560s and break the
        // "terminal statuses fail on the first attempt" invariant. Only a
        // successful response has a body worth reading here.
        if !(200..=299).contains(&status) {
            return Ok(DownloadedAsset {
                status,
                bytes: Vec::new(),
            });
        }
        // Still fully in-memory (verify-then-activate is unchanged); the cause
        // chain distinguishes a slow-link timeout from a mid-stream reset where
        // the bare `{e}` printed only "error decoding response body".
        let bytes = response
            .bytes()
            .map_err(|e| format!("Failed to read {label} response: {}", error_chain(&e)))?
            .to_vec();
        Ok(DownloadedAsset { status, bytes })
    })
}

#[cfg(windows)]
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(windows)]
fn verify_sha256_bytes(label: &str, bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "{label} checksum mismatch: expected {expected}, got {actual}"
        ))
    }
}

/// Where HQ stores its managed toolchain on Windows. Per-user, non-roaming
/// (LOCALAPPDATA), so a multi-hundred-MB Node install doesn't get pulled
/// across roaming profile sync.
#[cfg(windows)]
pub fn managed_toolchain_dir() -> PathBuf {
    local_app_data().join("IndigoHQ").join("toolchain")
}

#[cfg(windows)]
fn local_app_data() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("AppData")
                .join("Local")
        })
}

#[cfg(windows)]
fn user_profile() -> PathBuf {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

#[cfg(windows)]
fn program_files() -> PathBuf {
    std::env::var("ProgramFiles")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"))
}

#[cfg(windows)]
fn system_root() -> PathBuf {
    std::env::var("SystemRoot")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
}

#[cfg(windows)]
fn managed_node_dir() -> PathBuf {
    managed_toolchain_dir().join("node")
}

#[cfg(windows)]
fn managed_node_bin() -> PathBuf {
    managed_node_dir()
}

#[cfg(windows)]
fn managed_git_dir() -> PathBuf {
    managed_toolchain_dir().join("git")
}

/// Directory holding the MinGit `git.exe` wrapper — what goes on PATH.
#[cfg(windows)]
fn managed_git_cmd() -> PathBuf {
    managed_git_dir().join("cmd")
}

/// MinGit's core libexec/bin (the real git + helpers it shells out to).
#[cfg(windows)]
fn managed_git_mingw_bin() -> PathBuf {
    managed_git_dir().join("mingw64").join("bin")
}

#[cfg(windows)]
fn managed_npm_prefix() -> PathBuf {
    // Single source of truth shared with the hq-CLI updater's managed retry, so
    // the first-run installer and the updater can never drift to different prefixes.
    hq_desktop_core::paths::managed_npm_prefix_in(&managed_toolchain_dir())
}

#[cfg(windows)]
fn managed_npm_bin() -> PathBuf {
    hq_desktop_core::paths::managed_npm_bin_in(&managed_toolchain_dir())
}

#[cfg(windows)]
fn latest_claude_code_dir() -> Option<PathBuf> {
    let roaming = std::env::var("APPDATA").ok()?;
    let base = PathBuf::from(roaming).join("Claude").join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.join("claude.exe").exists())
        .collect();
    if versions.is_empty() {
        return None;
    }
    versions.sort();
    versions.pop()
}

/// PATH used when spawning install subprocesses. Composes Windows-standard
/// install locations so install scripts can find each other before the
/// user's PATH is refreshed via WM_SETTINGCHANGE.
#[cfg(windows)]
pub fn extended_search_path() -> String {
    let mut dirs: Vec<String> = vec![
        managed_node_bin().to_string_lossy().into_owned(),
        managed_npm_bin().to_string_lossy().into_owned(),
        managed_toolchain_dir()
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        // Portable Git (MinGit) installed by the managed fallback when no
        // package manager is present. `cmd` holds the git.exe wrapper;
        // `mingw64/bin` holds the helpers it shells out to.
        managed_git_cmd().to_string_lossy().into_owned(),
        managed_git_mingw_bin().to_string_lossy().into_owned(),
        // Node.js as installed by winget's `OpenJS.NodeJS.LTS` package. The MSI
        // lands `node.exe`/`npm.cmd` in `C:\Program Files\nodejs` (machine
        // scope) or `%LOCALAPPDATA%\Programs\nodejs` (winget `--scope user`).
        // Without these, a Node installed via winget earlier in THIS setup run
        // is invisible to the in-session `npm` lookup — the persistent HKCU PATH
        // update only reaches NEW shells via WM_SETTINGCHANGE — so the npm-based
        // deps (qmd, hq-cli) fail with "'npm' not found on PATH".
        program_files()
            .join("nodejs")
            .to_string_lossy()
            .into_owned(),
        local_app_data()
            .join("Programs")
            .join("nodejs")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("usr")
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("cmd")
            .to_string_lossy()
            .into_owned(),
        local_app_data()
            .join("Microsoft")
            .join("WindowsApps")
            .to_string_lossy()
            .into_owned(),
        local_app_data()
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .to_string_lossy()
            .into_owned(),
        user_profile()
            .join("scoop")
            .join("shims")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("GitHub CLI")
            .to_string_lossy()
            .into_owned(),
        system_root()
            .join("System32")
            .to_string_lossy()
            .into_owned(),
        system_root().to_string_lossy().into_owned(),
    ];

    if let Some(latest) = latest_claude_code_dir() {
        dirs.push(latest.to_string_lossy().into_owned());
    }

    if let Ok(existing) = std::env::var("PATH") {
        dirs.push(existing);
    }

    let joined = dirs.join(";");
    debug_log(&format!(
        "extended_search_path composed: {} entries, {} bytes",
        dirs.len(),
        joined.len()
    ));
    joined
}

/// Append `new_dir` to the user's persistent PATH (HKCU\Environment\Path)
/// and broadcast WM_SETTINGCHANGE so new shells pick it up without logout.
#[cfg(windows)]
#[derive(Clone)]
struct UserPathValue {
    value: String,
    value_type: winreg::enums::RegType,
}

#[cfg(windows)]
fn decode_registry_string(raw: &RegValue, name: &str) -> Result<String, String> {
    if raw.vtype != REG_SZ && raw.vtype != REG_EXPAND_SZ {
        return Err(format!(
            "HKCU\\Environment\\{name} has unsupported registry type {:?}",
            raw.vtype
        ));
    }
    if !raw.bytes.len().is_multiple_of(2) {
        return Err(format!(
            "HKCU\\Environment\\{name} has invalid UTF-16 byte length {}",
            raw.bytes.len()
        ));
    }

    let mut units = Vec::with_capacity(raw.bytes.len() / 2);
    for chunk in raw.bytes.chunks_exact(2) {
        units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    while units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16(&units)
        .map_err(|e| format!("HKCU\\Environment\\{name} is not valid UTF-16: {e}"))
}

#[cfg(windows)]
fn encode_registry_string(value: &str, value_type: winreg::enums::RegType) -> RegValue {
    let mut bytes = Vec::with_capacity((value.len() + 1) * 2);
    for unit in value.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    RegValue {
        bytes,
        vtype: value_type,
    }
}

#[cfg(windows)]
fn read_user_path_value(env: &RegKey) -> Result<UserPathValue, String> {
    match env.get_raw_value("Path") {
        Ok(raw) => Ok(UserPathValue {
            value: decode_registry_string(&raw, "Path")?,
            value_type: raw.vtype,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UserPathValue {
            value: String::new(),
            value_type: REG_EXPAND_SZ,
        }),
        Err(e) => Err(format!("HKCU\\Environment\\Path read failed: {e}")),
    }
}

#[cfg(windows)]
fn write_user_path_value(env: &RegKey, value: &UserPathValue) -> Result<(), String> {
    env.set_raw_value(
        "Path",
        &encode_registry_string(&value.value, value.value_type.clone()),
    )
    .map_err(|e| format!("HKCU\\Environment\\Path write failed: {e}"))
}

#[cfg(windows)]
pub fn append_user_path(new_dir: &Path) -> Result<(), String> {
    let result = (|| {
        let dir_str = new_dir.to_string_lossy().to_string();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu
            .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
            .map_err(|e| format!("HKCU\\Environment open failed: {e}"))?;

        let mut current_value = read_user_path_value(&env)?;
        let current = current_value.value.clone();

        let already_present = current
            .split(';')
            .any(|entry| entry.eq_ignore_ascii_case(&dir_str));
        if already_present {
            debug_log(&format!(
                "append_user_path: '{dir_str}' already on PATH, skipping"
            ));
            return Ok(());
        }

        let updated = if current.is_empty() {
            dir_str.clone()
        } else if current.ends_with(';') {
            format!("{current}{dir_str}")
        } else {
            format!("{current};{dir_str}")
        };

        current_value.value = updated;
        write_user_path_value(&env, &current_value)?;

        broadcast_environment_change();
        debug_log(&format!(
            "append_user_path: added '{dir_str}', broadcast sent"
        ));
        Ok(())
    })();

    if result.is_err() {
        let failure_scope = ACTIVE_ONBOARDING_FAILURE_SCOPE
            .try_with(|scope| scope.clone())
            .ok();
        record_onboarding_failure_detail(
            "deps",
            failure_scope.as_ref(),
            Some("path-write"),
            OnboardingErrorCategory::Unknown,
        );
    }
    result
}

/// Remove `dir` from the user's persistent PATH. Idempotent.
#[cfg(windows)]
pub fn remove_user_path(dir: &Path) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("HKCU\\Environment open failed: {e}"))?;

    let mut current_value = read_user_path_value(&env)?;
    let current = current_value.value.clone();
    let parts: Vec<&str> = current
        .split(';')
        .filter(|entry| !entry.eq_ignore_ascii_case(&dir_str))
        .collect();
    let updated = parts.join(";");

    if updated == current {
        return Ok(());
    }

    current_value.value = updated;
    write_user_path_value(&env, &current_value)?;
    broadcast_environment_change();
    Ok(())
}

#[cfg(windows)]
fn broadcast_environment_change() {
    let msg: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST as HWND,
            WM_SETTINGCHANGE,
            0,
            msg.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

#[cfg(windows)]
pub fn check_dep_impl(tool: &str, search_path: Option<&str>) -> DepStatus {
    let path_str = search_path
        .map(String::from)
        .unwrap_or_else(extended_search_path);

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let found = which::which_in(tool, Some(&path_str), &cwd).ok();

    match found {
        Some(path) => {
            let output = Command::new(&path)
                .arg("--version")
                .env("PATH", &path_str)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok();

            let (functional, version) = match output {
                Some(o) if o.status.success() => (
                    true,
                    Some(
                        String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                    ),
                ),
                Some(_) => (false, None),
                None => (false, None),
            };

            if !functional {
                return DepStatus {
                    installed: false,
                    version: None,
                    path: Some(path),
                };
            }

            DepStatus {
                installed: true,
                version,
                path: Some(path),
            }
        }
        None => DepStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

#[cfg(windows)]
pub fn check_dep_in(tool: &str, path_dirs: &str) -> DepStatus {
    check_dep_impl(tool, Some(path_dirs))
}

#[cfg(windows)]
#[derive(Debug, Clone)]
pub enum PackageManager {
    Winget,
    Scoop,
    Managed,
}

#[cfg(windows)]
fn detect_package_manager() -> PackageManager {
    let path = extended_search_path();
    if which::which_in(
        "winget",
        Some(&path),
        std::env::current_dir().unwrap_or_default(),
    )
    .is_ok()
    {
        return PackageManager::Winget;
    }
    if which::which_in(
        "scoop",
        Some(&path),
        std::env::current_dir().unwrap_or_default(),
    )
    .is_ok()
    {
        return PackageManager::Scoop;
    }
    PackageManager::Managed
}

#[cfg(windows)]
async fn run_streaming<R: tauri::Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    run_streaming_with_npm_cache(app, program, args, None).await
}

#[cfg(windows)]
async fn run_streaming_with_npm_cache<R: tauri::Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
    npm_cache: Option<&Path>,
) -> Result<String, String> {
    let setup_run_id = current_setup_run_id();
    let handle_id = Uuid::new_v4().to_string();
    register_cancel_handle(handle_id.clone());

    let search_path = extended_search_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resolved = match which::which_in(program, Some(&search_path), &cwd) {
        Ok(path) => path,
        Err(_) => {
            deregister_handle(&handle_id);
            let error = format!("'{}' not found on PATH", program);
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };

    let job = match create_job_object() {
        Ok(job) => Arc::new(job),
        Err(e) => {
            deregister_handle(&handle_id);
            record_setup_command_failure(program, args, None, String::new(), String::new(), e.clone());
            return Err(e);
        }
    };

    let mut command = if let Some(npm_cache) = npm_cache {
        setup_npm_command(
            resolved.to_str().unwrap_or(program),
            &search_path,
            npm_cache,
            args,
        )
    } else {
        let mut command = Command::new(&resolved);
        command.args(args).env("PATH", &search_path);
        command
    };
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            deregister_handle(&handle_id);
            let error = format!("Failed to spawn '{}': {}", program, e);
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };

    if let Err(e) = assign_process_to_job(job.0, child.as_raw_handle() as HANDLE) {
        record_setup_command_failure(program, args, None, String::new(), String::new(), e.clone());
        let kill_result = child.kill().map_err(|kill_err| {
            format!("failed to kill untracked child after job assignment failure: {kill_err}")
        });
        let wait_result = child.wait().map_err(|wait_err| {
            format!("failed to wait untracked child after job assignment failure: {wait_err}")
        });
        deregister_handle(&handle_id);
        if let Err(kill_err) = kill_result {
            return Err(format!("{e}; {kill_err}"));
        }
        if let Err(wait_err) = wait_result {
            return Err(format!("{e}; {wait_err}"));
        }
        return Err(e);
    }
    register_job_handle(&handle_id, job.clone());
    emit_install_handle_started(app, &handle_id);
    if is_cancelled(&handle_id) {
        if let Err(e) = terminate_process_tree(&handle_id) {
            record_cleanup_failure(&handle_id, e);
        }
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            deregister_handle(&handle_id);
            let error = "no stdout".to_string();
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            deregister_handle(&handle_id);
            let error = "no stderr".to_string();
            record_setup_command_failure(program, args, None, String::new(), String::new(), error.clone());
            return Err(error);
        }
    };

    enum ReaderMsg {
        Stdout(String),
        Stderr,
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    let stdout_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let (tx, rx) = mpsc::channel::<ReaderMsg>();
    let stdout_thread = {
        let tx = tx.clone();
        let stdout_tail = Arc::clone(&stdout_tail);
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stdout).lines() {
                match line_result {
                    Ok(line) => {
                        append_setup_diagnostic_tail(&mut recover_lock(&stdout_tail), &line);
                        if tx.send(ReaderMsg::Stdout(line)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stdout",
                err,
            });
        })
    };
    let stderr_thread = {
        let app = app.clone();
        let handle_id = handle_id.clone();
        let setup_run_id = setup_run_id.clone();
        let stderr_lines = Arc::clone(&stderr_lines);
        let stderr_tail = Arc::clone(&stderr_tail);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stderr).lines() {
                match line_result {
                    Ok(line) => {
                        recover_lock(&stderr_lines).push(line.clone());
                        append_setup_diagnostic_tail(&mut recover_lock(&stderr_tail), &line);
                        let _ = app.emit(
                            "install:progress",
                            InstallProgress {
                                setup_run_id: setup_run_id.clone(),
                                handle: handle_id.clone(),
                                line: line.clone(),
                                finished: false,
                                error: None,
                            },
                        );
                        if tx.send(ReaderMsg::Stderr).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stderr",
                err,
            });
        })
    };
    drop(tx);

    let mut done_count = 0;
    let mut first_stream_err: Option<String> = None;
    let mut status = None;
    let mut cancel_signal_sent = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(ReaderMsg::Stdout(line)) => {
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        setup_run_id: current_setup_run_id(),
                        handle: handle_id.clone(),
                        line,
                        finished: false,
                        error: None,
                    },
                );
            }
            Ok(ReaderMsg::Stderr) => {}
            Ok(ReaderMsg::Done { stream, err }) => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{stream}: {e}"));
                    }
                }
                done_count += 1;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if is_cancelled(&handle_id) && !cancel_signal_sent {
            if let Err(e) = terminate_process_tree(&handle_id) {
                record_cleanup_failure(&handle_id, e);
            }
            cancel_signal_sent = true;
        }

        if is_cancelled(&handle_id) {
            if let Some(cleanup) = cleanup_failure(&handle_id) {
                // Report before waiting for an uncooperative process or either
                // reader thread; the cancellation itself remains terminal.
                record_install_cancellation(InstallCancellation::CleanupFailed(cleanup));
            }
        }

        if status.is_none() {
            status = child.try_wait().map_err(|e| e.to_string())?;
        }
        if status.is_some() && done_count >= 2 {
            break;
        }
        if done_count >= 2 && status.is_none() {
            status = Some(child.wait().map_err(|e| e.to_string())?);
            break;
        }
    }

    let status = match status {
        Some(status) => status,
        None => child.wait().map_err(|e| e.to_string())?,
    };

    let stdout_join = stdout_thread
        .join()
        .map_err(|_| "stdout reader thread panicked".to_string());
    let stderr_join = stderr_thread
        .join()
        .map_err(|_| "stderr reader thread panicked".to_string());

    let was_cancelled = is_cancelled(&handle_id);
    let cleanup_failure = take_cleanup_failure(&handle_id);
    deregister_handle(&handle_id);

    if let Err(e) = stdout_join.and(stderr_join) {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }

    if was_cancelled {
        let cancellation = cleanup_failure
            .map(InstallCancellation::CleanupFailed)
            .unwrap_or(InstallCancellation::UserCancelled);
        record_install_cancellation(cancellation.clone());
        let msg = cancellation.user_message();
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    if let Some(err) = first_stream_err {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

    if status.success() {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: None,
            },
        );
        Ok(handle_id)
    } else {
        let code = status.code().unwrap_or(-1);
        let stdout = recover_lock(&stdout_tail).clone();
        let captured = recover_lock(&stderr_lines).clone();
        let stderr = recover_lock(&stderr_tail).clone();
        let msg = format_install_error(code, &captured);
        let user_msg = hq_desktop_core::installer_disk_space::user_facing_install_error(
            program, &stderr, &msg,
        );
        record_setup_command_failure(program, args, Some(code), stdout, stderr, msg.clone());
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                setup_run_id: current_setup_run_id(),
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(user_msg.clone()),
            },
        );
        Err(user_msg)
    }
}

#[cfg(windows)]
fn emit_progress<R: tauri::Runtime>(app: &AppHandle<R>, msg: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            setup_run_id: current_setup_run_id(),
            handle: "preflight".to_string(),
            line: msg.to_string(),
            finished: false,
            error: None,
        },
    );
}

#[cfg(windows)]
async fn winget_install(app: &AppHandle, id: &str) -> Result<String, String> {
    let args = winget_install_args(id);
    run_streaming(app, "winget", &args).await
}

#[cfg(windows)]
fn winget_install_args(id: &str) -> [&str; 8] {
    [
        "install",
        "--id",
        id,
        "--source",
        "winget",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
    ]
}

// WinGet documents 0x8A15005E (-1978335138) as
// APPINSTALLER_CLI_ERROR_PINNED_CERTIFICATE_MISMATCH, not as an already-
// installed result. Re-probe Git after this source failure so an existing
// managed Git is accepted, while preserving the original error when absent.
#[cfg(any(test, windows))]
fn winget_exit_code_from_error(error: &str) -> Option<i32> {
    let rest = error.strip_prefix("Process exited with code ")?;
    rest.split_once(':')
        .map_or(rest, |(code, _)| code)
        .trim()
        .parse()
        .ok()
}

#[cfg(any(test, windows))]
fn resolve_git_winget_install_failure<F>(
    error: String,
    git_is_satisfied: F,
) -> Result<String, String>
where
    F: FnOnce() -> bool,
{
    if winget_exit_code_from_error(&error) == Some(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE)
        && git_is_satisfied()
    {
        Ok("Git already available after WinGet certificate mismatch".to_string())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
async fn scoop_install(app: &AppHandle, name: &str) -> Result<String, String> {
    run_streaming(app, "scoop", &["install", name]).await
}

#[cfg(windows)]
async fn install_node_windows<R: tauri::Runtime>(
    app: AppHandle<R>,
    replace_existing: bool,
) -> Result<String, String> {
    // Node is a hard prerequisite for qmd and hq-cli, so its installer must be
    // deterministic. Package-manager exit codes do not prove that node/npm/npx
    // landed or are runnable in this process (and managed enterprise machines
    // can redirect/block winget without a useful failure). The managed path is
    // per-user and admin-free, verifies the pinned archive checksum, validates
    // all three executables, runs `node --version`, then atomically activates
    // the toolchain directory.
    emit_progress(&app, "Installing HQ's verified Node.js runtime...");
    install_managed_node(&app, replace_existing).await
}

#[cfg(windows)]
fn windows_managed_node_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "x64" => Some(WINDOWS_MANAGED_NODE_SHA256_X64),
        "arm64" => Some(WINDOWS_MANAGED_NODE_SHA256_ARM64),
        _ => None,
    }
}

#[cfg(windows)]
fn zip_entry_relative_to_root(
    enclosed: &Path,
    expected_root: &str,
    raw_name: &str,
) -> Result<Option<PathBuf>, String> {
    let mut comps = enclosed.components();
    let Some(first) = comps.next() else {
        return Ok(None);
    };
    match first {
        std::path::Component::Normal(root) if root == std::ffi::OsStr::new(expected_root) => {}
        _ => {
            return Err(format!(
                "zip entry outside expected root '{expected_root}': {raw_name}"
            ))
        }
    }

    let mut rel = PathBuf::new();
    for comp in comps {
        match comp {
            std::path::Component::Normal(part) => rel.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::ParentDir => {
                return Err(format!("zip entry has unsafe component: {raw_name}"));
            }
        }
    }

    if rel.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rel))
    }
}

#[cfg(windows)]
fn zip_raw_name_has_unsafe_component(raw_name: &str) -> bool {
    Path::new(raw_name).components().any(|component| {
        matches!(
            component,
            std::path::Component::Prefix(_)
                | std::path::Component::RootDir
                | std::path::Component::ParentDir
        )
    })
}

#[cfg(windows)]
fn validate_managed_node_dir(node_dir: &Path) -> Result<(), String> {
    for leaf in ["node.exe", "npm.cmd", "npx.cmd"] {
        let path = node_dir.join(leaf);
        if !path.is_file() {
            return Err(format!(
                "managed Node missing required file {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn extract_managed_node_zip(
    bytes: &[u8],
    version: &str,
    arch: &str,
    staged_node_dir: &Path,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open Node zip: {e}"))?;

    let archive_root = format!("node-{version}-win-{arch}");
    std::fs::create_dir_all(staged_node_dir)
        .map_err(|e| format!("mkdir {}: {e}", staged_node_dir.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("node zip entry {i}: {e}"))?;
        let raw_name = entry.name().to_string();
        if zip_raw_name_has_unsafe_component(&raw_name) {
            return Err(format!("node zip entry has unsafe path: {raw_name}"));
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("node zip entry has unsafe path: {raw_name}"))?
            .to_path_buf();
        let Some(rel) = zip_entry_relative_to_root(&enclosed, &archive_root, &raw_name)? else {
            continue;
        };
        let out_path = staged_node_dir.join(&rel);
        if !out_path.starts_with(staged_node_dir) {
            return Err(format!("node zip entry escapes staging dir: {raw_name}"));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir parent {}: {e}", parent.display()))?;
        }
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("create {out_path:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {out_path:?}: {e}"))?;
    }

    validate_managed_node_dir(staged_node_dir)
}

#[cfg(windows)]
fn ensure_node_version(node_exe: &Path, expected_version: &str) -> Result<(), String> {
    let output = Command::new(node_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", node_exe.display()))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && version == expected_version {
        Ok(())
    } else {
        Err(format!(
            "managed Node version check failed: expected {expected_version}, got '{version}'"
        ))
    }
}

#[cfg(windows)]
async fn install_managed_node<R: tauri::Runtime>(
    app: &AppHandle<R>,
    replace_existing: bool,
) -> Result<String, String> {
    let arch = managed_node_arch().ok_or_else(|| {
        format!(
            "Unsupported architecture for managed Node fallback: {}",
            std::env::consts::ARCH
        )
    })?;
    let version = WINDOWS_MANAGED_NODE_VERSION;
    let node_dir = managed_node_dir();
    let node_exe = node_dir.join("node.exe");
    // Capture the target before any network or extraction work. A forced repair
    // may accept a valid node.exe after a failed swap only if another process
    // actually replaced the file while this attempt was in flight.
    let original_node_digest = managed_node_sha256(&node_exe)?;
    let expected_sha = windows_managed_node_sha256_for(arch)
        .ok_or_else(|| format!("No pinned Node checksum for Windows arch {arch}"))?;
    let url = format!("https://nodejs.org/dist/{version}/node-{version}-win-{arch}.zip");

    emit_progress(app, &format!("Downloading {url}"));
    let url_for_dl = url.clone();
    let bytes =
        tokio::task::spawn_blocking(move || download_bytes_checked(&url_for_dl, "Node zip"))
            .await
            .map_err(|e| format!("node download task join failed: {e}"))??;
    emit_progress(app, &format!("Downloaded {} bytes", bytes.len()));
    verify_sha256_bytes("Node zip", &bytes, expected_sha)?;

    let target = managed_toolchain_dir();
    std::fs::create_dir_all(&target).map_err(|e| format!("Failed to mkdir {target:?}: {e}"))?;

    // Clear any staged/backup trees a previous interrupted or denied repair
    // stranded here before we add our own, bounded so a concurrent install's
    // in-flight tree is never swept.
    sweep_stale_toolchain_siblings(&target, crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN);

    let staged_node_dir = target.join(format!(".node-install-{}", Uuid::new_v4()));
    emit_progress(app, &format!("Extracting Node into {staged_node_dir:?}..."));
    if let Err(e) = extract_managed_node_zip(&bytes, version, arch, &staged_node_dir) {
        let _ = std::fs::remove_dir_all(&staged_node_dir);
        return Err(e);
    }
    if let Err(e) = ensure_node_version(&staged_node_dir.join("node.exe"), version) {
        let _ = std::fs::remove_dir_all(&staged_node_dir);
        return Err(e);
    }

    // A usable managed Node may already be at the target — another HQ process
    // won the race while we were downloading (the repair slot cannot serialize
    // two processes). Accept it rather than fight an open-handle swap, but only
    // if it passes the SAME version check the staged tree did.
    if managed_node_should_be_reused(replace_existing, &node_exe, |exe| {
        ensure_node_version(exe, version).is_ok()
    }) {
        let _ = std::fs::remove_dir_all(&staged_node_dir);
        append_user_path(&node_dir)?;
        append_user_path(&managed_npm_bin())?;
        return Ok(format!("Managed Node already present at {node_dir:?}"));
    }

    if let Err(e) = activate_staged_dir(&staged_node_dir, &node_dir) {
        // Lost an activation race: another HQ process may have activated a valid
        // managed Node into the target between our probe and our swap. A forced
        // repair accepts it only when the executable changed after our snapshot.
        let current_node_digest = match managed_node_sha256(&node_exe) {
            Ok(digest) => digest,
            Err(fingerprint_error) => {
                return Err(format!(
                    "{e}; could not verify whether a concurrent Node repair replaced the target: {fingerprint_error}"
                ));
            }
        };
        if managed_node_changed_since_repair_started(
            original_node_digest.as_deref(),
            current_node_digest.as_deref(),
        ) && managed_node_already_usable(&node_exe, |exe| {
            ensure_node_version(exe, version).is_ok()
        }) {
            append_user_path(&node_dir)?;
            append_user_path(&managed_npm_bin())?;
            return Ok(format!("Managed Node already present at {node_dir:?}"));
        }
        return Err(e);
    }

    append_user_path(&node_dir)?;
    append_user_path(&managed_npm_bin())?;

    Ok(format!("Managed Node installed at {node_dir:?}"))
}

#[cfg(windows)]
fn validate_managed_git_dir(git_dir: &Path) -> Result<(), String> {
    for path in [
        git_dir.join("cmd").join("git.exe"),
        git_dir.join("mingw64").join("bin").join("git.exe"),
    ] {
        if !path.is_file() {
            return Err(format!(
                "managed Git missing required file {}",
                path.display()
            ));
        }
    }
    Ok(())
}

/// Extract a MinGit zip. Unlike the Node archive, MinGit has no single top-level
/// root dir — entries are `cmd/...`, `mingw64/...`, etc. at the archive root — so
/// we extract relative paths directly into the staging dir.
#[cfg(windows)]
fn extract_mingit_zip(bytes: &[u8], staged_git_dir: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open Git zip: {e}"))?;

    std::fs::create_dir_all(staged_git_dir)
        .map_err(|e| format!("mkdir {}: {e}", staged_git_dir.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("git zip entry {i}: {e}"))?;
        let raw_name = entry.name().to_string();
        if zip_raw_name_has_unsafe_component(&raw_name) {
            return Err(format!("git zip entry has unsafe path: {raw_name}"));
        }
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("git zip entry has unsafe path: {raw_name}"))?
            .to_path_buf();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = staged_git_dir.join(&rel);
        if !out_path.starts_with(staged_git_dir) {
            return Err(format!("git zip entry escapes staging dir: {raw_name}"));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir parent {}: {e}", parent.display()))?;
        }
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("create {out_path:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {out_path:?}: {e}"))?;
    }

    validate_managed_git_dir(staged_git_dir)
}

#[cfg(windows)]
fn ensure_git_runs(git_exe: &Path, expected_version: &str) -> Result<(), String> {
    let output = Command::new(git_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", git_exe.display()))?;
    // `git --version` prints e.g. "git version 2.54.0.windows.1".
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && combined.contains(expected_version) {
        Ok(())
    } else {
        Err(format!(
            "managed Git version check failed: expected {expected_version}, got '{combined}'"
        ))
    }
}

#[cfg(windows)]
async fn install_managed_git(app: &AppHandle) -> Result<String, String> {
    let url = WINDOWS_MINGIT_URL.to_string();
    emit_progress(app, &format!("Downloading {url}"));
    let url_for_dl = url.clone();
    let bytes = tokio::task::spawn_blocking(move || download_bytes_checked(&url_for_dl, "Git zip"))
        .await
        .map_err(|e| format!("git download task join failed: {e}"))??;
    emit_progress(app, &format!("Downloaded {} bytes", bytes.len()));
    verify_sha256_bytes("Git zip", &bytes, WINDOWS_MINGIT_SHA256)?;

    let target = managed_toolchain_dir();
    std::fs::create_dir_all(&target).map_err(|e| format!("Failed to mkdir {target:?}: {e}"))?;

    let git_dir = managed_git_dir();
    let staged_git_dir = target.join(format!(".git-install-{}", Uuid::new_v4()));
    emit_progress(app, &format!("Extracting Git into {staged_git_dir:?}..."));
    if let Err(e) = extract_mingit_zip(&bytes, &staged_git_dir) {
        let _ = std::fs::remove_dir_all(&staged_git_dir);
        return Err(e);
    }
    if let Err(e) = ensure_git_runs(
        &staged_git_dir.join("cmd").join("git.exe"),
        WINDOWS_MINGIT_VERSION,
    ) {
        let _ = std::fs::remove_dir_all(&staged_git_dir);
        return Err(e);
    }
    activate_staged_dir(&staged_git_dir, &git_dir)?;

    append_user_path(&managed_git_cmd())?;
    append_user_path(&managed_git_mingw_bin())?;

    Ok(format!("Managed Git installed at {git_dir:?}"))
}

#[cfg(windows)]
fn managed_node_arch() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn install_pnpm(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing pnpm via npm...");
    let prefix = managed_npm_prefix();
    let prefix = prefix.to_string_lossy().into_owned();
    let result = run_managed_npm_install(
        &app,
        "npm",
        &prefix,
        "pnpm@9",
        "pnpm",
        "pnpm",
        &[],
        false,
    )
    .await?;

    append_user_path(&managed_npm_bin())?;
    Ok(result)
}

#[cfg(windows)]
async fn install_git_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Detecting package manager for Git install...");
    let pm = detect_package_manager();
    match pm {
        PackageManager::Winget => {
            emit_progress(&app, "Installing Git via winget...");
            match winget_install(&app, "Git.Git").await {
                Ok(_) => {
                    append_user_path(&program_files().join("Git").join("cmd"))?;
                    Ok("git installed via winget".to_string())
                }
                Err(error) => resolve_git_winget_install_failure(error, || {
                    dependency_defs()
                        .iter()
                        .find(|dep| dep.id == "git")
                        .is_some_and(|dep| dep_is_satisfied(&app, dep))
                }),
            }
        }
        PackageManager::Scoop => {
            emit_progress(&app, "Installing Git via scoop...");
            scoop_install(&app, "git").await?;
            append_user_path(&user_profile().join("scoop").join("shims"))?;
            Ok("git installed via scoop".to_string())
        }
        PackageManager::Managed => {
            emit_progress(
                &app,
                "No package manager found - downloading portable Git (MinGit)...",
            );
            install_managed_git(&app).await
        }
    }
}

#[cfg(windows)]
async fn install_gh_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Detecting package manager for GitHub CLI install...");
    let pm = detect_package_manager();
    match pm {
        PackageManager::Winget => {
            emit_progress(&app, "Installing GitHub CLI via winget...");
            winget_install(&app, "GitHub.cli").await?;
            append_user_path(&program_files().join("GitHub CLI"))?;
            Ok("gh installed via winget".to_string())
        }
        PackageManager::Scoop => {
            emit_progress(&app, "Installing GitHub CLI via scoop...");
            scoop_install(&app, "gh").await?;
            append_user_path(&user_profile().join("scoop").join("shims"))?;
            Ok("gh installed via scoop".to_string())
        }
        PackageManager::Managed => Err(
            "GitHub CLI is required for HQ template cloning. Install from https://cli.github.com or run `winget install --id GitHub.cli` once winget is available."
                .to_string(),
        ),
    }
}

#[cfg(windows)]
async fn install_yq_windows(app: AppHandle) -> Result<String, String> {
    let (arch, expected_sha) = match std::env::consts::ARCH {
        "x86_64" => ("amd64", WINDOWS_YQ_SHA256_AMD64),
        "aarch64" => ("arm64", WINDOWS_YQ_SHA256_ARM64),
        _ => {
            return Err(format!(
                "Unsupported architecture for yq install: {}",
                std::env::consts::ARCH
            ))
        }
    };
    let url = format!(
        "https://github.com/mikefarah/yq/releases/download/{WINDOWS_YQ_VERSION}/yq_windows_{arch}.exe"
    );

    emit_progress(&app, &format!("Downloading {url}..."));
    let url_owned = url.clone();
    let bytes = tokio::task::spawn_blocking(move || download_bytes_checked(&url_owned, "yq"))
        .await
        .map_err(|e| format!("yq download task join failed: {e}"))??;

    let bin_dir = managed_toolchain_dir().join("bin");
    let out = bin_dir.join("yq.exe");
    install_yq_windows_from_bytes(&bytes, expected_sha, &out, |staged| {
        ensure_yq_version(staged, WINDOWS_YQ_VERSION)
    })?;

    append_user_path(&bin_dir)?;
    Ok(format!("yq installed at {out:?}"))
}

#[cfg(windows)]
fn ensure_yq_version(yq_exe: &Path, expected_version: &str) -> Result<(), String> {
    let output = Command::new(yq_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", yq_exe.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() && combined.contains(expected_version) {
        Ok(())
    } else {
        Err(format!(
            "yq version check failed: expected {expected_version}, got '{}'",
            combined.lines().next().unwrap_or("").trim()
        ))
    }
}

#[cfg(windows)]
fn install_yq_windows_from_bytes<F>(
    bytes: &[u8],
    expected_sha: &str,
    target: &Path,
    version_check: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    verify_sha256_bytes("yq", bytes, expected_sha)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("yq target has no parent: {}", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to mkdir {parent:?}: {e}"))?;
    let staged = parent.join(format!(".yq.{}.tmp", Uuid::new_v4()));
    std::fs::write(&staged, bytes).map_err(|e| format!("Failed to write staged yq: {e}"))?;
    if let Err(e) = version_check(&staged) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    atomic_replace_file(&staged, target)
}

#[cfg(windows)]
async fn install_claude_code_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing Claude Code via npm...");
    let prefix = managed_npm_prefix();
    let prefix = prefix.to_string_lossy().into_owned();
    let result = run_managed_npm_install(
        &app,
        "npm",
        &prefix,
        "@anthropic-ai/claude-code",
        "@anthropic-ai/claude-code",
        "claude",
        &[],
        false,
    )
    .await?;
    append_user_path(&managed_npm_bin())?;
    Ok(result)
}

#[cfg(windows)]
async fn install_qmd_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing qmd via npm (@tobilu/qmd)...");
    let prefix = managed_npm_prefix();
    remove_managed_qmd_package(&prefix);
    let prefix = prefix.to_string_lossy().into_owned();
    let qmd_spec = format!("@tobilu/qmd@{MANAGED_QMD_VERSION}");
    let result = run_managed_npm_install(
        &app,
        "npm",
        &prefix,
        &qmd_spec,
        "@tobilu/qmd",
        "qmd",
        &["--no-audit", "--no-fund"],
        false,
    )
    .await?;
    append_user_path(&managed_npm_bin())?;

    write_qmd_bash_shim()?;

    Ok(result)
}

#[cfg(windows)]
fn write_qmd_bash_shim() -> Result<(), String> {
    let prefix = managed_npm_prefix();
    write_qmd_bash_shim_in(&prefix, git_bash_path().as_deref())
}

#[cfg(windows)]
fn write_qmd_bash_shim_in(prefix: &Path, bash_path: Option<&Path>) -> Result<(), String> {
    // npm may leave a qmd.cmd shim that resolves by name but still targets a
    // removed package or uses a launcher that cannot run this package's POSIX
    // entry point. Verify the target before writing a Git Bash launcher; when
    // Git Bash is absent, keep a valid Node-based npm shim instead.
    let bin_candidates = [
        prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("bin")
            .join("qmd"),
        prefix
            .join("node_modules")
            .join("qmd")
            .join("bin")
            .join("qmd"),
    ];
    let bin_rel: &str = if bin_candidates[0].exists() {
        r"node_modules\@tobilu\qmd\bin\qmd"
    } else if bin_candidates[1].exists() {
        r"node_modules\qmd\bin\qmd"
    } else {
        return Err(format!(
            "qmd bin not found at {:?} or {:?} (npm install incomplete)",
            bin_candidates[0], bin_candidates[1]
        ));
    };

    let cmd_path = prefix.join("qmd.cmd");
    // Resolve Git Bash to an absolute path at install time. A bare `bash` in
    // the shim resolves through the USER's shell PATH at run time, where
    // `C:\Windows\System32\bash.exe` (the WSL launcher) precedes Git's bash on
    // any machine with WSL enabled — and WSL bash cannot run a Windows-path
    // script argument (the INS-0580 failure class). If Git Bash is absent,
    // npm's Node-based shim remains usable and must not be replaced by a bare
    // `bash` invocation that may resolve to WSL or nothing at all.
    let Some(bash) = bash_path else {
        let npm_shim_references_entry = std::fs::read_to_string(&cmd_path)
            .ok()
            .is_some_and(|shim| qmd_npm_shim_references_entry(&shim, bin_rel));
        if npm_shim_references_entry {
            return Ok(());
        }
        return Err(
            "qmd.cmd does not reference the installed package entry point, and Git Bash is unavailable"
                .to_string(),
        );
    };
    let body = format!(
        "@ECHO off\r\n\
        SETLOCAL\r\n\
        \"{}\" \"%~dp0{bin_rel}\" %*\r\n",
        bash.display()
    );
    std::fs::write(&cmd_path, body).map_err(|e| format!("write {cmd_path:?}: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn qmd_npm_shim_references_entry(shim: &str, bin_rel: &str) -> bool {
    let normalized_shim = shim.replace('/', "\\").to_ascii_lowercase();
    let normalized_entry = bin_rel.replace('/', "\\").to_ascii_lowercase();
    normalized_shim.match_indices(&normalized_entry).any(|(index, _)| {
        let suffix = &normalized_shim[index + normalized_entry.len()..];
        suffix.is_empty()
            || suffix.as_bytes().first().is_some_and(|byte| {
                *byte == b'"' || *byte == b'%' || byte.is_ascii_whitespace()
            })
    })
}

/// Absolute path to Git for Windows' bash.exe, if one exists. Never returns
/// the WSL launcher (`System32\bash.exe`). Prefers the bash sitting next to
/// whichever `git.exe` the engine's search path resolves, then well-known
/// install locations.
#[cfg(windows)]
fn git_bash_path() -> Option<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Ok(git) = which::which_in("git", Some(extended_search_path()), &cwd) {
        // <root>\cmd\git.exe or <root>\bin\git.exe -> <root>\bin\bash.exe
        if let Some(root) = git.parent().and_then(|p| p.parent()) {
            let bash = root.join("bin").join("bash.exe");
            if bash.is_file() {
                return Some(bash);
            }
        }
    }
    let candidates = [
        program_files().join("Git").join("bin").join("bash.exe"),
        local_app_data()
            .join("Programs")
            .join("Git")
            .join("bin")
            .join("bash.exe"),
    ];
    candidates.into_iter().find(|c| c.is_file())
}

#[cfg(windows)]
const RSYNC_BUNDLE_URL: &str = "https://github.com/small-tech/portable-rsync-with-ssh-for-windows/archive/0fc67b2e08ac0b1740982bcec16b3f2eb26151fa.zip";

/// Result of the rsync preflight that precedes a Core rescue.
///
/// `AlreadyRescueReady` and `Provisioned` permit the rescue to spawn. The
/// remaining variants are hard pre-rescue failures and keep the rescue from
/// starting.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RsyncRescueProvisioning {
    AlreadyRescueReady,
    ShimRefreshed,
    Provisioned,
    ProvisioningTimedOut,
    ProvisioningFailed(String),
    ProvisionedButNotRescueReady,
}

/// The result of applying the Core-update-specific provisioning deadline.
///
/// Kept separate from the final rescue readiness outcome so the pure decision
/// helper can receive a deterministic deadline in tests.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RsyncRescueProvisioningAttempt {
    Completed(Result<(), String>),
    TimedOut,
}

/// Apply the rescue dependency provisioning policy with injected probes. The
/// production Windows path supplies a probe for a real `rsync.exe` on the
/// rescue child PATH; tests use temporary fake executable state.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) async fn ensure_rsync_for_core_update_rescue_with<P, F, Fut, B, BFut>(
    mut is_rescue_ready: P,
    provision: F,
    provision_deadline: Duration,
    provision_within_deadline: B,
) -> RsyncRescueProvisioning
where
    P: FnMut() -> bool,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
    B: FnOnce(Fut, Duration) -> BFut,
    BFut: Future<Output = RsyncRescueProvisioningAttempt>,
{
    if is_rescue_ready() {
        return RsyncRescueProvisioning::AlreadyRescueReady;
    }

    match provision_within_deadline(provision(), provision_deadline).await {
        RsyncRescueProvisioningAttempt::Completed(Ok(())) if is_rescue_ready() => {
            RsyncRescueProvisioning::Provisioned
        }
        RsyncRescueProvisioningAttempt::Completed(Ok(())) => {
            RsyncRescueProvisioning::ProvisionedButNotRescueReady
        }
        RsyncRescueProvisioningAttempt::Completed(Err(reason)) => {
            RsyncRescueProvisioning::ProvisioningFailed(reason)
        }
        RsyncRescueProvisioningAttempt::TimedOut => RsyncRescueProvisioning::ProvisioningTimedOut,
    }
}

#[cfg(test)]
mod poison_recovery_tests {
    use super::*;

    #[test]
    fn setup_command_diagnostic_recovers_a_poisoned_mutex() {
        let collector = SetupDiagnosticCollector::new();
        let poisoned = collector.clone();
        let panic = std::thread::spawn(move || {
            let _guard = poisoned.command_failure.lock().unwrap();
            panic!("poison setup command diagnostic");
        })
        .join();
        assert!(panic.is_err());

        let diagnostic = SetupCommandDiagnostic {
            command: "npm install hq".to_string(),
            exit_code: Some(1),
            stdout: "out".to_string(),
            stderr: "err".to_string(),
            error: "install failed".to_string(),
        };
        collector.record(diagnostic.clone());
        assert_eq!(collector.current(), Some(diagnostic.clone()));
        assert_eq!(collector.take(), Some(diagnostic));
        collector.clear();
        assert_eq!(collector.current(), None);
    }
}

#[cfg(test)]
mod rsync_core_update_rescue_tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    struct NoopWaker;

    impl Wake for NoopWaker {
        fn wake(self: Arc<Self>) {}
    }

    fn block_on_ready<T>(future: impl Future<Output = T>) -> T {
        let waker = Waker::from(Arc::new(NoopWaker));
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);

        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("rsync rescue test fixture must resolve immediately"),
        }
    }

    #[test]
    fn healthy_real_executable_skips_download_and_allows_rescue() {
        let provision_calls = Cell::new(0);

        let outcome = block_on_ready(ensure_rsync_for_core_update_rescue_with(
            || true,
            || {
                provision_calls.set(provision_calls.get() + 1);
                async { Ok(()) }
            },
            Duration::ZERO,
            |provision, _deadline| async move {
                RsyncRescueProvisioningAttempt::Completed(provision.await)
            },
        ));

        assert_eq!(outcome, RsyncRescueProvisioning::AlreadyRescueReady);
        assert_eq!(
            provision_calls.get(),
            0,
            "a healthy real rsync must not download a bundle"
        );
    }

    #[test]
    fn shim_only_state_downloads_then_allows_rescue_after_a_second_probe() {
        let probe_calls = Cell::new(0);

        let outcome = block_on_ready(ensure_rsync_for_core_update_rescue_with(
            || {
                probe_calls.set(probe_calls.get() + 1);
                probe_calls.get() == 2
            },
            || async { Ok(()) },
            Duration::ZERO,
            |provision, _deadline| async move {
                RsyncRescueProvisioningAttempt::Completed(provision.await)
            },
        ));

        assert_eq!(outcome, RsyncRescueProvisioning::Provisioned);
        assert_eq!(
            probe_calls.get(),
            2,
            "provisioning must re-probe rsync before trusting it"
        );
    }

    #[test]
    fn successful_provisioning_that_does_not_resolve_rsync_is_reported() {
        let outcome = block_on_ready(ensure_rsync_for_core_update_rescue_with(
            || false,
            || async { Ok(()) },
            Duration::ZERO,
            |provision, _deadline| async move {
                RsyncRescueProvisioningAttempt::Completed(provision.await)
            },
        ));

        assert_eq!(
            outcome,
            RsyncRescueProvisioning::ProvisionedButNotRescueReady
        );
    }

    #[test]
    fn provisioning_failure_preserves_the_reason() {
        let reason = "portable rsync archive returned HTTP 503".to_string();

        let outcome = block_on_ready(ensure_rsync_for_core_update_rescue_with(
            || false,
            move || async move { Err(reason) },
            Duration::ZERO,
            |provision, _deadline| async move {
                RsyncRescueProvisioningAttempt::Completed(provision.await)
            },
        ));

        assert_eq!(
            outcome,
            RsyncRescueProvisioning::ProvisioningFailed(
                "portable rsync archive returned HTTP 503".to_string()
            )
        );
    }

    #[test]
    fn failed_download_blocks_rescue_and_preserves_the_reason() {
        let provision_calls = Cell::new(0);
        let deadline_calls = Cell::new(0);
        let deadline_seen = Cell::new(None);

        let outcome = block_on_ready(ensure_rsync_for_core_update_rescue_with(
            || false,
            || {
                provision_calls.set(provision_calls.get() + 1);
                async { std::future::pending::<Result<(), String>>().await }
            },
            Duration::ZERO,
            |_, deadline| {
                deadline_calls.set(deadline_calls.get() + 1);
                deadline_seen.set(Some(deadline));
                async { RsyncRescueProvisioningAttempt::TimedOut }
            },
        ));

        assert_eq!(outcome, RsyncRescueProvisioning::ProvisioningTimedOut);
        assert_eq!(provision_calls.get(), 1);
        assert_eq!(
            deadline_calls.get(),
            1,
            "the injected deadline must finish the preflight without waiting for setup retries"
        );
        assert_eq!(deadline_seen.get(), Some(Duration::ZERO));
    }
}

/// Windows preflight for the Core-update rescue. The child receives
/// `child_path()`, so the check must inspect that exact PATH and must reject
/// the npm-prefix shims when no real `rsync.exe` is present.
#[cfg(windows)]
pub(crate) async fn ensure_rsync_for_core_update_rescue() -> RsyncRescueProvisioning {
    if rescue_rsync_is_ready().await.is_ok() {
        return RsyncRescueProvisioning::AlreadyRescueReady;
    }

    match tokio::time::timeout(
        CORE_UPDATE_RSYNC_PROVISION_TIMEOUT,
        install_rsync_with_progress_for_core_update(|message| {
            crate::util::logfile::log(
                "hq-core-update",
                &format!("rsync provisioning: {message}"),
            );
        }),
    )
    .await
    {
        Ok(Ok(())) if rescue_rsync_is_ready().await.is_ok() => {
            RsyncRescueProvisioning::Provisioned
        }
        Ok(Ok(())) => RsyncRescueProvisioning::ProvisionedButNotRescueReady,
        Ok(Err(reason)) => RsyncRescueProvisioning::ProvisioningFailed(reason),
        Err(_) => RsyncRescueProvisioning::ProvisioningTimedOut,
    }
}

/// Bounds the required Core-update preflight instead of inheriting setup's
/// three 180-second download attempts.
#[cfg(windows)]
pub(crate) const CORE_UPDATE_RSYNC_PROVISION_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(windows)]
const CORE_UPDATE_RSYNC_VERSION_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(windows)]
#[allow(dead_code)]
async fn provision_rsync_for_core_update_within_deadline<Fut>(
    provision: Fut,
    deadline: Duration,
) -> RsyncRescueProvisioningAttempt
where
    Fut: Future<Output = Result<(), String>>,
{
    match tokio::time::timeout(deadline, provision).await {
        Ok(result) => RsyncRescueProvisioningAttempt::Completed(result),
        Err(_) => RsyncRescueProvisioningAttempt::TimedOut,
    }
}

#[cfg(windows)]
fn rescue_rsync_executable() -> Option<PathBuf> {
    std::env::split_paths(&hq_desktop_core::paths::child_path())
        .map(|dir| dir.join("rsync.exe"))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
async fn rescue_rsync_is_ready() -> Result<(), String> {
    let executable = rescue_rsync_executable()
        .ok_or_else(|| "no real rsync.exe exists on the rescue child PATH".to_string())?;
    let result = tokio::time::timeout(
        CORE_UPDATE_RSYNC_VERSION_TIMEOUT,
        tokio::task::spawn_blocking(move || ensure_rsync_version(&executable)),
    )
    .await
    .map_err(|_| "rsync --version timed out after 10 seconds".to_string())?
    .map_err(|error| format!("rsync version probe task failed: {error}"))?;
    result
}

#[cfg(windows)]
#[tauri::command]
pub async fn install_rsync(app: AppHandle) -> Result<String, String> {
    install_rsync_with_progress(|message| emit_progress(&app, message)).await
}

#[cfg(windows)]
async fn install_rsync_with_progress(mut progress: impl FnMut(&str)) -> Result<String, String> {
    install_rsync_with_progress_inner(&mut progress, false).await
}

#[cfg(windows)]
async fn install_rsync_with_progress_for_core_update(
    mut progress: impl FnMut(&str),
) -> Result<(), String> {
    install_rsync_with_progress_inner(&mut progress, true)
        .await
        .map(|_| ())
}

#[cfg(windows)]
async fn install_rsync_with_progress_inner(
    progress: &mut impl FnMut(&str),
    force_bundle_install: bool,
) -> Result<String, String> {
    let managed_rsync = managed_toolchain_dir().join("bin").join("rsync.exe");
    let probe = check_dep_impl("rsync", None);
    if !force_bundle_install && probe.installed && !managed_rsync.exists() {
        progress("rsync already installed");
        write_rsync_shim()?;
        return Ok("rsync already present; path shim refreshed".to_string());
    }

    let url = std::env::var("HQ_RSYNC_URL").unwrap_or_else(|_| RSYNC_BUNDLE_URL.to_string());
    progress(&format!("Downloading portable rsync from {url}"));

    let bin_dir = managed_toolchain_dir().join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to mkdir {bin_dir:?}: {e}"))?;

    let url_for_dl = url.clone();
    let bytes =
        tokio::task::spawn_blocking(move || download_bytes_checked(&url_for_dl, "rsync bundle"))
            .await
            .map_err(|e| format!("rsync download task join failed: {e}"))??;
    verify_sha256_bytes("rsync bundle", &bytes, RSYNC_BUNDLE_SHA256)?;

    progress("Extracting rsync bundle...");
    let staged_bin = managed_toolchain_dir().join(format!(".rsync-bin-{}", Uuid::new_v4()));
    if let Err(e) = extract_rsync_zip_to_bin(&bytes, &staged_bin) {
        let _ = std::fs::remove_dir_all(&staged_bin);
        return Err(e);
    }
    if let Err(e) = ensure_rsync_version(&staged_bin.join("rsync.exe")) {
        let _ = std::fs::remove_dir_all(&staged_bin);
        return Err(e);
    }
    activate_staged_bin_files(&staged_bin, &bin_dir)?;

    append_user_path(&bin_dir)?;

    write_rsync_shim()?;

    Ok(format!("rsync extracted to {bin_dir:?}; path shim wired"))
}

#[cfg(windows)]
fn extract_rsync_zip_to_bin(bytes: &[u8], staged_bin: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid rsync zip: {e}"))?;
    std::fs::create_dir_all(staged_bin).map_err(|e| format!("mkdir {staged_bin:?}: {e}"))?;

    let mut extracted_rsync_exe = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("rsync zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        if zip_raw_name_has_unsafe_component(&raw_name) {
            return Err(format!("rsync zip entry has unsafe path: {raw_name}"));
        }
        let rel_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("rsync zip entry has unsafe path: {raw_name}"))?
            .to_path_buf();

        let comps: Vec<_> = rel_name.components().collect();
        let bin_idx = comps.iter().position(
            |c| matches!(c, std::path::Component::Normal(s) if s.eq_ignore_ascii_case("bin")),
        );
        let Some(bi) = bin_idx else { continue };
        if comps.len() != bi + 2 {
            continue;
        }
        let std::path::Component::Normal(leaf) = comps[bi + 1] else {
            continue;
        };
        let dest = staged_bin.join(leaf);
        if !dest.starts_with(staged_bin) {
            return Err(format!("rsync zip entry escapes staging dir: {raw_name}"));
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("create {dest:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {dest:?}: {e}"))?;
        if leaf.eq_ignore_ascii_case("rsync.exe") {
            extracted_rsync_exe = true;
        }
    }

    if extracted_rsync_exe {
        Ok(())
    } else {
        Err(
            "rsync bundle did not contain bin/rsync.exe - set HQ_RSYNC_URL to a different mirror"
                .to_string(),
        )
    }
}

#[cfg(windows)]
fn activate_staged_bin_files(staged_bin: &Path, bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    for entry in std::fs::read_dir(staged_bin).map_err(|e| format!("read {staged_bin:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("read staged rsync entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("stat staged rsync entry {:?}: {e}", entry.path()))?;
        if !file_type.is_file() {
            continue;
        }
        let dest = bin_dir.join(entry.file_name());
        atomic_replace_file(&entry.path(), &dest)?;
    }
    std::fs::remove_dir_all(staged_bin)
        .map_err(|e| format!("remove staged rsync dir {staged_bin:?}: {e}"))
}

#[cfg(windows)]
fn ensure_rsync_version(rsync_exe: &Path) -> Result<(), String> {
    let output = Command::new(rsync_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", rsync_exe.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() && combined.to_ascii_lowercase().contains("rsync") {
        Ok(())
    } else {
        Err(format!(
            "rsync version check failed: '{}'",
            combined.lines().next().unwrap_or("").trim()
        ))
    }
}

#[cfg(windows)]
fn write_rsync_shim() -> Result<(), String> {
    let bin_dir = managed_npm_bin();
    write_rsync_shim_in(&bin_dir)
}

#[cfg(windows)]
fn write_rsync_shim_in(bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;

    let cmd_path = bin_dir.join("rsync.cmd");
    let ps1_path = bin_dir.join("rsync.ps1");

    let cmd_body = "@echo off\r\n\
        powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dpn0.ps1\" %*\r\n";
    std::fs::write(&cmd_path, cmd_body).map_err(|e| format!("write {cmd_path:?}: {e}"))?;

    let ps1_body = r#"# rsync.ps1 - Windows path translator for cwRsync
# Generated by hq-installer. Translates Windows absolute paths
# (X:\foo\bar) into cygwin paths (/cygdrive/x/foo/bar) before invoking
# cwRsync, which can't parse colons in args.

$translated = @()
foreach ($a in $args) {
    if ($a -match '^([A-Za-z]):[\\/](.*)$') {
        $drive = $matches[1].ToLower()
        $rest  = ($matches[2] -replace '\\', '/')
        $translated += "/cygdrive/$drive/$rest"
    } else {
        $translated += $a
    }
}

$managedRsync = Join-Path $env:LOCALAPPDATA 'IndigoHQ\toolchain\bin\rsync.exe'
$realRsync = $null
if (Test-Path $managedRsync) {
    $realRsync = $managedRsync
} else {
    $realRsync = (Get-Command rsync.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'IndigoHQ\\toolchain\\bin\\rsync\.(cmd|ps1)$' } | Select-Object -First 1).Source
}
if (-not $realRsync) {
    Write-Error 'rsync shim: real rsync.exe not found'
    exit 127
}

& $realRsync @translated
exit $LASTEXITCODE
"#;
    std::fs::write(&ps1_path, ps1_body).map_err(|e| format!("write {ps1_path:?}: {e}"))?;

    Ok(())
}

#[cfg(windows)]
fn write_shasum_shim() -> Result<(), String> {
    let bin_dir = managed_toolchain_dir().join("bin");
    write_shasum_shim_in(&bin_dir)
}

#[cfg(windows)]
fn write_shasum_shim_in(bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;

    let shim_path = bin_dir.join("shasum");
    let shim_body = "#!/usr/bin/env bash\n\
# shasum shim - HQ installer (Windows). Maps `shasum -a <algo>` onto the\n\
# native shaNsum tools Git Bash ships, so macOS-authored hq-core scripts run\n\
# unchanged. Generated by hq-installer deps.rs::write_shasum_shim.\n\
algo=256\n\
out=()\n\
while [ $# -gt 0 ]; do\n\
  case \"$1\" in\n\
    -a|--algorithm) algo=\"$2\"; shift 2 ;;\n\
    -a*) algo=\"${1#-a}\"; shift ;;\n\
    -b|-t|-U|-p|--binary|--text|--portable|--UNIVERSAL) shift ;;\n\
    *) out+=(\"$1\"); shift ;;\n\
  esac\n\
done\n\
case \"$algo\" in\n\
  1)   exec sha1sum \"${out[@]}\" ;;\n\
  224) exec sha224sum \"${out[@]}\" ;;\n\
  256) exec sha256sum \"${out[@]}\" ;;\n\
  384) exec sha384sum \"${out[@]}\" ;;\n\
  512) exec sha512sum \"${out[@]}\" ;;\n\
  *)   exec sha256sum \"${out[@]}\" ;;\n\
esac\n";
    std::fs::write(&shim_path, shim_body).map_err(|e| format!("write {shim_path:?}: {e}"))?;

    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn ensure_shims() -> Result<String, String> {
    write_rsync_shim()?;
    write_shasum_shim()?;
    Ok("shims ready".to_string())
}

#[cfg(windows)]
async fn install_hq_cli_windows(app: AppHandle) -> Result<String, String> {
    // Cross-process cli-update lock — same rationale and contract as the macOS
    // leg above. On the SETUP deps path we WAIT the holder out for a bounded
    // budget (HQ-DESKTOP-6J) instead of failing the deps stage, off the async
    // worker via spawn_blocking; the guard is held through the streamed install.
    let cancellation = InstallCancellationRegistration::new(&app);
    let lock_wait_budget = hq_desktop_core::cli_update_lock::CLI_INSTALL_LOCK_WAIT_BUDGET;
    let lock_wait_handle = cancellation.handle.clone();
    let result = async {
        let _install_lock = acquire_cli_install_lock_for_setup_with_budget(
            &app,
            &cancellation,
            lock_wait_budget,
            move |app, line| {
                // The frontend uses this signal only to keep the setup deps
                // timeout alive for this install handle; it is not telemetry.
                let _ = app.emit_to(
                    "main",
                    "setup:cli-install-lock-wait",
                    lock_wait_handle.clone(),
                );
                emit_progress(app, line);
            },
        )
        .await?;
        install_hq_cli_after_lock(
            || hq_cli_dependency_is_satisfied(&app),
            || async {
                if cancellation.is_cancelled() {
                    return Err(crate::commands::hq_cli_update::CLI_INSTALL_CANCELLED_MESSAGE.to_string());
                }
                emit_progress(&app, "Installing @indigoai-us/hq-cli from npmjs.org...");
                let prefix = managed_npm_prefix();
                let prefix = prefix.to_string_lossy().into_owned();
                let result_inner = run_managed_npm_install_with_cancellation(
                    &app,
                    "npm",
                    &prefix,
                    "@indigoai-us/hq-cli",
                    "@indigoai-us/hq-cli",
                    "hq",
                    &[
                        "--@indigoai-us:registry=https://registry.npmjs.org/",
                        "--registry=https://registry.npmjs.org/",
                    ],
                    false,
                    &cancellation,
                )
                .await?;
                append_user_path(&managed_npm_bin())?;
                patch_hq_cli_pack_install_rsync()?;
                Ok(result_inner)
            },
        )
        .await
    }
    .await;
    cancellation.finish(&app, result.as_ref().err().map(String::as_str));
    result
}

#[cfg(windows)]
fn patch_hq_cli_pack_install_rsync() -> Result<(), String> {
    let target = managed_npm_prefix()
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("dist")
        .join("commands")
        .join("pack-install.js");
    patch_hq_cli_pack_install_rsync_at(&target)
}

#[cfg(windows)]
fn patch_hq_cli_pack_install_rsync_at(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Err(format!("pack-install.js not found at {target:?}"));
    }

    let content = std::fs::read_to_string(target).map_err(|e| format!("read {target:?}: {e}"))?;

    const MARKER: &str = "/* hq-installer: rsync -> fs.cpSync patch applied */";
    if content.contains(MARKER) {
        return Ok(());
    }

    const NEEDLE_MULTI: &str = "execFileSync('rsync', [\n        '-a',\n        '--exclude=.git',\n        '--exclude=node_modules',\n        '--exclude=.DS_Store',\n        srcSlashed,\n        destSlashed,\n    ], { stdio: 'inherit' });";
    const NEEDLE_SIMPLE_DEST: &str =
        "execFileSync('rsync', ['-a', srcSlashed, destSlashed], { stdio: 'inherit' });";
    const NEEDLE_SIMPLE_STAGING: &str =
        "execFileSync('rsync', ['-a', srcSlashed, stagingSlashed], { stdio: 'inherit' });";

    let replace_multi = format!(
        "{MARKER}\n    fs.cpSync(srcSlashed, destSlashed, {{\n        recursive: true,\n        filter: (s) => {{\n            const b = path.basename(s);\n            return b !== '.git' && b !== 'node_modules' && b !== '.DS_Store';\n        }},\n    }});"
    );
    let replace_simple =
        |dest_var: &str| format!("fs.cpSync(srcSlashed, {dest_var}, {{ recursive: true }});");

    let mut matched_any = false;
    let mut patched = content.clone();
    if patched.contains(NEEDLE_MULTI) {
        patched = patched.replace(NEEDLE_MULTI, &replace_multi);
        matched_any = true;
    }
    if patched.contains(NEEDLE_SIMPLE_DEST) {
        patched = patched.replace(NEEDLE_SIMPLE_DEST, &replace_simple("destSlashed"));
        matched_any = true;
    }
    if patched.contains(NEEDLE_SIMPLE_STAGING) {
        patched = patched.replace(NEEDLE_SIMPLE_STAGING, &replace_simple("stagingSlashed"));
        matched_any = true;
    }

    if !matched_any {
        return Err("expected execFileSync('rsync', ...) blocks not found - \
             hq-cli may have changed its pack-install.js format. \
             Re-run installer or patch manually."
            .to_string());
    }

    std::fs::write(target, patched).map_err(|e| format!("write {target:?}: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct DepDef {
    id: &'static str,
    label: &'static str,
    binary: &'static str,
    optional: bool,
    depends_on: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DepInstallStatus {
    Ok,
    Skipped,
    /// A user stopped this dependency. It remains a terminal setup outcome for
    /// UI/recovery purposes, but telemetry treats it as control flow rather
    /// than a dependency-install error.
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DepInstallResult {
    id: &'static str,
    label: &'static str,
    optional: bool,
    status: DepInstallStatus,
    error: Option<String>,
}

const DEP_DEFS: &[DepDef] = &[
    DepDef {
        id: "node",
        label: "Node.js",
        binary: "node",
        optional: false,
        depends_on: &[],
    },
    DepDef {
        id: "yq",
        label: "yq",
        binary: "yq",
        optional: false,
        depends_on: &[],
    },
    DepDef {
        id: "qmd",
        label: "qmd",
        binary: "qmd",
        optional: false,
        depends_on: &["node", "git"],
    },
    DepDef {
        id: "hq-cli",
        label: "HQ CLI",
        binary: "hq",
        optional: false,
        depends_on: &["node"],
    },
    DepDef {
        id: "git",
        label: "Git",
        binary: "git",
        optional: false,
        depends_on: &[],
    },
    DepDef {
        id: "jq",
        label: "jq",
        binary: "jq",
        // Required on macOS (setup.sh + hooks need it; Sonoma ships none).
        // The Windows installer does not provision jq yet.
        optional: cfg!(windows),
        depends_on: &[],
    },
    DepDef {
        id: "gh",
        label: "GitHub CLI",
        binary: "gh",
        optional: true,
        depends_on: &[],
    },
    DepDef {
        id: "claude-code",
        label: "Claude Code",
        binary: "claude",
        optional: true,
        depends_on: &["node"],
    },
    DepDef {
        id: "homebrew",
        label: "Homebrew",
        binary: "brew",
        optional: true,
        depends_on: &[],
    },
];

/// Public, UI-agnostic view of the dependency registry — `(id, binary, optional)`.
///
/// Used by the headless install mode (`commands::headless_install`) so an
/// unattended VM run can probe every registry entry after `install_deps`
/// without the private `DepDef` type leaking out of this module.
pub fn dependency_registry() -> Vec<(&'static str, &'static str, bool)> {
    dependency_defs()
        .iter()
        .map(|d| (d.id, d.binary, d.optional))
        .collect()
}

fn dependency_defs() -> &'static [DepDef] {
    DEP_DEFS
}

fn skipped_optional_result(dep: &DepDef) -> DepInstallResult {
    DepInstallResult {
        id: dep.id,
        label: dep.label,
        optional: dep.optional,
        status: DepInstallStatus::Skipped,
        error: None,
    }
}

fn premark_optional_results(deps: &[DepDef]) -> HashMap<&'static str, DepInstallResult> {
    deps.iter()
        .filter(|dep| dep.optional)
        .map(|dep| (dep.id, skipped_optional_result(dep)))
        .collect()
}

fn ready_required_deps<'a>(
    deps: &'a [DepDef],
    result_by_id: &HashMap<&'static str, DepInstallResult>,
    ok_set: &HashSet<&'static str>,
) -> Vec<&'a DepDef> {
    deps.iter()
        .filter(|dep| {
            !dep.optional
                && !result_by_id.contains_key(dep.id)
                && dep.depends_on.iter().all(|parent| ok_set.contains(parent))
        })
        .collect()
}

fn blocked_required_results(
    deps: &[DepDef],
    result_by_id: &HashMap<&'static str, DepInstallResult>,
    ok_set: &HashSet<&'static str>,
) -> Vec<DepInstallResult> {
    deps.iter()
        .filter(|dep| !dep.optional && !result_by_id.contains_key(dep.id))
        .map(|dep| {
            let missing: Vec<&str> = dep
                .depends_on
                .iter()
                .copied()
                .filter(|parent| !ok_set.contains(parent))
                .collect();
            let error = if missing.is_empty() {
                "Dependency was not processed".to_string()
            } else {
                format!("Prerequisite not installed: {}", missing.join(", "))
            };
            DepInstallResult {
                id: dep.id,
                label: dep.label,
                optional: dep.optional,
                status: DepInstallStatus::Failed,
                error: Some(error),
            }
        })
        .collect()
}

fn result_from_install(
    dep: &DepDef,
    install_result: Result<(), String>,
    cancellation: Option<&InstallCancellation>,
) -> DepInstallResult {
    match install_result {
        Ok(()) => DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: DepInstallStatus::Ok,
            error: None,
        },
        Err(err) => DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: if cancellation.is_some() {
                DepInstallStatus::Cancelled
            } else {
                DepInstallStatus::Failed
            },
            error: Some(err),
        },
    }
}

fn is_cancelled_dependency_result(result: &DepInstallResult) -> bool {
    result.status == DepInstallStatus::Cancelled
}

fn is_terminal_dependency_failure(result: &DepInstallResult) -> bool {
    result.status == DepInstallStatus::Failed || is_cancelled_dependency_result(result)
}

fn is_blocked_dependency_result(result: &DepInstallResult) -> bool {
    result.error.as_deref().is_some_and(|error| error.starts_with("Prerequisite not installed:"))
}

/// True when a dependency "failed" only because the cross-process cli-update lock
/// was held by a concurrent installer — in practice the app's own background CLI
/// auto-updater — and this cycle was skipped BY DESIGN, not because the install
/// failed (HQ-DESKTOP-6J). Matched off the single `CLI_INSTALL_LOCK_SKIP_PREFIX`
/// that the lock's `Held` branch builds every skip message from, so producer and
/// consumer share one committed literal and cannot silently drift — pinned by
/// `cli_install_lock_skip_tests`. Only hq-cli contends on this lock, so this can
/// never mask another dependency's genuine failure.
fn is_concurrent_install_skip_result(result: &DepInstallResult) -> bool {
    result.error.as_deref().is_some_and(|error| {
        error.starts_with(crate::commands::hq_cli_update::CLI_INSTALL_LOCK_SKIP_PREFIX)
    })
}

const WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE: i32 = 0x8A15_005E_u32 as i32;
const QMD_POST_INSTALL_PROBE_COMMAND: &str = "qmd post-install probe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QmdPostInstallFailure {
    NotResolved,
    VersionMismatch,
    NativeAddonMismatch,
}

impl QmdPostInstallFailure {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotResolved => "qmd_not_resolved",
            Self::VersionMismatch => "qmd_version_mismatch",
            Self::NativeAddonMismatch => "qmd_native_addon_mismatch",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "qmd_not_resolved" => Some(Self::NotResolved),
            "qmd_version_mismatch" => Some(Self::VersionMismatch),
            "qmd_native_addon_mismatch" => Some(Self::NativeAddonMismatch),
            _ => None,
        }
    }
}

fn setup_error_kind(diagnostic: Option<&SetupCommandDiagnostic>) -> Option<&'static str> {
    let diagnostic = diagnostic?;
    if diagnostic.command == QMD_POST_INSTALL_PROBE_COMMAND {
        return QmdPostInstallFailure::from_str(&diagnostic.error)
            .map(QmdPostInstallFailure::as_str);
    }
    let is_winget = diagnostic.command.split_whitespace().next() == Some("winget");
    (is_winget && diagnostic.exit_code == Some(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE))
        .then_some("winget_pinned_certificate_mismatch")
}

fn setup_error_category(result: &DepInstallResult, diagnostic: Option<&SetupCommandDiagnostic>) -> OnboardingErrorCategory {
    // The status is set only from InstallCancellation, which is captured at the
    // streaming cancellation source. Never infer this category from the
    // rendered error string.
    if is_cancelled_dependency_result(result) {
        return OnboardingErrorCategory::Cancelled;
    }
    // A cli-update lock skip is a deliberate concurrent-install skip, never an
    // install failure. It carries no exit code, so classify it BEFORE the
    // exit_code branch; this is what keeps it off the error-level Sentry path.
    if is_concurrent_install_skip_result(result) {
        return OnboardingErrorCategory::ConcurrentInstall;
    }
    let preflight_disk_space_message =
        hq_desktop_core::installer_disk_space::install_disk_space_message();
    let refused_disk_space_preflight =
        result.error.as_deref() == Some(preflight_disk_space_message.as_str());
    let command_reported_disk_full = diagnostic.is_some_and(|diagnostic| {
        hq_desktop_core::installer_disk_space::is_disk_full_output(&diagnostic.stdout)
            || hq_desktop_core::installer_disk_space::is_disk_full_output(&diagnostic.stderr)
            || hq_desktop_core::installer_disk_space::is_disk_full_output(&diagnostic.error)
    });
    let result_reports_disk_full = result.error.as_deref().is_some_and(
        hq_desktop_core::installer_disk_space::is_disk_full_output,
    );
    if refused_disk_space_preflight || command_reported_disk_full || result_reports_disk_full {
        return OnboardingErrorCategory::DiskFull;
    }
    match setup_error_kind(diagnostic) {
        Some("winget_pinned_certificate_mismatch") => return OnboardingErrorCategory::Network,
        Some("qmd_not_resolved") => return OnboardingErrorCategory::NotFound,
        Some("qmd_version_mismatch" | "qmd_native_addon_mismatch") => {
            return OnboardingErrorCategory::Unknown;
        }
        _ => {}
    }
    if diagnostic.and_then(|diagnostic| diagnostic.exit_code).is_some() {
        return OnboardingErrorCategory::ExitNonzero;
    }
    let error = result.error.as_deref().unwrap_or_default().to_ascii_lowercase();
    if error.contains("checksum") { OnboardingErrorCategory::Checksum }
    else if error.contains("timed out") || error.contains("timeout") { OnboardingErrorCategory::Timeout }
    else if error.contains("permission") || error.contains("eacces") { OnboardingErrorCategory::Permission }
    else if error.contains("not found") || error.contains("enoent") { OnboardingErrorCategory::NotFound }
    else if error.contains("failed to spawn") { OnboardingErrorCategory::SpawnFailed }
    else if error.contains("network") || error.contains("connection") { OnboardingErrorCategory::Network }
    else { OnboardingErrorCategory::Unknown }
}

fn setup_flow_token(flow: &str) -> &'static str {
    match flow {
        "first_install" => "first_install",
        "first_launch" => "first_launch",
        "resume" => "resume",
        _ => "unknown",
    }
}

fn setup_correlation_id(value: &str) -> String {
    Uuid::parse_str(value).map(|uuid| uuid.to_string()).unwrap_or_else(|_| "unknown".to_string())
}

fn fallback_setup_command_diagnostic(result: &DepInstallResult) -> SetupCommandDiagnostic {
    SetupCommandDiagnostic {
        command: "installer internal operation".to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        error: result.error.clone().unwrap_or_else(|| "installation failed".to_string()),
    }
}

fn blocked_dependents_for(deps: &[DepDef], results: &HashMap<&'static str, DepInstallResult>, prerequisite: &'static str) -> Vec<&'static str> {
    deps.iter()
        .filter(|dep| dep.depends_on.contains(&prerequisite))
        .filter_map(|dep| results.get(dep.id).filter(|result| is_blocked_dependency_result(result)).map(|_| dep.id))
        .collect()
}

fn reportable_setup_failure_ids(deps: &[DepDef], results: &HashMap<&'static str, DepInstallResult>) -> Vec<&'static str> {
    deps.iter()
        .filter(|dep| !dep.optional)
        .filter_map(|dep| results.get(dep.id)
            .filter(|result| result.status == DepInstallStatus::Failed
                && !is_blocked_dependency_result(result)
                && !is_cancelled_dependency_result(result)
                && !is_concurrent_install_skip_result(result))
            .map(|_| dep.id))
        .collect()
}

struct SetupDependencyFailureReport {
    dependency: &'static str,
    category: OnboardingErrorCategory,
    diagnostic: SetupCommandDiagnostic,
    blocked_dependents: Vec<String>,
}

/// Build error-level dependency reports without consuming the command
/// diagnostics. The same diagnostic is needed immediately afterwards to
/// classify the onboarding stage detail.
fn setup_dependency_failure_reports(
    deps: &[DepDef],
    results: &HashMap<&'static str, DepInstallResult>,
    diagnostics: &HashMap<&'static str, SetupCommandDiagnostic>,
) -> Vec<SetupDependencyFailureReport> {
    reportable_setup_failure_ids(deps, results)
        .into_iter()
        .map(|dependency| {
            let result = results
                .get(dependency)
                .expect("reportable dependency has an install result");
            let diagnostic = diagnostics
                .get(dependency)
                .cloned()
                .unwrap_or_else(|| fallback_setup_command_diagnostic(result));
            SetupDependencyFailureReport {
                dependency,
                category: setup_error_category(result, Some(&diagnostic)),
                diagnostic,
                blocked_dependents: blocked_dependents_for(deps, results, dependency)
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            }
        })
        .collect()
}

struct SetupCancellationCleanupFailureReport {
    dependency: &'static str,
    cleanup: CancellationCleanupFailure,
    diagnostic: SetupCommandDiagnostic,
}

/// Cleanup failures are independent of the terminal dependency status. For
/// example, a direct-binary fallback can recover installation after Homebrew
/// failed to stop, but the failed cancellation is still actionable telemetry.
fn setup_cancellation_cleanup_failure_reports(
    results: &HashMap<&'static str, DepInstallResult>,
    diagnostics: &HashMap<&'static str, SetupCommandDiagnostic>,
    cancellations: &HashMap<&'static str, InstallCancellation>,
    cleanup_reported_by_id: &HashSet<&'static str>,
) -> Vec<SetupCancellationCleanupFailureReport> {
    cancellations
        .iter()
        .filter_map(|(&dependency, cancellation)| {
            let InstallCancellation::CleanupFailed(cleanup) = cancellation else {
                return None;
            };
            if cleanup_reported_by_id.contains(dependency) {
                return None;
            }
            let result = results
                .get(dependency)
                .expect("cancelled dependency has an install result");
            let diagnostic = diagnostics
                .get(dependency)
                .cloned()
                .unwrap_or_else(|| fallback_setup_command_diagnostic(result));
            Some(SetupCancellationCleanupFailureReport {
                dependency,
                cleanup: cleanup.clone(),
                diagnostic,
            })
        })
        .collect()
}

/// Emit the diagnostic envelope on the current Sentry hub. Callers that are on
/// the setup path must use `queue_setup_dependency_failure` instead.
fn send_setup_dependency_failure(scope: &OnboardingFailureScope, dependency: &'static str, category: OnboardingErrorCategory, diagnostic: SetupCommandDiagnostic, blocked_dependents: &[String]) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let os = os_info::get();
        let search_path = {
            #[cfg(windows)] { Some(extended_search_path()) }
            #[cfg(not(windows))] { None::<String> }
        };
        let is_qmd_post_install_probe = diagnostic.command == QMD_POST_INSTALL_PROBE_COMMAND;
        sentry::with_scope(|sentry_scope| {
            // Keep every dependency-install failure in one issue. Dependency,
            // category, and retry data remain structured context.
            let fingerprint =
                hq_telemetry::setup_failure_fingerprint(dependency, category.as_str());
            sentry_scope.set_fingerprint(Some(&fingerprint));
            sentry_scope.set_tag("setup_stage", "deps");
            sentry_scope.set_tag("setup_dependency", dependency);
            sentry_scope.set_tag("setup_error_category", category.as_str());
            if let Some(error_kind) = setup_error_kind(Some(&diagnostic)) {
                sentry_scope.set_tag("setup_error_kind", error_kind);
            }
            sentry_scope.set_tag("setup_execution", "attempted");
            sentry_scope.set_tag("setup_flow", setup_flow_token(&scope.flow));
            sentry_scope.set_tag("setup_attempt", scope.attempt_count.to_string());
            sentry_scope.set_tag("setup_os", os.os_type().to_string());
            sentry_scope.set_tag("setup_architecture", std::env::consts::ARCH);
            sentry_scope.set_extra("setup_run_id", sentry::protocol::Value::String(setup_correlation_id(&scope.setup_run_id)));
            sentry_scope.set_extra("setup_frontend_session_id", sentry::protocol::Value::String(setup_correlation_id(&scope.frontend_session_id)));
            sentry_scope.set_extra("setup_app_version", sentry::protocol::Value::String(crate::app_version::current().to_string()));
            sentry_scope.set_extra("setup_os_version", sentry::protocol::Value::String(os.version().to_string()));
            sentry_scope.set_extra("setup_command", sentry::protocol::Value::String(diagnostic.command));
            sentry_scope.set_extra("setup_exit_code", diagnostic.exit_code.map(|code| sentry::protocol::Value::Number(code.into())).unwrap_or(sentry::protocol::Value::Null));
            sentry_scope.set_extra("setup_stdout_tail", sentry::protocol::Value::String(diagnostic.stdout.clone()));
            sentry_scope.set_extra("setup_stderr_tail", sentry::protocol::Value::String(diagnostic.stderr));
            sentry_scope.set_extra("setup_error", sentry::protocol::Value::String(diagnostic.error));
            if is_qmd_post_install_probe && qmd_version_token_is_safe(&diagnostic.stdout) {
                sentry_scope.set_extra(
                    "setup_resolved_version",
                    sentry::protocol::Value::String(diagnostic.stdout),
                );
            }
            sentry_scope.set_extra("setup_blocked_dependents", sentry::protocol::Value::Array(blocked_dependents.iter().cloned().map(sentry::protocol::Value::String).collect()));
            sentry_scope.set_extra("setup_blocked_dependents_status", sentry::protocol::Value::String(if blocked_dependents.is_empty() { "none" } else { "blocked_by_failed_prerequisite" }.to_string()));
            if let Some(search_path) = search_path.filter(|_| !is_qmd_post_install_probe) {
                sentry_scope.set_extra("setup_resolved_search_path", sentry::protocol::Value::String(search_path));
            }
        }, || sentry::capture_message("Desktop setup dependency installation failed", sentry::Level::Error));
    }));
}

/// Queue a terminal setup failure without waiting for the Sentry transport.
///
/// Setup completion is more important than a diagnostic envelope: a disabled
/// client is a no-op, and a slow or panicking transport is isolated in this
/// detached reporter thread rather than delaying the setup command.
fn queue_setup_dependency_failure(scope: OnboardingFailureScope, dependency: &'static str, category: OnboardingErrorCategory, diagnostic: SetupCommandDiagnostic, blocked_dependents: Vec<String>) {
    let source_hub = sentry::Hub::current();
    if source_hub.client().is_none() {
        return;
    }
    let hub = Arc::new(sentry::Hub::new_from_top(source_hub));
    hq_telemetry::dispatch_sentry_report(move || {
        sentry::Hub::run(hub, || {
            send_setup_dependency_failure(&scope, dependency, category, diagnostic, &blocked_dependents);
        });
    });
}

/// Capture a cancellation cleanup failure independently from the user's
/// deliberate cancellation. The fingerprint deliberately carries only stable
/// facts (dependency, cleanup category, signal, OS error kind): a process-group
/// id is machine-specific and would fragment one defect into many issues.
fn send_setup_cancellation_cleanup_failure(
    scope: &OnboardingFailureScope,
    dependency: &'static str,
    cleanup: CancellationCleanupFailure,
    diagnostic: SetupCommandDiagnostic,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let os = os_info::get();
        let category = OnboardingErrorCategory::CancelCleanupFailed;
        let os_error_kind = cleanup.os_error_kind_token();
        let fingerprint = [
            dependency,
            category.as_str(),
            cleanup.signal.as_str(),
            os_error_kind.as_str(),
        ];
        let search_path = {
            #[cfg(windows)]
            {
                Some(extended_search_path())
            }
            #[cfg(not(windows))]
            {
                None::<String>
            }
        };
        sentry::with_scope(
            |sentry_scope| {
                sentry_scope.set_fingerprint(Some(&fingerprint));
                sentry_scope.set_tag("setup_stage", "deps");
                sentry_scope.set_tag("setup_dependency", dependency);
                sentry_scope.set_tag("setup_error_category", category.as_str());
                sentry_scope.set_tag("setup_execution", "cancel-cleanup");
                sentry_scope.set_tag("setup_flow", setup_flow_token(&scope.flow));
                sentry_scope.set_tag("setup_attempt", scope.attempt_count.to_string());
                sentry_scope.set_tag("setup_os", os.os_type().to_string());
                sentry_scope.set_tag("setup_architecture", std::env::consts::ARCH);
                sentry_scope.set_tag("setup_cancel_signal", cleanup.signal.as_str());
                sentry_scope.set_tag(
                    "setup_cancel_os_error_kind",
                    os_error_kind.clone(),
                );
                sentry_scope.set_extra(
                    "setup_run_id",
                    sentry::protocol::Value::String(setup_correlation_id(&scope.setup_run_id)),
                );
                sentry_scope.set_extra(
                    "setup_frontend_session_id",
                    sentry::protocol::Value::String(setup_correlation_id(
                        &scope.frontend_session_id,
                    )),
                );
                sentry_scope.set_extra(
                    "setup_app_version",
                    sentry::protocol::Value::String(crate::app_version::current().to_string()),
                );
                sentry_scope.set_extra(
                    "setup_os_version",
                    sentry::protocol::Value::String(os.version().to_string()),
                );
                sentry_scope.set_extra(
                    "setup_command",
                    sentry::protocol::Value::String(diagnostic.command),
                );
                sentry_scope.set_extra(
                    "setup_exit_code",
                    diagnostic
                        .exit_code
                        .map(|code| sentry::protocol::Value::Number(code.into()))
                        .unwrap_or(sentry::protocol::Value::Null),
                );
                sentry_scope.set_extra(
                    "setup_stdout_tail",
                    sentry::protocol::Value::String(diagnostic.stdout),
                );
                sentry_scope.set_extra(
                    "setup_stderr_tail",
                    sentry::protocol::Value::String(diagnostic.stderr),
                );
                sentry_scope.set_extra(
                    "setup_error",
                    sentry::protocol::Value::String(diagnostic.error),
                );
                sentry_scope.set_extra(
                    "setup_blocked_dependents",
                    sentry::protocol::Value::Array(Vec::new()),
                );
                sentry_scope.set_extra(
                    "setup_blocked_dependents_status",
                    sentry::protocol::Value::String("none".to_string()),
                );
                sentry_scope.set_extra(
                    "setup_cancel_signal",
                    sentry::protocol::Value::String(cleanup.signal.as_str().to_string()),
                );
                sentry_scope.set_extra(
                    "setup_cancel_os_error_kind",
                    sentry::protocol::Value::String(os_error_kind.clone()),
                );
                if let Some(search_path) = search_path {
                    sentry_scope.set_extra(
                        "setup_resolved_search_path",
                        sentry::protocol::Value::String(search_path),
                    );
                }
            },
            || {
                sentry::capture_message(
                    "Desktop setup cancellation cleanup could leave an install process running",
                    sentry::Level::Error,
                )
            },
        );
    }));
}

/// Queue cancellation cleanup telemetry without delaying setup completion.
/// The user's cancellation remains terminal control flow regardless of whether
/// reporting can allocate a thread or reach Sentry.
fn queue_setup_cancellation_cleanup_failure(
    scope: OnboardingFailureScope,
    dependency: &'static str,
    cleanup: CancellationCleanupFailure,
    diagnostic: SetupCommandDiagnostic,
) {
    let source_hub = sentry::Hub::current();
    if source_hub.client().is_none() {
        return;
    }
    let hub = Arc::new(sentry::Hub::new_from_top(source_hub));
    hq_telemetry::dispatch_sentry_report(move || {
        sentry::Hub::run(hub, || {
            send_setup_cancellation_cleanup_failure(&scope, dependency, cleanup, diagnostic);
        });
    });
}

/// The telemetry payload available while a streaming installer is still alive.
/// A failed SIGTERM/SIGKILL may leave that child hung forever, so this must be
/// dispatched from the streaming loop instead of the post-exit aggregator.
struct ActiveCleanupFailureReport {
    scope: OnboardingFailureScope,
    dependency: &'static str,
    cleanup: CancellationCleanupFailure,
    diagnostic: SetupCommandDiagnostic,
}

fn fallback_cleanup_failure_diagnostic(
    cleanup: &CancellationCleanupFailure,
) -> SetupCommandDiagnostic {
    SetupCommandDiagnostic {
        command: "installer cancellation cleanup".to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        error: cleanup.description(),
    }
}

fn active_setup_cancellation_cleanup_failure_report(
    cleanup: CancellationCleanupFailure,
) -> Option<ActiveCleanupFailureReport> {
    let scope = ACTIVE_ONBOARDING_FAILURE_SCOPE
        .try_with(|scope| scope.clone())
        .ok()?;
    let dependency = ACTIVE_SETUP_DEPENDENCY
        .try_with(|dependency| *dependency)
        .ok()?;
    let diagnostic = ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR
        .try_with(SetupDiagnosticCollector::current)
        .ok()
        .flatten()
        .unwrap_or_else(|| fallback_cleanup_failure_diagnostic(&cleanup));
    Some(ActiveCleanupFailureReport {
        scope,
        dependency,
        cleanup,
        diagnostic,
    })
}

/// Queue an independent cleanup report as soon as termination fails. Returns
/// whether the command is running inside a setup dependency with reporting
/// context, which lets the final aggregator avoid sending a duplicate event.
fn report_active_setup_cancellation_cleanup_failure(cleanup: CancellationCleanupFailure) -> bool {
    let Some(report) = active_setup_cancellation_cleanup_failure_report(cleanup) else {
        return false;
    };
    queue_setup_cancellation_cleanup_failure(
        report.scope,
        report.dependency,
        report.cleanup,
        report.diagnostic,
    );
    true
}

fn emit_install_line<R: tauri::Runtime>(app: &AppHandle<R>, msg: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            setup_run_id: current_setup_run_id(),
            handle: "preflight".to_string(),
            line: msg.to_string(),
            finished: false,
            error: None,
        },
    );
}

fn emit_install_handle_started<R: tauri::Runtime>(app: &AppHandle<R>, handle: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            setup_run_id: current_setup_run_id(),
            handle: handle.to_string(),
            line: String::new(),
            finished: false,
            error: None,
        },
    );
}

/// Parse the major from `node --version` output (`v14.21.3` → `14`).
/// Unparseable strings return `None` so we treat them as not meeting the floor
/// rather than skipping a managed-Node install.
fn parse_dep_node_major(version_output: &str) -> Option<u32> {
    let s = version_output.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    s.split('.').next()?.parse::<u32>().ok()
}

fn node_version_meets_floor(version: Option<&str>) -> bool {
    version
        .and_then(parse_dep_node_major)
        .is_some_and(|major| major >= hq_desktop_core::hq_cli_update::MIN_NODE_MAJOR)
}

/// Whether this dep can be skipped because a usable copy is already on PATH.
///
/// Node is special: presence is not enough. HQ's sync runner needs Node 20+,
/// so a machine on Node 14 (or any unparseable version) still gets the
/// managed toolchain instead of being waved through as "installed".
fn dep_status_satisfies(dep: &DepDef, status: &DepStatus) -> bool {
    if !status.installed {
        return false;
    }
    if dep.id == "node" {
        return node_version_meets_floor(status.version.as_deref());
    }
    // A required tool that is on disk but cannot report a version does not
    // run (broken shebang target, stale stub, wrong arch). Treat it as
    // unsatisfied so the installer re-provisions instead of trusting it.
    if !dep.optional && status.version.is_none() {
        return false;
    }
    // qmd must be the pinned version: an old/foreign copy found off-PATH
    // (e.g. a ghost pnpm global) is not "installed" — re-provision into the
    // managed prefix. hq must live in HQ's managed toolchain: foreign copies
    // are exactly what the CLI updater collided with (2026-08-20 incident:
    // ghost pnpm install + uncoordinated updaters reinstalling 8×/hour).
    // Both surfaced by the install matrix `pnpm-global-ghost` profile.
    match dep.id {
        "qmd" => qmd_version_matches_pin(status.version.as_deref()),
        "hq-cli" => status
            .path
            .as_deref()
            .map(is_managed_toolchain_path)
            .unwrap_or(false),
        _ => true,
    }
}

/// `qmd 2.5.3 (abc123)` → matches when the second token equals the pin.
pub fn qmd_version_matches_pin(version: Option<&str>) -> bool {
    version
        .and_then(|v| v.split_whitespace().nth(1))
        .map(|v| v.trim_start_matches('v') == MANAGED_QMD_VERSION)
        .unwrap_or(false)
}

fn qmd_post_install_failure(status: &DepStatus) -> Option<QmdPostInstallFailure> {
    if !status.installed {
        return Some(QmdPostInstallFailure::NotResolved);
    }
    if !qmd_version_matches_pin(status.version.as_deref()) {
        return Some(QmdPostInstallFailure::VersionMismatch);
    }
    qmd_native_needs_rebuild(status).then_some(QmdPostInstallFailure::NativeAddonMismatch)
}

fn qmd_version_token_is_safe(token: &str) -> bool {
    if token.is_empty() || token.len() > 64 {
        return false;
    }
    let version = token.strip_prefix('v').unwrap_or(token);
    version.matches('.').count() >= 2
        && version
            .split(['.', '-', '+'])
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        && version
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_digit())
}

fn qmd_resolved_version_token(version_output: Option<&str>) -> Option<String> {
    let token = version_output?.split_whitespace().nth(1)?;
    qmd_version_token_is_safe(token).then(|| token.to_string())
}

fn qmd_post_install_diagnostic(
    failure: QmdPostInstallFailure,
    status: &DepStatus,
) -> SetupCommandDiagnostic {
    SetupCommandDiagnostic {
        command: QMD_POST_INSTALL_PROBE_COMMAND.to_string(),
        exit_code: None,
        stdout: qmd_resolved_version_token(status.version.as_deref()).unwrap_or_default(),
        stderr: String::new(),
        error: failure.as_str().to_string(),
    }
}

/// True when `path` is inside HQ's managed toolchain (any platform layout).
pub fn is_managed_toolchain_path(path: &std::path::Path) -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    #[cfg(not(windows))]
    let root = managed_toolchain_dir_in(&home);
    #[cfg(windows)]
    let root = managed_toolchain_dir();
    path.starts_with(&root)
}

fn dep_is_satisfied(app: &AppHandle, dep: &DepDef) -> bool {
    #[cfg(not(windows))]
    if dep.id == "hq-cli" && !bundled_hq_cli_ready(app) { return false; }
    // Setup npm installs need the npm bundled with HQ's pinned Node. A system
    // Node that passes the broad runtime floor can still be too old for the
    // system npm selected from /usr/local/bin, so it cannot satisfy this dep.
    #[cfg(not(windows))]
    if dep.id == "node" {
        return dirs::home_dir()
            .as_deref()
            .is_some_and(managed_node_toolchain_is_usable);
    }
    let status = check_dep_impl(dep.binary, None);
    if dep.id == "qmd" {
        return qmd_post_install_failure(&status).is_none();
    }
    if !dep_status_satisfies(dep, &status) {
        return false;
    }
    true
}

fn remove_managed_qmd_package(prefix: &Path) {
    for dir in hq_desktop_core::qmd_abi::managed_qmd_package_dirs(prefix) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn qmd_native_needs_rebuild(status: &DepStatus) -> bool {
    use hq_desktop_core::qmd_abi::{probe_qmd_bin, qmd_needs_rebuild, QmdAddonProbe};
    let version_ok = qmd_version_matches_pin(status.version.as_deref());
    let probe = match status.path.as_deref() {
        Some(path) => probe_qmd_bin(path, &extended_search_path()),
        None => QmdAddonProbe::MissingAddon,
    };
    qmd_needs_rebuild(version_ok, probe)
}

static QMD_ABI_REPAIR_STARTED: AtomicBool = AtomicBool::new(false);

/// Launch-time repair for a desktop-installed qmd whose sqlite addon was built
/// for a different Node ABI than HQ's managed Node. Runs once per process.
pub fn setup_qmd_abi_repair(app: &AppHandle) {
    if QMD_ABI_REPAIR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let _ = repair_qmd_native_abi_if_needed(&handle).await;
    });
}

pub(crate) async fn repair_qmd_native_abi_if_needed(app: &AppHandle) -> bool {
    let status = check_dep_impl("qmd", None);
    if !qmd_native_needs_rebuild(&status) {
        return false;
    }
    log(
        "qmd-abi",
        "desktop-installed qmd sqlite addon does not load under the current Node — rebuilding",
    );
    match install_qmd(app.clone()).await {
        Ok(_) => {
            log("qmd-abi", "qmd rebuild finished");
            true
        }
        Err(err) => {
            log("qmd-abi", &format!("qmd rebuild failed: {err}"));
            false
        }
    }
}

const HQ_CLI_ALREADY_INSTALLED_BY_CONCURRENT_UPDATER: &str =
    "HQ CLI already installed by concurrent updater";

/// Reuse the orchestrator's single satisfaction probe after the shared lock is
/// acquired. A successful competing updater must suppress the redundant npm
/// install, but an absent or unusable managed CLI must still fall through to it.
fn hq_cli_dependency_is_satisfied(app: &AppHandle) -> bool {
    let hq_cli = dependency_defs()
        .iter()
        .find(|dep| dep.id == "hq-cli")
        .expect("hq-cli is a registered dependency");
    dep_is_satisfied(app, hq_cli)
}

async fn install_hq_cli_after_lock<F, Fut>(
    is_satisfied: impl FnOnce() -> bool,
    install: F,
) -> Result<String, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    if is_satisfied() {
        return Ok(HQ_CLI_ALREADY_INSTALLED_BY_CONCURRENT_UPDATER.to_string());
    }
    install().await
}

fn finish_orchestrated_dep_install(
    label: &str,
    install_result: Result<String, String>,
    found_after_install: bool,
) -> Result<(), String> {
    match install_result {
        Ok(_) if found_after_install => Ok(()),
        Ok(_) => Err(format!("{label} was not found after install")),
        // An installer can leave a managed binary on the current process PATH
        // while failing to persist it for future shells. Do not turn that
        // failure into success through the post-install probe.
        Err(err) => Err(err),
    }
}

async fn install_orchestrated_dep(app: &AppHandle, dep: &DepDef) -> Result<(), String> {
    if dep_is_satisfied(app, dep) {
        return Ok(());
    }

    let install_result = match dep.id {
        #[cfg(not(windows))]
        "homebrew" => install_homebrew(app.clone()).await,
        "git" => install_git(app.clone()).await,
        "gh" => install_gh(app.clone()).await,
        "node" => install_node(app.clone()).await,
        "claude-code" => install_claude_code(app.clone()).await,
        "qmd" => install_qmd(app.clone()).await,
        "hq-cli" => install_hq_cli(app.clone()).await,
        "yq" => install_yq(app.clone()).await,
        "jq" => install_jq(app.clone()).await,
        _ => Err(format!("no installer registered for {}", dep.id)),
    };

    if dep.id == "qmd" {
        return match install_result {
            Err(err) => Err(err),
            Ok(_) => {
                let status = check_dep_impl(dep.binary, None);
                if let Some(failure) = qmd_post_install_failure(&status) {
                    let diagnostic = qmd_post_install_diagnostic(failure, &status);
                    let _ = ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.try_with(|collector| {
                        collector.record(diagnostic);
                    });
                    Err(format!("{} did not pass the post-install check", dep.label))
                } else {
                    Ok(())
                }
            }
        };
    }

    finish_orchestrated_dep_install(dep.label, install_result, dep_is_satisfied(app, dep))
}

#[tauri::command]
pub async fn install_deps(
    app: AppHandle,
    failure_scope: Option<crate::commands::install_stages::OnboardingFailureScope>,
) -> Result<(), String> {
    clear_onboarding_failure_detail("deps", failure_scope.as_ref());
    let deps = dependency_defs();
    let mut result_by_id = premark_optional_results(deps);
    let mut diagnostic_by_id: HashMap<&'static str, SetupCommandDiagnostic> = HashMap::new();
    let mut cancellation_by_id: HashMap<&'static str, InstallCancellation> = HashMap::new();
    let mut cleanup_reported_by_id: HashSet<&'static str> = HashSet::new();
    let mut ok_set: HashSet<&'static str> = HashSet::new();

    for dep in deps.iter().filter(|dep| dep.optional) {
        emit_install_line(
            &app,
            &format!("[{}] Optional dependency skipped: {}", dep.id, dep.label),
        );
    }

    loop {
        let ready = ready_required_deps(deps, &result_by_id, &ok_set);
        if ready.is_empty() {
            break;
        }

        let settled = join_all(ready.into_iter().map(|dep| {
            let app = app.clone();
            let failure_scope = failure_scope.clone();
            async move {
                let collector = SetupDiagnosticCollector::new();
                let cancellation_collector = InstallCancellationCollector::new();
                let install_result = ACTIVE_SETUP_DEPENDENCY
                    .scope(dep.id, async {
                        match failure_scope {
                            Some(scope) => {
                                ACTIVE_ONBOARDING_FAILURE_SCOPE
                                    .scope(
                                        scope,
                                        ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.scope(
                                            collector.clone(),
                                            ACTIVE_INSTALL_CANCELLATION_COLLECTOR.scope(
                                                cancellation_collector.clone(),
                                                install_orchestrated_dep(&app, dep),
                                            ),
                                        ),
                                    )
                                    .await
                            }
                            None => {
                                ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR
                                    .scope(
                                        collector.clone(),
                                        ACTIVE_INSTALL_CANCELLATION_COLLECTOR.scope(
                                            cancellation_collector.clone(),
                                            install_orchestrated_dep(&app, dep),
                                        ),
                                    )
                                    .await
                            }
                        }
                    })
                    .await;
                let cancellation = cancellation_collector.take();
                let cleanup_reported = cancellation_collector.cleanup_failure_reported();
                (
                    result_from_install(dep, install_result, cancellation.as_ref()),
                    collector.take(),
                    cancellation,
                    cleanup_reported,
                )
            }
        }))
        .await;

        for (result, diagnostic, cancellation, cleanup_reported) in settled {
            if result.status == DepInstallStatus::Ok {
                ok_set.insert(result.id);
            }
            if let Some(diagnostic) = diagnostic {
                diagnostic_by_id.insert(result.id, diagnostic);
            }
            if let Some(cancellation) = cancellation {
                cancellation_by_id.insert(result.id, cancellation);
            }
            if cleanup_reported {
                cleanup_reported_by_id.insert(result.id);
            }
            result_by_id.insert(result.id, result);
        }
    }

    // The shell PATH block used to be written only as a side effect of an
    // npm-global install, so a run where every dep was "already present"
    // (adopted from elsewhere) left the user's shell without the toolchain.
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        ensure_shell_path_configured(&home, &app);
    }

    for result in blocked_required_results(deps, &result_by_id, &ok_set) {
        if let Some(error) = result.error.as_deref() {
            emit_install_line(&app, &format!("[{}] {}", result.id, error));
        }
        result_by_id.insert(result.id, result);
    }

    let failures: Vec<String> = deps
        .iter()
        .filter_map(|dep| {
            let result = result_by_id.get(dep.id)?;
            if result.optional || !is_terminal_dependency_failure(result) {
                return None;
            }
            let summary = result
                .error
                .as_deref()
                .unwrap_or("installation failed")
                .lines()
                .next()
                .unwrap_or("installation failed")
                .trim();
            Some(format!("{}: {}", result.label, summary))
        })
        .collect();

    if let Some(scope) = failure_scope.as_ref() {
        for report in setup_cancellation_cleanup_failure_reports(
            &result_by_id,
            &diagnostic_by_id,
            &cancellation_by_id,
            &cleanup_reported_by_id,
        ) {
            queue_setup_cancellation_cleanup_failure(
                scope.clone(),
                report.dependency,
                report.cleanup,
                report.diagnostic,
            );
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        if let Some(scope) = failure_scope.as_ref() {
            for report in setup_dependency_failure_reports(deps, &result_by_id, &diagnostic_by_id) {
                queue_setup_dependency_failure(
                    scope.clone(),
                    report.dependency,
                    report.category,
                    report.diagnostic,
                    report.blocked_dependents,
                );
            }
        }
        if let Some(failed_dependency) = deps.iter().find_map(|dep| {
            let result = result_by_id.get(dep.id)?;
            (!dep.optional && is_terminal_dependency_failure(result)).then_some(dep.id)
        }) {
            let result = result_by_id
                .get(failed_dependency)
                .expect("failed dependency has an install result");
            let diagnostic = diagnostic_by_id.get(failed_dependency);
            record_onboarding_failure_detail_with_kind(
                "deps",
                failure_scope.as_ref(),
                Some(failed_dependency),
                setup_error_category(result, diagnostic),
                setup_error_kind(diagnostic),
            );
        }
        Err(format!(
            "Dependency install failed: {}",
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod install_deps_planner_tests {
    use super::*;

    #[test]
    fn path_persistence_failure_remains_fatal_after_the_managed_binary_is_visible() {
        let result = finish_orchestrated_dep_install(
            "Node.js",
            Err("PATH persistence failed".to_string()),
            true,
        );

        assert_eq!(result, Err("PATH persistence failed".to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn setup_fails_closed_when_only_system_npm_is_available() {
        const CHILD_ENV: &str = "HQ_SC014_NPM_SELECTION_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            let error = preferred_npm_binary()
                .expect_err("system npm must not replace the managed Node/npm pair");
            assert!(error.contains("managed Node.js"), "unexpected error: {error}");
            return;
        }

        // Isolate HOME and PATH in a child test process. The baseline selector
        // falls through to this fake system npm; the fixed selector reports
        // that HQ's managed Node/npm toolchain must be provisioned first.
        let home = tempfile::tempdir().expect("fixture home");
        let system_bin = tempfile::tempdir().expect("fixture system bin");
        let system_npm = system_bin.path().join("npm");
        std::fs::write(&system_npm, "#!/bin/sh\nexit 0\n").expect("write fake system npm");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&system_npm)
                .expect("stat fake system npm")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&system_npm, permissions).expect("make fake npm executable");
        }

        let test_binary = std::env::current_exe().expect("current test binary");
        let output = std::process::Command::new(test_binary)
            .arg("setup_fails_closed_when_only_system_npm_is_available")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .env("HOME", home.path())
            .env("PATH", system_bin.path())
            .env("SHELL", "/bin/sh")
            .output()
            .expect("run isolated selector test");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stdout.contains("running 1 test"),
            "child did not run the test:\n{stdout}\n{stderr}"
        );
        assert!(
            output.status.success(),
            "child rejected the invariant:\n{stdout}\n{stderr}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn managed_node_toolchain_requires_the_pinned_node_and_bundled_npm() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().expect("fixture home");
        let node_bin = managed_node_bin_in(home.path());
        std::fs::create_dir_all(&node_bin).expect("create managed node bin");
        let node = node_bin.join("node");
        let npm_invoked = home.path().join("npm-invoked-with-managed-node");
        let expected_arch = node_dist_arch_for(std::env::consts::ARCH)
            .expect("supported Node distribution architecture");
        std::fs::write(
            &node,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo {MANAGED_NODE_VERSION}; elif [ \"$1\" = \"-p\" ] && [ \"$2\" = \"process.arch\" ]; then echo {expected_arch}; else echo \"$2\" > '{}'; echo 11.0.0; fi\n",
                npm_invoked.display()
            ),
        )
        .expect("write fake managed node");
        let mut permissions = std::fs::metadata(&node)
            .expect("stat fake node")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&node, permissions).expect("make fake node executable");
        let npm = node_bin.join("npm");
        std::fs::write(&npm, "#!/usr/bin/env node\n// fake npm entrypoint\n")
            .expect("write bundled npm placeholder");
        let mut npm_permissions = std::fs::metadata(&npm)
            .expect("stat fake npm")
            .permissions();
        npm_permissions.set_mode(0o755);
        std::fs::set_permissions(&npm, npm_permissions).expect("make fake npm executable");

        assert!(managed_node_toolchain_is_usable(home.path()));

        assert_eq!(
            std::fs::read_to_string(&npm_invoked).expect("managed Node ran npm"),
            "--version\n"
        );

        std::fs::write(&npm, "#!/bin/sh\nexit 7\n").expect("write broken npm entrypoint");
        let mut npm_permissions = std::fs::metadata(&npm)
            .expect("stat broken npm")
            .permissions();
        npm_permissions.set_mode(0o755);
        std::fs::set_permissions(&npm, npm_permissions).expect("make broken npm executable");
        assert!(!managed_node_toolchain_is_usable(home.path()));

        std::fs::write(&npm, "#!/usr/bin/env node\n// fake npm entrypoint\n")
            .expect("restore npm entrypoint");
        let mut npm_permissions = std::fs::metadata(&npm)
            .expect("stat non-executable npm")
            .permissions();
        npm_permissions.set_mode(0o644);
        std::fs::set_permissions(&npm, npm_permissions)
            .expect("make npm non-executable");
        assert!(!managed_node_toolchain_is_usable(home.path()));

        std::fs::write(&node, "#!/bin/sh\necho v20.8.0\n").expect("write wrong-version node");
        assert!(!managed_node_toolchain_is_usable(home.path()));

        std::fs::remove_file(&npm).expect("remove bundled npm");
        assert!(!managed_node_toolchain_is_usable(home.path()));
    }

    #[tokio::test]
    async fn a_cli_satisfied_by_the_lock_holder_skips_the_second_npm_install() {
        let install_calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let calls_for_install = std::rc::Rc::clone(&install_calls);

        let result = install_hq_cli_after_lock(
            || true,
            move || {
                calls_for_install.set(calls_for_install.get() + 1);
                async { Err("a second npm install must not run".to_string()) }
            },
        )
        .await;

        assert_eq!(result, Ok("HQ CLI already installed by concurrent updater".to_string()));
        assert_eq!(install_calls.get(), 0, "the satisfied CLI must skip npm");
    }

    #[tokio::test]
    async fn a_missing_cli_after_the_lock_wait_still_runs_and_reports_a_failed_install() {
        let install_calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let calls_for_install = std::rc::Rc::clone(&install_calls);

        let install_result = install_hq_cli_after_lock(
            || false,
            move || {
                calls_for_install.set(calls_for_install.get() + 1);
                async { Err("npm ERR! EACCES: permission denied".to_string()) }
            },
        )
        .await;
        let result = finish_orchestrated_dep_install("HQ CLI", install_result, false);

        assert_eq!(install_calls.get(), 1, "a missing CLI must still invoke npm");
        assert_eq!(
            result,
            Err("npm ERR! EACCES: permission denied".to_string()),
            "a real npm failure after the wait must remain fatal"
        );
    }

    #[test]
    fn session_provider_npm_spec_covers_the_three_session_clis() {
        assert_eq!(
            session_provider_npm_spec("claude").unwrap(),
            ("@anthropic-ai/claude-code", "claude")
        );
        assert_eq!(
            session_provider_npm_spec("codex").unwrap(),
            ("@openai/codex", "codex")
        );
        assert_eq!(
            session_provider_npm_spec("grok").unwrap(),
            ("@xai-official/grok", "grok")
        );
        assert!(session_provider_npm_spec("cursor").is_err());
    }

    #[test]
    fn managed_node_abi_matches_pinned_versions() {
        // The hq-CLI updater's retry gate compares a failing runtime's ABI against
        // MANAGED_NODE_ABI; a Node bump that changes the ABI must update both
        // together, or this fails.
        let abi_for_major = |major: u32| -> Option<u32> {
            match major {
                20 => Some(115),
                22 => Some(127),
                24 => Some(137),
                _ => None,
            }
        };
        let major_of = |version: &str| -> u32 {
            version
                .trim_start_matches('v')
                .split('.')
                .next()
                .unwrap()
                .parse()
                .unwrap()
        };
        #[cfg(not(windows))]
        assert_eq!(
            abi_for_major(major_of(MANAGED_NODE_VERSION)),
            Some(MANAGED_NODE_ABI),
            "MANAGED_NODE_ABI is out of sync with MANAGED_NODE_VERSION"
        );
        #[cfg(windows)]
        assert_eq!(
            abi_for_major(major_of(WINDOWS_MANAGED_NODE_VERSION)),
            Some(MANAGED_NODE_ABI),
            "MANAGED_NODE_ABI is out of sync with WINDOWS_MANAGED_NODE_VERSION"
        );
    }

    fn ids(deps: Vec<&DepDef>) -> Vec<&'static str> {
        deps.into_iter().map(|dep| dep.id).collect()
    }

    fn ok_result(dep: &DepDef) -> DepInstallResult {
        DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: DepInstallStatus::Ok,
            error: None,
        }
    }

    fn failed_result(dep: &DepDef) -> DepInstallResult {
        DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: DepInstallStatus::Failed,
            error: Some("boom".to_string()),
        }
    }

    #[test]
    #[test]
    fn parse_dep_node_major_reads_versions() {
        assert_eq!(parse_dep_node_major("v14.21.3"), Some(14));
        assert_eq!(parse_dep_node_major("v20.11.1\n"), Some(20));
        assert_eq!(parse_dep_node_major("22.17.0"), Some(22));
        assert_eq!(parse_dep_node_major(""), None);
        assert_eq!(parse_dep_node_major("not-a-version"), None);
    }

    #[test]
    fn an_old_system_node_does_not_satisfy_the_node_dep() {
        // REGRESSION: the installer used to treat any `node` as installed, so a
        // machine on Node 14 skipped HQ's managed Node 22 and later failed
        // sync with "needs Node 20 or newer".
        let node = dependency_defs()
            .iter()
            .find(|dep| dep.id == "node")
            .unwrap();
        let git = dependency_defs()
            .iter()
            .find(|dep| dep.id == "git")
            .unwrap();
        let old = DepStatus {
            installed: true,
            version: Some("v14.21.3".into()),
            path: None,
        };
        let modern = DepStatus {
            installed: true,
            version: Some("v22.17.0".into()),
            path: None,
        };
        let floor = DepStatus {
            installed: true,
            version: Some("v20.0.0".into()),
            path: None,
        };
        let missing = DepStatus {
            installed: false,
            version: None,
            path: None,
        };
        let unparseable = DepStatus {
            installed: true,
            version: Some("mystery".into()),
            path: None,
        };
        assert!(
            !dep_status_satisfies(node, &old),
            "Node 14 must not skip the managed install"
        );
        assert!(dep_status_satisfies(node, &modern));
        assert!(dep_status_satisfies(node, &floor));
        assert!(!dep_status_satisfies(node, &missing));
        assert!(
            !dep_status_satisfies(node, &unparseable),
            "an unreadable version must not skip the managed install"
        );
        // Non-node deps still only care about presence.
        assert!(dep_status_satisfies(git, &old));
        assert!(!dep_status_satisfies(git, &missing));
    }

    #[test]
    fn planner_pre_marks_optional_deps_as_skipped() {
        let deps = dependency_defs();
        let result_by_id = premark_optional_results(deps);

        for dep_id in ["gh", "claude-code", "homebrew"] {
            let result = result_by_id
                .get(dep_id)
                .expect("optional dep should be pre-marked");
            assert!(result.optional);
            assert_eq!(result.status, DepInstallStatus::Skipped);
        }
        for dep_id in ["node", "yq", "qmd", "hq-cli", "git"] {
            assert!(
                !result_by_id.contains_key(dep_id),
                "required dep should not be pre-marked: {dep_id}"
            );
        }
    }

    /// Wave-1 required deps. `jq` is required on macOS (setup.sh/hooks need
    /// it; Sonoma ships none) but optional on Windows, where it is not
    /// provisioned yet — so it only appears in the required wave off-Windows.
    fn wave1_required() -> Vec<&'static str> {
        let mut w = vec!["node", "yq", "git"];
        if cfg!(not(windows)) {
            w.push("jq");
        }
        w
    }

    #[test]
    fn planner_gates_qmd_and_hq_cli_on_node() {
        let deps = dependency_defs();
        let mut result_by_id = premark_optional_results(deps);
        let mut ok_set = HashSet::new();

        assert_eq!(
            ids(ready_required_deps(deps, &result_by_id, &ok_set)),
            wave1_required()
        );

        for dep_id in ["node", "yq", "git", "jq"] {
            let dep = deps.iter().find(|dep| dep.id == dep_id).unwrap();
            result_by_id.insert(dep.id, ok_result(dep));
            ok_set.insert(dep.id);
        }

        assert_eq!(
            ids(ready_required_deps(deps, &result_by_id, &ok_set)),
            vec!["qmd", "hq-cli"]
        );
    }

    #[test]
    fn qmd_planner_waits_for_git_before_running() {
        let deps = dependency_defs();
        let mut result_by_id = premark_optional_results(deps);
        let mut ok_set = HashSet::new();

        for dep_id in ["node", "yq", "jq"] {
            let dep = deps.iter().find(|dep| dep.id == dep_id).unwrap();
            result_by_id.insert(dep.id, ok_result(dep));
            ok_set.insert(dep.id);
        }

        assert!(
            !ready_required_deps(deps, &result_by_id, &ok_set)
                .iter()
                .any(|dep| dep.id == "qmd"),
            "qmd must stay blocked until Git is satisfied"
        );

        let git = deps.iter().find(|dep| dep.id == "git").unwrap();
        result_by_id.insert(git.id, ok_result(git));
        ok_set.insert(git.id);

        assert!(
            ready_required_deps(deps, &result_by_id, &ok_set)
                .iter()
                .any(|dep| dep.id == "qmd"),
            "qmd becomes ready once Git is satisfied"
        );
    }

    #[test]
    fn winget_certificate_mismatch_accepts_git_when_present() {
        let error = format_install_error(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE, &[]);
        let probes = std::cell::Cell::new(0);

        let result = resolve_git_winget_install_failure(error, || {
            probes.set(probes.get() + 1);
            true
        });

        assert_eq!(
            result,
            Ok("Git already available after WinGet certificate mismatch".to_string())
        );
        assert_eq!(
            probes.get(),
            1,
            "the exact error must trigger one Git re-probe"
        );
    }

    #[test]
    fn winget_certificate_mismatch_keeps_error_when_git_is_absent() {
        let error = format_install_error(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE, &[]);
        let probes = std::cell::Cell::new(0);

        let result = resolve_git_winget_install_failure(error.clone(), || {
            probes.set(probes.get() + 1);
            false
        });

        assert_eq!(
            result,
            Err(error),
            "an absent Git must preserve the original WinGet exit code and error"
        );
        assert_eq!(
            probes.get(),
            1,
            "the exact error must trigger one Git re-probe"
        );
    }

    #[test]
    fn other_winget_errors_do_not_reprobe_git() {
        let error = format_install_error(-1, &[]);
        let probes = std::cell::Cell::new(0);

        let result = resolve_git_winget_install_failure(error.clone(), || {
            probes.set(probes.get() + 1);
            true
        });

        assert_eq!(result, Err(error));
        assert_eq!(probes.get(), 0, "only the named WinGet code re-probes Git");
    }

    #[test]
    fn planner_propagates_parent_failure_to_dependents() {
        let deps = dependency_defs();
        let mut result_by_id = premark_optional_results(deps);
        let mut ok_set = HashSet::new();

        for dep_id in ["yq", "git", "jq"] {
            let dep = deps.iter().find(|dep| dep.id == dep_id).unwrap();
            result_by_id.insert(dep.id, ok_result(dep));
            ok_set.insert(dep.id);
        }
        let node = deps.iter().find(|dep| dep.id == "node").unwrap();
        result_by_id.insert(node.id, failed_result(node));

        let blocked = blocked_required_results(deps, &result_by_id, &ok_set);
        assert_eq!(
            blocked.iter().map(|result| result.id).collect::<Vec<_>>(),
            vec!["qmd", "hq-cli"]
        );
        for result in blocked {
            assert_eq!(result.status, DepInstallStatus::Failed);
            assert_eq!(
                result.error.as_deref(),
                Some("Prerequisite not installed: node")
            );
        }
    }

    #[test]
    fn planner_selects_each_ready_wave() {
        let deps = dependency_defs();
        let mut result_by_id = premark_optional_results(deps);
        let mut ok_set = HashSet::new();
        let mut waves = Vec::new();

        loop {
            let ready = ready_required_deps(deps, &result_by_id, &ok_set);
            if ready.is_empty() {
                break;
            }
            waves.push(ids(ready.clone()));
            for dep in ready {
                result_by_id.insert(dep.id, ok_result(dep));
                ok_set.insert(dep.id);
            }
        }

        assert_eq!(
            waves,
            vec![wave1_required(), vec!["qmd", "hq-cli"]]
        );
    }

    fn failure_scope(run: &str, attempt: u32, session: &str) -> OnboardingFailureScope {
        OnboardingFailureScope {
            setup_run_id: run.to_string(),
            attempt_count: attempt,
            flow: "first_install".to_string(),
            frontend_session_id: session.to_string(),
        }
    }

    fn setup_diagnostic() -> SetupCommandDiagnostic {
        SetupCommandDiagnostic {
            command: "npm install -g @tobilu/qmd".to_string(),
            exit_code: Some(17),
            stdout: "downloading package\ninstall complete? no".to_string(),
            stderr: "npm ERR! EACCES: permission denied".to_string(),
            error: "Process exited with code 17: npm ERR! EACCES".to_string(),
        }
    }

    /// A recovered brew/npm command must not be reported if a later fallback
    /// path is the terminal failure for that dependency.
    #[test]
    fn recovered_command_failure_is_discarded_before_terminal_fallback() {
        let collector = SetupDiagnosticCollector::new();
        collector.record(setup_diagnostic());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(
            ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.scope(collector.clone(), async {
                clear_recovered_setup_command_failure();
            }),
        );
        assert!(collector.take().is_none());
    }

    fn string_extra<'a>(event: &'a sentry::protocol::Event<'static>, key: &str) -> &'a str {
        let Some(sentry::protocol::Value::String(value)) = event.extra.get(key) else {
            panic!("{key} must be a string extra");
        };
        value
    }

    /// The Sentry-only envelope holds the command result and all correlation
    /// fields needed to line it up with the bounded product telemetry row.
    #[test]
    fn setup_failure_event_carries_command_output_correlation_and_system_context() {
        let scope = failure_scope("11111111-1111-4111-8111-111111111111", 2, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let events = sentry::test::with_captured_events_options(
            || {
                send_setup_dependency_failure(&scope, "qmd", OnboardingErrorCategory::ExitNonzero, setup_diagnostic(), &["hq-cli".to_string()]);
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.fingerprint, vec!["desktop-setup-dependency-install-failed"]);
        assert_eq!(event.tags["setup_stage"], "deps");
        assert_eq!(event.tags["setup_dependency"], "qmd");
        assert_eq!(event.tags["setup_error_category"], "exit-nonzero");
        assert_eq!(event.tags["setup_execution"], "attempted");
        assert_eq!(event.tags["setup_attempt"], "2");
        assert_eq!(event.tags["setup_flow"], "first_install");
        assert_eq!(string_extra(event, "setup_run_id"), "11111111-1111-4111-8111-111111111111");
        assert_eq!(string_extra(event, "setup_frontend_session_id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert_eq!(string_extra(event, "setup_command"), "npm install -g @tobilu/qmd");
        assert_eq!(event.extra["setup_exit_code"], sentry::protocol::Value::Number(17.into()));
        assert!(string_extra(event, "setup_stdout_tail").contains("downloading package"));
        assert!(string_extra(event, "setup_stderr_tail").contains("EACCES"));
        assert!(event.tags.contains_key("setup_os"));
        assert!(event.tags.contains_key("setup_architecture"));
        assert!(!string_extra(event, "setup_app_version").is_empty());
        assert!(!string_extra(event, "setup_os_version").is_empty());
        assert_eq!(event.extra["setup_blocked_dependents"], sentry::protocol::Value::Array(vec![sentry::protocol::Value::String("hq-cli".into())]));
        assert_eq!(string_extra(event, "setup_blocked_dependents_status"), "blocked_by_failed_prerequisite");
    }

    #[test]
    fn winget_pinned_certificate_mismatch_has_a_stable_category_and_kind() {
        let dependency = dependency_defs()
            .into_iter()
            .find(|dep| dep.id == "git")
            .expect("git dependency is registered");
        let result = DepInstallResult {
            id: dependency.id,
            label: dependency.label,
            optional: dependency.optional,
            status: DepInstallStatus::Failed,
            error: Some("Process exited with code -1978335138".to_string()),
        };
        let diagnostic = SetupCommandDiagnostic {
            command: "winget install --id Git.Git --source winget".to_string(),
            exit_code: Some(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE),
            stdout: String::new(),
            stderr: String::new(),
            error: "server certificate did not match pinned certificate".to_string(),
        };

        assert_eq!(
            setup_error_kind(Some(&diagnostic)),
            Some("winget_pinned_certificate_mismatch")
        );
        assert_eq!(
            setup_error_category(&result, Some(&diagnostic)),
            OnboardingErrorCategory::Network
        );

        let scope = failure_scope(
            "11111111-1111-4111-8111-111111111111",
            1,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
        let category = setup_error_category(&result, Some(&diagnostic));
        let error_kind = setup_error_kind(Some(&diagnostic));
        record_onboarding_failure_detail_with_kind(
            "deps",
            Some(&scope),
            Some("git"),
            category,
            error_kind,
        );
        let stored_detail = crate::commands::install_stages::take_onboarding_failure_detail(
            "deps".to_string(),
            scope.setup_run_id.clone(),
            scope.attempt_count,
            scope.flow.clone(),
            scope.frontend_session_id.clone(),
        )
        .expect("classified detail is retained for the setup attempt");
        assert_eq!(stored_detail.error_category, "network");
        assert_eq!(
            stored_detail.error_kind.as_deref(),
            Some("winget_pinned_certificate_mismatch")
        );

        let events = sentry::test::with_captured_events(|| {
            send_setup_dependency_failure(
                &scope,
                "git",
                OnboardingErrorCategory::Network,
                diagnostic,
                &[],
            );
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags["setup_error_category"], "network");
        assert_eq!(
            events[0].tags["setup_error_kind"],
            "winget_pinned_certificate_mismatch"
        );

        let other_command = SetupCommandDiagnostic {
            command: "scoop install git".to_string(),
            exit_code: Some(WINGET_PINNED_CERTIFICATE_MISMATCH_EXIT_CODE),
            stdout: String::new(),
            stderr: String::new(),
            error: "server certificate did not match pinned certificate".to_string(),
        };
        assert_eq!(setup_error_kind(Some(&other_command)), None);
        assert_eq!(
            setup_error_category(&result, Some(&other_command)),
            OnboardingErrorCategory::ExitNonzero
        );
    }

    #[test]
    fn qmd_post_install_failures_emit_closed_kinds_and_a_sanitized_version() {
        let tmp = tempfile::tempdir().unwrap();
        let qmd_package_bin = tmp
            .path()
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("bin")
            .join("qmd");
        std::fs::create_dir_all(qmd_package_bin.parent().unwrap()).unwrap();

        let cases = [
            (
                DepStatus {
                    installed: false,
                    version: None,
                    path: None,
                },
                QmdPostInstallFailure::NotResolved,
                OnboardingErrorCategory::NotFound,
                None,
            ),
            (
                DepStatus {
                    installed: true,
                    version: Some("qmd v2.5.2 (C:\\Users\\Alice\\qmd)".to_string()),
                    path: None,
                },
                QmdPostInstallFailure::VersionMismatch,
                OnboardingErrorCategory::Unknown,
                Some("v2.5.2"),
            ),
            (
                DepStatus {
                    installed: true,
                    version: Some("qmd v2.5.3 (C:\\Users\\Alice\\qmd)".to_string()),
                    path: Some(qmd_package_bin.clone()),
                },
                QmdPostInstallFailure::NativeAddonMismatch,
                OnboardingErrorCategory::Unknown,
                Some("v2.5.3"),
            ),
        ];

        for (index, (status, expected_failure, expected_category, expected_version)) in
            cases.into_iter().enumerate()
        {
            let failure = qmd_post_install_failure(&status)
                .expect("each fixture should fail a distinct qmd post-install check");
            assert_eq!(failure, expected_failure);
            let diagnostic = qmd_post_install_diagnostic(failure, &status);
            assert_eq!(
                setup_error_kind(Some(&diagnostic)),
                Some(expected_failure.as_str())
            );
            assert_eq!(diagnostic.stdout, expected_version.unwrap_or_default());
            assert!(!diagnostic.stdout.contains("Users"));

            let run_id = format!("11111111-1111-4111-8111-{:012}", index + 1);
            let session_id = format!("aaaaaaaa-aaaa-4aaa-8aaa-{:012}", index + 1);
            let scope = failure_scope(&run_id, 1, &session_id);
            record_onboarding_failure_detail_with_kind(
                "deps",
                Some(&scope),
                Some("qmd"),
                expected_category,
                setup_error_kind(Some(&diagnostic)),
            );
            let stored_detail = crate::commands::install_stages::take_onboarding_failure_detail(
                "deps".to_string(),
                scope.setup_run_id.clone(),
                scope.attempt_count,
                scope.flow.clone(),
                scope.frontend_session_id.clone(),
            )
            .expect("classified qmd detail is retained for the setup attempt");
            assert_eq!(stored_detail.error_kind.as_deref(), Some(expected_failure.as_str()));

            let events = sentry::test::with_captured_events(|| {
                send_setup_dependency_failure(
                    &scope,
                    "qmd",
                    expected_category,
                    diagnostic,
                    &[],
                );
            });
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].tags["setup_error_kind"], expected_failure.as_str());
            assert!(!events[0].extra.contains_key("setup_resolved_search_path"));
            if let Some(version) = expected_version {
                assert_eq!(
                    events[0].extra.get("setup_resolved_version"),
                    Some(&sentry::protocol::Value::String(version.to_string()))
                );
            } else {
                assert!(!events[0].extra.contains_key("setup_resolved_version"));
            }
        }

        let unrecognized = SetupCommandDiagnostic {
            command: QMD_POST_INSTALL_PROBE_COMMAND.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: "qmd path included C:\\Users\\Alice".to_string(),
        };
        assert_eq!(setup_error_kind(Some(&unrecognized)), None);
        assert_eq!(
            qmd_resolved_version_token(Some("qmd C:\\Users\\Alice\\qmd")),
            None
        );
    }

    /// A failed node prerequisite blocks qmd and hq-cli, but only node is a
    /// root cause and only its event carries those dependent effects.
    #[test]
    fn setup_failure_roots_exclude_two_dependents_blocked_by_one_prerequisite() {
        let deps = dependency_defs();
        let node = deps.iter().find(|dep| dep.id == "node").unwrap();
        let qmd = deps.iter().find(|dep| dep.id == "qmd").unwrap();
        let hq_cli = deps.iter().find(|dep| dep.id == "hq-cli").unwrap();
        let mut results = premark_optional_results(deps);
        results.insert(node.id, failed_result(node));
        for dependent in [qmd, hq_cli] {
            results.insert(dependent.id, DepInstallResult {
                id: dependent.id,
                label: dependent.label,
                optional: dependent.optional,
                status: DepInstallStatus::Failed,
                error: Some("Prerequisite not installed: node".to_string()),
            });
        }
        assert_eq!(reportable_setup_failure_ids(deps, &results), vec!["node"]);
        assert_eq!(blocked_dependents_for(deps, &results, "node"), vec!["qmd", "hq-cli"]);
    }

    /// Retried failures stay grouped but run/session context distinguishes a
    /// retry by one person from a second affected person.
    #[test]
    fn repeated_setup_failures_share_one_issue_but_retain_person_and_retry_context() {
        let first = failure_scope("11111111-1111-4111-8111-111111111111", 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let retry = failure_scope("11111111-1111-4111-8111-111111111111", 2, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let other = failure_scope("22222222-2222-4222-8222-222222222222", 1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        let events = sentry::test::with_captured_events(|| {
            for scope in [&first, &retry, &other] {
                send_setup_dependency_failure(scope, "node", OnboardingErrorCategory::ExitNonzero, setup_diagnostic(), &[]);
            }
        });
        assert_eq!(events.len(), 3);
        assert!(events
            .iter()
            .all(|event| event.fingerprint == vec!["desktop-setup-dependency-install-failed"]));
        assert_eq!(events[0].tags["setup_attempt"], "1");
        assert_eq!(events[1].tags["setup_attempt"], "2");
        assert_eq!(string_extra(&events[0], "setup_frontend_session_id"), string_extra(&events[1], "setup_frontend_session_id"));
        assert_ne!(string_extra(&events[0], "setup_frontend_session_id"), string_extra(&events[2], "setup_frontend_session_id"));
    }

    /// Empty DSNs in development and PR CI must leave setup able to complete.
    #[test]
    fn setup_failure_capture_is_a_noop_without_a_sentry_client() {
        let hub = std::sync::Arc::new(sentry::Hub::new(None, std::sync::Arc::new(Default::default())));
        sentry::Hub::run(hub.clone(), || {
            queue_setup_dependency_failure(failure_scope("11111111-1111-4111-8111-111111111111", 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "node", OnboardingErrorCategory::ExitNonzero, setup_diagnostic(), vec![]);
        });
        assert!(hub.last_event_id().is_none());
    }

    struct BlockingSetupTransport {
        started: std::sync::mpsc::Sender<()>,
        release: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    }

    impl sentry::Transport for BlockingSetupTransport {
        fn send_envelope(&self, _envelope: sentry::Envelope) {
            let _ = self.started.send(());
            let (released, wake) = &*self.release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
    }

    struct PanickingSetupTransport {
        started: std::sync::mpsc::Sender<()>,
    }

    impl sentry::Transport for PanickingSetupTransport {
        fn send_envelope(&self, _envelope: sentry::Envelope) {
            let _ = self.started.send(());
            panic!("simulated Sentry transport failure");
        }
    }

    fn setup_hub<T: sentry::Transport>(transport: std::sync::Arc<T>) -> std::sync::Arc<sentry::Hub> {
        let options = sentry::ClientOptions {
            dsn: Some("https://public@sentry.invalid/1".parse().unwrap()),
            transport: Some(std::sync::Arc::new(transport)),
            before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        };
        std::sync::Arc::new(sentry::Hub::new(
            Some(std::sync::Arc::new(sentry::Client::from(options))),
            std::sync::Arc::new(Default::default()),
        ))
    }

    struct ConcurrentSetupTransport {
        arrived: std::sync::mpsc::Sender<&'static str>,
        released: std::sync::Arc<(
            std::sync::Mutex<std::collections::HashSet<&'static str>>,
            std::sync::Condvar,
        )>,
        events: std::sync::Mutex<Vec<sentry::protocol::Event<'static>>>,
    }

    impl ConcurrentSetupTransport {
        fn release(&self, dependency: &'static str) {
            let (released, wake) = &*self.released;
            released.lock().unwrap().insert(dependency);
            wake.notify_all();
        }

        fn events(&self) -> Vec<sentry::protocol::Event<'static>> {
            self.events.lock().unwrap().clone()
        }
    }

    impl sentry::Transport for ConcurrentSetupTransport {
        fn send_envelope(&self, envelope: sentry::Envelope) {
            let Some(event) = envelope.event().cloned() else {
                return;
            };
            let dependency = match event.tags.get("setup_dependency").map(|tag| tag.as_ref()) {
                Some("node") => "node",
                Some("qmd") => "qmd",
                _ => {
                    self.events.lock().unwrap().push(event);
                    return;
                }
            };
            self.events.lock().unwrap().push(event);
            let _ = self.arrived.send(dependency);
            let (released, wake) = &*self.released;
            let mut released = released.lock().unwrap();
            while !released.contains(dependency) {
                released = wake.wait(released).unwrap();
            }
        }
    }

    /// Concurrent detached setup reporters must keep their Sentry scopes and
    /// issue grouping independent. The transport forces the first reporter to
    /// finish while the second scope is active, which was the production panic.
    #[test]
    fn concurrent_setup_failure_reporters_keep_scopes_and_envelopes_independent() {
        let (arrived, arrived_rx) = std::sync::mpsc::channel();
        let released = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        let transport = std::sync::Arc::new(ConcurrentSetupTransport {
            arrived,
            released,
            events: std::sync::Mutex::new(Vec::new()),
        });
        let hub = setup_hub(transport.clone());

        let scope_guard_panicked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let scope_guard_panic_observer = scope_guard_panicked.clone();
        let previous_panic_hook =
            std::sync::Arc::new(std::sync::Mutex::new(Some(std::panic::take_hook())));
        let previous_panic_hook_for_observer = previous_panic_hook.clone();
        std::panic::set_hook(Box::new(move |info| {
            if info.to_string().contains("Popped scope guard out of order") {
                scope_guard_panic_observer.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            previous_panic_hook_for_observer
                .lock()
                .unwrap()
                .as_ref()
                .expect("previous panic hook is installed")(info);
        }));

        sentry::Hub::run(hub.clone(), || {
            queue_setup_dependency_failure(
                failure_scope(
                    "11111111-1111-4111-8111-111111111111",
                    1,
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                ),
                "node",
                OnboardingErrorCategory::ExitNonzero,
                setup_diagnostic(),
                vec![],
            );
        });
        let node_arrival = arrived_rx.recv_timeout(std::time::Duration::from_secs(1));

        sentry::Hub::run(hub, || {
            queue_setup_dependency_failure(
                failure_scope(
                    "22222222-2222-4222-8222-222222222222",
                    1,
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                ),
                "qmd",
                OnboardingErrorCategory::ExitNonzero,
                setup_diagnostic(),
                vec![],
            );
        });
        let qmd_arrival = arrived_rx.recv_timeout(std::time::Duration::from_secs(1));

        transport.release("node");
        let scope_guard_panic_deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(1);
        while !scope_guard_panicked.load(std::sync::atomic::Ordering::SeqCst)
            && std::time::Instant::now() < scope_guard_panic_deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        transport.release("qmd");
        std::thread::sleep(std::time::Duration::from_millis(100));

        let observed_scope_guard_panic =
            scope_guard_panicked.load(std::sync::atomic::Ordering::SeqCst);
        let _ = std::panic::take_hook();
        let previous_panic_hook = previous_panic_hook
            .lock()
            .unwrap()
            .take()
            .expect("previous panic hook is installed");
        std::panic::set_hook(previous_panic_hook);

        assert_eq!(
            node_arrival.expect("node reporter should reach the transport"),
            "node"
        );
        assert_eq!(
            qmd_arrival.expect("qmd reporter should reach the transport"),
            "qmd"
        );
        assert!(
            !observed_scope_guard_panic,
            "concurrent reporters must not panic while dropping their Sentry scopes"
        );

        let events = transport.events();
        assert_eq!(events.len(), 2);
        for dependency in ["node", "qmd"] {
            let event = events
                .iter()
                .find(|event| {
                    event.tags.get("setup_dependency").map(|tag| tag.as_ref()) == Some(dependency)
                })
                .expect("each concurrent reporter should capture its own envelope");
            assert_eq!(event.tags["setup_dependency"], dependency);
            assert_eq!(
                event.fingerprint,
                vec!["desktop-setup-dependency-install-failed"]
            );
        }
    }

    /// A slow transport and a transport failure run only on the reporter
    /// thread, so the setup command returns immediately in either case.
    #[test]
    fn setup_failure_reporter_never_blocks_on_slow_or_failing_sentry_transport() {
        let (slow_started, slow_started_rx) = std::sync::mpsc::channel();
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let slow_transport = std::sync::Arc::new(BlockingSetupTransport {
            started: slow_started,
            release: release.clone(),
        });
        let slow_hub = setup_hub(slow_transport);
        let start = std::time::Instant::now();
        sentry::Hub::run(slow_hub, || {
            queue_setup_dependency_failure(failure_scope("11111111-1111-4111-8111-111111111111", 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "node", OnboardingErrorCategory::ExitNonzero, setup_diagnostic(), vec![]);
        });
        assert!(start.elapsed() < std::time::Duration::from_millis(100));
        slow_started_rx.recv_timeout(std::time::Duration::from_secs(1)).expect("reporter should reach the slow transport");
        let (released, wake) = &*release;
        *released.lock().unwrap() = true;
        wake.notify_all();

        let (panic_started, panic_started_rx) = std::sync::mpsc::channel();
        let failing_hub = setup_hub(std::sync::Arc::new(PanickingSetupTransport { started: panic_started }));
        sentry::Hub::run(failing_hub, || {
            queue_setup_dependency_failure(failure_scope("11111111-1111-4111-8111-111111111111", 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "node", OnboardingErrorCategory::ExitNonzero, setup_diagnostic(), vec![]);
        });
        panic_started_rx.recv_timeout(std::time::Duration::from_secs(1)).expect("reporter should isolate a failed transport");
    }
}

#[cfg(all(test, not(windows)))]
mod managed_node_url_tests {
    use super::*;

    #[test]
    fn node_distribution_override_keeps_the_pinned_artifact_path() {
        let url = managed_node_url_for_base("aarch64", "http://127.0.0.1:8123/node-dist/")
            .expect("supported architecture");
        assert_eq!(
            url,
            format!(
                "http://127.0.0.1:8123/node-dist/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-arm64.tar.gz"
            )
        );
    }

    #[test]
    fn node_distribution_override_does_not_make_unknown_arches_installable() {
        assert!(managed_node_url_for_base("mips64", "http://127.0.0.1:8123").is_none());
    }

    /// The invariant that makes the override safe: there is no arch, and no
    /// distribution base, for which HQ can produce a download URL but has no
    /// pinned checksum to verify it against. `install_node_macos` reads both
    /// from these two functions and refuses when either is `None`, so keeping
    /// their supported sets identical is what makes "no code path may install
    /// an unverified Node" structurally true rather than merely reviewed.
    #[test]
    fn every_installable_arch_has_a_pinned_checksum_whatever_the_dist_base_is() {
        for arch in ["aarch64", "x86_64", "mips64", "riscv64", "armv7"] {
            for base in [
                "https://nodejs.org/dist",
                "http://127.0.0.1:8123/node-dist/",
                "https://an-attacker.example/dist",
            ] {
                assert_eq!(
                    managed_node_url_for_base(arch, base).is_some(),
                    managed_node_sha256_for(arch).is_some(),
                    "{arch} via {base}: a downloadable arch with no pinned SHA-256 \
                     would install an unverified Node"
                );
            }
        }
    }

    /// Two properties of the override, asserted in one test because both
    /// mutate the same process-global variable and `cargo test` runs test
    /// functions in parallel threads.
    ///
    ///   1. A shipped build ignores the environment entirely.
    ///   2. The pinned checksum is a property of the artifact, never of where
    ///      it came from — redirecting the origin cannot select a weaker (or
    ///      absent) expected hash.
    #[test]
    fn the_distribution_override_is_debug_only_and_never_moves_the_checksum() {
        let pinned_arm64 = managed_node_sha256_for("aarch64");
        let pinned_x64 = managed_node_sha256_for("x86_64");
        assert!(pinned_arm64.is_some() && pinned_x64.is_some());

        std::env::set_var("HQ_NODE_DIST_URL", "https://an-attacker.example/dist");
        let base = managed_node_dist_base();
        let sha_arm64_with_override = managed_node_sha256_for("aarch64");
        let sha_x64_with_override = managed_node_sha256_for("x86_64");
        std::env::remove_var("HQ_NODE_DIST_URL");

        if cfg!(debug_assertions) {
            assert_eq!(base, "https://an-attacker.example/dist");
        } else {
            assert_eq!(
                base, "https://nodejs.org/dist",
                "a release build must ignore the environment override entirely"
            );
        }

        assert_eq!(sha_arm64_with_override, pinned_arm64);
        assert_eq!(sha_x64_with_override, pinned_x64);
        assert_eq!(managed_node_sha256_for("aarch64"), pinned_arm64);
    }
}

#[cfg(all(test, unix))]
mod install_deps_tests {
    use super::*;
    use crate::util::test_support::{scoped_home, ENV_MUTEX};
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    fn make_fake_bin_at(parent: &Path, name: &str) {
        fs::create_dir_all(parent).unwrap();
        let path = parent.join(name);
        fs::write(&path, format!("#!/bin/sh\necho '{} version 1.2.3'\n", name)).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    fn make_fake_bin(dir: &tempfile::TempDir, name: &str) {
        make_fake_bin_at(dir.path(), name);
    }

    #[test]
    fn test_check_dep_installed_when_present() {
        let dir = tempfile::TempDir::new().unwrap();
        make_fake_bin(&dir, "mytool");

        let status = check_dep_in("mytool", dir.path().to_str().unwrap());

        assert!(status.installed);
    }

    #[test]
    fn test_is_macos_git_shim_classifies_stub_path() {
        assert!(is_macos_git_shim("git", Path::new("/usr/bin/git")));
        assert!(!is_macos_git_shim(
            "git",
            Path::new("/Users/x/Library/Application Support/Indigo HQ/toolchain/git/bin/git")
        ));
        assert!(!is_macos_git_shim(
            "git",
            Path::new("/opt/homebrew/bin/git")
        ));
        assert!(!is_macos_git_shim("node", Path::new("/usr/bin/git")));
    }

    #[test]
    fn test_managed_git_env_empty_when_not_installed() {
        let home = tempfile::TempDir::new().unwrap();
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let _home = scoped_home(home.path());
        assert!(managed_git_env_in(home.path()).is_empty());
    }

    #[test]
    fn test_managed_git_env_set_when_installed() {
        let home = tempfile::TempDir::new().unwrap();
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let git_bin_dir = home
            .path()
            .join("Library/Application Support/Indigo HQ/toolchain/git/bin");
        make_fake_bin_at(&git_bin_dir, "git");
        ensure_managed_git_shim_in(home.path()).expect("managed git shim");
        let _home = scoped_home(home.path());

        let env: std::collections::HashMap<String, String> =
            managed_git_env_in(home.path()).into_iter().collect();

        assert!(env
            .get("GIT_EXEC_PATH")
            .expect("GIT_EXEC_PATH should be set")
            .ends_with("toolchain/git/libexec/git-core"));
        assert!(env
            .get("GIT_TEMPLATE_DIR")
            .expect("GIT_TEMPLATE_DIR should be set")
            .ends_with("toolchain/git/share/git-core/templates"));
    }

    #[test]
    fn test_composed_settings_env_path_orders_and_dedupes_sources() {
        let home = tempfile::TempDir::new().unwrap();
        let managed_node = home
            .path()
            .join("Library/Application Support/Indigo HQ/toolchain/node/bin")
            .to_string_lossy()
            .into_owned();

        let path = composed_settings_env_path(
            home.path(),
            "/usr/local/bin:/custom/bin:/usr/bin",
            Some("/custom/bin:/template/bin:/bin"),
        );
        let parts: Vec<&str> = path.split(':').collect();

        assert_eq!(parts.first().copied(), Some(managed_node.as_str()));
        assert_eq!(
            parts.iter().filter(|part| **part == "/custom/bin").count(),
            1
        );
        assert_eq!(parts.iter().filter(|part| **part == "/usr/bin").count(), 1);
        assert_eq!(parts.iter().filter(|part| **part == "/bin").count(), 1);
        assert!(
            parts
                .iter()
                .position(|part| *part == "/usr/local/bin")
                .unwrap()
                < parts
                    .iter()
                    .position(|part| *part == "/template/bin")
                    .unwrap()
        );
    }

    #[test]
    fn test_settings_json_with_env_path_preserves_existing_key_order() {
        let input = r#"{
  "permissions": {
    "allow": [
      "Bash(hq:*)"
    ]
  },
  "env": {
    "FOO": "bar",
    "PATH": "/usr/bin",
    "BAZ": "qux"
  },
  "hooks": {
    "PostToolUse": []
  }
}"#;

        let updated = settings_json_with_env_path(input, "/managed/bin:/usr/bin").unwrap();
        let root_permissions = updated.find("\"permissions\"").unwrap();
        let root_env = updated.find("\"env\"").unwrap();
        let root_hooks = updated.find("\"hooks\"").unwrap();
        let env_foo = updated.find("\"FOO\"").unwrap();
        let env_path = updated.find("\"PATH\"").unwrap();
        let env_baz = updated.find("\"BAZ\"").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();

        assert!(root_permissions < root_env);
        assert!(root_env < root_hooks);
        assert!(env_foo < env_path);
        assert!(env_path < env_baz);
        assert_eq!(
            parsed
                .get("env")
                .and_then(|env| env.get("PATH"))
                .and_then(|path| path.as_str()),
            Some("/managed/bin:/usr/bin")
        );
        assert!(updated.ends_with('\n'));
    }

    #[test]
    fn test_settings_json_with_env_path_creates_env_at_end_when_absent() {
        let input = r#"{
  "permissions": {},
  "hooks": {}
}"#;

        let updated = settings_json_with_env_path(input, "/managed/bin").unwrap();
        let root_permissions = updated.find("\"permissions\"").unwrap();
        let root_hooks = updated.find("\"hooks\"").unwrap();
        let root_env = updated.find("\"env\"").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();

        assert!(root_permissions < root_hooks);
        assert!(root_hooks < root_env);
        assert_eq!(
            parsed
                .get("env")
                .and_then(|env| env.get("PATH"))
                .and_then(|path| path.as_str()),
            Some("/managed/bin")
        );
    }

    #[test]
    fn test_settings_json_with_env_path_rejects_non_object_documents() {
        let err = settings_json_with_env_path("[]", "/managed/bin").unwrap_err();
        assert_eq!(err, "settings.json root is not an object");

        let err = settings_json_with_env_path(r#"{"env": "bad"}"#, "/managed/bin").unwrap_err();
        assert_eq!(err, "settings.json 'env' is not an object");
    }

    /// HQ-DESKTOP-46: the composed managed-first PATH must be WRITTEN into the
    /// file the resolver READS. settings.local.json defines env.PATH, so it wins,
    /// and settings.json (which the resolver ignores) must be left untouched.
    #[cfg(not(windows))]
    #[test]
    fn write_managed_settings_path_targets_settings_local_when_it_has_a_path() {
        let hq = tempfile::TempDir::new().unwrap();
        let home = tempfile::TempDir::new().unwrap();
        let claude = hq.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("settings.json"),
            "{\"other\":1,\"env\":{\"PATH\":\"/base\"}}",
        )
        .unwrap();
        std::fs::write(
            claude.join("settings.local.json"),
            "{\"keep\":true,\"env\":{\"PATH\":\"/opt/homebrew/bin\"}}",
        )
        .unwrap();

        let outcome =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin:/bin").unwrap();
        assert_eq!(
            outcome,
            SettingsPathWriteOutcome::Wrote(claude.join("settings.local.json"))
        );

        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(claude.join("settings.local.json")).unwrap())
                .unwrap();
        let path = doc["env"]["PATH"].as_str().unwrap();
        // The managed node bin is hoisted to the FRONT.
        let managed = managed_tool_paths_in(home.path());
        assert!(
            path.starts_with(&managed[0]),
            "managed node bin must be first: {path}"
        );
        // The pre-existing foreign dir survives, just behind the managed dirs.
        assert!(path.split(':').any(|seg| seg == "/opt/homebrew/bin"));
        // Every other key in the winning document is preserved.
        assert_eq!(doc["keep"].as_bool(), Some(true));
        // The base file the resolver ignores is untouched.
        assert_eq!(
            std::fs::read_to_string(claude.join("settings.json")).unwrap(),
            "{\"other\":1,\"env\":{\"PATH\":\"/base\"}}"
        );
    }

    /// When only the base settings.json defines env.PATH the writer targets it,
    /// exactly as before the fix — and the rewrite is idempotent.
    #[cfg(not(windows))]
    #[test]
    fn write_managed_settings_path_falls_back_to_base_and_is_idempotent() {
        let hq = tempfile::TempDir::new().unwrap();
        let home = tempfile::TempDir::new().unwrap();
        let claude = hq.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("settings.json"),
            "{\"model\":\"x\",\"env\":{\"PATH\":\"/opt/homebrew/bin\"}}",
        )
        .unwrap();

        let first =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin:/bin").unwrap();
        assert_eq!(
            first,
            SettingsPathWriteOutcome::Wrote(claude.join("settings.json"))
        );
        let after_first = std::fs::read_to_string(claude.join("settings.json")).unwrap();

        let second =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin:/bin").unwrap();
        assert_eq!(
            second,
            SettingsPathWriteOutcome::Wrote(claude.join("settings.json"))
        );
        let after_second = std::fs::read_to_string(claude.join("settings.json")).unwrap();
        assert_eq!(after_first, after_second, "the rewrite must be idempotent");
        let doc: serde_json::Value = serde_json::from_str(&after_second).unwrap();
        assert_eq!(doc["model"].as_str(), Some("x"));
    }

    /// A missing target settings file is a skip, not an error.
    #[cfg(not(windows))]
    #[test]
    fn write_managed_settings_path_skips_when_no_settings_file() {
        let hq = tempfile::TempDir::new().unwrap();
        let home = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(hq.path().join(".claude")).unwrap();
        let outcome =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin").unwrap();
        assert!(matches!(outcome, SettingsPathWriteOutcome::Skipped(_)));
    }

    /// A settings file symlinked OUT of the HQ folder is refused, so the write
    /// cannot be redirected to clobber an unrelated file.
    #[cfg(not(windows))]
    #[test]
    fn write_managed_settings_path_refuses_a_symlink_escaping_the_hq_folder() {
        let hq = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let home = tempfile::TempDir::new().unwrap();
        let claude = hq.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let target = outside.path().join("evil-settings.json");
        std::fs::write(&target, "{\"env\":{\"PATH\":\"/opt/homebrew/bin\"}}").unwrap();
        std::os::unix::fs::symlink(&target, claude.join("settings.local.json")).unwrap();

        let err =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin").unwrap_err();
        assert!(err.contains("outside the HQ folder"), "unexpected error: {err}");
        // The escaping target was NOT rewritten.
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "{\"env\":{\"PATH\":\"/opt/homebrew/bin\"}}"
        );
    }

    /// A non-object settings document is refused rather than clobbered.
    #[cfg(not(windows))]
    #[test]
    fn write_managed_settings_path_refuses_a_non_object_document() {
        let hq = tempfile::TempDir::new().unwrap();
        let home = tempfile::TempDir::new().unwrap();
        let claude = hq.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        // No file defines env.PATH -> target is settings.json; it exists but is a
        // JSON array, so the composer refuses it as a non-object.
        std::fs::write(claude.join("settings.json"), "[]").unwrap();
        let err =
            write_managed_toolchain_settings_path(hq.path(), home.path(), "/usr/bin").unwrap_err();
        assert!(err.contains("not an object"), "unexpected error: {err}");
    }

    #[test]
    fn test_check_dep_not_installed_when_absent() {
        let dir = tempfile::TempDir::new().unwrap();

        let status = check_dep_in(
            "definitely_not_a_real_binary_xyz123",
            dir.path().to_str().unwrap(),
        );

        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.path.is_none());
    }

    #[test]
    fn test_check_dep_returns_version_string() {
        let dir = tempfile::TempDir::new().unwrap();
        make_fake_bin(&dir, "versiontool");

        let status = check_dep_in("versiontool", dir.path().to_str().unwrap());

        assert!(status.installed);
        let version = status.version.expect("version should be Some");
        assert!(!version.is_empty());
        assert!(version.contains("1.2.3"));
    }

    #[test]
    fn test_check_dep_returns_path_when_present() {
        let dir = tempfile::TempDir::new().unwrap();
        make_fake_bin(&dir, "pathtool");

        let status = check_dep_in("pathtool", dir.path().to_str().unwrap());

        assert!(status.installed);
        let path = status.path.expect("path should be Some");
        assert!(path.exists());
        assert!(path.ends_with("pathtool"));
    }

    #[test]
    fn test_cancel_install_unknown_handle_returns_false() {
        let result = cancel_install("handle-that-does-not-exist-abc999".to_string());
        assert!(!result);
    }

    #[test]
    fn test_cancel_install_sets_flag_for_registered_handle() {
        let handle = "test-handle-registered-001".to_string();

        register_cancel_handle(handle.clone());
        let result = cancel_install(handle);

        assert!(result);
    }

    #[test]
    fn cancel_install_does_not_require_a_feature_flag_source() {
        let handle = Uuid::new_v4().to_string();
        register_cancel_handle(handle.clone());

        assert!(cancel_install(handle.clone()));
        assert!(cancel_registry().lock().unwrap()[&handle].cancelled);
    }

    #[test]
    fn test_check_dep_node_when_faked() {
        let dir = tempfile::TempDir::new().unwrap();
        make_fake_bin(&dir, "node");

        let status = check_dep_in("node", dir.path().to_str().unwrap());

        assert!(status.installed);
        assert!(status.version.unwrap().contains("1.2.3"));
    }

    #[test]
    fn test_check_dep_git_when_faked() {
        let dir = tempfile::TempDir::new().unwrap();
        make_fake_bin(&dir, "git");

        let status = check_dep_in("git", dir.path().to_str().unwrap());

        assert!(status.installed);
        assert!(status.version.unwrap().contains("1.2.3"));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::io::Write as _;

    /// npm/qmd/hq all install an extensionless POSIX script next to their
    /// `.cmd` shim. Resolving the bare script and spawning it fails with
    /// ERROR_BAD_EXE_FORMAT (os error 193) — the first Windows headless
    /// install run died on exactly this. PATHEXT must win.
    #[test]
    fn which_prefers_pathext_over_extensionless_script() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("npm"), b"#!/bin/sh\nexec node npm.js\n").unwrap();
        std::fs::write(tmp.path().join("npm.cmd"), b"@echo off\r\n").unwrap();

        let found = which::which_in(
            "npm",
            Some(tmp.path().to_string_lossy().as_ref()),
            tmp.path(),
        )
        .expect("npm should resolve");
        // PATHEXT entries are uppercase, so the resolved path may come back
        // as `npm.CMD`; compare case-insensitively like the filesystem does.
        assert_eq!(
            found.to_string_lossy().to_lowercase(),
            tmp.path().join("npm.cmd").to_string_lossy().to_lowercase()
        );

        // A lone extensionless file must not resolve at all — it cannot be
        // spawned by CreateProcess.
        std::fs::write(tmp.path().join("qmd"), b"#!/bin/sh\n").unwrap();
        assert!(which::which_in(
            "qmd",
            Some(tmp.path().to_string_lossy().as_ref()),
            tmp.path(),
        )
        .is_err());
    }

    fn zip_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    fn path_entries_lower() -> Vec<String> {
        extended_search_path()
            .split(';')
            .map(|e| e.to_lowercase())
            .collect()
    }

    fn path_entry_position(entries: &[String], path: PathBuf) -> usize {
        let needle = path.to_string_lossy().to_lowercase();
        entries
            .iter()
            .position(|e| e == &needle)
            .unwrap_or_else(|| panic!("PATH should contain {needle}"))
    }

    #[test]
    fn managed_node_zip_extracts_expected_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = format!("node-{WINDOWS_MANAGED_NODE_VERSION}-win-x64");
        let node = format!("{root}/node.exe");
        let npm = format!("{root}/npm.cmd");
        let npx = format!("{root}/npx.cmd");
        let bytes = zip_fixture(&[
            (&node, b"node"),
            (&npm, b"npm"),
            (&npx, b"npx"),
            (&format!("{root}/README.md"), b"readme"),
        ]);

        extract_managed_node_zip(&bytes, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
            .expect("node zip should extract");

        assert_eq!(std::fs::read(tmp.path().join("node.exe")).unwrap(), b"node");
        assert_eq!(std::fs::read(tmp.path().join("npm.cmd")).unwrap(), b"npm");
        assert_eq!(std::fs::read(tmp.path().join("npx.cmd")).unwrap(), b"npx");
        assert_eq!(
            std::fs::read(tmp.path().join("README.md")).unwrap(),
            b"readme"
        );
    }

    #[test]
    fn managed_node_zip_rejects_unsafe_or_wrong_root_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = format!("node-{WINDOWS_MANAGED_NODE_VERSION}-win-x64");
        let unsafe_name = format!("{root}/../evil.exe");
        let unsafe_zip = zip_fixture(&[(&unsafe_name, b"evil")]);
        let err =
            extract_managed_node_zip(&unsafe_zip, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
                .unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");

        let wrong_root = zip_fixture(&[
            ("node-wrong-win-x64/node.exe", b"node"),
            ("node-wrong-win-x64/npm.cmd", b"npm"),
            ("node-wrong-win-x64/npx.cmd", b"npx"),
        ]);
        let err =
            extract_managed_node_zip(&wrong_root, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
                .unwrap_err();
        assert!(err.contains("outside expected root"), "{err}");
    }

    #[test]
    fn yq_download_status_and_staged_write_are_hermetic() {
        let err = fetch_asset_with("https://example.invalid/yq", "yq", |_| {
            Ok(DownloadedAsset {
                status: 404,
                bytes: b"not found".to_vec(),
            })
        })
        .unwrap_err();
        assert!(err.contains("HTTP status 404"), "{err}");

        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("yq.exe");
        std::fs::write(&target, b"old").unwrap();
        let bytes = b"fixture-yq";
        let sha = sha256_hex(bytes);
        install_yq_windows_from_bytes(bytes, &sha, &target, |staged| {
            assert!(staged.exists());
            assert_eq!(std::fs::read(staged).unwrap(), bytes);
            Ok(())
        })
        .expect("verified yq bytes should install");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);

        let err =
            install_yq_windows_from_bytes(b"tampered", &sha, &target, |_| Ok(())).unwrap_err();
        assert!(err.contains("checksum mismatch"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    // --- HQ-DESKTOP-5A: managed-download retry + instrumentation ------------

    #[test]
    fn a_transient_download_failure_is_retried_and_can_succeed() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // One transient body-read failure then success. The captured-by-ref
        // AtomicUsize keeps the closure `Fn` (hence both `FnOnce` and `FnMut`),
        // so this test compiled unchanged at the base too — where fetch ran
        // exactly once and the retry never happened.
        let calls = AtomicUsize::new(0);
        let result = fetch_asset_with("https://example.invalid/node", "Node zip", |_| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("Failed to read Node zip response: error decoding response body".to_string())
            } else {
                Ok(DownloadedAsset {
                    status: 200,
                    bytes: b"node".to_vec(),
                })
            }
        });
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "one blip should be retried"
        );
        assert_eq!(result.unwrap(), b"node".to_vec());
    }

    #[test]
    fn download_retries_are_bounded_and_report_the_attempt_count() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // An always-failing transport error is retried exactly DOWNLOAD_ATTEMPTS
        // times — never an unbounded loop — and the final error names the count.
        let calls = AtomicUsize::new(0);
        let err = fetch_asset_with("https://example.invalid/node", "Node zip", |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Err("error decoding response body".to_string())
        })
        .unwrap_err();
        assert_eq!(calls.load(Ordering::SeqCst), DOWNLOAD_ATTEMPTS as usize);
        assert!(
            err.contains(&format!(
                "attempt {DOWNLOAD_ATTEMPTS} of {DOWNLOAD_ATTEMPTS}"
            )),
            "{err}"
        );
    }

    #[test]
    fn a_terminal_http_status_is_not_retried() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // A terminal 404 is attempted exactly once and keeps the existing
        // message; a retryable 5xx is retried up to the cap.
        let calls = AtomicUsize::new(0);
        let err = fetch_asset_with("https://example.invalid/node", "Node zip", |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(DownloadedAsset {
                status: 404,
                bytes: b"not found".to_vec(),
            })
        })
        .unwrap_err();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "404 must not be retried");
        assert!(err.contains("HTTP status 404"), "{err}");

        let calls = AtomicUsize::new(0);
        let err = fetch_asset_with("https://example.invalid/node", "Node zip", |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(DownloadedAsset {
                status: 503,
                bytes: Vec::new(),
            })
        })
        .unwrap_err();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            DOWNLOAD_ATTEMPTS as usize,
            "503 is retryable"
        );
        assert!(err.contains("HTTP status 503"), "{err}");
    }

    #[test]
    fn the_total_download_budget_stays_inside_the_repair_slot() {
        // A repair holds the shared 15-minute slot; the whole worst-case
        // download budget must finish strictly inside it or a repair could
        // outlive the slot it holds.
        assert!(
            DOWNLOAD_BACKOFF.len() as u32 >= DOWNLOAD_ATTEMPTS - 1,
            "need a backoff for every retry gap"
        );
        let backoff: Duration = DOWNLOAD_BACKOFF
            .iter()
            .take((DOWNLOAD_ATTEMPTS - 1) as usize)
            .copied()
            .sum();
        let worst_case = DOWNLOAD_ATTEMPT_TIMEOUT * DOWNLOAD_ATTEMPTS + backoff;
        assert!(
            worst_case < crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN,
            "download budget {worst_case:?} must stay under repair cooldown {:?}",
            crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN
        );

        // The swap-retry budget is spent AFTER the download inside the SAME
        // repair slot, so the combined worst case must also stay strictly under
        // the cooldown (HQ-DESKTOP-5N).
        assert!(
            SWAP_BACKOFF.len() as u32 >= SWAP_ATTEMPTS - 1,
            "need a swap backoff for every retry gap"
        );
        let swap_budget: Duration = SWAP_BACKOFF.iter().copied().sum();
        assert!(
            worst_case + swap_budget < crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN,
            "download + swap budget {:?} must stay under repair cooldown {:?}",
            worst_case + swap_budget,
            crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN
        );
    }

    #[test]
    fn a_download_failure_reports_its_cause_chain() {
        // A reqwest timeout is a Kind::Decode whose Display is the causeless
        // "error decoding response body"; the real fault lives only in
        // source(). error_chain must render both layers so a future occurrence
        // is self-identifying — guarding against a regression to bare `{e}`.
        #[derive(Debug)]
        struct Layer {
            msg: &'static str,
            source: Option<Box<Layer>>,
        }
        impl std::fmt::Display for Layer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.msg)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.source
                    .as_deref()
                    .map(|e| e as &(dyn std::error::Error + 'static))
            }
        }
        let err = Layer {
            msg: "error decoding response body",
            source: Some(Box::new(Layer {
                msg: "operation timed out",
                source: None,
            })),
        };
        let rendered = error_chain(&err);
        assert_eq!(
            rendered,
            "error decoding response body: operation timed out"
        );
    }

    #[test]
    fn mingit_zip_extracts_flat_layout() {
        let tmp = tempfile::tempdir().unwrap();
        // MinGit has no top-level root dir — entries sit at the archive root.
        let bytes = zip_fixture(&[
            ("cmd/git.exe", b"git"),
            ("mingw64/bin/git.exe", b"git-core"),
            ("etc/gitconfig", b"[core]\n"),
            ("LICENSE.txt", b"license"),
        ]);

        extract_mingit_zip(&bytes, tmp.path()).expect("mingit zip should extract");

        assert_eq!(
            std::fs::read(tmp.path().join("cmd").join("git.exe")).unwrap(),
            b"git"
        );
        assert_eq!(
            std::fs::read(tmp.path().join("mingw64").join("bin").join("git.exe")).unwrap(),
            b"git-core"
        );
        assert_eq!(
            std::fs::read(tmp.path().join("LICENSE.txt")).unwrap(),
            b"license"
        );
    }

    #[test]
    fn mingit_zip_rejects_unsafe_entries_and_missing_git() {
        let tmp = tempfile::tempdir().unwrap();
        let unsafe_zip = zip_fixture(&[("cmd/../evil.exe", b"evil")]);
        let err = extract_mingit_zip(&unsafe_zip, tmp.path()).unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");

        let tmp2 = tempfile::tempdir().unwrap();
        let incomplete = zip_fixture(&[("LICENSE.txt", b"license")]);
        let err = extract_mingit_zip(&incomplete, tmp2.path()).unwrap_err();
        assert!(err.contains("missing required file"), "{err}");
    }

    #[test]
    fn mingit_pin_matches_expected_asset_and_sha_shape() {
        assert_eq!(WINDOWS_MINGIT_VERSION, "2.54.0");
        assert_eq!(
            WINDOWS_MINGIT_URL,
            "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-64-bit.zip"
        );
        assert_eq!(
            WINDOWS_MINGIT_SHA256,
            "04f937e1f0918b17b9be6f2294cb2bb66e96e1d9832d1c298e2de088a1d0e668"
        );
        assert_eq!(WINDOWS_MINGIT_SHA256.len(), 64);
        assert!(WINDOWS_MINGIT_SHA256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn rsync_zip_extracts_bin_and_rejects_bad_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = zip_fixture(&[
            ("portable-rsync/bin/rsync.exe", b"rsync"),
            ("portable-rsync/bin/ssh.exe", b"ssh"),
            ("portable-rsync/docs/readme.txt", b"ignored"),
        ]);
        extract_rsync_zip_to_bin(&bytes, tmp.path()).expect("rsync zip should extract");
        assert_eq!(
            std::fs::read(tmp.path().join("rsync.exe")).unwrap(),
            b"rsync"
        );
        assert_eq!(std::fs::read(tmp.path().join("ssh.exe")).unwrap(), b"ssh");
        assert!(!tmp.path().join("readme.txt").exists());

        let unsafe_zip = zip_fixture(&[("../evil.exe", b"evil")]);
        let err = extract_rsync_zip_to_bin(&unsafe_zip, tmp.path()).unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");

        let missing = zip_fixture(&[("portable-rsync/bin/ssh.exe", b"ssh")]);
        let err = extract_rsync_zip_to_bin(&missing, tmp.path()).unwrap_err();
        assert!(err.contains("bin/rsync.exe"), "{err}");
    }

    #[test]
    fn shim_writers_emit_expected_files() {
        let tmp = tempfile::tempdir().unwrap();
        let qmd_prefix = tmp.path().join("npm-prefix");
        let qmd_bin = qmd_prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("bin")
            .join("qmd");
        std::fs::create_dir_all(qmd_bin.parent().unwrap()).unwrap();
        std::fs::write(&qmd_bin, b"").unwrap();
        let git_bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        write_qmd_bash_shim_in(&qmd_prefix, Some(git_bash)).expect("qmd shim should write");
        let qmd_cmd = std::fs::read_to_string(qmd_prefix.join("qmd.cmd")).unwrap();
        // Supplying an explicit Git Bash fixture verifies the launcher uses its
        // absolute path and targets this package's script-relative entry point.
        assert!(
            qmd_cmd.contains(
                r#""C:\Program Files\Git\bin\bash.exe" "%~dp0node_modules\@tobilu\qmd\bin\qmd" %*"#,
            ),
            "{qmd_cmd}"
        );
        assert!(
            !qmd_cmd.to_lowercase().contains("system32"),
            "shim must never invoke the WSL launcher: {qmd_cmd}"
        );

        let npm_bin = tmp.path().join("npm-bin");
        write_rsync_shim_in(&npm_bin).expect("rsync shims should write");
        assert!(npm_bin.join("rsync.cmd").is_file());
        let ps1 = std::fs::read_to_string(npm_bin.join("rsync.ps1")).unwrap();
        assert!(ps1.contains("/cygdrive/$drive/$rest"));

        let tool_bin = tmp.path().join("tool-bin");
        write_shasum_shim_in(&tool_bin).expect("shasum shim should write");
        let shasum = std::fs::read_to_string(tool_bin.join("shasum")).unwrap();
        assert!(shasum.contains("exec sha256sum"));
    }

    #[test]
    fn qmd_postinstall_replaces_a_resolving_npm_shim_with_the_verified_target() {
        let tmp = tempfile::tempdir().unwrap();
        let qmd_prefix = tmp.path().join("npm-prefix");
        std::fs::create_dir_all(&qmd_prefix).unwrap();
        let package_bin = qmd_prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("bin")
            .join("qmd");
        std::fs::create_dir_all(package_bin.parent().unwrap()).unwrap();
        std::fs::write(&package_bin, b"#!/usr/bin/env node\n").unwrap();
        let npm_shim = "@echo off\r\necho qmd\r\n";
        std::fs::write(qmd_prefix.join("qmd.cmd"), npm_shim).unwrap();

        // Name resolution alone accepts npm's shim, even if it does not run
        // the package entry point needed by this install's Bash launch path.
        assert!(which::which_in(
            "qmd",
            Some(qmd_prefix.to_string_lossy().as_ref()),
            &qmd_prefix,
        )
        .is_ok());
        let git_bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        write_qmd_bash_shim_in(&qmd_prefix, Some(git_bash))
            .expect("qmd shim should target the installed package");
        let rewritten = std::fs::read_to_string(qmd_prefix.join("qmd.cmd")).unwrap();
        assert_ne!(rewritten, npm_shim);
        assert!(
            rewritten.contains(
                r#""C:\Program Files\Git\bin\bash.exe" "%~dp0node_modules\@tobilu\qmd\bin\qmd" %*"#,
            ),
            "{rewritten}"
        );
    }

    #[test]
    fn qmd_postinstall_keeps_a_valid_npm_shim_when_git_bash_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let qmd_prefix = tmp.path().join("npm-prefix");
        let package_bin = qmd_prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("bin")
            .join("qmd");
        std::fs::create_dir_all(package_bin.parent().unwrap()).unwrap();
        std::fs::write(&package_bin, b"#!/usr/bin/env node\n").unwrap();
        let npm_shim = "@ECHO off\r\nCALL \"%~dp0node_modules\\@tobilu\\qmd\\bin\\qmd\" %*\r\n";
        let cmd_path = qmd_prefix.join("qmd.cmd");
        std::fs::write(&cmd_path, npm_shim).unwrap();

        write_qmd_bash_shim_in(&qmd_prefix, None).expect("valid npm shim should be preserved");

        assert_eq!(std::fs::read_to_string(cmd_path).unwrap(), npm_shim);
    }

    #[test]
    fn qmd_postinstall_without_git_bash_rejects_a_missing_or_unrelated_npm_shim() {
        for create_unrelated_shim in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let qmd_prefix = tmp.path().join("npm-prefix");
            let package_bin = qmd_prefix
                .join("node_modules")
                .join("@tobilu")
                .join("qmd")
                .join("bin")
                .join("qmd");
            std::fs::create_dir_all(package_bin.parent().unwrap()).unwrap();
            std::fs::write(&package_bin, b"#!/usr/bin/env node\n").unwrap();
            let cmd_path = qmd_prefix.join("qmd.cmd");
            if create_unrelated_shim {
                std::fs::write(&cmd_path, "@ECHO off\r\necho qmd\r\n").unwrap();
            }

            let error = write_qmd_bash_shim_in(&qmd_prefix, None)
                .expect_err("missing or unrelated npm shim must not become a bare bash shim");

            assert!(
                error.contains("qmd.cmd does not reference the installed package entry point"),
                "{error}"
            );
            assert_eq!(
                std::fs::read_to_string(&cmd_path).ok(),
                create_unrelated_shim.then(|| "@ECHO off\r\necho qmd\r\n".to_string())
            );
        }
    }

    #[test]
    fn winget_install_is_pinned_to_the_community_source() {
        let args = winget_install_args("Git.Git");
        assert_eq!(args[0], "install");
        assert_eq!(args[1], "--id");
        assert_eq!(args[2], "Git.Git");
        assert_eq!(args[3], "--source");
        assert_eq!(args[4], "winget");
        assert!(args.contains(&"--accept-source-agreements"));
        assert!(args.contains(&"--accept-package-agreements"));
    }

    #[test]
    fn hq_cli_pack_install_patch_rewrites_rsync_once() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("pack-install.js");
        let source = "import fs from 'fs';\nimport path from 'path';\nfunction copy(srcSlashed, destSlashed) {\n    execFileSync('rsync', [\n        '-a',\n        '--exclude=.git',\n        '--exclude=node_modules',\n        '--exclude=.DS_Store',\n        srcSlashed,\n        destSlashed,\n    ], { stdio: 'inherit' });\n}\n";
        std::fs::write(&target, source).unwrap();

        patch_hq_cli_pack_install_rsync_at(&target).expect("patch should apply");
        patch_hq_cli_pack_install_rsync_at(&target).expect("patch should be idempotent");

        let patched = std::fs::read_to_string(&target).unwrap();
        assert!(patched.contains("hq-installer: rsync -> fs.cpSync patch applied"));
        assert!(patched.contains("fs.cpSync(srcSlashed, destSlashed"));
        assert!(!patched.contains("execFileSync('rsync'"));
        assert_eq!(
            patched
                .matches("hq-installer: rsync -> fs.cpSync patch applied")
                .count(),
            1
        );
    }

    #[test]
    fn registry_path_decode_rejects_non_string_values() {
        let raw = RegValue {
            bytes: vec![1, 2, 3, 4],
            vtype: winreg::enums::REG_BINARY,
        };
        let err = decode_registry_string(&raw, "Path").unwrap_err();
        assert!(err.contains("unsupported registry type"), "{err}");
    }

    #[test]
    fn managed_toolchain_dir_under_localappdata() {
        let dir = managed_toolchain_dir();
        let path_str = dir.to_string_lossy().to_lowercase();
        assert!(path_str.contains("indigohq"));
        assert!(path_str.contains("toolchain"));
    }

    #[test]
    fn extended_search_path_contains_system32_and_managed_node() {
        let path = extended_search_path();
        let lower = path.to_lowercase();
        assert!(lower.contains("system32"), "PATH should include System32");
        assert!(
            lower.contains("indigohq") && lower.contains("toolchain"),
            "PATH should include the managed toolchain dir"
        );
    }

    #[test]
    fn extended_search_path_contains_winget_node_dirs() {
        // Regression: a Node installed via winget (OpenJS.NodeJS.LTS) lands in
        // `C:\Program Files\nodejs` (machine) or `%LOCALAPPDATA%\Programs\nodejs`
        // (user scope). Both must be on the in-session search path or the
        // npm-based deps (qmd, hq-cli) fail with "'npm' not found on PATH" right
        // after Node installs in the same setup run.
        let entries = path_entries_lower();
        let machine = program_files()
            .join("nodejs")
            .to_string_lossy()
            .to_lowercase();
        let user = local_app_data()
            .join("Programs")
            .join("nodejs")
            .to_string_lossy()
            .to_lowercase();
        assert!(
            entries.iter().any(|e| e == &machine),
            "PATH should include the machine-scope winget Node dir (Program Files\\nodejs)"
        );
        assert!(
            entries.iter().any(|e| e == &user),
            "PATH should include the user-scope winget Node dir (LOCALAPPDATA\\Programs\\nodejs)"
        );
    }

    #[test]
    fn extended_search_path_orders_managed_and_winget_before_system_git() {
        let entries = path_entries_lower();
        let managed_node = path_entry_position(&entries, managed_node_bin());
        let managed_npm = path_entry_position(&entries, managed_npm_bin());
        let managed_tool_bin = path_entry_position(&entries, managed_toolchain_dir().join("bin"));
        let managed_git_cmd_pos = path_entry_position(&entries, managed_git_cmd());
        let managed_git_mingw = path_entry_position(&entries, managed_git_mingw_bin());
        let winget_node_machine = path_entry_position(&entries, program_files().join("nodejs"));
        let winget_node_user =
            path_entry_position(&entries, local_app_data().join("Programs").join("nodejs"));
        let system_git_bin = path_entry_position(&entries, program_files().join("Git").join("bin"));
        let system_git_usr = path_entry_position(
            &entries,
            program_files().join("Git").join("usr").join("bin"),
        );
        let system_git_cmd = path_entry_position(&entries, program_files().join("Git").join("cmd"));

        assert!(
            managed_node < managed_npm
                && managed_npm < managed_tool_bin
                && managed_tool_bin < managed_git_cmd_pos
                && managed_git_cmd_pos < managed_git_mingw
                && managed_git_mingw < winget_node_machine
                && winget_node_machine < winget_node_user
                && winget_node_user < system_git_bin
                && system_git_bin < system_git_usr
                && system_git_usr < system_git_cmd,
            "managed Git and winget Node dirs should precede system Git dirs: {entries:?}"
        );
    }

    #[test]
    fn extended_search_path_contains_managed_git_dirs() {
        let entries = path_entries_lower();
        let cmd = managed_git_cmd().to_string_lossy().to_lowercase();
        let mingw = managed_git_mingw_bin().to_string_lossy().to_lowercase();
        assert!(
            entries.iter().any(|e| e == &cmd),
            "PATH should include the managed Git cmd dir"
        );
        assert!(
            entries.iter().any(|e| e == &mingw),
            "PATH should include the managed Git mingw64\\bin dir"
        );
    }

    #[test]
    fn managed_git_dirs_under_toolchain() {
        for dir in [
            managed_git_dir(),
            managed_git_cmd(),
            managed_git_mingw_bin(),
        ] {
            let p = dir.to_string_lossy().to_lowercase();
            assert!(p.contains("indigohq") && p.contains("toolchain"), "{p}");
            assert!(p.contains("git"), "{p}");
        }
    }

    #[test]
    fn managed_node_arch_maps_known_archs() {
        match std::env::consts::ARCH {
            "x86_64" => assert_eq!(managed_node_arch(), Some("x64")),
            "aarch64" => assert_eq!(managed_node_arch(), Some("arm64")),
            _ => assert_eq!(managed_node_arch(), None),
        }
    }

    #[test]
    fn user_path_append_then_remove_round_trip() {
        let unique = format!(
            "C:\\hq-test-{}",
            uuid::Uuid::new_v4().to_string().replace('-', "")
        );
        let p = PathBuf::from(&unique);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu
            .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
            .expect("HKCU\\Environment open");
        let before: String = env.get_value("Path").unwrap_or_default();

        append_user_path(&p).expect("append should succeed");
        let after_add: String = env.get_value("Path").unwrap_or_default();
        assert!(
            after_add
                .split(';')
                .any(|e| e.eq_ignore_ascii_case(&unique)),
            "PATH should contain unique entry after append"
        );

        append_user_path(&p).expect("second append should succeed");
        let after_reappend: String = env.get_value("Path").unwrap_or_default();
        assert_eq!(after_add, after_reappend, "second append should be a no-op");

        remove_user_path(&p).expect("remove should succeed");
        let after_remove: String = env.get_value("Path").unwrap_or_default();
        assert!(
            !after_remove
                .split(';')
                .any(|e| e.eq_ignore_ascii_case(&unique)),
            "PATH should not contain unique entry after remove"
        );

        let entries = |s: &str| {
            s.split(';')
                .filter(|e| !e.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            entries(&after_remove),
            entries(&before),
            "PATH entries should be restored to before (modulo empty segments)"
        );

        env.set_value("Path", &before)
            .expect("restore original PATH");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Managed-toolchain swap resilience (HQ-DESKTOP-5N / 5P)
// ─────────────────────────────────────────────────────────────────────────────
//
// Every helper under test here is platform-neutral, so these run in the
// rust-macos lane (`cargo test --locked`) and prove the retry/attribution/
// cleanup logic that the shipped single-shot swap lacked. The real-handle proof
// on Windows lives in `toolchain_swap_e2e_tests` below.
#[cfg(test)]
mod atomic_swap_tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{Error, ErrorKind};

    #[test]
    fn is_retryable_swap_error_classifies_real_io_errors() {
        // Built from REAL std::io::Error values, never a mock error type, so the
        // predicate is exercised against the type it will actually see.
        //
        // Portable signals hold on every platform: PermissionDenied (unix EACCES)
        // is retryable, NotFound is terminal.
        assert!(is_retryable_swap_error(&Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(!is_retryable_swap_error(&Error::from(ErrorKind::NotFound)));
        assert!(!is_retryable_swap_error(&Error::from_raw_os_error(2)));
        assert!(!is_retryable_swap_error(&Error::from_raw_os_error(13_579)));

        // The bare sharing/lock codes are retryable ONLY on Windows; on other
        // platforms those numbers mean unrelated, usually terminal errors (unix
        // EIO=5, EPIPE=32) and must NOT be retried by the shared swap paths.
        #[cfg(windows)]
        for code in [5, 32, 33, 145] {
            assert!(
                is_retryable_swap_error(&Error::from_raw_os_error(code)),
                "windows code {code} is retryable"
            );
        }
        #[cfg(not(windows))]
        for code in [5, 32, 33, 145] {
            assert!(
                !is_retryable_swap_error(&Error::from_raw_os_error(code)),
                "off Windows, raw code {code} must not be a sharing/lock match"
            );
        }
    }

    #[test]
    fn the_swap_budget_stays_inside_the_repair_slot() {
        assert!(
            SWAP_BACKOFF.len() as u32 >= SWAP_ATTEMPTS - 1,
            "need a backoff for every retry gap"
        );
        let swap_budget: Duration = SWAP_BACKOFF.iter().copied().sum();
        assert!(
            swap_budget < crate::commands::sync::TOOLCHAIN_REPAIR_COOLDOWN,
            "swap budget {swap_budget:?} must stay under the repair cooldown"
        );
    }

    #[test]
    fn retry_swap_op_rides_out_a_retryable_error_then_succeeds() {
        let calls = Cell::new(0u32);
        let result = retry_swap_op(SwapPhase::Backup, || {
            let n = calls.get() + 1;
            calls.set(n);
            if n < 3 {
                // PermissionDenied is the portable retryable signal (raw codes
                // are retryable only on Windows).
                Err(Error::from(ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok(), "a transient denial should be ridden out");
        assert_eq!(
            calls.get(),
            3,
            "the first two attempts really ran and failed"
        );
    }

    #[test]
    fn retry_swap_op_stops_at_the_first_terminal_error() {
        let calls = Cell::new(0u32);
        let err = retry_swap_op(SwapPhase::Activate, || {
            calls.set(calls.get() + 1);
            Err(Error::from(ErrorKind::NotFound))
        })
        .unwrap_err();
        assert_eq!(
            calls.get(),
            1,
            "NotFound is terminal and must not be retried"
        );
        assert_eq!(err.phase, SwapPhase::Activate);
    }

    #[test]
    fn retry_swap_op_reports_attempts_phase_and_os_code_after_a_persistent_denial() {
        // A retryable denial that ALSO carries a raw OS code, chosen per platform
        // so it maps to PermissionDenied everywhere (unix EACCES=13, Windows
        // ERROR_ACCESS_DENIED=5) — proving both the retry count and that the raw
        // code is surfaced in the attribution.
        #[cfg(windows)]
        const DENIAL_CODE: i32 = 5;
        #[cfg(not(windows))]
        const DENIAL_CODE: i32 = 13;
        let err = retry_swap_op(SwapPhase::Restore, || {
            Err(Error::from_raw_os_error(DENIAL_CODE))
        })
        .unwrap_err();
        assert_eq!(err.attempts, SWAP_ATTEMPTS);
        let msg = err.describe("dir");
        assert!(msg.contains("phase=restore"), "{msg}");
        assert!(msg.contains(&format!("os_error={DENIAL_CODE}")), "{msg}");
        assert!(
            msg.contains(&format!("attempts={SWAP_ATTEMPTS} of {SWAP_ATTEMPTS}")),
            "{msg}"
        );
        assert!(msg.contains("target_state=dir"), "{msg}");
    }

    #[test]
    fn an_already_provisioned_managed_node_short_circuits_the_swap() {
        let dir = tempfile::TempDir::new().unwrap();
        let node_exe = dir.path().join("node.exe");
        // Absent -> never short-circuits (nothing to accept).
        assert!(!managed_node_already_usable(&node_exe, |_| true));
        std::fs::write(&node_exe, b"binary").unwrap();
        // Present and passing the pinned version check -> accept.
        assert!(managed_node_already_usable(&node_exe, |_| true));
        // Present but wrong/corrupt version -> do NOT wave it through.
        assert!(!managed_node_already_usable(&node_exe, |_| false));
    }

    #[test]
    fn forced_repair_accepts_only_a_changed_concurrent_node() {
        assert!(!managed_node_changed_since_repair_started(Some("old"), Some("old")));
        assert!(managed_node_changed_since_repair_started(Some("old"), Some("new")));
        assert!(!managed_node_changed_since_repair_started(Some("old"), None));
        assert!(managed_node_changed_since_repair_started(None, Some("new")));
    }

    #[test]
    fn managed_node_sha256_streams_the_target_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let node_exe = dir.path().join("node.exe");
        assert_eq!(managed_node_sha256(&node_exe).unwrap(), None);
        std::fs::write(&node_exe, b"binary").unwrap();
        let actual = managed_node_sha256(&node_exe).unwrap().unwrap();
        use sha2::{Digest, Sha256};
        assert_eq!(actual, format!("{:x}", Sha256::digest(b"binary")));
    }

    #[test]
    fn native_crash_repair_replaces_an_existing_versioned_node() {
        let dir = tempfile::TempDir::new().unwrap();
        let node_exe = dir.path().join("node.exe");
        std::fs::write(&node_exe, b"binary").unwrap();

        assert!(managed_node_should_be_reused(false, &node_exe, |_| true));
        assert!(!managed_node_should_be_reused(false, &node_exe, |_| false));
        assert!(
            !managed_node_should_be_reused(true, &node_exe, |_| true),
            "native-crash repair must not trust --version alone on the old runtime"
        );
    }

    #[test]
    fn is_stale_toolchain_sibling_matches_only_aged_swap_debris() {
        let min = Duration::from_secs(900);
        // An aged staging tree is swept.
        assert!(is_stale_toolchain_sibling(
            ".node-install-xyz",
            Some(Duration::from_secs(901)),
            min
        ));
        // A backup is NEVER aged by mtime — a rename preserves the old dir's
        // mtime, so an actively-used rollback backup could be misjudged as old.
        assert!(!is_stale_toolchain_sibling(
            ".node.bak.abc",
            Some(Duration::from_secs(1000)),
            min
        ));
        // A fresh staging tree is a concurrent install's in-flight tree -> keep.
        assert!(!is_stale_toolchain_sibling(
            ".node-install-live",
            Some(Duration::from_secs(1)),
            min
        ));
        // Undatable -> keep (never delete what we cannot age).
        assert!(!is_stale_toolchain_sibling(".node-install-x", None, min));
        // Non-debris names are never swept, at any age.
        assert!(!is_stale_toolchain_sibling(
            "node",
            Some(Duration::from_secs(99_999)),
            min
        ));
        assert!(!is_stale_toolchain_sibling("git", None, min));
    }

    #[test]
    fn describe_target_state_names_the_occupant() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(describe_target_state(&dir.path().join("nope")), "absent");
        let d = dir.path().join("d");
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(describe_target_state(&d), "dir");
        let f = dir.path().join("f");
        std::fs::write(&f, b"x").unwrap();
        assert_eq!(describe_target_state(&f), "file");
    }

    #[test]
    fn atomic_replace_file_swaps_and_removes_the_backup() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join("f");
        std::fs::write(&target, b"OLD").unwrap();
        let staged = dir.path().join("staged");
        std::fs::write(&staged, b"NEW").unwrap();
        atomic_replace_file(&staged, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
        let leftover = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".f.bak."));
        assert!(!leftover, "the backup must be removed after a clean swap");
    }
}

// Real-filesystem swap orchestration proved with genuine OS rename denials
// (chmod-based on unix). Runs in the rust-macos lane.
#[cfg(all(test, unix))]
mod atomic_swap_unix_tests {
    use super::*;
    use std::cell::Cell;
    use std::os::unix::fs::PermissionsExt as _;

    fn set_mode(path: &Path, mode: u32) {
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(mode);
        std::fs::set_permissions(path, perms).unwrap();
    }

    fn has_bak_sibling(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".node.bak."))
    }

    #[test]
    fn a_transient_rename_denial_is_retried_until_the_swap_succeeds() {
        // A REAL OS rename denial (a read-only parent) that a real filesystem
        // change lifts partway through the budget must be ridden out, not fail on
        // the first try the way the shipped single-shot swap did.
        let root = tempfile::TempDir::new().unwrap();
        let parent = root.path().join("toolchain");
        std::fs::create_dir_all(&parent).unwrap();
        let staged = root.path().join("staged.txt");
        std::fs::write(&staged, b"NEW").unwrap();
        let target = parent.join("node");
        set_mode(&parent, 0o555);

        let attempts = Cell::new(0u32);
        let result = retry_swap_op(SwapPhase::Activate, || {
            let n = attempts.get() + 1;
            attempts.set(n);
            if n >= 3 {
                set_mode(&parent, 0o755); // a real fs change lifts the denial
            }
            std::fs::rename(&staged, &target)
        });
        set_mode(&parent, 0o755);

        assert!(result.is_ok(), "the transient denial should be ridden out");
        assert!(attempts.get() >= 3, "the earlier attempts really failed");
        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
    }

    #[test]
    fn a_persistent_rename_denial_fails_terminally_within_the_budget() {
        let root = tempfile::TempDir::new().unwrap();
        let toolchain = root.path().join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let target = toolchain.join("node");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("VERSION"), b"OLD").unwrap();
        let staged = root.path().join("staged");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("VERSION"), b"NEW").unwrap();
        set_mode(&toolchain, 0o555); // deny the backup rename, persistently

        let err = atomic_replace_dir(&staged, &target).unwrap_err();
        set_mode(&toolchain, 0o755);

        assert!(
            err.starts_with("backup existing "),
            "leading shape preserved: {err}"
        );
        assert!(err.contains("phase=backup"), "{err}");
        assert!(
            err.contains(&format!("attempts={SWAP_ATTEMPTS} of {SWAP_ATTEMPTS}")),
            "{err}"
        );
        assert!(err.contains("target_state=dir"), "{err}");
        // The pre-existing install is untouched.
        assert_eq!(std::fs::read(target.join("VERSION")).unwrap(), b"OLD");
    }

    #[test]
    fn a_failed_swap_never_strands_the_staged_install() {
        // The toolchain dir is read-only (denying the swap) but the staged tree
        // lives in a separate writable dir — exactly the real shape, where the
        // toolchain is writable enough to drop the staged sibling and only the
        // specific handle blocks the rename.
        let root = tempfile::TempDir::new().unwrap();
        let toolchain = root.path().join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let target = toolchain.join("node");
        std::fs::create_dir_all(&target).unwrap();
        let stage_area = root.path().join("stage");
        std::fs::create_dir_all(&stage_area).unwrap();
        let staged = stage_area.join(".node-install-abc");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("node"), b"NEW").unwrap();
        set_mode(&toolchain, 0o555);

        let err = activate_staged_dir(&staged, &target).unwrap_err();
        set_mode(&toolchain, 0o755);

        assert!(err.contains("phase=backup"), "{err}");
        assert!(
            !staged.exists(),
            "the validated staged tree must be cleaned up, not stranded"
        );
    }

    #[test]
    fn a_backup_that_cannot_be_removed_does_not_fail_a_completed_install() {
        // HQ-DESKTOP-5P: the activate rename succeeds, but the OLD copy (now the
        // backup) contains an undeletable subtree — the unix stand-in for a
        // still-mapped node.exe image that Windows lets you rename but not delete.
        // A completed install must return Ok, not page.
        let root = tempfile::TempDir::new().unwrap();
        let toolchain = root.path().join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let target = toolchain.join("node");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("VERSION"), b"OLD").unwrap();
        let locked = target.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("f"), b"x").unwrap();
        set_mode(&locked, 0o000); // its contents cannot be removed
        let staged = root.path().join("staged");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("VERSION"), b"NEW").unwrap();

        let result = atomic_replace_dir(&staged, &target);

        // Restore perms on the moved-away backup so the tempdir can be cleaned up.
        for e in std::fs::read_dir(&toolchain).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with(".node.bak.") {
                let _ = std::fs::set_permissions(
                    e.path().join("locked"),
                    std::fs::Permissions::from_mode(0o755),
                );
            }
        }

        assert!(
            result.is_ok(),
            "a cleanup-only failure must not fail the install: {result:?}"
        );
        assert_eq!(
            std::fs::read(target.join("VERSION")).unwrap(),
            b"NEW",
            "the fresh payload is live at the target"
        );
    }

    #[test]
    fn a_non_directory_target_is_replaced_rather_than_backed_up_forever() {
        let root = tempfile::TempDir::new().unwrap();
        let toolchain = root.path().join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let target = toolchain.join("node");
        std::fs::write(&target, b"stray file").unwrap(); // a non-directory occupant
        let staged = root.path().join("staged");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("node.exe"), b"NEW").unwrap();

        atomic_replace_dir(&staged, &target).unwrap();

        assert!(
            target.is_dir(),
            "the staged directory now occupies the target"
        );
        assert_eq!(std::fs::read(target.join("node.exe")).unwrap(), b"NEW");
        assert!(
            !has_bak_sibling(&toolchain),
            "a stray non-directory must be removed, never backed up"
        );
    }

    #[test]
    fn the_restore_path_is_retried_too() {
        // Backup succeeds, activation fails persistently, and the restore rename
        // (which rides the same retry driver) returns the original install to the
        // target instead of losing it.
        let root = tempfile::TempDir::new().unwrap();
        let toolchain = root.path().join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let target = toolchain.join("node");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("VERSION"), b"OLD").unwrap();
        let stage_area = root.path().join("stage");
        std::fs::create_dir_all(&stage_area).unwrap();
        let staged = stage_area.join("staged");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("VERSION"), b"NEW").unwrap();
        // Deny moving the staged tree OUT of stage_area so ACTIVATE fails, while
        // the toolchain stays writable so BACKUP and RESTORE both work.
        set_mode(&stage_area, 0o555);

        let err = atomic_replace_dir(&staged, &target).unwrap_err();
        set_mode(&stage_area, 0o755);

        assert!(err.starts_with("rename "), "{err}");
        assert!(err.contains("phase=activate"), "{err}");
        assert!(target.is_dir());
        assert_eq!(
            std::fs::read(target.join("VERSION")).unwrap(),
            b"OLD",
            "the original install is restored"
        );
        assert!(
            !has_bak_sibling(&toolchain),
            "the restore should have consumed the backup"
        );
    }

    #[test]
    fn describe_target_state_names_a_symlink() {
        let root = tempfile::TempDir::new().unwrap();
        let dest = root.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&dest, &link).unwrap();
        assert_eq!(describe_target_state(&link), "symlink");
    }

    #[test]
    fn sweep_removes_only_matching_debris() {
        let dir = tempfile::TempDir::new().unwrap();
        let bak = dir.path().join(".node.bak.old");
        std::fs::create_dir_all(&bak).unwrap();
        let install = dir.path().join(".node-install-old");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("f"), b"x").unwrap();
        let keep = dir.path().join("node");
        std::fs::create_dir_all(&keep).unwrap();

        // min_age ZERO -> any age qualifies, so both debris trees are swept now
        // while a real toolchain dir is left alone.
        sweep_stale_toolchain_siblings(dir.path(), Duration::ZERO);

        assert!(!install.exists(), "a stale .node-install-* is swept");
        // A backup is left alone — it could be a concurrent swap's live rollback.
        assert!(bak.exists(), "a .node.bak.* backup is never swept");
        assert!(keep.exists(), "a real toolchain directory is kept");
    }
}

// Real Win32 open-handle proof (HQ-DESKTOP-5N). #[ignore]-marked so the general
// `cargo test --bins` run skips them; the dedicated windows-check step runs them
// with --include-ignored --test-threads=1. A file opened without delete-share
// reproduces the exact production ERROR_ACCESS_DENIED (os error 5) on the backup
// rename; the File's Drop closes the handle even if an assertion panics.
#[cfg(all(test, windows))]
mod toolchain_swap_e2e_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::sync::{Arc, Barrier};

    const FILE_SHARE_READ: u32 = 0x0000_0001;

    fn make_tree(root: &Path) -> (PathBuf, PathBuf) {
        let toolchain = root.join("toolchain");
        std::fs::create_dir_all(&toolchain).unwrap();
        let node = toolchain.join("node");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("node.exe"), b"OLD").unwrap();
        let staged = toolchain.join(".node-install-e2e");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("node.exe"), b"NEW").unwrap();
        (node, staged)
    }

    fn open_no_delete_share(file: &Path) -> std::fs::File {
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ) // deliberately NO FILE_SHARE_DELETE
            .open(file)
            .expect("open a live handle inside node without delete-share")
    }

    #[test]
    #[ignore = "real-handle artifact E2E; run explicitly in windows-check"]
    fn a_real_open_handle_denies_the_swap_then_a_release_lets_it_complete() {
        std::env::set_var("HQ_SWAP_TEST_BACKOFF_MS", "300");
        let root = tempfile::TempDir::new().unwrap();
        let (node, staged) = make_tree(root.path());

        let opened = open_no_delete_share(&node.join("node.exe"));
        let gate = Arc::new(Barrier::new(2));
        let g2 = gate.clone();
        let releaser = std::thread::spawn(move || {
            g2.wait();
            std::thread::sleep(Duration::from_millis(50));
            drop(opened); // release the handle well inside the retry budget
        });

        gate.wait();
        let result = atomic_replace_dir(&staged, &node);
        releaser.join().unwrap();
        std::env::remove_var("HQ_SWAP_TEST_BACKOFF_MS");

        assert!(
            result.is_ok(),
            "a transient handle must be ridden out: {result:?}"
        );
        assert_eq!(std::fs::read(node.join("node.exe")).unwrap(), b"NEW");
    }

    #[test]
    #[ignore = "real-handle artifact E2E; run explicitly in windows-check"]
    fn a_handle_held_for_the_whole_budget_fails_terminally_and_cleans_up() {
        std::env::set_var("HQ_SWAP_TEST_BACKOFF_MS", "0");
        let root = tempfile::TempDir::new().unwrap();
        let (node, staged) = make_tree(root.path());
        let opened = open_no_delete_share(&node.join("node.exe"));

        let err = activate_staged_dir(&staged, &node).unwrap_err();
        drop(opened);

        assert!(err.starts_with("backup existing "), "{err}");
        assert!(err.contains("phase=backup"), "{err}");
        assert!(err.contains("os_error="), "{err}");
        assert!(
            err.contains(&format!("attempts={SWAP_ATTEMPTS} of {SWAP_ATTEMPTS}")),
            "{err}"
        );
        assert_eq!(
            std::fs::read(node.join("node.exe")).unwrap(),
            b"OLD",
            "the pre-existing install is intact"
        );
        assert!(
            !staged.exists(),
            "the staged tree must be cleaned up, not stranded"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod shell_path_block_tests {
    use super::*;

    #[test]
    fn path_block_covers_git_and_local_bin_before_system_dirs() {
        let block = shell_path_block();
        let export = block.lines().find(|l| l.starts_with("export PATH=")).expect("export line");
        let idx = |needle: &str| export.find(needle).unwrap_or_else(|| panic!("missing {needle}"));
        assert!(idx("toolchain/node/bin") < idx("toolchain/npm-global/bin"));
        assert!(idx("toolchain/npm-global/bin") < idx("toolchain/git-shim"));
        assert!(idx("toolchain/git-shim") < idx("$HOME/.local/bin"));
        assert!(idx("$HOME/.local/bin") < idx(":$PATH"));
        assert!(block.contains(SHELL_PATH_MARKER));
    }

    #[test]
    fn zsh_gets_zshrc_and_zprofile() {
        let home = std::path::Path::new("/Users/x");
        let primary = shell_profile_path_in(home);
        let all = shell_profile_paths_in(home);
        assert_eq!(all[0], primary);
        if primary.ends_with(".zshrc") {
            assert_eq!(all.len(), 2);
            assert!(all[1].ends_with(".zprofile"));
        } else {
            assert_eq!(all.len(), 1);
        }
    }
}

#[cfg(all(test, not(windows)))]
mod git_shim_tests {
    use super::*;

    #[test]
    fn shim_written_only_when_portable_git_exists_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        assert!(ensure_managed_git_shim_in(home).is_err());
        let bin = managed_git_dir_in(home).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let git = bin.join("git");
        std::fs::write(&git, "#!/bin/sh\nprintf 'git version fixture'\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shim = ensure_managed_git_shim_in(home).expect("shim");
        let body = std::fs::read_to_string(&shim).unwrap();
        assert!(body.starts_with("#!/bin/sh"));
        assert!(
            body.contains("GIT_EXEC_PATH")
                && body.contains("GIT_TEMPLATE_DIR")
                && body.contains("exec ")
        );
        assert_eq!(
            std::fs::metadata(&shim).unwrap().permissions().mode() & 0o111,
            0o111
        );
        assert_eq!(ensure_managed_git_shim_in(home), Ok(shim));
    }

    #[test]
    fn qmd_pin_matches_setup_sh_contract() {
        assert_eq!(MANAGED_QMD_VERSION, "2.5.3");
    }
}

#[cfg(all(test, not(windows)))]
mod managed_node_health_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn stub(dir: &std::path::Path, body: &str) -> PathBuf {
        let p = dir.join("node");
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn healthy_node_reports_version() {
        let tmp = tempfile::tempdir().unwrap();
        let p = stub(tmp.path(), &format!("#!/bin/sh\necho {MANAGED_NODE_VERSION}\n"));
        assert_eq!(managed_node_reported_version(&p).as_deref().map(str::trim), Some(MANAGED_NODE_VERSION));
    }

    #[test]
    fn broken_or_wrong_node_is_not_trusted() {
        let tmp = tempfile::tempdir().unwrap();
        let p = stub(tmp.path(), "#!/bin/sh\necho 'node: stale stub'; exit 97\n");
        assert_eq!(managed_node_reported_version(&p), None);
        let p = stub(tmp.path(), "#!/bin/sh\necho v16.20.2\n");
        assert_ne!(managed_node_reported_version(&p).as_deref().map(str::trim), Some(MANAGED_NODE_VERSION));
        assert_eq!(managed_node_reported_version(std::path::Path::new("/nonexistent/node")), None);
    }
}

#[cfg(test)]
mod disk_space_install_wiring_tests {
    #[test]
    fn npm_install_wires_preflight_before_cache_creation_and_translates_failures_for_users() {
        let source = include_str!("install_deps.rs");
        let install = source
            .split("async fn run_managed_npm_install_with_cancellation")
            .nth(1)
            .expect("managed npm install entry point");
        let preflight = install
            .find("installer_disk_space::ensure_setup_disk_space_at")
            .expect("managed npm storage preflight");
        let cache_creation = install
            .find("app_npm_cache(app)")
            .expect("app-owned npm cache creation");
        assert!(preflight < cache_creation, "space must be checked before preparing npm cache");
        let production_source = source
            .split("#[cfg(test)]\nmod disk_space_install_wiring_tests")
            .next()
            .expect("production source before wiring tests");
        assert_eq!(
            production_source
                .matches("installer_disk_space::user_facing_install_error(")
                .count(),
            2,
            "both platform command runners must translate npm disk-full failures"
        );
    }
}

#[cfg(test)]
mod dep_health_tests {
    use super::*;

    #[test]
    fn required_dep_on_disk_without_a_version_is_not_satisfied() {
        let qmd = dependency_defs().iter().find(|d| d.id == "qmd").unwrap();
        let stub = DepStatus { installed: true, version: None, path: Some(PathBuf::from("/x/qmd")) };
        assert!(!dep_status_satisfies(qmd, &stub));
        let healthy = DepStatus { installed: true, version: Some("qmd 2.5.3".into()), path: Some(PathBuf::from("/x/qmd")) };
        assert!(dep_status_satisfies(qmd, &healthy));
        let gh = dependency_defs().iter().find(|d| d.id == "gh").unwrap();
        let opt_no_version = DepStatus { installed: true, version: None, path: Some(PathBuf::from("/x/gh")) };
        assert!(dep_status_satisfies(gh, &opt_no_version));
    }

    #[test]
    fn pinned_qmd_with_abi_mismatch_is_scheduled_for_rebuild() {
        use hq_desktop_core::qmd_abi::{qmd_needs_rebuild, QmdAddonProbe};
        assert!(qmd_needs_rebuild(true, QmdAddonProbe::AbiMismatch));
        assert!(qmd_needs_rebuild(true, QmdAddonProbe::MissingAddon));
        assert!(!qmd_needs_rebuild(true, QmdAddonProbe::Loads));
    }
}

#[cfg(all(test, not(windows)))]
mod npm_bin_cleanup_tests {
    use super::*;

    #[test]
    fn removes_plain_file_and_dangling_link_keeps_valid_link() {
        let tmp = tempfile::tempdir().unwrap();
        let prefix = tmp.path();
        let bin = prefix.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        assert!(!clear_unusable_npm_bin(prefix, "qmd"));
        std::fs::write(bin.join("qmd"), "#!/bin/sh\nexit 97\n").unwrap();
        assert!(clear_unusable_npm_bin(prefix, "qmd"));
        assert!(!bin.join("qmd").exists());
        std::os::unix::fs::symlink(prefix.join("lib/node_modules/missing/bin/qmd.js"), bin.join("qmd")).unwrap();
        assert!(clear_unusable_npm_bin(prefix, "qmd"));
        assert!(std::fs::symlink_metadata(bin.join("qmd")).is_err());
        let target = prefix.join("lib/node_modules/@tobilu/qmd/bin/qmd.js");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, bin.join("qmd")).unwrap();
        assert!(!clear_unusable_npm_bin(prefix, "qmd"));
        assert!(bin.join("qmd").exists());
    }
}

#[cfg(all(test, not(windows)))]
mod bundled_hq_cli_tests {
    use super::*;

    #[test]
    fn bundled_cli_requires_its_version_not_merely_a_managed_install() {
        assert!(bundled_cli_version_matches(Some("5.199.0-local.0\n"), Some("5.199.0-local.0")));
        assert!(!bundled_cli_version_matches(Some("5.199.0-local.0"), Some("5.109.16")));
        assert!(!bundled_cli_version_matches(Some("5.199.0-local.0"), None));
        assert!(!bundled_cli_version_matches(None, Some("5.199.0-local.0")));
    }

    #[test]
    fn exact_bundled_resource_is_selected() {
        let temp = tempfile::tempdir().unwrap();
        let resource_dir = temp.path().join("Resources");
        let package = resource_dir.join(BUNDLED_HQ_CLI_RESOURCE_PATH);
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(&package, b"package bytes").unwrap();

        assert_eq!(
            hq_cli_install_spec(Some(&resource_dir)),
            package.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            hq_cli_install_spec_with_mode(Some(&resource_dir)).1,
            "resource"
        );
    }

    #[test]
    fn absent_bundle_preserves_the_registry_install() {
        let temp = tempfile::tempdir().unwrap();
        let resource_dir = temp.path().join("Resources");
        std::fs::create_dir_all(&resource_dir).unwrap();

        assert_eq!(
            hq_cli_install_spec(Some(&resource_dir)),
            HQ_CLI_REGISTRY_SPEC
        );
        assert_eq!(hq_cli_install_spec(None), HQ_CLI_REGISTRY_SPEC);
        assert_eq!(
            hq_cli_install_spec_with_mode(Some(&resource_dir)).1,
            "registry_fallback"
        );
        assert_eq!(hq_cli_install_spec_with_mode(None).1, "registry_fallback");
    }

    #[test]
    fn neighboring_or_symlinked_user_file_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let resource_dir = temp.path().join("HQ.app/Contents/Resources");
        let package_dir = resource_dir.join("hq-cli");
        std::fs::create_dir_all(&package_dir).unwrap();

        let neighboring_package = temp.path().join("hq-cli.tgz");
        std::fs::write(&neighboring_package, b"untrusted package bytes").unwrap();
        assert_eq!(
            hq_cli_install_spec(Some(&resource_dir)),
            HQ_CLI_REGISTRY_SPEC,
            "a package beside the app must not be discovered"
        );

        std::os::unix::fs::symlink(&neighboring_package, package_dir.join("hq-cli.tgz")).unwrap();
        assert_eq!(
            hq_cli_install_spec(Some(&resource_dir)),
            HQ_CLI_REGISTRY_SPEC,
            "the fixed resource slot must not escape via symlink"
        );
    }
}

#[cfg(test)]
mod foreign_copy_rejection_tests {
    use super::*;

    #[test]
    fn qmd_pin_match() {
        assert!(qmd_version_matches_pin(Some(&format!("qmd {MANAGED_QMD_VERSION} (facd35e)"))));
        assert!(!qmd_version_matches_pin(Some("qmd 1.0.7-ghost")));
        assert!(!qmd_version_matches_pin(Some("qmd 2.8.3 (abc)")));
        assert!(!qmd_version_matches_pin(None));
    }

    #[test]
    fn foreign_qmd_and_hq_are_not_satisfied() {
        let qmd = dependency_defs().iter().find(|d| d.id == "qmd").unwrap();
        let ghost = DepStatus { installed: true, version: Some("qmd 1.0.7-ghost".into()), path: Some(PathBuf::from("/Users/x/Library/pnpm/qmd")) };
        assert!(!dep_status_satisfies(qmd, &ghost));
        let hq = dependency_defs().iter().find(|d| d.id == "hq-cli").unwrap();
        let foreign = DepStatus { installed: true, version: Some("5.0.0".into()), path: Some(PathBuf::from("/Users/x/Library/pnpm/hq")) };
        assert!(!dep_status_satisfies(hq, &foreign));
        #[cfg(not(windows))]
        {
            let managed = dirs::home_dir().unwrap().join("Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq");
            let ok = DepStatus { installed: true, version: Some("5.107.1".into()), path: Some(managed) };
            assert!(dep_status_satisfies(hq, &ok));
        }
    }
}

#[cfg(test)]
mod registry_failure_classifier_tests {
    use super::*;
    #[test]
    fn classifies_registry_vs_local_failures() {
        assert!(looks_like_registry_failure("npm error code ENOTFOUND\nnpm error network request to https://npm.corp.invalid/@tobilu%2fqmd failed"));
        assert!(looks_like_registry_failure("npm error code E404 Not Found - GET https://npm.corp/..."));
        assert!(looks_like_registry_failure("npm error network In most cases you are behind a proxy"));
        assert!(!looks_like_registry_failure("npm error code EACCES permission denied, mkdir '/usr/local/lib/node_modules'"));
        assert!(!looks_like_registry_failure("npm error code ENOSPC no space left on device"));
    }
}

#[cfg(test)]
mod npm_setup_recovery_tests {
    use super::*;
    use std::cell::RefCell;
    use std::ffi::OsStr;
    use std::rc::Rc;

    struct FakeNpmRun {
        result: Result<String, String>,
        attempts: Vec<Vec<String>>,
        cleanup_scopes: Vec<(PathBuf, String)>,
        preflight: Vec<String>,
        cleared_failures: usize,
    }

    async fn run_fake_npm(
        prefix: &str,
        windows_layout: bool,
        spec: &str,
        outcomes: Vec<Result<String, String>>,
        public_registry_args: Option<Vec<String>>,
    ) -> FakeNpmRun {
        run_fake_npm_with_cancellation_check(
            prefix,
            windows_layout,
            spec,
            outcomes,
            public_registry_args,
            || Ok(()),
        )
        .await
    }

    async fn run_fake_npm_with_cancellation_check<CheckCancelled>(
        prefix: &str,
        windows_layout: bool,
        spec: &str,
        outcomes: Vec<Result<String, String>>,
        public_registry_args: Option<Vec<String>>,
        mut check_cancelled: CheckCancelled,
    ) -> FakeNpmRun
    where
        CheckCancelled: FnMut() -> Result<(), String>,
    {
        let attempts = Rc::new(RefCell::new(Vec::new()));
        let cleanup_scopes = Rc::new(RefCell::new(Vec::new()));
        let preflight = Rc::new(RefCell::new(Vec::new()));
        let cleared_failures = Rc::new(RefCell::new(0));

        let attempts_for_run = Rc::clone(&attempts);
        let mut outcomes = outcomes;
        let mut run = move |args: Vec<String>| {
            attempts_for_run.borrow_mut().push(args);
            let outcome = outcomes
                .drain(..1)
                .next()
                .expect("fake npm received more attempts than expected");
            async move { outcome }
        };

        let cleanup_for_run = Rc::clone(&cleanup_scopes);
        let mut cleanup = move |scope: &Path, package_name: &str| {
            cleanup_for_run
                .borrow_mut()
                .push((scope.to_path_buf(), package_name.to_string()));
        };

        let preflight_for_run = Rc::clone(&preflight);
        let mut emit_preflight = move |line: String| {
            preflight_for_run.borrow_mut().push(line);
        };

        let cleared_for_run = Rc::clone(&cleared_failures);
        let mut clear_failure = move || {
            *cleared_for_run.borrow_mut() += 1;
        };

        let base_args = vec![
            "install".to_string(),
            "-g".to_string(),
            "--prefix".to_string(),
            prefix.to_string(),
            spec.to_string(),
        ];
        let package_name = npm_package_name_from_spec(spec).expect("registry package fixture");
        let result = run_setup_npm_install_with_retries(
            &mut run,
            &mut cleanup,
            &mut emit_preflight,
            &mut clear_failure,
            &mut check_cancelled,
            prefix,
            windows_layout,
            spec,
            &package_name,
            "test",
            base_args,
            public_registry_args,
        )
        .await;

        drop(run);
        drop(cleanup);
        drop(emit_preflight);
        drop(clear_failure);

        FakeNpmRun {
            result,
            attempts: Rc::try_unwrap(attempts).unwrap().into_inner(),
            cleanup_scopes: Rc::try_unwrap(cleanup_scopes).unwrap().into_inner(),
            preflight: Rc::try_unwrap(preflight).unwrap().into_inner(),
            cleared_failures: Rc::try_unwrap(cleared_failures).unwrap().into_inner(),
        }
    }

    #[test]
    fn setup_npm_command_carries_the_app_owned_cache_for_both_layouts() {
        for (layout, prefix, cache_path) in [
            ("macOS", "/tmp/setup-prefix", "/tmp/app-cache/npm"),
            (
                "Windows",
                "C:/Users/test/AppData/Local/IndigoHQ/npm-prefix",
                "C:/Users/test/AppData/Local/IndigoHQ/cache/npm",
            ),
        ] {
            let args = ["install", "-g", "--prefix", prefix, "@tobilu/qmd"];
            let command =
                setup_npm_command("npm", "/test/child-path", Path::new(cache_path), &args);
            let cache = command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("NPM_CONFIG_CACHE"))
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().into_owned());
            assert_eq!(
                cache.as_deref(),
                Some(cache_path),
                "{layout} setup must pass its resolved app-owned npm cache"
            );
            assert_eq!(
                command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
                args,
                "{layout} setup must preserve npm argv"
            );
        }
    }

    #[test]
    fn setup_npm_install_wires_the_resolved_cache_into_the_runner() {
        let source = include_str!("install_deps.rs");
        let call = "run_streaming_with_npm_cache(app, npm, &arg_refs, Some(npm_cache)).await";

        assert_eq!(
            source.matches(call).count(),
            2,
            "macOS and Windows setup installs must pass the resolved app-owned cache to the runner"
        );
    }

    #[tokio::test]
    async fn enotempty_cleans_once_and_retries_once_on_unix_layout() {
        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@indigoai-us/hq-cli",
            vec![
                Err("npm error code ENOTEMPTY".into()),
                Ok("recovered".into()),
            ],
            None,
        )
        .await;

        assert_eq!(run.result, Ok("recovered".into()));
        assert_eq!(run.attempts.len(), 2);
        assert_eq!(run.cleanup_scopes.len(), 1);
        assert_eq!(
            run.cleanup_scopes[0],
            (
                PathBuf::from("/tmp/setup-prefix/lib/node_modules/@indigoai-us"),
                "@indigoai-us/hq-cli".to_string(),
            )
        );
        assert_eq!(run.cleared_failures, 1);
        assert_eq!(run.preflight.len(), 1);
        assert!(run.preflight[0].contains("ENOTEMPTY"));
    }

    #[tokio::test(start_paused = true)]
    async fn etarget_retries_once_with_prefer_online() {
        let started = tokio::time::Instant::now();
        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@tobilu/qmd@2.5.3",
            vec![
                Err(
                    "npm error code ETARGET\nnpm error notarget No matching version found for @tobilu/qmd@2.5.3"
                        .into(),
                ),
                Ok("recovered".into()),
            ],
            None,
        )
        .await;

        assert_eq!(run.result, Ok("recovered".into()));
        assert_eq!(run.attempts.len(), 2);
        assert!(!run.attempts[0].contains(&"--prefer-online".to_string()));
        assert!(run.attempts[1].contains(&"--prefer-online".to_string()));
        assert!(run.cleanup_scopes.is_empty());
        assert_eq!(run.cleared_failures, 1);
        assert_eq!(run.preflight.len(), 1);
        assert!(run.preflight[0].contains("retrying in 30s"));
        assert_eq!(
            tokio::time::Instant::now() - started,
            std::time::Duration::from_secs(30)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn setup_npm_package_resolution_404_twice_then_success() {
        let started = tokio::time::Instant::now();
        let missing_tarball = "npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/-/hq-cli-5.290.0.tgz";
        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@indigoai-us/hq-cli",
            vec![
                Err(missing_tarball.into()),
                Err(missing_tarball.into()),
                Ok("installed after propagation".into()),
            ],
            None,
        )
        .await;

        assert_eq!(run.result, Ok("installed after propagation".into()));
        assert_eq!(
            run.attempts.len(),
            3,
            "two 404s must be retried before success"
        );
        assert_eq!(run.attempts[0], run.attempts[1]);
        assert_eq!(run.attempts[1], run.attempts[2]);
        assert_eq!(
            run.preflight.len(),
            2,
            "each retry keeps dependency-stage progress visible"
        );
        assert!(run
            .preflight
            .iter()
            .all(|line| line.contains("continuing dependency setup")));
        assert_eq!(
            tokio::time::Instant::now() - started,
            std::time::Duration::from_secs(75),
            "the two retries must respect the first two backoff intervals"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn setup_npm_package_resolution_404_survives_stderr_tail_formatting() {
        let lines = vec![
            "npm error code E404".to_string(),
            "npm stack preamble".to_string(),
            "npm stack detail".to_string(),
            "npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/-/hq-cli-5.290.0.tgz".to_string(),
            "npm error registry response detail".to_string(),
            "npm error troubleshooting detail".to_string(),
            "npm error end of report".to_string(),
        ];
        let formatted = format_install_error(1, &lines);
        assert!(!formatted.contains("code E404"), "the formatter must discard the early machine-code line");
        assert!(formatted.contains("npm error 404 Not Found"));

        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@indigoai-us/hq-cli",
            vec![
                Err(formatted.clone()),
                Err(formatted.clone()),
                Ok("installed after propagation".into()),
            ],
            None,
        )
        .await;

        assert_eq!(run.result, Ok("installed after propagation".into()));
        assert_eq!(
            run.attempts.len(),
            3,
            "formatted package 404 output must still enter the retry ladder"
        );
        assert_eq!(run.preflight.len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn setup_npm_package_resolution_cancellation_during_backoff_stops_retry() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let cancel_after_five_seconds = std::sync::Arc::clone(&cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            cancel_after_five_seconds.store(true, Ordering::SeqCst);
        });

        let check_cancelled = {
            let cancelled = std::sync::Arc::clone(&cancelled);
            move || {
                if cancelled.load(Ordering::SeqCst) {
                    Err(InstallCancellation::UserCancelled.user_message())
                } else {
                    Ok(())
                }
            }
        };
        let started = tokio::time::Instant::now();
        let missing = "npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/-/hq-cli-5.290.0.tgz";
        let run = run_fake_npm_with_cancellation_check(
            "/tmp/setup-prefix",
            false,
            "@indigoai-us/hq-cli",
            vec![Err(missing.into()), Ok("must not run after cancellation".into())],
            None,
            check_cancelled,
        )
        .await;

        assert_eq!(run.result, Err(InstallCancellation::UserCancelled.user_message()));
        assert_eq!(
            run.attempts.len(),
            1,
            "cancellation during backoff must prevent another npm process"
        );
        assert_eq!(
            run.cleared_failures, 0,
            "cancellation must not clear or replace the failure before returning"
        );
        assert!(tokio::time::Instant::now() - started < std::time::Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn transitive_package_404_falls_back_to_public_registry_without_backoff() {
        let prefix = "/tmp/setup-prefix";
        let spec = "@indigoai-us/hq-cli";
        let transitive_missing = "npm error 404 Not Found - GET https://registry.npmjs.org/@another-team%2fother-cli/-/other-cli-1.0.0.tgz";
        let public_registry_args = npm_public_registry_args(prefix, spec, &[]);
        let run = run_fake_npm(
            prefix,
            false,
            spec,
            vec![Err(transitive_missing.into()), Ok("installed via public registry".into())],
            Some(public_registry_args.clone()),
        )
        .await;

        assert_eq!(
            run.result,
            Ok("installed via public registry".into()),
            "an unrelated package lookup failure must retain the existing public-registry fallback"
        );
        assert_eq!(run.attempts.len(), 2, "skip backoff and try public registry once");
        assert_eq!(run.attempts[1], public_registry_args);
        assert_eq!(run.preflight.len(), 1);
        assert_eq!(run.cleared_failures, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn package_lookup_retry_non_lookup_failure_falls_back_to_public_registry() {
        let prefix = "/tmp/setup-prefix";
        let spec = "@indigoai-us/hq-cli";
        let requested_package_missing = "npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/-/hq-cli-5.290.0.tgz";
        let retry_failure = "npm error code EACCES\nnpm error syscall mkdir";
        let public_registry_args = npm_public_registry_args(prefix, spec, &[]);
        let run = run_fake_npm(
            prefix,
            false,
            spec,
            vec![
                Err(requested_package_missing.into()),
                Err(retry_failure.into()),
                Ok("installed via public registry".into()),
            ],
            Some(public_registry_args.clone()),
        )
        .await;

        assert_eq!(run.result, Ok("installed via public registry".into()));
        assert_eq!(run.attempts.len(), 3, "a terminal retry error must go to the public registry once");
        assert_eq!(run.attempts[2], public_registry_args);
        assert_eq!(run.preflight.len(), 2);
        assert_eq!(run.cleared_failures, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn setup_npm_package_resolution_unrelated_etarget_fails_fast() {
        let unrelated = "npm error code ETARGET\nnpm error notarget No matching version found for @another-team/other-cli@latest";
        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@indigoai-us/hq-cli",
            vec![Err(unrelated.into()), Ok("must not retry".into())],
            None,
        )
        .await;

        assert_eq!(run.result, Err(unrelated.into()));
        assert_eq!(
            run.attempts.len(),
            1,
            "an ETARGET for a different package is not transient evidence for this install"
        );
        assert_eq!(run.cleared_failures, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn setup_npm_package_resolution_404_exhaustion_keeps_exit_category() {
        let prefix = "/tmp/setup-prefix";
        let spec = "@indigoai-us/hq-cli";
        let started = tokio::time::Instant::now();
        let missing_tarball = "npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/-/hq-cli-5.290.0.tgz";
        let public_registry_args = npm_public_registry_args(prefix, spec, &[]);
        let run = run_fake_npm(
            prefix,
            false,
            spec,
            vec![Err(missing_tarball.into()); 5],
            Some(public_registry_args),
        )
        .await;

        let error = run
            .result
            .expect_err("all package-resolution attempts must fail");
        assert!(error.contains("npm error 404 Not Found"));
        assert_eq!(
            run.attempts.len(),
            5,
            "three retries are followed by the existing public-registry fallback"
        );
        assert_eq!(
            run.attempts[4],
            npm_public_registry_args(prefix, spec, &[]),
            "the final attempt preserves the existing public-registry fallback"
        );
        assert_eq!(
            tokio::time::Instant::now() - started,
            std::time::Duration::from_secs(150),
            "only the three bounded retries add backoff"
        );
        let dependency = dependency_defs()
            .into_iter()
            .find(|dependency| dependency.id == "hq-cli")
            .expect("hq-cli dependency is registered");
        let result = DepInstallResult {
            id: dependency.id,
            label: dependency.label,
            optional: dependency.optional,
            status: DepInstallStatus::Failed,
            error: Some(error.clone()),
        };
        let diagnostic = SetupCommandDiagnostic {
            command: "npm install -g @indigoai-us/hq-cli".into(),
            exit_code: Some(1),
            stdout: String::new(),
            stderr: error.clone(),
            error,
        };
        assert_eq!(
            setup_error_category(&result, Some(&diagnostic)).as_str(),
            "exit-nonzero",
            "exhausted 404 retries retain the existing setup failure category"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn etarget_falls_through_to_public_registry_after_prefer_online_fails() {
        let prefix = "/tmp/setup-prefix";
        let spec = "@tobilu/qmd@2.5.3";
        let public_registry_args = vec![
            "install".to_string(),
            "-g".to_string(),
            "--prefix".to_string(),
            prefix.to_string(),
            "--registry=https://registry.npmjs.org/".to_string(),
            spec.to_string(),
        ];
        let run = run_fake_npm(
            prefix,
            false,
            spec,
            vec![
                Err("npm error code ETARGET first for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET second for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET third for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET fourth for @tobilu/qmd@2.5.3".into()),
                Ok("public registry recovered".into()),
            ],
            Some(public_registry_args.clone()),
        )
        .await;

        assert_eq!(run.result, Ok("public registry recovered".into()));
        assert_eq!(
            run.attempts,
            vec![
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "--prefix".to_string(),
                    prefix.to_string(),
                    spec.to_string(),
                ],
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "--prefix".to_string(),
                    prefix.to_string(),
                    "--prefer-online".to_string(),
                    spec.to_string(),
                ],
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "--prefix".to_string(),
                    prefix.to_string(),
                    spec.to_string(),
                ],
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "--prefix".to_string(),
                    prefix.to_string(),
                    spec.to_string(),
                ],
                public_registry_args,
            ]
        );
        assert!(run.cleanup_scopes.is_empty());
        assert_eq!(run.cleared_failures, 4);
        assert_eq!(run.preflight.len(), 4);
        assert!(run.preflight[0].contains("retrying in 30s"));
        assert!(run.preflight[3].contains("public registry"));
    }

    #[tokio::test(start_paused = true)]
    async fn etarget_public_registry_failure_preserves_all_attempt_errors() {
        let prefix = "/tmp/setup-prefix";
        let spec = "@tobilu/qmd@2.5.3";
        let public_registry_args = vec![
            "install".to_string(),
            "-g".to_string(),
            "--prefix".to_string(),
            prefix.to_string(),
            "--registry=https://registry.npmjs.org/".to_string(),
            spec.to_string(),
        ];
        let run = run_fake_npm(
            prefix,
            false,
            spec,
            vec![
                Err("npm error code ETARGET first for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET second for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET third for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET fourth for @tobilu/qmd@2.5.3".into()),
                Err("npm error code ETARGET public registry for @tobilu/qmd@2.5.3".into()),
            ],
            Some(public_registry_args.clone()),
        )
        .await;

        let error = run.result.expect_err("all three attempts should fail");
        assert!(error.contains("ETARGET first"));
        assert!(error.contains("ETARGET second"));
        assert!(error.contains("ETARGET third"));
        assert!(error.contains("ETARGET fourth"));
        assert!(error.contains("ETARGET public registry"));
        assert_eq!(run.attempts.len(), 5);
        assert_eq!(run.attempts[4], public_registry_args);
        assert!(run.attempts[1].contains(&"--prefer-online".to_string()));
        assert!(run.cleanup_scopes.is_empty());
        assert_eq!(run.cleared_failures, 4);
        assert_eq!(run.preflight.len(), 4);
        assert!(run.preflight[0].contains("retrying in 30s"));
        assert!(run.preflight[3].contains("public registry"));
    }

    #[tokio::test]
    async fn unrelated_failure_does_not_arm_setup_recoveries() {
        let run = run_fake_npm(
            "/tmp/setup-prefix",
            false,
            "@private/package",
            vec![Err("npm error code E404 private package".into())],
            None,
        )
        .await;

        assert_eq!(run.result, Err("npm error code E404 private package".into()));
        assert_eq!(run.attempts.len(), 1);
        assert!(run.cleanup_scopes.is_empty());
        assert!(run.preflight.is_empty());
        assert_eq!(run.cleared_failures, 0);
    }

    #[tokio::test]
    async fn windows_layout_gets_the_same_enotempty_recovery() {
        let run = run_fake_npm(
            "C:/Users/test/AppData/Local/IndigoHQ/npm-prefix",
            true,
            "@indigoai-us/hq-cli",
            vec![
                Err("npm error code ENOTEMPTY".into()),
                Ok("recovered".into()),
            ],
            None,
        )
        .await;

        assert_eq!(run.result, Ok("recovered".into()));
        assert_eq!(run.attempts.len(), 2);
        assert_eq!(run.cleanup_scopes.len(), 1);
        assert_eq!(
            run.cleanup_scopes[0].0,
            PathBuf::from(
                "C:/Users/test/AppData/Local/IndigoHQ/npm-prefix/node_modules/@indigoai-us"
            )
        );
        assert_eq!(run.cleanup_scopes[0].1, "@indigoai-us/hq-cli");
        assert_eq!(run.cleared_failures, 1);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HQ-DESKTOP-6J: a cli-update lock skip must not be reported as a setup failure
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod cli_install_lock_skip_tests {
    use super::*;
    use crate::commands::hq_cli_update::{
        cli_install_lock_skip_message, CLI_INSTALL_LOCK_SKIP_PREFIX,
    };
    use hq_desktop_core::cli_update_lock::CliUpdateLockInfo;

    fn scope() -> OnboardingFailureScope {
        OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 1,
            flow: "resume".to_string(),
            frontend_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        }
    }

    fn hq_cli_result(error: &str) -> DepInstallResult {
        let dep = dependency_defs().iter().find(|d| d.id == "hq-cli").unwrap();
        DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: DepInstallStatus::Failed,
            error: Some(error.to_string()),
        }
    }

    /// The exact production skip message, reconstructed byte-for-byte from the
    /// real holder-line formatter and the real message builder — this is the
    /// `setup_error` extra that production event 2e10b3a7… carried.
    fn production_skip_message() -> String {
        let holder = CliUpdateLockInfo {
            pid: 39446,
            started_at: "2026-09-13T00:43:32.742Z".to_string(),
            tool: "hq-desktop-app-cli-update".to_string(),
            version: "0.10.251".to_string(),
        }
        .holder_line();
        cli_install_lock_skip_message(&holder)
    }

    /// Drive `install_deps`'s exact reporting loop against a results map and
    /// return the captured Sentry events.
    fn capture_reporting_loop(
        results: &HashMap<&'static str, DepInstallResult>,
        diagnostics: &HashMap<&'static str, SetupCommandDiagnostic>,
    ) -> Vec<sentry::protocol::Event<'static>> {
        let deps = dependency_defs();
        let scope = scope();
        sentry::test::with_captured_events(|| {
            for dependency in reportable_setup_failure_ids(deps, results) {
                let result = results.get(dependency).unwrap();
                let diagnostic = diagnostics
                    .get(dependency)
                    .cloned()
                    .unwrap_or_else(|| fallback_setup_command_diagnostic(result));
                let category = setup_error_category(result, Some(&diagnostic));
                let blocked = blocked_dependents_for(deps, results, dependency)
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                send_setup_dependency_failure(&scope, dependency, category, diagnostic, &blocked);
            }
        })
    }

    #[test]
    fn preflight_disk_space_refusal_emits_disk_full_category_tag() {
        let error = hq_desktop_core::installer_disk_space::ensure_setup_disk_space_at_with(
            Path::new("/tmp/hq-setup-prefix-not-created"),
            |_| Ok(0),
        )
        .expect_err("preflight must refuse a disk below the free-space minimum");
        let mut results: HashMap<&'static str, DepInstallResult> = HashMap::new();
        results.insert("hq-cli", hq_cli_result(&error));

        let events = capture_reporting_loop(&results, &HashMap::new());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags["setup_error_category"], "disk-full");
        assert!(matches!(
            events[0].extra.get("setup_error"),
            Some(sentry::protocol::Value::String(reason)) if reason.contains("1 GiB")
        ));
    }

    #[test]
    fn npm_enospc_with_exit_code_emits_disk_full_category_tag() {
        let stderr = "npm error code ENOSPC: no space left on device (os error 28)";
        let mut results: HashMap<&'static str, DepInstallResult> = HashMap::new();
        results.insert(
            "hq-cli",
            hq_cli_result("Process exited with code 1: npm error code ENOSPC"),
        );
        let mut diagnostics: HashMap<&'static str, SetupCommandDiagnostic> = HashMap::new();
        diagnostics.insert(
            "hq-cli",
            SetupCommandDiagnostic {
                command: "npm install -g @indigoai-us/hq-cli".to_string(),
                exit_code: Some(1),
                stdout: String::new(),
                stderr: stderr.to_string(),
                error: "Process exited with code 1".to_string(),
            },
        );

        let events = capture_reporting_loop(&results, &diagnostics);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags["setup_error_category"], "disk-full");
        assert!(matches!(
            events[0].extra.get("setup_stderr_tail"),
            Some(sentry::protocol::Value::String(reason)) if reason.contains("ENOSPC")
        ));
    }

    #[test]
    fn a_concurrent_cli_install_skip_is_not_a_reportable_setup_failure() {
        // Reproduces HQ-DESKTOP-6J: on the base, hq-cli is a reportable root and
        // the reporting loop fires one Level::Error event; with the fix it is
        // neither a root nor an event.
        let deps = dependency_defs();
        let mut results: HashMap<&'static str, DepInstallResult> = HashMap::new();
        results.insert("hq-cli", hq_cli_result(&production_skip_message()));

        assert!(
            reportable_setup_failure_ids(deps, &results).is_empty(),
            "a lock-skip must not be a reportable setup-failure root"
        );
        assert_eq!(
            capture_reporting_loop(&results, &HashMap::new()).len(),
            0,
            "a lock-skip must capture zero Sentry events"
        );
    }

    #[test]
    fn a_genuine_hq_cli_install_failure_is_still_reported() {
        // Negative control (filter-gates-need-a-negative-control): an ordinary
        // non-zero-exit npm failure for hq-cli stays a reportable root and still
        // fires exactly one error event with its existing fingerprint.
        let deps = dependency_defs();
        let mut results: HashMap<&'static str, DepInstallResult> = HashMap::new();
        results.insert(
            "hq-cli",
            hq_cli_result("Process exited with code 243: npm ERR! EACCES: permission denied"),
        );
        let mut diagnostics: HashMap<&'static str, SetupCommandDiagnostic> = HashMap::new();
        diagnostics.insert(
            "hq-cli",
            SetupCommandDiagnostic {
                command: "npm install -g @indigoai-us/hq-cli".to_string(),
                exit_code: Some(243),
                stdout: String::new(),
                stderr: "npm ERR! EACCES: permission denied".to_string(),
                error: "Process exited with code 243".to_string(),
            },
        );

        assert_eq!(reportable_setup_failure_ids(deps, &results), vec!["hq-cli"]);
        let events = capture_reporting_loop(&results, &diagnostics);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].fingerprint,
            vec!["desktop-setup-dependency-install-failed"]
        );
        assert_eq!(events[0].tags["setup_error_category"], "exit-nonzero");
    }

    #[test]
    fn the_skip_message_the_lock_path_produces_satisfies_the_suppression_predicate() {
        // Initializer-vs-consumer parity: the exact message the lock path emits is
        // accepted by the predicate, so producer and consumer cannot drift.
        let message = production_skip_message();
        assert!(message.starts_with(CLI_INSTALL_LOCK_SKIP_PREFIX));
        assert!(
            is_concurrent_install_skip_result(&hq_cli_result(&message)),
            "producer message must satisfy the consumer predicate: {message}"
        );
    }

    #[test]
    fn a_lock_skip_is_categorised_concurrent_install() {
        // No exit code, yet it must classify as concurrent-install (ahead of the
        // exit_code branch), never Unknown.
        let result = hq_cli_result(&production_skip_message());
        assert_eq!(
            setup_error_category(&result, None),
            OnboardingErrorCategory::ConcurrentInstall
        );
        assert_eq!(
            OnboardingErrorCategory::ConcurrentInstall.as_str(),
            "concurrent-install"
        );
    }
}

// Real-process artifact E2E for the bounded cli-install lock wait. `#[ignore]`d
// out of the parallel `cargo test` pool and run in a dedicated, timeout-bounded
// rust-macos step with `--include-ignored --test-threads=1`. A genuine second OS
// process holds the real cli-update lock under a temp `HQ_LOCK_DIR`; each case
// loops >= 20 sequential iterations so one green run is repeated-run evidence.
#[cfg(all(test, unix))]
mod cli_install_lock_e2e_tests {
    use super::*;
    use crate::commands::hq_cli_update::cli_install_lock_skip_message;
    use hq_desktop_core::cli_update_lock::{
        acquire_cli_update_lock_waiting_in, CliUpdateLockAttempt, CliUpdateLockInfo,
        CLI_UPDATE_LOCK_FILE,
    };
    use std::process::Command;

    // Opt-in real backoff window (mirrors HQ_SWAP_TEST_BACKOFF_MS). The rust-macos
    // step sets HQ_CLI_LOCK_TEST_BACKOFF_MS=200; the default keeps a local run brisk.
    fn wait_backoff() -> Duration {
        Duration::from_millis(
            std::env::var("HQ_CLI_LOCK_TEST_BACKOFF_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(200),
        )
    }

    fn seed_fresh_lock(dir: &Path, pid: u32) {
        let info = CliUpdateLockInfo {
            pid,
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            tool: "hq-desktop-app-cli-update".to_string(),
            version: "0.10.251".to_string(),
        };
        std::fs::write(
            dir.join(CLI_UPDATE_LOCK_FILE),
            serde_json::to_string(&info).unwrap(),
        )
        .unwrap();
    }

    fn scope() -> OnboardingFailureScope {
        OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 1,
            flow: "resume".to_string(),
            frontend_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        }
    }

    #[test]
    #[ignore = "real-process artifact E2E; run in the rust-macos cli-install-lock step"]
    fn a_holder_that_exits_mid_budget_lets_the_cli_install_proceed() {
        let backoff = wait_backoff();
        for iteration in 0..20 {
            let dir = tempfile::tempdir().unwrap();
            // A REAL second OS process is the lock holder.
            let mut holder = Command::new("sleep").arg("30").spawn().expect("spawn holder");
            seed_fresh_lock(dir.path(), holder.id());

            // The holder exits mid-budget; reaping it makes its pid genuinely dead,
            // so the lock is reclaimable exactly as production's dead-holder takeover
            // is — nothing waits forever on a crashed holder.
            let releaser = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let _ = holder.kill();
                let _ = holder.wait();
            });

            let attempt = acquire_cli_update_lock_waiting_in(
                dir.path(),
                "hq-desktop-app-install-deps",
                "0.10.255",
                Duration::from_secs(20),
                backoff,
                |_| {},
            )
            .expect("acquire");
            releaser.join().unwrap();

            assert!(
                matches!(attempt, CliUpdateLockAttempt::Acquired(_)),
                "iteration {iteration}: a holder that exits mid-budget must let the install proceed"
            );
        }
    }

    #[test]
    #[ignore = "real-process artifact E2E; run in the rust-macos cli-install-lock step"]
    fn a_holder_that_never_exits_skips_within_budget_with_zero_error_events() {
        let backoff = wait_backoff();
        let scope = scope();
        for iteration in 0..20 {
            let dir = tempfile::tempdir().unwrap();
            let mut holder = Command::new("sleep").arg("30").spawn().expect("spawn holder");
            seed_fresh_lock(dir.path(), holder.id());

            // A real, live, foreign holder for the whole (short) budget => a bounded
            // skip, never an unbounded wait.
            let attempt = acquire_cli_update_lock_waiting_in(
                dir.path(),
                "hq-desktop-app-install-deps",
                "0.10.255",
                backoff * 3,
                backoff,
                |_| {},
            )
            .expect("acquire");
            let holder_line = match attempt {
                CliUpdateLockAttempt::Held { holder } => holder,
                other => {
                    let _ = holder.kill();
                    let _ = holder.wait();
                    panic!("iteration {iteration}: expected a bounded skip, got {other:?}");
                }
            };

            // The bounded skip must produce ZERO error-level Sentry events through
            // the real reporting path.
            let deps = dependency_defs();
            let mut results: HashMap<&'static str, DepInstallResult> = HashMap::new();
            let hq_cli = deps.iter().find(|d| d.id == "hq-cli").unwrap();
            results.insert(
                "hq-cli",
                DepInstallResult {
                    id: hq_cli.id,
                    label: hq_cli.label,
                    optional: hq_cli.optional,
                    status: DepInstallStatus::Failed,
                    error: Some(cli_install_lock_skip_message(&holder_line)),
                },
            );
            assert!(reportable_setup_failure_ids(deps, &results).is_empty());
            let events = sentry::test::with_captured_events(|| {
                for dependency in reportable_setup_failure_ids(deps, &results) {
                    let result = results.get(dependency).unwrap();
                    let diagnostic = fallback_setup_command_diagnostic(result);
                    let category = setup_error_category(result, Some(&diagnostic));
                    send_setup_dependency_failure(&scope, dependency, category, diagnostic, &[]);
                }
            });
            assert_eq!(
                events.len(),
                0,
                "iteration {iteration}: a lock skip must page nothing"
            );

            let _ = holder.kill();
            let _ = holder.wait();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HQ-DESKTOP-6H: user cancellation and failed cancellation cleanup are distinct
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod cancellation_reporting_tests {
    use super::*;

    fn scope() -> OnboardingFailureScope {
        OnboardingFailureScope {
            setup_run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            attempt_count: 1,
            flow: "first_install".to_string(),
            frontend_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        }
    }

    fn failed_result(dependency: &'static str, error: &str) -> DepInstallResult {
        let dep = dependency_defs()
            .iter()
            .find(|dep| dep.id == dependency)
            .expect("fixture dependency is registered");
        DepInstallResult {
            id: dep.id,
            label: dep.label,
            optional: dep.optional,
            status: DepInstallStatus::Failed,
            error: Some(error.to_string()),
        }
    }

    fn cancelled_result(dependency: &'static str, cancellation: &InstallCancellation) -> DepInstallResult {
        let dep = dependency_defs()
            .iter()
            .find(|dep| dep.id == dependency)
            .expect("fixture dependency is registered");
        result_from_install(dep, Err(cancellation.user_message()), Some(cancellation))
    }

    #[cfg(unix)]
    fn sigterm_eperm_cleanup_failure() -> CancellationCleanupFailure {
        CancellationCleanupFailure::from_unix_signal(Signal::SIGTERM, nix::errno::Errno::EPERM)
    }

    #[cfg(unix)]
    struct ProcessGroupChild(std::process::Child);

    #[cfg(unix)]
    impl ProcessGroupChild {
        fn spawn(program: &str, args: &[&str]) -> Self {
            let child = Command::new(program)
                .args(args)
                .process_group(0)
                .spawn()
                .expect("process-group test child starts");
            Self(child)
        }

        fn pgid(&self) -> i32 {
            self.0.id() as i32
        }

        fn is_unreaped_zombie(&self) -> bool {
            let pid = Pid::from_raw(self.pgid());
            let deadline = Instant::now() + Duration::from_millis(800);
            loop {
                let still_exists = signal::kill(pid, None).is_ok();
                let has_live_members = unix_process_group_has_live_members(self.pgid());
                if still_exists && matches!(has_live_members, Ok(false)) {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn reap(&mut self) {
            let _ = self.0.wait().expect("process-group test child reaps");
        }
    }

    #[cfg(unix)]
    impl Drop for ProcessGroupChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(unix)]
    fn report_if_cleanup_failed(
        result: Result<(), CancellationCleanupFailure>,
    ) -> Vec<sentry::protocol::Event<'static>> {
        sentry::test::with_captured_events(|| {
            if let Err(cleanup) = result {
                send_setup_cancellation_cleanup_failure(
                    &scope(),
                    "hq-cli",
                    cleanup,
                    diagnostic("cleanup failed"),
                );
            }
        })
    }

    #[cfg(unix)]
    #[test]
    fn reaped_eperm_treats_an_unreaped_zombie_group_as_clean() {
        let child = ProcessGroupChild::spawn("sh", &["-c", "exit 0"]);
        let pgid = child.pgid();
        let is_unreaped_zombie = child.is_unreaped_zombie();

        let result = signal_process_group_with_probe(
            pgid,
            Signal::SIGTERM,
            |target, signal_kind| {
                assert_eq!(target.as_raw(), -pgid);
                assert_eq!(signal_kind, Signal::SIGTERM);
                Err(nix::errno::Errno::EPERM)
            },
            unix_process_group_has_live_members,
        );
        let events = report_if_cleanup_failed(result);

        assert!(
            is_unreaped_zombie,
            "leader must remain an unreaped zombie during the probe"
        );
        assert!(
            events.is_empty(),
            "a dead process group must not emit cleanup failure"
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_group_probe_treats_a_successfully_reaped_group_as_empty() {
        let mut child = ProcessGroupChild::spawn("sh", &["-c", "exit 0"]);
        let pgid = child.pgid();
        child.reap();

        assert!(matches!(
            unix_process_group_has_live_members(pgid),
            Ok(false)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn live_group_member_keeps_the_eperm_cleanup_report_and_tags() {
        let child = ProcessGroupChild::spawn("sleep", &["30"]);
        let pgid = child.pgid();
        let result = signal_process_group_with_probe(
            pgid,
            Signal::SIGTERM,
            |target, signal_kind| {
                assert_eq!(target.as_raw(), -pgid);
                assert_eq!(signal_kind, Signal::SIGTERM);
                Err(nix::errno::Errno::EPERM)
            },
            unix_process_group_has_live_members,
        );
        let events = report_if_cleanup_failed(result);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(
            events[0].fingerprint,
            vec!["hq-cli", "cancel-cleanup-failed", "SIGTERM", "EPERM"]
        );
        assert_eq!(
            events[0].message.as_deref(),
            Some("Desktop setup cancellation cleanup could leave an install process running")
        );
        assert_eq!(
            events[0].tags["setup_error_category"],
            "cancel-cleanup-failed"
        );
        assert_eq!(events[0].tags["setup_cancel_signal"], "SIGTERM");
        assert_eq!(events[0].tags["setup_cancel_os_error_kind"], "EPERM");
    }

    #[cfg(unix)]
    #[test]
    fn reaped_eperm_does_not_change_sigkill_escalation() {
        let result = signal_process_group_with_probe(
            42,
            Signal::SIGKILL,
            |_, _| Err(nix::errno::Errno::EPERM),
            |_| panic!("SIGKILL escalation must not run the reaped-group probe"),
        );
        let events = report_if_cleanup_failed(result);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(events[0].tags["setup_cancel_signal"], "SIGKILL");
        assert_eq!(events[0].tags["setup_cancel_os_error_kind"], "EPERM");
    }

    fn diagnostic(error: &str) -> SetupCommandDiagnostic {
        SetupCommandDiagnostic {
            command: "npm install -g @indigoai-us/hq-cli".to_string(),
            exit_code: Some(1),
            stdout: String::new(),
            stderr: error.to_string(),
            error: error.to_string(),
        }
    }

    fn capture_reporting_loop(result: &DepInstallResult) -> Vec<sentry::protocol::Event<'static>> {
        let deps = dependency_defs();
        let mut results = premark_optional_results(deps);
        results.insert(result.id, result.clone());
        sentry::test::with_captured_events(|| {
            for dependency in reportable_setup_failure_ids(deps, &results) {
                let result = results.get(dependency).expect("reportable result is present");
                let diagnostic = diagnostic(result.error.as_deref().unwrap_or_default());
                let category = setup_error_category(result, Some(&diagnostic));
                send_setup_dependency_failure(&scope(), dependency, category, diagnostic, &[]);
            }
        })
    }

    /// Collects envelopes and exposes a NON-DRAINING count, so a waiter can
    /// observe exactly the list the assertion later reads.
    ///
    /// `sentry::test::TestTransport::fetch_and_clear_events` drains, so a poll
    /// loop built on it returns the first batch that happens to have landed and
    /// throws away anything still in flight — the snapshot-one-event-short
    /// failure mode fixed for the Core update reports in PR #881. The queued
    /// cleanup-failure reports here have the same shape: they are dispatched
    /// onto a background thread by `queue_setup_cancellation_cleanup_failure`,
    /// so the test thread cannot assume they have all arrived.
    #[cfg(unix)]
    #[derive(Default)]
    struct CountingTestTransport {
        collected: Mutex<Vec<sentry::Envelope>>,
    }

    #[cfg(unix)]
    impl CountingTestTransport {
        /// Number of collected envelopes carrying an event. Never drains.
        fn event_count(&self) -> usize {
            self.collected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter_map(|envelope| envelope.event())
                .count()
        }

        fn take_events(&self) -> Vec<sentry::protocol::Event<'static>> {
            std::mem::take(&mut *self.collected.lock().unwrap_or_else(|e| e.into_inner()))
                .into_iter()
                .filter_map(|envelope| envelope.event().cloned())
                .collect()
        }
    }

    #[cfg(unix)]
    impl sentry::Transport for CountingTestTransport {
        fn send_envelope(&self, envelope: sentry::Envelope) {
            self.collected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(envelope);
        }
    }

    /// Run `f` and wait until `expected` dispatched reports have reached the
    /// TRANSPORT — not merely `before_send` — then return them.
    ///
    /// The deadline is 5s with a 5ms sleep, matching PR #881: the old 1s spin
    /// both burned a core while waiting and expired silently on a loaded CI
    /// runner, surfacing as a confusing length mismatch one assertion later.
    #[cfg(unix)]
    fn capture_queued_events(
        expected: usize,
        f: impl FnOnce(),
    ) -> Vec<sentry::protocol::Event<'static>> {
        let transport = Arc::new(CountingTestTransport::default());
        let options = sentry::ClientOptions {
            dsn: Some(
                "https://public@sentry.invalid/1"
                    .parse()
                    .expect("test DSN parses"),
            ),
            transport: Some(Arc::new(transport.clone())),
            ..Default::default()
        };
        let hub = Arc::new(sentry::Hub::new(
            Some(Arc::new(options.into())),
            Arc::new(Default::default()),
        ));

        sentry::Hub::run(hub, || {
            f();
            let deadline = Instant::now() + Duration::from_secs(5);
            while transport.event_count() < expected && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                transport.event_count(),
                expected,
                "every dispatched report must reach the Sentry transport"
            );
            transport.take_events()
        })
    }

    #[test]
    fn cancelling_while_waiting_for_the_cli_install_lock_records_a_typed_outcome() {
        let registration = InstallCancellationRegistration {
            handle: Uuid::new_v4().to_string(),
        };
        register_cancel_handle(registration.handle.clone());
        assert!(cancel_install(registration.handle.clone()));

        let collector = InstallCancellationCollector::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime builds");
        let result = runtime.block_on(
            ACTIVE_INSTALL_CANCELLATION_COLLECTOR.scope(collector.clone(), async {
                registration.reject_if_cancelled()
            }),
        );

        assert_eq!(
            result,
            Err(crate::commands::hq_cli_update::CLI_INSTALL_CANCELLED_MESSAGE.to_string())
        );
        let cancellation = collector.take().expect("typed cancellation is collected");
        assert_eq!(cancellation, InstallCancellation::UserCancelled);
        let result = cancelled_result("hq-cli", &cancellation);
        assert!(
            capture_reporting_loop(&result).is_empty(),
            "a lock-wait cancellation must not emit the generic dependency failure"
        );
    }

    /// Regression for the transport race fixed in PR #881, in its second home.
    ///
    /// `queue_setup_cancellation_cleanup_failure` dispatches each report onto a
    /// background thread, so two queued reports land at the transport at two
    /// unrelated moments. The old waiter polled
    /// `TestTransport::fetch_and_clear_events` and returned the first non-empty
    /// batch, which DRAINS: whichever report had not landed yet was discarded
    /// and the caller got a snapshot one event short. Against the old helper
    /// this test fails on the count; the counting transport waits for both.
    #[cfg(unix)]
    #[test]
    fn a_queued_capture_waits_for_every_dispatched_report() {
        let scope = scope();
        let diagnostic = diagnostic("cleanup failed");

        let events = capture_queued_events(2, || {
            queue_setup_cancellation_cleanup_failure(
                scope.clone(),
                "hq-cli",
                CancellationCleanupFailure::from_unix_signal(
                    Signal::SIGTERM,
                    nix::errno::Errno::EPERM,
                ),
                diagnostic.clone(),
            );
            queue_setup_cancellation_cleanup_failure(
                scope.clone(),
                "yq",
                CancellationCleanupFailure::from_unix_signal(
                    Signal::SIGKILL,
                    nix::errno::Errno::ESRCH,
                ),
                diagnostic.clone(),
            );
        });

        assert_eq!(events.len(), 2);
        let mut dependencies = events
            .iter()
            .map(|event| event.tags["setup_dependency"].clone())
            .collect::<Vec<_>>();
        dependencies.sort();
        assert_eq!(dependencies, vec!["hq-cli".to_string(), "yq".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_failure_is_emitted_before_a_hung_child_exits() {
        let cleanup = sigterm_eperm_cleanup_failure();
        let collector = SetupDiagnosticCollector::new();
        let cancellation_collector = InstallCancellationCollector::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime builds");
        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("hung child starts");

        let events = capture_queued_events(1, || {
            runtime.block_on(ACTIVE_ONBOARDING_FAILURE_SCOPE.scope(
                scope(),
                ACTIVE_SETUP_DEPENDENCY.scope(
                    "hq-cli",
                    ACTIVE_SETUP_DIAGNOSTIC_COLLECTOR.scope(collector, async {
                        ACTIVE_INSTALL_CANCELLATION_COLLECTOR
                            .scope(cancellation_collector.clone(), async {
                                assert!(
                                    child.try_wait().expect("poll hung child").is_none(),
                                    "the cleanup report must be emitted while the child is still running"
                                );
                                record_install_cancellation(InstallCancellation::CleanupFailed(
                                    cleanup.clone(),
                                ));
                            })
                            .await;
                    }),
                ),
            ));
        });

        assert!(
            child.try_wait().expect("poll after report").is_none(),
            "the report must not wait for the hung child to exit"
        );
        child.kill().expect("stop hung child");
        child.wait().expect("reap hung child");

        assert_eq!(
            cancellation_collector.take(),
            Some(InstallCancellation::CleanupFailed(cleanup))
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(
            events[0].fingerprint,
            vec!["hq-cli", "cancel-cleanup-failed", "SIGTERM", "EPERM"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_cleanup_failure_reports_even_after_a_successful_yq_fallback() {
        let cleanup = sigterm_eperm_cleanup_failure();
        let yq = dependency_defs()
            .iter()
            .find(|dep| dep.id == "yq")
            .expect("yq is registered");
        let results = HashMap::from([(
            "yq",
            DepInstallResult {
                id: yq.id,
                label: yq.label,
                optional: yq.optional,
                status: DepInstallStatus::Ok,
                error: None,
            },
        )]);
        let cancellations =
            HashMap::from([("yq", InstallCancellation::CleanupFailed(cleanup.clone()))]);

        let reports = setup_cancellation_cleanup_failure_reports(
            &results,
            &HashMap::new(),
            &cancellations,
            &HashSet::new(),
        );

        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].dependency, "yq");
        let events = sentry::test::with_captured_events(|| {
            let report = reports.into_iter().next().expect("cleanup report exists");
            send_setup_cancellation_cleanup_failure(
                &scope(),
                report.dependency,
                report.cleanup,
                report.diagnostic,
            );
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(events[0].tags["setup_dependency"], "yq");
    }

    #[test]
    fn nonzero_exit_keeps_its_diagnostic_for_the_stage_category() {
        let result = failed_result("hq-cli", "Process exited with code 1");
        let results = HashMap::from([("hq-cli", result.clone())]);
        let diagnostics = HashMap::from([(
            "hq-cli",
            SetupCommandDiagnostic {
                command: "npm install -g @indigoai-us/hq-cli".to_string(),
                exit_code: Some(1),
                stdout: String::new(),
                stderr: String::new(),
                error: "Process exited with code 1".to_string(),
            },
        )]);

        let reports = setup_dependency_failure_reports(dependency_defs(), &results, &diagnostics);

        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].category, OnboardingErrorCategory::ExitNonzero);
        assert_eq!(
            setup_error_category(
                results.get("hq-cli").expect("failed result exists"),
                diagnostics.get("hq-cli"),
            ),
            OnboardingErrorCategory::ExitNonzero,
            "the generic rendered error must not degrade to unknown"
        );
        assert!(
            diagnostics.contains_key("hq-cli"),
            "stage detail must retain the command diagnostic after dependency reporting"
        );
    }

    #[test]
    fn a_clean_user_cancellation_is_cancelled_and_not_reportable() {
        let cancellation = InstallCancellation::UserCancelled;
        let result = cancelled_result("hq-cli", &cancellation);

        assert_eq!(
            setup_error_category(&result, None),
            OnboardingErrorCategory::Cancelled
        );
        assert!(
            reportable_setup_failure_ids(
                dependency_defs(),
                &HashMap::from([("hq-cli", result.clone())]),
            )
            .is_empty(),
            "a user cancellation must not be an error-level setup failure"
        );
        assert!(
            capture_reporting_loop(&result).is_empty(),
            "a user cancellation must capture no error-level Sentry event"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_sigterm_cleanup_is_reported_separately_from_a_user_cancellation() {
        let cleanup = sigterm_eperm_cleanup_failure();
        let cancellation = InstallCancellation::CleanupFailed(cleanup.clone());
        let result = cancelled_result("hq-cli", &cancellation);

        assert!(
            capture_reporting_loop(&result).is_empty(),
            "the cancellation must not also create the generic setup-failure event"
        );
        let events = sentry::test::with_captured_events(|| {
            send_setup_cancellation_cleanup_failure(
                &scope(),
                "hq-cli",
                cleanup,
                diagnostic(result.error.as_deref().unwrap_or_default()),
            );
        });
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(
            event.fingerprint,
            vec!["hq-cli", "cancel-cleanup-failed", "SIGTERM", "EPERM"],
            "cleanup grouping must exclude the machine-specific process-group id"
        );
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(
            event.message.as_deref(),
            Some("Desktop setup cancellation cleanup could leave an install process running")
        );
        assert_eq!(event.tags["setup_error_category"], "cancel-cleanup-failed");
        assert_eq!(event.tags["setup_cancel_signal"], "SIGTERM");
        assert_eq!(event.tags["setup_cancel_os_error_kind"], "EPERM");
    }

    #[test]
    fn a_genuine_dependency_install_failure_still_reports_at_error_level() {
        let result = failed_result("hq-cli", "Process exited with code 1: npm ERR! EACCES");

        let events = capture_reporting_loop(&result);
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(
            event.fingerprint,
            vec!["desktop-setup-dependency-install-failed"]
        );
        assert_eq!(
            event.message.as_deref(),
            Some("Desktop setup dependency installation failed")
        );
    }
}
