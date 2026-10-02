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
//!   `target.properties.vygAid`. The desktop learns it from the website's
//!   visitor handshake (`GET /api/desktop/visitor-handshake?install=<id>`).
//!
//! Contract: fail silent, bounded in-memory queue (drops oldest), one retry at
//! most, 2 s per request, never on the UI thread, and nothing leaves the
//! process while the `desktop.cdp-mirror` public hq-flag is off. No email,
//! name, or token ever enters a payload — see [`sanitize_props`].

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
/// Website route that resolves the visitor id for an install id.
pub const HANDSHAKE_URL: &str = "https://hqforwork.com/api/desktop/visitor-handshake";
/// hq-pro's anonymous flag resolver (the same one the website uses for
/// `welcome.desktop-signin-link` on behalf of hq-desktop-app #1211).
pub const FLAG_RESOLVE_URL: &str = "https://hqapi.hq.computer/v1/flags/resolve-public";
/// Public hq-flags key gating the whole mirror. Default off.
pub const FLAG_KEY: &str = "desktop.cdp-mirror";
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

/// What every mirrored event carries. Assembled once at startup by the app and
/// updated when the handshake or sign-in link learns the visitor id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorContext {
    pub app_version: String,
    pub os_version: String,
    /// `arm64` or `x86_64`.
    pub chip: String,
    /// The installation attempt id (UUID v4) shared with hq-pro receipts.
    pub install_id: String,
    /// `welcome-install-arm | welcome-signin | email-link | direct`, from the
    /// handshake. Unknown until then.
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

/// Outcome of the website visitor handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handshake {
    /// The website resolved the visitor behind this install.
    Known {
        anon_id: String,
        install_source: Option<String>,
    },
    /// 204, 404, non-JSON, or a body without an `anonId`: nothing to link yet.
    Unknown,
}

const INSTALL_SOURCES: &[&str] = &[
    "welcome-install-arm",
    "welcome-signin",
    "email-link",
    "direct",
];

/// Parse `GET /api/desktop/visitor-handshake`. Only a 200 with a JSON object
/// carrying a non-empty string `anonId` counts; `installSource` is kept only
/// when it is one of the documented values.
pub fn parse_handshake(status: u16, body: &str) -> Handshake {
    if status != 200 {
        return Handshake::Unknown;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(body) else {
        return Handshake::Unknown;
    };
    let anon_id = object
        .get("anonId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_owned);
    let Some(anon_id) = anon_id else {
        return Handshake::Unknown;
    };
    let install_source = object
        .get("installSource")
        .and_then(Value::as_str)
        .filter(|s| INSTALL_SOURCES.contains(s))
        .map(str::to_owned);
    Handshake::Known {
        anon_id,
        install_source,
    }
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

/// Build the handshake URL. `link` is the sign-in link nonce from
/// `desktop_signin_link` when the retry runs after a linked sign-in.
pub fn handshake_url(base: &str, install_id: &str, link: Option<&str>) -> String {
    let mut url = url::Url::parse(base)
        .unwrap_or_else(|_| url::Url::parse(HANDSHAKE_URL).expect("constant handshake URL parses"));
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("install", install_id);
        if let Some(link) = link.filter(|l| !l.is_empty()) {
            pairs.append_pair("link", link);
        }
    }
    url.into()
}

/// Endpoints, overridable for tests.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub ingest: String,
    pub handshake: String,
    pub flag_resolve: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            ingest: INGEST_URL.to_string(),
            handshake: HANDSHAKE_URL.to_string(),
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
    handshake_attempted: Mutex<bool>,
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
            handshake_attempted: Mutex::new(false),
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

    /// Resolve the gate once. Off clears whatever was held.
    pub async fn resolve_gate(&self) -> bool {
        let install_id = self.context().install_id;
        let url = flag_resolve_url(&self.endpoints.flag_resolve, &install_id);
        let enabled = match self.client.get(url).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                parse_flag(status, &body)
            }
            Err(_) => false,
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

    /// Ask the website who this install is. On success the visitor id is
    /// stored, persisted, and an `install_linked` row is queued. No-op while
    /// the gate is off or the id is already known.
    pub async fn handshake(&self, link: Option<&str>) -> Handshake {
        if !self.is_enabled() {
            return Handshake::Unknown;
        }
        let ctx = self.context();
        if ctx.anon_id.is_some() {
            return Handshake::Known {
                anon_id: ctx.anon_id.unwrap_or_default(),
                install_source: ctx.install_source,
            };
        }
        *self
            .handshake_attempted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        let url = handshake_url(&self.endpoints.handshake, &ctx.install_id, link);
        let outcome = match self.client.get(url).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                parse_handshake(status, &body)
            }
            Err(_) => Handshake::Unknown,
        };
        if let Handshake::Known {
            anon_id,
            install_source,
        } = &outcome
        {
            self.adopt_visitor(anon_id, install_source.as_deref());
        }
        outcome
    }

    /// Accept a visitor id learned elsewhere (handshake or sign-in link).
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

    pub fn handshake_was_attempted(&self) -> bool {
        *self
            .handshake_attempted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    /// The background sender: resolve the flag, run the first handshake, then
    /// drain whenever something is queued. Returns when the gate is off.
    pub async fn run(self: Arc<Self>) {
        if !self.resolve_gate().await {
            return;
        }
        let _ = self.handshake(None).await;
        loop {
            self.flush_now().await;
            self.notify.notified().await;
            // Coalesce bursts (a step shown + a receipt) into one request.
            tokio::time::sleep(Duration::from_millis(100)).await;
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
    fn handshake_parsing() {
        assert_eq!(
            parse_handshake(200, r#"{"anonId":"vyg-1","installSource":"email-link"}"#),
            Handshake::Known {
                anon_id: "vyg-1".into(),
                install_source: Some("email-link".into())
            }
        );
        assert_eq!(
            parse_handshake(200, r#"{"anonId":"vyg-1","installSource":"bogus"}"#),
            Handshake::Known {
                anon_id: "vyg-1".into(),
                install_source: None
            }
        );
        assert_eq!(parse_handshake(204, ""), Handshake::Unknown);
        assert_eq!(
            parse_handshake(404, r#"{"anonId":"vyg-1"}"#),
            Handshake::Unknown
        );
        assert_eq!(parse_handshake(200, r#"{"anonId":""}"#), Handshake::Unknown);
        assert_eq!(parse_handshake(200, "not json"), Handshake::Unknown);
        assert_eq!(parse_handshake(200, "[]"), Handshake::Unknown);
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
    fn urls_carry_install_and_optional_link() {
        let flag = flag_resolve_url(FLAG_RESOLVE_URL, "inst");
        assert!(flag.contains("key=desktop.cdp-mirror"));
        assert!(flag.contains("visitorId=inst"));
        let hs = handshake_url(HANDSHAKE_URL, "inst", None);
        assert!(hs.ends_with("?install=inst"));
        let hs = handshake_url(HANDSHAKE_URL, "inst", Some("nonce"));
        assert!(hs.contains("install=inst") && hs.contains("link=nonce"));
    }

    fn endpoints(server: &MockServer) -> Endpoints {
        Endpoints {
            ingest: format!("{}/cdp/ingest", server.uri()),
            handshake: format!("{}/api/desktop/visitor-handshake", server.uri()),
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
        Mock::given(method("GET"))
            .and(path("/api/desktop/visitor-handshake"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
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
        mirror.clone().run().await;
        assert!(!mirror.is_enabled());
        assert_eq!(mirror.queued(), 0);
        mirror.record(EVENT_ONBOARDING_STEP_SHOWN, Map::new());
        assert_eq!(
            mirror.queued(),
            0,
            "events are dropped at the door once off"
        );
        mirror.flush_now().await;
        assert_eq!(mirror.handshake(None).await, Handshake::Unknown);
        server.verify().await;
    }

    #[tokio::test]
    async fn flag_on_runs_handshake_then_posts_pixel_shaped_batch_with_origin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/desktop/visitor-handshake"))
            .and(query_param(
                "install",
                "1b4e28ba-2fa1-4d01-8a1c-9c1c0d2b3e4f",
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    r#"{"anonId":"vyg-abc","installSource":"welcome-install-arm"}"#,
                ),
            )
            .expect(1)
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
        mirror.record(EVENT_APP_FIRST_LAUNCH, Map::new());
        assert!(mirror.resolve_gate().await);
        assert_eq!(
            mirror.handshake(None).await,
            Handshake::Known {
                anon_id: "vyg-abc".into(),
                install_source: Some("welcome-install-arm".into())
            }
        );
        assert_eq!(
            *persisted.lock().unwrap(),
            Some(("vyg-abc".into(), Some("welcome-install-arm".into())))
        );
        assert_eq!(mirror.queued(), 2, "first launch + install_linked");
        mirror.flush_now().await;
        assert_eq!(mirror.queued(), 0);
        let requests = server.received_requests().await.unwrap();
        let post = requests
            .iter()
            .find(|r| r.method == "POST")
            .expect("one ingest post");
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert_eq!(body["profileId"], "vyg-abc");
        let names: Vec<_> = body["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["eventType"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec![EVENT_APP_FIRST_LAUNCH, EVENT_INSTALL_LINKED]);
        for e in body["events"].as_array().unwrap() {
            assert_eq!(e["properties"]["anonId"], "vyg-abc");
            assert_eq!(e["properties"]["installSource"], "welcome-install-arm");
        }
        // A second handshake is a no-op once the visitor is known.
        assert!(matches!(
            mirror.handshake(Some("nonce")).await,
            Handshake::Known { .. }
        ));
        server.verify().await;
    }

    #[tokio::test]
    async fn unknown_handshake_still_sends_events_without_visitor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/flags/resolve-public"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"enabled":true}"#))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/desktop/visitor-handshake"))
            .respond_with(ResponseTemplate::new(404))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cdp/ingest"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&server)
            .await;
        let mut c = ctx();
        c.anon_id = None;
        let mirror = Mirror::new(c, endpoints(&server), Box::new(|_, _| {}));
        assert!(mirror.resolve_gate().await);
        assert_eq!(mirror.handshake(None).await, Handshake::Unknown);
        mirror.record(EVENT_LOGIN_COMPLETED, Map::new());
        mirror.flush_now().await;
        // Retry once after sign-in, with the link nonce.
        assert_eq!(mirror.handshake(Some("nonce")).await, Handshake::Unknown);
        let requests = server.received_requests().await.unwrap();
        let post = requests.iter().find(|r| r.method == "POST").unwrap();
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert!(body.get("profileId").is_none());
        assert_eq!(body["events"][0]["eventType"], EVENT_LOGIN_COMPLETED);
        assert!(requests
            .iter()
            .any(|r| r.method == "GET" && r.url.query().unwrap_or("").contains("link=nonce")));
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
}
