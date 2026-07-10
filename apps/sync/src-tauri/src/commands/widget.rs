//! Floating desktop widget for HQ Sync — the HQ wordmark, always-on-top.
//!
//! ## Why this exists
//!
//! The menubar tray is the primary surface, but a small always-visible mark on
//! the desktop (lower-right of a chosen display) gives presence when the tray
//! is hidden by Focus / overcrowding and is the future home for a queued-
//! message count (US-003). This module owns the always-on-top, borderless,
//! transparent, **non-activating** webview window that renders that mark.
//!
//! ## Design locks (US-002)
//!
//!   * Wordmark **only** — no circle, no badge chip, no rounded container.
//!   * Idle translucency, full opacity on hover (CSS in `Widget.svelte`).
//!   * Color follows macOS system appearance via `prefers-color-scheme` —
//!     **no** ScreenCaptureKit / CGWindowList sampling (would prompt for
//!     screen-recording permission).
//!   * Non-activating: `.focusable(false)` + `ActivationPolicy::Accessory` so
//!     hover/clicks never steal focus from the user's current app.
//!
//! ## Prefs (untyped — US-004 owns settings)
//!
//! Read `widgetEnabled` / `widgetDisplay` straight from `~/.hq/menubar.json`
//! as untyped JSON so this story does not touch `MenubarPrefs`. Defaults:
//! enabled ON, display = primary.
//!
//! ## Anchoring
//!
//! Lower-right of the configured display's **visibleFrame** (Dock + menu bar
//! excluded) so a bottom Dock cannot occlude the mark. Re-anchors on
//! `NSApplicationDidChangeScreenParametersNotification`.

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use crate::util::logfile::log;

const LOG_TAG: &str = "widget";

/// Window label — kept in sync with the `main.ts` router branch and
/// `capabilities/widget.json`.
pub const WINDOW_LABEL: &str = "widget";

/// Widget geometry (logical px). Sized to hug the 56px wordmark so the
/// transparent always-on-top window does not swallow desktop clicks outside
/// the mark. 10px headroom top+right for the queued-count superscript (US-003)
/// matches `Widget.svelte` `.wg` padding (padding 10 + mark 56 = 66 wide;
/// padding 10 + ~32.2 mark height ≈ 42.2 ≤ 43 tall).
const WIDGET_W: f64 = 66.0;
const WIDGET_H: f64 = 43.0;
/// Margins from the display's visible edge. `MARGIN_RIGHT` is 8 so the mark's
/// visual right margin stays 18px (8 window margin + 10px right padding in
/// `.wg`). `MARGIN_BOTTOM` is 16 — the mark sits flush to the window bottom.
const MARGIN_RIGHT: f64 = 8.0;
const MARGIN_BOTTOM: f64 = 16.0;

// ── Untyped menubar.json prefs ──────────────────────────────────────────────────

/// Read `~/.hq/menubar.json` as untyped JSON. `None` when missing/unreadable.
fn read_menubar_json() -> Option<serde_json::Value> {
    let path = crate::util::paths::menubar_json_path().ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// `widgetEnabled` in menubar.json — defaults **true** when missing/unreadable.
fn widget_enabled() -> bool {
    read_menubar_json()
        .and_then(|j| j.get("widgetEnabled").and_then(|v| v.as_bool()))
        .unwrap_or(true)
}

/// Optional `widgetDisplay` (display localized name). `None` = primary.
fn configured_display_name() -> Option<String> {
    read_menubar_json()
        .and_then(|j| {
            j.get("widgetDisplay")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

// ── Anchoring ───────────────────────────────────────────────────────────────────

/// Compute the lower-right anchor for the widget window.
///
/// On macOS, uses `NSScreen.visibleFrame` (Dock/menu-bar aware) on the main
/// thread. Falls back to Tauri monitor APIs when Cocoa fails or off-macOS.
fn widget_position(app: &AppHandle) -> tauri::LogicalPosition<f64> {
    #[cfg(target_os = "macos")]
    if let Some(pos) = widget_position_cocoa() {
        return pos;
    }
    widget_position_fallback(app)
}

/// macOS: lower-right of the configured screen's `visibleFrame`, converted
/// from Cocoa bottom-left coords to tao/tauri top-left logical coords.
#[cfg(target_os = "macos")]
fn widget_position_cocoa() -> Option<tauri::LogicalPosition<f64>> {
    use objc2::{class, msg_send, runtime::AnyObject};
    use objc2_core_foundation::CGRect;

    // SAFETY: caller must be on the main thread (Tauri `.setup()` and
    // `run_on_main_thread` / main-queue notification blocks). All selectors
    // are public AppKit; pointers are null-checked before use.
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            log(LOG_TAG, "anchor: NSScreen.screens is nil");
            return None;
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            log(LOG_TAG, "anchor: NSScreen.screens is empty");
            return None;
        }

        // screens[0] is the primary (menu-bar) screen; its frame origin is (0,0).
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        if primary.is_null() {
            log(LOG_TAG, "anchor: primary NSScreen is nil");
            return None;
        }

        let mut target = primary;
        if let Some(want) = configured_display_name() {
            for i in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
                if screen.is_null() {
                    continue;
                }
                let name_obj: *mut AnyObject = msg_send![screen, localizedName];
                if name_obj.is_null() {
                    continue;
                }
                let utf8: *const std::ffi::c_char = msg_send![name_obj, UTF8String];
                if utf8.is_null() {
                    continue;
                }
                if let Ok(s) = std::ffi::CStr::from_ptr(utf8).to_str() {
                    if s == want {
                        target = screen;
                        break;
                    }
                }
            }
        }

        let vf: CGRect = msg_send![target, visibleFrame];
        let primary_frame: CGRect = msg_send![primary, frame];

        // Cocoa: bottom-left origin, y-up. Lower-right of visibleFrame:
        let x_cocoa = vf.origin.x + vf.size.width - WIDGET_W - MARGIN_RIGHT;
        let y_cocoa = vf.origin.y + MARGIN_BOTTOM;
        // tao/tauri: top-left origin, y-down, relative to primary frame.
        let x = x_cocoa;
        let y = primary_frame.size.height - (y_cocoa + WIDGET_H);

        Some(tauri::LogicalPosition::new(x, y))
    }
}

/// Fallback (non-macOS or Cocoa failure): Tauri monitor APIs + extra bottom
/// clearance for a possible dock/taskbar.
fn widget_position_fallback(app: &AppHandle) -> tauri::LogicalPosition<f64> {
    let want = configured_display_name();
    let monitors = app.available_monitors().ok().unwrap_or_default();
    let monitor = want
        .as_ref()
        .and_then(|name| {
            monitors
                .iter()
                .find(|m| m.name().as_deref() == Some(name))
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.into_iter().next());

    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let mon_w = m.size().width as f64 / scale;
        let mon_h = m.size().height as f64 / scale;
        // Monitor origin in virtual-desktop logical coords (secondary displays
        // are often offset from (0,0)).
        let pos = m.position();
        let origin_x = pos.x as f64 / scale;
        let origin_y = pos.y as f64 / scale;
        // Extra 80px bottom clearance when we cannot read visibleFrame.
        // Clamp relative to the monitor origin, not the virtual desktop (0,0).
        let x = (origin_x + mon_w - WIDGET_W - MARGIN_RIGHT).max(origin_x);
        let y = (origin_y + mon_h - WIDGET_H - 80.0).max(origin_y);
        return tauri::LogicalPosition::new(x, y);
    }

    // Last-resort hard-coded primary-ish geometry.
    tauri::LogicalPosition::new(1440.0 - WIDGET_W - MARGIN_RIGHT, 900.0 - WIDGET_H - 80.0)
}

/// Recompute the anchor and `set_position` if the widget window exists.
pub fn anchor_widget(app: &AppHandle) {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            let pos = widget_position(&app);
            match window.set_position(pos) {
                Ok(()) => log(
                    LOG_TAG,
                    &format!("re-anchored to ({:.0}, {:.0})", pos.x, pos.y),
                ),
                Err(e) => log(LOG_TAG, &format!("anchor set_position failed: {e}")),
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let pos = widget_position(app);
        if let Err(e) = window.set_position(pos) {
            log(LOG_TAG, &format!("anchor set_position failed: {e}"));
        }
    }
}

// ── Setup ───────────────────────────────────────────────────────────────────────

/// Create the always-on-top widget window once at app launch. Called from
/// `main.rs` `.setup()`. No-op when `widgetEnabled` is false.
pub fn setup_widget_window(app: &AppHandle) {
    if !widget_enabled() {
        log(LOG_TAG, "setup: widgetEnabled=false — skipping");
        return;
    }

    if app.get_webview_window(WINDOW_LABEL).is_some() {
        log(LOG_TAG, "setup: window already exists — re-anchoring");
        anchor_widget(app);
        return;
    }

    let pos = widget_position(app);
    log(
        LOG_TAG,
        &format!(
            "setup: building window at ({:.0}, {:.0}) size {}×{}",
            pos.x, pos.y, WIDGET_W, WIDGET_H
        ),
    );

    let build = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("HQ Widget")
    .inner_size(WIDGET_W, WIDGET_H)
    .position(pos.x, pos.y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    // Non-activating: clicks/hover never steal focus. Paired with
    // ActivationPolicy::Accessory set in main.rs.
    .focusable(false)
    .accept_first_mouse(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .build();

    let window = match build {
        Ok(w) => w,
        Err(e) => {
            log(LOG_TAG, &format!("setup: WebviewWindowBuilder FAILED: {e}"));
            return;
        }
    };

    // (1) Clear the WKWebView's `underPageBackgroundColor`. macOS 12+ WebKit
    // paints it (a system gray) behind a transparent page, filling the square
    // window rect. `transparent: true` does not clear it. Same idiom as
    // `commands/banner.rs`.
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: runs on the main thread (with_webview guarantees it);
            // `inner()` is the live WKWebView; selectors are public AppKit/WebKit.
            unsafe {
                let wk = webview.inner() as *mut AnyObject;
                let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![wk, setUnderPageBackgroundColor: clear];
                let _: () = msg_send![wk, setValue: clear, forKey: ns_str("backgroundColor")];
            }
        });
    }

    // Window is non-focusable so show cannot activate the app.
    if let Err(e) = window.show() {
        log(LOG_TAG, &format!("setup: show FAILED: {e}"));
    } else {
        log(LOG_TAG, "setup: shown");
    }

    #[cfg(target_os = "macos")]
    register_screen_params_observer(app);
}

/// Register for display arrangement/resolution changes so the widget
/// re-anchors. macOS only. Leaks the observer token + block for process life.
#[cfg(target_os = "macos")]
fn register_screen_params_observer(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::AnyObject};

    let app = app.clone();
    // SAFETY: main thread (setup / with_webview path); public Foundation
    // selectors; null-checked before use.
    unsafe {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        if center.is_null() {
            log(LOG_TAG, "screen observer: defaultCenter is nil");
            return;
        }
        let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let name = ns_str("NSApplicationDidChangeScreenParametersNotification");
        let block = RcBlock::new(move |_notif: *mut AnyObject| {
            log(LOG_TAG, "screen parameters changed — re-anchoring");
            anchor_widget(&app);
        });
        let null_obj: *mut AnyObject = std::ptr::null_mut();
        let observer: *mut AnyObject = msg_send![
            center,
            addObserverForName: name,
            object: null_obj,
            queue: queue,
            usingBlock: &*block
        ];
        // Leak both: the widget lives for the app's lifetime and we never
        // unregister. `addObserverForName:…` returns a retained token we must
        // keep; the center also retains the block, but we forget our RcBlock
        // so a late notification after an (impossible) early drop can't UAF.
        std::mem::forget(block);
        let _ = observer; // retained (+1); intentionally never released
        log(LOG_TAG, "screen observer registered");
    }
}

/// Build an autoreleased `NSString` from a Rust &str for KVC / notification
/// name selectors. Local copy of the banner helper — not exported.
#[cfg(target_os = "macos")]
fn ns_str(s: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::{class, msg_send, runtime::AnyObject};
    // SAFETY: autoreleased NSString; valid UTF-8 bytes from &str.
    unsafe {
        let cls = class!(NSString);
        let bytes = s.as_ptr() as *const std::ffi::c_void;
        let ns: *mut AnyObject = msg_send![
            cls,
            stringWithBytes: bytes,
            length: s.len(),
            encoding: 4usize /* NSUTF8StringEncoding */
        ];
        ns
    }
}
