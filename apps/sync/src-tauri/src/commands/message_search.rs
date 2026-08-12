//! Message content search command layer (US-013).
//!
//! Thin reqwest client over `GET /v1/notify/search`. Pure URL building and
//! response types live in `hq_desktop_core::message_search`; this module owns
//! auth + HTTP only.

use serde::Serialize;

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

pub use hq_desktop_core::message_search::{
    build_search_url, map_search_response, SearchHit, SearchResponse,
};

const LOG_TAG: &str = "message_search";

/// Envelope returned to the webview (camelCase).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessagesResult {
    pub results: Vec<SearchHit>,
}

async fn auth_and_base(code: &str) -> Result<(String, String), String> {
    let token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("{code}_AUTH_FAIL {e}"));
        format!("Not signed in: {e}")
    })?;
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("{code}_ERROR vault url: {e}"));
            format!("Could not resolve server URL: {e}")
        })?;
    Ok((base, token))
}

/// Tauri command: search recent message content via hq-pro
/// `GET /v1/notify/search`. Recency-window substring scan (not full-text).
/// Optional `companyUid` scopes results to one company; omit for all.
///
/// Frontend invoke: `invoke('search_messages', { q, companyUid, limit })`.
#[tauri::command]
pub async fn search_messages(
    q: String,
    company_uid: Option<String>,
    limit: Option<u32>,
) -> Result<SearchMessagesResult, String> {
    let q = q.trim();
    if q.is_empty() {
        return Err("q must not be empty".to_string());
    }
    let (base, token) = auth_and_base("MSG_SEARCH").await?;
    let company = company_uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let url = build_search_url(&base, q, company, limit);

    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log(LOG_TAG, &format!("MSG_SEARCH_NETWORK_FAIL {e}"));
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
            &format!("MSG_SEARCH_ERROR status={status} msg={server_msg:?}"),
        );
        return Err(
            server_msg.unwrap_or_else(|| format!("Request failed (status {})", status.as_u16()))
        );
    }

    let body = resp.text().await.map_err(|e| {
        log(LOG_TAG, &format!("MSG_SEARCH_BODY_READ_FAIL {e}"));
        format!("Could not read response: {e}")
    })?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let snippet: String = body.chars().take(400).collect();
        log(LOG_TAG, &format!("MSG_SEARCH_PARSE_FAIL {e} body={snippet}"));
        format!("Could not parse response: {e}")
    })?;
    let mapped = map_search_response(value)?;
    log(
        LOG_TAG,
        &format!(
            "MSG_SEARCH_OK q_len={} company={:?} count={}",
            q.len(),
            company,
            mapped.results.len()
        ),
    );
    Ok(SearchMessagesResult {
        results: mapped.results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reexports_build_search_url() {
        let url = build_search_url("https://api.example.com", "notes", Some("cmp_1"), None);
        assert!(url.contains("/v1/notify/search?q=notes"));
        assert!(url.contains("companyUid=cmp_1"));
    }
}
