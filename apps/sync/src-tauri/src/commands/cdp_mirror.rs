//! App-side wiring for the vyg CDP mirror (`hq_desktop_core::cdp_mirror`).
//!
//! One process-wide [`Mirror`] is created in `.setup()` right after the launch
//! is classified. Every hq-pro desktop telemetry emitter calls one `note_*`
//! function here with the same event name it records to hq-pro; the mirror
//! decides (flag, queue, sender) what leaves the machine. Nothing here blocks
//! the caller: `record` is a mutex push + notify, the sender is a tokio task.
//!
//! Visitor id: returned by the #1211 sign-in link completion
//! (`POST /api/desktop/signin-link` answers `{"anonId"}`) and stored in
//! `~/.hq/menubar.json` next to `installAttemptId`. The browser hop through
//! `/api/desktop/signin-start?install=<id>` is what carries the website's
//! install cookie; the app makes no handshake request of its own.

use hq_desktop_core::cdp_mirror::{
    Endpoints, Mirror, MirrorContext, EVENT_APP_FIRST_LAUNCH, EVENT_COMPANY_CREATED,
    EVENT_FIRST_SYNC_COMPLETED, EVENT_LOGIN_COMPLETED, EVENT_ONBOARDING_STEP_SHOWN,
    EVENT_SETUP_ABANDONED,
};
use hq_desktop_core::first_run::{merge_menubar_flags, read_menubar_obj};
use hq_desktop_core::lifecycle::LifecycleState;
use serde_json::{json, Map, Value};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::util::paths;

/// menubar.json keys. Same file as `installAttemptId`.
pub const ANON_ID_KEY: &str = "cdpAnonId";
pub const INSTALL_SOURCE_KEY: &str = "cdpInstallSource";
pub const FIRST_LAUNCH_AT_KEY: &str = "cdpFirstLaunchAtMs";

/// How long an app-initiated quit waits for the final flush.
pub const EXIT_FLUSH_BUDGET: Duration = Duration::from_millis(1500);

static MIRROR: OnceLock<Arc<Mirror>> = OnceLock::new();

fn mirror() -> Option<&'static Arc<Mirror>> {
    MIRROR.get()
}

/// `arm64` / `x86_64` as the website reports them (`welcome-install-arm`).
pub fn chip_label(arch: &str) -> &'static str {
    match arch {
        "aarch64" | "arm64" => "arm64",
        "x86_64" => "x86_64",
        _ => "other",
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read the persisted visitor state and first-launch stamp, minting the stamp
/// on the first call. Returns `(anon_id, install_source, first_launch_at_ms)`.
pub fn load_persisted(
    path: &std::path::Path,
    now_ms: u64,
) -> (Option<String>, Option<String>, u64) {
    let obj = read_menubar_obj(path);
    let string = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let first = match obj.get(FIRST_LAUNCH_AT_KEY).and_then(Value::as_u64) {
        Some(ms) if ms > 0 => ms,
        _ => {
            let _ = merge_menubar_flags(path, &[(FIRST_LAUNCH_AT_KEY, json!(now_ms))]);
            now_ms
        }
    };
    (string(ANON_ID_KEY), string(INSTALL_SOURCE_KEY), first)
}

fn persist_visitor(anon_id: &str, install_source: Option<&str>) {
    let anon_id = anon_id.to_string();
    let install_source = install_source.map(str::to_owned);
    // menubar.json writes are small, but keep them off the sender task.
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(path) = paths::menubar_json_path() else {
            return;
        };
        let mut updates = vec![(ANON_ID_KEY, json!(anon_id))];
        if let Some(source) = install_source.as_deref() {
            updates.push((INSTALL_SOURCE_KEY, json!(source)));
        }
        let _ = merge_menubar_flags(&path, &updates);
    });
}

/// Build the mirror and start its sender. Called once from `.setup()`.
/// Without an install id there is nothing to key events on, so no mirror.
pub fn init(_app: &AppHandle, is_first_launch: bool) {
    let Some(install_id) = super::first_run::install_attempt_id() else {
        return;
    };
    let (anon_id, install_source, first_launch_at_ms) = match paths::menubar_json_path() {
        Ok(path) => load_persisted(&path, now_ms()),
        Err(_) => (None, None, now_ms()),
    };
    let ctx = MirrorContext {
        app_version: crate::app_version::current().to_string(),
        os_version: os_info::get().version().to_string(),
        chip: chip_label(std::env::consts::ARCH).to_string(),
        install_id,
        install_source,
        first_launch_at_ms,
        anon_id,
    };
    let mirror = Mirror::new(ctx, Endpoints::default(), Box::new(persist_visitor));
    if MIRROR.set(mirror.clone()).is_err() {
        return;
    }
    if is_first_launch {
        mirror.record(EVENT_APP_FIRST_LAUNCH, Map::new());
    }
    tauri::async_runtime::spawn(mirror.run());
}

/// Queue a named event with extra props. Common props are added by the mirror.
pub fn record(name: &str, props: Map<String, Value>) {
    if let Some(mirror) = mirror() {
        mirror.record(name, props);
    }
}

/// Map an hq-pro operational telemetry row to its CDP mirror, if any.
/// `desktop_onboarding_step` with `action: "entered"` is the step being shown;
/// the company step reports creation as `outcome: "company_created"`.
pub fn mirror_for_operational_event(
    event_name: &str,
    properties: Option<&Value>,
) -> Option<(&'static str, Map<String, Value>)> {
    if event_name != "desktop_onboarding_step" {
        return None;
    }
    let props = properties?.as_object()?;
    let step = props.get("step").and_then(Value::as_str)?;
    let action = props.get("action").and_then(Value::as_str).unwrap_or("");
    let outcome = props.get("outcome").and_then(Value::as_str).unwrap_or("");
    if outcome == "company_created" {
        return Some((EVENT_COMPANY_CREATED, Map::new()));
    }
    if action == "entered" {
        let mut out = Map::new();
        out.insert("step".into(), json!(step));
        return Some((EVENT_ONBOARDING_STEP_SHOWN, out));
    }
    None
}

/// Hook for `emit_desktop_operational_telemetry`.
pub fn note_operational_event(event_name: &str, properties: Option<&Value>) {
    if let Some((name, props)) = mirror_for_operational_event(event_name, properties) {
        record(name, props);
    }
}

/// Hook for `record_desktop_login_completed_inner`.
pub fn note_login_completed(provider: &str) {
    let mut props = Map::new();
    props.insert("provider".into(), json!(provider));
    record(EVENT_LOGIN_COMPLETED, props);
}

/// Hook for the sign-in link completion (`post_signin_link_best_effort`):
/// adopt the visitor id the website returned and send what is queued.
pub fn note_signin_link_visitor(anon_id: &str) {
    let Some(mirror) = mirror().cloned() else {
        return;
    };
    mirror.adopt_visitor(anon_id, None);
    tauri::async_runtime::spawn(async move {
        mirror.flush_now().await;
    });
}

/// Hook for the company first push completing.
pub fn note_first_sync_completed() {
    record(EVENT_FIRST_SYNC_COMPLETED, Map::new());
}

/// Whether a quit at this point is "setup abandoned": the person has not
/// signed in, or HQ is not installed on this machine yet.
pub fn quit_abandons_setup(signed_in: bool, state: Option<LifecycleState>) -> bool {
    if !signed_in {
        return true;
    }
    matches!(
        state,
        Some(LifecycleState::NeedsInstall)
            | Some(LifecycleState::NeedsAuthForInstall)
            | Some(LifecycleState::InstallResume)
    )
}

/// Hook for `RunEvent::ExitRequested`. Queues `setup_abandoned` when the
/// quit happens before sign-in or install, then gives the sender a bounded
/// window to drain. The wait is bounded by [`EXIT_FLUSH_BUDGET`] and the
/// request itself by the mirror's 2 s timeout; a flag-off mirror returns
/// immediately.
pub fn on_exit_requested(app: &AppHandle) {
    let Some(mirror) = mirror().cloned() else {
        return;
    };
    if !mirror.is_enabled() {
        return;
    }
    let signed_in = matches!(
        hq_desktop_core::cognito::read_tokens_from_file(),
        Ok(Some(_))
    );
    let state = super::lifecycle::current_lifecycle_state(app);
    if quit_abandons_setup(signed_in, state) {
        let mut props = Map::new();
        props.insert(
            "lifecycleState".into(),
            json!(state
                .map(|s| format!("{s:?}"))
                .unwrap_or_else(|| "unknown".into())),
        );
        mirror.record(EVENT_SETUP_ABANDONED, props);
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    tauri::async_runtime::spawn(async move {
        mirror.flush_now().await;
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(EXIT_FLUSH_BUDGET);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chip_label_maps_rust_arch_names() {
        assert_eq!(chip_label("aarch64"), "arm64");
        assert_eq!(chip_label("x86_64"), "x86_64");
        assert_eq!(chip_label("riscv64"), "other");
    }

    #[test]
    fn persisted_state_round_trips_and_mints_first_launch_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        let (anon, source, first) = load_persisted(&path, 5_000);
        assert_eq!((anon, source, first), (None, None, 5_000));
        let (_, _, again) = load_persisted(&path, 9_000);
        assert_eq!(again, 5_000, "first launch stamp is minted once");
        merge_menubar_flags(
            &path,
            &[
                (ANON_ID_KEY, json!("vyg-x")),
                (INSTALL_SOURCE_KEY, json!("email-link")),
            ],
        )
        .unwrap();
        let (anon, source, first) = load_persisted(&path, 9_000);
        assert_eq!(anon.as_deref(), Some("vyg-x"));
        assert_eq!(source.as_deref(), Some("email-link"));
        assert_eq!(first, 5_000);
    }

    #[test]
    fn operational_rows_map_to_step_shown_and_company_created() {
        let shown = json!({"step": "welcome-signin", "action": "entered"});
        let (name, props) =
            mirror_for_operational_event("desktop_onboarding_step", Some(&shown)).unwrap();
        assert_eq!(name, EVENT_ONBOARDING_STEP_SHOWN);
        assert_eq!(props["step"], "welcome-signin");

        let created = json!({"step": "company", "action": "started", "outcome": "company_created"});
        let (name, _) =
            mirror_for_operational_event("desktop_onboarding_step", Some(&created)).unwrap();
        assert_eq!(name, EVENT_COMPANY_CREATED);

        let completed = json!({"step": "directory", "action": "completed"});
        assert!(
            mirror_for_operational_event("desktop_onboarding_step", Some(&completed)).is_none()
        );
        assert!(mirror_for_operational_event("desktop_app_daily_active", Some(&shown)).is_none());
        assert!(mirror_for_operational_event("desktop_onboarding_step", None).is_none());
    }

    #[test]
    fn quit_before_signin_or_install_is_abandonment() {
        assert!(quit_abandons_setup(false, None));
        assert!(quit_abandons_setup(
            false,
            Some(LifecycleState::SteadyState)
        ));
        assert!(quit_abandons_setup(
            true,
            Some(LifecycleState::NeedsInstall)
        ));
        assert!(quit_abandons_setup(
            true,
            Some(LifecycleState::NeedsAuthForInstall)
        ));
        assert!(quit_abandons_setup(
            true,
            Some(LifecycleState::InstallResume)
        ));
        assert!(!quit_abandons_setup(
            true,
            Some(LifecycleState::SteadyState)
        ));
        assert!(!quit_abandons_setup(
            true,
            Some(LifecycleState::InstalledFirstRun)
        ));
        assert!(!quit_abandons_setup(true, None));
    }

    /// Every hq-pro desktop telemetry emitter must call into the mirror, so a
    /// future edit cannot silently drop a funnel stage from the CDP.
    #[test]
    fn mirror_is_wired_at_every_emitter_site() {
        let main = include_str!("../main.rs");
        let setup = main
            .split("commands::first_run::classify_launch(app.handle());")
            .nth(1)
            .expect("classify_launch call in setup");
        let next_statement = setup.trim_start().split(';').next().unwrap();
        assert!(
            next_statement.starts_with("commands::cdp_mirror::init(")
                && next_statement.contains("LaunchKind::FirstRun"),
            "app_first_launch: cdp_mirror::init must follow classify_launch"
        );
        let exit = main
            .split("if let tauri::RunEvent::ExitRequested { .. } = event {")
            .nth(1)
            .expect("ExitRequested arm");
        let exit_arm = exit
            .split("if matches!(&event, tauri::RunEvent::Exit)")
            .next()
            .unwrap();
        assert!(
            exit_arm.contains("commands::cdp_mirror::on_exit_requested(_app_handle);"),
            "setup_abandoned: on_exit_requested must run in the ExitRequested arm"
        );
        let before_terminate = exit_arm
            .split("commands::process::terminate_all_for_exit")
            .next()
            .unwrap();
        assert!(
            before_terminate.contains("cdp_mirror::on_exit_requested"),
            "the flush must run before children are terminated"
        );

        let telemetry = include_str!("telemetry.rs");
        let operational = telemetry
            .split("pub async fn emit_desktop_operational_telemetry(")
            .nth(1)
            .expect("operational telemetry command");
        let body = operational.split("\n}\n").next().unwrap();
        assert!(
            body.contains("cdp_mirror::note_operational_event(&event_name, properties.as_ref());"),
            "onboarding_step_shown / company_created: operational telemetry must call the mirror"
        );

        let auth = include_str!("desktop_auth.rs");
        let login = auth
            .split("async fn record_desktop_login_completed_inner<")
            .nth(1)
            .expect("login receipt inner");
        let login_body = login.split("\n}\n").next().unwrap();
        assert!(
            login_body.contains("cdp_mirror::note_login_completed("),
            "login_completed: the receipt builder must call the mirror"
        );
        let post = auth
            .split("fn post_signin_link_best_effort(")
            .nth(1)
            .expect("sign-in link post");
        let post_body = post.split("\n}\n").next().unwrap();
        assert!(
            post_body.contains("parse_link_anon_id(")
                && post_body.contains("cdp_mirror::note_signin_link_visitor(&anon_id);"),
            "install_linked: the anonId from the link completion must reach the mirror"
        );
        let start = auth
            .split("select_browser_url(")
            .nth(1)
            .expect("sign-in start URL selection");
        assert!(
            start
                .split(',')
                .nth(1)
                .unwrap()
                .contains("install_attempt_id"),
            "the sign-in start URL must carry the install id"
        );

        let first_push = include_str!("first_push.rs");
        let after_emit = first_push
            .split("EVENT_SYNC_COMPANY_FIRST_PUSH_COMPLETE,\n        SyncCompanyFirstPushCompleteEvent {")
            .nth(1)
            .expect("company first push complete emit");
        let tail = after_emit.split("\n    Ok(())").next().unwrap();
        assert!(
            tail.contains("cdp_mirror::note_first_sync_completed();"),
            "first_sync_completed: the company first push must call the mirror"
        );
    }
}
