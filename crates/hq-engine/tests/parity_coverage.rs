use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use hq_engine::{
    blocked_parity_command_names, capabilities, emitted_parity_event_names,
    parity_command_registration, parity_event_registration, parity_summary,
    registered_parity_command_names, registered_parity_event_names, subscribed_parity_event_names,
    ParityCommandStatus, ParityEventStatus,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Inventory {
    commands: Vec<InventoryCommand>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryCommand {
    name: String,
    disposition: String,
}

#[derive(Deserialize)]
struct EventInventory {
    events: Vec<InventoryEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryEvent {
    name: String,
    disposition: String,
}

fn parity_inventory() -> Inventory {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("apps")
        .join("native-macos")
        .join("Parity")
        .join("commands.json");
    serde_json::from_str(
        &fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
    )
    .expect("parse Parity/commands.json")
}

fn parity_event_inventory() -> EventInventory {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("apps")
        .join("native-macos")
        .join("Parity")
        .join("events.json");
    serde_json::from_str(
        &fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
    )
    .expect("parse Parity/events.json")
}

#[test]
fn every_engine_disposition_has_an_explicit_registration() {
    let expected: BTreeSet<String> = parity_inventory()
        .commands
        .into_iter()
        .filter(|command| command.disposition == "engine")
        .map(|command| command.name)
        .collect();
    let registered: BTreeSet<String> = registered_parity_command_names()
        .map(str::to_string)
        .collect();

    assert_eq!(
        registered, expected,
        "update parity-engine-commands.txt whenever the generated inventory changes"
    );
    assert_eq!(registered.len(), 196);
}

#[test]
fn implemented_registrations_are_capabilities_and_blocked_ones_are_not_claimed() {
    for command in registered_parity_command_names() {
        let registration = parity_command_registration(command)
            .unwrap_or_else(|| panic!("{command} is listed but unregistered"));
        match registration.status {
            ParityCommandStatus::Implemented { method } => {
                assert!(
                    capabilities().contains(&method),
                    "{command} claims an unadvertised method {method}"
                );
            }
            ParityCommandStatus::Blocked { .. } => {
                assert!(
                    !capabilities().contains(&command),
                    "blocked command {command} leaked into capabilities"
                );
            }
        }
    }
}

#[test]
fn initial_public_core_parity_commands_are_real_implementations() {
    for command in [
        "get_config",
        "get_sync_status",
        "get_local_projects",
        "get_local_project_prd",
        "get_local_project_readme",
        "get_local_company_goals",
        "get_company_crm_projection",
        "get_library_root",
        "get_library_company",
        "get_library_worker_detail",
        "get_library_skill_detail",
        "get_company_file_tree",
        "get_company_file_content",
        "list_hq_dir",
        "list_local_claude_sessions",
        "list_local_codex_sessions",
        "get_hq_version",
        "has_stored_token",
        "set_local_project_status",
        "set_local_story_passes",
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
        "meetings_notify_detected",
        "start_oauth_login",
        "oauth_listen_for_code",
        "oauth_cancel_listen",
        "oauth_exchange_code",
    ] {
        let registration = parity_command_registration(command).expect("registered parity command");
        assert!(
            matches!(
                registration.status,
                ParityCommandStatus::Implemented { method } if method == command
            ),
            "{command} must be a real legacy-compatible dispatch method"
        );
    }
}

#[test]
fn every_engine_event_has_an_explicit_delivery_registration() {
    let expected: BTreeSet<String> = parity_event_inventory()
        .events
        .into_iter()
        .filter(|event| event.disposition == "engine")
        .map(|event| event.name)
        .collect();
    let registered: BTreeSet<String> = registered_parity_event_names()
        .map(str::to_string)
        .collect();

    assert_eq!(
        registered, expected,
        "update parity-engine-events.txt whenever the generated event inventory changes"
    );
    assert_eq!(registered.len(), 46);
}

#[test]
fn no_event_is_claimed_without_both_a_producer_and_native_subscription() {
    let emitted: BTreeSet<&str> = emitted_parity_event_names().iter().copied().collect();
    let subscribed: BTreeSet<&str> = subscribed_parity_event_names().iter().copied().collect();
    let mut delivered = 0;

    for event in registered_parity_event_names() {
        let registration = parity_event_registration(event).expect("registered parity event");
        match registration.status {
            ParityEventStatus::Delivered { .. } => {
                delivered += 1;
                assert!(emitted.contains(event), "{event} has no engine producer");
                assert!(
                    subscribed.contains(event),
                    "{event} has no native subscriber"
                );
            }
            ParityEventStatus::Blocked { reason, .. } => {
                assert!(!reason.trim().is_empty(), "{event} needs an honest blocker");
            }
        }
    }

    assert_eq!(delivered, 46, "delivered parity events must stay explicit");
}

#[test]
fn every_engine_event_has_a_real_producer_and_native_subscriber() {
    for event in [
        "channel:new-message",
        "core-state:changed",
        "marketplace:publish-progress",
        "meeting:detected",
        "recording:started",
        "sync:external-progress",
        "sync:progress",
        "sync:totals",
    ] {
        match parity_event_registration(event).unwrap().status {
            ParityEventStatus::Delivered {
                producer,
                subscriber,
            } => {
                assert!(!producer.trim().is_empty());
                assert_eq!(subscriber, "HQAppStore.receiveEngineEvent");
            }
            status => panic!("{event} is not delivered: {status:?}"),
        }
    }
    assert_eq!(parity_summary().events.blocked, 0);
}

#[test]
fn packaged_runtime_commands_are_real_capabilities() {
    for command in [
        "start_sync",
        "poll_dm_inbox",
        "start_recall_sdk",
        "start_recording",
    ] {
        assert!(matches!(
            parity_command_registration(command).unwrap().status,
            ParityCommandStatus::Implemented { .. }
        ));
        assert!(capabilities().contains(&command));
    }
}

#[test]
fn parity_summary_counts_are_derived_from_the_registries() {
    let summary = parity_summary();

    assert_eq!(
        summary.commands.implemented + summary.commands.blocked,
        summary.commands.total
    );
    assert_eq!(
        summary.events.delivered + summary.events.blocked,
        summary.events.total
    );
    assert_eq!(
        summary
            .commands
            .blocked_by_dependency
            .values()
            .sum::<usize>(),
        summary.commands.blocked
    );
    assert_eq!(
        summary.events.blocked_by_dependency.values().sum::<usize>(),
        summary.events.blocked
    );
    assert_eq!(summary.commands.total, 196);
    assert_eq!(summary.events.total, 46);
    assert_eq!(
        blocked_parity_command_names(None).len(),
        summary.commands.blocked
    );
    for dependency in [
        hq_engine::ParityDependency::LocalOrchestration,
        hq_engine::ParityDependency::CloudRuntime,
        hq_engine::ParityDependency::NodeRuntime,
        hq_engine::ParityDependency::RecallRuntime,
        hq_engine::ParityDependency::GStreamerRuntime,
        hq_engine::ParityDependency::NativeRuntime,
    ] {
        assert_eq!(
            blocked_parity_command_names(Some(dependency)).len(),
            summary
                .commands
                .blocked_by_dependency
                .get(dependency.as_str())
                .copied()
                .unwrap_or(0)
        );
    }
}
