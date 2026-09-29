use std::time::Duration;

use reqwest::{header::HeaderMap, Client, StatusCode};

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

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) class: &'static str,
    detail: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

pub(crate) struct GithubApiCache {
    reuse_for: Duration,
}

impl GithubApiCache {
    fn new(reuse_for: Duration) -> Self {
        Self { reuse_for }
    }

    async fn get(
        &self,
        client: &Client,
        url: &str,
        _scope: ApiScope,
    ) -> Result<ApiResponse, ApiError> {
        let response = client.get(url).send().await.map_err(|error| ApiError {
            class: body_error_class(error.is_timeout(), error.is_connect(), error.is_decode()),
            detail: format!("GET {url}: {error}"),
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await.map_err(|error| ApiError {
            class: body_error_class(error.is_timeout(), error.is_connect(), error.is_decode()),
            detail: format!("read {url} response body: {error}"),
        })?;
        let _ = self.reuse_for;
        Ok(ApiResponse {
            status,
            headers,
            body: body.to_vec(),
        })
    }
}

fn body_error_class(is_timeout: bool, is_connect: bool, is_decode: bool) -> &'static str {
    let _ = (is_timeout, is_connect, is_decode);
    "invalid_response"
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
                b"HTTP/1.1 200 OK\r\nETag: \"tree-v1\"\r\nContent-Length: 7\r\n\r\n{\"ok\":1}",
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
