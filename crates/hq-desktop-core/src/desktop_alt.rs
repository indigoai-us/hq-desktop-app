//! Pure desktop-alt data types, parsers, validators, and local file helpers.
//!
//! This module intentionally contains no Tauri commands and no async network
//! layer. The app crate owns request execution and window lifecycle; this crate
//! owns the synchronous desktop-alt contract surface.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::config::{read_hq_config_lenient, MenubarPrefs};
use crate::ignore::MAX_FILE_BYTES;
use crate::paths;
use crate::workspaces::{Workspace, WorkspaceState};

const HQ_DEPLOY_APP_DOMAIN: &str = "indigo-hq.com";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignee_initials: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub age: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyBoard {
    #[serde(default)]
    pub inbox: Vec<BoardCard>,
    #[serde(default)]
    pub doing: Vec<BoardCard>,
    #[serde(default)]
    pub review: Vec<BoardCard>,
    #[serde(default)]
    pub done: Vec<BoardCard>,
}

impl CompanyBoard {
    /// Total cards across every column — the board count shown in the
    /// Company header and tab badge.
    pub fn card_count(&self) -> u32 {
        let total = self.inbox.len() + self.doing.len() + self.review.len() + self.done.len();
        u32::try_from(total).unwrap_or(u32::MAX)
    }
}

impl CompanyActivity {
    /// Activity in the last 7 days. The vault activity payload already
    /// rolls this up as `stats.files7` (files touched in the trailing 7
    /// days); we surface that directly as the header's `last7d` count.
    pub fn last7d(&self) -> u32 {
        self.stats.files7
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyActivity {
    #[serde(default)]
    pub stats: ActivityStats,
    #[serde(default)]
    pub sparkline: Vec<u32>,
    #[serde(default)]
    pub recent: Vec<ActivityEntry>,
    #[serde(default)]
    pub top: Vec<ActivityContributor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    #[serde(default)]
    pub files7: u32,
    #[serde(default)]
    pub edits7: u32,
    #[serde(default)]
    pub members: u32,
    #[serde(default)]
    pub vault_size: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    #[serde(default)]
    pub who: String,
    #[serde(default)]
    pub what: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub when: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityContributor {
    #[serde(default)]
    pub who: String,
    #[serde(default)]
    pub edits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentEntry {
    pub sub: String,
    pub url: String,
    pub state: String,
    pub last_deploy: String,
    pub size: String,
    pub ver: String,
    pub pwd: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecretItem {
    pub key: String,
    pub upd: String,
    pub rot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecretEnv {
    pub env: String,
    pub count: usize,
    pub items: Vec<SecretItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBoardModel {
    #[serde(default)]
    pub projects: Vec<LiveBoardProject>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBoardProject {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub uid: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assignee_initials: Option<String>,
    #[serde(default)]
    pub assignee: Option<LiveBoardAssignee>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    #[serde(rename = "type")]
    pub source_type: Option<String>,
    #[serde(default)]
    pub project_type: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub age: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBoardAssignee {
    #[serde(default)]
    pub initials: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyActivitySummary {
    pub last7d: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanySummary {
    pub board: u32,
    pub activity: CompanyActivitySummary,
    pub deployments: u32,
    pub secrets: u32,
}
/// Collapse a per-surface command result into the count for the summary.
/// Auth-required errors propagate (so the UI routes to sign-in); every
/// other error degrades to `0` for that surface so the rest still render.
pub fn summary_count_or_auth(result: Result<u32, String>) -> Result<u32, String> {
    match result {
        Ok(count) => Ok(count),
        Err(err) if is_auth_required_error(&err) => Err(err),
        Err(_) => Ok(0),
    }
}

pub fn is_auth_required_error(err: &str) -> bool {
    err.starts_with("AUTH_REQUIRED:")
}
/// Parse the vault CRM-projection response. Auth failures propagate; a missing
/// projection / not-provisioned / 404 / empty body / non-2xx all degrade to JSON
/// `null` (the calm empty state). Only a 2xx with malformed JSON errors.
pub fn parse_crm_projection_response(
    status: StatusCode,
    text: &str,
) -> Result<serde_json::Value, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: crm-projection (HTTP {status})"));
    }
    if !status.is_success() {
        // Not-provisioned, route-not-deployed-yet, or any other non-auth error:
        // fall back to the empty state rather than surfacing a hard error.
        return Ok(serde_json::Value::Null);
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|e| format!("crm-projection parse: {e}"))
}

/// Per-project attribution for Projects surfaces. The legacy command/type name
/// remains for compatibility, while optional owner/origin fields extend the
/// established creator row without breaking older webviews.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreator {
    pub id: String,
    pub prd_path: Option<String>,
    /// Kept as a string for the original command contract; empty when the row
    /// is retained for owner/origin but no displayable creator exists.
    pub creator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BoardCreatorEnvelope {
    #[serde(default)]
    pub projects: Vec<BoardCreatorProject>,
}

#[derive(Debug, Deserialize)]
pub struct BoardCreatorProject {
    #[serde(default)]
    pub id: String,
    #[serde(default, rename = "prdPath")]
    pub prd_path: Option<String>,
    #[serde(
        default,
        rename = "createdByName",
        alias = "creatorName",
        alias = "creator"
    )]
    pub created_by_name: Option<serde_json::Value>,
    #[serde(default, rename = "owner", alias = "ownerName", alias = "owner_name")]
    pub owner: Option<serde_json::Value>,
    #[serde(default, rename = "origin", alias = "source")]
    pub origin: Option<serde_json::Value>,
}

fn attribution_label(value: &Option<serde_json::Value>, keys: &[&str]) -> Option<String> {
    let value = value.as_ref()?;
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

/// Pure parse of cloud board JSON into backward-compatible attribution rows.
/// Rows with no displayable creator, owner, or origin are omitted.
pub fn parse_project_creators(text: &str) -> Result<Vec<ProjectCreator>, String> {
    let env: BoardCreatorEnvelope = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(env
        .projects
        .into_iter()
        .filter_map(|p| {
            let creator = attribution_label(
                &p.created_by_name,
                &[
                    "displayName",
                    "display_name",
                    "name",
                    "email",
                    "handle",
                    "label",
                ],
            );
            let owner = attribution_label(
                &p.owner,
                &[
                    "displayName",
                    "display_name",
                    "name",
                    "email",
                    "handle",
                    "label",
                ],
            );
            let origin =
                attribution_label(&p.origin, &["label", "name", "type", "provider", "source"]);
            if creator.is_none() && owner.is_none() && origin.is_none() {
                return None;
            }
            Some(ProjectCreator {
                id: p.id,
                prd_path: p.prd_path,
                creator: creator.unwrap_or_default(),
                owner,
                origin,
            })
        })
        .collect())
}
pub fn normalize_slug(slug: &str) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("company slug is required".to_string());
    }
    Ok(slug.to_string())
}
pub fn resolve_company_uid_from_workspaces(
    workspaces: Vec<Workspace>,
    slug: &str,
) -> Result<String, String> {
    let workspace = workspaces
        .into_iter()
        .find(|workspace| workspace.slug == slug)
        .ok_or_else(|| format!("company '{slug}' was not found"))?;
    if workspace.state == WorkspaceState::Broken {
        let reason = workspace
            .broken_reason
            .as_deref()
            .unwrap_or("workspace cloud mapping is broken");
        if let Some(live_cloud_uid) = live_cloud_uid_from_broken_reason(reason) {
            return Ok(live_cloud_uid);
        }
        return Err(format!("company '{slug}' is not synced: {reason}"));
    }
    if !matches!(
        workspace.state,
        WorkspaceState::Synced | WorkspaceState::CloudOnly
    ) {
        return Err(format!(
            "company '{slug}' is not synced (state: {:?})",
            workspace.state
        ));
    }
    workspace
        .cloud_uid
        .ok_or_else(|| format!("company '{slug}' is not connected to cloud"))
}

/// Machine-readable codes for company-UID resolution failures on the Board
/// read path. `resolve_company_uid_from_workspaces` errors run BEFORE
/// `parse_board_response` gets a chance to gracefully degrade, so without a
/// well-known prefix the raw diagnostic ("company 'x' is not synced: manifest
/// cloud_uid … not found in your cloud memberships") leaks verbatim into the
/// board panel. The frontend maps these codes to calm copy and keeps the raw
/// detail (everything after the `{code}: ` prefix) for logs only.
pub const COMPANY_NOT_FOUND_CODE: &str = "COMPANY_NOT_FOUND";
pub const COMPANY_NOT_SYNCED_CODE: &str = "COMPANY_NOT_SYNCED";
pub const COMPANY_NOT_CONNECTED_CODE: &str = "COMPANY_NOT_CONNECTED";

/// Classify a `resolve_company_uid_from_workspaces` error string into one of
/// the well-known company-resolution codes. Returns `None` for anything that
/// is not a resolution failure (auth, HTTP, parse errors) so those keep their
/// existing shape.
pub fn classify_company_resolution_error(error: &str) -> Option<&'static str> {
    if !error.starts_with("company '") {
        return None;
    }
    if error.ends_with("' was not found") {
        return Some(COMPANY_NOT_FOUND_CODE);
    }
    if error.contains("' is not synced") {
        return Some(COMPANY_NOT_SYNCED_CODE);
    }
    if error.ends_with("' is not connected to cloud") {
        return Some(COMPANY_NOT_CONNECTED_CODE);
    }
    None
}

/// Prefix a company-resolution failure with its machine-readable code
/// (`COMPANY_NOT_SYNCED: company 'x' is not synced: …`) so the frontend can
/// render a calm state instead of the raw diagnostic. Non-resolution errors
/// pass through unchanged.
pub fn prefix_company_resolution_error(error: String) -> String {
    match classify_company_resolution_error(&error) {
        Some(code) => format!("{code}: {error}"),
        None => error,
    }
}

pub fn live_cloud_uid_from_broken_reason(reason: &str) -> Option<String> {
    let reason = reason.strip_prefix("manifest cloud_uid ")?;
    let (manifest_uid, reason) = reason.split_once(" does not match cloud entity ")?;
    let live_uid = reason.strip_suffix(" for this slug")?;
    if manifest_uid.is_empty()
        || live_uid.is_empty()
        || manifest_uid == live_uid
        || !is_url_safe_id(live_uid)
    {
        return None;
    }
    Some(live_uid.to_string())
}
pub fn board_url(base: &str, company_uid: &str) -> Result<String, String> {
    if !is_url_safe_id(company_uid) {
        return Err(format!(
            "company uid has invalid characters: {company_uid:?}"
        ));
    }
    Ok(format!(
        "{}/companies/{}/board",
        base.trim_end_matches('/'),
        company_uid
    ))
}

pub fn crm_projection_url(base: &str, company_uid: &str) -> Result<String, String> {
    if !is_url_safe_id(company_uid) {
        return Err(format!(
            "company uid has invalid characters: {company_uid:?}"
        ));
    }
    Ok(format!(
        "{}/companies/{}/crm-projection",
        base.trim_end_matches('/'),
        company_uid
    ))
}

pub fn activity_url(base: &str, company_uid: &str) -> Result<String, String> {
    if !is_url_safe_id(company_uid) {
        return Err(format!(
            "company uid has invalid characters: {company_uid:?}"
        ));
    }
    Ok(format!(
        "{}/companies/{}/activity",
        base.trim_end_matches('/'),
        company_uid
    ))
}

/// Build the hq-deploy URL for the company Deployments panel.
///
/// Uses the ORG-scoped `GET /api/apps` (not the personal `GET /api/apps/me`).
/// The panel is a *company* dashboard: it must show every app in the org —
/// the same set the `hq deploy` CLI and the console table show — not just the
/// apps owned by the signed-in caller. `/api/apps/me` post-filters server-side
/// to `ownerId === userId`, so for a member viewing co-collaborators' apps it
/// returns `{"apps":[]}` (HTTP 200, empty) and the panel rendered 0 even when
/// the org has live deployments. Org scoping comes from the `x-org-slug`
/// header the caller already sends; the response shape is byte-identical
/// (`{"apps":[…]}`, no `orgSlug` on rows), so the parser is unchanged.
pub fn deployments_url(base: &str) -> String {
    format!("{}/api/apps", base.trim_end_matches('/'))
}

pub fn secrets_url(base: &str, company_uid: &str) -> Result<String, String> {
    if !is_url_safe_id(company_uid) {
        return Err(format!(
            "company uid has invalid characters: {company_uid:?}"
        ));
    }
    Ok(format!(
        "{}/secrets/{}",
        base.trim_end_matches('/'),
        company_uid
    ))
}

pub fn parse_board_response(status: StatusCode, text: &str) -> Result<CompanyBoard, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: board (HTTP {status})"));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(CompanyBoard::default());
    }
    if status == StatusCode::NOT_FOUND {
        return if is_board_not_provisioned(text) {
            eprintln!("[desktop-alt] board 404 not-provisioned -> empty board: {text}");
            Ok(CompanyBoard::default())
        } else {
            Err(format!("board HTTP {status}: {text}"))
        };
    }
    if !status.is_success() {
        return Err(format!("board HTTP {status}: {text}"));
    }

    let text = text.trim();
    if text.is_empty() {
        eprintln!("[desktop-alt] board {status} empty body -> empty board");
        return Ok(CompanyBoard::default());
    }

    parse_company_board(text)
}

pub fn parse_project_creators_response(
    status: StatusCode,
    text: &str,
) -> Result<Vec<ProjectCreator>, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: creators (HTTP {status})"));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(Vec::new());
    }
    if status == StatusCode::NOT_FOUND {
        return if is_board_not_provisioned(text) {
            eprintln!("[desktop-alt] creators 404 not-provisioned -> no cloud attribution: {text}");
            Ok(Vec::new())
        } else {
            Err(format!("creators HTTP {status}: {text}"))
        };
    }
    if !status.is_success() {
        return Err(format!("creators HTTP {status}: {text}"));
    }

    let text = text.trim();
    if text.is_empty() {
        eprintln!("[desktop-alt] creators {status} empty body -> no cloud attribution");
        return Ok(Vec::new());
    }

    parse_project_creators(text).map_err(|error| format!("creators parse: {error}"))
}

pub fn parse_activity_response(status: StatusCode, text: &str) -> Result<CompanyActivity, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: activity (HTTP {status})"));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(CompanyActivity::default());
    }
    if status == StatusCode::NOT_FOUND {
        return if is_activity_not_provisioned(text) {
            eprintln!("[desktop-alt] activity 404 not-provisioned -> empty activity: {text}");
            Ok(CompanyActivity::default())
        } else {
            Err(format!("activity HTTP {status}: {text}"))
        };
    }
    if !status.is_success() {
        return Err(format!("activity HTTP {status}: {text}"));
    }

    let text = text.trim();
    if text.is_empty() {
        eprintln!("[desktop-alt] activity {status} empty body -> empty activity");
        return Ok(CompanyActivity::default());
    }

    parse_company_activity(text)
}

pub fn parse_company_board(text: &str) -> Result<CompanyBoard, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("board parse: {e}"))?;
    if value.get("projects").and_then(|v| v.as_array()).is_some() {
        let live: LiveBoardModel =
            serde_json::from_value(value).map_err(|e| format!("board parse: {e}"))?;
        return Ok(live.into_company_board());
    }
    serde_json::from_value(value).map_err(|e| format!("board parse: {e}"))
}

pub fn parse_company_activity(text: &str) -> Result<CompanyActivity, String> {
    serde_json::from_str(text).map_err(|e| format!("activity parse: {e}"))
}

pub fn parse_secrets_response(status: StatusCode, text: &str) -> Result<Vec<SecretEnv>, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: secrets (HTTP {status})"));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(Vec::new());
    }
    if status == StatusCode::NOT_FOUND {
        return if is_secrets_not_provisioned(text) {
            eprintln!("[desktop-alt] secrets 404 not-provisioned -> empty secrets");
            Ok(Vec::new())
        } else {
            Err(format!("secrets HTTP {status}"))
        };
    }
    if !status.is_success() {
        return Err(format!("secrets HTTP {status}"));
    }

    let text = text.trim();
    if text.is_empty() {
        eprintln!("[desktop-alt] secrets {status} empty body -> empty secrets");
        return Ok(Vec::new());
    }

    parse_secret_envs(text)
}

pub fn parse_secret_envs(text: &str) -> Result<Vec<SecretEnv>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("secrets parse: {e}"))?;

    // STRUCTURE-ONLY diagnostic: logs the JSON shape (top-level kind, top-level
    // object key names, candidate array lengths, and the FIRST row's key names)
    // so a real-response shape mismatch is observable. NEVER logs any value —
    // only the *names* of keys and the *lengths* of arrays. Secret values must
    // never reach a log (see e2e/desktop-alt/secrets-never-leak.spec.ts).
    eprintln!(
        "[desktop-alt] secrets structure: {}",
        secret_structure_summary(&value)
    );

    let rows =
        secret_rows(&value).ok_or_else(|| "secrets parse: missing secrets array".to_string())?;
    let mut grouped: BTreeMap<String, Vec<SecretItem>> = BTreeMap::new();

    for row in rows {
        let Some(raw_key) = secret_key(row) else {
            continue;
        };
        let (env, key) = secret_env_and_key(row, &raw_key);
        grouped.entry(env).or_default().push(SecretItem {
            key,
            upd: secret_updated_at(row),
            rot: secret_rotation(row),
        });
    }

    Ok(grouped
        .into_iter()
        .map(|(env, mut items)| {
            items.sort_by(|a, b| a.key.cmp(&b.key));
            SecretEnv {
                env,
                count: items.len(),
                items,
            }
        })
        .collect())
}

/// Build a values-free description of a secrets JSON payload for diagnostics.
///
/// Reveals the top-level kind, top-level object key names, the lengths of the
/// candidate arrays `secret_rows` probes, and the key names present on the
/// first row of whichever array is found. It deliberately emits only key
/// *names* and array *lengths* — never a value, string contents, or anything
/// derived from a secret — so it is safe to write to stderr.
pub fn secret_structure_summary(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Array(rows) => {
            format!(
                "top-level array (len={}); first-row keys=[{}]",
                rows.len(),
                first_row_key_names(rows.first())
            )
        }
        serde_json::Value::Object(map) => {
            let top_keys: Vec<&str> = map.keys().map(String::as_str).collect();
            // Lengths of the arrays `secret_rows` knows how to read, so a
            // "found the envelope but it's empty/elsewhere" case is visible.
            let mut array_lens: Vec<String> = Vec::new();
            for path in ["secrets", "items", "data", "parameters", "body"] {
                if let Some(len) = map.get(path).and_then(|v| v.as_array()).map(Vec::len) {
                    array_lens.push(format!("{path}[]={len}"));
                }
            }
            let first_row_keys = secret_rows(value)
                .map(|rows| first_row_key_names(rows.first()))
                .unwrap_or_else(|| "<no array matched secret_rows>".to_string());
            format!(
                "top-level object; keys=[{}]; arrays=[{}]; first-row keys=[{}]",
                top_keys.join(","),
                array_lens.join(","),
                first_row_keys
            )
        }
        other => format!("top-level {} (not array/object)", json_kind(other)),
    }
}

/// Comma-joined key names of a JSON object row (names only, never values).
pub fn first_row_key_names(row: Option<&serde_json::Value>) -> String {
    match row {
        Some(serde_json::Value::Object(map)) => {
            map.keys().map(String::as_str).collect::<Vec<_>>().join(",")
        }
        Some(other) => format!("<row is {}>", json_kind(other)),
        None => "<empty>".to_string(),
    }
}

pub fn json_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

pub fn secret_rows(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if let Some(rows) = value.as_array() {
        return Some(rows);
    }
    value
        .get("secrets")
        .and_then(|v| v.as_array())
        .or_else(|| {
            value
                .get("body")
                .and_then(|body| body.get("secrets"))
                .and_then(|v| v.as_array())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| data.get("secrets"))
                .and_then(|v| v.as_array())
        })
        .or_else(|| value.get("items").and_then(|v| v.as_array()))
}

pub fn secret_key(value: &serde_json::Value) -> Option<String> {
    string_field(
        value,
        &[
            "key",
            "name",
            "path",
            "secretPath",
            "secretName",
            "parameterName",
        ],
    )
}

pub fn secret_env_and_key(value: &serde_json::Value, raw_key: &str) -> (String, String) {
    if let Some(env) = string_field(value, &["env", "environment", "stage"]) {
        return (env, raw_key.to_string());
    }

    let key = raw_key.trim_matches('/');
    if let Some((env, rest)) = key.split_once('/') {
        if !env.is_empty() && !rest.is_empty() {
            return (env.to_string(), rest.trim_start_matches('/').to_string());
        }
    }
    if let Some((env, rest)) = key.split_once(':') {
        if !env.is_empty() && !rest.is_empty() {
            return (env.to_string(), rest.to_string());
        }
    }

    ("default".to_string(), raw_key.to_string())
}

pub fn secret_updated_at(value: &serde_json::Value) -> String {
    string_field(
        value,
        &[
            "lastModifiedDate",
            "lastModified",
            "updatedAt",
            "modifiedAt",
            "createdAt",
        ],
    )
    .unwrap_or_else(|| "-".to_string())
}

pub fn secret_rotation(value: &serde_json::Value) -> String {
    string_field(
        value,
        &[
            "rotation",
            "rotationStatus",
            "rotationSchedule",
            "nextRotationDate",
            "rot",
        ],
    )
    .or_else(|| {
        bool_field(value, &["rotationEnabled"]).map(|enabled| {
            if enabled {
                "scheduled".to_string()
            } else {
                "manual".to_string()
            }
        })
    })
    .unwrap_or_else(|| "manual".to_string())
}

pub fn parse_deployments_response(
    status: StatusCode,
    text: &str,
    selected_slug: &str,
) -> Result<Vec<DeploymentEntry>, String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("AUTH_REQUIRED: deployments (HTTP {status})"));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(Vec::new());
    }
    if status == StatusCode::NOT_FOUND {
        return if is_deployments_not_provisioned(text) {
            eprintln!("[desktop-alt] deployments 404 not-provisioned -> empty deployments: {text}");
            Ok(Vec::new())
        } else {
            Err(format!("deployments HTTP {status}: {text}"))
        };
    }
    if !status.is_success() {
        return Err(format!("deployments HTTP {status}: {text}"));
    }

    let text = text.trim();
    if text.is_empty() {
        eprintln!("[desktop-alt] deployments {status} empty body -> empty deployments");
        return Ok(Vec::new());
    }

    parse_deployment_entries(text, selected_slug)
}

pub fn parse_deployment_entries(
    text: &str,
    selected_slug: &str,
) -> Result<Vec<DeploymentEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("deployments parse: {e}"))?;
    let rows = deployment_rows(&value)
        .ok_or_else(|| "deployments parse: missing apps array".to_string())?;

    // Per-row resilience: a single malformed app (unsafe subdomain/url, missing
    // subdomain, etc.) must NOT blank the entire panel. The org-scoped
    // `/api/apps` returns every app in the org, so one odd row would otherwise
    // collapse the whole list to an error and zero the Deployments count.
    // Skip+log the bad row and keep the rest. The log carries only the row's
    // subdomain/url shape (no secrets) — deployments are public hostnames.
    let mut entries = Vec::new();
    let mut skipped = 0usize;
    for row in rows
        .iter()
        .filter(|row| deployment_matches_selected_slug(row, selected_slug))
    {
        match deployment_entry_from_value(row) {
            Ok(entry) => entries.push(entry),
            Err(e) => {
                skipped += 1;
                eprintln!("[desktop-alt] deployments: skipping unparseable app row ({e})");
            }
        }
    }
    if skipped > 0 {
        eprintln!(
            "[desktop-alt] deployments: kept {} app(s), skipped {} unparseable",
            entries.len(),
            skipped
        );
    }
    Ok(entries)
}

pub fn deployment_rows(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if let Some(rows) = value.as_array() {
        return Some(rows);
    }
    value
        .get("apps")
        .and_then(|v| v.as_array())
        .or_else(|| value.get("deployments").and_then(|v| v.as_array()))
        .or_else(|| value.get("data").and_then(|v| v.as_array()))
}

pub fn deployment_entry_from_value(value: &serde_json::Value) -> Result<DeploymentEntry, String> {
    let sub = string_field(value, &["sub", "subdomain", "slug"])
        .or_else(|| string_field(value, &["url"]).and_then(|url| subdomain_from_url(&url)))
        .map(|sub| sub.to_ascii_lowercase())
        .ok_or_else(|| "deployments parse: app missing subdomain".to_string())?;
    if !is_safe_deployment_label(&sub) {
        return Err(format!(
            "deployments parse: app has unsafe subdomain: {sub:?}"
        ));
    }
    let url = match string_field(value, &["url"]) {
        Some(url) => normalize_deployment_host(&url)
            .ok_or_else(|| format!("deployments parse: app has unsafe url: {url:?}"))?,
        None => format!("{sub}.{HQ_DEPLOY_APP_DOMAIN}"),
    };

    Ok(DeploymentEntry {
        sub,
        url,
        state: normalize_deployment_state(value),
        last_deploy: deployment_last_deploy(value),
        size: deployment_size(value),
        ver: deployment_version(value),
        pwd: bool_field(
            value,
            &["pwd", "passwordProtected", "passwordLocked", "locked"],
        )
        .unwrap_or(false),
    })
}

pub fn deployment_matches_selected_slug(value: &serde_json::Value, selected_slug: &str) -> bool {
    deployment_org_slug(value)
        .map(|org_slug| org_slug == selected_slug)
        .unwrap_or(true)
}

pub fn deployment_org_slug(value: &serde_json::Value) -> Option<String> {
    string_field(value, &["orgSlug", "org_slug"]).or_else(|| {
        value.get("org").and_then(|org| {
            org.as_str()
                .map(|slug| slug.trim().to_string())
                .filter(|slug| !slug.is_empty())
                .or_else(|| string_field(org, &["slug", "orgSlug", "org_slug"]))
        })
    })
}

pub fn normalize_deployment_state(value: &serde_json::Value) -> String {
    if bool_field(value, &["active"]).is_some_and(|active| !active) {
        return "paused".to_string();
    }

    let status = string_field(value, &["deployStatus", "status", "state", "dnsStatus"])
        .or_else(|| nested_string_field(value, "latestDeploy", &["status", "state"]))
        .or_else(|| nested_string_field(value, "deploy", &["status", "state"]));
    match normalize_status(status.as_deref()).as_deref() {
        Some(
            "uploading" | "extracting" | "syncing" | "invalidating" | "building" | "pushing"
            | "deploying" | "stabilizing" | "pending" | "inprogress" | "in_progress" | "running",
        ) => "deploying".to_string(),
        Some("paused" | "disabled" | "suspended" | "inactive" | "deactivated" | "stopped") => {
            "paused".to_string()
        }
        Some("active" | "live" | "ready" | "healthy" | "deployed" | "complete" | "completed") => {
            "active".to_string()
        }
        _ => "paused".to_string(),
    }
}

pub fn deployment_last_deploy(value: &serde_json::Value) -> String {
    string_field(
        value,
        &[
            "lastDeploy",
            "lastDeployedAt",
            "deployedAt",
            "updatedAt",
            "createdAt",
        ],
    )
    .or_else(|| nested_string_field(value, "latestDeploy", &["updatedAt", "createdAt"]))
    .and_then(|timestamp| format_deployment_age(&timestamp, Utc::now()))
    .unwrap_or_else(|| "Never".to_string())
}

pub fn deployment_size(value: &serde_json::Value) -> String {
    string_field(value, &["size", "storage", "artifactSize"])
        .or_else(|| {
            number_field(value, &["sizeBytes", "bytes", "artifactSizeBytes"])
                .or_else(|| nested_number_field(value, "manifest", &["size", "sizeBytes"]))
                .or_else(|| nested_number_field(value, "latestDeploy", &["size", "sizeBytes"]))
                .map(format_bytes)
        })
        .unwrap_or_else(|| "-".to_string())
}

pub fn deployment_version(value: &serde_json::Value) -> String {
    string_field(value, &["ver", "version", "latestVersion"])
        .or_else(|| nested_string_field(value, "latestDeploy", &["ver", "version"]))
        .or_else(|| {
            number_field(value, &["version", "latestVersion"])
                .or_else(|| nested_number_field(value, "latestDeploy", &["version"]))
                .map(|version| format!("v{version}"))
        })
        .map(|version| {
            let version = version.trim();
            if version.is_empty() {
                "-".to_string()
            } else if version.bytes().all(|b| b.is_ascii_digit()) {
                format!("v{version}")
            } else {
                version.to_string()
            }
        })
        .unwrap_or_else(|| "-".to_string())
}

pub fn is_board_not_provisioned(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return false;
    };
    json_code(&value)
        .map(|code| {
            matches!(
                code,
                "board-not-provisioned" | "board_not_provisioned" | "board-missing"
            )
        })
        .unwrap_or(false)
}

pub fn is_activity_not_provisioned(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return false;
    };
    json_code(&value)
        .map(|code| {
            matches!(
                code,
                "activity-not-provisioned"
                    | "activity_not_provisioned"
                    | "activity-missing"
                    | "activity_missing"
                    | "company-activity-missing"
                    | "company_activity_missing"
            )
        })
        .unwrap_or(false)
}

pub fn is_deployments_not_provisioned(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return true;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    json_code(&value)
        .map(|code| {
            matches!(
                code,
                "deployments-not-provisioned"
                    | "deployments_not_provisioned"
                    | "deployments-missing"
                    | "deployments_missing"
                    | "apps-not-provisioned"
                    | "apps_not_provisioned"
                    | "not-provisioned"
                    | "not_provisioned"
            )
        })
        .unwrap_or(false)
}

pub fn is_secrets_not_provisioned(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return true;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    json_code(&value)
        .map(|code| {
            matches!(
                code,
                "secrets-not-provisioned"
                    | "secrets_not_provisioned"
                    | "secrets-missing"
                    | "secrets_missing"
                    | "not-provisioned"
                    | "not_provisioned"
            )
        })
        .unwrap_or(false)
}

pub fn json_code(value: &serde_json::Value) -> Option<&str> {
    value.get("code").and_then(|v| v.as_str()).or_else(|| {
        value
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(|v| v.as_str())
    })
}

pub fn string_field(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value.get(*name).and_then(|v| {
            v.as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
    })
}

pub fn nested_string_field(value: &serde_json::Value, key: &str, names: &[&str]) -> Option<String> {
    value
        .get(key)
        .and_then(|nested| string_field(nested, names))
}

pub fn bool_field(value: &serde_json::Value, names: &[&str]) -> Option<bool> {
    names.iter().find_map(|name| {
        value.get(*name).and_then(|v| {
            v.as_bool().or_else(|| {
                v.as_str()
                    .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            })
        })
    })
}

pub fn number_field(value: &serde_json::Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| {
        value.get(*name).and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
    })
}

pub fn nested_number_field(value: &serde_json::Value, key: &str, names: &[&str]) -> Option<u64> {
    value
        .get(key)
        .and_then(|nested| number_field(nested, names))
}

pub fn normalize_deployment_host(url: &str) -> Option<String> {
    let mut host = url.trim();
    if host.is_empty() {
        return None;
    }
    host = host
        .strip_prefix("https://")
        .or_else(|| host.strip_prefix("http://"))
        .unwrap_or(host);
    let host = host
        .split('/')
        .next()
        .unwrap_or(host)
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    is_safe_deployment_host(&host).then_some(host)
}

pub fn subdomain_from_url(url: &str) -> Option<String> {
    let host = normalize_deployment_host(url)?;
    host.strip_suffix(&format!(".{HQ_DEPLOY_APP_DOMAIN}"))
        .map(str::to_string)
        .filter(|sub| !sub.is_empty())
}

pub fn is_safe_deployment_host(host: &str) -> bool {
    host.strip_suffix(&format!(".{HQ_DEPLOY_APP_DOMAIN}"))
        .is_some_and(|sub| is_safe_deployment_label(sub))
}

pub fn is_safe_deployment_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

pub fn format_deployment_age(value: &str, now: DateTime<Utc>) -> Option<String> {
    let parsed = DateTime::parse_from_rfc3339(value.trim())
        .ok()?
        .with_timezone(&Utc);
    let seconds = now.signed_duration_since(parsed).num_seconds().max(0);
    Some(if seconds < 60 {
        "just now".to_string()
    } else if seconds < 60 * 60 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 60 * 60 * 24 {
        format!("{}h ago", seconds / (60 * 60))
    } else if seconds < 60 * 60 * 24 * 30 {
        format!("{}d ago", seconds / (60 * 60 * 24))
    } else {
        parsed.format("%b %-d, %Y").to_string()
    })
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else if value >= 10.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

impl LiveBoardModel {
    pub fn into_company_board(self) -> CompanyBoard {
        let mut board = CompanyBoard::default();
        for project in self.projects {
            match project.status_column() {
                BoardColumn::Inbox => board.inbox.push(project.into_board_card()),
                BoardColumn::Doing => board.doing.push(project.into_board_card()),
                BoardColumn::Review => board.review.push(project.into_board_card()),
                BoardColumn::Done => board.done.push(project.into_board_card()),
            }
        }
        board
    }
}

pub enum BoardColumn {
    Inbox,
    Doing,
    Review,
    Done,
}

impl LiveBoardProject {
    pub fn status_column(&self) -> BoardColumn {
        match normalize_status(self.status.as_deref()).as_deref() {
            Some("active" | "doing" | "inprogress" | "in_progress") => BoardColumn::Doing,
            Some("review" | "inreview" | "in_review") => BoardColumn::Review,
            Some("done" | "complete" | "completed" | "shipped") => BoardColumn::Done,
            Some("inbox" | "backlog" | "todo" | "to_do") | _ => BoardColumn::Inbox,
        }
    }

    pub fn into_board_card(self) -> BoardCard {
        let title = self
            .title
            .clone()
            .or_else(|| self.name.clone())
            .unwrap_or_else(|| "Untitled project".to_string());
        let assignee_initials = self
            .assignee_initials
            .clone()
            .or_else(|| self.assignee.as_ref().and_then(|a| a.initials.clone()))
            .or_else(|| {
                self.assignee
                    .as_ref()
                    .and_then(|a| derive_initials(a.name.as_deref().or(a.email.as_deref())))
            });
        let tag = self
            .tag
            .clone()
            .or_else(|| self.project_type.clone())
            .or_else(|| self.source_type.clone())
            .or_else(|| self.kind.clone())
            .or_else(|| self.labels.first().cloned());
        let age = self
            .age
            .clone()
            .or_else(|| self.updated_at.as_deref().and_then(format_board_date))
            .or_else(|| self.created_at.as_deref().and_then(format_board_date))
            .or_else(|| self.updated_at.clone())
            .or_else(|| self.created_at.clone());

        BoardCard {
            id: self.uid.clone().or(self.id.clone()).unwrap_or_default(),
            title,
            subtitle: None,
            href: None,
            labels: self.labels,
            assignee_initials,
            tag,
            age,
            extra: self.extra,
        }
    }
}

pub fn normalize_status(status: Option<&str>) -> Option<String> {
    status.map(|s| {
        s.trim()
            .to_ascii_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect()
    })
}

pub fn derive_initials(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let initials: String = value
        .split(|c: char| c.is_whitespace() || c == '.' || c == '@' || c == '-' || c == '_')
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.chars().next())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (!initials.is_empty()).then_some(initials)
}

pub fn format_board_date(value: &str) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value.trim()).ok()?;
    Some(parsed.format("%b %-d, %Y").to_string())
}

/// Allows only `[a-zA-Z0-9._-]+` for a path segment without percent-encoding.
pub fn is_url_safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

// ---- Company file explorer (US-001) ---------------------------------------

/// A node in a company's local file tree. Directories carry `children`; files
/// have an empty `children` vec. `path` is HQ-folder-relative with forward
/// slashes so the frontend can pass it straight back to
/// `get_company_file_content`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// HQ-folder-relative path, forward-slash separated (e.g.
    /// `companies/indigo/policies/foo.md`).
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

/// Resolve the user's HQ folder using the standard 4-tier resolver (mirrors
/// `projects_local.rs::resolve_hq_folder`). desktop_alt.rs keeps its own copy
/// rather than reaching across modules for the private helper.
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

/// True iff `candidate`, after lexical normalization, is contained within
/// `root`. Rejects `..` traversal and absolute escapes WITHOUT touching the
/// filesystem (so it works on non-existent paths too). Each module in this repo
/// keeps its own copy (projects_local.rs / library_local.rs both do).
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
            Component::ParentDir => match stack.last() {
                Some(Component::Normal(_)) => {
                    stack.pop();
                }
                _ => stack.push(component),
            },
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for c in stack {
        out.push(c.as_os_str());
    }
    out
}

/// Validate and normalize the forward-slash HQ-relative path contract.
///
/// `allow_root` permits an empty path for the lazy explorer's HQ-root listing.
pub fn validate_hq_relative_path(rel_path: &str, allow_root: bool) -> Result<String, String> {
    let value = rel_path.trim();
    if value.is_empty() {
        return allow_root
            .then(String::new)
            .ok_or_else(|| "invalid HQ-relative path: path is required".to_string());
    }
    if value.starts_with('/') || value.contains('\\') || value.contains('\0') {
        return Err(format!("invalid HQ-relative path: {rel_path:?}"));
    }

    let mut segments: Vec<&str> = Vec::new();
    for segment in value.split('/') {
        match segment {
            "." => continue,
            "" | ".." => {
                return Err(format!("invalid HQ-relative path: {rel_path:?}"));
            }
            _ if segment.contains(':') => {
                // Reject Windows drive paths and alternate data streams on
                // every platform so the wire contract has one meaning.
                return Err(format!("invalid HQ-relative path: {rel_path:?}"));
            }
            _ => segments.push(segment),
        }
    }

    if segments.is_empty() {
        return allow_root
            .then(String::new)
            .ok_or_else(|| "invalid HQ-relative path: path is required".to_string());
    }
    Ok(segments.join("/"))
}

/// Resolve the company addressed by a valid HQ-relative path.
pub fn company_slug_for_hq_path(rel_path: &str) -> Result<Option<String>, String> {
    let normalized = validate_hq_relative_path(rel_path, true)?;
    let mut segments = normalized.split('/');
    if segments.next() != Some("companies") {
        return Ok(None);
    }
    Ok(segments
        .next()
        .filter(|slug| !slug.is_empty())
        .map(str::to_string))
}

/// Resolve an existing HQ-relative path through filesystem symlinks and return
/// its canonical HQ-relative spelling. The canonical target must remain under
/// the canonical HQ root.
pub fn canonical_hq_relative_path(
    hq_root: &Path,
    rel_path: &str,
    allow_root: bool,
) -> Result<String, String> {
    let normalized = validate_hq_relative_path(rel_path, allow_root)?;
    let candidate = if normalized.is_empty() {
        hq_root.to_path_buf()
    } else {
        hq_root.join(&normalized)
    };
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let canonical_candidate = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("could not resolve {rel_path:?}: {e}"))?;
    let relative = canonical_candidate
        .strip_prefix(&canonical_root)
        .map_err(|_| format!("path escapes the HQ folder: {rel_path:?}"))?;

    let mut segments: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| format!("path is not valid UTF-8: {rel_path:?}"))?;
                segments.push(value.to_string());
            }
            Component::CurDir => {}
            _ => return Err(format!("invalid canonical HQ path: {rel_path:?}")),
        }
    }
    if segments.is_empty() && !allow_root {
        return Err("invalid HQ-relative path: path is required".to_string());
    }
    Ok(segments.join("/"))
}

/// Whether a resolved company workspace grants local Files access.
pub fn workspace_grants_company_file_access(workspaces: &[Workspace], slug: &str) -> bool {
    let Some(workspace) = workspaces
        .iter()
        .find(|workspace| workspace.slug == slug && workspace.has_local_folder)
    else {
        return false;
    };

    match workspace.membership_status.as_deref() {
        Some("active") => true,
        // A genuinely local-only company is authored on this machine and has
        // no cloud identity to authorize. Cloud-bound folders fail closed
        // when live membership hydration is unavailable.
        None => workspace.state == WorkspaceState::LocalOnly && workspace.cloud_uid.is_none(),
        // Pending, paused, revoked, and future unknown statuses fail closed.
        Some(_) => false,
    }
}

/// Curated dev-noise exclusion set for the local file explorer.
///
/// These entry names are filtered out at **every level** of the tree so users
/// see meaningful company content instead of build/dependency/artifact noise.
/// This is the single source of truth for the filter — extend this list (and
/// `is_dev_noise` for pattern-based rules like dot-directories) to hide more.
///
/// Deliberately NOT excluded: `settings/`, `data/`, `workers/` — those are real
/// company content and stay visible in this local-only read viewer (only noise
/// is filtered, never company content; see PRD US-008). Dotfiles that are NOT
/// dot-*directories* (e.g. `.gitignore`, `.env.example`) also stay visible.
pub const DEV_NOISE_NAMES: &[&str] = &[
    // VCS / dependency / build / artifact directories.
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".svelte-kit",
    ".turbo",
    ".vercel",
    ".cache",
    "coverage",
    // OS cruft.
    ".DS_Store",
    "Thumbs.db",
    // Lockfiles.
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
];

/// True if a directory entry named `name` (with `is_dir` set for directories)
/// is curated dev noise that the explorer should hide at every level.
///
/// Matches the explicit [`DEV_NOISE_NAMES`] set, plus any *dot-directory*
/// (a directory whose name starts with `.`). Dot-*files* are intentionally kept
/// (e.g. `.gitignore`, `.env.example`) — only dot-directories are swept, since
/// they are overwhelmingly tooling/cache state rather than authored content.
pub fn is_dev_noise(name: &str, is_dir: bool) -> bool {
    if DEV_NOISE_NAMES.contains(&name) {
        return true;
    }
    // Other dot-directories (e.g. `.idea`, `.pytest_cache`) are noise too.
    is_dir && name.starts_with('.')
}

/// Build a nested file tree rooted at `companies/<slug>/` for the local file
/// explorer.
///
/// Visibility per product decision is **everything except curated dev noise**
/// ([`DEV_NOISE_NAMES`] + dot-directories) at every level — this is a local
/// viewer, NOT the sync surface, so `settings/`, `data/`, and `workers/` ARE
/// included (the sync ignore filter is deliberately not applied here).
/// Directories sort before files, each group alphabetically (case-insensitive).
/// traversal + `.git` exclusion + sort order are unit-testable without the gate.
pub fn build_file_tree(hq_root: &Path, slug: &str) -> Result<FileNode, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("company slug is required".to_string());
    }
    let rel = format!("companies/{slug}");
    let normalized = validate_hq_relative_path(&rel, false)?;
    if normalized != rel
        || company_slug_for_hq_path(&normalized)?.as_deref() != Some(slug)
        || normalized.split('/').count() != 2
    {
        return Err(format!("invalid company slug: {slug:?}"));
    }
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let canonical_rel = canonical_hq_relative_path(&canonical_root, &normalized, false)?;
    if canonical_rel != normalized {
        return Err(format!(
            "company folder resolves across HQ company boundaries: {slug:?}"
        ));
    }
    let root = canonical_root.join(&canonical_rel);
    if !root.is_dir() {
        return Err(format!("company '{slug}' has no local folder"));
    }
    build_node(&root, slug.to_string(), rel)
}

/// Recursively build a `FileNode` for a directory or file at `abs`. The node's
/// `name`/`path` are passed in by the caller (already computed). Any directory
/// entry literally named `.git` is skipped at every level.
pub fn build_node(abs: &Path, name: String, rel_path: String) -> Result<FileNode, String> {
    let is_dir = abs.is_dir();
    let mut children: Vec<FileNode> = Vec::new();
    if is_dir {
        let entries = std::fs::read_dir(abs)
            .map_err(|e| format!("could not read directory {rel_path:?}: {e}"))?;
        for entry in entries.flatten() {
            if entry
                .file_type()
                .map(|file_type| file_type.is_symlink())
                .unwrap_or(true)
            {
                // A symlink can alias another company (or leave HQ entirely).
                // Files exposes authored nodes only.
                continue;
            }
            let child_name = match entry.file_name().into_string() {
                Ok(n) => n,
                // Non-UTF-8 names can't round-trip through the JSON path
                // contract — skip them rather than fail the whole tree.
                Err(_) => continue,
            };
            let child_abs = entry.path();
            // Exclude curated dev noise (deps/build/artifacts/OS cruft/lockfiles
            // and dot-directories) at every level — keeps the tree meaningful.
            if is_dev_noise(&child_name, child_abs.is_dir()) {
                continue;
            }
            let child_rel = format!("{rel_path}/{child_name}");
            children.push(build_node(&child_abs, child_name, child_rel)?);
        }
        // Directories before files, each group alphabetical (case-insensitive).
        children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }
    Ok(FileNode {
        name,
        path: rel_path,
        is_dir,
        children,
    })
}
/// Pure body for `get_company_file_content` — takes an explicit HQ root so the
/// traversal guard + size cap + binary detection are unit-testable.
pub fn read_file_content(hq_root: &Path, rel_path: &str) -> Result<String, String> {
    read_file_content_capped(hq_root, rel_path, MAX_FILE_BYTES)
}

#[cfg(test)]
thread_local! {
    static FILE_READ_BEFORE_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static FILE_READ_AFTER_SIZE_CHECK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn set_file_read_before_open_hook(hook: impl FnOnce() + 'static) {
    FILE_READ_BEFORE_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_file_read_before_open_hook() {
    FILE_READ_BEFORE_OPEN_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_file_read_before_open_hook() {}

#[cfg(test)]
fn set_file_read_after_size_check_hook(hook: impl FnOnce() + 'static) {
    FILE_READ_AFTER_SIZE_CHECK_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_file_read_after_size_check_hook() {
    FILE_READ_AFTER_SIZE_CHECK_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_file_read_after_size_check_hook() {}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone)]
pub(crate) struct HqScopedDirectory {
    descriptor: std::sync::Arc<std::fs::File>,
}

/// A retained Windows directory-handle chain. Each handle intentionally omits
/// `FILE_SHARE_DELETE`, so a junction/parent directory cannot be renamed or
/// replaced after authorization while a descendant file is opened or written.
///
/// Windows has no public `openat(2)` equivalent. `NtCreateFile` with a
/// `RootDirectory` handle is the native relative-open primitive; retaining the
/// complete chain closes the otherwise subtle `canonicalize` → parent-junction
/// swap between authorization and `CreateFileW`/`ReplaceFileW`.
#[cfg(target_os = "windows")]
#[derive(Clone)]
pub(crate) struct HqScopedDirectory {
    descriptors: std::sync::Arc<Vec<std::fs::File>>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl HqScopedDirectory {
    pub(crate) fn open_regular_file(
        &self,
        file_name: &std::ffi::OsStr,
    ) -> Result<std::fs::File, String> {
        let descriptor = rustix::fs::openat(
            self.descriptor.as_ref(),
            file_name,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
        )
        .map_err(|e| format!("could not open HQ file without following links: {e}"))?;
        let file = std::fs::File::from(descriptor);
        let metadata = file
            .metadata()
            .map_err(|e| format!("could not inspect opened HQ file: {e}"))?;
        if !metadata.is_file() {
            return Err("HQ file target is not a regular file".to_string());
        }
        Ok(file)
    }

    pub(crate) fn create_new_file(
        &self,
        file_name: &std::ffi::OsStr,
    ) -> Result<std::fs::File, std::io::Error> {
        rustix::fs::openat(
            self.descriptor.as_ref(),
            file_name,
            rustix::fs::OFlags::WRONLY
                | rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::EXCL
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::from_raw_mode(0o666),
        )
        .map(std::fs::File::from)
        .map_err(std::io::Error::from)
    }

    pub(crate) fn exchange_files(
        &self,
        first: &std::ffi::OsStr,
        second: &std::ffi::OsStr,
    ) -> Result<(), String> {
        rustix::fs::renameat_with(
            self.descriptor.as_ref(),
            first,
            self.descriptor.as_ref(),
            second,
            rustix::fs::RenameFlags::EXCHANGE,
        )
        .map_err(|error| format!("could not atomically exchange project JSON: {error}"))
    }

    pub(crate) fn remove_file(&self, file_name: &std::ffi::OsStr) -> Result<(), std::io::Error> {
        rustix::fs::unlinkat(
            self.descriptor.as_ref(),
            file_name,
            rustix::fs::AtFlags::empty(),
        )
        .map_err(std::io::Error::from)
    }
}

#[cfg(target_os = "windows")]
mod windows_scoped_directory {
    use std::{
        ffi::{c_void, OsStr},
        fs::File,
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::{AsRawHandle, FromRawHandle, RawHandle},
        },
        path::Path,
    };

    use super::HqScopedDirectory;

    // NT native API constants. The Win32 API exposes no way to open a child
    // relative to a retained directory handle; this is the documented kernel
    // primitive underpinning Win32 relative opens.
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const DELETE: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_OPEN: u32 = 0x0000_0001;
    const FILE_CREATE: u32 = 0x0000_0002;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: isize,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status_or_pointer: usize,
        information: usize,
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            file_handle: *mut isize,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            allocation_size: *mut i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *mut c_void,
            ea_length: u32,
        ) -> i32;
        fn NtSetInformationFile(
            file_handle: isize,
            io_status_block: *mut IoStatusBlock,
            file_information: *mut c_void,
            length: u32,
            file_information_class: u32,
        ) -> i32;
    }

    fn status_error(operation: &str, status: i32) -> String {
        format!("{operation} failed with NTSTATUS 0x{:08x}", status as u32)
    }

    fn validate_child_name(name: &OsStr) -> Result<(), String> {
        let text = name
            .to_str()
            .ok_or_else(|| "HQ path component is not valid UTF-8".to_string())?;
        if text.is_empty() || text == "." || text == ".." || text.contains(['/', '\\']) {
            return Err("HQ path component is not a single safe name".to_string());
        }
        Ok(())
    }

    fn nt_open_relative(
        parent: &File,
        name: &OsStr,
        desired_access: u32,
        create_disposition: u32,
        create_options: u32,
    ) -> Result<File, String> {
        validate_child_name(name)?;
        let mut encoded = name.encode_wide().collect::<Vec<_>>();
        let byte_len = encoded
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .and_then(|length| u16::try_from(length).ok())
            .ok_or_else(|| "HQ path component is too long".to_string())?;
        let mut object_name = UnicodeString {
            length: byte_len,
            maximum_length: byte_len,
            buffer: encoded.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: parent.as_raw_handle() as isize,
            object_name: &mut object_name,
            attributes: OBJ_CASE_INSENSITIVE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut io_status = IoStatusBlock {
            status_or_pointer: 0,
            information: 0,
        };
        let mut handle = -1isize;
        // The opened parent handle is the root for this one component. We
        // deliberately share READ only: no concurrent rename/delete/reparse
        // rewrite can replace any retained ancestor during the operation.
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                desired_access,
                &mut attributes,
                &mut io_status,
                std::ptr::null_mut(),
                0,
                FILE_SHARE_READ,
                create_disposition,
                create_options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
                0,
            )
        };
        if status < 0 {
            return Err(status_error(
                "could not open HQ path without following reparse points",
                status,
            ));
        }
        // SAFETY: a successful NtCreateFile returns one owned HANDLE. File
        // closes it exactly once, and `encoded` remains alive for the syscall.
        Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
    }

    fn ensure_real_directory(file: File) -> Result<File, String> {
        let metadata = file
            .metadata()
            .map_err(|error| format!("could not inspect opened HQ directory: {error}"))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_dir() {
            return Err("HQ directory must not be a reparse point".to_string());
        }
        Ok(file)
    }

    fn ensure_regular_file(file: File) -> Result<File, String> {
        let metadata = file
            .metadata()
            .map_err(|error| format!("could not inspect opened HQ file: {error}"))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_file() {
            return Err("HQ file target is not a regular file".to_string());
        }
        Ok(file)
    }

    fn open_root(path: &Path) -> Result<File, String> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| {
                format!("could not open HQ folder without following reparse points: {error}")
            })?;
        ensure_real_directory(file)
    }

    pub(super) fn open_scoped_directory(
        hq_root: &Path,
        rel_dir: &str,
        validate_relative: impl Fn(&str) -> Result<String, String>,
    ) -> Result<HqScopedDirectory, String> {
        let canonical_root = std::fs::canonicalize(hq_root)
            .map_err(|error| format!("could not resolve HQ folder: {error}"))?;
        let root = open_root(&canonical_root)?;
        let mut chain = vec![root];

        if !rel_dir.is_empty() {
            let normalized = validate_relative(rel_dir)?;
            if normalized != rel_dir {
                return Err("HQ directory path must be canonical".to_string());
            }
            for segment in normalized.split('/') {
                let parent = chain
                    .last()
                    .ok_or_else(|| "HQ directory chain is empty".to_string())?;
                let child = nt_open_relative(
                    parent,
                    OsStr::new(segment),
                    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                    FILE_OPEN,
                    FILE_DIRECTORY_FILE,
                )?;
                chain.push(ensure_real_directory(child)?);
            }
        }
        Ok(HqScopedDirectory {
            descriptors: std::sync::Arc::new(chain),
        })
    }

    pub(super) fn open_regular_file(
        directory: &HqScopedDirectory,
        file_name: &OsStr,
    ) -> Result<File, String> {
        let parent = directory
            .descriptors
            .last()
            .ok_or_else(|| "HQ directory chain is empty".to_string())?;
        ensure_regular_file(nt_open_relative(
            parent,
            file_name,
            GENERIC_READ | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?)
    }

    pub(super) fn create_new_file(
        directory: &HqScopedDirectory,
        file_name: &OsStr,
    ) -> Result<File, std::io::Error> {
        let parent = directory.descriptors.last().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "HQ directory chain is empty")
        })?;
        nt_open_relative(
            parent,
            file_name,
            GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))
    }

    pub(super) fn remove_file(
        directory: &HqScopedDirectory,
        file_name: &OsStr,
    ) -> Result<(), std::io::Error> {
        // `NtSetInformationFile(FileDispositionInformation)` deletes the
        // terminal directory entry through the retained parent handle. It is
        // the Windows counterpart to unlinkat and never re-resolves a path
        // through a replaceable parent junction.
        const FILE_DISPOSITION_INFORMATION: u32 = 13;
        let parent = directory.descriptors.last().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "HQ directory chain is empty")
        })?;
        let file = nt_open_relative(
            parent,
            file_name,
            DELETE | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
        let mut io_status = IoStatusBlock {
            status_or_pointer: 0,
            information: 0,
        };
        let mut delete_file: u8 = 1;
        let status = unsafe {
            NtSetInformationFile(
                file.as_raw_handle() as isize,
                &mut io_status,
                (&mut delete_file as *mut u8).cast(),
                1,
                FILE_DISPOSITION_INFORMATION,
            )
        };
        if status < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                status_error(
                    "could not remove HQ file without following reparse points",
                    status,
                ),
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl HqScopedDirectory {
    pub(crate) fn open_regular_file(
        &self,
        file_name: &std::ffi::OsStr,
    ) -> Result<std::fs::File, String> {
        windows_scoped_directory::open_regular_file(self, file_name)
    }

    pub(crate) fn create_new_file(
        &self,
        file_name: &std::ffi::OsStr,
    ) -> Result<std::fs::File, std::io::Error> {
        windows_scoped_directory::create_new_file(self, file_name)
    }

    pub(crate) fn remove_file(&self, file_name: &std::ffi::OsStr) -> Result<(), std::io::Error> {
        windows_scoped_directory::remove_file(self, file_name)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn open_hq_scoped_directory(
    hq_root: &Path,
    rel_dir: &str,
) -> Result<HqScopedDirectory, String> {
    use std::os::unix::fs::MetadataExt;

    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let expected_root = std::fs::symlink_metadata(&canonical_root)
        .map_err(|e| format!("could not inspect HQ folder: {e}"))?;
    if expected_root.file_type().is_symlink() || !expected_root.is_dir() {
        return Err("HQ folder must be a real directory".to_string());
    }

    let descriptor = rustix::fs::open(
        &canonical_root,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .map_err(|e| format!("could not open HQ folder without following links: {e}"))?;
    let mut directory = std::fs::File::from(descriptor);
    let opened_root = directory
        .metadata()
        .map_err(|e| format!("could not inspect opened HQ folder: {e}"))?;
    if opened_root.dev() != expected_root.dev() || opened_root.ino() != expected_root.ino() {
        return Err("HQ folder changed while it was being opened".to_string());
    }

    if !rel_dir.is_empty() {
        let normalized = validate_hq_relative_path(rel_dir, false)?;
        if normalized != rel_dir {
            return Err("HQ directory path must be canonical".to_string());
        }
        for segment in normalized.split('/') {
            let next = rustix::fs::openat(
                &directory,
                segment,
                rustix::fs::OFlags::RDONLY
                    | rustix::fs::OFlags::DIRECTORY
                    | rustix::fs::OFlags::CLOEXEC
                    | rustix::fs::OFlags::NOFOLLOW,
                rustix::fs::Mode::empty(),
            )
            .map_err(|e| {
                format!(
                    "could not open HQ directory component {segment:?} without following links: {e}"
                )
            })?;
            directory = std::fs::File::from(next);
        }
    }
    Ok(HqScopedDirectory {
        descriptor: std::sync::Arc::new(directory),
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn open_hq_scoped_directory(
    hq_root: &Path,
    rel_dir: &str,
) -> Result<HqScopedDirectory, String> {
    windows_scoped_directory::open_scoped_directory(hq_root, rel_dir, |value| {
        validate_hq_relative_path(value, false)
    })
}

/// Open an already-canonical HQ-relative regular file while binding every
/// path component to the opened HQ root. Unix walks the directory chain with
/// `openat(..., O_NOFOLLOW)` so an ancestor swapped after authorization cannot
/// redirect the read.
pub fn open_hq_regular_file_no_follow(
    hq_root: &Path,
    canonical_rel_path: &str,
) -> Result<std::fs::File, String> {
    let normalized = validate_hq_relative_path(canonical_rel_path, false)?;
    if normalized != canonical_rel_path {
        return Err("HQ file path must be canonical".to_string());
    }
    let relative = Path::new(&normalized);
    let file_name = relative
        .file_name()
        .ok_or_else(|| "HQ file path has no terminal name".to_string())?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let file = {
        let parent_rel = parent
            .to_str()
            .ok_or_else(|| "HQ file parent is not valid UTF-8".to_string())?;
        open_hq_scoped_directory(hq_root, parent_rel)?.open_regular_file(file_name)?
    };

    #[cfg(target_os = "windows")]
    let file = {
        let parent_rel = parent
            .to_str()
            .ok_or_else(|| "HQ file parent is not valid UTF-8".to_string())?;
        open_hq_scoped_directory(hq_root, parent_rel)?.open_regular_file(file_name)?
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let file = {
        let canonical_root = std::fs::canonicalize(hq_root)
            .map_err(|e| format!("could not resolve HQ folder: {e}"))?;
        open_regular_file_no_follow_path(&canonical_root.join(&normalized))?
    };

    let metadata = file
        .metadata()
        .map_err(|e| format!("could not inspect opened HQ file: {e}"))?;
    if !metadata.is_file() {
        return Err("HQ file target is not a regular file".to_string());
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_regular_file_no_follow_path(path: &Path) -> Result<std::fs::File, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("could not inspect preview file: {e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("preview target must not be a symlink".to_string());
    }
    if !metadata.is_file() {
        return Err("preview target is not a regular file".to_string());
    }
    std::fs::File::open(path).map_err(|e| format!("could not open preview file: {e}"))
}

#[cfg(test)]
mod windows_path_authority_contract_tests {
    /// The macOS/Linux regression can exercise actual symlink swaps. Windows
    /// junctions are unavailable in the host test environment, so lock the
    /// required native authority contract in source as well: every component
    /// must be opened under a retained RootDirectory handle, and the chain
    /// must deny delete sharing for the whole operation.
    #[test]
    fn windows_uses_retained_relative_no_reparse_directory_handles() {
        let source = include_str!("desktop_alt.rs");
        for required in [
            "struct HqScopedDirectory {\n    descriptors: std::sync::Arc<Vec<std::fs::File>>",
            "fn NtCreateFile(",
            "root_directory: parent.as_raw_handle() as isize",
            "FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT",
            "share_mode(FILE_SHARE_READ)",
            "FILE_SHARE_READ,",
            "open_hq_scoped_directory(hq_root, parent_rel)?.open_regular_file(file_name)?",
        ] {
            assert!(
                source.contains(required),
                "Windows parent-swap authority contract drifted: missing {required:?}"
            );
        }
    }
}

/// Read raw file bytes under the same strict/canonical HQ-relative contract.
pub fn read_file_bytes_capped(
    hq_root: &Path,
    rel_path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let rel = validate_hq_relative_path(rel_path, false)?;
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let relative = Path::new(&rel);
    let file_name = relative
        .file_name()
        .ok_or_else(|| format!("file not found: {rel_path:?}"))?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent_rel = parent
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {rel_path:?}"))?;
    let canonical_parent = canonical_hq_relative_path(hq_root, parent_rel, true)?;
    let canonical_rel = if canonical_parent.is_empty() {
        file_name.to_string_lossy().to_string()
    } else {
        format!("{canonical_parent}/{}", file_name.to_string_lossy())
    };
    if company_slug_for_hq_path(&rel)? != company_slug_for_hq_path(&canonical_rel)? {
        return Err("file path resolves across HQ company boundaries".to_string());
    }

    let _canonical_abs = canonical_root.join(&canonical_rel);
    run_file_read_before_open_hook();
    let file = open_hq_regular_file_no_follow(&canonical_root, &canonical_rel)?;
    let initial_len = file
        .metadata()
        .map_err(|e| format!("could not inspect opened preview file: {e}"))?
        .len();
    if initial_len > max_bytes {
        return Err(format!(
            "file is too large to preview ({initial_len} bytes; limit is {max_bytes} bytes)"
        ));
    }

    run_file_read_after_size_check_hook();
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read {rel_path:?}: {e}"))?;
    let actual_len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if actual_len > max_bytes {
        return Err(format!(
            "file is too large to preview ({actual_len} bytes read; limit is {max_bytes} bytes)"
        ));
    }
    Ok(bytes)
}

/// Size-cap-parameterized core of `read_file_content`. Split out so tests can
/// exercise the real cap path with a tiny `max_bytes` instead of writing a
/// 50MB fixture. Mirrors `IgnoreFilter::within_size_limit`: the cap is checked
/// from `std::fs::metadata` length BEFORE the file is read.
pub fn read_file_content_capped(
    hq_root: &Path,
    rel_path: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let bytes = read_file_bytes_capped(hq_root, rel_path, max_bytes)?;
    String::from_utf8(bytes).map_err(|_| format!("cannot preview binary file: {rel_path:?}"))
}
// ---- Lazy HQ-root file explorer (US-010) ----------------------------------

/// One entry in a single directory listing for the lazy file explorer (US-010).
///
/// Unlike [`FileNode`], a `DirEntry` is NOT recursive — `list_hq_dir` returns
/// only the *immediate* children of one directory so the large HQ root (esp.
/// `repos/`) never triggers a full eager walk. The frontend lazily fetches a
/// folder's children on expand. `has_children` lets the UI render an
/// expand chevron for non-empty directories WITHOUT walking them first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// HQ-folder-relative path, forward-slash separated (e.g.
    /// `repos/public/hq-sync`).
    pub path: String,
    pub is_dir: bool,
    /// For directories, whether the dir contains at least one non-noise child
    /// (so the UI can show an expand affordance without recursing). Always
    /// `false` for files.
    pub has_children: bool,
}
/// Pure body for `list_hq_dir` — takes an explicit HQ root so the traversal
/// guard + noise filter + sort order are unit-testable without the gate.
pub fn list_dir_entries(hq_root: &Path, rel_path: &str) -> Result<Vec<DirEntry>, String> {
    // Empty / "." mean the HQ root.
    let rel = validate_hq_relative_path(rel_path, true)?;
    let abs = if rel.is_empty() {
        hq_root.to_path_buf()
    } else {
        hq_root.join(&rel)
    };

    // Defense-in-depth: reject any path that escapes the HQ folder.
    if !is_within(hq_root, &abs) {
        return Err(format!("path escapes the HQ folder: {rel_path:?}"));
    }
    if !abs.is_dir() {
        return Err(format!("directory not found: {rel_path:?}"));
    }

    let canonical_rel = canonical_hq_relative_path(hq_root, &rel, true)?;
    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("could not resolve HQ folder: {e}"))?;
    let canonical_abs = canonical_root.join(canonical_rel);

    let entries = std::fs::read_dir(&canonical_abs)
        .map_err(|e| format!("could not read directory {rel_path:?}: {e}"))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        if entry
            .file_type()
            .map(|file_type| file_type.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            // Non-UTF-8 names can't round-trip through the JSON contract — skip.
            Err(_) => continue,
        };
        let child_abs = entry.path();
        let is_dir = child_abs.is_dir();
        if is_dev_noise(&name, is_dir) {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        // Cheap one-level peek so the UI knows whether to show an expand
        // chevron — does NOT recurse, so a giant subtree is never walked here.
        let has_children = is_dir && dir_has_visible_children(&child_abs);
        out.push(DirEntry {
            name,
            path: child_rel,
            is_dir,
            has_children,
        });
    }
    // Directories before files, each group case-insensitive alphabetical.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// True if directory `abs` has at least one child that survives the dev-noise
/// filter. A single-level peek (no recursion) used only to decide whether to
/// render an expand affordance.
pub fn dir_has_visible_children(abs: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(abs) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry
            .file_type()
            .map(|file_type| file_type.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let is_dir = entry.path().is_dir();
        if !is_dev_noise(&name, is_dir) {
            return true;
        }
    }
    false
}
#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use crate::feature_gate::email_present;
    use crate::workspaces::{Workspace, WorkspaceKind, WorkspaceState};

    // Note: `desktop_alt_enabled` itself depends on the on-disk Cognito
    // token cache so it isn't a pure unit-test target — the canonical
    // gate logic it delegates to is covered by the unit tests in
    // `util/feature_gate.rs` (ga_gate_admits_any_present_email /
    // ga_gate_rejects_signed_out), plus the command-specific assertions
    // below that re-exercise the GA presence contract this command is bound
    // to. The window graduated from the Indigo dogfood to GA.

    /// GA: the expanded desktop window is enabled for ANY signed-in user.
    #[test]
    fn desktop_alt_gate_admits_any_signed_in_user() {
        assert!(email_present(Some("stefan@getindigo.ai")));
        assert!(email_present(Some("qa@example.com")));
        assert!(email_present(Some("anyone@gmail.com")));
        // Former dogfood look-alike — now admitted, GA only checks presence.
        assert!(email_present(Some("attacker@forgetindigo.ai")));
    }

    /// GA: only signed-out (no email / empty) is rejected.
    #[test]
    fn desktop_alt_gate_rejects_signed_out() {
        assert!(!email_present(None));
        assert!(!email_present(Some("")));
        assert!(!email_present(Some("   ")));
    }

    #[test]
    fn company_board_card_count_sums_all_columns() {
        let card = |id: &str| super::BoardCard {
            id: id.to_string(),
            title: id.to_string(),
            subtitle: None,
            href: None,
            labels: Vec::new(),
            assignee_initials: None,
            tag: None,
            age: None,
            extra: std::collections::BTreeMap::new(),
        };
        let board = super::CompanyBoard {
            inbox: vec![card("a"), card("b")],
            doing: vec![card("c")],
            review: Vec::new(),
            done: vec![card("d"), card("e"), card("f")],
        };

        assert_eq!(board.card_count(), 6);
        assert_eq!(super::CompanyBoard::default().card_count(), 0);
    }

    #[test]
    fn company_activity_last7d_reads_files7_stat() {
        let activity = super::parse_activity_response(
            reqwest::StatusCode::OK,
            r#"{"stats":{"files7":9,"edits7":40}}"#,
        )
        .expect("activity should parse");

        assert_eq!(activity.last7d(), 9);
        assert_eq!(super::CompanyActivity::default().last7d(), 0);
    }

    #[test]
    fn summary_count_propagates_auth_but_degrades_other_errors_to_zero() {
        assert_eq!(super::summary_count_or_auth(Ok(7)).unwrap(), 7);
        // Non-auth failures (404 not-provisioned, network, parse) -> 0 so a
        // single dead surface doesn't zero the rest.
        assert_eq!(
            super::summary_count_or_auth(Err("board HTTP 404: nope".to_string())).unwrap(),
            0
        );
        // Auth failures propagate so the UI can route to sign-in.
        assert_eq!(
            super::summary_count_or_auth(Err(
                "AUTH_REQUIRED: board (HTTP 401 Unauthorized)".to_string()
            ))
            .unwrap_err(),
            "AUTH_REQUIRED: board (HTTP 401 Unauthorized)"
        );
    }

    #[test]
    fn parse_project_creators_keeps_only_real_creators() {
        // The board model carries createdByName per project (from S3 created-by).
        // We surface only projects with a non-empty creator; the rest stay
        // "Unassigned" on the desktop. Keyed by both id and prdPath.
        let body = r#"{
            "companyUid": "cmp_1",
            "goals": [],
            "projects": [
                {"id":"p1","prdPath":"companies/co/projects/a/prd.json","createdByName":"maya@x.com"},
                {"id":"p2","prdPath":"companies/co/projects/b/prd.json","createdBy":"sub_2"},
                {"id":"p3","prdPath":"companies/co/projects/c/prd.json","createdByName":"  "},
                {"id":"p4","createdByName":"corey@x.com"}
            ]
        }"#;
        let rows = super::parse_project_creators(body).expect("parses");
        // p2 (no name), p3 (blank) dropped; p1 + p4 kept.
        assert_eq!(rows.len(), 2);
        let p1 = rows.iter().find(|r| r.id == "p1").unwrap();
        assert_eq!(p1.creator, "maya@x.com");
        assert_eq!(
            p1.prd_path.as_deref(),
            Some("companies/co/projects/a/prd.json")
        );
        let p4 = rows.iter().find(|r| r.id == "p4").unwrap();
        assert_eq!(p4.creator, "corey@x.com");
        assert!(p4.prd_path.is_none());
    }

    #[test]
    fn parse_project_creators_tolerates_empty_or_missing_projects() {
        assert!(
            super::parse_project_creators(r#"{"companyUid":"c","goals":[]}"#)
                .unwrap()
                .is_empty()
        );
        assert!(super::parse_project_creators(r#"{"projects":[]}"#)
            .unwrap()
            .is_empty());
        assert!(super::parse_project_creators("not json").is_err());
    }

    #[test]
    fn project_creator_response_distinguishes_absence_from_auth_and_server_failures() {
        assert!(
            super::parse_project_creators_response(reqwest::StatusCode::NO_CONTENT, "")
                .expect("204 has no cloud attribution")
                .is_empty()
        );
        assert!(super::parse_project_creators_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"board-not-provisioned"}"#,
        )
        .expect("an explicitly unprovisioned board has no attribution")
        .is_empty());
        assert!(
            super::parse_project_creators_response(reqwest::StatusCode::OK, " \n ")
                .expect("an empty successful board has no attribution")
                .is_empty()
        );

        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let error =
                super::parse_project_creators_response(status, "").expect_err("auth must surface");
            assert!(error.starts_with("AUTH_REQUIRED: creators"));
        }

        let route_error = super::parse_project_creators_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"not-found","message":"route not found"}"#,
        )
        .expect_err("generic 404 must not masquerade as checked attribution");
        assert!(route_error.contains("creators HTTP 404"));

        let server_error = super::parse_project_creators_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "upstream unavailable",
        )
        .expect_err("server failures must reach the UI");
        assert!(server_error.contains("creators HTTP 500"));

        let parse_error =
            super::parse_project_creators_response(reqwest::StatusCode::OK, "not json")
                .expect_err("malformed successful responses must remain visible");
        assert!(parse_error.starts_with("creators parse:"));
    }

    #[test]
    fn parse_project_creators_preserves_optional_owner_and_origin_without_requiring_creator() {
        let body = r#"{
            "projects": [
                {
                    "id":"p1",
                    "prdPath":"companies/co/projects/a/prd.json",
                    "createdByName":"Corey",
                    "ownerName":"Maya",
                    "source":"Linear import"
                },
                {
                    "id":"p2",
                    "owner":{"displayName":"Ada"},
                    "origin":"HQ plan"
                },
                {
                    "id":"p3",
                    "owner":{"uid":"opaque-only"},
                    "source":" "
                }
            ]
        }"#;
        let rows = super::parse_project_creators(body).expect("parses");
        assert_eq!(rows.len(), 2, "opaque/blank attribution is omitted");

        let p1 = rows.iter().find(|row| row.id == "p1").unwrap();
        assert_eq!(p1.creator, "Corey");
        assert_eq!(p1.owner.as_deref(), Some("Maya"));
        assert_eq!(p1.origin.as_deref(), Some("Linear import"));

        let p2 = rows.iter().find(|row| row.id == "p2").unwrap();
        assert!(p2.creator.is_empty());
        assert_eq!(p2.owner.as_deref(), Some("Ada"));
        assert_eq!(p2.origin.as_deref(), Some("HQ plan"));
    }

    #[test]
    fn parse_responses_flag_auth_failures_as_auth_required() {
        assert!(
            super::parse_board_response(reqwest::StatusCode::UNAUTHORIZED, "")
                .unwrap_err()
                .starts_with("AUTH_REQUIRED: board")
        );
        assert!(
            super::parse_board_response(reqwest::StatusCode::FORBIDDEN, "")
                .unwrap_err()
                .starts_with("AUTH_REQUIRED: board")
        );
        assert!(
            super::parse_activity_response(reqwest::StatusCode::UNAUTHORIZED, "")
                .unwrap_err()
                .starts_with("AUTH_REQUIRED: activity")
        );
        assert!(
            super::parse_deployments_response(reqwest::StatusCode::FORBIDDEN, "", "test-org")
                .unwrap_err()
                .starts_with("AUTH_REQUIRED: deployments")
        );
        assert!(
            super::parse_secrets_response(reqwest::StatusCode::UNAUTHORIZED, "")
                .unwrap_err()
                .starts_with("AUTH_REQUIRED: secrets")
        );
    }

    #[test]
    fn company_summary_rejects_empty_slug() {
        assert_eq!(
            super::normalize_slug("").unwrap_err(),
            "company slug is required"
        );
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
    }

    #[test]
    fn company_board_rejects_empty_slug_before_network() {
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
    }

    #[test]
    fn company_activity_rejects_empty_slug_before_network() {
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
    }

    #[test]
    fn company_deployments_rejects_empty_slug_before_network() {
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
    }

    #[test]
    fn company_secrets_rejects_empty_slug_before_network() {
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
    }

    #[test]
    fn company_board_deserializes_missing_columns_as_empty_arrays() {
        let board: super::CompanyBoard = serde_json::from_str(
            r#"{
                "inbox": [{"id": "card-1", "title": "One", "customField": 42}]
            }"#,
        )
        .expect("missing columns should default");

        assert_eq!(board.inbox.len(), 1);
        assert_eq!(board.inbox[0].id, "card-1");
        assert_eq!(board.inbox[0].title, "One");
        assert_eq!(board.inbox[0].extra["customField"], 42);
        assert!(board.doing.is_empty());
        assert!(board.review.is_empty());
        assert!(board.done.is_empty());
    }

    #[test]
    fn company_board_deserializes_empty_object_as_empty_board() {
        let board: super::CompanyBoard = serde_json::from_str("{}").unwrap();

        assert!(board.inbox.is_empty());
        assert!(board.doing.is_empty());
        assert!(board.review.is_empty());
        assert!(board.done.is_empty());
    }

    #[test]
    fn company_board_treats_missing_or_empty_response_as_empty_board() {
        let not_provisioned = super::parse_board_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"board-not-provisioned"}"#,
        )
        .expect("missing board.json should be an empty board");
        assert_eq!(not_provisioned, super::CompanyBoard::default());

        let no_content = super::parse_board_response(reqwest::StatusCode::NO_CONTENT, "")
            .expect("204 should be an empty board");
        assert_eq!(no_content, super::CompanyBoard::default());

        let empty_body = super::parse_board_response(reqwest::StatusCode::OK, " \n ")
            .expect("empty board.json should be an empty board");
        assert_eq!(empty_body, super::CompanyBoard::default());
    }

    #[test]
    fn company_board_rejects_generic_route_not_found() {
        let err = super::parse_board_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"not-found","message":"route not found"}"#,
        )
        .unwrap_err();

        assert!(err.contains("board HTTP 404"));
    }

    #[test]
    fn crm_projection_parses_a_2xx_projection_passthrough() {
        let value = super::parse_crm_projection_response(
            reqwest::StatusCode::OK,
            r#"{"schema_version":1,"accounts":[{"id":"a","name":"A"}],"synced_at":"t"}"#,
        )
        .expect("2xx projection parses");
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["accounts"][0]["id"], "a");
    }

    #[test]
    fn crm_projection_degrades_non_auth_failures_and_empty_to_null() {
        // 404 (route not deployed yet) / not-provisioned / empty body all become
        // JSON null — the surface renders its calm empty state, not an error.
        for (status, body) in [
            (
                reqwest::StatusCode::NOT_FOUND,
                r#"{"code":"crm-not-provisioned"}"#,
            ),
            (reqwest::StatusCode::NOT_FOUND, "route not found"),
            (reqwest::StatusCode::OK, "  \n "),
            (reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom"),
        ] {
            let value = super::parse_crm_projection_response(status, body)
                .expect("non-auth failure degrades to null");
            assert!(
                value.is_null(),
                "status {status} body {body:?} should be null"
            );
        }
    }

    #[test]
    fn crm_projection_propagates_auth_failures() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let err = super::parse_crm_projection_response(status, "{}").unwrap_err();
            assert!(err.starts_with("AUTH_REQUIRED:"), "got {err}");
        }
    }

    #[test]
    fn crm_projection_url_is_company_scoped() {
        let url =
            super::crm_projection_url("https://hqapi.getindigo.ai", "cmp_01ABC").expect("url");
        assert_eq!(
            url,
            "https://hqapi.getindigo.ai/companies/cmp_01ABC/crm-projection"
        );
        assert!(super::crm_projection_url("https://x", "bad uid!").is_err());
    }

    #[test]
    fn company_activity_deserializes_empty_object_as_empty_activity() {
        let activity: super::CompanyActivity = serde_json::from_str("{}").unwrap();

        assert_eq!(activity, super::CompanyActivity::default());
    }

    #[test]
    fn company_activity_deserializes_missing_arrays_and_stats_as_defaults() {
        let activity: super::CompanyActivity = serde_json::from_str(
            r#"{
                "stats": {"files7": 3},
                "recent": [{"who": "Ada", "extraField": "kept"}]
            }"#,
        )
        .expect("missing activity fields should default");

        assert_eq!(activity.stats.files7, 3);
        assert_eq!(activity.stats.edits7, 0);
        assert_eq!(activity.stats.members, 0);
        assert_eq!(activity.stats.vault_size, "");
        assert!(activity.sparkline.is_empty());
        assert_eq!(activity.recent.len(), 1);
        assert_eq!(activity.recent[0].who, "Ada");
        assert_eq!(activity.recent[0].what, "");
        assert_eq!(activity.recent[0].extra["extraField"], "kept");
        assert!(activity.top.is_empty());
    }

    #[test]
    fn company_activity_treats_missing_or_empty_response_as_empty_activity() {
        let not_provisioned = super::parse_activity_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"activity-not-provisioned"}"#,
        )
        .expect("missing activity should be empty activity");
        assert_eq!(not_provisioned, super::CompanyActivity::default());

        let nested_code = super::parse_activity_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"error":{"code":"activity_missing"}}"#,
        )
        .expect("nested missing code should be empty activity");
        assert_eq!(nested_code, super::CompanyActivity::default());

        let no_content = super::parse_activity_response(reqwest::StatusCode::NO_CONTENT, "")
            .expect("204 should be empty activity");
        assert_eq!(no_content, super::CompanyActivity::default());

        let empty_body = super::parse_activity_response(reqwest::StatusCode::OK, " \n ")
            .expect("empty activity response should be empty activity");
        assert_eq!(empty_body, super::CompanyActivity::default());
    }

    #[test]
    fn company_activity_rejects_generic_route_not_found() {
        let err = super::parse_activity_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"not-found","message":"route not found"}"#,
        )
        .unwrap_err();

        assert!(err.contains("activity HTTP 404"));
    }

    #[test]
    fn company_activity_parses_live_camel_case_response() {
        let activity = super::parse_activity_response(
            reqwest::StatusCode::OK,
            r#"{
                "stats": {
                    "files7": 12,
                    "edits7": 34,
                    "members": 5,
                    "vaultSize": "1.2 MB"
                },
                "sparkline": [0, 2, 4, 3],
                "recent": [
                    {
                        "who": "Ada Lovelace",
                        "what": "edited",
                        "file": "plans/spec.md",
                        "when": "2026-05-27T12:00:00Z",
                        "source": "hq-sync"
                    }
                ],
                "top": [
                    {"who": "Ada Lovelace", "edits": 20},
                    {"who": "Grace Hopper", "edits": 14}
                ]
            }"#,
        )
        .expect("live activity should parse");

        assert_eq!(activity.stats.files7, 12);
        assert_eq!(activity.stats.edits7, 34);
        assert_eq!(activity.stats.members, 5);
        assert_eq!(activity.stats.vault_size, "1.2 MB");
        assert_eq!(activity.sparkline, vec![0, 2, 4, 3]);
        assert_eq!(activity.recent[0].who, "Ada Lovelace");
        assert_eq!(activity.recent[0].what, "edited");
        assert_eq!(activity.recent[0].file, "plans/spec.md");
        assert_eq!(activity.recent[0].when, "2026-05-27T12:00:00Z");
        assert_eq!(activity.recent[0].extra["source"], "hq-sync");
        assert_eq!(activity.top[0].edits, 20);
        assert_eq!(activity.top[1].who, "Grace Hopper");
    }

    #[test]
    fn company_deployments_parse_hq_deploy_apps_me_shape() {
        let deployments = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"{
                "apps": [
                    {
                        "id": "app-1",
                        "subdomain": "console",
                        "status": "active",
                        "dnsStatus": "active",
                        "active": true,
                        "passwordProtected": true,
                        "createdAt": "2026-05-27T12:00:00Z",
                        "url": "https://console.indigo-hq.com"
                    },
                    {
                        "id": "app-2",
                        "subdomain": "preview",
                        "status": "deploying",
                        "active": true,
                        "createdAt": "2026-05-27T11:00:00Z",
                        "url": "https://preview.indigo-hq.com/path"
                    },
                    {
                        "id": "app-3",
                        "subdomain": "paused-app",
                        "status": "active",
                        "active": false,
                        "passwordProtected": false,
                        "createdAt": "2026-05-27T10:00:00Z"
                    }
                ]
            }"#,
            "test-org",
        )
        .expect("apps/me response should parse");

        assert_eq!(deployments.len(), 3);
        assert_eq!(deployments[0].sub, "console");
        assert_eq!(deployments[0].url, "console.indigo-hq.com");
        assert_eq!(deployments[0].state, "active");
        assert_eq!(deployments[0].size, "-");
        assert_eq!(deployments[0].ver, "-");
        assert!(deployments[0].pwd);
        assert_eq!(deployments[1].url, "preview.indigo-hq.com");
        assert_eq!(deployments[1].state, "deploying");
        assert_eq!(deployments[2].url, "paused-app.indigo-hq.com");
        assert_eq!(deployments[2].state, "paused");
    }

    #[test]
    fn company_deployments_parse_optional_detail_fields() {
        let deployments = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"[
                {
                    "url": "https://portal.indigo-hq.com/",
                    "latestDeploy": {
                        "status": "live",
                        "version": 7,
                        "sizeBytes": 1536,
                        "updatedAt": "2020-01-02T12:00:00Z"
                    },
                    "pwd": false
                }
            ]"#,
            "test-org",
        )
        .expect("array response should parse");

        assert_eq!(
            deployments,
            vec![super::DeploymentEntry {
                sub: "portal".to_string(),
                url: "portal.indigo-hq.com".to_string(),
                state: "active".to_string(),
                last_deploy: "Jan 2, 2020".to_string(),
                size: "1.5 KB".to_string(),
                ver: "v7".to_string(),
                pwd: false,
            }]
        );
    }

    #[test]
    fn company_deployments_treats_empty_and_not_provisioned_as_empty() {
        assert_eq!(
            super::parse_deployments_response(reqwest::StatusCode::NO_CONTENT, "", "test-org")
                .unwrap(),
            Vec::<super::DeploymentEntry>::new()
        );
        assert_eq!(
            super::parse_deployments_response(reqwest::StatusCode::OK, " \n ", "test-org").unwrap(),
            Vec::<super::DeploymentEntry>::new()
        );
        assert_eq!(
            super::parse_deployments_response(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"code":"deployments-not-provisioned"}"#,
                "test-org",
            )
            .unwrap(),
            Vec::<super::DeploymentEntry>::new()
        );
    }

    #[test]
    fn company_secrets_project_metadata_only_from_body_secrets() {
        let envs = super::parse_secrets_response(
            reqwest::StatusCode::OK,
            r#"{
                "body": {
                    "secrets": [
                        {
                            "key": "prod/DATABASE_URL",
                            "lastModifiedDate": "2026-05-27T12:00:00Z",
                            "rotationSchedule": "30d",
                            "value": "plaintext-ignored"
                        },
                        {
                            "secretPath": "prod/STRIPE_KEY",
                            "updatedAt": "2026-05-26T12:00:00Z",
                            "rotationEnabled": false,
                            "payload": {"value": "ignored"}
                        },
                        {
                            "name": "API_TOKEN",
                            "environment": "dev",
                            "rot": "manual",
                            "secret": "ignored"
                        }
                    ]
                }
            }"#,
        )
        .expect("metadata response should parse");

        assert_eq!(envs.len(), 2);
        assert_eq!(envs[0].env, "dev");
        assert_eq!(envs[0].count, 1);
        assert_eq!(envs[0].items[0].key, "API_TOKEN");
        assert_eq!(envs[0].items[0].upd, "-");
        assert_eq!(envs[0].items[0].rot, "manual");
        assert_eq!(envs[1].env, "prod");
        assert_eq!(envs[1].count, 2);
        assert_eq!(envs[1].items[0].key, "DATABASE_URL");
        assert_eq!(envs[1].items[0].upd, "2026-05-27T12:00:00Z");
        assert_eq!(envs[1].items[0].rot, "30d");
        assert_eq!(envs[1].items[1].key, "STRIPE_KEY");
        assert_eq!(envs[1].items[1].rot, "manual");

        let serialized = serde_json::to_value(&envs).unwrap();
        let serialized_text = serialized.to_string();
        assert!(!serialized_text.contains("plaintext-ignored"));
        assert!(!serialized_text.contains("\"value\""));
        assert!(!serialized_text.contains("\"secret\""));
        assert!(serialized.get(0).unwrap().get("items").is_some());
        assert!(serialized.get(0).unwrap().get("value").is_none());
    }

    /// Contract test against the VERBATIM hq-pro vault response shape
    /// (`src/vault-service/handlers/secrets.ts` → `handleList`):
    /// `{"secrets":[{name,type,lastModifiedDate,version,permission}],"companyUid"}`.
    /// Proves the parser yields a NON-EMPTY result for this exact shape — so a
    /// company that has secrets provisioned can never render 0 because of a
    /// parse mismatch. (If the panel ever shows 0, the cause is upstream: an
    /// empty SSM path, an auth/error body, or a different response — which the
    /// committed `[desktop-alt] secrets structure:` diagnostic will reveal.)
    /// SSM names with no `/` group under "default"; `ENV/KEY` names split.
    #[test]
    fn company_secrets_parses_verbatim_vault_handlelist_shape() {
        let envs = super::parse_secrets_response(
            reqwest::StatusCode::OK,
            r#"{
                "secrets": [
                    {"name": "DATABASE_URL", "type": "SecureString", "lastModifiedDate": "2026-05-27T12:00:00Z", "version": 4, "permission": "admin"},
                    {"name": "STRIPE_KEY", "type": "SecureString", "lastModifiedDate": "2026-05-26T09:00:00Z", "version": 1, "permission": "admin"},
                    {"name": "DEV/API_TOKEN", "type": "String", "lastModifiedDate": "2026-05-25T09:00:00Z", "version": 2, "permission": "admin"}
                ],
                "companyUid": "cmp_01HX"
            }"#,
        )
        .expect("verbatim vault handleList shape should parse");

        // Two env groups: "DEV" (from DEV/API_TOKEN) and "default" (the two
        // prefix-less names). A provisioned company is never 0.
        assert!(!envs.is_empty(), "provisioned secrets must not parse to 0");
        assert_eq!(envs.len(), 2);

        let dev = envs.iter().find(|e| e.env == "DEV").expect("DEV env group");
        assert_eq!(dev.count, 1);
        assert_eq!(dev.items[0].key, "API_TOKEN");
        assert_eq!(dev.items[0].upd, "2026-05-25T09:00:00Z");

        let default = envs
            .iter()
            .find(|e| e.env == "default")
            .expect("default env group");
        assert_eq!(default.count, 2);
        let keys: Vec<&str> = default.items.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"DATABASE_URL"));
        assert!(keys.contains(&"STRIPE_KEY"));

        // The `permission`/`type` metadata never carries a value, but assert
        // the serialized form stays values-free regardless.
        let serialized = serde_json::to_value(&envs).unwrap().to_string();
        assert!(!serialized.contains("\"value\""));
    }

    /// The structure diagnostic must describe shape (top-level kind, key
    /// names, array lengths, first-row key names) and NEVER leak a value.
    #[test]
    fn secret_structure_summary_is_values_free() {
        let object_shape = serde_json::json!({
            "companyUid": "cmp_01HX",
            "secrets": [
                {
                    "name": "prod/DATABASE_URL",
                    "type": "SecureString",
                    "lastModifiedDate": "2026-05-27T12:00:00Z",
                    "version": 4,
                    "permission": "admin",
                    "value": "super-secret-plaintext"
                }
            ]
        });
        let summary = super::secret_structure_summary(&object_shape);
        // Shape facts ARE present.
        assert!(summary.contains("top-level object"));
        assert!(summary.contains("companyUid"));
        assert!(summary.contains("secrets[]=1"));
        // Row key NAMES are present...
        assert!(summary.contains("name"));
        assert!(summary.contains("version"));
        // ...but no value strings ever are.
        assert!(!summary.contains("super-secret-plaintext"));
        assert!(!summary.contains("SecureString"));
        assert!(!summary.contains("prod/DATABASE_URL"));

        let array_shape = serde_json::json!([
            { "name": "the-secret-name", "value": "leak-me" }
        ]);
        let summary = super::secret_structure_summary(&array_shape);
        assert!(summary.contains("top-level array (len=1)"));
        // Field NAMES appear...
        assert!(summary.contains("name"));
        assert!(summary.contains("value"));
        // ...but neither the secret value nor the secret's name VALUE leaks.
        assert!(!summary.contains("leak-me"));
        assert!(!summary.contains("the-secret-name"));
    }

    #[test]
    fn company_secrets_treats_empty_and_not_provisioned_as_empty() {
        assert_eq!(
            super::parse_secrets_response(reqwest::StatusCode::NO_CONTENT, "").unwrap(),
            Vec::<super::SecretEnv>::new()
        );
        assert_eq!(
            super::parse_secrets_response(reqwest::StatusCode::OK, " \n ").unwrap(),
            Vec::<super::SecretEnv>::new()
        );
        assert_eq!(
            super::parse_secrets_response(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"code":"secrets-not-provisioned"}"#,
            )
            .unwrap(),
            Vec::<super::SecretEnv>::new()
        );
    }

    #[test]
    fn company_secrets_rejects_generic_route_not_found() {
        let err = super::parse_secrets_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"not-found","message":"route not found"}"#,
        )
        .unwrap_err();

        assert!(err.contains("secrets HTTP 404"));
    }

    /// Regression for the "0 deployments despite HTTP 200 with data" bug.
    /// The real `GET /api/apps/me` rows do NOT carry an org-slug field (the
    /// server already scopes by the `x-org-slug` header), so the client-side
    /// slug filter must NOT drop them. Uses the exact production row shape.
    #[test]
    fn company_deployments_keeps_apps_me_rows_without_org_slug() {
        let deployments = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"{
                "apps": [
                    {
                        "id": "app_01HX",
                        "name": "nat-audit-indigo-api-3",
                        "subdomain": "nat-audit-indigo-api-3",
                        "type": "static",
                        "status": "active",
                        "dnsStatus": "failed",
                        "active": true,
                        "passwordProtected": false,
                        "ownerId": "user_01HX",
                        "createdAt": "2026-05-27T12:00:00Z",
                        "url": "https://nat-audit-indigo-api-3.indigo-hq.com"
                    }
                ]
            }"#,
            "indigo",
        )
        .expect("apps/me without orgSlug should parse");

        // The single row has no orgSlug field, so the server-trusted filter
        // must keep it — a count of 1, not 0.
        assert_eq!(deployments.len(), 1);
        assert_eq!(deployments[0].sub, "nat-audit-indigo-api-3");
        assert_eq!(deployments[0].state, "active");
    }

    /// The Deployments panel is a *company* dashboard, so it must hit the
    /// ORG-scoped `GET /api/apps` — never the personal `GET /api/apps/me`,
    /// which filters server-side to `ownerId === userId` and returned an
    /// empty `{"apps":[]}` (→ panel rendered 0) for any member viewing apps
    /// a co-collaborator created. Pin the path so it can't regress to `/me`.
    #[test]
    fn deployments_url_is_org_scoped_not_personal() {
        let url = super::deployments_url("https://api.indigo-hq.com");
        assert_eq!(url, "https://api.indigo-hq.com/api/apps");
        assert!(
            !url.ends_with("/me"),
            "deployments must use org-scoped /api/apps, not personal /api/apps/me: {url}"
        );
    }

    #[test]
    fn company_deployments_filters_rows_with_org_slug_when_present() {
        let deployments = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"{
                "apps": [
                    {"subdomain": "mine", "orgSlug": "selected-company"},
                    {"subdomain": "snake", "org_slug": "selected-company"},
                    {"subdomain": "nested", "org": {"slug": "selected-company"}},
                    {"subdomain": "legacy-without-org"},
                    {"subdomain": "theirs", "orgSlug": "other-company"},
                    {"subdomain": "other-nested", "org": {"slug": "other-company"}}
                ]
            }"#,
            "selected-company",
        )
        .expect("org-filtered response should parse");

        let subs: Vec<&str> = deployments
            .iter()
            .map(|deployment| deployment.sub.as_str())
            .collect();
        assert_eq!(subs, vec!["mine", "snake", "nested", "legacy-without-org"]);
    }

    #[test]
    fn deployment_helpers_normalize_state_url_age_and_size() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 27, 12, 0, 0).unwrap();

        assert_eq!(
            super::normalize_deployment_host("https://console.indigo-hq.com/path"),
            Some("console.indigo-hq.com".to_string())
        );
        assert_eq!(
            super::subdomain_from_url("https://console.indigo-hq.com/path"),
            Some("console".to_string())
        );
        assert_eq!(
            super::format_deployment_age("2026-05-27T11:57:00Z", now).as_deref(),
            Some("3m ago")
        );
        assert_eq!(
            super::format_deployment_age("2026-05-25T12:00:00Z", now).as_deref(),
            Some("2d ago")
        );
        assert_eq!(super::format_bytes(25 * 1024 * 1024), "25 MB");
    }

    #[test]
    fn deployment_helpers_reject_unsafe_hosts_before_shell_open() {
        // The host guard itself still rejects unsafe hosts outright.
        assert_eq!(
            super::normalize_deployment_host("https://evil.example.com"),
            None
        );
        assert_eq!(
            super::normalize_deployment_host("https://console.indigo-hq.com.evil.test"),
            None
        );
        assert_eq!(
            super::normalize_deployment_host("https://bad_sub.indigo-hq.com"),
            None
        );

        // Contract: an unsafe row is EXCLUDED from the parsed list — its URL can
        // never reach the UI to be shell-opened — but it does NOT fail the whole
        // batch. One malformed/hostile app must not blank every valid deployment.
        // (Regression: org-scoped `/api/apps` returns the whole org, so a single
        // odd row previously errored the collect and zeroed the entire panel.)
        let only_unsafe_url = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"[{"subdomain":"console","url":"https://evil.example.com"}]"#,
            "test-org",
        )
        .expect("an unsafe row is skipped, not turned into a batch error");
        assert!(
            only_unsafe_url.is_empty(),
            "the unsafe row must be excluded from results"
        );

        let only_unsafe_sub = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"[{"subdomain":"../console"}]"#,
            "test-org",
        )
        .expect("an unsafe subdomain row is skipped, not a batch error");
        assert!(only_unsafe_sub.is_empty());

        // The key fix: a mix of one hostile row and valid rows keeps the valid
        // ones and drops only the hostile one — and the unsafe host never appears
        // in any parsed entry (so it can never be shell-opened).
        let mixed = super::parse_deployments_response(
            reqwest::StatusCode::OK,
            r#"[
                {"subdomain":"good-app","url":"https://good-app.indigo-hq.com"},
                {"subdomain":"console","url":"https://evil.example.com"},
                {"subdomain":"another","url":"https://another.indigo-hq.com"}
            ]"#,
            "test-org",
        )
        .expect("valid rows survive alongside a skipped hostile row");
        assert_eq!(
            mixed.len(),
            2,
            "both safe rows are kept; only the hostile one drops"
        );
        let subs: Vec<&str> = mixed.iter().map(|d| d.sub.as_str()).collect();
        assert!(subs.contains(&"good-app"));
        assert!(subs.contains(&"another"));
        let serialized = serde_json::to_string(&mixed).unwrap();
        assert!(
            !serialized.contains("evil.example.com"),
            "the hostile host must never make it into a parsed entry"
        );
    }

    fn company_workspace(
        slug: &str,
        state: WorkspaceState,
        cloud_uid: Option<&str>,
        broken_reason: Option<&str>,
    ) -> Workspace {
        Workspace {
            slug: slug.to_string(),
            display_name: slug.to_string(),
            kind: WorkspaceKind::Company,
            state,
            cloud_uid: cloud_uid.map(str::to_string),
            bucket_name: None,
            has_local_folder: true,
            local_path: None,
            membership_status: None,
            role: None,
            sync_enabled: true,
            last_synced_at: None,
            broken_reason: broken_reason.map(str::to_string),
            invited_by: None,
            invited_at: None,
            branding_enabled: false,
            brand: None,
        }
    }

    #[test]
    fn company_uid_resolution_allows_synced_and_cloud_only_with_cloud_identity() {
        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "acme",
                    WorkspaceState::Synced,
                    Some("cmp_synced"),
                    None
                )],
                "acme",
            )
            .unwrap(),
            "cmp_synced"
        );
        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "orbit",
                    WorkspaceState::CloudOnly,
                    Some("cmp_cloud"),
                    None
                )],
                "orbit",
            )
            .unwrap(),
            "cmp_cloud"
        );
    }

    #[test]
    fn company_uid_resolution_allows_broken_uid_mismatch_via_live_cloud_uid() {
        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "acme",
                    WorkspaceState::Broken,
                    Some("cmp_OLD"),
                    Some(
                        "manifest cloud_uid cmp_OLD does not match cloud entity cmp_NEW for this slug",
                    ),
                )],
                "acme",
            )
            .unwrap(),
            "cmp_NEW"
        );
    }

    #[test]
    fn company_uid_resolution_rejects_broken_without_live_cloud_membership() {
        let broken_err = super::resolve_company_uid_from_workspaces(
            vec![company_workspace(
                "acme",
                WorkspaceState::Broken,
                Some("cmp_old"),
                Some("manifest cloud_uid cmp_old not found in your cloud memberships"),
            )],
            "acme",
        )
        .unwrap_err();
        assert!(broken_err.contains("company 'acme' is not synced"));
        assert!(broken_err.contains("manifest cloud_uid cmp_old not found"));

        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "local",
                    WorkspaceState::LocalOnly,
                    None,
                    None
                )],
                "local",
            )
            .unwrap_err(),
            "company 'local' is not synced (state: LocalOnly)"
        );
        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "personal",
                    WorkspaceState::Personal,
                    Some("person_123"),
                    None
                )],
                "personal",
            )
            .unwrap_err(),
            "company 'personal' is not synced (state: Personal)"
        );
        assert_eq!(
            super::resolve_company_uid_from_workspaces(
                vec![company_workspace(
                    "cloud",
                    WorkspaceState::CloudOnly,
                    None,
                    None
                )],
                "cloud",
            )
            .unwrap_err(),
            "company 'cloud' is not connected to cloud"
        );
    }

    #[test]
    fn company_resolution_errors_classify_into_well_known_codes() {
        assert_eq!(
            super::classify_company_resolution_error("company 'acme' was not found"),
            Some(super::COMPANY_NOT_FOUND_CODE)
        );
        // Broken workspace with a memberships-miss reason (the variant the
        // auto-heal cannot fix) — must classify, never leak raw to the UI.
        assert_eq!(
            super::classify_company_resolution_error(
                "company 'acme' is not synced: manifest cloud_uid cmp_old not found in your cloud memberships"
            ),
            Some(super::COMPANY_NOT_SYNCED_CODE)
        );
        assert_eq!(
            super::classify_company_resolution_error(
                "company 'local' is not synced (state: LocalOnly)"
            ),
            Some(super::COMPANY_NOT_SYNCED_CODE)
        );
        assert_eq!(
            super::classify_company_resolution_error("company 'cloud' is not connected to cloud"),
            Some(super::COMPANY_NOT_CONNECTED_CODE)
        );
        // Non-resolution failures pass through unclassified.
        assert_eq!(
            super::classify_company_resolution_error("AUTH_REQUIRED: board (HTTP 401)"),
            None
        );
        assert_eq!(
            super::classify_company_resolution_error("board HTTP 500: boom"),
            None
        );
        assert_eq!(super::classify_company_resolution_error(""), None);
        // A hostile slug can't smuggle a classification via its own text: the
        // string must START with the resolver's shape.
        assert_eq!(
            super::classify_company_resolution_error(
                "board fetch: error for company 'x' was not found"
            ),
            None
        );
    }

    #[test]
    fn prefix_company_resolution_error_adds_code_and_keeps_raw_detail() {
        assert_eq!(
            super::prefix_company_resolution_error("company 'acme' was not found".to_string()),
            "COMPANY_NOT_FOUND: company 'acme' was not found"
        );
        assert_eq!(
            super::prefix_company_resolution_error(
                "company 'acme' is not synced: manifest cloud_uid cmp_old not found in your cloud memberships"
                    .to_string()
            ),
            "COMPANY_NOT_SYNCED: company 'acme' is not synced: manifest cloud_uid cmp_old not found in your cloud memberships"
        );
        assert_eq!(
            super::prefix_company_resolution_error(
                "company 'cloud' is not connected to cloud".to_string()
            ),
            "COMPANY_NOT_CONNECTED: company 'cloud' is not connected to cloud"
        );
        // Non-resolution errors are untouched (auth mapping stays AUTH_REQUIRED).
        assert_eq!(
            super::prefix_company_resolution_error("AUTH_REQUIRED: board (HTTP 401)".to_string()),
            "AUTH_REQUIRED: board (HTTP 401)"
        );
        // Prefixed errors stay non-auth so get_company_summary degrades them
        // to a zero count instead of routing to sign-in.
        assert!(!super::is_auth_required_error(
            "COMPANY_NOT_SYNCED: company 'acme' is not synced"
        ));
    }

    #[test]
    fn company_board_maps_live_projects_into_columns() {
        let board = super::parse_board_response(
            reqwest::StatusCode::OK,
            r#"{
                "companyUid": "cmp_01ABC",
                "goals": [],
                "projects": [
                    {
                        "uid": "p1",
                        "name": "Triage intake",
                        "status": "backlog",
                        "assignee": {"name": "Ada Lovelace"},
                        "labels": ["Ops"],
                        "createdAt": "2026-05-20T12:00:00Z"
                    },
                    {
                        "id": "p2",
                        "title": "Ship sync UX",
                        "status": "in_progress",
                        "assigneeInitials": "SJ",
                        "type": "Feature",
                        "updatedAt": "2026-05-21T12:00:00Z"
                    },
                    {"id": "p3", "title": "Review polish", "status": "review"},
                    {"id": "p4", "title": "Launch", "status": "shipped"}
                ]
            }"#,
        )
        .expect("live board should map to UI columns");

        assert_eq!(board.inbox.len(), 1);
        assert_eq!(board.inbox[0].id, "p1");
        assert_eq!(board.inbox[0].title, "Triage intake");
        assert_eq!(board.inbox[0].assignee_initials.as_deref(), Some("AL"));
        assert_eq!(board.inbox[0].tag.as_deref(), Some("Ops"));
        assert_eq!(board.inbox[0].age.as_deref(), Some("May 20, 2026"));

        assert_eq!(board.doing.len(), 1);
        assert_eq!(board.doing[0].id, "p2");
        assert_eq!(board.doing[0].title, "Ship sync UX");
        assert_eq!(board.doing[0].assignee_initials.as_deref(), Some("SJ"));
        assert_eq!(board.doing[0].tag.as_deref(), Some("Feature"));
        assert_eq!(board.doing[0].age.as_deref(), Some("May 21, 2026"));

        assert_eq!(board.review[0].id, "p3");
        assert_eq!(board.done[0].id, "p4");
    }

    #[test]
    fn board_helpers_validate_slug_and_build_url() {
        assert_eq!(super::normalize_slug(" acme ").unwrap(), "acme");
        assert_eq!(
            super::normalize_slug("   ").unwrap_err(),
            "company slug is required"
        );
        assert_eq!(
            super::board_url("https://hqapi.getindigo.ai/", "cmp_01ABC-def.2").unwrap(),
            "https://hqapi.getindigo.ai/companies/cmp_01ABC-def.2/board"
        );
        assert_eq!(
            super::board_url("https://hqapi.getindigo.ai", "cmp/bad").unwrap_err(),
            "company uid has invalid characters: \"cmp/bad\""
        );
        assert_eq!(
            super::activity_url("https://hqapi.getindigo.ai/", "cmp_01ABC-def.2").unwrap(),
            "https://hqapi.getindigo.ai/companies/cmp_01ABC-def.2/activity"
        );
        assert_eq!(
            super::activity_url("https://hqapi.getindigo.ai", "cmp/bad").unwrap_err(),
            "company uid has invalid characters: \"cmp/bad\""
        );
        assert_eq!(
            super::secrets_url("https://hqapi.getindigo.ai/", "cmp_01ABC-def.2").unwrap(),
            "https://hqapi.getindigo.ai/secrets/cmp_01ABC-def.2"
        );
        assert_eq!(
            super::secrets_url("https://hqapi.getindigo.ai", "cmp/bad").unwrap_err(),
            "company uid has invalid characters: \"cmp/bad\""
        );
    }

    // ---- Company file explorer (US-001) -----------------------------------

    mod file_explorer {
        use super::super::{
            build_file_tree, company_slug_for_hq_path, read_file_bytes_capped, read_file_content,
            read_file_content_capped, set_file_read_after_size_check_hook,
            validate_hq_relative_path, workspace_grants_company_file_access, FileNode,
        };
        #[cfg(unix)]
        use super::super::{canonical_hq_relative_path, set_file_read_before_open_hook};
        use crate::workspaces::{Workspace, WorkspaceKind, WorkspaceState};
        use std::fs;
        use std::path::PathBuf;
        use tempfile::TempDir;

        /// Flatten a tree into the set of every node's path for easy assertions.
        fn collect_paths<'a>(node: &'a FileNode, out: &mut Vec<&'a str>) {
            out.push(&node.path);
            for child in &node.children {
                collect_paths(child, out);
            }
        }

        /// Build a fixture company tree under a temp HQ root and return the root.
        fn make_company_tree(tmp: &TempDir) -> PathBuf {
            let root = tmp.path().to_path_buf();
            let company = root.join("companies").join("test");
            // .git internals that MUST be excluded everywhere.
            fs::create_dir_all(company.join(".git")).unwrap();
            fs::write(company.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
            fs::create_dir_all(company.join("policies").join(".git")).unwrap();
            fs::write(company.join("policies").join(".git").join("config"), "x").unwrap();
            // Visible content, including settings/data/workers (NOT sync-ignored
            // here — local viewer shows everything but .git).
            fs::create_dir_all(company.join("policies")).unwrap();
            fs::write(company.join("policies").join("foo.md"), "# foo\n").unwrap();
            fs::create_dir_all(company.join("settings")).unwrap();
            fs::write(company.join("settings").join("vault.json"), "{}").unwrap();
            fs::create_dir_all(company.join("data")).unwrap();
            fs::write(company.join("data").join("rows.csv"), "a,b\n").unwrap();
            fs::create_dir_all(company.join("workers")).unwrap();
            fs::write(company.join("workers").join("w.md"), "worker").unwrap();
            root
        }

        #[test]
        fn build_file_tree_excludes_git_includes_local_dirs() {
            let tmp = TempDir::new().unwrap();
            let root = make_company_tree(&tmp);
            let tree = build_file_tree(&root, "test").unwrap();

            assert_eq!(tree.name, "test");
            assert_eq!(tree.path, "companies/test");
            assert!(tree.is_dir);

            let mut paths = Vec::new();
            collect_paths(&tree, &mut paths);

            // Visible content present.
            assert!(paths.contains(&"companies/test/policies/foo.md"));
            // settings/data/workers ARE included (local viewer, not sync).
            assert!(paths.contains(&"companies/test/settings/vault.json"));
            assert!(paths.contains(&"companies/test/data/rows.csv"));
            assert!(paths.contains(&"companies/test/workers/w.md"));

            // No node may be a .git dir or live under one at any level.
            for p in &paths {
                assert!(
                    !p.contains("/.git/") && !p.ends_with("/.git"),
                    "path leaked a .git entry: {p}"
                );
            }
            // And no node should be named ".git".
            fn assert_no_git_name(node: &FileNode) {
                assert_ne!(node.name, ".git", "node named .git leaked: {}", node.path);
                for c in &node.children {
                    assert_no_git_name(c);
                }
            }
            assert_no_git_name(&tree);
        }

        #[test]
        fn is_dev_noise_classifies_correctly() {
            use super::super::is_dev_noise;
            // Explicit noise dirs.
            assert!(is_dev_noise("node_modules", true));
            assert!(is_dev_noise(".git", true));
            assert!(is_dev_noise("dist", true));
            assert!(is_dev_noise("build", true));
            assert!(is_dev_noise("target", true));
            assert!(is_dev_noise(".next", true));
            assert!(is_dev_noise(".svelte-kit", true));
            assert!(is_dev_noise(".turbo", true));
            assert!(is_dev_noise(".vercel", true));
            assert!(is_dev_noise(".cache", true));
            assert!(is_dev_noise("coverage", true));
            // Lockfiles + OS cruft (files).
            assert!(is_dev_noise("package-lock.json", false));
            assert!(is_dev_noise("pnpm-lock.yaml", false));
            assert!(is_dev_noise("yarn.lock", false));
            assert!(is_dev_noise("Cargo.lock", false));
            assert!(is_dev_noise(".DS_Store", false));
            assert!(is_dev_noise("Thumbs.db", false));
            // Any other dot-directory is noise.
            assert!(is_dev_noise(".idea", true));
            assert!(is_dev_noise(".pytest_cache", true));
            // NOT noise: company content + dot-FILES (kept) + normal files.
            assert!(!is_dev_noise("settings", true));
            assert!(!is_dev_noise("data", true));
            assert!(!is_dev_noise("workers", true));
            assert!(!is_dev_noise("README.md", false));
            assert!(!is_dev_noise("policies", true));
            assert!(!is_dev_noise(".gitignore", false));
            assert!(!is_dev_noise(".env.example", false));
        }

        #[test]
        fn build_file_tree_excludes_dev_noise_keeps_content() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let company = root.join("companies").join("test");

            // --- Dev noise that MUST be filtered (top-level + nested). ---
            for dir in [
                "node_modules",
                "dist",
                "build",
                "target",
                ".next",
                ".svelte-kit",
                ".turbo",
                ".vercel",
                ".cache",
                "coverage",
                ".idea",
            ] {
                fs::create_dir_all(company.join(dir)).unwrap();
                fs::write(company.join(dir).join("noise.txt"), "x").unwrap();
            }
            for file in [
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "Cargo.lock",
                ".DS_Store",
                "Thumbs.db",
            ] {
                fs::write(company.join(file), "x").unwrap();
            }
            // Nested noise under a real content dir must also be filtered.
            fs::create_dir_all(company.join("projects").join("node_modules")).unwrap();
            fs::write(
                company.join("projects").join("node_modules").join("dep.js"),
                "x",
            )
            .unwrap();

            // --- Company content that MUST stay visible. ---
            fs::write(company.join("README.md"), "# readme\n").unwrap();
            fs::write(company.join(".gitignore"), "node_modules\n").unwrap();
            fs::create_dir_all(company.join("settings")).unwrap();
            fs::write(company.join("settings").join("vault.json"), "{}").unwrap();
            fs::create_dir_all(company.join("data")).unwrap();
            fs::write(company.join("data").join("rows.csv"), "a,b\n").unwrap();
            fs::create_dir_all(company.join("workers")).unwrap();
            fs::write(company.join("workers").join("w.md"), "worker").unwrap();
            fs::create_dir_all(company.join("projects")).unwrap();
            fs::write(company.join("projects").join("prd.json"), "{}").unwrap();

            let tree = build_file_tree(&root, "test").unwrap();
            let mut paths = Vec::new();
            collect_paths(&tree, &mut paths);

            // Noise dirs/files absent at every level.
            for noise in [
                "node_modules",
                "dist",
                "build",
                "target",
                ".next",
                ".svelte-kit",
                ".turbo",
                ".vercel",
                ".cache",
                "coverage",
                ".idea",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "Cargo.lock",
                ".DS_Store",
                "Thumbs.db",
            ] {
                assert!(
                    !paths.iter().any(|p| p.contains(&format!("/{noise}"))),
                    "dev noise leaked into tree: {noise}"
                );
            }
            // Nested node_modules gone too.
            assert!(
                !paths.contains(&"companies/test/projects/node_modules/dep.js"),
                "nested node_modules leaked"
            );

            // Real content present.
            assert!(paths.contains(&"companies/test/README.md"));
            assert!(paths.contains(&"companies/test/.gitignore"));
            assert!(paths.contains(&"companies/test/settings/vault.json"));
            assert!(paths.contains(&"companies/test/data/rows.csv"));
            assert!(paths.contains(&"companies/test/workers/w.md"));
            assert!(paths.contains(&"companies/test/projects/prd.json"));
        }

        #[test]
        fn build_file_tree_sorts_dirs_before_files() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let company = root.join("companies").join("test");
            fs::create_dir_all(company.join("zeta")).unwrap();
            fs::create_dir_all(company.join("alpha")).unwrap();
            fs::write(company.join("aaa.txt"), "a").unwrap();
            fs::write(company.join("bbb.txt"), "b").unwrap();
            let tree = build_file_tree(&root, "test").unwrap();
            let names: Vec<&str> = tree.children.iter().map(|c| c.name.as_str()).collect();
            // Dirs first (alpha, zeta), then files (aaa.txt, bbb.txt).
            assert_eq!(names, vec!["alpha", "zeta", "aaa.txt", "bbb.txt"]);
        }

        #[test]
        fn build_file_tree_rejects_empty_and_missing() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            assert!(build_file_tree(&root, "").is_err());
            assert!(build_file_tree(&root, "   ").is_err());
            // Slug with traversal must be rejected before touching the fs.
            assert!(build_file_tree(&root, "../../etc").is_err());
            // Nonexistent company.
            assert!(build_file_tree(&root, "nope").is_err());
        }

        #[cfg(unix)]
        #[test]
        fn build_file_tree_rejects_company_root_symlink_aliases() {
            use std::os::unix::fs::symlink;

            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let pending = root.join("companies").join("pending");
            fs::create_dir_all(&pending).unwrap();
            fs::write(pending.join("secret.md"), "secret").unwrap();

            let active = root.join("companies").join("active");
            symlink(&pending, &active).unwrap();
            assert!(build_file_tree(&root, "active").is_err());

            fs::remove_file(&active).unwrap();
            let outside = TempDir::new().unwrap();
            fs::write(outside.path().join("outside.md"), "outside").unwrap();
            symlink(outside.path(), &active).unwrap();
            assert!(build_file_tree(&root, "active").is_err());
        }

        #[test]
        fn hq_relative_path_contract_rejects_ambiguous_or_traversing_inputs() {
            assert_eq!(
                validate_hq_relative_path("./companies/indigo/policies/foo.md", false).unwrap(),
                "companies/indigo/policies/foo.md"
            );
            assert_eq!(validate_hq_relative_path("", true).unwrap(), "");

            for invalid in [
                "companies/indigo/../pending/secret.md",
                "companies\\pending\\secret.md",
                "/companies/pending/secret.md",
                "C:/companies/pending/secret.md",
                "companies//pending/secret.md",
                "companies/pending/file.txt:stream",
                "companies/pending/\0secret.md",
            ] {
                assert!(
                    validate_hq_relative_path(invalid, false).is_err(),
                    "accepted ambiguous path: {invalid:?}"
                );
            }
            assert!(validate_hq_relative_path("   ", false).is_err());
        }

        #[test]
        fn company_path_resolution_runs_after_strict_path_validation() {
            assert_eq!(
                company_slug_for_hq_path("companies/indigo/knowledge/overview.md").unwrap(),
                Some("indigo".to_string())
            );
            assert_eq!(
                company_slug_for_hq_path("./personal/knowledge/overview.md").unwrap(),
                None
            );
            assert!(company_slug_for_hq_path("companies/indigo/../pending/secret.md").is_err());
            assert!(company_slug_for_hq_path("companies\\pending\\secret.md").is_err());
        }

        fn company_workspace(
            slug: &str,
            state: WorkspaceState,
            membership_status: Option<&str>,
        ) -> Workspace {
            Workspace {
                slug: slug.to_string(),
                display_name: slug.to_string(),
                kind: WorkspaceKind::Company,
                state,
                cloud_uid: None,
                bucket_name: None,
                has_local_folder: true,
                local_path: Some(format!("/tmp/HQ/companies/{slug}")),
                membership_status: membership_status.map(str::to_string),
                role: Some("member".to_string()),
                sync_enabled: true,
                last_synced_at: None,
                broken_reason: None,
                invited_by: None,
                invited_at: None,
            branding_enabled: false,
            brand: None,
            }
        }

        #[test]
        fn company_file_access_requires_active_or_local_owned_workspace() {
            let workspaces = vec![
                company_workspace("active", WorkspaceState::Synced, Some("active")),
                company_workspace("pending", WorkspaceState::Synced, Some("pending")),
                company_workspace("paused", WorkspaceState::Synced, Some("paused")),
                company_workspace("local", WorkspaceState::LocalOnly, None),
                company_workspace("offline", WorkspaceState::Synced, None),
            ];

            assert!(workspace_grants_company_file_access(&workspaces, "active"));
            assert!(workspace_grants_company_file_access(&workspaces, "local"));
            assert!(!workspace_grants_company_file_access(
                &workspaces,
                "offline"
            ));
            assert!(!workspace_grants_company_file_access(
                &workspaces,
                "pending"
            ));
            assert!(!workspace_grants_company_file_access(&workspaces, "paused"));
            assert!(!workspace_grants_company_file_access(
                &workspaces,
                "unknown"
            ));
        }

        #[cfg(unix)]
        #[test]
        fn canonical_company_resolution_exposes_cross_scope_symlink_aliases() {
            use std::os::unix::fs::symlink;

            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let active = root.join("companies").join("active");
            let pending = root.join("companies").join("pending");
            let personal = root.join("personal");
            fs::create_dir_all(&active).unwrap();
            fs::create_dir_all(&pending).unwrap();
            fs::create_dir_all(&personal).unwrap();
            fs::write(pending.join("secret.md"), "not granted").unwrap();
            fs::write(personal.join("private.md"), "personal").unwrap();
            symlink(&pending, active.join("pending-link")).unwrap();
            symlink(&personal, active.join("personal-link")).unwrap();

            assert_eq!(
                canonical_hq_relative_path(
                    &root,
                    "companies/active/pending-link/secret.md",
                    false,
                )
                .unwrap(),
                "companies/pending/secret.md"
            );
            assert_eq!(
                canonical_hq_relative_path(
                    &root,
                    "companies/active/personal-link/private.md",
                    false,
                )
                .unwrap(),
                "personal/private.md"
            );

            // Recursive and lazy tree payloads omit symlinks entirely, so an
            // allowed company cannot expose another scope's entry names.
            let tree = build_file_tree(&root, "active").unwrap();
            assert!(tree.children.is_empty());
            let entries = super::super::list_dir_entries(&root, "companies/active").unwrap();
            assert!(entries.is_empty());
        }

        #[test]
        fn read_file_content_rejects_path_traversal() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let err = read_file_content(&root, "../../etc/passwd").unwrap_err();
            assert!(err.contains("invalid HQ-relative path"), "got: {err}");

            // Absolute path also escapes.
            let abs_err = read_file_content(&root, "/etc/passwd").unwrap_err();
            assert!(
                abs_err.contains("invalid HQ-relative path"),
                "got: {abs_err}"
            );

            // Empty path is rejected.
            assert!(read_file_content(&root, "   ").is_err());
        }

        #[test]
        fn read_file_content_rejects_cross_company_parent_traversal() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let pending = root.join("companies").join("pending");
            fs::create_dir_all(&pending).unwrap();
            fs::write(pending.join("secret.md"), "not granted").unwrap();

            let err =
                read_file_content(&root, "companies/indigo/../pending/secret.md").unwrap_err();
            assert!(err.contains("invalid HQ-relative path"), "got: {err}");
            let slash_err = read_file_content(&root, "companies\\pending\\secret.md").unwrap_err();
            assert!(
                slash_err.contains("invalid HQ-relative path"),
                "got: {slash_err}"
            );
        }

        #[test]
        fn read_file_content_reads_small_text() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let company = root.join("companies").join("test").join("policies");
            fs::create_dir_all(&company).unwrap();
            fs::write(company.join("foo.md"), "# hello\nworld\n").unwrap();
            let content = read_file_content(&root, "companies/test/policies/foo.md").unwrap();
            assert_eq!(content, "# hello\nworld\n");
        }

        #[test]
        fn read_file_content_rejects_binary() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let dir = root.join("companies").join("test");
            fs::create_dir_all(&dir).unwrap();
            // Invalid UTF-8 bytes.
            fs::write(dir.join("blob.bin"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
            let err = read_file_content(&root, "companies/test/blob.bin").unwrap_err();
            assert!(err.contains("cannot preview binary file"), "got: {err}");
        }

        #[test]
        fn read_file_content_capped_enforces_size_limit() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let dir = root.join("companies").join("test");
            fs::create_dir_all(&dir).unwrap();
            // 10 bytes against a 4-byte cap → size-limit error, no contents.
            fs::write(dir.join("big.txt"), "0123456789").unwrap();
            let result = read_file_content_capped(&root, "companies/test/big.txt", 4);
            let err = result.unwrap_err();
            assert!(err.contains("too large to preview"), "got: {err}");
            // Crucially the error must NOT contain the file contents.
            assert!(!err.contains("0123456789"), "contents leaked: {err}");

            // A file at/under the cap reads fine.
            fs::write(dir.join("ok.txt"), "abcd").unwrap();
            assert_eq!(
                read_file_content_capped(&root, "companies/test/ok.txt", 4).unwrap(),
                "abcd"
            );
        }

        #[test]
        fn read_file_bytes_capped_supports_binary_media_without_losing_the_cap() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let dir = root.join("companies").join("test");
            fs::create_dir_all(&dir).unwrap();
            let binary = [0xff, 0xd8, 0xff, 0x00, 0x80];
            fs::write(dir.join("photo.jpg"), binary).unwrap();

            assert_eq!(
                read_file_bytes_capped(&root, "companies/test/photo.jpg", 5).unwrap(),
                binary
            );
            let err = read_file_bytes_capped(&root, "companies/test/photo.jpg", 4).unwrap_err();
            assert!(err.contains("too large to preview"), "got: {err}");
            assert!(
                read_file_bytes_capped(&root, "companies/test/../pending/secret.jpg", 5,).is_err()
            );
        }

        #[test]
        fn read_file_bytes_capped_enforces_limit_on_bytes_actually_read() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let dir = root.join("companies").join("test");
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("changing.jpg");
            fs::write(&path, b"1234").unwrap();

            set_file_read_after_size_check_hook({
                let path = path.clone();
                move || fs::write(path, b"1234567890").unwrap()
            });

            let error =
                read_file_bytes_capped(&root, "companies/test/changing.jpg", 4).unwrap_err();
            assert!(error.contains("too large to preview"), "got: {error}");
        }

        #[cfg(unix)]
        #[test]
        fn read_file_bytes_capped_rejects_a_final_component_symlink() {
            use std::os::unix::fs::symlink;

            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let dir = root.join("companies").join("test");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("real.jpg"), b"image").unwrap();
            symlink(dir.join("real.jpg"), dir.join("alias.jpg")).unwrap();

            let error = read_file_bytes_capped(&root, "companies/test/alias.jpg", 16).unwrap_err();
            assert!(
                error.contains("symlink") || error.contains("could not open"),
                "got: {error}",
            );
        }

        #[cfg(unix)]
        #[test]
        fn read_file_bytes_capped_rejects_parent_swap_after_authorization() {
            use std::os::unix::fs::symlink;

            let tmp = TempDir::new().unwrap();
            let root = tmp.path().to_path_buf();
            let active = root.join("companies/active");
            let pending = root.join("companies/pending");
            fs::create_dir_all(active.join("docs")).unwrap();
            fs::create_dir_all(pending.join("docs")).unwrap();
            fs::write(active.join("docs/report.md"), b"authorized").unwrap();
            fs::write(pending.join("docs/report.md"), b"pending-secret").unwrap();

            set_file_read_before_open_hook({
                let active_docs = active.join("docs");
                let pending_docs = pending.join("docs");
                move || {
                    fs::rename(&active_docs, active.join("docs-original")).unwrap();
                    symlink(&pending_docs, &active_docs).unwrap();
                }
            });

            let result = read_file_bytes_capped(&root, "companies/active/docs/report.md", 64);
            assert!(
                result.is_err(),
                "an ancestor swap must fail closed, got {:?}",
                result.unwrap()
            );
        }

        // ---- list_hq_dir / list_dir_entries (US-010) ----------------------

        /// Build a fixture HQ root with the canonical top-level folders plus
        /// some noise, returning the root path.
        fn make_hq_root(tmp: &TempDir) -> PathBuf {
            let root = tmp.path().to_path_buf();
            for dir in ["companies", "repos", "core", "personal", "workspace"] {
                fs::create_dir_all(root.join(dir)).unwrap();
            }
            // A child under repos/ so it reports has_children.
            fs::create_dir_all(root.join("repos").join("public").join("hq-sync")).unwrap();
            // core/ has a file so it is non-empty too.
            fs::write(root.join("core").join("core.yaml"), "version: 1\n").unwrap();
            // workspace/ is empty (no visible children).
            // Top-level noise that MUST be filtered.
            fs::create_dir_all(root.join("node_modules")).unwrap();
            fs::create_dir_all(root.join(".git")).unwrap();
            fs::write(root.join(".DS_Store"), "x").unwrap();
            // A top-level real file stays visible.
            fs::write(root.join("README.md"), "# hq\n").unwrap();
            root
        }

        #[test]
        fn list_dir_entries_lists_hq_root_top_level() {
            use super::super::list_dir_entries;
            let tmp = TempDir::new().unwrap();
            let root = make_hq_root(&tmp);

            // Empty path = HQ root.
            let entries = list_dir_entries(&root, "").unwrap();
            let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

            // Canonical top-level folders present.
            for dir in ["companies", "repos", "core", "personal", "workspace"] {
                assert!(names.contains(&dir), "missing top-level {dir}");
            }
            // Real top-level file present.
            assert!(names.contains(&"README.md"));
            // Noise filtered at the root.
            assert!(!names.contains(&"node_modules"));
            assert!(!names.contains(&".git"));
            assert!(!names.contains(&".DS_Store"));

            // Dirs sort before files (README.md last), each group alphabetical.
            assert_eq!(
                names,
                vec![
                    "companies",
                    "core",
                    "personal",
                    "repos",
                    "workspace",
                    "README.md"
                ]
            );

            // Only immediate children — paths are single-segment at the root.
            for e in &entries {
                assert!(
                    !e.path.contains('/'),
                    "root entry path not flat: {}",
                    e.path
                );
            }
        }

        #[test]
        fn list_dir_entries_reports_has_children_without_recursing() {
            use super::super::list_dir_entries;
            let tmp = TempDir::new().unwrap();
            let root = make_hq_root(&tmp);

            let entries = list_dir_entries(&root, "").unwrap();
            let by_name = |n: &str| entries.iter().find(|e| e.name == n).unwrap();

            // repos/ has a child (repos/public) → has_children true; no recursion
            // means its own `children`/payload is not walked (DirEntry is flat).
            assert!(by_name("repos").is_dir);
            assert!(by_name("repos").has_children);
            assert!(by_name("core").has_children);
            // workspace/ is empty → no expand affordance.
            assert!(!by_name("workspace").has_children);
            // Files never report has_children.
            assert!(!by_name("README.md").is_dir);
            assert!(!by_name("README.md").has_children);
        }

        #[test]
        fn list_dir_entries_lists_nested_path() {
            use super::super::list_dir_entries;
            let tmp = TempDir::new().unwrap();
            let root = make_hq_root(&tmp);

            let entries = list_dir_entries(&root, "repos").unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].name, "public");
            // Child paths are HQ-relative, forward-slash joined.
            assert_eq!(entries[0].path, "repos/public");
            assert!(entries[0].has_children);
        }

        #[test]
        fn list_dir_entries_rejects_traversal_and_missing() {
            use super::super::list_dir_entries;
            let tmp = TempDir::new().unwrap();
            let root = make_hq_root(&tmp);

            // Traversal escapes the HQ folder.
            let err = list_dir_entries(&root, "../../etc").unwrap_err();
            assert!(err.contains("invalid HQ-relative path"), "got: {err}");
            // A `..` segment embedded mid-path also escapes.
            let mid_err = list_dir_entries(&root, "repos/../../etc").unwrap_err();
            assert!(
                mid_err.contains("invalid HQ-relative path"),
                "got: {mid_err}"
            );
            // Absolute-looking input is rejected by the cross-platform path
            // contract rather than repaired into a different relative path.
            let abs_err = list_dir_entries(&root, "/etc").unwrap_err();
            assert!(
                abs_err.contains("invalid HQ-relative path"),
                "got: {abs_err}"
            );
            // Nonexistent dir.
            assert!(list_dir_entries(&root, "nope").is_err());
            // A file path (not a dir) is rejected.
            assert!(list_dir_entries(&root, "README.md").is_err());
        }

        #[test]
        fn list_dir_entries_rejects_cross_company_parent_traversal() {
            use super::super::list_dir_entries;
            let tmp = TempDir::new().unwrap();
            let root = make_hq_root(&tmp);
            fs::create_dir_all(root.join("companies").join("pending")).unwrap();

            let err = list_dir_entries(&root, "companies/indigo/../pending").unwrap_err();
            assert!(err.contains("invalid HQ-relative path"), "got: {err}");
        }
    }
}
