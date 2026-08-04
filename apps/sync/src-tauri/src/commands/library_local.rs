//! Thin Tauri command wrappers for the local Skills & Workers Library surface.
//!
//! The pure data shapes and helpers live in `hq_desktop_core::library_local`;
//! this module keeps the Tauri command registration surface stable.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use hq_desktop_core::desktop_alt::workspace_grants_company_file_access;
use hq_desktop_core::library_local::{
    read_skill_detail_target, read_worker_detail_target, resolve_hq_folder,
    resolve_skill_detail_target, resolve_worker_detail_target, scan_company_library,
    scan_root_library, validate_slug, ResolvedLibraryDetailTarget,
};
use hq_desktop_core::skill_catalog::SkillCatalogExport;
#[allow(unused_imports)]
pub use hq_desktop_core::library_local::{
    LibraryItems, LibrarySkill, LibraryWorker, SkillDetail, WorkerDetail,
};
use hq_desktop_core::workspaces::{Workspace, WorkspaceKind};

fn authorized_library_company_slugs(workspaces: &[Workspace]) -> BTreeSet<String> {
    workspaces
        .iter()
        .filter(|workspace| {
            workspace.kind == WorkspaceKind::Company
                && workspace_grants_company_file_access(workspaces, &workspace.slug)
        })
        .map(|workspace| workspace.slug.clone())
        .collect()
}

fn require_library_company_access(
    workspaces: &[Workspace],
    company_slug: &str,
) -> Result<(), String> {
    if workspace_grants_company_file_access(workspaces, company_slug) {
        Ok(())
    } else {
        Err(format!(
            "company library is not authorized: {company_slug:?}"
        ))
    }
}

async fn hydrated_library_context() -> Result<(PathBuf, Vec<Workspace>), String> {
    let result = crate::commands::workspaces::list_syncable_workspaces().await?;
    Ok((PathBuf::from(result.hq_folder_path), result.workspaces))
}

fn require_matching_library_root(
    target: &ResolvedLibraryDetailTarget,
    hydrated_hq_root: &Path,
) -> Result<(), String> {
    let hydrated_root = std::fs::canonicalize(hydrated_hq_root)
        .map_err(|error| format!("could not resolve hydrated HQ folder: {error}"))?;
    if target.hq_root == hydrated_root {
        Ok(())
    } else {
        Err("HQ folder changed during Library authorization".to_string())
    }
}

async fn authorize_library_detail_target(
    target: &ResolvedLibraryDetailTarget,
) -> Result<(), String> {
    let Some(company_slug) = target.company_slug.as_deref() else {
        return Ok(());
    };
    let (hydrated_hq_root, workspaces) = hydrated_library_context().await?;
    require_matching_library_root(target, &hydrated_hq_root)?;
    require_library_company_access(&workspaces, company_slug)
}

/// List the ROOT library: public/root + personal items, plus only company items
/// authorized by the current live workspace snapshot.
#[tauri::command]
pub async fn get_library_root() -> Result<LibraryItems, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let (hq, workspaces) = hydrated_library_context().await?;
    let authorized = authorized_library_company_slugs(&workspaces);
    Ok(scan_root_library(&hq, &authorized))
}

/// List a single company's library: its private workers (registry entries whose
/// `path` is under `companies/<slug>/workers/`) plus `companies/<slug>/skills/*`.
#[tauri::command]
pub async fn get_library_company(company_slug: String) -> Result<LibraryItems, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let company_slug = validate_slug(&company_slug)?;
    let (hq, workspaces) = hydrated_library_context().await?;
    require_library_company_access(&workspaces, &company_slug)?;
    scan_company_library(&hq, &company_slug)
}

/// Read one worker's `worker.yaml` by its HQ-relative directory path.
#[tauri::command]
pub async fn get_library_worker_detail(worker_path: String) -> Result<WorkerDetail, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    let target = resolve_worker_detail_target(&hq, &worker_path)?;
    authorize_library_detail_target(&target).await?;
    let refreshed = resolve_worker_detail_target(&hq, &worker_path)?;
    if refreshed != target {
        return Err("Library worker target changed during authorization".to_string());
    }
    read_worker_detail_target(&refreshed)
}

/// Read one skill's `SKILL.md` (frontmatter + body) by its HQ-relative path.
#[tauri::command]
pub async fn get_library_skill_detail(skill_path: String) -> Result<SkillDetail, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    let target = resolve_skill_detail_target(&hq, &skill_path)?;
    authorize_library_detail_target(&target).await?;
    let refreshed = resolve_skill_detail_target(&hq, &skill_path)?;
    if refreshed != target {
        return Err("Library skill target changed during authorization".to_string());
    }
    read_skill_detail_target(&refreshed)
}

/// Export a bounded markdown skill catalog for Claude Code Desktop bootstrap.
/// When `company_slug` is set, company skills are listed first and shadow
/// root/package names on collision — matching SessionStart catalog semantics.
#[tauri::command]
pub async fn export_skill_catalog(company_slug: Option<String>) -> Result<SkillCatalogExport, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    let slug = company_slug
        .as_deref()
        .map(validate_slug)
        .transpose()?;
    if let Some(company_slug) = slug.as_deref() {
        let (_, workspaces) = hydrated_library_context().await?;
        require_library_company_access(&workspaces, company_slug)?;
    }
    Ok(hq_desktop_core::skill_catalog::export_skill_catalog(
        &hq,
        slug.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::workspaces::{Workspace, WorkspaceKind, WorkspaceState};

    fn workspace(
        slug: &str,
        state: WorkspaceState,
        membership_status: Option<&str>,
        cloud_uid: Option<&str>,
        has_local_folder: bool,
    ) -> Workspace {
        Workspace {
            slug: slug.to_string(),
            display_name: slug.to_string(),
            kind: WorkspaceKind::Company,
            state,
            cloud_uid: cloud_uid.map(str::to_string),
            bucket_name: cloud_uid.map(|_| format!("{slug}-bucket")),
            has_local_folder,
            local_path: has_local_folder.then(|| format!("/tmp/HQ/companies/{slug}")),
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
    fn library_company_access_requires_live_active_or_true_local_only() {
        let workspaces = vec![
            workspace(
                "active",
                WorkspaceState::Synced,
                Some("active"),
                Some("cmp_active"),
                true,
            ),
            workspace(
                "pending",
                WorkspaceState::Synced,
                Some("pending"),
                Some("cmp_pending"),
                true,
            ),
            workspace(
                "revoked",
                WorkspaceState::Synced,
                Some("revoked"),
                Some("cmp_revoked"),
                true,
            ),
            // Models cloud hydration being unavailable: the manifest still
            // identifies a cloud-bound workspace, but there is no live status.
            workspace(
                "offline-cloud",
                WorkspaceState::Synced,
                None,
                Some("cmp_offline"),
                true,
            ),
            workspace("local-only", WorkspaceState::LocalOnly, None, None, true),
            workspace(
                "cloud-only",
                WorkspaceState::CloudOnly,
                Some("active"),
                Some("cmp_cloud_only"),
                false,
            ),
        ];

        let allowed = authorized_library_company_slugs(&workspaces);
        assert_eq!(
            allowed.into_iter().collect::<Vec<_>>(),
            vec!["active".to_string(), "local-only".to_string()]
        );
        assert!(require_library_company_access(&workspaces, "active").is_ok());
        assert!(require_library_company_access(&workspaces, "local-only").is_ok());
        for denied in [
            "pending",
            "revoked",
            "offline-cloud",
            "cloud-only",
            "missing",
        ] {
            assert!(
                require_library_company_access(&workspaces, denied).is_err(),
                "{denied}"
            );
        }
    }
}
