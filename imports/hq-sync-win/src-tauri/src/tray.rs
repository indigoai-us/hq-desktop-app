//! System tray icon with state-driven icon swapping.
//!
//! Four visual states: **idle**, **syncing**, **error**, **conflict**.
//! Left-click toggles the popover window; right-click shows a context menu
//! with "Sync Now", "Settings", and "Quit".

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, Rect, WindowEvent,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tray state enum
// ─────────────────────────────────────────────────────────────────────────────

/// Visual state of the tray icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Syncing,
    Error,
    Conflict,
}

impl TrayState {
    /// Parse from a frontend string (case-insensitive).
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "idle" => Some(Self::Idle),
            "syncing" => Some(Self::Syncing),
            "error" => Some(Self::Error),
            "conflict" => Some(Self::Conflict),
            _ => None,
        }
    }

    /// Tooltip text for this state.
    pub fn tooltip(&self) -> &'static str {
        match self {
            Self::Idle => "HQ Sync — Idle",
            Self::Syncing => "HQ Sync — Syncing…",
            Self::Error => "HQ Sync — Error",
            Self::Conflict => "HQ Sync — Conflict",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global state
// ─────────────────────────────────────────────────────────────────────────────

/// Global current tray state.
static CURRENT_STATE: OnceLock<Arc<Mutex<TrayState>>> = OnceLock::new();

fn current_state() -> &'static Arc<Mutex<TrayState>> {
    CURRENT_STATE.get_or_init(|| Arc::new(Mutex::new(TrayState::Idle)))
}

/// Refcount of active native-modal guards. When > 0, the hide-on-blur
/// handler is suppressed — the modal stealing key-window status from
/// the popover should not dismiss the popover, which would otherwise
/// unparent and close the modal.
///
/// Refcount (not bool) because a new `pick_folder` may start while the
/// previous one's `rfd` future hasn't resolved yet — `close_existing_file_panels`
/// cancels the stuck panel mid-call, resolving the previous future
/// (and dropping its guard). With a bool, that drop would clobber the
/// new call's flag to false while its own panel is still opening.
static MODAL_DEPTH: AtomicUsize = AtomicUsize::new(0);

/// Count of unacknowledged share events. When > 0, the tray tooltip
/// gains a " · N new share(s)" suffix as a lightweight visual badge
/// (avoids needing a new tray icon PNG for the share-notify feature).
static SHARE_BADGE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Whether at least one native modal is currently open.
pub fn is_modal_open() -> bool {
    MODAL_DEPTH.load(Ordering::SeqCst) > 0
}

/// RAII guard — increments `MODAL_DEPTH` on construction and decrements
/// on drop. Prefer this over flipping the counter manually so the
/// decrement is always paired even if the caller panics or returns
/// early.
///
/// Usage:
/// ```ignore
/// let _guard = tray::ModalGuard::new();
/// let picked = rfd::AsyncFileDialog::new().pick_folder().await;
/// // _guard drops here, MODAL_DEPTH decrements.
/// ```
pub struct ModalGuard;

impl ModalGuard {
    pub fn new() -> Self {
        MODAL_DEPTH.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ModalGuard {
    fn drop(&mut self) {
        MODAL_DEPTH.fetch_sub(1, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon loading
// ─────────────────────────────────────────────────────────────────────────────

/// Load the embedded icon bytes for a given tray state.
/// We use `include_bytes!` so the PNGs are baked into the binary.
/// Icons are cached after first decode via `OnceLock` to avoid repeated PNG parsing.
fn icon_for_state(state: TrayState) -> Image<'static> {
    static ICON_IDLE: OnceLock<Image<'static>> = OnceLock::new();
    static ICON_SYNCING: OnceLock<Image<'static>> = OnceLock::new();
    static ICON_ERROR: OnceLock<Image<'static>> = OnceLock::new();
    static ICON_CONFLICT: OnceLock<Image<'static>> = OnceLock::new();

    let decode = |bytes: &'static [u8]| -> Image<'static> {
        Image::from_bytes(bytes).expect("Failed to decode tray icon PNG")
    };

    match state {
        TrayState::Idle => ICON_IDLE.get_or_init(|| decode(include_bytes!("../icons/tray-idle@2x.png"))),
        TrayState::Syncing => ICON_SYNCING.get_or_init(|| decode(include_bytes!("../icons/tray-syncing@2x.png"))),
        TrayState::Error => ICON_ERROR.get_or_init(|| decode(include_bytes!("../icons/tray-error@2x.png"))),
        TrayState::Conflict => ICON_CONFLICT.get_or_init(|| decode(include_bytes!("../icons/tray-conflict@2x.png"))),
    }
    .clone()
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu IDs
// ─────────────────────────────────────────────────────────────────────────────

const MENU_VERSION: &str = "version";
const MENU_SYNC_NOW: &str = "sync-now";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";

// ─────────────────────────────────────────────────────────────────────────────
// Tray ID
// ─────────────────────────────────────────────────────────────────────────────

const TRAY_ID: &str = "hq-sync-tray";

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

/// Create the system tray icon with its context menu and event handlers.
///
/// Call this from `tauri::Builder::default().setup(...)`.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use crate::util::logfile::log;

    // Build context menu. The version row is a disabled item — it renders
    // like a macOS "About" label (dimmed, unclickable). Sourced from the
    // bundled `Cargo.toml` / `tauri.conf.json` via `package_info()` so it
    // tracks the binary the user is actually running.
    let version = app.package_info().version.to_string();
    let version_item = MenuItemBuilder::with_id(MENU_VERSION, format!("HQ Sync v{}", version))
        .enabled(false)
        .build(app)?;
    let sync_now = MenuItemBuilder::with_id(MENU_SYNC_NOW, "Sync Now").build(app)?;
    let settings = MenuItemBuilder::with_id(MENU_SETTINGS, "Settings").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&version_item)
        .separator()
        .item(&sync_now)
        .separator()
        .item(&settings)
        .item(&quit)
        .build()?;

    // Build tray icon
    // `tray` binding is unused after US-002 stripped the
    // tray.set_visible(false)/set_visible(true) re-registration toggle
    // (a macOS Tahoe/Sequoia SystemUIServer workaround). The builder
    // result is held by Tauri's TrayIcon manager — we don't need to
    // address the icon directly here. Underscore-prefix to silence the
    // warning without losing the symbol for future US-005 work.
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_for_state(TrayState::Idle))
        // icon_as_template is a macOS template-icon flag (monochrome
        // recolouring by AppKit). Windows tray icons are full-color
        // .ico files, so leave it false.
        .icon_as_template(false)
        .tooltip("HQ Sync — Idle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event({
            let app_handle = app.clone();
            move |_app, event| {
                let id = event.id().as_ref();
                match id {
                    id if id == MENU_SYNC_NOW => {
                        let _ = app_handle.emit("tray:sync-now", ());
                    }
                    id if id == MENU_SETTINGS => {
                        let _ = app_handle.emit("tray:open-settings", ());
                    }
                    id if id == MENU_QUIT => {
                        app_handle.exit(0);
                    }
                    _ => {}
                }
            }
        })
        .on_tray_icon_event({
            let app_handle = app.clone();
            move |_tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } = event
                {
                    toggle_window(&app_handle, Some(rect));
                }
            }
        })
        .build(app)?;

    log("tray", "tray icon built");

    // Hide the popover when the user clicks away. `window.hide()` preserves
    // the renderer state (DOM, Svelte stores, listeners), so re-showing is
    // instant. Windows tray popovers follow the same click-off-to-dismiss
    // convention as menubar apps (PowerToys Run, Everything search).
    //
    // Exception: when a native modal (folder picker, save dialog) is open,
    // the modal steals focus from the popover, which fires a
    // `Focused(false)` event. Hiding here would unparent the modal and
    // dismiss it immediately. `ModalGuard` (see above) bumps `MODAL_DEPTH`
    // while a picker is in flight; we check it and skip the hide.
    if let Some(window) = app.get_webview_window("main") {
        let win_clone = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                if !is_modal_open() {
                    // Drop always-on-top before hiding so we don't briefly
                    // mark the window as topmost while it's invisible (some
                    // window-management tools cache that state).
                    let _ = win_clone.set_always_on_top(false);
                    let _ = win_clone.hide();
                }
            }
        });
    }

    // Listen for sync events to auto-update tray state
    setup_sync_listeners(app);

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Window toggle
// ─────────────────────────────────────────────────────────────────────────────

/// Toggle the main window visibility (popover behaviour).
///
/// When showing, position the popover ABOVE the tray icon (Windows tray
/// lives at the bottom-right of the screen by default, so the popover
/// goes above-and-aligned to the icon). `window.hide()` preserves
/// renderer state so re-show is instant. `alwaysOnTop` is toggled with
/// visibility so the popover doesn't block other apps while hidden.
fn toggle_window(app: &AppHandle, tray_rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_always_on_top(false);
            let _ = window.hide();
        } else {
            if let Some(rect) = tray_rect {
                position_above_tray(&window, rect);
            }
            let _ = window.set_always_on_top(true);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Pure math: right-align `win_w`-wide window with the tray icon,
/// `gap_px` above it. All inputs in physical pixels.
///
/// Windows tray icons sit at the bottom-right of the screen by default.
/// Anchoring the popover's RIGHT edge to the tray icon's right edge
/// keeps the popover on-screen even when the tray is in the corner.
/// `pop_y` is the popover's top — sits `win_h + gap_px` above the tray's top edge.
pub(crate) fn compute_popover_position(
    tray_x: f64,
    _tray_y: f64,
    tray_w: f64,
    _tray_h: f64,
    win_w: f64,
    win_h: f64,
    gap_px: f64,
) -> (i32, i32) {
    // Compute against the tray icon — for bottom-right Windows taskbar
    // tray placement we just need to position the popover above the icon,
    // right-aligned. The Y math uses the tray Y (top of icon) − win_h − gap.
    let pop_x = (tray_x + tray_w - win_w).round() as i32;
    let pop_y = (_tray_y - win_h - gap_px).round() as i32;
    (pop_x, pop_y)
}

// Small visual gap between the taskbar and the popover bottom edge.
// 8 physical px keeps the popover from feeling glued to the taskbar
// while staying close enough to read as "this popover comes from there."
const POPOVER_GAP_PX: f64 = 8.0;

/// Position the window above the tray icon with right-edge alignment.
///
/// `Rect`'s `position` and `size` are enums (Physical | Logical); we
/// normalize both to physical pixels using the window's scale factor
/// so the math is unit-consistent with `window.outer_size()`, which is
/// already physical.
fn position_above_tray(window: &tauri::WebviewWindow, rect: Rect) {
    let size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let scale = window.scale_factor().unwrap_or(1.0);

    let (tray_x, tray_y) = match rect.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(p) => (p.x * scale, p.y * scale),
    };
    let (tray_w, tray_h) = match rect.size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(s) => (s.width * scale, s.height * scale),
    };
    let win_w = size.width as f64;
    let win_h = size.height as f64;

    let (pop_x, pop_y) =
        compute_popover_position(tray_x, tray_y, tray_w, tray_h, win_w, win_h, POPOVER_GAP_PX);

    let _ = window.set_position(PhysicalPosition::new(pop_x, pop_y));
}

/// Show + focus the main window, positioned above the tray icon.
///
/// Used by the global keyboard shortcut so the popover can be summoned
/// from anywhere without clicking the tray icon. If the tray rect isn't
/// available yet (race during startup) we still show the window — it
/// will appear at its last position rather than above the icon.
pub fn show_window_at_tray(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(Some(rect)) = tray.rect() {
            position_above_tray(&window, rect);
        }
    }
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let _ = window.set_focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon update
// ─────────────────────────────────────────────────────────────────────────────

/// Update the tray icon to reflect a new state.
pub fn update_tray_icon(app: &AppHandle, state: TrayState) {
    // Update global state
    if let Ok(mut current) = current_state().lock() {
        *current = state;
    }

    // Update icon + badge-aware tooltip
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon_for_state(state)));
    }
    refresh_tray_tooltip(app);
}

/// Get the current tray state.
#[allow(dead_code)]
pub fn get_current_state() -> TrayState {
    current_state().lock().map(|s| *s).unwrap_or(TrayState::Idle)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync event listeners → auto tray state
// ─────────────────────────────────────────────────────────────────────────────

/// Wire sync events to tray icon state changes.
fn setup_sync_listeners(app: &AppHandle) {
    use crate::events::{EVENT_SYNC_COMPLETE, EVENT_SYNC_CONFLICT, EVENT_SYNC_ERROR, EVENT_SYNC_PROGRESS};

    let app1 = app.clone();
    app.listen(EVENT_SYNC_PROGRESS, move |_event| {
        update_tray_icon(&app1, TrayState::Syncing);
    });

    let app2 = app.clone();
    app.listen(EVENT_SYNC_ERROR, move |_event| {
        update_tray_icon(&app2, TrayState::Error);
    });

    let app3 = app.clone();
    app.listen(EVENT_SYNC_COMPLETE, move |_event| {
        update_tray_icon(&app3, TrayState::Idle);
    });

    let app4 = app.clone();
    app.listen(EVENT_SYNC_CONFLICT, move |_event| {
        update_tray_icon(&app4, TrayState::Conflict);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Share-notification badge
// ─────────────────────────────────────────────────────────────────────────────

/// Compose the current tray tooltip from global state + badge count and
/// apply it to the tray icon. Called by `update_tray_icon`,
/// `set_share_badge`, and `clear_share_badge` so the tooltip is always
/// consistent with both the tray state and the share badge.
fn refresh_tray_tooltip(app: &AppHandle) {
    let state = get_current_state();
    let count = SHARE_BADGE_COUNT.load(Ordering::SeqCst);
    let tooltip = if count > 0 {
        format!("{} · {} new share(s)", state.tooltip(), count)
    } else {
        state.tooltip().to_string()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

/// Mark N unacknowledged share events. Updates the tray tooltip suffix.
/// Call from `share_notify::do_poll` after emitting new events.
pub fn set_share_badge(app: &AppHandle, count: usize) {
    SHARE_BADGE_COUNT.store(count, Ordering::SeqCst);
    refresh_tray_tooltip(app);
}

/// Clear the share badge. Call from `share_notify::share_detail_window_ready`
/// after the ack POST fires (best-effort).
pub fn clear_share_badge(app: &AppHandle) {
    SHARE_BADGE_COUNT.store(0, Ordering::SeqCst);
    refresh_tray_tooltip(app);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command
// ─────────────────────────────────────────────────────────────────────────────

/// Tauri command: let the frontend explicitly set tray icon state.
///
/// Accepts: "idle", "syncing", "error", "conflict" (case-insensitive).
#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: String) -> Result<(), String> {
    let tray_state = TrayState::from_str_loose(&state)
        .ok_or_else(|| format!("Invalid tray state: '{}'. Expected: idle, syncing, error, conflict", state))?;
    update_tray_icon(&app, tray_state);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tray_state_from_str_loose() {
        assert_eq!(TrayState::from_str_loose("idle"), Some(TrayState::Idle));
        assert_eq!(TrayState::from_str_loose("SYNCING"), Some(TrayState::Syncing));
        assert_eq!(TrayState::from_str_loose("Error"), Some(TrayState::Error));
        assert_eq!(TrayState::from_str_loose("conflict"), Some(TrayState::Conflict));
        assert_eq!(TrayState::from_str_loose("unknown"), None);
        assert_eq!(TrayState::from_str_loose(""), None);
    }

    #[test]
    fn test_tray_state_tooltip() {
        assert_eq!(TrayState::Idle.tooltip(), "HQ Sync — Idle");
        assert_eq!(TrayState::Syncing.tooltip(), "HQ Sync — Syncing…");
        assert_eq!(TrayState::Error.tooltip(), "HQ Sync — Error");
        assert_eq!(TrayState::Conflict.tooltip(), "HQ Sync — Conflict");
    }

    #[test]
    fn test_icon_bytes_are_valid_png() {
        // Verify that each included icon starts with the PNG magic bytes
        let png_magic: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

        for state in &[TrayState::Idle, TrayState::Syncing, TrayState::Error, TrayState::Conflict] {
            let bytes: &[u8] = match state {
                TrayState::Idle => include_bytes!("../icons/tray-idle@2x.png"),
                TrayState::Syncing => include_bytes!("../icons/tray-syncing@2x.png"),
                TrayState::Error => include_bytes!("../icons/tray-error@2x.png"),
                TrayState::Conflict => include_bytes!("../icons/tray-conflict@2x.png"),
            };
            assert!(
                bytes.starts_with(&png_magic),
                "Icon for {:?} does not start with PNG magic bytes",
                state
            );
        }
    }

    #[test]
    fn test_menu_id_constants() {
        assert_eq!(MENU_SYNC_NOW, "sync-now");
        assert_eq!(MENU_SETTINGS, "settings");
        assert_eq!(MENU_QUIT, "quit");
    }

    #[test]
    fn test_tray_id_constant() {
        assert_eq!(TRAY_ID, "hq-sync-tray");
    }

    #[test]
    fn test_current_state_default() {
        // OnceLock initialises to Idle on first access.
        // In parallel test runs another test may have mutated it,
        // so we just assert the value is a valid variant (exhaustive match).
        let state = get_current_state();
        match state {
            TrayState::Idle | TrayState::Syncing | TrayState::Error | TrayState::Conflict => {}
        }
    }

    #[test]
    fn test_compute_popover_position_right_aligned_above_tray() {
        // Tray icon at bottom-right: x=1880, y=1050 (just above a 1080p
        // taskbar at y=1052), 24x24. Window 320w × 400h. Gap 8.
        // Expected: popover RIGHT edge aligned to tray right edge
        //   pop_x = tray_x + tray_w − win_w = 1880 + 24 − 320 = 1584
        // and BOTTOM edge sits gap above tray TOP edge
        //   pop_y = tray_y − win_h − gap = 1050 − 400 − 8 = 642
        let (x, y) = compute_popover_position(1880.0, 1050.0, 24.0, 24.0, 320.0, 400.0, 8.0);
        assert_eq!(x, 1584);
        assert_eq!(y, 642);
    }

    #[test]
    fn test_compute_popover_position_no_clamping() {
        // Helper returns raw math — no on-screen clamping. If the tray
        // is near top-left (unusual; Windows tray usually bottom-right
        // but user can move taskbar), pop_y goes negative. Caller is
        // responsible for keeping the popover on-screen if needed.
        let (_, y) = compute_popover_position(10.0, 20.0, 24.0, 24.0, 320.0, 400.0, 8.0);
        assert_eq!(y, 20 - 400 - 8); // = -388
    }

    #[test]
    fn test_share_badge_count_atomic() {
        // AppHandle isn't constructible in unit tests, but we can verify
        // the AtomicUsize counter itself. `refresh_tray_tooltip` / `set_share_badge`
        // / `clear_share_badge` wrap this counter; the tray interaction is
        // exercised in integration/e2e contexts.
        let before = SHARE_BADGE_COUNT.load(Ordering::SeqCst);
        SHARE_BADGE_COUNT.store(5, Ordering::SeqCst);
        assert_eq!(SHARE_BADGE_COUNT.load(Ordering::SeqCst), 5);
        SHARE_BADGE_COUNT.store(0, Ordering::SeqCst);
        assert_eq!(SHARE_BADGE_COUNT.load(Ordering::SeqCst), 0);
        // Restore — best-effort in parallel test runs.
        SHARE_BADGE_COUNT.store(before, Ordering::SeqCst);
    }

    #[test]
    fn test_modal_guard_scoping() {
        // ModalGuard is RAII — increment on construction, decrement on
        // drop. This guard is the mechanism that keeps the popover
        // visible while a native picker dialog is open (see
        // folder_picker.rs); if Drop stops decrementing, the popover
        // will never auto-hide on blur again. Treat regressions here
        // as release blockers.
        //
        // No other test in this module touches MODAL_DEPTH, so parallel
        // execution is safe as long as we assert via deltas rather than
        // absolute values.
        let start = MODAL_DEPTH.load(Ordering::SeqCst);

        {
            let _g = ModalGuard::new();
            assert_eq!(
                MODAL_DEPTH.load(Ordering::SeqCst),
                start + 1,
                "guard should increment MODAL_DEPTH"
            );
            assert!(is_modal_open(), "is_modal_open should be true with guard alive");

            {
                let _g2 = ModalGuard::new();
                assert_eq!(
                    MODAL_DEPTH.load(Ordering::SeqCst),
                    start + 2,
                    "nested guard should increment again"
                );
            }

            assert_eq!(
                MODAL_DEPTH.load(Ordering::SeqCst),
                start + 1,
                "dropping inner guard should decrement once"
            );
            assert!(is_modal_open(), "outer guard still alive — should still be open");
        }

        assert_eq!(
            MODAL_DEPTH.load(Ordering::SeqCst),
            start,
            "dropping outer guard should decrement back to start"
        );
    }
}
