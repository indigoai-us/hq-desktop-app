//! Unified notifications feed (`commands/notifications_feed`, desktop US-012)
//! — hq-pro NOTIF store.
//!
//! Commands:
//!   `fetch_notifications`     — GET  /v1/notify/notifications?limit&cursor&unreadOnly
//!   `ack_notification`        — POST /v1/notify/notifications/ack { id }
//!   `read_all_notifications`  — POST /v1/notify/notifications/read-all
//!   `run_notification_action` — M2: POST ack + emit `notification:feed-action`
//!
//! Auth/URL/client pattern matches `notification_history.rs` (cognito token,
//! resolve_vault_api_url, build_client). A missing endpoint (404 on list)
//! degrades to a clean empty feed so older servers stay usable.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "notif-feed";

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;

/// One notification row from the NOTIF store (defensive field set).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_person_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actionable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
}

fn default_status() -> String {
    "unread".to_string()
}

/// List response envelope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsFeedResponse {
    #[serde(default)]
    pub notifications: Vec<NotificationRecord>,
    #[serde(default)]
    pub unread_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Ack / read-all response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsMutateResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub marked: u32,
}

/// Payload emitted after an inline action (M2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActionEvent {
    pub id: String,
    pub action_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_ref: Option<String>,
}

/// Pure helper: build the list query URL (unit-tested).
pub fn build_list_url(
    base: &str,
    limit: u32,
    cursor: Option<&str>,
    unread_only: bool,
) -> String {
    let base = base.trim_end_matches('/');
    let mut url = format!("{base}/v1/notify/notifications?limit={limit}");
    if unread_only {
        url.push_str("&unreadOnly=true");
    }
    if let Some(c) = cursor.map(str::trim).filter(|c| !c.is_empty()) {
        // Cursor is an opaque server token; percent-encode reserved chars.
        let encoded: String = c
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        url.push_str(&format!("&cursor={encoded}"));
    }
    url
}

/// Pure helper: drop rows missing a usable id (unit-tested).
pub fn filter_valid_records(records: Vec<NotificationRecord>) -> Vec<NotificationRecord> {
    records
        .into_iter()
        .filter(|r| !r.id.trim().is_empty())
        .collect()
}

/// Pure helper: clamp list limit (unit-tested).
pub fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

async fn auth_and_base(code: &str) -> Result<(String, String), String> {
    let token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_AUTH_FAIL {e}"));
        format!("Not signed in: {e}")
    })?;
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_URL_FAIL {e}"));
            format!("Could not resolve server URL: {e}")
        })?;
    Ok((base, token))
}

async fn get_feed(
    url: &str,
    token: &str,
    code: &str,
) -> Result<NotificationsFeedResponse, String> {
    let resp = build_client()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_NETWORK_FAIL {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    // Older servers without the NOTIF feed: clean empty state, not an error.
    if status == reqwest::StatusCode::NOT_FOUND {
        log(LOG_TAG, &format!("{code}_EMPTY_404"));
        return Ok(NotificationsFeedResponse::default());
    }
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("{code}_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    let body = resp.text().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_BODY_READ_FAIL {e}"));
        format!("Could not read response: {e}")
    })?;
    let parsed: NotificationsFeedResponse = serde_json::from_str(&body).map_err(|e| {
        let snippet: String = body.chars().take(400).collect();
        log(LOG_TAG, &format!("{code}_PARSE_FAIL {e} body={snippet}"));
        format!("Could not parse response: {e}")
    })?;
    Ok(NotificationsFeedResponse {
        notifications: filter_valid_records(parsed.notifications),
        unread_count: parsed.unread_count,
        next_cursor: parsed.next_cursor,
    })
}

async fn post_json(
    url: &str,
    token: &str,
    payload: &serde_json::Value,
    code: &str,
) -> Result<NotificationsMutateResponse, String> {
    let resp = build_client()
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .json(payload)
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_NETWORK_FAIL {e}"));
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let server_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        log(
            LOG_TAG,
            &format!("{code}_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    let body = resp.text().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_BODY_READ_FAIL {e}"));
        format!("Could not read response: {e}")
    })?;
    // Some servers may return empty body on success — treat as ok.
    if body.trim().is_empty() {
        return Ok(NotificationsMutateResponse {
            ok: true,
            marked: 0,
        });
    }
    serde_json::from_str::<NotificationsMutateResponse>(&body).or_else(|_| {
        Ok(NotificationsMutateResponse {
            ok: true,
            marked: 0,
        })
    })
}

/// Tauri command: list notifications (newest-first) + unread badge count.
/// `GET /v1/notify/notifications?limit&cursor&unreadOnly`.
#[tauri::command]
pub async fn fetch_notifications(
    limit: Option<u32>,
    cursor: Option<String>,
    unread_only: Option<bool>,
) -> Result<NotificationsFeedResponse, String> {
    let lim = clamp_limit(limit);
    let unread = unread_only.unwrap_or(false);
    let (base, token) = auth_and_base("NOTIF_FEED_LIST").await?;
    let url = build_list_url(&base, lim, cursor.as_deref(), unread);
    let out = get_feed(&url, &token, "NOTIF_FEED_LIST").await?;
    log(
        LOG_TAG,
        &format!(
            "NOTIF_FEED_LIST_OK count={} unread={}",
            out.notifications.len(),
            out.unread_count
        ),
    );
    Ok(out)
}

/// Tauri command: mark one notification read. Idempotent.
/// `POST /v1/notify/notifications/ack { id }`.
#[tauri::command]
pub async fn ack_notification(id: String) -> Result<NotificationsMutateResponse, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Notification id must not be empty".to_string());
    }
    let (base, token) = auth_and_base("NOTIF_FEED_ACK").await?;
    let url = format!("{base}/v1/notify/notifications/ack");
    let payload = serde_json::json!({ "id": trimmed });
    let out = post_json(&url, &token, &payload, "NOTIF_FEED_ACK").await?;
    log(
        LOG_TAG,
        &format!("NOTIF_FEED_ACK_OK id={trimmed} marked={}", out.marked),
    );
    Ok(out)
}

/// Tauri command: mark all notifications read. Idempotent.
/// `POST /v1/notify/notifications/read-all`.
#[tauri::command]
pub async fn read_all_notifications() -> Result<NotificationsMutateResponse, String> {
    let (base, token) = auth_and_base("NOTIF_FEED_READ_ALL").await?;
    let url = format!("{base}/v1/notify/notifications/read-all");
    let payload = serde_json::json!({});
    let out = post_json(&url, &token, &payload, "NOTIF_FEED_READ_ALL").await?;
    log(
        LOG_TAG,
        &format!("NOTIF_FEED_READ_ALL_OK marked={}", out.marked),
    );
    Ok(out)
}

/// Tauri command: inline action for a notification (M2).
/// Posts ack for the row and emits `notification:feed-action` so other surfaces
/// can react. Real accept/decline APIs land later; buttons stay data-driven.
#[tauri::command]
pub async fn run_notification_action(
    app: AppHandle,
    id: String,
    action_kind: String,
    action_ref: Option<String>,
) -> Result<NotificationsMutateResponse, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Notification id must not be empty".to_string());
    }
    let kind = action_kind.trim();
    if kind.is_empty() {
        return Err("actionKind must not be empty".to_string());
    }
    let out = ack_notification(trimmed.to_string()).await?;
    let event = NotificationActionEvent {
        id: trimmed.to_string(),
        action_kind: kind.to_string(),
        action_ref: action_ref
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };
    if let Err(e) = app.emit("notification:feed-action", &event) {
        log(LOG_TAG, &format!("NOTIF_FEED_ACTION_EMIT_FAIL {e}"));
    } else {
        log(
            LOG_TAG,
            &format!("NOTIF_FEED_ACTION_OK id={trimmed} kind={kind}"),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_limit_defaults_and_caps() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(25)), 25);
        assert_eq!(clamp_limit(Some(999)), MAX_LIMIT);
    }

    #[test]
    fn build_list_url_includes_query_flags() {
        let url = build_list_url("https://api.example.com/", 25, Some("abc+def"), true);
        assert!(url.starts_with("https://api.example.com/v1/notify/notifications?limit=25"));
        assert!(url.contains("&unreadOnly=true"));
        assert!(url.contains("&cursor=abc%2Bdef"));
    }

    #[test]
    fn build_list_url_omits_empty_cursor_and_unread_flag() {
        let url = build_list_url("https://api.example.com", 10, Some("  "), false);
        assert_eq!(
            url,
            "https://api.example.com/v1/notify/notifications?limit=10"
        );
        assert!(!url.contains("cursor"));
        assert!(!url.contains("unreadOnly"));
    }

    #[test]
    fn filter_valid_records_drops_empty_ids() {
        let rows = vec![
            NotificationRecord {
                id: "n1".into(),
                r#type: "dm".into(),
                status: "unread".into(),
                read_at: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                actor_name: None,
                actor_person_uid: None,
                title: None,
                body: None,
                context: None,
                target_ref: None,
                action_ref: None,
                action_kind: None,
                actionable: None,
                company_uid: None,
            },
            NotificationRecord {
                id: "  ".into(),
                r#type: "dm".into(),
                status: "unread".into(),
                read_at: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                actor_name: None,
                actor_person_uid: None,
                title: None,
                body: None,
                context: None,
                target_ref: None,
                action_ref: None,
                action_kind: None,
                actionable: None,
                company_uid: None,
            },
        ];
        let filtered = filter_valid_records(rows);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "n1");
    }

    #[test]
    fn empty_feed_response_defaults() {
        let empty = NotificationsFeedResponse::default();
        assert!(empty.notifications.is_empty());
        assert_eq!(empty.unread_count, 0);
        assert!(empty.next_cursor.is_none());
    }
}
