//! The Settings "Cloud" switch (usage-only-pricing US-016).
//!
//! One control that turns every cloud upload and download for company vaults
//! and the personal vault off on this computer, and back on.
//!
//! The persisted flag is `cloudPaused` in `~/.hq/menubar.json`. That file lives
//! outside the app bundle, so the choice survives restarts and app updates.
//! Every desktop sync entry point already refuses while the flag is set
//! (`hq_desktop_core::daemon::ensure_cloud_sync_allowed` /
//! `ensure_sync_spawn_allowed`). This command adds the part that was missing:
//! a single place that writes the flag AND stops whatever is already running.
//!
//! Turning Cloud off:
//! 1. writes `cloudPaused: true` first, so nothing new can start;
//! 2. cancels an in-flight one-shot sync (legacy host);
//! 3. stops background sync (legacy watch runner, or `hq daemon sync pause`
//!    when the HQ CLI daemon owns sync);
//! 4. also pauses the HQ CLI daemon's sync service when the legacy host owns
//!    sync, so a CLI daemon on the same machine cannot keep syncing.
//!
//! Turning Cloud on clears the flag and restarts background sync only when
//! the user's Auto-sync switch is on. The per-sync switches are left alone.
//!
//! Sign-in, DMs, deploys, telemetry and update checks do not consult this flag
//! and keep working.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::config::MenubarPrefs;
use crate::util::paths;

const LOG_TAG: &str = "cloud-switch";

/// Emitted after the switch changes so every window (title bar pill, Core
/// popover, Settings) repaints without waiting for its next poll.
pub const EVENT_CLOUD_SWITCH_CHANGED: &str = "hq:cloud-switch-changed";

/// Result of a switch change, returned to the Settings pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSwitchOutcome {
    /// The persisted state after the change.
    pub cloud_enabled: bool,
    /// Plain-language note when the switch was saved but a follow-up step
    /// (stopping or starting background sync) did not complete. The saved
    /// setting still governs every new sync; this only tells the user that a
    /// process may need a moment or an app restart.
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSwitchChangedEvent {
    cloud_enabled: bool,
}

/// Side effects the switch drives. Injected so tests can prove the order
/// (persist first when turning off) without spawning processes.
pub(crate) trait CloudSwitchEffects {
    fn persist(&mut self, cloud_paused: bool) -> Result<(), String>;
    fn cancel_one_shot_sync(&mut self);
    fn stop_background_sync(&mut self) -> Result<(), String>;
    /// Pause the HQ CLI daemon's sync service even when the desktop's legacy
    /// host owns sync. Best effort: a machine without the CLI has no daemon.
    fn pause_cli_daemon_sync(&mut self) -> Result<(), String>;
    fn auto_sync_enabled(&self) -> bool;
    fn start_background_sync(&mut self) -> Result<(), String>;
}

pub(crate) const STOP_NOTICE: &str =
    "Cloud is off. Background sync is still stopping; it will not start again.";
pub(crate) const START_NOTICE: &str =
    "Cloud is on. Background sync did not start yet; use Sync now or restart HQ.";

/// Apply a switch change through `effects`. Persisting is the only step whose
/// failure fails the command: once the flag is on disk every sync path honors
/// it, so a slow process stop is reported as a notice, not an error.
pub(crate) fn apply_cloud_switch(
    enabled: bool,
    effects: &mut impl CloudSwitchEffects,
) -> Result<CloudSwitchOutcome, String> {
    if enabled {
        effects.persist(false)?;
        let mut notice = None;
        if effects.auto_sync_enabled() {
            if let Err(error) = effects.start_background_sync() {
                crate::util::logfile::log(
                    LOG_TAG,
                    &format!("background sync did not start after Cloud on: {error}"),
                );
                notice = Some(START_NOTICE.to_string());
            }
        }
        return Ok(CloudSwitchOutcome {
            cloud_enabled: true,
            notice,
        });
    }

    effects.persist(true)?;
    effects.cancel_one_shot_sync();
    let mut notice = None;
    if let Err(error) = effects.stop_background_sync() {
        crate::util::logfile::log(
            LOG_TAG,
            &format!("background sync did not stop after Cloud off: {error}"),
        );
        notice = Some(STOP_NOTICE.to_string());
    }
    if let Err(error) = effects.pause_cli_daemon_sync() {
        // No CLI or no CLI daemon on this machine is the common case here.
        crate::util::logfile::log(
            LOG_TAG,
            &format!("HQ CLI daemon sync pause skipped: {error}"),
        );
    }
    Ok(CloudSwitchOutcome {
        cloud_enabled: false,
        notice,
    })
}

/// Write only `cloudPaused`, merged over the latest on-disk settings.
pub(crate) fn persist_cloud_paused_at(path: &Path, cloud_paused: bool) -> Result<(), String> {
    let mut prefs: MenubarPrefs = crate::commands::settings::get_settings_at(path)?;
    prefs.cloud_paused = Some(cloud_paused);
    crate::commands::settings::save_settings_at(path, &prefs)
}

struct LiveEffects<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> CloudSwitchEffects for LiveEffects<R> {
    fn persist(&mut self, cloud_paused: bool) -> Result<(), String> {
        let path = paths::menubar_json_path()?;
        persist_cloud_paused_at(&path, cloud_paused)
    }

    fn cancel_one_shot_sync(&mut self) {
        let _ = crate::commands::sync::cancel_sync();
    }

    fn stop_background_sync(&mut self) -> Result<(), String> {
        crate::commands::daemon::stop_daemon().map(|_| ())
    }

    fn pause_cli_daemon_sync(&mut self) -> Result<(), String> {
        use crate::commands::hq_daemon_host::{current_phase, HostPhase};
        // In daemon mode `stop_background_sync` already ran this pause.
        if current_phase() == HostPhase::Daemon {
            return Ok(());
        }
        crate::commands::hq_daemon_host::set_daemon_sync(false)
    }

    fn auto_sync_enabled(&self) -> bool {
        hq_desktop_core::daemon::is_realtime_sync_enabled()
            || hq_desktop_core::daemon::is_autostart_enabled()
    }

    fn start_background_sync(&mut self) -> Result<(), String> {
        crate::commands::daemon::start_daemon(self.app.clone()).map(|_| ())
    }
}

/// Read the Cloud switch. `true` = Cloud on (sync allowed).
#[tauri::command]
pub fn get_cloud_enabled() -> bool {
    !hq_desktop_core::daemon::is_cloud_paused()
}

/// Turn Cloud on or off for this computer. See the module docs.
#[tauri::command]
pub async fn set_cloud_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<CloudSwitchOutcome, String> {
    let handle = app.clone();
    // Stopping or starting sync spawns and waits on processes; keep it off the
    // async runtime's worker threads.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut effects = LiveEffects { app: handle };
        apply_cloud_switch(enabled, &mut effects)
    })
    .await
    .map_err(|error| format!("Cloud switch task failed: {error}"))??;
    crate::commands::client_health::notify_client_health_state_changed();
    let _ = app.emit(
        EVENT_CLOUD_SWITCH_CHANGED,
        CloudSwitchChangedEvent {
            cloud_enabled: outcome.cloud_enabled,
        },
    );
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        auto_sync: bool,
        persist_fails: bool,
        stop_fails: bool,
        start_fails: bool,
        cli_fails: bool,
    }

    impl CloudSwitchEffects for Recorder {
        fn persist(&mut self, cloud_paused: bool) -> Result<(), String> {
            self.calls.push(format!("persist:{cloud_paused}"));
            if self.persist_fails {
                Err("disk full".to_string())
            } else {
                Ok(())
            }
        }
        fn cancel_one_shot_sync(&mut self) {
            self.calls.push("cancel".to_string());
        }
        fn stop_background_sync(&mut self) -> Result<(), String> {
            self.calls.push("stop".to_string());
            if self.stop_fails {
                Err("busy".to_string())
            } else {
                Ok(())
            }
        }
        fn pause_cli_daemon_sync(&mut self) -> Result<(), String> {
            self.calls.push("cli-pause".to_string());
            if self.cli_fails {
                Err("HQ CLI missing".to_string())
            } else {
                Ok(())
            }
        }
        fn auto_sync_enabled(&self) -> bool {
            self.auto_sync
        }
        fn start_background_sync(&mut self) -> Result<(), String> {
            self.calls.push("start".to_string());
            if self.start_fails {
                Err("no runner".to_string())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn turning_cloud_off_persists_before_stopping_anything() {
        let mut effects = Recorder::default();
        let outcome = apply_cloud_switch(false, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:true", "cancel", "stop", "cli-pause"]
        );
        assert_eq!(
            outcome,
            CloudSwitchOutcome {
                cloud_enabled: false,
                notice: None
            }
        );
    }

    #[test]
    fn turning_cloud_off_fails_without_side_effects_when_the_flag_cannot_be_saved() {
        let mut effects = Recorder {
            persist_fails: true,
            ..Recorder::default()
        };
        assert!(apply_cloud_switch(false, &mut effects).is_err());
        assert_eq!(effects.calls, vec!["persist:true"]);
    }

    #[test]
    fn a_slow_background_stop_is_a_notice_not_an_error() {
        let mut effects = Recorder {
            stop_fails: true,
            cli_fails: true,
            ..Recorder::default()
        };
        let outcome = apply_cloud_switch(false, &mut effects).unwrap();
        assert!(!outcome.cloud_enabled);
        assert_eq!(outcome.notice.as_deref(), Some(STOP_NOTICE));
        // The CLI daemon pause still runs after a failed desktop stop.
        assert_eq!(
            effects.calls,
            vec!["persist:true", "cancel", "stop", "cli-pause"]
        );
    }

    #[test]
    fn a_missing_cli_does_not_produce_a_notice() {
        let mut effects = Recorder {
            cli_fails: true,
            ..Recorder::default()
        };
        let outcome = apply_cloud_switch(false, &mut effects).unwrap();
        assert_eq!(outcome.notice, None);
    }

    #[test]
    fn turning_cloud_on_restarts_background_sync_only_when_auto_sync_is_on() {
        let mut auto_on = Recorder {
            auto_sync: true,
            ..Recorder::default()
        };
        let outcome = apply_cloud_switch(true, &mut auto_on).unwrap();
        assert_eq!(auto_on.calls, vec!["persist:false", "start"]);
        assert!(outcome.cloud_enabled);
        assert_eq!(outcome.notice, None);

        let mut auto_off = Recorder::default();
        apply_cloud_switch(true, &mut auto_off).unwrap();
        assert_eq!(auto_off.calls, vec!["persist:false"]);
    }

    #[test]
    fn turning_cloud_on_reports_a_start_failure_as_a_notice() {
        let mut effects = Recorder {
            auto_sync: true,
            start_fails: true,
            ..Recorder::default()
        };
        let outcome = apply_cloud_switch(true, &mut effects).unwrap();
        assert!(outcome.cloud_enabled);
        assert_eq!(outcome.notice.as_deref(), Some(START_NOTICE));
    }

    fn temp_config(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "hq-cloud-switch-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// The switch must survive a restart and an app update: it lives in
    /// `~/.hq/menubar.json`, and writing it must not drop the other per-sync
    /// switches or keys the typed prefs do not model.
    #[test]
    fn the_switch_persists_and_leaves_other_settings_alone() {
        let dir = temp_config("persist");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("menubar.json");
        std::fs::write(
            &path,
            r#"{"realtimeSync":false,"personalSyncEnabled":false,"machineId":"m-1"}"#,
        )
        .unwrap();

        persist_cloud_paused_at(&path, true).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["cloudPaused"], serde_json::json!(true));
        assert_eq!(raw["realtimeSync"], serde_json::json!(false));
        assert_eq!(raw["personalSyncEnabled"], serde_json::json!(false));
        assert_eq!(raw["machineId"], serde_json::json!("m-1"));

        // A fresh read (the restart seam) sees the saved choice.
        let reread = crate::commands::settings::get_settings_at(&path).unwrap();
        assert_eq!(reread.cloud_paused, Some(true));

        persist_cloud_paused_at(&path, false).unwrap();
        let reread = crate::commands::settings::get_settings_at(&path).unwrap();
        assert_eq!(reread.cloud_paused, Some(false));
        assert_eq!(reread.realtime_sync, Some(false));

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// With Cloud off, the user-started paths that move vault file content
    /// outside the main sync (conflict keep-local/keep-cloud, "Move to cloud",
    /// opening a cloud placeholder) refuse before they spawn anything.
    #[test]
    fn cloud_off_refuses_the_side_doors_that_move_vault_files() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"cloudPaused":true}"#,
        )
        .unwrap();
        let _home = scoped_home(tmp.path());
        let paused = hq_desktop_core::daemon::CLOUD_PAUSED_MESSAGE.to_string();

        let offload =
            tauri::async_runtime::block_on(crate::commands::storage::run_storage_offload());
        assert_eq!(offload.err(), Some(paused.clone()));

        let resolve = tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
            "companies/acme/notes.md".to_string(),
            "keep-local".to_string(),
        ));
        assert_eq!(resolve.err(), Some(paused));

        let placeholder = tmp.path().join("big.mov.hqcloud");
        let fetch =
            tauri::async_runtime::block_on(crate::commands::cloud_file::fetch(&placeholder));
        assert_eq!(
            fetch.err(),
            Some(crate::commands::cloud_file::CLOUD_OFF_CODE)
        );

        assert!(!get_cloud_enabled());
    }

    #[test]
    fn the_switch_can_be_saved_on_a_fresh_install() {
        let dir = temp_config("fresh");
        let path = dir.join("menubar.json");
        persist_cloud_paused_at(&path, true).unwrap();
        let reread = crate::commands::settings::get_settings_at(&path).unwrap();
        assert_eq!(reread.cloud_paused, Some(true));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
