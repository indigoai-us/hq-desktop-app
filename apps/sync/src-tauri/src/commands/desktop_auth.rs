//! Browser session continuation — the native half.
//!
//! Someone signs up on hqforwork.com, downloads HQ, opens it, and is asked to
//! sign in to the account they created four minutes ago. Between 2026-08-31 and
//! 2026-09-08, 101 people finished signup and were linked to a person, 43 ever
//! opened the desktop app, and of the 103 who reached the sign-in step only 66
//! got through. Three of those were recorded as an OAuth failure. The rest just
//! stopped.
//!
//! This module finishes that sign-in instead of asking for it again. It opens
//! the system browser through the ordinary Cognito authorization-code flow with
//! PKCE — the same flow the provider buttons use, the same app client, the same
//! loopback callback — and then does one thing differently: it holds the
//! resulting tokens in memory, asks the backend to verify them, shows the person
//! **Continue as \<email\>**, and only writes anything once they say yes.
//!
//! ## What this module deliberately is not
//!
//! It is not a handoff token attached to the download link. A signed assertion
//! travelling in a URL proves who *issued* it, not who *holds* it, and download
//! links get forwarded — to a colleague, into a group chat, through a helpdesk
//! ticket. That design was considered and rejected as an account-takeover
//! capability. Nothing here introduces a new signing key, and if a future change
//! seems to need one, it has drifted back into the rejected design.
//!
//! ## The rules the code is arranged around
//!
//! * **Off unless switched on.** A missing config, an unreachable backend, an
//!   unparseable body, or a protocol version this build does not implement all
//!   mean disabled, and disabled means the existing provider buttons — exactly
//!   what ships today.
//! * **Nothing is written before confirmation.** Tokens live in
//!   [`ContinuationCustody`], which has no serialize, no clone, and a `Debug`
//!   that prints a placeholder.
//! * **The renderer never sees a credential.** `confirm` and `cancel` take an
//!   attempt id. The only thing that crosses the bridge is an email and a
//!   display name, so the confirmation can say whose account it is.
//! * **One attempt at a time.** A second start supersedes the first rather than
//!   racing it, which is what makes two callbacks arriving together an answered
//!   question.
//!
//! The decision logic lives in `hq_desktop_core::session_continuation` and
//! `hq_desktop_core::continuation_custody`, which are pure and unit-tested. This
//! file is the wiring: Tauri commands, HTTP, and the browser. Keeping it thin is
//! not tidiness — `src-tauri` cannot be compiled without a GTK/JavaScriptCore
//! toolchain, so logic placed here is logic that no unit test can reach.

use hq_desktop_core::continuation_custody::{
    ContinuationCustody, CustodyError, PendingCredentials, VerifiedIdentity,
};
use hq_desktop_core::continuation_endpoints::ContinuationEndpoints;
use hq_desktop_core::session_continuation::{
    AttemptEnd, ContinuationAttempt, ContinuationConfig, DisabledReason, RolloutDecision,
    SUPPORTED_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::util::client_info::build_client;

use super::cognito::{self, AuthState, CognitoTokens};

/// Process-wide custody. One machine, one pending sign-in.
///
/// A plain `std::sync::Mutex` and never held across an `.await`: every guard in
/// this file is taken, used, and dropped inside one block. Holding it across an
/// HTTP round trip would let a slow provider block a Cancel click.
static CUSTODY: Mutex<Option<ContinuationCustody>> = Mutex::new(None);

fn with_custody<T>(f: impl FnOnce(&mut ContinuationCustody) -> T) -> T {
    let mut guard = CUSTODY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(ContinuationCustody::new))
}

/// Bump the account generation and discard anything pending.
///
/// Called by sign-out and by a manual sign-in completing. An attempt that was
/// waiting for confirmation when the account changed underneath it is now about
/// a question nobody asked, and its tokens go unwritten.
pub(crate) fn note_auth_transition(end: AttemptEnd) {
    with_custody(|custody| custody.bump_generation(end));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// What the renderer is told about a refusal.
///
/// A closed vocabulary. Deliberately coarse: the renderer's only real decision
/// is "show the provider buttons", and a more precise reason would be a more
/// precise thing to leak.
fn custody_error_code(error: CustodyError) -> &'static str {
    match error {
        CustodyError::NoSuchAttempt => "CONTINUATION_NO_ATTEMPT",
        CustodyError::Finished(_) => "CONTINUATION_ATTEMPT_OVER",
        CustodyError::StateMismatch => "CONTINUATION_STATE_MISMATCH",
        CustodyError::NonceMismatch => "CONTINUATION_TOKEN_MISMATCH",
        CustodyError::NothingHeld => "CONTINUATION_NOTHING_HELD",
    }
}

// ── Configuration ──────────────────────────────────────────────────────

/// The rollout document as the backend returns it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    #[serde(default)]
    protocol_version: Option<u32>,
    #[serde(default)]
    minimum_desktop_version: Option<String>,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    rollout_percent: Option<i64>,
}

/// What the renderer gets back. Never the raw document.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationAvailability {
    pub enabled: bool,
    /// Present when disabled. A closed set of labels, safe for telemetry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub variant: Option<String>,
}

fn disabled(reason: DisabledReason) -> ContinuationAvailability {
    ContinuationAvailability {
        enabled: false,
        reason: Some(match reason {
            DisabledReason::Unavailable => "unavailable",
            DisabledReason::Unrecognised => "unrecognised",
            DisabledReason::Control => "control",
            DisabledReason::NotInRollout => "not_in_rollout",
            DisabledReason::BuildTooOld => "build_too_old",
        }),
        variant: None,
    }
}

fn parse_config(body: &ConfigBody) -> Option<ContinuationConfig> {
    if body.protocol_version? != SUPPORTED_PROTOCOL_VERSION {
        return None;
    }
    let percent = body.rollout_percent?;
    if !(0..=100).contains(&percent) {
        return None;
    }
    Some(ContinuationConfig {
        protocol_version: Some(SUPPORTED_PROTOCOL_VERSION),
        minimum_desktop_version: Some(body.minimum_desktop_version.clone()?),
        variant: Some(body.variant.clone()?),
        rollout_percent: Some(percent),
    })
}

fn endpoints() -> ContinuationEndpoints {
    match super::sync::resolve_vault_api_url() {
        Ok(base) => ContinuationEndpoints::with_api_base(base),
        // A config read that fails is not a reason to guess. The resolver's own
        // default is the canonical URL, which is where an unconfigured install
        // would have gone anyway.
        Err(_) => ContinuationEndpoints::resolve(),
    }
}

/// Ask the backend whether continuation is on for this installation.
///
/// Every failure mode answers "off". That is not defensive habit — off is the
/// screen that ships today, so it is never worse than the status quo, whereas
/// half-applying a config the build does not understand could change behaviour
/// for a whole fleet on the strength of a typo.
#[tauri::command]
pub async fn desktop_continuation_availability(app: AppHandle) -> ContinuationAvailability {
    // No installation id means no stable rollout bucket. Guessing one would put
    // the same machine on a different side of the line every launch, so the
    // honest answer is off.
    let Some(install_attempt_id) = super::first_run::install_attempt_id() else {
        return disabled(DisabledReason::Unavailable);
    };
    let app_version = app.package_info().version.to_string();

    let response = build_client()
        .get(endpoints().config_url())
        .header("accept", "application/json")
        .send()
        .await;

    let Ok(response) = response else {
        return disabled(DisabledReason::Unavailable);
    };
    if !response.status().is_success() {
        return disabled(DisabledReason::Unavailable);
    }
    let Ok(body) = response.json::<ConfigBody>().await else {
        return disabled(DisabledReason::Unrecognised);
    };
    let Some(config) = parse_config(&body) else {
        return disabled(DisabledReason::Unrecognised);
    };

    match config.decide(&app_version, &install_attempt_id) {
        RolloutDecision::Continue => ContinuationAvailability {
            enabled: true,
            reason: None,
            variant: config.variant.clone(),
        },
        RolloutDecision::Disabled(reason) => disabled(reason),
    }
}

// ── The attempt ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationStarted {
    pub attempt_id: String,
}

/// Begin an attempt: arm the loopback listener and open the system browser.
///
/// Returns as soon as the browser is open. Waiting for the callback is a
/// separate command so a Cancel click is never queued behind a person who
/// wandered off mid-login.
#[tauri::command]
pub async fn desktop_continuation_start(app: AppHandle) -> Result<ContinuationStarted, String> {
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let nonce = hq_desktop_core::oauth::generate_nonce();

    // No identity provider: continuation lets the hosted UI use whichever
    // session the browser already has, which is the entire point — the person
    // signed in there minutes ago.
    let armed = super::oauth::arm_oauth_flow(&app, None, Some(&nonce))?;

    with_custody(|custody| {
        let attempt = ContinuationAttempt::start(
            attempt_id.clone(),
            armed.state.clone(),
            nonce.clone(),
            custody.generation(),
            now_ms(),
        );
        custody.begin(attempt);
    });

    if let Err(error) = app.shell().open(armed.authorize_url.as_str(), None) {
        with_custody(|custody| custody.cancel(&attempt_id, AttemptEnd::Failed));
        return Err(format!("Could not open the browser: {error}"));
    }

    Ok(ContinuationStarted { attempt_id })
}

/// Wait for the callback, exchange the code, verify server-side, and hold.
///
/// Resolves with the identity to put in front of the person. Nothing has been
/// written to disk when this returns.
#[tauri::command]
pub async fn desktop_continuation_await_identity(
    app: AppHandle,
    attempt_id: String,
) -> Result<VerifiedIdentityPayload, String> {
    // Refuse before waiting, so a stale attempt id does not park a task on a
    // listener that belongs to somebody else's attempt.
    let active = with_custody(|custody| {
        custody.tick(now_ms());
        custody.active_attempt_id().map(str::to_string)
    });
    if active.as_deref() != Some(attempt_id.as_str()) {
        return Err(custody_error_code(CustodyError::NoSuchAttempt).to_string());
    }

    // The listener validates the state itself before handing back a code and
    // returns the value it matched. Custody checks it again against the
    // attempt: the two stores can only disagree if something went wrong, and
    // that is exactly when a second check earns its keep.
    let (callback, matched_state) = super::oauth::oauth_listen_for_code_internal(&app).await?;
    with_custody(|custody| custody.accept_callback(&attempt_id, &matched_state, now_ms()))
        .map_err(|error| custody_error_code(error).to_string())?;

    let tokens = super::oauth::exchange_code_for_tokens(&callback.code).await?;

    // Server-side verification. The desktop reading its own claims proves
    // nothing — the backend checks the signature, the audience, and that the
    // subject is a person this deployment knows.
    let identity = verify_with_backend(&tokens).await?;

    let nonce = cognito::decode_id_token_claims(tokens.id_token.as_deref().unwrap_or_default())
        .ok()
        .and_then(|claims| claims.nonce);

    let held = with_custody(|custody| {
        custody.hold(
            &attempt_id,
            nonce.as_deref(),
            PendingCredentials::new(tokens, identity),
            now_ms(),
        )
    })
    .map_err(|error| custody_error_code(error).to_string())?;

    Ok(VerifiedIdentityPayload::from(held))
}

/// The identity a confirmation prompt shows. Nothing replayable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedIdentityPayload {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl From<VerifiedIdentity> for VerifiedIdentityPayload {
    fn from(identity: VerifiedIdentity) -> Self {
        Self {
            email: identity.email,
            display_name: identity.display_name,
        }
    }
}

/// The person pressed **Continue as …**. Persist and sign in.
#[tauri::command]
pub async fn desktop_continuation_confirm(
    app: AppHandle,
    attempt_id: String,
) -> Result<AuthState, String> {
    let credentials = with_custody(|custody| custody.confirm(&attempt_id, now_ms()))
        .map_err(|error| custody_error_code(error).to_string())?;

    // Only now does anything touch the disk. `complete_auth_session` is the
    // same completion the provider-button path runs, so both flows end in one
    // definition of "signed in".
    let tokens: CognitoTokens = credentials.into_tokens();
    let state = super::auth::complete_auth_session(&app, &tokens).await?;

    // The account just changed. Anything still pending is about a question
    // nobody asked any more.
    note_auth_transition(AttemptEnd::Superseded);
    Ok(state)
}

/// **Use another account**, Cancel, or the window going away.
///
/// Idempotent, because the renderer legitimately sends it twice: once from the
/// click and once from component teardown.
#[tauri::command]
pub async fn desktop_continuation_cancel(attempt_id: String) -> Result<(), String> {
    with_custody(|custody| custody.cancel(&attempt_id, AttemptEnd::Cancelled));
    Ok(())
}

// ── Server-side verification ───────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest<'a> {
    id_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyResponse {
    email: Option<String>,
    display_name: Option<String>,
}

/// Ask the backend to verify the ID token and tell us who it is about.
///
/// The desktop decoding its own claims would prove only that the token is
/// well-formed JSON. The signature, the audience, and whether the subject is a
/// person this deployment has ever seen are all questions only the backend can
/// answer, and all three have to be true before a person is shown a name and
/// asked to accept it.
async fn verify_with_backend(tokens: &CognitoTokens) -> Result<VerifiedIdentity, String> {
    let id_token = tokens
        .id_token
        .as_deref()
        .ok_or_else(|| "CONTINUATION_TOKEN_MISMATCH".to_string())?;

    let response = build_client()
        .post(endpoints().session_verify_url())
        .header("authorization", format!("Bearer {}", tokens.access_token))
        .json(&VerifyRequest { id_token })
        .send()
        .await
        .map_err(|_| "CONTINUATION_OFFLINE".to_string())?;

    if !response.status().is_success() {
        // The body may carry a provider message. It is not shown and not
        // logged: an error string from an unauthenticated boundary is
        // attacker-influenced text, and this one has a fixed code instead.
        return Err("CONTINUATION_NOT_VERIFIED".to_string());
    }

    let body: VerifyResponse = response
        .json()
        .await
        .map_err(|_| "CONTINUATION_NOT_VERIFIED".to_string())?;

    let email = body
        .email
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "CONTINUATION_NOT_VERIFIED".to_string())?;

    Ok(VerifiedIdentity {
        email,
        display_name: body
            .display_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}
