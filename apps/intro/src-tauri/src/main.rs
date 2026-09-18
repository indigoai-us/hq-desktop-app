// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Standalone preview of the HQ cinematic welcome intro.
//!
//! One transparent window sized to the primary monitor's work area, with the
//! same native frosted material the shipped app uses behind its onboarding
//! sheet, so the film opens over the person's real, blurred desktop. There is
//! no tray, no sign-in, no sync: the film plays, and the app quits when it is
//! finished or skipped.

use tauri::{AppHandle, Manager};

/// Called by the webview when the intro ends or is skipped. Quits the app.
#[tauri::command]
fn intro_finished(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![intro_finished])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");

            // Cover the work area rather than going true-fullscreen: macOS
            // fullscreen creates a Space and animates into it, which fights the
            // film's own iris. A borderless window the size of the work area
            // reads as fullscreen without the Space switch.
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let scale = monitor.scale_factor();
                let size = monitor.work_area().size.to_logical::<f64>(scale);
                let pos = monitor.work_area().position.to_logical::<f64>(scale);
                let _ = window.set_size(tauri::LogicalSize::new(size.width, size.height));
                let _ = window.set_position(tauri::LogicalPosition::new(pos.x, pos.y));
            }

            // Native blur of whatever is behind the window. CSS backdrop-filter
            // cannot see the desktop from inside a transparent webview; this can.
            hq_platform::window_effects::apply_popover_vibrancy(&window);

            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HQ Welcome Preview");
}
