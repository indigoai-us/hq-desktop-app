//! Read-only index of one local HQ vault for the Files explorer.
//!
//! The explorer lists folders lazily (`list_dir_entries`), but three features
//! need the whole vault at once: the quick switcher (find any file by name),
//! resolving `[[wikilinks]]` to a file, and backlinks (which notes link here).
//! This walks one vault root a single time and returns every visible file plus
//! the raw wikilink targets written in each Markdown note. Resolution happens
//! in the renderer, which already knows the vault's file list.
//!
//! A vault root is either `companies/<slug>` (a company vault) or the HQ root
//! itself (the personal vault). The personal vault mirrors what the personal
//! sync pushes: the HQ root minus `companies/`, `repos/` and `workspace/`.
//!
//! What is never listed, at any depth: curated dev noise and dot-directories
//! (the same rule as the lazy tree), symlinks (they can alias another company
//! or leave HQ), `settings/` folders, and files whose names mark them as
//! credentials. The explorer is something people show on screen; a key file
//! rendered as text is a leak.

use std::path::Path;

use serde::Serialize;

use crate::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, is_dev_noise, is_within,
    validate_hq_relative_path,
};

/// Most files one index returns. Larger vaults come back `truncated`.
pub const MAX_INDEX_FILES: usize = 20_000;
/// Largest Markdown note scanned for links. Bigger notes are listed, unscanned.
pub const MAX_LINK_SCAN_BYTES: u64 = 512 * 1024;
/// Most links recorded per note.
const MAX_LINKS_PER_NOTE: usize = 500;

/// Top-level folders that are not part of the personal vault.
pub const PERSONAL_VAULT_EXCLUDED_TOP_LEVEL: &[&str] = &[".git", "companies", "repos", "workspace"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    /// HQ-folder-relative, forward-slash path.
    pub path: String,
    pub name: String,
    pub is_markdown: bool,
    /// Raw `[[target]]` values in a Markdown note (before `|` and `#`), in
    /// order, deduplicated. Empty for other files.
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndex {
    /// The vault root as requested: `""` for personal, `companies/<slug>`.
    pub root: String,
    pub files: Vec<IndexedFile>,
    /// True when the vault had more than [`MAX_INDEX_FILES`] visible files.
    pub truncated: bool,
}

/// True for names the explorer must never list: credential files and
/// `settings/` folders (where HQ keeps service config and keys).
pub fn is_sensitive_name(name: &str, is_dir: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    if is_dir {
        return lower == "settings" || lower == "secrets" || lower == ".ssh";
    }
    if lower == ".env" || lower.starts_with(".env.") && lower != ".env.example" {
        return true;
    }
    if lower == ".netrc" || lower == ".npmrc" || lower == "id_rsa" || lower == "id_ed25519" {
        return true;
    }
    const SENSITIVE_EXT: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".keystore"];
    if SENSITIVE_EXT.iter().any(|ext| lower.ends_with(ext)) {
        return true;
    }
    let data_file = [".json", ".txt", ".yaml", ".yml", ".toml"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    lower.contains("credential")
        || lower.contains("secret")
        || (data_file && lower.contains("token"))
}

fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Pull `[[target]]` values out of Markdown, skipping fenced code blocks and
/// inline code spans. Keeps the part before `|` (alias) and `#` (heading),
/// trimmed; drops empty targets and embeds' leading `!` is irrelevant because
/// only the bracket contents are read.
pub fn extract_wikilinks(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut rest = line;
        let mut in_code = false;
        while !rest.is_empty() {
            if rest.starts_with('`') {
                in_code = !in_code;
                rest = &rest[1..];
                continue;
            }
            if !in_code && rest.starts_with("[[") {
                if let Some(end) = rest[2..].find("]]") {
                    let inner = &rest[2..2 + end];
                    let target = inner
                        .split('|')
                        .next()
                        .unwrap_or("")
                        .split('#')
                        .next()
                        .unwrap_or("")
                        .trim();
                    if !target.is_empty()
                        && !target.contains('\n')
                        && !out.iter().any(|t| t == target)
                    {
                        out.push(target.to_string());
                        if out.len() >= MAX_LINKS_PER_NOTE {
                            return out;
                        }
                    }
                    rest = &rest[2 + end + 2..];
                    continue;
                }
            }
            let mut chars = rest.chars();
            chars.next();
            rest = chars.as_str();
        }
    }
    out
}

/// Index one vault. `root_rel` is `""` (personal vault) or `companies/<slug>`.
/// Company authorization is the caller's job; this enforces the path rules.
pub fn build_vault_index(hq_root: &Path, root_rel: &str) -> Result<VaultIndex, String> {
    let normalized = validate_hq_relative_path(root_rel, true)?;
    let personal = normalized.is_empty();
    if !personal {
        let slug = company_slug_for_hq_path(&normalized)?;
        if slug.is_none() || normalized.split('/').count() != 2 {
            return Err(format!(
                "a vault root is the HQ folder or companies/<slug>: {root_rel:?}"
            ));
        }
    }
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    if !personal {
        let canonical_rel = canonical_hq_relative_path(&canonical_root, &normalized, false)?;
        if canonical_rel != normalized {
            return Err("vault folder resolves across HQ company boundaries".to_string());
        }
    }
    let start = if personal {
        canonical_root.clone()
    } else {
        canonical_root.join(&normalized)
    };
    if !start.is_dir() {
        return Err(format!("vault folder not found: {root_rel:?}"));
    }

    let mut files: Vec<IndexedFile> = Vec::new();
    let mut truncated = false;
    // Depth-first with an explicit stack; (absolute dir, relative dir).
    let mut stack: Vec<(std::path::PathBuf, String)> = vec![(start, normalized.clone())];
    'walk: while let Some((dir_abs, dir_rel)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir_abs) else {
            continue;
        };
        let mut children: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let is_dir = file_type.is_dir();
            if is_dev_noise(&name, is_dir) || is_sensitive_name(&name, is_dir) {
                continue;
            }
            if personal
                && dir_rel.is_empty()
                && is_dir
                && PERSONAL_VAULT_EXCLUDED_TOP_LEVEL.contains(&name.as_str())
            {
                continue;
            }
            children.push((name, entry.path(), is_dir));
        }
        children.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        // Push directories in reverse so the walk visits them alphabetically.
        let mut dirs: Vec<(std::path::PathBuf, String)> = Vec::new();
        for (name, abs, is_dir) in children {
            let rel = if dir_rel.is_empty() {
                name.clone()
            } else {
                format!("{dir_rel}/{name}")
            };
            if !is_within(&canonical_root, &abs) {
                continue;
            }
            if is_dir {
                dirs.push((abs, rel));
                continue;
            }
            if files.len() >= MAX_INDEX_FILES {
                truncated = true;
                break 'walk;
            }
            let is_markdown = is_markdown_name(&name);
            let links = if is_markdown {
                match std::fs::metadata(&abs) {
                    Ok(meta) if meta.len() <= MAX_LINK_SCAN_BYTES => std::fs::read(&abs)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .map(|text| extract_wikilinks(&text))
                        .unwrap_or_default(),
                    _ => Vec::new(),
                }
            } else {
                Vec::new()
            };
            files.push(IndexedFile {
                path: rel,
                name,
                is_markdown,
                links,
            });
        }
        for dir in dirs.into_iter().rev() {
            stack.push(dir);
        }
    }

    Ok(VaultIndex {
        root: normalized,
        files,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn paths(index: &VaultIndex) -> Vec<&str> {
        index.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn extracts_wikilinks_without_alias_heading_or_code() {
        let src = "See [[clients/Lumen|Lumen]] and [[pricing#Tiers]].\n\
                   Again [[pricing]] and `[[not-a-link]]`.\n\
                   ```\n[[fenced]]\n```\n![[diagram.png]]";
        assert_eq!(
            extract_wikilinks(src),
            vec!["clients/Lumen", "pricing", "diagram.png"]
        );
    }

    #[test]
    fn indexes_a_company_vault_and_hides_settings_secrets_and_noise() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/knowledge/a.md", "Links to [[b]].");
        write(root, "companies/acme/knowledge/b.md", "# B");
        write(root, "companies/acme/settings/keys.json", "{}");
        write(root, "companies/acme/.env", "X=1");
        write(root, "companies/acme/stripe-credentials.json", "{}");
        write(root, "companies/acme/node_modules/x/index.js", "");
        write(root, "companies/other/knowledge/c.md", "");
        let index = build_vault_index(root, "companies/acme").unwrap();
        assert_eq!(
            paths(&index),
            vec![
                "companies/acme/knowledge/a.md",
                "companies/acme/knowledge/b.md"
            ]
        );
        assert_eq!(index.files[0].links, vec!["b"]);
        assert!(!index.truncated);
    }

    #[test]
    fn personal_vault_is_the_root_minus_companies_repos_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "personal/notes/today.md", "");
        write(root, "knowledge/x.md", "");
        write(root, "companies/acme/a.md", "");
        write(root, "repos/private/r/README.md", "");
        write(root, "workspace/drafts/d.md", "");
        let index = build_vault_index(root, "").unwrap();
        assert_eq!(
            paths(&index),
            vec!["knowledge/x.md", "personal/notes/today.md"]
        );
    }

    #[test]
    fn refuses_roots_that_are_not_a_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/knowledge/a.md", "");
        assert!(build_vault_index(root, "companies/acme/knowledge").is_err());
        assert!(build_vault_index(root, "repos").is_err());
        assert!(build_vault_index(root, "../etc").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_that_could_alias_another_company() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/a.md", "");
        write(root, "companies/other/secret-plan.md", "");
        std::os::unix::fs::symlink(
            root.join("companies/other"),
            root.join("companies/acme/linked"),
        )
        .unwrap();
        let index = build_vault_index(root, "companies/acme").unwrap();
        assert_eq!(paths(&index), vec!["companies/acme/a.md"]);
    }

    #[test]
    fn sensitive_names() {
        assert!(is_sensitive_name("settings", true));
        assert!(is_sensitive_name(".env.local", false));
        assert!(!is_sensitive_name(".env.example", false));
        assert!(is_sensitive_name("server.pem", false));
        assert!(is_sensitive_name("gmail-token.json", false));
        assert!(!is_sensitive_name("pricing.md", false));
        assert!(!is_sensitive_name("settings.md", false));
        assert!(!is_sensitive_name("tokens.css", false));
    }
}
