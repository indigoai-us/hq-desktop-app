use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Codex sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_codex_sessions() -> Result<Vec<AgentSession>, String> {
    let hq_root = hq_desktop_core::sessions::claude::resolve_hq_folder();
    Ok(hq_desktop_core::sessions::codex::scan_codex_sessions_with_hq(
        &hq_desktop_core::sessions::codex::codex_dir(),
        hq_root.as_deref(),
        SystemTime::now(),
    ))
}
