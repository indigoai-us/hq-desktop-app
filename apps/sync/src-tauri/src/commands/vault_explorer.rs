//! Files explorer commands: vault home, quick switcher, note links, note text.
//!
//! Each vault's [`VaultSnapshot`] lives in memory for the life of the app, so
//! the renderer asks small questions instead of receiving the whole vault.
//! Answers come from the snapshot already built; once it is older than
//! [`REFRESH_AFTER`], the next question starts a background rebuild that
//! re-reads only notes that changed (stale-while-revalidate). The first
//! question about a vault waits for its first build.
//!
//! Every command takes the gates the other Files commands use: signed in, the
//! desktop session's company scope, and live company membership.

use std::collections::HashMap;
use std::fs::File;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hq_desktop_core::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, resolve_hq_folder,
    validate_hq_relative_path,
};
use hq_desktop_core::vault_index::{
    read_note_head, FileHit, NoteLinks, NotePreview, VaultSnapshot, VaultSummary,
};
use tauri::{AppHandle, Manager, State};

use super::desktop_alt::{
    enforce_desktop_read_scope, hydrated_file_context, require_company_file_read_access,
    require_matching_company_scope, resolve_authorized_file_target,
    revalidate_authorized_file_target, DesktopSessionScope,
};

/// A snapshot older than this is rebuilt in the background on the next question.
const REFRESH_AFTER: Duration = Duration::from_secs(15);
/// Most of a note sent to the renderer. Rendering is synchronous in the
/// webview; half a megabyte renders in under a tenth of a second.
const MAX_NOTE_BYTES: u64 = 512 * 1024;
/// Only frontmatter is sent to list surfaces; reject headers larger than 8 KiB.
const MAX_FRONTMATTER_BYTES: usize = 8 * 1024;
/// Most quick-switcher results.
const MAX_SEARCH_RESULTS: usize = 60;

/// Account id, HQ folder, vault root, and system-files toggle. The account
/// partition keeps a second sign-in in this process from inheriting the first
/// person's in-memory index.
type VaultKey = (String, PathBuf, String, bool);

#[derive(Default)]
struct Slot {
    snapshot: tokio::sync::RwLock<Option<(Instant, Arc<VaultSnapshot>)>>,
    /// Serializes first builds so concurrent questions share one walk.
    first_build: tokio::sync::Mutex<()>,
    /// A stale-while-revalidate task and prewarm must not walk the same vault
    /// together. Owned guards let a detached refresh hold this across awaits.
    refresh: Arc<tokio::sync::Mutex<()>>,
}

static PREWARM_RUNNING: AtomicBool = AtomicBool::new(false);

fn cache_write_lock() -> &'static Mutex<()> {
    static CACHE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    CACHE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn slots() -> &'static Mutex<HashMap<VaultKey, Arc<Slot>>> {
    static SLOTS: OnceLock<Mutex<HashMap<VaultKey, Arc<Slot>>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

fn slot(key: &VaultKey) -> Arc<Slot> {
    let mut slots = slots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    slots.entry(key.clone()).or_default().clone()
}

async fn build(
    key: &VaultKey,
    previous: Option<Arc<VaultSnapshot>>,
) -> Result<Arc<VaultSnapshot>, String> {
    let (_, hq, root, include_system) = key.clone();
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let snapshot = VaultSnapshot::build(&hq, &root, include_system, previous.as_deref())?;
        let summary = snapshot.summary();
        crate::util::logfile::log(
            "vault-index",
            &format!(
                "build complete in {} ms: {} files, {} notes",
                started.elapsed().as_millis(),
                summary.files,
                summary.notes
            ),
        );
        Ok(Arc::new(snapshot))
    })
    .await
    .map_err(|e| format!("vault index task failed: {e}"))?
}

fn cache_path(app: &AppHandle, key: &VaultKey) -> Result<PathBuf, String> {
    let (account_id, hq, root, include_system) = key;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hq.hash(&mut hasher);
    root.hash(&mut hasher);
    include_system.hash(&mut hasher);
    // Account ids are opaque service identifiers, so put only a filesystem-safe
    // encoding in the directory name. The snapshot also verifies its root and
    // option on load, making a hash collision a harmless cache miss.
    let account_dir = cache_account_dir_name(account_id);
    app.path()
        .app_data_dir()
        .map(|dir| {
            dir.join("vault-index")
                .join(account_dir)
                .join(format!("{:016x}.json", hasher.finish()))
        })
        .map_err(|error| format!("could not resolve vault index cache directory: {error}"))
}

fn cache_account_dir_name(account_id: &str) -> String {
    account_id
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn cache_previous(app: &AppHandle, key: &VaultKey) -> Option<Arc<VaultSnapshot>> {
    let path = cache_path(app, key).ok()?;
    let (_, _, root, include_system) = key.clone();
    tokio::task::spawn_blocking(move || {
        VaultSnapshot::load(&path, &root, include_system).map(Arc::new)
    })
    .await
    .ok()
    .flatten()
}

fn cache_write_matches(
    current: Option<&crate::commands::auth::AuthSessionEnvelope>,
    account_id: &str,
    generation: u64,
) -> bool {
    current.is_some_and(|current| {
        current.account_id.as_deref() == Some(account_id) && current.generation == generation
    })
}

fn save_snapshot_if_current(
    path: &Path,
    snapshot: &VaultSnapshot,
    account_id: &str,
    generation: u64,
    current: Option<&crate::commands::auth::AuthSessionEnvelope>,
) -> Result<bool, String> {
    if !cache_write_matches(current, account_id, generation) {
        return Ok(false);
    }
    snapshot.save(path)?;
    Ok(true)
}

fn persist_snapshot(app: &AppHandle, key: &VaultKey, snapshot: Arc<VaultSnapshot>) {
    let Some(account) = crate::commands::auth::active_auth_session_snapshot() else {
        return;
    };
    let Some(account_id) = account.account_id else {
        return;
    };
    if account_id != key.0 {
        return;
    }
    let Ok(path) = cache_path(app, key) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("vault-index-save".to_string())
        .spawn(move || {
            let _write = cache_write_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Sign-out removes this partition. Check immediately before the
            // write while sharing the clear lock, so a completed build cannot
            // recreate this folder after sign-out removes it.
            let current = crate::commands::auth::active_auth_session_snapshot();
            match save_snapshot_if_current(
                &path,
                &snapshot,
                &account_id,
                account.generation,
                current.as_ref(),
            ) {
                Ok(true) | Ok(false) => {}
                Err(error) => crate::util::logfile::log(
                    "vault-index",
                    &format!("snapshot cache write skipped: {error}"),
                ),
            }
        });
}

async fn refresh_snapshot(
    app: &AppHandle,
    key: VaultKey,
    slot: Arc<Slot>,
    refresh: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Arc<VaultSnapshot>, String> {
    let _refresh = refresh;
    let previous = match slot.snapshot.read().await.clone() {
        Some((_, snapshot)) => Some(snapshot),
        None => cache_previous(app, &key).await,
    };
    let fresh = build(&key, previous.clone()).await?;
    let changed = previous
        .as_ref()
        .is_none_or(|previous| !fresh.same_index(previous));
    *slot.snapshot.write().await = Some((Instant::now(), fresh.clone()));
    if changed {
        persist_snapshot(app, &key, fresh.clone());
    }
    Ok(fresh)
}

fn refresh_in_background(app: AppHandle, key: VaultKey, slot: Arc<Slot>) {
    let Ok(refresh) = slot.refresh.clone().try_lock_owned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _ = refresh_snapshot(&app, key, slot, refresh).await;
    });
}

/// The current snapshot for a vault, building it on first use and refreshing
/// it in the background once stale.
async fn snapshot(app: &AppHandle, key: VaultKey) -> Result<Arc<VaultSnapshot>, String> {
    let slot = slot(&key);
    if let Some((built_at, snap)) = slot.snapshot.read().await.clone() {
        if built_at.elapsed() > REFRESH_AFTER {
            refresh_in_background(app.clone(), key, slot.clone());
        }
        return Ok(snap);
    }
    let _first = slot.first_build.lock().await;
    if let Some((_, snap)) = slot.snapshot.read().await.clone() {
        return Ok(snap);
    }
    if let Some(cached) = cache_previous(app, &key).await {
        // A persisted snapshot is useful immediately, but must never be treated
        // as current. Mark it stale so the first caller starts the same
        // stale-while-revalidate walk used for an in-memory snapshot.
        *slot.snapshot.write().await = Some((Instant::now() - REFRESH_AFTER, cached.clone()));
        refresh_in_background(app.clone(), key, slot.clone());
        return Ok(cached);
    }
    let refresh = slot.refresh.clone().lock_owned().await;
    refresh_snapshot(app, key, slot.clone(), refresh).await
}

fn prewarm_is_quiet(app: &AppHandle) -> bool {
    !crate::commands::process::is_registered("hq-sync")
        && app
            .try_state::<crate::commands::update_gate::UpdateHoldsState>()
            .is_none_or(|holds| {
                !holds
                    .0
                    .active()
                    .iter()
                    .any(hq_desktop_core::update_gate::HoldReason::is_recording)
            })
}

async fn wait_for_prewarm_quiet(app: &AppHandle) {
    while !prewarm_is_quiet(app) {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn visit_roots_sequentially<T, F, Fut>(roots: Vec<T>, mut visit: F)
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = bool>,
{
    for root in roots {
        if !visit(root).await {
            break;
        }
    }
}

struct PrewarmClaim<'a>(&'a AtomicBool);

impl Drop for PrewarmClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn claim_prewarm(running: &AtomicBool) -> Option<PrewarmClaim<'_>> {
    (!running.swap(true, Ordering::AcqRel)).then_some(PrewarmClaim(running))
}

/// Starts after the first successful shell paint. It deliberately performs no
/// work on the launch path, indexes one vault at a time, and reuses the exact
/// command authorization before each candidate is admitted.
pub fn prewarm_after_shell_ready(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(_claim) = claim_prewarm(&PREWARM_RUNNING) else {
            return;
        };
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(account) = crate::commands::auth::active_auth_session_snapshot() else {
            return;
        };
        let account_id = account.account_id.unwrap_or_default();
        let account_generation = account.generation;
        let scope = app.state::<DesktopSessionScope>();
        let active = scope.active_company_slug();
        let mut roots = active
            .as_deref()
            .map(|slug| vec![format!("companies/{slug}")])
            .unwrap_or_default();
        roots.push(String::new());

        // Every candidate below receives its own desktop read scope and still
        // passes through authorize_vault, including the live membership check.
        // This does not mutate the shell's active-company scope while it warms
        // the person's other readable vaults one at a time.
        if let Ok((_, workspaces)) = hydrated_file_context().await {
            for workspace in workspaces {
                let root = format!("companies/{}", workspace.slug);
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
        }
        visit_roots_sequentially(roots, move |root| {
            let app = app.clone();
            let account_id = account_id.clone();
            async move {
                wait_for_prewarm_quiet(&app).await;
                let Some(current) = crate::commands::auth::active_auth_session_snapshot() else {
                    return false;
                };
                if current.account_id.as_deref() != Some(account_id.as_str())
                    || current.generation != account_generation
                {
                    return false;
                }
                let candidate_scope = DesktopSessionScope {
                    active_company: Mutex::new(root.strip_prefix("companies/").map(str::to_string)),
                };
                let Ok(key) = authorize_vault(&root, false, &candidate_scope).await else {
                    return true;
                };
                // Unlike the foreground command path, prewarm waits for every
                // build or refresh before admitting the next vault.
                let slot = slot(&key);
                let refresh = slot.refresh.clone().lock_owned().await;
                let _ = refresh_snapshot(&app, key, slot, refresh).await;
                true
            }
        })
        .await;
    });
}

/// Auth transitions call this before tokens disappear. Removing only the
/// current account's partition keeps the next account from reading it while
/// leaving unrelated OS users' local data untouched.
pub fn clear_account_cache(app: &AppHandle, account_id: &str) {
    slots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(cached_account_id, _, _, _), _| cached_account_id != account_id);
    let account_dir = cache_account_dir_name(account_id);
    let Ok(root) = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("vault-index").join(account_dir))
    else {
        return;
    };
    let _write = cache_write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = std::fs::remove_dir_all(root);
}

/// Authorize a vault root (`""` or `companies/<slug>`) and return its cache key.
async fn authorize_vault(
    root: &str,
    include_system: bool,
    scope: &DesktopSessionScope,
) -> Result<VaultKey, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let normalized = validate_hq_relative_path(root, true)?;
    enforce_desktop_read_scope(&normalized, scope)?;
    let hq = if company_slug_for_hq_path(&normalized)?.is_some() {
        let (hq, workspaces) = hydrated_file_context().await?;
        let canonical = canonical_hq_relative_path(&hq, &normalized, false)?;
        require_matching_company_scope(&normalized, &canonical)?;
        require_company_file_read_access(&workspaces, &canonical)?;
        hq
    } else {
        resolve_hq_folder()
    };
    let account_id = crate::commands::auth::active_auth_session_snapshot()
        .and_then(|session| session.account_id)
        .filter(|account_id| !account_id.trim().is_empty())
        .ok_or_else(|| "file explorer requires a signed-in user".to_string())?;
    Ok((account_id, hq, normalized, include_system))
}

/// Counts, most linked notes and top folders for the vault home.
#[tauri::command]
pub async fn vault_summary(
    app: AppHandle,
    root: String,
    include_system: bool,
    scope: State<'_, DesktopSessionScope>,
) -> Result<VaultSummary, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    Ok(snapshot(&app, key).await?.summary())
}

/// Quick switcher: files in the vault matching `query`.
#[tauri::command]
pub async fn vault_search(
    app: AppHandle,
    root: String,
    include_system: bool,
    query: String,
    scope: State<'_, DesktopSessionScope>,
) -> Result<Vec<FileHit>, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    let snap = snapshot(&app, key).await?;
    Ok(snap.search(&query, MAX_SEARCH_RESULTS))
}

/// Where the open note's `[[targets]]` go, and which notes link to it.
#[tauri::command]
pub async fn vault_note_links(
    app: AppHandle,
    root: String,
    include_system: bool,
    path: String,
    targets: Vec<String>,
    scope: State<'_, DesktopSessionScope>,
) -> Result<NoteLinks, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    let snap = snapshot(&app, key).await?;
    Ok(snap.note_links(&path, &targets))
}

/// A note's text for the reading view, at most [`MAX_NOTE_BYTES`], cut at a
/// line break. Same authorization as `get_company_file_content`.
#[tauri::command]
pub async fn read_vault_note(
    path: String,
    scope: State<'_, DesktopSessionScope>,
) -> Result<NotePreview, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let target = resolve_authorized_file_target(&path).await?;
    let target = revalidate_authorized_file_target(&target).await?;
    enforce_desktop_read_scope(&target.relative_path, &scope)?;
    let absolute = target.absolute_path.clone();
    tokio::task::spawn_blocking(move || read_note_head(&absolute, MAX_NOTE_BYTES))
        .await
        .map_err(|e| format!("note read task failed: {e}"))?
}

/// Read one Markdown frontmatter block without loading or returning the note body.
fn read_note_frontmatter(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("frontmatter read failed: {e}"))?;
    read_frontmatter_from(file, MAX_FRONTMATTER_BYTES)
}

fn read_frontmatter_from<R: Read>(reader: R, max_bytes: usize) -> Result<String, String> {
    let mut reader = BufReader::new(reader.take(max_bytes as u64 + 1));
    let mut frontmatter = Vec::with_capacity(max_bytes.min(1024));
    let mut line = Vec::new();
    let mut opened = false;
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("frontmatter read failed: {e}"))?;
        if count == 0 {
            return Err("frontmatter closing delimiter not found within 8 KiB".to_string());
        }
        if frontmatter.len() + count > max_bytes {
            return Err("frontmatter exceeds the 8 KiB limit".to_string());
        }
        let line_content = match line.strip_suffix(b"\n") {
            Some(without_lf) => without_lf.strip_suffix(b"\r").unwrap_or(without_lf),
            None => line.as_slice(),
        };
        if !opened {
            if line_content != b"---" {
                return Err("note does not begin with frontmatter".to_string());
            }
            opened = true;
        } else if line_content == b"---" {
            frontmatter.extend_from_slice(&line);
            return String::from_utf8(frontmatter)
                .map_err(|e| format!("frontmatter is not valid UTF-8: {e}"));
        }
        frontmatter.extend_from_slice(&line);
    }
}

/// Bounded frontmatter read with the same account, path, and company checks as
/// `read_vault_note`; the file operation stays off the async executor.
#[tauri::command]
pub async fn read_vault_note_frontmatter(
    path: String,
    scope: State<'_, DesktopSessionScope>,
) -> Result<String, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let target = resolve_authorized_file_target(&path).await?;
    let target = revalidate_authorized_file_target(&target).await?;
    enforce_desktop_read_scope(&target.relative_path, &scope)?;
    let absolute = target.absolute_path.clone();
    tokio::task::spawn_blocking(move || read_note_frontmatter(&absolute))
        .await
        .map_err(|e| format!("frontmatter read task failed: {e}"))?
}

#[cfg(test)]
mod frontmatter_tests {
    use super::{
        cache_account_dir_name, cache_write_matches, claim_prewarm, read_frontmatter_from,
        save_snapshot_if_current, visit_roots_sequentially, MAX_FRONTMATTER_BYTES,
    };
    use hq_desktop_core::vault_index::VaultSnapshot;
    use std::fs;
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn frontmatter_read_stops_at_closing_delimiter_before_large_body() {
        let header = b"---\nid: meeting:test\nsource_id: native-test\n---\n";
        let mut note = header.to_vec();
        note.extend(std::iter::repeat(b'x').take(MAX_FRONTMATTER_BYTES * 4));

        let actual = read_frontmatter_from(Cursor::new(note), MAX_FRONTMATTER_BYTES).unwrap();
        assert_eq!(actual.as_bytes(), header);
    }

    #[test]
    fn frontmatter_read_rejects_an_unterminated_header_at_the_byte_cap() {
        let mut note = b"---\n".to_vec();
        note.extend(std::iter::repeat(b'x').take(MAX_FRONTMATTER_BYTES));

        let error = read_frontmatter_from(Cursor::new(note), MAX_FRONTMATTER_BYTES).unwrap_err();
        assert!(error.contains("8 KiB"));
    }

    #[test]
    fn prewarm_is_single_flight_until_the_prior_run_ends() {
        let running = AtomicBool::new(false);
        let first = claim_prewarm(&running).expect("first prewarm starts");
        assert!(claim_prewarm(&running).is_none());
        drop(first);
        assert!(claim_prewarm(&running).is_some());
    }

    #[test]
    fn changed_account_generation_rejects_a_late_cache_write() {
        assert!(!cache_write_matches(None, "account-a", 1));
    }

    #[test]
    fn late_build_does_not_recreate_a_signed_out_account_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let hq = tmp.path().join("hq");
        fs::create_dir_all(hq.join("companies/acme")).unwrap();
        fs::write(hq.join("companies/acme/note.md"), "").unwrap();
        let snapshot = VaultSnapshot::build(Path::new(&hq), "companies/acme", false, None).unwrap();
        let cache = tmp
            .path()
            .join(cache_account_dir_name("account-a"))
            .join("snapshot.json");

        assert!(!save_snapshot_if_current(&cache, &snapshot, "account-a", 1, None).unwrap());
        assert!(!cache.parent().unwrap().exists());
        assert_ne!(
            cache_account_dir_name("account-a"),
            cache_account_dir_name("account-b")
        );
    }

    #[test]
    fn prewarm_visits_roots_one_at_a_time() {
        tauri::async_runtime::block_on(async {
            let in_flight = Arc::new(AtomicUsize::new(0));
            let visited = Arc::new(Mutex::new(Vec::new()));
            visit_roots_sequentially(vec!["first", "second", "third"], |root| {
                let in_flight = in_flight.clone();
                let visited = visited.clone();
                async move {
                    assert_eq!(in_flight.fetch_add(1, Ordering::AcqRel), 0);
                    tokio::task::yield_now().await;
                    visited.lock().unwrap().push(root);
                    assert_eq!(in_flight.fetch_sub(1, Ordering::AcqRel), 1);
                    true
                }
            })
            .await;
            assert_eq!(*visited.lock().unwrap(), vec!["first", "second", "third"]);
        });
    }
}
