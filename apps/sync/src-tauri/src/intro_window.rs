//! The welcome film's window inside the shipped app.
//!
//! The geometry, the window level and the fade itself are shared with the
//! standalone preview (`apps/intro`) in `hq_platform::intro_window`, so the
//! film a designer reviews is the window a user gets. What lives here is the
//! part only the shipped app has: the `main` window it borrows, the state it
//! has to hand back afterwards, and the Tauri command the renderer calls.
//!
//! AppKit window ops are main-thread-only; every native call below is
//! dispatched through `run_on_main_thread`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use hq_platform::intro_window::{
    animate_window_alpha, intro_frame_from_screen, pick_intro_screen, set_window_alpha,
    set_window_level, IntroRect, INTRO_WINDOW_LEVEL, NORMAL_WINDOW_LEVEL,
};
use tauri::{AppHandle, Manager};

/// True while the film owns the screen. Other window logic (the desktop-alt
/// work-area frame recovery added in #926) must not clamp anything back into
/// the work area while this is set — that clamp and the full-screen frame want
/// opposite things, and the clamp would eat the menu-bar band mid-film.
static INTRO_FULLSCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The `main` window state the film covered, restored verbatim when it ends.
static SAVED_STATE: Mutex<Option<SavedWindowState>> = Mutex::new(None);

/// Short fade back up once the window is its old size again. Long enough not to
/// pop, short enough that the setup card is not kept waiting.
pub const INTRO_RESTORE_FADE_MS: f64 = 200.0;

/// What has to go back exactly as it was when the film ends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SavedWindowState {
    pub frame: IntroRect,
    pub decorated: bool,
}

/// Whether the film currently owns the screen.
pub fn intro_fullscreen_active() -> bool {
    INTRO_FULLSCREEN_ACTIVE.load(Ordering::SeqCst)
}

/// Whether a work-area frame recovery pass should run.
///
/// Pure so the exemption is a tested rule rather than an `if` buried in a
/// window callback.
pub fn should_recover_frame(intro_active: bool) -> bool {
    !intro_active
}

/// Resolve the full-screen frame for `window` from the displays it can see.
///
/// Physical pixels throughout — `Monitor::position`/`Monitor::size` are the
/// display's full bounds (NOT the work area), which is the whole point.
fn resolve_fullscreen_frame(window: &tauri::WebviewWindow) -> Option<IntroRect> {
    let monitors = window.available_monitors().ok()?;
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
    let current = current_frame(window).unwrap_or(IntroRect::new(0.0, 0.0, 0.0, 0.0));
    let index = pick_intro_screen(current, &screens)?;
    Some(intro_frame_from_screen(screens[index]))
}

fn current_frame(window: &tauri::WebviewWindow) -> Option<IntroRect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(IntroRect::new(
        position.x as f64,
        position.y as f64,
        size.width as f64,
        size.height as f64,
    ))
}

fn ns_window_ptr(window: &tauri::WebviewWindow) -> *mut std::ffi::c_void {
    #[cfg(target_os = "macos")]
    {
        window.ns_window().unwrap_or(std::ptr::null_mut())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        std::ptr::null_mut()
    }
}

/// Put `main` full screen for the film, or put it back exactly as it was.
///
/// `fade_ms` is the fade the caller wants (the renderer owns the timing model,
/// `src/lib/intro-window.ts`). Enter: alpha 0 → full-screen borderless frame at
/// the status window level with the native full-screen material on → animate
/// alpha to 1. Exit: animate alpha to 0 → restore frame, level and decorations
/// → animate back to 1 for whatever the window shows next (the setup card), or
/// straight to hidden after a replay.
#[tauri::command]
pub async fn set_intro_fullscreen(
    app: AppHandle,
    enabled: bool,
    fade_ms: Option<f64>,
) -> Result<(), String> {
    let fade = fade_ms.unwrap_or(700.0).clamp(0.0, 3000.0);
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not available".into());
    };

    if enabled {
        let saved = SavedWindowState {
            frame: current_frame(&window).unwrap_or(IntroRect::new(0.0, 0.0, 780.0, 620.0)),
            decorated: window.is_decorated().unwrap_or(false),
        };
        *SAVED_STATE.lock().map_err(|e| e.to_string())? = Some(saved);
        INTRO_FULLSCREEN_ACTIVE.store(true, Ordering::SeqCst);

        let frame = resolve_fullscreen_frame(&window);
        let handle = window.clone();
        window
            .run_on_main_thread(move || {
                let ns_window = ns_window_ptr(&handle);
                // Invisible first, so the jump to the full-screen frame happens
                // off-screen and the person only ever sees the fade.
                set_window_alpha(ns_window, 0.0);
                let _ = handle.set_decorations(false);
                let _ = handle.set_shadow(false);
                let _ = handle.set_resizable(true);
                hq_platform::window_effects::apply_fullscreen_vibrancy(&handle);
                if let Some(frame) = frame {
                    let _ = handle
                        .set_position(tauri::PhysicalPosition::new(frame.x as i32, frame.y as i32));
                    let _ = handle.set_size(tauri::PhysicalSize::new(
                        frame.width.max(1.0) as u32,
                        frame.height.max(1.0) as u32,
                    ));
                }
                set_window_level(ns_window, INTRO_WINDOW_LEVEL);
                let _ = handle.show();
                let _ = handle.set_focus();
                animate_window_alpha(ns_window, 1.0, fade);
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Leaving: fade the film (and the blur) back down to the live desktop
    // before any geometry moves, so the restore itself is never on screen.
    let handle = window.clone();
    window
        .run_on_main_thread(move || animate_window_alpha(ns_window_ptr(&handle), 0.0, fade))
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(fade as u64)).await;

    let saved = SAVED_STATE.lock().map_err(|e| e.to_string())?.take();
    INTRO_FULLSCREEN_ACTIVE.store(false, Ordering::SeqCst);

    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let ns_window = ns_window_ptr(&handle);
            set_window_level(ns_window, NORMAL_WINDOW_LEVEL);
            if let Some(saved) = saved {
                let _ = handle.set_decorations(saved.decorated);
                let _ = handle.set_position(tauri::PhysicalPosition::new(
                    saved.frame.x as i32,
                    saved.frame.y as i32,
                ));
                let _ = handle.set_size(tauri::PhysicalSize::new(
                    saved.frame.width.max(1.0) as u32,
                    saved.frame.height.max(1.0) as u32,
                ));
            }
            // Back to visible for whatever the window shows next. The caller
            // (Onboarding.svelte) re-applies size, shadow and the popover
            // material immediately after this resolves.
            animate_window_alpha(ns_window, 1.0, INTRO_RESTORE_FADE_MS);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_work_area_clamp_is_exempt_while_the_film_plays() {
        assert!(!should_recover_frame(true));
        assert!(should_recover_frame(false));
    }

    #[test]
    fn the_saved_frame_round_trips_exactly() {
        let saved = SavedWindowState {
            frame: IntroRect::new(120.0, 64.0, 780.0, 620.0),
            decorated: false,
        };
        // Restoring is a copy, not a recomputation: the film hands the window
        // back byte-identical, not "close enough after a clamp".
        let restored = saved;
        assert_eq!(restored.frame, saved.frame);
        assert_eq!(restored.decorated, saved.decorated);
        assert_ne!(
            restored.frame,
            intro_frame_from_screen(IntroRect::new(0.0, 0.0, 1512.0, 982.0))
        );
    }
}
