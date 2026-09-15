//! On-disk scanners for local agent-CLI usage telemetry.
//!
//! These read the Claude Code and Codex CLI history that the user's own local
//! installs write, so usage/cost telemetry keeps working. They are independent
//! of the in-app Sessions feature (removed): nothing here starts, drives, or
//! renders a session — it only locates history files already on disk.
//!
//! Extracted verbatim from the former `sessions::{claude,codex}` modules when
//! the Sessions feature was removed, so telemetry coverage did not regress.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::config::MenubarPrefs;

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code: ~/.claude[-*]/projects roots
// ─────────────────────────────────────────────────────────────────────────────

pub fn resolve_claude_projects_dirs(
    home: &Path,
    menubar_path: &Path,
    projects_override: Option<&str>,
    config_override: Option<&str>,
) -> Vec<PathBuf> {
    if let Some(value) = projects_override.filter(|value| !value.trim().is_empty()) {
        return vec![PathBuf::from(value.trim())];
    }
    if let Some(value) = config_override.filter(|value| !value.trim().is_empty()) {
        return vec![PathBuf::from(value.trim()).join("projects")];
    }

    let mut candidates = vec![home.join(".claude").join("projects")];
    if let Some(saved) = std::fs::read_to_string(menubar_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<MenubarPrefs>(&raw).ok())
        .and_then(|prefs| prefs.claude_projects_dir)
        .filter(|value| !value.trim().is_empty())
    {
        candidates.push(PathBuf::from(saved.trim()));
    }
    if let Ok(entries) = std::fs::read_dir(home) {
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name == ".claude" || name.starts_with(".claude-"))
                && entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            {
                candidates.push(entry.path().join("projects"));
            }
        }
    }

    let mut roots = Vec::new();
    for candidate in candidates {
        if candidate.is_dir() && !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    if roots.is_empty() {
        roots.push(home.join(".claude").join("projects"));
    }
    roots
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex: ~/.codex rollout files
// ─────────────────────────────────────────────────────────────────────────────

pub struct RolloutFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: SystemTime,
}

pub fn enumerate_rollout_files(codex_dir: &Path) -> BTreeMap<String, RolloutFile> {
    let mut rollouts = BTreeMap::new();
    collect_rollouts(&codex_dir.join("sessions"), &mut rollouts);
    collect_rollouts(&codex_dir.join("archived_sessions"), &mut rollouts);
    rollouts
}

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

fn is_rollout_filename(name: &str) -> bool {
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

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
