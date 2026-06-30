//! Install->sync lifecycle classifier (Phase 2). Sits above first_run::LaunchKind
//! and decides, at launch, whether the unified app is an onboarding installer,
//! a resume/repair screen, a sign-in-for-install screen, or the steady-state
//! sync tray agent. Pure over its inputs so it is directly unit-testable.

use serde_json::{Map, Value};

/// The six launch lifecycle states (see MIGRATION.md section 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    /// No completed install marker and no valid legacy installed shape.
    NeedsInstall,
    /// An install marker says a step is in-progress or failed -> resume/repair.
    InstallResume,
    /// Config could be prepared but there is no usable auth token yet.
    NeedsAuthForInstall,
    /// Install completed, sync firstRunCompleted is false, and there was no
    /// prior machineId at classification -> finish onboarding then first sync.
    InstalledFirstRun,
    /// Valid existing sync install (machineId present) without the new
    /// onboarding flags -> normal popover + existing auto-sync notice logic.
    InstalledLegacyUpdate,
    /// Install completed and firstRunCompleted true -> hidden tray agent.
    SteadyState,
}

/// I/O-resolved signals the app passes in. All booleans are computed by the
/// caller from the filesystem / auth layer; the classifier itself does no I/O.
#[derive(Debug, Clone, Copy)]
pub struct LifecycleInputs {
    /// menubar.json `installCompleted == true`.
    pub install_completed: bool,
    /// menubar.json `firstRunCompleted == true`.
    pub first_run_completed: bool,
    /// menubar.json `machineId` present and non-empty (app ran before).
    pub had_machine_id: bool,
    /// config.json parses as the sync HqConfig shape.
    pub config_valid: bool,
    /// HQ root exists and contains the installed hq-core template/manifest shape.
    pub hq_root_valid: bool,
    /// A usable (unexpired) Cognito token exists.
    pub has_auth: bool,
    /// An install marker indicates an in-progress or failed install step.
    pub install_in_progress: bool,
}

/// Classifier verdict: the state plus whether the caller should backfill
/// `installCompleted: true` (legacy sync users who predate the install marker).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleVerdict {
    pub state: LifecycleState,
    /// True when a legacy install was recognized as installed via machineId +
    /// valid config + valid HQ root (no installCompleted marker yet). The caller
    /// should write installCompleted:true + a migration marker. Never force these
    /// users through the installer wizard.
    pub needs_install_backfill: bool,
}

/// Pure helper: extract LifecycleInputs' menubar-derived flags from a parsed
/// menubar.json object. (config_valid/hq_root_valid/has_auth/install_in_progress
/// still come from the caller; this only reads the menubar map.)
pub fn menubar_flags(obj: &Map<String, Value>) -> (bool, bool, bool) {
    let install_completed = obj
        .get("installCompleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let first_run_completed = obj
        .get("firstRunCompleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let had_machine_id = obj
        .get("machineId")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    (install_completed, first_run_completed, had_machine_id)
}

/// The pure classifier.
pub fn classify_lifecycle(inputs: LifecycleInputs) -> LifecycleVerdict {
    let is_installed = (inputs.install_completed || inputs.had_machine_id)
        && inputs.config_valid
        && inputs.hq_root_valid;
    let needs_install_backfill = is_installed && !inputs.install_completed;

    let state = if inputs.install_in_progress {
        LifecycleState::InstallResume
    } else if is_installed {
        if inputs.first_run_completed {
            LifecycleState::SteadyState
        } else if inputs.had_machine_id {
            LifecycleState::InstalledLegacyUpdate
        } else {
            LifecycleState::InstalledFirstRun
        }
    } else if !inputs.has_auth {
        LifecycleState::NeedsAuthForInstall
    } else {
        LifecycleState::NeedsInstall
    };

    LifecycleVerdict {
        state,
        needs_install_backfill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input() -> LifecycleInputs {
        LifecycleInputs {
            install_completed: false,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: false,
            hq_root_valid: false,
            has_auth: false,
            install_in_progress: false,
        }
    }

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn classify_needs_install_when_not_installed_and_authenticated() {
        let verdict = classify_lifecycle(LifecycleInputs {
            has_auth: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::NeedsInstall);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn classify_install_resume_takes_precedence_over_installed_flags() {
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: true,
        });

        assert_eq!(verdict.state, LifecycleState::InstallResume);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn classify_needs_auth_for_install_when_not_installed_and_unauthenticated() {
        let verdict = classify_lifecycle(LifecycleInputs {
            has_auth: false,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::NeedsAuthForInstall);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn classify_installed_first_run_for_completed_install_without_prior_machine_id() {
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
        });

        assert_eq!(verdict.state, LifecycleState::InstalledFirstRun);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn classify_installed_legacy_update_and_requests_backfill() {
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: false,
            first_run_completed: false,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
        });

        assert_eq!(verdict.state, LifecycleState::InstalledLegacyUpdate);
        assert!(verdict.needs_install_backfill);
    }

    #[test]
    fn classify_steady_state_for_completed_install_and_completed_first_run() {
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: false,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
        });

        assert_eq!(verdict.state, LifecycleState::SteadyState);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn not_installed_routes_only_on_auth_signal() {
        let authenticated = classify_lifecycle(LifecycleInputs {
            has_auth: true,
            ..input()
        });
        let unauthenticated = classify_lifecycle(LifecycleInputs {
            has_auth: false,
            ..input()
        });

        assert_eq!(authenticated.state, LifecycleState::NeedsInstall);
        assert_eq!(unauthenticated.state, LifecycleState::NeedsAuthForInstall);
        assert!(!authenticated.needs_install_backfill);
        assert!(!unauthenticated.needs_install_backfill);
    }

    #[test]
    fn explicit_install_completed_without_valid_config_is_not_installed() {
        let authenticated = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            config_valid: false,
            hq_root_valid: true,
            has_auth: true,
            ..input()
        });
        let unauthenticated = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            config_valid: false,
            hq_root_valid: true,
            has_auth: false,
            ..input()
        });

        assert_eq!(authenticated.state, LifecycleState::NeedsInstall);
        assert_eq!(unauthenticated.state, LifecycleState::NeedsAuthForInstall);
        assert!(!authenticated.needs_install_backfill);
        assert!(!unauthenticated.needs_install_backfill);
    }

    #[test]
    fn explicit_install_completed_without_valid_hq_root_is_not_installed() {
        let authenticated = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            config_valid: true,
            hq_root_valid: false,
            has_auth: true,
            ..input()
        });
        let unauthenticated = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            config_valid: true,
            hq_root_valid: false,
            has_auth: false,
            ..input()
        });

        assert_eq!(authenticated.state, LifecycleState::NeedsInstall);
        assert_eq!(unauthenticated.state, LifecycleState::NeedsAuthForInstall);
        assert!(!authenticated.needs_install_backfill);
        assert!(!unauthenticated.needs_install_backfill);
    }

    #[test]
    fn needs_install_backfill_false_for_explicit_install_completed_paths() {
        let first_run = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
        });
        let steady_state = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
        });

        assert_eq!(first_run.state, LifecycleState::InstalledFirstRun);
        assert_eq!(steady_state.state, LifecycleState::SteadyState);
        assert!(!first_run.needs_install_backfill);
        assert!(!steady_state.needs_install_backfill);
    }

    #[test]
    fn menubar_flags_defaults_absent_values_to_false() {
        assert_eq!(menubar_flags(&Map::new()), (false, false, false));
    }

    #[test]
    fn menubar_flags_reads_present_bool_and_non_empty_machine_id() {
        let obj = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "abc-123"
        }));

        assert_eq!(menubar_flags(&obj), (true, true, true));
    }

    #[test]
    fn menubar_flags_treats_empty_machine_id_as_absent() {
        let obj = map(json!({
            "installCompleted": true,
            "firstRunCompleted": false,
            "machineId": ""
        }));

        assert_eq!(menubar_flags(&obj), (true, false, false));
    }

    #[test]
    fn menubar_flags_ignores_wrong_types() {
        let obj = map(json!({
            "installCompleted": "true",
            "firstRunCompleted": 1,
            "machineId": 123
        }));

        assert_eq!(menubar_flags(&obj), (false, false, false));
    }
}
