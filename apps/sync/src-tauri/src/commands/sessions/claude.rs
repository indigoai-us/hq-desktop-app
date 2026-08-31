use std::collections::HashSet;
use std::time::SystemTime;

use crate::commands::sessions::AgentSession;

/// List the local Claude Code sessions as [`AgentSession`] records.
#[tauri::command]
pub async fn list_local_claude_sessions() -> Result<Vec<AgentSession>, String> {
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
    Ok(sessions)
}
