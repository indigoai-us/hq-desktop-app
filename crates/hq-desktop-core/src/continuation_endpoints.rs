//! Where a continuation attempt is allowed to talk to.
//!
//! Continuation drives a real OAuth flow against a real identity provider and
//! then asks a real backend to verify what came back. That makes an accident
//! here expensive in an unusual way: a test that reaches production does not
//! fail, it succeeds — quietly, against live infrastructure, with a live
//! account. So the three endpoints it needs are resolved through one place,
//! and that place can be pointed somewhere harmless from a test.
//!
//! Two of the three overrides already existed and are used by ordinary dev
//! setups (`HQ_COGNITO_DOMAIN`, `HQ_VAULT_API_URL`). The third — the Cognito
//! app client id — is deliberately NOT readable from the environment in a
//! shipped build. An env-settable client id would let anything that can set a
//! variable in the app's environment point sign-in at an app client it
//! controls, which is a real attack for a marginal testing convenience. It is
//! gated behind `cfg(test)` and the `test-support` feature instead.

/// The endpoints one continuation attempt will use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuationEndpoints {
    /// Cognito hosted-UI domain prefix (not a full URL).
    pub cognito_domain: String,
    /// Cognito app client id.
    pub cognito_client_id: String,
    /// Base URL of the vault API, no trailing slash.
    pub api_base: String,
}

/// The production values. Named so a test can assert it is *not* using them.
pub const PRODUCTION_API_BASE: &str = "https://hqapi.hq.computer";

/// Cognito app client id for a shipped build.
///
/// In a test build this is overridable via `HQ_TEST_COGNITO_CLIENT_ID`; in a
/// shipped build the override does not exist at all, so nothing in the
/// environment can repoint sign-in.
pub fn cognito_client_id() -> String {
    #[cfg(any(test, feature = "test-support"))]
    if let Ok(value) = std::env::var("HQ_TEST_COGNITO_CLIENT_ID") {
        if !value.is_empty() {
            return value;
        }
    }
    crate::oauth::COGNITO_CLIENT_ID.to_string()
}

/// Base URL of the vault API.
///
/// `HQ_VAULT_API_URL` is the existing dev/test override that the sync path
/// already honours; continuation reads the same one rather than inventing a
/// second name for the same idea. Note this resolver deliberately does NOT
/// read `~/.hq/config.json` — that is the caller's job on the desktop side,
/// because reading a file is exactly the kind of thing a pure resolver should
/// not do behind a test's back.
pub fn api_base() -> String {
    std::env::var("HQ_VAULT_API_URL")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| PRODUCTION_API_BASE.to_string())
}

impl ContinuationEndpoints {
    /// Resolve from the environment.
    pub fn resolve() -> Self {
        Self {
            cognito_domain: crate::oauth::cognito_domain_prefix(),
            cognito_client_id: cognito_client_id(),
            api_base: api_base(),
        }
    }

    /// Explicit construction, for a caller that already knows its base URL —
    /// the desktop resolves the vault URL from `~/.hq/config.json` first.
    pub fn with_api_base(api_base: impl Into<String>) -> Self {
        Self {
            api_base: api_base.into().trim_end_matches('/').to_string(),
            ..Self::resolve()
        }
    }

    /// True when any of the three still points at live infrastructure.
    ///
    /// A test that drives the whole flow asserts this is false before it makes
    /// a single request. It is cheap, and the failure it prevents — a green
    /// test that authenticated a real person against production — is one that
    /// would otherwise be discovered by someone else, later, in the logs.
    pub fn touches_production(&self) -> bool {
        self.api_base == PRODUCTION_API_BASE
            || self.cognito_domain == crate::oauth::DEFAULT_COGNITO_DOMAIN_PREFIX
            || self.cognito_client_id == crate::oauth::COGNITO_CLIENT_ID
    }

    pub fn config_url(&self) -> String {
        format!("{}/v1/desktop/onboarding/config", self.api_base)
    }

    pub fn launch_url(&self) -> String {
        format!("{}/v1/desktop/onboarding/launch", self.api_base)
    }

    pub fn progress_url(&self) -> String {
        format!("{}/v1/desktop/onboarding/progress", self.api_base)
    }

    /// Resolve a renderer-supplied receipt path to a full URL, or refuse.
    ///
    /// The renderer decides *when* a receipt is sent; it must not be able to
    /// decide *where*. Without this, the native delivery command would take a
    /// path from the webview and concatenate it onto the API base — and a path
    /// is enough to reach any route on that host, including the authenticated
    /// ones the renderer is deliberately kept away from. Two literals, compared
    /// whole; no prefix match, no normalisation, no traversal to reason about.
    pub fn receipt_url(&self, path: &str) -> Option<String> {
        match path {
            "/v1/desktop/onboarding/launch" => Some(self.launch_url()),
            "/v1/desktop/onboarding/progress" => Some(self.progress_url()),
            _ => None,
        }
    }

    pub fn session_verify_url(&self) -> String {
        format!("{}/v1/desktop/session/verify", self.api_base)
    }

    pub fn session_activated_url(&self) -> String {
        format!("{}/v1/desktop/session/activated", self.api_base)
    }

    pub fn workspace_selected_url(&self) -> String {
        format!("{}/v1/desktop/workspace/selected", self.api_base)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoints() -> ContinuationEndpoints {
        ContinuationEndpoints {
            cognito_domain: "example-domain".to_string(),
            cognito_client_id: "example-client-id".to_string(),
            api_base: "https://api.example.test".to_string(),
        }
    }

    #[test]
    fn the_two_anonymous_receipt_paths_resolve() {
        let e = endpoints();
        assert_eq!(
            e.receipt_url("/v1/desktop/onboarding/launch").as_deref(),
            Some("https://api.example.test/v1/desktop/onboarding/launch"),
        );
        assert_eq!(
            e.receipt_url("/v1/desktop/onboarding/progress").as_deref(),
            Some("https://api.example.test/v1/desktop/onboarding/progress"),
        );
    }

    #[test]
    fn nothing_else_resolves_however_it_is_spelled() {
        let e = endpoints();
        for path in [
            // The authenticated routes the renderer must never reach.
            "/v1/desktop/session/verify",
            "/v1/desktop/session/activated",
            "/v1/desktop/workspace/selected",
            // Anything else on the host.
            "/v1/files/shared-with-me",
            "/v1/notify/dm",
            // Traversal, absolute override, and near-misses.
            "/v1/desktop/onboarding/../session/verify",
            "https://evil.test/v1/desktop/onboarding/launch",
            "//evil.test/v1/desktop/onboarding/launch",
            "/v1/desktop/onboarding/launch?x=1",
            "/v1/desktop/onboarding/launch/",
            "/V1/DESKTOP/ONBOARDING/LAUNCH",
            " /v1/desktop/onboarding/launch",
            "",
        ] {
            assert_eq!(e.receipt_url(path), None, "path should be refused: {path:?}");
        }
    }

    /// These tests mutate process-global environment variables, so they share
    /// one lock rather than racing each other across vitest-style parallelism.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        keys: Vec<&'static str>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(pairs: &[(&'static str, &str)]) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            for (key, value) in pairs {
                std::env::set_var(key, value);
            }
            Self {
                keys: pairs.iter().map(|(key, _)| *key).collect(),
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for key in &self.keys {
                std::env::remove_var(key);
            }
        }
    }

    #[test]
    fn an_unconfigured_build_resolves_to_production() {
        let _guard = EnvGuard::set(&[]);
        std::env::remove_var("HQ_VAULT_API_URL");
        std::env::remove_var("HQ_COGNITO_DOMAIN");
        std::env::remove_var("HQ_TEST_COGNITO_CLIENT_ID");
        let endpoints = ContinuationEndpoints::resolve();
        assert_eq!(endpoints.api_base, PRODUCTION_API_BASE);
        assert!(endpoints.touches_production());
    }

    #[test]
    fn a_fully_overridden_build_touches_nothing_live() {
        let _guard = EnvGuard::set(&[
            ("HQ_VAULT_API_URL", "http://127.0.0.1:1/"),
            ("HQ_COGNITO_DOMAIN", "isolated-test-domain"),
            ("HQ_TEST_COGNITO_CLIENT_ID", "isolated-test-client"),
        ]);
        let endpoints = ContinuationEndpoints::resolve();
        assert_eq!(endpoints.api_base, "http://127.0.0.1:1");
        assert_eq!(endpoints.cognito_domain, "isolated-test-domain");
        assert_eq!(endpoints.cognito_client_id, "isolated-test-client");
        assert!(!endpoints.touches_production());
    }

    #[test]
    fn overriding_only_two_of_the_three_still_counts_as_production() {
        // The guard is an all-or-nothing claim on purpose. A test that
        // repointed the API but left the real Cognito client would still be
        // driving a live identity provider.
        let _guard = EnvGuard::set(&[
            ("HQ_VAULT_API_URL", "http://127.0.0.1:1"),
            ("HQ_COGNITO_DOMAIN", "isolated-test-domain"),
        ]);
        std::env::remove_var("HQ_TEST_COGNITO_CLIENT_ID");
        assert!(ContinuationEndpoints::resolve().touches_production());
    }

    #[test]
    fn a_trailing_slash_does_not_produce_a_double_slash_path() {
        let _guard = EnvGuard::set(&[
            ("HQ_VAULT_API_URL", "http://127.0.0.1:1/"),
            ("HQ_COGNITO_DOMAIN", "isolated-test-domain"),
            ("HQ_TEST_COGNITO_CLIENT_ID", "isolated-test-client"),
        ]);
        let endpoints = ContinuationEndpoints::resolve();
        assert_eq!(
            endpoints.config_url(),
            "http://127.0.0.1:1/v1/desktop/onboarding/config"
        );
    }

    #[test]
    fn every_route_this_build_calls_is_under_the_desktop_prefix() {
        let _guard = EnvGuard::set(&[
            ("HQ_VAULT_API_URL", "http://127.0.0.1:1"),
            ("HQ_COGNITO_DOMAIN", "isolated-test-domain"),
            ("HQ_TEST_COGNITO_CLIENT_ID", "isolated-test-client"),
        ]);
        let endpoints = ContinuationEndpoints::resolve();
        for url in [
            endpoints.config_url(),
            endpoints.launch_url(),
            endpoints.progress_url(),
            endpoints.session_verify_url(),
            endpoints.session_activated_url(),
            endpoints.workspace_selected_url(),
        ] {
            assert!(
                url.starts_with("http://127.0.0.1:1/v1/desktop/"),
                "unexpected route: {url}"
            );
        }
    }

    #[test]
    fn an_explicit_api_base_overrides_the_environment() {
        let _guard = EnvGuard::set(&[("HQ_VAULT_API_URL", "http://127.0.0.1:1")]);
        let endpoints = ContinuationEndpoints::with_api_base("http://127.0.0.1:2/");
        assert_eq!(endpoints.api_base, "http://127.0.0.1:2");
    }
}
