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
//!   `/deep-plan`, `/prd` write one) notifies sessions already explicitly bound
//!   to that project via [`EVENT_PROJECT_CREATED`], which the
//!   Sessions page turns into an "offer a channel" card. Creating the channel
//!   is outward-facing and stays behind the operator's explicit confirm in
//!   `session_share_to_channel`; nothing here posts anything.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hq_desktop_core::agent_session::types::SessionPhase;
use hq_desktop_core::hq_context::projects::{
    find_company_project, list_company_projects, ProjectEntry,
};
use hq_desktop_core::session_links::{
    join_project_links, merge_session_rows, project_matches, project_slug,
    read_recent_session_rows, scan_project_slugs, session_row_from_summary, sessions_for_project,
    ChannelRow, LinkedSession, ProjectCreated, ProjectLink, ProjectWatch, SessionRow, MAX_DISK_SESSIONS,
    MAX_SESSIONS_PER_PROJECT,
};
use hq_desktop_core::sessions::{AgentSession, AgentTool};
use hq_desktop_core::workspaces::resolve_hq_folder_path;
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::agent_session::live_session_summaries;
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
            log(
                LOG_TAG,
                &format!("LINKS_CHANNELS_UNAVAILABLE company={company} {e}"),
            );
            Vec::new()
        }
    }
}

/// Workspace session metadata owns the HQ company/project association, while
/// the provider catalog owns the native tool, title and timestamps. Join those
/// by the native id so older sparse `meta.yaml` files do not turn Codex rows
/// into anonymous "Claude session" links.
fn enrich_project_session_rows(rows: &mut [SessionRow], observed: &[AgentSession]) {
    let observed_by_id: HashMap<&str, &AgentSession> = observed
        .iter()
        .map(|session| (session.id.as_str(), session))
        .collect();
    for row in rows {
        let Some(session) = observed_by_id.get(row.session_id.as_str()) else {
            continue;
        };
        row.tool = match session.tool {
            AgentTool::Claude => "claude",
            AgentTool::Codex => "codex",
        }
        .to_string();
        if !session.title.trim().is_empty() {
            row.title = Some(session.title.trim().to_string());
        }
        if !session.started_at.trim().is_empty() {
            row.started_at = session.started_at.trim().to_string();
        }
    }
}

/// Add the local PRD for every visible project channel, even when that PRD is
/// outside the project picker's bounded recent list. The channel list is the
/// source of truth for sidebar decoration; the picker cap is only a picker
/// performance concern.
fn include_channel_backed_projects(
    hq_root: &std::path::Path,
    company: &str,
    projects: &mut Vec<ProjectEntry>,
    channels: &[ChannelRow],
) {
    for channel in channels {
        let Some(project_id) = channel
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if projects
            .iter()
            .any(|entry| project_matches(project_id, &project_slug(&entry.path), &entry.name))
        {
            continue;
        }
        if let Some(project) = find_company_project(hq_root, company, project_id) {
            projects.push(project);
        }
    }
}

async fn build_links(company: &str) -> Result<Vec<ProjectLink>, String> {
    let hq_root = resolve_hq_folder_path()?;
    let channels = company_channels(&hq_root, company).await;
    let root = hq_root.clone();
    let co = company.to_string();
    let channel_rows = channels.clone();
    let projects = tokio::task::spawn_blocking(move || {
        let mut projects = list_company_projects(&root, &co);
        include_channel_backed_projects(&root, &co, &mut projects, &channel_rows);
        projects
    }).await.map_err(|e| e.to_string())?;
    let sessions = linked_session_rows(&hq_root).await?;
    let mut links = join_project_links(company, &projects, &sessions, &channels);
    // Membership in a project chat is enough to discover its shared sessions;
    // teammates need not have downloaded a local PRD first.
    for channel in &channels {
        let Some(project) = channel.project_id.as_deref().filter(|id| !id.trim().is_empty()) else { continue; };
        if links.iter().any(|link| link.channel_id.as_deref() == Some(&channel.channel_id)) { continue; }
        links.push(ProjectLink { project: project.into(), project_name: channel.name.clone(), project_path: String::new(),
            channel_id: Some(channel.channel_id.clone()), channel_name: Some(channel.name.clone()), sessions: vec![] });
    }
    Ok(links)
}

/// All companies share one metadata scan. Blocking filesystem work stays off
/// the async runtime; the mutex coalesces simultaneous startup requests.
async fn linked_session_rows(hq_root: &std::path::Path) -> Result<Vec<SessionRow>, String> {
    type DiskCache = Option<(std::path::PathBuf, Instant, Vec<SessionRow>)>;
    static DISK: OnceLock<tokio::sync::Mutex<DiskCache>> = OnceLock::new();
    let mut cached = DISK.get_or_init(|| tokio::sync::Mutex::new(None)).lock().await;
    if !cached.as_ref().is_some_and(|(root, at, _)| root == hq_root && at.elapsed() < Duration::from_secs(1)) {
        let root = hq_root.to_path_buf();
        let rows = tokio::task::spawn_blocking(move || read_recent_session_rows(&root, MAX_DISK_SESSIONS))
            .await.map_err(|e| e.to_string())?;
        *cached = Some((hq_root.to_path_buf(), Instant::now(), rows));
    }
    let mut disk = cached.as_ref().unwrap().2.clone();
    drop(cached);
    // The existing provider poller owns discovery. Do not scan every provider
    // transcript (and audit history) again for each company's sidebar links.
    enrich_project_session_rows(&mut disk, &crate::commands::sessions::cached_agent_sessions());
    let live: Vec<_> = live_session_summaries()
        .await
        .iter()
        .map(session_row_from_summary)
        .collect();
    Ok(merge_session_rows(live, disk))
}

/// First paint needs only durable bindings, not PRD contents or a cloud call.
/// The sidebar already knows each visible channel's projectId and can match it.
fn local_links_from_rows(hq_root: &std::path::Path, company: &str, rows: &[SessionRow]) -> Vec<ProjectLink> {
    let mut links: Vec<ProjectLink> = Vec::new();
    for row in rows.iter().filter(|r| r.company.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(company))) {
        let Some(project) = row.project.as_deref().map(str::trim).filter(|p| !p.is_empty()) else { continue; };
        let index = links.iter().position(|link| link.project.eq_ignore_ascii_case(project))
            .unwrap_or_else(|| {
                links.push(ProjectLink {
                    project: project.to_string(), project_name: project.to_string(),
                    project_path: hq_root.join("companies").join(company).join("projects").join(project).to_string_lossy().into_owned(),
                    channel_id: None, channel_name: None, sessions: Vec::new(),
                });
                links.len() - 1
            });
        links[index].sessions.push(LinkedSession {
            channel_id: None,
            session_id: row.session_id.clone(), tool: row.tool.clone(), phase: row.phase.clone(),
            started_at: row.started_at.clone(), title: row.title.clone(),
        });
    }
    for link in &mut links {
        link.sessions.sort_by(|a, b| (b.phase != "ended").cmp(&(a.phase != "ended"))
            .then_with(|| b.started_at.cmp(&a.started_at))
            .then_with(|| a.session_id.cmp(&b.session_id)));
        link.sessions.truncate(MAX_SESSIONS_PER_PROJECT);
    }
    links
}

/// Every project of `company` with its channel and its sessions.
#[tauri::command]
pub async fn session_project_links(app: AppHandle, company: String, local_only: Option<bool>) -> Result<Vec<ProjectLink>, String> {
    let company = company.trim().to_string();
    if company.is_empty() {
        return Err("company must not be empty".to_string());
    }
    if local_only.unwrap_or(false) {
        let started = Instant::now();
        let root = resolve_hq_folder_path()?;
        let rows = linked_session_rows(&root).await?;
        let mut links = local_links_from_rows(&root, &company, &rows);
        super::project_session_sharing::attach_channel_bindings(&app, &mut links).await;
        if !links.is_empty() {
            log(LOG_TAG, &format!("LOCAL_LINKS_READY company={company} projects={} elapsed_ms={}", links.len(), started.elapsed().as_millis()));
        }
        return Ok(links);
    }
    if let Some(mut links) = cached(&company) {
        super::project_session_sharing::attach_channel_bindings(&app, &mut links).await;
        return Ok(links);
    }
    let mut links = build_links(&company).await?;
    super::project_session_sharing::attach_channel_bindings(&app, &mut links).await;
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
/// appeared since the last scan and notify already-associated sessions.
/// Observation never mutates session ownership. The caller emits.
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

    if !fresh.is_empty() {
        invalidate_links_cache();
    }
    let mut created = Vec::new();
    for (company, slug) in fresh {
        let project_path = hq_root
            .join("companies")
            .join(&company)
            .join("projects")
            .join(&slug)
            .to_string_lossy()
            .into_owned();
        for target in sessions_for_project(&summaries, &company, &slug) {
            created.push(ProjectCreated {
                session_id: target.session_id.clone(),
                company: company.clone(),
                project: slug.clone(),
                project_path: project_path.clone(),
            });
        }
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
    use hq_desktop_core::sessions::{AgentOrigin, AgentSession, AgentTool, SessionStatus};

    use crate::commands::agent_session::{now_iso, test_registry};

    fn project(root: &std::path::Path, company: &str, slug: &str) {
        let dir = root
            .join("companies")
            .join(company)
            .join("projects")
            .join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prd.json"), "{\"name\":\"X\"}").unwrap();
    }

    #[test]
    fn first_paint_uses_bindings_without_project_files_or_provider_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let row = SessionRow {
            session_id: "native-1".into(), workspace_session_id: Some("app-1".into()),
            provider_session_id: None, tool: "codex".into(), phase: "ended".into(),
            started_at: "2026-09-04T22:07:52Z".into(), title: Some("Describe project".into()),
            company: Some("indigo".into()), project: Some("feedback".into()),
        };
        let mut other = row.clone();
        other.session_id = "another-company".into();
        other.workspace_session_id = Some("another-app".into());
        other.company = Some("ridge".into());
        let rows = merge_session_rows(Vec::new(), vec![row, other]);
        let links = local_links_from_rows(dir.path(), "indigo", &rows);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].project, "feedback");
        assert_eq!(links[0].sessions.len(), 1);
        assert_eq!(links[0].sessions[0].session_id, "native-1");
        assert_eq!(links[0].sessions[0].title.as_deref(), Some("Describe project"));
        assert!(links[0].channel_id.is_none());
        assert!(!dir.path().join("companies").exists());
    }

    #[test]
    fn provider_history_enriches_sparse_project_metadata_without_rebinding_it() {
        let mut rows = vec![hq_desktop_core::session_links::SessionRow {
            session_id: "native-1".into(),
            workspace_session_id: Some("app-1".into()),
            provider_session_id: None,
            tool: "claude".into(),
            phase: "ended".into(),
            started_at: "2026-09-02T20:00:00Z".into(),
            title: None,
            company: Some("indigo".into()),
            project: Some("agent-reply-targeting".into()),
        }];
        let observed = vec![AgentSession {
            id: "native-1".into(),
            tool: AgentTool::Codex,
            origin: AgentOrigin::Local,
            title: "Target agent replies".into(),
            cwd: "/Users/x/HQ".into(),
            project: String::new(),
            company: String::new(),
            model: "gpt-5.6-sol".into(),
            status: SessionStatus::Ended,
            started_at: "2026-09-02T22:23:32Z".into(),
            last_activity_at: "2026-09-02T22:30:00Z".into(),
            source: "codex-rollout".into(),
            remote_control_session_id: None,
        }];

        enrich_project_session_rows(&mut rows, &observed);

        assert_eq!(rows[0].tool, "codex");
        assert_eq!(rows[0].title.as_deref(), Some("Target agent replies"));
        assert_eq!(rows[0].started_at, "2026-09-02T22:23:32Z");
        assert_eq!(rows[0].company.as_deref(), Some("indigo"));
        assert_eq!(rows[0].project.as_deref(), Some("agent-reply-targeting"));
    }

    #[test]
    fn visible_project_channels_pull_their_prd_outside_the_picker_feed() {
        let dir = tempfile::tempdir().expect("tempdir");
        project(dir.path(), "indigo", "old-project-channel");
        let mut projects = Vec::new();
        let channels = vec![ChannelRow {
            channel_id: "chn_old".into(),
            name: "old-project-channel".into(),
            project_id: Some("old-project-channel".into()),
        }];

        include_channel_backed_projects(dir.path(), "indigo", &mut projects, &channels);

        assert_eq!(projects.len(), 1);
        assert_eq!(project_slug(&projects[0].path), "old-project-channel");
        let links = join_project_links("indigo", &projects, &[], &channels);
        assert_eq!(links[0].channel_id.as_deref(), Some("chn_old"));
    }

    /// Discovery is not ownership: synced/other-session PRDs must never
    /// bind an unscoped session or overwrite an explicit project selection.
    #[tokio::test]
    async fn project_discovery_preserves_explicit_and_unbound_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        // Isolate this test's company so parallel tests sharing the process
        // registry cannot see each other's sessions.
        let company = format!("co-{}", uuid::Uuid::new_v4().simple());
        project(&root, &company, "existing");

        let session_id = format!("watch-{}", uuid::Uuid::new_v4());
        let spec = SessionSpec {
            session_id: session_id.clone(),
            title: None,
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

        // A project appeared, but there is no originating-session identity.
        project(&root, &company, "unrelated");
        assert!(scan_once(&root).await.is_empty());
        let raw = std::fs::read_to_string(meta_dir.join("meta.yaml")).unwrap();
        assert!(!raw.contains("project:"), "{raw}");

        // Only an explicit session binding establishes ownership.
        crate::commands::agent_session::bind_session_project(&root, &session_id, "draft")
            .await.unwrap();
        project(&root, &company, "another-session-project");
        assert!(scan_once(&root).await.is_empty());
        let raw = std::fs::read_to_string(meta_dir.join("meta.yaml")).unwrap();
        assert!(raw.contains("project: draft"), "{raw}");

        // The selected project's PRD can offer a channel without rebinding.
        project(&root, &company, "draft");
        let created = scan_once(&root).await;
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].session_id, session_id);
        assert_eq!(created[0].company, company);
        assert_eq!(created[0].project, "draft");
        assert!(std::path::Path::new(&created[0].project_path)
            .ends_with(std::path::Path::new("projects").join("draft")));

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
