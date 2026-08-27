//! Presigned S3 PUT/GET for chat attachments in the embedded HQ Work shell.
//!
//! Vault buckets have no CORS — WKWebView reports "Load failed" on a direct
//! fetch. Rust has no CORS, so we send the bytes here. Only HTTPS S3 hosts
//! are accepted so this cannot become an open proxy.
//!
//! Do **not** use `crate::util::client_info::build_client()`. That client
//! injects User-Agent / `x-hq-client-*` headers (which break SigV4) and a
//! 15s timeout (too short for 25 MB chat attachments).

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

fn host_from_https_url(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "vault S3 PUT requires https".to_string())?;
    let hostport = rest.split('/').next().unwrap_or("");
    let host = hostport.split(':').next().unwrap_or("").to_lowercase();
    if host.is_empty() {
        return Err("vault S3 PUT URL is missing a host".into());
    }
    Ok(host)
}

pub fn is_allowed_s3_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("vault S3 PUT URL is empty".into());
    }
    let host = host_from_https_url(url)?;
    let ok = host == "s3.amazonaws.com"
        || host.starts_with("s3.")
        || host.contains(".s3.")
        || host.contains(".s3-");
    if ok && host.ends_with(".amazonaws.com") {
        Ok(())
    } else {
        Err(format!("refusing vault S3 PUT to host {host}"))
    }
}

pub fn is_forwarded_s3_header(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower == "content-type"
        || lower == "if-match"
        || lower == "if-none-match"
        || lower.starts_with("x-amz-")
}

fn s3_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("vault S3 client: {e}"))
}

pub fn forwarded_s3_header_map(headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (key, value) in headers {
        if !is_forwarded_s3_header(key) {
            continue;
        }
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|e| format!("vault S3 header name: {e}"))?;
        let val =
            HeaderValue::from_str(value).map_err(|e| format!("vault S3 header value: {e}"))?;
        map.insert(name, val);
    }
    Ok(map)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultS3GetResult {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[tauri::command]
pub async fn vault_s3_put(
    url: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
) -> Result<u16, String> {
    is_allowed_s3_url(&url)?;
    let header_map = forwarded_s3_header_map(&headers)?;
    let client = s3_client()?;
    let resp = client
        .put(url.trim())
        .headers(header_map)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("vault S3 PUT failed: {e}"))?;
    Ok(resp.status().as_u16())
}

#[tauri::command]
pub async fn vault_s3_get(url: String) -> Result<VaultS3GetResult, String> {
    is_allowed_s3_url(&url)?;
    let client = s3_client()?;
    let resp = client
        .get(url.trim())
        .send()
        .await
        .map_err(|e| format!("vault S3 GET failed: {e}"))?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("vault S3 GET read failed: {e}"))?
        .to_vec();
    Ok(VaultS3GetResult {
        status,
        content_type,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_virtual_hosted_and_regional_s3() {
        assert!(is_allowed_s3_url(
            "https://hq-vault-cmp-x.s3.us-east-1.amazonaws.com/chat/a.pdf?X-Amz-Signature=1"
        )
        .is_ok());
        assert!(is_allowed_s3_url("https://bucket.s3.amazonaws.com/key").is_ok());
        assert!(is_allowed_s3_url("https://s3.us-east-1.amazonaws.com/bucket/key").is_ok());
    }

    #[test]
    fn rejects_non_s3_and_non_https() {
        assert!(is_allowed_s3_url("http://bucket.s3.amazonaws.com/key").is_err());
        assert!(is_allowed_s3_url("https://hqapi.getindigo.ai/v1/files").is_err());
        assert!(is_allowed_s3_url("https://evil.example/x").is_err());
        assert!(is_allowed_s3_url("").is_err());
    }

    #[test]
    fn forwards_content_type_and_amz_drops_auth() {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), "image/png".into());
        headers.insert("authorization".into(), "Bearer x".into());
        headers.insert("x-amz-acl".into(), "private".into());
        headers.insert("x-hq-client-name".into(), "hq-sync".into());
        headers.insert("If-Match".into(), "\"abc\"".into());
        let map = forwarded_s3_header_map(&headers).unwrap();
        assert_eq!(
            map.get("content-type").and_then(|v| v.to_str().ok()),
            Some("image/png")
        );
        assert_eq!(
            map.get("x-amz-acl").and_then(|v| v.to_str().ok()),
            Some("private")
        );
        assert_eq!(
            map.get("if-match").and_then(|v| v.to_str().ok()),
            Some("\"abc\"")
        );
        assert!(map.get("authorization").is_none());
        assert!(map.get("x-hq-client-name").is_none());
    }

    #[test]
    fn header_predicate_matches_web_hop() {
        assert!(is_forwarded_s3_header("content-type"));
        assert!(is_forwarded_s3_header("Content-Type"));
        assert!(is_forwarded_s3_header("x-amz-meta-foo"));
        assert!(is_forwarded_s3_header("if-none-match"));
        assert!(!is_forwarded_s3_header("authorization"));
        assert!(!is_forwarded_s3_header("cookie"));
    }
}
