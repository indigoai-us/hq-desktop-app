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

use crate::recordings_ledger;
use hq_desktop_core::events::{
    MeetingClosedEvent, MeetingDetectedEvent, PermissionStatusEvent, RecordingEndedEvent,
    RecordingErrorEvent, RecordingMediaCaptureEvent, RecordingStartedEvent,
};

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
        hq_desktop_core::logfile::log(
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
    hq_desktop_core::feature_gate::email_present(email)
}

/// Filename of the SDK bridge entrypoint (an ES module run under node).
pub const BRIDGE_ENTRY: &str = "bridge.mjs";

/// Directory name the bridge is installed into (bundle resources + repo sidecar).
pub const BRIDGE_DIR: &str = "recall-sdk-bridge";

/// Ad-hoc override for the bridge entrypoint, honoured on every non-Windows
/// platform. Preserves the dev ergonomics the retired bash wrapper offered.
pub const BRIDGE_PATH_ENV: &str = "RECALL_BRIDGE_PATH";

/// The flag that puts the bridge into ndjson-on-stdout mode (Recall SDK CLI
/// convention; mirrors how hq-sync-runner is invoked).
pub const SDK_JSON_FLAG: &str = "--json";

/// A resolved, ready-to-spawn Recall SDK invocation.
///
/// Windows spawns the compiled PE launcher directly. macOS/Linux spawn
/// `node <…>/recall-sdk-bridge/bridge.mjs` — see [`resolve_sdk_command`] for
/// why the macOS bundle deliberately has no `Contents/MacOS` sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkCommand {
    /// Program to exec.
    pub program: String,
    /// Full argv tail, `--json` included.
    pub args: Vec<String>,
}

// ── Windows: the compiled externalBin launcher ───────────────────────────────
//
// Windows ships a real PE32+ Node SEA (see sidecar/recall-sdk-bridge/build.mjs)
// as `bundle.externalBin`, so it is spawned by path exactly as before. Its
// signature is embedded in the PE itself and is unaffected by the macOS
// xattr/tar problem that motivated the macOS change below.

/// Tauri sidecar target triples for the Windows bundle (arch-tagged names).
/// Windows binaries also carry an `.exe` suffix (`std::env::consts::EXE_SUFFIX`).
#[cfg(target_os = "windows")]
const SDK_ARCH_TRIPLES: &[&str] = &["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];

#[cfg(target_os = "windows")]
fn sdk_binary_candidate_names() -> Vec<String> {
    let exe_suffix = std::env::consts::EXE_SUFFIX; // ".exe" on windows
    std::iter::once(format!("{SDK_BIN}{exe_suffix}"))
        .chain(
            SDK_ARCH_TRIPLES
                .iter()
                .map(|arch| format!("{SDK_BIN}-{arch}{exe_suffix}")),
        )
        .collect()
}

/// Try to find the Recall Desktop SDK launcher binary (Windows only).
#[cfg(target_os = "windows")]
pub fn find_sdk_binary() -> Option<String> {
    // 1. Check next to the running executable (release bundle).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate_name in sdk_binary_candidate_names() {
                let candidate = dir.join(candidate_name);
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }

    // 2. Try PATH / known install prefixes.
    let resolved = hq_desktop_core::paths::resolve_bin(SDK_BIN);
    if std::path::Path::new(&resolved).exists() {
        return Some(resolved);
    }

    None
}

/// Resolve the Recall SDK invocation for this platform.
#[cfg(target_os = "windows")]
pub fn resolve_sdk_command() -> Result<SdkCommand, String> {
    let program = find_sdk_binary()
        .ok_or_else(|| format!("binary {SDK_BIN} not found next to the app or on PATH"))?;
    Ok(SdkCommand {
        program,
        args: vec![SDK_JSON_FLAG.to_string()],
    })
}

// ── macOS / Linux: node + a plain-resource bridge.mjs ────────────────────────
//
// The macOS bundle used to ship a *bash script* as `bundle.externalBin`, which
// Tauri places at `HQ.app/Contents/MacOS/recall-desktop-sdk` — i.e. as a NESTED
// CODE OBJECT. Because a script is not a Mach-O, `codesign` has nowhere inside
// the file to embed the signature, so it stores it in extended attributes
// (`com.apple.cs.CodeDirectory`, `com.apple.cs.CodeSignature`, …).
//
// The Tauri auto-updater downloads `HQ_x.y.z_universal.app.tar.gz` and extracts
// it with a tar implementation that does NOT preserve extended attributes. The
// launcher therefore arrived byte-identical but signature-less on every
// auto-updated install: `codesign --verify --deep --strict` failed with "code
// object is not signed at all / In subcomponent: …/Contents/MacOS/
// recall-desktop-sdk" and `spctl` reported "rejected, no usable signature".
// macOS will not persist TCC privacy grants against an invalid bundle, so
// Accessibility/Screen Recording never stuck and meeting detection could never
// start. (The GStreamer dylibs were unaffected — Mach-O signatures are embedded
// in the file and survive the round trip.)
//
// The fix removes the nested code object entirely: `bridge.mjs` ships as a
// plain file under `Contents/Resources/`, which is sealed by content hash in
// `_CodeSignature/CodeResources` rather than by its own per-file signature, and
// Rust spawns `node <bridge.mjs>` directly. Plain resources carry no xattrs to
// lose, so the bundle signature survives an xattr-stripping extraction.

/// Candidate `bridge.mjs` locations relative to the running executable's
/// directory, most specific first.
///
/// * `../Resources/recall-sdk-bridge/bridge.mjs` — the shipped `.app`
///   (`Contents/MacOS/hq-sync-menubar` → `Contents/Resources/…`).
/// * `recall-sdk-bridge/bridge.mjs` — flat layouts that drop resources next to
///   the executable (Linux/portable builds).
/// * `../../../sidecar/…` — `cargo run` / `tauri dev`
///   (`apps/sync/src-tauri/target/{debug,release}/`).
/// * `../../../../sidecar/…` — cross-compiled target dirs
///   (`apps/sync/src-tauri/target/universal-apple-darwin/release/`).
#[cfg(not(target_os = "windows"))]
const BRIDGE_RELATIVE_CANDIDATES: &[&[&str]] = &[
    &["..", "Resources"],
    &["."],
    &["..", "..", "..", "sidecar"],
    &["..", "..", "..", "..", "sidecar"],
];

/// Pure resolution of the bridge entrypoint: `override_path` wins outright when
/// it points at an existing file, otherwise the layout candidates relative to
/// `exe_dir` are probed in order.
///
/// Split out from [`resolve_sdk_command`] so bundle / dev / override / missing
/// layouts are unit-testable without a real `.app`.
#[cfg(not(target_os = "windows"))]
pub fn resolve_bridge_entry_in(
    exe_dir: &std::path::Path,
    override_path: Option<&str>,
) -> Result<std::path::PathBuf, Vec<std::path::PathBuf>> {
    // Candidates are built with `..` segments (e.g. Contents/MacOS/../Resources).
    // Canonicalize the winner so the spawned argv and the log line read cleanly;
    // fall back to the raw path if canonicalization fails.
    fn normalize(p: std::path::PathBuf) -> std::path::PathBuf {
        std::fs::canonicalize(&p).unwrap_or(p)
    }

    let mut checked = Vec::new();

    if let Some(raw) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = std::path::PathBuf::from(raw);
        if candidate.is_file() {
            return Ok(normalize(candidate));
        }
        checked.push(candidate);
    }

    for rel in BRIDGE_RELATIVE_CANDIDATES {
        let mut candidate = exe_dir.to_path_buf();
        for part in *rel {
            if *part != "." {
                candidate.push(part);
            }
        }
        candidate.push(BRIDGE_DIR);
        candidate.push(BRIDGE_ENTRY);
        if candidate.is_file() {
            return Ok(normalize(candidate));
        }
        checked.push(candidate);
    }

    Err(checked)
}

/// Build the `node <bridge.mjs> --json` invocation for a given executable
/// directory and override. Pure — [`resolve_sdk_command`] is the thin
/// env/`current_exe` wrapper around it.
#[cfg(not(target_os = "windows"))]
pub fn sdk_command_in(
    exe_dir: &std::path::Path,
    override_path: Option<&str>,
) -> Result<SdkCommand, String> {
    let bridge = resolve_bridge_entry_in(exe_dir, override_path).map_err(|checked| {
        let list = checked
            .iter()
            .map(|p| format!("\n  {}", p.display()))
            .collect::<String>();
        format!("{BRIDGE_ENTRY} not found (set {BRIDGE_PATH_ENV} to override); checked:{list}")
    })?;

    // node is resolved the same way every other HQ child process resolves it
    // (`paths::resolve_bin`, matching the PATH `build_sdk_spawn_env` hands the
    // child) — this is exactly what the retired bash wrapper's `exec node` did.
    Ok(SdkCommand {
        program: hq_desktop_core::paths::resolve_bin("node"),
        args: vec![
            bridge.to_string_lossy().into_owned(),
            SDK_JSON_FLAG.to_string(),
        ],
    })
}

/// Resolve the Recall SDK invocation for this platform.
#[cfg(not(target_os = "windows"))]
pub fn resolve_sdk_command() -> Result<SdkCommand, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe() failed: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| format!("executable has no parent directory: {}", exe.display()))?;
    let override_path = std::env::var(BRIDGE_PATH_ENV).ok();
    sdk_command_in(exe_dir, override_path.as_deref())
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::sdk_binary_candidate_names;

    #[test]
    fn sdk_binary_candidate_names_are_windows_exes() {
        assert_eq!(
            sdk_binary_candidate_names(),
            vec![
                "recall-desktop-sdk.exe",
                "recall-desktop-sdk-x86_64-pc-windows-msvc.exe",
                "recall-desktop-sdk-aarch64-pc-windows-msvc.exe",
            ]
        );
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod bridge_resolution_tests {
    use super::{resolve_bridge_entry_in, sdk_command_in, BRIDGE_DIR, BRIDGE_ENTRY, SDK_JSON_FLAG};
    use std::fs;
    use std::path::Path;

    /// Create `<root>/<rel…>/recall-sdk-bridge/bridge.mjs` and return its path.
    fn plant_bridge(root: &Path, rel: &[&str]) -> std::path::PathBuf {
        let mut dir = root.to_path_buf();
        for part in rel {
            dir.push(part);
        }
        dir.push(BRIDGE_DIR);
        fs::create_dir_all(&dir).expect("create bridge dir");
        let entry = dir.join(BRIDGE_ENTRY);
        fs::write(&entry, "// test bridge\n").expect("write bridge");
        entry
    }

    #[test]
    fn resolve_bridge_entry_finds_the_macos_bundle_resources_layout() {
        // The shipped layout: HQ.app/Contents/MacOS/hq-sync-menubar resolves
        // ../Resources/recall-sdk-bridge/bridge.mjs. This is the plain-resource
        // path that survives the updater's xattr-stripping tar extraction.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("HQ.app").join("Contents");
        let macos_dir = contents.join("MacOS");
        fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        let expected = plant_bridge(&contents, &["Resources"]);

        let resolved = resolve_bridge_entry_in(&macos_dir, None).expect("bundle bridge resolves");
        assert_eq!(
            fs::canonicalize(&resolved).unwrap(),
            fs::canonicalize(&expected).unwrap()
        );
    }

    #[test]
    fn resolve_bridge_entry_finds_the_cargo_dev_layout() {
        // `cargo run` / `tauri dev`: apps/sync/src-tauri/target/debug/<exe>
        // resolves ../../../sidecar/recall-sdk-bridge/bridge.mjs.
        let tmp = tempfile::tempdir().expect("tempdir");
        let app_root = tmp.path().join("apps").join("sync");
        let exe_dir = app_root.join("src-tauri").join("target").join("debug");
        fs::create_dir_all(&exe_dir).expect("create target dir");
        let expected = plant_bridge(&app_root, &["sidecar"]);

        let resolved = resolve_bridge_entry_in(&exe_dir, None).expect("dev bridge resolves");
        assert_eq!(
            fs::canonicalize(&resolved).unwrap(),
            fs::canonicalize(&expected).unwrap()
        );
    }

    #[test]
    fn resolve_bridge_entry_finds_the_cross_compiled_target_layout() {
        // Release builds land in target/universal-apple-darwin/release/, one
        // directory deeper than the plain dev layout.
        let tmp = tempfile::tempdir().expect("tempdir");
        let app_root = tmp.path().join("apps").join("sync");
        let exe_dir = app_root
            .join("src-tauri")
            .join("target")
            .join("universal-apple-darwin")
            .join("release");
        fs::create_dir_all(&exe_dir).expect("create target dir");
        let expected = plant_bridge(&app_root, &["sidecar"]);

        let resolved =
            resolve_bridge_entry_in(&exe_dir, None).expect("cross-compiled bridge resolves");
        assert_eq!(
            fs::canonicalize(&resolved).unwrap(),
            fs::canonicalize(&expected).unwrap()
        );
    }

    #[test]
    fn resolve_bridge_entry_prefers_the_env_override() {
        // RECALL_BRIDGE_PATH kept the dev ergonomics the bash wrapper had. It
        // must WIN over a co-located bundle bridge, otherwise it is useless for
        // the "point the shipped app at my checkout" case it exists for.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("HQ.app").join("Contents");
        let macos_dir = contents.join("MacOS");
        fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        plant_bridge(&contents, &["Resources"]);
        let override_entry = plant_bridge(tmp.path(), &["elsewhere"]);

        let resolved =
            resolve_bridge_entry_in(&macos_dir, Some(override_entry.to_str().unwrap()))
                .expect("override resolves");
        assert_eq!(
            fs::canonicalize(&resolved).unwrap(),
            fs::canonicalize(&override_entry).unwrap()
        );
    }

    #[test]
    fn resolve_bridge_entry_ignores_a_blank_or_dangling_override() {
        // A blank or stale RECALL_BRIDGE_PATH must fall through to the bundle
        // rather than hard-failing the spawn.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("HQ.app").join("Contents");
        let macos_dir = contents.join("MacOS");
        fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        let expected = plant_bridge(&contents, &["Resources"]);

        for override_path in ["", "   ", "/nonexistent/hq/bridge.mjs"] {
            let resolved = resolve_bridge_entry_in(&macos_dir, Some(override_path))
                .unwrap_or_else(|_| panic!("bundle fallback for override {override_path:?}"));
            assert_eq!(
                fs::canonicalize(&resolved).unwrap(),
                fs::canonicalize(&expected).unwrap()
            );
        }
    }

    #[test]
    fn resolve_bridge_entry_reports_every_checked_path_when_missing() {
        // The RECALL_SDK_UNAVAILABLE path: no bridge anywhere. Must return the
        // probed list (for the log line) rather than panic.
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("empty");
        fs::create_dir_all(&exe_dir).expect("create dir");

        let checked = resolve_bridge_entry_in(&exe_dir, Some("/nonexistent/bridge.mjs"))
            .expect_err("must not resolve");
        assert_eq!(checked.len(), 5, "1 override + 4 layout candidates");
        assert!(checked
            .iter()
            .all(|p| p.ends_with(format!("{BRIDGE_DIR}/{BRIDGE_ENTRY}"))
                || p == Path::new("/nonexistent/bridge.mjs")));
    }

    #[test]
    fn sdk_command_runs_the_bundle_bridge_under_node_with_json() {
        // End-to-end shape of the spawn: node <Resources>/…/bridge.mjs --json.
        // Nothing inside Contents/MacOS is referenced any more — that is the
        // whole point of the fix.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("HQ.app").join("Contents");
        let macos_dir = contents.join("MacOS");
        fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        let expected = plant_bridge(&contents, &["Resources"]);

        let cmd = sdk_command_in(&macos_dir, None).expect("bundle command resolves");
        assert!(
            cmd.program == "node" || cmd.program.ends_with("/node"),
            "bridge must be spawned under node, got {}",
            cmd.program
        );
        assert_eq!(cmd.args.len(), 2);
        assert_eq!(
            fs::canonicalize(&cmd.args[0]).unwrap(),
            fs::canonicalize(&expected).unwrap()
        );
        assert_eq!(cmd.args[1], SDK_JSON_FLAG);
        assert!(
            !cmd.args[0].contains("/MacOS/"),
            "the bridge must live under Contents/Resources, not Contents/MacOS: {}",
            cmd.args[0]
        );
    }

    #[test]
    fn sdk_command_errors_with_the_checked_paths_when_the_bridge_is_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("empty");
        fs::create_dir_all(&exe_dir).expect("create dir");

        let err = sdk_command_in(&exe_dir, None).expect_err("must not resolve");
        assert!(err.contains(BRIDGE_ENTRY), "{err}");
        assert!(err.contains(super::BRIDGE_PATH_ENV), "{err}");
        assert!(err.contains(BRIDGE_DIR), "{err}");
    }
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
    env.insert("PATH".to_string(), hq_desktop_core::paths::child_path());
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
    use hq_desktop_core::events::{DetectionSource, MeetingPlatform, RecallPermission};

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
    fn resolve_sdk_command_never_panics_when_the_sdk_is_absent() {
        // In CI / dev environments without the Recall Desktop SDK installed,
        // resolution must return Err (not panic). This is the
        // RECALL_SDK_UNAVAILABLE path exercised by the E2E test "binary missing".
        //
        // We can't assert Err always (a dev may have the sidecar in place), but
        // we can assert the function doesn't panic.
        let _ = resolve_sdk_command(); // must not panic
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sdk_arch_triples_and_suffix_match_platform() {
        // Regression: the Windows bundle's sidecar is arch-tagged with the
        // windows-msvc triples and carries a .exe suffix. A macOS-only triple
        // list (the fork's bug) means find_sdk_binary never resolves it.
        //
        // Windows-only since the macOS bash-wrapper externalBin was removed:
        // a script in Contents/MacOS can only carry its signature in extended
        // attributes, which the updater's tar extraction strips (see the module
        // comment above `BRIDGE_RELATIVE_CANDIDATES`).
        assert!(SDK_ARCH_TRIPLES
            .iter()
            .all(|t| t.contains("pc-windows-msvc")));
        assert_eq!(std::env::consts::EXE_SUFFIX, ".exe");
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
        use hq_desktop_core::feature_gate::email_present;
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
