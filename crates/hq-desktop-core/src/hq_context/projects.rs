//! Company projects from `companies/{co}/projects/*/prd.json`.
//!
//! A real company folder carries ~650 project directories, so the reader stats
//! the directory listing first, sorts by `prd.json` mtime, and only then opens
//! the newest [`MAX_PROJECTS`] files. `_archive` and other `_`-prefixed
//! scaffold directories are skipped, as are sync-conflict copies.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{clamp, is_skippable_entry_name, modified_or_epoch, modified_rfc3339};

/// Hard ceiling on projects returned.
pub const MAX_PROJECTS: usize = 50;
/// Ceiling on directory entries considered before sorting.
const MAX_SCANNED_DIRS: usize = 5_000;
/// A `prd.json` beyond this size is skipped rather than parsed — real ones run
/// tens of KB, and the reader must never pull a runaway file into memory.
const MAX_PRD_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryCounts {
    pub total: u32,
    pub done: u32,
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
}

#[derive(Debug, Default, Deserialize)]
struct PrdStory {
    /// `passes` is HQ's "story is done" signal. Absent === not done.
    #[serde(default)]
    passes: Option<bool>,
}

/// List a company's projects, newest `prd.json` first, capped at
/// [`MAX_PROJECTS`].
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

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        if candidates.len() >= MAX_SCANNED_DIRS {
            break;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // `_archive` is HQ's retired-project bucket; `_`/`.` prefixes and
        // `.conflict-` copies are scaffold/sync noise.
        if is_skippable_entry_name(&name) {
            continue;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let prd = dir.join("prd.json");
        let Ok(metadata) = std::fs::metadata(&prd) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_PRD_BYTES {
            continue;
        }
        candidates.push((modified_or_epoch(&prd), dir));
    }

    // Newest first, then by path so equal mtimes (a fresh clone, a restore)
    // still order deterministically.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates.truncate(MAX_PROJECTS);

    candidates
        .into_iter()
        .filter_map(|(_, dir)| read_project(&dir))
        .collect()
}

fn read_project(dir: &Path) -> Option<ProjectEntry> {
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
    fn archive_and_conflict_directories_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_project(tmp.path(), "indigo", "real", &prd("real", &[true]));
        write_project(tmp.path(), "indigo", "_archive", &prd("archived", &[true]));
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
