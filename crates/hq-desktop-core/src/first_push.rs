use serde::{Deserialize, Serialize};

/// Mirror of `@indigoai-us/hq-cloud`'s `EntityContext` type. We construct
/// this from a `vend_child` result and serialize to JSON for the CLI's
/// `--creds-from-stdin` flag. Field names are camelCase to match the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityContextPayload {
    pub uid: String,
    pub slug: String,
    pub bucket_name: String,
    pub region: String,
    pub credentials: EntityCredentials,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
}

/// One line from the CLI's `--json` stderr stream. We don't strictly model
/// every variant — the parent only cares about `progress`, `complete`, and
/// `fatal`. Other types (`plan`, `conflict`, `error`, future additions) are
/// tolerated and logged but don't drive UI state. Forward-compatibility
/// matters because the CLI ships independently and may add event types.
///
/// `#[serde(flatten)]` on `rest` captures every non-`type` field as a raw
/// JSON map, which we reach into for the specific fields we care about
/// without fragmenting this type into a per-variant enum.
#[derive(Debug, Clone, Deserialize)]
pub struct CliEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The EntityContext payload must serialize with camelCase keys to
    /// match `@indigoai-us/hq-cloud`'s `EntityContext` interface — that's
    /// the cross-language contract the CLI relies on. If this test fails,
    /// `share()` will reject the stdin JSON and first-push will break.
    #[test]
    fn entity_context_serializes_camel_case() {
        let payload = EntityContextPayload {
            uid: "cmp_01H".to_string(),
            slug: "acme".to_string(),
            bucket_name: "hq-vault-cmp-01h".to_string(),
            region: "us-east-1".to_string(),
            credentials: EntityCredentials {
                access_key_id: "ASIA".to_string(),
                secret_access_key: "secret".to_string(),
                session_token: "token".to_string(),
            },
            expires_at: "2026-04-27T22:00:00Z".to_string(),
        };
        let json_str = serde_json::to_string(&payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // Top-level keys: every snake_case field must serialize to camelCase.
        assert_eq!(parsed["uid"], "cmp_01H");
        assert_eq!(parsed["slug"], "acme");
        assert_eq!(parsed["bucketName"], "hq-vault-cmp-01h");
        assert_eq!(parsed["region"], "us-east-1");
        assert_eq!(parsed["expiresAt"], "2026-04-27T22:00:00Z");
        // Nested credentials: same rule.
        assert_eq!(parsed["credentials"]["accessKeyId"], "ASIA");
        assert_eq!(parsed["credentials"]["secretAccessKey"], "secret");
        assert_eq!(parsed["credentials"]["sessionToken"], "token");
        // Anti-test: the snake_case keys must NOT be present (would mean
        // serde rename_all isn't actually applied).
        assert!(parsed.get("bucket_name").is_none());
        assert!(parsed["credentials"].get("access_key_id").is_none());
    }

    /// `complete` event roundtrips into our `CliEvent` decoder and yields
    /// the fields we read (filesUploaded, filesSkipped, aborted). Locks the
    /// CLI ↔ Rust contract for the only event that determines success.
    #[test]
    fn cli_complete_event_round_trip() {
        let line = json!({
            "type": "complete",
            "filesUploaded": 42,
            "bytesUploaded": 12345,
            "filesSkipped": 7,
            "conflictPaths": ["a.md", "b.md"],
            "aborted": false
        })
        .to_string();
        let event: CliEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(event.event_type, "complete");
        assert_eq!(
            event.rest.get("filesUploaded").and_then(|v| v.as_u64()),
            Some(42)
        );
        assert_eq!(
            event.rest.get("filesSkipped").and_then(|v| v.as_u64()),
            Some(7)
        );
        assert_eq!(
            event.rest.get("aborted").and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    /// `progress` event carries the `path` we surface to the UI as
    /// `current_file`. Locks the field name (`path`, not `file` or `key`).
    #[test]
    fn cli_progress_event_round_trip() {
        let line = json!({
            "type": "progress",
            "path": "knowledge/readme.md",
            "bytes": 2048
        })
        .to_string();
        let event: CliEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(event.event_type, "progress");
        assert_eq!(
            event.rest.get("path").and_then(|v| v.as_str()),
            Some("knowledge/readme.md"),
        );
    }

    /// `fatal` carries a `message` we surface as the Err string when the
    /// subprocess exits non-zero. Locks the field name.
    #[test]
    fn cli_fatal_event_round_trip() {
        let line = json!({
            "type": "fatal",
            "message": "vault auth expired mid-run"
        })
        .to_string();
        let event: CliEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(event.event_type, "fatal");
        assert_eq!(
            event.rest.get("message").and_then(|v| v.as_str()),
            Some("vault auth expired mid-run"),
        );
    }

    /// Forward-compat: an unknown event type must parse cleanly so the
    /// stream-reading loop can log-and-continue instead of crashing.
    /// Without this, a future CLI version that adds (say) `{"type":"warn"}`
    /// would silently break first-push for users on older AppBar builds.
    #[test]
    fn cli_unknown_event_type_parses_cleanly() {
        let line = json!({
            "type": "warn",
            "code": "FUTURE_FEATURE",
            "message": "hq-cli vN+1 emits a new event"
        })
        .to_string();
        let event: CliEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(event.event_type, "warn");
        // The unknown fields are captured in `rest` for logging.
        assert!(event.rest.contains_key("code"));
        assert!(event.rest.contains_key("message"));
    }
}
