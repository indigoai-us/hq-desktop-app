//! Snapshot command for the Deployments side panel, including protected apps.
//!
//! Public apps are captured straight from their https URL. For password,
//! company and invited-only apps the desktop first checks that hq-deploy
//! advertises the `preview-pass` capability on `/health`, then:
//!   1. `POST /api/apps/{id}/preview-pass` with the signed-in user's token.
//!      hq-deploy only grants it when the user can already open the app.
//!   2. `GET https://{host}/__hq/preview` with the pass in a header. The gate
//!      spends the pass and returns a 60 s view-only session. No cookie is
//!      set and nothing goes in a URL.
//!   3. The hidden window loads the page through the `hqpreview` scheme, which
//!      adds the session header to every request (see `deploy_snapshot.rs`).
//!
//! When the server lacks the capability, or any step fails, the command
//! returns an error and the panel shows the share image instead. Tokens, the
//! pass and the session never reach the log.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::AppHandle;

use crate::commands::cognito;
use crate::commands::deploy_snapshot::{self, DeploySnapshot};
use crate::commands::desktop_alt::HQ_DEPLOY_API_BASE;
use crate::util::client_info::build_client;

pub const PREVIEW_PASS_CAPABILITY: &str = "preview-pass";
/// How long a "server has no preview pass" answer is trusted before asking again.
const CAPABILITY_RECHECK: Duration = Duration::from_secs(10 * 60);

static CAPABILITY: Mutex<Option<(bool, Instant)>> = Mutex::new(None);

/// True when `/health` lists the preview-pass capability.
pub fn health_advertises_preview_pass(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("capabilities").cloned())
        .and_then(|c| c.as_array().cloned())
        .is_some_and(|caps| {
            caps.iter()
                .any(|c| c.as_str() == Some(PREVIEW_PASS_CAPABILITY))
        })
}

/// `personal` or a company slug.
pub fn valid_scope(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= 128
        && scope
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassGrant {
    pub pass: String,
    pub exchange_url: String,
}

#[derive(Debug, Deserialize)]
struct SessionGrant {
    session: String,
}

/// Parse the mint response and check the exchange URL is https on the same
/// host as the page, so a pass is never sent anywhere else.
pub fn parse_pass_grant(body: &str, page: &url::Url) -> Result<PassGrant, String> {
    let grant: PassGrant =
        serde_json::from_str(body).map_err(|_| "preview pass: unreadable reply".to_string())?;
    let exchange = url::Url::parse(&grant.exchange_url)
        .map_err(|_| "preview pass: unreadable exchange url".to_string())?;
    if exchange.scheme() != "https"
        || exchange.host_str().map(str::to_ascii_lowercase)
            != page.host_str().map(str::to_ascii_lowercase)
        || exchange.port().is_some()
        || exchange.path() != "/__hq/preview"
    {
        return Err("preview pass: exchange url does not match the app".to_string());
    }
    if grant.pass.is_empty() {
        return Err("preview pass: empty pass".to_string());
    }
    Ok(grant)
}

async fn server_has_preview_pass(client: &reqwest::Client) -> bool {
    if let Ok(slot) = CAPABILITY.lock() {
        if let Some((known, at)) = *slot {
            if known || at.elapsed() < CAPABILITY_RECHECK {
                return known;
            }
        }
    }
    let known = match client
        .get(format!("{HQ_DEPLOY_API_BASE}/health"))
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res
            .text()
            .await
            .map(|body| health_advertises_preview_pass(&body))
            .unwrap_or(false),
        Ok(_) => false,
        Err(err) => {
            eprintln!(
                "[deploy-snapshot] capability check failed: {}",
                err.without_url()
            );
            // Do not cache a network failure.
            return false;
        }
    };
    if let Ok(mut slot) = CAPABILITY.lock() {
        *slot = Some((known, Instant::now()));
    }
    known
}

async fn acquire_preview_session(
    app_id: &str,
    page: &url::Url,
    deployed_at: &str,
    scope: &str,
) -> Result<String, String> {
    let client = build_client();
    if !server_has_preview_pass(&client).await {
        return Err("preview pass: not offered by this server".to_string());
    }
    let tokens = cognito::get_valid_tokens()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let mut req = client
        .post(format!(
            "{HQ_DEPLOY_API_BASE}/api/apps/{}/preview-pass",
            urlencode(app_id)
        ))
        .header("authorization", format!("Bearer {}", tokens.access_token));
    req = if scope == "personal" {
        req.header("x-hq-deploy-scope", "personal")
    } else {
        req.header("x-org-slug", scope)
    };
    let body = if deployed_at.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::json!({ "deployedAt": deployed_at })
    };
    let res = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("preview pass: {}", e.without_url()))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|_| "preview pass: unreadable reply".to_string())?;
    if !status.is_success() {
        return Err(format!("preview pass: HTTP {}", status.as_u16()));
    }
    let grant = parse_pass_grant(&text, page)?;

    let exchange = build_client()
        .get(&grant.exchange_url)
        .header("x-hq-preview-pass", &grant.pass)
        .send()
        .await
        .map_err(|e| format!("preview exchange: {}", e.without_url()))?;
    if !exchange.status().is_success() {
        return Err(format!(
            "preview exchange: HTTP {}",
            exchange.status().as_u16()
        ));
    }
    let session: SessionGrant = exchange
        .json()
        .await
        .map_err(|_| "preview exchange: unreadable reply".to_string())?;
    Ok(session.session)
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Snapshot for one deployed app. `protected` apps need `scope` (company slug
/// or `personal`) to request a preview pass.
#[tauri::command]
pub async fn deploy_app_snapshot(
    app: AppHandle,
    app_id: String,
    url: String,
    deployed_at: String,
    refresh: Option<bool>,
    scope: Option<String>,
    protected: Option<bool>,
) -> Result<DeploySnapshot, String> {
    let refresh = refresh.unwrap_or(false);
    let dir = deploy_snapshot::cache_dir_for(&app)?;
    let result = async {
        let session = if protected.unwrap_or(false) {
            if !refresh {
                if let Some(hit) = deploy_snapshot::cached_snapshot(&dir, &app_id, &deployed_at) {
                    return Ok(hit);
                }
            }
            let scope = scope
                .as_deref()
                .filter(|s| valid_scope(s))
                .ok_or("preview pass: no scope")?;
            let page = deploy_snapshot::validate_snapshot_url(&url)?;
            Some(acquire_preview_session(&app_id, &page, &deployed_at, scope).await?)
        } else {
            None
        };
        deploy_snapshot::load_snapshot(&app, &dir, &app_id, &url, &deployed_at, refresh, session)
            .await
    }
    .await;
    if let Err(err) = &result {
        eprintln!("[deploy-snapshot] {app_id}: {err}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_comes_from_health() {
        assert!(health_advertises_preview_pass(
            r#"{"status":"ok","capabilities":["preview-pass"]}"#
        ));
        // Servers without the endpoint: no capabilities field.
        assert!(!health_advertises_preview_pass(
            r#"{"status":"ok","timestamp":"x"}"#
        ));
        assert!(!health_advertises_preview_pass(
            r#"{"capabilities":["other"]}"#
        ));
        assert!(!health_advertises_preview_pass("not json"));
    }

    #[test]
    fn pass_is_only_sent_to_the_app_host() {
        let page = url::Url::parse("https://secret.indigo-hq.com/").unwrap();
        let ok = r#"{"pass":"p","exchangeUrl":"https://secret.indigo-hq.com/__hq/preview"}"#;
        assert_eq!(parse_pass_grant(ok, &page).unwrap().pass, "p");
        for bad in [
            r#"{"pass":"p","exchangeUrl":"https://evil.example/__hq/preview"}"#,
            r#"{"pass":"p","exchangeUrl":"http://secret.indigo-hq.com/__hq/preview"}"#,
            r#"{"pass":"p","exchangeUrl":"https://secret.indigo-hq.com/other"}"#,
            r#"{"pass":"p","exchangeUrl":"https://secret.indigo-hq.com:444/__hq/preview"}"#,
            r#"{"pass":"","exchangeUrl":"https://secret.indigo-hq.com/__hq/preview"}"#,
            r#"{"error":{"code":"NOT_FOUND"}}"#,
        ] {
            assert!(parse_pass_grant(bad, &page).is_err(), "{bad}");
        }
    }

    #[test]
    fn scope_must_be_a_slug_or_personal() {
        assert!(valid_scope("personal"));
        assert!(valid_scope("indigo"));
        assert!(!valid_scope(""));
        assert!(!valid_scope("Indigo"));
        assert!(!valid_scope("a/b"));
    }
}
