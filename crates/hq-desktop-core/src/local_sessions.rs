//! OWNER-R27: session history from the HQ workspace folder on this Mac.
//!
//! Sources, read-only and structure-only (no transcript text):
//! - `workspace/sessions/<session-id>/meta.yaml`: `session_id`, `started_at`,
//!   `company_slug`, `project`, `task`, `title`.
//! - `workspace/threads/T-<date>-<time>-<slug>.json`: checkpoint and handoff
//!   records with `session_id`, `type`, `created_at`, `updated_at` and
//!   `metadata.title`.
//!
//! - Claude Code transcripts `<transcripts>/<project-dir>/<session-id>.jsonl`:
//!   only the `custom-title` / `agent-name` records (the session title set by
//!   `set_session_title`), the `cwd` field, and the file mtime (last
//!   activity). HQ never writes the title into `meta.yaml`, so without this
//!   source almost every row had no title, project or length. Only rows on
//!   the requested page are enriched, and each transcript summary is cached by
//!   path, size and mtime.
//! - Codex: `<codex>/session_index.jsonl` (`id`, `thread_name`) for the title
//!   and `<codex>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` for the
//!   `session_meta` cwd and the file mtime.
//! - When a session was never named (most headless lanes), the title falls
//!   back to a one-line summary of the first prompt: its first text line,
//!   capped at 80 characters. No other message text is read.
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TranscriptSummary {
    title: Option<String>,
    /// First prompt, one line, for sessions that were never named.
    first_prompt: Option<String>,
    cwd: Option<String>,
    last_at: Option<String>,
}

type TranscriptCache = HashMap<PathBuf, (u64, Option<SystemTime>, TranscriptSummary)>;

fn transcript_cache() -> &'static Mutex<TranscriptCache> {
    static CACHE: OnceLock<Mutex<TranscriptCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Longest first-prompt summary shown as a title.
const PROMPT_SUMMARY_CHARS: usize = 80;

/// First meaningful text line of a prompt, whitespace collapsed and capped.
/// Injected context blocks (`<...>` wrappers, slash-command markup) are skipped.
fn prompt_summary(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('<') && !l.starts_with("```"))?;
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PROMPT_SUMMARY_CHARS {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(PROMPT_SUMMARY_CHARS - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// Text of the first user prompt in a Claude Code transcript head.
fn claude_first_prompt(text: &str) -> Option<String> {
    for line in text.lines() {
        if !line.contains("\"type\":\"user\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if value.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let content = value.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(serde_json::Value::String(s)) => Some(s.as_str()),
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .find(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str()),
            _ => None,
        };
        if let Some(summary) = text.and_then(prompt_summary) {
            return Some(summary);
        }
    }
    None
}

/// Text of the first user prompt in a Codex rollout head.
fn codex_first_prompt(text: &str) -> Option<String> {
    for line in text.lines() {
        if !line.contains("\"role\":\"user\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(parts) = value.get("payload").and_then(|p| p.get("content")).and_then(|c| c.as_array()) else { continue };
        for part in parts {
            if let Some(summary) = part.get("text").and_then(|t| t.as_str()).and_then(prompt_summary) {
                return Some(summary);
            }
        }
    }
    None
}

/// Bytes read from the head of a transcript to find the first prompt.
const TRANSCRIPT_HEAD: u64 = 256 * 1024;

fn read_head(path: &Path, bytes: u64) -> String {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(bytes).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Bytes read from the end of a transcript before falling back to a full scan.
const TRANSCRIPT_TAIL: u64 = 512 * 1024;
/// Upper bound for the full scan when the tail has no title record.
const TRANSCRIPT_SCAN_CAP: u64 = 32 * 1024 * 1024;

/// Title and cwd from transcript lines, latest record wins. Only metadata
/// records are parsed; message text is never read into the result.
fn scan_transcript_lines(text: &str, out: &mut TranscriptSummary) {
    for line in text.lines() {
        let is_title = line.contains("\"type\":\"custom-title\"") || line.contains("\"type\":\"agent-name\"");
        if is_title {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                let title = value
                    .get("customTitle")
                    .or_else(|| value.get("agentName"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                if title.is_some() {
                    out.title = title;
                }
            }
            continue;
        }
        if let Some(idx) = line.find("\"cwd\":\"") {
            let rest = &line[idx + 7..];
            if let Some(end) = rest.find('"') {
                let cwd = &rest[..end];
                if !cwd.is_empty() {
                    out.cwd = Some(cwd.replace("\\\\", "\\"));
                }
            }
        }
    }
}

fn summarize_transcript(path: &Path) -> Option<TranscriptSummary> {
    use std::io::{Read, Seek, SeekFrom};
    let meta = fs::metadata(path).ok()?;
    let key = (meta.len(), meta.modified().ok());
    if let Ok(cache) = transcript_cache().lock() {
        if let Some((len, mtime, summary)) = cache.get(path) {
            if (*len, *mtime) == key {
                return Some(summary.clone());
            }
        }
    }
    let mut summary = TranscriptSummary {
        last_at: key.1.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        ..TranscriptSummary::default()
    };
    let mut file = fs::File::open(path).ok()?;
    let len = meta.len();
    let start = len.saturating_sub(TRANSCRIPT_TAIL);
    let mut tail = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_ok() && file.by_ref().take(TRANSCRIPT_TAIL).read_to_end(&mut tail).is_ok() {
        scan_transcript_lines(&String::from_utf8_lossy(&tail), &mut summary);
    }
    if summary.title.is_none() && start > 0 {
        // Title records can sit only near the start of a long transcript.
        let mut head = Vec::new();
        if file.seek(SeekFrom::Start(0)).is_ok() && file.by_ref().take(start.min(TRANSCRIPT_SCAN_CAP)).read_to_end(&mut head).is_ok() {
            let mut early = TranscriptSummary::default();
            scan_transcript_lines(&String::from_utf8_lossy(&head), &mut early);
            summary.title = early.title;
            if summary.cwd.is_none() {
                summary.cwd = early.cwd;
            }
        }
    }
    if summary.title.is_none() {
        summary.first_prompt = claude_first_prompt(&read_head(path, TRANSCRIPT_HEAD));
    }
    if let Ok(mut cache) = transcript_cache().lock() {
        cache.insert(path.to_path_buf(), (key.0, key.1, summary.clone()));
    }
    Some(summary)
}

/// `<transcripts>/<any project dir>/<session-id>.jsonl` for the wanted ids.
fn transcript_paths(root: &Path, wanted: &HashSet<&str>) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let Ok(dirs) = fs::read_dir(root) else { return out };
    for dir in dirs.flatten() {
        for id in wanted {
            if out.contains_key(*id) {
                continue;
            }
            let path = dir.path().join(format!("{id}.jsonl"));
            if path.is_file() {
                out.insert((*id).to_string(), path);
            }
        }
    }
    out
}

/// Where agent runtimes keep their own session records on this Mac.
#[derive(Debug, Clone, Default)]
pub struct TranscriptRoots {
    /// Claude Code `~/.claude/projects`.
    pub claude: Option<PathBuf>,
    /// Codex `~/.codex`.
    pub codex: Option<PathBuf>,
}

impl TranscriptRoots {
    /// The default locations under a home folder.
    pub fn under_home(home: &Path) -> Self {
        Self { claude: Some(home.join(".claude").join("projects")), codex: Some(home.join(".codex")) }
    }
}

/// Latest `thread_name` per id from Codex's `session_index.jsonl`.
fn codex_thread_names(codex: &Path, wanted: &HashSet<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string(codex.join("session_index.jsonl")) else { return out };
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let id = value.get("id").and_then(|v| v.as_str());
        let name = value.get("thread_name").and_then(|v| v.as_str()).map(str::trim);
        if let (Some(id), Some(name)) = (id, name) {
            if wanted.contains(id) && !name.is_empty() {
                out.insert(id.to_string(), name.to_string());
            }
        }
    }
    out
}

/// Codex rollout files for the page's ids, looked up in the day folders
/// around each session's start.
fn codex_rollouts(codex: &Path, rows: &[LocalSession]) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let mut by_dir: HashMap<PathBuf, Vec<&str>> = HashMap::new();
    for row in rows {
        for delta in [-1i64, 0, 1] {
            let shifted = shift_day(day(&row.started_at), delta);
            let parts: Vec<&str> = shifted.split('-').collect();
            if parts.len() != 3 {
                continue;
            }
            let dir = codex.join("sessions").join(parts[0]).join(parts[1]).join(parts[2]);
            by_dir.entry(dir).or_default().push(row.session_id.as_str());
        }
    }
    for (dir, ids) in by_dir {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            if let Some(id) = ids.iter().find(|id| name.ends_with(&format!("-{id}.jsonl"))) {
                out.entry((*id).to_string()).or_insert_with(|| entry.path());
            }
        }
    }
    out
}

/// cwd from the `session_meta` first line, and the mtime as last activity.
fn summarize_codex_rollout(path: &Path) -> Option<TranscriptSummary> {
    let meta = fs::metadata(path).ok()?;
    let key = (meta.len(), meta.modified().ok());
    if let Ok(cache) = transcript_cache().lock() {
        if let Some((len, mtime, summary)) = cache.get(path) {
            if (*len, *mtime) == key {
                return Some(summary.clone());
            }
        }
    }
    let head = read_head(path, TRANSCRIPT_HEAD);
    let cwd = head
        .lines()
        .next()
        .and_then(|first| serde_json::from_str::<serde_json::Value>(first).ok())
        .and_then(|v| v.get("payload").and_then(|p| p.get("cwd")).and_then(|c| c.as_str()).map(str::to_string));
    let summary = TranscriptSummary {
        title: None,
        first_prompt: codex_first_prompt(&head),
        cwd,
        last_at: key.1.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    };
    if let Ok(mut cache) = transcript_cache().lock() {
        cache.insert(path.to_path_buf(), (key.0, key.1, summary.clone()));
    }
    Some(summary)
}

/// Repo name from a working directory under `repos/public|private/<name>`.
fn repo_from_cwd(cwd: &str) -> Option<String> {
    let parts: Vec<&str> = cwd.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    let i = parts.iter().position(|p| *p == "repos")?;
    let next = *parts.get(i + 1)?;
    let name = if next == "public" || next == "private" { parts.get(i + 2)? } else { &next };
    Some((*name).to_string())
}

/// Product segment of an HQ-grammar title: `{glyph} COMPANY · Product · subject`.
fn product_from_title(title: &str) -> Option<String> {
    let parts: Vec<&str> = title.split(" · ").map(str::trim).collect();
    if parts.len() >= 3 && !parts[1].is_empty() {
        Some(parts[1].to_string())
    } else {
        None
    }
}

/// Fill title, project and last activity from the session's transcript.
fn enrich_from_transcript(session: &mut LocalSession, summary: &TranscriptSummary) {
    if session.title.is_none() {
        session.title = summary.title.clone();
    }
    let named = session.title.is_some();
    if session.project.is_none() {
        session.project = summary
            .cwd
            .as_deref()
            .and_then(repo_from_cwd)
            .or_else(|| session.title.as_deref().and_then(product_from_title));
    }
    if !named {
        session.title = summary.first_prompt.clone();
    }
    match (&session.last_at, &summary.last_at) {
        (None, Some(t)) => session.last_at = Some(t.clone()),
        (Some(a), Some(t)) if t > a => session.last_at = Some(t.clone()),
        _ => {}
    }
}

/// Sessions started between `from` and `to`, without transcript enrichment.
pub fn scan_local_sessions(
    hq: &Path,
    from: &str,
    to: &str,
    allowed: Option<&HashSet<String>>,
    offset: usize,
    limit: usize,
) -> LocalSessionsPage {
    scan_local_sessions_with(hq, &TranscriptRoots::default(), from, to, allowed, offset, limit)
}

/// Sessions started between `from` and `to` (inclusive `YYYY-MM-DD`), newest
/// first. `allowed` limits company-tagged sessions to the given slugs; a
/// session with no company is always kept. Rows on the returned page take
/// their title, project and last activity from the agent runtimes' own
/// records (`transcripts`) when `meta.yaml` and thread records have none.
pub fn scan_local_sessions_with(
    hq: &Path,
    transcripts: &TranscriptRoots,
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
    let mut rows: Vec<LocalSession> = sessions.into_iter().skip(offset).take(limit).collect();
    let owned: Vec<String> = rows.iter().map(|r| r.session_id.clone()).collect();
    let ids: HashSet<&str> = owned.iter().map(String::as_str).collect();
    let claude = transcripts.claude.as_deref().map(|root| transcript_paths(root, &ids)).unwrap_or_default();
    let (codex_names, codex_files) = match transcripts.codex.as_deref() {
        Some(root) => (codex_thread_names(root, &ids), codex_rollouts(root, &rows)),
        None => (HashMap::new(), HashMap::new()),
    };
    for row in &mut rows {
        if let Some(summary) = claude.get(&row.session_id).and_then(|p| summarize_transcript(p)) {
            enrich_from_transcript(row, &summary);
            continue;
        }
        let mut summary = codex_files.get(&row.session_id).and_then(|p| summarize_codex_rollout(p)).unwrap_or_default();
        summary.title = codex_names.get(&row.session_id).cloned();
        enrich_from_transcript(row, &summary);
    }
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
            let roots = std::env::var("HOME").map(|h| TranscriptRoots::under_home(Path::new(&h))).unwrap_or_default();
            let page = scan_local_sessions_with(Path::new(&root), &roots, &from, &to, None, 0, 50);
            let with_thread = page.rows.iter().filter(|r| r.thread_path.is_some()).count();
            let with_title = page.rows.iter().filter(|r| r.title.is_some()).count();
            let with_company = page.rows.iter().filter(|r| r.company.is_some()).count();
            let with_project = page.rows.iter().filter(|r| r.project.is_some()).count();
            let with_last = page.rows.iter().filter(|r| r.last_at.is_some()).count();
            println!("  first 50: with_title={with_title} with_project={with_project} with_last={with_last} with_company={with_company}");
            println!("{days}d total={} with_thread={} median_gap_min={:?} ms={}", page.total, with_thread, page.median_gap_minutes, t.elapsed().as_millis());
        }
    }

    fn transcript_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let hq = dir.path().join("hq");
        let tx = dir.path().join("projects/-Users-x-HQ");
        let meta = |id: &str, extra: &str| {
            write(&hq.join("workspace/sessions").join(id).join("meta.yaml"), &format!("session_id: {id}\nstarted_at: \"2026-10-05T10:00:00Z\"\n{extra}senior: user\n"));
        };
        // Full: company, title in transcript, cwd inside a repo.
        meta("s-full", "company_slug: acme\n");
        write(
            &tx.join("s-full.jsonl"),
            "{\"type\":\"user\",\"cwd\":\"/Users/x/HQ/repos/private/widget-app\",\"message\":{\"content\":\"secret prompt text\"}}\n{\"type\":\"custom-title\",\"customTitle\":\"ACME · Widget · fix the signup page\",\"sessionId\":\"s-full\"}\n",
        );
        // Title only: HQ-root cwd, so project comes from the title's product.
        meta("s-title", "company_slug: acme\n");
        write(&tx.join("s-title.jsonl"), "{\"type\":\"agent-name\",\"agentName\":\"ACME · Billing · invoices\"}\n{\"cwd\":\"/Users/x/HQ\"}\n");
        // Unbound company, plain title.
        meta("s-unbound", "");
        write(&tx.join("s-unbound.jsonl"), "{\"type\":\"custom-title\",\"customTitle\":\"quick question\"}\n");
        // Never named: the first prompt's first line stands in.
        meta("s-prompt", "");
        write(
            &tx.join("s-prompt.jsonl"),
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"<command-name>x</command-name>\"}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>skip</system-reminder>\\nRead your brief and   carry it out now.\\nsecond line stays private\"}]}}\n",
        );
        // No transcript at all: no end time, nothing invented.
        meta("s-bare", "company_slug: acme\n");
        // Codex: named thread (latest name wins), rollout cwd inside a repo.
        meta("c-codex", "company_slug: acme\n");
        write(&dir.path().join("codex/session_index.jsonl"), "{\"id\":\"c-codex\",\"thread_name\":\"Old name\"}\n{\"id\":\"c-codex\",\"thread_name\":\"Fix deploy script\"}\n");
        write(
            &dir.path().join("codex/sessions/2026/10/05/rollout-2026-10-05T10-00-00-c-codex.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c-codex\",\"cwd\":\"/Users/x/HQ/repos/public/deploy-kit\"}}\n{\"type\":\"response_item\",\"payload\":{\"content\":\"secret prompt text\"}}\n",
        );
        dir
    }

    #[test]
    fn transcripts_fill_title_project_and_length() {
        let dir = transcript_fixture();
        let roots = TranscriptRoots { claude: Some(dir.path().join("projects")), codex: Some(dir.path().join("codex")) };
        let page = scan_local_sessions_with(&dir.path().join("hq"), &roots, "2026-10-01", "2026-10-31", None, 0, 50);
        let row = |id: &str| page.rows.iter().find(|r| r.session_id == id).unwrap().clone();
        let full = row("s-full");
        assert_eq!(full.title.as_deref(), Some("ACME · Widget · fix the signup page"));
        assert_eq!(full.project.as_deref(), Some("widget-app"));
        assert!(full.last_at.is_some());
        let title = row("s-title");
        assert_eq!(title.project.as_deref(), Some("Billing"));
        let unbound = row("s-unbound");
        assert_eq!(unbound.company, None);
        assert_eq!(unbound.title.as_deref(), Some("quick question"));
        assert_eq!(unbound.project, None);
        let bare = row("s-bare");
        assert_eq!((bare.title, bare.project, bare.last_at), (None, None, None));
        let prompt = row("s-prompt");
        assert_eq!(prompt.title.as_deref(), Some("Read your brief and carry it out now."));
        assert!(!format!("{:?}", page.rows).contains("second line stays private"));
        let codex = row("c-codex");
        assert_eq!(codex.title.as_deref(), Some("Fix deploy script"));
        assert_eq!(codex.project.as_deref(), Some("deploy-kit"));
        assert!(codex.last_at.is_some());
        // Prompt text never reaches the row.
        assert!(!format!("{:?}", page.rows).contains("secret prompt text"));
        // Without a transcripts root nothing is enriched.
        let plain = scan_local_sessions(&dir.path().join("hq"), "2026-10-01", "2026-10-31", None, 0, 50);
        assert!(plain.rows.iter().all(|r| r.title.is_none()));
    }

    #[test]
    fn prompt_summary_is_one_capped_line() {
        assert_eq!(prompt_summary("<ctx>\n\n  hello   world \nmore").as_deref(), Some("hello world"));
        let long = "x".repeat(200);
        let s = prompt_summary(&long).unwrap();
        assert_eq!(s.chars().count(), PROMPT_SUMMARY_CHARS);
        assert!(s.ends_with('…'));
        assert_eq!(prompt_summary("<only>\n"), None);
    }

    #[test]
    fn repo_and_product_parsing() {
        assert_eq!(repo_from_cwd("/Users/x/HQ/repos/private/hq-desktop-app/workspace/worktrees/t").as_deref(), Some("hq-desktop-app"));
        assert_eq!(repo_from_cwd("/Users/x/HQ"), None);
        assert_eq!(product_from_title("INDIGO · Desktop · beta cleanup").as_deref(), Some("Desktop"));
        assert_eq!(product_from_title("just words"), None);
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
