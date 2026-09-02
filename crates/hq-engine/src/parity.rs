use std::collections::BTreeMap;

use hq_engine_protocol::method;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParityDependency {
    LocalOrchestration,
    CloudRuntime,
    NodeRuntime,
    RecallRuntime,
    GStreamerRuntime,
    NativeRuntime,
}

impl ParityDependency {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalOrchestration => "localOrchestration",
            Self::CloudRuntime => "cloudRuntime",
            Self::NodeRuntime => "nodeRuntime",
            Self::RecallRuntime => "recallRuntime",
            Self::GStreamerRuntime => "gstreamerRuntime",
            Self::NativeRuntime => "nativeRuntime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParityCommandStatus {
    Implemented {
        method: &'static str,
    },
    Blocked {
        dependency: ParityDependency,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParityCommandRegistration {
    pub legacy_command: &'static str,
    pub status: ParityCommandStatus,
}

const PARITY_ENGINE_COMMANDS: &str = include_str!("../parity-engine-commands.txt");

pub fn registered_parity_command_names() -> impl Iterator<Item = &'static str> {
    PARITY_ENGINE_COMMANDS
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}

pub fn parity_command_registration(legacy_command: &str) -> Option<ParityCommandRegistration> {
    let legacy_command =
        registered_parity_command_names().find(|registered| *registered == legacy_command)?;
    let status = if implemented_command(legacy_command) {
        ParityCommandStatus::Implemented {
            method: legacy_command,
        }
    } else {
        let dependency = blocked_command_dependency(legacy_command);
        ParityCommandStatus::Blocked {
            dependency,
            reason: dependency_blocker(dependency),
        }
    };
    Some(ParityCommandRegistration {
        legacy_command,
        status,
    })
}

pub fn blocked_parity_command_names(dependency: Option<ParityDependency>) -> Vec<&'static str> {
    registered_parity_command_names()
        .filter(|command| {
            matches!(
                parity_command_registration(command).map(|registration| registration.status),
                Some(ParityCommandStatus::Blocked {
                    dependency: command_dependency,
                    ..
                }) if dependency.is_none_or(|requested| requested == command_dependency)
            )
        })
        .collect()
}

fn implemented_command(command: &str) -> bool {
    crate::domains::is_implemented(command)
        || matches!(
            command,
            method::LEGACY_GET_CONFIG
                | method::LEGACY_GET_SYNC_STATUS
                | method::LEGACY_GET_LOCAL_PROJECTS
                | method::GET_LOCAL_PROJECT_PRD
                | method::GET_LOCAL_PROJECT_README
                | method::GET_LOCAL_COMPANY_GOALS
                | method::GET_COMPANY_CRM_PROJECTION
                | method::SET_LOCAL_PROJECT_STATUS
                | method::SET_LOCAL_STORY_PASSES
                | method::GET_LIBRARY_ROOT
                | method::GET_LIBRARY_COMPANY
                | method::GET_LIBRARY_WORKER_DETAIL
                | method::GET_LIBRARY_SKILL_DETAIL
                | method::GET_COMPANY_FILE_TREE
                | method::GET_COMPANY_FILE_CONTENT
                | method::LIST_HQ_DIR
                | method::LIST_LOCAL_CLAUDE_SESSIONS
                | method::LIST_LOCAL_CODEX_SESSIONS
                | method::GET_HQ_VERSION
                | method::HAS_STORED_TOKEN
                | method::DAEMON_STATUS
                | method::GET_SETTINGS
                | method::SAVE_SETTINGS
                | method::CREATE_DIRECTORY
                | method::CHECK_WRITABLE
                | method::DETECT_HQ
                | method::RESOLVE_HQ_PATH
                | method::SET_HQ_INSTALL_PATH
                | method::WRITE_MENUBAR_HQ_PATH
                | method::WRITE_FILE
                | method::MAKE_DIR
                | method::READ_TEXT_FILE
                | method::CREATE_SYMLINK
                | method::DESKTOP_ALT_ENABLED
                | method::DESKTOP_ALT_IS_ADMIN
                | method::GET_LIFECYCLE_STATE
                | method::IS_FIRST_RUN
                | method::SHOULD_SHOW_AUTO_SYNC_NOTICE
                | method::MARK_FIRST_RUN_COMPLETE
                | method::MARK_AUTO_SYNC_NOTICE_SHOWN
                | method::WRITE_MENUBAR_TELEMETRY_PREF
                | method::GET_STAGING_SOURCE
                | method::GET_USE_STAGING_SOURCE
                | method::SET_STAGING_SOURCE
                | method::DEVICE_FINGERPRINT
                | method::READ_INSTALL_MANIFEST
                | method::RECORD_STEP_START
                | method::RECORD_STEP_OK
                | method::RECORD_STEP_FAILURE
                | method::RECORD_DEPENDENCIES
                | method::RECORD_PACKS
                | method::RECORD_IMPORT
                | method::RECORD_INSTALL_COMPLETE
                | method::LIST_CHANNELS
                | method::FETCH_CHANNEL
                | method::CREATE_CHANNEL
                | method::CREATE_GROUP_DM
                | method::SEND_CHANNEL_MESSAGE
                | method::LIST_CHANNEL_MEMBERS
                | method::SEND_DM
                | method::SEND_DM_TO_EMAIL
                | method::FETCH_DM_THREAD
                | method::LIST_DM_REQUESTS
                | method::FETCH_THREAD
                | method::SEND_THREAD_REPLY
                | method::FETCH_REACTIONS
                | method::CHECK_AI_TOOLS
                | method::DETECT_AI_TOOLS
                | method::LIST_SESSION_HISTORY
                | method::LIST_AGENT_SESSIONS
                | method::IS_INDIGO_USER
                | method::PERSONALIZE_HQ
                | method::GET_COMPANY_SUMMARY
                | method::GET_COMPANY_BOARD
                | method::GET_COMPANY_CRM_PROJECTION_VAULT
                | method::GET_COMPANY_PROJECT_CREATORS
                | method::GET_COMPANY_ACTIVITY
                | method::GET_COMPANY_TEAM_TELEMETRY
                | method::GET_COMPANY_DEPLOYMENTS
                | method::GET_COMPANY_SECRETS
                | method::GET_SYNC_MODE
                | method::SET_SYNC_MODE
                | method::LIST_MARKETPLACE_LISTINGS
                | method::GET_MARKETPLACE_LISTING
                | method::LIST_MODERATION_QUEUE
                | method::DECIDE_MODERATION_LISTING
                | method::YANK_MARKETPLACE_LISTING
                | method::REQUEST_CREATOR_ACCESS
                | method::LIST_CREATOR_APPLICATIONS
                | method::DECIDE_CREATOR_APPLICATION
                | method::CLAIM_CREATOR_HANDLE
                | method::UPDATE_CREATOR_PROFILE
                | method::GET_CREATOR_PROFILE
                | method::GET_MY_CREATOR
                | method::RECORD_MARKETPLACE_INSTALL
                | method::PUBLISH_MARKETPLACE_PACK
                | method::UPLOAD_CREATOR_AVATAR
                | method::FETCH_NOTIFICATION_HISTORY
                | method::GIT_INIT
                | method::GIT_PROBE_USER
                | method::REFRESH_TOKENS
                | method::IS_PRIMARY_INSTANCE
                | method::RECHECK_PRIMARY_INSTANCE
                | method::SET_HQ_CLI_UPDATE_DISMISSED
                | method::LIST_AGENCY_TEAMS
                | method::LIST_AGENCY_QUESTIONS
                | method::LIST_AGENCY_CHAT
                | method::ANSWER_AGENCY_QUESTION
                | method::SEND_AGENCY_MESSAGE
                | method::CONNECT_WORKSPACE_TO_CLOUD
                | method::SUBMIT_BUG_REPORT
                | method::MEETING_DETECT_FEATURE_ENABLED
                | method::MEETINGS_FEATURE_ENABLED
                | method::MEETINGS_LIST_ACTIVE_DETECTIONS
                | method::MEETINGS_LIST_ACTIVE_RECORDINGS
                | method::MEETINGS_LIST_UPCOMING
                | method::MEETINGS_LIST_ACCOUNTS
                | method::MEETINGS_LIST_CALENDARS_FOR_ACCOUNT
                | method::MEETINGS_LIST_SCHEDULED_BOTS
                | method::MEETINGS_SET_COMPANY
                | method::MEETINGS_INVITE_BOT
                | method::MEETINGS_JOIN_BOT_NOW
                | method::MEETINGS_LIST_MEMBERSHIPS
                | method::MEETINGS_CANCEL_BOT
                | method::MEETINGS_CHECK_BOT_FOR_URL
                | method::START_OAUTH_LOGIN
                | method::OAUTH_LISTEN_FOR_CODE
                | method::OAUTH_CANCEL_LISTEN
                | method::OAUTH_EXCHANGE_CODE
                | "get_auth_state"
                | "sign_out"
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParityEventStatus {
    Delivered {
        producer: &'static str,
        subscriber: &'static str,
    },
    Blocked {
        dependency: ParityDependency,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParityEventRegistration {
    pub event: &'static str,
    pub status: ParityEventStatus,
}

const PARITY_ENGINE_EVENTS: &str = include_str!("../parity-engine-events.txt");

pub fn registered_parity_event_names() -> impl Iterator<Item = &'static str> {
    PARITY_ENGINE_EVENTS
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}

pub fn emitted_parity_event_names() -> &'static [&'static str] {
    &[
        "activity:append",
        "activity:list",
        "auth:reauth-required",
        "channel:new-message",
        "channel:updated",
        "content:progress",
        "core-state:changed",
        "dm:new-events",
        "dm:request-new",
        "dm:request-update",
        "dm:unread-summary",
        "drift:report",
        "hq-cli-update:available",
        "hq-cli-update:cleared",
        "install:progress",
        "marketplace:install-complete",
        "marketplace:install-error",
        "marketplace:install-progress",
        "marketplace:publish-progress",
        "meeting:closed",
        "meeting:detected",
        "message:reaction",
        "pack-update:available",
        "pack-update:cleared",
        "packages:complete",
        "packages:error",
        "packages:progress",
        "packages:updates",
        "recording:ended",
        "recording:error",
        "recording:started",
        "share:events-list",
        "sync:auth-error",
        "sync:complete",
        "sync:error",
        "sync:external-idle",
        "sync:external-progress",
        "sync:fanout-plan",
        "sync:personal-first-push-complete",
        "sync:personal-first-push-progress",
        "sync:personal-first-push-scan",
        "sync:plan",
        "sync:progress",
        "sync:setup-needed",
        "sync:totals",
        "thread:new-reply",
    ]
}

pub fn subscribed_parity_event_names() -> &'static [&'static str] {
    &[
        "activity:append",
        "activity:list",
        "auth:reauth-required",
        "channel:new-message",
        "channel:updated",
        "content:progress",
        "core-state:changed",
        "dm:new-events",
        "dm:request-new",
        "dm:request-update",
        "dm:unread-summary",
        "drift:report",
        "hq-cli-update:available",
        "hq-cli-update:cleared",
        "install:progress",
        "marketplace:install-complete",
        "marketplace:install-error",
        "marketplace:install-progress",
        "marketplace:publish-progress",
        "meeting:closed",
        "meeting:detected",
        "message:reaction",
        "pack-update:available",
        "pack-update:cleared",
        "packages:complete",
        "packages:error",
        "packages:progress",
        "packages:updates",
        "recording:ended",
        "recording:error",
        "recording:started",
        "share:events-list",
        "sync:auth-error",
        "sync:complete",
        "sync:error",
        "sync:external-idle",
        "sync:external-progress",
        "sync:fanout-plan",
        "sync:personal-first-push-complete",
        "sync:personal-first-push-progress",
        "sync:personal-first-push-scan",
        "sync:plan",
        "sync:progress",
        "sync:setup-needed",
        "sync:totals",
        "thread:new-reply",
    ]
}

pub fn parity_event_registration(event: &str) -> Option<ParityEventRegistration> {
    let event = registered_parity_event_names().find(|registered| *registered == event)?;
    if emitted_parity_event_names().contains(&event)
        && subscribed_parity_event_names().contains(&event)
    {
        return Some(ParityEventRegistration {
            event,
            status: ParityEventStatus::Delivered {
                producer: event_producer(event),
                subscriber: "HQAppStore.receiveEngineEvent",
            },
        });
    }
    let dependency = blocked_event_dependency(event);
    Some(ParityEventRegistration {
        event,
        status: ParityEventStatus::Blocked {
            dependency,
            reason: dependency_blocker(dependency),
        },
    })
}

fn event_producer(event: &str) -> &'static str {
    if event.starts_with("activity:") {
        "CoreBackend.record_sync_activity"
    } else if event == "auth:reauth-required" {
        "orchestration::execute_begin_reauth"
    } else if event == "dm:request-update" {
        "cloud::execute"
    } else if event.starts_with("channel:")
        || event.starts_with("dm:")
        || event.starts_with("message:")
        || event.starts_with("share:")
        || event.starts_with("thread:")
    {
        "cloud::realtime"
    } else if matches!(event, "core-state:changed" | "drift:report") {
        "node::check_core_state"
    } else if event == "marketplace:publish-progress" {
        "cloud::execute_with_publish_progress"
    } else if event.starts_with("marketplace:install-") {
        "node::install_marketplace_pack"
    } else if event.starts_with("sync:external-") {
        "node::ExternalSyncProgressWatcher"
    } else if event.starts_with("sync:") {
        "node::StreamEventMode"
    } else if event == "content:progress" {
        "node::ContentDownloadEmitter"
    } else if event.starts_with("hq-cli-update:")
        || event == "install:progress"
        || event.starts_with("pack-update:")
        || event.starts_with("packages:")
    {
        "node::execute"
    } else {
        "recall::RecallController"
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandParitySummary {
    pub total: usize,
    pub implemented: usize,
    pub blocked: usize,
    pub blocked_by_dependency: BTreeMap<&'static str, usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventParitySummary {
    pub total: usize,
    pub delivered: usize,
    pub blocked: usize,
    pub blocked_by_dependency: BTreeMap<&'static str, usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParitySummary {
    pub commands: CommandParitySummary,
    pub events: EventParitySummary,
}

pub fn parity_summary() -> ParitySummary {
    let mut commands = CommandParitySummary {
        total: 0,
        implemented: 0,
        blocked: 0,
        blocked_by_dependency: BTreeMap::new(),
    };
    for command in registered_parity_command_names() {
        commands.total += 1;
        match parity_command_registration(command)
            .expect("registered command must resolve")
            .status
        {
            ParityCommandStatus::Implemented { .. } => commands.implemented += 1,
            ParityCommandStatus::Blocked { dependency, .. } => {
                commands.blocked += 1;
                *commands
                    .blocked_by_dependency
                    .entry(dependency.as_str())
                    .or_default() += 1;
            }
        }
    }

    let mut events = EventParitySummary {
        total: 0,
        delivered: 0,
        blocked: 0,
        blocked_by_dependency: BTreeMap::new(),
    };
    for event in registered_parity_event_names() {
        events.total += 1;
        match parity_event_registration(event)
            .expect("registered event must resolve")
            .status
        {
            ParityEventStatus::Delivered { .. } => events.delivered += 1,
            ParityEventStatus::Blocked { dependency, .. } => {
                events.blocked += 1;
                *events
                    .blocked_by_dependency
                    .entry(dependency.as_str())
                    .or_default() += 1;
            }
        }
    }

    ParitySummary { commands, events }
}

fn blocked_event_dependency(event: &str) -> ParityDependency {
    if event.starts_with("recording:") {
        ParityDependency::GStreamerRuntime
    } else if event.starts_with("meeting:")
        || event.starts_with("meetings:")
        || event.starts_with("meetings-window:")
        || event == "popover:meetings-snapshot"
        || event == "notification:meeting-action"
    {
        ParityDependency::RecallRuntime
    } else if event.starts_with("sync:")
        || event.starts_with("packages:")
        || event.starts_with("content:")
        || event.starts_with("install:")
        || event.starts_with("hq-cli-update:")
        || event.starts_with("pack-update:")
    {
        ParityDependency::NodeRuntime
    } else if event == "auth:reauth-required"
        || event.starts_with("channel:")
        || event.starts_with("dm:")
        || event.starts_with("message:")
        || event.starts_with("messages:")
        || event.starts_with("share:")
        || event.starts_with("thread:")
        || event.starts_with("marketplace:")
        || matches!(
            event,
            "notification:dm-action" | "notification:share-action"
        )
    {
        ParityDependency::CloudRuntime
    } else if event.starts_with("tray:") || event == "popover:opened" {
        ParityDependency::NativeRuntime
    } else {
        ParityDependency::LocalOrchestration
    }
}

pub(crate) fn blocked_command_dependency(command: &str) -> ParityDependency {
    if command.starts_with("meetings_")
        || matches!(
            command,
            "meeting_detect_feature_enabled" | "start_recall_sdk"
        )
    {
        ParityDependency::RecallRuntime
    } else if matches!(command, "start_recording" | "stop_recording") {
        ParityDependency::GStreamerRuntime
    } else if command.starts_with("install_")
        || command.starts_with("check_dep")
        || command.starts_with("check_hq_cli")
        || command.starts_with("check_pack")
        || command.starts_with("check_package")
        || command.starts_with("update_pack")
        || command.starts_with("update_package")
        || matches!(
            command,
            "cancel_process"
                | "spawn_process"
                | "start_daemon"
                | "stop_daemon"
                | "start_sync"
                | "cancel_sync"
                | "fetch_and_extract_template"
                | "register_search_index"
        )
    {
        ParityDependency::NodeRuntime
    } else if command.starts_with("get_company_")
        && !matches!(
            command,
            method::GET_COMPANY_CRM_PROJECTION
                | method::GET_COMPANY_FILE_CONTENT
                | method::GET_COMPANY_FILE_TREE
        )
        || command.starts_with("create_channel")
        || command.starts_with("create_group_dm")
        || command.starts_with("fetch_")
        || command.starts_with("send_")
        || command.starts_with("list_channel")
        || command.starts_with("list_dm")
        || command.starts_with("list_marketplace")
        || command.starts_with("poll_")
        || command.starts_with("publish_marketplace")
        || command.starts_with("oauth_")
        || matches!(
            command,
            "connect_workspace_to_cloud"
                | "get_sync_mode"
                | "set_sync_mode"
                | "refresh_tokens"
                | "start_oauth_login"
                | "start_initial_cloud_sync"
                | "submit_bug_report"
                | "upload_creator_avatar"
        )
    {
        ParityDependency::CloudRuntime
    } else if matches!(
        command,
        "set_main_window_vibrancy"
            | "show_main_window_at_tray"
            | "open_in_editor"
            | "pick_avatar_file"
            | "pick_pack_directory"
            | "install_menubar_app"
            | "take_pending_messages_target"
    ) {
        ParityDependency::NativeRuntime
    } else {
        ParityDependency::LocalOrchestration
    }
}

fn dependency_blocker(dependency: ParityDependency) -> &'static str {
    match dependency {
        ParityDependency::LocalOrchestration => {
            "local producer/state still lives in a Tauri adapter"
        }
        ParityDependency::CloudRuntime => {
            "authenticated cloud runtime has not been extracted into the sidecar"
        }
        ParityDependency::NodeRuntime => {
            "packaged Node.js/HQ runner and process-event bridge are not wired"
        }
        ParityDependency::RecallRuntime => {
            "Recall SDK sidecar resources and event bridge are not packaged"
        }
        ParityDependency::GStreamerRuntime => {
            "GStreamer recording frameworks and event bridge are not packaged"
        }
        ParityDependency::NativeRuntime => "operation belongs to the native AppKit platform layer",
    }
}
