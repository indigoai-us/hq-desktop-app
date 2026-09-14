//! Built-artifact envelope proof for HQ-DESKTOP-6A (the exit-2 twin of the
//! HQ-DESKTOP-68/69 exit-1 fix in `provision_exit1_no_output_capture_e2e.rs`).
//!
//! The reported Sentry event was
//!
//! ```text
//! [provision-cli] validation error from `hq cloud provision`: exit 2 \
//!   (validation) — see ~/.hq/logs/hq-sync.log [provision-cli] for slug=seo-brand
//! ```
//!
//! captured at `level=error` with `provision_kind=validation`, NO fingerprint,
//! and NO `validation_kind` tag — so the desktop app's `hq cloud provision`
//! runner minted a fresh error-level HQ-DESKTOP issue for every company slug
//! that hit an exit-2 setup failure (chiefly a resolved HQ root with no
//! `companies/manifest.yaml`). These are user-laptop / setup problems, not
//! platform errors.
//!
//! These tests drive the real production decision
//! (`run_cli_provision::finish_child_exit`, through its `test-support` seam)
//! and the real `hq_telemetry::before_send` scrubber, then assert on the
//! envelopes. On the candidate:
//!
//!   1. The reported manifest-missing input is subclassed
//!      (`validation_kind=manifest-missing`), captured at `level=Warning`, and
//!      fingerprinted `["provision-cli","validation","manifest-missing"]` so the
//!      per-slug proliferation collapses into one issue. The IPC message text is
//!      byte-for-byte unchanged (the frontend contract depends on it), but the
//!      per-slug ERROR incident is gone.
//!   2. Every setup-incomplete subclass is a Warning with its own fingerprint,
//!      while a genuinely unexpected validation message stays `unclassified` at
//!      `level=Error` so a real CLI validation regression is still visible.
//!   3. No user filesystem path leaks into a tag or the message — the resolved
//!      manifest path rides only inside the scrubbed `stderr_tail` extra.
//!
//! The discriminating assertions (validation_kind tag, Warning level, collapsing
//! fingerprint) FAIL on the pre-fix base — which produced the per-slug title at
//! error level with no fingerprint and no subclass tag — and PASS on the
//! candidate, so this is a real base-fails/candidate-passes proof.

use std::sync::Arc;

use hq_desktop_core::hq_resolver::HqInvocation;
use hq_desktop_core::run_cli_provision::{
    finish_child_exit_for_test, ChildOutput, CliProvisionError, ReaderOutcome,
};

/// The exact reported per-slug title (the capture-site message). Its `Display`
/// half is deliberately UNCHANGED by the fix, so this string is present on both
/// base and candidate — what changes is the level (Error -> Warning) and the
/// grouping (none -> collapsing fingerprint). Locking it here proves the IPC
/// contract text did not drift.
const REPORTED_TITLE: &str = "[provision-cli] validation error from \
     `hq cloud provision`: exit 2 (validation) — see ~/.hq/logs/hq-sync.log \
     [provision-cli] for slug=seo-brand";

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
    let stderr_tail: Vec<String> = stderr_tail.into_iter().map(String::from).collect();
    let stderr_had_nonblank = stderr_tail.iter().any(|l| !l.trim().is_empty());
    let stderr_line_count = stderr_tail.len();
    ChildOutput {
        stdout_lines,
        stdout_tail,
        stderr_tail,
        stdout_reader: ReaderOutcome::Eof,
        stderr_reader: ReaderOutcome::Eof,
        stderr_line_count,
        stderr_had_nonblank,
    }
}

/// THE regression: the reported machine can no longer mint a fresh per-slug
/// error incident for an exit-2 setup failure — it is a subclassed, collapsed
/// Warning, with no user path in any tag or the message.
#[test]
fn the_reported_exit2_manifest_missing_is_a_collapsed_warning() {
    // The reported 6A/6B stderr line, carrying the user's real manifest path.
    let stderr = "[hq cloud provision] companies/manifest.yaml not found at \
         /Users/isa/hq/companies/manifest.yaml";
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "seo-brand",
            &HqInvocation::Npx,
            Some(2),
            output(vec![], vec![stderr]),
            300,
            None,
            None,
        ));
    });

    assert!(matches!(
        err,
        Some(Err(CliProvisionError::Validation { .. }))
    ));
    assert_eq!(events.len(), 1);
    let event = &events[0];

    // Provision kind unchanged; the new subclass tag is present.
    assert_eq!(event.tags["provision_kind"], "validation");
    assert_eq!(event.tags["validation_kind"], "manifest-missing");
    assert_eq!(event.tags["slug"], "seo-brand");
    assert_eq!(event.tags["exit_code"], "2");

    // The defect was "reported as errors" — this is now a Warning.
    assert_eq!(event.level, sentry::Level::Warning);

    // Per-slug proliferation collapses into one issue per subclass.
    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
    assert_eq!(fingerprint, ["provision-cli", "validation", "manifest-missing"]);

    // The IPC message text is unchanged (present on base too), so the frontend
    // contract does not drift — only the level and grouping changed.
    let message = event.message.as_deref().expect("event carries a message");
    assert_eq!(message, REPORTED_TITLE);

    // No user filesystem path may survive into the message or any tag; the raw
    // manifest path must NOT be in the message (it rides only in the extra).
    assert!(
        !message.contains("/Users/") && !message.contains("/home/"),
        "{message}"
    );
    assert!(!message.contains("manifest.yaml"), "{message}");
    for (key, value) in event.tags.iter() {
        assert!(
            !value.contains("/Users/") && !value.contains("/home/"),
            "tag {key}={value} leaked a path"
        );
    }

    // The manifest path survives only inside the scrubbed stderr_tail extra:
    // the account name is redacted, the rest of the evidence remains.
    let stderr_extra = event.extra["stderr_tail"].as_str().expect("stderr_tail");
    assert!(
        stderr_extra.contains("companies/manifest.yaml not found"),
        "{stderr_extra}"
    );
    assert!(
        stderr_extra.contains("/Users/[user]/hq/companies/manifest.yaml"),
        "scrubber must redact the account: {stderr_extra}"
    );
    assert!(!stderr_extra.contains("isa"), "{stderr_extra}");
}

/// Every setup-incomplete subclass is a Warning with its own collapsing
/// fingerprint — so the subclasses stay separate issues while per-slug
/// proliferation stops.
#[test]
fn each_setup_subclass_is_a_warning_with_its_own_fingerprint() {
    let cases = [
        (
            "[hq cloud provision] companies/manifest.yaml not found at /Users/isa/hq/companies/manifest.yaml",
            "manifest-missing",
        ),
        (
            "[hq cloud provision] manifest.yaml is malformed: could not parse YAML",
            "manifest-malformed",
        ),
        (
            "[hq cloud provision] slug `seo-brand` not found under `.companies` in manifest",
            "slug-not-in-manifest",
        ),
        (
            "[hq cloud provision] company directory companies/seo-brand does not exist",
            "company-dir-missing",
        ),
        (
            "[hq cloud provision] company seo-brand status=archived; refusing to provision",
            "archived",
        ),
    ];

    for (stderr, expected_kind) in cases {
        let events = captured(|| {
            let _ = finish_child_exit_for_test(
                "seo-brand",
                &HqInvocation::Npx,
                Some(2),
                output(vec![], vec![stderr]),
                300,
                None,
                None,
            );
        });
        assert_eq!(events.len(), 1, "kind {expected_kind}");
        let event = &events[0];
        assert_eq!(event.tags["provision_kind"], "validation", "{expected_kind}");
        assert_eq!(event.tags["validation_kind"], expected_kind);
        assert_eq!(event.level, sentry::Level::Warning, "{expected_kind}");
        let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
        assert_eq!(
            fingerprint,
            ["provision-cli", "validation", expected_kind],
            "{expected_kind}"
        );
    }
}

/// A genuinely unexpected validation message is NOT a known setup subclass, so
/// it stays `unclassified` at Error level — a real CLI validation regression
/// must remain visible on error dashboards — but it is still grouped by
/// fingerprint so it can't proliferate per-slug either.
#[test]
fn an_unclassified_exit2_stays_error_for_visibility() {
    let events = captured(|| {
        let _ = finish_child_exit_for_test(
            "seo-brand",
            &HqInvocation::Npx,
            Some(2),
            output(
                vec![],
                vec!["[hq cloud provision] slug must match ^[a-z][a-z0-9-]*$"],
            ),
            300,
            None,
            None,
        );
    });
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.tags["provision_kind"], "validation");
    assert_eq!(event.tags["validation_kind"], "unclassified");
    assert_eq!(event.level, sentry::Level::Error);
    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
    assert_eq!(fingerprint, ["provision-cli", "validation", "unclassified"]);
}

/// Controls-unchanged: a real vault 5xx (exit 1) still reports as `network` at
/// Error with no validation_kind tag — the vault-incident alert keyed on
/// `provision_kind=network` must not regress from the exit-2 change.
#[test]
fn a_vault_exit1_control_is_untouched_by_the_exit2_change() {
    let mut err = None;
    let events = captured(|| {
        err = Some(finish_child_exit_for_test(
            "seo-brand",
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
    assert_eq!(event.level, sentry::Level::Error);
    assert!(!event.tags.contains_key("validation_kind"));
    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
    assert!(!fingerprint.contains(&"validation"), "{fingerprint:?}");
}
