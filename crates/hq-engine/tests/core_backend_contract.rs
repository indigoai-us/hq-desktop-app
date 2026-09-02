use hq_engine::{CancellationFlag, CoreBackend, EngineBackend};
use hq_engine_protocol::method;
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};

fn write(path: &std::path::Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

#[test]
fn local_workspace_command_rejects_cloud_claims_it_does_not_implement() {
    let temp = tempfile::tempdir().unwrap();
    let backend = CoreBackend::with_roots(
        temp.path(),
        temp.path().join("claude"),
        temp.path().join("codex"),
    );

    let error = backend
        .execute(
            method::WORKSPACES_LIST,
            &json!({"includeCloud": true}),
            &CancellationFlag::default(),
        )
        .expect_err("cloud merge is intentionally not implemented");

    assert_eq!(error.code, "capability_not_implemented");
}

#[test]
fn domain_command_params_must_be_json_objects() {
    let temp = tempfile::tempdir().unwrap();
    let backend = CoreBackend::with_roots(
        temp.path(),
        temp.path().join("claude"),
        temp.path().join("codex"),
    );

    let error = backend
        .execute(
            method::WORKSPACES_LIST,
            &json!(null),
            &CancellationFlag::default(),
        )
        .expect_err("non-object params must fail");

    assert_eq!(error.code, "invalid_params");
}

#[test]
fn project_detail_commands_use_the_public_core_readers() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let prd_path = hq.join("companies/acme/projects/native/prd.json");
    write(
        &prd_path,
        r#"{
            "name": "Native app",
            "description": "A real macOS client",
            "userStories": [{"id":"US-001","title":"Shell","passes":true}]
        }"#,
    );
    write(
        &prd_path.with_file_name("README.md"),
        "# Native app\n\nLiquid Glass.",
    );
    write(
        &hq.join("companies/acme/board.json"),
        r#"{
            "objectives": [{"id":"obj-1","title":"Native quality"}],
            "initiatives": [{"id":"init-1","title":"Desktop"}]
        }"#,
    );
    write(
        &hq.join("companies/acme/crm-projection.json"),
        r#"{"accounts":[{"id":"acct-1"}]}"#,
    );
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let prd = backend
        .execute(
            "get_local_project_prd",
            &json!({"prdPath":"companies/acme/projects/native/prd.json"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(prd["name"], "Native app");
    assert_eq!(prd["userStories"][0]["passes"], true);

    let readme = backend
        .execute(
            "get_local_project_readme",
            &json!({"prdPath":"companies/acme/projects/native/prd.json"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(readme, "# Native app\n\nLiquid Glass.");

    let goals = backend
        .execute(
            "get_local_company_goals",
            &json!({"companySlug":"acme"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(goals["objectives"][0]["id"], "obj-1");

    let crm = backend
        .execute(
            "get_company_crm_projection",
            &json!({"companySlug":"acme"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(crm["accounts"][0]["id"], "acct-1");
}

#[test]
fn library_and_file_explorer_commands_use_guarded_core_readers() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    write(&hq.join("companies/acme/notes/brief.md"), "# Account brief");
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let root_library = backend
        .execute("get_library_root", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(root_library["workers"], json!([]));
    assert_eq!(root_library["skills"], json!([]));

    let company_library = backend
        .execute(
            "get_library_company",
            &json!({"companySlug":"acme"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(company_library["workers"], json!([]));

    let tree = backend
        .execute(
            "get_company_file_tree",
            &json!({"slug":"acme"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(tree["name"], "acme");

    let content = backend
        .execute(
            "get_company_file_content",
            &json!({"path":"companies/acme/notes/brief.md"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(content, "# Account brief");

    let entries = backend
        .execute(
            "list_hq_dir",
            &json!({"relPath":"companies/acme/notes"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(entries[0]["name"], "brief.md");

    let traversal = backend
        .execute(
            "get_company_file_content",
            &json!({"path":"../outside.txt"}),
            &cancellation,
        )
        .expect_err("path traversal must stay rejected");
    assert_eq!(traversal.code, "get_company_file_content_failed");
}

#[test]
fn local_session_aliases_return_the_exact_scanner_arrays() {
    let temp = tempfile::tempdir().unwrap();
    let backend = CoreBackend::with_roots(
        temp.path(),
        temp.path().join("claude"),
        temp.path().join("codex"),
    );
    let cancellation = CancellationFlag::default();

    assert_eq!(
        backend
            .execute("list_local_claude_sessions", &json!({}), &cancellation)
            .unwrap(),
        json!([])
    );
    assert_eq!(
        backend
            .execute("list_local_codex_sessions", &json!({}), &cancellation)
            .unwrap(),
        json!([])
    );
}

#[test]
fn local_project_mutations_persist_through_the_public_core_writers() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let board_path = hq.join("companies/acme/board.json");
    let prd_path = hq.join("companies/acme/projects/native/prd.json");
    write(
        &board_path,
        r#"{
            "projects": [{
                "id":"proj-1",
                "title":"Native app",
                "status":"planned",
                "prd_path":"companies/acme/projects/native/prd.json"
            }]
        }"#,
    );
    write(
        &prd_path,
        r#"{
            "name":"Native app",
            "userStories":[{"id":"US-001","title":"Shell","passes":false}]
        }"#,
    );
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let status_result = backend
        .execute(
            "set_local_project_status",
            &json!({
                "boardPath":"companies/acme/board.json",
                "projectId":"proj-1",
                "status":"in_progress"
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(status_result, Value::Null);
    let board: Value =
        serde_json::from_str(&std::fs::read_to_string(&board_path).unwrap()).unwrap();
    assert_eq!(board["projects"][0]["status"], "in_progress");

    backend
        .execute(
            "set_local_story_passes",
            &json!({
                "prdPath":"companies/acme/projects/native/prd.json",
                "storyId":"US-001",
                "passes":true
            }),
            &cancellation,
        )
        .unwrap();
    let prd: Value = serde_json::from_str(&std::fs::read_to_string(&prd_path).unwrap()).unwrap();
    assert_eq!(prd["userStories"][0]["passes"], true);
}

#[test]
fn daemon_status_and_hq_version_are_local_filesystem_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    write(&hq.join("core/core.yaml"), "hqVersion: 99.0.0\n");
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let daemon = backend
        .execute("daemon_status", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(daemon["running"], false);
    assert_eq!(daemon["source"], "none");

    let version = backend
        .execute("get_hq_version", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(version, "99.0.0");
}

#[test]
fn settings_commands_apply_defaults_and_preserve_unmodelled_keys() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar_path = hq.join(".hq/menubar.json");
    write(
        &menubar_path,
        r#"{
            "machineId":"keep-me",
            "futureSetting":{"nested":true},
            "notifications":false,
            "meetingDetectNotify":{"enabled":false}
        }"#,
    );
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let settings = backend
        .execute("get_settings", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(settings["notifications"], false);
    assert_eq!(settings["syncOnLaunch"], true);
    assert_eq!(settings["autostartDaemon"], false);
    assert_eq!(settings["meetingDetectNotify"]["enabled"], false);
    assert_eq!(
        settings["meetingDetectNotify"]["platforms"],
        json!(["zoom", "meet", "teams", "slack", "webex"])
    );
    assert_eq!(settings["widgetEnabled"], cfg!(not(target_os = "windows")));

    let mut updated = settings.clone();
    updated["notifications"] = json!(true);
    assert_eq!(
        backend
            .execute("save_settings", &json!({"prefs": updated}), &cancellation)
            .unwrap(),
        Value::Null
    );

    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&menubar_path).unwrap()).unwrap();
    assert_eq!(stored["notifications"], true);
    assert_eq!(stored["machineId"], "keep-me");
    assert_eq!(stored["futureSetting"]["nested"], true);
}

#[test]
fn save_settings_ignores_a_stale_legacy_temp_artifact() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar_path = hq.join(".hq/menubar.json");
    write(
        &menubar_path,
        r#"{"machineId":"keep-me","notifications":false}"#,
    );
    std::fs::create_dir_all(menubar_path.with_extension("json.tmp")).unwrap();
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();
    let mut prefs = backend
        .execute(method::GET_SETTINGS, &json!({}), &cancellation)
        .unwrap();
    prefs["notifications"] = json!(true);

    backend
        .execute(
            method::SAVE_SETTINGS,
            &json!({"prefs": prefs}),
            &cancellation,
        )
        .expect("a stale fixed-name staging artifact must not block an atomic save");

    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&menubar_path).unwrap()).unwrap();
    assert_eq!(stored["notifications"], true);
    assert_eq!(stored["machineId"], "keep-me");
}

#[test]
fn concurrent_save_settings_requests_commit_complete_atomic_documents() {
    const WRITERS: usize = 24;

    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar_path = hq.join(".hq/menubar.json");
    write(
        &menubar_path,
        r#"{
            "machineId":"keep-me",
            "futureSetting":{"nested":true},
            "notifications":false
        }"#,
    );
    let backend = Arc::new(CoreBackend::with_roots(
        hq,
        hq.join("claude"),
        hq.join("codex"),
    ));
    let base_prefs = backend
        .execute(
            method::GET_SETTINGS,
            &json!({}),
            &CancellationFlag::default(),
        )
        .unwrap();
    let start = Arc::new(Barrier::new(WRITERS));
    let writers = (0..WRITERS)
        .map(|index| {
            let backend = Arc::clone(&backend);
            let start = Arc::clone(&start);
            let mut prefs = base_prefs.clone();
            prefs["hqPath"] = json!(format!("/tmp/hq-writer-{index}"));
            std::thread::spawn(move || {
                start.wait();
                backend.execute(
                    method::SAVE_SETTINGS,
                    &json!({"prefs": prefs}),
                    &CancellationFlag::default(),
                )
            })
        })
        .collect::<Vec<_>>();

    for writer in writers {
        writer
            .join()
            .expect("settings writer panicked")
            .expect("concurrent settings writer failed");
    }

    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&menubar_path).unwrap())
        .expect("the committed settings document must always be complete JSON");
    assert_eq!(stored["machineId"], "keep-me");
    assert_eq!(stored["futureSetting"]["nested"], true);
    let hq_path = stored["hqPath"]
        .as_str()
        .expect("one complete writer payload must win");
    assert!(hq_path.starts_with("/tmp/hq-writer-"));
}

#[test]
fn install_directory_commands_persist_and_resolve_the_selected_hq_root() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let selected_parent = hq.join("selected-parent");
    std::fs::create_dir_all(&selected_parent).unwrap();
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let created = backend
        .execute(
            "create_directory",
            &json!({"parent":selected_parent,"name":"Indigo HQ"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(created["already_existed"], false);
    assert_eq!(created["non_empty"], false);
    let selected = std::path::PathBuf::from(created["path"].as_str().unwrap());

    assert_eq!(
        backend
            .execute(
                "set_hq_install_path",
                &json!({"path":selected}),
                &cancellation,
            )
            .unwrap(),
        Value::Null
    );
    let resolved = backend
        .execute("resolve_hq_path", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(
        std::path::PathBuf::from(resolved.as_str().unwrap()),
        selected.canonicalize().unwrap()
    );
    assert_eq!(
        backend
            .execute("check_writable", &json!({"path":selected}), &cancellation,)
            .unwrap(),
        true
    );

    write(&selected.join("companies/manifest.yaml"), "companies: []\n");
    let detected = backend
        .execute("detect_hq", &json!({"path":selected}), &cancellation)
        .unwrap();
    assert_eq!(
        detected,
        json!({
            "exists": true,
            "isHq": true,
            "nonEmpty": true,
        })
    );
}

#[test]
fn legacy_file_helpers_are_atomic_and_confined_to_the_install_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    std::fs::create_dir_all(&root).unwrap();
    let backend = CoreBackend::with_roots(&root, root.join("claude"), root.join("codex"));
    let cancellation = CancellationFlag::default();

    backend
        .execute(
            "make_dir",
            &json!({"path":"nested","installRoot":root}),
            &cancellation,
        )
        .unwrap();
    backend
        .execute(
            "write_file",
            &json!({
                "path":"nested/readme.txt",
                "contents":[72,81,10],
                "installRoot":root,
                "mode":420
            }),
            &cancellation,
        )
        .unwrap();
    let contents = backend
        .execute(
            "read_text_file",
            &json!({"path":"nested/readme.txt","installRoot":root}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(contents, "HQ\n");

    let traversal = backend
        .execute(
            "write_file",
            &json!({
                "path":"../escape.txt",
                "contents":[120],
                "installRoot":root
            }),
            &cancellation,
        )
        .expect_err("writes outside install root must be rejected");
    assert_eq!(traversal.code, "write_file_failed");
    assert!(!temp.path().join("escape.txt").exists());

    #[cfg(unix)]
    {
        backend
            .execute(
                "create_symlink",
                &json!({
                    "target":"readme.txt",
                    "linkPath":"nested/readme-link.txt",
                    "root":root
                }),
                &cancellation,
            )
            .unwrap();
        assert_eq!(
            std::fs::read_link(root.join("nested/readme-link.txt")).unwrap(),
            std::path::PathBuf::from("readme.txt")
        );

        let target_escape = backend
            .execute(
                "create_symlink",
                &json!({
                    "target":"../../outside.txt",
                    "linkPath":"nested/escape-link",
                    "root":root
                }),
                &cancellation,
            )
            .expect_err("symlink target must remain inside root");
        assert_eq!(target_escape.code, "create_symlink_failed");
    }
}

#[cfg(unix)]
#[test]
fn legacy_file_helpers_reject_symlink_escapes_but_allow_in_root_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let outside = temp.path().join("outside");
    let in_root = root.join("real");
    std::fs::create_dir_all(&in_root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape-parent")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("escape-leaf.txt")).unwrap();
    std::os::unix::fs::symlink(&in_root, root.join("inside-parent")).unwrap();

    let backend = CoreBackend::with_roots(&root, root.join("claude"), root.join("codex"));
    let cancellation = CancellationFlag::default();

    for (method, params) in [
        (
            "make_dir",
            json!({"path":"escape-parent/new-dir","installRoot":root}),
        ),
        (
            "write_file",
            json!({
                "path":"escape-parent/new.txt",
                "contents":[120],
                "installRoot":root
            }),
        ),
        (
            "read_text_file",
            json!({"path":"escape-leaf.txt","installRoot":root}),
        ),
        (
            "create_symlink",
            json!({
                "target":"../real",
                "linkPath":"escape-parent/new-link",
                "root":root
            }),
        ),
        (
            "create_symlink",
            json!({
                "target":"../escape-parent/missing-target",
                "linkPath":"real/unsafe-target-link",
                "root":root
            }),
        ),
    ] {
        let error = backend
            .execute(method, &params, &cancellation)
            .expect_err("filesystem-resolved escapes must be rejected");
        assert_eq!(error.code, format!("{method}_failed"));
    }

    backend
        .execute(
            "make_dir",
            &json!({"path":"inside-parent/nested","installRoot":root}),
            &cancellation,
        )
        .unwrap();
    backend
        .execute(
            "write_file",
            &json!({
                "path":"inside-parent/nested/readme.txt",
                "contents":[72,81,10],
                "installRoot":root
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(
        backend
            .execute(
                "read_text_file",
                &json!({
                    "path":"inside-parent/nested/readme.txt",
                    "installRoot":root
                }),
                &cancellation,
            )
            .unwrap(),
        "HQ\n"
    );
    backend
        .execute(
            "create_symlink",
            &json!({
                "target":"readme.txt",
                "linkPath":"inside-parent/nested/readme-link.txt",
                "root":root
            }),
            &cancellation,
        )
        .unwrap();
}

#[test]
fn desktop_feature_flags_use_the_signed_in_email_without_cloud_calls() {
    let temp = tempfile::tempdir().unwrap();
    let make_backend = |email: Option<&str>| {
        CoreBackend::with_roots(
            temp.path(),
            temp.path().join("claude"),
            temp.path().join("codex"),
        )
        .with_identity_email(email)
    };
    let cancellation = CancellationFlag::default();

    let signed_out = make_backend(None);
    assert_eq!(
        signed_out
            .execute("desktop_alt_enabled", &json!({}), &cancellation)
            .unwrap(),
        false
    );

    let member = make_backend(Some("member@example.com"));
    assert_eq!(
        member
            .execute("desktop_alt_enabled", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    assert_eq!(
        member
            .execute("desktop_alt_is_admin", &json!({}), &cancellation)
            .unwrap(),
        false
    );

    let admin = make_backend(Some("operator@getindigo.ai"));
    assert_eq!(
        admin
            .execute("desktop_alt_is_admin", &json!({}), &cancellation)
            .unwrap(),
        true
    );
}

#[test]
fn first_run_classification_is_stable_and_completion_writes_preserve_state() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    assert_eq!(
        backend
            .execute("is_first_run", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    backend
        .execute("mark_first_run_complete", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(
        backend
            .execute("is_first_run", &json!({}), &cancellation)
            .unwrap(),
        true,
        "launch classification must stay stable for the process"
    );
    let stored = hq_desktop_core::first_run::read_menubar_obj(&hq.join(".hq/menubar.json"));
    assert_eq!(stored["firstRunCompleted"], true);
    assert_eq!(stored["autoSyncNoticeShown"], true);
    assert_eq!(stored["realtimeSync"], true);
    assert_eq!(stored["personalSyncEnabled"], true);

    let next_launch = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    assert_eq!(
        next_launch
            .execute("is_first_run", &json!({}), &cancellation)
            .unwrap(),
        false
    );
}

#[test]
fn existing_update_notice_and_lifecycle_state_match_core_classifiers() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    write(
        &hq.join(".hq/menubar.json"),
        r#"{"machineId":"existing","realtimeSync":true}"#,
    );
    let existing = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();
    assert_eq!(
        existing
            .execute("should_show_auto_sync_notice", &json!({}), &cancellation,)
            .unwrap(),
        true
    );
    existing
        .execute("mark_auto_sync_notice_shown", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(
        existing
            .execute("should_show_auto_sync_notice", &json!({}), &cancellation,)
            .unwrap(),
        false
    );

    write(&hq.join("core/core.yaml"), "hqVersion: 1.0.0\n");
    hq_desktop_core::first_run::merge_menubar_flags(
        &hq.join(".hq/menubar.json"),
        &[
            ("installCompleted", json!(true)),
            ("firstRunCompleted", json!(true)),
        ],
    )
    .unwrap();
    let steady = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    assert_eq!(
        steady
            .execute("get_lifecycle_state", &json!({}), &cancellation)
            .unwrap(),
        "SteadyState"
    );
}

#[test]
fn telemetry_and_staging_preferences_round_trip_without_losing_unknown_keys() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar = hq.join(".hq/menubar.json");
    write(&menubar, r#"{"futureKey":"keep"}"#);
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    backend
        .execute(
            "write_menubar_telemetry_pref",
            &json!({"enabled":false}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(
        backend
            .execute(
                "set_staging_source",
                &json!({"enabled":true}),
                &cancellation,
            )
            .unwrap(),
        true
    );
    assert_eq!(
        backend
            .execute("get_staging_source", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    assert_eq!(
        backend
            .execute("get_use_staging_source", &json!({}), &cancellation)
            .unwrap(),
        true
    );

    let stored: Value = serde_json::from_str(&std::fs::read_to_string(menubar).unwrap()).unwrap();
    assert_eq!(stored["telemetryEnabled"], false);
    assert_eq!(stored["stagingSource"], true);
    assert_eq!(stored["futureKey"], "keep");
}

#[test]
fn device_fingerprint_is_stable_and_preserves_menubar_preferences() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar = hq.join(".hq/menubar.json");
    write(&menubar, r#"{"futureKey":"keep","machineId":""}"#);
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let first = backend
        .execute("device_fingerprint", &json!({}), &cancellation)
        .unwrap();
    let second = backend
        .execute("device_fingerprint", &json!({}), &cancellation)
        .unwrap();

    assert_eq!(first, second);
    assert!(
        first
            .as_str()
            .is_some_and(|machine_id| !machine_id.trim().is_empty()),
        "device fingerprint must be a non-empty persisted identifier"
    );
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(menubar).unwrap()).unwrap();
    assert_eq!(stored["machineId"], first);
    assert_eq!(stored["futureKey"], "keep");
}

#[test]
fn install_manifest_commands_are_durable_idempotent_and_legacy_compatible() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let empty = backend
        .execute("read_install_manifest", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(empty["schemaVersion"], 1);
    assert_eq!(empty["installPath"], hq.to_string_lossy().as_ref());
    assert_eq!(empty["completedAt"], Value::Null);
    assert_eq!(empty["steps"], json!({}));
    assert_eq!(empty["dependencies"], json!({}));
    assert_eq!(empty["packs"], json!({}));
    assert_eq!(empty["failures"], json!([]));

    let started = backend
        .execute(
            "record_step_start",
            &json!({"stepId":"content"}),
            &cancellation,
        )
        .unwrap();
    let started_at = started["steps"]["content"]["startedAt"]
        .as_str()
        .expect("start must be timestamped")
        .to_string();
    let started_twice = backend
        .execute(
            "record_step_start",
            &json!({"stepId":"content"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(started_twice["steps"]["content"]["startedAt"], started_at);
    assert_eq!(started_twice["steps"]["content"]["status"], "running");

    let failed = backend
        .execute(
            "record_step_failure",
            &json!({"stepId":"content","error":"network unavailable"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(failed["steps"]["content"]["status"], "failed");
    assert_eq!(failed["steps"]["content"]["error"], "network unavailable");
    assert_eq!(failed["failures"].as_array().unwrap().len(), 1);
    let failed_twice = backend
        .execute(
            "record_step_failure",
            &json!({"stepId":"content","error":"network unavailable"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(failed_twice["failures"].as_array().unwrap().len(), 1);

    let ok = backend
        .execute(
            "record_step_ok",
            &json!({"stepId":"content"}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(ok["steps"]["content"]["status"], "ok");
    assert_eq!(ok["steps"]["content"]["error"], Value::Null);

    let dependencies = backend
        .execute(
            "record_dependencies",
            &json!({
                "dependencies": {
                    "node": {"status":"ok","version":"22.14.0"},
                    "gh": {"status":"skipped","error":null}
                }
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(dependencies["dependencies"]["node"]["status"], "ok");
    assert_eq!(dependencies["dependencies"]["node"]["version"], "22.14.0");

    let packs = backend
        .execute(
            "record_packs",
            &json!({
                "packs": {
                    "engineering": {"status":"ok"},
                    "parker": {"status":"failed","error":"not available"}
                }
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(packs["packs"]["engineering"]["status"], "ok");
    assert_eq!(packs["packs"]["parker"]["error"], "not available");

    let imported = backend
        .execute(
            "record_import",
            &json!({
                "import": {
                    "codexApplied": true,
                    "discoveryOk": true,
                    "claudeCounts": {"skills": 4},
                    "totalClaudeArtifacts": 4
                }
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(imported["import"]["codexApplied"], true);
    assert_eq!(imported["import"]["claudeCounts"]["skills"], 4);

    let completed = backend
        .execute("record_install_complete", &json!({}), &cancellation)
        .unwrap();
    let completed_at = completed["completedAt"]
        .as_str()
        .expect("completion must be timestamped")
        .to_string();
    let completed_twice = backend
        .execute("record_install_complete", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(completed_twice["completedAt"], completed_at);

    let next_process = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let persisted = next_process
        .execute("read_install_manifest", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(persisted, completed_twice);
    assert!(
        hq.join(".hq/install-manifest.json").is_file(),
        "isolated backends must persist under their isolated app-config root"
    );
}

#[test]
fn ai_tool_detection_aliases_share_the_legacy_boolean_contract() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let detected = backend
        .execute("detect_ai_tools", &json!({}), &cancellation)
        .unwrap();
    let checked = backend
        .execute("check_ai_tools", &json!({}), &cancellation)
        .unwrap();

    assert_eq!(checked, detected);
    for key in [
        "claude_cli",
        "claude_desktop",
        "codex_cli",
        "codex_desktop",
        "grok_cli",
        "any",
    ] {
        assert!(detected[key].is_boolean(), "{key} must be a boolean");
    }
    assert_eq!(
        detected["any"].as_bool().unwrap(),
        detected["claude_cli"].as_bool().unwrap()
            || detected["claude_desktop"].as_bool().unwrap()
            || detected["codex_cli"].as_bool().unwrap()
            || detected["codex_desktop"].as_bool().unwrap()
            || detected["grok_cli"].as_bool().unwrap()
    );
}

#[test]
fn mission_control_snapshot_includes_bounded_local_history() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    write(
        &hq.join("workspace/metrics/audit-log.jsonl"),
        concat!(
            "{\"event\":\"task_started\",\"timestamp\":\"2026-07-26T19:00:00Z\",",
            "\"company\":\"indigo\",\"project\":\"native\",\"story_id\":\"US-001\"}\n",
            "{\"event\":\"task_completed\",\"timestamp\":\"2026-07-26T19:05:00Z\",",
            "\"company\":\"indigo\",\"project\":\"native\",\"story_id\":\"US-001\"}\n"
        ),
    );
    write(
        &hq.join("workspace/threads/checkpoint.json"),
        r#"{
            "type":"checkpoint",
            "created_at":"2026-07-26T19:03:00Z",
            "company":"indigo",
            "project":"native",
            "metadata":{"title":"Native checkpoint"}
        }"#,
    );
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let history = backend
        .execute("list_session_history", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 3);
    assert_eq!(history[0]["kind"], "completed");
    assert_eq!(history[0]["title"], "US-001 completed");
    assert_eq!(history[1]["kind"], "checkpoint");
    assert_eq!(history[2]["kind"], "dispatched");

    let snapshot = backend
        .execute("list_agent_sessions", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(snapshot["sessions"], json!([]));
    assert_eq!(snapshot["history"], history);
    assert_eq!(snapshot["outpost"], Value::Null);
}

#[test]
fn indigo_gate_and_personal_scaffold_are_local_and_deterministic() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let cancellation = CancellationFlag::default();
    let member = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"))
        .with_identity_email(Some("member@example.com"));
    assert_eq!(
        member
            .execute("is_indigo_user", &json!({}), &cancellation)
            .unwrap(),
        false
    );

    let admin = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"))
        .with_identity_email(Some("operator@getindigo.ai"));
    assert_eq!(
        admin
            .execute("is_indigo_user", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    assert_eq!(
        admin
            .execute("personalize_hq", &json!({}), &cancellation)
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        std::fs::read_to_string(hq.join("personal/settings/cognito.json")).unwrap(),
        "{}\n"
    );
    assert!(hq.join("personal/settings/.gitkeep").is_file());
    assert!(hq.join("personal/workers/.gitkeep").is_file());
}

#[test]
fn git_onboarding_reads_identity_and_initializes_the_selected_repository() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    write(
        &hq.join(".hq/test-gitconfig"),
        "[user]\n\tname = Native Operator\n\temail = native@example.com\n",
    );
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    let identity = backend
        .execute("git_probe_user", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(
        identity,
        json!({
            "name": "Native Operator",
            "email": "native@example.com",
        })
    );

    let repository = hq.join("selected");
    let initialized = backend
        .execute(
            "git_init",
            &json!({
                "path": repository,
                "name": "Explicit Native",
                "email": "explicit@example.com"
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(
        initialized,
        format!("initialised {}", repository.to_string_lossy())
    );
    assert!(repository.join(".git").is_dir());

    let git = hq_desktop_core::paths::resolve_bin("git");
    let name = std::process::Command::new(&git)
        .args(["-C", repository.to_str().unwrap(), "config", "user.name"])
        .output()
        .unwrap();
    let email = std::process::Command::new(&git)
        .args(["-C", repository.to_str().unwrap(), "config", "user.email"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&name.stdout).trim(),
        "Explicit Native"
    );
    assert_eq!(
        String::from_utf8_lossy(&email.stdout).trim(),
        "explicit@example.com"
    );
}

#[test]
fn local_update_dismissal_and_primary_instance_compatibility_persist() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let menubar = hq.join(".hq/menubar.json");
    write(&menubar, r#"{"futureKey":"keep"}"#);
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));
    let cancellation = CancellationFlag::default();

    assert_eq!(
        backend
            .execute("is_primary_instance", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    assert_eq!(
        backend
            .execute("recheck_primary_instance", &json!({}), &cancellation)
            .unwrap(),
        true
    );
    assert_eq!(
        backend
            .execute(
                "set_hq_cli_update_dismissed",
                &json!({"version":"2.4.1"}),
                &cancellation,
            )
            .unwrap(),
        Value::Null
    );
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(menubar).unwrap()).unwrap();
    assert_eq!(stored["cliUpdateDismissedVersion"], "2.4.1");
    assert_eq!(stored["futureKey"], "keep");
}

#[test]
fn agency_commands_read_append_and_answer_with_path_guards() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path();
    let team = hq.join("workspace/agency/acme/native-team");
    let liaison = team.join("team-liaison/main/chat.jsonl");
    let manager = team.join("team-manager/main/chat.jsonl");
    let question = "Which release channel?";
    let question_id = hq_desktop_core::agency::cksum(question.as_bytes()).to_string();
    write(
        &liaison,
        &format!(
            "{{\"role\":\"user\",\"from\":\"manager\",\"text\":\"ASK: {question}\",\"ts\":\"2026-07-26T20:00:00Z\",\"options\":[\"stable\",\"beta\"]}}\n"
        ),
    );
    write(
        &team.join("status.json"),
        r#"{"team-manager":{"main":{"status":"running","started_at":"2026-07-26T19:00:00Z","updated_at":"2026-07-26T20:00:00Z"}}}"#,
    );
    write(&manager, "");
    let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"))
        .with_identity_email(Some("member@example.com"));
    let cancellation = CancellationFlag::default();

    let teams = backend
        .execute("list_agency_teams", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(teams[0]["company"], "acme");
    assert_eq!(teams[0]["team"], "native-team");
    assert!(teams[0]["workers"].as_array().unwrap().len() >= 2);

    let questions = backend
        .execute("list_agency_questions", &json!({}), &cancellation)
        .unwrap();
    assert_eq!(questions[0]["id"], question_id);
    assert_eq!(questions[0]["options"], json!(["stable", "beta"]));

    let sent = backend
        .execute(
            "send_agency_message",
            &json!({"company":"acme","team":"native-team","text":"  Ship stable  "}),
            &cancellation,
        )
        .unwrap();
    assert_eq!(sent, "sent");
    let chat = backend
        .execute(
            "list_agency_chat",
            &json!({"company":"acme","team":"native-team"}),
            &cancellation,
        )
        .unwrap();
    assert!(chat
        .as_array()
        .unwrap()
        .iter()
        .any(|message| { message["text"] == "Ship stable" && message["from"] == "operator" }));

    let delivered = backend
        .execute(
            "answer_agency_question",
            &json!({
                "company":"acme",
                "team":"native-team",
                "id":question_id,
                "answer":"stable"
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(delivered, "delivered");
    let duplicate = backend
        .execute(
            "answer_agency_question",
            &json!({
                "company":"acme",
                "team":"native-team",
                "id":question_id,
                "answer":"stable"
            }),
            &cancellation,
        )
        .unwrap();
    assert_eq!(duplicate, "already-answered");
    let answered = std::fs::read_to_string(manager).unwrap();
    assert_eq!(answered.matches(&format!("[ans:{question_id}]")).count(), 1);
    assert_eq!(
        backend
            .execute("list_agency_questions", &json!({}), &cancellation)
            .unwrap(),
        json!([])
    );

    let traversal = backend
        .execute(
            "send_agency_message",
            &json!({"company":"..","team":"escape","text":"no"}),
            &cancellation,
        )
        .expect_err("agency paths must remain under the agency root");
    assert_eq!(traversal.code, "send_agency_message_failed");
}
