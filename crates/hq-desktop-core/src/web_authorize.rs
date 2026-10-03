//! HQ Desktop web authorize page.
//!
//! When the public hq-flags key `desktop.web-authorize` is on, sign-in opens
//! `https://hqforwork.com/authorize/desktop` with the desktop client's OAuth
//! query (state, nonce, PKCE, loopback redirect). The page never sees tokens.
//! When the flag is off or unreadable, callers must keep today's provider
//! buttons and continuation experiment.

use std::future::Future;
use std::time::Duration;
use url::Url;

pub const FLAG_KEY: &str = "desktop.web-authorize";
pub const FLAG_RESOLVE_URL: &str = "https://hqapi.hq.computer/v1/flags/resolve-public";
pub const AUTHORIZE_PAGE_URL: &str = "https://hqforwork.com/authorize/desktop";
pub const CONFIG_TIMEOUT: Duration = Duration::from_millis(1500);
pub const DESKTOP_COGNITO_CLIENT_ID: &str = crate::oauth::COGNITO_CLIENT_ID;
pub const ALLOWED_LOOPBACK_PORTS: [u16; 3] = [53682, 8765, 3000];

const DEFAULT_SCOPE: &str = "openid email profile";

/// `~/.hq/menubar.json` boolean. Lets one tester turn the path on without a
/// public-flag visitor allowlist. The install UUID lives in the same file as
/// `installAttemptId` (not shown in About). There is no env-var gate.
pub const MENUBAR_OVERRIDE_KEY: &str = "webAuthorize";

pub fn menubar_override(contents: Option<&str>) -> Option<bool> {
    contents
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .and_then(|value| value.get(MENUBAR_OVERRIDE_KEY)?.as_bool())
}

pub fn read_local_override() -> Option<bool> {
    crate::paths::hq_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("menubar.json")).ok())
        .as_deref()
        .and_then(|contents| menubar_override(Some(contents)))
}

/// Parse hq-pro's public flag resolver. Only HTTP 200 with `enabled: true` is on.
pub fn parse_flag(status: u16, body: &str) -> bool {
    if status != 200 {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("enabled")?.as_bool())
        == Some(true)
}

pub fn flag_resolve_url(base: &str, install_id: &str) -> String {
    let mut url = Url::parse(base).unwrap_or_else(|_| {
        Url::parse(FLAG_RESOLVE_URL).expect("constant flag resolve URL parses")
    });
    url.query_pairs_mut()
        .append_pair("key", FLAG_KEY)
        .append_pair("visitorId", install_id);
    url.into()
}

/// Fail closed: only an explicit enabled true inside the timeout turns the path on.
pub async fn resolve_enabled<F, Fut, E>(install_id: Option<&str>, fetch: F) -> bool
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<(u16, String), E>>,
{
    resolve_with_local(install_id, read_local_override(), fetch).await
}

pub async fn resolve_with_local<F, Fut, E>(
    install_id: Option<&str>,
    local: Option<bool>,
    fetch: F,
) -> bool
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<(u16, String), E>>,
{
    if let Some(value) = local {
        return value;
    }
    let Some(id) = install_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let url = flag_resolve_url(FLAG_RESOLVE_URL, id);
    match tokio::time::timeout(CONFIG_TIMEOUT, fetch(url)).await {
        Ok(Ok((status, body))) => parse_flag(status, &body),
        _ => false,
    }
}

pub fn is_allowed_loopback_redirect(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    if url.host_str() != Some("localhost") {
        return false;
    }
    if url.path() != "/callback" {
        return false;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    url.port()
        .is_some_and(|port| ALLOWED_LOOPBACK_PORTS.contains(&port))
}

/// Rewrite a Cognito authorize URL into the website authorize page, keeping
/// the desktop client's query. Returns None when the Cognito URL is not the
/// expected Hosted UI shape, so the caller can keep today's flow.
pub fn build_authorize_page_url(cognito_authorize_url: &str) -> Option<String> {
    let source = Url::parse(cognito_authorize_url).ok()?;
    if source.scheme() != "https" {
        return None;
    }
    if source.path() != "/oauth2/authorize" {
        return None;
    }
    let host = source.host_str()?;
    if !host.ends_with(".amazoncognito.com") {
        return None;
    }
    let client_id = source.query_pairs().find(|(k, _)| k == "client_id")?.1;
    if client_id.trim().is_empty() {
        return None;
    }
    let redirect = source
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")?
        .1
        .into_owned();
    if !is_allowed_loopback_redirect(&redirect) {
        return None;
    }
    let mut page = Url::parse(AUTHORIZE_PAGE_URL).ok()?;
    {
        let mut pairs = page.query_pairs_mut();
        for (key, value) in source.query_pairs() {
            match key.as_ref() {
                "client_id" | "redirect_uri" | "response_type" | "scope" | "state"
                | "code_challenge" | "code_challenge_method" | "nonce" | "identity_provider" => {
                    pairs.append_pair(&key, &value);
                }
                _ => {}
            }
        }
    }
    if page
        .query_pairs()
        .find(|(k, _)| k == "scope")
        .is_none()
    {
        page.query_pairs_mut().append_pair("scope", DEFAULT_SCOPE);
    }
    Some(page.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::{
        build_authorize_url_from_redirect, compute_code_challenge, generate_code_verifier,
        AuthorizeRequest, COGNITO_CLIENT_ID,
    };

    fn sample_cognito_url() -> String {
        let verifier = generate_code_verifier();
        let challenge = compute_code_challenge(&verifier);
        build_authorize_url_from_redirect(
            &AuthorizeRequest {
                state: "state-token-1",
                challenge: &challenge,
                identity_provider: None,
                nonce: Some("nonce-token-1"),
            },
            "http://localhost:53682/callback",
        )
    }

    #[test]
    fn flag_parsing_only_accepts_200_enabled_true() {
        assert!(parse_flag(200, r#"{"key":"desktop.web-authorize","enabled":true}"#));
        assert!(!parse_flag(200, r#"{"enabled":false}"#));
        assert!(!parse_flag(200, r#"{"enabled":"true"}"#));
        assert!(!parse_flag(404, r#"{"enabled":true}"#));
        assert!(!parse_flag(500, "nope"));
    }

    #[test]
    fn flag_url_carries_key_and_visitor() {
        let url = flag_resolve_url(FLAG_RESOLVE_URL, "11111111-1111-4111-8111-111111111111");
        assert!(url.contains("key=desktop.web-authorize"));
        assert!(url.contains("visitorId=11111111-1111-4111-8111-111111111111"));
    }

    #[tokio::test]
    async fn resolve_enabled_fails_closed() {
        assert!(
            !resolve_with_local(None, None, |_url| async {
                Ok::<_, ()>((200, r#"{"enabled":true}"#.into()))
            })
            .await
        );
        assert!(
            !resolve_with_local(Some("install"), None, |_url| async {
                Ok::<_, ()>((500, r#"{"enabled":true}"#.into()))
            })
            .await
        );
        assert!(
            resolve_with_local(Some("install"), None, |_url| async {
                Ok::<_, ()>((200, r#"{"enabled":true}"#.into()))
            })
            .await
        );
    }

    #[test]
    fn menubar_web_authorize_override() {
        assert_eq!(
            menubar_override(Some(
                r#"{"installAttemptId":"11111111-1111-4111-8111-111111111111","webAuthorize":true}"#
            )),
            Some(true)
        );
        assert_eq!(
            menubar_override(Some(r#"{"webAuthorize":false}"#)),
            Some(false)
        );
        assert_eq!(menubar_override(Some(r#"{"installAttemptId":"x"}"#)), None);
    }

    #[tokio::test]
    async fn local_true_skips_public_resolve() {
        assert!(
            resolve_with_local(None, Some(true), |_url| async {
                panic!("must not fetch");
                #[allow(unreachable_code)]
                Ok::<_, ()>((200, r#"{"enabled":false}"#.into()))
            })
            .await
        );
    }

    #[test]
    fn loopback_allowlist_matches_registered_desktop_callbacks() {
        assert!(is_allowed_loopback_redirect("http://localhost:53682/callback"));
        assert!(is_allowed_loopback_redirect("http://localhost:8765/callback"));
        assert!(is_allowed_loopback_redirect("http://localhost:3000/callback"));
        assert!(!is_allowed_loopback_redirect("http://127.0.0.1:53682/callback"));
        assert!(!is_allowed_loopback_redirect("https://localhost:53682/callback"));
        assert!(!is_allowed_loopback_redirect("http://evil.example/callback"));
    }

    #[test]
    fn page_url_preserves_desktop_oauth_query() {
        let cognito = sample_cognito_url();
        let page = build_authorize_page_url(&cognito).expect("page url");
        let url = Url::parse(&page).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://hqforwork.com");
        assert_eq!(url.path(), "/authorize/desktop");
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "client_id")
                .map(|(_, v)| v.into_owned())
                .as_deref(),
            Some(COGNITO_CLIENT_ID)
        );
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "redirect_uri")
                .map(|(_, v)| v.into_owned())
                .as_deref(),
            Some("http://localhost:53682/callback")
        );
        assert!(url.query_pairs().any(|(k, _)| k == "code_challenge"));
        assert!(url.query_pairs().any(|(k, _)| k == "state"));
        assert!(url.query_pairs().any(|(k, _)| k == "nonce"));
        assert!(!page.contains("/oauth2/authorize"));
    }

    #[test]
    fn page_url_rejects_foreign_authorize_hosts() {
        assert!(build_authorize_page_url("https://evil.example/oauth2/authorize?client_id=7acei2c8v870enheptb1j5foln&redirect_uri=http://localhost:53682/callback").is_none());
        assert!(build_authorize_page_url("https://example.com/login").is_none());
    }
}
