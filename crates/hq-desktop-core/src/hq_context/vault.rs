//! Bounded, privacy-filtered listing of a company's local folder, plus the
//! "attach this file as context" text reader behind it.
//!
//! Both entry points enforce the same two guards:
//!
//!   1. **Containment** — the resolved target must live inside `hq_root`.
//!      Symlinks and `..` are resolved before the check, so neither can walk
//!      the renderer out of HQ.
//!   2. **Privacy classes** — no path through a `settings/`, `data/`,
//!      `workers/` or `.git/` segment is ever listed or read. These mirror the
//!      anchored `companies/*/{settings,data,workers}/**` exclusions in
//!      [`crate::ignore::DEFAULT_IGNORES`] (credentials, datasets, worker
//!      prompt libraries).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    clamp_preserving, has_privacy_excluded_segment, is_skippable_entry_name, modified_rfc3339,
};

/// Hard ceiling on entries returned by a single listing.
pub const MAX_ENTRIES: usize = 200;
/// Default `limit` when the caller passes none/0.
pub const DEFAULT_LIMIT: usize = 200;
/// Ceiling on directory entries considered before sorting.
const MAX_SCANNED: usize = 20_000;
/// Hard ceiling on characters returned by [`read_reference_text`].
pub const MAX_REFERENCE_CHARS: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    /// Absolute path.
    pub path: String,
    pub name: String,
    /// `"file"` | `"dir"`.
    pub kind: String,
    /// `0` for directories.
    pub bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceText {
    /// The resolved absolute path that was read.
    pub path: String,
    pub text: String,
    pub truncated: bool,
}

/// List one level of `companies/{company}/{prefix}`.
///
/// Directories sort before files, then case-insensitively by name. `query` is a
/// case-insensitive substring filter on the entry name.
pub fn list_vault_files(
    hq_root: &Path,
    company: &str,
    prefix: Option<&str>,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<VaultEntry>, String> {
    let company = company.trim();
    if company.is_empty() {
        return Err("company must not be empty".to_string());
    }
    if company.contains('/') || company.contains('\\') || company.starts_with('.') {
        return Err(format!("invalid company slug: {company}"));
    }
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit }.min(MAX_ENTRIES);

    let company_dir = hq_root.join("companies").join(company);
    let prefix = prefix.map(str::trim).unwrap_or("").trim_matches('/');
    let target = if prefix.is_empty() {
        company_dir.clone()
    } else {
        company_dir.join(prefix)
    };

    let resolved = resolve_inside(hq_root, &target)?;
    if !resolved.is_dir() {
        return Err(format!("not a directory: {}", target.display()));
    }

    let needle = query
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| q.to_lowercase());

    let entries =
        std::fs::read_dir(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))?;

    let mut out: Vec<VaultEntry> = Vec::new();
    let mut scanned = 0usize;
    for entry in entries.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            break;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) {
            continue;
        }
        // Privacy classes are enforced on the child name too, so `settings/`
        // is not merely un-descendable — it is invisible.
        if has_privacy_excluded_segment(Path::new(&name)) {
            continue;
        }
        if let Some(needle) = needle.as_deref() {
            if !name.to_lowercase().contains(needle) {
                continue;
            }
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_dir = metadata.is_dir();
        out.push(VaultEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            kind: if is_dir { "dir" } else { "file" }.to_string(),
            bytes: if is_dir { 0 } else { metadata.len() },
            modified_at: modified_rfc3339(&metadata),
        });
    }

    out.sort_by(|a, b| {
        let dir_first = (a.kind != "dir").cmp(&(b.kind != "dir"));
        dir_first
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(limit);
    Ok(out)
}

/// Read a bounded slice of a text file under `hq_root` for the composer's
/// "attach as context" flow.
///
/// Rejects: anything outside `hq_root`, anything through a privacy-class
/// segment, non-files, and binary content.
pub fn read_reference_text(
    hq_root: &Path,
    path: &str,
    max_chars: usize,
) -> Result<ReferenceText, String> {
    let requested = path.trim();
    if requested.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        hq_root.join(requested)
    };
    let resolved = resolve_inside(hq_root, &candidate)?;
    if !resolved.is_file() {
        return Err(format!("not a file: {requested}"));
    }

    let max_chars = if max_chars == 0 {
        MAX_REFERENCE_CHARS
    } else {
        max_chars
    }
    .min(MAX_REFERENCE_CHARS);

    // A char is at most 4 bytes, so this head can never under-fill the
    // requested character budget, and never over-reads by more than 4x.
    let byte_budget = max_chars.saturating_mul(4).saturating_add(4);
    let raw = super::read_head(&resolved, byte_budget)
        .ok_or_else(|| format!("read {}: unreadable", resolved.display()))?;
    if raw.contains('\0') {
        return Err(format!("not a text file: {requested}"));
    }

    let file_len = std::fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);
    let text = clamp_preserving(&raw, max_chars);
    let truncated = text.chars().count() < raw.chars().count() || file_len > raw.len() as u64;

    Ok(ReferenceText {
        path: resolved.to_string_lossy().into_owned(),
        text,
        truncated,
    })
}

/// Canonicalize `candidate` (or its nearest existing ancestor, so a missing
/// leaf still gets a real containment answer) and assert it sits inside
/// `hq_root` and clears the privacy classes.
fn resolve_inside(hq_root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = hq_root
        .canonicalize()
        .map_err(|e| format!("resolve hq root {}: {e}", hq_root.display()))?;

    // Canonicalize as much of the path as exists so `..` and symlinks are
    // collapsed before the containment check, then re-attach the missing tail.
    let mut existing = candidate.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let resolved = loop {
        match existing.canonicalize() {
            Ok(resolved) => break resolved,
            Err(_) => match (
                existing.file_name().map(|n| n.to_os_string()),
                existing.parent(),
            ) {
                (Some(name), Some(parent)) if !parent.as_os_str().is_empty() => {
                    tail.push(name);
                    existing = parent.to_path_buf();
                }
                _ => return Err(format!("path does not resolve: {}", candidate.display())),
            },
        }
    };
    let mut resolved = resolved;
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }

    if !resolved.starts_with(&root) {
        return Err(format!(
            "refusing to access a path outside the HQ folder: {}",
            candidate.display()
        ));
    }
    let relative = resolved.strip_prefix(&root).unwrap_or(&resolved);
    if has_privacy_excluded_segment(relative) {
        return Err(format!(
            "refusing to access a private HQ path: {}",
            candidate.display()
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let company = tmp.path().join("companies/indigo");
        for dir in [
            "knowledge/brand",
            "projects/alpha",
            "settings/secrets",
            "data/exports",
            "workers/amelia",
            ".git/refs",
        ] {
            fs::create_dir_all(company.join(dir)).unwrap();
        }
        fs::write(
            company.join("knowledge/brand/voice.md"),
            "# Voice\n\nBe plain.\n",
        )
        .unwrap();
        fs::write(company.join("knowledge/Overview.md"), "overview\n").unwrap();
        fs::write(company.join("settings/secrets/creds.yaml"), "token: nope\n").unwrap();
        fs::write(company.join("data/exports/rows.csv"), "a,b\n").unwrap();
        fs::write(
            company.join("workers/amelia/worker.yaml"),
            "worker:\n  id: amelia\n",
        )
        .unwrap();
        fs::write(company.join("README.md"), "readme\n").unwrap();
        // Outside the company, still inside HQ.
        fs::create_dir_all(tmp.path().join("core/policies")).unwrap();
        fs::write(tmp.path().join("core/policies/e2e.md"), "e2e rules\n").unwrap();
        tmp
    }

    #[test]
    fn lists_one_level_with_dirs_first() {
        let tmp = fixture();
        let entries = list_vault_files(tmp.path(), "indigo", None, None, 200).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // `settings`, `data`, `workers` and `.git` are invisible.
        assert_eq!(names, vec!["knowledge", "projects", "README.md"]);
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[0].bytes, 0);
        assert_eq!(entries[2].kind, "file");
        assert!(entries[2].bytes > 0);
        assert!(entries[2].modified_at.is_some());
    }

    #[test]
    fn prefix_descends_and_query_filters_case_insensitively() {
        let tmp = fixture();
        let entries = list_vault_files(tmp.path(), "indigo", Some("knowledge"), None, 200).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["brand", "Overview.md"]);

        let filtered =
            list_vault_files(tmp.path(), "indigo", Some("knowledge"), Some("OVER"), 200).unwrap();
        let names: Vec<_> = filtered.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Overview.md"]);
    }

    #[test]
    fn privacy_class_prefixes_are_refused_outright() {
        let tmp = fixture();
        for prefix in [
            "settings",
            "data",
            "workers",
            ".git",
            "knowledge/../settings",
        ] {
            let err = list_vault_files(tmp.path(), "indigo", Some(prefix), None, 200)
                .expect_err(&format!("{prefix} must be refused"));
            assert!(
                err.contains("private HQ path") || err.contains("does not resolve"),
                "unexpected error for {prefix}: {err}"
            );
        }
    }

    #[test]
    fn listing_refuses_to_escape_the_hq_root() {
        let tmp = fixture();
        let err = list_vault_files(tmp.path(), "indigo", Some("../../.."), None, 200).unwrap_err();
        assert!(err.contains("outside the HQ folder"), "{err}");
        assert!(list_vault_files(tmp.path(), "", None, None, 200).is_err());
        assert!(list_vault_files(tmp.path(), "../etc", None, None, 200).is_err());
    }

    #[test]
    fn listing_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let company = tmp.path().join("companies/indigo");
        fs::create_dir_all(&company).unwrap();
        for idx in 0..(MAX_ENTRIES + 50) {
            fs::write(company.join(format!("f{idx:04}.md")), "x").unwrap();
        }
        let entries = list_vault_files(tmp.path(), "indigo", None, None, 10_000).unwrap();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(
            list_vault_files(tmp.path(), "indigo", None, None, 7)
                .unwrap()
                .len(),
            7
        );
    }

    #[test]
    fn reference_text_reads_relative_and_absolute_paths_inside_hq() {
        let tmp = fixture();
        let relative =
            read_reference_text(tmp.path(), "companies/indigo/knowledge/brand/voice.md", 0)
                .unwrap();
        assert_eq!(relative.text, "# Voice\n\nBe plain.\n");
        assert!(!relative.truncated);

        let absolute_path = tmp.path().join("core/policies/e2e.md");
        let absolute =
            read_reference_text(tmp.path(), &absolute_path.to_string_lossy(), 0).unwrap();
        assert_eq!(absolute.text, "e2e rules\n");
    }

    #[test]
    fn reference_text_truncates_and_clamps_to_the_hard_max() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("core")).unwrap();
        let path = tmp.path().join("core/big.md");
        fs::write(&path, "é".repeat(MAX_REFERENCE_CHARS + 5_000)).unwrap();

        let short = read_reference_text(tmp.path(), "core/big.md", 100).unwrap();
        assert_eq!(short.text.chars().count(), 100);
        assert!(short.truncated);

        // A request above the hard max is clamped to it.
        let capped = read_reference_text(tmp.path(), "core/big.md", 1_000_000).unwrap();
        assert_eq!(capped.text.chars().count(), MAX_REFERENCE_CHARS);
        assert!(capped.truncated);
    }

    #[test]
    fn reference_text_rejects_escapes_privacy_paths_and_non_files() {
        let tmp = fixture();
        let outside = tmp.path().parent().unwrap().join("escape.md");
        fs::write(&outside, "secret\n").unwrap();

        for (path, needle) in [
            ("../escape.md", "outside the HQ folder"),
            (
                "companies/indigo/../../../escape.md",
                "outside the HQ folder",
            ),
            // One fewer `..` lands back on the HQ root — contained, so the
            // refusal is "no such file", not a containment failure.
            ("companies/indigo/../../escape.md", "not a file"),
            ("/etc/hosts", "outside the HQ folder"),
            (
                "companies/indigo/settings/secrets/creds.yaml",
                "private HQ path",
            ),
            ("companies/indigo/data/exports/rows.csv", "private HQ path"),
            (
                "companies/indigo/workers/amelia/worker.yaml",
                "private HQ path",
            ),
            ("companies/indigo/knowledge", "not a file"),
            ("", "must not be empty"),
        ] {
            let err = read_reference_text(tmp.path(), path, 0)
                .expect_err(&format!("{path} must be refused"));
            assert!(err.contains(needle), "for {path}, got: {err}");
        }
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn reference_text_rejects_binary_content() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("core")).unwrap();
        fs::write(tmp.path().join("core/blob.bin"), [0x00, 0x01, 0x02, 0x00]).unwrap();
        let err = read_reference_text(tmp.path(), "core/blob.bin", 0).unwrap_err();
        assert!(err.contains("not a text file"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn reference_text_rejects_a_symlink_pointing_out_of_hq() {
        let tmp = fixture();
        let outside = tmp.path().parent().unwrap().join("outside-secret.md");
        fs::write(&outside, "secret\n").unwrap();
        let link = tmp.path().join("core/link.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let err = read_reference_text(tmp.path(), "core/link.md", 0).unwrap_err();
        assert!(err.contains("outside the HQ folder"), "{err}");
        let _ = fs::remove_file(outside);
    }
}
