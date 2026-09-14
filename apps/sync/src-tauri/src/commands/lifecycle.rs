use chrono::Utc;
use hq_desktop_core::lifecycle::{
    classify_lifecycle, hq_root_valid, menubar_flags, LifecycleInputs, LifecycleState,
};
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use tauri::{AppHandle, Manager, State};

use crate::util::{logfile::log, paths};

/// Managed lifecycle state resolved at app startup and advanced in-process
/// when setup finishes (see [`set_lifecycle_state`]), so window routing does
/// not keep sending an already-installed user back to the setup card until
/// the next relaunch.
pub struct LifecycleStateHandle(pub RwLock<LifecycleState>);

impl LifecycleStateHandle {
    pub fn current(&self) -> LifecycleState {
        *self.0.read().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Set at startup when the toolchain gate (not the plain install state) sent
/// this launch to the installer; cleared once setup advances past install.
static TOOLCHAIN_HOLDS_DESKTOP: AtomicBool = AtomicBool::new(false);

/// Whether desktop activation must stay on the installer for this launch.
pub fn toolchain_holds_desktop(app: &AppHandle) -> bool {
    TOOLCHAIN_HOLDS_DESKTOP.load(Ordering::SeqCst)
        && current_lifecycle_state(app).is_some_and(hq_desktop_core::lifecycle::installation_required)
}

/// Current lifecycle verdict for the running process, if one was resolved.
pub fn current_lifecycle_state(app: &AppHandle) -> Option<LifecycleState> {
    app.try_state::<LifecycleStateHandle>()
        .map(|handle| handle.current())
}

/// Advance the in-process lifecycle verdict. Called when the setup wizard
/// finishes so the same launch routes Dock / tray / second-launch activations
/// to the desktop workspace instead of back to the (now finished) setup card.
pub fn set_lifecycle_state(app: &AppHandle, state: LifecycleState) {
    if let Some(handle) = app.try_state::<LifecycleStateHandle>() {
        *handle
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = state;
        if !hq_desktop_core::lifecycle::installation_required(state) {
            TOOLCHAIN_HOLDS_DESKTOP.store(false, Ordering::SeqCst);
        }
        log(
            "lifecycle",
            &format!("lifecycle state advanced to {}", lifecycle_state_str(state)),
        );
    }
}

/// Resolve lifecycle inputs at startup, classify, backfill legacy install
/// markers when needed, and cache the state for command consumers.
pub fn setup_lifecycle(app: &AppHandle) {
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

    let menubar = menubar_path
        .as_ref()
        .map(|path| hq_desktop_core::first_run::read_menubar_obj(path))
        .unwrap_or_else(Map::new);
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
    let hq_root_valid = hq_root_valid(&hq_root);

    let has_auth = match tauri::async_runtime::block_on(
        crate::commands::cognito::has_non_empty_stored_token(),
    ) {
        Ok(has_auth) => has_auth,
        Err(e) => {
            log(
                "lifecycle",
                &format!("setup_lifecycle: auth presence check failed: {e}"),
            );
            false
        }
    };

    let inputs = LifecycleInputs {
        install_completed,
        first_run_completed,
        had_machine_id,
        config_valid,
        hq_root_valid,
        has_auth,
        install_in_progress: crate::commands::install_manifest::install_in_progress_from_disk(),
        consent_answered,
    };
    // macOS only: a synced workspace without local hq/node (or with a CLI that
    // does not match the bundled one) goes back to installation, unless this
    // machine already recorded finishing setup. Not applied on Windows, where
    // this readiness check is not certified.
    #[cfg(not(windows))]
    let setup_recorded_locally = inputs.install_completed || inputs.first_run_completed;
    #[cfg(not(windows))]
    let verdict = {
        let tools_present = ["hq", "node"].iter().all(|name| {
            paths::resolve_bin_with_kind(name).kind != paths::ResolvedProgramKind::NotResolved
        }) && crate::commands::install_deps::bundled_hq_cli_ready(app);
        let classified = classify_lifecycle(inputs);
        let gated = hq_desktop_core::lifecycle::require_local_toolchain(classified, tools_present, setup_recorded_locally);
        TOOLCHAIN_HOLDS_DESKTOP.store(
            hq_desktop_core::lifecycle::toolchain_holds_desktop(classified.state, gated.state),
            Ordering::SeqCst,
        );
        gated
    };
    #[cfg(windows)]
    let verdict = classify_lifecycle(inputs);

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

    log(
        "lifecycle",
        &format!(
            "setup_lifecycle: state={} install_completed={} first_run_completed={} had_machine_id={} config_valid={} hq_root_valid={} has_auth={} install_in_progress={} consent_answered={} backfill={} first_run_backfill={}",
            lifecycle_state_str(verdict.state),
            install_completed,
            first_run_completed,
            had_machine_id,
            config_valid,
            hq_root_valid,
            has_auth,
            inputs.install_in_progress,
            consent_answered,
            verdict.needs_install_backfill,
            verdict.needs_first_run_backfill,
        ),
    );

    app.manage(LifecycleStateHandle(RwLock::new(verdict.state)));
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
}

#[tauri::command]
pub fn get_setup_status() -> SetupStatus {
    let menubar = paths::menubar_json_path()
        .ok()
        .map(|path| hq_desktop_core::first_run::read_menubar_obj(&path))
        .unwrap_or_else(Map::new);
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
        welcome_setup_owed: hq_desktop_core::lifecycle::welcome_setup_owed(&menubar, root_valid),
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
}
