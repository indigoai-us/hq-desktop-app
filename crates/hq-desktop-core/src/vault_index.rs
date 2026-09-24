//! In-memory index of one local HQ vault for the Files explorer.
//!
//! The explorer lists folders lazily (`list_dir_entries`), but the quick
//! switcher, `[[wikilink]]` resolution, backlinks and the vault home need the
//! whole vault. A [`VaultSnapshot`] walks one vault root, reads the links out
//! of each Markdown note, resolves them, and answers those questions directly,
//! so the renderer only ever receives the few rows it shows.
//!
//! Rebuilding is incremental: [`VaultSnapshot::build`] takes the previous
//! snapshot and re-reads only notes whose size or modified time changed. A
//! walk that only stats files is what an unchanged vault costs.
//!
//! A vault root is either `companies/<slug>` (a company vault) or the HQ root
//! itself (the personal vault). The personal vault mirrors what the personal
//! sync pushes: the HQ root minus `companies/`, `repos/` and `workspace/`.
//! HQ's own scaffold (`core/`, `docs/`, root instruction files) and dotfiles
//! are left out unless `include_system` is set, so they never crowd out the
//! person's notes.
//!
//! Never indexed, at any depth: curated dev noise and dot-directories (the
//! lazy tree's rule), symlinks (they can alias another company or leave HQ),
//! `settings/` and `secrets/` folders, and files whose names mark them as
//! credentials. The explorer is something people show on screen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, is_dev_noise, is_within,
    validate_hq_relative_path,
};

/// Most files one snapshot holds. Larger vaults are marked `truncated`.
pub const MAX_INDEX_FILES: usize = 200_000;
/// Largest Markdown note scanned for links. Bigger notes are listed, unscanned.
pub const MAX_LINK_SCAN_BYTES: u64 = 512 * 1024;
/// Most links recorded per note.
const MAX_LINKS_PER_NOTE: usize = 500;
/// Most backlinks returned for one note; `backlink_count` has the total.
pub const MAX_BACKLINKS: usize = 200;

/// Top-level folders that belong to other vaults, never the personal one.
pub const PERSONAL_VAULT_EXCLUDED_TOP_LEVEL: &[&str] = &[".git", "companies", "repos", "workspace"];

/// HQ scaffold at the personal vault's top level; indexed only with `include_system`.
pub const PERSONAL_SYSTEM_TOP_LEVEL: &[&str] = &[
    "core",
    "docs",
    "sync-manifests",
    "AGENTS.md",
    "CLAUDE.md",
    "LICENSE",
    "README.md",
];

/// True for names the explorer must never list: credential files and the
/// folders where HQ keeps service config and keys.
pub fn is_sensitive_name(name: &str, is_dir: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    if is_dir {
        return lower == "settings" || lower == "secrets" || lower == ".ssh";
    }
    if lower == ".env" || (lower.starts_with(".env.") && lower != ".env.example") {
        return true;
    }
    if matches!(
        lower.as_str(),
        ".netrc" | ".npmrc" | "id_rsa" | "id_ed25519"
    ) {
        return true;
    }
    if [".pem", ".key", ".p12", ".pfx", ".keystore"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
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

fn strip_md_ext(s: &str) -> &str {
    let lower = s.to_ascii_lowercase();
    if lower.ends_with(".markdown") {
        &s[..s.len() - ".markdown".len()]
    } else if lower.ends_with(".md") {
        &s[..s.len() - ".md".len()]
    } else {
        s
    }
}

/// Pull `[[target]]` values out of Markdown, skipping fenced code blocks and
/// inline code spans. Keeps the part before `|` (alias) and `#` (heading),
/// trimmed and deduplicated. An embed's leading `!` is outside the brackets.
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
            if let Some(after) = rest.strip_prefix('`') {
                in_code = !in_code;
                rest = after;
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
                    if !target.is_empty() && !out.iter().any(|t| t == target) {
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

// ---- snapshot ------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Entry {
    /// HQ-folder-relative, forward-slash path.
    path: String,
    name: String,
    is_markdown: bool,
    size: u64,
    modified_ns: u128,
    /// Raw wikilink targets, for Markdown notes.
    links: Vec<String>,
}

/// One indexed vault. Immutable once built; share it behind an `Arc`.
#[derive(Debug)]
pub struct VaultSnapshot {
    root: String,
    include_system: bool,
    entries: Vec<Entry>,
    by_path: HashMap<String, usize>,
    /// File name (lower-cased, with and without `.md`) → entries, shortest path first.
    by_name: HashMap<String, Vec<usize>>,
    /// Resolved outgoing links per entry (entry indexes, deduplicated).
    outgoing: Vec<Vec<usize>>,
    /// Entries that link to each entry.
    incoming: Vec<Vec<usize>>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub is_markdown: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNote {
    pub path: String,
    /// Links in: how many notes link here (hubs on the vault home).
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderCount {
    pub name: String,
    pub files: usize,
}

/// What the vault home shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub root: String,
    pub notes: usize,
    pub files: usize,
    pub links: usize,
    pub truncated: bool,
    /// The notes the most other notes link to.
    pub hubs: Vec<LinkedNote>,
    /// Top-level folders by file count.
    pub folders: Vec<FolderCount>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    /// The target as written, e.g. `clients/Lumen`.
    pub target: String,
    /// The file it opens, or null when nothing in the vault matches.
    pub path: Option<String>,
}

/// Link context for one open note.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinks {
    /// Each requested target, resolved.
    pub resolved: Vec<ResolvedLink>,
    /// Notes that link to this one, by name, at most [`MAX_BACKLINKS`].
    pub backlinks: Vec<FileHit>,
    /// How many notes link to this one in total.
    pub backlink_count: usize,
    /// Files this note links to, as last indexed.
    pub outgoing: Vec<FileHit>,
}

impl VaultSnapshot {
    /// Index one vault. `root_rel` is `""` (personal) or `companies/<slug>`.
    /// Company authorization is the caller's job; this enforces the path
    /// rules. `previous` (same root) lets unchanged notes skip a re-read.
    pub fn build(
        hq_root: &Path,
        root_rel: &str,
        include_system: bool,
        previous: Option<&VaultSnapshot>,
    ) -> Result<Self, String> {
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
        let canonical_root = std::fs::canonicalize(hq_root)
            .map_err(|e| format!("could not resolve HQ folder: {e}"))?;
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

        let reuse: HashMap<&str, &Entry> = previous
            .filter(|p| p.root == normalized && p.include_system == include_system)
            .map(|p| p.entries.iter().map(|e| (e.path.as_str(), e)).collect())
            .unwrap_or_default();

        let mut entries: Vec<Entry> = Vec::new();
        // Notes whose links must be (re)read: (entry index, absolute path).
        let mut to_scan: Vec<(usize, PathBuf)> = Vec::new();
        let mut truncated = false;
        let mut stack: Vec<(PathBuf, String)> = vec![(start, normalized.clone())];
        'walk: while let Some((dir_abs, dir_rel)) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir_abs) else {
                continue;
            };
            let mut children: Vec<(String, PathBuf, bool, std::fs::Metadata)> = Vec::new();
            for entry in read.flatten() {
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
                if !include_system && name.starts_with('.') {
                    continue;
                }
                if personal && dir_rel.is_empty() {
                    if is_dir && PERSONAL_VAULT_EXCLUDED_TOP_LEVEL.contains(&name.as_str()) {
                        continue;
                    }
                    if !include_system && PERSONAL_SYSTEM_TOP_LEVEL.contains(&name.as_str()) {
                        continue;
                    }
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                children.push((name, entry.path(), is_dir, meta));
            }
            children.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
            let mut dirs: Vec<(PathBuf, String)> = Vec::new();
            for (name, abs, is_dir, meta) in children {
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
                if entries.len() >= MAX_INDEX_FILES {
                    truncated = true;
                    break 'walk;
                }
                let size = meta.len();
                let modified_ns = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let is_markdown = is_markdown_name(&name);
                let links = match reuse.get(rel.as_str()) {
                    Some(prev) if prev.size == size && prev.modified_ns == modified_ns => {
                        prev.links.clone()
                    }
                    _ => {
                        if is_markdown && size <= MAX_LINK_SCAN_BYTES {
                            to_scan.push((entries.len(), abs));
                        }
                        Vec::new()
                    }
                };
                entries.push(Entry {
                    path: rel,
                    name,
                    is_markdown,
                    size,
                    modified_ns,
                    links,
                });
            }
            for dir in dirs.into_iter().rev() {
                stack.push(dir);
            }
        }

        for (i, links) in scan_links(to_scan) {
            entries[i].links = links;
        }

        let mut snapshot = VaultSnapshot {
            root: normalized,
            include_system,
            entries,
            by_path: HashMap::new(),
            by_name: HashMap::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            truncated,
        };
        snapshot.link();
        Ok(snapshot)
    }

    fn vault_relative<'a>(&self, path: &'a str) -> &'a str {
        if self.root.is_empty() {
            path
        } else {
            path.strip_prefix(&self.root)
                .and_then(|p| p.strip_prefix('/'))
                .unwrap_or(path)
        }
    }

    /// Build the lookup tables and the resolved link graph.
    fn link(&mut self) {
        let mut by_path = HashMap::with_capacity(self.entries.len() * 2);
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, e) in self.entries.iter().enumerate() {
            let rel = self.vault_relative(&e.path).to_lowercase();
            by_path.entry(strip_md_ext(&rel).to_string()).or_insert(i);
            by_path.insert(rel, i);
            let name = e.name.to_lowercase();
            let stem = strip_md_ext(&name).to_string();
            if stem != name {
                by_name.entry(stem).or_default().push(i);
            }
            by_name.entry(name).or_default().push(i);
        }
        let entries = &self.entries;
        for list in by_name.values_mut() {
            list.sort_by_key(|&i| (entries[i].path.matches('/').count(), entries[i].path.len()));
        }
        self.by_path = by_path;
        self.by_name = by_name;

        let mut outgoing = vec![Vec::new(); self.entries.len()];
        let mut incoming = vec![Vec::new(); self.entries.len()];
        for i in 0..self.entries.len() {
            let mut out: Vec<usize> = Vec::new();
            for target in &self.entries[i].links {
                if let Some(j) = self.resolve_index(target, &self.entries[i].path) {
                    if j != i && !out.contains(&j) {
                        out.push(j);
                    }
                }
            }
            for &j in &out {
                incoming[j].push(i);
            }
            outgoing[i] = out;
        }
        self.outgoing = outgoing;
        self.incoming = incoming;
    }

    /// Resolve `[[target]]` the way Obsidian does, inside this vault: the exact
    /// vault path (with or without `.md`), then a path relative to the linking
    /// note's folder, then a file-name match (shortest path wins; a target
    /// with folders prefers a file whose path ends that way).
    fn resolve_index(&self, target: &str, from_path: &str) -> Option<usize> {
        let clean = target
            .trim()
            .trim_start_matches('/')
            .replace('\\', "/")
            .to_lowercase();
        if clean.is_empty() {
            return None;
        }
        if let Some(&i) = self.by_path.get(&clean) {
            return Some(i);
        }
        let from_rel = self.vault_relative(from_path).to_lowercase();
        let mut parts: Vec<&str> = from_rel.split('/').collect();
        parts.pop();
        for part in clean.split('/') {
            match part {
                ".." => {
                    parts.pop();
                }
                "." | "" => {}
                p => parts.push(p),
            }
        }
        if let Some(&i) = self.by_path.get(&parts.join("/")) {
            return Some(i);
        }
        let last = clean.rsplit('/').next().unwrap_or(&clean);
        let candidates = self.by_name.get(last)?;
        if clean.contains('/') {
            let suffix = format!("/{}", strip_md_ext(&clean));
            if let Some(&i) = candidates
                .iter()
                .find(|&&i| strip_md_ext(&self.entries[i].path.to_lowercase()).ends_with(&suffix))
            {
                return Some(i);
            }
        }
        candidates.first().copied()
    }

    /// The file a `[[target]]` in `from_path` opens.
    pub fn resolve(&self, target: &str, from_path: &str) -> Option<&str> {
        self.resolve_index(target, from_path)
            .map(|i| self.entries[i].path.as_str())
    }

    fn hit(&self, i: usize) -> FileHit {
        let e = &self.entries[i];
        FileHit {
            path: e.path.clone(),
            name: e.name.clone(),
            is_markdown: e.is_markdown,
        }
    }

    fn sorted_hits(&self, mut idx: Vec<usize>) -> Vec<FileHit> {
        idx.sort_by(|&a, &b| {
            strip_md_ext(&self.entries[a].name)
                .to_lowercase()
                .cmp(&strip_md_ext(&self.entries[b].name).to_lowercase())
        });
        idx.into_iter().map(|i| self.hit(i)).collect()
    }

    pub fn summary(&self) -> VaultSummary {
        let notes = self.entries.iter().filter(|e| e.is_markdown).count();
        let links = self.outgoing.iter().map(Vec::len).sum();
        let mut hubs: Vec<(usize, usize)> = self
            .incoming
            .iter()
            .enumerate()
            .filter(|(_, v)| !v.is_empty())
            .map(|(i, v)| (i, v.len()))
            .collect();
        hubs.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| self.entries[a.0].path.cmp(&self.entries[b.0].path))
        });
        let mut folders: HashMap<&str, usize> = HashMap::new();
        for e in &self.entries {
            let rel = self.vault_relative(&e.path);
            if let Some((top, _)) = rel.split_once('/') {
                *folders.entry(top).or_default() += 1;
            }
        }
        let mut folders: Vec<FolderCount> = folders
            .into_iter()
            .map(|(name, files)| FolderCount {
                name: name.to_string(),
                files,
            })
            .collect();
        folders.sort_by(|a, b| b.files.cmp(&a.files).then_with(|| a.name.cmp(&b.name)));
        folders.truncate(9);
        VaultSummary {
            root: self.root.clone(),
            notes,
            files: self.entries.len(),
            links,
            truncated: self.truncated,
            hubs: hubs
                .into_iter()
                .take(8)
                .map(|(i, count)| LinkedNote {
                    path: self.entries[i].path.clone(),
                    count,
                })
                .collect(),
            folders,
        }
    }

    /// Quick switcher: files whose vault path contains the query's characters
    /// in order. File-name matches, consecutive runs and word starts rank
    /// higher; notes edge out other files. An empty query lists notes.
    pub fn search(&self, query: &str, limit: usize) -> Vec<FileHit> {
        let q: Vec<char> = query
            .trim()
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if q.is_empty() {
            return self
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.is_markdown)
                .take(limit)
                .map(|(i, _)| self.hit(i))
                .collect();
        }
        let mut scored: Vec<(f64, usize)> = Vec::new();
        for (i, e) in self.entries.iter().enumerate() {
            if let Some(s) = fuzzy_score(&q, &self.vault_relative(&e.path).to_lowercase()) {
                scored.push((s + if e.is_markdown { 1.0 } else { 0.0 }, i));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, i)| self.hit(i))
            .collect()
    }

    /// Links for one open note: each written target resolved, the notes that
    /// link here, and the files it links to.
    pub fn note_links(&self, path: &str, targets: &[String]) -> NoteLinks {
        let resolved = targets
            .iter()
            .take(MAX_LINKS_PER_NOTE)
            .map(|t| ResolvedLink {
                target: t.clone(),
                path: self.resolve(t, path).map(str::to_string),
            })
            .collect();
        let Some(&i) = self.by_path.get(&self.vault_relative(path).to_lowercase()) else {
            return NoteLinks {
                resolved,
                backlinks: Vec::new(),
                backlink_count: 0,
                outgoing: Vec::new(),
            };
        };
        NoteLinks {
            resolved,
            backlinks: {
                let mut hits = self.sorted_hits(self.incoming[i].clone());
                hits.truncate(MAX_BACKLINKS);
                hits
            },
            backlink_count: self.incoming[i].len(),
            outgoing: self.outgoing[i].iter().map(|&j| self.hit(j)).collect(),
        }
    }
}

/// Read the wikilinks out of many notes at once. Reading is I/O bound, so the
/// notes are split across the machine's cores; a first build of a large vault
/// is otherwise one file read after another.
fn scan_links(to_scan: Vec<(usize, PathBuf)>) -> Vec<(usize, Vec<String>)> {
    let read = |path: &Path| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|text| extract_wikilinks(&text))
            .unwrap_or_default()
    };
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 8);
    if workers == 1 || to_scan.len() < 256 {
        return to_scan.into_iter().map(|(i, p)| (i, read(&p))).collect();
    }
    let chunk = to_scan.len().div_ceil(workers);
    std::thread::scope(|scope| {
        let handles: Vec<_> = to_scan
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || part.iter().map(|(i, p)| (*i, read(p))).collect::<Vec<_>>())
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

/// Score `q` (lower-cased, no spaces) against a lower-cased vault path. Every
/// character must appear in order; `None` when it does not.
fn fuzzy_score(q: &[char], path: &str) -> Option<f64> {
    let chars: Vec<char> = path.chars().collect();
    let name_start = chars.iter().rposition(|&c| c == '/').map_or(0, |p| p + 1);
    let mut score = 0.0;
    let mut from = 0usize;
    let mut prev: Option<usize> = None;
    for &ch in q {
        let idx = (from..chars.len()).find(|&k| chars[k] == ch)?;
        score += 1.0;
        if idx >= name_start {
            score += 2.0;
        }
        if prev == Some(idx.wrapping_sub(1)) && idx > 0 {
            score += 3.0;
        }
        let before = if idx == 0 { None } else { Some(chars[idx - 1]) };
        if matches!(
            before,
            None | Some('/') | Some('-') | Some('_') | Some(' ') | Some('.')
        ) {
            score += 2.0;
        }
        prev = Some(idx);
        from = idx + 1;
    }
    // The greedy walk above can scatter a query across folder names; a file
    // whose name holds the query as written always ranks above those.
    let name: String = chars[name_start..].iter().collect();
    let query: String = q.iter().collect();
    if name.starts_with(&query) {
        score += 30.0;
    } else if name.contains(&query) {
        score += 20.0;
    } else if path.contains(&query) {
        score += 8.0;
    }
    Some(score - chars.len() as f64 * 0.01)
}

/// The first `max_bytes` of a text file, cut at a line break so a partial note
/// never ends mid-line. `truncated` says whether anything was left out.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotePreview {
    pub text: String,
    pub size: u64,
    pub truncated: bool,
}

pub fn read_note_head(path: &Path, max_bytes: u64) -> Result<NotePreview, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("could not inspect file: {e}"))?
        .len();
    let mut bytes = Vec::with_capacity(size.min(max_bytes) as usize);
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read file: {e}"))?;
    let truncated = size > max_bytes;
    if truncated {
        if let Some(cut) = bytes.iter().rposition(|&b| b == b'\n') {
            bytes.truncate(cut + 1);
        }
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) if truncated => {
            // The cut can split a multi-byte character; keep the valid prefix.
            let valid = err.utf8_error().valid_up_to();
            let mut bytes = err.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).unwrap_or_default()
        }
        Err(_) => return Err("cannot preview binary file".to_string()),
    };
    Ok(NotePreview {
        text,
        size,
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

    fn paths(s: &VaultSnapshot) -> Vec<&str> {
        s.entries.iter().map(|e| e.path.as_str()).collect()
    }

    fn hit_paths(h: &[FileHit]) -> Vec<&str> {
        h.iter().map(|f| f.path.as_str()).collect()
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
    fn indexes_a_company_vault_and_hides_settings_secrets_noise_and_dotfiles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/knowledge/a.md", "Links to [[b]].");
        write(root, "companies/acme/knowledge/b.md", "# B");
        write(root, "companies/acme/settings/keys.json", "{}");
        write(root, "companies/acme/secrets/x/oauth-token.json", "{}");
        write(root, "companies/acme/.env", "X=1");
        write(root, "companies/acme/.hq-sync-journal.json", "{}");
        write(root, "companies/acme/stripe-credentials.json", "{}");
        write(root, "companies/acme/node_modules/x/index.js", "");
        write(root, "companies/other/knowledge/c.md", "");
        let s = VaultSnapshot::build(root, "companies/acme", false, None).unwrap();
        assert_eq!(
            paths(&s),
            vec![
                "companies/acme/knowledge/a.md",
                "companies/acme/knowledge/b.md"
            ]
        );
        let with_system = VaultSnapshot::build(root, "companies/acme", true, None).unwrap();
        assert!(paths(&with_system).contains(&"companies/acme/.hq-sync-journal.json"));
        assert!(!paths(&with_system)
            .iter()
            .any(|p| p.contains("secrets") || p.contains("settings")));
    }

    #[test]
    fn personal_vault_leaves_out_other_vaults_and_scaffold_unless_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "personal/notes/today.md", "");
        write(root, "knowledge/x.md", "");
        write(root, "core/skills/big.md", "");
        write(root, "CLAUDE.md", "");
        write(root, "companies/acme/a.md", "");
        write(root, "repos/private/r/README.md", "");
        write(root, "workspace/drafts/d.md", "");
        let s = VaultSnapshot::build(root, "", false, None).unwrap();
        assert_eq!(paths(&s), vec!["knowledge/x.md", "personal/notes/today.md"]);
        let all = VaultSnapshot::build(root, "", true, None).unwrap();
        assert_eq!(
            paths(&all),
            vec![
                "CLAUDE.md",
                "core/skills/big.md",
                "knowledge/x.md",
                "personal/notes/today.md"
            ]
        );
    }

    #[test]
    fn refuses_roots_that_are_not_a_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/knowledge/a.md", "");
        assert!(VaultSnapshot::build(root, "companies/acme/knowledge", false, None).is_err());
        assert!(VaultSnapshot::build(root, "repos", false, None).is_err());
        assert!(VaultSnapshot::build(root, "../etc", false, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_that_could_alias_another_company() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/a.md", "");
        write(root, "companies/other/plan.md", "");
        std::os::unix::fs::symlink(
            root.join("companies/other"),
            root.join("companies/acme/linked"),
        )
        .unwrap();
        let s = VaultSnapshot::build(root, "companies/acme", false, None).unwrap();
        assert_eq!(paths(&s), vec!["companies/acme/a.md"]);
    }

    fn acme() -> (tempfile::TempDir, VaultSnapshot) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "companies/acme/clients/Lumen.md",
            "[[pricing]] [[../knowledge/tone]] [[nowhere]]",
        );
        write(
            root,
            "companies/acme/knowledge/pricing.md",
            "[[clients/Lumen]] [[tone]]",
        );
        write(root, "companies/acme/knowledge/tone.md", "");
        write(root, "companies/acme/archive/old/pricing.md", "");
        write(root, "companies/acme/diagrams/flow.png", "png");
        let s = VaultSnapshot::build(root, "companies/acme", false, None).unwrap();
        (tmp, s)
    }

    #[test]
    fn resolves_like_obsidian() {
        let (_t, s) = acme();
        assert_eq!(
            s.resolve("clients/Lumen", "companies/acme/knowledge/pricing.md"),
            Some("companies/acme/clients/Lumen.md")
        );
        assert_eq!(
            s.resolve("../knowledge/tone", "companies/acme/clients/Lumen.md"),
            Some("companies/acme/knowledge/tone.md")
        );
        // Shortest path wins for a bare name.
        assert_eq!(
            s.resolve("pricing", "x"),
            Some("companies/acme/knowledge/pricing.md")
        );
        assert_eq!(
            s.resolve("old/pricing", "x"),
            Some("companies/acme/archive/old/pricing.md")
        );
        assert_eq!(
            s.resolve("flow.png", "x"),
            Some("companies/acme/diagrams/flow.png")
        );
        assert_eq!(s.resolve("nowhere", "x"), None);
    }

    #[test]
    fn answers_backlinks_outgoing_and_the_summary() {
        let (_t, s) = acme();
        let links = s.note_links(
            "companies/acme/knowledge/tone.md",
            &["pricing".to_string(), "ghost".to_string()],
        );
        assert_eq!(
            hit_paths(&links.backlinks),
            vec![
                "companies/acme/clients/Lumen.md",
                "companies/acme/knowledge/pricing.md"
            ]
        );
        assert_eq!(
            links.resolved[0].path.as_deref(),
            Some("companies/acme/knowledge/pricing.md")
        );
        assert_eq!(links.resolved[1].path, None);
        let lumen = s.note_links("companies/acme/clients/Lumen.md", &[]);
        assert_eq!(
            hit_paths(&lumen.outgoing),
            vec![
                "companies/acme/knowledge/pricing.md",
                "companies/acme/knowledge/tone.md"
            ]
        );

        let summary = s.summary();
        assert_eq!((summary.notes, summary.files, summary.links), (4, 5, 4));
        assert_eq!(summary.hubs[0].count, 2);
        assert_eq!(
            summary.folders[0],
            FolderCount {
                name: "knowledge".into(),
                files: 2
            }
        );
    }

    #[test]
    fn quick_switcher_ranks_file_name_matches_first() {
        let (_t, s) = acme();
        let hits = s.search("pric", 10);
        assert_eq!(hits[0].path, "companies/acme/knowledge/pricing.md");
        assert!(s.search("zzz", 10).is_empty());
        assert_eq!(s.search("", 2).len(), 2);
    }

    #[test]
    fn quick_switcher_prefers_a_name_containing_the_query_over_scattered_path_letters() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Every letter of "dedup" appears in order across these folder names.
        write(
            root,
            "companies/acme/data/experiments/synthetic-consumer-ad-benchmark/nanit-development/cohort-audit.private.json",
            "{}",
        );
        write(
            root,
            "companies/acme/knowledge/captures/2026-08-03-nanit-class-media-fanout-dedup.md",
            "",
        );
        let s = VaultSnapshot::build(root, "companies/acme", false, None).unwrap();
        assert_eq!(
            s.search("dedup", 10)[0].path,
            "companies/acme/knowledge/captures/2026-08-03-nanit-class-media-fanout-dedup.md"
        );
    }

    #[test]
    fn rebuild_reuses_unchanged_notes_and_rereads_changed_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "companies/acme/a.md", "[[b]]");
        write(root, "companies/acme/b.md", "");
        let first = VaultSnapshot::build(root, "companies/acme", false, None).unwrap();
        // Same size and mtime would be reused; a changed note is re-read.
        write(root, "companies/acme/a.md", "[[c]] and more");
        write(root, "companies/acme/c.md", "");
        let second = VaultSnapshot::build(root, "companies/acme", false, Some(&first)).unwrap();
        assert_eq!(
            second.resolve("c", "companies/acme/a.md"),
            Some("companies/acme/c.md")
        );
        assert_eq!(
            hit_paths(&second.note_links("companies/acme/c.md", &[]).backlinks),
            vec!["companies/acme/a.md"]
        );
    }

    #[test]
    fn note_head_cuts_at_a_line_and_reports_truncation() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("n.md");
        fs::write(&p, "line one\nline two\nline three\n").unwrap();
        let head = read_note_head(&p, 14).unwrap();
        assert_eq!(head.text, "line one\n");
        assert!(head.truncated);
        let whole = read_note_head(&p, 1024).unwrap();
        assert!(!whole.truncated);
        assert_eq!(whole.size, 29);
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
