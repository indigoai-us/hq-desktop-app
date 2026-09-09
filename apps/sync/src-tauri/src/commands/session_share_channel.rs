//! Tauri surface: turn an in-app session into a project channel.
//!
//! `session_share_to_channel` resolves (or creates) a company channel, invites
//! people, and posts ONE message carrying provenance, the operator's note, a
//! bounded secret-scrubbed transcript digest, and an `Open in HQ` deep link.
//! It is outward-facing — invites and posts reach other people — so the UI
//! only calls it after the operator confirms.
//!
//! Every rule lives in [`hq_desktop_core::session_share`] (digest, message
//! shape, naming, mutation order); this layer resolves the session, maps the
//! company slug to its cloud UID, and drives the existing hq-pro clients in
//! [`crate::commands::messages`]:
//!
//!   GET  /v1/notify/channels?companyUid=…&includeCompanyProjects=1
//!   POST /v1/notify/channels                         (new channel only)
//!   POST /v1/notify/channels/{id}/members {}         (self-join when invited)
//!   GET  /v1/notify/channels/{id}/members
//!   POST /v1/notify/channels/{id}/members {toPersonUid}  (one per invitee)
//!   POST /v1/notify/channels/{id}/messages {body}     (exactly once)
//!
//! Idempotent by construction: an existing same-named channel is reused,
//! members already on the roster are skipped, and a second call posts a
//! second message rather than failing.

use std::path::Path;

use hq_desktop_core::agent_session::types::SessionTool;
use hq_desktop_core::messages::{esc_seg, Channel};
use hq_desktop_core::session_share::{
    channel_name_matches, compose_share_message, digest_turns, plan_share, render_digest,
    ShareArgs, ShareHeader, ShareStep, ShareTarget,
};
use hq_desktop_core::workspaces::{read_manifest, resolve_hq_folder_path, ManifestLoad};
use serde::{Deserialize, Serialize};

use crate::commands::agent_session::{agent_session_list, agent_session_replay};
use crate::commands::cognito;
use crate::commands::messages;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "session-share";

/// Per-invitee outcome. `skipped` marks people who were already members (no
/// request was made); `error` carries the server's message on failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteOutcome {
    pub uid: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

/// What the command reports back to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResult {
    pub channel_id: String,
    pub channel_name: String,
    /// True when this call created the channel (false when reused/attached).
    pub created: bool,
    pub invited: Vec<InviteOutcome>,
    /// The posted message's event id, when the server returned one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_event_id: Option<String>,
    /// Characters of transcript digest included in the message (0 when the
    /// transcript was not included or the session had no dialogue).
    pub digest_chars: usize,
}

/// Share a session into a company channel. See the module docs for the
/// request sequence. Errors before any mutation when the arguments, company,
/// or session cannot be resolved; after the channel exists, per-invitee
/// failures are reported rather than raised so the post still happens.
#[tauri::command]
pub async fn session_share_to_channel(args: ShareArgs) -> Result<ShareResult, String> {
    let session_id = args.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("sessionId must not be empty".to_string());
    }
    let company = args.company.trim().to_string();
    if company.is_empty() {
        return Err("company must not be empty".to_string());
    }
    // Validate the target + invite list before touching the network. The
    // roster is unknown yet, so this pass only catches shape errors.
    plan_share(&args, &[])?;

    let hq_root = resolve_hq_folder_path()?;
    let company_uid = company_cloud_uid(&hq_root, &company).ok_or_else(|| {
        format!("Company '{company}' is not cloud-connected — nothing to share to")
    })?;

    // ── Session provenance + transcript ────────────────────────────────────
    let provenance = resolve_provenance(&hq_root, &session_id).await?;
    if let Some(session_company) = provenance.company.as_deref() {
        if !session_company.trim().is_empty() && session_company.trim() != company {
            return Err(format!(
                "Session belongs to '{session_company}', not '{company}' — refusing to share across companies"
            ));
        }
    }
    let digest = if args.include_transcript {
        let events = match agent_session_replay(session_id.clone(), 0).await {
            Ok(replay) => replay.events.into_iter().map(|entry| entry.event).collect(),
            Err(_) => {
                let tool = match provenance.tool.as_str() {
                    "codex" => SessionTool::Codex,
                    "claude" => SessionTool::Claude,
                    "grok" => SessionTool::Grok,
                    _ => return Err("Unknown transcript provider".into()),
                };
                super::agent_session::agent_session_history_page(session_id.clone(), None, Some(tool))
                    .await.map_err(|e| format!("Transcript unavailable: {e}"))?
                    .events.into_iter().map(|entry| entry.event).collect::<Vec<_>>()
            }
        };
        let rendered = render_digest(&digest_turns(&events));
        if rendered.is_empty() {
            return Err("Transcript unavailable. Nothing was shared; reopen the session and retry.".into());
        } else {
            Some(rendered)
        }
    } else {
        None
    };
    let digest_chars = digest.as_deref().map(|d| d.chars().count()).unwrap_or(0);

    // ── Step 1: resolve the channel ────────────────────────────────────────
    let project_id = selected_project_id(&hq_root, &company, &args.target)?;
    let (channel, created) = resolve_channel(&args.target, &company_uid, project_id.as_deref()).await?;
    let channel_id = channel.channel_id.clone();
    let channel_name = channel.name.clone();

    // ── Step 2: invites (skip current members) ─────────────────────────────
    let roster: Vec<String> = messages::list_channel_members(channel_id.clone())
        .await?
        .members
        .into_iter()
        .map(|m| m.person_uid)
        .collect();
    let steps = plan_share(&args, &roster)?;
    let mut invited: Vec<InviteOutcome> = Vec::new();
    let mut posted_event_id: Option<String> = None;
    for step in steps {
        match step {
            ShareStep::VerifyMembership { .. } | ShareStep::EnsureChannel { .. } => {
                // Already performed by `resolve_channel` above.
            }
            ShareStep::SkipInvite { uid } => invited.push(InviteOutcome {
                uid,
                ok: true,
                error: None,
                skipped: true,
            }),
            ShareStep::Invite { uid } => {
                let outcome = match messages::invite_to_channel(
                    channel_id.clone(),
                    vec![uid.clone()],
                )
                .await
                {
                    Ok(_) => InviteOutcome {
                        uid,
                        ok: true,
                        error: None,
                        skipped: false,
                    },
                    Err(e) => {
                        log(
                            LOG_TAG,
                            &format!("SESSION_SHARE_INVITE_FAIL channel={channel_id} {e}"),
                        );
                        InviteOutcome {
                            uid,
                            ok: false,
                            error: Some(e),
                            skipped: false,
                        }
                    }
                };
                invited.push(outcome);
            }
            // ── Step 3: post exactly one message ──────────────────────────
            ShareStep::Post { .. } => {
                let header = ShareHeader {
                    tool: provenance.tool.clone(),
                    model: provenance.model.clone().unwrap_or_default(),
                    company: company.clone(),
                };
                let body = compose_share_message(
                    &header,
                    args.note.as_deref(),
                    digest.as_deref(),
                    &session_id,
                );
                posted_event_id = post_channel_message(&channel_id, &body).await?;
            }
        }
    }

    log(
        LOG_TAG,
        &format!(
            "SESSION_SHARE_OK session={session_id} channel={channel_id} created={created} invited={} failed={} posted={} digest_chars={digest_chars}",
            invited.iter().filter(|i| i.ok && !i.skipped).count(),
            invited.iter().filter(|i| !i.ok).count(),
            posted_event_id.is_some()
        ),
    );

    Ok(ShareResult {
        channel_id,
        channel_name,
        created,
        invited,
        posted_event_id,
        digest_chars,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel resolution
// ─────────────────────────────────────────────────────────────────────────────

/// Existing target → the channel must be visible to the caller and, unless
/// the server left membership unstated, joined (an outstanding invite is
/// accepted). New target → reuse a same-named company channel when one is
/// visible, else create it. Returns `(channel, created)`.
fn selected_project_id(hq_root: &Path, company: &str, target: &ShareTarget) -> Result<Option<String>, String> {
    let ShareTarget::New { project_path: Some(path), .. } = target else { return Ok(None); };
    let slug = hq_desktop_core::session_links::project_slug(path);
    let project = hq_desktop_core::hq_context::projects::find_company_project(hq_root, company, &slug)
        .ok_or("Selected project is unavailable in this company")?;
    let selected = std::fs::canonicalize(path).map_err(|_| "Selected project is unavailable")?;
    let expected = std::fs::canonicalize(&project.path).map_err(|_| "Selected project is unavailable")?;
    if selected != expected { return Err("Selected project belongs to a different company or HQ folder".into()); }
    Ok(Some(slug))
}

async fn resolve_channel(
    target: &ShareTarget,
    company_uid: &str,
    project_id: Option<&str>,
) -> Result<(Channel, bool), String> {
    let visible = messages::list_channels(Some(company_uid.to_string()), Some(true))
        .await?
        .channels;

    match target {
        ShareTarget::Existing { channel_id } => {
            let id = channel_id.trim();
            let channel = visible
                .into_iter()
                .find(|c| c.channel_id == id)
                .ok_or_else(|| {
                    "Channel not found — it may have been deleted or you may not have access"
                        .to_string()
                })?;
            if let Some(other) = channel.company_uid.as_deref() {
                if other != company_uid {
                    return Err("Channel belongs to a different company".to_string());
                }
            }
            let channel = ensure_joined(channel).await?;
            Ok((channel, false))
        }
        ShareTarget::New { name, project_path } => {
            let name = hq_desktop_core::session_share::resolve_new_channel_name(
                name,
                project_path.as_deref(),
            )?;
            let existing = visible.into_iter().find(|c| {
                c.company_uid.as_deref() == Some(company_uid)
                    && channel_name_matches(&c.name, &name)
            });
            if let Some(channel) = existing {
                if project_id.is_some() && channel.project_id.as_deref() != project_id {
                    return Err("A channel with this name exists but is not linked to the selected project. Choose a different channel name.".into());
                }
                log(
                    LOG_TAG,
                    &format!(
                        "SESSION_SHARE_CHANNEL_REUSE id={} name={name}",
                        channel.channel_id
                    ),
                );
                let channel = ensure_joined(channel).await?;
                return Ok((channel, false));
            }
            let channel = messages::create_channel(
                name.clone(),
                if project_id.is_some() { "project" } else { "company" }.to_string(),
                Some(company_uid.to_string()),
                None,
                project_id.map(str::to_string),
            )
            .await?;
            log(
                LOG_TAG,
                &format!(
                    "SESSION_SHARE_CHANNEL_CREATE id={} name={name}",
                    channel.channel_id
                ),
            );
            Ok((channel, true))
        }
    }
}

/// Accept an outstanding invite; refuse when the server says the caller is
/// not a member at all. `None` membership (older servers / owner listings)
/// proceeds — the post itself will surface a policy rejection.
async fn ensure_joined(channel: Channel) -> Result<Channel, String> {
    match channel.membership.as_deref() {
        Some("joined") | None => Ok(channel),
        Some("invited") => {
            let joined = messages::join_channel(channel.channel_id.clone()).await?;
            Ok(joined)
        }
        Some(_) => Err(format!(
            "You are not a member of #{} — join it first",
            channel.name
        )),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session provenance
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct Provenance {
    tool: String,
    model: Option<String>,
    company: Option<String>,
}

/// The live registry first (tool + resolved model + company); a session that
/// already left the registry falls back to its `meta.yaml` on disk (no model).
async fn resolve_provenance(hq_root: &Path, session_id: &str) -> Result<Provenance, String> {
    if let Ok(sessions) = agent_session_list().await {
        if let Some(summary) = sessions.into_iter().find(|s| s.session_id == session_id) {
            return Ok(Provenance {
                tool: tool_label(summary.tool).to_string(),
                model: summary.model.or(summary.requested_model),
                company: summary.company,
            });
        }
    }
    let root = hq_root.to_path_buf();
    let id = session_id.to_string();
    let meta = tokio::time::timeout(std::time::Duration::from_secs(3), tokio::task::spawn_blocking(move || read_session_meta(&root, &id)))
        .await.map_err(|_| "Session metadata read timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let observed = super::sessions::cached_agent_sessions();
    historical_provenance(meta, observed.iter().find(|row| row.id == session_id))
        .ok_or_else(|| format!("Provider metadata unavailable for session {session_id}. Reopen history and retry."))
}

fn historical_provenance(meta: Option<Provenance>, observed: Option<&hq_desktop_core::sessions::AgentSession>) -> Option<Provenance> {
    if let Some(row) = observed {
        use hq_desktop_core::sessions::{AgentOrigin, AgentTool};
        if row.origin != AgentOrigin::Local { return None; }
        return Some(Provenance {
            tool: match row.tool { AgentTool::Claude => "claude", AgentTool::Codex => "codex" }.into(),
            model: (!row.model.trim().is_empty()).then(|| row.model.clone()),
            company: meta.and_then(|m| m.company).or_else(|| (!row.company.trim().is_empty()).then(|| row.company.clone())),
        });
    }
    meta.filter(|row| matches!(row.tool.as_str(), "claude" | "codex"))
}

fn tool_label(tool: SessionTool) -> &'static str {
    tool.as_str()
}

/// The subset of `workspace/sessions/<id>/meta.yaml` needed for the header.
#[derive(Debug, Default, Deserialize)]
struct SessionMeta {
    #[serde(default)]
    company_slug: Option<String>,
    #[serde(default)]
    tool: Option<String>,
}

fn read_session_meta(hq_root: &Path, session_id: &str) -> Option<Provenance> {
    // Defensive: a session id is a client-minted token, never a path.
    if session_id.contains(['/', '\\']) || session_id == "." || session_id == ".." {
        return None;
    }
    let path = hq_root
        .join("workspace")
        .join("sessions")
        .join(session_id)
        .join("meta.yaml");
    let raw = std::fs::read_to_string(path).ok()?;
    let meta: SessionMeta = serde_yaml::from_str(&raw).ok()?;
    Some(Provenance {
        tool: meta
            .tool
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .unwrap_or_default(),
        model: None,
        company: meta
            .company_slug
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty()),
    })
}

/// Map a company slug to its `cmp_*` cloud UID via `companies/manifest.yaml`.
/// Same rule as the share preflight — a local-only company has nothing to
/// share to.
pub(super) fn company_cloud_uid(hq_root: &Path, company: &str) -> Option<String> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Post (keeps the response so the event id can be reported)
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /v1/notify/channels/{id}/messages { body }`. Same wire call as
/// `messages::send_channel_message`, but the response body is kept so the
/// posted event id can be handed back to the renderer for linking.
async fn post_channel_message(channel_id: &str, body: &str) -> Result<Option<String>, String> {
    let token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("SESSION_SHARE_AUTH_FAIL {e}"));
        format!("Not signed in: {e}")
    })?;
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("Could not resolve server URL: {e}"))?;
    let url = format!("{base}/v1/notify/channels/{}/messages", esc_seg(channel_id));
    let resp = build_client()
        .post(&url)
        .header("authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("SESSION_SHARE_POST_NETWORK_FAIL {e}"));
            format!("Network error: {e}")
        })?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let server_msg = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("SESSION_SHARE_POST_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }
    log(
        LOG_TAG,
        &format!("SESSION_SHARE_POST_OK channel={channel_id}"),
    );
    Ok(serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| extract_event_id(&v)))
}

/// The posted message's id from whichever envelope the server used:
/// `{eventId}`, `{event:{eventId}}`, `{message:{eventId}}`, or `{id}`.
fn extract_event_id(value: &serde_json::Value) -> Option<String> {
    let candidates = [
        value.get("eventId"),
        value.get("event").and_then(|e| e.get("eventId")),
        value.get("message").and_then(|m| m.get("eventId")),
        value.get("event_id"),
        value.get("id"),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn project_selection_is_resolved_inside_configured_hq_and_company() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("companies/awesomeco/projects/sharing-test");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("prd.json"), r#"{"name":"Sharing test","userStories":[]}"#).unwrap();
        let target = ShareTarget::New { name: "p-sharing-test".into(), project_path: Some(project.to_string_lossy().into_owned()) };
        assert_eq!(selected_project_id(root.path(), "awesomeco", &target).unwrap(), Some("sharing-test".into()));
        assert!(selected_project_id(root.path(), "other-company", &target).is_err());
        let other_root = tempfile::tempdir().unwrap();
        assert!(selected_project_id(other_root.path(), "awesomeco", &target).is_err());
        assert_eq!(selected_project_id(root.path(), "awesomeco", &ShareTarget::New { name: "general".into(), project_path: None }).unwrap(), None);
    }

    #[test]
    fn event_id_is_read_from_every_known_envelope() {
        for (raw, expected) in [
            (r#"{"eventId":"evt_1"}"#, Some("evt_1")),
            (r#"{"event":{"eventId":"evt_2"}}"#, Some("evt_2")),
            (
                r#"{"message":{"eventId":"evt_3","body":"x"}}"#,
                Some("evt_3"),
            ),
            (r#"{"event_id":"evt_4"}"#, Some("evt_4")),
            (r#"{"id":"evt_5"}"#, Some("evt_5")),
            (r#"{"eventId":"  "}"#, None),
            (r#"{"ok":true}"#, None),
            (r#"{"eventId":42}"#, None),
        ] {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert_eq!(extract_event_id(&value).as_deref(), expected, "{raw}");
        }
    }

    #[test]
    fn cloud_uid_is_resolved_from_the_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("companies")).unwrap();
        fs::write(
            tmp.path().join("companies/manifest.yaml"),
            "companies:\n  indigo:\n    name: Indigo\n    cloud_uid: cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG\n  local:\n    name: Local\n",
        )
        .unwrap();
        assert_eq!(
            company_cloud_uid(tmp.path(), "indigo").as_deref(),
            Some("cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG")
        );
        assert_eq!(company_cloud_uid(tmp.path(), "local"), None);
        assert_eq!(company_cloud_uid(tmp.path(), ""), None);
    }

    #[test]
    fn session_meta_fallback_reads_tool_and_company_and_rejects_path_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("workspace/sessions/sess-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("meta.yaml"),
            "session_id: sess-1\ncompany_slug: indigo\nstarted_at: 2026-09-02T00:00:00Z\ntool: Codex\n",
        )
        .unwrap();
        assert_eq!(
            read_session_meta(tmp.path(), "sess-1"),
            Some(Provenance {
                tool: "codex".into(),
                model: None,
                company: Some("indigo".into()),
            })
        );
        // Missing provider is unknown, never silently classified as Claude.
        let bare = tmp.path().join("workspace/sessions/sess-2");
        fs::create_dir_all(&bare).unwrap();
        fs::write(bare.join("meta.yaml"), "session_id: sess-2\n").unwrap();
        assert_eq!(
            read_session_meta(tmp.path(), "sess-2"),
            Some(Provenance {
                tool: "".into(),
                model: None,
                company: None,
            })
        );
        assert_eq!(read_session_meta(tmp.path(), "nope"), None);
        assert_eq!(read_session_meta(tmp.path(), "../sess-1"), None);
        assert_eq!(read_session_meta(tmp.path(), ".."), None);
    }

    #[test]
    fn sparse_historical_metadata_uses_native_provider_not_claude_default() {
        let row: hq_desktop_core::sessions::AgentSession = serde_json::from_value(serde_json::json!({
            "id":"native", "tool":"codex", "origin":"local", "title":"Test", "status":"ended",
            "company":"awesomeco", "model":"codex-test", "source":"test"
        })).unwrap();
        let sparse = Provenance { tool: String::new(), company: Some("awesomeco".into()), model: None };
        assert!(historical_provenance(Some(sparse.clone()), None).is_none());
        let resolved = historical_provenance(Some(sparse), Some(&row)).unwrap();
        assert_eq!(resolved.tool, "codex");
        assert_eq!(resolved.model.as_deref(), Some("codex-test"));
        assert_eq!(resolved.company.as_deref(), Some("awesomeco"));
    }

    #[test]
    fn tool_labels_match_the_wire_spelling() {
        assert_eq!(tool_label(SessionTool::Claude), "claude");
        assert_eq!(tool_label(SessionTool::Codex), "codex");
        assert_eq!(tool_label(SessionTool::Grok), "grok");
    }

    #[test]
    fn share_result_serializes_camel_case_and_omits_empty_optionals() {
        let result = ShareResult {
            channel_id: "ch_1".into(),
            channel_name: "p-alpha".into(),
            created: true,
            invited: vec![
                InviteOutcome {
                    uid: "prs_a".into(),
                    ok: true,
                    error: None,
                    skipped: false,
                },
                InviteOutcome {
                    uid: "prs_b".into(),
                    ok: true,
                    error: None,
                    skipped: true,
                },
                InviteOutcome {
                    uid: "prs_c".into(),
                    ok: false,
                    error: Some("not in company".into()),
                    skipped: false,
                },
            ],
            posted_event_id: None,
            digest_chars: 0,
        };
        let raw = serde_json::to_value(&result).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({
                "channelId": "ch_1",
                "channelName": "p-alpha",
                "created": true,
                "invited": [
                    {"uid": "prs_a", "ok": true},
                    {"uid": "prs_b", "ok": true, "skipped": true},
                    {"uid": "prs_c", "ok": false, "error": "not in company"}
                ],
                "digestChars": 0
            })
        );
        let with_event = ShareResult {
            posted_event_id: Some("evt_9".into()),
            digest_chars: 120,
            ..result
        };
        let raw = serde_json::to_value(&with_event).unwrap();
        assert_eq!(raw["postedEventId"], "evt_9");
        assert_eq!(raw["digestChars"], 120);
    }
}
