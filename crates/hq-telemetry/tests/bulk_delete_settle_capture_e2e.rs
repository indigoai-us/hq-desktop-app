//! Built-artifact envelope proof for the git-mirror bulk-delete settle window
//! (HQ-DESKTOP-43 `bulk-delete-refused`).
//!
//! The reported defect was a one-way latch: the mirror's bulk-delete circuit
//! breaker refused, reset the index and committed nothing, so the staged
//! deletions that tripped it could never drain — 50 hosts stood wedged 7–16 days,
//! each still billing a confirmed refusal per host. The first fix time-boxed the
//! refusal: a wedge that stands past the settle window over a present, partial
//! tree is committed, and that drain is announced on a NEW, info-level fingerprint
//! (`git_mirror_kind=bulk-delete-accepted`).
//!
//! That fix drained the wedges but left the WARNING firing 5.5 hours too early: a
//! settle-eligible wedge still billed a first-confirmed banner at the 30-minute
//! confirmation gate even though the same build would silently auto-drain it at the
//! 6-hour settle window, so the issue reopened on the first host to cross 30
//! minutes of continuous refusal. This round holds that first banner until the
//! settle window has had its chance: a present, partial wedge inside the window
//! bills ZERO envelopes; a wedge that will never drain (tree absent, or a
//! whole-tree loss) keeps the unchanged 30-minute gate.
//!
//! These tests drive the REAL production decision
//! (`git_mirror::decide_bulk_delete_action`, the REAL `decide_refusal_report` gate
//! with the real settle_hold, and the real reporter functions, reached through the
//! `test-support` seam `drive_bulk_delete_decision_for_test`) through the real
//! `hq_telemetry::before_send` scrubber and assert on the resulting envelopes.
//! What is proven:
//!
//!   Case A — a settled wedge drains: an aged, present, partial wedge bills
//!   exactly ONE envelope, at `level=info`, `git_mirror_kind=bulk-delete-accepted`,
//!   carrying `deletions`, `tracked`, `wedge_age_secs` and `tree_present`, and ZERO
//!   warnings on the HQ-DESKTOP-43 refusal fingerprint.
//!
//!   Case B1 — the reopening shape is now silent: the exact 2026-09-07 field shape
//!   (497 of 3674 deleted, tree present, wedge 63 minutes old, past the 30-minute
//!   gate but short of the 6-hour window) bills ZERO envelopes. On the pre-hold
//!   code it billed one `level=warning` first-confirmed refusal, which is what
//!   reopened the lane, so this is a genuine base-fails/candidate-passes proof.
//!
//!   Case B2 — a wedge that never drains still warns: a young NON-eligible wedge,
//!   in both shapes (tree absent; and deletions == tracked) still bills exactly one
//!   `level=warning` `bulk-delete-refused` envelope at the unchanged gate.
//!
//!   Case C — envelope hygiene: every envelope survives `before_send` with its
//!   tags intact, the two new `tree_present`/`settle_eligible` tags are bare
//!   booleans, and no absolute path, username, or repository content appears.

use std::sync::Arc;

use hq_desktop_core::git_mirror::drive_bulk_delete_decision_for_test;

/// The recorded field shape of the 2026-09-05 MacBookPro event: 13,734 staged
/// deletions of 17,036 tracked files (80.6%), an 8-day durable wedge.
const FIELD_DELETIONS: usize = 13_734;
const FIELD_TRACKED: usize = 17_036;
const EIGHT_DAYS_SECS: u64 = 8 * 24 * 60 * 60;

/// The recorded field shape of the 2026-09-07 event that REOPENED HQ-DESKTOP-43:
/// 497 staged deletions of 3,674 tracked files (13.5%, past the 10% breaker) over
/// a present, only-partially-deleted HQ root, with a durable wedge just 3,813s
/// (63 min) old — cleanly settle-eligible and ~5 hours short of the 6-hour window.
const REOPEN_DELETIONS: usize = 497;
const REOPEN_TRACKED: usize = 3_674;
const REOPEN_WEDGE_SECS: u64 = 3_813;

/// Gate inputs that place a refusal PAST the confirmation gate — at least three
/// sustained passes and at least 30 minutes of continuous episode age — on its
/// FIRST banner, so the only thing left for the reporting gate to decide is the
/// settle-hold. Mirrors `REFUSAL_CONFIRM_OCCURRENCES = 3` and
/// `REFUSAL_CONFIRM_MIN_AGE = 30 min`.
const CONFIRMED_OCC: usize = 3;
const CONFIRMED_EPISODE_SECS: u64 = 31 * 60;
const FIRST_BANNER: usize = 0;

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
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
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
        event.tags["tree_present"], "true",
        "the acceptance carries the shared present/eligible discriminator"
    );
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
fn case_b1_the_reopening_shape_a_young_settle_eligible_wedge_bills_nothing() {
    let records = hq_subtree_records();
    let events = captured(|| {
        // The exact 2026-09-07 reopening event: present, partial, 63 minutes old —
        // past the 30-minute confirmation gate but ~5 hours short of the settle
        // window. Pre-hold this billed one first-confirmed warning; now it is held.
        let kind = drive_bulk_delete_decision_for_test(
            REOPEN_DELETIONS,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            true,
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
        );
        assert_eq!(
            kind, "none",
            "a settle-eligible wedge inside the window bills nothing"
        );
    });

    assert_eq!(
        events.len(),
        0,
        "the reopening event would not have been billed, got: {:?}",
        events
            .iter()
            .map(|e| (e.level, kind(e).map(str::to_string)))
            .collect::<Vec<_>>()
    );
}

#[test]
fn case_b2_a_young_non_eligible_wedge_still_bills_one_warning() {
    let records = hq_subtree_records();

    // Shape one: the tree is gone (a moved HQ root or an unmounted volume). It will
    // never auto-drain, so the unchanged 30-minute gate still bills its warning.
    let tree_absent = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            REOPEN_DELETIONS,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            false,
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
        );
        assert_eq!(
            kind, "bulk-delete-refused",
            "an absent tree never drains, so it still warns at the gate"
        );
    });
    assert_eq!(
        tree_absent.len(),
        1,
        "the absent-tree wedge warns exactly once"
    );
    assert_eq!(tree_absent[0].level, sentry::Level::Warning);
    assert_eq!(kind(&tree_absent[0]), Some("bulk-delete-refused"));
    assert_eq!(tree_absent[0].tags["tree_present"], "false");
    assert_eq!(tree_absent[0].tags["settle_eligible"], "false");

    // Shape two: the whole tree vanished (deletions == tracked). It is present by
    // the directory probe but never partial, so it is never eligible and still
    // warns at the gate.
    let whole_tree = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            100,
            100,
            Some(REOPEN_WEDGE_SECS),
            true,
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
        );
        assert_eq!(
            kind, "bulk-delete-refused",
            "a whole-tree loss never drains, so it still warns at the gate"
        );
    });
    assert_eq!(
        whole_tree.len(),
        1,
        "the whole-tree wedge warns exactly once"
    );
    assert_eq!(whole_tree[0].level, sentry::Level::Warning);
    assert_eq!(kind(&whole_tree[0]), Some("bulk-delete-refused"));
    assert_eq!(whole_tree[0].tags["tree_present"], "true");
    assert_eq!(
        whole_tree[0].tags["settle_eligible"], "false",
        "deletions == tracked is never settle-eligible"
    );
}

#[test]
fn case_c_no_local_detail_survives_scrubbing_and_the_new_tags_are_bools() {
    let records = hq_subtree_records();
    let accepted = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
        );
    });
    // A settle-eligible young wedge is now HELD (Case B1), so drive a NON-eligible
    // one to get a refusal envelope through the scrubber here.
    let refused = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(
            REOPEN_DELETIONS,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            false,
            CONFIRMED_OCC,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
        );
    });

    for (label, events) in [("accepted", accepted), ("refused", refused)] {
        assert_eq!(events.len(), 1, "{label}");
        let event = &events[0];
        // The two new tags are booleans — a count/probe result, never a path.
        for key in ["tree_present", "settle_eligible"] {
            if let Some(v) = event.tags.get(key) {
                assert!(
                    v == "true" || v == "false",
                    "{label}: {key}={v} must be a bare boolean"
                );
            }
        }
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
