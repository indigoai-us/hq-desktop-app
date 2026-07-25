//! Desktop outpost subscriber + box-level status + merge (US-011).
//!
//! This is the desktop half of the per-session outpost path. The outpost VM
//! publishes a compact `AgentSession[]` (origin=outpost) to the realtime topic
//! `hq/{personUid}/sessions` on the desktop's poll cadence (US-009), and the
//! realtime session policy scopes publish/subscribe to that topic per person
//! (US-010). This module:
//!
//!   1. **Subscribes** to `hq/{personUid}/sessions` over MQTT-over-WSS — reusing
//!      the exact credential/presign/subscribe pattern from `dm_mqtt.rs` — and,
//!      unlike DM (where the message is only a wake signal), **parses the
//!      payload** into `AgentSession[]`, stamps `origin=outpost`, and stores it.
//!   2. **Merges** those outpost sessions into the SAME Mission Control snapshot
//!      as the local readers, so local + outpost agents appear in one fleet
//!      (`outpost_sessions_snapshot` is folded into `collect_snapshot`).
//!   3. **Sources the box-level status** from `GET /outpost/status` (up/down,
//!      runtime, relay, last-seen) so the UI can head the outpost group with a
//!      status card (design.md "Outpost status card (US-011)").
//!   4. **Falls back to S3** when MQTT is unavailable — the same heartbeat payload
//!      is polled from the vault — and a **stale-after timeout** drops outpost
//!      sessions that stop reporting, so a dead box doesn't leave ghost rows.
//!
//! ## Shared state
//!
//! [`OutpostStore`] is a process-global, mutex-guarded cache of the latest
//! heartbeat (`AgentSession[]` + the instant it landed) plus the latest box
//! status. The MQTT receiver and the S3-fallback poller both write it; the
//! Mission Control snapshot assembly reads it. Reads apply the stale-after
//! timeout so a heartbeat that stopped arriving evaporates without any writer
//! having to actively clear it.
//!
//! ## Failure posture
//!
//! Every path here is **best-effort and non-fatal**, exactly like `dm_mqtt.rs`:
//! a creds/presign/connect failure logs and retries with backoff while the S3
//! poll keeps the store warm; a `/outpost/status` failure leaves the last known
//! box status (aged by the stale window) rather than blanking it. The local
//! fleet is never affected by an outpost-path failure.
//!
//! ## Log codes (`outpost` tag)
//!
//!   `OUTPOST_MQTT_CREDS_FAIL` / `OUTPOST_MQTT_PRESIGN_FAIL` /
//!   `OUTPOST_MQTT_CONNECT_OK` / `OUTPOST_MQTT_SUBSCRIBED` /
//!   `OUTPOST_MQTT_HEARTBEAT` / `OUTPOST_MQTT_DISCONNECT` / `OUTPOST_MQTT_FALLBACK`
//!   / `OUTPOST_S3_POLL_OK` / `OUTPOST_STATUS_OK` / `OUTPOST_STATUS_FAIL`. No
//!   secrets are ever logged (never the presigned URL, never the creds).

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use tauri::AppHandle;

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

use super::{AgentOrigin, AgentSession};

pub use hq_desktop_core::sessions::outpost::{
    build_signed_wss_url, client_id, parse_heartbeat, project_status, sessions_topic_for,
    system_time_to_iso, OutpostStatus, OutpostView, RawOutpostStatus, RealtimeCredsResponse,
    HEARTBEAT_STALE_AFTER,
};

const LOG_TAG: &str = "outpost";
/// Reconnect backoff floor (mirrors `dm_mqtt::BACKOFF_MIN`).
const BACKOFF_MIN: Duration = Duration::from_secs(5);
/// Reconnect backoff ceiling (mirrors `dm_mqtt::BACKOFF_MAX`).
const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// S3-fallback poll cadence. Only the fallback path uses a timer — the MQTT path
/// is push. Kept slightly longer than the live cadence since it's the backstop.
const S3_POLL_INTERVAL: Duration = Duration::from_secs(15);

/// `/outpost/status` refresh cadence (the box card is control-plane state, not
/// per-session, so it doesn't need the live heartbeat cadence).
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(20);

/// The mutable inner state behind [`OutpostStore`].
#[derive(Debug, Default)]
struct OutpostState {
    /// The most recent heartbeat's sessions (already stamped origin=outpost).
    sessions: Vec<AgentSession>,
    /// When that heartbeat landed. `None` until the first beat.
    last_heartbeat: Option<SystemTime>,
    /// The most recent box status from `/outpost/status`. `None` until first fetch.
    status: Option<OutpostStatus>,
}

/// Process-global outpost cache shared by the MQTT receiver, the S3 fallback
/// poller, the status poller, and the snapshot assembly. A single `Mutex` is
/// ample — writes are a handful per poll cycle and reads happen once per
/// snapshot. Lazily initialised so tests and non-outpost builds pay nothing.
pub struct OutpostStore;

fn state() -> &'static Mutex<OutpostState> {
    static STORE: OnceLock<Mutex<OutpostState>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(OutpostState::default()))
}

impl OutpostStore {
    /// Record a fresh heartbeat: replace the cached outpost sessions (each
    /// re-stamped `origin=outpost` defensively) and mark the landing time. The
    /// `at` instant is injected so the stale logic is deterministic under test.
    pub fn record_heartbeat(sessions: Vec<AgentSession>, at: SystemTime) {
        let stamped = sessions
            .into_iter()
            .map(|mut s| {
                s.origin = AgentOrigin::Outpost;
                s
            })
            .collect();
        let mut guard = state().lock().expect("outpost store mutex poisoned");
        guard.sessions = stamped;
        guard.last_heartbeat = Some(at);
    }

    /// Record the latest box status from `/outpost/status`.
    pub fn record_status(status: OutpostStatus) {
        let mut guard = state().lock().expect("outpost store mutex poisoned");
        guard.status = Some(status);
    }

    /// The current outpost view at instant `now`, with the stale-after timeout
    /// applied (pure read; injected `now` for tests):
    ///
    ///   - sessions: the cached heartbeat's sessions IF the beat is within
    ///     [`HEARTBEAT_STALE_AFTER`], else empty (stale → dropped).
    ///   - status: the last box status, with `last_seen_at` set from the most
    ///     recent heartbeat and `stale` set when that beat is past the window
    ///     (or never happened). When no `/outpost/status` has succeeded but we
    ///     HAVE seen a heartbeat, a minimal up status is synthesised so the card
    ///     still reflects last-seen.
    pub fn current(now: SystemTime) -> OutpostView {
        let guard = state().lock().expect("outpost store mutex poisoned");
        Self::view_from(&guard, now)
    }

    /// Pure projection of an [`OutpostState`] at `now` — split out so the
    /// stale-timeout rule is unit-testable without the global mutex.
    fn view_from(st: &OutpostState, now: SystemTime) -> OutpostView {
        let fresh = st
            .last_heartbeat
            .map(|t| {
                now.duration_since(t)
                    .map(|d| d < HEARTBEAT_STALE_AFTER)
                    .unwrap_or(true)
            })
            .unwrap_or(false);

        let sessions = if fresh {
            st.sessions.clone()
        } else {
            Vec::new()
        };

        let last_seen_at = st
            .last_heartbeat
            .map(system_time_to_iso)
            .unwrap_or_default();

        let status = match &st.status {
            Some(base) => {
                let mut s = base.clone();
                s.last_seen_at = last_seen_at.clone();
                // A box that stopped beating reads stale regardless of the
                // last control-plane state — the card flips to its down/last-seen
                // treatment and shows the stale-sessions note.
                s.stale = !fresh;
                if !fresh {
                    s.up = false;
                    s.relay_connected = false;
                }
                Some(s)
            }
            // No /outpost/status yet but we have heartbeats → synthesise a
            // minimal card so the operator still sees up + last-seen.
            None if st.last_heartbeat.is_some() => Some(OutpostStatus {
                up: fresh,
                runtime: String::new(),
                relay_connected: fresh,
                ip: String::new(),
                region: String::new(),
                last_seen_at,
                stale: !fresh,
            }),
            // Nothing known at all → no card (the UI omits the outpost group).
            None => None,
        };

        OutpostView { sessions, status }
    }

    /// Test-only reset of the global store between cases.
    #[cfg(test)]
    fn reset() {
        let mut guard = state().lock().expect("outpost store mutex poisoned");
        *guard = OutpostState::default();
    }
}

/// Snapshot accessor used by `sessions::collect_snapshot` — returns the current
/// stale-aware outpost view from the global store.
pub fn outpost_view(now: SystemTime) -> OutpostView {
    OutpostStore::current(now)
}

/// Fetch short-lived realtime credentials from the vault (identical to
/// `dm_mqtt::fetch_realtime_credentials`, kept local so the two background tasks
/// don't couple). Returns `Err` with a short reason on any failure.
async fn fetch_realtime_credentials() -> Result<RealtimeCredsResponse, String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;

    let url = format!("{}/v1/realtime/credentials", base_url);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status={}", status.as_u16()));
    }

    resp.json::<RealtimeCredsResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// MQTT receive loop (subscribe + parse, unlike dm_mqtt's wake-only path)
// ─────────────────────────────────────────────────────────────────────────────

/// One connect→subscribe→receive cycle for the sessions topic. On each inbound
/// Publish the payload is parsed into `AgentSession[]` and recorded in the store
/// (unlike DM, where the message is only a wake signal). Returns `Err` on any
/// connection failure so the caller backs off + retries.
async fn run_once(creds: &RealtimeCredsResponse) -> Result<(), String> {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};

    let now = SystemTime::now();
    let url = build_signed_wss_url(
        &creds.credentials.access_key_id,
        &creds.credentials.secret_access_key,
        &creds.credentials.session_token,
        &creds.iot_endpoint,
        &creds.region,
        now,
    )
    .map_err(|e| {
        log(LOG_TAG, &format!("OUTPOST_MQTT_PRESIGN_FAIL {e}"));
        e
    })?;

    let topic = sessions_topic_for(&creds.topic);

    let mut opts = MqttOptions::new(client_id(), url, 443);
    // Bundled webpki roots, not the macOS keychain — avoids the fatal
    // `load_native_certs().expect(...)` panic (Sentry HQ-SYNC-D). See util/mqtt_tls.rs.
    opts.set_transport(
        crate::util::mqtt_tls::wss_transport_with_bundled_roots().map_err(|e| {
            log(LOG_TAG, &format!("OUTPOST_MQTT_TLS_CONFIG_FAIL {e}"));
            format!("TLS configuration: {e}")
        })?,
    );
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_clean_session(true);

    let (client, mut eventloop) = AsyncClient::new(opts, 10);

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                log(LOG_TAG, "OUTPOST_MQTT_CONNECT_OK");
                if let Err(e) = client.subscribe(topic.clone(), QoS::AtMostOnce).await {
                    return Err(format!("subscribe: {e}"));
                }
                log(LOG_TAG, &format!("OUTPOST_MQTT_SUBSCRIBED topic={topic}"));
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                // The payload IS the heartbeat — parse it into outpost sessions.
                match parse_heartbeat(&p.payload) {
                    Ok(sessions) => {
                        let n = sessions.len();
                        OutpostStore::record_heartbeat(sessions, SystemTime::now());
                        log(LOG_TAG, &format!("OUTPOST_MQTT_HEARTBEAT sessions={n}"));
                    }
                    Err(e) => log(LOG_TAG, &format!("OUTPOST_MQTT_HEARTBEAT_BAD {e}")),
                }
            }
            Ok(_) => { /* SubAck, PingResp, Outgoing, etc. — ignore. */ }
            Err(e) => return Err(format!("eventloop: {e}")),
        }
    }
}

/// Spawn the outpost sessions MQTT receiver. Called from `main.rs` `.setup()`,
/// macOS-gated like the other realtime tasks. On any failure it logs and retries
/// with capped exponential backoff; the S3 fallback poller keeps the store warm
/// meanwhile, so an MQTT outage never blanks the outpost group — it just degrades
/// to the slower poll cadence (PRD US-011 resilience criterion).
pub fn setup_outpost_mqtt_receiver(_app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(6)).await;

        let mut backoff = BACKOFF_MIN;
        loop {
            match fetch_realtime_credentials().await {
                Ok(creds) => {
                    let started = SystemTime::now();
                    if let Err(e) = run_once(&creds).await {
                        log(LOG_TAG, &format!("OUTPOST_MQTT_DISCONNECT {e}"));
                    }
                    if started
                        .elapsed()
                        .map(|d| d > Duration::from_secs(30))
                        .unwrap_or(false)
                    {
                        backoff = BACKOFF_MIN;
                    }
                }
                Err(e) => log(LOG_TAG, &format!("OUTPOST_MQTT_CREDS_FAIL {e}")),
            }

            log(
                LOG_TAG,
                &format!(
                    "OUTPOST_MQTT_FALLBACK reconnect in {}s (S3 poll active)",
                    backoff.as_secs()
                ),
            );
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// S3 heartbeat fallback + box-status pollers
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch the S3-vault heartbeat (the MQTT-unavailable fallback) and record it.
///
/// The emitter writes the same `AgentSession[]` payload to a vault prefix when it
/// can't reach the realtime fabric; the desktop reads it via the vault API's
/// signed-read endpoint. Best-effort: a 404 (no heartbeat object) or any error
/// just leaves the store untouched so the stale-timeout takes over.
async fn poll_s3_heartbeat_once() {
    let payload = match fetch_s3_heartbeat().await {
        Ok(bytes) => bytes,
        Err(e) => {
            log(LOG_TAG, &format!("OUTPOST_S3_POLL_MISS {e}"));
            return;
        }
    };
    match parse_heartbeat(&payload) {
        Ok(sessions) => {
            let n = sessions.len();
            OutpostStore::record_heartbeat(sessions, SystemTime::now());
            log(LOG_TAG, &format!("OUTPOST_S3_POLL_OK sessions={n}"));
        }
        Err(e) => log(LOG_TAG, &format!("OUTPOST_S3_POLL_BAD {e}")),
    }
}

/// GET the S3-vault heartbeat object via the vault API (`/v1/outpost/heartbeat`,
/// served as the signed-read fallback for the sessions payload). Returns the raw
/// body bytes or a short error.
async fn fetch_s3_heartbeat() -> Result<Vec<u8>, String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;
    let url = format!("{}/v1/outpost/heartbeat", base_url);

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("status={}", resp.status().as_u16()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("body: {e}"))
}

/// Fetch `GET /outpost/status` and record the projected box card. Best-effort: a
/// 404 (no outpost) records the neutral `unknown` status so the card reads down
/// rather than disappearing; any other error leaves the last known status.
async fn poll_outpost_status_once() {
    match fetch_outpost_status().await {
        Ok(Some(raw)) => {
            OutpostStore::record_status(project_status(&raw));
            log(LOG_TAG, "OUTPOST_STATUS_OK");
        }
        Ok(None) => {
            // 404 → no box provisioned for this user. Record the neutral down
            // card only if we have never seen a heartbeat (don't stomp a live one).
            if OutpostStore::current(SystemTime::now()).status.is_none() {
                OutpostStore::record_status(OutpostStatus::unknown());
            }
            log(LOG_TAG, "OUTPOST_STATUS_NONE");
        }
        Err(e) => log(LOG_TAG, &format!("OUTPOST_STATUS_FAIL {e}")),
    }
}

/// GET `/outpost/status`. Returns `Ok(None)` on a 404 (no outpost for this user),
/// `Ok(Some)` on success, `Err` on any other failure.
async fn fetch_outpost_status() -> Result<Option<RawOutpostStatus>, String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;
    let url = format!("{}/outpost/status", base_url);

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("status={}", resp.status().as_u16()));
    }
    resp.json::<RawOutpostStatus>()
        .await
        .map(Some)
        .map_err(|e| format!("parse: {e}"))
}

/// Spawn the S3-heartbeat fallback poller and the box-status poller. Called from
/// `main.rs` `.setup()` alongside the MQTT receiver. Both run on independent
/// interval timers (mirrors the share/dm poller pattern) and are best-effort.
pub fn setup_outpost_pollers(_app: AppHandle) {
    // S3 heartbeat fallback — keeps the store warm when MQTT is down.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(7)).await;
        let mut ticker = tokio::time::interval(S3_POLL_INTERVAL);
        loop {
            ticker.tick().await;
            poll_s3_heartbeat_once().await;
        }
    });

    // Box-level status — heads the outpost group.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let mut ticker = tokio::time::interval(STATUS_POLL_INTERVAL);
        loop {
            ticker.tick().await;
            poll_outpost_status_once().await;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sessions::{AgentTool, SessionStatus};

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

    // ── store: merge + stale-timeout (the US-011 e2e back-pressure) ──────────

    #[test]
    fn fresh_heartbeat_surfaces_outpost_sessions() {
        OutpostStore::reset();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        OutpostStore::record_heartbeat(vec![outpost_session("o1")], now);

        // Read 10s later — within the stale window → sessions present, marked outpost.
        let view = OutpostStore::current(now + Duration::from_secs(10));
        assert_eq!(view.sessions.len(), 1);
        assert_eq!(view.sessions[0].origin, AgentOrigin::Outpost);
        // A synthesised card (no /outpost/status yet) reads up + carries last-seen.
        let status = view.status.expect("synthesised card present");
        assert!(status.up);
        assert!(!status.stale);
        assert!(!status.last_seen_at.is_empty());
        OutpostStore::reset();
    }

    #[test]
    fn stale_heartbeat_drops_outpost_sessions_and_marks_card() {
        OutpostStore::reset();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        OutpostStore::record_status(OutpostStatus {
            up: true,
            runtime: "claude".into(),
            relay_connected: true,
            ip: "203.0.113.7".into(),
            region: "us-east-1".into(),
            last_seen_at: String::new(),
            stale: false,
        });
        OutpostStore::record_heartbeat(vec![outpost_session("o1")], now);

        // Read PAST the stale window → sessions dropped, card flips to stale/down.
        let after = now + HEARTBEAT_STALE_AFTER + Duration::from_secs(1);
        let view = OutpostStore::current(after);
        assert!(
            view.sessions.is_empty(),
            "stale heartbeat drops outpost sessions"
        );
        let status = view.status.expect("card still present (last-seen)");
        assert!(status.stale, "card marked stale past the timeout");
        assert!(!status.up, "stale box reads down");
        assert!(
            !status.relay_connected,
            "stale box relay reads disconnected"
        );
        // last-seen reflects the last heartbeat instant, not 'now'.
        assert!(!status.last_seen_at.is_empty());
        OutpostStore::reset();
    }

    #[test]
    fn no_outpost_known_yields_no_card() {
        OutpostStore::reset();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        let view = OutpostStore::current(now);
        assert!(view.sessions.is_empty());
        assert!(
            view.status.is_none(),
            "no heartbeat + no status → no outpost card"
        );
        OutpostStore::reset();
    }

    #[test]
    fn status_only_box_renders_card_without_sessions() {
        OutpostStore::reset();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        // /outpost/status succeeded but no per-session heartbeat yet (box up,
        // emitter not reporting): card present + up, no sessions, last-seen empty.
        OutpostStore::record_status(OutpostStatus {
            up: true,
            runtime: "claude".into(),
            relay_connected: true,
            ip: "203.0.113.7".into(),
            region: "us-east-1".into(),
            last_seen_at: String::new(),
            stale: false,
        });
        let view = OutpostStore::current(now);
        assert!(view.sessions.is_empty());
        let status = view.status.expect("status card present");
        // No heartbeat ever → stale (we have never seen a per-session beat).
        assert!(
            status.stale,
            "a box with status but no heartbeat reads stale"
        );
        assert!(status.last_seen_at.is_empty());
        OutpostStore::reset();
    }
}
