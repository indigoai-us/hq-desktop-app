//! Thin Tauri command wrappers for the local Projects filesystem layer.
//!
//! The pure data shapes and helpers live in `hq_desktop_core::projects_local`;
//! this module keeps the Tauri command registration surface stable.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use hq_desktop_core::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, validate_hq_relative_path,
    workspace_grants_company_file_access,
};
use hq_desktop_core::projects_local::{
    read_company_goals, read_crm_projection, read_project_prd, read_project_readme,
    resolve_project_path, resolve_project_write_path, scan_local_projects_for_companies,
    write_project_status, write_story_passes,
};
#[allow(unused_imports)]
pub use hq_desktop_core::projects_local::{
    CompanyGoals, Initiative, KeyResult, LocalProject, LocalProjectPrd, LocalStory, Objective,
    ResolvedProjectPath, WorkProvenance,
};
use hq_desktop_core::workspaces::Workspace;

fn authorized_company_slugs(workspaces: &[Workspace]) -> HashSet<String> {
    workspaces
        .iter()
        .filter(|workspace| workspace_grants_company_file_access(workspaces, &workspace.slug))
        .map(|workspace| workspace.slug.clone())
        .collect()
}

fn authorize_project_target(
    hq_root: &Path,
    rel_path: &str,
    expected_filename: &str,
    for_write: bool,
    workspaces: &[Workspace],
) -> Result<ResolvedProjectPath, String> {
    let target = if for_write {
        resolve_project_write_path(hq_root, rel_path, expected_filename)?
    } else {
        resolve_project_path(hq_root, rel_path, expected_filename)?
    };
    if let Some(slug) = target.company_slug.as_deref() {
        if !workspace_grants_company_file_access(workspaces, slug) {
            return Err(format!("company projects are not authorized: {slug:?}"));
        }
    }
    Ok(target)
}

/// `Ok(Some(slug))` — authorized, and `companies/{slug}` exists on disk.
/// `Ok(None)` — authorized, but the folder does not exist yet.
///
/// The `None` arm is the first-open case: a signed-in user whose initial sync
/// has not materialized the company folder. The readers behind this gate
/// (`read_company_goals`, `read_crm_projection`) already treat missing FILES
/// as empty state, but `canonical_hq_relative_path` canonicalizes the
/// DIRECTORY and `fs::canonicalize` fails on a path that does not exist — so
/// every brand-new user's Home board opened on "Board unavailable. Try again
/// after a sync." Membership is checked before touching the disk: a missing
/// folder must never change an authorization verdict, only downgrade
/// "present" to "empty".
fn authorize_company_slug(
    hq_root: &Path,
    company_slug: &str,
    workspaces: &[Workspace],
) -> Result<Option<String>, String> {
    let slug = company_slug.trim();
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug == "." || slug == ".." {
        return Err(format!("invalid company_slug: {company_slug:?}"));
    }
    let relative = validate_hq_relative_path(&format!("companies/{slug}"), false)?;
    if company_slug_for_hq_path(&relative)?.as_deref() != Some(slug) {
        return Err(format!("invalid company_slug: {company_slug:?}"));
    }
    if !workspace_grants_company_file_access(workspaces, slug) {
        return Err(format!("company projects are not authorized: {slug:?}"));
    }
    // Symlink-metadata rather than exists(): a dangling or outward-pointing
    // symlink is present-but-suspect and must fall through to the canonical
    // check below, not masquerade as the innocent empty state.
    if std::fs::symlink_metadata(hq_root.join(&relative)).is_err() {
        return Ok(None);
    }
    let canonical = canonical_hq_relative_path(hq_root, &relative, false)?;
    if canonical != relative {
        return Err("company path resolves to a different canonical company".to_string());
    }
    Ok(Some(slug.to_string()))
}

fn authorize_project_identity_path(
    hq_root: &Path,
    prd_path: Option<&str>,
    expected_company: Option<&str>,
    workspaces: &[Workspace],
) -> Result<Option<String>, String> {
    let Some(raw) = prd_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let normalized = validate_hq_relative_path(raw, false)?;
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some("prd.json")
    {
        return Err("prd_path must point at a prd.json file".to_string());
    }
    let lexical_company = company_slug_for_hq_path(&normalized)?;
    if lexical_company.as_deref() != expected_company {
        return Err("project PRD identity crosses HQ company boundaries".to_string());
    }

    let candidate = hq_root.join(&normalized);
    if candidate.exists() {
        let target = authorize_project_target(hq_root, &normalized, "prd.json", false, workspaces)?;
        if target.company_slug.as_deref() != expected_company {
            return Err("project PRD identity crosses HQ company boundaries".to_string());
        }
        return Ok(Some(target.relative_path));
    }
    if let Some(slug) = lexical_company.as_deref() {
        if !workspace_grants_company_file_access(workspaces, slug) {
            return Err(format!("company projects are not authorized: {slug:?}"));
        }
    }
    Ok(Some(normalized))
}

async fn hydrated_project_context() -> Result<(PathBuf, Vec<Workspace>), String> {
    let result = crate::commands::workspaces::list_syncable_workspaces().await?;
    Ok((PathBuf::from(result.hq_folder_path), result.workspaces))
}

#[tauri::command]
pub async fn get_local_projects() -> Result<Vec<LocalProject>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let authorized = authorized_company_slugs(&workspaces);
    tauri::async_runtime::spawn_blocking(move || {
        scan_local_projects_for_companies(&hq, &authorized)
    })
    .await
    .map_err(|error| format!("projects scan task join: {error}"))
}

#[tauri::command]
pub async fn get_local_project_prd(prd_path: String) -> Result<LocalProjectPrd, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let target = authorize_project_target(&hq, &prd_path, "prd.json", false, &workspaces)?;
    read_project_prd(&hq, &target.relative_path)
}

#[tauri::command]
pub async fn get_local_project_readme(prd_path: String) -> Result<Option<String>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let target = authorize_project_target(&hq, &prd_path, "prd.json", false, &workspaces)?;
    read_project_readme(&hq, &target.relative_path)
}

#[tauri::command]
pub async fn get_local_company_goals(company_slug: String) -> Result<CompanyGoals, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("goals reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let Some(slug) = authorize_company_slug(&hq, &company_slug, &workspaces)? else {
        return Ok(CompanyGoals::default());
    };
    read_company_goals(&hq, &slug)
}

#[tauri::command]
pub async fn get_company_crm_projection(company_slug: String) -> Result<serde_json::Value, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("CRM projection reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let Some(slug) = authorize_company_slug(&hq, &company_slug, &workspaces)? else {
        return Ok(serde_json::Value::Null);
    };
    read_crm_projection(&hq, &slug)
}

#[tauri::command]
pub async fn set_local_project_status(
    board_path: String,
    project_id: String,
    prd_path: Option<String>,
    status: String,
) -> Result<(), String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects writer requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let board = authorize_project_target(&hq, &board_path, "board.json", true, &workspaces)?;
    let normalized_prd = authorize_project_identity_path(
        &hq,
        prd_path.as_deref(),
        board.company_slug.as_deref(),
        &workspaces,
    )?;
    write_project_status(
        &hq,
        &board.relative_path,
        &project_id,
        normalized_prd.as_deref(),
        &status,
    )
}

#[tauri::command]
pub async fn set_local_story_passes(
    prd_path: String,
    story_id: String,
    passes: bool,
) -> Result<(), String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects writer requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_project_context().await?;
    let target = authorize_project_target(&hq, &prd_path, "prd.json", true, &workspaces)?;
    write_story_passes(&hq, &target.relative_path, &story_id, passes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::workspaces::{WorkspaceKind, WorkspaceState};

    fn project_workspace(
        slug: &str,
        state: WorkspaceState,
        membership_status: Option<&str>,
        cloud_uid: Option<&str>,
    ) -> Workspace {
        Workspace {
            slug: slug.to_string(),
            display_name: slug.to_string(),
            kind: WorkspaceKind::Company,
            state,
            cloud_uid: cloud_uid.map(str::to_string),
            bucket_name: cloud_uid.map(|uid| format!("bucket-{uid}")),
            has_local_folder: true,
            local_path: Some(format!("/tmp/HQ/companies/{slug}")),
            membership_status: membership_status.map(str::to_string),
            role: Some("member".to_string()),
            sync_enabled: true,
            last_synced_at: None,
            broken_reason: None,
            invited_by: None,
            invited_at: None,
            branding_enabled: false,
            brand: None,
        }
    }

    #[test]
    fn a_missing_company_folder_is_empty_state_not_an_error() {
        // First open: the user signed in moments ago and the initial sync has
        // not materialized `companies/personal` yet. The Home board loads
        // immediately and asks for personal goals. This must be the empty
        // state — the same verdict read_company_goals gives a missing
        // board.json — not the red "Board unavailable" banner every new user
        // saw on their first launch.
        let temp = tempfile::tempdir().unwrap();
        // The REAL personal-row shape (state Personal, cloud_uid set) — the
        // LocalOnly fixture this replaced passed while every actual user's
        // personal board was denied one layer below, in
        // workspace_grants_company_file_access.
        let mut personal = project_workspace("personal", WorkspaceState::Personal, None, Some("prs_abc"));
        personal.kind = WorkspaceKind::Personal;
        personal.role = None;
        let workspaces = vec![personal];

        let verdict = authorize_company_slug(temp.path(), "personal", &workspaces)
            .expect("an authorized slug with no folder yet must not error");
        assert_eq!(verdict, None);
    }

    #[test]
    fn a_missing_folder_does_not_bypass_membership_denial() {
        // The empty-state shortcut must sit BEHIND the membership check: a
        // revoked company whose folder is gone is still "not authorized",
        // never "authorized and empty".
        let temp = tempfile::tempdir().unwrap();
        let workspaces = vec![project_workspace(
            "revoked",
            WorkspaceState::Synced,
            Some("revoked"),
            Some("cmp_revoked"),
        )];

        let err = authorize_company_slug(temp.path(), "revoked", &workspaces)
            .expect_err("revoked membership must stay denied even with no folder");
        assert!(err.contains("not authorized"), "{err}");
    }

    #[test]
    fn a_present_company_folder_still_authorizes_by_canonical_path() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("companies/local")).unwrap();
        let workspaces = vec![project_workspace("local", WorkspaceState::LocalOnly, None, None)];

        let verdict = authorize_company_slug(temp.path(), "local", &workspaces)
            .expect("present + authorized folder resolves");
        assert_eq!(verdict.as_deref(), Some("local"));
    }

    #[test]
    fn authorized_project_companies_allow_active_and_true_local_only_only() {
        let workspaces = vec![
            project_workspace(
                "active",
                WorkspaceState::Synced,
                Some("active"),
                Some("cmp_active"),
            ),
            project_workspace(
                "pending",
                WorkspaceState::Synced,
                Some("pending"),
                Some("cmp_pending"),
            ),
            project_workspace(
                "revoked",
                WorkspaceState::Synced,
                Some("revoked"),
                Some("cmp_revoked"),
            ),
            project_workspace(
                "offline-cloud",
                WorkspaceState::Synced,
                None,
                Some("cmp_offline"),
            ),
            project_workspace("local", WorkspaceState::LocalOnly, None, None),
        ];

        let allowed = authorized_company_slugs(&workspaces);
        assert_eq!(
            allowed,
            HashSet::from(["active".to_string(), "local".to_string()]),
        );
    }

    #[test]
    fn project_targets_require_live_membership_but_preserve_personal_scope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for slug in ["active", "pending", "offline-cloud", "local"] {
            let dir = root.join("companies").join(slug).join("projects/demo");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("prd.json"), r#"{"name":"Demo","userStories":[]}"#).unwrap();
        }
        std::fs::create_dir_all(root.join("personal/projects/demo")).unwrap();
        std::fs::write(
            root.join("personal/projects/demo/prd.json"),
            r#"{"name":"Personal","userStories":[]}"#,
        )
        .unwrap();
        let workspaces = vec![
            project_workspace(
                "active",
                WorkspaceState::Synced,
                Some("active"),
                Some("cmp_active"),
            ),
            project_workspace(
                "pending",
                WorkspaceState::Synced,
                Some("pending"),
                Some("cmp_pending"),
            ),
            project_workspace(
                "offline-cloud",
                WorkspaceState::Synced,
                None,
                Some("cmp_offline"),
            ),
            project_workspace("local", WorkspaceState::LocalOnly, None, None),
        ];

        assert!(authorize_project_target(
            root,
            "companies/active/projects/demo/prd.json",
            "prd.json",
            false,
            &workspaces,
        )
        .is_ok());
        assert!(authorize_project_target(
            root,
            "companies/local/projects/demo/prd.json",
            "prd.json",
            false,
            &workspaces,
        )
        .is_ok());
        for denied in [
            "companies/pending/projects/demo/prd.json",
            "companies/offline-cloud/projects/demo/prd.json",
        ] {
            assert!(
                authorize_project_target(root, denied, "prd.json", false, &workspaces).is_err(),
                "{denied} must fail closed",
            );
        }
        assert!(
            authorize_project_target(
                root,
                "companies/unknown/projects/demo/prd.json",
                "prd.json",
                false,
                &workspaces,
            )
            .is_err(),
            "unknown companies fail closed",
        );
        assert!(
            authorize_project_target(root, "../outside/prd.json", "prd.json", false, &workspaces,)
                .is_err(),
            "traversal is rejected",
        );
        assert!(
            authorize_project_target(
                root,
                "personal/projects/demo/prd.json",
                "prd.json",
                false,
                &workspaces,
            )
            .is_ok(),
            "legitimate non-company HQ content remains available",
        );
    }

    #[test]
    fn goals_crm_and_project_identity_paths_share_the_same_company_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for slug in ["active", "pending", "local"] {
            std::fs::create_dir_all(root.join("companies").join(slug)).unwrap();
        }
        let workspaces = vec![
            project_workspace(
                "active",
                WorkspaceState::Synced,
                Some("active"),
                Some("cmp_active"),
            ),
            project_workspace(
                "pending",
                WorkspaceState::Synced,
                Some("pending"),
                Some("cmp_pending"),
            ),
            project_workspace("local", WorkspaceState::LocalOnly, None, None),
        ];

        assert_eq!(
            authorize_company_slug(root, "active", &workspaces)
                .unwrap()
                .as_deref(),
            Some("active"),
        );
        assert_eq!(
            authorize_company_slug(root, "local", &workspaces)
                .unwrap()
                .as_deref(),
            Some("local"),
        );
        assert!(authorize_company_slug(root, "pending", &workspaces).is_err());
        assert!(authorize_company_slug(root, "../active", &workspaces).is_err());

        assert_eq!(
            authorize_project_identity_path(
                root,
                Some("companies/active/projects/missing/prd.json"),
                Some("active"),
                &workspaces,
            )
            .unwrap()
            .as_deref(),
            Some("companies/active/projects/missing/prd.json"),
            "a same-company legacy discriminator may remain non-existent",
        );
        assert!(
            authorize_project_identity_path(
                root,
                Some("companies/pending/projects/secret/prd.json"),
                Some("active"),
                &workspaces,
            )
            .is_err(),
            "a board write cannot use another company PRD identity",
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_target_authorization_rejects_cross_company_aliases() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("companies/active/projects/alias")).unwrap();
        std::fs::create_dir_all(root.join("companies/pending/projects/secret")).unwrap();
        std::fs::write(
            root.join("companies/pending/projects/secret/prd.json"),
            r#"{"name":"Secret","userStories":[]}"#,
        )
        .unwrap();
        symlink(
            root.join("companies/pending/projects/secret/prd.json"),
            root.join("companies/active/projects/alias/prd.json"),
        )
        .unwrap();
        let workspaces = vec![project_workspace(
            "active",
            WorkspaceState::Synced,
            Some("active"),
            Some("cmp_active"),
        )];

        assert!(
            authorize_project_target(
                root,
                "companies/active/projects/alias/prd.json",
                "prd.json",
                false,
                &workspaces,
            )
            .is_err(),
            "an active lexical path must not resolve into another company",
        );
    }
}
