//! Pure and synchronous support for the HQ desktop direct-message notification
//! command layer.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::paths;

/// A single inbound DM as returned by `GET /v1/notify/inbox`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmEvent {
    pub event_id: String,
    /// Canonical personUid of the sender. Used as `toPersonUid` when the
    /// recipient replies from the detail window (see `send_dm`).
    pub from_person_uid: String,
    pub from_email: String,
    pub from_display_name: String,
    pub body: String,
    /// Optional longer-form detail — shown in the DM detail window. Present only
    /// when the sender supplied it; drives whether the "Open details" action shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    /// Optional agent-context prompt the recipient can copy. Present only when
    /// the sender supplied it; drives whether the "Copy prompt" action shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxResponse {
    pub events: Vec<DmEvent>,
    #[allow(dead_code)]
    pub next_cursor: Option<String>,
}

/// One incoming connection request as returned by
/// `GET /v1/notify/connections/requests` (US-011). The recipient sees these in
/// the Messages "Requests" segment and acts on them (accept/decline/block). The
/// held first message is quoted (muted) on the request card.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmRequest {
    /// Symmetric pair key identifying the connection — the action POSTs carry it.
    pub pair_key: String,
    /// Canonical personUid of the requester (the person asking to connect).
    pub from_person_uid: String,
    pub from_email: String,
    pub from_display_name: String,
    /// The held first message the requester sent, if any (quoted on the card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Optional trust hint surfaced on the card, e.g. a shared company name.
    /// Present only when the server supplies it; the card omits the hint when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_company: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestsListResponse {
    #[serde(default)]
    pub requests: Vec<DmRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Action dispatched to the frontend when the user actions a rich DM banner.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDmActionEvent {
    /// One of `"copy"` (write prompt to clipboard) or `"open"` (open detail window).
    pub action: String,
    /// Full DM payload so the frontend can copy the prompt or render details
    /// without re-fetching the inbox.
    pub event: DmEvent,
}

/// Managed state: the DM event pending for the detail window's ready-handshake.
/// Mirrors `PendingShareEvents` in share_notify.rs.
pub struct PendingDmEvents(pub Mutex<Vec<DmEvent>>);

/// Managed state: running count of unread DMs since the user last opened the
/// Messages window. Incremented by the SINGLE `do_poll` path as new DMs land
/// (no parallel poller) and reset to 0 by `mark_messages_read`. The popover
/// badge reads this via `get_unread_summary` and stays live off the
/// `dm:unread-summary` event emitted on every change.
pub struct UnreadDmState(pub Mutex<u32>);

/// Managed state: the set of pending-request pairKeys the SINGLE poll path has
/// already observed (US-011). The poll fetches the current requests list each
/// cycle and diffs it against this set:
///   * a pairKey present now but not before → a NEW request → emit
///     `dm:request-new` + a distinct native banner.
///   * a pairKey present before but gone now → the request left the pending set
///     (accepted/declined/blocked) → emit `dm:request-update` so Pending bubbles
///     flip and the Requests list prunes. The held message (on accept) arrives
///     via the normal DM inbox poll, so no body is carried here.
/// `initialized` guards the first poll: we seed the set without firing a banner
/// for the backlog the user already had before the app launched.
#[derive(Default)]
pub struct SeenRequestsInner {
    pub initialized: bool,
    pub pair_keys: HashSet<String>,
}

pub struct SeenRequestState(pub Mutex<SeenRequestsInner>);

impl SeenRequestState {
    pub fn new() -> Self {
        SeenRequestState(Mutex::new(SeenRequestsInner::default()))
    }
}

/// Managed state for the SINGLE poll path's channel diff (US-018). Tracks, per
/// channel the caller can see, the last-observed unread count so the next poll
/// can detect new activity (unread increased) and emit `channel:new-message`.
/// Also tracks the set of known channelIds so a brand-new channel/invite fires
/// `channel:updated`. `initialized` guards the first poll: we seed the maps
/// without firing events for the backlog the user already had before launch.
#[derive(Default)]
pub struct SeenChannelsInner {
    pub initialized: bool,
    /// channelId → last-observed unread count.
    pub unread_by_id: HashMap<String, u32>,
}

pub struct SeenChannelState(pub Mutex<SeenChannelsInner>);

impl SeenChannelState {
    pub fn new() -> Self {
        SeenChannelState(Mutex::new(SeenChannelsInner::default()))
    }
}

// ── In-flight guard (separate from share-notify's so they never contend) ────────

static POLL_IN_FLIGHT: OnceLock<Mutex<bool>> = OnceLock::new();

pub fn poll_lock() -> &'static Mutex<bool> {
    POLL_IN_FLIGHT.get_or_init(|| Mutex::new(false))
}

pub fn try_set_in_flight() -> bool {
    let mut guard = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
    if *guard {
        false
    } else {
        *guard = true;
        true
    }
}

pub fn clear_in_flight() {
    let mut guard = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
    *guard = false;
}

// ── Cursor persistence (mirrors share_notify) ───────────────────────────────────

/// Upper bound on the per-machine `notified` ring. The repeated boundary events
/// (the cause of the re-notify bug) are always the newest, so they never reach
/// the eviction end of the FIFO — 200 is comfortably more than any single
/// `?since=` page (`limit=50`).
pub const NOTIFIED_CAP: usize = 200;

/// Per-machine cursor state. `cursor` is the ISO8601 `createdAt` of the newest
/// DM seen (the `?since=` value). `notified` is a bounded FIFO of recently
/// banner-fired `eventId`s: the inbox treats `?since=` as **inclusive**, so the
/// boundary DM(s) — and any DM sharing the cursor's exact timestamp — are
/// returned on every subsequent poll. Without an id-level guard that re-fires the
/// same banner each poll/launch (the same class of bug fixed in share_notify on
/// 2026-05-29). Deduping by id makes re-notification impossible regardless of the
/// server's `since` semantics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub notified: Vec<String>,
}

/// Back-compat shim: earlier builds stored a bare ISO string per machine. Accept
/// both the new object form and the legacy string form on read so an upgrade
/// doesn't re-notify every historical DM once.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum CursorEntryCompat {
    Entry(CursorEntry),
    Legacy(String),
}

impl From<CursorEntryCompat> for CursorEntry {
    fn from(c: CursorEntryCompat) -> Self {
        match c {
            CursorEntryCompat::Entry(e) => e,
            CursorEntryCompat::Legacy(s) => CursorEntry {
                cursor: Some(s),
                notified: Vec::new(),
            },
        }
    }
}

pub type CursorStore = HashMap<String, CursorEntry>;

pub fn cursor_path() -> Result<std::path::PathBuf, String> {
    paths::hq_config_dir().map(|d| d.join("dm-cursor.json"))
}

/// Read the whole store, normalising any legacy bare-string entries to the
/// current object shape.
pub fn read_cursor_store() -> CursorStore {
    let Ok(path) = cursor_path() else {
        return CursorStore::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return CursorStore::default();
    };
    match serde_json::from_str::<HashMap<String, CursorEntryCompat>>(&contents) {
        Ok(store) => store.into_iter().map(|(k, v)| (k, v.into())).collect(),
        Err(_) => CursorStore::default(),
    }
}

pub fn read_cursor_entry(machine_id: &str) -> CursorEntry {
    read_cursor_store().remove(machine_id).unwrap_or_default()
}

pub fn write_cursor_entry(machine_id: &str, entry: &CursorEntry) {
    let Ok(path) = cursor_path() else { return };
    // Re-read (with normalisation) so we never clobber other machines' entries.
    let mut store = read_cursor_store();
    store.insert(machine_id.to_string(), entry.clone());
    if let Ok(json) = serde_json::to_string_pretty(&store) {
        let _ = std::fs::write(&path, json);
    }
}

/// Split a poll's DMs into the subset to notify (dropping any whose `eventId` is
/// already in `notified`, preserving order) and the updated `notified` ring
/// (bounded to [`NOTIFIED_CAP`], newest at the end). Pure so it is unit-testable
/// without the filesystem or network.
pub fn partition_unnotified(
    events: &[DmEvent],
    notified: &[String],
) -> (Vec<DmEvent>, Vec<String>) {
    let seen: HashSet<&str> = notified.iter().map(String::as_str).collect();
    let fresh: Vec<DmEvent> = events
        .iter()
        .filter(|e| !seen.contains(e.event_id.as_str()))
        .cloned()
        .collect();

    let mut updated = notified.to_vec();
    updated.extend(fresh.iter().map(|e| e.event_id.clone()));
    if updated.len() > NOTIFIED_CAP {
        updated.drain(0..updated.len() - NOTIFIED_CAP);
    }
    (fresh, updated)
}

// ── Gate ────────────────────────────────────────────────────────────────────────

/// True unless the user explicitly set `dmNotifications: false` in
/// `~/.hq/menubar.json`. Read directly (not via `MenubarPrefs`) so the DM
/// channel is additive — see module doc. Missing key / unreadable → ON.
pub fn dm_notifications_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let path = dir.join("menubar.json");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("dmNotifications")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Build the `POST /v1/notify/dm` request body for a reply. Matches the server
/// contract in hq-pro `notify-dm.ts` (`handleSendDm`): exactly one recipient key
/// plus a `body` string. Pure + side-effect-free so the wire shape is testable.
pub fn build_send_payload(to_person_uid: &str, body: &str) -> serde_json::Value {
    serde_json::json!({ "toPersonUid": to_person_uid, "body": body })
}

/// The outcome of a compose send, surfaced to the frontend.
///
/// `delivered` → the message reached an active connection (HTTP 200).
/// `connection_requested` → the recipient isn't connected; the message is held
/// and a connect request was sent (HTTP 202). The compose UI renders a Pending
/// bubble for this case until `dm:request-update` confirms (US-011).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SendDmOutcome {
    /// HTTP 200 — delivered to an active connection.
    Delivered,
    /// HTTP 202 — held; a connection request was sent alongside the message.
    ConnectionRequested,
}

/// Build the `POST /v1/notify/dm` body for a compose send. Exactly one recipient
/// key is emitted: `toPersonUid` when present (preferred — the picker resolved a
/// canonical id), otherwise `toEmail`. The server rejects a request with both
/// keys, so this never emits both. Pure + side-effect-free so the wire shape is
/// unit-testable.
pub fn build_compose_payload(
    to_person_uid: Option<&str>,
    to_email: Option<&str>,
    body: &str,
) -> serde_json::Value {
    match to_person_uid.map(str::trim).filter(|s| !s.is_empty()) {
        Some(uid) => serde_json::json!({ "toPersonUid": uid, "body": body }),
        None => {
            let email = to_email.map(str::trim).unwrap_or_default();
            serde_json::json!({ "toEmail": email, "body": body })
        }
    }
}

/// Map a successful `POST /v1/notify/dm` response to a `SendDmOutcome`.
/// A 202 (or an explicit `{"state":"connection_requested"}` body) means the
/// recipient isn't connected yet; anything else 2xx means delivered. Pure so the
/// status→discriminant mapping is unit-testable.
pub fn classify_send_response(status: u16, body: &serde_json::Value) -> SendDmOutcome {
    let body_says_requested = body
        .get("state")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("connection_requested"))
        .unwrap_or(false);
    if status == 202 || body_says_requested {
        SendDmOutcome::ConnectionRequested
    } else {
        SendDmOutcome::Delivered
    }
}

/// One message in a conversation thread, as returned by `/v1/notify/thread`.
/// `direction` is tagged by the server relative to the signed-in caller:
/// `"out"` = the caller sent it, `"in"` = the counterparty sent it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub event_id: String,
    pub from_person_uid: String,
    pub from_email: String,
    pub from_display_name: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub created_at: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResponse {
    pub messages: Vec<ThreadMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Build the `GET /v1/notify/thread` URL. Pure + side-effect-free so the query
/// shape is unit-testable. urlencoding isn't pulled in here; personUids and the
/// base64 cursor are URL-safe, so simple concatenation is sufficient. An
/// empty/blank cursor is omitted so the server returns the first (newest) page.
pub fn build_thread_url(
    base_url: &str,
    with_person_uid: &str,
    limit: Option<u32>,
    cursor: Option<&str>,
) -> String {
    let mut url = format!(
        "{}/v1/notify/thread?withPersonUid={}",
        base_url, with_person_uid
    );
    if let Some(n) = limit {
        url.push_str(&format!("&limit={}", n));
    }
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        url.push_str(&format!("&cursor={}", c));
    }
    url
}

/// Map a respond action to the backend endpoint path segment. Only the three
/// recipient-side actions are valid here (`unblock` is handled elsewhere). Pure
/// so the action→path mapping is unit-testable. Returns `None` for an unknown
/// action so the command can reject it without an unguarded request.
pub fn respond_action_path(action: &str) -> Option<&'static str> {
    match action.trim().to_ascii_lowercase().as_str() {
        "accept" => Some("accept"),
        "decline" => Some("decline"),
        "block" => Some("block"),
        _ => None,
    }
}

/// Map a respond action to the resulting connection state surfaced to the UI in
/// the `dm:request-update` flip. Pure so the mapping is unit-testable.
pub fn respond_action_state(action: &str) -> &'static str {
    match action.trim().to_ascii_lowercase().as_str() {
        "accept" => "active",
        "decline" => "declined",
        "block" => "blocked",
        _ => "unknown",
    }
}

/// Diff the freshly-polled request set against the previously-seen pairKeys.
/// Returns `(new_requests, removed_pair_keys)`:
///   * `new_requests` — requests whose pairKey wasn't seen before (fire
///     `dm:request-new` + banner).
///   * `removed_pair_keys` — pairKeys seen before but absent now (fire
///     `dm:request-update`; the connection left the pending set).
/// Pure (operates on the provided set + slice) so the diff is unit-testable.
pub fn diff_requests(
    seen: &HashSet<String>,
    current: &[DmRequest],
) -> (Vec<DmRequest>, Vec<String>) {
    let current_keys: HashSet<&str> = current.iter().map(|r| r.pair_key.as_str()).collect();
    let new_requests: Vec<DmRequest> = current
        .iter()
        .filter(|r| !seen.contains(&r.pair_key))
        .cloned()
        .collect();
    let removed: Vec<String> = seen
        .iter()
        .filter(|k| !current_keys.contains(k.as_str()))
        .cloned()
        .collect();
    (new_requests, removed)
}

/// One message in a thread (the pinned root or a reply). Same wire shape as a DM
/// `ThreadMessage` / channel `ChannelMessage` — `direction` is tagged by the
/// server relative to the caller ("in"/"out"). Tolerant of server additions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReply {
    pub event_id: String,
    pub from_person_uid: String,
    #[serde(default)]
    pub from_email: String,
    #[serde(default)]
    pub from_display_name: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub direction: String,
}

/// The full thread view returned by `GET /v1/notify/threads`: the pinned root
/// message, the reply list (newest-first, like the other thread/channel fetches),
/// and the authoritative `replyCount`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub root: ThreadReply,
    #[serde(default)]
    pub replies: Vec<ThreadReply>,
    #[serde(default)]
    pub reply_count: u32,
}

/// Managed state: the thread the user currently has open in the ThreadPanel, if
/// any (US-022). Set by `set_active_thread` when a panel opens and cleared when it
/// closes. The SINGLE poll path reads this to know which thread to re-fetch on a
/// "thread" wake and which reply event-ids it has already surfaced, so it only
/// emits `thread:new-reply` for genuinely new replies.
#[derive(Default)]
pub struct ActiveThreadInner {
    /// The root message id of the open thread (`None` = no panel open).
    pub root_event_id: Option<String>,
    /// "dm" | "channel".
    pub scope: String,
    /// Present for a channel thread.
    pub channel_id: Option<String>,
    /// Present for a DM thread.
    pub with_person_uid: Option<String>,
    /// Reply event-ids already surfaced (seeded on open) so the poll only emits
    /// genuinely-new replies.
    pub seen_reply_ids: HashSet<String>,
}

pub struct ActiveThreadState(pub Mutex<ActiveThreadInner>);

impl ActiveThreadState {
    pub fn new() -> Self {
        ActiveThreadState(Mutex::new(ActiveThreadInner::default()))
    }
}

/// Managed state: the conversation the user currently has open and the message
/// ids visible in it, so the SINGLE poll path can re-fetch reactions on a
/// "reaction" wake (US-025). Set by `set_active_conversation` when a Conversation
/// host opens/changes its message list and cleared when it closes. The poll path
/// reads `scope` + `message_ids` to know what to re-fetch, and `last_seen` (a
/// per-message JSON snapshot of the last-emitted aggregate set) so it only emits
/// `message:reaction` for messages whose reactions actually changed.
#[derive(Default)]
pub struct ActiveConversationInner {
    /// The open conversation's messageScope (`dm:…` | `chan:…`); `None` = none.
    pub scope: Option<String>,
    /// The eventIds currently rendered in the open Conversation.
    pub message_ids: Vec<String>,
    /// messageId → last-emitted aggregate snapshot (serialized) so the poll only
    /// emits genuinely-changed reaction sets.
    pub last_seen: HashMap<String, String>,
}

pub struct ActiveConversationState(pub Mutex<ActiveConversationInner>);

impl ActiveConversationState {
    pub fn new() -> Self {
        ActiveConversationState(Mutex::new(ActiveConversationInner::default()))
    }
}

/// Build the `GET /v1/notify/threads` URL. Pure + side-effect-free so the query
/// shape is unit-testable. Exactly one of `channelId` / `withPersonUid` rides
/// alongside `rootEventId` + `scope`, matching the US-021 contract. Segments are
/// minimally escaped (`esc_thread_seg`) so a reserved char can't break the URL.
pub fn build_threads_url(
    base_url: &str,
    root_event_id: &str,
    scope: &str,
    channel_id: Option<&str>,
    with_person_uid: Option<&str>,
) -> String {
    let mut url = format!(
        "{}/v1/notify/threads?rootEventId={}&scope={}",
        base_url,
        esc_thread_seg(root_event_id),
        esc_thread_seg(scope),
    );
    match scope {
        "channel" => {
            if let Some(id) = channel_id.map(str::trim).filter(|s| !s.is_empty()) {
                url.push_str(&format!("&channelId={}", esc_thread_seg(id)));
            }
        }
        _ => {
            if let Some(uid) = with_person_uid.map(str::trim).filter(|s| !s.is_empty()) {
                url.push_str(&format!("&withPersonUid={}", esc_thread_seg(uid)));
            }
        }
    }
    url
}

/// Minimal query-value escape for thread URL params (server-issued ids are
/// URL-safe; this is defense-in-depth, mirroring `messages::esc_seg`). Keeps the
/// dep surface at zero — only the reserved chars that would break the query.
pub fn esc_thread_seg(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            ' ' => "%20".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Normalize a thread scope to "dm" | "channel" (defaults to "dm" for anything
/// unrecognized). Pure so the mapping is unit-testable.
pub fn normalize_scope(scope: &str) -> String {
    match scope.trim().to_ascii_lowercase().as_str() {
        "channel" => "channel".to_string(),
        _ => "dm".to_string(),
    }
}

/// Build the reply POST body for a thread reply. Always carries `body` +
/// `rootEventId`; a DM reply also carries `toPersonUid` (channel replies address
/// the channel via the URL path). Pure so the wire shape is unit-testable.
pub fn build_thread_reply_payload(
    scope: &str,
    root_event_id: &str,
    to_person_uid: Option<&str>,
    body: &str,
) -> serde_json::Value {
    if scope == "channel" {
        serde_json::json!({ "body": body, "rootEventId": root_event_id })
    } else {
        let uid = to_person_uid.unwrap_or_default();
        serde_json::json!({ "toPersonUid": uid, "body": body, "rootEventId": root_event_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_payload_uses_to_person_uid_and_body() {
        let payload = build_send_payload("prs_abc123", "hey there");
        assert_eq!(payload["toPersonUid"], "prs_abc123");
        assert_eq!(payload["body"], "hey there");
        // Exactly two keys — no stray `toEmail` (server rejects both present).
        let obj = payload.as_object().expect("payload is a JSON object");
        assert_eq!(obj.len(), 2);
        assert!(!obj.contains_key("toEmail"));
    }

    #[test]
    fn compose_payload_prefers_person_uid_single_key() {
        // When a personUid is resolved, address by it — never emit toEmail too
        // (the server rejects both present).
        let payload = build_compose_payload(Some("prs_x"), Some("a@b.com"), "hi");
        let obj = payload.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert_eq!(payload["toPersonUid"], "prs_x");
        assert_eq!(payload["body"], "hi");
        assert!(!obj.contains_key("toEmail"));
    }

    #[test]
    fn compose_payload_falls_back_to_email_single_key() {
        // Free-text email with no resolved personUid → address by toEmail only.
        let payload = build_compose_payload(None, Some("new@person.com"), "hello");
        let obj = payload.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert_eq!(payload["toEmail"], "new@person.com");
        assert!(!obj.contains_key("toPersonUid"));
        // A blank personUid is treated as absent.
        let blank = build_compose_payload(Some("   "), Some("x@y.com"), "h");
        assert_eq!(blank["toEmail"], "x@y.com");
        assert!(!blank.as_object().unwrap().contains_key("toPersonUid"));
    }

    #[test]
    fn classify_send_response_maps_status_and_body() {
        let null = serde_json::Value::Null;
        // 200 → delivered.
        assert_eq!(classify_send_response(200, &null), SendDmOutcome::Delivered);
        // 202 → connection requested even with an empty body.
        assert_eq!(
            classify_send_response(202, &null),
            SendDmOutcome::ConnectionRequested
        );
        // An explicit body state wins even on a 200 (defensive).
        let body = serde_json::json!({ "state": "connection_requested" });
        assert_eq!(
            classify_send_response(200, &body),
            SendDmOutcome::ConnectionRequested
        );
        // A delivered body on 200 stays delivered.
        let delivered = serde_json::json!({ "delivered": true });
        assert_eq!(
            classify_send_response(200, &delivered),
            SendDmOutcome::Delivered
        );
    }

    #[test]
    fn send_dm_outcome_serializes_to_state_tag() {
        // The frontend discriminates on `state` — lock the wire shape.
        let requested = serde_json::to_value(SendDmOutcome::ConnectionRequested).unwrap();
        assert_eq!(requested["state"], "connectionRequested");
        let delivered = serde_json::to_value(SendDmOutcome::Delivered).unwrap();
        assert_eq!(delivered["state"], "delivered");
    }

    #[test]
    fn dm_event_deserializes_camel_case_from_inbox() {
        // The reply target (`fromPersonUid`) must survive the wire round-trip so
        // the detail window can address a reply to the original sender.
        let json = r#"{
            "eventId": "evt_1",
            "fromPersonUid": "prs_sender",
            "fromEmail": "a@b.com",
            "fromDisplayName": "Ada",
            "body": "hi",
            "createdAt": "2026-05-29T00:00:00Z"
        }"#;
        let dm: DmEvent = serde_json::from_str(json).expect("DmEvent parses");
        assert_eq!(dm.from_person_uid, "prs_sender");
        assert_eq!(dm.body, "hi");
        assert!(dm.prompt.is_none());
        assert!(dm.details.is_none());
    }

    fn mk_dm(event_id: &str, created_at: &str) -> DmEvent {
        DmEvent {
            event_id: event_id.to_string(),
            from_person_uid: "prs_sender".to_string(),
            from_email: "a@b.com".to_string(),
            from_display_name: "Ada".to_string(),
            body: "hi".to_string(),
            details: None,
            prompt: None,
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn partition_unnotified_drops_already_notified_boundary_dupes() {
        // The inbox treats `?since=` as inclusive, so the boundary DM (e1) comes
        // back on the next poll. With e1 already in the ring, only e2 is fresh —
        // no duplicate banner. The ring grows to include the newly-fired e2.
        let events = vec![
            mk_dm("e1", "2026-06-05T00:00:00Z"),
            mk_dm("e2", "2026-06-05T00:01:00Z"),
        ];
        let (fresh, updated) = partition_unnotified(&events, &["e1".to_string()]);
        assert_eq!(
            fresh
                .iter()
                .map(|e| e.event_id.as_str())
                .collect::<Vec<_>>(),
            ["e2"]
        );
        assert_eq!(updated, ["e1", "e2"]);
    }

    #[test]
    fn partition_unnotified_all_seen_returns_empty() {
        // Every returned DM already notified → nothing fresh, ring unchanged.
        let events = vec![mk_dm("e1", "t1"), mk_dm("e2", "t2")];
        let (fresh, updated) = partition_unnotified(&events, &["e1".to_string(), "e2".to_string()]);
        assert!(fresh.is_empty());
        assert_eq!(updated, ["e1", "e2"]);
    }

    #[test]
    fn partition_unnotified_ring_is_bounded_newest_kept() {
        // The FIFO never exceeds NOTIFIED_CAP; the oldest ids evict first and the
        // just-fired (newest) id is always retained.
        let prior: Vec<String> = (0..NOTIFIED_CAP).map(|i| format!("old{i}")).collect();
        let events = vec![mk_dm("newest", "t")];
        let (fresh, updated) = partition_unnotified(&events, &prior);
        assert_eq!(fresh.len(), 1);
        assert_eq!(updated.len(), NOTIFIED_CAP);
        assert_eq!(updated.last().unwrap(), "newest");
        assert_eq!(updated.first().unwrap(), "old1"); // old0 evicted
    }

    #[test]
    fn cursor_entry_compat_upgrades_legacy_bare_string() {
        // Earlier builds stored `{"machineX":"2026-06-05T00:00:00Z"}`. Reading it
        // must yield a cursor with an empty ring — not re-notify history.
        let legacy = r#"{"machineX":"2026-06-05T00:00:00Z"}"#;
        let store: HashMap<String, CursorEntryCompat> = serde_json::from_str(legacy).unwrap();
        let entry: CursorEntry = store.into_iter().next().unwrap().1.into();
        assert_eq!(entry.cursor.as_deref(), Some("2026-06-05T00:00:00Z"));
        assert!(entry.notified.is_empty());

        // And the new object form round-trips with its ring intact.
        let modern = r#"{"machineX":{"cursor":"t","notified":["e1","e2"]}}"#;
        let store: HashMap<String, CursorEntryCompat> = serde_json::from_str(modern).unwrap();
        let entry: CursorEntry = store.into_iter().next().unwrap().1.into();
        assert_eq!(entry.cursor.as_deref(), Some("t"));
        assert_eq!(entry.notified, ["e1", "e2"]);
    }

    #[test]
    fn thread_url_includes_person_and_optional_params() {
        // Base case: just the recipient.
        assert_eq!(
            build_thread_url("https://api.example.com", "prs_x", None, None),
            "https://api.example.com/v1/notify/thread?withPersonUid=prs_x",
        );
        // Limit + cursor appended in order.
        assert_eq!(
            build_thread_url("https://api.example.com", "prs_x", Some(25), Some("Y3Vy")),
            "https://api.example.com/v1/notify/thread?withPersonUid=prs_x&limit=25&cursor=Y3Vy",
        );
        // A blank cursor is omitted (server returns the newest page).
        assert_eq!(
            build_thread_url("https://api.example.com", "prs_x", None, Some("")),
            "https://api.example.com/v1/notify/thread?withPersonUid=prs_x",
        );
    }

    fn mk_request(pair_key: &str) -> DmRequest {
        DmRequest {
            pair_key: pair_key.to_string(),
            from_person_uid: "prs_x".to_string(),
            from_email: "x@y.com".to_string(),
            from_display_name: "Ex".to_string(),
            message: None,
            shared_company: None,
            created_at: "2026-06-05T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn respond_action_path_maps_known_actions_only() {
        assert_eq!(respond_action_path("accept"), Some("accept"));
        assert_eq!(respond_action_path("Decline"), Some("decline"));
        assert_eq!(respond_action_path("  BLOCK "), Some("block"));
        // Unknown / unsupported actions are rejected (no unguarded request).
        assert_eq!(respond_action_path("unblock"), None);
        assert_eq!(respond_action_path(""), None);
        assert_eq!(respond_action_path("delete"), None);
    }

    #[test]
    fn respond_action_state_maps_to_ui_states() {
        assert_eq!(respond_action_state("accept"), "active");
        assert_eq!(respond_action_state("decline"), "declined");
        assert_eq!(respond_action_state("block"), "blocked");
        assert_eq!(respond_action_state("nope"), "unknown");
    }

    #[test]
    fn diff_requests_detects_new_and_removed() {
        // Seen had {a, b}; current has {b, c}. → new = [c], removed = [a].
        let seen: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let current = vec![mk_request("b"), mk_request("c")];
        let (new_requests, removed) = diff_requests(&seen, &current);
        assert_eq!(new_requests.len(), 1);
        assert_eq!(new_requests[0].pair_key, "c");
        assert_eq!(removed, vec!["a".to_string()]);
    }

    #[test]
    fn diff_requests_first_run_all_new_none_removed() {
        // Empty seen-set (first poll before seeding) → every current request is
        // "new" and nothing is removed. The seed guard in poll_requests is what
        // suppresses the banner on the very first run; the diff itself is pure.
        let seen: HashSet<String> = HashSet::new();
        let current = vec![mk_request("a"), mk_request("b")];
        let (new_requests, removed) = diff_requests(&seen, &current);
        assert_eq!(new_requests.len(), 2);
        assert!(removed.is_empty());
    }

    #[test]
    fn diff_requests_stable_set_no_events() {
        // Unchanged pending set → no new, no removed (no spurious events/banners).
        let seen: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let current = vec![mk_request("a"), mk_request("b")];
        let (new_requests, removed) = diff_requests(&seen, &current);
        assert!(new_requests.is_empty());
        assert!(removed.is_empty());
    }

    #[test]
    fn dm_request_deserializes_camel_case_from_requests_endpoint() {
        // The card needs pairKey (for the action POST) + the held message to
        // survive the wire round-trip; the trust hint is optional.
        let json = r#"{
            "pairKey": "pair_ab",
            "fromPersonUid": "prs_req",
            "fromEmail": "req@b.com",
            "fromDisplayName": "Reqer",
            "message": "hey, can we connect?",
            "sharedCompany": "Indigo",
            "createdAt": "2026-06-05T00:00:00Z"
        }"#;
        let req: DmRequest = serde_json::from_str(json).expect("DmRequest parses");
        assert_eq!(req.pair_key, "pair_ab");
        assert_eq!(req.from_person_uid, "prs_req");
        assert_eq!(req.message.as_deref(), Some("hey, can we connect?"));
        assert_eq!(req.shared_company.as_deref(), Some("Indigo"));
    }

    #[test]
    fn requests_list_response_tolerates_missing_fields() {
        // An empty/absent requests array and absent cursor must not break parsing
        // (the Requests segment renders the empty state).
        let empty: RequestsListResponse =
            serde_json::from_str("{}").expect("empty requests parses");
        assert!(empty.requests.is_empty());
        assert!(empty.next_cursor.is_none());
    }

    #[test]
    fn thread_response_deserializes_camel_case_with_direction() {
        // Server tags `direction` relative to the caller; the window renders
        // "out" right-aligned and "in" left-aligned. nextCursor is optional.
        let json = r#"{
            "messages": [
                {
                    "eventId": "evt_2",
                    "fromPersonUid": "prs_me",
                    "fromEmail": "me@b.com",
                    "fromDisplayName": "Me",
                    "body": "my reply",
                    "createdAt": "2026-05-29T00:01:00Z",
                    "direction": "out"
                },
                {
                    "eventId": "evt_1",
                    "fromPersonUid": "prs_them",
                    "fromEmail": "them@b.com",
                    "fromDisplayName": "Them",
                    "body": "their msg",
                    "createdAt": "2026-05-29T00:00:00Z",
                    "direction": "in"
                }
            ]
        }"#;
        let thread: ThreadResponse = serde_json::from_str(json).expect("ThreadResponse parses");
        assert_eq!(thread.messages.len(), 2);
        assert_eq!(thread.messages[0].direction, "out");
        assert_eq!(thread.messages[0].from_person_uid, "prs_me");
        assert_eq!(thread.messages[1].direction, "in");
        assert!(thread.next_cursor.is_none());
    }

    // ── Threads (US-022) ──────────────────────────────────────────────────────

    #[test]
    fn threads_url_dm_scope_carries_with_person_uid() {
        let url = build_threads_url(
            "https://api.example.com",
            "evt_root",
            "dm",
            None,
            Some("prs_peer"),
        );
        assert_eq!(
            url,
            "https://api.example.com/v1/notify/threads?rootEventId=evt_root&scope=dm&withPersonUid=prs_peer"
        );
    }

    #[test]
    fn threads_url_channel_scope_carries_channel_id() {
        let url = build_threads_url(
            "https://api.example.com",
            "evt_root",
            "channel",
            Some("chn_1"),
            // A stray withPersonUid is ignored for a channel-scoped thread.
            Some("prs_ignored"),
        );
        assert_eq!(
            url,
            "https://api.example.com/v1/notify/threads?rootEventId=evt_root&scope=channel&channelId=chn_1"
        );
    }

    #[test]
    fn normalize_scope_defaults_to_dm() {
        assert_eq!(normalize_scope("channel"), "channel");
        assert_eq!(normalize_scope("CHANNEL"), "channel");
        assert_eq!(normalize_scope("dm"), "dm");
        assert_eq!(normalize_scope("anything"), "dm");
        assert_eq!(normalize_scope(""), "dm");
    }

    #[test]
    fn thread_reply_payload_dm_carries_recipient_and_root() {
        let payload = build_thread_reply_payload("dm", "evt_root", Some("prs_peer"), "hi there");
        assert_eq!(payload["toPersonUid"], "prs_peer");
        assert_eq!(payload["rootEventId"], "evt_root");
        assert_eq!(payload["body"], "hi there");
        let obj = payload.as_object().expect("object");
        assert_eq!(obj.len(), 3);
    }

    #[test]
    fn thread_reply_payload_channel_omits_recipient() {
        // A channel reply addresses the channel via the URL path, so the body
        // carries only body + rootEventId — never a toPersonUid.
        let payload = build_thread_reply_payload("channel", "evt_root", Some("prs_x"), "yo");
        assert_eq!(payload["rootEventId"], "evt_root");
        assert_eq!(payload["body"], "yo");
        let obj = payload.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert!(!obj.contains_key("toPersonUid"));
    }

    #[test]
    fn thread_view_deserializes_root_replies_and_count() {
        let json = r#"{
            "root": {
                "eventId": "evt_root",
                "fromPersonUid": "prs_a",
                "body": "the root message",
                "createdAt": "2026-06-05T00:00:00Z",
                "direction": "in"
            },
            "replies": [
                {
                    "eventId": "evt_r2",
                    "fromPersonUid": "prs_me",
                    "body": "second reply",
                    "createdAt": "2026-06-05T00:02:00Z",
                    "direction": "out"
                },
                {
                    "eventId": "evt_r1",
                    "fromPersonUid": "prs_a",
                    "body": "first reply",
                    "createdAt": "2026-06-05T00:01:00Z",
                    "direction": "in"
                }
            ],
            "replyCount": 2
        }"#;
        let view: ThreadView = serde_json::from_str(json).expect("ThreadView parses");
        assert_eq!(view.root.event_id, "evt_root");
        assert_eq!(view.replies.len(), 2);
        assert_eq!(view.reply_count, 2);
        assert_eq!(view.replies[0].direction, "out");
    }
}
