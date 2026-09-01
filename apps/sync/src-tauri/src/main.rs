#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;

mod commands;
mod events;
#[cfg(target_os = "macos")]
mod glass;
mod tray;
mod tray_helper;
mod updater;
mod util;
#[cfg(target_os = "macos")]
mod webview_asset_cache;
#[cfg(target_os = "windows")]
mod windows_update;

/// Set the macOS application icon image at runtime.
///
/// We need this because the app's activation policy is `Accessory` (no Dock
/// icon, tray-only). When a detached window like the Meetings window is
/// open, macOS still shows the app in Mission Control and the window
/// switcher — but with NO bundled `.app` icon registered at runtime, the
/// representation is a generic folder/document. Setting
/// `NSApp.applicationIconImage` programmatically gives those surfaces an
/// HQ icon to render even though there's no Dock badge.
///
/// `cargo tauri dev` doesn't build a proper `.app` bundle either, so this
/// is the same fix in both dev and production.
///
/// Uses raw objc2 messaging so we don't pull in objc2-app-kit /
/// objc2-foundation just for one call. The image is leaked intentionally
/// — it's set once at startup and held by NSApplication for the lifetime
/// of the process, so manual release would be a use-after-free.
#[cfg(target_os = "macos")]
fn set_app_icon_from_bytes(bytes: &'static [u8]) {
    use objc2::{class, msg_send, runtime::AnyObject};
    use util::logfile::log;

    unsafe {
        let data_cls = class!(NSData);
        let data: *mut AnyObject = msg_send![
            data_cls,
            dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
            length: bytes.len()
        ];
        if data.is_null() {
            log("ui", "set_app_icon: NSData::dataWithBytes returned nil");
            return;
        }

        let image_cls = class!(NSImage);
        let image_alloc: *mut AnyObject = msg_send![image_cls, alloc];
        let image: *mut AnyObject = msg_send![image_alloc, initWithData: data];
        if image.is_null() {
            log("ui", "set_app_icon: NSImage::initWithData returned nil");
            return;
        }

        let app_cls = class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            log(
                "ui",
                "set_app_icon: NSApplication::sharedApplication returned nil",
            );
            return;
        }
        let _: () = msg_send![app, setApplicationIconImage: image];
        log("ui", "set_app_icon: applied HQ icon to NSApp");
    }
}

#[cfg(target_os = "windows")]
const SENTRY_IDENTITY: hq_telemetry::SentryIdentity<'static> = hq_telemetry::SentryIdentity {
    release_prefix: "hq-sync-win",
    repo: "hq-sync-win",
    app: "hq-desktop-app",
    flavor: "windows-sync-installer",
};

#[cfg(target_os = "macos")]
const SENTRY_IDENTITY: hq_telemetry::SentryIdentity<'static> = hq_telemetry::SentryIdentity {
    release_prefix: "hq-sync",
    repo: "hq-sync",
    app: "hq-desktop-app",
    flavor: "macos-sync-installer",
};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const SENTRY_IDENTITY: hq_telemetry::SentryIdentity<'static> = hq_telemetry::SentryIdentity {
    release_prefix: "hq-desktop-app",
    repo: "hq-desktop-app",
    app: "hq-desktop-app",
    flavor: "desktop",
};

fn register_global_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    for (label, code) in [("Opt+Shift+H", Code::KeyH), ("Opt+Shift+O", Code::KeyO)] {
        let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), code);
        if let Err(error) = app.global_shortcut().register(shortcut) {
            util::logfile::log(
                "ui",
                &format!("global shortcut {label} register FAILED: {error}"),
            );
        }
    }
}

/// Start every background source that can deliver a user-visible notification
/// or construct the shared banner webview.
///
/// This macOS-only group runs from the frontend-cache ready callback. The
/// UNUserNotificationCenter delegate is intentionally registered earlier so
/// macOS does not lose a cold-launch click; its response handler independently
/// awaits this same readiness boundary.
#[cfg(target_os = "macos")]
fn setup_notification_producers(app: &tauri::AppHandle) {
    use tauri::Listener;

    updater::setup_update_checker(app);
    commands::share_notify::setup_share_notify_poller(app.clone());

    commands::meetings::setup_unattributed_meeting_poller(app.clone());

    // Instant-DM push receiver — MQTT-over-WSS to AWS IoT Core. Wakes the
    // singleton DM poll path; the interval poll remains the long-stop.
    commands::dm_mqtt::setup_dm_mqtt_receiver(app.clone());

    // Post-sync top-up remains additive to the independent interval poll.
    let poll_handle = app.clone();
    app.listen(crate::events::EVENT_SYNC_ALL_COMPLETE, move |_event| {
        let handle = poll_handle.clone();
        tauri::async_runtime::spawn(async move {
            commands::share_notify::poll_once(handle).await;
        });
    });
}

fn setup_startup_surfaces(
    app: &tauri::AppHandle,
    first_run: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    tray::setup_tray(app)?;

    if first_run {
        tray::show_window_centered(app);
        util::logfile::log("app", "first-run launch: centered onboarding card");
    }

    // US-002: always-on-top HQ wordmark widget (lower-right of the
    // configured display). Gated by widgetEnabled in menubar.json
    // (default on). Non-activating, appearance-reactive.
    commands::widget::setup_widget_window(app);

    // macOS: the menu-bar item lives in a separate native helper process
    // (tao parks an in-process status item off-screen on Tahoe).
    #[cfg(target_os = "macos")]
    tray_helper::spawn_and_poll(app);

    register_global_shortcuts(app);
    Ok(())
}

fn surface_existing_instance(app: &tauri::AppHandle) {
    hq_telemetry::record_native_panic_seam(
        hq_telemetry::NativePanicSeam::SingleInstanceSurfaceExisting,
    );

    #[cfg(target_os = "windows")]
    {
        tray::show_window_at_tray(app);
        util::logfile::log(
            "app",
            "single-instance: showed main popover at tray on second launch",
        );
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        util::logfile::log(
            "app",
            "single-instance: focused existing window on second launch",
        );
    } else {
        util::logfile::log(
            "app",
            "single-instance: second launch with no window to focus",
        );
    }
}

fn handle_window_close_requested_hide<F>(should_hide: bool, hide_action: F)
where
    F: FnOnce(),
{
    if should_hide {
        hq_telemetry::record_native_panic_seam(
            hq_telemetry::NativePanicSeam::WindowCloseRequestedHide,
        );
        hide_action();
    }
}

/// Decide what `tauri::RunEvent::Exit` must do, given whether the app itself
/// asked to quit.
///
/// This is the fix for HQ-DESKTOP-44, the fatal native panic
/// `cannot move state from Destroyed`. The mechanism, read out of the pinned
/// dependency sources:
///
/// 1. At Windows session end (shutdown / logoff / forced restart) the OS sends
///    `WM_ENDSESSION(TRUE)`. tao handles it in `thread_event_target_callback`
///    by calling `event_loop_runner.loop_destroyed()`
///    (`tao/src/platform_impl/windows/event_loop.rs`), which moves the runner
///    to `RunnerState::Destroyed` and returns 0 — leaving tao's own
///    `GetMessageW`/`DispatchMessageW` pump still running.
/// 2. `move_state_to` (`.../event_loop/runner.rs`) replaces the state *first*,
///    so on return the runner is latched in `Destroyed`. Its final match arm is
///    `(Destroyed, _) => panic!("cannot move state from Destroyed")`, and every
///    later `poll` / `send_event` / `main_events_cleared` /
///    `redraw_events_cleared` routes through it.
/// 3. So the next dispatched message panics, and it panics inside an
///    `unsafe extern "system"` window procedure installed with
///    `SetWindowSubclass`. tao's `catch_unwind` wraps only `call_event_handler`,
///    not `move_state_to`, so that unwind aborts the process.
///
/// The one app-controlled instant in that window is this callback: tao's
/// `(_, Destroyed)` arms dispatch `Event::LoopDestroyed` synchronously from
/// inside the `WM_ENDSESSION` handler, tauri-runtime-wry maps it to
/// `RunEvent::Exit`, and tauri invokes the application callback *before*
/// `cleanup_before_exit()` (`tauri/src/app.rs`). No pump iteration intervenes,
/// so exiting here is guaranteed to beat the fatal dispatch.
///
/// `app_initiated` is the discriminator, and it is sound in both directions:
/// tauri-runtime-wry emits `RunEvent::ExitRequested` only when the last window
/// is destroyed or on `Message::RequestExit` (which `AppHandle::exit` sends),
/// and never for `WM_ENDSESSION`. A user quit therefore always sets the flag
/// first; an OS session end never does.
///
/// Kept free of Tauri and Windows types on purpose so both branches are unit
/// testable on any host, with no app instance and no real session end.
#[cfg(any(target_os = "windows", test))]
fn handle_run_event_exit<S, T>(app_initiated: bool, session_end_teardown: S, terminate: T)
where
    S: FnOnce(),
    T: FnOnce(),
{
    if app_initiated {
        // A user-initiated quit already ran its teardown in the
        // `ExitRequested` arm, and tauri runs `cleanup_before_exit()` (tray
        // teardown, window hiding) the moment this callback returns, followed
        // by tao's own `process::exit(exit_code)`. Exiting here would skip that
        // cleanup, so this path must stay exactly as it was.
        return;
    }

    session_end_teardown();
    terminate();
}

fn main() {
    // The copied Windows update helper must run before Sentry, Tauri, and the
    // single-instance plugin. It waits for the real app to exit, then launches
    // the verified NSIS package from outside the install directory.
    #[cfg(target_os = "windows")]
    windows_update::run_helper_if_requested();

    // CI-only probe entrypoint, gated on the non-default `sync-cancel-probe`
    // feature. The dispatch — including its process termination — lives in
    // `commands::process` so the only process exit in this file stays the Windows
    // session-end fast path pinned by `scripts/native-seam-wiring.test.ts`. The
    // helper never returns, so the menubar app is never initialized on a probe run.
    #[cfg(feature = "sync-cancel-probe")]
    if std::env::args().any(|arg| arg == "--sync-cancel-probe") {
        commands::process::run_sync_cancel_probe_main();
    }

    // Sentry init + the PII/secret scrubber live in the hq-telemetry crate. The
    // build-time values (DSN/version/environment, emitted by build.rs) are read
    // here in the binary and passed in, so the crate carries no build-env coupling.
    // `env!("SENTRY_DSN")` is "" on dev/PR CI (no release secret) → Sentry no-ops.
    // Hold the guard for the process lifetime.
    let _guard = hq_telemetry::init_with_identity(
        env!("SENTRY_DSN"),
        env!("APP_VERSION"),
        option_env!("SENTRY_ENVIRONMENT"),
        SENTRY_IDENTITY,
    );
    hq_telemetry::set_native_panic_phase(hq_telemetry::NativePanicPhase::Running);

    // Wire the foundation crate's injected dependencies before anything reads them:
    //  - the user-facing client version (from build-time APP_VERSION), and
    //  - the feature-gate email-claim source (Cognito token read + JWT decode).
    util::client_info::set_client_version(env!("APP_VERSION"));
    util::feature_gate::set_email_claim_fetcher(|| {
        Box::pin(async {
            let tokens = commands::cognito::get_tokens().await.ok().flatten()?;
            let id_token = tokens.id_token?;
            if id_token.is_empty() {
                return None;
            }
            commands::cognito::decode_id_token_claims(&id_token)
                .ok()?
                .email
        })
    });

    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    // Opt+Shift+H — global hotkey to summon the popover from anywhere.
    // Opt+Shift+O — global hotkey to reveal the larger desktop window.
    // Defined up front so the plugin builder and the setup-time `register`
    // calls agree on the exact key combos.
    let show_shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyH);
    let desktop_shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyO);

    // The `main` popover is created from `tauri.conf.json`, so its WebView2
    // browser arguments have to be folded into the config before the app is
    // built — there is no builder to reach for. See
    // `util::webview2_automation`: a WebDriver host's switches can only reach
    // `msedgewebview2.exe` through `additionalBrowserArgs`, and this is the
    // first webview the process creates, so it decides the browser process the
    // driver has to find. Untouched (and `None`) on a normal launch.
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    {
        if let Some(args) = util::webview2_automation::automation_browser_args() {
            for window in &mut context.config_mut().app.windows {
                window.additional_browser_args = Some(args.clone());
            }
        }
    }

    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "macos")]
            webview_asset_cache::handle_page_load(webview.label(), payload.event());
            #[cfg(not(target_os = "macos"))]
            let _ = (webview, payload);
        })
        // single-instance MUST be the first plugin: it runs before any other
        // plugin can create a window or spawn a process, so a second launch is
        // collapsed back into the already-running instance. macOS routes a
        // notification click (and a re-open of the installed copy) through
        // Launch Services by bundle id, which would otherwise start a duplicate
        // menubar process. Here the callback surfaces the existing instance and
        // the second process exits instead of becoming a ghost duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // US-104: if the OS delivered a hqwork:// URL to THIS process,
            // route it internally. Do not steal the popover for a deep link.
            if let Some(url) = commands::hq_work::hqwork_url_from_argv(&argv) {
                commands::hq_work::spawn_open_hqwork_deep_link(app, url);
                return;
            }

            // US-004 WindowRouter: taskbar / second-process activation always
            // shows the compact notification popover — never auto-focuses the
            // full desktop. Desktop opens only via explicit Open HQ / shortcut.
            let _ = commands::desktop_alt::activation_policy(
                commands::desktop_alt::ActivationSource::TaskbarSecondProcess,
            );

            #[cfg(target_os = "macos")]
            if webview_asset_cache::defer_activation_while_pending() {
                util::logfile::log(
                    "app",
                    "single-instance: activation deferred until startup cache gate completes",
                );
                return;
            }

            surface_existing_instance(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &show_shortcut && event.state() == ShortcutState::Pressed {
                        // Toggle the popover: hides it if already up, else shows
                        // it (and hides the desktop window — one at a time).
                        // Window ops (incl. the is_visible toggle query) must run
                        // on the main thread, so marshal off the shortcut callback.
                        let app_main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            hq_telemetry::record_native_panic_seam(
                                hq_telemetry::NativePanicSeam::GlobalShortcutTogglePopover,
                            );
                            tray::toggle_popover_window(&app_main);
                        });
                    } else if shortcut == &desktop_shortcut
                        && event.state() == ShortcutState::Pressed
                    {
                        // Toggle the desktop window: hide if visible, else open
                        // it (hiding the popover first — one HQ window at a time).
                        // Marshal to the main thread for the same reason.
                        let app_main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            hq_telemetry::record_native_panic_seam(
                                hq_telemetry::NativePanicSeam::GlobalShortcutToggleDesktop,
                            );
                            let desktop_visible = app_main
                                .get_webview_window("desktop-alt")
                                .and_then(|w| w.is_visible().ok())
                                .unwrap_or(false);
                            if desktop_visible {
                                tray::hide_desktop_alt(&app_main);
                            } else {
                                if let Some(main) = app_main.get_webview_window("main") {
                                    let _ = main.hide();
                                }
                                let app_handle = app_main.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Err(e) =
                                        commands::desktop_alt::open_desktop_alt_window_inner(
                                            app_handle, None,
                                        )
                                        .await
                                    {
                                        util::logfile::log(
                                            "ui",
                                            &format!(
                                                "global shortcut Opt+Shift+O open desktop FAILED: {e}"
                                            ),
                                        );
                                    }
                                });
                            }
                        });
                    }
                })
                .build(),
        )
        .manage(updater::PendingUpdate::default())
        .manage(commands::drift_detail::PendingDrift(Mutex::new(None)))
        .manage(commands::activity::SessionActivity::new())
        .manage(commands::share_notify::PendingShareEvents(Mutex::new(Vec::new())))
        .manage(commands::dm_notify::PendingDmEvents(Mutex::new(Vec::new())))
        .manage(commands::dm_notify::NotificationSessionState::new())
        .manage(commands::dm_notify::UnreadDmState(Mutex::new(0)))
        .manage(commands::dm_notify::PairUnreadState::new())
        .manage(commands::dm_notify::SeenRequestState::new())
        .manage(commands::dm_notify::SeenChannelState::new())
        .manage(commands::dm_notify::ActiveThreadState::new())
        .manage(commands::dm_notify::ActiveConversationState::new())
        .manage(commands::dm_notify::WatchedSharesState::new())
        .manage(commands::messages::PendingMessagesTarget::new())
        .manage(commands::banner::PendingBanner(Mutex::new(None)))
        .manage(commands::banner::PendingBannerActions::default())
        .manage(commands::banner::BannerActionRouterReadiness::default())
        // new-files-detail window handshake state (folded in from hq-sync-win).
        .manage(commands::new_files::PendingNewFiles(Mutex::new(Vec::new())))
        // Menubar-app close behaviour: intercept window-close (traffic-light
        // red button, Cmd-W, File→Close) and hide the window instead of
        // terminating the process. The app only truly exits via the tray
        // context menu's "Quit" item (see tray.rs MENU_QUIT). This matches
        // native Cocoa NSStatusItem apps like Bartender, Rectangle, Raycast.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only hide the main popover window — let other windows
                // (e.g. new-files-detail) close normally.
                if window.label() == "main" {
                    handle_window_close_requested_hide(true, || {
                        api.prevent_close();
                        let _ = window.hide();
                    });
                }
            }
            // No eager standalone-install probe here. `refresh_hq_work_install_cache`
            // force-probes with no TTL — on macOS that falls through to a fresh
            // `mdfind` process — and this fired on EVERY window focus, for every
            // user including the default flag-off population, overlapping as the
            // tray and desktop windows traded focus. The combined app never
            // consumes the standalone-install cache on the open path (US-103
            // mounts in-process; `should_probe_install_on_desktop_alt_open` is
            // hard `false`). Anything that still needs the state calls
            // `hq_work_installed`, which probes lazily behind its own TTL.
            // Windows: reapply Mica/Acrylic when the OS theme flips so light
            // mode never keeps a forced-dark backdrop (US-003). Theme is left
            // unset on window builders so ThemeChanged keeps firing.
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::ThemeChanged(theme) = event {
                hq_telemetry::record_native_panic_seam(
                    hq_telemetry::NativePanicSeam::WindowThemeChanged,
                );
                let appearance = hq_platform::window_effects::WindowAppearance::from_dark(
                    matches!(theme, tauri::Theme::Dark),
                );
                hq_platform::window_effects::apply_windows_window_style(window, appearance);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::quit_app,
            commands::app::bring_main_window_to_front,
            commands::app::open_settings_window,
            commands::app::open_claude_code_link,
            commands::ai_tools::detect_ai_tools,
            commands::ai_tools::detect_claude_ready,
            commands::ai_tools::detect_claude_desktop_connectors,
            commands::ai_tools::import_claude_desktop_connectors,
            commands::launch::launch_claude_code,
            commands::launch::launch_cli_in_terminal,
            commands::launch::launch_codex_workspace,
            commands::launch::reveal_folder,
            commands::new_files::open_new_files_detail,
            commands::new_files::detail_window_ready,
            commands::oauth::start_oauth_login,
            commands::oauth::oauth_listen_for_code,
            commands::oauth::oauth_exchange_code,
            commands::auth::get_auth_state,
            commands::auth::get_auth_session,
            commands::hq_pro::hq_pro_fetch,
            commands::vault_s3::vault_s3_put,
            commands::vault_s3::vault_s3_get,
            commands::auth::has_stored_token,
            commands::auth::begin_reauth,
            commands::auth::refresh_tokens,
            commands::auth::sign_out,
            commands::config::get_config,
            commands::hq_work::hq_work_installed,
            commands::hq_work::launch_hq_work,
            commands::hq_work::open_hqwork_deep_link,
            commands::hq_work::install_hq_work,
            commands::hq_work::get_hq_work_handoff_card_shown,
            commands::hq_work::mark_hq_work_handoff_card_shown,
            commands::config::get_hq_work_handoff,
            commands::config::set_hq_work_handoff,
            commands::status::get_sync_status,
            commands::sync::start_sync,
            commands::sync::cancel_sync,
            commands::first_run::is_first_run,
            commands::first_run::should_show_auto_sync_notice,
            commands::first_run::mark_first_run_complete,
            commands::first_run::mark_auto_sync_notice_shown,
            commands::first_run::set_main_window_vibrancy,
            commands::first_run::show_main_window_at_tray,
            commands::lifecycle::get_lifecycle_state,
            commands::lifecycle::get_setup_status,
            commands::session_end_observer::session_end_observer_status,
            commands::windows_teardown_probe::session_end_teardown_probe_status,
            commands::session_end_latch::session_end_latch_status,
            commands::workspaces::list_syncable_workspaces,
            commands::workspaces::connect_workspace_to_cloud,
            commands::workspaces::claim_pending_company_invite,
            commands::workspaces::set_workspace_sync_enabled,
            commands::sync_mode::get_sync_mode,
            commands::sync_mode::set_sync_mode,
            commands::conflicts::resolve_conflict,
            commands::conflicts::open_in_editor,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::telemetry::post_telemetry_opt_in,
            commands::telemetry::get_telemetry_consent_status,
            commands::telemetry::consent_reprompt_status,
            commands::telemetry::mark_consent_reprompt_shown,
            commands::telemetry::write_menubar_telemetry_pref,
            commands::telemetry::emit_desktop_telemetry_if_opted_in,
            commands::personal::ensure_person_entity,
            commands::folder_picker::pick_folder,
            commands::install_directory::resolve_hq_path,
            commands::install_directory::set_hq_install_path,
            commands::install_directory::create_directory,
            commands::install_directory::check_writable,
            commands::install_directory::detect_hq,
            commands::content::fetch_and_extract_template,
            commands::content::cancel_content_download,
            commands::content::get_staging_source,
            commands::content::set_staging_source,
            commands::checksums::compute_checksums,
            commands::install_manifest::read_install_manifest,
            commands::install_manifest::record_step_start,
            commands::install_manifest::record_step_ok,
            commands::install_manifest::record_step_failure,
            commands::install_manifest::record_dependencies,
            commands::install_manifest::record_packs,
            commands::install_manifest::record_import,
            commands::install_manifest::record_install_complete,
            commands::install_stages::git_init,
            commands::install_stages::git_probe_user,
            commands::install_stages::register_search_index,
            commands::install_stages::install_default_packages,
            commands::install_stages::personalize_hq,
            commands::install_stages::import_existing_setup,
            commands::install_stages::install_menubar_app,
            commands::install_stages::start_initial_cloud_sync,
            commands::install_deps::check_dep,
            commands::install_deps::cancel_install,
            #[cfg(not(windows))]
            commands::install_deps::install_homebrew,
            commands::install_deps::install_node,
            commands::install_deps::install_git,
            commands::install_deps::install_gh,
            commands::install_deps::install_claude_code,
            commands::install_deps::install_qmd,
            commands::install_deps::install_hq_cli,
            commands::install_deps::install_yq,
            commands::install_deps::install_deps,
            commands::install_deps::configure_claude_settings_path,
            #[cfg(windows)]
            commands::install_deps::install_pnpm,
            #[cfg(windows)]
            commands::install_deps::install_rsync,
            #[cfg(windows)]
            commands::install_deps::ensure_shims,
            #[cfg(windows)]
            commands::long_paths::is_long_paths_enabled,
            #[cfg(windows)]
            commands::long_paths::enable_long_paths,
            #[cfg(windows)]
            commands::long_paths::open_long_paths_settings,
            commands::autostart::get_autostart_enabled,
            commands::autostart::set_autostart_enabled,
            commands::daemon::start_daemon,
            commands::daemon::stop_daemon,
            commands::daemon::daemon_status,
            tray::set_tray_state,
            updater::check_for_updates,
            updater::get_pending_update,
            updater::install_update,
            updater::available_channels,
            updater::is_indigo_user,
            commands::hq_cli_update::check_hq_cli_update,
            commands::hq_cli_update::get_hq_cli_version,
            commands::hq_cli_update::install_hq_cli_update,
            commands::hq_cli_update::set_hq_cli_update_dismissed,
            commands::hq_core_update::get_hq_version,
            commands::hq_core_update::install_hq_core_update,
            commands::hq_core_drift::restore_from_upstream,
            commands::hq_core_staging::run_replace_from_staging,
            commands::hq_core_state::check_core_state,
            commands::drift_detail::open_drift_detail,
            commands::drift_detail::drift_window_ready,
            commands::feedback::submit_bug_report,
            commands::packages::list_packages,
            commands::packages::check_package_updates,
            commands::packages::check_pack_update,
            commands::packages::install_package,
            commands::packages::update_package,
            commands::packages::update_packs,
            commands::packages::uninstall_package,
            commands::packages::open_packages_window,
            commands::packages::packages_window_ready,
            commands::activity::open_activity_log,
            commands::activity::activity_window_ready,
            commands::activity::get_activity_log,
            // Mission Control (US-005): the merged-fleet command plus the
            // per-reader commands the readers exposed in US-002/US-003/US-004
            // (registered here so the frontend store can fall back to a single
            // reader and the polling loop emits `sessions:updated`).
            commands::sessions::list_agent_sessions,
            commands::sessions::claude::list_local_claude_sessions,
            commands::sessions::codex::list_local_codex_sessions,
            commands::sessions::history::list_session_history,
            // Mission Control — agency teams + answerable questions (read + answer).
            commands::agency::list_agency_teams,
            commands::agency::list_agency_questions,
            commands::agency::answer_agency_question,
            commands::agency::list_agency_chat,
            commands::agency::send_agency_message,
            commands::meetings::meetings_feature_enabled,
            commands::desktop_alt::desktop_alt_enabled,
            commands::desktop_alt::desktop_alt_is_admin,
            commands::desktop_alt::set_desktop_active_company,
            commands::desktop_alt::get_desktop_active_company,
            commands::desktop_alt::get_company_summary,
            commands::desktop_alt::get_company_board,
            commands::desktop_alt::get_company_project_creators,
            commands::desktop_alt::get_company_activity,
            commands::desktop_alt::get_company_team_telemetry,
            commands::desktop_alt::get_company_deployments,
            commands::desktop_alt::get_company_secrets,
            commands::desktop_alt::get_company_crm_projection_vault,
            commands::desktop_alt::get_company_file_tree,
            commands::desktop_alt::get_company_file_content,
            commands::desktop_alt::get_authorized_file_preview,
            commands::desktop_alt::reveal_authorized_file,
            commands::desktop_alt::open_authorized_file_in_claude,
            commands::desktop_alt::list_hq_dir,
            commands::projects_local::get_local_projects,
            commands::projects_local::get_local_project_prd,
            commands::projects_local::get_local_project_readme,
            commands::projects_local::get_local_company_goals,
            commands::projects_local::get_company_crm_projection,
            commands::projects_local::set_local_project_status,
            commands::projects_local::set_local_story_passes,
            commands::library_local::get_library_root,
            commands::library_local::get_library_company,
            commands::library_local::get_library_worker_detail,
            commands::library_local::get_library_skill_detail,
            commands::library_local::export_skill_catalog,
            commands::marketplace::list_marketplace_listings,
            commands::marketplace::get_marketplace_listing,
            commands::marketplace::install_marketplace_pack,
            commands::marketplace::yank_marketplace_listing,
            commands::marketplace::list_moderation_queue,
            commands::marketplace::decide_moderation_listing,
            commands::marketplace::list_creator_applications,
            commands::marketplace::decide_creator_application,
            commands::marketplace::record_marketplace_install,
            commands::marketplace::publish_marketplace_pack,
            commands::marketplace::request_creator_access,
            commands::marketplace::pick_pack_directory,
            commands::marketplace::claim_creator_handle,
            commands::marketplace::update_creator_profile,
            commands::marketplace::upload_creator_avatar,
            commands::marketplace::pick_avatar_file,
            commands::marketplace::get_creator_profile,
            commands::marketplace::get_my_creator,
            commands::meetings::meetings_list_upcoming,
            commands::meetings::meetings_list_scheduled_bots,
            commands::meetings::meetings_list_memberships,
            commands::meetings::meetings_list_accounts,
            commands::meetings::meetings_list_calendars_for_account,
            commands::meetings::meetings_invite_bot,
            commands::meetings::meetings_join_bot_now,
            commands::meetings::meetings_cancel_bot,
            commands::meetings::meetings_set_company,
            commands::meetings::meetings_take_pending_focus,
            commands::meetings::open_meetings_window,
            commands::meetings::meetings_check_bot_for_url,
            commands::meetings::meetings_notify_detected,
            commands::meetings::meetings_clear_prompt_badge,
            commands::permissions::permissions_open_settings,
            commands::permissions::permissions_force_native_register,
            commands::permissions::meetings_permissions_state,
            commands::permissions::open_meeting_permissions_window,
            commands::recall_sdk::meeting_detect_feature_enabled,
            commands::recall_sdk::start_recall_sdk,
            commands::recall_sdk::start_recording,
            commands::recall_sdk::stop_recording,
            commands::recall_sdk::meetings_list_active_detections,
            commands::recall_sdk::meetings_list_active_recordings,
            tray::meetings_set_prompt_badge,
            commands::desktop_alt::open_desktop_alt_window,
            commands::desktop_alt::desktop_alt_consume_pending_route,
            commands::desktop_alt::desktop_alt_dev_audit_render,
            commands::share_notify::poll_shared_with_me,
            commands::share_notify::open_share_detail,
            commands::share_notify::share_detail_window_ready,
            commands::dm_notify::poll_dm_inbox,
            commands::dm_notify::open_dm_detail,
            commands::dm_notify::open_inbox_window,
            commands::dm_notify::open_communications_window,
            commands::dm_notify::dm_detail_window_ready,
            commands::dm_notify::send_dm,
            commands::dm_notify::send_dm_to_email,
            commands::dm_notify::fetch_dm_thread,
            commands::dm_notify::fetch_thread,
            commands::dm_notify::send_thread_reply,
            commands::dm_notify::set_active_thread,
            commands::dm_notify::set_active_conversation,
            commands::dm_notify::set_watched_shares,
            commands::dm_notify::list_dm_requests,
            commands::dm_notify::respond_dm_request,
            commands::dm_notify::mark_dm_thread_read,
            commands::message_search::search_messages,
            commands::messages::open_messages_window,
            commands::messages::messages_window_ready,
            commands::messages::take_pending_messages_target,
            commands::messages::mark_messages_viewed,
            commands::messages::list_contacts,
            commands::messages::list_company_members,
            commands::messages::get_unread_summary,
            commands::messages::list_channels,
            commands::messages::ensure_project_channel,
            commands::messages::fetch_channel,
            commands::messages::fetch_channel_files,
            commands::messages::create_channel,
            commands::messages::create_group_dm,
            commands::messages::join_channel,
            commands::messages::invite_to_channel,
            commands::messages::send_channel_message,
            commands::messages::list_channel_members,
            commands::messages::remove_channel_member,
            commands::messages::mark_channel_read,
            tray_helper::set_tray_message_badge,
            commands::messages::toggle_reaction,
            commands::messages::fetch_reactions,
            commands::notification_history::open_notification_history,
            commands::notification_history::fetch_notification_history,
            commands::notifications_feed::fetch_notifications,
            commands::notifications_feed::ack_notification,
            commands::notifications_feed::read_all_notifications,
            commands::notifications_feed::run_notification_action,
            commands::notifications::notification_permission_state,
            commands::notifications::notification_request_permission,
            commands::notifications::notification_open_settings,
            commands::banner::banner_window_ready,
            commands::banner::banner_action,
            commands::banner::banner_action_result,
            commands::banner::banner_action_router_ready,
            commands::banner::banner_action_router_not_ready,
            commands::banner::show_action_retry_banner,
            commands::banner::dismiss_banner,
            commands::banner::resize_banner,
            commands::banner::show_main_window,
            commands::banner::preview_dm_banner,
            commands::banner::preview_share_banner,
            commands::banner::preview_update_banner,
            commands::banner::preview_meeting_banner,
            commands::widget::resize_widget,
            commands::widget::set_widget_focusable,
            commands::widget::widget_ready,
            commands::widget::list_displays,
            commands::widget::apply_widget_settings,
            commands::dock::apply_dock_icon,
            commands::compat::check_ai_tools,
            commands::compat::device_fingerprint,
            commands::compat::keychain_set,
            commands::compat::keychain_get,
            commands::compat::keychain_delete,
            commands::oauth::oauth_cancel_listen,
            commands::compat::write_menubar_hq_path,
            commands::compat::home_dir,
            commands::compat::write_file,
            commands::compat::make_dir,
            commands::compat::read_text_file,
            commands::compat::create_symlink,
            commands::compat::get_use_staging_source,
            commands::compat::download_staging_tarball,
            commands::compat::is_primary_instance,
            commands::compat::recheck_primary_instance,
            commands::compat::launch_menubar_app,
            commands::compat::menubar_installed,
            commands::compat::launch_claude_desktop,
            commands::compat::launch_codex_desktop,
            commands::compat::claude_desktop_installed,
            #[cfg(windows)]
            commands::compat::add_claude_trusted_folder,
            #[cfg(windows)]
            commands::compat::open_developer_settings,
        ])
        .setup(|app| {
            app.manage(commands::desktop_alt::DesktopSessionScope::new());
            #[cfg(target_os = "windows")]
            {
                // Prime the durable session-end latch's monotonic origin before
                // any write can land inside a window procedure, and give the
                // tracker the production sink so a committed WM_ENDSESSION / WTS
                // logoff is made durable (HQ-DESKTOP r3).
                commands::session_end_latch::init();
                let tracker = std::sync::Arc::new(
                    commands::session_end_observer::SessionEndTracker::with_latch(
                        std::sync::Arc::new(
                            commands::session_end_observer::ProcessStartClock::new(),
                        ),
                        std::sync::Arc::new(commands::session_end_latch::GlobalSessionEndLatch),
                    ),
                );
                app.manage(commands::session_end_observer::SessionEndObserverHandle::start(
                    tracker,
                ));
            }
            // Classify this launch (FirstRun / ExistingUpdate / Normal) and
            // cache it in managed state. MUST run before anything that can
            // write `machineId` to menubar.json (sync, telemetry, the
            // share/dm pollers below) — `machineId` is the tiebreaker that
            // distinguishes a brand-new install from a legacy user updating.
            // See commands/first_run.rs for the full rationale.
            let launch_kind = commands::first_run::classify_launch(app.handle());
            commands::lifecycle::setup_lifecycle(app.handle());

            // US-104: cold-start hqwork:// on argv (if the OS delivered one).
            // Not an OS-scheme registration — only handle what we were given.
            let startup_args: Vec<String> = std::env::args().collect();
            if let Some(url) = commands::hq_work::hqwork_url_from_argv(&startup_args) {
                commands::hq_work::spawn_open_hqwork_deep_link(app.handle(), url);
            }

            // One-shot migration of any legacy `/deploy`-skill stub at
            // ~/.hq/config.json. Runs first so subsequent prewarm /
            // daemon / sync calls see a clean HqConfig (when a personal
            // person-entity.json is on disk) or a missing config that
            // surfaces SetupNeeded cleanly (when reconstruction isn't
            // possible). Best-effort and idempotent — failures log to the
            // diagnostic file and don't abort launch.
            commands::config::migrate_legacy_config_stub();

            // Record this app's version to ~/.hq/sync-version.json so the
            // hq-cli can attach the installed hq-sync version to feedback
            // submissions — the CLI has no other way to learn the running
            // menubar-app version. Best-effort; never aborts launch.
            commands::config::record_sync_version(
                &app.package_info().version.to_string(),
            );

            // Default-on autostart: ensure the LaunchAgent plist matches the
            // effective `startAtLogin` pref (default true) so a fresh install
            // opens HQ Sync at login without the user opening Settings first.
            // Honours an explicit `"startAtLogin": false` opt-out. Best-effort
            // and idempotent — never aborts launch.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            commands::autostart::ensure_autostart_on_launch();

            // macOS activation policy, driven by the `dockIcon` pref
            // (default OFF). `Regular` = Dock icon + CMD-Tab entry + app menu
            // bar; `Accessory` = the classic menubar-only posture where the
            // tray icon is the only surface. The bundle stays LSUIElement, so
            // the process launches as an accessory either way and a user who
            // opted out never sees a Dock icon flash before we settle here.
            // Re-applied without a restart by `apply_dock_icon` when the
            // Settings toggle flips.
            //
            // `apply_at_launch` takes `&mut App` on purpose — the AppHandle
            // setter is NOT equivalent here and would be silently clobbered at
            // applicationDidFinishLaunching. See its doc comment.
            #[cfg(target_os = "macos")]
            commands::dock::apply_at_launch(app, commands::dock::dock_icon_pref());

            // Brand the app's runtime icon image. This is what the Dock
            // renders under `Regular` policy; under `Accessory` the Dock stays
            // empty but the meetings window (and any future detached windows)
            // still show up in Mission Control / Cmd-Tab — by default with a
            // generic folder icon because no .app bundle icon is registered at
            // runtime. Setting NSApp.applicationIconImage gives every one of
            // those surfaces the HQ mark to render.
            #[cfg(target_os = "macos")]
            {
                const HQ_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
                set_app_icon_from_bytes(HQ_ICON_PNG);
            }

            let first_run = commands::first_run::should_autoshow_on_launch(launch_kind);

            // The very first launch opens the onboarding FLOATING CARD (transparent,
            // centered, no frosted popover material, no native window shadow) rather
            // than the compact popover. Apply that window state BEFORE the window is
            // shown so it paints correctly framed from the first frame — no flash of
            // the small frosted popover shell before onboarding resizes it.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Some(window) = app.get_webview_window("main") {
                if first_run {
                    let onboarding_size = window
                        .current_monitor()
                        .ok()
                        .flatten()
                        .map(|monitor| {
                            let work_area = monitor.work_area();
                            let scale = monitor.scale_factor();
                            tauri::LogicalSize::new(
                                ((work_area.size.width as f64 / scale) - 32.0)
                                    .clamp(360.0, 780.0),
                                ((work_area.size.height as f64 / scale) - 32.0)
                                    .clamp(420.0, 620.0),
                            )
                        })
                        .unwrap_or_else(|| tauri::LogicalSize::new(780.0, 620.0));
                    let _ = window.set_size(onboarding_size);
                    let _ = window.set_shadow(false);
                    hq_platform::window_effects::clear_popover_vibrancy(&window);
                    let _ = window.center();
                } else {
                    hq_platform::window_effects::apply_popover_vibrancy(&window);
                    #[cfg(target_os = "windows")]
                    if let Ok(h) = window.hwnd() {
                        hq_platform::window_effects::set_small_corner(h.0 as isize);
                    }
                }
            }

            // WKWebView keeps cache entries for Tauri's stable custom-protocol
            // origin across app-bundle replacements. Keep every user-reachable
            // startup surface gated until disk/memory cache eviction and the
            // hidden-main reload have both been dispatched. The callback runs
            // immediately in dev, when this version is already complete, or
            // when eviction cannot be scheduled.
            #[cfg(target_os = "macos")]
            {
                let startup_app = app.handle().clone();
                webview_asset_cache::evict_frontend_asset_cache_once(
                    app.handle(),
                    env!("APP_VERSION"),
                    move || {
                        if let Err(error) = setup_startup_surfaces(&startup_app, first_run) {
                            util::logfile::log(
                                "app",
                                &format!("startup surface setup failed after cache gate: {error}"),
                            );
                        }
                        setup_notification_producers(&startup_app);
                        if webview_asset_cache::take_deferred_activation() {
                            surface_existing_instance(&startup_app);
                        }
                    },
                );
            }

            #[cfg(not(target_os = "macos"))]
            setup_startup_surfaces(app.handle(), first_run)?;

            // Hard version-gate against hq-pro fires at 5s (BEFORE the soft
            // updater at 10s) so a known-bad release can be yanked before the
            // user touches anything sensitive. Server-side source of truth is
            // `apps/hq-pro/src/vault-service/handlers/client-version-check.ts`.
            // See `commands::version_gate` for the rationale.
            commands::version_gate::setup_version_gate(app.handle());
            #[cfg(not(target_os = "macos"))]
            updater::setup_update_checker(app.handle());
            commands::telemetry::setup_daily_active_emit();
            // Surface live progress for ANY sync (auto-sync / CLI), not just
            // a menubar-spawned Sync Now, by watching ~/.hq/sync-progress.json.
            commands::sync_progress_watch::setup_sync_progress_watch(app.handle());
            // U59: hq-cloud itself decides V2 rollout admission; this sidecar
            // only forwards local file changes through its minimal stdin API.
            commands::realtime_mutation::setup_realtime_mutation_watcher(app.handle());
            // Supervise the watch daemon: respawn it if it dies while auto-sync
            // is on, so a crash/kill doesn't leave sync silently quiet.
            commands::daemon::setup_daemon_supervisor(app.handle());

            // Preserve the existing non-macOS notification startup order:
            // updater registration above follows the hard version gate, while
            // share/DM producers and the post-sync top-up start after the daemon
            // supervisor. macOS starts the same producers only from the cache
            // readiness callback.
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Listener;

                commands::share_notify::setup_share_notify_poller(app.handle().clone());
                #[cfg(target_os = "windows")]
                commands::dm_mqtt::setup_dm_mqtt_receiver(app.handle().clone());

                let poll_handle = app.handle().clone();
                app.listen(
                    crate::events::EVENT_SYNC_ALL_COMPLETE,
                    move |_event| {
                        let handle = poll_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            commands::share_notify::poll_once(handle).await;
                        });
                    },
                );
            }

            // Install the clickable-meeting notification delegate immediately
            // so macOS can deliver a cold-launch response. Its handler awaits
            // the cache-ready signal before opening any webview destination.
            #[cfg(target_os = "macos")]
            commands::un_notify::register_delegate(app.handle());

            // Mission Control polling loop (US-005). Re-scans the local Claude/
            // Codex fleet on a configurable interval (HQ_SYNC_SESSIONS_POLL_SECS,
            // default 5s) and emits the typed `sessions:updated` event so the UI
            // stays fresh without a manual refresh — same independent-timer
            // pattern as the share/dm poller above.
            commands::sessions::setup_sessions_poller(app.handle().clone());

            // Outpost sessions subscriber + box status (US-011). Subscribes to
            // the per-person `hq/{personUid}/sessions` realtime topic (reusing the
            // dm_mqtt MQTT-over-WSS credential/presign pattern), parses the remote
            // AgentSession[] heartbeat into the shared outpost store (origin=
            // outpost), and merges it into the SAME snapshot the sessions poller
            // emits. The S3-heartbeat fallback + box-status pollers run on their
            // own timers so an MQTT outage degrades to polling, and a stale-after
            // timeout drops outpost sessions that stop reporting. macOS-gated like
            // the rest of the realtime surface; every path is best-effort.
            #[cfg(target_os = "macos")]
            {
                commands::sessions::outpost::setup_outpost_mqtt_receiver(app.handle().clone());
                commands::sessions::outpost::setup_outpost_pollers(app.handle().clone());
            }

            // SPIKE: env-var trigger to preview the custom notification banner
            // without devtools / real inbound events. Pops one representative
            // banner per source — DM (2s), share (10s), update (18s), meeting
            // (26s) — spaced past the 6s auto-dismiss so each is seen in turn.
            // No-op when unset.
            //   HQ_SYNC_PREVIEW_BANNER=1     → DM only
            //   HQ_SYNC_PREVIEW_BANNER=all   → DM, share, update, meeting
            match std::env::var("HQ_SYNC_PREVIEW_BANNER").as_deref() {
                Ok("1") | Ok("all") => {
                    let all = std::env::var("HQ_SYNC_PREVIEW_BANNER").as_deref() == Ok("all");
                    let h = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use std::time::Duration;
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let _ = commands::banner::preview_dm_banner(h.clone()).await;
                        if all {
                            tokio::time::sleep(Duration::from_secs(8)).await;
                            let _ = commands::banner::preview_share_banner(h.clone()).await;
                            tokio::time::sleep(Duration::from_secs(8)).await;
                            let _ = commands::banner::preview_update_banner(h.clone()).await;
                            tokio::time::sleep(Duration::from_secs(8)).await;
                            let _ = commands::banner::preview_meeting_banner(h.clone()).await;
                        }
                    });
                }
                _ => {}
            }

            commands::hq_cli_update::setup_hq_cli_update_checker(app.handle());
            commands::packages::setup_pack_update_checker(app.handle());
            commands::hq_core_state::setup_core_state_checker(app.handle());

            // Clear a `.git/index.lock` orphaned by a mirror run that was
            // killed before it could finish. Until this happens, every HQ git
            // write — the mirror, the autocommit hook, the handoff finalizer —
            // fails, and the app is the only party that knows the run died.
            // Off the setup thread because the reaper probes for a live
            // holder, which spawns a short-lived child process.
            std::thread::spawn(commands::git_mirror::reap_stale_index_lock_on_launch);

            // Fire-and-forget: warm the npx cache for
            // `@indigoai-us/hq-cloud@<HQ_CLOUD_VERSION>` so the user's
            // first click of "Sync Now" doesn't eat the 3–10s first-time
            // download. No-ops if the cache is already warm. See
            // `commands::prewarm` for the rationale.
            commands::prewarm::spawn_prewarm();

            // US-004: silent HQ Work co-install after a Sync update. Canonical
            // path is next launch — macOS download_and_install often kills the
            // process before post-install hooks run.
            commands::hq_work::spawn_maybe_co_install_hq_work();

            // Auto-start the watcher when either flag is on:
            //   - `autostart_daemon` (V2-prep devtools flag, default OFF)
            //   - `realtime_sync`   (user-facing Auto-sync toggle, default ON)
            let dev_disable_auto_sync =
                std::env::var("HQ_DEV_DISABLE_AUTO_SYNC_ON_LAUNCH").ok().as_deref() == Some("1");
            if !dev_disable_auto_sync
                && (commands::daemon::is_autostart_enabled()
                    || commands::daemon::is_realtime_sync_enabled())
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Small delay to let the app fully initialize
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = commands::daemon::start_daemon_for_app_launch(handle);
                });
            }

            // Bound the meeting-detect notify ledger on launch: drop entries
            // older than 14 days. Best-effort; failures never block setup.
            util::meeting_ledger::prune_on_launch(chrono::Utc::now());

            // Start the Recall Desktop SDK sidecar — gated on
            // `meeting_detect_eligible()` so users outside the @getindigo.ai
            // allowlist see no SDK process and no Recall API calls.
            //
            // We DELIBERATELY request NO macOS permissions on launch. Asking
            // for Accessibility / Screen Recording / Microphone now lives
            // exclusively behind Settings → Meeting permissions (the wizard's
            // "Trigger prompts" button → `permissions_force_native_register`).
            // On launch we only READ the current TCC status (a prompt-less
            // call) and start the SDK when every required permission is
            // already granted. If they're not, we skip the SDK: starting it
            // before then would make the SDK's own capture calls fire the very
            // prompts we're keeping out of the launch path, and we don't pop
            // the wizard either. Once the user grants the permissions from
            // Settings the wizard starts the SDK itself, and it also comes up
            // automatically on the next launch.
            // See `commands::recall_sdk` for the gate definition and the
            // graceful-degradation contract.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if !commands::recall_sdk::meeting_detect_eligible().await {
                        util::logfile::log(
                            "recall-sdk",
                            "setup: user not in @getindigo.ai allowlist — skipping SDK spawn",
                        );
                        return;
                    }

                    // Decide whether to start the SDK now. On macOS we hold it
                    // back until the required permissions are already granted —
                    // a prompt-less status read — so the SDK's own capture
                    // calls never trigger the prompts we keep out of the launch
                    // path. On platforms without TCC, start as before.
                    #[cfg(target_os = "macos")]
                    let should_start_sdk = match commands::permissions::meetings_permissions_state() {
                        Ok(state) if state.all_required_granted => {
                            util::logfile::log(
                                "permissions",
                                "startup: required meeting permissions granted — starting SDK",
                            );
                            true
                        }
                        Ok(_) => {
                            util::logfile::log(
                                "permissions",
                                "startup: meeting permissions not yet granted — not starting SDK (enable via Settings -> Meeting permissions)",
                            );
                            false
                        }
                        Err(e) => {
                            util::logfile::log(
                                "permissions",
                                &format!("startup: meetings_permissions_state failed ({e}) — not starting SDK"),
                            );
                            false
                        }
                    };
                    #[cfg(not(target_os = "macos"))]
                    let should_start_sdk = true;

                    if should_start_sdk {
                        if let Err(e) = commands::recall_sdk::start_recall_sdk(handle.clone()).await {
                            util::logfile::log(
                                "recall-sdk",
                                &format!("start_recall_sdk error (app continues): {e}"),
                            );
                        }
                    }

                    // Recover any recording that was in flight when the app
                    // last closed. The durable recordings ledger persists the
                    // windowId→recordingId mapping on start and clears it on a
                    // clean stop; a leftover entry means a crash/forced-quit
                    // mid-recording. This queries hq-pro for each such
                    // recording's status and surfaces a "still processing" /
                    // "ingest failed" thread instead of silently losing it.
                    // Best-effort: all failures are logged + swallowed inside.
                    commands::recall_sdk::reconcile_recordings_on_launch(handle).await;
                });
            }

            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // On exit, tear down every spawned child (the `--watch` sync daemon,
            // recall sidecar, …). Each was spawned with `.process_group(0)`, so
            // the OS does NOT reap it when the app exits — without this they
            // reparent to PID 1 and keep running against a now-stale engine.
            //
            // ExitRequested is the chokepoint for every APP-initiated quit
            // (tray Quit, `quit_app`, Cmd-Q, last window closed), all of which
            // reach `app.exit(0)`. It is NOT the chokepoint for a Windows
            // session end: tauri-runtime-wry raises ExitRequested only on the
            // last window's `Destroyed` event or on `Message::RequestExit`, and
            // `WM_ENDSESSION` produces neither. That path is handled in the
            // `RunEvent::Exit` arm below — see `handle_run_event_exit`.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Latch first, so the `Exit` arm that follows can tell an
                // app-initiated quit from an OS-forced session end.
                commands::process::note_app_initiated_exit();
                hq_telemetry::set_native_panic_phase(hq_telemetry::NativePanicPhase::Exiting);
                hq_telemetry::record_native_panic_seam(
                    hq_telemetry::NativePanicSeam::AppExitRequested,
                );
                // An app-initiated quit is NOT a session end, so a watcher exit
                // still holding its send back has nothing to be affirmed by.
                // Flush it here rather than letting the process leave with the
                // alert unsent: a user who quits a few seconds after a genuine
                // external kill must not silently swallow it. Bounded and
                // panic-free — it drains a vector and sends what it took.
                commands::daemon::flush_pending_session_end_captures();
                // Likewise, a fault-exit capture whose deferred OS fault read is
                // still in flight (HQ-DESKTOP-4X) names a real crash — emit it now
                // with its honest `deferred` provenance rather than lose it to the
                // deferral horizon. Bounded, panic-free, no Event Log work.
                commands::daemon::flush_pending_watcher_fault_captures("app_quit_flush");
                #[cfg(target_os = "windows")]
                if let Some(observer) = _app_handle
                    .try_state::<commands::session_end_observer::SessionEndObserverHandle>()
                {
                    observer.shutdown(std::time::Duration::from_millis(500));
                }
                commands::process::terminate_all_for_exit(std::time::Duration::from_millis(500));
            }

            if matches!(&event, tauri::RunEvent::Exit) {
                hq_telemetry::set_native_panic_phase(hq_telemetry::NativePanicPhase::Destroyed);

                // Windows only, and only when no ExitRequested preceded this:
                // the OS is ending the desktop session, tao's event-loop runner
                // is already latched in `Destroyed`, and the very next message
                // its still-live pump dispatches would panic out of an
                // `extern "system"` window procedure and abort the process.
                // Run the teardown that ExitRequested would have run, then
                // leave before the pump gets another iteration.
                //
                // Every step is individually capped and the total is ~1.75s
                // against Windows' 5s default `WaitToKillAppTimeout`. Children
                // are terminated BEFORE the Sentry flush: at shutdown the
                // network may already be down, and an orphaned sync daemon is a
                // worse outcome than a dropped report.
                #[cfg(target_os = "windows")]
                handle_run_event_exit(
                    commands::process::app_initiated_exit(),
                    || {
                        use commands::session_end_observer::SessionEndObserverHandle;
                        use hq_desktop_core::sync_outcome::WindowsTerminatorAttribution;

                        // FIRST, before anything else in the session-end teardown:
                        // reaching this arm is unambiguous OS evidence that the
                        // session is ending (tao raises `RunEvent::Exit` without a
                        // preceding `ExitRequested` only on `WM_ENDSESSION`). Make
                        // that durable in the process-global latch BEFORE the
                        // one-shot `drop_pending_session_end_captures` sweep runs,
                        // so a watcher capture built microseconds later — after the
                        // sweep, during its own grace — still sees positive
                        // evidence at resolution and suppresses (HQ-DESKTOP r3).
                        // Bounded, allocation-free and panic-free: one monotonic
                        // read and one atomic store, safe inside this window
                        // procedure.
                        commands::session_end_latch::note_windows_session_end();

                        hq_telemetry::record_native_panic_seam(
                            hq_telemetry::NativePanicSeam::AppSessionEndExit,
                        );

                        // Reaching this arm IS the affirmation a deferred
                        // session-end watcher capture was waiting for: the OS told
                        // this app directly that the session is ending. Drop the
                        // held-back (benign) event instead of letting it race the
                        // teardown. Bounded and allocation-only — it adds no
                        // uncapped work to a teardown that runs inside a window
                        // procedure.
                        commands::daemon::drop_pending_session_end_captures();
                        // A deferred FAULT capture is different: it names a real
                        // 0xC0000409-class crash, not a benign session end, so it
                        // must NOT be dropped here. Flush it immediately with its
                        // honest `deferred` provenance, ahead of the capped Sentry
                        // flush below. Bounded, panic-free, no Event Log work.
                        commands::daemon::flush_pending_watcher_fault_captures("session_end_flush");

                        // Corroborating signal, read BEFORE the observer is shut
                        // down (shutdown moves its readiness out of the
                        // affirming states). Recorded alongside — never instead
                        // of — the branch marker, so a residual report shows
                        // whether the two independent signals agreed.
                        if let Some(observer) = _app_handle.try_state::<SessionEndObserverHandle>()
                        {
                            if observer.tracker().attribution_now()
                                == WindowsTerminatorAttribution::SessionEndObserved
                            {
                                hq_telemetry::record_native_panic_seam(
                                    hq_telemetry::NativePanicSeam::AppSessionEndObserved,
                                );
                            }
                            observer.shutdown(std::time::Duration::from_millis(500));
                        }

                        // Ownership report, emitted while the registry still
                        // holds the children about to be terminated. Env-gated
                        // (`HQ_SYNC_SESSION_END_OWNED_PIDS`), so this is inert
                        // in every shipped build; the live session-end proof
                        // points it at a temp file. Its existence is what tells
                        // that proof this teardown actually ran, and the pids
                        // it lists are what the proof then requires to be dead
                        // — the app declares what it owns instead of the test
                        // guessing from process names.
                        commands::process::report_session_end_owned_pids();

                        commands::process::terminate_all_for_exit(
                            std::time::Duration::from_millis(500),
                        );

                        // Leaving the process here skips the
                        // `ClientInitGuard` drop that normally flushes Sentry,
                        // so flush by hand under a hard cap.
                        hq_telemetry::flush_within(std::time::Duration::from_millis(750));
                    },
                    || std::process::exit(0),
                );
            }

            // Dock-icon click on the already-running app. Without this the
            // opted-in Dock icon would bounce and
            // do nothing, because every HQ window is hidden by default and the
            // OS has no reason to unhide one on its own.
            //
            // US-004 WindowRouter: `DockIconClick` resolves to ShowDesktop, so
            // this opens the full desktop window — a Dock icon is the
            // affordance users associate with an application's main window,
            // while the menu-bar icon stays the compact popover's affordance.
            // Show, never toggle: a Dock click that hides the window reads as a
            // no-op. Signed-out users fall back to the popover's SignInPrompt
            // inside `show_desktop_window`.
            //
            // `has_visible_windows` is deliberately ignored: the always-on-top
            // floating widget counts as a visible window, so honouring the flag
            // would make the Dock icon inert for every user who has the widget
            // enabled (the default on macOS).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                // Same reason as the focus handler above: no eager force-probe.
                let _ = commands::desktop_alt::activation_policy(
                    commands::desktop_alt::ActivationSource::DockIconClick,
                );
                tray::show_desktop_window(_app_handle);
                util::logfile::log("dock", "dock icon clicked: showing desktop window");
            }
        });
}

#[cfg(test)]
mod native_panic_tests {
    use super::*;
    use sentry::protocol::Event;
    use std::cell::{Cell, RefCell};

    fn recorded_native_seams() -> Vec<String> {
        hq_telemetry::before_send(Event::default())
            .expect("event remains sendable")
            .breadcrumbs
            .values
            .into_iter()
            .filter(|breadcrumb| breadcrumb.category.as_deref() == Some("ui.seam"))
            .filter_map(|breadcrumb| breadcrumb.message)
            .collect()
    }

    fn with_appended_seam(mut before: Vec<String>, message: &str) -> Vec<String> {
        before.push(message.to_string());
        if before.len() > 8 {
            before.remove(0);
        }
        before
    }

    #[test]
    fn guarded_hide_wrappers_record_and_run_only_when_taken() {
        let baseline = recorded_native_seams();
        let close_calls = Cell::new(0);

        handle_window_close_requested_hide(false, || close_calls.set(close_calls.get() + 1));
        assert_eq!(close_calls.get(), 0);
        assert_eq!(recorded_native_seams(), baseline);

        handle_window_close_requested_hide(true, || close_calls.set(close_calls.get() + 1));
        assert_eq!(close_calls.get(), 1);
        let after_close = with_appended_seam(baseline, "window.close-requested-hide");
        assert_eq!(recorded_native_seams(), after_close);

        let blur_calls = Cell::new(0);
        tray::handle_tray_blur_hide(false, || blur_calls.set(blur_calls.get() + 1));
        assert_eq!(blur_calls.get(), 0);
        assert_eq!(recorded_native_seams(), after_close);

        tray::handle_tray_blur_hide(true, || blur_calls.set(blur_calls.get() + 1));
        assert_eq!(blur_calls.get(), 1);
        assert_eq!(
            recorded_native_seams(),
            with_appended_seam(after_close, "tray.blur-hide")
        );
    }

    /// HQ-DESKTOP-44 regression. Fails on the pre-fix tree, where main.rs has
    /// no `RunEvent::Exit` arm at all: an OS-forced exit ran neither callback,
    /// so tao's still-live pump reached a `Destroyed` runner and aborted.
    #[test]
    fn run_event_exit_tears_down_and_leaves_only_when_the_os_forced_the_exit() {
        // OS-forced Windows session end: `WM_ENDSESSION` never produces
        // `ExitRequested`, so the flag is still false. Both callbacks must run,
        // teardown strictly first — children have to be reaped before the
        // process leaves.
        let calls = RefCell::new(Vec::<&'static str>::new());
        handle_run_event_exit(
            false,
            || calls.borrow_mut().push("teardown"),
            || calls.borrow_mut().push("terminate"),
        );
        assert_eq!(*calls.borrow(), vec!["teardown", "terminate"]);

        // User-initiated quit (tray Quit / `quit_app` / Cmd-Q / last window
        // closed). `ExitRequested` already ran this teardown, and tauri's
        // `cleanup_before_exit()` plus tao's own `process::exit(exit_code)`
        // follow this callback — terminating here would skip both, taking the
        // tray icon and window resources down with it.
        let calls = RefCell::new(Vec::<&'static str>::new());
        handle_run_event_exit(
            true,
            || calls.borrow_mut().push("teardown"),
            || calls.borrow_mut().push("terminate"),
        );
        assert!(
            calls.borrow().is_empty(),
            "the app-initiated quit path must stay behaviourally unchanged"
        );
    }
}
