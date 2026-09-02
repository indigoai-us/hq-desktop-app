//! Tauri-free request engine for the native HQ macOS application.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use hq_engine_protocol::{
    method, CancelParams, CancelResult, ErrorBody, EventSequencer, HealthResult, RequestEnvelope,
    ResponseEnvelope, ShutdownResult, PROTOCOL_VERSION,
};
use serde::Serialize;
use serde_json::Value;

mod domains;
mod events;
mod parity;

pub use domains::local::CoreBackend;
pub use events::{EngineDomainEvent, EngineEventBus, DEFAULT_EVENT_BUS_CAPACITY};
pub use parity::*;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn capabilities() -> &'static [&'static str] {
    static CAPABILITIES: OnceLock<Vec<&'static str>> = OnceLock::new();
    CAPABILITIES
        .get_or_init(|| {
            let mut values = vec![
                "health",
                "cancel",
                "shutdown",
                "config.get",
                "get_config",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "get_sync_status",
                "projects.list",
                "get_local_projects",
                "get_local_project_prd",
                "get_local_project_readme",
                "get_local_company_goals",
                "get_company_crm_projection",
                "set_local_project_status",
                "set_local_story_passes",
                "get_library_root",
                "get_library_company",
                "get_library_worker_detail",
                "get_library_skill_detail",
                "get_company_file_tree",
                "get_company_file_content",
                "list_hq_dir",
                "sessions.list",
                "list_local_claude_sessions",
                "list_local_codex_sessions",
                "get_hq_version",
                "has_stored_token",
                "daemon_status",
                "get_settings",
                "save_settings",
                "create_directory",
                "check_writable",
                "detect_hq",
                "resolve_hq_path",
                "set_hq_install_path",
                "write_menubar_hq_path",
                "write_file",
                "make_dir",
                "read_text_file",
                "create_symlink",
                "desktop_alt_enabled",
                "desktop_alt_is_admin",
                "get_lifecycle_state",
                "is_first_run",
                "should_show_auto_sync_notice",
                "mark_first_run_complete",
                "mark_auto_sync_notice_shown",
                "write_menubar_telemetry_pref",
                "get_staging_source",
                "get_use_staging_source",
                "set_staging_source",
                "device_fingerprint",
                "read_install_manifest",
                "record_step_start",
                "record_step_ok",
                "record_step_failure",
                "record_dependencies",
                "record_packs",
                "record_import",
                "record_install_complete",
                "list_channels",
                "fetch_channel",
                "create_channel",
                "create_group_dm",
                "send_channel_message",
                "list_channel_members",
                "send_dm",
                "send_dm_to_email",
                "fetch_dm_thread",
                "list_dm_requests",
                "fetch_thread",
                "send_thread_reply",
                "fetch_reactions",
                "check_ai_tools",
                "detect_ai_tools",
                "list_session_history",
                "list_agent_sessions",
                "is_indigo_user",
                "personalize_hq",
                "get_company_summary",
                "get_company_board",
                "get_company_crm_projection_vault",
                "get_company_project_creators",
                "get_company_activity",
                "get_company_team_telemetry",
                "get_company_deployments",
                "get_company_secrets",
                "get_sync_mode",
                "set_sync_mode",
                "list_marketplace_listings",
                "get_marketplace_listing",
                "list_moderation_queue",
                "decide_moderation_listing",
                "yank_marketplace_listing",
                "request_creator_access",
                "list_creator_applications",
                "decide_creator_application",
                "claim_creator_handle",
                "update_creator_profile",
                "get_creator_profile",
                "get_my_creator",
                "record_marketplace_install",
                "publish_marketplace_pack",
                "upload_creator_avatar",
                "fetch_notification_history",
                "git_init",
                "git_probe_user",
                "refresh_tokens",
                "is_primary_instance",
                "recheck_primary_instance",
                "set_hq_cli_update_dismissed",
                "list_agency_teams",
                "list_agency_questions",
                "list_agency_chat",
                "answer_agency_question",
                "send_agency_message",
                "connect_workspace_to_cloud",
                "submit_bug_report",
                "meeting_detect_feature_enabled",
                "meetings_feature_enabled",
                "meetings_list_active_detections",
                "meetings_list_active_recordings",
                "meetings_list_upcoming",
                "meetings_list_accounts",
                "meetings_list_calendars_for_account",
                "meetings_list_scheduled_bots",
                "meetings_set_company",
                "meetings_invite_bot",
                "meetings_join_bot_now",
                "meetings_list_memberships",
                "meetings_cancel_bot",
                "meetings_check_bot_for_url",
                "start_oauth_login",
                "oauth_listen_for_code",
                "oauth_cancel_listen",
                "oauth_exchange_code",
                "get_auth_state",
                "sign_out",
                "start_recall_sdk",
                "start_recording",
                "stop_recording",
            ];
            for methods in [
                domains::local::IMPLEMENTED_METHODS,
                domains::cloud::IMPLEMENTED_METHODS,
                domains::node::IMPLEMENTED_METHODS,
                domains::meetings::IMPLEMENTED_METHODS,
                domains::oauth::IMPLEMENTED_METHODS,
                domains::recall::IMPLEMENTED_METHODS,
                domains::orchestration::IMPLEMENTED_METHODS,
            ] {
                for method in methods {
                    if !values.contains(method) {
                        values.push(method);
                    }
                }
            }
            values
        })
        .as_slice()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl EngineError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }

    pub fn cancelled() -> Self {
        Self::new("request_cancelled", "Request was cancelled", false)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancellationFlag {
    cancelled: Arc<AtomicBool>,
}

impl CancellationFlag {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn check(&self) -> Result<(), EngineError> {
        self.is_cancelled()
            .then(EngineError::cancelled)
            .map_or(Ok(()), Err)
    }
}

pub trait EngineBackend: Send + Sync + 'static {
    fn execute(
        &self,
        method: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError>;

    fn shutdown(&self) {}
}

pub struct Engine<B: EngineBackend> {
    backend: Arc<B>,
    application_version: String,
    started_at: Instant,
    shutting_down: AtomicBool,
    in_flight: Mutex<HashMap<String, CancellationFlag>>,
    events: EventSequencer,
}

impl<B: EngineBackend> Engine<B> {
    pub fn new(application_version: impl Into<String>, backend: B) -> Self {
        Self {
            backend: Arc::new(backend),
            application_version: application_version.into(),
            started_at: Instant::now(),
            shutting_down: AtomicBool::new(false),
            in_flight: Mutex::new(HashMap::new()),
            events: EventSequencer::default(),
        }
    }

    pub fn startup_handshake(&self) -> ResponseEnvelope {
        ResponseEnvelope::handshake(
            ENGINE_VERSION,
            &self.application_version,
            capabilities()
                .iter()
                .map(|method| (*method).to_string())
                .collect(),
        )
    }

    pub async fn handle(&self, request: RequestEnvelope) -> ResponseEnvelope {
        if request.protocol_version != PROTOCOL_VERSION {
            return response_error(
                Some(request.id),
                EngineError::new(
                    "unsupported_protocol_version",
                    format!(
                        "Protocol version {} is unsupported; expected {PROTOCOL_VERSION}",
                        request.protocol_version
                    ),
                    false,
                ),
            );
        }

        match request.method.as_str() {
            method::HEALTH => self.health(request.id),
            method::CANCEL => self.cancel(request.id, request.params),
            method::SHUTDOWN => self.shutdown(request.id).await,
            _ => self.execute_domain(request).await,
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    pub fn in_flight_count(&self) -> usize {
        lock_unpoisoned(&self.in_flight).len()
    }

    pub fn event(
        &self,
        id: Option<String>,
        event: impl Into<String>,
        data: impl Serialize,
    ) -> ResponseEnvelope {
        self.events.next(id, event, data)
    }

    /// Stop all lifecycle-owned work when the process host disappears without
    /// sending a protocol shutdown frame (for example, stdin EOF after an app
    /// crash or test interruption).
    pub async fn shutdown_for_host(&self) {
        let first_shutdown = !self.shutting_down.swap(true, Ordering::AcqRel);
        if first_shutdown {
            for cancellation in lock_unpoisoned(&self.in_flight).values() {
                cancellation.cancel();
            }
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            while !lock_unpoisoned(&self.in_flight).is_empty()
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            self.backend.shutdown();
        }
    }

    fn health(&self, id: String) -> ResponseEnvelope {
        let health = HealthResult {
            healthy: true,
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION.to_string(),
            uptime_ms: self
                .started_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            shutting_down: self.is_shutting_down(),
            in_flight_requests: self.in_flight_count(),
        };
        match to_value(health) {
            Ok(value) => ResponseEnvelope::pong(id, value),
            Err(error) => response_error(Some(id), error),
        }
    }

    fn cancel(&self, id: String, params: Value) -> ResponseEnvelope {
        let params: CancelParams = match serde_json::from_value::<CancelParams>(params) {
            Ok(params) if !params.request_id.trim().is_empty() => params,
            Ok(_) => {
                return response_error(
                    Some(id),
                    EngineError::new(
                        "invalid_params",
                        "cancel requires a non-empty `requestId`",
                        false,
                    ),
                );
            }
            Err(error) => {
                return response_error(
                    Some(id),
                    EngineError::new(
                        "invalid_params",
                        format!("cancel params are invalid: {error}"),
                        false,
                    ),
                );
            }
        };

        let cancelled = lock_unpoisoned(&self.in_flight)
            .get(&params.request_id)
            .map(|flag| {
                flag.cancel();
                true
            })
            .unwrap_or(false);
        match to_value(CancelResult {
            request_id: params.request_id,
            cancelled,
        }) {
            Ok(value) => ResponseEnvelope::result(id, value),
            Err(error) => response_error(Some(id), error),
        }
    }

    async fn shutdown(&self, id: String) -> ResponseEnvelope {
        self.shutdown_for_host().await;
        match to_value(ShutdownResult { accepted: true }) {
            Ok(value) => ResponseEnvelope::end(id, value),
            Err(error) => response_error(Some(id), error),
        }
    }

    async fn execute_domain(&self, request: RequestEnvelope) -> ResponseEnvelope {
        if self.is_shutting_down() {
            return response_error(
                Some(request.id),
                EngineError::new(
                    "engine_shutting_down",
                    "Engine is shutting down and is not accepting new work",
                    true,
                ),
            );
        }
        if !domains::is_implemented(request.method.as_str()) {
            return response_error(
                Some(request.id),
                EngineError::new(
                    "method_not_found",
                    format!("Method `{}` is not implemented", request.method),
                    false,
                ),
            );
        }

        let cancellation = CancellationFlag::default();
        {
            let mut in_flight = lock_unpoisoned(&self.in_flight);
            if in_flight.contains_key(&request.id) {
                return response_error(
                    Some(request.id),
                    EngineError::new(
                        "duplicate_request_id",
                        "A request with this id is already in flight",
                        false,
                    ),
                );
            }
            in_flight.insert(request.id.clone(), cancellation.clone());
        }

        let backend = self.backend.clone();
        let id = request.id;
        let method = request.method;
        let params = request.params;
        let worker_cancellation = cancellation.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            backend.execute(&method, &params, &worker_cancellation)
        })
        .await;
        lock_unpoisoned(&self.in_flight).remove(&id);

        match outcome {
            Ok(Ok(_value)) if cancellation.is_cancelled() => {
                response_error(Some(id), EngineError::cancelled())
            }
            Ok(Ok(value)) => ResponseEnvelope::result(id, value),
            Ok(Err(error)) => response_error(Some(id), error),
            Err(error) => response_error(
                Some(id),
                EngineError::new(
                    "engine_task_failed",
                    format!("Engine worker failed: {error}"),
                    false,
                ),
            ),
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn to_value(value: impl Serialize) -> Result<Value, EngineError> {
    serde_json::to_value(value).map_err(|error| {
        EngineError::new(
            "response_encoding_failed",
            format!("Engine response could not be encoded: {error}"),
            false,
        )
    })
}

fn response_error(id: Option<String>, error: EngineError) -> ResponseEnvelope {
    ResponseEnvelope::error(
        id,
        ErrorBody::new(error.code, error.message, error.retryable),
    )
}
