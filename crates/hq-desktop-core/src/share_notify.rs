//! Pure and synchronous support for the HQ desktop share-notification command
//! layer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::paths;

// ── Blocking-notification concurrency cap ─────────────────────────────────────
//
// `mac-notification-sys` 0.6.12 busy-spins a Cocoa run loop inside
// `Notification::send()` when `wait_for_click(true)` is set: its
// `NotificationCenterDelegate keepRunning` loop calls
// `[[NSRunLoop currentRunLoop] runUntilDate:…]` on a run loop with no attached
// input source, so `runUntilDate:` returns immediately and the loop spins a
// full core. `keepRunning` only flips false when the user clicks/dismisses, so
// every un-actioned interactive notification leaks one spinning thread forever
// (measured: 8 leaked threads ≈ 673% CPU). See
// `workspace/reports/hq-sync-cpu-spin-debug.md`.
//
// Mitigation (CPU fix, Option 1): cap *blocking* sends to at most one at a
// time, shared across BOTH the share and DM notification surfaces. The first
// caller to acquire the slot sends with `wait_for_click(true)` (interactive);
// any concurrent caller falls back to a fire-and-forget `.send()` (no spin).
// This bounds the busy-spin at ~1 core instead of growing without limit, and
// preserves interactivity for the in-flight notification. The proper long-term
// fix (drop blocking sends entirely / move to a non-spinning action surface) is
// tracked separately.
static BLOCKING_NOTIFY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// RAII guard for the single "blocking notification send" slot, shared process-
/// wide across `share_notify` and `dm_notify`. Acquire with
/// [`BlockingNotifyGuard::try_acquire`]; the slot is released on `Drop`.
pub struct BlockingNotifyGuard;

impl BlockingNotifyGuard {
    /// Try to claim the single blocking-send slot. Returns `Some(guard)` if the
    /// slot was free (now claimed); `None` if another blocking send is already
    /// in flight — the caller should then fire-and-forget instead.
    pub fn try_acquire() -> Option<Self> {
        BLOCKING_NOTIFY_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then_some(BlockingNotifyGuard)
    }
}

impl Drop for BlockingNotifyGuard {
    fn drop(&mut self) {
        BLOCKING_NOTIFY_IN_FLIGHT.store(false, Ordering::Release);
    }
}

// ── Notification action wiring ────────────────────────────────────────────────

/// Tauri event channel name for `NotificationShareActionEvent`.
pub const EVENT_NOTIFICATION_SHARE_ACTION: &str = "notification:share-action";

/// Action dispatched by the frontend listener when the user interacts with a
/// share-notification banner. `event_id` lets the frontend look up the full
/// share event from its in-memory pending list (primed by `share:new-events`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationShareActionEvent {
    /// One of: `"copy"`, `"open"`. Any other action is filtered out before emit.
    pub action: String,
    /// Event ID of the share this notification represents — lets the
    /// frontend route to the right SHARE_EVENT row when multiple
    /// notifications are stacked.
    pub event_id: String,
    /// Full event payload embedded for offline-from-server convenience —
    /// the frontend can render Copy prompt without round-tripping
    /// `/v1/files/shared-with-me` again.
    pub event: ShareEvent,
}

// ── Event name emitted to the Svelte renderer ────────────────────────────────

/// Tauri event emitted when new share events are found. US-005 listens for
/// this to fire macOS notifications and open the ShareDetail window.
pub const EVENT_SHARE_NEW_EVENTS: &str = "share:new-events";

// ── Singleton in-flight guard ─────────────────────────────────────────────────

pub const LOG_TAG: &str = "share-notify";

static POLL_IN_FLIGHT: OnceLock<Mutex<bool>> = OnceLock::new();

pub fn poll_lock() -> &'static Mutex<bool> {
    POLL_IN_FLIGHT.get_or_init(|| Mutex::new(false))
}

/// Atomically mark a poll as in-flight. Returns `true` if we successfully
/// took the lock (caller must `clear_in_flight()` when done), `false` if
/// another poll is already running.
pub fn try_set_in_flight() -> bool {
    let mut guard = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
    if *guard {
        return false;
    }
    *guard = true;
    true
    // guard dropped here — not held across any await point
}

pub fn clear_in_flight() {
    let mut guard = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
    *guard = false;
}

// ── Wire-format types ─────────────────────────────────────────────────────────

/// A single share event as returned by `GET /v1/files/shared-with-me`.
/// Fields mirror the US-003 response schema; `note` is omitted when absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareEvent {
    pub event_id: String,
    pub issuer_email: String,
    pub issuer_display_name: String,
    /// The issuer's canonical person uid (hq-pro US-026). Empty string for
    /// legacy rows the server can't attribute — `serde(default)` keeps older
    /// backend payloads (and cached cursor fixtures) parsing.
    #[serde(default)]
    pub issuer_person_uid: String,
    pub paths: Vec<String>,
    pub note: Option<String>,
    pub permission: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWithMeResponse {
    pub events: Vec<ShareEvent>,
    #[allow(dead_code)]
    pub next_cursor: Option<String>,
}

/// Tauri event emitted to the share-detail window once its listener is ready
/// (ready-handshake; mirrors "new-files:list" in new_files.rs).
pub const EVENT_SHARE_EVENTS_LIST: &str = "share:events-list";

/// Managed state: pending share events for the detail window ready-handshake.
/// Follows the `PendingNewFiles` pattern in new_files.rs exactly.
pub struct PendingShareEvents(pub Mutex<Vec<ShareEvent>>);

// ── Cursor persistence ────────────────────────────────────────────────────────

/// Upper bound on the per-machine `notified` ring. The repeated boundary events
/// (the cause of the re-notify bug) are always the newest, so they never reach
/// the eviction end of the FIFO — 200 is comfortably more than any single
/// `?since=` page (`limit=50`).
pub const NOTIFIED_CAP: usize = 200;

/// Per-machine cursor state.
///
/// `cursor` is the ISO8601 `createdAt` of the newest event seen so far (the
/// `?since=` value). `notified` is a bounded FIFO of recently-notified
/// `eventId`s: the `shared-with-me` endpoint treats `?since=` as **inclusive**,
/// so the boundary event(s) are returned on every subsequent poll. Without an
/// id-level guard that re-delivers the same banner on every poll/launch (the
/// 2026-05-29 "same 8 events, cursor stuck" symptom). Deduping by id makes
/// re-notification impossible regardless of the server's `since` semantics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub notified: Vec<String>,
}

/// Back-compat shim: pre-0.4.4 stored a bare ISO string per machine. Accept both
/// the new object form and the legacy string form on read so an upgrade doesn't
/// re-notify every historical share once.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum CursorEntryCompat {
    Entry(CursorEntry),
    Legacy(String),
}

impl From<CursorEntryCompat> for CursorEntry {
    fn from(c: CursorEntryCompat) -> Self {
        match c {
            CursorEntryCompat::Entry(e) => e,
            CursorEntryCompat::Legacy(s) => CursorEntry {
                cursor: Some(s),
                notified: Vec::new(),
            },
        }
    }
}

pub type CursorStore = HashMap<String, CursorEntry>;

pub fn cursor_path() -> Result<std::path::PathBuf, String> {
    paths::hq_config_dir().map(|d| d.join("share-notify-cursor.json"))
}

/// Read the whole store, normalising any legacy bare-string entries to the
/// current object shape.
pub fn read_cursor_store() -> CursorStore {
    let Ok(path) = cursor_path() else {
        return CursorStore::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return CursorStore::default();
    };
    match serde_json::from_str::<HashMap<String, CursorEntryCompat>>(&contents) {
        Ok(store) => store.into_iter().map(|(k, v)| (k, v.into())).collect(),
        Err(_) => CursorStore::default(),
    }
}

pub fn read_cursor_entry(machine_id: &str) -> CursorEntry {
    read_cursor_store().remove(machine_id).unwrap_or_default()
}

pub fn write_cursor_entry(machine_id: &str, entry: &CursorEntry) {
    let Ok(path) = cursor_path() else { return };
    // Re-read (with normalisation) so we never clobber other machines' entries.
    let mut store = read_cursor_store();
    store.insert(machine_id.to_string(), entry.clone());
    if let Ok(json) = serde_json::to_string_pretty(&store) {
        let _ = std::fs::write(&path, json);
    }
}

/// Split a poll's events into the subset to notify (dropping any whose `eventId`
/// is already in `notified`, preserving order) and the updated `notified` ring
/// (bounded to [`NOTIFIED_CAP`], newest at the end). Pure so it is unit-testable
/// without the filesystem or network.
pub fn partition_unnotified(
    events: &[ShareEvent],
    notified: &[String],
) -> (Vec<ShareEvent>, Vec<String>) {
    let seen: std::collections::HashSet<&str> = notified.iter().map(String::as_str).collect();
    let fresh: Vec<ShareEvent> = events
        .iter()
        .filter(|e| !seen.contains(e.event_id.as_str()))
        .cloned()
        .collect();

    let mut updated = notified.to_vec();
    updated.extend(fresh.iter().map(|e| e.event_id.clone()));
    if updated.len() > NOTIFIED_CAP {
        updated.drain(0..updated.len() - NOTIFIED_CAP);
    }
    (fresh, updated)
}

// ── Gate check ───────────────────────────────────────────────────────────────

/// Pure gating decision for the share-notify poller. Notifications are ON unless
/// the user explicitly turned the `shareNotifications` pref off. A missing pref
/// (`None`) or unreadable settings default to ON.
pub fn share_notifications_enabled(share_notifications: Option<bool>) -> bool {
    share_notifications.unwrap_or(true)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Interval between independent share-notify polls once the launch poll has
/// run. Delivery MUST NOT depend on `sync:all-complete` firing — see the
/// 2026-05-28 incident (`workspace/reports/hq-sync-notifications-debug.md`):
/// the sync daemon was down ~34h, so the poller never ran and 7 incoming
/// shares sat unacked, then drained in a single cursor jump (≤1 banner for 7
/// events). The post-sync poll in `main.rs` is now a latency optimization on
/// top of this timer, not the sole delivery mechanism.
pub const SHARE_POLL_INTERVAL_SECS: u64 = 60;

// ── Notification content helpers ──────────────────────────────────────────────

/// Build the macOS notification title for a share event.
/// Format: "<issuerDisplayName> shared files with you"
pub fn notification_title(issuer_display_name: &str) -> String {
    format!("{} shared files with you", issuer_display_name)
}

/// Human-facing title for a single shared path.
///
/// Directory shares arrive as a wildcard path like `projects/foo/*` (or `/**`
/// for a recursive share). Naively taking the last segment surfaces the literal
/// `*`, which is meaningless. Strip the wildcard suffix and name the directory
/// with a trailing slash (`foo/`) so a folder share reads as a folder; plain
/// file shares keep their filename. Mirrors `shareTitle` in
/// `src/lib/share-path.ts`.
pub fn share_path_title(path: &str) -> String {
    let is_wildcard_dir =
        path.ends_with("/*") || path.ends_with("/**") || path == "*" || path == "**";
    let cleaned = path
        .trim_end_matches("/**")
        .trim_end_matches("/*")
        .trim_end_matches("**")
        .trim_end_matches('*');
    let last = cleaned.split('/').filter(|s| !s.is_empty()).next_back();
    match last {
        None => "All files".to_string(),
        Some(name) if is_wildcard_dir => format!("{}/", name),
        Some(name) => name.to_string(),
    }
}

/// Build the macOS notification body for a share event.
///
/// - If a non-empty note is present: return the note, truncated to 100
///   *Unicode scalar values* (characters, not bytes) with a "…" suffix when
///   truncated. Using character count avoids a panic on multi-byte sequences.
/// - Otherwise: return the comma-joined titles of the shared paths.
pub fn notification_body(note: Option<&str>, paths: &[String]) -> String {
    const CHAR_LIMIT: usize = 100;
    match note {
        Some(n) if !n.is_empty() => {
            let char_count = n.chars().count();
            if char_count > CHAR_LIMIT {
                // Find the byte offset of the CHAR_LIMIT-th character boundary.
                let cut = n
                    .char_indices()
                    .nth(CHAR_LIMIT)
                    .map(|(i, _)| i)
                    .unwrap_or(n.len());
                format!("{}…", &n[..cut])
            } else {
                n.to_string()
            }
        }
        _ => {
            let titles: Vec<String> = paths.iter().map(|p| share_path_title(p)).collect();
            titles.join(", ")
        }
    }
}

// ── ShareDetail window ─────────────────────────────────────────────────────────

pub const SHARE_DETAIL_LABEL: &str = "share-detail";

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // `POLL_IN_FLIGHT` is a process-global singleton, but cargo runs the tests
    // in this binary on parallel threads within ONE process. Any test that
    // mutates the flag (e.g. `test_try_set_and_clear_in_flight`, which flips it
    // to `true` mid-body) would otherwise race a test that reads it
    // (`test_singleton_lock_starts_false`, which asserts `false`). This guard
    // serializes the singleton-touching tests so they never interleave — held
    // for the whole test body. ANY new test that touches `poll_lock()` /
    // `try_set_in_flight()` / `clear_in_flight()` MUST take this guard first.
    static POLL_LOCK_TEST_SERIAL: Mutex<()> = Mutex::new(());

    /// Acquire the serial guard, ignoring poisoning from a panicking sibling
    /// test (a poisoned guard must not cascade-fail every other test).
    fn poll_lock_test_guard() -> std::sync::MutexGuard<'static, ()> {
        POLL_LOCK_TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn test_singleton_lock_starts_false() {
        // Serialized against the mutating test below; the only other toucher
        // (`test_try_set_and_clear_in_flight`) always ends by clearing the flag,
        // so in either ordering the flag is `false` when we observe it here.
        let _serial = poll_lock_test_guard();
        // The OnceLock starts unset; initialised to false on first access.
        let guard = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
        assert!(!*guard);
    }

    #[test]
    fn test_try_set_and_clear_in_flight() {
        let _serial = poll_lock_test_guard();
        // Force the lock to false first (may already be set from another test
        // calling try_set_in_flight).
        {
            let mut g = poll_lock().lock().unwrap_or_else(|p| p.into_inner());
            *g = false;
        }
        assert!(try_set_in_flight(), "first attempt should succeed");
        assert!(
            !try_set_in_flight(),
            "second attempt while in-flight should fail"
        );
        clear_in_flight();
        assert!(try_set_in_flight(), "after clear, should succeed again");
        clear_in_flight();
    }

    #[test]
    fn test_cursor_store_serde_roundtrip() {
        let mut store = CursorStore::default();
        store.insert(
            "machine-abc".to_string(),
            CursorEntry {
                cursor: Some("2026-05-25T12:00:00.000Z".to_string()),
                notified: vec!["e1".to_string(), "e2".to_string()],
            },
        );
        let json = serde_json::to_string(&store).unwrap();
        let parsed: HashMap<String, CursorEntryCompat> = serde_json::from_str(&json).unwrap();
        let entry: CursorEntry = parsed.into_iter().next().unwrap().1.into();
        assert_eq!(entry.cursor.as_deref(), Some("2026-05-25T12:00:00.000Z"));
        assert_eq!(entry.notified, vec!["e1", "e2"]);
    }

    #[test]
    fn test_cursor_store_reads_legacy_bare_string() {
        // Pre-0.4.4 format: bare ISO string per machine. Must upgrade cleanly to
        // the object form without losing the cursor or re-notifying history.
        let legacy = r#"{"machine-abc":"2026-05-25T12:00:00.000Z"}"#;
        let parsed: HashMap<String, CursorEntryCompat> = serde_json::from_str(legacy).unwrap();
        let entry: CursorEntry = parsed.into_iter().next().unwrap().1.into();
        assert_eq!(entry.cursor.as_deref(), Some("2026-05-25T12:00:00.000Z"));
        assert!(entry.notified.is_empty());
    }

    fn share_event(id: &str, created_at: &str) -> ShareEvent {
        let json = format!(
            r#"{{"eventId":"{id}","issuerEmail":"a@b.com","issuerDisplayName":"A",
                "paths":["/x.md"],"permission":"read","createdAt":"{created_at}"}}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn test_share_event_issuer_person_uid_defaults_empty() {
        // Legacy server rows (and cached payloads) omit `issuerPersonUid` —
        // parsing must default it to "" rather than fail (hq-pro US-026).
        let legacy = share_event("e1", "2026-05-29T03:19:02.349Z");
        assert_eq!(legacy.issuer_person_uid, "");

        let modern: ShareEvent = serde_json::from_str(
            r#"{"eventId":"e2","issuerEmail":"a@b.com","issuerDisplayName":"A",
                "issuerPersonUid":"prs_a","paths":["/x.md"],"permission":"read",
                "createdAt":"2026-05-29T03:19:02.349Z"}"#,
        )
        .unwrap();
        assert_eq!(modern.issuer_person_uid, "prs_a");
        // And it round-trips on serialize (camelCase key).
        let out = serde_json::to_value(&modern).unwrap();
        assert_eq!(out["issuerPersonUid"], "prs_a");
    }

    #[test]
    fn test_partition_unnotified_drops_already_seen() {
        // The stuck-cursor symptom: the same events come back every poll. Once an
        // id is in `notified`, it must never be returned for notification again.
        let events = vec![
            share_event("e1", "2026-05-29T03:19:02.349Z"),
            share_event("e2", "2026-05-29T03:19:02.349Z"),
        ];
        let notified = vec!["e1".to_string(), "e2".to_string()];
        let (fresh, updated) = partition_unnotified(&events, &notified);
        assert!(fresh.is_empty(), "already-notified events must not re-fire");
        assert_eq!(updated, vec!["e1", "e2"]);
    }

    #[test]
    fn test_partition_unnotified_returns_only_new() {
        let events = vec![
            share_event("e1", "2026-05-29T00:00:00.000Z"), // already seen
            share_event("e3", "2026-05-30T00:00:00.000Z"), // new
        ];
        let notified = vec!["e1".to_string()];
        let (fresh, updated) = partition_unnotified(&events, &notified);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].event_id, "e3");
        assert_eq!(updated, vec!["e1", "e3"]);
    }

    #[test]
    fn test_partition_unnotified_caps_ring_keeping_newest() {
        let notified: Vec<String> = (0..NOTIFIED_CAP).map(|i| format!("old{i}")).collect();
        let events = vec![share_event("brand-new", "2026-06-01T00:00:00.000Z")];
        let (fresh, updated) = partition_unnotified(&events, &notified);
        assert_eq!(fresh.len(), 1);
        assert_eq!(updated.len(), NOTIFIED_CAP);
        assert_eq!(updated.last().unwrap(), "brand-new");
        assert_eq!(updated.first().unwrap(), "old1"); // old0 evicted
    }

    #[test]
    fn test_share_event_deserializes_without_note() {
        let json = r#"{
            "eventId": "e1",
            "issuerEmail": "a@b.com",
            "issuerDisplayName": "Alice",
            "paths": ["/Foo/bar.md"],
            "permission": "read",
            "createdAt": "2026-05-25T00:00:00.000Z"
        }"#;
        let evt: ShareEvent = serde_json::from_str(json).unwrap();
        assert_eq!(evt.event_id, "e1");
        assert_eq!(evt.paths.len(), 1);
        assert!(evt.note.is_none());
    }

    #[test]
    fn test_share_event_deserializes_with_note() {
        let json = r#"{
            "eventId": "e2",
            "issuerEmail": "s@getindigo.ai",
            "issuerDisplayName": "Stefan",
            "paths": ["/Shared/doc.md", "/Shared/img.png"],
            "note": "Please review before Friday",
            "permission": "read",
            "createdAt": "2026-05-25T10:00:00.000Z"
        }"#;
        let evt: ShareEvent = serde_json::from_str(json).unwrap();
        assert_eq!(evt.note.as_deref(), Some("Please review before Friday"));
        assert_eq!(evt.paths.len(), 2);
    }

    #[test]
    fn test_write_and_read_cursor() {
        // Uses a temp directory to avoid polluting ~/.hq
        let tmp = tempfile::tempdir().unwrap();
        let cursor_file = tmp.path().join("share-notify-cursor.json");

        // Manually exercise the cursor store logic (not through the real path
        // functions, which are hardcoded to ~/.hq).
        let machine_id = "test-machine-001";
        let ts = "2026-05-25T12:34:56.789Z";

        let mut store = CursorStore::default();
        store.insert(
            machine_id.to_string(),
            CursorEntry {
                cursor: Some(ts.to_string()),
                notified: vec!["e1".to_string()],
            },
        );
        let json = serde_json::to_string_pretty(&store).unwrap();
        std::fs::write(&cursor_file, &json).unwrap();

        let loaded: HashMap<String, CursorEntryCompat> =
            serde_json::from_str(&std::fs::read_to_string(&cursor_file).unwrap()).unwrap();
        let entry: CursorEntry = loaded.into_iter().next().unwrap().1.into();
        assert_eq!(entry.cursor.as_deref(), Some(ts));
        assert_eq!(entry.notified, vec!["e1"]);
    }

    #[test]
    fn test_cursor_path_under_dot_hq() {
        let path = cursor_path().unwrap();
        assert!(
            path.ends_with(".hq/share-notify-cursor.json"),
            "cursor path must live under ~/.hq, got {path:?}"
        );
    }

    // ── notification_body tests ───────────────────────────────────────────────

    #[test]
    fn test_notification_body_short_note_returned_as_is() {
        let body = notification_body(Some("Please review the Q1 data"), &[]);
        assert_eq!(body, "Please review the Q1 data");
    }

    #[test]
    fn test_notification_body_long_note_truncated_at_100_chars_with_ellipsis() {
        // Build a 150-character ASCII note.
        let long_note: String = "a".repeat(150);
        let body = notification_body(Some(&long_note), &[]);
        // Truncated to 100 chars + "…" (the Unicode ellipsis character, 3 UTF-8 bytes)
        let expected = format!("{}…", "a".repeat(100));
        assert_eq!(body, expected);
        assert_eq!(body.chars().count(), 101); // 100 content chars + 1 ellipsis
    }

    #[test]
    fn test_notification_body_note_exactly_100_chars_not_truncated() {
        let note: String = "b".repeat(100);
        let body = notification_body(Some(&note), &[]);
        assert_eq!(body, note);
        assert!(!body.contains('…'));
    }

    #[test]
    fn test_notification_body_truncates_safely_at_char_boundary_for_multibyte() {
        // Each "😀" is 4 bytes but 1 character. A 150-char emoji string
        // would be 600 bytes — byte-index slicing at 100 would panic; char-aware
        // slicing should not.
        let emoji_note: String = "😀".repeat(150);
        let body = notification_body(Some(&emoji_note), &[]);
        assert!(body.ends_with('…'));
        assert_eq!(body.chars().count(), 101); // 100 emojis + ellipsis
    }

    #[test]
    fn test_notification_body_falls_back_to_comma_joined_basenames_when_no_note() {
        let paths = vec![
            "/vault/reports/q1.csv".to_string(),
            "/vault/data/summary.md".to_string(),
        ];
        let body = notification_body(None, &paths);
        assert_eq!(body, "q1.csv, summary.md");
    }

    #[test]
    fn test_notification_body_falls_back_to_basenames_when_note_is_empty_string() {
        let paths = vec!["reports/annual.pdf".to_string()];
        let body = notification_body(Some(""), &paths);
        assert_eq!(body, "annual.pdf");
    }

    #[test]
    fn test_notification_body_basename_with_no_slash() {
        let paths = vec!["standalone.md".to_string()];
        let body = notification_body(None, &paths);
        assert_eq!(body, "standalone.md");
    }

    #[test]
    fn test_notification_body_names_directory_for_wildcard_share() {
        // Regression: a wildcard directory share used to collapse to "*".
        let paths = vec!["projects/client-stats-redesign/*".to_string()];
        let body = notification_body(None, &paths);
        assert_eq!(body, "client-stats-redesign/");
    }

    #[test]
    fn test_share_path_title_variants() {
        assert_eq!(
            share_path_title("projects/client-stats-redesign/*"),
            "client-stats-redesign/"
        );
        assert_eq!(share_path_title("projects/foo/**"), "foo/");
        assert_eq!(share_path_title("docs/a.md"), "a.md");
        assert_eq!(share_path_title("standalone.md"), "standalone.md");
        assert_eq!(share_path_title("*"), "All files");
        assert_eq!(share_path_title("**"), "All files");
    }

    #[test]
    fn test_notification_title_format() {
        let title = notification_title("Stefan Johnson");
        assert_eq!(title, "Stefan Johnson shared files with you");
    }

    // ── should_poll gating (post indigo-gate removal, 2026-05-26) ─────────────

    #[test]
    fn test_share_notifications_enabled_defaults_on_when_pref_absent() {
        // Missing pref (None) → ON. A fresh install with no explicit toggle must
        // poll so recipients get notifications without opening Settings.
        assert!(share_notifications_enabled(None));
    }

    #[test]
    fn test_share_notifications_enabled_when_pref_true() {
        assert!(share_notifications_enabled(Some(true)));
    }

    #[test]
    fn test_share_notifications_disabled_only_when_pref_explicitly_false() {
        // The ONLY way the poller is gated off is an explicit opt-out. This is
        // the regression guard for dropping the `@getindigo.ai` gate: a
        // non-getindigo recipient (None / Some(true) pref) must still poll.
        assert!(!share_notifications_enabled(Some(false)));
    }

    // ── BlockingNotifyGuard cap-to-1 (CPU spin regression, 2026-05-28) ─────────
    //
    // Regression guard for the 673% CPU leak: `mac-notification-sys`
    // busy-spins one thread per outstanding `wait_for_click(true)` send. The
    // guard caps concurrent blocking sends to exactly one process-wide so the
    // spin can never accumulate. These tests assert the second concurrent
    // acquire is refused (→ caller fire-and-forgets) and that the slot frees on
    // drop. NOTE: this is the only test that touches BLOCKING_NOTIFY_IN_FLIGHT,
    // so the shared static can't be perturbed by sibling tests.

    //
    // Both invariants live in ONE test (not two) on purpose: cargo runs tests
    // in parallel threads within a process, and the guard's backing static is
    // process-wide — two separate tests racing on it would flake. A single
    // sequential test owns the slot for its whole body.
    #[test]
    fn test_blocking_guard_caps_concurrency_at_one() {
        let first = BlockingNotifyGuard::try_acquire();
        assert!(first.is_some(), "first acquire must claim the free slot");

        // Second acquire while the first is held → None. This is what forces
        // concurrent notification sends onto the fire-and-forget path instead
        // of leaking another spinning thread.
        assert!(
            BlockingNotifyGuard::try_acquire().is_none(),
            "second concurrent acquire must be refused while a send is in flight"
        );

        // Dropping the guard frees the slot (releases the in-flight flag).
        drop(first);
        assert!(
            !BLOCKING_NOTIFY_IN_FLIGHT.load(Ordering::Acquire),
            "the in-flight flag must be cleared once the guard drops"
        );

        // After the in-flight send returns (guard dropped), the slot is reusable.
        let third = BlockingNotifyGuard::try_acquire();
        assert!(
            third.is_some(),
            "slot must be reusable after the guard drops"
        );
        drop(third);
    }
}
