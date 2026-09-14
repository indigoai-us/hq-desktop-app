//! Pure helpers for "share a session into a project channel".
//!
//! Everything here is side-effect free and unit-tested: the transcript digest
//! (which turns a replayed [`SessionEvent`] stream into a compact, bounded,
//! secret-scrubbed text), the message composer, the project-channel naming
//! rule, and the step planner that pins the order of the mutations the Tauri
//! command performs against hq-pro. The command layer
//! (`apps/sync/src-tauri/src/commands/session_share_channel.rs`) only does I/O.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::agent_session::types::SessionEvent;

/// Longest a single user turn / assistant answer may be in the digest.
pub const MAX_TURN_CHARS: usize = 800;
/// Hard cap on the digest body (all turns + the omission note).
pub const MAX_DIGEST_CHARS: usize = 6_000;

const ELLIPSIS: char = '…';
const REDACTED: &str = "[REDACTED]";

// ─────────────────────────────────────────────────────────────────────────────
// Digest
// ─────────────────────────────────────────────────────────────────────────────

/// One line of the digest: who spoke and what they said (already clamped +
/// redacted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestTurn {
    pub role: DigestRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestRole {
    User,
    Assistant,
}

impl DigestRole {
    fn label(self) -> &'static str {
        match self {
            DigestRole::User => "You",
            DigestRole::Assistant => "Assistant",
        }
    }
}

/// Reduce a replayed event stream to the dialogue: every operator turn and,
/// for each turn, the assistant's FINAL top-level answer. Streamed deltas,
/// thinking, tool calls/results, permission/question prompts, usage, errors
/// and hook/system notices are dropped; sub-agent text (anything carrying a
/// `parent_tool_use_id`) is dropped too. Each turn is clamped to
/// [`MAX_TURN_CHARS`] and secret-scrubbed. Oldest first.
pub fn digest_turns(events: &[SessionEvent]) -> Vec<DigestTurn> {
    let mut turns: Vec<DigestTurn> = Vec::new();
    // The assistant's last complete top-level text block since the previous
    // user turn. Replaced (not appended) so interim narration — "Let me read
    // the file." — never survives once a later block lands.
    let mut pending_answer: Option<String> = None;

    for event in events {
        match event {
            SessionEvent::UserMessage { text, .. } => {
                if let Some(answer) = pending_answer.take() {
                    push_turn(&mut turns, DigestRole::Assistant, &answer);
                }
                push_turn(&mut turns, DigestRole::User, text);
            }
            SessionEvent::AssistantMessage {
                text,
                parent_tool_use_id: None,
            } if !text.trim().is_empty() => {
                pending_answer = Some(text.clone());
            }
            _ => {}
        }
    }
    if let Some(answer) = pending_answer.take() {
        push_turn(&mut turns, DigestRole::Assistant, &answer);
    }
    turns
}

fn push_turn(turns: &mut Vec<DigestTurn>, role: DigestRole, raw: &str) {
    let text = clamp_chars(&redact_secrets(raw.trim()), MAX_TURN_CHARS);
    if text.is_empty() {
        return;
    }
    turns.push(DigestTurn { role, text });
}

/// Render the digest, newest turns winning the [`MAX_DIGEST_CHARS`] budget but
/// printed oldest first. When turns had to be dropped the body opens with an
/// omission note so the reader knows the top is not the start.
pub fn render_digest(turns: &[DigestTurn]) -> String {
    render_digest_with_budget(turns, MAX_DIGEST_CHARS)
}

fn render_digest_with_budget(turns: &[DigestTurn], budget: usize) -> String {
    if turns.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = turns
        .iter()
        .map(|turn| format!("{}: {}", turn.role.label(), turn.text))
        .collect();

    // Walk newest → oldest, keeping whole lines while they fit. The note that
    // announces the omission has to fit too, so it is costed the moment a
    // single line would be left out.
    let mut kept_from = lines.len();
    let mut used = 0usize;
    for (idx, line) in lines.iter().enumerate().rev() {
        let separator = usize::from(kept_from < lines.len()); // "\n"
        let note_cost = if idx > 0 {
            omission_note(idx).chars().count() + 1
        } else {
            0
        };
        let line_len = line.chars().count();
        if used + separator + line_len + note_cost > budget {
            break;
        }
        used += separator + line_len;
        kept_from = idx;
    }

    if kept_from == lines.len() {
        // Not even the newest line fits — the note alone is the digest.
        return omission_note(lines.len());
    }
    let mut out = String::new();
    if kept_from > 0 {
        out.push_str(&omission_note(kept_from));
        out.push('\n');
    }
    out.push_str(&lines[kept_from..].join("\n"));
    out
}

fn omission_note(count: usize) -> String {
    if count == 1 {
        "… (1 earlier turn omitted)".to_string()
    } else {
        format!("… ({count} earlier turns omitted)")
    }
}

/// Truncate to `max` characters (not bytes), appending an ellipsis when cut.
pub fn clamp_chars(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push(ELLIPSIS);
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Message composition
// ─────────────────────────────────────────────────────────────────────────────

/// Provenance printed on the first line of the shared message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareHeader {
    pub tool: String,
    pub model: String,
    pub company: String,
}

/// The `sessions:{id}` deep link the app resolves back to the session.
pub fn session_link(session_id: &str) -> String {
    format!("Open in HQ: sessions:{}", session_id.trim())
}

/// Assemble the ONE message the command posts:
///
/// ```text
/// Session shared from HQ · {tool} · {model} · {company}
/// {note}
///
/// {digest}
///
/// Open in HQ: sessions:{id}
/// ```
///
/// `note` and `digest` are optional; blank ones are skipped. The note is
/// secret-scrubbed like the digest (it is free text the operator typed).
pub fn compose_share_message(
    header: &ShareHeader,
    note: Option<&str>,
    digest: Option<&str>,
    session_id: &str,
) -> String {
    let mut blocks: Vec<String> = Vec::new();
    let mut first = format!(
        "Session shared from HQ · {} · {} · {}",
        blank_to_dash(&header.tool),
        blank_to_dash(&header.model),
        blank_to_dash(&header.company)
    );
    if let Some(note) = note.map(str::trim).filter(|s| !s.is_empty()) {
        first.push('\n');
        first.push_str(&redact_secrets(note));
    }
    blocks.push(first);
    if let Some(digest) = digest.map(str::trim).filter(|s| !s.is_empty()) {
        blocks.push(digest.to_string());
    }
    blocks.push(session_link(session_id));
    blocks.join("\n\n")
}

fn blank_to_dash(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "—"
    } else {
        trimmed
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel naming
// ─────────────────────────────────────────────────────────────────────────────

/// Derive the project channel name from a project directory: `p-<slug>` where
/// the slug is the last path component lower-cased with runs of non
/// alphanumerics collapsed to single dashes. The UI prints the leading `#`,
/// so the stored name carries none. Returns `None` when no usable component
/// exists.
pub fn project_channel_name(project_path: &str) -> Option<String> {
    let trimmed = project_path.trim().trim_end_matches(['/', '\\']);
    let leaf = trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())?;
    let slug = slugify(leaf);
    if slug.is_empty() {
        return None;
    }
    Some(format!("p-{slug}"))
}

/// Lower-case ASCII alphanumerics joined by single dashes; everything else is
/// a separator. Leading/trailing dashes are trimmed.
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Channel-name equality as the server applies it for the "already exists"
/// check: trimmed, case-insensitive, leading `#` ignored.
pub fn channel_name_matches(a: &str, b: &str) -> bool {
    normalize_channel_name(a) == normalize_channel_name(b)
}

fn normalize_channel_name(name: &str) -> String {
    name.trim()
        .trim_start_matches('#')
        .trim()
        .to_ascii_lowercase()
}

// ─────────────────────────────────────────────────────────────────────────────
// Step planner
// ─────────────────────────────────────────────────────────────────────────────

/// Where the session should land.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShareTarget {
    /// An existing channel the caller must already belong to.
    #[serde(rename_all = "camelCase")]
    Existing { channel_id: String },
    /// A new company channel. `project_path`, when given, derives the name
    /// (`p-<slug>`); an explicit `name` still wins when non-blank.
    #[serde(rename_all = "camelCase")]
    New {
        #[serde(default)]
        name: String,
        #[serde(default)]
        project_path: Option<String>,
    },
}

/// Renderer → command arguments. camelCase on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareArgs {
    pub session_id: String,
    pub company: String,
    pub target: ShareTarget,
    #[serde(default)]
    pub invite_uids: Vec<String>,
    #[serde(default)]
    pub include_transcript: bool,
    #[serde(default)]
    pub note: Option<String>,
}

/// One mutation the command performs, in order. Pure so the order — resolve
/// the channel, then invite, then post exactly once — is pinned by a test
/// rather than by reading the async command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareStep {
    /// Verify the caller belongs to `channel_id` (joining if merely invited).
    VerifyMembership { channel_id: String },
    /// Reuse a same-named channel if one exists, else create `name`.
    EnsureChannel { name: String },
    /// `POST /channels/{id}/members { toPersonUid }` for one person.
    Invite { uid: String },
    /// Already a member — reported ok without a request.
    SkipInvite { uid: String },
    /// `POST /channels/{id}/messages`, exactly once, after every invite.
    Post { include_transcript: bool },
}

/// Lay out the mutations for `args` given the channel's current roster
/// (`existing_members`, personUids). Blank and duplicate invitees collapse;
/// members already present become [`ShareStep::SkipInvite`].
///
/// Errors when a `new` target has neither a usable name nor a project path
/// that yields one.
pub fn plan_share(args: &ShareArgs, existing_members: &[String]) -> Result<Vec<ShareStep>, String> {
    let mut steps = Vec::new();
    match &args.target {
        ShareTarget::Existing { channel_id } => {
            let id = channel_id.trim();
            if id.is_empty() {
                return Err("channelId must not be empty".to_string());
            }
            steps.push(ShareStep::VerifyMembership {
                channel_id: id.to_string(),
            });
        }
        ShareTarget::New { name, project_path } => {
            let name = resolve_new_channel_name(name, project_path.as_deref())?;
            steps.push(ShareStep::EnsureChannel { name });
        }
    }

    let existing: HashSet<&str> = existing_members.iter().map(|m| m.trim()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    for uid in &args.invite_uids {
        let uid = uid.trim();
        if uid.is_empty() || !seen.insert(uid.to_string()) {
            continue;
        }
        if existing.contains(uid) {
            steps.push(ShareStep::SkipInvite {
                uid: uid.to_string(),
            });
        } else {
            steps.push(ShareStep::Invite {
                uid: uid.to_string(),
            });
        }
    }

    steps.push(ShareStep::Post {
        include_transcript: args.include_transcript,
    });
    Ok(steps)
}

/// The name a `new` target resolves to: an explicit non-blank `name` (leading
/// `#` dropped), else `p-<slug>` from `project_path`.
pub fn resolve_new_channel_name(name: &str, project_path: Option<&str>) -> Result<String, String> {
    let explicit = name.trim().trim_start_matches('#').trim();
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    project_path
        .and_then(project_channel_name)
        .ok_or_else(|| "A new channel needs a name or a project path".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret redaction
// ─────────────────────────────────────────────────────────────────────────────

/// Field names whose value is a secret. Compared against the normalized
/// (lower-case, `_`/`-` stripped) SUFFIX of a key, so `OPENAI_API_KEY`,
/// `aws_secret_access_key`, `X-Api-Key` and `clientSecret` all match.
const SENSITIVE_KEY_SUFFIXES: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "apikey",
    "accesskey",
    "secretkey",
    "privatekey",
    "clientsecret",
    "credential",
    "credentials",
    "authorization",
];

/// Well-known credential prefixes and the minimum number of token characters
/// (`[A-Za-z0-9_.-]`) that must follow them. Prefixes are spelled as
/// `(head, tail)` pairs joined at runtime so no credential-shaped literal
/// lives in the source tree.
const TOKEN_PREFIXES: &[((&str, &str), usize)] = &[
    (("sk", "-"), 20),         // OpenAI / Anthropic / Stripe secret keys
    (("sk", "_live_"), 16),    // Stripe
    (("sk", "_test_"), 16),    // Stripe
    (("rk", "_live_"), 16),    // Stripe restricted
    (("rk", "_test_"), 16),    // Stripe restricted
    (("gh", "p_"), 30),        // GitHub PAT (classic)
    (("gh", "o_"), 30),        // GitHub OAuth
    (("gh", "u_"), 30),        // GitHub user-to-server
    (("gh", "s_"), 30),        // GitHub server-to-server
    (("gh", "r_"), 30),        // GitHub refresh
    (("github", "_pat_"), 20), // GitHub fine-grained PAT
    (("gl", "pat-"), 20),      // GitLab PAT
    (("xox", "a-"), 10),       // Slack
    (("xox", "b-"), 10),
    (("xox", "p-"), 10),
    (("xox", "o-"), 10),
    (("xox", "r-"), 10),
    (("xox", "s-"), 10),
    (("xa", "pp-"), 10),
    (("np", "m_"), 36),    // npm granular token
    (("shp", "at_"), 32),  // Shopify admin token
    (("shp", "ss_"), 32),  // Shopify shared secret
    (("shp", "ca_"), 32),  // Shopify custom app
    (("AI", "za"), 35),    // Google API key
    (("ya", "29."), 20),   // Google OAuth access token
    (("h", "f_"), 20),     // Hugging Face
    (("py", "pi-"), 20),   // PyPI
    (("dop", "_v1_"), 20), // DigitalOcean
    (("S", "G."), 20),     // SendGrid
];

/// AWS access-key ids: four-letter prefix + 16 upper-case alphanumerics.
const AWS_KEY_PREFIXES: &[(&str, &str)] = &[
    ("AK", "IA"),
    ("AS", "IA"),
    ("AG", "PA"),
    ("AR", "OA"),
    ("AI", "DA"),
    ("AN", "PA"),
];

/// Replace anything secret-looking with `[REDACTED]`. Conservative on purpose:
/// this text is about to be posted into a shared channel, so a false positive
/// costs a word while a miss leaks a credential. Handles:
///
///   * PEM private-key blocks (whole block),
///   * well-known token prefixes (OpenAI, GitHub, Slack, AWS, Google, …),
///   * JWTs (three base64url segments starting `eyJ`),
///   * `key=value` / `key: value` pairs whose key is credential-shaped,
///   * `Bearer <token>` / `Basic <blob>` / `Authorization: <value>`,
///   * `scheme://user:password@host` URL credentials.
pub fn redact_secrets(text: &str) -> String {
    let without_pem = redact_pem_blocks(text);
    let mut out = String::with_capacity(without_pem.len());
    for (idx, line) in without_pem.split('\n').enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        out.push_str(&redact_line(line));
    }
    out
}

fn redact_pem_blocks(text: &str) -> String {
    const BEGIN: &str = "-----BEGIN";
    const END: &str = "-----END";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(start) = rest.find(BEGIN) else {
            out.push_str(rest);
            return out;
        };
        // Only private-key style blocks — certificates are public material.
        let header_end = rest[start..]
            .find('\n')
            .map(|n| start + n)
            .unwrap_or(rest.len());
        let header = &rest[start..header_end];
        if !header.to_ascii_uppercase().contains("PRIVATE KEY") {
            out.push_str(&rest[..header_end]);
            rest = &rest[header_end..];
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str(REDACTED);
        let after = match rest[start..].find(END) {
            Some(end_rel) => {
                let end_abs = start + end_rel;
                rest[end_abs..]
                    .find('\n')
                    .map(|n| end_abs + n)
                    .unwrap_or(rest.len())
            }
            None => rest.len(),
        };
        rest = &rest[after..];
    }
}

/// Characters that end a token for the purposes of scanning. `=` and `:` are
/// deliberately NOT delimiters so `key=value` stays one token.
fn is_delimiter(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '|'
        )
}

fn redact_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut prev_token: Option<&str> = None;
    let mut chars = line.char_indices().peekable();
    while let Some((start, ch)) = chars.peek().copied() {
        if is_delimiter(ch) {
            out.push(ch);
            chars.next();
            continue;
        }
        let mut end = start;
        while let Some((i, c)) = chars.peek().copied() {
            if is_delimiter(c) {
                break;
            }
            end = i + c.len_utf8();
            chars.next();
        }
        let token = &line[start..end];
        out.push_str(&redact_token(token, prev_token));
        prev_token = Some(token);
    }
    out
}

fn redact_token(token: &str, prev: Option<&str>) -> String {
    // Trailing sentence punctuation stays visible; only the core is judged.
    let core_end = token.trim_end_matches(['.', ',', '!', '?', ':', ';']).len();
    let (core, tail) = token.split_at(core_end);
    if core.is_empty() {
        return token.to_string();
    }

    if let Some(redacted) = redact_url_credentials(core) {
        return format!("{redacted}{tail}");
    }
    if let Some(redacted) = redact_key_value(core) {
        return format!("{redacted}{tail}");
    }
    if looks_like_bare_secret(core) {
        return format!("{REDACTED}{tail}");
    }
    if let Some(prev) = prev {
        if previous_token_demands_secret(prev) && core.chars().count() >= 8 {
            return format!("{REDACTED}{tail}");
        }
    }
    token.to_string()
}

/// `scheme://user:pass@host…` → `scheme://[REDACTED]@host…`.
fn redact_url_credentials(token: &str) -> Option<String> {
    let scheme_end = token.find("://")?;
    let authority_start = scheme_end + 3;
    let rest = &token[authority_start..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let at = authority.rfind('@')?;
    let userinfo = &authority[..at];
    if !userinfo.contains(':') {
        return None;
    }
    Some(format!(
        "{}{}{}",
        &token[..authority_start],
        REDACTED,
        &rest[at..]
    ))
}

/// `KEY=value` / `KEY:value` where KEY is credential-shaped → `KEY=[REDACTED]`.
fn redact_key_value(token: &str) -> Option<String> {
    let sep = token.find(['=', ':'])?;
    // `://` is a URL, not a key/value pair.
    if token[sep..].starts_with("://") {
        return None;
    }
    let key = &token[..sep];
    let value = &token[sep + 1..];
    if value.is_empty() || !is_sensitive_key(key) {
        return None;
    }
    Some(format!("{key}{}{REDACTED}", &token[sep..=sep]))
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if normalized.is_empty() {
        return false;
    }
    SENSITIVE_KEY_SUFFIXES
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

/// `Bearer xxx`, `Basic xxx`, `token: xxx`, `password= xxx`.
fn previous_token_demands_secret(prev: &str) -> bool {
    let bare = prev.trim_end_matches([':', '=']);
    if bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic") {
        return true;
    }
    // Only a key that was written as `key:` / `key=` (value split by a space)
    // — a bare English word like "password" followed by prose is left alone.
    prev.ends_with([':', '=']) && is_sensitive_key(bare)
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.')
}

fn looks_like_bare_secret(token: &str) -> bool {
    if token.chars().all(is_token_char) {
        for ((head, tail), min_rest) in TOKEN_PREFIXES {
            if let Some(rest) = token.strip_prefix(head).and_then(|t| t.strip_prefix(tail)) {
                if rest.chars().count() >= *min_rest {
                    return true;
                }
            }
        }
        for (head, tail) in AWS_KEY_PREFIXES {
            if let Some(rest) = token.strip_prefix(head).and_then(|t| t.strip_prefix(tail)) {
                if rest.len() == 16
                    && rest
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                {
                    return true;
                }
            }
        }
    }
    looks_like_jwt(token)
}

fn looks_like_jwt(token: &str) -> bool {
    if !token.starts_with("eyJ") {
        return false;
    }
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            part.chars().count() >= 10
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::types::DoneStatus;

    fn user(text: &str) -> SessionEvent {
        SessionEvent::UserMessage {
            text: text.to_string(),
            image_count: 0,
        }
    }

    fn assistant(text: &str) -> SessionEvent {
        SessionEvent::AssistantMessage {
            text: text.to_string(),
            parent_tool_use_id: None,
        }
    }

    fn subagent(text: &str) -> SessionEvent {
        SessionEvent::AssistantMessage {
            text: text.to_string(),
            parent_tool_use_id: Some("toolu_1".to_string()),
        }
    }

    /// Fixture credentials are assembled at runtime so the source tree never
    /// contains a token-shaped literal (secret scanners would flag it).
    fn tok(parts: &[&str]) -> String {
        parts.concat()
    }

    // ── digest_turns ────────────────────────────────────────────────────────

    #[test]
    fn digest_keeps_user_turns_and_final_answers_oldest_first() {
        let events = vec![
            user("first ask"),
            assistant("Let me look."),
            SessionEvent::ToolCall {
                id: "t1".into(),
                name: "Bash".into(),
                input: serde_json::json!({"command": "ls"}),
                parent_tool_use_id: None,
            },
            SessionEvent::ToolResult {
                id: "t1".into(),
                is_error: false,
                content: serde_json::json!("a b c"),
                parent_tool_use_id: None,
            },
            assistant("Here is the answer."),
            SessionEvent::TurnDone {
                status: DoneStatus::Success,
                error: None,
                session_id: None,
            },
            user("second ask"),
            assistant("Second answer."),
        ];
        let turns = digest_turns(&events);
        assert_eq!(
            turns,
            vec![
                DigestTurn {
                    role: DigestRole::User,
                    text: "first ask".into()
                },
                DigestTurn {
                    role: DigestRole::Assistant,
                    text: "Here is the answer.".into()
                },
                DigestTurn {
                    role: DigestRole::User,
                    text: "second ask".into()
                },
                DigestTurn {
                    role: DigestRole::Assistant,
                    text: "Second answer.".into()
                },
            ]
        );
    }

    #[test]
    fn digest_skips_thinking_deltas_tool_activity_hooks_and_subagents() {
        let events = vec![
            user("go"),
            SessionEvent::ThinkingDelta {
                text: "private reasoning".into(),
            },
            SessionEvent::TextDelta {
                text: "partial".into(),
                parent_tool_use_id: None,
            },
            SessionEvent::ToolCall {
                id: "t1".into(),
                name: "Bash".into(),
                input: serde_json::json!({"command": "cat ~/.ssh/id_rsa"}),
                parent_tool_use_id: None,
            },
            SessionEvent::ToolResult {
                id: "t1".into(),
                is_error: false,
                content: serde_json::json!("hook notice: policy injected"),
                parent_tool_use_id: None,
            },
            SessionEvent::PermissionRequest {
                request_id: "r".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({}),
                suggestions: serde_json::json!([]),
            },
            SessionEvent::Error {
                message: "hook blocked".into(),
                code: None,
            },
            subagent("subagent chatter"),
            SessionEvent::Usage {
                input_tokens: 1,
                output_tokens: 1,
                cost_usd: None,
                duration_ms: None,
            },
            assistant("final"),
            SessionEvent::Exited {
                code: Some(0),
                signal: None,
            },
        ];
        let rendered = render_digest(&digest_turns(&events));
        assert_eq!(rendered, "You: go\nAssistant: final");
        for leaked in [
            "private reasoning",
            "partial",
            "id_rsa",
            "hook",
            "subagent chatter",
        ] {
            assert!(!rendered.contains(leaked), "leaked {leaked:?}");
        }
    }

    #[test]
    fn digest_without_a_final_answer_still_carries_the_user_turn() {
        let turns = digest_turns(&[user("hello"), assistant("   ")]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].role, DigestRole::User);
        assert!(digest_turns(&[]).is_empty());
    }

    #[test]
    fn each_turn_is_clamped_to_800_chars() {
        let long = "x".repeat(2_000);
        let turns = digest_turns(&[user(&long), assistant(&long)]);
        for turn in &turns {
            assert_eq!(turn.text.chars().count(), MAX_TURN_CHARS);
            assert!(turn.text.ends_with('…'));
        }
        // Multi-byte safe: counts chars, not bytes.
        let emoji = "🦀".repeat(900);
        let clamped = clamp_chars(&emoji, MAX_TURN_CHARS);
        assert_eq!(clamped.chars().count(), MAX_TURN_CHARS);
    }

    #[test]
    fn digest_total_is_capped_at_6000_keeping_newest_turns_in_order() {
        let mut events = Vec::new();
        for i in 0..20 {
            events.push(user(&format!("q{i:02} {}", "u".repeat(790))));
            events.push(assistant(&format!("a{i:02} {}", "v".repeat(790))));
        }
        let turns = digest_turns(&events);
        let rendered = render_digest(&turns);
        assert!(
            rendered.chars().count() <= MAX_DIGEST_CHARS,
            "{}",
            rendered.chars().count()
        );
        assert!(rendered.starts_with("… ("), "omission note leads");
        assert!(rendered.contains("earlier turns omitted)"));
        // Newest turn survives; oldest is gone; order is oldest → newest.
        assert!(rendered.contains("Assistant: a19"));
        assert!(!rendered.contains("You: q00"));
        let pos_q = rendered.find("You: q19").unwrap();
        let pos_a = rendered.find("Assistant: a19").unwrap();
        assert!(pos_q < pos_a);
        let seen: Vec<usize> = (0..20)
            .filter_map(|i| rendered.find(&format!("You: q{i:02}")))
            .collect();
        assert!(seen.len() > 1);
        assert!(seen.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn digest_under_budget_has_no_omission_note() {
        let rendered = render_digest(&digest_turns(&[user("a"), assistant("b")]));
        assert_eq!(rendered, "You: a\nAssistant: b");
        assert_eq!(render_digest(&[]), "");
    }

    #[test]
    fn digest_budget_too_small_for_the_newest_line_yields_only_the_note() {
        let turns = digest_turns(&[user("first"), assistant(&"z".repeat(500))]);
        assert_eq!(
            render_digest_with_budget(&turns, 40),
            "… (2 earlier turns omitted)"
        );
        assert_eq!(
            render_digest_with_budget(&turns[1..], 40),
            "… (1 earlier turn omitted)"
        );
        // Exactly one line fits alongside its note: both lines would be 77
        // chars, note + newest line is 68.
        let small = digest_turns(&[user(&"a".repeat(30)), assistant(&"b".repeat(30))]);
        let expected = format!("… (1 earlier turn omitted)\nAssistant: {}", "b".repeat(30));
        assert_eq!(expected.chars().count(), 68);
        assert_eq!(render_digest_with_budget(&small, 70), expected);
        assert_eq!(
            render_digest_with_budget(&small, 77),
            format!("You: {}\nAssistant: {}", "a".repeat(30), "b".repeat(30))
        );
    }

    #[test]
    fn digest_redacts_secrets_in_both_roles() {
        let openai = tok(&["sk", "-", "abcdefghijklmnopqrstuvwxyz0123456789"]);
        let github = tok(&["gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0"]);
        let turns = digest_turns(&[
            user(&format!("use OPENAI_API_KEY={openai}")),
            assistant(&format!("Set token: {github}")),
        ]);
        let rendered = render_digest(&turns);
        assert!(!rendered.contains(&openai[..8]));
        assert!(!rendered.contains(&github[..8]));
        assert!(rendered.contains("OPENAI_API_KEY=[REDACTED]"));
        assert!(rendered.contains("token: [REDACTED]"));
    }

    // ── compose_share_message ───────────────────────────────────────────────

    fn header() -> ShareHeader {
        ShareHeader {
            tool: "claude".into(),
            model: "claude-opus-4-1".into(),
            company: "indigo".into(),
        }
    }

    #[test]
    fn message_has_header_note_digest_and_trailing_link() {
        let msg = compose_share_message(
            &header(),
            Some("  worth a look  "),
            Some("You: hi\nAssistant: hello"),
            "sess-123",
        );
        assert_eq!(
            msg,
            "Session shared from HQ · claude · claude-opus-4-1 · indigo\nworth a look\n\nYou: hi\nAssistant: hello\n\nOpen in HQ: sessions:sess-123"
        );
        assert!(msg.ends_with(&session_link("sess-123")));
    }

    #[test]
    fn message_without_transcript_is_header_note_and_link_only() {
        let msg = compose_share_message(&header(), Some("note"), None, "s1");
        assert_eq!(
            msg,
            "Session shared from HQ · claude · claude-opus-4-1 · indigo\nnote\n\nOpen in HQ: sessions:s1"
        );
        let bare = compose_share_message(&header(), None, Some("  "), "s1");
        assert_eq!(
            bare,
            "Session shared from HQ · claude · claude-opus-4-1 · indigo\n\nOpen in HQ: sessions:s1"
        );
    }

    #[test]
    fn message_blanks_render_as_dashes_and_note_is_scrubbed() {
        let msg = compose_share_message(
            &ShareHeader {
                tool: "codex".into(),
                model: "".into(),
                company: " ".into(),
            },
            Some("password: correct-horse-battery"),
            None,
            "s",
        );
        assert!(msg.starts_with("Session shared from HQ · codex · — · —\n"));
        assert!(msg.contains("password: [REDACTED]"));
        assert!(!msg.contains("horse"));
    }

    // ── naming ──────────────────────────────────────────────────────────────

    #[test]
    fn project_channel_name_is_p_dash_slug_of_the_leaf() {
        assert_eq!(
            project_channel_name("/hq/companies/indigo/projects/Launch Plan_v2/").as_deref(),
            Some("p-launch-plan-v2")
        );
        assert_eq!(
            project_channel_name("C:\\HQ\\projects\\Ops--Board").as_deref(),
            Some("p-ops-board")
        );
        assert_eq!(project_channel_name("   "), None);
        assert_eq!(project_channel_name("/!!!/"), None);
        assert_eq!(slugify("  Hello,  World! "), "hello-world");
    }

    #[test]
    fn new_channel_name_prefers_explicit_name_then_project_path() {
        assert_eq!(
            resolve_new_channel_name(" #ops ", Some("/x/proj")).unwrap(),
            "ops"
        );
        assert_eq!(
            resolve_new_channel_name("", Some("/x/My Proj")).unwrap(),
            "p-my-proj"
        );
        assert!(resolve_new_channel_name("", None).is_err());
        assert!(resolve_new_channel_name("#", Some("//")).is_err());
    }

    #[test]
    fn channel_names_match_case_insensitively_ignoring_hash() {
        assert!(channel_name_matches("#P-Ops", "p-ops "));
        assert!(!channel_name_matches("p-ops", "p-ops-2"));
    }

    // ── plan_share ──────────────────────────────────────────────────────────

    fn args(target: ShareTarget, invite: &[&str], transcript: bool) -> ShareArgs {
        ShareArgs {
            session_id: "s1".into(),
            company: "indigo".into(),
            target,
            invite_uids: invite.iter().map(|s| s.to_string()).collect(),
            include_transcript: transcript,
            note: None,
        }
    }

    #[test]
    fn plan_pins_resolve_then_invites_then_single_post() {
        let plan = plan_share(
            &args(
                ShareTarget::New {
                    name: "".into(),
                    project_path: Some("/hq/projects/Alpha".into()),
                },
                &["prs_a", " prs_b ", "prs_a", "", "prs_c"],
                true,
            ),
            &["prs_b".into(), "prs_owner".into()],
        )
        .unwrap();
        assert_eq!(
            plan,
            vec![
                ShareStep::EnsureChannel {
                    name: "p-alpha".into()
                },
                ShareStep::Invite {
                    uid: "prs_a".into()
                },
                ShareStep::SkipInvite {
                    uid: "prs_b".into()
                },
                ShareStep::Invite {
                    uid: "prs_c".into()
                },
                ShareStep::Post {
                    include_transcript: true
                },
            ]
        );
        assert_eq!(
            plan.iter()
                .filter(|s| matches!(s, ShareStep::Post { .. }))
                .count(),
            1
        );
        assert!(matches!(plan.last(), Some(ShareStep::Post { .. })));
    }

    #[test]
    fn plan_for_existing_channel_verifies_membership_first() {
        let plan = plan_share(
            &args(
                ShareTarget::Existing {
                    channel_id: " ch_1 ".into(),
                },
                &[],
                false,
            ),
            &[],
        )
        .unwrap();
        assert_eq!(
            plan,
            vec![
                ShareStep::VerifyMembership {
                    channel_id: "ch_1".into()
                },
                ShareStep::Post {
                    include_transcript: false
                },
            ]
        );
        assert!(plan_share(
            &args(
                ShareTarget::Existing {
                    channel_id: "".into()
                },
                &[],
                false
            ),
            &[]
        )
        .is_err());
        assert!(plan_share(
            &args(
                ShareTarget::New {
                    name: "".into(),
                    project_path: None
                },
                &[],
                false
            ),
            &[]
        )
        .is_err());
    }

    #[test]
    fn share_args_deserialize_from_the_camel_case_wire_shape() {
        let raw = serde_json::json!({
            "sessionId": "s1",
            "company": "indigo",
            "target": {"kind": "new", "name": "", "projectPath": "/x/Alpha"},
            "inviteUids": ["prs_a"],
            "includeTranscript": true,
            "note": "hi"
        });
        let parsed: ShareArgs = serde_json::from_value(raw).unwrap();
        assert_eq!(
            parsed.target,
            ShareTarget::New {
                name: "".into(),
                project_path: Some("/x/Alpha".into())
            }
        );
        let existing: ShareArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "company": "indigo",
            "target": {"kind": "existing", "channelId": "ch_9"}
        }))
        .unwrap();
        assert_eq!(
            existing.target,
            ShareTarget::Existing {
                channel_id: "ch_9".into()
            }
        );
        assert!(existing.invite_uids.is_empty());
        assert!(!existing.include_transcript);
        assert_eq!(existing.note, None);
    }

    // ── redact_secrets ──────────────────────────────────────────────────────

    #[test]
    fn redacts_known_token_prefixes_and_aws_keys() {
        let cases = [
            tok(&["sk", "-", "abcdefghijklmnopqrstuvwxyz0123"]),
            tok(&["sk", "-ant-api03-", "abcdefghijklmnopqrstuvwxyz"]),
            tok(&["gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"]),
            tok(&["github", "_pat_", "11ABCDEFG0abcdefghijklmnop"]),
            tok(&["xox", "b-", "1234567890-abcdefghij"]),
            tok(&["AK", "IA", "IOSFODNN7EXAMPLE"]),
            tok(&["AI", "za", "SyA-abcdefghijklmnopqrstuvwxyz0123456"]),
            tok(&["gl", "pat-", "abcdefghijklmnopqrst"]),
            tok(&["shp", "at_", "0123456789abcdef0123456789abcdef"]),
        ];
        for secret in cases {
            let out = redact_secrets(&format!("value {secret}, ok"));
            assert_eq!(out, "value [REDACTED], ok", "{}", &secret[..6]);
        }
    }

    #[test]
    fn leaves_ordinary_prose_and_short_prefix_words_alone() {
        let prose = "Run npm_config and check sk-1 plus the token count. See AKIA.";
        assert_eq!(redact_secrets(prose), prose);
        let sha = "commit 3f2a9c1b7d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a";
        assert_eq!(redact_secrets(sha), sha);
        let code = "let max_tokens = 5; password_reset_url";
        assert_eq!(redact_secrets(code), code);
    }

    #[test]
    fn redacts_key_value_pairs_and_header_style_values() {
        let aws = tok(&["wJalrXUtnFEMI", "/K7MDENG"]);
        assert_eq!(
            redact_secrets(&format!("export AWS_SECRET_ACCESS_KEY={aws}")),
            "export AWS_SECRET_ACCESS_KEY=[REDACTED]"
        );
        assert_eq!(
            redact_secrets("Authorization: Bearer abcdefgh12345678"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(
            redact_secrets("Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l"),
            "Authorization: Basic [REDACTED]"
        );
        assert_eq!(
            redact_secrets("x-api-key: 0123456789abcdef"),
            "x-api-key: [REDACTED]"
        );
        assert_eq!(
            redact_secrets("\"clientSecret=abc\""),
            "\"clientSecret=[REDACTED]\""
        );
        assert_eq!(
            redact_secrets("the password is short"),
            "the password is short"
        );
    }

    #[test]
    fn redacts_jwts_url_credentials_and_pem_blocks() {
        let jwt = tok(&[
            "eyJ",
            "hbGciOiJIUzI1NiJ9",
            ".",
            "eyJ",
            "zdWIiOiIxMjM0NTY3ODkwIn0",
            ".",
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        ]);
        assert_eq!(redact_secrets(&format!("jwt {jwt}.")), "jwt [REDACTED].");
        let url = tok(&[
            "postgres://",
            "admin",
            ":",
            "s3cr3t",
            "@db.internal:5432/app",
        ]);
        assert_eq!(
            redact_secrets(&format!("db {url}")),
            "db postgres://[REDACTED]@db.internal:5432/app"
        );
        assert_eq!(
            redact_secrets("see https://example.com/path"),
            "see https://example.com/path"
        );
        let begin = tok(&["-----BEGIN ", "RSA PRIVATE", " KEY-----"]);
        let end = tok(&["-----END ", "RSA PRIVATE", " KEY-----"]);
        let pem = format!("before\n{begin}\nMIIEow\nAAAA\n{end}\nafter");
        assert_eq!(redact_secrets(&pem), "before\n[REDACTED]\nafter");
        let unterminated = format!("x {}\nMIIE", tok(&["-----BEGIN ", "PRIVATE", " KEY-----"]));
        assert_eq!(redact_secrets(&unterminated), "x [REDACTED]");
        let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        assert_eq!(redact_secrets(cert), cert);
    }
}
