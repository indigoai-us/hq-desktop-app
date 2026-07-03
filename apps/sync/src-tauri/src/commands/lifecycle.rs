use chrono::Utc;
use hq_desktop_core::lifecycle::{
    classify_lifecycle, hq_root_valid, menubar_flags, LifecycleInputs, LifecycleState,
};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::util::{logfile::log, paths};

/// Managed lifecycle state resolved once at app startup.
pub struct LifecycleStateHandle(pub LifecycleState);

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
        // TODO(install-marker): wire the install marker subsystem when it exists.
        install_in_progress: false,
    };
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

    log(
        "lifecycle",
        &format!(
            "setup_lifecycle: state={} install_completed={} first_run_completed={} had_machine_id={} config_valid={} hq_root_valid={} has_auth={} install_in_progress=false backfill={}",
            lifecycle_state_str(verdict.state),
            install_completed,
            first_run_completed,
            had_machine_id,
            config_valid,
            hq_root_valid,
            has_auth,
            verdict.needs_install_backfill,
        ),
    );

    app.manage(LifecycleStateHandle(verdict.state));
}

#[tauri::command]
pub fn get_lifecycle_state(state: State<'_, LifecycleStateHandle>) -> String {
    lifecycle_state_str(state.0).to_string()
}

pub fn lifecycle_keeps_main_window_visible(state: LifecycleState) -> bool {
    matches!(
        state,
        LifecycleState::NeedsInstall
            | LifecycleState::InstallResume
            | LifecycleState::NeedsAuthForInstall
    )
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
