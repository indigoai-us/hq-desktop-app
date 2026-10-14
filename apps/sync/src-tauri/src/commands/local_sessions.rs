//! First-run "what you already work with" scan (US-003): how much this
//! computer has used Claude Code and Codex, which repos it has, and which
//! apps and MCP servers are set up. It runs natively at launch so the
//! knowledge tree fills in without waiting for hq-cli.
//!
//! What it reads, and nothing else:
//!
//! - `$CLAUDE_CONFIG_DIR` or `~/.claude`: `projects/` is listed, and each
//!   `projects/<encoded cwd>/` is listed. Only `*.jsonl` file names and their
//!   modified times are used. The folder name is the project label. No
//!   session file is opened.
//! - `$CODEX_HOME` or `~/.codex`: `sessions/YYYY/MM/DD/` is listed. Only
//!   `*.jsonl` file names and their modified times are used. No session file
//!   is opened.
//! - Repos: up to three folder levels under `~/code`, `~/dev`, `~/projects`,
//!   `~/src`, `~/repos`, `~/Developer`, `~/github`, `~/work` and
//!   `~/Documents/GitHub`, looking for a `.git` entry. Hidden folders,
//!   `node_modules`, `target` and `vendor` are skipped. The last commit time
//!   is the modified time of `.git/logs/HEAD` (then `.git/HEAD`, then
//!   `.git`). No git command runs and no git object is read.
//! - Apps and MCP server names: `work_apps::detect_work_apps_in`, which reads
//!   app bundle names and the MCP server keys of the Claude Code, Claude
//!   Desktop, Cursor and Codex configs. Server commands, arguments, env,
//!   headers and keys are never read into the answer.
//!
//! The answer holds names, counts and times only. Logs hold counts and
//! outcomes only, never a name or a path. One shared deadline (8 s) and
//! entry caps bound the scan; hitting either marks the answer `truncated`
//! and the source `budget`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::work_apps::{detect_work_apps_in, ScanRoots};
use crate::first_run_timing;

/// The whole scan's time budget. Under the 10 s first-run target.
pub const SCAN_BUDGET: Duration = Duration::from_secs(8);
/// Sessions counted as recent.
const RECENT_WINDOW: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Directory entries looked at across the whole scan.
const ENTRY_MAX: usize = 200_000;
/// Repo folder depth below each repo root.
const REPO_DEPTH: usize = 3;
/// Repos and projects returned (newest first).
const REPO_MAX: usize = 50;
const PROJECT_MAX: usize = 50;
/// A repeat call within this window gets the last answer.
const CACHE_TTL: Duration = Duration::from_secs(60);

const SKIP_DIRS: &[&str] = &["node_modules", "target", "vendor", "Library"];
const REPO_ROOTS: &[&str] = &[
    "code",
    "dev",
    "projects",
    "src",
    "repos",
    "Developer",
    "github",
    "work",
    "Documents/GitHub",
];

// ── what the command returns ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalScan {
    pub tools: Vec<ToolSessions>,
    /// Session folders by tool, newest first. Claude Code only: Codex keeps
    /// the working folder inside the session file, which is never opened.
    pub projects: Vec<SessionProject>,
    pub repos: Vec<RepoSeen>,
    pub apps: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub sources: Vec<ScanOutcome>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolSessions {
    /// "claude-code" | "codex"
    pub tool: &'static str,
    pub sessions_total: u32,
    pub sessions_last_30d: u32,
    /// Milliseconds since the epoch of the newest session; null with none.
    pub last_active_at: Option<u64>,
    /// This tool's part of all sessions in the last 30 days, 0..=1.
    pub share_last_30d: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionProject {
    pub tool: &'static str,
    pub name: String,
    pub sessions: u32,
    pub last_active_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoSeen {
    pub path: String,
    pub last_commit_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanOutcome {
    /// "claude-code" | "codex" | "repos" | "apps"
    pub source: &'static str,
    /// "read" | "missing" | "unreadable" | "budget" | "unsupported"
    pub outcome: &'static str,
    pub count: u32,
}

// ── where to look ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct SessionRoots {
    /// Claude Code's config folder (`~/.claude`).
    pub claude_dir: Option<PathBuf>,
    /// Codex's home folder (`~/.codex`).
    pub codex_dir: Option<PathBuf>,
    /// The home folder, to shorten Claude Code project labels.
    pub home: Option<PathBuf>,
    pub repo_roots: Vec<PathBuf>,
    pub work_apps: ScanRoots,
}

impl SessionRoots {
    pub fn for_this_computer() -> Self {
        let home = dirs::home_dir();
        let env_dir = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        SessionRoots {
            claude_dir: env_dir("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude"))),
            codex_dir: env_dir("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
            repo_roots: home
                .as_ref()
                .map(|h| REPO_ROOTS.iter().map(|r| h.join(r)).collect())
                .unwrap_or_default(),
            home,
            work_apps: ScanRoots::for_this_computer(),
        }
    }
}

// ── the walk ──────────────────────────────────────────────────────────────

/// The shared deadline and entry cap.
struct Budget {
    deadline: Instant,
    entries: usize,
    spent: bool,
}

impl Budget {
    fn new(limit: Duration) -> Self {
        Budget {
            deadline: Instant::now() + limit,
            entries: 0,
            spent: false,
        }
    }

    /// Count one directory entry. False once time or entries run out.
    fn take(&mut self) -> bool {
        if self.spent {
            return false;
        }
        self.entries += 1;
        if self.entries > ENTRY_MAX || Instant::now() >= self.deadline {
            self.spent = true;
        }
        !self.spent
    }
}

enum Listing {
    Missing,
    Unreadable,
    Entries(Vec<fs::DirEntry>),
}

/// The entries of `dir`, stopping early when the budget runs out.
fn list(dir: &Path, budget: &mut Budget) -> Listing {
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Listing::Missing,
        Err(_) => return Listing::Unreadable,
    };
    let mut entries = Vec::new();
    for entry in read {
        if !budget.take() {
            break;
        }
        if let Ok(entry) = entry {
            entries.push(entry);
        }
    }
    Listing::Entries(entries)
}

fn to_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(to_ms)
}

fn is_session_file(entry: &fs::DirEntry) -> bool {
    entry.file_name().to_string_lossy().ends_with(".jsonl")
        && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
}

/// Session times (ms) for one tool, plus per-folder groups for Claude Code.
#[derive(Default)]
struct ToolWalk {
    times: Vec<u64>,
    folders: Vec<(String, Vec<u64>)>,
    outcome: &'static str,
}

fn outcome_for(listing: &Listing) -> &'static str {
    match listing {
        Listing::Missing => "missing",
        Listing::Unreadable => "unreadable",
        Listing::Entries(_) => "read",
    }
}

fn walk_claude(dir: Option<&Path>, budget: &mut Budget) -> ToolWalk {
    let Some(dir) = dir else {
        return ToolWalk { outcome: "missing", ..ToolWalk::default() };
    };
    let projects = list(&dir.join("projects"), budget);
    let mut walk = ToolWalk { outcome: outcome_for(&projects), ..ToolWalk::default() };
    let Listing::Entries(projects) = projects else {
        return walk;
    };
    for project in projects {
        if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Listing::Entries(files) = list(&project.path(), budget) else {
            continue;
        };
        let times: Vec<u64> = files
            .iter()
            .filter(|f| is_session_file(f))
            .filter_map(|f| f.metadata().ok().and_then(|m| m.modified().ok()).and_then(to_ms))
            .collect();
        if !times.is_empty() {
            walk.times.extend(&times);
            walk.folders.push((project.file_name().to_string_lossy().into_owned(), times));
        }
    }
    walk
}

/// Codex keeps `sessions/YYYY/MM/DD/*.jsonl`.
fn walk_codex(dir: Option<&Path>, budget: &mut Budget) -> ToolWalk {
    let Some(dir) = dir else {
        return ToolWalk { outcome: "missing", ..ToolWalk::default() };
    };
    let sessions = list(&dir.join("sessions"), budget);
    let mut walk = ToolWalk { outcome: outcome_for(&sessions), ..ToolWalk::default() };
    let Listing::Entries(years) = sessions else {
        return walk;
    };
    let mut level = years.into_iter().map(|e| e.path()).collect::<Vec<_>>();
    for _ in 0..3 {
        let mut next = Vec::new();
        for dir in level {
            if !dir.is_dir() {
                continue;
            }
            if let Listing::Entries(entries) = list(&dir, budget) {
                next.extend(entries);
            }
        }
        if next.is_empty() {
            return walk;
        }
        // At the day level keep the files; above it keep the folders.
        let files: Vec<_> = next.iter().filter(|e| is_session_file(e)).collect();
        walk.times.extend(
            files
                .iter()
                .filter_map(|f| f.metadata().ok().and_then(|m| m.modified().ok()).and_then(to_ms)),
        );
        level = next
            .into_iter()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
    }
    walk
}

fn walk_repos(roots: &[PathBuf], budget: &mut Budget) -> (Vec<RepoSeen>, &'static str) {
    let mut repos = Vec::new();
    let mut any_root = false;
    let mut level: Vec<(PathBuf, usize)> = Vec::new();
    for root in roots {
        if root.is_dir() {
            any_root = true;
            level.push((root.clone(), 0));
        }
    }
    while let Some((dir, depth)) = level.pop() {
        let git = dir.join(".git");
        if git.exists() {
            let last = modified_ms(&git.join("logs").join("HEAD"))
                .or_else(|| modified_ms(&git.join("HEAD")))
                .or_else(|| modified_ms(&git));
            repos.push(RepoSeen {
                path: dir.to_string_lossy().into_owned(),
                last_commit_at: last,
            });
            continue;
        }
        if depth >= REPO_DEPTH {
            continue;
        }
        let Listing::Entries(entries) = list(&dir, budget) else {
            continue;
        };
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            // Symlinks are not followed: file_type() does not traverse them.
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                level.push((entry.path(), depth + 1));
            }
        }
    }
    repos.sort_by(|a, b| b.last_commit_at.cmp(&a.last_commit_at).then(a.path.cmp(&b.path)));
    repos.dedup_by(|a, b| a.path == b.path);
    repos.truncate(REPO_MAX);
    (repos, if any_root { "read" } else { "missing" })
}

/// Claude Code names a project folder after its working folder with `/` and
/// `.` turned into `-`. A matching repo gives the real folder name; otherwise
/// the home prefix is dropped from the folder name.
fn project_label(folder: &str, home: Option<&Path>, repos: &[RepoSeen]) -> String {
    let encode = |p: &str| p.replace(['/', '.', '\\', ':'], "-");
    if let Some(repo) = repos.iter().find(|r| encode(&r.path) == folder) {
        if let Some(name) = Path::new(&repo.path).file_name() {
            return name.to_string_lossy().into_owned();
        }
    }
    if let Some(home) = home {
        let prefix = encode(&home.to_string_lossy());
        if folder == prefix {
            return "home".to_string();
        }
        if let Some(rest) = folder.strip_prefix(&format!("{prefix}-")) {
            return rest.trim_start_matches('-').to_string();
        }
    }
    folder.trim_start_matches('-').to_string()
}

fn tool_sessions(tool: &'static str, times: &[u64], recent_since: u64, recent_all: u32) -> ToolSessions {
    let recent = u32::try_from(times.iter().filter(|t| **t >= recent_since).count()).unwrap_or(u32::MAX);
    let share = if recent_all == 0 {
        0.0
    } else {
        (f64::from(recent) / f64::from(recent_all) * 1000.0).round() / 1000.0
    };
    ToolSessions {
        tool,
        sessions_total: u32::try_from(times.len()).unwrap_or(u32::MAX),
        sessions_last_30d: recent,
        last_active_at: times.iter().copied().max(),
        share_last_30d: share,
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Run the whole scan against `roots`. Blocking.
pub fn scan_local_sessions_in(roots: &SessionRoots, now: SystemTime, limit: Duration) -> LocalScan {
    let started = Instant::now();
    let mut budget = Budget::new(limit);
    let claude = walk_claude(roots.claude_dir.as_deref(), &mut budget);
    let claude_cut = budget.spent;
    let codex = walk_codex(roots.codex_dir.as_deref(), &mut budget);
    let codex_cut = budget.spent;
    let (repos, repos_outcome) = walk_repos(&roots.repo_roots, &mut budget);
    let repos_cut = budget.spent;

    let recent_since = to_ms(now.checked_sub(RECENT_WINDOW).unwrap_or(UNIX_EPOCH)).unwrap_or(0);
    let recent_all = count(
        claude
            .times
            .iter()
            .chain(codex.times.iter())
            .filter(|t| **t >= recent_since)
            .count(),
    );
    let tools = vec![
        tool_sessions("claude-code", &claude.times, recent_since, recent_all),
        tool_sessions("codex", &codex.times, recent_since, recent_all),
    ];

    // Group by label: two folders can shorten to the same name.
    let mut by_label: BTreeMap<String, (u32, Option<u64>)> = BTreeMap::new();
    for (folder, times) in &claude.folders {
        let label = project_label(folder, roots.home.as_deref(), &repos);
        if label.is_empty() {
            continue;
        }
        let slot = by_label.entry(label).or_insert((0, None));
        slot.0 = slot.0.saturating_add(count(times.len()));
        slot.1 = slot.1.max(times.iter().copied().max());
    }
    let mut projects: Vec<SessionProject> = by_label
        .into_iter()
        .map(|(name, (sessions, last))| SessionProject {
            tool: "claude-code",
            name,
            sessions,
            last_active_at: last,
        })
        .collect();
    projects.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at).then(a.name.cmp(&b.name)));
    projects.truncate(PROJECT_MAX);

    // Apps and MCP servers. The work-apps scan has its own small budget;
    // skip it when the shared one is already spent.
    let (apps, mcp_servers, apps_outcome, apps_cut) = if budget.spent || Instant::now() >= budget.deadline {
        (Vec::new(), Vec::new(), "budget", true)
    } else {
        let found = detect_work_apps_in(&roots.work_apps);
        let apps: BTreeSet<String> = found.apps.into_iter().map(|a| a.name).collect();
        let servers: BTreeSet<String> = found.mcp_servers.into_iter().map(|s| s.name).collect();
        let outcome = found
            .sources
            .iter()
            .find(|s| s.source == "apps")
            .map(|s| s.outcome)
            .unwrap_or("missing");
        (apps.into_iter().collect(), servers.into_iter().collect(), outcome, found.truncated)
    };

    let mark = |outcome: &'static str, cut: bool| if cut { "budget" } else { outcome };
    let sources = vec![
        ScanOutcome {
            source: "claude-code",
            outcome: mark(claude.outcome, claude_cut),
            count: count(claude.times.len()),
        },
        ScanOutcome {
            source: "codex",
            outcome: mark(codex.outcome, codex_cut),
            count: count(codex.times.len()),
        },
        ScanOutcome {
            source: "repos",
            outcome: mark(repos_outcome, repos_cut),
            count: count(repos.len()),
        },
        ScanOutcome {
            source: "apps",
            outcome: apps_outcome,
            count: count(apps.len()),
        },
    ];
    LocalScan {
        tools,
        projects,
        repos,
        apps,
        mcp_servers,
        sources,
        truncated: budget.spent || apps_cut,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

// ── logging ───────────────────────────────────────────────────────────────

/// `passed`, or `timeout` when the budget cut the scan short.
fn probe_result(scan: &LocalScan) -> &'static str {
    if scan.sources.iter().any(|s| s.outcome == "budget") {
        "timeout"
    } else {
        "passed"
    }
}

/// The counts line: outcomes and counts only, never a name or a path.
fn counts_line(scan: &LocalScan) -> String {
    let sources = scan
        .sources
        .iter()
        .map(|s| format!("{}={}:{}", s.source, s.outcome, s.count))
        .collect::<Vec<_>>()
        .join(" ");
    let recent = scan
        .tools
        .iter()
        .map(|t| format!("{}_30d={}", t.tool, t.sessions_last_30d))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "scan_local_sessions {sources} {recent} mcp={} truncated={}",
        scan.mcp_servers.len(),
        scan.truncated
    )
}

fn log_scan(scan: &LocalScan) {
    crate::util::logfile::log(
        first_run_timing::TAG,
        &first_run_timing::format_probe("scan", probe_result(scan), u128::from(scan.elapsed_ms)),
    );
    crate::util::logfile::log("local-sessions", &counts_line(scan));
}

fn empty_scan(outcome: &'static str, elapsed_ms: u64) -> LocalScan {
    LocalScan {
        tools: Vec::new(),
        projects: Vec::new(),
        repos: Vec::new(),
        apps: Vec::new(),
        mcp_servers: Vec::new(),
        sources: ["claude-code", "codex", "repos", "apps"]
            .into_iter()
            .map(|source| ScanOutcome { source, outcome, count: 0 })
            .collect(),
        truncated: false,
        elapsed_ms,
    }
}

// ── the command ───────────────────────────────────────────────────────────

static CACHE: Mutex<Option<(Instant, LocalScan)>> = Mutex::new(None);

fn cached() -> Option<LocalScan> {
    match CACHE.lock() {
        Ok(slot) => slot
            .as_ref()
            .filter(|(at, _)| at.elapsed() < CACHE_TTL)
            .map(|(_, scan)| scan.clone()),
        Err(error) => {
            crate::util::logfile::log("local-sessions", &format!("cache lock poisoned ({error})"));
            None
        }
    }
}

fn remember(scan: &LocalScan) {
    match CACHE.lock() {
        Ok(mut slot) => *slot = Some((Instant::now(), scan.clone())),
        Err(error) => crate::util::logfile::log("local-sessions", &format!("cache lock poisoned ({error})")),
    }
}

pub fn scan_local_sessions_blocking() -> LocalScan {
    if let Some(scan) = cached() {
        return scan;
    }
    let scan = scan_local_sessions_in(&SessionRoots::for_this_computer(), SystemTime::now(), SCAN_BUDGET);
    log_scan(&scan);
    remember(&scan);
    scan
}

/// Names, counts and recency of this computer's Claude Code and Codex
/// sessions, repos, apps and MCP servers, for the first-run knowledge tree.
/// Runs on the blocking pool: it lists folders and must never hold the main
/// thread.
#[tauri::command]
pub async fn scan_local_sessions() -> LocalScan {
    let started = Instant::now();
    match tokio::task::spawn_blocking(scan_local_sessions_blocking).await {
        Ok(scan) => scan,
        Err(error) => {
            let elapsed = started.elapsed().as_millis();
            crate::util::logfile::log(
                "local-sessions",
                &format!("scan_local_sessions blocking task failed ({error})"),
            );
            crate::util::logfile::log(
                first_run_timing::TAG,
                &first_run_timing::format_probe("scan", "failed", elapsed),
            );
            empty_scan("unreadable", u64::try_from(elapsed).unwrap_or(u64::MAX))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::logfile::LogOverrideGuard;

    /// Put in every file the scan must never open.
    const SENTINEL: &str = "SENTINEL-sk-ant-DO-NOT-READ";
    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    /// A fixed "now": 2026-10-01T00:00:00Z.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_812_800)
    }

    fn file_at(path: &Path, age: Duration) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("{{\"text\":\"{SENTINEL}\",\"cwd\":\"/{SENTINEL}\"}}\n")).unwrap();
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(now() - age).unwrap();
    }

    struct Machine {
        _dir: tempfile::TempDir,
        roots: SessionRoots,
    }

    /// An empty fake home: every root points inside a temp folder.
    fn machine() -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let roots = SessionRoots {
            claude_dir: Some(home.join(".claude")),
            codex_dir: Some(home.join(".codex")),
            repo_roots: REPO_ROOTS.iter().map(|r| home.join(r)).collect(),
            home: Some(home.clone()),
            work_apps: ScanRoots {
                app_dirs: vec![home.join("Applications")],
                claude_code: Some(home.join(".claude.json")),
                codex: Some(home.join(".codex").join("config.toml")),
                ..ScanRoots::default()
            },
        };
        Machine { _dir: dir, roots }
    }

    fn home(m: &Machine) -> PathBuf {
        m.roots.home.clone().unwrap()
    }

    fn claude_sessions(m: &Machine, folder: &str, ages_days: &[u64]) {
        let dir = m.roots.claude_dir.as_ref().unwrap().join("projects").join(folder);
        for (i, age) in ages_days.iter().enumerate() {
            file_at(&dir.join(format!("session-{i}.jsonl")), DAY * u32::try_from(*age).unwrap());
        }
    }

    fn codex_sessions(m: &Machine, ages_days: &[u64]) {
        let dir = m.roots.codex_dir.as_ref().unwrap().join("sessions");
        for (i, age) in ages_days.iter().enumerate() {
            let day = dir.join("2026").join("09").join(format!("{:02}", 1 + i % 28));
            file_at(&day.join(format!("rollout-{i}.jsonl")), DAY * u32::try_from(*age).unwrap());
        }
    }

    fn repo(m: &Machine, rel: &str, age_days: u32) -> PathBuf {
        let path = home(m).join(rel);
        file_at(&path.join(".git").join("logs").join("HEAD"), DAY * age_days);
        fs::write(path.join(".git").join("config"), format!("[remote]\n url = {SENTINEL}\n")).unwrap();
        path
    }

    fn scan(m: &Machine) -> LocalScan {
        scan_local_sessions_in(&m.roots, now(), SCAN_BUDGET)
    }

    fn tool<'a>(scan: &'a LocalScan, name: &str) -> &'a ToolSessions {
        scan.tools.iter().find(|t| t.tool == name).unwrap()
    }

    fn outcome(scan: &LocalScan, source: &str) -> &'static str {
        scan.sources.iter().find(|s| s.source == source).unwrap().outcome
    }

    fn assert_no_content(scan: &LocalScan) {
        let json = serde_json::to_string(scan).unwrap();
        assert!(!json.contains(SENTINEL), "the answer must not carry file content: {json}");
    }

    #[test]
    fn local_sessions_empty_machine_reports_zeroes_and_missing_sources() {
        let m = machine();
        let scan = scan(&m);
        for name in ["claude-code", "codex"] {
            let t = tool(&scan, name);
            assert_eq!((t.sessions_total, t.sessions_last_30d), (0, 0));
            assert_eq!(t.last_active_at, None);
            assert_eq!(t.share_last_30d, 0.0);
        }
        assert!(scan.repos.is_empty() && scan.projects.is_empty());
        assert!(scan.apps.is_empty() && scan.mcp_servers.is_empty());
        assert_eq!(outcome(&scan, "claude-code"), "missing");
        assert_eq!(outcome(&scan, "codex"), "missing");
        assert_eq!(outcome(&scan, "repos"), "missing");
        assert!(!scan.truncated);
    }

    #[test]
    fn local_sessions_claude_only_machine_counts_sessions_and_labels_projects() {
        let m = machine();
        let repo_path = repo(&m, "code/hq-desktop.app", 2);
        let encoded = repo_path.to_string_lossy().replace(['/', '.'], "-");
        claude_sessions(&m, &encoded, &[1, 3, 40]);
        let home_encoded = home(&m).to_string_lossy().replace(['/', '.'], "-");
        claude_sessions(&m, &format!("{home_encoded}-notes"), &[10]);
        claude_sessions(&m, &home_encoded, &[100]);

        let scan = scan(&m);
        let claude = tool(&scan, "claude-code");
        assert_eq!(claude.sessions_total, 5);
        assert_eq!(claude.sessions_last_30d, 3);
        assert_eq!(claude.share_last_30d, 1.0);
        assert_eq!(claude.last_active_at, to_ms(now() - DAY));
        let codex = tool(&scan, "codex");
        assert_eq!((codex.sessions_total, codex.share_last_30d), (0, 0.0));
        let names: Vec<_> = scan.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["hq-desktop.app", "notes", "home"]);
        assert_eq!(scan.projects[0].sessions, 3);
        assert_eq!(scan.repos.len(), 1);
        assert_eq!(scan.repos[0].last_commit_at, to_ms(now() - DAY * 2));
        assert_eq!(outcome(&scan, "claude-code"), "read");
        assert_eq!(outcome(&scan, "codex"), "missing");
        assert_no_content(&scan);
    }

    #[test]
    fn local_sessions_codex_heavy_machine_counts_dated_session_files() {
        let m = machine();
        let ages: Vec<u64> = (0..30).map(|i| if i < 24 { i } else { 60 + i }).collect();
        codex_sessions(&m, &ages);
        claude_sessions(&m, "-tmp-scratch", &[5, 50]);
        // Not a session: a stray file and a nested folder with a non-jsonl file.
        file_at(&m.roots.codex_dir.as_ref().unwrap().join("sessions").join("2026").join("notes.txt"), DAY);
        fs::write(
            m.roots.codex_dir.as_ref().unwrap().join("config.toml"),
            format!("[mcp_servers.linear]\ncommand = \"npx\"\nargs = [\"{SENTINEL}\"]\n[mcp_servers.linear.env]\nLINEAR_API_KEY = \"{SENTINEL}\"\n"),
        )
        .unwrap();

        let scan = scan(&m);
        let codex = tool(&scan, "codex");
        assert_eq!(codex.sessions_total, 30);
        assert_eq!(codex.sessions_last_30d, 24);
        assert_eq!(codex.last_active_at, to_ms(now()));
        let claude = tool(&scan, "claude-code");
        assert_eq!(claude.sessions_last_30d, 1);
        assert_eq!(codex.share_last_30d, 0.96);
        assert_eq!(claude.share_last_30d, 0.04);
        assert_eq!(scan.mcp_servers, ["linear"]);
        assert_eq!(scan.projects[0].name, "tmp-scratch");
        assert_no_content(&scan);
    }

    #[test]
    fn local_sessions_both_tools_with_repos_apps_and_mcp_servers() {
        let m = machine();
        let h = home(&m);
        claude_sessions(&m, "-work-a", &[1, 2, 3]);
        codex_sessions(&m, &[4]);
        repo(&m, "code/old", 300);
        repo(&m, "code/org/new", 1);
        repo(&m, "Documents/GitHub/site", 20);
        // Too deep, hidden, and inside node_modules: not found.
        repo(&m, "code/a/b/c/deep", 1);
        repo(&m, "code/.hidden/r", 1);
        repo(&m, "code/node_modules/pkg", 1);
        // A worktree: `.git` is a file.
        fs::create_dir_all(h.join("dev/wt")).unwrap();
        fs::write(h.join("dev/wt/.git"), format!("gitdir: {SENTINEL}\n")).unwrap();
        // With no logs/HEAD the `.git` file's own time is the last commit time.
        fs::File::options()
            .write(true)
            .open(h.join("dev/wt/.git"))
            .unwrap()
            .set_modified(now() - DAY * 400)
            .unwrap();
        fs::create_dir_all(h.join("Applications/Linear.app")).unwrap();
        fs::write(
            h.join(".claude.json"),
            format!(
                "{{\"mcpServers\":{{\"github\":{{\"command\":\"{SENTINEL}\",\"env\":{{\"GITHUB_TOKEN\":\"{SENTINEL}\"}}}}}}}}"
            ),
        )
        .unwrap();

        let scan = scan(&m);
        assert_eq!(tool(&scan, "claude-code").sessions_last_30d, 3);
        assert_eq!(tool(&scan, "codex").sessions_last_30d, 1);
        assert_eq!(tool(&scan, "claude-code").share_last_30d, 0.75);
        assert_eq!(tool(&scan, "codex").share_last_30d, 0.25);
        let repos: Vec<_> = scan
            .repos
            .iter()
            .map(|r| Path::new(&r.path).strip_prefix(&h).unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(repos[0], "code/org/new");
        assert_eq!(repos[1], "Documents/GitHub/site");
        assert_eq!(repos[2], "code/old");
        assert_eq!(repos[3], "dev/wt");
        assert_eq!(repos.len(), 4);
        assert_eq!(scan.mcp_servers, ["github"]);
        if cfg!(target_os = "macos") {
            assert_eq!(scan.apps, ["Linear"]);
        }
        assert!(scan.sources.iter().all(|s| s.outcome != "budget"));
        assert!(!scan.truncated);
        assert_no_content(&scan);
    }

    #[test]
    fn local_sessions_spent_budget_marks_the_answer_truncated() {
        let m = machine();
        claude_sessions(&m, "-work-a", &[1, 2]);
        codex_sessions(&m, &[1]);
        let scan = scan_local_sessions_in(&m.roots, now(), Duration::ZERO);
        assert!(scan.truncated);
        assert_eq!(outcome(&scan, "claude-code"), "budget");
        assert_eq!(outcome(&scan, "apps"), "budget");
        assert_eq!(probe_result(&scan), "timeout");
    }

    #[test]
    fn local_sessions_log_lines_hold_counts_and_no_names() {
        let m = machine();
        claude_sessions(&m, "-work-secret-project", &[1]);
        repo(&m, "code/private-repo", 1);
        let scan = scan(&m);
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log.clone());
        log_scan(&scan);
        let text = fs::read_to_string(&log).unwrap();
        assert!(text.contains(&format!(
            "[first-run] kind=probe tool=scan result=passed elapsed_ms={}",
            scan.elapsed_ms
        )));
        assert!(text.contains("claude-code=read:1"));
        assert!(text.contains("repos=read:1"));
        assert!(!text.contains("secret-project") && !text.contains("private-repo"));
        assert!(!text.contains(&home(&m).to_string_lossy().into_owned()));
    }
}
