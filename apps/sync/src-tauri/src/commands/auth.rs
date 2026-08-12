use super::cognito::{self, AuthState, CognitoTokens};
use tauri::{AppHandle, Emitter};

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

#[tauri::command]
pub async fn get_auth_state(app: AppHandle) -> Result<AuthState, String> {
    match crate::commands::dm_notify::resolve_notification_credentials(&app).await {
        Ok((tokens, _)) => {
            set_sentry_user_from_tokens(&tokens);
            Ok(AuthState {
                authenticated: true,
                expires_at: Some(cognito::expires_at_iso(&tokens)),
            })
        }
        Err(_) => {
            clear_sentry_user();
            Ok(AuthState {
                authenticated: false,
                expires_at: None,
            })
        }
    }
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
    Ok(())
}

#[tauri::command]
pub async fn refresh_tokens(app: AppHandle) -> Result<AuthState, String> {
    let current_tokens = crate::commands::dm_notify::refresh_notification_credentials(&app).await?;
    let iso = cognito::expires_at_iso(&current_tokens);
    set_sentry_user_from_tokens(&current_tokens);

    Ok(AuthState {
        authenticated: true,
        expires_at: Some(iso),
    })
}

/// Clear this device's stale session and take the user straight to the
/// provider buttons in the compact popover. This is the desktop Home/titlebar
/// one-click bridge into the existing OAuth flow.
#[tauri::command]
pub async fn begin_reauth(app: tauri::AppHandle) -> Result<(), String> {
    sign_out(app.clone()).await?;
    app.emit_to("main", "auth:reauth-required", ())
        .map_err(|err| err.to_string())?;

    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        crate::tray::show_popover_window(&app_for_main);
    })
    .map_err(|err| err.to_string())?;
    Ok(())
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
}
