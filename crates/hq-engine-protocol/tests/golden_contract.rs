use std::fs;
use std::path::PathBuf;

use hq_engine_protocol::{
    decode_request_line, encode_response_line, EnvelopeKind, ResponseEnvelope,
};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing golden fixture {}: {error}", path.display()))
}

#[test]
fn golden_requests_decode_as_single_frames() {
    for name in [
        "request-workspaces-list.jsonl",
        "request-health.jsonl",
        "request-cancel.jsonl",
        "request-shutdown.jsonl",
    ] {
        let line = fixture(name);
        assert_eq!(
            line.matches('\n').count(),
            1,
            "{name} must be one NDJSON frame"
        );
        decode_request_line(&line).unwrap_or_else(|error| {
            panic!("{name} must decode: {}: {}", error.code, error.message)
        });
    }
}

#[test]
fn golden_responses_round_trip_without_wire_drift() {
    for name in [
        "response-handshake.jsonl",
        "response-result.jsonl",
        "response-error.jsonl",
        "response-event.jsonl",
        "response-pong.jsonl",
        "response-cancelled.jsonl",
        "response-end.jsonl",
    ] {
        let line = fixture(name);
        let envelope: ResponseEnvelope = serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("{name} must decode: {error}"));
        let encoded = encode_response_line(&envelope)
            .unwrap_or_else(|error| panic!("{name} must encode: {}", error.message));
        assert_eq!(encoded, line, "{name} changed its canonical wire form");
    }
}

#[test]
fn golden_handshake_is_the_constructor_output() {
    let expected = fixture("response-handshake.jsonl");
    let handshake = ResponseEnvelope::handshake(
        "0.1.0",
        "0.10.21",
        vec![
            "health".into(),
            "cancel".into(),
            "shutdown".into(),
            "config.get".into(),
            "get_config".into(),
            "auth.state".into(),
            "workspaces.list".into(),
            "sync.status".into(),
            "get_sync_status".into(),
            "projects.list".into(),
            "get_local_projects".into(),
            "get_local_project_prd".into(),
            "get_local_project_readme".into(),
            "get_local_company_goals".into(),
            "get_company_crm_projection".into(),
            "set_local_project_status".into(),
            "set_local_story_passes".into(),
            "get_library_root".into(),
            "get_library_company".into(),
            "get_library_worker_detail".into(),
            "get_library_skill_detail".into(),
            "get_company_file_tree".into(),
            "get_company_file_content".into(),
            "list_hq_dir".into(),
            "sessions.list".into(),
            "list_local_claude_sessions".into(),
            "list_local_codex_sessions".into(),
            "get_hq_version".into(),
            "has_stored_token".into(),
            "daemon_status".into(),
            "get_settings".into(),
            "save_settings".into(),
            "create_directory".into(),
            "check_writable".into(),
            "detect_hq".into(),
            "resolve_hq_path".into(),
            "set_hq_install_path".into(),
            "write_menubar_hq_path".into(),
            "write_file".into(),
            "make_dir".into(),
            "read_text_file".into(),
            "create_symlink".into(),
            "desktop_alt_enabled".into(),
            "desktop_alt_is_admin".into(),
            "get_lifecycle_state".into(),
            "is_first_run".into(),
            "should_show_auto_sync_notice".into(),
            "mark_first_run_complete".into(),
            "mark_auto_sync_notice_shown".into(),
            "write_menubar_telemetry_pref".into(),
            "get_staging_source".into(),
            "get_use_staging_source".into(),
            "set_staging_source".into(),
            "device_fingerprint".into(),
            "read_install_manifest".into(),
            "record_step_start".into(),
            "record_step_ok".into(),
            "record_step_failure".into(),
            "record_dependencies".into(),
            "record_packs".into(),
            "record_import".into(),
            "record_install_complete".into(),
            "list_channels".into(),
            "fetch_channel".into(),
            "create_channel".into(),
            "create_group_dm".into(),
            "send_channel_message".into(),
            "list_channel_members".into(),
            "send_dm".into(),
            "send_dm_to_email".into(),
            "fetch_dm_thread".into(),
            "list_dm_requests".into(),
            "fetch_thread".into(),
            "send_thread_reply".into(),
            "fetch_reactions".into(),
            "check_ai_tools".into(),
            "detect_ai_tools".into(),
            "list_session_history".into(),
            "list_agent_sessions".into(),
            "is_indigo_user".into(),
            "personalize_hq".into(),
            "get_company_summary".into(),
            "get_company_board".into(),
            "get_company_crm_projection_vault".into(),
            "get_company_project_creators".into(),
            "get_company_activity".into(),
            "get_company_team_telemetry".into(),
            "get_company_deployments".into(),
            "get_company_secrets".into(),
            "get_sync_mode".into(),
            "set_sync_mode".into(),
            "list_marketplace_listings".into(),
            "get_marketplace_listing".into(),
            "list_moderation_queue".into(),
            "decide_moderation_listing".into(),
            "yank_marketplace_listing".into(),
            "request_creator_access".into(),
            "list_creator_applications".into(),
            "decide_creator_application".into(),
            "claim_creator_handle".into(),
            "update_creator_profile".into(),
            "get_creator_profile".into(),
            "get_my_creator".into(),
            "record_marketplace_install".into(),
            "publish_marketplace_pack".into(),
            "upload_creator_avatar".into(),
            "fetch_notification_history".into(),
            "git_init".into(),
            "git_probe_user".into(),
            "refresh_tokens".into(),
            "is_primary_instance".into(),
            "recheck_primary_instance".into(),
            "set_hq_cli_update_dismissed".into(),
            "list_agency_teams".into(),
            "list_agency_questions".into(),
            "list_agency_chat".into(),
            "answer_agency_question".into(),
            "send_agency_message".into(),
            "connect_workspace_to_cloud".into(),
            "submit_bug_report".into(),
            "meeting_detect_feature_enabled".into(),
            "meetings_feature_enabled".into(),
            "meetings_list_active_detections".into(),
            "meetings_list_active_recordings".into(),
            "meetings_list_upcoming".into(),
            "meetings_list_accounts".into(),
            "meetings_list_calendars_for_account".into(),
            "meetings_list_scheduled_bots".into(),
            "meetings_set_company".into(),
            "meetings_invite_bot".into(),
            "meetings_join_bot_now".into(),
            "meetings_list_memberships".into(),
            "meetings_cancel_bot".into(),
            "meetings_check_bot_for_url".into(),
            "start_oauth_login".into(),
            "oauth_listen_for_code".into(),
            "oauth_cancel_listen".into(),
            "oauth_exchange_code".into(),
        ],
    );

    assert_eq!(handshake.kind, EnvelopeKind::Handshake);
    assert_eq!(encode_response_line(&handshake).unwrap(), expected);
}
