//! Work-thread listener — "Send to HQ Agent → Local session", desktop half.
//!
//! ## What this does
//!
//! hq-pro's Slack "Send to HQ Agent" shortcut can target a **local session**.
//! When it does it mints a Work Mesh thread addressed to the invoker's OWN
//! `personUid`, stamps an additive `localSession` block on `THREAD_META`, and
//! publishes a wake on the IoT topic `hq/{personUid}/work`. This module is the
//! machine-side consumer:
//!
//!   1. **Subscribe** to `hq/{personUid}/work` over MQTT-over-WSS — the exact
//!      credential / SigV4-presign / backoff-reconnect structure `dm_mqtt.rs`
//!      established, reusing its presign + client-id primitives via
//!      `hq_desktop_core::sessions::outpost`.
//!   2. **Drain** on connect (offline catch-up) and on every wake: fetch the
//!      PERSON-scoped feed `GET {api}/v1/work-mesh/work` — note the absence of a
//!      `?companyUid=`; a `prs_*` person uid is never a valid companyUid and that
//!      form 403s.
//!   3. **Route** each open thread that carries a `localSession` to the matching
//!      local runtime (see `providers.rs`), deduping already-spawned `threadId`s
//!      for the process lifetime so a repeat wake never opens a second window.
//!   4. **Report** — an unavailable runtime POSTs a `blocked` event naming the
//!      provider and the reason, and does NOT mark the thread spawned, so a later
//!      wake retries once the runtime appears. The listener never crashes.
//!
//! Like `dm_mqtt.rs`, the MQTT message is only a wake signal: the payload is
//! never parsed, so dedupe and routing all live on the fetch path.
//!
//! ## Gating — OFF by default
//!
//! `workMeshEnabled` in `~/.hq/menubar.json`, default **false** (the
//! `autostart_daemon` posture, not the default-ON notification posture), with a
//! `WORK_MESH_ENABLED=1` environment override for development. This feature
//! opens windows and launches agent runtimes on the user's machine, so it stays
//! opt-in. With the gate off nothing here runs: no credential fetch, no socket,
//! no feed request, no behavior change of any kind.
//!
//! The gate is re-read on every reconnect cycle (not cached), so flipping the
//! pref takes effect without an app restart — mirroring how `share_notify` and
//! `hq_cli_update` re-read their toggles per cycle.
//!
//! ## Security
//!
//! Slack message bodies arrive as `sourceSignalSummary` and are UNTRUSTED. They
//! only ever reach a runtime inside the labelled `<signal-content>` fence
//! `work_mesh::build_work_thread_session_prefill` builds, and every dispatched
//! URL passes the same byte allowlist the "Open in Claude Code" button uses. The
//! reply-token field is a personal-vault KEY NAME, never a token value; no secret
//! is read or logged here.
//!
//! ## Log codes (`work-mesh` tag)
//!
//!   `WORK_MESH_GATE_SKIP` / `WORK_MESH_CREDS_FAIL` / `WORK_MESH_PRESIGN_FAIL` /
//!   `WORK_MESH_CONNECT_OK` / `WORK_MESH_SUBSCRIBED` / `WORK_MESH_WAKE` /
//!   `WORK_MESH_FEED_FAIL` / `WORK_MESH_SPAWN_OK` / `WORK_MESH_SPAWN_FAIL` /
//!   `WORK_MESH_BLOCKED` / `WORK_MESH_EVENT_FAIL` / `WORK_MESH_DISCONNECT` /
//!   `WORK_MESH_RECONNECT`. No secrets are ever logged (never the presigned URL,
//!   never the creds, never a token key's value).

pub mod providers;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::json;
use tauri::AppHandle;

use hq_desktop_core::sessions::outpost::{build_signed_wss_url, client_id, RealtimeCredsResponse};
use hq_desktop_core::work_mesh::{
    build_work_thread_session_prefill, work_topic_for, LocalProvider, WorkFeedResponse,
    WorkThreadMeta,
};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "work-mesh";

/// Reconnect backoff floor / ceiling (mirrors `dm_mqtt::BACKOFF_MIN`/`MAX`).
const BACKOFF_MIN: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(300);

/// Launch delay, staggered past the DM (5s) and outpost (6s) receivers so three
/// realtime tasks don't contend for the credential endpoint on cold start.
const LAUNCH_DELAY: Duration = Duration::from_secs(8);

// ─── Gate ─────────────────────────────────────────────────────────────────────

/// Whether the work-thread listener is armed. Default **false**.
///
/// `WORK_MESH_ENABLED=1` in the environment wins (dev override); otherwise the
/// `workMeshEnabled` key in `~/.hq/menubar.json` decides, and an absent key means
/// off. Re-read per cycle so a pref flip needs no restart.
pub fn work_mesh_enabled() -> bool {
    if std::env::var("WORK_MESH_ENABLED").ok().as_deref() == Some("1") {
        return true;
    }
    hq_desktop_core::daemon::read_menubar_bool(|p| p.work_mesh_enabled, false)
}

// ─── Spawn dedupe ─────────────────────────────────────────────────────────────

/// Thread ids already opened in THIS process. Deliberately process-lifetime and
/// in-memory: a restart is the natural "re-offer the work" boundary, and nothing
/// on disk should silently swallow a thread the user never actually saw.
///
/// A thread is recorded ONLY after its runtime launched. An unavailable runtime
/// leaves it unrecorded so the next wake retries.
fn spawned() -> &'static Mutex<HashSet<String>> {
    static SPAWNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SPAWNED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// True if `thread_id` has not been spawned before (and is now reserved).
/// Check-and-insert is atomic under one lock so two near-simultaneous wakes
/// cannot both win the race and open two windows for one thread.
fn claim_thread(thread_id: &str) -> bool {
    let mut guard = spawned().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(thread_id.to_string())
}

/// Give a reserved thread back after a failed launch, so a later wake retries it.
fn release_thread(thread_id: &str) {
    let mut guard = spawned().lock().unwrap_or_else(|e| e.into_inner());
    guard.remove(thread_id);
}

#[cfg(test)]
fn reset_spawned() {
    let mut guard = spawned().lock().unwrap_or_else(|e| e.into_inner());
    guard.clear();
}

// ─── hq-pro REST client ───────────────────────────────────────────────────────

async fn vault_base_url() -> Result<String, String> {
    resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))
}

/// Fetch the PERSON-scoped work feed.
///
/// `GET {api}/v1/work-mesh/work` — NOT `?companyUid=…`. The feed is scoped by the
/// caller's JWT across every company they are authorized in; passing the caller's
/// own `prs_*` as a companyUid 403s, because a person uid is never a company uid.
async fn fetch_work_feed() -> Result<WorkFeedResponse, String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let url = format!("{}/v1/work-mesh/work", vault_base_url().await?);

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("status={}", resp.status().as_u16()));
    }
    resp.json::<WorkFeedResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))
}

/// POST a typed event onto a thread. Best-effort — a failure is logged and
/// swallowed; the listener never dies because hq-pro was briefly unreachable.
async fn post_thread_event(
    thread_id: &str,
    company_uid: &str,
    event_kind: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let url = format!(
        "{}/v1/work-mesh/threads/{thread_id}/events",
        vault_base_url().await?
    );

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {access_token}"))
        .json(&json!({
            "companyUid": company_uid,
            "eventKind": event_kind,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("status={}", resp.status().as_u16()));
    }
    Ok(())
}

/// Build the `blocked` payload for an unavailable runtime. Pure so the shape is
/// testable without a network. The reason NAMES the provider so a Slack reader
/// can tell "your Mac has no Codex" from "your Mac was offline".
fn blocked_payload(provider: LocalProvider, reason: &str) -> serde_json::Value {
    json!({
        "kind": "blocked",
        "reason": format!(
            "Local session could not start: the `{}` runtime is unavailable on this \
             machine — {reason}",
            provider.tool()
        ),
        "asks": [format!("Install or sign in to the `{}` runtime, then re-send", provider.tool())],
    })
}

/// Send the company-scoped presence heartbeat, once per company the feed
/// actually returned. Unlike the feed, `POST /v1/work-mesh/participants/heartbeat`
/// DOES require a real `companyUid` — which is why the values are sourced from
/// the feed rather than guessed. Best-effort.
async fn heartbeat_companies(company_uids: &[String]) {
    let Ok(base) = vault_base_url().await else {
        return;
    };
    let Ok(access_token) = cognito::get_valid_access_token().await else {
        return;
    };
    for company_uid in company_uids {
        let result = build_client()
            .post(format!("{base}/v1/work-mesh/participants/heartbeat"))
            .header("authorization", format!("Bearer {access_token}"))
            .json(&json!({ "companyUid": company_uid, "status": "online" }))
            .send()
            .await;
        if let Err(e) = result {
            log(LOG_TAG, &format!("WORK_MESH_HEARTBEAT_FAIL {e}"));
        }
    }
}

// ─── Drain ────────────────────────────────────────────────────────────────────

/// Fetch the feed and open a local session per un-spawned local-session thread.
///
/// Called once on every (re)connect for offline catch-up and once per wake. Every
/// failure inside is contained: a bad feed logs and returns, a single thread's
/// launch failure never stops the others.
async fn drain_once() {
    let feed = match fetch_work_feed().await {
        Ok(feed) => feed,
        Err(e) => {
            log(LOG_TAG, &format!("WORK_MESH_FEED_FAIL {e}"));
            return;
        }
    };

    heartbeat_companies(&feed.company_uids()).await;

    let env = providers::detect_provider_env();
    let hq_folder = hq_desktop_core::daemon::resolve_hq_folder_path().unwrap_or_default();

    for thread in feed.local_session_threads() {
        handle_thread(thread, &hq_folder, &env).await;
    }
}

/// Route one local-session thread. Reserves the id BEFORE launching (so a
/// concurrent wake can't double-open) and releases it on failure (so a later wake
/// retries once the runtime appears).
async fn handle_thread(thread: &WorkThreadMeta, hq_folder: &str, env: &providers::ProviderEnv) {
    let Some(local) = thread.local_session.as_ref() else {
        return;
    };
    let provider = local.provider;

    if !claim_thread(&thread.thread_id) {
        // Already opened in this process — a repeat wake is a no-op, not a
        // second window.
        return;
    }

    let prefill = build_work_thread_session_prefill(thread, hq_folder);
    let action = match providers::plan_launch(provider, hq_folder, &prefill, env) {
        Ok(action) => action,
        Err(reason) => {
            // Runtime unavailable: report it, and do NOT keep the thread marked
            // spawned.
            release_thread(&thread.thread_id);
            log(
                LOG_TAG,
                &format!(
                    "WORK_MESH_BLOCKED thread={} provider={} reason={reason}",
                    thread.thread_id,
                    provider.tool()
                ),
            );
            if let Err(e) = post_thread_event(
                &thread.thread_id,
                &thread.company_uid,
                "blocked",
                blocked_payload(provider, &reason),
            )
            .await
            {
                log(LOG_TAG, &format!("WORK_MESH_EVENT_FAIL blocked {e}"));
            }
            return;
        }
    };

    match providers::execute(action) {
        Ok(()) => log(
            LOG_TAG,
            &format!(
                "WORK_MESH_SPAWN_OK thread={} provider={}",
                thread.thread_id,
                provider.tool()
            ),
        ),
        Err(e) => {
            // The runtime exists but dispatch failed (a failed preflight, a
            // refused `open`). Same posture as unavailable: report + retry later.
            release_thread(&thread.thread_id);
            log(
                LOG_TAG,
                &format!(
                    "WORK_MESH_SPAWN_FAIL thread={} provider={} {e}",
                    thread.thread_id,
                    provider.tool()
                ),
            );
            if let Err(post_err) = post_thread_event(
                &thread.thread_id,
                &thread.company_uid,
                "blocked",
                blocked_payload(provider, &e),
            )
            .await
            {
                log(LOG_TAG, &format!("WORK_MESH_EVENT_FAIL blocked {post_err}"));
            }
        }
    }
}

// ─── MQTT receive loop ────────────────────────────────────────────────────────

/// Fetch short-lived realtime credentials (identical to
/// `dm_mqtt::fetch_realtime_credentials`, kept local so the background tasks
/// don't couple — the same choice `sessions::outpost` made).
async fn fetch_realtime_credentials() -> Result<RealtimeCredsResponse, String> {
    let access_token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let url = format!("{}/v1/realtime/credentials", vault_base_url().await?);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("status={}", resp.status().as_u16()));
    }
    resp.json::<RealtimeCredsResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))
}

/// One connect→subscribe→receive cycle on `hq/{personUid}/work`. The payload is
/// never parsed — a message is only a wake signal, so `drain_once` owns dedupe
/// and routing (the same "wake → fetch" design as `dm_mqtt.rs`).
async fn run_once(creds: &RealtimeCredsResponse) -> Result<(), String> {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};

    let url = build_signed_wss_url(
        &creds.credentials.access_key_id,
        &creds.credentials.secret_access_key,
        &creds.credentials.session_token,
        &creds.iot_endpoint,
        &creds.region,
        SystemTime::now(),
    )
    .map_err(|e| {
        log(LOG_TAG, &format!("WORK_MESH_PRESIGN_FAIL {e}"));
        e
    })?;

    let topic = work_topic_for(&creds.topic);

    let mut opts = MqttOptions::new(client_id(), url, 443);
    // Bundled webpki roots, not the macOS keychain — avoids the fatal
    // `load_native_certs().expect(...)` panic (Sentry HQ-SYNC-D). See util/mqtt_tls.rs.
    opts.set_transport(
        crate::util::mqtt_tls::wss_transport_with_bundled_roots().map_err(|e| {
            log(LOG_TAG, &format!("WORK_MESH_TLS_CONFIG_FAIL {e}"));
            format!("TLS configuration: {e}")
        })?,
    );
    opts.set_keep_alive(Duration::from_secs(30));
    // AWS IoT requires a clean session for SigV4-WSS connections.
    opts.set_clean_session(true);

    let (client, mut eventloop) = AsyncClient::new(opts, 10);

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                log(LOG_TAG, "WORK_MESH_CONNECT_OK");
                if let Err(e) = client.subscribe(topic.clone(), QoS::AtMostOnce).await {
                    return Err(format!("subscribe: {e}"));
                }
                log(LOG_TAG, &format!("WORK_MESH_SUBSCRIBED topic={topic}"));
                // Offline catch-up: drain anything dispatched while we were away.
                drain_once().await;
            }
            Ok(Event::Incoming(Packet::Publish(_))) => {
                log(LOG_TAG, "WORK_MESH_WAKE");
                drain_once().await;
            }
            Ok(_) => { /* SubAck, PingResp, Outgoing, etc. — ignore. */ }
            Err(e) => return Err(format!("eventloop: {e}")),
        }
    }
}

/// Spawn the work-thread listener. Called from `main.rs` `.setup()`.
///
/// Gate-off is a true no-op: the task parks on a slow re-check timer without ever
/// fetching credentials, opening a socket, or touching the feed. Every failure
/// logs and retries with capped exponential backoff — nothing surfaces to the
/// user, and nothing else in the app is affected.
pub fn setup_work_thread_listener(_app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LAUNCH_DELAY).await;

        let mut backoff = BACKOFF_MIN;
        let mut logged_gate_skip = false;
        loop {
            // Re-read the gate every cycle so flipping the pref needs no restart.
            if !work_mesh_enabled() {
                if !logged_gate_skip {
                    log(LOG_TAG, "WORK_MESH_GATE_SKIP workMeshEnabled=false");
                    logged_gate_skip = true;
                }
                tokio::time::sleep(BACKOFF_MAX).await;
                continue;
            }
            logged_gate_skip = false;

            match fetch_realtime_credentials().await {
                Ok(creds) => {
                    let started = SystemTime::now();
                    if let Err(e) = run_once(&creds).await {
                        log(LOG_TAG, &format!("WORK_MESH_DISCONNECT {e}"));
                    }
                    // A connection that actually established resets the backoff so
                    // the next transient drop reconnects fast.
                    if started
                        .elapsed()
                        .map(|d| d > Duration::from_secs(30))
                        .unwrap_or(false)
                    {
                        backoff = BACKOFF_MIN;
                    }
                }
                Err(e) => log(LOG_TAG, &format!("WORK_MESH_CREDS_FAIL {e}")),
            }

            log(
                LOG_TAG,
                &format!("WORK_MESH_RECONNECT in {}s", backoff.as_secs()),
            );
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;

    // ── gate: OFF by default ─────────────────────────────────────────────────

    #[test]
    fn gate_is_off_without_the_env_override() {
        // Serialize against tests that mutate the process-global environment.
        let _env = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("WORK_MESH_ENABLED");
        // With no override, the answer comes from menubar.json's absent-key
        // default, which is FALSE — a machine that never opted in is never armed.
        // (A dev machine with the key explicitly true is the only way this reads
        // true, which is exactly the contract.)
        let from_prefs =
            hq_desktop_core::daemon::read_menubar_bool(|p| p.work_mesh_enabled, false);
        assert_eq!(
            work_mesh_enabled(),
            from_prefs,
            "with no env override the gate must be exactly the pref value"
        );
        assert!(
            !hq_desktop_core::daemon::read_menubar_bool(|_| None, false),
            "an absent workMeshEnabled key must resolve to OFF"
        );
    }

    #[test]
    fn env_override_arms_the_gate() {
        let _env = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("WORK_MESH_ENABLED", "1");
        assert!(work_mesh_enabled());
        // Only the exact "1" arms it — a stray truthy-looking value does not.
        std::env::set_var("WORK_MESH_ENABLED", "true");
        let from_prefs =
            hq_desktop_core::daemon::read_menubar_bool(|p| p.work_mesh_enabled, false);
        assert_eq!(work_mesh_enabled(), from_prefs);
        std::env::remove_var("WORK_MESH_ENABLED");
    }

    // ── threadId dedupe ──────────────────────────────────────────────────────

    #[test]
    fn thread_ids_are_deduped_for_the_process_lifetime() {
        reset_spawned();
        assert!(claim_thread("t-1"), "first sight of a thread wins the claim");
        assert!(
            !claim_thread("t-1"),
            "a repeat wake must NOT re-open the same thread"
        );
        assert!(claim_thread("t-2"), "a different thread is unaffected");
        reset_spawned();
    }

    #[test]
    fn a_failed_launch_releases_the_thread_for_a_later_retry() {
        reset_spawned();
        assert!(claim_thread("t-3"));
        // An unavailable runtime must not consume the thread — otherwise
        // installing the runtime and re-waking would silently do nothing.
        release_thread("t-3");
        assert!(
            claim_thread("t-3"),
            "a released thread must be retryable on the next wake"
        );
        reset_spawned();
    }

    // ── blocked payload ──────────────────────────────────────────────────────

    #[test]
    fn blocked_payload_names_the_provider_and_the_reason() {
        let payload = blocked_payload(LocalProvider::Codex, "ChatGPT.app is not installed");
        assert_eq!(payload["kind"], "blocked");
        let reason = payload["reason"].as_str().expect("reason is a string");
        assert!(reason.contains("codex"), "must name the provider: {reason}");
        assert!(
            reason.contains("ChatGPT.app is not installed"),
            "must carry the underlying reason: {reason}"
        );
        // The append API caps `blocked.reason` at 500 chars.
        assert!(reason.len() <= 500, "reason must fit the server cap");
        assert!(payload["asks"].is_array());
    }

    #[test]
    fn blocked_payload_is_built_for_every_provider() {
        for provider in [
            LocalProvider::Claude,
            LocalProvider::Codex,
            LocalProvider::Grok,
        ] {
            let payload = blocked_payload(provider, "not installed");
            assert!(payload["reason"]
                .as_str()
                .unwrap()
                .contains(provider.tool()));
        }
    }
}
