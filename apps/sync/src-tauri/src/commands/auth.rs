use super::cognito::{self, AuthState, CognitoTokens};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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

pub const AUTH_SESSION_CHANGED_EVENT: &str = "auth:session-changed";
const MAX_AUTH_SESSION_REASON_CHARS: usize = 200;

/// Native-to-renderer tenant boundary. This is deliberately independent of a
/// `/whoami` request: the renderer must withdraw old tenant state before it
/// begins any cloud hydration, and it must never see bearer material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthSessionStatus {
    Active,
    CredentialsAbsent,
    CredentialsInvalid,
    RefreshTemporarilyUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionEnvelope {
    pub account_id: Option<String>,
    pub generation: u64,
    pub status: AuthSessionStatus,
    pub reason: Option<String>,
}

static AUTH_SESSION_ENVELOPE: OnceLock<Mutex<Option<AuthSessionEnvelope>>> = OnceLock::new();

fn auth_session_envelope_cell() -> &'static Mutex<Option<AuthSessionEnvelope>> {
    AUTH_SESSION_ENVELOPE.get_or_init(|| Mutex::new(None))
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
    if current.1 {
        // The desktop label is intentional: auth events for the compact main
        // window must not be mistaken for an embedded Work tenant transition.
        let _ = app.emit_to(
            crate::commands::desktop_alt::WINDOW_LABEL,
            AUTH_SESSION_CHANGED_EVENT,
            &current.0,
        );
    }
    current.0
}

/// Update Sentry's scoped user context to the Cognito identity carried in
/// `tokens`. Best-effort: a malformed/missing id_token just clears the user
/// rather than failing — Sentry stays useful even when claims parsing breaks.
fn set_sentry_user_from_tokens(tokens: &CognitoTokens) {
    let claims = tokens
        .id_token
        .as_deref()
        .and_then(|tok| cognito::decode_id_token_claims(tok).ok());
    sentry::configure_scope(|scope| match claims {
        Some(c) => scope.set_user(Some(sentry::User {
            id: c.sub.clone(),
            email: c.email.clone(),
            username: Some(c.display_name()),
            ..Default::default()
        })),
        None => scope.set_user(None),
    });
}

fn clear_sentry_user() {
    sentry::configure_scope(|scope| scope.set_user(None));
}

pub(crate) fn notification_identity_from_tokens(tokens: &CognitoTokens) -> String {
    [
        tokens.id_token.as_deref(),
        Some(tokens.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(|token| {
        cognito::decode_id_token_claims(token)
            .ok()
            .and_then(|claims| claims.sub)
    })
    .filter(|sub| !sub.trim().is_empty())
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
    }
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
    let (tokens, _) = crate::commands::dm_notify::resolve_notification_credentials(&app)
        .await
        .map_err(|_| "Not signed in".to_string())?;
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
    }
}

/// Resolve the credential state once, then publish the same non-secret result
/// to the embedded renderer. A refresh transport failure deliberately leaves
/// the stored credential intact and becomes a recoverable state; an invalid
/// refresh is observed after Cognito has invalidated its file and becomes a
/// fail-closed signed-out state.
async fn resolve_authoritative_auth_session(app: &AppHandle) -> (AuthState, AuthSessionEnvelope) {
    let before = cognito::get_tokens().await.ok().flatten();
    let outcome = crate::commands::dm_notify::resolve_notification_credentials(app).await;
    let (state, status, account_id, reason) = match outcome {
        Ok((tokens, _)) => {
            set_sentry_user_from_tokens(&tokens);
            let state = authenticated_state_from_tokens(&tokens);
            (
                state,
                AuthSessionStatus::Active,
                Some(notification_identity_from_tokens(&tokens)),
                None,
            )
        }
        Err(_) if before.is_none() => (
            signed_out_state(),
            AuthSessionStatus::CredentialsAbsent,
            None,
            Some("No HQ Work credentials are saved on this device."),
        ),
        Err(_) => {
            let after = cognito::get_tokens().await.ok().flatten();
            let preserved_account = before
                .as_ref()
                .or(after.as_ref())
                .map(notification_identity_from_tokens);
            if after.is_none() {
                (
                    signed_out_state(),
                    AuthSessionStatus::CredentialsInvalid,
                    preserved_account,
                    Some("Your saved HQ Work credentials are no longer valid."),
                )
            } else {
                (
                    signed_out_state(),
                    AuthSessionStatus::RefreshTemporarilyUnavailable,
                    preserved_account,
                    Some("HQ Work could not refresh credentials while offline or unavailable."),
                )
            }
        }
    };
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
    (state, envelope)
}

#[tauri::command]
pub async fn get_auth_state(app: AppHandle) -> Result<AuthState, String> {
    let (state, _) = resolve_authoritative_auth_session(&app).await;
    Ok(state)
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

/// Sign out: clear the locally stored Cognito tokens (file + in-memory cache)
/// and reset the Sentry user scope. After this, `get_auth_state` / a relaunch
/// both report unauthenticated — without it, a frontend-only sign-out leaves the
/// token file on disk and the app re-authenticates silently on next launch.
#[tauri::command]
pub async fn sign_out(app: AppHandle) -> Result<(), String> {
    crate::commands::dm_notify::clear_notification_credentials(&app).await?;
    clear_sentry_user();
    publish_auth_session(
        &app,
        AuthSessionEnvelope {
            account_id: None,
            generation: 0,
            status: AuthSessionStatus::CredentialsAbsent,
            reason: Some("Signed out on this device.".to_string()),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn refresh_tokens(app: AppHandle) -> Result<AuthState, String> {
    let current_tokens = crate::commands::dm_notify::refresh_notification_credentials(&app).await?;
    set_sentry_user_from_tokens(&current_tokens);
    let state = authenticated_state_from_tokens(&current_tokens);
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
