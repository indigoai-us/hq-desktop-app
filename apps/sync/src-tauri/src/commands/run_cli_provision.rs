//! CLI provisioning — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::run_cli_provision::*` call sites are unchanged.
pub use hq_desktop_core::run_cli_provision::*;

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;

    use hq_desktop_core::hq_resolver::HqInvocation;
    use hq_desktop_core::runtime_diagnosis::{ProbeOutcome, RuntimeDiagnosisInput};
    use hq_desktop_core::toolchain::ManagedRuntime;

    use super::report_unexplained_spawn_for_test;

    #[test]
    fn production_spawn_envelope_has_bounded_diagnostics_without_a_user_path() {
        let private_path = r"C:\Users\Ada\AppData\Roaming\npm\npx.cmd";
        let captures = sentry::test::with_captured_events(|| {
            report_unexplained_spawn_for_test(
                "acme",
                &HqInvocation::Local(private_path.to_string()),
                &RuntimeDiagnosisInput {
                    attempted_program: private_path.to_string(),
                    spawn_error_kind: ErrorKind::NotFound,
                    node_probe: ProbeOutcome::PermissionDenied,
                    npx_probe: ProbeOutcome::ProbeError(
                        "raw process output must stay local".into(),
                    ),
                    managed_runtime: ManagedRuntime::Unknown {
                        reason: "path-uninspectable",
                    },
                },
            );
        });

        assert_eq!(captures.len(), 1);
        let scrubbed = hq_telemetry::before_send(captures.into_iter().next().unwrap())
            .expect("the residual event remains reportable");
        let serialized = serde_json::to_string(&scrubbed).expect("serialize scrubbed event");

        assert!(!serialized.contains(private_path));
        assert!(!serialized.contains("raw process output must stay local"));
        assert_eq!(
            scrubbed.message.as_deref(),
            Some(
                "[provision-cli] spawn `hq` failed: local: No such file or directory (os error 2)"
            )
        );
        assert_eq!(scrubbed.tags["cli_invocation"], "local");
        assert_eq!(scrubbed.tags["exit_code"], "signal/none");
        assert_eq!(scrubbed.tags["program_provenance"], "other");
        assert_eq!(scrubbed.tags["runtime_owner"], "unknown");
        assert_eq!(
            scrubbed.tags["runtime_unknown_reason"],
            "path-uninspectable"
        );
        assert_eq!(scrubbed.tags["node_probe"], "permission-denied");
        assert_eq!(scrubbed.tags["npx_probe"], "probe-error");
    }
}
