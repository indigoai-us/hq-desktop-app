//! Share-notification poller for HQ Sync (US-004).
//!
//! Polls `/v1/files/shared-with-me` on app launch (5s delay, matching the
//! updater pattern) and after every `sync:all-complete` event. Emits a
//! `share:new-events` Tauri event to the Svelte renderer when new events
//! are found, which US-005 will consume to fire macOS notifications and open
//! the ShareDetail window.
//!
//! ## Feature gating
//!
//! A single check gates a poll: the **`shareNotifications`** preference in
//! `~/.hq/menubar.json` (re-read on every poll cycle so the Settings toggle
//! takes effect immediately after the next sync without an app restart;
//! defaults ON when absent or unreadable).
//!
//! The former `@getindigo.ai` dogfood gate was removed 2026-05-26 — see
//! `should_poll` for the full rationale (it silently suppressed notifications
//! for recipients signed in under a non-getindigo Cognito identity).
//!
//! ## Cursor
//!
//! `~/.hq/share-notify-cursor.json` is a JSON object keyed by `machineId`
//! (from `ensure_machine_id`) so multiple Macs for the same user each track
//! their own polling position independently. The value is an ISO8601 string
//! passed as `since=` in the query. Absent → no `since=` (server returns all
//! events up to the default limit).
//!
//! ## Singleton lock
//!
//! A `std::sync::Mutex<bool>` (`POLL_IN_FLIGHT`) prevents concurrent polls.
//! The guard is dropped before the async HTTP call so it is never held across
//! an `.await` point (MutexGuard is !Send).
//!
//! ## Log codes
//!
//! All log lines to `~/.hq/logs/hq-sync.log` carry a `share-notify` tag and
//! one of these code prefixes so support can grep for them:
//!   `SHARE_NOTIFY_POLL_SKIP`          — gate/preference disabled or in-flight
//!   `SHARE_NOTIFY_POLL_START`         — poll request about to fire
//!   `SHARE_NOTIFY_POLL_OK`            — poll succeeded (may have 0 events)
//!   `SHARE_NOTIFY_POLL_AUTH_FAIL`     — 401/403 or token resolution failure
//!   `SHARE_NOTIFY_POLL_NETWORK_FAIL`  — reqwest transport error
//!   `SHARE_NOTIFY_POLL_ERROR`         — 4xx/5xx other than auth, or parse fail

use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;
#[allow(unused_imports)]
pub use hq_desktop_core::share_notify::{
    clear_in_flight, cursor_path, notification_body, notification_title, partition_unnotified,
    poll_lock, read_cursor_entry, read_cursor_store, share_notifications_enabled, share_path_title,
    try_set_in_flight, write_cursor_entry, BlockingNotifyGuard, CursorEntry, CursorEntryCompat,
    CursorStore, NotificationShareActionEvent, PendingShareEvents, ShareEvent,
    SharedWithMeResponse, EVENT_NOTIFICATION_SHARE_ACTION, EVENT_SHARE_EVENTS_LIST,
    EVENT_SHARE_NEW_EVENTS, LOG_TAG, NOTIFIED_CAP, SHARE_DETAIL_LABEL, SHARE_POLL_INTERVAL_SECS,
};

// ── Gate check ───────────────────────────────────────────────────────────────

/// Returns true when the user preference allows polling. Re-reads menubar.json
/// on every call so toggling the setting takes effect on the next poll without
/// an app restart.
///
/// NOTE: the former `@getindigo.ai` dogfood gate (`feature_gate::is_indigo_user`)
/// was removed 2026-05-26 once the share-notify feature was proven in production.
/// Gating the poller to indigo emails silently suppressed macOS notifications for
/// any recipient whose HQ Sync was signed in under a non-`@getindigo.ai` Cognito
/// identity: the grant resolves to the recipient's canonical personUid and the
/// `SHARE_EVENT` row + email fallback are written correctly, but the poller never
/// ran, so the events sat unacked forever and no notification fired. The
/// `shareNotifications` pref is now the only gate. (Other features — meetings,
/// staging-drift, release-channel — keep their own independent indigo gates.)
async fn should_poll() -> bool {
    let pref = match crate::commands::settings::get_settings().await {
        Ok(prefs) => prefs.share_notifications,
        Err(_) => None, // settings unreadable → fall through to default
    };
    share_notifications_enabled(pref)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Spawn the share-notify poller. Called from `main.rs` setup. Runs a launch
/// poll after a 5-second delay (matches the updater pattern — gives the app
/// time to fully initialize and the Cognito token to be loaded from disk),
/// then polls on an independent `SHARE_POLL_INTERVAL_SECS` timer so delivery
/// is decoupled from sync completion. `poll_once` is singleton-guarded
/// (`POLL_IN_FLIGHT`) so this composes safely with the post-sync poll.
pub fn setup_share_notify_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        // Launch poll: shares + DM inbox (one timer, two fetches — the DM
        // channel rides this same independent timer so it can never inherit
        // the sync-coupling flaw that broke share notifications).
        poll_once(app.clone()).await;
        crate::commands::dm_notify::poll_dm_once(app.clone()).await;

        let mut ticker =
            tokio::time::interval(tokio::time::Duration::from_secs(SHARE_POLL_INTERVAL_SECS));
        // The first tick fires immediately; consume it so the launch poll
        // above isn't double-counted, then poll once per interval thereafter.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            poll_once(app.clone()).await;
            crate::commands::dm_notify::poll_dm_once(app.clone()).await;
        }
    });
}

/// Fire one poll cycle. Skips if another poll is already in flight (singleton
/// guard). Safe to call from the `sync:all-complete` listener or the Tauri
/// command handler — the guard prevents overlap.
pub async fn poll_once(app: AppHandle) {
    if !try_set_in_flight() {
        log(LOG_TAG, "SHARE_NOTIFY_POLL_SKIP poll already in-flight");
        return;
    }
    do_poll(&app).await;
    clear_in_flight();
}

/// Tauri command: manual poll trigger. Exposed so the frontend (and tests)
/// can force a poll without waiting for a sync event.
#[tauri::command]
pub async fn poll_shared_with_me(app: AppHandle) -> Result<(), String> {
    poll_once(app).await;
    Ok(())
}

// ── Core poll logic ───────────────────────────────────────────────────────────

async fn do_poll(app: &AppHandle) {
    if !should_poll().await {
        log(
            LOG_TAG,
            "SHARE_NOTIFY_POLL_SKIP feature gate or setting disabled",
        );
        return;
    }

    // Cursor key: machineId so each Mac tracks independently.
    let machine_id = match crate::commands::config::ensure_machine_id() {
        Ok(id) => id,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_POLL_ERROR cannot resolve machineId: {e}"),
            );
            return;
        }
    };

    // Resolved + refreshed access token (transparent Cognito refresh).
    let access_token = match cognito::get_valid_access_token().await {
        Ok(t) => t,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_POLL_AUTH_FAIL token error: {e}"),
            );
            return;
        }
    };

    let base_url = match resolve_vault_api_url() {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(e) => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_POLL_ERROR cannot resolve vault URL: {e}"),
            );
            return;
        }
    };

    let entry = read_cursor_entry(&machine_id);
    let since = entry.cursor.clone();
    let url = match since.as_deref() {
        Some(s) => format!("{}/v1/files/shared-with-me?since={}&limit=50", base_url, s),
        None => format!("{}/v1/files/shared-with-me?limit=50", base_url),
    };

    log(
        LOG_TAG,
        &format!("SHARE_NOTIFY_POLL_START since={:?}", since),
    );

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .send()
        .await;

    match resp {
        Err(e) => {
            log(LOG_TAG, &format!("SHARE_NOTIFY_POLL_NETWORK_FAIL {e}"));
        }
        Ok(r) => {
            let status = r.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                log(
                    LOG_TAG,
                    &format!("SHARE_NOTIFY_POLL_AUTH_FAIL status={status}"),
                );
                return;
            }
            if !status.is_success() {
                log(LOG_TAG, &format!("SHARE_NOTIFY_POLL_ERROR status={status}"));
                return;
            }
            match r.json::<SharedWithMeResponse>().await {
                Err(e) => {
                    log(
                        LOG_TAG,
                        &format!("SHARE_NOTIFY_POLL_ERROR parse failed: {e}"),
                    );
                }
                Ok(body) => {
                    if body.events.is_empty() {
                        log(LOG_TAG, "SHARE_NOTIFY_POLL_OK no new events");
                        return;
                    }

                    // Dedupe by eventId BEFORE notifying: the endpoint's `?since=`
                    // is inclusive, so the boundary event(s) come back every poll.
                    // `fresh` is the never-notified subset; `notified` is the
                    // updated ring we persist below.
                    let (fresh, notified) = partition_unnotified(&body.events, &entry.notified);

                    // Advance the timestamp cursor to the newest event seen this
                    // poll (across ALL returned events, not just fresh) so the
                    // `?since=` window keeps narrowing over time.
                    let newest = body
                        .events
                        .iter()
                        .map(|e| e.created_at.as_str())
                        .max()
                        .unwrap_or_default();
                    write_cursor_entry(
                        &machine_id,
                        &CursorEntry {
                            cursor: (!newest.is_empty())
                                .then(|| newest.to_string())
                                .or(entry.cursor.clone()),
                            notified,
                        },
                    );

                    if fresh.is_empty() {
                        log(
                            LOG_TAG,
                            &format!(
                                "SHARE_NOTIFY_POLL_OK no new events ({} already notified)",
                                body.events.len()
                            ),
                        );
                        return;
                    }

                    log(
                        LOG_TAG,
                        &format!(
                            "SHARE_NOTIFY_POLL_OK {} event(s) ({} new), cursor→{}",
                            body.events.len(),
                            fresh.len(),
                            newest
                        ),
                    );

                    #[cfg(target_os = "macos")]
                    {
                        // Lazily register the bundle identifier with mac-notification-sys
                        // on the first send per process. Without this, the library calls
                        // `get_bundle_identifier_or_default("use_default")` internally,
                        // which triggers a macOS "Choose Application" picker because
                        // Launch Services can't resolve the literal "use_default" to an
                        // installed app. Mirrors the fix in commands/meetings.rs.
                        //
                        // `set_application` itself is guarded by an internal Once, so
                        // calling it on every send would be safe — wrapping in our own
                        // OnceLock keeps the log line at one-per-process.
                        static NOTIFICATION_APP_INIT: OnceLock<()> = OnceLock::new();
                        NOTIFICATION_APP_INIT.get_or_init(|| {
                            const BUNDLE_ID: &str = "ai.indigo.hq-sync-menubar";
                            match mac_notification_sys::set_application(BUNDLE_ID) {
                                Ok(()) => log(
                                    LOG_TAG,
                                    &format!("SHARE_NOTIFY_BUNDLE_SET bundle={BUNDLE_ID}"),
                                ),
                                Err(e) => log(
                                    LOG_TAG,
                                    &format!(
                                        "SHARE_NOTIFY_BUNDLE_SET_FAILED bundle={BUNDLE_ID} err={e}"
                                    ),
                                ),
                            }
                        });

                        // Fire one macOS notification per share event (US-005).
                        //
                        // We use mac-notification-sys directly (NOT tauri-plugin-
                        // notification) so we can attach a `DropdownActions` button
                        // labelled "Actions" with two options ("Copy prompt", "Open
                        // details") that reveal on hover. The spawned thread blocks
                        // on `wait_for_click(true).send()` until the user interacts
                        // (or macOS auto-dismisses) and emits a Tauri event for the
                        // frontend listener to handle.
                        //
                        // Custom-banner path: when `customBanner` is enabled, route
                        // each share through the in-app banner (event-driven, no
                        // busy-spinning Cocoa run loop) and skip the native firing
                        // loop below entirely. The tray badge + `share:new-events`
                        // emit after the branch run for both paths.
                        if crate::commands::banner::custom_banner_enabled() {
                            log(
                                LOG_TAG,
                                &format!("SHARE_NOTIFY_CUSTOM_BANNER {} event(s)", fresh.len()),
                            );
                            for evt in &fresh {
                                if let Err(e) = crate::commands::banner::show_share_banner(
                                    app.clone(),
                                    evt.clone(),
                                )
                                .await
                                {
                                    log(LOG_TAG, &format!("SHARE_NOTIFY_BANNER_FAIL err={e}"));
                                }
                            }
                        } else {
                            for evt in &fresh {
                                let body_text = notification_body(evt.note.as_deref(), &evt.paths);
                                let title = notification_title(&evt.issuer_display_name);
                                let app_for_thread = app.clone();
                                let event_clone = evt.clone();

                                std::thread::spawn(move || {
                                    let mut notification =
                                        mac_notification_sys::Notification::default();
                                    // The dropdown title appears as the visible button
                                    // label; the slice elements are the dropdown items.
                                    // Order = display order.
                                    notification
                                        .title(&title)
                                        .message(&body_text)
                                        // Body-click = primary action (open Claude Code
                                        // with the templated prompt prefilled, see the
                                        // Body-click = primary action: open Claude
                                        // Code with the templated prompt prefilled
                                        // (see "claude" branch in App.svelte).
                                        // Dropdown surfaces two explicit alternatives:
                                        //   * Copy prompt   — clipboard only (no app
                                        //     open) for users who already have a
                                        //     session running or want to paste
                                        //     elsewhere.
                                        //   * Open details  — ShareDetail window with
                                        //     full path list + Open in HQ Console.
                                        // Copy is intentionally redundant w/ body-
                                        // click for the LLM-session case; explicit
                                        // discoverability beats minimalism here
                                        // (user direction 2026-05-26).
                                        .main_button(
                                            mac_notification_sys::MainButton::DropdownActions(
                                                "Actions",
                                                &["Copy prompt", "Open details"],
                                            ),
                                        );

                                    // CPU cap (Option 1): only the holder of the single
                                    // blocking-send slot may use `wait_for_click(true)`
                                    // (which busy-spins until the user acts — see
                                    // BlockingNotifyGuard docs). Any concurrent send
                                    // falls back to fire-and-forget so we never
                                    // accumulate spinning threads. The guard is dropped
                                    // the instant the blocking send returns.
                                    let response = match BlockingNotifyGuard::try_acquire() {
                                        Some(guard) => {
                                            let r = notification.wait_for_click(true).send();
                                            drop(guard);
                                            r
                                        }
                                        None => notification.send(),
                                    };

                                    match response {
                                        Ok(resp) => {
                                            // Body-click → "claude": opens Claude
                                            // Code (`claude://code/new?q=…&folder=…`)
                                            // with the templated prompt pre-filled
                                            // and cwd at the user's HQ folder. The
                                            // recipient lands in an LLM session
                                            // ready to act on the shared files
                                            // without a paste step.
                                            //
                                            // Dropdown "Open details" → open the
                                            // ShareDetail window for a UI surface
                                            // (path list + Copy prompt fallback +
                                            // Open in HQ Console link).
                                            //
                                            // The frontend listener in App.svelte
                                            // owns the URL build + Tauri-command
                                            // dispatch.
                                            let action: Option<&'static str> = match resp {
                                        mac_notification_sys::NotificationResponse::ActionButton(name)
                                            if name.eq_ignore_ascii_case("copy prompt") =>
                                        {
                                            Some("copy")
                                        }
                                        mac_notification_sys::NotificationResponse::ActionButton(name)
                                            if name.eq_ignore_ascii_case("open details") =>
                                        {
                                            Some("open")
                                        }
                                        mac_notification_sys::NotificationResponse::Click => Some("claude"),
                                        // CloseButton / Reply / None — no actionable signal.
                                        _ => None,
                                    };

                                            if let Some(action) = action {
                                                let payload = NotificationShareActionEvent {
                                                    action: action.to_string(),
                                                    event_id: event_clone.event_id.clone(),
                                                    event: event_clone,
                                                };
                                                if let Err(e) = app_for_thread
                                                    .emit(EVENT_NOTIFICATION_SHARE_ACTION, &payload)
                                                {
                                                    log(
                                                LOG_TAG,
                                                &format!(
                                                    "SHARE_NOTIFY_EMIT_ACTION_FAILED action={action} err={e}"
                                                ),
                                            );
                                                }
                                            }
                                        }
                                        Err(e) => log(
                                            LOG_TAG,
                                            &format!("SHARE_NOTIFY_SEND_FAILED err={e}"),
                                        ),
                                    }
                                });
                            }
                        } // end else — native firing path
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        use tauri_plugin_notification::NotificationExt;
                        for evt in &fresh {
                            let body_text = notification_body(evt.note.as_deref(), &evt.paths);
                            let title = notification_title(&evt.issuer_display_name);
                            match app
                                .notification()
                                .builder()
                                .title(&title)
                                .body(&body_text)
                                .show()
                            {
                                Ok(()) => {
                                    log(LOG_TAG, &format!("SHARE_NOTIFY_TOAST_SHOWN title={title}"))
                                }
                                Err(e) => {
                                    log(LOG_TAG, &format!("SHARE_NOTIFY_SEND_FAILED err={e}"))
                                }
                            }
                        }
                    }

                    // Badge the tray icon with the count of newly-notified events.
                    crate::tray::set_share_badge(app, fresh.len());

                    // Emit to frontend — US-005 listens here (currently no-op
                    // after the eager-open removal, kept for future popover UI).
                    let _ = app.emit(EVENT_SHARE_NEW_EVENTS, &fresh);
                }
            }
        }
    }
}

// ── ShareDetail window ─────────────────────────────────────────────────────────

/// Tauri command: open (or focus) the ShareDetail window with the given events.
///
/// Mirrors `open_new_files_detail` in new_files.rs:
/// 1. Stash events in `PendingShareEvents` managed state.
/// 2. If window exists, show + focus it and re-emit the list directly.
/// 3. Otherwise create it hidden; `share_detail_window_ready` will show it.
#[tauri::command]
pub async fn open_share_detail(app: AppHandle, events: Vec<ShareEvent>) -> Result<(), String> {
    // Stash so the ready-handshake can retrieve them.
    if let Some(state) = app.try_state::<PendingShareEvents>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = events.clone();
    }

    if let Some(window) = app.get_webview_window(SHARE_DETAIL_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        app.emit_to(SHARE_DETAIL_LABEL, EVENT_SHARE_EVENTS_LIST, &events)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        SHARE_DETAIL_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Shared with Me")
    .inner_size(640.0, 560.0)
    .resizable(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Tauri command: called by ShareDetail.svelte once its event listener is
/// registered. Emits pending events, shows the window, fires best-effort ack,
/// and clears the tray badge.
#[tauri::command]
pub async fn share_detail_window_ready(app: AppHandle) -> Result<(), String> {
    let events: Vec<ShareEvent> = app
        .try_state::<PendingShareEvents>()
        .map(|s| s.0.lock().unwrap_or_else(|p| p.into_inner()).clone())
        .unwrap_or_default();

    app.emit_to(SHARE_DETAIL_LABEL, EVENT_SHARE_EVENTS_LIST, &events)
        .map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window(SHARE_DETAIL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    // Best-effort ack — fire-and-forget so the window doesn't block on it.
    if !events.is_empty() {
        let event_ids: Vec<String> = events.iter().map(|e| e.event_id.clone()).collect();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            post_ack(&app_clone, event_ids).await;
            crate::tray::clear_share_badge(&app_clone);
        });
    }

    Ok(())
}

/// POST `/v1/files/shared-with-me/ack` with the given event IDs.
/// Best-effort: errors are logged but never surfaced to the caller.
async fn post_ack(_app: &AppHandle, event_ids: Vec<String>) {
    let access_token = match cognito::get_valid_access_token().await {
        Ok(t) => t,
        Err(e) => {
            log(LOG_TAG, &format!("SHARE_NOTIFY_ACK_AUTH_FAIL {e}"));
            return;
        }
    };
    let base_url = match resolve_vault_api_url() {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(e) => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_ACK_ERROR cannot resolve vault URL: {e}"),
            );
            return;
        }
    };
    let url = format!("{}/v1/files/shared-with-me/ack", base_url);
    let body = serde_json::json!({ "eventIds": event_ids });

    match build_client()
        .post(&url)
        .header("authorization", format!("Bearer {}", access_token))
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_ACK_OK {} event(s)", event_ids.len()),
            );
        }
        Ok(r) => {
            log(
                LOG_TAG,
                &format!("SHARE_NOTIFY_ACK_ERROR status={}", r.status()),
            );
        }
        Err(e) => {
            log(LOG_TAG, &format!("SHARE_NOTIFY_ACK_NETWORK_FAIL {e}"));
        }
    }
}
