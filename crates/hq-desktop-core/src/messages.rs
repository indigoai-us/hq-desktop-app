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
/// fields are ignored. `company_uid` is present only for company-scoped
/// channels. Mirrors the TS `Channel` shape in `src/lib/channels.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub channel_id: String,
    #[serde(default)]
    pub name: String,
    /// "personal" | "company" | "group".
    #[serde(default)]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_name: Option<String>,
    /// "all" | "owner" — who may post.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_policy: Option<String>,
    /// "company" | "private".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    /// Caller's membership: "joined" | "invited" | "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    /// Server-supplied creation timestamp (ISO-8601). Carried through so the
    /// rail can order group DMs (which ship no activity timestamp) by creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Group-DM participant roster (caller excluded), so the rail can name an
    /// unnamed group DM by its people. Present only for group-scoped channels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ChannelParticipant>>,
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMembersResponse {
    #[serde(default)]
    pub members: Vec<ChannelMember>,
}

/// One channel message, as returned by `/v1/notify/channels/{id}/messages`.
/// `direction` is tagged by the server relative to the caller ("in"/"out") so
/// the shared `<Conversation showAuthors>` renders it identically to a DM.
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
/// only for company scope), optional `invite` (personUids). Pure so the wire
/// shape is unit-testable.
pub fn build_create_payload(
    name: &str,
    scope: &str,
    company_uid: Option<&str>,
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
    fn channel_member_and_detail_deserialize() {
        let members_json = r#"{ "members": [
            { "personUid": "prs_o", "email": "o@x.com", "displayName": "Owner", "role": "owner" },
            { "personUid": "prs_m", "email": "m@x.com", "displayName": "Member", "role": "member" }
        ] }"#;
        let m: ChannelMembersResponse = serde_json::from_str(members_json).expect("members parse");
        assert_eq!(m.members.len(), 2);
        assert_eq!(m.members[0].role, "owner");

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
            }],
        };
        let v = serde_json::to_value(&mr).unwrap();
        assert_eq!(v["messageScope"], "dm:prs_x");
        assert_eq!(v["messageId"], "evt_1");
        assert_eq!(v["reactions"][0]["reactedByMe"], true);
    }
}
