//! Lazy OG-image preview for one deployed app (Deployments side panel).
//!
//! The page asks for a preview only when a row is selected. The first call
//! reads the deployed page, finds its `og:image` (or `twitter:image`), downloads
//! that image and stores both under `<app data>/deploy-previews/`. Later calls
//! for the same app and deploy time return the stored copy without a network
//! read. A redeploy changes `deployedAt`, which changes the cache key, and the
//! write for the new key removes the app's older entries.
//!
//! No credentials are sent: the page and image are read anonymously, so a
//! password, company, or invite-only app returns its gate page, which has no
//! og:image, and the panel shows no preview for it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const MAX_PAGE_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployPreview {
    /// Absolute og:image URL the page declared, or None when it has none.
    pub og_image_url: Option<String>,
    /// Downloaded image as a `data:` URL, or None when there is no image.
    pub thumbnail: Option<String>,
    pub fetched_at: String,
}

/// Cache file stem: one hash for the app (so older deploys of the same app
/// can be found and removed) and one for the deploy time.
pub fn cache_stem(app_id: &str, deployed_at: &str) -> (String, String) {
    let app = hex16(app_id);
    (app.clone(), format!("{app}-{}", hex16(deployed_at)))
}

fn hex16(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Only https URLs are fetched.
pub fn validate_page_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "preview: unreadable url".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("preview: only https pages are previewed".to_string());
    }
    Ok(parsed)
}

/// Find the page's preview image: `og:image` (or `og:image:url` /
/// `og:image:secure_url`) first, then `twitter:image`. Relative values resolve
/// against the page URL; non-http(s) results are ignored.
pub fn parse_og_image(html: &str, page: &url::Url) -> Option<String> {
    let mut og: Option<String> = None;
    let mut twitter: Option<String> = None;
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<meta") {
        let start = from + start;
        let end = match lower[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        let tag = &html[start..end];
        from = end;
        let key = attr(tag, "property").or_else(|| attr(tag, "name"));
        let Some(key) = key.map(|k| k.to_ascii_lowercase()) else {
            continue;
        };
        let Some(content) = attr(tag, "content") else {
            continue;
        };
        let content = decode_entities(content.trim());
        if content.is_empty() {
            continue;
        }
        if og.is_none()
            && matches!(
                key.as_str(),
                "og:image" | "og:image:url" | "og:image:secure_url"
            )
        {
            og = Some(content);
        } else if twitter.is_none() && matches!(key.as_str(), "twitter:image" | "twitter:image:src")
        {
            twitter = Some(content);
        }
    }
    [og, twitter].into_iter().flatten().find_map(|value| {
        let resolved = page.join(&value).ok()?;
        matches!(resolved.scheme(), "https" | "http").then(|| resolved.to_string())
    })
}

/// Read one attribute value from a raw tag (quoted or bare).
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut search = 0;
    while let Some(pos) = lower[search..].find(name) {
        let pos = search + pos;
        search = pos + name.len();
        let before_ok = pos == 0 || bytes[pos - 1].is_ascii_whitespace();
        let mut i = pos + name.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if !before_ok || i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' {
            let rest = &tag[i + 1..];
            return rest.find(quote as char).map(|e| rest[..e].to_string());
        }
        let rest = &tag[i..];
        let e = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '/')
            .unwrap_or(rest.len());
        return Some(rest[..e].to_string());
    }
    None
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Turn a page response into the og:image URL. A non-success status or a
/// non-HTML body is an error the panel shows as "Preview unavailable".
pub fn og_from_page_response(
    status: u16,
    content_type: &str,
    body: &[u8],
    page: &url::Url,
) -> Result<Option<String>, String> {
    if !(200..300).contains(&status) {
        return Err(format!("preview: page HTTP {status}"));
    }
    let ct = content_type.to_ascii_lowercase();
    if !ct.is_empty() && !ct.contains("html") {
        return Ok(None);
    }
    let body = &body[..body.len().min(MAX_PAGE_BYTES)];
    Ok(parse_og_image(&String::from_utf8_lossy(body), page))
}

/// Turn an image response into a `data:` URL. Non-image or oversized bodies
/// yield None (no preview) rather than an error.
pub fn thumbnail_from_image_response(
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<Option<String>, String> {
    if !(200..300).contains(&status) {
        return Err(format!("preview: image HTTP {status}"));
    }
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !ct.starts_with("image/")
        || ct == "image/svg+xml"
        || body.is_empty()
        || body.len() > MAX_IMAGE_BYTES
    {
        return Ok(None);
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(body);
    Ok(Some(format!("data:{ct};base64,{encoded}")))
}

pub fn read_cached(dir: &Path, stem: &str) -> Option<DeployPreview> {
    let text = std::fs::read_to_string(dir.join(format!("{stem}.json"))).ok()?;
    match serde_json::from_str(&text) {
        Ok(preview) => Some(preview),
        Err(err) => {
            eprintln!("[deploy-preview] dropping unreadable cache entry: {err}");
            None
        }
    }
}

/// Store a preview and remove this app's entries for older deploys.
pub fn write_cached(
    dir: &Path,
    app_hash: &str,
    stem: &str,
    preview: &DeployPreview,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("preview cache dir: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{app_hash}-")) && !name.starts_with(stem) {
                if let Err(err) = std::fs::remove_file(entry.path()) {
                    eprintln!("[deploy-preview] stale entry not removed: {err}");
                }
            }
        }
    }
    let text = serde_json::to_string(preview).map_err(|e| format!("preview encode: {e}"))?;
    std::fs::write(dir.join(format!("{stem}.json")), text)
        .map_err(|e| format!("preview cache write: {e}"))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("deploy-previews"))
        .map_err(|e| format!("preview cache dir: {e}"))
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
) -> Result<(u16, String, Vec<u8>), String> {
    let res = client
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("preview fetch: {e}"))?;
    let status = res.status().as_u16();
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("preview read: {e}"))?;
    Ok((status, ct, bytes[..bytes.len().min(limit + 1)].to_vec()))
}

/// Read (or build and store) the preview for one deployed app.
pub async fn load_preview(
    dir: &Path,
    app_id: &str,
    page_url: &str,
    deployed_at: &str,
    refresh: bool,
) -> Result<DeployPreview, String> {
    let page = validate_page_url(page_url)?;
    let (app_hash, stem) = cache_stem(app_id, deployed_at);
    if !refresh {
        if let Some(hit) = read_cached(dir, &stem) {
            return Ok(hit);
        }
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("preview client: {e}"))?;
    let (status, ct, body) = fetch(&client, page.as_str(), MAX_PAGE_BYTES).await?;
    let og = og_from_page_response(status, &ct, &body, &page)?;
    let thumbnail = match &og {
        Some(image) => {
            let (status, ct, body) = fetch(&client, image, MAX_IMAGE_BYTES).await?;
            thumbnail_from_image_response(status, &ct, &body)?
        }
        None => None,
    };
    let preview = DeployPreview {
        og_image_url: og,
        thumbnail,
        fetched_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Err(err) = write_cached(dir, &app_hash, &stem, &preview) {
        eprintln!("[deploy-preview] {err}");
    }
    Ok(preview)
}

#[tauri::command]
pub async fn deploy_app_preview(
    app: AppHandle,
    app_id: String,
    url: String,
    deployed_at: String,
    refresh: Option<bool>,
) -> Result<DeployPreview, String> {
    let dir = cache_dir(&app)?;
    let result = load_preview(&dir, &app_id, &url, &deployed_at, refresh.unwrap_or(false)).await;
    if let Err(err) = &result {
        eprintln!("[deploy-preview] {app_id}: {err}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> url::Url {
        url::Url::parse("https://demo.indigo-hq.com/docs/index.html").unwrap()
    }

    #[test]
    fn parses_og_image_before_twitter_image() {
        let html = r#"<head><meta name="twitter:image" content="https://cdn.example.com/t.png"><meta property="og:image" content="https://cdn.example.com/og.png"></head>"#;
        assert_eq!(
            parse_og_image(html, &page()).as_deref(),
            Some("https://cdn.example.com/og.png")
        );
    }

    #[test]
    fn falls_back_to_twitter_image_and_resolves_relative_urls() {
        let html = r#"<META NAME='twitter:image' CONTENT='../img/card.png?a=1&amp;b=2'>"#;
        assert_eq!(
            parse_og_image(html, &page()).as_deref(),
            Some("https://demo.indigo-hq.com/img/card.png?a=1&b=2")
        );
        let root = r#"<meta content="/og.jpg" property="og:image" />"#;
        assert_eq!(
            parse_og_image(root, &page()).as_deref(),
            Some("https://demo.indigo-hq.com/og.jpg")
        );
    }

    #[test]
    fn no_image_or_unsafe_scheme_is_none() {
        assert_eq!(
            parse_og_image(
                "<title>x</title><meta name=description content=hi>",
                &page()
            ),
            None
        );
        assert_eq!(
            parse_og_image(
                r#"<meta property="og:image" content="javascript:alert(1)">"#,
                &page()
            ),
            None
        );
        assert_eq!(
            parse_og_image(r#"<meta property="og:image" content="">"#, &page()),
            None
        );
    }

    #[test]
    fn page_response_handling() {
        let html = br#"<meta property="og:image" content="/og.png">"#;
        assert_eq!(
            og_from_page_response(200, "text/html; charset=utf-8", html, &page())
                .unwrap()
                .as_deref(),
            Some("https://demo.indigo-hq.com/og.png")
        );
        assert_eq!(
            og_from_page_response(200, "application/json", html, &page()).unwrap(),
            None
        );
        assert!(og_from_page_response(502, "text/html", html, &page()).is_err());
    }

    #[test]
    fn image_response_handling() {
        let png = [0x89, b'P', b'N', b'G'];
        let data = thumbnail_from_image_response(200, "image/png", &png)
            .unwrap()
            .unwrap();
        assert!(data.starts_with("data:image/png;base64,"));
        assert_eq!(
            thumbnail_from_image_response(200, "text/html", &png).unwrap(),
            None
        );
        assert_eq!(
            thumbnail_from_image_response(200, "image/svg+xml", b"<svg/>").unwrap(),
            None
        );
        assert!(thumbnail_from_image_response(404, "image/png", &png).is_err());
    }

    #[test]
    fn rejects_non_https_pages() {
        assert!(validate_page_url("http://demo.indigo-hq.com").is_err());
        assert!(validate_page_url("file:///etc/hosts").is_err());
        assert!(validate_page_url("https://demo.indigo-hq.com").is_ok());
    }

    #[test]
    fn cache_key_changes_with_deploy_and_redeploy_removes_old_entry() {
        let dir = tempfile::tempdir().unwrap();
        let (app_hash, first) = cache_stem("personal:demo", "2026-10-01T00:00:00Z");
        let (same_app, second) = cache_stem("personal:demo", "2026-10-05T00:00:00Z");
        assert_eq!(app_hash, same_app);
        assert_ne!(first, second);
        let preview = DeployPreview {
            og_image_url: None,
            thumbnail: None,
            fetched_at: "t".into(),
        };
        write_cached(dir.path(), &app_hash, &first, &preview).unwrap();
        assert_eq!(read_cached(dir.path(), &first), Some(preview.clone()));
        write_cached(dir.path(), &app_hash, &second, &preview).unwrap();
        assert_eq!(read_cached(dir.path(), &first), None);
        assert!(read_cached(dir.path(), &second).is_some());
    }

    #[tokio::test]
    async fn cached_preview_is_returned_without_a_network_read() {
        let dir = tempfile::tempdir().unwrap();
        let (app_hash, stem) = cache_stem("acme:site", "d1");
        let stored = DeployPreview {
            og_image_url: Some("https://x/og.png".into()),
            thumbnail: None,
            fetched_at: "t".into(),
        };
        write_cached(dir.path(), &app_hash, &stem, &stored).unwrap();
        // The host does not resolve; a network read would fail.
        let got = load_preview(
            dir.path(),
            "acme:site",
            "https://unreachable.invalid/",
            "d1",
            false,
        )
        .await
        .unwrap();
        assert_eq!(got, stored);
        assert!(load_preview(
            dir.path(),
            "acme:site",
            "https://unreachable.invalid/",
            "d1",
            true
        )
        .await
        .is_err());
    }
}
