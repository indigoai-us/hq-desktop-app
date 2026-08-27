//! Built-artifact envelope proof for the git-mirror index-lock over-reporting
//! cluster (HQ-DESKTOP-5F `index-lock-wedged` + HQ-DESKTOP-5G
//! `index-lock-auto-reaped`).
//!
//! The reported episode was ONE self-healed 32-minute wedge on a single host
//! that nonetheless billed three Sentry events across two unresolved warning
//! issues: two `git_mirror_kind=index-lock-wedged` warnings 2.2s apart within a
//! single mirror pass, plus one `index-lock-auto-reaped` success notice — all at
//! `level=warning`, all carrying `lock_size_bytes=5767168`.
//!
//! These tests drive the REAL production reporting decision
//! (`git_mirror::decide_wedge_report` and the real reporter functions, reached
//! through the `test-support` seam `drive_wedge_report_for_test`) through the
//! real `hq_telemetry::before_send` scrubber and assert on the resulting
//! envelopes. What is proven:
//!
//!   Case A — the reported episode heals: a wedge the escape hatch clears bills
//!   exactly ONE envelope, at `level=info`, `git_mirror_kind=index-lock-auto-reaped`,
//!   with `lock_size_bytes` and `wedged_secs` preserved and ZERO warnings. On the
//!   pre-fix code this same episode billed three envelopes across two warning
//!   levels, so this is a genuine base-fails/candidate-passes proof of the cluster.
//!
//!   Case B — the state that must NOT be traded for silence: an unrecoverable
//!   wedge (backup or removal failed) bills exactly ONE `level=warning`
//!   `index-lock-wedged` envelope with `wedge_reports=0`, and the 2.2s-later
//!   duplicate observation inside the cooldown floor bills nothing more.
//!
//!   Case C — envelope hygiene: both envelopes survive `before_send` with their
//!   tags intact and carry no absolute path, username, or repository content.

use std::sync::Arc;

use hq_desktop_core::git_mirror::{drive_wedge_report_for_test, WedgeRecoveryOutcomeForTest};

/// The reported lock size, byte-for-byte from the cluster.
const REPORTED_LOCK_SIZE: u64 = 5_767_168;
/// The reported wedge duration: 15:18:38 + 1920s = 15:50:38.
const REPORTED_WEDGED_SECS: u64 = 1920;

fn captured(f: impl FnOnce()) -> Vec<sentry::protocol::Event<'static>> {
    sentry::test::with_captured_events_options(
        f,
        sentry::ClientOptions {
            before_send: Some(Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        },
    )
}

fn kind<'a>(event: &'a sentry::protocol::Event<'static>) -> Option<&'a str> {
    event.tags.get("git_mirror_kind").map(String::as_str)
}

#[test]
fn case_a_a_self_healed_wedge_bills_one_info_envelope_and_zero_warnings() {
    // The escape hatch cleared the lock after the hard timeout: the Recovered
    // outcome, having billed no warnings first (reports_so_far = 0).
    let events = captured(|| {
        let _ = drive_wedge_report_for_test(
            0,
            REPORTED_WEDGED_SECS,
            None,
            WedgeRecoveryOutcomeForTest::Recovered,
            REPORTED_LOCK_SIZE,
        );
    });

    assert_eq!(
        events.len(),
        1,
        "a self-healed episode bills exactly one envelope, got: {:?}",
        events
            .iter()
            .map(|e| (e.level, e.message.clone()))
            .collect::<Vec<_>>()
    );
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Info);
    assert_eq!(kind(event), Some("index-lock-auto-reaped"));
    assert_eq!(
        event.tags["lock_size_bytes"],
        REPORTED_LOCK_SIZE.to_string()
    );
    assert_eq!(event.tags["wedged_secs"], REPORTED_WEDGED_SECS.to_string());
    assert_eq!(event.tags["wedge_reports"], "0");
    assert_eq!(
        events
            .iter()
            .filter(|e| kind(e) == Some("index-lock-wedged"))
            .count(),
        0,
        "a self-healed episode must bill zero warnings"
    );
}

#[test]
fn case_b_an_unrecoverable_wedge_warns_once_then_respects_the_cooldown() {
    // First unrecoverable observation past the warn floor: exactly one warning.
    let first = captured(|| {
        let next = drive_wedge_report_for_test(
            0,
            REPORTED_WEDGED_SECS,
            None,
            WedgeRecoveryOutcomeForTest::Failed,
            REPORTED_LOCK_SIZE,
        );
        assert_eq!(
            next, 1,
            "the first unrecoverable observation spends one report"
        );
    });
    assert_eq!(first.len(), 1);
    let warning = &first[0];
    assert_eq!(warning.level, sentry::Level::Warning);
    assert_eq!(kind(warning), Some("index-lock-wedged"));
    assert_eq!(warning.tags["wedge_reports"], "0");
    assert_eq!(warning.tags["source"], "first-confirmed");
    assert_eq!(
        warning.tags["lock_size_bytes"],
        REPORTED_LOCK_SIZE.to_string()
    );

    // A second observation 2 seconds later — the intra-pass duplicate shape — is
    // inside the 6-hour cooldown floor and bills nothing.
    let second = captured(|| {
        let next = drive_wedge_report_for_test(
            1,
            REPORTED_WEDGED_SECS + 2,
            Some(2),
            WedgeRecoveryOutcomeForTest::Failed,
            REPORTED_LOCK_SIZE,
        );
        assert_eq!(next, 1, "a suppressed observation spends nothing");
    });
    assert!(
        second.is_empty(),
        "the 2.2s-later duplicate must be structurally impossible; got {:?}",
        second
            .iter()
            .map(|e| kind(e).map(str::to_string))
            .collect::<Vec<_>>()
    );
}

#[test]
fn case_c_no_local_detail_survives_scrubbing_into_a_wedge_envelope() {
    // The wedge reporters carry only sizes and durations — never an absolute path,
    // a username, or repo content — and the scrubber is the last line of defence.
    // Pin it for both the warning and the recovery envelope.
    let warning = captured(|| {
        let _ = drive_wedge_report_for_test(
            0,
            REPORTED_WEDGED_SECS,
            None,
            WedgeRecoveryOutcomeForTest::Failed,
            REPORTED_LOCK_SIZE,
        );
    });
    let info = captured(|| {
        let _ = drive_wedge_report_for_test(
            0,
            REPORTED_WEDGED_SECS,
            None,
            WedgeRecoveryOutcomeForTest::Recovered,
            REPORTED_LOCK_SIZE,
        );
    });

    for (label, events) in [("warning", warning), ("info", info)] {
        assert_eq!(events.len(), 1, "{label}");
        let event = &events[0];
        // Every tag this path sets is a size, a duration, a count, or a fixed
        // enum — none carries a path or anything user-owned.
        for (k, v) in event.tags.iter() {
            assert!(
                !v.contains('/'),
                "{label}: tag {k}={v} must not carry a path"
            );
        }
        let serialized = serde_json::to_string(event).expect("serialize scrubbed event");
        for needle in ["/Users/", "/home/", "/private/", "/tmp/"] {
            assert!(
                !serialized.contains(needle),
                "{label}: an absolute path ({needle}) leaked into {serialized}"
            );
        }
    }
}
