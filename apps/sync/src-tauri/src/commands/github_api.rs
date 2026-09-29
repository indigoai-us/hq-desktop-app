use std::{
    collections::HashMap,
    sync::{Arc, OnceLock, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{
    header::{HeaderMap, HeaderValue, IF_NONE_MATCH},
    Client, StatusCode,
};
use tokio::sync::Mutex;

const GITHUB_API_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const ANONYMOUS_GITHUB_API_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const IMMUTABLE_TREE_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CACHED_RESPONSES: usize = 256;

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub(crate) enum ApiScope {
    Anonymous,
    Authenticated,
}

#[derive(Debug)]
pub(crate) struct ApiResponse {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl ApiResponse {
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }
}

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) class: &'static str,
    pub(crate) transport_error: Option<reqwest::Error>,
    detail: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

pub(crate) struct GithubApiCache {
    reuse_for: Duration,
    responses: Mutex<HashMap<String, CachedResponse>>,
    in_flight: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    rate_limit_reset_at: Mutex<HashMap<ApiScope, u64>>,
}

#[derive(Clone)]
struct CachedResponse {
    body: Vec<u8>,
    etag: Option<HeaderValue>,
    headers: HeaderMap,
    fetched_at: Instant,
}

impl GithubApiCache {
    fn new(reuse_for: Duration) -> Self {
        Self {
            reuse_for,
            responses: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            rate_limit_reset_at: Mutex::new(HashMap::new()),
        }
    }

    async fn get(
        &self,
        client: &Client,
        url: &str,
        scope: ApiScope,
    ) -> Result<ApiResponse, ApiError> {
        let key = format!("{scope:?}:{url}");
        let request_lock = {
            let mut locks = self.in_flight.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            locks.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(key.clone(), Arc::downgrade(&lock));
                lock
            })
        };
        let _request_guard = request_lock.lock().await;

        let ttl = self.cache_ttl(url, scope);
        let cached = self.responses.lock().await.get(&key).cloned();
        if let Some(cached) = cached.as_ref() {
            if cached.fetched_at.elapsed() < ttl {
                return Ok(ApiResponse {
                    status: StatusCode::OK,
                    headers: cached.headers.clone(),
                    body: cached.body.clone(),
                });
            }
        }

        let reset_at = self.rate_limit_reset_at.lock().await.get(&scope).copied();
        if let Some(reset_at) = reset_at {
            let now = unix_now();
            if reset_at > now {
                return Err(ApiError {
                    class: "rate_limited",
                    transport_error: None,
                    detail: format!("GitHub API rate limited until epoch {reset_at}"),
                });
            }
            self.rate_limit_reset_at.lock().await.remove(&scope);
        }

        let mut request = client.get(url);
        if let Some(etag) = cached.as_ref().and_then(|entry| entry.etag.clone()) {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let response = request.send().await.map_err(|error| {
            let class = body_error_class(error.is_timeout(), error.is_connect(), error.is_decode());
            let detail = format!("GET {url}: {error}");
            ApiError {
                class,
                detail,
                transport_error: Some(error),
            }
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        if response_is_rate_limited(status, &headers) {
            let reset_at = rate_limit_reset_epoch(&headers).unwrap_or_else(|| unix_now() + 60);
            let mut resets = self.rate_limit_reset_at.lock().await;
            resets
                .entry(scope)
                .and_modify(|known| *known = (*known).max(reset_at))
                .or_insert(reset_at);
        }

        if status == StatusCode::NOT_MODIFIED {
            let Some(mut cached) = cached else {
                return Err(ApiError {
                    class: "invalid_response",
                    transport_error: None,
                    detail: format!("GitHub returned 304 without a cached body for {url}"),
                });
            };
            if let Some(etag) = headers.get(reqwest::header::ETAG).cloned() {
                cached.etag = Some(etag);
            }
            cached.fetched_at = Instant::now();
            cached.headers = headers.clone();
            self.responses.lock().await.insert(key, cached.clone());
            return Ok(ApiResponse {
                status: StatusCode::OK,
                headers,
                body: cached.body,
            });
        }

        let body = response.bytes().await.map_err(|error| {
            let class = body_error_class(error.is_timeout(), error.is_connect(), error.is_decode());
            let detail = format!("read {url} response body: {error}");
            ApiError {
                class,
                detail,
                transport_error: Some(error),
            }
        })?;
        let body = body.to_vec();
        if status.is_success() {
            let etag = headers.get(reqwest::header::ETAG).cloned();
            let mut responses = self.responses.lock().await;
            if responses.len() >= MAX_CACHED_RESPONSES && !responses.contains_key(&key) {
                if let Some(oldest) = responses
                    .iter()
                    .min_by_key(|(_, entry)| entry.fetched_at)
                    .map(|(key, _)| key.clone())
                {
                    responses.remove(&oldest);
                }
            }
            responses.insert(
                key,
                CachedResponse {
                    body: body.clone(),
                    etag,
                    headers: headers.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }
        Ok(ApiResponse {
            status,
            headers,
            body,
        })
    }

    fn cache_ttl(&self, url: &str, scope: ApiScope) -> Duration {
        if is_immutable_tree_url(url) {
            IMMUTABLE_TREE_CACHE_TTL
        } else if scope == ApiScope::Anonymous {
            self.reuse_for.max(ANONYMOUS_GITHUB_API_CACHE_TTL)
        } else {
            self.reuse_for
        }
    }
}

pub(crate) fn body_error_class(
    is_timeout: bool,
    is_connect: bool,
    is_decode: bool,
) -> &'static str {
    if is_timeout {
        "timeout"
    } else if is_connect {
        "connection"
    } else if is_decode {
        "invalid_response"
    } else {
        "transport_other"
    }
}

fn response_is_rate_limited(status: StatusCode, headers: &HeaderMap) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && (headers
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                == Some("0")
                || headers.contains_key("retry-after")))
}

fn rate_limit_reset_epoch(headers: &HeaderMap) -> Option<u64> {
    if let Some(reset) = headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Some(reset);
    }
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| unix_now().saturating_add(seconds))
}

fn is_immutable_tree_url(url: &str) -> bool {
    let Some((_, reference)) = url.split_once("/git/trees/") else {
        return false;
    };
    let reference = reference.split(['?', '#']).next().unwrap_or_default();
    reference.len() == 40 && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

static GITHUB_API_CACHE: OnceLock<GithubApiCache> = OnceLock::new();

pub(crate) async fn get(
    client: &Client,
    url: &str,
    scope: ApiScope,
) -> Result<ApiResponse, ApiError> {
    GITHUB_API_CACHE
        .get_or_init(|| GithubApiCache::new(GITHUB_API_CACHE_TTL))
        .get(client, url, scope)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn accept_request(listener: &TcpListener, response: &'static [u8]) -> String {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        let mut request = vec![0; 2048];
        let read = stream.read(&mut request).await.expect("read request");
        stream.write_all(response).await.expect("write response");
        String::from_utf8_lossy(&request[..read]).to_string()
    }

    async fn accept_unexpected_request(listener: &TcpListener) -> bool {
        let accepted = tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
        let Ok(Ok((mut stream, _))) = accepted else {
            return false;
        };
        let mut request = [0; 2048];
        let _ = stream
            .read(&mut request)
            .await
            .expect("read unexpected request");
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            .await
            .expect("respond to unexpected request");
        true
    }

    #[test]
    fn body_read_timeout_retains_timeout_class() {
        assert_eq!(body_error_class(true, false, false), "timeout");
    }

    #[test]
    fn body_read_connection_retains_connection_class() {
        assert_eq!(body_error_class(false, true, false), "connection");
    }

    #[test]
    fn actual_decode_failures_remain_invalid_response() {
        assert_eq!(body_error_class(false, false, true), "invalid_response");
    }

    #[test]
    fn other_body_read_failures_remain_transport_other() {
        assert_eq!(body_error_class(false, false, false), "transport_other");
    }

    #[tokio::test]
    async fn repeated_gets_are_deduplicated_within_the_reuse_window() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
        let server = tokio::spawn(async move {
            let first = accept_request(&listener, response).await;
            (first, accept_unexpected_request(&listener).await)
        });
        let cache = GithubApiCache::new(Duration::from_secs(60));
        let client = Client::new();
        let url = format!("http://{address}/repos/example/repo/releases/latest");

        let first = cache.get(&client, &url, ApiScope::Anonymous).await.unwrap();
        let second = cache.get(&client, &url, ApiScope::Anonymous).await.unwrap();
        let (_, accepted_second) = server.await.expect("server task");

        assert_eq!(first.body, b"ok");
        assert_eq!(second.body, b"ok");
        assert!(
            !accepted_second,
            "the second read must use the per-check cache"
        );
    }

    #[tokio::test]
    async fn stale_etag_uses_if_none_match_and_reuses_the_cached_body_on_304() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let first = accept_request(
                &listener,
                b"HTTP/1.1 200 OK\r\nETag: \"tree-v1\"\r\nContent-Length: 8\r\n\r\n{\"ok\":1}",
            )
            .await;
            let second = accept_request(
                &listener,
                b"HTTP/1.1 304 Not Modified\r\nETag: \"tree-v1\"\r\nContent-Length: 0\r\n\r\n",
            )
            .await;
            (first, second)
        });
        let cache = GithubApiCache::new(Duration::ZERO);
        let client = Client::new();
        let url = format!("http://{address}/repos/example/repo/git/trees/main?recursive=1");

        let first = cache
            .get(&client, &url, ApiScope::Authenticated)
            .await
            .unwrap();
        let second = cache
            .get(&client, &url, ApiScope::Authenticated)
            .await
            .unwrap();
        let (_, second_request) = server.await.expect("server task");

        assert_eq!(first.body, br#"{"ok":1}"#);
        assert_eq!(second.body, first.body);
        assert!(second_request
            .to_ascii_lowercase()
            .contains("if-none-match: \"tree-v1\""));
    }

    #[tokio::test]
    async fn rate_limited_gets_back_off_until_the_reset_header() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            accept_request(
                &listener,
                b"HTTP/1.1 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 4102444800\r\nContent-Length: 0\r\n\r\n",
            ).await;
            accept_unexpected_request(&listener).await
        });
        let cache = GithubApiCache::new(Duration::ZERO);
        let client = Client::new();
        let url = format!("http://{address}/repos/example/repo/git/trees/main?recursive=1");

        let _first = cache.get(&client, &url, ApiScope::Anonymous).await.unwrap();
        let second = cache.get(&client, &url, ApiScope::Anonymous).await;
        let accepted_second = server.await.expect("server task");

        assert_eq!(second.unwrap_err().class, "rate_limited");
        assert!(
            !accepted_second,
            "a retry before x-ratelimit-reset must not reach GitHub"
        );
    }
}
