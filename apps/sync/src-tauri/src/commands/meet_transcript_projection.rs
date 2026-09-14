//! Read-only local projection of participant-authorized native meeting sources.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    sync::{Arc, OnceLock},
};
use tokio::sync::Mutex;
static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
async fn require_account(account_id: &str) -> Result<(), String> {
    let tokens = super::cognito::get_tokens().await
        .map_err(|_| "Cannot resolve account")?.ok_or("Not signed in")?;
    if account_id.is_empty() || super::auth::notification_identity_from_tokens(&tokens) != account_id {
        return Err("Meeting projection account changed".into());
    }
    Ok(())
}

/// Authorization is evaluated after the queue wait, never cached ahead of it.
async fn lock_authorized<F, Fut>(lock: Arc<Mutex<()>>, authorize: F) -> Result<tokio::sync::OwnedMutexGuard<()>, String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<(), String>> {
    let guard = lock.lock_owned().await;
    authorize().await?;
    Ok(guard)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projection {
    pub source_id: String,
    pub revision: u64,
    #[serde(default)]
    pub access_revision: u64,
    pub markdown: String,
    pub raw_json: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projected {
    pub markdown_path: String,
    pub raw_path: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    revision: u64,
    #[serde(default)]
    access_revision: u64,
    files: std::collections::BTreeMap<String, Hashes>,
}
#[derive(Serialize, Deserialize)]
struct Hashes {
    current: String,
    previous: Option<String>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe_source(source: &str) -> bool {
    source.strip_prefix("native-").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn no_symlink(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Meeting projection refuses symbolic links".into());
    }
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    no_symlink(path)?;
    let parent = path.parent().ok_or("Invalid projection path")?;
    let tmp = parent.join(format!(".hq-meeting-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let a: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
            let b: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
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
        }
        #[cfg(not(windows))]
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(tmp);
    result.map_err(|_| "Cannot persist meeting projection".into())
}
fn protect_sync(root: &Path, prefix: &str) -> Result<(), String> {
    let preferred = root.join(".hqignore");
    let legacy = root.join(".hqsyncignore");
    let path = if preferred.exists() || !legacy.exists() {
        preferred
    } else {
        legacy
    };
    no_symlink(&path)?;
    let mut bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("Cannot read sync projection exclusions".into()),
    };
    if bytes.len() > 1024 * 1024 {
        return Err("Sync exclusion file is too large".into());
    }
    let suffix=format!("# HQ native meeting projections (server-owned)\n{prefix}/native-*.md\n{prefix}/native-*.raw.json\n");
    let content = String::from_utf8_lossy(&bytes);
    if let Some(index) = content.rfind(&suffix) {
        if !content[index + suffix.len()..]
            .lines()
            .any(|line| line.trim_start().starts_with('!'))
        {
            return Ok(());
        }
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(suffix.as_bytes());
    atomic(&path, &bytes)
}
fn project(company: &Path, ledger_path: &Path, input: Projection) -> Result<Projected, String> {
    if !safe_source(&input.source_id)
        || input.markdown.len() > 4 * 1024 * 1024
        || input.raw_json.len() > 8 * 1024 * 1024
    {
        return Err("Invalid meeting projection".into());
    }
    serde_json::from_str::<serde_json::Value>(&input.raw_json)
        .map_err(|_| "Invalid raw meeting JSON")?;
    no_symlink(company)?;
    let mut destination = company.to_path_buf();
    for part in ["sources", "meetings"] {
        destination.push(part);
        no_symlink(&destination)?;
        std::fs::create_dir_all(&destination).map_err(|_| "Cannot create meeting source folder")?;
    }
    no_symlink(ledger_path)?;
    if std::fs::metadata(ledger_path).is_ok_and(|m| m.len() > 65536) {
        return Err("Meeting projection tracking is too large".into());
    }
    let mut ledger: Ledger = match std::fs::read(ledger_path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Meeting projection tracking is damaged")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ledger::default(),
        Err(_) => return Err("Cannot read meeting projection tracking".into()),
    };
    if input.revision < ledger.revision || input.access_revision < ledger.access_revision {
        return Err("Meeting projection revision is stale".into());
    }
    let files = [
        (format!("{}.md", input.source_id), input.markdown),
        (format!("{}.raw.json", input.source_id), input.raw_json),
    ];
    for (name, content) in &files {
        let path = destination.join(name);
        no_symlink(&path)?;
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 8 * 1024 * 1024) {
            return Err("Existing meeting source is too large; preserved unchanged".into());
        }
        let existing = match std::fs::read(&path) {
            Ok(bytes) => Some(hash(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Cannot read existing meeting source".into()),
        };
        let desired = hash(content.as_bytes());
        if input.revision == ledger.revision
            && input.access_revision == ledger.access_revision
            && ledger.files.get(name).is_some_and(|h| h.current != desired)
        {
            return Err("Meeting projection revision conflicts with prior content".into());
        }
        if let Some(existing) = &existing {
            let owned = ledger
                .files
                .get(name)
                .is_some_and(|h| h.current == *existing || h.previous.as_ref() == Some(existing));
            if !owned {
                return Err("Local meeting source has untracked edits; preserved unchanged".into());
            }
        }
        ledger.files.insert(
            name.clone(),
            Hashes {
                current: desired,
                previous: existing,
            },
        );
    }
    ledger.revision = input.revision;
    ledger.access_revision = input.access_revision;
    let parent = ledger_path
        .parent()
        .ok_or("Invalid projection tracking path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create projection tracking")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect projection tracking")?;
    }
    // Write-ahead ownership permits recovery if the app exits between either
    // source replacement. Both old and intended hashes remain recognized.
    atomic(
        ledger_path,
        &serde_json::to_vec(&ledger).map_err(|_| "Cannot encode projection tracking")?,
    )?;
    for (name, content) in &files {
        atomic(&destination.join(name), content.as_bytes())?;
    }
    for hashes in ledger.files.values_mut() {
        hashes.previous = None;
    }
    atomic(
        ledger_path,
        &serde_json::to_vec(&ledger).map_err(|_| "Cannot encode projection tracking")?,
    )?;
    Ok(Projected {
        markdown_path: destination.join(&files[0].0).to_string_lossy().into(),
        raw_path: destination.join(&files[1].0).to_string_lossy().into(),
    })
}
#[tauri::command]
pub async fn meet_transcript_project(
    window: tauri::WebviewWindow,
    account_id: String,
    company_uid: String,
    projection: Projection,
    reveal: Option<bool>,
) -> Result<Projected, String> {
    if !matches!(window.label(), "call" | "desktop-alt") {
        return Err("Meeting projection unavailable in this window".into());
    }
    let tokens = super::cognito::get_tokens()
        .await
        .map_err(|_| "Cannot resolve account")?
        .ok_or("Not signed in")?;
    if account_id.is_empty()
        || super::auth::notification_identity_from_tokens(&tokens) != account_id
    {
        return Err("Meeting projection account changed".into());
    }
    let root = super::workspaces::resolve_hq_folder_path()?;
    let (companies, error) = super::workspaces::discover_local_companies(&root);
    if error.is_some() {
        return Err("Company mapping is unavailable".into());
    }
    let matching: Vec<_> = companies
        .into_iter()
        .filter(|c| c.cloud_uid.as_deref() == Some(&company_uid))
        .collect();
    if matching.len() != 1 {
        return Err("Company does not have one configured local vault folder".into());
    }
    let company = &matching[0];
    if company.slug.is_empty()
        || !company
            .slug
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid configured company slug".into());
    }
    let company_path = root.join("companies").join(&company.slug);
    let sync_prefix = format!("/companies/{}/sources/meetings", company.slug);
    no_symlink(&root.join("companies"))?;
    no_symlink(&company_path)?;
    if !company_path.is_dir() {
        return Err("Configured company folder is not present".into());
    }
    let ledger = dirs::data_dir()
        .ok_or("Cannot resolve application data")?
        .join("HQ/meet-projections")
        .join(format!(
            "{}.json",
            hash(format!("{account_id}\0{company_uid}\0{}", projection.source_id).as_bytes())
        ));
    let guard = lock_authorized(
        LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone(),
        || require_account(&account_id),
    ).await?;
    let result_account = account_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        // The blocking pool can queue this work too. Recheck at execution time.
        tauri::async_runtime::block_on(require_account(&account_id))?;
        protect_sync(&root, &sync_prefix)?;
        protect_sync(&company_path, "/sources/meetings")?;
        let result = project(&company_path, &ledger, projection)?;
        if reveal.unwrap_or(false) {
            tauri::async_runtime::block_on(require_account(&account_id))?;
            super::desktop_alt::reveal_file_in_manager(Path::new(&result.markdown_path))?;
        }
        Ok::<Projected, String>(result)
    })
    .await
    .map_err(|_| "Meeting projection worker failed")??;
    require_account(&result_account).await?;
    Ok(result)
}
/// Private local solo notes. These never enter the shared upload outbox.
#[tauri::command]
pub async fn meet_personal_transcript_project(
    window: tauri::WebviewWindow,
    account_id: String,
    projection: Projection,
    reveal: Option<bool>,
) -> Result<Projected, String> {
    if !matches!(window.label(), "call" | "desktop-alt") {
        return Err("Personal transcript unavailable in this window".into());
    }
    let tokens = super::cognito::get_tokens()
        .await
        .map_err(|_| "Cannot resolve account")?
        .ok_or("Not signed in")?;
    if account_id.is_empty()
        || super::auth::notification_identity_from_tokens(&tokens) != account_id
    {
        return Err("Personal transcript account changed".into());
    }
    let root = super::workspaces::resolve_hq_folder_path()?;
    let personal = root.join("personal");
    no_symlink(&personal)?;
    if !personal.is_dir() {
        return Err("Personal vault folder is not present".into());
    }
    let ledger = dirs::data_dir()
        .ok_or("Cannot resolve application data")?
        .join("HQ/meet-projections")
        .join(format!(
            "{}.json",
            hash(format!("{account_id}\0personal-local\0{}", projection.source_id).as_bytes())
        ));
    let guard = lock_authorized(
        LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone(),
        || require_account(&account_id),
    ).await?;
    let result_account = account_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        // The blocking pool can queue this work too. Recheck at execution time.
        tauri::async_runtime::block_on(require_account(&account_id))?;
        protect_sync(&root, "/personal/sources/meetings")?;
        protect_sync(&personal, "/sources/meetings")?;
        let result = project(&personal, &ledger, projection)?;
        if reveal.unwrap_or(false) {
            tauri::async_runtime::block_on(require_account(&account_id))?;
            super::desktop_alt::reveal_file_in_manager(Path::new(&result.markdown_path))?;
        }
        Ok::<Projected, String>(result)
    })
    .await
    .map_err(|_| "Personal transcript worker failed")??;
    require_account(&result_account).await?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_projection_rechecks_identity_before_work() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone().lock_owned().await;
        let current = Arc::new(AtomicBool::new(true));
        let checked = current.clone();
        let waiting = tokio::spawn(async move {
            lock_authorized(lock, || async move {
                if checked.load(Ordering::SeqCst) { Ok(()) }
                else { Err("Meeting projection account changed".to_string()) }
            }).await.map(|_| ())
        });
        tokio::task::yield_now().await;
        current.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(waiting.await.unwrap(), Err("Meeting projection account changed".to_string()));
    }

    fn input(revision: u64) -> Projection {
        Projection {
            source_id: format!("native-{}", "a".repeat(64)),
            revision,
            access_revision: 0,
            markdown: format!("revision {revision}"),
            raw_json: "{}".into(),
        }
    }
    #[test]
    fn sync_exclusions_preserve_legacy_rules_and_are_idempotent() {
        let d = tempfile::tempdir().unwrap();
        let legacy = d.path().join(".hqsyncignore");
        std::fs::write(&legacy, b"user-rule").unwrap();
        protect_sync(d.path(), "/sources/meetings").unwrap();
        let first = std::fs::read(&legacy).unwrap();
        assert!(first.starts_with(b"user-rule\n"));
        assert!(!d.path().join(".hqignore").exists());
        protect_sync(d.path(), "/sources/meetings").unwrap();
        assert_eq!(first, std::fs::read(&legacy).unwrap());
        std::fs::write(d.path().join(".hqignore"), b"preferred\n").unwrap();
        protect_sync(d.path(), "/sources/meetings").unwrap();
        assert_eq!(first, std::fs::read(&legacy).unwrap());
    }
    #[test]
    fn default_sync_filter_excludes_only_native_meetings() {
        let d = tempfile::tempdir().unwrap();
        let filter = hq_desktop_core::ignore::IgnoreFilter::for_hq_root(d.path()).unwrap();
        assert!(!filter.should_sync(
            &d.path()
                .join("companies/indigo/sources/meetings/native-abc.md")
        ));
        assert!(!filter.should_sync(
            &d.path()
                .join("companies/indigo/sources/meetings/native-abc.raw.json")
        ));
        assert!(filter.should_sync(&d.path().join("companies/indigo/sources/meetings/manual.md")));
    }
    #[test]
    fn access_expansion_updates_same_source_revision_without_accepting_stale_vectors() {
        let d = tempfile::tempdir().unwrap();
        let ledger = d.path().join("tracking/state.json");
        let mut initial = input(3);
        initial.access_revision = 2;
        project(d.path(), &ledger, initial).unwrap();
        let mut expanded = input(3);
        expanded.access_revision = 3;
        expanded.markdown = "expanded authorized view".into();
        let result = project(d.path(), &ledger, expanded).unwrap();
        assert_eq!(
            std::fs::read_to_string(result.markdown_path).unwrap(),
            "expanded authorized view"
        );
        let mut stale_access = input(4);
        stale_access.access_revision = 2;
        assert!(project(d.path(), &ledger, stale_access).is_err());
        let mut stale_source = input(2);
        stale_source.access_revision = 4;
        assert!(project(d.path(), &ledger, stale_source).is_err());
        let mut conflict = input(3);
        conflict.access_revision = 3;
        assert!(project(d.path(), &ledger, conflict).is_err());
    }
    #[test]
    fn personal_projection_stays_local_and_preserves_edits() {
        let d = tempfile::tempdir().unwrap();
        let personal = d.path().join("personal");
        std::fs::create_dir(&personal).unwrap();
        protect_sync(d.path(), "/personal/sources/meetings").unwrap();
        protect_sync(&personal, "/sources/meetings").unwrap();
        let ledger = d.path().join("tracking/personal.json");
        let result = project(&personal, &ledger, input(1)).unwrap();
        assert!(Path::new(&result.markdown_path).starts_with(personal.join("sources/meetings")));
        let filter = hq_desktop_core::ignore::IgnoreFilter::for_hq_root(d.path()).unwrap();
        assert!(!filter.should_sync(Path::new(&result.markdown_path)));
        assert!(!filter.should_sync(Path::new(&result.raw_path)));
        assert!(filter.should_sync(&personal.join("sources/meetings/manual.md")));
        std::fs::write(&result.markdown_path, "my edited personal note").unwrap();
        assert!(project(&personal, &ledger, input(2)).is_err());
        assert_eq!(
            std::fs::read_to_string(&result.markdown_path).unwrap(),
            "my edited personal note"
        );
    }
    #[test]
    fn update_and_refuse_user_edits() {
        let d = tempfile::tempdir().unwrap();
        let ledger = d.path().join("tracking/state.json");
        let first = project(d.path(), &ledger, input(1)).unwrap();
        project(d.path(), &ledger, input(2)).unwrap();
        std::fs::write(&first.markdown_path, "user notes").unwrap();
        assert!(project(d.path(), &ledger, input(3)).is_err());
        assert_eq!(
            std::fs::read_to_string(first.markdown_path).unwrap(),
            "user notes"
        );
    }
    #[test]
    fn reject_foreign_file_traversal_and_stale() {
        let d = tempfile::tempdir().unwrap();
        let ledger = d.path().join("tracking/state.json");
        let mut bad = input(1);
        bad.source_id = "../escape".into();
        assert!(project(d.path(), &ledger, bad).is_err());
        project(d.path(), &ledger, input(2)).unwrap();
        assert!(project(d.path(), &ledger, input(1)).is_err());
        std::fs::remove_file(&ledger).unwrap();
        assert!(project(d.path(), &ledger, input(3)).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn reject_symlink_sources() {
        let d = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), d.path().join("sources")).unwrap();
        assert!(project(d.path(), &d.path().join("tracking.json"), input(1)).is_err());
    }
}
