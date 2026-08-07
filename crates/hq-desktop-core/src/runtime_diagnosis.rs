//! Ownership-aware classification for a failed `hq`/`npx` spawn.
//!
//! The only silent outcomes are proven user-owned runtime setup states.  Any
//! uncertainty remains reportable so a broken managed HQ toolchain is never
//! mistaken for a missing user installation.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::time::{timeout_at, Instant};

use crate::logfile::log;
use crate::paths;
use crate::toolchain::ManagedRuntime;

const TOTAL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_CLEANUP_RESERVE: Duration = Duration::from_millis(250);
const DEFERRED_REAP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    Ok,
    NotFound,
    PermissionDenied,
    NonZeroExit(i32),
    Timeout,
    ProbeError(String),
}

impl ProbeOutcome {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NotFound => "not-found",
            Self::PermissionDenied => "permission-denied",
            Self::NonZeroExit(_) => "non-zero-exit",
            Self::Timeout => "timeout",
            Self::ProbeError(_) => "probe-error",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeDiagnosisInput {
    pub attempted_program: String,
    pub program_provenance: ProgramProvenance,
    pub spawn_error_kind: ErrorKind,
    pub node_probe: ProbeOutcome,
    pub npx_probe: ProbeOutcome,
    pub managed_runtime: ManagedRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeDiagnosis {
    LocalLogOnly {
        kind: &'static str,
        user_detail: &'static str,
    },
    Unexplained,
}

/// Decide whether a failed spawn is proven to be a user-owned setup gap.
///
/// This intentionally has no catch-all ownership arm: a newly added runtime
/// state must make this match non-exhaustive until its reporting policy is
/// reviewed.
pub fn diagnose(input: &RuntimeDiagnosisInput) -> RuntimeDiagnosis {
    if input.spawn_error_kind != ErrorKind::NotFound
        || input.attempted_program != "npx"
        || input.program_provenance != ProgramProvenance::BareName
    {
        return RuntimeDiagnosis::Unexplained;
    }

    match &input.managed_runtime {
        ManagedRuntime::NotProvisioned => {
            if input.node_probe == ProbeOutcome::NotFound
                && input.npx_probe == ProbeOutcome::NotFound
            {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "node-missing",
                    user_detail: "Install Node.js and reopen HQ Sync, then retry Connect.",
                }
            } else if input.node_probe == ProbeOutcome::Ok
                && input.npx_probe == ProbeOutcome::NotFound
            {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "npx-unavailable",
                    user_detail:
                        "Repair or reinstall Node.js and reopen HQ Sync, then retry Connect.",
                }
            } else {
                RuntimeDiagnosis::Unexplained
            }
        }
        ManagedRuntime::Present { .. } => {
            if input.node_probe == ProbeOutcome::Ok && input.npx_probe == ProbeOutcome::NotFound {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "npx-unavailable",
                    user_detail:
                        "Repair or reinstall Node.js and reopen HQ Sync, then retry Connect.",
                }
            } else {
                RuntimeDiagnosis::Unexplained
            }
        }
        ManagedRuntime::Incomplete { .. } => RuntimeDiagnosis::Unexplained,
        ManagedRuntime::PresentMissingNpx { .. } => RuntimeDiagnosis::Unexplained,
        ManagedRuntime::Unknown { .. } => RuntimeDiagnosis::Unexplained,
    }
}

pub fn is_bare_program(program: &str) -> bool {
    // The test suite exercises Windows paths on macOS too, and Unix's
    // `Path` treats backslashes as ordinary filename characters. Reject both
    // separator spellings before asking the host parser about native paths.
    !program.contains('/')
        && !program.contains('\\')
        && Path::new(program).components().count() == 1
}

/// Closed vocabulary for the attempted program's actual path ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramProvenance {
    BareName,
    ManagedToolchain,
    UserNpmPrefix,
    SystemPath,
    Other,
}

impl ProgramProvenance {
    pub fn tag(self) -> &'static str {
        match self {
            Self::BareName => "bare-name",
            Self::ManagedToolchain => "managed-toolchain",
            Self::UserNpmPrefix => "user-npm-prefix",
            Self::SystemPath => "system-path",
            Self::Other => "other",
        }
    }
}

fn windows_style_path(value: &str) -> bool {
    value.contains('\\')
        || value
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
}

fn normalized_path(value: &Path, fold_case: bool) -> String {
    let mut raw = value.to_string_lossy().replace('\\', "/");
    if fold_case {
        raw.make_ascii_lowercase();
    }
    let drive_prefix = raw
        .as_bytes()
        .get(1)
        .filter(|separator| **separator == b':')
        .map(|_| raw[..2].to_string());
    let remainder = drive_prefix
        .as_ref()
        .map(|_| &raw[2..])
        .unwrap_or(raw.as_str());
    let rooted = remainder.starts_with('/');
    let mut components: Vec<&str> = Vec::new();
    for component in remainder.split('/') {
        match component {
            "" | "." => {}
            ".." if components.last().is_some_and(|last| *last != "..") => {
                components.pop();
            }
            ".." if !rooted => components.push(component),
            ".." => {}
            _ => components.push(component),
        }
    }

    let body = components.join("/");
    match (drive_prefix, rooted, body.is_empty()) {
        (Some(prefix), true, true) => format!("{prefix}/"),
        (Some(prefix), true, false) => format!("{prefix}/{body}"),
        (Some(prefix), false, _) => format!("{prefix}{body}"),
        (None, true, true) => "/".to_string(),
        (None, true, false) => format!("/{body}"),
        (None, false, _) => body,
    }
}

fn path_is_within(program: &Path, root: &Path) -> bool {
    let program_text = program.to_string_lossy();
    let root_text = root.to_string_lossy();
    let fold_case = windows_style_path(&program_text) || windows_style_path(&root_text);
    let program = normalized_path(program, fold_case);
    let root = normalized_path(root, fold_case);
    if root.is_empty() {
        return false;
    }
    if root.ends_with('/') {
        return program.starts_with(&root);
    }
    program == root
        || program
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// Classify the exact attempted path by membership in explicit roots. Runtime
/// health is deliberately not an input: a managed runtime elsewhere does not
/// make an arbitrary absolute path managed, and a managed npm-prefix path is
/// still managed even though its directory name contains `npm-prefix`.
pub fn program_provenance_from_roots(
    program: &str,
    managed_roots: &[PathBuf],
    user_roots: &[PathBuf],
    system_roots: &[PathBuf],
) -> ProgramProvenance {
    if is_bare_program(program) {
        return ProgramProvenance::BareName;
    }
    let program = Path::new(program);
    if managed_roots
        .iter()
        .any(|root| path_is_within(program, root))
    {
        ProgramProvenance::ManagedToolchain
    } else if user_roots.iter().any(|root| path_is_within(program, root)) {
        ProgramProvenance::UserNpmPrefix
    } else if system_roots
        .iter()
        .any(|root| path_is_within(program, root))
    {
        ProgramProvenance::SystemPath
    } else {
        ProgramProvenance::Other
    }
}

/// Closed-cardinality tags for a residual event. Never put the program path,
/// probe text, or original spawn error into telemetry: the scrubber does not
/// redact Sentry tags or messages.
fn program_provenance(program: &str, managed_roots: &[PathBuf]) -> ProgramProvenance {
    program_provenance_from_roots(
        program,
        managed_roots,
        &paths::user_program_roots(),
        &paths::system_program_roots(),
    )
}

pub fn runtime_owner(runtime: &ManagedRuntime) -> &'static str {
    match runtime {
        ManagedRuntime::NotProvisioned => "user",
        ManagedRuntime::Incomplete { .. }
        | ManagedRuntime::Present { .. }
        | ManagedRuntime::PresentMissingNpx { .. } => "hq-managed",
        ManagedRuntime::Unknown { .. } => "unknown",
    }
}

pub fn unknown_reason(runtime: &ManagedRuntime) -> Option<&'static str> {
    match runtime {
        ManagedRuntime::Unknown { reason } => Some(*reason),
        ManagedRuntime::NotProvisioned
        | ManagedRuntime::Incomplete { .. }
        | ManagedRuntime::Present { .. }
        | ManagedRuntime::PresentMissingNpx { .. } => None,
    }
}

/// Capture runtime evidence after an already-failed spawn. The two probes
/// share one absolute deadline, so a broken laptop cannot pay the timeout
/// twice. Timed-out children are explicitly killed and normally reaped before
/// return; if the OS cannot make one waitable inside that deadline, ownership
/// moves to the separately bounded, locally observable reaper below.
pub async fn inspect_spawn_failure(
    attempted_program: String,
    spawn_error_kind: ErrorKind,
) -> RuntimeDiagnosisInput {
    let managed_roots = paths::managed_toolchain_roots_checked();
    let program_provenance = program_provenance(
        &attempted_program,
        managed_roots.as_deref().unwrap_or_default(),
    );
    let managed_runtime = crate::toolchain::classify_runtime_from_discovery(managed_roots);
    let deadline = Instant::now() + TOTAL_PROBE_TIMEOUT;
    let node_probe = probe_version("node", deadline).await;
    let npx_probe = probe_version("npx", deadline).await;
    RuntimeDiagnosisInput {
        attempted_program,
        program_provenance,
        spawn_error_kind,
        node_probe,
        npx_probe,
        managed_runtime,
    }
}

async fn probe_version(program: &str, deadline: Instant) -> ProbeOutcome {
    probe_command(program, &["--version"], deadline).await
}

async fn probe_command(program: &str, args: &[&str], deadline: Instant) -> ProbeOutcome {
    let Some(run_deadline) = deadline.checked_sub(PROBE_CLEANUP_RESERVE) else {
        return ProbeOutcome::Timeout;
    };
    if Instant::now() >= run_deadline {
        return ProbeOutcome::Timeout;
    }

    let mut command = paths::tokio_spawn_command(program, args);
    command
        .env("PATH", paths::child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return match error.kind() {
                ErrorKind::NotFound => ProbeOutcome::NotFound,
                ErrorKind::PermissionDenied => ProbeOutcome::PermissionDenied,
                _ => ProbeOutcome::ProbeError(error.kind().to_string()),
            };
        }
    };

    match timeout_at(run_deadline, child.wait()).await {
        Ok(Ok(status)) if status.success() => ProbeOutcome::Ok,
        Ok(Ok(status)) => ProbeOutcome::NonZeroExit(status.code().unwrap_or(-1)),
        Ok(Err(error)) => match error.kind() {
            ErrorKind::NotFound => ProbeOutcome::NotFound,
            ErrorKind::PermissionDenied => ProbeOutcome::PermissionDenied,
            _ => ProbeOutcome::ProbeError(error.kind().to_string()),
        },
        Err(_) => terminate_and_reap(child, deadline).await,
    }
}

async fn terminate_and_reap(child: tokio::process::Child, deadline: Instant) -> ProbeOutcome {
    terminate_and_reap_inner(child, deadline, false).await
}

async fn terminate_and_reap_inner(
    mut child: tokio::process::Child,
    deadline: Instant,
    force_deferred_reaper: bool,
) -> ProbeOutcome {
    let pid = child.id();
    let kill_error = child
        .start_kill()
        .err()
        .map(|error| error.kind().to_string());
    if force_deferred_reaper {
        defer_reap(child, pid, kill_error.as_deref());
        return ProbeOutcome::ProbeError(format!("timeout cleanup deferred: kill={kill_error:?}"));
    }
    match timeout_at(deadline, child.wait()).await {
        Ok(Ok(_)) if kill_error.is_none() => ProbeOutcome::Timeout,
        Ok(Ok(_)) => {
            ProbeOutcome::ProbeError(format!("timeout cleanup failed: kill={kill_error:?}"))
        }
        Ok(Err(error)) => ProbeOutcome::ProbeError(format!(
            "timeout cleanup failed: kill={kill_error:?}, wait={}",
            error.kind()
        )),
        Err(_) => {
            defer_reap(child, pid, kill_error.as_deref());
            ProbeOutcome::ProbeError(format!("timeout cleanup deferred: kill={kill_error:?}"))
        }
    }
}

/// The operating system cannot promise that a killed process becomes
/// waitable before an arbitrary application deadline. If that deadline is
/// exhausted, retain ownership of the Child in a separately bounded reaper
/// and record both its start and terminal state in the local diagnostic log.
/// This avoids the previous silent Child drop while keeping Connect bounded.
fn defer_reap(
    mut child: tokio::process::Child,
    pid: Option<u32>,
    initial_kill_error: Option<&str>,
) {
    let initial_kill_error = initial_kill_error.unwrap_or("none").to_string();
    log(
        "runtime-diagnosis",
        &format!("probe cleanup deferred pid={pid:?} initial_kill_error={initial_kill_error}"),
    );
    tokio::spawn(async move {
        let retry_kill_error = child
            .start_kill()
            .err()
            .map(|error| error.kind().to_string());
        let reap_deadline = Instant::now() + DEFERRED_REAP_TIMEOUT;
        match timeout_at(reap_deadline, child.wait()).await {
            Ok(Ok(status)) => log(
                "runtime-diagnosis",
                &format!(
                    "deferred probe reaped pid={pid:?} status={status:?} retry_kill_error={retry_kill_error:?}"
                ),
            ),
            Ok(Err(error)) => log(
                "runtime-diagnosis",
                &format!(
                    "deferred probe reap failed pid={pid:?} wait_error={} retry_kill_error={retry_kill_error:?}",
                    error.kind(),
                ),
            ),
            Err(_) => log(
                "runtime-diagnosis",
                &format!(
                    "deferred probe reap deadline exceeded pid={pid:?} retry_kill_error={retry_kill_error:?}"
                ),
            ),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::PathBuf;

    struct EnvRestore {
        key: &'static str,
        original: Option<OsString>,
    }

    impl EnvRestore {
        fn capture(key: &'static str) -> Self {
            Self {
                key,
                original: std::env::var_os(key),
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match self.original.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn runtime_states() -> Vec<ManagedRuntime> {
        vec![
            ManagedRuntime::NotProvisioned,
            ManagedRuntime::Incomplete {
                expected_node: PathBuf::from("/managed/node"),
            },
            ManagedRuntime::Present {
                node: PathBuf::from("/managed/node"),
            },
            ManagedRuntime::PresentMissingNpx {
                expected_npx: PathBuf::from("/managed/npx"),
            },
            ManagedRuntime::Unknown {
                reason: "path-uninspectable",
            },
        ]
    }

    fn outcomes() -> Vec<ProbeOutcome> {
        vec![
            ProbeOutcome::Ok,
            ProbeOutcome::NotFound,
            ProbeOutcome::PermissionDenied,
            ProbeOutcome::NonZeroExit(1),
            ProbeOutcome::Timeout,
            ProbeOutcome::ProbeError("launch error".to_string()),
        ]
    }

    #[test]
    fn only_two_proven_user_owned_rows_are_local_log_only() {
        for program in ["npx", "/Users/Ada/bin/npx"] {
            for managed_runtime in runtime_states() {
                for node_probe in outcomes() {
                    for npx_probe in outcomes() {
                        let actual = diagnose(&RuntimeDiagnosisInput {
                            attempted_program: program.to_string(),
                            program_provenance: if program == "npx" {
                                ProgramProvenance::BareName
                            } else {
                                ProgramProvenance::Other
                            },
                            spawn_error_kind: ErrorKind::NotFound,
                            node_probe: node_probe.clone(),
                            npx_probe: npx_probe.clone(),
                            managed_runtime: managed_runtime.clone(),
                        });
                        let expected = if program == "npx"
                            && managed_runtime == ManagedRuntime::NotProvisioned
                            && node_probe == ProbeOutcome::NotFound
                            && npx_probe == ProbeOutcome::NotFound
                        {
                            RuntimeDiagnosis::LocalLogOnly {
                                kind: "node-missing",
                                user_detail:
                                    "Install Node.js and reopen HQ Sync, then retry Connect.",
                            }
                        } else if program == "npx"
                            && matches!(
                                managed_runtime,
                                ManagedRuntime::NotProvisioned | ManagedRuntime::Present { .. }
                            )
                            && node_probe == ProbeOutcome::Ok
                            && npx_probe == ProbeOutcome::NotFound
                        {
                            RuntimeDiagnosis::LocalLogOnly {
                                kind: "npx-unavailable",
                                user_detail: "Repair or reinstall Node.js and reopen HQ Sync, then retry Connect.",
                            }
                        } else {
                            RuntimeDiagnosis::Unexplained
                        };
                        assert_eq!(actual, expected, "program={program}, runtime={managed_runtime:?}, node={node_probe:?}, npx={npx_probe:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn non_not_found_spawn_errors_are_never_silenced() {
        let input = RuntimeDiagnosisInput {
            attempted_program: "npx".to_string(),
            program_provenance: ProgramProvenance::BareName,
            spawn_error_kind: ErrorKind::PermissionDenied,
            node_probe: ProbeOutcome::NotFound,
            npx_probe: ProbeOutcome::NotFound,
            managed_runtime: ManagedRuntime::NotProvisioned,
        };
        assert_eq!(diagnose(&input), RuntimeDiagnosis::Unexplained);
    }

    #[test]
    fn inconsistent_non_bare_provenance_is_never_silenced() {
        let input = RuntimeDiagnosisInput {
            attempted_program: "npx".to_string(),
            program_provenance: ProgramProvenance::ManagedToolchain,
            spawn_error_kind: ErrorKind::NotFound,
            node_probe: ProbeOutcome::NotFound,
            npx_probe: ProbeOutcome::NotFound,
            managed_runtime: ManagedRuntime::NotProvisioned,
        };
        assert_eq!(
            diagnose(&input),
            RuntimeDiagnosis::Unexplained,
            "silencing requires mutually consistent bare-program evidence",
        );
    }

    #[test]
    fn unresolvable_platform_base_keeps_missing_node_reportable() {
        let discovery = paths::managed_toolchain_roots_from_base(None);
        assert_eq!(
            discovery
                .as_ref()
                .expect_err("missing base must be explicit")
                .reason,
            "base-dir-unresolved"
        );
        let managed_runtime = crate::toolchain::classify_runtime_from_discovery(discovery);
        assert_eq!(
            managed_runtime,
            ManagedRuntime::Unknown {
                reason: "base-dir-unresolved",
            }
        );

        let input = RuntimeDiagnosisInput {
            attempted_program: "npx".to_string(),
            program_provenance: ProgramProvenance::BareName,
            spawn_error_kind: ErrorKind::NotFound,
            node_probe: ProbeOutcome::NotFound,
            npx_probe: ProbeOutcome::NotFound,
            managed_runtime,
        };
        assert_eq!(
            diagnose(&input),
            RuntimeDiagnosis::Unexplained,
            "failure to resolve HOME/LOCALAPPDATA is never proof of user ownership"
        );
    }

    #[test]
    fn invalid_platform_bases_keep_missing_node_reportable() {
        for (base, expected_reason) in [
            (PathBuf::new(), "base-dir-empty"),
            (PathBuf::from("relative/home"), "base-dir-relative"),
        ] {
            let discovery = paths::managed_toolchain_roots_from_base(Some(base));
            assert_eq!(
                discovery
                    .as_ref()
                    .expect_err("invalid base must remain explicit")
                    .reason,
                expected_reason,
            );
            let managed_runtime = crate::toolchain::classify_runtime_from_discovery(discovery);
            let input = RuntimeDiagnosisInput {
                attempted_program: "npx".to_string(),
                program_provenance: ProgramProvenance::BareName,
                spawn_error_kind: ErrorKind::NotFound,
                node_probe: ProbeOutcome::NotFound,
                npx_probe: ProbeOutcome::NotFound,
                managed_runtime,
            };
            assert_eq!(
                diagnose(&input),
                RuntimeDiagnosis::Unexplained,
                "{expected_reason} is uncertainty, not positive user ownership",
            );
        }
    }

    #[test]
    fn native_invalid_platform_base_keeps_missing_node_reportable() {
        let _environment = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(target_os = "windows")]
        let key = "LOCALAPPDATA";
        #[cfg(not(target_os = "windows"))]
        let key = "HOME";
        let _restore = EnvRestore::capture(key);

        for (value, expected_reason) in [
            (OsString::new(), "base-dir-empty"),
            (OsString::from("relative/home"), "base-dir-relative"),
        ] {
            std::env::set_var(key, value);
            let discovery = paths::managed_toolchain_roots_checked();
            assert_eq!(
                discovery
                    .as_ref()
                    .expect_err("invalid native base must remain explicit")
                    .reason,
                expected_reason,
            );
            let input = RuntimeDiagnosisInput {
                attempted_program: "npx".to_string(),
                program_provenance: ProgramProvenance::BareName,
                spawn_error_kind: ErrorKind::NotFound,
                node_probe: ProbeOutcome::NotFound,
                npx_probe: ProbeOutcome::NotFound,
                managed_runtime: crate::toolchain::classify_runtime_from_discovery(discovery),
            };
            assert_eq!(
                diagnose(&input),
                RuntimeDiagnosis::Unexplained,
                "{expected_reason} must stay reportable through native discovery",
            );
        }
    }

    #[test]
    fn provenance_compares_the_attempted_path_to_explicit_roots() {
        let managed = vec![
            PathBuf::from(r"C:\Users\Ada\AppData\Local\IndigoHQ\toolchain"),
            PathBuf::from("/Users/Ada/Library/Application Support/Indigo HQ/toolchain"),
        ];
        let user = vec![
            PathBuf::from(r"C:\Users\Ada\AppData\Roaming\npm"),
            PathBuf::from("/Users/Ada/.npm-global/bin"),
        ];
        let system = vec![
            PathBuf::from(r"C:\Program Files\nodejs"),
            PathBuf::from("/opt/homebrew/bin"),
        ];

        for program in [
            r"C:\Users\Ada\AppData\Local\IndigoHQ\toolchain\npm-prefix\npx.cmd",
            "/Users/Ada/Library/Application Support/Indigo HQ/toolchain/node/bin/npx",
        ] {
            assert_eq!(
                program_provenance_from_roots(program, &managed, &user, &system).tag(),
                "managed-toolchain",
            );
        }
        for program in [
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd",
            "/Users/Ada/.npm-global/bin/npx",
        ] {
            assert_eq!(
                program_provenance_from_roots(program, &managed, &user, &system).tag(),
                "user-npm-prefix",
            );
        }
        for program in [r"C:\Program Files\nodejs\npx.cmd", "/opt/homebrew/bin/npx"] {
            assert_eq!(
                program_provenance_from_roots(program, &managed, &user, &system).tag(),
                "system-path",
            );
        }
        for program in [
            r"C:\Tools\npx.cmd",
            r"C:\Users\Ada\AppData\Local\IndigoHQ\toolchain\..\outside\npx.cmd",
            "/Users/Ada/custom/bin/npx",
            "/Users/Ada/Library/Application Support/Indigo HQ/toolchain/../outside/npx",
        ] {
            assert_eq!(
                program_provenance_from_roots(program, &managed, &user, &system).tag(),
                "other",
            );
        }
    }

    #[test]
    fn windows_absolute_program_is_not_bare_on_every_host_platform() {
        assert!(!is_bare_program(
            r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd"
        ));
        assert!(!is_bare_program("/Users/Ada/.npm-global/bin/npx"));
        assert!(is_bare_program("npx"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_probe_is_reaped_and_the_deadline_is_shared() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("slow-probe.sh");
        let first_pid = tmp.path().join("first.pid");
        let second_pid = tmp.path().join("second.pid");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nwhile :; do :; done\n",
        )
        .expect("write probe script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("make probe executable");

        let deadline = Instant::now() + Duration::from_secs(1);
        let first = probe_command(
            script.to_str().expect("utf-8 script path"),
            &[first_pid.to_str().expect("utf-8 pid path")],
            deadline,
        )
        .await;
        let second = probe_command(
            script.to_str().expect("utf-8 script path"),
            &[second_pid.to_str().expect("utf-8 pid path")],
            deadline,
        )
        .await;

        assert_eq!(first, ProbeOutcome::Timeout);
        assert_eq!(second, ProbeOutcome::Timeout);
        assert!(
            !second_pid.exists(),
            "the second probe must not start after the shared deadline"
        );

        let pid = std::fs::read_to_string(&first_pid).expect("probe recorded its pid");
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("probe pid liveness check")
            .success();
        assert!(
            !alive,
            "the timed-out probe child must be killed and reaped"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exhausted_cleanup_budget_transfers_the_child_to_an_observable_reaper() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("deferred-reap.sh");
        let pid_path = tmp.path().join("deferred.pid");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nwhile :; do :; done\n",
        )
        .expect("write probe script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("make probe executable");

        let mut command = paths::tokio_spawn_command(
            script.to_str().expect("utf-8 script path"),
            &[pid_path.to_str().expect("utf-8 pid path")],
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("spawn slow child");
        timeout_at(Instant::now() + Duration::from_secs(1), async {
            while !pid_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("child records pid");

        let outcome = terminate_and_reap_inner(child, Instant::now(), true).await;
        assert!(
            matches!(outcome, ProbeOutcome::ProbeError(ref detail) if detail.contains("deferred")),
            "deadline exhaustion must be explicit: {outcome:?}",
        );

        let pid = std::fs::read_to_string(&pid_path).expect("probe recorded its pid");
        timeout_at(Instant::now() + Duration::from_secs(2), async {
            loop {
                let alive = std::process::Command::new("/bin/kill")
                    .args(["-0", pid.trim()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("probe pid liveness check")
                    .success();
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("bounded deferred reaper terminates the child");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_timed_out_probe_is_terminated_and_reaped() {
        let mut command = paths::tokio_spawn_command(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ],
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn slow Windows probe");
        let pid = child.id().expect("spawned probe pid");

        let run_deadline = Instant::now() + Duration::from_millis(100);
        assert!(
            timeout_at(run_deadline, child.wait()).await.is_err(),
            "the probe must still be running when its execution budget ends",
        );
        let outcome = terminate_and_reap(child, Instant::now() + Duration::from_secs(2)).await;
        assert_eq!(outcome, ProbeOutcome::Timeout);

        let liveness_script = format!(
            "if (Get-Process -Id {} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}",
            pid,
        );
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &liveness_script,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("probe pid liveness check");
        assert!(
            status.success(),
            "the Windows probe must be gone after timeout"
        );
    }
}
