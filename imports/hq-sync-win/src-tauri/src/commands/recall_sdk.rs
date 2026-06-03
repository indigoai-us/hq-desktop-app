//! Recall Desktop SDK sidecar lifecycle.
//!
//! Spawns the Recall Desktop SDK as a child process (sidecar pattern) and
//! forwards its `meeting:detected` stdout events to the Svelte renderer as
//! typed Tauri `meeting:detected` events.
//!
//! ## Binary discovery
//!
//! The SDK binary (`recall-desktop-sdk`) is resolved in order:
//!   1. Next to the running executable — the Tauri `bundle.externalBin`
//!      placement for release builds. The binary is named
//!      `recall-desktop-sdk` (or `recall-desktop-sdk-aarch64-apple-darwin`
//!      in the Tauri arch-tagged form).
//!   2. `recall-desktop-sdk` on PATH — used during local dev or when the SDK
//!      is installed globally (e.g. `npm install -g @recall-ai/desktop-sdk`).
//!
//! If the binary cannot be found, `start_recall_sdk` logs
//! `RECALL_SDK_UNAVAILABLE` and returns `Ok(())` — the app continues
//! normally. The rest of the MeetingsWindow is unaffected.
//!
//! ## Credentials
//!
//! On startup, the module calls `GET /v1/recall/credentials` on hq-pro to
//! obtain the user's Recall API key. If the endpoint returns 404 (not yet
//! provisioned) or any network error, the SDK is skipped (same
//! `RECALL_SDK_UNAVAILABLE` log). This keeps the credential handshake
//! entirely server-side — no Recall key is ever stored locally in plaintext.
//!
//! ## Protocol
//!
//! The SDK emits ndjson to stdout. Lines whose `type` field equals
//! `"meeting:detected"` are parsed into `MeetingDetectedEvent` and forwarded
//! to the renderer. Unknown / malformed lines are silently skipped.
//!
//! ## Lifecycle
//!
//! - Started once from `main.rs` setup, in a `tauri::async_runtime::spawn`.
//! - The process is registered under the singleton handle `"recall-sdk"` in
//!   the shared `PROCESS_REGISTRY` (from `commands::process`). A second call
//!   to `start_recall_sdk` while the SDK is already running is a no-op.
//! - On app quit the Tauri runtime tears down, which drops the async tasks.
//!   SIGTERM is sent to the process; after `SIGKILL_DELAY` SIGKILL follows.
//!   This mirrors the sync runner and daemon lifecycle.
//!
//! ## Graceful-degradation contract
//!
//! Every error path in `start_recall_sdk` MUST log `RECALL_SDK_UNAVAILABLE`
//! and return `Ok(())` rather than propagating an `Err`. The caller (`main.rs`
//! setup) ignores the return value; an `Err` from setup would abort the
//! Tauri runtime and take the whole menubar app down.

use std::collections::HashMap;
use std::io::Write;
use std::process::ChildStdin;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::commands::cognito;
use crate::commands::process::{
    cancel_process_impl, run_process_with_stdin_impl, try_register_handle, ProcessEvent, SpawnArgs,
};
use crate::commands::sync::resolve_vault_api_url;
use crate::events::{
    MeetingClosedEvent, MeetingDetectedEvent, RecordingEndedEvent, RecordingErrorEvent,
    RecordingMediaCaptureEvent, RecordingStartedEvent, EVENT_MEETING_CLOSED,
    EVENT_MEETING_DETECTED, EVENT_RECORDING_ENDED, EVENT_RECORDING_ERROR,
    EVENT_RECORDING_MEDIA_CAPTURE, EVENT_RECORDING_STARTED,
};
use crate::util::client_info::build_client;
use crate::util::logfile::log;
use crate::util::paths;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Singleton handle in `PROCESS_REGISTRY`.
const SDK_HANDLE: &str = "recall-sdk";

/// Name of the Recall Desktop SDK binary.
const SDK_BIN: &str = "recall-desktop-sdk";

/// Tree-kill grace period passed to `cancel_process_impl` on app shutdown.
/// (The "SIGKILL" wording is macOS legacy — on Windows teardown is the
/// synchronous `TerminateJobObject` tree-kill; this delay is unused by the
/// Windows cancel path but kept for signature parity.) Consumed by
/// `stop_recall_sdk`, which is wired into the Tauri app-exit hook in `main.rs`.
const SIGKILL_DELAY: Duration = Duration::from_secs(5);

/// Log tag used by all `log()` calls in this module.
const LOG_TAG: &str = "recall-sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Bridge stdin (command channel)
// ─────────────────────────────────────────────────────────────────────────────
//
// The SDK bridge accepts ndjson commands on stdin so we can drive
// `RecallAiSdk.startRecording` / `stopRecording` without spawning a new
// process per recording. The `ChildStdin` handle is stored here when
// `run_process_with_stdin_impl` spawns the bridge; cleared when it exits.
//
// All access goes through `write_bridge_command()` which serialises the
// payload to JSON, appends `\n`, and flushes — matching the bridge's
// `readline` parser exactly. Failures are reported as `Err(String)`
// (typically "bridge not running") so the calling Tauri command can surface a
// clean error to the UI instead of panicking.

static BRIDGE_STDIN: OnceLock<Mutex<Option<ChildStdin>>> = OnceLock::new();

fn bridge_stdin_cell() -> &'static Mutex<Option<ChildStdin>> {
    BRIDGE_STDIN.get_or_init(|| Mutex::new(None))
}

/// Serialise a JSON value, append `\n`, and write to the bridge's stdin.
///
/// Returns `Err` when:
/// - The bridge isn't running (`stdin` handle missing — likely never spawned,
///   or already exited)
/// - The lock is poisoned (a previous writer panicked mid-write)
/// - The write or flush itself fails (broken pipe — bridge died)
///
/// The caller is responsible for any retry / recovery semantics; this function
/// intentionally has no implicit retry.
fn write_bridge_command(value: &serde_json::Value) -> Result<(), String> {
    let cell = bridge_stdin_cell();
    let mut guard = cell
        .lock()
        .map_err(|e| format!("bridge stdin lock poisoned: {e}"))?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "bridge not running".to_string())?;
    let line =
        serde_json::to_string(value).map_err(|e| format!("command serialise failed: {e}"))?;
    writeln!(stdin, "{line}").map_err(|e| format!("bridge stdin write failed: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("bridge stdin flush failed: {e}"))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Active-detection registry
// ─────────────────────────────────────────────────────────────────────────────
//
// The Recall SDK fires `meeting:detected` once when a meeting window appears
// and keeps no state of its own. The MeetingsWindow is created on demand (from
// the tray), so it misses any detection that fired before it existed. We retain
// the most recent detection per meeting window here so a freshly opened
// MeetingsWindow can seed its active-meeting rows via
// `meetings_list_active_detections` and show the in-progress meeting (with its
// Record control) immediately.
//
// Keyed by `window_id` (always populated by the current bridge; falls back to
// `meeting_url` defensively). Insert on `meeting:detected`, remove on
// `meeting:closed` — mirroring the frontend's upsert/remove lifecycle so the
// retained set and the live event stream converge on the same state.

static ACTIVE_DETECTIONS: OnceLock<Mutex<HashMap<String, MeetingDetectedEvent>>> = OnceLock::new();

fn active_detections_cell() -> &'static Mutex<HashMap<String, MeetingDetectedEvent>> {
    ACTIVE_DETECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Key a detection by its window id, falling back to the meeting URL when the
/// bridge omitted the window id (defensive — the current bridge always sets it).
fn detection_key(event: &MeetingDetectedEvent) -> String {
    event
        .window_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| event.meeting_url.clone())
}

/// Record (or replace) the retained detection for a meeting window.
fn record_active_detection(event: &MeetingDetectedEvent) {
    if let Ok(mut map) = active_detections_cell().lock() {
        map.insert(detection_key(event), event.clone());
    }
}

/// Drop the retained detection for a closed meeting window. The close event's
/// `window_id` is the same key the detection was inserted under (both come from
/// the bridge's window identity).
fn remove_active_detection(window_id: &str) {
    if let Ok(mut map) = active_detections_cell().lock() {
        map.remove(window_id);
    }
}

/// Snapshot of every retained detection (one per open meeting window). Order is
/// unspecified (HashMap); the frontend upsert is idempotent so order is moot.
fn active_detections_snapshot() -> Vec<MeetingDetectedEvent> {
    active_detections_cell()
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default()
}

/// Return the meeting detections currently retained in-process (one per open
/// meeting window). The MeetingsWindow calls this on mount to seed its active
/// rows with meetings detected *before* the window existed — the live
/// `meeting:detected` stream only covers detections that happen while a
/// listener is attached. Empty when the SDK isn't running or no meeting is open.
#[tauri::command]
pub async fn meetings_list_active_detections() -> Result<Vec<MeetingDetectedEvent>, String> {
    Ok(active_detections_snapshot())
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility gate
// ─────────────────────────────────────────────────────────────────────────────

/// Phase-0 allowlist for the meeting-detect-notify feature. Currently only the
/// project owner while the feature rolls out; widened to all `@getindigo.ai`
/// users in a later story (US-003). The gate keeps the SDK from starting — no
/// Recall API call, no sidecar process — for everyone outside the allowlist
/// during Phase 0.
const MEETING_DETECT_ALLOWLIST: &[&str] = &["stefan@getindigo.ai"];

/// Env-var override for QA: when set to `1`, force-enable the feature
/// regardless of the signed-in email. Lets a tester exercise the SDK on a
/// machine signed in as someone outside the allowlist without flipping the
/// allowlist itself.
const FORCE_ENV: &str = "HQ_SYNC_MEETING_DETECT_FORCE";

/// Cached per-session decision so we don't re-decode the id_token on every
/// callsite (start_recall_sdk + the Tauri command from the renderer). The
/// token is rotated on refresh but the email claim is stable across rotations,
/// so a process-lifetime cache is safe.
static CACHED_ELIGIBLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Returns true iff this user/process should run meeting detection in Phase 0.
///
/// Decision order:
///   1. `HQ_SYNC_MEETING_DETECT_FORCE=1` -> true (QA override).
///   2. Signed-in email in `MEETING_DETECT_ALLOWLIST` -> true.
///   3. Otherwise -> false.
///
/// Quiet on missing/malformed tokens (returns false rather than erroring) so a
/// signed-out user during launch doesn't crash setup.
pub async fn meeting_detect_eligible() -> bool {
    if let Some(v) = CACHED_ELIGIBLE.get() {
        return *v;
    }
    let enabled = compute_meeting_detect_eligible().await;
    let _ = CACHED_ELIGIBLE.set(enabled);
    enabled
}

async fn compute_meeting_detect_eligible() -> bool {
    // Env override wins first — needed for CI/QA on machines signed in as
    // someone outside the allowlist.
    if matches!(std::env::var(FORCE_ENV).ok().as_deref(), Some("1")) {
        log(LOG_TAG, "meeting_detect_eligible: forced via env override");
        return true;
    }

    let tokens = match cognito::get_tokens().await {
        Ok(Some(t)) => t,
        _ => return false,
    };
    let id_token = match tokens.id_token.as_deref() {
        Some(t) if !t.is_empty() => t,
        _ => return false,
    };
    let claims = match cognito::decode_id_token_claims(id_token) {
        Ok(c) => c,
        Err(_) => return false,
    };
    is_meeting_detect_allowed_email(claims.email.as_deref())
}

/// Pure helper — public for unit testing. Case-insensitive exact match
/// against the allowlist. Empty / `None` / malformed strings are rejected.
pub fn is_meeting_detect_allowed_email(email: Option<&str>) -> bool {
    match email {
        Some(s) if !s.is_empty() => {
            let lc = s.to_ascii_lowercase();
            MEETING_DETECT_ALLOWLIST
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(&lc))
        }
        _ => false,
    }
}

/// Tauri command exposing `meeting_detect_eligible` to the renderer so the
/// frontend can hide the meeting-detection toggle for users outside the
/// Phase 0 allowlist.
#[tauri::command]
pub async fn meeting_detect_feature_enabled() -> Result<bool, String> {
    Ok(meeting_detect_eligible().await)
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

/// Response shape for `GET /v1/recall/credentials`.
///
/// hq-pro returns this when the user has an active Recall integration.
/// The `api_key` is a short-lived token or a long-lived key depending on
/// the Recall tier — the SDK handles refresh internally once it has the
/// initial key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecallCredentials {
    api_key: String,
}

/// Fetch the user's Recall API key from hq-pro.
///
/// Returns `Ok(Some(key))` when the credentials endpoint responds 200 with
/// a valid `apiKey`. Returns `Ok(None)` when the endpoint responds 404 (the
/// user has no Recall integration yet) or when the credentials are empty.
/// Returns `Err` only on hard network / auth failures.
async fn fetch_recall_credentials() -> Result<Option<String>, String> {
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;

    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(format!("{base}/v1/recall/credentials"))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("recall/credentials fetch: {e}"))?;

    if res.status().as_u16() == 404 {
        return Ok(None);
    }

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("recall/credentials HTTP {status}: {body}"));
    }

    let text = res
        .text()
        .await
        .map_err(|e| format!("recall/credentials read: {e}"))?;

    let creds: RecallCredentials =
        serde_json::from_str(&text).map_err(|e| format!("recall/credentials parse: {e}"))?;

    if creds.api_key.is_empty() {
        return Ok(None);
    }

    Ok(Some(creds.api_key))
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary discovery
// ─────────────────────────────────────────────────────────────────────────────

/// Try to find the Recall Desktop SDK binary.
///
/// Search order:
///   1. Adjacent to the running executable (Tauri `externalBin` placement).
///      Also checks the arch-tagged Tauri form: `{bin}-aarch64-apple-darwin`
///      and `{bin}-x86_64-apple-darwin`.
///   2. On PATH via `paths::resolve_bin` (returns bare name when not found on
///      known prefixes — the process manager returns `NotFound` at spawn time,
///      which we catch and log as `RECALL_SDK_UNAVAILABLE`).
///
/// Returns `Some(path)` when the binary exists on disk, `None` otherwise.
fn find_sdk_binary() -> Option<String> {
    // The executable suffix and Tauri `externalBin` target-triple tags differ
    // per platform. On Windows the bundled sidecar is `recall-desktop-sdk.exe`
    // (and the arch-tagged form `recall-desktop-sdk-{triple}.exe`).
    #[cfg(target_os = "windows")]
    const EXE_SUFFIX: &str = ".exe";
    #[cfg(not(target_os = "windows"))]
    const EXE_SUFFIX: &str = "";

    #[cfg(target_os = "windows")]
    const ARCH_TRIPLES: &[&str] = &["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];
    #[cfg(not(target_os = "windows"))]
    const ARCH_TRIPLES: &[&str] = &["aarch64-apple-darwin", "x86_64-apple-darwin"];

    // 1. Check next to the running executable (release bundle).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Plain name (with the platform executable suffix).
            let plain = dir.join(format!("{SDK_BIN}{EXE_SUFFIX}"));
            if plain.exists() {
                return Some(plain.to_string_lossy().into_owned());
            }
            // Tauri arch-tagged `externalBin` names.
            for arch in ARCH_TRIPLES {
                let tagged = dir.join(format!("{SDK_BIN}-{arch}{EXE_SUFFIX}"));
                if tagged.exists() {
                    return Some(tagged.to_string_lossy().into_owned());
                }
            }
        }
    }

    // 2. Try PATH / known install prefixes.
    let resolved = paths::resolve_bin(SDK_BIN);
    // `resolve_bin` returns the bare name when nothing is found on known
    // prefixes. Check whether the result actually exists as an absolute path
    // on disk before accepting it (bare-name entries on PATH will fail at
    // spawn time — that's handled in the caller).
    if std::path::Path::new(&resolved).exists() {
        return Some(resolved);
    }

    // Not found anywhere we can verify statically — return the bare name so
    // the caller gets a clean `NotFound` from the OS rather than a confusing
    // panic. The calling code in `start_recall_sdk` maps spawn failure to
    // `RECALL_SDK_UNAVAILABLE`.
    //
    // Actually: return None so the caller can log RECALL_SDK_UNAVAILABLE
    // before even trying to spawn, giving a cleaner log message.
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdout protocol
// ─────────────────────────────────────────────────────────────────────────────

/// ndjson event shape emitted by the SDK bridge on stdout. The bridge
/// translates real Recall SDK callbacks into the lines we parse here.
///
/// Windows note: the upstream enum also carries `permission:status` /
/// `permissions:all-granted` variants for the macOS TCC permission surface.
/// Windows has no permission system, so those are intentionally NOT modelled —
/// the bridge still emits `permissions:all-granted` on Windows, which falls
/// through to `None` here and is silently ignored. Blank / unknown lines also
/// return `None`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum RecallSdkEvent {
    #[serde(rename = "meeting:detected")]
    MeetingDetected(MeetingDetectedEvent),
    #[serde(rename = "meeting:closed")]
    MeetingClosed(MeetingClosedEvent),
    #[serde(rename = "recording:started")]
    RecordingStarted(RecordingStartedEvent),
    #[serde(rename = "recording:ended")]
    RecordingEnded(RecordingEndedEvent),
    #[serde(rename = "recording:media-capture")]
    RecordingMediaCapture(RecordingMediaCaptureEvent),
    #[serde(rename = "recording:error")]
    RecordingError(RecordingErrorEvent),
}

/// Parse a single ndjson line from the SDK bridge. Blank lines and
/// unrecognised types (including the Windows `permissions:all-granted`
/// no-op) return `None`.
fn parse_sdk_line(line: &str) -> Option<RecallSdkEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<RecallSdkEvent>(trimmed).ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/// Start the Recall Desktop SDK sidecar.
///
/// Called once from `main.rs` setup inside a `tauri::async_runtime::spawn`.
/// On any failure (binary missing, credentials unavailable, spawn error) the
/// function logs `RECALL_SDK_UNAVAILABLE` and returns `Ok(())` — the menubar
/// app continues running normally.
pub async fn start_recall_sdk(app: AppHandle) -> Result<(), String> {
    log(LOG_TAG, "start_recall_sdk: initialising");

    // ── 0. Phase-0 eligibility gate ──────────────────────────────────────────
    // Locked to the Phase-0 allowlist during rollout. Skip silently for
    // everyone else — no SDK process, no Recall API call.
    if !meeting_detect_eligible().await {
        log(
            LOG_TAG,
            "start_recall_sdk: user not in Phase-0 allowlist — skipping (set HQ_SYNC_MEETING_DETECT_FORCE=1 to override)",
        );
        return Ok(());
    }

    // ── 1. Check the singleton — don't double-start ──────────────────────────
    if !try_register_handle(SDK_HANDLE) {
        log(LOG_TAG, "start_recall_sdk: already running (no-op)");
        return Ok(());
    }

    // ── 2. Find the SDK binary ───────────────────────────────────────────────
    let bin_path = match find_sdk_binary() {
        Some(p) => {
            log(LOG_TAG, &format!("start_recall_sdk: binary found at {p}"));
            p
        }
        None => {
            log(
                LOG_TAG,
                "RECALL_SDK_UNAVAILABLE: binary recall-desktop-sdk not found",
            );
            // Deregister so a future attempt (e.g. user installs the SDK and
            // restarts the app) is not blocked by the stale handle.
            crate::commands::process::deregister_process(SDK_HANDLE);
            return Ok(());
        }
    };

    // ── 3. Fetch Recall credentials from hq-pro ──────────────────────────────
    let api_key = match fetch_recall_credentials().await {
        Ok(Some(key)) => {
            log(LOG_TAG, "start_recall_sdk: credentials obtained");
            key
        }
        Ok(None) => {
            log(
                LOG_TAG,
                "RECALL_SDK_UNAVAILABLE: no Recall credentials configured",
            );
            crate::commands::process::deregister_process(SDK_HANDLE);
            return Ok(());
        }
        Err(e) => {
            log(
                LOG_TAG,
                &format!("RECALL_SDK_UNAVAILABLE: credentials fetch failed: {e}"),
            );
            crate::commands::process::deregister_process(SDK_HANDLE);
            return Ok(());
        }
    };

    // ── 4. Build SpawnArgs ───────────────────────────────────────────────────
    let mut env = HashMap::new();
    // Pass the API key via environment variable. The SDK reads RECALL_API_KEY
    // on startup and uses it to authenticate with the Recall cloud service.
    env.insert("RECALL_API_KEY".to_string(), api_key);
    // Include a sane PATH so the SDK binary can find its own dependencies
    // (Node modules, dylibs, etc.) in a Dock-launched context where launchd
    // provides a minimal PATH. Mirrors the sync runner spawn.
    env.insert("PATH".to_string(), paths::child_path());

    let spawn_args = SpawnArgs {
        cmd: bin_path,
        // `--json` tells the SDK to emit ndjson on stdout (Recall SDK CLI
        // convention; the flag name mirrors how hq-sync-runner works).
        args: vec!["--json".to_string()],
        cwd: None,
        env: Some(env),
    };

    // ── 5. Spawn in background ───────────────────────────────────────────────
    log(LOG_TAG, "start_recall_sdk: spawning SDK process");

    let app_bg = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_process_with_stdin_impl(
            SDK_HANDLE,
            &spawn_args,
            |event| match event {
                ProcessEvent::Stdout(line) => {
                    log("recall-sdk.stdout", &line);
                    match parse_sdk_line(&line) {
                        Some(RecallSdkEvent::MeetingDetected(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "meeting:detected — id={} platform={:?} url={}",
                                    payload.detection_id, payload.platform, payload.meeting_url
                                ),
                            );
                            // Record into the active-detection registry so a
                            // MeetingsWindow opened *after* this fired can seed
                            // its rows via `meetings_list_active_detections`.
                            record_active_detection(&payload);
                            if let Err(e) = app_bg.emit(EVENT_MEETING_DETECTED, &payload) {
                                log(LOG_TAG, &format!("emit meeting:detected failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::MeetingClosed(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "meeting:closed — windowId={} platform={:?}",
                                    payload.window_id, payload.platform
                                ),
                            );
                            // Drop from the registry so a freshly opened window
                            // won't seed a meeting that has already ended.
                            remove_active_detection(&payload.window_id);
                            if let Err(e) = app_bg.emit(EVENT_MEETING_CLOSED, &payload) {
                                log(LOG_TAG, &format!("emit meeting:closed failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::RecordingStarted(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "recording:started — windowId={} platform={:?}",
                                    payload.window_id, payload.platform
                                ),
                            );
                            if let Err(e) = app_bg.emit(EVENT_RECORDING_STARTED, &payload) {
                                log(LOG_TAG, &format!("emit recording:started failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::RecordingEnded(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "recording:ended — windowId={} platform={:?}",
                                    payload.window_id, payload.platform
                                ),
                            );
                            if let Err(e) = app_bg.emit(EVENT_RECORDING_ENDED, &payload) {
                                log(LOG_TAG, &format!("emit recording:ended failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::RecordingMediaCapture(payload)) => {
                            // High-frequency event during a recording — log
                            // only the capturing transition. The Tauri event is
                            // still emitted with full detail for the UI badges.
                            log(
                                LOG_TAG,
                                &format!(
                                    "recording:media-capture — windowId={} type={} capturing={}",
                                    payload.window_id, payload.capture_type, payload.capturing
                                ),
                            );
                            if let Err(e) = app_bg.emit(EVENT_RECORDING_MEDIA_CAPTURE, &payload) {
                                log(
                                    LOG_TAG,
                                    &format!("emit recording:media-capture failed: {e}"),
                                );
                            }
                        }
                        Some(RecallSdkEvent::RecordingError(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "recording:error — cmd={} windowId={} message={}",
                                    payload.cmd, payload.window_id, payload.message
                                ),
                            );
                            if let Err(e) = app_bg.emit(EVENT_RECORDING_ERROR, &payload) {
                                log(LOG_TAG, &format!("emit recording:error failed: {e}"));
                            }
                        }
                        None => {}
                    }
                }
                ProcessEvent::Stderr(line) => {
                    log("recall-sdk.stderr", &line);
                }
                ProcessEvent::Exit {
                    code,
                    signal,
                    success,
                } => {
                    log(
                        LOG_TAG,
                        &format!(
                            "SDK exited: success={} code={:?} signal={:?}",
                            success, code, signal
                        ),
                    );
                    // Clear the stashed stdin handle so a subsequent
                    // start_recording call returns a clean "bridge not running"
                    // error instead of writing into a closed pipe.
                    if let Ok(mut guard) = bridge_stdin_cell().lock() {
                        *guard = None;
                    }
                }
            },
            |child| {
                // Stash the bridge's stdin so the `start_recording` /
                // `stop_recording` Tauri commands can write commands to it. The
                // handle stays alive for the lifetime of the bridge process;
                // cleared on ProcessEvent::Exit above.
                if let Some(stdin) = child.stdin.take() {
                    match bridge_stdin_cell().lock() {
                        Ok(mut guard) => {
                            *guard = Some(stdin);
                            log(LOG_TAG, "bridge stdin handle registered");
                        }
                        Err(e) => {
                            log(
                                LOG_TAG,
                                &format!("bridge stdin lock poisoned at spawn: {e}"),
                            );
                        }
                    }
                } else {
                    log(LOG_TAG, "bridge spawned without stdin pipe (unexpected)");
                }
            },
        );

        if let Err(e) = result {
            log(
                LOG_TAG,
                &format!("RECALL_SDK_UNAVAILABLE: spawn failed: {e}"),
            );
        }
    });

    Ok(())
}

/// Tear down the running SDK bridge process (Windows: `TerminateJobObject` via
/// the Job Object supervisor; the "SIGTERM/SIGKILL" wording is macOS legacy).
///
/// Wired into the Tauri app-exit cleanup hook in `main.rs`
/// (`RunEvent::ExitRequested`). Safe to call when the SDK is not running —
/// `cancel_process_impl` is a no-op in that case.
pub fn stop_recall_sdk() {
    cancel_process_impl(SDK_HANDLE, SIGKILL_DELAY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording control (start / stop)
// ─────────────────────────────────────────────────────────────────────────────

/// Response shape for `POST /v1/recall/upload-token` on hq-pro.
///
/// hq-pro mints a one-shot Recall.ai SDK upload token via Recall's
/// `/api/v2/sdk-upload/` endpoint and returns the token + the durable
/// Recording id. The token is consumed by `RecallAiSdk.startRecording` inside
/// the bridge.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdkUploadTokenResponse {
    /// Recall.ai Recording UUID — stable handle for the recording.
    id: String,
    /// One-shot token consumed by `RecallAiSdk.startRecording({ uploadToken })`.
    upload_token: String,
}

/// Fetch a fresh SDK upload token from hq-pro.
///
/// Returns `(recordingId, uploadToken)` on success. Errors when hq-pro rejects
/// (`recall-not-provisioned`, upstream Recall failure, network) — the caller
/// surfaces the message to the UI.
///
/// `company_uid` (when present) is passed as `?companyId=<uid>` so the
/// upload-token mint can stamp Recall recording `metadata` with the company
/// context for the server-side webhook router. The bot-* routes use the same
/// `companyId` query param, so the SDK-recording attribution slot lines up with
/// the rest of the recording surface.
async fn fetch_sdk_upload_token(company_uid: Option<&str>) -> Result<(String, String), String> {
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;

    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let mut url = format!("{base}/v1/recall/upload-token");
    if let Some(uid) = company_uid.filter(|u| !u.is_empty()) {
        url = format!("{url}?companyId={uid}");
    }

    let res = build_client()
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("upload-token fetch: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("upload-token read: {e}"))?;

    if !status.is_success() {
        return Err(format!("upload-token HTTP {status}: {text}"));
    }

    let parsed: SdkUploadTokenResponse = serde_json::from_str(&text)
        .map_err(|e| format!("upload-token parse: {e} — body: {text}"))?;

    if parsed.id.is_empty() || parsed.upload_token.is_empty() {
        return Err(format!(
            "upload-token response missing id or token — body: {text}"
        ));
    }

    Ok((parsed.id, parsed.upload_token))
}

/// Start a local recording for the given SDK window.
///
/// Pre-conditions checked before the bridge command is sent:
/// - The user is in the meeting-detect allowlist (same gate as detection)
/// - The bridge is running (stdin handle present)
///
/// Side effects on success:
/// - hq-pro mints a fresh `uploadToken`
/// - The bridge starts the SDK recording, which streams audio + metadata to
///   Recall.ai. A `recording:started` event follows asynchronously when the SDK
///   confirms.
///
/// Returns the Recall.ai `recordingId` so the caller can stash it alongside the
/// windowId for a later transcript fetch.
///
/// NOTE (US-003): the upstream macOS build also marks the meeting `Recorded` in
/// the detect-notify dedup ledger here so a later `meeting:detected` re-fire is
/// suppressed. That ledger (`util::meeting_ledger`) is owned by US-003 and does
/// not exist on this fork yet — wire the `record_action(Recorded)` call here
/// once US-003 lands the ledger.
#[tauri::command]
pub async fn start_recording(
    window_id: String,
    company_uid: Option<String>,
) -> Result<String, String> {
    if !meeting_detect_eligible().await {
        return Err("user not in meeting-detect allowlist".to_string());
    }
    if window_id.trim().is_empty() {
        return Err("window_id is required".to_string());
    }

    // Normalise empty / whitespace-only values to None so the URL query doesn't
    // get an empty `?companyId=`. The frontend defaults to `null` for Personal
    // and the user-picked dropdown can also produce `""` if the membership list
    // races empty on first render.
    let company_uid = company_uid
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    log(
        LOG_TAG,
        &format!(
            "start_recording: requested for windowId={window_id}, company={}",
            company_uid.as_deref().unwrap_or("(personal)"),
        ),
    );

    let (recording_id, upload_token) = match fetch_sdk_upload_token(company_uid.as_deref()).await {
        Ok(v) => v,
        Err(e) => {
            // Surface the upstream HTTP status + body verbatim so post-deploy
            // issues (route 404, auth 401, Recall 5xx) are diagnosable from the
            // log alone — without this the Rust-side failure was opaque.
            log(
                LOG_TAG,
                &format!(
                    "start_recording: upload-token fetch failed for windowId={window_id}: {e}"
                ),
            );
            return Err(e);
        }
    };
    log(
        LOG_TAG,
        &format!(
            "start_recording: minted token (recordingId={recording_id}) for windowId={window_id}"
        ),
    );

    let cmd = serde_json::json!({
        "cmd": "start-recording",
        "windowId": window_id,
        "uploadToken": upload_token,
    });
    write_bridge_command(&cmd)?;

    Ok(recording_id)
}

/// Stop the active recording for the given SDK window.
///
/// Idempotent — issuing stop against a window that isn't recording is a
/// bridge-side no-op (the SDK silently ignores). Always returns `Ok(())` unless
/// the bridge isn't running.
#[tauri::command]
pub async fn stop_recording(window_id: String) -> Result<(), String> {
    if !meeting_detect_eligible().await {
        return Err("user not in meeting-detect allowlist".to_string());
    }
    if window_id.trim().is_empty() {
        return Err("window_id is required".to_string());
    }

    log(
        LOG_TAG,
        &format!("stop_recording: requested for windowId={window_id}"),
    );

    let cmd = serde_json::json!({
        "cmd": "stop-recording",
        "windowId": window_id,
    });
    write_bridge_command(&cmd)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{DetectionSource, MeetingPlatform};

    /// Parse a line known to be a `meeting:detected`, unwrapping the enum.
    fn meeting(line: &str) -> MeetingDetectedEvent {
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::MeetingDetected(m) => m,
            other => panic!("expected MeetingDetected, got {:?}", other),
        }
    }

    #[test]
    fn parse_sdk_line_returns_none_for_empty() {
        assert!(parse_sdk_line("").is_none());
        assert!(parse_sdk_line("   ").is_none());
    }

    #[test]
    fn parse_sdk_line_returns_none_for_unknown_type() {
        let line = r#"{"type":"health-check","status":"ok"}"#;
        assert!(parse_sdk_line(line).is_none());
    }

    #[test]
    fn parse_sdk_line_returns_none_for_windows_permissions_all_granted() {
        // Windows has no permission system; the bridge still emits this no-op
        // line. We don't model the variant, so it must parse to None (ignored)
        // rather than erroring.
        let line = r#"{"type":"permissions:all-granted"}"#;
        assert!(parse_sdk_line(line).is_none());
    }

    #[test]
    fn parse_sdk_line_returns_none_for_malformed_json() {
        assert!(parse_sdk_line("not json at all").is_none());
        assert!(parse_sdk_line("{unclosed").is_none());
    }

    #[test]
    fn parse_sdk_line_parses_meeting_detected_zoom() {
        let line = r#"{"type":"meeting:detected","detectionId":"det_1","meetingUrl":"https://zoom.us/j/999","platform":"zoom","detectedAt":"2026-05-20T10:00:00Z","source":"sdk-calendar","sourceEventId":"evt_abc"}"#;
        let payload = meeting(line);
        assert_eq!(payload.detection_id, "det_1");
        assert_eq!(payload.meeting_url, "https://zoom.us/j/999");
        assert_eq!(payload.platform, MeetingPlatform::Zoom);
        assert_eq!(payload.source, DetectionSource::SdkCalendar);
        assert_eq!(payload.source_event_id.as_deref(), Some("evt_abc"));
    }

    #[test]
    fn parse_sdk_line_parses_meeting_detected_active_app() {
        let line = r#"{"type":"meeting:detected","detectionId":"det_2","meetingUrl":"https://meet.google.com/abc-def","platform":"meet","detectedAt":"2026-05-20T11:00:00Z","source":"sdk-active-app"}"#;
        let payload = meeting(line);
        assert_eq!(payload.platform, MeetingPlatform::Meet);
        assert_eq!(payload.source, DetectionSource::SdkActiveApp);
        assert!(payload.source_event_id.is_none());
    }

    #[test]
    fn parse_sdk_line_parses_meeting_detected_with_window_id() {
        let line = r#"{"type":"meeting:detected","detectionId":"det_w","meetingUrl":"recall-window:w-9","windowId":"w-9","platform":"zoom","detectedAt":"2026-05-20T11:00:00Z","source":"sdk-active-app"}"#;
        let payload = meeting(line);
        assert_eq!(payload.window_id.as_deref(), Some("w-9"));
    }

    #[test]
    fn parse_sdk_line_handles_leading_whitespace() {
        let line = r#"  {"type":"meeting:detected","detectionId":"det_3","meetingUrl":"https://zoom.us/j/1","platform":"zoom","detectedAt":"2026-05-20T12:00:00Z","source":"sdk-active-app"}  "#;
        let payload = meeting(line);
        assert_eq!(payload.detection_id, "det_3");
    }

    #[test]
    fn parse_sdk_line_parses_other_platform() {
        let line = r#"{"type":"meeting:detected","detectionId":"det_4","meetingUrl":"https://webex.com/meet/abc","platform":"webex","detectedAt":"2026-05-20T13:00:00Z","source":"sdk-calendar"}"#;
        let payload = meeting(line);
        assert_eq!(payload.platform, MeetingPlatform::Webex);
    }

    // ── Recording lifecycle + meeting:closed parsing (US-002) ─────────────────

    #[test]
    fn parse_sdk_line_parses_meeting_closed() {
        let line = r#"{"type":"meeting:closed","windowId":"w-1","platform":"zoom","closedAt":"2026-05-25T17:00:00Z"}"#;
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::MeetingClosed(p) => {
                assert_eq!(p.window_id, "w-1");
                assert_eq!(p.platform, MeetingPlatform::Zoom);
            }
            other => panic!("expected MeetingClosed, got {:?}", other),
        }
    }

    #[test]
    fn parse_sdk_line_parses_recording_started() {
        let line = r#"{"type":"recording:started","windowId":"win-1","platform":"zoom","startedAt":"2026-05-25T17:00:00Z"}"#;
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::RecordingStarted(p) => {
                assert_eq!(p.window_id, "win-1");
                assert_eq!(p.platform, MeetingPlatform::Zoom);
                assert_eq!(p.started_at, "2026-05-25T17:00:00Z");
            }
            other => panic!("expected RecordingStarted, got {:?}", other),
        }
    }

    #[test]
    fn parse_sdk_line_parses_recording_ended() {
        let line = r#"{"type":"recording:ended","windowId":"win-1","platform":"meet","endedAt":"2026-05-25T17:30:00Z"}"#;
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::RecordingEnded(p) => {
                assert_eq!(p.window_id, "win-1");
                assert_eq!(p.platform, MeetingPlatform::Meet);
                assert_eq!(p.ended_at, "2026-05-25T17:30:00Z");
            }
            other => panic!("expected RecordingEnded, got {:?}", other),
        }
    }

    #[test]
    fn parse_sdk_line_parses_recording_media_capture() {
        let line = r#"{"type":"recording:media-capture","windowId":"win-1","captureType":"audio","capturing":true}"#;
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::RecordingMediaCapture(p) => {
                assert_eq!(p.window_id, "win-1");
                assert_eq!(p.capture_type, "audio");
                assert!(p.capturing);
            }
            other => panic!("expected RecordingMediaCapture, got {:?}", other),
        }
    }

    #[test]
    fn parse_sdk_line_parses_recording_error() {
        let line = r#"{"type":"recording:error","cmd":"start-recording","windowId":"win-1","message":"upload token rejected"}"#;
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::RecordingError(p) => {
                assert_eq!(p.cmd, "start-recording");
                assert_eq!(p.window_id, "win-1");
                assert_eq!(p.message, "upload token rejected");
            }
            other => panic!("expected RecordingError, got {:?}", other),
        }
    }

    // ── Active-detection registry (seed for late-opened MeetingsWindow) ───────

    #[test]
    fn active_detection_registry_records_and_removes() {
        // Use a unique windowId so this test doesn't collide with any other
        // test mutating the process-global registry.
        let win = format!("test-win-{}", uuid::Uuid::new_v4());
        let line = format!(
            r#"{{"type":"meeting:detected","detectionId":"d","meetingUrl":"recall-window:{win}","windowId":"{win}","platform":"zoom","detectedAt":"2026-05-25T17:00:00Z","source":"sdk-active-app"}}"#
        );
        let payload = meeting(&line);
        record_active_detection(&payload);
        assert!(
            active_detections_snapshot()
                .iter()
                .any(|d| d.window_id.as_deref() == Some(win.as_str())),
            "detection should be retained after record"
        );
        remove_active_detection(&win);
        assert!(
            !active_detections_snapshot()
                .iter()
                .any(|d| d.window_id.as_deref() == Some(win.as_str())),
            "detection should be gone after remove"
        );
    }

    #[test]
    fn write_bridge_command_errs_when_bridge_not_running() {
        // No bridge spawned in unit tests → stdin cell is None → clean Err
        // rather than a panic. Guards the "Record while SDK absent" UX path.
        let cmd = serde_json::json!({"cmd":"stop-recording","windowId":"w"});
        let err = write_bridge_command(&cmd).expect_err("should error with no bridge");
        assert!(err.contains("bridge not running"), "got: {err}");
    }

    #[test]
    fn find_sdk_binary_returns_none_when_not_installed() {
        // In CI / dev environments without the Recall Desktop SDK installed,
        // find_sdk_binary() must return None (not panic). This is the
        // RECALL_SDK_UNAVAILABLE path exercised by the E2E test "binary missing".
        //
        // We can't assert None always (a dev may have installed the SDK), but we
        // can assert the function doesn't panic.
        let _ = find_sdk_binary(); // must not panic
    }

    // ── Eligibility gate (Phase-0 allowlist) ──────────────────────────────────

    #[test]
    fn meeting_detect_allowlist_accepts_stefan_exact() {
        assert!(is_meeting_detect_allowed_email(Some("stefan@getindigo.ai")));
    }

    #[test]
    fn meeting_detect_allowlist_case_insensitive() {
        // Cognito sometimes returns emails with non-canonical casing.
        assert!(is_meeting_detect_allowed_email(Some("Stefan@GetIndigo.ai")));
        assert!(is_meeting_detect_allowed_email(Some("STEFAN@GETINDIGO.AI")));
    }

    #[test]
    fn meeting_detect_allowlist_rejects_domain_only() {
        // Domain match is NOT enough — Phase 0 is exact-address-only.
        assert!(!is_meeting_detect_allowed_email(Some(
            "teammate@getindigo.ai"
        )));
    }

    #[test]
    fn meeting_detect_allowlist_rejects_lookalike() {
        assert!(!is_meeting_detect_allowed_email(Some(
            "stefan@forgetindigo.ai"
        )));
        assert!(!is_meeting_detect_allowed_email(Some(
            "stefan+test@getindigo.ai"
        )));
        assert!(!is_meeting_detect_allowed_email(Some(
            "notstefan@getindigo.ai"
        )));
    }

    #[test]
    fn meeting_detect_allowlist_rejects_missing_and_empty() {
        assert!(!is_meeting_detect_allowed_email(None));
        assert!(!is_meeting_detect_allowed_email(Some("")));
    }

    #[test]
    fn meeting_detect_allowlist_rejects_other_domains() {
        assert!(!is_meeting_detect_allowed_email(Some("stefan@example.com")));
        assert!(!is_meeting_detect_allowed_email(Some("stefan@gmail.com")));
    }
}
