//! Thin authenticated hq-pro fetch for the Sync PlatformAdapter (US-102).
//!
//! Reuses the existing Cognito session + reqwest client. The webview never
//! holds the bearer. Relative paths (`/v1/...`) are joined onto
//! `resolve_vault_api_url()`; absolute https URLs are allowed only when the
//! host matches that vault API base.

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;
use crate::util::logfile::log;

const LOG_TAG: &str = "hq_pro";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HqProHttpResponse {
    pub status: u16,
    pub body: String,
}

pub fn normalize_method(method: &str) -> Result<Method, String> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        other => Err(format!("unsupported hq-pro method {other}")),
    }
}

/// `(host, port)` for an https URL. Missing port defaults to 443 so
/// `https://host:8443` does not match `https://host` (443).
fn origin_of_https(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "hq-pro fetch requires https".to_string())?;
    let hostport = rest.split('/').next().unwrap_or("");
    let (host_raw, port) = match hostport.split_once(':') {
        Some((host, port)) => (
            host,
            port.parse::<u16>()
                .map_err(|_| format!("hq-pro fetch URL has invalid port {port}"))?,
        ),
        None => (hostport, 443),
    };
    let host = host_raw.to_ascii_lowercase();
    if host.is_empty() {
        return Err("hq-pro fetch URL is missing a host".to_string());
    }
    Ok((host, port))
}

/// Join a relative `/v1/...` path onto the vault base, or accept an https URL
/// whose host matches the vault API host.
pub fn resolve_request_url(url: &str, vault_base: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("hq-pro fetch URL is empty".to_string());
    }
    let base = vault_base.trim().trim_end_matches('/');
    if url.starts_with('/') {
        return Ok(format!("{base}{url}"));
    }
    if url.starts_with("https://") {
        let req_origin = origin_of_https(url)?;
        let base_origin = origin_of_https(base)?;
        if req_origin != base_origin {
            return Err(format!(
                "refusing hq-pro fetch to host {}:{}",
                req_origin.0, req_origin.1
            ));
        }
        return Ok(url.to_string());
    }
    Err("hq-pro fetch URL must be a /path or https URL".to_string())
}

/// Authenticated hq-pro request. Token is attached here and never returned.
#[tauri::command]
pub async fn hq_pro_fetch(
    url: String,
    method: String,
    body: Option<String>,
) -> Result<HqProHttpResponse, String> {
    let method = normalize_method(&method)?;
    let token = cognito::get_valid_access_token().await.map_err(|e| {
        log(LOG_TAG, &format!("HQ_PRO_FETCH_AUTH_FAIL {e}"));
        format!("Not signed in: {e}")
    })?;
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| {
            log(LOG_TAG, &format!("HQ_PRO_FETCH_URL_FAIL {e}"));
            format!("Could not resolve server URL: {e}")
        })?;
    let full = resolve_request_url(&url, &base)?;

    let mut req = build_client()
        .request(method.clone(), &full)
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "application/json");
    if method != Method::GET {
        if let Some(payload) = body.as_deref() {
            req = req
                .header("content-type", "application/json")
                .body(payload.to_string());
        }
    }

    let resp = req.send().await.map_err(|e| {
        log(LOG_TAG, &format!("HQ_PRO_FETCH_NETWORK_FAIL {e}"));
        format!("Network error: {e}")
    })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let outcome = if (200..300).contains(&status) {
        "OK"
    } else {
        "STATUS"
    };
    log(
        LOG_TAG,
        &format!("HQ_PRO_FETCH_{outcome} method={method} status={status}"),
    );
    Ok(HqProHttpResponse { status, body: text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_relative_path_onto_vault_base() {
        assert_eq!(
            resolve_request_url("/v1/identity/whoami", "https://hqapi.hq.computer/").unwrap(),
            "https://hqapi.hq.computer/v1/identity/whoami"
        );
    }

    #[test]
    fn allows_https_url_on_the_vault_host() {
        assert_eq!(
            resolve_request_url(
                "https://hqapi.hq.computer/v1/files/presign",
                "https://hqapi.hq.computer"
            )
            .unwrap(),
            "https://hqapi.hq.computer/v1/files/presign"
        );
    }

    #[test]
    fn refuses_https_url_on_a_foreign_host() {
        let err = resolve_request_url(
            "https://evil.example/v1/identity/whoami",
            "https://hqapi.hq.computer",
        )
        .unwrap_err();
        assert!(err.contains("evil.example"), "{err}");
    }

    #[test]
    fn refuses_https_url_on_the_same_host_different_port() {
        let err = resolve_request_url(
            "https://hqapi.hq.computer/v1/identity/whoami",
            "https://hqapi.hq.computer:8443",
        )
        .unwrap_err();
        assert!(err.contains("443"), "{err}");
    }

    #[test]
    fn normalize_method_allowlist() {
        assert_eq!(normalize_method("post").unwrap(), Method::POST);
        assert_eq!(normalize_method("DELETE").unwrap(), Method::DELETE);
        assert!(normalize_method("TRACE").is_err());
    }
}
