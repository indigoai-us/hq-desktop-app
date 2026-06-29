pub use hq_desktop_core::sessions::history::HistoryEvent;

/// Build the Mission Control history feed from the local HQ workspace.
#[tauri::command]
pub async fn list_session_history() -> Result<Vec<HistoryEvent>, String> {
    let workspace = match hq_desktop_core::sessions::history::resolve_workspace_dir() {
        Some(w) => w,
        None => return Ok(Vec::new()),
    };
    Ok(hq_desktop_core::sessions::history::derive_history(
        &workspace,
    ))
}
