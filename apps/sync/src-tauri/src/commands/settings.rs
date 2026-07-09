use crate::commands::config::{MeetingDetectNotifyPrefs, MenubarPrefs};
use crate::util::paths;
use hq_desktop_core::settings::{default_meeting_detect_notify, merge_prefs_over_existing};

/// Default platform allow-list (all five) when the field is absent from disk.
const DEFAULT_PLATFORMS: &[&str] = &["zoom", "meet", "teams", "slack", "webex"];

/// Read settings from ~/.hq/menubar.json.
/// Returns current prefs with defaults applied for missing fields.
///
/// `release_channel` is returned RAW (the value as stored on disk; `None`
/// when the user has never explicitly chosen a channel). The Settings UI
/// is responsible for resolving `None` into a displayed default via
/// `available_channels`; resolution-for-the-updater lives in
/// `updater::read_stored_release_channel` + `effective_channel` so this
/// boundary stays a pure pass-through. Persisting the resolved value
/// here would lock indigo users into "beta" the first time they touch
/// any unrelated toggle, defeating the "no preference" state the
/// effective_channel gate is designed to honor (Codex P1 review on #120).
#[tauri::command]
pub async fn get_settings() -> Result<MenubarPrefs, String> {
    let path = paths::menubar_json_path()?;

    if !path.exists() {
        return Ok(MenubarPrefs {
            hq_path: None,
            // Sync-on-launch defaults ON so a fresh install syncs as soon as it
            // opens, matching the always-on auto-sync (realtime_sync) default.
            sync_on_launch: Some(true),
            notifications: Some(true),
            start_at_login: Some(true),
            autostart_daemon: Some(false),
            realtime_sync: Some(true),
            personal_sync_enabled: Some(true),
            instant_sync: Some(true),
            drift_staging_repo: None,
            share_notifications: Some(true),
            dm_notifications: Some(true),
            cli_auto_update: Some(true),
            // Master automatic-updates switch defaults ON — a fresh install
            // keeps the app, CLI, and hq-core current silently.
            auto_update: Some(true),
            staging_channel: Some(true),
            release_channel: None,
            meeting_detect_notify: Some(default_meeting_detect_notify()),
            default_recording_company_uid: None,
            // Telemetry is opt-in; absent → off (mirrors
            // telemetry.rs::read_local_telemetry_enabled's unwrap_or(false)).
            telemetry_enabled: Some(false),
        });
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read menubar.json: {}", e))?;
    let prefs: MenubarPrefs = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse menubar.json: {}", e))?;

    // Apply defaults for missing fields. `realtime_sync` defaults ON — it
    // mirrors `is_realtime_sync_enabled` in daemon.rs so the Settings toggle
    // and the auto-start logic agree on a fresh install. `personal_sync_enabled`
    // defaults ON to preserve pre-5.25 behavior — only users who explicitly
    // toggle it off see the personal target drop from the fanout.
    let mdn = prefs
        .meeting_detect_notify
        .unwrap_or_else(default_meeting_detect_notify);
    Ok(MenubarPrefs {
        hq_path: prefs.hq_path,
        // Default ON (see the no-file branch above) — absent key syncs on launch.
        sync_on_launch: Some(prefs.sync_on_launch.unwrap_or(true)),
        notifications: Some(prefs.notifications.unwrap_or(true)),
        start_at_login: Some(prefs.start_at_login.unwrap_or(true)),
        autostart_daemon: Some(prefs.autostart_daemon.unwrap_or(false)),
        realtime_sync: Some(prefs.realtime_sync.unwrap_or(true)),
        personal_sync_enabled: Some(prefs.personal_sync_enabled.unwrap_or(true)),
        // Instant sync (event-driven) defaults ON, mirroring `realtime_sync`
        // and `is_instant_sync_enabled` in daemon.rs. Only ever takes effect
        // for `event_push_eligible()` users (Phase 1: @getindigo.ai).
        instant_sync: Some(prefs.instant_sync.unwrap_or(true)),
        drift_staging_repo: prefs.drift_staging_repo,
        // Share notifications default ON — re-read on each poll cycle so the
        // toggle takes effect without restart. Only active for @getindigo.ai
        // users (dogfood gate checked separately in share_notify.rs).
        share_notifications: Some(prefs.share_notifications.unwrap_or(true)),
        // DM notifications default ON — re-read directly from menubar.json on
        // each poll cycle in dm_notify.rs so the toggle takes effect without
        // restart. Mirrors `share_notifications`.
        dm_notifications: Some(prefs.dm_notifications.unwrap_or(true)),
        // CLI auto-update defaults ON — re-read untyped from menubar.json by
        // hq_cli_update.rs on each background check so the toggle takes effect
        // without restart. Mirrors `dm_notifications`.
        cli_auto_update: Some(prefs.cli_auto_update.unwrap_or(true)),
        // Master automatic-updates switch — defaults ON. Governs silent
        // install of the app, CLI, and hq-core (see
        // `hq_cli_update::auto_update_enabled`). Absent in older menubar.json
        // files → true, so existing installs keep updating without asking.
        auto_update: Some(prefs.auto_update.unwrap_or(true)),
        // Staging channel (@getindigo.ai-only): defaults ON so existing
        // builders' "Update to Staging" pill keeps rendering across the
        // upgrade. An explicit `false` flips them to the prod release
        // channel — the same surface non-@indigo users see. See
        // `MenubarPrefs::staging_channel` for the full gating contract.
        staging_channel: Some(prefs.staging_channel.unwrap_or(true)),
        // Pass-through (NOT resolved) — see fn-level comment.
        release_channel: prefs.release_channel,
        // Meeting detect-notify: defaults to enabled + all five platforms
        // when absent on disk. Only ever fires for `@getindigo.ai` users
        // (gate in `commands/recall_sdk.rs::is_meeting_detect_allowed_email`),
        // and the platform allowlist is applied in `meetings.rs` notify path.
        meeting_detect_notify: Some(MeetingDetectNotifyPrefs {
            enabled: Some(mdn.enabled.unwrap_or(true)),
            platforms: Some(
                mdn.platforms
                    .unwrap_or_else(|| DEFAULT_PLATFORMS.iter().map(|s| s.to_string()).collect()),
            ),
        }),
        // Pass-through — `None` means Personal; the Settings dropdown
        // surfaces this as the "Personal" option (same shape as the
        // URL-invite picker in MeetingsWindow).
        default_recording_company_uid: prefs.default_recording_company_uid,
        // Telemetry defaults OFF (opt-in). Re-read untyped from menubar.json by
        // the collector each sync, so the toggle takes effect without restart.
        telemetry_enabled: Some(prefs.telemetry_enabled.unwrap_or(false)),
    })
}

/// Write settings to ~/.hq/menubar.json, preserving keys the typed
/// `MenubarPrefs` doesn't model.
///
/// IMPORTANT: a plain `to_string_pretty(&prefs)` overwrite WIPED every
/// top-level key absent from the struct — `machineId`, `firstRunCompleted`,
/// `autoSyncNoticeShown`, `cliUpdateDismissedVersion` — on every settings save.
/// That regenerated machine identity (telemetry double-counting) and could
/// re-trigger first-run onboarding on the next launch. So we merge: emit the
/// typed fields, then carry forward any on-disk keys the typed output lacks,
/// and atomic-rename — the same untyped-merge contract as
/// `config::ensure_machine_id` / first_run.rs.
#[tauri::command]
pub async fn save_settings(prefs: MenubarPrefs) -> Result<(), String> {
    let path = paths::menubar_json_path()?;

    // Ensure ~/.hq/ directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let existing = if path.exists() {
        std::fs::read_to_string(&path).ok()
    } else {
        None
    };
    let json = merge_prefs_over_existing(&prefs, existing.as_deref())?;

    // Atomic write: stage to a temp file, fsync, rename into place.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Failed to write menubar.json: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to write menubar.json: {}", e))?;

    Ok(())
}
