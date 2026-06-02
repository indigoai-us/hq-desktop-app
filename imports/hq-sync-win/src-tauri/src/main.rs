#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;

mod commands;
mod events;
mod sentry_scrub;
mod tray;
mod updater;
mod util;

/// Apply Mica (Win 11) or Acrylic (Win 10 fallback) blur to the popover window.
///
/// Mica is the preferred Win 11 material — it's the system-tinted backdrop
/// the OS uses for Settings, Files, etc. On Win 10 Mica isn't available;
/// Acrylic is the closest analogue (translucent panel with a custom RGBA
/// tint). Either way the Svelte popover renders on top of the system blur.
///
/// Both calls are best-effort: a failure logs and returns. The Svelte UI
/// ships a solid-background fallback so the popover remains readable even
/// when no vibrancy is applied (third-party theme tools, custom shell
/// replacements, Windows Server SKUs).
fn apply_windows_vibrancy(window: &tauri::WebviewWindow) {
    use util::logfile::log;
    use window_vibrancy::{apply_acrylic, apply_mica};

    // Try Mica first (Win 11+). `Some(true)` enables the dark variant —
    // matches the popover's dark Svelte theme. Returns Err on Win 10 and
    // any system where DwmExtendFrameIntoClientArea isn't honored.
    match apply_mica(window, Some(true)) {
        Ok(()) => {
            log("ui", "apply_mica: success (dark variant)");
            return;
        }
        Err(e) => {
            log("ui", &format!("apply_mica failed: {e}; trying Acrylic fallback"));
        }
    }

    // Acrylic fallback. RGBA tint (18, 18, 18, 180) ≈ dark with ~70% opacity —
    // close enough to the macOS Popover material the mac version used.
    match apply_acrylic(window, Some((18, 18, 18, 180))) {
        Ok(()) => log("ui", "apply_acrylic: success (Win 10 fallback)"),
        Err(e) => log(
            "ui",
            &format!(
                "apply_acrylic failed: {e}; popover will render with the Svelte solid-background fallback"
            ),
        ),
    }
}

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
        .plugin(tauri_plugin_notification::init())
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
        .manage(commands::drift_detail::PendingDrift(Mutex::new(None)))
        .manage(commands::activity::SessionActivity::new())
        .manage(commands::share_notify::PendingShareEvents(Mutex::new(Vec::new())))
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
            commands::hq_core_update::get_hq_version,
            commands::hq_core_drift::check_hq_core_drift,
            commands::hq_core_drift::restore_from_upstream,
            commands::hq_core_staging::check_staging_replace_available,
            commands::hq_core_staging::run_replace_from_staging,
            commands::hq_core_staging::check_staging_drift,
            commands::drift_detail::open_drift_detail,
            commands::drift_detail::drift_window_ready,
            commands::new_files::open_new_files_detail,
            commands::new_files::detail_window_ready,
            commands::activity::open_activity_log,
            commands::activity::activity_window_ready,
            commands::activity::get_activity_log,
            commands::meetings::meetings_feature_enabled,
            commands::meetings::meetings_list_upcoming,
            commands::meetings::meetings_list_scheduled_bots,
            commands::meetings::meetings_list_memberships,
            commands::meetings::meetings_list_accounts,
            commands::meetings::meetings_list_calendars_for_account,
            commands::meetings::meetings_invite_bot,
            commands::meetings::meetings_cancel_bot,
            commands::meetings::open_meetings_window,
            commands::share_notify::poll_shared_with_me,
            commands::share_notify::open_share_detail,
            commands::share_notify::share_detail_window_ready,
            commands::notifications::notification_permission_state,
            commands::notifications::notification_request_permission,
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

            // Apply Mica (Win 11) / Acrylic (Win 10) backdrop to the popover.
            // Best-effort — the Svelte UI ships a solid-background fallback
            // for systems where neither material is available.
            if let Some(window) = app.get_webview_window("main") {
                apply_windows_vibrancy(&window);
            }

            tray::setup_tray(app.handle())?;
            // Hard version-gate against hq-pro fires at 5s (BEFORE the soft
            // updater at 10s) so a known-bad release can be yanked before the
            // user touches anything sensitive. Server-side source of truth is
            // `apps/hq-pro/src/vault-service/handlers/client-version-check.ts`.
            // See `commands::version_gate` for the rationale.
            commands::version_gate::setup_version_gate(app.handle());
            updater::setup_update_checker(app.handle());

            // Share-notification poller: fires 5s after launch and after
            // every sync:all-complete event. Gated to @getindigo.ai users
            // and the shareNotifications menubar preference (both checked
            // inside share_notify — not here so the gate is never scattered).
            {
                use tauri::Listener;
                // (a) Launch-time poll — 5s delay matches the updater pattern.
                commands::share_notify::setup_share_notify_poller(app.handle().clone());

                // (b) Post-sync poll — fires after every complete sync run.
                let poll_handle = app.handle().clone();
                app.listen(
                    crate::events::EVENT_SYNC_ALL_COMPLETE,
                    move |_event| {
                        let h = poll_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            commands::share_notify::poll_once(h).await;
                        });
                    },
                );
            }

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
            commands::hq_core_drift::setup_hq_core_drift_checker(app.handle());
            commands::hq_core_staging::setup_staging_drift_checker(app.handle());

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
