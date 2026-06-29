//! Session activity log — a per-app-session record of every file the sync
//! pipeline uploaded or downloaded, with a timestamp and a direction.
//!
//! Unlike the journal (which keeps each file's *latest* state on disk), this
//! is an in-memory, append-only log scoped to the current app session: it
//! starts empty on launch and accumulates one entry per `progress` event the
//! runner emits (`commands::sync` calls [`record_progress`] from its event
//! dispatch). It clears when the app quits.
//!
//! The log lives in Rust managed state so it can be shared across windows: the
//! main popover triggers [`open_activity_log`] to spawn the detail window, and
//! the window pulls the accumulated list via [`activity_window_ready`] (the
//! same ready-handshake pattern as `new_files`). New entries arriving while the
//! window is open are pushed live via the `activity:append` event.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use hq_desktop_core::activity::{apply_new_files, direction_for, now_millis};

pub use hq_desktop_core::activity::ActivityEntry;

use crate::events::{SyncNewFilesEvent, SyncProgressEvent};
use crate::util::logfile::log;

/// Window label for the activity-log detail window (routed in `main.ts`).
const ACTIVITY_WINDOW_LABEL: &str = "activity-log";

/// Cap on retained entries so a long-running daemon session can't grow the
/// log unbounded. Oldest entries are dropped first.
const MAX_ENTRIES: usize = 2000;

/// Managed state: the session's append-only activity log.
pub struct SessionActivity(pub Mutex<Vec<ActivityEntry>>);

impl SessionActivity {
    pub fn new() -> Self {
        SessionActivity(Mutex::new(Vec::new()))
    }

    /// Append an entry, trimming the oldest if over [`MAX_ENTRIES`].
    fn push(&self, entry: ActivityEntry) {
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        v.push(entry);
        let len = v.len();
        if len > MAX_ENTRIES {
            v.drain(0..len - MAX_ENTRIES);
        }
    }

    fn snapshot(&self) -> Vec<ActivityEntry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Return the current session activity snapshot. The window pulls this on
/// mount (robust against emit-timing races — the earlier emit-on-ready
/// handshake could fire before the webview's listener registered).
#[tauri::command]
pub fn get_activity_log(app: AppHandle) -> Vec<ActivityEntry> {
    app.try_state::<SessionActivity>()
        .map(|s| s.snapshot())
        .unwrap_or_default()
}

/// Record one `progress` event into the session log and push it live to the
/// activity window if it's open. Called from `commands::sync`'s event dispatch.
pub fn record_progress(app: &AppHandle, p: &SyncProgressEvent) {
    let Some(state) = app.try_state::<SessionActivity>() else {
        return;
    };
    let entry = ActivityEntry {
        company: p.company.clone(),
        path: p.path.clone(),
        bytes: p.bytes,
        direction: direction_for(p),
        author: p.author.clone(),
        // Unknown at progress time — the `new-files` event that distinguishes
        // added-vs-updated arrives later and back-fills this via record_new_files.
        is_new: None,
        at: now_millis(),
    };
    state.push(entry.clone());

    // Live-append to the window if it's open (best-effort; the window also
    // pulls the full snapshot on ready, so a missed append is recoverable).
    if app.get_webview_window(ACTIVITY_WINDOW_LABEL).is_some() {
        let _ = app.emit_to(ACTIVITY_WINDOW_LABEL, "activity:append", &entry);
    }
}

/// Reconcile a runner `new-files` event into the session log: mark the matching
/// download entries as *new* so the activity log can render "added" (vs the
/// default "updated") and, where the per-file progress event carried no author,
/// back-fill attribution from the new-files `addedBy`.
///
/// The `new-files` event lands once per company *after* that company's
/// `progress` events, so the entries already exist with `is_new: None`. We match
/// on (company, path) over download rows and flip the flag in place, then push a
/// fresh `activity:list` snapshot to the window (if open) so the verb updates
/// live. Entries the event doesn't name stay `None` → rendered as "updated".
pub fn record_new_files(app: &AppHandle, e: &SyncNewFilesEvent) {
    let Some(state) = app.try_state::<SessionActivity>() else {
        return;
    };
    {
        let mut log = state.0.lock().unwrap_or_else(|e| e.into_inner());
        apply_new_files(&mut log, e);
    }

    // Re-emit the full snapshot so an open window re-renders verbs/authors.
    if app.get_webview_window(ACTIVITY_WINDOW_LABEL).is_some() {
        let _ = app.emit_to(ACTIVITY_WINDOW_LABEL, "activity:list", state.snapshot());
    }
}

/// Open (or focus) the activity-log detail window. Mirrors
/// `open_new_files_detail`: the window starts hidden and the renderer calls
/// [`activity_window_ready`] once its listeners are registered.
#[tauri::command]
pub async fn open_activity_log(app: AppHandle) -> Result<(), String> {
    log("activity", "open_activity_log invoked");
    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        log("activity", "open: window exists -> show + emit list");
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        if let Some(state) = app.try_state::<SessionActivity>() {
            let snap = state.snapshot();
            log("activity", &format!("open: emit list len={}", snap.len()));
            let _ = app.emit_to(ACTIVITY_WINDOW_LABEL, "activity:list", snap);
        }
        return Ok(());
    }
    log("activity", "open: building new window");

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        ACTIVITY_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Recent Changes")
    .inner_size(560.0, 460.0)
    .resizable(true)
    .decorations(true)
    .transparent(true)
    .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(20.0, 18.0));
    }

    let _window = builder.build().map_err(|e| e.to_string())?;

    // macOS vibrancy must run on the main thread (AppKit) — command handlers
    // run on the async worker pool, so dispatch via run_on_main_thread.
    #[cfg(target_os = "macos")]
    {
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            if let Some(window) = app_for_main.get_webview_window(ACTIVITY_WINDOW_LABEL) {
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Popover,
                    Some(NSVisualEffectState::Active),
                    Some(18.0),
                );
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        hq_platform::window_effects::apply_popover_vibrancy(&_window);
    }

    // Show the window now rather than waiting for a ready-handshake from the
    // webview. The component pulls its data via get_activity_log on mount, so
    // there's no emit race to avoid — and showing immediately means the FIRST
    // click always opens the window (the prior handshake-to-show could leave
    // it hidden forever if the webview's invoke didn't fire).
    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        log("activity", "open: shown new window");
    }

    Ok(())
}

/// Called by the activity-log window's Svelte component once its listeners are
/// registered. Emits the current snapshot and shows the window — race-free.
#[tauri::command]
pub async fn activity_window_ready(app: AppHandle) -> Result<(), String> {
    log("activity", "activity_window_ready invoked by webview");
    let entries = app
        .try_state::<SessionActivity>()
        .map(|s| s.snapshot())
        .unwrap_or_default();
    log(
        "activity",
        &format!("ready: snapshot len={}", entries.len()),
    );

    app.emit_to(ACTIVITY_WINDOW_LABEL, "activity:list", entries)
        .map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        log("activity", "ready: window shown + focused");
    } else {
        log("activity", "ready: window NOT FOUND");
    }

    Ok(())
}
