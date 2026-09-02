//! Native recovery window: a bundled HTML page with no dependency on the
//! Svelte desktop bundle. Opened by the boot watchdog, safe-mode, or the
//! tray/app menu.

use std::borrow::Cow;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::boot_watchdog::{
    consume_safe_mode_flag, force_recovery_from_env, safe_mode_requested, ui_state_reset_script,
    RecoveryTrigger, WatchdogEvent, WatchdogRuntime, WATCHDOG_TIMEOUT_ENV,
};
use crate::updater::{self, UpdateInfo};
use crate::util::logfile::log;

pub const WINDOW_LABEL: &str = "recovery";
pub const SCHEME: &str = "hq-recovery";
const RECOVERY_HTML: &str = include_str!("../recovery/index.html");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryInit {
    version: String,
    pending_update: Option<UpdateInfo>,
    trigger: String,
}

fn recovery_url() -> WebviewUrl {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        WebviewUrl::CustomProtocol(
            Url::parse("http://hq-recovery.localhost/index.html").expect("recovery url"),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        WebviewUrl::CustomProtocol(
            Url::parse("hq-recovery://localhost/index.html").expect("recovery url"),
        )
    }
}

pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |_ctx, request| {
        let path = request.uri().path();
        if path == "/" || path == "/index.html" || path.is_empty() {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                .body(Cow::<[u8]>::Borrowed(RECOVERY_HTML.as_bytes()))
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(Cow::<[u8]>::Borrowed(b""))
                        .expect("empty recovery error body")
                })
        } else {
            tauri::http::Response::builder()
                .status(404)
                .body(Cow::<[u8]>::Borrowed(b""))
                .expect("empty recovery 404 body")
        }
    })
}

fn boot_log(message: &str) {
    log("boot", message);
    eprintln!("[boot] {message}");
}

/// Tests construct `tauri::test::mock_app()` without installing
/// [`WatchdogRuntime`]. `AppHandle::state` panics in that case; a missing
/// runtime must be a no-op so Windows unit tests cannot abort the process.
fn apply_watchdog(
    app: &AppHandle,
    f: impl FnOnce(&mut crate::boot_watchdog::BootWatchdog) -> WatchdogEvent,
) -> WatchdogEvent {
    app.try_state::<WatchdogRuntime>()
        .map(|runtime| runtime.apply(f))
        .unwrap_or(WatchdogEvent::None)
}

pub fn on_startup(app: &AppHandle) {
    if force_recovery_from_env() {
        boot_log("HQ_DESKTOP_FORCE_RECOVERY set — opening recovery window");
        handle_event(app, apply_watchdog(app, |dog| dog.on_safe_mode()));
        return;
    }
    if safe_mode_requested() {
        boot_log("~/.hq/desktop-safe-mode present — opening recovery window");
        consume_safe_mode_flag();
        handle_event(app, apply_watchdog(app, |dog| dog.on_safe_mode()));
    }
}

pub fn note_desktop_window_created(app: &AppHandle) {
    boot_log("desktop-alt window created");
    handle_event(app, apply_watchdog(app, |dog| dog.on_window_created()));
}

pub fn note_desktop_user_closed(app: &AppHandle) {
    boot_log("desktop-alt closed by user");
    handle_event(app, apply_watchdog(app, |dog| dog.on_user_closed()));
}

pub fn note_desktop_destroyed(app: &AppHandle) {
    let event = apply_watchdog(app, |dog| dog.on_webview_crash());
    if matches!(event, WatchdogEvent::OpenRecovery { .. }) {
        boot_log("desktop-alt webview gone before shell_ready");
    }
    handle_event(app, event);
}

fn handle_event(app: &AppHandle, event: WatchdogEvent) {
    match event {
        WatchdogEvent::None => {}
        WatchdogEvent::StartTimer => {
            let timeout = crate::boot_watchdog::watchdog_timeout_from_env();
            boot_log(&format!(
                "watchdog armed ({}s{})",
                timeout.as_secs().max(1),
                if std::env::var(WATCHDOG_TIMEOUT_ENV).is_ok() {
                    ", env override"
                } else {
                    ""
                }
            ));
            spawn_timer(app, timeout);
        }
        WatchdogEvent::CancelTimer => {
            boot_log("shell ready — watchdog cancelled");
        }
        WatchdogEvent::OpenRecovery { trigger } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = open_recovery_window(app, trigger).await {
                    boot_log(&format!("failed to open recovery window: {error}"));
                }
            });
        }
    }
}

fn spawn_timer(app: &AppHandle, timeout: Duration) {
    let Some(runtime) = app.try_state::<WatchdogRuntime>() else {
        return;
    };
    let generation = runtime.generation();
    drop(runtime);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(timeout).await;
        let Some(runtime) = handle.try_state::<WatchdogRuntime>() else {
            return;
        };
        if runtime.generation() != generation {
            return;
        }
        boot_log("watchdog timeout — desktop shell did not report ready");
        let event = runtime.apply(|dog| dog.on_timeout());
        drop(runtime);
        handle_event(&handle, event);
    });
}

pub async fn open_recovery_from_menu(app: AppHandle) -> Result<(), String> {
    match apply_watchdog(&app, |dog| dog.on_menu_recovery()) {
        WatchdogEvent::OpenRecovery { trigger } => open_recovery_window(app, trigger).await,
        WatchdogEvent::None => open_recovery_window(app, RecoveryTrigger::Menu).await,
        _ => Ok(()),
    }
}

pub async fn open_recovery_window(
    app: AppHandle,
    trigger: RecoveryTrigger,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.set_focus();
        let _ = existing.show();
        return Ok(());
    }
    if let Some(runtime) = app.try_state::<WatchdogRuntime>() {
        runtime.mark_recovery_open(true);
    }

    let mut pending = None;
    if trigger.auto_check() {
        boot_log(&format!(
            "auto-checking for updates before recovery window (trigger={})",
            trigger.as_str()
        ));
        match updater::check_for_updates(app.clone()).await {
            Ok(info) => {
                if let Some(info) = &info {
                    boot_log(&format!(
                        "recovery auto-check found v{} — offering as primary action",
                        info.version
                    ));
                } else {
                    boot_log("recovery auto-check: no update/rollback available");
                }
                pending = info;
            }
            Err(error) => {
                boot_log(&format!("recovery auto-check failed: {error}"));
            }
        }
    }

    let init = RecoveryInit {
        version: app.package_info().version.to_string(),
        pending_update: pending,
        trigger: trigger.as_str().to_string(),
    };
    let init_json = serde_json::to_string(&init).unwrap_or_else(|_| {
        format!(
            r#"{{"version":"{}","pendingUpdate":null,"trigger":"{}"}}"#,
            app.package_info().version,
            trigger.as_str()
        )
    });
    let init_script = format!("window.__HQ_RECOVERY__ = {init_json};");

    let mut builder = WebviewWindowBuilder::new(&app, WINDOW_LABEL, recovery_url())
        .title("HQ Recovery")
        .inner_size(420.0, 520.0)
        .resizable(false)
        .always_on_top(true)
        .visible(true)
        .initialization_script(&init_script);

    builder = crate::util::external_links::deny_webview_new_windows(builder, &app);

    #[cfg(target_os = "windows")]
    {
        if let Some(args) = crate::util::webview2_automation::automation_browser_args() {
            builder = builder.additional_browser_args(&args);
        }
    }

    builder.build().map_err(|e| {
        if let Some(runtime) = app.try_state::<WatchdogRuntime>() {
            runtime.mark_recovery_open(false);
        }
        e.to_string()
    })?;
    boot_log(&format!(
        "recovery window opened (trigger={}, version=v{})",
        trigger.as_str(),
        app.package_info().version
    ));
    Ok(())
}

#[tauri::command]
pub fn shell_ready(app: AppHandle) -> Result<(), String> {
    boot_log("shell_ready from UI");
    handle_event(&app, apply_watchdog(&app, |dog| dog.on_shell_ready()));
    Ok(())
}

#[tauri::command]
pub fn reset_local_ui_state(app: AppHandle) -> Result<(), String> {
    boot_log("reset local UI state");
    let script = ui_state_reset_script();
    for label in ["desktop-alt", "main"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.eval(script) {
                boot_log(&format!("reset eval on {label} failed: {error}"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn open_recovery_window_cmd(app: AppHandle) -> Result<(), String> {
    open_recovery_from_menu(app).await
}

pub fn on_recovery_closed(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<WatchdogRuntime>() {
        runtime.mark_recovery_open(false);
    }
    boot_log("recovery window closed");
}

/// Tray / native helper: check for updates without touching the main webview.
pub fn spawn_tray_check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        boot_log("tray Check for updates…");
        match updater::check_for_updates(app.clone()).await {
            Ok(Some(info)) => {
                boot_log(&format!(
                    "tray check found v{} — opening recovery",
                    info.version
                ));
                if let Err(error) = open_recovery_from_menu(app).await {
                    boot_log(&format!("tray recovery open failed: {error}"));
                }
            }
            Ok(None) => {
                boot_log("tray check: up to date");
                #[cfg(target_os = "macos")]
                updater::notify_manual_check_up_to_date(&app);
            }
            Err(error) => {
                boot_log(&format!("tray check_for_updates failed: {error}"));
            }
        }
    });
}

pub fn spawn_tray_open_recovery(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        boot_log("tray Recovery…");
        if let Err(error) = open_recovery_from_menu(app).await {
            boot_log(&format!("tray Recovery… failed: {error}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_html_is_self_contained() {
        assert!(RECOVERY_HTML.contains("data-testid=\"hq-recovery\""));
        assert!(RECOVERY_HTML.contains("Check for updates now"));
        assert!(RECOVERY_HTML.contains("Reinstall latest release"));
        assert!(RECOVERY_HTML.contains("Reset local UI state"));
        assert!(RECOVERY_HTML.contains(">Quit<"));
        assert!(!RECOVERY_HTML.contains("desktop-alt"));
        assert!(!RECOVERY_HTML.contains("/src/"));
        assert!(RECOVERY_HTML.contains("__TAURI_INTERNALS__"));
        assert!(RECOVERY_HTML.contains("reinstall_latest_release"));
        assert!(RECOVERY_HTML.contains("reset_local_ui_state"));
    }

    #[test]
    fn recovery_url_uses_the_custom_scheme() {
        match recovery_url() {
            WebviewUrl::CustomProtocol(url) => {
                let raw = url.as_str();
                #[cfg(any(target_os = "windows", target_os = "android"))]
                assert_eq!(raw, "http://hq-recovery.localhost/index.html");
                #[cfg(not(any(target_os = "windows", target_os = "android")))]
                assert_eq!(raw, "hq-recovery://localhost/index.html");
            }
            other => panic!("expected custom protocol, got {other:?}"),
        }
    }

    #[test]
    fn watchdog_runtime_is_optional_so_unit_tests_cannot_abort() {
        let src = include_str!("recovery.rs");
        let production = src.split("mod tests").next().expect("production source");
        assert!(
            production.contains("try_state::<WatchdogRuntime>()"),
            "recovery must use try_state so mock apps and Windows unit tests do not panic"
        );
        assert!(
            !production.contains("app.state::<WatchdogRuntime>")
                && !production.contains("handle.state::<WatchdogRuntime>"),
            "AppHandle::state panics when WatchdogRuntime is not managed"
        );
    }
}
