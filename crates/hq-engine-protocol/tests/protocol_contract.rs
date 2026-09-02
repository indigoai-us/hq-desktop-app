use hq_engine_protocol::{
    decode_request_line, encode_response_line, method, EnvelopeKind, EventSequencer,
    ResponseEnvelope, PROTOCOL_VERSION,
};
use serde_json::json;

#[test]
fn decodes_a_valid_versioned_request() {
    let request = decode_request_line(
        r#"{"protocolVersion":1,"id":"request-7","method":"health","params":{}}"#,
    )
    .expect("valid request");

    assert_eq!(request.protocol_version, PROTOCOL_VERSION);
    assert_eq!(request.id, "request-7");
    assert_eq!(request.method, "health");
}

#[test]
fn rejects_wrong_protocol_version_with_a_stable_error_code() {
    let error = decode_request_line(
        r#"{"protocolVersion":99,"id":"request-8","method":"health","params":{}}"#,
    )
    .expect_err("unsupported protocol must fail");

    assert_eq!(error.code, "unsupported_protocol_version");
}

#[test]
fn rejects_blank_request_ids_and_methods() {
    for line in [
        r#"{"protocolVersion":1,"id":" ","method":"health","params":{}}"#,
        r#"{"protocolVersion":1,"id":"request-9","method":"","params":{}}"#,
    ] {
        let error = decode_request_line(line).expect_err("invalid request must fail");
        assert_eq!(error.code, "invalid_request");
    }
}

#[test]
fn response_encoding_is_one_compact_ndjson_frame() {
    let response = ResponseEnvelope::result("request-10", json!({"message": "line one\nline two"}));
    let encoded = encode_response_line(&response).expect("response encodes");

    assert!(encoded.ends_with('\n'));
    assert_eq!(encoded.matches('\n').count(), 1);
    assert!(!encoded.contains("line one\nline two"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(encoded.trim_end()).unwrap(),
        json!({
            "protocolVersion": 1,
            "id": "request-10",
            "kind": "result",
            "sequence": null,
            "result": {"message": "line one\nline two"},
            "error": null,
            "event": null,
            "data": null
        })
    );
}

#[test]
fn event_sequences_are_strictly_monotonic() {
    let sequencer = EventSequencer::default();
    let first = sequencer.next(
        Some("sync-1".to_string()),
        "sync:changed",
        json!({"state": "syncing"}),
    );
    let second = sequencer.next(
        Some("sync-1".to_string()),
        "sync:changed",
        json!({"state": "idle"}),
    );

    let sequence = |envelope: ResponseEnvelope| {
        assert_eq!(envelope.kind, EnvelopeKind::Event);
        envelope.sequence.expect("event sequence")
    };

    assert_eq!(sequence(first), 1);
    assert_eq!(sequence(second), 2);
    assert_eq!(sequencer.current(), 2);
}

#[test]
fn startup_handshake_matches_the_swift_contract() {
    let handshake = ResponseEnvelope::handshake(
        "0.1.0",
        "0.10.21",
        vec!["health".into(), "workspaces.list".into()],
    );
    let value = serde_json::to_value(handshake).unwrap();

    assert_eq!(
        value,
        json!({
            "protocolVersion": 1,
            "id": null,
            "kind": "handshake",
            "sequence": 0,
            "result": {
                "engineVersion": "0.1.0",
                "applicationVersion": "0.10.21",
                "capabilities": ["health", "workspaces.list"]
            },
            "error": null,
            "event": null,
            "data": null
        })
    );
}

#[test]
fn upstream_reauth_workspace_and_pending_target_methods_are_versioned_contracts() {
    assert_eq!(method::BEGIN_REAUTH, "begin_reauth");
    assert_eq!(
        method::SET_WORKSPACE_SYNC_ENABLED,
        "set_workspace_sync_enabled"
    );
    assert_eq!(
        method::TAKE_PENDING_MESSAGES_TARGET,
        "take_pending_messages_target"
    );
}
