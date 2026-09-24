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
}
