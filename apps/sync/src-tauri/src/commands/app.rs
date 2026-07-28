use tauri::Manager;

/// Terminate the app from the renderer. Used by the in-popover Quit
/// button — the menubar-app close handler intercepts plain window-close
/// events and only hides, so the renderer needs an explicit exit path
/// to mirror what the tray's Quit menu item does (`app.exit(0)`).
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Raise the main installer / popover window above other apps after OAuth
/// (macOS + Windows). Uses the sticky post-OAuth raise so the wizard stays
/// above the browser for the next step — not the generic show path used by
/// first-run launch (which must not cover the provider login page).
#[tauri::command]
pub fn bring_main_window_to_front(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is not available.".to_string())?;
    crate::util::window_focus::bring_webview_to_front_after_oauth(&window);
    Ok(())
}

/// Ask the main menubar window to show its existing Settings surface.
///
/// Desktop-alt is a separate webview, but Settings still lives in the main
/// popover App.svelte state. This command keeps the renderer contract simple:
/// desktop UI invokes `open_settings_window`, Rust shows/focuses the main
/// window, then emits the same event path the tray menu already uses.
#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    if let Some(window) = app.get_webview_window("main") {
        crate::util::window_focus::bring_webview_to_front(&window);
    }

    app.emit_to("main", "tray:open-settings", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a Claude Code deep link (`claude://code/new?...`). The renderer
/// can't call `@tauri-apps/plugin-shell` `open()` for non-http(s) schemes
/// without widening `shell:allow-open` to the world; this command keeps
/// the surface tight by only forwarding validated `claude://` URLs to the OS
/// URL dispatcher.
///
/// The URL is byte-validated by `launch::validate_claude_deep_link` before it
/// reaches the dispatcher — a scheme check alone would let whitespace, quotes,
/// or shell metacharacters through to the OS URL dispatcher (the hq-installer
/// hardening).
#[tauri::command]
pub fn open_claude_code_link(url: String) -> Result<(), String> {
    crate::commands::launch::validate_claude_deep_link(&url)?;

    #[cfg(not(windows))]
    {
        return open_claude_code_link_macos(&url);
    }

    #[cfg(windows)]
    {
        return open_claude_code_link_windows(&url);
    }
}

#[cfg(not(windows))]
fn open_claude_code_link_macos(url: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg(url)
        .output()
        .map_err(|e| format!("Failed to run open: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open exited {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn shell_execute_succeeded(result: isize) -> bool {
    // ShellExecuteW returns an HINSTANCE-style error value in the inclusive
    // 0..=32 range and a value greater than 32 when dispatch succeeded.
    result > 32
}

#[cfg(windows)]
fn open_claude_code_link_windows(url: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide_url: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    // ShellExecuteW hands the already-validated URL directly to the registered
    // protocol handler. This intentionally avoids `cmd /C start`: even with an
    // empty title, cmd would re-parse URI characters such as `&`, and no helper
    // subprocess means there is no console window to flash.
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            None,
            PCWSTR(wide_url.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW's HINSTANCE is a legacy integer status smuggled through a
    // pointer type, so converting it to isize here is intentional.
    let result = result.0 as isize;
    if !shell_execute_succeeded(result) {
        return Err(format!(
            "ShellExecuteW failed to open claude link: {}",
            result
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::shell_execute_succeeded;

    #[cfg(windows)]
    #[test]
    fn shell_execute_treats_documented_error_values_as_failures() {
        assert!(!shell_execute_succeeded(0));
        assert!(!shell_execute_succeeded(32));
        assert!(shell_execute_succeeded(33));
    }
}
