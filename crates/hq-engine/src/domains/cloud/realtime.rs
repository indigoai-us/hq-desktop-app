//! Authenticated realtime collaboration polling for the native engine.

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::{ensure_success, request, CloudContext, CloudTransport, HttpVerb};
use crate::domains::local::CoreBackend;
use crate::domains::orchestration::SessionOrchestrationState;
use crate::{CancellationFlag, EngineError};

const EVENT_DM_NEW_EVENTS: &str = "dm:new-events";
const EVENT_DM_UNREAD_SUMMARY: &str = "dm:unread-summary";
const EVENT_DM_REQUEST_NEW: &str = "dm:request-new";
const EVENT_DM_REQUEST_UPDATE: &str = "dm:request-update";
const EVENT_CHANNEL_NEW_MESSAGE: &str = "channel:new-message";
const EVENT_CHANNEL_UPDATED: &str = "channel:updated";
const EVENT_THREAD_NEW_REPLY: &str = "thread:new-reply";
const EVENT_MESSAGE_REACTION: &str = "message:reaction";
const EVENT_SHARE_EVENTS_LIST: &str = "share:events-list";

trait RealtimePersistence {
    fn machine_id(&self) -> Result<String, EngineError>;
    fn dm_notifications_enabled(&self) -> bool;
    fn share_notifications_enabled(&self) -> bool;
    fn load_dm_cursor(
        &self,
        machine_id: &str,
    ) -> Result<hq_desktop_core::dm_notify::CursorEntry, EngineError>;
    fn save_dm_cursor(
        &self,
        machine_id: &str,
        entry: &hq_desktop_core::dm_notify::CursorEntry,
    ) -> Result<(), EngineError>;
    fn load_share_cursor(
        &self,
        machine_id: &str,
    ) -> Result<hq_desktop_core::share_notify::CursorEntry, EngineError>;
    fn save_share_cursor(
        &self,
        machine_id: &str,
        entry: &hq_desktop_core::share_notify::CursorEntry,
    ) -> Result<(), EngineError>;
}

trait RealtimeEventSink {
    fn emit(&self, name: &'static str, data: Value);
}

struct CoreRealtimePersistence;

static DM_CURSOR_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SHARE_CURSOR_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

impl RealtimePersistence for CoreRealtimePersistence {
    fn machine_id(&self) -> Result<String, EngineError> {
        hq_desktop_core::config::ensure_machine_id().map_err(|message| {
            EngineError::new(
                "realtime_machine_id_unavailable",
                format!("Could not resolve this Mac's collaboration identity: {message}"),
                false,
            )
        })
    }

    fn dm_notifications_enabled(&self) -> bool {
        hq_desktop_core::dm_notify::dm_notifications_enabled()
    }

    fn share_notifications_enabled(&self) -> bool {
        let preference = hq_desktop_core::paths::hq_config_dir()
            .ok()
            .and_then(|directory| std::fs::read_to_string(directory.join("menubar.json")).ok())
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|settings| settings.get("shareNotifications").and_then(Value::as_bool));
        hq_desktop_core::share_notify::share_notifications_enabled(preference)
    }

    fn load_dm_cursor(
        &self,
        machine_id: &str,
    ) -> Result<hq_desktop_core::dm_notify::CursorEntry, EngineError> {
        let _guard = cursor_lock(&DM_CURSOR_LOCK);
        Ok(hq_desktop_core::dm_notify::read_cursor_store()
            .remove(machine_id)
            .unwrap_or_default())
    }

    fn save_dm_cursor(
        &self,
        machine_id: &str,
        entry: &hq_desktop_core::dm_notify::CursorEntry,
    ) -> Result<(), EngineError> {
        let _guard = cursor_lock(&DM_CURSOR_LOCK);
        let path = hq_desktop_core::dm_notify::cursor_path().map_err(cursor_path_error)?;
        let mut store = hq_desktop_core::dm_notify::read_cursor_store();
        store.insert(machine_id.to_string(), entry.clone());
        save_cursor_store(&path, &store)
    }

    fn load_share_cursor(
        &self,
        machine_id: &str,
    ) -> Result<hq_desktop_core::share_notify::CursorEntry, EngineError> {
        let _guard = cursor_lock(&SHARE_CURSOR_LOCK);
        Ok(hq_desktop_core::share_notify::read_cursor_store()
            .remove(machine_id)
            .unwrap_or_default())
    }

    fn save_share_cursor(
        &self,
        machine_id: &str,
        entry: &hq_desktop_core::share_notify::CursorEntry,
    ) -> Result<(), EngineError> {
        let _guard = cursor_lock(&SHARE_CURSOR_LOCK);
        let path = hq_desktop_core::share_notify::cursor_path().map_err(cursor_path_error)?;
        let mut store = hq_desktop_core::share_notify::read_cursor_store();
        store.insert(machine_id.to_string(), entry.clone());
        save_cursor_store(&path, &store)
    }
}

struct BackendEventSink<'a>(&'a CoreBackend);

impl RealtimeEventSink for BackendEventSink<'_> {
    fn emit(&self, name: &'static str, data: Value) {
        self.0.emit_domain_event(None, name, data);
    }
}

pub(super) fn handles(method: &str) -> bool {
    matches!(method, "poll_dm_inbox" | "poll_shared_with_me")
}

pub(super) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    if !params.is_object() {
        return Err(EngineError::new(
            "invalid_params",
            format!("`{method}` params must be a JSON object"),
            false,
        ));
    }
    let persistence = CoreRealtimePersistence;
    let events = BackendEventSink(backend);
    match method {
        "poll_dm_inbox" => poll_dm_inbox_with(
            backend.session_orchestration_state(),
            cancellation,
            context,
            transport,
            &persistence,
            &events,
        ),
        "poll_shared_with_me" => poll_shared_with_me_with(
            backend.session_orchestration_state(),
            cancellation,
            context,
            transport,
            &persistence,
            &events,
        ),
        _ => Err(EngineError::new(
            "method_not_found",
            format!("Realtime cloud method `{method}` is not implemented"),
            false,
        )),
    }
}

fn poll_dm_inbox_with(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    persistence: &dyn RealtimePersistence,
    events: &dyn RealtimeEventSink,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    if !persistence.dm_notifications_enabled() {
        return Ok(Value::Null);
    }
    let Some(_lease) = state.try_begin_dm_poll() else {
        return Ok(Value::Null);
    };
    let machine_id = persistence.machine_id()?;
    let base = context.base_url.trim_end_matches('/');

    poll_requests(state, cancellation, context, transport, events)?;
    poll_channels(state, cancellation, context, transport, events)?;
    poll_active_thread(state, cancellation, context, transport, events)?;
    poll_conversation_reactions(state, cancellation, context, transport, events)?;
    poll_share_reactions(state, cancellation, context, transport, events)?;

    let entry = persistence.load_dm_cursor(&machine_id)?;
    let url = entry.cursor.as_deref().map_or_else(
        || format!("{base}/v1/notify/inbox?limit=50"),
        |since| format!("{base}/v1/notify/inbox?since={since}&limit=50"),
    );
    let Some(inbox) = best_effort(
        fetch::<hq_desktop_core::dm_notify::InboxResponse>(url, cancellation, context, transport),
        cancellation,
    )?
    else {
        return Ok(Value::Null);
    };
    if inbox.events.is_empty() {
        return Ok(Value::Null);
    }

    let newest = inbox
        .events
        .iter()
        .map(|event| event.created_at.as_str())
        .max()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(entry.cursor.clone());
    let (fresh, notified) =
        hq_desktop_core::dm_notify::partition_unnotified(&inbox.events, &entry.notified);
    cancellation.check()?;
    persistence.save_dm_cursor(
        &machine_id,
        &hq_desktop_core::dm_notify::CursorEntry {
            cursor: newest,
            notified,
        },
    )?;

    if !fresh.is_empty() {
        let unread_dms = state.bump_unread_dms(fresh.len() as u32);
        events.emit(
            EVENT_DM_UNREAD_SUMMARY,
            json!({"unreadDms": unread_dms, "pendingRequests": 0u32}),
        );
        events.emit(EVENT_DM_NEW_EVENTS, crate::to_value(fresh)?);
    }
    Ok(Value::Null)
}

fn poll_shared_with_me_with(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    persistence: &dyn RealtimePersistence,
    events: &dyn RealtimeEventSink,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    if !persistence.share_notifications_enabled() {
        return Ok(Value::Null);
    }
    let Some(_lease) = state.try_begin_share_poll() else {
        return Ok(Value::Null);
    };
    let machine_id = persistence.machine_id()?;
    let entry = persistence.load_share_cursor(&machine_id)?;
    let base = context.base_url.trim_end_matches('/');
    let url = entry.cursor.as_deref().map_or_else(
        || format!("{base}/v1/files/shared-with-me?limit=50"),
        |since| format!("{base}/v1/files/shared-with-me?since={since}&limit=50"),
    );
    let Some(inbox) = best_effort(
        fetch::<hq_desktop_core::share_notify::SharedWithMeResponse>(
            url,
            cancellation,
            context,
            transport,
        ),
        cancellation,
    )?
    else {
        return Ok(Value::Null);
    };
    if inbox.events.is_empty() {
        return Ok(Value::Null);
    }

    let newest = inbox
        .events
        .iter()
        .map(|event| event.created_at.as_str())
        .max()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(entry.cursor.clone());
    let (fresh, notified) =
        hq_desktop_core::share_notify::partition_unnotified(&inbox.events, &entry.notified);
    cancellation.check()?;
    persistence.save_share_cursor(
        &machine_id,
        &hq_desktop_core::share_notify::CursorEntry {
            cursor: newest,
            notified,
        },
    )?;
    if !fresh.is_empty() {
        // Native parity intentionally uses the listed payload-bearing event,
        // not the legacy unlisted `share:new-events` wake.
        events.emit(EVENT_SHARE_EVENTS_LIST, crate::to_value(fresh)?);
    }
    Ok(Value::Null)
}

fn poll_requests(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    events: &dyn RealtimeEventSink,
) -> Result<(), EngineError> {
    let url = format!(
        "{}/v1/notify/connections/requests",
        context.base_url.trim_end_matches('/')
    );
    let Some(response) = best_effort(
        fetch::<hq_desktop_core::dm_notify::RequestsListResponse>(
            url,
            cancellation,
            context,
            transport,
        ),
        cancellation,
    )?
    else {
        return Ok(());
    };
    let Some((new_requests, removed)) = state.reconcile_requests(&response.requests) else {
        return Ok(());
    };
    for request in new_requests {
        events.emit(EVENT_DM_REQUEST_NEW, crate::to_value(request)?);
    }
    for pair_key in removed {
        events.emit(
            EVENT_DM_REQUEST_UPDATE,
            json!({"pairKey": pair_key, "state": "resolved"}),
        );
    }
    Ok(())
}

fn poll_channels(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    events: &dyn RealtimeEventSink,
) -> Result<(), EngineError> {
    let url = format!(
        "{}/v1/notify/channels",
        context.base_url.trim_end_matches('/')
    );
    let Some(response) = best_effort(
        fetch::<hq_desktop_core::messages::ChannelsResponse>(url, cancellation, context, transport),
        cancellation,
    )?
    else {
        return Ok(());
    };
    let Some((new_channels, unread_increases)) = state.reconcile_channels(&response.channels)
    else {
        return Ok(());
    };
    for channel in new_channels {
        events.emit(EVENT_CHANNEL_UPDATED, crate::to_value(channel)?);
    }
    for (channel_id, unread) in unread_increases {
        events.emit(
            EVENT_CHANNEL_NEW_MESSAGE,
            json!({"channelId": channel_id, "unread": unread}),
        );
    }
    Ok(())
}

fn poll_active_thread(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    events: &dyn RealtimeEventSink,
) -> Result<(), EngineError> {
    let Some(descriptor) = state.active_thread_descriptor() else {
        return Ok(());
    };
    let url = hq_desktop_core::dm_notify::build_threads_url(
        context.base_url.trim_end_matches('/'),
        &descriptor.root_event_id,
        &descriptor.scope,
        descriptor.channel_id.as_deref(),
        descriptor.with_person_uid.as_deref(),
    );
    let Some(view) = best_effort(
        fetch::<hq_desktop_core::dm_notify::ThreadView>(url, cancellation, context, transport),
        cancellation,
    )?
    else {
        return Ok(());
    };
    let fresh = state.reconcile_thread_replies(&descriptor.root_event_id, &view.replies);
    for reply in fresh.iter().rev() {
        events.emit(
            EVENT_THREAD_NEW_REPLY,
            json!({
                "rootEventId": descriptor.root_event_id,
                "reply": reply,
                "replyCount": view.reply_count,
            }),
        );
    }
    Ok(())
}

fn poll_conversation_reactions(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    events: &dyn RealtimeEventSink,
) -> Result<(), EngineError> {
    let Some(descriptor) = state.active_conversation_descriptor() else {
        return Ok(());
    };
    for message_id in descriptor.message_ids {
        cancellation.check()?;
        let url = hq_desktop_core::messages::build_reactions_url(
            context.base_url.trim_end_matches('/'),
            &descriptor.scope,
            &message_id,
        );
        let Some(response) = best_effort(
            fetch::<hq_desktop_core::messages::MessageReactions>(
                url,
                cancellation,
                context,
                transport,
            ),
            cancellation,
        )?
        else {
            continue;
        };
        let snapshot = serde_json::to_string(&response.reactions).map_err(|error| {
            EngineError::new(
                "realtime_state_encoding_failed",
                format!("Could not compare reaction state: {error}"),
                false,
            )
        })?;
        if state.reconcile_conversation_reactions(&descriptor.scope, &message_id, snapshot) {
            events.emit(
                EVENT_MESSAGE_REACTION,
                crate::to_value(hq_desktop_core::messages::MessageReactions {
                    message_scope: descriptor.scope.clone(),
                    message_id,
                    reactions: response.reactions,
                })?,
            );
        }
    }
    Ok(())
}

fn poll_share_reactions(
    state: &SessionOrchestrationState,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    events: &dyn RealtimeEventSink,
) -> Result<(), EngineError> {
    for event_id in state.watched_share_ids() {
        cancellation.check()?;
        let scope = format!("share:{event_id}");
        let url = hq_desktop_core::messages::build_reactions_url(
            context.base_url.trim_end_matches('/'),
            &scope,
            &event_id,
        );
        let Some(response) = best_effort(
            fetch::<hq_desktop_core::messages::MessageReactions>(
                url,
                cancellation,
                context,
                transport,
            ),
            cancellation,
        )?
        else {
            continue;
        };
        let snapshot = serde_json::to_string(&response.reactions).map_err(|error| {
            EngineError::new(
                "realtime_state_encoding_failed",
                format!("Could not compare share reaction state: {error}"),
                false,
            )
        })?;
        if state.reconcile_share_reactions(&event_id, snapshot) {
            events.emit(
                EVENT_MESSAGE_REACTION,
                crate::to_value(hq_desktop_core::messages::MessageReactions {
                    message_scope: scope,
                    message_id: event_id,
                    reactions: response.reactions,
                })?,
            );
        }
    }
    Ok(())
}

fn fetch<T: DeserializeOwned>(
    url: String,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<T, EngineError> {
    cancellation.check()?;
    let body =
        ensure_success(transport.send(request(HttpVerb::Get, url, context, None), cancellation)?)?;
    cancellation.check()?;
    serde_json::from_value(body).map_err(|error| {
        EngineError::new(
            "cloud_response_invalid",
            format!("HQ realtime collaboration returned invalid data: {error}"),
            false,
        )
    })
}

fn best_effort<T>(
    result: Result<T, EngineError>,
    cancellation: &CancellationFlag,
) -> Result<Option<T>, EngineError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code == "request_cancelled" => Err(error),
        Err(_) => {
            cancellation.check()?;
            Ok(None)
        }
    }
}

fn cursor_lock(lock: &'static OnceLock<Mutex<()>>) -> MutexGuard<'static, ()> {
    lock.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cursor_path_error(message: String) -> EngineError {
    EngineError::new(
        "realtime_cursor_path_unavailable",
        format!("Could not resolve collaboration cursor storage: {message}"),
        false,
    )
}

fn save_cursor_store(
    path: &std::path::Path,
    store: &impl serde::Serialize,
) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            EngineError::new(
                "realtime_cursor_write_failed",
                format!("Could not create collaboration cursor storage: {error}"),
                true,
            )
        })?;
    }
    let value = serde_json::to_value(store).map_err(|error| {
        EngineError::new(
            "realtime_cursor_write_failed",
            format!("Could not encode collaboration cursor state: {error}"),
            false,
        )
    })?;
    hq_desktop_core::projects_local::atomic_write_json(path, &value).map_err(|message| {
        EngineError::new(
            "realtime_cursor_write_failed",
            format!("Could not durably save collaboration cursor state: {message}"),
            true,
        )
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::domains::cloud::{CloudRequest, CloudResponse};

    #[derive(Debug, Clone, PartialEq)]
    struct CapturedEvent {
        name: String,
        data: Value,
    }

    #[derive(Default)]
    struct MockEventSink {
        captured: Mutex<Vec<CapturedEvent>>,
        order: Arc<Mutex<Vec<String>>>,
    }

    impl MockEventSink {
        fn with_order(order: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                captured: Mutex::default(),
                order,
            }
        }

        fn captured(&self) -> Vec<CapturedEvent> {
            self.captured.lock().unwrap().clone()
        }
    }

    impl RealtimeEventSink for MockEventSink {
        fn emit(&self, name: &'static str, data: Value) {
            self.order.lock().unwrap().push(format!("event:{name}"));
            self.captured.lock().unwrap().push(CapturedEvent {
                name: name.to_string(),
                data,
            });
        }
    }

    #[derive(Default)]
    struct MockPersistence {
        machine_id: String,
        dm_enabled: bool,
        share_enabled: bool,
        dm: Mutex<HashMap<String, hq_desktop_core::dm_notify::CursorEntry>>,
        shares: Mutex<HashMap<String, hq_desktop_core::share_notify::CursorEntry>>,
        fail_dm_save: bool,
        order: Arc<Mutex<Vec<String>>>,
    }

    impl MockPersistence {
        fn enabled(order: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                machine_id: "machine-1".to_string(),
                dm_enabled: true,
                share_enabled: true,
                order,
                ..Default::default()
            }
        }
    }

    impl RealtimePersistence for MockPersistence {
        fn machine_id(&self) -> Result<String, EngineError> {
            Ok(self.machine_id.clone())
        }

        fn dm_notifications_enabled(&self) -> bool {
            self.dm_enabled
        }

        fn share_notifications_enabled(&self) -> bool {
            self.share_enabled
        }

        fn load_dm_cursor(
            &self,
            machine_id: &str,
        ) -> Result<hq_desktop_core::dm_notify::CursorEntry, EngineError> {
            Ok(self
                .dm
                .lock()
                .unwrap()
                .get(machine_id)
                .cloned()
                .unwrap_or_default())
        }

        fn save_dm_cursor(
            &self,
            machine_id: &str,
            entry: &hq_desktop_core::dm_notify::CursorEntry,
        ) -> Result<(), EngineError> {
            if self.fail_dm_save {
                return Err(EngineError::new(
                    "realtime_cursor_write_failed",
                    "mock cursor write failed",
                    true,
                ));
            }
            self.dm
                .lock()
                .unwrap()
                .insert(machine_id.to_string(), entry.clone());
            self.order.lock().unwrap().push("persist:dm".to_string());
            Ok(())
        }

        fn load_share_cursor(
            &self,
            machine_id: &str,
        ) -> Result<hq_desktop_core::share_notify::CursorEntry, EngineError> {
            Ok(self
                .shares
                .lock()
                .unwrap()
                .get(machine_id)
                .cloned()
                .unwrap_or_default())
        }

        fn save_share_cursor(
            &self,
            machine_id: &str,
            entry: &hq_desktop_core::share_notify::CursorEntry,
        ) -> Result<(), EngineError> {
            self.shares
                .lock()
                .unwrap()
                .insert(machine_id.to_string(), entry.clone());
            self.order.lock().unwrap().push("persist:share".to_string());
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockTransport {
        requests: Mutex<Vec<CloudRequest>>,
        responses: Mutex<VecDeque<Result<CloudResponse, EngineError>>>,
    }

    impl MockTransport {
        fn returning(responses: impl IntoIterator<Item = CloudResponse>) -> Self {
            Self {
                requests: Mutex::default(),
                responses: Mutex::new(responses.into_iter().map(Ok).collect()),
            }
        }

        fn returning_results(
            responses: impl IntoIterator<Item = Result<CloudResponse, EngineError>>,
        ) -> Self {
            Self {
                requests: Mutex::default(),
                responses: Mutex::new(responses.into_iter().collect()),
            }
        }

        fn requests(&self) -> Vec<CloudRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl CloudTransport for MockTransport {
        fn send(
            &self,
            request: CloudRequest,
            cancellation: &CancellationFlag,
        ) -> Result<CloudResponse, EngineError> {
            cancellation.check()?;
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("mock response")
        }
    }

    fn context() -> CloudContext {
        CloudContext {
            base_url: "https://vault.example.test/".to_string(),
            access_token: "secret-bearer".to_string(),
        }
    }

    fn ok(body: Value) -> CloudResponse {
        CloudResponse { status: 200, body }
    }

    fn empty_requests() -> CloudResponse {
        ok(json!({"requests": []}))
    }

    fn empty_channels() -> CloudResponse {
        ok(json!({"channels": []}))
    }

    fn empty_inbox() -> CloudResponse {
        ok(json!({"events": [], "nextCursor": null}))
    }

    #[test]
    fn dm_poll_seeds_request_and_channel_state_and_persists_before_emitting() {
        let transport = MockTransport::returning([
            ok(json!({
                "requests": [{
                    "pairKey": "pair-existing",
                    "fromPersonUid": "person-1",
                    "fromEmail": "ada@example.test",
                    "fromDisplayName": "Ada",
                    "createdAt": "2026-07-26T20:00:00Z"
                }]
            })),
            ok(json!({
                "channels": [{
                    "channelId": "channel-existing",
                    "name": "Launch",
                    "scope": "company",
                    "unread": 4
                }]
            })),
            ok(json!({
                "events": [{
                    "eventId": "dm-1",
                    "fromPersonUid": "person-2",
                    "fromEmail": "grace@example.test",
                    "fromDisplayName": "Grace",
                    "body": "Native hello",
                    "createdAt": "2026-07-26T21:00:00Z"
                }],
                "nextCursor": null
            })),
        ]);
        let state = SessionOrchestrationState::default();
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order.clone());

        assert_eq!(
            poll_dm_inbox_with(
                &state,
                &CancellationFlag::default(),
                &context(),
                &transport,
                &persistence,
                &events,
            )
            .unwrap(),
            Value::Null
        );

        assert_eq!(
            events
                .captured()
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            ["dm:unread-summary", "dm:new-events"]
        );
        assert_eq!(
            *order.lock().unwrap(),
            [
                "persist:dm",
                "event:dm:unread-summary",
                "event:dm:new-events"
            ]
        );
        assert_eq!(
            persistence
                .dm
                .lock()
                .unwrap()
                .get("machine-1")
                .unwrap()
                .notified,
            ["dm-1"]
        );
        assert_eq!(
            transport
                .requests()
                .iter()
                .map(|request| request.url.as_str())
                .collect::<Vec<_>>(),
            [
                "https://vault.example.test/v1/notify/connections/requests",
                "https://vault.example.test/v1/notify/channels",
                "https://vault.example.test/v1/notify/inbox?limit=50"
            ]
        );
    }

    #[test]
    fn dm_poll_diffs_requests_and_channels_only_after_the_seed_poll() {
        let transport = MockTransport::returning([
            ok(json!({
                "requests": [{
                    "pairKey": "pair-old",
                    "fromPersonUid": "person-old",
                    "fromEmail": "old@example.test",
                    "fromDisplayName": "Old",
                    "createdAt": "2026-07-26T18:00:00Z"
                }]
            })),
            ok(json!({
                "channels": [{
                    "channelId": "channel-1",
                    "name": "One",
                    "scope": "company",
                    "unread": 1
                }]
            })),
            empty_inbox(),
            ok(json!({
                "requests": [{
                    "pairKey": "pair-new",
                    "fromPersonUid": "person-new",
                    "fromEmail": "new@example.test",
                    "fromDisplayName": "New",
                    "createdAt": "2026-07-26T22:00:00Z"
                }]
            })),
            ok(json!({
                "channels": [{
                    "channelId": "channel-1",
                    "name": "One",
                    "scope": "company",
                    "unread": 3
                }, {
                    "channelId": "channel-2",
                    "name": "Two",
                    "scope": "company",
                    "unread": 2
                }]
            })),
            empty_inbox(),
        ]);
        let state = SessionOrchestrationState::default();
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order);

        poll_dm_inbox_with(
            &state,
            &CancellationFlag::default(),
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap();
        assert!(events.captured().is_empty());

        poll_dm_inbox_with(
            &state,
            &CancellationFlag::default(),
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap();

        let captured = events.captured();
        assert_eq!(
            captured
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            [
                "dm:request-new",
                "dm:request-update",
                "channel:updated",
                "channel:new-message",
                "channel:new-message"
            ]
        );
        assert_eq!(
            captured[1].data,
            json!({"pairKey": "pair-old", "state": "resolved"})
        );
        assert_eq!(captured[2].data["channelId"], "channel-2");
    }

    #[test]
    fn share_poll_emits_the_parity_list_event_after_durable_dedupe() {
        let transport = MockTransport::returning([ok(json!({
            "events": [{
                "eventId": "share-1",
                "issuerEmail": "ada@example.test",
                "issuerDisplayName": "Ada",
                "issuerPersonUid": "person-1",
                "paths": ["knowledge/native.md"],
                "note": "Review",
                "permission": "write",
                "createdAt": "2026-07-26T21:30:00Z"
            }],
            "nextCursor": null
        }))]);
        let state = SessionOrchestrationState::default();
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order.clone());

        poll_shared_with_me_with(
            &state,
            &CancellationFlag::default(),
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap();

        assert_eq!(
            events.captured(),
            [CapturedEvent {
                name: "share:events-list".to_string(),
                data: json!([{
                    "eventId": "share-1",
                    "issuerEmail": "ada@example.test",
                    "issuerDisplayName": "Ada",
                    "issuerPersonUid": "person-1",
                    "paths": ["knowledge/native.md"],
                    "note": "Review",
                    "permission": "write",
                    "createdAt": "2026-07-26T21:30:00Z"
                }])
            }]
        );
        assert_eq!(
            *order.lock().unwrap(),
            ["persist:share", "event:share:events-list"]
        );
    }

    #[test]
    fn cursor_write_failure_prevents_dm_event_delivery() {
        let transport = MockTransport::returning([
            empty_requests(),
            empty_channels(),
            ok(json!({
                "events": [{
                    "eventId": "dm-1",
                    "fromPersonUid": "person-1",
                    "fromEmail": "ada@example.test",
                    "fromDisplayName": "Ada",
                    "body": "Do not lose this",
                    "createdAt": "2026-07-26T21:00:00Z"
                }],
                "nextCursor": null
            })),
        ]);
        let state = SessionOrchestrationState::default();
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence {
            fail_dm_save: true,
            ..MockPersistence::enabled(order.clone())
        };
        let events = MockEventSink::with_order(order);

        let error = poll_dm_inbox_with(
            &state,
            &CancellationFlag::default(),
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap_err();

        assert_eq!(error.code, "realtime_cursor_write_failed");
        assert!(events.captured().is_empty());
    }

    #[test]
    fn cancellation_and_network_failures_are_isolated_and_never_expose_tokens() {
        let state = SessionOrchestrationState::default();
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order);
        let cancelled = CancellationFlag::default();
        cancelled.cancel();
        let no_network = MockTransport::default();

        let error = poll_dm_inbox_with(
            &state,
            &cancelled,
            &context(),
            &no_network,
            &persistence,
            &events,
        )
        .unwrap_err();
        assert_eq!(error.code, "request_cancelled");
        assert!(no_network.requests().is_empty());

        let failing = MockTransport::returning_results([
            Err(EngineError::new(
                "cloud_network_error",
                "request network unavailable",
                true,
            )),
            Err(EngineError::new(
                "cloud_network_error",
                "channel network unavailable",
                true,
            )),
            Err(EngineError::new(
                "cloud_network_error",
                "inbox network unavailable",
                true,
            )),
        ]);
        let output = poll_dm_inbox_with(
            &state,
            &CancellationFlag::default(),
            &context(),
            &failing,
            &persistence,
            &events,
        )
        .unwrap();
        assert_eq!(output, Value::Null);
        assert!(!format!("{output:?}").contains("secret-bearer"));
        assert!(events.captured().is_empty());
    }

    #[test]
    fn single_dm_path_reconciles_thread_and_conversation_and_share_reactions() {
        let root =
            std::env::temp_dir().join(format!("hq-native-realtime-{}", uuid::Uuid::new_v4()));
        let backend =
            CoreBackend::with_roots(root.join("hq"), root.join("claude"), root.join("codex"));
        let cancellation = CancellationFlag::default();
        crate::domains::orchestration::execute(
            &backend,
            "set_active_thread",
            &json!({
                "rootEventId": "root-1",
                "scope": "dm",
                "withPersonUid": "person-1",
                "seenReplyIds": []
            }),
            &cancellation,
        )
        .unwrap();
        crate::domains::orchestration::execute(
            &backend,
            "set_active_conversation",
            &json!({
                "scope": "dm:person-1",
                "messageIds": ["dm-1"]
            }),
            &cancellation,
        )
        .unwrap();
        crate::domains::orchestration::execute(
            &backend,
            "set_watched_shares",
            &json!({"eventIds": ["share-1"]}),
            &cancellation,
        )
        .unwrap();

        let one_cycle = || {
            [
                empty_requests(),
                empty_channels(),
                ok(json!({
                    "root": {
                        "eventId": "root-1",
                        "fromPersonUid": "person-1",
                        "body": "Root",
                        "createdAt": "2026-07-26T20:00:00Z"
                    },
                    "replies": [{
                        "eventId": "reply-newest",
                        "fromPersonUid": "person-1",
                        "body": "Newest",
                        "createdAt": "2026-07-26T21:02:00Z"
                    }, {
                        "eventId": "reply-oldest",
                        "fromPersonUid": "person-1",
                        "body": "Oldest",
                        "createdAt": "2026-07-26T21:01:00Z"
                    }],
                    "replyCount": 2
                })),
                ok(json!({
                    "messageScope": "dm:person-1",
                    "messageId": "dm-1",
                    "reactions": [{
                        "emoji": "👍",
                        "count": 2,
                        "reactedByMe": true
                    }]
                })),
                ok(json!({
                    "messageScope": "share:share-1",
                    "messageId": "share-1",
                    "reactions": [{
                        "emoji": "✅",
                        "count": 1,
                        "reactedByMe": false
                    }]
                })),
                empty_inbox(),
            ]
        };
        let transport = MockTransport::returning(one_cycle().into_iter().chain(one_cycle()));
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order);

        poll_dm_inbox_with(
            backend.session_orchestration_state(),
            &cancellation,
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap();

        let first = events.captured();
        assert_eq!(
            first
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            [
                "thread:new-reply",
                "thread:new-reply",
                "message:reaction",
                "message:reaction"
            ]
        );
        assert_eq!(first[0].data["reply"]["eventId"], "reply-oldest");
        assert_eq!(first[1].data["reply"]["eventId"], "reply-newest");
        assert_eq!(first[0].data["replyCount"], 2);
        assert_eq!(first[2].data["messageScope"], "dm:person-1");
        assert_eq!(first[2].data["messageId"], "dm-1");
        assert_eq!(first[3].data["messageScope"], "share:share-1");
        assert_eq!(first[3].data["messageId"], "share-1");

        poll_dm_inbox_with(
            backend.session_orchestration_state(),
            &cancellation,
            &context(),
            &transport,
            &persistence,
            &events,
        )
        .unwrap();
        assert_eq!(
            events.captured().len(),
            first.len(),
            "unchanged thread replies and reaction aggregates must not replay"
        );
    }

    #[test]
    fn per_backend_poll_leases_skip_overlap_without_cross_kind_contention() {
        let state = SessionOrchestrationState::default();
        let dm_lease = state.try_begin_dm_poll().expect("first DM lease");
        assert!(
            state.try_begin_share_poll().is_some(),
            "share polling has an independent in-flight boundary"
        );
        let order = Arc::new(Mutex::new(Vec::new()));
        let persistence = MockPersistence::enabled(order.clone());
        let events = MockEventSink::with_order(order);
        let transport = MockTransport::default();

        assert_eq!(
            poll_dm_inbox_with(
                &state,
                &CancellationFlag::default(),
                &context(),
                &transport,
                &persistence,
                &events,
            )
            .unwrap(),
            Value::Null
        );
        assert!(transport.requests().is_empty());
        drop(dm_lease);
        assert!(state.try_begin_dm_poll().is_some());
    }
}
