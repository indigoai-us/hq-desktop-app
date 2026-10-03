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
    hash_identifier, Endpoints, Mirror, MirrorContext, EVENT_ACCOUNT_LINKED,
    EVENT_AGENT_SESSION_LAUNCHED, EVENT_APP_DAILY_ACTIVE, EVENT_APP_FIRST_LAUNCH, EVENT_APP_OPENED,
    EVENT_COMPANY_CREATED, EVENT_COMPANY_JOINED, EVENT_COMPANY_PROVISIONING_FAILED,
    EVENT_COMPANY_ROUTE_DECIDED, EVENT_COMPANY_SELF_HEAL, EVENT_FIRST_SYNC_COMPLETED,
    EVENT_INVITE_FAILED, EVENT_INVITE_SENT, EVENT_LOGIN_COMPLETED, EVENT_ONBOARDING_STEP_SHOWN,
    EVENT_AUTH_FAILURE, EVENT_AUTH_PROGRESS, EVENT_PLAN_SELECTED, EVENT_SETUP_ABANDONED,
    EVENT_SYNC_COMPLETED, EVENT_SYNC_FAILED, EVENT_SYNC_STARTED, FLAG_REFRESH_INTERVAL,
};
use hq_desktop_core::first_run::{merge_menubar_flags, read_menubar_obj};
use hq_desktop_core::lifecycle::LifecycleState;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, OnceLock};
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

/// UTC day (`YYYY-MM-DD`) `app_daily_active` was last queued for.
pub const DAILY_ACTIVE_DAY_KEY: &str = "cdpDailyActiveDay";
/// `userHash|companyHash` last sent as `account_linked`, so a repeat is skipped.
pub const ACCOUNT_LINKED_KEY: &str = "cdpAccountLinked";
/// `true` while the first launch's `desktop_app_opened` row has not reached
/// hq-pro. That route needs a signed-in caller, and a first launch has none.
pub const FIRST_OPEN_PENDING_KEY: &str = "cdpFirstOpenPending";

/// hq-pro operational rows (consent-free) for the funnel events below. Each is
/// mirrored to the CDP under the unprefixed name by
/// [`mirror_for_operational_event`]. The `desktop_` prefix keeps them apart
/// from server-written journey rows (`company_joined`, `invite_failed`).
pub const OP_APP_OPENED: &str = "desktop_app_opened";
pub const OP_ACCOUNT_LINKED: &str = "desktop_account_linked";
pub const OP_AGENT_SESSION_LAUNCHED: &str = "desktop_agent_session_launched";
pub const OP_SYNC_STARTED: &str = "desktop_sync_started";
pub const OP_SYNC_COMPLETED: &str = "desktop_sync_completed";
pub const OP_SYNC_FAILED: &str = "desktop_sync_failed";
pub const OP_INVITE_SENT: &str = "desktop_invite_sent";
pub const OP_INVITE_FAILED: &str = "desktop_invite_failed";
pub const OP_COMPANY_JOINED: &str = "desktop_company_joined";
pub const OP_PLAN_SELECTED: &str = "desktop_plan_selected";
/// Sign-in funnel stages before the app has an authenticated account.
pub const OP_AUTH_PROGRESS: &str = "desktop_auth_progress";
/// Sanitized sign-in failures, never a provider response, callback code, or token.
pub const OP_AUTH_FAILURE: &str = "desktop_auth_failure";

/// `(hq-pro operational row, CDP event, props carried over)`. Telemetry tests
/// check every row name is on the operational allow-list and every prop on the
/// desktop property allow-list, so hq-pro keeps what the CDP gets.
pub const OPERATIONAL_MIRRORS: &[(&str, &str, &[&str])] = &[
    (OP_APP_OPENED, EVENT_APP_OPENED, &["isFirstLaunch"]),
    (
        OP_ACCOUNT_LINKED,
        EVENT_ACCOUNT_LINKED,
        &["userHash", "companyHash"],
    ),
    (
        OP_AGENT_SESSION_LAUNCHED,
        EVENT_AGENT_SESSION_LAUNCHED,
        &["provider", "surface", "success", "errorClass"],
    ),
    (OP_SYNC_STARTED, EVENT_SYNC_STARTED, &["trigger", "flow"]),
    (
        OP_SYNC_COMPLETED,
        EVENT_SYNC_COMPLETED,
        &["trigger", "flow", "downloadedCount"],
    ),
    (
        OP_SYNC_FAILED,
        EVENT_SYNC_FAILED,
        &["trigger", "flow", "errorClass"],
    ),
    (OP_INVITE_SENT, EVENT_INVITE_SENT, &["count"]),
    (
        OP_INVITE_FAILED,
        EVENT_INVITE_FAILED,
        &["count", "errorClass"],
    ),
    (OP_COMPANY_JOINED, EVENT_COMPANY_JOINED, &["route", "count"]),
    (OP_PLAN_SELECTED, EVENT_PLAN_SELECTED, &["plan"]),
    (
        OP_AUTH_PROGRESS,
        EVENT_AUTH_PROGRESS,
        &["provider", "step"],
    ),
    (
        OP_AUTH_FAILURE,
        EVENT_AUTH_FAILURE,
        &["provider", "step", "errorCategory"],
    ),
];

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

/// Build the mirror and start its sender, then record `app_opened` and start
/// the daily-active check. Called once from `.setup()`.
pub fn init(app: &AppHandle, is_first_launch: bool) {
    let telemetry_suppressed = std::env::var("HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED")
        .is_ok_and(|value| value == "1");
    let record_first_launch = should_record_first_launch(is_first_launch, telemetry_suppressed);
    init_mirror(app, record_first_launch);
    if record_first_launch {
        // hq-pro only accepts the row from a signed-in caller, so a first
        // launch holds it until sign-in. The CDP copy is queued now.
        note_operational_event(OP_APP_OPENED, Some(&json!({ "isFirstLaunch": true })));
        hold_first_open();
        flush_pending_first_open();
    } else {
        emit_operational(OP_APP_OPENED, json!({ "isFirstLaunch": is_first_launch }));
    }
    tauri::async_runtime::spawn(async {
        loop {
            note_daily_active_if_new_day();
            tokio::time::sleep(FLAG_REFRESH_INTERVAL).await;
        }
    });
}

fn should_record_first_launch(is_first_launch: bool, telemetry_suppressed: bool) -> bool {
    is_first_launch && !telemetry_suppressed
}

/// Without an install id there is nothing to key events on, so no mirror.
fn init_mirror(_app: &AppHandle, is_first_launch: bool) {
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
/// [`OPERATIONAL_MIRRORS`] rows map one to one. `desktop_onboarding_step`
/// with `action: "entered"` is the step being shown; the company step reports
/// creation as `outcome: "company_created"`.
pub fn mirror_for_operational_event(
    event_name: &str,
    properties: Option<&Value>,
) -> Option<(&'static str, Map<String, Value>)> {
    if let Some((_, cdp, keys)) = OPERATIONAL_MIRRORS
        .iter()
        .find(|(op, _, _)| *op == event_name)
    {
        let mut out = Map::new();
        if let Some(props) = properties.and_then(Value::as_object) {
            for key in keys.iter() {
                if let Some(value) = props.get(*key) {
                    out.insert((*key).to_string(), value.clone());
                }
            }
        }
        return Some((cdp, out));
    }
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
    note_account_linked();
    flush_pending_first_open();
}

/// Hold the first launch's `desktop_app_opened` row for
/// [`flush_pending_first_open_now`].
pub fn hold_first_open() {
    match paths::menubar_json_path() {
        Ok(path) => {
            if let Err(err) = merge_menubar_flags(&path, &[(FIRST_OPEN_PENDING_KEY, json!(true))]) {
                warn_first_open("hold_write_failed", &err);
            }
        }
        Err(err) => warn_first_open("menubar_path_unresolved", &err),
    }
}

/// Non-fatal first-open problems go to the local diagnostic log as WARN lines.
fn warn_first_open(kind: &str, err: &str) {
    crate::util::logfile::log("cdp", &format!("WARN first_open {kind}: {err}"));
}

#[cfg(test)]
pub(crate) struct FirstOpenGuardHook {
    pub reached: tokio::sync::Notify,
    pub resume: tokio::sync::Notify,
}

#[cfg(test)]
tokio::task_local! {
    /// Parks a flush between its cheap pending check and the guard, so a test
    /// can finish a second flush in that window.
    pub(crate) static FIRST_OPEN_GUARD_HOOK: std::sync::Arc<FirstOpenGuardHook>;
}

static FIRST_OPEN_FLUSHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Send the held first-launch `desktop_app_opened` row if there is one.
/// Returns whether a held row was delivered. The row stays held on failure
/// (no session yet, network), so the next sign-in sends it.
pub async fn flush_pending_first_open_now() -> bool {
    use std::sync::atomic::Ordering;
    let Ok(path) = paths::menubar_json_path() else {
        return false;
    };
    let pending = || {
        read_menubar_obj(&path)
            .get(FIRST_OPEN_PENDING_KEY)
            .and_then(Value::as_bool)
            == Some(true)
    };
    if !pending() {
        return false;
    }
    #[cfg(test)]
    if let Ok(hook) = FIRST_OPEN_GUARD_HOOK.try_with(std::sync::Arc::clone) {
        hook.reached.notify_one();
        hook.resume.notified().await;
    }
    if FIRST_OPEN_FLUSHING.swap(true, Ordering::SeqCst) {
        return false;
    }
    // Another flush may have sent and cleared the row since the check above.
    if !pending() {
        FIRST_OPEN_FLUSHING.store(false, Ordering::SeqCst);
        return false;
    }
    let sent = match super::telemetry::emit_desktop_operational_telemetry_unmirrored(
        OP_APP_OPENED,
        json!({ "isFirstLaunch": true }),
    )
    .await
    {
        Ok(()) => true,
        Err(err) => {
            warn_first_open("send_failed_held_for_retry", &err);
            false
        }
    };
    if sent {
        if let Err(err) = merge_menubar_flags(&path, &[(FIRST_OPEN_PENDING_KEY, Value::Null)]) {
            warn_first_open("clear_write_failed", &err);
        }
    }
    FIRST_OPEN_FLUSHING.store(false, Ordering::SeqCst);
    sent
}

/// `idempotencyKey` for the first launch's `desktop_app_opened` row: one per
/// install, so hq-pro stores a repeated send once.
pub fn first_open_idempotency_key(install_attempt_id: &str) -> String {
    format!("hq-desktop-app:first-open:{install_attempt_id}")
}

fn flush_pending_first_open() {
    tauri::async_runtime::spawn(async {
        flush_pending_first_open_now().await;
    });
}

/// Send one consent-free hq-pro row; `emit_desktop_operational_telemetry`
/// mirrors it to the CDP first, so the CDP copy does not wait on sign-in.
fn emit_operational(event_name: &'static str, properties: Value) {
    super::telemetry::emit_desktop_operational_telemetry_best_effort(event_name, properties);
}

/// `account_linked` props: sha256 hex of the person uid (required) and of the
/// company uid when known. Never the raw ids, never an email.
pub fn account_linked_props(person_uid: Option<&str>, company_uid: Option<&str>) -> Option<Value> {
    let user = person_uid.and_then(hash_identifier)?;
    let mut props = Map::new();
    props.insert("userHash".into(), json!(user));
    if let Some(company) = company_uid.and_then(hash_identifier) {
        props.insert("companyHash".into(), json!(company));
    }
    Some(Value::Object(props))
}

/// Dedupe key for [`account_linked_props`] output.
fn account_linked_key(props: &Value) -> String {
    format!(
        "{}|{}",
        props["userHash"].as_str().unwrap_or(""),
        props["companyHash"].as_str().unwrap_or("")
    )
}

/// Whether `props` differs from what was last sent from this machine; records
/// it as sent when it does.
pub fn claim_account_linked_at(path: &std::path::Path, props: &Value) -> bool {
    let key = account_linked_key(props);
    if read_menubar_obj(path)
        .get(ACCOUNT_LINKED_KEY)
        .and_then(Value::as_str)
        == Some(key.as_str())
    {
        return false;
    }
    let _ = merge_menubar_flags(path, &[(ACCOUNT_LINKED_KEY, json!(key))]);
    true
}

/// The company for `account_linked`: the uid the caller knows, else
/// `config.json`'s company when it is a real company (the personal-vault
/// reconstruction stores the person uid there), else the HQ manifest's `cmp_`
/// uid when it holds exactly one. The desktop onboarding does not write
/// `config.json`, so without the last two steps a desktop-only person never
/// gets a company. With several companies in the manifest there is no way to
/// tell which one the link belongs to, so none is sent and the first-push hook
/// names the company.
pub fn account_linked_company(
    explicit: Option<&str>,
    config_company: Option<&str>,
    person: Option<&str>,
    manifest_uids: &[String],
) -> Option<String> {
    let real = |uid: &&str| uid.starts_with("cmp_") && Some(*uid) != person;
    explicit
        .map(str::trim)
        .filter(real)
        .or_else(|| config_company.map(str::trim).filter(real))
        .or_else(|| {
            let mut companies: Vec<&str> = manifest_uids
                .iter()
                .map(String::as_str)
                .filter(real)
                .collect();
            companies.sort_unstable();
            companies.dedup();
            match companies.as_slice() {
                [only] => Some(*only),
                _ => None,
            }
        })
        .map(str::to_string)
}

/// `cmp_` cloud uids recorded in `<hq_root>/companies/manifest.yaml`.
pub fn manifest_company_uids(hq_root: &std::path::Path) -> Vec<String> {
    match hq_desktop_core::workspaces::read_manifest(hq_root) {
        hq_desktop_core::workspaces::ManifestLoad::Present(entries) => entries
            .into_iter()
            .filter_map(|entry| entry.cloud_uid)
            .filter(|uid| uid.starts_with("cmp_"))
            .collect(),
        _ => Vec::new(),
    }
}

/// Send `account_linked` for the signed-in person and their company when one
/// is known. Called after sign-in, after the first-launch sync, and after a
/// company's first push (with that company's uid); the same pair is sent once.
pub fn note_account_linked() {
    note_account_linked_for(None);
}

fn note_account_linked_for(explicit_company: Option<String>) {
    tauri::async_runtime::spawn(async move {
        let config = hq_desktop_core::config::read_hq_config_lenient()
            .ok()
            .flatten();
        let nonempty = |v: String| Some(v).filter(|v| !v.trim().is_empty());
        let mut person = config.as_ref().and_then(|c| nonempty(c.person_uid.clone()));
        if person.is_none() {
            if let (Ok(token), Ok(api)) = (
                super::cognito::get_valid_access_token().await,
                super::sync::resolve_vault_api_url(),
            ) {
                person = super::dm_notify::fetch_person_uid_from_vault(&api, &token).await;
            }
        }
        let manifest_uids = hq_desktop_core::workspaces::resolve_hq_folder_path()
            .map(|root| manifest_company_uids(&root))
            .unwrap_or_default();
        let company = account_linked_company(
            explicit_company.as_deref(),
            config.as_ref().map(|c| c.company_uid.as_str()),
            person.as_deref(),
            &manifest_uids,
        );
        let Some(props) = account_linked_props(person.as_deref(), company.as_deref()) else {
            return;
        };
        let Ok(path) = paths::menubar_json_path() else {
            return;
        };
        if claim_account_linked_at(&path, &props) {
            emit_operational(OP_ACCOUNT_LINKED, props);
        }
    });
}

/// Whether `app_daily_active` is due: the stored day is not `today`.
pub fn daily_active_due(stored_day: Option<&str>, today: &str) -> bool {
    stored_day != Some(today)
}

/// Queue `app_daily_active` once per UTC day. Runs at launch and every
/// [`FLAG_REFRESH_INTERVAL`], so a long-running app reports each day it is up.
pub fn note_daily_active_if_new_day() {
    let Some(mirror) = mirror() else {
        return;
    };
    if !mirror.accepts_events() {
        return;
    }
    let Ok(path) = paths::menubar_json_path() else {
        return;
    };
    let today = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let stored = read_menubar_obj(&path)
        .get(DAILY_ACTIVE_DAY_KEY)
        .and_then(Value::as_str)
        .map(str::to_owned);
    if !daily_active_due(stored.as_deref(), &today) {
        return;
    }
    mirror.record(EVENT_APP_DAILY_ACTIVE, Map::new());
    let _ = merge_menubar_flags(&path, &[(DAILY_ACTIVE_DAY_KEY, json!(today))]);
}

/// Closed error class for a failed agent launch. Never the raw message.
pub fn agent_launch_error_class(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("unsupported cli tool") {
        "unsupported_tool"
    } else if lower.contains("does not exist")
        || lower.contains("not found")
        || lower.contains("no such file")
    {
        "not_found"
    } else if lower.contains("(exit ") {
        "exit_nonzero"
    } else if lower.contains("failed to run") || lower.contains("failed to spawn") {
        "spawn_failed"
    } else {
        "unknown"
    }
}

/// `agent_session_launched` props for one launch attempt.
pub fn agent_session_props(provider: &str, surface: &str, result: &Result<(), String>) -> Value {
    let mut props = json!({
        "provider": provider,
        "surface": surface,
        "success": result.is_ok(),
    });
    if let Err(error) = result {
        props["errorClass"] = json!(agent_launch_error_class(error));
    }
    props
}

/// Hook for the agent launch commands in `launch.rs`.
pub fn note_agent_session_launched(provider: &str, surface: &str, result: &Result<(), String>) {
    emit_operational(
        OP_AGENT_SESSION_LAUNCHED,
        agent_session_props(provider, surface, result),
    );
}

/// What started a sync pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTrigger {
    /// The person pressed Sync (any window).
    Manual,
    /// Sync-on-launch or a client-repair retry.
    Auto,
    /// The first pass after setup.
    First,
}

impl SyncTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncTrigger::Manual => "manual",
            SyncTrigger::Auto => "auto",
            SyncTrigger::First => "first",
        }
    }
}

/// The runner pass in flight (one at a time): its trigger and, once the
/// runner reports `all-complete`, the file count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SyncInFlight {
    trigger: SyncTrigger,
    file_count: Option<u64>,
}

static SYNC_IN_FLIGHT: Mutex<Option<SyncInFlight>> = Mutex::new(None);

fn sync_in_flight() -> std::sync::MutexGuard<'static, Option<SyncInFlight>> {
    SYNC_IN_FLIGHT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `sync_started`. `flow` is `runner` (this app spawned the pass and will see
/// it end) or `daemon` (the HQ daemon owns the pass; its end is not observed).
pub fn note_sync_started(trigger: SyncTrigger, flow: &'static str) {
    if flow == "runner" {
        *sync_in_flight() = Some(SyncInFlight {
            trigger,
            file_count: None,
        });
    }
    emit_operational(
        OP_SYNC_STARTED,
        json!({ "trigger": trigger.as_str(), "flow": flow }),
    );
}

/// The runner's `all-complete` payload: remember the file count for the end row.
pub fn note_sync_files(files_downloaded: u32) {
    if let Some(in_flight) = sync_in_flight().as_mut() {
        in_flight.file_count = Some(u64::from(files_downloaded));
    }
}

/// End row for a runner pass: `sync_completed` when `error_class` is `None`,
/// else `sync_failed`. `None` when no pass was in flight.
pub fn sync_end_event(
    in_flight: Option<(SyncTrigger, Option<u64>)>,
    error_class: Option<&str>,
) -> Option<(&'static str, Value)> {
    let (trigger, file_count) = in_flight?;
    let mut props = json!({ "trigger": trigger.as_str(), "flow": "runner" });
    match error_class {
        None => {
            if let Some(count) = file_count {
                props["downloadedCount"] = json!(count);
            }
            Some((OP_SYNC_COMPLETED, props))
        }
        Some(class) => {
            props["errorClass"] = json!(class);
            Some((OP_SYNC_FAILED, props))
        }
    }
}

/// Hook for the runner's terminal seam (`record_sync_run_ended` call sites).
pub fn note_sync_ended(error_class: Option<&str>) {
    let in_flight = sync_in_flight().take().map(|f| (f.trigger, f.file_count));
    let links_account = sync_end_links_account(in_flight.map(|f| f.0), error_class);
    if let Some((name, props)) = sync_end_event(in_flight, error_class) {
        emit_operational(name, props);
    }
    if links_account {
        note_account_linked();
    }
}

/// A successful first-launch sync has put the person's companies in the
/// manifest, so `account_linked` can carry a company now.
pub fn sync_end_links_account(trigger: Option<SyncTrigger>, error_class: Option<&str>) -> bool {
    trigger == Some(SyncTrigger::First) && error_class.is_none()
}

/// `start_sync` returned an error after the pass was registered (a preflight
/// refused it before the runner spawned).
pub fn note_sync_start_failed() {
    note_sync_ended(Some("preflight_failed"));
}

/// Closed `route` for `company_joined`.
pub fn company_join_route(route: Option<&str>) -> &'static str {
    match route.map(str::trim) {
        Some("onboarding") => "onboarding",
        Some("company_page") => "company_page",
        _ => "unknown",
    }
}

/// Hook for `claim_pending_company_invite` when it joined at least one company.
pub fn note_company_joined(route: Option<&str>, count: usize) {
    if count == 0 {
        return;
    }
    emit_operational(
        OP_COMPANY_JOINED,
        json!({ "route": company_join_route(route), "count": count }),
    );
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

/// Hook for the company first push completing; `account_linked` gets that
/// company's hash.
pub fn note_first_sync_completed(company_uid: &str) {
    record(EVENT_FIRST_SYNC_COMPLETED, Map::new());
    note_account_linked_for(Some(company_uid.to_string()));
}

/// hq-pro funnel rows from [`OPERATIONAL_MIRRORS`]; each carries `appVersion`.
pub fn is_funnel_operational_row(event_name: &str) -> bool {
    OPERATIONAL_MIRRORS
        .iter()
        .any(|(op, _, _)| *op == event_name)
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
    fn ci_suppression_skips_only_the_first_launch_mirror_event() {
        assert!(should_record_first_launch(true, false));
        assert!(!should_record_first_launch(true, true));
        assert!(!should_record_first_launch(false, false));
        assert!(!should_record_first_launch(false, true));
    }

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

    #[test]
    fn funnel_rows_mirror_one_to_one_with_only_their_props() {
        let cases = [
            (
                OP_APP_OPENED,
                EVENT_APP_OPENED,
                json!({"isFirstLaunch": false, "email": "x@y.z"}),
            ),
            (
                OP_ACCOUNT_LINKED,
                EVENT_ACCOUNT_LINKED,
                json!({"userHash": "ab", "companyHash": "cd", "personUid": "prs_1"}),
            ),
            (
                OP_AGENT_SESSION_LAUNCHED,
                EVENT_AGENT_SESSION_LAUNCHED,
                json!({"provider": "codex", "surface": "codex_app", "success": false, "errorClass": "not_found", "path": "/Users/x"}),
            ),
            (
                OP_SYNC_STARTED,
                EVENT_SYNC_STARTED,
                json!({"trigger": "manual", "flow": "runner"}),
            ),
            (
                OP_SYNC_COMPLETED,
                EVENT_SYNC_COMPLETED,
                json!({"trigger": "auto", "flow": "runner", "downloadedCount": 3}),
            ),
            (
                OP_SYNC_FAILED,
                EVENT_SYNC_FAILED,
                json!({"trigger": "first", "flow": "runner", "errorClass": "auth_expired"}),
            ),
            (
                OP_INVITE_SENT,
                EVENT_INVITE_SENT,
                json!({"count": 1, "inviteeEmail": "a@b.c"}),
            ),
            (
                OP_INVITE_FAILED,
                EVENT_INVITE_FAILED,
                json!({"count": 1, "errorClass": "plan_limit"}),
            ),
            (
                OP_COMPANY_JOINED,
                EVENT_COMPANY_JOINED,
                json!({"route": "onboarding", "count": 2}),
            ),
            (
                OP_PLAN_SELECTED,
                EVENT_PLAN_SELECTED,
                json!({"plan": "workforce"}),
            ),
            (
                OP_AUTH_PROGRESS,
                EVENT_AUTH_PROGRESS,
                json!({"provider": "google", "step": "callback_received", "code": "secret"}),
            ),
            (
                OP_AUTH_FAILURE,
                EVENT_AUTH_FAILURE,
                json!({"provider": "google", "step": "provider_page_opened", "errorCategory": "network", "message": "secret"}),
            ),
        ];
        assert_eq!(cases.len(), OPERATIONAL_MIRRORS.len());
        for (op, cdp, props) in cases {
            let (name, out) = mirror_for_operational_event(op, Some(&props)).unwrap();
            assert_eq!(name, cdp, "{op}");
            let (_, _, keys) = OPERATIONAL_MIRRORS
                .iter()
                .find(|(o, _, _)| *o == op)
                .unwrap();
            for key in out.keys() {
                assert!(keys.contains(&key.as_str()), "{op} leaked {key}");
            }
            for key in ["email", "personUid", "inviteeEmail", "path"] {
                assert!(out.get(key).is_none(), "{op} carried {key}");
            }
        }
        let (_, out) = mirror_for_operational_event(OP_INVITE_SENT, None).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn account_linked_carries_only_hashes() {
        let props = account_linked_props(Some("prs_01ABC"), Some("cmp_01XYZ")).unwrap();
        let text = props.to_string();
        assert!(!text.contains("prs_01ABC") && !text.contains("cmp_01XYZ"));
        assert_eq!(props["userHash"], hash_identifier("prs_01ABC").unwrap());
        assert_eq!(props["companyHash"], hash_identifier("cmp_01XYZ").unwrap());
        let person_only = account_linked_props(Some("prs_01ABC"), Some(" ")).unwrap();
        assert!(person_only.get("companyHash").is_none());
        assert!(account_linked_props(None, Some("cmp_01XYZ")).is_none());
        assert!(account_linked_props(Some(""), None).is_none());
    }

    #[test]
    fn account_linked_is_sent_once_per_person_company_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        let person = account_linked_props(Some("prs_1"), None).unwrap();
        assert!(claim_account_linked_at(&path, &person));
        assert!(!claim_account_linked_at(&path, &person), "repeat sign-in");
        let with_company = account_linked_props(Some("prs_1"), Some("cmp_1")).unwrap();
        assert!(
            claim_account_linked_at(&path, &with_company),
            "company now known"
        );
        assert!(!claim_account_linked_at(&path, &with_company));
    }

    #[test]
    fn account_linked_company_comes_from_the_known_company_not_config_json() {
        // Regression: the company came only from ~/.hq/config.json, which the
        // desktop onboarding never writes, so companyHash was never sent.
        let person = Some("prs_1");
        assert_eq!(
            account_linked_company(Some("cmp_new"), None, person, &[]).as_deref(),
            Some("cmp_new"),
            "first push passes the pushed company"
        );
        assert_eq!(
            account_linked_company(None, Some("prs_1"), person, &[]),
            None,
            "the personal-vault reconstruction stores the person uid as company"
        );
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("companies")).unwrap();
        std::fs::write(
            dir.path().join("companies/manifest.yaml"),
            "companies:\n  personal:\n    cloud_uid: prs_1\n  acme:\n    cloud_uid: cmp_acme\n",
        )
        .unwrap();
        let manifest = manifest_company_uids(dir.path());
        assert_eq!(manifest, vec!["cmp_acme".to_string()]);
        assert_eq!(
            account_linked_company(None, Some("prs_1"), person, &manifest).as_deref(),
            Some("cmp_acme"),
            "after the first-launch sync the manifest names the company"
        );
        let props = account_linked_props(person, Some("cmp_acme")).unwrap();
        assert_eq!(props["companyHash"], hash_identifier("cmp_acme").unwrap());
    }

    #[test]
    fn account_linked_company_is_unknown_when_the_manifest_holds_several_companies() {
        // Regression: the first manifest company was credited with the link, so
        // a person in two companies linked the wrong one and then sent a second
        // account_linked with a different companyHash after first push.
        let person = Some("prs_1");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("companies")).unwrap();
        std::fs::write(
            dir.path().join("companies/manifest.yaml"),
            "companies:\n  personal:\n    cloud_uid: prs_1\n  acme:\n    cloud_uid: cmp_acme\n  beta:\n    cloud_uid: cmp_beta\n",
        )
        .unwrap();
        let manifest = manifest_company_uids(dir.path());
        assert_eq!(manifest.len(), 2);
        assert_eq!(
            account_linked_company(None, Some("prs_1"), person, &manifest),
            None,
            "two companies: leave the company to the first-push hook"
        );
        assert_eq!(
            account_linked_company(Some("cmp_beta"), None, person, &manifest).as_deref(),
            Some("cmp_beta"),
            "first push still names its company"
        );
        let props = account_linked_props(person, None).unwrap();
        assert!(props.get("companyHash").is_none());
    }

    #[test]
    fn only_a_successful_first_launch_sync_links_the_account() {
        assert!(sync_end_links_account(Some(SyncTrigger::First), None));
        assert!(!sync_end_links_account(
            Some(SyncTrigger::First),
            Some("auth_expired")
        ));
        assert!(!sync_end_links_account(Some(SyncTrigger::Manual), None));
        assert!(!sync_end_links_account(None, None));
    }

    #[test]
    fn daily_active_is_due_once_per_utc_day() {
        assert!(daily_active_due(None, "2026-10-02"));
        assert!(daily_active_due(Some("2026-10-01"), "2026-10-02"));
        assert!(!daily_active_due(Some("2026-10-02"), "2026-10-02"));
    }

    #[test]
    fn agent_launch_props_and_closed_error_classes() {
        let ok = agent_session_props("claude", "terminal", &Ok(()));
        assert_eq!(
            ok,
            json!({"provider": "claude", "surface": "terminal", "success": true})
        );
        let failed = agent_session_props(
            "codex",
            "codex_app",
            &Err("workspace folder does not exist: /Users/someone/hq".into()),
        );
        assert_eq!(failed["success"], false);
        assert_eq!(failed["errorClass"], "not_found");
        assert!(!failed.to_string().contains("/Users/someone"));
        for (message, class) in [
            ("Unsupported CLI tool: vim", "unsupported_tool"),
            ("codex app failed (exit 2): boom", "exit_nonzero"),
            ("osascript failed (exit 1): denied", "exit_nonzero"),
            (
                "failed to run codex app: No such file or directory",
                "not_found",
            ),
            ("Failed to spawn osascript: busy", "spawn_failed"),
            ("something else", "unknown"),
        ] {
            assert_eq!(agent_launch_error_class(message), class, "{message}");
        }
    }

    #[test]
    fn sync_end_rows_follow_the_in_flight_pass() {
        assert!(sync_end_event(None, None).is_none(), "no pass in flight");
        let (name, props) = sync_end_event(Some((SyncTrigger::Manual, Some(12))), None).unwrap();
        assert_eq!(name, OP_SYNC_COMPLETED);
        assert_eq!(
            props,
            json!({"trigger": "manual", "flow": "runner", "downloadedCount": 12})
        );
        let (name, props) =
            sync_end_event(Some((SyncTrigger::First, None)), Some("auth_expired")).unwrap();
        assert_eq!(name, OP_SYNC_FAILED);
        assert_eq!(
            props,
            json!({"trigger": "first", "flow": "runner", "errorClass": "auth_expired"})
        );
        assert_eq!(SyncTrigger::Auto.as_str(), "auto");
    }

    #[test]
    fn sync_in_flight_is_taken_exactly_once() {
        *sync_in_flight() = Some(SyncInFlight {
            trigger: SyncTrigger::Auto,
            file_count: None,
        });
        note_sync_files(4);
        let taken = sync_in_flight().take();
        assert_eq!(
            taken,
            Some(SyncInFlight {
                trigger: SyncTrigger::Auto,
                file_count: Some(4)
            })
        );
        assert!(sync_in_flight().take().is_none());
    }

    #[test]
    fn company_join_route_is_closed() {
        assert_eq!(company_join_route(Some("onboarding")), "onboarding");
        assert_eq!(company_join_route(Some("company_page")), "company_page");
        assert_eq!(company_join_route(Some("/Users/x")), "unknown");
        assert_eq!(company_join_route(None), "unknown");
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
            tail.contains("cdp_mirror::note_first_sync_completed(&company.uid);"),
            "first_sync_completed: the company first push must call the mirror"
        );

        let this = include_str!("cdp_mirror.rs");
        let init_body = this
            .split("pub fn init(app: &AppHandle, is_first_launch: bool) {")
            .nth(1)
            .expect("init")
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(
            init_body.contains("emit_operational(OP_APP_OPENED"),
            "app_opened: every launch must emit it from init"
        );
        assert!(
            init_body.contains("note_daily_active_if_new_day();"),
            "app_daily_active: init must start the daily check"
        );

        let launch = include_str!("launch.rs");
        for command in [
            "pub fn launch_claude_code(path: String) -> Result<(), String> {",
            "pub fn launch_cli_in_terminal(path: String, tool: String) -> Result<(), String> {",
            "pub fn launch_codex_workspace(path: String, prompt: Option<String>) -> Result<(), String> {",
        ] {
            let bodies: Vec<_> = launch.split(command).skip(1).collect();
            assert!(!bodies.is_empty(), "{command} missing");
            for body in bodies {
                let body = body.split("\n}\n").next().unwrap();
                assert!(
                    body.contains("cdp_mirror::note_agent_session_launched("),
                    "agent_session_launched: {command} must report the launch"
                );
            }
        }

        let sync = include_str!("sync.rs");
        let register = sync
            .split("let Some(sync_generation) = try_register_handle_gen(SYNC_HANDLE) else {")
            .nth(1)
            .expect("sync handle registration");
        let after_register = register.split("};").nth(1).unwrap();
        assert!(
            after_register.trim_start().starts_with(
                "crate::commands::cdp_mirror::note_sync_started(trigger, \"runner\");"
            ),
            "sync_started: must follow the handle registration"
        );
        assert_eq!(
            sync.matches("crate::commands::client_health::record_sync_run_ended(")
                .count(),
            sync.matches("crate::commands::cdp_mirror::note_sync_ended(")
                .count(),
            "sync_completed/sync_failed: every runner end seam reports the pass"
        );
        assert!(
            sync.contains(
                "crate::commands::cdp_mirror::note_sync_files(payload.files_downloaded);"
            ),
            "sync_completed: all-complete must carry the file count"
        );

        let workspaces = include_str!("workspaces.rs");
        assert!(
            workspaces.contains("crate::commands::cdp_mirror::note_company_joined("),
            "company_joined: the invite claim must report the join"
        );
    }
}
