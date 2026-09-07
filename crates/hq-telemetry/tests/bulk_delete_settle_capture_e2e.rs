//! Built-artifact envelope proof for the git-mirror bulk-delete settle window
//! (HQ-DESKTOP-43 `bulk-delete-refused`).
//!
//! The reported defect was a one-way latch: the mirror's bulk-delete circuit
//! breaker refused, reset the index and committed nothing, so the staged
//! deletions that tripped it could never drain — 50 hosts stood wedged 7–16 days,
//! each still billing a confirmed refusal per host. The fix time-boxes the
//! refusal: a wedge that stands past the settle window over a present, partial
//! tree is committed, and that drain is announced on a NEW, info-level fingerprint
//! (`git_mirror_kind=bulk-delete-accepted`) so it groups separately from the
//! refusal issue and reads as the fix working rather than a new incident.
//!
//! These tests drive the REAL production decision
//! (`git_mirror::decide_bulk_delete_action` and the real reporter functions,
//! reached through the `test-support` seam `drive_bulk_delete_decision_for_test`)
//! through the real `hq_telemetry::before_send` scrubber and assert on the
//! resulting envelopes. What is proven:
//!
//!   Case A — a settled wedge drains: an aged, present, partial wedge bills
//!   exactly ONE envelope, at `level=info`, `git_mirror_kind=bulk-delete-accepted`,
//!   carrying `deletions`, `tracked` and `wedge_age_secs`, and ZERO warnings on
//!   the HQ-DESKTOP-43 refusal fingerprint. On the pre-fix code this decision does
//!   not exist, so this is a genuine base-fails/candidate-passes proof.
//!
//!   Case B — the young case is unchanged: a wedge younger than the settle window
//!   still bills exactly one `level=warning` `bulk-delete-refused` envelope and no
//!   acceptance.
//!
//!   Case C — envelope hygiene: both envelopes survive `before_send` with their
//!   tags intact and carry no absolute path, username, or repository content.

use std::sync::Arc;

use hq_desktop_core::git_mirror::drive_bulk_delete_decision_for_test;

/// The recorded field shape of the 2026-09-05 MacBookPro event: 13,734 staged
/// deletions of 17,036 tracked files (80.6%), an 8-day durable wedge.
const FIELD_DELETIONS: usize = 13_734;
const FIELD_TRACKED: usize = 17_036;
const EIGHT_DAYS_SECS: u64 = 8 * 24 * 60 * 60;

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

/// NUL-terminated Git path records over HQ's own machine-managed subtrees, the
/// same shape the field histogram carries. Depth-1 prefixes only ever reduce to
/// the subtree name, never a file name.
fn hq_subtree_records() -> Vec<u8> {
    let mut out = Vec::new();
    for path in [
        "core/scripts/a.sh",
        "core/policies/b.md",
        "workspace/tmp/c.json",
        "personal/projects/d.md",
        ".claude/settings.json",
    ] {
        out.extend_from_slice(path.as_bytes());
        out.push(0);
    }
    out
}

#[test]
fn case_a_a_settled_wedge_bills_one_info_acceptance_and_zero_warnings() {
    let records = hq_subtree_records();
    let events = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            &records,
        );
        assert_eq!(
            kind, "bulk-delete-accepted",
            "an aged present partial wedge is accepted"
        );
    });

    assert_eq!(
        events.len(),
        1,
        "a settled acceptance bills exactly one envelope, got: {:?}",
        events
            .iter()
            .map(|e| (e.level, e.message.clone()))
            .collect::<Vec<_>>()
    );
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Info);
    assert_eq!(kind(event), Some("bulk-delete-accepted"));
    assert_eq!(event.tags["deletions"], FIELD_DELETIONS.to_string());
    assert_eq!(event.tags["tracked"], FIELD_TRACKED.to_string());
    assert_eq!(event.tags["wedge_age_secs"], EIGHT_DAYS_SECS.to_string());
    assert_eq!(
        events
            .iter()
            .filter(|e| kind(e) == Some("bulk-delete-refused"))
            .count(),
        0,
        "a settled acceptance must bill zero refusal warnings"
    );
}

#[test]
fn case_b_a_young_wedge_still_bills_one_refusal_warning() {
    let records = hq_subtree_records();
    let events = captured(|| {
        // One hour old — well short of the six-hour settle window.
        let kind = drive_bulk_delete_decision_for_test(60, 100, Some(60 * 60), true, &records);
        assert_eq!(kind, "bulk-delete-refused", "a young wedge still refuses");
    });

    assert_eq!(
        events.len(),
        1,
        "a young wedge bills exactly one refusal warning"
    );
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(kind(event), Some("bulk-delete-refused"));
    assert_eq!(event.tags["deletions"], "60");
    assert_eq!(event.tags["tracked"], "100");
    assert_eq!(
        events
            .iter()
            .filter(|e| kind(e) == Some("bulk-delete-accepted"))
            .count(),
        0,
        "a young wedge is never accepted"
    );
}

#[test]
fn case_c_no_local_detail_survives_scrubbing_into_either_envelope() {
    let records = hq_subtree_records();
    let accepted = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            &records,
        );
    });
    let refused = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(60, 100, Some(60 * 60), true, &records);
    });

    for (label, events) in [("accepted", accepted), ("refused", refused)] {
        assert_eq!(events.len(), 1, "{label}");
        let event = &events[0];
        // Every tag this path sets is a count, a duration, a bool, or a fixed
        // enum — none carries a path or anything user-owned.
        for (k, v) in event.tags.iter() {
            assert!(
                !v.contains('/'),
                "{label}: tag {k}={v} must not carry a path"
            );
        }
        let serialized = serde_json::to_string(event).expect("serialize scrubbed event");
        for needle in ["/Users/", "/home/", "/private/", "/tmp/", "file-0"] {
            assert!(
                !serialized.contains(needle),
                "{label}: local detail ({needle}) leaked into {serialized}"
            );
        }
    }
}
