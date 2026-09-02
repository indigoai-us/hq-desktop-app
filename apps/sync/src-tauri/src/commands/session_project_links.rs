//! Project channels ↔ sessions.
//!
//! Two things live here, both on top of the pure rules in
//! [`hq_desktop_core::session_links`]:
//!
//! * `session_project_links(company)` — the join the HQ Work shell decorates
//!   its sidebar with: every company project, the channel that stands for it
//!   (hq-pro's `projectId` when present, else the `p-<slug>` naming
//!   convention), and the sessions bound to it — live registry rows first,
//!   then the newest on-disk `workspace/sessions/*/meta.yaml` records. Cached
//!   for [`CACHE_TTL`] per company: the sidebar asks on every phase edge and
//!   every 30 s, and the channel listing is a network call.
//!
//! * the project watch — a 5 s scan of `companies/<co>/projects/*/prd.json`
//!   for every company with a live session. A NEW `prd.json` (HQ's `/plan`,
//!   `/deep-plan`, `/prd` write one) binds the company's most recently active
//!   session to that project and emits [`EVENT_PROJECT_CREATED`], which the
//!   Sessions page turns into an "offer a channel" card. Creating the channel
//!   is outward-facing and stays behind the operator's explicit confirm in
//!   `session_share_to_channel`; nothing here posts anything.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hq_desktop_core::agent_session_flags::ensure_in_app_sessions_allowed;
use hq_desktop_core::hq_context::projects::list_company_projects;
use hq_desktop_core::session_links::{
    join_project_links, merge_session_rows, read_recent_session_rows, scan_project_slugs,
    session_row_from_summary, session_to_bind, ChannelRow, ProjectCreated, ProjectLink,
    ProjectWatch, MAX_DISK_SESSIONS,
};
use hq_desktop_core::agent_session::types::SessionPhase;
use hq_desktop_core::workspaces::resolve_hq_folder_path;
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::agent_session::{bind_session_project, live_session_summaries};
use crate::commands::hq_context::company_cloud_uid;
use crate::commands::messages;
use crate::util::logfile::log;

const LOG_TAG: &str = "session-links";

/// Tauri event: HQ created a project while a session was live.
pub const EVENT_PROJECT_CREATED: &str = "agent-session:project-created";

/// How long one company's join is reused before it is rebuilt.
pub const CACHE_TTL: Duration = Duration::from_secs(10);

/// How often the project directories of live-session companies are scanned.
const WATCH_INTERVAL: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

struct CacheEntry {
    at: Instant,
    links: Vec<ProjectLink>,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget every cached join — a binding changed, so the next ask must rebuild.
pub fn invalidate_links_cache() {
    if let Ok(mut guard) = cache().lock() {
        guard.clear();
    }
}

fn cached(company: &str) -> Option<Vec<ProjectLink>> {
    let guard = cache().lock().ok()?;
    let entry = guard.get(company)?;
    (entry.at.elapsed() < CACHE_TTL).then(|| entry.links.clone())
}

fn remember(company: &str, links: &[ProjectLink]) {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            company.to_string(),
            CacheEntry {
                at: Instant::now(),
                links: links.to_vec(),
            },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

/// The channels of a company as join rows. A company that is not
/// cloud-connected, or a listing that fails (offline, signed out), yields no
/// channels rather than no links: the session side of the join still works.
async fn company_channels(hq_root: &std::path::Path, company: &str) -> Vec<ChannelRow> {
    let Some(company_uid) = company_cloud_uid(hq_root, company) else {
        return Vec::new();
    };
    match messages::list_channels(Some(company_uid.clone()), Some(true)).await {
        Ok(listing) => listing
            .channels
            .into_iter()
            .filter(|channel| {
                channel
                    .company_uid
                    .as_deref()
                    .map(|uid| uid == company_uid)
                    .unwrap_or(false)
            })
            .map(|channel| ChannelRow {
                channel_id: channel.channel_id,
                name: channel.name,
                project_id: channel.project_id,
            })
            .collect(),
        Err(e) => {
            log(LOG_TAG, &format!("LINKS_CHANNELS_UNAVAILABLE company={company} {e}"));
            Vec::new()
        }
    }
}

async fn build_links(company: &str) -> Result<Vec<ProjectLink>, String> {
    let hq_root = resolve_hq_folder_path()?;
    let projects = list_company_projects(&hq_root, company);
    let live: Vec<_> = live_session_summaries()
        .await
        .iter()
        .map(session_row_from_summary)
        .collect();
    let disk = read_recent_session_rows(&hq_root, MAX_DISK_SESSIONS);
    let sessions = merge_session_rows(live, disk);
    let channels = company_channels(&hq_root, company).await;
    Ok(join_project_links(company, &projects, &sessions, &channels))
}

/// Every project of `company` with its channel and its sessions.
#[tauri::command]
pub async fn session_project_links(company: String) -> Result<Vec<ProjectLink>, String> {
    ensure_in_app_sessions_allowed()?;
    let company = company.trim().to_string();
    if company.is_empty() {
        return Err("company must not be empty".to_string());
    }
    if let Some(links) = cached(&company) {
        return Ok(links);
    }
    let links = build_links(&company).await?;
    remember(&company, &links);
    Ok(links)
}

// ─────────────────────────────────────────────────────────────────────────────
// Project watch
// ─────────────────────────────────────────────────────────────────────────────

fn watch() -> &'static Mutex<ProjectWatch> {
    static WATCH: OnceLock<Mutex<ProjectWatch>> = OnceLock::new();
    WATCH.get_or_init(|| Mutex::new(ProjectWatch::new()))
}

/// One scan: for every company with a live session, name the projects that
/// appeared since the last scan, bind the company's most recently active
/// session to each, and report them. Pure over the registry snapshot + disk;
/// the caller emits.
async fn scan_once(hq_root: &std::path::Path) -> Vec<ProjectCreated> {
    let summaries = live_session_summaries().await;
    let companies: BTreeSet<String> = summaries
        .iter()
        .filter(|s| s.phase != SessionPhase::Ended)
        .filter_map(|s| s.company.as_deref())
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let fresh: Vec<(String, String)> = {
        let Ok(mut guard) = watch().lock() else {
            return Vec::new();
        };
        guard.retain(&companies);
        let mut out = Vec::new();
        for company in &companies {
            for slug in guard.observe(company, scan_project_slugs(hq_root, company)) {
                out.push((company.clone(), slug));
            }
        }
        out
    };

    let mut created = Vec::new();
    for (company, slug) in fresh {
        let Some(target) = session_to_bind(&summaries, &company) else {
            continue;
        };
        let project_path = hq_root
            .join("companies")
            .join(&company)
            .join("projects")
            .join(&slug)
            .to_string_lossy()
            .into_owned();
        match bind_session_project(hq_root, &target.session_id, &slug).await {
            Ok(_) => log(
                LOG_TAG,
                &format!(
                    "PROJECT_CREATED company={company} project={slug} session={}",
                    target.session_id
                ),
            ),
            Err(e) => {
                log(LOG_TAG, &format!("PROJECT_BIND_FAILED project={slug} {e}"));
                continue;
            }
        }
        created.push(ProjectCreated {
            session_id: target.session_id.clone(),
            company,
            project: slug,
            project_path,
        });
    }
    if !created.is_empty() {
        invalidate_links_cache();
    }
    created
}

/// Spawn the project watch. Called from `main.rs` setup; ticks every
/// [`WATCH_INTERVAL`] and does nothing at all while no session is live.
pub fn setup_project_watch<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(WATCH_INTERVAL);
        loop {
            ticker.tick().await;
            let Ok(hq_root) = resolve_hq_folder_path() else {
                continue;
            };
            for created in scan_once(&hq_root).await {
                if let Err(e) = app.emit(EVENT_PROJECT_CREATED, &created) {
                    log(LOG_TAG, &format!("PROJECT_CREATED_EMIT_FAILED {e}"));
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::agent_session::registry::LiveSession;
    use hq_desktop_core::agent_session::types::{PermissionMode, SessionSpec, SessionTool};

    use crate::commands::agent_session::{now_iso, test_registry};

    fn project(root: &std::path::Path, company: &str, slug: &str) {
        let dir = root.join("companies").join(company).join("projects").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prd.json"), "{\"name\":\"X\"}").unwrap();
    }

    /// The whole detection path against a real registry and a real tempdir:
    /// a prd.json that appears while a session of that company is live is
    /// reported ONCE, the session is bound in the registry and on disk, and a
    /// project that already existed when the session started never fires.
    #[tokio::test]
    async fn a_new_prd_json_binds_the_live_session_and_is_reported_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        // Isolate this test's company so parallel tests sharing the process
        // registry cannot see each other's sessions.
        let company = format!("co-{}", uuid::Uuid::new_v4().simple());
        project(&root, &company, "existing");

        let session_id = format!("watch-{}", uuid::Uuid::new_v4());
        let spec = SessionSpec {
            session_id: session_id.clone(),
            tool: SessionTool::Claude,
            cwd: "/hq".into(),
            company: Some(company.clone()),
            project: None,
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionMode::Prompt,
        };
        test_registry()
            .lock()
            .await
            .registry
            .insert(LiveSession::new(spec, now_iso()))
            .expect("insert");
        let meta_dir = root.join("workspace/sessions").join(&session_id);
        std::fs::create_dir_all(&meta_dir).unwrap();
        std::fs::write(
            meta_dir.join("meta.yaml"),
            format!("company_slug: {company}\ntool: claude\n"),
        )
        .unwrap();

        // First scan seeds: `existing` is not a creation.
        assert!(scan_once(&root).await.is_empty());

        // The agent's /plan lands a new project.
        project(&root, &company, "draft");
        let created = scan_once(&root).await;
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].session_id, session_id);
        assert_eq!(created[0].company, company);
        assert_eq!(created[0].project, "draft");
        assert!(created[0].project_path.ends_with("projects/draft"));

        // Bound in the registry and on disk.
        let bound = live_session_summaries()
            .await
            .into_iter()
            .find(|s| s.session_id == session_id)
            .expect("still live");
        assert_eq!(bound.project.as_deref(), Some("draft"));
        let raw = std::fs::read_to_string(meta_dir.join("meta.yaml")).unwrap();
        assert!(raw.contains("project: draft"), "{raw}");
        assert!(raw.contains(&format!("company_slug: {company}")), "{raw}");

        // Once.
        assert!(scan_once(&root).await.is_empty());

        test_registry().lock().await.registry.remove(&session_id);
        // With the session gone the company is no longer watched, so a project
        // created now is nobody's — no event, no phantom binding.
        project(&root, &company, "later");
        assert!(scan_once(&root).await.is_empty());
    }

    #[test]
    fn the_cache_forgets_on_invalidation() {
        let key = format!("cache-{}", uuid::Uuid::new_v4().simple());
        assert!(cached(&key).is_none());
        remember(&key, &[]);
        assert_eq!(cached(&key), Some(Vec::new()));
        invalidate_links_cache();
        assert!(cached(&key).is_none());
    }
}
