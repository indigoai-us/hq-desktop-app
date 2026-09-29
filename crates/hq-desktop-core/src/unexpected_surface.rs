use crate::cognito::StoredTokenPresence;
use crate::lifecycle::{HqRootProbe, LifecycleInputs};
use crate::paths::ResolvedProgramKind;

/// Returns true when the machine shows evidence it was already set up,
/// making a sign-in or onboarding surface unexpected.
pub fn prior_setup_detected(
    install_completed: bool,
    first_run_completed: bool,
    had_machine_id: bool,
    hq_root_valid: bool,
    install_in_progress: bool,
    manifest_incomplete: bool,
) -> bool {
    install_completed
        || first_run_completed
        || (!install_in_progress && !manifest_incomplete && had_machine_id && hq_root_valid)
}

/// Decide whether a startup surface is reportable while preserving sign-in
/// token evidence and InstalledFirstRun reports. Only the three fresh/incomplete
/// install states are suppressed when no prior setup evidence exists.
pub fn should_report_unexpected_surface(
    surface: &str,
    lifecycle_state: &str,
    prior_setup: bool,
    sign_in_prior_setup: bool,
) -> bool {
    match (surface, lifecycle_state) {
        ("onboarding", "NeedsInstall" | "NeedsAuthForInstall" | "InstallResume") => prior_setup,
        ("onboarding", _) => true,
        ("sign-in", _) => sign_in_prior_setup,
        _ => prior_setup,
    }
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

/// Limit auth-session and refresh-failure diagnostics to stable buckets.
pub fn auth_session_status_tag(status: &str) -> &'static str {
    match status {
        "active" => "active",
        "credentials_absent" => "credentials_absent",
        "credentials_invalid" => "credentials_invalid",
        "refresh_temporarily_unavailable" => "refresh_temporarily_unavailable",
        "non_human_principal" => "non_human_principal",
        _ => "unknown",
    }
}

pub fn refresh_failure_class_tag(class: &str) -> &'static str {
    match class {
        "none" => "none",
        "network" => "network",
        "timeout" => "timeout",
        "http_4xx" => "http_4xx",
        "http_5xx" => "http_5xx",
        "http_other" => "http_other",
        "response_decode" => "response_decode",
        "unknown" => "unknown",
        _ => "unknown",
    }
}

pub fn refresh_failure_class_for_session_tag(status: &str, class: &str) -> &'static str {
    let status = auth_session_status_tag(status);
    let class = refresh_failure_class_tag(class);
    if status == "refresh_temporarily_unavailable" && class == "none" {
        "unknown"
    } else {
        class
    }
}

/// Cognito startup restores from ~/.hq/cognito-tokens.json, not macOS Keychain.
pub const KEYCHAIN_STATUS_TAG: &str = "not_used_token_file";

/// Startup-only observations needed to explain the lifecycle verdict without
/// attaching filesystem paths or other user data to the Sentry event.
#[derive(Debug, Clone, Copy)]
pub struct StartupLifecycleInputs {
    pub inputs: LifecycleInputs,
    pub hq_root_probe: Option<HqRootProbe>,
    pub hq_program_kind: Option<ResolvedProgramKind>,
    pub node_program_kind: Option<ResolvedProgramKind>,
    pub require_local_toolchain_demoted: bool,
}

fn bool_tag(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn hq_root_invalid_reason_tag(probe: Option<HqRootProbe>) -> &'static str {
    match probe {
        Some(HqRootProbe::Valid) => "none",
        Some(HqRootProbe::Missing) => "missing",
        Some(HqRootProbe::Unreadable) => "unreadable",
        None => "unobserved",
    }
}

fn program_resolved_tag(kind: Option<ResolvedProgramKind>) -> &'static str {
    match kind {
        Some(ResolvedProgramKind::NotResolved) => "false",
        Some(_) => "true",
        None => "not_observed",
    }
}

fn program_kind_tag(kind: Option<ResolvedProgramKind>) -> &'static str {
    match kind {
        Some(ResolvedProgramKind::Exe) => "exe",
        Some(ResolvedProgramKind::CmdOrBat) => "cmd_or_bat",
        Some(ResolvedProgramKind::Extensionless) => "extensionless",
        Some(ResolvedProgramKind::OtherExtension) => "other_extension",
        Some(ResolvedProgramKind::NotResolved) => "not_resolved",
        None => "not_observed",
    }
}

/// The low-cardinality Sentry tags for an unexpected startup surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupDiagnosticTags {
    pub session_restore_state: &'static str,
    pub token_present: &'static str,
    pub keychain_status: &'static str,
    pub ms_since_launch: &'static str,
    pub prior_surface: &'static str,
    pub install_completed: &'static str,
    pub first_run_completed: &'static str,
    pub had_machine_id: &'static str,
    pub config_valid: &'static str,
    pub hq_root_valid: &'static str,
    pub hq_root_invalid_reason: &'static str,
    pub has_auth: &'static str,
    pub install_in_progress: &'static str,
    pub consent_answered: &'static str,
    pub evidence_unreadable: &'static str,
    pub hq_resolved: &'static str,
    pub hq_resolved_program_kind: &'static str,
    pub node_resolved: &'static str,
    pub node_resolved_program_kind: &'static str,
    pub require_local_toolchain_demoted: &'static str,
    pub auth_session_status: &'static str,
    pub refresh_failure_class: &'static str,
    pub invalidation_marker_present: bool,
    pub first_read_result: &'static str,
    pub recheck_read_result: &'static str,
}

impl StartupDiagnosticTags {
    /// Keep the Sentry keys and values together so tests cover the reporter contract.
    pub fn as_pairs(self) -> [(&'static str, &'static str); 25] {
        [
            ("session_restore_state", self.session_restore_state),
            ("token_present", self.token_present),
            ("keychain_status", self.keychain_status),
            ("ms_since_launch", self.ms_since_launch),
            ("prior_surface", self.prior_surface),
            ("install_completed", self.install_completed),
            ("first_run_completed", self.first_run_completed),
            ("had_machine_id", self.had_machine_id),
            ("config_valid", self.config_valid),
            ("hq_root_valid", self.hq_root_valid),
            ("hq_root_invalid_reason", self.hq_root_invalid_reason),
            ("has_auth", self.has_auth),
            ("install_in_progress", self.install_in_progress),
            ("consent_answered", self.consent_answered),
            ("evidence_unreadable", self.evidence_unreadable),
            ("hq_resolved", self.hq_resolved),
            ("hq_resolved_program_kind", self.hq_resolved_program_kind),
            ("node_resolved", self.node_resolved),
            (
                "node_resolved_program_kind",
                self.node_resolved_program_kind,
            ),
            (
                "require_local_toolchain_demoted",
                self.require_local_toolchain_demoted,
            ),
            ("auth_session_status", self.auth_session_status),
            ("refresh_failure_class", self.refresh_failure_class),
            (
                "invalidation_marker_present",
                bool_tag(self.invalidation_marker_present),
            ),
            ("first_read_result", self.first_read_result),
            ("recheck_read_result", self.recheck_read_result),
        ]
    }
}

/// Build a bounded diagnostic snapshot for the unexpected-surface reporter.
pub fn startup_diagnostic_tags(
    authenticated: bool,
    token_presence: &str,
    elapsed_ms: Option<u128>,
    prior_surface: &str,
    lifecycle: StartupLifecycleInputs,
) -> StartupDiagnosticTags {
    startup_diagnostic_tags_with_auth_session(
        authenticated,
        token_presence,
        elapsed_ms,
        prior_surface,
        lifecycle,
        "unknown",
        "none",
    )
}

/// Build startup tags with the native auth status and bounded refresh class.
pub fn startup_diagnostic_tags_with_auth_session(
    authenticated: bool,
    token_presence: &str,
    elapsed_ms: Option<u128>,
    prior_surface: &str,
    lifecycle: StartupLifecycleInputs,
    auth_session_status: &str,
    refresh_failure_class: &str,
) -> StartupDiagnosticTags {
    let inputs = lifecycle.inputs;
    #[cfg(test)]
    let token_diagnostics = if !authenticated && token_presence_tag(token_presence) == "present" {
        crate::cognito::startup_token_store_diagnostics()
    } else {
        crate::cognito::StartupTokenStoreDiagnostics {
            invalidation_marker_present: false,
            first_read_result: "not_checked",
            recheck_read_result: "not_checked",
        }
    };
    #[cfg(not(test))]
    let token_diagnostics = crate::cognito::StartupTokenStoreDiagnostics {
        invalidation_marker_present: false,
        first_read_result: "not_checked",
        recheck_read_result: "not_checked",
    };
    StartupDiagnosticTags {
        session_restore_state: session_restore_state_tag(authenticated, token_presence),
        token_present: token_presence_tag(token_presence),
        keychain_status: KEYCHAIN_STATUS_TAG,
        ms_since_launch: ms_since_launch_tag(elapsed_ms),
        prior_surface: prior_surface_tag(prior_surface),
        install_completed: bool_tag(inputs.install_completed),
        first_run_completed: bool_tag(inputs.first_run_completed),
        had_machine_id: bool_tag(inputs.had_machine_id),
        config_valid: bool_tag(inputs.config_valid),
        hq_root_valid: bool_tag(inputs.hq_root_valid),
        hq_root_invalid_reason: hq_root_invalid_reason_tag(lifecycle.hq_root_probe),
        has_auth: bool_tag(inputs.has_auth),
        install_in_progress: bool_tag(inputs.install_in_progress),
        consent_answered: bool_tag(inputs.consent_answered),
        evidence_unreadable: bool_tag(inputs.evidence_unreadable),
        hq_resolved: program_resolved_tag(lifecycle.hq_program_kind),
        hq_resolved_program_kind: program_kind_tag(lifecycle.hq_program_kind),
        node_resolved: program_resolved_tag(lifecycle.node_program_kind),
        node_resolved_program_kind: program_kind_tag(lifecycle.node_program_kind),
        require_local_toolchain_demoted: bool_tag(lifecycle.require_local_toolchain_demoted),
        auth_session_status: auth_session_status_tag(auth_session_status),
        refresh_failure_class: refresh_failure_class_for_session_tag(
            auth_session_status,
            refresh_failure_class,
        ),
        invalidation_marker_present: token_diagnostics.invalidation_marker_present,
        first_read_result: token_diagnostics.first_read_result,
        recheck_read_result: token_diagnostics.recheck_read_result,
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
        assert!(prior_setup_detected(
            true, false, false, false, false, false
        ));
    }

    #[test]
    fn prior_setup_detected_first_run_completed() {
        assert!(prior_setup_detected(
            false, true, false, false, false, false
        ));
    }

    #[test]
    fn prior_setup_detected_with_machine_id_and_valid_hq_root() {
        assert!(prior_setup_detected(false, false, true, true, false, false));
    }

    #[test]
    fn interrupted_first_install_is_not_prior_setup() {
        assert!(!prior_setup_detected(false, false, true, true, true, false));
    }

    #[test]
    fn incomplete_manifest_evidence_excludes_machine_id_and_root_from_prior_setup() {
        assert!(!prior_setup_detected(false, false, true, true, false, true));
    }

    #[test]
    fn completion_markers_override_install_in_progress() {
        assert!(prior_setup_detected(true, false, true, true, true, true));
        assert!(prior_setup_detected(false, true, true, true, true, true));
    }

    #[test]
    fn needs_install_remains_reportable_with_completed_or_lost_progress_marker() {
        assert!(should_report_unexpected_surface(
            "onboarding",
            "NeedsInstall",
            prior_setup_detected(true, false, true, true, true, true),
            false,
        ));
        assert!(should_report_unexpected_surface(
            "onboarding",
            "NeedsInstall",
            prior_setup_detected(false, false, true, true, false, false),
            false,
        ));
    }

    #[test]
    fn prior_setup_not_detected_on_fresh_install() {
        assert!(!prior_setup_detected(
            false, false, false, false, false, false
        ));
    }

    #[test]
    fn prior_setup_detected_multiple_signals() {
        assert!(prior_setup_detected(true, true, false, false, false, false));
    }

    #[test]
    fn a_machine_id_without_a_valid_hq_root_is_not_prior_setup_evidence() {
        assert!(!prior_setup_detected(
            false, false, true, false, false, false
        ));
    }

    #[test]
    fn fresh_install_onboarding_states_are_not_reported_without_prior_setup() {
        for state in ["NeedsInstall", "NeedsAuthForInstall", "InstallResume"] {
            assert!(!should_report_unexpected_surface(
                "onboarding",
                state,
                false,
                false
            ));
        }
    }

    #[test]
    fn installed_first_run_remains_reportable_without_marker_evidence() {
        assert!(should_report_unexpected_surface(
            "onboarding",
            "InstalledFirstRun",
            false,
            false,
        ));
    }

    #[test]
    fn sign_in_retains_token_file_evidence_without_completion_markers() {
        assert!(should_report_unexpected_surface(
            "sign-in",
            "SteadyState",
            false,
            true
        ));
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
            false,
            false,
            false,
            false,
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
        let _home_lock = crate::cognito::HQ_TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let isolated_home = tempfile::tempdir().expect("isolated test home");
        std::env::set_var("HQ_TEST_HOME", isolated_home.path());
        let tags = startup_diagnostic_tags_with_auth_session(
            false,
            "present",
            Some(5_000),
            "loading",
            StartupLifecycleInputs {
                inputs: LifecycleInputs {
                    install_completed: true,
                    first_run_completed: true,
                    had_machine_id: true,
                    config_valid: false,
                    hq_root_valid: true,
                    has_auth: true,
                    install_in_progress: false,
                    consent_answered: true,
                    evidence_unreadable: false,
                },
                hq_root_probe: Some(HqRootProbe::Valid),
                hq_program_kind: Some(ResolvedProgramKind::Exe),
                node_program_kind: Some(ResolvedProgramKind::Exe),
                require_local_toolchain_demoted: false,
            },
            "credentials_invalid",
            "http_4xx",
        );
        assert!(
            tags.as_pairs()
                .iter()
                .any(|(key, _)| *key == "hq_root_valid"),
            "the existing unexpected-surface event must tag the lifecycle classifier inputs"
        );
        assert!(
            tags.as_pairs()
                .iter()
                .any(|(key, _)| *key == "auth_session_status"),
            "unexpected startup events must identify the authoritative auth-session status"
        );
        assert!(
            tags.as_pairs()
                .iter()
                .any(|(key, _)| *key == "refresh_failure_class"),
            "unexpected startup events must identify the bounded refresh failure class"
        );
        assert_eq!(
            tags.as_pairs(),
            [
                ("session_restore_state", "unauthenticated_with_token"),
                ("token_present", "present"),
                ("keychain_status", "not_used_token_file"),
                ("ms_since_launch", "5000-29999ms"),
                ("prior_surface", "loading"),
                ("install_completed", "true"),
                ("first_run_completed", "true"),
                ("had_machine_id", "true"),
                ("config_valid", "false"),
                ("hq_root_valid", "true"),
                ("hq_root_invalid_reason", "none"),
                ("has_auth", "true"),
                ("install_in_progress", "false"),
                ("consent_answered", "true"),
                ("evidence_unreadable", "false"),
                ("hq_resolved", "true"),
                ("hq_resolved_program_kind", "exe"),
                ("node_resolved", "true"),
                ("node_resolved_program_kind", "exe"),
                ("require_local_toolchain_demoted", "false"),
                ("auth_session_status", "credentials_invalid"),
                ("refresh_failure_class", "http_4xx"),
                ("invalidation_marker_present", "false"),
                ("first_read_result", "ok_none"),
                ("recheck_read_result", "ok_none"),
            ]
        );
        assert_eq!(
            auth_session_status_tag("person@example.com"),
            "unknown",
            "free-form identity values must never become tags"
        );
        std::env::remove_var("HQ_TEST_HOME");
        for (status, tag) in [
            ("active", "active"),
            ("credentials_absent", "credentials_absent"),
            ("credentials_invalid", "credentials_invalid"),
            (
                "refresh_temporarily_unavailable",
                "refresh_temporarily_unavailable",
            ),
            ("non_human_principal", "non_human_principal"),
        ] {
            assert_eq!(auth_session_status_tag(status), tag);
        }
        assert_eq!(
            refresh_failure_class_tag("eyJhbGciOiJ..."),
            "unknown",
            "free-form or credential values must never become tags"
        );
        assert_eq!(
            refresh_failure_class_for_session_tag("refresh_temporarily_unavailable", "none"),
            "unknown"
        );
        assert_eq!(
            refresh_failure_class_for_session_tag("credentials_invalid", "none"),
            "none"
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

    fn token_store_tags(home: &std::path::Path) -> serde_json::Value {
        std::env::set_var("HQ_TEST_HOME", home);
        let tags = startup_diagnostic_tags_with_auth_session(
            false,
            "present",
            None,
            "sign-in",
            StartupLifecycleInputs {
                inputs: LifecycleInputs {
                    install_completed: true,
                    first_run_completed: true,
                    had_machine_id: true,
                    config_valid: true,
                    hq_root_valid: true,
                    has_auth: false,
                    install_in_progress: false,
                    consent_answered: true,
                    evidence_unreadable: false,
                },
                hq_root_probe: Some(HqRootProbe::Valid),
                hq_program_kind: None,
                node_program_kind: None,
                require_local_toolchain_demoted: false,
            },
            "credentials_invalid",
            "http_4xx",
        );
        serde_json::Value::Object(
            tags.as_pairs()
                .into_iter()
                .map(|(key, value)| {
                    let value = if key == "invalidation_marker_present" {
                        serde_json::json!(value == "true")
                    } else {
                        serde_json::json!(value)
                    };
                    (key.to_string(), value)
                })
                .collect(),
        )
    }

    #[test]
    fn startup_diagnostics_distinguish_invalidated_token_from_readable_token() {
        let _home_lock = crate::cognito::HQ_TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = tempfile::tempdir().expect("temp home");
        let token_dir = home.path().join(".hq");
        std::fs::create_dir_all(&token_dir).expect("token dir");
        let path = token_dir.join("cognito-tokens.json");
        let access_token = "test-access-token";
        std::fs::write(
            &path,
            serde_json::json!({
                "accessToken": access_token,
                "idToken": null,
                "refreshToken": "test-refresh-token",
                "expiresAt": 1
            })
            .to_string(),
        )
        .expect("token fixture");
        let marker = token_dir.join(format!(
            "cognito-tokens.json.invalid.{}",
            crate::cognito::access_token_fingerprint(access_token)
        ));
        std::fs::write(marker, "").expect("invalidation marker");

        let invalidated = token_store_tags(home.path());
        assert_eq!(invalidated["invalidation_marker_present"], true);
        assert_eq!(invalidated["first_read_result"], "ok_none");
        assert_eq!(invalidated["recheck_read_result"], "ok_none");

        std::fs::remove_file(token_dir.join(format!(
            "cognito-tokens.json.invalid.{}",
            crate::cognito::access_token_fingerprint(access_token)
        )))
        .expect("remove marker");
        let readable = token_store_tags(home.path());
        assert_eq!(readable["invalidation_marker_present"], false);
        assert_eq!(readable["first_read_result"], "ok_some");
        assert_eq!(readable["recheck_read_result"], "ok_some");
        std::env::remove_var("HQ_TEST_HOME");
    }

    #[test]
    fn lifecycle_tags_report_missing_tools_and_unobserved_platforms_truthfully() {
        let tags = startup_diagnostic_tags(
            true,
            "present",
            Some(1),
            "loading",
            StartupLifecycleInputs {
                inputs: LifecycleInputs {
                    install_completed: true,
                    first_run_completed: true,
                    had_machine_id: true,
                    config_valid: true,
                    hq_root_valid: false,
                    has_auth: true,
                    install_in_progress: false,
                    consent_answered: true,
                    evidence_unreadable: false,
                },
                hq_root_probe: Some(HqRootProbe::Missing),
                hq_program_kind: Some(ResolvedProgramKind::NotResolved),
                node_program_kind: None,
                require_local_toolchain_demoted: true,
            },
        );

        let pairs = tags.as_pairs();
        assert!(pairs.contains(&("hq_root_invalid_reason", "missing")));
        assert!(pairs.contains(&("hq_resolved", "false")));
        assert!(pairs.contains(&("hq_resolved_program_kind", "not_resolved")));
        assert!(pairs.contains(&("node_resolved", "not_observed")));
        assert!(pairs.contains(&("node_resolved_program_kind", "not_observed")));
        assert!(pairs.contains(&("require_local_toolchain_demoted", "true")));
    }
}
