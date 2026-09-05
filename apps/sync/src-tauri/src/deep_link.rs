//! `hq-desktop://` URL scheme (US-009).
//!
//! Stripe checkout returns to `hq-desktop://setup?checkout=done&company={uid}`.
//! That focuses Messages on `#setup` and refreshes the channel. Cold start
//! stashes the target the same way Messages conversation deep-links do.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::commands::desktop_alt::{self, DesktopDestination};
use crate::util::logfile::log;

const LOG_TAG: &str = "deep-link";
const EVENT_OPEN_SETUP: &str = "messages:open-setup";
const SCHEME: &str = "hq-desktop";

/// Parsed `hq-desktop://setup?checkout=done&company={uid}` target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDeepLinkTarget {
    #[serde(default)]
    pub checkout: String,
    pub company_uid: String,
}

/// Stashed until the desktop webview has listeners (cold-start path).
pub struct PendingSetupTarget(pub std::sync::Mutex<Option<SetupDeepLinkTarget>>);

impl PendingSetupTarget {
    pub fn new() -> Self {
        PendingSetupTarget(std::sync::Mutex::new(None))
    }
}

/// Parse a `hq-desktop://` URL. Only the setup+company checkout return is
/// accepted; anything else is ignored so random custom-scheme hits stay inert.
pub fn parse_hq_desktop_url(raw: &str) -> Option<SetupDeepLinkTarget> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    let is_setup = host.eq_ignore_ascii_case("setup") || path.eq_ignore_ascii_case("setup");
    if !is_setup {
        return None;
    }
    let mut checkout = String::new();
    let mut company_uid = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "checkout" => checkout = value.into_owned(),
            "company" => company_uid = value.into_owned(),
            _ => {}
        }
    }
    let company_uid = company_uid.trim().to_string();
    if !is_valid_company_uid(&company_uid) {
        return None;
    }
    Some(SetupDeepLinkTarget {
        checkout: checkout.trim().to_string(),
        company_uid,
    })
}

/// Company UIDs forwarded from a deep link must match `^cmp_[A-Za-z0-9_-]+$`.
/// The value lands in a Tauri event and a channel lookup, so anything a
/// third-party URL could smuggle in (path separators, whitespace, query
/// syntax) is rejected here rather than downstream.
pub fn is_valid_company_uid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("cmp_") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// First `hq-desktop://` argument the OS handed this process, if valid.
pub fn hq_desktop_url_from_argv(argv: &[String]) -> Option<String> {
    argv.iter()
        .find(|arg| parse_hq_desktop_url(arg).is_some())
        .cloned()
}

fn stash_target(app: &AppHandle, target: SetupDeepLinkTarget) {
    if let Some(state) = app.try_state::<PendingSetupTarget>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(target);
    }
}

fn clear_stashed_target(app: &AppHandle) {
    if let Some(state) = app.try_state::<PendingSetupTarget>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Focus Messages on `#setup` for `company` and emit so an already-mounted
/// shell can refresh. Cold start keeps the stash for `take_pending_setup_target`.
pub async fn open_setup_deep_link(
    app: AppHandle,
    target: SetupDeepLinkTarget,
) -> Result<(), String> {
    let desktop_already_mounted = app
        .get_webview_window(desktop_alt::WINDOW_LABEL)
        .is_some();
    stash_target(&app, target.clone());
    log(
        LOG_TAG,
        &format!(
            "HQ_DESKTOP_SETUP checkout={} company={}",
            target.checkout, target.company_uid
        ),
    );
    desktop_alt::open_destination(app.clone(), DesktopDestination::Messages).await?;
    let _ = app.emit_to(desktop_alt::WINDOW_LABEL, EVENT_OPEN_SETUP, &target);
    let _ = app.emit(EVENT_OPEN_SETUP, &target);
    if desktop_already_mounted {
        clear_stashed_target(&app);
    }
    Ok(())
}

pub fn spawn_open_hq_desktop_url(app: &AppHandle, url: String) {
    let Some(target) = parse_hq_desktop_url(&url) else {
        log(LOG_TAG, &format!("HQ_DESKTOP_IGNORE {url}"));
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = open_setup_deep_link(handle, target).await;
    });
}

/// Drain a stashed setup checkout deep-link (cold-start path).
#[tauri::command]
pub fn take_pending_setup_target(app: AppHandle) -> Option<SetupDeepLinkTarget> {
    let state = app.try_state::<PendingSetupTarget>()?;
    let target = state.0.lock().unwrap_or_else(|p| p.into_inner()).take();
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_setup_checkout_done() {
        let parsed = parse_hq_desktop_url(
            "hq-desktop://setup?checkout=done&company=cmp_acme",
        )
        .expect("valid setup url");
        assert_eq!(parsed.checkout, "done");
        assert_eq!(parsed.company_uid, "cmp_acme");
    }

    #[test]
    fn parse_setup_with_path_slash() {
        let parsed =
            parse_hq_desktop_url("hq-desktop://setup/?checkout=done&company=cmp_x")
                .expect("path slash is accepted");
        assert_eq!(parsed.company_uid, "cmp_x");
    }

    #[test]
    fn parse_rejects_missing_company() {
        assert!(parse_hq_desktop_url("hq-desktop://setup?checkout=done").is_none());
    }

    #[test]
    fn parse_rejects_other_schemes_and_hosts() {
        assert!(parse_hq_desktop_url("https://example.com/setup?company=cmp_x").is_none());
        assert!(parse_hq_desktop_url("hq-desktop://messages?company=cmp_x").is_none());
        assert!(parse_hq_desktop_url("hqwork://open?channel=setup").is_none());
    }

    #[test]
    fn parse_requires_cmp_prefixed_company_uid() {
        for bad in [
            "acme",
            "cmp_",
            "CMP_acme",
            "cmp_ac me",
            "cmp_acme/../x",
            "cmp_acme%00",
            "cmp_acme?x=1",
            "prs_owner",
            "cmp_ac.me",
        ] {
            let url = format!("hq-desktop://setup?checkout=done&company={bad}");
            assert!(
                parse_hq_desktop_url(&url).is_none(),
                "expected {bad:?} to be rejected"
            );
        }
        // Percent-encoded separators decode to invalid characters too.
        assert!(parse_hq_desktop_url(
            "hq-desktop://setup?checkout=done&company=cmp_acme%2F..%2Fx"
        )
        .is_none());

        for good in ["cmp_acme", "cmp_Acme-1_B", "cmp_0"] {
            let url = format!("hq-desktop://setup?checkout=done&company={good}");
            assert_eq!(
                parse_hq_desktop_url(&url).map(|t| t.company_uid),
                Some(good.to_string())
            );
        }
    }

    #[test]
    fn is_valid_company_uid_matches_the_pattern() {
        assert!(is_valid_company_uid("cmp_acme"));
        assert!(is_valid_company_uid("cmp_a-b_C9"));
        assert!(!is_valid_company_uid(""));
        assert!(!is_valid_company_uid("cmp_"));
        assert!(!is_valid_company_uid("cmp_a b"));
        assert!(!is_valid_company_uid("cmp_é"));
        assert!(!is_valid_company_uid("xcmp_acme"));
    }

    #[test]
    fn argv_picks_the_hq_desktop_url() {
        let argv = vec![
            "HQ".into(),
            "hq-desktop://setup?checkout=done&company=cmp_acme".into(),
        ];
        assert_eq!(
            hq_desktop_url_from_argv(&argv).as_deref(),
            Some("hq-desktop://setup?checkout=done&company=cmp_acme")
        );
        assert!(hq_desktop_url_from_argv(&["HQ".into(), "hqwork://open?channel=setup".into()]).is_none());
    }
}
