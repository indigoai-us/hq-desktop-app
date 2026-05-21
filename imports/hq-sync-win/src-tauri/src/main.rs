#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;

mod commands;
mod events;
mod sentry_scrub;
mod tray;
mod updater;
mod util;

// US-005 adds Windows vibrancy (Mica on Win 11, Acrylic fallback on Win 10)
// via window_vibrancy. The macOS NSVisualEffectMaterial::Popover path was
// stripped in US-002 along with the objc2 NSApp.applicationIconImage reach
// (the Accessory activation policy + .app icon image were macOS-only
// surfaces — Windows ships a real .exe + .ico via the MSI/NSIS bundle).

fn main() {
    use sentry::ClientOptions;
    use sentry_scrub::before_send;
    use std::sync::Arc;
    // `SENTRY_DSN` is set at compile time by build.rs, which reads
    // `HQ_SYNC_SENTRY_DSN` from the CI env. On local `cargo build`
    // / `cargo tauri dev` / PR CI (where the release-only secret is not
    // in scope), build.rs emits `cargo:rustc-env=SENTRY_DSN=` (empty),
    // so `env!("SENTRY_DSN")` evaluates to `""` — gate on emptiness → None
    // so the Sentry client no-ops cleanly in dev instead of crashing at startup.
    let dsn_str = env!("SENTRY_DSN");
    let dsn: Option<sentry::types::Dsn> = if dsn_str.is_empty() {
        None
    } else {
        Some(dsn_str.parse().expect("SENTRY_DSN invalid at build time"))
    };
    let _guard = sentry::init(ClientOptions {
        dsn,
        release: Some(format!("hq-sync-win@{}", env!("CARGO_PKG_VERSION")).into()),
        environment: Some(
            option_env!("SENTRY_ENVIRONMENT")
                .unwrap_or("production")
                .into(),
        ),
        sample_rate: std::env::var("SENTRY_SAMPLE_RATE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1.0),
        before_send: Some(Arc::new(before_send)),
        ..Default::default()
    });
    sentry::configure_scope(|scope| {
        scope.set_tag("repo", "hq-sync-win");
    });

    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    // Ctrl+Shift+H — global hotkey to summon the popover from anywhere.
    // SUPER on Windows maps to the Win key, which conflicts with system
    // shortcuts (Win+H opens Voice Typing). CONTROL+SHIFT+H is the
    // Windows-conventional equivalent of the macOS Cmd+Shift+H chord.
    let show_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &show_shortcut && event.state() == ShortcutState::Pressed {
                        tray::show_window_at_tray(app);
                    }
                })
                .build(),
        )
        .manage(updater::PendingUpdate(Mutex::new(None)))
        .manage(commands::new_files::PendingNewFiles(Mutex::new(Vec::new())))
        // Tray-app close behaviour: intercept window-close (system menu Close,
        // Alt-F4, frame X) and hide the popover instead of terminating the
        // process. The app only truly exits via the tray context menu's
        // "Quit" item (see tray.rs MENU_QUIT). Matches Windows tray-utility
        // norms (PowerToys, ShareX, Everything).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only hide the main popover window — let other windows
                // (e.g. new-files-detail) close normally.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::quit_app,
            commands::app::open_claude_code_link,
            commands::process::spawn_process,
            commands::process::cancel_process,
            commands::oauth::start_oauth_login,
            commands::oauth::oauth_listen_for_code,
            commands::oauth::oauth_exchange_code,
            commands::auth::get_auth_state,
            commands::auth::has_stored_token,
            commands::auth::refresh_tokens,
            commands::config::get_config,
            commands::status::get_sync_status,
            commands::sync::start_sync,
            commands::sync::cancel_sync,
            commands::workspaces::list_syncable_workspaces,
            commands::workspaces::connect_workspace_to_cloud,
            commands::conflicts::resolve_conflict,
            commands::conflicts::open_in_editor,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::folder_picker::pick_folder,
            commands::autostart::get_autostart_enabled,
            commands::autostart::set_autostart_enabled,
            commands::daemon::start_daemon,
            commands::daemon::stop_daemon,
            commands::daemon::daemon_status,
            tray::set_tray_state,
            updater::check_for_updates,
            updater::install_update,
            commands::hq_cli_update::check_hq_cli_update,
            commands::hq_cli_update::install_hq_cli_update,
            commands::hq_core_update::check_hq_core_update,
            commands::new_files::open_new_files_detail,
            commands::new_files::detail_window_ready,
            commands::meetings::meetings_feature_enabled,
            commands::meetings::meetings_list_upcoming,
            commands::meetings::meetings_list_scheduled_bots,
            commands::meetings::meetings_list_memberships,
            commands::meetings::meetings_list_accounts,
            commands::meetings::meetings_list_calendars_for_account,
            commands::meetings::meetings_invite_bot,
            commands::meetings::meetings_cancel_bot,
            commands::meetings::open_meetings_window,
        ])
        .setup(|app| {
            // One-shot migration of any legacy `/deploy`-skill stub at
            // ~/.hq/config.json. Runs first so subsequent prewarm /
            // daemon / sync calls see a clean HqConfig (when a personal
            // person-entity.json is on disk) or a missing config that
            // surfaces SetupNeeded cleanly (when reconstruction isn't
            // possible). Best-effort and idempotent — failures log to the
            // diagnostic file and don't abort launch.
            commands::config::migrate_legacy_config_stub();

            // Default-on autostart: ensure the Registry Run entry matches
            // the effective `startAtLogin` pref (default true) so a fresh
            // install opens HQ Sync at login without the user opening
            // Settings first. Honours an explicit `"startAtLogin": false`
            // opt-out. Best-effort and idempotent — never aborts launch.
            // US-006 wires the HKCU Registry Run key implementation.
            commands::autostart::ensure_autostart_on_launch();

            // US-005 wires Windows vibrancy here:
            //   apply_mica(window, Some(true))  on Win 11
            //   apply_acrylic(window, Some((18, 18, 18, 180)))  on Win 10 fallback
            // For now the popover renders without blur; the Svelte UI ships
            // a solid background fallback so this is visually acceptable.
            if let Some(_window) = app.get_webview_window("main") {
                // intentionally empty until US-005
            }

            tray::setup_tray(app.handle())?;
            updater::setup_update_checker(app.handle());

            // Register Ctrl+Shift+H globally so the popover can be summoned
            // from any app. The handler (configured on the plugin builder
            // above) calls `tray::show_window_at_tray`. Registration can
            // fail if another app already holds the chord — log and
            // continue so the rest of the app still launches.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH);
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    util::logfile::log(
                        "ui",
                        &format!("global shortcut Ctrl+Shift+H register FAILED: {e}"),
                    );
                }
            }

            commands::hq_cli_update::setup_hq_cli_update_checker(app.handle());
            commands::hq_core_update::setup_hq_core_update_checker(app.handle());

            // Fire-and-forget: warm the npx cache for
            // `@indigoai-us/hq-cloud@<HQ_CLOUD_VERSION>` so the user's
            // first click of "Sync Now" doesn't eat the 3–10s first-time
            // download. No-ops if the cache is already warm. See
            // `commands::prewarm` for the rationale.
            commands::prewarm::spawn_prewarm();

            // Auto-start the watcher when either flag is on:
            //   - `autostart_daemon` (V2-prep devtools flag, default OFF)
            //   - `realtime_sync`   (user-facing Auto-sync toggle, default ON)
            if commands::daemon::is_autostart_enabled()
                || commands::daemon::is_realtime_sync_enabled()
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Small delay to let the app fully initialize
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = commands::daemon::start_daemon(handle);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
