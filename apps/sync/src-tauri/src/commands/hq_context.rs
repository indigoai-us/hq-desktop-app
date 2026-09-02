//! Tauri surface for HQ-native context in the in-app Sessions composer.
//!
//! Every command here is a thin, `Result<T, String>` wrapper over the pure
//! readers in [`hq_desktop_core::hq_context`] — the parsing, bounding and
//! privacy rules live there and are unit-tested there. This layer only:
//!
//!   * resolves the HQ root (`workspaces::resolve_hq_folder_path`),
//!   * coerces the renderer's `u32` limits into the readers' `usize`, and
//!   * for the share preflight, maps a company **slug** to its cloud UID and
//!     forwards to the existing hq-pro clients in [`crate::commands::messages`].
//!
//! All payloads serialize camelCase.

use hq_desktop_core::hq_context::meetings::{recent_meetings, MeetingEntry};
use hq_desktop_core::hq_context::projects::{list_company_projects, ProjectEntry};
use hq_desktop_core::hq_context::signals::{list_signals, SignalEntry};
use hq_desktop_core::hq_context::skills::{build_skill_catalog_cached, SkillCatalog};
use hq_desktop_core::hq_context::vault::{
    list_vault_files, read_reference_text, ReferenceText, VaultEntry,
};
use hq_desktop_core::workspaces::{read_manifest, resolve_hq_folder_path, ManifestLoad};
use serde::{Deserialize, Serialize};

/// Workers + skills the composer can offer, optionally scoped to one company.
///
/// Company scoping drops other tenants' workers and skills; core, personal and
/// package skills — and company-less shared workers — always come back. The
/// result is cached in-process for 60 s (invalidated early when
/// `core/workers/registry.yaml` or `.claude/skills` changes).
#[tauri::command]
pub fn hq_skill_catalog(company: Option<String>) -> Result<SkillCatalog, String> {
    let hq_root = resolve_hq_folder_path()?;
    Ok(build_skill_catalog_cached(&hq_root, company.as_deref()))
}

/// A company's projects, most recent activity (`prd.json` or journal) first,
/// archived ones included and flagged, capped at 200.
#[tauri::command]
pub fn hq_company_projects(company: String) -> Result<Vec<ProjectEntry>, String> {
    let hq_root = resolve_hq_folder_path()?;
    Ok(list_company_projects(&hq_root, &company))
}

/// A company's most recent meeting transcripts, newest first.
/// `limit` defaults to 20 and is capped at 100.
#[tauri::command]
pub fn hq_recent_meetings(
    company: String,
    limit: Option<u32>,
) -> Result<Vec<MeetingEntry>, String> {
    let hq_root = resolve_hq_folder_path()?;
    Ok(recent_meetings(&hq_root, &company, as_usize(limit)))
}

/// A company's extracted signals, newest first, optionally filtered to one
/// `kind` (`decision`, `action_item`, `key_point`, `question`, `risk`,
/// `summary`, `commitment`, `participant_contribution`, …). Capped at 50.
#[tauri::command]
pub fn hq_signals(
    company: String,
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SignalEntry>, String> {
    let hq_root = resolve_hq_folder_path()?;
    Ok(list_signals(
        &hq_root,
        &company,
        kind.as_deref(),
        as_usize(limit),
    ))
}

/// One level of a company's local folder, dirs first. `prefix` is relative to
/// `companies/{company}`; `query` is a case-insensitive name filter. Capped at
/// 200 entries. Privacy classes (`settings/`, `data/`, `workers/`, `.git/`) are
/// never listed or descended into.
#[tauri::command]
pub fn hq_vault_files(
    company: String,
    prefix: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<VaultEntry>, String> {
    let hq_root = resolve_hq_folder_path()?;
    list_vault_files(
        &hq_root,
        &company,
        prefix.as_deref(),
        query.as_deref(),
        as_usize(limit),
    )
}

/// Read a bounded slice of a text file under the HQ root for the composer's
/// "attach as context" flow. `maxChars` is capped at 20 000. Rejects anything
/// outside the HQ root, anything through a privacy class, non-files, and
/// binary content.
#[tauri::command]
pub fn hq_reference_text(path: String, max_chars: Option<u32>) -> Result<ReferenceText, String> {
    let hq_root = resolve_hq_folder_path()?;
    read_reference_text(&hq_root, &path, as_usize(max_chars))
}

// ── share-to-channel preflight ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightChannel {
    pub channel_id: String,
    pub name: String,
    /// Channel scope as reported by hq-pro: `personal` | `company` | `group` |
    /// `project`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightMember {
    pub uid: String,
    pub display_name: String,
    /// `"human"` | `"agent"`.
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreflight {
    pub channels: Vec<PreflightChannel>,
    pub members: Vec<PreflightMember>,
}

/// Read-only listing of the channels and members a Sessions result *could* be
/// shared with, so the frontend can render a "Share to channel / invite"
/// picker.
///
/// This command performs **no mutation**: it does not share, invite, or post.
/// It reuses the existing hq-pro clients ([`crate::commands::messages`]) so
/// there is exactly one HTTP path to that API.
///
/// A company with no `cloud_uid` in `companies/manifest.yaml` is not
/// cloud-backed, so there is nothing to share to — that returns an empty
/// preflight rather than an error.
#[tauri::command]
pub async fn hq_share_to_channel_preflight(company: String) -> Result<SharePreflight, String> {
    let hq_root = resolve_hq_folder_path()?;
    let Some(company_uid) = company_cloud_uid(&hq_root, &company) else {
        return Ok(SharePreflight::default());
    };

    let channels = crate::commands::messages::list_channels(Some(company_uid.clone()), Some(true))
        .await?
        .channels
        .into_iter()
        .filter(|channel| {
            // Personal-scope channels carry no company; company/project ones
            // must belong to the requested company.
            channel
                .company_uid
                .as_deref()
                .map(|uid| uid == company_uid)
                .unwrap_or(true)
        })
        .map(|channel| PreflightChannel {
            channel_id: channel.channel_id,
            name: channel.name,
            kind: channel.scope,
        })
        .collect();

    let members = crate::commands::messages::list_company_members(company_uid)
        .await?
        .contacts
        .into_iter()
        .map(|contact| PreflightMember {
            kind: principal_kind(&contact.person_uid).to_string(),
            display_name: if contact.display_name.trim().is_empty() {
                contact.email.clone()
            } else {
                contact.display_name.clone()
            },
            uid: contact.person_uid,
        })
        .collect();

    Ok(SharePreflight { channels, members })
}

/// Map a company slug to its `cmp_*` cloud UID via `companies/manifest.yaml`.
fn company_cloud_uid(hq_root: &std::path::Path, company: &str) -> Option<String> {
    let company = company.trim();
    if company.is_empty() {
        return None;
    }
    let ManifestLoad::Present(entries) = read_manifest(hq_root) else {
        return None;
    };
    entries
        .into_iter()
        .find(|entry| entry.slug == company)
        .and_then(|entry| entry.cloud_uid)
        .filter(|uid| !uid.trim().is_empty())
}

/// Classify a messaging principal. Fleet agents carry an `agt_` / `agent:`
/// prefix on the wire (same convention the channel-files uploader field
/// documents); everything else is a person.
fn principal_kind(uid: &str) -> &'static str {
    let uid = uid.trim();
    if uid.starts_with("agt_") || uid.starts_with("agent:") {
        "agent"
    } else {
        "human"
    }
}

/// Renderer limits arrive as `u32`; `0`/absent means "use the reader's
/// documented default", and every reader clamps to its own hard cap.
fn as_usize(value: Option<u32>) -> usize {
    value.unwrap_or(0) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn principal_kind_splits_agents_from_humans() {
        assert_eq!(principal_kind("prs_01KQ2RY9VB1S105X2GZ2EPHKWY"), "human");
        assert_eq!(principal_kind("agt_01KQ2RY9VB1S105X2GZ2EPHKWY"), "agent");
        assert_eq!(principal_kind("agent:amelia"), "agent");
        assert_eq!(principal_kind(" prs_x "), "human");
        assert_eq!(principal_kind(""), "human");
    }

    #[test]
    fn limits_pass_through_with_zero_as_the_default_sentinel() {
        assert_eq!(as_usize(None), 0);
        assert_eq!(as_usize(Some(0)), 0);
        assert_eq!(as_usize(Some(25)), 25);
    }

    #[test]
    fn cloud_uid_is_resolved_from_the_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("companies")).unwrap();
        fs::write(
            tmp.path().join("companies/manifest.yaml"),
            "companies:\n  indigo:\n    name: Indigo\n    cloud_uid: cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG\n  bissell:\n    name: Bissell\n",
        )
        .unwrap();
        assert_eq!(
            company_cloud_uid(tmp.path(), "indigo").as_deref(),
            Some("cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG")
        );
        // Local-only company (no cloud_uid) → nothing to share to.
        assert_eq!(company_cloud_uid(tmp.path(), "bissell"), None);
        assert_eq!(company_cloud_uid(tmp.path(), "nope"), None);
        assert_eq!(company_cloud_uid(tmp.path(), "  "), None);
    }

    #[test]
    fn missing_manifest_yields_no_cloud_uid_rather_than_panicking() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(company_cloud_uid(tmp.path(), "indigo"), None);
    }
}
