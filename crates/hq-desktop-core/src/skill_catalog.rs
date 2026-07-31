//! Bounded name+description skill catalog for Claude Code Desktop sessions.
//!
//! Mirrors `core/scripts/lib/session-skill-catalog.sh`: company skills first
//! (when scoped), then `.claude/skills`, then `core/packages/*/skills/*`.
//! First name wins on collision. Output is compact markdown lines only —
//! never full SKILL.md bodies.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::library_local::split_frontmatter;

const DEFAULT_MAX_BYTES: usize = 32_768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogEntry {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogExport {
    pub skills_available: usize,
    pub rendered_bytes: usize,
    pub body: String,
}

#[derive(Default, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
}

/// Build a bounded markdown catalog body for the given HQ root and optional
/// company slug. When `company_slug` is set, company skills are enumerated
/// first so they shadow root/package names on collision — matching the shell
/// catalog's precedence.
pub fn export_skill_catalog(
    hq_root: &Path,
    company_slug: Option<&str>,
) -> SkillCatalogExport {
    export_skill_catalog_with_limit(hq_root, company_slug, DEFAULT_MAX_BYTES)
}

pub fn export_skill_catalog_with_limit(
    hq_root: &Path,
    company_slug: Option<&str>,
    max_bytes: usize,
) -> SkillCatalogExport {
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();

    if let Some(slug) = company_slug.filter(|s| !s.trim().is_empty()) {
        let company_dir = hq_root.join("companies").join(slug).join("skills");
        collect_skill_files(&company_dir, &mut candidates);
    }

    collect_skill_files(&hq_root.join(".claude/skills"), &mut candidates);

    if hq_root.join("core/packages").is_dir() {
        if let Ok(packages) = std::fs::read_dir(hq_root.join("core/packages")) {
            for package in packages.flatten() {
                let skills_dir = package.path().join("skills");
                collect_skill_files(&skills_dir, &mut candidates);
            }
        }
    }

    for (origin, skill_md) in candidates {
        let _ = origin;
        let Ok(raw) = std::fs::read_to_string(&skill_md) else {
            continue;
        };
        let (front_yaml, _) = split_frontmatter(&raw);
        let front = front_yaml
            .and_then(|yaml| serde_yaml::from_str::<SkillFrontmatter>(yaml).ok())
            .unwrap_or_default();
        let fallback_name = skill_md
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let name = if front.name.trim().is_empty() {
            fallback_name
        } else {
            front.name.trim().to_string()
        };
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        entries.push(SkillCatalogEntry {
            name,
            description: front.description.trim().to_string(),
        });
    }

    let skills_available = entries.len();
    let mut rendered_bytes = 0usize;
    let mut lines = Vec::new();
    for entry in entries {
        let line = if entry.description.is_empty() {
            format!("- /{}", entry.name)
        } else {
            format!("- /{} — {}", entry.name, entry.description)
        };
        let line_bytes = line.len() + 1;
        if rendered_bytes + line_bytes > max_bytes {
            break;
        }
        rendered_bytes += line_bytes;
        lines.push(line);
    }

    SkillCatalogExport {
        skills_available,
        rendered_bytes,
        body: lines.join("\n"),
    }
}

fn collect_skill_files(skills_dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let dir_name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        if dir_name.starts_with('_') || dir_name.starts_with('.') {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        if skill_md.is_file() {
            out.push((dir_name, skill_md));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: {description}\n---\n\nbody\n"
            ),
        )
        .unwrap();
    }

    fn scaffold_hq(root: &Path) {
        fs::create_dir_all(root.join("companies/indigo/skills")).unwrap();
        fs::create_dir_all(root.join(".claude/skills")).unwrap();
        fs::create_dir_all(root.join("core/packages/hq-pack-engineering/skills"))
            .unwrap();
    }

    #[test]
    fn company_skills_shadow_root_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        scaffold_hq(root);
        write_skill(&root.join("companies/indigo/skills/startwork"), "startwork", "company");
        write_skill(&root.join(".claude/skills/startwork"), "startwork", "root");
        let catalog = export_skill_catalog(root, Some("indigo"));
        assert_eq!(catalog.skills_available, 1);
        assert!(catalog.body.contains("company"));
        assert!(!catalog.body.contains("root"));
    }

    #[test]
    fn catalog_respects_byte_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        scaffold_hq(root);
        for idx in 0..200 {
            write_skill(
                &root.join(format!(".claude/skills/skill-{idx}")),
                &format!("skill-{idx}"),
                "x".repeat(200).as_str(),
            );
        }
        let catalog = export_skill_catalog_with_limit(root, None, 512);
        assert!(catalog.rendered_bytes <= 512);
        assert!(catalog.skills_available > catalog.body.lines().count());
    }

    #[test]
    fn root_and_package_skills_without_company() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        scaffold_hq(root);
        write_skill(&root.join(".claude/skills/handoff"), "handoff", "wrap sessions");
        write_skill(
            &root.join("core/packages/hq-pack-engineering/skills/land"),
            "land",
            "ship code",
        );
        let catalog = export_skill_catalog(root, None);
        assert_eq!(catalog.skills_available, 2);
        assert!(catalog.body.contains("/handoff"));
        assert!(catalog.body.contains("/land"));
    }
}
