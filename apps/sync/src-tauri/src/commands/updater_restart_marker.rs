use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MARKER_FILE: &str = "updater-restart-marker.json";
const MARKER_TTL_SECS: u64 = 120;

#[derive(Debug, Deserialize, Serialize)]
struct UpdaterRestartMarker {
    expected_version: String,
    written_at_unix_secs: u64,
}

pub(crate) fn startup_is_updater_restart(
    launch_agent_relaunch: bool,
    marker_matches: bool,
) -> bool {
    launch_agent_relaunch || marker_matches
}

pub(crate) fn persist_before_gui_restart(
    app: &AppHandle,
    expected_version: &str,
) -> io::Result<()> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?
        .join(MARKER_FILE);
    persist_at(&path, expected_version, unix_now_secs()?)
}

pub(crate) fn consume_for_startup(app: &AppHandle, running_version: &str) -> bool {
    let Ok(path) = app.path().app_data_dir() else {
        return false;
    };
    let path = path.join(MARKER_FILE);
    match unix_now_secs().and_then(|now| consume_at(&path, running_version, now)) {
        Ok(valid) => valid,
        Err(error) => {
            crate::util::logfile::log(
                "updater",
                &format!("could not consume updater restart marker: {error}"),
            );
            false
        }
    }
}

fn unix_now_secs() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))
}

fn persist_at(path: &Path, expected_version: &str, now_secs: u64) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "marker has no parent"))?;
    fs::create_dir_all(parent)?;
    let marker = UpdaterRestartMarker {
        expected_version: expected_version.to_owned(),
        written_at_unix_secs: now_secs,
    };
    let bytes = serde_json::to_vec(&marker)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)?;
    #[cfg(windows)]
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn consume_at(path: &Path, running_version: &str, now_secs: u64) -> io::Result<bool> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            let _ = fs::remove_file(path);
            return Err(error);
        }
    };

    // Consume even an invalid, stale, or version-mismatched marker so it can
    // never affect a later normal launch.
    fs::remove_file(path)?;
    let Ok(marker) = serde_json::from_str::<UpdaterRestartMarker>(&contents) else {
        return Ok(false);
    };
    let age_secs = now_secs.checked_sub(marker.written_at_unix_secs);
    Ok(marker.expected_version == running_version
        && age_secs.is_some_and(|age| age <= MARKER_TTL_SECS))
}

#[cfg(test)]
mod tests {
    use super::{consume_at, persist_at, startup_is_updater_restart};
    use hq_desktop_core::lifecycle::{
        classify_lifecycle, require_local_toolchain_after_updater_restart, LifecycleInputs,
        LifecycleState,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn marker_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "hq-updater-restart-marker-{}-{nonce}",
                std::process::id()
            ))
            .join(name)
    }

    fn previously_setup_inputs() -> LifecycleInputs {
        LifecycleInputs {
            install_completed: true,
            first_run_completed: true,
            had_machine_id: true,
            config_valid: false,
            hq_root_valid: true,
            has_auth: true,
            install_in_progress: false,
            consent_answered: true,
            evidence_unreadable: false,
            hq_root_recorded_by_prior_setup: false,
        }
    }

    #[test]
    fn gui_fallback_marker_classifies_the_matching_update_restart() {
        let path = marker_path("marker.json");
        persist_at(&path, "0.10.388", 1_000).unwrap();

        let marker_matches = consume_at(&path, "0.10.388", 1_005).unwrap();
        let updater_restart = startup_is_updater_restart(false, marker_matches);
        let classified = classify_lifecycle(previously_setup_inputs());
        let verdict =
            require_local_toolchain_after_updater_restart(classified, false, updater_restart);
        assert!(
            updater_restart,
            "the GUI fallback marker is updater evidence"
        );
        assert_eq!(verdict.state, LifecycleState::InstallResume);
        assert!(!path.exists(), "the marker is consumed once");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn stale_or_version_mismatched_marker_is_ignored_and_removed() {
        for (version, written_at) in [("0.10.388", 1_000), ("0.10.387", 1_995)] {
            let path = marker_path("marker.json");
            persist_at(&path, version, written_at).unwrap();
            let marker_matches = consume_at(&path, "0.10.388", 2_000).unwrap();
            assert!(!startup_is_updater_restart(false, marker_matches));
            assert!(!path.exists(), "invalid markers are removed");
            let _ = fs::remove_dir_all(path.parent().unwrap());
        }
    }

    #[test]
    fn normal_launch_without_marker_is_not_an_updater_restart() {
        let path = marker_path("missing.json");
        let marker_matches = consume_at(&path, "0.10.388", 2_000).unwrap();
        let updater_restart = startup_is_updater_restart(false, marker_matches);
        let classified = classify_lifecycle(previously_setup_inputs());
        let verdict =
            require_local_toolchain_after_updater_restart(classified, false, updater_restart);
        assert!(!updater_restart);
        assert_eq!(verdict.state, LifecycleState::NeedsInstall);
    }
}
