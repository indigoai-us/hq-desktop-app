//! OWNER-R27: session history from the HQ workspace folder on this Mac.
//!
//! Sources, read-only and structure-only (no transcript text):
//! - `workspace/sessions/<session-id>/meta.yaml`: `session_id`, `started_at`,
//!   `company_slug`, `project`, `task`, `title`.
//! - `workspace/threads/T-<date>-<time>-<slug>.json`: checkpoint and handoff
//!   records with `session_id`, `type`, `created_at`, `updated_at` and
//!   `metadata.title`.
//!
//! Thread files are large (hundreds of MB in total), so only files whose name
//! date falls inside the requested range (plus one day) are read, and each
//! parsed summary is cached by path, size and mtime for the life of the app.
//! No per-session token count exists in these records, so none is reported.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSession {
    pub session_id: String,
    /// ISO timestamp from `meta.yaml` `started_at`.
    pub started_at: String,
    pub company: Option<String>,
    pub project: Option<String>,
    pub title: Option<String>,
    /// Latest `updated_at`/`created_at` among the session's thread records.
    pub last_at: Option<String>,
    /// "Handed off" when a handoff record exists, else "Checkpointed".
    pub outcome: Option<String>,
    /// HQ-relative path of the latest handoff, else the latest checkpoint.
    pub thread_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionsPage {
    /// Sessions found in range (before paging).
    pub total: usize,
    pub rows: Vec<LocalSession>,
    /// Median minutes between consecutive session starts in range (this Mac).
    pub median_gap_minutes: Option<f64>,
}

#[derive(Debug, Clone)]
struct ThreadSummary {
    session_id: String,
    kind: String,
    at: String,
    title: Option<String>,
}

type ThreadCache = HashMap<PathBuf, (u64, Option<SystemTime>, Option<ThreadSummary>)>;

fn thread_cache() -> &'static Mutex<ThreadCache> {
    static CACHE: OnceLock<Mutex<ThreadCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Top-level `key: value` pairs of a small YAML file, quotes stripped.
fn meta_fields(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() && value != "null" && value != "~" {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

fn day(ts: &str) -> &str {
    ts.get(..10).unwrap_or(ts)
}

/// Date in a thread file name: `T-2026-09-01-...` or `T-20261001-...`.
fn name_day(name: &str) -> Option<String> {
    let rest = name.strip_prefix("T-")?;
    let dashed = rest.get(..10)?;
    if dashed.len() == 10 && dashed.as_bytes()[4] == b'-' && dashed.as_bytes()[7] == b'-' {
        return Some(dashed.to_string());
    }
    let compact = rest.get(..8)?;
    if compact.bytes().all(|b| b.is_ascii_digit()) {
        return Some(format!("{}-{}-{}", &compact[..4], &compact[4..6], &compact[6..8]));
    }
    None
}

fn shift_day(day: &str, delta: i64) -> String {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.checked_add_signed(chrono::Duration::days(delta)))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| day.to_string())
}

fn summarize_thread(path: &Path) -> Option<ThreadSummary> {
    let meta = fs::metadata(path).ok()?;
    let key = (meta.len(), meta.modified().ok());
    if let Ok(cache) = thread_cache().lock() {
        if let Some((len, mtime, summary)) = cache.get(path) {
            if (*len, *mtime) == key {
                return summary.clone();
            }
        }
    }
    let summary = fs::read_to_string(path).ok().and_then(|text| {
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        let obj = value.as_object()?;
        let metadata = obj.get("metadata").and_then(|m| m.as_object());
        let session_id = obj
            .get("session_id")
            .or_else(|| metadata.and_then(|m| m.get("session_id")))
            .and_then(|v| v.as_str())?
            .to_string();
        let kind = obj
            .get("type")
            .or_else(|| metadata.and_then(|m| m.get("kind")))
            .and_then(|v| v.as_str())
            .unwrap_or("checkpoint")
            .to_string();
        let at = obj
            .get("updated_at")
            .or_else(|| obj.get("created_at"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = metadata
            .and_then(|m| m.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Some(ThreadSummary { session_id, kind, at, title })
    });
    if let Ok(mut cache) = thread_cache().lock() {
        cache.insert(path.to_path_buf(), (key.0, key.1, summary.clone()));
    }
    summary
}

/// Sessions started between `from` and `to` (inclusive `YYYY-MM-DD`), newest
/// first. `allowed` limits company-tagged sessions to the given slugs; a
/// session with no company is always kept.
pub fn scan_local_sessions(
    hq: &Path,
    from: &str,
    to: &str,
    allowed: Option<&HashSet<String>>,
    offset: usize,
    limit: usize,
) -> LocalSessionsPage {
    let mut sessions: Vec<LocalSession> = Vec::new();
    let sessions_dir = hq.join("workspace").join("sessions");
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let meta_path = entry.path().join("meta.yaml");
            let Ok(text) = fs::read_to_string(&meta_path) else { continue };
            let fields = meta_fields(&text);
            let Some(started) = fields.get("started_at") else { continue };
            let started_day = day(started);
            if started_day < from || started_day > to {
                continue;
            }
            let company = fields.get("company_slug").cloned();
            if let (Some(slug), Some(allowed)) = (&company, allowed) {
                if !allowed.contains(slug) {
                    continue;
                }
            }
            let session_id = fields
                .get("session_id")
                .cloned()
                .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
            let title = fields
                .get("title")
                .or_else(|| fields.get("task"))
                .cloned();
            sessions.push(LocalSession {
                session_id,
                started_at: started.clone(),
                company,
                project: fields.get("project").cloned(),
                title,
                last_at: None,
                outcome: None,
                thread_path: None,
            });
        }
    }

    // Thread records for those sessions, read only inside the date window.
    let wanted: HashSet<&str> = sessions.iter().map(|s| s.session_id.as_str()).collect();
    let low = shift_day(from, -1);
    let high = shift_day(to, 1);
    let threads_dir = hq.join("workspace").join("threads");
    let mut by_session: HashMap<String, Vec<(ThreadSummary, String)>> = HashMap::new();
    if !wanted.is_empty() {
        if let Ok(entries) = fs::read_dir(&threads_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with("T-") || !name.ends_with(".json") {
                    continue;
                }
                let Some(file_day) = name_day(&name) else { continue };
                if file_day.as_str() < low.as_str() || file_day.as_str() > high.as_str() {
                    continue;
                }
                let Some(summary) = summarize_thread(&entry.path()) else { continue };
                if !wanted.contains(summary.session_id.as_str()) {
                    continue;
                }
                let rel = format!("workspace/threads/{name}");
                by_session.entry(summary.session_id.clone()).or_default().push((summary, rel));
            }
        }
    }

    for session in &mut sessions {
        let Some(threads) = by_session.get_mut(&session.session_id) else { continue };
        threads.sort_by(|a, b| a.0.at.cmp(&b.0.at));
        session.last_at = threads.iter().map(|t| t.0.at.clone()).filter(|s| !s.is_empty()).max();
        let handoff = threads.iter().rev().find(|t| t.0.kind == "handoff");
        let pick = handoff.or_else(|| threads.last());
        session.outcome = Some(if handoff.is_some() { "Handed off" } else { "Checkpointed" }.to_string());
        if let Some((summary, rel)) = pick {
            session.thread_path = Some(rel.clone());
            if summary.title.is_some() {
                session.title = summary.title.clone();
            }
        }
    }

    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| a.session_id.cmp(&b.session_id)));
    let total = sessions.len();
    let mut starts: Vec<i64> = sessions
        .iter()
        .filter_map(|s| chrono::DateTime::parse_from_rfc3339(&s.started_at).ok())
        .map(|t| t.timestamp())
        .collect();
    starts.sort_unstable();
    let mut gaps: Vec<i64> = starts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_unstable();
    let median_gap_minutes = if gaps.is_empty() {
        None
    } else {
        let mid = gaps.len() / 2;
        let secs = if gaps.len() % 2 == 0 { (gaps[mid - 1] + gaps[mid]) as f64 / 2.0 } else { gaps[mid] as f64 };
        Some((secs / 60.0 * 10.0).round() / 10.0)
    };
    let rows = sessions.into_iter().skip(offset).take(limit).collect();
    LocalSessionsPage { total, rows, median_gap_minutes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn fixture(n: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let hq = dir.path();
        for i in 0..n {
            let id = format!("00000000-0000-4000-8000-{i:012}");
            let day = 1 + ((i / 2) % 28);
            let company = if i % 3 == 0 { "company_slug: acme\n" } else if i % 3 == 1 { "company_slug: other-co\n" } else { "" };
            write(
                &hq.join("workspace/sessions").join(&id).join("meta.yaml"),
                &format!("session_id: {id}\nstarted_at: \"2026-09-{day:02}T10:00:00Z\"\n{company}project: proj-{i}\nsenior: x\n"),
            );
            if i % 2 == 0 {
                let kind = if i % 4 == 0 { "handoff" } else { "checkpoint" };
                // Both file name forms exist in real HQ folders.
                let name = if i % 8 == 0 { format!("T-202609{day:02}-110000-thing-{i}.json") } else { format!("T-2026-09-{day:02}-1100-thing-{i}.json") };
                write(
                    &hq.join("workspace/threads").join(name),
                    &format!(
                        "{{\"created_at\":\"2026-09-{day:02}T11:00:00Z\",\"updated_at\":\"2026-09-{day:02}T11:30:00Z\",\"session_id\":\"{id}\",\"type\":\"{kind}\",\"metadata\":{{\"title\":\"Title {i}\"}},\"conversation_summary\":\"placeholder\"}}"
                    ),
                );
            }
        }
        dir
    }

    #[test]
    fn reads_both_thread_name_dates() {
        assert_eq!(name_day("T-2026-09-01-1100-x.json").as_deref(), Some("2026-09-01"));
        assert_eq!(name_day("T-20261003-101500-x.json").as_deref(), Some("2026-10-03"));
        assert_eq!(name_day("2026-04-14-US-005.json"), None);
    }

    #[test]
    fn meta_fields_reads_top_level_scalars_only() {
        let f = meta_fields("session_id: abc\nstarted_at: \"2026-09-01T00:00:00Z\"\nnested:\n  child: x\nempty:\n");
        assert_eq!(f.get("session_id").map(String::as_str), Some("abc"));
        assert_eq!(f.get("started_at").map(String::as_str), Some("2026-09-01T00:00:00Z"));
        assert!(!f.contains_key("child"));
        assert!(!f.contains_key("empty"));
    }

    #[test]
    fn lists_sessions_in_range_newest_first_with_thread_outcomes() {
        let dir = fixture(4000);
        let allowed: HashSet<String> = ["acme".to_string()].into_iter().collect();
        let page = scan_local_sessions(dir.path(), "2026-09-10", "2026-09-20", Some(&allowed), 0, 50);
        assert!(page.total > 0);
        assert_eq!(page.rows.len(), 50.min(page.total));
        for w in page.rows.windows(2) {
            assert!(w[0].started_at >= w[1].started_at);
        }
        for row in &page.rows {
            assert!(row.started_at.as_str() >= "2026-09-10" && row.started_at.as_str() < "2026-09-21");
            assert!(row.company.is_none() || row.company.as_deref() == Some("acme"));
        }
        let with_thread: Vec<_> = page.rows.iter().filter(|r| r.thread_path.is_some()).collect();
        assert!(!with_thread.is_empty());
        for row in with_thread {
            assert!(row.thread_path.as_deref().unwrap().starts_with("workspace/threads/T-2026"));
            assert!(matches!(row.outcome.as_deref(), Some("Handed off") | Some("Checkpointed")));
            assert!(row.title.as_deref().unwrap().starts_with("Title "));
            assert!(row.last_at.is_some());
        }
        assert!(page.rows.iter().any(|r| r.thread_path.is_none() && r.outcome.is_none()));
    }

    #[test]
    fn pages_and_counts_several_thousand_sessions() {
        let dir = fixture(6000);
        let all = scan_local_sessions(dir.path(), "2026-09-01", "2026-09-30", None, 0, usize::MAX);
        assert_eq!(all.total, 6000);
        let second = scan_local_sessions(dir.path(), "2026-09-01", "2026-09-30", None, 50, 50);
        assert_eq!(second.total, 6000);
        assert_eq!(second.rows, all.rows[50..100].to_vec());
        // Starts fall on the hour each day, many per day: the median gap is 0.
        assert_eq!(all.median_gap_minutes, Some(0.0));
    }

    /// Counts and timing against a real HQ folder (no content printed):
    /// `HQ_LOCAL_SESSIONS_ROOT=/path/to/HQ cargo test --lib real_hq -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_hq_counts_only() {
        let Ok(root) = std::env::var("HQ_LOCAL_SESSIONS_ROOT") else { return };
        let today = chrono::Utc::now().date_naive();
        for days in [7i64, 30, 90] {
            let from = (today - chrono::Duration::days(days - 1)).format("%Y-%m-%d").to_string();
            let to = today.format("%Y-%m-%d").to_string();
            let t = std::time::Instant::now();
            let page = scan_local_sessions(Path::new(&root), &from, &to, None, 0, usize::MAX);
            let with_thread = page.rows.iter().filter(|r| r.thread_path.is_some()).count();
            let with_title = page.rows.iter().filter(|r| r.title.is_some()).count();
            let with_company = page.rows.iter().filter(|r| r.company.is_some()).count();
            println!("  with_title={with_title} with_company={with_company}");
            println!("{days}d total={} with_thread={} median_gap_min={:?} ms={}", page.total, with_thread, page.median_gap_minutes, t.elapsed().as_millis());
        }
    }

    #[test]
    fn empty_workspace_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let page = scan_local_sessions(dir.path(), "2026-09-01", "2026-09-30", None, 0, 10);
        assert_eq!(page.total, 0);
        assert!(page.rows.is_empty());
        assert_eq!(page.median_gap_minutes, None);
    }
}
