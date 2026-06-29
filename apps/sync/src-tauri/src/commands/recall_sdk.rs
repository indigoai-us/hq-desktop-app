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
//! ## Keyless by design
//!
//! The Recall Desktop SDK is **keyless** — `init()` takes only the region
//! `apiUrl`, and each recording is authorized solely by a per-recording,
//! company-scoped **upload token** (`POST /v1/recall/upload-token`; see
//! `fetch_sdk_upload_token`). No account-wide Recall API key is fetched or
//! injected into the sidecar. An account-wide key would be a security
//! exposure: it controls every bot + every recording/transcript across the
//! whole Recall account, and Recall has no scoped keys. hq-pro PR #300 stopped
//! `GET /v1/recall/credentials` from returning the real key; this client no
//! longer reads it at all (`build_sdk_spawn_env` is regression-tested keyless).
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
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter};

use crate::commands::cognito;
use crate::commands::process::{
    cancel_process_impl, run_process_with_stdin_impl, try_register_handle, ProcessEvent, SpawnArgs,
};
use crate::commands::sync::resolve_vault_api_url;
use crate::events::{
    MeetingDetectedEvent, EVENT_MEETING_CLOSED, EVENT_MEETING_DETECTED,
    EVENT_PERMISSIONS_ALL_GRANTED, EVENT_PERMISSION_STATUS, EVENT_RECORDING_ENDED,
    EVENT_RECORDING_ERROR, EVENT_RECORDING_MEDIA_CAPTURE, EVENT_RECORDING_STARTED,
};
use crate::util::client_info::build_client;
use crate::util::logfile::log;
use crate::util::recordings_ledger::{self, ReconcileOutcome, RecordingStatus};

#[allow(unused_imports)]
pub use hq_desktop_core::recall_sdk::{
    active_detections_cell, active_detections_snapshot, active_recordings_from_ledger,
    bridge_stdin_cell, build_sdk_spawn_env, detection_key, detection_url_and_event,
    find_sdk_binary, is_meeting_detect_allowed_email, mark_recorded_for_window, parse_sdk_line,
    pick_recording_handle, record_active_detection, remove_active_detection,
    synthesize_bridge_exit_errors, write_bridge_command, ActiveRecording, BotStatusResponse,
    RecallSdkEvent, SdkUploadTokenResponse, BRIDGE_EXIT_CMD, BRIDGE_EXIT_ERROR_MESSAGE,
    EVENT_RECORDING_RECONCILED, FORCE_ENV, LOG_TAG, SDK_BIN,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Singleton handle in `PROCESS_REGISTRY`.
const SDK_HANDLE: &str = "recall-sdk";

/// SIGKILL grace period after SIGTERM on app shutdown.
const SIGKILL_DELAY: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Active-detection registry
// ─────────────────────────────────────────────────────────────────────────────
//
// The Recall SDK fires `meeting:detected` once when a meeting window appears
// and keeps no state of its own. The classic popover's `main` window is alive
// from launch so it never misses the event, but the Indigo desktop-alt window
// is created on demand (e.g. from a notification click) and therefore misses
// any detection that fired before it existed. We retain the most recent
// detection per meeting window here so a freshly opened desktop-alt window can
// seed `$activeMeetings` via `meetings_list_active_detections` and show the
// in-progress meeting (with its Record control) immediately.
//
// Keyed by `window_id` (always populated by the current bridge; falls back to
// `meeting_url` defensively). Insert on `meeting:detected`, remove on
// `meeting:closed` — mirroring the frontend's upsert/remove lifecycle so the
// retained set and the live event stream converge on the same state.

/// Return the meeting detections currently retained in-process (one per open
/// meeting window). The Indigo desktop-alt window calls this on mount to seed
/// `$activeMeetings` with meetings detected *before* the window existed — the
/// live `meeting:detected` stream only covers detections that happen while a
/// listener is attached. Empty when the SDK isn't running or no meeting is open.
#[tauri::command]
pub async fn meetings_list_active_detections() -> Result<Vec<MeetingDetectedEvent>, String> {
    Ok(active_detections_snapshot())
}

/// List the recordings currently in flight, read from the on-disk recordings
/// ledger (`~/.hq/recordings-ledger.json`). Complements
/// `meetings_list_active_detections`: detections seed *detected* rows, this
/// seeds *recording* rows so a window opened after a recording began (e.g. the
/// on-demand desktop-alt window, which missed the live `recording:started`)
/// shows it as Recording rather than a stale Detected. Fail-soft to empty — a
/// missing or corrupt ledger must never blank the Meetings UX.
#[tauri::command]
pub async fn meetings_list_active_recordings() -> Result<Vec<ActiveRecording>, String> {
    Ok(active_recordings_from_ledger(
        recordings_ledger::read_ledger().unwrap_or_default(),
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility gate
// ─────────────────────────────────────────────────────────────────────────────

/// Feature flag for the meeting-detect-notify + Desktop SDK recording
/// feature. **GA — any signed-in user.** Matches the broader
/// `meetings_feature_enabled` gate so the full meeting-pipeline UX
/// (calendar + bot + SDK recording) lights up together for every signed-in
/// user and stays dark only for the signed-out.
///
/// Was a single-user allowlist (`stefan@getindigo.ai`) during the
/// 2026-05-26 dogfood, then widened to the `@getindigo.ai` domain; graduated
/// to GA (present-email) alongside the rest of the expanded desktop window.
///
/// Env-var override for QA: when set to `1`, force-enable the feature
/// regardless of the signed-in email. Lets a tester exercise the SDK on a
/// machine signed in as someone outside the allowlist without flipping the
/// allowlist itself.
/// Cached per-session decision so we don't re-decode the id_token on every
/// callsite (start_recall_sdk + main.rs setup + Tauri command from the
/// renderer). The token is rotated on refresh but the email claim is stable
/// across rotations, so a process-lifetime cache is safe. Same pattern as
/// `meetings::CACHED_FLAG`.
static CACHED_ELIGIBLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Returns true iff this user/process should run meeting detection.
///
/// Decision order:
///   1. `HQ_SYNC_MEETING_DETECT_FORCE=1` → true (QA override).
///   2. A signed-in user (non-empty email claim) → true (GA).
///   3. Otherwise → false.
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

/// Tauri command exposing `meeting_detect_eligible` to the renderer so the
/// frontend can hide the permissions banner / Settings section / meeting
/// detection toggle for users outside the Phase 0 allowlist.
#[tauri::command]
pub async fn meeting_detect_feature_enabled() -> Result<bool, String> {
    Ok(meeting_detect_eligible().await)
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyless: no account-wide Recall API key
// ─────────────────────────────────────────────────────────────────────────────

// The Recall Desktop SDK is keyless: `init()` takes only the region `apiUrl`
// (set in the sidecar) and each recording is authorized by a per-recording,
// company-scoped upload token from `POST /v1/recall/upload-token` (see
// `fetch_sdk_upload_token` below). No account-wide Recall API key is fetched or
// injected into the sidecar's environment — `build_sdk_spawn_env` is the single
// place the spawn env is built, and it is regression-tested to stay keyless
// (`sdk_spawn_env_is_keyless`). hq-pro PR #300 already stopped
// `GET /v1/recall/credentials` from returning the real key; this client no
// longer reads that endpoint at all.

// ─────────────────────────────────────────────────────────────────────────────
// Binary discovery
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Stdout protocol
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/// Start the Recall Desktop SDK sidecar.
///
/// Called from `main.rs` setup inside a `tauri::async_runtime::spawn` (only
/// once the required macOS permissions are already granted), and also as a
/// Tauri command from the Settings → Meeting permissions wizard right after
/// the user grants those permissions — so meeting-detect starts working
/// immediately without waiting for the next app launch.
///
/// Idempotent: the singleton handle check (`try_register_handle`) makes a
/// second call a no-op while the SDK is already running.
///
/// On any failure (binary missing, spawn error) the function logs
/// `RECALL_SDK_UNAVAILABLE` and returns `Ok(())` — the menubar app continues
/// running normally.
#[tauri::command]
pub async fn start_recall_sdk(app: AppHandle) -> Result<(), String> {
    log(LOG_TAG, "start_recall_sdk: initialising");

    // ── 0. Signed-in eligibility gate (GA) ────────────────────────────────────
    // Feature is GA — gated to any signed-in user, matching
    // `meetings_feature_enabled` so the full meeting-pipeline UX lights up
    // together. Skip silently for the signed-out: no SDK process, no Recall
    // API call, no permission prompts. (Was a single-user Phase-0 allowlist
    // during the 2026-05-26 dogfood, then `@getindigo.ai`-only; graduated to
    // GA alongside the expanded desktop window.)
    if !meeting_detect_eligible().await {
        log(
            LOG_TAG,
            "start_recall_sdk: no signed-in user — skipping (set HQ_SYNC_MEETING_DETECT_FORCE=1 to override)",
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

    // ── 3. Build SpawnArgs (keyless — no Recall API key) ─────────────────────
    // The Recall Desktop SDK is keyless: no account-wide API key is fetched or
    // injected (see the "Keyless" note above). The SDK initialises with only
    // the region apiUrl, and recording is authorized per-recording by the
    // upload token (`fetch_sdk_upload_token`). `build_sdk_spawn_env` is the
    // single, regression-tested place the spawn env is assembled.
    let spawn_args = SpawnArgs {
        cmd: bin_path,
        // `--json` tells the SDK to emit ndjson on stdout (Recall SDK CLI
        // convention; the flag name mirrors how hq-sync-runner works).
        args: vec!["--json".to_string()],
        cwd: None,
        env: Some(build_sdk_spawn_env()),
    };

    // ── 4. Spawn in background ───────────────────────────────────────────────
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
                            // Record into the active-detection registry so an
                            // on-demand desktop-alt window opened *after* this
                            // fired can seed `$activeMeetings` via
                            // `meetings_list_active_detections`.
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
                            // Drop from the active-detection registry so a
                            // freshly opened desktop-alt window won't seed a
                            // meeting that has already ended.
                            remove_active_detection(&payload.window_id);
                            if let Err(e) = app_bg.emit(EVENT_MEETING_CLOSED, &payload) {
                                log(LOG_TAG, &format!("emit meeting:closed failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::PermissionStatus(payload)) => {
                            log(
                                LOG_TAG,
                                &format!(
                                    "permission:status — {:?} → {}",
                                    payload.permission, payload.status
                                ),
                            );
                            if let Err(e) = app_bg.emit(EVENT_PERMISSION_STATUS, &payload) {
                                log(LOG_TAG, &format!("emit permission:status failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::PermissionsAllGranted {}) => {
                            log(LOG_TAG, "permissions:all-granted");
                            if let Err(e) = app_bg.emit(EVENT_PERMISSIONS_ALL_GRANTED, &()) {
                                log(
                                    LOG_TAG,
                                    &format!("emit permissions:all-granted failed: {e}"),
                                );
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
                            // Clean terminal event: drop the in-flight ledger
                            // entry so the next launch has nothing to reconcile
                            // for this window. This is the canonical clear path
                            // (covers both explicit Stop and the SDK
                            // auto-stopping when the meeting window closes).
                            if let Err(e) = recordings_ledger::record_ended(&payload.window_id) {
                                log(
                                    LOG_TAG,
                                    &format!(
                                        "recording:ended — failed to clear ledger entry for windowId={}: {e}",
                                        payload.window_id
                                    ),
                                );
                            }
                            if let Err(e) = app_bg.emit(EVENT_RECORDING_ENDED, &payload) {
                                log(LOG_TAG, &format!("emit recording:ended failed: {e}"));
                            }
                        }
                        Some(RecallSdkEvent::RecordingMediaCapture(payload)) => {
                            // High-frequency event during a recording — log
                            // only the binary capturing transition. The
                            // Tauri event is still emitted with full detail
                            // for the UI to render audio/video badges.
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
                    // start_recording call returns a clean "bridge not
                    // running" error instead of writing into a closed pipe.
                    if let Ok(mut guard) = bridge_stdin_cell().lock() {
                        *guard = None;
                    }

                    // ── Terminal event on unexpected sidecar death (B3) ──────
                    // The bridge synthesizes its own terminal recording:error
                    // when the *SDK* crashes (bridge.mjs::failActiveRecordings).
                    // But if the bridge *process itself* dies — SIGSEGV, OOM,
                    // panic, killed — it can't emit anything, so any row the user
                    // had in `recording`/`stopping` would hang until (at best)
                    // the 12s stop-watchdog, and only if they'd pressed Stop.
                    // Mirror failActiveRecordings here: for every windowId the
                    // durable ledger still has in flight, synthesize a terminal
                    // recording:error so the UI resolves the row immediately.
                    //
                    // Skip a *deliberate* teardown (app quit → stop_recall_sdk →
                    // cancel_process_impl marks the handle cancelled): emitting a
                    // scary error while the app is closing is wrong, and a
                    // genuinely in-flight recording is recovered by the launch
                    // reconcile instead. `success` covers a clean exit(0); the
                    // cancelled flag covers a SIGTERM'd one (non-zero/​signalled).
                    let cancelled = crate::commands::process::is_cancelled(SDK_HANDLE);
                    if success || cancelled {
                        log(
                            LOG_TAG,
                            &format!(
                                "SDK exit treated as orderly (success={success} cancelled={cancelled}) — no terminal recording:error synthesized; any in-flight recording is left for the launch reconcile",
                            ),
                        );
                    } else {
                        fail_active_recordings_on_exit(&app_bg, code, signal);
                    }
                }
            },
            |child| {
                // Stash the bridge's stdin so `start_recording` / `stop_recording`
                // Tauri commands can write commands to it. The handle stays
                // alive for the lifetime of the bridge process; cleared on
                // ProcessEvent::Exit above.
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

/// Send SIGTERM (then SIGKILL after grace) to the running SDK process.
///
/// Called from the Tauri cleanup hook or the quit command. Safe to call when
/// the SDK is not running — `cancel_process_impl` is a no-op in that case.
pub fn stop_recall_sdk() {
    cancel_process_impl(SDK_HANDLE, SIGKILL_DELAY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal event on unexpected sidecar death (B3 residual)
// ─────────────────────────────────────────────────────────────────────────────

/// Mirror the bridge's `failActiveRecordings` from the Rust side when the
/// sidecar *process* dies: read every in-flight windowId from the durable
/// ledger, synthesize a terminal `recording:error` for each, emit it to the
/// renderer, and clear the ledger so the launch reconcile doesn't double-report
/// the same death.
///
/// Best-effort: a ledger read/clear failure is logged, not propagated (the SDK
/// task is already unwinding). Emitting the terminal events is the user-facing
/// priority; ledger hygiene is secondary.
fn fail_active_recordings_on_exit(app: &AppHandle, code: Option<i32>, signal: Option<i32>) {
    // Clear-and-take the open windowIds in one shot so the entries can't also
    // re-surface through the launch reconcile (the terminal event below IS the
    // resolution). On a read/clear failure fall back to a plain read so we can
    // still emit — losing the clear is acceptable (reconcile would re-report,
    // not lose data); losing the emit is the actual hang we're fixing.
    let window_ids = match recordings_ledger::record_bridge_died() {
        Ok(ids) => ids,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("bridge-exit: failed to clear recordings ledger: {e}"),
            );
            recordings_ledger::open_window_ids().unwrap_or_default()
        }
    };

    if window_ids.is_empty() {
        log(
            LOG_TAG,
            "bridge-exit: no in-flight recordings to fail (nothing to surface)",
        );
        return;
    }

    let events = synthesize_bridge_exit_errors(&window_ids, code, signal);
    log(
        LOG_TAG,
        &format!(
            "bridge-exit: synthesizing terminal recording:error for {} in-flight recording(s)",
            events.len()
        ),
    );
    for ev in &events {
        if let Err(e) = app.emit(EVENT_RECORDING_ERROR, ev) {
            log(
                LOG_TAG,
                &format!(
                    "bridge-exit: emit recording:error failed for windowId={}: {e}",
                    ev.window_id
                ),
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording control (start / stop)
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch a fresh SDK upload token from hq-pro.
///
/// Returns `(recordingId, uploadToken)` on success. Errors when hq-pro
/// rejects (`recall-not-provisioned`, upstream Recall failure, network) —
/// caller surfaces the message to the UI.
async fn fetch_sdk_upload_token(company_uid: Option<&str>) -> Result<(String, String), String> {
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;

    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    // The bot-* routes use ?companyId=… as the canonical company-context
    // query param (see `bot.controller.ts` router). Mirror that here so
    // the SDK-recording path's attribution slot lines up with the rest of
    // the recording surface — hq-pro reads it from the same place, validates
    // the membership, and bakes companyUid+slug+name into the Recall
    // recording's `metadata` so the webhook handler can route it later.
    //
    // Empty body is preserved — `recording_config` belongs there if/when we
    // expose transcript-provider knobs to the UI. Company context goes on
    // the URL because it's a request-scope parameter, not a Recall API
    // payload field.
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

    if parsed.upload_token.is_empty() {
        return Err(format!(
            "upload-token response missing upload token — body: {text}"
        ));
    }

    // The recordings ledger keys on the Recall *recording* id — the same handle
    // the `sdk_upload.complete` webhook and the landed `sources/meetings/{id}.md`
    // source object use. hq-pro returns it as `recordingId`. We fall back to the
    // sdk-upload `id` only when hq-pro omitted it (older server). Log the
    // fallback so the (re-broken) source correlation is visible rather than
    // silently storing the wrong id.
    let used_recording_id = parsed
        .recording_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();

    let recording_id = match pick_recording_handle(parsed.recording_id.as_deref(), &parsed.id) {
        Some(rid) => rid,
        None => {
            return Err(format!(
                "upload-token response missing both recordingId and id — body: {text}"
            ));
        }
    };

    if !used_recording_id {
        log(
            LOG_TAG,
            "fetch_sdk_upload_token: hq-pro returned no recordingId — \
             falling back to sdk-upload id (source correlation may break)",
        );
    }

    Ok((recording_id, parsed.upload_token))
}

/// Start a local recording for the given SDK window.
///
/// Pre-conditions checked before the bridge command is sent:
/// - The user is signed in (GA gate — same gate as detection)
/// - The bridge is running (stdin handle present)
///
/// Side effects on success:
/// - hq-pro mints a fresh `uploadToken`
/// - The bridge starts the SDK recording, which streams audio + metadata
///   to Recall.ai. A `recording:started` event will follow asynchronously
///   when the SDK confirms.
///
/// Returns the Recall.ai `recordingId` so the caller can stash it
/// alongside the windowId for later transcript fetch.
#[tauri::command]
pub async fn start_recording(
    window_id: String,
    company_uid: Option<String>,
) -> Result<String, String> {
    if !meeting_detect_eligible().await {
        return Err("recording requires a signed-in user".to_string());
    }
    if window_id.trim().is_empty() {
        return Err("window_id is required".to_string());
    }

    // Normalise empty / whitespace-only values to None so the URL query
    // doesn't get an empty `?companyId=`. The frontend defaults to
    // `null` for Personal and the user-picked dropdown can also produce
    // `""` if the membership list races empty on first render.
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
            // Without this log line the Rust-side failure was opaque to
            // debugging — the user saw an "Error" badge but no visible
            // reason. Surface the upstream HTTP status + body verbatim so
            // post-deploy issues (route 404, auth 401, Recall 5xx) are
            // diagnosable from `~/.hq/logs/hq-sync.log` alone.
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

    // Persist the in-flight mapping to the durable ledger BEFORE we tell the
    // bridge to start. If the app is force-quit (or crashes) mid-recording, the
    // next launch reconciles this entry — without it the windowId→recordingId
    // mapping lives only in the in-memory Svelte store and is lost on restart,
    // silently orphaning a recording Recall still holds server-side. Best-effort:
    // a ledger-write failure is logged but must not block the recording from
    // starting (the recording itself is the user's primary intent).
    if let Err(e) = recordings_ledger::record_started(
        window_id.clone(),
        recording_id.clone(),
        company_uid.clone(),
        Utc::now(),
    ) {
        log(
            LOG_TAG,
            &format!(
                "start_recording: failed to persist recordings ledger entry for windowId={window_id} (recording continues): {e}"
            ),
        );
    }

    let cmd = serde_json::json!({
        "cmd": "start-recording",
        "windowId": window_id,
        "uploadToken": upload_token,
    });
    write_bridge_command(&cmd)?;

    // The user explicitly recorded this meeting — authoritatively mark it
    // `Recorded` in the notify ledger so a later `meeting:detected` for the same
    // meeting (e.g. an SDK re-fire) doesn't re-notify. Best-effort; the
    // `claim_notify` lock is the primary dedup guard.
    mark_recorded_for_window(&window_id);

    Ok(recording_id)
}

/// Stop the active recording for the given SDK window.
///
/// Idempotent — issuing stop against a window that isn't recording is a
/// bridge-side no-op (the SDK silently ignores). Always returns `Ok(())`
/// unless the bridge isn't running.
#[tauri::command]
pub async fn stop_recording(window_id: String) -> Result<(), String> {
    if !meeting_detect_eligible().await {
        return Err("recording requires a signed-in user".to_string());
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
// Launch reconcile (in-flight recordings ledger)
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch one recording's server-side status from hq-pro, mapped onto the
/// ledger's normalised [`RecordingStatus`].
///
/// HTTP 404 → `not_found` (the recording never finalised server-side — a lost
/// ingest, not "still processing"). Any other non-2xx or a network error is an
/// `Err` so the reconcile classifies it as transient (`Unknown`) and retries on
/// a later launch rather than dropping the recording.
async fn fetch_recording_status(
    recording_id: &str,
    _company_uid: Option<&str>,
) -> Result<RecordingStatus, String> {
    let base = resolve_vault_api_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .map_err(|e| format!("vault url: {e}"))?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let url = format!("{base}/v1/bot/{recording_id}/status");
    let res = build_client()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("status fetch: {e}"))?;

    let http = res.status();
    if http.as_u16() == 404 {
        return Ok(RecordingStatus {
            status: "not-found".to_string(),
            source_landed: false,
            not_found: true,
        });
    }

    let text = res.text().await.map_err(|e| format!("status read: {e}"))?;
    if !http.is_success() {
        return Err(format!("status HTTP {http}: {text}"));
    }

    let parsed: BotStatusResponse =
        serde_json::from_str(&text).map_err(|e| format!("status parse: {e} — body: {text}"))?;
    Ok(RecordingStatus {
        status: parsed.status,
        source_landed: parsed.source_landed,
        not_found: false,
    })
}

/// Reconcile any in-flight recordings left over from a previous run.
///
/// Called once from `main.rs` setup (gated on the same meeting-detect
/// eligibility as the SDK boot). Reads the durable ledger, asks hq-pro for each
/// still-open recording's status, classifies it, persists the trimmed ledger,
/// and emits one [`EVENT_RECORDING_RECONCILED`] per non-transient outcome so
/// the UI surfaces the thread.
///
/// Best-effort: every failure is logged and swallowed. A corrupt / unreadable
/// ledger is treated as empty so a bad file never blocks launch.
pub async fn reconcile_recordings_on_launch(app: AppHandle) {
    let mut ledger = match recordings_ledger::read_ledger() {
        Ok(l) => l,
        Err(e) => {
            // Treat a corrupt ledger as empty (don't block launch). Logged so a
            // recurring corruption is visible in the diagnostic log.
            log(
                LOG_TAG,
                &format!("reconcile: ledger unreadable, treating as empty: {e}"),
            );
            return;
        }
    };

    if ledger.is_empty() {
        return;
    }

    log(
        LOG_TAG,
        &format!(
            "reconcile: {} in-flight recording(s) left over from a previous run — reconciling",
            ledger.len()
        ),
    );

    // The ledger's `reconcile` takes a synchronous fetcher, but the real status
    // call is async. Pre-fetch every recording's status into a map first, then
    // hand `reconcile` a closure that just looks the result up. This keeps the
    // (heavily unit-tested) classify/prune logic synchronous while the I/O
    // stays async.
    let mut statuses: HashMap<String, Result<RecordingStatus, String>> = HashMap::new();
    for entry in ledger.values() {
        if statuses.contains_key(&entry.recording_id) {
            continue;
        }
        let result =
            fetch_recording_status(&entry.recording_id, entry.company_uid.as_deref()).await;
        statuses.insert(entry.recording_id.clone(), result);
    }

    let outcomes = recordings_ledger::reconcile(&mut ledger, Utc::now(), |recording_id, _co| {
        statuses
            .get(recording_id)
            .cloned()
            .unwrap_or_else(|| Err("status not pre-fetched".to_string()))
    });

    // Persist the trimmed ledger (terminal entries removed, in-flight retained).
    if let Err(e) = recordings_ledger::write_ledger(&ledger) {
        log(
            LOG_TAG,
            &format!("reconcile: failed to persist trimmed ledger: {e}"),
        );
    }

    // Surface each outcome. Transient `Unknown` outcomes are retained in the
    // ledger and not shown to the user (they retry on a later launch).
    for outcome in &outcomes {
        match outcome {
            ReconcileOutcome::Unknown {
                recording_id,
                reason,
                ..
            } => {
                log(
                    LOG_TAG,
                    &format!(
                        "reconcile: recordingId={recording_id} status unknown (will retry next launch): {reason}"
                    ),
                );
            }
            other => {
                log(LOG_TAG, &format!("reconcile: {other:?}"));
                if let Err(e) = app.emit(EVENT_RECORDING_RECONCILED, other) {
                    log(LOG_TAG, &format!("emit recording:reconciled failed: {e}"));
                }
            }
        }
    }
}
