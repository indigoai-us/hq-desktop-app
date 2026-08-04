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
    Path::new(program).components().count() == 1
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
    if Instant::now() >= deadline {
        return ProbeOutcome::Timeout;
    }

    let mut command = paths::tokio_spawn_command(program, &["--version"]);
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

    match timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) if status.success() => ProbeOutcome::Ok,
        Ok(Ok(status)) => ProbeOutcome::NonZeroExit(status.code().unwrap_or(-1)),
        Ok(Err(error)) => match error.kind() {
            ErrorKind::NotFound => ProbeOutcome::NotFound,
            ErrorKind::PermissionDenied => ProbeOutcome::PermissionDenied,
            _ => ProbeOutcome::ProbeError(error.kind().to_string()),
        },
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            ProbeOutcome::Timeout
        }
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
}
