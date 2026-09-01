//! Pure daemon lifecycle helpers shared by desktop app shells.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

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
    /// The reason behind the last lifecycle transition this process observed —
    /// e.g. `"runner_memory"` after a footprint pre-empt — so the daemon UI can
    /// state not just that background sync stopped but WHY. `None` when the last
    /// transition carried no failure reason (e.g. a healthy Running state, or a
    /// daemon inherited from a prior app session this process never supervised).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub failure_category: Option<String>,
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
///   - `--event-push` — when both runner compatibility and the user's
///     Instant-sync setting permit that optional runner capability
///
/// As of hq-cloud 5.26 the runner's chokidar watcher is real. `--event-push`
/// is only a local runner capability: it permits the runner to consider its
/// existing event-driven V1 behavior. It never enrolls a scope in V2, issues a
/// lease, or authorizes a mutation; those decisions stay server-owned.
/// Toggling Instant-sync OFF drops back to poll-only without disabling
/// Auto-sync.
///
/// Instant-sync OFF stays poll-only: the remote→local pull uses the runner's
/// load-aware cadence and a local push waits for the next pass — there is no second-by-second
/// upload of local edits. (The remote→local pull is poll-driven for most users.
/// The server side shipped in hq-pro US-015/US-016 — `POST /v1/sync/subscribe`
/// mints a per-device SQS queue and vends scoped receive credentials — and as
/// of hq-cloud ≥6.3.1 the runner brings up real event-driven pull INSIDE
/// `--event-push` for accounts enrolled in its Phase 3 rollout gate
/// (`resolveEventSync`, exact-email allowlist + `HQ_SYNC_EVENT_SYNC` override);
/// no new menubar flag is involved. Adaptive polling stays as the correctness
/// backstop.)
/// Conflict policy is `keep` (cloud-wins with a local sidecar) — the cloud body
/// takes the working path while the displaced local edit stays recoverable in
/// the conflict store. Live sync reports an aggregate conflict banner; use its
/// `/resolve-conflicts` recovery path to inspect and resolve preserved copies.

/// Pure decision: should the watch runner get `--event-push`?
///
/// A capability/preference decision only. This function deliberately has no
/// account, token, tenant, or rollout input, because none can be desktop
/// enrollment authority. It cannot select V2 or claim a first-push path.
pub fn should_event_push(runner_supports_event_push: bool, instant_sync: bool) -> bool {
    runner_supports_event_push && instant_sync
}

/// Compatibility export for app shells built against the old desktop API.
///
/// The former implementation returned `true` for every signed-in user. That
/// universal enrollment decision is intentionally gone: callers that have not
/// yet moved to the runner-capability seam receive `false` and cannot select
/// any V2 path. Server inventory and leases remain the only enrollment
/// authority.
pub fn event_push_eligible() -> bool {
    false
}

pub fn build_watch_runner_args(hq_folder_path: &str) -> SpawnArgs {
    let target = match crate::runner_target::local_runner_override() {
        Some(script) => crate::runner_target::RunnerSpawnTarget::Local { script },
        None => crate::runner_target::RunnerSpawnTarget::npx_with_assumed_cache_root(),
    };
    build_watch_runner_args_for_target(hq_folder_path, &target)
}

/// Build the watcher command for a source selected before startup preflight.
///
/// The same [`crate::runner_target::RunnerSpawnTarget`] is retained by the
/// caller for runner-target repair and crash provenance. Only a cache root npm
/// or the environment positively established is bound into the child; an
/// assumed default must not change where npx installs packages.
pub fn build_watch_runner_args_for_target(
    hq_folder_path: &str,
    target: &crate::runner_target::RunnerSpawnTarget,
) -> SpawnArgs {
    use crate::hq_cloud::{
        HQ_CLOUD_PACKAGE, HQ_CLOUD_RUNNER_CAPABILITIES, HQ_CLOUD_VERSION, RUNNER_BIN,
    };

    let mut env = HashMap::new();
    env.insert("HQ_ROOT".to_string(), hq_folder_path.to_string());
    // GUI-launched Tauri apps inherit a minimal launchd PATH and otherwise
    // can't find node/npx. See paths::child_path.
    env.insert("PATH".to_string(), paths::child_path());
    // Mirror Sync Now: paused companies (workspaceSyncEnabled=false) must not
    // keep uploading/downloading under Auto-sync / watch.
    let disabled = crate::workspaces::disabled_workspace_sync_slugs();
    if !disabled.is_empty() {
        env.insert("HQ_SYNC_SKIP_COMPANIES".to_string(), disabled.join(","));
    }
    // Mirror Sync Now: Personal Off must suppress the personal vault target.
    let personal_sync_enabled = is_personal_sync_enabled();
    if !personal_sync_enabled {
        env.insert("HQ_SYNC_SKIP_PERSONAL".to_string(), "1".to_string());
    }
    // Bandwidth governor: tell the runner what share of the link it may use.
    crate::bandwidth::apply_bandwidth_env(&mut env, crate::bandwidth::prefs_bandwidth_percent());

    // Declare a V8 old-space ceiling for the runner child so its mid-pull heap
    // growth is bounded at an app-DECLARED point rather than one derived from
    // whatever RAM the host happens to have (auto-sync watcher unbounded-memory
    // cluster). The child inherits THIS process's environment, so read any
    // inherited NODE_OPTIONS and MERGE the ceiling into it: an explicit user
    // `--max-old-space-size` always wins and every other inherited option is
    // preserved verbatim. Applied identically on BOTH spawn paths below.
    let heap_ceiling = effective_runner_heap_ceiling();
    if let Some(node_options) =
        merge_node_options_ceiling(std::env::var("NODE_OPTIONS").ok().as_deref(), heap_ceiling)
    {
        env.insert("NODE_OPTIONS".to_string(), node_options);
    }

    let mut runner_args = vec![
        "--companies".to_string(),
        "--direction".to_string(),
        "both".to_string(),
        "--on-conflict".to_string(),
        "keep".to_string(),
        "--hq-root".to_string(),
        hq_folder_path.to_string(),
        "--watch".to_string(),
    ];

    // `--event-push` is a runner capability, never V2 enrollment. The
    // hq-cloud runner requires --watch for it (already set above), so appending
    // it is safe for both spawn paths below. V2 mutation support stays false
    // until U59 wires the server-authorized compiled boundary.
    if should_event_push(
        HQ_CLOUD_RUNNER_CAPABILITIES.event_push,
        is_instant_sync_enabled(),
    ) {
        runner_args.push("--event-push".to_string());
    }

    // Personal Off — same CLI surface Sync Now uses (`--skip-personal`).
    if !personal_sync_enabled {
        runner_args.push("--skip-personal".to_string());
    }

    // Dev override: HQ_CLOUD_LOCAL_RUNNER points at a built sync-runner.js
    // (e.g. /…/hq/packages/hq-cloud/dist/bin/sync-runner.js). Lets us
    // exercise unreleased runner changes before the version is published
    // to npm; production falls through to the npx-pinned path below.
    if let crate::runner_target::RunnerSpawnTarget::Local { script } = target {
        let mut args = Vec::new();
        // On the path we own (bare `node`), ALSO pass the ceiling in argv so a
        // NODE_OPTIONS that fails to reach the child (host policy/packaging)
        // still bounds the heap. A node CLI flag must precede the script path,
        // and it is withheld when the user set their own `--max-old-space-size`
        // (argv would override the user's NODE_OPTIONS value, which must win).
        if let Some(flag) = runner_max_old_space_arg(heap_ceiling) {
            args.push(flag);
        }
        args.push(script.clone());
        args.extend(runner_args);
        return SpawnArgs {
            cmd: paths::resolve_bin("node"),
            args,
            cwd: None,
            env: Some(env),
        };
    }

    let mut args = vec![
        "-y".to_string(),
        format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        RUNNER_BIN.to_string(),
    ];
    args.extend(runner_args);

    if let Some(cache_root) = target.established_npm_cache_root() {
        // npm config was resolved before the watcher launch. Re-export its
        // effective value at npm's canonical lowercase spelling so the npx
        // child is pinned to the cache attribution will inspect.
        env.insert(
            "npm_config_cache".to_string(),
            cache_root.to_string_lossy().into_owned(),
        );
    }

    SpawnArgs {
        cmd: paths::resolve_bin("npx"),
        args,
        cwd: None,
        env: Some(env),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner memory ceiling (auto-sync watcher child unbounded-memory cluster)
// ─────────────────────────────────────────────────────────────────────────────

/// Declared V8 old-space ceiling (MB) for the auto-sync runner child. The
/// fixed runner's Linux peak tree RSS was 3,617 MB; subtracting the measured
/// 102-1,331 MB non-heap overhead infers roughly 2,286-3,105 MB of old-space
/// demand. 3,584 MB clears that upper inference by about 479 MB. It is kept
/// deliberately below 4,096 MB because the derived footprint backstop is then
/// 3,584 + 2,048 = 5,632 MB, below the observed approximately 5.9 GB OS-kill
/// point. Expected peak tree footprint is 3,584 + 1,331 = 4,915 MB, below both
/// that backstop and the OS kill. Overridable per host without a rebuild via
/// [`RUNNER_HEAP_CEILING_ENV`].
pub const RUNNER_HEAP_CEILING_DEFAULT_MB: u32 = 3584;

/// Approximate field-observed lower bound (MB) for a macOS OS kill, not a
/// platform specification. The default derived footprint backstop must remain
/// below it: margin below this physical limit matters more than surplus margin
/// above inferred V8 demand because the app must pre-empt before the OS does.
pub const OBSERVED_OS_KILL_FLOOR_MB: u32 = 5900;

/// Assumed runaway whole-tree footprint growth for the hard safety threshold.
/// 20 MB/s (1,200 MB/min) is deliberately conservative for an unbounded runner:
/// it protects a full 30-second supervisor sampling gap rather than assuming the
/// next sample catches a gradual leak immediately.
pub const WATCHER_FOOTPRINT_HARD_CEILING_GROWTH_MB_PER_SEC: u32 = 20;

/// Escape-hatch env var: a per-host integer-MB override of the declared runner
/// old-space ceiling, so a user with a genuinely large workspace can raise it
/// without a rebuild. An explicit `--max-old-space-size` in NODE_OPTIONS still
/// outranks it — that is the user's own decision.
pub const RUNNER_HEAP_CEILING_ENV: &str = "HQ_SYNC_RUNNER_MAX_OLD_SPACE_MB";

/// Where the runner's effective old-space ceiling came from. Fixed vocabulary,
/// safe for a Sentry tag; recorded on every watcher exit so the ceiling in force
/// is never guessed after the fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerHeapCeilingSource {
    /// The declared default constant applied (no user or env override).
    DeclaredDefault,
    /// [`RUNNER_HEAP_CEILING_ENV`] supplied the value.
    EnvOverride,
    /// The inherited NODE_OPTIONS already carried an explicit
    /// `--max-old-space-size`; the user's value wins and we add nothing.
    UserNodeOptions,
}

impl RunnerHeapCeilingSource {
    /// Fixed vocabulary safe for a Sentry tag.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeclaredDefault => "declared_default",
            Self::EnvOverride => "env_override",
            Self::UserNodeOptions => "user_node_options",
        }
    }
}

/// The effective runner old-space ceiling in MB plus its provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerHeapCeiling {
    pub mb: u32,
    pub source: RunnerHeapCeilingSource,
}

/// Strip one balanced pair of surrounding ASCII quotes (`"` or `'`) from a
/// NODE_OPTIONS value token. Node's own NODE_OPTIONS parser honours quoting, so
/// `--max-old-space-size="128"` grants 128MB there; our parser must read the
/// same value rather than fail and let the declared default override the user.
fn unquote_option_value(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' || first == b'\'') && first == last {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Parse the effective `--max-old-space-size` (MB) out of a NODE_OPTIONS string,
/// if any. Accepts the `=` and space forms, the underscore spelling Node also
/// honours, and a quoted value; the LAST occurrence wins, exactly as Node
/// resolves repeated flags. Pure — reads no environment.
pub fn parse_max_old_space_mb(node_options: Option<&str>) -> Option<u32> {
    let raw = node_options?;
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut found: Option<u32> = None;
    let mut i = 0;
    while i < tokens.len() {
        let normalized = tokens[i].replace("--max_old_space_size", "--max-old-space-size");
        if let Some(rest) = normalized.strip_prefix("--max-old-space-size") {
            if let Some(value) = rest.strip_prefix('=') {
                if let Ok(mb) = unquote_option_value(value).parse::<u32>() {
                    found = Some(mb);
                }
            } else if rest.is_empty() {
                // Space form: the value is the next token.
                if let Some(next) = tokens.get(i + 1) {
                    if let Ok(mb) = unquote_option_value(next).parse::<u32>() {
                        found = Some(mb);
                        i += 1;
                    }
                }
            }
        }
        i += 1;
    }
    found
}

/// Pure resolution of the runner's effective old-space ceiling and its
/// provenance, given the inherited NODE_OPTIONS and an optional env-override MB.
/// An explicit user `--max-old-space-size` always wins; then the env override;
/// then the declared default.
pub fn resolve_runner_heap_ceiling(
    inherited_node_options: Option<&str>,
    env_override_mb: Option<u32>,
) -> RunnerHeapCeiling {
    if let Some(mb) = parse_max_old_space_mb(inherited_node_options) {
        return RunnerHeapCeiling {
            mb,
            source: RunnerHeapCeilingSource::UserNodeOptions,
        };
    }
    if let Some(mb) = env_override_mb.filter(|mb| *mb > 0) {
        return RunnerHeapCeiling {
            mb,
            source: RunnerHeapCeilingSource::EnvOverride,
        };
    }
    RunnerHeapCeiling {
        mb: RUNNER_HEAP_CEILING_DEFAULT_MB,
        source: RunnerHeapCeilingSource::DeclaredDefault,
    }
}

/// Pure NODE_OPTIONS merge: return the child's NODE_OPTIONS value carrying the
/// declared ceiling WITHOUT clobbering an inherited value. Returns `None` when
/// nothing should be written — the user already set `--max-old-space-size`, so
/// the inherited environment is left exactly as-is and the user's value wins.
/// Otherwise the declared flag is appended to any other inherited options
/// verbatim.
pub fn merge_node_options_ceiling(
    inherited: Option<&str>,
    ceiling: RunnerHeapCeiling,
) -> Option<String> {
    if ceiling.source == RunnerHeapCeilingSource::UserNodeOptions {
        return None;
    }
    let flag = format!("--max-old-space-size={}", ceiling.mb);
    match inherited.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => Some(format!("{existing} {flag}")),
        None => Some(flag),
    }
}

/// Pure: the argv flag to ADDITIONALLY pass on the spawn path we own (the bare
/// `node` local-runner path). `None` when the user's NODE_OPTIONS already
/// declares a ceiling — passing it in argv would override the user's value,
/// which must always win.
pub fn runner_max_old_space_arg(ceiling: RunnerHeapCeiling) -> Option<String> {
    match ceiling.source {
        RunnerHeapCeilingSource::UserNodeOptions => None,
        _ => Some(format!("--max-old-space-size={}", ceiling.mb)),
    }
}

/// Non-pure glue: resolve the effective ceiling from THIS process's environment
/// (which the child inherits). Deterministic within a process lifetime, so the
/// spawn path and the exit-attribution path resolve the same ceiling.
pub fn effective_runner_heap_ceiling() -> RunnerHeapCeiling {
    let inherited = std::env::var("NODE_OPTIONS").ok();
    let override_mb = std::env::var(RUNNER_HEAP_CEILING_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    resolve_runner_heap_ceiling(inherited.as_deref(), override_mb)
}

/// Fixed-vocabulary bucket for the runner's retained V8 heap-used measurement
/// immediately before a heap OOM. The exact MB figure remains a numeric Sentry
/// extra; this bounded tag makes the peak-at-abort queryable without high
/// cardinality. It is only emitted when V8 supplied that measurement.
pub fn runner_heap_peak_used_bucket(used_mb: u64) -> &'static str {
    match used_mb {
        0..=2047 => "under_2gb",
        2048..=2559 => "2gb_to_2_5gb",
        2560..=3071 => "2_5gb_to_3gb",
        3072..=3583 => "3gb_to_3_5gb",
        3584..=4095 => "3_5gb_to_4gb",
        _ => "over_4gb",
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervisor footprint ceiling (the RSS backstop --max-old-space-size cannot give)
// ─────────────────────────────────────────────────────────────────────────────

/// Supervisor high-water mark (MB) for the watcher's WHOLE-TREE footprint. This
/// stays as the floor for lower heap overrides whose heap plus non-heap headroom
/// would otherwise be smaller; the 3,584 MB default instead derives a 5,632 MB
/// backstop, leaving this floor nonbinding. `--max-old-space-size` bounds only V8
/// old space, so external / Buffer memory can still outrun it. This is the
/// platform-independent backstop that lets the app decide the outcome before a
/// macOS jetsam SIGKILL or a Windows commit failure does.
pub const WATCHER_FOOTPRINT_CEILING_MB: u32 = 4608;

/// Absolute whole-tree footprint safety threshold (MB) that pre-empts on ONE
/// comparable supervisor sample. The ordinary ceiling below intentionally needs
/// two samples to ignore a healthy transient, but that would leave the 5,632 MB
/// default-derived backstop only 268 MB below the observed 5,900 MB OS-kill
/// floor. At the 30s supervisor cadence, 5,120 + (20 MB/s * 30s) = 5,720 MB,
/// still below 5,900 MB and leaving 180 MB for termination after the sample.
/// This hard ceiling therefore tolerates a 20 MB/s runaway for a complete missed
/// sampling interval while preserving the ordinary backstop's anti-spike policy.
/// It is absolute even for a user heap override: an override may not trade away
/// the app's ability to pre-empt before the observed OS kill.
pub const WATCHER_FOOTPRINT_HARD_CEILING_MB: u32 = 5120;

/// Consecutive over-ceiling supervisor samples required before a pre-empt. At the
/// 30s supervisor cadence this is ~60s of SUSTAINED over-ceiling footprint, so a
/// single spike or a healthy pull that momentarily peaks near the mark never
/// pre-empts a sync.
pub const WATCHER_FOOTPRINT_CEILING_CONSECUTIVE: u32 = 2;

/// Non-heap headroom (MB) the runner may legitimately hold above its declared
/// old-space ceiling: external/Buffer/ArrayBuffer, code, and stacks that
/// `--max-old-space-size` does not bound. Across 33 heap aborts, tree RSS minus
/// the 2,048 MB cap measured 102 MB minimum, 512 MB p50, and 1,331 MB maximum,
/// so this leaves 717 MB above the observed maximum. The footprint backstop must
/// sit at least this far above the heap ceiling.
pub const WATCHER_FOOTPRINT_HEADROOM_MB: u32 = 2048;

/// The effective supervisor footprint ceiling (MB) for a resolved heap ceiling:
/// the LARGER of the fixed footprint floor and the heap ceiling plus non-heap
/// headroom. Raising the heap override (`HQ_SYNC_RUNNER_MAX_OLD_SPACE_MB` or a
/// user `--max-old-space-size` above the default) therefore also raises the
/// footprint backstop, so the escape hatch that grants more heap is never
/// throttled by a fixed footprint mark below it. Pure.
pub fn effective_watcher_footprint_ceiling_mb(heap_ceiling_mb: u32) -> u32 {
    WATCHER_FOOTPRINT_CEILING_MB.max(heap_ceiling_mb.saturating_add(WATCHER_FOOTPRINT_HEADROOM_MB))
}

/// Supervisor decision: keep the watcher running, or pre-empt it at the declared
/// footprint ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FootprintCeilingDecision {
    KeepRunning,
    Preempt,
}

/// Pure supervisor decision: given a fresh scoped footprint sample and the
/// running over-ceiling streak, return the UPDATED streak and whether to
/// pre-empt. A comparable (whole-tree / job) sample at or above the hard safety
/// threshold pre-empts immediately. Otherwise, ONLY a comparable sample at or
/// above the ordinary ceiling advances the streak; a withheld/shim sample, a
/// missing sample, or one below the ceiling resets it to zero. Pre-empt the
/// ordinary backstop only once the streak reaches the required consecutive count
/// — never on a single spike, never on an unsampled or withheld footprint.
pub fn footprint_ceiling_step(
    sample_kb: Option<u64>,
    scope_comparable: bool,
    ceiling_kb: u64,
    prior_streak: u32,
    required_consecutive: u32,
) -> (u32, FootprintCeilingDecision) {
    let hard_ceiling_kb = u64::from(WATCHER_FOOTPRINT_HARD_CEILING_MB) * 1024;
    if scope_comparable && matches!(sample_kb, Some(kb) if kb >= hard_ceiling_kb) {
        return (0, FootprintCeilingDecision::Preempt);
    }
    let over = scope_comparable && matches!(sample_kb, Some(kb) if kb >= ceiling_kb);
    if !over {
        return (0, FootprintCeilingDecision::KeepRunning);
    }
    let streak = prior_streak.saturating_add(1);
    let decision = if required_consecutive > 0 && streak >= required_consecutive {
        FootprintCeilingDecision::Preempt
    } else {
        FootprintCeilingDecision::KeepRunning
    };
    (streak, decision)
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
/// Defaults to true when the field is missing so a runner that supports the
/// optional event-push capability can use it on a fresh install. An explicit
/// `false` written by `save_settings` still wins. This setting is local-disable
/// only; it cannot enroll a scope or select V2.
pub fn is_instant_sync_enabled() -> bool {
    read_menubar_bool(|p| p.instant_sync, true)
}

/// User-facing message every gated sync entry point returns while Cloud is
/// off. One constant so the popover, the V2 window, and the daemon agree.
pub const CLOUD_PAUSED_MESSAGE: &str =
    "Cloud is off — sync is paused on this device. Turn Cloud on to resume.";

/// Check the V2 "Cloud Off" switch (US-001 / US-016) in menubar.json.
///
/// Defaults to false (connected) when the field is missing so existing
/// installs keep syncing. This is THE choke-point flag: `start_sync`, the
/// watch-daemon starts (renderer / app-launch / supervisor-respawn origins),
/// and therefore auto-sync and instant push all consult it before initiating
/// any sync.
pub fn is_cloud_paused() -> bool {
    read_menubar_bool(|p| p.cloud_paused, false)
}

/// Common preflight for every sync initiation path: `Err(CLOUD_PAUSED_MESSAGE)`
/// while Cloud is off, `Ok(())` otherwise.
pub fn ensure_cloud_sync_allowed() -> Result<(), String> {
    if is_cloud_paused() {
        Err(CLOUD_PAUSED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

/// Check if personal-vault sync is enabled in menubar.json.
///
/// Defaults to true (matches Settings + Sync Now). When false, the watch
/// runner must pass `--skip-personal` so Auto-sync honors the Off toggle.
pub fn is_personal_sync_enabled() -> bool {
    read_menubar_bool(|p| p.personal_sync_enabled, true)
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

/// Explicit watch-daemon lifecycle states used by the supervisor.
///
/// The live Windows defect was a boolean mismatch: the supervisor treated a
/// healthy long-lived runner as "down" whenever `.hq-sync.pid` was absent, then
/// force-cleared the still-registered child after the start deadline. These
/// states make the phases explicit so the app-owned child handle can be
/// authoritative after spawn, while the PID file remains a recovery signal for
/// runners inherited from a previous app session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchDaemonState {
    Stopped,
    Starting,
    Running,
    Backoff,
}

/// Failure categories for content-safe lifecycle diagnostics (no argv, tokens,
/// paths, or file contents).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonFailureCategory {
    None,
    SpawnFailed,
    Crash,
    HeartbeatStall,
    Cancelled,
    ForceClear,
    Backoff,
    Preflight,
    /// The watcher died of runner memory exhaustion (an evidence-attributed
    /// heap OOM / at-or-above-ceiling footprint), or the supervisor pre-empted
    /// it at the declared footprint ceiling. Surfaces "background sync stopped
    /// and why" instead of a silent running → backoff transition.
    RunnerMemory,
}

impl WatchDaemonState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Backoff => "backoff",
        }
    }
}

impl DaemonFailureCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::SpawnFailed => "spawn_failed",
            Self::Crash => "crash",
            Self::HeartbeatStall => "heartbeat_stall",
            Self::Cancelled => "cancelled",
            Self::ForceClear => "force_clear",
            Self::Backoff => "backoff",
            Self::Preflight => "preflight",
            Self::RunnerMemory => "runner_memory",
        }
    }
}

/// Derive the supervisor lifecycle state from app-owned registration, the
/// registered child's liveness, an inherited PID-file runner, and backoff.
///
/// After spawn the process-registry handle is authoritative: a live registered
/// child is `Running` even when no HQ PID file exists. The PID file is only
/// consulted when this app holds no handle (previous-session recovery).
pub fn derive_watch_daemon_state(
    app_owned_registered: bool,
    registered_child_alive: bool,
    pid_file_alive: bool,
    within_backoff: bool,
) -> WatchDaemonState {
    if app_owned_registered {
        if registered_child_alive {
            WatchDaemonState::Running
        } else {
            // Handle held but child not yet observed live (or mid-teardown) →
            // Starting until the start deadline force-clears a wedge.
            WatchDaemonState::Starting
        }
    } else if pid_file_alive {
        WatchDaemonState::Running
    } else if within_backoff {
        WatchDaemonState::Backoff
    } else {
        WatchDaemonState::Stopped
    }
}

/// Supervisor liveness: true only when a runner should not be respawned and
/// must not be force-cleared.
///
/// App-owned registered child is authoritative after spawn. PID-file liveness
/// is a fallback for an inherited daemon this process did not start.
pub fn is_daemon_alive_for_supervisor(
    app_owned_registered: bool,
    registered_child_alive: bool,
    pid_file_alive: bool,
) -> bool {
    if app_owned_registered {
        registered_child_alive
    } else {
        pid_file_alive
    }
}

/// Whether teardown should terminate the Windows Job Object / process group.
/// Idempotent cancel relies on the process registry's cancelled flag; callers
/// should invoke cancel at most once per generation. This pure helper encodes
/// which lifecycle paths are allowed to request termination.
pub fn should_terminate_job_on_path(already_cancelled: bool, path: DaemonFailureCategory) -> bool {
    if already_cancelled {
        return false;
    }
    matches!(
        path,
        DaemonFailureCategory::Crash
            | DaemonFailureCategory::HeartbeatStall
            | DaemonFailureCategory::Cancelled
            | DaemonFailureCategory::ForceClear
            | DaemonFailureCategory::Backoff
            | DaemonFailureCategory::RunnerMemory
    )
}

/// Pure decision for the supervisor: respawn the watch daemon iff auto-sync
/// should be on (the user-facing realtime-sync toggle or the autostart devtools
/// flag) AND it isn't currently alive AND Cloud isn't paused (`is_cloud_paused`,
/// the V2 Cloud Off switch — while it's set, no sync path may start). Extracted
/// (like `should_event_push`) so the decision stays unit-testable.
pub fn should_respawn_daemon_gated(
    realtime_sync: bool,
    autostart: bool,
    daemon_alive: bool,
    cloud_paused: bool,
) -> bool {
    !cloud_paused && should_respawn_daemon(realtime_sync, autostart, daemon_alive)
}

/// See `should_respawn_daemon_gated` — the ungated auto-sync half of the
/// supervisor decision.
pub fn should_respawn_daemon(realtime_sync: bool, autostart: bool, daemon_alive: bool) -> bool {
    (realtime_sync || autostart) && !daemon_alive
}

/// Decide whether the desktop shell must terminate a live-but-stalled watch
/// runner. PID liveness alone only says that a process exists; a runner that
/// has stopped emitting its sync protocol cannot make progress and may still
/// own the per-root operation lock.
pub fn should_cancel_stalled_daemon(
    daemon_registered: bool,
    heartbeat_age: Duration,
    timeout: Duration,
) -> bool {
    daemon_registered && heartbeat_age >= timeout
}

/// Pure decision for the supervisor: force-clear a wedged daemon-start guard.
///
/// The supervisor guards respawns behind an in-process "starting" singleton
/// (the process registry entry). Liveness is measured from the **app-owned
/// child handle** after spawn (and only falls back to the PID file for an
/// inherited runner). When a start acquires that guard yet never yields a live
/// registered child — a hung runner the watchdog cancelled but whose
/// `run_process_impl` never returned to deregister — the two signals disagree:
/// every tick sees the daemon down, calls `start_daemon`, and is refused with
/// "Daemon is already starting". Without a bound the supervisor loops on that
/// forever (observed: 7.5+ hours).
///
/// A bounded start deadline breaks the deadlock for a *true* wedge. A healthy
/// long-lived runner with no HQ PID file keeps `daemon_alive == true` via the
/// registered child, so this never force-clears a live app-owned generation.
/// `start_age` is `None` when no start is in flight (nothing to clear).
pub fn should_force_clear_stalled_start(
    daemon_alive: bool,
    start_age: Option<Duration>,
    deadline: Duration,
) -> bool {
    !daemon_alive && start_age.is_some_and(|age| age >= deadline)
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

    // ── Cloud Off gating (V2 US-001 / US-016) ─────────────────────────────

    #[test]
    fn test_should_respawn_daemon_gated_on_cloud_paused() {
        // Cloud paused dominates every auto-sync-on combination.
        assert!(!should_respawn_daemon_gated(true, false, false, true));
        assert!(!should_respawn_daemon_gated(false, true, false, true));
        assert!(!should_respawn_daemon_gated(true, true, false, true));
        // Cloud connected → falls through to the plain auto-sync decision.
        assert!(should_respawn_daemon_gated(true, false, false, false));
        assert!(!should_respawn_daemon_gated(true, false, true, false));
        assert!(!should_respawn_daemon_gated(false, false, false, false));
    }

    #[test]
    fn test_is_cloud_paused_reads_menubar_and_defaults_connected() {
        let _g = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let old_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        // No menubar.json → connected (never paused by default).
        assert!(!is_cloud_paused());
        assert!(ensure_cloud_sync_allowed().is_ok());

        // Absent field → connected.
        std::fs::write(tmp.path().join(".hq/menubar.json"), r#"{}"#).unwrap();
        assert!(!is_cloud_paused());

        // Explicit pause → every sync initiation gate refuses with the
        // shared user-facing message.
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"cloudPaused":true}"#,
        )
        .unwrap();
        assert!(is_cloud_paused());
        assert_eq!(
            ensure_cloud_sync_allowed(),
            Err(CLOUD_PAUSED_MESSAGE.to_string())
        );

        // Toggling back on restores sync.
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"cloudPaused":false}"#,
        )
        .unwrap();
        assert!(!is_cloud_paused());
        assert!(ensure_cloud_sync_allowed().is_ok());

        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn test_should_cancel_stalled_daemon_requires_live_registered_handle_and_expired_heartbeat() {
        let timeout = Duration::from_secs(300);
        assert!(should_cancel_stalled_daemon(true, timeout, timeout));
        assert!(should_cancel_stalled_daemon(
            true,
            timeout + Duration::from_secs(1),
            timeout
        ));
        assert!(!should_cancel_stalled_daemon(
            true,
            Duration::from_secs(299),
            timeout
        ));
        assert!(!should_cancel_stalled_daemon(false, timeout * 2, timeout));
    }

    #[test]
    fn test_should_force_clear_stalled_start_breaks_respawn_deadlock() {
        let deadline = Duration::from_secs(2 * 60);

        // The wedge: no live daemon and a start that has held the guard past the
        // deadline → force-clear so respawn can proceed. This is exactly the
        // "respawn skipped: Daemon is already starting" loop the bug reported.
        assert!(should_force_clear_stalled_start(
            false,
            Some(deadline),
            deadline
        ));
        assert!(should_force_clear_stalled_start(
            false,
            Some(deadline + Duration::from_secs(1)),
            deadline
        ));

        // A legitimately in-flight start (guard just acquired, PID not written
        // yet) must NOT be force-cleared — it is not yet stale.
        assert!(!should_force_clear_stalled_start(
            false,
            Some(Duration::from_secs(1)),
            deadline
        ));

        // No start in flight → nothing to clear.
        assert!(!should_force_clear_stalled_start(false, None, deadline));

        // Daemon is alive → never force-clear, regardless of guard age.
        assert!(!should_force_clear_stalled_start(
            true,
            Some(deadline * 10),
            deadline
        ));
        assert!(!should_force_clear_stalled_start(true, None, deadline));
    }

    // ── App-owned handle is authoritative (US-002) ───────────────────────

    #[test]
    fn healthy_registered_child_without_pid_file_stays_running() {
        // The live Windows defect: registered child is alive, no .hq-sync.pid.
        let state = derive_watch_daemon_state(
            /* app_owned_registered */ true, /* registered_child_alive */ true,
            /* pid_file_alive */ false, /* within_backoff */ false,
        );
        assert_eq!(state, WatchDaemonState::Running);
        assert!(is_daemon_alive_for_supervisor(true, true, false));
        // Must never force-clear a live app-owned runner after many start deadlines.
        let deadline = Duration::from_secs(2 * 60);
        assert!(!should_force_clear_stalled_start(
            true,
            Some(deadline * 10),
            deadline
        ));
        assert!(!should_respawn_daemon(true, false, true));
    }

    #[test]
    fn derive_watch_daemon_state_covers_stopped_starting_running_backoff() {
        assert_eq!(
            derive_watch_daemon_state(false, false, false, false),
            WatchDaemonState::Stopped
        );
        assert_eq!(
            derive_watch_daemon_state(true, false, false, false),
            WatchDaemonState::Starting
        );
        assert_eq!(
            derive_watch_daemon_state(true, true, false, false),
            WatchDaemonState::Running
        );
        assert_eq!(
            derive_watch_daemon_state(false, false, true, false),
            WatchDaemonState::Running
        );
        assert_eq!(
            derive_watch_daemon_state(false, false, false, true),
            WatchDaemonState::Backoff
        );
    }

    #[test]
    fn supervisor_liveness_prefers_app_owned_handle_over_pid_file() {
        // Live registered child, missing PID file → alive.
        assert!(is_daemon_alive_for_supervisor(true, true, false));
        // Registered but child dead, PID file still claims alive → not alive
        // for this generation (handle is authoritative; inherited PID would
        // only apply when unregistered).
        assert!(!is_daemon_alive_for_supervisor(true, false, true));
        // No app handle, PID file alive → inherited runner.
        assert!(is_daemon_alive_for_supervisor(false, false, true));
        // Nothing → down.
        assert!(!is_daemon_alive_for_supervisor(false, false, false));
    }

    #[test]
    fn job_termination_paths_are_idempotent_once_cancelled() {
        for path in [
            DaemonFailureCategory::Crash,
            DaemonFailureCategory::HeartbeatStall,
            DaemonFailureCategory::Cancelled,
            DaemonFailureCategory::ForceClear,
            DaemonFailureCategory::Backoff,
        ] {
            assert!(
                should_terminate_job_on_path(false, path),
                "first {path:?} must terminate"
            );
            assert!(
                !should_terminate_job_on_path(true, path),
                "second {path:?} must not re-terminate"
            );
        }
        // Non-teardown categories never terminate the job.
        assert!(!should_terminate_job_on_path(
            false,
            DaemonFailureCategory::None
        ));
        assert!(!should_terminate_job_on_path(
            false,
            DaemonFailureCategory::SpawnFailed
        ));
        assert!(!should_terminate_job_on_path(
            false,
            DaemonFailureCategory::Preflight
        ));
    }

    #[test]
    fn force_clear_after_two_start_deadlines_does_not_fire_when_registered_child_live() {
        let deadline = Duration::from_secs(2 * 60);
        // Simulate supervisor checks across ≥2 start deadlines with a healthy
        // registered child and no PID file.
        for _ in 0..3 {
            let alive = is_daemon_alive_for_supervisor(true, true, false);
            assert!(alive);
            assert!(!should_force_clear_stalled_start(
                alive,
                Some(deadline * 2),
                deadline
            ));
        }
    }

    #[test]
    fn lifecycle_state_and_failure_category_serialize_without_sensitive_fields() {
        let state = WatchDaemonState::Running;
        let category = DaemonFailureCategory::HeartbeatStall;
        let payload = serde_json::json!({
            "state": state,
            "failureCategory": category,
        });
        let text = payload.to_string();
        assert!(text.contains("running"));
        assert!(text.contains("heartbeat_stall"));
        assert!(!text.contains("argv"));
        assert!(!text.contains("token"));
        assert!(!text.contains("command"));
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
            failure_category: Some("runner_memory".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"watchPath\""));
        assert!(json.contains("\"failureCategory\":\"runner_memory\""));
        assert!(!json.contains("\"started_at\""));
        assert!(!json.contains("\"watch_path\""));
        assert!(!json.contains("\"failure_category\""));
    }

    #[test]
    fn test_daemon_status_roundtrip() {
        let status = DaemonStatus {
            running: true,
            pid: Some(12345),
            started_at: Some("2026-04-18T12:00:00Z".to_string()),
            watch_path: Some("/Users/test/HQ".to_string()),
            source: "daemon_json".to_string(),
            failure_category: Some("runner_memory".to_string()),
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
            failure_category: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"running\":false"));
        assert!(json.contains("\"pid\":null"));
        assert!(json.contains("\"startedAt\":null"));
        assert!(json.contains("\"watchPath\":null"));
        assert!(json.contains("\"source\":\"none\""));
        // A None failure reason is omitted entirely (skip_serializing_if), so the
        // UI never has to distinguish null from "no reason".
        assert!(!json.contains("failureCategory"));
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
    //   --watch — keep the runner alive after the first pass; hq-cloud owns
    //             the adaptive correctness-poll cadence
    //
    // Conflict policy stays `keep` (cloud-wins with a local sidecar) — cloud
    // takes the working path and the displaced local edit remains recoverable
    // through the existing modal. Direction stays `both`. Companies stays
    // fanned out (`--companies`).

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
    fn test_build_watch_runner_args_binds_the_snapshotted_npx_cache_root() {
        let cache_root = std::path::PathBuf::from("/tmp/hq-npm-cache");
        let target = crate::runner_target::RunnerSpawnTarget::Npx {
            cache_root: crate::runner_target::NpmCacheRoot::Established(cache_root.clone()),
        };
        let args = build_watch_runner_args_for_target("/Users/test/HQ", &target);
        let env = args.env.expect("watch runner env");

        assert_eq!(
            env.get("npm_config_cache"),
            Some(&cache_root.to_string_lossy().into_owned()),
            "npx must use the cache root retained for this launch's attribution"
        );
    }

    #[test]
    fn test_build_watch_runner_args_does_not_bind_an_assumed_npx_cache_root() {
        let target = crate::runner_target::RunnerSpawnTarget::Npx {
            cache_root: crate::runner_target::NpmCacheRoot::Assumed(std::path::PathBuf::from(
                "/tmp/assumed-npm-cache",
            )),
        };
        let args = build_watch_runner_args_for_target("/Users/test/HQ", &target);
        let env = args.env.expect("watch runner env");

        assert!(
            !env.contains_key("npm_config_cache"),
            "an assumed default must not alter npx's cache selection"
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
    fn test_build_watch_runner_args_uses_runner_adaptive_poll_interval() {
        let args = build_watch_runner_args("/any");
        assert!(args.args.contains(&"--watch".to_string()));
        assert!(
            !args.args.iter().any(|arg| arg == "--poll-remote-ms"),
            "omitting --poll-remote-ms lets hq-cloud apply load-aware backoff: {:?}",
            args.args
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

    // ── runner memory ceiling ──────────────────────────────────────────────

    #[test]
    fn test_parse_max_old_space_mb_forms() {
        assert_eq!(parse_max_old_space_mb(None), None);
        assert_eq!(parse_max_old_space_mb(Some("")), None);
        assert_eq!(parse_max_old_space_mb(Some("--enable-source-maps")), None);
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size=3072")),
            Some(3072)
        );
        // Space form and the underscore spelling Node also honours.
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size 1536")),
            Some(1536)
        );
        assert_eq!(
            parse_max_old_space_mb(Some("--max_old_space_size=4096")),
            Some(4096)
        );
        // Last occurrence wins, exactly as Node resolves repeated flags.
        assert_eq!(
            parse_max_old_space_mb(Some(
                "--max-old-space-size=1024 --enable-source-maps --max-old-space-size=8192"
            )),
            Some(8192)
        );
        // Non-numeric value is ignored, not a panic.
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size=big")),
            None
        );
        // Quoted value — Node's NODE_OPTIONS parser honours quoting, so the user's
        // limit must be read (not dropped, which would let the default override it).
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size=\"128\"")),
            Some(128)
        );
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size='256'")),
            Some(256)
        );
        assert_eq!(
            parse_max_old_space_mb(Some("--max-old-space-size \"512\"")),
            Some(512)
        );
        // A lone/mismatched quote is not stripped and stays unparsed, not a panic.
        assert_eq!(parse_max_old_space_mb(Some("--max-old-space-size=\"128")), None);
    }

    #[test]
    fn test_effective_watcher_footprint_ceiling_honours_heap_override() {
        // The default has a derived backstop below the observed OS-kill floor.
        assert_eq!(
            effective_watcher_footprint_ceiling_mb(RUNNER_HEAP_CEILING_DEFAULT_MB),
            5632
        );
        // The fixed floor still protects lower overrides.
        assert_eq!(
            effective_watcher_footprint_ceiling_mb(1024),
            WATCHER_FOOTPRINT_CEILING_MB
        );
        // A raised heap override lifts the footprint backstop above it by the
        // non-heap headroom, so the escape hatch is never throttled below its heap.
        let raised = 6144;
        assert_eq!(
            effective_watcher_footprint_ceiling_mb(raised),
            raised + WATCHER_FOOTPRINT_HEADROOM_MB
        );
        assert!(effective_watcher_footprint_ceiling_mb(raised) > raised);
        // Saturating: an absurd override never overflows.
        assert!(effective_watcher_footprint_ceiling_mb(u32::MAX) >= u32::MAX - 1);
    }

    #[test]
    fn test_declared_runner_heap_ceiling_default_and_provenance() {
        assert_eq!(RUNNER_HEAP_CEILING_DEFAULT_MB, 3584);
        assert_eq!(
            resolve_runner_heap_ceiling(None, None),
            RunnerHeapCeiling {
                mb: 3584,
                source: RunnerHeapCeilingSource::DeclaredDefault,
            }
        );
    }

    #[test]
    fn test_default_footprint_backstop_stays_below_observed_os_kill_floor() {
        // With 2,048 MB headroom, a 3,852 MB default is the first whole-MB value
        // that fails this strict inequality; 4,096 MB would derive 6,144 MB.
        assert!(
            effective_watcher_footprint_ceiling_mb(RUNNER_HEAP_CEILING_DEFAULT_MB)
                < OBSERVED_OS_KILL_FLOOR_MB,
            "the app must pre-empt before the observed OS-kill floor"
        );
    }

    #[test]
    fn test_runner_heap_peak_used_bucket_is_fixed_vocabulary() {
        assert_eq!(runner_heap_peak_used_bucket(0), "under_2gb");
        assert_eq!(runner_heap_peak_used_bucket(2047), "under_2gb");
        assert_eq!(runner_heap_peak_used_bucket(2048), "2gb_to_2_5gb");
        assert_eq!(runner_heap_peak_used_bucket(2560), "2_5gb_to_3gb");
        assert_eq!(runner_heap_peak_used_bucket(3072), "3gb_to_3_5gb");
        assert_eq!(runner_heap_peak_used_bucket(3584), "3_5gb_to_4gb");
        assert_eq!(runner_heap_peak_used_bucket(4096), "over_4gb");
    }

    #[test]
    fn test_resolve_runner_heap_ceiling_precedence() {
        // Declared default when nothing overrides.
        let default = resolve_runner_heap_ceiling(None, None);
        assert_eq!(default.mb, RUNNER_HEAP_CEILING_DEFAULT_MB);
        assert_eq!(default.source, RunnerHeapCeilingSource::DeclaredDefault);

        // Env override raises it without a rebuild.
        let overridden = resolve_runner_heap_ceiling(None, Some(6144));
        assert_eq!(overridden.mb, 6144);
        assert_eq!(overridden.source, RunnerHeapCeilingSource::EnvOverride);

        // A zero/invalid env override falls back to the default, never 0.
        let zero = resolve_runner_heap_ceiling(None, Some(0));
        assert_eq!(zero.mb, RUNNER_HEAP_CEILING_DEFAULT_MB);
        assert_eq!(zero.source, RunnerHeapCeilingSource::DeclaredDefault);

        // An explicit user --max-old-space-size ALWAYS wins, even over an env override.
        let user = resolve_runner_heap_ceiling(Some("--max-old-space-size=1234"), Some(6144));
        assert_eq!(user.mb, 1234);
        assert_eq!(user.source, RunnerHeapCeilingSource::UserNodeOptions);
    }

    #[test]
    fn test_merge_node_options_ceiling_never_clobbers() {
        let default = RunnerHeapCeiling {
            mb: 2048,
            source: RunnerHeapCeilingSource::DeclaredDefault,
        };
        // Appends when NODE_OPTIONS is absent or empty.
        assert_eq!(
            merge_node_options_ceiling(None, default),
            Some("--max-old-space-size=2048".to_string())
        );
        assert_eq!(
            merge_node_options_ceiling(Some("   "), default),
            Some("--max-old-space-size=2048".to_string())
        );
        // Preserves every inherited option verbatim and appends the ceiling.
        assert_eq!(
            merge_node_options_ceiling(Some("--enable-source-maps"), default),
            Some("--enable-source-maps --max-old-space-size=2048".to_string())
        );
        // A user who declared their own ceiling is left untouched (None → inherit
        // as-is), so the user's value wins and no duplicate flag is added.
        let user = RunnerHeapCeiling {
            mb: 1234,
            source: RunnerHeapCeilingSource::UserNodeOptions,
        };
        assert_eq!(
            merge_node_options_ceiling(Some("--max-old-space-size=1234"), user),
            None
        );
    }

    #[test]
    fn test_runner_max_old_space_arg_respects_user_override() {
        for source in [
            RunnerHeapCeilingSource::DeclaredDefault,
            RunnerHeapCeilingSource::EnvOverride,
        ] {
            assert_eq!(
                runner_max_old_space_arg(RunnerHeapCeiling { mb: 2048, source }),
                Some("--max-old-space-size=2048".to_string())
            );
        }
        // Never pass argv when the user set their own value — argv would override it.
        assert_eq!(
            runner_max_old_space_arg(RunnerHeapCeiling {
                mb: 1234,
                source: RunnerHeapCeilingSource::UserNodeOptions
            }),
            None
        );
    }

    #[test]
    fn test_build_watch_runner_args_declares_heap_ceiling_on_npx_path() {
        use crate::test_support::ENV_MUTEX;
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // Clean env → the declared default is applied on the pinned npx path.
        std::env::remove_var("NODE_OPTIONS");
        std::env::remove_var("HQ_CLOUD_LOCAL_RUNNER");
        std::env::remove_var(RUNNER_HEAP_CEILING_ENV);
        let args = build_watch_runner_args("/any");
        let env = args.env.expect("env should be populated");
        let node_options = env
            .get("NODE_OPTIONS")
            .expect("NODE_OPTIONS must declare the runner heap ceiling on the npx path");
        assert!(
            node_options.contains(&format!(
                "--max-old-space-size={}",
                RUNNER_HEAP_CEILING_DEFAULT_MB
            )),
            "expected declared ceiling in NODE_OPTIONS, got: {node_options}"
        );
    }

    // The bare-`node` local-runner path applies the SAME ceiling (in argv and in
    // NODE_OPTIONS). It is proven without a process-global env race by the pure
    // `runner_max_old_space_arg` test above and by the desktop-alt source contract
    // (watcher-memory-ceiling-attribution.spec.ts), which asserts the ceiling is
    // applied on BOTH spawn paths in the shipping source.

    // ── supervisor footprint ceiling ───────────────────────────────────────

    #[test]
    fn test_footprint_ceiling_step_requires_sustained_comparable_breach() {
        let ceiling_kb = u64::from(WATCHER_FOOTPRINT_CEILING_MB) * 1024;
        let required = WATCHER_FOOTPRINT_CEILING_CONSECUTIVE;
        assert!(required >= 2, "a single spike must not pre-empt");

        // A below-ceiling comparable sample never advances the streak.
        assert_eq!(
            footprint_ceiling_step(Some(ceiling_kb - 1), true, ceiling_kb, 5, required),
            (0, FootprintCeilingDecision::KeepRunning)
        );
        // A single over-ceiling sample advances but does not pre-empt.
        let (streak, decision) =
            footprint_ceiling_step(Some(ceiling_kb), true, ceiling_kb, 0, required);
        assert_eq!(streak, 1);
        assert_eq!(decision, FootprintCeilingDecision::KeepRunning);
        // Reaching the required consecutive count pre-empts.
        let (streak, decision) =
            footprint_ceiling_step(Some(ceiling_kb + 1), true, ceiling_kb, required - 1, required);
        assert_eq!(streak, required);
        assert_eq!(decision, FootprintCeilingDecision::Preempt);
        // A non-comparable (shim/withheld) sample resets the streak even when huge —
        // a launcher/shim footprint must never pre-empt the runner.
        assert_eq!(
            footprint_ceiling_step(Some(ceiling_kb * 4), false, ceiling_kb, required - 1, required),
            (0, FootprintCeilingDecision::KeepRunning)
        );
        // A missing (unsampled) tick resets the streak too.
        assert_eq!(
            footprint_ceiling_step(None, true, ceiling_kb, required - 1, required),
            (0, FootprintCeilingDecision::KeepRunning)
        );
    }

    #[test]
    fn test_hard_footprint_ceiling_preempts_one_comparable_sample() {
        let hard_ceiling_kb = u64::from(WATCHER_FOOTPRINT_HARD_CEILING_MB) * 1024;
        let ordinary_ceiling_kb = hard_ceiling_kb + 1;

        // A hard safety breach bypasses the ordinary two-sample anti-spike
        // backstop even when the ordinary ceiling itself has not been crossed.
        assert_eq!(
            footprint_ceiling_step(
                Some(hard_ceiling_kb),
                true,
                ordinary_ceiling_kb,
                0,
                WATCHER_FOOTPRINT_CEILING_CONSECUTIVE,
            ),
            (0, FootprintCeilingDecision::Preempt)
        );
    }

    #[test]
    fn test_build_watch_runner_args_appends_skip_personal_when_disabled() {
        use crate::test_support::ENV_MUTEX;
        use tempfile::TempDir;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"personalSyncEnabled":false}"#,
        )
        .unwrap();
        let prior_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let args = build_watch_runner_args("/Users/test/HQ");
        let env = args.env.clone().expect("env");
        // Restore HOME rather than leaving it unset: other tests in this binary
        // (e.g. paths::tests) depend on ambient HOME, so a dangling remove makes
        // the suite order-dependent.
        match prior_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(
            args.args.last().map(String::as_str),
            Some("--skip-personal"),
            "expected --skip-personal when personalSyncEnabled=false, got: {:?}",
            args.args
        );
        assert_eq!(
            env.get("HQ_SYNC_SKIP_PERSONAL").map(String::as_str),
            Some("1")
        );
    }

    // ── event-push capability (U16) ────────────────────────────────────────

    #[test]
    fn test_should_event_push_requires_runner_capability_and_local_preference() {
        // The flag exposes a local runner capability only; it is not account
        // eligibility and cannot enroll a scope in V2.
        assert!(should_event_push(true, true));
        assert!(!should_event_push(true, false));
        assert!(!should_event_push(false, true));
        assert!(!should_event_push(false, false));
    }

    #[test]
    fn test_legacy_event_push_eligibility_export_fails_closed() {
        assert!(!event_push_eligible());
    }

    #[test]
    fn test_watch_runner_stays_on_sync_runner_after_u59_enables_mutation_sidecar() {
        use crate::hq_cloud::HQ_CLOUD_RUNNER_CAPABILITIES;

        let args = build_watch_runner_args("/any");
        assert!(HQ_CLOUD_RUNNER_CAPABILITIES.v2_mutation);
        assert!(args.args.contains(&"hq-sync-runner".to_string()));
        assert!(
            !args
                .args
                .windows(2)
                .any(|args| args == ["sync", "mutation"]),
            "the watch runner remains V1-compatible; U59's sidecar owns mutation: {:?}",
            args.args
        );
    }
}
