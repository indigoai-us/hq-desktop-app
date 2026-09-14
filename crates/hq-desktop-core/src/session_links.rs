//! Project ↔ session ↔ channel links: the pure half of `session_project_links`.
//!
//! Three things describe "work on project X" and none of them knows about the
//! others: a `companies/<co>/projects/<slug>/prd.json`, an agent session bound
//! to `<slug>` (in the live registry, or on disk in
//! `workspace/sessions/<id>/meta.yaml`), and an hq-pro channel — either a real
//! project-scope channel carrying a `projectId`, or a company channel named
//! `p-<slug>` by the share flow. This module joins them.
//!
//! Also here: the watch that notices a NEW project directory appearing while a
//! session is live (HQ's `/plan`, `/deep-plan`, `/prd` skills write
//! `prd.json`), which is what turns "the agent planned a project" into "a
//! channel offer appears in the chat".
//!
//! Pure and synchronous apart from the two small readers, so the join rules
//! are pinned by unit tests rather than by a signed-in desktop.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent_session::registry::SessionSummary;
use crate::agent_session::types::{SessionPhase, SessionTool};
use crate::hq_context::is_skippable_entry_name;
use crate::hq_context::projects::ProjectEntry;
use crate::session_share::{channel_name_matches, project_channel_name};

/// How many `workspace/sessions/*/meta.yaml` files the on-disk reader opens,
/// newest first. A long-lived HQ has thousands; the sidebar needs recent ones.
pub const MAX_DISK_SESSIONS: usize = 200;

/// Sessions listed per project, live ones first.
pub const MAX_SESSIONS_PER_PROJECT: usize = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────────────

/// One session as the sidebar's hover card shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSession {
    pub session_id: String,
    /// Explicit channel enrollment, when this session was created in a chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `claude` | `codex`.
    pub tool: String,
    /// A [`SessionPhase`] tag (`starting` | `idle` | `working` | `needsYou`)
    /// for a live session, `ended` for a finished or on-disk-only one.
    pub phase: String,
    /// ISO-8601 UTC.
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One company project with everything linked to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    /// The project directory slug — the binding key sessions and channels use.
    pub project: String,
    /// The `prd.json` display name (falls back to the slug).
    pub project_name: String,
    /// Absolute project directory.
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    pub sessions: Vec<LinkedSession>,
}

/// One session as the join reads it — from the live registry or from disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    /// HQ's app-owned workspace id when this row came from
    /// `workspace/sessions/<id>/meta.yaml`. The provider-native id remains the
    /// public `session_id` for history hydration, but this alias lets a live
    /// registry row suppress its own durable twin.
    pub workspace_session_id: Option<String>,
    /// Provider-native id advertised directly by a live registry row. This is
    /// distinct from the app-owned workspace id and makes identity resolution
    /// independent of metadata write timing and the disk-history read limit.
    pub provider_session_id: Option<String>,
    pub tool: String,
    pub phase: String,
    pub started_at: String,
    pub title: Option<String>,
    pub company: Option<String>,
    pub project: Option<String>,
}

/// One channel as the join reads it (the subset of hq-pro's channel row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelRow {
    pub channel_id: String,
    pub name: String,
    pub project_id: Option<String>,
}

/// Payload of the `agent-session:project-created` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreated {
    pub session_id: String,
    pub company: String,
    pub project: String,
    pub project_path: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────────────

/// The project directory slug: the last non-empty path component.
pub fn project_slug(path: &str) -> String {
    path.trim()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn norm(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

/// Does a free-text project reference (a session's binding, a channel's
/// `projectId`) name this project? The slug is the canonical key; the prd
/// name is accepted because HQ's own `/startwork <name>` flow stamps names.
pub fn project_matches(reference: &str, slug: &str, name: &str) -> bool {
    let reference = norm(reference);
    if reference.is_empty() {
        return false;
    }
    reference == norm(slug) || (!name.trim().is_empty() && reference == norm(name))
}

/// The channel for a project: its `projectId` when it carries one, else the
/// `p-<slug>` naming convention the share flow uses.
pub fn channel_for_project<'a>(
    channels: &'a [ChannelRow],
    slug: &str,
    name: &str,
) -> Option<&'a ChannelRow> {
    if let Some(by_id) = channels.iter().find(|c| {
        c.project_id
            .as_deref()
            .is_some_and(|id| project_matches(id, slug, name))
    }) {
        return Some(by_id);
    }
    let conventional = project_channel_name(slug)?;
    channels
        .iter()
        .find(|c| channel_name_matches(&c.name, &conventional))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

fn tool_tag(tool: SessionTool) -> &'static str {
    tool.as_str()
}

fn phase_tag(phase: SessionPhase) -> &'static str {
    match phase {
        SessionPhase::Starting => "starting",
        SessionPhase::Idle => "idle",
        SessionPhase::Working => "working",
        SessionPhase::NeedsYou => "needsYou",
        SessionPhase::Ended => "ended",
    }
}

/// A live registry summary as a join row.
pub fn session_row_from_summary(summary: &SessionSummary) -> SessionRow {
    SessionRow {
        session_id: summary.session_id.clone(),
        workspace_session_id: Some(summary.session_id.clone()),
        provider_session_id: summary.cli_session_id.clone(),
        tool: tool_tag(summary.tool).to_string(),
        phase: phase_tag(summary.phase).to_string(),
        started_at: summary.started_at.clone(),
        title: (!summary.title.trim().is_empty()).then(|| summary.title.trim().to_string()),
        company: summary.company.clone(),
        project: summary.project.clone(),
    }
}

/// The subset of `workspace/sessions/<id>/meta.yaml` the join needs.
#[derive(Debug, Default, Deserialize)]
struct DiskMeta {
    #[serde(default)]
    company_slug: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    title: Option<String>,
    /// Provider-native Claude/Codex identifier used to hydrate and resume the
    /// transcript. The enclosing workspace directory is only HQ's local
    /// bookkeeping id and is not necessarily understood by either provider.
    #[serde(default)]
    cli_session_id: Option<String>,
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The newest `limit` on-disk sessions that carry a `project`, as `ended`
/// rows. Sessions without a project binding are skipped — they cannot link
/// to anything, and reading them would only cost time.
pub fn read_recent_session_rows(hq_root: &Path, limit: usize) -> Vec<SessionRow> {
    let dir = hq_root.join("workspace").join("sessions");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<(std::time::SystemTime, String, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) {
            continue;
        }
        let meta = entry.path().join("meta.yaml");
        let Ok(metadata) = std::fs::metadata(&meta) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        candidates.push((modified, name, meta));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates.truncate(limit);

    candidates
        .into_iter()
        .filter_map(|(_, workspace_session_id, meta)| {
            let raw = std::fs::read_to_string(meta).ok()?;
            let parsed: DiskMeta = serde_yaml::from_str(&raw).ok()?;
            let project = clean(parsed.project)?;
            Some(SessionRow {
                session_id: clean(parsed.cli_session_id)
                    .unwrap_or_else(|| workspace_session_id.clone()),
                workspace_session_id: Some(workspace_session_id),
                provider_session_id: None,
                tool: clean(parsed.tool)
                    .map(|t| t.to_ascii_lowercase())
                    .unwrap_or_else(|| "claude".to_string()),
                phase: "ended".to_string(),
                started_at: clean(parsed.started_at).unwrap_or_default(),
                title: clean(parsed.title),
                company: clean(parsed.company_slug),
                project: Some(project),
            })
        })
        .collect()
}

/// Return the root of one row's identity component, compressing the path.
fn identity_root(parents: &mut [usize], index: usize) -> usize {
    if parents[index] != index {
        parents[index] = identity_root(parents, parents[index]);
    }
    parents[index]
}

fn union_identities(parents: &mut [usize], left: usize, right: usize) {
    let left_root = identity_root(parents, left);
    let right_root = identity_root(parents, right);
    if left_root == right_root {
        return;
    }
    // Keep the earliest row as the root so component order stays live-first
    // and otherwise follows the disk reader's stable newest-first order.
    let (root, child) = if left_root < right_root {
        (left_root, right_root)
    } else {
        (right_root, left_root)
    };
    parents[child] = root;
}

/// Combine all representations of one conversation after its identity graph
/// has been resolved. Active registry rows keep their app-owned id because it
/// owns the live event stream. Once ended, a provider-native id wins because
/// that is the id the history reader can hydrate.
fn merge_identity_component(mut rows: Vec<SessionRow>) -> SessionRow {
    let mut merged = rows.remove(0);
    for row in rows {
        if merged.phase == "ended"
            && row.phase == "ended"
            && merged.session_id != row.session_id
        {
            let existing = merged;
            merged = row;
            if merged.title.is_none() {
                merged.title = existing.title;
            }
            if merged.started_at.is_empty() {
                merged.started_at = existing.started_at;
            }
            continue;
        }
        if merged.title.is_none() && row.title.is_some() {
            merged.title = row.title;
        }
        if merged.started_at.is_empty() && !row.started_at.is_empty() {
            merged.started_at = row.started_at;
        }
    }
    merged
}

/// Live rows win over their on-disk twins. A workspace session normally has
/// two ids: the app-owned registry id and the provider-native Claude/Codex id
/// used to hydrate history. Disk mtimes are independent, so the provider
/// shadow can arrive before the app-owned bridge row. Resolve the complete
/// identity graph first; a streaming `seen` map cannot coalesce two components
/// after a later row reveals that they are the same conversation.
pub fn merge_session_rows(live: Vec<SessionRow>, disk: Vec<SessionRow>) -> Vec<SessionRow> {
    let mut rows = live;
    rows.extend(disk);
    if rows.is_empty() {
        return rows;
    }

    let mut parents: Vec<usize> = (0..rows.len()).collect();
    let mut owner_by_alias: HashMap<String, usize> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let aliases = std::iter::once(&row.session_id)
            .chain(row.workspace_session_id.iter())
            .chain(row.provider_session_id.iter());
        for alias in aliases {
            if let Some(owner) = owner_by_alias.get(alias).copied() {
                union_identities(&mut parents, owner, index);
            } else {
                owner_by_alias.insert(alias.clone(), index);
            }
        }
    }

    let mut components: HashMap<usize, Vec<SessionRow>> = HashMap::new();
    for (index, row) in rows.into_iter().enumerate() {
        let root = identity_root(&mut parents, index);
        components.entry(root).or_default().push(row);
    }

    let mut components: Vec<(usize, Vec<SessionRow>)> = components.into_iter().collect();
    components.sort_by_key(|(root, _)| *root);
    components
        .into_iter()
        .map(|(_, rows)| merge_identity_component(rows))
        .collect()
}

/// Live first (anything not `ended`), then newest start first.
fn sort_sessions(sessions: &mut [LinkedSession]) {
    sessions.sort_by(|a, b| {
        let live_a = a.phase != "ended";
        let live_b = b.phase != "ended";
        live_b
            .cmp(&live_a)
            .then_with(|| b.started_at.cmp(&a.started_at))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
}

/// The join: every project of the company, each with its channel (when one
/// is visible) and the sessions bound to it. A session belongs to a project
/// when its binding names the slug (or the prd name); a session bound to a
/// different company never links here even if the slugs collide.
pub fn join_project_links(
    company: &str,
    projects: &[ProjectEntry],
    sessions: &[SessionRow],
    channels: &[ChannelRow],
) -> Vec<ProjectLink> {
    let company = norm(company);
    projects
        .iter()
        .map(|entry| {
            let slug = project_slug(&entry.path);
            let name = entry.name.clone();
            let channel = channel_for_project(channels, &slug, &name);
            let mut linked: Vec<LinkedSession> = sessions
                .iter()
                .filter(|row| {
                    row.company
                        .as_deref()
                        .is_some_and(|row_company| norm(row_company) == company)
                })
                .filter(|row| {
                    row.project
                        .as_deref()
                        .is_some_and(|p| project_matches(p, &slug, &name))
                })
                .map(|row| LinkedSession {
                    session_id: row.session_id.clone(),
                    channel_id: None,
                    tool: row.tool.clone(),
                    phase: row.phase.clone(),
                    started_at: row.started_at.clone(),
                    title: row.title.clone(),
                })
                .collect();
            sort_sessions(&mut linked);
            linked.truncate(MAX_SESSIONS_PER_PROJECT);
            ProjectLink {
                project: slug,
                project_name: name,
                project_path: entry.path.clone(),
                channel_id: channel.map(|c| c.channel_id.clone()),
                channel_name: channel.map(|c| c.name.clone()),
                sessions: linked,
            }
        })
        .collect()
}

/// Filesystem discovery carries no originating session identity. Notify only
/// sessions already explicitly associated with this company and project;
/// neither recency nor being unbound establishes ownership.
pub fn sessions_for_project<'a>(
    summaries: &'a [SessionSummary],
    company: &str,
    project: &str,
) -> Vec<&'a SessionSummary> {
    let company = norm(company);
    summaries
        .iter()
        .filter(|s| s.phase != SessionPhase::Ended)
        .filter(|s| s.company.as_deref().map(norm) == Some(company.clone()))
        .filter(|s| s.project.as_deref().is_some_and(|p| project_matches(p, project, "")))
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// New-project watch
// ─────────────────────────────────────────────────────────────────────────────

/// The project directory slugs of a company that carry a `prd.json`.
pub fn scan_project_slugs(hq_root: &Path, company: &str) -> BTreeSet<String> {
    let company = company.trim();
    let mut out = BTreeSet::new();
    if company.is_empty() {
        return out;
    }
    let dir = hq_root.join("companies").join(company).join("projects");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) {
            continue;
        }
        if entry.path().join("prd.json").is_file() {
            out.insert(name);
        }
    }
    out
}

/// Remembers which projects each watched company had, so a later scan can
/// name the ones that are NEW.
///
/// The first observation of a company seeds silently: the projects that
/// already existed when a session started are not creations. A company that
/// stops being observed (no live session) is forgotten with [`Self::retain`],
/// so its next observation seeds again rather than replaying everything that
/// happened while nobody was watching.
#[derive(Debug, Default)]
pub struct ProjectWatch {
    seen: HashMap<String, BTreeSet<String>>,
}

impl ProjectWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `current` for `company`; returns the slugs not seen before.
    pub fn observe(&mut self, company: &str, current: BTreeSet<String>) -> Vec<String> {
        let key = company.trim().to_string();
        match self.seen.get_mut(&key) {
            None => {
                self.seen.insert(key, current);
                Vec::new()
            }
            Some(known) => {
                let fresh: Vec<String> = current.difference(known).cloned().collect();
                *known = current;
                fresh
            }
        }
    }

    /// Keep only the companies still worth watching.
    pub fn retain(&mut self, companies: &BTreeSet<String>) {
        self.seen.retain(|key, _| companies.contains(key));
    }

    pub fn is_watching(&self, company: &str) -> bool {
        self.seen.contains_key(company.trim())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::types::PermissionMode;
    use crate::hq_context::projects::{ProjectStatus, StoryCounts};
    use std::fs;

    fn entry(path: &str, name: &str) -> ProjectEntry {
        ProjectEntry {
            name: name.into(),
            description: String::new(),
            branch_name: None,
            path: path.into(),
            story_counts: StoryCounts::default(),
            updated_at: None,
            last_activity_at: None,
            owner: None,
            status: ProjectStatus::Active,
        }
    }

    fn row(
        id: &str,
        phase: &str,
        started: &str,
        company: &str,
        project: Option<&str>,
    ) -> SessionRow {
        SessionRow {
            session_id: id.into(),
            workspace_session_id: Some(id.into()),
            provider_session_id: None,
            tool: "claude".into(),
            phase: phase.into(),
            started_at: started.into(),
            title: None,
            company: Some(company.into()),
            project: project.map(str::to_owned),
        }
    }

    fn chan(id: &str, name: &str, project_id: Option<&str>) -> ChannelRow {
        ChannelRow {
            channel_id: id.into(),
            name: name.into(),
            project_id: project_id.map(str::to_owned),
        }
    }

    fn summary(id: &str, phase: SessionPhase, company: &str, active: &str) -> SessionSummary {
        SessionSummary {
            session_id: id.into(),
            cli_session_id: None,
            title: id.into(),
            tool: SessionTool::Claude,
            phase,
            company: Some(company.into()),
            project: None,
            model: None,
            requested_model: None,
            effort: None,
            permission_mode: PermissionMode::Prompt,
            cwd: "/hq".into(),
            started_at: "2026-09-01T00:00:00Z".into(),
            last_activity_at: active.into(),
            last_seq: 0,
            pending_count: 0,
            resumed_from: None,
            history_before: None,
        }
    }

    #[test]
    fn the_project_slug_is_the_directory_leaf() {
        assert_eq!(
            project_slug("/hq/companies/indigo/projects/launch"),
            "launch"
        );
        assert_eq!(
            project_slug("/hq/companies/indigo/projects/launch/"),
            "launch"
        );
        assert_eq!(project_slug("C:\\hq\\projects\\Launch Q3\\"), "Launch Q3");
        assert_eq!(project_slug("   "), "");
    }

    #[test]
    fn a_channel_links_by_project_id_first_then_by_the_p_slug_convention() {
        let channels = vec![
            chan("ch_general", "general", None),
            chan("ch_conv", "p-launch", None),
            chan("ch_bound", "Launch chat", Some("launch")),
        ];
        // The bound project-scope channel wins over the conventionally named one.
        assert_eq!(
            channel_for_project(&channels, "launch", "Launch").map(|c| c.channel_id.as_str()),
            Some("ch_bound")
        );
        // No bound channel → `p-<slug>`, case-insensitive, `#` ignored.
        let channels = vec![
            chan("ch_general", "general", None),
            chan("ch_conv", "#P-Launch", None),
        ];
        assert_eq!(
            channel_for_project(&channels, "launch", "Launch").map(|c| c.channel_id.as_str()),
            Some("ch_conv")
        );
        // A projectId naming the prd NAME (not the slug) still binds.
        let channels = vec![chan("ch_named", "whatever", Some("Launch Q3"))];
        assert_eq!(
            channel_for_project(&channels, "launch-q3", "Launch Q3").map(|c| c.channel_id.as_str()),
            Some("ch_named")
        );
        // Nothing matches → no channel (never a wrong one).
        assert!(channel_for_project(&channels, "other", "Other").is_none());
    }

    #[test]
    fn the_join_lists_every_project_with_its_channel_and_its_sessions_live_first() {
        let projects = vec![
            entry("/hq/companies/indigo/projects/launch", "Launch"),
            entry("/hq/companies/indigo/projects/onboarding", "Onboarding"),
        ];
        let sessions = vec![
            row(
                "s-old",
                "ended",
                "2026-09-01T10:00:00Z",
                "indigo",
                Some("launch"),
            ),
            row(
                "s-live",
                "working",
                "2026-09-01T09:00:00Z",
                "indigo",
                Some("launch"),
            ),
            row(
                "s-by-name",
                "ended",
                "2026-09-01T11:00:00Z",
                "indigo",
                Some("Launch"),
            ),
            // Same slug, different company: never links here.
            row(
                "s-other-co",
                "idle",
                "2026-09-01T12:00:00Z",
                "ridge",
                Some("launch"),
            ),
            // Missing tenant identity is not permission to borrow the active
            // company's project association.
            SessionRow {
                session_id: "s-no-company".into(),
                workspace_session_id: Some("s-no-company".into()),
                provider_session_id: None,
                tool: "codex".into(),
                phase: "ended".into(),
                started_at: "2026-09-01T13:00:00Z".into(),
                title: None,
                company: None,
                project: Some("launch".into()),
            },
            // No binding at all.
            row("s-none", "idle", "2026-09-01T12:00:00Z", "indigo", None),
        ];
        let channels = vec![chan("ch_launch", "p-launch", None)];

        let links = join_project_links("indigo", &projects, &sessions, &channels);
        assert_eq!(links.len(), 2, "every project is listed, linked or not");

        let launch = &links[0];
        assert_eq!(launch.project, "launch");
        assert_eq!(launch.project_name, "Launch");
        assert_eq!(launch.channel_id.as_deref(), Some("ch_launch"));
        assert_eq!(launch.channel_name.as_deref(), Some("p-launch"));
        let ids: Vec<&str> = launch
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        // Live first, then newest start first.
        assert_eq!(ids, vec!["s-live", "s-by-name", "s-old"]);

        let onboarding = &links[1];
        assert!(onboarding.channel_id.is_none());
        assert!(onboarding.sessions.is_empty());

        // Wire shape: camelCase, channel keys omitted when absent.
        let raw = serde_json::to_value(onboarding).expect("serialize");
        assert_eq!(raw["projectName"], "Onboarding");
        assert_eq!(
            raw["projectPath"],
            "/hq/companies/indigo/projects/onboarding"
        );
        assert!(raw.get("channelId").is_none());
        let raw = serde_json::to_value(&launch.sessions[0]).expect("serialize");
        assert_eq!(raw["sessionId"], "s-live");
        assert_eq!(raw["startedAt"], "2026-09-01T09:00:00Z");
        assert!(raw.get("title").is_none());
    }

    #[test]
    fn live_rows_win_over_their_on_disk_twins() {
        let live = vec![row("s1", "working", "t1", "indigo", Some("launch"))];
        let disk = vec![
            row("s1", "ended", "t1", "indigo", Some("launch")),
            row("s2", "ended", "t0", "indigo", Some("launch")),
        ];
        let merged = merge_session_rows(live, disk);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].phase, "working");
        assert_eq!(merged[1].session_id, "s2");
    }

    #[test]
    fn live_project_rows_keep_the_conversation_title() {
        let summary = summary(
            "Plan the workspace launch",
            SessionPhase::Working,
            "indigo",
            "2026-09-03T23:40:00Z",
        );

        let row = session_row_from_summary(&summary);

        assert_eq!(row.title.as_deref(), Some("Plan the workspace launch"));
    }

    #[test]
    fn live_app_row_suppresses_its_provider_native_disk_twin() {
        let live = vec![row(
            "app-owned-id",
            "idle",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        )];
        let mut disk_twin = row(
            "native-codex-id",
            "ended",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        );
        disk_twin.workspace_session_id = Some("app-owned-id".into());

        let merged = merge_session_rows(live, vec![disk_twin]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].session_id, "app-owned-id");
        assert_eq!(merged[0].phase, "idle");
    }

    #[test]
    fn live_provider_alias_suppresses_a_shadow_without_a_disk_bridge() {
        let mut live_summary = summary(
            "app-owned-id",
            SessionPhase::Working,
            "indigo",
            "2026-09-04T18:10:39Z",
        );
        live_summary.cli_session_id = Some("native-codex-id".into());
        live_summary.project = Some("launch".into());
        let live = vec![session_row_from_summary(&live_summary)];

        let provider_shadow = row(
            "native-codex-id",
            "ended",
            "2026-09-04T18:10:53Z",
            "indigo",
            Some("launch"),
        );

        let merged = merge_session_rows(live, vec![provider_shadow]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].session_id, "app-owned-id");
        assert_eq!(merged[0].phase, "working");
    }

    #[test]
    fn duplicate_aliases_form_one_identity_set_regardless_of_disk_order() {
        let live = vec![row(
            "app-owned-id",
            "working",
            "2026-09-04T18:10:39Z",
            "indigo",
            Some("launch"),
        )];
        let mut app_meta = row(
            "native-codex-id",
            "ended",
            "2026-09-04T18:10:39Z",
            "indigo",
            Some("launch"),
        );
        app_meta.workspace_session_id = Some("app-owned-id".into());
        app_meta.title = Some("hey".into());
        let mut provider_shadow = row(
            "native-codex-id",
            "ended",
            "2026-09-04T18:10:53Z",
            "indigo",
            Some("launch"),
        );
        provider_shadow.workspace_session_id = Some("native-codex-id".into());

        // The provider catalog rewrites its native shadow independently of
        // HQ's app-owned metadata, so either file may be newest. Identity
        // merging must be invariant to the reader's mtime ordering.
        for disk in [
            vec![app_meta.clone(), provider_shadow.clone()],
            vec![provider_shadow, app_meta],
        ] {
            let merged = merge_session_rows(live.clone(), disk);

            assert_eq!(merged.len(), 1);
            assert_eq!(merged[0].session_id, "app-owned-id");
            assert_eq!(merged[0].title.as_deref(), Some("hey"));
        }
    }

    #[test]
    fn a_duplicate_durable_alias_can_supply_a_missing_title() {
        let mut sparse = row(
            "native-codex-id",
            "ended",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        );
        sparse.workspace_session_id = Some("native-codex-id".into());
        let mut titled = row(
            "native-codex-id",
            "ended",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        );
        titled.workspace_session_id = Some("app-owned-id".into());
        titled.title = Some("Plan the launch".into());

        let merged = merge_session_rows(vec![], vec![sparse, titled]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].title.as_deref(), Some("Plan the launch"));
    }

    #[test]
    fn an_ended_registry_row_yields_to_its_provider_native_history_id() {
        let mut ended = row(
            "app-owned-id",
            "ended",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        );
        ended.workspace_session_id = Some("app-owned-id".into());
        ended.title = Some("Inspect the launch".into());
        let mut durable = row(
            "native-codex-id",
            "ended",
            "2026-09-03T23:40:00Z",
            "indigo",
            Some("launch"),
        );
        durable.workspace_session_id = Some("app-owned-id".into());

        let merged = merge_session_rows(vec![ended], vec![durable]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].session_id, "native-codex-id");
        assert_eq!(merged[0].title.as_deref(), Some("Inspect the launch"));
    }

    #[test]
    fn on_disk_sessions_are_read_newest_first_and_only_when_bound() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let write = |id: &str, body: &str, mtime: u64| {
            let d = root.join("workspace/sessions").join(id);
            fs::create_dir_all(&d).unwrap();
            let p = d.join("meta.yaml");
            fs::write(&p, body).unwrap();
            crate::hq_context::set_mtime(&p, mtime);
        };
        write(
            "s-old",
            "company_slug: indigo\nproject: launch\ntool: codex\nstarted_at: 2026-09-01T00:00:00Z\n",
            1_000,
        );
        write(
            "s-new",
            "company_slug: indigo\nproject: launch\nstarted_at: 2026-09-02T00:00:00Z\n",
            2_000,
        );
        write(
            "s-unbound",
            "company_slug: indigo\nstarted_at: 2026-09-03T00:00:00Z\n",
            3_000,
        );
        write("s-blank", "company_slug: indigo\nproject: '  '\n", 4_000);
        // Scaffold noise is skipped without being opened.
        write(".DS_Store-ish", "project: launch\n", 5_000);

        let rows = read_recent_session_rows(root, 10);
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["s-new", "s-old"]);
        assert_eq!(rows[0].phase, "ended");
        assert_eq!(rows[0].tool, "claude", "missing tool defaults to claude");
        assert_eq!(rows[1].tool, "codex");
        assert_eq!(rows[0].company.as_deref(), Some("indigo"));
        assert_eq!(rows[0].project.as_deref(), Some("launch"));

        // The limit bounds the FILES OPENED (newest first), not the rows kept.
        let rows = read_recent_session_rows(root, 2);
        assert!(
            rows.is_empty(),
            "the two newest metas are unbound: {rows:?}"
        );
        assert!(read_recent_session_rows(&root.join("nowhere"), 10).is_empty());
    }

    #[test]
    fn on_disk_session_links_use_the_provider_native_resume_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_dir = root.join("workspace/sessions/app-owned-id");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("meta.yaml"),
            "company_slug: indigo\nproject: launch\ntool: codex\ncli_session_id: native-codex-id\n",
        )
        .unwrap();

        let rows = read_recent_session_rows(root, 10);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "native-codex-id");
        assert_eq!(
            rows[0].workspace_session_id.as_deref(),
            Some("app-owned-id")
        );
    }

    #[test]
    fn project_observation_uses_explicit_ownership_not_activity_order() {
        let mut summaries = vec![
            summary(
                "ended",
                SessionPhase::Ended,
                "indigo",
                "2026-09-02T10:00:00Z",
            ),
            summary(
                "quiet",
                SessionPhase::Idle,
                "indigo",
                "2026-09-02T08:00:00Z",
            ),
            summary(
                "busy",
                SessionPhase::Working,
                "indigo",
                "2026-09-02T09:00:00Z",
            ),
            summary(
                "other",
                SessionPhase::Working,
                "ridge",
                "2026-09-02T11:00:00Z",
            ),
        ];
        assert!(sessions_for_project(&summaries, "indigo", "draft").is_empty());
        summaries[0].project = Some("draft".into()); // ended
        summaries[1].project = Some("draft".into()); // quiet owner
        summaries[2].project = Some("other-project".into()); // busy unrelated
        summaries[3].project = Some("draft".into()); // other company
        let ids = |co: &str, project: &str| sessions_for_project(&summaries, co, project)
            .iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids("Indigo", "draft"), vec!["quiet"]);
        assert!(ids("acme", "draft").is_empty());
        assert!(ids("indigo", "unrelated").is_empty());
    }

    #[test]
    fn the_watch_reports_a_new_prd_json_exactly_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let projects = root.join("companies/indigo/projects");
        fs::create_dir_all(projects.join("launch")).unwrap();
        fs::write(projects.join("launch/prd.json"), "{}").unwrap();
        // A directory without a prd.json is not a project yet.
        fs::create_dir_all(projects.join("draft")).unwrap();
        // Retired and scaffold buckets never count.
        fs::create_dir_all(projects.join("_archive/old")).unwrap();
        fs::write(projects.join("_archive/prd.json"), "{}").unwrap();

        let mut watch = ProjectWatch::new();
        // First look seeds silently: `launch` already existed.
        assert!(watch
            .observe("indigo", scan_project_slugs(root, "indigo"))
            .is_empty());
        assert!(watch.is_watching("indigo"));

        // The agent's `/plan` lands a prd.json.
        fs::write(projects.join("draft/prd.json"), "{\"name\":\"Draft\"}").unwrap();
        assert_eq!(
            watch.observe("indigo", scan_project_slugs(root, "indigo")),
            vec!["draft".to_string()]
        );
        // Once: the next tick sees nothing new.
        assert!(watch
            .observe("indigo", scan_project_slugs(root, "indigo"))
            .is_empty());

        // No live session for the company → forgotten; the next look seeds
        // again instead of replaying `draft` as a creation.
        watch.retain(&BTreeSet::new());
        assert!(!watch.is_watching("indigo"));
        assert!(watch
            .observe("indigo", scan_project_slugs(root, "indigo"))
            .is_empty());

        assert!(scan_project_slugs(root, "").is_empty());
        assert!(scan_project_slugs(root, "nope").is_empty());
    }

    #[test]
    fn project_created_payload_is_camel_case() {
        let raw = serde_json::to_value(ProjectCreated {
            session_id: "s1".into(),
            company: "indigo".into(),
            project: "draft".into(),
            project_path: "/hq/companies/indigo/projects/draft".into(),
        })
        .expect("serialize");
        assert_eq!(raw["sessionId"], "s1");
        assert_eq!(raw["projectPath"], "/hq/companies/indigo/projects/draft");
    }
}
