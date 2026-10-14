//! Page titles for links shown in chat messages.
//!
//! The webview never fetches arbitrary sites itself. It asks this command for
//! a title; we fetch with a fresh client that has no cookie store and sends no
//! auth headers, refuse private/loopback hosts (including after redirects),
//! read at most `MAX_BYTES`, and give up after `FETCH_TIMEOUT`. Results (hits
//! and misses) are cached in memory for the life of the process.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_CACHE_ENTRIES: usize = 2000;

static CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// True when the URL is http(s) on a host we are willing to contact.
pub fn is_fetchable(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            !(d == "localhost"
                || d.ends_with(".localhost")
                || d.ends_with(".local")
                || d.ends_with(".internal")
                || !d.contains('.'))
        }
        Some(url::Host::Ipv4(ip)) => is_public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_public_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00
                || (seg0 & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| !is_public_ip(IpAddr::V4(v4))))
        }
    }
}

fn decode_entities(s: &str) -> String {
    let mut out = s
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&ndash;", "\u{2013}")
        .replace("&mdash;", "\u{2014}")
        .replace("&middot;", "\u{00b7}");
    out = out.replace("&amp;", "&");
    out
}

fn clean(raw: &str) -> Option<String> {
    let collapsed = decode_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TITLE_CHARS).collect())
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let mut from = 0;
    while let Some(pos) = lower[from..].find(&needle) {
        let start = from + pos;
        let boundary = start == 0
            || lower.as_bytes()[start - 1].is_ascii_whitespace();
        let value_start = start + needle.len();
        from = value_start;
        if !boundary {
            continue;
        }
        let rest = &tag[value_start..];
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            let end = rest[1..].find(quote)?;
            return Some(&rest[1..1 + end]);
        }
        let end = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '>')
            .unwrap_or(rest.len());
        return Some(&rest[..end]);
    }
    None
}

/// Prefer og:title / twitter:title, then `<title>`.
pub fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut twitter: Option<String> = None;
    while let Some(pos) = lower[cursor..].find("<meta") {
        let start = cursor + pos;
        let end = match lower[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        let tag = &html[start..=end];
        let key = attr(tag, "property")
            .or_else(|| attr(tag, "name"))
            .map(|k| k.to_ascii_lowercase());
        if let (Some(key), Some(content)) = (key, attr(tag, "content")) {
            if key == "og:title" {
                if let Some(t) = clean(content) {
                    return Some(t);
                }
            } else if key == "twitter:title" && twitter.is_none() {
                twitter = clean(content);
            }
        }
        cursor = end + 1;
    }
    if twitter.is_some() {
        return twitter;
    }
    let open = lower.find("<title")?;
    let body_start = open + lower[open..].find('>')? + 1;
    let body_end = body_start + lower[body_start..].find("</title")?;
    clean(&html[body_start..body_end])
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_fetchable(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .timeout(FETCH_TIMEOUT)
        .user_agent("Mozilla/5.0 (Macintosh) HQ link preview")
        .build()
        .map_err(|e| format!("link title client: {e}"))
}

async fn fetch_title(url: &url::Url) -> Result<Option<String>, String> {
    let mut res = client()?
        .get(url.as_str())
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| format!("link title fetch: {e}"))?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let html_like = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("html"))
        .unwrap_or(true);
    if !html_like {
        return Ok(None);
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("link title read: {e}"))?
    {
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_BYTES {
            buf.truncate(MAX_BYTES);
            break;
        }
    }
    Ok(extract_title(&String::from_utf8_lossy(&buf)))
}

/// Resolve a page title for a chat link. `Ok(None)` means "no title"; the UI
/// keeps its locally derived label.
#[tauri::command]
pub async fn link_page_title(url: String) -> Result<Option<String>, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "invalid url".to_string())?;
    if !is_fetchable(&parsed) {
        return Ok(None);
    }
    let key = parsed.as_str().to_string();
    if let Some(hit) = CACHE.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let title = fetch_title(&parsed).await.unwrap_or(None);
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(key, title.clone());
    }
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn refuses_private_and_local_hosts() {
        assert!(is_fetchable(&u("https://example.com/a")));
        assert!(!is_fetchable(&u("http://localhost:3000")));
        assert!(!is_fetchable(&u("http://127.0.0.1/")));
        assert!(!is_fetchable(&u("http://10.0.0.5/")));
        assert!(!is_fetchable(&u("http://192.168.1.1/")));
        assert!(!is_fetchable(&u("http://169.254.169.254/latest")));
        assert!(!is_fetchable(&u("http://[::1]/")));
        assert!(!is_fetchable(&u("http://printer.local/")));
        assert!(!is_fetchable(&u("http://intranet/")));
        assert!(!is_fetchable(&u("https://user:pw@example.com/")));
        assert!(!is_fetchable(&u("file:///etc/passwd")));
    }

    #[test]
    fn prefers_og_title_then_title_tag() {
        let html = r#"<html><head><title>Plain</title>
            <meta property="og:title" content="Rich &amp; Clear"></head></html>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Rich & Clear"));
        let html = "<html><head><TITLE>\n  Hello   World \n</TITLE></head>";
        assert_eq!(extract_title(html).as_deref(), Some("Hello World"));
        assert_eq!(extract_title("<html><body>none</body></html>"), None);
    }

    #[test]
    fn reads_twitter_title_when_no_og() {
        let html = r#"<meta name='twitter:title' content='Tweet title'><title>T</title>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Tweet title"));
    }
}
