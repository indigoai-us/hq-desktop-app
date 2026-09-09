use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

// hq-prod stack (canonical post-2026-04-25 cutover). MUST stay in sync with
// cognito.rs's COGNITO_CLIENT_ID — drift between the two breaks token refresh
// (sign-in succeeds against one client but refresh hits InvalidClient).
pub const COGNITO_CLIENT_ID: &str = "7acei2c8v870enheptb1j5foln";
pub const DEFAULT_COGNITO_DOMAIN_PREFIX: &str = "vault-indigo-hq-prod";
pub const REDIRECT_URI: &str = "http://localhost:53682/callback";

/// Cognito hosted-UI domain prefix.
///
/// Resolves to `$HQ_COGNITO_DOMAIN` if set, else the canonical
/// `vault-indigo-hq-prod` prefix shared with `@indigoai-us/hq-cli` and
/// `hq-installer`. Always in the
/// `us-east-1.amazoncognito.com` namespace — custom domains not yet supported.
pub fn cognito_domain_prefix() -> String {
    std::env::var("HQ_COGNITO_DOMAIN").unwrap_or_else(|_| DEFAULT_COGNITO_DOMAIN_PREFIX.to_string())
}

pub fn cognito_authorize_url() -> String {
    format!(
        "https://{}.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        cognito_domain_prefix()
    )
}

pub fn cognito_token_url() -> String {
    format!(
        "https://{}.auth.us-east-1.amazoncognito.com/oauth2/token",
        cognito_domain_prefix()
    )
}

pub fn cognito_identity_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "Google" => Ok("Google"),
        "Microsoft" => Ok("MicrosoftPersonal"),
        _ => Err(format!("Unsupported sign-in provider: {provider}")),
    }
}

/// Inputs to the Cognito authorize URL.
///
/// `identity_provider` is optional because browser continuation deliberately
/// omits it: naming a provider forces that provider's own login, which defeats
/// the whole point of letting Cognito reuse a session the browser may already
/// have. The manual provider buttons still pass one.
///
/// `nonce` is likewise optional and is set only for continuation, where the
/// returned ID token is checked against it. It is an OIDC replay defence, not
/// an identifier, and it never leaves the process except inside the authorize
/// URL and the ID token that answers it.
pub struct AuthorizeRequest<'a> {
    pub state: &'a str,
    pub challenge: &'a str,
    pub identity_provider: Option<&'a str>,
    pub nonce: Option<&'a str>,
}

pub fn build_authorize_url_from(request: &AuthorizeRequest<'_>) -> String {
    let mut url = format!(
        "{base}?response_type=code\
         &client_id={client_id}\
         &redirect_uri={redirect_uri}\
         &scope=openid+email+profile\
         &state={state}\
         &code_challenge={challenge}\
         &code_challenge_method=S256",
        base = cognito_authorize_url(),
        client_id = COGNITO_CLIENT_ID,
        redirect_uri = REDIRECT_URI,
        state = request.state,
        challenge = request.challenge,
    );
    if let Some(provider) = request.identity_provider {
        url.push_str("&identity_provider=");
        url.push_str(provider);
    }
    if let Some(nonce) = request.nonce {
        url.push_str("&nonce=");
        url.push_str(nonce);
    }
    url
}

pub fn build_authorize_url(state: &str, challenge: &str, identity_provider: &str) -> String {
    build_authorize_url_from(&AuthorizeRequest {
        state,
        challenge,
        identity_provider: Some(identity_provider),
        nonce: None,
    })
}

/// Generate an OIDC nonce for a continuation attempt.
///
/// Same construction as the PKCE verifier — two v4 UUIDs, hex, URL-safe — so
/// no new randomness dependency enters the crate.
pub fn generate_nonce() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple(),
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

/// Largest loopback callback request we will look at.
///
/// The listener's own read buffer is 4 KiB, so anything at or past this bound
/// is either a truncated read or something that is not a browser redirect.
/// Refusing it outright keeps a hostile local peer from steering the parser
/// with a request we only ever saw part of.
pub const MAX_CALLBACK_REQUEST_BYTES: usize = 4096;

/// What the authorization server actually said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackOutcome {
    /// A single-use authorization code, to be exchanged with the PKCE verifier.
    Code(String),
    /// An OAuth error identifier, e.g. `access_denied` or `login_required`.
    Error(String),
}

/// A callback that passed structural validation. The state still has to be
/// compared against the attempt's own state by the caller — this type only
/// promises the request was well formed and unambiguous.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackRequest {
    pub state: String,
    pub outcome: CallbackOutcome,
}

/// Why a request on the loopback listener is not a usable callback.
///
/// These are deliberately separate variants rather than one catch-all: the
/// difference between "some other program probed the port" and "a callback
/// arrived carrying two different states" matters when reading logs, and only
/// the second is worth alarming about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackRejection {
    /// No parseable HTTP request line.
    Malformed,
    /// Larger than [`MAX_CALLBACK_REQUEST_BYTES`].
    TooLarge,
    /// Something other than GET.
    WrongMethod,
    /// A path other than exactly `/callback`.
    WrongPath,
    /// A parameter we care about appeared more than once.
    DuplicateParameter,
    /// No `state`, so the request cannot be tied to any attempt we started.
    MissingState,
    /// Neither a nonempty `code` nor a nonempty `error`.
    MissingOutcome,
    /// Both a code and an error, which no compliant server sends.
    AmbiguousOutcome,
}

/// Parse a loopback callback strictly.
///
/// The previous implementation accepted any path with a query string and
/// required a `code` even on the error branch, so a perfectly ordinary
/// `?error=login_required&state=...` response — which is exactly what Cognito
/// returns when it cannot reuse a browser session silently — parsed as nothing,
/// got a 404, and left the listener spinning until its five-minute timeout. The
/// user saw a browser tab that said nothing and an app that never came back.
///
/// This version accepts only `GET /callback`, requires exactly one `state`,
/// requires exactly one of a nonempty code or a nonempty error, and refuses
/// duplicates of any of the three. The caller compares state on BOTH outcomes,
/// so an unsolicited error cannot cancel an attempt it does not belong to.
pub fn parse_callback(request: &str) -> Result<CallbackRequest, CallbackRejection> {
    if request.len() > MAX_CALLBACK_REQUEST_BYTES {
        return Err(CallbackRejection::TooLarge);
    }
    let first_line = request.lines().next().ok_or(CallbackRejection::Malformed)?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().ok_or(CallbackRejection::Malformed)?;
    let target = parts.next().ok_or(CallbackRejection::Malformed)?;
    if method != "GET" {
        return Err(CallbackRejection::WrongMethod);
    }

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    if path != "/callback" {
        return Err(CallbackRejection::WrongPath);
    }

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, raw) = pair.split_once('=').unwrap_or((pair, ""));
        let slot = match key {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            _ => continue,
        };
        if slot.is_some() {
            return Err(CallbackRejection::DuplicateParameter);
        }
        *slot = Some(urldecode(raw));
    }

    let state = state.filter(|s| !s.is_empty()).ok_or(CallbackRejection::MissingState)?;
    let code = code.filter(|c| !c.is_empty());
    let error = error.filter(|e| !e.is_empty());

    match (code, error) {
        (Some(_), Some(_)) => Err(CallbackRejection::AmbiguousOutcome),
        (Some(code), None) => Ok(CallbackRequest {
            state,
            outcome: CallbackOutcome::Code(code),
        }),
        (None, Some(error)) => Ok(CallbackRequest {
            state,
            outcome: CallbackOutcome::Error(error),
        }),
        (None, None) => Err(CallbackRejection::MissingOutcome),
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

    fn callback(request: &str) -> Result<CallbackRequest, CallbackRejection> {
        parse_callback(request)
    }

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let req = "GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let parsed = callback(req).unwrap();
        assert_eq!(parsed.state, "xyz");
        assert_eq!(parsed.outcome, CallbackOutcome::Code("abc123".into()));
    }

    #[test]
    fn parse_callback_accepts_an_error_with_no_code() {
        // The regression this parser exists for. Cognito answers this way when
        // it cannot reuse a browser session; the old parser required a code
        // even here, so the response fell through to a 404 and the listener sat
        // until its five-minute timeout with the user staring at a blank tab.
        let req = "GET /callback?error=login_required&state=xyz HTTP/1.1\r\n\r\n";
        let parsed = callback(req).unwrap();
        assert_eq!(parsed.state, "xyz");
        assert_eq!(
            parsed.outcome,
            CallbackOutcome::Error("login_required".into())
        );
    }

    #[test]
    fn parse_callback_carries_state_on_the_error_branch() {
        // State has to survive an error, because the caller compares it before
        // acting. Without it an unsolicited error delivered to the loopback
        // port would cancel an attempt it has nothing to do with.
        let req = "GET /callback?error=access_denied&state=attempt-1 HTTP/1.1\r\n\r\n";
        assert_eq!(callback(req).unwrap().state, "attempt-1");
    }

    #[test]
    fn parse_callback_refuses_a_code_and_an_error_together() {
        let req = "GET /callback?code=x&state=y&error=access_denied HTTP/1.1\r\n\r\n";
        assert_eq!(callback(req), Err(CallbackRejection::AmbiguousOutcome));
    }

    #[test]
    fn parse_callback_refuses_state_with_neither_outcome() {
        let req = "GET /callback?state=y HTTP/1.1\r\n\r\n";
        assert_eq!(callback(req), Err(CallbackRejection::MissingOutcome));
    }

    #[test]
    fn parse_callback_refuses_an_outcome_with_no_state() {
        let req = "GET /callback?code=abc HTTP/1.1\r\n\r\n";
        assert_eq!(callback(req), Err(CallbackRejection::MissingState));
    }

    #[test]
    fn parse_callback_treats_empty_values_as_absent() {
        assert_eq!(
            callback("GET /callback?code=&state=y HTTP/1.1\r\n\r\n"),
            Err(CallbackRejection::MissingOutcome)
        );
        assert_eq!(
            callback("GET /callback?code=abc&state= HTTP/1.1\r\n\r\n"),
            Err(CallbackRejection::MissingState)
        );
    }

    #[test]
    fn parse_callback_refuses_repeated_parameters() {
        // Parameter smuggling: a first state that matches the attempt followed
        // by a second the parser would otherwise silently prefer or discard.
        // Neither answer is safe, so the request is refused outright.
        for req in [
            "GET /callback?code=a&code=b&state=y HTTP/1.1\r\n\r\n",
            "GET /callback?code=a&state=y&state=z HTTP/1.1\r\n\r\n",
            "GET /callback?error=a&error=b&state=y HTTP/1.1\r\n\r\n",
        ] {
            assert_eq!(callback(req), Err(CallbackRejection::DuplicateParameter));
        }
    }

    #[test]
    fn parse_callback_rejects_non_get() {
        let req = "POST /callback?code=x&state=y HTTP/1.1\r\n\r\n";
        assert_eq!(callback(req), Err(CallbackRejection::WrongMethod));
    }

    #[test]
    fn parse_callback_requires_the_exact_callback_path() {
        // The old parser never looked at the path at all: any local program
        // that could reach the port could deliver a code on any path.
        for req in [
            "GET /favicon.ico HTTP/1.1\r\n\r\n",
            "GET /?code=x&state=y HTTP/1.1\r\n\r\n",
            "GET /callback/extra?code=x&state=y HTTP/1.1\r\n\r\n",
            "GET /Callback?code=x&state=y HTTP/1.1\r\n\r\n",
            "GET /callbackx?code=x&state=y HTTP/1.1\r\n\r\n",
        ] {
            assert_eq!(callback(req), Err(CallbackRejection::WrongPath));
        }
    }

    #[test]
    fn parse_callback_refuses_an_oversized_request() {
        let padding = "a".repeat(MAX_CALLBACK_REQUEST_BYTES);
        let req = format!("GET /callback?code={padding}&state=y HTTP/1.1\r\n\r\n");
        assert_eq!(callback(&req), Err(CallbackRejection::TooLarge));
    }

    #[test]
    fn parse_callback_refuses_a_request_with_no_request_line() {
        assert_eq!(callback(""), Err(CallbackRejection::Malformed));
        assert_eq!(callback("GET"), Err(CallbackRejection::Malformed));
    }

    #[test]
    fn parse_callback_decodes_percent_escapes_in_values() {
        let req = "GET /callback?code=a%2Fb&state=x%20y HTTP/1.1\r\n\r\n";
        let parsed = callback(req).unwrap();
        assert_eq!(parsed.state, "x y");
        assert_eq!(parsed.outcome, CallbackOutcome::Code("a/b".into()));
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

        let url = build_authorize_url(state, &challenge, "Google");

        assert!(url.starts_with(&format!("{}?", cognito_authorize_url())));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=7acei2c8v870enheptb1j5foln"));
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
    fn maps_microsoft_to_personal_cognito_provider() {
        assert_eq!(cognito_identity_provider("Google").unwrap(), "Google");
        assert_eq!(
            cognito_identity_provider("Microsoft").unwrap(),
            "MicrosoftPersonal"
        );
        assert!(cognito_identity_provider("MicrosoftWork").is_err());
    }

    #[test]
    fn continuation_authorize_url_names_no_provider() {
        // Naming a provider forces that provider's own login screen, which is
        // exactly what continuation is trying to avoid. Omitting it is what
        // lets Cognito reuse a session the browser may already hold.
        let url = build_authorize_url_from(&AuthorizeRequest {
            state: "s",
            challenge: "c",
            identity_provider: None,
            nonce: Some("n"),
        });
        assert!(!url.contains("identity_provider"));
        assert!(url.contains("&nonce=n"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn manual_authorize_url_is_unchanged_and_carries_no_nonce() {
        let url = build_authorize_url("s", "c", "Google");
        assert!(url.contains("identity_provider=Google"));
        assert!(!url.contains("nonce="));
    }

    #[test]
    fn nonce_is_random_and_url_safe() {
        let a = generate_nonce();
        let b = generate_nonce();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn authorize_url_supports_microsoft_provider() {
        let url = build_authorize_url("state-123", "challenge-123", "MicrosoftPersonal");
        assert!(url.contains("identity_provider=MicrosoftPersonal"));
        assert!(url.contains("state=state-123"));
        assert!(url.contains("code_challenge=challenge-123"));
    }
}
