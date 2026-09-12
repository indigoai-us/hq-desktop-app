//! Built-artifact envelope proof for the git-mirror bulk-delete settle window
//! and its reporter-side settle-hold (HQ-DESKTOP-43 `bulk-delete-refused`).
//!
//! The original defect was a one-way latch: the mirror's bulk-delete circuit
//! breaker refused, reset the index and committed nothing, so the staged
//! deletions that tripped it could never drain — 50 hosts stood wedged 7–16 days,
//! each still billing a confirmed refusal per host. The first fix time-boxed the
//! refusal: a wedge that stands past the settle window over a present, partial
//! tree is committed, and that drain is announced on a NEW, info-level fingerprint
//! (`git_mirror_kind=bulk-delete-accepted`) so it groups separately from the
//! refusal issue and reads as the fix working rather than a new incident.
//!
//! HQ-DESKTOP-43 then REOPENED: the first fix drained real wedges but left the
//! reporting clock untouched, so a settle-eligible wedge still billed its first
//! `bulk-delete-refused` warning at 30 minutes even though the same build would
//! silently auto-commit it ~5.5 hours later. This second fix holds that first
//! banner for exactly the settle-eligible population until the wedge outlives the
//! settle window — so the wedge the build drains itself never warns, and only a
//! drain that fails to happen does.
//!
//! These tests drive the REAL production decision (`decide_bulk_delete_action`,
//! the real reporting gate `decide_refusal_report` WITH its real settle-hold, and
//! the real reporter functions, reached through the `test-support` seam
//! `drive_bulk_delete_decision_for_test`) through the real
//! `hq_telemetry::before_send` scrubber and assert on the resulting envelopes.
//! What is proven:
//!
//!   Case A — a settled wedge drains: an aged, present, partial wedge bills
//!   exactly ONE envelope, at `level=info`, `git_mirror_kind=bulk-delete-accepted`,
//!   carrying `deletions`, `tracked`, `wedge_age_secs` and `tree_present`, and
//!   ZERO warnings on the HQ-DESKTOP-43 refusal fingerprint.
//!
//!   Case B1 — the reopening shape is NOT billed: a confirmed, young,
//!   settle-eligible wedge (the exact 497-of-3674, 63-minute field shape that
//!   reopened the lane) drives the real gate to `await-settle-window` and bills
//!   ZERO envelopes — no refusal warning and no acceptance. On the pre-hold code
//!   this same shape bills one `level=warning` first-confirmed refusal, so this is
//!   a genuine base-fails/candidate-passes proof of the reopen fix.
//!
//!   Case B2 — a wedge that never self-heals still warns: a NON-eligible refusal,
//!   in both its shapes (an absent tree, and a vanished whole tree where
//!   `deletions == tracked`), still bills exactly one `level=warning`
//!   `bulk-delete-refused` envelope at the unchanged 30-minute gate.
//!
//!   Case C — envelope hygiene: every envelope survives `before_send` with its
//!   tags — including the new `tree_present` / `settle_eligible` booleans — intact
//!   and carries no absolute path, username, or repository content. It also feeds
//!   a failed drain, whose error string carries an absolute path, through the real
//!   scrubber and asserts that path never reaches a tag or the serialized event
//!   while `drain_failed` / `drain_failure_class` survive intact.
//!
//!   Case D — a failed drain warns instead of accepting: the same aged, present,
//!   partial wedge whose drain COMMIT fails bills exactly one `level=warning`
//!   `bulk-delete-refused` envelope tagged `drain_failed=true` with a closed
//!   `drain_failure_class`, and ZERO acceptances — while the identical inputs with
//!   the commit succeeding still bill one `level=info` acceptance (case A). This is
//!   the reopen fix's failure path: a drain that does not land escalates, never
//!   silently clears.

use std::sync::Arc;

use hq_desktop_core::git_mirror::drive_bulk_delete_decision_for_test;

/// The recorded field shape of the 2026-09-05 MacBookPro event: 13,734 staged
/// deletions of 17,036 tracked files (80.6%), an 8-day durable wedge.
const FIELD_DELETIONS: usize = 13_734;
const FIELD_TRACKED: usize = 17_036;
const EIGHT_DAYS_SECS: u64 = 8 * 24 * 60 * 60;

/// The recorded field shape of the 2026-09-07 event that REOPENED HQ-DESKTOP-43:
/// 497 staged deletions of 3,674 tracked files (a present, partial tree), a
/// durable wedge only 3,813 s (63 min) old — past the 30-minute confirmation gate
/// but ~5 hours short of the 6-hour settle window it would have drained in.
const REOPEN_DELETIONS: usize = 497;
const REOPEN_TRACKED: usize = 3_674;
const REOPEN_WEDGE_SECS: u64 = 3_813;

/// A confirmed episode: well past the 3-pass floor and the 30-minute continuous
/// window, so the confirmation gate is cleared and only the settle-hold is left to
/// decide the first banner. Matches the reopening event's `episode_occurrences`.
const CONFIRMED_OCCURRENCES: usize = 10;
const CONFIRMED_EPISODE_SECS: u64 = REOPEN_WEDGE_SECS;
/// The wedge has never bannered — this is the moment it would emit its first.
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
            CONFIRMED_OCCURRENCES,
            EIGHT_DAYS_SECS,
            FIRST_BANNER,
            &records,
            false,
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
    // The acceptance carries the same present-tree discriminator the refusal does,
    // so triage can line the two fingerprints up on one axis.
    assert_eq!(event.tags["tree_present"], "true");
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
fn case_b1_the_reopening_shape_is_held_and_bills_nothing() {
    let records = hq_subtree_records();
    let events = captured(|| {
        // The exact field shape that reopened HQ-DESKTOP-43: confirmed, present,
        // partial, and 63 minutes old — settle-eligible and ~5 hours short of the
        // window. The real gate holds the first banner (await-settle-window).
        let kind = drive_bulk_delete_decision_for_test(
            REOPEN_DELETIONS,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
        assert_eq!(
            kind, "none",
            "a confirmed young settle-eligible wedge is held, not billed"
        );
    });

    assert_eq!(
        events.len(),
        0,
        "the reopening shape bills zero envelopes — no warning and no acceptance, got: {:?}",
        events
            .iter()
            .map(|e| (e.level, kind(e).map(str::to_string)))
            .collect::<Vec<_>>()
    );
}

#[test]
fn case_b2_a_wedge_that_never_self_heals_still_bills_one_warning() {
    let records = hq_subtree_records();

    // Shape one: the tree is ABSENT. Never settle-eligible, so the settle-hold
    // never engages and the confirmed refusal bills its one warning at 30 minutes.
    let absent = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            REOPEN_DELETIONS,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            false,
            CONFIRMED_OCCURRENCES,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
        assert_eq!(kind, "bulk-delete-refused", "an absent tree still warns");
    });
    assert_eq!(absent.len(), 1, "an absent-tree wedge bills one warning");
    assert_eq!(absent[0].level, sentry::Level::Warning);
    assert_eq!(kind(&absent[0]), Some("bulk-delete-refused"));
    assert_eq!(absent[0].tags["tree_present"], "false");
    assert_eq!(absent[0].tags["settle_eligible"], "false");

    // Shape two: the WHOLE tree is gone (`deletions == tracked`) — the signature of
    // an unmounted or moved root, never auto-accepted however old, so it too keeps
    // the unchanged gate even with the tree nominally present.
    let whole = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            REOPEN_TRACKED,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
        assert_eq!(
            kind, "bulk-delete-refused",
            "a vanished whole tree still warns"
        );
    });
    assert_eq!(whole.len(), 1, "a whole-tree deletion bills one warning");
    assert_eq!(whole[0].level, sentry::Level::Warning);
    assert_eq!(kind(&whole[0]), Some("bulk-delete-refused"));
    assert_eq!(whole[0].tags["tree_present"], "true");
    assert_eq!(
        whole[0].tags["settle_eligible"], "false",
        "deletions == tracked is not settle-eligible even with the tree present"
    );
}

#[test]
fn case_c_no_local_detail_survives_scrubbing_and_the_new_tags_are_intact() {
    let records = hq_subtree_records();
    let accepted = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            EIGHT_DAYS_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
    });
    // A NON-eligible refusal, so the gate still emits one warning to scrub.
    let refused = captured(|| {
        let _ = drive_bulk_delete_decision_for_test(
            REOPEN_TRACKED,
            REOPEN_TRACKED,
            Some(REOPEN_WEDGE_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            CONFIRMED_EPISODE_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
    });

    // A settled drain whose COMMIT failed: the aged present partial wedge, but
    // reported as a refusal carrying the git error string — which holds an absolute
    // path. The new tags must survive `before_send`; the path must not.
    let failed_drain = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            EIGHT_DAYS_SECS,
            FIRST_BANNER,
            &records,
            true,
        );
        assert_eq!(
            kind, "bulk-delete-refused",
            "a failed drain reports a refusal"
        );
    });
    assert_eq!(failed_drain.len(), 1, "a failed drain bills one envelope");
    assert_eq!(
        failed_drain[0].tags["drain_failed"], "true",
        "the failed-drain discriminator survives scrubbing"
    );
    assert!(
        ["lock", "timeout", "spawn", "exit", "other"]
            .contains(&failed_drain[0].tags["drain_failure_class"].as_str()),
        "drain_failure_class survives as a closed-vocabulary word, got {:?}",
        failed_drain[0].tags.get("drain_failure_class")
    );

    for (label, events) in [
        ("accepted", accepted),
        ("refused", refused),
        ("failed_drain", failed_drain),
    ] {
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
        // The new discriminator tags survive `before_send` with their values
        // intact — a boolean is not scrubbable content, and both fingerprints
        // carry `tree_present`.
        assert_eq!(
            event.tags["tree_present"], "true",
            "{label}: tree_present must survive scrubbing"
        );
        let serialized = serde_json::to_string(event).expect("serialize scrubbed event");
        for needle in ["/Users/", "/home/", "/private/", "/tmp/", "file-0"] {
            assert!(
                !serialized.contains(needle),
                "{label}: local detail ({needle}) leaked into {serialized}"
            );
        }
    }
}

#[test]
fn case_d_a_failed_drain_bills_one_warning_and_zero_acceptances() {
    let records = hq_subtree_records();

    // The aged, present, partial wedge of case A — but the drain's commit failed.
    let failed = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            EIGHT_DAYS_SECS,
            FIRST_BANNER,
            &records,
            true,
        );
        assert_eq!(
            kind, "bulk-delete-refused",
            "a failed drain reports an aged refusal, not an acceptance"
        );
    });

    assert_eq!(
        failed.len(),
        1,
        "a failed drain bills exactly one envelope, got: {:?}",
        failed
            .iter()
            .map(|e| (e.level, kind(e).map(str::to_string)))
            .collect::<Vec<_>>()
    );
    let event = &failed[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(kind(event), Some("bulk-delete-refused"));
    assert_eq!(event.tags["drain_failed"], "true");
    assert!(
        ["lock", "timeout", "spawn", "exit", "other"]
            .contains(&event.tags["drain_failure_class"].as_str()),
        "drain_failure_class is a closed-vocabulary word, got {:?}",
        event.tags.get("drain_failure_class")
    );
    assert_eq!(event.tags["settle_eligible"], "true");
    assert_eq!(event.tags["tree_present"], "true");
    assert_eq!(event.tags["report_source"], "first-confirmed");
    assert_eq!(
        failed
            .iter()
            .filter(|e| kind(e) == Some("bulk-delete-accepted"))
            .count(),
        0,
        "a failed drain bills zero acceptances"
    );

    // The identical inputs, but the commit lands: exactly one info acceptance
    // (case A behaviour, pinned here beside its failure twin).
    let ok = captured(|| {
        let kind = drive_bulk_delete_decision_for_test(
            FIELD_DELETIONS,
            FIELD_TRACKED,
            Some(EIGHT_DAYS_SECS),
            true,
            CONFIRMED_OCCURRENCES,
            EIGHT_DAYS_SECS,
            FIRST_BANNER,
            &records,
            false,
        );
        assert_eq!(kind, "bulk-delete-accepted");
    });
    assert_eq!(ok.len(), 1, "a successful drain bills one acceptance");
    assert_eq!(ok[0].level, sentry::Level::Info);
    assert_eq!(kind(&ok[0]), Some("bulk-delete-accepted"));
}
