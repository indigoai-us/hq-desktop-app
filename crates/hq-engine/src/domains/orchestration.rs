//! Local application-session orchestration that does not belong to AppKit.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use super::local::CoreBackend;
use crate::{to_value, CancellationFlag, EngineError};

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    "get_auth_state",
    "sign_out",
    "begin_reauth",
    "get_activity_log",
    "set_active_conversation",
    "set_active_thread",
    "set_watched_shares",
    "mark_messages_read",
    "set_workspace_sync_enabled",
];

pub(crate) const MAX_ACTIVITY_ENTRIES: usize = 2_000;

#[derive(Debug, Default)]
struct ActiveConversationSession {
    scope: Option<String>,
    message_ids: Vec<String>,
    last_seen: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct ActiveThreadSession {
    root_event_id: Option<String>,
    scope: String,
    channel_id: Option<String>,
    with_person_uid: Option<String>,
    seen_reply_ids: HashSet<String>,
}

#[derive(Debug, Default)]
struct WatchedSharesSession {
    event_ids: Vec<String>,
    last_seen: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct SeenRequestsSession {
    initialized: bool,
    pair_keys: HashSet<String>,
}

#[derive(Debug, Default)]
struct SeenChannelsSession {
    initialized: bool,
    unread_by_id: HashMap<String, u32>,
}

type ChannelReconciliation = (Vec<hq_desktop_core::messages::Channel>, Vec<(String, u32)>);

#[cfg(test)]
type ActiveThreadSnapshot = (
    String,
    String,
    Option<String>,
    Option<String>,
    HashSet<String>,
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveThreadDescriptor {
    pub(crate) root_event_id: String,
    pub(crate) scope: String,
    pub(crate) channel_id: Option<String>,
    pub(crate) with_person_uid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveConversationDescriptor {
    pub(crate) scope: String,
    pub(crate) message_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct RealtimePollLease<'a> {
    flag: &'a AtomicBool,
}

impl Drop for RealtimePollLease<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[derive(Debug, Default)]
pub(crate) struct SessionOrchestrationState {
    active_conversation: Mutex<ActiveConversationSession>,
    active_thread: Mutex<ActiveThreadSession>,
    watched_shares: Mutex<WatchedSharesSession>,
    seen_requests: Mutex<SeenRequestsSession>,
    seen_channels: Mutex<SeenChannelsSession>,
    activity: Mutex<Vec<hq_desktop_core::activity::ActivityEntry>>,
    unread_dms: Mutex<u32>,
    workspace_settings: Mutex<()>,
    dm_poll_in_flight: AtomicBool,
    share_poll_in_flight: AtomicBool,
}

impl SessionOrchestrationState {
    pub(crate) fn try_begin_dm_poll(&self) -> Option<RealtimePollLease<'_>> {
        try_begin_poll(&self.dm_poll_in_flight)
    }

    pub(crate) fn try_begin_share_poll(&self) -> Option<RealtimePollLease<'_>> {
        try_begin_poll(&self.share_poll_in_flight)
    }

    /// Reconcile the pending-request snapshot. `None` means this was the first
    /// observation and callers must seed silently.
    pub(crate) fn reconcile_requests(
        &self,
        current: &[hq_desktop_core::dm_notify::DmRequest],
    ) -> Option<(Vec<hq_desktop_core::dm_notify::DmRequest>, Vec<String>)> {
        let mut seen = lock_unpoisoned(&self.seen_requests);
        let first_poll = !seen.initialized;
        let diff = hq_desktop_core::dm_notify::diff_requests(&seen.pair_keys, current);
        seen.pair_keys = current
            .iter()
            .map(|request| request.pair_key.clone())
            .collect();
        seen.initialized = true;
        (!first_poll).then_some(diff)
    }

    /// Reconcile channel unread counts. `None` means the first observation was
    /// stored silently. Later results contain full new-channel rows followed by
    /// `(channelId, unread)` increments in server order.
    pub(crate) fn reconcile_channels(
        &self,
        current: &[hq_desktop_core::messages::Channel],
    ) -> Option<ChannelReconciliation> {
        let mut seen = lock_unpoisoned(&self.seen_channels);
        let first_poll = !seen.initialized;
        let mut new_channels = Vec::new();
        let mut unread_increases = Vec::new();
        for channel in current {
            let unread = channel.unread.unwrap_or(0);
            match seen.unread_by_id.get(&channel.channel_id) {
                None => {
                    new_channels.push(channel.clone());
                    if unread > 0 {
                        unread_increases.push((channel.channel_id.clone(), unread));
                    }
                }
                Some(previous) if unread > *previous => {
                    unread_increases.push((channel.channel_id.clone(), unread));
                }
                _ => {}
            }
        }
        seen.unread_by_id = current
            .iter()
            .map(|channel| (channel.channel_id.clone(), channel.unread.unwrap_or(0)))
            .collect();
        seen.initialized = true;
        (!first_poll).then_some((new_channels, unread_increases))
    }

    pub(crate) fn active_thread_descriptor(&self) -> Option<ActiveThreadDescriptor> {
        let active = lock_unpoisoned(&self.active_thread);
        active
            .root_event_id
            .clone()
            .map(|root_event_id| ActiveThreadDescriptor {
                root_event_id,
                scope: active.scope.clone(),
                channel_id: active.channel_id.clone(),
                with_person_uid: active.with_person_uid.clone(),
            })
    }

    /// Mark and return replies that are genuinely new for the still-active
    /// descriptor. State advances before the caller publishes any event.
    pub(crate) fn reconcile_thread_replies(
        &self,
        root_event_id: &str,
        replies: &[hq_desktop_core::dm_notify::ThreadReply],
    ) -> Vec<hq_desktop_core::dm_notify::ThreadReply> {
        let mut active = lock_unpoisoned(&self.active_thread);
        if active.root_event_id.as_deref() != Some(root_event_id) {
            return Vec::new();
        }
        let fresh = replies
            .iter()
            .filter(|reply| !active.seen_reply_ids.contains(&reply.event_id))
            .cloned()
            .collect::<Vec<_>>();
        active
            .seen_reply_ids
            .extend(fresh.iter().map(|reply| reply.event_id.clone()));
        fresh
    }

    pub(crate) fn active_conversation_descriptor(&self) -> Option<ActiveConversationDescriptor> {
        let active = lock_unpoisoned(&self.active_conversation);
        active
            .scope
            .clone()
            .filter(|_| !active.message_ids.is_empty())
            .map(|scope| ActiveConversationDescriptor {
                scope,
                message_ids: active.message_ids.clone(),
            })
    }

    /// Record a reaction aggregate snapshot only if the fetched descriptor is
    /// still active. Returns true exactly when the UI needs reconciliation.
    pub(crate) fn reconcile_conversation_reactions(
        &self,
        scope: &str,
        message_id: &str,
        snapshot: String,
    ) -> bool {
        let mut active = lock_unpoisoned(&self.active_conversation);
        if active.scope.as_deref() != Some(scope)
            || !active.message_ids.iter().any(|id| id == message_id)
        {
            return false;
        }
        if active.last_seen.get(message_id) == Some(&snapshot) {
            return false;
        }
        active.last_seen.insert(message_id.to_string(), snapshot);
        true
    }

    pub(crate) fn watched_share_ids(&self) -> Vec<String> {
        lock_unpoisoned(&self.watched_shares).event_ids.clone()
    }

    pub(crate) fn reconcile_share_reactions(&self, event_id: &str, snapshot: String) -> bool {
        let mut watched = lock_unpoisoned(&self.watched_shares);
        if !watched.event_ids.iter().any(|id| id == event_id) {
            return false;
        }
        if watched.last_seen.get(event_id) == Some(&snapshot) {
            return false;
        }
        watched.last_seen.insert(event_id.to_string(), snapshot);
        true
    }

    pub(crate) fn append_activity(&self, entry: hq_desktop_core::activity::ActivityEntry) {
        let mut activity = lock_unpoisoned(&self.activity);
        activity.push(entry);
        let overflow = activity.len().saturating_sub(MAX_ACTIVITY_ENTRIES);
        if overflow > 0 {
            activity.drain(0..overflow);
        }
    }

    pub(crate) fn activity_snapshot(&self) -> Vec<hq_desktop_core::activity::ActivityEntry> {
        lock_unpoisoned(&self.activity).clone()
    }

    pub(crate) fn reconcile_new_files(
        &self,
        event: &hq_desktop_core::events::SyncNewFilesEvent,
    ) -> Vec<hq_desktop_core::activity::ActivityEntry> {
        let mut activity = lock_unpoisoned(&self.activity);
        hq_desktop_core::activity::apply_new_files(&mut activity, event);
        activity.clone()
    }

    pub(crate) fn unread_dms(&self) -> u32 {
        *lock_unpoisoned(&self.unread_dms)
    }

    pub(crate) fn bump_unread_dms(&self, delta: u32) -> u32 {
        let mut unread = lock_unpoisoned(&self.unread_dms);
        *unread = unread.saturating_add(delta);
        *unread
    }

    fn reset_unread_dms(&self) {
        *lock_unpoisoned(&self.unread_dms) = 0;
    }

    fn set_active_conversation(&self, scope: Option<String>, message_ids: Vec<String>) {
        let mut active = lock_unpoisoned(&self.active_conversation);
        match scope {
            Some(scope) if active.scope.as_deref() == Some(scope.as_str()) => {
                for message_id in message_ids {
                    if !active.message_ids.contains(&message_id) {
                        active.message_ids.push(message_id);
                    }
                }
            }
            Some(scope) => {
                active.scope = Some(scope);
                active.message_ids = message_ids;
                active.last_seen.clear();
            }
            None => *active = ActiveConversationSession::default(),
        }
    }

    fn set_active_thread(
        &self,
        root_event_id: Option<String>,
        scope: Option<String>,
        channel_id: Option<String>,
        with_person_uid: Option<String>,
        seen_reply_ids: Vec<String>,
    ) {
        let mut active = lock_unpoisoned(&self.active_thread);
        match root_event_id {
            Some(root_event_id) => {
                active.root_event_id = Some(root_event_id);
                active.scope =
                    hq_desktop_core::dm_notify::normalize_scope(scope.as_deref().unwrap_or("dm"));
                active.channel_id = channel_id;
                active.with_person_uid = with_person_uid;
                active.seen_reply_ids = seen_reply_ids.into_iter().collect();
            }
            None => *active = ActiveThreadSession::default(),
        }
    }

    fn set_watched_shares(&self, event_ids: Vec<String>) {
        let mut watched = lock_unpoisoned(&self.watched_shares);
        watched
            .last_seen
            .retain(|event_id, _| event_ids.contains(event_id));
        watched.event_ids = event_ids;
    }

    #[cfg(test)]
    fn active_conversation_snapshot(&self) -> (Option<String>, Vec<String>) {
        let active = lock_unpoisoned(&self.active_conversation);
        (active.scope.clone(), active.message_ids.clone())
    }

    #[cfg(test)]
    fn active_thread_snapshot(&self) -> Option<ActiveThreadSnapshot> {
        let active = lock_unpoisoned(&self.active_thread);
        active.root_event_id.clone().map(|root_event_id| {
            (
                root_event_id,
                active.scope.clone(),
                active.channel_id.clone(),
                active.with_person_uid.clone(),
                active.seen_reply_ids.clone(),
            )
        })
    }
}

pub(crate) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    if method == "begin_reauth" {
        execute_begin_reauth(params, cancellation, &CoreAuthRuntime, &|name, payload| {
            backend.emit_domain_event(None, name, payload);
        })
    } else if method == "set_workspace_sync_enabled" {
        set_workspace_sync_enabled_at(
            backend.session_orchestration_state(),
            &backend.menubar_path()?,
            params,
            cancellation,
        )
    } else if matches!(method, "get_auth_state" | "sign_out") {
        execute_with_auth(method, params, cancellation, &CoreAuthRuntime)
    } else {
        execute_with_state(
            method,
            params,
            cancellation,
            backend.session_orchestration_state(),
        )
    }
}

fn execute_begin_reauth(
    params: &Value,
    cancellation: &CancellationFlag,
    auth: &impl AuthRuntime,
    emit: &impl Fn(&str, Value),
) -> Result<Value, EngineError> {
    if !params.is_object() {
        return Err(EngineError::new(
            "invalid_params",
            "`begin_reauth` params must be a JSON object",
            false,
        ));
    }
    cancellation.check()?;
    auth.sign_out()?;
    // Once credentials are cleared, always notify the native shell. The Swift
    // subscriber owns bringing forward its AppKit popover/sign-in surface.
    emit("auth:reauth-required", Value::Null);
    Ok(Value::Null)
}

fn set_workspace_sync_enabled_at(
    state: &SessionOrchestrationState,
    path: &std::path::Path,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let params = params.as_object().ok_or_else(|| {
        invalid_params("`set_workspace_sync_enabled` params must be a JSON object")
    })?;
    let slug = params
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("`slug` must be a string"))?;
    if slug.trim().is_empty() {
        return Err(invalid_params("workspace slug must not be empty"));
    }
    if slug == "personal" {
        return Err(invalid_params("personal sync is managed through settings"));
    }
    let enabled = params
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_params("`enabled` must be a boolean"))?;
    cancellation.check()?;

    let _guard = lock_unpoisoned(&state.workspace_settings);
    let mut root = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| Value::Object(Default::default()))
    } else {
        Value::Object(Default::default())
    };
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| invalid_params("menubar.json root is not an object"))?;
    let workspace_map = root_object
        .entry("workspaceSyncEnabled".to_string())
        .or_insert_with(|| Value::Object(Default::default()))
        .as_object_mut()
        .ok_or_else(|| invalid_params("workspaceSyncEnabled is not an object"))?;
    workspace_map.insert(slug.to_string(), Value::Bool(enabled));

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            EngineError::new(
                "workspace_sync_write_failed",
                format!("Could not create the settings directory: {error}"),
                true,
            )
        })?;
    }
    hq_desktop_core::projects_local::atomic_write_json(path, &root).map_err(|message| {
        EngineError::new(
            "workspace_sync_write_failed",
            format!("Could not save the workspace sync preference: {message}"),
            true,
        )
    })?;
    Ok(Value::Bool(enabled))
}

trait AuthRuntime {
    fn state(&self) -> Result<hq_desktop_core::cognito::AuthState, EngineError>;
    fn sign_out(&self) -> Result<(), EngineError>;
}

struct CoreAuthRuntime;

impl AuthRuntime for CoreAuthRuntime {
    fn state(&self) -> Result<hq_desktop_core::cognito::AuthState, EngineError> {
        auth_runtime()?.block_on(async {
            let Some(tokens) = hq_desktop_core::cognito::get_tokens()
                .await
                .map_err(auth_error)?
            else {
                return Ok(hq_desktop_core::cognito::AuthState {
                    authenticated: false,
                    expires_at: None,
                });
            };

            if !hq_desktop_core::cognito::is_expired(&tokens) {
                return Ok(hq_desktop_core::cognito::AuthState {
                    authenticated: true,
                    expires_at: Some(hq_desktop_core::cognito::expires_at_iso(&tokens)),
                });
            }

            match hq_desktop_core::cognito::refresh_access_token(&tokens.refresh_token).await {
                Ok(refreshed) => {
                    let expires_at = hq_desktop_core::cognito::expires_at_iso(&refreshed);
                    hq_desktop_core::cognito::set_tokens(&refreshed)
                        .await
                        .map_err(auth_error)?;
                    Ok(hq_desktop_core::cognito::AuthState {
                        authenticated: true,
                        expires_at: Some(expires_at),
                    })
                }
                Err(_) => Ok(hq_desktop_core::cognito::AuthState {
                    authenticated: false,
                    expires_at: None,
                }),
            }
        })
    }

    fn sign_out(&self) -> Result<(), EngineError> {
        auth_runtime()?
            .block_on(hq_desktop_core::cognito::clear_tokens())
            .map_err(auth_error)
    }
}

fn auth_runtime() -> Result<tokio::runtime::Runtime, EngineError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            EngineError::new(
                "auth_runtime_unavailable",
                format!("Could not initialize local authentication: {error}"),
                true,
            )
        })
}

fn auth_error(message: String) -> EngineError {
    EngineError::new(
        "auth_operation_failed",
        format!("Local authentication could not be updated: {message}"),
        false,
    )
}

fn execute_with_auth(
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    auth: &impl AuthRuntime,
) -> Result<Value, EngineError> {
    if !params.is_object() {
        return Err(EngineError::new(
            "invalid_params",
            format!("`{method}` params must be a JSON object"),
            false,
        ));
    }
    cancellation.check()?;
    match method {
        "get_auth_state" => to_value(auth.state()?),
        "sign_out" => {
            auth.sign_out()?;
            cancellation.check()?;
            Ok(Value::Null)
        }
        _ => Err(EngineError::new(
            "method_not_found",
            format!("Method `{method}` is not implemented"),
            false,
        )),
    }
}

fn execute_with_state(
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    state: &SessionOrchestrationState,
) -> Result<Value, EngineError> {
    let params = params.as_object().ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` params must be a JSON object"),
            false,
        )
    })?;
    cancellation.check()?;
    let output = match method {
        "get_activity_log" => to_value(state.activity_snapshot())?,
        "set_active_conversation" => {
            state.set_active_conversation(
                optional_trimmed(params, "scope")?,
                optional_string_array(params, "messageIds")?,
            );
            Value::Null
        }
        "set_active_thread" => {
            state.set_active_thread(
                optional_trimmed(params, "rootEventId")?,
                optional_trimmed(params, "scope")?,
                optional_trimmed(params, "channelId")?,
                optional_trimmed(params, "withPersonUid")?,
                optional_string_array(params, "seenReplyIds")?,
            );
            Value::Null
        }
        "set_watched_shares" => {
            state.set_watched_shares(required_string_array(params, "eventIds")?);
            Value::Null
        }
        "mark_messages_read" => {
            state.reset_unread_dms();
            Value::Null
        }
        _ => {
            return Err(EngineError::new(
                "method_not_found",
                format!("Method `{method}` is not implemented"),
                false,
            ));
        }
    };
    cancellation.check()?;
    Ok(output)
}

fn optional_trimmed(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty()))
        }
        Some(_) => Err(invalid_params(format!("`{key}` must be a string"))),
    }
}

fn optional_string_array(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => required_string_array(params, key),
    }
}

fn required_string_array(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, EngineError> {
    let values = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_params(format!("`{key}` must be an array of strings")))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .map(str::to_string)
                .ok_or_else(|| invalid_params(format!("`{key}` must contain only strings")))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|values| {
            values
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect()
        })
}

fn invalid_params(message: impl Into<String>) -> EngineError {
    EngineError::new("invalid_params", message, false)
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn try_begin_poll(flag: &AtomicBool) -> Option<RealtimePollLease<'_>> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
        .then_some(RealtimePollLease { flag })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockAuth {
        state: Option<hq_desktop_core::cognito::AuthState>,
        signed_out: std::sync::atomic::AtomicBool,
    }

    impl AuthRuntime for MockAuth {
        fn state(&self) -> Result<hq_desktop_core::cognito::AuthState, EngineError> {
            self.state
                .clone()
                .ok_or_else(|| EngineError::new("auth_state_failed", "missing mock state", false))
        }

        fn sign_out(&self) -> Result<(), EngineError> {
            self.signed_out
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        }
    }

    #[test]
    fn legacy_auth_state_preserves_the_exact_wire_shape() {
        let auth = MockAuth {
            state: Some(hq_desktop_core::cognito::AuthState {
                authenticated: true,
                expires_at: Some("2026-07-27T00:00:00Z".to_string()),
            }),
            ..Default::default()
        };

        let value = execute_with_auth(
            "get_auth_state",
            &Value::Object(Default::default()),
            &CancellationFlag::default(),
            &auth,
        )
        .expect("auth state");

        assert_eq!(
            value,
            serde_json::json!({
                "authenticated": true,
                "expiresAt": "2026-07-27T00:00:00Z"
            })
        );
    }

    #[test]
    fn sign_out_calls_the_persistent_auth_boundary_and_is_cancellable() {
        let auth = MockAuth::default();
        assert_eq!(
            execute_with_auth(
                "sign_out",
                &Value::Object(Default::default()),
                &CancellationFlag::default(),
                &auth,
            )
            .expect("sign out"),
            Value::Null
        );
        assert!(auth.signed_out.load(std::sync::atomic::Ordering::Acquire));

        let cancelled = CancellationFlag::default();
        cancelled.cancel();
        let error = execute_with_auth(
            "sign_out",
            &Value::Object(Default::default()),
            &cancelled,
            &MockAuth::default(),
        )
        .expect_err("cancelled sign out");
        assert_eq!(error.code, "request_cancelled");
    }

    #[test]
    fn active_conversation_merges_same_scope_and_resets_on_scope_change() {
        let state = SessionOrchestrationState::default();
        let cancellation = CancellationFlag::default();

        execute_with_state(
            "set_active_conversation",
            &serde_json::json!({
                "scope": "dm:person-1",
                "messageIds": ["event-1", "event-2"]
            }),
            &cancellation,
            &state,
        )
        .unwrap();
        execute_with_state(
            "set_active_conversation",
            &serde_json::json!({
                "scope": "dm:person-1",
                "messageIds": ["event-2", "event-3", " "]
            }),
            &cancellation,
            &state,
        )
        .unwrap();
        assert_eq!(
            state.active_conversation_snapshot(),
            (
                Some("dm:person-1".to_string()),
                vec![
                    "event-1".to_string(),
                    "event-2".to_string(),
                    "event-3".to_string()
                ]
            )
        );

        execute_with_state(
            "set_active_conversation",
            &serde_json::json!({
                "scope": "chan:launch",
                "messageIds": ["event-4"]
            }),
            &cancellation,
            &state,
        )
        .unwrap();
        assert_eq!(
            state.active_conversation_snapshot(),
            (Some("chan:launch".to_string()), vec!["event-4".to_string()])
        );
    }

    #[test]
    fn thread_and_watched_share_registrations_use_replace_and_clear_semantics() {
        let state = SessionOrchestrationState::default();
        let cancellation = CancellationFlag::default();

        execute_with_state(
            "set_active_thread",
            &serde_json::json!({
                "rootEventId": "root-1",
                "scope": "CHANNEL",
                "channelId": "channel-1",
                "seenReplyIds": ["reply-1", "reply-2"]
            }),
            &cancellation,
            &state,
        )
        .unwrap();
        assert_eq!(
            state.active_thread_snapshot(),
            Some((
                "root-1".to_string(),
                "channel".to_string(),
                Some("channel-1".to_string()),
                None,
                ["reply-1".to_string(), "reply-2".to_string()]
                    .into_iter()
                    .collect()
            ))
        );

        execute_with_state(
            "set_watched_shares",
            &serde_json::json!({"eventIds": ["share-1", " ", "share-2"]}),
            &cancellation,
            &state,
        )
        .unwrap();
        assert_eq!(
            state.watched_share_ids(),
            vec!["share-1".to_string(), "share-2".to_string()]
        );

        execute_with_state(
            "set_active_thread",
            &serde_json::json!({"rootEventId": null}),
            &cancellation,
            &state,
        )
        .unwrap();
        execute_with_state(
            "set_watched_shares",
            &serde_json::json!({"eventIds": []}),
            &cancellation,
            &state,
        )
        .unwrap();
        assert_eq!(state.active_thread_snapshot(), None);
        assert!(state.watched_share_ids().is_empty());
    }

    #[test]
    fn activity_log_is_bounded_serialized_and_cancellable() {
        let state = SessionOrchestrationState::default();
        for index in 0..=MAX_ACTIVITY_ENTRIES {
            state.append_activity(hq_desktop_core::activity::ActivityEntry {
                company: "indigo".to_string(),
                path: format!("knowledge/{index}.md"),
                bytes: index as u64,
                direction: "down".to_string(),
                author: None,
                is_new: None,
                at: index as u64,
            });
        }

        let output = execute_with_state(
            "get_activity_log",
            &serde_json::json!({}),
            &CancellationFlag::default(),
            &state,
        )
        .unwrap();
        let rows = output.as_array().unwrap();
        assert_eq!(rows.len(), MAX_ACTIVITY_ENTRIES);
        assert_eq!(rows[0]["path"], "knowledge/1.md");

        let cancelled = CancellationFlag::default();
        cancelled.cancel();
        let error = execute_with_state(
            "get_activity_log",
            &serde_json::json!({}),
            &cancelled,
            &state,
        )
        .unwrap_err();
        assert_eq!(error.code, "request_cancelled");
    }

    #[test]
    fn sync_activity_records_append_then_reconciles_and_emits_full_list() {
        let root =
            std::env::temp_dir().join(format!("hq-native-activity-{}", uuid::Uuid::new_v4()));
        let backend =
            CoreBackend::with_roots(root.join("hq"), root.join("claude"), root.join("codex"));
        let mut events = backend.event_bus().subscribe();

        backend.record_sync_activity(
            hq_desktop_core::events::EVENT_SYNC_PROGRESS,
            &serde_json::json!({
                "company": "indigo",
                "path": "knowledge/native.md",
                "bytes": 42,
                "direction": "down"
            }),
        );
        let appended = events.try_recv().expect("activity append");
        assert_eq!(appended.name, "activity:append");
        assert_eq!(appended.data["isNew"], Value::Null);

        backend.record_sync_activity(
            hq_desktop_core::events::EVENT_SYNC_NEW_FILES,
            &serde_json::json!({
                "company": "indigo",
                "files": [{
                    "path": "knowledge/native.md",
                    "bytes": 42,
                    "addedBy": "ada@example.test"
                }]
            }),
        );
        let reconciled = events.try_recv().expect("activity list");
        assert_eq!(reconciled.name, "activity:list");
        assert_eq!(reconciled.data[0]["isNew"], true);
        assert_eq!(reconciled.data[0]["author"], "ada@example.test");
    }

    #[test]
    fn unread_counter_saturates_and_native_mark_read_resets_it() {
        let state = SessionOrchestrationState::default();
        assert_eq!(state.bump_unread_dms(u32::MAX), u32::MAX);
        assert_eq!(state.bump_unread_dms(1), u32::MAX);

        assert_eq!(
            execute_with_state(
                "mark_messages_read",
                &serde_json::json!({}),
                &CancellationFlag::default(),
                &state,
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(state.unread_dms(), 0);
    }

    #[test]
    fn begin_reauth_signs_out_then_emits_the_exact_null_payload() {
        let auth = MockAuth::default();
        let emitted = Mutex::new(Vec::<(String, Value)>::new());

        assert_eq!(
            execute_begin_reauth(
                &Value::Object(Default::default()),
                &CancellationFlag::default(),
                &auth,
                &|name, payload| emitted.lock().unwrap().push((name.to_string(), payload)),
            )
            .expect("begin reauth"),
            Value::Null
        );
        assert!(auth.signed_out.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            *emitted.lock().unwrap(),
            [("auth:reauth-required".to_string(), Value::Null)]
        );
    }

    #[test]
    fn begin_reauth_cancellation_prevents_sign_out_and_event_delivery() {
        let auth = MockAuth::default();
        let emitted = Mutex::new(Vec::<(String, Value)>::new());
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_begin_reauth(
            &Value::Object(Default::default()),
            &cancellation,
            &auth,
            &|name, payload| emitted.lock().unwrap().push((name.to_string(), payload)),
        )
        .expect_err("cancelled");

        assert_eq!(error.code, "request_cancelled");
        assert!(!auth.signed_out.load(std::sync::atomic::Ordering::Acquire));
        assert!(emitted.lock().unwrap().is_empty());
    }

    #[test]
    fn workspace_sync_toggle_preserves_unrelated_settings_and_round_trips_bool() {
        let root =
            std::env::temp_dir().join(format!("hq-workspace-toggle-{}", uuid::Uuid::new_v4()));
        let path = root.join(".hq").join("menubar.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"hqPath":"/tmp/HQ","future":{"nested":1},"workspaceSyncEnabled":{"acme":true}}"#,
        )
        .unwrap();
        let state = SessionOrchestrationState::default();

        assert_eq!(
            set_workspace_sync_enabled_at(
                &state,
                &path,
                &serde_json::json!({"slug": "acme", "enabled": false}),
                &CancellationFlag::default(),
            )
            .unwrap(),
            Value::Bool(false)
        );
        assert_eq!(
            set_workspace_sync_enabled_at(
                &state,
                &path,
                &serde_json::json!({"slug": "zeta", "enabled": true}),
                &CancellationFlag::default(),
            )
            .unwrap(),
            Value::Bool(true)
        );

        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["hqPath"], "/tmp/HQ");
        assert_eq!(saved["future"]["nested"], 1);
        assert_eq!(saved["workspaceSyncEnabled"]["acme"], false);
        assert_eq!(saved["workspaceSyncEnabled"]["zeta"], true);
    }

    #[test]
    fn workspace_sync_toggle_rejects_empty_and_personal_without_writing() {
        let root =
            std::env::temp_dir().join(format!("hq-workspace-toggle-{}", uuid::Uuid::new_v4()));
        let path = root.join(".hq").join("menubar.json");
        let state = SessionOrchestrationState::default();

        for params in [
            serde_json::json!({"slug": " ", "enabled": true}),
            serde_json::json!({"slug": "personal", "enabled": false}),
        ] {
            let error =
                set_workspace_sync_enabled_at(&state, &path, &params, &CancellationFlag::default())
                    .expect_err("invalid workspace toggle");
            assert_eq!(error.code, "invalid_params");
        }
        assert!(!path.exists());
    }
}
