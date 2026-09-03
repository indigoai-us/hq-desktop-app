use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;
use hq_desktop_core::first_run::merge_menubar_flags;
use serde_json::Value;

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

/// Read `startAtLogin` from ~/.hq/menubar.json (best-effort), applying the
/// default-on semantics of `effective_start_at_login`.
fn start_at_login_pref() -> bool {
    let path = match paths::menubar_json_path() {
        Ok(p) => p,
        Err(_) => return true,
    };
    let prefs: Option<MenubarPrefs> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
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
    #[cfg(target_os = "macos")]
    {
        let report = hq_platform::launchagent::reconcile_installed(true);
        apply_reconcile_notice(&report);
    }
}

/// Same heal as launch, run after the updater has replaced the bundle and
/// before `app.restart()`.
pub fn reconcile_launch_agent_after_update() {
    reconcile_launch_agent_on_launch();
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
/// is removed). It ALSO self-heals an existing registration that points at a
/// stale executable path: an older build wrote `.../HQ.app/Contents/MacOS/HQ`,
/// but the bundled binary is `hq-sync-menubar`, so launchd exited EX_CONFIG
/// and autosync never ran. On upgrade we detect the mismatch and rewrite the
/// plist to the current executable path. Best-effort: every IO error is logged
/// and swallowed so a failure here can never abort app launch.
pub fn ensure_autostart_on_launch() {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use hq_platform::autostart::ReconcileAction;

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

        // Path currency only matters while a registration exists. On a probe
        // error, assume current so a transient failure never rewrites the plist.
        let path_is_current = if currently_enabled {
            match hq_platform::autostart::is_current() {
                Ok(v) => v,
                Err(e) => {
                    log(
                        "autostart",
                        &format!("ensure: cannot read autostart path state: {e}"),
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
            path_is_current,
        ) {
            ReconcileAction::None => {}
            action @ (ReconcileAction::Enable | ReconcileAction::Refresh) => {
                match hq_platform::autostart::set_enabled(true) {
                    Ok(()) => {
                        let created = if action == ReconcileAction::Refresh {
                            "rewrote stale LaunchAgent path"
                        } else {
                            "created LaunchAgent plist (default-on)"
                        };
                        #[cfg(target_os = "macos")]
                        log("autostart", &format!("ensure: {created}"));
                        #[cfg(target_os = "windows")]
                        log(
                            "autostart",
                            &format!(
                                "ensure: {}",
                                created
                                    .replace("LaunchAgent plist", "Run value")
                                    .replace("LaunchAgent", "Run value")
                            ),
                        );
                    }
                    Err(e) => log("autostart", &format!("ensure: set autostart failed: {e}")),
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
            cli_auto_update: None,
            auto_update: None,
            staging_channel: None,
            release_channel: None,
            meeting_detect_notify: None,
            default_recording_company_uid: None,
            telemetry_enabled: None,
            claude_projects_dir: None,
            widget_enabled: None,
            widget_display: None,
            widget_placement: None,
            widget_auto_hide_seconds: None,
            widget_show_needs_action: None,
            dock_icon: None,
            hq_work_handoff: None,
            system_notifications: None,
            native_notify_direct_messages: None,
            native_notify_shares: None,
            native_notify_meetings: None,
            native_notify_only_when_unfocused: None,
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
