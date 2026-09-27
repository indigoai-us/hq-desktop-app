//! Install->sync lifecycle classifier (Phase 2). Sits above first_run::LaunchKind
//! and decides, at launch, whether the unified app is an onboarding installer,
//! a resume/repair screen, a sign-in-for-install screen, or the steady-state
//! sync tray agent. Pure over its inputs so it is directly unit-testable.

use std::path::Path;

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
    /// Installed, but the compulsory consent question has no answer on this
    /// machine -> the wizard asks that one question, then first run is done.
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
    /// The person has answered the blocking telemetry consent question at least
    /// once on this machine (menubar.json carries the `telemetryOptInAnsweredAt`
    /// provenance marker). Consent is compulsory, so an installed machine whose
    /// consent is UNANSWERED must be routed back through onboarding rather than
    /// classified as an already-set-up machine that skips it.
    pub consent_answered: bool,
    /// At least one piece of install evidence could not be READ this launch —
    /// the HQ folder was unreachable (permission denied, an unmounted volume,
    /// an I/O error) or the token store could not be read — as opposed to
    /// being confirmed absent.
    ///
    /// "Could not tell" is not "not installed". A machine that already
    /// finished first run keeps its steady-state surface when the evidence is
    /// unreadable; the alternative is dropping a long-set-up person onto the
    /// fresh-install Welcome card after an auto-update relaunch briefly makes
    /// the read fail (customer report 2026-09-19, v0.10.296 -> v0.10.297).
    pub evidence_unreadable: bool,
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
    /// True when the machine is installed and consent is answered but
    /// `firstRunCompleted` is missing (an older build never wrote it, or the
    /// settings file lost it). Setup is judged done from what is on disk; the
    /// caller writes the marker back so later launches — and the Dock click,
    /// which reads the same verdict — never fall into the installer again.
    pub needs_first_run_backfill: bool,
}

/// HQ is installed on this computer only when its tools are here too. A synced
/// workspace or a completion marker is not proof that this computer has the
/// executables setup needs: missing tools return to installation, without
/// backfilling completion markers. The installer then puts back what is missing.
///
/// "Tools present" means `hq` and `node` resolve on this computer. A bundled
/// CLI *version* mismatch is not absence — see
/// [`tools_present_for_lifecycle_gate`].
pub fn require_local_toolchain(verdict: LifecycleVerdict, tools_present: bool) -> LifecycleVerdict {
    if tools_present {
        verdict
    } else {
        LifecycleVerdict {
            state: LifecycleState::NeedsInstall,
            needs_install_backfill: false,
            needs_first_run_backfill: false,
        }
    }
}

/// Whether the launch install-gate should treat local tools as present.
///
/// Only unresolved `hq` or `node` counts as missing. A release bundle can
/// also require a matching CLI version (`bundled_hq_cli_ready`); that check
/// belongs to dependency install, not launch. After an auto-update the new
/// bundle's `version.txt` disagrees with the still-installed CLI until the
/// updater runs, and treating that as `NeedsInstall` re-opens the Welcome
/// card on every restart (feedback #2290 / v0.10.260).
pub fn tools_present_for_lifecycle_gate(hq_resolved: bool, node_resolved: bool) -> bool {
    hq_resolved && node_resolved
}

/// Desktop activation may not bypass the install wizard. This is distinct
/// from the retired notification popover: completed installs open desktop.
pub fn installation_required(state: LifecycleState) -> bool {
    matches!(
        state,
        LifecycleState::NeedsInstall
            | LifecycleState::InstallResume
            | LifecycleState::NeedsAuthForInstall
    )
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

/// Is the welcome channel's guided setup still owed on this machine?
///
/// The welcome channel (Run Setup in `#welcome`) is for people whose first
/// run completed on a build that has it: the installer writes
/// `welcomeSetupPending` when a brand-new install finishes. A machine that was
/// set up before that flag existed — an existing user updating, whose
/// `firstRunCompleted` was written by an older build or backfilled from disk
/// — has already done its setup another way and must not be greeted with
/// Run Setup again. Machines still mid-install are owed it.
///
/// `welcomeSetupPending: false` (written when the guided run finishes) wins
/// over everything: setup is done.
pub fn welcome_setup_owed(menubar: &Map<String, Value>, hq_root_valid: bool) -> bool {
    match menubar.get("welcomeSetupPending").and_then(Value::as_bool) {
        Some(pending) => pending,
        None => {
            let (_, first_run_completed, _) = menubar_flags(menubar);
            !hq_root_valid || !first_run_completed
        }
    }
}

/// Should finishing the installer (re)arm `welcomeSetupPending`?
///
/// A brand-new install owes the welcome channel's guided run. Re-running the
/// installer because launch misclassified the machine must not reset a
/// finished welcome — otherwise `welcomeSetupCompletedAt` never sticks and
/// the next restart looks like first-run again.
///
/// An already fully set-up machine (`installCompleted + firstRunCompleted +
/// machineId` all present) never owes the guided welcome, so a re-run
/// installer cannot re-arm the flag even when `welcomeSetupCompletedAt` is
/// absent (pre-welcome-flow install).
pub fn should_arm_welcome_setup_pending(menubar: &Map<String, Value>) -> bool {
    if menubar.get("welcomeSetupPending").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if menubar
        .get("welcomeSetupCompletedAt")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return false;
    }
    // An already-set-up machine (all three completion markers) never needs the
    // guided welcome run armed - it completed setup via an older flow that did
    // not write welcomeSetupCompletedAt.
    let (install_completed, first_run_completed, had_machine_id) = menubar_flags(menubar);
    !(install_completed && first_run_completed && had_machine_id)
}

/// Should a stuck `welcomeSetupPending: true` flag be self-healed on this launch?
///
/// During the v0.10.259-v0.10.287 regression window the installer ran on
/// every auto-update restart and wrote `welcomeSetupPending: true`. The only
/// normal writer that clears it is `mark_welcome_setup_complete`, which fires
/// only when the person completes the guided `/setup` run. Users who were
/// fighting the loop never reached that point, leaving an orphaned flag that
/// keeps surfacing the Welcome card on every launch even though the machine is
/// fully set up.
///
/// Returns true when ALL of these hold:
/// - the machine is provably set up: `installCompleted`, `firstRunCompleted`,
///   `hq_root_valid`, and `has_auth` are all true
/// - `welcomeSetupPending` is explicitly `true` (not absent - absence means
///   the flag was never written, handled by `welcome_setup_owed` fallback)
/// - `welcomeSetupCompletedAt` is absent or empty (not yet written by the
///   normal `mark_welcome_setup_complete` path)
///
/// A new install that has not completed setup returns false: it still owes the
/// guided welcome.
pub fn should_backfill_welcome_setup_pending(
    menubar: &Map<String, Value>,
    install_completed: bool,
    first_run_completed: bool,
    hq_root_valid: bool,
    has_auth: bool,
) -> bool {
    if !install_completed || !first_run_completed || !hq_root_valid || !has_auth {
        return false;
    }
    if menubar.get("welcomeSetupPending").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    !menubar
        .get("welcomeSetupCompletedAt")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
}

/// True when `root` exists and contains the installed hq-core template shape
/// (canonical `core/core.yaml`, or legacy top-level `core.yaml`).
pub fn hq_root_valid(root: &Path) -> bool {
    root.is_dir()
        && (root.join("core").join("core.yaml").is_file() || root.join("core.yaml").is_file())
}

/// Outcome of probing the HQ folder on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HqRootProbe {
    /// The folder exists and carries the installed hq-core shape.
    Valid,
    /// The folder was read and is not an installed HQ root.
    Missing,
    /// The folder could not be read: permission denied (macOS TCC on
    /// `~/Documents`, for example), an unmounted volume, or an I/O error.
    Unreadable,
}

/// Probe `root`, distinguishing "not an HQ folder" from "could not look".
///
/// `hq_root_valid` answers false for both, which is what sent an installed
/// machine to the Welcome card when the folder was momentarily unreachable.
pub fn probe_hq_root(root: &Path) -> HqRootProbe {
    match std::fs::metadata(root) {
        Ok(meta) if !meta.is_dir() => HqRootProbe::Missing,
        Ok(_) => {
            if hq_root_valid(root) {
                return HqRootProbe::Valid;
            }
            // The directory is there but the marker read failed for a reason
            // other than absence — treat that as "could not look".
            match std::fs::read_dir(root) {
                Ok(_) => HqRootProbe::Missing,
                Err(_) => HqRootProbe::Unreadable,
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HqRootProbe::Missing,
        Err(_) => HqRootProbe::Unreadable,
    }
}

/// The pure classifier.
pub fn classify_lifecycle(inputs: LifecycleInputs) -> LifecycleVerdict {
    // An install is recognized from what is actually on disk: a valid HQ root
    // plus evidence the machine has been set up before — an explicit
    // completion marker, a prior machineId, a valid config.json, OR usable
    // Cognito auth tokens.
    //
    // `config.json` is deliberately NOT required. The onboarding flow does not
    // reliably write `~/.hq/config.json` (the personal-vault first-push
    // short-circuits when the vault already exists), so gating on it sent a
    // fully set-up user back through the entire onboarding wizard on the next
    // launch/restart. The rule is now "valid HQ folder + (prior setup OR auth
    // on disk) => installed, show the menu bar".
    let has_prior_setup = inputs.install_completed
        || inputs.first_run_completed
        || inputs.had_machine_id
        || inputs.config_valid;
    let is_installed = inputs.hq_root_valid && (has_prior_setup || inputs.has_auth);
    let needs_install_backfill = is_installed && !inputs.install_completed;

    // Installed and consent answered: setup is done whatever the markers say.
    // The `firstRunCompleted` marker is a cache of that fact, not the fact
    // itself — a settings file that lost it must not send a set-up person back
    // through sign-in, folder choice and install.
    let needs_first_run_backfill =
        is_installed && inputs.consent_answered && !inputs.first_run_completed;

    // "Could not read the evidence" must never demote a machine that already
    // completed first run. `first_run_completed` is only ever written after
    // setup (and consent) finished on this computer, so preserving
    // steady-state here cannot wave anyone past onboarding or consent — it
    // only refuses to conclude "brand new machine" from a failed read.
    if inputs.evidence_unreadable && inputs.first_run_completed && !inputs.install_in_progress {
        return LifecycleVerdict {
            state: LifecycleState::SteadyState,
            needs_install_backfill: false,
            needs_first_run_backfill: false,
        };
    }

    let state = if inputs.install_in_progress {
        LifecycleState::InstallResume
    } else if is_installed {
        // Compulsory consent overrides the "already installed, skip onboarding"
        // shortcut: a machine that reached the consent step and quit before
        // answering (setup done + machineId written, but firstRunCompleted still
        // false) must NOT be waved through as a legacy update — that is exactly
        // how quitting at the consent step bypassed consent. Route any installed
        // machine whose consent is unanswered to the first-run state, where the
        // wizard asks the consent question alone. Once consent is answered (or
        // first-run completed), the machine is set up.
        if inputs.first_run_completed {
            LifecycleState::SteadyState
        } else if !inputs.consent_answered {
            LifecycleState::InstalledFirstRun
        } else if inputs.had_machine_id {
            LifecycleState::InstalledLegacyUpdate
        } else {
            LifecycleState::SteadyState
        }
    } else if !inputs.has_auth {
        LifecycleState::NeedsAuthForInstall
    } else {
        LifecycleState::NeedsInstall
    };

    LifecycleVerdict {
        state,
        needs_install_backfill,
        needs_first_run_backfill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn input() -> LifecycleInputs {
        LifecycleInputs {
            install_completed: false,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: false,
            hq_root_valid: false,
            has_auth: false,
            install_in_progress: false,
            consent_answered: false,
            evidence_unreadable: false,
        }
    }

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn unreadable_evidence_preserves_steady_state_for_a_set_up_machine() {
        // The v0.10.297 report: an auto-update relaunch could not read the HQ
        // folder, and a long-installed machine was shown the Welcome card.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            consent_answered: true,
            hq_root_valid: false,
            has_auth: false,
            evidence_unreadable: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::SteadyState);
        assert!(!verdict.needs_install_backfill);
        assert!(!verdict.needs_first_run_backfill);
    }

    #[test]
    fn unreadable_evidence_does_not_wave_a_new_machine_through() {
        let verdict = classify_lifecycle(LifecycleInputs {
            evidence_unreadable: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::NeedsAuthForInstall);
    }

    #[test]
    fn unreadable_evidence_does_not_bypass_an_unanswered_consent() {
        // machineId written, first run never finished: consent is still owed.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            had_machine_id: true,
            hq_root_valid: true,
            evidence_unreadable: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::InstalledFirstRun);
    }

    #[test]
    fn unreadable_evidence_yields_to_an_in_progress_install() {
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            install_in_progress: true,
            evidence_unreadable: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::InstallResume);
    }

    #[test]
    fn real_session_loss_still_reaches_the_setup_card() {
        // Nothing unreadable: the HQ folder is genuinely gone and there is no
        // auth. The install card is the correct surface.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            hq_root_valid: false,
            has_auth: false,
            evidence_unreadable: false,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::NeedsAuthForInstall);
    }

    #[test]
    fn probe_hq_root_reports_valid_missing_and_unreadable() {
        let dir = tempdir().unwrap();

        let missing = dir.path().join("nope");
        assert_eq!(probe_hq_root(&missing), HqRootProbe::Missing);

        let root = dir.path().join("HQ");
        std::fs::create_dir_all(root.join("core")).unwrap();
        assert_eq!(probe_hq_root(&root), HqRootProbe::Missing);
        std::fs::write(root.join("core").join("core.yaml"), "version: 1\n").unwrap();
        assert_eq!(probe_hq_root(&root), HqRootProbe::Valid);

        // A path that exists but is not a directory is not an HQ root.
        let file = dir.path().join("a-file");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(probe_hq_root(&file), HqRootProbe::Missing);
    }

    #[cfg(unix)]
    #[test]
    fn probe_hq_root_reports_unreadable_for_a_permission_denied_folder() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let root = dir.path().join("HQ");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).unwrap();

        let probe = probe_hq_root(&root);

        // Restore before asserting so the tempdir can always clean itself up.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        if unsafe { libc::geteuid() } == 0 {
            // root ignores the mode bits; nothing to assert.
            return;
        }
        assert_eq!(probe, HqRootProbe::Unreadable);
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
            consent_answered: true,
            evidence_unreadable: false,
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
            consent_answered: false,
            evidence_unreadable: false,
        });

        assert_eq!(verdict.state, LifecycleState::InstalledFirstRun);
        assert!(!verdict.needs_install_backfill);
    }

    #[test]
    fn classify_installed_legacy_update_and_requests_backfill() {
        // A genuine legacy sync user who HAS answered consent: no first-run flag
        // yet but consent is on record, so they stay a legacy-update, not sent
        // through onboarding again.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: false,
            first_run_completed: false,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        });

        assert_eq!(verdict.state, LifecycleState::InstalledLegacyUpdate);
        assert!(verdict.needs_install_backfill);
        assert!(verdict.needs_first_run_backfill);
    }

    #[test]
    fn installed_with_consent_answered_is_set_up_even_without_first_run_or_machine_id() {
        // Regression: a set-up, signed-in machine whose settings file lost its
        // `firstRunCompleted` marker (an update relaunch found it missing) must
        // be judged by what is on disk — not sent through the whole installer.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: false,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        });

        assert_eq!(verdict.state, LifecycleState::SteadyState);
        assert!(
            verdict.needs_first_run_backfill,
            "the missing marker is written back"
        );
    }

    #[test]
    fn first_run_backfill_only_when_installed_consent_answered_and_marker_missing() {
        let steady = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            hq_root_valid: true,
            has_auth: true,
            consent_answered: true,
            ..input()
        });
        let unanswered = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            hq_root_valid: true,
            has_auth: true,
            consent_answered: false,
            ..input()
        });
        let not_installed = classify_lifecycle(LifecycleInputs {
            has_auth: true,
            consent_answered: true,
            ..input()
        });
        let resuming = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            hq_root_valid: true,
            has_auth: true,
            consent_answered: true,
            install_in_progress: true,
            ..input()
        });

        assert!(!steady.needs_first_run_backfill);
        assert!(!unanswered.needs_first_run_backfill);
        assert_eq!(unanswered.state, LifecycleState::InstalledFirstRun);
        assert!(!not_installed.needs_first_run_backfill);
        assert_eq!(resuming.state, LifecycleState::InstallResume);
        assert!(
            resuming.needs_first_run_backfill,
            "resume finishes into a set-up machine"
        );
    }

    #[test]
    fn classify_installed_but_unanswered_consent_routes_to_onboarding() {
        // Finding #2: a machine that completed setup (machineId written) but quit
        // at the consent step before answering must NOT be waved through as a
        // legacy update — it must return to onboarding so the blocking consent
        // step runs. This is the exact "quit at consent bypasses consent" bug.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: false,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: false,
            evidence_unreadable: false,
        });

        assert_eq!(
            verdict.state,
            LifecycleState::InstalledFirstRun,
            "unanswered consent must route back to onboarding, not skip it"
        );
    }

    #[test]
    fn updater_restart_reads_persisted_setup_and_consent_before_routing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        let inputs_from_disk = |menubar: &Map<String, Value>| {
            let (install_completed, first_run_completed, had_machine_id) = menubar_flags(menubar);
            let consent_answered = menubar
                .get("telemetryOptInAnsweredAt")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty());
            LifecycleInputs {
                install_completed,
                first_run_completed,
                had_machine_id,
                config_valid: false,
                hq_root_valid: true,
                has_auth: true,
                install_in_progress: false,
                consent_answered,
                evidence_unreadable: false,
            }
        };

        // A post-update process synchronously reads the same persisted markers
        // before lifecycle classification. No update-specific read or write is
        // needed to recover them.
        std::fs::write(
            &path,
            r#"{"installCompleted":true,"firstRunCompleted":true,"machineId":"saved","telemetryOptInAnsweredAt":"2026-09-01T00:00:00Z"}"#,
        )
        .unwrap();
        let completed = match crate::first_run::read_menubar(&path) {
            crate::first_run::MenubarRead::Object(menubar) => menubar,
            other => panic!("expected readable post-update settings, got {other:?}"),
        };
        assert_eq!(
            classify_lifecycle(inputs_from_disk(&completed)).state,
            LifecycleState::SteadyState
        );

        // A persisted unanswered consent remains first-run onboarding after
        // restart; the lifecycle must not infer consent from auth or setup.
        std::fs::write(
            &path,
            r#"{"installCompleted":true,"firstRunCompleted":false,"machineId":"saved"}"#,
        )
        .unwrap();
        let unanswered = match crate::first_run::read_menubar(&path) {
            crate::first_run::MenubarRead::Object(menubar) => menubar,
            other => panic!("expected readable post-update settings, got {other:?}"),
        };
        assert_eq!(
            classify_lifecycle(inputs_from_disk(&unanswered)).state,
            LifecycleState::InstalledFirstRun
        );
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
            consent_answered: true,
            evidence_unreadable: false,
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
    fn completed_install_without_valid_config_is_still_installed() {
        // Regression for the "restart re-runs onboarding" bug: a set-up
        // machine (valid HQ root + an install marker) must NOT be gated on
        // config.json, which onboarding doesn't reliably write.
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

        assert_eq!(authenticated.state, LifecycleState::InstalledFirstRun);
        assert_eq!(unauthenticated.state, LifecycleState::InstalledFirstRun);
        assert!(!authenticated.needs_install_backfill);
        assert!(!unauthenticated.needs_install_backfill);
    }

    #[test]
    fn relaunch_after_onboarding_without_config_reaches_steady_state() {
        // Exact real-world relaunch: onboarding completed (firstRunCompleted +
        // machineId written, HQ folder populated, auth on disk) but config.json
        // was never written. Must go straight to the menu bar, not onboarding.
        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: false,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: false,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        });

        assert_eq!(verdict.state, LifecycleState::SteadyState);
        // No installCompleted marker yet, so the caller should backfill it.
        assert!(verdict.needs_install_backfill);
    }

    #[test]
    fn valid_hq_root_plus_auth_alone_is_installed() {
        // "hq path + cognito login on disk => show the menu bar": a valid HQ
        // root plus usable auth is enough, even with no menubar markers.
        let verdict = classify_lifecycle(LifecycleInputs {
            hq_root_valid: true,
            has_auth: true,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::InstalledFirstRun);
    }

    #[test]
    fn valid_hq_root_without_auth_or_markers_needs_auth() {
        // A populated HQ folder with neither auth nor any prior-setup marker
        // still routes to sign-in, not straight into the menu bar.
        let verdict = classify_lifecycle(LifecycleInputs {
            hq_root_valid: true,
            has_auth: false,
            ..input()
        });

        assert_eq!(verdict.state, LifecycleState::NeedsAuthForInstall);
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
            consent_answered: false,
            evidence_unreadable: false,
        });
        let steady_state = classify_lifecycle(LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        });

        assert_eq!(first_run.state, LifecycleState::InstalledFirstRun);
        assert_eq!(steady_state.state, LifecycleState::SteadyState);
        assert!(!first_run.needs_install_backfill);
        assert!(!steady_state.needs_install_backfill);
    }

    #[test]
    fn welcome_setup_is_owed_to_a_new_install_and_a_machine_still_installing() {
        let pending = map(json!({ "firstRunCompleted": true, "welcomeSetupPending": true }));
        assert!(welcome_setup_owed(&pending, true));
        let installing = map(json!({}));
        assert!(welcome_setup_owed(&installing, false));
        let no_first_run = map(json!({ "machineId": "abc" }));
        assert!(welcome_setup_owed(&no_first_run, true));
    }

    #[test]
    fn welcome_setup_is_not_owed_to_an_existing_set_up_user() {
        // An older build (or the disk backfill) wrote firstRunCompleted and never
        // knew about the welcome channel: this person already ran setup.
        let legacy =
            map(json!({ "machineId": "abc", "installCompleted": true, "firstRunCompleted": true }));
        assert!(!welcome_setup_owed(&legacy, true));
        // Finished the guided run: done for good, whatever else is on disk.
        let finished = map(json!({ "welcomeSetupPending": false }));
        assert!(!welcome_setup_owed(&finished, false));
    }

    #[test]
    fn finishing_the_installer_does_not_rearm_a_completed_welcome() {
        let brand_new = map(json!({}));
        assert!(should_arm_welcome_setup_pending(&brand_new));
        let still_owed = map(json!({ "welcomeSetupPending": true }));
        assert!(should_arm_welcome_setup_pending(&still_owed));
        let finished = map(json!({ "welcomeSetupPending": false }));
        assert!(!should_arm_welcome_setup_pending(&finished));
        let stamped = map(json!({ "welcomeSetupCompletedAt": "2026-09-16T13:13:12Z" }));
        assert!(!should_arm_welcome_setup_pending(&stamped));
    }

    #[test]
    fn finishing_the_installer_does_not_rearm_an_already_set_up_machine() {
        // Regression guard: an already-set-up machine (all three markers) must
        // not have welcomeSetupPending re-armed by a re-run installer, even
        // when welcomeSetupCompletedAt was never written (pre-welcome-flow setup).
        let set_up = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
        }));
        assert!(!should_arm_welcome_setup_pending(&set_up));

        // With an orphaned pending=true (as left by the v0.10.259 regression):
        // still must not re-arm.
        let orphaned = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
            "welcomeSetupPending": true,
        }));
        assert!(!should_arm_welcome_setup_pending(&orphaned));

        // A brand-new install (no machineId yet) still owes the welcome.
        let brand_new = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
        }));
        assert!(should_arm_welcome_setup_pending(&brand_new));
    }

    // ---- Regression: orphaned welcomeSetupPending self-heal (fix PR) ----
    //
    // During v0.10.259-v0.10.287 the installer ran on every auto-update
    // restart and wrote `welcomeSetupPending: true` into menubar.json. The
    // only writer that clears it (`mark_welcome_setup_complete`) fires only
    // when the person completes the guided /setup run. A user fighting the
    // loop never completed that run, leaving an orphaned flag. On v0.10.288+
    // the classifier correctly returns SteadyState but `welcome_setup_owed`
    // still returns true on every launch, driving the Welcome card.
    //
    // Nima's exact menubar.json shape (2026-09-22/09-23, v0.10.299/v0.10.304):
    //   installCompleted: true, firstRunCompleted: true, machineId: "m1",
    //   welcomeSetupPending: true, welcomeSetupCompletedAt: absent
    //
    // The fix: `should_backfill_welcome_setup_pending` detects this shape and
    // `setup_lifecycle` self-heals by merging the completion flags into
    // menubar.json, after which `welcome_setup_owed` returns false.

    #[test]
    fn backfill_is_needed_for_orphaned_flag_on_set_up_machine() {
        // Nima's exact shape: fully set up, but welcomeSetupPending was never
        // cleared. Backfill should be triggered.
        let menubar = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
            "welcomeSetupPending": true,
        }));
        assert!(
            should_backfill_welcome_setup_pending(&menubar, true, true, true, true),
            "orphaned pending flag on a set-up machine must trigger backfill",
        );
        // After the backfill (pending:false + completedAt written), owed is false.
        let healed = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
            "welcomeSetupPending": false,
            "welcomeSetupCompletedAt": "2026-09-23T10:00:00Z",
        }));
        assert!(
            !welcome_setup_owed(&healed, true),
            "after backfill welcome_setup_owed must be false",
        );
    }

    #[test]
    fn backfill_is_not_triggered_for_a_new_install_still_pending_setup() {
        // A brand-new machine that has not completed setup must still be owed
        // the guided welcome. installCompleted=false, firstRunCompleted=false.
        let brand_new = map(json!({ "welcomeSetupPending": true }));
        assert!(
            !should_backfill_welcome_setup_pending(&brand_new, false, false, true, true),
            "new install that has not completed setup must not be backfilled",
        );
        // Still owed after no backfill.
        assert!(welcome_setup_owed(&brand_new, true));
    }

    #[test]
    fn backfill_is_not_triggered_when_pending_flag_is_absent_or_already_false() {
        // Flag absent (pre-welcome-flow install): `welcome_setup_owed` handles
        // this via the legacy fallback; no backfill needed.
        let absent = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
        }));
        assert!(!should_backfill_welcome_setup_pending(&absent, true, true, true, true));

        // Flag already false: already done.
        let already_done = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
            "welcomeSetupPending": false,
        }));
        assert!(!should_backfill_welcome_setup_pending(&already_done, true, true, true, true));
    }

    #[test]
    fn backfill_is_not_triggered_when_welcome_setup_already_has_a_completed_at() {
        // completedAt already written: the guided run finished normally.
        let completed = map(json!({
            "installCompleted": true,
            "firstRunCompleted": true,
            "machineId": "m1",
            "welcomeSetupPending": true,
            "welcomeSetupCompletedAt": "2026-09-16T13:13:12Z",
        }));
        assert!(!should_backfill_welcome_setup_pending(&completed, true, true, true, true));
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

    #[test]
    fn hq_root_valid_true_for_canonical_layout() {
        let dir = tempdir().unwrap();
        let core_dir = dir.path().join("core");
        std::fs::create_dir(&core_dir).unwrap();
        std::fs::write(core_dir.join("core.yaml"), "").unwrap();

        assert!(hq_root_valid(dir.path()));
    }

    #[test]
    fn hq_root_valid_true_for_legacy_layout() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("core.yaml"), "").unwrap();

        assert!(hq_root_valid(dir.path()));
    }

    #[test]
    fn hq_root_valid_false_when_core_yaml_missing() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("core")).unwrap();

        assert!(!hq_root_valid(dir.path()));
    }

    #[test]
    fn hq_root_valid_false_for_nonexistent_root() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("missing");

        assert!(!hq_root_valid(&missing));
    }
}

#[cfg(test)]
mod toolchain_readiness_tests {
    use super::*;
    #[test]
    fn synced_workspace_without_local_tools_must_install_without_backfill() {
        for state in [
            LifecycleState::NeedsInstall,
            LifecycleState::InstallResume,
            LifecycleState::NeedsAuthForInstall,
            LifecycleState::InstalledFirstRun,
            LifecycleState::InstalledLegacyUpdate,
            LifecycleState::SteadyState,
        ] {
            let original = LifecycleVerdict {
                state,
                needs_install_backfill: true,
                needs_first_run_backfill: true,
            };
            assert_eq!(require_local_toolchain(original, true), original);
            let missing = require_local_toolchain(original, false);
            assert_eq!(missing.state, LifecycleState::NeedsInstall);
            assert!(!missing.needs_install_backfill && !missing.needs_first_run_backfill);
            assert!(installation_required(missing.state));
        }
    }
    #[test]
    fn finished_setup_without_local_tools_still_returns_to_the_installer() {
        // Completion markers and a synced HQ folder (the 2026-09-14 fresh-VM
        // case) do not make HQ installed when hq or node is missing here.
        let inputs = LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: true,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        };
        assert_eq!(
            classify_lifecycle(inputs).state,
            LifecycleState::SteadyState
        );
        let verdict = require_local_toolchain(classify_lifecycle(inputs), false);
        assert_eq!(verdict.state, LifecycleState::NeedsInstall);
        assert!(installation_required(verdict.state));
        assert_eq!(
            require_local_toolchain(classify_lifecycle(inputs), true).state,
            LifecycleState::SteadyState
        );
    }

    #[test]
    fn tools_present_for_lifecycle_gate_ignores_cli_version_mismatch() {
        assert!(tools_present_for_lifecycle_gate(true, true));
        assert!(!tools_present_for_lifecycle_gate(false, true));
        assert!(!tools_present_for_lifecycle_gate(true, false));
        assert!(!tools_present_for_lifecycle_gate(false, false));
    }

    #[test]
    fn auto_update_restart_with_hq_and_node_does_not_reopen_installer() {
        // Feedback #2290: v0.10.260 ANDed bundled CLI version match into
        // tools_present. After an auto-update the new bundle's version.txt
        // disagrees with the still-installed CLI, so the Welcome card came
        // back even though hq, node, auth, and the HQ folder were healthy.
        // config.json is often missing too; that must not change the result.
        let inputs = LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: false,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
        };
        let classified = classify_lifecycle(inputs);
        assert_eq!(classified.state, LifecycleState::SteadyState);
        let tools = tools_present_for_lifecycle_gate(true, true);
        let verdict = require_local_toolchain(classified, tools);
        assert_eq!(verdict.state, LifecycleState::SteadyState);
        assert!(!installation_required(verdict.state));
    }
    #[test]
    fn completed_install_opens_desktop_and_incomplete_install_resumes_wizard() {
        for state in [
            LifecycleState::NeedsInstall,
            LifecycleState::InstallResume,
            LifecycleState::NeedsAuthForInstall,
        ] {
            assert!(installation_required(state));
        }
        for state in [
            LifecycleState::InstalledFirstRun,
            LifecycleState::InstalledLegacyUpdate,
            LifecycleState::SteadyState,
        ] {
            assert!(!installation_required(state));
        }
    }
}
