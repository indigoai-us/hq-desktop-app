//! Durable account-bound outbox for shared, final Meet transcript rows.
//! Local solo previews are explicitly excluded. Backend admission remains the
//! authority for whether a row belongs to an actual multi-person conversation.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::Mutex;
const MAX_ROWS: usize = 5000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub company_uid: String,
    pub person_uid: String,
    pub room_id: String,
    pub call_id: String,
    pub epoch: u64,
    pub conversation_id: String,
    pub stream_id: String,
    pub segment_id: String,
    pub revision: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Key {
    pub company_uid: String,
    pub person_uid: String,
    pub conversation_id: String,
    pub stream_id: String,
    pub segment_id: String,
    pub revision: u32,
}
impl Row {
    fn matches(&self, key: &Key) -> bool {
        self.company_uid == key.company_uid
            && self.person_uid == key.person_uid
            && self.conversation_id == key.conversation_id
            && self.stream_id == key.stream_id
            && self.segment_id == key.segment_id
            && self.revision == key.revision
    }
    fn key(&self) -> Key {
        Key {
            company_uid: self.company_uid.clone(),
            person_uid: self.person_uid.clone(),
            conversation_id: self.conversation_id.clone(),
            stream_id: self.stream_id.clone(),
            segment_id: self.segment_id.clone(),
            revision: self.revision,
        }
    }
    fn validate(&self) -> Result<(), String> {
        for id in [
            &self.company_uid,
            &self.person_uid,
            &self.room_id,
            &self.call_id,
            &self.conversation_id,
            &self.stream_id,
            &self.segment_id,
            &self.device_id,
        ] {
            if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_control()) {
                return Err("Invalid transcript identity".into());
            }
        }
        if self
            .upload_token
            .as_ref()
            .is_some_and(|t| t.is_empty() || t.len() > 16384)
            || self.upload_token.is_some() != self.expires_at.is_some()
        {
            return Err("Invalid upload authorization".into());
        }
        if self.text.trim().is_empty()
            || self.text.len() > 16384
            || self.end_ms < self.start_ms
            || self.end_ms > 9_007_199_254_740_991
            || self.epoch > 9_007_199_254_740_991
        {
            return Err("Invalid transcript content".into());
        }
        Ok(())
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    rows: Vec<Row>,
    #[serde(default)]
    receipts: Vec<SavedReceipt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRef {
    pub key: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub source_id: String,
    pub source_ref: SourceRef,
    pub revision: u64,
    pub updated_at: u64,
    pub saved: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReceipt {
    company_uid: String,
    person_uid: String,
    conversation_id: String,
    source_path: String,
    revision: u64,
    updated_at: u64,
}
fn acknowledge(path: &Path, keys: &[Key], receipt: Option<Receipt>) -> Result<(), String> {
    let mut store = load(path)?;
    if let Some(receipt) = receipt {
        if !receipt.saved
            || receipt.source_ref.key.len() > 1024
            || receipt.source_ref.key.contains("..")
            || receipt.source_id.len() > 256
        {
            return Err("Invalid saved transcript receipt".into());
        }
        for row in store
            .rows
            .iter()
            .filter(|row| keys.iter().any(|key| row.matches(key)))
        {
            let value = SavedReceipt {
                company_uid: row.company_uid.clone(),
                person_uid: row.person_uid.clone(),
                conversation_id: row.conversation_id.clone(),
                source_path: receipt.source_ref.key.clone(),
                revision: receipt.revision,
                updated_at: receipt.updated_at,
            };
            if let Some(old) = store.receipts.iter_mut().find(|r| {
                r.company_uid == value.company_uid
                    && r.person_uid == value.person_uid
                    && r.conversation_id == value.conversation_id
            }) {
                if value.revision >= old.revision {
                    *old = value;
                }
            } else {
                store.receipts.push(value);
            }
        }
        store.receipts.sort_by_key(|r| r.updated_at);
        if store.receipts.len() > 200 {
            store.receipts.drain(..store.receipts.len() - 200);
        }
    }
    store
        .rows
        .retain(|row| !keys.iter().any(|key| row.matches(key)));
    save(path, &store)
}
fn path_for(root: &Path, account: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(account.as_bytes())))
}
fn load(path: &Path) -> Result<Store, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(_) => return Err("Cannot read transcript outbox".into()),
    };
    if metadata.len() > MAX_BYTES as u64 {
        return Err("Transcript outbox exceeds size limit".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Cannot read transcript outbox")?;
    let store: Store = serde_json::from_slice(&bytes)
        .map_err(|_| "Transcript outbox is damaged; preserved for recovery")?;
    if store.rows.len() > MAX_ROWS {
        return Err("Transcript outbox exceeds row limit".into());
    }
    for row in &store.rows {
        row.validate()?;
    }
    Ok(store)
}
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                a.as_ptr(),
                b.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to)
    }
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn save(path: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|_| "Cannot encode transcript outbox")?;
    if store.rows.len() > MAX_ROWS || bytes.len() > MAX_BYTES {
        return Err("Transcript outbox is full; pending text was preserved".into());
    }
    let root = path.parent().ok_or("Invalid outbox path")?;
    std::fs::create_dir_all(root).map_err(|_| "Cannot create transcript outbox")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect transcript outbox")?;
    }
    let temp = Temp(root.join(format!(".{}.tmp", uuid::Uuid::new_v4())));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp.0)
        .map_err(|_| "Cannot write transcript outbox")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush transcript outbox")?;
    drop(file);
    replace(&temp.0, path).map_err(|_| "Cannot publish transcript outbox")?;
    #[cfg(unix)]
    {
        std::fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot flush transcript directory")?;
    }
    Ok(())
}
fn enqueue(path: &Path, row: Row, audience: &str) -> Result<(), String> {
    if audience != "room" {
        return Err("Solo transcript previews cannot enter the shared outbox".into());
    }
    row.validate()?;
    let mut store = load(path)?;
    if let Some(index) = store.rows.iter().position(|old| old.matches(&row.key())) {
        let mut comparable = row.clone();
        comparable.upload_token = store.rows[index].upload_token.clone();
        comparable.expires_at = store.rows[index].expires_at;
        if comparable != store.rows[index] {
            return Err("Transcript revision conflicts with queued content".into());
        }
        if row.upload_token.is_some() && row.expires_at >= store.rows[index].expires_at {
            store.rows[index].upload_token = row.upload_token;
            store.rows[index].expires_at = row.expires_at;
            return save(path, &store);
        }
        return Ok(());
    }
    store.rows.push(row);
    save(path, &store)
}
async fn authorized(window: &tauri::WebviewWindow, account_id: &str) -> Result<PathBuf, String> {
    if !matches!(window.label(), "call" | "desktop-alt") {
        return Err("Transcript outbox unavailable in this window".into());
    }
    let tokens = super::cognito::get_tokens()
        .await
        .map_err(|_| "Cannot resolve local account")?
        .ok_or("Not signed in")?;
    if account_id.is_empty()
        || super::auth::notification_identity_from_tokens(&tokens) != account_id
    {
        return Err("Transcript outbox account changed".into());
    }
    Ok(path_for(
        &dirs::data_dir()
            .ok_or("Cannot resolve application data")?
            .join("HQ/meet-transcript-outbox"),
        account_id,
    ))
}
#[tauri::command]
pub async fn meet_transcript_outbox_enqueue(
    window: tauri::WebviewWindow,
    account_id: String,
    row: Row,
    audience: String,
) -> Result<(), String> {
    let _guard = LOCK
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    let path = authorized(&window, &account_id).await?;
    tokio::task::spawn_blocking(move || {
        let _guard = _guard;
        enqueue(&path, row, &audience)
    })
    .await
    .map_err(|_| "Outbox worker failed")?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    rows: Vec<Row>,
    total_count: usize,
    has_more: bool,
    receipts: Vec<SavedReceipt>,
}
#[tauri::command]
pub async fn meet_transcript_outbox_read(
    window: tauri::WebviewWindow,
    account_id: String,
    offset: Option<usize>,
) -> Result<Batch, String> {
    let _guard = LOCK
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    let path = authorized(&window, &account_id).await?;
    let offset = offset.unwrap_or(0).min(MAX_ROWS);
    let rows = tokio::task::spawn_blocking(move || {
        let _guard = _guard;
        load(&path).map(|s| {
            let total_count = s.rows.len();
            Batch {
                rows: s.rows.into_iter().skip(offset).take(500).collect(),
                total_count,
                has_more: total_count > offset + 500,
                receipts: s.receipts,
            }
        })
    })
    .await
    .map_err(|_| "Outbox worker failed")??;
    authorized(&window, &account_id).await?;
    Ok(rows)
}
#[tauri::command]
pub async fn meet_transcript_outbox_ack(
    window: tauri::WebviewWindow,
    account_id: String,
    keys: Vec<Key>,
    receipt: Option<Receipt>,
) -> Result<(), String> {
    if keys.len() > 500 {
        return Err("Too many transcript acknowledgements".into());
    }
    let _guard = LOCK
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    let path = authorized(&window, &account_id).await?;
    tokio::task::spawn_blocking(move || {
        let _guard = _guard;
        acknowledge(&path, &keys, receipt)
    })
    .await
    .map_err(|_| "Outbox worker failed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn row() -> Row {
        Row {
            company_uid: "co1".into(),
            person_uid: "prs1".into(),
            room_id: "room1".into(),
            call_id: "call1".into(),
            epoch: 1,
            conversation_id: "conv1".into(),
            stream_id: "stream1".into(),
            segment_id: "seg1".into(),
            revision: 1,
            start_ms: 0,
            end_ms: 1000,
            text: "Hello".into(),
            device_id: "dev1".into(),
            upload_token: None,
            expires_at: None,
        }
    }
    #[test]
    fn survives_reload_idempotent_and_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "acct");
        enqueue(&p, row(), "room").unwrap();
        enqueue(&p, row(), "room").unwrap();
        assert_eq!(load(&p).unwrap().rows, vec![row()]);
        let mut other = row();
        other.text = "different".into();
        assert!(enqueue(&p, other, "room").is_err());
        assert_eq!(load(&p).unwrap().rows, vec![row()]);
    }
    #[test]
    fn capacity_rejection_preserves_previous_durable_rows() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        enqueue(&p, row(), "room").unwrap();
        assert!(save(
            &p,
            &Store {
                rows: vec![row(); MAX_ROWS + 1],
                receipts: Vec::new()
            }
        )
        .is_err());
        assert_eq!(load(&p).unwrap().rows, vec![row()]);
    }
    #[test]
    fn newer_revision_survives_older_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        enqueue(&p, row(), "room").unwrap();
        let mut newer = row();
        newer.revision = 2;
        newer.text = "Hello there".into();
        enqueue(&p, newer.clone(), "room").unwrap();
        let mut store = load(&p).unwrap();
        store.rows.retain(|r| !r.matches(&row().key()));
        save(&p, &store).unwrap();
        assert_eq!(load(&p).unwrap().rows, vec![newer]);
    }
    #[test]
    fn receipts_survive_row_ack_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        enqueue(&p, row(), "room").unwrap();
        acknowledge(
            &p,
            &[row().key()],
            Some(Receipt {
                source_id: "native-fixture".into(),
                source_ref: SourceRef {
                    key: "sources/meetings/native-fixture.md".into(),
                },
                revision: 3,
                updated_at: 1234,
                saved: true,
            }),
        )
        .unwrap();
        let store = load(&p).unwrap();
        assert!(store.rows.is_empty());
        assert_eq!(store.receipts.len(), 1);
        assert_eq!(store.receipts[0].conversation_id, "conv1");
        assert_eq!(store.receipts[0].revision, 3);
    }
    #[test]
    fn attaches_authority_without_downgrade_or_content_change() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        enqueue(&p, row(), "room").unwrap();
        let mut authorized = row();
        authorized.upload_token = Some("fixture-only".into());
        authorized.expires_at = Some(1234);
        enqueue(&p, authorized.clone(), "room").unwrap();
        enqueue(&p, row(), "room").unwrap();
        assert_eq!(load(&p).unwrap().rows, vec![authorized]);
    }
    #[test]
    fn isolates_accounts_and_ack_tenants() {
        let dir = tempfile::tempdir().unwrap();
        let a = path_for(dir.path(), "../../a");
        let b = path_for(dir.path(), "b");
        enqueue(&a, row(), "room").unwrap();
        assert!(load(&b).unwrap().rows.is_empty());
        assert_eq!(a.parent(), Some(dir.path()));
        let mut key = row().key();
        key.company_uid = "other".into();
        assert!(!row().matches(&key));
        key = row().key();
        key.revision = 2;
        assert!(!row().matches(&key));
    }
    #[test]
    fn rejects_solo_bounds_and_preserves_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        assert!(enqueue(&p, row(), "solo").is_err());
        let mut r = row();
        r.text = "a".repeat(16385);
        assert!(enqueue(&p, r, "room").is_err());
        std::fs::write(&p, b"broken").unwrap();
        assert!(enqueue(&p, row(), "room").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"broken");
    }
    #[test]
    fn interrupted_temp_does_not_replace_last_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path(), "a");
        enqueue(&p, row(), "room").unwrap();
        std::fs::write(dir.path().join(".interrupted.tmp"), b"partial").unwrap();
        assert_eq!(load(&p).unwrap().rows, vec![row()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
