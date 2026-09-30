//! App-side owner of the plan-limit upload pause (hard-stop-readiness US-019).
//!
//! The runner sends one `plan-limit` notice per company per pass when hq-pro
//! refuses new uploads. This module keeps the process-wide
//! [`UploadsPausedRegistry`] (seeded once from the desktop sync journal),
//! records notices as they stream in, settles the registry when a pass ends,
//! and announces every change to the desktop window on
//! [`EVENT_SYNC_UPLOADS_PAUSED`] and to the menu bar through the sink the tray
//! registers at setup. Both are targeted: a broadcast `emit` would wake every
//! webview, and `scripts/perf-budget-contract.test.ts` caps those.

use std::sync::{Mutex, OnceLock};

use hq_desktop_core::uploads_paused::{
    uploads_paused_summary, UploadsPassObservation, UploadsPaused, UploadsPausedRegistry,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::events::SyncPlanLimitEvent;
use crate::util::logfile::log;

/// Sent to the desktop window whenever the paused set changes. Payload:
/// [`UploadsPausedPayload`].
pub const EVENT_SYNC_UPLOADS_PAUSED: &str = "sync:uploads-paused";

/// Wire shape of [`EVENT_SYNC_UPLOADS_PAUSED`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadsPausedPayload {
    pub companies: Vec<UploadsPaused>,
    /// "Uploads paused for Acme" — null when nothing is paused.
    pub summary: Option<String>,
}

impl UploadsPausedPayload {
    pub fn from_snapshot(companies: Vec<UploadsPaused>) -> Self {
        let summary = uploads_paused_summary(&companies);
        Self { companies, summary }
    }
}

#[derive(Default)]
struct State {
    registry: UploadsPausedRegistry,
    /// True once the journal has been read (or there was nothing to read).
    seeded: bool,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// The menu bar's receiver for a new paused set.
type TraySink = Box<dyn Fn(Vec<UploadsPaused>) + Send + Sync>;

fn tray_sink() -> &'static OnceLock<TraySink> {
    static SINK: OnceLock<TraySink> = OnceLock::new();
    &SINK
}

/// Register the menu bar's receiver (the tray module, once, at setup). A
/// direct call rather than an event: an app-level Rust listener only hears
/// broadcast `emit`s, and a broadcast wakes every open webview.
pub fn set_tray_sink(sink: impl Fn(Vec<UploadsPaused>) + Send + Sync + 'static) {
    if tray_sink().set(Box::new(sink)).is_err() {
        log("tray", "uploads-paused tray sink was already registered");
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn with_state<T>(hq_folder: Option<&str>, f: impl FnOnce(&mut UploadsPausedRegistry) -> T) -> T {
    let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
    if !guard.seeded {
        if let Some(folder) = hq_folder.filter(|f| !f.trim().is_empty()) {
            let persisted = hq_desktop_core::status::try_journal_uploads_paused(folder);
            // A notice may already have arrived before the first seed; keep it.
            let mut seeded = UploadsPausedRegistry::from_snapshot(persisted);
            for entry in guard.registry.snapshot() {
                seeded.record_notice(&entry.company, entry.upgrade_url, entry.last_notice_at_ms);
            }
            guard.registry = seeded;
            guard.seeded = true;
        }
    }
    f(&mut guard.registry)
}

/// Current paused set (seeding from the journal under `hq_folder` if this
/// process has not read it yet).
pub fn snapshot(hq_folder: Option<&str>) -> Vec<UploadsPaused> {
    with_state(hq_folder, |registry| registry.snapshot())
}

/// The recorded upgrade link for a paused company.
pub fn upgrade_url_for(company: &str) -> Option<String> {
    with_state(None, |registry| registry.upgrade_url_for(company))
}

/// Record one runner `plan-limit` notice and announce a visible change.
pub fn record_plan_limit<R: Runtime>(
    app: &AppHandle<R>,
    hq_folder: &str,
    notice: &SyncPlanLimitEvent,
) {
    let approved = hq_desktop_core::plan_limit::approved_plan_upgrade_url(&notice.upgrade_url);
    if approved.is_none() {
        log(
            "sync",
            "plan-limit notice carried an upgrade link on an unapproved host; showing it without one",
        );
    }
    let (changed, snapshot) = with_state(Some(hq_folder), |registry| {
        let changed = registry.record_notice(&notice.company, approved, now_ms());
        (changed, registry.snapshot())
    });
    if changed {
        publish(app, snapshot);
    }
}

/// Settle a finished pass and return the snapshot to persist in the journal.
pub fn settle_pass<R: Runtime>(
    app: &AppHandle<R>,
    hq_folder: &str,
    pass: &UploadsPassObservation,
) -> Vec<UploadsPaused> {
    let (changed, snapshot) = with_state(Some(hq_folder), |registry| {
        let changed = registry.settle_pass(pass, now_ms());
        (changed, registry.snapshot())
    });
    if changed {
        publish(app, snapshot.clone());
    }
    snapshot
}

/// Forget the paused set (sign-out: the next account starts clean).
pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    let changed = with_state(None, |registry| registry.clear());
    if changed {
        publish(app, Vec::new());
    }
}

/// Announce the current set once at startup so the menu bar reflects a pause
/// the journal carried over from the previous run.
pub fn publish_current<R: Runtime>(app: &AppHandle<R>) {
    let folder = crate::commands::status::resolve_hq_folder_path().ok();
    let snapshot = snapshot(folder.as_deref());
    publish(app, snapshot);
}

fn publish<R: Runtime>(app: &AppHandle<R>, snapshot: Vec<UploadsPaused>) {
    if let Some(sink) = tray_sink().get() {
        sink(snapshot.clone());
    }
    if let Err(error) = app.emit_to(
        crate::commands::desktop_alt::WINDOW_LABEL,
        EVENT_SYNC_UPLOADS_PAUSED,
        UploadsPausedPayload::from_snapshot(snapshot),
    ) {
        log("sync", &format!("failed to emit uploads-paused: {error}"));
    }
}

/// Open the approved upgrade link recorded for a paused company (tray menu).
pub fn open_upgrade_for_company<R: Runtime>(app: &AppHandle<R>, company: &str) -> bool {
    let company = company.trim();
    let Some(url) = upgrade_url_for(company) else {
        log(
            "tray",
            "upgrade requested for a company with no recorded upgrade link",
        );
        return false;
    };
    crate::util::external_links::open_plan_upgrade_url(app, &url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_names_the_paused_companies() {
        let payload = UploadsPausedPayload::from_snapshot(vec![UploadsPaused {
            company: "Acme".into(),
            upgrade_url: Some("https://hq.computer/companies/acme/billing?upgrade=1".into()),
            last_notice_at_ms: 1,
        }]);
        let wire = serde_json::to_value(&payload).unwrap();
        assert_eq!(wire["summary"], "Uploads paused for Acme");
        assert_eq!(wire["companies"][0]["company"], "Acme");
        assert_eq!(
            wire["companies"][0]["upgradeUrl"],
            "https://hq.computer/companies/acme/billing?upgrade=1"
        );
        let empty = serde_json::to_value(UploadsPausedPayload::from_snapshot(Vec::new())).unwrap();
        assert_eq!(empty["summary"], serde_json::Value::Null);
        assert_eq!(empty["companies"], serde_json::json!([]));
    }
}
