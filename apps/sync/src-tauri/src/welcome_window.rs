//! The welcome flow's window backdrop (first-run onboarding, the consent
//! re-prompt and the menu-bar "Replay welcome intro").
//!
//! The welcome flow is a full-bleed ~800x900 window with no wallpaper of its
//! own. Its backdrop is whatever is on the person's screen behind it, blurred
//! natively, with the renderer's dark veil (`.hq-welcome .veil`) on top. That
//! reads as their own desktop, blurred and dimmed, and it needs no screen
//! recording permission: the blur is an `NSVisualEffectView` in
//! behind-window blending mode, sampled by the window server.
//!
//! The material fades in over `fade_ms`, so the flow opens on the untouched
//! desktop and the blur settles over it, the way the prototype's veil did.
//!
//! On Windows the window takes the dark Acrylic/Mica backdrop the app already
//! uses; the veil does the rest. Elsewhere it is a no-op and the veil alone
//! darkens the (transparent) window.
//!
//! AppKit is main-thread-only; the command dispatches through
//! `run_on_main_thread`. Raw objc2 messaging, in the idiom of `glass.rs`.

use tauri::{AppHandle, Manager};

/// Corner radius of the welcome window. Matches `--w-window-radius` in
/// `src/components/onboarding/welcome/welcome.css`, so the native material and
/// the webview's veil round off together.
pub const WELCOME_CORNER_RADIUS: f64 = 12.0;

/// The fade the renderer asks for when it does not say.
pub const DEFAULT_WELCOME_FADE_MS: f64 = 1800.0;

/// Clamp the renderer's requested fade to something sane.
pub fn welcome_fade_ms(requested: Option<f64>) -> f64 {
    match requested {
        Some(ms) if ms.is_finite() => ms.clamp(0.0, 3000.0),
        _ => DEFAULT_WELCOME_FADE_MS,
    }
}

/// Put the native blur behind the welcome flow (`enabled`), or take it away.
///
/// Enabling clears the tray popover's vibrancy first, because a second
/// material stacked under this one would show as a lighter frame. Disabling
/// only removes this backdrop; the caller (`Onboarding.svelte`) re-applies the
/// popover material with `set_main_window_vibrancy` when it hands the window
/// back.
#[tauri::command]
pub fn set_welcome_backdrop(
    app: AppHandle,
    enabled: bool,
    fade_ms: Option<f64>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not available".into());
    };
    let fade = welcome_fade_ms(fade_ms);
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            if enabled {
                hq_platform::window_effects::clear_popover_vibrancy(&handle);
                #[cfg(target_os = "macos")]
                macos::install_backdrop(&handle, fade);
                #[cfg(target_os = "windows")]
                hq_platform::window_effects::apply_windows_window_style(
                    &handle,
                    hq_platform::window_effects::WindowAppearance::from_dark(true),
                );
                let _ = handle.set_shadow(true);
            } else {
                #[cfg(target_os = "macos")]
                macos::remove_backdrop(&handle);
            }
            let _ = fade;
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::WELCOME_CORNER_RADIUS;
    use crate::util::logfile::log;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::CGRect;

    const LOG_TAG: &str = "ui";
    const BACKDROP_IDENTIFIER: &std::ffi::CStr = c"hq.welcome-backdrop";

    // NSVisualEffectView constants (AppKit SDK).
    const MATERIAL_HUD_WINDOW: isize = 13;
    const BLENDING_BEHIND_WINDOW: isize = 0;
    const STATE_ACTIVE: isize = 1;

    unsafe fn ns_string(value: &std::ffi::CStr) -> *mut AnyObject {
        let Some(class) = AnyClass::get(c"NSString") else {
            return std::ptr::null_mut();
        };
        msg_send![class, stringWithUTF8String: value.as_ptr()]
    }

    unsafe fn content_view(window: &tauri::WebviewWindow) -> *mut AnyObject {
        let ns_win = match window.ns_window() {
            Ok(ptr) => ptr as *mut AnyObject,
            Err(e) => {
                log(LOG_TAG, &format!("welcome-backdrop: ns_window() unavailable: {e}"));
                return std::ptr::null_mut();
            }
        };
        msg_send![ns_win, contentView]
    }

    unsafe fn find_backdrop(content: *mut AnyObject) -> *mut AnyObject {
        let marker = ns_string(BACKDROP_IDENTIFIER);
        if marker.is_null() || content.is_null() {
            return std::ptr::null_mut();
        }
        let subviews: *mut AnyObject = msg_send![content, subviews];
        if subviews.is_null() {
            return std::ptr::null_mut();
        }
        let count: usize = msg_send![subviews, count];
        for index in 0..count {
            let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
            if view.is_null() {
                continue;
            }
            let ident: *mut AnyObject = msg_send![view, identifier];
            if ident.is_null() {
                continue;
            }
            let same: bool = msg_send![ident, isEqualToString: marker];
            if same {
                return view;
            }
        }
        std::ptr::null_mut()
    }

    /// Insert a dark behind-window blur at the very back of the content view,
    /// rounded to the window's corners, and fade it in. Idempotent.
    pub fn install_backdrop(window: &tauri::WebviewWindow, fade_ms: f64) {
        // SAFETY: called on the main thread (run_on_main_thread); every message
        // goes to a live AppKit object and pointers are checked before use.
        unsafe {
            let content = content_view(window);
            if content.is_null() {
                log(LOG_TAG, "welcome-backdrop: window has no contentView");
                return;
            }
            if !find_backdrop(content).is_null() {
                return;
            }
            let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
                log(LOG_TAG, "welcome-backdrop: NSVisualEffectView unavailable");
                return;
            };
            let bounds: CGRect = msg_send![content, bounds];
            let view: *mut AnyObject = msg_send![effect_class, alloc];
            let view: *mut AnyObject = msg_send![view, initWithFrame: bounds];
            if view.is_null() {
                log(LOG_TAG, "welcome-backdrop: NSVisualEffectView init returned nil");
                return;
            }
            // Track the window: NSViewWidthSizable | NSViewHeightSizable.
            let autoresize: usize = (1 << 1) | (1 << 4);
            let _: () = msg_send![view, setAutoresizingMask: autoresize];
            let _: () = msg_send![view, setMaterial: MATERIAL_HUD_WINDOW];
            let _: () = msg_send![view, setBlendingMode: BLENDING_BEHIND_WINDOW];
            let _: () = msg_send![view, setState: STATE_ACTIVE];
            // Dark regardless of the system appearance: the veil and the white
            // type on top are designed for a dark backdrop.
            if let Some(appearance_class) = AnyClass::get(c"NSAppearance") {
                let name = ns_string(c"NSAppearanceNameDarkAqua");
                if !name.is_null() {
                    let appearance: *mut AnyObject =
                        msg_send![appearance_class, appearanceNamed: name];
                    if !appearance.is_null() {
                        let _: () = msg_send![view, setAppearance: appearance];
                    }
                }
            }
            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: WELCOME_CORNER_RADIUS];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
            let ident = ns_string(BACKDROP_IDENTIFIER);
            if !ident.is_null() {
                let _: () = msg_send![view, setIdentifier: ident];
            }
            let _: () = msg_send![view, setAlphaValue: 0.0_f64];
            // NSWindowBelow, relative to nothing: behind the webview.
            let below: isize = -1;
            let null_view: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![content, addSubview: view, positioned: below, relativeTo: null_view];

            // The blur settles over the desktop rather than popping in.
            match AnyClass::get(c"NSAnimationContext") {
                Some(context_class) if fade_ms > 0.0 => {
                    let _: () = msg_send![context_class, beginGrouping];
                    let context: *mut AnyObject = msg_send![context_class, currentContext];
                    if !context.is_null() {
                        let _: () = msg_send![context, setDuration: fade_ms / 1000.0];
                    }
                    let animator: *mut AnyObject = msg_send![view, animator];
                    if animator.is_null() {
                        let _: () = msg_send![view, setAlphaValue: 1.0_f64];
                    } else {
                        let _: () = msg_send![animator, setAlphaValue: 1.0_f64];
                    }
                    let _: () = msg_send![context_class, endGrouping];
                }
                _ => {
                    let _: () = msg_send![view, setAlphaValue: 1.0_f64];
                }
            }
            // The window shadow follows the rounded content, not a rectangle.
            let ns_win: *mut AnyObject = msg_send![content, window];
            if !ns_win.is_null() {
                let _: () = msg_send![ns_win, invalidateShadow];
            }
            log(LOG_TAG, "welcome-backdrop: installed (HUDWindow, behind-window, dark)");
        }
    }

    /// Remove the welcome backdrop if it is there.
    pub fn remove_backdrop(window: &tauri::WebviewWindow) {
        // SAFETY: main thread; see `install_backdrop`.
        unsafe {
            let content = content_view(window);
            let view = find_backdrop(content);
            if view.is_null() {
                return;
            }
            let _: () = msg_send![view, removeFromSuperview];
            log(LOG_TAG, "welcome-backdrop: removed");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::BACKDROP_IDENTIFIER;

        #[test]
        fn the_backdrop_is_tagged_apart_from_the_desktop_glass() {
            // Removal finds the view by this tag; it must never match the
            // desktop window's `hq.liquid-glass` backing.
            assert_eq!(BACKDROP_IDENTIFIER.to_str().unwrap(), "hq.welcome-backdrop");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fades_default_and_clamp() {
        assert_eq!(welcome_fade_ms(None), DEFAULT_WELCOME_FADE_MS);
        assert_eq!(welcome_fade_ms(Some(f64::NAN)), DEFAULT_WELCOME_FADE_MS);
        assert_eq!(welcome_fade_ms(Some(-5.0)), 0.0);
        assert_eq!(welcome_fade_ms(Some(10_000.0)), 3000.0);
        assert_eq!(welcome_fade_ms(Some(700.0)), 700.0);
    }

    #[test]
    fn corner_radius_matches_the_renderer() {
        let css = include_str!("../../src/components/onboarding/welcome/welcome.css");
        assert!(css.contains(&format!("--w-window-radius: {}px;", WELCOME_CORNER_RADIUS as i64)));
    }
}
