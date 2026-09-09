//! Sessions composer `@`-mentions: who can be mentioned, and the DM fan-out.
//!
//! Typing `@` in the in-app Sessions composer opens a picker of the people and
//! fleet agents the signed-in user can reach INSIDE the session's company. On
//! send, the session line goes to the CLI as usual (it sees the literal
//! `@Name` tokens) and, for every mention the user kept as a visible chip, the
//! app sends that recipient an ordinary HQ DM carrying the message text plus a
//! short context line ("From Jacob's Claude session in indigo · open:
//! sessions:<id>") in the DM's `details` slot.
//!
//! Directory — no new HTTP endpoint. Candidates are the company-scoped slice
//! of the existing DM contacts surface (`messages::list_company_members` →
//! `GET /v1/notify/contacts?companyUid=`), which the Messages shell already
//! uses. Fleet agents ride that same list: `/new-agent` gives an agent an
//! active membership in its host company, so it appears as a member whose uid
//! is `agt_*` — exactly how the Messages rail tells agents apart. The company
//! slug on the composer pill is resolved to its cloud uid from the local
//! manifest first (no network), falling back to the caller-scoped slug lookup.
//!
//! Send — the existing `send_dm` path. `dm_notify::post_dm_payload` is the
//! factored-out POST behind `send_dm`; this module only builds the richer
//! payload (`toPersonUid` + `body` + `details`, the same wire shape `hq dm
//! --details` uses; `agt_*` rides `toPersonUid` like the CLI). Nothing here
//! reads the transcript: the body is the one message the user typed, clamped,
//! and the context line is built from four bounded, non-secret fields.
//!
//! Both commands sit behind the in-app-sessions feature flag and the same
//! sign-in check the messaging commands use. The candidate list is cached for
//! 60 s per company so reopening the picker does not refetch the directory.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hq_desktop_core::agent_session_flags::ensure_in_app_sessions_allowed;
use hq_desktop_core::messages::Contact;
use hq_desktop_core::workspaces::{discover_local_companies, resolve_hq_folder_path};
use serde::{Deserialize, Serialize};

use crate::commands::{cognito, config, dm_notify, messages};
use crate::util::logfile::log;

const LOG_TAG: &str = "session-mentions";

/// How long one company's candidate list is reused before refetching.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// The most recipients one send fans out to — a mention list, not a broadcast.
pub const MAX_RECIPIENTS: usize = 12;
/// The DM body is the one line the user typed; anything longer is clipped.
pub const MAX_BODY_CHARS: usize = 4000;
/// Each name that lands in the context line is clipped to this.
const MAX_NAME_CHARS: usize = 48;
/// The session id in the context line — ids are short; anything else is not one.
const MAX_SESSION_ID_CHARS: usize = 64;
/// Hard ceiling on the whole context line.
pub const MAX_CONTEXT_CHARS: usize = 240;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────────────

/// Whether a mention target is a person or a fleet agent — decided by the uid
/// prefix, the same rule the Messages rail applies (`agt_` = agent).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum MentionKind {
    Human,
    Agent,
}

/// One row of the `@` picker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MentionCandidate {
    pub uid: String,
    pub display_name: String,
    pub kind: MentionKind,
    /// People only. An agent's machine address is never surfaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// Per-recipient outcome of one mention fan-out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MentionDelivery {
    pub uid: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/// Classify a directory uid. `None` for anything that is neither a person nor
/// an agent (channel ids, blanks, legacy rows) — those never become mentions.
pub fn mention_kind_for_uid(uid: &str) -> Option<MentionKind> {
    let uid = uid.trim();
    if uid.starts_with("prs_") {
        Some(MentionKind::Human)
    } else if uid.starts_with("agt_") || uid.starts_with("agent_") || uid.starts_with("agent:") {
        Some(MentionKind::Agent)
    } else {
        None
    }
}

fn clean(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The name a candidate is shown (and inserted) under. A person with no name
/// falls back to the local part of their email; an agent with no name to its
/// uid — never to a machine mailbox.
fn display_name_for(contact: &Contact, kind: MentionKind) -> String {
    if let Some(name) = clean(&contact.display_name) {
        return name;
    }
    if kind == MentionKind::Human {
        if let Some(email) = clean(&contact.email) {
            return email.split('@').next().unwrap_or(&email).to_string();
        }
    }
    contact.person_uid.trim().to_string()
}

/// Turn the directory rows for one company into the picker's rows.
///
/// - the caller is never a candidate (a DM to yourself from your own session
///   is noise, and the server rejects self-DMs anyway),
/// - uids that are neither `prs_*` nor `agt_*` are dropped,
/// - duplicates collapse onto one row, the first named one winning,
/// - people sort before agents; within a kind, by name (case-insensitive),
///   then uid, so the order is stable across refetches.
pub fn compose_candidates(contacts: &[Contact], self_uid: Option<&str>) -> Vec<MentionCandidate> {
    let self_uid = self_uid.map(str::trim).filter(|s| !s.is_empty());
    // uid → (has a real display name, row). The flag is tracked separately
    // because an unnamed person is SHOWN under an email fallback, which must
    // not count as a name when a later row carries the real one.
    let mut by_uid: HashMap<String, (bool, MentionCandidate)> = HashMap::new();
    for contact in contacts {
        let uid = contact.person_uid.trim();
        if uid.is_empty() || Some(uid) == self_uid {
            continue;
        }
        let Some(kind) = mention_kind_for_uid(uid) else {
            continue;
        };
        let named = clean(&contact.display_name).is_some();
        let candidate = MentionCandidate {
            uid: uid.to_string(),
            display_name: display_name_for(contact, kind),
            kind,
            email: match kind {
                MentionKind::Human => clean(&contact.email),
                MentionKind::Agent => None,
            },
        };
        match by_uid.get_mut(uid) {
            None => {
                by_uid.insert(uid.to_string(), (named, candidate));
            }
            Some((existing_named, existing)) => {
                // Keep the richer row: a named entry beats an unnamed one, and
                // an email fills in on a row that had none.
                if named && !*existing_named {
                    let email = candidate.email.clone().or_else(|| existing.email.clone());
                    *existing = MentionCandidate { email, ..candidate };
                    *existing_named = true;
                } else if existing.email.is_none() && candidate.email.is_some() {
                    existing.email = candidate.email;
                }
            }
        }
    }
    let mut out: Vec<MentionCandidate> = by_uid.into_values().map(|(_, row)| row).collect();
    out.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
            .then_with(|| a.uid.cmp(&b.uid))
    });
    out
}

/// Clip to `max` characters (not bytes), marking the cut with an ellipsis.
fn clip(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max {
        return value.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut out: String = value.chars().take(keep).collect();
    out.push('…');
    out
}

/// One line, no control characters: the context line is rendered in a
/// notification detail window, and a newline in a name must not become a
/// second line of "context".
fn single_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The possessive first name for the context line: "Jacob's", "Iris'".
fn possessive_first_name(sender: &str) -> String {
    let first = single_line(sender)
        .split_whitespace()
        .next()
        .map(str::to_string)
        .unwrap_or_default();
    let first = clip(&first, MAX_NAME_CHARS);
    if first.is_empty() {
        return "A teammate's".to_string();
    }
    if first.ends_with('s') || first.ends_with('S') {
        format!("{first}'")
    } else {
        format!("{first}'s")
    }
}

/// The CLI the session runs on, named the way the composer's tool pill does.
fn tool_label(tool: Option<&str>) -> &'static str {
    match tool.map(|t| t.trim().to_ascii_lowercase()).as_deref() {
        Some("claude") => "Claude",
        Some("codex") => "Codex",
        Some("grok") => "Grok",
        _ => "agent",
    }
}

/// A session id as it may appear in a deep link: word characters, dots and
/// dashes only, clipped. Anything else is not an id and is not echoed.
fn safe_session_id(session_id: &str) -> String {
    session_id
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(MAX_SESSION_ID_CHARS)
        .collect()
}

/// The short context line that rides every mention DM as its `details`.
///
///   From Jacob's Claude session in indigo · open: sessions:abc123
///
/// Built from four bounded, non-secret fields — a first name, the tool label,
/// the company slug and the session id — and clipped to `MAX_CONTEXT_CHARS`,
/// so nothing from the transcript, the environment or the message itself can
/// leak through it.
pub fn build_context_line(
    sender: &str,
    tool: Option<&str>,
    company: &str,
    session_id: &str,
) -> String {
    let company = clip(&single_line(company), MAX_NAME_CHARS);
    let company = if company.is_empty() {
        "HQ".to_string()
    } else {
        company
    };
    let mut line = format!(
        "From {} {} session in {}",
        possessive_first_name(sender),
        tool_label(tool),
        company
    );
    let id = safe_session_id(session_id);
    if !id.is_empty() {
        line.push_str(&format!(" · open: sessions:{id}"));
    }
    clip(&line, MAX_CONTEXT_CHARS)
}

/// The message body a recipient sees: the one line the user typed, trimmed
/// and clipped. `None` when there is nothing to send.
pub fn clamp_body(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(clip(trimmed, MAX_BODY_CHARS))
}

/// Trim, drop anything that is not a person or agent uid, dedupe (first
/// occurrence wins), and cap the list.
pub fn normalize_recipients(recipients: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for raw in recipients {
        let uid = raw.trim();
        if mention_kind_for_uid(uid).is_none() || seen.iter().any(|s| s == uid) {
            continue;
        }
        seen.push(uid.to_string());
        if seen.len() == MAX_RECIPIENTS {
            break;
        }
    }
    seen
}

/// The exact `/v1/notify/dm` payload one mention DM sends. Same shape as
/// `hq dm <uid> <body> --details <line>`: agents ride `toPersonUid` too.
pub fn build_mention_payload(to_person_uid: &str, body: &str, details: &str) -> serde_json::Value {
    serde_json::json!({
        "toPersonUid": to_person_uid,
        "body": body,
        "details": details,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate cache
// ─────────────────────────────────────────────────────────────────────────────

struct CacheEntry {
    fetched_at: Instant,
    candidates: Vec<MentionCandidate>,
}

#[derive(Default)]
pub struct CandidateCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

impl CandidateCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get_at(&self, company: &str, now: Instant) -> Option<Vec<MentionCandidate>> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(company)?;
        if now.duration_since(entry.fetched_at) < CACHE_TTL {
            Some(entry.candidates.clone())
        } else {
            None
        }
    }

    fn put_at(&self, company: &str, candidates: Vec<MentionCandidate>, now: Instant) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                company.to_string(),
                CacheEntry {
                    fetched_at: now,
                    candidates,
                },
            );
        }
    }

    pub fn get(&self, company: &str) -> Option<Vec<MentionCandidate>> {
        self.get_at(company, Instant::now())
    }

    pub fn put(&self, company: &str, candidates: Vec<MentionCandidate>) {
        self.put_at(company, candidates, Instant::now())
    }
}

fn cache() -> &'static CandidateCache {
    static CACHE: OnceLock<CandidateCache> = OnceLock::new();
    CACHE.get_or_init(CandidateCache::new)
}

// ─────────────────────────────────────────────────────────────────────────────
// Company resolution
// ─────────────────────────────────────────────────────────────────────────────

/// The cloud uid behind a composer company slug. The local manifest is asked
/// first — it records `cloud_uid` for every cloud-backed company and costs no
/// request — then the caller-scoped slug lookup, which is unique inside the
/// signed-in user's own companies.
async fn resolve_company_uid(slug: &str) -> Result<String, String> {
    if let Ok(root) = resolve_hq_folder_path() {
        let (entries, _) = discover_local_companies(&root);
        if let Some(uid) = entries
            .iter()
            .find(|entry| entry.slug == slug)
            .and_then(|entry| entry.cloud_uid.clone())
            .filter(|uid| !uid.trim().is_empty())
        {
            return Ok(uid);
        }
    }

    let vault_url = crate::commands::sync::resolve_vault_api_url()?;
    let jwt = crate::commands::sync::resolve_jwt().await?;
    let vault = crate::commands::vault_client::VaultClient::new(&vault_url, &jwt);
    match vault.find_my_company_by_slug(slug).await {
        Ok(Some(entity)) => Ok(entity.uid),
        Ok(None) => Err(format!("No cloud company named {slug} in your memberships")),
        Err(e) => Err(format!("Could not resolve company {slug}: {e}")),
    }
}

fn self_person_uid() -> Option<String> {
    config::read_hq_config_lenient()
        .ok()
        .flatten()
        .map(|cfg| cfg.person_uid)
        .filter(|uid| !uid.trim().is_empty())
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Tauri command: the people and fleet agents the caller can `@`-mention in
/// `company`. Composes `list_company_members` (the Messages shell's own
/// directory call); cached 60 s per company.
#[tauri::command]
pub async fn session_mention_candidates(company: String) -> Result<Vec<MentionCandidate>, String> {
    ensure_in_app_sessions_allowed()?;
    let slug = company.trim().to_string();
    if slug.is_empty() {
        return Err("company must not be empty".to_string());
    }
    // Same gate the messaging commands apply: nothing is looked up signed-out.
    cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("Not signed in: {e}"))?;

    if let Some(hit) = cache().get(&slug) {
        return Ok(hit);
    }

    let company_uid = resolve_company_uid(&slug).await?;
    let members = messages::list_company_members(company_uid).await?;
    let candidates = compose_candidates(&members.contacts, self_person_uid().as_deref());
    log(
        LOG_TAG,
        &format!(
            "SESSION_MENTION_CANDIDATES_OK company={slug} humans={} agents={}",
            candidates
                .iter()
                .filter(|c| c.kind == MentionKind::Human)
                .count(),
            candidates
                .iter()
                .filter(|c| c.kind == MentionKind::Agent)
                .count(),
        ),
    );
    cache().put(&slug, candidates.clone());
    Ok(candidates)
}

/// The signed-in user's name for the context line, read from the id token
/// already on disk — no request. Empty when unknown; the line then says
/// "A teammate's".
async fn sender_display_name() -> String {
    let Ok(tokens) = cognito::get_valid_tokens().await else {
        return String::new();
    };
    let claims = tokens
        .id_token
        .as_deref()
        .and_then(|token| cognito::decode_id_token_claims(token).ok())
        .or_else(|| cognito::decode_id_token_claims(&tokens.access_token).ok());
    claims
        .map(|claims| claims.display_name())
        .unwrap_or_default()
}

/// Tauri command: DM every mentioned recipient the message text plus the
/// session context line. Called by the Sessions page AFTER the session send
/// succeeded, with only the mentions still shown as chips. Returns one row per
/// recipient; a failed DM never fails the whole call, so the page can show
/// exactly which recipient did not get it.
#[tauri::command]
pub async fn session_mention_notify(
    company: String,
    session_id: String,
    recipients: Vec<String>,
    text: String,
    tool: Option<String>,
) -> Result<Vec<MentionDelivery>, String> {
    ensure_in_app_sessions_allowed()?;
    let Some(body) = clamp_body(&text) else {
        return Err("Message body must not be empty".to_string());
    };
    let recipients = normalize_recipients(&recipients);
    if recipients.is_empty() {
        return Err("No valid mention recipients".to_string());
    }
    cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("Not signed in: {e}"))?;

    let sender = sender_display_name().await;
    let details = build_context_line(&sender, tool.as_deref(), &company, &session_id);

    let mut out = Vec::with_capacity(recipients.len());
    for uid in recipients {
        let payload = build_mention_payload(&uid, &body, &details);
        match dm_notify::post_dm_payload(&payload, "SESSION_MENTION_DM").await {
            Ok(()) => out.push(MentionDelivery {
                uid,
                ok: true,
                error: None,
            }),
            Err(error) => {
                log(
                    LOG_TAG,
                    &format!("SESSION_MENTION_DM_FAIL uid={uid} err={error}"),
                );
                out.push(MentionDelivery {
                    uid,
                    ok: false,
                    error: Some(error),
                });
            }
        }
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn contact(uid: &str, name: &str, email: &str) -> Contact {
        Contact {
            person_uid: uid.to_string(),
            email: email.to_string(),
            display_name: name.to_string(),
            avatar_url: None,
            company_uid: None,
            source: None,
            connection_state: None,
            last_message_at: None,
            last_activity_at: None,
            last_dm_at: None,
            last_message_body: None,
            last_message_preview: None,
            last_message_text: None,
            last_message_direction: None,
        }
    }

    #[test]
    fn classifies_uids_by_prefix() {
        assert_eq!(mention_kind_for_uid("prs_1"), Some(MentionKind::Human));
        assert_eq!(mention_kind_for_uid("agt_1"), Some(MentionKind::Agent));
        assert_eq!(mention_kind_for_uid("agent_1"), Some(MentionKind::Agent));
        assert_eq!(mention_kind_for_uid("agent:self"), Some(MentionKind::Agent));
        assert_eq!(mention_kind_for_uid("chn_1"), None);
        assert_eq!(mention_kind_for_uid(""), None);
    }

    #[test]
    fn composes_people_before_agents_sorted_by_name() {
        let rows = vec![
            contact("agt_zed", "Zed Agent", "zed@agents.example"),
            contact("prs_corey", "Corey Epstein", "corey@example.com"),
            contact("agt_atlas", "Atlas", "atlas@agents.example"),
            contact("prs_alex", "alex smith", "alex@example.com"),
        ];
        let out = compose_candidates(&rows, None);
        let names: Vec<&str> = out.iter().map(|c| c.display_name.as_str()).collect();
        assert_eq!(names, ["alex smith", "Corey Epstein", "Atlas", "Zed Agent"]);
        assert_eq!(out[0].kind, MentionKind::Human);
        assert_eq!(out[2].kind, MentionKind::Agent);
    }

    #[test]
    fn dedupes_by_uid_keeping_the_named_row() {
        let rows = vec![
            contact("prs_1", "", "one@example.com"),
            contact("prs_1", "One Person", ""),
            contact("prs_1", "One Person", "one@example.com"),
            contact("agt_1", "Bot", ""),
            contact("agt_1", "Bot", ""),
        ];
        let out = compose_candidates(&rows, None);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].display_name, "One Person");
        assert_eq!(out[0].email.as_deref(), Some("one@example.com"));
        assert_eq!(out[1].uid, "agt_1");
    }

    #[test]
    fn drops_self_and_non_mentionable_uids() {
        let rows = vec![
            contact("prs_me", "Me", "me@example.com"),
            contact("prs_you", "You", "you@example.com"),
            contact("chn_room", "Room", ""),
            contact("   ", "Blank", ""),
        ];
        let out = compose_candidates(&rows, Some("prs_me"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uid, "prs_you");
    }

    #[test]
    fn agents_never_surface_a_machine_mailbox() {
        let rows = vec![contact("agt_1", "", "agt-1@agents.hq.example")];
        let out = compose_candidates(&rows, None);
        assert_eq!(out[0].email, None);
        // With no name, an agent is shown by its uid — not by its mailbox.
        assert_eq!(out[0].display_name, "agt_1");
    }

    #[test]
    fn a_person_with_no_name_falls_back_to_the_email_local_part() {
        let rows = vec![contact("prs_1", "  ", "corey@example.com")];
        let out = compose_candidates(&rows, None);
        assert_eq!(out[0].display_name, "corey");
    }

    #[test]
    fn context_line_reads_as_specified() {
        let line = build_context_line("Jacob Posel", Some("claude"), "indigo", "abc-123");
        assert_eq!(
            line,
            "From Jacob's Claude session in indigo · open: sessions:abc-123"
        );
        assert_eq!(
            build_context_line("Iris", Some("codex"), "ridge", "s1"),
            "From Iris' Codex session in ridge · open: sessions:s1"
        );
    }

    #[test]
    fn context_line_has_safe_fallbacks() {
        assert_eq!(
            build_context_line("", None, "", ""),
            "From A teammate's agent session in HQ"
        );
        assert_eq!(
            build_context_line("  ", Some("weird"), "indigo", "x"),
            "From A teammate's agent session in indigo · open: sessions:x"
        );
    }

    #[test]
    fn context_line_is_bounded_and_single_line() {
        let huge_name = "N".repeat(5_000);
        let huge_company = "c\n".repeat(3_000);
        let huge_id = "i".repeat(3_000);
        let line = build_context_line(&huge_name, Some("claude"), &huge_company, &huge_id);
        assert!(
            line.chars().count() <= MAX_CONTEXT_CHARS,
            "{}",
            line.chars().count()
        );
        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
    }

    #[test]
    fn context_line_never_echoes_secret_looking_input() {
        // Only four bounded, filtered fields ever reach the line: the sender
        // is reduced to a first name, the session id to id characters. The
        // fake credentials are assembled at runtime so no key-shaped literal
        // sits in the source tree.
        let fake_key = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
        let fake_token = format!("{}{}", "ghp_", "NOTAREALTOKEN");
        let line = build_context_line(
            &format!("Jacob\n{fake_key}"),
            Some("claude"),
            "indigo",
            &format!("abc 123 {fake_token} $(rm -rf /)"),
        );
        assert!(!line.contains(&fake_key), "{line}");
        assert!(!line.contains("rm -rf"), "{line}");
        assert!(!line.contains("$("), "{line}");
        assert!(
            line.starts_with("From Jacob's Claude session in indigo · open: sessions:abc123"),
            "{line}"
        );
    }

    #[test]
    fn body_is_trimmed_clipped_and_never_empty() {
        assert_eq!(clamp_body("   "), None);
        assert_eq!(clamp_body("  hi @Corey  ").as_deref(), Some("hi @Corey"));
        let long = "x".repeat(MAX_BODY_CHARS + 500);
        let clipped = clamp_body(&long).unwrap();
        assert_eq!(clipped.chars().count(), MAX_BODY_CHARS);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn recipients_are_deduped_filtered_and_capped() {
        let raw: Vec<String> = ["prs_a", " prs_a ", "agt_b", "chn_c", "", "prs_d"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(normalize_recipients(&raw), ["prs_a", "agt_b", "prs_d"]);

        let many: Vec<String> = (0..(MAX_RECIPIENTS + 5))
            .map(|i| format!("prs_{i}"))
            .collect();
        assert_eq!(normalize_recipients(&many).len(), MAX_RECIPIENTS);
    }

    #[test]
    fn payload_is_the_hq_dm_details_shape() {
        let payload = build_mention_payload(
            "agt_1",
            "ship it @Atlas",
            "From Jacob's Claude session in indigo · open: sessions:s1",
        );
        assert_eq!(
            payload,
            serde_json::json!({
                "toPersonUid": "agt_1",
                "body": "ship it @Atlas",
                "details": "From Jacob's Claude session in indigo · open: sessions:s1",
            })
        );
        // No prompt, no transcript, no extra keys.
        assert_eq!(payload.as_object().unwrap().len(), 3);
    }

    #[test]
    fn candidate_serializes_camel_case_with_lowercase_kind() {
        let row = MentionCandidate {
            uid: "agt_1".into(),
            display_name: "Atlas".into(),
            kind: MentionKind::Agent,
            email: None,
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            serde_json::json!({ "uid": "agt_1", "displayName": "Atlas", "kind": "agent" })
        );
    }

    #[test]
    fn cache_expires_after_ttl() {
        let cache = CandidateCache::new();
        let t0 = Instant::now();
        let rows = vec![MentionCandidate {
            uid: "prs_1".into(),
            display_name: "One".into(),
            kind: MentionKind::Human,
            email: None,
        }];
        cache.put_at("indigo", rows.clone(), t0);
        assert_eq!(
            cache.get_at("indigo", t0 + Duration::from_secs(30)),
            Some(rows.clone())
        );
        assert_eq!(cache.get_at("ridge", t0), None);
        assert_eq!(cache.get_at("indigo", t0 + CACHE_TTL), None);
    }
}
