use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Codex sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_codex_sessions() -> Result<Vec<AgentSession>, String> {
    Ok(hq_desktop_core::sessions::codex::scan_codex_sessions(
        &hq_desktop_core::sessions::codex::codex_dir(),
        SystemTime::now(),
    ))
}
