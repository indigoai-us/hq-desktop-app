//! Idea-board capture overlay (US-003).
//!
//! A global chord (default ⌥⇧C / Alt+Shift+C) must put a dimmed capture
//! overlay on screen faster than the OS screenshot tool. The only way to hit
//! the 80ms chord→overlay budget is to *pre-render*: the `capture-overlay`
//! webview window is built hidden at app start and merely shown (never
//! constructed) on chord press.
//!
//! Window contract:
//!   * transparent, always-on-top, decorations off, skip-taskbar
//!   * **non-activating** (`.focusable(false)`) — the user's app keeps focus.
//!     Per repo policy `hq-desktop-app-nonactivating-window-toggle-focusable-
//!     for-input` this window therefore hosts no text input; the capture toast
//!     (US-005) is a separate window for that reason.
//!   * sized/positioned to the display under the cursor at press time.
//!
//! Timing marks are written through `util::logfile` so US-001's benchmark
//! (`apps/sync/scripts/idea-board-bench.mjs`) can score them:
//!
//! ```text
//! [idea] idea.capture.chord
//! [idea] idea.capture.overlay_visible
//! ```
//!
//! Dismissal: Escape hides the overlay and captures nothing; pressing the
//! chord again while visible also hides it. Escape is delivered by registering
//! a global `Escape` shortcut only while the overlay is visible (the window is
//! non-focusable, so the webview itself never receives key events), and
//! unregistering it on hide so other apps get Escape back.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

use hq_desktop_core::ideas::{
    create_record, mark_cited, model_extract_url, parse_mode, reindex_after_write, run_model_stage,
    CaptureImage, ExtractionMode, HttpModelExtractor, IdeasError, NewCapture, Provenance, QmdCli,
    TokenProvider, EXTRACTION_MODE_SETTING, MODEL_DISCLOSURE,
};
use hq_platform::screenshot::{self, CaptureRegion, FrontmostSnapshot};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::util::logfile::log;

/// Log tag; the bench parses `[idea]` lines only.
pub const LOG_TAG: &str = "idea";
/// Mark: the chord was received (written before any main-thread hop).
pub const MARK_CHORD: &str = "idea.capture.chord";
/// Mark: the overlay window `show()` returned Ok.
pub const MARK_OVERLAY_VISIBLE: &str = "idea.capture.overlay_visible";
/// Mark: the overlay was hidden without a capture (`reason=escape|chord|command`).
pub const MARK_OVERLAY_HIDDEN: &str = "idea.capture.overlay_hidden";
/// Mark: the drag was released (written before any main-thread hop). Paired
/// with [`MARK_PNG_WRITTEN`] by the bench to score the release->PNG budget.
pub const MARK_RELEASE: &str = "idea.capture.release";
/// Mark: `create_record` wrote `image.png` (` path=<abs path>`).
pub const MARK_PNG_WRITTEN: &str = "idea.capture.png_written";
/// Mark: a release carried a degenerate rect (`reason=empty`) — a click, not a drag.
pub const MARK_RELEASE_REJECTED: &str = "idea.capture.release_rejected";
/// Mark: the capture could not be stored (` reason=...`).
pub const MARK_CAPTURE_FAILED: &str = "idea.capture.failed";
/// Mark: Screen Recording permission is missing, so no overlay was shown.
pub const MARK_PERMISSION_DENIED: &str = "idea.capture.permission_denied";

/// Window label — kept in sync with the `main.ts` router branch and
/// `capabilities/capture-overlay.json`.
pub const WINDOW_LABEL: &str = "capture-overlay";

/// Frontend events.
pub const EVENT_SHOWN: &str = "capture-overlay:shown";
pub const EVENT_HIDDEN: &str = "capture-overlay:hidden";
/// App-wide event carrying the stored `CaptureRecord` JSON (US-005 toast).
pub const EVENT_CAPTURE_COMPLETED: &str = "capture:completed";
/// App-wide event carrying a *revised* `CaptureRecord` JSON after each
/// enrichment stage (OCR, local extraction, opt-in model refinement).
pub const EVENT_CAPTURE_UPDATED: &str = "capture:updated";

/// menubar.json key backing [`EXTRACTION_MODE_SETTING`].
pub const IDEAS_EXTRACTION_MODE_KEY: &str = "ideasExtractionMode";

/// Analytics mark written when a user opts into model extraction.
pub const MARK_MODEL_ENABLED: &str = "idea.extraction.model_enabled";

/// Banner contract for the missing-permission prompt. The frontend
/// (`App.svelte`) routes `payload.kind === "capture"` /
/// `action_id === "open-settings"` to
/// `invoke('permissions_open_settings', { permission: 'screen-capture' })`.
pub const BANNER_KIND: &str = "capture";
/// Action id on both the chip and the body click of that banner.
pub const BANNER_ACTION_OPEN_SETTINGS: &str = "open-settings";

/// Human label for the chord, used in log lines.
pub const CHORD_LABEL: &str = "Opt+Shift+C";

/// Tracks visibility without a window round-trip so the chord toggle and the
/// Escape shortcut agree even while a show/hide is in flight.
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);

/// The `DisplayRect` the overlay was last shown on. The frontend hands us a
/// selection in *overlay-window* coordinates; this is the origin that turns it
/// back into a global rect.
static SHOWN_DISPLAY: Mutex<Option<DisplayRect>> = Mutex::new(None);

/// Frontmost-app *snapshot* taken in `show_overlay` **before** the overlay
/// appears. Once the overlay is on screen it is itself frontmost, so sampling
/// at capture time would always say "HQ".
///
/// Only the cheap half (pid + app name) is read here; the window title and the
/// accessibility URL lookup are resolved on the capture thread
/// (`screenshot::resolve_frontmost`), because they enumerate every on-screen
/// window and round-trip into another process — work that would blow the 80ms
/// chord->overlay budget and can block the main thread outright when the
/// target app is not answering.
static PENDING_PROVENANCE: Mutex<Option<FrontmostSnapshot>> = Mutex::new(None);

/// The overlay's native window number (macOS `NSWindow.windowNumber`), read on
/// the main thread at show time. `CGWindowListCreateImage` uses it to capture
/// everything *below* the overlay, so the dimmed sheet is excluded without
/// waiting for the hide to land. 0 = unknown (fall back to a display grab).
static OVERLAY_WINDOW_NUMBER: AtomicU32 = AtomicU32::new(0);

/// The capture chord: ⌥⇧C.
pub fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyC)
}

/// Escape, registered only while the overlay is visible.
pub fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// What a chord press should do given the current overlay state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayAction {
    Show,
    Hide,
}

/// Chord while hidden shows; chord while visible hides (captures nothing).
pub fn next_action(visible: bool) -> OverlayAction {
    if visible {
        OverlayAction::Hide
    } else {
        OverlayAction::Show
    }
}

/// A display rectangle in **logical** points (virtual-desktop coordinates),
/// plus its scale factor. Logical is the one space where a cursor point and a
/// monitor frame can be compared on mixed-DPI setups, and it is what tao's
/// `set_position` / `set_size` apply without re-scaling by the window's
/// *current* screen (see `widget.rs`, which is logical throughout).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

impl DisplayRect {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Pick the display containing the cursor. Falls back to `primary`, then the
/// first display. Returns `None` only when there are no displays at all.
pub fn display_for_cursor(
    displays: &[DisplayRect],
    cursor: Option<(f64, f64)>,
    primary: Option<DisplayRect>,
) -> Option<DisplayRect> {
    if let Some((cx, cy)) = cursor {
        if let Some(hit) = displays.iter().find(|d| d.contains(cx, cy)) {
            return Some(*hit);
        }
    }
    primary.or_else(|| displays.first().copied())
}

/// Convert a raw `cursor_position()` reading to logical points.
///
/// tao reports the cursor scaled by the *primary* monitor's scale factor on
/// macOS (`NSEvent.mouseLocation` × primary scale) and as raw device pixels on
/// Windows, where the virtual desktop is itself in device pixels. Dividing by
/// the primary scale recovers logical points on macOS; on Windows monitors are
/// compared in the same device-pixel space so the divisor is 1.
pub fn cursor_to_logical(raw: (f64, f64), primary_scale: f64) -> (f64, f64) {
    let divisor = if cfg!(target_os = "macos") && primary_scale > 0.0 {
        primary_scale
    } else {
        1.0
    };
    (raw.0 / divisor, raw.1 / divisor)
}

/// A selection rectangle in the overlay window's own logical coordinate
/// space (origin = overlay top-left), already normalized by the frontend so
/// `width`/`height` are non-negative.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Turn an overlay-local selection into a global capture rect, clamped to the
/// display the overlay covers.
///
/// Returns `None` for a degenerate rect — a click with no drag, which the
/// frontend treats as "cancel", not "capture a 0x0 image".
pub fn selection_to_global(display: &DisplayRect, sel: &SelectionRect) -> Option<CaptureRegion> {
    let left = (display.x + sel.x).max(display.x);
    let top = (display.y + sel.y).max(display.y);
    let right = (display.x + sel.x + sel.width).min(display.x + display.w);
    let bottom = (display.y + sel.y + sel.height).min(display.y + display.h);
    let w = right - left;
    let h = bottom - top;
    if w < 1.0 || h < 1.0 {
        return None;
    }
    Some(CaptureRegion { x: left, y: top, w, h })
}

/// Should the overlay be shown, given the Screen Recording preflight and a
/// one-shot request?
///
/// Pure so the (untestable-in-CI) TCC behaviour stays out of the decision:
/// preflight true -> show without prompting; preflight false -> prompt once,
/// and only show if the prompt actually granted. `request` is never called
/// when preflight already passed.
pub fn permission_gate(preflight: bool, request: impl FnOnce() -> bool) -> bool {
    if preflight {
        return true;
    }
    request()
}

/// Platform wiring for [`permission_gate`]. Non-macOS has no Screen Recording
/// TCC gate, so `screen_capture_preflight` returns true there and no prompt is
/// ever shown.
fn screen_capture_allowed() -> bool {
    permission_gate(
        hq_platform::permissions::screen_capture_preflight(),
        hq_platform::permissions::request_screen_capture_access,
    )
}

/// One-line prompt shown when Screen Recording is still denied after the
/// system request. Spawned (not awaited) so the chord path never blocks.
fn prompt_for_screen_recording(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let payload = crate::commands::banner::BannerPayload {
            kind: BANNER_KIND.to_string(),
            title: "Screen Recording".to_string(),
            body: "HQ needs Screen Recording permission to capture ideas. Open System \
Settings › Privacy & Security › Screen Recording and enable HQ."
                .to_string(),
            icon_text: Some("●".to_string()),
            action_label: Some("Open Settings".to_string()),
            action_id: Some(BANNER_ACTION_OPEN_SETTINGS.to_string()),
            click_action_id: BANNER_ACTION_OPEN_SETTINGS.to_string(),
            data: serde_json::json!({ "permission": "screen-capture" }),
        };
        if let Err(e) = crate::commands::banner::show_banner(app, payload).await {
            log(LOG_TAG, &format!("permission banner FAILED: {e}"));
        }
    });
}

fn monitor_rect(m: &tauri::Monitor) -> DisplayRect {
    let scale = m.scale_factor();
    // On Windows keep device pixels (matches the cursor space, see
    // `cursor_to_logical`); on macOS convert to points.
    let divisor = if cfg!(target_os = "macos") { scale } else { 1.0 };
    DisplayRect {
        x: m.position().x as f64 / divisor,
        y: m.position().y as f64 / divisor,
        w: m.size().width as f64 / divisor,
        h: m.size().height as f64 / divisor,
        scale,
    }
}

/// Resolve the display under the cursor via Tauri's monitor APIs.
fn target_display(app: &AppHandle) -> Option<DisplayRect> {
    let primary = app.primary_monitor().ok().flatten().map(|m| monitor_rect(&m));
    let primary_scale = primary.map(|p| p.scale).unwrap_or(1.0);
    let cursor = app
        .cursor_position()
        .ok()
        .map(|p| cursor_to_logical((p.x, p.y), primary_scale));
    let displays: Vec<DisplayRect> = app
        .available_monitors()
        .ok()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    display_for_cursor(&displays, cursor, primary)
}

/// Position/size the overlay window to cover `d`.
fn cover_display(window: &tauri::WebviewWindow, d: &DisplayRect) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_position(tauri::LogicalPosition::new(d.x, d.y));
        let _ = window.set_size(tauri::LogicalSize::new(d.w, d.h));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(d.x as i32, d.y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(d.w as u32, d.h as u32));
    }
}

/// Build the hidden overlay window at app start (idempotent).
pub fn setup_capture_overlay_window(app: &AppHandle) {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        log(LOG_TAG, "overlay setup: window already exists");
        return;
    }
    OVERLAY_VISIBLE.store(false, Ordering::SeqCst);

    // Pre-size to the primary display so the first show only has to move.
    let initial = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| monitor_rect(&m))
        .unwrap_or(DisplayRect { x: 0.0, y: 0.0, w: 1440.0, h: 900.0, scale: 1.0 });

    let build = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("HQ Capture")
    .inner_size(initial.w, initial.h)
    .position(initial.x, initial.y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    // Non-activating: showing must never steal focus from the user's app.
    .focusable(false)
    .accept_first_mouse(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .build();

    let window = match build {
        Ok(w) => w,
        Err(e) => {
            log(LOG_TAG, &format!("overlay setup: WebviewWindowBuilder FAILED: {e}"));
            return;
        }
    };

    // Clear WKWebView's underPageBackgroundColor so the transparent page does
    // not sit on a system-gray sheet (same idiom as widget.rs / banner.rs).
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: with_webview runs on the main thread; `inner()` is the
            // live WKWebView; selectors are public AppKit/WebKit.
            unsafe {
                let wk = webview.inner() as *mut AnyObject;
                let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![wk, setUnderPageBackgroundColor: clear];
            }
        });
    }

    log(
        LOG_TAG,
        &format!(
            "overlay setup: pre-rendered hidden window {}x{} @ ({}, {}) scale={}",
            initial.w, initial.h, initial.x, initial.y, initial.scale
        ),
    );
}

/// Chord handler entry point. Writes the chord mark *before* marshalling to
/// the main thread so the bench measures the full user-perceived interval.
/// Safe to call from the global-shortcut callback thread.
pub fn on_capture_chord(app: &AppHandle) {
    let action = next_action(OVERLAY_VISIBLE.load(Ordering::SeqCst));
    match action {
        // Bare mark: this is the press the bench pairs with overlay_visible.
        OverlayAction::Show => log(LOG_TAG, MARK_CHORD),
        // Suffixed so log readers can tell the toggle apart. The bench keys on
        // the latest chord before an overlay_visible, so a hide-toggle (which is
        // never followed by overlay_visible without a fresh show chord) cannot
        // skew the chord->overlay interval.
        OverlayAction::Hide => log(LOG_TAG, &format!("{MARK_CHORD} action=hide")),
    }
    // Permission gate runs *before* the show hop: an overlay the user can
    // drag on but that can never produce an image is worse than no overlay.
    if action == OverlayAction::Show && !screen_capture_allowed() {
        log(LOG_TAG, MARK_PERMISSION_DENIED);
        prompt_for_screen_recording(app);
        return;
    }
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || match action {
        OverlayAction::Show => show_overlay(&app_main),
        OverlayAction::Hide => hide_overlay(&app_main, "chord"),
    });
}

/// Escape handler entry point (global shortcut, only registered while visible).
pub fn on_escape(app: &AppHandle) {
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || hide_overlay(&app_main, "escape"));
}

/// True when `shortcut` is the overlay's transient Escape binding and the
/// overlay is currently visible.
pub fn is_overlay_escape(shortcut: &Shortcut) -> bool {
    shortcut == &escape_shortcut() && OVERLAY_VISIBLE.load(Ordering::SeqCst)
}

/// What the main-thread reconciler should do to the transient Escape binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscapeBindingOp {
    Register,
    Unregister,
    Noop,
}

/// Decide the Escape binding from the **current** overlay state, not from
/// the state at the time a bind/unbind was requested.
///
/// A show and a fast hide each queue a main-thread task; if the tasks were
/// applied as "register" / "unregister" verbatim and the queue order were ever
/// inverted, a bare global Escape could stay registered while the overlay is
/// hidden, swallowing Escape system-wide. Re-deriving the op from
/// `overlay_visible` at apply time makes every task idempotent and
/// order-independent: the last task to run always leaves the binding matching
/// the overlay.
pub fn escape_binding_op(overlay_visible: bool, currently_registered: bool) -> EscapeBindingOp {
    match (overlay_visible, currently_registered) {
        (true, false) => EscapeBindingOp::Register,
        (false, true) => EscapeBindingOp::Unregister,
        _ => EscapeBindingOp::Noop,
    }
}

/// Single worker that serializes every Escape (un)bind request.
static ESCAPE_BINDING_QUEUE: OnceLock<Mutex<Sender<AppHandle>>> = OnceLock::new();

/// Reconcile the transient Escape binding with `OVERLAY_VISIBLE` **off the
/// shortcut callback's stack**.
///
/// `tauri-plugin-global-shortcut` invokes our handler while holding its
/// shortcuts mutex, and on macOS the hotkey event arrives on the main thread,
/// where `run_on_main_thread` executes closures inline. Calling
/// `register`/`unregister` from inside that closure re-locks the same mutex
/// and deadlocks the hotkey thread (observed: one chord, then silence).
/// Hopping through a helper thread makes the main-thread task go via the
/// event-loop proxy, so it runs after the handler returns and the lock drops.
///
/// Two guards keep show/hide races from leaving Escape bound while hidden:
///   1. all requests flow through **one** worker thread + channel, so their
///      main-thread tasks are enqueued in request order (spawning a thread per
///      call gave no such ordering);
///   2. the main-thread task ignores what was requested and applies
///      [`escape_binding_op`] against `OVERLAY_VISIBLE` as it is *now*.
fn defer_escape_binding(app: &AppHandle) {
    let queue = ESCAPE_BINDING_QUEUE.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<AppHandle>();
        std::thread::Builder::new()
            .name("hq-capture-escape-binding".into())
            .spawn(move || {
                for app in rx {
                    let app_main = app.clone();
                    let _ = app.run_on_main_thread(move || apply_escape_binding(&app_main));
                }
            })
            .expect("spawn escape-binding worker");
        Mutex::new(tx)
    });
    let sent = match queue.lock() {
        Ok(tx) => tx.send(app.clone()).is_ok(),
        Err(_) => false,
    };
    if !sent {
        log(LOG_TAG, "escape binding: worker queue unavailable, applying inline");
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || apply_escape_binding(&app_main));
    }
}

/// MAIN THREAD ONLY. Make the global Escape registration match the overlay.
fn apply_escape_binding(app: &AppHandle) {
    let gs = app.global_shortcut();
    let visible = OVERLAY_VISIBLE.load(Ordering::SeqCst);
    let registered = gs.is_registered(escape_shortcut());
    match escape_binding_op(visible, registered) {
        EscapeBindingOp::Register => {
            if let Err(e) = gs.register(escape_shortcut()) {
                log(LOG_TAG, &format!("overlay show: Escape register FAILED: {e}"));
            }
        }
        EscapeBindingOp::Unregister => {
            if let Err(e) = gs.unregister(escape_shortcut()) {
                log(LOG_TAG, &format!("overlay hide: Escape unregister FAILED: {e}"));
            }
        }
        EscapeBindingOp::Noop => {}
    }
}

/// MAIN THREAD ONLY. Move the pre-rendered window onto the cursor's display
/// and show it.
fn show_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        log(LOG_TAG, "overlay show: window missing (setup failed?)");
        return;
    };
    // Provenance must be sampled before the overlay takes the screen. Cheap
    // half only — see PENDING_PROVENANCE.
    if let Ok(mut slot) = PENDING_PROVENANCE.lock() {
        *slot = Some(screenshot::frontmost_snapshot());
    }
    OVERLAY_WINDOW_NUMBER.store(overlay_window_number(&window), Ordering::SeqCst);
    if let Some(d) = target_display(app) {
        cover_display(&window, &d);
        if let Ok(mut slot) = SHOWN_DISPLAY.lock() {
            *slot = Some(d);
        }
        let _ = app.emit_to(
            WINDOW_LABEL,
            EVENT_SHOWN,
            serde_json::json!({
                "display": { "x": d.x, "y": d.y, "width": d.w, "height": d.h, "scale": d.scale }
            }),
        );
    } else {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOWN, serde_json::json!({ "display": null }));
    }
    match window.show() {
        Ok(()) => {
            OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
            log(LOG_TAG, MARK_OVERLAY_VISIBLE);
            defer_escape_binding(app);
        }
        Err(e) => log(LOG_TAG, &format!("overlay show FAILED: {e}")),
    }
}

/// MAIN THREAD ONLY. Hide the overlay without capturing anything.
pub fn hide_overlay(app: &AppHandle, reason: &str) {
    let was_visible = OVERLAY_VISIBLE.swap(false, Ordering::SeqCst);
    if was_visible {
        defer_escape_binding(app);
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if !was_visible {
        // Already hidden (e.g. the webview dismissed itself first): nothing to
        // do, and no redundant window op on the main thread.
        return;
    }
    if let Err(e) = window.hide() {
        log(LOG_TAG, &format!("overlay hide FAILED: {e}"));
        return;
    }
    log(LOG_TAG, &format!("{MARK_OVERLAY_HIDDEN} reason={reason}"));
    let _ = app.emit_to(WINDOW_LABEL, EVENT_HIDDEN, serde_json::json!({ "reason": reason }));
}

/// Frontend handshake: the overlay webview mounted its listeners.
#[tauri::command]
pub fn capture_overlay_ready() -> Result<(), String> {
    log(LOG_TAG, "overlay webview ready");
    Ok(())
}

/// Frontend-initiated dismiss (e.g. a keydown that did reach the webview).
#[tauri::command]
pub async fn dismiss_capture_overlay(app: AppHandle) -> Result<(), String> {
    let app_main = app.clone();
    app.run_on_main_thread(move || hide_overlay(&app_main, "command"))
        .map_err(|e| e.to_string())
}

/// MAIN THREAD ONLY. The overlay's native window number, or 0 when it can't
/// be determined (non-macOS, or a handle we can't reach).
#[allow(unused_variables)]
fn overlay_window_number(window: &tauri::WebviewWindow) -> u32 {
    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, runtime::AnyObject};
        if let Ok(ns_win) = window.ns_window() {
            if !ns_win.is_null() {
                // SAFETY: called on the main thread with a live NSWindow;
                // `windowNumber` is a public AppKit accessor returning NSInteger.
                let number: i64 = unsafe { msg_send![ns_win as *mut AnyObject, windowNumber] };
                if number > 0 {
                    return number as u32;
                }
            }
        }
    }
    0
}

/// Company slugs from `{hq_root}/companies/manifest.yaml`, in file order.
fn parse_manifest_slugs(yaml: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Manifest {
        companies: Option<serde_yaml::Mapping>,
    }
    serde_yaml::from_str::<Manifest>(yaml)
        .ok()
        .and_then(|m| m.companies)
        .map(|map| {
            map.keys()
                .filter_map(|k| k.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn read_manifest_slugs(hq_root: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(hq_root.join("companies").join("manifest.yaml"))
        .map(|c| parse_manifest_slugs(&c))
        .unwrap_or_default()
}

/// Pick the company a capture is filed under.
///
/// Precedence: the desktop session's ACTIVE company (when its dir exists) >
/// `config.json`'s slug (except the `personal` placeholder when the manifest
/// offers a real company) > the first manifest company whose dir exists > the
/// first manifest company > nothing.
pub fn pick_company_slug(
    active: Option<&str>,
    config_slug: Option<&str>,
    manifest_slugs: &[String],
    dir_exists: impl Fn(&str) -> bool,
) -> Option<String> {
    if let Some(a) = active.map(str::trim).filter(|s| !s.is_empty()) {
        if dir_exists(a) {
            return Some(a.to_string());
        }
    }
    if let Some(c) = config_slug.map(str::trim).filter(|s| !s.is_empty()) {
        let placeholder = c == "personal" && manifest_slugs.iter().any(|s| dir_exists(s));
        if !placeholder {
            return Some(c.to_string());
        }
    }
    if let Some(s) = manifest_slugs.iter().find(|s| dir_exists(s)) {
        return Some(s.clone());
    }
    manifest_slugs.first().cloned()
}

/// Resolve `(hq_root, company_slug)`. The hq root follows `get_config`
/// (menubar override wins, then `config.json`'s `hqFolderPath`); the company
/// is resolved by `pick_company_slug`, so menubar-only installs with no
/// `config.json` still file captures against the active/manifest company.
fn resolve_vault_target(app: &AppHandle) -> Result<(std::path::PathBuf, String), String> {
    let active = app
        .try_state::<crate::commands::desktop_alt::DesktopSessionScope>()
        .and_then(|s| s.active_company_slug());
    resolve_vault_target_with_active(active)
}

/// The AppHandle-free core of [`resolve_vault_target`].
///
/// Split out so the CLI bridge (which runs before Tauri is initialized and has
/// no AppHandle at all) resolves the vault exactly the way the GUI does,
/// passing `active = None` because there is no desktop session.
pub fn resolve_vault_target_with_active(
    active: Option<String>,
) -> Result<(std::path::PathBuf, String), String> {
    let menubar_path = hq_desktop_core::paths::menubar_json_path()?;
    let menubar_override = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|c| serde_json::from_str::<hq_desktop_core::config::MenubarPrefs>(&c).ok())
            .and_then(|p| p.hq_path)
    } else {
        None
    };
    let config = hq_desktop_core::config::read_hq_config_lenient()
        .ok()
        .flatten();
    let hq_root = hq_desktop_core::paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_override.as_deref(),
    );

    let config_slug = config.as_ref().map(|c| c.company_slug.clone());
    let manifest_slugs = read_manifest_slugs(&hq_root);
    let companies_dir = hq_root.join("companies");

    let slug = pick_company_slug(
        active.as_deref(),
        config_slug.as_deref(),
        &manifest_slugs,
        |s| companies_dir.join(s).is_dir(),
    )
    .ok_or_else(|| "unconfigured".to_string())?;

    let source = if Some(slug.as_str()) == active.as_deref() {
        "active"
    } else if Some(slug.as_str()) == config_slug.as_deref() {
        "config"
    } else {
        "manifest"
    };
    log(LOG_TAG, &format!("idea.capture.target company={slug} source={source}"));
    Ok((hq_root, slug))
}

/// Background half of the capture: grab pixels, store the record, mark, emit.
/// Never panics; every failure becomes an `idea.capture.failed` line.
fn capture_and_store(app: &AppHandle, region: CaptureRegion, exclude_window: Option<u32>) {
    let snapshot = PENDING_PROVENANCE
        .lock()
        .ok()
        .and_then(|mut s| s.take())
        .unwrap_or_default();

    // Pixels first: the release->png_written budget is the one the bench
    // scores, so nothing slower than the grab may run ahead of it.
    let shot = match screenshot::capture_region(&region, exclude_window) {
        Ok(s) => s,
        Err(e) => {
            log(LOG_TAG, &format!("{MARK_CAPTURE_FAILED} reason={e}"));
            return;
        }
    };
    // Now the slow half of provenance: window-title enumeration and the
    // accessibility URL round-trip, keyed by the pid saved before the overlay
    // appeared. Off the chord path and after the overlay is gone.
    let provenance_info = screenshot::resolve_frontmost(&snapshot);
    let Some(img) = image::RgbaImage::from_raw(shot.width, shot.height, shot.rgba) else {
        log(LOG_TAG, &format!("{MARK_CAPTURE_FAILED} reason=pixel_buffer_mismatch"));
        return;
    };
    let (hq_root, company_slug) = match resolve_vault_target(app) {
        Ok(v) => v,
        Err(e) => {
            log(LOG_TAG, &format!("{MARK_CAPTURE_FAILED} reason=unconfigured detail={e}"));
            return;
        }
    };
    let provenance = Provenance {
        app: provenance_info.app,
        window_title: provenance_info.window_title,
        url: provenance_info.url,
        captured_at: chrono::Utc::now(),
        display_id: screenshot::display_id_for_point(region.x, region.y),
    };
    let new = NewCapture::pending(
        company_slug,
        CaptureImage::Decoded(image::DynamicImage::ImageRgba8(img)),
        provenance,
    );
    match create_record(&hq_root, new) {
        Ok(record) => {
            let path = hq_root.join(&record.image_path);
            log(
                LOG_TAG,
                &format!("{MARK_PNG_WRITTEN} path={}", path.to_string_lossy()),
            );
            // US-006 extraction hook: after png_written, never before.
            match serde_json::to_value(&record) {
                Ok(json) => {
                    let _ = app.emit(EVENT_CAPTURE_COMPLETED, json);
                }
                Err(e) => log(LOG_TAG, &format!("capture record serialize FAILED: {e}")),
            }
            spawn_enrichment(app.clone(), hq_root, record.company_slug.clone(), record.id.clone());
        }
        Err(e) => log(LOG_TAG, &format!("{MARK_CAPTURE_FAILED} reason=store detail={e}")),
    }
}

/// Drag released: capture exactly the selected region.
///
/// `selection` is in the overlay window's logical coordinate space (top-left
/// origin), already normalized by the frontend. The overlay is hidden
/// immediately and the pixel grab + PNG encode run off the main thread, so the
/// user's screen is clear before any encoding starts.
#[tauri::command]
pub async fn capture_region_release(app: AppHandle, selection: SelectionRect) -> Result<(), String> {
    // Bare mark, first statement: the bench pairs this with png_written.
    log(LOG_TAG, MARK_RELEASE);

    let display = SHOWN_DISPLAY
        .lock()
        .ok()
        .and_then(|d| *d)
        .ok_or_else(|| "no display recorded for the overlay".to_string())?;
    let Some(region) = selection_to_global(&display, &selection) else {
        log(LOG_TAG, &format!("{MARK_RELEASE_REJECTED} reason=empty"));
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || hide_overlay(&app_main, "click"));
        return Err("empty selection".to_string());
    };
    let exclude = match OVERLAY_WINDOW_NUMBER.load(Ordering::SeqCst) {
        0 => None,
        n => Some(n),
    };

    let app_main = app.clone();
    app.run_on_main_thread(move || hide_overlay(&app_main, "release"))
        .map_err(|e| e.to_string())?;

    let app_bg = app.clone();
    std::thread::spawn(move || capture_and_store(&app_bg, region, exclude));
    Ok(())
}

// ---------------------------------------------------------------------------
// US-008: opt-in model extraction setting + the post-capture enrichment chain
// ---------------------------------------------------------------------------

/// What the settings UI needs to render the extraction-mode control.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeasExtractionSettings {
    /// `"local"` or `"model"`.
    pub mode: String,
    /// Plain-language statement of what turning this on does.
    pub disclosure: String,
    /// The setting's canonical key.
    pub setting: String,
}

impl IdeasExtractionSettings {
    fn of(mode: ExtractionMode) -> Self {
        IdeasExtractionSettings {
            mode: mode.as_str().to_string(),
            disclosure: MODEL_DISCLOSURE.to_string(),
            setting: EXTRACTION_MODE_SETTING.to_string(),
        }
    }
}

/// Read the extraction mode out of a menubar.json at `path`.
///
/// A missing, unreadable, non-JSON, or unrecognized value is
/// [`ExtractionMode::Local`] — the private, free default. Opting in is only
/// ever the result of an explicit `"model"` on disk.
pub fn read_extraction_mode_from(path: &std::path::Path) -> ExtractionMode {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| {
            v.get(IDEAS_EXTRACTION_MODE_KEY)
                .and_then(|m| m.as_str())
                .map(parse_mode)
        })
        .unwrap_or_default()
}

/// The extraction mode for this install.
fn current_extraction_mode() -> ExtractionMode {
    match crate::util::paths::menubar_json_path() {
        Ok(path) => read_extraction_mode_from(&path),
        Err(_) => ExtractionMode::Local,
    }
}

/// Does this mode send anything off the device?
fn should_run_model(mode: ExtractionMode) -> bool {
    mode == ExtractionMode::Model
}

/// Current extraction mode plus the disclosure copy the settings UI shows.
#[tauri::command]
pub async fn ideas_get_extraction_settings() -> Result<IdeasExtractionSettings, String> {
    Ok(IdeasExtractionSettings::of(current_extraction_mode()))
}

/// Persist the extraction mode. Only the two known spellings are accepted —
/// an unknown value is an error, never a silent opt-in.
#[tauri::command]
pub async fn ideas_set_extraction_mode(mode: String) -> Result<IdeasExtractionSettings, String> {
    let trimmed = mode.trim().to_ascii_lowercase();
    let parsed = match trimmed.as_str() {
        "local" => ExtractionMode::Local,
        "model" => ExtractionMode::Model,
        other => return Err(format!(
            "unknown {EXTRACTION_MODE_SETTING} value {other:?} (expected \"local\" or \"model\")"
        )),
    };
    let path = crate::util::paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(
            IDEAS_EXTRACTION_MODE_KEY,
            serde_json::Value::String(parsed.as_str().to_string()),
        )],
    )?;
    if should_run_model(parsed) {
        log(LOG_TAG, MARK_MODEL_ENABLED);
    }
    Ok(IdeasExtractionSettings::of(parsed))
}

/// Build the authenticated model extractor for this install.
fn build_model_extractor() -> Result<HttpModelExtractor, String> {
    let base = crate::commands::sync::resolve_vault_api_url()?;
    let token: TokenProvider = std::sync::Arc::new(|| {
        Box::pin(async { crate::commands::cognito::get_valid_access_token().await })
    });
    Ok(HttpModelExtractor::new(
        hq_desktop_core::client_info::build_client(),
        model_extract_url(&base),
        token,
    ))
}

/// Run the post-capture enrichment chain off the capture thread: OCR, then
/// local extraction, then (only when opted in) model refinement.
///
/// Every stage is best-effort. Failures are logged and nothing is surfaced to
/// the user — the image is the artifact, the structure is a bonus. Each stage
/// that produces a revised record emits [`EVENT_CAPTURE_UPDATED`] so a live
/// toast can refresh in place.
fn spawn_enrichment(app: AppHandle, hq_root: std::path::PathBuf, company_slug: String, id: String) {
    tauri::async_runtime::spawn(async move {
        let emit =
            |record: &hq_desktop_core::ideas::CaptureRecord| match serde_json::to_value(record) {
                Ok(json) => {
                    let _ = app.emit(EVENT_CAPTURE_UPDATED, json);
                }
                Err(e) => log(LOG_TAG, &format!("capture update serialize FAILED: {e}")),
            };

        let lines = match hq_platform::ocr::ocr_only_record(&hq_root, &company_slug, &id).await {
            Ok((record, lines)) => {
                emit(&record);
                lines
            }
            Err(e) => {
                log(LOG_TAG, &format!("ocr stage failed for record {id}: {e}"));
                Vec::new()
            }
        };

        match hq_platform::ocr::extract_record(&hq_root, &company_slug, &id, lines).await {
            Ok(record) => emit(&record),
            Err(e) => log(
                LOG_TAG,
                &format!("extraction stage failed for record {id}: {e}"),
            ),
        }

        // The optional model stage. Deliberately *not* written with early
        // `return`s: `spawn_reindex` below must run on every path out of this
        // task — the model stage is off by default, so an early return here
        // would mean the common capture is never re-indexed.
        let mode = current_extraction_mode();
        if should_run_model(mode) {
            match build_model_extractor() {
                Ok(extractor) => {
                    match run_model_stage(&hq_root, &company_slug, &id, mode, &extractor).await {
                        Ok(record) => emit(&record),
                        Err(e) => {
                            log(LOG_TAG, &format!("model stage failed for record {id}: {e}"))
                        }
                    }
                }
                Err(e) => log(
                    LOG_TAG,
                    &format!("model stage unavailable for record {id}: {e}"),
                ),
            }
        }

        // Unconditional: `capture.md` was written by `create_record` and
        // refreshed by each enrichment stage, so the index owes a refresh
        // whether or not the model stage ran.
        spawn_reindex(id);
    });
}

/// Best-effort qmd refresh after the enrichment chain has settled, so the new
/// `capture.md` becomes searchable.
///
/// Never runs on the capture thread and never blocks the async runtime:
/// `qmd update` is a synchronous subprocess, so it goes to `spawn_blocking`.
/// A missing `qmd` is a no-op, not an error — indexing is a bonus, the record
/// is the artifact.
fn spawn_reindex(id: String) {
    let Some(indexer) = QmdCli::detect() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || reindex_after_write(&indexer, &id));
}

// ---------------------------------------------------------------------------
// US-011: citation counter (Tauri command + local CLI bridge for HQ skills)
// ---------------------------------------------------------------------------

/// Result of a successful citation: enough for the caller to know *which*
/// company's record moved, since an agent cites by id alone.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeasCitation {
    pub id: String,
    pub company_slug: String,
    pub cited_count: u32,
}

/// Increment a capture's citation count, searching across companies by id.
///
/// HQ skills cite a capture by id without knowing which company it was filed
/// under, so a `NotFound` in `preferred_slug` falls back to scanning the
/// manifest's companies. The scan only ever *reads* `record.json` paths under
/// `companies/{slug}/ideas/{id}/`; the write still goes through the core,
/// which screens both components, so nothing can be written outside that
/// directory.
pub fn mark_cited_in_vault(
    hq_root: &std::path::Path,
    preferred_slug: &str,
    id: &str,
) -> Result<IdeasCitation, String> {
    let citation = |record: hq_desktop_core::ideas::CaptureRecord| IdeasCitation {
        id: record.id,
        company_slug: record.company_slug,
        cited_count: record.cited_count,
    };

    match mark_cited(hq_root, preferred_slug, id) {
        Ok(record) => return Ok(citation(record)),
        // Anything other than "this company doesn't have it" is a real error —
        // an invalid id must not silently trigger a cross-company scan.
        Err(IdeasError::NotFound { .. }) => {}
        Err(e) => return Err(e.to_string()),
    }

    for slug in read_manifest_slugs(hq_root) {
        if slug == preferred_slug {
            continue;
        }
        match mark_cited(hq_root, &slug, id) {
            Ok(record) => return Ok(citation(record)),
            Err(IdeasError::NotFound { .. }) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!("capture {id} not found in any company"))
}

/// Record that an agent cited a capture. Bumps `cited_count` in both
/// `record.json` and `capture.md`.
#[tauri::command]
pub async fn ideas_mark_cited(app: AppHandle, id: String) -> Result<IdeasCitation, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    mark_cited_in_vault(&hq_root, &slug, &id)
}

/// The CLI flag HQ skills use to cite a capture without the GUI.
pub const IDEAS_MARK_CITED_FLAG: &str = "--ideas-mark-cited";

/// Pull the capture id out of `--ideas-mark-cited <id>` or
/// `--ideas-mark-cited=<id>`, or `None` when this argv is not a citation run.
///
/// An empty value (`--ideas-mark-cited=`) is not a citation request — it would
/// otherwise become an id of `""` and fail deep inside the core.
pub fn ideas_mark_cited_id_from_argv<S: AsRef<str>>(argv: &[S]) -> Option<String> {
    let mut iter = argv.iter().map(|a| a.as_ref());
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix(&format!("{IDEAS_MARK_CITED_FLAG}=")) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
            return None;
        }
        if arg == IDEAS_MARK_CITED_FLAG {
            return iter.next().filter(|v| !v.is_empty()).map(|v| v.to_string());
        }
    }
    None
}

/// Run the citation as a one-shot CLI and exit. Never returns.
///
/// The process exit lives here rather than in `main.rs` because
/// `scripts/native-seam-wiring.test.ts` pins the set of `process::exit` calls
/// in `main.rs`; `main.rs` only performs the dispatch.
pub fn run_ideas_mark_cited_cli_main(id: &str) -> ! {
    use std::io::Write as _;
    let result = resolve_vault_target_with_active(None)
        .and_then(|(hq_root, slug)| mark_cited_in_vault(&hq_root, &slug, id))
        .and_then(|citation| {
            serde_json::to_string(&citation).map_err(|e| format!("serialize failed: {e}"))
        });
    match result {
        Ok(line) => {
            println!("{line}");
            // `process::exit` skips end-of-run flushing and the caller parses
            // this single line off stdout.
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("ideas-mark-cited failed: {error}");
            let _ = std::io::stderr().flush();
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod hq_idea_board_capture_tests {
    use super::*;

    fn d(x: f64, y: f64, w: f64, h: f64) -> DisplayRect {
        DisplayRect { x, y, w, h, scale: 2.0 }
    }

    #[test]
    fn hq_idea_board_mark_cited_flag_is_parsed_in_both_spellings() {
        assert_eq!(
            ideas_mark_cited_id_from_argv(&["hq-sync", "--ideas-mark-cited", "01JABC"]),
            Some("01JABC".to_string())
        );
        assert_eq!(
            ideas_mark_cited_id_from_argv(&["hq-sync", "--ideas-mark-cited=01JABC"]),
            Some("01JABC".to_string())
        );
        // Unrelated argv is left alone.
        assert_eq!(
            ideas_mark_cited_id_from_argv(&["hq-sync", "--sync-cancel-probe"]),
            None
        );
        assert_eq!(ideas_mark_cited_id_from_argv::<&str>(&[]), None);
        // A flag with no value is not a citation request.
        assert_eq!(
            ideas_mark_cited_id_from_argv(&["hq-sync", "--ideas-mark-cited"]),
            None
        );
        assert_eq!(
            ideas_mark_cited_id_from_argv(&["hq-sync", "--ideas-mark-cited="]),
            None
        );
    }

    #[test]
    fn hq_idea_board_mark_cited_falls_back_across_manifest_companies() {
        use hq_desktop_core::ideas::{
            create_record, load_record, CaptureImage, NewCapture,
        };

        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        std::fs::create_dir_all(hq_root.join("companies/alpha")).unwrap();
        std::fs::create_dir_all(hq_root.join("companies/beta")).unwrap();
        std::fs::write(
            hq_root.join("companies/manifest.yaml"),
            "companies:\n  alpha:\n    name: Alpha\n  beta:\n    name: Beta\n",
        )
        .unwrap();

        let provenance = Provenance {
            app: "Safari".to_string(),
            window_title: "X".to_string(),
            url: None,
            captured_at: chrono::Utc::now(),
            display_id: 1,
        };
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(8, 8));
        // The record lives in beta, but the caller prefers alpha.
        let record = create_record(
            hq_root,
            NewCapture::pending("beta", CaptureImage::Decoded(image), provenance),
        )
        .unwrap();

        let citation = mark_cited_in_vault(hq_root, "alpha", &record.id).unwrap();
        assert_eq!(citation.company_slug, "beta");
        assert_eq!(citation.cited_count, 1);
        assert_eq!(citation.id, record.id);
        assert_eq!(
            load_record(hq_root, "beta", &record.id).unwrap().cited_count,
            1
        );

        // An id nobody has is an error, not a silent success.
        assert!(mark_cited_in_vault(hq_root, "alpha", "01JMISSING").is_err());
        // An id that cannot be a path component is rejected outright.
        assert!(mark_cited_in_vault(hq_root, "alpha", "../../etc").is_err());
    }

    #[test]
    fn hq_idea_board_extraction_mode_defaults_to_local_off_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("menubar.json");
        // Missing file.
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Local);
        // Not JSON.
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Local);
        // JSON without the key.
        std::fs::write(&path, r#"{"hqPath":"/tmp"}"#).unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Local);
        // Unrecognized value.
        std::fs::write(&path, r#"{"ideasExtractionMode":"bedrock"}"#).unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Local);
        // Explicit local.
        std::fs::write(&path, r#"{"ideasExtractionMode":"local"}"#).unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Local);
    }

    #[test]
    fn hq_idea_board_extraction_mode_opts_in_only_on_explicit_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("menubar.json");
        std::fs::write(&path, r#"{"ideasExtractionMode":"model"}"#).unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Model);
        std::fs::write(&path, r#"{"ideasExtractionMode":" Model "}"#).unwrap();
        assert_eq!(read_extraction_mode_from(&path), ExtractionMode::Model);
    }

    #[test]
    fn hq_idea_board_only_model_mode_leaves_the_device() {
        assert!(!should_run_model(ExtractionMode::Local));
        assert!(!should_run_model(ExtractionMode::default()));
        assert!(should_run_model(ExtractionMode::Model));
    }

    #[test]
    fn hq_idea_board_extraction_settings_carry_the_disclosure() {
        let s = IdeasExtractionSettings::of(ExtractionMode::Local);
        assert_eq!(s.mode, "local");
        assert_eq!(s.setting, "ideas.extraction_mode");
        assert!(s.disclosure.to_lowercase().contains("cost"));
        assert!(s.disclosure.to_lowercase().contains("leaves this device"));
        assert_eq!(
            IdeasExtractionSettings::of(ExtractionMode::Model).mode,
            "model"
        );
    }

    #[test]
    fn chord_toggles_between_show_and_hide() {
        assert_eq!(next_action(false), OverlayAction::Show);
        assert_eq!(next_action(true), OverlayAction::Hide);
    }

    #[test]
    fn chord_is_alt_shift_c_like_existing_hotkeys() {
        let s = capture_shortcut();
        assert!(s.matches(Modifiers::ALT | Modifiers::SHIFT, Code::KeyC));
        assert!(!s.matches(Modifiers::ALT | Modifiers::SHIFT, Code::KeyH));
        assert_ne!(
            s,
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyH)
        );
    }

    #[test]
    fn escape_shortcut_is_bare_escape() {
        let e = escape_shortcut();
        assert!(e.matches(Modifiers::empty(), Code::Escape));
        assert_ne!(e, capture_shortcut());
    }

    #[test]
    fn overlay_escape_only_counts_while_visible() {
        OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
        assert!(!is_overlay_escape(&escape_shortcut()));
        OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
        assert!(is_overlay_escape(&escape_shortcut()));
        assert!(!is_overlay_escape(&capture_shortcut()));
        OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
    }

    #[test]
    fn picks_display_under_cursor_on_multi_display() {
        let left = d(-2560.0, 0.0, 2560.0, 1440.0);
        let main = d(0.0, 0.0, 2880.0, 1800.0);
        let right = d(2880.0, -200.0, 1920.0, 1080.0);
        let displays = [left, main, right];
        assert_eq!(display_for_cursor(&displays, Some((-100.0, 10.0)), Some(main)), Some(left));
        assert_eq!(display_for_cursor(&displays, Some((10.0, 10.0)), Some(main)), Some(main));
        assert_eq!(display_for_cursor(&displays, Some((3000.0, -50.0)), Some(main)), Some(right));
        // Right edge is exclusive: x == 2880 belongs to `right`, not `main`.
        assert_eq!(display_for_cursor(&displays, Some((2880.0, 0.0)), Some(main)), Some(right));
    }

    #[test]
    fn falls_back_to_primary_then_first_display() {
        let a = d(0.0, 0.0, 100.0, 100.0);
        let b = d(100.0, 0.0, 100.0, 100.0);
        assert_eq!(display_for_cursor(&[a, b], Some((999.0, 999.0)), Some(b)), Some(b));
        assert_eq!(display_for_cursor(&[a, b], None, None), Some(a));
        assert_eq!(display_for_cursor(&[], None, None), None);
    }

    /// The marks must match what US-001's benchmark parses, byte for byte.
    #[test]
    fn marks_match_us001_bench_script() {
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/idea-board-bench.mjs");
        let src = std::fs::read_to_string(bench).expect("bench script exists");
        assert!(src.contains(&format!("chord: '{MARK_CHORD}'")), "chord mark drifted");
        assert!(
            src.contains(&format!("overlay: '{MARK_OVERLAY_VISIBLE}'")),
            "overlay mark drifted"
        );
        assert!(src.contains(&format!("release: '{MARK_RELEASE}'")), "release mark drifted");
        assert!(src.contains(&format!("png: '{MARK_PNG_WRITTEN}'")), "png mark drifted");
        assert_eq!(LOG_TAG, "idea", "bench documents [idea]-tagged lines");
    }

    #[test]
    fn cursor_scaling_matches_platform_contract() {
        let (x, y) = cursor_to_logical((2000.0, 1000.0), 2.0);
        if cfg!(target_os = "macos") {
            assert_eq!((x, y), (1000.0, 500.0));
        } else {
            assert_eq!((x, y), (2000.0, 1000.0));
        }
        // A zero/invalid scale never divides.
        assert_eq!(cursor_to_logical((10.0, 10.0), 0.0), (10.0, 10.0));
    }

    #[test]
    fn hq_idea_board_permission_gate_truth_table() {
        // Preflight granted: never prompt.
        assert!(permission_gate(true, || panic!("must not request when preflighted")));
        // Not granted, user grants at the prompt.
        assert!(permission_gate(false, || true));
        // Not granted and the prompt did not grant.
        assert!(!permission_gate(false, || false));
    }

    fn sel(x: f64, y: f64, w: f64, h: f64) -> SelectionRect {
        SelectionRect { x, y, width: w, height: h }
    }

    #[test]
    fn hq_idea_board_selection_maps_to_global_coordinates() {
        let display = DisplayRect { x: -2560.0, y: 100.0, w: 2560.0, h: 1440.0, scale: 2.0 };
        let r = selection_to_global(&display, &sel(10.0, 20.0, 100.0, 50.0)).expect("region");
        assert_eq!((r.x, r.y, r.w, r.h), (-2550.0, 120.0, 100.0, 50.0));
    }

    #[test]
    fn hq_idea_board_selection_is_clamped_to_the_display() {
        let display = DisplayRect { x: 0.0, y: 0.0, w: 800.0, h: 600.0, scale: 1.0 };
        // Overhangs the right/bottom edges.
        let r = selection_to_global(&display, &sel(700.0, 500.0, 400.0, 400.0)).expect("region");
        assert_eq!((r.x, r.y, r.w, r.h), (700.0, 500.0, 100.0, 100.0));
        // Negative origin (drag started off-window) clamps to the display.
        let r = selection_to_global(&display, &sel(-50.0, -50.0, 100.0, 100.0)).expect("region");
        assert_eq!((r.x, r.y, r.w, r.h), (0.0, 0.0, 50.0, 50.0));
    }

    #[test]
    fn hq_idea_board_empty_selection_is_rejected_not_captured() {
        let display = DisplayRect { x: 0.0, y: 0.0, w: 800.0, h: 600.0, scale: 1.0 };
        // A plain click.
        assert!(selection_to_global(&display, &sel(100.0, 100.0, 0.0, 0.0)).is_none());
        // A sub-pixel twitch.
        assert!(selection_to_global(&display, &sel(100.0, 100.0, 0.6, 40.0)).is_none());
        // Entirely off the display.
        assert!(selection_to_global(&display, &sel(900.0, 100.0, 50.0, 50.0)).is_none());
    }

    /// Escape/second-chord marks must not be mistaken for the visible mark by
    /// the bench's prefix matcher (`msg === name || msg.startsWith(name + ' ')`).
    #[test]
    fn hidden_mark_is_not_a_prefix_of_visible_mark() {
        assert!(!MARK_OVERLAY_HIDDEN.starts_with(&format!("{MARK_OVERLAY_VISIBLE} ")));
        assert_ne!(MARK_OVERLAY_HIDDEN, MARK_OVERLAY_VISIBLE);
    }

    /// The bench prefix-matches (`msg === name || msg.startsWith(name + ' ')`),
    /// so no other mark may be `release`/`png` with a suffix.
    #[test]
    fn hq_idea_board_failure_marks_are_not_prefixes_of_release_or_png_marks() {
        for other in [MARK_RELEASE_REJECTED, MARK_CAPTURE_FAILED, MARK_PERMISSION_DENIED] {
            for scored in [MARK_RELEASE, MARK_PNG_WRITTEN] {
                assert_ne!(other, scored);
                assert!(!other.starts_with(&format!("{scored} ")), "{other} shadows {scored}");
            }
        }
        // ...and release is not itself a space-prefix of release_rejected.
        assert!(!MARK_RELEASE_REJECTED.starts_with(&format!("{MARK_RELEASE} ")));
    }

    /// Ordering guard (review critical): a stale "bind" applied after the
    /// overlay was hidden must never register Escape, and a stale "unbind"
    /// applied after a re-show must never leave the overlay without Escape.
    /// The op is derived from current state only, so request order is moot.
    #[test]
    fn hq_idea_board_escape_binding_follows_current_visibility_not_request_order() {
        // Requested bind, but overlay already hidden again -> no bare Escape.
        assert_eq!(escape_binding_op(false, false), EscapeBindingOp::Noop);
        assert_eq!(escape_binding_op(false, true), EscapeBindingOp::Unregister);
        // Requested unbind, but overlay re-shown -> Escape must be bound.
        assert_eq!(escape_binding_op(true, false), EscapeBindingOp::Register);
        assert_eq!(escape_binding_op(true, true), EscapeBindingOp::Noop);
    }

    /// Applying the reconciler repeatedly in any interleaving converges: the
    /// final registration always equals the final visibility.
    #[test]
    fn hq_idea_board_escape_binding_is_idempotent_under_any_interleaving() {
        fn step(registered: bool, visible: bool) -> bool {
            match escape_binding_op(visible, registered) {
                EscapeBindingOp::Register => true,
                EscapeBindingOp::Unregister => false,
                EscapeBindingOp::Noop => registered,
            }
        }
        for &start in &[false, true] {
            for seq in [[true, false], [false, true], [true, true], [false, false]] {
                let mut reg = start;
                for &vis in &seq {
                    reg = step(reg, vis);
                    assert_eq!(reg, vis);
                }
                // A duplicate apply (two queued tasks for one state) is a no-op.
                assert_eq!(step(reg, seq[1]), seq[1]);
            }
        }
    }

    #[test]
    fn hq_idea_board_pick_company_prefers_active_when_dir_exists() {
        let manifest = vec!["indigo".to_string()];
        assert_eq!(
            pick_company_slug(Some("acme"), Some("indigo"), &manifest, |s| s == "acme"),
            Some("acme".to_string())
        );
    }

    #[test]
    fn hq_idea_board_pick_company_ignores_active_without_dir() {
        let manifest = vec!["indigo".to_string()];
        assert_eq!(
            pick_company_slug(Some("ghost"), Some("indigo"), &manifest, |s| s == "indigo"),
            Some("indigo".to_string())
        );
        // blank active is ignored too
        assert_eq!(
            pick_company_slug(Some("  "), None, &manifest, |s| s == "indigo"),
            Some("indigo".to_string())
        );
    }

    #[test]
    fn hq_idea_board_pick_company_falls_back_to_config_without_dir() {
        // config slug wins even when its dir is missing — create_record makes it.
        assert_eq!(
            pick_company_slug(None, Some("fresh"), &[], |_| false),
            Some("fresh".to_string())
        );
    }

    #[test]
    fn hq_idea_board_pick_company_skips_personal_placeholder() {
        let manifest = vec!["indigo".to_string()];
        assert_eq!(
            pick_company_slug(None, Some("personal"), &manifest, |s| s == "indigo"),
            Some("indigo".to_string())
        );
        // ...but keeps it when the manifest offers nothing real
        assert_eq!(
            pick_company_slug(None, Some("personal"), &manifest, |_| false),
            Some("personal".to_string())
        );
    }

    #[test]
    fn hq_idea_board_pick_company_first_manifest_slug_with_dir() {
        let manifest = vec!["old".to_string(), "indigo".to_string()];
        assert_eq!(
            pick_company_slug(None, None, &manifest, |s| s == "indigo"),
            Some("indigo".to_string())
        );
        // no dirs at all -> first manifest entry
        assert_eq!(
            pick_company_slug(None, None, &manifest, |_| false),
            Some("old".to_string())
        );
    }

    #[test]
    fn hq_idea_board_pick_company_empty_manifest_is_none() {
        assert_eq!(pick_company_slug(None, None, &[], |_| false), None);
    }

    #[test]
    fn hq_idea_board_manifest_parses_in_file_order_and_picks_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let companies = tmp.path().join("companies");
        std::fs::create_dir_all(companies.join("indigo")).unwrap();
        std::fs::write(
            companies.join("manifest.yaml"),
            "companies:\n  old:\n    cloud_uid: abc\n    name: Old\n  indigo:\n    cloud_uid: def\n    name: Indigo\n",
        )
        .unwrap();

        let slugs = read_manifest_slugs(tmp.path());
        assert_eq!(slugs, vec!["old".to_string(), "indigo".to_string()]);

        let picked = pick_company_slug(None, None, &slugs, |s| companies.join(s).is_dir());
        assert_eq!(picked, Some("indigo".to_string()));
    }

    #[test]
    fn hq_idea_board_manifest_missing_or_garbage_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_manifest_slugs(tmp.path()).is_empty());
        assert!(parse_manifest_slugs("::: not yaml [").is_empty());
        assert!(parse_manifest_slugs("other: 1\n").is_empty());
    }
}
