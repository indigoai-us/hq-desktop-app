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
    // Windows parity: persist new-file notifications before touching the
    // session-only activity state so cross-session history survives restarts.
    crate::commands::notification_history::record_new_files(&e.company, &e.files);

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

/// Open Activity as a typed desktop destination (US-004 WindowRouter).
///
/// Legacy name kept for frontend IPC. Session activity lives on the desktop
/// Home digest — no longer creates a top-level `activity-log` webview.
/// Live `activity:append` / `activity:list` events still update any open
/// desktop that listens.
#[tauri::command]
pub async fn open_activity_log(app: AppHandle) -> Result<(), String> {
    log(
        "activity",
        "open_activity_log → desktop destination home/activity",
    );
    crate::commands::desktop_alt::open_destination(
        app,
        crate::commands::desktop_alt::DesktopDestination::Activity,
    )
    .await
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
