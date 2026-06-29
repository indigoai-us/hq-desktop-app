use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Claude Code sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_claude_sessions() -> Result<Vec<AgentSession>, String> {
    let projects_dir = hq_desktop_core::sessions::claude::claude_projects_dir();
    let hq_root = hq_desktop_core::sessions::claude::resolve_hq_folder();
    Ok(hq_desktop_core::sessions::claude::scan_claude_sessions(
        &projects_dir,
        hq_root.as_deref(),
        SystemTime::now(),
    ))
}
