//! Pure and synchronous support for the HQ desktop direct-message notification
//! command layer.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::messages::{ChannelMessage, MessageAttachment};
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
    /// Present when this inbox event is a thread reply rather than a top-level
    /// DM. Omitted on ordinary messages; the frontend routes these into the
    /// thread pane instead of appending them to the main conversation list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// `"file_share"` for a share written as a DM. Absent on ordinary messages
    /// and on older servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_kind: Option<String>,
    /// Vault-path file cards on a `file_share` DM. Absent-safe for old servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    /// Declared audience: `"human"` | `"agent"` | `"both"`. Absent on messages
    /// stored before this feature was shipped — treat as `"human"` per the
    /// rollout decision. Mirrors `details` and `prompt` in the server contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
}

/// Per-counterparty DM unread rollup from `GET /v1/notify/inbox` (hq-pro
/// US-010). Additive — older servers omit the entire `pairUnreads` array.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairUnread {
    pub with_person_uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read_at: Option<String>,
    #[serde(default)]
    pub unread_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxResponse {
    pub events: Vec<DmEvent>,
    #[allow(dead_code)]
    pub next_cursor: Option<String>,
    /// ADDITIVE page-scoped per-pair unread rollup. Absent on older servers →
    /// empty via `#[serde(default)]` so deserialization stays backward-compatible.
    #[serde(default)]
    pub pair_unreads: Vec<PairUnread>,
}

/// Managed state: latest pair-unread counts observed from the inbox poll
/// (personUid → unreadCount). Frontend merges these into sidebar DM rows;
/// `mark_dm_thread_read` zeros a pair optimistically after a successful POST.
pub struct PairUnreadState(pub Mutex<HashMap<String, u32>>);

impl PairUnreadState {
    pub fn new() -> Self {
        PairUnreadState(Mutex::new(HashMap::new()))
    }
}

impl Default for PairUnreadState {
    fn default() -> Self {
        Self::new()
    }
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
    /// Monotonic local-mutation revision captured before an HTTP snapshot.
    /// A request action or auth-session reset advances it so the older response
    /// cannot restore a request that has already left the pending set.
    revision: u64,
}

impl SeenRequestsInner {
    pub fn begin_snapshot(&self) -> u64 {
        self.revision
    }

    pub fn snapshot_is_current(&self, revision: u64) -> bool {
        self.revision == revision
    }

    pub fn invalidate_snapshots(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn reset_for_session(&mut self) {
        self.invalidate_snapshots();
        self.initialized = false;
        self.pair_keys.clear();
    }
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
    /// Monotonic local-mutation revision captured before an HTTP snapshot.
    /// Marking a channel read or changing auth sessions advances it so a stale
    /// list response cannot resurrect an older unread count.
    revision: u64,
}

impl SeenChannelsInner {
    pub fn begin_snapshot(&self) -> u64 {
        self.revision
    }

    pub fn snapshot_is_current(&self, revision: u64) -> bool {
        self.revision == revision
    }

    pub fn invalidate_snapshots(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn reset_for_session(&mut self) {
        self.invalidate_snapshots();
        self.initialized = false;
        self.unread_by_id.clear();
    }
}

pub struct SeenChannelState(pub Mutex<SeenChannelsInner>);

impl SeenChannelState {
    pub fn new() -> Self {
        SeenChannelState(Mutex::new(SeenChannelsInner::default()))
    }
}

/// Per-session mention watch: last-seen message cursor per channel plus a
/// bounded set of message ids already considered, so a poll never re-notifies.
pub const MENTION_SEEN_CAP: usize = 500;
/// Notification body cap. Truncate with `chars()`, never a byte slice.
pub const MENTION_BODY_MAX_CHARS: usize = 180;
/// History fetches per mention-detect cycle. The rest rotate to the next cycle.
pub const MENTION_FETCH_PER_CYCLE: usize = 4;
/// At most this many mention notifications fire in one cycle (overflow → summary).
pub const MENTION_NOTIFY_CAP: usize = 3;
/// Mentions older than this relative to poll time are not delivered.
pub const MENTION_FRESH_MAX_AGE: Duration = Duration::minutes(15);
/// When the saved cursor is missing from the page, deliver at most the newest
/// message if it is within this age.
pub const MENTION_CURSOR_MISSING_MAX_AGE: Duration = Duration::minutes(10);

#[derive(Default)]
pub struct MentionWatchInner {
    pub initialized: bool,
    /// channelId → newest event_id already considered this session.
    pub last_event_by_channel: HashMap<String, String>,
    /// Bounded FIFO of message ids already considered this session.
    pub seen_message_ids: Vec<String>,
    /// Channels waiting for a history fetch (id, name). FIFO; at most
    /// [`MENTION_FETCH_PER_CYCLE`] are taken per detect cycle.
    pub pending_fetches: Vec<(String, String)>,
    /// True while a spawned detect task owns a fetch batch.
    pub detect_in_flight: bool,
}

impl MentionWatchInner {
    pub fn reset_for_session(&mut self) {
        *self = Self::default();
    }

    pub fn has_seen(&self, event_id: &str) -> bool {
        let id = event_id.trim();
        !id.is_empty() && self.seen_message_ids.iter().any(|seen| seen == id)
    }
}

pub struct MentionWatchState(pub Mutex<MentionWatchInner>);

impl MentionWatchState {
    pub fn new() -> Self {
        MentionWatchState(Mutex::new(MentionWatchInner::default()))
    }
}

/// True when `mentions[]` contains the signed-in person as `participantUid`.
/// Match the person uid **or** the Cognito subject — live rows use either.
/// Text that merely contains `@Name` does not count. Empty ids never match.
pub fn message_mentions_person(
    message: &ChannelMessage,
    person_uid: &str,
    cognito_sub: &str,
) -> bool {
    let me = person_uid.trim();
    let sub = cognito_sub.trim();
    message
        .mentions
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .any(|mention| {
            let uid = mention.participant_uid.trim();
            !uid.is_empty() && ((!me.is_empty() && uid == me) || (!sub.is_empty() && uid == sub))
        })
}

/// Own messages never count, even when they mention me. `fromPersonUid` on
/// the wire may be the `prs_` person uid *or* the Cognito subject.
pub fn is_self_authored(from_person_uid: &str, person_uid: &str, cognito_sub: &str) -> bool {
    let from = from_person_uid.trim();
    if from.is_empty() {
        return false;
    }
    let person = person_uid.trim();
    let sub = cognito_sub.trim();
    (!person.is_empty() && from == person) || (!sub.is_empty() && from == sub)
}

/// A mention of me: structured `participantUid` match, not authored by me.
pub fn is_mention_of_me(message: &ChannelMessage, person_uid: &str, cognito_sub: &str) -> bool {
    !is_self_authored(&message.from_person_uid, person_uid, cognito_sub)
        && message_mentions_person(message, person_uid, cognito_sub)
}

pub fn newest_event_id(messages_newest_first: &[ChannelMessage]) -> Option<String> {
    messages_newest_first
        .iter()
        .map(|message| message.event_id.trim())
        .find(|id| !id.is_empty())
        .map(str::to_string)
}

/// First poll after launch: cursor starts at the newest message so opening
/// the app does not replay old mentions.
pub fn seed_mention_cursor(messages_newest_first: &[ChannelMessage]) -> Option<String> {
    newest_event_id(messages_newest_first)
}

pub fn cursor_in_page(messages_newest_first: &[ChannelMessage], last_seen_event_id: &str) -> bool {
    let seen = last_seen_event_id.trim();
    !seen.is_empty()
        && messages_newest_first
            .iter()
            .any(|message| message.event_id == seen)
}

/// Messages newer than `last_seen_event_id` in a newest-first page.
///
/// If the cursor is absent from the page, return nothing — the caller advances
/// the cursor silently rather than treating the whole page as new.
pub fn messages_newer_than<'a>(
    messages_newest_first: &'a [ChannelMessage],
    last_seen_event_id: &str,
) -> Vec<&'a ChannelMessage> {
    let seen = last_seen_event_id.trim();
    if seen.is_empty() || !cursor_in_page(messages_newest_first, seen) {
        return Vec::new();
    }
    messages_newest_first
        .iter()
        .take_while(|message| message.event_id != seen)
        .collect()
}

const NAIVE_CREATED_AT_FMTS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M:%S",
];

/// Parse a message `createdAt`. RFC 3339 with offset, or a naive timestamp
/// treated as UTC. Does not log — callers that have an event id use
/// [`parse_message_created_at_logged`].
pub fn parse_message_created_at(created_at: &str) -> Option<DateTime<Utc>> {
    let raw = created_at.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(ts) = DateTime::parse_from_rfc3339(raw) {
        return Some(ts.with_timezone(&Utc));
    }
    for fmt in NAIVE_CREATED_AT_FMTS {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            return Some(naive.and_utc());
        }
    }
    None
}

/// Like [`parse_message_created_at`], and logs `DM_NOTIFY_MENTION_BAD_TS
/// event=<id>` (never the body) when parsing fails.
pub fn parse_message_created_at_logged(created_at: &str, event_id: &str) -> Option<DateTime<Utc>> {
    match parse_message_created_at(created_at) {
        Some(ts) => Some(ts),
        None => {
            let id = event_id.trim();
            if !id.is_empty() {
                crate::logfile::log("dm-notify", &format!("DM_NOTIFY_MENTION_BAD_TS event={id}"));
            }
            None
        }
    }
}

/// True when `created_at` is at most `max_age` before `now`. Unparseable
/// timestamps are not fresh. Future timestamps count as fresh.
pub fn mention_created_within(created_at: &str, now: DateTime<Utc>, max_age: Duration) -> bool {
    mention_created_within_for_event(created_at, now, max_age, "")
}

pub fn mention_created_within_for_event(
    created_at: &str,
    now: DateTime<Utc>,
    max_age: Duration,
    event_id: &str,
) -> bool {
    let Some(ts) = parse_message_created_at_logged(created_at, event_id) else {
        return false;
    };
    now.signed_duration_since(ts) <= max_age
}

pub fn filter_mentions_by_age<'a>(
    messages: Vec<&'a ChannelMessage>,
    now: DateTime<Utc>,
    max_age: Duration,
) -> Vec<&'a ChannelMessage> {
    messages
        .into_iter()
        .filter(|message| {
            mention_created_within_for_event(&message.created_at, now, max_age, &message.event_id)
        })
        .collect()
}

/// Advance the per-channel last-seen cursor.
///
/// * No cursor (first fetch / after `reset_for_session`): seed at newest,
///   deliver nothing. Unread delta is never used to pick "new" rows.
/// * Cursor present in the page: messages strictly newer than that id.
/// * Cursor missing from the page: advance to newest and deliver nothing,
///   except the newest row when its `createdAt` is within 10 minutes of `now`.
pub fn advance_mention_cursor<'a>(
    messages_newest_first: &'a [ChannelMessage],
    last_seen_event_id: Option<&str>,
    now: DateTime<Utc>,
) -> (Option<String>, Vec<&'a ChannelMessage>) {
    let newest = newest_event_id(messages_newest_first);
    let Some(seen) = last_seen_event_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return (newest, Vec::new());
    };
    if cursor_in_page(messages_newest_first, seen) {
        return (
            newest.or_else(|| Some(seen.to_string())),
            messages_newer_than(messages_newest_first, seen),
        );
    }
    let newest_if_recent = messages_newest_first.first().filter(|message| {
        mention_created_within_for_event(
            &message.created_at,
            now,
            MENTION_CURSOR_MISSING_MAX_AGE,
            &message.event_id,
        )
    });
    (
        newest.or_else(|| Some(seen.to_string())),
        newest_if_recent.into_iter().collect(),
    )
}

/// Fetch failure / timeout leaves the saved cursor untouched.
pub fn mention_cursor_after_fetch<'a>(
    current: Option<&str>,
    fetch_succeeded: bool,
    messages_newest_first: &'a [ChannelMessage],
    now: DateTime<Utc>,
) -> (Option<String>, Vec<&'a ChannelMessage>) {
    if !fetch_succeeded {
        return (current.map(str::to_string), Vec::new());
    }
    advance_mention_cursor(messages_newest_first, current, now)
}

pub fn enqueue_mention_fetches(pending: &mut Vec<(String, String)>, incoming: &[(String, String)]) {
    for (id, name) in incoming {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        if pending.iter().any(|(existing, _)| existing == id) {
            continue;
        }
        pending.push((id.to_string(), name.clone()));
    }
}

pub fn take_mention_fetch_batch(
    pending: &mut Vec<(String, String)>,
    cap: usize,
) -> Vec<(String, String)> {
    let n = cap.min(pending.len());
    pending.drain(0..n).collect()
}

/// Re-queue failed fetches at most once per detect run so a dead channel
/// cannot spin. `retried` is the set of channel ids already re-queued.
pub fn requeue_failed_mention_fetches(
    pending: &mut Vec<(String, String)>,
    failed: &[(String, String)],
    retried: &mut HashSet<String>,
) {
    let mut once = Vec::new();
    for (id, name) in failed {
        let id = id.trim();
        if id.is_empty() || retried.contains(id) {
            continue;
        }
        retried.insert(id.to_string());
        once.push((id.to_string(), name.clone()));
    }
    enqueue_mention_fetches(pending, &once);
}

/// Spawn a detect task when something is waiting and nothing owns the drain.
/// Growth while a detect is in flight is only enqueued — the in-flight run
/// (or the next poll) takes the next batch.
pub fn should_spawn_mention_detect(pending_len: usize, detect_in_flight: bool) -> bool {
    pending_len > 0 && !detect_in_flight
}

/// One mention that qualified for a notification this cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionCapItem {
    pub created_at: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionSummary {
    pub extra_count: usize,
    pub channel_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionCapPlan {
    /// Indices into the input slice to deliver as individual notifications.
    pub deliver_indices: Vec<usize>,
    pub summary: Option<MentionSummary>,
}

/// At most [`MENTION_NOTIFY_CAP`] notifications per cycle. If more qualify,
/// deliver the newest 2 plus one summary for the rest, routed to the first
/// overflow channel (original scan order).
pub fn plan_mention_cap(items: &[MentionCapItem]) -> MentionCapPlan {
    if items.len() <= MENTION_NOTIFY_CAP {
        return MentionCapPlan {
            deliver_indices: (0..items.len()).collect(),
            summary: None,
        };
    }
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| cmp_created_at_desc(&items[a].created_at, &items[b].created_at));
    let newest_two = vec![order[0], order[1]];
    let overflow: Vec<usize> = (0..items.len())
        .filter(|index| !newest_two.contains(index))
        .collect();
    let channel_id = overflow
        .first()
        .map(|&index| items[index].channel_id.clone())
        .unwrap_or_default();
    MentionCapPlan {
        deliver_indices: newest_two,
        summary: Some(MentionSummary {
            extra_count: overflow.len(),
            channel_id,
        }),
    }
}

fn cmp_created_at_desc(a: &str, b: &str) -> std::cmp::Ordering {
    match (parse_message_created_at(a), parse_message_created_at(b)) {
        (Some(ta), Some(tb)) => tb.cmp(&ta),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.cmp(a),
    }
}

pub fn mention_summary_title(extra_count: usize) -> String {
    format!("You were mentioned {extra_count} more times")
}

/// Consider each message id at most once per session. Bounded FIFO.
pub fn take_unseen_message_ids(
    event_ids: &[String],
    seen: &[String],
) -> (Vec<String>, Vec<String>) {
    let known: HashSet<&str> = seen.iter().map(String::as_str).collect();
    let fresh: Vec<String> = event_ids
        .iter()
        .filter(|id| !id.trim().is_empty() && !known.contains(id.as_str()))
        .cloned()
        .collect();
    let mut updated = seen.to_vec();
    updated.extend(fresh.iter().cloned());
    if updated.len() > MENTION_SEEN_CAP {
        updated.drain(0..updated.len() - MENTION_SEEN_CAP);
    }
    (fresh, updated)
}

pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

pub fn mention_notification_title(author: &str, channel_name: &str) -> String {
    let author = author.trim();
    let author = if author.is_empty() { "Someone" } else { author };
    let channel = channel_name.trim().trim_start_matches('#');
    let channel = if channel.is_empty() {
        "channel"
    } else {
        channel
    };
    format!("{author} mentioned you in #{channel}")
}

pub fn mention_notification_body(body: &str) -> String {
    truncate_chars(body.trim(), MENTION_BODY_MAX_CHARS)
}

pub fn mention_route(channel_id: &str, message_id: &str) -> String {
    let channel = channel_id.trim();
    let message = message_id.trim();
    if channel.is_empty() {
        return "inbox".to_string();
    }
    if message.is_empty() {
        format!("inbox:channel:{channel}")
    } else {
        format!("inbox:channel:{channel}:{message}")
    }
}

/// No notification when that channel is open and focused in the desktop-alt
/// window (`desktop-alt` webview), not the tray popover.
pub fn should_suppress_mention_for_open_channel(
    active_scope: Option<&str>,
    channel_id: &str,
    main_window_focused: bool,
) -> bool {
    if !main_window_focused {
        return false;
    }
    let channel = channel_id.trim();
    if channel.is_empty() {
        return false;
    }
    let expected = format!("chan:{channel}");
    active_scope
        .map(str::trim)
        .is_some_and(|scope| scope == expected)
}

pub fn should_suppress_duplicate_event(event_id: &str, already_notified: &[String]) -> bool {
    let id = event_id.trim();
    !id.is_empty() && already_notified.iter().any(|seen| seen == id)
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

/// Upper bound on each account-scoped `notified` ring. The repeated boundary
/// events (the cause of the re-notify bug) are always the newest, so they never
/// reach the eviction end of the FIFO — 200 is comfortably more than any
/// single `?since=` page (`limit=50`).
pub const NOTIFIED_CAP: usize = 200;

/// Cursor state for one machine/account pair. `cursor` is the ISO8601
/// `createdAt` of the newest DM seen (the `?since=` value). `notified` is a
/// bounded FIFO of recently banner-fired `eventId`s: the inbox treats
/// `?since=` as **inclusive**, so the boundary DM(s) — and any DM sharing the
/// cursor's exact timestamp — are returned on every subsequent poll. Without
/// an id-level guard that re-fires the same banner each poll/launch (the same
/// class of bug fixed in share_notify on 2026-05-29). Deduping by id makes
/// re-notification impossible regardless of the server's `since` semantics.
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

fn write_cursor_store(store: &CursorStore) {
    let Ok(path) = cursor_path() else { return };
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn write_cursor_entry(machine_id: &str, entry: &CursorEntry) {
    // Re-read (with normalisation) so we never clobber other machines' entries.
    let mut store = read_cursor_store();
    store.insert(machine_id.to_string(), entry.clone());
    write_cursor_store(&store);
}

const ACCOUNT_CURSOR_KEY_PREFIX: &str = "account-v1";

/// Build the persisted cursor key for one machine/account pair.
///
/// The stable account identity should be the authenticated Cognito subject,
/// not an access token or display value. Hashing both inputs keeps raw identity
/// data out of `dm-cursor.json`, while the length prefix prevents ambiguous
/// concatenations from producing the same digest input.
pub fn account_cursor_key(machine_id: &str, account_identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update((machine_id.len() as u64).to_be_bytes());
    hasher.update(machine_id.as_bytes());
    hasher.update(account_identity.as_bytes());
    format!("{ACCOUNT_CURSOR_KEY_PREFIX}:{:x}", hasher.finalize())
}

/// Resolve an account-scoped entry from an in-memory store.
///
/// Returns the resolved entry and whether the store changed. A pre-account
/// machine-only entry is claimed by the first authenticated identity and moved
/// to its scoped key. Consuming the old key is essential: a later identity on
/// the same machine must start with an empty cursor rather than inherit another
/// account's notification history.
fn resolve_account_cursor_entry(
    store: &mut CursorStore,
    machine_id: &str,
    account_identity: &str,
) -> (CursorEntry, bool) {
    let scoped_key = account_cursor_key(machine_id, account_identity);

    if let Some(scoped_entry) = store.get(&scoped_key).cloned() {
        let removed_stale_legacy = store.remove(machine_id).is_some();
        return (scoped_entry, removed_stale_legacy);
    }

    let Some(legacy_entry) = store.remove(machine_id) else {
        return (CursorEntry::default(), false);
    };

    store.insert(scoped_key, legacy_entry.clone());
    (legacy_entry, true)
}

/// Insert an account-scoped entry without disturbing other account or machine
/// entries. Any leftover machine-only key is consumed so it cannot later leak
/// into another account.
fn upsert_account_cursor_entry(
    store: &mut CursorStore,
    machine_id: &str,
    account_identity: &str,
    entry: &CursorEntry,
) {
    store.remove(machine_id);
    store.insert(
        account_cursor_key(machine_id, account_identity),
        entry.clone(),
    );
}

/// Read the cursor for one authenticated account on a machine.
///
/// On first use after upgrading from a machine-only store, this claims the
/// legacy entry for the current identity and persists the migrated shape.
/// Other entries in the store are preserved.
pub fn read_cursor_entry_for_account(machine_id: &str, account_identity: &str) -> CursorEntry {
    let mut store = read_cursor_store();
    let (entry, changed) = resolve_account_cursor_entry(&mut store, machine_id, account_identity);
    if changed {
        write_cursor_store(&store);
    }
    entry
}

/// Persist the cursor for one authenticated account on a machine while
/// preserving every unrelated account and machine entry.
pub fn write_cursor_entry_for_account(
    machine_id: &str,
    account_identity: &str,
    entry: &CursorEntry,
) {
    let mut store = read_cursor_store();
    upsert_account_cursor_entry(&mut store, machine_id, account_identity, entry);
    write_cursor_store(&store);
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
    /// Parent thread id when this row is a reply. Roots omit it (or echo their
    /// own eventId). Absent-safe so older servers still deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// Reply count maintained on root rows. Absent on replies and on older
    /// payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u32>,
    /// `"file_share"` for a share written as a DM. Absent on ordinary rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_kind: Option<String>,
    /// Vault-path file cards. Absent-safe for old servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    /// Declared audience: `"human"` | `"agent"` | `"both"`. Absent on older
    /// rows — treat as `"human"`. Mirrors `details` and `prompt`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u32>,
    /// Keep attachment references intact across the native bridge. The UI owns
    /// attachment validation and loads bytes through the authorized vault API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    /// Declared audience: `"human"` | `"agent"` | `"both"`. Absent on older
    /// rows — treat as `"human"`. Mirrors `details` and `prompt`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
}

/// The full thread view returned by `GET /v1/notify/threads`: the pinned root
/// message and the reply list (newest-first, like the other thread/channel
/// fetches). `replyCount` is optional — the DM-scope response is
/// `{ scope, root, replies }` with no top-level count — so callers must use
/// [`effective_reply_count`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub root: ThreadReply,
    #[serde(default)]
    pub replies: Vec<ThreadReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u32>,
}

/// Authoritative reply count for a thread view: the larger of the declared
/// `replyCount` (treating absence as 0) and the number of loaded replies.
/// The DM-scope GET omits `replyCount`, so a missing/zero count with replies
/// present must still report the loaded length.
pub fn effective_reply_count(view: &ThreadView) -> u32 {
    view.reply_count.unwrap_or(0).max(view.replies.len() as u32)
}

/// One renderer's active reply thread. Several desktop windows can have a
/// thread open at once, so [`ActiveThreadState`] owns one of these per window
/// label rather than a last-writer-wins global descriptor.
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

/// Managed active reply threads keyed by the invoking Tauri window label.
///
/// Closing one renderer must remove only its own descriptor: a Messages window
/// and the embedded desktop window can both stay mounted and reconcile replies
/// independently through the single native poll path.
pub struct ActiveThreadState(pub Mutex<HashMap<String, ActiveThreadInner>>);

impl ActiveThreadState {
    pub fn new() -> Self {
        ActiveThreadState(Mutex::new(HashMap::new()))
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

/// True when the message is addressed only to agents (`audience == "agent"`).
/// Absent audience or any other value is treated as `"human"` (non-agent).
/// Used by the unread counter, OS notification path, and preview selection.
pub fn is_agent_audience(audience: Option<&str>) -> bool {
    matches!(audience, Some(a) if a.eq_ignore_ascii_case("agent"))
}

/// Filter a `DmEvent` slice to the subset a human should see in the unread
/// count and OS notifications: everything whose audience is NOT `"agent"`.
/// `"human"`, `"both"`, and absent all pass through.
pub fn filter_human_visible_events(events: &[DmEvent]) -> Vec<&DmEvent> {
    events
        .iter()
        .filter(|e| !is_agent_audience(e.audience.as_deref()))
        .collect()
}

/// Return the newest event in `events` that is not agent-only, for use as
/// the conversation preview when the "Show bot messages" toggle is off. The
/// input is assumed newest-first (inbox/thread order). Returns `None` when
/// all events are agent-only or the slice is empty.
pub fn newest_non_agent_event<'a>(events: &'a [DmEvent]) -> Option<&'a DmEvent> {
    events
        .iter()
        .find(|e| !is_agent_audience(e.audience.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn active_thread_registry_keeps_other_window_seen_reply_suppression_on_selective_cleanup() {
        let state = ActiveThreadState::new();
        let mut threads = state.0.lock().unwrap();
        threads.insert(
            "messages".to_string(),
            ActiveThreadInner {
                root_event_id: Some("evt_messages".to_string()),
                scope: "dm".to_string(),
                with_person_uid: Some("prs_peer".to_string()),
                seen_reply_ids: ["evt_messages_seen".to_string()].into_iter().collect(),
                ..Default::default()
            },
        );
        threads.insert(
            "desktop-alt".to_string(),
            ActiveThreadInner {
                root_event_id: Some("evt_desktop".to_string()),
                scope: "channel".to_string(),
                channel_id: Some("chn_1".to_string()),
                seen_reply_ids: ["evt_desktop_seen".to_string()].into_iter().collect(),
                ..Default::default()
            },
        );

        threads.remove("desktop-alt");

        assert_eq!(threads.len(), 1);
        assert_eq!(
            threads
                .get("messages")
                .and_then(|thread| thread.root_event_id.as_deref()),
            Some("evt_messages"),
        );
        assert!(
            threads
                .get("messages")
                .is_some_and(|thread| thread.seen_reply_ids.contains("evt_messages_seen")),
            "clearing desktop-alt must not make the Messages window re-emit an already seen reply"
        );
    }

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
        assert!(dm.root_event_id.is_none());
    }

    #[test]
    fn inbox_response_pair_unreads_absent_safe() {
        // Older servers omit pairUnreads entirely — must still deserialize.
        let legacy = r#"{
            "events": [{
                "eventId": "evt_1",
                "fromPersonUid": "prs_sender",
                "fromEmail": "a@b.com",
                "fromDisplayName": "Ada",
                "body": "hi",
                "createdAt": "2026-05-29T00:00:00Z"
            }],
            "nextCursor": null
        }"#;
        let legacy_body: InboxResponse =
            serde_json::from_str(legacy).expect("legacy inbox without pairUnreads");
        assert_eq!(legacy_body.events.len(), 1);
        assert!(legacy_body.pair_unreads.is_empty());

        // Newer servers include the additive rollup.
        let modern = r#"{
            "events": [],
            "pairUnreads": [
                {
                    "withPersonUid": "prs_ada",
                    "lastReadAt": "2026-08-01T00:00:00Z",
                    "unreadCount": 3
                },
                {
                    "withPersonUid": "prs_grace",
                    "unreadCount": 0
                }
            ]
        }"#;
        let modern_body: InboxResponse =
            serde_json::from_str(modern).expect("modern inbox with pairUnreads");
        assert!(modern_body.events.is_empty());
        assert_eq!(modern_body.pair_unreads.len(), 2);
        assert_eq!(modern_body.pair_unreads[0].with_person_uid, "prs_ada");
        assert_eq!(modern_body.pair_unreads[0].unread_count, 3);
        assert_eq!(
            modern_body.pair_unreads[0].last_read_at.as_deref(),
            Some("2026-08-01T00:00:00Z")
        );
        assert_eq!(modern_body.pair_unreads[1].with_person_uid, "prs_grace");
        assert_eq!(modern_body.pair_unreads[1].unread_count, 0);
        assert!(modern_body.pair_unreads[1].last_read_at.is_none());
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
            root_event_id: None,
            message_kind: None,
            attachments: None,
            audience: None,
        }
    }

    fn mk_dm_with_audience(event_id: &str, created_at: &str, audience: &str) -> DmEvent {
        DmEvent {
            audience: Some(audience.to_string()),
            ..mk_dm(event_id, created_at)
        }
    }

    #[test]
    fn dm_event_deserializes_without_attachments_or_kind() {
        let json = r#"{
            "eventId": "evt_1",
            "fromPersonUid": "prs_a",
            "fromEmail": "a@b.com",
            "fromDisplayName": "Ada",
            "body": "hi",
            "createdAt": "2026-09-21T00:00:00Z"
        }"#;
        let evt: DmEvent = serde_json::from_str(json).unwrap();
        assert!(evt.attachments.is_none());
        assert!(evt.message_kind.is_none());
    }

    #[test]
    fn dm_event_deserializes_file_share_attachments_and_ignores_unknown_fields() {
        let json = r#"{
            "eventId": "evt_share",
            "fromPersonUid": "prs_a",
            "fromEmail": "a@b.com",
            "fromDisplayName": "Ada",
            "body": "Shared 2 file(s) with you.",
            "createdAt": "2026-09-21T00:00:00Z",
            "messageKind": "file_share",
            "unknownServerField": true,
            "attachments": [{
                "id": "att_1",
                "vaultPath": "indigo/reports/q1.md",
                "name": "q1.md",
                "sizeBytes": 1200,
                "kind": "file",
                "contentType": "text/markdown",
                "companyUid": "cmp_indigo"
            }]
        }"#;
        let evt: DmEvent = serde_json::from_str(json).unwrap();
        assert_eq!(evt.message_kind.as_deref(), Some("file_share"));
        let attachments = evt.attachments.expect("attachments");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "q1.md");
        assert_eq!(attachments[0].vault_path, "indigo/reports/q1.md");
        assert_eq!(attachments[0].company_uid.as_deref(), Some("cmp_indigo"));
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

    fn cursor_entry(cursor: &str, notified: &[&str]) -> CursorEntry {
        CursorEntry {
            cursor: Some(cursor.to_string()),
            notified: notified
                .iter()
                .map(|event_id| event_id.to_string())
                .collect(),
        }
    }

    #[test]
    fn account_cursor_keys_partition_the_same_machine_by_stable_identity() {
        let alpha = account_cursor_key("machine-1", "cognito-sub-alpha");
        let alpha_again = account_cursor_key("machine-1", "cognito-sub-alpha");
        let beta = account_cursor_key("machine-1", "cognito-sub-beta");

        assert_eq!(alpha, alpha_again, "the same account must resolve stably");
        assert_ne!(
            alpha, beta,
            "accounts on one machine must never share a cursor"
        );
        assert_ne!(
            alpha, "machine-1",
            "scoped keys must not reuse the legacy key"
        );
    }

    #[test]
    fn account_cursor_resolution_reads_only_the_current_identity() {
        let alpha_key = account_cursor_key("machine-1", "account-alpha");
        let beta_key = account_cursor_key("machine-1", "account-beta");
        let mut store = CursorStore::from([
            (
                alpha_key.clone(),
                cursor_entry("alpha-time", &["alpha-event"]),
            ),
            (beta_key.clone(), cursor_entry("beta-time", &["beta-event"])),
            (
                "other-machine".to_string(),
                cursor_entry("other-time", &["other-event"]),
            ),
        ]);

        let (alpha, changed) =
            resolve_account_cursor_entry(&mut store, "machine-1", "account-alpha");

        assert!(
            !changed,
            "reading an already-scoped entry should not rewrite it"
        );
        assert_eq!(alpha.cursor.as_deref(), Some("alpha-time"));
        assert_eq!(alpha.notified, ["alpha-event"]);
        assert_eq!(
            store
                .get(&beta_key)
                .and_then(|entry| entry.cursor.as_deref()),
            Some("beta-time"),
            "another account's cursor must remain untouched"
        );
        assert!(store.contains_key("other-machine"));
    }

    #[test]
    fn legacy_machine_cursor_is_claimed_once_by_the_current_identity() {
        let alpha_key = account_cursor_key("machine-1", "account-alpha");
        let beta_key = account_cursor_key("machine-1", "account-beta");
        let mut store = CursorStore::from([
            (
                "machine-1".to_string(),
                cursor_entry("legacy-time", &["legacy-event"]),
            ),
            (
                "other-machine".to_string(),
                cursor_entry("other-time", &["other-event"]),
            ),
        ]);

        let (alpha, changed) =
            resolve_account_cursor_entry(&mut store, "machine-1", "account-alpha");

        assert!(changed, "claiming a legacy entry must request persistence");
        assert_eq!(alpha.cursor.as_deref(), Some("legacy-time"));
        assert_eq!(alpha.notified, ["legacy-event"]);
        assert!(
            !store.contains_key("machine-1"),
            "legacy key must be consumed"
        );
        assert_eq!(
            store
                .get(&alpha_key)
                .and_then(|entry| entry.cursor.as_deref()),
            Some("legacy-time")
        );
        assert!(
            store.contains_key("other-machine"),
            "unrelated entries survive"
        );

        let (beta, changed_again) =
            resolve_account_cursor_entry(&mut store, "machine-1", "account-beta");

        assert!(!changed_again);
        assert!(beta.cursor.is_none());
        assert!(beta.notified.is_empty());
        assert!(
            !store.contains_key(&beta_key),
            "a later identity must not inherit the claimed legacy cursor"
        );
        assert_eq!(
            store
                .get(&alpha_key)
                .and_then(|entry| entry.cursor.as_deref()),
            Some("legacy-time"),
            "the first identity keeps its migrated entry"
        );
    }

    #[test]
    fn existing_account_cursor_wins_and_consumes_a_stale_legacy_entry() {
        let alpha_key = account_cursor_key("machine-1", "account-alpha");
        let mut store = CursorStore::from([
            (
                alpha_key.clone(),
                cursor_entry("scoped-time", &["scoped-event"]),
            ),
            (
                "machine-1".to_string(),
                cursor_entry("legacy-time", &["legacy-event"]),
            ),
        ]);

        let (alpha, changed) =
            resolve_account_cursor_entry(&mut store, "machine-1", "account-alpha");

        assert!(changed, "discarding a stale legacy key must be persisted");
        assert_eq!(alpha.cursor.as_deref(), Some("scoped-time"));
        assert_eq!(alpha.notified, ["scoped-event"]);
        assert!(!store.contains_key("machine-1"));
        assert_eq!(
            store
                .get(&alpha_key)
                .and_then(|entry| entry.cursor.as_deref()),
            Some("scoped-time"),
            "legacy data must never overwrite a newer scoped cursor"
        );
    }

    #[test]
    fn account_cursor_write_removes_stale_legacy_key_and_preserves_other_entries() {
        let alpha_key = account_cursor_key("machine-1", "account-alpha");
        let mut store = CursorStore::from([
            (
                "machine-1".to_string(),
                cursor_entry("legacy-time", &["legacy-event"]),
            ),
            (
                "other-machine".to_string(),
                cursor_entry("other-time", &["other-event"]),
            ),
        ]);
        let current = cursor_entry("current-time", &["current-event"]);

        upsert_account_cursor_entry(&mut store, "machine-1", "account-alpha", &current);

        assert!(!store.contains_key("machine-1"));
        assert_eq!(
            store
                .get(&alpha_key)
                .and_then(|entry| entry.cursor.as_deref()),
            Some("current-time")
        );
        assert_eq!(
            store
                .get("other-machine")
                .and_then(|entry| entry.cursor.as_deref()),
            Some("other-time")
        );
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
    fn request_snapshot_is_rejected_after_a_local_resolution() {
        let mut state = SeenRequestsInner::default();
        state.pair_keys.insert("pair_pending".to_string());
        let snapshot_revision = state.begin_snapshot();

        state.invalidate_snapshots();
        state.pair_keys.remove("pair_pending");

        assert!(
            !state.snapshot_is_current(snapshot_revision),
            "an HTTP response started before respond_dm_request completed must not restore it"
        );
    }

    #[test]
    fn channel_snapshot_is_rejected_after_mark_read() {
        let mut state = SeenChannelsInner::default();
        state.unread_by_id.insert("channel_a".to_string(), 4);
        let snapshot_revision = state.begin_snapshot();

        state.invalidate_snapshots();
        state.unread_by_id.insert("channel_a".to_string(), 0);

        assert!(
            !state.snapshot_is_current(snapshot_revision),
            "an HTTP response started before mark_channel_read completed must not restore unread"
        );
    }

    #[test]
    fn session_reset_clears_seen_notification_state_and_invalidates_snapshots() {
        let mut requests = SeenRequestsInner::default();
        requests.initialized = true;
        requests.pair_keys.insert("pair_a".to_string());
        let request_revision = requests.begin_snapshot();

        let mut channels = SeenChannelsInner::default();
        channels.initialized = true;
        channels.unread_by_id.insert("channel_a".to_string(), 3);
        let channel_revision = channels.begin_snapshot();

        requests.reset_for_session();
        channels.reset_for_session();

        assert!(!requests.initialized);
        assert!(requests.pair_keys.is_empty());
        assert!(!requests.snapshot_is_current(request_revision));
        assert!(!channels.initialized);
        assert!(channels.unread_by_id.is_empty());
        assert!(!channels.snapshot_is_current(channel_revision));
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
        assert_eq!(view.reply_count, Some(2));
        assert_eq!(view.replies[0].direction, "out");
        assert_eq!(effective_reply_count(&view), 2);
    }

    #[test]
    fn thread_view_preserves_root_and_reply_attachment_references() {
        let message = serde_json::json!({
            "eventId": "evt_image", "fromPersonUid": "prs_a",
            "body": "image", "createdAt": "2026-09-05T22:23:00Z",
            "attachments": [{"vaultPath": "chat/image.png", "name": "image.png",
                "kind": "image", "sizeBytes": 2200000}]
        });
        let input = serde_json::json!({"root": message, "replies": [message]});
        let view: ThreadView = serde_json::from_value(input.clone()).unwrap();
        let output = serde_json::to_value(view).unwrap();
        assert_eq!(output["root"]["attachments"], input["root"]["attachments"]);
        assert_eq!(
            output["replies"][0]["attachments"],
            input["replies"][0]["attachments"]
        );
    }

    #[test]
    fn thread_view_absent_reply_count_deserializes_none() {
        // DM-scope GET /v1/notify/threads returns { scope, root, replies } with
        // no top-level replyCount. That must stay None (not coerce to 0) so
        // callers can fall back to the loaded reply list.
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
                    "eventId": "evt_r1",
                    "fromPersonUid": "prs_a",
                    "body": "first reply",
                    "createdAt": "2026-06-05T00:01:00Z",
                    "direction": "in"
                }
            ]
        }"#;
        let view: ThreadView = serde_json::from_str(json).expect("ThreadView parses");
        assert!(view.reply_count.is_none());
        assert_eq!(view.replies.len(), 1);
        assert_eq!(effective_reply_count(&view), 1);
    }

    #[test]
    fn effective_reply_count_prefers_declared_when_larger() {
        let json = r#"{
            "root": {
                "eventId": "evt_root",
                "fromPersonUid": "prs_a",
                "body": "the root message",
                "createdAt": "2026-06-05T00:00:00Z"
            },
            "replies": [
                {
                    "eventId": "evt_r1",
                    "fromPersonUid": "prs_a",
                    "body": "first reply",
                    "createdAt": "2026-06-05T00:01:00Z"
                }
            ],
            "replyCount": 3
        }"#;
        let view: ThreadView = serde_json::from_str(json).expect("ThreadView parses");
        assert_eq!(view.reply_count, Some(3));
        assert_eq!(effective_reply_count(&view), 3);
    }

    #[test]
    fn thread_message_and_reply_pass_through_root_event_id_and_count() {
        let msg_json = r#"{
            "eventId": "evt_1",
            "fromPersonUid": "prs_a",
            "fromEmail": "a@b.com",
            "fromDisplayName": "Ada",
            "body": "hi",
            "createdAt": "2026-06-05T00:00:00Z",
            "direction": "in",
            "rootEventId": "evt_root",
            "replyCount": 2
        }"#;
        let msg: ThreadMessage = serde_json::from_str(msg_json).expect("ThreadMessage parses");
        assert_eq!(msg.root_event_id.as_deref(), Some("evt_root"));
        assert_eq!(msg.reply_count, Some(2));
        let msg_out = serde_json::to_value(&msg).expect("ThreadMessage serializes");
        assert_eq!(msg_out["rootEventId"], "evt_root");
        assert_eq!(msg_out["replyCount"], 2);

        let reply_json = r#"{
            "eventId": "evt_r1",
            "fromPersonUid": "prs_a",
            "body": "reply",
            "createdAt": "2026-06-05T00:01:00Z",
            "rootEventId": "evt_root",
            "replyCount": 1
        }"#;
        let reply: ThreadReply = serde_json::from_str(reply_json).expect("ThreadReply parses");
        assert_eq!(reply.root_event_id.as_deref(), Some("evt_root"));
        assert_eq!(reply.reply_count, Some(1));
        let reply_out = serde_json::to_value(&reply).expect("ThreadReply serializes");
        assert_eq!(reply_out["rootEventId"], "evt_root");
        assert_eq!(reply_out["replyCount"], 1);
    }

    #[test]
    fn dm_event_passes_through_root_event_id() {
        let json = r#"{
            "eventId": "evt_1",
            "fromPersonUid": "prs_sender",
            "fromEmail": "a@b.com",
            "fromDisplayName": "Ada",
            "body": "hi",
            "createdAt": "2026-05-29T00:00:00Z",
            "rootEventId": "evt_root"
        }"#;
        let dm: DmEvent = serde_json::from_str(json).expect("DmEvent parses");
        assert_eq!(dm.root_event_id.as_deref(), Some("evt_root"));
        let out = serde_json::to_value(&dm).expect("DmEvent serializes");
        assert_eq!(out["rootEventId"], "evt_root");
    }

    const ME: &str = "prs_01KQ2RY9VB1S105X2GZ2EPHKWY";
    const MY_SUB: &str = "94b82448-aaaa-bbbb-cccc-ddddeeeeffff";

    fn mk_channel_msg(json: &str) -> ChannelMessage {
        serde_json::from_str(json).expect("ChannelMessage parses")
    }

    fn live_mention_json(event_id: &str, from: &str) -> String {
        live_mention_json_at(event_id, from, "2026-09-23T12:00:00Z")
    }

    fn live_mention_json_at(event_id: &str, from: &str, created_at: &str) -> String {
        format!(
            r#"{{
                "eventId": "{event_id}",
                "fromPersonUid": "{from}",
                "fromDisplayName": "Ada",
                "body": "hey @Stefan look at this",
                "createdAt": "{created_at}",
                "direction": "in",
                "mentions": [{{
                    "participantUid": "prs_01KQ2RY9VB1S105X2GZ2EPHKWY",
                    "participantType": "human",
                    "displayName": "Stefan Johnson"
                }}]
            }}"#
        )
    }

    fn poll_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-23T12:00:00Z")
            .expect("fixed poll time")
            .with_timezone(&Utc)
    }

    #[test]
    fn mention_detection_matches_participant_uid_live_shape() {
        let mentioned = mk_channel_msg(&live_mention_json("evt_1", "prs_ada"));
        assert!(is_mention_of_me(&mentioned, ME, MY_SUB));
        assert!(message_mentions_person(&mentioned, ME, MY_SUB));
        assert!(message_mentions_person(&mentioned, ME, ""));
    }

    #[test]
    fn mention_detection_ignores_at_name_text_without_structured_mention() {
        let text_only = mk_channel_msg(
            r#"{
                "eventId": "evt_text",
                "fromPersonUid": "prs_ada",
                "body": "hey @Stefan without a structured mention",
                "createdAt": "2026-09-23T12:00:00Z",
                "direction": "in"
            }"#,
        );
        assert!(!message_mentions_person(&text_only, ME, MY_SUB));
        assert!(!is_mention_of_me(&text_only, ME, MY_SUB));
    }

    #[test]
    fn mention_detection_matches_cognito_sub_as_participant_uid() {
        let mentioned = mk_channel_msg(&format!(
            r#"{{
                "eventId": "evt_sub",
                "fromPersonUid": "prs_ada",
                "fromDisplayName": "Ada",
                "body": "hey",
                "createdAt": "2026-09-23T12:00:00Z",
                "direction": "in",
                "mentions": [{{
                    "participantUid": "{MY_SUB}",
                    "participantType": "human",
                    "displayName": "Stefan Johnson"
                }}]
            }}"#
        ));
        assert!(message_mentions_person(&mentioned, ME, MY_SUB));
        assert!(message_mentions_person(&mentioned, "", MY_SUB));
        assert!(!message_mentions_person(&mentioned, ME, ""));
        assert!(is_mention_of_me(&mentioned, ME, MY_SUB));
    }

    #[test]
    fn mention_detection_empty_participant_uid_never_matches() {
        let mentioned = mk_channel_msg(
            r#"{
                "eventId": "evt_empty",
                "fromPersonUid": "prs_ada",
                "fromDisplayName": "Ada",
                "body": "hey",
                "createdAt": "2026-09-23T12:00:00Z",
                "direction": "in",
                "mentions": [{
                    "participantType": "human",
                    "displayName": "Stefan Johnson"
                }]
            }"#,
        );
        assert_eq!(mentioned.mentions.as_ref().unwrap()[0].participant_uid, "");
        assert!(!message_mentions_person(&mentioned, ME, MY_SUB));
        assert!(!is_mention_of_me(&mentioned, ME, MY_SUB));
    }

    #[test]
    fn mention_detection_skips_self_authored_even_when_mentions_me() {
        let as_person = mk_channel_msg(&live_mention_json("evt_self_prs", ME));
        assert!(!is_mention_of_me(&as_person, ME, MY_SUB));
        assert!(is_self_authored(ME, ME, MY_SUB));

        let as_sub = mk_channel_msg(&live_mention_json("evt_self_sub", MY_SUB));
        assert!(is_self_authored(MY_SUB, ME, MY_SUB));
        assert!(!is_mention_of_me(&as_sub, ME, MY_SUB));
    }

    #[test]
    fn mention_cursor_first_poll_seeds_newest_without_replay() {
        let older = mk_channel_msg(&live_mention_json("evt_old", "prs_ada"));
        let newest = mk_channel_msg(&live_mention_json("evt_new", "prs_ada"));
        let page = vec![newest, older];
        let (cursor, consider) = advance_mention_cursor(&page, None, poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert!(consider.is_empty());
        assert_eq!(seed_mention_cursor(&page).as_deref(), Some("evt_new"));
    }

    #[test]
    fn mention_cursor_advance_returns_messages_newer_than_last_seen() {
        let oldest = mk_channel_msg(&live_mention_json("evt_old", "prs_ada"));
        let mid = mk_channel_msg(&live_mention_json("evt_mid", "prs_ada"));
        let newest = mk_channel_msg(&live_mention_json("evt_new", "prs_ada"));
        let page = vec![newest, mid, oldest];
        let (cursor, consider) = advance_mention_cursor(&page, Some("evt_old"), poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert_eq!(
            consider
                .iter()
                .map(|m| m.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_new", "evt_mid"]
        );
    }

    #[test]
    fn mention_cursor_missing_from_page_advances_silently() {
        let older = mk_channel_msg(&live_mention_json_at(
            "evt_old",
            "prs_ada",
            "2026-09-23T10:00:00Z",
        ));
        let newest = mk_channel_msg(&live_mention_json_at(
            "evt_new",
            "prs_ada",
            "2026-09-23T10:01:00Z",
        ));
        let page = vec![newest, older];
        let (cursor, consider) = advance_mention_cursor(&page, Some("evt_not_in_page"), poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert!(consider.is_empty());
    }

    #[test]
    fn mention_cursor_missing_from_page_keeps_newest_if_within_ten_minutes() {
        let newest = mk_channel_msg(&live_mention_json_at(
            "evt_new",
            "prs_ada",
            "2026-09-23T11:55:00Z",
        ));
        let older = mk_channel_msg(&live_mention_json_at(
            "evt_old",
            "prs_ada",
            "2026-09-23T11:50:00Z",
        ));
        let page = vec![newest, older];
        let (cursor, consider) = advance_mention_cursor(&page, Some("evt_not_in_page"), poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert_eq!(
            consider
                .iter()
                .map(|m| m.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_new"]
        );
    }

    #[test]
    fn mention_first_fetch_seeds_silently_ignoring_unread_delta() {
        let older = mk_channel_msg(&live_mention_json("evt_old", "prs_ada"));
        let newest = mk_channel_msg(&live_mention_json("evt_new", "prs_ada"));
        let page = vec![newest, older];
        let (cursor, consider) = advance_mention_cursor(&page, None, poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert!(consider.is_empty());
    }

    #[test]
    fn mention_reset_for_session_then_growth_seeds_silently() {
        let mut watch = MentionWatchInner::default();
        watch
            .last_event_by_channel
            .insert("chn_eng".into(), "evt_old".into());
        watch.pending_fetches.push(("chn_eng".into(), "eng".into()));
        watch.reset_for_session();
        assert!(watch.last_event_by_channel.is_empty());
        assert!(watch.pending_fetches.is_empty());

        let newest = mk_channel_msg(&live_mention_json("evt_new", "prs_ada"));
        let page = vec![newest];
        let last_seen = watch
            .last_event_by_channel
            .get("chn_eng")
            .map(String::as_str);
        let (cursor, consider) = advance_mention_cursor(&page, last_seen, poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_new"));
        assert!(consider.is_empty());
    }

    #[test]
    fn mention_stale_created_at_is_filtered() {
        let oldest = mk_channel_msg(&live_mention_json_at(
            "evt_oldest",
            "prs_ada",
            "2026-09-23T11:30:00Z",
        ));
        let stale = mk_channel_msg(&live_mention_json_at(
            "evt_stale",
            "prs_ada",
            "2026-09-23T11:40:00Z",
        ));
        let fresh = mk_channel_msg(&live_mention_json_at(
            "evt_fresh",
            "prs_ada",
            "2026-09-23T11:50:00Z",
        ));
        let page = vec![fresh, stale, oldest];
        let (_, consider) = advance_mention_cursor(&page, Some("evt_oldest"), poll_now());
        assert_eq!(
            consider
                .iter()
                .map(|m| m.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_fresh", "evt_stale"]
        );
        let fresh_only = filter_mentions_by_age(consider, poll_now(), MENTION_FRESH_MAX_AGE);
        assert_eq!(
            fresh_only
                .iter()
                .map(|m| m.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_fresh"]
        );
    }

    #[test]
    fn mention_cycle_cap_delivers_newest_two_plus_summary() {
        let items = vec![
            MentionCapItem {
                created_at: "2026-09-23T11:50:00Z".into(),
                channel_id: "chn_a".into(),
            },
            MentionCapItem {
                created_at: "2026-09-23T11:58:00Z".into(),
                channel_id: "chn_b".into(),
            },
            MentionCapItem {
                created_at: "2026-09-23T11:55:00Z".into(),
                channel_id: "chn_c".into(),
            },
            MentionCapItem {
                created_at: "2026-09-23T11:52:00Z".into(),
                channel_id: "chn_d".into(),
            },
        ];
        let plan = plan_mention_cap(&items);
        assert_eq!(plan.deliver_indices, vec![1, 2]);
        assert_eq!(
            plan.summary,
            Some(MentionSummary {
                extra_count: 2,
                channel_id: "chn_a".into(),
            })
        );
        assert_eq!(mention_summary_title(2), "You were mentioned 2 more times");
        let under_cap = plan_mention_cap(&items[..3]);
        assert_eq!(under_cap.deliver_indices, vec![0, 1, 2]);
        assert!(under_cap.summary.is_none());
    }

    #[test]
    fn mention_fetch_failure_leaves_cursor_unchanged() {
        let current = Some("evt_old");
        let newest = mk_channel_msg(&live_mention_json("evt_new", "prs_ada"));
        let page = vec![newest];
        let (cursor, consider) = mention_cursor_after_fetch(current, false, &page, poll_now());
        assert_eq!(cursor.as_deref(), Some("evt_old"));
        assert!(consider.is_empty());

        let (ok_cursor, ok_consider) = mention_cursor_after_fetch(current, true, &page, poll_now());
        assert_eq!(ok_cursor.as_deref(), Some("evt_new"));
        assert_eq!(
            ok_consider
                .iter()
                .map(|m| m.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_new"]
        );
    }

    #[test]
    fn mention_fetch_batch_caps_at_four_and_rotates_rest() {
        let mut pending = vec![
            ("c1".into(), "one".into()),
            ("c2".into(), "two".into()),
            ("c3".into(), "three".into()),
            ("c4".into(), "four".into()),
            ("c5".into(), "five".into()),
            ("c6".into(), "six".into()),
        ];
        enqueue_mention_fetches(&mut pending, &[("c1".into(), "one".into())]);
        assert_eq!(pending.len(), 6);
        let batch = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
        assert_eq!(
            batch.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2", "c3", "c4"]
        );
        assert_eq!(
            pending
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["c5", "c6"]
        );
    }

    #[test]
    fn mention_drain_fetches_all_six_channels_across_batches() {
        let mut pending = vec![
            ("c1".into(), "one".into()),
            ("c2".into(), "two".into()),
            ("c3".into(), "three".into()),
            ("c4".into(), "four".into()),
            ("c5".into(), "five".into()),
            ("c6".into(), "six".into()),
        ];
        let mut fetched = Vec::new();
        while !pending.is_empty() {
            let batch = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
            assert!(!batch.is_empty());
            fetched.extend(batch.into_iter().map(|(id, _)| id));
        }
        assert_eq!(
            fetched,
            vec![
                "c1".to_string(),
                "c2".to_string(),
                "c3".to_string(),
                "c4".to_string(),
                "c5".to_string(),
                "c6".to_string()
            ]
        );
    }

    #[test]
    fn mention_growth_while_in_flight_is_fetched_on_next_batch() {
        let mut pending = vec![
            ("c1".into(), "one".into()),
            ("c2".into(), "two".into()),
            ("c3".into(), "three".into()),
            ("c4".into(), "four".into()),
        ];
        let detect_in_flight = true;
        let batch1 = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
        enqueue_mention_fetches(
            &mut pending,
            &[("c5".into(), "five".into()), ("c6".into(), "six".into())],
        );
        assert!(detect_in_flight);
        assert!(!should_spawn_mention_detect(
            pending.len(),
            detect_in_flight
        ));
        let batch2 = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
        assert_eq!(
            batch1.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2", "c3", "c4"]
        );
        assert_eq!(
            batch2.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["c5", "c6"]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn mention_failed_fetch_is_retried_once_then_dropped() {
        let mut pending = vec![("dead".into(), "x".into())];
        let mut retried = HashSet::new();
        let batch = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
        requeue_failed_mention_fetches(&mut pending, &batch, &mut retried);
        assert_eq!(pending.len(), 1);
        let retry = take_mention_fetch_batch(&mut pending, MENTION_FETCH_PER_CYCLE);
        requeue_failed_mention_fetches(&mut pending, &retry, &mut retried);
        assert!(pending.is_empty());
    }

    #[test]
    fn mention_spawn_when_pending_and_idle_even_without_growth() {
        assert!(should_spawn_mention_detect(2, false));
        assert!(!should_spawn_mention_detect(2, true));
        assert!(!should_spawn_mention_detect(0, false));
        assert!(!should_spawn_mention_detect(0, true));
    }

    #[test]
    fn mention_created_at_accepts_naive_utc_and_logs_bad_ts() {
        let naive = parse_message_created_at("2026-09-23T12:00:00").expect("naive utc");
        let rfc = parse_message_created_at("2026-09-23T12:00:00Z").expect("rfc3339");
        assert_eq!(naive, rfc);
        assert!(parse_message_created_at("not-a-timestamp").is_none());

        let tmp = tempfile::tempdir().expect("tmpdir");
        let log_path = tmp.path().join("hq-sync.log");
        let _guard = crate::logfile::LogOverrideGuard::new(log_path.clone());
        assert!(parse_message_created_at_logged("nope", "evt_bad").is_none());
        crate::logfile::log("dm-notify", "flush");
        let body = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(body.contains("DM_NOTIFY_MENTION_BAD_TS event=evt_bad"));
        assert!(!body.contains("nope"));
    }

    #[test]
    fn mention_seen_set_drops_duplicate_ids() {
        let (fresh, updated) = take_unseen_message_ids(
            &["evt_1".into(), "evt_2".into(), "evt_1".into()],
            &["evt_1".into()],
        );
        assert_eq!(fresh, vec!["evt_2".to_string()]);
        assert_eq!(updated, vec!["evt_1".to_string(), "evt_2".to_string()]);
        let (again, _) = take_unseen_message_ids(&["evt_2".into()], &updated);
        assert!(again.is_empty());
    }

    #[test]
    fn mention_payload_title_body_and_route() {
        assert_eq!(
            mention_notification_title("Ada Lovelace", "engineering"),
            "Ada Lovelace mentioned you in #engineering"
        );
        assert_eq!(
            mention_route("chn_eng", "evt_1"),
            "inbox:channel:chn_eng:evt_1"
        );
        let long: String = "é".repeat(MENTION_BODY_MAX_CHARS + 8);
        let body = mention_notification_body(&long);
        assert_eq!(body.chars().count(), MENTION_BODY_MAX_CHARS);
        assert!(!body.contains('\u{FFFD}'));
    }

    #[test]
    fn mention_suppressed_when_channel_open_and_focused() {
        assert!(should_suppress_mention_for_open_channel(
            Some("chan:chn_eng"),
            "chn_eng",
            true,
        ));
        assert!(!should_suppress_mention_for_open_channel(
            Some("chan:chn_eng"),
            "chn_eng",
            false,
        ));
        assert!(!should_suppress_mention_for_open_channel(
            Some("chan:chn_other"),
            "chn_eng",
            true,
        ));
        assert!(!should_suppress_mention_for_open_channel(
            Some("dm:prs_ada"),
            "chn_eng",
            true,
        ));
    }

    #[test]
    fn mention_duplicate_event_id_is_suppressed() {
        assert!(should_suppress_duplicate_event(
            "evt_1",
            &["evt_0".into(), "evt_1".into()]
        ));
        assert!(!should_suppress_duplicate_event("evt_2", &["evt_1".into()]));
        assert!(!should_suppress_duplicate_event("", &["evt_1".into()]));
    }

    // ── US-005: audience field and filtering ─────────────────────────────────

    #[test]
    fn dm_event_deserializes_audience_field_when_present() {
        let json = r#"{
            "eventId": "evt_1",
            "fromPersonUid": "agt_bot",
            "fromEmail": "bot@hq.ai",
            "fromDisplayName": "Bot",
            "body": "status: running",
            "createdAt": "2026-09-23T10:00:00Z",
            "audience": "agent"
        }"#;
        let dm: DmEvent = serde_json::from_str(json).expect("DmEvent with audience parses");
        assert_eq!(dm.audience.as_deref(), Some("agent"));
    }

    #[test]
    fn dm_event_audience_absent_deserializes_as_none() {
        let json = r#"{
            "eventId": "evt_2",
            "fromPersonUid": "prs_human",
            "fromEmail": "h@b.com",
            "fromDisplayName": "Human",
            "body": "hello",
            "createdAt": "2026-09-23T10:00:00Z"
        }"#;
        let dm: DmEvent = serde_json::from_str(json).expect("DmEvent without audience parses");
        assert!(dm.audience.is_none());
    }

    #[test]
    fn thread_message_deserializes_audience_field() {
        let json = r#"{
            "eventId": "evt_t1",
            "fromPersonUid": "agt_bot",
            "fromEmail": "b@b.com",
            "fromDisplayName": "Bot",
            "body": "progress update",
            "createdAt": "2026-09-23T10:00:00Z",
            "direction": "in",
            "audience": "agent"
        }"#;
        let msg: ThreadMessage = serde_json::from_str(json).expect("ThreadMessage with audience parses");
        assert_eq!(msg.audience.as_deref(), Some("agent"));
    }

    #[test]
    fn thread_reply_deserializes_audience_field() {
        let json = r#"{
            "eventId": "evt_r1",
            "fromPersonUid": "agt_bot",
            "body": "delegating",
            "createdAt": "2026-09-23T10:00:00Z",
            "audience": "agent"
        }"#;
        let reply: ThreadReply = serde_json::from_str(json).expect("ThreadReply with audience parses");
        assert_eq!(reply.audience.as_deref(), Some("agent"));
    }

    #[test]
    fn thread_reply_audience_absent_is_none() {
        let json = r#"{
            "eventId": "evt_r2",
            "fromPersonUid": "prs_human",
            "body": "hey",
            "createdAt": "2026-09-23T10:00:00Z"
        }"#;
        let reply: ThreadReply = serde_json::from_str(json).expect("ThreadReply without audience parses");
        assert!(reply.audience.is_none());
    }

    #[test]
    fn is_agent_audience_classifies_correctly() {
        assert!(is_agent_audience(Some("agent")));
        assert!(is_agent_audience(Some("Agent")));
        assert!(is_agent_audience(Some("AGENT")));
        assert!(!is_agent_audience(Some("human")));
        assert!(!is_agent_audience(Some("both")));
        assert!(!is_agent_audience(None));
        assert!(!is_agent_audience(Some("")));
    }

    #[test]
    fn filter_human_visible_excludes_agent_messages_counts_as_unread() {
        // One human and two agent DMs: only the human one counts for unread.
        let events = vec![
            mk_dm_with_audience("e1", "2026-09-23T10:00:00Z", "human"),
            mk_dm_with_audience("e2", "2026-09-23T10:01:00Z", "agent"),
            mk_dm_with_audience("e3", "2026-09-23T10:02:00Z", "agent"),
        ];
        let visible = filter_human_visible_events(&events);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].event_id, "e1");
    }

    #[test]
    fn filter_human_visible_keeps_both_and_absent_audience() {
        let events = vec![
            mk_dm("e_absent", "2026-09-23T10:00:00Z"),
            mk_dm_with_audience("e_both", "2026-09-23T10:01:00Z", "both"),
            mk_dm_with_audience("e_human", "2026-09-23T10:02:00Z", "human"),
            mk_dm_with_audience("e_agent", "2026-09-23T10:03:00Z", "agent"),
        ];
        let visible = filter_human_visible_events(&events);
        assert_eq!(visible.len(), 3);
        let ids: Vec<&str> = visible.iter().map(|e| e.event_id.as_str()).collect();
        assert!(ids.contains(&"e_absent"));
        assert!(ids.contains(&"e_both"));
        assert!(ids.contains(&"e_human"));
        assert!(!ids.contains(&"e_agent"));
    }

    #[test]
    fn newest_non_agent_event_skips_leading_agent_messages() {
        // Newest-first list: two agent messages then a human one.
        let events = vec![
            mk_dm_with_audience("e_agent1", "2026-09-23T10:02:00Z", "agent"),
            mk_dm_with_audience("e_agent2", "2026-09-23T10:01:00Z", "agent"),
            mk_dm("e_human", "2026-09-23T10:00:00Z"),
        ];
        let preview = newest_non_agent_event(&events);
        assert_eq!(preview.map(|e| e.event_id.as_str()), Some("e_human"));
    }

    #[test]
    fn newest_non_agent_event_returns_none_when_all_agent() {
        let events = vec![
            mk_dm_with_audience("e1", "2026-09-23T10:00:00Z", "agent"),
            mk_dm_with_audience("e2", "2026-09-23T10:01:00Z", "agent"),
        ];
        assert!(newest_non_agent_event(&events).is_none());
    }

    #[test]
    fn newest_non_agent_event_returns_none_for_empty_slice() {
        assert!(newest_non_agent_event(&[]).is_none());
    }

    #[test]
    fn audience_field_round_trips_through_serialization() {
        let mut dm = mk_dm("evt_rt", "2026-09-23T10:00:00Z");
        dm.audience = Some("both".to_string());
        let v = serde_json::to_value(&dm).expect("serializes");
        assert_eq!(v["audience"], "both");
        let back: DmEvent = serde_json::from_value(v).expect("deserializes");
        assert_eq!(back.audience.as_deref(), Some("both"));
    }

    #[test]
    fn audience_absent_not_emitted_in_serialization() {
        let dm = mk_dm("evt_absent", "2026-09-23T10:00:00Z");
        let v = serde_json::to_value(&dm).expect("serializes");
        assert!(v.get("audience").is_none(), "absent audience must not emit a key");
    }
}
