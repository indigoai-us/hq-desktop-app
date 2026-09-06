//! Custom in-app notification banner for HQ Sync.
//!
//! ## Why this exists
//!
//! The native banner path (`mac-notification-sys`, used by `dm_notify.rs` and
//! `share_notify.rs`) is brittle:
//!
//!   * the clickable path busy-spins a Cocoa run loop (`wait_for_click(true)`
//!     ≈ 1 core, capped by `BlockingNotifyGuard` — see `hq-sync-cpu-spin`),
//!   * `tauri-plugin-notification`'s desktop impl hardcodes permission state
//!     (see `notifications.rs`), and
//!   * macOS Focus/DND silently swallows banners with no app-visible signal.
//!
//! HQ Sync is a menu-bar app — always resident — so the strongest reasons to
//! keep system notifications (delivery when closed, Notification Center
//! history) mostly don't apply. This module renders a fully-controlled,
//! transparent, always-on-top, non-activating webview banner with the same
//! NSVisualEffectView vibrancy as the detail windows.
//!
//! ## One surface, many sources
//!
//! Every notification source builds a neutral [`BannerPayload`] and calls
//! [`show_banner`]. On action, [`banner_action`] re-emits a single
//! `notification:banner-action` event `{kind, action, data}` that `App.svelte`
//! routes by `kind` — DMs open the DM detail / copy a prompt, shares open the
//! share detail, updates install or reveal the popover. The `data` field is the
//! opaque source event echoed back, so no re-fetch is needed.
//!
//! Sources:
//!   * DMs    — [`show_dm_banner`]    (gated by `customBanner` in `dm_notify`)
//!   * Shares — [`show_share_banner`] (gated by `customBanner` in `share_notify`)
//!   * Update — [`show_update_banner`] (raised from `updater` on `update:available`)
//!
//! ## Productionisation notes (out of spike scope)
//!
//!   * Convert the NSWindow to a true `NSPanel` (`.nonactivatingPanel` +
//!     `canBecomeKey = false`) via `tauri-nspanel`. Accessory activation policy
//!     + `focused(false)` covers the common case today.
//!   * Multi-banner **stacking** (vertical offset per live banner). Today a
//!     second notification replaces the first in the single banner window.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use hq_desktop_core::banner::initials;
pub use hq_desktop_core::banner::{custom_banner_enabled, BannerPayload};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::util::logfile::log;

const LOG_TAG: &str = "banner";

/// Window label — kept in sync with the `main.ts` router branch and
/// `capabilities/dm-banner.json`.
pub const WINDOW_LABEL: &str = "dm-banner";

/// Tauri event the banner webview listens for to receive its payload.
const EVENT_BANNER: &str = "banner:event";

/// Unified action event. `App.svelte` has one listener that routes by `kind`.
/// Replaces the per-source `notification:dm-action` / `notification:share-action`
/// for the CUSTOM banner path (the native paths still emit their own events).
const EVENT_BANNER_ACTION: &str = "notification:banner-action";

/// The main webview normally acknowledges immediately after the requested
/// action settles. Keep the timeout bounded so a crashed/reloading webview
/// cannot leave an IPC command pending forever.
const ACTION_ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// Recording does not succeed when the bridge accepts the command; Recall's
/// matching `recording:started` lifecycle event is authoritative. App uses a
/// 45-second caller timeout, so Rust must outlive it and never manufacture an
/// early Retry while that semantic start is still active.
const RECORDING_ACTION_ACK_TIMEOUT: Duration = Duration::from_secs(60);

fn action_ack_timeout(kind: &str, action: &str) -> Duration {
    if kind == "meeting" && action == "record" {
        RECORDING_ACTION_ACK_TIMEOUT
    } else {
        ACTION_ACK_TIMEOUT
    }
}

/// Banner geometry (logical px). `BANNER_H` is the INITIAL height the window is
/// created at; the frontend measures its rendered content on mount and calls
/// `resize_banner` to shrink/grow the window to fit (so a one-line DM isn't
/// padded out to a three-line share). Resizing is safe because the rounded
/// corners are clipped via the contentView layer's `cornerRadius` +
/// `masksToBounds`, which follows the new bounds (see `reclip_banner_corners`).
const BANNER_W: f64 = 366.0;
const BANNER_H: f64 = 104.0;
/// Clamp bounds for the content-driven resize.
const BANNER_H_MIN: f64 = 56.0;
const BANNER_H_MAX: f64 = 260.0;
const MARGIN_RIGHT: f64 = 14.0;
const MARGIN_TOP: f64 = 40.0;

/// Managed state: the payload pending for the banner's ready-handshake.
pub struct PendingBanner(pub Mutex<Option<BannerPayload>>);

/// Explicit main-webview router readiness. The frontend sets this only after
/// its critical listener is installed and clears it before uninstalling.
#[derive(Default)]
pub struct BannerActionRouterReadiness(AtomicBool);

impl BannerActionRouterReadiness {
    fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn set_ready(&self, ready: bool) {
        self.0.store(ready, Ordering::Release);
    }
}

/// Managed acknowledgement ledger for custom notification actions.
///
/// `banner_action` registers a one-shot sender before emitting to `App.svelte`.
/// The app reports the real result through `banner_action_result`; the original
/// command only resolves after that acknowledgement. This keeps every visual
/// surface mounted until the destination action actually succeeds.
#[derive(Default)]
pub struct PendingBannerActions(Mutex<HashMap<String, oneshot::Sender<bool>>>);

impl PendingBannerActions {
    fn register(&self, request_id: &str) -> Result<oneshot::Receiver<bool>, String> {
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if pending.contains_key(request_id) {
            return Err("That action is already in progress.".to_string());
        }
        pending.insert(request_id.to_string(), sender);
        Ok(receiver)
    }

    fn complete(&self, request_id: &str, success: bool) -> bool {
        let sender = self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id);
        sender.is_some_and(|sender| sender.send(success).is_ok())
    }

    fn remove(&self, request_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id);
    }
}

/// Action re-dispatched to `App.svelte`. One shape for every source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BannerActionEvent {
    request_id: String,
    kind: String,
    action: String,
    data: serde_json::Value,
}

fn top_right_position(app: &AppHandle) -> tauri::LogicalPosition<f64> {
    let monitor = app.primary_monitor().ok().flatten().or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|m| m.into_iter().next())
    });
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let logical_w = m.size().width as f64 / scale;
        let x = (logical_w - BANNER_W - MARGIN_RIGHT).max(0.0);
        return tauri::LogicalPosition::new(x, MARGIN_TOP);
    }
    tauri::LogicalPosition::new(1440.0 - BANNER_W - MARGIN_RIGHT, MARGIN_TOP)
}

// ── Core: show any banner ───────────────────────────────────────────────────────

/// Show (or refresh) the banner for a neutral [`BannerPayload`].
///
/// Single-window: a second notification reuses the same window (focus +
/// re-emit). Stacking is a productionisation note above.
///
/// When widget takeover is active (US-003), forwards to the widget stack and
/// never opens the dm-banner window.
pub async fn show_banner(app: AppHandle, payload: BannerPayload) -> Result<(), String> {
    // A stale custom-protocol response can survive an app-bundle replacement
    // in WKWebView's shared cache. Never create, reveal, or route into either
    // notification webview until the per-version eviction/reload gate is
    // terminal. Other platforms keep their existing immediate behavior.
    #[cfg(target_os = "macos")]
    crate::webview_asset_cache::wait_until_ready().await;

    // US-003: widget owns every DM/share/meeting/update while widget mode is on.
    if crate::commands::widget::takeover_active(&app) {
        log(
            LOG_TAG,
            &format!(
                "takeover: routing kind={} title={} to widget",
                payload.kind, payload.title
            ),
        );
        return crate::commands::widget::show_widget_notification(app, payload).await;
    }

    log(
        LOG_TAG,
        &format!(
            "show: kind={} title={} body_len={}",
            payload.kind,
            payload.title,
            payload.body.len()
        ),
    );

    if let Some(state) = app.try_state::<PendingBanner>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(payload.clone());
    }

    let pos = top_right_position(&app);

    // Get-or-create is single-flight: the label check and the build are not
    // atomic, and a burst of shows on a fresh process used to build one window
    // per call. Every build leaves a renderer handle set behind for the life
    // of the process, so the window is built once and reused (hidden on
    // dismiss, never closed).
    let (window, created) = {
        let lookup_app = app.clone();
        let build_app = app.clone();
        get_or_create_serialized(
            move || lookup_app.get_webview_window(WINDOW_LABEL),
            move || build_banner_window(&build_app, pos),
        )
        .await?
    };

    if !created {
        let _ = window.set_position(pos);
        window.show().map_err(|e| e.to_string())?;
        app.emit_to(WINDOW_LABEL, EVENT_BANNER, &payload)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    drop(window);

    // (1) Clear the WKWebView's `underPageBackgroundColor`. macOS 12+ WebKit
    // paints it (a system gray) behind a transparent page, filling the square
    // window rect — THIS was the "square box behind the rounded card", not the
    // vibrancy/blur/shadow. `transparent: true` does not clear it.
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
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

    // (2) Apply native NSVisualEffectView vibrancy for the frosted-glass look.
    // Now that the webview gray is cleared, the rounded effect view (radius 18,
    // matching the card) shows cleanly behind the translucent CSS card. AppKit
    // is main-thread-only → dispatch via run_on_main_thread.
    #[cfg(target_os = "macos")]
    {
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            let Some(window) = app_for_main.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            if let Err(e) = apply_vibrancy(
                &window,
                // Popover material = the app's "Liquid Glass" look (same as the
                // main window's apply_liquid_glass). Brighter / more translucent
                // than HudWindow for a pure-glass feel.
                NSVisualEffectMaterial::Popover,
                Some(NSVisualEffectState::Active),
                Some(18.0), // match the card's border-radius
            ) {
                log(LOG_TAG, &format!("apply_vibrancy FAILED: {e}"));
            }

            // Clip the window CONTENT to a rounded rect at the OS level. The
            // NSVisualEffectView is a square view and window-vibrancy's own
            // `radius` does not reliably clip it on this macOS, so its square
            // corners showed through. cornerRadius + masksToBounds on the
            // contentView's layer clips ALL subviews (the effect view AND the
            // webview) to the rounded shape — the definitive fix.
            use objc2::{msg_send, runtime::AnyObject};
            if let Ok(ns_win) = window.ns_window() {
                let ns_win = ns_win as *mut AnyObject;
                // SAFETY: main thread (run_on_main_thread); AppKit selectors.
                unsafe {
                    let content: *mut AnyObject = msg_send![ns_win, contentView];
                    if !content.is_null() {
                        let _: () = msg_send![content, setWantsLayer: true];
                        let layer: *mut AnyObject = msg_send![content, layer];
                        if !layer.is_null() {
                            let _: () = msg_send![layer, setCornerRadius: 18.0_f64];
                            let _: () = msg_send![layer, setMasksToBounds: true];
                        }
                    }
                }
            }
        });
    }

    Ok(())
}

/// Build an autoreleased `NSString` from a Rust &str for KVC selectors.
#[cfg(target_os = "macos")]
fn ns_str(s: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::{class, msg_send, runtime::AnyObject};
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

// ── Source-specific constructors ─────────────────────────────────────────────────

/// DM → banner. Body-click opens the DM detail; the chip copies the agent
/// prompt when the DM carries one.
pub async fn show_dm_banner(
    app: AppHandle,
    event: crate::commands::dm_notify::DmEvent,
) -> Result<(), String> {
    let has_prompt = event
        .prompt
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let payload = BannerPayload {
        kind: "dm".to_string(),
        title: event.from_display_name.clone(),
        body: event.body.clone(),
        icon_text: Some(initials(&event.from_display_name)),
        action_label: has_prompt.then(|| "Copy prompt".to_string()),
        action_id: has_prompt.then(|| "copy".to_string()),
        click_action_id: "open".to_string(),
        data: serde_json::to_value(&event).unwrap_or(serde_json::Value::Null),
    };
    show_banner(app, payload).await
}

/// Share ("shared with me") → banner. Body-click opens the share detail window.
pub async fn show_share_banner(
    app: AppHandle,
    event: crate::commands::share_notify::ShareEvent,
) -> Result<(), String> {
    let title = crate::commands::share_notify::notification_title(&event.issuer_display_name);
    let body =
        crate::commands::share_notify::notification_body(event.note.as_deref(), &event.paths);
    let payload = BannerPayload {
        kind: "share".to_string(),
        title,
        body,
        icon_text: Some(initials(&event.issuer_display_name)),
        action_label: Some("Open".to_string()),
        action_id: Some("open".to_string()),
        click_action_id: "open".to_string(),
        data: serde_json::to_value(&event).unwrap_or(serde_json::Value::Null),
    };
    show_banner(app, payload).await
}

/// Meeting-detected → banner. Body-click opens the Meetings window; the chip
/// starts recording. `data` carries `{ windowId, platform }` so `App.svelte`'s
/// banner-action router can drive the same flow as the native
/// `notification:meeting-action` path. Replaces the native UN/osascript banner
/// when `customBanner` is on (the native path remains as the off fallback).
pub async fn show_meeting_banner(
    app: AppHandle,
    title: String,
    body: String,
    window_id: String,
    platform: String,
) -> Result<(), String> {
    let payload = BannerPayload {
        kind: "meeting".to_string(),
        title,
        body,
        // System source → the HQ mark renders in the avatar regardless of
        // icon_text, so this is purely a non-macOS / fallback glyph.
        icon_text: Some("●".to_string()),
        action_label: Some("Record".to_string()),
        action_id: Some("record".to_string()),
        click_action_id: "open".to_string(),
        data: serde_json::json!({ "windowId": window_id, "platform": platform }),
    };
    show_banner(app, payload).await
}

/// Unattributed meeting → banner. Body-click opens the desktop Meetings page
/// focused on this bot; the chip files the meeting to a company in place.
pub async fn show_unattributed_meeting_banner(
    app: AppHandle,
    meeting_id: String,
    meeting_title: Option<String>,
    scheduled_start_time: Option<String>,
    calendar_event_id: Option<String>,
) -> Result<(), String> {
    let name = meeting_title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("Meeting")
        .to_string();
    let mut body = format!("\"{name}\" isn't filed to a company yet.");
    body.push_str(" Assign it so the transcript files correctly.");
    let payload = BannerPayload {
        kind: "meeting".to_string(),
        title: name.clone(),
        body,
        icon_text: Some("●".to_string()),
        action_label: Some("Assign".to_string()),
        action_id: Some("assign".to_string()),
        click_action_id: "assign".to_string(),
        data: serde_json::json!({
            "meetingId": meeting_id,
            "meetingTitle": name,
            "scheduledStartTime": scheduled_start_time,
            "calendarEventId": calendar_event_id,
        }),
    };
    show_banner(app, payload).await
}

/// New HQ Sync version → banner. The chip installs; a body-click reveals the
/// popover (which carries the full update UI) without forcing a restart.
pub async fn show_update_banner(
    app: AppHandle,
    version: String,
    notes: Option<String>,
) -> Result<(), String> {
    let body = match notes.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => format!("Version {version} is ready — {n}"),
        None => format!("Version {version} is ready to install."),
    };
    let payload = BannerPayload {
        kind: "update".to_string(),
        title: "New version".to_string(),
        body,
        icon_text: Some("⬆".to_string()),
        action_label: Some("Update now".to_string()),
        action_id: Some("update".to_string()),
        click_action_id: "open".to_string(),
        data: serde_json::json!({ "version": version }),
    };
    show_banner(app, payload).await
}

// ── Commands ─────────────────────────────────────────────────────────────────────

/// Called by `BannerNotification.svelte` once its `listen` handler is mounted.
#[tauri::command]
pub async fn banner_window_ready(app: AppHandle) -> Result<(), String> {
    let payload = app
        .try_state::<PendingBanner>()
        .and_then(|s| s.0.lock().unwrap_or_else(|p| p.into_inner()).clone());
    if let Some(payload) = payload {
        app.emit_to(WINDOW_LABEL, EVENT_BANNER, &payload)
            .map_err(|e| e.to_string())?;
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
    }
    Ok(())
}

#[tauri::command]
pub fn banner_action_router_ready(readiness: State<'_, BannerActionRouterReadiness>) {
    readiness.set_ready(true);
    log(LOG_TAG, "action router ready");
}

#[tauri::command]
pub fn banner_action_router_not_ready(readiness: State<'_, BannerActionRouterReadiness>) {
    readiness.set_ready(false);
    log(LOG_TAG, "action router not ready");
}

/// The banner or widget was actioned. Emit the unified event for `App.svelte`
/// to route by `kind`, then wait for its explicit success/failure result.
///
/// A successful emit is not a successful user action: opening a window,
/// copying, installing, or starting a recording can still fail later. The
/// frontend keeps its row mounted while this command waits and only dismisses
/// after `banner_action_result` acknowledges success.
#[tauri::command]
pub async fn banner_action(
    app: AppHandle,
    pending: State<'_, PendingBannerActions>,
    readiness: State<'_, BannerActionRouterReadiness>,
    request_id: String,
    action: String,
    payload: BannerPayload,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Couldn’t start that action. Try again.".to_string());
    }
    if !readiness.is_ready() {
        return Err("HQ is still getting ready. Try again in a moment.".to_string());
    }
    let ack_timeout = action_ack_timeout(&payload.kind, &action);

    log(
        LOG_TAG,
        &format!(
            "action request={} kind={} action={}",
            request_id, payload.kind, action
        ),
    );
    let receiver = pending.register(&request_id)?;
    if let Err(error) = app.emit(
        EVENT_BANNER_ACTION,
        BannerActionEvent {
            request_id: request_id.clone(),
            kind: payload.kind,
            action,
            data: payload.data,
        },
    ) {
        pending.remove(&request_id);
        log(
            LOG_TAG,
            &format!("action request={} emit FAILED: {error}", request_id),
        );
        return Err("Couldn’t start that action. Try again.".to_string());
    }

    let result = tokio::time::timeout(ack_timeout, receiver).await;
    pending.remove(&request_id);
    match result {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("Couldn’t complete that action. Try again.".to_string()),
        Ok(Err(_)) | Err(_) => {
            log(
                LOG_TAG,
                &format!("action request={} acknowledgement timed out", request_id),
            );
            Err("The action took too long. Try again.".to_string())
        }
    }
}

/// Complete a pending custom action after `App.svelte` has finished the real
/// destination work. Stale/late acknowledgements are harmless and idempotent.
#[tauri::command]
pub async fn banner_action_result(
    pending: State<'_, PendingBannerActions>,
    request_id: String,
    success: bool,
) -> Result<(), String> {
    if !pending.complete(request_id.trim(), success) {
        log(
            LOG_TAG,
            &format!("late action result ignored request={}", request_id.trim()),
        );
    }
    Ok(())
}

/// Turn a failed native notification action into a visible, retryable custom
/// banner. This is intentionally limited to the native DM/share action set;
/// the opaque `data` is echoed back only to the existing App action router.
#[tauri::command]
pub async fn show_action_retry_banner(
    app: AppHandle,
    kind: String,
    action: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let (title, body) = match (kind.as_str(), action.as_str()) {
        ("dm", "copy") => (
            "Couldn’t copy the prompt",
            "The message is still available. Try copying it again.",
        ),
        ("dm", "open") => (
            "Couldn’t open the message",
            "The message is still available. Try opening it again.",
        ),
        ("share", "claude") => (
            "Couldn’t open Claude",
            "The shared item is still available. Try again.",
        ),
        ("share", "copy") => (
            "Couldn’t copy the details",
            "The shared item is still available. Try copying again.",
        ),
        ("share", "open") => (
            "Couldn’t open the shared item",
            "The shared item is still available. Try opening it again.",
        ),
        _ => return Err("Unsupported notification action.".to_string()),
    };

    show_banner(
        app,
        BannerPayload {
            kind,
            title: title.to_string(),
            body: body.to_string(),
            icon_text: Some("HQ".to_string()),
            action_label: Some("Retry".to_string()),
            action_id: Some(action.clone()),
            click_action_id: action,
            data,
        },
    )
    .await
}

/// Dismiss the banner (auto-timeout or explicit close).
#[tauri::command]
pub async fn dismiss_banner(app: AppHandle) -> Result<(), String> {
    dismiss_banner_inner(&app);
    Ok(())
}

/// Resize the banner window to fit its rendered content. `BannerNotification`
/// measures its card height after each payload and calls this so the window
/// hugs the content instead of a fixed 104px (which over-pads short banners).
/// Keeps the top-right anchor (a content-size change can shift the macOS
/// bottom-left origin) and re-asserts the rounded corners on the new bounds.
#[tauri::command]
pub async fn resize_banner(app: AppHandle, height: f64) -> Result<(), String> {
    let h = height.clamp(BANNER_H_MIN, BANNER_H_MAX);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .set_size(tauri::LogicalSize::new(BANNER_W, h))
            .map_err(|e| e.to_string())?;
        let _ = window.set_position(top_right_position(&app));
        #[cfg(target_os = "macos")]
        reclip_banner_corners(&app);
    }
    Ok(())
}

/// Re-assert the rounded-corner clip on the banner window's contentView layer.
/// Idempotent — the layer's `cornerRadius`/`masksToBounds` follows the view's
/// bounds, so calling this after a resize re-rounds the new geometry (including
/// the NSVisualEffectView subview, whose own mask image would otherwise be
/// stale). macOS-only.
#[cfg(target_os = "macos")]
fn reclip_banner_corners(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use objc2::{msg_send, runtime::AnyObject};
        let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        if let Ok(ns_win) = window.ns_window() {
            let ns_win = ns_win as *mut AnyObject;
            // SAFETY: main thread (run_on_main_thread); public AppKit selectors.
            unsafe {
                let content: *mut AnyObject = msg_send![ns_win, contentView];
                if !content.is_null() {
                    let _: () = msg_send![content, setWantsLayer: true];
                    let layer: *mut AnyObject = msg_send![content, layer];
                    if !layer.is_null() {
                        let _: () = msg_send![layer, setCornerRadius: 18.0_f64];
                        let _: () = msg_send![layer, setMasksToBounds: true];
                    }
                }
            }
        }
    });
}

/// Serialize a get-or-create of a keyed resource (the banner window). Callers
/// that find the resource already present return `(resource, false)`; the one
/// caller that builds it returns `(resource, true)` and owns any post-build
/// setup. A failed build releases the lock so the next caller can retry.
async fn get_or_create_serialized<T, L, C>(lookup: L, create: C) -> Result<(T, bool), String>
where
    L: Fn() -> Option<T>,
    C: FnOnce() -> Result<T, String>,
{
    if let Some(existing) = lookup() {
        return Ok((existing, false));
    }
    let _guard = BANNER_WINDOW_CREATE.lock().await;
    if let Some(existing) = lookup() {
        return Ok((existing, false));
    }
    let built = create()?;
    Ok((built, true))
}

/// Guards banner window creation so concurrent shows cannot each build one.
static BANNER_WINDOW_CREATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn build_banner_window(
    app: &AppHandle,
    pos: tauri::LogicalPosition<f64>,
) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("HQ Notification")
    .inner_size(BANNER_W, BANNER_H)
    .position(pos.x, pos.y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    // Native shadow ON — the contentView is clipped to a rounded rect (below),
    // so the OS shadow follows the rounded shape. (The card's CSS box-shadow is
    // clipped away by masksToBounds, so the native one provides the drop.)
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible_on_all_workspaces(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())
}

/// Hide, never close: closing destroys the webview but its renderer handle
/// set (Metal shader cache, netsrc socket, metallibs) is never returned to the
/// process, and the next show would build a fresh one. Hidden, the window is
/// reused by `show_banner` for the life of the process.
fn dismiss_banner_inner(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// Show the main popover anchored under the tray icon. Used by the update
/// banner's body-click so the user lands on the full update UI — positioned at
/// the menu-bar tray (like a normal popover open), NOT centered on screen.
#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), String> {
    crate::tray::show_window_at_tray(&app);
    Ok(())
}

// ── Preview triggers (devtools / env-var) ────────────────────────────────────────

/// SPIKE trigger — fabricate a representative DM and show its banner.
#[tauri::command]
pub async fn preview_dm_banner(app: AppHandle) -> Result<(), String> {
    let event = crate::commands::dm_notify::DmEvent {
        event_id: "evt_preview".to_string(),
        from_person_uid: "prs_preview".to_string(),
        from_email: "ada@getindigo.ai".to_string(),
        from_display_name: "Ada Lovelace".to_string(),
        body: "Custom banner spike is live — click me to open the detail window, or hit Copy prompt.".to_string(),
        details: Some("This banner is a transparent Tauri webview with NSVisualEffectView vibrancy, pinned top-right. It auto-dismisses; hover to keep it.".to_string()),
        prompt: Some("Review the custom notification banner spike in repos/public/hq-sync and report on the feel vs native.".to_string()),
        created_at: "2026-05-29T00:00:00Z".to_string(),
        root_event_id: None,
    };
    show_dm_banner(app, event).await
}

/// Fabricate a representative "shared with me" event and show its banner.
#[tauri::command]
pub async fn preview_share_banner(app: AppHandle) -> Result<(), String> {
    let event = crate::commands::share_notify::ShareEvent {
        event_id: "shr_preview".to_string(),
        issuer_email: "grace@getindigo.ai".to_string(),
        issuer_display_name: "Grace Hopper".to_string(),
        issuer_person_uid: "prs_preview_issuer".to_string(),
        paths: vec![
            "indigo/reports/q1-forecast.md".to_string(),
            "indigo/reports/q1-model.xlsx".to_string(),
        ],
        note: Some("Sharing the Q1 forecast — take a look before our sync.".to_string()),
        permission: "read".to_string(),
        created_at: "2026-05-29T00:00:00Z".to_string(),
    };
    show_share_banner(app, event).await
}

/// Fabricate a new-version event and show its banner.
#[tauri::command]
pub async fn preview_update_banner(app: AppHandle) -> Result<(), String> {
    show_update_banner(
        app,
        "0.4.0".to_string(),
        Some("instant DMs + custom banners".to_string()),
    )
    .await
}

/// Fabricate a meeting-detected event and show its banner (manual QA).
#[tauri::command]
pub async fn preview_meeting_banner(app: AppHandle) -> Result<(), String> {
    show_meeting_banner(
        app,
        "Zoom meeting detected".to_string(),
        "Zoom: Weekly sync".to_string(),
        "preview-window-1".to_string(),
        "zoom".to_string(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_action_delivers_the_real_result_once() {
        let pending = PendingBannerActions::default();
        let receiver = pending.register("request-1").expect("register action");

        assert!(pending.complete("request-1", true));
        assert!(receiver.await.expect("receive action result"));
        assert!(!pending.complete("request-1", false));
    }

    #[test]
    fn duplicate_request_ids_cannot_replace_an_active_waiter() {
        let pending = PendingBannerActions::default();
        let _receiver = pending.register("request-1").expect("register action");

        let error = pending
            .register("request-1")
            .expect_err("duplicate request must fail");
        assert_eq!(error, "That action is already in progress.");
    }

    #[test]
    fn recording_ack_timeout_outlives_the_generic_action_timeout() {
        assert!(
            action_ack_timeout("meeting", "record") > ACTION_ACK_TIMEOUT,
            "recording must wait for the authoritative SDK lifecycle event"
        );
        assert_eq!(
            action_ack_timeout("dm", "open"),
            ACTION_ACK_TIMEOUT,
            "ordinary actions retain the short bounded timeout"
        );
    }

    // Every banner show used to race its own window creation: `show_banner`
    // checks for the `dm-banner` window and builds one when it is missing, and
    // the check and the build were not atomic. When the meeting poller fired
    // 32 shows back to back on a fresh process, each one found no window and
    // built its own. Every build left a renderer handle set (Metal shader
    // cache, netsrc control socket, metallibs) behind for the life of the
    // process; 28 of them pushed the app past macOS's 256-handle soft limit
    // and every child spawn failed with EMFILE. Creation must be single-flight.
    #[tokio::test]
    async fn concurrent_shows_create_the_banner_window_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        let existing: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
        let creations = Arc::new(AtomicUsize::new(0));

        let mut tasks = Vec::new();
        for _ in 0..32 {
            let existing = Arc::clone(&existing);
            let creations = Arc::clone(&creations);
            tasks.push(tokio::spawn(async move {
                let lookup = {
                    let existing = Arc::clone(&existing);
                    move || *existing.lock().unwrap()
                };
                let create = {
                    let existing = Arc::clone(&existing);
                    let creations = Arc::clone(&creations);
                    move || {
                        creations.fetch_add(1, Ordering::SeqCst);
                        // Simulate the window build: the label only becomes
                        // visible to `lookup` once the build finishes.
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        *existing.lock().unwrap() = Some(7);
                        Ok::<u32, String>(7)
                    }
                };
                get_or_create_serialized(lookup, create).await
            }));
        }

        let mut created_flags = 0;
        for task in tasks {
            let (window, created) = task.await.expect("task").expect("get or create");
            assert_eq!(window, 7);
            if created {
                created_flags += 1;
            }
        }
        assert_eq!(creations.load(Ordering::SeqCst), 1, "window built once");
        assert_eq!(
            created_flags, 1,
            "exactly one caller owns post-build styling"
        );
    }

    #[tokio::test]
    async fn serialized_creation_surfaces_build_errors_and_lets_the_next_caller_retry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = AtomicUsize::new(0);
        let lookup = || None::<u32>;
        let failing = || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err::<u32, String>("boom".into())
        };
        assert_eq!(
            get_or_create_serialized(lookup, failing).await,
            Err("boom".to_string())
        );
        let succeeding = || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok::<u32, String>(1)
        };
        assert_eq!(
            get_or_create_serialized(lookup, succeeding).await,
            Ok((1, true))
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn banner_action_router_readiness_is_explicit() {
        let readiness = BannerActionRouterReadiness::default();
        assert!(!readiness.is_ready());
        readiness.set_ready(true);
        assert!(readiness.is_ready());
        readiness.set_ready(false);
        assert!(!readiness.is_ready());
    }
}
