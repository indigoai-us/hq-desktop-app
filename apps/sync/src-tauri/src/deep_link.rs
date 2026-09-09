//! `hq-desktop://` URL scheme (US-009).
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
//! ## Nothing from a URL is ever logged verbatim
//!
//! A custom-scheme URL is attacker-controlled input that any web page can hand
//! this process, and the log file is read by support and pasted into tickets.
//! Writing the raw URL there — which this module used to do on the ignore path
//! — turns any future credential-bearing target, or any parameter someone
//! appends today, into a durable plaintext record on disk. Log the shape of
//! what arrived, never its content.

use tauri::{AppHandle, Emitter, Manager};

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
