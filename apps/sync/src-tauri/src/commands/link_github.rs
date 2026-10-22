//! Live details for GitHub pull request and issue links shown in chat.
//!
//! The link hovercard parses the URL locally; this command adds what the URL
//! cannot carry: title, state, review decision, author, and size. Requests go
//! only to `api.github.com` (and the author avatar to
//! `avatars.githubusercontent.com`), with the person's own `gh` token when one
//! resolves so private repos work, and anonymously otherwise. Anything that
//! fails returns `Ok(None)` and the card keeps its parsed layout.
//!
//! Results are cached in memory for `CACHE_TTL` so hovering the same link
//! twice does not refetch, while a status change shows up within a minute.
//!
//! The `gh auth token` lookup runs on a blocking thread with a timeout, and
//! only one lookup runs at a time. When GitHub reports a rate limit, every
//! lookup returns `Ok(None)` without calling GitHub until the limit resets.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::header::HeaderMap;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use super::github_api::{rate_limit_reset_epoch, response_is_rate_limited};
use crate::util::client_info::client_headers;
use crate::util::paths;

const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const CACHE_TTL: Duration = Duration::from_secs(60);
/// How long a found token is reused before `gh auth token` runs again.
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
/// How long "no token" is remembered, so signing in to `gh` shows up soon.
const MISSING_TOKEN_TTL: Duration = Duration::from_secs(60);
/// Longest `gh auth token` may run (it can hang on a keychain prompt).
const GH_TOKEN_TIMEOUT: Duration = Duration::from_secs(3);
/// Back-off when GitHub signals a rate limit without saying when it resets.
const DEFAULT_BACKOFF_SECS: u64 = 60;
/// Upper bound on any back-off, in case a reset header is far off or wrong.
const MAX_BACKOFF_SECS: u64 = 60 * 60;
/// Review pages read per pull request (100 reviews each).
const MAX_REVIEW_PAGES: u64 = 3;
const MAX_CACHE_ENTRIES: usize = 500;
const MAX_AVATAR_BYTES: usize = 64 * 1024;
const MAX_TITLE_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct GithubRef {
    owner: String,
    repo: String,
    is_pull: bool,
    number: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubLinkSummary {
    /// "pull" or "issue".
    kind: &'static str,
    title: String,
    /// open, draft, merged, closed (PR); open, completed, not_planned, closed (issue).
    state: String,
    /// approved or changes_requested, from the latest decisive review per reviewer.
    review: Option<&'static str>,
    author: Option<String>,
    /// `data:` URL so the webview CSP needs no new image host.
    author_avatar: Option<String>,
    updated_at: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
    comments: Option<u64>,
}

type CacheEntry = (Instant, Option<GithubLinkSummary>);

static CACHE: LazyLock<Mutex<HashMap<GithubRef, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TOKEN: LazyLock<TokenCache> = LazyLock::new(TokenCache::default);
/// Unix seconds until which no GitHub API call is made. 0 means none.
static BACKOFF_UNTIL: AtomicU64 = AtomicU64::new(0);

fn valid_name(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 100
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && part != "."
        && part != ".."
}

/// Parse `https://github.com/{owner}/{repo}/(pull|issues)/{n}[/...]`.
pub(crate) fn parse_github_ref(url: &str) -> Option<GithubRef> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let mut parts = parsed.path_segments()?;
    let owner = parts.next()?;
    let repo = parts.next()?;
    let kind = parts.next()?;
    let number = parts.next()?;
    if !valid_name(owner) || !valid_name(repo) {
        return None;
    }
    let is_pull = match kind {
        "pull" => true,
        "issues" => false,
        _ => return None,
    };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(GithubRef {
        owner: owner.to_string(),
        repo: repo.to_string(),
        is_pull,
        number: number.parse().ok()?,
    })
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPull {
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    merged_at: Option<String>,
    user: Option<GhUser>,
    updated_at: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GhIssue {
    title: String,
    state: String,
    #[serde(default)]
    state_reason: Option<String>,
    user: Option<GhUser>,
    updated_at: Option<String>,
    comments: Option<u64>,
    /// Present when the "issue" is a pull request.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct GhReview {
    user: Option<GhUser>,
    state: String,
}

fn clip(title: &str) -> String {
    let clean = title.split_whitespace().collect::<Vec<_>>().join(" ");
    clean.chars().take(MAX_TITLE_CHARS).collect()
}

fn pull_state(pull: &GhPull) -> &'static str {
    if pull.merged || pull.merged_at.is_some() {
        "merged"
    } else if pull.state == "closed" {
        "closed"
    } else if pull.draft {
        "draft"
    } else {
        "open"
    }
}

fn issue_state(issue: &GhIssue) -> &'static str {
    if issue.state == "open" {
        return "open";
    }
    match issue.state_reason.as_deref() {
        Some("completed") => "completed",
        Some("not_planned") => "not_planned",
        _ => "closed",
    }
}

/// GitHub's review decision, rebuilt from the review list: each reviewer's
/// latest APPROVED / CHANGES_REQUESTED / DISMISSED counts. Any outstanding
/// change request wins over approvals.
pub(crate) fn review_decision(reviews: &[GhReviewLite]) -> Option<&'static str> {
    let mut latest: HashMap<&str, &str> = HashMap::new();
    for review in reviews {
        if matches!(
            review.state.as_str(),
            "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
        ) {
            latest.insert(review.login.as_str(), review.state.as_str());
        }
    }
    if latest.values().any(|s| *s == "CHANGES_REQUESTED") {
        Some("changes_requested")
    } else if latest.values().any(|s| *s == "APPROVED") {
        Some("approved")
    } else {
        None
    }
}

pub(crate) struct GhReviewLite {
    login: String,
    state: String,
}

/// Whether a cached token lookup made at `at` still holds at `now`. A found
/// token is kept for `TOKEN_TTL`, a missing one only for `MISSING_TOKEN_TTL`.
fn token_entry_fresh(at: Instant, token: &Option<String>, now: Instant) -> bool {
    let ttl = if token.is_some() {
        TOKEN_TTL
    } else {
        MISSING_TOKEN_TTL
    };
    now.saturating_duration_since(at) < ttl
}

/// The `gh` token, looked up at most once at a time. The slot lock is held
/// only to read or write the cached value; the lookup itself runs with only
/// the async `refresh` gate held, so concurrent hovers wait without blocking
/// a thread and reuse the one result.
#[derive(Default)]
struct TokenCache {
    slot: Mutex<Option<(Instant, Option<String>)>>,
    refresh: tokio::sync::Mutex<()>,
}

impl TokenCache {
    fn fresh(&self) -> Option<Option<String>> {
        let slot = self.slot.lock().ok()?;
        let (at, token) = slot.as_ref()?;
        token_entry_fresh(*at, token, Instant::now()).then(|| token.clone())
    }

    async fn get<F>(&self, resolve: F) -> Option<String>
    where
        F: FnOnce() -> Option<String> + Send + 'static,
    {
        if let Some(token) = self.fresh() {
            return token;
        }
        let _gate = self.refresh.lock().await;
        // Another caller may have refreshed while this one waited.
        if let Some(token) = self.fresh() {
            return token;
        }
        // The resolver enforces its own timeout; this outer bound only guards
        // against a resolver that ignores it.
        let token = tokio::time::timeout(
            GH_TOKEN_TIMEOUT + Duration::from_secs(1),
            tokio::task::spawn_blocking(resolve),
        )
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .flatten();
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some((Instant::now(), token.clone()));
        }
        token
    }
}

/// Run `cmd` and return its trimmed stdout when it exits successfully within
/// `timeout`. On timeout the child is killed and reaped. Blocking: call it
/// from `spawn_blocking`.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

/// `gh auth token` with a timeout, then the `hosts.yml` fallback.
fn resolve_gh_token_bounded() -> Option<String> {
    let mut cmd = Command::new(paths::resolve_bin("gh"));
    paths::no_window(&mut cmd);
    cmd.args(["auth", "token"]);
    run_with_timeout(cmd, GH_TOKEN_TIMEOUT)
        .or_else(crate::commands::hq_core_staging::gh_token_from_hosts_file)
}

async fn cached_token() -> Option<String> {
    TOKEN.get(resolve_gh_token_bounded).await
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// When GitHub says to stop, the Unix time to resume; `None` when it did not.
/// Covers a 403/429 rate-limit response, a `Retry-After` header, and a
/// response that used up the last request (`X-RateLimit-Remaining: 0`).
fn backoff_until(status: StatusCode, headers: &HeaderMap, now: u64) -> Option<u64> {
    let exhausted = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        == Some("0");
    let limited = response_is_rate_limited(status, headers)
        || exhausted
        || headers.contains_key("retry-after");
    if !limited {
        return None;
    }
    let until = rate_limit_reset_epoch(headers)
        .filter(|reset| *reset > now)
        .unwrap_or(now + DEFAULT_BACKOFF_SECS);
    Some(until.min(now + MAX_BACKOFF_SECS))
}

fn in_backoff(until: u64, now: u64) -> bool {
    now < until
}

fn note_backoff(until: u64) {
    BACKOFF_UNTIL.fetch_max(until, Ordering::Relaxed);
}

/// The page number in a GitHub `Link` header's `rel="last"` entry.
fn last_page(link: &str) -> Option<u64> {
    link.split(',').find_map(|part| {
        let (target, rel) = part.split_once(';')?;
        if !rel.contains("rel=\"last\"") {
            return None;
        }
        let url =
            url::Url::parse(target.trim().trim_start_matches('<').trim_end_matches('>')).ok()?;
        url.query_pairs()
            .find(|(k, _)| k == "page")
            .and_then(|(_, v)| v.parse().ok())
    })
}

/// Review pages to read after page 1, given the last page number. Reads the
/// newest pages so the latest reviews decide, `MAX_REVIEW_PAGES` in total.
fn review_pages_after_first(last: u64) -> Vec<u64> {
    if last <= 1 {
        return Vec::new();
    }
    let first_extra = last.saturating_sub(MAX_REVIEW_PAGES - 2).max(2);
    (first_extra..=last).collect()
}

#[derive(Debug)]
enum FetchError {
    /// GitHub asked us to slow down; the back-off is recorded.
    RateLimited,
    /// Anything else (no access, offline, bad JSON). Not logged: URLs are
    /// private repo names.
    Other,
}

fn client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = client_headers();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(token) = token {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("github link client: {e}"))
}

/// GET a GitHub API URL. Records a back-off from the response headers; a
/// rate-limited response is `FetchError::RateLimited`. A successful response
/// that used the last request still returns its body.
async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
) -> Result<(HeaderMap, T), FetchError> {
    if in_backoff(BACKOFF_UNTIL.load(Ordering::Relaxed), unix_now()) {
        return Err(FetchError::RateLimited);
    }
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|_| FetchError::Other)?;
    let status = res.status();
    let headers = res.headers().clone();
    if let Some(until) = backoff_until(status, &headers, unix_now()) {
        note_backoff(until);
        if !status.is_success() {
            return Err(FetchError::RateLimited);
        }
    }
    if !status.is_success() {
        return Err(FetchError::Other);
    }
    let body = res.json::<T>().await.map_err(|_| FetchError::Other)?;
    Ok((headers, body))
}

/// All reviews on a pull request, oldest first: page 1, then up to
/// `MAX_REVIEW_PAGES - 1` of the newest pages. A failed later page keeps
/// what was read; a rate limit is passed up.
async fn fetch_reviews(
    client: &reqwest::Client,
    base: &str,
    number: u64,
) -> Result<Vec<GhReview>, FetchError> {
    let page_url = |page: u64| format!("{base}/pulls/{number}/reviews?per_page=100&page={page}");
    let (headers, mut reviews): (HeaderMap, Vec<GhReview>) =
        match get_json(client, &page_url(1)).await {
            Ok(page) => page,
            Err(FetchError::RateLimited) => return Err(FetchError::RateLimited),
            Err(FetchError::Other) => return Ok(Vec::new()),
        };
    let last = headers
        .get(reqwest::header::LINK)
        .and_then(|v| v.to_str().ok())
        .and_then(last_page)
        .unwrap_or(1);
    for page in review_pages_after_first(last) {
        match get_json::<Vec<GhReview>>(client, &page_url(page)).await {
            Ok((_, more)) => reviews.extend(more),
            Err(FetchError::RateLimited) => return Err(FetchError::RateLimited),
            Err(FetchError::Other) => break,
        }
    }
    Ok(reviews)
}

/// Small author avatar as a `data:` URL. Only GitHub's avatar host is fetched.
async fn avatar_data_url(avatar_url: &str) -> Option<String> {
    let mut url = url::Url::parse(avatar_url).ok()?;
    if url.scheme() != "https" || url.host_str()? != "avatars.githubusercontent.com" {
        return None;
    }
    url.query_pairs_mut().append_pair("s", "40");
    let res = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?
        .get(url)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

async fn fetch_summary(target: &GithubRef) -> Result<GithubLinkSummary, FetchError> {
    let token = cached_token().await;
    let client = client(token.as_deref()).map_err(|_| FetchError::Other)?;
    let base = format!(
        "https://api.github.com/repos/{}/{}",
        target.owner, target.repo
    );
    if target.is_pull {
        let (_, pull): (_, GhPull) =
            get_json(&client, &format!("{base}/pulls/{}", target.number)).await?;
        let reviews = fetch_reviews(&client, &base, target.number).await?;
        let lite: Vec<GhReviewLite> = reviews
            .into_iter()
            .filter_map(|r| {
                Some(GhReviewLite {
                    login: r.user?.login,
                    state: r.state,
                })
            })
            .collect();
        let state = pull_state(&pull);
        let avatar = match pull.user.as_ref().and_then(|u| u.avatar_url.as_deref()) {
            Some(url) => avatar_data_url(url).await,
            None => None,
        };
        Ok(GithubLinkSummary {
            kind: "pull",
            title: clip(&pull.title),
            state: state.to_string(),
            review: if state == "open" || state == "draft" {
                review_decision(&lite)
            } else {
                None
            },
            author: pull.user.map(|u| u.login),
            author_avatar: avatar,
            updated_at: pull.updated_at,
            additions: pull.additions,
            deletions: pull.deletions,
            changed_files: pull.changed_files,
            comments: None,
        })
    } else {
        let (_, issue): (_, GhIssue) =
            get_json(&client, &format!("{base}/issues/{}", target.number)).await?;
        if issue.pull_request.is_some() {
            // /issues/N for a PR number: answer as the PR the link really is.
            let as_pull = GithubRef {
                is_pull: true,
                ..target.clone()
            };
            return Box::pin(fetch_summary(&as_pull)).await;
        }
        let avatar = match issue.user.as_ref().and_then(|u| u.avatar_url.as_deref()) {
            Some(url) => avatar_data_url(url).await,
            None => None,
        };
        Ok(GithubLinkSummary {
            kind: "issue",
            title: clip(&issue.title),
            state: issue_state(&issue).to_string(),
            review: None,
            author: issue.user.map(|u| u.login),
            author_avatar: avatar,
            updated_at: issue.updated_at,
            additions: None,
            deletions: None,
            changed_files: None,
            comments: issue.comments,
        })
    }
}

/// Live details for a GitHub PR or issue link. `Ok(None)` means "unknown"
/// (not a PR/issue URL, no access, offline); the card keeps its parsed layout.
#[tauri::command]
pub async fn link_github_summary(url: String) -> Result<Option<GithubLinkSummary>, String> {
    let Some(target) = parse_github_ref(&url) else {
        return Ok(None);
    };
    if let Some((at, hit)) = CACHE.lock().ok().and_then(|c| c.get(&target).cloned()) {
        if at.elapsed() < CACHE_TTL {
            return Ok(hit);
        }
    }
    // Rate limited: answer "unknown" without caching, so the card fills in
    // as soon as the limit resets rather than a minute later.
    if in_backoff(BACKOFF_UNTIL.load(Ordering::Relaxed), unix_now()) {
        return Ok(None);
    }
    let summary = match fetch_summary(&target).await {
        Ok(summary) => Some(summary),
        Err(FetchError::RateLimited) => return Ok(None),
        Err(FetchError::Other) => None,
    };
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(target, (Instant::now(), summary.clone()));
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pull_and_issue_links_only() {
        let pr = parse_github_ref("https://github.com/indigoai-us/hq-pro/pull/5020/files").unwrap();
        assert_eq!(pr.owner, "indigoai-us");
        assert_eq!(pr.repo, "hq-pro");
        assert!(pr.is_pull);
        assert_eq!(pr.number, 5020);
        let issue = parse_github_ref("https://github.com/acme/app/issues/7").unwrap();
        assert!(!issue.is_pull);
        assert!(parse_github_ref("https://github.com/acme/app/commit/abc").is_none());
        assert!(parse_github_ref("https://github.com/acme/app/pull/x1").is_none());
        assert!(parse_github_ref("http://github.com/acme/app/pull/1").is_none());
        assert!(parse_github_ref("https://gitlab.com/acme/app/pull/1").is_none());
        assert!(parse_github_ref("https://github.com/../app/pull/1").is_none());
        assert!(parse_github_ref("https://github.com/acme").is_none());
    }

    fn review(login: &str, state: &str) -> GhReviewLite {
        GhReviewLite {
            login: login.into(),
            state: state.into(),
        }
    }

    #[test]
    fn review_decision_uses_each_reviewers_latest_decisive_review() {
        assert_eq!(review_decision(&[]), None);
        assert_eq!(review_decision(&[review("a", "COMMENTED")]), None);
        assert_eq!(
            review_decision(&[review("a", "APPROVED")]),
            Some("approved")
        );
        assert_eq!(
            review_decision(&[review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")]),
            Some("changes_requested")
        );
        // A later approval from the same reviewer clears their change request.
        assert_eq!(
            review_decision(&[
                review("a", "CHANGES_REQUESTED"),
                review("a", "COMMENTED"),
                review("a", "APPROVED"),
            ]),
            Some("approved")
        );
        // Dismissal clears it too.
        assert_eq!(
            review_decision(&[review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED")]),
            None
        );
    }

    #[test]
    fn pull_and_issue_states() {
        let pull = |state: &str, draft: bool, merged: bool| GhPull {
            title: "t".into(),
            state: state.into(),
            draft,
            merged,
            merged_at: None,
            user: None,
            updated_at: None,
            additions: None,
            deletions: None,
            changed_files: None,
        };
        assert_eq!(pull_state(&pull("open", false, false)), "open");
        assert_eq!(pull_state(&pull("open", true, false)), "draft");
        assert_eq!(pull_state(&pull("closed", false, true)), "merged");
        assert_eq!(pull_state(&pull("closed", false, false)), "closed");

        let issue = |state: &str, reason: Option<&str>| GhIssue {
            title: "t".into(),
            state: state.into(),
            state_reason: reason.map(Into::into),
            user: None,
            updated_at: None,
            comments: None,
            pull_request: None,
        };
        assert_eq!(issue_state(&issue("open", None)), "open");
        assert_eq!(
            issue_state(&issue("closed", Some("completed"))),
            "completed"
        );
        assert_eq!(
            issue_state(&issue("closed", Some("not_planned"))),
            "not_planned"
        );
        assert_eq!(issue_state(&issue("closed", None)), "closed");
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().unwrap());
        }
        map
    }

    #[test]
    fn backoff_starts_on_rate_limit_signals_only() {
        let now = 1_000_000;
        // Normal responses: no back-off.
        assert_eq!(backoff_until(StatusCode::OK, &headers(&[]), now), None);
        assert_eq!(
            backoff_until(
                StatusCode::OK,
                &headers(&[("x-ratelimit-remaining", "12")]),
                now
            ),
            None
        );
        assert_eq!(
            backoff_until(StatusCode::NOT_FOUND, &headers(&[]), now),
            None
        );
        // A plain 403 (no access) is not a rate limit.
        assert_eq!(
            backoff_until(StatusCode::FORBIDDEN, &headers(&[]), now),
            None
        );

        // Last request used: back off until the reset time, even on a 200.
        let reset = (now + 900).to_string();
        assert_eq!(
            backoff_until(
                StatusCode::OK,
                &headers(&[
                    ("x-ratelimit-remaining", "0"),
                    ("x-ratelimit-reset", &reset)
                ]),
                now
            ),
            Some(now + 900)
        );
        // 403 with remaining 0 and a reset.
        assert_eq!(
            backoff_until(
                StatusCode::FORBIDDEN,
                &headers(&[
                    ("x-ratelimit-remaining", "0"),
                    ("x-ratelimit-reset", &reset)
                ]),
                now
            ),
            Some(now + 900)
        );
        // 429 with no reset information: default back-off.
        assert_eq!(
            backoff_until(StatusCode::TOO_MANY_REQUESTS, &headers(&[]), now),
            Some(now + DEFAULT_BACKOFF_SECS)
        );
        // Retry-After (secondary limit) is relative to the real clock.
        let wall = unix_now();
        let until = backoff_until(
            StatusCode::FORBIDDEN,
            &headers(&[("retry-after", "30")]),
            wall,
        )
        .unwrap();
        assert!(
            until >= wall + 30 && until <= wall + 32,
            "{until} vs {wall}"
        );
        // A reset already in the past falls back to the default.
        assert_eq!(
            backoff_until(
                StatusCode::FORBIDDEN,
                &headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "5")]),
                now
            ),
            Some(now + DEFAULT_BACKOFF_SECS)
        );
        // A far-off reset is capped.
        let far = (now + 10 * MAX_BACKOFF_SECS).to_string();
        assert_eq!(
            backoff_until(
                StatusCode::FORBIDDEN,
                &headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &far)]),
                now
            ),
            Some(now + MAX_BACKOFF_SECS)
        );
    }

    #[test]
    fn in_backoff_until_the_reset_time() {
        assert!(!in_backoff(0, 1_000));
        assert!(in_backoff(1_060, 1_000));
        assert!(in_backoff(1_060, 1_059));
        assert!(!in_backoff(1_060, 1_060));
    }

    #[tokio::test]
    async fn rate_limited_summary_is_not_cached() {
        let url = "https://github.com/acme/backoff-probe/pull/99";
        let target = parse_github_ref(url).unwrap();
        note_backoff(unix_now() + 120);
        assert_eq!(link_github_summary(url.to_string()).await.unwrap(), None);
        assert!(
            CACHE.lock().unwrap().get(&target).is_none(),
            "a rate-limited lookup must not be cached as a miss"
        );
        BACKOFF_UNTIL.store(0, Ordering::Relaxed);
    }

    #[test]
    fn missing_token_expires_sooner_than_a_found_one() {
        let at = Instant::now();
        let found = Some("t".to_string());
        assert!(token_entry_fresh(
            at,
            &found,
            at + Duration::from_secs(5 * 60)
        ));
        assert!(!token_entry_fresh(at, &found, at + TOKEN_TTL));
        assert!(token_entry_fresh(at, &None, at + Duration::from_secs(30)));
        assert!(!token_entry_fresh(at, &None, at + MISSING_TOKEN_TTL));
        assert!(MISSING_TOKEN_TTL < TOKEN_TTL);
    }

    #[tokio::test]
    async fn token_lookup_is_cached_and_single_flight() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;

        let cache = Arc::new(TokenCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                cache
                    .get(move || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        Some("tok".to_string())
                    })
                    .await
            }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().as_deref(), Some("tok"));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "one lookup for concurrent callers"
        );

        // A cached value is reused without calling the resolver again.
        let again = cache.get(|| panic!("resolver must not run")).await;
        assert_eq!(again.as_deref(), Some("tok"));
    }

    #[tokio::test]
    async fn token_slot_is_free_while_the_lookup_runs() {
        use std::sync::Arc;

        let cache = Arc::new(TokenCache::default());
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let task = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get(move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        None
                    })
                    .await
            })
        };
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();
        // The slot lock is not held during the lookup.
        assert!(cache.slot.try_lock().is_ok());
        release_tx.send(()).unwrap();
        assert_eq!(task.await.unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn slow_command_is_killed_at_the_timeout() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5; echo late"]);
        let started = Instant::now();
        assert_eq!(run_with_timeout(cmd, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(2));

        let mut ok = Command::new("sh");
        ok.args(["-c", "echo ' tok '"]);
        assert_eq!(
            run_with_timeout(ok, Duration::from_secs(3)).as_deref(),
            Some("tok")
        );

        let mut failed = Command::new("sh");
        failed.args(["-c", "echo tok; exit 1"]);
        assert_eq!(run_with_timeout(failed, Duration::from_secs(3)), None);
    }

    #[test]
    fn review_paging_reads_the_newest_pages() {
        let link = "<https://api.github.com/repositories/1/pulls/5/reviews?per_page=100&page=2>; rel=\"next\", <https://api.github.com/repositories/1/pulls/5/reviews?per_page=100&page=7>; rel=\"last\"";
        assert_eq!(last_page(link), Some(7));
        assert_eq!(last_page("<https://x.test/?page=2>; rel=\"next\""), None);
        assert_eq!(last_page(""), None);

        assert_eq!(review_pages_after_first(1), Vec::<u64>::new());
        assert_eq!(review_pages_after_first(2), vec![2]);
        assert_eq!(review_pages_after_first(3), vec![2, 3]);
        assert_eq!(review_pages_after_first(7), vec![6, 7]);
        assert!((review_pages_after_first(50).len() as u64) < MAX_REVIEW_PAGES);
    }

    #[test]
    fn titles_are_collapsed_and_capped() {
        assert_eq!(clip("  Fix\n the   thing "), "Fix the thing");
        assert_eq!(clip(&"x".repeat(1000)).chars().count(), MAX_TITLE_CHARS);
    }
}
