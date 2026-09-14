//! Company projects from `companies/{co}/projects/*/prd.json`.
//!
//! A real company folder carries ~650 project directories, so the reader stats
//! the directory listing first (the `prd.json` and the `journal/*.md` entries —
//! never their contents), sorts by that last activity, and only then opens the
//! newest [`MAX_PROJECTS`] files. Retired projects under `_archive/` are listed
//! too, flagged `archived`; other `_`-prefixed scaffold directories and
//! sync-conflict copies are skipped.
//!
//! Ownership is best-effort. Real `prd.json` files name an owner in a handful
//! of shapes — a top-level `owner` (an email, sometimes a display name) or
//! `metadata.owner` (a `prs_…` person uid or an email) are what HQ actually
//! writes today; `createdBy` / `created-by` / `metadata.requestedBy` are
//! honoured for completeness. When the PRD says nothing, the newest journal
//! entry's frontmatter (`author:` / `owner:` / `by:`) is the fallback.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::{
    clamp, is_skippable_entry_name, modified_or_epoch, modified_rfc3339, read_head,
    split_frontmatter, HEAD_BYTES,
};

/// Hard ceiling on projects returned.
pub const MAX_PROJECTS: usize = 200;
/// Ceiling on directory entries considered before sorting (live + archived).
const MAX_SCANNED_DIRS: usize = 5_000;
/// Ceiling on `journal/*.md` entries stat'ed per project.
const MAX_JOURNAL_ENTRIES: usize = 256;
/// HQ's retired-project bucket inside `projects/`.
const ARCHIVE_DIR: &str = "_archive";
/// A `prd.json` beyond this size is skipped rather than parsed — real ones run
/// tens of KB, and the reader must never pull a runaway file into memory.
const MAX_PRD_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryCounts {
    pub total: u32,
    pub done: u32,
}

/// Where a project stands, derived rather than declared: `done` once every
/// story passes (and there is at least one), `archived` when it lives under
/// `_archive/`, `active` otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectStatus {
    Active,
    Done,
    Archived,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    pub description: String,
    pub branch_name: Option<String>,
    /// Absolute path to the project directory.
    pub path: String,
    pub story_counts: StoryCounts,
    /// `prd.json` mtime, RFC-3339 UTC.
    pub updated_at: Option<String>,
    /// Who the PRD (or, failing that, the newest journal entry) names as the
    /// owner: an email, a `prs_…` uid or a display name, verbatim. `None` when
    /// nothing on disk says.
    pub owner: Option<String>,
    /// The newer of the `prd.json` mtime and the newest `journal/*.md` mtime,
    /// RFC-3339 UTC — what "recently worked on" means for the picker.
    pub last_activity_at: Option<String>,
    pub status: ProjectStatus,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prd {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    branch_name: Option<String>,
    #[serde(default)]
    user_stories: Vec<PrdStory>,
    // Ownership keys are read as raw JSON: real files carry strings, but a
    // stray object or list must degrade to "no owner", never drop the project.
    #[serde(default)]
    owner: Option<serde_json::Value>,
    #[serde(default)]
    created_by: Option<serde_json::Value>,
    #[serde(default, rename = "created-by")]
    created_by_kebab: Option<serde_json::Value>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

/// The first non-empty string among the owner-ish keys, in priority order.
fn owner_from_prd(prd: &Prd) -> Option<String> {
    let meta = prd.metadata.as_ref().and_then(|value| value.as_object());
    let meta_key = |key: &str| meta.and_then(|map| map.get(key));
    let candidates: [Option<&serde_json::Value>; 8] = [
        prd.owner.as_ref(),
        meta_key("owner"),
        meta_key("createdBy"),
        prd.created_by.as_ref(),
        meta_key("created-by"),
        prd.created_by_kebab.as_ref(),
        meta_key("author"),
        meta_key("requestedBy"),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| clamp(value, 120))
}

/// `author:` / `owner:` / `by:` / `operator:` out of a journal entry's
/// frontmatter, quotes stripped. Journal frontmatter is flat `key: value`
/// YAML, so a line scan is enough and no YAML parser is pulled in.
fn owner_from_journal(path: &Path) -> Option<String> {
    let head = read_head(path, HEAD_BYTES)?;
    let (front, _) = split_frontmatter(&head);
    let front = front?;
    for key in ["author", "owner", "by", "operator", "created_by"] {
        for line in front.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.trim() != key {
                continue;
            }
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if !value.is_empty() {
                return Some(clamp(value, 120));
            }
        }
    }
    None
}

/// Stat-only scan of `{dir}/journal/*.md`: the newest entry's mtime and path.
fn newest_journal_entry(dir: &Path) -> Option<(SystemTime, PathBuf)> {
    let entries = std::fs::read_dir(dir.join("journal")).ok()?;
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in entries.flatten().take(MAX_JOURNAL_ENTRIES) {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) || !name.ends_with(".md") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        let newer = match &newest {
            Some((when, _)) => modified > *when,
            None => true,
        };
        if newer {
            newest = Some((modified, path));
        }
    }
    newest
}

fn system_time_rfc3339(when: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Utc> = when.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// One directory the listing will consider, with everything the stat pass
/// learned so the sort and the cap happen before any file is opened.
struct Candidate {
    dir: PathBuf,
    archived: bool,
    /// Newer of `prd.json` and the newest journal entry.
    activity: SystemTime,
    newest_journal: Option<PathBuf>,
}

/// Stat a project directory into a [`Candidate`], or `None` when it has no
/// readable, sanely sized `prd.json`.
fn candidate(dir: PathBuf, archived: bool) -> Option<Candidate> {
    let prd = dir.join("prd.json");
    let metadata = std::fs::metadata(&prd).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PRD_BYTES {
        return None;
    }
    let prd_mtime = modified_or_epoch(&prd);
    let journal = newest_journal_entry(&dir);
    let activity = journal
        .as_ref()
        .map(|(when, _)| (*when).max(prd_mtime))
        .unwrap_or(prd_mtime);
    Some(Candidate {
        dir,
        archived,
        activity,
        newest_journal: journal.map(|(_, path)| path),
    })
}

#[derive(Debug, Default, Deserialize)]
struct PrdStory {
    /// `passes` is HQ's "story is done" signal. Absent === not done.
    #[serde(default)]
    passes: Option<bool>,
}

/// List a company's projects, most recent activity first, capped at
/// [`MAX_PROJECTS`]. Projects under `_archive/` are included and flagged.
///
/// Unreadable or malformed `prd.json` files are skipped rather than failing the
/// whole listing.
pub fn list_company_projects(hq_root: &Path, company: &str) -> Vec<ProjectEntry> {
    let company = company.trim();
    if company.is_empty() {
        return Vec::new();
    }
    let projects_dir = hq_root.join("companies").join(company).join("projects");
    let Ok(entries) = std::fs::read_dir(&projects_dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut scanned = 0usize;
    for entry in entries.flatten() {
        if scanned >= MAX_SCANNED_DIRS {
            break;
        }
        scanned += 1;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // `_archive` is HQ's retired-project bucket: one level of project
        // directories, listed as archived. Other `_`/`.` prefixes and
        // `.conflict-` copies are scaffold/sync noise.
        if name == ARCHIVE_DIR {
            let Ok(archived) = std::fs::read_dir(&dir) else {
                continue;
            };
            for retired in archived.flatten() {
                if scanned >= MAX_SCANNED_DIRS {
                    break;
                }
                scanned += 1;
                let Ok(retired_name) = retired.file_name().into_string() else {
                    continue;
                };
                if is_skippable_entry_name(&retired_name) {
                    continue;
                }
                let retired_dir = retired.path();
                if !retired_dir.is_dir() {
                    continue;
                }
                if let Some(found) = candidate(retired_dir, true) {
                    candidates.push(found);
                }
            }
            continue;
        }
        if is_skippable_entry_name(&name) {
            continue;
        }
        if let Some(found) = candidate(dir, false) {
            candidates.push(found);
        }
    }

    // Most recent activity first, then by path so equal mtimes (a fresh
    // clone, a restore) still order deterministically.
    candidates.sort_by(|a, b| b.activity.cmp(&a.activity).then_with(|| a.dir.cmp(&b.dir)));
    candidates.truncate(MAX_PROJECTS);

    candidates
        .into_iter()
        .filter_map(|found| read_project(&found))
        .collect()
}

/// Read one project by its canonical directory slug without going through the
/// bounded recent-project listing. Project-channel decoration uses this path:
/// a visible cloud channel must not disappear merely because its local PRD is
/// older than the project picker's [`MAX_PROJECTS`] window.
pub fn find_company_project(
    hq_root: &Path,
    company: &str,
    project_slug: &str,
) -> Option<ProjectEntry> {
    let company = company.trim();
    let project_slug = project_slug.trim();
    if company.is_empty()
        || project_slug.is_empty()
        || project_slug.contains(['/', '\\'])
        || project_slug == "."
        || project_slug == ".."
        || is_skippable_entry_name(project_slug)
    {
        return None;
    }

    let projects_dir = hq_root.join("companies").join(company).join("projects");
    candidate(projects_dir.join(project_slug), false)
        .or_else(|| candidate(projects_dir.join(ARCHIVE_DIR).join(project_slug), true))
        .and_then(|found| read_project(&found))
}

fn read_project(found: &Candidate) -> Option<ProjectEntry> {
    let dir = found.dir.as_path();
    let prd_path = dir.join("prd.json");
    let raw = std::fs::read_to_string(&prd_path).ok()?;
    let prd: Prd = serde_json::from_str(&raw).ok()?;

    let total = prd.user_stories.len() as u32;
    let done = prd
        .user_stories
        .iter()
        .filter(|story| story.passes.unwrap_or(false))
        .count() as u32;

    let fallback_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    let owner = owner_from_prd(&prd)
        .or_else(|| found.newest_journal.as_deref().and_then(owner_from_journal));

    let status = if found.archived {
        ProjectStatus::Archived
    } else if total > 0 && done == total {
        ProjectStatus::Done
    } else {
        ProjectStatus::Active
    };

    Some(ProjectEntry {
        name: prd
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| clamp(n, 200))
            .unwrap_or(fallback_name),
        description: clamp(prd.description.as_deref().unwrap_or_default(), 400),
        branch_name: prd
            .branch_name
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| clamp(b, 200)),
        path: dir.to_string_lossy().into_owned(),
        story_counts: StoryCounts { total, done },
        updated_at: std::fs::metadata(&prd_path)
            .ok()
            .and_then(|m| modified_rfc3339(&m)),
        owner,
        last_activity_at: Some(system_time_rfc3339(found.activity)),
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_project(root: &Path, company: &str, slug: &str, body: &str) -> PathBuf {
        let dir = root
            .join("companies")
            .join(company)
            .join("projects")
            .join(slug);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("prd.json"), body).unwrap();
        dir
    }

    /// Modelled on a real `prd.json`: `name`, `description`, `branchName`,
    /// `userStories[].passes`, plus a `metadata` object we ignore.
    fn prd(name: &str, stories: &[bool]) -> String {
        let user_stories: Vec<String> = stories
            .iter()
            .enumerate()
            .map(|(idx, passes)| {
                format!(
                    r#"{{"id":"US-{:03}","title":"story {idx}","passes":{passes}}}"#,
                    idx + 1
                )
            })
            .collect();
        format!(
            r#"{{"name":"{name}","description":"desc for {name}","branchName":"feature/{name}","userStories":[{}],"metadata":{{"company":"indigo"}}}}"#,
            user_stories.join(",")
        )
    }

    #[test]
    fn story_counts_come_from_the_passes_flag() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(
            tmp.path(),
            "indigo",
            "alpha",
            &prd("alpha", &[true, true, false, true]),
        );
        let projects = list_company_projects(tmp.path(), "indigo");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "alpha");
        assert_eq!(projects[0].description, "desc for alpha");
        assert_eq!(projects[0].branch_name.as_deref(), Some("feature/alpha"));
        assert_eq!(projects[0].story_counts, StoryCounts { total: 4, done: 3 });
        assert!(projects[0].updated_at.is_some());
    }

    #[test]
    fn exact_project_lookup_is_not_limited_by_the_recent_picker_window() {
        let tmp = tempfile::tempdir().unwrap();
        let old = write_project(
            tmp.path(),
            "indigo",
            "old-project-channel",
            &prd("Old project channel", &[false]),
        );
        super::super::set_mtime(&old.join("prd.json"), 1_000);
        for idx in 0..MAX_PROJECTS {
            let slug = format!("recent-{idx:03}");
            let dir = write_project(tmp.path(), "indigo", &slug, &prd(&slug, &[false]));
            super::super::set_mtime(&dir.join("prd.json"), 2_000 + idx as u64);
        }

        assert!(list_company_projects(tmp.path(), "indigo")
            .iter()
            .all(|project| project.name != "Old project channel"));
        let found = find_company_project(tmp.path(), "indigo", "old-project-channel")
            .expect("channel-backed project must bypass the picker cap");
        assert_eq!(found.name, "Old project channel");
        assert!(find_company_project(tmp.path(), "indigo", "../other-company").is_none());
    }

    #[test]
    fn missing_or_absent_passes_counts_as_not_done() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(
            tmp.path(),
            "indigo",
            "beta",
            r#"{"name":"beta","userStories":[{"id":"US-001"},{"id":"US-002","passes":false},{"id":"US-003","passes":true}]}"#,
        );
        let projects = list_company_projects(tmp.path(), "indigo");
        assert_eq!(projects[0].story_counts, StoryCounts { total: 3, done: 1 });
        // Absent optional fields degrade, they don't drop the project.
        assert_eq!(projects[0].description, "");
        assert_eq!(projects[0].branch_name, None);
    }

    #[test]
    fn scaffold_and_conflict_directories_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "real", &prd("real", &[true]));
        // A `prd.json` directly inside `_archive` is not a project; only its
        // children are (see `archived_projects_are_listed_and_flagged`).
        write_project(tmp.path(), "indigo", "_archive", &prd("bucket", &[true]));
        write_project(tmp.path(), "indigo", "_drafts", &prd("drafts", &[true]));
        write_project(tmp.path(), "indigo", ".hidden", &prd("hidden", &[true]));
        write_project(
            tmp.path(),
            "indigo",
            "real.conflict-2026-08-22T22-17-32Z-9aea6b",
            &prd("conflict", &[true]),
        );
        let names: Vec<_> = list_company_projects(tmp.path(), "indigo")
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn archived_projects_are_listed_and_flagged() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "live", &prd("live", &[false]));
        write_project(
            tmp.path(),
            "indigo",
            "_archive/retired",
            &prd("retired", &[true]),
        );
        write_project(
            tmp.path(),
            "indigo",
            "_archive/old.conflict-2026-08-22T22-17-32Z-9aea6b",
            &prd("conflict", &[true]),
        );
        let projects = list_company_projects(tmp.path(), "indigo");
        let mut by_name: Vec<(String, ProjectStatus)> =
            projects.into_iter().map(|p| (p.name, p.status)).collect();
        by_name.sort();
        assert_eq!(
            by_name,
            vec![
                ("live".to_string(), ProjectStatus::Active),
                ("retired".to_string(), ProjectStatus::Archived),
            ]
        );
    }

    #[test]
    fn status_is_done_only_when_every_story_passes() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "done", &prd("done", &[true, true]));
        write_project(
            tmp.path(),
            "indigo",
            "partial",
            &prd("partial", &[true, false]),
        );
        write_project(tmp.path(), "indigo", "empty", &prd("empty", &[]));
        let mut statuses: Vec<(String, ProjectStatus)> =
            list_company_projects(tmp.path(), "indigo")
                .into_iter()
                .map(|p| (p.name, p.status))
                .collect();
        statuses.sort();
        assert_eq!(
            statuses,
            vec![
                ("done".to_string(), ProjectStatus::Done),
                ("empty".to_string(), ProjectStatus::Active),
                ("partial".to_string(), ProjectStatus::Active),
            ]
        );
    }

    #[test]
    fn owner_comes_from_the_shapes_real_prds_use() {
        let tmp = tempfile::tempdir().unwrap();
        // Top-level `owner` — an email, as `sandbox-runner-egress-hardening` has it.
        write_project(
            tmp.path(),
            "indigo",
            "top",
            r#"{"name":"top","owner":"hassaan@getindigo.ai","userStories":[]}"#,
        );
        // `metadata.owner` — a person uid, as `fleet-agent-delivery-failures` has it.
        write_project(
            tmp.path(),
            "indigo",
            "meta",
            r#"{"name":"meta","metadata":{"owner":"prs_01KQ695MZHZBYFMVMPRTGFW34B"},"userStories":[]}"#,
        );
        // The documented-but-rarer keys still resolve, in priority order.
        write_project(
            tmp.path(),
            "indigo",
            "created",
            r#"{"name":"created","metadata":{"createdBy":"jacob@getindigo.ai","requestedBy":"other@x"},"userStories":[]}"#,
        );
        write_project(
            tmp.path(),
            "indigo",
            "kebab",
            r#"{"name":"kebab","created-by":"kebab@x","userStories":[]}"#,
        );
        // Top-level wins over metadata; blanks and non-strings are skipped.
        write_project(
            tmp.path(),
            "indigo",
            "mixed",
            r#"{"name":"mixed","owner":"  ","metadata":{"owner":{"uid":"nope"},"createdBy":"meta@x"},"userStories":[]}"#,
        );
        // A metadata that is not an object degrades to "no owner", not a drop.
        write_project(
            tmp.path(),
            "indigo",
            "odd",
            r#"{"name":"odd","metadata":"legacy string","userStories":[]}"#,
        );
        let mut owners: Vec<(String, Option<String>)> = list_company_projects(tmp.path(), "indigo")
            .into_iter()
            .map(|p| (p.name, p.owner))
            .collect();
        owners.sort();
        assert_eq!(
            owners,
            vec![
                (
                    "created".to_string(),
                    Some("jacob@getindigo.ai".to_string())
                ),
                ("kebab".to_string(), Some("kebab@x".to_string())),
                (
                    "meta".to_string(),
                    Some("prs_01KQ695MZHZBYFMVMPRTGFW34B".to_string())
                ),
                ("mixed".to_string(), Some("meta@x".to_string())),
                ("odd".to_string(), None),
                ("top".to_string(), Some("hassaan@getindigo.ai".to_string())),
            ]
        );
    }

    #[test]
    fn owner_falls_back_to_the_newest_journal_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = write_project(
            tmp.path(),
            "indigo",
            "journaled",
            &prd("journaled", &[false]),
        );
        let journal = dir.join("journal");
        fs::create_dir_all(&journal).unwrap();
        let older = journal.join("2026-05-01-0900-plan-adhoc.md");
        let newer = journal.join("2026-06-01-0900-plan-adhoc.md");
        fs::write(
            &older,
            "---\nskill: plan\nauthor: old@x\n---\n## Decisions\n",
        )
        .unwrap();
        fs::write(
            &newer,
            "---\nskill: plan\nauthor: \"new@x\"\nstatus: active\n---\n## Decisions\n",
        )
        .unwrap();
        super::super::set_mtime(&older, 1_700_000_000);
        super::super::set_mtime(&newer, 1_700_000_600);
        let projects = list_company_projects(tmp.path(), "indigo");
        assert_eq!(projects[0].owner.as_deref(), Some("new@x"));

        // No author anywhere → None, and the project still lists.
        let plain = write_project(tmp.path(), "indigo", "plain", &prd("plain", &[false]));
        fs::create_dir_all(plain.join("journal")).unwrap();
        fs::write(
            plain.join("journal/2026-05-22-1550-brainstorm-adhoc.md"),
            "---\nskill: brainstorm\nstarted_at: 2026-05-22T15:50:21Z\nstatus: active\n---\n",
        )
        .unwrap();
        let plain_entry = list_company_projects(tmp.path(), "indigo")
            .into_iter()
            .find(|p| p.name == "plain")
            .unwrap();
        assert_eq!(plain_entry.owner, None);
    }

    #[test]
    fn last_activity_is_the_newer_of_prd_and_journal_and_drives_the_order() {
        let tmp = tempfile::tempdir().unwrap();
        // `quiet` has the newer PRD; `busy` has an older PRD but a newer journal entry.
        let quiet = write_project(tmp.path(), "indigo", "quiet", &prd("quiet", &[false]));
        let busy = write_project(tmp.path(), "indigo", "busy", &prd("busy", &[false]));
        super::super::set_mtime(&quiet.join("prd.json"), 1_700_000_600);
        super::super::set_mtime(&busy.join("prd.json"), 1_700_000_000);
        fs::create_dir_all(busy.join("journal")).unwrap();
        let entry = busy.join("journal/2026-06-01-0900-plan-adhoc.md");
        fs::write(&entry, "---\nskill: plan\n---\n").unwrap();
        super::super::set_mtime(&entry, 1_700_001_200);

        let projects = list_company_projects(tmp.path(), "indigo");
        let names: Vec<_> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["busy", "quiet"]);
        assert_eq!(
            projects[0].last_activity_at.as_deref(),
            Some("2023-11-14T22:33:20Z")
        );
        // `updated_at` stays the PRD's own mtime.
        assert_eq!(
            projects[0].updated_at.as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(
            projects[1].last_activity_at.as_deref(),
            Some("2023-11-14T22:23:20Z")
        );
        assert_eq!(projects[1].last_activity_at, projects[1].updated_at);
    }

    #[test]
    fn malformed_prd_is_skipped_and_directories_without_one_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "good", &prd("good", &[true]));
        write_project(tmp.path(), "indigo", "broken", "{not json");
        fs::create_dir_all(tmp.path().join("companies/indigo/projects/no-prd")).unwrap();
        let names: Vec<_> = list_company_projects(tmp.path(), "indigo")
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["good"]);
    }

    #[test]
    fn listing_is_newest_first_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        for idx in 0..(MAX_PROJECTS + 20) {
            let dir = write_project(
                tmp.path(),
                "indigo",
                &format!("p{idx:03}"),
                &prd(&format!("p{idx:03}"), &[true]),
            );
            // Older index === older mtime.
            super::super::set_mtime(&dir.join("prd.json"), 1_700_000_000 + idx as u64 * 60);
        }
        let projects = list_company_projects(tmp.path(), "indigo");
        assert_eq!(projects.len(), MAX_PROJECTS);
        assert_eq!(projects[0].name, format!("p{:03}", MAX_PROJECTS + 19));
        assert!(projects[0].name > projects[1].name);
    }

    #[test]
    fn unknown_company_and_empty_slug_return_empty() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "alpha", &prd("alpha", &[true]));
        assert!(list_company_projects(tmp.path(), "nope").is_empty());
        assert!(list_company_projects(tmp.path(), "  ").is_empty());
    }
}
