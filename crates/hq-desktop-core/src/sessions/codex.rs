//! Local Codex session reader (US-003).
//!
//! Enumerates the user's local OpenAI Codex sessions from the on-disk rollout
//! store and maps each to the shared [`AgentSession`] contract (US-001) with
//! `origin = local` and `tool = codex`. Mirrors the Claude reader
//! (`commands/sessions/claude.rs`) in structure, error handling, and test style.
//!
//! ## Where Codex keeps its sessions (verified against a real `~/.codex`)
//!
//! Codex maintains a lightweight **index** plus per-session **rollout** logs:
//!
//! ```text
//! ~/.codex/session_index.jsonl                       (one line per session)
//! ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl   (live rollouts)
//! ~/.codex/archived_sessions/rollout-<ts>-<id>.jsonl     (archived rollouts, flat)
//! ```
//!
//! A single machine can accumulate hundreds of rollouts, many of them very large
//! (hundreds of MB — a 407 MB rollout was observed on this box). Enumeration must
//! therefore stay cheap: scandir + stat + a tiny bounded **head** read only.
//!
//! ## Observed index line shape (`session_index.jsonl`)
//!
//! One compact JSON object per line (verified against a real index, Codex
//! 0.128.x):
//!
//! ```jsonc
//! {
//!   "id": "019de12c-d83e-78c2-9bb3-cbb8146965e4",
//!   "thread_name": "Sync HQ with hq-core-stage PRs",
//!   "updated_at": "2026-05-01T01:36:06.218891Z"
//! }
//! ```
//!
//! - `id` — the stable Codex session id (also embedded in the rollout filename).
//! - `thread_name` — a human label for the session (used as the project label
//!   fallback when the rollout's cwd is unavailable).
//! - `updated_at` — ISO-8601 last-activity timestamp; this is the index's
//!   liveness signal. The index is the **fast path**: we map a session from its
//!   index line alone, and only crack open the rollout head for `cwd` / `model`.
//!
//! ## Observed rollout line shapes (`rollout-*.jsonl`)
//!
//! A rollout is heterogeneous ndjson. Only the first few records carry the
//! metadata we need (verified against real rollouts, Codex 0.128.x):
//!
//! ```jsonc
//! // line 1 — always present, the session header:
//! {
//!   "timestamp": "2026-05-01T01:38:52.811Z",
//!   "type": "session_meta",
//!   "payload": {
//!     "id": "019de12f-9c8a-77c0-b8d1-12895c1e4b68",
//!     "timestamp": "2026-05-01T01:38:07.121Z",   // session start
//!     "cwd": "/Users/corey/HQ",
//!     "originator": "Codex Desktop",
//!     "cli_version": "0.128.0-alpha.1",
//!     "source": "vscode",
//!     "model_provider": "openai"
//!   }
//! }
//! // a few lines later — the first turn's context, carries the model:
//! {
//!   "timestamp": "2026-06-04T03:04:39.480Z",
//!   "type": "turn_context",
//!   "payload": { "cwd": "/Users/corey/Documents/HQ", "model": "gpt-5.5", … }
//! }
//! ```
//!
//! `id`, `cwd`, and the session-start `timestamp` come from `session_meta`'s
//! `payload`; `model` lives on the first `turn_context` payload (the
//! `session_meta` header does NOT carry a model, only `model_provider`). Both of
//! these records sit at the **head** of the file, so a small bounded head read
//! recovers everything — we never read the whole rollout.
//!
//! ## Performance contract (PRD performanceRequirements — HARD)
//!
//! Enumeration is **index scan + scandir + stat + a bounded head read only**. We
//! never parse a rollout front-to-back: a multi-hundred-MB rollout would blow the
//! latency budget. For each session we:
//!
//!   1. Read `session_index.jsonl` (small — KBs) to enumerate session ids +
//!      last-activity, OR scandir the rollout dirs when the index is absent.
//!   2. `metadata()` each rollout for size + mtime (stat) — mtime is the
//!      fallback liveness signal when the index lacks `updated_at`.
//!   3. Read at most [`HEAD_BYTES`] from the **start** of the rollout and parse
//!      only the leading records to recover `cwd` and `model`. The `session_meta`
//!      header and first `turn_context` are within the first few KB.
//!
//! The head read is capped regardless of file size (`take(HEAD_BYTES)`), so a
//! 407 MB rollout costs the same as a 5 KB one. The
//! `large_rollout_is_not_fully_read` unit test pins this: it writes a rollout far
//! larger than `HEAD_BYTES` and asserts the reader still extracts the head fields
//! without reading the whole thing.
//!
//! ## Status (coarse — US-004 refines)
//!
//! Like the Claude reader, status here is a coarse mtime/last-activity-only
//! classification; the dedicated liveness engine (US-004) adds the process
//! cross-check and `awaiting_input` detection.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::scan_cache::StableCache;
use super::{AgentOrigin, AgentSession, AgentTool, SessionStatus};

/// Memo for the rollout **head** parse.
///
/// The Mission Control poller re-scans every few seconds and used to re-open and
/// re-parse the head of every rollout on disk — thousands of files on a working
/// machine, and a large share of the app's idle CPU. A rollout is append-only:
/// the `session_meta` / `turn_context` records we read live at the *head*, so for
/// a given path the parse result cannot change. Keyed by path alone, and pruned
/// each scan to the rollouts that still exist. See `super::scan_cache`.
static HEAD_CACHE: StableCache<HeadInfo> = StableCache::new();

/// Provenance tag stamped on every record this reader emits (US-001 `source`).
const SOURCE_TAG: &str = "codex-rollout";

/// Max bytes read from the **start** of each rollout. The `session_meta` header
/// is line 1 and the first `turn_context` (carrying the model) follows within a
/// handful of records, so a small head window reliably catches both `cwd` and
/// `model` while staying tiny relative to a multi-hundred-MB rollout. This is the
/// cap that makes enumeration O(files), not O(total rollout bytes) — see the
/// module performance contract. 64 KiB.
const HEAD_BYTES: u64 = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Status windows (coarse — US-004 refines)
// ─────────────────────────────────────────────────────────────────────────────

/// How long after the last activity a session is still considered actively
/// `Running`. Beyond this it's `Idle`; far beyond it's `Ended`. Kept in lock-step
/// with the Claude reader's windows so both tools classify identically; the
/// liveness engine (US-004) adds the process cross-check and `awaiting_input`.
const RUNNING_WINDOW_SECS: u64 = 90; // fresh activity → running
const IDLE_WINDOW_SECS: u64 = 30 * 60; // < 30m → idle, else ended

// ─────────────────────────────────────────────────────────────────────────────
// Index line shape
// ─────────────────────────────────────────────────────────────────────────────

/// One line of `~/.codex/session_index.jsonl`. Everything but `id` is optional so
/// a malformed/foreign line deserialises to "id + None" rather than erroring the
/// whole scan; a line without an `id` is skipped entirely.
#[derive(Debug, Default, Deserialize)]
struct IndexLine {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    thread_name: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollout head shapes
// ─────────────────────────────────────────────────────────────────────────────

/// A single rollout record we care about. We only ever look at the leading
/// `session_meta` and `turn_context` records, both of which wrap their fields in
/// a `payload` object. Foreign record types deserialise to "all None".
#[derive(Debug, Default, Deserialize)]
struct RolloutLine {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    payload: Option<RolloutPayload>,
}

/// The `payload` of a `session_meta` / `turn_context` record. `cwd` appears on
/// both; `model` on `turn_context`; `id` + session-start `timestamp` on
/// `session_meta`.
#[derive(Debug, Default, Deserialize)]
struct RolloutPayload {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<Vec<RolloutContent>>,
    #[serde(default)]
    source: Option<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct RolloutContent {
    #[serde(default)]
    text: Option<String>,
}

/// Fields recovered from a rollout's head.
#[derive(Clone, Debug, Default)]
struct HeadInfo {
    /// `payload.id` from `session_meta` (authoritative id; falls back to the
    /// filename-derived id when absent).
    id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    /// Session-start `timestamp` from `session_meta.payload`.
    started_at: Option<String>,
    company: Option<String>,
    project: Option<String>,
    first_user_message: Option<String>,
    source: Option<serde_json::Value>,
}

// ─────────────────────────────────────────────────────────────────────────────
// A located rollout (filename-derived id + path + stat)
// ─────────────────────────────────────────────────────────────────────────────

/// A rollout file we located on disk, keyed by its filename-embedded session id.
pub struct RolloutFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: SystemTime,
}

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────────

/// `~/.codex` — the root of Codex's session store.
pub fn codex_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".codex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure scanner (testable)
// ─────────────────────────────────────────────────────────────────────────────

/// Enumerate the local Codex sessions under `codex_dir` and map each to an
/// [`AgentSession`]. Pure over its inputs so tests can point it at a fixture tree
/// and pin a deterministic `now`. Never panics: unreadable dirs/files are
/// skipped, one bad file can't blank the whole list.
///
/// Strategy: locate every rollout on disk (under `sessions/**` and
/// `archived_sessions/`) keyed by its filename-embedded id, then layer the index
/// over the top for last-activity + thread-name. A session that appears only in
/// the index but has no rollout on disk is skipped (we need at least the file to
/// stat); a rollout with no index line is still emitted (mtime is the fallback
/// liveness signal), so neither store is a single point of failure.
///
/// `now` is injected (not `SystemTime::now()`) so the age→status window is
/// deterministic under test.
pub fn scan_codex_sessions(codex_dir: &Path, now: SystemTime) -> Vec<AgentSession> {
    scan_codex_sessions_with_hq(codex_dir, None, now)
}

/// Enrich native conversations with app-owned metadata when an HQ root exists.
pub fn scan_codex_sessions_with_hq(
    codex_dir: &Path,
    hq_root: Option<&Path>,
    now: SystemTime,
) -> Vec<AgentSession> {
    let rollouts = enumerate_rollout_files(codex_dir);

    if rollouts.is_empty() {
        // No rollouts on disk → no local Codex sessions. Empty, not error.
        return Vec::new();
    }

    // Read the index (best-effort) for last-activity + thread-name, keyed by id.
    let index = read_index(&codex_dir.join("session_index.jsonl"));
    // HQ generates its own app id; Codex assigns a different durable thread id.
    // Join once by the recorded native identity, never by title or runtime cwd.
    let linked_meta = hq_root
        .map(super::claude::read_linked_session_meta)
        .unwrap_or_default();

    // Prune the head memo to the rollouts that still exist before reading, so a
    // deleted or archived rollout does not leak an entry for the process lifetime.
    let seen: HashSet<PathBuf> = rollouts.values().map(|r| r.path.clone()).collect();
    HEAD_CACHE.retain_paths(&seen);

    let mut out: Vec<AgentSession> = Vec::with_capacity(rollouts.len());
    for (file_id, rollout) in &rollouts {
        // Memoised: an append-only rollout's head never changes, so this is one
        // open + parse per rollout for the life of the process, not one per tick.
        let head = HEAD_CACHE
            .get_or_compute(&rollout.path, || {
                let head = read_head_info(&rollout.path);
                // A rollout may be observed before its first JSON line has
                // finished writing. Only cache classified heads permanently.
                head.source.is_some().then_some(head)
            })
            .unwrap_or_else(|| read_head_info(&rollout.path));

        // `codex exec` rollouts are internal executions (including sub-agents),
        // not user-owned Desktop tasks. They share the same rollout store but
        // have no task in Codex's native session index and must not appear as
        // resumable conversations in HQ.
        if head.source.as_ref().is_some_and(|source| {
            matches!(source.as_str(), Some("exec" | "subagent"))
                || source.get("subagent").is_some()
        }) {
            continue;
        }
        // Keep legacy index-backed main threads, but do not invent a task from
        // an unclassified, partially written background rollout.
        if head.source.is_none() && !index.contains_key(file_id) {
            continue;
        }

        // The filename identifies the task represented by this rollout. Forked
        // Codex tasks retain their parent's id in `session_meta.payload.id` and
        // append the child id to the filename, so preferring the payload here
        // collapses the child back into its parent and gives Resume the wrong
        // native id.
        let id = file_id.clone();
        let meta = linked_meta.get(&id);

        // A user-created fork keeps the parent id in session_meta but appends
        // its own resumable id to the filename. Use the child id for Resume and
        // the parent index row only as a display-metadata fallback.
        let idx = index
            .get(file_id)
            .or_else(|| head.id.as_ref().and_then(|id| index.get(id)));

        // last-activity: prefer the index `updated_at`, else the rollout mtime.
        let mtime_iso = system_time_to_iso(rollout.mtime);
        let last_activity_at = idx
            .and_then(|l| l.updated_at.clone())
            .unwrap_or_else(|| mtime_iso.clone());

        // started-at: prefer the `session_meta` payload timestamp; else mtime.
        let started_at = head.started_at.clone().unwrap_or_else(|| mtime_iso.clone());

        let cwd = head.cwd.clone().unwrap_or_default();

        let company = meta
            .and_then(|m| m.company_slug.clone())
            .or_else(|| head.company.clone())
            .unwrap_or_default();
        let project = meta
            .and_then(|m| m.project.clone())
            .or_else(|| head.project.clone())
            .unwrap_or_else(|| {
            // The HQ root is a runtime cwd, not a project. Only use a cwd
            // basename for non-HQ sessions where it remains meaningful. A
            // native task title is not project metadata and must stay out of
            // this field.
            basename(&cwd)
                .filter(|name| !name.eq_ignore_ascii_case("hq"))
                .unwrap_or_default()
        });
        let title = idx
            .and_then(|line| line.thread_name.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                meta.and_then(|m| m.title.clone())
                    .filter(|value| !value.trim().is_empty())
            })
            .or_else(|| {
                head.first_user_message
                    .as_deref()
                    .and_then(title_from_prompt)
            })
            .unwrap_or_else(|| project.clone());

        let status = status_from_age(&last_activity_at, rollout.mtime, now);

        out.push(AgentSession {
            id,
            tool: AgentTool::Codex,
            origin: AgentOrigin::Local,
            title,
            cwd,
            project,
            company,
            model: head.model.clone().unwrap_or_default(),
            status,
            started_at,
            last_activity_at,
            source: SOURCE_TAG.to_string(),
            remote_control_session_id: None,
        });
    }

    out
}

/// Locate live and archived rollout files with the stat metadata needed by both
/// session discovery and the telemetry byte cursor. Missing Codex directories
/// are represented by an empty map.
pub fn enumerate_rollout_files(codex_dir: &Path) -> BTreeMap<String, RolloutFile> {
    let mut rollouts = BTreeMap::new();
    collect_rollouts(&codex_dir.join("sessions"), &mut rollouts);
    collect_rollouts(&codex_dir.join("archived_sessions"), &mut rollouts);
    rollouts
}

/// Recursively collect `rollout-*.jsonl` files under `dir` into `out`, keyed by
/// the session id embedded in the filename. Walks `sessions/YYYY/MM/DD/` (nested)
/// and the flat `archived_sessions/` alike. Unreadable dirs/files are skipped.
fn collect_rollouts(dir: &Path, out: &mut BTreeMap<String, RolloutFile>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // dir absent → nothing to collect
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // sessions/ nests by YYYY/MM/DD — recurse. archived_sessions/ is flat
            // so this branch is simply never taken there.
            collect_rollouts(&path, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_rollout_filename(name) {
            continue;
        }
        let Some(id) = rollout_id_from_filename(name) else {
            continue;
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = match metadata.modified() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // First writer wins; a session id shouldn't collide across sessions/ and
        // archived_sessions/, but if it does we keep the first (live) one.
        out.entry(id).or_insert(RolloutFile {
            path,
            size: metadata.len(),
            mtime,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Index read
// ─────────────────────────────────────────────────────────────────────────────

/// Parse `session_index.jsonl` into an id→[`IndexLine`] map. The index is small
/// (KBs) so a full read is fine here — unlike rollouts. A missing/unreadable
/// index yields an empty map (enumeration falls back to rollout mtime).
fn read_index(index_path: &Path) -> BTreeMap<String, IndexLine> {
    let mut map = BTreeMap::new();
    let contents = match std::fs::read_to_string(index_path) {
        Ok(c) => c,
        Err(_) => return map,
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: IndexLine = match serde_json::from_str(line) {
            Ok(p) => p,
            Err(_) => continue, // foreign/partial line — skip
        };
        if let Some(id) = parsed.id.clone() {
            map.insert(id, parsed);
        }
    }
    map
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded head read
// ─────────────────────────────────────────────────────────────────────────────

/// Read at most [`HEAD_BYTES`] from the start of `path` and recover `id` / `cwd`
/// / `model` / session-start `timestamp` from the leading `session_meta` and
/// `turn_context` records. Returns an all-`None` [`HeadInfo`] on any read error
/// (the record still gets index/stat-derived fields).
///
/// This is the function that holds the hard performance contract: it reads at
/// most `HEAD_BYTES` from the front via `take(HEAD_BYTES)`, so the cost is bounded
/// regardless of how large the rollout is.
fn read_head_info(path: &Path) -> HeadInfo {
    use std::io::Read;

    let mut info = HeadInfo::default();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return info,
    };

    // Read only the head window (at most HEAD_BYTES). Never the whole file.
    let mut buf = Vec::with_capacity(HEAD_BYTES as usize);
    if file.take(HEAD_BYTES).read_to_end(&mut buf).is_err() {
        return info;
    }

    let text = String::from_utf8_lossy(&buf);

    // Walk head → first useful records. If the window ended mid-line, the final
    // fragment fails to parse and is simply skipped.
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: RolloutLine = match serde_json::from_str(line) {
            Ok(p) => p,
            // Foreign/partial line (incl. a truncated tail of the head window) —
            // skip, don't abort the head scan.
            Err(_) => continue,
        };
        let Some(payload) = parsed.payload else {
            continue;
        };

        match parsed.kind.as_deref() {
            Some("session_meta") => {
                if info.id.is_none() {
                    info.id = payload.id;
                }
                if info.started_at.is_none() {
                    info.started_at = payload.timestamp;
                }
                if info.cwd.is_none() {
                    info.cwd = payload.cwd;
                }
                if info.source.is_none() {
                    info.source = payload.source;
                }
            }
            Some("turn_context") => {
                // turn_context carries the freshest cwd + the model.
                if info.cwd.is_none() {
                    info.cwd = payload.cwd;
                }
                if info.model.is_none() {
                    info.model = payload.model;
                }
            }
            Some("response_item")
                if payload.kind.as_deref() == Some("message")
                    && payload.role.as_deref() == Some("user") =>
            {
                let text = payload
                    .content
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|part| part.text)
                    .filter(|text| !is_injected_user_context(text))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    if let Some((company, project)) = parse_startwork_context(&text) {
                        if info.company.is_none() {
                            info.company = Some(company);
                            info.project = project;
                        }
                    }
                    if info.first_user_message.is_none() {
                        info.first_user_message = Some(text);
                    }
                }
            }
            _ => continue,
        }

        // Stop once everything useful is found.
        if info.id.is_some()
            && info.cwd.is_some()
            && info.model.is_some()
            && info.started_at.is_some()
            && info.first_user_message.is_some()
        {
            break;
        }
    }

    info
}

/// Codex persists runtime-supplied context as user-role `input_text` blocks.
/// These are instructions to the model, not messages authored by the user, so
/// they must never become transcript bubbles or fallback task titles.
pub fn is_injected_user_context(text: &str) -> bool {
    let text = text.trim_start();
    [
        "<recommended_plugins>",
        "<in-app-browser-context",
        "<app-context>",
        "<skills_instructions>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<apps_instructions>",
        "<plugins_instructions>",
        "<skill>",
        "<environment_context>",
        "<policy-reminder>",
        "<local-context>",
        "<journal-index>",
        "<hook_prompt>",
        "# AGENTS.md instructions for ",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn parse_startwork_context(text: &str) -> Option<(String, Option<String>)> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("/startwork "))?;
    let mut words = line.split_whitespace();
    if words.next()? != "/startwork" {
        return None;
    }
    let company = words.next()?.trim_matches(|c: char| c == '`' || c == '"');
    if company.is_empty() {
        return None;
    }
    let project = words
        .next()
        .map(|value| {
            value
                .trim_matches(|c: char| c == '`' || c == '"')
                .to_string()
        })
        .filter(|value| !value.is_empty());
    Some((company.to_string(), project))
}

fn title_from_prompt(prompt: &str) -> Option<String> {
    let candidate = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("/startwork "))?;
    let candidate = candidate
        .strip_prefix('/')
        .and_then(|line| line.split_once(' ').map(|(_, rest)| rest))
        .unwrap_or(candidate)
        .trim();
    if candidate.is_empty() {
        return None;
    }
    Some(candidate.chars().take(80).collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Status from age (coarse — US-004 refines)
// ─────────────────────────────────────────────────────────────────────────────

/// Coarse last-activity-only status. Prefers the index `updated_at` (parsed as
/// RFC-3339) for the age computation, falling back to the rollout mtime when the
/// timestamp is absent or unparseable. Never emits `AwaitingInput` (that needs
/// rollout semantics / process state from US-004). A last-activity in the future
/// (clock skew) is treated as fresh → `Running`.
fn status_from_age(last_activity_iso: &str, mtime: SystemTime, now: SystemTime) -> SessionStatus {
    let activity_time = parse_rfc3339_to_system_time(last_activity_iso).unwrap_or(mtime);
    let age = now
        .duration_since(activity_time)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if age <= RUNNING_WINDOW_SECS {
        SessionStatus::Running
    } else if age <= IDLE_WINDOW_SECS {
        SessionStatus::Idle
    } else {
        SessionStatus::Ended
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Whether a filename is a Codex rollout (`rollout-<ts>-<id>.jsonl`).
fn is_rollout_filename(name: &str) -> bool {
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// Extract the session id from a rollout filename. The usual shape is
/// `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`, where `<uuid>` is the last five
/// dash-joined groups (a UUID with its own internal dashes). We strip the
/// `rollout-` prefix and `.jsonl` suffix, then take the trailing UUID (last 5
/// dash groups) so the leading timestamp (which also contains dashes) is dropped.
/// Forked Codex tasks use `...-<parent_uuid>_<child_uuid>.jsonl`; the child id
/// after the final underscore is the task's native resume identifier.
/// Returns `None` if the name doesn't contain a plausible UUID tail.
fn rollout_id_from_filename(name: &str) -> Option<String> {
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id_bearing_stem = stem.rsplit('_').next().unwrap_or(stem);
    let parts: Vec<&str> = id_bearing_stem.split('-').collect();
    // A UUID is 5 dash-joined groups (8-4-4-4-12). The timestamp prefix adds
    // more leading groups; the id is always the last 5.
    if parts.len() < 5 {
        return None;
    }
    let uuid = parts[parts.len() - 5..].join("-");
    // Sanity-check the canonical 8-4-4-4-12 hex group lengths so a malformed name
    // doesn't yield a bogus id.
    let groups: Vec<&str> = uuid.split('-').collect();
    let lens = [8usize, 4, 4, 4, 12];
    if groups.len() == 5
        && groups
            .iter()
            .zip(lens.iter())
            .all(|(g, &n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
    {
        Some(uuid)
    } else {
        None
    }
}

/// Basename of a path string (last non-empty component), or `None` for an empty
/// or root path. Used to derive a project label from a cwd.
fn basename(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or("");
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// Convert a `SystemTime` to an ISO-8601 / RFC-3339 UTC string (seconds
/// precision, `Z` suffix) so timestamps match the rest of the contract.
fn system_time_to_iso(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap())
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Parse an RFC-3339 / ISO-8601 timestamp into a `SystemTime`. Returns `None` on
/// any parse failure so callers fall back to mtime.
fn parse_rfc3339_to_system_time(iso: &str) -> Option<SystemTime> {
    let dt = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let secs = dt.timestamp();
    if secs < 0 {
        return None;
    }
    Some(UNIX_EPOCH + std::time::Duration::from_secs(secs as u64))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    /// Build a throwaway tree under a unique temp dir (pid + monotonic time +
    /// atomic counter so concurrent tests never collide) and return its root.
    /// Layout mirrors the real on-disk shape:
    ///   <root>/session_index.jsonl
    ///   <root>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    ///   <root>/archived_sessions/rollout-<ts>-<id>.jsonl
    fn make_fixture_root() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hq-codex-sessions-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// The `session_meta` header line as Codex writes it (line 1 of a rollout).
    fn session_meta_line(id: &str, cwd: &str, started_at: &str) -> String {
        session_meta_line_with_source(id, cwd, started_at, "vscode")
    }

    fn session_meta_line_with_source(
        id: &str,
        cwd: &str,
        started_at: &str,
        source: &str,
    ) -> String {
        format!(
            r#"{{"timestamp":"{started_at}","type":"session_meta","payload":{{"id":"{id}","timestamp":"{started_at}","cwd":"{cwd}","originator":"Codex Desktop","cli_version":"0.128.0","source":"{source}","model_provider":"openai"}}}}"#
        )
    }

    /// The first `turn_context` line — carries the model (and a fresh cwd).
    fn turn_context_line(cwd: &str, model: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"turn_context","payload":{{"turn_id":"abc","cwd":"{cwd}","model":"{model}","approval_policy":"never"}}}}"#
        )
    }

    /// A non-meta rollout record that carries none of the fields we extract — must
    /// be skipped without breaking the head scan.
    fn event_line(ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"kind":"agent_message","text":"working"}}}}"#
        )
    }

    fn index_line(id: &str, thread_name: &str, updated_at: &str) -> String {
        format!(r#"{{"id":"{id}","thread_name":"{thread_name}","updated_at":"{updated_at}"}}"#)
    }

    fn user_message_line(text: &str) -> String {
        serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": text}]
            }
        })
        .to_string()
    }

    /// Write a rollout file at `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
    fn write_session_rollout(
        root: &Path,
        date: &str,
        ts: &str,
        id: &str,
        contents: &str,
    ) -> PathBuf {
        // date = "YYYY/MM/DD"
        let dir = root.join("sessions").join(date);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-{ts}-{id}.jsonl"));
        fs::write(&path, contents).unwrap();
        path
    }

    /// Write a rollout file flat under `archived_sessions/`.
    fn write_archived_rollout(root: &Path, ts: &str, id: &str, contents: &str) -> PathBuf {
        let dir = root.join("archived_sessions");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-{ts}-{id}.jsonl"));
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn enumerates_rollouts_and_extracts_fields() {
        let root = make_fixture_root();

        // A live session under sessions/ and an archived one under
        // archived_sessions/ — both must be enumerated.
        let id_a = "019de12c-d83e-78c2-9bb3-cbb8146965e4";
        let id_b = "019de12f-9c8a-77c0-b8d1-12895c1e4b68";

        let rollout_a = format!(
            "{}\n{}\n{}\n",
            session_meta_line(
                id_a,
                "/Users/corey/Documents/HQ",
                "2026-06-15T18:00:00.000Z"
            ),
            event_line("2026-06-15T18:00:01.000Z"),
            turn_context_line(
                "/Users/corey/Documents/HQ",
                "gpt-5.5",
                "2026-06-15T18:00:02.000Z"
            ),
        );
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id_a, &rollout_a);

        let rollout_b = format!(
            "{}\n{}\n",
            session_meta_line(id_b, "/Users/corey/code/widget", "2026-06-14T10:00:00.000Z"),
            turn_context_line(
                "/Users/corey/code/widget",
                "gpt-5.1-codex",
                "2026-06-14T10:00:05.000Z"
            ),
        );
        write_archived_rollout(&root, "2026-06-14T10-00-00", id_b, &rollout_b);

        // Index covers both with last-activity + thread name.
        let index = format!(
            "{}\n{}\n",
            index_line(id_a, "Mission Control reader", "2026-06-15T18:05:00.000Z"),
            index_line(id_b, "Widget work", "2026-06-14T10:30:00.000Z"),
        );
        fs::write(root.join("session_index.jsonl"), index).unwrap();

        let mut sessions = scan_codex_sessions(&root, SystemTime::now());
        sessions.sort_by(|a, b| a.id.cmp(&b.id));

        assert_eq!(sessions.len(), 2, "both rollouts enumerated");

        let a = &sessions[0];
        assert_eq!(a.id, id_a);
        assert_eq!(a.tool, AgentTool::Codex);
        assert_eq!(a.origin, AgentOrigin::Local);
        assert_eq!(a.cwd, "/Users/corey/Documents/HQ");
        assert_eq!(a.model, "gpt-5.5", "model lifted from turn_context");
        assert_eq!(a.project, "", "the HQ runtime root is not a project");
        assert_eq!(a.company, "", "Codex rollouts carry no HQ company metadata");
        assert_eq!(a.title, "Mission Control reader");
        assert_eq!(a.source, SOURCE_TAG);
        // Index updated_at is preferred for last-activity.
        assert_eq!(a.last_activity_at, "2026-06-15T18:05:00.000Z");
        // started_at comes from the session_meta payload.
        assert_eq!(a.started_at, "2026-06-15T18:00:00.000Z");

        let b = &sessions[1];
        assert_eq!(b.id, id_b);
        assert_eq!(b.cwd, "/Users/corey/code/widget");
        assert_eq!(b.model, "gpt-5.1-codex");
        assert_eq!(b.project, "widget");
        assert_eq!(b.last_activity_at, "2026-06-14T10:30:00.000Z");
    }

    #[test]
    fn extracts_hq_context_and_native_title() {
        let root = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30b";
        let rollout = format!(
            "{}\n{}\n{}\n",
            session_meta_line(id, "/Users/corey/Documents/HQ", "2026-06-15T18:00:00.000Z"),
            turn_context_line(
                "/Users/corey/Documents/HQ",
                "gpt-5.6-sol",
                "2026-06-15T18:00:01.000Z"
            ),
            user_message_line(
                "/startwork indigo hq-console-reenvision\n\n/indigo:html-deck hello world deck"
            ),
        );
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &rollout);
        fs::write(
            root.join("session_index.jsonl"),
            format!(
                "{}\n",
                index_line(id, "Build the hello world deck", "2026-06-15T18:05:00.000Z")
            ),
        )
        .unwrap();

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].company, "indigo");
        assert_eq!(sessions[0].project, "hq-console-reenvision");
        assert_eq!(sessions[0].title, "Build the hello world deck");
    }

    #[test]
    fn restores_app_owned_codex_metadata_by_native_identity() {
        let root = make_fixture_root();
        let hq = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30b";
        let rollout = session_meta_line(id, "/Users/test/HQ", "2026-06-15T18:00:00.000Z");
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &rollout);
        let meta_dir = hq.join("workspace/sessions/app-owned-id");
        fs::create_dir_all(&meta_dir).unwrap();
        fs::write(meta_dir.join("meta.yaml"), format!(
            "cli_session_id: {id}\ncompany_slug: indigo\nproject: feedback\ntitle: Saved conversation name\n"
        )).unwrap();
        let sessions = scan_codex_sessions_with_hq(&root, Some(&hq), SystemTime::now());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, id);
        assert_eq!(sessions[0].title, "Saved conversation name");
        assert_eq!(sessions[0].company, "indigo");
        assert_eq!(sessions[0].project, "feedback");
        // A provider-native rename remains authoritative over an older HQ label.
        fs::write(root.join("session_index.jsonl"), index_line(id, "Renamed in Codex", "2026-06-15T18:05:00.000Z")).unwrap();
        assert_eq!(scan_codex_sessions_with_hq(&root, Some(&hq), SystemTime::now())[0].title, "Renamed in Codex");
    }

    #[test]
    fn excludes_exec_rollouts_and_ignores_injected_title_context() {
        let root = make_fixture_root();
        let desktop_id = "019e0525-596f-7013-82ee-9397e9a1c30b";
        let exec_id = "019e0525-596f-7013-82ee-9397e9a1c30c";
        let desktop = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            session_meta_line(
                desktop_id,
                "/Users/corey/Documents/HQ",
                "2026-06-15T18:00:00.000Z"
            ),
            turn_context_line(
                "/Users/corey/Documents/HQ",
                "gpt-5.6-sol",
                "2026-06-15T18:00:01.000Z"
            ),
            user_message_line("<recommended_plugins>\nAirtable"),
            user_message_line(
                "<skill>\n<name>startwork</name>\n<path>/tmp/SKILL.md</path>\n---\nhidden instructions\n</skill>",
            ),
            user_message_line("/startwork indigo desktop-sessions\n\nFix resume history"),
        );
        write_session_rollout(
            &root,
            "2026/06/15",
            "2026-06-15T18-00-00",
            desktop_id,
            &desktop,
        );

        let exec = format!(
            "{}\n{}\n{}\n",
            session_meta_line_with_source(
                exec_id,
                "/Users/corey/Documents/HQ",
                "2026-06-15T18:01:00.000Z",
                "exec"
            ),
            turn_context_line(
                "/Users/corey/Documents/HQ",
                "gpt-5.6-sol",
                "2026-06-15T18:01:01.000Z"
            ),
            user_message_line("<recommended_plugins>\nAirtable"),
        );
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", exec_id, &exec);

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, desktop_id);
        assert_eq!(sessions[0].company, "indigo");
        assert_eq!(sessions[0].project, "desktop-sessions");
        assert_eq!(sessions[0].title, "Fix resume history");
    }

    #[test]
    fn missing_codex_dir_yields_empty() {
        let root = make_fixture_root();
        let nonexistent = root.join("does-not-exist");
        let sessions = scan_codex_sessions(&nonexistent, SystemTime::now());
        assert!(sessions.is_empty());
    }

    #[test]
    fn incomplete_helper_header_is_not_cached_as_a_main_thread() {
        let root = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30c";
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", id, "");
        let first = scan_codex_sessions(&root, SystemTime::now());
        let meta = session_meta_line_with_source(id, "/tmp/HQ", "2026-06-15T18:01:00.000Z", "exec");
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", id, &format!("{meta}\n"));
        assert!(scan_codex_sessions(&root, SystemTime::now()).is_empty(), "completed exec metadata must be re-read");
        assert!(first.is_empty(), "unclassified rollouts must not flash as main threads");
    }

    #[test]
    fn structured_subagent_source_is_excluded_even_with_an_index_title() {
        let root = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30c";
        let mut meta: serde_json::Value = serde_json::from_str(&session_meta_line(id, "/tmp/HQ", "2026-06-15T18:01:00.000Z")).unwrap();
        meta["payload"]["source"] = serde_json::json!({"subagent":{"thread_spawn":{"parent_thread_id":"parent", "depth":1}}});
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", id, &format!("{meta}\n"));
        fs::write(root.join("session_index.jsonl"), index_line(id, "Helper", "2026-06-15T18:05:00.000Z")).unwrap();
        assert!(scan_codex_sessions(&root, SystemTime::now()).is_empty());
    }

    #[test]
    fn incomplete_main_thread_appears_when_metadata_arrives() {
        let root = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30b";
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", id, "");
        assert!(scan_codex_sessions(&root, SystemTime::now()).is_empty());
        let meta = session_meta_line(id, "/tmp/HQ", "2026-06-15T18:01:00.000Z");
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-01-00", id, &format!("{meta}\n"));
        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, id);
    }

    #[test]
    fn telemetry_enumerator_returns_live_and_archived_rollouts() {
        let root = make_fixture_root();
        let live_id = "019de12c-d83e-78c2-9bb3-cbb8146965e4";
        let archived_id = "019de12f-9c8a-77c0-b8d1-12895c1e4b68";
        let live =
            write_session_rollout(&root, "2026/07/23", "2026-07-23T10-00-00", live_id, "{}\n");
        let archived = write_archived_rollout(
            &root,
            "2026-07-22T10-00-00",
            archived_id,
            "{\"type\":\"event_msg\"}\n",
        );

        let rollouts = enumerate_rollout_files(&root);

        assert_eq!(rollouts.len(), 2);
        assert_eq!(rollouts[live_id].path, live);
        assert_eq!(rollouts[archived_id].path, archived);
        assert!(rollouts[live_id].size > 0);
        assert!(rollouts[archived_id].size > 0);
    }

    #[test]
    fn telemetry_enumerator_missing_codex_dir_is_empty() {
        let root = make_fixture_root().join("missing");
        assert!(enumerate_rollout_files(&root).is_empty());
    }

    #[test]
    fn rollout_without_index_uses_mtime_fallback() {
        let root = make_fixture_root();
        let id = "019de131-1a9a-7eb0-9811-d2ed00b47f6c";
        let rollout = format!(
            "{}\n{}\n",
            session_meta_line(id, "/tmp/proj", "2026-06-15T18:00:00.000Z"),
            turn_context_line("/tmp/proj", "gpt-5.5", "2026-06-15T18:00:01.000Z"),
        );
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &rollout);
        // No session_index.jsonl written at all.

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1, "rollout enumerated even with no index");
        let s = &sessions[0];
        assert_eq!(s.id, id);
        assert_eq!(s.cwd, "/tmp/proj");
        // last-activity falls back to mtime (a real ISO string, non-empty).
        assert!(
            s.last_activity_at.ends_with('Z') && s.last_activity_at.len() >= 20,
            "last_activity_at falls back to an ISO mtime: {}",
            s.last_activity_at
        );
    }

    /// HARD performance contract: a rollout far larger than HEAD_BYTES must be
    /// enumerated via a bounded head read, NOT a full parse. We prove the
    /// boundedness two ways: (1) the reader still extracts the head fields from a
    /// huge file, and (2) the head reader provably reads at most HEAD_BYTES.
    #[test]
    fn large_rollout_is_not_fully_read() {
        let root = make_fixture_root();
        let id = "019de142-4c91-7420-95b2-99e7096c9cf7";

        // Real head: session_meta + turn_context carrying the fields that must win.
        let mut contents = String::with_capacity((HEAD_BYTES as usize) * 3);
        contents.push_str(&session_meta_line(
            id,
            "/Users/corey/Documents/HQ",
            "2026-06-15T18:00:00.000Z",
        ));
        contents.push('\n');
        contents.push_str(&turn_context_line(
            "/Users/corey/Documents/HQ",
            "gpt-5.5",
            "2026-06-15T18:00:01.000Z",
        ));
        contents.push('\n');

        // Pad with > HEAD_BYTES of filler event lines AFTER the head, plus a
        // "stale" turn_context far past the head window. If the reader fully
        // parsed the file, it would still pick the FIRST turn_context (head-first
        // wins), but the filler proves we never need to read past the window.
        let filler = event_line("2026-06-15T18:00:02.000Z");
        while (contents.len() as u64) < HEAD_BYTES * 2 {
            contents.push_str(&filler);
            contents.push('\n');
        }
        // A late turn_context with a model that must NOT win (proves head-first).
        contents.push_str(&turn_context_line(
            "/should/not/win",
            "stale-model-past-head",
            "2030-01-01T00:00:00.000Z",
        ));
        contents.push('\n');

        let path = write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &contents);

        let file_len = fs::metadata(&path).unwrap().len();
        assert!(
            file_len > HEAD_BYTES * 2,
            "fixture must exceed the head window to exercise the bound (len={file_len}, head={HEAD_BYTES})"
        );

        // (1) End-to-end: the head fields win, the late stale line is never seen.
        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(
            s.model, "gpt-5.5",
            "model must come from the HEAD, proving the rest was not read"
        );
        assert_eq!(s.cwd, "/Users/corey/Documents/HQ");
        assert_ne!(s.model, "stale-model-past-head");
        assert_ne!(s.cwd, "/should/not/win");

        // (2) Direct bound check: the head reader buffers at most HEAD_BYTES and
        // still recovers the head fields.
        let head = read_head_info(&path);
        assert_eq!(head.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(head.cwd.as_deref(), Some("/Users/corey/Documents/HQ"));
        assert_eq!(head.id.as_deref(), Some(id));
    }

    #[test]
    fn malformed_index_lines_are_skipped_not_fatal() {
        let root = make_fixture_root();
        let id = "019de18b-fe3f-7a20-8474-9e632c07ded5";
        let rollout = format!(
            "{}\n{}\n",
            session_meta_line(id, "/tmp/x", "2026-06-15T18:00:00.000Z"),
            turn_context_line("/tmp/x", "gpt-5.5", "2026-06-15T18:00:01.000Z"),
        );
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &rollout);

        // Index with a garbage line + a line missing an id + the real line.
        let index = format!(
            "not json at all\n{{\"thread_name\":\"no id here\"}}\n{}\n",
            index_line(id, "Real session", "2026-06-15T18:05:00.000Z"),
        );
        fs::write(root.join("session_index.jsonl"), index).unwrap();

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(
            sessions.len(),
            1,
            "garbage index lines don't blank the scan"
        );
        assert_eq!(sessions[0].last_activity_at, "2026-06-15T18:05:00.000Z");
    }

    #[test]
    fn native_thread_name_stays_a_title_when_project_is_unknown() {
        let root = make_fixture_root();
        let id = "019e0525-596f-7013-82ee-9397e9a1c30b";
        // Rollout with only an event line — no session_meta cwd, no turn_context.
        let rollout = format!("{}\n", event_line("2026-06-15T18:00:00.000Z"));
        write_session_rollout(&root, "2026/06/15", "2026-06-15T18-00-00", id, &rollout);

        let index = format!(
            "{}\n",
            index_line(id, "Codex thread label", "2026-06-15T18:05:00.000Z"),
        );
        fs::write(root.join("session_index.jsonl"), index).unwrap();

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.cwd, "", "no cwd recoverable");
        // id falls back to filename when the rollout head lacked session_meta.
        assert_eq!(s.id, id);
        assert_eq!(s.project, "", "a task title is not project metadata");
        assert_eq!(s.title, "Codex thread label");
    }

    #[test]
    fn status_window_maps_age_to_taxonomy() {
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        let mtime = now; // mtime irrelevant when last_activity parses
        let iso = |secs_ago: u64| system_time_to_iso(now - Duration::from_secs(secs_ago));

        // Fresh activity → running.
        assert_eq!(
            status_from_age(&iso(10), mtime, now),
            SessionStatus::Running
        );
        // 5 minutes stale → idle.
        assert_eq!(
            status_from_age(&iso(5 * 60), mtime, now),
            SessionStatus::Idle
        );
        // 2 hours stale → ended.
        assert_eq!(
            status_from_age(&iso(2 * 60 * 60), mtime, now),
            SessionStatus::Ended
        );
        // Unparseable last-activity → falls back to mtime (here = now → running).
        assert_eq!(
            status_from_age("not-a-timestamp", mtime, now),
            SessionStatus::Running
        );
    }

    #[test]
    fn rollout_id_from_filename_extracts_trailing_uuid() {
        assert_eq!(
            rollout_id_from_filename(
                "rollout-2026-04-30T19-35-05-019de12c-d83e-78c2-9bb3-cbb8146965e4.jsonl"
            )
            .as_deref(),
            Some("019de12c-d83e-78c2-9bb3-cbb8146965e4")
        );
        assert_eq!(
            rollout_id_from_filename(
                "rollout-2026-09-02T17-32-55-01a063d4-7aa7-7ec1-bf14-e5ddfea0995d_01a0640a-0c86-7a31-baad-f9d5cbfd379a.jsonl"
            )
            .as_deref(),
            Some("01a0640a-0c86-7a31-baad-f9d5cbfd379a")
        );
        // Not a rollout → None.
        assert_eq!(rollout_id_from_filename("README.md"), None);
        // Missing a valid UUID tail → None.
        assert_eq!(
            rollout_id_from_filename("rollout-2026-04-30-foo.jsonl"),
            None
        );
    }

    #[test]
    fn non_rollout_files_are_ignored() {
        let root = make_fixture_root();
        let dir = root.join("sessions").join("2026/06/15");
        fs::create_dir_all(&dir).unwrap();
        // A stray non-rollout file alongside a real rollout.
        fs::write(dir.join("notes.txt"), "not a rollout").unwrap();
        let id = "019e1068-682a-7833-9717-cf2224c5af0d";
        fs::write(
            dir.join(format!("rollout-2026-06-15T18-00-00-{id}.jsonl")),
            format!(
                "{}\n{}\n",
                session_meta_line(id, "/tmp/x", "2026-06-15T18:00:00.000Z"),
                turn_context_line("/tmp/x", "gpt-5.5", "2026-06-15T18:00:01.000Z"),
            ),
        )
        .unwrap();

        let sessions = scan_codex_sessions(&root, SystemTime::now());
        assert_eq!(sessions.len(), 1, "only the rollout is enumerated");
        assert_eq!(sessions[0].id, id);
    }
}
