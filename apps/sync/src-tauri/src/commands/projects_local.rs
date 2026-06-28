//! Thin Tauri command wrappers for the local Projects filesystem layer.
//!
//! The pure data shapes and helpers live in `hq_desktop_core::projects_local`;
//! this module keeps the Tauri command registration surface stable.

use hq_desktop_core::projects_local::{
    read_company_goals, read_crm_projection, read_project_prd, read_project_readme,
    resolve_hq_folder, scan_local_projects, write_project_status, write_story_passes,
};
#[allow(unused_imports)]
pub use hq_desktop_core::projects_local::{
    CompanyGoals, Initiative, KeyResult, LocalProject, LocalProjectPrd, LocalStory, Objective,
};

#[tauri::command]
pub async fn get_local_projects() -> Result<Vec<LocalProject>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    Ok(scan_local_projects(&hq))
}

#[tauri::command]
pub async fn get_local_project_prd(prd_path: String) -> Result<LocalProjectPrd, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_project_prd(&hq, &prd_path)
}

#[tauri::command]
pub async fn get_local_project_readme(prd_path: String) -> Result<Option<String>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_project_readme(&hq, &prd_path)
}

#[tauri::command]
pub async fn get_local_company_goals(company_slug: String) -> Result<CompanyGoals, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("goals reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_company_goals(&hq, &company_slug)
}

#[tauri::command]
pub async fn get_company_crm_projection(company_slug: String) -> Result<serde_json::Value, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("CRM projection reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_crm_projection(&hq, &company_slug)
}

#[tauri::command]
pub async fn set_local_project_status(
    board_path: String,
    project_id: String,
    status: String,
) -> Result<(), String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("projects writer requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    write_project_status(&hq, &board_path, &project_id, &status)
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
    let hq = resolve_hq_folder();
    write_story_passes(&hq, &prd_path, &story_id, passes)
}
