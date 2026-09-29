//! Pure request builders + response types for `GET /v1/notify/search`.
//!
//! Recency-window substring search over the caller's per-person recent message
//! index (NFKC-lowercase, newest-first, ~1,000 evaluated rows). Not ranked
//! full-text. The Tauri command layer owns HTTP; this module stays pure so URL
//! shape and serde mapping are unit-testable.

use serde::{Deserialize, Serialize};

/// One hit from `GET /v1/notify/search`.
///
/// Wire fields are camelCase. The server may surface either `snippet` or `body`
/// (or both); UI prefers snippet then falls back to body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message_id: String,
    /// `"dm"` or `"channel"` (group DMs arrive as channel-scope with group meta).
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterparty_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub created_at: String,
}

impl SearchHit {
    /// Prefer server-provided snippet; fall back to body.
    pub fn display_snippet(&self) -> &str {
        self.snippet
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.body.as_deref())
            .unwrap_or("")
    }
}

/// Envelope returned by `GET /v1/notify/search`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    #[serde(default)]
    pub results: Vec<SearchHit>,
}

/// URL-escape query values without pulling in the `urlencoding` crate.
pub const MESSAGE_SEARCH_MIN_QUERY_LENGTH: usize = 2;
pub const MESSAGE_SEARCH_MAX_QUERY_LENGTH: usize = 100;
const MESSAGE_SEARCH_QUERY_LENGTH_ERROR: &str =
    "Query parameter 'q' must be between 2 and 100 characters";

fn is_javascript_trim_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Trim and validate exactly as the server does: JavaScript trim followed by
/// `String.length`, which counts UTF-16 code units rather than UTF-8 bytes.
pub fn normalize_search_query(query: &str) -> Result<String, String> {
    let query = query.trim_matches(is_javascript_trim_whitespace);
    let length = query.encode_utf16().count();
    if !(MESSAGE_SEARCH_MIN_QUERY_LENGTH..=MESSAGE_SEARCH_MAX_QUERY_LENGTH).contains(&length) {
        return Err(MESSAGE_SEARCH_QUERY_LENGTH_ERROR.to_string());
    }
    Ok(query.to_string())
}

/// Escapes reserved / unsafe characters that break query strings.
fn esc_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// Build `GET /v1/notify/search?q=…` with optional `companyUid` and `limit`,
/// only for a query accepted by the server.
/// Pure + side-effect-free so invalid inputs cannot become request URLs.
pub fn build_search_url(
    base_url: &str,
    q: &str,
    company_uid: Option<&str>,
    limit: Option<u32>,
) -> Result<String, String> {
    let q = normalize_search_query(q)?;
    let base = base_url.trim_end_matches('/');
    let mut url = format!("{base}/v1/notify/search?q={}", esc_query(&q));
    if let Some(uid) = company_uid.map(str::trim).filter(|s| !s.is_empty()) {
        url.push_str(&format!("&companyUid={}", esc_query(uid)));
    }
    if let Some(n) = limit {
        url.push_str(&format!("&limit={n}"));
    }
    Ok(url)
}

/// Map a raw JSON value (or already-parsed response) into `SearchResponse`.
/// Accepts both `{ results: [...] }` and a bare array of hits for resilience.
pub fn map_search_response(value: serde_json::Value) -> Result<SearchResponse, String> {
    if value.is_array() {
        let results: Vec<SearchHit> = serde_json::from_value(value)
            .map_err(|e| format!("Could not parse search hits array: {e}"))?;
        return Ok(SearchResponse { results });
    }
    serde_json::from_value(value).map_err(|e| format!("Could not parse search response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_search_url_basic_query() {
        let url = build_search_url("https://api.example.com", "hello", None, None)
            .expect("valid query builds a URL");
        assert_eq!(url, "https://api.example.com/v1/notify/search?q=hello");
    }

    #[test]
    fn build_search_url_encodes_spaces_and_reserved() {
        let url = build_search_url("https://api.example.com/", "a b&c", None, Some(50))
            .expect("valid query builds a URL");
        assert_eq!(
            url,
            "https://api.example.com/v1/notify/search?q=a%20b%26c&limit=50"
        );
    }

    #[test]
    fn build_search_url_company_scope() {
        let url = build_search_url(
            "https://api.example.com",
            "launch",
            Some("cmp_acme"),
            Some(100),
        )
        .expect("valid query builds a URL");
        assert_eq!(
            url,
            "https://api.example.com/v1/notify/search?q=launch&companyUid=cmp_acme&limit=100"
        );
    }

    #[test]
    fn build_search_url_skips_blank_company() {
        let url = build_search_url("https://api.example.com", "xy", Some("  "), None)
            .expect("valid query builds a URL");
        assert_eq!(url, "https://api.example.com/v1/notify/search?q=xy");
    }

    #[test]
    fn search_query_bounds_match_server_utf16_length_and_reject_before_url_build() {
        let invalid = build_search_url("https://api.example.com", "x", None, None)
            .expect_err("one UTF-16 code unit is below the server minimum");
        assert_eq!(invalid, MESSAGE_SEARCH_QUERY_LENGTH_ERROR);
        assert!(build_search_url("https://api.example.com", &"x".repeat(101), None, None).is_err());

        let two = build_search_url("https://api.example.com", "xy", None, None)
            .expect("two code units are accepted");
        assert_eq!(two, "https://api.example.com/v1/notify/search?q=xy");
        assert!(build_search_url("https://api.example.com", &"x".repeat(100), None, None).is_ok());

        // An emoji is one Unicode scalar but two UTF-16 code units. Fifty fit
        // the server's 100-unit cap, though their UTF-8 representation is 200 bytes.
        assert!(build_search_url("https://api.example.com", "😀", None, None).is_ok());
        assert!(build_search_url("https://api.example.com", &"😀".repeat(50), None, None,).is_ok());

        // JavaScript String.trim also removes BOM; match its query normalization.
        assert!(
            build_search_url("https://api.example.com", "\u{FEFF}xy\u{FEFF}", None, None).is_ok()
        );
    }

    #[test]
    fn search_hit_deserializes_channel_row() {
        let json = r#"{
            "messageId": "msg_1",
            "scope": "channel",
            "channelId": "chn_launch",
            "companyUid": "cmp_acme",
            "projectId": "prj_1",
            "snippet": "ship the launch checklist",
            "createdAt": "2026-08-11T15:00:00.000Z"
        }"#;
        let hit: SearchHit = serde_json::from_str(json).expect("SearchHit parses");
        assert_eq!(hit.message_id, "msg_1");
        assert_eq!(hit.scope, "channel");
        assert_eq!(hit.channel_id.as_deref(), Some("chn_launch"));
        assert_eq!(hit.company_uid.as_deref(), Some("cmp_acme"));
        assert_eq!(hit.display_snippet(), "ship the launch checklist");
    }

    #[test]
    fn search_hit_deserializes_dm_row_with_body_fallback() {
        // Message sent yesterday, matched by substring — body only, no snippet.
        let json = r#"{
            "messageId": "msg_yesterday",
            "scope": "dm",
            "counterpartyUid": "prs_bob",
            "body": "can you review the deploy notes from yesterday",
            "createdAt": "2026-08-11T09:30:00.000Z"
        }"#;
        let hit: SearchHit = serde_json::from_str(json).expect("DM SearchHit parses");
        assert_eq!(hit.scope, "dm");
        assert_eq!(hit.counterparty_uid.as_deref(), Some("prs_bob"));
        assert!(hit.snippet.is_none());
        assert_eq!(
            hit.display_snippet(),
            "can you review the deploy notes from yesterday"
        );
        // Substring match target appears in the body (yesterday window).
        assert!(hit.display_snippet().contains("yesterday"));
    }

    #[test]
    fn map_search_response_object_and_array() {
        let obj = serde_json::json!({
            "results": [{
                "messageId": "m1",
                "scope": "dm",
                "counterpartyUid": "prs_a",
                "snippet": "hi",
                "createdAt": "2026-08-11T10:00:00.000Z"
            }]
        });
        let mapped = map_search_response(obj).expect("object maps");
        assert_eq!(mapped.results.len(), 1);
        assert_eq!(mapped.results[0].message_id, "m1");

        let arr = serde_json::json!([{
            "messageId": "m2",
            "scope": "channel",
            "channelId": "chn_1",
            "body": "hello",
            "createdAt": "2026-08-11T11:00:00.000Z"
        }]);
        let mapped_arr = map_search_response(arr).expect("array maps");
        assert_eq!(mapped_arr.results.len(), 1);
        assert_eq!(mapped_arr.results[0].message_id, "m2");
    }

    #[test]
    fn empty_results_default() {
        let empty: SearchResponse = serde_json::from_str("{}").expect("empty ok");
        assert!(empty.results.is_empty());
    }
}
