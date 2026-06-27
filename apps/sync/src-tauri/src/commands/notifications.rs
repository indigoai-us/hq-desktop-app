use tauri::AppHandle;

/// Read the current OS notification authorization without prompting.
/// Returns `"granted" | "denied" | "prompt" | "unknown"`.
#[tauri::command]
pub async fn notification_permission_state(_app: AppHandle) -> Result<String, String> {
    Ok(hq_platform::notifications::permission_state())
}

/// Request OS notification authorization. On macOS this shows the system dialog
/// only when the status is not yet determined; afterwards it silently returns
/// the existing status. Returns the freshly-read state
/// `"granted" | "denied" | "prompt" | "unknown"`.
#[tauri::command]
pub async fn notification_request_permission(_app: AppHandle) -> Result<String, String> {
    Ok(hq_platform::notifications::request_permission())
}
