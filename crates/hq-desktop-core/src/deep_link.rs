//! Pure parsing for the `hq-desktop://` URL scheme.
//!
//! This lives in the core crate, not in the Tauri app, for one reason: it is
//! the security boundary for attacker-controlled input — any web page can hand
//! this process a custom-scheme URL — and the Tauri app crate cannot be built
//! or tested without a GTK/WebKit toolchain. A parser nobody can run the tests
//! for on an ordinary machine is a parser that quietly rots.
//!
//! Two targets, and only two:
//!
//! - `hq-desktop://setup?checkout=done&company={uid}` — Stripe checkout return.
//! - `hq-desktop://signin` — start sign-in. Carries NOTHING: no identity, no
//!   token, no challenge, no callback override, no company. Any query string or
//!   fragment at all is a refusal, so nobody can begin smuggling one parameter
//!   at a time. It is a doorbell, not a key.
//!
//! Nothing parsed here is ever logged verbatim by callers. A custom-scheme URL
//! is untrusted input and the desktop log file gets pasted into support
//! tickets; see the callers in the app crate.

use serde::{Deserialize, Serialize};
use url::Url;

const SCHEME: &str = "hq-desktop";

/// Parsed `hq-desktop://setup?checkout=done&company={uid}` target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDeepLinkTarget {
    #[serde(default)]
    pub checkout: String,
    pub company_uid: String,
}

/// Everything this process will act on from a `hq-desktop://` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HqDesktopTarget {
    /// Stripe checkout returned; focus `#setup` for this company.
    Setup(SetupDeepLinkTarget),
    /// Start sign-in. Deliberately carries no data of any kind.
    SignIn,
}

/// Parse a `hq-desktop://` URL. Only `setup` (with a valid company) and the
/// parameterless `signin` are accepted; anything else is ignored so random
/// custom-scheme hits stay inert.
pub fn parse_hq_desktop_target(raw: &str) -> Option<HqDesktopTarget> {
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
    let names = |name: &str| host.eq_ignore_ascii_case(name) || path.eq_ignore_ascii_case(name);

    if names("signin") {
        // A credential-free target stays credential-free by refusing to carry
        // anything at all. Accepting and ignoring unknown parameters would make
        // "we added one harmless parameter" a one-line change nobody notices,
        // and a fragment is just a query the parser did not look at.
        if url.query().is_some() || url.fragment().is_some() {
            return None;
        }
        // `signin` names the whole target: `signin/anything` is not it.
        if !host.is_empty() && !path.is_empty() {
            return None;
        }
        return Some(HqDesktopTarget::SignIn);
    }

    if !names("setup") {
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
    Some(HqDesktopTarget::Setup(SetupDeepLinkTarget {
        checkout: checkout.trim().to_string(),
        company_uid,
    }))
}

/// The setup target in a URL, if that is what it is.
pub fn parse_hq_desktop_url(raw: &str) -> Option<SetupDeepLinkTarget> {
    match parse_hq_desktop_target(raw)? {
        HqDesktopTarget::Setup(target) => Some(target),
        HqDesktopTarget::SignIn => None,
    }
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
        .find(|arg| parse_hq_desktop_target(arg).is_some())
        .cloned()
}

// ── Tests ──────────────────────────────────────────────────────────────

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
    fn parse_accepts_the_bare_signin_target() {
        for raw in [
            "hq-desktop://signin",
            "hq-desktop://signin/",
            "hq-desktop://SIGNIN",
            "  hq-desktop://signin  ",
        ] {
            assert_eq!(
                parse_hq_desktop_target(raw),
                Some(HqDesktopTarget::SignIn),
                "expected {raw:?} to be the sign-in target"
            );
        }
    }

    #[test]
    fn signin_refuses_to_carry_anything() {
        // The whole security argument for this target is that it transports
        // nothing. A parameter that is merely ignored is a parameter someone
        // will start relying on, so the URL is refused outright instead.
        for raw in [
            "hq-desktop://signin?token=abc",
            "hq-desktop://signin?company=cmp_acme",
            "hq-desktop://signin?next=https://evil.example",
            "hq-desktop://signin?code=abc&state=xyz",
            "hq-desktop://signin?",
            "hq-desktop://signin#token=abc",
            "hq-desktop://signin/extra",
        ] {
            assert_eq!(
                parse_hq_desktop_target(raw),
                None,
                "expected {raw:?} to be refused"
            );
        }
    }

    #[test]
    fn signin_is_not_a_setup_target() {
        // `parse_hq_desktop_url` feeds the checkout path, which opens a company
        // channel. Sign-in must never reach it.
        assert!(parse_hq_desktop_url("hq-desktop://signin").is_none());
    }

    #[test]
    fn setup_still_parses_through_the_target_enum() {
        assert_eq!(
            parse_hq_desktop_target("hq-desktop://setup?checkout=done&company=cmp_acme"),
            Some(HqDesktopTarget::Setup(SetupDeepLinkTarget {
                checkout: "done".into(),
                company_uid: "cmp_acme".into(),
            }))
        );
    }

    #[test]
    fn argv_picks_the_signin_target_too() {
        let argv = vec!["HQ".into(), "hq-desktop://signin".into()];
        assert_eq!(
            hq_desktop_url_from_argv(&argv).as_deref(),
            Some("hq-desktop://signin")
        );
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
