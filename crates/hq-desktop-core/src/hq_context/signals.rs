//! Extracted signals from `companies/{co}/signals/`.
//!
//! Real layout, as written by the HQ signal extractor:
//!
//! ```text
//! companies/{co}/signals/
//!   _index/2026-05-18.json      ← [{signal_id, type, source_ref, key, written_at}, …]
//!   decision/<sha256>.md
//!   action_item/<sha256>.md
//!   key_point/…  question/…  risk/…  summary/…  commitment/…
//!   participant_contribution/…
//!   slack-dm/decision/<sha256>.md   ← same kinds, nested under a channel dir
//! ```
//!
//! Each signal `.md` carries frontmatter (`canonical_content`, `citations`,
//! `entity_refs`, `source_ref`, `type`, `signal_id`) followed by a headed prose
//! body. There is **no date in the frontmatter** — the daily `_index/*.json`
//! files are the only authoritative timestamps, so they are the primary read
//! path here: they give `type`, `key` and `written_at` for thousands of signals
//! without opening a single signal file. Only the `limit` files that survive
//! filtering are then opened for a title and snippet.
//!
//! A company can hold 8k+ signal files, so the directory walk is a fallback for
//! roots with no `_index/`, and is itself bounded.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    clamp, is_skippable_entry_name, modified_or_epoch, modified_rfc3339, read_head,
    split_frontmatter, HEAD_BYTES,
};

/// Default `limit` when the caller passes none/0.
pub const DEFAULT_LIMIT: usize = 50;
/// Hard ceiling on signals returned regardless of the requested `limit`.
pub const MAX_LIMIT: usize = 50;
/// Ceiling on `_index/*.json` day files opened.
const MAX_INDEX_FILES: usize = 60;
/// Ceiling on a single `_index` day file's size.
const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
/// Ceiling on files visited by the no-`_index` fallback walk.
const MAX_SCANNED: usize = 20_000;
/// Directory names under `signals/` that are not signal kinds.
const NON_KIND_DIRS: &[&str] = &["_index"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalEntry {
    /// Frontmatter `signal_id` (the content sha), falling back to the file stem.
    pub id: String,
    /// `decision` | `action_item` | `key_point` | `question` | `risk` |
    /// `summary` | `commitment` | `participant_contribution` | …
    pub kind: String,
    /// Leading markdown heading, falling back to a clamped `canonical_content`.
    pub title: String,
    /// `written_at` from `_index`, else the file mtime.
    pub date: Option<String>,
    /// Absolute path to the signal `.md`.
    pub path: String,
    pub snippet: String,
}

#[derive(Debug, Deserialize)]
struct IndexRow {
    #[serde(default)]
    signal_id: String,
    #[serde(default, rename = "type")]
    kind: String,
    /// Path relative to the company directory, e.g.
    /// `signals/decision/<sha>.md`.
    #[serde(default)]
    key: String,
    #[serde(default)]
    written_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SignalFrontmatter {
    #[serde(default)]
    signal_id: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    canonical_content: Option<String>,
}

/// List a company's most recent signals, newest first, optionally filtered to
/// one `kind`.
pub fn list_signals(
    hq_root: &Path,
    company: &str,
    kind: Option<&str>,
    limit: usize,
) -> Vec<SignalEntry> {
    let company = company.trim();
    if company.is_empty() {
        return Vec::new();
    }
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit }.min(MAX_LIMIT);
    let kind = kind.map(str::trim).filter(|k| !k.is_empty());

    let company_dir = hq_root.join("companies").join(company);
    let signals_dir = company_dir.join("signals");
    if !signals_dir.is_dir() {
        return Vec::new();
    }

    let mut candidates = from_index(&company_dir, &signals_dir, kind, limit);
    if candidates.is_empty() {
        candidates = from_walk(&signals_dir, kind, limit);
    }

    candidates.into_iter().filter_map(read_signal).collect()
}

/// A signal we intend to read, with whatever metadata the discovery pass
/// already established.
struct Candidate {
    path: PathBuf,
    kind: String,
    date: Option<String>,
    id: Option<String>,
}

/// Primary path: the daily `_index/*.json` files, newest day first.
fn from_index(
    company_dir: &Path,
    signals_dir: &Path,
    kind: Option<&str>,
    limit: usize,
) -> Vec<Candidate> {
    let index_dir = signals_dir.join("_index");
    let Ok(entries) = std::fs::read_dir(&index_dir) else {
        return Vec::new();
    };
    let mut days: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.contains(".conflict-"))
                .unwrap_or(false)
        })
        .collect();
    // `_index` files are named `YYYY-MM-DD.json`, so lexical descending order
    // is chronological descending order.
    days.sort_by(|a, b| b.cmp(a));
    days.truncate(MAX_INDEX_FILES);

    let mut out: Vec<Candidate> = Vec::new();
    for day in days {
        if out.len() >= limit {
            break;
        }
        let Ok(metadata) = std::fs::metadata(&day) else {
            continue;
        };
        if metadata.len() > MAX_INDEX_BYTES {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&day) else {
            continue;
        };
        let Ok(rows) = serde_json::from_str::<Vec<IndexRow>>(&raw) else {
            continue;
        };
        // Within one day file, newest written_at first.
        let mut rows: Vec<IndexRow> = rows
            .into_iter()
            .filter(|row| !row.key.trim().is_empty())
            .filter(|row| kind.map(|k| row.kind == k).unwrap_or(true))
            .collect();
        rows.sort_by(|a, b| b.written_at.cmp(&a.written_at));

        for row in rows {
            if out.len() >= limit {
                break;
            }
            let path = company_dir.join(row.key.trim_start_matches('/'));
            if !path.is_file() {
                continue;
            }
            out.push(Candidate {
                kind: row.kind,
                date: row.written_at,
                id: (!row.signal_id.trim().is_empty()).then_some(row.signal_id),
                path,
            });
        }
    }
    out
}

/// Fallback for roots with no `_index/`: walk `signals/{kind}/` and
/// `signals/{channel}/{kind}/`, ordering by mtime.
fn from_walk(signals_dir: &Path, kind: Option<&str>, limit: usize) -> Vec<Candidate> {
    let mut found: Vec<(std::time::SystemTime, PathBuf, String)> = Vec::new();

    // Depth 1 = kind dirs; depth 2 = channel dirs whose children are kind dirs
    // (`signals/slack-dm/decision/…`).
    let mut kind_dirs: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(signals_dir) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !entry.path().is_dir() || NON_KIND_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.contains(".conflict-") {
                continue;
            }
            kind_dirs.push((name.clone(), entry.path()));
            if let Ok(nested) = std::fs::read_dir(entry.path()) {
                for child in nested.flatten() {
                    let Ok(child_name) = child.file_name().into_string() else {
                        continue;
                    };
                    if child.path().is_dir() && !child_name.contains(".conflict-") {
                        kind_dirs.push((child_name, child.path()));
                    }
                }
            }
        }
    }

    for (dir_kind, dir) in kind_dirs {
        if found.len() >= MAX_SCANNED {
            break;
        }
        if let Some(wanted) = kind {
            if dir_kind != wanted {
                continue;
            }
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= MAX_SCANNED {
                break;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if is_skippable_entry_name(&name) || !name.ends_with(".md") {
                continue;
            }
            let path = entry.path();
            if path.is_file() {
                found.push((modified_or_epoch(&path), path, dir_kind.clone()));
            }
        }
    }

    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.truncate(limit);
    found
        .into_iter()
        .map(|(_, path, kind)| Candidate {
            path,
            kind,
            date: None,
            id: None,
        })
        .collect()
}

fn read_signal(candidate: Candidate) -> Option<SignalEntry> {
    let raw = read_head(&candidate.path, HEAD_BYTES)?;
    let (front_yaml, body) = split_frontmatter(&raw);
    let front = front_yaml
        .and_then(|yaml| serde_yaml::from_str::<SignalFrontmatter>(yaml).ok())
        .unwrap_or_default();

    let stem = candidate
        .path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    let canonical = front.canonical_content.unwrap_or_default();
    let title = first_heading(body)
        .map(|heading| clamp(heading, 200))
        .filter(|heading| !heading.is_empty())
        .unwrap_or_else(|| clamp(&canonical, 120));

    Some(SignalEntry {
        id: candidate
            .id
            .or(front.signal_id)
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| clamp(id, 200))
            .unwrap_or(stem),
        kind: front
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(|k| clamp(k, 80))
            .unwrap_or(candidate.kind),
        title,
        date: candidate.date.map(|d| clamp(&d, 64)).or_else(|| {
            std::fs::metadata(&candidate.path)
                .ok()
                .and_then(|m| modified_rfc3339(&m))
        }),
        snippet: if canonical.trim().is_empty() {
            clamp(first_paragraph(body), 300)
        } else {
            clamp(&canonical, 300)
        },
        path: candidate.path.to_string_lossy().into_owned(),
    })
}

fn first_heading(body: &str) -> Option<&str> {
    body.lines()
        .map(str::trim)
        .find(|line| line.starts_with('#'))
        .map(|line| line.trim_start_matches('#').trim())
}

fn first_paragraph(body: &str) -> &str {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// Byte-for-byte modelled on a real extracted decision signal.
    fn decision(sha: &str, content: &str) -> String {
        format!(
            r#"---
canonical_content: {content}
citations:
  - location: 00:05:01
    source_ref: sources/meetings/a814de59-e77d-4e82-b801-31bb062c2685.md
    text: Yeah, it does work in cursor.
entity_refs:
  - person/jacob-posel
  - company/audio-hook
source_ref: sources/meetings/a814de59-e77d-4e82-b801-31bb062c2685.md
type: decision
signal_id: {sha}
---
## Decision

{content}

### Reasoning
The team primarily uses Claude and Codex.
"#
        )
    }

    fn action_item(sha: &str, content: &str) -> String {
        format!(
            "---\ncanonical_content: {content}\nentity_refs:\n  - person/stephan-oreilly\ntype: action_item\nsignal_id: {sha}\n---\n# Action Item: Stephan to Continue Portfolio Build\n\n{content}\n"
        )
    }

    /// Fixture with the real two-layer layout plus a daily `_index`.
    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let signals = tmp.path().join("companies/indigo/signals");
        write(
            &signals.join("decision/aaa.md"),
            &decision("aaa", "Use Claude or Codex."),
        );
        write(
            &signals.join("decision/bbb.md"),
            &decision("bbb", "Ship the composer first."),
        );
        write(
            &signals.join("action_item/ccc.md"),
            &action_item("ccc", "Stephan to run /run project."),
        );
        // Channel-nested kind directory.
        write(
            &signals.join("slack-dm/risk/ddd.md"),
            &decision("ddd", "Vault ACL drift risk."),
        );

        write(
            &signals.join("_index/2026-05-18.json"),
            r#"[{"signal_id":"aaa","type":"decision","source_ref":"sources/meetings/x.md","key":"signals/decision/aaa.md","written_at":"2026-05-18T15:13:49.498Z"},
                {"signal_id":"ccc","type":"action_item","source_ref":"sources/meetings/x.md","key":"signals/action_item/ccc.md","written_at":"2026-05-18T15:13:54.448Z"}]"#,
        );
        write(
            &signals.join("_index/2026-05-19.json"),
            r#"[{"signal_id":"bbb","type":"decision","source_ref":"sources/meetings/y.md","key":"signals/decision/bbb.md","written_at":"2026-05-19T09:00:00.000Z"},
                {"signal_id":"ddd","type":"risk","source_ref":"sources/meetings/y.md","key":"signals/slack-dm/risk/ddd.md","written_at":"2026-05-19T10:00:00.000Z"}]"#,
        );
        tmp
    }

    #[test]
    fn index_path_orders_newest_day_first_and_carries_written_at() {
        let tmp = fixture();
        let signals = list_signals(tmp.path(), "indigo", None, 50);
        let ids: Vec<_> = signals.iter().map(|s| s.id.as_str()).collect();
        // 05-19 before 05-18; within a day file, newest written_at first
        // (ccc at 15:13:54 precedes aaa at 15:13:49).
        assert_eq!(ids, vec!["ddd", "bbb", "ccc", "aaa"]);
        assert_eq!(signals[0].date.as_deref(), Some("2026-05-19T10:00:00.000Z"));
        assert_eq!(signals[0].kind, "decision"); // frontmatter `type` wins over the dir name
        assert_eq!(signals[1].id, "bbb");
        assert_eq!(signals[1].title, "Decision");
        assert_eq!(signals[1].snippet, "Ship the composer first.");
    }

    #[test]
    fn kind_filter_narrows_the_listing() {
        let tmp = fixture();
        let decisions = list_signals(tmp.path(), "indigo", Some("decision"), 50);
        let ids: Vec<_> = decisions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["bbb", "aaa"]);

        let actions = list_signals(tmp.path(), "indigo", Some("action_item"), 50);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, "action_item");
        assert_eq!(
            actions[0].title,
            "Action Item: Stephan to Continue Portfolio Build"
        );

        assert!(list_signals(tmp.path(), "indigo", Some("nope"), 50).is_empty());
    }

    #[test]
    fn falls_back_to_a_directory_walk_without_an_index() {
        let tmp = tempfile::tempdir().unwrap();
        let signals = tmp.path().join("companies/indigo/signals");
        write(&signals.join("decision/aaa.md"), &decision("aaa", "Older."));
        write(&signals.join("risk/bbb.md"), &decision("bbb", "Newer."));
        write(
            &signals.join("slack-dm/question/ccc.md"),
            &decision("ccc", "Newest."),
        );
        super::super::set_mtime(&signals.join("decision/aaa.md"), 1_700_000_000);
        super::super::set_mtime(&signals.join("risk/bbb.md"), 1_700_000_600);
        super::super::set_mtime(&signals.join("slack-dm/question/ccc.md"), 1_700_001_200);

        let found = list_signals(tmp.path(), "indigo", None, 50);
        let ids: Vec<_> = found.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ccc", "bbb", "aaa"],
            "channel-nested kinds are walked too"
        );
        assert!(found[0].date.is_some(), "mtime fallback fills the date");
    }

    #[test]
    fn walk_fallback_honours_the_kind_filter_including_nested_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let signals = tmp.path().join("companies/indigo/signals");
        write(
            &signals.join("decision/aaa.md"),
            &decision("aaa", "A decision."),
        );
        write(
            &signals.join("slack-dm/question/ccc.md"),
            &decision("ccc", "A question."),
        );
        let questions = list_signals(tmp.path(), "indigo", Some("question"), 50);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "ccc");
    }

    #[test]
    fn limit_is_clamped_to_the_hard_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let signals_dir = tmp.path().join("companies/indigo/signals");
        for idx in 0..(MAX_LIMIT + 20) {
            let sha = format!("{idx:064x}");
            write(
                &signals_dir.join(format!("decision/{sha}.md")),
                &decision(&sha, "x"),
            );
        }
        assert_eq!(list_signals(tmp.path(), "indigo", None, 10).len(), 10);
        assert_eq!(
            list_signals(tmp.path(), "indigo", None, 10_000).len(),
            MAX_LIMIT
        );
        assert_eq!(
            list_signals(tmp.path(), "indigo", None, 0).len(),
            DEFAULT_LIMIT
        );
    }

    #[test]
    fn index_rows_pointing_at_missing_files_are_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        let signals = tmp.path().join("companies/indigo/signals");
        write(
            &signals.join("decision/aaa.md"),
            &decision("aaa", "Present."),
        );
        write(
            &signals.join("_index/2026-05-18.json"),
            r#"[{"signal_id":"aaa","type":"decision","key":"signals/decision/aaa.md","written_at":"2026-05-18T15:00:00Z"},
                {"signal_id":"gone","type":"decision","key":"signals/decision/gone.md","written_at":"2026-05-18T16:00:00Z"}]"#,
        );
        let found = list_signals(tmp.path(), "indigo", None, 50);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "aaa");
    }

    #[test]
    fn missing_company_or_signals_directory_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_signals(tmp.path(), "indigo", None, 50).is_empty());
        assert!(list_signals(tmp.path(), "", None, 50).is_empty());
    }
}
