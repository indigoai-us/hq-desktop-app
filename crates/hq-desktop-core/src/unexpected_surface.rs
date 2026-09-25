use crate::cognito::StoredTokenPresence;

/// Returns true when the machine shows evidence it was already set up and
/// signed in, making a sign-in or onboarding surface unexpected.
pub fn prior_setup_detected(
    install_completed: bool,
    first_run_completed: bool,
    token_file_exists: bool,
) -> bool {
    install_completed || first_run_completed || token_file_exists
}

/// All fields sent to Sentry on an unexpected startup surface event.
/// No tokens, emails, or file contents are ever included.
#[derive(Debug, Clone)]
pub struct UnexpectedSurfacePayload {
    pub surface: String,
    pub lifecycle_state: String,
    pub install_completed: bool,
    pub first_run_completed: bool,
    pub config_valid: bool,
    pub hq_root_valid: bool,
    pub has_auth: bool,
    pub tools_present: bool,
    pub bundled_cli_ready: bool,
    pub consent_answered: bool,
    pub evidence_unreadable: bool,
    pub token_file_exists: bool,
    pub token_file_age_minutes: Option<u64>,
    pub auth_check_failed: bool,
    pub probe_attempts: u32,
    pub seconds_since_start: u64,
    pub from_updater_restart: bool,
    pub app_version: &'static str,
}

/// Normalize token-store observations before they become Sentry tag values.
/// The renderer reports only this bounded set; unknown inputs stay unknown.
pub fn token_presence_tag(presence: &str) -> &'static str {
    match presence {
        "present" => "present",
        "absent" => "absent",
        _ => "unknown",
    }
}

/// Preserve the backend's tri-state token-store read result in diagnostics.
pub fn stored_token_presence_label(presence: StoredTokenPresence) -> &'static str {
    match presence {
        StoredTokenPresence::Present => "present",
        StoredTokenPresence::Absent => "absent",
        StoredTokenPresence::Unreadable => "unknown",
    }
}

/// Summarize the auth verdict and token-store observation with bounded labels.
pub fn session_restore_state_tag(authenticated: bool, token_presence: &str) -> &'static str {
    match (authenticated, token_presence_tag(token_presence)) {
        (true, "present") => "authenticated_with_token",
        (true, "absent") => "authenticated_without_token",
        (true, _) => "authenticated_token_unknown",
        (false, "present") => "unauthenticated_with_token",
        (false, "absent") => "signed_out",
        (false, _) => "unauthenticated_token_unknown",
    }
}

/// Bucket elapsed launch time so the tag has a fixed, low-cardinality value set.
pub fn ms_since_launch_tag(elapsed_ms: Option<u128>) -> &'static str {
    match elapsed_ms {
        Some(0..=999) => "0-999ms",
        Some(1_000..=4_999) => "1000-4999ms",
        Some(5_000..=29_999) => "5000-29999ms",
        Some(30_000..=119_999) => "30000-119999ms",
        Some(120_000..) => "120000ms+",
        None => "unknown",
    }
}

/// Restrict prior-surface tags to the UI's known startup destinations.
pub fn prior_surface_tag(surface: &str) -> &'static str {
    match surface {
        "loading" => "loading",
        "onboarding" => "onboarding",
        "signed-in" => "signed-in",
        "sign-in" => "sign-in",
        _ => "unknown",
    }
}

/// Cognito startup restores from ~/.hq/cognito-tokens.json, not macOS Keychain.
pub const KEYCHAIN_STATUS_TAG: &str = "not_used_token_file";

/// The low-cardinality Sentry tags for an unexpected startup surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupDiagnosticTags {
    pub session_restore_state: &'static str,
    pub token_present: &'static str,
    pub keychain_status: &'static str,
    pub ms_since_launch: &'static str,
    pub prior_surface: &'static str,
}

impl StartupDiagnosticTags {
    /// Keep the Sentry keys and values together so tests cover the reporter contract.
    pub fn as_pairs(self) -> [(&'static str, &'static str); 5] {
        [
            ("session_restore_state", self.session_restore_state),
            ("token_present", self.token_present),
            ("keychain_status", self.keychain_status),
            ("ms_since_launch", self.ms_since_launch),
            ("prior_surface", self.prior_surface),
        ]
    }
}

/// Build a bounded diagnostic snapshot for the unexpected-surface reporter.
pub fn startup_diagnostic_tags(
    authenticated: bool,
    token_presence: &str,
    elapsed_ms: Option<u128>,
    prior_surface: &str,
) -> StartupDiagnosticTags {
    StartupDiagnosticTags {
        session_restore_state: session_restore_state_tag(authenticated, token_presence),
        token_present: token_presence_tag(token_presence),
        keychain_status: KEYCHAIN_STATUS_TAG,
        ms_since_launch: ms_since_launch_tag(elapsed_ms),
        prior_surface: prior_surface_tag(prior_surface),
    }
}

/// Replace the home directory in a path string with `~` so usernames are
/// never sent in Sentry events.
pub fn redact_home(path: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return path.replace(home.as_str(), "~");
        }
    }
    path.to_string()
}

#[allow(clippy::too_many_arguments)]
pub fn build_payload(
    surface: String,
    lifecycle_state: String,
    install_completed: bool,
    first_run_completed: bool,
    config_valid: bool,
    hq_root_valid: bool,
    has_auth: bool,
    tools_present: bool,
    bundled_cli_ready: bool,
    consent_answered: bool,
    evidence_unreadable: bool,
    token_file_exists: bool,
    token_file_age_minutes: Option<u64>,
    auth_check_failed: bool,
    probe_attempts: u32,
    seconds_since_start: u64,
    from_updater_restart: bool,
    app_version: &'static str,
) -> UnexpectedSurfacePayload {
    UnexpectedSurfacePayload {
        surface,
        lifecycle_state,
        install_completed,
        first_run_completed,
        config_valid,
        hq_root_valid,
        has_auth,
        tools_present,
        bundled_cli_ready,
        consent_answered,
        evidence_unreadable,
        token_file_exists,
        token_file_age_minutes,
        auth_check_failed,
        probe_attempts,
        seconds_since_start,
        from_updater_restart,
        app_version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prior_setup_detected_install_completed() {
        assert!(prior_setup_detected(true, false, false));
    }

    #[test]
    fn prior_setup_detected_first_run_completed() {
        assert!(prior_setup_detected(false, true, false));
    }

    #[test]
    fn prior_setup_detected_token_file_exists() {
        assert!(prior_setup_detected(false, false, true));
    }

    #[test]
    fn prior_setup_not_detected_on_fresh_install() {
        assert!(!prior_setup_detected(false, false, false));
    }

    #[test]
    fn prior_setup_detected_multiple_signals() {
        assert!(prior_setup_detected(true, true, true));
    }

    #[test]
    fn payload_fields_preserved() {
        let p = build_payload(
            "sign-in".into(),
            "SteadyState".into(),
            true,
            false,
            true,
            true,
            false,
            true,
            true,
            true,
            false,
            true,
            Some(45),
            false,
            2,
            8,
            false,
            "0.10.305",
        );
        assert_eq!(p.surface, "sign-in");
        assert_eq!(p.lifecycle_state, "SteadyState");
        assert!(p.install_completed);
        assert_eq!(p.token_file_age_minutes, Some(45));
        assert_eq!(p.probe_attempts, 2);
        assert_eq!(p.app_version, "0.10.305");
    }

    #[test]
    fn redact_home_replaces_home_dir() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/testuser".to_string());
        let path = format!("{home}/.hq/cognito-tokens.json");
        let redacted = redact_home(&path);
        assert_eq!(redacted, "~/.hq/cognito-tokens.json");
        assert!(!redacted.contains(&home));
    }

    #[test]
    fn redact_home_leaves_non_home_paths_alone() {
        let path = "/var/log/hq/something.log";
        assert_eq!(redact_home(path), path);
    }

    #[test]
    fn build_payload_fresh_install_not_prior_setup() {
        let p = build_payload(
            "onboarding".into(),
            "NeedsInstall".into(),
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            None,
            false,
            1,
            2,
            false,
            "0.10.305",
        );
        assert!(!prior_setup_detected(
            p.install_completed,
            p.first_run_completed,
            p.token_file_exists,
        ));
    }

    #[test]
    fn unreadable_token_store_stays_unknown_in_startup_diagnostics() {
        assert_eq!(
            stored_token_presence_label(StoredTokenPresence::Present),
            "present"
        );
        assert_eq!(
            stored_token_presence_label(StoredTokenPresence::Absent),
            "absent"
        );
        assert_eq!(
            stored_token_presence_label(StoredTokenPresence::Unreadable),
            "unknown"
        );
        assert_eq!(
            session_restore_state_tag(
                false,
                stored_token_presence_label(StoredTokenPresence::Unreadable),
            ),
            "unauthenticated_token_unknown"
        );
    }

    #[test]
    fn startup_diagnostic_tags_are_bounded_and_explain_restore_state() {
        assert_eq!(
            startup_diagnostic_tags(false, "present", Some(5_000), "loading").as_pairs(),
            [
                ("session_restore_state", "unauthenticated_with_token"),
                ("token_present", "present"),
                ("keychain_status", "not_used_token_file"),
                ("ms_since_launch", "5000-29999ms"),
                ("prior_surface", "loading"),
            ]
        );
        assert_eq!(token_presence_tag("permission-denied"), "unknown");
        assert_eq!(session_restore_state_tag(false, "absent"), "signed_out");
        assert_eq!(
            session_restore_state_tag(true, "unknown"),
            "authenticated_token_unknown"
        );
        assert_eq!(ms_since_launch_tag(Some(0)), "0-999ms");
        assert_eq!(ms_since_launch_tag(Some(999)), "0-999ms");
        assert_eq!(ms_since_launch_tag(Some(1_000)), "1000-4999ms");
        assert_eq!(ms_since_launch_tag(Some(4_999)), "1000-4999ms");
        assert_eq!(ms_since_launch_tag(Some(5_000)), "5000-29999ms");
        assert_eq!(ms_since_launch_tag(Some(29_999)), "5000-29999ms");
        assert_eq!(ms_since_launch_tag(Some(30_000)), "30000-119999ms");
        assert_eq!(ms_since_launch_tag(Some(119_999)), "30000-119999ms");
        assert_eq!(ms_since_launch_tag(Some(120_000)), "120000ms+");
        assert_eq!(ms_since_launch_tag(None), "unknown");
        assert_eq!(prior_surface_tag("loading"), "loading");
        assert_eq!(prior_surface_tag("onboarding"), "onboarding");
        assert_eq!(prior_surface_tag("arbitrary-user-data"), "unknown");
        assert_eq!(KEYCHAIN_STATUS_TAG, "not_used_token_file");
    }
}
