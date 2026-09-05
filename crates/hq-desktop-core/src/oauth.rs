use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

pub const REDIRECT_URI: &str = "http://localhost:53682/callback";
const COGNITO_CLIENT_ID_MAX_LEN: usize = 128;
const COGNITO_DOMAIN_PREFIX_MAX_LEN: usize = 63;

fn resolve_cognito_client_id(override_value: Option<&str>) -> Result<&str, String> {
    let Some(raw_value) = override_value else {
        return Err("HQ_COGNITO_CLIENT_ID is required for this non-production release".to_string());
    };
    let value = raw_value.trim();
    if value.is_empty() {
        return Err("HQ_COGNITO_CLIENT_ID is set but empty".to_string());
    }
    if value.len() > COGNITO_CLIENT_ID_MAX_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+'))
    {
        return Err(
            "HQ_COGNITO_CLIENT_ID must be 1-128 ASCII letters, digits, underscores, or plus signs"
                .to_string(),
        );
    }
    Ok(value)
}

/// Cognito app client used by authorization, code exchange, and token refresh.
///
/// Non-production runs must set `HQ_COGNITO_CLIENT_ID` before the process starts.
/// Keeping resolution here prevents the OAuth and refresh paths from drifting
/// onto different clients.
pub fn cognito_client_id() -> Result<String, String> {
    match std::env::var("HQ_COGNITO_CLIENT_ID") {
        Ok(override_value) => resolve_cognito_client_id(Some(&override_value)).map(str::to_owned),
        Err(std::env::VarError::NotPresent) => resolve_cognito_client_id(None).map(str::to_owned),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("HQ_COGNITO_CLIENT_ID must contain valid UTF-8".to_string())
        }
    }
}

/// Cognito hosted-UI domain prefix.
///
/// This non-production release intentionally has no production fallback.
/// Always in the `us-east-1.amazoncognito.com` namespace — custom domains are
/// not yet supported.
pub fn cognito_domain_prefix() -> Result<String, String> {
    match std::env::var("HQ_COGNITO_DOMAIN") {
        Ok(value) => resolve_cognito_domain_prefix(Some(&value)).map(str::to_owned),
        Err(std::env::VarError::NotPresent) => {
            resolve_cognito_domain_prefix(None).map(str::to_owned)
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("HQ_COGNITO_DOMAIN must contain valid UTF-8".to_string())
        }
    }
}

fn resolve_cognito_domain_prefix(override_value: Option<&str>) -> Result<&str, String> {
    let Some(raw_value) = override_value else {
        return Err("HQ_COGNITO_DOMAIN is required for this non-production release".to_string());
    };
    let value = raw_value.trim();
    if value.is_empty() {
        return Err("HQ_COGNITO_DOMAIN is set but empty".to_string());
    }
    if value.len() > COGNITO_DOMAIN_PREFIX_MAX_LEN
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(
            "HQ_COGNITO_DOMAIN must be a valid lowercase Cognito domain prefix".to_string(),
        );
    }
    Ok(value)
}

pub fn cognito_authorize_url() -> Result<String, String> {
    Ok(format!(
        "https://{}.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        cognito_domain_prefix()?
    ))
}

pub fn cognito_token_url() -> Result<String, String> {
    Ok(format!(
        "https://{}.auth.us-east-1.amazoncognito.com/oauth2/token",
        cognito_domain_prefix()?
    ))
}

pub fn cognito_identity_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "Google" => Ok("Google"),
        "Microsoft" => Ok("MicrosoftPersonal"),
        _ => Err(format!("Unsupported sign-in provider: {provider}")),
    }
}

pub fn build_authorize_url(
    state: &str,
    challenge: &str,
    identity_provider: &str,
) -> Result<String, String> {
    Ok(build_authorize_url_for_client(
        state,
        challenge,
        identity_provider,
        &cognito_client_id()?,
        &cognito_authorize_url()?,
    ))
}

fn build_authorize_url_for_client(
    state: &str,
    challenge: &str,
    identity_provider: &str,
    client_id: &str,
    authorize_url: &str,
) -> String {
    format!(
        "{base}?response_type=code\
         &client_id={client_id}\
         &redirect_uri={redirect_uri}\
         &scope=openid+email+profile\
         &identity_provider={identity_provider}\
         &state={state}\
         &code_challenge={challenge}\
         &code_challenge_method=S256",
        base = authorize_url,
        client_id = client_id,
        redirect_uri = REDIRECT_URI,
        identity_provider = identity_provider,
        state = state,
        challenge = challenge,
    )
}

/// Generate a PKCE code verifier (43–128 characters, URL-safe).
/// Uses uuid::Uuid::new_v4 to avoid adding `rand` as a dependency.
pub fn generate_code_verifier() -> String {
    // 3 UUIDs = 96 hex chars after removing hyphens. We take the first 64
    // characters, well within the 43–128 range.
    let raw = format!(
        "{}{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple(),
    );
    // UUID simple format is hex (0-9a-f) which is URL-safe.
    raw[..64].to_string()
}

/// Compute the S256 code challenge: BASE64URL(SHA256(verifier)).
pub fn compute_code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn parse_callback(request: &str) -> Option<(String, String, Option<String>)> {
    let first_line = request.lines().next()?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    if method != "GET" {
        return None;
    }
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v_decoded = urldecode(v);
        match k {
            "code" => code = Some(v_decoded),
            "state" => state = Some(v_decoded),
            "error" => error = Some(v_decoded),
            _ => {}
        }
    }
    match (code, state, error) {
        (Some(c), Some(s), err) => Some((c, s, err)),
        _ => None,
    }
}

pub fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let req = "GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let (code, state, err) = parse_callback(req).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
        assert!(err.is_none());
    }

    #[test]
    fn parse_callback_captures_error() {
        let req = "GET /callback?code=x&state=y&error=access_denied HTTP/1.1\r\n\r\n";
        let (_, _, err) = parse_callback(req).unwrap();
        assert_eq!(err.as_deref(), Some("access_denied"));
    }

    #[test]
    fn parse_callback_rejects_non_get() {
        let req = "POST /callback?code=x&state=y HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn parse_callback_ignores_non_callback_paths() {
        let req = "GET /favicon.ico HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn urldecode_handles_percent_and_plus() {
        assert_eq!(urldecode("hello+world"), "hello world");
        assert_eq!(urldecode("a%20b"), "a b");
        assert_eq!(urldecode("plain"), "plain");
    }

    #[test]
    fn code_verifier_length_is_valid() {
        let verifier = generate_code_verifier();
        assert_eq!(verifier.len(), 64);
        // Must be in the 43–128 range per PKCE spec
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
    }

    #[test]
    fn code_verifier_is_url_safe() {
        let verifier = generate_code_verifier();
        // UUID simple format is hex (0-9a-f), all URL-safe
        assert!(verifier.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn code_verifier_is_random() {
        let v1 = generate_code_verifier();
        let v2 = generate_code_verifier();
        assert_ne!(v1, v2);
    }

    #[test]
    fn code_challenge_is_base64url_sha256() {
        // Known test vector: SHA256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
        // base64url of that = n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg
        let challenge = compute_code_challenge("test");
        assert_eq!(challenge, "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg");
    }

    #[test]
    fn code_challenge_has_no_padding() {
        let challenge = compute_code_challenge("hello");
        assert!(!challenge.contains('='));
    }

    #[test]
    fn authorize_url_contains_required_params() {
        // We can't call the async command directly in a sync test, so test
        // the URL construction logic inline.
        let state = "test-state-123";
        let verifier = generate_code_verifier();
        let challenge = compute_code_challenge(&verifier);

        let url = build_authorize_url_for_client(
            state,
            &challenge,
            "Google",
            "nonproductionclient",
            "https://nonproduction.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        );

        assert!(url.starts_with(
            "https://nonproduction.auth.us-east-1.amazoncognito.com/oauth2/authorize?"
        ));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=nonproductionclient"));
        assert!(
            url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback")
                || url.contains("redirect_uri=http://localhost:53682/callback")
        );
        assert!(url.contains("scope=openid+email+profile"));
        assert!(url.contains("identity_provider=Google"));
        assert!(url.contains(&format!("state={state}")));
        assert!(url.contains(&format!("code_challenge={challenge}")));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn cognito_client_override_is_trimmed_and_used_in_authorize_url() {
        assert_eq!(
            resolve_cognito_client_id(Some("  nonproductionclient  ")).unwrap(),
            "nonproductionclient"
        );
        assert!(resolve_cognito_client_id(None).is_err());

        let url = build_authorize_url_for_client(
            "state-123",
            "challenge-123",
            "Google",
            "nonproductionclient",
            "https://nonproduction.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        );
        assert!(url.contains("client_id=nonproductionclient"));
    }

    #[test]
    fn cognito_domain_override_is_required_and_validated() {
        assert!(resolve_cognito_domain_prefix(None).is_err());
        assert_eq!(
            resolve_cognito_domain_prefix(Some("  nonproduction-auth  ")).unwrap(),
            "nonproduction-auth"
        );
        for invalid in ["", "UPPERCASE", "-leading", "trailing-", "has.dot"] {
            assert!(
                resolve_cognito_domain_prefix(Some(invalid)).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn cognito_client_override_rejects_empty_or_malformed_values() {
        assert!(resolve_cognito_client_id(Some("  ")).is_err());
        assert!(resolve_cognito_client_id(Some("client-id")).is_err());
        assert!(resolve_cognito_client_id(Some("client/id")).is_err());
        assert!(resolve_cognito_client_id(Some(&"a".repeat(129))).is_err());
        assert_eq!(
            resolve_cognito_client_id(Some("client_ID+1")).unwrap(),
            "client_ID+1"
        );
    }

    #[test]
    fn maps_microsoft_to_personal_cognito_provider() {
        assert_eq!(cognito_identity_provider("Google").unwrap(), "Google");
        assert_eq!(
            cognito_identity_provider("Microsoft").unwrap(),
            "MicrosoftPersonal"
        );
        assert!(cognito_identity_provider("MicrosoftWork").is_err());
    }

    #[test]
    fn authorize_url_supports_microsoft_provider() {
        let url = build_authorize_url_for_client(
            "state-123",
            "challenge-123",
            "MicrosoftPersonal",
            "nonproductionclient",
            "https://nonproduction.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        );
        assert!(url.contains("identity_provider=MicrosoftPersonal"));
        assert!(url.contains("state=state-123"));
        assert!(url.contains("code_challenge=challenge-123"));
    }
}
