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
//! ## Prefs (typed in MenubarPrefs; untyped at runtime)
//!
//! Settings UI round-trips `widgetEnabled` / `widgetDisplay` via typed
//! `MenubarPrefs` (US-004). This module still reads those keys untyped from
//! `~/.hq/menubar.json` on every dispatch so toggles take effect without
//! restart. Defaults: enabled ON, display = primary.
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
//!
//! ### Ready-handshake (never drop notifications in the startup gap)
//!
//! The widget webview mounts its `widget:notification` listener in `onMount`
//! and only then invokes `widget_ready`. Any payload that arrives between
//! window creation and that handshake would be silently dropped if emitted
//! immediately. [`WIDGET_STACK_CHANNEL`] buffers those payloads until ready,
//! then drains them FIFO when `widget_ready` runs (after the initial
//! `widget:occlusion` emit). Cap is [`WIDGET_PENDING_CAP`]; oldest drop first.

use std::sync::{Mutex, Once};

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

use crate::util::logfile::log;

const LOG_TAG: &str = "widget";

/// Ensures `register_screen_params_observer` runs at most once per process.
/// `setup_widget_window` can run again after disable→re-enable (US-004); without
/// this guard each enable would stack a duplicate NSNotificationCenter observer.
static SCREEN_PARAMS_OBSERVER: Once = Once::new();

/// Ensures `register_click_away_monitor` runs at most once per process.
/// Same disable→re-enable rationale as [`SCREEN_PARAMS_OBSERVER`].
static CLICK_AWAY_MONITOR: Once = Once::new();

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

/// Max payloads held while the widget webview has not completed its
/// ready-handshake. Oldest are dropped when over cap.
const WIDGET_PENDING_CAP: usize = 50;

/// Current logical size of the widget window. Starts at the idle wordmark
/// size; `resize_widget` grows it for notification rows while re-anchoring so
/// the lower-right corner stays fixed.
static WIDGET_SIZE: Mutex<(f64, f64)> = Mutex::new((WIDGET_W, WIDGET_H));

/// Stack channel: `(ready, pending)`.
///
/// - `ready` is `false` from window creation until the frontend mounts its
///   listeners and invokes [`widget_ready`].
/// - `pending` is FIFO; [`show_widget_notification`] pushes while not ready;
///   [`widget_ready`] drains after the initial occlusion emit.
/// - Cap [`WIDGET_PENDING_CAP`]; oldest dropped first.
///
/// When `setup_widget_window` **creates** a new window it resets `ready` to
/// `false` but keeps any already-buffered pending payloads.
static WIDGET_STACK_CHANNEL: Mutex<(bool, Vec<hq_desktop_core::banner::BannerPayload>)> =
    Mutex::new((false, Vec::new()));

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

/// Pure routing decision for the widget stack channel.
///
/// Returns `(emit_now, next_pending)`. When `ready`, the caller should emit
/// immediately and `pending` is left unchanged (payload is not consumed into
/// the queue). When not ready, `payload` is appended FIFO and the queue is
/// trimmed to `cap` by dropping oldest entries.
///
/// Extracted so unit tests cover buffer-vs-emit + cap trimming without an
/// `AppHandle`. Callers that need the payload after a ready/emit decision
/// should clone before calling when `ready` is true, or pass ownership only
/// when buffering.
fn route_widget_notification(
    ready: bool,
    mut pending: Vec<hq_desktop_core::banner::BannerPayload>,
    payload: hq_desktop_core::banner::BannerPayload,
    cap: usize,
) -> (bool, Vec<hq_desktop_core::banner::BannerPayload>) {
    if ready {
        // Payload not queued; drop the by-value arg (callers clone when needed).
        drop(payload);
        return (true, pending);
    }
    pending.push(payload);
    if cap == 0 {
        pending.clear();
    } else if pending.len() > cap {
        let overflow = pending.len() - cap;
        pending.drain(..overflow);
    }
    (false, pending)
}

/// Route a notification payload to the widget's in-window stack.
///
/// If the webview has completed its ready-handshake, emits
/// `widget:notification` immediately. Otherwise buffers the payload in
/// [`WIDGET_STACK_CHANNEL`] (FIFO, capped) so nothing is dropped during the
/// startup gap between window creation and `widget_ready`.
///
/// Called from `show_banner` when [`takeover_active`] is true — the single
/// funnel for DM/share/meeting/update while widget mode is on.
pub async fn show_widget_notification(
    app: AppHandle,
    payload: hq_desktop_core::banner::BannerPayload,
) -> Result<(), String> {
    log(
        LOG_TAG,
        &format!("takeover: routing kind={} to widget stack", payload.kind),
    );

    // Under the lock: either emit immediately, or buffer (FIFO + cap).
    let to_emit = {
        let mut guard = WIDGET_STACK_CHANNEL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if guard.0 {
            // Ready — emit this payload; leave pending alone.
            Some(payload)
        } else {
            let pending = std::mem::take(&mut guard.1);
            let (_emit, next_pending) =
                route_widget_notification(false, pending, payload, WIDGET_PENDING_CAP);
            guard.1 = next_pending;
            None
        }
    };

    let Some(payload) = to_emit else {
        log(LOG_TAG, "takeover: buffered (webview not ready yet)");
        return Ok(());
    };

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

/// Pure lower-right anchor in tao/tauri logical coords (top-left origin, y-down).
///
/// Cocoa's `visibleFrame` uses bottom-left origin with y-up. The widget's Cocoa
/// lower-left sits at `(vf_origin_x + vf_width - w - MARGIN_RIGHT, vf_origin_y +
/// MARGIN_BOTTOM)`. Converting to tao: `y = primary_height - (y_cocoa + h)`.
/// Because the window grows up/left from that corner, the lower-right screen
/// point `(x + w, y + h)` is invariant across sizes for a fixed visibleFrame.
///
/// cfg-independent so unit tests run on every host.
fn anchor_lower_right(
    vf_origin_x: f64,
    vf_origin_y: f64,
    vf_width: f64,
    primary_height: f64,
    w: f64,
    h: f64,
) -> (f64, f64) {
    let x = vf_origin_x + vf_width - w - MARGIN_RIGHT;
    let y_cocoa = vf_origin_y + MARGIN_BOTTOM;
    (x, primary_height - (y_cocoa + h))
}

/// Compute the lower-right anchor for the widget window using `w`×`h`.
///
/// On macOS, uses `NSScreen.visibleFrame` (Dock/menu-bar aware) on the main
/// thread. Falls back to Tauri monitor APIs when Cocoa fails or off-macOS.
/// Callers that need size and position to stay matched (e.g. `resize_widget`)
/// must pass the same `(w, h)` they apply via `set_size`.
fn widget_position_for(app: &AppHandle, w: f64, h: f64) -> tauri::LogicalPosition<f64> {
    #[cfg(target_os = "macos")]
    if let Some(pos) = widget_position_cocoa(w, h) {
        return pos;
    }
    widget_position_fallback(app, w, h)
}

/// Anchor using the currently tracked widget size (setup / re-anchor paths).
fn widget_position(app: &AppHandle) -> tauri::LogicalPosition<f64> {
    let (w, h) = current_widget_size();
    widget_position_for(app, w, h)
}

/// macOS: lower-right of the configured screen's `visibleFrame`, converted
/// from Cocoa bottom-left coords to tao/tauri top-left logical coords.
/// `w`/`h` are the window size so the lower-right corner stays fixed
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

        let (x, y) = anchor_lower_right(
            vf.origin.x,
            vf.origin.y,
            vf.size.width,
            primary_frame.size.height,
            w,
            h,
        );

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
            // Re-read latest requested size so out-of-order main-thread
            // closures always apply a matched size+position pair.
            let (w, h) = current_widget_size();
            if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                // Log but do not return early — tao keeps top-left fixed on
                // resize, so we must still re-anchor even when set_size fails.
                log(LOG_TAG, &format!("resize set_size failed: {e}"));
            }
            let pos = widget_position_for(&app, w, h);
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
            // Re-read latest requested size (same convergence as macOS path).
            let (w, h) = current_widget_size();
            if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                log(LOG_TAG, &format!("resize set_size failed: {e}"));
            }
            let pos = widget_position_for(&app, w, h);
            if let Err(e) = window.set_position(pos) {
                log(LOG_TAG, &format!("resize set_position failed: {e}"));
            } else {
                log(
                    LOG_TAG,
                    &format!("resized to {w:.0}×{h:.0} at ({:.0}, {:.0})", pos.x, pos.y),
                );
            }
        }
        Ok(())
    }
}

// ── Focusable (quick-reply) ─────────────────────────────────────────────────────

/// Temporarily make the widget window key so the quick-reply `<input>` can type.
///
/// While idle the window stays non-activating (design lock: `.focusable(false)`
/// + Accessory policy). This command flips that on so keyboard focus can reach
/// the reply field; the frontend restores `focusable(false)` when the reply is
/// sent/dismissed or the pointer leaves the widget.
#[tauri::command]
pub async fn set_widget_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                // Missing window is a silent no-op (mirror resize_widget).
                return;
            };
            match window.set_focusable(focusable) {
                Ok(()) => {
                    log(
                        LOG_TAG,
                        &format!("set_widget_focusable: focusable={focusable}"),
                    );
                    if focusable {
                        if let Err(e) = window.set_focus() {
                            log(LOG_TAG, &format!("set_widget_focusable: set_focus failed: {e}"));
                        }
                    }
                }
                Err(e) => {
                    log(
                        LOG_TAG,
                        &format!("set_widget_focusable: set_focusable failed: {e}"),
                    );
                }
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
            return Ok(());
        };
        match window.set_focusable(focusable) {
            Ok(()) => {
                log(
                    LOG_TAG,
                    &format!("set_widget_focusable: focusable={focusable}"),
                );
                if focusable {
                    if let Err(e) = window.set_focus() {
                        log(LOG_TAG, &format!("set_widget_focusable: set_focus failed: {e}"));
                    }
                }
            }
            Err(e) => {
                log(
                    LOG_TAG,
                    &format!("set_widget_focusable: set_focusable failed: {e}"),
                );
            }
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

/// Ready-handshake: mark the webview ready, emit the current occlusion state
/// once the frontend has mounted its listeners, then drain any payloads that
/// arrived during the startup gap (FIFO `widget:notification` emits).
///
/// Defaults occlusion `visible: true` when the AppKit query is unavailable.
#[tauri::command]
pub async fn widget_ready(app: AppHandle) -> Result<(), String> {
    // Mark ready under the lock and take pending. Concurrent
    // `show_widget_notification` calls after this emit immediately.
    let pending = {
        let mut guard = WIDGET_STACK_CHANNEL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.0 = true;
        std::mem::take(&mut guard.1)
    };

    // Initial occlusion first — frontend is listening.
    #[cfg(target_os = "macos")]
    {
        let app_for_occ = app.clone();
        let _ = app_for_occ.clone().run_on_main_thread(move || {
            let visible = widget_occlusion_visible_now(&app_for_occ).unwrap_or(true);
            log(
                LOG_TAG,
                &format!("widget_ready: initial occlusion visible={visible}"),
            );
            let _ = app_for_occ.emit_to(
                WINDOW_LABEL,
                "widget:occlusion",
                serde_json::json!({ "visible": visible }),
            );
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app.emit_to(
            WINDOW_LABEL,
            "widget:occlusion",
            serde_json::json!({ "visible": true }),
        );
    }

    // Drain buffered notifications in FIFO order after occlusion.
    let drained = pending.len();
    for payload in pending {
        if let Err(e) = app.emit_to(WINDOW_LABEL, "widget:notification", &payload) {
            log(
                LOG_TAG,
                &format!("widget_ready: drain emit failed: {e}"),
            );
        }
    }
    if drained > 0 {
        log(
            LOG_TAG,
            &format!("widget_ready: drained {drained} buffered notification(s)"),
        );
    }

    Ok(())
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

    // New webview is not ready until it mounts listeners and invokes
    // `widget_ready`. Reset ready=false; keep any already-buffered pending
    // payloads so notifications that raced setup are not lost.
    if let Ok(mut ch) = WIDGET_STACK_CHANNEL.lock() {
        ch.0 = false;
        // keep ch.1 (pending)
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

    #[cfg(target_os = "macos")]
    register_click_away_monitor(app);
}

/// Register a global mouse-down monitor so the frontend can close a
/// click-pinned recent list when the user clicks OUTSIDE the widget window
/// (US-010). The widget window is non-focusable, so it never sees `blur`, and
/// clicks in other apps / the desktop never reach its `document` — a global
/// NSEvent monitor is the only signal. Global monitors only observe events
/// delivered to OTHER applications (clicks inside the widget stay in-webview),
/// which is exactly the click-away set. Passive: events are observed, never
/// consumed. The frontend ignores the event unless a list is pinned.
///
/// Guarded by [`CLICK_AWAY_MONITOR`]; the monitor + block leak for process
/// life (same idiom as the other observers here).
#[cfg(target_os = "macos")]
fn register_click_away_monitor(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::AnyObject};

    let app = app.clone();
    CLICK_AWAY_MONITOR.call_once(move || {
        // NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown
        const MASK: u64 = (1 << 1) | (1 << 3);
        // SAFETY: main thread (setup path); public AppKit selectors; the
        // returned monitor token and block are intentionally leaked.
        unsafe {
            let block = RcBlock::new(move |_event: *mut AnyObject| {
                let _ = app.emit_to(WINDOW_LABEL, "widget:click-away", serde_json::json!({}));
            });
            let monitor: *mut AnyObject = msg_send![
                class!(NSEvent),
                addGlobalMonitorForEventsMatchingMask: MASK,
                handler: &*block
            ];
            std::mem::forget(block);
            let _ = monitor; // retained token; intentionally never released
            log(LOG_TAG, "click-away monitor registered");
        }
    });
}

/// Register for display arrangement/resolution changes so the widget
/// re-anchors. macOS only. Leaks the observer token + block for process life.
///
/// Guarded by [`SCREEN_PARAMS_OBSERVER`] so disable→re-enable (US-004
/// `apply_widget_settings` → `setup_widget_window`) does not stack duplicates.
#[cfg(target_os = "macos")]
fn register_screen_params_observer(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::AnyObject};

    let app = app.clone();
    SCREEN_PARAMS_OBSERVER.call_once(move || {
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
    });
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

// ── Settings UI commands (US-004) ───────────────────────────────────────────────

/// One display entry for the Settings display picker.
///
/// `name` MUST be the exact string matched by `configured_display_name()` /
/// `widget_position_cocoa` (`NSScreen.localizedName`) so a picker selection
/// round-trips into menubar.json and re-anchors correctly.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub name: String,
    pub primary: bool,
}

/// Enumerate displays for the Settings picker.
///
/// macOS: hops to the main thread and reads `NSScreen.screens` +
/// `localizedName` (same source as the anchor). On failure or non-macOS,
/// falls back to Tauri `available_monitors()`. Never errors just because
/// some names are missing — returns whatever is available (at worst a single
/// "Primary Display" entry).
///
/// Names are deduped via [`dedupe_displays_by_name`] so the picker only lists
/// addresses the anchor can actually resolve (first-match-by-name).
#[tauri::command]
pub async fn list_displays(app: tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<DisplayInfo>>();
        let app_for_main = app.clone();
        let hop = app_for_main.clone().run_on_main_thread(move || {
            let list = list_displays_cocoa().unwrap_or_else(|| list_displays_fallback(&app_for_main));
            let _ = tx.send(list);
        });
        if hop.is_err() {
            log(LOG_TAG, "list_displays: run_on_main_thread failed — fallback");
            return Ok(list_displays_fallback(&app));
        }
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(list) => {
                log(
                    LOG_TAG,
                    &format!("list_displays: {} display(s)", list.len()),
                );
                Ok(list)
            }
            Err(_) => {
                log(LOG_TAG, "list_displays: main-thread recv timeout — fallback");
                Ok(list_displays_fallback(&app))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(list_displays_fallback(&app))
    }
}

/// Drop later entries whose `name` already appeared (keep first).
///
/// Why: `configured_display_name()` matching in `widget_position_cocoa` is
/// first-match-by-`localizedName` (locked US-002 design), so a second monitor
/// with an identical name can never be individually addressed. Showing it in
/// the picker is misleading AND duplicate `name` values crash Svelte's keyed
/// `{#each displays as display (display.name)}` in WidgetSettings.
fn dedupe_displays_by_name(mut list: Vec<DisplayInfo>) -> Vec<DisplayInfo> {
    let mut seen = std::collections::HashSet::new();
    list.retain(|d| seen.insert(d.name.clone()));
    list
}

/// macOS: enumerate `NSScreen.screens` with `localizedName` UTF-8.
/// Primary = index 0 (same convention as `widget_position_cocoa`).
#[cfg(target_os = "macos")]
fn list_displays_cocoa() -> Option<Vec<DisplayInfo>> {
    use objc2::{class, msg_send, runtime::AnyObject};

    // SAFETY: caller must be on the main thread (`run_on_main_thread`).
    // Public AppKit selectors; pointers null-checked before use.
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            log(LOG_TAG, "list_displays: NSScreen.screens is nil");
            return None;
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            log(LOG_TAG, "list_displays: NSScreen.screens is empty");
            return None;
        }

        let mut out = Vec::with_capacity(count);
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
                let name = s.trim();
                if name.is_empty() {
                    continue;
                }
                out.push(DisplayInfo {
                    name: name.to_string(),
                    primary: i == 0,
                });
            }
        }

        if out.is_empty() {
            None
        } else {
            // Dedupe before primary-ensure so the kept first entry can carry primary.
            out = dedupe_displays_by_name(out);
            // Ensure at least one primary if we skipped index 0's name.
            if !out.iter().any(|d| d.primary) {
                out[0].primary = true;
            }
            Some(out)
        }
    }
}

/// Fallback: Tauri monitor APIs. Skips unnamed monitors; if nothing remains,
/// returns a single "Primary Display" entry so the picker is never empty.
fn list_displays_fallback(app: &AppHandle) -> Vec<DisplayInfo> {
    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().map(|s| s.to_string()));

    let monitors = app.available_monitors().ok().unwrap_or_default();
    let mut out: Vec<DisplayInfo> = monitors
        .into_iter()
        .filter_map(|m| {
            let name = m.name()?.to_string();
            if name.trim().is_empty() {
                return None;
            }
            let primary = primary_name.as_ref().map(|p| p == &name).unwrap_or(false);
            Some(DisplayInfo { name, primary })
        })
        .collect();

    if out.is_empty() {
        log(
            LOG_TAG,
            "list_displays: no named monitors — returning Primary Display",
        );
        return vec![DisplayInfo {
            name: "Primary Display".to_string(),
            primary: true,
        }];
    }

    // Dedupe before primary-ensure so the kept first entry can carry primary.
    out = dedupe_displays_by_name(out);

    if !out.iter().any(|d| d.primary) {
        out[0].primary = true;
    }
    out
}

/// Reconcile the widget window with the just-saved menubar.json prefs.
///
/// Called by the Settings UI after `save_settings`. On the main thread:
/// - enabled → `setup_widget_window` (re-anchor if present, create if missing)
/// - disabled + window exists → mark stack not-ready (keep pending), close window
///
/// After close, `takeover_active()` is false so the next notification is
/// delivered natively — the US-004 instant-restore contract. No extra gating.
///
/// `main.rs` `on_window_event` only intercepts the `"main"` label, so
/// `window.close()` for the widget is fine (not `destroy()`).
#[tauri::command]
pub async fn apply_widget_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let app_for_main = app.clone();
        let hop = app_for_main.clone().run_on_main_thread(move || {
            let result = apply_widget_settings_on_main(&app_for_main);
            let _ = tx.send(result);
        });
        if hop.is_err() {
            // Never create/close NSWindow off the AppKit main thread.
            log(
                LOG_TAG,
                "apply_widget_settings: failed to reach main thread",
            );
            return Err("apply_widget_settings: failed to reach main thread".into());
        }
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(result) => result,
            Err(_) => {
                log(
                    LOG_TAG,
                    "apply_widget_settings: main-thread recv timeout",
                );
                Err("apply_widget_settings timed out waiting for main thread".into())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        apply_widget_settings_on_main(&app)
    }
}

/// Core apply path — must run on the main thread on macOS (window create/close).
fn apply_widget_settings_on_main(app: &AppHandle) -> Result<(), String> {
    if widget_enabled() {
        log(LOG_TAG, "apply_widget_settings: enabled — setup/re-anchor");
        setup_widget_window(app);
        return Ok(());
    }

    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        log(
            LOG_TAG,
            "apply_widget_settings: disabled — no window (already off)",
        );
        return Ok(());
    };

    // Mark not-ready but KEEP pending so any payloads buffered during the
    // disable race are not dropped. After close, takeover_active() is false
    // and the next notification goes native.
    if let Ok(mut ch) = WIDGET_STACK_CHANNEL.lock() {
        ch.0 = false;
        // keep ch.1 (pending)
    }

    match window.close() {
        Ok(()) => log(LOG_TAG, "apply_widget_settings: disabled — window closed"),
        Err(e) => {
            log(
                LOG_TAG,
                &format!("apply_widget_settings: close failed: {e}"),
            );
            return Err(format!("Failed to close widget window: {e}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::banner::BannerPayload;

    fn sample_payload(kind: &str) -> BannerPayload {
        BannerPayload {
            kind: kind.to_string(),
            title: "t".to_string(),
            body: "b".to_string(),
            icon_text: None,
            action_label: None,
            action_id: None,
            click_action_id: "open".to_string(),
            data: serde_json::Value::Null,
        }
    }

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

    #[test]
    fn route_widget_notification_emits_when_ready() {
        let pending = vec![sample_payload("old")];
        let (emit, next) =
            route_widget_notification(true, pending.clone(), sample_payload("new"), 50);
        assert!(emit);
        // Pending unchanged when ready — caller emits the new payload itself.
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].kind, "old");
    }

    #[test]
    fn route_widget_notification_buffers_when_not_ready() {
        let (emit, next) =
            route_widget_notification(false, Vec::new(), sample_payload("a"), 50);
        assert!(!emit);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].kind, "a");

        let (emit2, next2) =
            route_widget_notification(false, next, sample_payload("b"), 50);
        assert!(!emit2);
        assert_eq!(
            next2.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn route_widget_notification_drops_oldest_over_cap() {
        let mut pending = Vec::new();
        for i in 0..3 {
            let (emit, next) =
                route_widget_notification(false, pending, sample_payload(&format!("k{i}")), 2);
            assert!(!emit);
            pending = next;
        }
        // Cap 2: kept newest (k1, k2); dropped oldest k0.
        assert_eq!(
            pending
                .iter()
                .map(|p| p.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["k1", "k2"]
        );
    }

    #[test]
    fn anchor_lower_right_keeps_lower_right_corner_fixed_across_sizes() {
        // 1512×982 visibleFrame at origin (0,0); primary_height 982.
        let vf_ox = 0.0;
        let vf_oy = 0.0;
        let vf_w = 1512.0;
        let primary_h = 982.0;

        let (x_idle, y_idle) =
            anchor_lower_right(vf_ox, vf_oy, vf_w, primary_h, 66.0, 43.0);
        let (x_grown, y_grown) =
            anchor_lower_right(vf_ox, vf_oy, vf_w, primary_h, 340.0, 480.0);

        // Lower-right corner (x+w, y+h) is size-invariant.
        assert_eq!(x_idle + 66.0, x_grown + 340.0);
        assert_eq!(y_idle + 43.0, y_grown + 480.0);
    }

    #[test]
    fn grow_then_shrink_returns_to_idle_anchor() {
        let vf_ox = 0.0;
        let vf_oy = 0.0;
        let vf_w = 1512.0;
        let primary_h = 982.0;

        let idle = anchor_lower_right(vf_ox, vf_oy, vf_w, primary_h, 66.0, 43.0);
        let _grown = anchor_lower_right(vf_ox, vf_oy, vf_w, primary_h, 340.0, 480.0);
        let idle_again = anchor_lower_right(vf_ox, vf_oy, vf_w, primary_h, 66.0, 43.0);

        assert_eq!(idle_again, idle);
    }

    #[test]
    fn anchor_lower_right_secondary_display_offsets() {
        // Secondary display visibleFrame origin (1512, 100), width 1920;
        // primary_height 982; idle size 66×43.
        let (x, y) = anchor_lower_right(1512.0, 100.0, 1920.0, 982.0, 66.0, 43.0);
        assert_eq!(x, 1512.0 + 1920.0 - 66.0 - 8.0);
        // y can be negative for displays above the primary.
        assert_eq!(y, 982.0 - (100.0 + 16.0 + 43.0));
    }
}
