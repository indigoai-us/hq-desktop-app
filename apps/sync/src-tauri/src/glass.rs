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
/// Idempotent enough for our use — each caller invokes it once immediately
/// after building a fresh window.
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
    unsafe {
        let content: *mut AnyObject = msg_send![ns_win, contentView];
        if content.is_null() {
            log(LOG_TAG, "liquid-glass: window has no contentView");
            return;
        }

        if let Some(class) = glass_class {
            let bounds: CGRect = msg_send![content, bounds];
            let glass: *mut AnyObject = msg_send![class, alloc];
            let glass: *mut AnyObject = msg_send![glass, initWithFrame: bounds];
            if glass.is_null() {
                log(LOG_TAG, "liquid-glass: NSGlassEffectView init returned nil");
                return;
            }
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
    match apply_vibrancy(window, material, Some(NSVisualEffectState::Active), None) {
        Ok(()) => {
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
