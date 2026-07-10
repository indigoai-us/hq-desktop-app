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
//!
//! ## Notification takeover (US-003)
//!
//! When the widget window is live, every DM/share/meeting/update banner is
//! routed to the widget stack via `show_widget_notification` (no dm-banner
//! window, no native macOS notifications). The window can grow up/left from
//! the lower-right anchor to fit notification rows (`resize_widget`), and
//! emits `widget:occlusion` so the frontend can queue while occluded.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

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
/// Max size when the notification stack expands the window (US-003).
const WIDGET_W_MAX: f64 = 340.0;
const WIDGET_H_MAX: f64 = 480.0;
/// Margins from the display's visible edge. `MARGIN_RIGHT` is 8 so the mark's
/// visual right margin stays 18px (8 window margin + 10px right padding in
/// `.wg`). `MARGIN_BOTTOM` is 16 — the mark sits flush to the window bottom.
const MARGIN_RIGHT: f64 = 8.0;
const MARGIN_BOTTOM: f64 = 16.0;

/// Current logical size of the widget window. Starts at the idle wordmark
/// size; `resize_widget` grows it for notification rows while re-anchoring so
/// the lower-right corner stays fixed.
static WIDGET_SIZE: Mutex<(f64, f64)> = Mutex::new((WIDGET_W, WIDGET_H));

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

// ── Takeover (US-003) ───────────────────────────────────────────────────────────

/// True when widget mode owns notification delivery.
///
/// Returns `widget_enabled() &&` the widget window exists. Reads menubar.json
/// FRESH each call (`widget_enabled` already does) so disabling widget mode
/// instantly restores native notifications.
pub fn takeover_active(app: &AppHandle) -> bool {
    widget_enabled() && app.get_webview_window(WINDOW_LABEL).is_some()
}

/// Route a notification payload to the widget's in-window stack.
///
/// Emits `widget:notification` to the widget webview. Called from
/// `show_banner` when [`takeover_active`] is true — the single funnel for
/// DM/share/meeting/update while widget mode is on.
pub async fn show_widget_notification(
    app: AppHandle,
    payload: hq_desktop_core::banner::BannerPayload,
) -> Result<(), String> {
    log(
        LOG_TAG,
        &format!("takeover: routing kind={} to widget stack", payload.kind),
    );
    app.emit_to(WINDOW_LABEL, "widget:notification", &payload)
        .map_err(|e| e.to_string())
}

/// Clamp requested widget size to the idle minimum and the stack maximum.
fn clamp_widget_size(width: f64, height: f64) -> (f64, f64) {
    (
        width.clamp(WIDGET_W, WIDGET_W_MAX),
        height.clamp(WIDGET_H, WIDGET_H_MAX),
    )
}

fn current_widget_size() -> (f64, f64) {
    WIDGET_SIZE
        .lock()
        .map(|g| *g)
        .unwrap_or((WIDGET_W, WIDGET_H))
}

// ── Anchoring ───────────────────────────────────────────────────────────────────

/// Compute the lower-right anchor for the widget window.
///
/// On macOS, uses `NSScreen.visibleFrame` (Dock/menu-bar aware) on the main
/// thread. Falls back to Tauri monitor APIs when Cocoa fails or off-macOS.
/// Uses the current tracked size so re-anchors keep the lower-right fixed
/// when the window has grown for notification rows.
fn widget_position(app: &AppHandle) -> tauri::LogicalPosition<f64> {
    let (w, h) = current_widget_size();
    #[cfg(target_os = "macos")]
    if let Some(pos) = widget_position_cocoa(w, h) {
        return pos;
    }
    widget_position_fallback(app, w, h)
}

/// macOS: lower-right of the configured screen's `visibleFrame`, converted
/// from Cocoa bottom-left coords to tao/tauri top-left logical coords.
/// `w`/`h` are the current window size so the lower-right corner stays fixed
/// at the same margins for any size.
#[cfg(target_os = "macos")]
fn widget_position_cocoa(w: f64, h: f64) -> Option<tauri::LogicalPosition<f64>> {
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
        // window grows up/left so the wordmark stays fixed at lower-right.
        let x_cocoa = vf.origin.x + vf.size.width - w - MARGIN_RIGHT;
        let y_cocoa = vf.origin.y + MARGIN_BOTTOM;
        // tao/tauri: top-left origin, y-down, relative to primary frame.
        let x = x_cocoa;
        let y = primary_frame.size.height - (y_cocoa + h);

        Some(tauri::LogicalPosition::new(x, y))
    }
}

/// Fallback (non-macOS or Cocoa failure): Tauri monitor APIs + extra bottom
/// clearance for a possible dock/taskbar.
fn widget_position_fallback(app: &AppHandle, w: f64, h: f64) -> tauri::LogicalPosition<f64> {
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
        let x = (origin_x + mon_w - w - MARGIN_RIGHT).max(origin_x);
        let y = (origin_y + mon_h - h - 80.0).max(origin_y);
        return tauri::LogicalPosition::new(x, y);
    }

    // Last-resort hard-coded primary-ish geometry.
    tauri::LogicalPosition::new(1440.0 - w - MARGIN_RIGHT, 900.0 - h - 80.0)
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

// ── Resize (US-003) ─────────────────────────────────────────────────────────────

/// Grow/shrink the widget window to fit notification rows while keeping the
/// wordmark visually fixed at the lower-right (window expands up/left).
#[tauri::command]
pub async fn resize_widget(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let (w, h) = clamp_widget_size(width, height);
    if let Ok(mut size) = WIDGET_SIZE.lock() {
        *size = (w, h);
    }
    log(
        LOG_TAG,
        &format!("resize: {w:.0}×{h:.0} (requested {width:.0}×{height:.0})"),
    );

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                log(LOG_TAG, &format!("resize set_size failed: {e}"));
                return;
            }
            let pos = widget_position(&app);
            if let Err(e) = window.set_position(pos) {
                log(LOG_TAG, &format!("resize set_position failed: {e}"));
            } else {
                log(
                    LOG_TAG,
                    &format!("resized to {w:.0}×{h:.0} at ({:.0}, {:.0})", pos.x, pos.y),
                );
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            window
                .set_size(tauri::LogicalSize::new(w, h))
                .map_err(|e| e.to_string())?;
            let pos = widget_position(&app);
            let _ = window.set_position(pos);
        }
        Ok(())
    }
}

// ── Occlusion (US-003) ──────────────────────────────────────────────────────────

/// Query the widget window's current occlusion visibility.
///
/// Must run on the main thread (AppKit). Callers already on the main thread
/// (notification blocks, `run_on_main_thread` closures) can call this directly.
/// Returns `None` when the window is missing or the AppKit query fails.
#[cfg(target_os = "macos")]
fn widget_occlusion_visible_now(app: &AppHandle) -> Option<bool> {
    use objc2::runtime::AnyObject;

    let window = app.get_webview_window(WINDOW_LABEL)?;
    let ns_win = window.ns_window().ok()? as *mut AnyObject;
    // SAFETY: caller is on the main thread; ns_window is the live NSWindow.
    unsafe { widget_occlusion_visible_from_nswindow(ns_win) }
}

/// Read `NSWindow.occlusionState` for a known NSWindow pointer.
/// `NSWindowOcclusionStateVisible = 1 << 1`.
#[cfg(target_os = "macos")]
unsafe fn widget_occlusion_visible_from_nswindow(
    ns_win: *mut objc2::runtime::AnyObject,
) -> Option<bool> {
    use objc2::msg_send;

    if ns_win.is_null() {
        return None;
    }
    // NSWindowOcclusionStateVisible = 1 << 1
    const NS_WINDOW_OCCLUSION_STATE_VISIBLE: usize = 1 << 1;
    // SAFETY: main thread; public AppKit selector; ns_win non-null.
    let state: usize = msg_send![ns_win, occlusionState];
    Some((state & NS_WINDOW_OCCLUSION_STATE_VISIBLE) != 0)
}

/// Register for `NSWindowDidChangeOcclusionStateNotification` scoped to the
/// widget's NSWindow. Leaks the observer token + block for process life —
/// mirrors `register_screen_params_observer`.
#[cfg(target_os = "macos")]
fn register_occlusion_observer(app: &AppHandle, window: &tauri::WebviewWindow) {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::AnyObject};

    let Ok(ns_win_raw) = window.ns_window() else {
        log(LOG_TAG, "occlusion observer: ns_window failed");
        return;
    };
    let ns_win = ns_win_raw as *mut AnyObject;
    if ns_win.is_null() {
        log(LOG_TAG, "occlusion observer: ns_window is nil");
        return;
    }

    let app = app.clone();
    // SAFETY: main thread (setup path); public Foundation/AppKit selectors;
    // null-checked before use. Observer + block leaked for process life.
    unsafe {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        if center.is_null() {
            log(LOG_TAG, "occlusion observer: defaultCenter is nil");
            return;
        }
        let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let name = ns_str("NSWindowDidChangeOcclusionStateNotification");
        let block = RcBlock::new(move |_notif: *mut AnyObject| {
            // Main queue → already on main thread.
            let visible = widget_occlusion_visible_from_nswindow(ns_win).unwrap_or(true);
            log(LOG_TAG, &format!("occlusion: visible={visible}"));
            let _ = app.emit_to(
                WINDOW_LABEL,
                "widget:occlusion",
                serde_json::json!({ "visible": visible }),
            );
        });
        let observer: *mut AnyObject = msg_send![
            center,
            addObserverForName: name,
            object: ns_win,
            queue: queue,
            usingBlock: &*block
        ];
        // Leak both: the widget lives for the app's lifetime and we never
        // unregister. Same idiom as the screen-params observer.
        std::mem::forget(block);
        let _ = observer; // retained (+1); intentionally never released
        log(LOG_TAG, "occlusion observer registered");
    }
}

/// Ready-handshake: emit the current occlusion state once the frontend has
/// mounted its `widget:occlusion` listener. Defaults `visible: true` when
/// the AppKit query is unavailable.
#[tauri::command]
pub async fn widget_ready(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let visible = widget_occlusion_visible_now(&app).unwrap_or(true);
            log(
                LOG_TAG,
                &format!("widget_ready: initial occlusion visible={visible}"),
            );
            let _ = app.emit_to(
                WINDOW_LABEL,
                "widget:occlusion",
                serde_json::json!({ "visible": visible }),
            );
        });
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app.emit_to(
            WINDOW_LABEL,
            "widget:occlusion",
            serde_json::json!({ "visible": true }),
        );
        Ok(())
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

    // Reset size tracking for a fresh window (idle wordmark).
    if let Ok(mut size) = WIDGET_SIZE.lock() {
        *size = (WIDGET_W, WIDGET_H);
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

    #[cfg(target_os = "macos")]
    register_occlusion_observer(app, &window);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_widget_size_holds_idle_minimum() {
        assert_eq!(clamp_widget_size(0.0, 0.0), (WIDGET_W, WIDGET_H));
        assert_eq!(clamp_widget_size(10.0, 5.0), (WIDGET_W, WIDGET_H));
        assert_eq!(
            clamp_widget_size(WIDGET_W, WIDGET_H),
            (WIDGET_W, WIDGET_H)
        );
    }

    #[test]
    fn clamp_widget_size_holds_maximum() {
        assert_eq!(
            clamp_widget_size(999.0, 999.0),
            (WIDGET_W_MAX, WIDGET_H_MAX)
        );
        assert_eq!(
            clamp_widget_size(WIDGET_W_MAX, WIDGET_H_MAX),
            (WIDGET_W_MAX, WIDGET_H_MAX)
        );
    }

    #[test]
    fn clamp_widget_size_passes_through_in_range() {
        assert_eq!(clamp_widget_size(200.0, 120.0), (200.0, 120.0));
        assert_eq!(clamp_widget_size(100.0, 43.0), (100.0, 43.0));
        assert_eq!(clamp_widget_size(66.0, 300.0), (66.0, 300.0));
    }
}
