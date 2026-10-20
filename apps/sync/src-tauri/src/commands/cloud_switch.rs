//! The Settings › Sync switches (usage-only-pricing US-016): one "Turn off all
//! cloud sync" switch (this section) and one switch per vault (further down).
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
use hq_desktop_core::vault_sync::{SyncVault, VaultSyncSwitches};

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
    /// `Ok(true)` when this call paused it, `Ok(false)` when there was
    /// nothing for it to do (the daemon host already paused it).
    fn pause_cli_daemon_sync(&mut self) -> Result<bool, String>;
    /// Resume the HQ CLI daemon's sync service that the switch paused.
    fn resume_cli_daemon_sync(&mut self) -> Result<(), String>;
    /// Whether the switch paused the CLI daemon's sync (a saved marker, so the
    /// resume survives an app restart while sync is off).
    fn cli_daemon_paused_by_switch(&self) -> bool;
    fn remember_cli_daemon_paused_by_switch(&mut self, paused: bool) -> Result<(), String>;
    fn auto_sync_enabled(&self) -> bool;
    fn start_background_sync(&mut self) -> Result<(), String>;
}

/// Settings key recording that "Turn off all cloud sync" paused the HQ CLI
/// daemon's sync on the legacy host, so turning sync back on resumes it. A
/// daemon the person paused some other way is left alone.
pub(crate) const CLI_DAEMON_PAUSED_BY_SWITCH_KEY: &str = "cloudSwitchPausedCliDaemonSync";

pub(crate) const STOP_NOTICE: &str = "Cloud sync is off";
pub(crate) const START_NOTICE: &str = "Cloud sync is on";

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
        // Undo the CLI daemon pause this switch made when it went off (legacy
        // host). Without this the daemon stayed paused after sync came back.
        if effects.cli_daemon_paused_by_switch() {
            match effects.resume_cli_daemon_sync() {
                Ok(()) => {
                    if let Err(error) = effects.remember_cli_daemon_paused_by_switch(false) {
                        crate::util::logfile::log(
                            LOG_TAG,
                            &format!("could not clear the CLI daemon pause marker: {error}"),
                        );
                    }
                }
                Err(error) => {
                    // Keep the marker so the next switch-on retries.
                    crate::util::logfile::log(
                        LOG_TAG,
                        &format!("HQ CLI daemon sync did not resume after Cloud on: {error}"),
                    );
                    notice = Some(START_NOTICE.to_string());
                }
            }
        }
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
    match effects.pause_cli_daemon_sync() {
        Ok(true) => {
            if let Err(error) = effects.remember_cli_daemon_paused_by_switch(true) {
                crate::util::logfile::log(
                    LOG_TAG,
                    &format!("could not save the CLI daemon pause marker: {error}"),
                );
            }
        }
        Ok(false) => {}
        Err(error) => {
            // No CLI or no CLI daemon on this machine is the common case here.
            crate::util::logfile::log(
                LOG_TAG,
                &format!("HQ CLI daemon sync pause skipped: {error}"),
            );
        }
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

/// Read the CLI daemon pause marker. Missing or unreadable means not paused.
pub(crate) fn cli_daemon_paused_marker_at(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get(CLI_DAEMON_PAUSED_BY_SWITCH_KEY)
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

/// Save or clear the CLI daemon pause marker, keeping every other key.
pub(crate) fn write_cli_daemon_paused_marker_at(path: &Path, paused: bool) -> Result<(), String> {
    if paused {
        hq_desktop_core::first_run::merge_menubar_flags(
            path,
            &[(
                CLI_DAEMON_PAUSED_BY_SWITCH_KEY,
                serde_json::Value::Bool(true),
            )],
        )
    } else {
        hq_desktop_core::first_run::remove_menubar_keys(path, &[CLI_DAEMON_PAUSED_BY_SWITCH_KEY])
            .map(|_| ())
    }
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

    fn pause_cli_daemon_sync(&mut self) -> Result<bool, String> {
        use crate::commands::hq_daemon_host::{current_phase, HostPhase};
        // In daemon mode `stop_background_sync` already ran this pause, and
        // `start_background_sync` resumes it.
        if current_phase() == HostPhase::Daemon {
            return Ok(false);
        }
        crate::commands::hq_daemon_host::set_daemon_sync(false).map(|()| true)
    }

    fn resume_cli_daemon_sync(&mut self) -> Result<(), String> {
        crate::commands::hq_daemon_host::set_daemon_sync(true)
    }

    fn cli_daemon_paused_by_switch(&self) -> bool {
        paths::menubar_json_path()
            .map(|path| cli_daemon_paused_marker_at(&path))
            .unwrap_or(false)
    }

    fn remember_cli_daemon_paused_by_switch(&mut self, paused: bool) -> Result<(), String> {
        let path = paths::menubar_json_path()?;
        write_cli_daemon_paused_marker_at(&path, paused)
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

// ── Per-vault switches (US-016, widened 2026-10-18) ────────────────────────
//
// Settings › Sync lists the personal vault and every company vault, each with
// its own switch. Turning one off writes `personalSyncEnabled: false` or
// `workspaceSyncEnabled.<slug>: false`. The background runner reads those at
// spawn (`HQ_SYNC_SKIP_PERSONAL` / `HQ_SYNC_SKIP_COMPANIES`), so the running
// runner is restarted to pick the change up. Other vaults keep syncing. The
// switch affects only this computer; teammates are untouched.

/// The `vault` argument value that names the personal vault.
pub const PERSONAL_VAULT_ID: &str = "personal";

/// Result of a vault switch change, returned to the Settings pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSwitchOutcome {
    pub vault: String,
    pub enabled: bool,
    /// Plain-language note when the switch was saved but background sync did
    /// not restart. The saved switch still governs every new sync.
    pub notice: Option<String>,
}

pub(crate) const VAULT_RESTART_NOTICE: &str =
    "Saved. Background sync did not restart yet; use Sync now or restart HQ.";

/// Side effects a vault switch drives. Injected so tests can prove the order.
pub(crate) trait VaultSwitchEffects {
    fn persist(&mut self, vault: &SyncVault, enabled: bool) -> Result<(), String>;
    fn cloud_paused(&self) -> bool;
    fn cancel_one_shot_sync(&mut self);
    fn stop_background_sync(&mut self) -> Result<(), String>;
    fn auto_sync_enabled(&self) -> bool;
    fn start_background_sync(&mut self) -> Result<(), String>;
}

/// Parse the `vault` argument: `"personal"` or a company slug.
pub(crate) fn parse_vault_id(vault: &str) -> Result<SyncVault, String> {
    let vault = vault.trim();
    if vault.is_empty() {
        return Err("Choose a vault to turn sync on or off.".to_string());
    }
    if vault == PERSONAL_VAULT_ID {
        return Ok(SyncVault::Personal);
    }
    if vault.contains(['/', '\\']) || vault.starts_with('.') {
        return Err("That company name is not valid.".to_string());
    }
    Ok(SyncVault::Company(vault.to_string()))
}

/// Apply one vault switch. Persisting is the only step whose failure fails
/// the command. While "Turn off all cloud sync" is on nothing is running, so
/// only the saved value changes.
///
/// Cost: the runner takes its skip lists at spawn, so one vault's switch
/// restarts background sync for every vault, and turning a vault off also
/// cancels a one-shot sync in progress. The other vaults pick up again on the
/// restarted runner; a cancelled Sync now has to be run again.
pub(crate) fn apply_vault_switch(
    vault: &SyncVault,
    enabled: bool,
    effects: &mut impl VaultSwitchEffects,
) -> Result<VaultSwitchOutcome, String> {
    effects.persist(vault, enabled)?;
    let id = match vault {
        SyncVault::Personal => PERSONAL_VAULT_ID.to_string(),
        SyncVault::Company(slug) => slug.clone(),
    };
    let mut outcome = VaultSwitchOutcome {
        vault: id,
        enabled,
        notice: None,
    };
    if effects.cloud_paused() {
        return Ok(outcome);
    }
    if !enabled {
        // A one-shot sync already running may be moving this vault's files.
        effects.cancel_one_shot_sync();
    }
    // The runner reads the skip lists at spawn: restart it so the change
    // applies now. A stop failure still leaves the saved switch in force for
    // the next spawn.
    if let Err(error) = effects.stop_background_sync() {
        crate::util::logfile::log(
            LOG_TAG,
            &format!("background sync did not stop after a vault switch: {error}"),
        );
    }
    if effects.auto_sync_enabled() {
        if let Err(error) = effects.start_background_sync() {
            crate::util::logfile::log(
                LOG_TAG,
                &format!("background sync did not restart after a vault switch: {error}"),
            );
            outcome.notice = Some(VAULT_RESTART_NOTICE.to_string());
        }
    }
    Ok(outcome)
}

/// Write one vault's switch, merged over the latest on-disk settings.
pub(crate) fn persist_vault_enabled_at(
    path: &Path,
    vault: &SyncVault,
    enabled: bool,
) -> Result<(), String> {
    match vault {
        SyncVault::Personal => {
            let mut prefs: MenubarPrefs = crate::commands::settings::get_settings_at(path)?;
            prefs.personal_sync_enabled = Some(enabled);
            crate::commands::settings::save_settings_at(path, &prefs)
        }
        SyncVault::Company(slug) => {
            hq_desktop_core::workspaces::write_workspace_sync_enabled(slug, enabled)
        }
    }
}

impl<R: Runtime> VaultSwitchEffects for LiveEffects<R> {
    fn persist(&mut self, vault: &SyncVault, enabled: bool) -> Result<(), String> {
        let path = paths::menubar_json_path()?;
        persist_vault_enabled_at(&path, vault, enabled)
    }

    fn cloud_paused(&self) -> bool {
        hq_desktop_core::daemon::is_cloud_paused()
    }

    fn cancel_one_shot_sync(&mut self) {
        CloudSwitchEffects::cancel_one_shot_sync(self)
    }

    fn stop_background_sync(&mut self) -> Result<(), String> {
        CloudSwitchEffects::stop_background_sync(self)
    }

    fn auto_sync_enabled(&self) -> bool {
        CloudSwitchEffects::auto_sync_enabled(self)
    }

    fn start_background_sync(&mut self) -> Result<(), String> {
        CloudSwitchEffects::start_background_sync(self)
    }
}

/// Every vault switch for Settings › Sync, plus whether the HQ CLI this app
/// runs honours them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSyncSwitchesView {
    #[serde(flatten)]
    pub switches: VaultSyncSwitches,
    /// `Some(false)`: the managed HQ CLI predates the switches, so its
    /// `hq sync` and `hq daemon` sync can still move an off vault. Settings
    /// says so while a switch is off. `None` when it cannot tell.
    pub cli_honours_switches: Option<bool>,
}

/// Read every vault switch for Settings › Sync.
#[tauri::command]
pub async fn get_vault_sync_switches() -> VaultSyncSwitchesView {
    let switches = VaultSyncSwitches::read();
    if hq_desktop_core::vault_sync::settings_file_unreadable() {
        crate::util::logfile::log(
            "cloud-switch",
            hq_desktop_core::vault_sync::SETTINGS_UNREADABLE_WARNING,
        );
    }
    // The CLI check may probe the CLI the first time; keep it off the
    // main thread, and skip it when nothing is off.
    let cli_honours_switches = if switches.any_off() {
        tauri::async_runtime::spawn_blocking(
            hq_desktop_core::vault_sync::cli_honours_vault_switches,
        )
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    VaultSyncSwitchesView {
        switches,
        cli_honours_switches,
    }
}

/// Turn sync on or off for one vault on this computer. `vault` is
/// `"personal"` or a company slug.
#[tauri::command]
pub async fn set_vault_sync_enabled<R: Runtime>(
    app: AppHandle<R>,
    vault: String,
    enabled: bool,
) -> Result<VaultSwitchOutcome, String> {
    let target = parse_vault_id(&vault)?;
    // No host event: the Settings pane that made the change repaints from the
    // result and tells the other surfaces in the window
    // (`hq:workspace-sync-enabled-changed`); the Core menu re-reads the
    // workspace list on its poll.
    tauri::async_runtime::spawn_blocking(move || {
        let mut effects = LiveEffects { app };
        apply_vault_switch(&target, enabled, &mut effects)
    })
    .await
    .map_err(|error| format!("Vault switch task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The notices Settings shows after the all-off switch changes (owner
    /// copy, US-016 review).
    #[test]
    fn cloud_switch_notice_copy() {
        assert_eq!(STOP_NOTICE, "Cloud sync is off");
        assert_eq!(START_NOTICE, "Cloud sync is on");
    }

    #[derive(Default)]
    struct VaultRecorder {
        calls: Vec<String>,
        cloud_paused: bool,
        auto_sync: bool,
        persist_fails: bool,
        start_fails: bool,
    }

    impl VaultSwitchEffects for VaultRecorder {
        fn persist(&mut self, vault: &SyncVault, enabled: bool) -> Result<(), String> {
            self.calls.push(format!("persist:{vault:?}:{enabled}"));
            if self.persist_fails {
                Err("disk full".to_string())
            } else {
                Ok(())
            }
        }
        fn cloud_paused(&self) -> bool {
            self.cloud_paused
        }
        fn cancel_one_shot_sync(&mut self) {
            self.calls.push("cancel".to_string());
        }
        fn stop_background_sync(&mut self) -> Result<(), String> {
            self.calls.push("stop".to_string());
            Ok(())
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
    fn turning_one_vault_off_saves_first_then_restarts_background_sync() {
        let mut effects = VaultRecorder {
            auto_sync: true,
            ..VaultRecorder::default()
        };
        let vault = SyncVault::Company("acme".into());
        let outcome = apply_vault_switch(&vault, false, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:Company(\"acme\"):false", "cancel", "stop", "start"]
        );
        assert_eq!(
            outcome,
            VaultSwitchOutcome {
                vault: "acme".into(),
                enabled: false,
                notice: None
            }
        );
    }

    #[test]
    fn turning_a_vault_back_on_restarts_without_cancelling() {
        let mut effects = VaultRecorder {
            auto_sync: true,
            ..VaultRecorder::default()
        };
        apply_vault_switch(&SyncVault::Personal, true, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:Personal:true", "stop", "start"]
        );
    }

    #[test]
    fn a_vault_switch_with_auto_sync_off_does_not_start_background_sync() {
        let mut effects = VaultRecorder::default();
        apply_vault_switch(&SyncVault::Personal, false, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:Personal:false", "cancel", "stop"]
        );
    }

    #[test]
    fn a_vault_switch_while_all_cloud_sync_is_off_only_saves() {
        let mut effects = VaultRecorder {
            cloud_paused: true,
            auto_sync: true,
            ..VaultRecorder::default()
        };
        apply_vault_switch(&SyncVault::Company("acme".into()), true, &mut effects).unwrap();
        assert_eq!(effects.calls, vec!["persist:Company(\"acme\"):true"]);
    }

    #[test]
    fn a_failed_vault_save_changes_nothing() {
        let mut effects = VaultRecorder {
            persist_fails: true,
            auto_sync: true,
            ..VaultRecorder::default()
        };
        assert!(apply_vault_switch(&SyncVault::Personal, false, &mut effects).is_err());
        assert_eq!(effects.calls, vec!["persist:Personal:false"]);
    }

    #[test]
    fn a_failed_restart_is_a_notice() {
        let mut effects = VaultRecorder {
            auto_sync: true,
            start_fails: true,
            ..VaultRecorder::default()
        };
        let outcome =
            apply_vault_switch(&SyncVault::Company("acme".into()), false, &mut effects).unwrap();
        assert_eq!(outcome.notice.as_deref(), Some(VAULT_RESTART_NOTICE));
    }

    #[test]
    fn vault_ids_parse_to_personal_or_a_company() {
        assert_eq!(parse_vault_id("personal").unwrap(), SyncVault::Personal);
        assert_eq!(
            parse_vault_id(" acme ").unwrap(),
            SyncVault::Company("acme".into())
        );
        assert!(parse_vault_id("").is_err());
        assert!(parse_vault_id("../acme").is_err());
        assert!(parse_vault_id("a/b").is_err());
    }

    /// Both switch kinds survive a restart (they live in menubar.json) and
    /// leave every other setting alone.
    #[test]
    fn vault_switches_persist_and_leave_other_settings_alone() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let path = tmp.path().join(".hq/menubar.json");
        std::fs::write(&path, r#"{"realtimeSync":false,"machineId":"m-1"}"#).unwrap();
        let _home = scoped_home(tmp.path());

        persist_vault_enabled_at(&path, &SyncVault::Personal, false).unwrap();
        persist_vault_enabled_at(&path, &SyncVault::Company("acme".into()), false).unwrap();
        persist_vault_enabled_at(&path, &SyncVault::Company("zeta".into()), true).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["personalSyncEnabled"], serde_json::json!(false));
        assert_eq!(
            raw["workspaceSyncEnabled"]["acme"],
            serde_json::json!(false)
        );
        assert_eq!(raw["workspaceSyncEnabled"]["zeta"], serde_json::json!(true));
        assert_eq!(raw["realtimeSync"], serde_json::json!(false));
        assert_eq!(raw["machineId"], serde_json::json!("m-1"));

        // A fresh read (the restart seam) sees every saved choice.
        let switches = VaultSyncSwitches::read();
        assert!(!switches.all_off);
        assert!(!switches.personal_enabled);
        assert!(!switches.allows(&SyncVault::Company("acme".into())));
        assert!(switches.allows(&SyncVault::Company("zeta".into())));
        assert!(switches.allows(&SyncVault::Company("other".into())));
    }

    /// One company off: the side doors refuse for that company only.
    #[test]
    fn one_company_off_refuses_its_conflict_resolve_only() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"workspaceSyncEnabled":{"acme":false}}"#,
        )
        .unwrap();
        let _home = scoped_home(tmp.path());

        let resolve = tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
            "companies/acme/notes.md".to_string(),
            "keep-local".to_string(),
        ));
        assert_eq!(
            resolve.err(),
            Some(hq_desktop_core::vault_sync::vault_off_message(
                &SyncVault::Company("acme".into())
            ))
        );
        // `./` and `//` spellings of the same path are refused too.
        for spelled in ["./companies/acme/notes.md", "//companies/acme/notes.md"] {
            let resolve =
                tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
                    spelled.to_string(),
                    "keep-local".to_string(),
                ));
            assert_eq!(
                resolve.err(),
                Some(hq_desktop_core::vault_sync::vault_off_message(
                    &SyncVault::Company("acme".into())
                )),
                "{spelled}"
            );
        }
        // Another company is not refused by the vault gate (it fails later for
        // an unrelated reason in this sandbox, never with the off message).
        let other = tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
            "companies/zeta/notes.md".to_string(),
            "keep-local".to_string(),
        ));
        assert!(!other
            .err()
            .unwrap_or_default()
            .starts_with("Sync is off for"));
    }

    /// Review: "Move to cloud" has no per-vault scope, so it waits while any
    /// vault is off, and runs again once the vault is back on.
    #[test]
    fn move_to_cloud_refuses_while_one_vault_is_off_and_not_after_re_enable() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let path = tmp.path().join(".hq/menubar.json");
        std::fs::write(&path, r#"{"workspaceSyncEnabled":{"acme":false}}"#).unwrap();
        let _home = scoped_home(tmp.path());

        let offload =
            tauri::async_runtime::block_on(crate::commands::storage::run_storage_offload());
        assert_eq!(
            offload.err().as_deref(),
            Some(hq_desktop_core::vault_sync::OFFLOAD_VAULT_OFF_MESSAGE)
        );

        persist_vault_enabled_at(&path, &SyncVault::Company("acme".into()), true).unwrap();
        assert_eq!(
            hq_desktop_core::vault_sync::ensure_offload_allowed(),
            Ok(())
        );
    }

    /// Review: turning a vault back on lets its side doors run again.
    #[test]
    fn re_enabling_a_vault_lifts_its_conflict_resolve_refusal() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let path = tmp.path().join(".hq/menubar.json");
        std::fs::write(&path, r#"{"workspaceSyncEnabled":{"acme":false}}"#).unwrap();
        let _home = scoped_home(tmp.path());
        let off =
            hq_desktop_core::vault_sync::vault_off_message(&SyncVault::Company("acme".into()));
        let resolve = || {
            tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
                "companies/acme/notes.md".to_string(),
                "keep-local".to_string(),
            ))
        };
        assert_eq!(resolve().err(), Some(off.clone()));

        persist_vault_enabled_at(&path, &SyncVault::Company("acme".into()), true).unwrap();
        // No longer refused by the switch (it fails later in this sandbox).
        assert_ne!(resolve().err(), Some(off));
    }

    /// Review: a symlink from the personal vault into an off company vault
    /// must not resolve the conflict.
    #[cfg(unix)]
    #[test]
    fn a_symlink_into_an_off_company_vault_does_not_resolve() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        let hq = tmp.path().join("HQ");
        std::fs::create_dir_all(hq.join("companies/acme")).unwrap();
        std::fs::create_dir_all(hq.join("knowledge")).unwrap();
        std::fs::write(hq.join("companies/acme/real.md"), "x").unwrap();
        std::os::unix::fs::symlink(
            hq.join("companies/acme/real.md"),
            hq.join("knowledge/link.md"),
        )
        .unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            serde_json::json!({
                "hqPath": hq.to_string_lossy(),
                "workspaceSyncEnabled": { "acme": false }
            })
            .to_string(),
        )
        .unwrap();
        let _home = scoped_home(tmp.path());
        let resolve = tauri::async_runtime::block_on(crate::commands::conflicts::resolve_conflict(
            "knowledge/link.md".to_string(),
            "keep-local".to_string(),
        ));
        assert!(
            resolve.is_err(),
            "a link into an off vault must not resolve"
        );
    }

    /// Opening a cloud placeholder refuses for an off vault only.
    #[test]
    fn placeholder_fetch_refuses_only_for_an_off_vault() {
        use crate::util::test_support::{scoped_home, ENV_MUTEX};
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        let hq = tmp.path().join("HQ");
        std::fs::create_dir_all(hq.join("companies/acme")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            serde_json::json!({
                "hqPath": hq.to_string_lossy(),
                "personalSyncEnabled": false,
                "workspaceSyncEnabled": { "acme": false }
            })
            .to_string(),
        )
        .unwrap();
        let _home = scoped_home(tmp.path());
        let fetch = |rel: &str| {
            tauri::async_runtime::block_on(crate::commands::cloud_file::fetch(&hq.join(rel)))
        };
        let off = Some(crate::commands::cloud_file::CLOUD_OFF_CODE);
        assert_eq!(fetch("companies/acme/big.mov.hqcloud").err(), off);
        assert_eq!(fetch("knowledge/big.mov.hqcloud").err(), off);
        // Another company is not refused by the switch (it fails later in this
        // sandbox for an unrelated reason).
        assert_ne!(fetch("companies/zeta/big.mov.hqcloud").err(), off);
    }

    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        auto_sync: bool,
        persist_fails: bool,
        stop_fails: bool,
        start_fails: bool,
        cli_fails: bool,
        /// The CLI daemon owns sync (daemon host): the stop already paused it.
        daemon_host: bool,
        resume_fails: bool,
        cli_marker: bool,
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
        fn pause_cli_daemon_sync(&mut self) -> Result<bool, String> {
            self.calls.push("cli-pause".to_string());
            if self.cli_fails {
                Err("HQ CLI missing".to_string())
            } else {
                Ok(!self.daemon_host)
            }
        }
        fn resume_cli_daemon_sync(&mut self) -> Result<(), String> {
            self.calls.push("cli-resume".to_string());
            if self.resume_fails {
                Err("daemon busy".to_string())
            } else {
                Ok(())
            }
        }
        fn cli_daemon_paused_by_switch(&self) -> bool {
            self.cli_marker
        }
        fn remember_cli_daemon_paused_by_switch(&mut self, paused: bool) -> Result<(), String> {
            self.calls.push(format!("cli-marker:{paused}"));
            self.cli_marker = paused;
            Ok(())
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
            vec![
                "persist:true",
                "cancel",
                "stop",
                "cli-pause",
                "cli-marker:true"
            ]
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

    /// Legacy host: off pauses the HQ CLI daemon's sync, so on must resume
    /// it (review H2). Auto-sync off: only the daemon resume runs.
    #[test]
    fn off_then_on_resumes_the_cli_daemon_sync_the_switch_paused() {
        let mut effects = Recorder::default();
        apply_cloud_switch(false, &mut effects).unwrap();
        assert!(effects.cli_marker);
        effects.calls.clear();

        let outcome = apply_cloud_switch(true, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:false", "cli-resume", "cli-marker:false"]
        );
        assert!(outcome.cloud_enabled);
        assert_eq!(outcome.notice, None);
        assert!(!effects.cli_marker);

        // A second "on" does not resume a daemon the switch did not pause.
        effects.calls.clear();
        apply_cloud_switch(true, &mut effects).unwrap();
        assert_eq!(effects.calls, vec!["persist:false"]);
    }

    #[test]
    fn off_then_on_with_auto_sync_resumes_the_daemon_then_restarts_sync() {
        let mut effects = Recorder {
            auto_sync: true,
            ..Recorder::default()
        };
        apply_cloud_switch(false, &mut effects).unwrap();
        effects.calls.clear();
        apply_cloud_switch(true, &mut effects).unwrap();
        assert_eq!(
            effects.calls,
            vec!["persist:false", "cli-resume", "cli-marker:false", "start"]
        );
    }

    #[test]
    fn a_failed_cli_daemon_resume_keeps_the_marker_and_reports_a_notice() {
        let mut effects = Recorder {
            resume_fails: true,
            ..Recorder::default()
        };
        apply_cloud_switch(false, &mut effects).unwrap();
        let outcome = apply_cloud_switch(true, &mut effects).unwrap();
        assert!(outcome.cloud_enabled);
        assert_eq!(outcome.notice.as_deref(), Some(START_NOTICE));
        // Still marked, so the next switch-on tries again.
        assert!(effects.cli_marker);
    }

    /// Daemon host: the stop already paused the daemon and the start resumes
    /// it, so the switch records no marker and runs no extra resume.
    #[test]
    fn on_the_daemon_host_the_switch_records_no_cli_pause() {
        let mut effects = Recorder {
            daemon_host: true,
            auto_sync: true,
            ..Recorder::default()
        };
        apply_cloud_switch(false, &mut effects).unwrap();
        assert!(!effects.cli_marker);
        effects.calls.clear();
        apply_cloud_switch(true, &mut effects).unwrap();
        assert_eq!(effects.calls, vec!["persist:false", "start"]);
    }

    /// The marker lives in menubar.json, survives a restart, and leaves the
    /// other keys alone.
    #[test]
    fn the_cli_daemon_pause_marker_persists_and_clears() {
        let dir = temp_config("cli-marker");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("menubar.json");
        std::fs::write(&path, r#"{"cloudPaused":true,"machineId":"m-1"}"#).unwrap();
        assert!(!cli_daemon_paused_marker_at(&path));
        write_cli_daemon_paused_marker_at(&path, true).unwrap();
        assert!(cli_daemon_paused_marker_at(&path));
        write_cli_daemon_paused_marker_at(&path, false).unwrap();
        assert!(!cli_daemon_paused_marker_at(&path));
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["machineId"], serde_json::json!("m-1"));
        assert_eq!(raw["cloudPaused"], serde_json::json!(true));
        std::fs::remove_dir_all(dir).unwrap();
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
