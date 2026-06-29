//! Pure Recall Desktop SDK data types, parsers, validators, and builders.
//!
//! This module intentionally contains no Tauri commands and no async network
//! layer. The app crate owns request execution, process lifecycle, and bridge
//! stdin state; this crate owns the synchronous SDK contract surface.

use std::collections::HashMap;
use std::io::Write;
use std::process::ChildStdin;
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::events::{
    MeetingClosedEvent, MeetingDetectedEvent, PermissionStatusEvent, RecordingEndedEvent,
    RecordingErrorEvent, RecordingMediaCaptureEvent, RecordingStartedEvent,
};
use crate::recordings_ledger;

/// Name of the Recall Desktop SDK binary.
pub const SDK_BIN: &str = "recall-desktop-sdk";

/// Feature flag for the meeting-detect-notify + Desktop SDK recording feature.
pub const FORCE_ENV: &str = "HQ_SYNC_MEETING_DETECT_FORCE";

/// Human-readable message stamped on a synthesized terminal `recording:error`
/// when the SDK sidecar process dies unexpectedly.
pub const BRIDGE_EXIT_ERROR_MESSAGE: &str =
    "Recording engine exited unexpectedly — the recording may not have been saved.";

/// The `cmd` field used on a synthesized bridge-death `recording:error`.
pub const BRIDGE_EXIT_CMD: &str = "bridge-exit";

/// Tauri event channel for a reconciled in-flight recording.
pub const EVENT_RECORDING_RECONCILED: &str = "recording:reconciled";

/// Log tag used by all `log()` calls in this module.
pub const LOG_TAG: &str = "recall-sdk";

static BRIDGE_STDIN: OnceLock<Mutex<Option<ChildStdin>>> = OnceLock::new();

pub fn bridge_stdin_cell() -> &'static Mutex<Option<ChildStdin>> {
    BRIDGE_STDIN.get_or_init(|| Mutex::new(None))
}

/// Serialise a JSON value, append `\n`, and write to the bridge's stdin.
pub fn write_bridge_command(value: &serde_json::Value) -> Result<(), String> {
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

static ACTIVE_DETECTIONS: OnceLock<Mutex<HashMap<String, MeetingDetectedEvent>>> = OnceLock::new();

pub fn active_detections_cell() -> &'static Mutex<HashMap<String, MeetingDetectedEvent>> {
    ACTIVE_DETECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Key a detection by its window id, falling back to the meeting URL when the
/// bridge omitted the window id.
pub fn detection_key(event: &MeetingDetectedEvent) -> String {
    event
        .window_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| event.meeting_url.clone())
}

/// Record (or replace) the retained detection for a meeting window.
pub fn record_active_detection(event: &MeetingDetectedEvent) {
    if let Ok(mut map) = active_detections_cell().lock() {
        map.insert(detection_key(event), event.clone());
    }
}

/// Drop the retained detection for a closed meeting window.
pub fn remove_active_detection(window_id: &str) {
    if let Ok(mut map) = active_detections_cell().lock() {
        map.remove(window_id);
    }
}

/// Snapshot of every retained detection (one per open meeting window).
pub fn active_detections_snapshot() -> Vec<MeetingDetectedEvent> {
    active_detections_cell()
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default()
}

/// Look up the retained detection for `window_id` and return its meeting URL +
/// source event id.
pub fn detection_url_and_event(window_id: &str) -> Option<(String, Option<String>)> {
    active_detections_cell().lock().ok().and_then(|map| {
        map.get(window_id)
            .map(|e| (e.meeting_url.clone(), e.source_event_id.clone()))
    })
}

/// Authoritatively mark the meeting behind `window_id` as `Recorded` in the
/// notify ledger.
pub fn mark_recorded_for_window(window_id: &str) {
    use crate::meeting_ledger::{record_action, stable_key, LedgerAction};
    let Some((meeting_url, source_event_id)) = detection_url_and_event(window_id) else {
        return;
    };
    if let Some(key) = stable_key(Some(meeting_url.as_str()), source_event_id.as_deref()) {
        record_action(&key, LedgerAction::Recorded, Utc::now());
        crate::logfile::log(
            LOG_TAG,
            &format!("notify-ledger: marked Recorded for windowId={window_id}"),
        );
    }
}

/// One in-flight recording from the on-disk recordings ledger, surfaced to the
/// renderer (serde camelCase).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    pub window_id: String,
    pub recording_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_uid: Option<String>,
    pub started_at: String,
}

/// Pure mapping: recordings ledger (`windowId` → entry) → renderer rows.
pub fn active_recordings_from_ledger(
    ledger: recordings_ledger::RecordingsLedger,
) -> Vec<ActiveRecording> {
    ledger
        .into_iter()
        .map(|(window_id, entry)| ActiveRecording {
            window_id,
            recording_id: entry.recording_id,
            company_uid: entry.company_uid,
            started_at: entry.started_at,
        })
        .collect()
}

/// Pure helper — GA gate: true for any signed-in user (non-empty email claim),
/// regardless of domain.
pub fn is_meeting_detect_allowed_email(email: Option<&str>) -> bool {
    crate::feature_gate::email_present(email)
}

/// Try to find the Recall Desktop SDK binary.
pub fn find_sdk_binary() -> Option<String> {
    // 1. Check next to the running executable (release bundle).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Plain name.
            let plain = dir.join(SDK_BIN);
            if plain.exists() {
                return Some(plain.to_string_lossy().into_owned());
            }
            // Tauri arch-tagged names for macOS universal builds.
            for arch in &["aarch64-apple-darwin", "x86_64-apple-darwin"] {
                let tagged = dir.join(format!("{}-{}", SDK_BIN, arch));
                if tagged.exists() {
                    return Some(tagged.to_string_lossy().into_owned());
                }
            }
        }
    }

    // 2. Try PATH / known install prefixes.
    let resolved = crate::paths::resolve_bin(SDK_BIN);
    if std::path::Path::new(&resolved).exists() {
        return Some(resolved);
    }

    None
}

/// ndjson event shape emitted by the SDK bridge on stdout.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum RecallSdkEvent {
    #[serde(rename = "meeting:detected")]
    MeetingDetected(MeetingDetectedEvent),
    #[serde(rename = "meeting:closed")]
    MeetingClosed(MeetingClosedEvent),
    #[serde(rename = "permission:status")]
    PermissionStatus(PermissionStatusEvent),
    /// Convenience signal — all required perms granted. No payload.
    #[serde(rename = "permissions:all-granted")]
    PermissionsAllGranted {},
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
/// unrecognised types return `None`.
pub fn parse_sdk_line(line: &str) -> Option<RecallSdkEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<RecallSdkEvent>(trimmed).ok()
}

/// Build the environment for the Recall SDK sidecar spawn.
pub fn build_sdk_spawn_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), crate::paths::child_path());
    env
}

/// Build one terminal [`RecordingErrorEvent`] per still-open windowId after an
/// unexpected sidecar exit.
pub fn synthesize_bridge_exit_errors(
    open_window_ids: &[String],
    code: Option<i32>,
    signal: Option<i32>,
) -> Vec<RecordingErrorEvent> {
    let detail = match (code, signal) {
        (_, Some(sig)) => format!(" (signal {sig})"),
        (Some(c), None) => format!(" (exit code {c})"),
        (None, None) => String::new(),
    };
    open_window_ids
        .iter()
        .map(|window_id| RecordingErrorEvent {
            cmd: BRIDGE_EXIT_CMD.to_string(),
            window_id: window_id.clone(),
            message: format!("{BRIDGE_EXIT_ERROR_MESSAGE}{detail}"),
        })
        .collect()
}

/// Response shape for `POST /v1/recall/upload-token` on hq-pro.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkUploadTokenResponse {
    /// SDK-upload record id (UUID).
    pub id: String,
    /// Recall.ai Recording UUID.
    pub recording_id: Option<String>,
    /// One-shot token consumed by `RecallAiSdk.startRecording({ uploadToken })`.
    pub upload_token: String,
}

/// Choose the durable recording handle the recordings ledger should store from
/// an `/v1/recall/upload-token` response.
pub fn pick_recording_handle(recording_id: Option<&str>, sdk_upload_id: &str) -> Option<String> {
    if let Some(rid) = recording_id.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(rid.to_string());
    }
    let id = sdk_upload_id.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Subset of hq-pro `GET /v1/bot/{botId}/status` the reconcile needs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotStatusResponse {
    #[serde(default)]
    pub status: String,
    /// US-010 source-landed signal.
    #[serde(default)]
    pub source_landed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{DetectionSource, MeetingPlatform, RecallPermission};

    fn meeting(line: &str) -> MeetingDetectedEvent {
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::MeetingDetected(m) => m,
            other => panic!("expected MeetingDetected, got {:?}", other),
        }
    }

    fn permission(line: &str) -> PermissionStatusEvent {
        match parse_sdk_line(line).expect("should parse") {
            RecallSdkEvent::PermissionStatus(p) => p,
            other => panic!("expected PermissionStatus, got {:?}", other),
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

    #[test]
    fn parse_sdk_line_parses_permission_status() {
        let line =
            r#"{"type":"permission:status","permission":"screen-capture","status":"denied"}"#;
        let payload = permission(line);
        assert_eq!(payload.permission, RecallPermission::ScreenCapture);
        assert_eq!(payload.status, "denied");
    }

    #[test]
    fn parse_sdk_line_parses_all_granted() {
        let line = r#"{"type":"permissions:all-granted"}"#;
        assert!(matches!(
            parse_sdk_line(line),
            Some(RecallSdkEvent::PermissionsAllGranted {})
        ));
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

    #[test]
    fn sdk_spawn_env_is_keyless() {
        // Regression: the Recall Desktop SDK is keyless by design. Recording is
        // authorized per-recording by the company-scoped upload token
        // (`/v1/recall/upload-token`), NOT an account-wide Recall API key, so the
        // sidecar spawn env must never carry RECALL_API_KEY. A leaked account key
        // controls every bot + every recording/transcript across the whole Recall
        // account (Recall has no scoped keys) — the exposure hq-pro PR #300 closed
        // by no longer returning the real key from `/v1/recall/credentials`. This
        // client stopped fetching it entirely; `build_sdk_spawn_env` is the single
        // place the env is assembled, so pinning it here keeps the SDK keyless.
        let env = build_sdk_spawn_env();
        assert!(
            !env.contains_key("RECALL_API_KEY"),
            "Recall SDK spawn must stay keyless — found RECALL_API_KEY in the spawn env"
        );
        // PATH is still required so the SDK binary resolves its Node/dylib deps
        // under launchd's minimal PATH (Dock-launched context).
        assert!(
            env.contains_key("PATH"),
            "spawn env should still set PATH for the launchd minimal-PATH context"
        );
    }

    #[test]
    fn active_recordings_from_ledger_maps_every_entry() {
        // Regression for the desktop-alt "stuck on Detected" bug: the on-demand
        // window seeds recording state from this mapping (via
        // `meetings_list_active_recordings`), so a recording started *before* the
        // window opened — which missed the live `recording:started` event — shows
        // as Recording, not a stale Detected.
        use crate::recordings_ledger::{RecordingEntry, RecordingsLedger};
        let mut ledger: RecordingsLedger = std::collections::HashMap::new();
        ledger.insert(
            "win-1".to_string(),
            RecordingEntry {
                recording_id: "rec_1".to_string(),
                company_uid: Some("cmp_1".to_string()),
                started_at: "2026-06-06T14:57:05Z".to_string(),
            },
        );
        ledger.insert(
            "win-2".to_string(),
            RecordingEntry {
                recording_id: "rec_2".to_string(),
                company_uid: None,
                started_at: "2026-06-06T15:00:00Z".to_string(),
            },
        );
        let mut rows = active_recordings_from_ledger(ledger);
        rows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].window_id, "win-1");
        assert_eq!(rows[0].recording_id, "rec_1");
        assert_eq!(rows[0].company_uid.as_deref(), Some("cmp_1"));
        assert_eq!(rows[1].window_id, "win-2");
        assert_eq!(rows[1].company_uid, None);
    }

    #[test]
    fn active_recordings_from_empty_ledger_is_empty() {
        let rows = active_recordings_from_ledger(std::collections::HashMap::new());
        assert!(rows.is_empty());
    }

    #[test]
    fn active_recording_serializes_camelcase() {
        // The renderer (activeMeetings.ts `BackendActiveRecording`) reads
        // camelCase keys: windowId / recordingId / companyUid / startedAt.
        let row = ActiveRecording {
            window_id: "win-1".to_string(),
            recording_id: "rec_1".to_string(),
            company_uid: Some("cmp_1".to_string()),
            started_at: "2026-06-06T14:57:05Z".to_string(),
        };
        let json = serde_json::to_string(&row).expect("serialize");
        assert!(json.contains("\"windowId\":\"win-1\""), "json: {json}");
        assert!(json.contains("\"recordingId\":\"rec_1\""), "json: {json}");
        assert!(json.contains("\"companyUid\":\"cmp_1\""), "json: {json}");
        assert!(
            json.contains("\"startedAt\":\"2026-06-06T14:57:05Z\""),
            "json: {json}"
        );
    }

    // ── Eligibility gate (GA — signed-in feature flag) ────────────────────────
    //
    // The recording/detection gate graduated from the `@getindigo.ai`
    // dogfood to GA: it now admits any signed-in user (non-empty email
    // claim) and rejects only the signed-out, delegating to
    // `feature_gate::email_present`. Tests below pin the GA presence
    // semantics.

    #[test]
    fn meeting_detect_admits_any_getindigo_user() {
        assert!(is_meeting_detect_allowed_email(Some("stefan@getindigo.ai")));
        assert!(is_meeting_detect_allowed_email(Some(
            "teammate@getindigo.ai"
        )));
        assert!(is_meeting_detect_allowed_email(Some("anyone@getindigo.ai")));
    }

    #[test]
    fn meeting_detect_admits_non_indigo_users_under_ga() {
        // GA: the gate no longer requires the `@getindigo.ai` domain.
        assert!(is_meeting_detect_allowed_email(Some("stefan@example.com")));
        assert!(is_meeting_detect_allowed_email(Some("stefan@gmail.com")));
        assert!(is_meeting_detect_allowed_email(Some("admin@indigo.ai")));
        // Former dogfood look-alikes — now admitted, GA only checks presence.
        assert!(is_meeting_detect_allowed_email(Some(
            "stefan@forgetindigo.ai"
        )));
        assert!(is_meeting_detect_allowed_email(Some(
            "stefan@notgetindigo.ai"
        )));
        assert!(is_meeting_detect_allowed_email(Some(
            "stefan@evil-getindigo.ai"
        )));
    }

    #[test]
    fn meeting_detect_admits_plus_addressing() {
        assert!(is_meeting_detect_allowed_email(Some(
            "stefan+test@getindigo.ai"
        )));
        assert!(is_meeting_detect_allowed_email(Some("qa+tag@example.com")));
    }

    #[test]
    fn meeting_detect_rejects_signed_out() {
        // Only the signed-out (missing / empty / whitespace-only) is rejected.
        assert!(!is_meeting_detect_allowed_email(None));
        assert!(!is_meeting_detect_allowed_email(Some("")));
        assert!(!is_meeting_detect_allowed_email(Some("   ")));
    }

    #[test]
    fn meeting_detect_matches_meetings_feature_enabled() {
        // The two gates should agree — they're parallel GA checks (present
        // email) from different sites in the codebase. If the broader
        // `meetings_feature_enabled` ever diverges from this one, the menubar
        // UI surfaces and the SDK boot will disagree about who's signed in.
        use crate::feature_gate::email_present;
        for email in [
            "stefan@getindigo.ai",
            "Anyone@GetIndigo.AI",
            "stefan@gmail.com",
            "stefan@forgetindigo.ai",
            "",
            "   ",
        ] {
            assert_eq!(
                is_meeting_detect_allowed_email(Some(email)),
                email_present(Some(email)),
                "gate disagreement for {email}",
            );
        }
        assert_eq!(is_meeting_detect_allowed_email(None), email_present(None),);
    }

    // ── Recording event parsing ────────────────────────────────────────────
    //
    // The bridge emits these on stdout after the SDK responds to a
    // startRecording/stopRecording command, or when a meeting window
    // closes and the SDK auto-ends the recording. Parser is the bottleneck
    // — if these break, recording state on the UI side desyncs from reality.

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

    // ── Recording-handle selection (recordingId vs sdk-upload id) ───────────
    //
    // The recordings ledger must store the Recall *recording* id — the handle
    // the `sdk_upload.complete` webhook and the landed `sources/meetings/{id}.md`
    // source object key on. hq-pro returns it as `recordingId` (distinct from
    // the sdk-upload `id`). Before this fix the client stored the sdk-upload id
    // and could never correlate a recording to its landed source.

    #[test]
    fn pick_recording_handle_prefers_recording_id() {
        assert_eq!(
            pick_recording_handle(Some("rec-xyz"), "sdkup-abc"),
            Some("rec-xyz".to_string()),
        );
    }

    #[test]
    fn pick_recording_handle_falls_back_to_sdk_upload_id_when_absent() {
        // Older hq-pro that didn't return recordingId — recording still works,
        // just with the legacy (uncorrelatable) handle.
        assert_eq!(
            pick_recording_handle(None, "sdkup-abc"),
            Some("sdkup-abc".to_string()),
        );
    }

    #[test]
    fn pick_recording_handle_treats_blank_recording_id_as_absent() {
        assert_eq!(
            pick_recording_handle(Some("   "), "sdkup-abc"),
            Some("sdkup-abc".to_string()),
        );
    }

    #[test]
    fn pick_recording_handle_trims_both_candidates() {
        assert_eq!(
            pick_recording_handle(Some("  rec-xyz  "), "sdkup-abc"),
            Some("rec-xyz".to_string()),
        );
        assert_eq!(
            pick_recording_handle(None, "  sdkup-abc  "),
            Some("sdkup-abc".to_string()),
        );
    }

    #[test]
    fn pick_recording_handle_none_when_both_blank() {
        assert_eq!(pick_recording_handle(Some("  "), "   "), None);
        assert_eq!(pick_recording_handle(None, ""), None);
    }

    #[test]
    fn sdk_upload_token_response_deserialises_camelcase_recording_id() {
        // hq-pro emits camelCase `recordingId`; serde(rename_all=camelCase)
        // maps it onto the Rust `recording_id` field.
        let body = r#"{"id":"sdkup-1","recordingId":"rec-1","uploadToken":"ut-1"}"#;
        let parsed: SdkUploadTokenResponse = serde_json::from_str(body).expect("parse");
        assert_eq!(parsed.id, "sdkup-1");
        assert_eq!(parsed.recording_id.as_deref(), Some("rec-1"));
        assert_eq!(parsed.upload_token, "ut-1");
        assert_eq!(
            pick_recording_handle(parsed.recording_id.as_deref(), &parsed.id),
            Some("rec-1".to_string()),
        );
    }

    #[test]
    fn sdk_upload_token_response_tolerates_missing_recording_id() {
        // An older hq-pro response with no recordingId must still parse (the
        // field is Option) so recording isn't broken — it just falls back.
        let body = r#"{"id":"sdkup-2","uploadToken":"ut-2"}"#;
        let parsed: SdkUploadTokenResponse = serde_json::from_str(body).expect("parse");
        assert_eq!(parsed.recording_id, None);
        assert_eq!(
            pick_recording_handle(parsed.recording_id.as_deref(), &parsed.id),
            Some("sdkup-2".to_string()),
        );
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

    // ── Terminal event on unexpected sidecar death (B3 residual) ───────────────
    //
    // When the bridge *process* dies it cannot run its own
    // failActiveRecordings, so `ProcessEvent::Exit` synthesizes the terminal
    // recording:error for every in-flight windowId. These cover the pure
    // mapping; the ledger read/clear + emit glue is exercised by the
    // recordings_ledger tests (record_bridge_died / open_window_ids) and, in the
    // real app, by the wired ProcessEvent::Exit handler.

    #[test]
    fn bridge_exit_errors_one_per_open_window_with_terminal_cmd() {
        let ids = vec!["win-1".to_string(), "win-2".to_string()];
        let events = synthesize_bridge_exit_errors(&ids, None, Some(11));
        assert_eq!(events.len(), 2);
        // Every synthesized event uses the dedicated bridge-exit cmd (so the UI
        // and logs can tell it from a real start/stop-recording failure) and a
        // message that tells the user the recording may not have been saved.
        for ev in &events {
            assert_eq!(ev.cmd, BRIDGE_EXIT_CMD);
            assert!(
                ev.message.contains("exited unexpectedly"),
                "message should explain the engine died: {}",
                ev.message
            );
            assert!(
                ev.message.contains("may not have been saved"),
                "message should warn about lost recording: {}",
                ev.message
            );
        }
        let windows: Vec<&str> = events.iter().map(|e| e.window_id.as_str()).collect();
        assert!(windows.contains(&"win-1"));
        assert!(windows.contains(&"win-2"));
    }

    #[test]
    fn bridge_exit_errors_empty_when_nothing_in_flight() {
        // The common case: the sidecar dies with no active recording — there is
        // no row to resolve, so no terminal event is produced.
        let events = synthesize_bridge_exit_errors(&[], Some(1), None);
        assert!(events.is_empty());
    }

    #[test]
    fn bridge_exit_error_message_includes_signal_detail() {
        // A SIGKILL/SIGSEGV death stamps the signal so triage can see *how* the
        // sidecar died straight from the row's error text.
        let ids = vec!["win-1".to_string()];
        let events = synthesize_bridge_exit_errors(&ids, None, Some(9));
        assert!(
            events[0].message.contains("signal 9"),
            "expected signal detail in: {}",
            events[0].message
        );
    }

    #[test]
    fn bridge_exit_error_message_includes_exit_code_detail() {
        // A non-zero plain exit (no signal) stamps the code instead.
        let ids = vec!["win-1".to_string()];
        let events = synthesize_bridge_exit_errors(&ids, Some(2), None);
        assert!(
            events[0].message.contains("exit code 2"),
            "expected exit-code detail in: {}",
            events[0].message
        );
    }

    #[test]
    fn bridge_exit_error_parses_back_as_recording_error_event() {
        // The synthesized event must round-trip through the same
        // serde shape the renderer consumes on the `recording:error` channel
        // (serde camelCase): cmd / windowId / message.
        let ids = vec!["win-xyz".to_string()];
        let event = &synthesize_bridge_exit_errors(&ids, None, Some(15))[0];
        let json = serde_json::to_string(event).expect("serialize");
        assert!(json.contains("\"windowId\":\"win-xyz\""));
        assert!(json.contains("\"cmd\":\"bridge-exit\""));
        let parsed: RecordingErrorEvent = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(parsed, *event);
    }
}
