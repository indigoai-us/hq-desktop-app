//! Pure daemon lifecycle helpers shared by desktop app shells.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::MenubarPrefs;
use crate::process_types::SpawnArgs;
use crate::{config, paths};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Daemon status response for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub watch_path: Option<String>,
    pub source: String, // "pid_file", "daemon_json", or "none"
}

/// Structure of .hq-sync-daemon.json written by `hq sync start`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonJson {
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub watch_path: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (same pattern as sync.rs and status.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the HQ folder path by reading config.json and menubar.json directly.
pub fn resolve_hq_folder_path() -> Result<String, String> {
    let menubar_path = paths::menubar_json_path()?;

    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    // Use the shared lenient reader so the policy is uniform across all
    // four `resolve_hq_folder_path` duplicates: parse failures fall
    // through to menubar.json + the 4-tier resolver, but real IO errors
    // (permission denied, transient FS failure) still propagate as Err.
    // Without this, silently swallowing read errors could route sync at
    // the wrong HQ folder when config.json is the only source of
    // `hqFolderPath`.
    let config = config::read_hq_config_lenient()?;

    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    Ok(hq_folder.to_string_lossy().to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// SpawnArgs builders (testable)
// ─────────────────────────────────────────────────────────────────────────────

/// Build SpawnArgs for the Auto-sync watcher: hq-sync-runner in watch mode,
/// fanned out across every membership the caller has.
///
/// Mirrors `build_sync_spawn_args` (manual Sync Now) and adds:
///   - `--watch` — runner stays alive after the first pass
///   - `--poll-remote-ms 15000` — pulls remote changes every 15 seconds (fixed)
///   - `--event-push` — when the user's Instant-sync setting is ON (Phase 2 GA)
///
/// As of hq-cloud 5.26 the runner's chokidar watcher is real. Phase 2 GA
/// (2026-05-23) opened event-driven push to ALL users: we append `--event-push`
/// (requires `--watch`, always set) whenever the user's Instant-sync setting is
/// ON — which it is by default. Local edits then upload within seconds of the
/// filesystem event. Toggling Instant-sync OFF drops back to poll-only without
/// disabling Auto-sync.
///
/// Instant-sync OFF stays poll-only: the remote→local pull runs on the 15-second
/// cadence and a local push waits for the next pass — there is no second-by-second
/// upload of local edits. (The remote→local pull is poll-driven for most users.
/// The server side shipped in hq-pro US-015/US-016 — `POST /v1/sync/subscribe`
/// mints a per-device SQS queue and vends scoped receive credentials — and as
/// of hq-cloud ≥6.3.1 the runner brings up real event-driven pull INSIDE
/// `--event-push` for accounts enrolled in its Phase 3 rollout gate
/// (`resolveEventSync`, exact-email allowlist + `HQ_SYNC_EVENT_SYNC` override);
/// no new menubar flag is involved. The 15-second poll stays regardless, as
/// the correctness backstop.)
/// Conflict policy is `keep` (skip-and-surface) — local
/// edits win and the conflict store routes them through the existing modal so
/// auto-pull never clobbers an in-progress resolution.

/// Pure decision: should the watch runner get `--event-push`?
///
/// As of Phase 2 GA (2026-05-23) eligibility is universal, so this effectively
/// reduces to "is the user's Instant-sync setting ON?". Kept as a pure
/// `(eligible, instant_sync) -> bool` so the decision stays unit-testable and a
/// future targeted re-gate (flip `event_push_eligible`) works without touching
/// this logic.
pub fn should_event_push(eligible: bool, instant_sync: bool) -> bool {
    eligible && instant_sync
}

/// Resolve whether the signed-in user is eligible for event-driven push.
///
/// Phase 2 (2026-05-23): event-driven push is GA — every signed-in user is
/// eligible. The per-user Instant-sync setting (`is_instant_sync_enabled`,
/// default-on) is now the sole gate. Kept as a function (rather than inlining
/// `true` at the call site) so the `should_event_push` seam stays intact and a
/// future targeted re-gate is a one-line change here.
pub fn event_push_eligible() -> bool {
    true
}

pub fn build_watch_runner_args(hq_folder_path: &str) -> SpawnArgs {
    use crate::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION, RUNNER_BIN};

    let mut env = HashMap::new();
    env.insert("HQ_ROOT".to_string(), hq_folder_path.to_string());
    // GUI-launched Tauri apps inherit a minimal launchd PATH and otherwise
    // can't find node/npx. See paths::child_path.
    env.insert("PATH".to_string(), paths::child_path());

    // Remote-pull cadence, fixed at 15 seconds. event-push + event-sync handle
    // real-time propagation; this poll is only the correctness backstop. It is
    // intentionally NOT user-configurable.
    const SYNC_POLL_REMOTE_MS: u64 = 15_000;
    let poll_ms = SYNC_POLL_REMOTE_MS;

    let mut runner_args = vec![
        "--companies".to_string(),
        "--direction".to_string(),
        "both".to_string(),
        "--on-conflict".to_string(),
        "keep".to_string(),
        "--hq-root".to_string(),
        hq_folder_path.to_string(),
        "--watch".to_string(),
        "--poll-remote-ms".to_string(),
        poll_ms.to_string(),
    ];

    // Phase 2 GA: event-driven push is gated solely by the user's Instant-sync
    // setting (eligibility is now universal — see `event_push_eligible`). The
    // hq-cloud runner requires --watch for --event-push (already set above), so
    // appending here is safe for both spawn paths below.
    if should_event_push(event_push_eligible(), is_instant_sync_enabled()) {
        runner_args.push("--event-push".to_string());
    }

    // Dev override: HQ_CLOUD_LOCAL_RUNNER points at a built sync-runner.js
    // (e.g. /…/hq/packages/hq-cloud/dist/bin/sync-runner.js). Lets us
    // exercise unreleased runner changes before the version is published
    // to npm; production falls through to the npx-pinned path below.
    if let Ok(local_runner) = std::env::var("HQ_CLOUD_LOCAL_RUNNER") {
        if !local_runner.is_empty() {
            let mut args = vec![local_runner];
            args.extend(runner_args);
            return SpawnArgs {
                cmd: paths::resolve_bin("node"),
                args,
                cwd: None,
                env: Some(env),
            };
        }
    }

    let mut args = vec![
        "-y".to_string(),
        format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        RUNNER_BIN.to_string(),
    ];
    args.extend(runner_args);

    SpawnArgs {
        cmd: paths::resolve_bin("npx"),
        args,
        cwd: None,
        env: Some(env),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Check if a PID is alive using kill(0).
///
/// Note: kill(0) checks if the calling user has permission to signal the PID.
/// If the original process died and a different process reused the PID, this
/// may return a false positive. Acceptable for V2 prep — daemon.json cross-check
/// can be added in V2 if PID reuse becomes an issue.
#[cfg(unix)]
pub fn is_pid_alive(pid: u32) -> bool {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }

    unsafe { kill(pid as c_int, 0) == 0 }
}

#[cfg(target_os = "windows")]
pub fn is_pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let mut exit_code: u32 = 0;
        let alive = match GetExitCodeProcess(handle, &mut exit_code) {
            Ok(()) => exit_code == STILL_ACTIVE.0 as u32,
            Err(_) => false,
        };
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn is_pid_alive(_pid: u32) -> bool {
    false
}

/// Read .hq-sync.pid file from the HQ folder.
pub fn read_pid_file(hq_folder_path: &str) -> Option<u32> {
    let pid_path = PathBuf::from(hq_folder_path).join(".hq-sync.pid");
    std::fs::read_to_string(&pid_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

/// Read .hq-sync-daemon.json from the HQ folder.
pub fn read_daemon_json(hq_folder_path: &str) -> Option<DaemonJson> {
    let json_path = PathBuf::from(hq_folder_path).join(".hq-sync-daemon.json");
    std::fs::read_to_string(&json_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// Check if autostart_daemon flag is enabled in menubar.json.
pub fn is_autostart_enabled() -> bool {
    read_menubar_bool(|p| p.autostart_daemon, false)
}

/// Check if the user-facing Auto-sync flag is enabled in menubar.json.
/// Both flags trigger the same daemon — `autostart_daemon` is the V2-prep
/// devtools flag and `realtime_sync` is the user-facing Settings toggle —
/// but they're kept separate so each can evolve independently.
///
/// Defaults to true when the field is missing so fresh installs auto-sync
/// without the user having to discover the Settings toggle. An explicit
/// `false` written by `save_settings` still wins.
pub fn is_realtime_sync_enabled() -> bool {
    read_menubar_bool(|p| p.realtime_sync, true)
}

/// Check if the user-facing Instant-sync (event-driven) flag is enabled in
/// menubar.json.
///
/// Defaults to true when the field is missing so eligible (@getindigo.ai)
/// users get instant push on a fresh install without discovering the toggle,
/// matching the `realtime_sync` default-on convention. An explicit `false`
/// written by `save_settings` still wins. Note this is only consulted for
/// `event_push_eligible()` users — see `should_event_push`.
pub fn is_instant_sync_enabled() -> bool {
    read_menubar_bool(|p| p.instant_sync, true)
}

pub fn read_menubar_bool<F: FnOnce(&MenubarPrefs) -> Option<bool>>(
    field: F,
    default: bool,
) -> bool {
    let menubar_path = match paths::menubar_json_path() {
        Ok(p) => p,
        Err(_) => return default,
    };
    if !menubar_path.exists() {
        return default;
    }
    let prefs: Option<MenubarPrefs> = std::fs::read_to_string(&menubar_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    prefs.and_then(|p| field(&p)).unwrap_or(default)
}

/// Pure decision for the supervisor: respawn the watch daemon iff auto-sync
/// should be on (the user-facing realtime-sync toggle or the autostart devtools
/// flag) AND it isn't currently alive. Extracted (like `should_event_push`) so
/// the decision stays unit-testable.
pub fn should_respawn_daemon(realtime_sync: bool, autostart: bool, daemon_alive: bool) -> bool {
    (realtime_sync || autostart) && !daemon_alive
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Daemon supervisor decision ───────────────────────────────────────

    #[test]
    fn test_should_respawn_daemon() {
        // Auto-sync on (either flag), daemon dead → respawn.
        assert!(should_respawn_daemon(true, false, false));
        assert!(should_respawn_daemon(false, true, false));
        assert!(should_respawn_daemon(true, true, false));
        // Auto-sync on, daemon already alive → no-op.
        assert!(!should_respawn_daemon(true, false, true));
        assert!(!should_respawn_daemon(false, true, true));
        // Auto-sync off (user disabled it), daemon dead → never respawn.
        assert!(!should_respawn_daemon(false, false, false));
        // Auto-sync off, daemon alive → no-op.
        assert!(!should_respawn_daemon(false, false, true));
    }

    // ── DaemonStatus serialization ───────────────────────────────────────

    #[test]
    fn test_daemon_status_serializes_camel_case() {
        let status = DaemonStatus {
            running: true,
            pid: Some(12345),
            started_at: Some("2026-04-18T12:00:00Z".to_string()),
            watch_path: Some("/Users/test/HQ".to_string()),
            source: "daemon_json".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"watchPath\""));
        assert!(!json.contains("\"started_at\""));
        assert!(!json.contains("\"watch_path\""));
    }

    #[test]
    fn test_daemon_status_roundtrip() {
        let status = DaemonStatus {
            running: true,
            pid: Some(12345),
            started_at: Some("2026-04-18T12:00:00Z".to_string()),
            watch_path: Some("/Users/test/HQ".to_string()),
            source: "daemon_json".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        let parsed: DaemonStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, parsed);
    }

    #[test]
    fn test_daemon_status_default_none() {
        let status = DaemonStatus {
            running: false,
            pid: None,
            started_at: None,
            watch_path: None,
            source: "none".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"running\":false"));
        assert!(json.contains("\"pid\":null"));
        assert!(json.contains("\"startedAt\":null"));
        assert!(json.contains("\"watchPath\":null"));
        assert!(json.contains("\"source\":\"none\""));
    }

    // ── DaemonJson deserialization ───────────────────────────────────────

    #[test]
    fn test_daemon_json_deserialize_full() {
        let json = r#"{
            "pid": 42,
            "startedAt": "2026-04-18T10:30:00Z",
            "watchPath": "/Users/test/HQ"
        }"#;
        let daemon: DaemonJson = serde_json::from_str(json).unwrap();
        assert_eq!(daemon.pid, Some(42));
        assert_eq!(daemon.started_at, Some("2026-04-18T10:30:00Z".to_string()));
        assert_eq!(daemon.watch_path, Some("/Users/test/HQ".to_string()));
    }

    #[test]
    fn test_daemon_json_deserialize_minimal() {
        let json = r#"{}"#;
        let daemon: DaemonJson = serde_json::from_str(json).unwrap();
        assert_eq!(daemon.pid, None);
        assert_eq!(daemon.started_at, None);
        assert_eq!(daemon.watch_path, None);
    }

    #[test]
    fn test_daemon_json_deserialize_partial() {
        let json = r#"{"pid": 99}"#;
        let daemon: DaemonJson = serde_json::from_str(json).unwrap();
        assert_eq!(daemon.pid, Some(99));
        assert_eq!(daemon.started_at, None);
        assert_eq!(daemon.watch_path, None);
    }

    // ── is_pid_alive ──────────────────────────────────────────────────────

    #[test]
    fn test_is_pid_alive_current_process() {
        // Current process should always be alive
        let pid = std::process::id();
        assert!(is_pid_alive(pid));
    }

    #[test]
    fn test_is_pid_alive_invalid_pid() {
        // PID 0 is the kernel — kill(0) should fail for a regular user process
        // PID 4_000_000 is unlikely to exist on any system
        assert!(!is_pid_alive(4_000_000));
    }

    // ── is_autostart_enabled ─────────────────────────────────────────────

    #[test]
    fn test_is_autostart_enabled_does_not_panic() {
        // This test relies on the real menubar.json path. If the file
        // doesn't exist or doesn't have autostartDaemon=true, it returns false.
        // On CI / clean machines this will always be false.
        let _result = is_autostart_enabled();
        // Function should not panic regardless of filesystem state
    }

    // ── build_watch_runner_args (Auto-sync) ───────────────────────────────
    //
    // Auto-sync reuses the same hq-sync-runner binary as the manual Sync Now
    // button (see commands/sync.rs::build_sync_spawn_args), but adds:
    //   --watch                  — keep the runner alive after the first pass
    //   --poll-remote-ms 15000   — pull from S3 every 15 seconds (fixed)
    //
    // Conflict policy stays `keep` (skip-and-surface) — local edits win and
    // the conflict store routes them through the existing modal. Direction
    // stays `both`. Companies stays fanned out (`--companies`).

    #[test]
    fn test_build_watch_runner_args_uses_npx_runner() {
        let args = build_watch_runner_args("/Users/test/HQ");
        // Resolved path varies by machine; Windows uses npm's npx.cmd shim.
        let expected = if cfg!(target_os = "windows") {
            "npx.cmd"
        } else {
            "npx"
        };
        let actual = std::path::Path::new(&args.cmd)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&args.cmd);
        assert!(
            actual.eq_ignore_ascii_case(expected),
            "expected resolved {expected} path, got: {}",
            args.cmd
        );
    }

    #[test]
    fn test_build_watch_runner_args_pins_hq_cloud_package() {
        use crate::hq_cloud::{HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION};
        let args = build_watch_runner_args("/any");
        let expected_pin = format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION);
        assert!(
            args.args.contains(&expected_pin),
            "expected pinned --package= flag, got: {:?}",
            args.args
        );
        assert!(args.args.contains(&"-y".to_string()));
        assert!(args.args.contains(&"hq-sync-runner".to_string()));
    }

    #[test]
    fn test_build_watch_runner_args_includes_watch_and_poll_interval() {
        let args = build_watch_runner_args("/any");
        assert!(args.args.contains(&"--watch".to_string()));
        let poll_idx = args
            .args
            .iter()
            .position(|a| a == "--poll-remote-ms")
            .expect("--poll-remote-ms flag missing");
        assert_eq!(
            args.args.get(poll_idx + 1).map(|s| s.as_str()),
            Some("15000"),
            "expected the fixed 15-second (15000ms) poll interval"
        );
    }

    #[test]
    fn test_build_watch_runner_args_fans_out_to_all_companies() {
        // Auto-sync mirrors the manual Sync Now button: --companies, not a
        // single --company. Bidirectional, conflict-keep.
        let args = build_watch_runner_args("/any");
        assert!(args.args.contains(&"--companies".to_string()));
        assert!(!args.args.iter().any(|a| a == "--company"));

        let dir_idx = args
            .args
            .iter()
            .position(|a| a == "--direction")
            .expect("--direction flag missing");
        assert_eq!(args.args.get(dir_idx + 1).map(|s| s.as_str()), Some("both"));

        let conflict_idx = args
            .args
            .iter()
            .position(|a| a == "--on-conflict")
            .expect("--on-conflict flag missing");
        assert_eq!(
            args.args.get(conflict_idx + 1).map(|s| s.as_str()),
            Some("keep")
        );
    }

    #[test]
    fn test_build_watch_runner_args_passes_hq_root() {
        let args = build_watch_runner_args("/Users/test/HQ");
        let root_idx = args
            .args
            .iter()
            .position(|a| a == "--hq-root")
            .expect("--hq-root flag missing");
        assert_eq!(
            args.args.get(root_idx + 1).map(|s| s.as_str()),
            Some("/Users/test/HQ")
        );
    }

    #[test]
    fn test_build_watch_runner_args_env_carries_hq_root_and_path() {
        // Mirrors build_sync_spawn_args: HQ_ROOT for defense-in-depth and
        // PATH so Dock-launched apps can resolve node/npx (see paths::child_path).
        let args = build_watch_runner_args("/Users/test/HQ");
        let env = args.env.expect("env should be populated");
        assert_eq!(
            env.get("HQ_ROOT").map(String::as_str),
            Some("/Users/test/HQ")
        );
        assert!(
            env.get("PATH").map(|p| !p.is_empty()).unwrap_or(false),
            "PATH must be set so Dock-launched Tauri apps can find node/npx"
        );
    }

    // ── event-push gating (Phase 2 GA) ─────────────────────────────────────
    //
    // Phase 2 GA (2026-05-23): eligibility is universal (`event_push_eligible`
    // => true), so --event-push is appended whenever the user's Instant-sync
    // setting is ON. The pure `should_event_push` still models the
    // (eligible × setting) AND, so a future targeted re-gate is a one-liner.

    #[test]
    fn test_event_push_eligible_is_universal_phase2_ga() {
        // GA: every signed-in user is eligible — no token/email required.
        assert!(event_push_eligible());
    }

    #[test]
    fn test_should_event_push_eligible_and_instant_on_pushes() {
        // (i) Instant-sync ON + eligible => event-driven push.
        assert!(should_event_push(true, true));
    }

    #[test]
    fn test_should_event_push_eligible_but_instant_off_is_poll_only() {
        // (ii) Instant-sync OFF => poll-only, no --event-push.
        assert!(!should_event_push(true, false));
    }

    #[test]
    fn test_should_event_push_ineligible_never_pushes_regardless_of_setting() {
        // (iii) The seam still holds: were eligibility ever re-gated to false,
        // the Instant-sync setting could not override it.
        assert!(!should_event_push(false, true));
        assert!(!should_event_push(false, false));
    }
}
