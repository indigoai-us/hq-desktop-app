//! US-016 story acceptance tests — "Own calls in a dedicated native window".
//!
//! Story-level regression cover for the three PRD e2e statements on the native
//! side. Where `calls.rs`'s own unit tests pin each seam in isolation, these
//! walk whole story sequences end to end (open → mount → live call → main
//! window churn → close / quit → next launch) through the pure seams only: no
//! `AppHandle`, no webview, no real windows.
//!
//! NOTE on e2e statement 1: real cross-window media continuity is a property of
//! the call living in its own OS window process and is certified by the native
//! harness in US-031. What is regression-testable here is the registry
//! invariant that makes it possible — only the `call` label owns a call entry,
//! so no amount of main-window close or navigation can tear one down.

use super::calls::*;

fn target(session: &str) -> CallWindowTarget {
    CallWindowTarget {
        session_id: session.to_string(),
        company_uid: "cmp-indigo".to_string(),
        room_id: "room-1".to_string(),
        call_id: "call-1".to_string(),
        epoch: 7,
        self_: CallSelfTarget {
            person_uid: "prs-1".to_string(),
            device_id: "dev-1".to_string(),
        },
        knock: None,
    }
}

/// A unique scratch directory per test, so the suite stays parallel-safe.
fn scratch(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "hq-calls-story-{name}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

// ── e2e 1: the call outlives Desktop navigation and close ────────────────────

#[test]
fn story_main_window_close_and_navigation_never_touch_a_live_call() {
    let mut registry = CallRegistry::default();
    let live = target("cmp-indigo:room-1:call-1:7");
    registry.arm(live.clone());
    assert_eq!(registry.take_pending(), Some(live.clone()));
    assert!(registry.mark_ready(&live.session_id));

    // Every Desktop window label that can close or navigate while a call runs.
    for label in [
        "main",
        "desktop-alt",
        "meetings-window",
        "communications",
        "widget",
        "detail-dm-1",
        "",
        "CALL",
    ] {
        assert!(
            !owns_window_label(label),
            "{label} must never own the call registry"
        );
        // This is the exact guard the window-event handler applies.
        if owns_window_label(label) {
            registry.release(&live.session_id);
        }
    }

    assert_eq!(
        registry.active_session_ids(),
        vec![live.session_id.clone()],
        "the call entry survives all main-window lifecycle traffic"
    );
    assert!(registry.is_ready(&live.session_id));

    // Only the call window's own destruction ends it.
    assert!(owns_window_label(CALL_WINDOW_LABEL));
    assert!(registry.release(&live.session_id));
    assert!(registry.is_empty());
}

// ── e2e 2: exactly one authorized target, and duplicate opens focus ──────────

#[test]
fn story_cold_open_hands_the_window_exactly_one_target_then_focuses_duplicates() {
    let mut registry = CallRegistry::default();
    let call = target("cmp-indigo:room-1:call-1:7");

    // Cold: no window yet.
    assert_eq!(registry.decide_open(false, &call), OpenDecision::Cold);
    registry.arm(call.clone());

    // A duplicate open arriving before the mount acknowledges re-arms pending
    // rather than emitting into a webview that cannot hear it yet.
    assert_eq!(registry.decide_open(true, &call), OpenDecision::Cold);
    registry.arm(call.clone());

    // The mount drains exactly one target, then acknowledges.
    assert_eq!(registry.take_pending(), Some(call.clone()));
    assert_eq!(registry.take_pending(), None, "drained exactly once");
    assert!(registry.mark_ready(&call.session_id));

    // Now a duplicate open is a focus — never a second window, never a re-join.
    assert_eq!(registry.decide_open(true, &call), OpenDecision::Focus);
    assert_eq!(registry.decide_open(true, &call), OpenDecision::Focus);
    assert_eq!(registry.take_pending(), None, "focus arms nothing");
}

#[test]
fn story_warm_open_reuses_a_free_window_and_a_rival_call_is_refused() {
    let mut registry = CallRegistry::default();
    let first = target("cmp-indigo:room-1:call-1:7");
    let second = target("cmp-indigo:room-2:call-2:1");

    registry.arm(first.clone());
    let _ = registry.take_pending();
    registry.mark_ready(&first.session_id);

    // Authorization path: a different call cannot take a live window.
    assert_eq!(registry.decide_open(true, &second), OpenDecision::Conflict);
    assert_eq!(CALL_ACTIVE, "CALL_ACTIVE");
    assert_eq!(
        registry.active_session_ids(),
        vec![first.session_id.clone()]
    );

    // Once the first call leaves, the surviving window is warmed, not rebuilt.
    assert!(registry.release(&first.session_id));
    assert_eq!(registry.decide_open(true, &second), OpenDecision::Warm);
    registry.arm(second.clone());
    assert_eq!(registry.take_pending(), Some(second.clone()));
    assert!(registry.mark_ready(&second.session_id));
    assert!(!registry.mark_ready("cmp-indigo:room-9:call-9:9"));
}

#[test]
fn story_no_target_reaching_the_window_ever_carries_credential_material() {
    let clean = target("cmp-indigo:room-1:call-1:7");
    assert!(validate_target(&clean).is_ok());
    let serialized = serde_json::to_value(&clean).unwrap();
    assert!(json_has_no_credential_fields(&serialized));

    // US-018 left the target with no free-form JSON at all: there is nowhere
    // for a credential to hide any more. The recursive scan still guards every
    // serialized target, so it is pinned on the shapes it must refuse.
    for poison in [
        serde_json::json!({ "token": "hq-pro-bearer" }),
        serde_json::json!({ "nested": { "API-Key": "x" } }),
        serde_json::json!({ "list": [{ "authorization": "Bearer x" }] }),
        serde_json::json!({ "deep": { "list": [{ "Secret": "x" }] } }),
        serde_json::json!({ "Bearer": "x" }),
        serde_json::json!({ "pass-word": "x", "password": "x" }),
    ] {
        assert!(
            !json_has_no_credential_fields(&poison),
            "credential-shaped json must be refused"
        );
    }
    // A knocked target is still just ids — and still credential-free.
    let mut knocked = clean.clone();
    knocked.knock = Some(CallKnockTarget {
        knock_id: "knk-1".to_string(),
        capability_id: "cap-1".to_string(),
    });
    assert!(validate_target(&knocked).is_ok());
    assert!(json_has_no_credential_fields(
        &serde_json::to_value(&knocked).unwrap()
    ));

    // And a target can never smuggle a path, query or space into the URL.
    let mutations: [(&str, fn(&mut CallWindowTarget)); 3] = [
        ("room", |t| t.room_id = "../escape".to_string()),
        ("session", |t| t.session_id = "a b:c:d:1".to_string()),
        ("call", |t| t.call_id = "call?x=1".to_string()),
    ];
    for (label, mutate) in mutations {
        let mut bad = clean.clone();
        mutate(&mut bad);
        assert!(validate_target(&bad).is_err(), "{label} must be refused");
    }
}

// ── e2e 3: shutdown releases devices, durable work recovers ──────────────────

#[test]
fn story_app_quit_waits_for_every_active_session_then_clears_the_registry() {
    let mut registry = CallRegistry::default();
    let call = target("cmp-indigo:room-1:call-1:7");
    registry.arm(call.clone());
    let _ = registry.take_pending();
    registry.mark_ready(&call.session_id);

    // Quit asks, and waits: nothing is disposed until the window says so.
    assert!(!registry.all_disposed());
    registry.note_disposed("cmp-indigo:room-9:call-9:9");
    assert!(
        !registry.all_disposed(),
        "an unrelated ack must not satisfy the handshake"
    );
    registry.note_disposed(&call.session_id);
    registry.note_disposed(&call.session_id);
    assert!(registry.all_disposed(), "acks are idempotent");

    // Quit then clears whatever it asked about, answered or not.
    for session_id in registry.active_session_ids() {
        registry.release(&session_id);
    }
    assert!(registry.is_empty());
    assert!(
        registry.all_disposed(),
        "an empty registry is trivially done"
    );
    assert!(DISPOSE_WAIT.as_millis() > 0, "quit waits, bounded");
}

#[test]
fn story_pending_transcript_work_survives_a_quit_and_recovers_once() {
    let dir = scratch("recover");
    let state = serde_json::json!({
        "version": 1,
        "sessionId": "cmp-indigo:room-1:call-1:7",
        "binding": {
            "companyUid": "cmp-indigo",
            "roomId": "room-1",
            "callId": "call-1",
            "epoch": 7,
        },
        "pendingCompletion": serde_json::Value::Null,
    });

    // Leaving the call persists before the window goes away…
    persist_pending_at(&dir, "cmp-indigo:room-1:call-1:7", &state).unwrap();
    // …and a later leave overwrites rather than accumulating.
    persist_pending_at(&dir, "cmp-indigo:room-1:call-1:7", &state).unwrap();

    // The next launch drains it exactly once.
    let recovered = take_recovered_at(&dir).expect("the next launch recovers it");
    assert_eq!(
        recovered.get("sessionId").and_then(|v| v.as_str()),
        Some("cmp-indigo:room-1:call-1:7")
    );
    assert_eq!(recovered.get("state"), Some(&state));
    assert!(json_has_no_credential_fields(&recovered));
    assert!(
        take_recovered_at(&dir).is_none(),
        "a second launch must not replay it"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn story_durable_work_refuses_oversized_or_credential_bearing_state() {
    let dir = scratch("refused");

    let huge = serde_json::json!({ "blob": "x".repeat(MAX_PENDING_BYTES + 1) });
    assert!(persist_pending_at(&dir, "s-1", &huge).is_err());

    for secret in [
        serde_json::json!({ "authorization": "Bearer x" }),
        serde_json::json!({ "pendingCompletion": { "api_key": "x" } }),
    ] {
        assert!(persist_pending_at(&dir, "s-1", &secret).is_err());
    }

    // A malformed session id never becomes a path.
    let ok = serde_json::json!({ "version": 1 });
    assert!(persist_pending_at(&dir, "../escape", &ok).is_err());

    assert!(
        take_recovered_at(&dir).is_none(),
        "nothing refused was ever written"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
