//! Direct, Node-free Recall Desktop SDK runtime for native macOS.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::local::CoreBackend;
use crate::{to_value, CancellationFlag, EngineDomainEvent, EngineError, EngineEventBus};

pub(crate) const IMPLEMENTED_METHODS: &[&str] =
    &["start_recall_sdk", "start_recording", "stop_recording"];

const RECALL_API_URL: &str = "https://us-west-2.recall.ai";
const SDK_VERSION: &str = "2.0.15";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const REQUIRED_PERMISSIONS: &[&str] = &[
    "accessibility",
    "screen-capture",
    "microphone",
    "system-audio",
    "full-disk-access",
];

type PendingNativeResponse = (String, mpsc::Receiver<Result<Value, EngineError>>);

#[derive(Clone, PartialEq)]
struct UploadTokenRequest {
    url: String,
    bearer_token: String,
    body: Value,
}

impl fmt::Debug for UploadTokenRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadTokenRequest")
            .field("url", &self.url)
            .field("bearer_token", &"<redacted>")
            .field("body", &self.body)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct UploadTokenResponse {
    status: u16,
    body: Vec<u8>,
}

trait UploadContextProvider: Send + Sync {
    fn context(&self, cancellation: &CancellationFlag) -> Result<UploadContext, EngineError>;
}

trait UploadTransport: Send + Sync {
    fn post(
        &self,
        request: UploadTokenRequest,
        cancellation: &CancellationFlag,
    ) -> Result<UploadTokenResponse, EngineError>;
}

trait RecallRuntime: Send + Sync {
    fn command(
        &self,
        command: &str,
        params: Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError>;

    fn dispatch(&self, command: &str, params: Value) -> Result<(), EngineError>;
    fn shutdown_and_reap(&self);
}

trait RecallRuntimeFactory: Send + Sync {
    fn spawn(
        &self,
        event_handler: Arc<dyn Fn(NativeSdkEvent) + Send + Sync>,
        exit_handler: Arc<dyn Fn(Option<i32>) + Send + Sync>,
    ) -> Result<Arc<dyn RecallRuntime>, EngineError>;
}

trait RecallPersistence: Send + Sync {
    fn record_started(
        &self,
        window_id: &str,
        recording_id: &str,
        company_uid: Option<&str>,
        started_at: DateTime<Utc>,
    ) -> Result<(), EngineError>;

    fn record_ended(&self, window_id: &str) -> Result<(), EngineError>;
    fn rollback_started(&self, window_id: &str) -> Result<(), EngineError>;
    fn record_detection(
        &self,
        event: &hq_desktop_core::events::MeetingDetectedEvent,
    ) -> Result<(), EngineError>;
    fn remove_detection(&self, window_id: &str) -> Result<(), EngineError>;
    fn mark_recorded(&self, window_id: &str);
    fn bridge_died(&self) -> Result<Vec<String>, EngineError>;
}

trait RecallEventSink: Send + Sync {
    fn emit(&self, name: &str, data: Value);
}

trait RecallClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UploadContext {
    base_url: String,
    access_token: String,
}

#[derive(Debug, Clone, PartialEq)]
struct NativeSdkEvent {
    event_type: String,
    payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum NativeProtocolFrame {
    Event(NativeSdkEvent),
    Response {
        command_id: String,
        status: String,
        result: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCommandFrame {
    command: String,
    command_id: String,
    write_sequence: u64,
    params: Value,
}

fn encode_native_command(frame: &NativeCommandFrame) -> Result<String, EngineError> {
    let mut encoded = serde_json::to_string(frame).map_err(|_| {
        EngineError::new(
            "recall_protocol_error",
            "The recording engine command could not be encoded",
            false,
        )
    })?;
    encoded.push('\n');
    Ok(encoded)
}

fn parse_native_protocol_line(line: &str) -> Option<NativeProtocolFrame> {
    let payload = line.trim().strip_prefix("recall_ai_command|")?;
    let envelope = serde_json::from_str::<Value>(payload).ok()?;
    match envelope.get("type")?.as_str()? {
        "event" => {
            let event = envelope.get("event")?.as_str()?;
            let event = serde_json::from_str::<Value>(event).ok()?;
            Some(NativeProtocolFrame::Event(NativeSdkEvent {
                event_type: event.get("type")?.as_str()?.to_string(),
                payload: event.get("payload").cloned().unwrap_or(Value::Null),
            }))
        }
        "response" => Some(NativeProtocolFrame::Response {
            command_id: envelope.get("commandId")?.as_str()?.to_string(),
            status: envelope.get("status")?.as_str()?.to_string(),
            result: envelope.get("result").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    }
}

struct RecallController {
    inner: Arc<RecallControllerInner>,
    context: Arc<dyn UploadContextProvider>,
    transport: Arc<dyn UploadTransport>,
    runtime_factory: Arc<dyn RecallRuntimeFactory>,
    clock: Arc<dyn RecallClock>,
}

struct RecallControllerInner {
    runtime: Mutex<Option<Arc<dyn RecallRuntime>>>,
    active_recordings: Mutex<HashSet<String>>,
    seen_permissions: Mutex<HashSet<String>>,
    persistence: Arc<dyn RecallPersistence>,
    events: Arc<dyn RecallEventSink>,
}

impl RecallController {
    fn new(
        context: Arc<dyn UploadContextProvider>,
        transport: Arc<dyn UploadTransport>,
        runtime_factory: Arc<dyn RecallRuntimeFactory>,
        persistence: Arc<dyn RecallPersistence>,
        events: Arc<dyn RecallEventSink>,
        clock: Arc<dyn RecallClock>,
    ) -> Self {
        Self {
            inner: Arc::new(RecallControllerInner {
                runtime: Mutex::new(None),
                active_recordings: Mutex::new(HashSet::new()),
                seen_permissions: Mutex::new(HashSet::new()),
                persistence,
                events,
            }),
            context,
            transport,
            runtime_factory,
            clock,
        }
    }

    fn start_sdk(&self, cancellation: &CancellationFlag) -> Result<(), EngineError> {
        cancellation.check()?;
        let mut runtime_slot = lock_unpoisoned(&self.inner.runtime);
        if runtime_slot.is_some() {
            return Ok(());
        }

        let weak_for_events = Arc::downgrade(&self.inner);
        let event_handler = Arc::new(move |event| {
            if let Some(inner) = weak_for_events.upgrade() {
                inner.handle_native_event(event);
            }
        });
        let weak_for_exit = Arc::downgrade(&self.inner);
        let exit_handler = Arc::new(move |code| {
            if let Some(inner) = weak_for_exit.upgrade() {
                std::thread::spawn(move || inner.handle_unexpected_exit(code));
            }
        });
        let runtime = self.runtime_factory.spawn(event_handler, exit_handler)?;
        *runtime_slot = Some(runtime.clone());

        let init = json!({
            "apiUrl": RECALL_API_URL,
            "acquirePermissionsOnStartup": REQUIRED_PERMISSIONS,
            "restartOnError": true,
            "sdkVersion": SDK_VERSION,
        });
        let init_result = runtime.command(
            "init",
            json!({"config": serde_json::to_string(&init).map_err(protocol_error)?}),
            cancellation,
        );
        if let Err(error) = init_result {
            runtime_slot.take();
            runtime.shutdown_and_reap();
            return Err(sanitized_command_error("initialize", error.retryable));
        }

        for permission in REQUIRED_PERMISSIONS {
            if let Err(error) = cancellation.check() {
                runtime_slot.take();
                runtime.shutdown_and_reap();
                return Err(error);
            }
            let _ = runtime.command(
                "requestPermission",
                json!({"permission": permission}),
                cancellation,
            );
        }
        drop(runtime_slot);

        let weak = Arc::downgrade(&self.inner);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2_500));
            if let Some(inner) = weak.upgrade() {
                inner.synthesize_missing_permissions();
            }
        });
        Ok(())
    }

    fn start_recording(
        &self,
        window_id: &str,
        company_uid: Option<&str>,
        cancellation: &CancellationFlag,
    ) -> Result<String, EngineError> {
        cancellation.check()?;
        let window_id = require_non_empty(window_id, "start_recording", "windowId")?;
        self.start_sdk(cancellation)?;
        let runtime = self.inner.runtime().ok_or_else(runtime_unavailable)?;
        let context = self.context.context(cancellation)?;
        let url = upload_token_url(&context.base_url, company_uid)?;
        let response = self.transport.post(
            UploadTokenRequest {
                url,
                bearer_token: context.access_token,
                body: json!({}),
            },
            cancellation,
        )?;
        cancellation.check()?;
        let token = decode_upload_token(response)?;

        self.inner.persistence.record_started(
            window_id,
            &token.recording_id,
            company_uid,
            self.clock.now(),
        )?;
        let config = serde_json::to_string(&json!({
            "windowId": window_id,
            "uploadToken": token.upload_token,
        }))
        .map_err(protocol_error)?;
        if let Err(error) =
            runtime.command("startRecording", json!({"config": config}), cancellation)
        {
            let _ = self.inner.persistence.rollback_started(window_id);
            return Err(sanitized_command_error("start recording", error.retryable));
        }
        self.inner.persistence.mark_recorded(window_id);
        Ok(token.recording_id)
    }

    fn stop_recording(
        &self,
        window_id: &str,
        cancellation: &CancellationFlag,
    ) -> Result<(), EngineError> {
        cancellation.check()?;
        let window_id = require_non_empty(window_id, "stop_recording", "windowId")?;
        let runtime = self.inner.runtime().ok_or_else(runtime_unavailable)?;
        runtime
            .command(
                "stopRecording",
                json!({"windowId": window_id}),
                cancellation,
            )
            .map_err(|error| sanitized_command_error("stop recording", error.retryable))?;
        Ok(())
    }

    #[cfg(test)]
    fn synthesize_missing_permissions(&self) {
        self.inner.synthesize_missing_permissions();
    }

    fn shutdown(&self) {
        if let Some(runtime) = lock_unpoisoned(&self.inner.runtime).take() {
            runtime.shutdown_and_reap();
        }
    }
}

impl RecallControllerInner {
    fn handle_native_event(&self, event: NativeSdkEvent) {
        match event.event_type.as_str() {
            "meeting-detected" => {
                let window = event.payload.get("window").unwrap_or(&Value::Null);
                let window_id = string_field(window, "id");
                let raw_url = string_field(window, "url").unwrap_or_default();
                let meeting_url = if raw_url.is_empty() {
                    window_id
                        .as_ref()
                        .map(|id| format!("recall-window:{id}"))
                        .unwrap_or_default()
                } else {
                    raw_url
                };
                if meeting_url.is_empty() {
                    return;
                }
                let payload = hq_desktop_core::events::MeetingDetectedEvent {
                    detection_id: uuid::Uuid::new_v4().to_string(),
                    meeting_url,
                    window_id,
                    platform: meeting_platform(string_field(window, "platform").as_deref()),
                    detected_at: Utc::now().to_rfc3339(),
                    source: hq_desktop_core::events::DetectionSource::SdkActiveApp,
                    source_event_id: None,
                };
                let _ = self.persistence.record_detection(&payload);
                self.emit_serialized("meeting:detected", payload);
            }
            "meeting-closed" => {
                let window = event.payload.get("window").unwrap_or(&Value::Null);
                let window_id = string_field(window, "id").unwrap_or_default();
                if window_id.is_empty() {
                    return;
                }
                if lock_unpoisoned(&self.active_recordings).contains(&window_id) {
                    if let Some(runtime) = self.runtime() {
                        let _ = runtime.dispatch("stopRecording", json!({"windowId": window_id}));
                    }
                }
                let _ = self.persistence.remove_detection(&window_id);
                self.emit_serialized(
                    "meeting:closed",
                    hq_desktop_core::events::MeetingClosedEvent {
                        window_id,
                        platform: meeting_platform(string_field(window, "platform").as_deref()),
                        closed_at: Utc::now().to_rfc3339(),
                    },
                );
            }
            "permission-status" => {
                let Some(permission) = string_field(&event.payload, "permission") else {
                    return;
                };
                let Some(status) = string_field(&event.payload, "status") else {
                    return;
                };
                lock_unpoisoned(&self.seen_permissions).insert(permission.clone());
                self.events.emit(
                    "permission:status",
                    json!({"permission": permission, "status": status}),
                );
            }
            "permissions-granted" => {
                lock_unpoisoned(&self.seen_permissions).extend(
                    REQUIRED_PERMISSIONS
                        .iter()
                        .map(|value| (*value).to_string()),
                );
                self.events.emit("permissions:all-granted", json!({}));
            }
            "recording-started" => {
                let window = event.payload.get("window").unwrap_or(&Value::Null);
                let window_id = string_field(window, "id").unwrap_or_default();
                if window_id.is_empty() {
                    return;
                }
                lock_unpoisoned(&self.active_recordings).insert(window_id.clone());
                self.emit_serialized(
                    "recording:started",
                    hq_desktop_core::events::RecordingStartedEvent {
                        window_id,
                        platform: meeting_platform(string_field(window, "platform").as_deref()),
                        started_at: Utc::now().to_rfc3339(),
                    },
                );
            }
            "recording-ended" => {
                let window = event.payload.get("window").unwrap_or(&Value::Null);
                let window_id = string_field(window, "id").unwrap_or_default();
                if window_id.is_empty() {
                    return;
                }
                lock_unpoisoned(&self.active_recordings).remove(&window_id);
                let _ = self.persistence.record_ended(&window_id);
                self.emit_serialized(
                    "recording:ended",
                    hq_desktop_core::events::RecordingEndedEvent {
                        window_id,
                        platform: meeting_platform(string_field(window, "platform").as_deref()),
                        ended_at: Utc::now().to_rfc3339(),
                    },
                );
            }
            "media-capture-status" => {
                let window = event.payload.get("window").unwrap_or(&Value::Null);
                self.emit_serialized(
                    "recording:media-capture",
                    hq_desktop_core::events::RecordingMediaCaptureEvent {
                        window_id: string_field(window, "id").unwrap_or_default(),
                        capture_type: string_field(&event.payload, "type").unwrap_or_default(),
                        capturing: event
                            .payload
                            .get("capturing")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    },
                );
            }
            "error" => {
                let window_id = event
                    .payload
                    .get("window")
                    .and_then(|window| string_field(window, "id"));
                let Some(window_id) = window_id else {
                    return;
                };
                lock_unpoisoned(&self.active_recordings).remove(&window_id);
                self.emit_serialized(
                    "recording:error",
                    hq_desktop_core::events::RecordingErrorEvent {
                        cmd: string_field(&event.payload, "type")
                            .unwrap_or_else(|| "sdk".to_string()),
                        window_id,
                        message: string_field(&event.payload, "message").unwrap_or_else(|| {
                            "The recording engine reported an error".to_string()
                        }),
                    },
                );
            }
            _ => {}
        }
    }

    fn handle_unexpected_exit(&self, code: Option<i32>) {
        lock_unpoisoned(&self.runtime).take();
        lock_unpoisoned(&self.active_recordings).clear();
        let window_ids = self.persistence.bridge_died().unwrap_or_default();
        for window_id in window_ids {
            self.emit_serialized(
                "recording:error",
                hq_desktop_core::events::RecordingErrorEvent {
                    cmd: "bridge-exit".to_string(),
                    window_id,
                    message: code.map_or_else(
                        || "Recording engine exited unexpectedly".to_string(),
                        |code| format!("Recording engine exited unexpectedly (exit code {code})"),
                    ),
                },
            );
        }
    }

    fn runtime(&self) -> Option<Arc<dyn RecallRuntime>> {
        lock_unpoisoned(&self.runtime).clone()
    }

    fn synthesize_missing_permissions(&self) {
        let seen = lock_unpoisoned(&self.seen_permissions).clone();
        for permission in REQUIRED_PERMISSIONS {
            if !seen.contains(*permission) {
                self.events.emit(
                    "permission:status",
                    json!({"permission": permission, "status": "not-determined"}),
                );
            }
        }
    }

    fn emit_serialized(&self, name: &str, payload: impl Serialize) {
        if let Ok(data) = serde_json::to_value(payload) {
            self.events.emit(name, data);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTokenWire {
    #[serde(default)]
    id: String,
    #[serde(default)]
    recording_id: Option<String>,
    #[serde(default)]
    upload_token: String,
}

struct DecodedUploadToken {
    recording_id: String,
    upload_token: String,
}

fn decode_upload_token(response: UploadTokenResponse) -> Result<DecodedUploadToken, EngineError> {
    if !(200..300).contains(&response.status) {
        return Err(EngineError::new(
            "recall_upload_token_rejected",
            format!(
                "The recording service rejected the upload token request (HTTP {})",
                response.status
            ),
            response.status >= 500,
        ));
    }
    if response.body.len() > MAX_RESPONSE_BYTES {
        return Err(EngineError::new(
            "recall_upload_token_invalid",
            "The recording service response exceeded the safe size limit",
            false,
        ));
    }
    let wire = serde_json::from_slice::<UploadTokenWire>(&response.body).map_err(|_| {
        EngineError::new(
            "recall_upload_token_invalid",
            "The recording service returned an invalid response",
            false,
        )
    })?;
    let upload_token = wire.upload_token.trim();
    if upload_token.is_empty() {
        return Err(EngineError::new(
            "recall_upload_token_invalid",
            "The recording service did not provide an upload token",
            false,
        ));
    }
    let recording_id = wire
        .recording_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let value = wire.id.trim();
            (!value.is_empty()).then_some(value)
        })
        .ok_or_else(|| {
            EngineError::new(
                "recall_upload_token_invalid",
                "The recording service did not provide a recording identifier",
                false,
            )
        })?
        .to_string();
    Ok(DecodedUploadToken {
        recording_id,
        upload_token: upload_token.to_string(),
    })
}

fn upload_token_url(base_url: &str, company_uid: Option<&str>) -> Result<String, EngineError> {
    let value = format!(
        "{}/v1/recall/upload-token",
        base_url.trim().trim_end_matches('/')
    );
    let mut url = reqwest::Url::parse(&value).map_err(|_| {
        EngineError::new(
            "recall_service_unavailable",
            "The configured recording service URL is invalid",
            false,
        )
    })?;
    if url.scheme() != "https" {
        return Err(EngineError::new(
            "recall_service_unavailable",
            "The configured recording service URL must use HTTPS",
            false,
        ));
    }
    if let Some(company_uid) = company_uid.map(str::trim).filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("companyId", company_uid);
    }
    Ok(url.into())
}

fn require_non_empty<'a>(
    value: &'a str,
    method: &str,
    field: &str,
) -> Result<&'a str, EngineError> {
    let value = value.trim();
    if value.is_empty() {
        Err(EngineError::new(
            "invalid_params",
            format!("{method} requires a non-empty `{field}`"),
            false,
        ))
    } else {
        Ok(value)
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn meeting_platform(value: Option<&str>) -> hq_desktop_core::events::MeetingPlatform {
    match value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "zoom" => hq_desktop_core::events::MeetingPlatform::Zoom,
        "meet" | "googlemeet" | "google-meet" => hq_desktop_core::events::MeetingPlatform::Meet,
        "teams" | "msteams" | "microsoft-teams" => hq_desktop_core::events::MeetingPlatform::Teams,
        "slack" => hq_desktop_core::events::MeetingPlatform::Slack,
        "webex" => hq_desktop_core::events::MeetingPlatform::Webex,
        _ => hq_desktop_core::events::MeetingPlatform::Other,
    }
}

fn runtime_unavailable() -> EngineError {
    EngineError::new(
        "recall_runtime_unavailable",
        "The recording engine is not running",
        true,
    )
}

fn sanitized_command_error(action: &str, retryable: bool) -> EngineError {
    EngineError::new(
        "recall_command_failed",
        format!("The recording engine could not {action}"),
        retryable,
    )
}

fn protocol_error(_error: serde_json::Error) -> EngineError {
    EngineError::new(
        "recall_protocol_error",
        "The recording engine command could not be encoded",
        false,
    )
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct CoreUploadContextProvider;

impl UploadContextProvider for CoreUploadContextProvider {
    fn context(&self, cancellation: &CancellationFlag) -> Result<UploadContext, EngineError> {
        cancellation.check()?;
        let config = hq_desktop_core::config::read_hq_config_lenient()
            .map_err(|message| EngineError::new("recall_config_unavailable", message, false))?
            .ok_or_else(|| {
                EngineError::new(
                    "recall_config_unavailable",
                    "HQ is not configured for recording",
                    false,
                )
            })?;
        let base_url = config.vault_api_url.trim().trim_end_matches('/');
        if base_url.is_empty() {
            return Err(EngineError::new(
                "recall_config_unavailable",
                "The configured recording service URL is empty",
                false,
            ));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "recall_auth_unavailable",
                    format!("Could not initialize recording authentication: {error}"),
                    true,
                )
            })?;
        let access_token = runtime
            .block_on(hq_desktop_core::cognito::get_valid_access_token())
            .map_err(|_| {
                EngineError::new(
                    "recall_auth_required",
                    "Sign in again to record this meeting",
                    false,
                )
            })?;
        cancellation.check()?;
        Ok(UploadContext {
            base_url: base_url.to_string(),
            access_token,
        })
    }
}

struct ReqwestUploadTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestUploadTransport {
    fn new() -> Result<Self, EngineError> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("HQ-Native/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map(|client| Self { client })
            .map_err(|error| {
                EngineError::new(
                    "recall_client_unavailable",
                    format!("Could not initialize the recording service: {error}"),
                    true,
                )
            })
    }
}

impl UploadTransport for ReqwestUploadTransport {
    fn post(
        &self,
        request: UploadTokenRequest,
        cancellation: &CancellationFlag,
    ) -> Result<UploadTokenResponse, EngineError> {
        cancellation.check()?;
        let mut response = self
            .client
            .post(&request.url)
            .bearer_auth(&request.bearer_token)
            .json(&request.body)
            .send()
            .map_err(|_| {
                EngineError::new(
                    "recall_network_error",
                    "The recording service could not be reached",
                    true,
                )
            })?;
        cancellation.check()?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(EngineError::new(
                "recall_upload_token_invalid",
                "The recording service response exceeded the safe size limit",
                false,
            ));
        }
        let status = response.status().as_u16();
        let mut body = Vec::new();
        response
            .by_ref()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| {
                EngineError::new(
                    "recall_response_unreadable",
                    "The recording service returned an unreadable response",
                    true,
                )
            })?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(EngineError::new(
                "recall_upload_token_invalid",
                "The recording service response exceeded the safe size limit",
                false,
            ));
        }
        cancellation.check()?;
        Ok(UploadTokenResponse { status, body })
    }
}

struct CoreRecallPersistence;

impl RecallPersistence for CoreRecallPersistence {
    fn record_started(
        &self,
        window_id: &str,
        recording_id: &str,
        company_uid: Option<&str>,
        started_at: DateTime<Utc>,
    ) -> Result<(), EngineError> {
        hq_desktop_core::recordings_ledger::record_started(
            window_id.to_string(),
            recording_id.to_string(),
            company_uid.map(str::to_string),
            started_at,
        )
        .map_err(|message| EngineError::new("recall_ledger_write_failed", message, false))
    }

    fn record_ended(&self, window_id: &str) -> Result<(), EngineError> {
        hq_desktop_core::recordings_ledger::record_ended(window_id)
            .map_err(|message| EngineError::new("recall_ledger_write_failed", message, false))
    }

    fn rollback_started(&self, window_id: &str) -> Result<(), EngineError> {
        self.record_ended(window_id)
    }

    fn record_detection(
        &self,
        event: &hq_desktop_core::events::MeetingDetectedEvent,
    ) -> Result<(), EngineError> {
        hq_desktop_core::recall_sdk::record_active_detection(event);
        Ok(())
    }

    fn remove_detection(&self, window_id: &str) -> Result<(), EngineError> {
        hq_desktop_core::recall_sdk::remove_active_detection(window_id);
        Ok(())
    }

    fn mark_recorded(&self, window_id: &str) {
        hq_desktop_core::recall_sdk::mark_recorded_for_window(window_id);
    }

    fn bridge_died(&self) -> Result<Vec<String>, EngineError> {
        hq_desktop_core::recordings_ledger::record_bridge_died()
            .map_err(|message| EngineError::new("recall_ledger_write_failed", message, false))
    }
}

struct BusRecallEventSink {
    bus: EngineEventBus,
}

impl RecallEventSink for BusRecallEventSink {
    fn emit(&self, name: &str, data: Value) {
        self.bus
            .emit(EngineDomainEvent::new(None, name.to_string(), data));
    }
}

struct SystemClock;

impl RecallClock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

const RECALL_FD3_SHELL: &str = "exec 3>&1; exec \"$@\"";
const RECALL_HELPER_NAME: &str = "hq-recall-runtime";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_POLL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeLaunchSpec {
    program: PathBuf,
    arguments: Vec<String>,
    environment: BTreeMap<String, String>,
    current_directory: PathBuf,
}

fn native_launch_spec(helper: &Path) -> Result<NativeLaunchSpec, EngineError> {
    let helper = helper.canonicalize().map_err(|_| runtime_unavailable())?;
    let current_directory = helper
        .parent()
        .ok_or_else(runtime_unavailable)?
        .to_path_buf();
    let mut environment = BTreeMap::new();
    environment.insert(
        "EXE_NAME".to_string(),
        "ai.indigo.hq-sync-menubar".to_string(),
    );
    environment.insert("SDK_VERSION".to_string(), SDK_VERSION.to_string());
    environment.insert("GST_REGISTRY_FORK".to_string(), "no".to_string());
    environment.insert("RUST_BACKTRACE".to_string(), "1".to_string());
    environment.insert(
        "TMPDIR".to_string(),
        std::env::temp_dir().to_string_lossy().into_owned(),
    );
    Ok(NativeLaunchSpec {
        program: PathBuf::from("/bin/sh"),
        arguments: vec![
            "-c".to_string(),
            RECALL_FD3_SHELL.to_string(),
            RECALL_HELPER_NAME.to_string(),
            helper.to_string_lossy().into_owned(),
        ],
        environment,
        current_directory,
    })
}

fn bundled_recall_helper() -> Result<PathBuf, EngineError> {
    let executable = std::env::current_exe().map_err(|_| runtime_unavailable())?;
    let helper = executable
        .parent()
        .ok_or_else(runtime_unavailable)?
        .join(RECALL_HELPER_NAME);
    helper
        .is_file()
        .then_some(helper)
        .ok_or_else(runtime_unavailable)
}

struct NativeRecallRuntimeFactory;

impl RecallRuntimeFactory for NativeRecallRuntimeFactory {
    fn spawn(
        &self,
        event_handler: Arc<dyn Fn(NativeSdkEvent) + Send + Sync>,
        exit_handler: Arc<dyn Fn(Option<i32>) + Send + Sync>,
    ) -> Result<Arc<dyn RecallRuntime>, EngineError> {
        NativeRecallRuntime::spawn(
            native_launch_spec(&bundled_recall_helper()?)?,
            event_handler,
            exit_handler,
        )
        .map(|runtime| runtime as Arc<dyn RecallRuntime>)
    }
}

struct NativeRecallRuntime {
    shared: Arc<NativeRuntimeShared>,
    reader: Mutex<Option<JoinHandle<()>>>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
}

struct NativeRuntimeShared {
    writer: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<Value, EngineError>>>>,
    next_sequence: AtomicU64,
    intentional_shutdown: AtomicBool,
    reaped: AtomicBool,
}

impl NativeRecallRuntime {
    fn spawn(
        spec: NativeLaunchSpec,
        event_handler: Arc<dyn Fn(NativeSdkEvent) + Send + Sync>,
        exit_handler: Arc<dyn Fn(Option<i32>) + Send + Sync>,
    ) -> Result<Arc<Self>, EngineError> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.arguments)
            .env_clear()
            .envs(&spec.environment)
            .current_dir(&spec.current_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|_| runtime_unavailable())?;
        let writer = child.stdin.take().ok_or_else(runtime_unavailable)?;
        let stdout = child.stdout.take().ok_or_else(runtime_unavailable)?;
        let stderr = child.stderr.take().ok_or_else(runtime_unavailable)?;
        let shared = Arc::new(NativeRuntimeShared {
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            next_sequence: AtomicU64::new(1),
            intentional_shutdown: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
        });

        let reader_shared = shared.clone();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                match parse_native_protocol_line(&line) {
                    Some(NativeProtocolFrame::Event(event)) => event_handler(event),
                    Some(NativeProtocolFrame::Response {
                        command_id,
                        status,
                        result,
                    }) => {
                        let outcome = if status == "success" {
                            Ok(result)
                        } else {
                            Err(sanitized_command_error("complete the command", true))
                        };
                        if let Some(sender) =
                            lock_unpoisoned(&reader_shared.pending).remove(&command_id)
                        {
                            let _ = sender.send(outcome);
                        }
                    }
                    None => {}
                }
            }
            fail_pending(&reader_shared);
            let code = reap_child(&reader_shared);
            if !reader_shared.intentional_shutdown.load(Ordering::Acquire) {
                exit_handler(code);
            }
        });
        let stderr_reader = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                if line.is_err() {
                    break;
                }
            }
        });

        Ok(Arc::new(Self {
            shared,
            reader: Mutex::new(Some(reader)),
            stderr_reader: Mutex::new(Some(stderr_reader)),
        }))
    }

    fn send_frame(
        &self,
        command: &str,
        params: Value,
        wait_for_response: bool,
    ) -> Result<Option<PendingNativeResponse>, EngineError> {
        let command_id = uuid::Uuid::new_v4().to_string();
        let write_sequence = self.shared.next_sequence.fetch_add(1, Ordering::AcqRel);
        let line = encode_native_command(&NativeCommandFrame {
            command: command.to_string(),
            command_id: command_id.clone(),
            write_sequence,
            params,
        })?;
        let receiver = if wait_for_response {
            let (sender, receiver) = mpsc::sync_channel(1);
            lock_unpoisoned(&self.shared.pending).insert(command_id.clone(), sender);
            Some((command_id.clone(), receiver))
        } else {
            None
        };
        let write_result = lock_unpoisoned(&self.shared.writer)
            .as_mut()
            .ok_or_else(runtime_unavailable)
            .and_then(|writer| {
                writer
                    .write_all(line.as_bytes())
                    .and_then(|()| writer.flush())
                    .map_err(|_| runtime_unavailable())
            });
        if let Err(error) = write_result {
            lock_unpoisoned(&self.shared.pending).remove(&command_id);
            return Err(error);
        }
        Ok(receiver)
    }

    fn shutdown_once(&self) {
        if self
            .shared
            .intentional_shutdown
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let _ = self.command_with_timeout(
            "shutdown",
            json!({}),
            &CancellationFlag::default(),
            SHUTDOWN_TIMEOUT,
        );
        lock_unpoisoned(&self.shared.writer).take();

        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            if self.shared.reaped.load(Ordering::Acquire) {
                break;
            }
            let exited = lock_unpoisoned(&self.shared.child)
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
                .is_some();
            if exited {
                let _ = reap_child(&self.shared);
                break;
            }
            if Instant::now() >= deadline {
                if let Some(child) = lock_unpoisoned(&self.shared.child).as_mut() {
                    let _ = child.kill();
                }
                let _ = reap_child(&self.shared);
                break;
            }
            std::thread::sleep(RESPONSE_POLL);
        }
        if let Some(reader) = lock_unpoisoned(&self.reader).take() {
            if reader.thread().id() != std::thread::current().id() {
                let _ = reader.join();
            }
        }
        if let Some(reader) = lock_unpoisoned(&self.stderr_reader).take() {
            if reader.thread().id() != std::thread::current().id() {
                let _ = reader.join();
            }
        }
    }

    fn command_with_timeout(
        &self,
        command: &str,
        params: Value,
        cancellation: &CancellationFlag,
        timeout: Duration,
    ) -> Result<Value, EngineError> {
        cancellation.check()?;
        let (command_id, receiver) = self
            .send_frame(command, params, true)?
            .ok_or_else(runtime_unavailable)?;
        let deadline = Instant::now() + timeout;
        loop {
            if cancellation.is_cancelled() {
                lock_unpoisoned(&self.shared.pending).remove(&command_id);
                return Err(EngineError::cancelled());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                lock_unpoisoned(&self.shared.pending).remove(&command_id);
                return Err(EngineError::new(
                    "recall_command_timeout",
                    "The recording engine did not respond in time",
                    true,
                ));
            }
            match receiver.recv_timeout(remaining.min(RESPONSE_POLL)) {
                Ok(outcome) => return outcome,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(runtime_unavailable());
                }
            }
        }
    }
}

impl RecallRuntime for NativeRecallRuntime {
    fn command(
        &self,
        command: &str,
        params: Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        self.command_with_timeout(command, params, cancellation, COMMAND_TIMEOUT)
    }

    fn dispatch(&self, command: &str, params: Value) -> Result<(), EngineError> {
        self.send_frame(command, params, false).map(|_| ())
    }

    fn shutdown_and_reap(&self) {
        self.shutdown_once();
    }
}

impl Drop for NativeRecallRuntime {
    fn drop(&mut self) {
        self.shutdown_once();
    }
}

fn fail_pending(shared: &NativeRuntimeShared) {
    let pending = std::mem::take(&mut *lock_unpoisoned(&shared.pending));
    for sender in pending.into_values() {
        let _ = sender.send(Err(runtime_unavailable()));
    }
}

fn reap_child(shared: &NativeRuntimeShared) -> Option<i32> {
    if shared.reaped.swap(true, Ordering::AcqRel) {
        return None;
    }
    lock_unpoisoned(&shared.child)
        .take()
        .and_then(|mut child| child.wait().ok())
        .and_then(|status| status.code())
}

fn production_controller(backend: &CoreBackend) -> Result<RecallController, EngineError> {
    Ok(RecallController::new(
        Arc::new(CoreUploadContextProvider),
        Arc::new(ReqwestUploadTransport::new()?),
        Arc::new(NativeRecallRuntimeFactory),
        Arc::new(CoreRecallPersistence),
        Arc::new(BusRecallEventSink {
            bus: backend.event_bus(),
        }),
        Arc::new(SystemClock),
    ))
}

static GLOBAL_CONTROLLER: OnceLock<Result<RecallController, EngineError>> = OnceLock::new();

fn global_controller(backend: &CoreBackend) -> Result<&'static RecallController, EngineError> {
    GLOBAL_CONTROLLER
        .get_or_init(|| production_controller(backend))
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let controller = global_controller(backend)?;
    match method {
        "start_recall_sdk" => {
            if backend.identity_email()?.is_none() {
                return to_value(());
            }
            controller.start_sdk(cancellation)?;
            to_value(())
        }
        "start_recording" => {
            let params = serde_json::from_value::<StartRecordingParams>(params.clone())
                .map_err(|error| invalid_params(method, error))?;
            to_value(controller.start_recording(
                &params.window_id,
                params.company_uid.as_deref(),
                cancellation,
            )?)
        }
        "stop_recording" => {
            let params = serde_json::from_value::<StopRecordingParams>(params.clone())
                .map_err(|error| invalid_params(method, error))?;
            controller.stop_recording(&params.window_id, cancellation)?;
            to_value(())
        }
        _ => Err(EngineError::new(
            "method_not_found",
            format!("Method `{method}` is not implemented"),
            false,
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRecordingParams {
    window_id: String,
    #[serde(default, alias = "companyId")]
    company_uid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopRecordingParams {
    window_id: String,
}

fn invalid_params(method: &str, error: serde_json::Error) -> EngineError {
    EngineError::new(
        "invalid_params",
        format!("{method} params are invalid: {error}"),
        false,
    )
}

pub(crate) fn shutdown_global() {
    if let Some(Ok(controller)) = GLOBAL_CONTROLLER.get() {
        controller.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    use super::*;

    #[derive(Default)]
    struct MockRuntime {
        commands: Mutex<Vec<(String, Value)>>,
        fail_start: AtomicBool,
        shutdowns: AtomicUsize,
        order: Arc<Mutex<Vec<String>>>,
    }

    impl RecallRuntime for MockRuntime {
        fn command(
            &self,
            command: &str,
            params: Value,
            cancellation: &CancellationFlag,
        ) -> Result<Value, EngineError> {
            cancellation.check()?;
            lock(&self.order).push(format!("command:{command}"));
            lock(&self.commands).push((command.to_string(), params));
            if command == "startRecording" && self.fail_start.load(Ordering::Acquire) {
                return Err(EngineError::new(
                    "recall_command_failed",
                    "The recording engine rejected the start command",
                    true,
                ));
            }
            Ok(Value::Null)
        }

        fn dispatch(&self, command: &str, params: Value) -> Result<(), EngineError> {
            lock(&self.order).push(format!("command:{command}"));
            lock(&self.commands).push((command.to_string(), params));
            Ok(())
        }

        fn shutdown_and_reap(&self) {
            self.shutdowns.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct MockFactory {
        runtime: Arc<MockRuntime>,
        spawns: AtomicUsize,
    }

    impl RecallRuntimeFactory for MockFactory {
        fn spawn(
            &self,
            _event_handler: Arc<dyn Fn(NativeSdkEvent) + Send + Sync>,
            _exit_handler: Arc<dyn Fn(Option<i32>) + Send + Sync>,
        ) -> Result<Arc<dyn RecallRuntime>, EngineError> {
            self.spawns.fetch_add(1, Ordering::AcqRel);
            Ok(self.runtime.clone())
        }
    }

    struct MockContext;

    impl UploadContextProvider for MockContext {
        fn context(&self, cancellation: &CancellationFlag) -> Result<UploadContext, EngineError> {
            cancellation.check()?;
            Ok(UploadContext {
                base_url: "https://hq.example.test".to_string(),
                access_token: "bearer-secret".to_string(),
            })
        }
    }

    struct MockTransport {
        requests: Mutex<Vec<UploadTokenRequest>>,
        response: Mutex<UploadTokenResponse>,
        calls: AtomicUsize,
        order: Arc<Mutex<Vec<String>>>,
    }

    impl UploadTransport for MockTransport {
        fn post(
            &self,
            request: UploadTokenRequest,
            cancellation: &CancellationFlag,
        ) -> Result<UploadTokenResponse, EngineError> {
            cancellation.check()?;
            self.calls.fetch_add(1, Ordering::AcqRel);
            lock(&self.order).push("transport".to_string());
            lock(&self.requests).push(request);
            Ok(lock(&self.response).clone())
        }
    }

    #[derive(Default)]
    struct MockPersistence {
        order: Arc<Mutex<Vec<String>>>,
        open: Mutex<HashSet<String>>,
        detections: Mutex<HashMap<String, hq_desktop_core::events::MeetingDetectedEvent>>,
        marked: Mutex<Vec<String>>,
    }

    impl RecallPersistence for MockPersistence {
        fn record_started(
            &self,
            window_id: &str,
            _recording_id: &str,
            _company_uid: Option<&str>,
            _started_at: DateTime<Utc>,
        ) -> Result<(), EngineError> {
            lock(&self.order).push("ledger:record_started".to_string());
            lock(&self.open).insert(window_id.to_string());
            Ok(())
        }

        fn record_ended(&self, window_id: &str) -> Result<(), EngineError> {
            lock(&self.open).remove(window_id);
            Ok(())
        }

        fn rollback_started(&self, window_id: &str) -> Result<(), EngineError> {
            lock(&self.order).push("ledger:rollback".to_string());
            lock(&self.open).remove(window_id);
            Ok(())
        }

        fn record_detection(
            &self,
            event: &hq_desktop_core::events::MeetingDetectedEvent,
        ) -> Result<(), EngineError> {
            let key = event
                .window_id
                .clone()
                .unwrap_or_else(|| event.meeting_url.clone());
            lock(&self.detections).insert(key, event.clone());
            Ok(())
        }

        fn remove_detection(&self, window_id: &str) -> Result<(), EngineError> {
            lock(&self.detections).remove(window_id);
            Ok(())
        }

        fn mark_recorded(&self, window_id: &str) {
            lock(&self.marked).push(window_id.to_string());
        }

        fn bridge_died(&self) -> Result<Vec<String>, EngineError> {
            let mut open = lock(&self.open);
            let ids = open.iter().cloned().collect();
            open.clear();
            Ok(ids)
        }
    }

    #[derive(Default)]
    struct MockEvents {
        values: Mutex<Vec<(String, Value)>>,
    }

    impl RecallEventSink for MockEvents {
        fn emit(&self, name: &str, data: Value) {
            lock(&self.values).push((name.to_string(), data));
        }
    }

    struct FixedClock;

    impl RecallClock for FixedClock {
        fn now(&self) -> DateTime<Utc> {
            DateTime::parse_from_rfc3339("2026-07-26T20:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
        }
    }

    struct Harness {
        controller: RecallController,
        runtime: Arc<MockRuntime>,
        factory: Arc<MockFactory>,
        transport: Arc<MockTransport>,
        persistence: Arc<MockPersistence>,
        events: Arc<MockEvents>,
    }

    fn harness() -> Harness {
        let order = Arc::new(Mutex::new(Vec::new()));
        let runtime = Arc::new(MockRuntime {
            order: order.clone(),
            ..MockRuntime::default()
        });
        let factory = Arc::new(MockFactory {
            runtime: runtime.clone(),
            spawns: AtomicUsize::new(0),
        });
        let transport = Arc::new(MockTransport {
            requests: Mutex::new(Vec::new()),
            response: Mutex::new(UploadTokenResponse {
                status: 200,
                body: br#"{"recordingId":"rec-1","id":"upload-1","uploadToken":"one-shot-secret"}"#
                    .to_vec(),
            }),
            calls: AtomicUsize::new(0),
            order: order.clone(),
        });
        let persistence = Arc::new(MockPersistence {
            order,
            ..MockPersistence::default()
        });
        let events = Arc::new(MockEvents::default());
        let controller = RecallController::new(
            Arc::new(MockContext),
            transport.clone(),
            factory.clone(),
            persistence.clone(),
            events.clone(),
            Arc::new(FixedClock),
        );
        Harness {
            controller,
            runtime,
            factory,
            transport,
            persistence,
            events,
        }
    }

    #[test]
    fn command_wire_and_response_correlation_match_native_sdk() {
        let line = encode_native_command(&NativeCommandFrame {
            command: "startRecording".to_string(),
            command_id: "cmd-123".to_string(),
            write_sequence: 7,
            params: json!({"config":"{\"windowId\":\"win-1\",\"uploadToken\":\"secret\"}"}),
        })
        .unwrap();
        assert_eq!(
            line,
            "{\"command\":\"startRecording\",\"commandId\":\"cmd-123\",\"writeSequence\":7,\"params\":{\"config\":\"{\\\"windowId\\\":\\\"win-1\\\",\\\"uploadToken\\\":\\\"secret\\\"}\"}}\n"
        );

        let response = parse_native_protocol_line(
            r#"recall_ai_command|{"type":"response","commandId":"cmd-123","status":"success","result":null}"#,
        );
        assert_eq!(
            response,
            Some(NativeProtocolFrame::Response {
                command_id: "cmd-123".to_string(),
                status: "success".to_string(),
                result: Value::Null,
            })
        );
    }

    #[test]
    fn sdk_start_is_singleton_keyless_and_requests_every_permission() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();

        assert_eq!(harness.factory.spawns.load(Ordering::Acquire), 1);
        let commands = lock(&harness.runtime.commands);
        assert_eq!(commands.len(), 1 + REQUIRED_PERMISSIONS.len());
        let init: Value = serde_json::from_str(commands[0].1["config"].as_str().unwrap()).unwrap();
        assert_eq!(init["apiUrl"], RECALL_API_URL);
        assert_eq!(init["sdkVersion"], SDK_VERSION);
        assert!(init.get("apiKey").is_none());
        assert_eq!(
            commands[1..]
                .iter()
                .map(|(_, params)| params["permission"].as_str().unwrap())
                .collect::<Vec<_>>(),
            REQUIRED_PERMISSIONS
        );
    }

    #[test]
    fn recording_token_request_is_exact_secret_safe_and_ledger_precedes_command() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        lock(&harness.runtime.order).clear();

        let recording_id = harness
            .controller
            .start_recording("win-1", Some("co/space name"), &CancellationFlag::default())
            .unwrap();

        assert_eq!(recording_id, "rec-1");
        let request = lock(&harness.transport.requests)[0].clone();
        assert_eq!(
            request.url,
            "https://hq.example.test/v1/recall/upload-token?companyId=co%2Fspace+name"
        );
        assert_eq!(request.body, json!({}));
        assert!(!format!("{request:?}").contains("bearer-secret"));
        assert_eq!(
            lock(&harness.runtime.order).as_slice(),
            [
                "transport",
                "ledger:record_started",
                "command:startRecording"
            ]
        );
        assert_eq!(lock(&harness.persistence.marked).as_slice(), ["win-1"]);
    }

    #[test]
    fn command_failure_rolls_back_durable_ledger_without_exposing_token() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        harness.runtime.fail_start.store(true, Ordering::Release);
        let error = harness
            .controller
            .start_recording("win-1", None, &CancellationFlag::default())
            .unwrap_err();

        assert!(!error.message.contains("one-shot-secret"));
        assert!(lock(&harness.persistence.open).is_empty());
        assert!(lock(&harness.persistence.order)
            .iter()
            .any(|entry| entry == "ledger:rollback"));
    }

    #[test]
    fn events_translate_update_state_and_auto_stop_on_meeting_close() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        harness
            .controller
            .inner
            .handle_native_event(NativeSdkEvent {
                event_type: "meeting-detected".to_string(),
                payload: json!({"window":{"id":"win-1","url":"https://zoom.us/j/1","platform":"zoom"}}),
            });
        harness
            .controller
            .inner
            .handle_native_event(NativeSdkEvent {
                event_type: "recording-started".to_string(),
                payload: json!({"window":{"id":"win-1","platform":"zoom"}}),
            });
        harness
            .controller
            .inner
            .handle_native_event(NativeSdkEvent {
                event_type: "meeting-closed".to_string(),
                payload: json!({"window":{"id":"win-1","platform":"zoom"}}),
            });

        let names = lock(&harness.events.values)
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            ["meeting:detected", "recording:started", "meeting:closed"]
        );
        assert!(lock(&harness.runtime.commands)
            .iter()
            .any(|(command, params)| command == "stopRecording" && params["windowId"] == "win-1"));
        assert!(lock(&harness.persistence.detections).is_empty());
    }

    #[test]
    fn permission_events_and_synthetic_not_determined_are_complete() {
        let harness = harness();
        harness
            .controller
            .inner
            .handle_native_event(NativeSdkEvent {
                event_type: "permission-status".to_string(),
                payload: json!({"permission":"microphone","status":"granted"}),
            });
        harness.controller.synthesize_missing_permissions();

        let events = lock(&harness.events.values);
        assert_eq!(
            events
                .iter()
                .filter(|(name, _)| name == "permission:status")
                .count(),
            REQUIRED_PERMISSIONS.len()
        );
        assert!(events.iter().any(|(_, data)| {
            data["permission"] == "microphone" && data["status"] == "granted"
        }));
        assert!(events.iter().any(|(_, data)| {
            data["permission"] == "screen-capture" && data["status"] == "not-determined"
        }));
    }

    #[test]
    fn unexpected_bridge_exit_emits_terminal_errors_and_clears_ledger() {
        let harness = harness();
        lock(&harness.persistence.open).extend(["win-1".to_string(), "win-2".to_string()]);
        harness.controller.inner.handle_unexpected_exit(Some(9));

        let events = lock(&harness.events.values);
        assert_eq!(
            events
                .iter()
                .filter(|(name, _)| name == "recording:error")
                .count(),
            2
        );
        assert!(events.iter().all(|(_, data)| {
            !data.to_string().contains("one-shot-secret")
                && data["cmd"] == "bridge-exit"
                && data["message"].as_str().unwrap().contains("exit code 9")
        }));
        assert!(lock(&harness.persistence.open).is_empty());
    }

    #[test]
    fn cancellation_short_circuits_before_network_or_process_work() {
        let harness = harness();
        let cancelled = CancellationFlag::default();
        cancelled.cancel();
        let error = harness
            .controller
            .start_recording("win-1", None, &cancelled)
            .unwrap_err();
        assert_eq!(error.code, "request_cancelled");
        assert_eq!(harness.transport.calls.load(Ordering::Acquire), 0);
        assert!(lock(&harness.runtime.commands).is_empty());
    }

    #[test]
    fn shutdown_is_idempotent_and_reaps_the_native_child() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        harness.controller.shutdown();
        harness.controller.shutdown();
        assert_eq!(harness.runtime.shutdowns.load(Ordering::Acquire), 1);
    }

    #[test]
    fn all_eight_recall_events_have_exact_names_and_payload_shapes() {
        use std::collections::BTreeSet;

        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        let emit = |event_type: &str, payload: Value| {
            harness
                .controller
                .inner
                .handle_native_event(NativeSdkEvent {
                    event_type: event_type.to_string(),
                    payload,
                });
        };
        emit(
            "meeting-detected",
            json!({"window":{"id":"win-1","url":"https://meet.google.com/abc","platform":"meet"}}),
        );
        emit(
            "permission-status",
            json!({"permission":"microphone","status":"granted"}),
        );
        emit("permissions-granted", json!({}));
        emit(
            "recording-started",
            json!({"window":{"id":"win-1","platform":"meet"}}),
        );
        emit(
            "media-capture-status",
            json!({"window":{"id":"win-1"},"type":"audio","capturing":true}),
        );
        emit(
            "recording-ended",
            json!({"window":{"id":"win-1","platform":"meet"}}),
        );
        emit(
            "error",
            json!({"window":{"id":"win-2"},"type":"capture","message":"Audio input stopped"}),
        );
        emit(
            "meeting-closed",
            json!({"window":{"id":"win-1","platform":"meet"}}),
        );

        let events = lock(&harness.events.values);
        let names = events
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            names,
            BTreeSet::from([
                "meeting:closed".to_string(),
                "meeting:detected".to_string(),
                "permission:status".to_string(),
                "permissions:all-granted".to_string(),
                "recording:ended".to_string(),
                "recording:error".to_string(),
                "recording:media-capture".to_string(),
                "recording:started".to_string(),
            ])
        );
        let payload = |name: &str| {
            events
                .iter()
                .find(|(event_name, _)| event_name == name)
                .map(|(_, data)| data)
                .unwrap()
        };
        assert_eq!(payload("meeting:detected")["windowId"], "win-1");
        assert_eq!(payload("meeting:detected")["source"], "sdk-active-app");
        assert_eq!(payload("meeting:closed")["platform"], "meet");
        assert_eq!(payload("permission:status")["permission"], "microphone");
        assert_eq!(payload("permissions:all-granted"), &json!({}));
        assert!(payload("recording:started")["startedAt"].is_string());
        assert!(payload("recording:ended")["endedAt"].is_string());
        assert_eq!(
            payload("recording:media-capture"),
            &json!({"windowId":"win-1","captureType":"audio","capturing":true})
        );
        assert_eq!(payload("recording:error")["cmd"], "capture");
        assert_eq!(payload("recording:error")["windowId"], "win-2");
    }

    #[test]
    fn stop_recording_uses_the_exact_native_command() {
        let harness = harness();
        harness
            .controller
            .start_sdk(&CancellationFlag::default())
            .unwrap();
        harness
            .controller
            .stop_recording("win-1", &CancellationFlag::default())
            .unwrap();
        assert!(lock(&harness.runtime.commands)
            .iter()
            .any(|(command, params)| {
                command == "stopRecording" && params == &json!({"windowId":"win-1"})
            }));
    }

    #[test]
    fn native_launch_is_fd3_capable_keyless_and_never_invokes_node() {
        let temp = tempfile::tempdir().unwrap();
        let helper_directory = temp.path().join("runtime with spaces");
        std::fs::create_dir_all(&helper_directory).unwrap();
        let helper = helper_directory.join(RECALL_HELPER_NAME);
        std::fs::write(&helper, b"fixture").unwrap();
        let spec = native_launch_spec(&helper).unwrap();

        assert_eq!(spec.program, PathBuf::from("/bin/sh"));
        assert_eq!(spec.arguments[0], "-c");
        assert_eq!(spec.arguments[1], RECALL_FD3_SHELL);
        assert_eq!(spec.arguments[2], RECALL_HELPER_NAME);
        assert_eq!(
            PathBuf::from(&spec.arguments[3]),
            helper.canonicalize().unwrap()
        );
        assert!(!spec
            .arguments
            .iter()
            .any(|argument| argument.contains("node") || argument.ends_with(".js")));
        assert!(!spec.environment.keys().any(|key| {
            let key = key.to_ascii_uppercase();
            key.contains("API_KEY") || key.contains("UPLOAD_TOKEN")
        }));
    }

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
