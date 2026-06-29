use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::{AgentOrigin, AgentSession};

/// AWS service name for the IoT MQTT broker SigV4 signature. Fixed by AWS.
const IOT_SERVICE: &str = "iotdevicegateway";
/// Presigned-WSS validity (mirrors `dm_mqtt::PRESIGN_EXPIRES`).
const PRESIGN_EXPIRES: Duration = Duration::from_secs(3600);

/// How long an outpost heartbeat is trusted before its sessions are dropped.
pub const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(90);

/// The desktop-facing outpost box status that heads the outpost group
/// (design.md "Outpost status card (US-011)").
///
/// A normalised projection of the hq-pro `StatusResponse` — the card only needs
/// up/down, runtime, relay, and an `ip · region` line, plus a last-seen relative
/// (driven by the heartbeat freshness, not a server field). camelCase on the
/// wire so the Svelte card reads it without remapping, matching the rest of the
/// sessions contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutpostStatus {
    /// Whether the box reads as up (provisioned, instance running). Drives the
    /// green-vs-red card. Best-effort: see [`derive_box_up`].
    pub up: bool,
    /// The agent runtime the box runs (`claude` / `codex`), surfaced as RUNTIME.
    pub runtime: String,
    /// Whether the relay reads as connected (the RELAY stat: green connected /
    /// red disconnected). For codex boxes this tracks the codex relay state; for
    /// claude boxes a ready+running box is treated as connected.
    pub relay_connected: bool,
    /// `ip · region` meta line. Either half may be empty when the row omits it.
    pub ip: String,
    pub region: String,
    /// ISO-8601 of the most recent heartbeat we received (the LAST SEEN stat).
    /// Empty when we have never received a beat. Set by the store, not the
    /// status fetch, so "last seen" reflects actual per-session reporting.
    pub last_seen_at: String,
    /// `true` once the heartbeat has gone stale past [`HEARTBEAT_STALE_AFTER`] —
    /// the card then renders its down/last-seen treatment and the stale-sessions
    /// note even if `/outpost/status` still says the box exists.
    pub stale: bool,
}

impl OutpostStatus {
    /// A status for "no outpost configured / never seen" — the card renders a
    /// neutral down state. Used as the default when `/outpost/status` 404s (no
    /// box) or has never succeeded.
    pub fn unknown() -> Self {
        OutpostStatus {
            up: false,
            runtime: String::new(),
            relay_connected: false,
            ip: String::new(),
            region: String::new(),
            last_seen_at: String::new(),
            stale: false,
        }
    }
}

/// The raw `GET /outpost/status` response — only the fields the box card needs.
/// Extra fields on the wire are ignored (serde default). Mirrors hq-pro's
/// `StatusResponse` (`src/outpost/types.ts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawOutpostStatus {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub instance_state: String,
    #[serde(default)]
    pub agent_runtime: String,
    #[serde(default)]
    pub static_ip: String,
    #[serde(default)]
    pub region: String,
    /// Derived codex sub-state (`connected` / `awaiting-login` / `disabled` / …).
    #[serde(default)]
    pub codex_state: String,
    /// Raw relay-state passthrough (`connected` / `error` / …), codex rows only.
    #[serde(default)]
    pub codex_relay_status: String,
}

/// Whether the box reads as UP from a raw status (pure, testable).
///
/// The brainstorm caveat (companies/indigo/.../outpost-ready-state-is-stale-auth-flag.md)
/// is that `state: "ready"` is a stale boot flag, not live health — so we require
/// BOTH the provisioning `state` to be `ready` AND the live `instanceState` to be
/// `running`. A box that is provisioning/bootstrapping/failed, or whose instance
/// isn't running, reads down.
pub fn derive_box_up(raw: &RawOutpostStatus) -> bool {
    raw.state == "ready" && raw.instance_state == "running"
}

/// Whether the relay reads as connected from a raw status (pure, testable).
///
/// For a codex runtime, the relay is the codex remote-control channel — connected
/// iff the derived `codexState` (or the raw relay status) is `connected`. For a
/// claude runtime there is no separate relay, so an up box is treated as
/// connected and a down box as disconnected.
pub fn derive_relay_connected(raw: &RawOutpostStatus) -> bool {
    let is_codex = raw.agent_runtime == "codex"
        || !raw.codex_state.is_empty()
        || !raw.codex_relay_status.is_empty();
    if is_codex {
        raw.codex_state == "connected" || raw.codex_relay_status == "connected"
    } else {
        derive_box_up(raw)
    }
}

/// Project a raw `/outpost/status` response onto the desktop [`OutpostStatus`]
/// card shape (pure over its input; `last_seen_at`/`stale` are filled in by the
/// store from heartbeat freshness, not here).
pub fn project_status(raw: &RawOutpostStatus) -> OutpostStatus {
    OutpostStatus {
        up: derive_box_up(raw),
        runtime: if raw.agent_runtime.is_empty() {
            "claude".to_string()
        } else {
            raw.agent_runtime.clone()
        },
        relay_connected: derive_relay_connected(raw),
        ip: raw.static_ip.clone(),
        region: raw.region.clone(),
        last_seen_at: String::new(),
        stale: false,
    }
}

/// The stale-aware outpost view folded into a Mission Control snapshot.
#[derive(Debug, Clone, Default)]
pub struct OutpostView {
    /// Fresh outpost sessions (empty when the heartbeat is stale).
    pub sessions: Vec<AgentSession>,
    /// The box status card, or `None` when no outpost is known.
    pub status: Option<OutpostStatus>,
}

/// Parse an MQTT/S3 heartbeat payload into outpost sessions (pure, testable).
///
/// The emitter publishes the compact `AgentSession[]` directly (US-009), but we
/// tolerate a `{ "sessions": [...] }` envelope too, so the wire format can gain
/// metadata later without breaking the desktop. Each session is re-stamped
/// `origin=outpost` (the emitter already sets it, but we never trust the wire).
/// A malformed payload yields `Err` so the caller can log + ignore rather than
/// poisoning the store.
pub fn parse_heartbeat(payload: &[u8]) -> Result<Vec<AgentSession>, String> {
    // Try the bare array first (the documented shape), then the envelope.
    if let Ok(sessions) = serde_json::from_slice::<Vec<AgentSession>>(payload) {
        return Ok(stamp_outpost(sessions));
    }
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        sessions: Vec<AgentSession>,
    }
    let env: Envelope =
        serde_json::from_slice(payload).map_err(|e| format!("heartbeat parse: {e}"))?;
    Ok(stamp_outpost(env.sessions))
}

pub fn stamp_outpost(sessions: Vec<AgentSession>) -> Vec<AgentSession> {
    sessions
        .into_iter()
        .map(|mut s| {
            s.origin = AgentOrigin::Outpost;
            s
        })
        .collect()
}

/// STS credentials block inside the realtime-credentials response (same shape as
/// `dm_mqtt::RealtimeCredentials`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
    #[allow(dead_code)]
    pub expiration: String,
}

/// Response of `POST /v1/realtime/credentials`. The server returns the caller's
/// DM topic (`hq/<personUid>/dm`); the per-person STS policy scopes the whole
/// `hq/<personUid>/*` subtree (US-010), so the sessions topic is reachable by
/// swapping the leaf — see [`sessions_topic_for`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCredsResponse {
    pub credentials: RealtimeCredentials,
    pub iot_endpoint: String,
    pub region: String,
    /// The caller's own topic, e.g. `hq/<personUid>/dm`.
    pub topic: String,
}

/// Derive the sessions topic from the realtime-credentials `topic`
/// (`hq/<personUid>/dm` → `hq/<personUid>/sessions`). Pure + testable. Falls back
/// to swapping just the trailing segment so an unexpected leaf still lands under
/// the same person prefix the STS policy scopes.
pub fn sessions_topic_for(creds_topic: &str) -> String {
    match creds_topic.rsplit_once('/') {
        Some((prefix, _leaf)) => format!("{prefix}/sessions"),
        None => "sessions".to_string(),
    }
}

/// Presign an AWS IoT MQTT-over-WSS URL. Identical algorithm to
/// `dm_mqtt::build_signed_wss_url` — the session token is appended AFTER signing
/// (AWS IoT 403s if it's in the signed query). Pure + deterministic given `now`.
pub fn build_signed_wss_url(
    access_key_id: &str,
    secret_access_key: &str,
    session_token: &str,
    endpoint: &str,
    region: &str,
    now: SystemTime,
) -> Result<String, String> {
    use aws_credential_types::Credentials;
    use aws_sigv4::http_request::{
        sign, SignableBody, SignableRequest, SignatureLocation, SigningSettings,
    };
    use aws_sigv4::sign::v4;
    use aws_smithy_runtime_api::client::identity::Identity;

    let creds = Credentials::new(
        access_key_id,
        secret_access_key,
        None,
        None,
        "hq-sync-realtime-iot",
    );
    let identity: Identity = creds.into();

    let mut settings = SigningSettings::default();
    settings.signature_location = SignatureLocation::QueryParams;
    settings.expires_in = Some(PRESIGN_EXPIRES);

    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name(IOT_SERVICE)
        .time(now)
        .settings(settings)
        .build()
        .map_err(|e| format!("signing params: {e}"))?
        .into();

    let signable_uri = format!("wss://{}/mqtt", endpoint);
    let host_header = endpoint.to_string();
    let headers = [("host", host_header.as_str())];

    let signable = SignableRequest::new(
        "GET",
        &signable_uri,
        headers.iter().copied(),
        SignableBody::Bytes(&[]),
    )
    .map_err(|e| format!("signable request: {e}"))?;

    let signing_output = sign(signable, &params).map_err(|e| format!("sign: {e}"))?;
    let (instructions, _signature) = signing_output.into_parts();

    let query_pairs = instructions.params();
    if query_pairs.is_empty() {
        return Err("presign produced no query params".to_string());
    }
    let query = query_pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");

    Ok(format!(
        "wss://{}/mqtt?{}&X-Amz-Security-Token={}",
        endpoint,
        query,
        aws_uri_encode(session_token),
    ))
}

/// RFC3986 / AWS-canonical percent-encoding (mirrors `dm_mqtt::aws_uri_encode`).
pub fn aws_uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Stable MQTT client id (mirrors `dm_mqtt::client_id`, distinct prefix so the
/// two connections from one machine never collide on IoT's client-id reaping).
pub fn client_id() -> String {
    let machine = crate::config::ensure_machine_id().unwrap_or_else(|_| "unknown".into());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "hqsync-sess-{}-{}",
        &machine.chars().take(34).collect::<String>(),
        &suffix[..8]
    )
}

/// Format a `SystemTime` as an RFC-3339 / `Z` string (seconds precision),
/// matching how the readers stamp `lastActivityAt`.
pub fn system_time_to_iso(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{AgentTool, SessionStatus};

    fn outpost_session(id: &str) -> AgentSession {
        AgentSession {
            id: id.to_string(),
            tool: AgentTool::Claude,
            // Deliberately LOCAL on the wire so we prove the store re-stamps it.
            origin: AgentOrigin::Local,
            cwd: "/home/outpost/repos/thing".to_string(),
            project: "thing".to_string(),
            company: "indigo".to_string(),
            model: "claude-opus-4-8".to_string(),
            status: SessionStatus::Running,
            started_at: "2026-06-15T18:00:00Z".to_string(),
            last_activity_at: "2026-06-15T18:43:20Z".to_string(),
            source: "outpost-heartbeat".to_string(),
        }
    }

    // ── heartbeat parsing ───────────────────────────────────────────────────

    #[test]
    fn parse_heartbeat_accepts_bare_array_and_stamps_outpost() {
        let payload =
            serde_json::to_vec(&vec![outpost_session("a"), outpost_session("b")]).unwrap();
        let sessions = parse_heartbeat(&payload).expect("bare array parses");
        assert_eq!(sessions.len(), 2);
        // Wire said local; the parser MUST force origin=outpost.
        assert!(sessions.iter().all(|s| s.origin == AgentOrigin::Outpost));
    }

    #[test]
    fn parse_heartbeat_accepts_envelope_shape() {
        let payload = serde_json::json!({ "sessions": [outpost_session("a")] });
        let bytes = serde_json::to_vec(&payload).unwrap();
        let sessions = parse_heartbeat(&bytes).expect("envelope parses");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].origin, AgentOrigin::Outpost);
    }

    #[test]
    fn parse_heartbeat_rejects_garbage() {
        assert!(parse_heartbeat(b"not json").is_err());
    }

    // ── sessions topic derivation ───────────────────────────────────────────

    #[test]
    fn sessions_topic_swaps_the_dm_leaf() {
        assert_eq!(sessions_topic_for("hq/prs_abc/dm"), "hq/prs_abc/sessions");
        // Any leaf under the same person prefix lands on /sessions.
        assert_eq!(
            sessions_topic_for("hq/prs_abc/share"),
            "hq/prs_abc/sessions"
        );
    }

    // ── box-status derivation (up/down + relay) ─────────────────────────────

    #[test]
    fn box_up_requires_ready_state_and_running_instance() {
        // Ready + running → up (the only up combination — guards the stale-flag caveat).
        let up = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "running".into(),
            ..Default::default()
        };
        assert!(derive_box_up(&up));

        // Ready flag but instance not running → DOWN (state:ready is a stale boot flag).
        let stale_flag = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "stopped".into(),
            ..Default::default()
        };
        assert!(!derive_box_up(&stale_flag));

        // Still bootstrapping → down.
        let booting = RawOutpostStatus {
            state: "bootstrapping".into(),
            instance_state: "running".into(),
            ..Default::default()
        };
        assert!(!derive_box_up(&booting));
    }

    #[test]
    fn relay_connected_tracks_codex_state_for_codex_boxes() {
        let codex_connected = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "running".into(),
            agent_runtime: "codex".into(),
            codex_state: "connected".into(),
            ..Default::default()
        };
        assert!(derive_relay_connected(&codex_connected));

        let codex_down = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "running".into(),
            agent_runtime: "codex".into(),
            codex_state: "awaiting-login".into(),
            ..Default::default()
        };
        assert!(
            !derive_relay_connected(&codex_down),
            "codex relay not connected → disconnected"
        );

        // Claude box: relay == up.
        let claude_up = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "running".into(),
            agent_runtime: "claude".into(),
            ..Default::default()
        };
        assert!(derive_relay_connected(&claude_up));
    }

    #[test]
    fn project_status_fills_card_fields() {
        let raw = RawOutpostStatus {
            state: "ready".into(),
            instance_state: "running".into(),
            agent_runtime: "claude".into(),
            static_ip: "203.0.113.7".into(),
            region: "us-east-1".into(),
            ..Default::default()
        };
        let card = project_status(&raw);
        assert!(card.up);
        assert_eq!(card.runtime, "claude");
        assert!(card.relay_connected);
        assert_eq!(card.ip, "203.0.113.7");
        assert_eq!(card.region, "us-east-1");
    }

    // ── presign shape (regression: token appended AFTER signing) ────────────

    #[test]
    fn signed_wss_url_appends_session_token_after_signature() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_012_800);
        let url = build_signed_wss_url(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "FAKE/SESSION+TOKEN=",
            "abc123.iot.us-east-1.amazonaws.com",
            "us-east-1",
            now,
        )
        .expect("presign succeeds");
        assert!(url.starts_with("wss://abc123.iot.us-east-1.amazonaws.com/mqtt?"));
        let sig_at = url.find("X-Amz-Signature").unwrap();
        let tok_at = url.find("X-Amz-Security-Token").unwrap();
        assert!(
            tok_at > sig_at,
            "token must be appended after the signature: {url}"
        );
        assert!(
            url.contains("FAKE%2FSESSION%2BTOKEN%3D"),
            "token must be AWS-encoded: {url}"
        );
    }

    #[test]
    fn realtime_creds_response_deserializes() {
        let json = r#"{
            "credentials": {
                "accessKeyId": "ASIA_FAKE",
                "secretAccessKey": "secret",
                "sessionToken": "token",
                "expiration": "2026-05-29T01:00:00Z"
            },
            "iotEndpoint": "abc123.iot.us-east-1.amazonaws.com",
            "region": "us-east-1",
            "topic": "hq/prs_abc/dm"
        }"#;
        let parsed: RealtimeCredsResponse = serde_json::from_str(json).expect("parses");
        assert_eq!(parsed.credentials.access_key_id, "ASIA_FAKE");
        assert_eq!(sessions_topic_for(&parsed.topic), "hq/prs_abc/sessions");
    }

    #[test]
    fn raw_outpost_status_tolerates_extra_fields() {
        // The real StatusResponse carries many more fields; we must ignore them.
        let json = r#"{
            "userId": "u", "instanceName": "i", "staticIp": "203.0.113.7",
            "region": "us-east-1", "state": "ready", "agentRuntime": "codex",
            "rcPort": 7799, "instanceState": "running", "codexState": "connected",
            "codexRelayStatus": "connected", "platform": "ec2", "extra": {"nested": 1}
        }"#;
        let raw: RawOutpostStatus = serde_json::from_str(json).expect("parses despite extras");
        let card = project_status(&raw);
        assert!(card.up);
        assert_eq!(card.runtime, "codex");
        assert!(card.relay_connected);
    }
}
