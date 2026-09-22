// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Standalone preview of the HQ cinematic welcome intro.
//!
//! One transparent window covering the WHOLE display — past the menu bar and
//! the Dock — with the same native full-screen material the shipped app uses,
//! so the film opens over the person's real, blurred desktop. There is no
//! tray, no sign-in, no sync: the film plays, and the app quits when it is
//! finished or skipped.
//!
//! The geometry, the window level and the fade come from
//! `hq_platform::intro_window`, the same code the shipped app's
//! `set_intro_fullscreen` command runs, so this preview IS the shipped window.

use hq_platform::intro_window::{
    animate_window_alpha, intro_frame_from_screen, pick_intro_screen, set_window_alpha,
    set_window_level, IntroRect, INTRO_WINDOW_LEVEL,
};
use tauri::{AppHandle, Manager};

/// Matches `INTRO_FADE_IN_MS` in `apps/sync/src/lib/intro-window.ts`: the
/// desktop blurs up under the film over 700ms, ease-out.
const FADE_IN_MS: f64 = 700.0;

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

            #[cfg(target_os = "macos")]
            let ns_window = window.ns_window().unwrap_or(std::ptr::null_mut());
            #[cfg(not(target_os = "macos"))]
            let ns_window = std::ptr::null_mut();

            // Invisible first: the jump onto the full-screen frame happens
            // off-screen, and the person only ever sees the fade.
            set_window_alpha(ns_window, 0.0);

            // The FULL display bounds, not the work area: covering the menu bar
            // and the Dock is what makes this read as full screen rather than
            // as a very large window.
            if let Ok(monitors) = window.available_monitors() {
                let screens: Vec<IntroRect> = monitors
                    .iter()
                    .map(|m| {
                        IntroRect::new(
                            m.position().x as f64,
                            m.position().y as f64,
                            m.size().width as f64,
                            m.size().height as f64,
                        )
                    })
                    .collect();
                let current = window
                    .outer_position()
                    .ok()
                    .zip(window.outer_size().ok())
                    .map(|(p, s)| {
                        IntroRect::new(p.x as f64, p.y as f64, s.width as f64, s.height as f64)
                    })
                    .unwrap_or(IntroRect::new(0.0, 0.0, 0.0, 0.0));
                if let Some(index) = pick_intro_screen(current, &screens) {
                    let frame = intro_frame_from_screen(screens[index]);
                    let _ = window
                        .set_position(tauri::PhysicalPosition::new(frame.x as i32, frame.y as i32));
                    let _ = window.set_size(tauri::PhysicalSize::new(
                        frame.width.max(1.0) as u32,
                        frame.height.max(1.0) as u32,
                    ));
                }
            }

            // Above the menu bar for the duration.
            set_window_level(ns_window, INTRO_WINDOW_LEVEL);

            // Native blur of whatever is behind the window. CSS backdrop-filter
            // cannot see the desktop from inside a transparent webview; this can.
            hq_platform::window_effects::apply_fullscreen_vibrancy(&window);

            let _ = window.show();
            let _ = window.set_focus();
            // Desktop → blurred film, in one fade.
            animate_window_alpha(ns_window, 1.0, FADE_IN_MS);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HQ Welcome Preview");
}
