use std::collections::HashSet;
use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Claude Code sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_claude_sessions() -> Result<Vec<AgentSession>, String> {
    Ok(scan_local_claude_sessions())
}

/// Blocking scan of the local Claude transcripts (thousands of `stat`s). The
/// sessions poller runs this on a blocking thread; the async command above is
/// a thin wrapper for the invoke handler.
pub fn scan_local_claude_sessions() -> Vec<AgentSession> {
    let hq_root = hq_desktop_core::sessions::claude::resolve_hq_folder();
    let now = SystemTime::now();
    let mut sessions: Vec<_> = hq_desktop_core::sessions::claude::claude_projects_dirs()
        .into_iter()
        .flat_map(|projects_dir| {
            hq_desktop_core::sessions::claude::scan_claude_sessions(
                &projects_dir,
                hq_root.as_deref(),
                now,
            )
        })
        .collect();
    sessions.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    let mut seen = HashSet::new();
    sessions.retain(|session| seen.insert(session.id.clone()));
    sessions
}
