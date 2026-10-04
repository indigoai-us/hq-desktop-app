use chrono::Utc;
use hq_desktop_core::cognito::StoredTokenPresence;
use hq_desktop_core::first_run::{read_menubar, MenubarRead};
#[cfg(not(windows))]
use hq_desktop_core::lifecycle::{
    probe_local_toolchain_for_startup, tools_present_for_lifecycle_gate,
};
use hq_desktop_core::lifecycle::{
    hq_root_valid, menubar_flags, probe_hq_root_for_startup,
    should_backfill_welcome_setup_pending, HqRootProbe, LifecycleInputs, LifecycleState,
};
use hq_desktop_core::paths::ResolvedProgramKind;
use serde_json::{Map, Value};
use std::sync::{OnceLock, RwLock};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

use crate::util::{logfile::log, paths};

/// Managed lifecycle state resolved at app startup and advanced in-process
/// when setup finishes (see [`set_lifecycle_state`]), so window routing does
/// not keep sending an already-installed user back to the setup card until
/// the next relaunch.
pub struct LifecycleStateHandle(pub RwLock<LifecycleState>);

impl LifecycleStateHandle {
    pub fn current(&self) -> LifecycleState {
        *self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Current lifecycle verdict for the running process, if one was resolved.
pub fn current_lifecycle_state(app: &AppHandle) -> Option<LifecycleState> {
    app.try_state::<LifecycleStateHandle>()
        .map(|handle| handle.current())
}

/// Immutable lifecycle inputs captured at startup, for use by diagnostic
/// commands that run after setup_lifecycle has returned.
pub struct LifecycleInputsHandle {
    pub inputs: LifecycleInputs,
    pub manifest_incomplete: bool,
    pub tools_present: bool,
    pub bundled_cli_ready: bool,
    pub hq_root_probe: Option<HqRootProbe>,
    pub hq_program_kind: Option<ResolvedProgramKind>,
    pub node_program_kind: Option<ResolvedProgramKind>,
    pub require_local_toolchain_demoted: bool,
    pub hq_candidate_count_bucket: &'static str,
    pub managed_hq_package_state: &'static str,
    pub bundled_cli_mode: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSetupEvidence {
    install_completed: bool,
    first_run_completed: bool,
    consent_answered: bool,
    install_in_progress: bool,
    manifest_incomplete: bool,
    had_machine_id: bool,
    hq_root_valid: bool,
    hq_root_missing: bool,
}

/// Setup evidence used by the frontend's unexpected-surface reporting boundary.
/// Unknown evidence is returned as `None` so the reporter can defer to its own
/// conservative Rust-side check.
#[tauri::command]
pub fn get_startup_setup_evidence(
    state: State<'_, LifecycleInputsHandle>,
) -> Option<StartupSetupEvidence> {
    let inputs = state.inputs;
    if inputs.evidence_unreadable {
        return None;
    }
    Some(StartupSetupEvidence {
        install_completed: inputs.install_completed,
        first_run_completed: inputs.first_run_completed,
        consent_answered: inputs.consent_answered,
        install_in_progress: inputs.install_in_progress,
        manifest_incomplete: state.manifest_incomplete,
        had_machine_id: inputs.had_machine_id,
        hq_root_valid: inputs.hq_root_valid,
        hq_root_missing: state.hq_root_probe == Some(HqRootProbe::Missing),
    })
}

/// Time at which setup_lifecycle started, used to compute seconds since
/// process start in diagnostic events.
static SETUP_LIFECYCLE_TIME: OnceLock<Instant> = OnceLock::new();

/// Rate-limit: at most one unexpected-surface Sentry event per process.
static UNEXPECTED_SURFACE_REPORTED: OnceLock<()> = OnceLock::new();

/// Advance the in-process lifecycle verdict. Called when the setup wizard
/// finishes so the same launch routes Dock / tray / second-launch activations
/// to the desktop workspace instead of back to the (now finished) setup card.
pub fn set_lifecycle_state(app: &AppHandle, state: LifecycleState) {
    if let Some(handle) = app.try_state::<LifecycleStateHandle>() {
        *handle
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = state;
        log(
            "lifecycle",
            &format!("lifecycle state advanced to {}", lifecycle_state_str(state)),
        );
    }
}

/// Resolve lifecycle inputs at startup, classify, backfill legacy install
/// markers when needed, and cache the state for command consumers.
pub fn setup_lifecycle(app: &AppHandle) {
    let _ = SETUP_LIFECYCLE_TIME.get_or_init(Instant::now);
    let launch_agent_relaunch =
        std::env::args().any(|arg| arg == hq_platform::launchagent::LAUNCH_AGENT_RELAUNCH_ARG);
    let menubar_path = match paths::menubar_json_path() {
        Ok(path) => Some(path),
        Err(e) => {
            log(
                "lifecycle",
                &format!("setup_lifecycle: menubar path unavailable: {e}"),
            );
            None
        }
    };

    let menubar_read = menubar_path.as_ref().map(|path| read_menubar(path));
    if matches!(
        menubar_read.as_ref(),
        None | Some(
            MenubarRead::Unreadable | MenubarRead::Unparseable | MenubarRead::PreservedCorrupt
        )
    ) {
        // A present-but-damaged settings file, or an unavailable settings
        // location, cannot prove that this machine is new. Do not route the
        // person into setup or try to backfill over the unreadable state.
        log(
            "lifecycle",
            "settings state unavailable; preserving the existing launch surface",
        );
        app.manage(LifecycleStateHandle(RwLock::new(
            LifecycleState::SteadyState,
        )));
        app.manage(LifecycleInputsHandle {
            inputs: LifecycleInputs {
                install_completed: false,
                first_run_completed: false,
                had_machine_id: false,
                config_valid: false,
                hq_root_valid: false,
                has_auth: false,
                install_in_progress: false,
                consent_answered: false,
                evidence_unreadable: true,
            },
            manifest_incomplete: false,
            tools_present: false,
            bundled_cli_ready: false,
            hq_root_probe: None,
            hq_program_kind: None,
            node_program_kind: None,
            require_local_toolchain_demoted: false,
            hq_candidate_count_bucket: "0",
            managed_hq_package_state: "unknown",
            bundled_cli_mode: "unknown",
        });
        return;
    }
    let menubar = match menubar_read {
        Some(MenubarRead::Object(menubar)) => menubar,
        Some(MenubarRead::Absent) => Map::new(),
        Some(
            MenubarRead::Unreadable | MenubarRead::Unparseable | MenubarRead::PreservedCorrupt,
        )
        | None => unreachable!(),
    };
    let (install_completed, first_run_completed, had_machine_id) = menubar_flags(&menubar);

    // Compulsory consent: an installed machine whose consent is unanswered must
    // be routed back through onboarding, not waved through as an already-set-up
    // machine (finding #2 — quitting at the consent step bypassed consent). The
    // `telemetryOptInAnsweredAt` provenance marker is written the moment the
    // person answers, so its presence is the "consent was answered here" signal.
    let consent_answered = menubar
        .get("telemetryOptInAnsweredAt")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let config = match crate::commands::config::read_hq_config_lenient() {
        Ok(config) => config,
        Err(e) => {
            log(
                "lifecycle",
                &format!("setup_lifecycle: config read failed: {e}"),
            );
            None
        }
    };
    let config_valid = config.is_some();

    let hq_root = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar.get("hqPath").and_then(Value::as_str),
    );
    // LaunchAgent starts include login and KeepAlive relaunches as well as an
    // updater kick. Recheck an initially missing root briefly so a just-updated
    // app does not mistake a settling filesystem for a deleted HQ folder.
    let root_probe = probe_hq_root_for_startup(&hq_root, launch_agent_relaunch);
    let hq_root_valid = root_probe == HqRootProbe::Valid;
    let hq_root_unreadable = root_probe == HqRootProbe::Unreadable;
    if hq_root_unreadable {
        log(
            "lifecycle",
            &format!(
                "setup_lifecycle: HQ folder unreadable at {} - treating install evidence as unknown",
                hq_root.display()
            ),
        );
    }

    let token_presence =
        tauri::async_runtime::block_on(hq_desktop_core::cognito::stored_token_presence());
    let has_auth = token_presence == StoredTokenPresence::Present;
    let token_unreadable = token_presence == StoredTokenPresence::Unreadable;
    if token_unreadable {
        log(
            "lifecycle",
            "setup_lifecycle: token store unreadable - treating auth evidence as unknown",
        );
    }
    let evidence_unreadable = hq_root_unreadable || token_unreadable;

    let (install_in_progress, manifest_incomplete) =
        crate::commands::install_manifest::startup_manifest_evidence_from_disk();
    let inputs = LifecycleInputs {
        install_completed,
        first_run_completed,
        had_machine_id,
        config_valid,
        hq_root_valid,
        has_auth,
        install_in_progress,
        consent_answered,
        evidence_unreadable,
    };
    // macOS only: HQ is installed only when hq and node are on this computer.
    // A bundled CLI version mismatch is not "missing tools": auto-update
    // restarts ship a new expected version before the existing CLI is
    // upgraded, and treating that as NeedsInstall re-opens the Welcome card
    // (feedback #2290). Not applied on Windows, where this readiness check
    // is not certified.
    #[cfg(not(windows))]
    let (
        verdict,
        tools_present,
        bundled_cli_ready,
        hq_program_kind,
        node_program_kind,
        require_local_toolchain_demoted,
        hq_candidate_count_bucket,
        managed_hq_package_state,
        bundled_cli_mode,
    ) = {
        // When the install evidence itself could not be read, a "tools are
        // missing" reading of the same filesystem is not trustworthy either,
        // so it must not demote a set-up machine to NeedsInstall.
        let classified = hq_desktop_core::lifecycle::classify_lifecycle(inputs);
        // A LaunchAgent updater restart can race the managed toolchain settling
        // after the app bundle is replaced. Recheck only existing installs;
        // fresh installs still reach onboarding immediately when tools are absent.
        let mut resolved_programs = None;
        let tools_present = probe_local_toolchain_for_startup(
            launch_agent_relaunch,
            matches!(
                classified.state,
                LifecycleState::SteadyState
                    | LifecycleState::InstalledFirstRun
                    | LifecycleState::InstalledLegacyUpdate
            ),
            || {
                let (hq_program, resolver_diagnostics) = paths::resolve_hq_with_diagnostics();
                let node_program = paths::resolve_bin_with_kind("node");
                let tools_present = tools_present_for_lifecycle_gate(
                    hq_program.kind != ResolvedProgramKind::NotResolved,
                    node_program.kind != ResolvedProgramKind::NotResolved,
                );
                resolved_programs = Some((hq_program, node_program, resolver_diagnostics));
                tools_present
            },
        );
        // The startup probe always performs its initial resolution.
        let (hq_program, node_program, resolver_diagnostics) = resolved_programs
            .expect("startup toolchain probe records its initial resolution");
        let (bundled_cli_ready, bundled_cli_mode) =
            crate::commands::install_deps::bundled_hq_cli_diagnostics(app);
        let verdict = if evidence_unreadable {
            classified
        } else {
            hq_desktop_core::lifecycle::require_local_toolchain_after_updater_restart(
                classified,
                tools_present,
                launch_agent_relaunch,
            )
        };
        let require_local_toolchain_demoted = !evidence_unreadable
            && classified.state != verdict.state
            && verdict.state == LifecycleState::NeedsInstall;
        (
            verdict,
            tools_present,
            bundled_cli_ready,
            Some(hq_program.kind),
            Some(node_program.kind),
            require_local_toolchain_demoted,
            resolver_diagnostics.candidate_count_bucket(),
            resolver_diagnostics.managed_package_state,
            bundled_cli_mode,
        )
    };
    #[cfg(windows)]
    let verdict = hq_desktop_core::lifecycle::classify_lifecycle(inputs);
    #[cfg(windows)]
    let (
        tools_present,
        bundled_cli_ready,
        hq_program_kind,
        node_program_kind,
        require_local_toolchain_demoted,
        hq_candidate_count_bucket,
        managed_hq_package_state,
        bundled_cli_mode,
    ) = {
        // Windows does not use require_local_toolchain for lifecycle routing,
        // but collect the same resolver observations for startup diagnostics.
        let (hq_program, resolver_diagnostics) = paths::resolve_hq_with_diagnostics();
        let node_program = paths::resolve_bin_with_kind("node");
        (
            true,
            true,
            Some(hq_program.kind),
            Some(node_program.kind),
            false,
            resolver_diagnostics.candidate_count_bucket(),
            resolver_diagnostics.managed_package_state,
            "unknown",
        )
    };

    if verdict.needs_install_backfill {
        match menubar_path.as_ref() {
            Some(path) => {
                if let Err(e) = hq_desktop_core::first_run::merge_menubar_flags(
                    path,
                    &[
                        ("installCompleted", Value::Bool(true)),
                        (
                            "installBackfilledAt",
                            Value::String(Utc::now().to_rfc3339()),
                        ),
                    ],
                ) {
                    log(
                        "lifecycle",
                        &format!("setup_lifecycle: install backfill failed: {e}"),
                    );
                }
            }
            None => log(
                "lifecycle",
                "setup_lifecycle: install backfill skipped; menubar path unavailable",
            ),
        }
    }

    // Setup is done on this machine; only the marker was missing. Write it
    // back so the next launch, and a Dock click in this one, read "set up".
    if verdict.needs_first_run_backfill {
        match menubar_path.as_ref() {
            Some(path) => {
                if let Err(e) = hq_desktop_core::first_run::merge_menubar_flags(
                    path,
                    &[
                        ("firstRunCompleted", Value::Bool(true)),
                        (
                            "firstRunBackfilledAt",
                            Value::String(Utc::now().to_rfc3339()),
                        ),
                    ],
                ) {
                    log(
                        "lifecycle",
                        &format!("setup_lifecycle: first-run backfill failed: {e}"),
                    );
                }
            }
            None => log(
                "lifecycle",
                "setup_lifecycle: first-run backfill skipped; menubar path unavailable",
            ),
        }
    }

    // A machine that is fully set up and signed in but still has
    // welcomeSetupPending:true with no welcomeSetupCompletedAt was left in this
    // state by the v0.10.259–v0.10.287 regression (bundled_hq_cli_ready false on
    // every auto-update restart caused SteadyState→NeedsInstall, running the
    // installer and arming the flag). Clear it now so welcome_setup_owed returns
    // false on this and every subsequent launch.
    let welcome_setup_backfill = should_backfill_welcome_setup_pending(
        &menubar,
        install_completed,
        first_run_completed,
        hq_root_valid,
        has_auth,
    );
    if welcome_setup_backfill {
        match menubar_path.as_ref() {
            Some(path) => {
                let now = Utc::now().to_rfc3339();
                if let Err(e) = hq_desktop_core::first_run::merge_menubar_flags(
                    path,
                    &[
                        ("welcomeSetupPending", Value::Bool(false)),
                        ("welcomeSetupCompletedAt", Value::String(now.clone())),
                        ("welcomeSetupBackfilledAt", Value::String(now)),
                    ],
                ) {
                    log(
                        "lifecycle",
                        &format!("setup_lifecycle: welcome-setup backfill failed: {e}"),
                    );
                } else {
                    log(
                        "lifecycle",
                        "setup_lifecycle: backfilled welcomeSetupPending=false for set-up machine",
                    );
                }
            }
            None => log(
                "lifecycle",
                "setup_lifecycle: welcome-setup backfill skipped; menubar path unavailable",
            ),
        }
    }

    log(
        "lifecycle",
        &format!(
            "setup_lifecycle: state={} install_completed={} first_run_completed={} had_machine_id={} config_valid={} hq_root_valid={} has_auth={} install_in_progress={} consent_answered={} evidence_unreadable={} tools_present={} bundled_cli_ready={} backfill={} first_run_backfill={} welcome_setup_backfill={}",
            lifecycle_state_str(verdict.state),
            install_completed,
            first_run_completed,
            had_machine_id,
            config_valid,
            hq_root_valid,
            has_auth,
            inputs.install_in_progress,
            consent_answered,
            evidence_unreadable,
            tools_present,
            bundled_cli_ready,
            verdict.needs_install_backfill,
            verdict.needs_first_run_backfill,
            welcome_setup_backfill,
        ),
    );

    app.manage(LifecycleStateHandle(RwLock::new(verdict.state)));
    app.manage(LifecycleInputsHandle {
        inputs,
        manifest_incomplete,
        tools_present,
        bundled_cli_ready,
        hq_root_probe: Some(root_probe),
        hq_program_kind,
        node_program_kind,
        require_local_toolchain_demoted,
        hq_candidate_count_bucket,
        managed_hq_package_state,
        bundled_cli_mode,
    });
}

#[tauri::command]
pub fn get_lifecycle_state(state: State<'_, LifecycleStateHandle>) -> String {
    lifecycle_state_str(state.current()).to_string()
}

/// Fresh (non-cached) setup status for UI surfaces that need to know whether
/// the HQ tree actually exists *right now* — unlike `get_lifecycle_state`,
/// whose verdict is resolved once at startup and cached for the process
/// lifetime. Used by the desktop window's "Finish setting up HQ" card.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub hq_root_valid: bool,
    pub configured: bool,
    pub hq_folder_path: String,
    /// The welcome channel should still offer Run Setup here. False for a
    /// machine set up before the welcome flow existed, or once the guided run
    /// finished. See `hq_desktop_core::lifecycle::welcome_setup_owed`.
    pub welcome_setup_owed: bool,
    /// The desktop window's first-run guided tour was already shown here.
    /// See `hq_desktop_core::lifecycle::welcome_tour_shown`.
    pub welcome_tour_shown: bool,
}

#[tauri::command]
pub fn get_setup_status() -> SetupStatus {
    let menubar_read = paths::menubar_json_path()
        .ok()
        .map(|path| read_menubar(&path));
    let settings_unavailable = matches!(
        menubar_read.as_ref(),
        None | Some(
            MenubarRead::Unreadable | MenubarRead::Unparseable | MenubarRead::PreservedCorrupt
        )
    );
    let menubar = match menubar_read {
        Some(MenubarRead::Object(menubar)) => menubar,
        Some(MenubarRead::Absent)
        | Some(MenubarRead::Unreadable | MenubarRead::Unparseable)
        | Some(MenubarRead::PreservedCorrupt)
        | None => Map::new(),
    };
    let config = crate::commands::config::read_hq_config_lenient()
        .ok()
        .flatten();
    let hq_root = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar.get("hqPath").and_then(Value::as_str),
    );
    let root_valid = hq_root_valid(&hq_root);
    SetupStatus {
        hq_root_valid: root_valid,
        configured: config.is_some(),
        hq_folder_path: hq_root.to_string_lossy().to_string(),
        // Do not surface another setup route when the settings file itself is
        // the unavailable state that made launch conservative.
        welcome_setup_owed: !settings_unavailable
            && hq_desktop_core::lifecycle::welcome_setup_owed(&menubar, root_valid),
        welcome_tour_shown: hq_desktop_core::lifecycle::welcome_tour_shown(&menubar),
    }
}

/// The welcome channel's guided setup finished: it is never owed again on
/// this machine, whatever the window's own memory says (that lives in WebKit
/// storage and does not survive a reinstall under another bundle id).
#[tauri::command]
pub fn mark_welcome_setup_complete() -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[
            ("welcomeSetupPending", Value::Bool(false)),
            (
                "welcomeSetupCompletedAt",
                Value::String(Utc::now().to_rfc3339()),
            ),
        ],
    )
}

/// The desktop window's first-run guided tour started showing. Recorded as
/// soon as it appears (not when it finishes) so a crash or quit mid-tour does
/// not replay it on every launch. The command palette can still replay it.
#[tauri::command]
pub fn mark_welcome_tour_shown() -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(
            hq_desktop_core::lifecycle::WELCOME_TOUR_SHOWN_KEY,
            Value::Bool(true),
        )],
    )
}

pub fn lifecycle_keeps_main_window_visible(state: LifecycleState) -> bool {
    matches!(
        state,
        LifecycleState::NeedsInstall
            | LifecycleState::InstallResume
            | LifecycleState::NeedsAuthForInstall
            | LifecycleState::InstalledFirstRun
    )
}

/// Whether launch should open the centered setup card on its own.
///
/// A brand-new install (`first_run`) always does. So does any launch whose
/// lifecycle verdict says HQ is not set up on this machine yet — a machine
/// that already carries a `machineId` (an aborted earlier attempt, a wiped
/// HQ folder) classifies as a `Normal` launch, and without this rule nothing
/// opens: the person clicks the Dock icon, lands in the workspace with no HQ
/// tree underneath, and hits a dead end instead of the setup that would have
/// fixed it.
pub fn launch_should_show_setup_card(first_run: bool, state: Option<LifecycleState>) -> bool {
    first_run || state.is_some_and(lifecycle_keeps_main_window_visible)
}

fn lifecycle_state_str(state: LifecycleState) -> &'static str {
    match state {
        LifecycleState::NeedsInstall => "NeedsInstall",
        LifecycleState::InstallResume => "InstallResume",
        LifecycleState::NeedsAuthForInstall => "NeedsAuthForInstall",
        LifecycleState::InstalledFirstRun => "InstalledFirstRun",
        LifecycleState::InstalledLegacyUpdate => "InstalledLegacyUpdate",
        LifecycleState::SteadyState => "SteadyState",
    }
}

/// Report an unexpected startup surface to Sentry and the app log.
///
/// Called from the frontend after `checkAuth()` resolves, when the resolved
/// surface is "sign-in" or "onboarding" AND the machine shows prior-setup
/// evidence (installCompleted, firstRunCompleted, or an existing machine ID
/// backed by a valid HQ root).
/// Rate-limited to one Sentry event per process via `UNEXPECTED_SURFACE_REPORTED`.
#[tauri::command]
pub fn report_unexpected_startup_surface(
    app: AppHandle,
    state: State<'_, LifecycleInputsHandle>,
    surface: String,
    auth_check_failed: bool,
    probe_attempts: u32,
    authenticated: bool,
    token_presence: String,
    first_read_result: Option<String>,
    prior_surface: String,
) {
    // Read token file metadata without reading its contents.
    let (token_file_exists, token_file_age_minutes) = {
        let token_path = hq_desktop_core::paths::hq_config_dir()
            .ok()
            .map(|d| d.join("cognito-tokens.json"));
        match token_path.as_ref().and_then(|p| p.metadata().ok()) {
            Some(meta) => {
                let age_minutes = meta
                    .modified()
                    .ok()
                    .and_then(|mt| mt.elapsed().ok())
                    .map(|d| d.as_secs() / 60);
                (true, age_minutes)
            }
            None => (false, None),
        }
    };

    let inputs = &state.inputs;
    let lc_state_str = app
        .try_state::<LifecycleStateHandle>()
        .map(|h| lifecycle_state_str(h.current()).to_string())
        .unwrap_or_else(|| "unknown".into());
    let elapsed_since_start = SETUP_LIFECYCLE_TIME.get().map(|started| started.elapsed());
    let seconds_since_start = elapsed_since_start
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let (auth_session_status, refresh_failure_class, refresh_rejection_class) =
        crate::commands::auth::startup_auth_diagnostic_tags();
    let diagnostic_tags =
        hq_desktop_core::unexpected_surface::apply_startup_token_store_diagnostics(
            hq_desktop_core::unexpected_surface::startup_diagnostic_tags_with_rejection_class(
                authenticated,
                &token_presence,
                elapsed_since_start.map(|elapsed| elapsed.as_millis()),
                &prior_surface,
                hq_desktop_core::unexpected_surface::StartupLifecycleInputs {
                    inputs: *inputs,
                    hq_root_probe: state.hq_root_probe,
                    hq_program_kind: state.hq_program_kind,
                    node_program_kind: state.node_program_kind,
                    require_local_toolchain_demoted: state.require_local_toolchain_demoted,
                    hq_candidate_count_bucket: state.hq_candidate_count_bucket,
                    managed_hq_package_state: state.managed_hq_package_state,
                    bundled_cli_mode: state.bundled_cli_mode,
                },
                auth_session_status,
                refresh_failure_class,
                refresh_rejection_class,
            ),
            &surface,
            &token_presence,
            first_read_result.as_deref(),
        );
    let (last_auth_transition, last_auth_transition_age_seconds) =
        if surface == "sign-in" && token_presence == "present" {
            crate::commands::auth::last_auth_transition_diagnostic()
        } else {
            ("none", 0)
        };

    let prior_setup = inputs.evidence_unreadable
        || hq_desktop_core::unexpected_surface::prior_setup_detected(
            inputs.install_completed,
            inputs.first_run_completed,
            inputs.had_machine_id,
            inputs.hq_root_valid,
            inputs.install_in_progress,
            state.manifest_incomplete,
        );
    let sign_in_prior_setup = inputs.evidence_unreadable
        || inputs.install_completed
        || inputs.first_run_completed
        || token_file_exists;
    let should_report = hq_desktop_core::unexpected_surface::should_report_unexpected_surface(
        &surface,
        &lc_state_str,
        prior_setup,
        sign_in_prior_setup,
    );

    // Always write the log line so diagnostics can find it.
    let log_line = format!(
        "unexpected_startup_surface surface={} lifecycle_state={} install_completed={} first_run_completed={} config_valid={} hq_root_valid={} has_auth={} tools_present={} bundled_cli_ready={} consent_answered={} evidence_unreadable={} token_file_exists={} token_file_age_minutes={} auth_check_failed={} probe_attempts={} session_restore_state={} token_present={} keychain_status={} ms_since_launch={} prior_surface={} from_updater_restart={} app_version={} invalidation_marker_present={} marker_kind={} refresh_rejection_class={} first_read_result={} recheck_read_result={} last_auth_transition={} last_auth_transition_age_seconds={} hq_candidate_count_bucket={} managed_hq_package_state={} bundled_cli_mode={}",
        surface,
        lc_state_str,
        inputs.install_completed,
        inputs.first_run_completed,
        inputs.config_valid,
        inputs.hq_root_valid,
        inputs.has_auth,
        state.tools_present,
        state.bundled_cli_ready,
        inputs.consent_answered,
        inputs.evidence_unreadable,
        token_file_exists,
        token_file_age_minutes.map(|v| v.to_string()).unwrap_or_else(|| "none".into()),
        auth_check_failed,
        probe_attempts,
        diagnostic_tags.session_restore_state,
        diagnostic_tags.token_present,
        diagnostic_tags.keychain_status,
        diagnostic_tags.ms_since_launch,
        diagnostic_tags.prior_surface,
        std::env::args().any(|a| a == hq_platform::launchagent::LAUNCH_AGENT_RELAUNCH_ARG),
        crate::app_version::current(),
        diagnostic_tags.invalidation_marker_present,
        diagnostic_tags.marker_kind,
        diagnostic_tags.refresh_rejection_class,
        diagnostic_tags.first_read_result,
        diagnostic_tags.recheck_read_result,
        last_auth_transition,
        last_auth_transition_age_seconds,
        diagnostic_tags.hq_candidate_count_bucket,
        diagnostic_tags.managed_hq_package_state,
        diagnostic_tags.bundled_cli_mode,
    );

    if !should_report {
        log("lifecycle", &format!("[skip] {log_line}"));
        return;
    }

    log("lifecycle", &log_line);

    // Rate-limit: at most one Sentry event per process.
    if UNEXPECTED_SURFACE_REPORTED.set(()).is_err() {
        return;
    }

    let from_updater_restart =
        std::env::args().any(|a| a == hq_platform::launchagent::LAUNCH_AGENT_RELAUNCH_ARG);

    let payload = hq_desktop_core::unexpected_surface::build_payload(
        surface.clone(),
        lc_state_str,
        inputs.install_completed,
        inputs.first_run_completed,
        inputs.config_valid,
        inputs.hq_root_valid,
        inputs.has_auth,
        state.tools_present,
        state.bundled_cli_ready,
        inputs.consent_answered,
        inputs.evidence_unreadable,
        token_file_exists,
        token_file_age_minutes,
        auth_check_failed,
        probe_attempts,
        seconds_since_start,
        from_updater_restart,
        crate::app_version::current(),
    );

    sentry::with_scope(
        |scope| {
            scope.set_tag("surface", &payload.surface);
            scope.set_tag("lifecycle_state", &payload.lifecycle_state);
            scope.set_tag("app_version", payload.app_version);
            scope.set_tag("from_updater_restart", payload.from_updater_restart.to_string());
            for (key, value) in diagnostic_tags.as_pairs() {
                scope.set_tag(key, value);
            }
            scope.set_tag("last_auth_transition", last_auth_transition);
            scope.set_extra(
                "last_auth_transition_age_seconds",
                serde_json::json!(last_auth_transition_age_seconds).into(),
            );
            scope.set_extra("install_completed", serde_json::json!(payload.install_completed).into());
            scope.set_extra("first_run_completed", serde_json::json!(payload.first_run_completed).into());
            scope.set_extra("config_valid", serde_json::json!(payload.config_valid).into());
            scope.set_extra("hq_root_valid", serde_json::json!(payload.hq_root_valid).into());
            scope.set_extra("has_auth", serde_json::json!(payload.has_auth).into());
            scope.set_extra("tools_present", serde_json::json!(payload.tools_present).into());
            scope.set_extra("bundled_cli_ready", serde_json::json!(payload.bundled_cli_ready).into());
            scope.set_extra("consent_answered", serde_json::json!(payload.consent_answered).into());
            scope.set_extra("evidence_unreadable", serde_json::json!(payload.evidence_unreadable).into());
            scope.set_extra("token_file_exists", serde_json::json!(payload.token_file_exists).into());
            scope.set_extra(
                "token_file_age_minutes",
                serde_json::json!(payload.token_file_age_minutes).into(),
            );
            scope.set_extra("auth_check_failed", serde_json::json!(payload.auth_check_failed).into());
            scope.set_extra("probe_attempts", serde_json::json!(payload.probe_attempts).into());
            scope.set_extra("seconds_since_start", serde_json::json!(payload.seconds_since_start).into());
        },
        || {
            sentry::capture_message(
                &format!("unexpected_startup_surface: surface={}", payload.surface),
                sentry::Level::Warning,
            );
        },
    );
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_always_shows_the_setup_card() {
        assert!(launch_should_show_setup_card(true, None));
        assert!(launch_should_show_setup_card(
            true,
            Some(LifecycleState::SteadyState)
        ));
    }

    #[test]
    fn an_uninstalled_machine_shows_the_setup_card_even_on_a_normal_launch() {
        for state in [
            LifecycleState::NeedsInstall,
            LifecycleState::NeedsAuthForInstall,
            LifecycleState::InstallResume,
            LifecycleState::InstalledFirstRun,
        ] {
            assert!(
                launch_should_show_setup_card(false, Some(state)),
                "{state:?} must open the setup card"
            );
        }
    }

    #[test]
    fn an_installed_machine_stays_quiet_on_launch() {
        assert!(!launch_should_show_setup_card(false, None));
        assert!(!launch_should_show_setup_card(
            false,
            Some(LifecycleState::SteadyState)
        ));
        assert!(!launch_should_show_setup_card(
            false,
            Some(LifecycleState::InstalledLegacyUpdate)
        ));
    }

    #[test]
    fn the_handle_can_be_advanced_in_process() {
        let handle = LifecycleStateHandle(RwLock::new(LifecycleState::NeedsInstall));
        assert_eq!(handle.current(), LifecycleState::NeedsInstall);
        *handle.0.write().unwrap() = LifecycleState::SteadyState;
        assert_eq!(handle.current(), LifecycleState::SteadyState);
    }

    #[test]
    fn startup_setup_evidence_serializes_manifest_incomplete_separately() {
        let evidence = StartupSetupEvidence {
            install_completed: false,
            first_run_completed: false,
            consent_answered: false,
            install_in_progress: false,
            manifest_incomplete: true,
            had_machine_id: true,
            hq_root_valid: true,
            hq_root_missing: false,
        };
        let value = serde_json::to_value(evidence).unwrap();

        assert_eq!(value["manifestIncomplete"], true);
        assert_eq!(value["installInProgress"], false);
        assert_eq!(value["consentAnswered"], false);
        assert_eq!(value["hqRootMissing"], false);
    }

}
