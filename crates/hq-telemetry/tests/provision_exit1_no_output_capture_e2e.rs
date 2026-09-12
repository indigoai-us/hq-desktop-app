//! Built-artifact envelope proof for HQ-DESKTOP-68 (and its twin HQ-DESKTOP-69).
//!
//! The reported Sentry event was
//!
//! ```text
//! [provision-cli] vault/network error from `hq cloud provision`: exit 1 (vault) \
//!   — see ~/.hq/logs/hq-sync.log [provision-cli] for slug=arbium
//! ```
//!
//! captured at `level=error` with `provision_kind=network` and
//! `stderr_tail=""` — a fresh-macOS `npx` run that exited 1 having written
//! nothing at all, mislabelled a vault/network incident.
//!
//! These tests drive the real production decision
//! (`run_cli_provision::finish_child_exit`, through its `test-support` seam)
//! and the real `hq_telemetry::before_send` scrubber, then assert on the
//! envelopes. On the candidate:
//!
//!   1. An exit 1 with an empty stderr tail is reported as `no-output` (cause
//!      unproven) — NOT vault/network — carrying runtime provenance, node/npx
//!      probes, the node major, the child duration and the stdout tail, and
//!      fingerprinted into one issue. The reported vault title is absent.
//!   2. Every control that WAS classified correctly still is — a real vault
//!      5xx stays `network` with the unchanged message, npm EACCES stays
//!      `local-env`, exit 2 stays `validation`, exit 3 stays `sync` — so no
//!      alert rule or grouping regresses.
//!
//! Asserting message text, provision_kind, fingerprint and closed tags is what
//! makes this a base-fails/candidate-passes proof: the pre-fix code produced
//! the vault title with `provision_kind=network` and no fingerprint for input 1.

use std::io::ErrorKind;
use std::sync::Arc;

use hq_desktop_core::hq_resolver::{HqInvocation, HQ_CLI_NPM_RANGE};
use hq_desktop_core::run_cli_provision::{
    finish_child_exit_for_test, ChildOutput, CliProvisionError, ReaderOutcome,
};
use hq_desktop_core::runtime_diagnosis::{ProbeOutcome, ProgramProvenance, RuntimeDiagnosisInput};
use hq_desktop_core::toolchain::ManagedRuntime;

/// The exact pre-fix Sentry title for the reported occurrence. On the candidate
/// this must be ABSENT for the no-output input and PRESENT (unchanged) for the
/// genuine vault control — the generic exit-1 vault message is deliberately
/// left untouched.
const REPORTED_TITLE: &str = "[provision-cli] vault/network error from \
     `hq cloud provision`: exit 1 (vault) — see ~/.hq/logs/hq-sync.log \
     [provision-cli] for slug=arbium";

fn captured(f: impl FnOnce()) -> Vec<sentry::protocol::Event<'static>> {
    sentry::test::with_captured_events_options(
        f,
        sentry::ClientOptions {
            before_send: Some(Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        },
    )
}

fn output(stdout_lines: Vec<&str>, stderr_tail: Vec<&str>) -> ChildOutput {
    let stdout_lines: Vec<String> = stdout_lines.into_iter().map(String::from).collect();
    let stdout_tail = stdout_lines.clone();
    ChildOutput {
        stdout_lines,
        stdout_tail,
        stderr_tail: stderr_tail.into_iter().map(String::from).collect(),
        stdout_reader: ReaderOutcome::Eof,
        stderr_reader: ReaderOutcome::Eof,
    }
}

/// The reported machine: fresh macOS, no local `hq`, resolver on the Homebrew
/// `npx`, managed runtime not yet provisioned; both probes answer after the
/// fact because Node was present (the child DID run for ~58 s).
fn fresh_mac_npx_runtime() -> RuntimeDiagnosisInput {
    RuntimeDiagnosisInput {
        attempted_program: "/opt/homebrew/bin/npx".to_string(),
        program_provenance: ProgramProvenance::SystemPath,
        spawn_error_kind: ErrorKind::Other,
        node_probe: ProbeOutcome::Ok,
        npx_probe: ProbeOutcome::Ok,
        managed_runtime: ManagedRuntime::NotProvisioned,
    }
}

/// Guard on the guards: if the npm range or the npx label drifts, the reported
/// title this file asserts against stops describing the real event.
#[test]
fn npm_range_and_labels_are_still_what_this_test_asserts() {
    assert_eq!(HQ_CLI_NPM_RANGE, "^5.10.0");
    assert_eq!(HqInvocation::Npx.label(), "npx:@indigoai-us/hq-cli@^5.10.0");
}

/// THE regression: the reported machine can no longer mint a vault incident for
/// an evidence-free exit 1.
#[test]
fn the_reported_exit1_no_output_event_is_no_longer_a_vault_incident() {
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "arbium",
            &HqInvocation::Npx,
            Some(1),
            output(vec![], vec![]),
            58_000,
            Some(fresh_mac_npx_runtime()),
            Some(26),
        ));
    });

    assert!(matches!(err, Some(Err(CliProvisionError::NoOutput { .. }))));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    let message = event.message.as_deref().expect("event carries a message");

    assert_ne!(message, REPORTED_TITLE);
    assert!(!message.contains("vault/network error"), "{message}");
    assert!(
        message.contains("exited 1 with no stderr output"),
        "{message}"
    );
    assert!(message.contains("slug=arbium"), "{message}");

    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(event.tags["provision_kind"], "no-output");
    assert_eq!(
        event.tags["cli_invocation"],
        "npx:@indigoai-us/hq-cli@^5.10.0"
    );
    assert_eq!(event.tags["exit_code"], "1");
    assert_eq!(event.tags["stderr_reader"], "eof");
    assert_eq!(event.tags["stdout_reader"], "eof");
    assert_eq!(event.tags["program_provenance"], "system-path");
    assert_eq!(event.tags["runtime_owner"], "user");
    assert_eq!(event.tags["node_probe"], "ok");
    assert_eq!(event.tags["npx_probe"], "ok");
    assert_eq!(event.tags["node_major"], "26");

    assert_eq!(event.extra["stderr_lines"], serde_json::Value::from(0u64));
    assert_eq!(event.extra["stdout_lines"], serde_json::Value::from(0u64));
    assert_eq!(
        event.extra["child_duration_ms"],
        serde_json::Value::from(58_000u64)
    );
    assert!(event.extra.contains_key("stdout_tail"));

    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
    assert_eq!(fingerprint, ["provision-cli", "no-output", "npx", "1"]);

    // No user path may survive into a tag or the message.
    for (key, value) in event.tags.iter() {
        assert!(
            !value.contains("/Users/") && !value.contains("/home/"),
            "tag {key}={value}"
        );
    }
    assert!(
        !message.contains("/Users/") && !message.contains("/home/"),
        "{message}"
    );
}

/// A genuine vault 5xx on stderr still reports as `network` with the unchanged
/// message and no no-output fingerprint or runtime tags — the vault-incident
/// alert keeps firing for real incidents.
#[test]
fn a_vault_flavoured_exit1_still_reports_as_network_unchanged() {
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "arbium",
            &HqInvocation::Npx,
            Some(1),
            output(
                vec![],
                vec!["[hq cloud provision] Vault GET /entity/by-type/person failed: 503"],
            ),
            1_200,
            None,
            None,
        ));
    });

    assert!(matches!(err, Some(Err(CliProvisionError::Network(_)))));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.tags["provision_kind"], "network");
    assert_eq!(event.message.as_deref(), Some(REPORTED_TITLE));

    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
    assert!(!fingerprint.contains(&"no-output"), "{fingerprint:?}");
    assert!(!event.tags.contains_key("program_provenance"));
    assert!(!event.tags.contains_key("node_major"));
}

/// npm EACCES (on either stream) still classifies as `local-env`; the offending
/// path rides only in the scrubbed extra, never a tag or the message.
#[test]
fn an_npm_eacces_exit1_still_reports_as_local_env() {
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "arbium",
            &HqInvocation::Npx,
            Some(1),
            output(
                vec![],
                vec![
                    "npm error code EACCES",
                    "npm error path /Users/dan/.npm/_cacache/index-v5/aa",
                ],
            ),
            900,
            None,
            None,
        ));
    });

    assert!(matches!(
        err,
        Some(Err(CliProvisionError::LocalEnv {
            kind: "npm-cache-permission",
            ..
        }))
    ));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.tags["provision_kind"], "local-env");
    assert_eq!(event.tags["local_env_kind"], "npm-cache-permission");

    let message = event.message.as_deref().unwrap();
    // The raw account is scrubbed out of the message (the `/Users/` prefix may
    // remain as `[user]`); the account name must not survive.
    assert!(!message.contains("dan"), "{message}");
    assert!(
        message.contains("[user]"),
        "scrubber must have run: {message}"
    );
}

#[test]
fn exit2_still_reports_as_validation() {
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "arbium",
            &HqInvocation::Npx,
            Some(2),
            output(vec![], vec![]),
            300,
            None,
            None,
        ));
    });
    assert!(matches!(err, Some(Err(CliProvisionError::Validation(_)))));
    assert_eq!(events[0].tags["provision_kind"], "validation");
}

#[test]
fn exit3_with_partial_json_still_reports_as_sync() {
    let json = r#"{"ok":false,"company_slug":"arbium","cloud_uid":"cmp_x","bucket_name":"hq-vault-cmp-x","vault_api_url":"https://v","kms_key_id":null,"created_entity":true,"manifest_patched":true,"config_written":true,"initial_sync":{"ok":false,"error":"S3 timeout"}}"#;
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "arbium",
            &HqInvocation::Npx,
            Some(3),
            output(vec![json], vec![]),
            2_500,
            None,
            None,
        ));
    });
    assert!(matches!(err, Some(Err(CliProvisionError::Sync { .. }))));
    assert_eq!(events[0].tags["provision_kind"], "sync");
}
