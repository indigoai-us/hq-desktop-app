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
    EVENT_COMPANY_PROVISIONING_FAILED, EVENT_COMPANY_ROUTE_DECIDED, EVENT_COMPANY_SELF_HEAL,
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
/// `true` when `cdpAnonId` came from the installer's download URL.
pub const DOWNLOAD_URL_TAG_KEY: &str = "cdpDownloadUrlTag";
/// Unix ms of the one-time download-URL read (set whether or not it found one).
pub const DOWNLOAD_TAG_READ_AT_KEY: &str = "cdpDownloadTagReadAt";
/// `{found, source}` of that read until hq-pro accepts `install_tag_read`.
pub const INSTALL_TAG_PENDING_KEY: &str = "cdpInstallTagReadPending";
/// hq-pro operational event for the one-time read.
pub const EVENT_INSTALL_TAG_READ: &str = "install_tag_read";

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

/// What the one-time read found, as reported on `install_tag_read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagReadReport {
    pub found: bool,
    /// `whereFroms | zoneIdentifier | none`.
    pub source: &'static str,
}

impl TagReadReport {
    pub fn properties(&self) -> Value {
        json!({ "found": self.found, "source": self.source })
    }
}

/// Apply a download-URL read to menubar.json once. Returns `None` when the
/// read already happened on an earlier launch. The visitor id is written only
/// when none is stored, so a sign-in link (or an earlier read) is never
/// overwritten. Only `aid`/`src` are stored; the URL itself never is.
pub fn apply_download_tag(
    path: &std::path::Path,
    tag: Option<&hq_desktop_core::download_tag::DownloadTag>,
    now_ms: u64,
) -> Option<TagReadReport> {
    let obj = read_menubar_obj(path);
    if obj.get(DOWNLOAD_TAG_READ_AT_KEY).is_some() {
        return None;
    }
    let report = TagReadReport {
        found: tag.is_some(),
        source: tag.map(|t| t.source.label()).unwrap_or("none"),
    };
    let mut updates = vec![
        (DOWNLOAD_TAG_READ_AT_KEY, json!(now_ms)),
        (INSTALL_TAG_PENDING_KEY, report.properties()),
    ];
    let existing = obj.get(ANON_ID_KEY).and_then(Value::as_str);
    if let Some(tag) = tag.filter(|_| hq_desktop_core::download_tag::should_adopt(existing)) {
        updates.push((ANON_ID_KEY, json!(tag.anon_id)));
        updates.push((DOWNLOAD_URL_TAG_KEY, json!(true)));
        if let Some(source) = tag.install_source.as_deref() {
            updates.push((INSTALL_SOURCE_KEY, json!(source)));
        }
    }
    let _ = merge_menubar_flags(path, &updates);
    Some(report)
}

/// The stored visitor id when, and only when, it came from the download URL.
pub fn download_tag_anon_id_at(path: &std::path::Path) -> Option<String> {
    let obj = read_menubar_obj(path);
    if obj.get(DOWNLOAD_URL_TAG_KEY).and_then(Value::as_bool) != Some(true) {
        return None;
    }
    obj.get(ANON_ID_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// [`download_tag_anon_id_at`] for this machine's menubar.json.
pub fn download_tag_anon_id() -> Option<String> {
    paths::menubar_json_path()
        .ok()
        .and_then(|p| download_tag_anon_id_at(&p))
}

/// The visitor id the mirror currently tags events with, if any. hq-pro
/// desktop telemetry attaches the same id.
pub fn current_anon_id() -> Option<String> {
    mirror().and_then(|m| m.context().anon_id)
}

/// The website visitor id for this install (sign-in link or download tag), so
/// onboarding can ask hq-pro whether that visitor already made a company under
/// another account. An opaque, anonymous id; never a token.
#[tauri::command]
pub fn web_visitor_anon_id() -> Option<String> {
    current_anon_id()
        .or_else(download_tag_anon_id)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

/// Send the pending `install_tag_read` row to hq-pro; clear it on success.
/// Before sign-in there is no token and it stays pending for the next try.
pub fn flush_install_tag_report() {
    let Ok(path) = paths::menubar_json_path() else {
        return;
    };
    let Some(props) = read_menubar_obj(&path)
        .get(INSTALL_TAG_PENDING_KEY)
        .filter(|v| v.is_object())
        .cloned()
    else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let sent = super::telemetry::emit_desktop_operational_telemetry(
            EVENT_INSTALL_TAG_READ.to_string(),
            Some(props),
            None,
            None,
        )
        .await
        .is_ok();
        if sent {
            let _ = merge_menubar_flags(&path, &[(INSTALL_TAG_PENDING_KEY, Value::Null)]);
        }
    });
}

/// One-time read of the installer's download URL tag (`aid`/`src`).
fn read_download_tag_once(path: &std::path::Path) {
    if read_menubar_obj(path)
        .get(DOWNLOAD_TAG_READ_AT_KEY)
        .is_some()
    {
        return;
    }
    let tag = std::env::current_exe().ok().and_then(|exe| {
        hq_desktop_core::download_tag::discover(
            &exe,
            dirs::download_dir().as_deref(),
            std::time::SystemTime::now(),
        )
    });
    if let Some(report) = apply_download_tag(path, tag.as_ref(), now_ms()) {
        // Labels only: never the URL, and the ids only as the closed shape.
        crate::util::logfile::log(
            "cdp",
            &format!(
                "download tag read: found={} source={}",
                report.found, report.source
            ),
        );
    }
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
        Ok(path) => {
            read_download_tag_once(&path);
            load_persisted(&path, now_ms())
        }
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
    flush_install_tag_report();
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
    if let Some(self_heal) = props.get("selfHeal").and_then(Value::as_str) {
        let mut out = Map::new();
        out.insert("result".into(), json!(self_heal));
        if let Some(step) = props.get("provisioningStep").and_then(Value::as_str) {
            out.insert("provisioningStep".into(), json!(step));
        }
        return Some((EVENT_COMPANY_SELF_HEAL, out));
    }
    if step == "company" {
        if let Some(decision) = props.get("decision").and_then(Value::as_str) {
            let mut out = Map::new();
            out.insert("decision".into(), json!(decision));
            for key in ["existingCompanies", "paidCompany", "pendingInvites"] {
                if let Some(value) = props.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
            return Some((EVENT_COMPANY_ROUTE_DECIDED, out));
        }
        if action == "failed" {
            if let Some(step_name) = props.get("provisioningStep").and_then(Value::as_str) {
                let mut out = Map::new();
                out.insert("provisioningStep".into(), json!(step_name));
                return Some((EVENT_COMPANY_PROVISIONING_FAILED, out));
            }
        }
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
    flush_install_tag_report();
}

/// Hook for the sign-in link completion (`post_desktop_referral_receipt`):
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

    fn tag(aid: &str) -> hq_desktop_core::download_tag::DownloadTag {
        hq_desktop_core::download_tag::DownloadTag {
            anon_id: aid.into(),
            install_source: Some("welcome-install-arm".into()),
            source: hq_desktop_core::download_tag::TagSource::WhereFroms,
        }
    }

    #[test]
    fn download_tag_fills_an_empty_visitor_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        let report = apply_download_tag(&path, Some(&tag("vyg-dl")), 7).unwrap();
        assert_eq!(
            report,
            TagReadReport {
                found: true,
                source: "whereFroms"
            }
        );
        let (anon, source, _) = load_persisted(&path, 9);
        assert_eq!(anon.as_deref(), Some("vyg-dl"));
        assert_eq!(source.as_deref(), Some("welcome-install-arm"));
        assert_eq!(download_tag_anon_id_at(&path).as_deref(), Some("vyg-dl"));
        let obj = read_menubar_obj(&path);
        assert_eq!(obj[DOWNLOAD_TAG_READ_AT_KEY], 7);
        assert_eq!(obj[INSTALL_TAG_PENDING_KEY]["found"], true);
        // Second launch: no re-read, nothing changes.
        assert_eq!(apply_download_tag(&path, Some(&tag("vyg-other")), 8), None);
        assert_eq!(load_persisted(&path, 9).0.as_deref(), Some("vyg-dl"));
    }

    #[test]
    fn download_tag_never_overwrites_a_signin_link() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        merge_menubar_flags(
            &path,
            &[
                (ANON_ID_KEY, json!("vyg-signin")),
                (INSTALL_SOURCE_KEY, json!("email-link")),
            ],
        )
        .unwrap();
        let report = apply_download_tag(&path, Some(&tag("vyg-dl")), 7).unwrap();
        assert!(report.found);
        let (anon, source, _) = load_persisted(&path, 9);
        assert_eq!(anon.as_deref(), Some("vyg-signin"));
        assert_eq!(source.as_deref(), Some("email-link"));
        assert_eq!(download_tag_anon_id_at(&path), None);
    }

    #[test]
    fn download_tag_absent_is_reported_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        let report = apply_download_tag(&path, None, 7).unwrap();
        assert_eq!(
            report.properties(),
            json!({ "found": false, "source": "none" })
        );
        assert_eq!(load_persisted(&path, 9).0, None);
    }

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
    fn company_route_provisioning_and_self_heal_rows_mirror() {
        let route = json!({"step": "company", "action": "started", "decision": "paid_existing",
            "existingCompanies": 1, "paidCompany": true, "pendingInvites": 0});
        let (name, props) =
            mirror_for_operational_event("desktop_onboarding_step", Some(&route)).unwrap();
        assert_eq!(name, EVENT_COMPANY_ROUTE_DECIDED);
        assert_eq!(props["decision"], "paid_existing");
        assert_eq!(props["paidCompany"], true);
        assert_eq!(props["existingCompanies"], 1);

        let failed =
            json!({"step": "company", "action": "failed", "provisioningStep": "kms-create"});
        let (name, props) =
            mirror_for_operational_event("desktop_onboarding_step", Some(&failed)).unwrap();
        assert_eq!(name, EVENT_COMPANY_PROVISIONING_FAILED);
        assert_eq!(props["provisioningStep"], "kms-create");

        let heal =
            json!({"step": "first-folder-sync", "action": "started", "selfHeal": "succeeded"});
        let (name, props) =
            mirror_for_operational_event("desktop_onboarding_step", Some(&heal)).unwrap();
        assert_eq!(name, EVENT_COMPANY_SELF_HEAL);
        assert_eq!(props["result"], "succeeded");
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
            .split("async fn post_desktop_referral_receipt(")
            .nth(1)
            .expect("desktop referral post");
        let post_body = post.split("\n}\n").next().unwrap();
        assert!(
            post_body.contains("parse_referral_ack(")
                && post_body.contains("cdp_mirror::note_signin_link_visitor(anon_id)"),
            "install_linked: the anonId from the link completion must reach the mirror"
        );
        let start = auth
            .split("signin_start_url(")
            .nth(1)
            .expect("sign-in start URL selection");
        assert!(
            start
                .split(',')
                .nth(2)
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
