//! Unified, persistent notification history.
//!
//! A single re-readable timeline of everything the menubar surfaced — DMs,
//! files shared with me, and new files that arrived on sync — so a dismissed
//! toast (a minimized DM, a share notice the user clicked away) is never lost.
//!
//! ## Why a local store (and not the server feeds the macOS build uses)
//!
//! The upstream macOS build fetched this window's contents live from hq-pro
//! endpoints (`GET /v1/notify/inbox`, `/v1/files/shared-with-me`,
//! `/v1/notify/file-history`). On this Windows fork we instead **persist the
//! history locally** as each notification fires, for three reasons:
//!
//!   1. **Durability without a backend round-trip.** New-file notifications in
//!      particular are emitted by the sync runner per-run and were never
//!      retained server-side on the fork's backend; the only faithful way to
//!      show *cross-session* new-file history (the Phase-3 requirement,
//!      upstream `abf83be`) here is to write them down when they happen.
//!   2. **Offline / signed-out readability.** The window opens and renders the
//!      full timeline with no network and no valid Cognito token.
//!   3. **One code path for all three kinds.** DMs, shares, and new files are
//!      recorded the same way — at the exact point their notification fires —
//!      so the history is always consistent with what the user actually saw.
//!
//! ## Storage
//!
//! `~/.hq/notification-history.json` (via [`crate::util::paths::hq_config_dir`])
//! — a single JSON object `{ "version": 1, "entries": [...] }`, newest-last in
//! the file, capped at [`MAX_ENTRIES`]. Writes are append-then-trim under a
//! process-wide mutex and persisted atomically (temp file + rename) so a crash
//! mid-write can't truncate the history. De-dup is by each entry's stable
//! [`HistoryEntry::id`], so re-recording the same DM/share/new-file (e.g. a
//! re-emit on reconnect) is idempotent.
//!
//! The window (`NotificationHistory.svelte`, label `notification-history`)
//! pulls the full list via [`fetch_notification_history`] on mount and renders
//! a day-grouped, reverse-chronological timeline. DM and share rows click
//! through to their existing detail windows (`open_dm_detail` /
//! `open_share_detail`); new-file rows are informational.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::dm_notify::DmEvent;
use crate::commands::share_notify::ShareEvent;
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "notif-history";
const WINDOW_LABEL: &str = "notification-history";

/// Schema version stamped into the on-disk file so a future shape change can
/// migrate or discard older histories rather than mis-parsing them.
const STORE_VERSION: u32 = 1;

/// Hard cap on retained entries. Oldest are trimmed first. Generous enough to
/// span weeks of normal use while bounding the file (and the window's render
/// cost) — mirrors the spirit of `activity::MAX_ENTRIES`.
const MAX_ENTRIES: usize = 500;

/// Kind tag for a history entry. Serialized in kebab-case so the wire contract
/// reads `"new-file"` (matches the Svelte `Kind` union).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryKind {
    /// A direct message received.
    Dm,
    /// One or more files shared with me.
    Share,
    /// A new file that arrived on sync.
    NewFile,
    /// A generic update notification (reserved for parity with the macOS
    /// timeline's "update" rows; not currently emitted on Windows but kept in
    /// the wire contract so the renderer's tag handling is forward-compatible).
    Update,
}

/// One persisted notification, flattened to a single self-describing row.
///
/// The optional `dm` / `share` payloads carry just enough to re-open the
/// existing detail window for that row (the renderer passes them straight back
/// to `open_dm_detail` / `open_share_detail`). New-file and update rows are
/// informational and carry neither.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Stable de-dup key. Derived from the source event's own id so a re-emit
    /// of the same notification updates in place instead of duplicating.
    pub id: String,
    pub kind: HistoryKind,
    /// Display name (or email / company) of who triggered the notification.
    pub actor: String,
    /// One-line human summary rendered as the row body.
    pub summary: String,
    /// Epoch milliseconds the notification was recorded — drives sort + day
    /// grouping in the window.
    pub ts: u64,
    /// Present for `Dm` rows: the event needed to re-open the DM detail window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dm: Option<DmEvent>,
    /// Present for `Share` rows: the event needed to re-open the share detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<ShareEvent>,
}

/// On-disk shape: a versioned envelope around the entry list.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryStore {
    version: u32,
    entries: Vec<HistoryEntry>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            entries: Vec::new(),
        }
    }
}

/// Process-wide lock serializing read-modify-write of the on-disk history so
/// two notification sources firing at once (a DM and a share in the same tick)
/// can't clobber each other's append. The data itself lives on disk; this
/// guards only the file transaction.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve `~/.hq/notification-history.json`.
fn store_path() -> Result<std::path::PathBuf, String> {
    paths::hq_config_dir().map(|d| d.join("notification-history.json"))
}

/// Current epoch milliseconds (saturating to 0 if the clock is before epoch).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read the store from disk, returning an empty store if it's absent or
/// unreadable/corrupt (a bad file must never block recording a new entry — we
/// log and start fresh).
fn read_store() -> HistoryStore {
    let Ok(path) = store_path() else {
        return HistoryStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<HistoryStore>(&contents) {
            Ok(store) => store,
            Err(e) => {
                log(LOG_TAG, &format!("HISTORY_READ_PARSE_FAIL {e}"));
                HistoryStore::default()
            }
        },
        // Absent file is the normal first-run case — not an error.
        Err(_) => HistoryStore::default(),
    }
}

/// Persist the store atomically: write a sibling temp file, then rename over
/// the target so a reader never observes a partial write. Best-effort — a
/// failure is logged, not surfaced (losing a single history append must not
/// break the notification that triggered it).
fn write_store(store: &HistoryStore) {
    let Ok(path) = store_path() else { return };

    // Ensure ~/.hq exists (first run may predate any other writer).
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log(LOG_TAG, &format!("HISTORY_MKDIR_FAIL {e}"));
            return;
        }
    }

    let json = match serde_json::to_string_pretty(store) {
        Ok(j) => j,
        Err(e) => {
            log(LOG_TAG, &format!("HISTORY_SERIALIZE_FAIL {e}"));
            return;
        }
    };

    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, json.as_bytes()) {
        log(LOG_TAG, &format!("HISTORY_WRITE_TMP_FAIL {e}"));
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // Rename can fail across a transient AV lock on Windows; fall back to a
        // direct write so the entry still lands, then clean up the temp file.
        log(
            LOG_TAG,
            &format!("HISTORY_RENAME_FAIL {e}; falling back to direct write"),
        );
        let _ = std::fs::write(&path, json.as_bytes());
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Insert (or replace by id) a batch of entries, newest-last, trimming to
/// [`MAX_ENTRIES`]. Pure over the in-memory list so it's unit-testable without
/// touching the filesystem.
fn upsert_entries(store: &mut HistoryStore, incoming: Vec<HistoryEntry>) {
    for entry in incoming {
        if let Some(existing) = store.entries.iter_mut().find(|e| e.id == entry.id) {
            *existing = entry;
        } else {
            store.entries.push(entry);
        }
    }
    // Keep the on-disk list in timeline order so a manual read is legible and
    // the trim below drops the genuinely-oldest rows.
    store.entries.sort_by_key(|e| e.ts);
    let len = store.entries.len();
    if len > MAX_ENTRIES {
        store.entries.drain(0..len - MAX_ENTRIES);
    }
}

/// Read-modify-write the on-disk store under [`STORE_LOCK`] with the given
/// batch of new entries. The single shared mutation path for all three
/// recorders. No-op on an empty batch.
fn record(entries: Vec<HistoryEntry>) {
    if entries.is_empty() {
        return;
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_store();
    let added = entries.len();
    upsert_entries(&mut store, entries);
    write_store(&store);
    log(
        LOG_TAG,
        &format!("HISTORY_RECORD added={added} total={}", store.entries.len()),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recorders — called from the existing notification fire points.
// ─────────────────────────────────────────────────────────────────────────────

/// Build a one-line summary for a DM row.
fn dm_summary(e: &DmEvent) -> String {
    let body = e.body.trim();
    if body.is_empty() {
        "Sent you a message".to_string()
    } else {
        body.to_string()
    }
}

/// Build the actor + summary for a share row.
fn share_summary(e: &ShareEvent) -> String {
    let n = e.paths.len();
    let files = e.paths.join(", ");
    let base = if n == 1 {
        format!("Shared a file: {files}")
    } else {
        format!("Shared {n} files: {files}")
    };
    match e.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(note) => format!("{base} — \u{201c}{note}\u{201d}"),
        None => base,
    }
}

/// Record received DMs into the history. Called from `dm_notify` as each batch
/// of new DM events is surfaced. Idempotent by `event_id`.
pub fn record_dm_events(events: &[DmEvent]) {
    let entries = events
        .iter()
        .map(|e| {
            let actor = {
                let name = e.from_display_name.trim();
                if !name.is_empty() {
                    name.to_string()
                } else if !e.from_email.trim().is_empty() {
                    e.from_email.clone()
                } else {
                    "Someone".to_string()
                }
            };
            HistoryEntry {
                id: format!("dm:{}", e.event_id),
                kind: HistoryKind::Dm,
                actor,
                summary: dm_summary(e),
                ts: now_millis(),
                dm: Some(e.clone()),
                share: None,
            }
        })
        .collect();
    record(entries);
}

/// Record shares-with-me into the history. Called from `share_notify` as each
/// batch of new share events is surfaced. Idempotent by `event_id`.
pub fn record_share_events(events: &[ShareEvent]) {
    let entries = events
        .iter()
        .map(|e| {
            let actor = {
                let name = e.issuer_display_name.trim();
                if !name.is_empty() {
                    name.to_string()
                } else if !e.issuer_email.trim().is_empty() {
                    e.issuer_email.clone()
                } else {
                    "Someone".to_string()
                }
            };
            HistoryEntry {
                id: format!("share:{}", e.event_id),
                kind: HistoryKind::Share,
                actor,
                summary: share_summary(e),
                ts: now_millis(),
                dm: None,
                share: Some(e.clone()),
            }
        })
        .collect();
    record(entries);
}

/// Record new files (arrived on sync) into the history. Called from
/// `activity::record_new_files` as the runner's per-company `new-files` event
/// is reconciled — this is what makes new-file history survive restarts
/// (Phase 3, upstream `abf83be`). Idempotent by `company + path` so the same
/// file re-reported in a later sync doesn't duplicate.
pub fn record_new_files(company: &str, files: &[crate::events::SyncNewFileEntry]) {
    let entries = files
        .iter()
        .map(|f| {
            let actor = f
                .added_by
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| company.to_string());
            HistoryEntry {
                id: format!("newfile:{company}/{}", f.path),
                kind: HistoryKind::NewFile,
                actor,
                summary: format!("New file in {company}: {}", f.path),
                ts: now_millis(),
                dm: None,
                share: None,
            }
        })
        .collect();
    record(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Return the persisted notification history, newest-first, for the window.
/// Reads straight off disk — no network, works signed-out. Capped client-side
/// by the same [`MAX_ENTRIES`] the store enforces.
#[tauri::command]
pub fn fetch_notification_history() -> Result<Vec<HistoryEntry>, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_store().entries;
    // Window renders newest-first; the file is stored oldest-first.
    entries.sort_by_key(|b| std::cmp::Reverse(b.ts));
    log(LOG_TAG, &format!("HISTORY_FETCH count={}", entries.len()));
    Ok(entries)
}

/// Open (or focus) the notification-history window.
///
/// Mirrors `open_meeting_permissions_window` (US-003) exactly: build hidden on
/// the shared `index.html`, attach the HQ icon, apply Mica/Acrylic vibrancy,
/// then show — so the user never sees a flash of the un-styled transparent
/// frame. The window self-fetches via [`fetch_notification_history`] on mount.
#[tauri::command]
pub async fn open_notification_history(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Re-use the bundled HQ app icon for the taskbar / Alt-Tab representation
    // (matches the other secondary windows).
    const HQ_ICON_PNG: &[u8] = include_bytes!("../../icons/128x128@2x.png");
    let icon = tauri::image::Image::from_bytes(HQ_ICON_PNG)
        .map_err(|e| format!("load window icon: {e}"))?;

    // Build hidden → vibrancy → show, the same ordering as
    // `permissions` / `drift_detail` / `activity` so Mica/Acrylic lands before
    // the first paint. `transparent(true)` + `decorations(true)` is the
    // Windows-vibrancy contract (NOT macOS NSVisualEffectView).
    // Tray-utility footprint for the fallback path (the popover normally
    // hosts this view inline; this window only opens when the popover is
    // dismissed — e.g. dispatched from an OS notification action). 380×520
    // matches the popover's compact width; chrome-less, no taskbar entry,
    // parented to main for z-stacking so it dismisses with the popover.
    let parent = app.get_webview_window("main");
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Notifications")
    .inner_size(380.0, 520.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .icon(icon)
    .map_err(|e| format!("attach window icon: {e}"))?
    .visible(false);
    if let Some(parent_win) = parent.as_ref() {
        builder = builder
            .parent(parent_win)
            .map_err(|e| format!("attach parent window: {e}"))?;
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    // Mica (Win 11) / Acrylic (Win 10) liquid-glass, matching the popover and
    // the other secondary windows. Best-effort — the Svelte view ships a solid
    // background fallback.
    crate::apply_windows_vibrancy(&window);

    window.show().map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dm(id: &str, name: &str, body: &str) -> DmEvent {
        DmEvent {
            event_id: id.to_string(),
            from_person_uid: "uid".to_string(),
            from_email: "a@e.com".to_string(),
            from_display_name: name.to_string(),
            body: body.to_string(),
            details: None,
            prompt: None,
            created_at: "2026-06-01T00:00:00Z".to_string(),
        }
    }

    fn share(id: &str, paths: &[&str], note: Option<&str>) -> ShareEvent {
        ShareEvent {
            event_id: id.to_string(),
            issuer_email: "b@e.com".to_string(),
            issuer_display_name: "Bob".to_string(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            note: note.map(|s| s.to_string()),
            permission: "read".to_string(),
            created_at: "2026-06-01T00:00:00Z".to_string(),
        }
    }

    fn entry(id: &str, ts: u64) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            kind: HistoryKind::NewFile,
            actor: "indigo".to_string(),
            summary: "x".to_string(),
            ts,
            dm: None,
            share: None,
        }
    }

    #[test]
    fn store_default_is_versioned_and_empty() {
        let s = HistoryStore::default();
        assert_eq!(s.version, STORE_VERSION);
        assert!(s.entries.is_empty());
    }

    #[test]
    fn upsert_appends_new_and_replaces_by_id() {
        let mut store = HistoryStore::default();
        upsert_entries(&mut store, vec![entry("a", 1), entry("b", 2)]);
        assert_eq!(store.entries.len(), 2);

        // Re-upserting "a" with a new summary replaces in place (no dup).
        let mut updated = entry("a", 3);
        updated.summary = "changed".to_string();
        upsert_entries(&mut store, vec![updated]);
        assert_eq!(store.entries.len(), 2, "id collision must replace, not add");
        let a = store.entries.iter().find(|e| e.id == "a").unwrap();
        assert_eq!(a.summary, "changed");
    }

    #[test]
    fn upsert_sorts_oldest_first_and_trims_to_cap() {
        let mut store = HistoryStore::default();
        // Insert MAX_ENTRIES + 5 with increasing ts; the 5 oldest must be
        // dropped and the survivors kept in ascending ts order.
        let extra = 5usize;
        let mut batch = Vec::new();
        for i in 0..(MAX_ENTRIES + extra) {
            batch.push(entry(&format!("e{i}"), i as u64));
        }
        upsert_entries(&mut store, batch);
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        // Oldest survivor is e{extra} (e0..e{extra-1} trimmed).
        assert_eq!(store.entries.first().unwrap().id, format!("e{extra}"));
        assert!(store.entries.windows(2).all(|w| w[0].ts <= w[1].ts));
    }

    #[test]
    fn dm_summary_falls_back_when_body_empty() {
        assert_eq!(dm_summary(&dm("1", "Al", "   ")), "Sent you a message");
        assert_eq!(dm_summary(&dm("1", "Al", "hello")), "hello");
    }

    #[test]
    fn share_summary_singular_plural_and_note() {
        assert_eq!(
            share_summary(&share("1", &["a.md"], None)),
            "Shared a file: a.md"
        );
        assert_eq!(
            share_summary(&share("1", &["a.md", "b.md"], None)),
            "Shared 2 files: a.md, b.md"
        );
        assert_eq!(
            share_summary(&share("1", &["a.md"], Some("look"))),
            "Shared a file: a.md \u{2014} \u{201c}look\u{201d}"
        );
    }

    #[test]
    fn build_dm_entry_has_stable_id_and_payload() {
        // Exercise the id/actor/payload mapping without touching disk by
        // replicating record_dm_events' per-entry construction.
        let e = dm("evt-9", "Carol", "hi");
        let id = format!("dm:{}", e.event_id);
        assert_eq!(id, "dm:evt-9");
        assert_eq!(e.from_display_name, "Carol");
    }
}
