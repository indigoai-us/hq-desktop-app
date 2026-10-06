//! Pick the Cognito Microsoft identity provider for a desktop sign-in.
//!
//! Work and school accounts live on per-tenant `MsOrg*` providers created by
//! hq-pro. Personal Microsoft accounts use `MicrosoftPersonal`. Mapping every
//! "Microsoft" click to `MicrosoftPersonal` sends work users to login.live.com,
//! which then says it could not find that username.
//!
//! Desktop cannot reuse the website's browser discovery hop: that callback
//! returns to hqforwork.com, not the loopback redirect. The unauthenticated
//! resolve endpoint is the same lookup the website uses when it already has an
//! email, and it is safe to call from native code.

use serde::Deserialize;

/// Cognito IdP for Microsoft consumer (outlook.com / hotmail.com / live.com).
pub const MICROSOFT_PERSONAL_PROVIDER: &str = "MicrosoftPersonal";

/// Per-organisation providers are `MsOrg` plus 26 lowercase hex characters
/// (hq-pro `MICROSOFT_ORG_PROVIDER_NAME_RE`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MicrosoftResolveError {
    InvalidEmail,
    EmailRequired,
    EnablementRequired,
    Network,
    UnexpectedResponse,
    UnsupportedProvider(String),
}

impl MicrosoftResolveError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidEmail | Self::EmailRequired => "MICROSOFT_EMAIL_REQUIRED",
            Self::EnablementRequired => "MICROSOFT_ENABLEMENT_REQUIRED",
            Self::Network | Self::UnexpectedResponse => "MICROSOFT_RESOLVE_FAILED",
            Self::UnsupportedProvider(_) => "OAUTH_UNSUPPORTED_PROVIDER",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::InvalidEmail => {
                "Enter a valid Microsoft email, then try again.".to_string()
            }
            Self::EmailRequired => {
                "Enter the Microsoft email you use with HQ, then try again.".to_string()
            }
            Self::EnablementRequired => {
                "This Microsoft work account is not set up for HQ Desktop yet. Sign in at hqforwork.com first, then return here.".to_string()
            }
            Self::Network => {
                "We could not identify your Microsoft account. Check your connection and retry.".to_string()
            }
            Self::UnexpectedResponse => {
                "We could not identify your Microsoft account. Retry, or sign in at hqforwork.com first.".to_string()
            }
            Self::UnsupportedProvider(provider) => {
                format!("Unsupported sign-in provider: {provider}")
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct ResolveResponse {
    status: String,
    #[serde(rename = "providerName", default)]
    provider_name: Option<String>,
}

pub fn microsoft_org_resolve_url(api_base: &str) -> String {
    format!(
        "{}/v1/signin/microsoft-org/resolve",
        api_base.trim_end_matches('/')
    )
}

pub fn is_microsoft_org_provider_name(name: &str) -> bool {
    name.starts_with("MsOrg")
        && name.len() == 31
        && name.as_bytes()[5..]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Normalise an email the same way hq-pro's resolve route does: trim, lowercase,
/// reject empty / oversized / whitespace-bearing values.
pub fn normalised_microsoft_email(email: &str) -> Result<String, MicrosoftResolveError> {
    let trimmed = email.trim().to_lowercase();
    if trimmed.is_empty() {
        return Err(MicrosoftResolveError::EmailRequired);
    }
    if trimmed.len() > 320 || trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(MicrosoftResolveError::InvalidEmail);
    }
    let Some(at) = trimmed.rfind('@') else {
        return Err(MicrosoftResolveError::InvalidEmail);
    };
    if at == 0 || at == trimmed.len() - 1 {
        return Err(MicrosoftResolveError::InvalidEmail);
    }
    Ok(trimmed)
}

/// Map a resolve JSON body to a Cognito `identity_provider` name.
///
/// A work/school (`enabled`) response never returns `MicrosoftPersonal`.
/// `personal` and `not-microsoft` (generic consumer mailboxes) do.
pub fn identity_provider_from_resolve_body(body: &str) -> Result<String, MicrosoftResolveError> {
    let parsed: ResolveResponse =
        serde_json::from_str(body).map_err(|_| MicrosoftResolveError::UnexpectedResponse)?;
    match parsed.status.as_str() {
        "enabled" => {
            let name = parsed
                .provider_name
                .as_deref()
                .ok_or(MicrosoftResolveError::UnexpectedResponse)?;
            if is_microsoft_org_provider_name(name) {
                Ok(name.to_string())
            } else {
                Err(MicrosoftResolveError::UnexpectedResponse)
            }
        }
        "personal" | "not-microsoft" => Ok(MICROSOFT_PERSONAL_PROVIDER.to_string()),
        "enablement-required" => Err(MicrosoftResolveError::EnablementRequired),
        _ => Err(MicrosoftResolveError::UnexpectedResponse),
    }
}

pub async fn resolve_microsoft_identity_provider(
    client: &reqwest::Client,
    api_base: &str,
    email: &str,
) -> Result<String, MicrosoftResolveError> {
    let email = normalised_microsoft_email(email)?;
    let url = microsoft_org_resolve_url(api_base);
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|_| MicrosoftResolveError::Network)?;
    let status = response.status();
    if status.as_u16() == 400 {
        return Err(MicrosoftResolveError::InvalidEmail);
    }
    if !status.is_success() {
        return Err(MicrosoftResolveError::Network);
    }
    let body = response
        .text()
        .await
        .map_err(|_| MicrosoftResolveError::Network)?;
    identity_provider_from_resolve_body(&body)
}

/// Map a desktop provider button to the Cognito `identity_provider` value.
///
/// Google is 1:1. Microsoft asks hq-pro which tenant provider to use.
pub async fn identity_provider_for_sign_in(
    provider: &str,
    email: Option<&str>,
    client: &reqwest::Client,
    api_base: &str,
) -> Result<String, MicrosoftResolveError> {
    match provider {
        "Google" => Ok("Google".to_string()),
        "Microsoft" => {
            resolve_microsoft_identity_provider(client, api_base, email.unwrap_or("")).await
        }
        other => Err(MicrosoftResolveError::UnsupportedProvider(
            other.to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const WORK_EMAIL: &str = "scottallen@dim6fitness.com";
    const WORK_PROVIDER: &str = "MsOrg87489d4600af47338b7bafe9bd";

    #[test]
    fn work_enabled_body_never_produces_microsoft_personal() {
        let body = format!(r#"{{"status":"enabled","providerName":"{WORK_PROVIDER}"}}"#);
        let provider = identity_provider_from_resolve_body(&body).unwrap();
        assert_eq!(provider, WORK_PROVIDER);
        assert_ne!(provider, MICROSOFT_PERSONAL_PROVIDER);
        assert!(is_microsoft_org_provider_name(&provider));
    }

    #[test]
    fn personal_and_generic_mailboxes_use_microsoft_personal() {
        assert_eq!(
            identity_provider_from_resolve_body(r#"{"status":"personal"}"#).unwrap(),
            MICROSOFT_PERSONAL_PROVIDER
        );
        assert_eq!(
            identity_provider_from_resolve_body(r#"{"status":"not-microsoft"}"#).unwrap(),
            MICROSOFT_PERSONAL_PROVIDER
        );
    }

    #[test]
    fn enablement_required_is_not_microsoft_personal() {
        let err =
            identity_provider_from_resolve_body(r#"{"status":"enablement-required"}"#).unwrap_err();
        assert_eq!(err, MicrosoftResolveError::EnablementRequired);
        assert_ne!(err.message(), MICROSOFT_PERSONAL_PROVIDER);
    }

    #[test]
    fn enabled_without_a_valid_msorg_name_fails_closed() {
        assert!(identity_provider_from_resolve_body(
            r#"{"status":"enabled","providerName":"MicrosoftPersonal"}"#
        )
        .is_err());
        assert!(identity_provider_from_resolve_body(r#"{"status":"enabled"}"#).is_err());
        assert!(identity_provider_from_resolve_body(
            r#"{"status":"enabled","providerName":"MsOrgZZZZZZZZZZZZZZZZZZZZZZZZZZ"}"#
        )
        .is_err());
    }

    #[test]
    fn rejects_malformed_email_without_a_network_call() {
        assert_eq!(
            normalised_microsoft_email("").unwrap_err(),
            MicrosoftResolveError::EmailRequired
        );
        assert_eq!(
            normalised_microsoft_email("not-an-email").unwrap_err(),
            MicrosoftResolveError::InvalidEmail
        );
        assert_eq!(
            normalised_microsoft_email("scottallen@dim6fitness.com").unwrap(),
            WORK_EMAIL
        );
        assert_eq!(
            normalised_microsoft_email("  ScottAllen@Dim6Fitness.com  ").unwrap(),
            WORK_EMAIL
        );
    }

    #[test]
    fn msorg_name_shape_matches_hq_pro() {
        assert!(is_microsoft_org_provider_name(WORK_PROVIDER));
        assert!(!is_microsoft_org_provider_name("MicrosoftPersonal"));
        assert!(!is_microsoft_org_provider_name(
            "MsOrg87489d4600af47338b7bafe9b"
        ));
        assert!(!is_microsoft_org_provider_name(
            "MsOrg87489d4600af47338b7bafe9bdX"
        ));
        assert!(!is_microsoft_org_provider_name(
            "msorg87489d4600af47338b7bafe9bd"
        ));
    }

    async fn mock_resolve(server: &MockServer, email: &str, body: serde_json::Value, status: u16) {
        Mock::given(method("POST"))
            .and(path("/v1/signin/microsoft-org/resolve"))
            .and(body_json(serde_json::json!({ "email": email })))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn work_email_resolves_to_msorg_not_personal() {
        let server = MockServer::start().await;
        mock_resolve(
            &server,
            WORK_EMAIL,
            serde_json::json!({ "status": "enabled", "providerName": WORK_PROVIDER }),
            200,
        )
        .await;

        let client = reqwest::Client::new();
        let provider =
            identity_provider_for_sign_in("Microsoft", Some(WORK_EMAIL), &client, &server.uri())
                .await
                .unwrap();
        assert_eq!(provider, WORK_PROVIDER);
        assert_ne!(provider, MICROSOFT_PERSONAL_PROVIDER);
    }

    #[tokio::test]
    async fn personal_email_still_uses_microsoft_personal() {
        let server = MockServer::start().await;
        mock_resolve(
            &server,
            "ada@outlook.com",
            serde_json::json!({ "status": "personal" }),
            200,
        )
        .await;

        let client = reqwest::Client::new();
        let provider = identity_provider_for_sign_in(
            "Microsoft",
            Some("ada@outlook.com"),
            &client,
            &server.uri(),
        )
        .await
        .unwrap();
        assert_eq!(provider, MICROSOFT_PERSONAL_PROVIDER);
    }

    #[tokio::test]
    async fn google_is_unchanged_and_does_not_call_resolve() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let provider =
            identity_provider_for_sign_in("Google", Some(WORK_EMAIL), &client, &server.uri())
                .await
                .unwrap();
        assert_eq!(provider, "Google");
    }

    #[tokio::test]
    async fn network_failure_does_not_fall_back_to_microsoft_personal() {
        let server = MockServer::start().await;
        mock_resolve(
            &server,
            WORK_EMAIL,
            serde_json::json!({ "error": "boom" }),
            500,
        )
        .await;

        let client = reqwest::Client::new();
        let err =
            identity_provider_for_sign_in("Microsoft", Some(WORK_EMAIL), &client, &server.uri())
                .await
                .unwrap_err();
        assert_eq!(err, MicrosoftResolveError::Network);
        assert_eq!(err.code(), "MICROSOFT_RESOLVE_FAILED");
    }

    #[tokio::test]
    async fn unreachable_resolve_does_not_use_microsoft_personal() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .unwrap();
        let err = identity_provider_for_sign_in(
            "Microsoft",
            Some(WORK_EMAIL),
            &client,
            "http://127.0.0.1:1",
        )
        .await
        .unwrap_err();
        assert_eq!(err, MicrosoftResolveError::Network);
    }

    #[tokio::test]
    async fn enablement_required_does_not_use_microsoft_personal() {
        let server = MockServer::start().await;
        mock_resolve(
            &server,
            WORK_EMAIL,
            serde_json::json!({ "status": "enablement-required" }),
            200,
        )
        .await;

        let client = reqwest::Client::new();
        let err =
            identity_provider_for_sign_in("Microsoft", Some(WORK_EMAIL), &client, &server.uri())
                .await
                .unwrap_err();
        assert_eq!(err, MicrosoftResolveError::EnablementRequired);
    }

    #[tokio::test]
    async fn missing_microsoft_email_fails_before_http() {
        let client = reqwest::Client::new();
        let err = identity_provider_for_sign_in("Microsoft", None, &client, "http://127.0.0.1:1")
            .await
            .unwrap_err();
        assert_eq!(err, MicrosoftResolveError::EmailRequired);
    }
}
