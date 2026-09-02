//! Workers + skills catalog for the Sessions composer.
//!
//! Two independent sources, merged into one payload:
//!
//!   * **Workers** — `core/workers/registry.yaml`, the generated index written
//!     by `core/scripts/generate-workers-registry.sh`. It carries `id`, `path`,
//!     `description`, and an optional `company` per worker, but **not** the
//!     display name and **not** the worker's skills — those live next to the
//!     worker itself (`{path}/worker.yaml` and `{path}/skills/`), so we read a
//!     bounded head of each.
//!
//!   * **Skills** — `.claude/skills/<dir>/SKILL.md`. The directory name is the
//!     slash invocation (`/handoff`, `/personal:adr`, `/indigo:capture`) while
//!     the frontmatter `name` is the bare skill name; both are surfaced.
//!
//! On a real HQ root `.claude/skills` holds ~14k directories, of which ~13.2k
//! are `.conflict-<ts>-<hash>` sync artifacts. Those are skipped before any
//! file is opened, which is what keeps this call affordable.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{clamp, is_skippable_entry_name, read_head, split_frontmatter, HEAD_BYTES};

/// Descriptions are clamped so a verbose worker blurb (some run 1.5 KB) can't
/// dominate the payload.
const MAX_DESCRIPTION_CHARS: usize = 200;
/// Hard ceiling on workers emitted.
const MAX_WORKERS: usize = 400;
/// Hard ceiling on skills listed per worker.
const MAX_SKILLS_PER_WORKER: usize = 40;
/// Hard ceiling on `.claude/skills` entries opened and emitted.
const MAX_SKILLS: usize = 2_000;
/// Hard ceiling on tags carried per entry.
const MAX_TAGS: usize = 12;
/// Catalog cache lifetime.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// One skill exposed by a worker. `invoke` is the HQ slash form,
/// `/run {worker} {skill}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSkill {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub invoke: String,
}

/// One worker from the generated registry, enriched with its display name and
/// skills.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub company: Option<String>,
    pub skills: Vec<WorkerSkill>,
}

/// One `.claude/skills` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// Frontmatter `name`, falling back to the un-namespaced directory name.
    pub name: String,
    pub description: String,
    /// `"core"` | `"personal"` | `"company:<slug>"` | `"package"`.
    pub scope: String,
    pub tags: Vec<String>,
    /// The literal slash invocation, built from the directory name.
    pub invoke: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub workers: Vec<WorkerEntry>,
    pub skills: Vec<SkillEntry>,
}

// ── registry.yaml ───────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    workers: Vec<RegistryWorker>,
}

#[derive(Debug, Deserialize)]
struct RegistryWorker {
    #[serde(default)]
    id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    company: Option<String>,
}

/// Build the catalog for `hq_root`, optionally scoped to one company.
///
/// Company scoping drops *other* companies' workers and skills; core, personal
/// and package skills — and company-less (shared) workers — always stay.
pub fn build_skill_catalog(hq_root: &Path, company: Option<&str>) -> SkillCatalog {
    let company = company.map(str::trim).filter(|slug| !slug.is_empty());
    SkillCatalog {
        workers: collect_workers(hq_root, company),
        skills: collect_skills(hq_root, company),
    }
}

/// Cached wrapper over [`build_skill_catalog`] with a 60 s TTL, keyed by
/// `(hq_root, company)`.
///
/// The catalog walks thousands of directories, and the composer re-queries it
/// on every open — so the cache is what makes it cheap the second time. An
/// entry is also invalidated early when `core/workers/registry.yaml` or the
/// `.claude/skills` directory mtime moves, so a freshly generated registry or a
/// newly installed skill shows up without waiting out the TTL.
pub fn build_skill_catalog_cached(hq_root: &Path, company: Option<&str>) -> SkillCatalog {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), CacheEntry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (
        hq_root.to_path_buf(),
        company.unwrap_or_default().to_string(),
    );
    let stamp = catalog_stamp(hq_root);

    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.stored_at.elapsed() < CACHE_TTL && entry.stamp == stamp {
                return entry.catalog.clone();
            }
        }
    }

    let catalog = build_skill_catalog(hq_root, company);
    if let Ok(mut guard) = cache.lock() {
        // Bound the cache itself: one entry per company is the realistic
        // ceiling, but a pathological caller must not grow it without limit.
        if guard.len() > 64 {
            guard.clear();
        }
        guard.insert(
            key,
            CacheEntry {
                stored_at: Instant::now(),
                stamp,
                catalog: catalog.clone(),
            },
        );
    }
    catalog
}

struct CacheEntry {
    stored_at: Instant,
    stamp: (Option<std::time::SystemTime>, Option<std::time::SystemTime>),
    catalog: SkillCatalog,
}

fn catalog_stamp(hq_root: &Path) -> (Option<std::time::SystemTime>, Option<std::time::SystemTime>) {
    let mtime = |path: PathBuf| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    (
        mtime(hq_root.join("core/workers/registry.yaml")),
        mtime(hq_root.join(".claude/skills")),
    )
}

fn collect_workers(hq_root: &Path, company: Option<&str>) -> Vec<WorkerEntry> {
    let registry_path = hq_root.join("core/workers/registry.yaml");
    let Ok(raw) = std::fs::read_to_string(&registry_path) else {
        return Vec::new();
    };
    let registry: RegistryFile = serde_yaml::from_str(&raw).unwrap_or_default();

    let mut out = Vec::new();
    for worker in registry.workers {
        if out.len() >= MAX_WORKERS {
            break;
        }
        if worker.id.trim().is_empty() {
            continue;
        }
        // Company scoping: keep this company's workers plus shared (company-less)
        // ones; drop every other tenant's.
        if let (Some(wanted), Some(owner)) = (company, worker.company.as_deref()) {
            if owner != wanted {
                continue;
            }
        }
        let relative = worker.path.trim().trim_end_matches('/');
        let worker_dir = if relative.is_empty() {
            hq_root.to_path_buf()
        } else {
            hq_root.join(relative)
        };

        let id = worker.id.trim().to_string();
        out.push(WorkerEntry {
            name: worker_display_name(&worker_dir).unwrap_or_else(|| humanize(&id)),
            skills: collect_worker_skills(&worker_dir, &id),
            description: clamp(&worker.description, MAX_DESCRIPTION_CHARS),
            company: worker.company.filter(|c| !c.trim().is_empty()),
            id,
        });
    }
    out
}

/// Pull `worker.name` out of a `worker.yaml` head.
///
/// Deliberately a line scan rather than a YAML parse: `worker.yaml` carries a
/// multi-KB `instructions: |` block, so a bounded head is routinely not valid
/// YAML on its own.
fn worker_display_name(worker_dir: &Path) -> Option<String> {
    let raw = read_head(&worker_dir.join("worker.yaml"), 4096)?;
    let mut in_worker_block = false;
    for line in raw.lines() {
        if line.starts_with("worker:") {
            in_worker_block = true;
            continue;
        }
        if in_worker_block {
            if !line.starts_with(' ') && !line.trim().is_empty() {
                break; // left the `worker:` block
            }
            if let Some(rest) = line.trim().strip_prefix("name:") {
                let name = rest.trim().trim_matches(['"', '\'']).trim();
                if !name.is_empty() {
                    return Some(clamp(name, 120));
                }
            }
        }
    }
    None
}

/// Enumerate `{worker}/skills/` — both flat `<skill>.md` files and nested
/// `<skill>/SKILL.md` directories are in use across HQ.
fn collect_worker_skills(worker_dir: &Path, worker_id: &str) -> Vec<WorkerSkill> {
    let skills_dir = worker_dir.join("skills");
    let Ok(entries) = std::fs::read_dir(&skills_dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let nested = path.join("SKILL.md");
            if nested.is_file() {
                candidates.push((name, nested));
            }
        } else if let Some(stem) = name.strip_suffix(".md") {
            candidates.push((stem.to_string(), path));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    candidates.truncate(MAX_SKILLS_PER_WORKER);

    candidates
        .into_iter()
        .map(|(name, path)| {
            let (description, tags) = describe_markdown(&path);
            WorkerSkill {
                invoke: format!("/run {worker_id} {name}"),
                name,
                description,
                tags,
            }
        })
        .collect()
}

// ── .claude/skills ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    /// Some skills declare `triggers:` instead of / alongside `tags:`; both are
    /// surfaced as tags so the composer can filter on either.
    #[serde(default)]
    triggers: Vec<String>,
}

fn collect_skills(hq_root: &Path, company: Option<&str>) -> Vec<SkillEntry> {
    let skills_root = hq_root.join(".claude/skills");
    let Ok(entries) = std::fs::read_dir(&skills_root) else {
        return Vec::new();
    };
    let known_companies = manifest_company_slugs(hq_root);

    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_skippable_entry_name(&name) {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        dirs.push(name);
    }
    dirs.sort();

    let mut out = Vec::new();
    for dir_name in dirs {
        if out.len() >= MAX_SKILLS {
            break;
        }
        let scope = scope_for_dir(&dir_name, &known_companies);
        if let (Some(wanted), Scope::Company(owner)) = (company, &scope) {
            if owner != wanted {
                continue;
            }
        }
        let skill_md = skills_root.join(&dir_name).join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let front = read_head(&skill_md, HEAD_BYTES)
            .map(|raw| {
                let (front_yaml, _) = split_frontmatter(&raw);
                front_yaml
                    .and_then(|yaml| serde_yaml::from_str::<SkillFrontmatter>(yaml).ok())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        let bare = dir_name.rsplit(':').next().unwrap_or(&dir_name).to_string();
        let name = front
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| clamp(n, 120))
            .unwrap_or(bare);

        let mut tags: Vec<String> = front
            .tags
            .into_iter()
            .chain(front.triggers)
            .map(|tag| clamp(&tag, 60))
            .filter(|tag| !tag.is_empty())
            .collect();
        tags.dedup();
        tags.truncate(MAX_TAGS);

        out.push(SkillEntry {
            name,
            description: clamp(
                front.description.as_deref().unwrap_or_default(),
                MAX_DESCRIPTION_CHARS,
            ),
            scope: scope.to_string(),
            tags,
            invoke: format!("/{dir_name}"),
        });
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum Scope {
    Core,
    Personal,
    Company(String),
    Package,
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Scope::Core => f.write_str("core"),
            Scope::Personal => f.write_str("personal"),
            Scope::Company(slug) => write!(f, "company:{slug}"),
            Scope::Package => f.write_str("package"),
        }
    }
}

/// Scope a skill by its directory-name prefix:
/// `handoff` → core, `personal:adr` → personal, `indigo:capture` → company
/// (only when the prefix is a real manifest slug), anything else namespaced
/// (`hq-pack-parker:…`, `vercel:…`) → package.
fn scope_for_dir(dir_name: &str, known_companies: &BTreeSet<String>) -> Scope {
    let Some((prefix, _)) = dir_name.split_once(':') else {
        return Scope::Core;
    };
    if prefix == "personal" {
        return Scope::Personal;
    }
    if known_companies.contains(prefix) {
        return Scope::Company(prefix.to_string());
    }
    Scope::Package
}

/// Company slugs from `companies/manifest.yaml`.
///
/// Uses the same manifest reader the workspaces surface uses, so the slug list
/// (and therefore the company/package scope split) can never drift from what
/// the rest of the app considers a company.
fn manifest_company_slugs(hq_root: &Path) -> BTreeSet<String> {
    match crate::workspaces::read_manifest(hq_root) {
        crate::workspaces::ManifestLoad::Present(entries) => {
            entries.into_iter().map(|entry| entry.slug).collect()
        }
        _ => BTreeSet::new(),
    }
}

// ── shared markdown description extraction ──────────────────────────────────

/// `(description, tags)` for a worker skill file — frontmatter when present,
/// otherwise the first prose paragraph under the leading heading.
fn describe_markdown(path: &Path) -> (String, Vec<String>) {
    let Some(raw) = read_head(path, HEAD_BYTES) else {
        return (String::new(), Vec::new());
    };
    let (front_yaml, body) = split_frontmatter(&raw);
    let front = front_yaml
        .and_then(|yaml| serde_yaml::from_str::<SkillFrontmatter>(yaml).ok())
        .unwrap_or_default();

    let mut tags: Vec<String> = front
        .tags
        .into_iter()
        .chain(front.triggers)
        .map(|tag| clamp(&tag, 60))
        .filter(|tag| !tag.is_empty())
        .collect();
    tags.dedup();
    tags.truncate(MAX_TAGS);

    let description = match front.description.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => clamp(text, MAX_DESCRIPTION_CHARS),
        _ => clamp(first_paragraph(body), MAX_DESCRIPTION_CHARS),
    };
    (description, tags)
}

/// First non-empty, non-heading line of a markdown body.
fn first_paragraph(body: &str) -> &str {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .unwrap_or("")
}

fn humanize(id: &str) -> String {
    id.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// A fixture modelled on the real HQ root: a generated registry with a
    /// shared worker and two company workers, and a `.claude/skills` tree
    /// containing every scope plus a sync-conflict artifact.
    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        write(
            &root.join("companies/manifest.yaml"),
            "companies:\n  indigo:\n    name: Indigo\n  ridge:\n    name: Ridge\n",
        );

        write(
            &root.join("core/workers/registry.yaml"),
            r#"version: "5.0"
generated_at: "2026-09-02T04:54:47Z"

workers:
  - id: "architect"
    path: "core/workers/public/dev-team/architect/"
    type: "CodeWorker"
    visibility: "public"
    team: "dev-team"
    status: "active"
    description: "System design, API design, architecture decisions"
  - id: "amelia"
    path: "companies/indigo/workers/amelia/"
    type: "OpsWorker"
    visibility: "private"
    company: "indigo"
    status: "active"
    description: "Slack-native email analyst."
  - id: "ridge-analyst"
    path: "companies/ridge/workers/ridge-analyst/"
    type: "OpsWorker"
    visibility: "private"
    company: "ridge"
    status: "active"
    description: "Ridge reporting."
"#,
        );

        write(
            &root.join("core/workers/public/dev-team/architect/worker.yaml"),
            "worker:\n  id: architect\n  name: \"Architect\"\n  description: \"System design\"\n\nexecution:\n  name: not-the-worker-name\n",
        );
        write(
            &root.join("core/workers/public/dev-team/architect/skills/api-design.md"),
            "# api-design\n\nDesign API contracts and interfaces.\n",
        );
        write(
            &root.join("core/workers/public/dev-team/architect/skills/system-design/SKILL.md"),
            "---\nname: system-design\ndescription: Design system architecture for a feature.\ntags: [architecture, design]\n---\n\nbody\n",
        );
        // Worker with no worker.yaml and no skills dir at all.
        write(
            &root.join("companies/indigo/workers/amelia/README.md"),
            "no worker.yaml here\n",
        );

        let skills = root.join(".claude/skills");
        write(
            &skills.join("handoff/SKILL.md"),
            "---\nname: handoff\ndescription: Preserve session state for a follow-up agent.\n---\n\nbody\n",
        );
        write(
            &skills.join("personal:adr/SKILL.md"),
            "---\nname: adr\ndescription: Capture an Architectural Decision Record.\n---\n\nbody\n",
        );
        write(
            &skills.join("indigo:capture/SKILL.md"),
            "---\nskill_uid: skl_01\ntags: [screen, capture]\nname: capture\ndescription: Toggle Screenpipe capture.\n---\n\nbody\n",
        );
        write(
            &skills.join("ridge:upsell-report/SKILL.md"),
            "---\nname: upsell-report\ndescription: Ridge upsell reporting.\n---\n\nbody\n",
        );
        write(
            &skills.join("vercel:deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Deploy to Vercel.\n---\n\nbody\n",
        );
        // Missing every optional frontmatter field.
        write(
            &skills.join("bare-skill/SKILL.md"),
            "just a body, no frontmatter\n",
        );
        // Sync conflict artifact — must never appear.
        write(
            &skills.join("personal:adr.conflict-2026-08-22T22-17-32Z-9aea6b/SKILL.md"),
            "---\nname: adr\ndescription: conflict copy\n---\n",
        );
        // Scaffold dir — must never appear.
        write(&skills.join("_shared/SKILL.md"), "---\nname: shared\n---\n");
        // Directory with no SKILL.md — must never appear.
        fs::create_dir_all(skills.join("not-a-skill")).unwrap();

        tmp
    }

    #[test]
    fn registry_workers_carry_name_description_and_skills() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), None);
        let architect = catalog
            .workers
            .iter()
            .find(|w| w.id == "architect")
            .expect("architect present");
        // Display name comes from worker.yaml's `worker:` block, not the
        // unrelated `execution.name` key below it.
        assert_eq!(architect.name, "Architect");
        assert_eq!(architect.company, None);
        assert_eq!(
            architect.description,
            "System design, API design, architecture decisions"
        );
        let names: Vec<_> = architect.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["api-design", "system-design"]);
        // Flat `.md` skills fall back to the first prose line.
        assert_eq!(
            architect.skills[0].description,
            "Design API contracts and interfaces."
        );
        assert_eq!(architect.skills[0].invoke, "/run architect api-design");
        // Nested SKILL.md skills use frontmatter, including tags.
        assert_eq!(architect.skills[1].tags, vec!["architecture", "design"]);
        assert_eq!(architect.skills[1].invoke, "/run architect system-design");
    }

    #[test]
    fn worker_without_worker_yaml_falls_back_to_a_humanized_id() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), None);
        let ridge = catalog
            .workers
            .iter()
            .find(|w| w.id == "ridge-analyst")
            .expect("ridge worker present");
        assert_eq!(ridge.name, "Ridge Analyst");
        assert!(ridge.skills.is_empty());
    }

    #[test]
    fn skill_scopes_are_derived_from_the_directory_prefix() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), None);
        let scope_of = |name: &str| {
            catalog
                .skills
                .iter()
                .find(|s| s.invoke == name)
                .map(|s| s.scope.clone())
        };
        assert_eq!(scope_of("/handoff").as_deref(), Some("core"));
        assert_eq!(scope_of("/personal:adr").as_deref(), Some("personal"));
        assert_eq!(
            scope_of("/indigo:capture").as_deref(),
            Some("company:indigo")
        );
        assert_eq!(
            scope_of("/ridge:upsell-report").as_deref(),
            Some("company:ridge")
        );
        // `vercel` is not a manifest company → package, not company.
        assert_eq!(scope_of("/vercel:deploy").as_deref(), Some("package"));
    }

    #[test]
    fn skill_with_missing_frontmatter_fields_still_lists() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), None);
        let bare = catalog
            .skills
            .iter()
            .find(|s| s.invoke == "/bare-skill")
            .expect("bare skill present");
        assert_eq!(bare.name, "bare-skill"); // falls back to the directory name
        assert_eq!(bare.description, "");
        assert!(bare.tags.is_empty());
        assert_eq!(bare.scope, "core");
    }

    #[test]
    fn conflict_scaffold_and_skill_less_directories_are_skipped() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), None);
        assert!(catalog
            .skills
            .iter()
            .all(|s| !s.invoke.contains(".conflict-")));
        assert!(catalog.skills.iter().all(|s| s.invoke != "/_shared"));
        assert!(catalog.skills.iter().all(|s| s.invoke != "/not-a-skill"));
    }

    #[test]
    fn company_scope_filters_other_tenants_but_keeps_core_personal_package() {
        let tmp = fixture();
        let catalog = build_skill_catalog(tmp.path(), Some("indigo"));

        let worker_ids: Vec<_> = catalog.workers.iter().map(|w| w.id.as_str()).collect();
        assert!(worker_ids.contains(&"architect"), "shared worker kept");
        assert!(worker_ids.contains(&"amelia"), "own-company worker kept");
        assert!(
            !worker_ids.contains(&"ridge-analyst"),
            "other tenant dropped"
        );

        let invokes: Vec<_> = catalog.skills.iter().map(|s| s.invoke.as_str()).collect();
        assert!(invokes.contains(&"/handoff"));
        assert!(invokes.contains(&"/personal:adr"));
        assert!(invokes.contains(&"/vercel:deploy"));
        assert!(invokes.contains(&"/indigo:capture"));
        assert!(!invokes.contains(&"/ridge:upsell-report"));
    }

    #[test]
    fn descriptions_are_clamped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            &root.join("core/workers/registry.yaml"),
            &format!(
                "workers:\n  - id: \"verbose\"\n    path: \"core/workers/public/verbose/\"\n    description: \"{}\"\n",
                "x".repeat(900)
            ),
        );
        let catalog = build_skill_catalog(root, None);
        assert_eq!(catalog.workers[0].description.chars().count(), 200);
    }

    #[test]
    fn missing_hq_root_yields_an_empty_catalog_rather_than_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let catalog = build_skill_catalog(&tmp.path().join("nope"), None);
        assert!(catalog.workers.is_empty());
        assert!(catalog.skills.is_empty());
    }

    #[test]
    fn cached_catalog_matches_the_uncached_one() {
        let tmp = fixture();
        let direct = build_skill_catalog(tmp.path(), Some("indigo"));
        let cached = build_skill_catalog_cached(tmp.path(), Some("indigo"));
        assert_eq!(direct, cached);
        // Second call comes off the cache and must be identical.
        assert_eq!(
            cached,
            build_skill_catalog_cached(tmp.path(), Some("indigo"))
        );
    }
}
