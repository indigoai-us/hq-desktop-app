//! Native macOS "Liquid Glass" window backing.
//!
//! On macOS 26 (Tahoe) the desktop window's background becomes a real
//! `NSGlassEffectView` — Apple's Liquid Glass material — inserted *behind* the
//! (transparent) WKWebView so the window itself reads as live glass over the
//! desktop. On older macOS, where that class does not exist, we fall back to
//! the same `NSVisualEffectView` frosted vibrancy the menubar popover already
//! uses (`main.rs::apply_liquid_glass`), so every supported OS still gets a
//! translucent glass window rather than a see-through hole.
//!
//! Why a backing view instead of styling the webview: Liquid Glass is a native
//! `NSView` effect. It can sit behind the transparent webview (sampling the
//! desktop and windows behind ours) but it cannot refract the webview's own DOM
//! content — so in-window panels get matched translucent styling in CSS, while
//! the *window* gets the genuine material here.
//!
//! AppKit is main-thread-only; callers MUST invoke this from
//! `app.run_on_main_thread`. Mirrors the raw-objc2 idiom in
//! `commands/banner.rs` (no objc2-app-kit dependency for the messaging itself —
//! only `objc2-core-foundation` for the `CGRect` returned by `-bounds`).

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum GlassWindowRole {
    /// A large desktop window: Regular glass on Tahoe so the neutral CSS veil
    /// still retains visible depth, with UnderWindowBackground on older macOS.
    LargeWindow,
    /// A detached communications window: Regular glass on Tahoe and the
    /// brighter Popover material on earlier macOS releases.
    CompactCommunications,
}

/// Insert the large-window Liquid Glass (or vibrancy fallback) backing view.
///
/// The desktop uses Regular glass because a window-sized neutral contrast veil
/// makes Clear read as a flat gray panel. Compact communications uses the same
/// optical strength with a denser semantic fallback.
#[cfg(target_os = "macos")]
pub fn apply_liquid_glass_window(window: &tauri::WebviewWindow) {
    apply_macos_glass_window(window, GlassWindowRole::LargeWindow);
}

/// Insert the higher-presence material used by the compact Messages window.
///
/// Regular Liquid Glass preserves the frosted depth and vibrant sampling that
/// Clear loses behind a neutral CSS tint. On pre-Tahoe macOS, Popover is the
/// matching semantic material for this detached, focused surface.
#[cfg(target_os = "macos")]
pub fn apply_compact_communications_glass_window(window: &tauri::WebviewWindow) {
    apply_macos_glass_window(window, GlassWindowRole::CompactCommunications);
}

/// Insert the role-appropriate native material behind a transparent WKWebView.
///
/// Idempotent: the inserted backing view is tagged with
/// [`GLASS_VIEW_IDENTIFIER`], and a second call on the same content view returns
/// early instead of stacking another material behind the webview. Reveal paths
/// (`desktop_alt` re-opens, first-load refresh) may all call this on the same
/// window.
#[cfg(target_os = "macos")]
fn apply_macos_glass_window(window: &tauri::WebviewWindow, role: GlassWindowRole) {
    use crate::util::logfile::log;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::CGRect;

    const LOG_TAG: &str = "ui";

    let ns_win = match window.ns_window() {
        Ok(ptr) => ptr as *mut AnyObject,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("liquid-glass: ns_window() unavailable: {e}"),
            );
            return;
        }
    };

    // NSGlassEffectView only exists on macOS 26+. Resolve it at runtime so the
    // same binary still links and runs on older macOS, where we drop to the
    // vibrancy fallback below.
    let glass_class = AnyClass::get(c"NSGlassEffectView");

    // SAFETY: invoked on the main thread (run_on_main_thread); every selector
    // here is a standard AppKit message sent to a live object, and the pointers
    // are validated non-null before use.
    let content: *mut AnyObject = unsafe {
        let content: *mut AnyObject = msg_send![ns_win, contentView];
        if content.is_null() {
            log(LOG_TAG, "liquid-glass: window has no contentView");
            return;
        }
        if content_has_glass_backing(content) {
            log(
                LOG_TAG,
                "liquid-glass: backing view already present, skipping re-apply",
            );
            return;
        }
        content
    };

    unsafe {
        if let Some(class) = glass_class {
            let bounds: CGRect = msg_send![content, bounds];
            let glass: *mut AnyObject = msg_send![class, alloc];
            let glass: *mut AnyObject = msg_send![glass, initWithFrame: bounds];
            if glass.is_null() {
                log(LOG_TAG, "liquid-glass: NSGlassEffectView init returned nil");
                return;
            }
            tag_as_glass_backing(glass);
            // Fill the content view and track it as the window resizes:
            // NSViewWidthSizable (1<<1) | NSViewHeightSizable (1<<4).
            let autoresize: usize = (1 << 1) | (1 << 4);
            let _: () = msg_send![glass, setAutoresizingMask: autoresize];
            // Square corners — the macOS window frame already rounds the content.
            let _: () = msg_send![glass, setCornerRadius: 0.0_f64];
            // NSGlassEffectViewStyleRegular = 0, Clear = 1 (macOS 26 SDK).
            // Both roles use Regular: the CSS tints are already restrained and
            // achromatic, so Clear loses the material depth the user expects.
            let style: isize = match role {
                GlassWindowRole::LargeWindow => 0,
                GlassWindowRole::CompactCommunications => 0,
            };
            let _: () = msg_send![glass, setStyle: style];
            // Insert at the very back (NSWindowBelow) so the webview and all its
            // content paint over the glass.
            let below: isize = -1;
            let null_view: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                content,
                addSubview: glass,
                positioned: below,
                relativeTo: null_view
            ];
            let message = match role {
                GlassWindowRole::LargeWindow => {
                    "liquid-glass: NSGlassEffectView regular style applied to desktop (macOS 26+)"
                }
                GlassWindowRole::CompactCommunications => {
                    "liquid-glass: NSGlassEffectView regular style applied to compact communications (macOS 26+)"
                }
            };
            log(LOG_TAG, message);
            return;
        }
    }

    // Pre-Tahoe fallback: retain the calm large-window material, but give the
    // detached Messages window the brighter semantic Popover material.
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    let material = match role {
        GlassWindowRole::LargeWindow => NSVisualEffectMaterial::UnderWindowBackground,
        GlassWindowRole::CompactCommunications => NSVisualEffectMaterial::Popover,
    };
    // FollowsWindowActiveState: a background desktop window must not keep
    // re-sampling what is behind it on every frame.
    match apply_vibrancy(
        window,
        material,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
    ) {
        Ok(()) => {
            // `apply_vibrancy` inserts an untagged NSVisualEffectView; tag it so
            // the idempotency guard above also covers the fallback path.
            unsafe { tag_untagged_visual_effect_subview(content) };
            let message = match role {
                GlassWindowRole::LargeWindow => {
                    "liquid-glass: vibrancy fallback applied (UnderWindowBackground)"
                }
                GlassWindowRole::CompactCommunications => {
                    "liquid-glass: compact communications vibrancy fallback applied (Popover)"
                }
            };
            log(LOG_TAG, message);
        }
        Err(e) => log(
            LOG_TAG,
            &format!("liquid-glass: vibrancy fallback FAILED: {e}"),
        ),
    }
}

/// `NSUserInterfaceItemIdentifier` stamped on the backing view we insert, so a
/// re-apply on the same content view can find it and return early.
#[cfg(target_os = "macos")]
const GLASS_VIEW_IDENTIFIER: &std::ffi::CStr = c"hq.liquid-glass";

/// Build an autoreleased `NSString` for [`GLASS_VIEW_IDENTIFIER`].
#[cfg(target_os = "macos")]
unsafe fn glass_identifier_nsstring() -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(ns_string) = AnyClass::get(c"NSString") else {
        return std::ptr::null_mut();
    };
    let s: *mut AnyObject =
        msg_send![ns_string, stringWithUTF8String: GLASS_VIEW_IDENTIFIER.as_ptr()];
    s
}

/// Stamp `view.identifier = GLASS_VIEW_IDENTIFIER`.
///
/// SAFETY: `view` must be a live NSView; main thread only.
#[cfg(target_os = "macos")]
unsafe fn tag_as_glass_backing(view: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    let ident = glass_identifier_nsstring();
    if !ident.is_null() {
        let _: () = msg_send![view, setIdentifier: ident];
    }
}

/// Does `content` already hold a direct subview tagged as our glass backing?
///
/// SAFETY: `content` must be a live NSView; main thread only.
#[cfg(target_os = "macos")]
unsafe fn content_has_glass_backing(content: *mut objc2::runtime::AnyObject) -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let marker = glass_identifier_nsstring();
    if marker.is_null() {
        return false;
    }
    let subviews: *mut AnyObject = msg_send![content, subviews];
    if subviews.is_null() {
        return false;
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
            return true;
        }
    }
    false
}

/// After `window_vibrancy::apply_vibrancy`, find the `NSVisualEffectView` it
/// inserted (a direct, still-untagged subview) and stamp it with our identifier.
///
/// SAFETY: `content` must be a live NSView; main thread only.
#[cfg(target_os = "macos")]
unsafe fn tag_untagged_visual_effect_subview(content: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
        return;
    };
    let subviews: *mut AnyObject = msg_send![content, subviews];
    if subviews.is_null() {
        return;
    }
    let count: usize = msg_send![subviews, count];
    for index in 0..count {
        let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
        if view.is_null() {
            continue;
        }
        let is_effect: bool = msg_send![view, isKindOfClass: effect_class];
        if !is_effect {
            continue;
        }
        let ident: *mut AnyObject = msg_send![view, identifier];
        if ident.is_null() {
            tag_as_glass_backing(view);
            return;
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::GLASS_VIEW_IDENTIFIER;

    #[test]
    fn glass_identifier_is_a_stable_non_empty_marker() {
        // The identifier is what makes re-apply idempotent; it must be a real,
        // stable string (a nil/empty identifier would match every untagged view).
        let s = GLASS_VIEW_IDENTIFIER.to_str().unwrap();
        assert_eq!(s, "hq.liquid-glass");
        assert!(!s.is_empty());
    }
}

/// Ask AppKit to lay out and display the complete native content hierarchy
/// after WKWebView reports its first finished page load.
///
/// Inserting a window-sized material view while the transparent webview is
/// still loading can leave WebKit's first composited frame stale even though
/// the DOM and accessibility tree are complete. Re-invalidating the content
/// view after page load gives AppKit one deterministic paint boundary without
/// reloading the page or perturbing frontend route state.
#[cfg(target_os = "macos")]
pub fn refresh_liquid_glass_window(window: &tauri::WebviewWindow) {
    use crate::util::logfile::log;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    const LOG_TAG: &str = "ui";

    let ns_win = match window.ns_window() {
        Ok(ptr) => ptr as *mut AnyObject,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("liquid-glass: redraw ns_window() unavailable: {e}"),
            );
            return;
        }
    };

    // SAFETY: callers dispatch this helper onto AppKit's main thread. The
    // content view belongs to the live NSWindow for the supplied Tauri window.
    unsafe {
        let content: *mut AnyObject = msg_send![ns_win, contentView];
        if content.is_null() {
            log(
                LOG_TAG,
                "liquid-glass: redraw skipped because contentView is nil",
            );
            return;
        }

        let _: () = msg_send![content, setNeedsLayout: true];
        let _: () = msg_send![content, layoutSubtreeIfNeeded];
        let _: () = msg_send![content, setNeedsDisplay: true];
        let _: () = msg_send![content, displayIfNeeded];
        log(
            LOG_TAG,
            "liquid-glass: native hierarchy refreshed after page load",
        );
    }
}
