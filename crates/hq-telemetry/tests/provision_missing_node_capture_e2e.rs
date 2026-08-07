//! Built-artifact envelope proof for HQ-DESKTOP-49.
//!
//! The reported Sentry event was
//!
//! ```text
//! [provision-cli] spawn `hq` failed: npx:@indigoai-us/hq-cli@^5.10.0: No such file or directory (os error 2)
//! ```
//!
//! captured at `level=error` with `provision_kind=spawn`,
//! `cli_invocation=npx:@indigoai-us/hq-cli@^5.10.0` and `exit_code=signal/none`,
//! from a macOS machine that had no Node runtime at all.
//!
//! These tests drive the real production decision
//! (`run_cli_provision::finish_spawn_failure`, reached through its
//! `test-support` seam) through the real `hq_telemetry::before_send` scrubber
//! and assert on the resulting envelopes. Two things are proven:
//!
//!   1. A **proven** user-owned runtime gap (managed runtime `NotProvisioned`
//!      plus both probes `NotFound`) produces ZERO envelopes and a typed
//!      `LocalEnv` error the UI can act on — so the reported event can no
//!      longer be produced by that machine state.
//!   2. Every state that is *not* proven — a broken HQ-managed toolchain, an
//!      uninspectable path, a different `io::ErrorKind`, a non-`npx` program,
//!      a resolved (non-bare) program — still produces exactly one
//!      `level=error` envelope. Silencing those would turn an HQ defect into
//!      silence, which is the failure mode this cluster must not trade for.
//!
//! Asserting envelope COUNTS (not just message text) is what makes this a
//! base-fails/candidate-passes proof: on the pre-fix code every one of these
//! inputs captured, so case 1 fails there.

use std::io::{Error, ErrorKind};
use std::sync::Arc;

use hq_desktop_core::hq_resolver::{HqInvocation, HQ_CLI_NPM_RANGE};
use hq_desktop_core::run_cli_provision::{finish_spawn_failure_for_test, CliProvisionError};
use hq_desktop_core::runtime_diagnosis::{ProbeOutcome, ProgramProvenance, RuntimeDiagnosisInput};
use hq_desktop_core::toolchain::ManagedRuntime;

/// The literal Sentry title from issue HQ-DESKTOP-49, event
/// `5bdc25c9de1742ac823cbb564093fc97`.
const REPORTED_TITLE: &str = "[provision-cli] spawn `hq` failed: \
     npx:@indigoai-us/hq-cli@^5.10.0: No such file or directory (os error 2)";

/// The same failure as the caller sees it. `report_provision_error` adds the
/// `[provision-cli]` prefix on the way into Sentry, so the error's own
/// `Display` is the title minus that prefix.
const REPORTED_ERROR_DISPLAY: &str = "spawn `hq` failed: \
     npx:@indigoai-us/hq-cli@^5.10.0: No such file or directory (os error 2)";

fn enoent() -> Error {
    // Constructed from the raw errno so the Display text is the platform's own
    // rendering — the same string the reported event carried, not a literal we
    // typed to match it.
    Error::from_raw_os_error(2)
}

fn captured(f: impl FnOnce()) -> Vec<sentry::protocol::Event<'static>> {
    sentry::test::with_captured_events_options(
        f,
        sentry::ClientOptions {
            before_send: Some(Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        },
    )
}

/// The exact machine state from the report: no managed runtime, no `node`, no
/// `npx`, and the resolver having fallen back to the bare-name npx invocation.
fn reported_machine_state() -> RuntimeDiagnosisInput {
    RuntimeDiagnosisInput {
        attempted_program: "npx".to_string(),
        program_provenance: ProgramProvenance::BareName,
        spawn_error_kind: ErrorKind::NotFound,
        node_probe: ProbeOutcome::NotFound,
        npx_probe: ProbeOutcome::NotFound,
        managed_runtime: ManagedRuntime::NotProvisioned,
    }
}

fn run(diagnosis: RuntimeDiagnosisInput) -> (Vec<sentry::protocol::Event<'static>>, String) {
    let mut error = None;
    let events = captured(|| {
        error = Some(finish_spawn_failure_for_test(
            "lpg-digital",
            &HqInvocation::Npx,
            &enoent(),
            diagnosis,
        ));
    });
    (events, error.expect("the seam always returns an error").to_string())
}

/// Guard on the guard: if the invocation label ever drifts, the "reported
/// title" this file asserts against stops describing the real event and every
/// other test here silently weakens. Pin the composition instead of trusting
/// the constant.
#[test]
fn the_reported_title_is_still_what_this_code_would_compose() {
    assert_eq!(HQ_CLI_NPM_RANGE, "^5.10.0");
    assert_eq!(
        HqInvocation::Npx.sentry_label(),
        "npx:@indigoai-us/hq-cli@^5.10.0"
    );
    assert_eq!(
        format!(
            "[provision-cli] spawn `hq` failed: {}: {}",
            HqInvocation::Npx.sentry_label(),
            enoent()
        ),
        REPORTED_TITLE,
    );
    assert_eq!(REPORTED_TITLE, format!("[provision-cli] {REPORTED_ERROR_DISPLAY}"));
}

/// THE regression: the reported machine can no longer produce the reported
/// event, and gets an actionable typed error instead of an opaque spawn crash.
#[test]
fn a_proven_missing_node_runtime_emits_no_envelope_at_all() {
    let (events, message) = run(reported_machine_state());

    assert!(
        events.is_empty(),
        "a machine with no Node is a user setup gap, not an HQ defect — \
         it must not page anyone; got: {:?}",
        events.iter().map(|e| e.message.clone()).collect::<Vec<_>>()
    );
    assert_ne!(message, REPORTED_ERROR_DISPLAY);
    assert_eq!(
        message,
        "local environment failure (node-missing): \
         Install Node.js and reopen HQ Sync, then retry Connect."
    );
}

#[test]
fn a_user_owned_node_with_a_broken_npx_shim_emits_no_envelope() {
    let (events, message) = run(RuntimeDiagnosisInput {
        node_probe: ProbeOutcome::Ok,
        ..reported_machine_state()
    });

    assert!(events.is_empty());
    assert_eq!(
        message,
        "local environment failure (npx-unavailable): \
         Repair or reinstall Node.js and reopen HQ Sync, then retry Connect."
    );
}

/// Every ambiguous or HQ-owned state stays reportable, and stays reportable
/// as the SAME event — same message, same tag set — so the existing issue
/// keeps grouping and no alerting rule needs rewriting.
#[test]
fn every_unproven_runtime_state_still_captures_exactly_one_error() {
    let cases: Vec<(&str, RuntimeDiagnosisInput, &str, Option<&str>)> = vec![
        (
            "a half-installed HQ-managed toolchain is HQ's defect",
            RuntimeDiagnosisInput {
                managed_runtime: ManagedRuntime::Incomplete {
                    expected_node: "/managed/node".into(),
                },
                ..reported_machine_state()
            },
            "hq-managed",
            None,
        ),
        (
            "an HQ-managed node whose npx never shipped is HQ's defect",
            RuntimeDiagnosisInput {
                managed_runtime: ManagedRuntime::PresentMissingNpx {
                    expected_npx: "/managed/npx".into(),
                },
                ..reported_machine_state()
            },
            "hq-managed",
            None,
        ),
        (
            "an uninspectable path proves nothing and must stay loud",
            RuntimeDiagnosisInput {
                managed_runtime: ManagedRuntime::Unknown {
                    reason: "path-uninspectable",
                },
                ..reported_machine_state()
            },
            "unknown",
            Some("path-uninspectable"),
        ),
        (
            "a present managed node that still cannot spawn is unexplained",
            RuntimeDiagnosisInput {
                managed_runtime: ManagedRuntime::Present {
                    node: "/managed/node".into(),
                },
                ..reported_machine_state()
            },
            "hq-managed",
            None,
        ),
        (
            "a probe that could not answer is not a proof of absence",
            RuntimeDiagnosisInput {
                node_probe: ProbeOutcome::Timeout,
                ..reported_machine_state()
            },
            "user",
            None,
        ),
        (
            "permission-denied is a different failure than not-installed",
            RuntimeDiagnosisInput {
                node_probe: ProbeOutcome::PermissionDenied,
                npx_probe: ProbeOutcome::PermissionDenied,
                ..reported_machine_state()
            },
            "user",
            None,
        ),
    ];

    for (why, diagnosis, expected_owner, expected_unknown_reason) in cases {
        let (events, message) = run(diagnosis);

        assert_eq!(events.len(), 1, "{why}");
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Error, "{why}");
        assert_eq!(event.message.as_deref(), Some(REPORTED_TITLE), "{why}");
        assert_eq!(message, REPORTED_ERROR_DISPLAY, "{why}");
        assert_eq!(event.tags["provision_kind"], "spawn", "{why}");
        assert_eq!(event.tags["cli_invocation"], "npx", "{why}");
        assert_eq!(event.tags["exit_code"], "signal/none", "{why}");
        assert_eq!(event.tags["slug"], "lpg-digital", "{why}");
        assert_eq!(event.tags["runtime_owner"], expected_owner, "{why}");
        assert_eq!(
            event.tags.get("runtime_unknown_reason").map(String::as_str),
            expected_unknown_reason,
            "{why}"
        );
    }
}

/// The downgrade is scoped to `NotFound` on a bare-name `npx`. A different
/// errno or a resolved path means something else broke, and something else
/// breaking is exactly what a spawn error should still report.
#[test]
fn the_downgrade_does_not_widen_past_a_bare_name_npx_enoent() {
    let widening_attempts: Vec<(&str, RuntimeDiagnosisInput, Error)> = vec![
        (
            "permission-denied on npx is not a missing runtime",
            RuntimeDiagnosisInput {
                spawn_error_kind: ErrorKind::PermissionDenied,
                ..reported_machine_state()
            },
            Error::from_raw_os_error(13),
        ),
        (
            "a resolved absolute npx that vanished is not a missing runtime",
            RuntimeDiagnosisInput {
                attempted_program: "/opt/homebrew/bin/npx".to_string(),
                program_provenance: ProgramProvenance::SystemPath,
                ..reported_machine_state()
            },
            enoent(),
        ),
        (
            "a missing `hq` binary is a different failure than a missing Node",
            RuntimeDiagnosisInput {
                attempted_program: "hq".to_string(),
                ..reported_machine_state()
            },
            enoent(),
        ),
    ];

    for (why, diagnosis, io_error) in widening_attempts {
        let mut error = None;
        let events = captured(|| {
            error = Some(finish_spawn_failure_for_test(
                "lpg-digital",
                &HqInvocation::Npx,
                &io_error,
                diagnosis,
            ));
        });

        assert_eq!(events.len(), 1, "{why}");
        assert_eq!(events[0].level, sentry::Level::Error, "{why}");
        assert!(
            matches!(error, Some(CliProvisionError::Spawn(_))),
            "{why}: expected a Spawn error, got {error:?}"
        );
    }
}

/// No resolved absolute path may survive into an envelope this path emits —
/// the scrubber is the last line of defence and it has to hold for the newly
/// added diagnostic tags too.
#[test]
fn no_local_path_survives_scrubbing_into_a_captured_envelope() {
    let private_path = "/Users/ada/Library/hq/toolchain/node/bin/node";
    let (events, _) = run(RuntimeDiagnosisInput {
        managed_runtime: ManagedRuntime::Incomplete {
            expected_node: private_path.into(),
        },
        ..reported_machine_state()
    });

    assert_eq!(events.len(), 1);
    let serialized = serde_json::to_string(&events[0]).expect("serialize scrubbed event");
    assert!(!serialized.contains(private_path));
    assert!(!serialized.contains("/Users/ada"));
    assert!(!serialized.contains("ada"));
}
