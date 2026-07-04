//! Notification history — a unified, re-readable timeline of everything the
//! menubar surfaced and the user may have dismissed.
//!
//! Two server-retained sources are fetched on demand (newest-first, full
//! history rather than the unseen-delta the live pollers request):
//!   - DMs:    `GET /v1/notify/inbox?limit=N`        (DmEvent)
//!   - Shares: `GET /v1/files/shared-with-me?limit=N` (ShareEvent)
//!
//! New-file notifications are intentionally NOT fetched here: the runner emits
//! them per-sync and nothing persists them server-side, so true cross-session
//! history would need a new backend endpoint. The window includes the current
//! session's new-file rows client-side via the existing `get_activity_log`
//! command (entries with `is_new = true`), clearly scoped as session-only.
//!
//! Resilience: each source is fetched independently. A single source failing
//! degrades to its empty list (logged) so the other still renders; only a hard
//! auth/URL failure (can't even build the request) surfaces as an error.
//!
//! Windows parity: legacy Windows recorded the local notifications it emitted
//! into a capped, atomic JSON store. The unified app keeps the server-backed
//! fetch on macOS/Linux and uses the local store on Windows so notification
//! history remains readable offline and includes new-file toasts that have no
//! durable server source there.

#[cfg(any(target_os = "windows", test))]
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(any(target_os = "windows", test))]
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::cognito;
use crate::commands::dm_notify::DmEvent;
use crate::commands::share_notify::ShareEvent;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "notif-history";

/// Default + maximum number of items fetched per source. The server returns
/// newest-first, so this is the most-recent N; pagination is a future add.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 200;

#[cfg(any(target_os = "windows", test))]
const STORE_VERSION: u32 = 1;
#[cfg(target_os = "windows")]
const LOCAL_MAX_ENTRIES: usize = 500;

#[cfg(any(target_os = "windows", test))]
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxResponse {
    events: Vec<DmEvent>,
    #[allow(dead_code)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedWithMeResponse {
    events: Vec<ShareEvent>,
    #[allow(dead_code)]
    next_cursor: Option<String>,
}

/// One new-file event from the server-retained file-history feed
/// (GET /v1/notify/file-history) — populated by the sync runner's report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryItem {
    pub event_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_slug: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHistoryResponse {
    files: Vec<FileHistoryItem>,
    #[allow(dead_code)]
    next_cursor: Option<String>,
}

/// The server-retained notification sources, returned to the history window.
/// `files` is the cross-session new-file history; the window also merges the
/// current session's new files (from `get_activity_log`) and de-dupes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationHistory {
    pub dms: Vec<DmEvent>,
    pub shares: Vec<ShareEvent>,
    pub files: Vec<FileHistoryItem>,
}

/// Legacy standalone-window IPC. The unified app retired that window in favor
/// of the popover's inline NotificationFeed, so the compatibility path focuses
/// the main surface where the feed is already mounted.
#[tauri::command]
pub async fn open_notification_history(app: AppHandle) -> Result<(), String> {
    crate::tray::show_window_at_tray(&app);
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum HistoryKind {
    Dm,
    Share,
    NewFile,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    kind: HistoryKind,
    actor: String,
    summary: String,
    ts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dm: Option<DmEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    share: Option<ShareEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file: Option<FileHistoryItem>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryStore {
    version: u32,
    entries: Vec<HistoryEntry>,
}

#[cfg(any(target_os = "windows", test))]
impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            entries: Vec::new(),
        }
    }
}

#[cfg(target_os = "windows")]
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(any(target_os = "windows", test))]
fn iso_from_millis(ts: u64) -> String {
    let millis = ts.min(i64::MAX as u64) as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(target_os = "windows")]
fn local_store_path() -> Result<PathBuf, String> {
    crate::util::paths::hq_config_dir().map(|d| d.join("notification-history.json"))
}

#[cfg(any(target_os = "windows", test))]
fn read_local_store_from_path(path: &Path) -> HistoryStore {
    match std::fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str::<HistoryStore>(&contents) {
            Ok(store) if store.version == STORE_VERSION => store,
            Ok(_) => {
                log(LOG_TAG, "HISTORY_READ_VERSION_MISMATCH");
                HistoryStore::default()
            }
            Err(e) => {
                log(LOG_TAG, &format!("HISTORY_READ_PARSE_FAIL {e}"));
                HistoryStore::default()
            }
        },
        Err(_) => HistoryStore::default(),
    }
}

#[cfg(target_os = "windows")]
fn read_local_store() -> HistoryStore {
    match local_store_path() {
        Ok(path) => read_local_store_from_path(&path),
        Err(e) => {
            log(LOG_TAG, &format!("HISTORY_PATH_FAIL {e}"));
            HistoryStore::default()
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn replace_file_atomic(tmp: &Path, path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let tmp_w: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let path_w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe {
            MoveFileExW(
                tmp_w.as_ptr(),
                path_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(tmp, path)
    }
}

#[cfg(any(target_os = "windows", test))]
fn write_local_store_to_path(path: &Path, store: &HistoryStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }

    let json = serde_json::to_vec_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    match replace_file_atomic(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(format!("replace: {e}"))
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn upsert_entries(store: &mut HistoryStore, incoming: Vec<HistoryEntry>, cap: usize) {
    store.version = STORE_VERSION;
    for entry in incoming {
        if let Some(existing) = store.entries.iter_mut().find(|e| e.id == entry.id) {
            *existing = entry;
        } else {
            store.entries.push(entry);
        }
    }
    store.entries.sort_by_key(|e| e.ts);
    if cap == 0 {
        store.entries.clear();
    } else if store.entries.len() > cap {
        store.entries.drain(0..store.entries.len() - cap);
    }
}

#[cfg(any(target_os = "windows", test))]
fn append_entries_to_path(
    path: &Path,
    entries: Vec<HistoryEntry>,
    cap: usize,
) -> Result<usize, String> {
    let mut store = read_local_store_from_path(path);
    upsert_entries(&mut store, entries, cap);
    let len = store.entries.len();
    write_local_store_to_path(path, &store)?;
    Ok(len)
}

#[cfg(target_os = "windows")]
fn record_local_entries(entries: Vec<HistoryEntry>) {
    if entries.is_empty() {
        return;
    }

    let Ok(path) = local_store_path() else {
        return;
    };
    let added = entries.len();
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match append_entries_to_path(&path, entries, LOCAL_MAX_ENTRIES) {
        Ok(total) => log(
            LOG_TAG,
            &format!("HISTORY_RECORD added={added} total={total}"),
        ),
        Err(e) => log(LOG_TAG, &format!("HISTORY_RECORD_FAIL {e}")),
    }
}

#[cfg(target_os = "windows")]
fn dm_summary(e: &DmEvent) -> String {
    let body = e.body.trim();
    if body.is_empty() {
        "Sent you a message".to_string()
    } else {
        body.to_string()
    }
}

#[cfg(target_os = "windows")]
fn share_summary(e: &ShareEvent) -> String {
    let n = e.paths.len();
    let files = e.paths.join(", ");
    let base = if n == 1 {
        format!("Shared a file: {files}")
    } else {
        format!("Shared {n} files: {files}")
    };
    match e.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(note) => format!("{base} - \"{note}\""),
        None => base,
    }
}

#[cfg(target_os = "windows")]
fn dm_entry(e: &DmEvent) -> HistoryEntry {
    let name = e.from_display_name.trim();
    let email = e.from_email.trim();
    let actor = if !name.is_empty() {
        name
    } else if !email.is_empty() {
        email
    } else {
        "Someone"
    }
    .to_string();
    HistoryEntry {
        id: format!("dm:{}", e.event_id),
        kind: HistoryKind::Dm,
        actor,
        summary: dm_summary(e),
        ts: now_millis(),
        dm: Some(e.clone()),
        share: None,
        file: None,
    }
}

#[cfg(target_os = "windows")]
fn share_entry(e: &ShareEvent) -> HistoryEntry {
    let name = e.issuer_display_name.trim();
    let email = e.issuer_email.trim();
    let actor = if !name.is_empty() {
        name
    } else if !email.is_empty() {
        email
    } else {
        "Someone"
    }
    .to_string();
    HistoryEntry {
        id: format!("share:{}", e.event_id),
        kind: HistoryKind::Share,
        actor,
        summary: share_summary(e),
        ts: now_millis(),
        dm: None,
        share: Some(e.clone()),
        file: None,
    }
}

#[cfg(target_os = "windows")]
fn new_file_entry(company: &str, file: &crate::events::SyncNewFileEntry) -> HistoryEntry {
    let ts = now_millis();
    let event_id = format!("newfile:{company}/{}", file.path);
    let actor = file
        .added_by
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(company)
        .to_string();
    let file_item = FileHistoryItem {
        event_id: event_id.clone(),
        path: file.path.clone(),
        bytes: Some(file.bytes),
        added_by: file.added_by.clone(),
        company_uid: None,
        company_slug: Some(company.to_string()),
        created_at: iso_from_millis(ts),
    };
    HistoryEntry {
        id: event_id,
        kind: HistoryKind::NewFile,
        actor,
        summary: format!("New file in {company}: {}", file.path),
        ts,
        dm: None,
        share: None,
        file: Some(file_item),
    }
}

#[cfg(target_os = "windows")]
fn fetch_local_notification_history(limit: usize) -> NotificationHistory {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_local_store().entries;
    entries.sort_by_key(|e| std::cmp::Reverse(e.ts));
    entries.truncate(limit);

    let mut dms = Vec::new();
    let mut shares = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        match entry.kind {
            HistoryKind::Dm => {
                if let Some(dm) = entry.dm {
                    dms.push(dm);
                }
            }
            HistoryKind::Share => {
                if let Some(share) = entry.share {
                    shares.push(share);
                }
            }
            HistoryKind::NewFile => {
                if let Some(file) = entry.file {
                    files.push(file);
                }
            }
        }
    }

    log(
        LOG_TAG,
        &format!(
            "HISTORY_FETCH_LOCAL dms={} shares={} files={}",
            dms.len(),
            shares.len(),
            files.len()
        ),
    );
    NotificationHistory { dms, shares, files }
}

#[cfg(target_os = "windows")]
pub fn record_dm_events(events: &[DmEvent]) {
    record_local_entries(events.iter().map(dm_entry).collect());
}

#[cfg(not(target_os = "windows"))]
pub fn record_dm_events(_events: &[DmEvent]) {}

#[cfg(target_os = "windows")]
pub fn record_share_events(events: &[ShareEvent]) {
    record_local_entries(events.iter().map(share_entry).collect());
}

#[cfg(not(target_os = "windows"))]
pub fn record_share_events(_events: &[ShareEvent]) {}

#[cfg(target_os = "windows")]
pub fn record_new_files(company: &str, files: &[crate::events::SyncNewFileEntry]) {
    record_local_entries(
        files
            .iter()
            .map(|file| new_file_entry(company, file))
            .collect(),
    );
}

#[cfg(not(target_os = "windows"))]
pub fn record_new_files(_company: &str, _files: &[crate::events::SyncNewFileEntry]) {}

async fn fetch_dms(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    limit: u32,
) -> Result<Vec<DmEvent>, String> {
    let url = format!("{}/v1/notify/inbox?limit={}", base_url, limit);
    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status {}", status.as_u16()));
    }
    let parsed = resp
        .json::<InboxResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))?;
    Ok(parsed.events)
}

async fn fetch_shares(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    limit: u32,
) -> Result<Vec<ShareEvent>, String> {
    let url = format!("{}/v1/files/shared-with-me?limit={}", base_url, limit);
    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status {}", status.as_u16()));
    }
    let parsed = resp
        .json::<SharedWithMeResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))?;
    Ok(parsed.events)
}

async fn fetch_files(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    limit: u32,
) -> Result<Vec<FileHistoryItem>, String> {
    let url = format!("{}/v1/notify/file-history?limit={}", base_url, limit);
    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status {}", status.as_u16()));
    }
    let parsed = resp
        .json::<FileHistoryResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))?;
    Ok(parsed.files)
}

/// Fetch the full (newest-N) DM + share + new-file history for the history window.
#[tauri::command]
pub async fn fetch_notification_history(limit: Option<u32>) -> Result<NotificationHistory, String> {
    let lim = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    #[cfg(target_os = "windows")]
    {
        return Ok(fetch_local_notification_history(lim as usize));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let access_token = cognito::get_valid_access_token().await.map_err(|e| {
            log(LOG_TAG, &format!("NOTIF_HISTORY_AUTH_FAIL {e}"));
            format!("Not signed in: {e}")
        })?;
        let base_url = resolve_vault_api_url()
            .map(|u| u.trim_end_matches('/').to_string())
            .map_err(|e| {
                log(LOG_TAG, &format!("NOTIF_HISTORY_URL_FAIL {e}"));
                format!("Could not resolve server URL: {e}")
            })?;

        let client = build_client();

        let dms_res = fetch_dms(&client, &base_url, &access_token, lim).await;
        let shares_res = fetch_shares(&client, &base_url, &access_token, lim).await;
        // File-history is the newest endpoint; treat its failure as non-fatal so an
        // older backend (or a transient miss) still renders DMs + shares.
        let files = match fetch_files(&client, &base_url, &access_token, lim).await {
            Ok(v) => v,
            Err(e) => {
                log(LOG_TAG, &format!("NOTIF_HISTORY_FILES_FAIL {e}"));
                Vec::new()
            }
        };

        // Capture each source's error (if any) while consuming the Result, so a
        // both-failed check below doesn't need to re-borrow the moved values.
        let mut dm_err: Option<String> = None;
        let dms = match dms_res {
            Ok(v) => v,
            Err(e) => {
                log(LOG_TAG, &format!("NOTIF_HISTORY_DM_FAIL {e}"));
                dm_err = Some(e);
                Vec::new()
            }
        };
        let mut share_err: Option<String> = None;
        let shares = match shares_res {
            Ok(v) => v,
            Err(e) => {
                log(LOG_TAG, &format!("NOTIF_HISTORY_SHARE_FAIL {e}"));
                share_err = Some(e);
                Vec::new()
            }
        };

        // Only fail hard if BOTH sources errored — a one-source outage still renders
        // the other half of the timeline.
        if let (Some(de), Some(se)) = (&dm_err, &share_err) {
            return Err(format!(
                "Could not load notifications (dm: {de}; share: {se})"
            ));
        }

        log(
            LOG_TAG,
            &format!(
                "NOTIF_HISTORY_OK dms={} shares={} files={}",
                dms.len(),
                shares.len(),
                files.len()
            ),
        );
        Ok(NotificationHistory { dms, shares, files })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, ts: u64) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            kind: HistoryKind::NewFile,
            actor: "indigo".to_string(),
            summary: format!("summary {id}"),
            ts,
            dm: None,
            share: None,
            file: Some(FileHistoryItem {
                event_id: id.to_string(),
                path: format!("{id}.md"),
                bytes: Some(1),
                added_by: None,
                company_uid: None,
                company_slug: Some("indigo".to_string()),
                created_at: iso_from_millis(ts),
            }),
        }
    }

    #[test]
    fn capped_atomic_append_replaces_by_id_and_trims_oldest() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().join("notification-history.json");

        let total = append_entries_to_path(
            &path,
            vec![entry("old", 1), entry("keep", 2), entry("replace", 3)],
            3,
        )
        .expect("initial append");
        assert_eq!(total, 3);

        let mut replacement = entry("replace", 4);
        replacement.summary = "updated".to_string();
        let total =
            append_entries_to_path(&path, vec![entry("new", 5), replacement], 3).expect("append");
        assert_eq!(total, 3);

        let store = read_local_store_from_path(&path);
        let ids: Vec<&str> = store.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["keep", "replace", "new"]);
        assert_eq!(store.entries[1].summary, "updated");
        assert_eq!(store.entries[1].ts, 4);
        assert_eq!(store.version, STORE_VERSION);

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }
}
