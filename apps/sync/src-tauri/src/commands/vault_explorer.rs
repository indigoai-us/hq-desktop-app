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
use std::path::PathBuf;
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
use tauri::State;

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
/// Most quick-switcher results.
const MAX_SEARCH_RESULTS: usize = 60;

type VaultKey = (PathBuf, String, bool);

#[derive(Default)]
struct Slot {
    snapshot: tokio::sync::RwLock<Option<(Instant, Arc<VaultSnapshot>)>>,
    /// Serializes first builds so concurrent questions share one walk.
    first_build: tokio::sync::Mutex<()>,
    refreshing: AtomicBool,
}

fn slot(key: &VaultKey) -> Arc<Slot> {
    static SLOTS: OnceLock<Mutex<HashMap<VaultKey, Arc<Slot>>>> = OnceLock::new();
    let mut slots = SLOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    slots.entry(key.clone()).or_default().clone()
}

async fn build(
    key: &VaultKey,
    previous: Option<Arc<VaultSnapshot>>,
) -> Result<Arc<VaultSnapshot>, String> {
    let (hq, root, include_system) = key.clone();
    tokio::task::spawn_blocking(move || {
        VaultSnapshot::build(&hq, &root, include_system, previous.as_deref()).map(Arc::new)
    })
    .await
    .map_err(|e| format!("vault index task failed: {e}"))?
}

/// The current snapshot for a vault, building it on first use and refreshing
/// it in the background once stale.
async fn snapshot(key: VaultKey) -> Result<Arc<VaultSnapshot>, String> {
    let slot = slot(&key);
    if let Some((built_at, snap)) = slot.snapshot.read().await.clone() {
        if built_at.elapsed() > REFRESH_AFTER && !slot.refreshing.swap(true, Ordering::AcqRel) {
            let slot = slot.clone();
            let previous = snap.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(fresh) = build(&key, Some(previous)).await {
                    *slot.snapshot.write().await = Some((Instant::now(), fresh));
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
    let snap = build(&key, None).await?;
    *slot.snapshot.write().await = Some((Instant::now(), snap.clone()));
    Ok(snap)
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
    Ok((hq, normalized, include_system))
}

/// Counts, most linked notes and top folders for the vault home.
#[tauri::command]
pub async fn vault_summary(
    root: String,
    include_system: bool,
    scope: State<'_, DesktopSessionScope>,
) -> Result<VaultSummary, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    Ok(snapshot(key).await?.summary())
}

/// Quick switcher: files in the vault matching `query`.
#[tauri::command]
pub async fn vault_search(
    root: String,
    include_system: bool,
    query: String,
    scope: State<'_, DesktopSessionScope>,
) -> Result<Vec<FileHit>, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    let snap = snapshot(key).await?;
    Ok(snap.search(&query, MAX_SEARCH_RESULTS))
}

/// Where the open note's `[[targets]]` go, and which notes link to it.
#[tauri::command]
pub async fn vault_note_links(
    root: String,
    include_system: bool,
    path: String,
    targets: Vec<String>,
    scope: State<'_, DesktopSessionScope>,
) -> Result<NoteLinks, String> {
    let key = authorize_vault(&root, include_system, &scope).await?;
    let snap = snapshot(key).await?;
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
