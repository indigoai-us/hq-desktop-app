//! Runtime side of UI hot updates (pure logic lives in
//! `hq_desktop_core::ui_hot`; see `docs/RELEASE.md` "UI hot updates").
//!
//! - Resolves the hot-bundle root (`<app data dir>/ui`, outside the signed
//!   `.app`), the running shell key (`Resources/shell-key.txt`), and the
//!   `uiHotUpdates` setting.
//! - Caches which UI root `ui_protocol` serves. The cache is only refreshed on
//!   launch, rollback, or an explicit reload, so a page never mixes assets
//!   from two bundles.
//! - Runs the boot health beacon: when a hot bundle is served, the UI must
//!   call `ui_hot_boot_ok` within [`beacon_timeout`]. A miss or an explicit
//!   `ui_hot_boot_failed` marks the bundle bad, rolls back, and reloads.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use hq_desktop_core::ui_hot::{self, Selection, UiHotMode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const LOG_TAG: &str = "ui-hot";
const DEFAULT_BEACON_SECS: u64 = 30;

static HOT_ROOT: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static SERVED: RwLock<Option<Served>> = RwLock::new(None);
static BEACON_SEEN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
struct Served {
    /// `None` = no UI directory at all.
    dir: Option<PathBuf>,
    /// `Some(version)` when a hot bundle is being served.
    hot_version: Option<String>,
}

pub(crate) fn log(msg: &str) {
    eprintln!("[hq-ui-hot] {msg}");
    crate::util::logfile::log(LOG_TAG, msg);
}

/// `<app data dir>/ui`. `HQ_UI_HOT_ROOT` overrides it (tests, proofs).
pub fn hot_root() -> Option<&'static Path> {
    HOT_ROOT.get().map(PathBuf::as_path)
}

/// Idempotent: the protocol handler calls this on its first request too,
/// since a window can request `index.html` before `setup` runs.
pub fn init(app: &AppHandle) {
    if HOT_ROOT.get().is_some() {
        return;
    }
    let root = std::env::var_os("HQ_UI_HOT_ROOT")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok().map(|d| d.join("ui")));
    if let Some(root) = root {
        let _ = HOT_ROOT.set(root);
    }
    let _ = APP.set(app.clone());
}

/// The `uiHotUpdates` setting from `~/.hq/menubar.json` (untyped read, so the
/// key survives every typed settings round-trip). `HQ_UI_HOT_UPDATES`
/// overrides it.
pub fn mode() -> UiHotMode {
    if let Ok(v) = std::env::var("HQ_UI_HOT_UPDATES") {
        return UiHotMode::from_pref(Some(&v));
    }
    let stored = crate::util::paths::menubar_json_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("uiHotUpdates").and_then(|m| m.as_str()).map(str::to_string));
    UiHotMode::from_pref(stored.as_deref())
}

fn resources_dir() -> Option<PathBuf> {
    hq_desktop_core::runtime_version::resources_dir_from_current_exe()
}

/// The running shell's key (`Resources/shell-key.txt`). `None` for dev runs
/// and any bundle assembled without a key — hot bundles never apply there.
pub fn shell_key() -> Option<String> {
    static KEY: OnceLock<Option<String>> = OnceLock::new();
    KEY.get_or_init(|| resources_dir().as_deref().and_then(ui_hot::read_shell_key))
        .clone()
}

fn builtin_root() -> Option<PathBuf> {
    crate::ui_protocol::builtin_ui_root_dir()
}

fn resolve() -> Served {
    let (selection, skipped) = match hot_root() {
        Some(root) => {
            let report = ui_hot::select_root(
                root,
                mode(),
                shell_key().as_deref(),
                crate::app_version::current(),
            );
            (report.selection, report.skipped)
        }
        None => (Selection::Builtin, Vec::new()),
    };
    for (version, reason) in &skipped {
        log(&format!("skipped hot bundle {version}: {reason:?}"));
    }
    match selection {
        Selection::Hot { ui_version, dir } => match dir.canonicalize() {
            Ok(dir) => Served { dir: Some(dir), hot_version: Some(ui_version) },
            Err(err) => {
                log(&format!("hot bundle {ui_version} unreadable ({err}); serving builtin"));
                Served { dir: builtin_root(), hot_version: None }
            }
        },
        Selection::Builtin => Served { dir: builtin_root(), hot_version: None },
    }
}

/// The directory `ui_protocol` serves from (cached until [`invalidate`]).
pub fn served_root() -> Option<PathBuf> {
    if let Some(served) = SERVED.read().ok().and_then(|g| g.clone()) {
        return served.dir;
    }
    let served = resolve();
    match &served.hot_version {
        Some(v) => log(&format!("serving hot UI {v} from {}", display(&served.dir))),
        None => log(&format!("serving builtin UI from {}", display(&served.dir))),
    }
    if let Ok(mut guard) = SERVED.write() {
        *guard = Some(served.clone());
    }
    served.dir
}

fn display(dir: &Option<PathBuf>) -> String {
    dir.as_ref().map(|d| d.display().to_string()).unwrap_or_else(|| "<none>".into())
}

fn served_hot_version() -> Option<String> {
    SERVED.read().ok().and_then(|g| g.as_ref().and_then(|s| s.hot_version.clone()))
}

/// Drop the cached root so the next request re-resolves it.
pub fn invalidate() {
    if let Ok(mut guard) = SERVED.write() {
        *guard = None;
    }
    BEACON_SEEN.store(false, Ordering::SeqCst);
}

/// The live UI version: the hot bundle's `uiVersion`, else the app version
/// (the builtin UI ships with the app).
pub fn ui_version() -> String {
    served_hot_version().unwrap_or_else(|| crate::app_version::current().to_string())
}

pub fn ui_source() -> &'static str {
    if served_hot_version().is_some() {
        "hot"
    } else {
        "builtin"
    }
}

/// Keep the client-attribution `x-hq-ui-version` header in step.
fn publish_ui_version() {
    hq_desktop_core::client_info::set_ui_version(&ui_version());
}

/// Reload every webview so it re-reads the (re-resolved) UI root.
pub fn reload_all(app: &AppHandle) {
    invalidate();
    let _ = served_root();
    publish_ui_version();
    for (_, window) in app.webview_windows() {
        if let Err(err) = window.eval("window.location.reload()") {
            log(&format!("reload {} failed: {err}", window.label()));
        }
    }
    start_beacon_watch(app.clone());
}

fn beacon_timeout() -> Duration {
    let secs = std::env::var("HQ_UI_HOT_BEACON_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BEACON_SECS);
    Duration::from_secs(secs)
}

/// Mark the served hot bundle bad, roll back, report, and reload.
pub fn roll_back(app: &AppHandle, reason: &str) {
    let (Some(root), Some(version)) = (hot_root(), served_hot_version()) else {
        return;
    };
    match ui_hot::mark_bad(root, &version) {
        Ok(state) => {
            let target = state.active.clone().unwrap_or_else(|| "builtin Resources/ui".into());
            log(&format!("rollback: {version} marked bad ({reason}); now serving {target}"));
            sentry::capture_message(
                &format!("ui hot bundle rolled back: {version} ({reason})"),
                sentry::Level::Warning,
            );
            crate::commands::telemetry::emit_desktop_telemetry_best_effort(
                "desktop_ui_hot_rollback",
                serde_json::json!({ "uiVersion": version, "reason": reason, "rolledBackTo": target }),
            );
        }
        Err(err) => log(&format!("rollback: failed to mark {version} bad: {err}")),
    }
    reload_all(app);
}

/// After a hot bundle is served, wait for the UI's health beacon.
pub fn start_beacon_watch(app: AppHandle) {
    let Some(version) = served_hot_version() else {
        return;
    };
    let timeout = beacon_timeout();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(timeout).await;
        if BEACON_SEEN.load(Ordering::SeqCst) || served_hot_version().as_deref() != Some(&version) {
            return;
        }
        log(&format!("no boot beacon from hot UI {version} within {}s", timeout.as_secs()));
        roll_back(&app, "boot beacon timeout");
    });
}

/// Call once from `setup`, after `init`.
pub fn on_startup(app: &AppHandle) {
    let _ = served_root();
    publish_ui_version();
    log(&format!(
        "mode={} shell_key={} app={} ui={} ({})",
        mode().as_str(),
        shell_key().unwrap_or_else(|| "<none>".into()),
        crate::app_version::current(),
        ui_version(),
        ui_source()
    ));
    start_beacon_watch(app.clone());
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiHotStatus {
    pub mode: &'static str,
    pub app_version: String,
    pub ui_version: String,
    pub source: &'static str,
    pub shell_key: Option<String>,
    pub pending_version: Option<String>,
}

fn pending_version() -> Option<String> {
    let root = hot_root()?;
    let active = ui_hot::read_state(root).active?;
    (Some(&active) != served_hot_version().as_ref()).then_some(active)
}

#[tauri::command]
pub fn get_ui_hot_status() -> UiHotStatus {
    UiHotStatus {
        mode: mode().as_str(),
        app_version: crate::app_version::current().to_string(),
        ui_version: ui_version(),
        source: ui_source(),
        shell_key: shell_key(),
        pending_version: pending_version(),
    }
}

/// Health beacon: the UI booted. Confirms the served hot bundle as good.
#[tauri::command]
pub fn ui_hot_boot_ok() {
    if BEACON_SEEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let (Some(root), Some(version)) = (hot_root(), served_hot_version()) else {
        return;
    };
    match ui_hot::confirm_good(root, &version) {
        Ok(_) => log(&format!("boot beacon received; {version} confirmed good")),
        Err(err) => log(&format!("confirm {version} failed: {err}")),
    }
}

/// The UI hit a fatal boot error. Rolls back when a hot bundle is served.
#[tauri::command]
pub fn ui_hot_boot_failed(app: AppHandle, reason: String) {
    if served_hot_version().is_none() {
        return;
    }
    let reason: String = reason.chars().take(200).collect();
    roll_back(&app, &format!("ui fatal boot error: {reason}"));
}

/// True while a call window is open or any secondary window is visible —
/// the UI then shows the reload toast instead of reloading on its own.
#[tauri::command]
pub fn ui_hot_call_active(app: AppHandle) -> bool {
    app.webview_windows().iter().any(|(label, window)| {
        label.as_str() != "main"
            && label.as_str() != "desktop-alt"
            && window.is_visible().unwrap_or(true)
    })
}

/// The "Interface updated — reload" action.
#[tauri::command]
pub fn ui_hot_reload(app: AppHandle) {
    log("reload requested by UI");
    reload_all(&app);
}

#[tauri::command]
pub fn set_ui_hot_updates(mode: String) -> Result<String, String> {
    let resolved = UiHotMode::from_pref(Some(&mode));
    let path = crate::util::paths::menubar_json_path()?;
    let mut obj = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert("uiHotUpdates".into(), serde_json::Value::String(resolved.as_str().into()));
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| e.to_string())?;
    ui_hot::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    log(&format!("setting uiHotUpdates={}", resolved.as_str()));
    Ok(resolved.as_str().to_string())
}

/// Event the UI listens for to show the "Interface updated" toast.
pub const EVENT_UI_UPDATED: &str = "ui-hot:updated";

pub fn emit_updated(version: &str) {
    if let Some(app) = APP.get() {
        // Only the desktop window shows the toast and decides on reload.
        let _ = app.emit_to(
            "desktop-alt",
            EVENT_UI_UPDATED,
            serde_json::json!({ "uiVersion": version }),
        );
    }
}
