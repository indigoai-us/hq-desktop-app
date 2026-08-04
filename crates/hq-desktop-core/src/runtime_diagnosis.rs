//! Ownership-aware classification for a failed `hq`/`npx` spawn.
//!
//! The only silent outcomes are proven user-owned runtime setup states.  Any
//! uncertainty remains reportable so a broken managed HQ toolchain is never
//! mistaken for a missing user installation.

use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::time::{timeout_at, Instant};

use crate::paths;
use crate::toolchain::ManagedRuntime;

const TOTAL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_CLEANUP_RESERVE: Duration = Duration::from_millis(250);

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
    pub spawn_error_kind: ErrorKind,
    pub node_probe: ProbeOutcome,
    pub npx_probe: ProbeOutcome,
    pub managed_runtime: ManagedRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeDiagnosis {
    LocalLogOnly { kind: &'static str },
    Unexplained,
}

/// Decide whether a failed spawn is proven to be a user-owned setup gap.
///
/// This intentionally has no catch-all ownership arm: a newly added runtime
/// state must make this match non-exhaustive until its reporting policy is
/// reviewed.
pub fn diagnose(input: &RuntimeDiagnosisInput) -> RuntimeDiagnosis {
    if input.spawn_error_kind != ErrorKind::NotFound || input.attempted_program != "npx" {
        return RuntimeDiagnosis::Unexplained;
    }

    match &input.managed_runtime {
        ManagedRuntime::NotProvisioned => {
            if input.node_probe == ProbeOutcome::NotFound
                && input.npx_probe == ProbeOutcome::NotFound
            {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "node-missing",
                }
            } else if input.node_probe == ProbeOutcome::Ok
                && input.npx_probe == ProbeOutcome::NotFound
            {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "npx-unavailable",
                }
            } else {
                RuntimeDiagnosis::Unexplained
            }
        }
        ManagedRuntime::Present { .. } => {
            if input.node_probe == ProbeOutcome::Ok && input.npx_probe == ProbeOutcome::NotFound {
                RuntimeDiagnosis::LocalLogOnly {
                    kind: "npx-unavailable",
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

/// Closed-cardinality tags for a residual event. Never put the program path,
/// probe text, or original spawn error into telemetry: the scrubber does not
/// redact Sentry tags or messages.
pub fn program_provenance(program: &str, runtime: &ManagedRuntime) -> &'static str {
    if is_bare_program(program) {
        return "bare-name";
    }
    if program.contains(".npm-global") || program.contains("npm-prefix") {
        return "user-npm-prefix";
    }
    if program.starts_with("/usr/local/") || program.starts_with("/opt/homebrew/") {
        return "system-path";
    }
    match runtime {
        ManagedRuntime::Incomplete { .. }
        | ManagedRuntime::Present { .. }
        | ManagedRuntime::PresentMissingNpx { .. } => "managed-toolchain",
        ManagedRuntime::NotProvisioned | ManagedRuntime::Unknown { .. } => "other",
    }
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
/// twice. Each child is explicitly killed and reaped on timeout.
pub async fn inspect_spawn_failure(
    attempted_program: String,
    spawn_error_kind: ErrorKind,
) -> RuntimeDiagnosisInput {
    let deadline = Instant::now() + TOTAL_PROBE_TIMEOUT;
    let node_probe = probe_version("node", deadline).await;
    let npx_probe = probe_version("npx", deadline).await;
    RuntimeDiagnosisInput {
        attempted_program,
        spawn_error_kind,
        node_probe,
        npx_probe,
        managed_runtime: crate::toolchain::classify_runtime(),
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
        Err(_) => {
            let kill_result = child.start_kill();
            bounded_reap(kill_result, child.wait(), deadline).await
        }
    }
}

async fn bounded_reap<F>(
    kill_result: std::io::Result<()>,
    wait: F,
    deadline: Instant,
) -> ProbeOutcome
where
    F: std::future::Future<Output = std::io::Result<std::process::ExitStatus>>,
{
    let kill_error = kill_result.err().map(|error| error.kind().to_string());
    match timeout_at(deadline, wait).await {
        Ok(Ok(_)) if kill_error.is_none() => ProbeOutcome::Timeout,
        Ok(Ok(_)) => {
            ProbeOutcome::ProbeError(format!("timeout cleanup failed: kill={kill_error:?}"))
        }
        Ok(Err(error)) => ProbeOutcome::ProbeError(format!(
            "timeout cleanup failed: kill={kill_error:?}, wait={}",
            error.kind()
        )),
        Err(_) => ProbeOutcome::ProbeError(format!(
            "timeout cleanup deadline exceeded: kill={kill_error:?}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
            spawn_error_kind: ErrorKind::PermissionDenied,
            node_probe: ProbeOutcome::NotFound,
            npx_probe: ProbeOutcome::NotFound,
            managed_runtime: ManagedRuntime::NotProvisioned,
        };
        assert_eq!(diagnose(&input), RuntimeDiagnosis::Unexplained);
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

    #[tokio::test]
    async fn cleanup_that_cannot_finish_is_bounded_by_the_total_deadline() {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(40);
        let outcome = bounded_reap(
            Ok(()),
            std::future::pending::<std::io::Result<std::process::ExitStatus>>(),
            deadline,
        )
        .await;

        assert!(
            matches!(outcome, ProbeOutcome::ProbeError(ref detail) if detail.contains("cleanup deadline exceeded")),
            "an unreapable child must fail loudly: {outcome:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cleanup must not outlive the total diagnosis budget"
        );
    }
}
