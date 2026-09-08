use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Codex sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_codex_sessions() -> Result<Vec<AgentSession>, String> {
    Ok(scan_local_codex_sessions())
}

/// Blocking scan of the local Codex rollouts. The sessions poller runs this on
/// a blocking thread; the async command above wraps it for the invoke handler.
pub fn scan_local_codex_sessions() -> Vec<AgentSession> {
    hq_desktop_core::sessions::codex::scan_codex_sessions(
        &hq_desktop_core::sessions::codex::codex_dir(),
        SystemTime::now(),
    )
}
