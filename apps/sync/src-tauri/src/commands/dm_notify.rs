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
//! `~/.hq/dm-cursor.json`, keyed by a hash of Cognito subject + `machineId` so
//! each account on each device tracks an isolated inbox position. A legacy
//! machine-only entry is claimed once by the first authenticated account.
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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::cognito;
use crate::commands::messages::Channel;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

pub use hq_desktop_core::dm_notify::{
    build_compose_payload, build_send_payload, build_thread_reply_payload, build_thread_url,
    build_threads_url, classify_send_response, clear_in_flight, diff_requests,
    dm_notifications_enabled, effective_reply_count, enqueue_mention_fetches, esc_thread_seg,
    filter_mentions_by_age, is_mention_of_me, mention_cursor_after_fetch,
    mention_notification_body, mention_notification_title, mention_route, mention_summary_title,
    normalize_scope, partition_unnotified, plan_mention_cap, read_cursor_entry_for_account,
    requeue_failed_mention_fetches, respond_action_path, respond_action_state,
    should_spawn_mention_detect, should_suppress_duplicate_event,
    should_suppress_mention_for_open_channel, take_mention_fetch_batch, take_unseen_message_ids,
    try_set_in_flight, write_cursor_entry_for_account, ActiveConversationInner,
    ActiveConversationState, ActiveThreadInner, ActiveThreadState, CursorEntry, DmEvent,
    InboxResponse, MentionCapItem, MentionWatchState, PairUnread, PairUnreadState,
    RequestsListResponse, SeenChannelState, SeenRequestState, SendDmOutcome, ThreadReply,
    ThreadResponse, ThreadView, UnreadDmState, MENTION_FETCH_PER_CYCLE, MENTION_FRESH_MAX_AGE,
};

const LOG_TAG: &str = "dm-notify";

// ── Fine-grained notification prefs (GET /v1/notify/prefs) ──────────────────
//
// The server stores per-person prefs and a per-channel level and applies them
// to push and to the `notify` hint on channel wakes. The poller mirrors those
// rules (see `hq_desktop_core::notify_prefs`). The local `dmNotifications`
// switch in menubar.json stays a master override: when it is off `do_poll`
// returns before any of this runs.

/// How long a fetched prefs row is reused before the next poll refetches it.
const NOTIFY_PREFS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
struct NotifyPrefsCache {
    /// Cognito identity the cached value belongs to.
    identity: String,
    /// `None` = route unavailable (404 / old server) or never fetched; the
    /// poller keeps its pre-prefs behaviour.
    prefs: Option<hq_desktop_core::notify_prefs::NotifyPrefs>,
    fetched_at: Option<std::time::Instant>,
}

fn notify_prefs_cache() -> &'static Mutex<NotifyPrefsCache> {
    static CACHE: OnceLock<Mutex<NotifyPrefsCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(NotifyPrefsCache::default()))
}

/// In-memory `prs_` uid for the signed-in person. `config.json` is the cheap
/// first source; many installs never wrote `personUid` there, so the poller
/// falls back to the same vault person-entity list `whoami` uses, keyed by
/// Cognito identity. Never written back to config.json.
#[derive(Default)]
struct PersonUidCache {
    identity: String,
    uid: Option<String>,
    /// A server resolve was already attempted for `identity`.
    fetched: bool,
    /// `DM_NOTIFY_MENTION_SKIP no personUid` already logged this session.
    skip_logged: bool,
}

fn person_uid_cache() -> &'static Mutex<PersonUidCache> {
    static CACHE: OnceLock<Mutex<PersonUidCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(PersonUidCache::default()))
}

fn clear_person_uid_cache() {
    let mut guard = person_uid_cache().lock().unwrap_or_else(|p| p.into_inner());
    *guard = PersonUidCache::default();
}

fn nonempty_person_uid(uid: Option<String>) -> Option<String> {
    uid.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn cached_person_uid(identity: &str) -> Option<String> {
    let guard = person_uid_cache().lock().unwrap_or_else(|p| p.into_inner());
    if guard.identity != identity {
        return None;
    }
    nonempty_person_uid(guard.uid.clone())
}

fn person_uid_fetched_for(identity: &str) -> bool {
    let guard = person_uid_cache().lock().unwrap_or_else(|p| p.into_inner());
    guard.identity == identity && guard.fetched
}

fn store_person_uid_cache(identity: &str, uid: Option<String>) {
    let mut guard = person_uid_cache().lock().unwrap_or_else(|p| p.into_inner());
    guard.identity = identity.to_string();
    guard.uid = nonempty_person_uid(uid);
    guard.fetched = true;
}

fn take_missing_person_uid_skip_log() -> bool {
    let mut guard = person_uid_cache().lock().unwrap_or_else(|p| p.into_inner());
    if guard.skip_logged {
        return false;
    }
    guard.skip_logged = true;
    true
}

fn log_missing_person_uid_once() {
    if take_missing_person_uid_skip_log() {
        log(LOG_TAG, "DM_NOTIFY_MENTION_SKIP no personUid");
    }
}

/// eventId → `notify` hints read off realtime channel/thread wakes.
fn wake_notify_hints() -> &'static Mutex<hq_desktop_core::notify_prefs::WakeNotifyHints> {
    static HINTS: OnceLock<Mutex<hq_desktop_core::notify_prefs::WakeNotifyHints>> = OnceLock::new();
    HINTS.get_or_init(|| Mutex::new(Default::default()))
}

/// channelId → resolved `membership.notifyLevel` from the latest channel poll.
fn channel_notify_levels() -> &'static Mutex<HashMap<String, String>> {
    static LEVELS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    LEVELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record the `notify` hint of a realtime wake payload (called by the MQTT
/// receiver before it wakes the poll). Wakes without the flag are ignored, so
/// older producers keep the computed rule.
pub fn record_wake_notify_hint(payload: &[u8]) {
    if let Some((event_id, notify)) = hq_desktop_core::notify_prefs::parse_wake_notify_hint(payload)
    {
        wake_notify_hints()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .record(event_id, notify);
    }
}

fn wake_notify_hint(event_id: &str) -> Option<bool> {
    wake_notify_hints()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(event_id)
}

fn channel_notify_level(channel_id: &str) -> Option<hq_desktop_core::notify_prefs::NotifyLevel> {
    channel_notify_levels()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(channel_id)
        .and_then(|level| hq_desktop_core::notify_prefs::NotifyLevel::parse(level))
}

/// Prefs for `identity`, or `None` when unavailable.
fn cached_notify_prefs(identity: &str) -> Option<hq_desktop_core::notify_prefs::NotifyPrefs> {
    let guard = notify_prefs_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if guard.identity != identity {
        return None;
    }
    guard.prefs.clone()
}

/// Refresh the prefs cache when stale. 404 → unavailable (legacy behaviour).
/// A transient failure keeps the last good value for the same identity.
async fn refresh_notify_prefs(base_url: &str, auth: &NotificationAuthSnapshot) {
    {
        let guard = notify_prefs_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if guard.identity == auth.identity
            && guard
                .fetched_at
                .is_some_and(|at| at.elapsed() < NOTIFY_PREFS_TTL)
        {
            return;
        }
    }
    let url = format!("{base_url}/v1/notify/prefs");
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", auth.access_token))
        .send()
        .await;
    let fetched: Result<Option<hq_desktop_core::notify_prefs::NotifyPrefs>, String> = match resp {
        Err(e) => Err(format!("network: {e}")),
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => Ok(None),
        Ok(r) if !r.status().is_success() => Err(format!("status={}", r.status())),
        Ok(r) => match r.text().await {
            Ok(body) => hq_desktop_core::notify_prefs::parse_prefs_body(&body)
                .map(Some)
                .ok_or_else(|| "parse".to_string()),
            Err(e) => Err(format!("body: {e}")),
        },
    };
    let mut guard = notify_prefs_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let same_identity = guard.identity == auth.identity;
    match fetched {
        Ok(prefs) => {
            if prefs.is_none() {
                log(LOG_TAG, "DM_NOTIFY_PREFS_UNAVAILABLE 404 (legacy rules)");
            }
            guard.prefs = prefs;
        }
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_PREFS_FETCH_FAIL {e}"));
            if !same_identity {
                guard.prefs = None;
            }
        }
    }
    guard.identity = auth.identity.clone();
    guard.fetched_at = Some(std::time::Instant::now());
}

/// Tauri command: drop the cached prefs so the next poll refetches them.
/// Called by Settings after a successful PUT so a pause applies immediately.
#[tauri::command]
pub fn invalidate_notify_prefs_cache() {
    notify_prefs_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .fetched_at = None;
}

/// Tauri event emitted when new DMs are found (frontend may surface a badge
/// or inbox view; currently informational, mirrors `share:new-events`).
pub const EVENT_DM_NEW_EVENTS: &str = "dm:new-events";

/// Tauri event emitted when the inbox poll (or mark-read) updates per-pair DM
/// unread rollups (hq-pro US-010 / desktop US-011). Payload:
/// `{ pairUnreads: [{ withPersonUid, lastReadAt?, unreadCount }] }`.
/// ChatSidebar merges these into DM row badges. Absent on older servers → the
/// poll never emits this after a legacy payload (empty pairUnreads = no-op).
pub const EVENT_DM_PAIR_UNREADS: &str = "dm:pair-unreads";

/// Tauri event emitted by the SINGLE poll path when a new reply lands in the
/// thread the user currently has open (US-022). A "thread" wake on the person
/// topic routes through the same `poll_dm_once` → `do_poll` path as DMs/channels
/// (the MQTT wake is ids-only); `do_poll` re-fetches the active thread and emits
/// this for each reply not previously seen. Payload is `{ rootEventId, eventId,
/// scope, channelId|withPersonUid, reply, replyCount }` — UI hosts use the ids
/// and scope to re-fetch their own visible thread; they never payload-apply a
/// reply from another account or conversation. There is NO parallel thread
/// poller.
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

/// Tauri event emitted whenever an authoritative per-channel unread count
/// changes, including decreases to zero. The menu-bar aggregate listens to this
/// separately from `channel:new-message`, which remains an increase-only
/// content-refresh signal.
pub const EVENT_CHANNEL_UNREAD_CHANGED: &str = "channel:unread-changed";

/// Tauri event emitted by the SINGLE poll path when a channel's metadata
/// changed (US-018) — a brand-new channel appeared (created/invited), or its
/// name/membership/member-count changed. Payload is the full `Channel` (camel).
/// ChannelList upserts it so a new invite/channel appears live without a manual
/// refresh.
pub const EVENT_CHANNEL_UPDATED: &str = "channel:updated";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationAuthSnapshot {
    pub generation: u64,
    pub identity: String,
    pub access_token: String,
}

struct NotificationSessionInner {
    generation: u64,
    identity: Option<String>,
    access_token: Option<String>,
}

impl Default for NotificationSessionInner {
    fn default() -> Self {
        Self {
            generation: 0,
            identity: None,
            access_token: None,
        }
    }
}

impl NotificationSessionInner {
    fn auth_snapshot(&self) -> Option<NotificationAuthSnapshot> {
        Some(NotificationAuthSnapshot {
            generation: self.generation,
            identity: self.identity.clone()?,
            access_token: self.access_token.clone()?,
        })
    }
}

/// Owns notification authentication identity and a cancellation pulse for the
/// current generation. Polls capture one identity/generation/access-token
/// snapshot before any network work and may commit only while that exact
/// snapshot is still active. A transition withdraws the current identity and
/// broadcasts immediately. Cancellable work (polls/banners) is dropped;
/// intentional writes are tracked separately until their bounded response.
pub struct NotificationSessionState {
    inner: tokio::sync::Mutex<NotificationSessionInner>,
    invalidation: tokio::sync::watch::Sender<u64>,
    mutation_leases: Arc<NotificationMutationLeases>,
    /// Serializes local credential-file writes only. Never held while waiting
    /// for the network or a banner, so auth invalidation stays prompt.
    credential_write_gate: tokio::sync::Mutex<()>,
}

impl NotificationSessionState {
    pub fn new() -> Self {
        let (invalidation, _) = tokio::sync::watch::channel(0u64);
        Self {
            inner: tokio::sync::Mutex::new(NotificationSessionInner::default()),
            invalidation,
            mutation_leases: Arc::new(NotificationMutationLeases::default()),
            credential_write_gate: tokio::sync::Mutex::new(()),
        }
    }
}

/// A short-lived, intentionally remote-mutating operation (ACK, mark-read,
/// request response). Auth transitions withdraw the active identity first and
/// then wait for these leases to drain before publishing the next account,
/// which establishes a linearization point: no previous-account write is still
/// in flight once the next account is visible to the rest of the app.
#[derive(Default)]
struct NotificationMutationLeases {
    active: Mutex<usize>,
    drained: tokio::sync::Notify,
}

impl NotificationMutationLeases {
    fn acquire(self: &Arc<Self>) -> NotificationMutationLease {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active = active.saturating_add(1);
        NotificationMutationLease {
            tracker: Arc::clone(self),
        }
    }

    async fn wait_for_drain(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            // Register before inspecting `active`: `notify_waiters` does not
            // retain a permit for a future waiter, so enabling first closes the
            // last-lease-drop race between the count read and `.await`.
            notified.as_mut().enable();
            if *self
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                == 0
            {
                return;
            }
            notified.await;
        }
    }
}

struct NotificationMutationLease {
    tracker: Arc<NotificationMutationLeases>,
}

impl Drop for NotificationMutationLease {
    fn drop(&mut self) {
        let mut active = self
            .tracker
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert!(*active > 0, "notification mutation lease underflow");
        *active = active.saturating_sub(1);
        if *active == 0 {
            self.tracker.drained.notify_waiters();
        }
    }
}

async fn transition_notification_session_if_generation<R: Runtime>(
    app: &AppHandle<R>,
    identity: Option<String>,
    access_token: Option<String>,
    force_reset: bool,
) -> Option<(u64, Option<NotificationAuthSnapshot>)> {
    transition_notification_session_if_generation_expected(
        app,
        identity,
        access_token,
        force_reset,
        None,
    )
    .await
}

/// Apply one transition only if no other auth transition happened after the
/// caller captured `expected_generation`. This is the publish CAS for token
/// resolution: an old resolver cannot restore account A after OAuth/sign-out
/// has already invalidated A.
async fn transition_notification_session_if_generation_expected<R: Runtime>(
    app: &AppHandle<R>,
    identity: Option<String>,
    access_token: Option<String>,
    force_reset: bool,
    expected_generation: Option<u64>,
) -> Option<(u64, Option<NotificationAuthSnapshot>)> {
    let Some(session_state) = app.try_state::<NotificationSessionState>() else {
        return None;
    };
    let mut session = session_state.inner.lock().await;
    if expected_generation.is_some_and(|expected| session.generation != expected) {
        return None;
    }
    let identity_changed = session.identity != identity;
    let token_changed = session.access_token != access_token;
    if !force_reset && !identity_changed && !token_changed {
        return Some((session.generation, session.auth_snapshot()));
    }

    // Phase 1: withdraw the old identity and wake all existing operations.
    // This is deliberately separate from publishing the next identity below:
    // callers never see account B as active while an intentional account-A
    // write still owns a lease.
    session.generation = session.generation.wrapping_add(1);
    session.identity = None;
    session.access_token = None;
    let generation = session.generation;

    // Notify active work while this brief state update is still serialized.
    // Receivers are created only after they validated the matching snapshot,
    // so a changed value always means their identity/token is no longer safe.
    session_state.invalidation.send_replace(generation);

    // A same-account access-token refresh invalidates in-flight network work,
    // but the account's unread/seen UI state remains valid. Account replacement
    // and explicit replacement/sign-out clear all account-scoped state.
    if force_reset || identity_changed {
        if let Some(state) = app.try_state::<UnreadDmState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = 0;
        }
        if let Some(state) = app.try_state::<PairUnreadState>() {
            state.0.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }
        if let Some(state) = app.try_state::<SeenRequestState>() {
            state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reset_for_session();
        }
        let cleared_channel_ids = app
            .try_state::<SeenChannelState>()
            .map(|state| {
                let mut channels = state.0.lock().unwrap_or_else(|p| p.into_inner());
                let ids = channels.unread_by_id.keys().cloned().collect::<Vec<_>>();
                channels.reset_for_session();
                ids
            })
            .unwrap_or_default();
        if let Some(state) = app.try_state::<MentionWatchState>() {
            state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reset_for_session();
        }
        clear_person_uid_cache();
        if let Some(state) = app.try_state::<ActiveThreadState>() {
            state.0.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }
        if let Some(state) = app.try_state::<ActiveConversationState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = ActiveConversationInner::default();
        }
        if let Some(state) = app.try_state::<WatchedSharesState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = WatchedSharesInner::default();
        }

        let summary = serde_json::json!({ "unreadDms": 0u32, "pendingRequests": 0u32 });
        let _ = app.emit(EVENT_DM_UNREAD_SUMMARY, &summary);
        let _ = app.emit(
            EVENT_DM_PAIR_UNREADS,
            &serde_json::json!({ "pairUnreads": [] }),
        );
        for channel_id in cleared_channel_ids {
            let unread = serde_json::json!({ "channelId": channel_id, "unread": 0u32 });
            let _ = app.emit(EVENT_CHANNEL_UNREAD_CHANGED, &unread);
        }
    }

    let mutation_leases = Arc::clone(&session_state.mutation_leases);
    drop(session);

    // Cancellable work sees the invalidation; an intentional remote mutation
    // instead completes under its lease. Do not publish the next identity or
    // return from an auth transition until every such lease is gone.
    mutation_leases.wait_for_drain().await;

    // Phase 2: publish the next identity only if another transition did not
    // win while we waited for old mutations. Keeping the same generation is
    // safe: it was already broadcast as the cancellation boundary, and no
    // caller can obtain a new authenticated snapshot before this publication.
    let snapshot = match (identity, access_token) {
        (Some(identity), Some(access_token)) => {
            let mut session = session_state.inner.lock().await;
            if session.generation != generation || session.identity.is_some() {
                return None;
            }
            session.identity = Some(identity);
            session.access_token = Some(access_token);
            session.auth_snapshot()
        }
        (None, None) => None,
        _ => return None,
    };
    Some((generation, snapshot))
}

async fn transition_notification_session<R: Runtime>(
    app: &AppHandle<R>,
    identity: Option<String>,
    access_token: Option<String>,
    force_reset: bool,
) -> (u64, Option<NotificationAuthSnapshot>) {
    transition_notification_session_if_generation(app, identity, access_token, force_reset)
        .await
        .unwrap_or((0, None))
}

/// Establish the first authenticated notification session, or reset all
/// account-scoped state when Cognito resolves to a different person.
pub async fn ensure_notification_session<R: Runtime>(
    app: &AppHandle<R>,
    identity: String,
    access_token: String,
) -> NotificationAuthSnapshot {
    transition_notification_session(app, Some(identity), Some(access_token), false)
        .await
        .1
        .expect("authenticated notification transition must yield a snapshot")
}

/// Start a freshly-authenticated session even when the same person signs back
/// in, invalidating work started with the previous token generation.
pub async fn replace_notification_session<R: Runtime>(
    app: &AppHandle<R>,
    identity: String,
    access_token: String,
) -> NotificationAuthSnapshot {
    transition_notification_session(app, Some(identity), Some(access_token), true)
        .await
        .1
        .expect("authenticated notification transition must yield a snapshot")
}

/// Force invalidation for an explicit sign-out so even a poll captured before
/// token deletion cannot commit afterward.
pub async fn invalidate_notification_session<R: Runtime>(app: &AppHandle<R>) -> u64 {
    transition_notification_session(app, None, None, true)
        .await
        .0
}

pub async fn current_notification_auth_snapshot<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<NotificationAuthSnapshot> {
    let state = app.try_state::<NotificationSessionState>()?;
    let snapshot = state.inner.lock().await.auth_snapshot();
    snapshot
}

async fn notification_session_generation<R: Runtime>(app: &AppHandle<R>) -> Option<u64> {
    let state = app.try_state::<NotificationSessionState>()?;
    let generation = state.inner.lock().await.generation;
    Some(generation)
}

async fn clear_notification_session_if_generation<R: Runtime>(
    app: &AppHandle<R>,
    expected_generation: u64,
) -> Option<u64> {
    transition_notification_session_if_generation_expected(
        app,
        None,
        None,
        false,
        Some(expected_generation),
    )
    .await
    .map(|(generation, _)| generation)
}

async fn ensure_notification_session_if_generation<R: Runtime>(
    app: &AppHandle<R>,
    expected_generation: u64,
    identity: String,
    access_token: String,
) -> Option<NotificationAuthSnapshot> {
    transition_notification_session_if_generation_expected(
        app,
        Some(identity),
        Some(access_token),
        false,
        Some(expected_generation),
    )
    .await
    .and_then(|(_, snapshot)| snapshot)
}

async fn replace_notification_session_if_generation<R: Runtime>(
    app: &AppHandle<R>,
    expected_generation: u64,
    identity: String,
    access_token: String,
) -> Option<NotificationAuthSnapshot> {
    transition_notification_session_if_generation_expected(
        app,
        Some(identity),
        Some(access_token),
        true,
        Some(expected_generation),
    )
    .await
    .and_then(|(_, snapshot)| snapshot)
}

/// Run a synchronous state mutation/event emission only if the network work
/// still belongs to the exact identity, token, and generation it captured.
pub async fn with_current_notification_auth_snapshot<R: Runtime, T>(
    app: &AppHandle<R>,
    expected: &NotificationAuthSnapshot,
    commit: impl FnOnce() -> T,
) -> Option<T> {
    let state = app.try_state::<NotificationSessionState>()?;
    let session = state.inner.lock().await;
    if session.auth_snapshot().as_ref() != Some(expected) {
        return None;
    }
    Some(commit())
}

/// Run an async operation only while `expected` remains the active session.
///
/// The state mutex is deliberately released before polling `operation`: auth
/// transitions must not queue behind a slow HTTP request or a native-banner
/// await. Every transition changes the watch value, which cancels an operation
/// that has not completed and suppresses any result that races the transition.
/// This is used for cancellable non-mutating async work such as native banner
/// presentation. Remote writes use [`with_current_notification_mutation`] so
/// auth transitions also await an intentional-write lease.
pub async fn with_current_notification_auth_snapshot_async<R, F, Fut, T>(
    app: &AppHandle<R>,
    expected: &NotificationAuthSnapshot,
    operation: F,
) -> Option<T>
where
    R: Runtime,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let state = app.try_state::<NotificationSessionState>()?;
    let session = state.inner.lock().await;
    if session.auth_snapshot().as_ref() != Some(expected) {
        return None;
    }
    let mut invalidation = state.invalidation.subscribe();
    drop(session);

    tokio::select! {
        biased;
        changed = invalidation.changed() => {
            // A dropped sender can only happen while the app is shutting down;
            // treating it as invalidation prevents an old operation committing.
            let _ = changed;
            None
        }
        output = operation() => {
            with_current_notification_auth_snapshot(app, expected, || output).await
        }
    }
}

/// Run a remote mutation only while `expected` remains current.
///
/// The lease is acquired while the exact session snapshot is still protected,
/// then the state mutex is released before network I/O. Unlike a poll or a
/// banner, a write is deliberately **not** cancelled after dispatch: dropping a
/// client future cannot prove the server did not receive it. A transition
/// withdraws the old identity immediately, then waits for this lease through
/// the bounded server response before publishing the next identity or
/// returning. Once a transition returns, no previous-account write can still
/// be executing remotely. Every caller uses `build_client`, whose default
/// request timeout bounds how long a transition can remain withdrawn.
pub async fn with_current_notification_mutation<R, F, Fut, T>(
    app: &AppHandle<R>,
    expected: &NotificationAuthSnapshot,
    operation: F,
) -> Option<T>
where
    R: Runtime,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let state = app.try_state::<NotificationSessionState>()?;
    let session = state.inner.lock().await;
    if session.auth_snapshot().as_ref() != Some(expected) {
        return None;
    }
    let lease = state.mutation_leases.acquire();
    drop(session);

    let output = operation().await;
    let result = with_current_notification_auth_snapshot(app, expected, || output).await;
    drop(lease);
    result
}

pub(crate) async fn resolve_notification_auth_snapshot<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<NotificationAuthSnapshot, String> {
    let (_, snapshot) = resolve_notification_credentials(app).await?;
    Ok(snapshot)
}

pub(crate) async fn resolve_notification_credentials<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(cognito::CognitoTokens, NotificationAuthSnapshot), String> {
    let started_generation = notification_session_generation(app)
        .await
        .ok_or_else(|| "Notification session state is unavailable".to_string())?;
    let tokens = match cognito::get_valid_tokens().await {
        Ok(tokens) => tokens,
        Err(error) => {
            // A refresh transport failure is recoverable and must keep its
            // existing tenant partition. Cognito removes invalid credentials
            // before returning, so clear notification ownership only when no
            // credential remains for this generation.
            if cognito::get_tokens().await.ok().flatten().is_none() {
                let _ = clear_notification_session_if_generation(app, started_generation).await;
            }
            return Err(error);
        }
    };
    let snapshot = ensure_notification_session_if_generation(
        app,
        started_generation,
        crate::commands::auth::notification_identity_from_tokens(&tokens),
        tokens.access_token.clone(),
    )
    .await
    .ok_or_else(|| "Authentication changed while resolving credentials".to_string())?;
    Ok((tokens, snapshot))
}

pub(crate) async fn replace_notification_credentials<R: Runtime>(
    app: &AppHandle<R>,
    tokens: &cognito::CognitoTokens,
) -> Result<NotificationAuthSnapshot, String> {
    let state = app
        .try_state::<NotificationSessionState>()
        .ok_or_else(|| "Notification session state is unavailable".to_string())?;
    // Invalidate before token publication so no poll can observe the new token
    // while the previous account's notification generation is still current.
    let generation = invalidate_notification_session(app).await;
    let _credential_write = state.credential_write_gate.lock().await;
    cognito::set_tokens(tokens).await?;
    replace_notification_session_if_generation(
        app,
        generation,
        crate::commands::auth::notification_identity_from_tokens(tokens),
        tokens.access_token.clone(),
    )
    .await
    .ok_or_else(|| "Authentication changed while storing credentials".to_string())
}

pub(crate) async fn clear_notification_credentials<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let state = app
        .try_state::<NotificationSessionState>()
        .ok_or_else(|| "Notification session state is unavailable".to_string())?;
    invalidate_notification_session(app).await;
    let _credential_write = state.credential_write_gate.lock().await;
    let cleared = cognito::clear_tokens().await;
    // Client health (US-002): sign-out is an auth state change.
    crate::commands::client_health::notify_client_health_state_changed();
    cleared
}

pub(crate) async fn refresh_notification_credentials<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<cognito::CognitoTokens, String> {
    let started_generation = notification_session_generation(app)
        .await
        .ok_or_else(|| "Notification session state is unavailable".to_string())?;

    let Some(started_from) = cognito::get_tokens().await? else {
        let _ = clear_notification_session_if_generation(app, started_generation).await;
        return Err("No tokens found — user is not signed in".to_string());
    };
    let refreshed = match cognito::refresh_access_token_classified(&started_from.refresh_token)
        .await
    {
        Ok(tokens) => tokens,
        Err(error) => {
            if error.requires_reauth {
                cognito::invalidate_tokens(&started_from).await?;
            }
            match cognito::get_tokens().await? {
                Some(current) if current != started_from && !cognito::is_expired(&current) => {
                    current
                }
                _ => {
                    if error.requires_reauth {
                        let _ =
                            clear_notification_session_if_generation(app, started_generation).await;
                    }
                    return Err(cognito::REAUTH_MESSAGE.to_string());
                }
            }
        }
    };

    let Some(current) = cognito::persist_refreshed_tokens_if_current(&started_from, &refreshed)
        .await?
        .into_current_tokens()
    else {
        let _ = clear_notification_session_if_generation(app, started_generation).await;
        return Err("No tokens found — user is not signed in".to_string());
    };
    let current = if cognito::is_expired(&current) {
        cognito::get_valid_tokens().await?
    } else {
        current
    };
    ensure_notification_session_if_generation(
        app,
        started_generation,
        crate::commands::auth::notification_identity_from_tokens(&current),
        current.access_token.clone(),
    )
    .await
    .ok_or_else(|| "Authentication changed while refreshing credentials".to_string())?;
    Ok(current)
}

/// Add `delta` to the running unread-DM count and emit `dm:unread-summary` so
/// the popover badge updates immediately. Called from `do_poll` (the one
/// poller). Best-effort: if the request count can't be fetched here we emit the
/// DM count alone — `get_unread_summary` reconciles requests on next read.
///
/// Also mirrors the new total onto the macOS Dock badge. This function and
/// [`reset_unread_dms`] are the ONLY two writers of `UnreadDmState`, so
/// updating the badge at both keeps it an exact function of that state — no
/// poller, no frontend round-trip, and no way for the two to drift.
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
    crate::commands::dock::set_badge(app, total);
}

/// Read the current unread-DM count from managed state (0 if unset).
pub fn current_unread_dms<R: Runtime>(app: &AppHandle<R>) -> u32 {
    app.try_state::<UnreadDmState>()
        .map(|s| *s.0.lock().unwrap_or_else(|p| p.into_inner()))
        .unwrap_or(0)
}

/// Reset the unread-DM count to 0. Called when the Messages window opens.
///
/// Clears the Dock badge too — the count and the badge share one owner (see
/// [`bump_unread`]). Unconditional rather than "only if it was non-zero": the
/// clear is idempotent, and always issuing it also repairs a badge that somehow
/// drifted out of step with the state.
pub fn reset_unread_dms<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<UnreadDmState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = 0;
    }
    let payload = serde_json::json!({ "unreadDms": 0u32, "pendingRequests": 0u32 });
    let _ = app.emit(EVENT_DM_UNREAD_SUMMARY, &payload);
    crate::commands::dock::set_badge(app, 0);
}

/// Merge a page of pair-unread rollups into managed state and emit
/// `dm:pair-unreads` so the chat sidebar can paint numeric DM badges.
/// No-op when the page is empty (legacy servers or no pairs on this page).
fn apply_pair_unreads_page(app: &AppHandle, page: &[PairUnread]) {
    if page.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<PairUnreadState>() else {
        return;
    };
    let snapshot = {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        for entry in page {
            let uid = entry.with_person_uid.trim();
            if uid.is_empty() {
                continue;
            }
            guard.insert(uid.to_string(), entry.unread_count);
        }
        pair_unreads_payload(&guard, page)
    };
    let _ = app.emit(EVENT_DM_PAIR_UNREADS, &snapshot);
}

/// Build the frontend payload: prefer page metadata (lastReadAt) when present,
/// fall back to bare `{ withPersonUid, unreadCount }` from the map.
fn pair_unreads_payload(
    map: &std::collections::HashMap<String, u32>,
    page: &[PairUnread],
) -> serde_json::Value {
    let by_uid: std::collections::HashMap<&str, &PairUnread> = page
        .iter()
        .map(|p| (p.with_person_uid.as_str(), p))
        .collect();
    let pair_unreads: Vec<serde_json::Value> = map
        .iter()
        .map(|(uid, count)| {
            let last_read = by_uid
                .get(uid.as_str())
                .and_then(|p| p.last_read_at.as_ref());
            let mut obj = serde_json::json!({
                "withPersonUid": uid,
                "unreadCount": count,
            });
            if let Some(at) = last_read {
                obj["lastReadAt"] = serde_json::Value::String(at.clone());
            }
            obj
        })
        .collect();
    serde_json::json!({ "pairUnreads": pair_unreads })
}

/// Zero one pair's local unread and re-emit so the sidebar clears the badge
/// immediately after mark-read (server is source of truth on next poll).
fn clear_pair_unread_local(app: &AppHandle, with_person_uid: &str) {
    let Some(state) = app.try_state::<PairUnreadState>() else {
        return;
    };
    let snapshot = {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.insert(with_person_uid.to_string(), 0);
        let pair_unreads: Vec<serde_json::Value> = guard
            .iter()
            .map(|(uid, count)| {
                serde_json::json!({
                    "withPersonUid": uid,
                    "unreadCount": count,
                })
            })
            .collect();
        serde_json::json!({ "pairUnreads": pair_unreads })
    };
    let _ = app.emit(EVENT_DM_PAIR_UNREADS, &snapshot);
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
    let auth = match resolve_notification_auth_snapshot(&app).await {
        Ok(auth) => auth,
        Err(error) => {
            log(LOG_TAG, &format!("DM_NOTIFY_POLL_AUTH_FAIL {error}"));
            // Credential resolution already performs a generation-conditional
            // clear. An unconditional clear here could erase a newer account
            // that signed in while an older resolver was failing.
            clear_in_flight();
            return;
        }
    };
    do_poll(&app, &auth).await;
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
    let payload = build_send_payload(&to_person_uid, body_text);
    post_dm_payload(&payload, "DM_NOTIFY_SEND").await
}

/// POST one already-built DM payload to `/v1/notify/dm`.
///
/// The auth + URL plumbing behind `send_dm`, factored out so other senders
/// that need the richer wire shape (`details` / `prompt` — the Sessions
/// composer's `@`-mention fan-out in `session_mentions.rs`) take the SAME path
/// instead of growing a second copy of it. `code` prefixes the log lines so a
/// failure is attributable to its caller in `~/.hq/logs/hq-sync.log`.
pub(crate) async fn post_dm_payload(payload: &serde_json::Value, code: &str) -> Result<(), String> {
    let access_token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_FAIL auth: {e}"));
        format!("Not signed in: {e}")
    })?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/dm", base_url);

    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_FAIL network: {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if status.is_success() {
        log(LOG_TAG, &format!("{code}_OK"));
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
        &format!("{code}_FAIL status={status} msg={server_msg:?}"),
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
        // Name the peer. Without it a recurring 404 tells you a thread read
        // failed but not which one, so you cannot tell one unreachable
        // account from a broken route without adding the field first.
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_FAIL with={target} status={status} msg={server_msg:?}"),
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

/// Tauri command: mark a 1:1 DM thread read (hq-pro US-010 / desktop US-011).
///
/// `POST /v1/notify/thread/read` with `{ withPersonUid }`. Mirrors
/// `mark_channel_read` for the channel path — called from the chat sidebar when
/// a DM row is opened. Local pair-unread is zeroed and `dm:pair-unreads` is
/// re-emitted so the numeric badge clears immediately. Network/auth failures
/// are logged and returned; the UI treats them as non-fatal (optimistic clear
/// already happened).
#[tauri::command]
pub async fn mark_dm_thread_read(app: AppHandle, with_person_uid: String) -> Result<(), String> {
    let auth = resolve_notification_auth_snapshot(&app)
        .await
        .map_err(|error| format!("Not signed in: {error}"))?;
    let uid = with_person_uid.trim();
    if uid.is_empty() {
        return Err("withPersonUid must not be empty".to_string());
    }
    let base = resolve_vault_api_url()
        .map(|url| url.trim_end_matches('/').to_string())
        .map_err(|error| {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_READ_ERROR vault url: {error}"),
            );
            format!("Could not resolve server URL: {error}")
        })?;
    let url = format!("{base}/v1/notify/thread/read");
    let payload = serde_json::json!({ "withPersonUid": uid });

    // Account-owned write: same mutation lease as channel read / request respond
    // so a mid-flight account switch cannot publish against a stale bearer.
    let sent = with_current_notification_mutation(&app, &auth, || async {
        build_client()
            .post(&url)
            .header("authorization", format!("Bearer {}", auth.access_token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                log(LOG_TAG, &format!("DM_NOTIFY_THREAD_READ_NETWORK_FAIL {e}"));
                format!("Network error: {e}")
            })
    })
    .await;

    let resp = match sent {
        None => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_READ_STALE uid={uid} auth session changed before send"),
            );
            return Ok(());
        }
        Some(Err(error)) => {
            // Non-fatal to the UI: log and surface, caller swallows.
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_THREAD_READ_ERROR uid={uid} err={error}"),
            );
            return Err(error);
        }
        Some(Ok(resp)) => resp,
    };

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_READ_ERROR uid={uid} status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    let committed = with_current_notification_auth_snapshot(&app, &auth, || {
        clear_pair_unread_local(&app, uid);
    })
    .await;
    if committed.is_none() {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_THREAD_READ_STALE uid={uid} auth session changed"),
        );
        return Ok(());
    }
    log(LOG_TAG, &format!("DM_NOTIFY_THREAD_READ_OK uid={uid}"));
    Ok(())
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
    let auth = current_notification_auth_snapshot(&app)
        .await
        .ok_or_else(|| "Not signed in".to_string())?;
    let key = pair_key.trim();
    if key.is_empty() {
        return Err("pairKey must not be empty".to_string());
    }
    let path =
        respond_action_path(&action).ok_or_else(|| format!("Unsupported action: {action}"))?;

    let base_url = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("DM_NOTIFY_RESPOND_FAIL vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;

    let url = format!("{}/v1/notify/connections/{}", base_url, path);
    let payload = serde_json::json!({ "pairKey": key });

    // The request action is account-owned. Dispatch it through the same
    // response-bounded mutation lease as inbox ACKs so an account switch
    // between opening the Requests pane and clicking Accept/Decline cannot
    // publish a new account while the prior account can still mutate remotely.
    let sent = with_current_notification_mutation(&app, &auth, || async {
        build_client()
            .post(&url)
            .header("authorization", format!("Bearer {}", auth.access_token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                log(LOG_TAG, &format!("DM_NOTIFY_RESPOND_FAIL network: {e}"));
                format!("Network error: {e}")
            })
    })
    .await;
    let resp = match sent {
        None => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_RESPOND_STALE action={path} before remote dispatch"),
            );
            return Ok(());
        }
        Some(Err(error)) => return Err(error),
        Some(Ok(resp)) => resp,
    };

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

    let new_state = respond_action_state(&action);
    let committed = with_current_notification_auth_snapshot(&app, &auth, || {
        // The request has left the pending set. Advance the local revision
        // before mutating so an older list GET cannot restore the pair.
        if let Some(state) = app.try_state::<SeenRequestState>() {
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            guard.invalidate_snapshots();
            guard.pair_keys.remove(key);
        }
        let update = serde_json::json!({ "pairKey": key, "state": new_state });
        let _ = app.emit(EVENT_DM_REQUEST_UPDATE, &update);
    })
    .await;

    if committed.is_none() {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_RESPOND_STALE action={path} state={new_state}"),
        );
        return Ok(());
    }

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
async fn poll_requests(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
    let Some(state) = app.try_state::<SeenRequestState>() else {
        return;
    };
    let snapshot_revision = state
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .begin_snapshot();

    let url = format!("{}/v1/notify/connections/requests", base_url);
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", auth.access_token))
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

    let committed = with_current_notification_auth_snapshot(app, auth, || {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.snapshot_is_current(snapshot_revision) {
            return false;
        }
        let first_run = !guard.initialized;
        let (new_requests, removed) = diff_requests(&guard.pair_keys, &list.requests);
        // Reconcile the seen-set to exactly the current pending pairKeys.
        guard.pair_keys = list.requests.iter().map(|r| r.pair_key.clone()).collect();
        guard.initialized = true;
        drop(guard);

        if first_run {
            // Seed silently — the user already had these before launch.
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_REQ_POLL_SEED count={}", list.requests.len()),
            );
            return true;
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
            // The request left the pending set. We can't tell accept vs decline
            // from its disappearance alone, so report a neutral "resolved" flip.
            let update = serde_json::json!({ "pairKey": pair_key, "state": "resolved" });
            log(LOG_TAG, &format!("DM_NOTIFY_REQ_RESOLVED pair={pair_key}"));
            let _ = app.emit(EVENT_DM_REQUEST_UPDATE, &update);
        }
        true
    })
    .await
    .unwrap_or(false);

    if !committed {
        log(
            LOG_TAG,
            "DM_NOTIFY_REQ_POLL_STALE auth generation or local request revision changed",
        );
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
// DMs/channels. `do_poll` re-fetches every thread registered by a mounted
// renderer (tracked in `ActiveThreadState`, set by the frontend when a ThreadPanel
// opens / cleared when it closes) and emits `thread:new-reply` for replies it
// hasn't seen yet. There is NO parallel thread poller.

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

/// Managed state: the share events currently visible in a share surface
/// (ShareDetail window, popover/desktop notification feed, or the Messages
/// share timeline), so the SINGLE poll path can re-fetch their reactions on a
/// "reaction" wake (share reactions, hq-pro contract: messageScope
/// `share:{eventId}`, messageId = eventId). Kept SEPARATE from
/// `ActiveConversationState` on purpose: shares are many one-message scopes,
/// and registering them must not clobber the open DM/channel conversation
/// (nor vice versa).
#[derive(Default)]
pub struct WatchedSharesInner {
    /// The share eventIds currently rendered by a share surface.
    pub event_ids: Vec<String>,
    /// eventId → last-emitted aggregate snapshot (serialized) so the poll only
    /// emits genuinely-changed reaction sets.
    pub last_seen: HashMap<String, String>,
}

pub struct WatchedSharesState(pub Mutex<WatchedSharesInner>);

impl WatchedSharesState {
    pub fn new() -> Self {
        WatchedSharesState(Mutex::new(WatchedSharesInner::default()))
    }
}

/// Tauri command: register the share events currently visible in a share
/// surface (replace semantics — the newest caller wins, mirroring how only one
/// share surface is focused at a time). An empty list clears the watch. The
/// `last_seen` snapshots of ids that stay watched survive the replace so a
/// re-registration doesn't re-emit unchanged aggregate sets.
#[tauri::command]
pub fn set_watched_shares(app: AppHandle, event_ids: Vec<String>) -> Result<(), String> {
    let Some(state) = app.try_state::<WatchedSharesState>() else {
        return Ok(());
    };
    let ids: Vec<String> = event_ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    guard.last_seen.retain(|k, _| ids.contains(k));
    log(
        LOG_TAG,
        &format!("DM_NOTIFY_WATCHED_SHARES_SET count={}", ids.len()),
    );
    guard.event_ids = ids;
    Ok(())
}

/// Build the `share:{eventId}` messageScope for one share event. The share's
/// eventId is BOTH the scope id and the messageId (hq-pro contract).
pub(crate) fn share_scope(event_id: &str) -> String {
    format!("share:{}", event_id.trim())
}

/// Decode the reactions endpoint for the realtime poll path.
///
/// Kept as a small pure seam so the server response contract is regression-
/// tested independently of Tauri state and the network client.
fn parse_reaction_poll_payload(
    body: &[u8],
) -> serde_json::Result<Vec<crate::commands::messages::ReactionAggregate>> {
    let envelope: crate::commands::messages::MessageReactions = serde_json::from_slice(body)?;
    Ok(envelope.reactions)
}

/// Re-fetch reactions for every watched share and emit `message:reaction` for
/// any share whose aggregate set changed since the last poll. Folded into the
/// SINGLE `do_poll` path right beside `poll_reactions` (NOT a parallel poller).
/// Best-effort; no-op when no share surface is registered.
async fn poll_share_reactions(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
    let event_ids = {
        let Some(state) = app.try_state::<WatchedSharesState>() else {
            return;
        };
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if guard.event_ids.is_empty() {
            return;
        }
        guard.event_ids.clone()
    };

    for event_id in &event_ids {
        let scope = share_scope(event_id);
        let url = format!(
            "{}/v1/notify/reactions?messageScope={}&messageId={}",
            base_url,
            esc_thread_seg(&scope),
            esc_thread_seg(event_id),
        );
        let resp = build_client()
            .get(&url)
            .header("authorization", format!("Bearer {}", auth.access_token))
            .send()
            .await;

        let reactions = match resp {
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_SHARE_REACTION_POLL_NETWORK_FAIL {e}"),
                );
                continue;
            }
            Ok(r) => {
                let status = r.status();
                if !status.is_success() {
                    log(
                        LOG_TAG,
                        &format!("DM_NOTIFY_SHARE_REACTION_POLL_ERROR status={status}"),
                    );
                    continue;
                }
                let body = match r.bytes().await {
                    Ok(body) => body,
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("DM_NOTIFY_SHARE_REACTION_POLL_ERROR body: {e}"),
                        );
                        continue;
                    }
                };
                match parse_reaction_poll_payload(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("DM_NOTIFY_SHARE_REACTION_POLL_ERROR parse: {e}"),
                        );
                        continue;
                    }
                }
            }
        };

        // Compare, mutate, and emit inside the same auth-snapshot guard. This
        // prevents an account switch from landing after local reconciliation
        // but before event publication.
        let snapshot = serde_json::to_string(&reactions).unwrap_or_default();
        let committed = with_current_notification_auth_snapshot(app, auth, || {
            let Some(state) = app.try_state::<WatchedSharesState>() else {
                return false;
            };
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if !guard.event_ids.contains(event_id)
                || guard.last_seen.get(event_id) == Some(&snapshot)
            {
                return false;
            }
            guard.last_seen.insert(event_id.clone(), snapshot);
            let payload = crate::commands::messages::MessageReactions {
                message_scope: scope.clone(),
                message_id: event_id.to_string(),
                reactions,
            };
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_SHARE_REACTION_CHANGED scope={scope}"),
            );
            let _ = app.emit(EVENT_MESSAGE_REACTION, &payload);
            true
        })
        .await;
        if committed.is_none() {
            log(
                LOG_TAG,
                "DM_NOTIFY_SHARE_REACTION_POLL_STALE auth snapshot changed",
            );
            return;
        }
    }
}

/// Re-fetch reactions for the open conversation and emit `message:reaction` for
/// any message whose aggregate set changed since the last poll (US-025). Folded
/// into the SINGLE `do_poll` path (NOT a parallel poller). Best-effort: any
/// failure logs and returns without disturbing the rest of the poll. No-op when
/// no conversation is open.
async fn poll_reactions(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
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
            .header("authorization", format!("Bearer {}", auth.access_token))
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
                let body = match r.bytes().await {
                    Ok(body) => body,
                    Err(e) => {
                        log(LOG_TAG, &format!("DM_NOTIFY_REACTION_POLL_ERROR body: {e}"));
                        continue;
                    }
                };
                match parse_reaction_poll_payload(&body) {
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

        // Compare, mutate, and emit under the same auth-snapshot guard.
        let snapshot = serde_json::to_string(&reactions).unwrap_or_default();
        let committed = with_current_notification_auth_snapshot(app, auth, || {
            let Some(state) = app.try_state::<ActiveConversationState>() else {
                return false;
            };
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if guard.scope.as_deref() != Some(scope.as_str())
                || guard.last_seen.get(message_id) == Some(&snapshot)
            {
                return false;
            }
            guard.last_seen.insert(message_id.clone(), snapshot);
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
            true
        })
        .await;
        if committed.is_none() {
            log(
                LOG_TAG,
                "DM_NOTIFY_REACTION_POLL_STALE auth snapshot changed",
            );
            return;
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

/// Tauri command: register (or clear) the invoking renderer's open reply
/// thread (US-022). A Messages window and the embedded desktop window may both
/// be mounted, so registrations are keyed by the Tauri window label. Clearing
/// one renderer never wipes another renderer's active thread.
#[tauri::command]
pub fn set_active_thread(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root_event_id: Option<String>,
    scope: Option<String>,
    channel_id: Option<String>,
    with_person_uid: Option<String>,
    seen_reply_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ActiveThreadState>() else {
        return Ok(());
    };
    let owner = window.label().to_string();
    let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    match root_event_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(root) => {
            guard.insert(
                owner.clone(),
                ActiveThreadInner {
                    root_event_id: Some(root.to_string()),
                    scope: normalize_scope(scope.as_deref().unwrap_or("dm")),
                    channel_id: channel_id
                        .map(|c| c.trim().to_string())
                        .filter(|s| !s.is_empty()),
                    with_person_uid: with_person_uid
                        .map(|c| c.trim().to_string())
                        .filter(|s| !s.is_empty()),
                    seen_reply_ids: seen_reply_ids.unwrap_or_default().into_iter().collect(),
                },
            );
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_ACTIVE_THREAD_SET owner={owner} root={root}"),
            );
        }
        None => {
            guard.remove(&owner);
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_ACTIVE_THREAD_CLEAR owner={owner}"),
            );
        }
    }
    Ok(())
}

/// Build the typed wire envelope used by the embedded Work bridge. This keeps
/// enough routing context for a mounted panel to reconcile its own thread
/// without treating a native payload as authoritative message state.
fn thread_reply_wake_payload(
    root_event_id: &str,
    scope: &str,
    channel_id: Option<&str>,
    with_person_uid: Option<&str>,
    reply: &ThreadReply,
    reply_count: u32,
) -> serde_json::Value {
    serde_json::json!({
        "rootEventId": root_event_id,
        "eventId": reply.event_id,
        "scope": normalize_scope(scope),
        "channelId": channel_id,
        "withPersonUid": with_person_uid,
        "reply": reply,
        "replyCount": reply_count,
    })
}

/// Poll every registered active thread and emit `thread:new-reply` for replies
/// the owning panel has not seen yet. Folded into the SINGLE `do_poll` path
/// (NOT a parallel poller). Best-effort: any failure logs and continues so one
/// unavailable thread cannot suppress another mounted window's reconciliation.
async fn poll_active_thread(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
    // Snapshot all active descriptors without holding the lock across network
    // requests. The owner label makes late closes/switches reject their stale
    // response during the guarded reconciliation below.
    let descriptors = {
        let Some(state) = app.try_state::<ActiveThreadState>() else {
            return;
        };
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .iter()
            .filter_map(|(owner, descriptor)| {
                descriptor.root_event_id.as_ref().map(|root| {
                    (
                        owner.clone(),
                        root.clone(),
                        descriptor.scope.clone(),
                        descriptor.channel_id.clone(),
                        descriptor.with_person_uid.clone(),
                    )
                })
            })
            .collect::<Vec<_>>()
    };
    for (owner, root, scope, channel_id, with_person_uid) in descriptors {
        let url = build_threads_url(
            base_url,
            &root,
            &normalize_scope(&scope),
            channel_id.as_deref(),
            with_person_uid.as_deref(),
        );
        let resp = build_client()
            .get(&url)
            .header("authorization", format!("Bearer {}", auth.access_token))
            .send()
            .await;

        let view = match resp {
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_THREAD_POLL_NETWORK_FAIL owner={owner} {e}"),
                );
                continue;
            }
            Ok(r) => {
                let status = r.status();
                if !status.is_success() {
                    log(
                        LOG_TAG,
                        &format!("DM_NOTIFY_THREAD_POLL_ERROR owner={owner} status={status}"),
                    );
                    continue;
                }
                match r.json::<ThreadView>().await {
                    Ok(v) => v,
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("DM_NOTIFY_THREAD_POLL_ERROR owner={owner} parse: {e}"),
                        );
                        continue;
                    }
                }
            }
        };

        // Reconcile and emit under the same auth-snapshot guard, so stale
        // account work cannot mutate a retained thread or leak an event to a
        // new account. The full descriptor check rejects a response when that
        // same window switched threads while the request was in flight.
        let committed = with_current_notification_auth_snapshot(app, auth, || {
            let Some(state) = app.try_state::<ActiveThreadState>() else {
                return false;
            };
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            let Some(active) = guard.get_mut(&owner) else {
                return false;
            };
            if active.root_event_id.as_deref() != Some(root.as_str())
                || active.scope != scope
                || active.channel_id != channel_id
                || active.with_person_uid != with_person_uid
            {
                return false;
            }
            let fresh: Vec<ThreadReply> = view
                .replies
                .iter()
                .filter(|r| !active.seen_reply_ids.contains(&r.event_id))
                .cloned()
                .collect();
            for reply in &view.replies {
                active.seen_reply_ids.insert(reply.event_id.clone());
            }
            drop(guard);

            // Emit oldest→newest so the panel appends in chronological order.
            // The server returns newest-first, so reverse.
            for reply in fresh.iter().rev() {
                let payload = thread_reply_wake_payload(
                    &root,
                    &scope,
                    channel_id.as_deref(),
                    with_person_uid.as_deref(),
                    reply,
                    effective_reply_count(&view),
                );
                log(
                    LOG_TAG,
                    &format!(
                        "DM_NOTIFY_THREAD_NEW_REPLY owner={owner} root={root} reply={}",
                        reply.event_id
                    ),
                );
                let _ = app.emit(EVENT_THREAD_NEW_REPLY, &payload);
            }
            true
        })
        .await;
        if committed.is_none() {
            log(LOG_TAG, "DM_NOTIFY_THREAD_POLL_STALE auth snapshot changed");
            return;
        }
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
    /// Exact count changes, including decreases and channels removed from the
    /// caller's visible set (represented as zero).
    unread_changes: Vec<(String, u32)>,
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
        if seen_unread.get(&ch.channel_id).copied() != Some(unread) {
            diff.unread_changes.push((ch.channel_id.clone(), unread));
        }
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
    for channel_id in seen_unread.keys() {
        if !current
            .iter()
            .any(|channel| &channel.channel_id == channel_id)
        {
            diff.unread_changes.push((channel_id.clone(), 0));
        }
    }
    diff
}

/// One channel whose unread grew this poll: id and name.
#[derive(Clone, Debug)]
struct ChannelUnreadGrowth {
    channel_id: String,
    name: String,
}

enum ChannelPollCommit {
    Stale,
    Seeded,
    Growth {
        growth: Vec<ChannelUnreadGrowth>,
        /// (channelId, name) of channels the caller was just added to.
        added: Vec<(String, String)>,
    },
}

/// Poll the channels list and emit channel events off the diff. Folded into the
/// SINGLE `do_poll` path (NOT a parallel poller). Best-effort: any failure logs
/// and returns without disturbing the DM-inbox poll. The first poll seeds the
/// unread map silently (no events for the pre-launch backlog). When unread
/// grows (`DM_NOTIFY_CHAN_NEW_MESSAGE`), fetch that channel's history and
/// detect structured @mentions of the signed-in person.
async fn poll_channels(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
    let Some(state) = app.try_state::<SeenChannelState>() else {
        return;
    };
    let snapshot_revision = state
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .begin_snapshot();

    let url = format!("{}/v1/notify/channels", base_url);
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", auth.access_token))
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

    // Refresh the per-channel levels the notification rule reads.
    {
        let mut levels = channel_notify_levels()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *levels = list
            .channels
            .iter()
            .filter_map(|c| {
                c.notify_level
                    .as_ref()
                    .map(|level| (c.channel_id.clone(), level.clone()))
            })
            .collect();
    }
    let self_person_uid = resolve_signed_in_person_uid(base_url, auth)
        .await
        .unwrap_or_default();

    let committed = with_current_notification_auth_snapshot(app, auth, || {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.snapshot_is_current(snapshot_revision) {
            return ChannelPollCommit::Stale;
        }
        let first_run = !guard.initialized;
        let diff = diff_channels(&guard.unread_by_id, &list.channels);
        // Reconcile the unread map to exactly the current channels.
        guard.unread_by_id = list
            .channels
            .iter()
            .map(|c| (c.channel_id.clone(), c.unread.unwrap_or(0)))
            .collect();
        guard.initialized = true;
        drop(guard);

        if first_run {
            if let Some(mentions) = app.try_state::<MentionWatchState>() {
                mentions
                    .0
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .initialized = true;
            }
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_CHAN_POLL_SEED count={}", list.channels.len()),
            );
            return ChannelPollCommit::Seeded;
        }

        // Emit `channel:updated` for brand-new channels/invites (full payload so
        // the rail can render the row without a separate fetch).
        let mut added = Vec::new();
        for channel_id in &diff.new_channels {
            if let Some(ch) = list.channels.iter().find(|c| &c.channel_id == channel_id) {
                log(LOG_TAG, &format!("DM_NOTIFY_CHAN_UPDATED id={channel_id}"));
                let _ = app.emit(EVENT_CHANNEL_UPDATED, ch);
                if hq_desktop_core::notify_prefs::is_notifiable_added_channel(
                    ch.membership.as_deref().unwrap_or("joined") == "joined",
                    ch.membership_source.as_deref(),
                    ch.created_by.as_deref(),
                    &[self_person_uid.as_str(), auth.identity.as_str()],
                ) {
                    added.push((ch.channel_id.clone(), ch.name.clone()));
                }
            }
        }
        // Publish every exact unread transition (increase, decrease, or removal)
        // before increase-only content refresh signals.
        for (channel_id, unread) in &diff.unread_changes {
            let payload = serde_json::json!({ "channelId": channel_id, "unread": unread });
            let _ = app.emit(EVENT_CHANNEL_UNREAD_CHANGED, &payload);
        }
        // Emit `channel:new-message` for channels whose unread grew.
        let mut growth = Vec::new();
        for (channel_id, unread) in &diff.new_messages {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_CHAN_NEW_MESSAGE id={channel_id} unread={unread}"),
            );
            let payload = serde_json::json!({ "channelId": channel_id, "unread": unread });
            let _ = app.emit(EVENT_CHANNEL_NEW_MESSAGE, &payload);
            let name = list
                .channels
                .iter()
                .find(|c| &c.channel_id == channel_id)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            growth.push(ChannelUnreadGrowth {
                channel_id: channel_id.clone(),
                name,
            });
        }
        ChannelPollCommit::Growth { growth, added }
    })
    .await;

    match committed {
        None | Some(ChannelPollCommit::Stale) => {
            log(
                LOG_TAG,
                "DM_NOTIFY_CHAN_POLL_STALE auth generation or local unread revision changed",
            );
        }
        Some(ChannelPollCommit::Seeded) => {
            spawn_mention_detection_if_pending(app, base_url, auth, &[]);
        }
        Some(ChannelPollCommit::Growth { growth, added }) => {
            spawn_mention_detection_if_pending(app, base_url, auth, &growth);
            deliver_added_notifications(app, auth, added).await;
        }
    }
}

/// "Added to #name" OS notifications for channels that newly appeared in the
/// caller's list (explicit adds only; see `is_notifiable_added_channel`),
/// gated by the `addedToChannel` pref and a global pause. Clicking opens the
/// channel.
async fn deliver_added_notifications(
    app: &AppHandle,
    auth: &NotificationAuthSnapshot,
    added: Vec<(String, String)>,
) {
    if added.is_empty() {
        return;
    }
    let prefs = cached_notify_prefs(&auth.identity);
    if !hq_desktop_core::notify_prefs::added_allowed(prefs.as_ref(), chrono::Utc::now()) {
        log(
            LOG_TAG,
            &format!(
                "DM_NOTIFY_ADDED_SUPPRESSED {} channel(s) (pref off, paused, or prefs unavailable)",
                added.len()
            ),
        );
        return;
    }
    let ids: Vec<String> = added.iter().map(|(id, _)| id.clone()).collect();
    let deliveries: Vec<(String, String, Option<usize>)> =
        match hq_desktop_core::notify_prefs::plan_added_notifications(&ids) {
            hq_desktop_core::notify_prefs::AddedPlan::Each(indices) => indices
                .into_iter()
                .filter_map(|index| added.get(index).cloned())
                .map(|(id, name)| (id, name, None))
                .collect(),
            hq_desktop_core::notify_prefs::AddedPlan::Summary { count, channel_id } => {
                log(LOG_TAG, &format!("DM_NOTIFY_ADDED_SUMMARY count={count}"));
                vec![(channel_id, String::new(), Some(count))]
            }
        };
    for (channel_id, channel_name, summary_count) in deliveries {
        log(LOG_TAG, &format!("DM_NOTIFY_ADDED channel={channel_id}"));
        deliver_mention_notification(
            app,
            auth,
            MentionDelivery {
                channel_id,
                channel_name,
                event_id: String::new(),
                from_person_uid: String::new(),
                from_display_name: String::new(),
                body: String::new(),
                created_at: String::new(),
                summary_extra: summary_count,
                kind: ChannelDeliveryKind::Added,
            },
        )
        .await;
    }
}

fn spawn_mention_detection_if_pending(
    app: &AppHandle,
    base_url: &str,
    auth: &NotificationAuthSnapshot,
    growth: &[ChannelUnreadGrowth],
) {
    let incoming: Vec<(String, String)> = growth
        .iter()
        .map(|channel| (channel.channel_id.clone(), channel.name.clone()))
        .collect();
    let should_spawn = {
        let Some(watch) = app.try_state::<MentionWatchState>() else {
            return;
        };
        let mut guard = watch.0.lock().unwrap_or_else(|p| p.into_inner());
        enqueue_mention_fetches(&mut guard.pending_fetches, &incoming);
        should_spawn_mention_detect(guard.pending_fetches.len(), guard.detect_in_flight)
    };
    if should_spawn {
        spawn_mention_detection(app.clone(), base_url.to_string(), auth.clone());
    }
}

fn spawn_mention_detection(app: AppHandle, base_url: String, auth: NotificationAuthSnapshot) {
    tauri::async_runtime::spawn(async move {
        detect_and_deliver_mentions(&app, &base_url, &auth).await;
    });
}

fn person_uid_from_config() -> Option<String> {
    nonempty_person_uid(
        hq_desktop_core::config::read_hq_config_lenient()
            .ok()
            .flatten()
            .map(|config| config.person_uid),
    )
}

fn person_uid_from_entities(
    mut persons: Vec<crate::commands::vault_client::EntityInfo>,
) -> Option<String> {
    persons.retain(|person| !person.deleted && !person.uid.trim().is_empty());
    persons.sort_by(|a, b| match a.created_at.cmp(&b.created_at) {
        std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
        ord => ord,
    });
    persons.into_iter().next().map(|person| person.uid)
}

fn person_uid_from_memberships(
    memberships: &[crate::commands::vault_client::MembershipInfo],
) -> Option<String> {
    memberships.iter().find_map(|membership| {
        nonempty_person_uid(Some(membership.person_uid.clone())).or_else(|| {
            membership
                .membership_key
                .as_deref()
                .and_then(|key| key.split('#').next())
                .map(str::trim)
                .filter(|left| !left.is_empty())
                .map(str::to_string)
        })
    })
}

async fn fetch_person_uid_from_vault(base_url: &str, access_token: &str) -> Option<String> {
    let vault = crate::commands::vault_client::VaultClient::new(base_url, access_token);
    match vault.list_entities_by_type("person").await {
        Ok(persons) => {
            if let Some(uid) = person_uid_from_entities(persons) {
                return Some(uid);
            }
        }
        Err(crate::commands::vault_client::VaultClientError::Http { status, .. }) => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_PERSON_UID_FETCH_FAIL status={status}"),
            );
        }
        Err(crate::commands::vault_client::VaultClientError::Request(_)) => {
            log(LOG_TAG, "DM_NOTIFY_PERSON_UID_FETCH_FAIL network");
        }
        Err(_) => log(LOG_TAG, "DM_NOTIFY_PERSON_UID_FETCH_FAIL"),
    }
    match vault.list_my_memberships().await {
        Ok(memberships) => person_uid_from_memberships(&memberships),
        Err(_) => None,
    }
}

/// Config.json first; then the in-memory cache; then `GET /entity/by-type/person`
/// with the auth-snapshot token (same source as `whoami`), falling back to
/// `GET /membership/me`. Does not write `personUid` back to config.json.
async fn resolve_signed_in_person_uid(
    base_url: &str,
    auth: &NotificationAuthSnapshot,
) -> Option<String> {
    resolve_signed_in_person_uid_with(person_uid_from_config(), base_url, auth).await
}

async fn resolve_signed_in_person_uid_with(
    config_uid: Option<String>,
    base_url: &str,
    auth: &NotificationAuthSnapshot,
) -> Option<String> {
    if let Some(uid) = nonempty_person_uid(config_uid) {
        return Some(uid);
    }
    if let Some(uid) = cached_person_uid(&auth.identity) {
        return Some(uid);
    }
    if person_uid_fetched_for(&auth.identity) {
        return None;
    }
    let fetched = fetch_person_uid_from_vault(base_url, &auth.access_token).await;
    store_person_uid_cache(&auth.identity, fetched.clone());
    nonempty_person_uid(fetched)
}

fn desktop_alt_focused(app: &AppHandle) -> bool {
    app.get_webview_window(crate::commands::desktop_alt::WINDOW_LABEL)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

async fn fetch_channel_history(
    base_url: &str,
    token: &str,
    channel_id: &str,
) -> Option<crate::commands::messages::ChannelDetail> {
    let url = hq_desktop_core::messages::build_channel_messages_url(base_url, channel_id, Some(50));
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await;
    match resp {
        Err(e) => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_MENTION_FETCH_FAIL id={channel_id} err={e}"),
            );
            None
        }
        Ok(r) => {
            let status = r.status();
            if !status.is_success() {
                log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_MENTION_FETCH_ERROR id={channel_id} status={status}"),
                );
                return None;
            }
            match r.json::<crate::commands::messages::ChannelDetail>().await {
                Ok(detail) => Some(detail),
                Err(e) => {
                    log(
                        LOG_TAG,
                        &format!("DM_NOTIFY_MENTION_FETCH_PARSE id={channel_id} err={e}"),
                    );
                    None
                }
            }
        }
    }
}

/// Which channel notification a [`MentionDelivery`] renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChannelDeliveryKind {
    /// "{author} mentioned you in #channel".
    Mention,
    /// "{author} in #channel" (file or other activity the prefs allow).
    Activity,
    /// "Added to #channel".
    Added,
}

#[derive(Clone)]
struct MentionDelivery {
    channel_id: String,
    channel_name: String,
    event_id: String,
    from_person_uid: String,
    from_display_name: String,
    body: String,
    created_at: String,
    summary_extra: Option<usize>,
    kind: ChannelDeliveryKind,
}

const MENTION_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

async fn fetch_channel_history_timed(
    base_url: &str,
    token: &str,
    channel_id: &str,
) -> Option<crate::commands::messages::ChannelDetail> {
    match tokio::time::timeout(
        MENTION_FETCH_TIMEOUT,
        fetch_channel_history(base_url, token, channel_id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_MENTION_FETCH_TIMEOUT id={channel_id}"),
            );
            None
        }
    }
}

fn read_active_scope(app: &AppHandle) -> Option<String> {
    app.try_state::<ActiveConversationState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .scope
                .clone()
        })
}

async fn detect_and_deliver_mentions(
    app: &AppHandle,
    base_url: &str,
    auth: &NotificationAuthSnapshot,
) {
    let person_uid = resolve_signed_in_person_uid(base_url, auth)
        .await
        .unwrap_or_default();
    if person_uid.is_empty() {
        log_missing_person_uid_once();
    }
    let cognito_sub = auth.identity.clone();
    let machine_id = crate::commands::config::ensure_machine_id().unwrap_or_default();
    let dm_notified = read_cursor_entry_for_account(&machine_id, &auth.identity).notified;
    let now = chrono::Utc::now();
    let notify_prefs = cached_notify_prefs(&auth.identity);

    let mut to_deliver = Vec::new();
    let mut retried: HashSet<String> = HashSet::new();
    let mut failed_last: Vec<(String, String)> = Vec::new();
    let mut owns_detect = false;

    loop {
        let batch = {
            let Some(watch) = app.try_state::<MentionWatchState>() else {
                if owns_detect {
                    clear_mention_detect_in_flight(app);
                }
                return;
            };
            let mut guard = watch.0.lock().unwrap_or_else(|p| p.into_inner());
            requeue_failed_mention_fetches(&mut guard.pending_fetches, &failed_last, &mut retried);
            failed_last.clear();
            if guard.detect_in_flight && !owns_detect {
                return;
            }
            if guard.pending_fetches.is_empty() {
                if owns_detect {
                    guard.detect_in_flight = false;
                }
                break;
            }
            guard.detect_in_flight = true;
            owns_detect = true;
            take_mention_fetch_batch(&mut guard.pending_fetches, MENTION_FETCH_PER_CYCLE)
        };
        if batch.is_empty() {
            break;
        }

        for (channel_id, channel_name) in &batch {
            let fetched =
                fetch_channel_history_timed(base_url, &auth.access_token, channel_id).await;
            if with_current_notification_auth_snapshot(app, auth, || ())
                .await
                .is_none()
            {
                log(LOG_TAG, "DM_NOTIFY_MENTION_STALE auth snapshot changed");
                clear_mention_detect_in_flight(app);
                return;
            }
            let Some(watch) = app.try_state::<MentionWatchState>() else {
                continue;
            };
            let mut guard = watch.0.lock().unwrap_or_else(|p| p.into_inner());
            let last_seen = guard.last_event_by_channel.get(channel_id).cloned();
            let watch_started_at = guard.watch_started_at;
            let messages = fetched.as_ref().map(|detail| detail.messages.as_slice());
            let (cursor, newer) = mention_cursor_after_fetch(
                last_seen.as_deref(),
                fetched.is_some(),
                messages.unwrap_or(&[]),
                now,
                watch_started_at,
            );
            if fetched.is_none() {
                failed_last.push((channel_id.clone(), channel_name.clone()));
                continue;
            }
            if let Some(event_id) = cursor {
                guard
                    .last_event_by_channel
                    .insert(channel_id.clone(), event_id);
            }
            guard.initialized = true;
            let newer = filter_mentions_by_age(newer, now, MENTION_FRESH_MAX_AGE);
            // Decide each fresh message: the wake's `notify` hint when one
            // arrived, else the prefs + channel level rule, else (prefs route
            // unavailable) the legacy mentions-only rule.
            let level = channel_notify_level(channel_id);
            let mut kinds: HashMap<String, ChannelDeliveryKind> = HashMap::new();
            for message in &newer {
                if hq_desktop_core::dm_notify::is_self_authored(
                    &message.from_person_uid,
                    &person_uid,
                    &cognito_sub,
                ) {
                    continue;
                }
                let mentioned = is_mention_of_me(message, &person_uid, &cognito_sub);
                // System rows (joins, renames) are not activity; they only
                // notify as mentions.
                let is_system = message.message_kind.as_deref() == Some("system");
                if is_system && !mentioned {
                    continue;
                }
                let (notify, source) = hq_desktop_core::notify_prefs::decide_channel_notify(
                    wake_notify_hint(&message.event_id),
                    notify_prefs.as_ref(),
                    level,
                    mentioned,
                    message.attachment.is_some(),
                    now,
                );
                if !notify {
                    if mentioned
                        || source != hq_desktop_core::notify_prefs::ChannelNotifySource::Legacy
                    {
                        log(
                            LOG_TAG,
                            &format!(
                                "DM_NOTIFY_CHAN_PREFS_SUPPRESSED channel={} event={} source={source:?}",
                                channel_id, message.event_id
                            ),
                        );
                    }
                    continue;
                }
                kinds.insert(
                    message.event_id.clone(),
                    if mentioned {
                        ChannelDeliveryKind::Mention
                    } else {
                        ChannelDeliveryKind::Activity
                    },
                );
            }
            let mention_ids: Vec<String> = newer
                .iter()
                .filter(|message| kinds.contains_key(&message.event_id))
                .map(|message| message.event_id.clone())
                .collect();
            let (fresh_ids, updated_seen) =
                take_unseen_message_ids(&mention_ids, &guard.seen_message_ids);
            guard.seen_message_ids = updated_seen;
            drop(guard);

            let active_scope = read_active_scope(app);
            let focused = desktop_alt_focused(app);

            for message in newer {
                if !fresh_ids.iter().any(|id| id == &message.event_id) {
                    continue;
                }
                log(
                    LOG_TAG,
                    &format!(
                        "DM_NOTIFY_MENTION_DETECTED channel={} event={}",
                        channel_id, message.event_id
                    ),
                );
                if should_suppress_duplicate_event(&message.event_id, &dm_notified) {
                    log(
                        LOG_TAG,
                        &format!(
                            "DM_NOTIFY_MENTION_SUPPRESSED_DUP event={}",
                            message.event_id
                        ),
                    );
                    continue;
                }
                if should_suppress_mention_for_open_channel(
                    active_scope.as_deref(),
                    channel_id,
                    focused,
                ) {
                    log(
                        LOG_TAG,
                        &format!("DM_NOTIFY_MENTION_SUPPRESSED_OPEN channel={channel_id}"),
                    );
                    continue;
                }
                to_deliver.push(MentionDelivery {
                    channel_id: channel_id.clone(),
                    channel_name: channel_name.clone(),
                    event_id: message.event_id.clone(),
                    from_person_uid: message.from_person_uid.clone(),
                    from_display_name: message.from_display_name.clone(),
                    body: message.body.clone(),
                    created_at: message.created_at.clone(),
                    summary_extra: None,
                    kind: kinds
                        .get(&message.event_id)
                        .copied()
                        .unwrap_or(ChannelDeliveryKind::Mention),
                });
            }
        }
    }

    let cap_items: Vec<MentionCapItem> = to_deliver
        .iter()
        .map(|mention| MentionCapItem {
            created_at: mention.created_at.clone(),
            channel_id: mention.channel_id.clone(),
        })
        .collect();
    let plan = plan_mention_cap(&cap_items);
    let mut deliver = plan
        .deliver_indices
        .into_iter()
        .filter_map(|index| to_deliver.get(index).cloned())
        .collect::<Vec<_>>();
    if let Some(summary) = plan.summary {
        let name = to_deliver
            .iter()
            .find(|mention| mention.channel_id == summary.channel_id)
            .map(|mention| mention.channel_name.clone())
            .unwrap_or_default();
        deliver.push(MentionDelivery {
            channel_id: summary.channel_id,
            channel_name: name,
            event_id: String::new(),
            from_person_uid: String::new(),
            from_display_name: String::new(),
            body: String::new(),
            created_at: String::new(),
            summary_extra: Some(summary.extra_count),
            kind: if to_deliver
                .iter()
                .all(|item| item.kind == ChannelDeliveryKind::Mention)
            {
                ChannelDeliveryKind::Mention
            } else {
                ChannelDeliveryKind::Activity
            },
        });
    }

    for mention in deliver {
        deliver_mention_notification(app, auth, mention).await;
    }
}

fn clear_mention_detect_in_flight(app: &AppHandle) {
    if let Some(watch) = app.try_state::<MentionWatchState>() {
        watch
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .detect_in_flight = false;
    }
}

async fn deliver_mention_notification(
    app: &AppHandle,
    auth: &NotificationAuthSnapshot,
    mention: MentionDelivery,
) {
    let (title, body) = if let Some(extra) = mention.summary_extra {
        if mention.kind == ChannelDeliveryKind::Added {
            (
                hq_desktop_core::notify_prefs::added_summary_title(extra),
                String::new(),
            )
        } else if mention.kind == ChannelDeliveryKind::Mention {
            (mention_summary_title(extra), String::new())
        } else {
            (
                hq_desktop_core::notify_prefs::activity_summary_title(extra),
                String::new(),
            )
        }
    } else {
        match mention.kind {
            ChannelDeliveryKind::Mention => (
                mention_notification_title(&mention.from_display_name, &mention.channel_name),
                mention_notification_body(&mention.body),
            ),
            ChannelDeliveryKind::Activity => (
                hq_desktop_core::notify_prefs::channel_activity_title(
                    &mention.from_display_name,
                    &mention.channel_name,
                ),
                mention_notification_body(&mention.body),
            ),
            ChannelDeliveryKind::Added => (
                hq_desktop_core::notify_prefs::added_notification_title(&mention.channel_name),
                String::new(),
            ),
        }
    };
    let route = mention_route(&mention.channel_id, &mention.event_id);
    let payload = serde_json::json!({
        "channelId": mention.channel_id,
        "eventId": mention.event_id,
        "fromPersonUid": mention.from_person_uid,
        "fromDisplayName": mention.from_display_name,
    });
    log(
        LOG_TAG,
        &format!(
            "DM_NOTIFY_MENTION_DELIVER event={} channel={}",
            mention.event_id, mention.channel_id
        ),
    );

    if crate::commands::banner::custom_banner_enabled() {
        if let Some(Err(e)) = with_current_notification_auth_snapshot_async(app, auth, || {
            crate::commands::banner::show_mention_banner(app.clone(), title, body, payload)
        })
        .await
        {
            log(LOG_TAG, &format!("DM_NOTIFY_MENTION_BANNER_FAIL err={e}"));
        }
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let app_focused = crate::commands::notifications::app_is_focused(app);
        let native_allowed =
            hq_desktop_core::native_notify::should_native_notify("mention", app_focused);
        if !native_allowed {
            log(
                LOG_TAG,
                &format!(
                    "DM_NOTIFY_MENTION_NATIVE_SUPPRESSED event={} focused={app_focused}",
                    mention.event_id
                ),
            );
            return;
        }
        let from_person_uid = mention.from_person_uid.clone();
        let channel_id = mention.channel_id.clone();
        let event_id = mention.event_id.clone();
        let payload_json = crate::commands::un_notify::encode_action_payload(&payload);
        let dispatched = with_current_notification_mutation(app, auth, || async move {
            tokio::task::spawn_blocking(move || {
                crate::commands::un_notify::deliver_message(
                    &title,
                    &body,
                    "mention",
                    &crate::commands::un_notify::MessageUserInfo {
                        from_person_uid,
                        channel_id,
                        event_id,
                        issuer_uid: String::new(),
                        route,
                        payload_json,
                    },
                );
            })
            .await
        })
        .await;
        if dispatched.is_none() {
            log(
                LOG_TAG,
                "DM_NOTIFY_MENTION_TOAST_STALE auth session changed",
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (route, payload);
        let dispatched = with_current_notification_mutation(app, auth, || async {
            app.notification()
                .builder()
                .title(&title)
                .body(&body)
                .show()
        })
        .await;
        if dispatched.is_none() {
            log(
                LOG_TAG,
                "DM_NOTIFY_MENTION_TOAST_STALE auth session changed",
            );
        }
    }
}

// ── Core poll logic (mirrors share_notify::do_poll) ─────────────────────────────

async fn do_poll(app: &AppHandle, auth: &NotificationAuthSnapshot) {
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
    poll_requests(app, &base_url, auth).await;

    // Server-side notification prefs gate every OS notification below (DMs,
    // channel activity, "added to channel"). Cached for NOTIFY_PREFS_TTL.
    refresh_notify_prefs(&base_url, auth).await;

    // Fold channel-activity polling into the SAME single path (US-018) — a
    // "channel" wake on the person topic routes here. Best-effort; emits
    // `channel:new-message` / `channel:updated`. NOT a parallel poller.
    poll_channels(app, &base_url, auth).await;

    // Fold thread-activity polling into the SAME single path (US-022) — a
    // "thread" wake on the person topic routes here. Re-fetches every thread a
    // mounted ThreadPanel registered and emits `thread:new-reply` for replies it
    // hasn't surfaced yet. No-op when no panel is open. NOT a parallel poller.
    poll_active_thread(app, &base_url, auth).await;

    // Fold reaction-activity polling into the SAME single path (US-025) — a
    // "reaction" wake on the person topic routes here. Re-fetches reactions for
    // whichever conversation is open and emits `message:reaction` for messages
    // whose aggregate set changed. No-op when no conversation is open. NOT a
    // parallel poller.
    poll_reactions(app, &base_url, auth).await;

    // Share-reaction polling rides the same wake: a "reaction" wake for a
    // `share:` scope arrives on the person topic exactly like a `dm:` one, so
    // re-fetching the watched shares here keeps every visible share surface
    // live without a parallel poller.
    poll_share_reactions(app, &base_url, auth).await;

    let entry = read_cursor_entry_for_account(&machine_id, &auth.identity);
    let since = entry.cursor.clone();
    let url = match since.as_deref() {
        Some(s) => format!("{}/v1/notify/inbox?since={}&limit=50", base_url, s),
        None => format!("{}/v1/notify/inbox?limit=50", base_url),
    };

    log(LOG_TAG, &format!("DM_NOTIFY_POLL_START since={:?}", since));

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", auth.access_token))
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

    if with_current_notification_auth_snapshot(app, auth, || ())
        .await
        .is_none()
    {
        log(
            LOG_TAG,
            "DM_NOTIFY_POLL_STALE authenticated notification snapshot changed",
        );
        return;
    }

    // Apply additive pair-unread rollups even when there are no new events —
    // the sidebar needs badge counts without inventing a second poller.
    if with_current_notification_auth_snapshot(app, auth, || {
        apply_pair_unreads_page(app, &body.pair_unreads);
    })
    .await
    .is_none()
    {
        log(LOG_TAG, "DM_NOTIFY_POLL_STALE before pair-unreads apply");
        return;
    }

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
    write_cursor_entry_for_account(
        &machine_id,
        &auth.identity,
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
    // live. The count is reset when the Messages window opens. Keep the
    // account-owned state under the generation check, but do not retain that
    // lock while showing banners or ACKing the server.
    if with_current_notification_auth_snapshot(app, auth, || {
        bump_unread(app, fresh.len() as u32);
        // Windows parity: persist exactly the DMs whose notifications are
        // emitted so dismissed toasts remain visible in local history.
        crate::commands::notification_history::record_dm_events(&fresh);
    })
    .await
    .is_none()
    {
        log(LOG_TAG, "DM_NOTIFY_POLL_STALE before unread accounting");
        return;
    }

    // Agent membership announcements ("🤖 Izzy (an agent) just joined Indigo.")
    // go to EVERY member of the company, so a fleet run that stands up thirty
    // agents rings thirty banners on a teammate's Mac for something they never
    // asked for. Keep them out of every banner path; they are still ACKed,
    // still counted, and still emitted to the in-app feed, which bundles them.
    let mention_notified = app
        .try_state::<MentionWatchState>()
        .map(|state| {
            state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .seen_message_ids
                .clone()
        })
        .unwrap_or_default();
    let banner_worthy: Vec<DmEvent> = fresh
        .iter()
        .filter(|dm| {
            !hq_desktop_core::agent_join::is_agent_join_notice(
                &dm.from_person_uid,
                &dm.from_email,
                &dm.from_display_name,
                &dm.body,
                dm.details.as_deref(),
                dm.prompt.as_deref(),
            ) && !should_suppress_duplicate_event(&dm.event_id, &mention_notified)
        })
        .cloned()
        .collect();
    if banner_worthy.len() < fresh.len() {
        log(
            LOG_TAG,
            &format!(
                "DM_NOTIFY_AGENT_JOIN_SUPPRESSED {} of {} DM(s)",
                fresh.len() - banner_worthy.len(),
                fresh.len()
            ),
        );
    }

    // Fine-grained prefs: the DMs toggle and a global pause (DMs pass a pause
    // only with "Let DMs through while paused"). Suppressed DMs still count,
    // ACK and reach the in-app feed; only the OS notification is skipped.
    let notify_prefs = cached_notify_prefs(&auth.identity);
    let banner_worthy: Vec<DmEvent> =
        if hq_desktop_core::notify_prefs::dm_allowed(notify_prefs.as_ref(), chrono::Utc::now()) {
            banner_worthy
        } else {
            log(
                LOG_TAG,
                &format!(
                    "DM_NOTIFY_PREFS_SUPPRESSED {} DM(s) (dms off or paused)",
                    banner_worthy.len()
                ),
            );
            Vec::new()
        };

    // SPIKE: when the custom banner is enabled, route every DM through the
    // in-app banner (commands::banner) — event-driven, no blocking Cocoa run
    // loop — and skip the native firing path entirely.
    if crate::commands::banner::custom_banner_enabled() {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_CUSTOM_BANNER {} DM(s)", banner_worthy.len()),
        );
        for dm in &banner_worthy {
            match with_current_notification_auth_snapshot_async(app, auth, || {
                crate::commands::banner::show_dm_banner(app.clone(), dm.clone())
            })
            .await
            {
                Some(Err(e)) => log(LOG_TAG, &format!("DM_NOTIFY_BANNER_FAIL err={e}")),
                None => {
                    log(LOG_TAG, "DM_NOTIFY_BANNER_STALE auth session changed");
                    return;
                }
                Some(Ok(())) => {}
            }
        }
        let event_ids: Vec<String> = fresh.iter().map(|e| e.event_id.clone()).collect();
        // Await (don't detach) so the server-side unread decrement lands within
        // the poll's lifetime. Detaching risked the runtime dropping the task on
        // a quick app quit, leaving the web/other-device unread badge stuck even
        // though this Mac already showed + dismissed the DM. post_ack is
        // best-effort + uses a timed client, so awaiting can't hang the poll.
        post_ack(app, auth, event_ids).await;
        let _ = with_current_notification_auth_snapshot(app, auth, || {
            app.emit(EVENT_DM_NEW_EVENTS, &fresh)
        })
        .await;
        return;
    }

    #[cfg(target_os = "macos")]
    {
        // Native fallback (customBanner: false). Deliver through
        // `un_notify::deliver_message`, which fires a real macOS banner via
        // `UNUserNotificationCenter` when notification permission is granted and
        // falls back to `osascript display notification` otherwise.
        //
        // This replaces the old `mac_notification_sys` (NSUserNotification)
        // send, which produced NO banner on modern macOS: the process becomes a
        // UN "modern client" at launch (the UN delegate + permission probe both
        // touch UN), after which usernoted permanently denies every legacy
        // NSUserNotification deliver from this process. That silent denial was
        // the root cause of "native DM notifications don't appear".
        // Native-banner gate (Settings → Notifications). The master switch,
        // the per-event DM toggle, and the "only when unfocused" rule all live
        // in menubar.json and are read fresh here so a toggle takes effect on
        // the next DM without a restart. When suppressed we skip only the OS
        // banner — the DMs are still ACKed and emitted to the in-app
        // NotificationFeed panel below, so nothing is lost.
        let app_focused = crate::commands::notifications::app_is_focused(app);
        let native_allowed =
            hq_desktop_core::native_notify::should_native_notify("dm", app_focused);
        if !native_allowed {
            log(
                LOG_TAG,
                &format!(
                    "DM_NOTIFY_NATIVE_SUPPRESSED {} DM(s) (settings gate, focused={app_focused})",
                    fresh.len()
                ),
            );
        }
        for dm in banner_worthy.iter().filter(|_| native_allowed) {
            let title = dm.from_display_name.clone();
            let message = dm.body.clone();
            let from_person_uid = dm.from_person_uid.clone();
            let event_id = dm.event_id.clone();
            let payload_json = crate::commands::un_notify::encode_action_payload(dm);
            let title_for_log = title.clone();
            let dispatched = with_current_notification_mutation(app, auth, || async move {
                // UN delivery is async. Dropdown actions (Copy prompt / Open
                // details) are registered on the UN category and handled in
                // the delegate; we never block an account transition waiting
                // on a click.
                tokio::task::spawn_blocking(move || {
                    crate::commands::un_notify::deliver_message(
                        &title,
                        &message,
                        "dm",
                        &crate::commands::un_notify::MessageUserInfo {
                            from_person_uid,
                            channel_id: String::new(),
                            event_id,
                            issuer_uid: String::new(),
                            payload_json,
                            ..Default::default()
                        },
                    );
                })
                .await
            })
            .await;

            match dispatched {
                None => {
                    log(LOG_TAG, "DM_NOTIFY_TOAST_STALE auth session changed");
                    return;
                }
                Some(Ok(())) => log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_TOAST_SHOWN from={title_for_log}"),
                ),
                Some(Err(error)) => log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_SEND_WORKER_FAILED err={error}"),
                ),
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        for dm in &banner_worthy {
            let title = dm.from_display_name.clone();
            let message = dm.body.clone();
            let dispatched = with_current_notification_mutation(app, auth, || async {
                app.notification()
                    .builder()
                    .title(&title)
                    .body(&message)
                    .show()
            })
            .await;
            match dispatched {
                None => {
                    log(LOG_TAG, "DM_NOTIFY_TOAST_STALE auth session changed");
                    return;
                }
                Some(Ok(())) => log(LOG_TAG, &format!("DM_NOTIFY_TOAST_SHOWN from={title}")),
                Some(Err(error)) => log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAILED err={error}")),
            }
        }
    }

    // Ack only the fresh DMs — boundary dupes were acked on the poll where they
    // were first fresh, so each event is acked exactly once. Await (don't detach)
    // so the server-side unread decrement reliably lands within the poll's
    // lifetime; post_ack is best-effort + uses a timed client, so it can't hang.
    let event_ids: Vec<String> = fresh.iter().map(|e| e.event_id.clone()).collect();
    post_ack(app, auth, event_ids).await;

    let _ = with_current_notification_auth_snapshot(app, auth, || {
        app.emit(EVENT_DM_NEW_EVENTS, &fresh)
    })
    .await;
}

/// POST `/v1/notify/inbox/ack`. Best-effort: errors logged, never surfaced.
async fn post_ack(app: &AppHandle, auth: &NotificationAuthSnapshot, event_ids: Vec<String>) {
    let base_url = match resolve_vault_api_url() {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(e) => {
            log(LOG_TAG, &format!("DM_NOTIFY_ACK_ERROR vault url: {e}"));
            return;
        }
    };
    let url = format!("{}/v1/notify/inbox/ack", base_url);
    let body = serde_json::json!({ "eventIds": event_ids });

    let token = auth.access_token.clone();
    let sent = with_current_notification_mutation(app, auth, move || async move {
        build_client()
            .post(&url)
            .header("authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
    })
    .await;

    match sent {
        None => log(LOG_TAG, "DM_NOTIFY_ACK_STALE auth session changed"),
        Some(Ok(r)) if r.status().is_success() => {
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_ACK_OK {} DM(s)", event_ids.len()),
            );
        }
        Some(Ok(r)) => log(
            LOG_TAG,
            &format!("DM_NOTIFY_ACK_ERROR status={}", r.status()),
        ),
        Some(Err(e)) => log(LOG_TAG, &format!("DM_NOTIFY_ACK_ERROR {e}")),
    }
}

/// Open Inbox as a typed desktop destination (US-004 WindowRouter).
///
/// Legacy name kept for frontend IPC; no longer creates a top-level Inbox
/// webview. Specific DM threads still use [`open_dm_detail`] (detachable
/// short-lived detail surface).
#[tauri::command]
pub async fn open_inbox_window(app: AppHandle) -> Result<(), String> {
    log(LOG_TAG, "INBOX_WINDOW_OPEN → desktop destination inbox");
    crate::commands::desktop_alt::open_destination(
        app,
        crate::commands::desktop_alt::DesktopDestination::Inbox,
    )
    .await
}

/// Open a conversation, optionally scoped to a channel.
///
/// This explicit route intentionally coexists with [`open_inbox_window`]:
/// Inbox is the desktop's own destination, while compact messaging entry
/// points name a conversation. Both land in the embedded desktop —
/// `maybe_intercept_conversation_open` routes the validated channel token to
/// the desktop workspace and there is no second window to build.
#[tauri::command]
pub async fn open_communications_window(
    app: AppHandle,
    channel: Option<Channel>,
) -> Result<(), String> {
    log(LOG_TAG, "COMMUNICATIONS_WINDOW_OPEN");

    let channel_id = channel.as_ref().map(|c| c.channel_id.as_str());
    crate::commands::hq_work::maybe_intercept_conversation_open(&app, channel_id, None).await?;
    Ok(())
}

/// Tauri command: open the conversation with the sender of a single DM.
/// Notification clicks now front the main window via `open_desktop_alt_window`
/// (US-002); this command remains for other callers of the quick Inbox path.
#[tauri::command]
pub async fn open_dm_detail(app: AppHandle, event: DmEvent) -> Result<(), String> {
    let person = event.from_person_uid.as_str();
    crate::commands::hq_work::maybe_intercept_dm_open(&app, Some(person), None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_channel(id: &str, unread: u32) -> crate::commands::messages::Channel {
        crate::commands::messages::Channel {
            channel_id: id.to_string(),
            project_id: None,
            name: format!("#{id}"),
            scope: "company".to_string(),
            company_uid: Some("ent_co".to_string()),
            company_name: Some("Acme".to_string()),
            post_policy: None,
            visibility: None,
            membership: Some("joined".to_string()),
            unread: Some(unread),
            member_count: None,
            last_activity_at: None,
            last_message_at: None,
            created_at: None,
            members: None,
            notify_level: None,
            membership_source: None,
            created_by: None,
        }
    }

    #[test]
    fn wake_notify_hints_round_trip_by_event_id() {
        record_wake_notify_hint(
            br#"{"type":"channel","channelId":"chn_h","eventId":"evt_hint_off","notify":false}"#,
        );
        record_wake_notify_hint(
            br#"{"type":"thread","scope":"channel","rootEventId":"r","eventId":"evt_hint_on","notify":true}"#,
        );
        // An old producer's wake carries no flag and records nothing.
        record_wake_notify_hint(br#"{"type":"channel","eventId":"evt_no_hint"}"#);
        assert_eq!(wake_notify_hint("evt_hint_off"), Some(false));
        assert_eq!(wake_notify_hint("evt_hint_on"), Some(true));
        assert_eq!(wake_notify_hint("evt_no_hint"), None);
    }

    #[test]
    fn notify_prefs_cache_is_scoped_to_identity() {
        {
            let mut guard = notify_prefs_cache().lock().unwrap();
            guard.identity = "sub_cache_a".to_string();
            guard.prefs = Some(hq_desktop_core::notify_prefs::NotifyPrefs::default());
            guard.fetched_at = Some(std::time::Instant::now());
        }
        assert!(cached_notify_prefs("sub_cache_a").is_some());
        assert!(cached_notify_prefs("sub_cache_b").is_none());
        invalidate_notify_prefs_cache();
        assert!(notify_prefs_cache().lock().unwrap().fetched_at.is_none());
    }

    #[test]
    fn thread_reply_wake_carries_reconciliation_scope_and_ids() {
        let reply = ThreadReply {
            event_id: "evt_reply".to_string(),
            from_person_uid: "prs_bryan".to_string(),
            from_email: String::new(),
            from_display_name: "Bryan".to_string(),
            body: "Looks good".to_string(),
            attachments: None,
            details: None,
            prompt: None,
            created_at: "2026-09-01T00:00:00.000Z".to_string(),
            direction: "in".to_string(),
            root_event_id: None,
            reply_count: None,
        };

        let payload = thread_reply_wake_payload(
            "evt_root",
            "CHANNEL",
            Some("chn_engineering"),
            None,
            &reply,
            3,
        );

        assert_eq!(payload["rootEventId"], "evt_root");
        assert_eq!(payload["eventId"], "evt_reply");
        assert_eq!(payload["scope"], "channel");
        assert_eq!(payload["channelId"], "chn_engineering");
        assert!(payload["withPersonUid"].is_null());
        assert_eq!(payload["reply"]["eventId"], "evt_reply");
        assert_eq!(payload["replyCount"], 3);
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
    fn mention_payload_maps_to_channel_message_route() {
        assert_eq!(
            mention_route("chn_eng", "evt_mention"),
            "inbox:channel:chn_eng:evt_mention"
        );
        assert_eq!(
            mention_notification_title("Ada", "engineering"),
            "Ada mentioned you in #engineering"
        );
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
    }

    #[test]
    fn mention_poll_spawns_when_pending_even_without_growth() {
        assert!(should_spawn_mention_detect(3, false));
        assert!(!should_spawn_mention_detect(3, true));
        assert!(!should_spawn_mention_detect(0, false));
    }

    #[test]
    fn diff_channels_keeps_new_message_increase_only_and_reports_exact_changes() {
        // a stayed flat, b grew, c shrank (read elsewhere) → only b is a new
        // message, while both b and c publish exact unread snapshots.
        let mut seen: HashMap<String, u32> = HashMap::new();
        seen.insert("a".to_string(), 2);
        seen.insert("b".to_string(), 1);
        seen.insert("c".to_string(), 5);
        let current = vec![mk_channel("a", 2), mk_channel("b", 3), mk_channel("c", 0)];
        let diff = diff_channels(&seen, &current);
        assert!(diff.new_channels.is_empty());
        assert_eq!(diff.new_messages, vec![("b".to_string(), 3)]);
        assert_eq!(
            diff.unread_changes,
            vec![("b".to_string(), 3), ("c".to_string(), 0)]
        );
    }

    #[test]
    fn diff_channels_clears_removed_channel_unread() {
        let mut seen: HashMap<String, u32> = HashMap::new();
        seen.insert("removed".to_string(), 6);

        let diff = diff_channels(&seen, &[]);

        assert_eq!(diff.unread_changes, vec![("removed".to_string(), 0)]);
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
            project_id: None,
            name: String::new(),
            scope: "group".to_string(),
            company_uid: None,
            company_name: None,
            post_policy: None,
            visibility: None,
            membership: Some("joined".to_string()),
            unread: Some(0),
            member_count: Some(5),
            last_activity_at: None,
            last_message_at: None,
            created_at: None,
            members: None,
            notify_level: None,
            membership_source: None,
            created_by: None,
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

    #[test]
    fn reaction_poll_decodes_server_envelope() {
        let body = br#"{
            "messageScope": "dm:prs_deacon",
            "messageId": "evt_eyes",
            "reactions": [
                { "emoji": "\ud83d\udc40", "count": 1, "reactedByMe": false }
            ]
        }"#;

        let reactions = parse_reaction_poll_payload(body).expect("reaction envelope decodes");
        assert_eq!(reactions.len(), 1);
        assert_eq!(reactions[0].emoji, "👀");
        assert_eq!(reactions[0].count, 1);
        assert!(!reactions[0].reacted_by_me);
    }

    #[tokio::test]
    async fn account_switch_resets_native_notification_state_and_rejects_old_snapshot() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        assert!(app.manage(UnreadDmState(Mutex::new(0))));
        assert!(app.manage(SeenRequestState::new()));
        assert!(app.manage(SeenChannelState::new()));
        let handle = app.handle().clone();

        let first_snapshot =
            replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string())
                .await;
        *handle
            .state::<UnreadDmState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = 7;
        {
            let request_state = handle.state::<SeenRequestState>();
            let mut requests = request_state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests.initialized = true;
            requests.pair_keys.insert("pair-a".to_string());
        }
        {
            let channel_state = handle.state::<SeenChannelState>();
            let mut channels = channel_state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            channels.initialized = true;
            channels.unread_by_id.insert("channel-a".to_string(), 4);
        }

        let second_snapshot =
            replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string())
                .await;

        assert_ne!(first_snapshot.generation, second_snapshot.generation);
        assert_eq!(second_snapshot.identity, "person-b");
        assert_eq!(second_snapshot.access_token, "access-b");
        assert_eq!(
            current_notification_auth_snapshot(&handle).await,
            Some(second_snapshot.clone())
        );
        assert_eq!(current_unread_dms(&handle), 0);
        assert!(
            !handle
                .state::<SeenRequestState>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .initialized
        );
        assert!(handle
            .state::<SeenChannelState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .unread_by_id
            .is_empty());

        let stale_commit =
            with_current_notification_auth_snapshot(&handle, &first_snapshot, || 1u8).await;
        assert_eq!(stale_commit, None);
        let current_commit =
            with_current_notification_auth_snapshot(&handle, &second_snapshot, || 2u8).await;
        assert_eq!(current_commit, Some(2));
    }

    #[tokio::test]
    async fn access_token_rotation_invalidates_old_work_without_erasing_same_account_state() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        assert!(app.manage(UnreadDmState(Mutex::new(0))));
        let handle = app.handle().clone();

        let old_snapshot =
            replace_notification_session(&handle, "person-a".to_string(), "access-old".to_string())
                .await;
        *handle
            .state::<UnreadDmState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = 7;

        let refreshed_snapshot = ensure_notification_session(
            &handle,
            "person-a".to_string(),
            "access-refreshed".to_string(),
        )
        .await;

        assert_ne!(old_snapshot.generation, refreshed_snapshot.generation);
        assert_eq!(refreshed_snapshot.identity, "person-a");
        assert_eq!(refreshed_snapshot.access_token, "access-refreshed");
        assert_eq!(
            current_unread_dms(&handle),
            7,
            "a same-account refresh invalidates old requests but preserves account state"
        );
        assert_eq!(
            with_current_notification_auth_snapshot(&handle, &old_snapshot, || "stale").await,
            None
        );
        assert_eq!(
            with_current_notification_auth_snapshot(&handle, &refreshed_snapshot, || "current")
                .await,
            Some("current")
        );
    }

    #[tokio::test]
    async fn stale_thread_and_reaction_subpolls_cannot_mutate_or_emit_after_account_switch() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        assert!(app.manage(ActiveThreadState::new()));
        assert!(app.manage(ActiveConversationState::new()));
        assert!(app.manage(WatchedSharesState::new()));
        let handle = app.handle().clone();

        let stale_snapshot =
            replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string())
                .await;
        let _current_snapshot =
            replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string())
                .await;

        let emitted = std::sync::atomic::AtomicUsize::new(0);
        let committed = with_current_notification_auth_snapshot(&handle, &stale_snapshot, || {
            handle
                .state::<ActiveThreadState>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    "stale-window".to_string(),
                    ActiveThreadInner {
                        seen_reply_ids: ["stale-reply".to_string()].into_iter().collect(),
                        ..Default::default()
                    },
                );
            handle
                .state::<ActiveConversationState>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .last_seen
                .insert("stale-message".to_string(), "[]".to_string());
            handle
                .state::<WatchedSharesState>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .last_seen
                .insert("stale-share".to_string(), "[]".to_string());
            emitted.fetch_add(3, std::sync::atomic::Ordering::SeqCst);
        })
        .await;

        assert!(committed.is_none());
        assert!(handle
            .state::<ActiveThreadState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty());
        assert!(handle
            .state::<ActiveConversationState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last_seen
            .is_empty());
        assert!(handle
            .state::<WatchedSharesState>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last_seen
            .is_empty());
        assert_eq!(
            emitted.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "event emission must stay inside the same generation guard as state mutation"
        );
    }

    #[tokio::test]
    async fn stale_account_snapshot_cannot_start_an_ack() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();

        let stale_snapshot =
            replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string())
                .await;
        replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string()).await;

        let ack_calls = std::sync::atomic::AtomicUsize::new(0);
        let result =
            with_current_notification_auth_snapshot_async(&handle, &stale_snapshot, || async {
                ack_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            })
            .await;

        assert!(result.is_none());
        assert_eq!(
            ack_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an ACK must not begin after its captured account snapshot is stale"
        );
    }

    #[tokio::test]
    async fn generation_cas_prevents_late_old_account_publication() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();

        // An old token resolver may have read generation zero before OAuth
        // starts. OAuth invalidates it first, so the stale publication CAS must
        // fail instead of resurrecting account A after B is active.
        let old_generation = notification_session_generation(&handle)
            .await
            .expect("managed notification session");
        let account_b =
            replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string())
                .await;
        let stale_publication = ensure_notification_session_if_generation(
            &handle,
            old_generation,
            "person-a".to_string(),
            "access-a".to_string(),
        )
        .await;

        assert!(stale_publication.is_none());
        assert_eq!(
            current_notification_auth_snapshot(&handle).await,
            Some(account_b),
            "the newer account must remain final; A cannot publish after B"
        );
    }

    #[tokio::test]
    async fn stale_auth_failure_cannot_clear_a_newer_account() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();

        let old_generation = notification_session_generation(&handle)
            .await
            .expect("managed notification session");
        let account_b =
            replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string())
                .await;

        assert_eq!(
            clear_notification_session_if_generation(&handle, old_generation).await,
            None,
            "the stale resolver must lose its generation CAS"
        );
        assert_eq!(
            current_notification_auth_snapshot(&handle).await,
            Some(account_b),
            "an old auth failure must not sign out the newer account"
        );
    }

    #[tokio::test]
    async fn auth_transition_waits_for_an_active_mutating_lease_before_publishing_next_account() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();
        let account_a =
            replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string())
                .await;

        // Acquire an intentional-write lease exactly as the mutation helper
        // does, then hold it past the account-switch start.
        let lease = {
            let state = handle.state::<NotificationSessionState>();
            let session = state.inner.lock().await;
            assert_eq!(session.auth_snapshot().as_ref(), Some(&account_a));
            let lease = state.mutation_leases.acquire();
            drop(session);
            lease
        };

        let switching_handle = handle.clone();
        let switch = tokio::spawn(async move {
            replace_notification_session(
                &switching_handle,
                "person-b".to_string(),
                "access-b".to_string(),
            )
            .await
        });

        // The old identity is withdrawn immediately, but B is not published
        // while the old remote-write lease remains active.
        for _ in 0..8 {
            tokio::task::yield_now().await;
            if current_notification_auth_snapshot(&handle).await.is_none() {
                break;
            }
        }
        assert_eq!(current_notification_auth_snapshot(&handle).await, None);
        assert!(
            !switch.is_finished(),
            "account B must wait for the account-A mutation lease to drain"
        );

        drop(lease);
        let account_b = tokio::time::timeout(std::time::Duration::from_millis(250), switch)
            .await
            .expect("transition completes after the lease drains")
            .expect("transition task succeeds");
        assert_eq!(
            current_notification_auth_snapshot(&handle).await,
            Some(account_b)
        );
    }

    #[tokio::test]
    async fn auth_transition_waits_for_pending_mutation_response_before_publishing_next_account() {
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();
        let account_a =
            replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string())
                .await;

        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let operation_handle = handle.clone();
        let operation = tokio::spawn(async move {
            with_current_notification_mutation(&operation_handle, &account_a, move || async move {
                let _ = started_tx.send(());
                release_rx
                    .await
                    .expect("test completes the remote response");
            })
            .await
        });

        tokio::time::timeout(std::time::Duration::from_millis(250), started_rx)
            .await
            .expect("mutation begins")
            .expect("mutation start signal is delivered");

        let switching_handle = handle.clone();
        let switch = tokio::spawn(async move {
            replace_notification_session(
                &switching_handle,
                "person-b".to_string(),
                "access-b".to_string(),
            )
            .await
        });

        // The transition is immediately visible as unauthenticated, but it
        // cannot publish B or return while the account-A server write remains
        // in flight.
        for _ in 0..8 {
            tokio::task::yield_now().await;
            if current_notification_auth_snapshot(&handle).await.is_none() {
                break;
            }
        }
        assert_eq!(current_notification_auth_snapshot(&handle).await, None);
        assert!(
            !switch.is_finished(),
            "the transition must wait for the pending mutation response"
        );

        release_tx
            .send(())
            .expect("release the simulated server response");
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_millis(250), operation)
                .await
                .expect("completed operation exits")
                .expect("operation task succeeds"),
            None,
            "the stale operation cannot commit local state after account A is withdrawn"
        );
        let account_b = tokio::time::timeout(std::time::Duration::from_millis(250), switch)
            .await
            .expect("transition completes once the write lease drains")
            .expect("transition task succeeds");
        assert_eq!(
            current_notification_auth_snapshot(&handle).await,
            Some(account_b)
        );
    }

    fn person_uid_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn test_auth(identity: &str, token: &str) -> NotificationAuthSnapshot {
        NotificationAuthSnapshot {
            generation: 1,
            identity: identity.to_string(),
            access_token: token.to_string(),
        }
    }

    fn test_person_entity(
        uid: &str,
        created_at: &str,
    ) -> crate::commands::vault_client::EntityInfo {
        serde_json::from_value(serde_json::json!({
            "uid": uid,
            "slug": "p",
            "type": "person",
            "status": "active",
            "createdAt": created_at,
        }))
        .expect("person entity")
    }

    fn mention_of(participant_uid: &str) -> hq_desktop_core::messages::ChannelMessage {
        serde_json::from_str(&format!(
            r#"{{
                "eventId": "evt_mention",
                "fromPersonUid": "prs_ada",
                "fromDisplayName": "Ada",
                "body": "hey",
                "createdAt": "2026-09-23T12:00:00Z",
                "direction": "in",
                "mentions": [{{
                    "participantUid": "{participant_uid}",
                    "participantType": "human",
                    "displayName": "Stefan"
                }}]
            }}"#
        ))
        .expect("mention message")
    }

    #[test]
    fn person_uid_from_entities_prefers_oldest_then_uid() {
        let newer = test_person_entity("prs_a", "2025-01-01T00:00:00Z");
        let older = test_person_entity("prs_b", "2024-01-01T00:00:00Z");
        assert_eq!(
            person_uid_from_entities(vec![newer, older]).as_deref(),
            Some("prs_b")
        );
        let first = test_person_entity("prs_a", "2024-01-01T00:00:00Z");
        let second = test_person_entity("prs_b", "2024-01-01T00:00:00Z");
        assert_eq!(
            person_uid_from_entities(vec![second, first]).as_deref(),
            Some("prs_a")
        );
    }

    #[test]
    fn person_uid_from_memberships_reads_uid_or_key_prefix() {
        let with_uid: crate::commands::vault_client::MembershipInfo =
            serde_json::from_value(serde_json::json!({
                "personUid": "prs_from_field",
                "companyUid": "cmp_a",
                "status": "active",
            }))
            .expect("membership");
        assert_eq!(
            person_uid_from_memberships(&[with_uid]).as_deref(),
            Some("prs_from_field")
        );
        let from_key: crate::commands::vault_client::MembershipInfo =
            serde_json::from_value(serde_json::json!({
                "personUid": "",
                "companyUid": "cmp_a",
                "status": "active",
                "membershipKey": "prs_from_key#cmp_a",
            }))
            .expect("membership key");
        assert_eq!(
            person_uid_from_memberships(&[from_key]).as_deref(),
            Some("prs_from_key")
        );
    }

    #[test]
    fn missing_person_uid_skip_log_is_once_per_session() {
        let _lock = person_uid_test_lock();
        clear_person_uid_cache();
        assert!(take_missing_person_uid_skip_log());
        assert!(!take_missing_person_uid_skip_log());
        assert!(!take_missing_person_uid_skip_log());
        clear_person_uid_cache();
        assert!(take_missing_person_uid_skip_log());
        clear_person_uid_cache();
    }

    #[test]
    fn detect_without_person_uid_still_matches_cognito_sub() {
        let message = mention_of("sub_mention_me");
        assert!(is_mention_of_me(&message, "", "sub_mention_me"));
        assert!(hq_desktop_core::dm_notify::is_self_authored(
            "sub_mention_me",
            "",
            "sub_mention_me",
        ));
    }

    #[tokio::test]
    async fn resolver_prefers_config_over_server() {
        let _lock = person_uid_test_lock();
        clear_person_uid_cache();
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/entity/by-type/person"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "entities": [{
                        "uid": "prs_server",
                        "slug": "p",
                        "type": "person",
                        "status": "active",
                        "createdAt": "2024-01-01T00:00:00Z"
                    }]
                })),
            )
            .expect(0)
            .mount(&server)
            .await;
        let auth = test_auth("sub_prefers_config", "tok");
        let uid = resolve_signed_in_person_uid_with(
            Some("prs_from_config".to_string()),
            &server.uri(),
            &auth,
        )
        .await;
        assert_eq!(uid.as_deref(), Some("prs_from_config"));
        clear_person_uid_cache();
    }

    #[tokio::test]
    async fn resolver_falls_back_to_server_and_caches() {
        let _lock = person_uid_test_lock();
        clear_person_uid_cache();
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/entity/by-type/person"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "entities": [{
                        "uid": "prs_server_uid",
                        "slug": "p",
                        "type": "person",
                        "status": "active",
                        "createdAt": "2024-01-01T00:00:00Z"
                    }]
                })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let auth = test_auth("sub_server_fallback", "tok");
        let first = resolve_signed_in_person_uid_with(None, &server.uri(), &auth).await;
        assert_eq!(first.as_deref(), Some("prs_server_uid"));
        assert_eq!(
            cached_person_uid("sub_server_fallback").as_deref(),
            Some("prs_server_uid")
        );
        let second = resolve_signed_in_person_uid_with(None, &server.uri(), &auth).await;
        assert_eq!(second.as_deref(), Some("prs_server_uid"));
        let mentioned = mention_of("prs_server_uid");
        assert!(is_mention_of_me(
            &mentioned,
            first.as_deref().unwrap_or(""),
            &auth.identity,
        ));
        clear_person_uid_cache();
    }

    #[tokio::test]
    async fn resolver_uses_memberships_when_person_list_empty() {
        let _lock = person_uid_test_lock();
        clear_person_uid_cache();
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/entity/by-type/person"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "entities": [] })),
            )
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/membership/me"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "memberships": [{
                        "personUid": "prs_from_membership",
                        "companyUid": "cmp_a",
                        "status": "active",
                        "membershipKey": "prs_from_membership#cmp_a"
                    }]
                })),
            )
            .mount(&server)
            .await;
        let auth = test_auth("sub_membership_fallback", "tok");
        let uid = resolve_signed_in_person_uid_with(None, &server.uri(), &auth).await;
        assert_eq!(uid.as_deref(), Some("prs_from_membership"));
        clear_person_uid_cache();
    }

    #[tokio::test]
    async fn person_uid_cache_clears_on_session_reset() {
        let _lock = person_uid_test_lock();
        let app = tauri::test::mock_app();
        assert!(app.manage(NotificationSessionState::new()));
        let handle = app.handle().clone();
        replace_notification_session(&handle, "person-a".to_string(), "access-a".to_string()).await;
        store_person_uid_cache("person-a", Some("prs_cached".to_string()));
        assert!(take_missing_person_uid_skip_log());
        assert_eq!(cached_person_uid("person-a").as_deref(), Some("prs_cached"));

        replace_notification_session(&handle, "person-b".to_string(), "access-b".to_string()).await;

        assert!(cached_person_uid("person-a").is_none());
        assert!(cached_person_uid("person-b").is_none());
        assert!(
            take_missing_person_uid_skip_log(),
            "session reset must re-arm the missing-uid skip log"
        );
        clear_person_uid_cache();
    }
}
