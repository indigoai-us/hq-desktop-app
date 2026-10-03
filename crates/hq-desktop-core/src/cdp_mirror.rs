//! Mirror desktop onboarding events to the vyg CDP (`cdp.vyg.app`).
//!
//! The website already mirrors every funnel event to the CDP through the web
//! pixel (`https://cdp.vyg.app/cdp/vyg.js`). This module posts the same wire
//! format from the desktop app so one visitor can be followed from a page view
//! to `first_sync_completed`:
//!
//! - `POST https://cdp.vyg.app/cdp/ingest` with the Unomi `context.json`
//!   envelope the pixel builds: `{source, sessionId, profileId, events}`; each
//!   event is `{eventType, scope, properties, timeStamp, target?}`.
//! - The ingest proxy is credential-free but Origin-locked and scope-bound, so
//!   every request carries `Origin: https://hqforwork.com` and every
//!   tenancy-bearing `scope` is `hqforwork.com`, exactly like the website pixel.
//! - The visitor id is the pixel's `__vyg_aid` (`vyg-<uuid>`), carried in
//!   `profileId`, `properties.ids.{vyg_aid,vygAid}`, and
//!   `target.properties.vygAid`. The desktop learns it from the sign-in link
//!   completion (`POST /api/desktop/signin-link` answers `{"anonId"}`): the
//!   browser hop through `/api/desktop/signin-start?install=<id>` is the only
//!   request that carries the website's `hq_install_aid` cookie, so the app
//!   makes no handshake request of its own.
//!
//! Contract: fail silent, bounded in-memory queue (drops oldest), one retry at
//! most, 2 s per request, never on the UI thread, and nothing leaves the
//! process while the `desktop.cdp-mirror` public hq-flag is off. The flag is
//! re-resolved every [`FLAG_REFRESH_INTERVAL`], so flipping it takes effect
//! without a relaunch. No email, name, or token ever enters a payload — see
//! [`sanitize_props`]. Account ids leave only as [`hash_identifier`] output.

use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// Where the website pixel posts; the desktop mirror posts to the same URL.
pub const INGEST_URL: &str = "https://cdp.vyg.app/cdp/ingest";
/// The pixel's `data-site-key` on hqforwork.com: the CDP scope for every row.
pub const SITE_KEY: &str = "hqforwork.com";
/// The ingest proxy binds `scope` to the requesting Origin.
pub const ORIGIN: &str = "https://hqforwork.com";
/// hq-pro's anonymous flag resolver (the same one the website uses for
/// `welcome.desktop-signin-link` on behalf of hq-desktop-app #1211).
pub const FLAG_RESOLVE_URL: &str = "https://hqapi.hq.computer/v1/flags/resolve-public";
/// Public hq-flags key gating the whole mirror. Default off.
pub const FLAG_KEY: &str = "desktop.cdp-mirror";
/// How often the sender re-resolves [`FLAG_KEY`] (matches the version
/// heartbeat cadence).
pub const FLAG_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Per-request budget. The pixel's own retries are 250 ms-based; we allow one.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(2);
/// Events held in memory before the oldest is dropped.
pub const QUEUE_CAPACITY: usize = 64;
/// The proxy rejects bodies over 64 KB with 413 before parsing.
pub const MAX_BODY_BYTES: usize = 65_536;
/// Longest string kept in any property (matches lib/cdp-track.ts).
pub const MAX_PROP_LENGTH: usize = 300;

/// Event names mirrored. Same names as the hq-pro desktop telemetry rows.
pub const EVENT_APP_FIRST_LAUNCH: &str = "app_first_launch";
pub const EVENT_ONBOARDING_STEP_SHOWN: &str = "onboarding_step_shown";
pub const EVENT_LOGIN_COMPLETED: &str = "login_completed";
pub const EVENT_COMPANY_CREATED: &str = "company_created";
pub const EVENT_FIRST_SYNC_COMPLETED: &str = "first_sync_completed";
pub const EVENT_SETUP_ABANDONED: &str = "setup_abandoned";
pub const EVENT_INSTALL_LINKED: &str = "install_linked";
/// Company step looked before creating: which route it took.
pub const EVENT_COMPANY_ROUTE_DECIDED: &str = "company_route_decided";
/// Company provisioning failed (with the step) during onboarding.
pub const EVENT_COMPANY_PROVISIONING_FAILED: &str = "company_provisioning_failed";
/// First sync found a company with no bucket and asked hq-pro to finish it.
pub const EVENT_COMPANY_SELF_HEAL: &str = "company_self_heal";
/// Every launch, first or not.
pub const EVENT_APP_OPENED: &str = "app_opened";
/// Once per UTC day the app runs (mirrors hq-pro `desktop_app_daily_active`).
pub const EVENT_APP_DAILY_ACTIVE: &str = "app_daily_active";
/// Sign-in completed: joins this visitor to hashed person/company uids.
pub const EVENT_ACCOUNT_LINKED: &str = "account_linked";
/// The app launched a Claude, Codex, or Grok session.
pub const EVENT_AGENT_SESSION_LAUNCHED: &str = "agent_session_launched";
pub const EVENT_SYNC_STARTED: &str = "sync_started";
pub const EVENT_SYNC_COMPLETED: &str = "sync_completed";
pub const EVENT_SYNC_FAILED: &str = "sync_failed";
pub const EVENT_INVITE_SENT: &str = "invite_sent";
pub const EVENT_INVITE_FAILED: &str = "invite_failed";
/// A pending invite was accepted from the app.
pub const EVENT_COMPANY_JOINED: &str = "company_joined";
/// A plan was chosen in the onboarding company step.
pub const EVENT_PLAN_SELECTED: &str = "plan_selected";
/// A pre-auth desktop sign-in stage for the download-to-login funnel.
pub const EVENT_AUTH_PROGRESS: &str = "auth_progress";
/// A pre-auth desktop sign-in failure with only a closed error category.
pub const EVENT_AUTH_FAILURE: &str = "auth_failure";

/// Lowercase sha256 hex of a trimmed identifier, or `None` when it is empty.
/// The only form in which a person or company uid may reach the CDP: hq-pro
/// holds the raw uid and can compute the same digest to join rows.
pub fn hash_identifier(raw: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("{:x}", Sha256::digest(trimmed.as_bytes())))
}

/// What every mirrored event carries. Assembled once at startup by the app and
/// updated when the sign-in link completion returns the visitor id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorContext {
    pub app_version: String,
    pub os_version: String,
    /// `arm64` or `x86_64`.
    pub chip: String,
    /// The installation attempt id (UUID v4) shared with hq-pro receipts.
    pub install_id: String,
    /// `welcome-install-arm | welcome-signin | email-link | direct`, from the
    /// website when it reports one. Unknown until then.
    pub install_source: Option<String>,
    /// Unix milliseconds of the first launch, persisted so
    /// `secondsSinceFirstLaunch` survives a relaunch.
    pub first_launch_at_ms: u64,
    /// The website visitor id (`vyg-<uuid>`) once known.
    pub anon_id: Option<String>,
}

/// One mirrored event, captured at the call site with its own timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorEvent {
    pub name: String,
    pub props: Map<String, Value>,
    /// RFC 3339 with milliseconds, UTC.
    pub occurred_at: String,
    pub seconds_since_first_launch: u64,
}

/// Property keys that must never reach the CDP from the desktop, whatever a
/// call site passes. Substring match, case-insensitive.
const DENIED_PROP_FRAGMENTS: &[&str] = &[
    "email",
    "name",
    "token",
    "password",
    "secret",
    "authorization",
    "bearer",
    "phone",
    "cookie",
    "jwt",
    "person",
    "account",
];

/// Drop PII-shaped keys, empty values, and over-long strings. Pure.
pub fn sanitize_props(props: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in props {
        let lower = key.to_ascii_lowercase();
        if DENIED_PROP_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment))
        {
            continue;
        }
        let bounded = match value {
            Value::Null => continue,
            Value::String(s) if s.is_empty() => continue,
            Value::String(s) => Value::String(s.chars().take(MAX_PROP_LENGTH).collect()),
            Value::Object(_) | Value::Array(_) => continue,
            other => other,
        };
        out.insert(key, bounded);
    }
    out
}

/// Bounded FIFO: when full, the oldest event is dropped to make room.
#[derive(Debug)]
pub struct BoundedQueue {
    items: VecDeque<MirrorEvent>,
    capacity: usize,
    dropped: u64,
}

impl BoundedQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            items: VecDeque::with_capacity(capacity.min(QUEUE_CAPACITY)),
            capacity: capacity.max(1),
            dropped: 0,
        }
    }

    /// Push one event, evicting the oldest when at capacity. Returns whether an
    /// older event was dropped.
    pub fn push(&mut self, event: MirrorEvent) -> bool {
        let mut dropped = false;
        while self.items.len() >= self.capacity {
            self.items.pop_front();
            self.dropped += 1;
            dropped = true;
        }
        self.items.push_back(event);
        dropped
    }

    pub fn drain(&mut self) -> Vec<MirrorEvent> {
        self.items.drain(..).collect()
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

fn user_agent(ctx: &MirrorContext) -> String {
    let os = if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    format!(
        "HQ-Desktop/{} ({} {}; {})",
        ctx.app_version, os, ctx.os_version, ctx.chip
    )
}

/// The Unomi `target` block the pixel attaches when it knows the visitor id.
fn anonymous_target(anon_id: &str) -> Value {
    json!({
        "itemId": "anonymous",
        "itemType": "customer",
        "scope": SITE_KEY,
        "properties": { "vygAid": anon_id, "shopDomain": SITE_KEY },
    })
}

/// Build one event in the pixel's `track` shape (see `m()` in vyg.js).
pub fn build_event(ctx: &MirrorContext, event: &MirrorEvent) -> Value {
    let mut properties = sanitize_props(event.props.clone());
    properties.insert("appVersion".into(), json!(ctx.app_version));
    properties.insert("osVersion".into(), json!(ctx.os_version));
    properties.insert("chip".into(), json!(ctx.chip));
    properties.insert("installId".into(), json!(ctx.install_id));
    if let Some(source) = ctx.install_source.as_deref() {
        properties.insert("installSource".into(), json!(source));
    }
    properties.insert(
        "secondsSinceFirstLaunch".into(),
        json!(event.seconds_since_first_launch),
    );
    properties.insert("platform".into(), json!("desktop"));
    properties.insert("integration".into(), json!("desktop"));
    properties.insert("source".into(), json!("hq-desktop-app"));
    properties.insert("lookupId".into(), json!(SITE_KEY));
    properties.insert("userAgent".into(), json!(user_agent(ctx)));
    properties.insert("messageId".into(), json!(uuid::Uuid::new_v4().to_string()));
    if let Some(anon) = ctx.anon_id.as_deref() {
        properties.insert("anonId".into(), json!(anon));
        properties.insert("ids".into(), json!({ "vyg_aid": anon, "vygAid": anon }));
    }
    let mut out = json!({
        "eventType": event.name,
        "scope": SITE_KEY,
        "properties": Value::Object(properties),
        "timeStamp": event.occurred_at,
    });
    if let Some(anon) = ctx.anon_id.as_deref() {
        out["target"] = anonymous_target(anon);
    }
    out
}

/// Build the ingest envelope (see `T()` in vyg.js).
pub fn build_payload(ctx: &MirrorContext, session_id: &str, events: &[MirrorEvent]) -> Value {
    let profile = ctx.anon_id.clone();
    let mut payload = json!({
        "source": {
            "itemId": profile.clone().unwrap_or_else(|| ctx.install_id.clone()),
            "itemType": "web-pixel",
            "scope": SITE_KEY,
        },
        "sessionId": session_id,
        "events": events.iter().map(|e| build_event(ctx, e)).collect::<Vec<_>>(),
    });
    if let Some(anon) = profile {
        payload["profileId"] = json!(anon);
    }
    payload
}

/// Split events so no serialized payload exceeds [`MAX_BODY_BYTES`]. An event
/// that alone exceeds the cap is dropped.
pub fn chunk_payloads(
    ctx: &MirrorContext,
    session_id: &str,
    events: &[MirrorEvent],
) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<MirrorEvent> = Vec::new();
    for event in events {
        let mut candidate = current.clone();
        candidate.push(event.clone());
        let body = build_payload(ctx, session_id, &candidate).to_string();
        if body.len() <= MAX_BODY_BYTES {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            out.push(build_payload(ctx, session_id, &current).to_string());
        }
        let alone = build_payload(ctx, session_id, std::slice::from_ref(event)).to_string();
        current = if alone.len() <= MAX_BODY_BYTES {
            vec![event.clone()]
        } else {
            Vec::new()
        };
    }
    if !current.is_empty() {
        out.push(build_payload(ctx, session_id, &current).to_string());
    }
    out
}

/// Parse hq-pro's public flag resolver. Mirrors the website's
/// `resolveDesktopSigninBounceForInstall`: only an HTTP 200 whose JSON body
/// has `enabled: true` turns the mirror on. An unregistered key answers 404
/// with `enabled: false`; that, any error, or a malformed body is off.
pub fn parse_flag(status: u16, body: &str) -> bool {
    if status != 200 {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("enabled")?.as_bool())
        == Some(true)
}

/// Build the flag-resolve URL for this install.
pub fn flag_resolve_url(base: &str, install_id: &str) -> String {
    let mut url = url::Url::parse(base).unwrap_or_else(|_| {
        url::Url::parse(FLAG_RESOLVE_URL).expect("constant flag resolve URL parses")
    });
    url.query_pairs_mut()
        .append_pair("key", FLAG_KEY)
        .append_pair("visitorId", install_id);
    url.into()
}

/// Endpoints, overridable for tests.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub ingest: String,
    pub flag_resolve: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            ingest: INGEST_URL.to_string(),
            flag_resolve: FLAG_RESOLVE_URL.to_string(),
        }
    }
}

const GATE_UNRESOLVED: u8 = 0;
const GATE_OFF: u8 = 1;
const GATE_ON: u8 = 2;

/// Called when the visitor id becomes known so the app can persist it next to
/// the install id. Must not block for long.
pub type PersistVisitor = dyn Fn(&str, Option<&str>) + Send + Sync;

/// The mirror: a bounded queue plus one background sender.
pub struct Mirror {
    ctx: Mutex<MirrorContext>,
    queue: Mutex<BoundedQueue>,
    gate: AtomicU8,
    notify: Notify,
    client: reqwest::Client,
    endpoints: Endpoints,
    session_id: String,
    persist: Box<PersistVisitor>,
}

impl Mirror {
    pub fn new(
        ctx: MirrorContext,
        endpoints: Endpoints,
        persist: Box<PersistVisitor>,
    ) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .timeout(SEND_TIMEOUT)
            .connect_timeout(SEND_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            ctx: Mutex::new(ctx),
            queue: Mutex::new(BoundedQueue::new(QUEUE_CAPACITY)),
            gate: AtomicU8::new(GATE_UNRESOLVED),
            notify: Notify::new(),
            client,
            endpoints,
            session_id: uuid::Uuid::new_v4().to_string(),
            persist,
        })
    }

    pub fn context(&self) -> MirrorContext {
        self.ctx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn is_enabled(&self) -> bool {
        self.gate.load(Ordering::SeqCst) == GATE_ON
    }

    /// Whether [`Mirror::record`] would keep an event right now: the flag is on
    /// or not resolved yet (events are held until it is).
    pub fn accepts_events(&self) -> bool {
        self.gate.load(Ordering::SeqCst) != GATE_OFF
    }

    pub fn queued(&self) -> usize {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Queue an event. Before the flag resolves the event is held (bounded);
    /// once the flag is known to be off every event is dropped at the door.
    pub fn record(&self, name: &str, props: Map<String, Value>) {
        if self.gate.load(Ordering::SeqCst) == GATE_OFF {
            return;
        }
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        let now = Self::now_ms();
        let first = self.context().first_launch_at_ms;
        let event = MirrorEvent {
            name: name.to_string(),
            props: sanitize_props(props),
            occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            seconds_since_first_launch: now.saturating_sub(first) / 1000,
        };
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
        self.notify.notify_one();
    }

    /// Resolve the gate. Off clears whatever was held. A transport error on a
    /// re-resolve keeps the current state, so a network blip cannot switch a
    /// working mirror off for a whole refresh interval; on the first resolve
    /// it counts as off.
    pub async fn resolve_gate(&self) -> bool {
        let install_id = self.context().install_id;
        let url = flag_resolve_url(&self.endpoints.flag_resolve, &install_id);
        let enabled = match self.client.get(url).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                parse_flag(status, &body)
            }
            Err(_) => match self.gate.load(Ordering::SeqCst) {
                GATE_UNRESOLVED => false,
                current => return current == GATE_ON,
            },
        };
        if enabled {
            self.gate.store(GATE_ON, Ordering::SeqCst);
        } else {
            self.gate.store(GATE_OFF, Ordering::SeqCst);
            self.queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
        enabled
    }

    /// Accept the visitor id returned by the sign-in link completion. Stores and
    /// persists it and queues one `install_linked` row; a repeat is a no-op.
    pub fn adopt_visitor(&self, anon_id: &str, install_source: Option<&str>) {
        let anon_id = anon_id.trim();
        if anon_id.is_empty() {
            return;
        }
        {
            let mut ctx = self
                .ctx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if ctx.anon_id.as_deref() == Some(anon_id) {
                return;
            }
            ctx.anon_id = Some(anon_id.to_string());
            if let Some(source) = install_source {
                ctx.install_source = Some(source.to_string());
            }
        }
        (self.persist)(anon_id, install_source);
        self.record(EVENT_INSTALL_LINKED, Map::new());
    }

    async fn post_once(&self, body: &str) -> Result<u16, ()> {
        self.client
            .post(&self.endpoints.ingest)
            .header("content-type", "application/json;charset=UTF-8")
            .header("origin", ORIGIN)
            .body(body.to_string())
            .send()
            .await
            .map(|r| r.status().as_u16())
            .map_err(|_| ())
    }

    /// Send one body with at most one retry (5xx, 429, or transport error).
    async fn post_with_one_retry(&self, body: &str) {
        for attempt in 0..2 {
            match self.post_once(body).await {
                Ok(status) if status < 500 && status != 429 => return,
                Ok(_) | Err(()) => {}
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }

    /// Drain and send everything queued. Safe to call concurrently; a drain
    /// that finds nothing returns immediately.
    pub async fn flush_now(&self) {
        if !self.is_enabled() {
            return;
        }
        let events = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain();
        if events.is_empty() {
            return;
        }
        let ctx = self.context();
        for body in chunk_payloads(&ctx, &self.session_id, &events) {
            self.post_with_one_retry(&body).await;
        }
    }

    /// The background sender: resolve the flag, drain whenever something is
    /// queued, and re-resolve every [`FLAG_REFRESH_INTERVAL`]. Never returns.
    pub async fn run(self: Arc<Self>) {
        self.run_with_refresh(FLAG_REFRESH_INTERVAL).await
    }

    /// [`Mirror::run`] with an explicit refresh interval (tests use a short one).
    pub async fn run_with_refresh(self: Arc<Self>, every: Duration) {
        loop {
            let enabled = self.resolve_gate().await;
            let next_resolve = tokio::time::Instant::now() + every;
            if !enabled {
                tokio::time::sleep_until(next_resolve).await;
                continue;
            }
            loop {
                self.flush_now().await;
                tokio::select! {
                    _ = self.notify.notified() => {
                        // Coalesce bursts (a step shown + a receipt) into one request.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    _ = tokio::time::sleep_until(next_resolve) => break,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ctx() -> MirrorContext {
        MirrorContext {
            app_version: "0.10.400".into(),
            os_version: "15.1".into(),
            chip: "arm64".into(),
            install_id: "1b4e28ba-2fa1-4d01-8a1c-9c1c0d2b3e4f".into(),
            install_source: Some("welcome-signin".into()),
            first_launch_at_ms: 1_000,
            anon_id: Some("vyg-0a1b2c3d-0000-4000-8000-000000000000".into()),
        }
    }

    fn event(name: &str) -> MirrorEvent {
        MirrorEvent {
            name: name.into(),
            props: Map::new(),
            occurred_at: "2026-10-01T00:00:00.000Z".into(),
            seconds_since_first_launch: 42,
        }
    }

    #[test]
    fn queue_is_bounded_and_drops_oldest() {
        let mut queue = BoundedQueue::new(3);
        assert!(!queue.push(event("a")));
        assert!(!queue.push(event("b")));
        assert!(!queue.push(event("c")));
        assert!(queue.push(event("d")));
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.dropped(), 1);
        let names: Vec<_> = queue.drain().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["b", "c", "d"]);
        assert!(queue.is_empty());
    }

    #[test]
    fn payload_carries_required_props_and_pixel_shape() {
        let mut props = Map::new();
        props.insert("step".into(), json!("welcome-signin"));
        let mut e = event(EVENT_ONBOARDING_STEP_SHOWN);
        e.props = props;
        let payload = build_payload(&ctx(), "session-1", &[e]);
        assert_eq!(payload["source"]["scope"], SITE_KEY);
        assert_eq!(payload["source"]["itemType"], "web-pixel");
        assert_eq!(payload["profileId"], ctx().anon_id.unwrap());
        assert_eq!(payload["sessionId"], "session-1");
        let ev = &payload["events"][0];
        assert_eq!(ev["eventType"], EVENT_ONBOARDING_STEP_SHOWN);
        assert_eq!(ev["scope"], SITE_KEY);
        assert_eq!(ev["timeStamp"], "2026-10-01T00:00:00.000Z");
        let p = &ev["properties"];
        for key in [
            "appVersion",
            "osVersion",
            "chip",
            "installId",
            "installSource",
            "secondsSinceFirstLaunch",
            "anonId",
            "step",
            "messageId",
            "userAgent",
        ] {
            assert!(p.get(key).is_some(), "missing {key}");
        }
        assert_eq!(p["secondsSinceFirstLaunch"], 42);
        assert_eq!(p["ids"]["vyg_aid"], ctx().anon_id.unwrap());
        assert_eq!(ev["target"]["scope"], SITE_KEY);
        assert_eq!(ev["target"]["properties"]["vygAid"], ctx().anon_id.unwrap());
    }

    #[test]
    fn payload_without_visitor_omits_profile_and_target() {
        let mut c = ctx();
        c.anon_id = None;
        c.install_source = None;
        let payload = build_payload(&c, "s", &[event(EVENT_APP_FIRST_LAUNCH)]);
        assert!(payload.get("profileId").is_none());
        assert_eq!(payload["source"]["itemId"], c.install_id);
        let ev = &payload["events"][0];
        assert!(ev.get("target").is_none());
        assert!(ev["properties"].get("anonId").is_none());
        assert!(ev["properties"].get("installSource").is_none());
        assert_eq!(ev["properties"]["installId"], c.install_id);
    }

    #[test]
    fn sanitize_drops_pii_shaped_keys_and_bounds_strings() {
        let mut props = Map::new();
        props.insert("email".into(), json!("a@b.c"));
        props.insert("displayName".into(), json!("A"));
        props.insert("accessToken".into(), json!("t"));
        props.insert("personUid".into(), json!("p"));
        props.insert("provider".into(), json!("google"));
        props.insert("empty".into(), json!(""));
        props.insert("nested".into(), json!({"email": "x"}));
        props.insert("long".into(), json!("x".repeat(1000)));
        let out = sanitize_props(props);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out["provider"], "google");
        assert_eq!(out["long"].as_str().unwrap().len(), MAX_PROP_LENGTH);
        let text = serde_json::to_string(&build_payload(
            &ctx(),
            "s",
            &[MirrorEvent {
                name: EVENT_LOGIN_COMPLETED.into(),
                props: {
                    let mut m = Map::new();
                    m.insert("email".into(), json!("leak@example.com"));
                    m.insert("idToken".into(), json!("eyJ"));
                    m
                },
                occurred_at: "2026-10-01T00:00:00.000Z".into(),
                seconds_since_first_launch: 1,
            }],
        ))
        .unwrap();
        assert!(!text.contains("leak@example.com"));
        assert!(!text.contains("eyJ"));
    }

    #[test]
    fn chunking_respects_body_cap() {
        let big = MirrorEvent {
            props: {
                let mut m = Map::new();
                // ~30 KB per event: three together exceed the 64 KB cap.
                for i in 0..100 {
                    m.insert(format!("k{i}"), json!("v".repeat(MAX_PROP_LENGTH)));
                }
                m
            },
            ..event("x")
        };
        let events: Vec<_> = (0..3).map(|_| big.clone()).collect();
        let bodies = chunk_payloads(&ctx(), "s", &events);
        assert_eq!(bodies.len(), 2);
        for body in &bodies {
            assert!(body.len() <= MAX_BODY_BYTES);
        }
        // An event that alone exceeds the cap is dropped, not sent.
        let huge = MirrorEvent {
            props: {
                let mut m = Map::new();
                for i in 0..400 {
                    m.insert(format!("k{i}"), json!("v".repeat(MAX_PROP_LENGTH)));
                }
                m
            },
            ..event("huge")
        };
        assert!(chunk_payloads(&ctx(), "s", &[huge]).is_empty());
    }

    #[test]
    fn flag_parsing_only_accepts_200_enabled_true() {
        assert!(parse_flag(
            200,
            r#"{"key":"desktop.cdp-mirror","enabled":true}"#
        ));
        assert!(!parse_flag(
            200,
            r#"{"key":"desktop.cdp-mirror","enabled":false}"#
        ));
        assert!(!parse_flag(
            404,
            r#"{"key":"desktop.cdp-mirror","enabled":true}"#
        ));
        assert!(!parse_flag(200, r#"{"enabled":"true"}"#));
        assert!(!parse_flag(200, "nope"));
    }

    #[test]
    fn flag_url_carries_key_and_install() {
        let flag = flag_resolve_url(FLAG_RESOLVE_URL, "inst");
        assert!(flag.contains("key=desktop.cdp-mirror"));
        assert!(flag.contains("visitorId=inst"));
    }

    fn endpoints(server: &MockServer) -> Endpoints {
        Endpoints {
            ingest: format!("{}/cdp/ingest", server.uri()),
            flag_resolve: format!("{}/v1/flags/resolve-public", server.uri()),
        }
    }

    #[tokio::test]
    async fn flag_off_sends_nothing_and_drops_held_events() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .and(query_param("key", FLAG_KEY))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_string(r#"{"key":"desktop.cdp-mirror","enabled":false}"#),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let mut c = ctx();
        c.anon_id = None;
        let mirror = Mirror::new(c, endpoints(&server), Box::new(|_, _| {}));
        mirror.record(EVENT_APP_FIRST_LAUNCH, Map::new());
        assert_eq!(mirror.queued(), 1);
        assert!(mirror.accepts_events(), "held until the flag resolves");
        assert!(!mirror.resolve_gate().await);
        assert!(!mirror.accepts_events());
        assert!(!mirror.is_enabled());
        assert_eq!(mirror.queued(), 0);
        mirror.record(EVENT_ONBOARDING_STEP_SHOWN, Map::new());
        assert_eq!(
            mirror.queued(),
            0,
            "events are dropped at the door once off"
        );
        mirror.flush_now().await;
        mirror.adopt_visitor("vyg-late", None);
        assert_eq!(mirror.queued(), 0, "install_linked is dropped while off");
        server.verify().await;
    }

    #[tokio::test]
    async fn run_makes_no_handshake_request_and_sends_without_visitor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&server)
            .await;
        let mut c = ctx();
        c.anon_id = None;
        let mirror = Mirror::new(c, endpoints(&server), Box::new(|_, _| {}));
        mirror.record(EVENT_APP_FIRST_LAUNCH, Map::new());
        let sender = tokio::spawn(mirror.clone().run());
        for _ in 0..50 {
            if mirror.queued() == 0 && mirror.is_enabled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        sender.abort();
        let requests = server.received_requests().await.unwrap();
        assert!(
            requests
                .iter()
                .all(|r| r.url.path() != "/api/desktop/visitor-handshake"),
            "the app never asks the handshake route directly"
        );
        let post = requests.iter().find(|r| r.method == "POST").unwrap();
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert!(body.get("profileId").is_none());
        assert_eq!(body["events"][0]["eventType"], EVENT_APP_FIRST_LAUNCH);
        server.verify().await;
    }

    #[tokio::test]
    async fn signin_link_visitor_is_adopted_persisted_and_posted_with_origin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .and(header("origin", ORIGIN))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let persisted = Arc::new(Mutex::new(None::<(String, Option<String>)>));
        let sink = persisted.clone();
        let mut c = ctx();
        c.anon_id = None;
        c.install_source = None;
        let mirror = Mirror::new(
            c,
            endpoints(&server),
            Box::new(move |anon, source| {
                *sink.lock().unwrap() = Some((anon.to_string(), source.map(str::to_owned)));
            }),
        );
        mirror.record(EVENT_LOGIN_COMPLETED, Map::new());
        assert!(mirror.resolve_gate().await);
        mirror.adopt_visitor(" vyg-abc ", None);
        assert_eq!(*persisted.lock().unwrap(), Some(("vyg-abc".into(), None)));
        assert_eq!(mirror.context().anon_id.as_deref(), Some("vyg-abc"));
        assert_eq!(mirror.queued(), 2, "login + install_linked");
        // A repeat of the same id is a no-op; an empty one is ignored.
        mirror.adopt_visitor("vyg-abc", None);
        mirror.adopt_visitor("  ", None);
        assert_eq!(mirror.queued(), 2);
        mirror.flush_now().await;
        let requests = server.received_requests().await.unwrap();
        let post = requests.iter().find(|r| r.method == "POST").unwrap();
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert_eq!(body["profileId"], "vyg-abc");
        let names: Vec<_> = body["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["eventType"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec![EVENT_LOGIN_COMPLETED, EVENT_INSTALL_LINKED]);
        for e in body["events"].as_array().unwrap() {
            assert_eq!(e["properties"]["anonId"], "vyg-abc");
        }
        server.verify().await;
    }

    #[tokio::test]
    async fn server_error_gets_exactly_one_retry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(503))
            .expect(2)
            .mount(&server)
            .await;
        let mirror = Mirror::new(ctx(), endpoints(&server), Box::new(|_, _| {}));
        mirror.gate.store(GATE_ON, Ordering::SeqCst);
        mirror.record(EVENT_SETUP_ABANDONED, Map::new());
        mirror.flush_now().await;
        server.verify().await;
    }

    #[tokio::test]
    async fn client_error_is_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&server)
            .await;
        let mirror = Mirror::new(ctx(), endpoints(&server), Box::new(|_, _| {}));
        mirror.gate.store(GATE_ON, Ordering::SeqCst);
        mirror.record(EVENT_COMPANY_CREATED, Map::new());
        mirror.flush_now().await;
        server.verify().await;
    }

    #[test]
    fn hash_identifier_is_sha256_hex_and_never_the_raw_id() {
        let hashed = hash_identifier(" prs_01ABC ").unwrap();
        assert_eq!(hashed.len(), 64);
        assert!(hashed
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(Some(hashed.clone()), hash_identifier("prs_01ABC"));
        assert!(!hashed.contains("prs_"));
        // Known vector: sha256("abc").
        assert_eq!(
            hash_identifier("abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_identifier("   "), None);
    }

    #[test]
    fn hashed_ids_survive_sanitize_under_their_prop_names() {
        let mut props = Map::new();
        props.insert("userHash".into(), json!(hash_identifier("prs_1").unwrap()));
        props.insert(
            "companyHash".into(),
            json!(hash_identifier("cmp_1").unwrap()),
        );
        let out = sanitize_props(props);
        assert_eq!(out.len(), 2, "{out:?}");
    }

    #[tokio::test]
    async fn flag_flip_takes_effect_on_the_next_refresh_without_relaunch() {
        let server = MockServer::start().await;
        // First resolve: off. Every later resolve: on.
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":false}"#))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&server)
            .await;
        let mirror = Mirror::new(ctx(), endpoints(&server), Box::new(|_, _| {}));
        let sender = tokio::spawn(mirror.clone().run_with_refresh(Duration::from_millis(150)));
        for _ in 0..100 {
            if mirror.gate.load(Ordering::SeqCst) == GATE_OFF {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        mirror.record(EVENT_APP_OPENED, Map::new());
        assert_eq!(mirror.queued(), 0, "dropped while off");
        for _ in 0..200 {
            if mirror.is_enabled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(mirror.is_enabled(), "flag flip picked up by the refresh");
        mirror.record(EVENT_APP_DAILY_ACTIVE, Map::new());
        let mut sent = false;
        for _ in 0..100 {
            let requests = server.received_requests().await.unwrap();
            sent = requests.iter().any(|r| {
                r.method == "POST"
                    && serde_json::from_slice::<Value>(&r.body).unwrap()["events"][0]["eventType"]
                        == EVENT_APP_DAILY_ACTIVE
            });
            if sent {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        sender.abort();
        assert!(sent, "event recorded after the flip is sent");
    }

    #[tokio::test]
    async fn refresh_turning_off_clears_queue_and_transport_error_keeps_state() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(404).set_body_string(r#"{"enabled":false}"#))
            .mount(&server)
            .await;
        let mirror = Mirror::new(ctx(), endpoints(&server), Box::new(|_, _| {}));
        assert!(mirror.resolve_gate().await);
        mirror.record(EVENT_SYNC_STARTED, Map::new());
        assert!(
            !mirror.resolve_gate().await,
            "re-resolve reads the flipped flag"
        );
        assert_eq!(
            mirror.queued(),
            0,
            "held events are cleared when it turns off"
        );

        // A dead flag endpoint on re-resolve keeps the current state.
        let dead = Endpoints {
            ingest: "http://127.0.0.1:9/cdp/ingest".into(),
            flag_resolve: "http://127.0.0.1:9/v1/flags/resolve-public".into(),
        };
        let on = Mirror::new(ctx(), dead.clone(), Box::new(|_, _| {}));
        on.gate.store(GATE_ON, Ordering::SeqCst);
        assert!(on.resolve_gate().await);
        assert!(on.is_enabled());
        let fresh = Mirror::new(ctx(), dead, Box::new(|_, _| {}));
        assert!(!fresh.resolve_gate().await, "first resolve failing is off");
        assert!(!fresh.is_enabled());
    }
}
