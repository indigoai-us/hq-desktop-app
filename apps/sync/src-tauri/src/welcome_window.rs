//! The welcome flow's window (first-run onboarding, the consent re-prompt and
//! the menu-bar "Replay welcome intro").
//!
//! While the welcome flow owns the `main` window, the window fills the work
//! area of the monitor it is on: below the menu bar, beside the Dock, placed at
//! the work area's origin. It has no rounded corners and no window shadow, so
//! it reads as a full-screen page rather than a card. `set_welcome_window`
//! puts it there and takes it back; the renderer (`Onboarding.svelte`) then
//! shrinks it to the compact size and re-applies the popover material.
//!
//! The backdrop is the person's desktop wallpaper, blurred and dimmed.
//! On macOS `get_desktop_wallpaper` reads the wallpaper of the window's screen
//! through `NSWorkspace`, scales it down to at most
//! [`WALLPAPER_MAX_EDGE_PX`] on the long edge and returns it as a JPEG data
//! URL. The renderer paints it full-bleed behind the flow and its veil blurs
//! and dims it over 1.8 seconds, as in the designer's prototype. Other app
//! windows never show through.
//!
//! When the wallpaper cannot be read (non-macOS, an unreadable or dynamic
//! wallpaper file, any AppKit failure), the renderer falls back to
//! `set_welcome_backdrop`: an `NSVisualEffectView` in behind-window blending
//! mode, faded in over `fade_ms`, with the renderer's veil on top. On Windows
//! that fallback is the dark Acrylic/Mica backdrop the app already uses.
//! Elsewhere it is a no-op and the veil alone darkens the transparent window.
//!
//! AppKit is main-thread-only; every native call dispatches through
//! `run_on_main_thread`. Raw objc2 messaging, in the idiom of `glass.rs`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// The fade the renderer asks for when it does not say.
pub const DEFAULT_WELCOME_FADE_MS: f64 = 1800.0;

/// Longest edge, in pixels, of the wallpaper image handed to the renderer.
/// It is blurred by 34px, so anything larger only costs memory and IPC time.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const WALLPAPER_MAX_EDGE_PX: f64 = 1600.0;

/// JPEG quality for the wallpaper image (NSImageCompressionFactor).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const WALLPAPER_JPEG_QUALITY: f64 = 0.8;

/// True while the welcome flow owns `main` and it should fill the work area.
/// Window paths that would otherwise re-anchor `main` under the tray icon
/// (`tray::show_onboarding_window`) check this instead.
static WELCOME_WINDOW_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether the welcome flow currently owns the `main` window.
pub fn welcome_window_active() -> bool {
    WELCOME_WINDOW_ACTIVE.load(Ordering::SeqCst)
}

/// Mark the welcome flow as owning `main` (or not).
pub fn set_welcome_window_active(active: bool) {
    WELCOME_WINDOW_ACTIVE.store(active, Ordering::SeqCst);
}

/// Clamp the renderer's requested fade to something sane.
pub fn welcome_fade_ms(requested: Option<f64>) -> f64 {
    match requested {
        Some(ms) if ms.is_finite() => ms.clamp(0.0, 3000.0),
        _ => DEFAULT_WELCOME_FADE_MS,
    }
}

/// A window frame in logical units (points on macOS).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The welcome window's frame for a monitor whose work area is given in
/// physical pixels, converted with that monitor's scale factor.
///
/// `None` when the work area is empty or the numbers are not usable.
pub fn welcome_frame_from_work_area(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Option<LogicalFrame> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    if ![x, y, width, height].iter().all(|v| v.is_finite()) || width < 1.0 || height < 1.0 {
        return None;
    }
    Some(LogicalFrame {
        x: x / scale,
        y: y / scale,
        width: width / scale,
        height: height / scale,
    })
}

/// Pixel size to scale an image of `width` x `height` down to so its long edge
/// is at most `max_edge`. Never scales up. `None` for unusable sizes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn wallpaper_target_size(width: f64, height: f64, max_edge: f64) -> Option<(usize, usize)> {
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
        return None;
    }
    if !max_edge.is_finite() || max_edge < 1.0 {
        return None;
    }
    let scale = (max_edge / width.max(height)).min(1.0);
    let w = (width * scale).round().max(1.0) as usize;
    let h = (height * scale).round().max(1.0) as usize;
    Some((w, h))
}

/// `data:image/jpeg;base64,...` for JPEG bytes, or `None` for no bytes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn jpeg_data_url(bytes: &[u8]) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if bytes.is_empty() {
        return None;
    }
    Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

/// Fit `window` to the work area of the monitor it is on (falling back to the
/// primary monitor). Returns whether a frame was applied. Must be called on
/// the main thread.
pub fn fit_to_work_area(window: &tauri::WebviewWindow) -> bool {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return false;
    };
    let area = monitor.work_area();
    let Some(frame) = welcome_frame_from_work_area(
        area.position.x as f64,
        area.position.y as f64,
        area.size.width as f64,
        area.size.height as f64,
        monitor.scale_factor(),
    ) else {
        return false;
    };
    let _ = window.set_size(tauri::LogicalSize::new(frame.width, frame.height));
    let _ = window.set_position(tauri::LogicalPosition::new(frame.x, frame.y));
    true
}

/// Give `main` to the welcome flow (`enabled`): fill the work area, no window
/// shadow. Or hand it back: shadow on, and the renderer re-applies the compact
/// size and the popover material.
#[tauri::command]
pub fn set_welcome_window(app: AppHandle, enabled: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not available".into());
    };
    set_welcome_window_active(enabled);
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            if enabled {
                let _ = handle.set_shadow(false);
                fit_to_work_area(&handle);
            } else {
                let _ = handle.set_shadow(true);
            }
        })
        .map_err(|e| e.to_string())
}

/// The person's desktop wallpaper as a JPEG data URL, scaled down, or `None`
/// if it cannot be read. macOS only; `None` elsewhere.
#[tauri::command]
pub async fn get_desktop_wallpaper(app: AppHandle) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let window = app.get_webview_window("main")?;
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
        let handle = window.clone();
        window
            .run_on_main_thread(move || {
                let bytes = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    macos::wallpaper_jpeg(&handle)
                }))
                .ok()
                .flatten();
                let _ = tx.send(bytes);
            })
            .ok()?;
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .ok()?
            .ok()??;
        jpeg_data_url(&bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// Put the native blur behind the welcome flow (`enabled`), or take it away.
/// Only used when the wallpaper could not be read.
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
                // Full-screen page, not a card: no window shadow.
                let _ = handle.set_shadow(false);
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
    use super::{wallpaper_target_size, WALLPAPER_JPEG_QUALITY, WALLPAPER_MAX_EDGE_PX};
    use crate::util::logfile::log;
    use objc2::msg_send;
    use objc2::rc::{autoreleasepool, Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    const LOG_TAG: &str = "ui";
    const BACKDROP_IDENTIFIER: &std::ffi::CStr = c"hq.welcome-backdrop";

    // NSVisualEffectView constants (AppKit SDK).
    const MATERIAL_HUD_WINDOW: isize = 13;
    const BLENDING_BEHIND_WINDOW: isize = 0;
    const STATE_ACTIVE: isize = 1;

    // NSBitmapImageFileTypeJPEG and NSCompositingOperationCopy.
    const BITMAP_FILE_TYPE_JPEG: usize = 3;
    const COMPOSITING_OPERATION_COPY: usize = 1;

    unsafe fn ns_string(value: &std::ffi::CStr) -> *mut AnyObject {
        let Some(class) = AnyClass::get(c"NSString") else {
            return std::ptr::null_mut();
        };
        msg_send![class, stringWithUTF8String: value.as_ptr()]
    }

    unsafe fn ns_window(window: &tauri::WebviewWindow) -> *mut AnyObject {
        match window.ns_window() {
            Ok(ptr) => ptr as *mut AnyObject,
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("welcome-window: ns_window() unavailable: {e}"),
                );
                std::ptr::null_mut()
            }
        }
    }

    unsafe fn content_view(window: &tauri::WebviewWindow) -> *mut AnyObject {
        let ns_win = ns_window(window);
        if ns_win.is_null() {
            return std::ptr::null_mut();
        }
        msg_send![ns_win, contentView]
    }

    /// The window's screen, or the main screen.
    unsafe fn window_screen(window: &tauri::WebviewWindow) -> Option<Retained<AnyObject>> {
        let ns_win = ns_window(window);
        if !ns_win.is_null() {
            let screen: Option<Retained<AnyObject>> = msg_send![ns_win, screen];
            if screen.is_some() {
                return screen;
            }
        }
        let class = AnyClass::get(c"NSScreen")?;
        msg_send![class, mainScreen]
    }

    /// Read the wallpaper of the window's screen, scale it down, and encode it
    /// as JPEG. Main thread only. `None` on any failure.
    pub fn wallpaper_jpeg(window: &tauri::WebviewWindow) -> Option<Vec<u8>> {
        // SAFETY: called on the main thread (run_on_main_thread). Every object
        // is checked for nil before use; ownership is tracked by `Retained`,
        // and autoreleased temporaries drain with the pool.
        let result = autoreleasepool(|_| unsafe {
            let screen = window_screen(window)?;
            encode_wallpaper(&screen)
        });
        if result.is_none() {
            log(
                LOG_TAG,
                "welcome-wallpaper: unavailable, using the native blur",
            );
        }
        result
    }

    unsafe fn encode_wallpaper(screen: &AnyObject) -> Option<Vec<u8>> {
        let workspace_class = AnyClass::get(c"NSWorkspace")?;
        let workspace: Option<Retained<AnyObject>> = msg_send![workspace_class, sharedWorkspace];
        let workspace = workspace?;
        let url: Option<Retained<AnyObject>> =
            msg_send![&*workspace, desktopImageURLForScreen: screen];
        let url = url?;

        // NSImage reads HEIC, JPEG, PNG and the rest through ImageIO.
        let image_class = AnyClass::get(c"NSImage")?;
        let image: Allocated<AnyObject> = msg_send![image_class, alloc];
        let image: Option<Retained<AnyObject>> = msg_send![image, initWithContentsOfURL: &*url];
        let image = image?;
        let valid: bool = msg_send![&*image, isValid];
        if !valid {
            return None;
        }
        let size: CGSize = msg_send![&*image, size];
        let (width, height) =
            wallpaper_target_size(size.width, size.height, WALLPAPER_MAX_EDGE_PX)?;

        let rep_class = AnyClass::get(c"NSBitmapImageRep")?;
        let color_space = ns_string(c"NSCalibratedRGBColorSpace");
        if color_space.is_null() {
            return None;
        }
        let planes: *mut *mut u8 = std::ptr::null_mut();
        let rep: Allocated<AnyObject> = msg_send![rep_class, alloc];
        let rep: Option<Retained<AnyObject>> = msg_send![
            rep,
            initWithBitmapDataPlanes: planes,
            pixelsWide: width as isize,
            pixelsHigh: height as isize,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: color_space,
            bytesPerRow: 0isize,
            bitsPerPixel: 0isize
        ];
        let rep = rep?;

        // Draw the wallpaper into the bitmap at the target size.
        let context_class = AnyClass::get(c"NSGraphicsContext")?;
        let context: Option<Retained<AnyObject>> =
            msg_send![context_class, graphicsContextWithBitmapImageRep: &*rep];
        let context = context?;
        let target = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width as f64, height as f64),
        );
        let whole_image = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(0.0, 0.0));
        let _: () = msg_send![context_class, saveGraphicsState];
        let _: () = msg_send![context_class, setCurrentContext: &*context];
        let _: () = msg_send![
            &*image,
            drawInRect: target,
            fromRect: whole_image,
            operation: COMPOSITING_OPERATION_COPY,
            fraction: 1.0_f64
        ];
        let _: () = msg_send![&*context, flushGraphics];
        let _: () = msg_send![context_class, restoreGraphicsState];

        // JPEG at WALLPAPER_JPEG_QUALITY.
        let number_class = AnyClass::get(c"NSNumber")?;
        let quality: Option<Retained<AnyObject>> =
            msg_send![number_class, numberWithDouble: WALLPAPER_JPEG_QUALITY];
        let quality = quality?;
        let key = ns_string(c"NSImageCompressionFactor");
        if key.is_null() {
            return None;
        }
        let dict_class = AnyClass::get(c"NSDictionary")?;
        let properties: Option<Retained<AnyObject>> =
            msg_send![dict_class, dictionaryWithObject: &*quality, forKey: key];
        let properties = properties?;
        let data: Option<Retained<AnyObject>> = msg_send![
            &*rep,
            representationUsingType: BITMAP_FILE_TYPE_JPEG,
            properties: &*properties
        ];
        let data = data?;
        let length: usize = msg_send![&*data, length];
        let bytes: *const u8 = msg_send![&*data, bytes];
        if length == 0 || bytes.is_null() {
            return None;
        }
        let out = std::slice::from_raw_parts(bytes, length).to_vec();
        log(
            LOG_TAG,
            &format!(
                "welcome-wallpaper: {width}x{height} jpeg, {} bytes",
                out.len()
            ),
        );
        Some(out)
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

    /// Insert a dark behind-window blur at the very back of the content view
    /// and fade it in. Idempotent.
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
                log(
                    LOG_TAG,
                    "welcome-backdrop: NSVisualEffectView init returned nil",
                );
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
            let ident = ns_string(BACKDROP_IDENTIFIER);
            if !ident.is_null() {
                let _: () = msg_send![view, setIdentifier: ident];
            }
            let _: () = msg_send![view, setAlphaValue: 0.0_f64];
            // NSWindowBelow, relative to nothing: behind the webview.
            let below: isize = -1;
            let null_view: *mut AnyObject = std::ptr::null_mut();
            let _: () =
                msg_send![content, addSubview: view, positioned: below, relativeTo: null_view];

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
            log(
                LOG_TAG,
                "welcome-backdrop: installed (HUDWindow, behind-window, dark)",
            );
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
        use super::*;

        #[test]
        fn reading_the_wallpaper_yields_a_bounded_jpeg_or_nothing() {
            // Exercises every AppKit message and its type encoding. On a
            // machine with no screen (headless CI) there is nothing to read,
            // and the answer must be None rather than a panic.
            unsafe fn main_screen_wallpaper() -> Option<Vec<u8>> {
                let class = AnyClass::get(c"NSScreen")?;
                let screen: Option<Retained<AnyObject>> = msg_send![class, mainScreen];
                let screen = screen?;
                encode_wallpaper(&screen)
            }
            let bytes = autoreleasepool(|_| unsafe { main_screen_wallpaper() });
            if let Some(bytes) = bytes {
                assert_eq!(&bytes[..2], &[0xff, 0xd8], "not a JPEG");
                assert!(bytes.len() < 4 * 1024 * 1024, "{} bytes", bytes.len());
            }
        }

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
    fn the_window_fills_the_work_area_in_logical_units() {
        // A Retina MacBook: 3024x1964 physical, menu bar 37pt, Dock at the bottom.
        let frame = welcome_frame_from_work_area(0.0, 74.0, 3024.0, 1740.0, 2.0).unwrap();
        assert_eq!(
            frame,
            LogicalFrame {
                x: 0.0,
                y: 37.0,
                width: 1512.0,
                height: 870.0
            }
        );
        // The test VM: 1x, 1024x768 with a 25pt menu bar.
        let frame = welcome_frame_from_work_area(0.0, 25.0, 1024.0, 743.0, 1.0).unwrap();
        assert_eq!(
            frame,
            LogicalFrame {
                x: 0.0,
                y: 25.0,
                width: 1024.0,
                height: 743.0
            }
        );
        // A secondary display to the left, Dock on its left edge.
        let frame = welcome_frame_from_work_area(-1360.0, 50.0, 1280.0, 1340.0, 2.0).unwrap();
        assert_eq!(
            frame,
            LogicalFrame {
                x: -680.0,
                y: 25.0,
                width: 640.0,
                height: 670.0
            }
        );
    }

    #[test]
    fn an_unusable_work_area_is_not_applied() {
        assert!(welcome_frame_from_work_area(0.0, 0.0, 0.0, 800.0, 2.0).is_none());
        assert!(welcome_frame_from_work_area(0.0, 0.0, 800.0, f64::NAN, 2.0).is_none());
        // A broken scale factor is treated as 1x rather than dividing by zero.
        assert_eq!(
            welcome_frame_from_work_area(0.0, 0.0, 800.0, 600.0, 0.0),
            Some(LogicalFrame {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0
            })
        );
    }

    #[test]
    fn the_wallpaper_scales_down_to_the_long_edge_and_never_up() {
        assert_eq!(
            wallpaper_target_size(6016.0, 3384.0, 1600.0),
            Some((1600, 900))
        );
        assert_eq!(
            wallpaper_target_size(3384.0, 6016.0, 1600.0),
            Some((900, 1600))
        );
        assert_eq!(
            wallpaper_target_size(1280.0, 800.0, 1600.0),
            Some((1280, 800))
        );
        assert_eq!(
            wallpaper_target_size(1600.0, 1600.0, 1600.0),
            Some((1600, 1600))
        );
        // Extreme aspect ratios keep at least one pixel.
        assert_eq!(
            wallpaper_target_size(100_000.0, 10.0, 1600.0),
            Some((1600, 1))
        );
    }

    #[test]
    fn an_unusable_wallpaper_size_is_rejected() {
        assert_eq!(wallpaper_target_size(0.0, 900.0, 1600.0), None);
        assert_eq!(wallpaper_target_size(f64::INFINITY, 900.0, 1600.0), None);
        assert_eq!(wallpaper_target_size(1600.0, 900.0, 0.0), None);
        assert_eq!(wallpaper_target_size(1600.0, f64::NAN, 1600.0), None);
    }

    #[test]
    fn the_wallpaper_is_a_jpeg_data_url() {
        assert_eq!(jpeg_data_url(&[]), None);
        assert_eq!(
            jpeg_data_url(&[0xff, 0xd8, 0xff]).as_deref(),
            Some("data:image/jpeg;base64,/9j/")
        );
    }

    #[test]
    fn the_welcome_window_flag_round_trips() {
        set_welcome_window_active(true);
        assert!(welcome_window_active());
        set_welcome_window_active(false);
        assert!(!welcome_window_active());
    }

    #[test]
    fn the_renderer_window_is_square() {
        // Full-screen page: neither the CSS nor the native backdrop rounds it.
        let css = include_str!("../../src/components/onboarding/welcome/welcome.css");
        assert!(!css.contains("--w-window-radius"));
    }
}
