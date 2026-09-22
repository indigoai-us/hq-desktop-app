//! Custom-scheme deep links for HQ Desktop.
//!
//! ## `hq-desktop://` (US-009)
//!
//! Two targets, and only two:
//!
//! - `hq-desktop://setup?checkout=done&company={uid}` — Stripe checkout return.
//!   Focuses Messages on `#setup` and refreshes the channel. Cold start stashes
//!   the target the same way Messages conversation deep-links do.
//! - `hq-desktop://signin` — start sign-in. Carries NOTHING: no identity, no
//!   token, no challenge, no callback override, no company. Any query string at
//!   all is a refusal, so nobody can begin smuggling one parameter at a time.
//!   It is a doorbell, not a key; it does exactly what clicking Sign in does.
//!
//! ## `hq://` (US-004)
//!
//! Notification / console / email links map onto the desktop route grammar:
//! `inbox:dm:…`, `inbox:channel:…`, `files:…`, `company:…`, `meetings`.
//! Parsing is a pure `parse_hq_url -> Option<String>`; cold start and a
//! second-launch argv resolve here so the webview is not required.
//!
//! ## Nothing from a URL is ever logged verbatim
//!
//! A custom-scheme URL is attacker-controlled input that any web page can hand
//! this process, and the log file is read by support and pasted into tickets.
//! Writing the raw URL there — which this module used to do on the ignore path
//! — turns any future credential-bearing target, or any parameter someone
//! appends today, into a durable plaintext record on disk. Log the shape of
//! what arrived, never its content.

use tauri::{AppHandle, Emitter, Manager};
use url::Url;

pub use hq_desktop_core::deep_link::{
    hq_desktop_url_from_argv, is_valid_company_uid, parse_hq_desktop_target, parse_hq_desktop_url,
    HqDesktopTarget, SetupDeepLinkTarget,
};

use crate::commands::desktop_alt::{self, DesktopDestination};
use crate::util::logfile::log;

const LOG_TAG: &str = "deep-link";
const EVENT_OPEN_SETUP: &str = "messages:open-setup";
const EVENT_OPEN_SIGNIN: &str = "auth:open-signin";

/// Stashed until the desktop webview has listeners (cold-start path).
pub struct PendingSetupTarget(pub std::sync::Mutex<Option<SetupDeepLinkTarget>>);

impl PendingSetupTarget {
    pub fn new() -> Self {
        PendingSetupTarget(std::sync::Mutex::new(None))
    }
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
    let desktop_already_mounted = app.get_webview_window(desktop_alt::WINDOW_LABEL).is_some();
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
    match parse_hq_desktop_target(&url) {
        Some(HqDesktopTarget::Setup(target)) => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = open_setup_deep_link(handle, target).await;
            });
        }
        Some(HqDesktopTarget::SignIn) => {
            open_signin_deep_link(app);
        }
        None => {
            // Never the URL itself. See the module header: this line lands in a
            // support log that gets pasted into tickets.
            log(LOG_TAG, &format!("HQ_DESKTOP_IGNORE len={}", url.len()));
        }
    }
}

/// Ask the renderer to show sign-in.
///
/// This does not authenticate anything and cannot. It carries no data, it
/// starts no OAuth attempt by itself, and an app that already holds a valid
/// session ignores it — the renderer decides, exactly as it does when someone
/// clicks Sign in. An old build that has never heard of this target simply logs
/// the ignore and does nothing, which is the intended behaviour there.
fn open_signin_deep_link(app: &AppHandle) {
    log(LOG_TAG, "HQ_DESKTOP_SIGNIN");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            desktop_alt::open_destination(handle.clone(), DesktopDestination::Messages).await
        {
            log(LOG_TAG, &format!("HQ_DESKTOP_SIGNIN_OPEN_FAILED {error}"));
            return;
        }
        let _ = handle.emit_to(desktop_alt::WINDOW_LABEL, EVENT_OPEN_SIGNIN, ());
        let _ = handle.emit(EVENT_OPEN_SIGNIN, ());
    });
}

/// Drain a stashed setup checkout deep-link (cold-start path).
#[tauri::command]
pub fn take_pending_setup_target(app: AppHandle) -> Option<SetupDeepLinkTarget> {
    let state = app.try_state::<PendingSetupTarget>()?;
    let target = state.0.lock().unwrap_or_else(|p| p.into_inner()).take();
    target
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn is_allowed_hq_url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'['
                | b']'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b'%'
        )
}

/// Validate an `hq://` URL byte-for-byte before parsing, matching
/// `validate_hqwork_deep_link`: printable ASCII, no shell metacharacters,
/// well-formed percent escapes. Does not include the URL in the error.
pub fn validate_hq_url_bytes(url: &str) -> Result<(), &'static str> {
    if url.is_empty() {
        return Err("empty");
    }
    let bytes = url.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if !(0x21..=0x7e).contains(&byte) {
            return Err("control");
        }
        match byte {
            b'"' | b'\'' | b'`' | b'<' | b'>' | b'\\' | b'|' => {
                return Err("metachar");
            }
            b'%' => {
                if i + 2 >= bytes.len()
                    || !is_hex_digit(bytes[i + 1])
                    || !is_hex_digit(bytes[i + 2])
                {
                    return Err("percent");
                }
                i += 3;
                continue;
            }
            _ if is_allowed_hq_url_byte(byte) => {}
            _ => return Err("disallowed"),
        }
        i += 1;
    }
    Ok(())
}

fn is_id_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_slug_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_path_token(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
}

fn starts_with_hq_scheme(raw: &str) -> bool {
    raw.trim()
        .chars()
        .take(5)
        .collect::<String>()
        .eq_ignore_ascii_case("hq://")
}

/// First `hq://` argument the OS handed this process, including malformed
/// ones so the landing-route fallback can still front the window.
pub fn hq_url_from_argv<S: AsRef<str>>(argv: &[S]) -> Option<String> {
    argv.iter()
        .map(|s| s.as_ref().trim())
        .find(|s| starts_with_hq_scheme(s))
        .map(|s| s.to_string())
}

fn map_hq_segments(segs: &[&str]) -> Option<String> {
    match segs {
        [head] if head.eq_ignore_ascii_case("meetings") => Some("meetings".into()),
        [head, "dm", uid] if head.eq_ignore_ascii_case("inbox") && is_id_token(uid) => {
            Some(format!("inbox:dm:{uid}"))
        }
        [head, "channel", channel]
            if head.eq_ignore_ascii_case("inbox") && is_id_token(channel) =>
        {
            Some(format!("inbox:channel:{channel}"))
        }
        [head, "channel", channel, message]
            if head.eq_ignore_ascii_case("inbox")
                && is_id_token(channel)
                && is_id_token(message) =>
        {
            Some(format!("inbox:channel:{channel}:{message}"))
        }
        [head, slug, rest @ ..]
            if head.eq_ignore_ascii_case("files")
                && is_slug_token(slug)
                && !rest.is_empty()
                && rest.iter().all(|part| is_path_token(part)) =>
        {
            Some(format!("files:{slug}:{}", rest.join(":")))
        }
        [head, slug] if head.eq_ignore_ascii_case("company") && is_slug_token(slug) => {
            Some(format!("company:{slug}"))
        }
        [head, slug, tab]
            if head.eq_ignore_ascii_case("company") && is_slug_token(slug) && is_id_token(tab) =>
        {
            Some(format!("company:{slug}:{tab}"))
        }
        _ => None,
    }
}

/// Map an `hq://` URL onto a desktop route string.
///
/// Pure: no logging, no window I/O. Callers log shape/length only when this
/// returns `None` and then front the landing route.
fn has_dot_segment(raw: &str) -> bool {
    raw.split('/')
        .any(|part| part == "." || part == ".." || part.starts_with(".."))
}

pub fn parse_hq_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if validate_hq_url_bytes(trimmed).is_err() {
        return None;
    }
    if has_dot_segment(trimmed) {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if !url.scheme().eq_ignore_ascii_case("hq") {
        return None;
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    let mut segs: Vec<&str> = Vec::new();
    if !host.is_empty() {
        segs.push(host);
    }
    if !path.is_empty() {
        segs.extend(path.split('/').filter(|part| !part.is_empty()));
    }
    map_hq_segments(&segs)
}

/// Deliver a parsed `hq://` URL (or front the landing route when malformed).
pub fn spawn_open_hq_url(app: &AppHandle, url: String) {
    let route = parse_hq_url(&url);
    if route.is_none() {
        // Never the URL itself. See the module header.
        log(
            LOG_TAG,
            &format!("HQ_URL_IGNORE len={}", url.chars().count()),
        );
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mapped = route.as_deref();
        let _ = desktop_alt::open_desktop_alt_window_inner(handle, mapped).await;
    });
}

/// Dispatch a plugin-delivered URL onto `hq://` or `hq-desktop://`.
pub fn spawn_open_delivered_url(app: &AppHandle, url: String) {
    if starts_with_hq_scheme(&url) {
        spawn_open_hq_url(app, url);
    } else {
        spawn_open_hq_desktop_url(app, url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hq_url_maps_each_supported_form() {
        assert_eq!(
            parse_hq_url("hq://inbox/dm/prs_ada").as_deref(),
            Some("inbox:dm:prs_ada")
        );
        assert_eq!(
            parse_hq_url("hq://inbox/channel/chn_eng").as_deref(),
            Some("inbox:channel:chn_eng")
        );
        assert_eq!(
            parse_hq_url("hq://inbox/channel/chn_eng/evt_root").as_deref(),
            Some("inbox:channel:chn_eng:evt_root")
        );
        assert_eq!(
            parse_hq_url("hq://files/indigo/companies/indigo/knowledge/foo.md").as_deref(),
            Some("files:indigo:companies:indigo:knowledge:foo.md")
        );
        assert_eq!(
            parse_hq_url("hq://company/indigo").as_deref(),
            Some("company:indigo")
        );
        assert_eq!(
            parse_hq_url("hq://company/indigo/activity").as_deref(),
            Some("company:indigo:activity")
        );
        assert_eq!(parse_hq_url("hq://meetings").as_deref(), Some("meetings"));
        assert_eq!(parse_hq_url("hq://meetings/").as_deref(), Some("meetings"));
        assert_eq!(parse_hq_url("HQ://meetings").as_deref(), Some("meetings"));
        assert_eq!(
            parse_hq_url("hq:///inbox/dm/prs_ada").as_deref(),
            Some("inbox:dm:prs_ada")
        );
    }

    #[test]
    fn parse_hq_url_rejects_malformed() {
        assert!(parse_hq_url("hq://not-a-real-target").is_none());
        assert!(parse_hq_url("hq://inbox/dm/").is_none());
        assert!(parse_hq_url("hq://inbox/dm").is_none());
        assert!(parse_hq_url("hq://inbox/channel").is_none());
        assert!(parse_hq_url("hq://files/indigo").is_none());
        assert!(parse_hq_url("hq://files/indigo/../etc/passwd").is_none());
        assert!(parse_hq_url("hq://company/indigo/activity/extra").is_none());
        assert!(parse_hq_url("hq://meetings?next=1").is_none());
        assert!(parse_hq_url("https://example.com/inbox/dm/prs_ada").is_none());
        assert!(parse_hq_url("hq-desktop://signin").is_none());
        assert!(parse_hq_url("hqwork://open?person=prs_ada").is_none());
        assert!(parse_hq_url("").is_none());
        assert!(parse_hq_url("hq://inbox/dm/prs ada").is_none());
        assert!(parse_hq_url("hq://inbox/dm/%zz").is_none());
        assert!(parse_hq_url("hq://inbox/dm/\"prs\"").is_none());
    }

    #[test]
    fn validate_hq_url_bytes_mirrors_hqwork_allowlist() {
        assert!(validate_hq_url_bytes("hq://inbox/dm/prs_ada").is_ok());
        assert!(validate_hq_url_bytes("hq://inbox/dm/prs ada").is_err());
        assert!(validate_hq_url_bytes("hq://inbox/dm/prs\"ada").is_err());
        assert!(validate_hq_url_bytes("hq://inbox/dm/%2").is_err());
        assert!(validate_hq_url_bytes("hq://inbox/dm/%zz").is_err());
    }

    #[test]
    fn argv_picks_hq_urls_including_malformed() {
        assert_eq!(
            hq_url_from_argv(&["HQ", "hq://inbox/dm/prs_ada"]).as_deref(),
            Some("hq://inbox/dm/prs_ada")
        );
        assert_eq!(
            hq_url_from_argv(&["HQ", "hq://not-a-real-target"]).as_deref(),
            Some("hq://not-a-real-target")
        );
        assert!(hq_url_from_argv(&["HQ", "hq-desktop://signin"]).is_none());
        assert!(hq_url_from_argv(&["HQ", "hqwork://open?person=prs_ada"]).is_none());
        assert!(hq_url_from_argv(&["HQ", "--foreground"]).is_none());
    }

    #[test]
    fn never_byte_slices_a_str_in_this_module() {
        // Guard the HARD policy: log helpers and scheme checks must use
        // `chars()`, not a byte range on a &str.
        let source = include_str!("deep_link.rs");
        let forbidden = ["url", "raw", "trimmed", "s"].map(|name| format!("&{name}[.."));
        for needle in forbidden {
            assert!(
                !source.contains(&needle),
                "deep_link.rs must not byte-slice a &str ({needle})"
            );
        }
        assert!(source.contains("chars().take(5)"));
        assert!(source.contains("url.chars().count()"));
    }
}
