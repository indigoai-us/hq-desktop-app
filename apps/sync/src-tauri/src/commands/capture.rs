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
    create_record, delete_record, ideas_root, load_record, mark_cited, model_extract_url,
    move_record, parse_mode, reindex_after_write, run_model_stage, save_record, CaptureImage,
    CaptureKind, CaptureRecord, CaptureStatus, ExtractionMode, ExtractionSource,
    HttpModelExtractor, IdeasError, NewCapture, Provenance, QmdCli, TokenProvider,
    EXTRACTION_MODE_SETTING, MODEL_DISCLOSURE,
};
use hq_desktop_core::ideas::{
    resolve_image_max_edge, sync_enabled, DEFAULT_IMAGE_MAX_EDGE,
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
/// Mark: the US-014 guidance panel was opened after a refused/denied grant.
pub const MARK_GUIDE_SHOWN: &str = "idea.capture.permission_guide_shown";
/// Mark: the user closed the guidance panel without granting.
pub const MARK_GUIDE_DISMISSED: &str = "idea.capture.permission_guide_dismissed";
/// Mark: the poller saw the preflight flip to granted while the panel was open.
pub const MARK_GUIDE_GRANTED: &str = "idea.capture.permission_guide_granted";
/// Mark: the capture the user originally attempted was resumed automatically.
pub const MARK_GUIDE_RESUMED: &str = "idea.capture.permission_guide_resumed";

// ---------------------------------------------------------------------------
// US-012 wiring: the two capture preferences, resolved OFF the hot path
// ---------------------------------------------------------------------------

/// Cached `ideasImageMaxEdge`, already screened by `resolve_image_max_edge`.
static IDEAS_IMAGE_MAX_EDGE: AtomicU32 = AtomicU32::new(DEFAULT_IMAGE_MAX_EDGE);
/// Cached `!ideasSyncEnabled` — true means "write outside the vault sync scope".
static IDEAS_LOCAL_ONLY: AtomicBool = AtomicBool::new(false);

/// Re-read the Ideas capture preferences from `menubar.json` into the cache.
///
/// **Never call this from `capture_and_store`.** Commit a0ab3044 took
/// provenance resolution off the release->png_written path to hold a p95 of
/// 120ms; a `menubar.json` read per capture would put a synchronous disk hit
/// straight back into that window. Instead this runs at the three moments the
/// answer can actually change — app start, a settings save, and a settings
/// panel open — and `capture_and_store` reads two atomics.
///
/// Atomics, not a `Mutex`/`RwLock`, on purpose: a lock is contendable, and the
/// contending writer here is a disk-reading settings save. `Relaxed` is
/// sufficient — the two values are independent scalars, nothing else is
/// published alongside them, and a capture racing a save legitimately gets
/// either the old or the new preference.
///
/// Guarded by `hq_idea_board_settings_resolution_is_off_the_release_to_png_path`.
pub fn refresh_ideas_capture_prefs() {
    let prefs = hq_desktop_core::paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<hq_desktop_core::config::MenubarPrefs>(&c).ok());
    let max_edge = resolve_image_max_edge(prefs.as_ref().and_then(|p| p.ideas_image_max_edge));
    let local_only = !sync_enabled(prefs.as_ref().and_then(|p| p.ideas_sync_enabled));
    IDEAS_IMAGE_MAX_EDGE.store(max_edge, Ordering::Relaxed);
    IDEAS_LOCAL_ONLY.store(local_only, Ordering::Relaxed);
    log(
        LOG_TAG,
        &format!("idea.capture.prefs image_max_edge={max_edge} local_only={local_only}"),
    );
}

/// `(image_max_edge, local_only)` from the cache. Two relaxed atomic loads and
/// no I/O — safe to call between the release and png_written marks.
pub fn ideas_capture_prefs() -> (u32, bool) {
    (
        IDEAS_IMAGE_MAX_EDGE.load(Ordering::Relaxed),
        IDEAS_LOCAL_ONLY.load(Ordering::Relaxed),
    )
}

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
/// App-wide event fired when a capture leaves the active company's board
/// (US-010). Payload:
/// `{"id": <id>, "company_slug": <slug it left>, "reason": "moved"|"deleted",
///   "to_company": <slug>?}` — `to_company` is present only for `"moved"`.
pub const EVENT_CAPTURE_REMOVED: &str = "capture:removed";

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
/// the main thread at show time, and cleared again the moment the overlay is
/// ordered out. 0 = no overlay on screen.
///
/// It is only ever a valid `CGWindowListCreateImage` anchor **while the
/// overlay is still on screen**. AppKit assigns a window number when a window
/// is first ordered in, so the overlay — built `.visible(false)` — reports 0
/// until its first `show()` and a real number on every show after that. That
/// asymmetry is what made the first capture of a session work and every one
/// after it come back black: capture 1 anchored on 0 (no exclusion, plain
/// display grab), captures 2+ anchored on a window that `hide_overlay` had
/// already ordered out, and an on-screen-below-window query anchored on an
/// off-screen window returns the caller's own layers over a black desktop.
/// See [`grab_exclusion`].
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
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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

// ---------------------------------------------------------------------------
// US-014: guided screen-recording permission onboarding (macOS)
// ---------------------------------------------------------------------------

/// Window label — kept in sync with `main.ts`'s router branch and
/// `capabilities/permission-guide.json`.
pub const GUIDE_WINDOW_LABEL: &str = "permission-guide";

/// Payload event delivered to the guidance panel on its ready handshake.
pub const EVENT_GUIDE_STATE: &str = "permission-guide:state";

/// Panel dimensions and screen margin (logical points).
const GUIDE_W: f64 = 380.0;
const GUIDE_H: f64 = 460.0;
const GUIDE_MARGIN: f64 = 24.0;

/// Poll cadence for `CGPreflightScreenCaptureAccess` while the panel is open.
///
/// 500ms is fast enough that the drop into the permissions list feels like it
/// is detected instantly, and slow enough that this is two syscalls a second
/// on a background thread — not a busy loop. The poller exits the moment the
/// panel closes, so nothing runs when the panel is not on screen.
pub const GUIDE_POLL_INTERVAL_MS: u64 = 500;

/// True while the guidance panel is on screen. Also the poller's run flag —
/// clearing it is what stops the polling thread.
static GUIDE_OPEN: AtomicBool = AtomicBool::new(false);

/// True once the user has closed the panel without granting. A second chord
/// then falls back to the one-line denial banner rather than re-opening a
/// panel the user just rejected.
static GUIDE_DISMISSED: AtomicBool = AtomicBool::new(false);

/// How to answer a chord that found Screen Recording unavailable *after* the
/// (at most once ever) system prompt. Only reached on a real denial — the
/// granted case never gets here, so there is no "proceed" arm to go stale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenialResponse {
    /// Open the guided panel (macOS, first refusal).
    Guide,
    /// Fall back to the existing one-line banner + deep link.
    Banner,
}

/// Pure denial policy, so the (untestable-in-CI) TCC behaviour stays out of
/// the decision.
///
/// * `guide_dismissed` — the user already closed the panel without granting.
///   Process-global and only cleared by an actual grant, so one dismissal
///   means the banner for the rest of the session: re-opening a panel the
///   user just rejected would be nagging, not guidance.
/// * `guide_supported` — macOS only; Windows has no Screen Recording gate and
///   no Settings pane to guide anyone to.
pub fn denial_response(guide_dismissed: bool, guide_supported: bool) -> DenialResponse {
    if guide_supported && !guide_dismissed {
        DenialResponse::Guide
    } else {
        DenialResponse::Banner
    }
}

/// One poll tick's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuidePoll {
    /// Panel closed (or never opened) — the thread must exit.
    Stop,
    /// Access just appeared — dismiss the panel and resume the capture.
    Resume,
    /// Still waiting.
    Continue,
}

/// Pure poll policy. The `open` check comes first so a dismissed panel never
/// resurrects a capture the user walked away from, even if the grant lands in
/// the same tick.
pub fn guide_poll(open: bool, granted: bool) -> GuidePoll {
    if !open {
        GuidePoll::Stop
    } else if granted {
        GuidePoll::Resume
    } else {
        GuidePoll::Continue
    }
}

/// Typical System Settings window width in logical points. macOS opens that
/// window centred on the active display and gives no API for another app's
/// window geometry, so this is the honest way to park *beside* it.
pub const SETTINGS_WINDOW_W: f64 = 715.0;

/// Logical origin that parks a `w`x`h` panel immediately to the LEFT of the
/// centred System Settings window, vertically centred, clamped inside the
/// display so it can never land offscreen on a small or scaled screen.
///
/// Pure so it is unit-testable without a live window.
pub fn guide_position(display: &DisplayRect, w: f64, h: f64, margin: f64) -> (f64, f64) {
    let settings_left = display.x + (display.w - SETTINGS_WINDOW_W) / 2.0;
    let desired_x = settings_left - w - margin;
    let desired_y = display.y + (display.h - h) / 2.0;
    // Clamp: the low bound wins, so a display too narrow to hold both windows
    // still shows the panel fully rather than half off the left edge.
    let max_x = display.x + display.w - w - margin;
    let max_y = display.y + display.h - h - margin;
    let x = desired_x.min(max_x).max(display.x + margin);
    let y = desired_y.min(max_y).max(display.y + margin);
    (x, y)
}

/// State handed to the panel on its ready handshake.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGuideState {
    /// Absolute path of the `.app` bundle the user drags into the list.
    pub grant_path: String,
    /// Display name shown on the drag chip.
    pub grant_name: String,
    /// False on macOS: the system prompt fires at most once per app identity,
    /// so a user who has already refused will never see it again and the drag
    /// path is their only route. The panel says so plainly.
    pub will_reprompt: bool,
}

/// Resolve the panel's state. Kept out of the command so tests can call it.
pub fn permission_guide_state_inner() -> PermissionGuideState {
    let path = hq_platform::permissions::screen_capture_grant_path();
    let grant_path = path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let grant_name = path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "HQ".to_string());
    PermissionGuideState {
        grant_path,
        grant_name,
        // macOS never re-prompts once a decision is cached; by the time this
        // panel is on screen the one-shot prompt is already spent.
        will_reprompt: false,
    }
}

/// Build the hidden guidance-panel window at app start (idempotent).
///
/// macOS only. Windows has no Screen Recording gate — `denial_response`
/// always answers `Banner` there — so building a transparent always-on-top
/// window that can never be shown would be pure overhead.
///
/// Built **non-activating** (`.focusable(false)`) per repo policy
/// `hq-desktop-app-nonactivating-window-toggle-focusable-for-input`, so
/// opening it never yanks focus away from System Settings. It becomes
/// focusable — and therefore keyboard-operable — only through
/// `set_permission_guide_focusable`, which the panel calls on its ready
/// handshake and flips back off on dismiss.
#[allow(unused_variables)]
pub fn setup_permission_guide_window(app: &AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        log(LOG_TAG, "guide setup: skipped (no Screen Recording gate off macOS)");
    }

    #[cfg(target_os = "macos")]
    {
    if app.get_webview_window(GUIDE_WINDOW_LABEL).is_some() {
        log(LOG_TAG, "guide setup: window already exists");
        return;
    }
    GUIDE_OPEN.store(false, Ordering::SeqCst);

    let build = WebviewWindowBuilder::new(
        app,
        GUIDE_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Screen Recording")
    .inner_size(GUIDE_W, GUIDE_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible_on_all_workspaces(true)
    .visible(false)
    .build();

    let window = match build {
        Ok(w) => w,
        Err(e) => {
            log(LOG_TAG, &format!("guide setup: WebviewWindowBuilder FAILED: {e}"));
            return;
        }
    };

    // Clear WKWebView's underPageBackgroundColor so the transparent page does
    // not sit on a system-gray sheet (same idiom as the overlay/toast).
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

    // Promote to a non-activating NSPanel, for the same reason commit
    // ecf6eef8 did it to the capture overlay: without it, the first click or
    // drag inside this panel activates HQ and raises HQ's other windows over
    // the System Settings pane the user is being asked to drop into. That is
    // fatal here specifically — the drag's destination would be covered by the
    // app that started the drag.
    //
    // COUPLING: this swaps out tao's `TaoWindow` subclass, so tao's
    // `focusable` ivar goes with it and `window.set_focusable(..)` must never
    // be called on this window again. `set_permission_guide_focusable` speaks
    // to the NSPanel directly instead — see its note.
    make_window_nonactivating_panel(&window);
    // ...but unlike the overlay, this panel *is* keyboard-operable (Escape,
    // tabbing to the buttons), so it must be allowed to become key on a plain
    // click rather than only when a view demands input.
    set_guide_becomes_key_only_if_needed(&window, false);

    log(LOG_TAG, &format!("guide setup: pre-rendered hidden window {GUIDE_W}x{GUIDE_H}"));
    }
}

/// MAIN THREAD ONLY. Set the guide panel's `becomesKeyOnlyIfNeeded`.
///
/// `false` lets a click anywhere in the panel make it key — which, on a
/// *non-activating* panel, gives it the keyboard without activating HQ or
/// raising HQ's other windows. That is how the panel stays keyboard-operable
/// after the NSPanel promotion took tao's focusable ivar away.
#[cfg(target_os = "macos")]
fn set_guide_becomes_key_only_if_needed(window: &tauri::WebviewWindow, value: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_win) = window.ns_window() else { return };
    if ns_win.is_null() {
        return;
    }
    // SAFETY: main thread, live NSPanel, public AppKit selector.
    unsafe {
        let obj = ns_win as *mut AnyObject;
        let _: () = msg_send![obj, setBecomesKeyOnlyIfNeeded: value];
    }
}

/// Show the guidance panel, open the Screen Recording pane it guides to, and
/// start the grant poller.
///
/// Never blocks the chord: the System Settings deep link is spawned, the
/// positioning/show hops onto the main thread, and the poller runs on its own
/// thread. The deep link is fired here — not left to a click — because AC2
/// asks the panel to *land beside* that window; opening it ourselves is what
/// makes the side-by-side placement mean anything. The panel still carries an
/// explicit button for when macOS ignores the URL.
fn show_permission_guide(app: &AppHandle) {
    // Already up: nothing to do, and re-arming the poller would duplicate it.
    if GUIDE_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }

    // Fire-and-forget: `open` spawns a child process, which must never sit on
    // the chord's stack.
    tauri::async_runtime::spawn(async {
        if let Err(e) =
            crate::commands::permissions::permissions_open_settings("screen-capture".to_string())
        {
            log(LOG_TAG, &format!("guide: open settings FAILED: {e}"));
        }
    });

    let app_main = app.clone();
    let hop = app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(GUIDE_WINDOW_LABEL) else {
            // No panel window (build failed at setup): do not leave the flag
            // set claiming a panel is up, and give the user the banner.
            GUIDE_OPEN.store(false, Ordering::SeqCst);
            log(LOG_TAG, "guide show FAILED: window missing");
            prompt_for_screen_recording(&app_main);
            return;
        };
        let display = app_main
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| monitor_rect(&m))
            .unwrap_or(DisplayRect { x: 0.0, y: 0.0, w: 1440.0, h: 900.0, scale: 1.0 });
        let (x, y) = guide_position(&display, GUIDE_W, GUIDE_H, GUIDE_MARGIN);

        #[cfg(target_os = "macos")]
        {
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        }

        match window.show() {
            Ok(()) => log(LOG_TAG, MARK_GUIDE_SHOWN),
            Err(e) => {
                GUIDE_OPEN.store(false, Ordering::SeqCst);
                log(LOG_TAG, &format!("guide show FAILED: {e}"));
                prompt_for_screen_recording(&app_main);
                return;
            }
        }
        let _ = app_main.emit_to(
            GUIDE_WINDOW_LABEL,
            EVENT_GUIDE_STATE,
            permission_guide_state_inner(),
        );
    });

    // If the hop itself failed (event loop gone), the closure above never ran:
    // do not leave GUIDE_OPEN latched true, which would swallow every later
    // chord and leave an orphan poller running for the process lifetime.
    if let Err(e) = hop {
        GUIDE_OPEN.store(false, Ordering::SeqCst);
        log(LOG_TAG, &format!("guide show FAILED: main-thread hop {e}"));
        prompt_for_screen_recording(app);
        return;
    }

    start_guide_poller(app);
}

/// Hide the panel and stop the poller. Safe to call repeatedly and from any
/// thread; this is the single teardown path for dismissal, grant, panel
/// errors, and app quit, so no code path can leave a stuck always-on-top
/// window behind.
fn hide_permission_guide(app: &AppHandle) {
    GUIDE_OPEN.store(false, Ordering::SeqCst);
    let app_main = app.clone();
    let hop = app.run_on_main_thread(move || {
        if let Some(window) = app_main.get_webview_window(GUIDE_WINDOW_LABEL) {
            // Drop key-ability with the window so the next open behaves
            // exactly as it was built.
            //
            // NOT tao's `set_focusable`: the window is promoted to an NSPanel
            // at setup, which replaces tao's `TaoWindow` subclass — and tao's
            // macOS `set_focusable` writes a `focusable` ivar that no longer
            // exists on the class, which panics on the main thread. That
            // would wedge this teardown, the single path every dismissal,
            // grant-resume and quit funnels through.
            #[cfg(target_os = "macos")]
            set_guide_becomes_key_only_if_needed(&window, true);
            #[cfg(not(target_os = "macos"))]
            if let Err(e) = window.set_focusable(false) {
                log(LOG_TAG, &format!("guide hide: set_focusable failed: {e}"));
            }
            // Any half-armed drag dies with the panel.
            #[cfg(target_os = "macos")]
            disarm_drag_monitor_on_main();
            if let Err(e) = window.hide() {
                log(LOG_TAG, &format!("guide hide FAILED: {e}"));
            }
        }
    });
    // A dropped hop is the one way a visible panel could outlive its flag, so
    // it is logged loudly rather than swallowed.
    if let Err(e) = hop {
        log(LOG_TAG, &format!("guide hide FAILED: main-thread hop {e}"));
    }
}

/// Background poller: watches `CGPreflightScreenCaptureAccess` while the panel
/// is open and, the instant it flips, closes the panel and resumes the capture
/// the user originally attempted — no second chord press.
fn start_guide_poller(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(GUIDE_POLL_INTERVAL_MS));
        let open = GUIDE_OPEN.load(Ordering::SeqCst);
        // Skip the syscall entirely once the panel is gone.
        let granted = open && hq_platform::permissions::screen_capture_preflight();
        match guide_poll(open, granted) {
            GuidePoll::Stop => return,
            GuidePoll::Continue => continue,
            GuidePoll::Resume => {
                // Claim the panel atomically. `dismiss_permission_guide` also
                // clears GUIDE_OPEN, so if the user pressed "Not now" while
                // this tick was inside the preflight syscall, the swap below
                // reads false and we exit without resurrecting a capture they
                // walked away from — and without clearing their dismissal.
                if !GUIDE_OPEN.swap(false, Ordering::SeqCst) {
                    return;
                }
                log(LOG_TAG, MARK_GUIDE_GRANTED);
                hide_permission_guide(&app);
                GUIDE_DISMISSED.store(false, Ordering::SeqCst);
                log(LOG_TAG, MARK_GUIDE_RESUMED);
                let app_main = app.clone();
                let _ = app.run_on_main_thread(move || show_overlay(&app_main));
                return;
            }
        }
    });
}

/// App-quit teardown. Called from the exit path so a panel that is on screen
/// when the user quits never outlives the app as a stuck always-on-top window.
pub fn shutdown_permission_guide(app: &AppHandle) {
    if GUIDE_OPEN.load(Ordering::SeqCst) {
        hide_permission_guide(app);
    }
}

/// Ready handshake from the panel webview: deliver the drag/copy state.
#[tauri::command]
pub fn permission_guide_ready(app: AppHandle) -> Result<PermissionGuideState, String> {
    let state = permission_guide_state_inner();
    let _ = app.emit_to(GUIDE_WINDOW_LABEL, EVENT_GUIDE_STATE, state.clone());
    Ok(state)
}

/// Toggle the panel's focusable state so it can take keyboard input. Per
/// policy `hq-desktop-app-nonactivating-window-toggle-focusable-for-input`
/// the panel is built non-activating and only becomes focusable through this
/// command (same shape as `set_capture_toast_focusable`).
///
/// Deliberately does NOT call `set_focus()`: the whole point of this panel is
/// that the user is working in the Screen Recording pane next to it, and
/// yanking key focus off that window would break the drag it is asking for.
/// Making the window focusable is enough — clicking or tabbing into the panel
/// then gives it the keyboard.
#[tauri::command]
pub async fn set_permission_guide_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(GUIDE_WINDOW_LABEL) else {
            return;
        };
        // NOT `window.set_focusable(..)`: this window was promoted to an
        // NSPanel at setup, which replaced tao's `TaoWindow` subclass and the
        // `focusable` ivar that call reads. The NSPanel equivalent is
        // `becomesKeyOnlyIfNeeded` — false means a click anywhere gives the
        // panel the keyboard, and because the panel is non-activating that
        // costs the user neither their frontmost app nor the Screen Recording
        // window they are dragging into.
        #[cfg(target_os = "macos")]
        set_guide_becomes_key_only_if_needed(&window, !focusable);
        #[cfg(not(target_os = "macos"))]
        let _ = window.set_focusable(focusable);
        log(
            LOG_TAG,
            &format!("set_permission_guide_focusable: focusable={focusable}"),
        );
    })
    .map_err(|e| e.to_string())
}

/// User closed the panel without granting. Hides the panel, stops the poller,
/// and arms the banner fallback for the next chord press.
#[tauri::command]
pub fn dismiss_permission_guide(app: AppHandle) -> Result<(), String> {
    if !GUIDE_OPEN.load(Ordering::SeqCst) {
        return Ok(());
    }
    GUIDE_DISMISSED.store(true, Ordering::SeqCst);
    log(LOG_TAG, MARK_GUIDE_DISMISSED);
    hide_permission_guide(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// US-014 drag: a REAL native file drag of the .app bundle
// ---------------------------------------------------------------------------
//
// The panel used to present the chip as an HTML5 DOM drag (`draggable="true"`
// + `dragstart` writing a `file://` string). That looks draggable and does
// nothing: an HTML5 drag inside a WKWebView never starts an
// `NSDraggingSession`, so System Settings is never offered a file and its
// Screen Recording list never highlights. The owner saw exactly that — the
// list highlights for ChatGPT (a real Finder/native drag) and not for us.
//
// The fix is to start the drag from AppKit: put the bundle's `NSURL` on a
// dragging item (NSURL is an `NSPasteboardWriting`, so it lands on the
// pasteboard as `public.file-url` — the type System Settings reads), give it
// the bundle's Finder icon as the drag image, and call
// `beginDraggingSessionWithItems:event:source:` on the panel's content view.

/// `NSDragOperationCopy` — the only operation this drag ever offers.
pub const NS_DRAG_OPERATION_COPY: u64 = 1;

/// `NSEventTypeLeftMouseDown`.
pub const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: u64 = 1;
/// `NSEventTypeLeftMouseUp`.
pub const NS_EVENT_TYPE_LEFT_MOUSE_UP: u64 = 2;
/// `NSEventTypeLeftMouseDragged`.
pub const NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED: u64 = 6;

/// Edge of the square drag image, in points.
pub const DRAG_IMAGE_EDGE: f64 = 64.0;

/// True when `ty` is an event `beginDraggingSessionWithItems:event:source:`
/// accepts. Apple's contract is "a mouse-down or mouse-drag event"; handing it
/// anything else (a `mouseUp`, or the `nil` you get when no event is being
/// dispatched) yields no session at all — which is indistinguishable, from the
/// user's side, from the inert HTML5 drag this replaced.
///
/// Pure so the contract is unit-testable without AppKit.
pub fn is_drag_initiating_event(ty: u64) -> bool {
    ty == NS_EVENT_TYPE_LEFT_MOUSE_DOWN || ty == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED
}

/// Mark: the panel was pressed and the drag monitor is watching for the
/// user's own mouse-drag.
pub const MARK_GUIDE_DRAG_ARMED: &str = "idea.capture.permission_guide_drag_armed";
/// Mark: a native dragging session was begun for the grant bundle.
pub const MARK_GUIDE_DRAG_BEGAN: &str = "idea.capture.permission_guide_drag_began";
/// Mark: the native drag could not start (` reason=...`) — the panel falls
/// back to copy-path, which is why this is a log and not a silent return.
pub const MARK_GUIDE_DRAG_FAILED: &str = "idea.capture.permission_guide_drag_failed";

/// Lazily register (once) a minimal `NSDraggingSource` class.
///
/// `beginDraggingSessionWithItems:event:source:` requires a source object; a
/// source that does not answer
/// `draggingSession:sourceOperationMaskForDraggingContext:` with a real
/// operation makes every destination refuse the drop — no highlight, which is
/// the whole bug. So the class exists purely to answer `Copy` outside the
/// application, and to ignore modifier keys (holding ⌥ must not turn the drop
/// into something System Settings rejects).
///
/// Returns `None` if the runtime refuses to register or find the class —
/// never a fabricated reference, because the caller immediately sends it
/// `alloc`.
#[cfg(target_os = "macos")]
fn drag_source_class() -> Option<&'static objc2::runtime::AnyClass> {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use std::num::NonZeroUsize;
    use std::sync::OnceLock;

    static CLASS: OnceLock<Option<NonZeroUsize>> = OnceLock::new();

    // `NSDraggingContext` is an NSInteger; `NSDragOperation` an NSUInteger.
    extern "C" fn operation_mask(
        _this: &AnyObject,
        _sel: Sel,
        _session: *mut AnyObject,
        _context: isize,
    ) -> u64 {
        // Same answer for both contexts (within-application and outside). The
        // panel is never itself a drop target, and System Settings is always
        // "outside".
        NS_DRAG_OPERATION_COPY
    }

    extern "C" fn ignore_modifiers(_this: &AnyObject, _sel: Sel, _session: *mut AnyObject) -> Bool {
        Bool::YES
    }

    let slot = CLASS.get_or_init(|| {
        let registered: *const AnyClass = match ClassBuilder::new(
            c"HQIdeaBoardGrantDragSource",
            objc2::class!(NSObject),
        ) {
            Some(mut builder) => {
                if let Some(proto) = objc2::runtime::AnyProtocol::get(c"NSDraggingSource") {
                    builder.add_protocol(proto);
                }
                // SAFETY: both selectors are declared by `NSDraggingSource`
                // with exactly these signatures, and the implementations
                // touch no state.
                unsafe {
                    builder.add_method(
                        objc2::sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                        operation_mask as extern "C" fn(_, _, _, _) -> _,
                    );
                    builder.add_method(
                        objc2::sel!(ignoreModifierKeysForDraggingSession:),
                        ignore_modifiers as extern "C" fn(_, _, _) -> _,
                    );
                }
                builder.register()
            }
            // The only way `new` fails for a fixed name is that the class is
            // already registered in this process.
            None => match AnyClass::get(c"HQIdeaBoardGrantDragSource") {
                Some(c) => c,
                None => return None,
            },
        };
        NonZeroUsize::new(registered as usize)
    });
    // SAFETY: the pointer came from a `&'static AnyClass` above, and the
    // `NonZeroUsize` proves it is not the null sentinel.
    slot.map(|p| unsafe { &*(p.get() as *const objc2::runtime::AnyClass) })
}

/// The single drag-source instance.
///
/// `NSDraggingSession.draggingSource` is **unretained**, so the source must
/// outlive the drag by some other means. One process-lifetime singleton is
/// that means: it holds no per-drag state, so sharing it is free, and it is
/// deliberately never released. Do NOT "fix" this into a per-drag alloc that
/// gets released — that is a use-after-free of the source mid-drag.
#[cfg(target_os = "macos")]
fn drag_source_instance() -> Option<*mut objc2::runtime::AnyObject> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::num::NonZeroUsize;
    use std::sync::OnceLock;

    static SOURCE: OnceLock<Option<NonZeroUsize>> = OnceLock::new();
    let slot = SOURCE.get_or_init(|| {
        let class = drag_source_class()?;
        // SAFETY: plain NSObject alloc/init on a class we registered.
        let obj: *mut AnyObject = unsafe {
            let o: *mut AnyObject = msg_send![class, alloc];
            msg_send![o, init]
        };
        NonZeroUsize::new(obj as usize)
    });
    slot.map(|p| p.get() as *mut AnyObject)
}

/// The armed local event monitor, if any (an `id`, retained).
#[cfg(target_os = "macos")]
static DRAG_MONITOR: Mutex<Option<usize>> = Mutex::new(None);

/// MAIN THREAD ONLY. Remove any armed drag monitor. Idempotent.
#[cfg(target_os = "macos")]
fn disarm_drag_monitor_on_main() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let Ok(mut slot) = DRAG_MONITOR.lock() else { return };
    if let Some(ptr) = slot.take() {
        // SAFETY: main thread; `ptr` is the retained monitor object AppKit
        // handed back from `addLocalMonitorForEventsMatchingMask:handler:`.
        unsafe {
            let obj = ptr as *mut AnyObject;
            let _: () = msg_send![class!(NSEvent), removeMonitor: obj];
            objc2::ffi::objc_release(obj.cast());
        }
    }
}

/// Remove the monitor on the NEXT main-thread turn.
///
/// The handler block must NEVER call `disarm_drag_monitor_on_main` directly:
/// once armed, AppKit's copy of the block is the only strong reference to it,
/// so `removeMonitor:` from inside the handler releases the block — and its
/// captured `AppHandle`/`String` — while the handler's own frame is still
/// running and still has to return. Deferring the removal by one turn means
/// the block has always returned before anything releases it.
#[cfg(target_os = "macos")]
fn schedule_disarm(app: &AppHandle) {
    // `run_on_main_thread` posts to the event loop rather than running inline,
    // which is precisely the one-turn delay this needs.
    let _ = app.run_on_main_thread(disarm_drag_monitor_on_main);
}

/// Arm the drag: the panel was pressed, so watch for the user's own
/// left-mouse-drag and start the native session from *that* event.
///
/// Why a local event monitor rather than reading `NSApp`'s current-event
/// inside the command: the webview's press crosses the Tauri IPC boundary and a
/// thread hop, so by the time Rust runs, the event AppKit is dispatching is no
/// longer the user's press — it may belong to another window entirely (System
/// Settings is right there). `beginDraggingSessionWithItems:event:source:`
/// seeded with a stale or foreign event starts no session that tracks the
/// pointer, which reproduces the original symptom exactly: no highlight. A
/// local monitor runs **synchronously inside AppKit's dispatch**, so the event
/// it hands us is the real one.
///
/// Waiting for a `leftMouseDragged` also means a plain click on the chip (the
/// copy-path affordance) never spawns a stray session: a click produces no
/// drag event at all.
#[cfg(target_os = "macos")]
fn arm_drag_monitor_on_main(app: &AppHandle, path: String) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    // Re-arming replaces, never stacks.
    disarm_drag_monitor_on_main();

    // Fail loudly *now* if the pieces the drag needs are missing, so the panel
    // can show its copy-path fallback instead of an inert chip.
    if app.get_webview_window(GUIDE_WINDOW_LABEL).is_none() {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_window"));
        return Err("guide window is gone".into());
    }
    if drag_source_instance().is_none() {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_drag_source"));
        return Err("could not create the drag source".into());
    }

    let app = app.clone();
    let armed_path = path.clone();
    let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }
        // SAFETY: main thread, inside AppKit's own dispatch; `event` is a live
        // NSEvent.
        let ty: u64 = unsafe { msg_send![event, type] };
        if ty == NS_EVENT_TYPE_LEFT_MOUSE_UP {
            // Released without dragging — the press was a click. Stand down.
            schedule_disarm(&app);
            return event;
        }
        if is_drag_initiating_event(ty) {
            let _ = begin_grant_drag_with_event(&app, &path, event);
            // One session per press either way: a refusal must not retry on
            // every subsequent drag event.
            schedule_disarm(&app);
        }
        event
    });

    // NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp.
    let mask: u64 = (1 << NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED) | (1 << NS_EVENT_TYPE_LEFT_MOUSE_UP);
    // SAFETY: main thread; AppKit copies the handler block, and we retain the
    // returned monitor so `removeMonitor:` has something valid to take.
    unsafe {
        let monitor: *mut AnyObject = msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: mask,
            handler: &*handler,
        ];
        if monitor.is_null() {
            log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_monitor"));
            return Err("could not watch for the drag".into());
        }
        objc2::ffi::objc_retain(monitor.cast());
        if let Ok(mut slot) = DRAG_MONITOR.lock() {
            *slot = Some(monitor as usize);
        }
    }
    log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_ARMED} path={armed_path}"));
    Ok(())
}

/// Arm the native drag of the running app bundle.
///
/// Called when the user presses the chip. Returns the path that will be put on
/// the pasteboard, so the caller (and the tests) can assert the drag offers
/// the *running* bundle rather than a hardcoded or stale path. Errors are
/// meaningful: the panel shows its copy-path fallback whenever this rejects,
/// so a machine where the drag cannot start is never left with a chip that
/// silently does nothing.
#[tauri::command]
pub async fn permission_guide_begin_drag(app: AppHandle) -> Result<String, String> {
    // Always resolved at runtime from the running executable
    // (`hq_platform::permissions::screen_capture_grant_path`), never a
    // constant — a shipped `.app` in /Applications and a dev build under
    // target/ must each offer their own bundle or the grant lands on the
    // wrong identity.
    let state = permission_guide_state_inner();
    if state.grant_path.is_empty() {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_grant_path"));
        return Err("no bundle path to drag".into());
    }
    if !std::path::Path::new(&state.grant_path).exists() {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=path_missing"));
        return Err(format!("bundle path does not exist: {}", state.grant_path));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Err("native drag is macOS-only".into())
    }

    #[cfg(target_os = "macos")]
    {
        let path = state.grant_path.clone();
        let armed = run_on_main_and_wait(&app, {
            let path = path.clone();
            move |app| arm_drag_monitor_on_main(app, path.clone())
        })
        .await?;
        armed.map(|()| path)
    }
}

/// Stand down an armed drag (the press ended without one, or the panel is
/// going away). Idempotent and safe to call when nothing is armed.
#[tauri::command]
pub async fn permission_guide_cancel_drag(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        run_on_main_and_wait::<(), _>(&app, |_| disarm_drag_monitor_on_main()).await
    }
}

/// Run `f` on the main thread and await its result without parking a runtime
/// worker on a blocking `recv` (a wedged main thread must not cost a tokio
/// thread for the duration).
#[cfg(target_os = "macos")]
async fn run_on_main_and_wait<T, F>(app: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> T + Send + 'static,
{
    let app_main = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&app_main));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| format!("main thread did not answer: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// MAIN THREAD ONLY. Begin the dragging session from `event` — the user's own
/// left-mouse-drag, handed to us synchronously by the local monitor.
#[cfg(target_os = "macos")]
fn begin_grant_drag_with_event(
    app: &AppHandle,
    path: &str,
    event: *mut objc2::runtime::AnyObject,
) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    let Some(window) = app.get_webview_window(GUIDE_WINDOW_LABEL) else {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_window"));
        return Err("guide window is gone".into());
    };
    let ns_win = window.ns_window().map_err(|e| e.to_string())?;
    if ns_win.is_null() {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=null_ns_window"));
        return Err("guide window has no NSWindow".into());
    }
    let win = ns_win as *mut AnyObject;
    let Some(source) = drag_source_instance() else {
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_drag_source"));
        return Err("could not create the drag source".into());
    };

    // SAFETY: main thread, inside AppKit's event dispatch; `win` is a live
    // NSWindow and `event` a live NSEvent. Every selector below is public
    // AppKit. Objects we create are explicitly released at the end of the
    // frame — except the source, which the session holds *unretained* and
    // which is therefore a deliberate process-lifetime singleton.
    unsafe {
        // The seed event must belong to THIS window. A monitor sees every
        // local event, and a drag that started in System Settings would give
        // us coordinates in a foreign window and a session that tracks
        // nothing.
        let event_window: *mut AnyObject = msg_send![event, window];
        if event_window != win {
            return Err("drag event belongs to another window".into());
        }

        let view: *mut AnyObject = msg_send![win, contentView];
        if view.is_null() {
            log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_content_view"));
            return Err("guide window has no content view".into());
        }

        // The file URL. NSURL is an NSPasteboardWriting, so the dragging item
        // publishes `public.file-url` — the representation System Settings
        // reads when it decides whether to highlight.
        let ns_path: *mut AnyObject = {
            let s: *mut AnyObject = msg_send![class!(NSString), alloc];
            msg_send![s, initWithBytes: path.as_ptr(),
                         length: path.len(),
                         encoding: 4usize] // NSUTF8StringEncoding
        };
        if ns_path.is_null() {
            return Err("could not encode the bundle path".into());
        }
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns_path];
        if url.is_null() {
            objc2::ffi::objc_release(ns_path.cast());
            return Err("could not build a file URL for the bundle".into());
        }

        let item: *mut AnyObject = msg_send![class!(NSDraggingItem), alloc];
        let item: *mut AnyObject = msg_send![item, initWithPasteboardWriter: url];
        if item.is_null() {
            objc2::ffi::objc_release(ns_path.cast());
            return Err("could not build the dragging item".into());
        }

        // Drag image: the bundle's own Finder icon, so what the user drags
        // looks like the app they are being asked to add.
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let icon: *mut AnyObject = msg_send![workspace, iconForFile: ns_path];

        // Centre the image on the pointer, in the view's coordinates.
        let win_point: CGPoint = msg_send![event, locationInWindow];
        let local: CGPoint =
            msg_send![view, convertPoint: win_point, fromView: std::ptr::null::<AnyObject>()];
        let frame = CGRect {
            origin: CGPoint {
                x: local.x - DRAG_IMAGE_EDGE / 2.0,
                y: local.y - DRAG_IMAGE_EDGE / 2.0,
            },
            size: CGSize { width: DRAG_IMAGE_EDGE, height: DRAG_IMAGE_EDGE },
        };
        if icon.is_null() {
            // A dragging item with nil contents drags nothing visible (and can
            // raise). Frame-only keeps the session valid; the pasteboard —
            // the part System Settings actually reads — is unaffected.
            let _: () = msg_send![item, setDraggingFrame: frame];
        } else {
            let edge = CGSize { width: DRAG_IMAGE_EDGE, height: DRAG_IMAGE_EDGE };
            let _: () = msg_send![icon, setSize: edge];
            let _: () = msg_send![item, setDraggingFrame: frame, contents: icon];
        }

        let items: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: item];

        let session: *mut AnyObject =
            msg_send![view, beginDraggingSessionWithItems: items, event: event, source: source];

        // The session retains the items it needs; ours are +1 from alloc/init.
        objc2::ffi::objc_release(item.cast());
        objc2::ffi::objc_release(ns_path.cast());

        if session.is_null() {
            log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_FAILED} reason=no_session"));
            return Err("AppKit refused to begin the dragging session".into());
        }
        log(LOG_TAG, &format!("{MARK_GUIDE_DRAG_BEGAN} path={path}"));
    }

    Ok(())
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

    // ---------------------------------------------------------------------
    // LIVE-CAPTURE FIX (BUG 2): never activate HQ on a click.
    //
    // `.focusable(false)` only stops the window becoming *key*. AppKit still
    // ACTIVATES the owning application when any of its ordinary NSWindows is
    // clicked, and activation raises every other window of that app — so the
    // first mousedown on the overlay pulled the main HQ window in front of
    // exactly the content the user was trying to capture.
    //
    // The only AppKit construct that suppresses click-to-activate is an
    // NSPanel carrying `NSWindowStyleMaskNonactivatingPanel`. Promote the
    // window's class to NSPanel and OR that bit into its style mask.
    #[cfg(target_os = "macos")]
    make_window_nonactivating_panel(&window);

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

/// `NSWindowStyleMaskNonactivatingPanel` (AppKit, `1 << 7`). Only meaningful
/// on an `NSPanel`; on a plain `NSWindow` the bit is ignored, which is exactly
/// why the overlay has to be promoted to a panel as well.
pub const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;

/// The style mask an overlay window must end up with so clicking it never
/// activates HQ. Pure so the contract is unit-testable without AppKit.
///
/// Regression guard for the live bug where dragging on the overlay brought the
/// main HQ window to the front and covered the capture target.
pub fn nonactivating_panel_style_mask(current: u64) -> u64 {
    current | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL
}

/// True when `mask` will not activate the application on click.
pub fn mask_is_nonactivating(mask: u64) -> bool {
    mask & NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL != 0
}

/// MAIN THREAD ONLY. Promote a Tauri window's `NSWindow` to a non-activating
/// `NSPanel` so clicks and drags on it never activate HQ or raise HQ's other
/// windows. No-op off macOS.
#[cfg(target_os = "macos")]
fn make_window_nonactivating_panel(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let Ok(ns_win) = window.ns_window() else {
        log(LOG_TAG, "overlay setup: ns_window() unavailable; overlay may activate HQ on click");
        return;
    };
    if ns_win.is_null() {
        log(LOG_TAG, "overlay setup: ns_window() null; overlay may activate HQ on click");
        return;
    }
    let obj = ns_win as *mut AnyObject;
    // SAFETY: main thread, live NSWindow. `object_setClass` to NSPanel is the
    // documented-by-practice promotion used by non-activating overlay panels
    // (the same move `tauri-nspanel` makes); NSPanel adds no instance variables
    // over NSWindow.
    //
    // COUPLING: this replaces tao's `TaoWindow` subclass, so tao's
    // `canBecomeKeyWindow` override and its `focusable` ivar go with it.
    // NSPanel's own non-activating semantics take over, which is what we want —
    // but it means `window.set_focusable(..)` must NEVER be called on the
    // overlay (it would read a now-absent ivar). The overlay hosts no text
    // input by design (repo policy
    // `hq-desktop-app-nonactivating-window-toggle-focusable-for-input`), so
    // nothing needs it; the toast and the permission guide keep their own
    // unmodified windows for that.
    unsafe {
        let panel_class: *const objc2::runtime::AnyClass = class!(NSPanel);
        let _ = objc2::ffi::object_setClass(obj, panel_class);
        let current: u64 = msg_send![obj, styleMask];
        let _: () = msg_send![obj, setStyleMask: nonactivating_panel_style_mask(current)];
        let _: () = msg_send![obj, setFloatingPanel: true];
        let _: () = msg_send![obj, setBecomesKeyOnlyIfNeeded: true];
        let _: () = msg_send![obj, setHidesOnDeactivate: false];
        // A non-activating panel never becomes key and
        // `acceptsMouseMovedEvents` defaults to NO, so mouse-moved events
        // would never reach its view. Correct and free to set; the native
        // tracker (`arm_overlay_drag_tracker`) is what the drag actually
        // depends on, because this flag does nothing for the missing
        // `mouseUp` that also broke the gesture.
        let _: () = msg_send![obj, setAcceptsMouseMovedEvents: true];
        let accepts_moved: bool = msg_send![obj, acceptsMouseMovedEvents];
        let applied: u64 = msg_send![obj, styleMask];
        log(
            LOG_TAG,
            &format!(
                "overlay setup: non-activating panel styleMask={applied:#x} nonactivating={} acceptsMouseMoved={accepts_moved}",
                mask_is_nonactivating(applied)
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// US-003 regression: NATIVE overlay drag tracking
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS (read before "simplifying" it back into DOM handlers).
//
// The overlay window is a non-activating `NSPanel` (see
// `make_window_nonactivating_panel`) so a capture never raises HQ's own
// windows over the content being captured. That promotion is load-bearing and
// must not be reverted. But a panel that never becomes key is a hostile host
// for a WebView drag gesture:
//
//   * `NSWindow.acceptsMouseMovedEvents` defaults to NO, so `mouseMoved:` is
//     never delivered to the panel's view at all and the WebView never sees a
//     DOM `mousemove` — no crosshair, no growing rect.
//   * The hand-test also showed **`mouseup` missing**: the 0x0 selection
//     stayed on screen and simply re-anchored on the next click, and the app
//     log recorded zero `release` marks across two attempts. A missing
//     `mouseUp` is NOT explained by `acceptsMouseMovedEvents` (a mouse-up is
//     not a mouse-moved event), so "just set that flag" cannot be the whole
//     fix — only `mousedown`, the one event AppKit routes to a non-key panel
//     unconditionally, was ever arriving.
//
// So the gesture is tracked by AppKit, not by the WebView. A local monitor
// (events dispatched to HQ) plus a global monitor (events dispatched to
// whatever app the user is actually in — the normal case for a background
// overlay) watch left mouse down / dragged / up and mouse moved, convert the
// screen point into the overlay window's own logical space, and push the
// selection to the webview, which is now a pure renderer. The release is run
// by Rust from the native mouse-up; the webview no longer has to see a single
// mouse event for a capture to work.
//
// `setAcceptsMouseMovedEvents:YES` is still applied (see
// `make_window_nonactivating_panel`) because it is correct and costs nothing,
// but nothing here depends on it.

/// Selection/pointer updates pushed to the overlay webview by the native
/// tracker. Payload: `{ phase, selection, pointer }`.
pub const EVENT_DRAG: &str = "capture-overlay:drag";

/// Mark: the native drag tracker is watching (overlay shown).
pub const MARK_DRAG_ARMED: &str = "idea.capture.overlay_drag_armed";
/// Mark: the native drag tracker could not be armed (` reason=...`).
pub const MARK_DRAG_ARM_FAILED: &str = "idea.capture.overlay_drag_arm_failed";

/// `NSEventTypeMouseMoved`.
pub const NS_EVENT_TYPE_MOUSE_MOVED: u64 = 5;

/// The event mask the overlay's own tracker arms.
///
/// Down/dragged/up are the gesture itself; moved only feeds the idle
/// crosshair.
pub fn overlay_drag_event_mask() -> u64 {
    (1 << NS_EVENT_TYPE_LEFT_MOUSE_DOWN)
        | (1 << NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED)
        | (1 << NS_EVENT_TYPE_LEFT_MOUSE_UP)
        | (1 << NS_EVENT_TYPE_MOUSE_MOVED)
}

/// Does `mask` carry a whole drag gesture without help from the WebView?
///
/// The regression this guards: a tracker that watches only `mouseMoved` (or
/// only `dragged`) leaves the release depending on a DOM `mouseup` that a
/// non-key panel never delivers — exactly the shipped defect.
pub fn mask_tracks_whole_gesture(mask: u64) -> bool {
    let needed = (1 << NS_EVENT_TYPE_LEFT_MOUSE_DOWN)
        | (1 << NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED)
        | (1 << NS_EVENT_TYPE_LEFT_MOUSE_UP);
    mask & needed == needed
}

/// Convert an AppKit screen point (origin = bottom-left of the primary
/// display, points) into the overlay window's own logical CSS px (origin =
/// the overlay's top-left) — the space `SelectionRect` is defined in.
///
/// `frame` is the overlay `NSWindow`'s frame as `(x, y, w, h)` in the same
/// AppKit screen space. Going through the window's own frame (rather than
/// tao's virtual-desktop coordinates) means no primary-screen-height constant
/// and no AppKit/tao origin mismatch on multi-display setups.
pub fn overlay_point_from_screen(frame: (f64, f64, f64, f64), mouse: (f64, f64)) -> (f64, f64) {
    (mouse.0 - frame.0, (frame.1 + frame.3) - mouse.1)
}

/// Normalize a drag into the rect shape the capture path consumes. Negative
/// drags (right-to-left / bottom-to-top) come out with non-negative extents.
pub fn drag_rect(anchor: (f64, f64), end: (f64, f64)) -> SelectionRect {
    SelectionRect {
        x: anchor.0.min(end.0).round(),
        y: anchor.1.min(end.1).round(),
        width: (end.0 - anchor.0).abs().round(),
        height: (end.1 - anchor.1).abs().round(),
    }
}

/// The overlay frame cached when the tracker armed (the overlay does not move
/// while shown), as AppKit `(x, y, w, h)`.
static OVERLAY_FRAME: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

/// The live drag anchor in overlay-logical px; `None` when no drag is down.
static OVERLAY_DRAG_ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// Armed overlay event monitors (retained `id`s) — local and global.
#[cfg(target_os = "macos")]
static OVERLAY_DRAG_MONITORS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

/// MAIN THREAD ONLY. Stop tracking. Idempotent.
pub fn disarm_overlay_drag_tracker() {
    if let Ok(mut a) = OVERLAY_DRAG_ANCHOR.lock() {
        *a = None;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let mut slot = OVERLAY_DRAG_MONITORS.lock().unwrap_or_else(|p| p.into_inner());
        for ptr in slot.drain(..) {
            // SAFETY: main thread; each `ptr` is a monitor object AppKit
            // returned and we retained.
            unsafe {
                let obj = ptr as *mut AnyObject;
                let _: () = msg_send![class!(NSEvent), removeMonitor: obj];
                objc2::ffi::objc_release(obj.cast());
            }
        }
    }
}

/// MAIN THREAD ONLY. Push the crosshair cursor. A background, non-key panel
/// does not get to set the cursor through CSS (`cursor: crosshair` on the
/// WebView is only honoured for the key window's cursor rects), so the
/// overlay asks AppKit directly on every tracked event.
#[cfg(target_os = "macos")]
fn push_crosshair_cursor() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    // SAFETY: main thread; `crosshairCursor` is a public AppKit class method
    // returning an autoreleased NSCursor, and `set` takes no arguments.
    unsafe {
        let cursor: *mut AnyObject = msg_send![class!(NSCursor), crosshairCursor];
        if !cursor.is_null() {
            let _: () = msg_send![cursor, set];
        }
    }
}

/// One tracked native event, already in overlay-logical coordinates.
/// Returns the payload to push to the webview, if any.
fn on_tracked_event(app: &AppHandle, ty: u64, point: (f64, f64)) {
    if !OVERLAY_VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    let anchor = OVERLAY_DRAG_ANCHOR.lock().ok().and_then(|a| *a);
    match ty {
        NS_EVENT_TYPE_LEFT_MOUSE_DOWN => {
            if let Ok(mut a) = OVERLAY_DRAG_ANCHOR.lock() {
                *a = Some(point);
            }
            emit_drag(app, "start", Some(drag_rect(point, point)), point);
        }
        NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED => {
            let Some(anchor) = anchor else { return };
            emit_drag(app, "move", Some(drag_rect(anchor, point)), point);
        }
        NS_EVENT_TYPE_LEFT_MOUSE_UP => {
            let Some(anchor) = anchor else { return };
            if let Ok(mut a) = OVERLAY_DRAG_ANCHOR.lock() {
                *a = None;
            }
            let rect = drag_rect(anchor, point);
            emit_drag(app, "end", Some(rect), point);
            // USE-AFTER-FREE GUARD — do NOT inline this call.
            //
            // We are running INSIDE AppKit's dispatch of the monitor block,
            // and AppKit's copy of that block is its only strong reference.
            // The release hides the overlay, `hide_overlay` disarms the
            // tracker, and `removeMonitor:` + release would free this very
            // block — its code and its captured `AppHandle` — while this
            // frame is still running and still has to return the event. Same
            // hazard `schedule_disarm` documents for the permission-guide
            // monitor. `run_on_main_thread` posts to the next main-thread
            // turn, by which time the handler has returned.
            let deferred = app.clone();
            let _ = app.run_on_main_thread(move || release_selection_on_main(&deferred, rect));
        }
        NS_EVENT_TYPE_MOUSE_MOVED => {
            if anchor.is_some() {
                return;
            }
            emit_drag(app, "pointer", None, point);
        }
        _ => {}
    }
}

fn emit_drag(app: &AppHandle, phase: &str, selection: Option<SelectionRect>, point: (f64, f64)) {
    let _ = app.emit_to(
        WINDOW_LABEL,
        EVENT_DRAG,
        serde_json::json!({
            "phase": phase,
            "selection": selection,
            "pointer": { "x": point.0, "y": point.1 },
        }),
    );
}

/// MAIN THREAD ONLY. Arm the native tracker for the currently shown overlay.
/// No-op off macOS (where the WebView's own DOM events are delivered normally
/// and the frontend fallback path drives the drag).
#[allow(unused_variables)]
pub fn arm_overlay_drag_tracker(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};

        disarm_overlay_drag_tracker();

        let Ok(ns_win) = window.ns_window() else {
            log(LOG_TAG, &format!("{MARK_DRAG_ARM_FAILED} reason=no_ns_window"));
            return;
        };
        if ns_win.is_null() {
            log(LOG_TAG, &format!("{MARK_DRAG_ARM_FAILED} reason=null_ns_window"));
            return;
        }
        // SAFETY: main thread, live NSWindow. `frame` returns an NSRect
        // (== CGRect on 64-bit macOS) by value.
        use objc2_core_foundation::CGRect;
        let frame: CGRect = unsafe { msg_send![ns_win as *mut AnyObject, frame] };
        let frame = (frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        // Poison-tolerant: a leaked-but-still-installed monitor would keep
        // firing for the life of the process, so never skip the bookkeeping.
        *OVERLAY_FRAME.lock().unwrap_or_else(|p| p.into_inner()) = Some(frame);

        // The reticle is the NATIVE crosshair cursor (the overlay no longer
        // paints one in the DOM). Push it once at arm time so the very first
        // frame already shows it even if the mouse never moves.
        push_crosshair_cursor();

        let mask = overlay_drag_event_mask();

        // Shared per-event work: read the *global* mouse location (valid for
        // both monitor kinds, and for a global event that carries no window),
        // convert into overlay space, and act.
        let handle = |app: &AppHandle, event: *mut AnyObject| {
            if event.is_null() {
                return;
            }
            // SAFETY: inside AppKit's dispatch on the main thread; `event` is
            // a live NSEvent and `mouseLocation` is a class method returning
            // an NSPoint of plain doubles.
            let ty: u64 = unsafe { msg_send![event, type] };
            let loc: objc2_core_foundation::CGPoint =
                unsafe { msg_send![class!(NSEvent), mouseLocation] };
            let frame = (*OVERLAY_FRAME.lock().unwrap_or_else(|p| p.into_inner())).unwrap_or(frame);
            // Not on mouse-up: the gesture is over and the foreground app
            // should get its own cursor back on the next cursor-rect update.
            if ty != NS_EVENT_TYPE_LEFT_MOUSE_UP {
                push_crosshair_cursor();
            }
            on_tracked_event(app, ty, overlay_point_from_screen(frame, (loc.x, loc.y)));
        };

        let local_app = app.clone();
        let local_handle = handle;
        let local = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            local_handle(&local_app, event);
            event
        });
        let global_app = app.clone();
        let global_handle = handle;
        let global = RcBlock::new(move |event: *mut AnyObject| {
            global_handle(&global_app, event);
        });

        let mut armed: Vec<usize> = Vec::new();
        // SAFETY: main thread; AppKit copies each handler block and we retain
        // the returned monitors so `removeMonitor:` has something valid.
        unsafe {
            let l: *mut AnyObject = msg_send![
                class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: mask,
                handler: &*local,
            ];
            if !l.is_null() {
                objc2::ffi::objc_retain(l.cast());
                armed.push(l as usize);
            }
            // A background overlay's events are dispatched to the user's OWN
            // app, not to HQ, so the global monitor — not the local one — is
            // the load-bearing half. Mouse monitors need no Accessibility
            // grant (only keyboard ones do).
            let g: *mut AnyObject = msg_send![
                class!(NSEvent),
                addGlobalMonitorForEventsMatchingMask: mask,
                handler: &*global,
            ];
            if !g.is_null() {
                objc2::ffi::objc_retain(g.cast());
                armed.push(g as usize);
            }
        }
        if armed.is_empty() {
            log(LOG_TAG, &format!("{MARK_DRAG_ARM_FAILED} reason=no_monitor"));
            return;
        }
        *OVERLAY_DRAG_MONITORS.lock().unwrap_or_else(|p| p.into_inner()) = armed;
        log(LOG_TAG, &format!("{MARK_DRAG_ARMED} mask={mask:#x}"));
    }
}

// ---------------------------------------------------------------------------
// US-005: capture toast (undo / note / reassign / open)
// ---------------------------------------------------------------------------

/// Window label — kept in sync with `main.ts`'s router branch and
/// `capabilities/capture-toast.json`.
pub const TOAST_WINDOW_LABEL: &str = "capture-toast";

/// Event carrying the captured `CaptureRecord` JSON (same shape as
/// `capture:completed`), delivered to the toast window specifically.
pub const EVENT_TOAST_SHOW: &str = "capture-toast:show";

/// Toast window dimensions and screen margin (logical points).
const TOAST_W: f64 = 360.0;
const TOAST_H: f64 = 168.0;
const TOAST_MARGIN: f64 = 16.0;

/// Mark: the toast window `show()` returned Ok.
pub const MARK_TOAST_SHOWN: &str = "idea.capture.toast_shown";

/// The most recently captured record, held until the toast webview's ready
/// handshake (`capture_toast_ready`) can deliver it — mirrors
/// `PENDING_PROVENANCE`'s pattern, since `show_capture_toast` can run before
/// the webview has mounted its listeners.
static PENDING_TOAST: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// Build the hidden capture-toast window at app start (idempotent). Mirrors
/// `setup_capture_overlay_window`: pre-rendered so `show_capture_toast` only
/// has to position + show it, never construct it, on the capture path.
///
/// Built **non-activating** (`.focusable(false)`) per repo policy
/// `hq-desktop-app-nonactivating-window-toggle-focusable-for-input` — the
/// toast only becomes focusable (so its note field can type) via
/// `set_capture_toast_focusable`, when the user presses N or clicks in.
pub fn setup_capture_toast_window(app: &AppHandle) {
    if app.get_webview_window(TOAST_WINDOW_LABEL).is_some() {
        log(LOG_TAG, "toast setup: window already exists");
        return;
    }

    let build = WebviewWindowBuilder::new(
        app,
        TOAST_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("HQ Capture Toast")
    .inner_size(TOAST_W, TOAST_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible_on_all_workspaces(true)
    .visible(false)
    .build();

    let window = match build {
        Ok(w) => w,
        Err(e) => {
            log(LOG_TAG, &format!("toast setup: WebviewWindowBuilder FAILED: {e}"));
            return;
        }
    };

    // Clear WKWebView's underPageBackgroundColor so the transparent page does
    // not sit on a system-gray sheet (same idiom as the overlay/widget/banner).
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
        &format!("toast setup: pre-rendered hidden window {TOAST_W}x{TOAST_H}"),
    );
}

/// Bottom-right anchored logical origin for a `w`x`h` window on `display`,
/// inset by `margin` on both edges. Pure so it is unit-testable without a
/// live window; `show_capture_toast` is the only caller.
pub fn toast_position(display: &DisplayRect, w: f64, h: f64, margin: f64) -> (f64, f64) {
    (
        display.x + display.w - w - margin,
        display.y + display.h - h - margin,
    )
}

/// Stash `record` and show the toast anchored bottom-right on the display the
/// overlay was last shown on (falling back to the primary monitor). Runs on
/// the main thread because window positioning/show is main-thread-only.
fn show_capture_toast(app: &AppHandle, record: &CaptureRecord) {
    let value = match serde_json::to_value(record) {
        Ok(v) => v,
        Err(e) => {
            log(LOG_TAG, &format!("toast record serialize FAILED: {e}"));
            return;
        }
    };
    if let Ok(mut slot) = PENDING_TOAST.lock() {
        *slot = Some(value.clone());
    }

    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(TOAST_WINDOW_LABEL) else {
            return;
        };
        let display = SHOWN_DISPLAY
            .lock()
            .ok()
            .and_then(|d| *d)
            .or_else(|| app_main.primary_monitor().ok().flatten().map(|m| monitor_rect(&m)))
            .unwrap_or(DisplayRect { x: 0.0, y: 0.0, w: 1440.0, h: 900.0, scale: 1.0 });
        let (x, y) = toast_position(&display, TOAST_W, TOAST_H, TOAST_MARGIN);

        #[cfg(target_os = "macos")]
        {
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        }

        match window.show() {
            Ok(()) => log(LOG_TAG, MARK_TOAST_SHOWN),
            Err(e) => log(LOG_TAG, &format!("toast show FAILED: {e}")),
        }
        let _ = app_main.emit_to(TOAST_WINDOW_LABEL, EVENT_TOAST_SHOW, value.clone());
    });
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
        // US-014: the first refusal gets the guided panel (macOS only); once
        // the user has closed that panel without granting, fall back to the
        // one-line banner rather than re-opening something they rejected.
        match denial_response(
            GUIDE_DISMISSED.load(Ordering::SeqCst),
            cfg!(target_os = "macos"),
        ) {
            DenialResponse::Guide => show_permission_guide(app),
            DenialResponse::Banner => prompt_for_screen_recording(app),
        }
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
            // The gesture is tracked natively — see `arm_overlay_drag_tracker`.
            // Armed AFTER the visibility flag, which the handler gates on.
            arm_overlay_drag_tracker(app, &window);
            defer_escape_binding(app);
        }
        Err(e) => log(LOG_TAG, &format!("overlay show FAILED: {e}")),
    }
}

/// MAIN THREAD ONLY. Hide the overlay without capturing anything.
pub fn hide_overlay(app: &AppHandle, reason: &str) {
    let was_visible = OVERLAY_VISIBLE.swap(false, Ordering::SeqCst);
    // The number is only an anchor while the window is on screen. Clearing it
    // here means a stale one can never survive into a later grab.
    OVERLAY_WINDOW_NUMBER.store(0, Ordering::SeqCst);
    disarm_overlay_drag_tracker();
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

/// Toast webview handshake: if a capture is waiting, deliver it and show the
/// window. Idempotent — a capture already shown is simply re-delivered.
#[tauri::command]
pub fn capture_toast_ready(app: AppHandle) -> Result<(), String> {
    log(LOG_TAG, "toast webview ready");
    let pending = PENDING_TOAST.lock().ok().and_then(|s| s.clone());
    let Some(record) = pending else {
        return Ok(());
    };
    app.emit_to(TOAST_WINDOW_LABEL, EVENT_TOAST_SHOW, record)
        .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window(TOAST_WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Frontend-initiated dismiss: hide (never close) and reset focusable so the
/// next show starts non-activating again.
#[tauri::command]
pub async fn dismiss_capture_toast(app: AppHandle) -> Result<(), String> {
    // Drop the pending record too: a webview reload after a dismiss (or after
    // an undo deleted the record) must not resurface a stale toast through the
    // `capture_toast_ready` handshake.
    if let Ok(mut slot) = PENDING_TOAST.lock() {
        *slot = None;
    }
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(TOAST_WINDOW_LABEL) else {
            return;
        };
        let _ = window.hide();
        if let Err(e) = window.set_focusable(false) {
            log(LOG_TAG, &format!("dismiss_capture_toast: set_focusable failed: {e}"));
        }
    })
    .map_err(|e| e.to_string())
}

/// Toggle the toast's focusable state so its note field can take keyboard
/// input. Per policy `hq-desktop-app-nonactivating-window-toggle-focusable-
/// for-input` the toast is built non-activating and only becomes focusable
/// when the user presses N or clicks into it (mirrors
/// `widget::set_widget_focusable`).
#[tauri::command]
pub async fn set_capture_toast_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(TOAST_WINDOW_LABEL) else {
            return;
        };
        match window.set_focusable(focusable) {
            Ok(()) => {
                log(
                    LOG_TAG,
                    &format!("set_capture_toast_focusable: focusable={focusable}"),
                );
                if focusable {
                    if let Err(e) = window.set_focus() {
                        log(
                            LOG_TAG,
                            &format!("set_capture_toast_focusable: set_focus failed: {e}"),
                        );
                    }
                }
            }
            Err(e) => log(
                LOG_TAG,
                &format!("set_capture_toast_focusable: set_focusable failed: {e}"),
            ),
        }
    })
    .map_err(|e| e.to_string())
}

/// Focus/open the desktop workspace window on the captured idea's board
/// route.
#[tauri::command]
pub async fn ideas_open_board(app: AppHandle, id: String) -> Result<(), String> {
    crate::commands::desktop_alt::open_desktop_alt_window_inner(app, Some(&format!("ideas:{id}")))
        .await
}

/// Mark: the capture toast could not load its thumbnail. The live bug this
/// guards was invisible — the toast silently fell back to a placeholder.
pub const MARK_THUMB_FAILED: &str = "idea.capture.thumb_failed";

/// Bytes the toast thumbnail is allowed to pull back (matches the desktop
/// Files preview cap).
const MAX_THUMB_BYTES: u64 = 2 * 1024 * 1024;

/// The toast thumbnail payload — same field names as the desktop Files
/// preview so the renderer shape is unchanged.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreview {
    pub mime_type: String,
    pub data_base64: String,
}

/// Is `rel` an HQ-relative path to a capture image inside the ideas tree?
///
/// LIVE-CAPTURE FIX (BUG 3): the toast used to read its thumbnail through
/// `get_authorized_file_preview`, whose `enforce_desktop_read_scope` requires
/// a bound desktop *session* company. The capture toast is its own window and
/// never binds one, so every `companies/<slug>/ideas/<id>/image.png` thumbnail
/// failed with "company scope not bound" and was swallowed by the frontend's
/// silent `thumbFailed` fallback. Local-only captures under
/// `workspace/ideas-local/` carry no company segment and so happened to work,
/// which is why this never showed up before US-012 moved them apart.
///
/// This predicate is the whole authorization surface for the toast: it accepts
/// ONLY an `image.png` that the capture pipeline itself writes, under either
/// ideas root (see `hq_desktop_core::ideas::settings::ideas_root_relative`),
/// with no traversal segments. Symlinks are refused separately, at read time.
pub fn is_ideas_capture_image_rel(rel: &str) -> bool {
    if rel.contains('\\') || rel.starts_with('/') {
        return false;
    }
    let segments: Vec<&str> = rel.split('/').collect();
    if segments.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return false;
    }
    if segments.last() != Some(&"image.png") {
        return false;
    }
    match segments.as_slice() {
        ["companies", slug, "ideas", id, "image.png"] => {
            !slug.is_empty() && !id.is_empty()
        }
        // Local-only captures: `ideas_root_relative` yields
        // `workspace/ideas-local/{company}`, so the record dir is
        // `workspace/ideas-local/{company}/{id}`.
        ["workspace", "ideas-local", slug, id, "image.png"] => {
            !slug.is_empty() && !id.is_empty()
        }
        _ => false,
    }
}

/// Load the capture toast's thumbnail bytes for an ideas-tree image.
///
/// Deliberately NOT `get_authorized_file_preview`: that command is scoped to
/// the desktop Files session (see [`is_ideas_capture_image_rel`]). Every
/// failure is logged with a reason so a broken preview can never be invisible
/// again.
#[tauri::command]
pub async fn ideas_capture_preview(app: AppHandle, path: String) -> Result<CapturePreview, String> {
    let fail = |reason: &str| -> String {
        log(LOG_TAG, &format!("{MARK_THUMB_FAILED} reason={reason} path={path}"));
        reason.to_string()
    };
    if !is_ideas_capture_image_rel(&path) {
        return Err(fail("not-an-ideas-capture-image"));
    }
    let (hq_root, _slug) = resolve_vault_target(&app).map_err(|e| {
        log(LOG_TAG, &format!("{MARK_THUMB_FAILED} reason=vault detail={e}"));
        e
    })?;
    let absolute = hq_root.join(&path);
    // `symlink_metadata` does NOT follow links: a symlink planted in the ideas
    // tree must not turn this command into an arbitrary-file reader.
    let meta = std::fs::symlink_metadata(&absolute).map_err(|_| fail("missing"))?;
    if meta.file_type().is_symlink() {
        return Err(fail("symlink"));
    }
    if !meta.is_file() {
        return Err(fail("not-a-file"));
    }
    if meta.len() > MAX_THUMB_BYTES {
        return Err(fail("too-large"));
    }
    let bytes = std::fs::read(&absolute).map_err(|_| fail("unreadable"))?;
    use base64::Engine as _;
    Ok(CapturePreview {
        mime_type: "image/png".to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
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
    // Only the *cheap* half of provenance goes on the critical path. The
    // expensive half (`screenshot::resolve_frontmost`: a CGWindowList
    // enumeration plus accessibility round-trips into the captured app) blocks
    // until that app answers, bounded only by the AX messaging timeout — which
    // is larger than the whole release->png_written budget, and is exactly the
    // tail that showed up as a p50=37ms / p95=261ms split in US-004's bench.
    // It now runs in [`spawn_provenance`], after the PNG is on disk.
    let provenance = Provenance {
        app: snapshot.app.clone(),
        window_title: String::new(),
        url: None,
        captured_at: chrono::Utc::now(),
        display_id: screenshot::display_id_for_point(region.x, region.y),
    };
    // Two relaxed atomic loads off the cache primed by
    // `refresh_ideas_capture_prefs` — no menubar.json read, no lock, nothing
    // that can block between MARK_RELEASE and MARK_PNG_WRITTEN.
    let (image_max_edge, local_only) = ideas_capture_prefs();
    let new = NewCapture::pending(
        company_slug,
        CaptureImage::Decoded(image::DynamicImage::ImageRgba8(img)),
        provenance,
    )
    .with_image_max_edge(Some(image_max_edge))
    .with_local_only(local_only);
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
            show_capture_toast(app, &record);
            spawn_provenance(
                app.clone(),
                hq_root,
                record.company_slug.clone(),
                record.id.clone(),
                snapshot,
            );
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
    if !OVERLAY_VISIBLE.load(Ordering::SeqCst) {
        // The native tracker (`on_tracked_event`) already ran this release on
        // the mouse-up. A late DOM `mouseup` must not capture twice.
        return Ok(());
    }
    let empty = SHOWN_DISPLAY
        .lock()
        .ok()
        .and_then(|d| *d)
        .map(|d| selection_to_global(&d, &selection).is_none());
    let app_main = app.clone();
    app.run_on_main_thread(move || release_selection_on_main(&app_main, selection))
        .map_err(|e| e.to_string())?;
    match empty {
        None => Err("no display recorded for the overlay".to_string()),
        Some(true) => Err("empty selection".to_string()),
        Some(false) => Ok(()),
    }
}

/// Hide the overlay, then decide what the grab may exclude.
///
/// The order is the whole point, and is why this is one function rather than
/// two statements a later edit can quietly transpose: the exclusion must be
/// read from the overlay's state *after* it is off screen, never from a window
/// number remembered at show time. Running these two steps in the other order
/// is the black-capture defect.
fn release_grab_plan(hide: impl FnOnce()) -> Option<u32> {
    hide();
    grab_exclusion(
        OVERLAY_VISIBLE.load(Ordering::SeqCst),
        OVERLAY_WINDOW_NUMBER.load(Ordering::SeqCst),
    )
}

/// What the pixel grab may exclude, given the overlay's state *at grab time*.
///
/// `CGWindowListCreateImage`'s on-screen-below-window mode needs its anchor to
/// still be on screen. Ask it for "everything below window N" when N has
/// already been ordered out and it does not error — it hands back the calling
/// process's own layers over a black desktop, which is saved as a
/// convincing-looking black PNG.
///
/// The release path hides the overlay before grabbing (so the user's screen is
/// clean before any encoding starts), so by grab time there is nothing left to
/// exclude and the honest answer is `None` — the plain display grab, which is
/// exactly the path the one good capture of the owner's session took.
fn grab_exclusion(overlay_on_screen_at_grab: bool, window_number: u32) -> Option<u32> {
    if !overlay_on_screen_at_grab {
        return None;
    }
    match window_number {
        0 => None,
        n => Some(n),
    }
}

/// MAIN THREAD ONLY. The one release path: freeze the rect, hide the overlay,
/// and hand the pixels to the background capture thread.
///
/// Both entry points funnel through here — the native mouse-up tracked by
/// `arm_overlay_drag_tracker` (the path that actually runs on macOS) and the
/// `capture_region_release` command (the DOM fallback, and every non-macOS
/// host). It is idempotent by way of `OVERLAY_VISIBLE`: a second release for
/// the same gesture finds the overlay already hidden and does nothing.
pub fn release_selection_on_main(app: &AppHandle, selection: SelectionRect) {
    if !OVERLAY_VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    // Bare mark, first statement: the bench pairs this with png_written.
    log(LOG_TAG, MARK_RELEASE);

    let display = SHOWN_DISPLAY.lock().ok().and_then(|d| *d);
    let Some(display) = display else {
        log(LOG_TAG, &format!("{MARK_RELEASE_REJECTED} reason=no_display"));
        hide_overlay(app, "click");
        return;
    };
    let Some(region) = selection_to_global(&display, &selection) else {
        log(LOG_TAG, &format!("{MARK_RELEASE_REJECTED} reason=empty"));
        hide_overlay(app, "click");
        return;
    };
    let exclude = release_grab_plan(|| hide_overlay(app, "release"));

    let app_bg = app.clone();
    std::thread::spawn(move || capture_and_store(&app_bg, region, exclude));
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

/// Resolve the slow half of provenance (window title + document URL) *after*
/// the PNG is on disk, patch it into the stored record, then hand off to the
/// enrichment chain.
///
/// This is deliberately off the release->png_written critical path:
/// `resolve_frontmost` talks to the captured application over the
/// accessibility API and blocks until it answers or the AX messaging timeout
/// fires, which alone exceeds the 120ms capture budget.
///
/// Runs the enrichment chain itself (rather than racing it) so the two never
/// write `record.json` concurrently.
fn spawn_provenance(
    app: AppHandle,
    hq_root: std::path::PathBuf,
    company_slug: String,
    id: String,
    snapshot: screenshot::FrontmostSnapshot,
) {
    std::thread::spawn(move || {
        let info = screenshot::resolve_frontmost(&snapshot);
        if !info.window_title.is_empty() || info.url.is_some() {
            match load_record(&hq_root, &company_slug, &id) {
                Ok(mut record) => {
                    record.provenance.window_title = info.window_title;
                    record.provenance.url = info.url;
                    if !info.app.is_empty() {
                        record.provenance.app = info.app;
                    }
                    match save_record(&hq_root, &mut record) {
                        Ok(()) => match serde_json::to_value(&record) {
                            Ok(json) => {
                                let _ = app.emit(EVENT_CAPTURE_UPDATED, json);
                            }
                            Err(e) => log(
                                LOG_TAG,
                                &format!("capture provenance serialize FAILED: {e}"),
                            ),
                        },
                        Err(e) => log(
                            LOG_TAG,
                            &format!("provenance stage failed for record {id}: {e}"),
                        ),
                    }
                }
                Err(e) => log(
                    LOG_TAG,
                    &format!("provenance stage could not load record {id}: {e}"),
                ),
            }
        }
        spawn_enrichment(app, hq_root, company_slug, id);
    });
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

// ---------------------------------------------------------------------------
// US-009: board data surface (list captures + user kind/status correction)
// ---------------------------------------------------------------------------

/// Read every capture record for one company, newest first.
///
/// Deliberately lenient: a single unreadable or malformed `record.json` must
/// not blank the whole board, so bad entries are logged and skipped. A missing
/// ideas directory is an empty board, not an error.
///
/// **Both roots are scanned** (US-012 wiring): the synced vault root and the
/// local-only root. The sync preference decides where new captures are
/// *written*, never what the board can *see* — a user who turns sync off must
/// not watch their existing captures vanish, and one who turns it back on must
/// not lose the ones taken while it was off. Ids are deduped with the synced
/// copy winning, matching `storage::existing_record_dir`'s resolution order.
pub fn list_captures_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
) -> Result<Vec<CaptureRecord>, String> {
    let mut records: Vec<CaptureRecord> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for synced in [true, false] {
        let dir = ideas_root(hq_root, slug, synced).map_err(|e| e.to_string())?;
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // Dedupe on the *loaded* record, not on the directory entry: a
            // malformed directory in one root must not consume the id and
            // suppress a readable record for it in the other.
            match load_record(hq_root, slug, &id) {
                Ok(record) => {
                    if seen.insert(id) {
                        records.push(record);
                    }
                }
                Err(e) => log(LOG_TAG, &format!("skipping unreadable capture {id}: {e}")),
            }
        }
    }
    // Newest first; `created_at` ties break on the ULID id, which is itself
    // creation-ordered, so the order is stable across reads.
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(records)
}

/// Parse a snake_case kind/status pair coming from the board UI.
fn parse_kind_status(kind: &str, status: &str) -> Result<(CaptureKind, CaptureStatus), String> {
    let kind: CaptureKind =
        serde_json::from_value(serde_json::Value::String(kind.to_string()))
            .map_err(|_| format!("unknown capture kind: {kind}"))?;
    let status: CaptureStatus =
        serde_json::from_value(serde_json::Value::String(status.to_string()))
            .map_err(|_| format!("unknown capture status: {status}"))?;
    Ok((kind, status))
}

/// Apply the user's verdict on a low-confidence capture.
///
/// `extracted` is intentionally left in place even when the record becomes a
/// plain image: the extraction may still be useful later, and the board reads
/// `kind`/`status` — never `extracted` alone — to choose a layout. The sidecar
/// is refreshed by `save_record`, which funnels every write through the same
/// `capture.md` renderer, so the record and its index never drift.
pub fn set_kind_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
    id: &str,
    kind: &str,
    status: &str,
) -> Result<CaptureRecord, String> {
    let (kind, status) = parse_kind_status(kind, status)?;
    let mut record = load_record(hq_root, slug, id).map_err(|e| e.to_string())?;
    record.kind = kind;
    record.status = status;
    save_record(hq_root, &mut record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// List the active company's captures for the Ideas board (US-009).
#[tauri::command]
pub async fn ideas_list_captures(app: AppHandle) -> Result<Vec<CaptureRecord>, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    list_captures_in_vault(&hq_root, &slug)
}

/// Accept or reject a low-confidence classification from the board (US-009).
#[tauri::command]
pub async fn ideas_set_kind(
    app: AppHandle,
    id: String,
    kind: String,
    status: String,
) -> Result<CaptureRecord, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    let record = set_kind_in_vault(&hq_root, &slug, &id, &kind, &status)?;
    match serde_json::to_value(&record) {
        Ok(json) => {
            let _ = app.emit(EVENT_CAPTURE_UPDATED, json);
        }
        Err(e) => log(LOG_TAG, &format!("capture update serialize FAILED: {e}")),
    }
    spawn_reindex(record.id.clone());
    Ok(record)
}

// ---------------------------------------------------------------------------
// US-010: card detail — kind correction, note/tags, reassign, delete
// ---------------------------------------------------------------------------

/// Apply a user's kind correction from the card detail.
///
/// A hand correction is authoritative, so it always writes
/// `confidence = 1.0` and `extraction_source = User` — no later automatic pass
/// should be able to argue with a human. The status follows from the kind:
/// choosing `image` means "keep this as a plain screenshot" (`Plain`, the
/// board's plain render state); every other kind means the user asserted the
/// extraction, i.e. `Extracted`.
pub fn correct_kind_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
    id: &str,
    kind: &str,
) -> Result<CaptureRecord, String> {
    let parsed: CaptureKind = serde_json::from_value(serde_json::Value::String(kind.to_string()))
        .map_err(|_| format!("unknown capture kind: {kind}"))?;
    let status = if matches!(parsed, CaptureKind::Image) {
        CaptureStatus::Plain
    } else {
        CaptureStatus::Extracted
    };
    let mut record = load_record(hq_root, slug, id).map_err(|e| e.to_string())?;
    record.kind = parsed;
    record.status = status;
    record.confidence = Some(1.0);
    record.extraction_source = Some(ExtractionSource::User);
    save_record(hq_root, &mut record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Set (or clear) the free-text note on a capture.
///
/// A note that is empty or all whitespace is stored as `None` rather than
/// `Some("")`, so "cleared the note" and "never wrote one" are the same state
/// on disk and in the sidecar.
pub fn set_note_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
    id: &str,
    note: &str,
) -> Result<CaptureRecord, String> {
    let trimmed = note.trim();
    let mut record = load_record(hq_root, slug, id).map_err(|e| e.to_string())?;
    record.note = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    save_record(hq_root, &mut record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Normalize a tag list from the UI: trim each entry, drop empties, and drop
/// duplicates while preserving the order the user typed them in.
fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(tags.len());
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() || out.iter().any(|t| t == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

/// Replace the tag list on a capture.
pub fn set_tags_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
    id: &str,
    tags: &[String],
) -> Result<CaptureRecord, String> {
    let mut record = load_record(hq_root, slug, id).map_err(|e| e.to_string())?;
    record.tags = normalize_tags(tags);
    save_record(hq_root, &mut record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Company slugs (manifest order) that actually have a `companies/{slug}`
/// directory under `hq_root`.
///
/// Manifest-order rather than alphabetical so the reassign picker matches the
/// order the user sees everywhere else in HQ. Slugs listed in the manifest but
/// not present on this machine are skipped — moving a record into a directory
/// that does not exist locally would file it somewhere the user cannot see.
pub fn list_company_slugs(hq_root: &std::path::Path) -> Vec<String> {
    let companies_dir = hq_root.join("companies");
    read_manifest_slugs(hq_root)
        .into_iter()
        .filter(|s| companies_dir.join(s).is_dir())
        .collect()
}

/// Move a capture into another company's vault.
///
/// The destination is checked against [`list_company_slugs`] first: an
/// arbitrary string here would otherwise mint a new `companies/<whatever>`
/// tree and quietly file the record outside any real tenant.
pub fn move_capture_in_vault(
    hq_root: &std::path::Path,
    from_slug: &str,
    id: &str,
    to_company: &str,
) -> Result<CaptureRecord, String> {
    let available = list_company_slugs(hq_root);
    if !available.iter().any(|s| s == to_company) {
        return Err(format!(
            "unknown destination company: {to_company} (available: {})",
            available.join(", ")
        ));
    }
    move_record(hq_root, id, from_slug, to_company).map_err(|e| e.to_string())
}

/// Delete a capture outright (record.json, image.png, capture.md).
pub fn delete_capture_in_vault(
    hq_root: &std::path::Path,
    slug: &str,
    id: &str,
) -> Result<(), String> {
    delete_record(hq_root, slug, id).map_err(|e| e.to_string())
}

/// Emit [`EVENT_CAPTURE_UPDATED`] with a record, logging a serialize failure
/// rather than failing the command — the write already landed.
fn emit_capture_updated(app: &AppHandle, record: &CaptureRecord) {
    match serde_json::to_value(record) {
        Ok(json) => {
            let _ = app.emit(EVENT_CAPTURE_UPDATED, json);
        }
        Err(e) => log(LOG_TAG, &format!("capture update serialize FAILED: {e}")),
    }
}

/// Correct a capture's kind from the card detail (US-010).
#[tauri::command]
pub async fn ideas_correct_kind(
    app: AppHandle,
    id: String,
    kind: String,
) -> Result<CaptureRecord, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    let record = correct_kind_in_vault(&hq_root, &slug, &id, &kind)?;
    emit_capture_updated(&app, &record);
    spawn_reindex(record.id.clone());
    Ok(record)
}

/// Set or clear a capture's note (US-010).
#[tauri::command]
pub async fn ideas_set_note(
    app: AppHandle,
    id: String,
    note: String,
) -> Result<CaptureRecord, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    let record = set_note_in_vault(&hq_root, &slug, &id, &note)?;
    emit_capture_updated(&app, &record);
    spawn_reindex(record.id.clone());
    Ok(record)
}

/// Replace a capture's tags (US-010).
#[tauri::command]
pub async fn ideas_set_tags(
    app: AppHandle,
    id: String,
    tags: Vec<String>,
) -> Result<CaptureRecord, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    let record = set_tags_in_vault(&hq_root, &slug, &id, &tags)?;
    emit_capture_updated(&app, &record);
    spawn_reindex(record.id.clone());
    Ok(record)
}

/// Reassign a capture to another company (US-010).
///
/// Emits [`EVENT_CAPTURE_REMOVED`] rather than `capture:updated`: from the
/// active board's point of view the card is gone, and the moved record now
/// belongs to a vault this board is not showing.
#[tauri::command]
pub async fn ideas_move_capture(
    app: AppHandle,
    id: String,
    to_company: String,
) -> Result<CaptureRecord, String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    let record = move_capture_in_vault(&hq_root, &slug, &id, &to_company)?;
    let _ = app.emit(
        EVENT_CAPTURE_REMOVED,
        serde_json::json!({
            "id": id,
            "company_slug": slug,
            "reason": "moved",
            "to_company": to_company,
        }),
    );
    spawn_reindex(record.id.clone());
    Ok(record)
}

/// Delete a capture after the UI has confirmed (US-010).
#[tauri::command]
pub async fn ideas_delete_capture(app: AppHandle, id: String) -> Result<(), String> {
    let (hq_root, slug) = resolve_vault_target(&app)?;
    delete_capture_in_vault(&hq_root, &slug, &id)?;
    let _ = app.emit(
        EVENT_CAPTURE_REMOVED,
        serde_json::json!({
            "id": id,
            "company_slug": slug,
            "reason": "deleted",
        }),
    );
    // `qmd update` rescans the collection, so the deleted sidecar drops out of
    // search on this pass.
    spawn_reindex(id);
    Ok(())
}

/// Companies a capture can be reassigned to (US-010).
#[tauri::command]
pub async fn ideas_list_companies(app: AppHandle) -> Result<Vec<String>, String> {
    let (hq_root, _slug) = resolve_vault_target(&app)?;
    Ok(list_company_slugs(&hq_root))
}

#[cfg(test)]
mod hq_idea_board_capture_tests {
    use super::*;

    /// Drive the production release decision the way an app session does:
    /// show, release, show again, release again. AppKit gives the overlay no
    /// window number until its first order-in, so capture 1 saw 0 and every
    /// capture after it saw a real number — and the old code turned that
    /// difference into a below-window grab anchored on a window it had just
    /// hidden, i.e. a black PNG. Both cycles must produce the same plan.
    #[test]
    fn hq_idea_board_second_capture_takes_the_same_grab_path_as_the_first() {
        // What `NSWindow.windowNumber` returns at each successive show.
        let numbers_at_show = [0u32, 4271, 4271];
        let mut plans = Vec::new();
        for number in numbers_at_show {
            // ...what `show_overlay` records.
            OVERLAY_WINDOW_NUMBER.store(number, Ordering::SeqCst);
            OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
            // ...and what the release path does, hide included.
            plans.push(release_grab_plan(|| {
                OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
                OVERLAY_WINDOW_NUMBER.store(0, Ordering::SeqCst);
            }));
        }
        assert_eq!(
            plans[0], plans[1],
            "capture 2 took a different grab path than capture 1: {plans:?}"
        );
        assert_eq!(plans[1], plans[2], "capture 3 drifted again: {plans:?}");
        assert!(
            plans.iter().all(|p| p.is_none()),
            "the overlay is hidden before the grab, so there is nothing to \
             exclude - a below-window anchor here is the black capture: {plans:?}"
        );
        OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
        OVERLAY_WINDOW_NUMBER.store(0, Ordering::SeqCst);
    }

    /// A window number is only an anchor while its window is on screen.
    #[test]
    fn hq_idea_board_grab_exclusion_requires_an_on_screen_anchor() {
        // On screen with a real number: excluding it is meaningful.
        assert_eq!(grab_exclusion(true, 4271), Some(4271));
        // On screen but never ordered in: nothing to anchor on.
        assert_eq!(grab_exclusion(true, 0), None);
        // Already hidden: the number is stale no matter how real it looks.
        assert_eq!(grab_exclusion(false, 4271), None);
        assert_eq!(grab_exclusion(false, 0), None);
    }

    /// The stale number must not outlive the window being ordered out.
    #[test]
    fn hq_idea_board_release_plan_reads_state_after_the_hide_not_before() {
        OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
        OVERLAY_WINDOW_NUMBER.store(4271, Ordering::SeqCst);
        let mut hidden = false;
        let plan = release_grab_plan(|| {
            hidden = true;
            OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
            OVERLAY_WINDOW_NUMBER.store(0, Ordering::SeqCst);
        });
        assert!(hidden, "the plan must hide the overlay, not just read flags");
        assert_eq!(plan, None, "the plan was computed before the hide landed");
    }

    /// `hide_overlay` itself has to clear the number; the test above supplies
    /// its own closure, so pin the real function's behaviour to the source.
    #[test]
    fn hq_idea_board_hide_overlay_clears_the_window_number() {
        let src = std::fs::read_to_string(file!()).expect("own source");
        let body = src
            .split("pub fn hide_overlay(")
            .nth(1)
            .expect("hide_overlay defined");
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert!(
            body.contains("OVERLAY_WINDOW_NUMBER.store(0, Ordering::SeqCst)"),
            "hiding the overlay must clear its window number, or a stale \
             anchor survives into the next capture"
        );
    }

    #[test]
    fn hq_idea_board_list_captures_sorts_newest_first_and_skips_junk() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();

        // A missing ideas dir is an empty board, not an error.
        assert_eq!(list_captures_in_vault(hq_root, "alpha").unwrap().len(), 0);

        let mut ids = Vec::new();
        for i in 0..3 {
            let provenance = Provenance {
                app: format!("App{i}"),
                window_title: format!("Window {i}"),
                url: None,
                captured_at: chrono::Utc::now(),
                display_id: 1,
            };
            let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 4));
            let record = create_record(
                hq_root,
                NewCapture::pending("alpha", CaptureImage::Decoded(image), provenance),
            )
            .unwrap();
            ids.push(record.id);
            std::thread::sleep(std::time::Duration::from_millis(3));
        }

        // A malformed record and a stray file must not blank the board.
        let junk_dir = ideas_root(hq_root, "alpha", true).unwrap().join("01JJUNK0000000000000000000");
        std::fs::create_dir_all(&junk_dir).unwrap();
        std::fs::write(junk_dir.join("record.json"), b"{ not json").unwrap();
        std::fs::write(
            ideas_root(hq_root, "alpha", true).unwrap().join("README.txt"),
            b"hi",
        )
        .unwrap();

        let listed = list_captures_in_vault(hq_root, "alpha").unwrap();
        assert_eq!(listed.len(), 3);
        let listed_ids: Vec<String> = listed.iter().map(|r| r.id.clone()).collect();
        let mut expected = ids.clone();
        expected.reverse();
        assert_eq!(listed_ids, expected, "newest first");
    }

    #[test]
    fn hq_idea_board_set_kind_persists_user_verdict() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let provenance = Provenance {
            app: "Safari".to_string(),
            window_title: "X".to_string(),
            url: None,
            captured_at: chrono::Utc::now(),
            display_id: 1,
        };
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 4));
        let record = create_record(
            hq_root,
            NewCapture::pending("alpha", CaptureImage::Decoded(image), provenance),
        )
        .unwrap();

        let updated =
            set_kind_in_vault(hq_root, "alpha", &record.id, "image", "plain").unwrap();
        assert_eq!(updated.kind, CaptureKind::Image);
        assert_eq!(updated.status, CaptureStatus::Plain);
        let reloaded = load_record(hq_root, "alpha", &record.id).unwrap();
        assert_eq!(reloaded.kind, CaptureKind::Image);
        assert_eq!(reloaded.status, CaptureStatus::Plain);

        // Accepting keeps the kind and promotes the status.
        let accepted =
            set_kind_in_vault(hq_root, "alpha", &record.id, "x_post", "extracted").unwrap();
        assert_eq!(accepted.kind, CaptureKind::XPost);
        assert_eq!(accepted.status, CaptureStatus::Extracted);

        // Garbage strings are rejected before anything is written.
        assert!(set_kind_in_vault(hq_root, "alpha", &record.id, "nope", "plain").is_err());
        assert!(set_kind_in_vault(hq_root, "alpha", &record.id, "image", "nope").is_err());
        assert!(set_kind_in_vault(hq_root, "alpha", "01JMISSING", "image", "plain").is_err());
    }

    fn d(x: f64, y: f64, w: f64, h: f64) -> DisplayRect {
        DisplayRect { x, y, w, h, scale: 2.0 }
    }

    // ── US-005: capture toast ────────────────────────────────────────────

    #[test]
    fn hq_idea_board_toast_position_anchors_bottom_right() {
        let display = d(0.0, 0.0, 1440.0, 900.0);
        let (x, y) = toast_position(&display, 360.0, 168.0, 16.0);
        assert_eq!((x, y), (1440.0 - 360.0 - 16.0, 900.0 - 168.0 - 16.0));
    }

    #[test]
    fn hq_idea_board_toast_position_anchors_bottom_right_on_negative_origin_display() {
        // A non-primary display left of the primary has a negative x origin.
        let display = d(-2560.0, -200.0, 2560.0, 1440.0);
        let (x, y) = toast_position(&display, 360.0, 168.0, 16.0);
        assert_eq!(x, -2560.0 + 2560.0 - 360.0 - 16.0);
        assert_eq!(y, -200.0 + 1440.0 - 168.0 - 16.0);
        // Anchored inside the display, not the virtual desktop origin.
        assert!(x > display.x && x + 360.0 <= display.x + display.w);
        assert!(y > display.y && y + 168.0 <= display.y + display.h);
    }

    #[test]
    fn hq_idea_board_toast_window_is_built_non_activating() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");

        // Built non-activating.
        let setup_body = fn_body(&src, "fn setup_capture_toast_window(");
        assert!(
            setup_body.contains(".focusable(false)"),
            "capture-toast window must be built non-activating"
        );
        // The builder never flips it back on inside setup.
        assert!(!setup_body.contains("set_focusable"));

        // set_capture_toast_focusable is the only *runtime* toggle: it is the
        // sole function body in the file whose text contains a
        // `.set_focusable(` call driven by a parameter (not a literal).
        let toggle_body = fn_body(&src, "fn set_capture_toast_focusable(");
        assert!(
            toggle_body.contains("set_focusable(focusable)"),
            "set_capture_toast_focusable must toggle via its `focusable` param"
        );
        // Count only non-test source lines (the assertion text itself contains
        // the literal), so the check is not self-referential.
        let toggle_sites = src
            .lines()
            .filter(|l| l.trim_start().starts_with("window.set_focusable(focusable)")
                || l.trim_start().starts_with("match window.set_focusable(focusable)"))
            .count();
        // `set_capture_toast_focusable` is now the ONLY tao-level toggle. The
        // permission guide used to be the second, but the US-014 drag fix
        // promoted its window to a non-activating NSPanel — which replaces
        // tao's `TaoWindow` subclass and the `focusable` ivar
        // `set_focusable` reads. On macOS it now speaks to the NSPanel
        // directly (`becomesKeyOnlyIfNeeded`); calling tao there would read
        // state that no longer exists.
        assert_eq!(
            toggle_sites, 1,
            "set_capture_toast_focusable is the only sanctioned tao-level \
             focusable toggle; a second site means a window is flipping \
             focusable outside its own command"
        );
        let guide_toggle = fn_body(&src, "fn set_permission_guide_focusable(");
        assert!(
            guide_toggle.contains("set_guide_becomes_key_only_if_needed(&window, !focusable)"),
            "the guide panel must be made key-able through its NSPanel, driven \
             by its own `focusable` param"
        );
        // Every `set_focusable` reachable for THIS window must sit behind a
        // not(macos) gate: on macOS the window is a promoted NSPanel and tao's
        // setter reads an ivar the class no longer has, which panics.
        //
        // Scan the *production* half so the assertion text below is not itself
        // a match, and pair every guide-side call with the cfg line above it.
        let production = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let lines: Vec<&str> = production.lines().collect();
        let mut guide_calls = 0;
        for (i, line) in lines.iter().enumerate() {
            if !line.contains("window.set_focusable(") || line.trim_start().starts_with("//") {
                continue;
            }
            // The toast keeps an unmodified tao window, so its own toggles are
            // legitimate; only the guide's are gated.
            let context = lines[i.saturating_sub(14)..i].join("\n");
            if !context.contains("GUIDE_WINDOW_LABEL") {
                continue;
            }
            guide_calls += 1;
            let gate = if i == 0 { "" } else { lines[i - 1] };
            assert!(
                gate.contains("#[cfg(not(target_os = \"macos\"))]"),
                "guide set_focusable must be not(macos)-gated, got guard: {gate}"
            );
        }
        assert!(
            guide_calls >= 2,
            "expected the guide's hide + focusable-toggle call sites, found {guide_calls}"
        );
    }

    #[test]
    fn hq_idea_board_toast_label_matches_capability_file() {
        let cap_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/capture-toast.json"
        );
        let cap = std::fs::read_to_string(cap_path).expect("capture-toast.json is readable");
        let parsed: serde_json::Value = serde_json::from_str(&cap).expect("valid json");
        assert_eq!(
            parsed["identifier"].as_str(),
            Some("capture-toast"),
            "capability identifier drifted from TOAST_WINDOW_LABEL"
        );
        let windows = parsed["windows"]
            .as_array()
            .expect("windows array present");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].as_str(), Some(TOAST_WINDOW_LABEL));
        assert_eq!(parsed["identifier"].as_str(), Some(TOAST_WINDOW_LABEL));
    }

    #[test]
    fn hq_idea_board_show_capture_toast_runs_after_completed_emit_before_provenance() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");

        let body = fn_body(&src, "fn capture_and_store(");
        let png_mark = body
            .find("MARK_PNG_WRITTEN")
            .expect("capture_and_store logs the png_written mark");
        let completed_emit = body
            .find("EVENT_CAPTURE_COMPLETED")
            .expect("capture_and_store emits capture:completed");
        let toast_call = body
            .find("show_capture_toast(app, &record)")
            .expect("capture_and_store calls show_capture_toast");
        let provenance_call = body
            .find("spawn_provenance(")
            .expect("capture_and_store hands off to the deferred provenance stage");

        assert!(png_mark < completed_emit, "png mark must precede the completed emit");
        assert!(
            completed_emit < toast_call,
            "show_capture_toast must run after the capture:completed emit"
        );
        assert!(
            toast_call < provenance_call,
            "show_capture_toast must run before spawn_provenance"
        );
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

    /// US-004 tail-latency regression guard.
    ///
    /// `screenshot::resolve_frontmost` blocks on accessibility round-trips into
    /// the captured application (bounded only by the AX messaging timeout,
    /// which is larger than the whole 120ms release->png_written budget). It
    /// therefore must not run between the release mark and the PNG-written
    /// mark: `capture_and_store` may only reach it *after* it has logged
    /// `MARK_PNG_WRITTEN`, and it belongs to the deferred `spawn_provenance`
    /// stage. A GUI-free source check, because the only other way to catch the
    /// regression is a live driven capture against a slow frontmost app.
    #[test]
    fn hq_idea_board_provenance_resolution_is_off_the_release_to_png_path() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");

        let body = fn_body(&src, "fn capture_and_store(");
        let png_mark = body
            .find("MARK_PNG_WRITTEN")
            .expect("capture_and_store logs the png_written mark");
        match body.find("resolve_frontmost") {
            None => {}
            Some(at) => assert!(
                at > png_mark,
                "resolve_frontmost is back on the release->png critical path in capture_and_store"
            ),
        }

        let deferred = fn_body(&src, "fn spawn_provenance(");
        assert!(
            deferred.contains("resolve_frontmost"),
            "the deferred provenance stage must be the one that resolves frontmost"
        );
        assert!(
            deferred.contains("std::thread::spawn"),
            "the deferred provenance stage must not run inline on the capture thread"
        );
        // The heavy enrichment chain likewise stays behind the PNG mark.
        let enrich = body
            .find("spawn_provenance(")
            .expect("capture_and_store hands off to the deferred stage");
        assert!(enrich > png_mark, "enrichment handoff moved ahead of png_written");
    }

    /// US-012 wiring, same guard shape as the provenance one above.
    ///
    /// Resolving the user's Ideas preferences means reading `menubar.json`.
    /// That is a synchronous disk hit, and the release->png_written budget is
    /// p95 <= 120ms — the same budget commit a0ab3044 protected by moving
    /// provenance off this path. So `capture_and_store` must take the
    /// preferences from the cached atomics (`ideas_capture_prefs`) and must
    /// never reach the reader (`refresh_ideas_capture_prefs`) or the config
    /// file itself. A source check for the same reason the provenance guard is
    /// one: the alternative is noticing it in a benchmark after the fact.
    #[test]
    fn hq_idea_board_settings_resolution_is_off_the_release_to_png_path() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");

        let body = fn_body(&src, "fn capture_and_store(");
        let png_mark = body
            .find("MARK_PNG_WRITTEN")
            .expect("capture_and_store logs the png_written mark");

        // The settings the write path applies come from the cache, before the
        // PNG mark — reading them must cost two atomic loads, nothing more.
        let from_cache = body
            .find("ideas_capture_prefs()")
            .expect("capture_and_store must read the cached Ideas preferences");
        assert!(
            from_cache < png_mark,
            "the cached preference read must happen before png_written, not after"
        );

        // None of these may appear anywhere in `capture_and_store`: each one is
        // a synchronous read of the settings file on the critical path.
        for banned in [
            "refresh_ideas_capture_prefs",
            "menubar_json_path",
            "MenubarPrefs",
            "ideas_get_settings",
            "build_settings_state",
            // The settings-file readers sitting next to those in
            // `ideas_settings.rs` / `settings.rs`. Without these, a
            // `let p = ideas_settings::read_prefs();` on the hot path would
            // reintroduce the disk hit and still pass this guard.
            "read_prefs",
            "get_settings_at",
            "read_hq_config_lenient",
            "read_to_string",
        ] {
            assert!(
                !body.contains(banned),
                "{banned} is back on the release->png critical path in capture_and_store"
            );
        }

        // ...and the reader really is the thing that touches the config file,
        // so the assertions above are about a real cost rather than a name.
        let refresh = fn_body(&src, "pub fn refresh_ideas_capture_prefs()");
        assert!(
            refresh.contains("menubar_json_path") && refresh.contains("read_to_string"),
            "refresh_ideas_capture_prefs must be the one that reads menubar.json"
        );
        // The accessor stays I/O-free and lock-free.
        let accessor = fn_body(&src, "pub fn ideas_capture_prefs()");
        for banned in ["read_to_string", "menubar_json_path", ".lock()"] {
            assert!(
                !accessor.contains(banned),
                "ideas_capture_prefs must stay lock-free and I/O-free, found {banned}"
            );
        }
    }

    /// Code text of `name`'s body, from its signature to the first column-0
    /// `}` that closes it, with comment lines stripped — the test reasons
    /// about what executes, not about what the comments mention.
    pub(super) fn fn_body(src: &str, name: &str) -> String {
        let start = src.find(name).unwrap_or_else(|| panic!("{name} exists"));
        let end = src[start..]
            .find("\n}\n")
            .unwrap_or_else(|| panic!("{name} is terminated"));
        src[start..start + end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
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

    // ── US-010: card detail ────────────────────────────────────────────────

    fn hq_idea_board_seed(hq_root: &std::path::Path, slug: &str) -> CaptureRecord {
        let provenance = Provenance {
            app: "Safari".to_string(),
            window_title: "Window".to_string(),
            url: None,
            captured_at: chrono::Utc::now(),
            display_id: 1,
        };
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 4));
        create_record(
            hq_root,
            NewCapture::pending(slug, CaptureImage::Decoded(image), provenance),
        )
        .unwrap()
    }

    fn hq_idea_board_write_manifest(hq_root: &std::path::Path, slugs: &[&str]) {
        let companies = hq_root.join("companies");
        std::fs::create_dir_all(&companies).unwrap();
        let mut yaml = String::from("companies:\n");
        for slug in slugs {
            yaml.push_str(&format!("  {slug}:\n    name: {slug}\n"));
        }
        std::fs::write(companies.join("manifest.yaml"), yaml).unwrap();
    }

    #[test]
    fn hq_idea_board_correct_kind_marks_user_extracted() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        let out = correct_kind_in_vault(hq_root, "alpha", &seeded.id, "x_post").unwrap();
        assert_eq!(out.kind, CaptureKind::XPost);
        assert_eq!(out.status, CaptureStatus::Extracted);
        assert_eq!(out.confidence, Some(1.0));
        assert_eq!(out.extraction_source, Some(ExtractionSource::User));

        let reloaded = load_record(hq_root, "alpha", &seeded.id).unwrap();
        assert_eq!(reloaded.extraction_source, Some(ExtractionSource::User));
    }

    #[test]
    fn hq_idea_board_correct_kind_image_stays_plain() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        let out = correct_kind_in_vault(hq_root, "alpha", &seeded.id, "image").unwrap();
        assert_eq!(out.kind, CaptureKind::Image);
        assert_eq!(out.status, CaptureStatus::Plain);
        assert_eq!(out.confidence, Some(1.0));
        assert_eq!(out.extraction_source, Some(ExtractionSource::User));

        assert!(correct_kind_in_vault(hq_root, "alpha", &seeded.id, "nonsense").is_err());
    }

    #[test]
    fn hq_idea_board_set_note_trims_and_clears() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        let out = set_note_in_vault(hq_root, "alpha", &seeded.id, "  follow up  ").unwrap();
        assert_eq!(out.note.as_deref(), Some("follow up"));

        let cleared = set_note_in_vault(hq_root, "alpha", &seeded.id, "   \n ").unwrap();
        assert_eq!(cleared.note, None);
        assert_eq!(load_record(hq_root, "alpha", &seeded.id).unwrap().note, None);
    }

    #[test]
    fn hq_idea_board_set_tags_trims_dedupes_preserving_order() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        let tags: Vec<String> = ["  zeta ", "alpha", "", "zeta", "  ", "beta"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = set_tags_in_vault(hq_root, "alpha", &seeded.id, &tags).unwrap();
        assert_eq!(out.tags, vec!["zeta", "alpha", "beta"]);
        assert_eq!(
            load_record(hq_root, "alpha", &seeded.id).unwrap().tags,
            vec!["zeta", "alpha", "beta"]
        );
    }

    #[test]
    fn hq_idea_board_list_company_slugs_skips_missing_dirs() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        hq_idea_board_write_manifest(hq_root, &["alpha", "ghost", "beta"]);
        std::fs::create_dir_all(hq_root.join("companies").join("alpha")).unwrap();
        std::fs::create_dir_all(hq_root.join("companies").join("beta")).unwrap();

        assert_eq!(list_company_slugs(hq_root), vec!["alpha", "beta"]);
    }

    #[test]
    fn hq_idea_board_move_capture_relocates_and_rejects_unknown_company() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        hq_idea_board_write_manifest(hq_root, &["alpha", "beta"]);
        std::fs::create_dir_all(hq_root.join("companies").join("beta")).unwrap();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        let err = move_capture_in_vault(hq_root, "alpha", &seeded.id, "nowhere").unwrap_err();
        assert!(err.contains("unknown destination company"), "{err}");

        let moved = move_capture_in_vault(hq_root, "alpha", &seeded.id, "beta").unwrap();
        assert_eq!(moved.company_slug, "beta");
        assert!(!hq_desktop_core::ideas::record_dir(hq_root, "alpha", &seeded.id).exists());
        assert!(hq_desktop_core::ideas::record_dir(hq_root, "beta", &seeded.id).is_dir());
        assert_eq!(list_captures_in_vault(hq_root, "alpha").unwrap().len(), 0);
        assert_eq!(list_captures_in_vault(hq_root, "beta").unwrap().len(), 1);
    }

    #[test]
    fn hq_idea_board_delete_capture_removes_record_and_reports_missing() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let seeded = hq_idea_board_seed(hq_root, "alpha");

        delete_capture_in_vault(hq_root, "alpha", &seeded.id).unwrap();
        assert!(!hq_desktop_core::ideas::record_dir(hq_root, "alpha", &seeded.id).exists());
        assert_eq!(list_captures_in_vault(hq_root, "alpha").unwrap().len(), 0);

        assert!(delete_capture_in_vault(hq_root, "alpha", &seeded.id).is_err());
    }

    // ── US-012 wiring: settings honored by the capture write path ──────────

    fn hq_idea_board_seed_with(
        hq_root: &std::path::Path,
        slug: &str,
        edge: u32,
        max_edge: u32,
        local_only: bool,
    ) -> CaptureRecord {
        let provenance = Provenance {
            app: "Safari".to_string(),
            window_title: String::new(),
            url: None,
            captured_at: chrono::Utc::now(),
            display_id: 1,
        };
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(edge, edge / 2));
        create_record(
            hq_root,
            NewCapture::pending(slug, CaptureImage::Decoded(image), provenance)
                .with_image_max_edge(Some(max_edge))
                .with_local_only(local_only),
        )
        .unwrap()
    }

    /// The board must show captures from BOTH roots: flipping the sync
    /// preference decides where the next capture is written, never which of the
    /// user's existing captures they can still see.
    #[test]
    fn hq_idea_board_list_captures_spans_synced_and_local_only_roots() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let synced = hq_idea_board_seed_with(hq_root, "alpha", 40, 2000, false);
        let local = hq_idea_board_seed_with(hq_root, "alpha", 40, 2000, true);

        let listed = list_captures_in_vault(hq_root, "alpha").unwrap();
        let ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(listed.len(), 2, "both roots must be listed, got {ids:?}");
        assert!(ids.contains(&synced.id.as_str()));
        assert!(ids.contains(&local.id.as_str()));

        // ...and the local-only one really is outside the vault sync scope.
        assert!(local.image_path.starts_with("workspace/ideas-local/alpha/"));
        assert!(hq_root.join(&local.image_path).is_file());
        assert!(!hq_desktop_core::ideas::record_dir(hq_root, "alpha", &local.id).exists());
    }

    /// Editing a local-only capture must not copy it into the vault. This is
    /// the privacy regression the two-root resolution exists to prevent.
    #[test]
    fn hq_idea_board_editing_a_local_only_capture_never_lands_it_in_the_vault() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let local = hq_idea_board_seed_with(hq_root, "alpha", 40, 2000, true);

        set_note_in_vault(hq_root, "alpha", &local.id, "still private").unwrap();

        assert!(
            !hq_desktop_core::ideas::record_dir(hq_root, "alpha", &local.id).exists(),
            "a note edit republished a local-only capture into the company vault"
        );
        let reloaded = load_record(hq_root, "alpha", &local.id).unwrap();
        assert_eq!(reloaded.note.as_deref(), Some("still private"));
        assert!(reloaded.image_path.starts_with("workspace/ideas-local/alpha/"));
    }

    /// Reassigning a local-only capture to another company keeps it local-only
    /// — moving it would publish it to a second company's vault.
    #[test]
    fn hq_idea_board_moving_a_local_only_capture_keeps_it_out_of_the_vault() {
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        hq_idea_board_write_manifest(hq_root, &["alpha", "beta"]);
        std::fs::create_dir_all(hq_root.join("companies").join("beta")).unwrap();
        let local = hq_idea_board_seed_with(hq_root, "alpha", 40, 2000, true);

        let moved = move_capture_in_vault(hq_root, "alpha", &local.id, "beta").unwrap();
        assert_eq!(moved.company_slug, "beta");
        assert_eq!(
            moved.image_path,
            format!("workspace/ideas-local/beta/{}/image.png", local.id)
        );
        assert!(hq_root.join(&moved.image_path).is_file());
        assert!(!hq_desktop_core::ideas::record_dir(hq_root, "beta", &local.id).exists());
        assert_eq!(list_captures_in_vault(hq_root, "beta").unwrap().len(), 1);
        assert_eq!(list_captures_in_vault(hq_root, "alpha").unwrap().len(), 0);
    }

    /// The cache defaults match the documented settings defaults, so an install
    /// that has never opened the panel captures at 2000px into the vault...
    #[test]
    fn hq_idea_board_capture_prefs_default_to_2000px_and_synced() {
        assert_eq!(ideas_capture_prefs(), (DEFAULT_IMAGE_MAX_EDGE, false));
        assert_eq!(DEFAULT_IMAGE_MAX_EDGE, 2000);
    }

    /// ...and the cache is what the write path actually applies. The test above
    /// only pins the static initializers, so it would still pass if
    /// `capture_and_store` stopped consulting the cache altogether. This one
    /// pins the wiring: whatever `ideas_capture_prefs` reports is what reaches
    /// `NewCapture`, and what reaches `NewCapture` is what lands on disk.
    #[test]
    fn hq_idea_board_cached_prefs_are_the_ones_the_write_path_applies() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let body = fn_body(&src, "fn capture_and_store(");

        // The destructured pair is handed straight to the two builders.
        assert!(
            body.contains("let (image_max_edge, local_only) = ideas_capture_prefs();"),
            "capture_and_store must destructure the cached preferences"
        );
        assert!(
            body.contains(".with_image_max_edge(Some(image_max_edge))"),
            "the cached max edge must reach NewCapture"
        );
        assert!(
            body.contains(".with_local_only(local_only)"),
            "the cached sync posture must reach NewCapture"
        );
        // No hardcoded bound may sneak back alongside it.
        assert!(
            !body.contains("MAX_IMAGE_EDGE)") && !body.contains("with_image_max_edge(None)"),
            "capture_and_store must not fall back to a compiled-in bound"
        );

        // And the builders really do drive storage: a NewCapture carrying the
        // non-default choices writes where and at the size it was told.
        let root = tempfile::tempdir().unwrap();
        let hq_root = root.path();
        let record = hq_idea_board_seed_with(hq_root, "alpha", 3000, 1200, true);
        let stored = image::open(hq_root.join(&record.image_path)).unwrap();
        assert_eq!(stored.width().max(stored.height()), 1200);
        assert!(record.image_path.starts_with("workspace/ideas-local/alpha/"));
    }
    // -----------------------------------------------------------------
    // US-014: guided screen-recording permission onboarding
    // -----------------------------------------------------------------

    #[test]
    fn hq_idea_board_denial_response_truth_table() {
        // macOS, first refusal -> the guided panel.
        assert_eq!(denial_response(false, true), DenialResponse::Guide);

        // macOS, the user already closed the panel without granting -> the
        // one-line banner, not a panel they just rejected (US-014 AC5 / e2e 3).
        assert_eq!(denial_response(true, true), DenialResponse::Banner);

        // Windows: no Screen Recording gate and no pane to guide to, so the
        // panel is never offered regardless of the dismissal flag.
        assert_eq!(denial_response(false, false), DenialResponse::Banner);
        assert_eq!(denial_response(true, false), DenialResponse::Banner);
    }

    #[test]
    fn hq_idea_board_guide_poll_truth_table() {
        // Closed panel stops the thread even if the grant lands in the same
        // tick — a dismissed panel must never resurrect a capture.
        assert_eq!(guide_poll(false, false), GuidePoll::Stop);
        assert_eq!(guide_poll(false, true), GuidePoll::Stop);
        // Open and still denied: keep waiting.
        assert_eq!(guide_poll(true, false), GuidePoll::Continue);
        // Open and just granted: close + resume.
        assert_eq!(guide_poll(true, true), GuidePoll::Resume);
    }

    #[test]
    fn hq_idea_board_guide_drag_only_starts_from_a_mouse_down_or_drag_event() {
        // AppKit begins no dragging session for any other event type, and a
        // session that never begins is exactly the inert-chip bug: the drop
        // target is never offered a file and never highlights.
        assert!(is_drag_initiating_event(NS_EVENT_TYPE_LEFT_MOUSE_DOWN));
        assert!(is_drag_initiating_event(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED));
        // leftMouseUp(2), rightMouseDown(3), mouseMoved(5), keyDown(10).
        for ty in [0u64, 2, 3, 5, 10] {
            assert!(!is_drag_initiating_event(ty), "event {ty} cannot seed a drag");
        }
    }

    #[test]
    fn hq_idea_board_guide_drag_offers_the_running_bundle_as_a_file_url() {
        // REGRESSION (owner-reported): the chip was an HTML5 DOM drag, which
        // inside a WKWebView starts no NSDraggingSession at all — System
        // Settings' Screen Recording list never highlighted. The drag must be
        // begun by AppKit, offering the bundle as an NSURL (an
        // NSPasteboardWriting, so it publishes `public.file-url`).
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let body = fn_body(&src, "fn begin_grant_drag_with_event(");
        assert!(
            body.contains("beginDraggingSessionWithItems"),
            "the drag must start a real NSDraggingSession"
        );
        assert!(
            body.contains("fileURLWithPath") && body.contains("initWithPasteboardWriter"),
            "the session must carry the bundle as a file URL"
        );
        // A source that answers no operation makes every destination refuse
        // the drop — highlight included.
        assert!(
            src.contains("draggingSession:sourceOperationMaskForDraggingContext:")
                && src.contains("NS_DRAG_OPERATION_COPY"),
            "the drag source must offer a real operation"
        );

        // The path is resolved from the RUNNING executable every time, never
        // a constant: a shipped .app and a dev build must each grant their own
        // identity.
        let cmd = fn_body(&src, "pub async fn permission_guide_begin_drag(");
        assert!(
            cmd.contains("permission_guide_state_inner()"),
            "the dragged path must be resolved at runtime"
        );
        assert!(
            !cmd.contains("/Applications/"),
            "the dragged path must never be hardcoded"
        );
        // And the panel must be told when the drag cannot start, so the
        // copy-path fallback surfaces instead of a chip that does nothing.
        assert!(cmd.contains("return Err(") && cmd.contains("MARK_GUIDE_DRAG_FAILED"));

        // The seed event must come from AppKit's own dispatch, not from
        // `NSApp`'s current-event read after an IPC hop: by then the event is
        // stale and may belong to another window, and a session seeded with
        // one of those tracks nothing — the original no-highlight symptom
        // wearing a native costume.
        // Scan only the non-test half: the assertion text itself would
        // otherwise satisfy the very pattern it forbids.
        let production = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            !production.contains("msg_send![ns_app,"),
            "the drag must not be seeded from a stale NSApp current-event"
        );
        assert!(
            src.contains("addLocalMonitorForEventsMatchingMask"),
            "the drag must be seeded from the live event monitor"
        );
        assert!(
            body.contains("if event_window != win"),
            "a drag event from another window must be refused"
        );
        // The dragging source is held UNRETAINED by the session, so it must
        // be a singleton that is never released — releasing it would be a
        // use-after-free mid-drag.
        assert!(src.contains("fn drag_source_instance()") && src.contains("static SOURCE:"));
    }

    #[test]
    fn hq_idea_board_guide_grant_path_is_the_running_bundle() {
        // `permission_guide_state_inner` is what the drag command offers, so
        // pin that it comes from the live executable, not a literal.
        let state = permission_guide_state_inner();
        let exe = std::env::current_exe().expect("current_exe");
        let expected = hq_platform::permissions::bundle_path_from_exe(&exe);
        assert_eq!(state.grant_path, expected.to_string_lossy());
        assert!(!state.grant_path.is_empty());
    }

    #[test]
    fn hq_idea_board_guide_panel_never_activates_hq_when_dragged() {
        // Commit ecf6eef8 made the capture overlay a non-activating NSPanel so
        // a drag on it could not raise HQ's windows. The guide panel needs the
        // same treatment for a sharper reason: the drag's DESTINATION is the
        // System Settings window beside it, and activating HQ covers it.
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let setup = fn_body(&src, "pub fn setup_permission_guide_window(");
        assert!(
            setup.contains("make_window_nonactivating_panel(&window)"),
            "the guide panel must be non-activating"
        );
        // The promotion takes tao's focusable ivar with it, so the focusable
        // command must NOT call set_focusable on macOS or it reads free'd state.
        let focusable = fn_body(&src, "pub async fn set_permission_guide_focusable(");
        assert!(
            focusable.contains("set_guide_becomes_key_only_if_needed"),
            "post-promotion the panel is made key-able through NSPanel, not tao"
        );
    }

    #[test]
    fn hq_idea_board_guide_poll_interval_is_neither_busy_nor_sluggish() {
        // A busy loop would burn a core behind a modal panel; anything over a
        // second would make the drop feel unacknowledged.
        assert!(GUIDE_POLL_INTERVAL_MS >= 100, "poll must not busy-loop");
        assert!(GUIDE_POLL_INTERVAL_MS <= 1000, "grant must feel instant");
    }

    #[test]
    fn hq_idea_board_guide_poller_skips_the_syscall_when_closed() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let body = fn_body(&src, "fn start_guide_poller(");
        // `open &&` short-circuits the preflight call, so a closed panel costs
        // nothing, and the loop always sleeps before polling.
        assert!(body.contains("let granted = open && hq_platform::permissions::screen_capture_preflight()"));
        let sleep_idx = body.find("thread::sleep").expect("poller sleeps each tick");
        let poll_idx = body.find("screen_capture_preflight").expect("poller preflights");
        assert!(sleep_idx < poll_idx, "sleep before poll — never a busy loop");
        // Every terminal arm leaves the loop.
        assert!(body.contains("GuidePoll::Stop => return"));
    }

    #[test]
    fn hq_idea_board_guide_state_says_macos_will_not_reprompt() {
        // The one-shot system prompt is already spent by the time this panel
        // exists, so the panel must never imply another dialog is coming.
        let state = permission_guide_state_inner();
        assert!(!state.will_reprompt);
        assert!(!state.grant_name.is_empty());
    }

    #[test]
    fn hq_idea_board_guide_sits_beside_the_centred_settings_window() {
        // A non-primary display left of the primary has a negative origin.
        let display = DisplayRect { x: -2560.0, y: -200.0, w: 2560.0, h: 1440.0, scale: 1.0 };
        let (x, y) = guide_position(&display, GUIDE_W, GUIDE_H, GUIDE_MARGIN);
        // Parked to the LEFT of where macOS centres System Settings, with the
        // margin as the gap between the two windows.
        let settings_left = display.x + (display.w - SETTINGS_WINDOW_W) / 2.0;
        assert_eq!(x + GUIDE_W + GUIDE_MARGIN, settings_left);
        // Vertically centred, not pinned to a corner.
        assert_eq!(y, display.y + (display.h - GUIDE_H) / 2.0);
        // Inside the display it was anchored to, not the virtual desktop.
        assert!(x >= display.x && x + GUIDE_W <= display.x + display.w);
        assert!(y >= display.y && y + GUIDE_H <= display.y + display.h);
    }

    #[test]
    fn hq_idea_board_guide_position_clamps_onto_a_small_display() {
        // A display too narrow to hold the panel beside Settings would put the
        // ideal x off the left edge; clamping keeps the whole panel visible.
        let display = DisplayRect { x: 0.0, y: 0.0, w: 900.0, h: 600.0, scale: 1.0 };
        let (x, y) = guide_position(&display, GUIDE_W, GUIDE_H, GUIDE_MARGIN);
        assert!(x >= display.x + GUIDE_MARGIN, "panel ran off the left edge");
        assert!(x + GUIDE_W <= display.x + display.w, "panel ran off the right edge");
        assert!(y >= display.y + GUIDE_MARGIN);
        assert!(y + GUIDE_H <= display.y + display.h);
    }

    #[test]
    fn hq_idea_board_guide_window_is_built_hidden_and_non_activating() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let body = fn_body(&src, "fn setup_permission_guide_window(");
        assert!(body.contains(".visible(false)"), "panel must be pre-rendered hidden");
        assert!(body.contains(".focusable(false)"), "panel must be built non-activating");
        assert!(body.contains(".always_on_top(true)"));
        // macOS-only: Windows has no gate, so no window is built there.
        assert!(body.contains(r#"#[cfg(target_os = "macos")]"#));
        // Setup must never request a permission — US-014 AC7 (the one-shot
        // macOS prompt is only spent on genuine capture intent).
        assert!(!body.contains("request_screen_capture_access"));
        assert!(!body.contains("screen_capture_preflight"));
        assert!(!body.contains("set_focusable"));
    }

    #[test]
    fn hq_idea_board_no_screen_permission_is_requested_at_launch() {
        // AC7 regression: the only caller of the one-shot request in the app
        // is the chord's permission gate (and the explicit user-driven
        // meeting-permissions button in permissions.rs), never app setup.
        let main_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs"))
            .expect("main.rs is readable");
        assert!(
            !main_rs.contains("request_screen_capture_access"),
            "app setup must never burn the one-shot Screen Recording prompt"
        );
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let request_sites = src
            .lines()
            // Only real call/reference sites: a line that *starts* with the
            // path. The filter literal itself is nested inside this closure,
            // so the check is not self-referential.
            .filter(|l| {
                l.trim_start()
                    .starts_with("hq_platform::permissions::request_screen_capture_access")
            })
            .count();
        assert_eq!(
            request_sites, 1,
            "exactly one request site: the chord's screen_capture_allowed gate"
        );
        assert!(fn_body(&src, "fn screen_capture_allowed(")
            .contains("request_screen_capture_access"));
    }

    #[test]
    fn hq_idea_board_guide_teardown_is_the_single_cleanup_path() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        // Dismissal, grant-resume, and app quit all funnel through
        // hide_permission_guide, which clears the run flag *and* hides the
        // window — so no path can leave a stuck always-on-top panel.
        let hide = fn_body(&src, "fn hide_permission_guide(");
        assert!(hide.contains("GUIDE_OPEN.store(false"));
        assert!(hide.contains("window.hide()"));
        // Key-ability is dropped through the NSPanel, not tao (see the note
        // in hide_permission_guide: tao's set_focusable panics on a promoted
        // panel, which would wedge the single teardown path).
        assert!(hide.contains("set_guide_becomes_key_only_if_needed(&window, true)"));
        assert!(hide.contains("disarm_drag_monitor_on_main()"));
        for caller in [
            "fn dismiss_permission_guide(",
            "fn shutdown_permission_guide(",
        ] {
            assert!(
                fn_body(&src, caller).contains("hide_permission_guide("),
                "{caller} must tear down through hide_permission_guide"
            );
        }
        assert!(fn_body(&src, "fn start_guide_poller(").contains("hide_permission_guide(&app)"));
        // A failed show must not leave the flag claiming a panel is up —
        // neither when the closure runs and the window is missing, nor when
        // the main-thread hop itself is rejected.
        let show = fn_body(&src, "fn show_permission_guide(");
        assert!(show.contains("GUIDE_OPEN.store(false, Ordering::SeqCst)"));
        assert!(show.contains("prompt_for_screen_recording(&app_main)"));
        assert!(
            show.contains("if let Err(e) = hop"),
            "a dropped main-thread hop must reset the flag, not latch it forever"
        );
        assert!(
            show.contains("prompt_for_screen_recording(app);"),
            "a panel that cannot be shown still owes the user the banner"
        );
        // ...and the dropped-hop branch returns before the poller is armed.
        let hop_idx = show.find("if let Err(e) = hop").expect("hop guard");
        let poller_idx = show.find("start_guide_poller(app)").expect("poller");
        assert!(hop_idx < poller_idx);
    }

    #[test]
    fn hq_idea_board_a_dismiss_racing_a_grant_never_resurrects_the_capture() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let poller = fn_body(&src, "fn start_guide_poller(");
        let resume = &poller[poller.find("GuidePoll::Resume").expect("resume arm")..];
        // The resume arm must *claim* the panel with a swap before it acts:
        // a plain load would let a dismiss that landed during the preflight
        // syscall be overwritten, showing an overlay the user declined.
        let claim = resume
            .find("GUIDE_OPEN.swap(false, Ordering::SeqCst)")
            .expect("resume must claim the panel atomically");
        for after in ["hide_permission_guide", "GUIDE_DISMISSED.store(false", "show_overlay"] {
            let idx = resume.find(after).unwrap_or_else(|| panic!("missing {after}"));
            assert!(claim < idx, "{after} must come after the atomic claim");
        }
        assert!(resume[claim..].contains("return;"), "a lost claim must bail out");
    }

    #[test]
    fn hq_idea_board_guide_opens_the_pane_it_guides_to_and_keeps_focus_off_itself() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/commands/capture.rs"
        ))
        .expect("capture.rs is readable");
        let show = fn_body(&src, "fn show_permission_guide(");
        // AC2: the panel deep-links the Screen Recording pane itself — being
        // "beside that window" is meaningless if nothing opened it.
        assert!(show.contains(r#"permissions_open_settings("screen-capture".to_string())"#));
        // Spawned, so the chord never waits on a child process.
        assert!(show.contains("tauri::async_runtime::spawn"));
        // The panel never activates itself: the user is dragging into the
        // Settings window next door and must keep key focus there.
        let toggle = fn_body(&src, "fn set_permission_guide_focusable(");
        assert!(
            !toggle.contains("set_focus()"),
            "the guide must never steal focus from the Settings pane"
        );
    }

    #[test]
    fn hq_idea_board_guide_commands_are_registered_with_tauri() {
        // A command the panel invokes but main.rs never registers fails only
        // at runtime, as a rejected invoke inside a window the user is stuck
        // in. Assert the registration instead.
        let main_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs"))
            .expect("main.rs is readable");
        for cmd in [
            "commands::capture::permission_guide_ready",
            "commands::capture::set_permission_guide_focusable",
            "commands::capture::dismiss_permission_guide",
            // The native drag (US-014 AC2). Unregistered, the chip throws on
            // every press and the drag silently does nothing — the exact
            // failure this command exists to end.
            "commands::capture::permission_guide_begin_drag",
            "commands::capture::permission_guide_cancel_drag",
        ] {
            assert!(main_rs.contains(cmd), "{cmd} is not in generate_handler!");
        }
        assert!(main_rs.contains("commands::capture::setup_permission_guide_window(app)"));
        assert!(main_rs.contains("commands::capture::shutdown_permission_guide(&_app_handle)"));
    }

    #[test]
    fn hq_idea_board_guide_label_matches_capability_file() {
        let cap_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/permission-guide.json"
        );
        let cap = std::fs::read_to_string(cap_path).expect("permission-guide.json is readable");
        let parsed: serde_json::Value = serde_json::from_str(&cap).expect("valid json");
        assert_eq!(
            parsed["identifier"].as_str(),
            Some(GUIDE_WINDOW_LABEL),
            "capability identifier drifted from GUIDE_WINDOW_LABEL"
        );
        assert_eq!(
            parsed["windows"][0].as_str(),
            Some(GUIDE_WINDOW_LABEL),
            "capability window drifted from GUIDE_WINDOW_LABEL"
        );
        // Every core command the panel invokes must be covered by the grant.
        let perms: Vec<&str> = parsed["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(perms.contains(&"core:default"));
        assert!(
            perms.contains(&"core:event:default"),
            "the panel receives permission-guide:state over core:event"
        );
    }
}

#[cfg(test)]
mod hq_idea_board_live_capture_fix_tests {
    use super::*;

    /// The overlay's own source, so the wiring assertion below is falsifiable
    /// by deleting the call it names.
    const CAPTURE_SRC: &str = include_str!("capture.rs");


    // ── US-003 regression: the drag must not depend on WebView mouse events ────

    /// THE REGRESSION THIS BLOCK EXISTS FOR.
    ///
    /// ecf6eef8 promoted the overlay to a non-activating `NSPanel` (correct — it
    /// stopped HQ raising its own windows over the capture target) and, in the
    /// same breath, moved the drag onto `<svelte:window>` DOM handlers. A panel
    /// that never becomes key is never sent `mouseMoved:` and — as the hand-test
    /// showed by logging zero `release` marks while a 0x0 selection sat on screen
    /// and re-anchored on each click — is not reliably sent the `mouseUp` either.
    /// Only `mousedown` got through. The suite stayed green because every test
    /// dispatched synthetic DOM events, which a happy-dom window always delivers.
    ///
    /// So the invariant is not "a flag is set" but "the gesture is tracked by
    /// AppKit end to end": the tracker's mask must carry mouse DOWN, DRAGGED and
    /// UP. Falsified by dropping any one of them from `overlay_drag_event_mask`.
    #[test]
    fn hq_idea_board_overlay_drag_is_tracked_natively_end_to_end() {
        let mask = overlay_drag_event_mask();
        assert!(mask & (1 << NS_EVENT_TYPE_LEFT_MOUSE_DOWN) != 0, "the anchor is native");
        assert!(mask & (1 << NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED) != 0, "the rect grows natively");
        assert!(
            mask & (1 << NS_EVENT_TYPE_LEFT_MOUSE_UP) != 0,
            "the RELEASE is native — the shipped bug was a mouseUp that never arrived"
        );
        assert!(mask_tracks_whole_gesture(mask));

        // A tracker that only watched moves is exactly the half-fix that
        // `setAcceptsMouseMovedEvents:` alone would have been: it leaves the
        // release on the WebView, which is where it died.
        assert!(!mask_tracks_whole_gesture(1 << NS_EVENT_TYPE_MOUSE_MOVED));
        assert!(!mask_tracks_whole_gesture(
            (1 << NS_EVENT_TYPE_LEFT_MOUSE_DOWN) | (1 << NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED)
        ));
    }

    /// The tracker has to actually be armed while the overlay is up and torn down
    /// when it goes away, or the mask above is decoration. Falsified by deleting
    /// either call.
    #[test]
    fn hq_idea_board_overlay_arms_and_disarms_the_native_tracker() {
        let show = super::hq_idea_board_capture_tests::fn_body(CAPTURE_SRC, "fn show_overlay(app: &AppHandle)");
        assert!(
            show.contains("arm_overlay_drag_tracker(app, &window)"),
            "show_overlay must arm the native tracker"
        );
        let hide = super::hq_idea_board_capture_tests::fn_body(CAPTURE_SRC, "pub fn hide_overlay(app: &AppHandle, reason: &str)");
        assert!(
            hide.contains("disarm_overlay_drag_tracker()"),
            "hide_overlay must disarm the native tracker"
        );
    }

    /// The non-activating promotion (which must NOT be reverted) also has to stop
    /// suppressing mouse-moved delivery. Falsified by removing the setter.
    #[test]
    fn hq_idea_board_overlay_panel_accepts_mouse_moved_events() {
        let body = super::hq_idea_board_capture_tests::fn_body(
            CAPTURE_SRC,
            "fn make_window_nonactivating_panel(window: &tauri::WebviewWindow)",
        );
        assert!(
            body.contains("setAcceptsMouseMovedEvents: true"),
            "a non-activating panel defaults acceptsMouseMovedEvents to NO"
        );
        // And the fix that must never regress while fixing this one.
        assert!(body.contains("nonactivating_panel_style_mask(current)"));
    }

    /// One release path, run from the native mouse-up. A second release for the
    /// same gesture (a late DOM `mouseup`) must not capture twice.
    #[test]
    fn hq_idea_board_native_mouse_up_runs_the_one_release_path() {
        let tracked = super::hq_idea_board_capture_tests::fn_body(
            CAPTURE_SRC,
            "fn on_tracked_event(app: &AppHandle, ty: u64, point: (f64, f64))",
        );
        assert!(
            tracked.contains("release_selection_on_main(&deferred, rect)"),
            "the native mouse-up must run the release itself"
        );
        // USE-AFTER-FREE: the handler runs inside AppKit's dispatch of the
        // monitor block, and the release disarms the tracker — which frees
        // that very block. It MUST be deferred a turn (the same hazard
        // `schedule_disarm` documents for the permission-guide monitor).
        assert!(
            tracked.contains("app.run_on_main_thread(move || release_selection_on_main"),
            "the release must be deferred off the monitor handler's own frame"
        );
        assert!(
            !tracked.contains("\n            release_selection_on_main("),
            "an INLINE release from the handler frees the running block"
        );
        let cmd = super::hq_idea_board_capture_tests::fn_body(
            CAPTURE_SRC,
            "pub async fn capture_region_release(app: AppHandle, selection: SelectionRect)",
        );
        assert!(cmd.contains("release_selection_on_main"), "one release path, not two");
        assert!(
            cmd.contains("if !OVERLAY_VISIBLE.load(Ordering::SeqCst)"),
            "a second release for the same gesture must be a no-op"
        );
    }

    /// AppKit screen point (bottom-left origin) -> overlay-local CSS px (top-left
    /// origin), via the overlay window's own frame so a secondary display with a
    /// negative or offset origin lands in the right place.
    #[test]
    fn hq_idea_board_overlay_point_from_screen_maps_appkit_to_overlay_space() {
        let frame = (0.0, 0.0, 1800.0, 1080.0);
        assert_eq!(overlay_point_from_screen(frame, (0.0, 1080.0)), (0.0, 0.0), "top-left");
        assert_eq!(overlay_point_from_screen(frame, (1800.0, 0.0)), (1800.0, 1080.0), "bottom-right");
        assert_eq!(overlay_point_from_screen(frame, (900.0, 540.0)), (900.0, 540.0), "centre");

        // A display to the left of and below the primary.
        let secondary = (-1440.0, -200.0, 1440.0, 900.0);
        assert_eq!(overlay_point_from_screen(secondary, (-1440.0, 700.0)), (0.0, 0.0));
        assert_eq!(overlay_point_from_screen(secondary, (-1000.0, 500.0)), (440.0, 200.0));
    }

    /// Negative drags (right-to-left, bottom-to-top) must normalize, or the
    /// backend rejects them as empty and the capture silently does nothing.
    #[test]
    fn hq_idea_board_drag_rect_normalizes_every_direction() {
        let forward = drag_rect((100.0, 50.0), (300.0, 250.0));
        assert_eq!(forward, SelectionRect { x: 100.0, y: 50.0, width: 200.0, height: 200.0 });
        assert_eq!(drag_rect((300.0, 250.0), (100.0, 50.0)), forward, "backwards selects the same");
        assert_eq!(
            drag_rect((300.0, 50.0), (100.0, 250.0)),
            SelectionRect { x: 100.0, y: 50.0, width: 200.0, height: 200.0 }
        );

        // A click with no movement stays degenerate so the backend can reject it.
        let click = drag_rect((10.0, 10.0), (10.0, 10.0));
        assert!(click.width < 1.0 && click.height < 1.0);
    }

    /// BUG 2 (live): clicking the overlay activated HQ and raised the main
    /// window over the capture target. `focusable(false)` does not prevent
    /// AppKit's click-to-activate — only `NSWindowStyleMaskNonactivatingPanel`
    /// on an `NSPanel` does.
    ///
    /// The real behaviour is only observable in a live drive; this is the
    /// closest honest automated assertion: the overlay window IS constructed
    /// through the non-activating-panel promotion, and the mask that promotion
    /// applies really is non-activating.
    #[test]
    fn hq_idea_board_overlay_window_is_built_as_a_nonactivating_panel() {
        assert_eq!(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL, 1 << 7);

        // A borderless window (what the overlay is built as) is activating
        // until the panel bit is set.
        let borderless: u64 = 0;
        assert!(!mask_is_nonactivating(borderless));
        assert!(mask_is_nonactivating(nonactivating_panel_style_mask(borderless)));
        // Idempotent, and it never drops existing bits.
        let with_titled: u64 = 1 << 0;
        let promoted = nonactivating_panel_style_mask(with_titled);
        assert_eq!(promoted & with_titled, with_titled);
        assert_eq!(nonactivating_panel_style_mask(promoted), promoted);

        let setup = CAPTURE_SRC
            .split("pub fn setup_capture_overlay_window")
            .nth(1)
            .expect("setup_capture_overlay_window must exist");
        let body = setup
            .split("\n// ---")
            .next()
            .unwrap_or(setup);
        assert!(
            body.contains("make_window_nonactivating_panel(&window)"),
            "setup_capture_overlay_window must promote the overlay to a non-activating NSPanel, \
             or a click on the overlay activates HQ and raises the main window over the capture target"
        );
    }

    /// BUG 3 (live): the toast thumbnail never rendered for a company capture.
    /// `companies/<slug>/ideas/<id>/image.png` has to be previewable without a
    /// bound desktop Files session.
    #[test]
    fn hq_idea_board_ideas_capture_images_are_previewable_without_a_desktop_session() {
        assert!(is_ideas_capture_image_rel(
            "companies/indigo/ideas/01M2CHF7CM99QZZZPNC1NXESK6/image.png"
        ));
        // The local-only root is `workspace/ideas-local/{company}` — the
        // record dir adds the id, exactly as `create_record` writes it.
        assert_eq!(
            hq_desktop_core::ideas::settings::ideas_root_relative("indigo", false).unwrap(),
            "workspace/ideas-local/indigo"
        );
        assert!(is_ideas_capture_image_rel(
            "workspace/ideas-local/indigo/01M2CHF7CM99QZZZPNC1NXESK6/image.png"
        ));

        // …and nothing else in the tree is reachable through this door.
        for bad in [
            "companies/indigo/settings/vault.json",
            "companies/indigo/ideas/../../../etc/passwd/image.png",
            "companies/indigo/ideas/id/notes/image.png",
            "companies/indigo/ideas//image.png",
            "companies//ideas/id/image.png",
            "/companies/indigo/ideas/id/image.png",
            "companies\\indigo\\ideas\\id\\image.png",
            "workspace/ideas-local/image.png",
            "workspace/ideas-local/indigo/image.png",
            "workspace/ideas-local/indigo/id/sub/image.png",
            "workspace/threads/id/image.png",
            "companies/indigo/ideas/id/image.png.txt",
            "",
        ] {
            assert!(!is_ideas_capture_image_rel(bad), "must reject {bad:?}");
        }
    }

    /// The toast must not go back through the desktop-Files-scoped command:
    /// `enforce_desktop_read_scope` rejects every `companies/…` read when no
    /// desktop session company is bound, which is the exact silent failure the
    /// owner hit.
    #[test]
    fn hq_idea_board_capture_toast_does_not_use_the_desktop_scoped_preview() {
        let toast = include_str!("../../../src/components/capture/CaptureToast.svelte");
        assert!(
            toast.contains("invoke('ideas_capture_preview'"),
            "the capture toast must load its thumbnail through ideas_capture_preview"
        );
        assert!(
            !toast.contains("invoke('get_authorized_file_preview'"),
            "get_authorized_file_preview is desktop-session-scoped and always fails from the toast"
        );
    }
}
