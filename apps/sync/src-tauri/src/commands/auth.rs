pub use super::cognito::AuthSessionStatus;
use super::cognito::{
    self, AuthState, CognitoRefreshFailureClass, CognitoTokens, MachineFailure, NonHumanPrincipal,
    TokenSource,
};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager};

pub const AUTH_SESSION_CHANGED_EVENT: &str = "auth:session-changed";
const MAX_AUTH_SESSION_REASON_CHARS: usize = 200;

/// Canonical identity the embedded shell hydrates from. Person UID comes from
/// the vault (same `list_entities_by_type("person")` path as
/// `list_syncable_workspaces`); email / display name come from Cognito claims
/// with a person-name fallback. Never the provisional REST `/v1/identity/whoami`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoAmIIdentity {
    pub person_uid: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Native-to-renderer tenant boundary. The renderer withdraws old tenant
/// state before cloud hydration and never receives bearer material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionEnvelope {
    pub account_id: Option<String>,
    pub generation: u64,
    pub status: AuthSessionStatus,
    pub reason: Option<String>,
}

/// Whether this device can sign in as its outpost, and whether it currently
/// is. Carries no credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentityStatus {
    /// Machine identity is enabled and the machine credentials are readable.
    /// A local opt-out (machine-mode sign-out) does not clear this.
    pub available: bool,
    /// This process is signed in as the outpost right now.
    pub active: bool,
}

static ACTIVE_SESSION_SOURCE: OnceLock<Mutex<Option<TokenSource>>> = OnceLock::new();

fn active_session_source_cell() -> &'static Mutex<Option<TokenSource>> {
    ACTIVE_SESSION_SOURCE.get_or_init(|| Mutex::new(None))
}

/// Record where the active session's tokens come from. Returns true when the
/// source changed, so a transition is logged once and not on every read.
fn set_active_session_source(source: Option<TokenSource>) -> bool {
    let mut guard = active_session_source_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let changed = *guard != source;
    *guard = source;
    changed
}

pub(crate) fn active_session_source() -> Option<TokenSource> {
    *active_session_source_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// True while this device is signed in as its outpost rather than as a
/// person. Person-only flows (invites, person provisioning, pack admin)
/// check this and step aside instead of failing on a missing person entity.
pub(crate) fn machine_session_is_active() -> bool {
    active_session_source() == Some(TokenSource::Machine)
}

static SKIPPED_PERSON_ONLY_CALLS: OnceLock<Mutex<std::collections::BTreeSet<&'static str>>> =
    OnceLock::new();

/// True when a person-only server call must be skipped because this device is
/// signed in as its outpost. hq-pro answers these calls with 403 for an
/// outpost principal (person settings, connection requests, invites by
/// email), so polling them would only log a refusal every cycle. The skip is
/// logged once per call site, never per poll.
pub(crate) fn skip_person_only_call(site: &'static str) -> bool {
    if !machine_session_is_active() {
        return false;
    }
    let cell = SKIPPED_PERSON_ONLY_CALLS.get_or_init(|| Mutex::new(Default::default()));
    let first_time = cell
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(site);
    if first_time {
        eprintln!("[auth] {site} skipped: an outpost session has no person entity");
    }
    true
}

#[cfg(test)]
pub(crate) fn reset_skipped_person_only_calls() {
    if let Some(cell) = SKIPPED_PERSON_ONLY_CALLS.get() {
        cell.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

static AUTH_SESSION_ENVELOPE: OnceLock<Mutex<Option<AuthSessionEnvelope>>> = OnceLock::new();
type AuthSessionDiagnostic = (
    AuthSessionStatus,
    Option<CognitoRefreshFailureClass>,
    &'static str,
);

static AUTH_SESSION_DIAGNOSTIC: OnceLock<Mutex<Option<AuthSessionDiagnostic>>> = OnceLock::new();
static LAST_AUTH_TRANSITION: OnceLock<Mutex<Option<(&'static str, SystemTime)>>> = OnceLock::new();

fn record_last_auth_transition(class: &'static str) {
    let cell = LAST_AUTH_TRANSITION.get_or_init(|| Mutex::new(None));
    *cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((class, SystemTime::now()));
}

pub(crate) fn last_auth_transition_diagnostic() -> (&'static str, u64) {
    let cell = LAST_AUTH_TRANSITION.get_or_init(|| Mutex::new(None));
    cell.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|(class, at)| (*class, at.elapsed().unwrap_or_default().as_secs()))
        .unwrap_or(("none", 0))
}

fn auth_session_envelope_cell() -> &'static Mutex<Option<AuthSessionEnvelope>> {
    AUTH_SESSION_ENVELOPE.get_or_init(|| Mutex::new(None))
}

fn auth_session_diagnostic_cell() -> &'static Mutex<Option<AuthSessionDiagnostic>> {
    AUTH_SESSION_DIAGNOSTIC.get_or_init(|| Mutex::new(None))
}

fn auth_session_status_tag(status: &AuthSessionStatus) -> &'static str {
    match status {
        AuthSessionStatus::Active => "active",
        AuthSessionStatus::CredentialsAbsent => "credentials_absent",
        AuthSessionStatus::CredentialsReadError => "credentials_read_error",
        AuthSessionStatus::CredentialsInvalid => "credentials_invalid",
        AuthSessionStatus::RefreshTemporarilyUnavailable => "refresh_temporarily_unavailable",
        AuthSessionStatus::NonHumanPrincipal => "non_human_principal",
        AuthSessionStatus::MachineUnavailable => "machine_unavailable",
    }
}

fn set_auth_session_diagnostic(
    status: AuthSessionStatus,
    refresh_failure_class: Option<CognitoRefreshFailureClass>,
    rejection_class: &'static str,
) {
    let mut guard = auth_session_diagnostic_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some((status, refresh_failure_class, rejection_class));
}

/// Bounded startup diagnostic labels; this snapshot contains no account
/// identity, token material, email, or free-form error detail.
pub(crate) fn startup_auth_diagnostic_tags() -> (&'static str, &'static str, &'static str) {
    let guard = auth_session_diagnostic_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_ref() {
        Some((status, Some(failure_class), rejection_class)) => (
            auth_session_status_tag(status),
            failure_class.as_tag(),
            *rejection_class,
        ),
        Some((status, None, rejection_class)) => {
            (auth_session_status_tag(status), "none", *rejection_class)
        }
        None => ("unknown", "none", "none"),
    }
}

/// Returns the non-secret identity snapshot for an operation that must retain
/// its original authorizer after work is handed to a background task. This is
/// memory-only: command paths must not reread credential files just to prepare
/// telemetry.
pub(crate) fn active_auth_session_snapshot() -> Option<AuthSessionEnvelope> {
    let guard = auth_session_envelope_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.as_ref().and_then(|session| {
        (session.status == AuthSessionStatus::Active)
            .then_some(session)
            .filter(|session| {
                session
                    .account_id
                    .as_deref()
                    .is_some_and(|account_id| !account_id.trim().is_empty())
            })
            .cloned()
    })
}

fn bounded_reason(reason: Option<&str>) -> Option<String> {
    reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_AUTH_SESSION_REASON_CHARS).collect())
}

fn next_auth_session_envelope(
    previous: Option<&AuthSessionEnvelope>,
    account_id: Option<String>,
    status: AuthSessionStatus,
    reason: Option<&str>,
) -> AuthSessionEnvelope {
    let reason = bounded_reason(reason);
    let unchanged = previous.is_some_and(|current| {
        current.account_id == account_id && current.status == status && current.reason == reason
    });
    AuthSessionEnvelope {
        account_id,
        generation: if unchanged {
            previous.expect("checked above").generation
        } else {
            previous.map_or(1, |current| current.generation.saturating_add(1))
        },
        status,
        reason,
    }
}

pub(crate) fn publish_auth_session(
    app: &AppHandle,
    next: AuthSessionEnvelope,
) -> AuthSessionEnvelope {
    let current = {
        let mut guard = auth_session_envelope_cell()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = next_auth_session_envelope(
            guard.as_ref(),
            next.account_id,
            next.status,
            next.reason.as_deref(),
        );
        let changed = guard.as_ref() != Some(&current);
        *guard = Some(current.clone());
        (current, changed)
    };
    set_auth_session_diagnostic(current.0.status.clone(), None, "none");
    if current.1 {
        // The desktop label is intentional: auth events for the compact main
        // window must not be mistaken for an embedded Work tenant transition.
        let _ = app.emit_to(
            crate::commands::desktop_alt::WINDOW_LABEL,
            AUTH_SESSION_CHANGED_EVENT,
            &current.0,
        );
        // The call window (US-017) binds its identity, its device signing key
        // and its media to one account generation. A sign-out or account
        // switch must reach it directly — it does not observe the Work shell,
        // and a live call must never outlive the account that authorized it.
        // The envelope carries no bearer material, only an account id and a
        // generation, so widening delivery to this second labelled window
        // adds no credential exposure.
        let _ = app.emit_to(
            crate::commands::calls::CALL_WINDOW_LABEL,
            AUTH_SESSION_CHANGED_EVENT,
            &current.0,
        );
    }
    current.0
}

/// Update Sentry's process-wide user context to the Cognito identity carried
/// in `tokens`. Best-effort: a malformed/missing id_token just clears the user
/// rather than failing — Sentry stays useful even when claims parsing breaks.
pub(crate) fn set_sentry_user_from_tokens(tokens: &CognitoTokens) {
    let claims = tokens
        .id_token
        .as_deref()
        .and_then(|tok| cognito::decode_id_token_claims(tok).ok());
    sentry::Hub::main().configure_scope(|scope| match claims {
        Some(c) => scope.set_user(Some(sentry::User {
            id: c.sub.clone(),
            email: c.email.clone(),
            username: Some(c.display_name()),
            ..Default::default()
        })),
        None => scope.set_user(None),
    });
}

pub(crate) fn clear_sentry_user() {
    sentry::Hub::main().configure_scope(|scope| scope.set_user(None));
}

/// Sentry user for an outpost session: the outpost's uid and a fixed
/// `outpost` username. The owner's email is deliberately not attached, so
/// crash reports from an outpost are never filed under a person.
fn set_sentry_user_for_outpost(tokens: &CognitoTokens) {
    let id = outpost_entity_uid(tokens);
    sentry::Hub::main().configure_scope(|scope| {
        scope.set_user(Some(sentry::User {
            id,
            username: Some("outpost".to_string()),
            ..Default::default()
        }))
    });
}

fn claims_in_order<'a>(
    tokens: &'a CognitoTokens,
    id_token_first: bool,
) -> impl Iterator<Item = cognito::IdTokenClaims> + 'a {
    let (first, second) = if id_token_first {
        (tokens.id_token.as_deref(), Some(tokens.access_token.as_str()))
    } else {
        (Some(tokens.access_token.as_str()), tokens.id_token.as_deref())
    };
    [first, second]
        .into_iter()
        .flatten()
        .filter_map(|token| cognito::decode_id_token_claims(token).ok())
}

fn outpost_entity_uid(tokens: &CognitoTokens) -> Option<String> {
    claims_in_order(tokens, true).find_map(|claims| {
        claims
            .entity_uid
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// The owner's email rides on the outpost's access token; the id token only
/// carries the outpost's own `out-…@outposts.hq.computer` address, which is
/// the fallback.
fn outpost_owner_email(tokens: &CognitoTokens) -> Option<String> {
    claims_in_order(tokens, false).find_map(|claims| {
        claims
            .email
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn outpost_display_name(tokens: &CognitoTokens) -> String {
    match outpost_entity_uid(tokens) {
        Some(uid) => format!("Outpost {uid}"),
        None => "Outpost".to_string(),
    }
}

/// Auth state for a session minted from the outpost machine identity. Shown
/// as "Outpost out_…" with the owner's email; no person claims are involved.
pub(crate) fn machine_state_from_tokens(tokens: &CognitoTokens) -> AuthState {
    AuthState {
        authenticated: true,
        expires_at: Some(cognito::expires_at_iso(tokens)),
        account_id: Some(notification_identity_from_tokens(tokens)),
        email: outpost_owner_email(tokens),
        display_name: Some(outpost_display_name(tokens)),
        startup_token_read_result: None,
    }
}

/// `whoami` for an outpost session. The outpost's uid stands in for the
/// person uid so account-partitioned renderer state stays keyed per identity;
/// there is no vault person lookup, because an outpost has no person entity.
fn outpost_identity_from_tokens(tokens: &CognitoTokens) -> Option<WhoAmIIdentity> {
    let uid = outpost_entity_uid(tokens)?;
    Some(WhoAmIIdentity {
        person_uid: uid.clone(),
        email: outpost_owner_email(tokens).unwrap_or_default(),
        display_name: Some(format!("Outpost {uid}")),
    })
}

pub(crate) fn notification_identity_from_tokens(tokens: &CognitoTokens) -> String {
    [
        tokens.id_token.as_deref(),
        Some(tokens.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(notification_identity_from_bearer_token)
    .unwrap_or_else(|| {
        // Fail partition-safe when a malformed legacy token lacks claims:
        // never collapse multiple accounts into one "unknown" cursor key.
        // Cognito refresh tokens are stable for this flow; if one is absent,
        // the access-token fingerprint still isolates the current session.
        let stable_credential = if tokens.refresh_token.trim().is_empty() {
            &tokens.access_token
        } else {
            &tokens.refresh_token
        };
        format!(
            "credential:{}",
            cognito::access_token_fingerprint(stable_credential)
        )
    })
}

/// Extract the account partition from the exact bearer token about to cross a
/// network boundary. Unlike [`notification_identity_from_tokens`], this has no
/// credential fingerprint fallback: an undecodable bearer must never authorize
/// a queued receipt for an account we cannot prove it belongs to.
pub(crate) fn notification_identity_from_bearer_token(token: &str) -> Option<String> {
    cognito::decode_id_token_claims(token)
        .ok()
        .and_then(|claims| claims.sub)
        .filter(|sub| !sub.trim().is_empty())
}

/// Auth state plus the non-secret claims the embedded shell needs to render
/// the signed-in account. Tokens remain native-only.
pub(crate) fn authenticated_state_from_tokens(tokens: &CognitoTokens) -> AuthState {
    let claims = [
        tokens.id_token.as_deref(),
        Some(tokens.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(|token| cognito::decode_id_token_claims(token).ok());
    let email = claims
        .as_ref()
        .and_then(|value| value.email.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let display_name = claims
        .as_ref()
        .map(cognito::IdTokenClaims::display_name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    AuthState {
        authenticated: true,
        expires_at: Some(cognito::expires_at_iso(tokens)),
        account_id: Some(notification_identity_from_tokens(tokens)),
        email,
        display_name,
        startup_token_read_result: None,
    }
}

/// Finish a sign-in.
///
/// Persist the credentials, publish the tenant envelope, and announce the new
/// session. Extracted verbatim from the tail of `oauth_exchange_code` so that
/// browser continuation converges on the *same* completion rather than a second
/// implementation of it — two versions of "you are now signed in" is how one of
/// them quietly stops clearing the previous account's notification session.
///
/// The order is the contract and it is not arbitrary:
///
/// 1. `replace_notification_credentials` invalidates the outgoing notification
///    generation, then writes the token file. Nothing may observe a new token
///    while the previous account's poller is still current.
/// 2. The envelope is published, which is what tells the embedded Work surface
///    to withdraw the old tenant.
/// 3. `auth:session-ready` goes last, because its whole meaning is "the
///    credentials on disk are now durable" — emitting it earlier would invite
///    a re-hydration against a token that had not landed yet.
///
/// Returns the non-secret auth state. No caller ever needs the tokens back.
pub(crate) async fn complete_auth_session(
    app: &AppHandle,
    tokens: &CognitoTokens,
) -> Result<AuthState, String> {
    // Rejected before step 1, so a machine credential is never persisted by a
    // sign-in. `resolve_authoritative_auth_session` still re-checks on every
    // read, because the file can also be written by processes that never come
    // through here.
    if let Some(principal) = cognito::non_human_principal_from_tokens(tokens) {
        return Err(format!(
            "This sign-in belongs to an HQ {}, not to a person. Sign in with your own HQ account.",
            principal.as_str()
        ));
    }

    crate::commands::dm_notify::replace_notification_credentials(app, tokens).await?;
    record_last_auth_transition("sign_in");

    let state = authenticated_state_from_tokens(tokens);
    publish_auth_session(
        app,
        AuthSessionEnvelope {
            account_id: state.account_id.clone(),
            generation: 0,
            status: AuthSessionStatus::Active,
            reason: None,
        },
    );
    // Native credentials are durable before this event goes out. Embedded HQ
    // Work uses this completion edge to re-hydrate account and memberships;
    // the payload contains only the existing non-secret auth state.
    app.emit("auth:session-ready", &state)
        .map_err(|err| err.to_string())?;
    Ok(state)
}

fn oldest_person_entity(
    mut persons: Vec<super::vault_client::EntityInfo>,
) -> Option<super::vault_client::EntityInfo> {
    persons.sort_by(|a, b| match a.created_at.cmp(&b.created_at) {
        std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
        ord => ord,
    });
    persons.into_iter().next()
}

/// Native identity for the desktop shell. Resolves Cognito claims plus the
/// oldest vault person entity — the same working endpoint
/// `list_syncable_workspaces` uses. The provisional REST path
/// `/v1/identity/whoami` does not exist on the real API.
#[tauri::command]
pub async fn whoami(app: AppHandle) -> Result<WhoAmIIdentity, String> {
    let (session, _) = crate::commands::dm_notify::resolve_notification_session_classified(&app)
        .await
        .map_err(|_| "Not signed in".to_string())?;
    let tokens = session.tokens;
    // Signed in as the outpost: the identity comes from the token claims and
    // nothing is looked up in the vault. Core only labels a session `Machine`
    // after confirming it is an outpost, so the refusal below cannot apply.
    if session.source == TokenSource::Machine {
        if let Some(identity) = outpost_identity_from_tokens(&tokens) {
            return Ok(identity);
        }
    }
    // Same gate as `resolve_authoritative_auth_session`, repeated because this
    // command is reachable on its own from the renderer. Without it the person
    // lookup below fails with "no person entity for this account", which reads
    // as a broken account rather than as the wrong principal — and callers that
    // tolerate a whoami failure would carry on rendering the agent as the user.
    if let Some(principal) = cognito::non_human_principal_from_tokens(&tokens) {
        return Err(format!(
            "the credentials saved on this device belong to an HQ {}, not to a person — sign in with your own HQ account",
            principal.as_str()
        ));
    }
    let auth = authenticated_state_from_tokens(&tokens);

    let vault_url = crate::commands::sync::resolve_vault_api_url()
        .map_err(|e| format!("person entity lookup failed: {e}"))?;
    let jwt = crate::commands::sync::resolve_jwt()
        .await
        .map_err(|e| format!("person entity lookup failed: {e}"))?;
    let vault = super::vault_client::VaultClient::new(&vault_url, &jwt);

    let persons = vault
        .list_entities_by_type("person")
        .await
        .map_err(|e| format!("person entity lookup failed: {e}"))?;
    let person = oldest_person_entity(persons).ok_or_else(|| {
        "person entity lookup failed: no person entity for this account".to_string()
    })?;

    let display_name = auth.display_name.or_else(|| {
        person
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });

    Ok(WhoAmIIdentity {
        person_uid: person.uid,
        email: auth.email.unwrap_or_default(),
        display_name,
    })
}

fn signed_out_state() -> AuthState {
    AuthState {
        authenticated: false,
        expires_at: None,
        account_id: None,
        email: None,
        display_name: None,
        startup_token_read_result: None,
    }
}

fn startup_auth_state_result(
    state: AuthState,
    status: &AuthSessionStatus,
) -> Result<AuthState, String> {
    cognito::startup_auth_state_result(state, status)
}

/// Resolve the credential state once, then publish the same non-secret result
/// to the embedded renderer. A refresh transport failure deliberately leaves
/// the stored credential intact and becomes a recoverable state; an invalid
/// refresh is observed after Cognito has invalidated its file and becomes a
/// fail-closed signed-out state.
async fn resolve_authoritative_auth_session(app: &AppHandle) -> (AuthState, AuthSessionEnvelope) {
    let (first_token_read, first_token_read_result) = cognito::get_tokens_with_read_result().await;
    let first_token_read_failed = first_token_read.is_err();
    if first_token_read_failed {
        eprintln!(
            "[auth] startup token-store read failed; auth_session_status=credentials_read_error"
        );
    }
    let before = first_token_read.ok().flatten();
    let outcome = crate::commands::dm_notify::resolve_notification_session_classified(app).await;
    let (state, status, account_id, reason, refresh_failure_class, rejection_class) = match outcome
    {
        // Refuse to adopt a machine identity as the signed-in person. The
        // credential file is shared with the `hq` CLI and with fleet-agent
        // machine credentials, so usable tokens are not evidence of a human
        // sign-in. Checked here rather than only at first sign-in because
        // `get_tokens` re-reads the file on every mtime change: a session that
        // began as a person can be replaced mid-flight by another process.
        //
        // The tokens are deliberately left on disk. They may belong to an agent
        // that is legitimately running on this machine, and deleting another
        // process's credentials to fix our own display is not ours to do.
        Ok((session, _)) => {
            let tokens = session.tokens;
            if before
                .as_ref()
                .is_some_and(|previous| previous.access_token != tokens.access_token)
            {
                record_last_auth_transition("refresh_ok");
            }
            match (
                session.source,
                cognito::non_human_principal_from_tokens(&tokens),
            ) {
                // The outpost machine identity, minted from this device's own
                // machine credentials. Signed in as the outpost, never as a
                // person. Only the machine source may carry an outpost: an
                // outpost token sitting in the person cache is refused below
                // exactly as before.
                (TokenSource::Machine, Some(NonHumanPrincipal::Outpost)) => {
                    if set_active_session_source(Some(TokenSource::Machine)) {
                        eprintln!(
                            "[auth] signed in as the outpost machine identity; source=machine"
                        );
                    }
                    set_sentry_user_for_outpost(&tokens);
                    (
                        machine_state_from_tokens(&tokens),
                        AuthSessionStatus::Active,
                        Some(notification_identity_from_tokens(&tokens)),
                        None,
                        None,
                        "none",
                    )
                }
                (_, Some(principal)) => {
                    set_active_session_source(None);
                    (
                        signed_out_state(),
                        AuthSessionStatus::NonHumanPrincipal,
                        Some(notification_identity_from_tokens(&tokens)),
                        Some(match principal {
                            NonHumanPrincipal::Outpost => {
                                "The HQ credentials saved on this device belong to an outpost, not to a person."
                            }
                            NonHumanPrincipal::Agent => {
                                "The HQ credentials saved on this device belong to a fleet agent, not to a person."
                            }
                        }),
                        None,
                        "none",
                    )
                }
                (_, None) => {
                    set_active_session_source(Some(TokenSource::Person));
                    set_sentry_user_from_tokens(&tokens);
                    let state = authenticated_state_from_tokens(&tokens);
                    (
                        state,
                        AuthSessionStatus::Active,
                        Some(notification_identity_from_tokens(&tokens)),
                        None,
                        None,
                        "none",
                    )
                }
            }
        }
        // The machine identity fallback ran and failed. Checked before the
        // "no credentials saved" arm because `before` is empty in machine
        // mode as well. A mint failure is recoverable and keeps the sign-in
        // screen's outpost action available; a fleet-agent credential is
        // refused the same way as from the person cache.
        Err(error) if error.machine.is_some() => {
            set_active_session_source(None);
            match error.machine {
                Some(MachineFailure::Unavailable) => {
                    eprintln!(
                        "[auth] outpost machine session unavailable; auth_session_status=machine_unavailable"
                    );
                    (
                        signed_out_state(),
                        AuthSessionStatus::MachineUnavailable,
                        None,
                        Some(cognito::MACHINE_UNAVAILABLE_MESSAGE),
                        None,
                        "none",
                    )
                }
                Some(MachineFailure::Refused(Some(NonHumanPrincipal::Agent))) => (
                    signed_out_state(),
                    AuthSessionStatus::NonHumanPrincipal,
                    None,
                    Some(cognito::MACHINE_AGENT_REFUSED_MESSAGE),
                    None,
                    "none",
                ),
                _ => (
                    signed_out_state(),
                    AuthSessionStatus::CredentialsAbsent,
                    None,
                    Some(cognito::MACHINE_PERSON_REFUSED_MESSAGE),
                    None,
                    "none",
                ),
            }
        }
        Err(error) if before.is_none() && (!error.requires_reauth || first_token_read_failed) => {
            set_active_session_source(None);
            let status = cognito::classify_startup_refresh_failure(
                false,
                first_token_read_failed,
                error.requires_reauth,
                false,
            );
            let reason = if first_token_read_failed {
                "HQ Work could not read saved credentials."
            } else {
                "No HQ Work credentials are saved on this device."
            };
            (
                signed_out_state(),
                status,
                None,
                Some(reason),
                error.refresh_failure_class,
                error.rejection_class,
            )
        }
        Err(error) => {
            if error.requires_reauth {
                record_last_auth_transition("refresh_rejected_requires_reauth");
            }
            let after = cognito::get_tokens().await.ok().flatten();
            set_active_session_source(after.as_ref().map(|_| TokenSource::Person));
            let refresh_failure_class = error.refresh_failure_class;
            let preserved_account = before
                .as_ref()
                .or(after.as_ref())
                .map(notification_identity_from_tokens);
            let status = cognito::classify_startup_refresh_failure(
                before.is_some(),
                first_token_read_failed,
                error.requires_reauth,
                after.is_some(),
            );
            if status == AuthSessionStatus::CredentialsInvalid {
                set_active_session_source(None);
                (
                    signed_out_state(),
                    AuthSessionStatus::CredentialsInvalid,
                    preserved_account,
                    Some("Your saved HQ Work credentials are no longer valid."),
                    refresh_failure_class,
                    error.rejection_class,
                )
            } else {
                (
                    after
                        .as_ref()
                        .map(authenticated_state_from_tokens)
                        .unwrap_or_else(signed_out_state),
                    AuthSessionStatus::RefreshTemporarilyUnavailable,
                    preserved_account,
                    Some("HQ Work could not refresh credentials while offline or unavailable."),
                    refresh_failure_class,
                    error.rejection_class,
                )
            }
        }
    };
    let mut state = state;
    state.startup_token_read_result = Some(first_token_read_result.to_string());
    if !state.authenticated {
        clear_sentry_user();
    }
    let envelope = publish_auth_session(
        app,
        AuthSessionEnvelope {
            account_id,
            generation: 0,
            status,
            reason: reason.map(str::to_string),
        },
    );
    set_auth_session_diagnostic(
        envelope.status.clone(),
        refresh_failure_class,
        rejection_class,
    );
    (state, envelope)
}

#[tauri::command]
pub async fn get_auth_state(app: AppHandle) -> Result<AuthState, String> {
    let (state, envelope) = resolve_authoritative_auth_session(&app).await;
    // Onboarding receipts and referrals describe a person's sign-up. An
    // outpost session has neither, so the flush waits for a person session.
    if state.authenticated && active_session_source() != Some(TokenSource::Machine) {
        // A prior process may have stopped between queueing an onboarding
        // receipt and sending it. Retries are native and non-blocking, so the
        // renderer never receives a bearer token or waits on analytics.
        crate::commands::desktop_auth::flush_pending_authenticated_desktop_receipts();
        crate::commands::desktop_auth::flush_pending_desktop_referrals(&app);
    }
    startup_auth_state_result(state, &envelope.status)
}

/// Renderer bootstrap/recovery command. The event is the live transition
/// transport; this command closes the subscription race for a newly mounted
/// webview by returning the latest authoritative envelope.
#[tauri::command]
pub async fn get_auth_session(app: AppHandle) -> Result<AuthSessionEnvelope, String> {
    let (_, envelope) = resolve_authoritative_auth_session(&app).await;
    Ok(envelope)
}

/// Returns true when `~/.hq/cognito-tokens.json` exists and contains a
/// non-empty `accessToken`. The onboarding UI uses this only to choose its
/// friendly reauth copy; `get_auth_state` still validates whether the session
/// is usable and is the sole source of truth for skipping sign-in.
#[tauri::command]
pub async fn has_stored_token() -> Result<bool, String> {
    cognito::has_non_empty_stored_token().await
}

/// Preserve unreadable token-store state for startup diagnostics.
#[tauri::command]
pub async fn get_stored_token_presence() -> String {
    let presence = cognito::stored_token_presence().await;
    hq_desktop_core::unexpected_surface::stored_token_presence_label(presence).to_string()
}

/// Sign out: revoke the refresh token at Cognito (single attempt, 5s bound),
/// then always clear the locally stored Cognito tokens (file + in-memory cache)
/// and reset the Sentry user scope. After this, `get_auth_state` / a relaunch
/// both report unauthenticated — without it, a frontend-only sign-out leaves the
/// token file on disk and the app re-authenticates silently on next launch.
#[tauri::command]
pub async fn sign_out(app: AppHandle) -> Result<(), String> {
    // Before anything else: a browser-continuation attempt that is mid-flight
    // is now about an account this device is deliberately leaving. Its held
    // tokens go unwritten, and a confirmation that arrives afterwards finds
    // nothing to activate. Doing this first means the window in which a
    // confirmation could race the sign-out does not exist.
    crate::commands::desktop_auth::note_auth_transition(
        hq_desktop_core::session_continuation::AttemptEnd::SignedOut,
    );
    let cache_account_id = active_auth_session_snapshot().and_then(|session| session.account_id);
    if machine_session_is_active() {
        // Machine mode: nothing is revoked and nothing is deleted. The
        // outpost's machine credentials and its minted session stay on disk
        // for the CLI and for a later "Use this outpost's identity". This
        // device only records a local opt-out so the next launch shows the
        // sign-in screen instead of signing back in as the outpost.
        record_last_auth_transition("sign_out_machine");
        hq_desktop_core::machine_session::set_opted_out(true)?;
        set_active_session_source(None);
        crate::commands::dm_notify::detach_notification_session(&app).await?;
        crate::commands::dm_mqtt::reset_dm_push_for_auth_session_change();
    } else {
        record_last_auth_transition("sign_out");
        set_active_session_source(None);
        crate::commands::dm_notify::clear_notification_credentials(&app).await?;
        crate::commands::dm_mqtt::reset_dm_push_for_auth_session_change();
    }
    clear_sentry_user();
    // The next account must not inherit this one's plan-limit upload pause.
    crate::commands::uploads_paused::clear(&app);
    // Nor this one's active company: a later connector import or scoped read
    // must never land in the previous account's company.
    if let Some(scope) = app.try_state::<crate::commands::desktop_alt::DesktopSessionScope>() {
        scope.clear();
    }
    publish_auth_session(
        &app,
        AuthSessionEnvelope {
            account_id: None,
            generation: 0,
            status: AuthSessionStatus::CredentialsAbsent,
            reason: Some("Signed out on this device.".to_string()),
        },
    );
    // Publish the new generation before deleting the old partition. A late
    // index build now fails its write guard instead of recreating this folder.
    if let Some(account_id) = cache_account_id {
        crate::commands::vault_explorer::clear_account_cache(&app, &account_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn refresh_tokens(app: AppHandle) -> Result<AuthState, String> {
    let current_tokens = crate::commands::dm_notify::refresh_notification_credentials(&app).await?;
    record_last_auth_transition("refresh_ok");
    let state = if machine_session_is_active() {
        set_sentry_user_for_outpost(&current_tokens);
        machine_state_from_tokens(&current_tokens)
    } else {
        set_sentry_user_from_tokens(&current_tokens);
        authenticated_state_from_tokens(&current_tokens)
    };
    publish_auth_session(
        &app,
        AuthSessionEnvelope {
            account_id: state.account_id.clone(),
            generation: 0,
            status: AuthSessionStatus::Active,
            reason: None,
        },
    );
    Ok(state)
}

/// Whether the sign-in screen should offer "Use this outpost's identity".
#[tauri::command]
pub async fn get_machine_identity_status() -> MachineIdentityStatus {
    use hq_desktop_core::machine_session;
    MachineIdentityStatus {
        available: machine_session::machine_identity_enabled()
            && machine_session::machine_creds_readable(),
        active: machine_session_is_active(),
    }
}

/// "Use this outpost's identity" on the sign-in screen. Clears the local
/// opt-out and resolves the session again. A valid person session keeps
/// winning. A revoked person session is signed out first, with today's
/// sign-out semantics (revoke and clear), so the machine fallback can run. A
/// person session that merely cannot be checked right now is left alone.
#[tauri::command]
pub async fn use_machine_identity(app: AppHandle) -> Result<AuthSessionEnvelope, String> {
    use hq_desktop_core::machine_session;
    if !machine_session::machine_identity_enabled() || !machine_session::machine_creds_readable()
    {
        return Err("This device has no outpost identity.".to_string());
    }
    machine_session::set_opted_out(false)?;
    if cognito::get_tokens().await?.is_some() {
        match cognito::resolve_session_classified(false).await {
            Ok(_) => {}
            Err(error) if error.requires_reauth => {
                crate::commands::dm_notify::clear_notification_credentials(&app).await?;
                record_last_auth_transition("sign_out");
            }
            Err(error) if error.refresh_failure_class.is_some() => {
                return Err("Your saved sign-in could not be checked. Try again.".to_string());
            }
            Err(_) => {}
        }
    }
    let (_, envelope) = resolve_authoritative_auth_session(&app).await;
    Ok(envelope)
}

/// Clear this device's stale session and open the desktop workspace so the
/// user can sign in there. The compact popover is not the sign-in surface.
#[tauri::command]
pub async fn begin_reauth(app: tauri::AppHandle) -> Result<(), String> {
    sign_out(app.clone()).await?;
    let _ = app.emit("auth:reauth-required", ());
    crate::commands::desktop_alt::open_desktop_alt_window_inner(app, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_command_does_not_conclude_signed_out_for_temporary_refresh_failure() {
        let result = startup_auth_state_result(
            signed_out_state(),
            &AuthSessionStatus::RefreshTemporarilyUnavailable,
        );

        assert!(
            result.is_err(),
            "a saved session with a transient refresh failure must reach the renderer retry path"
        );
    }

    #[test]
    fn temporary_refresh_failure_keeps_a_stored_session_authenticated() {
        let tokens = cognito::CognitoTokens {
            access_token: "expired-access".to_string(),
            id_token: None,
            refresh_token: "refresh".to_string(),
            expires_at: 0,
        };
        let state = authenticated_state_from_tokens(&tokens);
        assert!(state.authenticated);
        assert!(startup_auth_state_result(
            state,
            &AuthSessionStatus::RefreshTemporarilyUnavailable,
        )
        .is_err(), "the renderer gets the temporary-retry surface while the session stays authenticated");
    }

    #[test]
    fn startup_command_still_concludes_signed_out_for_invalid_credentials() {
        let result =
            startup_auth_state_result(signed_out_state(), &AuthSessionStatus::CredentialsInvalid)
                .expect("definitively invalid credentials should allow sign-in");

        assert!(!result.authenticated);
    }

    #[test]
    fn token_store_read_error_uses_a_distinct_diagnostic_tag() {
        assert_eq!(
            auth_session_status_tag(&AuthSessionStatus::CredentialsReadError),
            "credentials_read_error"
        );
    }

    #[test]
    fn machine_unavailable_uses_a_distinct_diagnostic_tag() {
        assert_eq!(
            auth_session_status_tag(&AuthSessionStatus::MachineUnavailable),
            "machine_unavailable"
        );
    }

    #[test]
    fn machine_unavailable_still_reaches_the_sign_in_screen() {
        let result = startup_auth_state_result(
            signed_out_state(),
            &AuthSessionStatus::MachineUnavailable,
        )
        .expect("a failed outpost mint shows sign-in with the outpost action, not a retry loop");
        assert!(!result.authenticated);
    }

    fn outpost_tokens() -> CognitoTokens {
        tokens(
            Some(jwt_with_claims(serde_json::json!({
                "sub": "outpost-sub",
                "email": "out-01abc@outposts.hq.computer",
                "custom:entityType": "outpost",
                "custom:entityUid": "out_01ABC",
            }))),
            jwt_with_claims(serde_json::json!({
                "sub": "outpost-sub",
                "email": "owner@example.com",
            })),
            "",
        )
    }

    #[test]
    fn outpost_session_shows_the_outpost_name_and_the_owner_email() {
        let state = machine_state_from_tokens(&outpost_tokens());
        assert!(state.authenticated);
        assert_eq!(state.display_name.as_deref(), Some("Outpost out_01ABC"));
        assert_eq!(state.email.as_deref(), Some("owner@example.com"));
        assert_eq!(state.account_id.as_deref(), Some("outpost-sub"));
    }

    #[test]
    fn outpost_identity_needs_no_person_entity() {
        let identity = outpost_identity_from_tokens(&outpost_tokens()).expect("outpost identity");
        assert_eq!(identity.person_uid, "out_01ABC");
        assert_eq!(identity.email, "owner@example.com");
        assert_eq!(identity.display_name.as_deref(), Some("Outpost out_01ABC"));
        assert!(
            outpost_identity_from_tokens(&tokens(None, jwt_with_sub("person"), "r")).is_none(),
            "a person token has no outpost uid"
        );
    }

    #[test]
    fn outpost_owner_email_falls_back_to_the_outpost_address() {
        let only_id_token = tokens(
            Some(jwt_with_claims(serde_json::json!({
                "sub": "outpost-sub",
                "email": "out-01abc@outposts.hq.computer",
                "custom:entityType": "outpost",
                "custom:entityUid": "out_01ABC",
            }))),
            jwt_with_sub("outpost-sub"),
            "",
        );
        assert_eq!(
            machine_state_from_tokens(&only_id_token).email.as_deref(),
            Some("out-01abc@outposts.hq.computer")
        );
    }

    #[test]
    fn session_source_tracking_reports_each_transition_once() {
        let _serial = SOURCE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_active_session_source(None);
        assert!(!machine_session_is_active());
        assert!(set_active_session_source(Some(TokenSource::Machine)));
        assert!(machine_session_is_active());
        assert!(!set_active_session_source(Some(TokenSource::Machine)));
        assert!(set_active_session_source(Some(TokenSource::Person)));
        assert!(!machine_session_is_active());
        assert!(set_active_session_source(None));
    }

    static SOURCE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn person_only_calls_run_for_a_person_and_are_skipped_for_an_outpost() {
        let _serial = SOURCE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_skipped_person_only_calls();
        set_active_session_source(Some(TokenSource::Person));
        assert!(!skip_person_only_call("test-site"));
        set_active_session_source(None);
        assert!(!skip_person_only_call("test-site"));

        set_active_session_source(Some(TokenSource::Machine));
        assert!(skip_person_only_call("test-site"));
        // The second skip of the same site is still a skip; the once-per-site
        // log is bookkeeping only.
        assert!(skip_person_only_call("test-site"));
        assert!(skip_person_only_call("another-site"));

        set_active_session_source(None);
        reset_skipped_person_only_calls();
    }

    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn jwt_with_sub(subject: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({ "sub": subject })).expect("claims serialize"),
        );
        format!("header.{payload}.signature")
    }

    fn jwt_with_profile(subject: &str, email: &str, name: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "sub": subject,
                "email": email,
                "name": name,
            }))
            .expect("claims serialize"),
        );
        format!("header.{payload}.signature")
    }

    fn tokens(
        id_token: Option<String>,
        access_token: String,
        refresh_token: &str,
    ) -> CognitoTokens {
        CognitoTokens {
            access_token,
            id_token,
            refresh_token: refresh_token.to_string(),
            expires_at: i64::MAX,
        }
    }

    fn jwt_with_claims(payload: serde_json::Value) -> String {
        let encoded =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("claims serialize"));
        format!("header.{encoded}.signature")
    }

    /// The reported incident, reduced: an agent's token in the shared
    /// credential file must not produce a signed-in human session.
    #[test]
    fn agent_credentials_do_not_authenticate_a_person() {
        let tokens = tokens(
            Some(jwt_with_claims(serde_json::json!({
                "sub": "cognito-sub",
                "email": "agt-01m2jygtfssyg85057nwvskth6@agents.getindigo.ai",
                "custom:entityType": "agent",
                "custom:entityUid": "agt_01M2JYGTFSSYG85057NWVSKTH6",
            }))),
            jwt_with_sub("access-subject"),
            "refresh-a",
        );

        assert_eq!(
            cognito::non_human_principal_from_tokens(&tokens),
            Some(cognito::NonHumanPrincipal::Agent)
        );
    }

    #[test]
    fn person_credentials_still_authenticate() {
        let tokens = tokens(
            Some(jwt_with_profile(
                "cognito-sub-ben",
                "ben@yoprettyboy.com",
                "Ben",
            )),
            jwt_with_sub("access-subject"),
            "refresh-a",
        );

        assert_eq!(cognito::non_human_principal_from_tokens(&tokens), None);
        let state = authenticated_state_from_tokens(&tokens);
        assert!(state.authenticated);
        assert_eq!(state.email.as_deref(), Some("ben@yoprettyboy.com"));
    }

    #[test]
    fn notification_identity_prefers_id_token_subject() {
        let tokens = tokens(
            Some(jwt_with_sub("id-subject")),
            jwt_with_sub("access-subject"),
            "refresh-a",
        );

        assert_eq!(notification_identity_from_tokens(&tokens), "id-subject");
    }

    #[test]
    fn bearer_identity_never_falls_back_for_an_undecodable_token() {
        assert_eq!(
            notification_identity_from_bearer_token(&jwt_with_sub("access-subject")),
            Some("access-subject".to_string()),
        );
        assert_eq!(notification_identity_from_bearer_token("not-a-jwt"), None);
    }

    #[test]
    fn authenticated_state_exposes_non_secret_profile_claims_to_the_webview() {
        let tokens = tokens(
            Some(jwt_with_profile(
                "cognito-sub-ada",
                "ada@getindigo.ai",
                "Ada Lovelace",
            )),
            jwt_with_sub("access-subject"),
            "refresh-a",
        );

        let state = authenticated_state_from_tokens(&tokens);

        assert!(state.authenticated);
        assert_eq!(state.account_id.as_deref(), Some("cognito-sub-ada"));
        assert_eq!(state.email.as_deref(), Some("ada@getindigo.ai"));
        assert_eq!(state.display_name.as_deref(), Some("Ada Lovelace"));
    }

    #[test]
    fn whoami_identity_serializes_camel_case_and_omits_empty_display_name() {
        let named = serde_json::to_value(&WhoAmIIdentity {
            person_uid: "prs_1".to_string(),
            email: "a@b.c".to_string(),
            display_name: Some("Ada".to_string()),
        })
        .expect("serialize named");
        assert_eq!(named["personUid"], "prs_1");
        assert_eq!(named["email"], "a@b.c");
        assert_eq!(named["displayName"], "Ada");

        let unnamed = serde_json::to_value(&WhoAmIIdentity {
            person_uid: "prs_1".to_string(),
            email: String::new(),
            display_name: None,
        })
        .expect("serialize unnamed");
        assert_eq!(unnamed["personUid"], "prs_1");
        assert_eq!(unnamed["email"], "");
        assert!(unnamed.get("displayName").is_none());
    }

    fn person_entity(
        uid: &str,
        created_at: &str,
        name: Option<&str>,
    ) -> super::super::vault_client::EntityInfo {
        super::super::vault_client::EntityInfo {
            uid: uid.to_string(),
            slug: uid.to_string(),
            entity_type: "person".to_string(),
            name: name.map(str::to_string),
            bucket_name: None,
            status: "active".to_string(),
            created_at: created_at.to_string(),
            deleted: false,
            cloud_activated_at: None,
        }
    }

    #[test]
    fn oldest_person_entity_sorts_by_created_at_then_uid() {
        let older = person_entity("prs_b", "2024-01-01T00:00:00Z", Some("B"));
        let newer = person_entity("prs_a", "2025-01-01T00:00:00Z", Some("A"));
        let picked = oldest_person_entity(vec![newer, older]).expect("pick");
        assert_eq!(picked.uid, "prs_b");

        let first = person_entity("prs_a", "2024-01-01T00:00:00Z", None);
        let second = person_entity("prs_b", "2024-01-01T00:00:00Z", None);
        let tied = oldest_person_entity(vec![second, first]).expect("tie-break");
        assert_eq!(tied.uid, "prs_a");
    }

    #[test]
    fn notification_identity_uses_access_subject_when_refresh_omits_id_token() {
        let tokens = tokens(None, jwt_with_sub("access-subject"), "refresh-a");

        assert_eq!(notification_identity_from_tokens(&tokens), "access-subject");
    }

    #[test]
    fn malformed_claims_get_stable_partitioned_credential_fallbacks() {
        let first = tokens(None, "malformed-a".to_string(), "refresh-a");
        let refreshed = tokens(None, "malformed-b".to_string(), "refresh-a");
        let other_account = tokens(None, "malformed-c".to_string(), "refresh-b");

        assert_eq!(
            notification_identity_from_tokens(&first),
            notification_identity_from_tokens(&refreshed),
            "access-token rotation must not change the account partition"
        );
        assert_ne!(
            notification_identity_from_tokens(&first),
            notification_identity_from_tokens(&other_account),
            "different accounts must never collapse into one fallback partition"
        );
    }

    #[test]
    fn auth_session_envelope_rotates_only_for_identity_or_status_transitions() {
        let first = next_auth_session_envelope(
            None,
            Some("acct-a".to_string()),
            AuthSessionStatus::Active,
            None,
        );
        let same = next_auth_session_envelope(
            Some(&first),
            Some("acct-a".to_string()),
            AuthSessionStatus::Active,
            None,
        );
        let transient = next_auth_session_envelope(
            Some(&same),
            Some("acct-a".to_string()),
            AuthSessionStatus::RefreshTemporarilyUnavailable,
            Some(&"x".repeat(250)),
        );
        let switched = next_auth_session_envelope(
            Some(&transient),
            Some("acct-b".to_string()),
            AuthSessionStatus::Active,
            None,
        );

        assert_eq!(first.generation, 1);
        assert_eq!(same.generation, first.generation);
        assert_eq!(transient.generation, first.generation + 1);
        assert_eq!(switched.generation, transient.generation + 1);
        assert_eq!(transient.reason.as_deref().map(str::len), Some(200));
    }

    #[test]
    fn no_id_token_keeps_the_access_token_subject_in_the_auth_envelope() {
        let tokens = tokens(None, jwt_with_sub("access-subject"), "refresh-a");
        let envelope = next_auth_session_envelope(
            None,
            Some(notification_identity_from_tokens(&tokens)),
            AuthSessionStatus::Active,
            None,
        );

        assert_eq!(envelope.account_id.as_deref(), Some("access-subject"));
        assert_eq!(envelope.status, AuthSessionStatus::Active);
    }

    #[test]
    fn successful_expired_token_refresh_keeps_the_same_account_generation() {
        let expired = tokens(None, jwt_with_sub("access-subject"), "refresh-a");
        let refreshed = tokens(None, jwt_with_sub("access-subject"), "refresh-a");
        let before = next_auth_session_envelope(
            None,
            Some(notification_identity_from_tokens(&expired)),
            AuthSessionStatus::Active,
            None,
        );
        let after = next_auth_session_envelope(
            Some(&before),
            Some(notification_identity_from_tokens(&refreshed)),
            AuthSessionStatus::Active,
            None,
        );

        assert_eq!(after.account_id, before.account_id);
        assert_eq!(after.generation, before.generation);
    }

    #[test]
    fn terminal_and_transient_refresh_failures_are_distinct_session_states() {
        let active = next_auth_session_envelope(
            None,
            Some("account-a".to_string()),
            AuthSessionStatus::Active,
            None,
        );
        let transient = next_auth_session_envelope(
            Some(&active),
            Some("account-a".to_string()),
            AuthSessionStatus::RefreshTemporarilyUnavailable,
            Some("network unavailable"),
        );
        let invalid = next_auth_session_envelope(
            Some(&transient),
            Some("account-a".to_string()),
            AuthSessionStatus::CredentialsInvalid,
            Some("refresh rejected"),
        );

        assert_eq!(transient.generation, active.generation + 1);
        assert_eq!(invalid.generation, transient.generation + 1);
        assert_eq!(
            transient.status,
            AuthSessionStatus::RefreshTemporarilyUnavailable
        );
        assert_eq!(invalid.status, AuthSessionStatus::CredentialsInvalid);
    }
}
