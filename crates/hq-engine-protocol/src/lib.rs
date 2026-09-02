//! Versioned NDJSON contract shared by the native macOS client and HQ engine.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

pub mod method {
    pub const HEALTH: &str = "health";
    pub const CANCEL: &str = "cancel";
    pub const SHUTDOWN: &str = "shutdown";
    pub const CONFIG_GET: &str = "config.get";
    pub const LEGACY_GET_CONFIG: &str = "get_config";
    pub const AUTH_STATE: &str = "auth.state";
    pub const WORKSPACES_LIST: &str = "workspaces.list";
    pub const SYNC_STATUS: &str = "sync.status";
    pub const LEGACY_GET_SYNC_STATUS: &str = "get_sync_status";
    pub const PROJECTS_LIST: &str = "projects.list";
    pub const LEGACY_GET_LOCAL_PROJECTS: &str = "get_local_projects";
    pub const GET_LOCAL_PROJECT_PRD: &str = "get_local_project_prd";
    pub const GET_LOCAL_PROJECT_README: &str = "get_local_project_readme";
    pub const GET_LOCAL_COMPANY_GOALS: &str = "get_local_company_goals";
    pub const GET_COMPANY_CRM_PROJECTION: &str = "get_company_crm_projection";
    pub const SET_LOCAL_PROJECT_STATUS: &str = "set_local_project_status";
    pub const SET_LOCAL_STORY_PASSES: &str = "set_local_story_passes";
    pub const GET_LIBRARY_ROOT: &str = "get_library_root";
    pub const GET_LIBRARY_COMPANY: &str = "get_library_company";
    pub const GET_LIBRARY_WORKER_DETAIL: &str = "get_library_worker_detail";
    pub const GET_LIBRARY_SKILL_DETAIL: &str = "get_library_skill_detail";
    pub const GET_COMPANY_FILE_TREE: &str = "get_company_file_tree";
    pub const GET_COMPANY_FILE_CONTENT: &str = "get_company_file_content";
    pub const LIST_HQ_DIR: &str = "list_hq_dir";
    pub const SESSIONS_LIST: &str = "sessions.list";
    pub const LIST_LOCAL_CLAUDE_SESSIONS: &str = "list_local_claude_sessions";
    pub const LIST_LOCAL_CODEX_SESSIONS: &str = "list_local_codex_sessions";
    pub const GET_HQ_VERSION: &str = "get_hq_version";
    pub const HAS_STORED_TOKEN: &str = "has_stored_token";
    pub const DAEMON_STATUS: &str = "daemon_status";
    pub const GET_SETTINGS: &str = "get_settings";
    pub const SAVE_SETTINGS: &str = "save_settings";
    pub const CREATE_DIRECTORY: &str = "create_directory";
    pub const CHECK_WRITABLE: &str = "check_writable";
    pub const DETECT_HQ: &str = "detect_hq";
    pub const RESOLVE_HQ_PATH: &str = "resolve_hq_path";
    pub const SET_HQ_INSTALL_PATH: &str = "set_hq_install_path";
    pub const WRITE_MENUBAR_HQ_PATH: &str = "write_menubar_hq_path";
    pub const WRITE_FILE: &str = "write_file";
    pub const MAKE_DIR: &str = "make_dir";
    pub const READ_TEXT_FILE: &str = "read_text_file";
    pub const CREATE_SYMLINK: &str = "create_symlink";
    pub const DESKTOP_ALT_ENABLED: &str = "desktop_alt_enabled";
    pub const DESKTOP_ALT_IS_ADMIN: &str = "desktop_alt_is_admin";
    pub const GET_LIFECYCLE_STATE: &str = "get_lifecycle_state";
    pub const IS_FIRST_RUN: &str = "is_first_run";
    pub const SHOULD_SHOW_AUTO_SYNC_NOTICE: &str = "should_show_auto_sync_notice";
    pub const MARK_FIRST_RUN_COMPLETE: &str = "mark_first_run_complete";
    pub const MARK_AUTO_SYNC_NOTICE_SHOWN: &str = "mark_auto_sync_notice_shown";
    pub const WRITE_MENUBAR_TELEMETRY_PREF: &str = "write_menubar_telemetry_pref";
    pub const GET_STAGING_SOURCE: &str = "get_staging_source";
    pub const GET_USE_STAGING_SOURCE: &str = "get_use_staging_source";
    pub const SET_STAGING_SOURCE: &str = "set_staging_source";
    pub const DEVICE_FINGERPRINT: &str = "device_fingerprint";
    pub const READ_INSTALL_MANIFEST: &str = "read_install_manifest";
    pub const RECORD_STEP_START: &str = "record_step_start";
    pub const RECORD_STEP_OK: &str = "record_step_ok";
    pub const RECORD_STEP_FAILURE: &str = "record_step_failure";
    pub const RECORD_DEPENDENCIES: &str = "record_dependencies";
    pub const RECORD_PACKS: &str = "record_packs";
    pub const RECORD_IMPORT: &str = "record_import";
    pub const RECORD_INSTALL_COMPLETE: &str = "record_install_complete";
    pub const LIST_CHANNELS: &str = "list_channels";
    pub const FETCH_CHANNEL: &str = "fetch_channel";
    pub const CREATE_CHANNEL: &str = "create_channel";
    pub const CREATE_GROUP_DM: &str = "create_group_dm";
    pub const SEND_CHANNEL_MESSAGE: &str = "send_channel_message";
    pub const LIST_CHANNEL_MEMBERS: &str = "list_channel_members";
    pub const SEND_DM: &str = "send_dm";
    pub const SEND_DM_TO_EMAIL: &str = "send_dm_to_email";
    pub const FETCH_DM_THREAD: &str = "fetch_dm_thread";
    pub const LIST_DM_REQUESTS: &str = "list_dm_requests";
    pub const FETCH_THREAD: &str = "fetch_thread";
    pub const SEND_THREAD_REPLY: &str = "send_thread_reply";
    pub const FETCH_REACTIONS: &str = "fetch_reactions";
    pub const CHECK_AI_TOOLS: &str = "check_ai_tools";
    pub const DETECT_AI_TOOLS: &str = "detect_ai_tools";
    pub const LIST_SESSION_HISTORY: &str = "list_session_history";
    pub const LIST_AGENT_SESSIONS: &str = "list_agent_sessions";
    pub const IS_INDIGO_USER: &str = "is_indigo_user";
    pub const PERSONALIZE_HQ: &str = "personalize_hq";
    pub const GET_COMPANY_SUMMARY: &str = "get_company_summary";
    pub const GET_COMPANY_BOARD: &str = "get_company_board";
    pub const GET_COMPANY_CRM_PROJECTION_VAULT: &str = "get_company_crm_projection_vault";
    pub const GET_COMPANY_PROJECT_CREATORS: &str = "get_company_project_creators";
    pub const GET_COMPANY_ACTIVITY: &str = "get_company_activity";
    pub const GET_COMPANY_TEAM_TELEMETRY: &str = "get_company_team_telemetry";
    pub const GET_COMPANY_DEPLOYMENTS: &str = "get_company_deployments";
    pub const GET_COMPANY_SECRETS: &str = "get_company_secrets";
    pub const GET_SYNC_MODE: &str = "get_sync_mode";
    pub const SET_SYNC_MODE: &str = "set_sync_mode";
    pub const LIST_MARKETPLACE_LISTINGS: &str = "list_marketplace_listings";
    pub const GET_MARKETPLACE_LISTING: &str = "get_marketplace_listing";
    pub const LIST_MODERATION_QUEUE: &str = "list_moderation_queue";
    pub const DECIDE_MODERATION_LISTING: &str = "decide_moderation_listing";
    pub const YANK_MARKETPLACE_LISTING: &str = "yank_marketplace_listing";
    pub const REQUEST_CREATOR_ACCESS: &str = "request_creator_access";
    pub const LIST_CREATOR_APPLICATIONS: &str = "list_creator_applications";
    pub const DECIDE_CREATOR_APPLICATION: &str = "decide_creator_application";
    pub const CLAIM_CREATOR_HANDLE: &str = "claim_creator_handle";
    pub const UPDATE_CREATOR_PROFILE: &str = "update_creator_profile";
    pub const GET_CREATOR_PROFILE: &str = "get_creator_profile";
    pub const GET_MY_CREATOR: &str = "get_my_creator";
    pub const RECORD_MARKETPLACE_INSTALL: &str = "record_marketplace_install";
    pub const PUBLISH_MARKETPLACE_PACK: &str = "publish_marketplace_pack";
    pub const UPLOAD_CREATOR_AVATAR: &str = "upload_creator_avatar";
    pub const FETCH_NOTIFICATION_HISTORY: &str = "fetch_notification_history";
    pub const GIT_INIT: &str = "git_init";
    pub const GIT_PROBE_USER: &str = "git_probe_user";
    pub const BEGIN_REAUTH: &str = "begin_reauth";
    pub const REFRESH_TOKENS: &str = "refresh_tokens";
    pub const IS_PRIMARY_INSTANCE: &str = "is_primary_instance";
    pub const RECHECK_PRIMARY_INSTANCE: &str = "recheck_primary_instance";
    pub const SET_HQ_CLI_UPDATE_DISMISSED: &str = "set_hq_cli_update_dismissed";
    pub const LIST_AGENCY_TEAMS: &str = "list_agency_teams";
    pub const LIST_AGENCY_QUESTIONS: &str = "list_agency_questions";
    pub const LIST_AGENCY_CHAT: &str = "list_agency_chat";
    pub const ANSWER_AGENCY_QUESTION: &str = "answer_agency_question";
    pub const SEND_AGENCY_MESSAGE: &str = "send_agency_message";
    pub const CONNECT_WORKSPACE_TO_CLOUD: &str = "connect_workspace_to_cloud";
    pub const SUBMIT_BUG_REPORT: &str = "submit_bug_report";
    pub const MEETING_DETECT_FEATURE_ENABLED: &str = "meeting_detect_feature_enabled";
    pub const MEETINGS_FEATURE_ENABLED: &str = "meetings_feature_enabled";
    pub const MEETINGS_LIST_ACTIVE_DETECTIONS: &str = "meetings_list_active_detections";
    pub const MEETINGS_LIST_ACTIVE_RECORDINGS: &str = "meetings_list_active_recordings";
    pub const MEETINGS_LIST_UPCOMING: &str = "meetings_list_upcoming";
    pub const MEETINGS_LIST_ACCOUNTS: &str = "meetings_list_accounts";
    pub const MEETINGS_LIST_CALENDARS_FOR_ACCOUNT: &str = "meetings_list_calendars_for_account";
    pub const MEETINGS_LIST_SCHEDULED_BOTS: &str = "meetings_list_scheduled_bots";
    pub const MEETINGS_SET_COMPANY: &str = "meetings_set_company";
    pub const MEETINGS_INVITE_BOT: &str = "meetings_invite_bot";
    pub const MEETINGS_JOIN_BOT_NOW: &str = "meetings_join_bot_now";
    pub const MEETINGS_LIST_MEMBERSHIPS: &str = "meetings_list_memberships";
    pub const MEETINGS_CANCEL_BOT: &str = "meetings_cancel_bot";
    pub const MEETINGS_CHECK_BOT_FOR_URL: &str = "meetings_check_bot_for_url";
    pub const START_OAUTH_LOGIN: &str = "start_oauth_login";
    pub const OAUTH_LISTEN_FOR_CODE: &str = "oauth_listen_for_code";
    pub const OAUTH_CANCEL_LISTEN: &str = "oauth_cancel_listen";
    pub const OAUTH_EXCHANGE_CODE: &str = "oauth_exchange_code";
    pub const START_RECALL_SDK: &str = "start_recall_sdk";
    pub const START_RECORDING: &str = "start_recording";
    pub const STOP_RECORDING: &str = "stop_recording";
    pub const SET_WORKSPACE_SYNC_ENABLED: &str = "set_workspace_sync_enabled";
    pub const TAKE_PENDING_MESSAGES_TARGET: &str = "take_pending_messages_target";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub protocol_version: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    Handshake,
    Result,
    Error,
    Event,
    Pong,
    End,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub protocol_version: u32,
    pub id: Option<String>,
    pub kind: EnvelopeKind,
    pub sequence: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<ErrorBody>,
    pub event: Option<String>,
    pub data: Option<Value>,
}

impl ResponseEnvelope {
    pub fn result(id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: Some(id.into()),
            kind: EnvelopeKind::Result,
            sequence: None,
            result: Some(result),
            error: None,
            event: None,
            data: None,
        }
    }

    pub fn error(id: Option<String>, error: ErrorBody) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id,
            kind: EnvelopeKind::Error,
            sequence: None,
            result: None,
            error: Some(error),
            event: None,
            data: None,
        }
    }

    pub fn handshake(
        engine_version: impl Into<String>,
        application_version: impl Into<String>,
        capabilities: Vec<String>,
    ) -> Self {
        let result = HandshakeResult {
            engine_version: engine_version.into(),
            application_version: application_version.into(),
            capabilities,
        };
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: None,
            kind: EnvelopeKind::Handshake,
            sequence: Some(0),
            result: Some(
                serde_json::to_value(result)
                    .expect("serializing the fixed handshake schema cannot fail"),
            ),
            error: None,
            event: None,
            data: None,
        }
    }

    pub fn pong(id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: Some(id.into()),
            kind: EnvelopeKind::Pong,
            sequence: None,
            result: Some(result),
            error: None,
            event: None,
            data: None,
        }
    }

    pub fn end(id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: Some(id.into()),
            kind: EnvelopeKind::End,
            sequence: None,
            result: Some(result),
            error: None,
            event: None,
            data: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ErrorBody {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    pub engine_version: String,
    pub application_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub healthy: bool,
    pub protocol_version: u32,
    pub engine_version: String,
    pub uptime_ms: u64,
    pub shutting_down: bool,
    pub in_flight_requests: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub request_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResult {
    pub accepted: bool,
}

#[derive(Debug, Default)]
pub struct EventSequencer {
    sequence: AtomicU64,
}

impl EventSequencer {
    pub fn next(
        &self,
        id: Option<String>,
        event: impl Into<String>,
        data: impl Serialize,
    ) -> ResponseEnvelope {
        let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let data = serde_json::to_value(data)
            .expect("serializing an event payload supplied by the engine cannot fail");
        ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            id,
            kind: EnvelopeKind::Event,
            sequence: Some(sequence),
            result: None,
            error: None,
            event: Some(event.into()),
            data: Some(data),
        }
    }

    pub fn current(&self) -> u64 {
        self.sequence.load(Ordering::Acquire)
    }
}

pub fn decode_request_line(line: &str) -> Result<RequestEnvelope, ErrorBody> {
    let request: RequestEnvelope = serde_json::from_str(line).map_err(|error| {
        ErrorBody::new(
            "invalid_request",
            format!("Request is not one valid JSON object: {error}"),
            false,
        )
    })?;

    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ErrorBody::new(
            "unsupported_protocol_version",
            format!(
                "Protocol version {} is unsupported; expected {PROTOCOL_VERSION}",
                request.protocol_version
            ),
            false,
        ));
    }
    if request.id.trim().is_empty() {
        return Err(ErrorBody::new(
            "invalid_request",
            "Request id must be a non-empty string",
            false,
        ));
    }
    if request.method.trim().is_empty() {
        return Err(ErrorBody::new(
            "invalid_request",
            "Request method must be a non-empty string",
            false,
        ));
    }

    Ok(request)
}

pub fn encode_response_line(response: &ResponseEnvelope) -> Result<String, ErrorBody> {
    let mut encoded = serde_json::to_string(response).map_err(|error| {
        ErrorBody::new(
            "response_encoding_failed",
            format!("Response could not be encoded: {error}"),
            false,
        )
    })?;
    encoded.push('\n');
    Ok(encoded)
}
