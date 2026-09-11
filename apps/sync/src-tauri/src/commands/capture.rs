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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

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

/// Window label — kept in sync with the `main.ts` router branch and
/// `capabilities/capture-overlay.json`.
pub const WINDOW_LABEL: &str = "capture-overlay";

/// Frontend events.
pub const EVENT_SHOWN: &str = "capture-overlay:shown";
pub const EVENT_HIDDEN: &str = "capture-overlay:hidden";

/// Human label for the chord, used in log lines.
pub const CHORD_LABEL: &str = "Opt+Shift+C";

/// Tracks visibility without a window round-trip so the chord toggle and the
/// Escape shortcut agree even while a show/hide is in flight.
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);

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
    if let Some(d) = target_display(app) {
        cover_display(&window, &d);
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

#[cfg(test)]
mod hq_idea_board_capture_tests {
    use super::*;

    fn d(x: f64, y: f64, w: f64, h: f64) -> DisplayRect {
        DisplayRect { x, y, w, h, scale: 2.0 }
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

    /// Escape/second-chord marks must not be mistaken for the visible mark by
    /// the bench's prefix matcher (`msg === name || msg.startsWith(name + ' ')`).
    #[test]
    fn hidden_mark_is_not_a_prefix_of_visible_mark() {
        assert!(!MARK_OVERLAY_HIDDEN.starts_with(&format!("{MARK_OVERLAY_VISIBLE} ")));
        assert_ne!(MARK_OVERLAY_HIDDEN, MARK_OVERLAY_VISIBLE);
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
}
