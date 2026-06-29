//! Thin Tauri command wrappers for the local Skills & Workers Library surface.
//!
//! The pure data shapes and helpers live in `hq_desktop_core::library_local`;
//! this module keeps the Tauri command registration surface stable.

use hq_desktop_core::library_local::{
    read_skill_detail, read_worker_detail, resolve_hq_folder, scan_company_library,
    scan_root_library,
};
#[allow(unused_imports)]
pub use hq_desktop_core::library_local::{
    LibraryItems, LibrarySkill, LibraryWorker, SkillDetail, WorkerDetail,
};

/// List the ROOT/shared library: public workers from `registry.yaml` plus skills
/// from `.claude/skills/*` (scope `root`) and `personal/skills/*` (scope
/// `personal`). Empty (not an error) when nothing resolves.
#[tauri::command]
pub async fn get_library_root() -> Result<LibraryItems, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    Ok(scan_root_library(&hq))
}

/// List a single company's library: its private workers (registry entries whose
/// `path` is under `companies/<slug>/workers/`) plus `companies/<slug>/skills/*`.
#[tauri::command]
pub async fn get_library_company(company_slug: String) -> Result<LibraryItems, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    scan_company_library(&hq, &company_slug)
}

/// Read one worker's `worker.yaml` by its HQ-relative directory path.
#[tauri::command]
pub async fn get_library_worker_detail(worker_path: String) -> Result<WorkerDetail, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_worker_detail(&hq, &worker_path)
}

/// Read one skill's `SKILL.md` (frontmatter + body) by its HQ-relative path.
#[tauri::command]
pub async fn get_library_skill_detail(skill_path: String) -> Result<SkillDetail, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("library reader requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_skill_detail(&hq, &skill_path)
}
