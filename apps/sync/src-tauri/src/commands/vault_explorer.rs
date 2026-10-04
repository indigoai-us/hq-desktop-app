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
    refreshing: AtomicBool,
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
    let account_dir = account_id
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    app.path()
        .app_data_dir()
        .map(|dir| {
            dir.join("vault-index")
                .join(account_dir)
                .join(format!("{:016x}.json", hasher.finish()))
        })
        .map_err(|error| format!("could not resolve vault index cache directory: {error}"))
}

fn cache_previous(app: &AppHandle, key: &VaultKey) -> Option<Arc<VaultSnapshot>> {
    let (_, _, root, include_system) = key;
    VaultSnapshot::load(&cache_path(app, key).ok()?, root, *include_system).map(Arc::new)
}

fn persist_snapshot(app: &AppHandle, key: &VaultKey, snapshot: Arc<VaultSnapshot>) {
    let Ok(path) = cache_path(app, key) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("vault-index-save".to_string())
        .spawn(move || {
            if let Err(error) = snapshot.save(&path) {
                crate::util::logfile::log(
                    "vault-index",
                    &format!("snapshot cache write skipped: {error}"),
                );
            }
        });
}

/// The current snapshot for a vault, building it on first use and refreshing
/// it in the background once stale.
async fn snapshot(app: &AppHandle, key: VaultKey) -> Result<Arc<VaultSnapshot>, String> {
    let slot = slot(&key);
    if let Some((built_at, snap)) = slot.snapshot.read().await.clone() {
        if built_at.elapsed() > REFRESH_AFTER && !slot.refreshing.swap(true, Ordering::AcqRel) {
            let slot = slot.clone();
            let previous = snap.clone();
            let current = snap.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(fresh) = build(&key, Some(previous)).await {
                    let changed = !fresh.same_index(&current);
                    *slot.snapshot.write().await = Some((Instant::now(), fresh));
                    if changed {
                        if let Some((_, fresh)) = slot.snapshot.read().await.clone() {
                            persist_snapshot(&app, &key, fresh);
                        }
                    }
                }
                slot.refreshing.store(false, Ordering::Release);
            });
        }
        return Ok(snap);
    }
    let _first = slot.first_build.lock().await;
    if let Some((_, snap)) = slot.snapshot.read().await.clone() {
        return Ok(snap);
    }
    if let Some(cached) = cache_previous(app, &key) {
        // A persisted snapshot is useful immediately, but must never be treated
        // as current. Mark it stale so the first caller starts the same
        // stale-while-revalidate walk used for an in-memory snapshot.
        *slot.snapshot.write().await = Some((Instant::now() - REFRESH_AFTER, cached.clone()));
        if !slot.refreshing.swap(true, Ordering::AcqRel) {
            let slot = slot.clone();
            let previous = cached.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(fresh) = build(&key, Some(previous.clone())).await {
                    let changed = !fresh.same_index(&previous);
                    *slot.snapshot.write().await = Some((Instant::now(), fresh.clone()));
                    if changed {
                        persist_snapshot(&app, &key, fresh);
                    }
                }
                slot.refreshing.store(false, Ordering::Release);
            });
        }
        return Ok(cached);
    }
    let snap = build(&key, None).await?;
    *slot.snapshot.write().await = Some((Instant::now(), snap.clone()));
    persist_snapshot(app, &key, snap.clone());
    Ok(snap)
}

/// Starts after the first successful shell paint. It deliberately performs no
/// work on the launch path, indexes one vault at a time, and reuses the exact
/// command authorization before each candidate is admitted.
pub fn prewarm_after_shell_ready(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
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
        for root in roots {
            let Some(current) = crate::commands::auth::active_auth_session_snapshot() else {
                return;
            };
            if current.account_id.as_deref() != Some(account_id.as_str())
                || current.generation != account_generation
            {
                return;
            }
            let candidate_scope = DesktopSessionScope {
                active_company: Mutex::new(root.strip_prefix("companies/").map(str::to_string)),
            };
            let Ok(key) = authorize_vault(&root, false, &candidate_scope).await else {
                continue;
            };
            let _ = snapshot(&app, key).await;
        }
    });
}

/// Auth transitions call this before tokens disappear. Removing only the
/// current account's partition keeps the next account from reading it while
/// leaving unrelated OS users' local data untouched.
pub fn clear_account_cache(app: &AppHandle) {
    let Some(account) = crate::commands::auth::active_auth_session_snapshot() else {
        return;
    };
    let Some(account_id) = account.account_id else {
        return;
    };
    slots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(cached_account_id, _, _, _), _| cached_account_id != &account_id);
    let account_dir = account_id
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let Ok(root) = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("vault-index").join(account_dir))
    else {
        return;
    };
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
    use super::{read_frontmatter_from, MAX_FRONTMATTER_BYTES};
    use std::io::Cursor;

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
}
