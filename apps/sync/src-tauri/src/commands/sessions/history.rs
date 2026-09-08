pub use hq_desktop_core::sessions::history::HistoryEvent;

/// Build the Mission Control history feed from the local HQ workspace.
#[tauri::command]
pub async fn list_session_history() -> Result<Vec<HistoryEvent>, String> {
    Ok(derive_local_session_history())
}

/// Blocking derivation of the history feed (walks the workspace). The sessions
/// poller runs this on a blocking thread; the async command above wraps it.
pub fn derive_local_session_history() -> Vec<HistoryEvent> {
    let workspace = match hq_desktop_core::sessions::history::resolve_workspace_dir() {
        Some(w) => w,
        None => return Vec::new(),
    };
    hq_desktop_core::sessions::history::derive_history(&workspace)
}
