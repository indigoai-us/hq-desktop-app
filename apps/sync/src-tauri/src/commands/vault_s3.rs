//! Presigned S3 PUT/GET for chat attachments in the embedded HQ Work shell.
//!
//! Vault buckets have no CORS — WKWebView reports "Load failed" on a direct
//! fetch. Rust has no CORS, so we send the bytes here. Only HTTPS S3 hosts
//! are accepted so this cannot become an open proxy.
//!
//! Do **not** use `crate::util::client_info::build_client()`. That client
//! injects User-Agent / `x-hq-client-*` headers (which break SigV4) and a
//! 15s timeout (too short for 25 MB chat attachments).

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

/// Host label test against the S3 endpoint shapes, applied to a *parsed* host.
///
/// `ends_with(".amazonaws.com")` alone is not enough on its own — it must be
/// combined with the S3 prefix/infix check — and neither is safe unless the
/// host came from a real parser (see [`is_allowed_s3_url`]).
fn is_s3_host(host: &str) -> bool {
    if !host.ends_with(".amazonaws.com") {
        return false;
    }
    host == "s3.amazonaws.com"
        || host.starts_with("s3.")
        || host.contains(".s3.")
        || host.contains(".s3-")
}

/// Gate for the attachment hop: only presigned HTTPS S3 endpoints.
///
/// Parsed with `url::Url` rather than string slicing, because the allowlist
/// has to describe the host `reqwest` will actually dial. A hand-rolled
/// "take everything before the first `/`, then before the first `:`" parser
/// reads `s3.amazonaws.com` out of
/// `https://s3.amazonaws.com:443@evil.example/x` — that is userinfo, and the
/// real host is `evil.example`. Both `vault_s3_put` and `vault_s3_get` would
/// then ship attachment bytes and the forwarded `x-amz-*` signed headers to
/// an attacker-chosen origin.
///
/// Rejected: any userinfo at all, any scheme but https, any non-default port,
/// and any host that is not an S3 endpoint.
pub fn is_allowed_s3_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("vault S3 URL is empty".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("vault S3 URL is unparseable: {e}"))?;

    if parsed.scheme() != "https" {
        return Err("vault S3 URL requires https".into());
    }
    // A presigned vault URL never carries credentials. Their only use here
    // would be to move the real host past a naive check.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refusing vault S3 URL that carries userinfo".into());
    }
    // `port()` is None for the scheme default, so this only trips on an
    // explicit non-443 port.
    if let Some(port) = parsed.port() {
        return Err(format!("refusing vault S3 URL on port {port}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "vault S3 URL is missing a host".to_string())?
        .to_lowercase();
    if is_s3_host(&host) {
        Ok(())
    } else {
        Err(format!("refusing vault S3 request to host {host}"))
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

/// Chat attachments and interactive previews share this byte transport. A
/// caller may request a smaller bound, but never a larger unbounded read.
const MAX_VAULT_GET_BYTES: usize = 25 * 1024 * 1024;

fn bounded_get_limit(requested: Option<usize>) -> usize {
    requested
        .filter(|value| *value > 0)
        .unwrap_or(MAX_VAULT_GET_BYTES)
        .min(MAX_VAULT_GET_BYTES)
}

fn content_length_exceeds(headers: &HeaderMap, limit: usize) -> bool {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|value| value > limit as u64)
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
pub async fn vault_s3_get(
    url: String,
    max_bytes: Option<usize>,
) -> Result<VaultS3GetResult, String> {
    is_allowed_s3_url(&url)?;
    let limit = bounded_get_limit(max_bytes);
    let client = s3_client()?;
    let mut resp = client
        .get(url.trim())
        .send()
        .await
        .map_err(|e| format!("vault S3 GET failed: {e}"))?;
    let status = resp.status().as_u16();
    if content_length_exceeds(resp.headers(), limit) {
        return Err(format!("vault S3 GET exceeds the {limit}-byte read limit"));
    }
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("vault S3 GET read failed: {e}"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(format!("vault S3 GET exceeds the {limit}-byte read limit"));
        }
        body.extend_from_slice(&chunk);
    }
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
    fn vault_get_limit_is_bounded_and_content_length_is_checked_before_reading() {
        assert_eq!(bounded_get_limit(None), MAX_VAULT_GET_BYTES);
        assert_eq!(bounded_get_limit(Some(1024)), 1024);
        assert_eq!(bounded_get_limit(Some(MAX_VAULT_GET_BYTES + 1)), MAX_VAULT_GET_BYTES);

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("1025"));
        assert!(content_length_exceeds(&headers, 1024));
        assert!(!content_length_exceeds(&headers, 1025));
    }

    #[test]
    fn rejects_non_s3_and_non_https() {
        assert!(is_allowed_s3_url("http://bucket.s3.amazonaws.com/key").is_err());
        assert!(is_allowed_s3_url("https://hqapi.getindigo.ai/v1/files").is_err());
        assert!(is_allowed_s3_url("https://evil.example/x").is_err());
        assert!(is_allowed_s3_url("").is_err());
    }

    /// The allowlist must validate the host `reqwest` will actually dial.
    ///
    /// A hand-rolled "everything before the first `/`, then before the first
    /// `:`" parser reads `s3.amazonaws.com` out of
    /// `https://s3.amazonaws.com:443@evil.example/x` and lets it through,
    /// while a standards-compliant parser sees `s3.amazonaws.com:443` as
    /// userinfo and `evil.example` as the host. That gap sent attachment
    /// bytes and the forwarded `x-amz-*` signed headers to an attacker-chosen
    /// origin on both PUT and GET.
    #[test]
    fn rejects_userinfo_that_hides_the_real_host() {
        for url in [
            "https://s3.amazonaws.com:443@evil.example/x",
            "https://s3.amazonaws.com@evil.example/x",
            "https://bucket.s3.amazonaws.com:443@evil.example/chat/a.pdf",
            "https://user:pass@bucket.s3.amazonaws.com/key",
            "https://evil.example#@bucket.s3.amazonaws.com/key",
            "https://evil.example?@bucket.s3.amazonaws.com/key",
        ] {
            assert!(
                is_allowed_s3_url(url).is_err(),
                "must refuse userinfo-obscured host: {url}"
            );
        }
    }

    /// Look-alikes that a substring check would wave through.
    #[test]
    fn rejects_lookalike_hosts() {
        for url in [
            "https://s3.amazonaws.com.evil.example/x",
            "https://bucket.s3.amazonaws.com.evil.example/x",
            "https://not-amazonaws.com/s3.amazonaws.com/x",
            "https://s3.evil.example/x",
        ] {
            assert!(is_allowed_s3_url(url).is_err(), "must refuse look-alike: {url}");
        }
    }

    /// Only the default HTTPS port. A stray port is a different endpoint and
    /// there is no legitimate presigned vault URL that carries one.
    #[test]
    fn rejects_non_default_ports() {
        assert!(is_allowed_s3_url("https://bucket.s3.amazonaws.com:8443/key").is_err());
        assert!(is_allowed_s3_url("https://bucket.s3.amazonaws.com:443/key").is_ok());
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
