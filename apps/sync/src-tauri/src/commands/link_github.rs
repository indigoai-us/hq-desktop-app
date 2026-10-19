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

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::util::client_info::client_headers;

const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const CACHE_TTL: Duration = Duration::from_secs(60);
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
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
static TOKEN: LazyLock<Mutex<Option<(Instant, Option<String>)>>> =
    LazyLock::new(|| Mutex::new(None));

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

fn cached_token() -> Option<String> {
    let mut slot = TOKEN.lock().ok()?;
    if let Some((at, token)) = slot.as_ref() {
        if at.elapsed() < TOKEN_TTL {
            return token.clone();
        }
    }
    let token = crate::commands::hq_core_staging::resolve_gh_token();
    *slot = Some((Instant::now(), token.clone()));
    token
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

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, String> {
    let res = client.get(url).send().await.map_err(|e| format!("GET {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", res.status()));
    }
    res.json::<T>().await.map_err(|e| format!("GET {url}: {e}"))
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
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

async fn fetch_summary(target: &GithubRef) -> Result<GithubLinkSummary, String> {
    let token = cached_token();
    let client = client(token.as_deref())?;
    let base = format!(
        "https://api.github.com/repos/{}/{}",
        target.owner, target.repo
    );
    if target.is_pull {
        let pull: GhPull = get_json(&client, &format!("{base}/pulls/{}", target.number)).await?;
        let reviews: Vec<GhReview> = get_json(
            &client,
            &format!("{base}/pulls/{}/reviews?per_page=100", target.number),
        )
        .await
        .unwrap_or_default();
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
        let issue: GhIssue = get_json(&client, &format!("{base}/issues/{}", target.number)).await?;
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
    let summary = fetch_summary(&target).await.ok();
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
        assert_eq!(review_decision(&[review("a", "APPROVED")]), Some("approved"));
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
        assert_eq!(issue_state(&issue("closed", Some("completed"))), "completed");
        assert_eq!(issue_state(&issue("closed", Some("not_planned"))), "not_planned");
        assert_eq!(issue_state(&issue("closed", None)), "closed");
    }

    #[test]
    fn titles_are_collapsed_and_capped() {
        assert_eq!(clip("  Fix\n the   thing "), "Fix the thing");
        assert_eq!(clip(&"x".repeat(1000)).chars().count(), MAX_TITLE_CHARS);
    }
}
