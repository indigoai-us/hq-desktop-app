//! HQ-native context readers for the desktop app's in-app Sessions surface.
//!
//! Everything in this module is a **pure reader** over an HQ root on disk:
//! every entry point takes `hq_root: &Path`, touches no globals, spawns no
//! processes, and is unit-testable against a tempdir fixture.
//!
//! Bounding is a hard requirement, not a nicety — a real HQ root carries ~650
//! projects per company, ~2.3k meeting transcripts (20 KB+ each), ~8k signal
//! files, and ~14k skill directories. So every reader here:
//!
//!   * caps the number of directory entries it will even consider,
//!   * caps the number of files it opens,
//!   * reads a bounded **head** of each file rather than the whole thing,
//!   * caps every emitted string, and
//!   * silently skips unreadable/malformed entries instead of failing the call.
//!
//! Sub-modules:
//!   * [`skills`]   — workers registry + `.claude/skills` catalog
//!   * [`projects`] — `companies/{co}/projects/*/prd.json`
//!   * [`meetings`] — `companies/{co}/sources/meetings/*.md`
//!   * [`signals`]  — `companies/{co}/signals/{kind}/*.md` (+ `_index/*.json`)
//!   * [`vault`]    — bounded local company-folder listing + reference text

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};

pub mod meetings;
pub mod projects;
pub mod signals;
pub mod skills;
pub mod vault;

/// Directory / file name segments that are never read or listed by any reader
/// in this module.
///
/// These mirror the anchored `companies/*/{settings,data,workers}/**` privacy
/// classes in [`crate::ignore::DEFAULT_IGNORES`] (credentials, datasets,
/// worker prompt libraries) plus `.git`. They are enforced by *segment name at
/// any depth* here rather than by anchored glob: this module hands paths to a
/// renderer, so the conservative direction is to over-exclude.
pub const PRIVACY_EXCLUDED_SEGMENTS: &[&str] = &["settings", "data", "workers", ".git"];

/// Upper bound on how many bytes any reader will pull off a single file head.
pub(crate) const HEAD_BYTES: usize = 16 * 1024;

/// Read at most `max_bytes` from the front of `path`, lossily decoded.
///
/// Returns `None` when the file cannot be opened. A truncated multi-byte
/// sequence at the cut point is replaced rather than erroring — callers only
/// ever parse frontmatter / leading prose out of the result.
pub(crate) fn read_head(path: &Path, max_bytes: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buf = vec![0u8; max_bytes];
    let mut filled = 0usize;
    loop {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if filled == buf.len() {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Collapse whitespace and clamp to `max_chars` **characters** (not bytes),
/// appending an ellipsis when the value was cut.
pub(crate) fn clamp(value: &str, max_chars: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    clamp_preserving(&collapsed, max_chars)
}

/// Clamp to `max_chars` characters without collapsing internal whitespace.
pub(crate) fn clamp_preserving(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Split a `---\n…\n---\n` YAML frontmatter block off the front of a document.
///
/// Returns `(frontmatter_yaml, body)`. When there is no well-formed
/// frontmatter, the whole input comes back as the body.
///
/// This is deliberately local rather than reusing
/// [`crate::library_local::split_frontmatter`]: the readers here operate on a
/// bounded *head* of a file, so an unterminated block is the normal case for a
/// large document and must degrade to "no frontmatter" rather than swallow the
/// body.
pub(crate) fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let rest = match trimmed.strip_prefix("---\n") {
        Some(rest) => rest,
        None => match trimmed.strip_prefix("---\r\n") {
            Some(rest) => rest,
            None => return (None, trimmed),
        },
    };
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare == "---" || bare == "..." {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(front), body);
        }
        offset += line.len();
    }
    (None, trimmed)
}

/// True when any component of `rel` is a privacy-class segment.
///
/// `rel` is expected to be relative; absolute inputs are still scanned
/// component-wise, so an absolute path through `…/settings/…` is excluded too.
pub fn has_privacy_excluded_segment(rel: &Path) -> bool {
    rel.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|name| PRIVACY_EXCLUDED_SEGMENTS.contains(&name))
            .unwrap_or(false),
        _ => false,
    })
}

/// True for HQ sync conflict artifacts (`name.conflict-<ts>-<hash>`) and for
/// `_`/`.`-prefixed scaffold entries. Every enumerator here skips them: on a
/// real HQ root the conflict copies outnumber the real entries ~14:1.
pub(crate) fn is_skippable_entry_name(name: &str) -> bool {
    name.is_empty() || name.starts_with('.') || name.starts_with('_') || name.contains(".conflict-")
}

/// File modification time as an RFC-3339 UTC string, when available.
pub(crate) fn modified_rfc3339(metadata: &std::fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let datetime: chrono::DateTime<chrono::Utc> = modified.into();
    Some(datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Modification time as a sortable `SystemTime`, defaulting to the UNIX epoch
/// so an unreadable timestamp sorts last rather than dropping the entry.
pub(crate) fn modified_or_epoch(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// Test-only: pin a file's mtime so ordering assertions are deterministic.
#[cfg(test)]
pub(crate) fn set_mtime(path: &Path, unix_secs: u64) {
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix_secs);
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open for mtime")
        .set_modified(when)
        .expect("set mtime");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn clamp_counts_characters_not_bytes() {
        assert_eq!(clamp("héllo wörld", 5), "héll…");
        assert_eq!(clamp("short", 40), "short");
        assert_eq!(clamp("  spaced   out\n\nlines ", 40), "spaced out lines");
    }

    #[test]
    fn split_frontmatter_extracts_a_terminated_block() {
        let (front, body) = split_frontmatter("---\nname: adr\n---\n# Title\n");
        assert_eq!(front, Some("name: adr\n"));
        assert_eq!(body, "# Title\n");
    }

    #[test]
    fn split_frontmatter_tolerates_an_unterminated_block() {
        // A 16 KB head of a 200 KB transcript can cut mid-frontmatter.
        let (front, body) = split_frontmatter("---\nname: adr\nno terminator");
        assert!(front.is_none());
        assert!(body.starts_with("---"));
    }

    #[test]
    fn split_frontmatter_passes_through_plain_documents() {
        let (front, body) = split_frontmatter("# Just a doc\n");
        assert!(front.is_none());
        assert_eq!(body, "# Just a doc\n");
    }

    #[test]
    fn privacy_segments_are_detected_at_any_depth() {
        assert!(has_privacy_excluded_segment(&PathBuf::from(
            "settings/creds.yaml"
        )));
        assert!(has_privacy_excluded_segment(&PathBuf::from(
            "knowledge/data/rows.csv"
        )));
        assert!(has_privacy_excluded_segment(&PathBuf::from(
            "workers/x/worker.yaml"
        )));
        assert!(has_privacy_excluded_segment(&PathBuf::from(
            "a/.git/config"
        )));
        assert!(!has_privacy_excluded_segment(&PathBuf::from(
            "knowledge/brand.md"
        )));
        // Substring matches must NOT trip the guard.
        assert!(!has_privacy_excluded_segment(&PathBuf::from(
            "metadata/x.md"
        )));
        assert!(!has_privacy_excluded_segment(&PathBuf::from(
            "settings-notes.md"
        )));
    }

    #[test]
    fn conflict_and_scaffold_entries_are_skipped() {
        assert!(is_skippable_entry_name(
            "personal:adr.conflict-2026-08-22T22-17-32Z-9aea6b"
        ));
        assert!(is_skippable_entry_name("_archive"));
        assert!(is_skippable_entry_name(".DS_Store"));
        assert!(!is_skippable_entry_name("personal:adr"));
    }

    #[test]
    fn read_head_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.md");
        std::fs::write(&path, "x".repeat(100_000)).unwrap();
        let head = read_head(&path, 1024).unwrap();
        assert_eq!(head.len(), 1024);
        assert!(read_head(&tmp.path().join("missing.md"), 1024).is_none());
    }
}
