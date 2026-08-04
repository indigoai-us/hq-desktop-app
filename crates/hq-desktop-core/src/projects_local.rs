//! Local-PRD reader commands for the Projects surface (US-003).
//!
//! The Projects surface needs to list projects + read stories straight from the
//! local HQ tree — fast, offline, and cross-company — instead of round-tripping
//! to the vault for every render. These two commands scan the resolved HQ folder
//! and parse the on-disk `board.json` + `prd.json` files directly.
//!
//! Data shapes (modeled from real files):
//!   * `companies/<slug>/board.json` — `{ company, objectives[], initiatives[],
//!     projects[] }`. Each project: `id, title, description, status, scope, app,
//!     initiative_id, objective_id, prd_path, created_at, updated_at`.
//!   * `companies/<slug>/projects/<name>/prd.json` — `{ name, description,
//!     branchName, userStories[], metadata{} }`. Each story: `id, title,
//!     description, acceptanceCriteria[], passes, priority, labels[], dependsOn[],
//!     notes`.
//!
//! Both commands are gated by `feature_gate::desktop_features_enabled()`
//! (GA — any signed-in user) like the other desktop-alt commands, and both
//! must be allow-listed in
//! `capabilities/desktop-alt.json` + registered in `main.rs`.
//!
//! ## Empty local state
//!
//! These commands are the *local* fast path. When the HQ folder cannot be
//! resolved to a real directory on disk, or no `companies/*/projects/*/prd.json`
//! exist, `get_local_projects` returns an **empty list** rather than erroring.
//! This module deliberately has no vault/network fallback: keeping the local
//! reader pure (filesystem only, no network, no auth) makes it testable and
//! leaves any alternate data source to the caller. A malformed unlinked
//! `prd.json` or `board.json` is skipped (logged), never panicked on — one bad
//! file must not blank the whole list.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::config::{read_hq_config_lenient, MenubarPrefs};
use crate::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, open_hq_regular_file_no_follow,
    validate_hq_relative_path,
};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use crate::desktop_alt::{open_hq_scoped_directory, HqScopedDirectory};
use crate::paths;

/// Explicit attribution for a project or story. All fields remain optional so
/// older board/prd files deserialize unchanged and the UI can render honest
/// Unassigned / Unknown source fallbacks.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkProvenance {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
}

/// One project row for the Projects list. Merges `board.json` project metadata
/// with `prd.json` story counts where a `prd_path` links them. Projects that
/// exist only as a `prd.json` (not referenced by any board) are still included.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    /// Board project id (e.g. `in-proj-001`) when known, otherwise the prd
    /// directory name — always non-empty so the UI has a stable key.
    pub id: String,
    /// Display title — board `title`, falling back to prd `name`, then the id.
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Company slug the project belongs to (the `companies/<slug>/` dir).
    pub company: String,
    #[serde(default)]
    pub status: String,
    /// HQ-folder-relative path to the linked `prd.json`, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prd_path: Option<String>,
    /// Project creation timestamp from board.json or prd metadata, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Latest project update timestamp from board.json or prd metadata, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Total user stories in the linked PRD (0 if the existing PRD is unparseable).
    pub story_count: u32,
    /// Stories whose `passes == true`.
    pub stories_complete: u32,
    /// Explicit owner/creator/source metadata, when declared.
    #[serde(default)]
    pub provenance: WorkProvenance,
    /// Best-effort first-add author from the local HQ Git history. This is
    /// creator evidence, never ownership, and only participates after explicit
    /// local/cloud attribution has had a chance to win.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator_fallback: Option<String>,
}

/// A single user story, mirroring the prd.json story shape the Kanban + detail
/// views render.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStory {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub passes: bool,
    // `priority` is a passthrough JSON value: real prds write it as a NUMBER
    // (e.g. `1`), older ones as a STRING (e.g. `"P0"`). Deserializing into
    // `Option<String>` made serde reject the whole story (and therefore the
    // whole prd) the moment it hit a numeric priority — which is why every
    // numeric-priority project's board showed 0 stories. The frontend already
    // coerces `string | number | null` (see lib/local-projects.ts), so we pass
    // the raw value straight through.
    #[serde(default)]
    pub priority: Option<serde_json::Value>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Explicit owner/assignee/creator/source metadata, when declared.
    #[serde(default)]
    pub provenance: WorkProvenance,
}

/// A parsed prd.json returned by `get_local_project_prd`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectPrd {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub user_stories: Vec<LocalStory>,
    /// Pass-through metadata object (company, goal, createdAt, …).
    #[serde(default)]
    pub metadata: serde_json::Value,
    /// Project-level attribution normalized from top-level + metadata fields.
    #[serde(default)]
    pub provenance: WorkProvenance,
}

// ---- company goals (objectives + initiatives) ------------------------------

/// A single key result under an objective. The current board.json data carries
/// `key_results: []`, so every field is permissive (Option / serde default) —
/// this models whatever a populated KR might contain without erroring on the
/// empty case.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// One objective from a company `board.json` `objectives[]` entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Objective {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub timeframe: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub key_results: Vec<KeyResult>,
    #[serde(default)]
    pub initiative_ids: Vec<String>,
    /// The Linear initiative this objective links to, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linear_initiative_id: Option<String>,
}

/// One initiative from a company `board.json` `initiatives[]` entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Initiative {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: String,
}

/// A company's GOALS surface: the objectives + initiatives from its
/// `board.json`. Returned by `get_local_company_goals`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyGoals {
    pub objectives: Vec<Objective>,
    pub initiatives: Vec<Initiative>,
}

// ---- on-disk parse models (snake_case, matching the real JSON) -------------

/// `board.json` — only the fields we consume.
#[derive(Debug, Deserialize, Default)]
pub struct BoardFile {
    #[serde(default)]
    projects: Vec<BoardProject>,
}

/// `board.json` goals view — only the `objectives` + `initiatives` arrays. The
/// `Objective`/`Initiative` return structs are themselves `Deserialize` with
/// `#[serde(rename_all = "camelCase")]`; the on-disk JSON is snake_case, so we
/// parse via dedicated snake_case raw models below and convert.
#[derive(Debug, Deserialize, Default)]
pub struct BoardGoalsFile {
    #[serde(default)]
    objectives: Vec<RawObjective>,
    #[serde(default)]
    initiatives: Vec<RawInitiative>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawObjective {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    timeframe: String,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    key_results: Vec<RawKeyResult>,
    #[serde(default)]
    initiative_ids: Vec<String>,
    #[serde(default)]
    linear_initiative_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawKeyResult {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    metric: Option<String>,
    #[serde(default)]
    target: Option<serde_json::Value>,
    #[serde(default)]
    current: Option<serde_json::Value>,
    #[serde(default)]
    unit: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawInitiative {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    status: String,
}

impl From<RawKeyResult> for KeyResult {
    fn from(k: RawKeyResult) -> Self {
        KeyResult {
            id: k.id,
            title: k.title,
            metric: k.metric,
            target: k.target,
            current: k.current,
            unit: k.unit,
            status: k.status,
        }
    }
}

impl From<RawObjective> for Objective {
    fn from(o: RawObjective) -> Self {
        Objective {
            id: o.id,
            title: o.title,
            description: o.description,
            status: o.status,
            timeframe: o.timeframe,
            owner: o.owner,
            key_results: o.key_results.into_iter().map(KeyResult::from).collect(),
            initiative_ids: o.initiative_ids,
            linear_initiative_id: o.linear_initiative_id,
        }
    }
}

impl From<RawInitiative> for Initiative {
    fn from(i: RawInitiative) -> Self {
        Initiative {
            id: i.id,
            title: i.title,
            description: i.description,
            status: i.status,
        }
    }
}

impl From<BoardGoalsFile> for CompanyGoals {
    fn from(b: BoardGoalsFile) -> Self {
        CompanyGoals {
            objectives: b.objectives.into_iter().map(Objective::from).collect(),
            initiatives: b.initiatives.into_iter().map(Initiative::from).collect(),
        }
    }
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct BoardProject {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    prd_path: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default, flatten)]
    attribution: RawAttribution,
    #[serde(default)]
    provenance: RawAttribution,
}

/// `prd.json` — the raw on-disk shape. Stories use camelCase keys, so this
/// model renames into snake_case Rust fields.
#[derive(Debug, Deserialize, Default)]
pub struct PrdFile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, rename = "branchName")]
    branch_name: Option<String>,
    #[serde(default, rename = "userStories")]
    user_stories: Vec<PrdStory>,
    #[serde(default)]
    metadata: serde_json::Value,
    #[serde(default, flatten)]
    attribution: RawAttribution,
    #[serde(default)]
    provenance: RawAttribution,
}

#[derive(Debug, Deserialize, Default)]
pub struct PrdStory {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(
        default,
        rename = "acceptanceCriteria",
        deserialize_with = "deserialize_acceptance_criteria"
    )]
    acceptance_criteria: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_passes")]
    passes: bool,
    // Accept number OR string priority (see LocalStory::priority) — a numeric
    // priority must not fail the whole prd parse.
    #[serde(default)]
    priority: Option<serde_json::Value>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default, rename = "dependsOn")]
    depends_on: Vec<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    metadata: serde_json::Value,
    #[serde(default, flatten)]
    attribution: RawAttribution,
    #[serde(default)]
    provenance: RawAttribution,
}

fn acceptance_criterion(value: serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::String(value) => Ok(value),
        serde_json::Value::Object(object) => object
            .get("criterion")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                "acceptance criterion object must contain a string criterion".to_string()
            }),
        _ => Err("acceptance criterion must be a string or criterion object".to_string()),
    }
}

fn deserialize_acceptance_criteria<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(acceptance_criterion)
            .collect::<Result<Vec<_>, _>>()
            .map_err(serde::de::Error::custom),
        serde_json::Value::Null => Ok(Vec::new()),
        _ => Err(serde::de::Error::custom(
            "acceptanceCriteria must be an array",
        )),
    }
}

fn deserialize_passes<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let passes = match value {
        serde_json::Value::Bool(value) => value,
        serde_json::Value::Null => false,
        serde_json::Value::String(value) if value.eq_ignore_ascii_case("skipped") => false,
        _ => {
            return Err(serde::de::Error::custom(
                "passes must be a boolean, null, or \"skipped\"",
            ));
        }
    };
    Ok(passes)
}

/// Permissive input shape for current and legacy provenance aliases. Values are
/// kept as JSON so both strings and small person/source objects are accepted.
#[derive(Debug, Deserialize, Default, Clone)]
pub struct RawAttribution {
    #[serde(default, alias = "ownerName", alias = "owner_name")]
    owner: Option<serde_json::Value>,
    #[serde(
        default,
        alias = "assigneeName",
        alias = "assignee_name",
        alias = "assignedTo",
        alias = "assigned_to"
    )]
    assignee: Option<serde_json::Value>,
    #[serde(
        default,
        alias = "creatorName",
        alias = "creator_name",
        alias = "createdByName",
        alias = "created_by_name",
        alias = "createdBy",
        alias = "created_by"
    )]
    creator: Option<serde_json::Value>,
    #[serde(default, alias = "source", alias = "sourceName", alias = "source_name")]
    origin: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawProvenanceCarrier {
    #[serde(default, flatten)]
    attribution: RawAttribution,
    #[serde(default)]
    provenance: RawAttribution,
}

fn clean_label(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    let object = value.as_object()?;
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn person_label(value: &Option<serde_json::Value>) -> Option<String> {
    value.as_ref().and_then(|value| {
        clean_label(
            value,
            &[
                "displayName",
                "display_name",
                "name",
                "email",
                "handle",
                "label",
            ],
        )
    })
}

fn origin_label(value: &Option<serde_json::Value>) -> Option<String> {
    value
        .as_ref()
        .and_then(|value| clean_label(value, &["label", "name", "type", "provider", "source"]))
}

fn metadata_provenance(metadata: &serde_json::Value) -> RawProvenanceCarrier {
    serde_json::from_value(metadata.clone()).unwrap_or_default()
}

/// Normalize multiple sources ordered most → least authoritative. Canonical
/// nested `provenance` wins over legacy direct fields within each source, while
/// missing fields fall through independently.
fn normalize_work_provenance(sources: &[(&RawAttribution, &RawAttribution)]) -> WorkProvenance {
    let first_person =
        |field: fn(&RawAttribution) -> &Option<serde_json::Value>| -> Option<String> {
            sources.iter().find_map(|(direct, nested)| {
                person_label(field(nested)).or_else(|| person_label(field(direct)))
            })
        };
    let origin = sources.iter().find_map(|(direct, nested)| {
        origin_label(&nested.origin).or_else(|| origin_label(&direct.origin))
    });
    WorkProvenance {
        owner: first_person(|value| &value.owner),
        assignee: first_person(|value| &value.assignee),
        creator: first_person(|value| &value.creator),
        origin,
    }
}

fn merge_work_provenance(primary: WorkProvenance, fallback: WorkProvenance) -> WorkProvenance {
    WorkProvenance {
        owner: primary.owner.or(fallback.owner),
        assignee: primary.assignee.or(fallback.assignee),
        creator: primary.creator.or(fallback.creator),
        origin: primary.origin.or(fallback.origin),
    }
}

/// Attach the real HQ-relative file that defines the work when no declared
/// source/origin exists. This intentionally fills only `origin`: a file path is
/// useful provenance, but it is not evidence of an owner or creator.
fn with_origin_fallback(mut provenance: WorkProvenance, source_path: &str) -> WorkProvenance {
    if provenance.origin.is_none() {
        let source_path = normalize_rel(source_path.trim());
        if !source_path.is_empty() {
            provenance.origin = Some(source_path);
        }
    }
    provenance
}

fn prd_provenance(prd: &PrdFile) -> WorkProvenance {
    let metadata = metadata_provenance(&prd.metadata);
    normalize_work_provenance(&[
        (&prd.attribution, &prd.provenance),
        (&metadata.attribution, &metadata.provenance),
    ])
}

impl From<PrdStory> for LocalStory {
    fn from(s: PrdStory) -> Self {
        let metadata = metadata_provenance(&s.metadata);
        let provenance = normalize_work_provenance(&[
            (&s.attribution, &s.provenance),
            (&metadata.attribution, &metadata.provenance),
        ]);
        LocalStory {
            id: s.id,
            title: s.title,
            description: s.description,
            acceptance_criteria: s.acceptance_criteria,
            passes: s.passes,
            priority: s.priority,
            labels: s.labels,
            depends_on: s.depends_on,
            notes: s.notes,
            provenance,
        }
    }
}

impl From<PrdFile> for LocalProjectPrd {
    fn from(p: PrdFile) -> Self {
        let provenance = prd_provenance(&p);
        LocalProjectPrd {
            name: p.name,
            description: p.description,
            branch_name: p.branch_name,
            user_stories: p.user_stories.into_iter().map(LocalStory::from).collect(),
            metadata: p.metadata,
            provenance,
        }
    }
}

fn local_project_prd_with_source(prd: PrdFile, source_path: &str) -> LocalProjectPrd {
    let mut local = LocalProjectPrd::from(prd);
    local.provenance = with_origin_fallback(local.provenance, source_path);
    for story in &mut local.user_stories {
        story.provenance = with_origin_fallback(std::mem::take(&mut story.provenance), source_path);
    }
    local
}

/// `(total, complete)` story counts for a parsed prd.
pub fn story_counts(prd: &PrdFile) -> (u32, u32) {
    let total = u32::try_from(prd.user_stories.len()).unwrap_or(u32::MAX);
    let complete =
        u32::try_from(prd.user_stories.iter().filter(|s| s.passes).count()).unwrap_or(u32::MAX);
    (total, complete)
}

pub fn metadata_timestamp(metadata: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        metadata
            .get(*key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

pub fn prd_created_at(prd: &PrdFile) -> Option<String> {
    metadata_timestamp(&prd.metadata, &["createdAt", "created_at"])
}

pub fn prd_updated_at(prd: &PrdFile) -> Option<String> {
    metadata_timestamp(&prd.metadata, &["updatedAt", "updated_at"])
}

/// Resolve the user's HQ folder using the standard 4-tier resolver, the same
/// way every other CLI-spawning command in this app does (mirrors
/// `commands/packages.rs::resolve_hq_folder`).
pub fn resolve_hq_folder() -> PathBuf {
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let config = read_hq_config_lenient().ok().flatten();
    paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    )
}

/// Canonical, HQ-contained project file resolved from an HQ-relative path.
///
/// The lexical and canonical company identities must match. This prevents a
/// path under `companies/alpha` from resolving through a symlink into
/// `companies/beta` (or out of HQ entirely) while preserving legitimate
/// personal/root project files whose scope is not company-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProjectPath {
    pub hq_root: PathBuf,
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub company_slug: Option<String>,
}

fn matching_project_company_scope(
    lexical_path: &str,
    canonical_path: &str,
) -> Result<Option<String>, String> {
    let lexical_company = company_slug_for_hq_path(lexical_path)?;
    let canonical_company = company_slug_for_hq_path(canonical_path)?;
    let company_root_mismatch = (lexical_path == "companies" || canonical_path == "companies")
        && lexical_path != canonical_path;
    if company_root_mismatch || lexical_company != canonical_company {
        return Err("project path resolves across HQ company boundaries".to_string());
    }
    Ok(lexical_company)
}

/// Resolve an existing project file through symlinks while enforcing its
/// required filename and canonical company scope.
pub fn resolve_project_path(
    hq_root: &Path,
    rel_path: &str,
    expected_filename: &str,
) -> Result<ResolvedProjectPath, String> {
    let normalized = validate_hq_relative_path(rel_path, false)?;
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(expected_filename)
    {
        return Err(format!(
            "project path must point at a {expected_filename} file"
        ));
    }

    let canonical = canonical_hq_relative_path(hq_root, &normalized, false)?;
    if Path::new(&canonical)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(expected_filename)
    {
        return Err(format!(
            "project path resolves to a non-{expected_filename} file"
        ));
    }
    let company_slug = matching_project_company_scope(&normalized, &canonical)?;
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let absolute_path = canonical_root.join(&canonical);
    if !absolute_path.is_file() {
        return Err(format!("project file not found: {rel_path:?}"));
    }
    Ok(ResolvedProjectPath {
        hq_root: canonical_root,
        absolute_path,
        relative_path: canonical,
        company_slug,
    })
}

fn read_project_target_bytes(target: &ResolvedProjectPath) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let mut file = open_hq_regular_file_no_follow(&target.hq_root, &target.relative_path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("could not read project target: {error}"))?;
    Ok(bytes)
}

fn read_project_target_json<T: serde::de::DeserializeOwned>(
    target: &ResolvedProjectPath,
) -> Option<T> {
    read_project_target_bytes(target)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn reject_project_write_symlinks(hq_root: &Path, rel_path: &str) -> Result<(), String> {
    let normalized = validate_hq_relative_path(rel_path, false)?;
    let mut current =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    for segment in normalized.split('/') {
        current.push(segment);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|e| format!("could not inspect project write target {rel_path:?}: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "project write target must not contain symlinks: {rel_path:?}"
            ));
        }
    }
    Ok(())
}

/// Resolve a write target and refuse every symlink component. Reads may follow
/// same-company aliases after canonical authorization; writes deliberately do
/// not, because an atomic rename through an aliased parent can mutate a target
/// outside the caller's intended path.
pub fn resolve_project_write_path(
    hq_root: &Path,
    rel_path: &str,
    expected_filename: &str,
) -> Result<ResolvedProjectPath, String> {
    reject_project_write_symlinks(hq_root, rel_path)?;
    resolve_project_path(hq_root, rel_path, expected_filename)
}

fn require_same_project_write_target(
    hq_root: &Path,
    original: &ResolvedProjectPath,
    expected_filename: &str,
) -> Result<(), String> {
    let current = resolve_project_write_path(hq_root, &original.relative_path, expected_filename)?;
    if current != *original {
        return Err("project write target changed during authorization".to_string());
    }
    Ok(())
}

struct ProjectWriteAnchor {
    hq_root: PathBuf,
    parent_rel: String,
    target_path: PathBuf,
    target_name: std::ffi::OsString,
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    directory: HqScopedDirectory,
}

impl ProjectWriteAnchor {
    fn open(target: &ResolvedProjectPath) -> Result<Self, String> {
        let relative = Path::new(&target.relative_path);
        let target_name = relative
            .file_name()
            .ok_or_else(|| "project write target has no file name".to_string())?
            .to_os_string();

        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        let directory = {
            let parent = relative.parent().unwrap_or_else(|| Path::new(""));
            let parent_rel_for_open = parent
                .to_str()
                .ok_or_else(|| "project write parent is not valid UTF-8".to_string())?;
            let directory = open_hq_scoped_directory(&target.hq_root, parent_rel_for_open)?;
            // Open the terminal through the retained directory descriptor now,
            // before any mutation is prepared, so a non-file target fails closed.
            let _ = directory.open_regular_file(&target_name)?;
            directory
        };

        let parent_rel = {
            let parent = relative.parent().unwrap_or_else(|| Path::new(""));
            parent
                .to_str()
                .ok_or_else(|| "project write parent is not valid UTF-8".to_string())?
                .to_string()
        };

        Ok(Self {
            hq_root: target.hq_root.clone(),
            parent_rel,
            target_path: target.absolute_path.clone(),
            target_name,
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            directory,
        })
    }

    fn read_bytes(&self) -> Result<Vec<u8>, String> {
        use std::io::Read;

        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        let mut file = self.directory.open_regular_file(&self.target_name)?;
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let mut file = std::fs::File::open(&self.target_path)
            .map_err(|error| format!("could not open project write target: {error}"))?;

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("could not read project write target: {error}"))?;
        Ok(bytes)
    }
}

const GIT_AUTHOR_RECORD: char = '\u{001e}';
const GIT_AUTHOR_FIELD: char = '\u{001f}';
const CREATOR_HISTORY_CACHE_LIMIT: usize = 8;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CreatorHistoryCacheKey {
    hq_root: PathBuf,
    head: String,
    scopes: Vec<String>,
}

static CREATOR_HISTORY_CACHE: OnceLock<
    Mutex<HashMap<CreatorHistoryCacheKey, HashMap<String, String>>>,
> = OnceLock::new();

fn project_needs_creator_fallback(project: &LocalProject) -> bool {
    project.provenance.owner.is_none()
        && project.provenance.assignee.is_none()
        && project.provenance.creator.is_none()
}

#[derive(Debug, Default, PartialEq)]
struct GitCreatorHistory {
    creators: HashMap<String, String>,
    /// Commits where exact-only detection reported at least one added and one
    /// deleted PRD. These are the only commits that can contain a modified
    /// rename, so a targeted heuristic pass can stay fast on large HQ repos.
    possible_modified_rename_commits: Vec<String>,
}

#[derive(Debug, Default)]
struct GitCreatorCommit {
    hash: String,
    author: Option<String>,
    added_prd: bool,
    deleted_prd: bool,
}

fn finish_git_creator_commit(
    current: &mut GitCreatorCommit,
    possible_modified_rename_commits: &mut Vec<String>,
) {
    if current.added_prd && current.deleted_prd && !current.hash.is_empty() {
        possible_modified_rename_commits.push(current.hash.clone());
    }
    *current = GitCreatorCommit::default();
}

fn is_prd_path(path: &str) -> bool {
    path == "prd.json" || path.ends_with("/prd.json")
}

/// Parse the machine-delimited output of:
/// `git log --reverse --diff-filter=ADR
/// --format=%x1e%H%x1f%aN%x1f%aE --name-status`.
///
/// `--reverse` places the oldest add first. Exact renames carry that original
/// creator forward within the authorized history scopes instead of attributing
/// the move to the mover. `or_insert` preserves the first recorded author if a
/// path was later deleted and added again. A+D PRD commits are retained for the
/// narrowly targeted modified-rename fallback in `load_git_first_add_creators`.
fn parse_git_creator_history(output: &str) -> GitCreatorHistory {
    let mut creators = HashMap::new();
    let mut current = GitCreatorCommit::default();
    let mut possible_modified_rename_commits = Vec::new();
    for raw_line in output.lines() {
        let line = raw_line.trim_end_matches('\r');
        if let Some(header) = line.strip_prefix(GIT_AUTHOR_RECORD) {
            finish_git_creator_commit(&mut current, &mut possible_modified_rename_commits);
            let mut fields = header.splitn(3, GIT_AUTHOR_FIELD);
            current.hash = fields.next().unwrap_or_default().trim().to_string();
            let name = fields.next().unwrap_or_default().trim();
            let email = fields.next().unwrap_or_default().trim();
            current.author = if name.is_empty() {
                (!email.is_empty()).then(|| email.to_string())
            } else {
                Some(name.to_string())
            };
            continue;
        }
        let mut fields = line.split('\t');
        match (fields.next(), fields.next(), fields.next()) {
            (Some("A"), Some(path), None) => {
                let path = normalize_rel(path.trim());
                current.added_prd |= is_prd_path(&path);
                if let Some(author) = current.author.as_ref().filter(|_| !path.is_empty()) {
                    creators.entry(path).or_insert_with(|| author.clone());
                }
            }
            (Some("D"), Some(path), None) => {
                current.deleted_prd |= is_prd_path(&normalize_rel(path.trim()));
            }
            (Some(status), Some(previous), Some(next)) if status.starts_with('R') => {
                let previous = normalize_rel(previous.trim());
                let next = normalize_rel(next.trim());
                if let Some(original_author) = creators.get(&previous).cloned() {
                    creators.entry(next).or_insert(original_author);
                }
            }
            _ => {}
        }
    }
    finish_git_creator_commit(&mut current, &mut possible_modified_rename_commits);
    GitCreatorHistory {
        creators,
        possible_modified_rename_commits,
    }
}

#[cfg(test)]
fn parse_git_first_add_creators(output: &str) -> HashMap<String, String> {
    parse_git_creator_history(output).creators
}

fn apply_modified_rename_commit(
    hq_root: &Path,
    scopes: &[String],
    commit: &str,
    creators: &mut HashMap<String, String>,
) {
    if commit.is_empty() {
        return;
    }
    let mut command = paths::git_command();
    command
        .arg("-C")
        .arg(hq_root)
        .args([
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--find-renames=50%",
            "--diff-filter=R",
            "--name-status",
            commit,
            "--",
        ])
        .args(scopes);
    let Ok(output) = command.output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for raw_line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = raw_line.trim_end_matches('\r').split('\t');
        match (fields.next(), fields.next(), fields.next()) {
            (Some(status), Some(previous), Some(next)) if status.starts_with('R') => {
                let previous = normalize_rel(previous.trim());
                let next = normalize_rel(next.trim());
                if let Some(original_author) = creators.get(&previous).cloned() {
                    // The exact-only first pass sees a modified rename as D+A
                    // and initially attributes the new path to the mover. A
                    // verified heuristic rename must replace that provisional
                    // value with the original file creator.
                    creators.insert(next, original_author);
                }
            }
            _ => {}
        }
    }
}

fn project_history_scopes(paths: &[String]) -> Vec<String> {
    let mut scopes = paths
        .iter()
        .filter_map(|path| {
            let normalized = normalize_rel(path);
            let mut parts = normalized.split('/');
            match (parts.next(), parts.next(), parts.next()) {
                (Some("companies"), Some(company), Some("projects"))
                    if !company.is_empty() && company != "." && company != ".." =>
                {
                    Some(format!("companies/{company}/projects"))
                }
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

fn git_head(hq_root: &Path) -> Option<String> {
    let output = paths::git_command()
        .arg("-C")
        .arg(hq_root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!head.is_empty()).then_some(head)
}

fn load_git_first_add_creators(hq_root: &Path, scopes: &[String]) -> HashMap<String, String> {
    if scopes.is_empty() {
        return HashMap::new();
    }
    let mut command = paths::git_command();
    command
        .arg("-C")
        .arg(hq_root)
        .args([
            "log",
            "--find-renames=100%",
            "--reverse",
            "--diff-filter=ADR",
            "--format=%x1e%H%x1f%aN%x1f%aE",
            "--name-status",
            "--",
        ])
        .args(scopes);
    let Ok(output) = command.output() else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    let history = parse_git_creator_history(&String::from_utf8_lossy(&output.stdout));
    let mut creators = history.creators;
    for commit in history.possible_modified_rename_commits {
        apply_modified_rename_commit(hq_root, scopes, &commit, &mut creators);
    }
    creators
}

fn first_add_creators_for_paths(hq_root: &Path, paths: &[String]) -> HashMap<String, String> {
    let scopes = project_history_scopes(paths);
    let Some(head) = git_head(hq_root) else {
        return HashMap::new();
    };
    let key = CreatorHistoryCacheKey {
        hq_root: hq_root.to_path_buf(),
        head,
        scopes: scopes.clone(),
    };
    let cache = CREATOR_HISTORY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut entries) = cache.lock() {
        if let Some(creators) = entries.get(&key) {
            return creators.clone();
        }

        // Hold the short-lived lock through the load so simultaneous Overview,
        // Projects, and Goals requests become a single flight instead of
        // launching duplicate history walks.
        //
        // Hundreds of exact pathspecs make Git walk history once per PRD and
        // took ~9 seconds on a real HQ tree. One already-authorized company
        // projects scope plus exact-only rename detection measured ~0.7 seconds
        // for the full company tree; exact PRD matches are filtered by the
        // caller. Exact renames retain the original creator without Git's
        // expensive heuristic rename search.
        let creators = load_git_first_add_creators(hq_root, &scopes);
        if entries.len() >= CREATOR_HISTORY_CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(key, creators.clone());
        return creators;
    }

    // Poisoned cache state must never blank the projects surface.
    load_git_first_add_creators(hq_root, &scopes)
}

fn project_creator_fallback_path(project: &LocalProject) -> Option<String> {
    let path = normalize_rel(project.prd_path.as_deref()?);
    let path_company = company_slug_for_hq_path(&path).ok().flatten()?;
    if path_company != project.company {
        return None;
    }
    let project_prefix = format!("companies/{path_company}/projects/");
    (path.starts_with(&project_prefix) && path.ends_with("/prd.json")).then_some(path)
}

/// Keep a board-declared PRD identity only when it resolves to an existing file
/// inside that board's company. Existing paths are canonicalized so a
/// same-company spelling cannot hide a cross-company symlink.
fn validated_board_prd_path(hq_root: &Path, company: &str, raw_path: &str) -> Option<String> {
    let normalized = validate_hq_relative_path(raw_path, false).ok()?;
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some("prd.json")
    {
        return None;
    }
    if company_slug_for_hq_path(&normalized)
        .ok()
        .flatten()
        .as_deref()
        != Some(company)
    {
        return None;
    }
    let project_prefix = format!("companies/{company}/projects/");
    let project_relative = normalized.strip_prefix(&project_prefix)?;
    if project_relative == "prd.json" || !project_relative.ends_with("/prd.json") {
        return None;
    }

    let candidate = hq_root.join(&normalized);
    if !candidate.exists() {
        return None;
    }
    let target = resolve_project_path(hq_root, &normalized, "prd.json").ok()?;
    (target.company_slug.as_deref() == Some(company)).then_some(target.relative_path)
}

fn apply_creator_fallback_map(projects: &mut [LocalProject], creators: &HashMap<String, String>) {
    for project in projects {
        if !project_needs_creator_fallback(project) {
            continue;
        }
        let Some(path) = project_creator_fallback_path(project) else {
            continue;
        };
        project.creator_fallback = creators.get(&path).cloned();
    }
}

fn apply_git_creator_fallbacks(hq_root: &Path, projects: &mut [LocalProject]) {
    let mut paths = projects
        .iter()
        .filter(|project| project_needs_creator_fallback(project))
        .filter_map(project_creator_fallback_path)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();

    let creators = first_add_creators_for_paths(hq_root, &paths);
    apply_creator_fallback_map(projects, &creators);
}

/// List projects across every company by scanning the local HQ tree.
///
/// Reads `companies/<slug>/board.json` for project metadata and
/// `companies/<slug>/projects/<name>/prd.json` for story data, merging the two
/// where a board project's `prd_path` points at a real prd. Projects that exist
/// only as a `prd.json` (no board entry) are still listed.
///
/// Returns an **empty list** (not an error) when the HQ folder doesn't resolve
/// to a directory or has no companies. Individual malformed `board.json` files
/// and unlinked malformed `prd.json` files are skipped, never fatal. A board
/// row with an existing but malformed PRD remains visible with 0/0 counts so
/// diagnostics can still identify the damaged project file.
/// Pure, testable scanner — takes an explicit HQ root so tests can point it at a
/// fixture tree. Never panics: unreadable dirs/files are skipped.
pub fn scan_local_projects(hq_root: &Path) -> Vec<LocalProject> {
    scan_local_projects_scoped(hq_root, None)
}

/// Scan only the explicitly authorized canonical company slugs.
///
/// Filtering happens before board/PRD content is opened, so an unauthorized
/// local folder is never parsed and a symlinked company alias cannot borrow a
/// different tenant's canonical identity.
pub fn scan_local_projects_for_companies(
    hq_root: &Path,
    authorized_companies: &HashSet<String>,
) -> Vec<LocalProject> {
    scan_local_projects_scoped(hq_root, Some(authorized_companies))
}

fn scan_local_projects_scoped(
    hq_root: &Path,
    authorized_companies: Option<&HashSet<String>>,
) -> Vec<LocalProject> {
    let companies_dir = hq_root.join("companies");
    let entries = match std::fs::read_dir(&companies_dir) {
        Ok(e) => e,
        // No companies dir (HQ folder unresolved or empty) → empty local list.
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<LocalProject> = Vec::new();

    for entry in entries.flatten() {
        let company_path = entry.path();
        let slug = match company_path.file_name().and_then(|n| n.to_str()) {
            Some(s) if !s.starts_with('.') => s.to_string(),
            _ => continue,
        };
        if authorized_companies.is_some_and(|allowed| !allowed.contains(&slug)) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let company_rel = format!("companies/{slug}");
        if canonical_hq_relative_path(hq_root, &company_rel, false).as_deref()
            != Ok(company_rel.as_str())
        {
            continue;
        }

        // Track which prd.json paths a board already accounts for, so we can
        // append unlinked prds afterward without duplicating.
        let mut linked_prds: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. board.json projects (with prd-linked story counts where possible).
        let board_rel = format!("companies/{slug}/board.json");
        let board_source = format!("companies/{slug}/board.json");
        let board = resolve_project_path(hq_root, &board_rel, "board.json")
            .ok()
            .filter(|target| target.company_slug.as_deref() == Some(slug.as_str()))
            .and_then(|target| read_project_target_json::<BoardFile>(&target));
        if let Some(board) = board {
            for project in board.projects {
                let BoardProject {
                    id,
                    title,
                    description,
                    status,
                    prd_path,
                    created_at,
                    updated_at,
                    attribution,
                    provenance,
                } = project;
                let Some(prd_path) = prd_path
                    .as_deref()
                    .and_then(|rel| validated_board_prd_path(hq_root, &slug, rel))
                else {
                    continue;
                };
                let prd_details = resolve_project_path(hq_root, &prd_path, "prd.json")
                    .ok()
                    .filter(|target| target.company_slug.as_deref() == Some(slug.as_str()))
                    .and_then(|target| {
                        read_project_target_json::<PrdFile>(&target).map(|prd| {
                            let (story_count, stories_complete) = story_counts(&prd);
                            (
                                story_count,
                                stories_complete,
                                prd_created_at(&prd),
                                prd_updated_at(&prd),
                                prd_provenance(&prd),
                            )
                        })
                    });
                linked_prds.insert(prd_path.clone());
                let (story_count, stories_complete, prd_created, prd_updated, prd_provenance) =
                    prd_details.unwrap_or((0, 0, None, None, WorkProvenance::default()));
                let board_provenance = normalize_work_provenance(&[(&attribution, &provenance)]);
                let id = if id.trim().is_empty() {
                    title.clone()
                } else {
                    id
                };
                out.push(LocalProject {
                    id,
                    title: if title.trim().is_empty() {
                        prd_path.clone()
                    } else {
                        title
                    },
                    description,
                    company: slug.clone(),
                    status,
                    prd_path: Some(prd_path),
                    created_at: created_at.or(prd_created),
                    updated_at: updated_at.or(prd_updated),
                    story_count,
                    stories_complete,
                    provenance: with_origin_fallback(
                        merge_work_provenance(board_provenance, prd_provenance),
                        &board_source,
                    ),
                    creator_fallback: None,
                });
            }
        }

        // 2. prd.json files not referenced by the board — include them too so a
        //    freshly-created project shows up before the board is regenerated.
        let projects_dir = company_path.join("projects");
        for prd_path in find_prd_files(&projects_dir) {
            let rel = match prd_path.strip_prefix(hq_root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if linked_prds.contains(&normalize_rel(&rel)) {
                continue;
            }
            let Ok(target) = resolve_project_path(hq_root, &rel, "prd.json") else {
                continue;
            };
            if target.company_slug.as_deref() != Some(slug.as_str()) {
                continue;
            }
            let Some(prd) = read_project_target_json::<PrdFile>(&target) else {
                continue;
            };
            let (story_count, stories_complete) = story_counts(&prd);
            let created_at = prd_created_at(&prd);
            let updated_at = prd_updated_at(&prd);
            let provenance = with_origin_fallback(prd_provenance(&prd), &rel);
            // Project name from prd, falling back to the parent dir name.
            let dir_name = prd_path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("project")
                .to_string();
            let title = if prd.name.trim().is_empty() {
                dir_name.clone()
            } else {
                prd.name.clone()
            };
            out.push(LocalProject {
                id: dir_name,
                title,
                description: prd.description,
                company: slug.clone(),
                status: String::new(),
                prd_path: Some(rel),
                created_at,
                updated_at,
                story_count,
                stories_complete,
                provenance,
                creator_fallback: None,
            });
        }
    }

    apply_git_creator_fallbacks(hq_root, &mut out);
    out
}

#[cfg(test)]
thread_local! {
    static PROJECT_READ_BEFORE_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn set_project_read_before_open_hook(hook: impl FnOnce() + 'static) {
    PROJECT_READ_BEFORE_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_project_read_before_open_hook() {
    PROJECT_READ_BEFORE_OPEN_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_project_read_before_open_hook() {}

/// Read + parse a single project's prd.json by HQ-folder-relative path.
///
/// Validates that the resolved path stays inside the HQ folder (no `..`
/// traversal, no absolute escape) before reading — AC #2.
/// Pure body for `get_local_project_prd` — takes an explicit HQ root so it's
/// unit-testable and the traversal guard is verifiable.
pub fn read_project_prd(hq_root: &Path, prd_path: &str) -> Result<LocalProjectPrd, String> {
    let normalized = validate_hq_relative_path(prd_path, false)?;
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some("prd.json")
    {
        return Err("prd_path must point at a prd.json file".to_string());
    }
    if !hq_root.join(&normalized).exists() {
        return Err(format!("could not read or parse prd.json at {prd_path:?}"));
    }
    let target = resolve_project_path(hq_root, prd_path, "prd.json")?;
    run_project_read_before_open_hook();
    let prd = read_project_target_json::<PrdFile>(&target)
        .ok_or_else(|| format!("could not read or parse prd.json at {prd_path:?}"))?;
    Ok(local_project_prd_with_source(prd, &target.relative_path))
}

/// Read a project's sibling `README.md` by the project's HQ-folder-relative
/// `prd.json` path (US-009).
///
/// The README is expected to live alongside the prd (`<dir>/README.md`). We take
/// the *prd* path rather than a free-form file path so the same path-traversal
/// guard as `get_local_project_prd` applies and the frontend never has to
/// construct a README path itself. Returns `Ok(None)` when no README exists (a
/// project without one is normal, not an error); `Err` only on a path-escape or
/// an unreadable-but-present file.
/// Pure body for `get_local_project_readme` — explicit HQ root for testing.
///
/// Derives the project directory from the prd path (its parent), then reads
/// `<dir>/README.md`. Reuses the same lexical `is_within` guard so a malicious
/// `prd_path` can't escape the HQ folder.
pub fn read_project_readme(hq_root: &Path, prd_path: &str) -> Result<Option<String>, String> {
    let prd_target = resolve_project_path(hq_root, prd_path, "prd.json")?;
    let Some(dir) = Path::new(&prd_target.relative_path).parent() else {
        return Ok(None);
    };
    let readme_rel = dir.join("README.md").to_string_lossy().replace('\\', "/");
    let candidate = hq_root.join(&readme_rel);
    if !candidate.exists() {
        return Ok(None);
    }
    let readme_target = resolve_project_path(hq_root, &readme_rel, "README.md")?;
    if readme_target.company_slug != prd_target.company_slug {
        return Err("README path resolves across HQ company boundaries".to_string());
    }
    let bytes = read_project_target_bytes(&readme_target)
        .map_err(|e| format!("could not read README.md: {e}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| format!("could not read README.md: {e}"))
}

/// Read a company's GOALS (objectives + initiatives) from its `board.json`
/// under the resolved HQ folder.
///
/// Powers a per-company board UI that renders OKRs. Reads
/// `companies/<company_slug>/board.json` and returns only its `objectives[]` +
/// `initiatives[]` (the projects live behind `get_local_projects`). Indigo-gated
/// like the other local readers.
///
/// A missing or unparseable `board.json` yields an **empty** `CompanyGoals`
/// rather than an error — a company without a board simply has no goals yet, and
/// the caller can fall back to the vault. The only hard errors are a
/// `company_slug` that escapes the HQ folder (path-traversal guard) or the gate
/// rejecting a signed-out caller.
/// Pure body for `get_local_company_goals` — takes an explicit HQ root so it's
/// unit-testable and the traversal guard is verifiable.
///
/// Validates the slug stays inside `companies/` under the HQ folder (no `..`
/// traversal, no nested path, no absolute escape), then leniently parses the
/// company's `board.json`. Missing/garbage board → empty `CompanyGoals`.
pub fn read_company_goals(hq_root: &Path, company_slug: &str) -> Result<CompanyGoals, String> {
    let slug = company_slug.trim();
    if slug.is_empty() {
        return Err("company_slug is required".to_string());
    }
    // A slug is a single directory name — reject anything with separators or
    // traversal components before it ever touches the filesystem.
    if slug.contains('/') || slug.contains('\\') || slug == "." || slug == ".." {
        return Err(format!("invalid company_slug: {company_slug:?}"));
    }
    let board_rel = format!("companies/{slug}/board.json");
    let board_path = hq_root.join(&board_rel);
    if !board_path.exists() {
        return Ok(CompanyGoals::default());
    }
    let target = resolve_project_path(hq_root, &board_rel, "board.json")?;
    if target.company_slug.as_deref() != Some(slug) {
        return Err("goals path resolves across HQ company boundaries".to_string());
    }
    // Missing/unparseable board.json → empty goals (not an error).
    Ok(read_project_target_json::<BoardGoalsFile>(&target)
        .map(CompanyGoals::from)
        .unwrap_or_default())
}

// ---- CRM projection (hq-native-crm US-010) ---------------------------------

/// Read a company's CRM projection (`crm-projection.json`) from the resolved HQ
/// folder — the LOCAL-FIRST leg of the Accounts surface, read EXACTLY the way
/// `get_local_company_goals` reads `board.json`.
///
/// The projection is produced server-side by hq-pro (US-009) and synced down to
/// the company vault like `board.json`; this command reads the on-disk copy. It
/// returns the raw JSON value pass-through (the projection shape is owned by the
/// producer and normalized in the frontend `account-view-model.ts`), so a schema
/// addition never needs a Rust change.
///
/// A missing / unsynced / unparseable projection resolves to JSON `null` rather
/// than an error: the frontend treats `null` as "no local projection — fall
/// back to the vault API" (the same local-first → vault-API fallback the board
/// surface uses). The only hard errors are a `company_slug` that escapes the HQ
/// folder (path-traversal guard) or the gate rejecting a signed-out caller.
/// Pure body for `get_company_crm_projection` — explicit HQ root for testing.
///
/// Validates the slug stays inside `companies/` under the HQ folder (no `..`
/// traversal, no nested path, no absolute escape), then leniently reads the
/// company's `crm-projection.json`. Missing/garbage projection → JSON `null`
/// (the "fall back to the vault" signal), never an error.
pub fn read_crm_projection(
    hq_root: &Path,
    company_slug: &str,
) -> Result<serde_json::Value, String> {
    let slug = company_slug.trim();
    if slug.is_empty() {
        return Err("company_slug is required".to_string());
    }
    // A slug is a single directory name — reject separators / traversal before
    // it ever touches the filesystem.
    if slug.contains('/') || slug.contains('\\') || slug == "." || slug == ".." {
        return Err(format!("invalid company_slug: {company_slug:?}"));
    }
    let projection_rel = format!("companies/{slug}/crm-projection.json");
    let projection_path = hq_root.join(&projection_rel);
    if !projection_path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let target = resolve_project_path(hq_root, &projection_rel, "crm-projection.json")?;
    if target.company_slug.as_deref() != Some(slug) {
        return Err("CRM path resolves across HQ company boundaries".to_string());
    }
    // Missing/unparseable crm-projection.json → JSON null (fall back to vault).
    Ok(read_project_target_json::<serde_json::Value>(&target).unwrap_or(serde_json::Value::Null))
}

// ---- writes (US-010) -------------------------------------------------------

#[cfg(test)]
thread_local! {
    static PROJECT_WRITE_START_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static PROJECT_WRITE_BEFORE_COMMIT_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static PROJECT_WRITE_AT_EXCHANGE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn set_project_write_start_hook(hook: impl FnOnce() + 'static) {
    PROJECT_WRITE_START_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_project_write_start_hook() {
    PROJECT_WRITE_START_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_project_write_start_hook() {}

#[cfg(test)]
fn set_project_write_before_commit_hook(hook: impl FnOnce() + 'static) {
    PROJECT_WRITE_BEFORE_COMMIT_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_project_write_before_commit_hook() {
    PROJECT_WRITE_BEFORE_COMMIT_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_project_write_before_commit_hook() {}

#[cfg(test)]
fn set_project_write_at_exchange_hook(hook: impl FnOnce() + 'static) {
    PROJECT_WRITE_AT_EXCHANGE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_project_write_at_exchange_hook() {
    PROJECT_WRITE_AT_EXCHANGE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_project_write_at_exchange_hook() {}

const PROJECT_WRITE_LOCK_DIR: &str = ".hq-desktop-locks";
const PROJECT_WRITE_LOCK_FILE: &str = "project-json-writes.lock";

struct ProjectWriteLock(std::fs::File);

impl Drop for ProjectWriteLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn ensure_project_lock_directory(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("could not create {label}: {error}")),
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label} must be a real directory"));
    }
    Ok(())
}

/// Acquire a stable, root-wide lock for project JSON mutations.
///
/// The lock lives in local `workspace/` state rather than beside a synced
/// board/PRD. It must be a separate, stable inode: locking the target file
/// itself would stop coordinating as soon as the atomic rename replaces that
/// inode.
fn acquire_project_write_lock(hq_root: &Path) -> Result<ProjectWriteLock, String> {
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let workspace = canonical_root.join("workspace");
    ensure_project_lock_directory(&workspace, "HQ workspace lock directory")?;

    let lock_dir = workspace.join(PROJECT_WRITE_LOCK_DIR);
    ensure_project_lock_directory(&lock_dir, "project write lock directory")?;

    let canonical_lock_dir = std::fs::canonicalize(&lock_dir)
        .map_err(|e| format!("could not resolve project write lock directory: {e}"))?;
    if !canonical_lock_dir.starts_with(&canonical_root) {
        return Err("project write lock directory escaped the HQ folder".to_string());
    }

    let lock_path = canonical_lock_dir.join(PROJECT_WRITE_LOCK_FILE);
    if std::fs::symlink_metadata(&lock_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("project write lock file must not be a symlink".to_string());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|e| format!("could not open project write lock: {e}"))?;
    file.lock_exclusive()
        .map_err(|e| format!("could not acquire project write lock: {e}"))?;
    Ok(ProjectWriteLock(file))
}

fn error_with_preserved_version(
    error: String,
    preserved: Option<&DisplacedAtomicJsonWrite>,
) -> String {
    match preserved {
        Some(displaced) => format!(
            "{error}; the newest displaced version was preserved at {}",
            displaced.path.display()
        ),
        None => error,
    }
}

/// Apply one JSON field mutation with a linearizable displaced-target loop.
///
/// Each exchange puts the prepared candidate at `target` and retains the exact
/// directory entry it displaced. If those bytes are not the version we
/// expected to replace, an external writer won before the exchange; reparse
/// those displaced bytes, reapply only our mutation, and exchange again. A
/// quiet exchange displaces our expected candidate and is the linearization
/// point. Unlike a check-then-rename preflight, no unseen target version is
/// overwritten without first being preserved.
fn commit_json_mutation_with_exchange<Mutate, Validate>(
    target: &mut ProjectWriteAnchor,
    initial_snapshot: Vec<u8>,
    mut mutate: Mutate,
    mut validate_target: Validate,
) -> Result<(), String>
where
    Mutate: FnMut(&[u8]) -> Result<serde_json::Value, String>,
    Validate: FnMut() -> Result<(), String>,
{
    let mut mutation_base = initial_snapshot.clone();
    let mut expected_visible = initial_snapshot;
    let mut preserved_base: Option<DisplacedAtomicJsonWrite> = None;

    loop {
        let tree = mutate(&mutation_base)
            .map_err(|error| error_with_preserved_version(error, preserved_base.as_ref()))?;
        let prepared = prepare_atomic_json_write(target, &tree)
            .map_err(|error| error_with_preserved_version(error, preserved_base.as_ref()))?;

        run_project_write_before_commit_hook();
        validate_target()
            .map_err(|error| error_with_preserved_version(error, preserved_base.as_ref()))?;
        let exchanged = prepared
            .exchange(target)
            .map_err(|error| error_with_preserved_version(error, preserved_base.as_ref()))?;

        // The new candidate was built from `preserved_base` and is now visible,
        // so that older recovery copy is no longer the only carrier of its
        // fields.
        if let Some(previous) = preserved_base.take() {
            previous.discard();
        }

        let displaced_bytes = exchanged.displaced.read_bytes()?;
        if displaced_bytes == expected_visible {
            exchanged.displaced.discard();
            return validate_target();
        }

        mutation_base = displaced_bytes;
        expected_visible = exchanged.candidate_bytes;
        preserved_base = Some(exchanged.displaced);
        std::thread::yield_now();
    }
}

/// Persist a project's `status` (and refresh its `updated_at`) back to the
/// company `board.json` under the resolved HQ folder.
///
/// Local-write counterpart to the read commands above — makes the desktop-alt
/// board a control center (US-010). The frontend updates its store optimistically
/// and calls this to persist; a returned `Err` is the rollback signal.
///
/// Inputs (HQ-relative, validated):
///   * `board_path` — HQ-folder-relative path ending in `board.json`.
///   * `project_id` — the `id` of the project entry to mutate.
///   * `prd_path`    — the linked PRD path that disambiguates legacy duplicate IDs.
///   * `status`     — the new status string (an editable-status value).
///
/// Safety/correctness (AC #1, #2):
///   * Indigo-gated, same as the readers.
///   * Canonical containment rejects traversal and cross-company aliases; every
///     write-path component must be a real non-symlink filesystem entry.
///   * The target must be a `board.json`.
///   * The write is atomic + round-trip-validated: we parse the existing JSON,
///     mutate the matching project, fsync a sibling candidate, atomically
///     exchange it with the target, and inspect the exact displaced bytes.
///     Concurrent external versions are merged forward until a quiet exchange;
///     parse/serialize failures never discard the displaced version.
///
/// Pure body for `set_local_project_status` — explicit HQ root for testing.
pub fn write_project_status(
    hq_root: &Path,
    board_path: &str,
    project_id: &str,
    prd_path: Option<&str>,
    status: &str,
) -> Result<(), String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("project_id is required".to_string());
    }
    // Test-only scheduling hook: both writers reach the lock boundary together,
    // proving that the cross-process lock serializes their complete mutations.
    run_project_write_start_hook();
    let _write_lock = acquire_project_write_lock(hq_root)?;
    let target = resolve_project_write_path(hq_root, board_path, "board.json")?;
    let mut write_anchor = ProjectWriteAnchor::open(&target)?;
    let expected_prd_path = normalize_project_identity_path(prd_path);

    require_same_project_write_target(hq_root, &target, "board.json")?;
    let snapshot = write_anchor
        .read_bytes()
        .map_err(|e| format!("could not read board.json at {board_path:?}: {e}"))?;
    commit_json_mutation_with_exchange(
        &mut write_anchor,
        snapshot,
        |base| {
            let mut tree: serde_json::Value = serde_json::from_slice(base)
                .map_err(|e| format!("board.json at {board_path:?} is not valid JSON: {e}"))?;

            let projects = tree
                .get_mut("projects")
                .and_then(|p| p.as_array_mut())
                .ok_or_else(|| "board.json has no `projects` array".to_string())?;

            let matching_indices: Vec<usize> = projects
                .iter()
                .enumerate()
                .filter(|(_, project)| {
                    project.get("id").and_then(|value| value.as_str()) == Some(project_id)
                        && normalize_project_identity_path(
                            project.get("prd_path").and_then(|value| value.as_str()),
                        ) == expected_prd_path
                })
                .map(|(index, _)| index)
                .collect();

            let target_index = match matching_indices.as_slice() {
                [index] => *index,
                [] => {
                    return Err(format!(
                        "no project with id {project_id:?} and prd_path {expected_prd_path:?} in board.json"
                    ))
                }
                _ => {
                    return Err(format!(
                        "multiple projects with id {project_id:?} and prd_path {expected_prd_path:?} in board.json"
                    ))
                }
            };
            let project_value = projects
                .get_mut(target_index)
                .ok_or_else(|| "matched project index disappeared".to_string())?;

            let obj = project_value
                .as_object_mut()
                .ok_or_else(|| "matched project is not a JSON object".to_string())?;
            obj.insert(
                "status".to_string(),
                serde_json::Value::String(status.to_string()),
            );
            obj.insert(
                "updated_at".to_string(),
                serde_json::Value::String(now_iso8601()),
            );
            Ok(tree)
        },
        || require_same_project_write_target(hq_root, &target, "board.json"),
    )
}

/// Match the frontend's project identity normalization: trim whitespace,
/// normalize separators, collapse duplicate slashes, and treat an empty path
/// as the explicit board-only (`None`) discriminator.
fn normalize_project_identity_path(prd_path: Option<&str>) -> Option<String> {
    let raw = prd_path?.trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = normalize_rel(raw)
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Persist a story's `passes` toggle back to the project's `prd.json` (optional
/// US-010 nicety). Same gate + guard + atomic-write discipline as the status
/// write; the `prd_path` must point at a `prd.json` inside the HQ folder.
/// Pure body for `set_local_story_passes` — explicit HQ root for testing.
pub fn write_story_passes(
    hq_root: &Path,
    prd_path: &str,
    story_id: &str,
    passes: bool,
) -> Result<(), String> {
    if story_id.trim().is_empty() {
        return Err("story_id is required".to_string());
    }
    run_project_write_start_hook();
    let _write_lock = acquire_project_write_lock(hq_root)?;
    let target = resolve_project_write_path(hq_root, prd_path, "prd.json")?;
    let mut write_anchor = ProjectWriteAnchor::open(&target)?;

    require_same_project_write_target(hq_root, &target, "prd.json")?;
    let snapshot = write_anchor
        .read_bytes()
        .map_err(|e| format!("could not read prd.json at {prd_path:?}: {e}"))?;
    commit_json_mutation_with_exchange(
        &mut write_anchor,
        snapshot,
        |base| {
            let mut tree: serde_json::Value = serde_json::from_slice(base)
                .map_err(|e| format!("prd.json at {prd_path:?} is not valid JSON: {e}"))?;

            let stories = tree
                .get_mut("userStories")
                .and_then(|s| s.as_array_mut())
                .ok_or_else(|| "prd.json has no `userStories` array".to_string())?;

            let story_value = stories
                .iter_mut()
                .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(story_id))
                .ok_or_else(|| format!("no story with id {story_id:?} in prd.json"))?;

            let obj = story_value
                .as_object_mut()
                .ok_or_else(|| "matched story is not a JSON object".to_string())?;
            obj.insert("passes".to_string(), serde_json::Value::Bool(passes));
            Ok(tree)
        },
        || require_same_project_write_target(hq_root, &target, "prd.json"),
    )
}

struct PreparedAtomicJsonWrite {
    temp_path: PathBuf,
    temp_name: std::ffi::OsString,
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    directory: HqScopedDirectory,
    serialized: Vec<u8>,
    exchanged: bool,
}

impl PreparedAtomicJsonWrite {
    fn exchange(mut self, target: &mut ProjectWriteAnchor) -> Result<AtomicJsonExchange, String> {
        run_project_write_at_exchange_hook();

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        target
            .directory
            .exchange_files(&self.temp_name, &target.target_name)?;
        #[cfg(target_os = "windows")]
        let displaced_path = {
            self.directory.release_directory_chain();
            target.directory.release_directory_chain();
            let displaced_path = atomic_exchange_file(&self.temp_path, &target.target_path)?;
            target.directory = open_hq_scoped_directory(&target.hq_root, &target.parent_rel)?;
            displaced_path
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        atomic_exchange_file(&self.temp_path, &target.target_path)?;

        self.exchanged = true;
        Ok(AtomicJsonExchange {
            candidate_bytes: std::mem::take(&mut self.serialized),
            displaced: DisplacedAtomicJsonWrite::capture(
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                self.temp_path.clone(),
                #[cfg(target_os = "windows")]
                displaced_path,
                #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
                self.directory.clone(),
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                self.temp_name.clone(),
                #[cfg(target_os = "windows")]
                self.temp_path
                    .with_extension("displaced")
                    .file_name()
                    .ok_or_else(|| "displaced project JSON has no filename".to_string())?
                    .to_os_string(),
            )?,
        })
    }
}

impl Drop for PreparedAtomicJsonWrite {
    fn drop(&mut self) {
        if !self.exchanged {
            // A failed pre-exchange operation never touched the target.
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            let _ = self.directory.remove_file(&self.temp_name);
            #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

struct AtomicJsonExchange {
    candidate_bytes: Vec<u8>,
    displaced: DisplacedAtomicJsonWrite,
}

/// Exact target bytes displaced by one atomic exchange.
///
/// This intentionally has no deleting `Drop`: if parsing, reading, or a later
/// exchange fails, preserving this hidden sibling is safer than discarding the
/// only copy of an external writer's version.
struct DisplacedAtomicJsonWrite {
    path: PathBuf,
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    directory: HqScopedDirectory,
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    entry_name: std::ffi::OsString,
    bytes: Vec<u8>,
}

#[cfg(all(any(target_os = "macos", target_os = "linux"), test))]
fn read_displaced_regular_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let descriptor = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .map_err(|error| {
        format!(
            "could not read displaced project JSON at {} without following links: {error}; the path was preserved",
            path.display()
        )
    })?;
    let mut file = std::fs::File::from(descriptor);
    let metadata = file.metadata().map_err(|error| {
        format!(
            "could not inspect displaced project JSON at {}: {error}; the path was preserved",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "could not read displaced project JSON at {}: entry is not a regular file; the path was preserved",
            path.display()
        ));
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| {
        format!(
            "could not read displaced project JSON at {}: {error}; the path was preserved",
            path.display()
        )
    })?;
    Ok(bytes)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn read_displaced_regular_file(path: &Path) -> Result<Vec<u8>, String> {
    Err(format!(
        "could not read displaced project JSON at {}: secure no-follow reads are unsupported on this platform; the path was preserved",
        path.display()
    ))
}


#[cfg(target_os = "windows")]
fn read_displaced_path(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "could not read displaced project JSON at {}: {error}; the path was preserved",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "could not read displaced project JSON at {}: entry is a symlink; the path was preserved",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "could not read displaced project JSON at {}: entry is not a regular file; the path was preserved",
            path.display()
        ));
    }
    let mut file = std::fs::File::open(path).map_err(|error| {
        format!(
            "could not read displaced project JSON at {}: {error}; the path was preserved",
            path.display()
        )
    })?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| {
        format!(
            "could not read displaced project JSON at {}: {error}; the path was preserved",
            path.display()
        )
    })?;
    Ok(bytes)
}

impl DisplacedAtomicJsonWrite {
    fn capture(
        path: PathBuf,
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        directory: HqScopedDirectory,
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        entry_name: std::ffi::OsString,
    ) -> Result<Self, String> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let bytes = {
            use std::io::Read;
            let mut file = directory.open_regular_file(&entry_name).map_err(|error| {
                format!(
                    "could not read displaced project JSON at {}: {error}; the path was preserved",
                    path.display()
                )
            })?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|error| {
                format!(
                    "could not read displaced project JSON at {}: {error}; the path was preserved",
                    path.display()
                )
            })?;
            bytes
        };
        #[cfg(target_os = "windows")]
        let bytes = read_displaced_path(&path)?;
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let bytes = read_displaced_regular_file(&path)?;

        Ok(Self {
            path,
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            directory,
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            entry_name,
            bytes,
        })
    }

    fn read_bytes(&self) -> Result<Vec<u8>, String> {
        Ok(self.bytes.clone())
    }

    fn discard(self) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let result = self.directory.remove_file(&self.entry_name);
        #[cfg(any(target_os = "windows", not(any(target_os = "macos", target_os = "linux", target_os = "windows"))))]
        let result = std::fs::remove_file(&self.path);

        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[projects-local] could not remove merged displaced file {}: {error}",
                    self.path.display()
                );
            }
        }
    }
}

/// Serialize and durably flush a sibling replacement file without changing the
/// visible target yet.
fn prepare_atomic_json_write(
    target: &ProjectWriteAnchor,
    value: &serde_json::Value,
) -> Result<PreparedAtomicJsonWrite, String> {
    let mut serialized = serde_json::to_string_pretty(value)
        .map_err(|e| format!("could not serialize JSON: {e}"))?;
    serialized.push('\n');
    let serialized = serialized.into_bytes();

    let dir = target
        .target_path
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let target_name = target
        .target_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("board.json");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    for attempt in 0..100u32 {
        let temp_name = std::ffi::OsString::from(format!(
            ".{target_name}.{}.{}.{attempt}.tmp",
            std::process::id(),
            nanos,
        ));
        let tmp_path = dir.join(&temp_name);
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        let opened = target.directory.create_new_file(&temp_name);
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let opened = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path);
        let mut file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("could not create temp file: {error}")),
        };

        use std::io::Write;
        if let Err(error) = file.write_all(&serialized).and_then(|()| file.sync_all()) {
            drop(file);
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            let _ = target.directory.remove_file(&temp_name);
            #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("could not prepare temp file: {error}"));
        }
        drop(file);
        return Ok(PreparedAtomicJsonWrite {
            temp_path: tmp_path,
            temp_name,
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            directory: target.directory.clone(),
            serialized,
            exchanged: false,
        });
    }

    Err(format!(
        "could not create a unique temp file beside {}",
        target.target_path.display()
    ))
}

/// Windows has no rename-exchange primitive. `ReplaceFileW` performs the
/// equivalent linearizable replacement and moves the exact old target to the
/// requested backup path. The replacement temp is fsynced before this call;
/// Microsoft's `REPLACEFILE_WRITE_THROUGH` flag is explicitly unsupported.
#[cfg(target_os = "windows")]
fn atomic_exchange_file(temp: &Path, target: &Path) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    let temp_resolved = std::fs::canonicalize(temp).map_err(|error| {
        format!(
            "could not resolve replacement temp {} before exchange: {error}",
            temp.display()
        )
    })?;
    let target_resolved = std::fs::canonicalize(target).map_err(|error| {
        format!(
            "could not resolve project JSON target {} before exchange: {error}",
            target.display()
        )
    })?;
    let backup_path = temp_resolved.with_extension("displaced");
    if std::fs::symlink_metadata(&backup_path).is_ok() {
        return Err(format!(
            "could not reserve displaced project JSON path {}",
            backup_path.display()
        ));
    }

    let temp_wide: Vec<u16> = temp_resolved.as_os_str().encode_wide().chain([0]).collect();
    let target_wide: Vec<u16> = target_resolved.as_os_str().encode_wide().chain([0]).collect();
    let backup_wide: Vec<u16> = backup_path.as_os_str().encode_wide().chain([0]).collect();
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temp_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        let backup_note = if backup_path.exists() {
            format!(
                "; the displaced original may be preserved at {}",
                backup_path.display()
            )
        } else {
            String::new()
        };
        return Err(format!(
            "could not atomically exchange project JSON: {}{backup_note}",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(backup_path)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn atomic_exchange_file(_temp: &Path, _target: &Path) -> Result<PathBuf, String> {
    Err("atomic project JSON exchange is unsupported on this platform".to_string())
}

/// Current UTC time as an ISO-8601 / RFC-3339 `Z` string (no chrono dep).
pub fn now_iso8601() -> String {
    // Days-since-epoch → civil date via Howard Hinnant's algorithm, then HMS.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Parse a JSON file leniently: `None` on missing/unreadable/garbage (never a
/// panic). Used so one bad file can be skipped instead of failing the scan.
pub fn read_json_lenient<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    let json_bytes = bytes
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(bytes.as_slice());
    match serde_json::from_slice::<T>(json_bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            // serde's derived struct visitor rejects duplicate fields even
            // though serde_json::Value follows common JSON consumer behavior
            // and keeps the last value. Accept that recoverable shape so one
            // duplicated optional metadata key cannot hide an entire project.
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(json_bytes) {
                if let Ok(parsed) = serde_json::from_value::<T>(value) {
                    return Some(parsed);
                }
            }

            log_parse_error_once(path, &e.to_string());
            None
        }
    }
}

fn log_parse_error_once(path: &Path, error: &str) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let display = portable_diagnostic_path(path);
    let key = format!("{display}\n{error}");
    let should_log = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut seen| seen.insert(key))
        .unwrap_or(true);
    if should_log {
        eprintln!("[projects-local] skipping unparseable {display}: {error}");
    }
}

/// Render diagnostics in the same forward-slash form used by upstream HQ
/// paths, stripping Windows' internal verbatim-path marker (`\\?\`).
pub fn portable_diagnostic_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_string()
    }
}

/// Find every `projects/*/prd.json` (one level deep) under a company's
/// `projects/` dir. Skips unreadable dirs. Does not recurse into `_archive`'s
/// nested layout beyond one level — board.json links cover archived prds.
pub fn find_prd_files(projects_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if !std::fs::symlink_metadata(projects_dir)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
    {
        return found;
    }
    let Ok(entries) = std::fs::read_dir(projects_dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let dir = entry.path();
        let candidate = dir.join("prd.json");
        if std::fs::symlink_metadata(&candidate)
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false)
        {
            found.push(candidate);
        }
    }
    found
}

/// Normalize a relative path for set membership (collapse `./`, unify slashes).
pub fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_start_matches("./").to_string()
}

/// True iff `candidate`, after lexical normalization, is contained within
/// `root`. Rejects `..` traversal and absolute escapes WITHOUT touching the
/// filesystem (so it works on non-existent paths too). We normalize lexically
/// rather than canonicalize because the target file may not exist yet and
/// canonicalize would also resolve symlinks we don't want to chase.
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let normalized = lexically_normalize(candidate);
    let root_norm = lexically_normalize(root);
    normalized.starts_with(&root_norm)
}

/// Collapse `.` and `..` components lexically. A leading `..` that would escape
/// the prefix is preserved as a `ParentDir` component so `is_within` rejects it.
pub fn lexically_normalize(path: &Path) -> PathBuf {
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                match stack.last() {
                    Some(Component::Normal(_)) => {
                        stack.pop();
                    }
                    // Can't pop a root/prefix; keep the `..` so it can't match a
                    // root prefix in `starts_with`.
                    _ => stack.push(component),
                }
            }
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for c in stack {
        out.push(c.as_os_str());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Windows junction fixtures are unavailable in the host environment.
    /// Keep the write-side authority boundary explicit: the prepared temp,
    /// target read, and displaced backup must all be reached through the same
    /// retained directory chain, while ReplaceFileW's actual backup path is
    /// preserved for recovery.
    #[test]
    fn windows_project_writes_keep_relative_directory_authority() {
        let source = include_str!("projects_local.rs");
        for required in [
            "directory.open_regular_file(&self.target_name)?",
            "target.directory.create_new_file(&temp_name)",
            "release_directory_chain();",
            "atomic_exchange_file(&self.temp_path, &target.target_path)?;",
            "target.directory = open_hq_scoped_directory(&target.hq_root, &target.parent_rel)?;",
            ".with_extension(\"displaced\")",
            "read_displaced_path(&path)?;",
            "std::fs::remove_file(&self.path);",
        ] {
            assert!(
                source.contains(required),
                "Windows project-write authority contract drifted: missing {required:?}"
            );
        }
    }

    /// Build a throwaway HQ tree under a unique temp dir and return its root.
    ///
    /// The dir name mixes pid + a monotonic time component **and** a process-wide
    /// atomic counter so two fixtures built concurrently (tests run in parallel)
    /// can never collide on the same path — a same-nanosecond collision would
    /// otherwise let one test's tree leak into another's scan.
    fn make_fixture_tree() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hq-projects-local-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        let indigo = root.join("companies").join("indigo");
        let proj = indigo.join("projects").join("flagship");
        fs::create_dir_all(&proj).unwrap();

        // A valid prd.json with 3 stories (2 passing).
        let prd = r#"{
            "name": "Flagship",
            "description": "the flagship project",
            "branchName": "feature/flagship",
            "userStories": [
                {"id":"US-001","title":"one","acceptanceCriteria":["a","b"],"passes":true,"priority":"P0","labels":["x"],"dependsOn":[],"notes":"n"},
                {"id":"US-002","title":"two","passes":true},
                {"id":"US-003","title":"three","passes":false}
            ],
            "metadata": {
                "company":"indigo",
                "goal":"ship",
                "createdAt":"2026-06-01T00:00:00Z",
                "updatedAt":"2026-06-03T00:00:00Z"
            }
        }"#;
        fs::write(proj.join("prd.json"), prd).unwrap();
        let damaged = indigo.join("projects").join("damaged");
        fs::create_dir_all(&damaged).unwrap();
        fs::write(damaged.join("prd.json"), "{ present but not valid json ]").unwrap();

        // board.json: one project links the prd above, one points at a missing
        // PRD, one has no project file identity, and one retains an existing
        // but malformed PRD for the diagnostics path.
        let board = r#"{
            "company": "indigo",
            "projects": [
                {"id":"in-proj-001","title":"Flagship","description":"d","status":"active","prd_path":"companies/indigo/projects/flagship/prd.json","created_at":"2026-06-02T00:00:00Z","updated_at":"2026-06-04T00:00:00Z"},
                {"id":"in-proj-002","title":"Broken","status":"archived","prd_path":"companies/indigo/projects/missing/prd.json","created_at":"2026-05-01T00:00:00Z"},
                {"id":"in-proj-003","title":"Board only","status":"in_progress","created_at":"2026-05-02T00:00:00Z"},
                {"id":"in-proj-004","title":"Damaged","status":"active","prd_path":"companies/indigo/projects/damaged/prd.json","created_at":"2026-05-03T00:00:00Z"}
            ]
        }"#;
        fs::write(indigo.join("board.json"), board).unwrap();

        // A second company with an unlinked prd (no board.json at all).
        let solo = root
            .join("companies")
            .join("acme")
            .join("projects")
            .join("widget");
        fs::create_dir_all(&solo).unwrap();
        fs::write(
            solo.join("prd.json"),
            r#"{
                "name":"Widget",
                "userStories":[{"id":"W-1","passes":false}],
                "metadata":{"createdAt":"2026-06-05T00:00:00Z","updatedAt":"2026-06-06T00:00:00Z"}
            }"#,
        )
        .unwrap();

        // A garbage prd.json that must be skipped (not panic).
        let junk = root
            .join("companies")
            .join("acme")
            .join("projects")
            .join("junk");
        fs::create_dir_all(&junk).unwrap();
        fs::write(junk.join("prd.json"), "{ this is not json ]").unwrap();

        root
    }

    #[test]
    fn scan_merges_board_and_prd_counts() {
        let root = make_fixture_tree();
        let mut projects = scan_local_projects(&root);
        // Deterministic order for assertions.
        projects.sort_by(|a, b| {
            (a.company.clone(), a.id.clone()).cmp(&(b.company.clone(), b.id.clone()))
        });

        // acme: one valid unlinked prd ("widget"), junk skipped.
        let acme: Vec<_> = projects.iter().filter(|p| p.company == "acme").collect();
        assert_eq!(acme.len(), 1, "junk prd must be skipped, widget kept");
        assert_eq!(acme[0].title, "Widget");
        assert_eq!(acme[0].story_count, 1);
        assert_eq!(acme[0].stories_complete, 0);
        assert_eq!(acme[0].created_at.as_deref(), Some("2026-06-05T00:00:00Z"));
        assert_eq!(acme[0].updated_at.as_deref(), Some("2026-06-06T00:00:00Z"));
        assert!(acme[0].provenance.owner.is_none());
        assert!(acme[0].provenance.creator.is_none());
        assert_eq!(
            acme[0].provenance.origin.as_deref(),
            Some("companies/acme/projects/widget/prd.json"),
            "an unlinked project points back to its defining PRD",
        );

        // Indigo's healthy linked project retains its board metadata and PRD counts.
        let flagship = projects
            .iter()
            .find(|p| p.id == "in-proj-001")
            .expect("flagship board project present");
        assert_eq!(flagship.title, "Flagship");
        assert_eq!(flagship.story_count, 3);
        assert_eq!(flagship.stories_complete, 2);
        assert_eq!(flagship.created_at.as_deref(), Some("2026-06-02T00:00:00Z"));
        assert_eq!(flagship.updated_at.as_deref(), Some("2026-06-04T00:00:00Z"));
        assert_eq!(
            flagship.prd_path.as_deref(),
            Some("companies/indigo/projects/flagship/prd.json")
        );
        assert!(flagship.provenance.owner.is_none());
        assert!(flagship.provenance.creator.is_none());
        assert_eq!(
            flagship.provenance.origin.as_deref(),
            Some("companies/indigo/board.json"),
            "a board project points back to its defining board",
        );

        assert!(
            projects.iter().all(|project| project.id != "in-proj-002"),
            "a stale board row with a missing PRD must not reach project surfaces",
        );
        assert!(
            projects.iter().all(|project| project.id != "in-proj-003"),
            "a board row without a project file must not reach project surfaces",
        );
        let damaged = projects
            .iter()
            .find(|project| project.id == "in-proj-004")
            .expect("an existing malformed PRD remains available for diagnostics");
        assert_eq!((damaged.story_count, damaged.stories_complete), (0, 0));

        // The flagship prd is board-linked, so it must NOT also appear as an
        // unlinked prd row (no duplicate).
        let flagship_rows = projects
            .iter()
            .filter(|p| {
                p.prd_path.as_deref() == Some("companies/indigo/projects/flagship/prd.json")
            })
            .count();
        assert_eq!(flagship_rows, 1, "linked prd must not be duplicated");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_drops_cross_company_board_prd_identity_before_it_reaches_the_ui() {
        let root = std::env::temp_dir().join(format!(
            "hq-projects-cross-company-board-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        let alpha = root.join("companies/alpha");
        let beta_project = root.join("companies/beta/projects/secret");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta_project).unwrap();
        fs::write(
            alpha.join("board.json"),
            r#"{
                "projects":[{
                    "id":"alpha-project",
                    "title":"Alpha project",
                    "prd_path":"companies/beta/projects/secret/prd.json"
                }]
            }"#,
        )
        .unwrap();
        fs::write(
            beta_project.join("prd.json"),
            r#"{
                "name":"Beta secret",
                "userStories":[{"id":"B-001","title":"Private task","passes":false}]
            }"#,
        )
        .unwrap();

        let allowed = HashSet::from(["alpha".to_string()]);
        let projects = scan_local_projects_for_companies(&root, &allowed);
        assert!(
            projects.is_empty(),
            "a board row without a readable same-company PRD must not reach Alpha UI",
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_companies_dir_returns_empty() {
        let root =
            std::env::temp_dir().join(format!("hq-projects-local-empty-{}", std::process::id()));
        // Root exists but has no companies/ subdir.
        let _ = fs::create_dir_all(&root);
        assert!(scan_local_projects(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_prd_parses_stories() {
        let root = make_fixture_tree();
        let prd = read_project_prd(&root, "companies/indigo/projects/flagship/prd.json")
            .expect("prd parses");
        assert_eq!(prd.name, "Flagship");
        assert_eq!(prd.branch_name.as_deref(), Some("feature/flagship"));
        assert_eq!(prd.user_stories.len(), 3);
        let us1 = &prd.user_stories[0];
        assert_eq!(us1.id, "US-001");
        assert_eq!(us1.acceptance_criteria, vec!["a", "b"]);
        assert!(us1.passes);
        // String priority still round-trips (now carried as a JSON value).
        assert_eq!(us1.priority.as_ref().and_then(|v| v.as_str()), Some("P0"));
        assert_eq!(us1.labels, vec!["x"]);
        assert_eq!(us1.notes.as_deref(), Some("n"));
        assert!(us1.provenance.owner.is_none());
        assert!(us1.provenance.creator.is_none());
        assert_eq!(
            us1.provenance.origin.as_deref(),
            Some("companies/indigo/projects/flagship/prd.json"),
            "stories point back to their defining PRD",
        );
        assert_eq!(
            prd.provenance.origin.as_deref(),
            Some("companies/indigo/projects/flagship/prd.json"),
        );
        // metadata passes through.
        assert_eq!(prd.metadata["company"], "indigo");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn provenance_normalizes_board_prd_and_story_aliases_without_inventing_people() {
        let root = std::env::temp_dir().join(format!(
            "hq-projects-provenance-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let company = root.join("companies").join("indigo");
        let project_dir = company.join("projects").join("launch");
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("prd.json"),
            r#"{
                "name":"Launch",
                "metadata":{
                    "owner":"PRD owner",
                    "createdBy":{"displayName":"Corey"},
                    "source":"Local PRD"
                },
                "userStories":[{
                    "id":"US-001",
                    "title":"Trace origin",
                    "assignee_name":"Ada",
                    "created_by":{"email":"corey@example.com"},
                    "metadata":{"owner":{"name":"Maya"},"source":"Linear import"}
                },{
                    "id":"US-002",
                    "title":"Legacy story"
                }]
            }"#,
        )
        .unwrap();
        fs::write(
            company.join("board.json"),
            r#"{
                "projects":[{
                    "id":"p-1",
                    "title":"Launch",
                    "prd_path":"companies/indigo/projects/launch/prd.json",
                    "owner":{"displayName":"Board owner"},
                    "origin":"HQ plan"
                }]
            }"#,
        )
        .unwrap();

        let projects = scan_local_projects(&root);
        let project = projects.iter().find(|project| project.id == "p-1").unwrap();
        assert_eq!(project.provenance.owner.as_deref(), Some("Board owner"));
        assert_eq!(project.provenance.creator.as_deref(), Some("Corey"));
        assert_eq!(project.provenance.origin.as_deref(), Some("HQ plan"));
        assert!(project.provenance.assignee.is_none());

        let prd = read_project_prd(&root, "companies/indigo/projects/launch/prd.json")
            .expect("provenance PRD parses");
        let attributed = &prd.user_stories[0];
        assert_eq!(attributed.provenance.owner.as_deref(), Some("Maya"));
        assert_eq!(attributed.provenance.assignee.as_deref(), Some("Ada"));
        assert_eq!(
            attributed.provenance.creator.as_deref(),
            Some("corey@example.com")
        );
        assert_eq!(
            attributed.provenance.origin.as_deref(),
            Some("Linear import")
        );
        assert_eq!(prd.provenance.owner.as_deref(), Some("PRD owner"));
        assert_eq!(prd.provenance.creator.as_deref(), Some("Corey"));
        assert_eq!(prd.provenance.origin.as_deref(), Some("Local PRD"));
        let legacy = &prd.user_stories[1].provenance;
        assert!(legacy.owner.is_none());
        assert!(legacy.assignee.is_none());
        assert!(legacy.creator.is_none());
        assert_eq!(
            legacy.origin.as_deref(),
            Some("companies/indigo/projects/launch/prd.json"),
            "a missing story source falls back to the real PRD without guessing a person",
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn git_first_add_creator_is_an_honest_last_resort_not_an_owner() {
        let log = concat!(
            "\u{001e}a1\u{001f}Corey Epstein\u{001f}corey@getindigo.ai\n\n",
            "A\tcompanies/indigo/projects/alpha/prd.json\n",
            "\u{001e}b2\u{001f}\u{001f}maya@example.com\n\n",
            "A\tcompanies/indigo/projects/beta/prd.json\n",
            "\u{001e}c3\u{001f}Project Mover\u{001f}mover@example.com\n\n",
            "R100\tcompanies/indigo/projects/alpha/prd.json\tcompanies/indigo/projects/alpha-renamed/prd.json\n",
            "\u{001e}d4\u{001f}Later Author\u{001f}later@example.com\n\n",
            "A\tcompanies/indigo/projects/alpha/prd.json\n",
            "\u{001e}e5\u{001f}Other Tenant Author\u{001f}other@example.com\n\n",
            "A\tcompanies/other/projects/secret/prd.json\n",
        );
        let creators = parse_git_first_add_creators(log);
        assert_eq!(
            project_history_scopes(&[
                "companies/indigo/projects/alpha/prd.json".to_string(),
                "companies/indigo/projects/beta/prd.json".to_string(),
                "companies/other/projects/gamma/prd.json".to_string(),
                "../companies/escape/projects/nope/prd.json".to_string(),
            ]),
            vec![
                "companies/indigo/projects".to_string(),
                "companies/other/projects".to_string(),
            ],
            "history scans collapse exact PRDs to authorized company scopes",
        );
        assert_eq!(
            creators
                .get("companies/indigo/projects/alpha/prd.json")
                .map(String::as_str),
            Some("Corey Epstein"),
            "the oldest add author wins even if a file is added again",
        );
        assert_eq!(
            creators
                .get("companies/indigo/projects/beta/prd.json")
                .map(String::as_str),
            Some("maya@example.com"),
            "email is retained when Git has no display name",
        );
        assert_eq!(
            creators
                .get("companies/indigo/projects/alpha-renamed/prd.json")
                .map(String::as_str),
            Some("Corey Epstein"),
            "an exact rename carries the original creator instead of the mover",
        );

        let project = |id: &str, path: &str, provenance: WorkProvenance| LocalProject {
            id: id.to_string(),
            title: id.to_string(),
            description: String::new(),
            company: "indigo".to_string(),
            status: "active".to_string(),
            prd_path: Some(path.to_string()),
            created_at: None,
            updated_at: None,
            story_count: 0,
            stories_complete: 0,
            provenance,
            creator_fallback: None,
        };
        let mut projects = vec![
            project(
                "alpha",
                "companies/indigo/projects/alpha/prd.json",
                WorkProvenance::default(),
            ),
            project(
                "beta",
                "companies/indigo/projects/beta/prd.json",
                WorkProvenance {
                    owner: Some("Explicit owner".to_string()),
                    ..WorkProvenance::default()
                },
            ),
            project(
                "cross-tenant",
                "companies/other/projects/secret/prd.json",
                WorkProvenance::default(),
            ),
        ];
        apply_creator_fallback_map(&mut projects, &creators);

        assert_eq!(
            projects[0].creator_fallback.as_deref(),
            Some("Corey Epstein"),
        );
        assert!(projects[0].provenance.owner.is_none());
        assert!(projects[0].provenance.creator.is_none());
        assert!(
            projects[1].creator_fallback.is_none(),
            "explicit responsibility must outrank Git history",
        );
        assert!(
            projects[2].creator_fallback.is_none(),
            "an Indigo project must never expose another tenant's Git author even if its board retains a cross-company path",
        );
    }

    #[test]
    fn creator_history_cache_is_scoped_and_invalidates_at_a_new_head() {
        let root = std::env::temp_dir().join(format!(
            "hq-projects-creator-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        let project_dir = root.join("companies/indigo/projects/alpha");
        fs::create_dir_all(&project_dir).expect("project dir");

        let git = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .env("GIT_OPTIONAL_LOCKS", "0")
                .status()
                .expect("git command");
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "--quiet"]);
        fs::create_dir_all(root.join(".git/empty-hooks")).expect("empty hooks dir");
        git(&["config", "core.hooksPath", ".git/empty-hooks"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "user.name", "First Author"]);
        git(&["config", "user.email", "first@example.com"]);
        fs::write(
            project_dir.join("prd.json"),
            r#"{
                "name":"alpha",
                "description":"A sufficiently stable project document for rename similarity.",
                "userStories":[
                    {"id":"US-001","title":"Preserve original creator","passes":false},
                    {"id":"US-002","title":"Keep project history","passes":false}
                ]
            }"#,
        )
        .expect("write alpha");
        git(&["add", "companies/indigo/projects/alpha/prd.json"]);
        git(&["commit", "--quiet", "--no-verify", "-m", "add alpha"]);

        let alpha_path = "companies/indigo/projects/alpha/prd.json".to_string();
        let alpha = first_add_creators_for_paths(&root, std::slice::from_ref(&alpha_path));
        assert_eq!(
            alpha.get(&alpha_path).map(String::as_str),
            Some("First Author")
        );

        let scopes = project_history_scopes(std::slice::from_ref(&alpha_path));
        let first_key = CreatorHistoryCacheKey {
            hq_root: root.clone(),
            head: git_head(&root).expect("first head"),
            scopes,
        };
        assert!(
            CREATOR_HISTORY_CACHE
                .get()
                .and_then(|cache| cache.lock().ok())
                .is_some_and(|entries| entries.contains_key(&first_key)),
            "the first history walk is cached by repo, HEAD, and authorized scopes",
        );

        let beta_dir = root.join("companies/indigo/projects/beta");
        fs::create_dir_all(&beta_dir).expect("beta dir");
        git(&["config", "user.name", "Second Author"]);
        git(&["config", "user.email", "second@example.com"]);
        git(&[
            "mv",
            "companies/indigo/projects/alpha",
            "companies/indigo/projects/alpha-renamed",
        ]);
        fs::write(
            root.join("companies/indigo/projects/alpha-renamed/prd.json"),
            r#"{
                "name":"alpha renamed",
                "description":"A sufficiently stable project document for rename similarity.",
                "userStories":[
                    {"id":"US-001","title":"Preserve original creator","passes":true},
                    {"id":"US-002","title":"Keep project history","passes":false}
                ]
            }"#,
        )
        .expect("edit moved alpha");
        git(&["add", "companies/indigo/projects/alpha-renamed/prd.json"]);
        fs::write(beta_dir.join("prd.json"), r#"{"name":"beta"}"#).expect("write beta");
        git(&["add", "companies/indigo/projects/beta/prd.json"]);
        git(&[
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "move alpha and add beta",
        ]);

        let renamed_path = "companies/indigo/projects/alpha-renamed/prd.json".to_string();
        let beta_path = "companies/indigo/projects/beta/prd.json".to_string();
        let exact_only = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args([
                "diff-tree",
                "--no-commit-id",
                "-r",
                "--find-renames=100%",
                "--diff-filter=ADR",
                "--name-status",
                "HEAD",
                "--",
                "companies/indigo/projects",
            ])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .expect("exact-only diff");
        let exact_only = String::from_utf8_lossy(&exact_only.stdout);
        assert!(
            exact_only.lines().any(|line| line.starts_with("A\t"))
                && exact_only.lines().any(|line| line.starts_with("D\t")),
            "fixture must be a modified rename that exact-only detection misses: {exact_only}",
        );
        let refreshed =
            first_add_creators_for_paths(&root, &[renamed_path.clone(), beta_path.clone()]);
        assert_eq!(
            refreshed.get(&renamed_path).map(String::as_str),
            Some("First Author"),
            "moving a PRD under a new author must retain its original creator",
        );
        assert_eq!(
            refreshed.get(&beta_path).map(String::as_str),
            Some("Second Author"),
            "a new HEAD invalidates the cached creator map",
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn numeric_priority_does_not_break_the_prd() {
        // Regression: real prds write `priority` as a NUMBER (e.g. 1). When the
        // field was typed `Option<String>`, serde rejected the entire prd the
        // moment it hit a numeric priority — so EVERY story vanished and the
        // board showed "0 stories" (and unlinked numeric-priority prds dropped
        // out of the project list entirely). The prd must parse with all stories.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hq-prd-numprio-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        let proj = root
            .join("companies")
            .join("acme")
            .join("projects")
            .join("numeric");
        fs::create_dir_all(&proj).unwrap();
        let prd = r#"{
            "name": "Numeric",
            "userStories": [
                {"id":"US-1","title":"a","passes":true,"priority":1},
                {"id":"US-2","title":"b","passes":false,"priority":2}
            ]
        }"#;
        fs::write(proj.join("prd.json"), prd).unwrap();

        // Direct read keeps both stories and passes the numeric priority through.
        let parsed = read_project_prd(&root, "companies/acme/projects/numeric/prd.json")
            .expect("numeric-priority prd must parse");
        assert_eq!(parsed.user_stories.len(), 2);
        assert_eq!(parsed.user_stories[0].priority, Some(serde_json::json!(1)));

        // The board scan reports the REAL counts (2 total, 1 complete) — not 0 —
        // and lists the unlinked prd as a project.
        let projects = scan_local_projects(&root);
        let numeric = projects
            .iter()
            .find(|p| p.title == "Numeric")
            .expect("unlinked numeric-priority prd should surface as a project");
        assert_eq!(numeric.story_count, 2);
        assert_eq!(numeric.stories_complete, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn real_prd_story_variants_remain_visible_without_changing_completion_semantics() {
        let root =
            std::env::temp_dir().join(format!("hq-prd-schema-variants-{}", std::process::id(),));
        let proj = root.join("companies/acme/projects/schema-variants");
        fs::create_dir_all(&proj).unwrap();
        fs::write(
            proj.join("prd.json"),
            r#"{
                "name":"Schema variants",
                "userStories":[
                    {
                        "id":"S-1",
                        "acceptanceCriteria":[
                            "Plain criterion",
                            {"criterion":"Structured criterion","testability":"automated"}
                        ],
                        "passes":true,
                        "labels":["ui"],
                        "dependsOn":["S-0"],
                        "notes":"Preserve exactly"
                    },
                    {
                        "id":"S-2",
                        "acceptanceCriteria":[
                            {"criterion":"Manual criterion","testability":"manual"}
                        ],
                        "passes":"skipped"
                    },
                    {"id":"S-3","passes":null},
                    {"id":"S-4"}
                ]
            }"#,
        )
        .unwrap();

        let parsed = read_project_prd(&root, "companies/acme/projects/schema-variants/prd.json")
            .expect("real story schema variants parse");
        assert_eq!(parsed.user_stories.len(), 4);
        assert_eq!(
            parsed.user_stories[0].acceptance_criteria,
            vec!["Plain criterion", "Structured criterion"],
        );
        assert_eq!(
            parsed.user_stories[1].acceptance_criteria,
            vec!["Manual criterion"],
        );
        assert!(parsed.user_stories[0].passes);
        assert!(parsed.user_stories[1..].iter().all(|story| !story.passes));
        assert_eq!(parsed.user_stories[0].labels, vec!["ui"]);
        assert_eq!(parsed.user_stories[0].depends_on, vec!["S-0"]);
        assert_eq!(
            parsed.user_stories[0].notes.as_deref(),
            Some("Preserve exactly"),
        );

        let projects = scan_local_projects(&root);
        let project = projects
            .iter()
            .find(|project| project.title == "Schema variants")
            .expect("schema-variant PRD remains in project scan");
        assert_eq!((project.story_count, project.stories_complete), (4, 1));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn utf8_bom_is_ignored_but_malformed_json_still_fails() {
        let root = std::env::temp_dir().join(format!("hq-prd-bom-{}", std::process::id(),));
        fs::create_dir_all(&root).unwrap();
        let bom_path = root.join("bom.json");
        let mut bom_json = vec![0xef, 0xbb, 0xbf];
        bom_json.extend_from_slice(br#"{"name":"BOM project","userStories":[]}"#);
        fs::write(&bom_path, bom_json).unwrap();
        let parsed = read_json_lenient::<PrdFile>(&bom_path).expect("UTF-8 BOM is accepted");
        assert_eq!(parsed.name, "BOM project");

        let malformed_path = root.join("malformed.json");
        fs::write(
            &malformed_path,
            br#"{"name":"broken","userStories":[{"id":"S-1"} {"id":"S-2"}]}"#,
        )
        .unwrap();
        assert!(
            read_json_lenient::<PrdFile>(&malformed_path).is_none(),
            "genuinely malformed JSON remains visible to diagnostics and skipped",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_prd_garbage_file_errors_not_panics() {
        let root = make_fixture_tree();
        let err = read_project_prd(&root, "companies/acme/projects/junk/prd.json")
            .expect_err("garbage prd must Err, not panic");
        assert!(err.contains("could not read or parse"), "got: {err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lenient_reader_accepts_duplicate_story_notes_with_last_value_winning() {
        let root = std::env::temp_dir().join(format!(
            "hq-projects-duplicate-notes-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("prd.json");
        fs::write(
            &path,
            r#"{"name":"Duplicate notes","userStories":[{"id":"US-001","notes":"old","notes":"new"}]}"#,
        )
        .unwrap();

        let parsed = read_json_lenient::<PrdFile>(&path).expect("duplicate keys are tolerated");
        assert_eq!(parsed.user_stories[0].notes.as_deref(), Some("new"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn diagnostic_paths_strip_windows_verbatim_prefix_and_use_forward_slashes() {
        assert_eq!(
            portable_diagnostic_path(Path::new(
                r"\\?\C:\Users\person\HQ\companies\acme\projects\demo\prd.json"
            )),
            "C:/Users/person/HQ/companies/acme/projects/demo/prd.json"
        );
    }

    #[test]
    fn normalize_rel_accepts_upstream_and_windows_separator_styles() {
        let upstream = "./companies/acme/projects/demo/prd.json";
        let windows = r".\companies\acme\projects\demo\prd.json";
        assert_eq!(
            normalize_rel(upstream),
            "companies/acme/projects/demo/prd.json"
        );
        assert_eq!(
            normalize_rel(windows),
            "companies/acme/projects/demo/prd.json"
        );
    }

    #[test]
    fn read_prd_missing_file_errors() {
        let root = make_fixture_tree();
        let err = read_project_prd(&root, "companies/indigo/projects/nope/prd.json")
            .expect_err("missing prd must Err");
        assert!(err.contains("could not read or parse"), "got: {err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_traversal_is_rejected() {
        let root = make_fixture_tree();
        for evil in [
            "../../../etc/passwd",
            "companies/../../secrets/prd.json",
            "/etc/passwd",
            "companies/indigo/../../../prd.json",
        ] {
            let res = read_project_prd(&root, evil);
            assert!(res.is_err(), "traversal {evil:?} must be rejected");
        }
        // Non-prd.json filename inside the tree is also rejected.
        let res = read_project_prd(&root, "companies/indigo/board.json");
        assert!(res.is_err(), "non-prd.json target must be rejected");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_readme_returns_sibling_content() {
        let root = make_fixture_tree();
        // No README yet → Ok(None).
        let none = read_project_readme(&root, "companies/indigo/projects/flagship/prd.json")
            .expect("missing README is Ok(None)");
        assert!(none.is_none(), "no README → None");

        // Write a sibling README and read it back.
        let readme_path = root
            .join("companies")
            .join("indigo")
            .join("projects")
            .join("flagship")
            .join("README.md");
        fs::write(&readme_path, "# Flagship\n\nHello **world**.").unwrap();
        let some = read_project_readme(&root, "companies/indigo/projects/flagship/prd.json")
            .expect("README reads")
            .expect("README present");
        assert!(some.contains("# Flagship"));
        assert!(some.contains("Hello **world**."));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_readme_rejects_traversal_and_non_prd() {
        let root = make_fixture_tree();
        for evil in ["../../../etc/passwd", "companies/../../secrets/prd.json"] {
            assert!(
                read_project_readme(&root, evil).is_err(),
                "traversal {evil:?} must be rejected"
            );
        }
        // A non-prd.json target is rejected before any README is derived.
        assert!(
            read_project_readme(&root, "companies/indigo/board.json").is_err(),
            "non-prd.json target must be rejected"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_within_lexical_guard() {
        let root = Path::new("/Users/x/HQ");
        assert!(is_within(root, &root.join("companies/indigo/prd.json")));
        assert!(!is_within(root, Path::new("/Users/x/HQ/../evil")));
        assert!(!is_within(root, Path::new("/etc/passwd")));
        assert!(is_within(root, &root.join("a/./b/../c")));
    }

    // ---- company goals -----------------------------------------------------

    /// Build a fixture HQ tree whose indigo board.json carries 2 objectives
    /// (one with a populated key_result, one with `[]`) + 1 initiative.
    fn make_goals_fixture_tree() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hq-projects-local-goals-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        let indigo = root.join("companies").join("indigo");
        fs::create_dir_all(&indigo).unwrap();

        let board = r#"{
            "company": "indigo",
            "objectives": [
                {
                    "id": "in-obj-001",
                    "title": "Desktop Experience",
                    "description": "Native desktop apps",
                    "timeframe": "2026",
                    "owner": "corey",
                    "status": "on_track",
                    "linear_initiative_id": null,
                    "initiative_ids": ["in-init-001"],
                    "key_results": [
                        {"id":"kr-1","title":"Ship 1.0","metric":"releases","target":1,"current":0,"unit":"count","status":"in_progress"}
                    ]
                },
                {
                    "id": "in-obj-002",
                    "title": "Platform Stability",
                    "description": "Reliability",
                    "timeframe": "2026",
                    "owner": null,
                    "status": "on_track",
                    "initiative_ids": ["in-init-002"],
                    "key_results": []
                }
            ],
            "initiatives": [
                {
                    "id": "in-init-001",
                    "title": "Desktop Experience",
                    "description": "Native desktop apps",
                    "status": "active"
                }
            ],
            "projects": []
        }"#;
        fs::write(indigo.join("board.json"), board).unwrap();
        root
    }

    #[test]
    fn read_company_goals_parses_objectives_and_initiatives() {
        let root = make_goals_fixture_tree();
        let goals = read_company_goals(&root, "indigo").expect("goals parse");

        assert_eq!(goals.objectives.len(), 2);
        assert_eq!(goals.initiatives.len(), 1);

        // Objective 1: populated key_result + owner + linked initiative.
        let obj1 = &goals.objectives[0];
        assert_eq!(obj1.id, "in-obj-001");
        assert_eq!(obj1.title, "Desktop Experience");
        assert_eq!(obj1.status, "on_track");
        assert_eq!(obj1.timeframe, "2026");
        assert_eq!(obj1.owner.as_deref(), Some("corey"));
        assert_eq!(obj1.initiative_ids, vec!["in-init-001"]);
        assert_eq!(obj1.key_results.len(), 1);
        let kr = &obj1.key_results[0];
        assert_eq!(kr.id.as_deref(), Some("kr-1"));
        assert_eq!(kr.title.as_deref(), Some("Ship 1.0"));
        assert_eq!(kr.metric.as_deref(), Some("releases"));
        assert_eq!(kr.unit.as_deref(), Some("count"));
        assert_eq!(kr.status.as_deref(), Some("in_progress"));

        // Objective 2: empty key_results, null owner.
        let obj2 = &goals.objectives[1];
        assert_eq!(obj2.id, "in-obj-002");
        assert!(obj2.owner.is_none());
        assert!(obj2.key_results.is_empty());

        // Initiative round-trips.
        let init = &goals.initiatives[0];
        assert_eq!(init.id, "in-init-001");
        assert_eq!(init.title, "Desktop Experience");
        assert_eq!(init.status, "active");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_company_goals_missing_board_is_empty_not_panic() {
        let root = make_goals_fixture_tree();
        // A company with no board.json at all → empty goals, no error/panic.
        let goals = read_company_goals(&root, "acme").expect("missing board → empty goals");
        assert!(goals.objectives.is_empty());
        assert!(goals.initiatives.is_empty());
        assert_eq!(goals, CompanyGoals::default());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_company_goals_rejects_traversal_and_empty_slug() {
        let root = make_goals_fixture_tree();
        for evil in ["../../../etc", "..", ".", "foo/bar", "indigo/../secrets"] {
            assert!(
                read_company_goals(&root, evil).is_err(),
                "slug {evil:?} must be rejected"
            );
        }
        assert!(
            read_company_goals(&root, "   ").is_err(),
            "empty slug rejected"
        );
        let _ = fs::remove_dir_all(&root);
    }

    // ---- CRM projection (hq-native-crm US-010) -----------------------------

    fn make_crm_fixture_tree() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hq-projects-local-crm-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        let indigo = root.join("companies").join("indigo");
        fs::create_dir_all(&indigo).unwrap();
        let projection = r#"{
            "schema_version": 1,
            "synced_at": "2026-06-15T00:00:00Z",
            "accounts": [
                { "id": "ent_acme", "name": "Acme", "stage": "signed",
                  "external_ids": { "stripe": "cus_1" },
                  "sources": { "billing": { "system": "stripe", "status": "paid", "value": "$1", "meta": "", "ref": "cus_1" } },
                  "timeline": [] }
            ]
        }"#;
        fs::write(indigo.join("crm-projection.json"), projection).unwrap();
        root
    }

    #[test]
    fn read_crm_projection_returns_the_synced_json_passthrough() {
        let root = make_crm_fixture_tree();
        let value = read_crm_projection(&root, "indigo").expect("projection read");
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["accounts"][0]["id"], "ent_acme");
        assert_eq!(value["accounts"][0]["sources"]["billing"]["status"], "paid");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_crm_projection_missing_file_is_null_not_error() {
        let root = make_crm_fixture_tree();
        // A company with no crm-projection.json → JSON null (fall back to vault).
        let value = read_crm_projection(&root, "acme").expect("missing projection → null");
        assert!(value.is_null());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_crm_projection_unparseable_file_is_null_not_error() {
        let root = make_crm_fixture_tree();
        let bad = root.join("companies").join("acme");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("crm-projection.json"), "{ not json").unwrap();
        let value = read_crm_projection(&root, "acme").expect("garbage projection → null");
        assert!(value.is_null());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_crm_projection_rejects_traversal_and_empty_slug() {
        let root = make_crm_fixture_tree();
        for evil in ["../../../etc", "..", ".", "foo/bar", "indigo/../secrets"] {
            assert!(
                read_crm_projection(&root, evil).is_err(),
                "slug {evil:?} must be rejected"
            );
        }
        assert!(
            read_crm_projection(&root, "   ").is_err(),
            "empty slug rejected"
        );
        let _ = fs::remove_dir_all(&root);
    }

    // ---- writes (US-010) ---------------------------------------------------

    #[test]
    fn write_project_status_persists_and_round_trips() {
        let root = make_fixture_tree();
        let board_rel = "companies/indigo/board.json";

        // Sanity: the fixture board has in-proj-001 with status "active".
        let before: BoardFile =
            read_json_lenient(&root.join(board_rel)).expect("board parses before");
        let p0 = before
            .projects
            .iter()
            .find(|p| p.id == "in-proj-001")
            .expect("in-proj-001 present");
        assert_eq!(p0.status, "active");

        // Mutate → reread → assert the new status persisted.
        write_project_status(
            &root,
            board_rel,
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        )
        .expect("status write succeeds");

        let after_bytes = fs::read(root.join(board_rel)).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&after_bytes).expect("still valid JSON");
        let proj = after["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "in-proj-001")
            .expect("in-proj-001 still present");
        assert_eq!(proj["status"], "completed");
        // updated_at was refreshed to an ISO-8601 Z timestamp.
        let updated = proj["updated_at"].as_str().expect("updated_at written");
        assert!(
            updated.ends_with('Z') && updated.contains('T'),
            "got: {updated}"
        );

        // Untouched sibling project keeps its original status (no clobber).
        let other = after["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "in-proj-002")
            .expect("in-proj-002 preserved");
        assert_eq!(other["status"], "archived");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_project_status_rejects_malformed_and_missing_targets() {
        let root = make_fixture_tree();

        // Path traversal / absolute escape is rejected.
        for evil in ["../../../etc/board.json", "/etc/board.json"] {
            assert!(
                write_project_status(
                    &root,
                    evil,
                    "in-proj-001",
                    Some("companies/indigo/projects/flagship/prd.json"),
                    "completed",
                )
                .is_err(),
                "traversal {evil:?} must be rejected"
            );
        }
        // A non-board.json target inside the tree is rejected.
        assert!(
            write_project_status(
                &root,
                "companies/indigo/projects/flagship/prd.json",
                "in-proj-001",
                Some("companies/indigo/projects/flagship/prd.json"),
                "completed",
            )
            .is_err(),
            "non-board.json target must be rejected"
        );
        // An unknown project id is rejected (and the file is left untouched).
        let before = fs::read(root.join("companies/indigo/board.json")).unwrap();
        assert!(
            write_project_status(
                &root,
                "companies/indigo/board.json",
                "nope-id",
                Some("companies/indigo/projects/flagship/prd.json"),
                "completed",
            )
            .is_err(),
            "unknown project id must Err"
        );
        let after = fs::read(root.join("companies/indigo/board.json")).unwrap();
        assert_eq!(before, after, "rejected write must not mutate the file");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_project_status_uses_prd_path_to_disambiguate_duplicate_ids() {
        let root = make_fixture_tree();
        let board_rel = "companies/indigo/board.json";
        fs::write(
            root.join(board_rel),
            r#"{
                "company": "indigo",
                "projects": [
                    {
                        "id": "duplicate-id",
                        "title": "First",
                        "status": "active",
                        "prd_path": "companies/indigo/projects/first/prd.json"
                    },
                    {
                        "id": "duplicate-id",
                        "title": "Second",
                        "status": "planned",
                        "prd_path": "companies/indigo/projects/second/prd.json"
                    }
                ]
            }"#,
        )
        .unwrap();

        write_project_status(
            &root,
            board_rel,
            "duplicate-id",
            Some(r#".\companies\indigo//projects/second/prd.json"#),
            "completed",
        )
        .expect("the PRD path selects the second duplicate");

        let after: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(board_rel)).unwrap()).unwrap();
        let projects = after["projects"].as_array().unwrap();
        assert_eq!(projects[0]["status"], "active");
        assert_eq!(projects[1]["status"], "completed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_story_passes_toggles_and_preserves_siblings() {
        let root = make_fixture_tree();
        let prd_rel = "companies/indigo/projects/flagship/prd.json";

        // US-003 starts passes=false; flip to true.
        write_story_passes(&root, prd_rel, "US-003", true).expect("passes write succeeds");

        let prd = read_project_prd(&root, prd_rel).expect("prd still parses");
        let us3 = prd
            .user_stories
            .iter()
            .find(|s| s.id == "US-003")
            .expect("US-003 present");
        assert!(us3.passes, "US-003 must now pass");
        // A sibling story is untouched.
        let us1 = prd.user_stories.iter().find(|s| s.id == "US-001").unwrap();
        assert!(us1.passes, "US-001 still passes");

        // A bad target path is rejected.
        assert!(
            write_story_passes(&root, "../../evil/prd.json", "US-003", true).is_err(),
            "traversal must be rejected"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn project_read_rejects_parent_swap_after_target_resolution() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let active_dir = root.join("companies/indigo/projects/flagship");
        let pending_dir = root.join("companies/pending/projects/flagship");
        fs::create_dir_all(&pending_dir).unwrap();
        fs::write(
            pending_dir.join("prd.json"),
            r#"{"name":"Pending secret","userStories":[]}"#,
        )
        .unwrap();

        set_project_read_before_open_hook({
            let root = root.clone();
            let active_dir = active_dir.clone();
            move || {
                fs::rename(
                    &active_dir,
                    root.join("companies/indigo/projects/flagship-original"),
                )
                .unwrap();
                symlink(&pending_dir, &active_dir).unwrap();
            }
        });

        let result = read_project_prd(&root, "companies/indigo/projects/flagship/prd.json");
        assert!(
            result.is_err(),
            "a parent swap must fail closed, got {:?}",
            result.unwrap()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_exchange_preserves_the_exact_displaced_target() {
        let root = make_fixture_tree();
        let target_path = root.join("companies/indigo/board.json");
        let original = fs::read(&target_path).unwrap();
        let resolved =
            resolve_project_write_path(&root, "companies/indigo/board.json", "board.json").unwrap();
        let mut target = ProjectWriteAnchor::open(&resolved).unwrap();
        let candidate = serde_json::json!({"projects": [], "candidate": true});
        let prepared = prepare_atomic_json_write(&target, &candidate).unwrap();
        let expected_candidate = prepared.serialized.clone();

        let exchanged = prepared.exchange(&mut target).unwrap();

        assert_eq!(fs::read(&target_path).unwrap(), expected_candidate);
        assert_eq!(
            exchanged.displaced.read_bytes().unwrap(),
            original,
            "the exchange must retain the exact bytes that occupied the target at its linearization point"
        );
        exchanged.displaced.discard();
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn displaced_read_stays_bound_to_the_entry_captured_by_exchange() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let target_path = root.join("companies/indigo/board.json");
        let original = fs::read(&target_path).unwrap();
        let resolved =
            resolve_project_write_path(&root, "companies/indigo/board.json", "board.json").unwrap();
        let mut target = ProjectWriteAnchor::open(&resolved).unwrap();
        let outside = root.with_extension("outside-secret.json");
        let outside_bytes = br#"{"tenant":"outside","secret":true}"#;
        fs::write(&outside, outside_bytes).unwrap();

        let candidate = serde_json::json!({"projects": [], "candidate": true});
        let prepared = prepare_atomic_json_write(&target, &candidate).unwrap();
        let exchanged = prepared.exchange(&mut target).unwrap();
        let displaced_path = exchanged.displaced.path.clone();
        let preserved_original = displaced_path.with_extension("original");

        fs::rename(&displaced_path, &preserved_original).unwrap();
        symlink(&outside, &displaced_path).unwrap();

        assert_eq!(
            exchanged.displaced.read_bytes().unwrap(),
            original,
            "a post-exchange path substitution must not redirect the displaced-byte read"
        );

        fs::remove_file(&displaced_path).unwrap();
        fs::remove_file(&preserved_original).unwrap();
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn displaced_regular_file_reader_refuses_symlinks() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let outside = root.with_extension("outside-secret.json");
        let alias = root.join("companies/indigo/.displaced-alias");
        fs::write(&outside, br#"{"tenant":"outside","secret":true}"#).unwrap();
        symlink(&outside, &alias).unwrap();

        let error = read_displaced_regular_file(&alias).unwrap_err();
        assert!(
            error.contains("could not read displaced project JSON"),
            "the refusal should retain an actionable displaced-file error: {error}"
        );

        let _ = fs::remove_file(&alias);
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn displaced_regular_file_reader_refuses_non_files() {
        let root = make_fixture_tree();
        let directory = root.join("companies/indigo/displaced-directory");
        fs::create_dir(&directory).unwrap();

        let error = read_displaced_regular_file(&directory).unwrap_err();
        assert!(
            error.contains("not a regular"),
            "the refusal should distinguish a non-file displaced entry: {error}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_atomic_exchange_prepares_temp_before_the_swap() {
        let root = make_fixture_tree();
        let board_path = root.join("companies/indigo/board.json");
        set_project_write_before_commit_hook({
            let board_path = board_path.clone();
            move || {
                let target_name = board_path.file_name().unwrap().to_string_lossy();
                let temp_prefix = format!(".{target_name}.");
                let has_prepared_temp = fs::read_dir(board_path.parent().unwrap())
                    .unwrap()
                    .filter_map(Result::ok)
                    .any(|entry| {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        name.starts_with(&temp_prefix) && name.ends_with(".tmp")
                    });
                assert!(
                    has_prepared_temp,
                    "the durable temp file must exist before the atomic exchange"
                );
            }
        });

        write_project_status(
            &root,
            "companies/indigo/board.json",
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        )
        .unwrap();

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_project_status_writes_preserve_both_mutations() {
        let root = make_fixture_tree();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut writers = Vec::new();

        for (project_id, prd_path, status) in [
            (
                "in-proj-001",
                "companies/indigo/projects/flagship/prd.json",
                "completed",
            ),
            (
                "in-proj-002",
                "companies/indigo/projects/missing/prd.json",
                "planned",
            ),
        ] {
            let root = root.clone();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                set_project_write_start_hook(move || {
                    barrier.wait();
                });
                write_project_status(
                    &root,
                    "companies/indigo/board.json",
                    project_id,
                    Some(prd_path),
                    status,
                )
            }));
        }

        for writer in writers {
            writer.join().expect("writer thread panicked").unwrap();
        }

        let board: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("companies/indigo/board.json")).unwrap())
                .unwrap();
        let projects = board["projects"].as_array().unwrap();
        let status = |id: &str| {
            projects
                .iter()
                .find(|project| project["id"] == id)
                .and_then(|project| project["status"].as_str())
                .unwrap()
        };
        assert_eq!(status("in-proj-001"), "completed");
        assert_eq!(status("in-proj-002"), "planned");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_story_pass_writes_preserve_both_mutations() {
        let root = make_fixture_tree();
        let prd_rel = "companies/indigo/projects/flagship/prd.json";
        fs::write(
            root.join(prd_rel),
            r#"{"userStories":[{"id":"US-001","passes":false},{"id":"US-002","passes":false}]}"#,
        )
        .unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut writers = Vec::new();
        for story_id in ["US-001", "US-002"] {
            let root = root.clone();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                set_project_write_start_hook(move || {
                    barrier.wait();
                });
                write_story_passes(
                    &root,
                    "companies/indigo/projects/flagship/prd.json",
                    story_id,
                    true,
                )
            }));
        }

        for writer in writers {
            writer.join().expect("writer thread panicked").unwrap();
        }

        let prd: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(prd_rel)).unwrap()).unwrap();
        let stories = prd["userStories"].as_array().unwrap();
        assert!(
            stories
                .iter()
                .all(|story| story["passes"].as_bool() == Some(true)),
            "both concurrent story mutations must survive: {stories:#?}",
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_status_write_preserves_an_external_edit_before_commit() {
        let root = make_fixture_tree();
        let board_path = root.join("companies/indigo/board.json");
        set_project_write_before_commit_hook({
            let board_path = board_path.clone();
            move || {
                let mut board: serde_json::Value =
                    serde_json::from_slice(&fs::read(&board_path).unwrap()).unwrap();
                board["external_sync_marker"] = serde_json::Value::Bool(true);
                fs::write(&board_path, serde_json::to_vec_pretty(&board).unwrap()).unwrap();
            }
        });

        write_project_status(
            &root,
            "companies/indigo/board.json",
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        )
        .unwrap();

        let board: serde_json::Value =
            serde_json::from_slice(&fs::read(&board_path).unwrap()).unwrap();
        assert_eq!(board["external_sync_marker"], true);
        let project = board["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|project| project["id"] == "in-proj-001")
            .unwrap();
        assert_eq!(project["status"], "completed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn story_pass_write_preserves_an_external_edit_before_commit() {
        let root = make_fixture_tree();
        let prd_path = root.join("companies/indigo/projects/flagship/prd.json");
        set_project_write_before_commit_hook({
            let prd_path = prd_path.clone();
            move || {
                let mut prd: serde_json::Value =
                    serde_json::from_slice(&fs::read(&prd_path).unwrap()).unwrap();
                prd["metadata"]["externalSync"] = serde_json::Value::Bool(true);
                fs::write(&prd_path, serde_json::to_vec_pretty(&prd).unwrap()).unwrap();
            }
        });

        write_story_passes(
            &root,
            "companies/indigo/projects/flagship/prd.json",
            "US-003",
            true,
        )
        .unwrap();

        let prd: serde_json::Value = serde_json::from_slice(&fs::read(&prd_path).unwrap()).unwrap();
        assert_eq!(prd["metadata"]["externalSync"], true);
        let story = prd["userStories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|story| story["id"] == "US-003")
            .unwrap();
        assert_eq!(story["passes"], true);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_write_preserves_an_external_edit_at_the_exchange_boundary() {
        let root = make_fixture_tree();
        let board_path = root.join("companies/indigo/board.json");
        set_project_write_at_exchange_hook({
            let board_path = board_path.clone();
            move || {
                let mut board: serde_json::Value =
                    serde_json::from_slice(&fs::read(&board_path).unwrap()).unwrap();
                board["exchange_boundary_marker"] = serde_json::Value::Bool(true);
                fs::write(&board_path, serde_json::to_vec_pretty(&board).unwrap()).unwrap();
            }
        });

        write_project_status(
            &root,
            "companies/indigo/board.json",
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        )
        .unwrap();

        let board: serde_json::Value =
            serde_json::from_slice(&fs::read(&board_path).unwrap()).unwrap();
        assert_eq!(
            board["exchange_boundary_marker"], true,
            "an edit arriving after the last preflight read must be merged, not overwritten"
        );
        let project = board["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|project| project["id"] == "in-proj-001")
            .unwrap();
        assert_eq!(project["status"], "completed");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn project_exchange_cannot_be_redirected_by_a_parent_swap() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let authorized_dir = root.join("companies/indigo");
        let unauthorized_dir = root.join("companies/pending");
        fs::create_dir_all(&unauthorized_dir).unwrap();
        let unauthorized_board = unauthorized_dir.join("board.json");
        let unauthorized_original = br#"{"tenant":"pending","projects":[]}"#.to_vec();
        fs::write(&unauthorized_board, &unauthorized_original).unwrap();

        set_project_write_at_exchange_hook({
            let root = root.clone();
            let authorized_dir = authorized_dir.clone();
            let unauthorized_dir = unauthorized_dir.clone();
            move || {
                let temp_name = fs::read_dir(&authorized_dir)
                    .unwrap()
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name())
                    .find(|name| {
                        let name = name.to_string_lossy();
                        name.starts_with(".board.json.") && name.ends_with(".tmp")
                    })
                    .expect("prepared board temp");
                fs::copy(
                    authorized_dir.join(&temp_name),
                    unauthorized_dir.join(&temp_name),
                )
                .unwrap();
                fs::rename(&authorized_dir, root.join("companies/indigo-original")).unwrap();
                symlink(&unauthorized_dir, &authorized_dir).unwrap();
            }
        });

        let _ = write_project_status(
            &root,
            "companies/indigo/board.json",
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        );

        assert_eq!(
            fs::read(&unauthorized_board).unwrap(),
            unauthorized_original,
            "the pending-company board must never be exchanged"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_write_preserves_an_unparseable_displaced_version_for_recovery() {
        let root = make_fixture_tree();
        let board_path = root.join("companies/indigo/board.json");
        let external_bytes = b"{ external writer left incomplete JSON".to_vec();
        set_project_write_at_exchange_hook({
            let board_path = board_path.clone();
            let external_bytes = external_bytes.clone();
            move || fs::write(&board_path, external_bytes).unwrap()
        });

        let error = write_project_status(
            &root,
            "companies/indigo/board.json",
            "in-proj-001",
            Some("companies/indigo/projects/flagship/prd.json"),
            "completed",
        )
        .unwrap_err();

        assert!(
            error.contains("newest displaced version was preserved at"),
            "the recovery location must be actionable: {error}"
        );
        let preserved = fs::read_dir(board_path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| fs::read(entry.path()).ok().as_deref() == Some(external_bytes.as_slice()))
            .expect("the exact unparseable external version must remain on disk");
        assert_ne!(preserved.path(), board_path);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn project_readers_reject_cross_company_and_outside_symlink_aliases() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let outside = root.with_extension("outside");
        fs::create_dir_all(root.join("companies/active/projects/alias")).unwrap();
        fs::create_dir_all(root.join("companies/active/projects/readme")).unwrap();
        fs::create_dir_all(root.join("companies/pending/projects/secret")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        fs::write(
            root.join("companies/pending/projects/secret/prd.json"),
            r#"{"name":"Pending secret","userStories":[]}"#,
        )
        .unwrap();
        symlink(
            root.join("companies/pending/projects/secret/prd.json"),
            root.join("companies/active/projects/alias/prd.json"),
        )
        .unwrap();
        assert!(
            read_project_prd(&root, "companies/active/projects/alias/prd.json").is_err(),
            "an active-company alias must not read a different company's PRD",
        );

        fs::write(
            root.join("companies/active/projects/readme/prd.json"),
            r#"{"name":"Safe","userStories":[]}"#,
        )
        .unwrap();
        fs::write(outside.join("README.md"), "outside secret").unwrap();
        symlink(
            outside.join("README.md"),
            root.join("companies/active/projects/readme/README.md"),
        )
        .unwrap();
        assert!(
            read_project_readme(&root, "companies/active/projects/readme/prd.json",).is_err(),
            "a README alias must not escape the HQ root",
        );

        fs::create_dir_all(root.join("companies/active")).unwrap();
        fs::create_dir_all(root.join("companies/pending")).unwrap();
        fs::write(
            root.join("companies/pending/board.json"),
            r#"{"objectives":[{"id":"secret"}],"initiatives":[]}"#,
        )
        .unwrap();
        symlink(
            root.join("companies/pending/board.json"),
            root.join("companies/active/board.json"),
        )
        .unwrap();
        assert!(
            read_company_goals(&root, "active").is_err(),
            "goals must not follow a board alias into another company",
        );

        fs::write(outside.join("crm-projection.json"), r#"{"secret":true}"#).unwrap();
        symlink(
            outside.join("crm-projection.json"),
            root.join("companies/active/crm-projection.json"),
        )
        .unwrap();
        assert!(
            read_crm_projection(&root, "active").is_err(),
            "CRM must not follow a projection alias outside HQ",
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn project_writers_refuse_symlink_targets_and_symlinked_parents() {
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        let outside = root.with_extension("writer-outside");
        fs::create_dir_all(root.join("companies/active/projects")).unwrap();
        fs::create_dir_all(outside.join("project")).unwrap();

        let outside_board = outside.join("board.json");
        fs::write(
            &outside_board,
            r#"{"projects":[{"id":"p1","status":"active"}]}"#,
        )
        .unwrap();
        symlink(&outside_board, root.join("companies/active/board.json")).unwrap();
        let board_before = fs::read(&outside_board).unwrap();
        assert!(
            write_project_status(&root, "companies/active/board.json", "p1", None, "complete",)
                .is_err(),
            "a board.json symlink must be refused",
        );
        assert_eq!(
            fs::read(&outside_board).unwrap(),
            board_before,
            "the external board must not be mutated",
        );

        fs::write(
            outside.join("project/prd.json"),
            r#"{"userStories":[{"id":"US-001","passes":false}]}"#,
        )
        .unwrap();
        symlink(
            outside.join("project"),
            root.join("companies/active/projects/escape"),
        )
        .unwrap();
        let prd_before = fs::read(outside.join("project/prd.json")).unwrap();
        assert!(
            write_story_passes(
                &root,
                "companies/active/projects/escape/prd.json",
                "US-001",
                true,
            )
            .is_err(),
            "a symlinked parent directory must be refused",
        );
        assert_eq!(
            fs::read(outside.join("project/prd.json")).unwrap(),
            prd_before,
            "the external PRD must not be mutated",
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn scoped_project_scan_filters_before_following_company_aliases() {
        use std::collections::HashSet;
        use std::os::unix::fs::symlink;

        let root = make_fixture_tree();
        symlink(
            root.join("companies/acme"),
            root.join("companies/acme-alias"),
        )
        .unwrap();

        let allowed = HashSet::from(["indigo".to_string(), "acme-alias".to_string()]);
        let projects = scan_local_projects_for_companies(&root, &allowed);

        assert!(
            projects.iter().all(|project| project.company == "indigo"),
            "only the canonical authorized company should be scanned: {projects:#?}",
        );
        assert!(
            projects
                .iter()
                .all(|project| project.company != "acme-alias"),
            "a company-directory alias must not create a second tenant identity",
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn now_iso8601_is_well_formed() {
        let s = now_iso8601();
        // YYYY-MM-DDTHH:MM:SSZ → 20 chars.
        assert_eq!(s.len(), 20, "got: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
