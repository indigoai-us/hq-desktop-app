use serde::{Deserialize, Serialize};

/// One person the caller can start (or continue) a DM with. Shape is tolerant
/// of server additions — unknown fields are ignored. `companyUid` is present
/// for company teammates and absent for cross-company connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub person_uid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    /// "connection" | "company" — how the caller is allowed to DM this person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Connection state relative to the caller: "active" | "pending" | "none" |
    /// "blocked" (US-010). Drives the compose "not-connected" affordance. Absent
    /// on older server payloads → the frontend treats absence as "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_state: Option<String>,
    /// Optional server-supplied conversation timestamps. Older servers omit
    /// these; the frontend also folds in local notification history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_dm_at: Option<String>,
    /// Optional server-supplied conversation preview fields. The current server
    /// may omit them; preserving them here keeps the desktop rail from dropping
    /// richer contact payloads as the API evolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_direction: Option<String>,
    /// Audience of the last message: "human" | "agent" | "both". Absent on
    /// older servers. When present and equal to "agent", the preview fields
    /// should be hidden unless the US-006 "show bot messages" toggle is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_audience: Option<String>,
    /// Presigned avatar GET URL from hq-pro (contacts + company members).
    /// Absent/null on older servers or people without a photo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// Clear the conversation preview fields on contacts whose last message is
/// agent-only, unless `show_bot_messages` is true (US-006 toggle, default off).
/// Called in `list_contacts` / `list_company_members` so the frontend never
/// renders an agent-only snippet in the DM rail unless the user opted in.
pub fn apply_contact_preview_filter(contacts: &mut [Contact], show_bot_messages: bool) {
    if show_bot_messages {
        return;
    }
    for c in contacts.iter_mut() {
        let audience = c.last_message_audience.as_deref().unwrap_or("").to_lowercase();
        if audience == "agent" {
            c.last_message_body = None;
            c.last_message_preview = None;
            c.last_message_text = None;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsResponse {
    #[serde(default)]
    pub contacts: Vec<Contact>,
}

/// Counts surfaced on the popover Messages badge. `unread_dms` comes from the
/// single DM-poll path (managed state); `pending_requests` is fetched live.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSummary {
    pub unread_dms: u32,
    pub pending_requests: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestsResponse {
    #[serde(default)]
    pub requests: Vec<serde_json::Value>,
}

/// One channel the caller can see. Tolerant of server additions — unknown
/// fields are ignored. `company_uid` is present only for company/project-scoped
/// channels. Mirrors the TS `Channel` shape in `src/lib/channels.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "ChannelWire")]
pub struct Channel {
    pub channel_id: String,
    #[serde(default)]
    pub name: String,
    /// "personal" | "company" | "group" | "project".
    #[serde(default)]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    /// Present when `scope == "project"` (invite-only, bound to a board project).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_name: Option<String>,
    /// "all" | "owner" — who may post.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_policy: Option<String>,
    /// "company" | "private".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    /// Caller's membership: "joined" | "invited" | "none".
    ///
    /// Newer servers send a membership object while older ones sent this
    /// string directly. `ChannelWire` normalizes both wire shapes so all
    /// desktop consumers retain the existing string contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership: Option<String>,
    #[serde(
        default,
        alias = "unreadCount",
        skip_serializing_if = "Option::is_none"
    )]
    pub unread: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    /// Server-supplied activity timestamps (ISO-8601). These MUST survive the
    /// Rust round-trip: the sidebar day-grouping (TODAY / YESTERDAY / weekday /
    /// LAST WEEK) keys off them — dropping them here made every real channel
    /// deserialize with no timestamp and bucket under LAST WEEK (epoch 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    /// Server-supplied creation timestamp (ISO-8601). Carried through so the
    /// rail can order group DMs (which ship no activity timestamp) by creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Group-DM participant roster (caller excluded), so the rail can name an
    /// unnamed group DM by its people. Present only for group-scoped channels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ChannelParticipant>>,
    /// Caller's resolved notification level ("all" | "mentions" | "files" |
    /// "muted"), read from `membership.notifyLevel`. `None` for browse-only
    /// rows and older servers. Serialized flat so the webview sees it as
    /// `notifyLevel`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify_level: Option<String>,
    /// How the caller joined (`membership.source`): "explicit" |
    /// "company-auto" | "company". Company joins never raise an "added"
    /// notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership_source: Option<String>,
    /// Channel creator uid, so a channel the caller made is never announced
    /// to them as "added".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

/// Deserialization shape for [`Channel`]. The server's `membership` is either
/// a legacy string or an object (`{ joined, notifyLevel, source, ... }`); the
/// object's extra fields are lifted onto the channel here. The flat
/// `notifyLevel` / `membershipSource` keys are what [`Channel`] serializes, so
/// a round-trip through the webview keeps them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelWire {
    channel_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    company_uid: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    company_name: Option<String>,
    #[serde(default)]
    post_policy: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    membership: Option<serde_json::Value>,
    #[serde(default, alias = "unreadCount")]
    unread: Option<u32>,
    #[serde(default)]
    member_count: Option<u32>,
    #[serde(default)]
    last_activity_at: Option<String>,
    #[serde(default)]
    last_message_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    members: Option<Vec<ChannelParticipant>>,
    #[serde(default)]
    notify_level: Option<String>,
    #[serde(default)]
    membership_source: Option<String>,
    #[serde(default)]
    created_by: Option<String>,
}

impl From<ChannelWire> for Channel {
    fn from(wire: ChannelWire) -> Self {
        let object = wire.membership.as_ref().and_then(|m| m.as_object());
        let object_str = |key: &str| {
            object
                .and_then(|o| o.get(key))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let membership = match &wire.membership {
            Some(serde_json::Value::String(value)) => Some(value.clone()),
            Some(serde_json::Value::Object(o)) => Some(
                if o.get("joined").and_then(|v| v.as_bool()).unwrap_or(false) {
                    "joined"
                } else {
                    "invited"
                }
                .to_string(),
            ),
            _ => None,
        };
        let notify_level = object_str("notifyLevel").or(wire.notify_level);
        let membership_source = object_str("source").or(wire.membership_source);
        Channel {
            channel_id: wire.channel_id,
            name: wire.name,
            scope: wire.scope,
            company_uid: wire.company_uid,
            project_id: wire.project_id,
            company_name: wire.company_name,
            post_policy: wire.post_policy,
            visibility: wire.visibility,
            membership,
            unread: wire.unread,
            member_count: wire.member_count,
            last_activity_at: wire.last_activity_at,
            last_message_at: wire.last_message_at,
            created_at: wire.created_at,
            members: wire.members,
            notify_level,
            membership_source,
            created_by: wire.created_by,
        }
    }
}

/// A group-DM participant as returned on the channels list — enough to label the
/// conversation. Mirrors the TS `ChannelParticipant` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelParticipant {
    pub person_uid: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsResponse {
    #[serde(default)]
    pub channels: Vec<Channel>,
}

/// Response of `POST /v1/notify/channels/ensure-project` (US-021).
/// `Default` (channel: None) doubles as the absent-safe "old server without
/// the route" value — the 404 path resolves to it and callers no-op.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureProjectChannelResponse {
    #[serde(default)]
    pub created: bool,
    #[serde(default)]
    pub channel: Option<Channel>,
}

/// One member of a channel. `role` is "owner" | "member".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMember {
    pub person_uid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub role: String,
    /// Presigned avatar GET URL from `GET /v1/notify/channels/{id}/members`.
    /// hq-pro sends this (or `null`) on every enriched roster row; dropping it
    /// here is what left human channel messages as initials-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMembersResponse {
    #[serde(default)]
    pub members: Vec<ChannelMember>,
}

/// File attachment metadata on a channel message (hq-pro chat wire).
/// All size/kind fields are optional — the UI omits the size caption when
/// `size_bytes` is absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub vault_path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Client-generated id for multi-file messages. Absent on older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Company vault the bytes live in (needed to presign GET).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    /// MIME type when distinct from `kind`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

/// One channel message, as returned by `/v1/notify/channels/{id}/messages`.
/// `direction` is tagged by the server relative to the caller ("in"/"out") so
/// the shared `<Conversation showAuthors>` renders it identically to a DM.
///
/// Optional chat-tab fields (`message_kind`, `system_event`, `attachment`) are
/// absent-safe: older servers omit them, and the desktop UI parses only known
/// shapes (unknown `systemEvent.type` / version → render nothing).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub event_id: String,
    pub from_person_uid: String,
    #[serde(default)]
    pub from_email: String,
    #[serde(default)]
    pub from_display_name: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub direction: String,
    /// `"system"` for bridge events; absent for normal human/agent posts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_kind: Option<String>,
    /// Versioned system-event envelope (`{ v, type, ... }`). Kept as raw JSON
    /// so unknown types/extra keys stay absent-safe on the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_event: Option<serde_json::Value>,
    /// Optional file attachment card payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<MessageAttachment>,
    /// Parent thread id when this row is a reply. Roots omit it (or echo their
    /// own eventId). Absent-safe so older servers still deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// Reply count maintained on root rows. Absent on replies and on older
    /// payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u32>,
    /// Structured @-mentions stored on the message. Match on
    /// `participantUid`, never a `personUid` key. Absent-safe for older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<MessageMention>>,
}

/// One structured mention on a channel message. Live wire shape:
/// `{ "participantUid", "participantType", "displayName" }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageMention {
    #[serde(default)]
    pub participant_uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// The full channel view: its metadata + a page of messages (newest-first).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDetail {
    /// The channel metadata. Optional because the `/messages` endpoint may
    /// return only the message page (the caller already holds the channel from
    /// the list); a required field here made an otherwise-fine fetch fail to
    /// decode with "error decoding response body". The frontend already treats
    /// it as optional (`if (detail.channel)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
    #[serde(default)]
    pub messages: Vec<ChannelMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// URL-escape a path segment for the channel id / personUid. These are
/// server-issued slugs (URL-safe), but a defensive minimal escape avoids a
/// malformed URL if a future id carries a reserved char. Keeps the dep surface
/// at zero (no `urlencoding` crate) — only `/`, `?`, `#`, and space are escaped.
/// Percent-encode a QUERY VALUE. `esc_seg` is for path segments and leaves
/// `&` and `=` alone, which would let a typed handle add its own parameters —
/// so the query path gets its own encoder rather than reusing that one.
pub fn esc_query(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => {
                let mut buf = [0u8; 4];
                other
                    .encode_utf8(&mut buf)
                    .as_bytes()
                    .iter()
                    .map(|b| format!("%{b:02X}"))
                    .collect::<String>()
            }
        })
        .collect()
}

/// Build `GET /v1/notify/channels/{id}/messages` (newest-first history).
/// Pure so the poll path and unit tests share one URL shape.
pub fn build_channel_messages_url(base_url: &str, channel_id: &str, limit: Option<u32>) -> String {
    let mut url = format!(
        "{}/v1/notify/channels/{}/messages",
        base_url.trim_end_matches('/'),
        esc_seg(channel_id),
    );
    if let Some(n) = limit {
        url.push_str(&format!("?limit={n}"));
    }
    url
}

pub fn esc_seg(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            ' ' => "%20".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Build the `POST /v1/notify/channels` create body. Exactly the fields the
/// server contract expects: `name`, `scope`, optional `companyUid` (required
/// for company + project scope), optional `projectId` (project scope), optional
/// `invite` (personUids). Pure so the wire shape is unit-testable.
pub fn build_create_payload(
    name: &str,
    scope: &str,
    company_uid: Option<&str>,
    invite: &[String],
) -> serde_json::Value {
    build_create_payload_with_project(name, scope, company_uid, None, invite)
}

/// Same as [`build_create_payload`] with optional `projectId` for project-scoped
/// channels (`scope == "project"`).
pub fn build_create_payload_with_project(
    name: &str,
    scope: &str,
    company_uid: Option<&str>,
    project_id: Option<&str>,
    invite: &[String],
) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "name".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    obj.insert(
        "scope".to_string(),
        serde_json::Value::String(scope.to_string()),
    );
    if let Some(uid) = company_uid.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert(
            "companyUid".to_string(),
            serde_json::Value::String(uid.to_string()),
        );
    }
    if let Some(pid) = project_id.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert(
            "projectId".to_string(),
            serde_json::Value::String(pid.to_string()),
        );
    }
    if !invite.is_empty() {
        obj.insert(
            "invite".to_string(),
            serde_json::Value::Array(
                invite
                    .iter()
                    .map(|u| serde_json::Value::String(u.clone()))
                    .collect(),
            ),
        );
    }
    serde_json::Value::Object(obj)
}

/// Build the `POST /v1/notify/channels/ensure-project` body (US-021):
/// idempotent auto-provision of a project's invite-only channel.
pub fn build_ensure_project_channel_payload(
    company_uid: &str,
    project_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "companyUid": company_uid.trim(),
        "projectId": project_id.trim(),
    })
}

/// Build the `POST /v1/notify/channels` body for a GROUP DM:
/// `{ scope: "group", participants: [...] }` (no name). Pure → unit-testable.
pub fn build_group_payload(participants: &[String]) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "scope".to_string(),
        serde_json::Value::String("group".to_string()),
    );
    obj.insert(
        "participants".to_string(),
        serde_json::Value::Array(
            participants
                .iter()
                .map(|p| serde_json::Value::String(p.clone()))
                .collect(),
        ),
    );
    serde_json::Value::Object(obj)
}

/// Body for a single channel-invite POST. The `/members` endpoint validates
/// "exactly one of toPersonUid or toEmail" and rejects the older
/// `{ personUids: [...] }` batch shape — that mismatch is what broke channel
/// invites (server returned "Provide exactly one of 'toPersonUid' or
/// 'toEmail'"). Pulled out as a pure fn so the wire shape is unit-locked.
pub fn invite_member_payload(uid: &str) -> serde_json::Value {
    serde_json::json!({ "toPersonUid": uid })
}

/// One emoji's aggregate on a single message, as returned by
/// `GET /v1/notify/reactions`. `reacted_by_me` drives the highlighted pill +
/// toggle direction in the UI. Mirrors the TS `ReactionAggregate`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReactionAggregate {
    pub emoji: String,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub reacted_by_me: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactors: Option<serde_json::Value>,
}

/// The aggregate set for one message. The GET endpoint returns THIS object
/// (`{messageScope, messageId, reactions: [...]}`), not a bare array, so
/// `fetch_reactions` deserializes into `MessageReactions` and returns its
/// `reactions`. This shape is also what the `message:reaction` event carries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactions {
    pub message_scope: String,
    pub message_id: String,
    pub reactions: Vec<ReactionAggregate>,
}

/// Build the `/v1/notify/reactions` mutation body. Identical shape for add
/// (POST) and remove (DELETE): `{ messageScope, messageId, emoji }`. Pure so the
/// wire shape is unit-testable.
pub fn build_reaction_payload(
    message_scope: &str,
    message_id: &str,
    emoji: &str,
) -> serde_json::Value {
    serde_json::json!({
        "messageScope": message_scope,
        "messageId": message_id,
        "emoji": emoji,
    })
}

/// Build the `GET /v1/notify/reactions` query URL. Pure + side-effect-free so
/// the query shape is unit-testable; segments are minimally escaped (`esc_seg`)
/// so a reserved char in the scope/id/emoji can't break the query.
pub fn build_reactions_url(base_url: &str, message_scope: &str, message_id: &str) -> String {
    format!(
        "{}/v1/notify/reactions?messageScope={}&messageId={}",
        base_url,
        esc_seg(message_scope),
        esc_seg(message_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_activity_timestamps_survive_round_trip() {
        // Regression (design-gap G2): the server sends lastActivityAt /
        // lastMessageAt on real channel rows; serde used to drop them (fields
        // undeclared), so the sidebar day-grouping saw epoch 0 and folded every
        // channel under LAST WEEK. They must parse AND re-serialize.
        let json = r#"{
            "channelId": "ch_1",
            "name": "hq-dev",
            "scope": "company",
            "companyUid": "ent_co",
            "lastActivityAt": "2026-08-12T09:30:00Z",
            "lastMessageAt": "2026-08-12T09:29:00Z",
            "createdAt": "2026-05-01T00:00:00Z"
        }"#;
        let c: Channel = serde_json::from_str(json).expect("Channel parses");
        assert_eq!(c.last_activity_at.as_deref(), Some("2026-08-12T09:30:00Z"));
        assert_eq!(c.last_message_at.as_deref(), Some("2026-08-12T09:29:00Z"));
        let out = serde_json::to_value(&c).expect("Channel serializes");
        assert_eq!(out["lastActivityAt"], "2026-08-12T09:30:00Z");
        assert_eq!(out["lastMessageAt"], "2026-08-12T09:29:00Z");
    }

    #[test]
    fn contact_deserializes_camel_case_minimal() {
        // Only personUid is required on the wire; the rest default.
        let json = r#"{ "personUid": "prs_x" }"#;
        let c: Contact = serde_json::from_str(json).expect("Contact parses");
        assert_eq!(c.person_uid, "prs_x");
        assert_eq!(c.email, "");
        assert!(c.company_uid.is_none());
    }

    #[test]
    fn contact_deserializes_full_row() {
        let json = r#"{
            "personUid": "prs_y",
            "email": "a@b.com",
            "displayName": "Ada",
            "companyUid": "ent_co",
            "source": "company",
            "lastMessageAt": "2026-06-12T01:02:03Z",
            "lastActivityAt": "2026-06-11T01:02:03Z",
            "lastDmAt": "2026-06-10T01:02:03Z",
            "lastMessageBody": "latest text",
            "lastMessageDirection": "out"
        }"#;
        let c: Contact = serde_json::from_str(json).expect("Contact parses");
        assert_eq!(c.email, "a@b.com");
        assert_eq!(c.company_uid.as_deref(), Some("ent_co"));
        assert_eq!(c.source.as_deref(), Some("company"));
        assert_eq!(c.last_message_at.as_deref(), Some("2026-06-12T01:02:03Z"));
        assert_eq!(c.last_activity_at.as_deref(), Some("2026-06-11T01:02:03Z"));
        assert_eq!(c.last_dm_at.as_deref(), Some("2026-06-10T01:02:03Z"));
        assert_eq!(c.last_message_body.as_deref(), Some("latest text"));
        assert_eq!(c.last_message_direction.as_deref(), Some("out"));
    }

    #[test]
    fn contact_round_trips_avatar_url() {
        let json = r#"{
            "personUid": "prs_a",
            "displayName": "Ada",
            "avatarUrl": "https://cdn/a.jpg"
        }"#;
        let c: Contact = serde_json::from_str(json).expect("Contact parses");
        assert_eq!(c.avatar_url.as_deref(), Some("https://cdn/a.jpg"));
        let out = serde_json::to_value(&c).expect("Contact serializes");
        assert_eq!(out["avatarUrl"], "https://cdn/a.jpg");

        let no_photo: Contact =
            serde_json::from_str(r#"{ "personUid": "prs_b", "avatarUrl": null }"#)
                .expect("null avatarUrl parses");
        assert!(no_photo.avatar_url.is_none());
        let omitted = serde_json::to_value(&no_photo).expect("serializes");
        assert!(omitted.get("avatarUrl").is_none());
    }

    #[test]
    fn channel_detail_decodes_without_channel_key() {
        // Regression: the `/v1/notify/channels/{id}/messages` endpoint returns
        // only the message page (no nested `channel`). A required `channel`
        // field made this fail to decode ("error decoding response body") and
        // broke opening a freshly-created/empty channel. `channel` is optional.
        let json = r#"{ "messages": [], "nextCursor": null }"#;
        let detail: ChannelDetail = serde_json::from_str(json).expect("ChannelDetail parses");
        assert!(detail.channel.is_none());
        assert!(detail.messages.is_empty());
        assert!(detail.next_cursor.is_none());
    }

    #[test]
    fn channel_detail_decodes_with_channel_and_messages() {
        let json = r#"{
            "channel": { "channelId": "chn_1", "name": "crew", "scope": "company" },
            "messages": [
                {
                    "eventId": "evt_1",
                    "fromPersonUid": "prs_a",
                    "body": "hi",
                    "createdAt": "2026-06-10T16:00:00Z",
                    "direction": "in"
                }
            ]
        }"#;
        let detail: ChannelDetail = serde_json::from_str(json).expect("ChannelDetail parses");
        let channel = detail.channel.expect("channel present");
        assert_eq!(channel.channel_id, "chn_1");
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].body, "hi");
    }

    #[test]
    fn channel_message_optional_chat_fields_round_trip() {
        // Absent-safe: minimal messages still decode with None optionals.
        let minimal = r#"{
            "eventId": "evt_min",
            "fromPersonUid": "prs_a",
            "body": "hi",
            "createdAt": "2026-06-10T16:00:00Z",
            "direction": "in"
        }"#;
        let m: ChannelMessage = serde_json::from_str(minimal).expect("minimal message");
        assert!(m.message_kind.is_none());
        assert!(m.system_event.is_none());
        assert!(m.attachment.is_none());

        let full = r#"{
            "eventId": "evt_sys",
            "fromPersonUid": "bridge",
            "body": "",
            "createdAt": "2026-06-10T16:00:00Z",
            "direction": "in",
            "messageKind": "system",
            "systemEvent": {
                "v": 1,
                "type": "run_complete",
                "meshThreadId": "th_1",
                "meshEventId": "ev_1",
                "title": "Deploy finished",
                "summary": "All green",
                "previewUrl": "https://example.com/preview",
                "diffUrl": "https://example.com/diff"
            },
            "attachment": {
                "vaultPath": "companies/acme/notes.md",
                "name": "notes.md",
                "sizeBytes": 1024,
                "kind": "file"
            }
        }"#;
        let m: ChannelMessage = serde_json::from_str(full).expect("full message");
        assert_eq!(m.message_kind.as_deref(), Some("system"));
        let se = m.system_event.clone().expect("systemEvent present");
        assert_eq!(se["type"], "run_complete");
        assert_eq!(se["v"], 1);
        let att = m.attachment.clone().expect("attachment present");
        assert_eq!(att.vault_path, "companies/acme/notes.md");
        assert_eq!(att.name, "notes.md");
        assert_eq!(att.size_bytes, Some(1024));
        assert_eq!(att.kind.as_deref(), Some("file"));

        // Serialize back uses camelCase and keeps optionals.
        let v = serde_json::to_value(&m).expect("serialize");
        assert_eq!(v["messageKind"], "system");
        assert!(v.get("systemEvent").is_some());
        assert_eq!(v["attachment"]["vaultPath"], "companies/acme/notes.md");
        assert_eq!(v["attachment"]["sizeBytes"], 1024);
        assert!(m.root_event_id.is_none());
        assert!(m.reply_count.is_none());
    }

    #[test]
    fn channel_message_thread_fields_round_trip() {
        let minimal = r#"{
            "eventId": "evt_min",
            "fromPersonUid": "prs_a",
            "body": "hi",
            "createdAt": "2026-06-10T16:00:00Z",
            "direction": "in"
        }"#;
        let m: ChannelMessage = serde_json::from_str(minimal).expect("minimal message");
        assert!(m.root_event_id.is_none());
        assert!(m.reply_count.is_none());

        let with_thread = r#"{
            "eventId": "evt_root",
            "fromPersonUid": "prs_a",
            "body": "hi",
            "createdAt": "2026-06-10T16:00:00Z",
            "direction": "in",
            "rootEventId": "evt_root",
            "replyCount": 4
        }"#;
        let m: ChannelMessage = serde_json::from_str(with_thread).expect("thread fields parse");
        assert_eq!(m.root_event_id.as_deref(), Some("evt_root"));
        assert_eq!(m.reply_count, Some(4));
        let v = serde_json::to_value(&m).expect("serialize");
        assert_eq!(v["rootEventId"], "evt_root");
        assert_eq!(v["replyCount"], 4);
        assert!(m.mentions.is_none());
    }

    #[test]
    fn channel_message_mentions_use_participant_uid_live_shape() {
        let json = r#"{
            "eventId": "evt_live",
            "fromPersonUid": "94b82448-aaaa-bbbb-cccc-ddddeeeeffff",
            "body": "hey @Stefan",
            "createdAt": "2026-09-23T00:00:00Z",
            "direction": "in",
            "mentions": [{
                "participantUid": "prs_01KQ2RY9VB1S105X2GZ2EPHKWY",
                "participantType": "human",
                "displayName": "Stefan Johnson"
            }]
        }"#;
        let m: ChannelMessage = serde_json::from_str(json).expect("live mentions shape");
        let mentions = m.mentions.expect("mentions present");
        assert_eq!(mentions.len(), 1);
        assert_eq!(
            mentions[0].participant_uid,
            "prs_01KQ2RY9VB1S105X2GZ2EPHKWY"
        );
        assert_eq!(mentions[0].participant_type.as_deref(), Some("human"));
        assert_eq!(mentions[0].display_name.as_deref(), Some("Stefan Johnson"));
    }

    #[test]
    fn channel_detail_parses_mention_missing_participant_uid() {
        let json = r#"{
            "messages": [{
                "eventId": "evt_partial",
                "fromPersonUid": "prs_ada",
                "body": "hey",
                "createdAt": "2026-09-23T00:00:00Z",
                "direction": "in",
                "mentions": [{
                    "participantType": "human",
                    "displayName": "Stefan Johnson"
                }]
            }]
        }"#;
        let detail: ChannelDetail =
            serde_json::from_str(json).expect("missing participantUid is default");
        let mentions = detail.messages[0]
            .mentions
            .as_ref()
            .expect("mentions present");
        assert_eq!(mentions[0].participant_uid, "");
        assert_eq!(mentions[0].display_name.as_deref(), Some("Stefan Johnson"));
    }

    #[test]
    fn build_channel_messages_url_uses_existing_history_path() {
        assert_eq!(
            build_channel_messages_url("https://api.example.com/", "chn_eng", Some(50)),
            "https://api.example.com/v1/notify/channels/chn_eng/messages?limit=50"
        );
        assert_eq!(
            build_channel_messages_url("https://api.example.com", "chn_eng", None),
            "https://api.example.com/v1/notify/channels/chn_eng/messages"
        );
    }

    #[test]
    fn unread_summary_serializes_camel_case() {
        let s = UnreadSummary {
            unread_dms: 3,
            pending_requests: 1,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["unreadDms"], 3);
        assert_eq!(v["pendingRequests"], 1);
    }

    #[test]
    fn requests_response_counts_rows() {
        let json = r#"{ "requests": [ {"a":1}, {"b":2} ] }"#;
        let r: RequestsResponse = serde_json::from_str(json).expect("parses");
        assert_eq!(r.requests.len(), 2);
        // Missing key → empty.
        let empty: RequestsResponse = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.requests.len(), 0);
    }

    // ── Channels (US-018) ────────────────────────────────────────────────────

    #[test]
    fn channel_deserializes_minimal() {
        // Only channelId is strictly required; the rest default.
        let json = r#"{ "channelId": "chn_1", "name": "general", "scope": "company" }"#;
        let c: Channel = serde_json::from_str(json).expect("Channel parses");
        assert_eq!(c.channel_id, "chn_1");
        assert_eq!(c.name, "general");
        assert_eq!(c.scope, "company");
        assert!(c.company_uid.is_none());
        assert!(c.unread.is_none());
    }

    #[test]
    fn channel_lifts_notify_level_and_source_from_membership_object() {
        // Live /v1/notify/channels row shape (2026-09-23).
        let json = r#"{
            "channelId": "chn_1", "name": "hq-sentry", "scope": "company",
            "createdBy": "prs_owner",
            "membership": {
                "joined": true, "following": true, "muted": false,
                "notifyLevel": "mentions", "role": "member",
                "source": "explicit", "lastReadAt": null
            }
        }"#;
        let c: Channel = serde_json::from_str(json).expect("Channel parses");
        assert_eq!(c.membership.as_deref(), Some("joined"));
        assert_eq!(c.notify_level.as_deref(), Some("mentions"));
        assert_eq!(c.membership_source.as_deref(), Some("explicit"));
        assert_eq!(c.created_by.as_deref(), Some("prs_owner"));

        // Serialized flat for the webview, and a round-trip keeps the fields.
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["notifyLevel"], "mentions");
        assert_eq!(v["membership"], "joined");
        assert_eq!(v["membershipSource"], "explicit");
        let back: Channel = serde_json::from_value(v).unwrap();
        assert_eq!(back.notify_level.as_deref(), Some("mentions"));
        assert_eq!(back.membership_source.as_deref(), Some("explicit"));
    }

    #[test]
    fn channel_notify_level_absent_for_browse_only_and_legacy_rows() {
        let browse =
            r#"{ "channelId": "chn_2", "membership": { "joined": false, "notifyLevel": null } }"#;
        let c: Channel = serde_json::from_str(browse).unwrap();
        assert_eq!(c.membership.as_deref(), Some("invited"));
        assert!(c.notify_level.is_none());
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("notifyLevel").is_none());

        let legacy = r#"{ "channelId": "chn_3", "membership": "joined" }"#;
        let c: Channel = serde_json::from_str(legacy).unwrap();
        assert_eq!(c.membership.as_deref(), Some("joined"));
        assert!(c.notify_level.is_none());
        assert!(c.membership_source.is_none());
    }

    #[test]
    fn channel_deserializes_full_row() {
        let json = r#"{
            "channelId": "chn_2",
            "name": "eng",
            "scope": "company",
            "companyUid": "ent_co",
            "companyName": "Acme",
            "postPolicy": "all",
            "visibility": "company",
            "membership": "invited",
            "unread": 3,
            "memberCount": 12
        }"#;
        let c: Channel = serde_json::from_str(json).expect("Channel parses");
        assert_eq!(c.company_uid.as_deref(), Some("ent_co"));
        assert_eq!(c.company_name.as_deref(), Some("Acme"));
        assert_eq!(c.membership.as_deref(), Some("invited"));
        assert_eq!(c.unread, Some(3));
        assert_eq!(c.member_count, Some(12));
    }

    #[test]
    fn channels_response_accepts_current_production_wire_shape() {
        let response: ChannelsResponse = serde_json::from_value(serde_json::json!({
            "channels": [{
                "channelId": "chn_group",
                "name": "",
                "slug": "",
                "scope": "group",
                "createdBy": "prs_owner",
                "postPolicy": "all",
                "visibility": "invite",
                "createdAt": "2026-07-29T18:30:00Z",
                "updatedAt": "2026-07-29T18:35:00Z",
                "memberCount": 3,
                "unreadCount": 4,
                "membership": {
                    "joined": true,
                    "following": true,
                    "muted": false,
                    "role": "member",
                    "source": "direct",
                    "lastReadAt": null
                },
                "members": [{
                    "personUid": "prs_aleena",
                    "participantType": "human",
                    "displayName": "Aleena Hassaan"
                }]
            }]
        }))
        .expect("the current channels response parses");

        let channel = response.channels.first().expect("channel present");
        assert_eq!(channel.membership.as_deref(), Some("joined"));
        assert_eq!(channel.unread, Some(4));
        assert_eq!(
            channel
                .members
                .as_ref()
                .and_then(|members| members.first())
                .map(|member| member.display_name.as_str()),
            Some("Aleena Hassaan"),
        );
    }

    #[test]
    fn channel_member_and_detail_deserialize() {
        let members_json = r#"{ "members": [
            { "personUid": "prs_o", "email": "o@x.com", "displayName": "Owner", "role": "owner" },
            { "personUid": "prs_m", "email": "m@x.com", "displayName": "Member", "role": "member" }
        ] }"#;
        let m: ChannelMembersResponse = serde_json::from_str(members_json).expect("members parse");
        assert_eq!(m.members.len(), 2);
        assert_eq!(m.members[0].role, "owner");
        assert!(m.members[0].avatar_url.is_none());

        let with_photos = r#"{ "members": [
            { "personUid": "prs_o", "email": "o@x.com", "displayName": "Owner",
              "role": "owner", "avatarUrl": "https://cdn/o.jpg" },
            { "personUid": "prs_m", "displayName": "Member", "role": "member",
              "avatarUrl": null }
        ] }"#;
        let photos: ChannelMembersResponse =
            serde_json::from_str(with_photos).expect("members with avatars parse");
        assert_eq!(
            photos.members[0].avatar_url.as_deref(),
            Some("https://cdn/o.jpg")
        );
        assert!(photos.members[1].avatar_url.is_none());
        let out = serde_json::to_value(&photos).expect("members serialize");
        assert_eq!(out["members"][0]["avatarUrl"], "https://cdn/o.jpg");
        assert!(out["members"][1].get("avatarUrl").is_none());

        let detail_json = r#"{
            "channel": { "channelId": "chn_1", "name": "g", "scope": "personal" },
            "messages": [
                { "eventId": "e1", "fromPersonUid": "prs_a", "body": "hi",
                  "createdAt": "2026-06-05T00:00:00Z", "direction": "in" }
            ]
        }"#;
        let d: ChannelDetail = serde_json::from_str(detail_json).expect("detail parses");
        assert_eq!(d.channel.expect("channel present").channel_id, "chn_1");
        assert_eq!(d.messages.len(), 1);
        assert_eq!(d.messages[0].direction, "in");
    }

    #[test]
    fn create_channel_response_envelope_unwraps() {
        // The create endpoint wraps the channel: `{"channel": {...}}` with no
        // `messages`. `create_channel` decodes into `ChannelDetail` and unwraps
        // `.channel`. A bare `Channel` decode here was the original bug (the
        // server's `channelId` lives one level down), surfacing as
        // "missing field channelId" even though the channel was created.
        let json =
            r#"{ "channel": { "channelId": "chn_1", "name": "general", "scope": "company" } }"#;
        let detail: ChannelDetail = serde_json::from_str(json).expect("envelope parses");
        let channel = detail.channel.expect("channel present in create envelope");
        assert_eq!(channel.channel_id, "chn_1");
        assert!(detail.messages.is_empty());
    }

    #[test]
    fn reactions_response_envelope_unwraps() {
        // The GET reactions endpoint returns the `MessageReactions` object, not a
        // bare array — decoding into `Vec<ReactionAggregate>` threw
        // "invalid type: map, expected a sequence" on every message load.
        let empty = r#"{ "messageScope": "chan:chn_1", "messageId": "m1", "reactions": [] }"#;
        let r: MessageReactions = serde_json::from_str(empty).expect("empty envelope parses");
        assert!(r.reactions.is_empty());

        let one = r#"{ "messageScope": "chan:chn_1", "messageId": "m1",
            "reactions": [ { "emoji": "👍", "count": 2, "reactedByMe": true } ] }"#;
        let r: MessageReactions = serde_json::from_str(one).expect("one-emoji envelope parses");
        assert_eq!(r.reactions.len(), 1);
        assert_eq!(r.reactions[0].emoji, "👍");
        assert_eq!(r.reactions[0].count, 2);
        assert!(r.reactions[0].reacted_by_me);
    }

    #[test]
    fn group_payload_carries_scope_and_participants_no_name() {
        let payload = build_group_payload(&["prs_a".to_string(), "prs_b".to_string()]);
        assert_eq!(payload["scope"], "group");
        assert_eq!(payload["participants"][0], "prs_a");
        assert_eq!(payload["participants"][1], "prs_b");
        // A group DM has no name field.
        assert!(payload.get("name").is_none());
    }

    #[test]
    fn create_payload_personal_omits_company_and_empty_invite() {
        let payload = build_create_payload("diary", "personal", None, &[]);
        let obj = payload.as_object().expect("object");
        assert_eq!(payload["name"], "diary");
        assert_eq!(payload["scope"], "personal");
        assert!(!obj.contains_key("companyUid"));
        assert!(!obj.contains_key("invite"));
    }

    #[test]
    fn create_payload_company_with_invites() {
        let invites = vec!["prs_a".to_string(), "prs_b".to_string()];
        let payload = build_create_payload("eng", "company", Some("ent_co"), &invites);
        assert_eq!(payload["companyUid"], "ent_co");
        assert_eq!(payload["invite"][0], "prs_a");
        assert_eq!(payload["invite"][1], "prs_b");
        // A blank companyUid is treated as absent.
        let blank = build_create_payload("x", "company", Some("   "), &[]);
        assert!(!blank.as_object().unwrap().contains_key("companyUid"));
    }

    #[test]
    fn create_payload_project_includes_project_id() {
        let invites = vec!["prs_a".to_string()];
        let payload = build_create_payload_with_project(
            "hq-desktop",
            "project",
            Some("cmp_indigo"),
            Some("hq-desktop-app"),
            &invites,
        );
        assert_eq!(payload["scope"], "project");
        assert_eq!(payload["companyUid"], "cmp_indigo");
        assert_eq!(payload["projectId"], "hq-desktop-app");
        assert_eq!(payload["invite"][0], "prs_a");
        // Blank projectId is treated as absent.
        let blank = build_create_payload_with_project("x", "project", Some("c"), Some("  "), &[]);
        assert!(!blank.as_object().unwrap().contains_key("projectId"));
    }

    #[test]
    fn invite_member_payload_is_single_to_person_uid() {
        // REGRESSION: the /members endpoint rejects the old `{ personUids: [...] }`
        // batch shape with "Provide exactly one of 'toPersonUid' or 'toEmail'".
        // Each invitee must POST exactly `{ toPersonUid }`.
        let payload = invite_member_payload("prs_abc");
        assert_eq!(payload["toPersonUid"], "prs_abc");
        let obj = payload.as_object().expect("object");
        assert_eq!(obj.len(), 1, "exactly one key — no toEmail, no batch array");
        assert!(
            !obj.contains_key("personUids"),
            "the stale batch key must be gone"
        );
        assert!(
            !obj.contains_key("toEmail"),
            "must not send both identity keys"
        );
    }

    #[test]
    fn esc_seg_escapes_path_reserved_chars_only() {
        assert_eq!(esc_seg("chn_abc123"), "chn_abc123");
        assert_eq!(esc_seg("a/b c"), "a%2Fb%20c");
        assert_eq!(esc_seg("q?x#y"), "q%3Fx%23y");
    }

    // ── Reactions (US-025) ────────────────────────────────────────────────────

    #[test]
    fn reaction_payload_carries_scope_id_emoji_only() {
        let payload = build_reaction_payload("dm:prs_peer", "evt_1", "👍");
        assert_eq!(payload["messageScope"], "dm:prs_peer");
        assert_eq!(payload["messageId"], "evt_1");
        assert_eq!(payload["emoji"], "👍");
        // Exactly the three contract keys — add (POST) and remove (DELETE) share
        // this body.
        assert_eq!(payload.as_object().expect("object").len(), 3);
    }

    #[test]
    fn reactions_url_escapes_scope_and_id() {
        // Channel scope is URL-safe; a stray reserved char must still be escaped.
        assert_eq!(
            build_reactions_url("https://api.example.com", "chan:chn_1", "evt_9"),
            "https://api.example.com/v1/notify/reactions?messageScope=chan:chn_1&messageId=evt_9"
        );
        assert_eq!(
            build_reactions_url("https://api.example.com", "dm:a/b", "e?1"),
            "https://api.example.com/v1/notify/reactions?messageScope=dm:a%2Fb&messageId=e%3F1"
        );
    }

    #[test]
    fn reaction_aggregate_deserializes_camel_case() {
        // The GET endpoint returns a bare array of aggregates.
        let json = r#"[
            { "emoji": "👍", "count": 3, "reactedByMe": true },
            { "emoji": "🎉", "count": 1, "reactedByMe": false }
        ]"#;
        let out: Vec<ReactionAggregate> = serde_json::from_str(json).expect("aggregates parse");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].emoji, "👍");
        assert_eq!(out[0].count, 3);
        assert!(out[0].reacted_by_me);
        assert!(!out[1].reacted_by_me);
    }

    #[test]
    fn reaction_aggregate_tolerates_missing_fields() {
        // count/reactedByMe default so a sparse server row still parses.
        let json = r#"{ "emoji": "🔥" }"#;
        let a: ReactionAggregate = serde_json::from_str(json).expect("parses");
        assert_eq!(a.emoji, "🔥");
        assert_eq!(a.count, 0);
        assert!(!a.reacted_by_me);
    }

    #[test]
    fn message_reactions_serializes_camel_case_for_event() {
        // The `message:reaction` event payload shape the frontend listens for.
        let mr = MessageReactions {
            message_scope: "dm:prs_x".to_string(),
            message_id: "evt_1".to_string(),
            reactions: vec![ReactionAggregate {
                emoji: "👍".to_string(),
                count: 2,
                reacted_by_me: true,
                reactors: Some(
                    serde_json::json!([{ "personUid": "prs_ada", "displayName": "Ada" }]),
                ),
            }],
        };
        let v = serde_json::to_value(&mr).unwrap();
        assert_eq!(v["messageScope"], "dm:prs_x");
        assert_eq!(v["messageId"], "evt_1");
        assert_eq!(v["reactions"][0]["reactedByMe"], true);
        let roundtrip: MessageReactions = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(roundtrip).unwrap()["reactions"][0]["reactors"],
            v["reactions"][0]["reactors"]
        );
        assert_eq!(v["reactions"][0]["reactors"][0]["displayName"], "Ada");
    }

    #[test]
    fn ensure_project_channel_payload_trims_and_shapes() {
        let v = build_ensure_project_channel_payload("  ent_co  ", " hq-mobile ");
        assert_eq!(v["companyUid"], "ent_co");
        assert_eq!(v["projectId"], "hq-mobile");
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    #[test]
    fn ensure_project_channel_response_default_is_absent_safe_noop() {
        // 404 from an old server resolves to Default: no channel, not created.
        let d = EnsureProjectChannelResponse::default();
        assert!(!d.created);
        assert!(d.channel.is_none());
    }

    #[test]
    fn ensure_project_channel_response_parses_created_channel() {
        let json = r#"{
            "created": true,
            "channel": { "channelId": "chn_1", "name": "Project x", "scope": "project",
                         "companyUid": "ent_co", "projectId": "hq-mobile" },
            "membership": { "joined": true }
        }"#;
        let r: EnsureProjectChannelResponse = serde_json::from_str(json).expect("response parses");
        assert!(r.created);
        assert_eq!(r.channel.as_ref().unwrap().channel_id, "chn_1");
    }
}

#[cfg(test)]
mod esc_query_tests {
    use super::esc_query;

    #[test]
    fn leaves_handle_characters_alone() {
        assert_eq!(esc_query("acme-co-1"), "acme-co-1");
    }

    #[test]
    fn encodes_query_delimiters_so_a_typed_value_cannot_add_parameters() {
        assert_eq!(esc_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(esc_query("a b"), "a%20b");
        assert_eq!(esc_query("a/b?c#d"), "a%2Fb%3Fc%23d");
    }

    #[test]
    fn encodes_non_ascii_as_utf8_bytes() {
        assert_eq!(esc_query("é"), "%C3%A9");
    }
}

#[cfg(test)]
mod contact_preview_filter_tests {
    use super::{apply_contact_preview_filter, Contact};

    fn make_contact(audience: Option<&str>) -> Contact {
        Contact {
            person_uid: "uid1".into(),
            email: "a@b.com".into(),
            display_name: "Alice".into(),
            company_uid: None,
            source: None,
            connection_state: None,
            last_message_at: None,
            last_activity_at: None,
            last_dm_at: None,
            last_message_body: Some("hello".into()),
            last_message_preview: Some("hello".into()),
            last_message_text: Some("hello".into()),
            last_message_direction: Some("inbound".into()),
            last_message_audience: audience.map(str::to_string),
            avatar_url: None,
        }
    }

    #[test]
    fn clears_preview_when_audience_is_agent_and_toggle_off() {
        let mut contacts = vec![make_contact(Some("agent"))];
        apply_contact_preview_filter(&mut contacts, false);
        assert!(contacts[0].last_message_body.is_none());
        assert!(contacts[0].last_message_preview.is_none());
        assert!(contacts[0].last_message_text.is_none());
    }

    #[test]
    fn keeps_preview_when_audience_is_agent_and_toggle_on() {
        let mut contacts = vec![make_contact(Some("agent"))];
        apply_contact_preview_filter(&mut contacts, true);
        assert!(contacts[0].last_message_body.is_some());
    }

    #[test]
    fn keeps_preview_for_human_audience() {
        let mut contacts = vec![make_contact(Some("human"))];
        apply_contact_preview_filter(&mut contacts, false);
        assert!(contacts[0].last_message_body.is_some());
    }

    #[test]
    fn keeps_preview_for_both_audience() {
        let mut contacts = vec![make_contact(Some("both"))];
        apply_contact_preview_filter(&mut contacts, false);
        assert!(contacts[0].last_message_body.is_some());
    }

    #[test]
    fn keeps_preview_when_audience_absent() {
        let mut contacts = vec![make_contact(None)];
        apply_contact_preview_filter(&mut contacts, false);
        assert!(contacts[0].last_message_body.is_some());
    }

    #[test]
    fn clears_preview_for_uppercase_agent_audience() {
        let mut contacts = vec![make_contact(Some("AGENT"))];
        apply_contact_preview_filter(&mut contacts, false);
        assert!(contacts[0].last_message_body.is_none());
    }
}
