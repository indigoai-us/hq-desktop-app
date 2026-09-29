use std::fs;

use hq_desktop_core::projects_local::{authorize_project_board_target, write_project_status};
use hq_desktop_core::workspaces::{Workspace, WorkspaceKind, WorkspaceState};

fn personal_workspace() -> Workspace {
    Workspace {
        slug: "personal".to_string(),
        display_name: "Personal".to_string(),
        kind: WorkspaceKind::Personal,
        state: WorkspaceState::Personal,
        cloud_uid: Some("prs_test".to_string()),
        bucket_name: None,
        has_local_folder: true,
        local_path: None,
        membership_status: None,
        role: None,
        sync_enabled: true,
        last_synced_at: None,
        broken_reason: None,
        invited_by: None,
        invited_at: None,
        branding_enabled: false,
        brand: None,
        home_channel_id: None,
    }
}

fn write_board(root: &std::path::Path, relative: &str, project_id: &str, status: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("board has a parent")).expect("create board folder");
    fs::write(
        path,
        format!(r#"{{"projects":[{{"id":"{project_id}","status":"{status}"}}]}}"#),
    )
    .expect("write synthetic board");
}

fn write_status(
    root: &std::path::Path,
    board_path: &str,
    workspaces: &[Workspace],
) -> Result<(), String> {
    let board = authorize_project_board_target(root, board_path, workspaces)?;
    write_project_status(
        root,
        &board.relative_path,
        "personal-demo",
        None,
        "complete",
    )
}

fn board_status(root: &std::path::Path, relative: &str) -> String {
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(relative)).expect("read board"))
            .expect("parse board");
    value["projects"][0]["status"]
        .as_str()
        .expect("project status")
        .to_string()
}

#[test]
fn personal_status_write_uses_personal_board_and_rejects_companies_personal() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_board(
        root.path(),
        "personal/board.json",
        "personal-demo",
        "planned",
    );
    write_board(
        root.path(),
        "companies/personal/board.json",
        "personal-demo",
        "planned",
    );
    let workspaces = [personal_workspace()];

    write_status(root.path(), "personal/board.json", &workspaces)
        .expect("authorized Personal status write succeeds");
    assert_eq!(board_status(root.path(), "personal/board.json"), "complete");
    assert_eq!(
        board_status(root.path(), "companies/personal/board.json"),
        "planned",
        "the write must not reach a company-shaped Personal path"
    );

    assert!(
        write_status(root.path(), "companies/personal/board.json", &workspaces).is_err(),
        "companies/personal must be rejected even when the Personal workspace is authorized"
    );
}

#[test]
fn personal_status_write_requires_personal_scope_authorization() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_board(
        root.path(),
        "personal/board.json",
        "personal-demo",
        "planned",
    );

    assert!(
        write_status(root.path(), "personal/board.json", &[]).is_err(),
        "a Personal board write must fail without an authorized Personal workspace"
    );
    assert_eq!(board_status(root.path(), "personal/board.json"), "planned");
}
