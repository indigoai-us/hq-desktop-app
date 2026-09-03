use tauri::{AppHandle, Manager};

/// True when any HQ window currently has OS keyboard focus. Used by the native
/// notification gate's "only when the app is not focused" rule so an OS banner
/// is suppressed while the user is already looking at HQ. Cheap best-effort
/// read — a window whose focus state can't be queried counts as unfocused.
pub fn app_is_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

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

/// Open the OS-owned notification settings surface. The frontend never carries
/// a platform URI, so Windows cannot be sent to the macOS preferences route.
#[tauri::command]
pub async fn notification_open_settings(_app: AppHandle) -> Result<(), String> {
    hq_platform::notifications::open_settings()
}
