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

use std::collections::HashMap;
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
    dm_notifications_enabled, effective_reply_count, esc_thread_seg, normalize_scope,
    partition_unnotified, read_cursor_entry_for_account, respond_action_path, respond_action_state,
    try_set_in_flight, write_cursor_entry_for_account, ActiveConversationInner,
    ActiveConversationState, ActiveThreadInner, ActiveThreadState, CursorEntry, DmEvent,
    InboxResponse, PairUnread, PairUnreadState, PendingDmEvents, RequestsListResponse,
    SeenChannelState, SeenRequestState, SendDmOutcome, ThreadReply, ThreadResponse, ThreadView,
    UnreadDmState,
};

const LOG_TAG: &str = "dm-notify";

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
/// Also the unified Messages quick window (side pane + detail canvas) used by
/// the widget and notification entry points — not the full desktop-alt app.
const DM_DETAIL_LABEL: &str = "dm-detail";

/// Default size for the two-pane Messages / DM detail window.
const COMMUNICATIONS_WINDOW_W: f64 = 820.0;
const COMMUNICATIONS_WINDOW_H: f64 = 640.0;

/// Tauri event the DM detail window listens for to receive its event payload.
const EVENT_DM_DETAIL_EVENT: &str = "dm:detail-event";

/// Open the window as Messages (no forced DM) — clears the main canvas selection
/// so the user picks a conversation from the side pane.
const EVENT_DM_INBOX_OPEN: &str = "dm:inbox-open";

/// A channel notification can open the same singleton compact communications
/// window as DMs. Cold opens stash the target until the renderer's ready
/// handshake; genuinely warm opens take it immediately and emit to the mounted
/// listener. Merely having built the native window does not make its renderer
/// ready — there is a real gap before `DmDetail.svelte` mounts its listener.
const EVENT_COMMUNICATIONS_CHANNEL_OPEN: &str = "communications:open-channel";

enum CommunicationsOpenTarget {
    Inbox,
    Channel(Channel),
}

#[derive(Default)]
struct CommunicationsWindowState {
    renderer_ready: bool,
    pending_target: Option<CommunicationsOpenTarget>,
}

impl CommunicationsWindowState {
    fn queue(&mut self, channel: Option<Channel>) {
        self.pending_target = Some(match channel {
            Some(channel) => CommunicationsOpenTarget::Channel(channel),
            None => CommunicationsOpenTarget::Inbox,
        });
    }

    fn take_if_ready(&mut self) -> Option<CommunicationsOpenTarget> {
        self.renderer_ready
            .then(|| self.pending_target.take())
            .flatten()
    }

    fn mark_ready_and_take(&mut self) -> Option<CommunicationsOpenTarget> {
        self.renderer_ready = true;
        self.pending_target.take()
    }
}

static COMMUNICATIONS_WINDOW_STATE: OnceLock<Mutex<CommunicationsWindowState>> = OnceLock::new();

fn communications_window_state() -> &'static Mutex<CommunicationsWindowState> {
    COMMUNICATIONS_WINDOW_STATE.get_or_init(|| Mutex::new(CommunicationsWindowState::default()))
}

fn set_pending_communications_channel(channel: Option<Channel>) {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .queue(channel);
}

fn clear_pending_communications_target() {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pending_target = None;
}

fn mark_communications_renderer_not_ready() {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .renderer_ready = false;
}

fn take_communications_target_if_ready() -> Option<CommunicationsOpenTarget> {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take_if_ready()
}

fn mark_communications_renderer_ready_and_take() -> Option<CommunicationsOpenTarget> {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .mark_ready_and_take()
}

fn communications_renderer_ready() -> bool {
    communications_window_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .renderer_ready
}

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
        if let Some(state) = app.try_state::<PendingDmEvents>() {
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
        if let Some(state) = app.try_state::<ActiveThreadState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = ActiveThreadInner::default();
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
            let _ = clear_notification_session_if_generation(app, started_generation).await;
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
    cognito::clear_tokens().await
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
            &format!(
                "DM_NOTIFY_THREAD_READ_ERROR uid={uid} status={status} msg={server_msg:?}"
            ),
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
async fn poll_active_thread(app: &AppHandle, base_url: &str, auth: &NotificationAuthSnapshot) {
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
        .header("authorization", format!("Bearer {}", auth.access_token))
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

    // Reconcile and emit under the same auth-snapshot guard, so stale account
    // work cannot mutate the active thread or leak an event to the new account.
    let committed = with_current_notification_auth_snapshot(app, auth, || {
        let Some(state) = app.try_state::<ActiveThreadState>() else {
            return false;
        };
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if guard.root_event_id.as_deref() != Some(root.as_str()) {
            return false;
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
        drop(guard);

        // Emit oldest→newest so the panel appends in chronological order. The
        // server returns newest-first, so reverse.
        for reply in fresh.iter().rev() {
            let payload = serde_json::json!({
                "rootEventId": root,
                "reply": reply,
                "replyCount": effective_reply_count(&view),
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
        true
    })
    .await;
    if committed.is_none() {
        log(LOG_TAG, "DM_NOTIFY_THREAD_POLL_STALE auth snapshot changed");
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

/// Poll the channels list and emit channel events off the diff. Folded into the
/// SINGLE `do_poll` path (NOT a parallel poller). Best-effort: any failure logs
/// and returns without disturbing the DM-inbox poll. The first poll seeds the
/// unread map silently (no events for the pre-launch backlog).
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

    let committed = with_current_notification_auth_snapshot(app, auth, || {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.snapshot_is_current(snapshot_revision) {
            return false;
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
            log(
                LOG_TAG,
                &format!("DM_NOTIFY_CHAN_POLL_SEED count={}", list.channels.len()),
            );
            return true;
        }

        // Emit `channel:updated` for brand-new channels/invites (full payload so
        // the rail can render the row without a separate fetch).
        for channel_id in &diff.new_channels {
            if let Some(ch) = list.channels.iter().find(|c| &c.channel_id == channel_id) {
                log(LOG_TAG, &format!("DM_NOTIFY_CHAN_UPDATED id={channel_id}"));
                let _ = app.emit(EVENT_CHANNEL_UPDATED, ch);
            }
        }
        // Publish every exact unread transition (increase, decrease, or removal)
        // before increase-only content refresh signals.
        for (channel_id, unread) in &diff.unread_changes {
            let payload = serde_json::json!({ "channelId": channel_id, "unread": unread });
            let _ = app.emit(EVENT_CHANNEL_UNREAD_CHANGED, &payload);
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
        true
    })
    .await
    .unwrap_or(false);

    if !committed {
        log(
            LOG_TAG,
            "DM_NOTIFY_CHAN_POLL_STALE auth generation or local unread revision changed",
        );
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

    // Fold channel-activity polling into the SAME single path (US-018) — a
    // "channel" wake on the person topic routes here. Best-effort; emits
    // `channel:new-message` / `channel:updated`. NOT a parallel poller.
    poll_channels(app, &base_url, auth).await;

    // Fold thread-activity polling into the SAME single path (US-022) — a
    // "thread" wake on the person topic routes here. Re-fetches whichever thread
    // the ThreadPanel currently has open and emits `thread:new-reply` for replies
    // it hasn't surfaced yet. No-op when no panel is open. NOT a parallel poller.
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

    // SPIKE: when the custom banner is enabled, route every DM through the
    // in-app banner (commands::banner) — event-driven, no blocking Cocoa run
    // loop — and skip the native firing path entirely.
    // US-003: widget takeover must never fall back to native banners
    if crate::commands::banner::custom_banner_enabled()
        || crate::commands::widget::takeover_active(app)
    {
        log(
            LOG_TAG,
            &format!("DM_NOTIFY_CUSTOM_BANNER {} DM(s)", fresh.len()),
        );
        for dm in &fresh {
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
            let title_for_log = title.clone();
            let dispatched = with_current_notification_mutation(app, auth, || async move {
                tokio::task::spawn_blocking(move || {
                    // Native fallback is intentionally fire-and-forget. The
                    // custom banner/widget path above owns interactive actions;
                    // waiting for a native click here would keep an account
                    // transition blocked until the user acted.
                    let mut notification = mac_notification_sys::Notification::default();
                    notification
                        .title(&title)
                        .message(&message)
                        .asynchronous(true);
                    notification.send()
                })
                .await
            })
            .await;

            match dispatched {
                None => {
                    log(LOG_TAG, "DM_NOTIFY_TOAST_STALE auth session changed");
                    return;
                }
                Some(Ok(Ok(_))) => log(
                    LOG_TAG,
                    &format!("DM_NOTIFY_TOAST_SHOWN from={title_for_log}"),
                ),
                Some(Ok(Err(error))) => log(LOG_TAG, &format!("DM_NOTIFY_SEND_FAILED err={error}")),
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
        for dm in &fresh {
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

// ── DM detail / Messages quick window ───────────────────────────────────────────
//
// Mirrors `open_share_detail` / `share_detail_window_ready` in share_notify.rs:
// stash the event in managed state, create the window hidden, and let the
// renderer's ready-handshake (`dm_detail_window_ready`) pull the payload + show
// the window — avoids the race where emit_to fires before the JS listener mounts.
//
// The same webview is the compact Messages surface: left side pane
// (conversations) + right canvas (thread / share detail). Desktop-alt remains
// the full Company OS shell.

fn ensure_communications_window(app: &AppHandle) -> Result<bool, String> {
    // Existing does not necessarily mean ready: a newly-built webview has a
    // startup gap before its listener + ready handshake complete.
    if app.get_webview_window(DM_DETAIL_LABEL).is_some() {
        return Ok(true);
    }

    mark_communications_renderer_not_ready();

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        DM_DETAIL_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Messages")
    .inner_size(COMMUNICATIONS_WINDOW_W, COMMUNICATIONS_WINDOW_H)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .decorations(true)
    .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            // The webview must be transparent for the native Liquid Glass
            // backing to sample the desktop and windows behind Messages.
            //
            // Keep the standard decorated titlebar here. Overlay would place
            // traffic lights over DmDetail's 20px-aligned custom heading; that
            // component intentionally has no macOS-only safe-area gutter.
            // AppKit's titlebar remains native material, while the content view
            // receives the compact communications glass below.
            .transparent(true)
            .on_page_load(|loaded_window, payload| {
                if payload.event() != tauri::webview::PageLoadEvent::Finished {
                    return;
                }
                let window = loaded_window;
                let dispatcher = window.clone();
                let _ = dispatcher.run_on_main_thread(move || {
                    crate::glass::refresh_liquid_glass_window(&window);
                });
            });
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        // WKWebView retains an opaque system under-page color even on a
        // transparent Tauri window unless it is explicitly cleared.
        let _ = window.with_webview(|webview| {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: with_webview runs on AppKit's main thread; the selectors
            // are public WebKit/AppKit APIs and the WKWebView is live.
            unsafe {
                let wk = webview.inner() as *mut AnyObject;
                let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![wk, setUnderPageBackgroundColor: clear];
                let _: () = msg_send![
                    wk,
                    setValue: clear,
                    forKey: communications_ns_string("backgroundColor")
                ];
            }
        });

        let glass_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::glass::apply_compact_communications_glass_window(&glass_window);
        });
    }

    Ok(false)
}

/// Build an autoreleased NSString for WKWebView background-color KVC.
#[cfg(target_os = "macos")]
fn communications_ns_string(value: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::{class, msg_send};
    // SAFETY: the bytes are valid UTF-8 for the duration of this message, and
    // NSString returns an autoreleased object retained by the KVC call.
    unsafe {
        let bytes = value.as_ptr() as *const std::ffi::c_void;
        msg_send![
            class!(NSString),
            stringWithBytes: bytes,
            length: value.len(),
            encoding: 4usize
        ]
    }
}

fn show_focus_communications_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DM_DETAIL_LABEL) {
        let _ = window.set_size(tauri::LogicalSize::new(
            COMMUNICATIONS_WINDOW_W,
            COMMUNICATIONS_WINDOW_H,
        ));
        let _ = window.set_title("Messages");
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn emit_communications_target(
    app: &AppHandle,
    target: CommunicationsOpenTarget,
) -> Result<(), String> {
    match target {
        CommunicationsOpenTarget::Channel(channel) => app
            .emit_to(DM_DETAIL_LABEL, EVENT_COMMUNICATIONS_CHANNEL_OPEN, channel)
            .map_err(|e| e.to_string()),
        CommunicationsOpenTarget::Inbox => app
            .emit_to(DM_DETAIL_LABEL, EVENT_DM_INBOX_OPEN, serde_json::json!({}))
            .map_err(|e| e.to_string()),
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

/// Open the dedicated mini communications window without forcing a specific DM.
///
/// This explicit route intentionally coexists with [`open_inbox_window`]:
/// Inbox remains a full-desktop destination, while compact messaging entry
/// points can opt into the reusable two-pane `dm-detail` surface. A cold window
/// is shown by [`dm_detail_window_ready`] after its listeners mount; a warm
/// window is focused immediately and reset to its conversation chooser.
#[tauri::command]
pub async fn open_communications_window(
    app: AppHandle,
    channel: Option<Channel>,
) -> Result<(), String> {
    log(LOG_TAG, "COMMUNICATIONS_WINDOW_OPEN");

    let channel_id = channel.as_ref().map(|c| c.channel_id.as_str());
    // US-104: flag-on steals this compact window into the embedded desktop
    // (validated channel/reply tokens → pending-open). Flag-off is unchanged.
    if crate::commands::hq_work::maybe_intercept_conversation_open(&app, channel_id, None).await? {
        return Ok(());
    }

    // A prior notification may have stashed a single DM for the ready
    // handshake. Clear it before opening the general communications surface so
    // a cold window cannot unexpectedly reopen that stale conversation.
    if let Some(state) = app.try_state::<PendingDmEvents>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Vec::new();
    }

    set_pending_communications_channel(channel);
    let existed = match ensure_communications_window(&app) {
        Ok(existed) => existed,
        Err(error) => {
            clear_pending_communications_target();
            return Err(error);
        }
    };
    if existed {
        // A second click can land after native creation but before the JS
        // listener is mounted. Leave the latest target queued in that case;
        // `dm_detail_window_ready` owns the first emit.
        if let Some(target) = take_communications_target_if_ready() {
            show_focus_communications_window(&app)?;
            emit_communications_target(&app, target)?;
        }
    }

    Ok(())
}

/// Tauri command: open (or focus) the DM detail window for a single DM event.
/// Invoked by App.svelte's `notification:dm-action` listener on the "open" action.
#[tauri::command]
pub async fn open_dm_detail(app: AppHandle, event: DmEvent) -> Result<(), String> {
    let person = event.from_person_uid.as_str();
    // US-104: flag-on opens the embedded desktop on this person; never launch_hq_work.
    if crate::commands::hq_work::maybe_intercept_dm_open(&app, Some(person), None).await? {
        return Ok(());
    }

    clear_pending_communications_target();
    if let Some(state) = app.try_state::<PendingDmEvents>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = vec![event.clone()];
    }

    let existed = ensure_communications_window(&app)?;
    if existed && communications_renderer_ready() {
        show_focus_communications_window(&app)?;
        app.emit_to(DM_DETAIL_LABEL, EVENT_DM_DETAIL_EVENT, &event)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

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
    let communications_target = mark_communications_renderer_ready_and_take();

    if let Some(event) = events.first() {
        app.emit_to(DM_DETAIL_LABEL, EVENT_DM_DETAIL_EVENT, event)
            .map_err(|e| e.to_string())?;
    } else if let Some(target) = communications_target {
        emit_communications_target(&app, target)?;
    } else {
        // General Messages open with no forced DM — empty canvas + side pane.
        app.emit_to(DM_DETAIL_LABEL, EVENT_DM_INBOX_OPEN, serde_json::json!({}))
            .map_err(|e| e.to_string())?;
        let _ = app
            .get_webview_window(DM_DETAIL_LABEL)
            .and_then(|w| w.set_title("Messages").ok());
    }

    if let Some(window) = app.get_webview_window(DM_DETAIL_LABEL) {
        let _ = window.set_size(tauri::LogicalSize::new(
            COMMUNICATIONS_WINDOW_W,
            COMMUNICATIONS_WINDOW_H,
        ));
        let _ = window.show();
        let _ = window.set_focus();
    }

    // Best-effort ack so the opened DM isn't re-notified next poll.
    if let Some(event) = events.first() {
        let event_id = event.event_id.clone();
        if let Some(auth) = current_notification_auth_snapshot(&app).await {
            let app_for_ack = app.clone();
            tauri::async_runtime::spawn(async move {
                post_ack(&app_for_ack, &auth, vec![event_id]).await;
            });
        }
    }

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
        }
    }

    #[test]
    fn communications_target_waits_through_created_but_not_ready_window() {
        let mut state = CommunicationsWindowState::default();

        // The first click creates the native window, but its JS listener has
        // not mounted yet. A second click during that gap replaces the target
        // without emitting into an unready renderer.
        state.queue(Some(mk_channel("first", 1)));
        assert!(state.take_if_ready().is_none());
        state.queue(Some(mk_channel("second", 2)));
        assert!(state.take_if_ready().is_none());

        match state.mark_ready_and_take() {
            Some(CommunicationsOpenTarget::Channel(channel)) => {
                assert_eq!(channel.channel_id, "second");
            }
            _ => panic!("latest cold-start channel must reach the ready handshake"),
        }

        // Once the renderer is genuinely warm, later opens can emit
        // immediately instead of waiting for another ready handshake.
        state.queue(None);
        assert!(matches!(
            state.take_if_ready(),
            Some(CommunicationsOpenTarget::Inbox)
        ));
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
                .seen_reply_ids
                .insert("stale-reply".to_string());
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
            .seen_reply_ids
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
}
