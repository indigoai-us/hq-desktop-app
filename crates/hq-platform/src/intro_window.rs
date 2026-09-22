//! The welcome film's window geometry and fade, shared by every app that plays
//! the film: the shipped menubar app (`apps/sync`) and the standalone preview
//! (`apps/intro`). One code path, so the preview a designer reviews is the
//! window the user gets.
//!
//! The film covers the ENTIRE display it plays on — past the menu bar and the
//! Dock — and the person's real desktop blurs underneath it. Two rules carry
//! that: the frame is the display's FULL bounds (never the work area), and the
//! window sits above the menu-bar level for the duration.
//!
//! Why borderless-at-status-level rather than macOS native full screen
//! (`toggleFullScreen:`): native full screen moves the window to a new Space
//! and plays the system's space-switch animation, which the app cannot
//! cross-fade with. The film has to arrive as ONE fade from the live desktop
//! into the blurred film, and leave the same way, so it stays in the current
//! Space and simply takes the whole screen.
//!
//! AppKit is main-thread-only: every `ns_window` call below must be dispatched
//! from the main thread by the caller.

/// A display or window rectangle in one consistent unit (callers use physical
/// pixels; the maths does not care as long as it is not mixed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntroRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl IntroRect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// Window level for the film. `kCGMainMenuWindowLevel` is 24, so 25
/// (`NSStatusWindowLevel`) is the first level that paints OVER the menu bar.
/// Anything at or below 24 leaves the menu bar drawn on top of the film, which
/// is the most visible way a "full screen" intro fails to look full screen.
pub const INTRO_WINDOW_LEVEL: i64 = 25;

/// macOS main-menu window level. The film must sit strictly above it.
pub const MAIN_MENU_WINDOW_LEVEL: i64 = 24;

/// Ordinary window level, restored when the film ends.
pub const NORMAL_WINDOW_LEVEL: i64 = 0;

/// The frame the film should occupy on a display whose FULL bounds are
/// `screen_frame`.
///
/// Deliberately the identity of the screen frame: no insets, no work-area
/// intersection, no margin for the menu bar. It exists so "full screen, not
/// work area" is a function with a test on it rather than a line of window code
/// nobody can assert against.
pub fn intro_frame_from_screen(screen_frame: IntroRect) -> IntroRect {
    screen_frame
}

/// Index of the display the film should play on: the one holding the most of
/// the app window, falling back to the first (primary) display when the window
/// overlaps none of them — first run, where the window has not been placed yet.
pub fn pick_intro_screen(window: IntroRect, screens: &[IntroRect]) -> Option<usize> {
    if screens.is_empty() {
        return None;
    }
    let mut best = 0usize;
    let mut best_overlap = 0.0f64;
    for (index, screen) in screens.iter().enumerate() {
        let overlap = overlap_area(window, *screen);
        if overlap > best_overlap {
            best_overlap = overlap;
            best = index;
        }
    }
    Some(best)
}

fn overlap_area(a: IntroRect, b: IntroRect) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width <= 0.0 || height <= 0.0 {
        0.0
    } else {
        width * height
    }
}

/// Set an `NSWindow`'s level. `ns_window` is the pointer Tauri returns from
/// `WebviewWindow::ns_window`. Main thread only.
#[cfg(target_os = "macos")]
pub fn set_window_level(ns_window: *mut std::ffi::c_void, level: i64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    if ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    unsafe {
        let _: () = msg_send![window, setLevel: level as isize];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_window_level(_ns_window: *mut std::ffi::c_void, _level: i64) {}

/// Set an `NSWindow`'s alpha immediately, with no animation. Main thread only.
#[cfg(target_os = "macos")]
pub fn set_window_alpha(ns_window: *mut std::ffi::c_void, alpha: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    if ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    unsafe {
        let _: () = msg_send![window, setAlphaValue: alpha];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_window_alpha(_ns_window: *mut std::ffi::c_void, _alpha: f64) {}

/// `+[CAMediaTimingFunction functionWithControlPoints::::]` with the classic
/// ease-out curve: the fade moves fastest at the start and settles into the
/// blur, rather than the symmetric ease AppKit uses by default.
///
/// The selector has four UNNAMED parts, which `msg_send!` cannot express, so
/// the call goes through `objc_msgSend` directly.
#[cfg(target_os = "macos")]
fn ease_out_timing_function() -> Option<*mut objc2::runtime::AnyObject> {
    use objc2::runtime::{AnyClass, AnyObject, Sel};

    let class = AnyClass::get(c"CAMediaTimingFunction")?;
    let sel = Sel::register(c"functionWithControlPoints::::");
    type Send4 = unsafe extern "C" fn(*mut AnyObject, Sel, f32, f32, f32, f32) -> *mut AnyObject;
    unsafe {
        let send: Send4 = std::mem::transmute(objc2::ffi::objc_msgSend as *const ());
        let timing = send(
            class as *const AnyClass as *mut AnyObject,
            sel,
            0.0,
            0.0,
            0.58,
            1.0,
        );
        if timing.is_null() {
            None
        } else {
            Some(timing)
        }
    }
}

/// Animate an `NSWindow`'s alpha to `alpha` over `duration_ms`, ease-out.
///
/// This is the fade: at alpha 0 the window is not there at all and the person
/// sees their own desktop; as alpha rises, the native material AND the film
/// come up together, so the desktop visibly blurs and darkens under the film in
/// one move. Main thread only.
#[cfg(target_os = "macos")]
pub fn animate_window_alpha(ns_window: *mut std::ffi::c_void, alpha: f64, duration_ms: f64) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    if ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    let Some(context_class) = AnyClass::get(c"NSAnimationContext") else {
        set_window_alpha(ns_window, alpha);
        return;
    };

    unsafe {
        let _: () = msg_send![context_class, beginGrouping];
        let current: *mut AnyObject = msg_send![context_class, currentContext];
        if !current.is_null() {
            let _: () = msg_send![current, setDuration: duration_ms / 1000.0];
            if let Some(timing) = ease_out_timing_function() {
                let _: () = msg_send![current, setTimingFunction: timing];
            }
        }
        let animator: *mut AnyObject = msg_send![window, animator];
        if animator.is_null() {
            let _: () = msg_send![window, setAlphaValue: alpha];
        } else {
            let _: () = msg_send![animator, setAlphaValue: alpha];
        }
        let _: () = msg_send![context_class, endGrouping];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn animate_window_alpha(_ns_window: *mut std::ffi::c_void, _alpha: f64, _duration_ms: f64) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn laptop_frame() -> IntroRect {
        IntroRect::new(0.0, 0.0, 1512.0, 982.0)
    }

    fn laptop_work_area() -> IntroRect {
        IntroRect::new(0.0, 37.0, 1512.0, 945.0)
    }

    #[test]
    fn the_film_takes_the_whole_screen_frame_not_the_work_area() {
        let frame = intro_frame_from_screen(laptop_frame());
        assert_eq!(frame, laptop_frame());
        // The menu-bar band and the Dock strip are exactly what the work area
        // gives up, and exactly what the film must cover.
        assert_ne!(frame, laptop_work_area());
        assert!(frame.y < laptop_work_area().y);
        assert!(frame.height > laptop_work_area().height);
    }

    #[test]
    fn the_film_sits_above_the_menu_bar_and_returns_to_normal() {
        assert!(INTRO_WINDOW_LEVEL > MAIN_MENU_WINDOW_LEVEL);
        assert_eq!(NORMAL_WINDOW_LEVEL, 0);
        assert!(INTRO_WINDOW_LEVEL > NORMAL_WINDOW_LEVEL);
    }

    #[test]
    fn it_plays_on_the_display_holding_the_app_window() {
        let screens = [
            IntroRect::new(0.0, 0.0, 1512.0, 982.0),
            IntroRect::new(1512.0, 0.0, 2560.0, 1440.0),
        ];
        assert_eq!(
            pick_intro_screen(IntroRect::new(2000.0, 300.0, 780.0, 620.0), &screens),
            Some(1)
        );
        assert_eq!(
            pick_intro_screen(IntroRect::new(100.0, 100.0, 780.0, 620.0), &screens),
            Some(0)
        );
    }

    #[test]
    fn a_window_straddling_two_displays_plays_on_the_one_holding_more_of_it() {
        let screens = [
            IntroRect::new(0.0, 0.0, 1512.0, 982.0),
            IntroRect::new(1512.0, 0.0, 2560.0, 1440.0),
        ];
        // 600 of 780 points sit on the secondary display.
        assert_eq!(
            pick_intro_screen(IntroRect::new(1332.0, 200.0, 780.0, 620.0), &screens),
            Some(1)
        );
    }

    #[test]
    fn an_unplaced_first_run_window_falls_back_to_the_primary_display() {
        let screens = [
            IntroRect::new(0.0, 0.0, 1512.0, 982.0),
            IntroRect::new(1512.0, 0.0, 2560.0, 1440.0),
        ];
        // Zero-size window (first run, never positioned) overlaps nothing.
        assert_eq!(
            pick_intro_screen(IntroRect::new(0.0, 0.0, 0.0, 0.0), &screens),
            Some(0)
        );
        assert_eq!(
            pick_intro_screen(IntroRect::new(0.0, 0.0, 0.0, 0.0), &[]),
            None
        );
    }
}
