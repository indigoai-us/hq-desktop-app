//! Direct-message notification client for HQ Sync.
//!
//! A user-to-user "DM via notification" channel layered on the SAME polling
//! infrastructure as `share_notify.rs`. A DM is structurally "a share event
//! minus a file path, plus a reply action".
//!
//! ## Why this mirrors share_notify
//!
//! The 2026-05-28 incident (`workspace/reports/hq-sync-notifications-debug.md`)
//! showed that coupling notification delivery to `sync:all-complete` is fatal:
//! when sync stalls, notifications silently stop. DMs MUST NOT repeat that
//! mistake. `poll_dm_once` is therefore driven by the **independent interval
//! timer** in `share_notify::setup_share_notify_poller` (one timer, two
//! fetches) — never by a sync event.
//!
//! ## Endpoints (hq-cloud, planned — see DM design 2026-05-28)
//!
//!   `GET  /v1/notify/inbox?since=&limit=`  — poll for new DMs (mirrors
//!                                            `/v1/files/shared-with-me`)
//!   `POST /v1/notify/inbox/ack`            — ack delivered DMs
//!   `POST /v1/notify/dm`                    — send a DM to a recipient
//!
//! ## Cursor
//!
//! `~/.hq/dm-cursor.json`, keyed by `machineId` (same scheme as
//! `share-notify-cursor.json`) so each Mac tracks its own inbox position.
//!
//! ## Gating
//!
//! The `dmNotifications` key in `~/.hq/menubar.json` (defaults ON when absent
//! or unreadable). Read directly here rather than via `MenubarPrefs` so adding
//! the DM channel does not force edits to every `MenubarPrefs` literal.
//!
//! ## Log codes (`dm-notify` tag in `~/.hq/logs/hq-sync.log`)
//!
//!   `DM_NOTIFY_POLL_SKIP` / `_START` / `_OK` / `_AUTH_FAIL` /
//!   `_NETWORK_FAIL` / `_ERROR` — mirror the `SHARE_NOTIFY_*` codes.
//!   `DM_NOTIFY_SEND_OK` / `_SEND_FAIL` — outbound send result.

use std::collections::HashMap;
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

pub use hq_desktop_core::dm_notify::{
    build_compose_payload, build_send_payload, build_thread_reply_payload, build_thread_url,
    build_threads_url, classify_send_response, clear_in_flight, diff_requests,
    dm_notifications_enabled, esc_thread_seg, normalize_scope, partition_unnotified,
    read_cursor_entry, respond_action_path, respond_action_state, try_set_in_flight,
    write_cursor_entry, ActiveConversationInner, ActiveConversationState, ActiveThreadInner,
    ActiveThreadState, CursorEntry, DmEvent, InboxResponse, NotificationDmActionEvent,
    PendingDmEvents, RequestsListResponse, SeenChannelState, SeenRequestState, SendDmOutcome,
    ThreadReply, ThreadResponse, ThreadView, UnreadDmState,
};

const LOG_TAG: &str = "dm-notify";

/// Tauri event emitted when new DMs are found (frontend may surface a badge
/// or inbox view; currently informational, mirrors `share:new-events`).
pub const EVENT_DM_NEW_EVENTS: &str = "dm:new-events";

/// Tauri event emitted when the user actions a DM notification — "copy" (write
/// the agent prompt to the clipboard, only when the DM carries a `prompt`) or
/// "open" (open the DM detail window). Every DM is clickable: a body-click maps
/// to "open". Frontend listener lives in App.svelte.
const EVENT_NOTIFICATION_DM_ACTION: &str = "notification:dm-action";

/// Tauri event emitted by the SINGLE poll path when a new reply lands in the
/// thread the user currently has open (US-022). A "thread" wake on the person
/// topic routes through the same `poll_dm_once` → `do_poll` path as DMs/channels
/// (the MQTT wake is ids-only); `do_poll` re-fetches the active thread and emits
/// this for each reply not previously seen. Payload is `{ rootEventId, reply,
/// replyCount }` — the open ThreadPanel appends `reply` and the root bubble in
/// the main Conversation bumps to `replyCount`. Listened for in ThreadPanel +
/// MessagesShell. There is NO parallel thread poller.
pub const EVENT_THREAD_NEW_REPLY: &str = "thread:new-reply";

/// Tauri event emitted by the SINGLE poll path when reactions on a message in
/// the conversation the user currently has open change (US-025). A "reaction"
/// wake on the person topic routes through the same `poll_dm_once` → `do_poll`
/// path as DMs/channels/threads (the MQTT wake is ids-only); `do_poll`
/// re-fetches the open conversation's reactions and emits this for each message
/// whose aggregate set changed since the last poll. Payload is `MessageReactions`
/// (`{ messageScope, messageId, reactions }` — see messages.rs). The open
/// Conversation host applies it via `applyReactionEvent`, reconciling any
/// optimistic toggle. There is NO parallel reaction poller.
pub const EVENT_MESSAGE_REACTION: &str = "message:reaction";

/// Label of the DM detail window (mirrors share-detail).
const DM_DETAIL_LABEL: &str = "dm-detail";

/// Tauri event the DM detail window listens for to receive its event payload.
const EVENT_DM_DETAIL_EVENT: &str = "dm:detail-event";

// ── Wire types ─────────────────────────────────────────────────────────────────

/// Tauri event emitted when the live unread/request counts change so the
/// popover Messages badge stays current without its own poller. Payload is
/// `UnreadSummary` (see messages.rs). Listened for in App.svelte.
pub const EVENT_DM_UNREAD_SUMMARY: &str = "dm:unread-summary";

/// Tauri event emitted by the SINGLE poll path when a brand-new incoming
/// connection request is observed (US-011). Payload is the `DmRequest`. Drives a
/// DISTINCT native banner ("{name} wants to connect") + the popover
/// request-count badge in App.svelte, and the Requests segment in MessagesShell.
pub const EVENT_DM_REQUEST_NEW: &str = "dm:request-new";

/// Tauri event emitted by the SINGLE poll path (and on a respond action) when a
/// pending request changes state (US-011) — e.g. it was accepted and the held
/// message converted to a live thread, or it was declined/blocked. Payload is
/// `{ pairKey, withPersonUid?, state }`. Flips ComposeMessage Pending bubbles
/// and prunes the Requests list. The MQTT `connection_update` wake routes here
/// via the same poll path (the wake is ids-only; the client re-derives state by
/// diffing the requests list it re-fetches).
pub const EVENT_DM_REQUEST_UPDATE: &str = "dm:request-update";

/// Tauri event emitted by the SINGLE poll path when a channel the caller is in
/// has new activity (US-018). Payload is `{ channelId, unread }`. ChannelView
/// (if open on that channel) refreshes its messages; ChannelList bumps the
/// per-channel unread badge; App.svelte folds it into the popover badge accent.
/// The "channel" MQTT wake on the person topic routes here via the same poll
/// path (the wake is ids-only; the client re-derives state by diffing the
/// channels list it re-fetches).
pub const EVENT_CHANNEL_NEW_MESSAGE: &str = "channel:new-message";

/// Tauri event emitted by the SINGLE poll path when a channel's metadata
/// changed (US-018) — a brand-new channel appeared (created/invited), or its
/// name/membership/member-count changed. Payload is the full `Channel` (camel).
/// ChannelList upserts it so a new invite/channel appears live without a manual
/// refresh.
pub const EVENT_CHANNEL_UPDATED: &str = "channel:updated";

/// Add `delta` to the running unread-DM count and emit `dm:unread-summary` so
/// the popover badge updates immediately. Called from `do_poll` (the one
/// poller). Best-effort: if the request count can't be fetched here we emit the
/// DM count alone — `get_unread_summary` reconciles requests on next read.
fn bump_unread(app: &AppHandle, delta: u32) {
    let Some(state) = app.try_state::<UnreadDmState>() else {
        return;
    };
    let total = {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = guard.saturating_add(delta);
        *guard
    };
    // Emit DM count immediately; pendingRequests is filled in on the next
    // explicit get_unread_summary (which does a network read). Keeping the
    // poll path network-free for requests avoids a second fetch per poll.
    let payload = serde_json::json!({ "unreadDms": total, "pendingRequests": 0u32 });
    let _ = app.emit(EVENT_DM_UNREAD_SUMMARY, &payload);
}

/// Read the current unread-DM count from managed state (0 if unset).
pub fn current_unread_dms(app: &AppHandle) -> u32 {
    app.try_state::<UnreadDmState>()
        .map(|s| *s.0.lock().unwrap_or_else(|p| p.into_inner()))
        .unwrap_or(0)
}

/// Reset the unread-DM count to 0. Called when the Messages window opens.
pub fn reset_unread_dms(app: &AppHandle) {
    if let Some(state) = app.try_state::<UnreadDmState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = 0;
    }
}

// ── Public API ───────────────────────────────────────────────────────────────────

/// Fire one DM inbox poll. Singleton-guarded; safe to call from the shared
/// interval timer. Called from `share_notify::setup_share_notify_poller`'s
/// loop (one timer, two fetches) — NOT from a sync event.
pub async fn poll_dm_once(app: AppHandle) {
    if !try_set_in_flight() {
        log(LOG_TAG, "DM_NOTIFY_POLL_SKIP poll already in-flight");
        return;
    }
    do_poll(&app).await;
    clear_in_flight();
}

/// Tauri command: manual poll trigger (frontend / tests).
#[tauri::command]
pub async fn poll_dm_inbox(app: AppHandle) -> Result<(), String> {
    poll_dm_once(app).await;
    Ok(())
}

/// Tauri command: send a DM (a reply from the detail window). Mirrors the auth +
/// URL plumbing of `post_ack`, but — unlike the best-effort ack — surfaces
/// failures to the caller so the UI can show delivery feedback.
///
/// Addresses the recipient by `toPersonUid` (the original sender's
/// `from_person_uid`). The server requires sender and recipient to share an
/// active company membership and rejects self-DMs; a reply to whoever DM'd you
/// always satisfies that. POSTs to `/v1/notify/dm`.
#[tauri::command]
pub async fn send_dm(to_person_uid: String, body: String) -> Result<(), String> {
    let body_text = body.trim();
    if body_text.is_empty() {
        return Err("Message body must not be empty".to_string());
    }

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/dm", base_url);
    let payload = build_send_payload(&to_person_uid, body_text);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if status.is_success() {
        log(LOG_TAG, "DM_NOTIFY_SEND_OK");
        return Ok(());
    }

    // Surface the server's error message when present so the UI can show it.
    let server_msg = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
    log(
        LOG_TAG,
        &format!("DM_NOTIFY_SEND_FAIL status={status} msg={server_msg:?}"),
    );
    Err(server_msg.unwrap_or_else(|| format!("Send failed (status {})", status.as_u16())))
}

// ── Compose: send a DM to an email or personUid (US-010) ─────────────────────────
//
// The New Message compose flow (RecipientPicker + ComposeMessage) lets the user
// start a conversation with anyone — a known contact, a company teammate, or any
// valid email. Unlike `send_dm` (which always replies to a known sender by
// `toPersonUid`), this addresses the recipient by EITHER `toPersonUid` (when the
// picker resolved one) OR `toEmail` (free-text email). The backend
// `POST /v1/notify/dm` answers with one of two shapes:
//
//   200 { "delivered": true }                         — recipient is an active
//                                                        connection; the message
//                                                        was delivered.
//   202 { "state": "connection_requested" }           — recipient is not yet
//                                                        connected; the message
//                                                        is held and a connect
//                                                        request was sent.
//
// `send_dm_to_email` returns that discriminant to the frontend so the compose UI
// can render an optimistic Pending bubble (202) or open the normal thread (200).

/// Tauri command: send a DM from the New Message compose flow (US-010).
///
/// Addresses the recipient by `toPersonUid` (preferred, when the picker resolved
/// one) or `toEmail` (free-text email). Returns a `SendDmOutcome` discriminant so
/// the compose UI can render a Pending bubble (connection requested) or open the
/// normal thread (delivered). Surfaces failures to the caller for delivery
/// feedback. Takes the same guarded blocking-send path as `send_dm`.
#[tauri::command]
pub async fn send_dm_to_email(
    to_email: Option<String>,
    to_person_uid: Option<String>,
    body: String,
) -> Result<SendDmOutcome, String> {
    let body_text = body.trim();
    if body_text.is_empty() {
        return Err("Message body must not be empty".to_string());
    }

    let person_uid = to_person_uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let email = to_email.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if person_uid.is_none() && email.is_none() {
        return Err("A recipient (email or personUid) is required".to_string());
    }

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_COMPOSE_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_COMPOSE_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/dm", base_url);
    let payload = build_compose_payload(person_uid, email, body_text);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_COMPOSE_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_COMPOSE_FAIL status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Send failed (status {})", status.as_u16()))
        );
    }

    let status_code = status.as_u16();
    // The body is optional (a bare 200 with no JSON is treated as delivered).
    let parsed = resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    let outcome = classify_send_response(status_code, &parsed);
    log(
        LOG_TAG,
        &format!("DM_NOTIFY_COMPOSE_OK status={status_code} outcome={outcome:?}"),
    );
    Ok(outcome)
}

// ── Conversation thread (history) ───────────────────────────────────────────────
//
// The DM detail window renders a two-way thread, not just the single DM that
// triggered the notification. The backend stores a conversation-keyed mirror of
// every DM (see hq-pro `dm-thread.ts`) and exposes it at
// `GET /v1/notify/thread?withPersonUid=…`. `fetch_dm_thread` pulls that thread
// for whichever person the open DM is with, so the window can show the history
// above the live message + reply box.

/// Tauri command: fetch the conversation thread with one person. Returns the
/// messages newest-first plus an optional opaque `nextCursor` for loading older
/// pages. Surfaces failures to the caller so the window can show a load error
/// (and still render the single live DM it already has).
#[tauri::command]
pub async fn fetch_dm_thread(
    with_person_uid: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<ThreadResponse, String> {
    let target = with_person_uid.trim();
    if target.is_empty() {
        return Err("withPersonUid must not be empty".to_string());
    }

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = build_thread_url(&base_url, target, limit, cursor.as_deref());

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_FAIL status={status} msg={server_msg:?}"),
        );
        return Err(server_msg
            .unwrap_or_else(|| format!("Failed to load thread (status {})", status.as_u16())));
    }

    let thread = resp.json::<ThreadResponse>().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FAIL parse: {e}"));
        format!("Could not parse thread response: {e}")
    })?;

    log(
        LOG_TAG,
        &format!(
            "DM_NOTIFY_THREAD_OK with={target} count={}",
            thread.messages.len()
        ),
    );
    Ok(thread)
}

// ── Connection requests: list + respond (US-011) ────────────────────────────────
//
// The recipient of an incoming connection request reviews it in the Messages
// "Requests" segment and acts on it. `list_dm_requests` reads the pending set;
// `respond_dm_request` accepts/declines/blocks it. On accept the backend promotes
// the held first message into a live DM_EVENT, so the conversation pane can swap
// the request card for the standard thread on the next thread load.

/// Tauri command: list the caller's pending incoming connection requests.
/// `GET /v1/notify/connections/requests`. Surfaces failures to the caller so the
/// Requests segment can show a load error.
#[tauri::command]
pub async fn list_dm_requests() -> Result<RequestsListResponse, String> {
    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_REQUESTS_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_REQUESTS_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/connections/requests", base_url);

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_REQUESTS_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_REQUESTS_FAIL status={status} msg={server_msg:?}"),
        );
        return Err(server_msg
            .unwrap_or_else(|| format!("Failed to load requests (status {})", status.as_u16())));
    }

    let out = resp.json::<RequestsListResponse>().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_REQUESTS_FAIL parse: {e}"));
        format!("Could not parse requests response: {e}")
    })?;

    log(
        LOG_TAG,
        &format!("DM_NOTIFY_REQUESTS_OK count={}", out.requests.len()),
    );
    Ok(out)
}

/// Tauri command: respond to a pending connection request (US-011).
///
/// `action` is one of `accept` | `decline` | `block`; it POSTs to the matching
/// `/v1/notify/connections/{action}` endpoint with `{ pairKey }`. On success the
/// caller emits `dm:request-update` so the request leaves the Requests segment
/// and (on accept) the held message converts to a thread. Surfaces failures to
/// the caller so the card can show an error and keep its actions.
#[tauri::command]
pub async fn respond_dm_request(
    app: AppHandle,
    pair_key: String,
    action: String,
) -> Result<(), String> {
    let key = pair_key.trim();
    if key.is_empty() {
        return Err("pairKey must not be empty".to_string());
    }
    let path =
        respond_action_path(&action).ok_or_else(|| format!("Unsupported action: {action}"))?;

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_RESPOND_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_RESPOND_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/connections/{}", base_url, path);
    let payload = serde_json::json!({ "pairKey": key });

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_RESPOND_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_RESPOND_FAIL status={status} action={path} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Action failed (status {})", status.as_u16()))
        );
    }

    // The request has left the pending set — drop it from the seen-set so a later
    // poll doesn't treat its disappearance as a second state change.
    if let Some(state) = app.try_state::<SeenRequestState>() {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.pair_keys.remove(key);
    }

    let new_state = respond_action_state(&action);
    let update = serde_json::json!({ "pairKey": key, "state": new_state });
    let _ = app.emit(EVENT_DM_REQUEST_UPDATE, &update);

    log(
        LOG_TAG,
        &format!("DM_NOTIFY_RESPOND_OK action={path} state={new_state}"),
    );
    Ok(())
}

/// Poll the connection-requests list and emit request events off the diff.
/// Folded into the SINGLE `do_poll` path (NOT a parallel poller). Best-effort:
/// any failure logs and returns without disturbing the DM-inbox poll. The first
/// poll seeds the seen-set silently (no banner for the pre-launch backlog).
async fn poll_requests(app: &AppHandle, base_url: &str, access_token: &str) {
    let url = format!("{}/v1/notify/connections/requests", base_url);
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await;

    let list = match resp {
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_REQ_POLL_NETWORK_FAIL {e}"));
            return;
        }
        Ok(r) => {
            let status = r.status();
            if !status.is_success() {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_REQ_POLL_ERROR status={status}"),
                );
                return;
            }
            match r.json::<RequestsListResponse>().await {
                Ok(b) => b,
                Err(e) => {
                    log(LOG_TAG, &format!("DM_NOTIFY_REQ_POLL_ERROR parse: {e}"));
                    return;
                }
            }
        }
    };

    let Some(state) = app.try_state::<SeenRequestState>() else {
        return;
    };

    let (new_requests, removed, first_run) = {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let first_run = !guard.initialized;
        let (new_requests, removed) = diff_requests(&guard.pair_keys, &list.requests);
        // Reconcile the seen-set to exactly the current pending pairKeys.
        guard.pair_keys = list.requests.iter().map(|r| r.pair_key.clone()).collect();
        guard.initialized = true;
        (new_requests, removed, first_run)
    };

    if first_run {
        // Seed silently — the user already had these before launch.
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_REQ_POLL_SEED count={}", list.requests.len()),
        );
        return;
    }

    for req in &new_requests {
        log(
            LOG_TAG,
            &format!(
                "DM_NOTIFY_REQ_NEW from={} pair={}",
                req.from_email, req.pair_key
            ),
        );
        let _ = app.emit(EVENT_DM_REQUEST_NEW, req);
    }
    for pair_key in &removed {
        // The request left the pending set. We can't tell accept vs decline from
        // its disappearance alone, so report a neutral "resolved" flip; on accept
        // the held message arrives via the DM inbox poll and renders the thread.
        let update = serde_json::json!({ "pairKey": pair_key, "state": "resolved" });
        log(LOG_TAG, &format!("DM_NOTIFY_REQ_RESOLVED pair={pair_key}"));
        let _ = app.emit(EVENT_DM_REQUEST_UPDATE, &update);
    }
}

// ── Threads: fetch + reply + fold thread activity into the SINGLE poll (US-022) ──
//
// A thread is a side-conversation hung off a root message (a DM or a channel
// message). The backend (hq-pro, US-021) exposes:
//
//   GET  /v1/notify/threads?rootEventId=&scope=dm|channel[&channelId=|&withPersonUid=]
//        → { root, replies, replyCount }
//   POST /v1/notify/dm                         (+ optional rootEventId) — DM reply
//   POST /v1/notify/channels/{id}/messages     (+ optional rootEventId) — channel reply
//
// Realtime: a "thread" wake ({type:"thread", rootEventId, eventId,...}) lands on
// the person topic and routes through the SAME `poll_dm_once` → `do_poll` path as
// DMs/channels. `do_poll` re-fetches whichever thread the user currently has open
// (tracked in `ActiveThreadState`, set by the frontend when a ThreadPanel opens /
// cleared when it closes) and emits `thread:new-reply` for replies it hasn't seen
// yet. There is NO parallel thread poller.

/// Tauri command: register (or clear) the conversation the open Conversation host
/// currently shows (US-025). Called with the messageScope + the visible message
/// ids when a DM/channel/thread pane opens or its message list changes, so the
/// SINGLE poll path knows which messages to re-fetch reactions for on a
/// "reaction" wake.
///
/// Behavior:
///   * A *new* scope replaces the active conversation and clears the last-seen
///     snapshot (so a switch doesn't suppress the first emit for the new one).
///   * The *same* scope MERGES the message-id sets (deduped). This lets a
///     ThreadPanel (whose replies share the parent conversation's scope) and the
///     main pane coexist over the single active-conversation slot — `poll_reactions`
///     re-fetches the union, and both hosts' `message:reaction` listeners apply
///     the per-message events (each ignoring ids it doesn't render).
///   * A `None` scope clears it (host teardown / close).
#[tauri::command]
pub fn set_active_conversation(
    app: AppHandle,
    scope: Option<String>,
    message_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ActiveConversationState>() else {
        return Ok(());
    };
    let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    match scope.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let incoming: Vec<String> = message_ids
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
                .collect();
            if guard.scope.as_deref() == Some(s) {
                // Same conversation — merge the id sets (dedupe, preserve order).
                for id in incoming {
                    if !guard.message_ids.contains(&id) {
                        guard.message_ids.push(id);
                    }
                }
            } else {
                // A scope change invalidates the last-seen snapshot.
                guard.last_seen.clear();
                guard.scope = Some(s.to_string());
                guard.message_ids = incoming;
            }
            log(LOG_TAG, &format!("DM_NOTIFY_ACTIVE_CONV_SET scope={s}"));
        }
        None => {
            *guard = ActiveConversationInner::default();
            log(LOG_TAG, "DM_NOTIFY_ACTIVE_CONV_CLEAR");
        }
    }
    Ok(())
}

/// Re-fetch reactions for the open conversation and emit `message:reaction` for
/// any message whose aggregate set changed since the last poll (US-025). Folded
/// into the SINGLE `do_poll` path (NOT a parallel poller). Best-effort: any
/// failure logs and returns without disturbing the rest of the poll. No-op when
/// no conversation is open.
async fn poll_reactions(app: &AppHandle, base_url: &str, access_token: &str) {
    // Snapshot the descriptor without holding the lock across the network calls.
    let (scope, message_ids) = {
        let Some(state) = app.try_state::<ActiveConversationState>() else {
            return;
        };
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.scope.clone() {
            Some(s) if !guard.message_ids.is_empty() => (s, guard.message_ids.clone()),
            _ => return, // nothing open / no messages
        }
    };

    for message_id in &message_ids {
        let url = format!(
            "{}/v1/notify/reactions?messageScope={}&messageId={}",
            base_url,
            esc_thread_seg(&scope),
            esc_thread_seg(message_id),
        );
        let resp = build_client()
            .get(&url)
            .header("authorization", format!("Bearer {}", access_token))
            .send()
            .await;

        let reactions = match resp {
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_REACTION_POLL_NETWORK_FAIL {e}"),
                );
                continue;
            }
            Ok(r) => {
                let status = r.status();
                if !status.is_success() {
                    log(
                        LOG_TAG,
                        &format!("DM_NOTIFY_REACTION_POLL_ERROR status={status}"),
                    );
                    continue;
                }
                match r
                    .json::<Vec<crate::commands::messages::ReactionAggregate>>()
                    .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("DM_NOTIFY_REACTION_POLL_ERROR parse: {e}"),
                        );
                        continue;
                    }
                }
            }
        };

        // Compare against the last-emitted snapshot; emit only on a change. Bail
        // if the conversation was closed/swapped while we were fetching.
        let snapshot = serde_json::to_string(&reactions).unwrap_or_default();
        let changed = {
            let Some(state) = app.try_state::<ActiveConversationState>() else {
                return;
            };
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if guard.scope.as_deref() != Some(scope.as_str()) {
                return; // conversation closed or swapped — stale fetch
            }
            if guard.last_seen.get(message_id) == Some(&snapshot) {
                false
            } else {
                guard.last_seen.insert(message_id.clone(), snapshot);
                true
            }
        };

        if changed {
            let payload = crate::commands::messages::MessageReactions {
                message_scope: scope.clone(),
                message_id: message_id.clone(),
                reactions,
            };
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_REACTION_CHANGED scope={scope} id={message_id}"),
            );
            let _ = app.emit(EVENT_MESSAGE_REACTION, &payload);
        }
    }
}

/// Tauri command: fetch one thread (its pinned root + reply list + count).
/// `GET /v1/notify/threads`. `scope` is "dm" | "channel"; a channel thread takes
/// `channel_id`, a DM thread takes `with_person_uid`. Surfaces failures to the
/// caller so the ThreadPanel can show a load error.
#[tauri::command]
pub async fn fetch_thread(
    scope: String,
    root_event_id: String,
    channel_id: Option<String>,
    with_person_uid: Option<String>,
) -> Result<ThreadView, String> {
    let root = root_event_id.trim();
    if root.is_empty() {
        return Err("rootEventId must not be empty".to_string());
    }
    let scope_norm = normalize_scope(&scope);

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FETCH_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_FETCH_FAIL vault url: {e}"),
            );
            format!("Could not resolve server URL: {e}")
        })?;

    let url = build_threads_url(
        &base_url,
        root,
        &scope_norm,
        channel_id.as_deref(),
        with_person_uid.as_deref(),
    );

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_FETCH_FAIL network: {e}"),
            );
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_FETCH_FAIL status={status} msg={server_msg:?}"),
        );
        return Err(server_msg
            .unwrap_or_else(|| format!("Failed to load thread (status {})", status.as_u16())));
    }

    let view = resp.json::<ThreadView>().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_THREAD_FETCH_FAIL parse: {e}"));
        format!("Could not parse thread response: {e}")
    })?;

    log(
        LOG_TAG,
        &format!(
            "DM_NOTIFY_THREAD_FETCH_OK root={root} scope={scope_norm} replies={}",
            view.replies.len()
        ),
    );
    Ok(view)
}

/// Tauri command: post a reply into a thread (US-022). For a DM thread it POSTs
/// `/v1/notify/dm` with `{ toPersonUid, body, rootEventId }`; for a channel
/// thread it POSTs `/v1/notify/channels/{id}/messages` with `{ body, rootEventId }`.
/// Surfaces failures to the caller so the panel composer can show delivery
/// feedback. Takes the same auth + URL plumbing as `send_dm` / `send_channel_message`.
#[tauri::command]
pub async fn send_thread_reply(
    scope: String,
    root_event_id: String,
    body: String,
    channel_id: Option<String>,
    to_person_uid: Option<String>,
) -> Result<(), String> {
    let body_text = body.trim();
    if body_text.is_empty() {
        return Err("Message body must not be empty".to_string());
    }
    let root = root_event_id.trim();
    if root.is_empty() {
        return Err("rootEventId must not be empty".to_string());
    }
    let scope_norm = normalize_scope(&scope);

    let person_uid = to_person_uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let channel = channel_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if scope_norm == "channel" && channel.is_none() {
        return Err("A channel thread reply requires a channelId".to_string());
    }
    if scope_norm == "dm" && person_uid.is_none() {
        return Err("A DM thread reply requires a toPersonUid".to_string());
    }

    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("DM_NOTIFY_THREAD_REPLY_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_REPLY_FAIL vault url: {e}"),
            );
            format!("Could not resolve server URL: {e}")
        })?;

    let url = if scope_norm == "channel" {
        format!(
            "{}/v1/notify/channels/{}/messages",
            base_url,
            esc_thread_seg(channel.unwrap_or_default())
        )
    } else {
        format!("{}/v1/notify/dm", base_url)
    };
    let payload = build_thread_reply_payload(&scope_norm, root, person_uid, body_text);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_REPLY_FAIL network: {e}"),
            );
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if status.is_success() {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_REPLY_OK root={root} scope={scope_norm}"),
        );
        return Ok(());
    }

    let server_msg = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
    log(
        LOG_TAG,
        &format!("DM_NOTIFY_THREAD_REPLY_FAIL status={status} msg={server_msg:?}"),
    );
    Err(server_msg.unwrap_or_else(|| format!("Reply failed (status {})", status.as_u16())))
}

/// Tauri command: register (or clear) the thread the ThreadPanel currently has
/// open (US-022). Called with the root id + scope + the reply ids already shown
/// when a panel opens, so the SINGLE poll path knows which thread to re-fetch on a
/// "thread" wake and which replies it has already surfaced. Called with a `None`
/// root (or the panel-close path) to clear it.
#[tauri::command]
pub fn set_active_thread(
    app: AppHandle,
    root_event_id: Option<String>,
    scope: Option<String>,
    channel_id: Option<String>,
    with_person_uid: Option<String>,
    seen_reply_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ActiveThreadState>() else {
        return Ok(());
    };
    let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    match root_event_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(root) => {
            guard.root_event_id = Some(root.to_string());
            guard.scope = normalize_scope(scope.as_deref().unwrap_or("dm"));
            guard.channel_id = channel_id
                .map(|c| c.trim().to_string())
                .filter(|s| !s.is_empty());
            guard.with_person_uid = with_person_uid
                .map(|c| c.trim().to_string())
                .filter(|s| !s.is_empty());
            guard.seen_reply_ids = seen_reply_ids.unwrap_or_default().into_iter().collect();
            log(LOG_TAG, &format!("DM_NOTIFY_ACTIVE_THREAD_SET root={root}"));
        }
        None => {
            *guard = ActiveThreadInner::default();
            log(LOG_TAG, "DM_NOTIFY_ACTIVE_THREAD_CLEAR");
        }
    }
    Ok(())
}

/// Poll the active thread (if any) and emit `thread:new-reply` for replies the
/// open panel hasn't seen yet. Folded into the SINGLE `do_poll` path (NOT a
/// parallel poller). Best-effort: any failure logs and returns without disturbing
/// the rest of the poll. No-op when no thread is open.
async fn poll_active_thread(app: &AppHandle, base_url: &str, access_token: &str) {
    // Snapshot the active-thread descriptor without holding the lock across the
    // network call.
    let descriptor = {
        let Some(state) = app.try_state::<ActiveThreadState>() else {
            return;
        };
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.root_event_id.as_ref().map(|root| {
            (
                root.clone(),
                guard.scope.clone(),
                guard.channel_id.clone(),
                guard.with_person_uid.clone(),
            )
        })
    };
    let Some((root, scope, channel_id, with_person_uid)) = descriptor else {
        return; // no panel open
    };

    let url = build_threads_url(
        base_url,
        &root,
        &normalize_scope(&scope),
        channel_id.as_deref(),
        with_person_uid.as_deref(),
    );
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await;

    let view = match resp {
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_THREAD_POLL_NETWORK_FAIL {e}"));
            return;
        }
        Ok(r) => {
            let status = r.status();
            if !status.is_success() {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_THREAD_POLL_ERROR status={status}"),
                );
                return;
            }
            match r.json::<ThreadView>().await {
                Ok(v) => v,
                Err(e) => {
                    log(LOG_TAG, &format!("DM_NOTIFY_THREAD_POLL_ERROR parse: {e}"));
                    return;
                }
            }
        }
    };

    // Compute the genuinely-new replies under the lock, then reconcile the
    // seen-set. Bail (without emitting) if the panel was closed or swapped while
    // we were fetching.
    let new_replies: Vec<ThreadReply> = {
        let Some(state) = app.try_state::<ActiveThreadState>() else {
            return;
        };
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if guard.root_event_id.as_deref() != Some(root.as_str()) {
            return; // panel closed or swapped — stale fetch
        }
        let fresh: Vec<ThreadReply> = view
            .replies
            .iter()
            .filter(|r| !guard.seen_reply_ids.contains(&r.event_id))
            .cloned()
            .collect();
        for r in &fresh {
            guard.seen_reply_ids.insert(r.event_id.clone());
        }
        fresh
    };

    if new_replies.is_empty() {
        return;
    }

    // Emit oldest→newest so the panel appends in chronological order. The server
    // returns newest-first, so reverse.
    for reply in new_replies.iter().rev() {
        let payload = serde_json::json!({
            "rootEventId": root,
            "reply": reply,
            "replyCount": view.reply_count,
        });
        log(
            LOG_TAG,
            &format!(
                "DM_NOTIFY_THREAD_NEW_REPLY root={root} reply={}",
                reply.event_id
            ),
        );
        let _ = app.emit(EVENT_THREAD_NEW_REPLY, &payload);
    }
}

// ── Channels: fold channel activity into the SINGLE poll path (US-018) ───────────
//
// A "channel" wake arrives on the caller's person topic and routes through the
// same `poll_dm_once` → `do_poll` path as DMs (the MQTT wake is ids-only). Here
// we list the caller's channels and diff each channel's unread against the
// last-observed value to detect new activity, emitting:
//   * `channel:new-message` { channelId, unread } when a channel's unread grew
//     (or a new channel arrived already carrying unread).
//   * `channel:updated` (full Channel) for a brand-new channel/invite, so the
//     left rail picks it up live.
// There is NO parallel channel poller — this is best-effort and never disturbs
// the DM-inbox poll that follows.

/// The events produced by one channel diff. Pure result type so the diff is
/// unit-testable without an AppHandle.
#[derive(Debug, Default, PartialEq)]
struct ChannelDiff {
    /// (channelId, unread) for channels whose unread increased since last poll.
    new_messages: Vec<(String, u32)>,
    /// channelIds that are brand-new to the caller this poll (fire updated).
    new_channels: Vec<String>,
}

/// Diff the freshly-listed channels against the last-observed unread map.
/// Returns the events to emit. A channel is "new" when its id wasn't seen
/// before; it raises a `new_messages` entry when its unread strictly increased
/// (or it's new AND already carries unread > 0). Pure (operates on the provided
/// map + slice) so the diff is unit-testable.
fn diff_channels(
    seen_unread: &HashMap<String, u32>,
    current: &[crate::commands::messages::Channel],
) -> ChannelDiff {
    let mut diff = ChannelDiff::default();
    for ch in current {
        let unread = ch.unread.unwrap_or(0);
        match seen_unread.get(&ch.channel_id) {
            None => {
                // Brand-new channel/invite this poll.
                diff.new_channels.push(ch.channel_id.clone());
                if unread > 0 {
                    diff.new_messages.push((ch.channel_id.clone(), unread));
                }
            }
            Some(&prev) if unread > prev => {
                diff.new_messages.push((ch.channel_id.clone(), unread));
            }
            _ => {}
        }
    }
    diff
}

/// Poll the channels list and emit channel events off the diff. Folded into the
/// SINGLE `do_poll` path (NOT a parallel poller). Best-effort: any failure logs
/// and returns without disturbing the DM-inbox poll. The first poll seeds the
/// unread map silently (no events for the pre-launch backlog).
async fn poll_channels(app: &AppHandle, base_url: &str, access_token: &str) {
    let url = format!("{}/v1/notify/channels", base_url);
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await;

    let list = match resp {
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_CHAN_POLL_NETWORK_FAIL {e}"));
            return;
        }
        Ok(r) => {
            let status = r.status();
            if !status.is_success() {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_CHAN_POLL_ERROR status={status}"),
                );
                return;
            }
            match r
                .json::<crate::commands::messages::ChannelsResponse>()
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    log(LOG_TAG, &format!("DM_NOTIFY_CHAN_POLL_ERROR parse: {e}"));
                    return;
                }
            }
        }
    };

    let Some(state) = app.try_state::<SeenChannelState>() else {
        return;
    };

    let (diff, channels, first_run) = {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let first_run = !guard.initialized;
        let diff = diff_channels(&guard.unread_by_id, &list.channels);
        // Reconcile the unread map to exactly the current channels.
        guard.unread_by_id = list
            .channels
            .iter()
            .map(|c| (c.channel_id.clone(), c.unread.unwrap_or(0)))
            .collect();
        guard.initialized = true;
        (diff, list.channels, first_run)
    };

    if first_run {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_CHAN_POLL_SEED count={}", channels.len()),
        );
        return;
    }

    // Emit `channel:updated` for brand-new channels/invites (full payload so the
    // rail can render the row without a separate fetch).
    for channel_id in &diff.new_channels {
        if let Some(ch) = channels.iter().find(|c| &c.channel_id == channel_id) {
            log(LOG_TAG, &format!("DM_NOTIFY_CHAN_UPDATED id={channel_id}"));
            let _ = app.emit(EVENT_CHANNEL_UPDATED, ch);
        }
    }
    // Emit `channel:new-message` for channels whose unread grew.
    for (channel_id, unread) in &diff.new_messages {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_CHAN_NEW_MESSAGE id={channel_id} unread={unread}"),
        );
        let payload = serde_json::json!({ "channelId": channel_id, "unread": unread });
        let _ = app.emit(EVENT_CHANNEL_NEW_MESSAGE, &payload);
    }
}

// ── Core poll logic (mirrors share_notify::do_poll) ─────────────────────────────

async fn do_poll(app: &AppHandle) {
    if !dm_notifications_enabled() {
        log(LOG_TAG, "DM_NOTIFY_POLL_SKIP dmNotifications disabled");
        return;
    }

    let machine_id = match crate::commands::config::ensure_machine_id() {
        Ok(id) => id,
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_POLL_ERROR machineId: {e}"));
            return;
        }
    };

    let access_token = match cognito::get_valid_access_token().await {
        Ok(t) => t,
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_POLL_AUTH_FAIL {e}"));
            return;
        }
    };

    let base_url = match resolve_vault_api_url() {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_POLL_ERROR vault url: {e}"));
            return;
        }
    };

    // Fold connection-request polling into the SINGLE poll path (US-011) — NOT a
    // parallel poller. Runs every cycle before the inbox fetch so request events
    // fire even when the DM inbox is empty (the inbox path returns early on an
    // empty body). Best-effort: any failure logs and returns without disturbing
    // the DM-inbox poll below.
    poll_requests(app, &base_url, &access_token).await;

    // Fold channel-activity polling into the SAME single path (US-018) — a
    // "channel" wake on the person topic routes here. Best-effort; emits
    // `channel:new-message` / `channel:updated`. NOT a parallel poller.
    poll_channels(app, &base_url, &access_token).await;

    // Fold thread-activity polling into the SAME single path (US-022) — a
    // "thread" wake on the person topic routes here. Re-fetches whichever thread
    // the ThreadPanel currently has open and emits `thread:new-reply` for replies
    // it hasn't surfaced yet. No-op when no panel is open. NOT a parallel poller.
    poll_active_thread(app, &base_url, &access_token).await;

    // Fold reaction-activity polling into the SAME single path (US-025) — a
    // "reaction" wake on the person topic routes here. Re-fetches reactions for
    // whichever conversation is open and emits `message:reaction` for messages
    // whose aggregate set changed. No-op when no conversation is open. NOT a
    // parallel poller.
    poll_reactions(app, &base_url, &access_token).await;

    let entry = read_cursor_entry(&machine_id);
    let since = entry.cursor.clone();
    let url = match since.as_deref() {
        Some(s) => format!("{}/v1/notify/inbox?since={}&limit=50", base_url, s),
        None => format!("{}/v1/notify/inbox?limit=50", base_url),
    };

    log(LOG_TAG, &format!("DM_NOTIFY_POLL_START since={:?}", since));

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await;

    let body = match resp {
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_POLL_NETWORK_FAIL {e}"));
            return;
        }
        Ok(r) => {
            let status = r.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_POLL_AUTH_FAIL status={status}"),
                );
                return;
            }
            if !status.is_success() {
                log(LOG_TAG, &format!("DM_NOTIFY_POLL_ERROR status={status}"));
                return;
            }
            match r.json::<InboxResponse>().await {
                Ok(b) => b,
                Err(e) => {
                    log(LOG_TAG, &format!("DM_NOTIFY_POLL_ERROR parse: {e}"));
                    return;
                }
            }
        }
    };

    if body.events.is_empty() {
        log(LOG_TAG, "DM_NOTIFY_POLL_OK no new DMs");
        return;
    }

    // Advance the cursor to the newest DM's createdAt across ALL returned events
    // (so it moves forward even when every event was a re-delivered boundary
    // dupe), and dedupe by eventId against the notified ring. Only `fresh` DMs —
    // ones never banner-fired before — drive unread, banners, ack, and the
    // live `dm:new-events` emit. Persist the advanced cursor + grown ring before
    // returning, even on the all-dupes path, so the ring keeps converging.
    let newest = body
        .events
        .iter()
        .map(|e| e.created_at.as_str())
        .max()
        .unwrap_or_default();
    let (fresh, updated_notified) = partition_unnotified(&body.events, &entry.notified);
    write_cursor_entry(
        &machine_id,
        &CursorEntry {
            cursor: (!newest.is_empty()).then(|| newest.to_string()),
            notified: updated_notified,
        },
    );

    if fresh.is_empty() {
        log(
            LOG_TAG,
            &format!(
                "DM_NOTIFY_POLL_OK {} DM(s) all already notified, cursor→{}",
                body.events.len(),
                newest
            ),
        );
        return;
    }

    log(
        LOG_TAG,
        &format!(
            "DM_NOTIFY_POLL_OK {} new DM(s) ({} returned), cursor→{}",
            fresh.len(),
            body.events.len(),
            newest
        ),
    );

    // Extend the SINGLE poll path with unread accounting (US-009) — NOT a
    // parallel poller. Every freshly-polled DM increments the running unread
    // count and emits `dm:unread-summary` so the popover Messages badge stays
    // live. The count is reset when the Messages window opens.
    bump_unread(app, fresh.len() as u32);

    // SPIKE: when the custom banner is enabled, route every DM through the
    // in-app banner (commands::banner) — event-driven, no blocking Cocoa run
    // loop — and skip the native firing path entirely.
    if crate::commands::banner::custom_banner_enabled() {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_CUSTOM_BANNER {} DM(s)", fresh.len()),
        );
        for dm in &fresh {
            if let Err(e) = crate::commands::banner::show_dm_banner(app.clone(), dm.clone()).await {
                log(LOG_TAG, &format!("DM_NOTIFY_BANNER_FAIL err={e}"));
            }
        }
        let event_ids: Vec<String> = fresh.iter().map(|e| e.event_id.clone()).collect();
        // Await (don't detach) so the server-side unread decrement lands within
        // the poll's lifetime. Detaching risked the runtime dropping the task on
        // a quick app quit, leaving the web/other-device unread badge stuck even
        // though this Mac already showed + dismissed the DM. post_ack is
        // best-effort + uses a timed client, so awaiting can't hang the poll.
        post_ack(event_ids).await;
        let _ = app.emit(EVENT_DM_NEW_EVENTS, &fresh);
        return;
    }

    #[cfg(target_os = "macos")]
    {
        // Lazily register the bundle identifier with mac-notification-sys so the
        // first send doesn't trigger a macOS "Choose Application" picker. Mirrors
        // the guard in share_notify::do_poll.
        static NOTIFICATION_APP_INIT: OnceLock<()> = OnceLock::new();
        NOTIFICATION_APP_INIT.get_or_init(|| {
            const BUNDLE_ID: &str = "ai.indigo.hq-sync-menubar";
            match mac_notification_sys::set_application(BUNDLE_ID) {
                Ok(()) => log(LOG_TAG, &format!("DM_NOTIFY_BUNDLE_SET bundle={BUNDLE_ID}")),
                Err(e) => log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_BUNDLE_SET_FAILED bundle={BUNDLE_ID} err={e}"),
                ),
            }
        });

        for dm in &fresh {
            let title = dm.from_display_name.clone();
            let message = dm.body.clone();
            let has_prompt = dm
                .prompt
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_details = dm
                .details
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let app_for_thread = app.clone();
            let event_clone = dm.clone();

            std::thread::spawn(move || {
                let mut notification = mac_notification_sys::Notification::default();
                notification.title(&title).message(&message);

                let mut actions: Vec<&str> = Vec::new();
                if has_prompt {
                    actions.push("Copy prompt");
                }
                if has_details {
                    actions.push("Open details");
                }
                if !actions.is_empty() {
                    notification.main_button(mac_notification_sys::MainButton::DropdownActions(
                        "Actions", &actions,
                    ));
                }

                let response =
                    match crate::commands::share_notify::BlockingNotifyGuard::try_acquire() {
                        Some(guard) => {
                            let r = notification.wait_for_click(true).send();
                            drop(guard);
                            r
                        }
                        None => notification.send(),
                    };

                match response {
                    Ok(resp) => {
                        let action: Option<&'static str> = match resp {
                            mac_notification_sys::NotificationResponse::ActionButton(name)
                                if name.eq_ignore_ascii_case("copy prompt") =>
                            {
                                Some("copy")
                            }
                            mac_notification_sys::NotificationResponse::ActionButton(name)
                                if name.eq_ignore_ascii_case("open details") =>
                            {
                                Some("open")
                            }
                            mac_notification_sys::NotificationResponse::Click => Some("open"),
                            _ => None,
                        };

                        if let Some(action) = action {
                            let payload = NotificationDmActionEvent {
                                action: action.to_string(),
                                event: event_clone,
                            };
                            if let Err(e) =
                                app_for_thread.emit(EVENT_NOTIFICATION_DM_ACTION, &payload)
                            {
                                log(
                                    LOG_TAG,
                                    &format!(
                                        "DM_NOTIFY_EMIT_ACTION_FAILED action={action} err={e}"
                                    ),
                                );
                            }
                        }
                    }
                    Err(e) => log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAILED err={e}")),
                }
            });
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        for dm in &fresh {
            let title = dm.from_display_name.clone();
            let message = dm.body.clone();
            match app
                .notification()
                .builder()
                .title(&title)
                .body(&message)
                .show()
            {
                Ok(()) => log(LOG_TAG, &format!("DM_NOTIFY_TOAST_SHOWN from={title}")),
                Err(e) => log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAILED err={e}")),
            }
        }
    }

    // Ack only the fresh DMs — boundary dupes were acked on the poll where they
    // were first fresh, so each event is acked exactly once. Await (don't detach)
    // so the server-side unread decrement reliably lands within the poll's
    // lifetime; post_ack is best-effort + uses a timed client, so it can't hang.
    let event_ids: Vec<String> = fresh.iter().map(|e| e.event_id.clone()).collect();
    post_ack(event_ids).await;

    let _ = app.emit(EVENT_DM_NEW_EVENTS, &fresh);
}

/// POST `/v1/notify/inbox/ack`. Best-effort: errors logged, never surfaced.
async fn post_ack(event_ids: Vec<String>) {
    let access_token = match cognito::get_valid_access_token().await {
        Ok(t) => t,
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_ACK_AUTH_FAIL {e}"));
            return;
        }
    };
    let base_url = match resolve_vault_api_url() {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_ACK_ERROR vault url: {e}"));
            return;
        }
    };
    let url = format!("{}/v1/notify/inbox/ack", base_url);
    let body = serde_json::json!({ "eventIds": event_ids });

    match build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_ACK_OK {} DM(s)", event_ids.len()),
            );
        }
        Ok(r) => log(
            LOG_TAG,
            &format!("DM_NOTIFY_ACK_ERROR status={}", r.status()),
        ),
        Err(e) => log(LOG_TAG, &format!("DM_NOTIFY_ACK_ERROR {e}")),
    }
}

// ── DM detail window ────────────────────────────────────────────────────────────
//
// Mirrors `open_share_detail` / `share_detail_window_ready` in share_notify.rs:
// stash the event in managed state, create the window hidden, and let the
// renderer's ready-handshake (`dm_detail_window_ready`) pull the payload + show
// the window — avoids the race where emit_to fires before the JS listener mounts.

/// Tauri command: open (or focus) the DM detail window for a single DM event.
/// Invoked by App.svelte's `notification:dm-action` listener on the "open" action.
#[tauri::command]
pub async fn open_dm_detail(app: AppHandle, event: DmEvent) -> Result<(), String> {
    if let Some(state) = app.try_state::<PendingDmEvents>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = vec![event.clone()];
    }

    if let Some(window) = app.get_webview_window(DM_DETAIL_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        app.emit_to(DM_DETAIL_LABEL, EVENT_DM_DETAIL_EVENT, &event)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        DM_DETAIL_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Direct Message")
    .inner_size(560.0, 580.0)
    .resizable(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Tauri command: called by DmDetail.svelte once its listener is registered.
/// Emits the pending event, shows the window, and fires a best-effort ack.
#[tauri::command]
pub async fn dm_detail_window_ready(app: AppHandle) -> Result<(), String> {
    let events: Vec<DmEvent> = app
        .try_state::<PendingDmEvents>()
        .map(|s| s.0.lock().unwrap_or_else(|p| p.into_inner()).clone())
        .unwrap_or_default();

    if let Some(event) = events.first() {
        app.emit_to(DM_DETAIL_LABEL, EVENT_DM_DETAIL_EVENT, event)
            .map_err(|e| e.to_string())?;
    }

    if let Some(window) = app.get_webview_window(DM_DETAIL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    // Best-effort ack so the opened DM isn't re-notified next poll.
    if let Some(event) = events.first() {
        let event_id = event.event_id.clone();
        tauri::async_runtime::spawn(async move {
            post_ack(vec![event_id]).await;
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_channel(id: &str, unread: u32) -> crate::commands::messages::Channel {
        crate::commands::messages::Channel {
            channel_id: id.to_string(),
            name: format!("#{id}"),
            scope: "company".to_string(),
            company_uid: Some("ent_co".to_string()),
            company_name: Some("Acme".to_string()),
            post_policy: None,
            visibility: None,
            membership: Some("joined".to_string()),
            unread: Some(unread),
            member_count: None,
            created_at: None,
            members: None,
        }
    }

    #[test]
    fn diff_channels_first_seed_marks_all_new() {
        // Empty seen map → every channel is "new"; channels with unread>0 also
        // raise a new-message entry. (The seed guard in poll_channels suppresses
        // emission on the very first poll; the diff itself is pure.)
        let seen: HashMap<String, u32> = HashMap::new();
        let current = vec![mk_channel("a", 0), mk_channel("b", 4)];
        let diff = diff_channels(&seen, &current);
        assert_eq!(diff.new_channels, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(diff.new_messages, vec![("b".to_string(), 4)]);
    }

    #[test]
    fn diff_channels_detects_unread_increase_only() {
        // a stayed flat, b grew, c shrank (read elsewhere) → only b fires.
        let mut seen: HashMap<String, u32> = HashMap::new();
        seen.insert("a".to_string(), 2);
        seen.insert("b".to_string(), 1);
        seen.insert("c".to_string(), 5);
        let current = vec![mk_channel("a", 2), mk_channel("b", 3), mk_channel("c", 0)];
        let diff = diff_channels(&seen, &current);
        assert!(diff.new_channels.is_empty());
        assert_eq!(diff.new_messages, vec![("b".to_string(), 3)]);
    }

    #[test]
    fn diff_channels_new_invite_fires_updated() {
        // A brand-new channel with zero unread (a fresh invite) fires updated but
        // no new-message.
        let mut seen: HashMap<String, u32> = HashMap::new();
        seen.insert("a".to_string(), 0);
        let current = vec![mk_channel("a", 0), mk_channel("new", 0)];
        let diff = diff_channels(&seen, &current);
        assert_eq!(diff.new_channels, vec!["new".to_string()]);
        assert!(diff.new_messages.is_empty());
    }

    /// Builds an unnamed, participant-keyed group DM the caller CREATED/OWNS:
    /// `scope: "group"`, empty name, and `unread == 0` (the caller sent the only
    /// message, so it is not unread to them).
    fn mk_owned_group(id: &str) -> crate::commands::messages::Channel {
        crate::commands::messages::Channel {
            channel_id: id.to_string(),
            name: String::new(),
            scope: "group".to_string(),
            company_uid: None,
            company_name: None,
            post_policy: None,
            visibility: None,
            membership: Some("joined".to_string()),
            unread: Some(0),
            member_count: Some(5),
            created_at: None,
            members: None,
        }
    }

    #[test]
    fn diff_channels_emits_updated_for_self_created_owned_group_after_seed() {
        // US-001 investigation: assert the channel-poll diff emits the new channel
        // (→ EVENT_CHANNEL_UPDATED with the full payload in poll_channels) when the
        // poll observes a channelId NOT in its known set after the initial seed —
        // INCLUDING a group DM the signed-in user created/owns (unread 0, unnamed).
        //
        // This is the `hq dm`-created group DM scenario. The diff has NO creator
        // filter: any id absent from `seen_unread` is `new_channels`. So the RUST
        // poll layer is NOT the failing layer — it emits correctly for a
        // self-created/owned channel. (The live-surfacing gap is downstream, in the
        // unified-rail sort: see the RED repro in src/lib/channels.test.ts.)
        let mut seen: HashMap<String, u32> = HashMap::new();
        seen.insert("chn_existing".to_string(), 0); // post-seed known set

        let current = vec![
            mk_channel("chn_existing", 0),
            mk_owned_group("chn_01KV6C02ARDJME1W2ZC9JAX4FX"),
        ];
        let diff = diff_channels(&seen, &current);

        // The self-created group fires `updated` (full payload emitted upstream)…
        assert_eq!(
            diff.new_channels,
            vec!["chn_01KV6C02ARDJME1W2ZC9JAX4FX".to_string()],
            "a self-created/owned group DM not in the seen set must be detected as a new channel",
        );
        // …and raises NO new-message (the owner's own message is not unread).
        assert!(
            diff.new_messages.is_empty(),
            "an owned channel with unread 0 must not raise a new-message event",
        );
    }
}
