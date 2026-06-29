//! Dedicated Messages window + its supporting read commands (US-009).
//!
//! The Messages window (`label = "messages"`) is a resizable master/detail
//! surface opened from the popover header. It is built with the SAME
//! ready-handshake pattern as the DM detail window (`open_dm_detail` /
//! `dm_detail_window_ready` in `dm_notify.rs`): create the window hidden, let
//! the renderer mount its listeners and call `messages_window_ready`, then show
//! the window. There is no per-window payload to stash (the shell self-fetches
//! its data via the commands below), so the handshake here is purely a
//! show-on-ready signal — the window has nothing to render against an
//! `emit_to`-raced payload.
//!
//! ## Commands
//!
//!   `open_messages_window`     — create/focus the window (hidden until ready)
//!   `messages_window_ready`    — renderer→Rust: show + focus the window, reset
//!                                the unread-DM badge
//!   `list_contacts`            — `GET /v1/notify/contacts` (people the caller
//!                                can DM: connections + company teammates)
//!   `list_company_members`     — `GET /v1/notify/contacts?companyUid=…` (the
//!                                teammates in one company)
//!   `get_unread_summary`       — counts for the popover badge: unread DMs
//!                                (managed state, fed by the single DM poll)
//!                                + pending connection requests
//!                                (`GET /v1/notify/connections/requests`)
//!
//! ## Why the unread count lives in dm_notify, not here
//!
//! The unread-DM tally is incremented by the ONE `dm_notify::do_poll` path
//! (no parallel poller — see the PRD hard rule). This module only reads that
//! managed state (`dm_notify::current_unread_dms`) and reconciles it with the
//! pending-request count fetched on demand.
//!
//! ## Log codes (`messages` tag in `~/.hq/logs/hq-sync.log`)
//!
//!   `MESSAGES_WINDOW_OPEN` / `_READY` — window lifecycle.
//!   `MESSAGES_CONTACTS_*` / `MESSAGES_MEMBERS_*` / `MESSAGES_UNREAD_*` —
//!   per-command fetch results, mirroring the `DM_NOTIFY_*` code shape.

use tauri::{AppHandle, Manager};

use crate::commands::cognito;
use crate::commands::dm_notify;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

#[allow(unused_imports)]
pub use hq_desktop_core::messages::{
    build_create_payload, build_group_payload, build_reaction_payload, build_reactions_url,
    esc_seg, invite_member_payload, Channel, ChannelDetail, ChannelMember,
    ChannelMembersResponse, ChannelMessage, ChannelParticipant, ChannelsResponse, Contact,
    ContactsResponse, MessageReactions, ReactionAggregate, RequestsResponse, UnreadSummary,
};

/// POST `url` with the bearer + JSON `payload`, parsing the response body into
/// `T`. Centralizes the status-check + server-error-extraction used by the
/// channel write commands below. Mirrors `get_json` for the read side.
async fn post_json<T: serde::de::DeserializeOwned>(
    url: &str,
    token: &str,
    payload: &serde_json::Value,
    code: &str,
) -> Result<T, String> {
    let resp = build_client()
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .json(payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_NETWORK_FAIL {e}"));
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
            &format!("{code}_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    parse_body::<T>(resp, code).await
}

const LOG_TAG: &str = "messages";

/// Label of the dedicated Messages window. Routed in `src/main.ts`.
const MESSAGES_LABEL: &str = "messages";

// ── Window: open + ready handshake ──────────────────────────────────────────

/// Tauri command: open (or focus) the dedicated Messages window.
///
/// Mirrors `dm_notify::open_dm_detail`: the window is created hidden
/// (`visible(false)`) and only shown by `messages_window_ready` once the
/// renderer has mounted. There is no stashed payload — the shell self-fetches.
#[tauri::command]
pub async fn open_messages_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MESSAGES_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        log(LOG_TAG, "MESSAGES_WINDOW_OPEN focus-existing");
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        MESSAGES_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Messages")
    .inner_size(720.0, 560.0)
    .min_inner_size(420.0, 420.0)
    .resizable(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    log(LOG_TAG, "MESSAGES_WINDOW_OPEN create");
    Ok(())
}

/// Tauri command: called by MessagesShell.svelte once its listeners are
/// mounted. Shows + focuses the window and resets the unread-DM badge (the user
/// is now looking at their messages). Mirrors `dm_detail_window_ready`.
#[tauri::command]
pub async fn messages_window_ready(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MESSAGES_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    // Opening the Messages window clears the unread badge.
    dm_notify::reset_unread_dms(&app);
    log(LOG_TAG, "MESSAGES_WINDOW_READY");
    Ok(())
}

// ── Shared HTTP helper ──────────────────────────────────────────────────────

/// Resolve `(base_url, bearer)` for an authenticated vault call, mapping each
/// failure to a user-facing string. Mirrors the auth+URL preamble used across
/// `dm_notify.rs` commands.
async fn auth_and_base(code: &str) -> Result<(String, String), String> {
    let token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_AUTH_FAIL {e}"));
        format!("Not signed in: {e}")
    })?;
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_ERROR vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;
    Ok((base, token))
}

/// GET `url` with the bearer and parse the JSON body into `T`. Centralizes the
/// status-check + server-error-extraction used by every read command here.
async fn get_json<T: serde::de::DeserializeOwned>(
    url: &str,
    token: &str,
    code: &str,
) -> Result<T, String> {
    let resp = build_client()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_NETWORK_FAIL {e}"));
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
            &format!("{code}_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    parse_body::<T>(resp, code).await
}

/// Like `get_json`, but a `404 Not Found` resolves to `T::default()` instead of
/// an error. Used for optional collections (e.g. a channel roster) where the
/// endpoint may not exist yet server-side — the caller renders an empty list
/// rather than an alarming error banner. Any other non-success status still errors.
async fn get_json_allow_404<T: serde::de::DeserializeOwned + Default>(
    url: &str,
    token: &str,
    code: &str,
) -> Result<T, String> {
    let resp = build_client()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_NETWORK_FAIL {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        log(LOG_TAG, &format!("{code}_EMPTY_404 (treating as empty)"));
        return Ok(T::default());
    }
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("{code}_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    parse_body::<T>(resp, code).await
}

/// Read a successful response body as text, then deserialize into `T`. On a
/// decode failure we log a truncated copy of the RAW body (alongside the serde
/// error) so a server↔client contract drift is diagnosable from
/// `~/.hq/logs/hq-sync.log` instead of surfacing only the opaque "error
/// decoding response body". Shared by `get_json` + `post_json`.
async fn parse_body<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    code: &str,
) -> Result<T, String> {
    let body = resp.text().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_BODY_READ_FAIL {e}"));
        format!("Could not read response: {e}")
    })?;
    serde_json::from_str::<T>(&body).map_err(|e| {
        let snippet: String = body.chars().take(400).collect();
        log(LOG_TAG, &format!("{code}_PARSE_FAIL {e} body={snippet}"));
        format!("Could not parse response: {e}")
    })
}

// ── Read commands ───────────────────────────────────────────────────────────

/// Tauri command: list everyone the caller can DM (active connections + company
/// teammates). `GET /v1/notify/contacts`.
#[tauri::command]
pub async fn list_contacts() -> Result<ContactsResponse, String> {
    let (base, token) = auth_and_base("MESSAGES_CONTACTS").await?;
    let url = format!("{base}/v1/notify/contacts");
    let out: ContactsResponse = get_json(&url, &token, "MESSAGES_CONTACTS").await?;
    log(
        LOG_TAG,
        &format!("MESSAGES_CONTACTS_OK count={}", out.contacts.len()),
    );
    Ok(out)
}

/// Tauri command: list the teammates in one company. `GET
/// /v1/notify/contacts?companyUid=…` — the company-scoped slice of the contacts
/// surface, used by the (later) compose flow's company picker.
#[tauri::command]
pub async fn list_company_members(company_uid: String) -> Result<ContactsResponse, String> {
    let target = company_uid.trim();
    if target.is_empty() {
        return Err("companyUid must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_MEMBERS").await?;
    let url = format!("{base}/v1/notify/contacts?companyUid={target}");
    let out: ContactsResponse = get_json(&url, &token, "MESSAGES_MEMBERS").await?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_MEMBERS_OK company={target} count={}",
            out.contacts.len()
        ),
    );
    Ok(out)
}

/// Tauri command: counts for the popover Messages badge.
///
/// `unread_dms` is read from managed state fed by the SINGLE DM poll path (no
/// parallel poller). `pending_requests` is fetched live from
/// `GET /v1/notify/connections/requests`. A failed request fetch degrades
/// gracefully to 0 pending so the unread count still surfaces.
#[tauri::command]
pub async fn get_unread_summary(app: AppHandle) -> Result<UnreadSummary, String> {
    let unread_dms = dm_notify::current_unread_dms(&app);

    let pending_requests = match auth_and_base("MESSAGES_UNREAD").await {
        Ok((base, token)) => {
            let url = format!("{base}/v1/notify/connections/requests");
            match get_json::<RequestsResponse>(&url, &token, "MESSAGES_UNREAD").await {
                Ok(r) => r.requests.len() as u32,
                Err(_) => 0, // already logged; degrade to 0 rather than fail the badge
            }
        }
        Err(_) => 0,
    };

    log(
        LOG_TAG,
        &format!("MESSAGES_UNREAD_OK dms={unread_dms} requests={pending_requests}"),
    );
    Ok(UnreadSummary {
        unread_dms,
        pending_requests,
    })
}

// ── Channels (US-018) ────────────────────────────────────────────────────────
//
// Channels are multi-party conversations, personal or company-scoped. The
// commands below are thin clients over the hq-pro `/v1/notify/channels*`
// surface; all HTTP happens here in Rust (the webview never holds the bearer).
// Realtime: a "channel" wake arrives on the person topic and is folded into the
// SINGLE DM poll path (`dm_notify::do_poll` → `poll_channels`), which emits the
// `channel:new-message` / `channel:updated` Tauri events — there is NO parallel
// channel poller.
//
//   `list_channels`         — GET    /v1/notify/channels
//   `fetch_channel`         — GET    /v1/notify/channels/{id}/messages (+ meta)
//   `create_channel`        — POST   /v1/notify/channels
//   `join_channel`          — POST   /v1/notify/channels/{id}/members (self)
//   `invite_to_channel`     — POST   /v1/notify/channels/{id}/members (others)
//   `send_channel_message`  — POST   /v1/notify/channels/{id}/messages
//   `list_channel_members`  — GET    /v1/notify/channels/{id}/members
//   `remove_channel_member` — DELETE /v1/notify/channels/{id}/members/{uid}
//   `mark_channel_read`     — POST   /v1/notify/channels/{id}/read

/// Tauri command: list every channel the caller can see (personal + company,
/// joined + invited). `GET /v1/notify/channels`.
#[tauri::command]
pub async fn list_channels() -> Result<ChannelsResponse, String> {
    let (base, token) = auth_and_base("MESSAGES_CHANNELS").await?;
    let url = format!("{base}/v1/notify/channels");
    let out: ChannelsResponse = get_json(&url, &token, "MESSAGES_CHANNELS").await?;
    log(
        LOG_TAG,
        &format!("MESSAGES_CHANNELS_OK count={}", out.channels.len()),
    );
    Ok(out)
}

/// Tauri command: fetch one channel's metadata + its newest page of messages.
/// `GET /v1/notify/channels/{id}/messages`. Opening a channel also marks it
/// read server-side (the page read advances the caller's cursor), but the
/// caller should still call `mark_channel_read` to zero the local unread.
#[tauri::command]
pub async fn fetch_channel(
    channel_id: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<ChannelDetail, String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_FETCH").await?;
    let mut url = format!("{base}/v1/notify/channels/{}/messages", esc_seg(id));
    let mut sep = '?';
    if let Some(n) = limit {
        url.push_str(&format!("{sep}limit={n}"));
        sep = '&';
    }
    if let Some(c) = cursor.as_deref().filter(|c| !c.is_empty()) {
        url.push_str(&format!("{sep}cursor={}", esc_seg(c)));
    }
    let out: ChannelDetail = get_json(&url, &token, "MESSAGES_CHANNEL_FETCH").await?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_CHANNEL_FETCH_OK id={id} msgs={}",
            out.messages.len()
        ),
    );
    Ok(out)
}

/// Tauri command: create a channel. `POST /v1/notify/channels`. `scope` is
/// "personal" | "company"; a company channel requires `company_uid`. Optional
/// `invite` seeds initial members by personUid. Returns the created `Channel`.
#[tauri::command]
pub async fn create_channel(
    name: String,
    scope: String,
    company_uid: Option<String>,
    invite: Option<Vec<String>>,
) -> Result<Channel, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Channel name must not be empty".to_string());
    }
    let scope_norm = scope.trim().to_ascii_lowercase();
    if scope_norm != "personal" && scope_norm != "company" {
        return Err("Channel scope must be 'personal' or 'company'".to_string());
    }
    let company = company_uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if scope_norm == "company" && company.is_none() {
        return Err("A company channel requires a companyUid".to_string());
    }
    let invites = invite.unwrap_or_default();

    let (base, token) = auth_and_base("MESSAGES_CHANNEL_CREATE").await?;
    let url = format!("{base}/v1/notify/channels");
    let payload = build_create_payload(trimmed, &scope_norm, company, &invites);
    // The server wraps the created channel in an envelope: `{"channel": {…}}`.
    // Decoding into `Channel` directly failed with `missing field channelId` even
    // though the channel WAS created — so the user saw an error, retried, and hit
    // a 409 "name already taken". Decode the envelope (reuse `ChannelDetail`,
    // whose `channel` is optional and other fields default) and unwrap it.
    let detail: ChannelDetail =
        post_json(&url, &token, &payload, "MESSAGES_CHANNEL_CREATE").await?;
    let out = detail
        .channel
        .ok_or_else(|| "Create response missing channel object".to_string())?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_CHANNEL_CREATE_OK id={} scope={scope_norm}",
            out.channel_id
        ),
    );
    Ok(out)
}

/// Tauri command: create or reopen a GROUP DM — an unnamed, participant-keyed
/// channel. `POST /v1/notify/channels { scope:"group", participants }`. The
/// caller is added server-side; the server dedupes by member set (idempotent)
/// and requires ≥3 distinct people total. `participants` are personUids or
/// emails (the server resolves emails). Returns the created/reopened `Channel`.
#[tauri::command]
pub async fn create_group_dm(participants: Vec<String>) -> Result<Channel, String> {
    let cleaned: Vec<String> = participants
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if cleaned.len() < 2 {
        return Err("A group DM needs at least 2 other people".to_string());
    }

    let (base, token) = auth_and_base("MESSAGES_GROUP_CREATE").await?;
    let url = format!("{base}/v1/notify/channels");
    let payload = build_group_payload(&cleaned);
    // Same `{"channel": {…}}` envelope as create_channel — decode via ChannelDetail.
    let detail: ChannelDetail = post_json(&url, &token, &payload, "MESSAGES_GROUP_CREATE").await?;
    let out = detail
        .channel
        .ok_or_else(|| "Group create response missing channel object".to_string())?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_GROUP_CREATE_OK id={} members={}",
            out.channel_id,
            cleaned.len()
        ),
    );
    Ok(out)
}

/// Tauri command: join a channel the caller was invited to (or a discoverable
/// company channel). `POST /v1/notify/channels/{id}/members` with no body —
/// the server adds the authenticated caller. Returns the updated `Channel`.
#[tauri::command]
pub async fn join_channel(channel_id: String) -> Result<Channel, String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_JOIN").await?;
    let url = format!("{base}/v1/notify/channels/{}/members", esc_seg(id));
    // Empty body → join self (no `personUid`). The server distinguishes
    // self-join from invite by the presence of `personUid`.
    let payload = serde_json::json!({});
    let out: Channel = post_json(&url, &token, &payload, "MESSAGES_CHANNEL_JOIN").await?;
    log(LOG_TAG, &format!("MESSAGES_CHANNEL_JOIN_OK id={id}"));
    Ok(out)
}

/// Tauri command: invite people to a channel (owner action). `POST
/// /v1/notify/channels/{id}/members`, ONE invitee per request with a body of
/// exactly `{ toPersonUid }` (the server validates "exactly one of toPersonUid
/// or toEmail" and rejects the older `{ personUids: [...] }` batch shape — that
/// mismatch is what broke channel invites). Returns the channel's updated member
/// list (the last response after all invitees are added) so the roster refreshes
/// in place.
#[tauri::command]
pub async fn invite_to_channel(
    channel_id: String,
    person_uids: Vec<String>,
) -> Result<ChannelMembersResponse, String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let cleaned: Vec<String> = person_uids
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Err("At least one person is required".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_INVITE").await?;
    let url = format!("{base}/v1/notify/channels/{}/members", esc_seg(id));
    // The /members endpoint adds one person per POST, keyed by exactly one of
    // toPersonUid / toEmail. We resolve to personUids upstream, so each invitee
    // is a `{ toPersonUid }` body. Keep the final response — it carries the full
    // updated roster.
    let mut latest: Option<ChannelMembersResponse> = None;
    for uid in &cleaned {
        let payload = invite_member_payload(uid);
        let out: ChannelMembersResponse =
            post_json(&url, &token, &payload, "MESSAGES_CHANNEL_INVITE").await?;
        latest = Some(out);
    }
    let out = latest.ok_or_else(|| "At least one person is required".to_string())?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_CHANNEL_INVITE_OK id={id} members={}",
            out.members.len()
        ),
    );
    Ok(out)
}

/// Tauri command: post a message into a channel. `POST
/// /v1/notify/channels/{id}/messages` with `{ body }`. Surfaces failures to the
/// caller (e.g. an owner-only post policy rejection) for composer feedback.
#[tauri::command]
pub async fn send_channel_message(channel_id: String, body: String) -> Result<(), String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let text = body.trim();
    if text.is_empty() {
        return Err("Message body must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_SEND").await?;
    let url = format!("{base}/v1/notify/channels/{}/messages", esc_seg(id));
    let payload = serde_json::json!({ "body": text });
    let _: serde_json::Value = post_json(&url, &token, &payload, "MESSAGES_CHANNEL_SEND").await?;
    log(LOG_TAG, &format!("MESSAGES_CHANNEL_SEND_OK id={id}"));
    Ok(())
}

/// Tauri command: list a channel's members. `GET
/// /v1/notify/channels/{id}/members`. Drives the roster (name + role; the owner
/// sees the remove affordance).
#[tauri::command]
pub async fn list_channel_members(channel_id: String) -> Result<ChannelMembersResponse, String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_MEMBERS").await?;
    let url = format!("{base}/v1/notify/channels/{}/members", esc_seg(id));
    // Tolerate a 404 as an empty roster: the GET endpoint may be absent until the
    // server deploy lands. An empty list renders far better than an error banner.
    let out: ChannelMembersResponse =
        get_json_allow_404(&url, &token, "MESSAGES_CHANNEL_MEMBERS").await?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_CHANNEL_MEMBERS_OK id={id} count={}",
            out.members.len()
        ),
    );
    Ok(out)
}

/// Tauri command: remove a member from a channel (owner action). `DELETE
/// /v1/notify/channels/{id}/members/{personUid}`. Returns the updated member
/// list so the roster refreshes in place.
#[tauri::command]
pub async fn remove_channel_member(
    channel_id: String,
    person_uid: String,
) -> Result<ChannelMembersResponse, String> {
    let id = channel_id.trim();
    let uid = person_uid.trim();
    if id.is_empty() || uid.is_empty() {
        return Err("channelId and personUid must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_REMOVE").await?;
    let url = format!(
        "{base}/v1/notify/channels/{}/members/{}",
        esc_seg(id),
        esc_seg(uid)
    );
    let resp = build_client()
        .delete(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log(
                LOG_TAG,
                &format!("MESSAGES_CHANNEL_REMOVE_NETWORK_FAIL {e}"),
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
            &format!("MESSAGES_CHANNEL_REMOVE_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Remove failed (status {})", status.as_u16()))
        );
    }
    // The server returns the updated member list; tolerate an empty 204 by
    // re-listing only if the body didn't parse.
    let out: ChannelMembersResponse =
        resp.json::<ChannelMembersResponse>()
            .await
            .unwrap_or(ChannelMembersResponse {
                members: Vec::new(),
            });
    log(
        LOG_TAG,
        &format!("MESSAGES_CHANNEL_REMOVE_OK id={id} uid={uid}"),
    );
    Ok(out)
}

/// Tauri command: mark a channel read (zeroes its server-side unread). `POST
/// /v1/notify/channels/{id}/read`. Called when the user opens a channel; the
/// local unread is cleared in the UI immediately and reconciled here.
#[tauri::command]
pub async fn mark_channel_read(channel_id: String) -> Result<(), String> {
    let id = channel_id.trim();
    if id.is_empty() {
        return Err("channelId must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_CHANNEL_READ").await?;
    let url = format!("{base}/v1/notify/channels/{}/read", esc_seg(id));
    let payload = serde_json::json!({});
    let _: serde_json::Value = post_json(&url, &token, &payload, "MESSAGES_CHANNEL_READ").await?;
    log(LOG_TAG, &format!("MESSAGES_CHANNEL_READ_OK id={id}"));
    Ok(())
}

// ── Reactions (US-025) ────────────────────────────────────────────────────────
//
// Emoji reactions on any message (DM, channel, or thread reply). Thin clients
// over the hq-pro US-024 surface; all HTTP happens here in Rust (the webview
// never holds the bearer). The `messageScope` is opaque to this layer — the
// frontend builds it (`dm:{pairKey-or-peer}` | `chan:{channelId}`) and the
// server keys the reactions partition by it. React authorization reuses the
// message domain's read gate server-side (no new auth here).
//
// Realtime: a "reaction" wake arrives on the person topic and is folded into the
// SINGLE DM poll path (`dm_notify::do_poll` → `poll_reactions`), which re-fetches
// the open conversation's reactions and emits the `message:reaction` Tauri event
// — there is NO parallel reaction poller.
//
//   `toggle_reaction` — POST (add) / DELETE (remove) /v1/notify/reactions
//   `fetch_reactions` — GET /v1/notify/reactions?messageScope=&messageId=

/// Tauri command: add or remove the caller's reaction to a message (US-025).
/// `add = true` → POST `/v1/notify/reactions` (idempotent conditional Put);
/// `add = false` → DELETE the exact key. The UI toggles optimistically and
/// reconciles on the `message:reaction` event, so this surfaces failures to the
/// caller for rollback. `message_scope` is opaque (built by the frontend).
#[tauri::command]
pub async fn toggle_reaction(
    message_scope: String,
    message_id: String,
    emoji: String,
    add: bool,
) -> Result<(), String> {
    let scope = message_scope.trim();
    let id = message_id.trim();
    let e = emoji.trim();
    if scope.is_empty() || id.is_empty() || e.is_empty() {
        return Err("messageScope, messageId, and emoji must not be empty".to_string());
    }

    let (base, token) = auth_and_base("MESSAGES_REACTION").await?;
    let url = format!("{base}/v1/notify/reactions");
    let payload = build_reaction_payload(scope, id, e);

    let client = build_client();
    let req = if add {
        client.post(&url)
    } else {
        client.delete(&url)
    };
    let resp = req
        .header("authorization", format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|err| {
            log(LOG_TAG, &format!("MESSAGES_REACTION_NETWORK_FAIL {err}"));
            format!("Network error: {err}")
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
            &format!("MESSAGES_REACTION_ERROR status={status} add={add} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Reaction failed (status {})", status.as_u16()))
        );
    }

    log(
        LOG_TAG,
        &format!("MESSAGES_REACTION_OK add={add} scope={scope} id={id} emoji={e}"),
    );
    Ok(())
}

/// Tauri command: fetch the aggregated reactions for one message (US-025).
/// `GET /v1/notify/reactions?messageScope=&messageId=` → the per-emoji counts
/// with `reactedByMe`. Used for the initial load of a conversation's reactions
/// and as the truth source the `message:reaction` event re-fetches. Surfaces
/// failures so the caller can keep its optimistic state.
#[tauri::command]
pub async fn fetch_reactions(
    message_scope: String,
    message_id: String,
) -> Result<Vec<ReactionAggregate>, String> {
    let scope = message_scope.trim();
    let id = message_id.trim();
    if scope.is_empty() || id.is_empty() {
        return Err("messageScope and messageId must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MESSAGES_REACTIONS_GET").await?;
    let url = build_reactions_url(&base, scope, id);
    // Server returns the `MessageReactions` envelope, not a bare array — decoding
    // into `Vec<ReactionAggregate>` threw `invalid type: map, expected a sequence`
    // on every message load. Decode the object and return its `reactions`.
    let out: MessageReactions = get_json(&url, &token, "MESSAGES_REACTIONS_GET").await?;
    log(
        LOG_TAG,
        &format!(
            "MESSAGES_REACTIONS_GET_OK scope={scope} id={id} count={}",
            out.reactions.len()
        ),
    );
    Ok(out.reactions)
}
