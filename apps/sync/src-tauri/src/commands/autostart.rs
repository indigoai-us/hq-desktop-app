use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;
use hq_desktop_core::first_run::merge_menubar_flags;
use serde_json::{json, Value};

/// One-time in-app copy when a stale LaunchAgent was healed or an old bundle
/// was retired. Persisted untyped in menubar.json so a settings save cannot
/// drop it.
pub const LAUNCH_AGENT_REPOINT_NOTICE: &str =
    "HQ updated its launch settings; the old copy was retired";
const NOTICE_KEY: &str = "launchAgentRepointNoticePending";

/// Check whether autostart is enabled.
#[tauri::command]
pub async fn get_autostart_enabled() -> Result<bool, String> {
    hq_platform::autostart::is_enabled()
}

/// Enable or disable autostart.
#[tauri::command]
pub async fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    if crate::scratch_build::active() {
        crate::scratch_build::skip("set_autostart_enabled");
        return Err("Start at login is turned off for this test build".to_string());
    }
    hq_platform::autostart::set_enabled(enabled)
}

/// Resolve the effective `startAtLogin` preference.
///
/// Defaults to `true` when menubar.json is absent or the field is missing —
/// matching the Settings UI default (`settings.rs`) and the `realtime_sync`
/// default-on convention in `daemon.rs`. Only an explicit
/// `"startAtLogin": false` opts out. Kept pure (takes parsed prefs) so the
/// default semantics are unit-testable without touching the real home dir.
fn effective_start_at_login(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.start_at_login).unwrap_or(true)
}

fn build_autostart_state_event(
    prefs: Option<&MenubarPrefs>,
    platform: &str,
    registered: Option<bool>,
) -> (&'static str, Value) {
    let mut properties = json!({
        "enabled": effective_start_at_login(prefs),
        "platform": platform,
    });
    if let Some(registered) = registered {
        properties["registered"] = Value::Bool(registered);
    }
    ("desktop_autostart_state", properties)
}

fn read_menubar_prefs() -> Option<MenubarPrefs> {
    let path = paths::menubar_json_path().ok()?;
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
}

/// Build the bounded launch-state event after platform reconciliation.
/// Registration state is omitted on unsupported platforms or when unreadable.
pub fn autostart_state_event_after_reconciliation() -> (&'static str, Value) {
    let prefs = read_menubar_prefs();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let registered = hq_platform::autostart::is_enabled().ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let registered = None;

    build_autostart_state_event(prefs.as_ref(), std::env::consts::OS, registered)
}

/// Closed, launch-time registration state for operational liveness telemetry.
/// This reports the platform registration itself, not the settings preference.
pub fn desktop_start_at_login_status() -> &'static str {
    let prefs = read_menubar_prefs();
    let preference = prefs
        .as_ref()
        .map(|prefs| effective_start_at_login(Some(prefs)));
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let registered = hq_platform::autostart::is_enabled().ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let registered = None;
    crate::commands::telemetry::classify_start_at_login(preference, registered)
}

/// Read `startAtLogin` from ~/.hq/menubar.json (best-effort), applying the
/// default-on semantics of `effective_start_at_login`.
fn start_at_login_pref() -> bool {
    let prefs = read_menubar_prefs();
    effective_start_at_login(prefs.as_ref())
}

/// True when menubar.json is holding an undismissed LaunchAgent heal notice.
pub fn launch_agent_notice_pending_in_json(contents: &str) -> bool {
    serde_json::from_str::<Value>(contents)
        .ok()
        .and_then(|v| v.get(NOTICE_KEY).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn persist_launch_agent_notice() {
    let Ok(path) = paths::menubar_json_path() else {
        return;
    };
    if let Err(err) = merge_menubar_flags(&path, &[(NOTICE_KEY, Value::Bool(true))]) {
        log("launchagent", &format!("persist notice failed: {err}"));
    }
}

fn apply_reconcile_notice(report: &hq_platform::launchagent::ReconcileReport) {
    if report.should_surface_notice() {
        persist_launch_agent_notice();
    }
}

/// Heal a LaunchAgent that still points at a renamed bundle (`HQ Sync.app`)
/// and retire a leftover copy in `/Applications`. Idempotent. No-op on
/// non-macOS and when this process is not the shipped `/Applications` app
/// (so `cargo tauri dev` cannot rewrite the user's login agent).
pub fn reconcile_launch_agent_on_launch() {
    if !crate::scratch_build::launch_side_effect_allowed("LaunchAgent reconcile") {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let report = hq_platform::launchagent::reconcile_installed(true);
        apply_reconcile_notice(&report);
    }
}

/// Same heal as launch, run after the updater has replaced the bundle and
/// before the launchd handoff (or GUI `app.restart()` fallback).
pub fn reconcile_launch_agent_after_update() {
    reconcile_launch_agent_on_launch();
}

/// Prefer handing restart to launchd so HQ is not relaunched as a GUI app.
/// A LaunchServices relaunch is invisible to the KeepAlive agent, which then
/// starts a second copy every ~10s and the single-instance handler steals
/// focus. Falls back to `app.restart()` when no LaunchAgent is installed.
/// Returns `false` when a protected activity deferred the restart. Successful
/// restart paths do not return, preserving `AppHandle::restart` semantics.
pub fn restart_preferring_launch_agent(app: &tauri::AppHandle) -> bool {
    restart_preferring_launch_agent_with_update_version(app, None)
}

/// Restart after a verified update, carrying its target version through the GUI
/// fallback when no LaunchAgent can perform the restart.
pub fn restart_after_update_preferring_launch_agent(
    app: &tauri::AppHandle,
    expected_version: &str,
) -> bool {
    restart_preferring_launch_agent_with_update_version(app, Some(expected_version))
}

fn restart_preferring_launch_agent_with_update_version(
    app: &tauri::AppHandle,
    update_version: Option<&str>,
) -> bool {
    if let Some(reasons) = crate::updater::restart_is_held(app) {
        log(
            "updater",
            &format!("restart deferred while protected activity is active: {reasons:?}"),
        );
        crate::updater::defer_restart_until_safe(app.clone(), update_version.map(str::to_owned));
        return false;
    }
    if update_version.is_some() {
        crate::commands::telemetry::note_desktop_quit_reason(
            crate::commands::telemetry::DesktopQuitReason::UpdateRestart,
        );
    }
    #[cfg(target_os = "macos")]
    if crate::scratch_build::production_bundle() {
        if hq_platform::launchagent::schedule_handoff_after_exit() {
            log(
                "updater",
                "restart handed to launchd; exiting without GUI relaunch",
            );
            app.exit(0);
            std::process::exit(0);
        }
        log(
            "updater",
            "launchd handoff unavailable; falling back to GUI relaunch",
        );
    }
    if let Some(version) = update_version {
        if let Err(error) =
            crate::commands::updater_restart_marker::persist_before_gui_restart(app, version)
        {
            log(
                "updater",
                &format!("could not persist updater restart marker: {error}"),
            );
        }
    }
    app.restart()
}

/// Return the one-time LaunchAgent heal note and clear the pending flag.
#[tauri::command]
pub fn take_launch_agent_repoint_notice() -> Option<String> {
    let path = paths::menubar_json_path().ok()?;
    if !path.exists() {
        return None;
    }
    let contents = std::fs::read_to_string(&path).ok()?;
    if !launch_agent_notice_pending_in_json(&contents) {
        return None;
    }
    if let Err(err) = merge_menubar_flags(&path, &[(NOTICE_KEY, Value::Bool(false))]) {
        log("launchagent", &format!("clear notice failed: {err}"));
    }
    Some(LAUNCH_AGENT_REPOINT_NOTICE.to_string())
}

/// Idempotent launch-time autostart reconciliation.
///
/// Called from `main.rs` `.setup()`. Ensures the LaunchAgent plist matches
/// the effective `startAtLogin` preference so a fresh install autostarts by
/// default without the user having to open Settings — while still honouring
/// an explicit `"startAtLogin": false` opt-out (in which case a stale plist
/// is removed). It also self-heals an existing registration with a stale
/// executable path or missing restart policy. On upgrade, a stale LaunchAgent
/// plist is rewritten and reloaded so launchd uses the current definition.
/// Best-effort: every IO error is logged and swallowed so a failure here can
/// never abort app launch.
pub fn ensure_autostart_on_launch() {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use hq_platform::autostart::{LaunchEnsureGate, ReconcileAction};

        // Only the installed production bundle may write the login item at
        // launch. A scratch build shares ~/Library/LaunchAgents and would
        // otherwise repoint the owner's login item at itself. The bundle
        // identifier comes from the same source as every other launch-time
        // gate (scratch_build::LaunchIdentity); Windows has none to read and
        // counts as production, so only the env switch applies there.
        let bundle_identifier = crate::scratch_build::running_bundle_identifier();
        // A scratch build counts as HQ_UPDATER_DISABLED=1 (scratch_build.rs).
        let updater_disabled = if crate::scratch_build::active() {
            Some("1".to_string())
        } else {
            std::env::var(hq_platform::autostart::UPDATER_DISABLED_ENV).ok()
        };
        match hq_platform::autostart::launch_ensure_gate(
            bundle_identifier,
            updater_disabled.as_deref(),
        ) {
            LaunchEnsureGate::Proceed => {}
            LaunchEnsureGate::SkipUpdaterDisabled => {
                log(
                    "autostart",
                    "autostart: ensure skipped, HQ_UPDATER_DISABLED is set",
                );
                return;
            }
            LaunchEnsureGate::SkipNonProductionBundle(id) => {
                log(
                    "autostart",
                    &format!(
                        "autostart: ensure skipped, non-production bundle {}",
                        id.as_deref().unwrap_or("<unknown>")
                    ),
                );
                return;
            }
        }

        let want_enabled = start_at_login_pref();

        let currently_enabled = match hq_platform::autostart::is_enabled() {
            Ok(enabled) => enabled,
            Err(e) => {
                log(
                    "autostart",
                    &format!("ensure: cannot read current autostart state: {e}"),
                );
                // macOS: can't safely reconcile without a reliable read — bail.
                // Windows: treat as not-registered and let reconciliation
                // (re)create it if wanted (matches the prior behavior).
                #[cfg(target_os = "macos")]
                {
                    return;
                }
                #[cfg(target_os = "windows")]
                {
                    false
                }
            }
        };

        // Registration currency only matters while a registration exists. On
        // a probe error, assume current so a transient failure never rewrites
        // the plist.
        let registration_is_current = if currently_enabled {
            match hq_platform::autostart::is_current() {
                Ok(v) => v,
                Err(e) => {
                    log(
                        "autostart",
                        &format!("ensure: cannot read LaunchAgent registration state: {e}"),
                    );
                    true
                }
            }
        } else {
            true
        };

        match hq_platform::autostart::reconcile_action(
            want_enabled,
            currently_enabled,
            registration_is_current,
        ) {
            ReconcileAction::None => {}
            action @ (ReconcileAction::Enable | ReconcileAction::Refresh) => {
                let mut deferred_until_next_login = false;
                let result = hq_platform::autostart::apply_reconcile_action(
                    action,
                    hq_platform::autostart::set_enabled,
                    || {
                        #[cfg(target_os = "macos")]
                        {
                            let argv: Vec<String> = std::env::args().collect();
                            hq_platform::launchagent::argv_is_launch_agent_relaunch(&argv)
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            false
                        }
                    },
                    || {
                        #[cfg(target_os = "macos")]
                        {
                            hq_platform::launchagent::reload_installed_launch_agent()
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            Ok(())
                        }
                    },
                    || {
                        deferred_until_next_login = true;
                        log(
                            "autostart",
                            "ensure: LaunchAgent plist refreshed; the current agent process will keep running and the new policy takes effect at the next login",
                        );
                    },
                );
                match result {
                    Ok(()) if !deferred_until_next_login => {
                        let outcome = if action == ReconcileAction::Refresh {
                            "refreshed stale autostart registration"
                        } else {
                            "created autostart registration (default-on)"
                        };
                        log("autostart", &format!("ensure: {outcome}"));
                    }
                    Ok(()) => {}
                    Err(e) => log("autostart", &format!("ensure: reconciliation failed: {e}")),
                }
            }
            ReconcileAction::Disable => match hq_platform::autostart::set_enabled(false) {
                Ok(()) => {
                    #[cfg(target_os = "macos")]
                    log(
                        "autostart",
                        "ensure: removed LaunchAgent plist (explicit opt-out)",
                    );
                    #[cfg(target_os = "windows")]
                    log("autostart", "ensure: removed Run value (explicit opt-out)");
                }
                Err(e) => log("autostart", &format!("ensure: set autostart failed: {e}")),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prefs_with_start(start: Option<bool>) -> MenubarPrefs {
        MenubarPrefs {
            hq_path: None,
            cloud_paused: None,
            sync_on_launch: None,
            notifications: None,
            start_at_login: start,
            autostart_daemon: None,
            realtime_sync: None,
            personal_sync_enabled: None,
            instant_sync: None,
            sync_bandwidth_percent: None,
            drift_staging_repo: None,
            share_notifications: None,
            dm_notifications: None,
            custom_banner: None,
            notification_surface: None,
            cli_auto_update: None,
            auto_update: None,
            staging_channel: None,
            release_channel: None,
            meeting_detect_notify: None,
            auto_record_meetings: None,
            default_recording_company_uid: None,
            telemetry_enabled: None,
            claude_projects_dir: None,
            dock_icon: None,
            hq_work_handoff: None,
            in_app_sessions: None,
            system_notifications: None,
            native_notify_direct_messages: None,
            native_notify_shares: None,
            native_notify_meetings: None,
            native_notify_only_when_unfocused: None,
        }
    }

    #[test]
    fn autostart_state_event_reports_effective_preference() {
        let cases = [(None, true), (Some(false), false), (Some(true), true)];

        for (preference, expected_enabled) in cases {
            let prefs = preference.map(|value| prefs_with_start(Some(value)));
            let (event_name, properties) = build_autostart_state_event(
                prefs.as_ref(),
                std::env::consts::OS,
                Some(expected_enabled),
            );

            assert_eq!(event_name, "desktop_autostart_state");
            assert_eq!(properties["enabled"], expected_enabled);
            assert_eq!(properties["platform"], std::env::consts::OS);
            assert_eq!(properties["registered"], expected_enabled);
        }
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_absent() {
        // No menubar.json at all -> autostart on by default.
        assert!(effective_start_at_login(None));
    }

    #[test]
    fn test_effective_start_at_login_defaults_on_when_field_missing() {
        // menubar.json exists but startAtLogin not set -> default on.
        let p = prefs_with_start(None);
        assert!(effective_start_at_login(Some(&p)));
    }

    #[test]
    fn test_effective_start_at_login_explicit_true() {
        let p = prefs_with_start(Some(true));
        assert!(effective_start_at_login(Some(&p)));
    }

    #[test]
    fn test_effective_start_at_login_explicit_false_opts_out() {
        // The one case that disables autostart: explicit opt-out.
        let p = prefs_with_start(Some(false));
        assert!(!effective_start_at_login(Some(&p)));
    }

    #[test]
    fn launch_agent_notice_pending_reads_flag() {
        assert!(!launch_agent_notice_pending_in_json("{}"));
        assert!(!launch_agent_notice_pending_in_json("not json"));
        assert!(launch_agent_notice_pending_in_json(
            r#"{"launchAgentRepointNoticePending":true}"#
        ));
        assert!(!launch_agent_notice_pending_in_json(
            r#"{"launchAgentRepointNoticePending":false}"#
        ));
    }

    #[test]
    fn take_launch_agent_notice_is_one_shot() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("menubar.json");
        std::fs::write(
            &path,
            r#"{"machineId":"keep-me","launchAgentRepointNoticePending":true}"#,
        )
        .unwrap();
        assert!(launch_agent_notice_pending_in_json(
            &std::fs::read_to_string(&path).unwrap()
        ));
        merge_menubar_flags(&path, &[(NOTICE_KEY, Value::Bool(false))]).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!launch_agent_notice_pending_in_json(&body));
        assert!(body.contains("keep-me"));
        assert_eq!(
            LAUNCH_AGENT_REPOINT_NOTICE,
            "HQ updated its launch settings; the old copy was retired"
        );
    }
}
