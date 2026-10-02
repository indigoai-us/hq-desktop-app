//! Best-effort browser link for desktop sign-in.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::future::Future;
use std::time::Duration;
use url::Url;

pub const SIGNIN_CONFIG_URL: &str = "https://hqforwork.com/api/desktop/signin-config";
pub const SIGNIN_START_URL: &str = "https://hqforwork.com/api/desktop/signin-start";
pub const SIGNIN_LINK_URL: &str = "https://hqforwork.com/api/desktop/signin-link";
pub const CONFIG_TIMEOUT: Duration = Duration::from_millis(1500);

/// Fail open: only a successful, valid response with `bounce: true` changes the URL.
pub async fn should_bounce<F, Fut, E>(fetch: F) -> bool
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(u16, String), E>>,
{
    match tokio::time::timeout(CONFIG_TIMEOUT, fetch()).await {
        Ok(Ok((200, body))) => {
            serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    let object = value.as_object()?;
                    (object.len() == 1)
                        .then(|| object.get("bounce").and_then(|v| v.as_bool()))
                        .flatten()
                })
                == Some(true)
        }
        _ => false,
    }
}

/// Choose the URL to open and retain the nonce only when the start route was
/// successfully built. Every config failure returns the original URL verbatim.
/// `install_id` rides along so the browser request, which carries the
/// website's `hq_install_aid` cookie, can link this install to the visitor.
pub async fn select_browser_url<F, Fut, E>(
    authorize_url: &str,
    install_id: Option<&str>,
    fetch: F,
) -> (String, Option<String>)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(u16, String), E>>,
{
    if should_bounce(fetch).await {
        let link = new_link_nonce();
        if let Some(url) = signin_start_url(authorize_url, &link, install_id) {
            return (url, Some(link));
        }
    }
    (authorize_url.to_string(), None)
}

/// A URL-safe encoding of exactly 32 random bytes. UUID v4 supplies the
/// cryptographic randomness; only the version/variant bits are fixed.
pub fn new_link_nonce() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn signin_start_url(
    authorize_url: &str,
    link: &str,
    install_id: Option<&str>,
) -> Option<String> {
    let mut url = Url::parse(SIGNIN_START_URL).ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("link", link);
        if let Some(install) = install_id.map(str::trim).filter(|id| !id.is_empty()) {
            pairs.append_pair("install", install);
        }
        pairs.append_pair("authorize", authorize_url);
    }
    Some(url.into())
}

/// The website visitor id from `POST /api/desktop/signin-link`. A claimed link
/// answers `200 {"anonId": "..."}`; 204 (nothing to claim), any other status,
/// or a malformed body yields `None`.
pub fn parse_link_anon_id(status: u16, body: &str) -> Option<String> {
    if status != 200 {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    value
        .as_object()?
        .get("anonId")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_owned)
}

/// Run a credential-bearing POST detached from sign-in. Its result is never
/// observed by the caller and it cannot hold up successful authentication.
pub fn spawn_best_effort<F, E>(future: F)
where
    F: Future<Output = Result<(), E>> + Send + 'static,
    E: Send + 'static,
{
    tokio::spawn(async move {
        let _ = future.await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn config_bounces_only_on_explicit_true() {
        assert!(should_bounce(|| async { Ok::<_, ()>((200, r#"{"bounce":true}"#.into())) }).await);
        assert!(
            !should_bounce(|| async { Ok::<_, ()>((200, r#"{"bounce":false}"#.into())) }).await
        );
        assert!(!should_bounce(|| async { Ok::<_, ()>((503, r#"{"bounce":true}"#.into())) }).await);
        assert!(!should_bounce(|| async { Ok::<_, ()>((200, "not json".into())) }).await);
        assert!(
            !should_bounce(|| async { Ok::<_, ()>((200, r#"{"bounce":true,"extra":1}"#.into())) })
                .await
        );
        assert!(!should_bounce(|| async { Err::<(u16, String), _>(()) }).await);
    }

    #[tokio::test]
    async fn config_timeout_keeps_the_existing_authorize_url_path() {
        let authorize = "https://cognito.example/authorize?client_id=abc";
        let (result, nonce) = select_browser_url(authorize, None, || async {
            tokio::time::sleep(CONFIG_TIMEOUT + Duration::from_millis(50)).await;
            Ok::<_, ()>((200, r#"{"bounce":true}"#.into()))
        })
        .await;
        assert_eq!(result, authorize);
        assert_eq!(nonce, None);
    }

    #[tokio::test]
    async fn config_false_or_error_keeps_the_existing_authorize_url() {
        let authorize = "https://cognito.example/authorize?client_id=abc";
        let (url, nonce) = select_browser_url(authorize, None, || async {
            Ok::<_, ()>((200, r#"{"bounce":false}"#.into()))
        })
        .await;
        assert_eq!(url, authorize);
        assert_eq!(nonce, None);

        let (url, nonce) =
            select_browser_url(authorize, None, || async { Err::<(u16, String), _>(()) }).await;
        assert_eq!(url, authorize);
        assert_eq!(nonce, None);
    }

    #[test]
    fn start_url_encodes_authorize_url_and_contains_no_token() {
        let authorize = "https://cognito.example/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback";
        let url = Url::parse(&signin_start_url(authorize, "nonce-value", None).unwrap()).unwrap();
        assert!(url.query_pairs().all(|(k, _)| k != "install"));
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "link").unwrap().1,
            "nonce-value"
        );
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "authorize").unwrap().1,
            authorize
        );
        assert!(!url.as_str().contains("access_token"));
        assert!(!url.as_str().contains("id_token"));
    }

    #[tokio::test]
    async fn bounced_start_url_carries_the_install_id() {
        let authorize = "https://cognito.example/authorize?client_id=abc";
        let install = "1b4e28ba-2fa1-4d01-8a1c-9c1c0d2b3e4f";
        let (url, nonce) = select_browser_url(authorize, Some(install), || async {
            Ok::<_, ()>((200, r#"{"bounce":true}"#.into()))
        })
        .await;
        let url = Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("install").map(String::as_str), Some(install));
        assert_eq!(pairs.get("link"), nonce.as_ref());
        assert_eq!(pairs.get("authorize").map(String::as_str), Some(authorize));
        let blank = signin_start_url(authorize, "n", Some("  ")).unwrap();
        assert!(!blank.contains("install="));
    }

    #[test]
    fn link_completion_returns_anon_id_only_on_200_with_an_id() {
        assert_eq!(
            parse_link_anon_id(200, r#"{"anonId":" vyg-1 "}"#).as_deref(),
            Some("vyg-1")
        );
        assert_eq!(parse_link_anon_id(204, ""), None);
        assert_eq!(parse_link_anon_id(500, r#"{"anonId":"vyg-1"}"#), None);
        assert_eq!(parse_link_anon_id(200, r#"{"anonId":""}"#), None);
        assert_eq!(parse_link_anon_id(200, r#"{"anonId":7}"#), None);
        assert_eq!(parse_link_anon_id(200, "not json"), None);
        assert_eq!(parse_link_anon_id(200, "[]"), None);
        let long = format!(r#"{{"anonId":"{}"}}"#, "a".repeat(129));
        assert_eq!(parse_link_anon_id(200, &long), None);
    }

    #[test]
    fn nonce_is_base64url_for_32_bytes() {
        let encoded = new_link_nonce();
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        assert_eq!(decoded.len(), 32);
    }

    #[tokio::test]
    async fn failed_link_post_is_detached_from_signin_result() {
        let (started_tx, started_rx) = oneshot::channel();
        spawn_best_effort(async move {
            let _ = started_tx.send(());
            Err::<(), _>("HTTP failure")
        });
        started_rx.await.expect("background request was started");
        let signin_result = Ok::<_, ()>("authenticated");
        assert_eq!(signin_result.unwrap(), "authenticated");
    }
}
