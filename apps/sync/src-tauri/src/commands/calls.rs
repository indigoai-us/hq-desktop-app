//! US-016 — the dedicated native call window.
//!
//! Calls own their own OS window (label `call`) whose lifetime is owned here,
//! on the Rust side, so the main Desktop view can navigate or close without
//! ever tearing down live media. The window mounts `call.html` (its own Vite
//! entry) and hosts the `@hq/meet-core` session.
//!
//! Hand-off follows the pattern already used by `commands::meetings`:
//!
//!   * cold open — the authorized target is stashed as *pending*, the window is
//!     built, and the freshly mounted webview drains it exactly once via
//!     `calls_take_pending_target`;
//!   * warm open — the window is already mounted and has acknowledged itself
//!     `ready`, so the target is additionally pushed with `emit_to("call", …)`.
//!     Scoped to the call window on purpose: a global `emit` would broadcast
//!     the target (grant id, binding) to every webview in the process.
//!
//! A `CallWindowTarget` carries NO credential material — no token, bearer,
//! password, key or authorization header. The bearer stays in the native host
//! (`hq_pro_fetch`), the device signing key is generated inside the call
//! window, and nothing is ever passed through the URL. `target_has_no_credential_fields`
//! pins that by construction.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use hq_desktop_core::meetings::is_url_safe_id;

/// The one call window. Exactly one per user in Phase 1, and the exact string
/// the capability file (`capabilities/call-window.json`) scopes itself to.
pub const CALL_WINDOW_LABEL: &str = "call";

/// Refusal when a *different* call session asks for the window while a call is
/// already live. Phase 1 is one active call per user.
pub const CALL_ACTIVE: &str = "CALL_ACTIVE";

/// Durable pending-work file (transcript completion hook, US-024+).
const RECOVERY_FILE: &str = "call-pending.json";
/// Hard ceiling on the durable blob. Small state only — never transcript text.
pub const MAX_PENDING_BYTES: usize = 256 * 1024;
/// How long app quit waits for the call window to confirm disposal.
pub const DISPOSE_WAIT: Duration = Duration::from_millis(1500);
const DISPOSE_POLL: Duration = Duration::from_millis(25);
/// JS `Number.MAX_SAFE_INTEGER`. Every timestamp in a target crosses the invoke
/// seam into a webview, so anything past this cannot round-trip honestly.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_992; // 2^53

// ── Target ───────────────────────────────────────────────────────────────────

/// Admission grant as handed to the window. Ids and timings only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallKnockTarget {
    pub knock_id: String,
    pub capability_id: String,
}

/// This device's participant identity. No key material: the call window mints
/// its own Ed25519 device key and derives `peerKey` from it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSelfTarget {
    pub person_uid: String,
    pub device_id: String,
}

/// Everything the call window is authorized to act on — and nothing else.
///
/// US-018 removed the grant and the evidence receipt. The window mints its own
/// device key and signs its own `admit`, so no grant minted elsewhere could be
/// bound to the key it signs with; the US-011 receipt is bundled at build time
/// rather than carried, so a caller cannot decide what counts as verified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallWindowTarget {
    /// Opaque, caller-chosen id, e.g. `${companyUid}:${roomId}:${callId}:${epoch}`.
    pub session_id: String,
    /// Explicit company binding — never inferred inside the window.
    pub company_uid: String,
    pub room_id: String,
    pub call_id: String,
    pub epoch: i64,
    /// `self` in JSON; `self` is a Rust keyword.
    #[serde(rename = "self")]
    pub self_: CallSelfTarget,
    /// An accepted knock's capability, for a private room (US-018). Absent for
    /// a company-visible room, which needs no capability to admit into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knock: Option<CallKnockTarget>,
}

/// Result of `calls_open_window`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallOpenResult {
    /// True when an already-open window for the SAME session was focused.
    pub focused: bool,
}

/// Credential *stems*. A normalized key (lowercased, `_`/`-` stripped) that
/// CONTAINS any of these is refused, so `access_token`, `refreshToken` and
/// `x-api-key` are caught, not just the bare names. `sessionId` is deliberately
/// not a stem: the session id is the registry key and carries no secret.
const CREDENTIAL_FIELD_STEMS: [&str; 8] = [
    "token",
    "credential",
    "password",
    "secret",
    "authorization",
    "bearer",
    "apikey",
    "privatekey",
];

/// True when no key anywhere in `value` looks like credential material.
/// Recursive: an `evidence` receipt is caller-supplied JSON, so the check has
/// to reach into it too.
pub fn json_has_no_credential_fields(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().all(|(key, nested)| {
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            !CREDENTIAL_FIELD_STEMS
                .iter()
                .any(|stem| normalized.contains(stem))
                && json_has_no_credential_fields(nested)
        }),
        serde_json::Value::Array(items) => items.iter().all(json_has_no_credential_fields),
        _ => true,
    }
}

/// Validate a target before it is stored or handed to a webview.
pub fn validate_target(target: &CallWindowTarget) -> Result<(), String> {
    for (field, value) in [
        ("sessionId", target.session_id.as_str()),
        ("companyUid", target.company_uid.as_str()),
        ("roomId", target.room_id.as_str()),
        ("callId", target.call_id.as_str()),
        ("self.personUid", target.self_.person_uid.as_str()),
        ("self.deviceId", target.self_.device_id.as_str()),
    ]
    .into_iter()
    .chain(target.knock.iter().flat_map(|knock| {
        [
            ("knock.knockId", knock.knock_id.as_str()),
            ("knock.capabilityId", knock.capability_id.as_str()),
        ]
    })) {
        // sessionId is the one composite id: `a:b:c:d`. Every segment still has
        // to be url-safe, so a target can never smuggle a path or a query.
        // `split` always yields at least one part, so an empty value simply
        // fails `is_url_safe_id` — no separate emptiness branch needed.
        let parts: Vec<&str> = if field == "sessionId" {
            value.split(':').collect()
        } else {
            vec![value]
        };
        if !parts.iter().all(|part| is_url_safe_id(part)) {
            return Err(format!("invalid {field}"));
        }
    }
    if target.epoch < 0 || target.epoch > MAX_SAFE_INTEGER {
        return Err("invalid epoch".to_string());
    }
    let serialized =
        serde_json::to_value(target).map_err(|error| format!("invalid target: {error}"))?;
    if !json_has_no_credential_fields(&serialized) {
        return Err("target must not carry credential material".to_string());
    }
    Ok(())
}

// ── Registry ─────────────────────────────────────────────────────────────────

/// A live (or opening) call window, keyed by session id.
#[derive(Debug, Clone, PartialEq)]
pub struct CallEntry {
    pub target: CallWindowTarget,
    /// Set once the webview has acknowledged its mount (`calls_window_ready`).
    pub ready: bool,
    pub opened_at: Instant,
}

/// Registry state. Phase 1 holds at most one entry, but the map keeps the
/// "keyed by session" shape so a future multi-call phase is a policy change
/// rather than a rewrite.
#[derive(Debug, Default)]
pub struct CallRegistry {
    entries: HashMap<String, CallEntry>,
    /// Drained exactly once by the window on mount.
    pending: Option<CallWindowTarget>,
    /// Session ids the window has confirmed disposed (app-quit handshake).
    disposed: Vec<String>,
}

/// What `calls_open_window` should do, decided without touching Tauri so the
/// policy is unit-testable with no webview.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenDecision {
    /// Same session, window already there: just focus it.
    Focus,
    /// Window exists and has acknowledged ready: store pending AND emit_to.
    Warm,
    /// Build the window; it will drain the pending target on mount.
    Cold,
    /// A different call already owns the window.
    Conflict,
}

impl CallRegistry {
    pub fn decide_open(&self, window_exists: bool, target: &CallWindowTarget) -> OpenDecision {
        match self.entries.get(&target.session_id) {
            Some(entry) if window_exists => {
                if entry.ready {
                    OpenDecision::Focus
                } else {
                    // Window is up but has not acknowledged: re-arm pending so
                    // a slow mount still gets exactly one target.
                    OpenDecision::Cold
                }
            }
            Some(_) => OpenDecision::Cold,
            None if !self.entries.is_empty() => OpenDecision::Conflict,
            None if window_exists => OpenDecision::Warm,
            None => OpenDecision::Cold,
        }
    }

    pub fn arm(&mut self, target: CallWindowTarget) {
        self.entries.insert(
            target.session_id.clone(),
            CallEntry {
                target: target.clone(),
                ready: false,
                opened_at: Instant::now(),
            },
        );
        self.pending = Some(target);
    }

    /// Drain the pending target. Returns it at most once.
    pub fn take_pending(&mut self) -> Option<CallWindowTarget> {
        self.pending.take()
    }

    /// Mark a session's window mounted. False when the session is unknown.
    pub fn mark_ready(&mut self, session_id: &str) -> bool {
        match self.entries.get_mut(session_id) {
            Some(entry) => {
                entry.ready = true;
                true
            }
            None => false,
        }
    }

    pub fn is_ready(&self, session_id: &str) -> bool {
        self.entries
            .get(session_id)
            .map(|entry| entry.ready)
            .unwrap_or(false)
    }

    pub fn release(&mut self, session_id: &str) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|target| target.session_id == session_id)
        {
            self.pending = None;
        }
        self.entries.remove(session_id).is_some()
    }

    /// Drain every entry and the pending slot. Returns the released ids.
    pub fn release_all(&mut self) -> Vec<String> {
        let released = self.active_session_ids();
        self.entries.clear();
        self.pending = None;
        released
    }

    pub fn active_session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.entries.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn note_disposed(&mut self, session_id: &str) {
        if !self.disposed.iter().any(|id| id == session_id) {
            self.disposed.push(session_id.to_string());
        }
    }

    pub fn all_disposed(&self) -> bool {
        self.entries
            .keys()
            .all(|id| self.disposed.iter().any(|seen| seen == id))
    }
}

/// Only the call window's own destruction clears the registry. Main-window
/// close/navigation (`main`, `desktop-alt`, detail windows) must never do it —
/// that is the whole point of the story.
pub fn owns_window_label(label: &str) -> bool {
    label == CALL_WINDOW_LABEL
}

/// The call window was destroyed (closed, crashed, or killed). Drop every
/// entry and any undrained pending target so the registry is cold again and the
/// next open is a clean cold start rather than `CALL_ACTIVE`.
///
/// Called from the `Destroyed` window-event hook in `main.rs`, gated on
/// `owns_window_label`, so no other window can ever clear a live call.
pub fn release_all_sessions() -> Vec<String> {
    with_registry(|registry| registry.release_all())
}

static REGISTRY: OnceLock<Mutex<CallRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<CallRegistry> {
    REGISTRY.get_or_init(|| Mutex::new(CallRegistry::default()))
}

fn with_registry<T>(run: impl FnOnce(&mut CallRegistry) -> T) -> T {
    let mut guard = registry().lock().unwrap_or_else(|poison| poison.into_inner());
    run(&mut guard)
}

// ── Durable pending work ─────────────────────────────────────────────────────

fn recovery_path(dir: &Path) -> PathBuf {
    dir.join(RECOVERY_FILE)
}

/// Atomic (temp + rename) write of the small pending-completion blob.
pub fn persist_pending_at(
    dir: &Path,
    session_id: &str,
    state: &serde_json::Value,
) -> Result<(), String> {
    if !is_url_safe_id(&session_id.replace(':', "-")) {
        return Err("invalid sessionId".to_string());
    }
    if !json_has_no_credential_fields(state) {
        return Err("pending state must not carry credential material".to_string());
    }
    let record = serde_json::json!({
        "version": 1,
        "sessionId": session_id,
        "state": state,
    });
    let encoded = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_PENDING_BYTES {
        return Err(format!(
            "pending state exceeds {MAX_PENDING_BYTES} bytes"
        ));
    }
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let final_path = recovery_path(dir);
    let temp_path = final_path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temp_path).map_err(|error| error.to_string())?;
        file.write_all(&encoded).map_err(|error| error.to_string())?;
        // Durable before the rename: a crash between write and rename must not
        // leave a renamed-but-empty recovery file.
        file.sync_all().map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temp_path, &final_path).map_err(|error| error.to_string())
}

/// Read and remove the durable blob. Returns it at most once per launch.
pub fn take_recovered_at(dir: &Path) -> Option<serde_json::Value> {
    let path = recovery_path(dir);
    let raw = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    if raw.len() > MAX_PENDING_BYTES {
        return None;
    }
    serde_json::from_slice(&raw).ok()
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Open (or focus) the dedicated call window for `target`.
#[tauri::command]
pub async fn calls_open_window(
    app: AppHandle,
    target: CallWindowTarget,
) -> Result<CallOpenResult, String> {
    validate_target(&target)?;

    let window = app.get_webview_window(CALL_WINDOW_LABEL);
    let decision = with_registry(|registry| registry.decide_open(window.is_some(), &target));

    match decision {
        OpenDecision::Conflict => Err(CALL_ACTIVE.to_string()),
        OpenDecision::Focus => {
            if let Some(window) = window {
                window.set_focus().map_err(|error| error.to_string())?;
            }
            Ok(CallOpenResult { focused: true })
        }
        OpenDecision::Warm => {
            // Store first so a window that is mid-reload still drains exactly
            // one target, then push it live. Scoped to the call window only.
            with_registry(|registry| registry.arm(target.clone()));
            app.emit_to(CALL_WINDOW_LABEL, "calls:target", &target)
                .map_err(|error| error.to_string())?;
            if let Some(window) = window {
                let _ = window.set_focus();
            }
            Ok(CallOpenResult { focused: false })
        }
        OpenDecision::Cold => {
            with_registry(|registry| registry.arm(target));
            if let Some(window) = window {
                let _ = window.set_focus();
                return Ok(CallOpenResult { focused: false });
            }
            build_call_window(&app)?;
            Ok(CallOpenResult { focused: false })
        }
    }
}

fn build_call_window(app: &AppHandle) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(
        app,
        CALL_WINDOW_LABEL,
        tauri::WebviewUrl::App("call.html".into()),
    )
    .title("HQ Call")
    .inner_size(960.0, 640.0)
    .min_inner_size(560.0, 400.0)
    .resizable(true)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Drain the pending target — exactly once, on the call window's mount.
#[tauri::command]
pub async fn calls_take_pending_target() -> Option<CallWindowTarget> {
    with_registry(|registry| registry.take_pending())
}

/// Mount acknowledgement. Unknown sessions are refused, so a stray webview
/// cannot mark somebody else's call ready.
#[tauri::command]
pub async fn calls_window_ready(session_id: String) -> Result<bool, String> {
    if with_registry(|registry| registry.mark_ready(&session_id)) {
        Ok(true)
    } else {
        Err("unknown call session".to_string())
    }
}

/// The window has left the call (close, leave, or error). Clears the entry so a
/// later open is a clean cold start rather than `CALL_ACTIVE`.
#[tauri::command]
pub async fn calls_release(session_id: String, reason: Option<String>) -> Result<bool, String> {
    let released = with_registry(|registry| registry.release(&session_id));
    crate::util::logfile::log(
        "calls",
        &format!(
            "release session={session_id} released={released} reason={}",
            reason.unwrap_or_else(|| "unspecified".to_string())
        ),
    );
    Ok(released)
}

/// Persist a small, credential-free blob of unfinished completion work.
#[tauri::command]
pub async fn calls_persist_pending(
    app: AppHandle,
    session_id: String,
    state: serde_json::Value,
) -> Result<(), String> {
    persist_pending_at(&app_dir(&app)?, &session_id, &state)
}

/// Hand back (once) whatever the previous launch left unfinished.
#[tauri::command]
pub async fn calls_take_recovered(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    Ok(take_recovered_at(&app_dir(&app)?))
}

/// The window's answer to `calls:dispose` during app quit.
#[tauri::command]
pub async fn calls_disposed(session_id: String) -> Result<(), String> {
    with_registry(|registry| registry.note_disposed(&session_id));
    Ok(())
}

/// App-quit hook: ask the call window to dispose its session (stopping camera
/// and microphone) and wait a bounded time for its acknowledgement.
///
/// Never hangs the quit: no call window, or no answer within `DISPOSE_WAIT`,
/// and the quit simply continues.
pub fn dispose_call_windows_for_exit(app: &AppHandle, budget: Duration) {
    let sessions = with_registry(|registry| registry.active_session_ids());
    if sessions.is_empty() || app.get_webview_window(CALL_WINDOW_LABEL).is_none() {
        return;
    }
    for session_id in &sessions {
        let _ = app.emit_to(
            CALL_WINDOW_LABEL,
            "calls:dispose",
            serde_json::json!({ "sessionId": session_id }),
        );
    }
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if with_registry(|registry| registry.all_disposed()) {
            break;
        }
        std::thread::sleep(DISPOSE_POLL);
    }
    with_registry(|registry| {
        for session_id in &sessions {
            registry.release(session_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(session: &str) -> CallWindowTarget {
        CallWindowTarget {
            session_id: session.to_string(),
            company_uid: "cmp-indigo".to_string(),
            room_id: "room-1".to_string(),
            call_id: "call-1".to_string(),
            epoch: 7,
            self_: CallSelfTarget {
                person_uid: "prs-1".to_string(),
                device_id: "dev-1".to_string(),
            },
            knock: None,
        }
    }

    #[test]
    fn cold_open_arms_pending_and_drains_exactly_once() {
        let mut registry = CallRegistry::default();
        let target = target("cmp-indigo:room-1:call-1:7");
        assert_eq!(registry.decide_open(false, &target), OpenDecision::Cold);
        registry.arm(target.clone());
        assert_eq!(registry.take_pending(), Some(target));
        assert_eq!(registry.take_pending(), None);
    }

    #[test]
    fn duplicate_open_of_same_ready_session_focuses() {
        let mut registry = CallRegistry::default();
        let target = target("s-1");
        registry.arm(target.clone());
        assert!(registry.mark_ready("s-1"));
        assert_eq!(registry.decide_open(true, &target), OpenDecision::Focus);
    }

    #[test]
    fn duplicate_open_before_ready_re_arms_the_pending_target() {
        let mut registry = CallRegistry::default();
        let target = target("s-1");
        registry.arm(target.clone());
        let _ = registry.take_pending();
        assert_eq!(registry.decide_open(true, &target), OpenDecision::Cold);
    }

    #[test]
    fn a_second_session_is_refused_while_a_call_is_active() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        assert_eq!(
            registry.decide_open(true, &target("s-2")),
            OpenDecision::Conflict
        );
    }

    #[test]
    fn warm_open_when_the_window_survived_its_previous_session() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        registry.mark_ready("s-1");
        registry.release("s-1");
        assert_eq!(registry.decide_open(true, &target("s-2")), OpenDecision::Warm);
    }

    #[test]
    fn ready_ack_is_refused_for_an_unknown_session() {
        let mut registry = CallRegistry::default();
        assert!(!registry.mark_ready("ghost"));
        registry.arm(target("s-1"));
        assert!(registry.mark_ready("s-1"));
        assert!(registry.is_ready("s-1"));
    }

    #[test]
    fn release_clears_entry_and_any_undrained_pending() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        assert!(registry.release("s-1"));
        assert!(registry.is_empty());
        assert_eq!(registry.take_pending(), None);
        assert!(!registry.release("s-1"));
    }

    #[test]
    fn only_the_call_window_label_owns_the_registry() {
        for label in ["main", "desktop-alt", "meetings-window", "widget"] {
            assert!(!owns_window_label(label), "{label} must not own calls");
        }
        assert!(owns_window_label(CALL_WINDOW_LABEL));
    }

    #[test]
    fn main_window_events_never_clear_an_active_call() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        registry.mark_ready("s-1");
        for label in ["main", "desktop-alt"] {
            if owns_window_label(label) {
                registry.release("s-1");
            }
        }
        assert_eq!(registry.active_session_ids(), vec!["s-1".to_string()]);
        assert!(registry.is_ready("s-1"));
    }

    #[test]
    fn dispose_handshake_tracks_every_active_session() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        assert!(!registry.all_disposed());
        registry.note_disposed("s-1");
        registry.note_disposed("s-1");
        assert!(registry.all_disposed());
    }

    #[test]
    fn a_target_never_serializes_credential_shaped_fields() {
        let serialized = serde_json::to_value(target("s-1")).unwrap();
        assert!(json_has_no_credential_fields(&serialized));
        assert!(serialized.get("self").is_some());
        for banned in ["token", "credential", "password", "secret", "authorization"] {
            assert!(
                serialized.get(banned).is_none(),
                "target must not carry {banned}"
            );
        }
    }

    #[test]
    fn credential_shaped_json_is_refused_at_any_depth() {
        // US-018 removed the last free-form JSON field from the target, so the
        // scan can no longer be driven THROUGH a target. It still guards every
        // serialized target (and any future field), so it is pinned directly.
        assert!(json_has_no_credential_fields(
            &serde_json::json!({ "nested": { "runAt": "x" } })
        ));
        assert!(!json_has_no_credential_fields(
            &serde_json::json!({ "nested": { "API-Key": "x" } })
        ));
        assert!(!json_has_no_credential_fields(
            &serde_json::json!({ "list": [{ "authorization": "Bearer x" }] })
        ));
        assert!(validate_target(&target("s-1")).is_ok());
    }

    #[test]
    fn validation_rejects_unsafe_ids_and_bad_numbers() {
        assert!(validate_target(&target("cmp:room:call:1")).is_ok());
        let mut bad = target("s-1");
        bad.room_id = "../escape".to_string();
        assert!(validate_target(&bad).is_err());
        let mut bad = target("s-1");
        bad.session_id = "has space".to_string();
        assert!(validate_target(&bad).is_err());
        let mut bad = target("s-1");
        bad.epoch = -1;
        assert!(validate_target(&bad).is_err());
        // A knock's ids are validated exactly like every other id.
        let mut knocked = target("s-1");
        knocked.knock = Some(CallKnockTarget {
            knock_id: "knk-1".to_string(),
            capability_id: "cap-1".to_string(),
        });
        assert!(validate_target(&knocked).is_ok());
        let mut bad = knocked.clone();
        bad.knock = Some(CallKnockTarget {
            knock_id: "../escape".to_string(),
            capability_id: "cap-1".to_string(),
        });
        assert!(validate_target(&bad).is_err());
        let mut bad = knocked;
        bad.knock = Some(CallKnockTarget {
            knock_id: "knk-1".to_string(),
            capability_id: String::new(),
        });
        assert!(validate_target(&bad).is_err());
    }

    #[test]
    fn destroying_the_call_window_returns_the_registry_to_cold() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        assert!(registry.mark_ready("s-1"));
        // Exactly what the `Destroyed` hook in main.rs does, gated on the label.
        assert!(owns_window_label(CALL_WINDOW_LABEL));
        let released = registry.release_all();
        assert_eq!(released, vec!["s-1".to_string()]);
        assert!(registry.is_empty());
        assert_eq!(registry.take_pending(), None);
        // A brand new session is a clean cold start, not CALL_ACTIVE.
        assert_eq!(registry.decide_open(false, &target("s-2")), OpenDecision::Cold);
    }

    #[test]
    fn a_destroyed_window_never_leaves_a_conflicting_entry_behind() {
        let mut registry = CallRegistry::default();
        registry.arm(target("s-1"));
        // Crash before ready: pending is still undrained.
        assert_eq!(registry.release_all(), vec!["s-1".to_string()]);
        assert_eq!(registry.decide_open(true, &target("s-2")), OpenDecision::Warm);
        // Idempotent.
        assert!(registry.release_all().is_empty());
    }

    #[test]
    fn validation_rejects_out_of_range_timestamps() {
        let mut bad = target("s-1");
        bad.epoch = MAX_SAFE_INTEGER + 1;
        assert!(validate_target(&bad).is_err());
        let mut ok = target("s-1");
        ok.epoch = MAX_SAFE_INTEGER;
        assert!(validate_target(&ok).is_ok());
        let mut negative = target("s-1");
        negative.epoch = -1;
        assert!(validate_target(&negative).is_err());
    }

    #[test]
    fn a_target_carries_no_grant_and_no_evidence() {
        // US-018: the grant is minted by the window's own admit, and the
        // service-evidence receipt is bundled in the build. Neither may travel
        // on a target, so neither can be chosen by whoever opened the window.
        let serialized = serde_json::to_value(target("s-1")).expect("serializable");
        let map = serialized.as_object().expect("object");
        assert!(!map.contains_key("grant"));
        assert!(!map.contains_key("evidence"));
        assert_eq!(
            map.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "sessionId",
                "companyUid",
                "roomId",
                "callId",
                "epoch",
                "self",
            ]
        );
    }

    #[test]
    fn credential_stems_match_by_substring_but_session_id_is_not_a_secret() {
        for banned in [
            "access_token",
            "refreshToken",
            "X-Api-Key",
            "servicePrivateKey",
            "clientSecret",
            "authorizationHeader",
            "userPassword",
            "bearerToken",
            "credentials",
        ] {
            let value = serde_json::json!({ "deep": { banned: "x" } });
            assert!(
                !json_has_no_credential_fields(&value),
                "{banned} must be refused"
            );
        }
        for allowed in ["sessionId", "session_id", "roomId", "grantId", "runAt"] {
            let value = serde_json::json!({ allowed: "x" });
            assert!(
                json_has_no_credential_fields(&value),
                "{allowed} is not credential material"
            );
        }
        assert!(!json_has_no_credential_fields(
            &serde_json::json!({ "access_token": "x" })
        ));
    }

    #[test]
    fn persisted_pending_state_round_trips_once() {
        let dir = std::env::temp_dir().join(format!(
            "hq-calls-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = serde_json::json!({
            "version": 1,
            "sessionId": "s-1",
            "pendingCompletion": serde_json::Value::Null,
        });
        persist_pending_at(&dir, "s-1", &state).unwrap();
        let recovered = take_recovered_at(&dir).expect("recovered once");
        assert_eq!(recovered.get("sessionId").and_then(|v| v.as_str()), Some("s-1"));
        assert_eq!(recovered.get("state"), Some(&state));
        assert!(take_recovered_at(&dir).is_none(), "drains exactly once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_or_credential_bearing_pending_state_is_refused() {
        let dir = std::env::temp_dir().join("hq-calls-test-refused");
        let huge = serde_json::json!({ "blob": "x".repeat(MAX_PENDING_BYTES + 1) });
        assert!(persist_pending_at(&dir, "s-1", &huge).is_err());
        let secret = serde_json::json!({ "authorization": "Bearer x" });
        assert!(persist_pending_at(&dir, "s-1", &secret).is_err());
        assert!(take_recovered_at(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod call_window_capability_tests {
    /// The call window closes itself by calling `destroy()` after cancelling
    /// the OS close so teardown can finish. `core:window:default` carries only
    /// read-only getters, so without an explicit `allow-destroy` grant that
    /// call is refused by the ACL and the window can never be closed — a
    /// silent UnhandledRejection in the webview, invisible from Rust.
    ///
    /// This asserts the grant is present so nobody trims the capability back
    /// to "least privilege" and re-wedges every call window.
    #[test]
    fn call_window_may_destroy_itself() {
        let capability = include_str!("../../capabilities/call-window.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capability).expect("call-window.json parses");
        let permissions = parsed["permissions"]
            .as_array()
            .expect("permissions is an array");
        assert!(
            permissions
                .iter()
                .any(|p| p.as_str() == Some("core:window:allow-destroy")),
            "call window must keep core:window:allow-destroy or it cannot be closed"
        );
        assert!(
            permissions
                .iter()
                .any(|p| p.as_str() == Some("core:window:allow-close")),
            "call window must keep core:window:allow-close"
        );
    }
}
