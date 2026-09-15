//! Unified HQ-core state: "in sync" / "drift" / "update available".
//!
//! Replaces three independent checkers (`hq_core_update.rs`,
//! `hq_core_drift.rs`, the drift half of `hq_core_staging.rs`) with one
//! source of truth keyed off the rescue script's three-way classification
//! (see `scripts/replace-rescue.sh` and PR-110 commit 1af82d0). The same
//! mental model the rescue script uses to decide what to do per file
//! (`USER-ONLY` / `UNCHANGED` / `USER-EDIT` vs `last_sync_sha` floor) now
//! powers what the popover shows.
//!
//! Selection rules:
//!   * **release channel** — target = latest tag on `indigoai-us/hq-core`.
//!     Drift is computed against that latest tag's tree, not the user's
//!     pinned `hqVersion`. This means "needs update" and "drift" become
//!     the same question.
//!   * **staging channel** — target = `main` HEAD on staging repo (default
//!     `indigoai-us/hq-core-staging`; team override via `driftStagingRepo`).
//!     Eligible @getindigo.ai user with `stagingChannel != false`, or any
//!     user with an explicit `driftStagingRepo`.
//!
//! Per-file classification mirrors the rescue script when a trustworthy
//! installed baseline exists. When it does not, Core Drift now fails closed
//! instead of inventing counts from target HEAD:
//!   * `USER-EDIT` — local blob ≠ floor:<path>. This is THE drift list.
//!   * `USER-ONLY` — path unknown to floor AND to target tree. Surfaces in
//!     `userOnlyCount` but does NOT count toward the pill.
//!   * `UNCHANGED` — local blob == floor:<path>. Counted only.
//!   * `MISSING`  — in target tree, not local. Informational; overlay
//!     would create on update.
//!
//! Pill drives:
//!   * `isInSync` = `userEdit.len() == 0 && !versionBehind`
//!   * `hasDrift` = `userEdit.len() > 0`
//!   * `needsUpdate` = `versionBehind || hasDrift`
//!
//! Cadence: one bg loop, 30s after launch, then every 6h. Matches the
//! pre-refactor `hq_core_drift` cadence; the dropped checkers (update,
//! staging-drift) each had their own 6h loop — net traffic / API spend goes
//! down.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::commands::config::{read_hq_config_lenient, MenubarPrefs};
use crate::commands::hq_core_drift::{
    excluded_scope_paths_for, is_conflict_artifact, path_in_excluded_scope, path_in_locked_scope,
    read_locked_paths, walk_local_under_scope, BaselineStatus, DriftEntry, DriftReport,
};
use crate::commands::hq_core_staging;
use crate::commands::hq_core_update::get_local_version;
use crate::util::logfile::log;
use crate::util::paths;

const PROD_REPO: &str = "indigoai-us/hq-core";
const DEFAULT_STAGING_REPO: &str = "indigoai-us/hq-core-staging";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
// Native ownership replaces the frontend effect. Start promptly enough that a
// person who opens HQ briefly still receives a Core update, while remaining
// staggered behind the app updater's first check.
const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(21600); // 6h
const CORE_STATE_REUSE_WINDOW: Duration = Duration::from_secs(15);

static CORE_UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
const MAX_CONSECUTIVE_AUTOMATIC_TARGET_FAILURES: u8 = 3;
const CONSECUTIVE_FAILURE_CAP_SKIP_REASON: &str = "consecutive_failure_cap_reached";
const RETRY_INTERVAL_NOT_ELAPSED_SKIP_REASON: &str = "retry_interval_not_elapsed";

/// Automatic retry eligibility is intentionally separate from the update run
/// guard. The guard prevents overlapping Core writes; this state remembers a
/// target that completed without moving the observed version and bounds hard
/// failures until the checker discovers a newer target.
static AUTO_TARGET_STATES: OnceLock<Mutex<HashMap<Channel, AutomaticTargetState>>> =
    OnceLock::new();

/// Channel the user is tracking. Drives target selection + the action-pill
/// label. Carries the resolving repo + ref so the frontend can render
/// "Update to v14.2.0" vs "Update to Staging" without re-parsing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Release,
    Staging,
}

/// Unified state emitted to the frontend. One struct replaces the
/// `hqCoreUpdateAvailable + hqCoreDrift + stagingDrift + stagingReplace`
/// quad in App.svelte.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreState {
    /// Which channel the user is on (drives all the labels + target).
    pub channel: Channel,
    /// Repo we're comparing against (`indigoai-us/hq-core` or staging).
    pub target_repo: String,
    /// Human-displayable target version. For release: `"14.2.0"`. For
    /// staging: the 7-char short SHA of `main` HEAD (e.g. `"1af82d0"`).
    pub target_version: String,
    /// Full commit-ish for the target — release uses `"v14.2.0"`, staging
    /// uses the full 40-char `main` SHA. Used for fetches + display.
    pub target_ref: String,
    /// Locally-installed `hqVersion` from `core.yaml`. `None` when the HQ
    /// folder has no usable `core.yaml`.
    pub local_version: Option<String>,
    /// `replaced_from_source.last_sync_sha` from local `core/core.yaml`, or
    /// a release-tag-derived fallback when no stamp exists. Carries the
    /// installed source commit even across channel/repo switches so the
    /// local baseline identity remains inspectable in diagnostics.
    pub floor_sha: Option<String>,
    /// True when the signed-in user has an `@getindigo.ai` email. Drives
    /// frontend gating: only eligible users see the drift count + can
    /// click the detail-window pill. Non-eligible users see a static
    /// "in sync" label regardless of actual drift state — they don't get
    /// a per-file diagnostic surface, only the rolled-up Update pill.
    pub is_eligible: bool,
    /// True when the local version trails the target. For release,
    /// semver-cmp `local_version < target_version`. For staging, true
    /// when `floor_sha != target_full_sha` (or `floor_sha` is `None`).
    pub version_behind: bool,
    /// USER-EDIT + MISSING + USER-ONLY rolled into the existing
    /// `DriftReport` shape so the drift detail window keeps working
    /// unchanged. `count` reflects USER-EDIT only — informational lists
    /// (missing/userOnly) don't add to the pill total.
    pub drift_report: DriftReport,
    /// Count of UNCHANGED files (local == floor). Diagnostic only — not
    /// shown in UI today, but logged + available for debugging.
    pub unchanged_count: u32,
    /// Count of USER-ONLY files. Listed in `drift_report.added` for
    /// detail-window display, but tracked separately so a future "you
    /// have N user-only files that will survive overlay" surface can
    /// read this without re-counting.
    pub user_only_count: u32,
    /// ISO-8601 timestamp of when the scan ran.
    pub scanned_at: String,
}

struct RecentCoreState {
    at: Instant,
    state: Option<CoreState>,
}

static CORE_STATE_CHECK: tokio::sync::Mutex<Option<RecentCoreState>> =
    tokio::sync::Mutex::const_new(None);

/// True when a previous `check_core_state` result can be reused instead of
/// starting another scan. Stale at and after `window`.
fn recent_core_state_is_reusable(at: Instant, now: Instant, window: Duration) -> bool {
    now.saturating_duration_since(at) < window
}

/// Native ownership decision for the periodic Core updater. Kept pure so the
/// updater gates stay reviewable and unit-testable independently of network,
/// Tauri, and the rescue subprocess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoreAutoUpdateDecision {
    Ignore,
    SkipAutomaticUpdatesDisabled,
    DeferForSync,
    Install,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoreUpdateErrorKind {
    AlreadyInProgress,
    InvalidCoreRoot,
    Network,
    RescueSpawn,
    BaselinePersistence,
    ChannelConfiguration,
    Internal,
}

impl CoreUpdateErrorKind {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::AlreadyInProgress => "already_in_progress",
            Self::InvalidCoreRoot => "invalid_core_root",
            Self::Network => "network",
            Self::RescueSpawn => "rescue_spawn",
            Self::BaselinePersistence => "baseline_persistence",
            Self::ChannelConfiguration => "channel_configuration",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug)]
pub(crate) struct CoreUpdateError {
    kind: CoreUpdateErrorKind,
    message: String,
    npx_resolution: Option<CoreUpdateNpxResolution>,
}

impl CoreUpdateError {
    pub(crate) fn new(kind: CoreUpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            npx_resolution: None,
        }
    }

    pub(crate) fn with_npx_resolution(mut self, npx_resolution: CoreUpdateNpxResolution) -> Self {
        self.npx_resolution = Some(npx_resolution);
        self
    }

    pub(crate) const fn kind(&self) -> CoreUpdateErrorKind {
        self.kind
    }

    pub(crate) const fn npx_resolution(&self) -> Option<CoreUpdateNpxResolution> {
        self.npx_resolution
    }
}

/// Path-free, closed diagnostic for the `npx` executable used to launch the
/// Core rescue. The source is one of the resolver's stable telemetry tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CoreUpdateNpxResolution {
    /// Whether the chosen program can be spawned. This is false for both a
    /// missing `npx` and a Windows shim that exists but the loader rejects.
    pub(crate) resolved: bool,
    pub(crate) source: &'static str,
}

/// Closed telemetry dimension for why a Core rescue failed.
///
/// This remains a dimension rather than raw diagnostic text: hq-pro admits
/// `errorCategory` as a short safe label, while its telemetry privacy boundary
/// deliberately rejects free-form process output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RescueFailureCategory {
    MissingDependency,
    Auth,
    Network,
    Dns,
    Tls,
    DiskFull,
    Permission,
    NotFound,
    NpxResolveFailed,
    Timeout,
    Unknown,
}

impl RescueFailureCategory {
    const ALL: &[Self] = &[
        Self::MissingDependency,
        Self::Auth,
        Self::Network,
        Self::Dns,
        Self::Tls,
        Self::DiskFull,
        Self::Permission,
        Self::NotFound,
        Self::NpxResolveFailed,
        Self::Timeout,
        Self::Unknown,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::MissingDependency => "missing_dependency",
            Self::Auth => "auth",
            Self::Network => "network",
            Self::Dns => "dns",
            Self::Tls => "tls",
            Self::DiskFull => "disk-full",
            Self::Permission => "permission",
            Self::NotFound => "not-found",
            Self::NpxResolveFailed => "npx-resolve-failed",
            Self::Timeout => "timeout",
            Self::Unknown => "unknown",
        }
    }
}

struct RescueStderrPattern {
    category: RescueFailureCategory,
    needle: &'static str,
}

// Rescue emits local preflight diagnostics before allocating a safety snapshot;
// Git supplies the transport signals for a rescue process that then exits
// unsuccessfully. Keep every recognized stderr phrase in this one ordered
// table: specific causes must precede their broader counterparts.
const RESCUE_STDERR_PATTERNS: &[RescueStderrPattern] = &[
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "rsync preflight failed",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Auth,
        needle: "authentication failed",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Auth,
        needle: "could not read username",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Auth,
        needle: "permission denied (publickey)",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Dns,
        needle: "could not resolve host",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Dns,
        needle: "name or service not known",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Tls,
        needle: "ssl certificate problem",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Tls,
        needle: "certificate verify failed",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::DiskFull,
        needle: "no space left on device",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Permission,
        needle: "operation not permitted",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Permission,
        needle: "permission denied",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::NotFound,
        needle: "repository not found",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::NotFound,
        needle: "remote: not found",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Timeout,
        needle: "operation timed out",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Timeout,
        needle: "connection timed out",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "failed to connect",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "connection refused",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "connection reset",
    },
];

fn classify_rescue_stderr_failure(stderr: &str) -> RescueFailureCategory {
    let stderr = stderr.to_ascii_lowercase();
    RESCUE_STDERR_PATTERNS
        .iter()
        .find(|pattern| stderr.contains(pattern.needle))
        .map(|pattern| pattern.category)
        .unwrap_or(RescueFailureCategory::Unknown)
}

pub(crate) fn classify_rescue_exit_failure(
    stderr: &str,
    npx_resolution: CoreUpdateNpxResolution,
) -> RescueFailureCategory {
    if !npx_resolution.resolved {
        return RescueFailureCategory::NpxResolveFailed;
    }
    classify_rescue_stderr_failure(stderr)
}

pub(crate) fn classify_core_update_error(
    error_kind: CoreUpdateErrorKind,
    npx_resolution: Option<CoreUpdateNpxResolution>,
) -> RescueFailureCategory {
    if npx_resolution.is_some_and(|resolution| !resolution.resolved) {
        return RescueFailureCategory::NpxResolveFailed;
    }

    match error_kind {
        CoreUpdateErrorKind::Network => RescueFailureCategory::Network,
        CoreUpdateErrorKind::AlreadyInProgress
        | CoreUpdateErrorKind::InvalidCoreRoot
        | CoreUpdateErrorKind::RescueSpawn
        | CoreUpdateErrorKind::BaselinePersistence
        | CoreUpdateErrorKind::ChannelConfiguration
        | CoreUpdateErrorKind::Internal => RescueFailureCategory::Unknown,
    }
}

/// Additional diagnostics emitted only with `core_update_failed`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CoreUpdateFailureDetails<'a> {
    /// A redacted 16 KiB rescue-log tail retained for the Sentry diagnostic.
    pub(crate) rescue_stderr_tail: Option<&'a str>,
    pub(crate) rescue_failure_category: RescueFailureCategory,
    pub(crate) npx_resolution: Option<CoreUpdateNpxResolution>,
}

impl std::fmt::Display for CoreUpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CoreUpdateTelemetryContext {
    source: &'static str,
    version_behind: Option<bool>,
}

impl CoreUpdateTelemetryContext {
    pub(crate) const fn manual() -> Self {
        Self {
            source: "manual",
            version_behind: None,
        }
    }

    pub(crate) const fn automatic(version_behind: bool) -> Self {
        Self {
            source: "automatic",
            version_behind: Some(version_behind),
        }
    }

    pub(crate) const fn source(self) -> &'static str {
        self.source
    }

    pub(crate) const fn version_behind(self) -> Option<bool> {
        self.version_behind
    }
}

fn core_auto_update_decision(
    auto_update_enabled: bool,
    version_behind: bool,
    sync_in_progress: bool,
) -> CoreAutoUpdateDecision {
    if !version_behind {
        CoreAutoUpdateDecision::Ignore
    } else if !auto_update_enabled {
        CoreAutoUpdateDecision::SkipAutomaticUpdatesDisabled
    } else if sync_in_progress {
        CoreAutoUpdateDecision::DeferForSync
    } else {
        CoreAutoUpdateDecision::Install
    }
}

/// Process-wide guard shared by release and staging rescue commands. Native
/// background ownership adds a second caller alongside manual UI actions, so
/// the old per-component booleans are no longer sufficient to prevent two
/// overlays from running at once.
pub(crate) struct CoreUpdateRunGuard;

impl Drop for CoreUpdateRunGuard {
    fn drop(&mut self) {
        CORE_UPDATE_RUNNING.store(false, Ordering::Release);
    }
}

pub(crate) fn try_begin_core_update() -> Result<CoreUpdateRunGuard, CoreUpdateError> {
    CORE_UPDATE_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| CoreUpdateRunGuard)
        .map_err(|_| {
            CoreUpdateError::new(
                CoreUpdateErrorKind::AlreadyInProgress,
                "an HQ Core update is already in progress",
            )
        })
}

fn channel_label(channel: Channel) -> &'static str {
    match channel {
        Channel::Release => "release",
        Channel::Staging => "staging",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutomaticTargetState {
    target: String,
    consecutive_failures: u8,
    completed_without_version_move: bool,
    last_failure_at: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutomaticTargetEligibility {
    Eligible,
    CompletedWithoutVersionMove,
    ConsecutiveFailureCapReached,
    RetryIntervalNotElapsed,
}

fn automatic_target_eligibility(channel: Channel, target: &str) -> AutomaticTargetEligibility {
    automatic_target_eligibility_at(channel, target, Instant::now())
}

fn automatic_target_eligibility_at(
    channel: Channel,
    target: &str,
    attempted_at: Instant,
) -> AutomaticTargetEligibility {
    let states = AUTO_TARGET_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(state) = states.get(&channel) else {
        return AutomaticTargetEligibility::Eligible;
    };
    if state.target != target {
        // State belongs to a single target per channel, so observing a newer
        // target starts a fresh retry budget and drops old non-convergence.
        return AutomaticTargetEligibility::Eligible;
    }
    if state.completed_without_version_move {
        AutomaticTargetEligibility::CompletedWithoutVersionMove
    } else if state.consecutive_failures >= MAX_CONSECUTIVE_AUTOMATIC_TARGET_FAILURES {
        AutomaticTargetEligibility::ConsecutiveFailureCapReached
    } else if state.last_failure_at.is_some_and(|last_failure_at| {
        attempted_at.saturating_duration_since(last_failure_at) < CHECK_INTERVAL
    }) {
        AutomaticTargetEligibility::RetryIntervalNotElapsed
    } else {
        AutomaticTargetEligibility::Eligible
    }
}

fn record_automatic_target_failure_at(channel: Channel, target: &str, attempted_at: Instant) {
    let mut states = AUTO_TARGET_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = states
        .entry(channel)
        .or_insert_with(|| AutomaticTargetState {
            target: target.to_string(),
            consecutive_failures: 0,
            completed_without_version_move: false,
            last_failure_at: None,
        });
    if state.target != target {
        *state = AutomaticTargetState {
            target: target.to_string(),
            consecutive_failures: 0,
            completed_without_version_move: false,
            last_failure_at: None,
        };
    }
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.last_failure_at = Some(attempted_at);
}

fn record_automatic_target_completed(channel: Channel, target: &str) {
    AUTO_TARGET_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            channel,
            AutomaticTargetState {
                target: target.to_string(),
                consecutive_failures: 0,
                completed_without_version_move: true,
                last_failure_at: None,
            },
        );
}

#[cfg(test)]
fn reset_automatic_target_states_for_test() {
    if let Some(states) = AUTO_TARGET_STATES.get() {
        states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

#[allow(clippy::too_many_arguments)]
fn core_update_event_properties(
    source: &'static str,
    result: &'static str,
    channel: Option<Channel>,
    local_version: Option<&str>,
    target_version: Option<&str>,
    auto_update_enabled: bool,
    eligible: Option<bool>,
    version_behind: Option<bool>,
    duration: Duration,
    exit_code: Option<i32>,
    error_kind: Option<&'static str>,
    skip_reason: Option<&'static str>,
) -> Map<String, Value> {
    let mut properties = Map::new();
    properties.insert("source".to_string(), Value::String(source.to_string()));
    properties.insert("result".to_string(), Value::String(result.to_string()));
    properties.insert(
        "desktopVersion".to_string(),
        Value::String(env!("APP_VERSION").to_string()),
    );
    properties.insert(
        "autoUpdateEnabled".to_string(),
        Value::Bool(auto_update_enabled),
    );
    properties.insert(
        "durationMs".to_string(),
        json!(duration.as_millis().min(u64::MAX as u128) as u64),
    );
    if let Some(channel) = channel {
        properties.insert(
            "channel".to_string(),
            Value::String(channel_label(channel).to_string()),
        );
    }
    if let Some(version) = local_version {
        properties.insert(
            "localCoreVersion".to_string(),
            Value::String(version.to_string()),
        );
    }
    if let Some(version) = target_version {
        properties.insert(
            "targetCoreVersion".to_string(),
            Value::String(version.to_string()),
        );
    }
    if let Some(eligible) = eligible {
        properties.insert("eligible".to_string(), Value::Bool(eligible));
    }
    if let Some(version_behind) = version_behind {
        properties.insert("versionBehind".to_string(), Value::Bool(version_behind));
    }
    if let Some(exit_code) = exit_code {
        properties.insert("exitCode".to_string(), json!(exit_code));
    }
    if let Some(error_kind) = error_kind {
        properties.insert(
            "errorKind".to_string(),
            Value::String(error_kind.to_string()),
        );
    }
    if let Some(skip_reason) = skip_reason {
        properties.insert(
            "skipReason".to_string(),
            Value::String(skip_reason.to_string()),
        );
    }
    properties
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_core_update_event(
    event_name: &'static str,
    source: &'static str,
    result: &'static str,
    channel: Option<Channel>,
    local_version: Option<&str>,
    target_version: Option<&str>,
    auto_update_enabled: bool,
    eligible: Option<bool>,
    version_behind: Option<bool>,
    duration: Duration,
    exit_code: Option<i32>,
    error_kind: Option<&'static str>,
    skip_reason: Option<&'static str>,
) {
    let properties = core_update_event_properties(
        source,
        result,
        channel,
        local_version,
        target_version,
        auto_update_enabled,
        eligible,
        version_behind,
        duration,
        exit_code,
        error_kind,
        skip_reason,
    );
    crate::commands::telemetry::emit_desktop_telemetry_best_effort(
        event_name,
        Value::Object(properties),
    );
}

#[allow(clippy::too_many_arguments)]
fn core_update_failed_properties(
    source: &'static str,
    channel: Channel,
    local_version: Option<&str>,
    auto_update_enabled: bool,
    eligible: Option<bool>,
    version_behind: Option<bool>,
    duration: Duration,
    exit_code: Option<i32>,
    error_kind: &'static str,
    details: CoreUpdateFailureDetails<'_>,
) -> Map<String, Value> {
    let mut properties = core_update_event_properties(
        source,
        "failed",
        Some(channel),
        local_version,
        None,
        auto_update_enabled,
        eligible,
        version_behind,
        duration,
        exit_code,
        Some(error_kind),
        None,
    );
    properties.insert(
        "platform".to_string(),
        Value::String(crate::commands::version_gate::platform_tag()),
    );
    properties.insert(
        "errorCategory".to_string(),
        Value::String(details.rescue_failure_category.label().to_string()),
    );
    if let Some(npx_resolution) = details.npx_resolution {
        properties.insert(
            "npxResolved".to_string(),
            Value::Bool(npx_resolution.resolved),
        );
        properties.insert(
            "npxResolution".to_string(),
            Value::String(npx_resolution.source.to_string()),
        );
    }
    properties
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_core_update_failed_event(
    source: &'static str,
    channel: Channel,
    local_version: Option<&str>,
    auto_update_enabled: bool,
    eligible: Option<bool>,
    version_behind: Option<bool>,
    duration: Duration,
    exit_code: Option<i32>,
    error_kind: &'static str,
    details: CoreUpdateFailureDetails<'_>,
) {
    crate::commands::telemetry::emit_desktop_telemetry_best_effort(
        "core_update_failed",
        Value::Object(core_update_failed_properties(
            source,
            channel,
            local_version,
            auto_update_enabled,
            eligible,
            version_behind,
            duration,
            exit_code,
            error_kind,
            details,
        )),
    );
    queue_core_update_failure_report(source, channel, exit_code, error_kind, details);
}

/// The Sentry grouping pair for a Core update failure. Every field is a closed
/// vocabulary token; target version and rescue output deliberately stay out of
/// the signature so a single underlying defect does not fragment into issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CoreUpdateSentryFailureSignature {
    error_kind: &'static str,
    error_category: RescueFailureCategory,
}

static CORE_UPDATE_SENTRY_SIGNATURES: OnceLock<Mutex<HashSet<CoreUpdateSentryFailureSignature>>> =
    OnceLock::new();

#[derive(Debug, Clone)]
struct CoreUpdateSentryFailureReport {
    source: &'static str,
    channel: Channel,
    exit_code: Option<i32>,
    error_kind: &'static str,
    error_category: RescueFailureCategory,
    rescue_stderr_tail: Option<String>,
    npx_resolution: Option<CoreUpdateNpxResolution>,
}

fn core_update_sentry_error_kind(error_kind: &'static str) -> &'static str {
    match error_kind {
        "already_in_progress"
        | "invalid_core_root"
        | "network"
        | "rescue_spawn"
        | "baseline_persistence"
        | "channel_configuration"
        | "internal"
        | "rescue_exit" => error_kind,
        _ => "other",
    }
}

fn core_update_sentry_source(source: &'static str) -> &'static str {
    match source {
        "automatic" | "manual" => source,
        _ => "other",
    }
}

fn core_update_sentry_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => "other",
    }
}

fn core_update_sentry_exit_code(exit_code: Option<i32>) -> &'static str {
    match exit_code {
        Some(1) => "1",
        Some(2) => "2",
        Some(3) => "3",
        Some(4) => "4",
        Some(5) => "5",
        Some(-1) => "signal_or_unknown",
        Some(_) => "other",
        None => "not_available",
    }
}

fn claim_core_update_sentry_signature(signature: CoreUpdateSentryFailureSignature) -> bool {
    CORE_UPDATE_SENTRY_SIGNATURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(signature)
}

fn send_core_update_failure_report(report: CoreUpdateSentryFailureReport) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let fingerprint = [report.error_kind, report.error_category.label()];
        sentry::with_scope(
            |sentry_scope| {
                sentry_scope.set_fingerprint(Some(&fingerprint));
                sentry_scope.set_tag("errorKind", report.error_kind);
                sentry_scope.set_tag("errorCategory", report.error_category.label());
                sentry_scope.set_tag("channel", channel_label(report.channel));
                sentry_scope.set_tag("platform", core_update_sentry_platform());
                sentry_scope.set_tag("source", core_update_sentry_source(report.source));
                sentry_scope.set_tag("exitCode", core_update_sentry_exit_code(report.exit_code));
                sentry_scope.set_extra(
                    "coreUpdateExitCode",
                    report
                        .exit_code
                        .map(|code| sentry::protocol::Value::Number(code.into()))
                        .unwrap_or(sentry::protocol::Value::Null),
                );
                sentry_scope.set_extra(
                    "coreUpdateAppVersion",
                    sentry::protocol::Value::String(env!("APP_VERSION").to_string()),
                );
                if let Some(rescue_stderr_tail) = report.rescue_stderr_tail {
                    sentry_scope.set_extra(
                        "rescueStderrTail",
                        sentry::protocol::Value::String(rescue_stderr_tail),
                    );
                }
                if let Some(npx_resolution) = report.npx_resolution {
                    sentry_scope.set_extra(
                        "npxResolved",
                        sentry::protocol::Value::Bool(npx_resolution.resolved),
                    );
                    sentry_scope.set_extra(
                        "npxResolution",
                        sentry::protocol::Value::String(npx_resolution.source.to_string()),
                    );
                }
            },
            || sentry::capture_message("Desktop Core update failed", sentry::Level::Error),
        );
    }));
}

fn report_core_update_failure_once(report: CoreUpdateSentryFailureReport) {
    let signature = CoreUpdateSentryFailureSignature {
        error_kind: report.error_kind,
        error_category: report.error_category,
    };
    if claim_core_update_sentry_signature(signature) {
        send_core_update_failure_report(report);
    }
}

fn queue_core_update_failure_report(
    source: &'static str,
    channel: Channel,
    exit_code: Option<i32>,
    error_kind: &'static str,
    details: CoreUpdateFailureDetails<'_>,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source_hub = sentry::Hub::current();
        if source_hub.client().is_none() {
            return;
        }
        let report = CoreUpdateSentryFailureReport {
            source,
            channel,
            exit_code,
            error_kind: core_update_sentry_error_kind(error_kind),
            error_category: details.rescue_failure_category,
            rescue_stderr_tail: details
                .rescue_stderr_tail
                .map(hq_telemetry::redact_core_update_diagnostic_tail),
            npx_resolution: details.npx_resolution,
        };
        let hub = std::sync::Arc::new(sentry::Hub::new_from_top(source_hub));
        hq_telemetry::dispatch_sentry_report(move || {
            sentry::Hub::run(hub, || report_core_update_failure_once(report));
        });
    }));
}

#[cfg(test)]
fn reset_core_update_sentry_signatures_for_test() {
    if let Some(signatures) = CORE_UPDATE_SENTRY_SIGNATURES.get() {
        signatures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

async fn check_once_observed(
    app: &AppHandle,
    source: &'static str,
) -> Result<Option<CoreState>, CoreUpdateError> {
    let started = Instant::now();
    let result = check_once(app).await;
    let auto_updates = hq_desktop_core::hq_cli_update::auto_update_enabled();
    match &result {
        Ok(Some(state)) => emit_core_update_event(
            "core_update_check",
            source,
            if state.version_behind {
                "update_available"
            } else {
                "up_to_date"
            },
            Some(state.channel),
            state.local_version.as_deref(),
            Some(&state.target_version),
            auto_updates,
            Some(state.is_eligible),
            Some(state.version_behind),
            started.elapsed(),
            None,
            None,
            None,
        ),
        Ok(None) => emit_core_update_event(
            "core_update_check",
            source,
            "unavailable",
            None,
            None,
            None,
            auto_updates,
            None,
            None,
            started.elapsed(),
            None,
            None,
            None,
        ),
        Err(error) => emit_core_update_event(
            "core_update_check",
            source,
            "failed",
            None,
            None,
            None,
            auto_updates,
            None,
            None,
            started.elapsed(),
            None,
            Some(error.kind().label()),
            None,
        ),
    }
    result
}

// ─── GitHub API shapes ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
}

#[derive(Debug, Deserialize)]
struct GhCommit {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GhTreesResponse {
    #[serde(default)]
    tree: Vec<GhTreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GhTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

// ─── Channel selection ───────────────────────────────────────────────────────

/// Resolve the active channel by reading prefs. Mirrors the staging-repo
/// gating in `hq_core_staging.rs`:
///   * eligible `@getindigo.ai` user with `stagingChannel != false` → Staging
///   * any user with an explicit `driftStagingRepo` → Staging (using that repo)
///   * otherwise → Release
fn resolve_channel() -> (Channel, String) {
    let prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());

    let explicit_repo = prefs
        .as_ref()
        .and_then(|p| p.drift_staging_repo.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(repo) = explicit_repo {
        return (Channel::Staging, repo);
    }

    let staging_pref_on = prefs
        .as_ref()
        .and_then(|p| p.staging_channel)
        .unwrap_or(true);

    let eligible = hq_core_staging::is_eligible_email(
        crate::commands::cognito::read_tokens_from_file()
            .ok()
            .flatten()
            .and_then(|t| t.id_token)
            .and_then(|tok| crate::commands::cognito::decode_id_token_claims(&tok).ok())
            .and_then(|c| c.email)
            .as_deref(),
    );

    if eligible && staging_pref_on {
        (Channel::Staging, DEFAULT_STAGING_REPO.to_string())
    } else {
        (Channel::Release, PROD_REPO.to_string())
    }
}

// ─── Target resolution ───────────────────────────────────────────────────────

/// Fetch the latest release tag from `indigoai-us/hq-core`. Returns the
/// raw `tag_name` (e.g. `"v14.2.0"`) — caller strips the `v` for display.
async fn fetch_latest_release_tag(client: &reqwest::Client) -> Result<String, String> {
    let url = "https://api.github.com/repos/indigoai-us/hq-core/releases/latest";
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("releases/latest HTTP {}", resp.status()));
    }
    let parsed: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("parse release JSON: {e}"))?;
    Ok(parsed.tag_name.trim().to_string())
}

/// Fetch the commit SHA a ref points to (branch name, tag, or short SHA).
async fn fetch_commit_sha(
    client: &reqwest::Client,
    repo: &str,
    git_ref: &str,
) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{repo}/commits/{git_ref}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("commits/{git_ref} HTTP {}", resp.status()));
    }
    let parsed: GhCommit = resp
        .json()
        .await
        .map_err(|e| format!("parse commit JSON: {e}"))?;
    let sha = parsed.sha.trim().to_string();
    if sha.len() < 40 {
        return Err(format!("unexpected SHA length: {sha:?}"));
    }
    Ok(sha)
}

/// Fetch staging `main`'s HEAD commit SHA (back-compat shim).
async fn fetch_main_head_sha(client: &reqwest::Client, repo: &str) -> Result<String, String> {
    fetch_commit_sha(client, repo, "main").await
}

/// Fetch a tree at any ref (tag, branch, commit SHA). Returns
/// `path → (blob_sha, size)`. Drops symlinks (mode `120000`) — their blob
/// is the target-path string, not the target's content.
async fn fetch_tree(
    client: &reqwest::Client,
    repo: &str,
    git_ref: &str,
) -> Result<BTreeMap<String, (String, u64)>, String> {
    let url = format!("https://api.github.com/repos/{repo}/git/trees/{git_ref}?recursive=1");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("git/trees/{git_ref} HTTP {}", resp.status()));
    }
    let parsed: GhTreesResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse trees JSON: {e}"))?;
    if parsed.truncated {
        log(
            "hq-core-state",
            &format!("WARNING: tree at {repo}@{git_ref} truncated — drift is a lower bound"),
        );
    }
    let mut out = BTreeMap::new();
    for e in parsed.tree {
        if e.kind != "blob" {
            continue;
        }
        if e.mode.as_deref() == Some("120000") {
            continue;
        }
        out.insert(e.path, (e.sha, e.size.unwrap_or(0)));
    }
    Ok(out)
}

pub(crate) async fn persist_remote_baseline(
    hq_folder: &std::path::Path,
    client: &reqwest::Client,
    repo: &str,
    git_ref: &str,
) -> Result<String, String> {
    let commit = fetch_commit_sha(client, repo, git_ref).await?;
    let blobs = fetch_tree(client, repo, &commit)
        .await?
        .into_iter()
        .map(|(path, (sha, _))| (path, sha))
        .collect();
    hq_desktop_core::drift_scope::persist_core_drift_baseline(hq_folder, repo, &commit, blobs)?;
    Ok(commit)
}

// ─── Floor SHA reader ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LocalCoreYaml {
    #[serde(default)]
    replaced_from_source: Option<LocalSourceStamp>,
    #[serde(default)]
    replaced_from_staging: Option<LocalSourceStamp>,
}

#[derive(Debug, Deserialize)]
struct LocalSourceStamp {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    last_sync_sha: Option<String>,
}

fn local_source_stamp(hq_folder: &std::path::Path) -> Option<(String, String)> {
    let canonical = hq_folder.join("core").join("core.yaml");
    let legacy = hq_folder.join("core.yaml");
    let bytes = std::fs::read(if canonical.is_file() {
        canonical
    } else {
        legacy
    })
    .ok()?;
    let parsed: LocalCoreYaml = serde_yaml::from_slice(&bytes).ok()?;
    let stamp = parsed
        .replaced_from_source
        .or(parsed.replaced_from_staging)?;
    let source = stamp.source?.trim().to_string();
    let commit = stamp.last_sync_sha?.trim().to_string();
    (!source.is_empty() && !commit.is_empty()).then_some((source, commit))
}

// ─── Version compare ─────────────────────────────────────────────────────────

/// Lexicographic semver compare (a < b iff a is older). Borrowed from
/// `hq_core_update::cmp_semver` shape: split on `.`, compare numerically.
fn semver_lt(local: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .map(|c| c.split(|x: char| !x.is_ascii_digit()).next().unwrap_or(""))
            .map(|c| c.parse::<u64>().unwrap_or(0))
            .collect()
    };
    parse(local) < parse(latest)
}

// ─── Core check ──────────────────────────────────────────────────────────────

/// One unified check. Returns `Ok(None)` only when we can't compute at all
/// (no HQ folder, no `core.yaml`, no `rules.locked`). Returns `Ok(Some)`
/// for both "in sync" and "drifted" cases — frontend renders both.
async fn check_once(app: &AppHandle) -> Result<Option<CoreState>, CoreUpdateError> {
    let started = Instant::now();
    // Resolve HQ folder + local version (same path the old checkers used).
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let config = read_hq_config_lenient().ok().flatten();
    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    let local_version = get_local_version();

    let locked = read_locked_paths(&hq_folder);
    // Hard bail only when there's NOTHING to surface. If we still know the
    // local version we can compute `version_behind` even without a drift
    // scope and render the Update pill (preserves the legacy
    // `check_hq_core_update` behavior for users whose `core.yaml` lost
    // `rules.locked` — the old path only needed `hqVersion`, and Codex's
    // P2 review on PR #110 flagged the unconditional bail as a regression
    // that would strand those users on an older hq-core).
    let drift_scan_possible = !locked.is_empty();
    if !drift_scan_possible && local_version.is_none() {
        return Ok(None);
    }

    // Channel + target + eligibility (used for frontend gating).
    let (mut channel, mut target_repo) = resolve_channel();
    let signed_in_email = crate::commands::cognito::read_tokens_from_file()
        .ok()
        .flatten()
        .and_then(|t| t.id_token)
        .and_then(|tok| crate::commands::cognito::decode_id_token_claims(&tok).ok())
        .and_then(|c| c.email);
    let is_eligible = hq_core_staging::is_eligible_email(signed_in_email.as_deref());

    // Use staging's authed client when on staging — burns gh token for
    // higher rate limits + works with private repos. On release we use
    // an anonymous client (the public hq-core repo doesn't need auth).
    //
    // Staging-auth missing → fall back to Release. The popover previously
    // got the prod release Update pill from the separate
    // `check_hq_core_update` codepath whenever staging was dark; after
    // unification we'd have stranded the user with no state at all if
    // their `gh` token was missing/expired. Falling back keeps the
    // Update CTA alive on the release channel (Codex P2 review on PR
    // #110). NOTE: this strictly affects users who have no `gh`
    // token — eligible @indigo users with a token still get the
    // staging channel as intended.
    let client = match channel {
        Channel::Staging => match hq_core_staging::resolve_gh_token() {
            Some(token) => staging_authed_client(&token)
                .map_err(|error| CoreUpdateError::new(CoreUpdateErrorKind::Network, error))?,
            None => {
                log(
                    "hq-core-state",
                    "staging channel selected but no gh token; falling back to Release",
                );
                channel = Channel::Release;
                target_repo = PROD_REPO.to_string();
                reqwest::Client::builder()
                    .default_headers(crate::util::client_info::client_headers())
                    .timeout(REQUEST_TIMEOUT)
                    .build()
                    .map_err(|error| {
                        CoreUpdateError::new(
                            CoreUpdateErrorKind::Network,
                            format!("build client: {error}"),
                        )
                    })?
            }
        },
        Channel::Release => reqwest::Client::builder()
            .default_headers(crate::util::client_info::client_headers())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| {
                CoreUpdateError::new(
                    CoreUpdateErrorKind::Network,
                    format!("build client: {error}"),
                )
            })?,
    };

    let (target_ref, target_version) = match channel {
        Channel::Release => {
            let tag = fetch_latest_release_tag(&client)
                .await
                .map_err(|error| CoreUpdateError::new(CoreUpdateErrorKind::Network, error))?;
            let version = tag.trim_start_matches('v').to_string();
            (tag, version)
        }
        Channel::Staging => {
            let sha = fetch_main_head_sha(&client, &target_repo)
                .await
                .map_err(|error| CoreUpdateError::new(CoreUpdateErrorKind::Network, error))?;
            let short = sha.chars().take(7).collect::<String>();
            (sha, short)
        }
    };

    // Floor identity. Keep the installed source/commit even when the user has
    // switched channels: the local persisted baseline remains authoritative for
    // classifying already-installed content across repo changes.
    //
    // Codex P2 review on PR #110: when the stamp is empty (pre-rescue
    // install — common for prod users seeing the new Update pill for the
    // first time), fall through to `v{local_version}`'s SHA on the
    // release channel. Without this fallback the classifier would have no
    // trustworthy installed baseline for pre-rescue prod users and would
    // otherwise need to fail closed immediately. Mirrors the spawn-side
    // `--floor-sha` derivation in `install_hq_core_update` so the popover
    // count and the rescue behavior agree.
    let installed_stamp = local_source_stamp(&hq_folder);
    let floor_identity: Option<(String, String)> = match installed_stamp.clone() {
        Some(identity) => Some(identity),
        None => match (channel, local_version.as_deref()) {
            (Channel::Release, Some(ver)) => {
                let tag = format!("v{ver}");
                match fetch_commit_sha(&client, &target_repo, &tag).await {
                    Ok(sha) => {
                        log(
                            "hq-core-state",
                            &format!(
                                "no stamp; using {tag} as derived floor (sha={sha}) for {target_repo}"
                            ),
                        );
                        Some((target_repo.clone(), sha))
                    }
                    Err(e) => {
                        log(
                            "hq-core-state",
                            &format!(
                                "no stamp + {tag} lookup failed ({e}); no trustworthy installed baseline, failing closed"
                            ),
                        );
                        None
                    }
                }
            }
            _ => None,
        },
    };
    let floor_sha = floor_identity.as_ref().map(|(_, sha)| sha.clone());

    // Fetch trees. Target only if we're actually going to scan drift.
    // Floor only if available + matches source.
    let (target_tree, floor_blobs) = if drift_scan_possible {
        let target_tree = fetch_tree(&client, &target_repo, &target_ref)
            .await
            .map_err(|error| CoreUpdateError::new(CoreUpdateErrorKind::Network, error))?;
        let floor_blobs = match floor_identity.as_ref() {
            Some((source, commit)) => {
                let local = hq_desktop_core::drift_scope::load_core_drift_baseline(
                    &hq_folder, source, commit,
                )
                .map(|baseline| baseline.normalized_blobs);
                if local.is_some() {
                    local
                } else if source == &target_repo {
                    match fetch_tree(&client, source, commit).await {
                        Ok(tree) => Some(
                            tree.into_iter()
                                .map(|(path, (sha, _))| (path, sha))
                                .collect(),
                        ),
                        Err(e) => {
                            log(
                                "hq-core-state",
                                &format!(
                                    "baseline {source}@{commit} unavailable locally and remotely ({e}); failing closed"
                                ),
                            );
                            None
                        }
                    }
                } else {
                    log(
                        "hq-core-state",
                        &format!(
                            "source switched from {source} to {target_repo}, but local baseline {commit} is missing; failing closed"
                        ),
                    );
                    None
                }
            }
            None => None,
        };
        (Some(target_tree), floor_blobs)
    } else {
        log(
            "hq-core-state",
            "no `rules.locked` in core.yaml; skipping drift scan and reporting empty drift report (version_behind still computed)",
        );
        (None, None)
    };

    // Drift classification — fail closed only when a scan was possible but no
    // trustworthy installed baseline existed. When there is no locked scope,
    // keep the legacy "empty drift report, version-only update signal"
    // behavior instead of forcing an update-required state.
    let (drift_report, unchanged_count, user_only_count): (DriftReport, u32, u32) =
        if let (Some(target_tree), Some(floor_blobs)) = (target_tree, floor_blobs) {
            // Local files under locked scopes.
            // Pack landings + static runtime excludes (see drift_scope).
            let excluded = excluded_scope_paths_for(&hq_folder);
            let local = walk_local_under_scope(&hq_folder, &locked);
            let local: BTreeMap<String, (String, u64)> = local
                .into_iter()
                .filter(|(p, _)| !path_in_excluded_scope(p, &excluded))
                .filter(|(p, _)| !is_conflict_artifact(p))
                .collect();

            let target_in_scope: BTreeMap<String, (String, u64)> = target_tree
                .into_iter()
                .filter(|(p, _)| path_in_locked_scope(p, &locked))
                .filter(|(p, _)| !path_in_excluded_scope(p, &excluded))
                .collect();

            let floor_in_scope: BTreeMap<String, String> = floor_blobs
                .into_iter()
                .filter(|(p, _)| path_in_locked_scope(p, &locked))
                .filter(|(p, _)| !path_in_excluded_scope(p, &excluded))
                .collect();

            // Three-way classify each path (USER-EDIT goes to `modified`,
            // MISSING goes to `missing`, USER-ONLY goes to `added` —
            // preserves the DriftReport shape the detail window already
            // renders).
            let mut user_edit: Vec<DriftEntry> = Vec::new();
            let mut missing: Vec<DriftEntry> = Vec::new();
            let mut user_only: Vec<DriftEntry> = Vec::new();
            let mut unchanged_count: u32 = 0;

            let target_paths: BTreeSet<&String> = target_in_scope.keys().collect();
            let local_paths: BTreeSet<&String> = local.keys().collect();

            for path in target_paths.intersection(&local_paths) {
                let (sha_target, _) = &target_in_scope[*path];
                let (sha_local, size_local) = &local[*path];

                // A path introduced after the installed baseline is not a
                // local edit. Compare it to target only for this new-file case.
                let classification_sha = floor_in_scope
                    .get(*path)
                    .cloned()
                    .unwrap_or_else(|| sha_target.clone());

                if sha_local == &classification_sha {
                    unchanged_count += 1;
                } else {
                    user_edit.push(DriftEntry {
                        path: (*path).clone(),
                        size: *size_local,
                        git_sha_local: Some(sha_local.clone()),
                        git_sha_upstream: Some(sha_target.clone()),
                        staging_status: None,
                    });
                }
            }
            for path in target_paths.difference(&local_paths) {
                let (sha_target, size_target) = &target_in_scope[*path];
                missing.push(DriftEntry {
                    path: (*path).clone(),
                    size: *size_target,
                    git_sha_local: None,
                    git_sha_upstream: Some(sha_target.clone()),
                    staging_status: None,
                });
            }
            for path in local_paths.difference(&target_paths) {
                let (sha_local, size_local) = &local[*path];
                // Codex P2 review on PR #110: "Classify removed floor
                // files against the floor". A path missing from
                // `target_paths` isn't automatically USER-ONLY — if it
                // existed in the floor tree (the user's installed
                // baseline) and was removed upstream since then,
                // ownership depends on whether the local copy still
                // matches the floor:
                //
                //   * sha_local == floor_sha → upstream deleted a file
                //     the user hadn't touched. Not drift — count it
                //     UNCHANGED (the rescue overlay will delete the
                //     local copy cleanly). Mirrors the rescue script's
                //     "removed upstream, unchanged locally" handling.
                //
                //   * sha_local != floor_sha → user edited a file
                //     upstream later removed. Real work — surface as
                //     USER-EDIT (with `git_sha_upstream = None` since
                //     target has no copy) so the rescue moves the edit
                //     to personal/ instead of silently dropping it.
                //
                //   * floor doesn't know this path → genuinely
                //     locally-authored under a locked scope. USER-ONLY,
                //     same as before.
                let floor_sha_at_path = floor_in_scope.get(*path);
                match floor_sha_at_path {
                    Some(fsha) if sha_local == fsha => {
                        unchanged_count += 1;
                    }
                    Some(_) => {
                        user_edit.push(DriftEntry {
                            path: (*path).clone(),
                            size: *size_local,
                            git_sha_local: Some(sha_local.clone()),
                            git_sha_upstream: None,
                            staging_status: None,
                        });
                    }
                    None => {
                        user_only.push(DriftEntry {
                            path: (*path).clone(),
                            size: *size_local,
                            git_sha_local: Some(sha_local.clone()),
                            git_sha_upstream: None,
                            staging_status: None,
                        });
                    }
                }
            }

            // Staging-aware classification (decorates USER-EDIT +
            // USER-ONLY rows with `staging_status` so the detail window
            // can show "this file already exists in PR #182"). Only run
            // when the user is actively on the Staging channel — for
            // Release-channel reports the staging tags would be
            // misleading noise (the user opted out of staging via
            // Settings, or never had access). Also avoids hitting the
            // staging repo for a release-only user (Codex P2 review on
            // PR #110: "Respect the staging-channel opt-out for
            // badges"). Fail-quiet: ineligible users see None.
            if matches!(channel, Channel::Staging) {
                if let Some(index) = hq_core_staging::build_index_if_eligible().await {
                    for entry in user_edit.iter_mut().chain(user_only.iter_mut()) {
                        if let Some(sha) = entry.git_sha_local.as_deref() {
                            entry.staging_status = Some(index.classify(&entry.path, sha));
                        }
                    }
                }
            }

            let user_only_count = user_only.len() as u32;

            let report = DriftReport {
                baseline_status: BaselineStatus::Available,
                update_required: false,
                // PILL TOTAL is USER-EDIT only — drift = work the user has done.
                // Missing files (overlay would install) + user-only files (overlay
                // would leave alone) are listed in the detail window but don't
                // contribute to the count.
                count: user_edit.len(),
                modified: user_edit,
                missing,
                added: user_only,
                scanned_at: chrono::Utc::now().to_rfc3339(),
                // hq_version on the report = the ref this report was
                // scanned *against*, NOT the local installed version.
                // The detail window uses this to link to the upstream
                // blob and `restore_from_upstream` fetches from it, so
                // it must match the tree whose blob SHAs are in
                // `entry.git_sha_upstream`. Discriminator on `@`:
                //   - release: bare version string like "14.2.1"
                //   - staging: "owner/repo@ref" like "…@a1b2c3d"
                hq_version: match channel {
                    Channel::Release => target_version.clone(),
                    Channel::Staging => format!("{target_repo}@{target_ref}"),
                },
                target_repo: target_repo.clone(),
                target_ref: match channel {
                    // Restore needs the `v`-prefixed tag for release
                    // (matches the raw-content URL convention); SHA
                    // works as-is for staging.
                    Channel::Release => target_ref.clone(),
                    Channel::Staging => target_ref.clone(),
                },
            };
            (report, unchanged_count, user_only_count)
        } else if drift_scan_possible {
            // A locked scope exists, but there is no trustworthy baseline for
            // the installed source/commit. Do not compare against the latest
            // channel head: surface an explicit fail-closed state instead.
            let report = DriftReport {
                baseline_status: BaselineStatus::BaselineUnavailable,
                update_required: true,
                count: 0,
                modified: Vec::new(),
                missing: Vec::new(),
                added: Vec::new(),
                scanned_at: chrono::Utc::now().to_rfc3339(),
                // hq_version on the report = the ref this report was
                // scanned *against*, NOT the local installed version.
                // The detail window uses this to link to the upstream
                // blob and `restore_from_upstream` fetches from it, so
                // it must match the tree whose blob SHAs are in
                // `entry.git_sha_upstream`. Discriminator on `@`:
                //   - release: bare version string like "14.2.1"
                //   - staging: "owner/repo@ref" like "…@a1b2c3d"
                hq_version: match channel {
                    Channel::Release => target_version.clone(),
                    Channel::Staging => format!("{target_repo}@{target_ref}"),
                },
                target_repo: target_repo.clone(),
                target_ref: match channel {
                    // Restore needs the `v`-prefixed tag for release
                    // (matches the raw-content URL convention); SHA
                    // works as-is for staging.
                    Channel::Release => target_ref.clone(),
                    Channel::Staging => target_ref.clone(),
                },
            };
            (report, 0, 0)
        } else {
            let report = DriftReport {
                baseline_status: BaselineStatus::Available,
                update_required: false,
                count: 0,
                modified: Vec::new(),
                missing: Vec::new(),
                added: Vec::new(),
                scanned_at: chrono::Utc::now().to_rfc3339(),
                hq_version: match channel {
                    Channel::Release => target_version.clone(),
                    Channel::Staging => format!("{target_repo}@{target_ref}"),
                },
                target_repo: target_repo.clone(),
                target_ref: match channel {
                    Channel::Release => target_ref.clone(),
                    Channel::Staging => target_ref.clone(),
                },
            };
            (report, 0, 0)
        };

    let version_behind = drift_report.update_required
        || match channel {
            Channel::Release => {
                // Trust the rescue stamp's SHA over the in-file `hqVersion` string:
                // upstream releases sometimes ship a stale `hqVersion` in
                // `core.yaml` (e.g. v14.2.1 carrying `hqVersion: "14.2.0"`), which
                // would otherwise make the pill keep offering a no-op upgrade
                // forever. If the last rescue stamped the same commit the release
                // tag points to, we're on the release regardless of what the
                // string says.
                let stamp_matches_tag = match floor_sha.as_deref() {
                    Some(floor) => match fetch_commit_sha(&client, &target_repo, &target_ref).await
                    {
                        Ok(tag_sha) => floor == tag_sha,
                        Err(_) => false,
                    },
                    None => false,
                };
                if stamp_matches_tag {
                    false
                } else {
                    match local_version.as_deref() {
                        Some(v) => semver_lt(v, &target_version),
                        None => false,
                    }
                }
            }
            Channel::Staging => match floor_sha.as_deref() {
                Some(floor) => !target_ref.starts_with(floor) && !floor.starts_with(&target_ref),
                None => true, // no floor on staging = treat as behind
            },
        };

    let state = CoreState {
        channel,
        target_repo,
        target_version,
        target_ref,
        local_version,
        floor_sha,
        is_eligible,
        version_behind,
        drift_report,
        unchanged_count,
        user_only_count,
        scanned_at: chrono::Utc::now().to_rfc3339(),
    };

    log(
        "hq-core-state",
        &format!(
            "check: channel={:?} target={}@{} local={:?} floor={:?} version_behind={} user_edit={} missing={} user_only={} unchanged={} elapsed_ms={}",
            state.channel,
            state.target_repo,
            state.target_version,
            state.local_version,
            state.floor_sha,
            state.version_behind,
            state.drift_report.modified.len(),
            state.drift_report.missing.len(),
            state.drift_report.added.len(),
            state.unchanged_count,
            started.elapsed().as_millis(),
        ),
    );

    // Emit. Drift detail window keeps its `drift:report` listener — pipe
    // the report there too so its render stays live across re-checks.
    let _ = app.emit("core-state:changed", &state);
    if let Some(slot) = app.try_state::<crate::commands::drift_detail::PendingDrift>() {
        *slot.0.lock().unwrap() = Some(state.drift_report.clone());
    }
    let _ = app.emit_to(
        crate::commands::drift_detail::WINDOW_LABEL,
        "drift:report",
        &state.drift_report,
    );

    Ok(Some(state))
}

/// Crate-local helper — mirrors `hq_core_staging::authed_client` without
/// dragging that function out of its module. Keeps this module's GH calls
/// using the same UA + bearer header conventions.
fn staging_authed_client(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = crate::util::client_info::client_headers();
    let bearer = format!("Bearer {token}");
    if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer) {
        headers.insert(reqwest::header::AUTHORIZATION, v);
    }
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("build authed client: {e}"))
}

/// Tauri command — synchronous one-shot. Used by Settings + post-action
/// refreshes (post-rescue, post-install-update, post-channel-toggle).
///
/// Concurrent callers share one in-flight scan: the mutex is held for the
/// duration of the check, so a second caller waits and then reuses the
/// just-finished result instead of kicking off another GitHub walk.
#[tauri::command]
pub async fn check_core_state(app: AppHandle) -> Result<Option<CoreState>, String> {
    let mut slot = CORE_STATE_CHECK.lock().await;
    let now = Instant::now();
    if let Some(recent) = slot.as_ref() {
        if recent_core_state_is_reusable(recent.at, now, CORE_STATE_REUSE_WINDOW) {
            log(
                "hq-core-state",
                &format!(
                    "check: served recent result age={}ms",
                    now.saturating_duration_since(recent.at).as_millis()
                ),
            );
            return Ok(recent.state.clone());
        }
    }

    let result = check_once_observed(&app, "ui").await;
    if let Ok(state) = &result {
        *slot = Some(RecentCoreState {
            at: Instant::now(),
            state: state.clone(),
        });
        if let Some(state) = state {
            let handle = app.clone();
            let state = state.clone();
            // Return the check result to the UI immediately; automatic rescue is a
            // native background concern and may take several minutes.
            tauri::async_runtime::spawn(async move {
                run_native_core_auto_update(&handle, &state).await;
            });
        }
    }
    result.map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy)]
struct CoreAutoUpdateCandidate<'a> {
    channel: Channel,
    local_version: Option<&'a str>,
    target_version: &'a str,
    is_eligible: bool,
    version_behind: bool,
}

impl<'a> From<&'a CoreState> for CoreAutoUpdateCandidate<'a> {
    fn from(state: &'a CoreState) -> Self {
        Self {
            channel: state.channel,
            local_version: state.local_version.as_deref(),
            target_version: &state.target_version,
            is_eligible: state.is_eligible,
            version_behind: state.version_behind,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeCoreAutoUpdateOutcome {
    Ignored,
    SkippedAutomaticUpdatesDisabled,
    DeferredForSync,
    SkippedAlreadyInProgress,
    SkippedAlreadyAttempted,
    SkippedConsecutiveFailureCap,
    SkippedRetryInterval,
    Succeeded,
    FailedExit(i32),
    Failed(CoreUpdateErrorKind),
}

async fn execute_native_core_auto_update<F, Fut>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<i32, CoreUpdateError>>,
{
    execute_native_core_auto_update_with_clock(
        candidate,
        auto_updates,
        sync_in_progress,
        Instant::now,
        install,
    )
    .await
}

async fn execute_native_core_auto_update_with_clock<F, Fut, Now>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    now: Now,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<i32, CoreUpdateError>>,
    Now: Fn() -> Instant,
{
    match core_auto_update_decision(auto_updates, candidate.version_behind, sync_in_progress) {
        CoreAutoUpdateDecision::Ignore => NativeCoreAutoUpdateOutcome::Ignored,
        CoreAutoUpdateDecision::SkipAutomaticUpdatesDisabled => {
            log(
                "hq-core-update",
                "native auto-update skipped: automatic updates disabled",
            );
            emit_core_update_event(
                "core_update_skipped",
                "automatic",
                "skipped",
                Some(candidate.channel),
                candidate.local_version,
                Some(candidate.target_version),
                false,
                Some(candidate.is_eligible),
                Some(candidate.version_behind),
                Duration::ZERO,
                None,
                None,
                Some("automatic_updates_disabled"),
            );
            NativeCoreAutoUpdateOutcome::SkippedAutomaticUpdatesDisabled
        }
        CoreAutoUpdateDecision::DeferForSync => {
            log(
                "hq-core-update",
                "native auto-update deferred: sync in progress",
            );
            emit_core_update_event(
                "core_update_skipped",
                "automatic",
                "deferred",
                Some(candidate.channel),
                candidate.local_version,
                Some(candidate.target_version),
                true,
                Some(candidate.is_eligible),
                Some(candidate.version_behind),
                Duration::ZERO,
                None,
                None,
                Some("sync_in_progress"),
            );
            NativeCoreAutoUpdateOutcome::DeferredForSync
        }
        CoreAutoUpdateDecision::Install => {
            // Do not gate on `state.is_eligible`: that field means Indigo
            // staging-email eligibility. Release-channel client users (the
            // majority of HQ installs) must receive automatic Core updates.
            let run_guard = match try_begin_core_update() {
                Ok(guard) => guard,
                Err(error) => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: another Core update is in progress",
                    );
                    emit_core_update_event(
                        "core_update_skipped",
                        "automatic",
                        "skipped",
                        Some(candidate.channel),
                        candidate.local_version,
                        Some(candidate.target_version),
                        true,
                        Some(candidate.is_eligible),
                        Some(candidate.version_behind),
                        Duration::ZERO,
                        None,
                        Some(error.kind().label()),
                        Some(error.kind().label()),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedAlreadyInProgress;
                }
            };
            match automatic_target_eligibility_at(
                candidate.channel,
                candidate.target_version,
                now(),
            ) {
                AutomaticTargetEligibility::Eligible => {}
                AutomaticTargetEligibility::CompletedWithoutVersionMove => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: target already completed without a version move",
                    );
                    emit_core_update_event(
                        "core_update_skipped",
                        "automatic",
                        "skipped",
                        Some(candidate.channel),
                        candidate.local_version,
                        Some(candidate.target_version),
                        true,
                        Some(candidate.is_eligible),
                        Some(candidate.version_behind),
                        Duration::ZERO,
                        None,
                        None,
                        Some("already_attempted_this_session"),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedAlreadyAttempted;
                }
                AutomaticTargetEligibility::ConsecutiveFailureCapReached => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: consecutive failure cap reached",
                    );
                    emit_core_update_event(
                        "core_update_skipped",
                        "automatic",
                        "skipped",
                        Some(candidate.channel),
                        candidate.local_version,
                        Some(candidate.target_version),
                        true,
                        Some(candidate.is_eligible),
                        Some(candidate.version_behind),
                        Duration::ZERO,
                        None,
                        None,
                        Some(CONSECUTIVE_FAILURE_CAP_SKIP_REASON),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedConsecutiveFailureCap;
                }
                AutomaticTargetEligibility::RetryIntervalNotElapsed => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: retry interval has not elapsed",
                    );
                    emit_core_update_event(
                        "core_update_skipped",
                        "automatic",
                        "skipped",
                        Some(candidate.channel),
                        candidate.local_version,
                        Some(candidate.target_version),
                        true,
                        Some(candidate.is_eligible),
                        Some(candidate.version_behind),
                        Duration::ZERO,
                        None,
                        None,
                        Some(RETRY_INTERVAL_NOT_ELAPSED_SKIP_REASON),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedRetryInterval;
                }
            }
            log(
                "hq-core-update",
                &format!(
                    "native auto-update starting: channel={} local={:?} target={}",
                    channel_label(candidate.channel),
                    candidate.local_version,
                    candidate.target_version
                ),
            );
            let observation = CoreUpdateTelemetryContext::automatic(candidate.version_behind);
            let result = install(candidate.channel, run_guard, observation).await;
            match result {
                Ok(0) => {
                    record_automatic_target_completed(candidate.channel, candidate.target_version);
                    log("hq-core-update", "native auto-update succeeded");
                    NativeCoreAutoUpdateOutcome::Succeeded
                }
                Ok(exit_code) => {
                    record_automatic_target_failure_at(
                        candidate.channel,
                        candidate.target_version,
                        now(),
                    );
                    log(
                        "hq-core-update",
                        &format!("native auto-update failed: rescue_exit={exit_code}"),
                    );
                    NativeCoreAutoUpdateOutcome::FailedExit(exit_code)
                }
                Err(error) => {
                    record_automatic_target_failure_at(
                        candidate.channel,
                        candidate.target_version,
                        now(),
                    );
                    log(
                        "hq-core-update",
                        &format!(
                            "native auto-update failed: category={}",
                            error.kind().label()
                        ),
                    );
                    NativeCoreAutoUpdateOutcome::Failed(error.kind())
                }
            }
        }
    }
}

#[cfg(test)]
async fn execute_native_core_auto_update_at<F, Fut>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    attempted_at: Instant,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<i32, CoreUpdateError>>,
{
    execute_native_core_auto_update_with_clock(
        candidate,
        auto_updates,
        sync_in_progress,
        || attempted_at,
        install,
    )
    .await
}

async fn run_native_core_auto_update(app: &AppHandle, state: &CoreState) {
    let outcome = execute_native_core_auto_update(
        CoreAutoUpdateCandidate::from(state),
        hq_desktop_core::hq_cli_update::auto_update_enabled(),
        crate::updater::sync_in_progress(),
        |channel, run_guard, observation| async move {
            match channel {
                Channel::Release => {
                    crate::commands::hq_core_update::install_hq_core_update_automatic(
                        run_guard,
                        observation,
                    )
                    .await
                    .map(|run| run.exit_code)
                }
                Channel::Staging => {
                    crate::commands::hq_core_staging::run_replace_from_staging_automatic(
                        run_guard,
                        observation,
                    )
                    .await
                    .map(|run| run.exit_code)
                }
            }
        },
    )
    .await;

    if outcome == NativeCoreAutoUpdateOutcome::Succeeded {
        // Refresh the public state immediately so every window clears the stale
        // update badge without waiting six hours.
        if let Err(error) = check_once_observed(app, "post_install").await {
            log(
                "hq-core-state",
                &format!("post-install refresh failed: {error}"),
            );
        }
    }
}

/// Background loop. Replaces three pre-refactor loops (update, drift,
/// staging-drift) with one and owns automatic Core installation natively.
/// First check 30s after launch, then every 6h.
pub fn setup_core_state_checker(app: &AppHandle) {
    let post_sync_handle = app.clone();
    app.listen(crate::events::EVENT_SYNC_ALL_COMPLETE, move |_event| {
        let handle = post_sync_handle.clone();
        tauri::async_runtime::spawn(async move {
            match check_once_observed(&handle, "post_sync").await {
                Ok(Some(state)) => run_native_core_auto_update(&handle, &state).await,
                Ok(None) => {}
                Err(error) => log("hq-core-state", &format!("post-sync check failed: {error}")),
            }
        });
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            match check_once_observed(&handle, "background").await {
                Ok(Some(state)) => run_native_core_auto_update(&handle, &state).await,
                Ok(None) => {}
                Err(error) => {
                    log(
                        "hq-core-state",
                        &format!("background check failed: {error}"),
                    );
                }
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};

    static CORE_UPDATE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static CORE_UPDATE_SENTRY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // Snapshot of the hq-pro entries that can admit `core_update_failed`
    // properties. Mirrors
    // src/vault-service/handlers/raw-telemetry-envelope.ts. CI for this repo
    // cannot import hq-pro, so the test below makes server-list drift explicit.
    const HQ_PRO_LABEL_PROPERTY_KEYS: &[&str] = &[
        "channel",
        "desktopVersion",
        "errorCategory",
        "errorKind",
        "localCoreVersion",
        "platform",
        "result",
        "source",
    ];
    const HQ_PRO_BOOLEAN_PROPERTY_KEYS: &[&str] =
        &["autoUpdateEnabled", "eligible", "versionBehind"];
    const HQ_PRO_NUMBER_PROPERTY_KEYS: &[&str] = &["durationMs", "exitCode"];
    const EXPECTED_HQ_PRO_CORE_UPDATE_PROPERTY_GAPS: &[&str] = &["npxResolution", "npxResolved"];

    fn hq_pro_admits_core_update_property(key: &str) -> bool {
        HQ_PRO_LABEL_PROPERTY_KEYS.contains(&key)
            || HQ_PRO_BOOLEAN_PROPERTY_KEYS.contains(&key)
            || HQ_PRO_NUMBER_PROPERTY_KEYS.contains(&key)
    }

    #[tokio::test]
    async fn core_update_run_guard_serializes_and_releases_the_update_slot() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let first = try_begin_core_update().expect("first update owns the slot");
        assert!(try_begin_core_update().is_err());
        drop(first);

        let retry = try_begin_core_update().expect("dropping the guard releases the slot");
        drop(retry);
    }

    #[tokio::test]
    async fn automatic_target_state_is_scoped_to_the_channel() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let target = "15.0.117-deduplication-contract";

        record_automatic_target_completed(Channel::Release, target);
        assert_eq!(
            automatic_target_eligibility(Channel::Release, target),
            AutomaticTargetEligibility::CompletedWithoutVersionMove
        );
        assert_eq!(
            automatic_target_eligibility(Channel::Staging, target),
            AutomaticTargetEligibility::Eligible
        );
    }

    #[tokio::test]
    async fn failed_automatic_target_waits_for_the_next_check_interval_before_retrying() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let target = "15.0.117-retry-after-failure-contract";
        let candidate = || CoreAutoUpdateCandidate {
            channel: Channel::Release,
            local_version: Some("15.0.4"),
            target_version: target,
            is_eligible: true,
            version_behind: true,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let first_attempt_at = Instant::now();

        let first_calls = Arc::clone(&calls);
        let first = execute_native_core_auto_update_at(
            candidate(),
            true,
            false,
            first_attempt_at,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                first_calls.fetch_add(1, Ordering::AcqRel);
                Ok(5)
            },
        )
        .await;

        let before_interval_calls = Arc::clone(&calls);
        let before_interval = execute_native_core_auto_update_at(
            candidate(),
            true,
            false,
            first_attempt_at + CHECK_INTERVAL - Duration::from_secs(1),
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                before_interval_calls.fetch_add(1, Ordering::AcqRel);
                Ok(5)
            },
        )
        .await;

        let after_interval_calls = Arc::clone(&calls);
        let after_interval = execute_native_core_auto_update_at(
            candidate(),
            true,
            false,
            first_attempt_at + CHECK_INTERVAL,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                after_interval_calls.fetch_add(1, Ordering::AcqRel);
                Ok(0)
            },
        )
        .await;

        assert_eq!(first, NativeCoreAutoUpdateOutcome::FailedExit(5));
        assert_eq!(
            before_interval,
            NativeCoreAutoUpdateOutcome::SkippedRetryInterval
        );
        assert_eq!(after_interval, NativeCoreAutoUpdateOutcome::Succeeded);
        assert_eq!(
            calls.load(Ordering::Acquire),
            2,
            "only the first and next-cycle automatic attempts may invoke the installer"
        );
        assert_eq!(
            RETRY_INTERVAL_NOT_ELAPSED_SKIP_REASON,
            "retry_interval_not_elapsed"
        );
    }

    #[tokio::test]
    async fn successful_but_unchanged_target_stays_suppressed_until_a_newer_target() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let old_target = "15.0.117-success-without-version-move-contract";
        let candidate = |target| CoreAutoUpdateCandidate {
            channel: Channel::Release,
            // The installer below reports zero without changing this observed
            // local version, which is the non-convergence case we must retain.
            local_version: Some("15.0.4"),
            target_version: target,
            is_eligible: true,
            version_behind: true,
        };
        let calls = Arc::new(AtomicUsize::new(0));

        let first_calls = Arc::clone(&calls);
        let first = execute_native_core_auto_update(
            candidate(old_target),
            true,
            false,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                first_calls.fetch_add(1, Ordering::AcqRel);
                Ok(0)
            },
        )
        .await;

        let blocked = execute_native_core_auto_update(
            candidate(old_target),
            true,
            false,
            |_, run_guard, _| async move {
                let _run_guard = run_guard;
                panic!("a successful-but-unchanged target must remain suppressed");
            },
        )
        .await;

        let new_target_calls = Arc::clone(&calls);
        let newer = execute_native_core_auto_update(
            candidate("15.0.118-new-target-contract"),
            true,
            false,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                new_target_calls.fetch_add(1, Ordering::AcqRel);
                Ok(0)
            },
        )
        .await;

        assert_eq!(first, NativeCoreAutoUpdateOutcome::Succeeded);
        assert_eq!(
            blocked,
            NativeCoreAutoUpdateOutcome::SkippedAlreadyAttempted
        );
        assert_eq!(newer, NativeCoreAutoUpdateOutcome::Succeeded);
        assert_eq!(calls.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn automatic_retry_stops_after_three_consecutive_failures() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let target = "15.0.117-consecutive-failure-cap-contract";
        let candidate = || CoreAutoUpdateCandidate {
            channel: Channel::Release,
            local_version: Some("15.0.4"),
            target_version: target,
            is_eligible: true,
            version_behind: true,
        };
        let calls = Arc::new(AtomicUsize::new(0));

        let first_attempt_at = Instant::now();
        for failure_number in 0..MAX_CONSECUTIVE_AUTOMATIC_TARGET_FAILURES {
            let failure_calls = Arc::clone(&calls);
            let outcome = execute_native_core_auto_update_at(
                candidate(),
                true,
                false,
                first_attempt_at + CHECK_INTERVAL * u32::from(failure_number),
                move |_, run_guard, _| async move {
                    let _run_guard = run_guard;
                    failure_calls.fetch_add(1, Ordering::AcqRel);
                    Ok(5)
                },
            )
            .await;
            assert_eq!(outcome, NativeCoreAutoUpdateOutcome::FailedExit(5));
        }

        let capped = execute_native_core_auto_update_at(
            candidate(),
            true,
            false,
            first_attempt_at
                + CHECK_INTERVAL * u32::from(MAX_CONSECUTIVE_AUTOMATIC_TARGET_FAILURES),
            |_, run_guard, _| async move {
                let _run_guard = run_guard;
                panic!("the capped target must not start another automatic install");
            },
        )
        .await;

        assert_eq!(
            capped,
            NativeCoreAutoUpdateOutcome::SkippedConsecutiveFailureCap
        );
        assert_eq!(calls.load(Ordering::Acquire), 3);
        assert_eq!(
            CONSECUTIVE_FAILURE_CAP_SKIP_REASON,
            "consecutive_failure_cap_reached"
        );
    }

    #[tokio::test]
    async fn manual_retry_is_not_gated_by_an_automatic_failure_cap() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let target = "15.0.117-manual-retry-contract";
        let first_failure_at = Instant::now();
        record_automatic_target_failure_at(Channel::Release, target, first_failure_at);
        assert_eq!(
            automatic_target_eligibility_at(
                Channel::Release,
                target,
                first_failure_at + Duration::from_secs(1),
            ),
            AutomaticTargetEligibility::RetryIntervalNotElapsed
        );

        // Manual commands acquire only the run guard; automatic retry state is
        // deliberately not consulted, so the UI retry remains responsive even
        // while the automatic retry interval is active.
        let manual_run_guard = try_begin_core_update().expect("manual retry is not gated");
        drop(manual_run_guard);

        for failure_number in 1..MAX_CONSECUTIVE_AUTOMATIC_TARGET_FAILURES {
            record_automatic_target_failure_at(
                Channel::Release,
                target,
                first_failure_at + CHECK_INTERVAL * u32::from(failure_number),
            );
        }
        assert_eq!(
            automatic_target_eligibility(Channel::Release, target),
            AutomaticTargetEligibility::ConsecutiveFailureCapReached
        );
    }

    #[tokio::test]
    async fn noneligible_release_candidate_executes_the_native_installer() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let called = Arc::new(AtomicBool::new(false));
        let called_by_installer = Arc::clone(&called);
        let candidate = CoreAutoUpdateCandidate {
            channel: Channel::Release,
            local_version: Some("15.0.4"),
            target_version: "15.0.117-native-behavior-test",
            is_eligible: false,
            version_behind: true,
        };

        let outcome = execute_native_core_auto_update(
            candidate,
            true,
            false,
            move |channel, run_guard, observation| async move {
                let _run_guard = run_guard;
                assert_eq!(channel, Channel::Release);
                assert_eq!(observation.source(), "automatic");
                assert_eq!(observation.version_behind(), Some(true));
                called_by_installer.store(true, Ordering::Release);
                Ok(0)
            },
        )
        .await;

        assert_eq!(outcome, NativeCoreAutoUpdateOutcome::Succeeded);
        assert!(called.load(Ordering::Acquire));
    }

    #[test]
    fn manual_telemetry_does_not_invent_version_drift() {
        let observation = CoreUpdateTelemetryContext::manual();
        assert_eq!(observation.source(), "manual");
        assert_eq!(observation.version_behind(), None);
    }

    #[test]
    fn typed_error_kind_is_stable_when_human_message_changes() {
        let error = CoreUpdateError::new(
            CoreUpdateErrorKind::Network,
            "completely revised network wording",
        );
        assert_eq!(error.kind().label(), "network");
    }

    #[test]
    fn rescue_exit_failure_classifies_dns_without_sending_the_raw_diagnostic() {
        let npx_resolution = CoreUpdateNpxResolution {
            resolved: true,
            source: "managed_toolchain",
        };
        let stderr =
            "fatal: unable to access 'https://github.com/indigoai-us/hq-core/': Could not resolve host: github.com";
        let properties = core_update_failed_properties(
            "automatic",
            Channel::Release,
            Some("15.0.4"),
            true,
            None,
            Some(true),
            Duration::from_millis(42),
            Some(5),
            "rescue_exit",
            CoreUpdateFailureDetails {
                rescue_stderr_tail: Some(stderr),
                rescue_failure_category: classify_rescue_exit_failure(stderr, npx_resolution),
                npx_resolution: Some(npx_resolution),
            },
        );

        assert_eq!(properties["exitCode"], 5);
        assert_eq!(
            properties["errorCategory"], "dns",
            "a git DNS failure must become a bounded telemetry dimension"
        );
        assert!(properties.get("rescueStderrTail").is_none());
        assert_eq!(properties["npxResolved"], true);
        assert_eq!(properties["npxResolution"], "managed_toolchain");
        let platform = properties["platform"].as_str().unwrap();
        assert!(
            crate::commands::version_gate::DESKTOP_PLATFORM_VALUES.contains(&platform),
            "platform must remain in the closed desktop vocabulary"
        );
    }

    #[test]
    fn rescue_rsync_preflight_failure_is_a_missing_dependency() {
        let stderr = "error: rsync preflight failed before any safety snapshot was allocated.\n\
       resolved PATH: (unset)\n\
       Install or repair rsync, then retry the HQ update.";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::MissingDependency
        );
    }

    #[test]
    fn rescue_rsync_preflight_failure_precedes_broader_transport_needles() {
        let stderr = "error: rsync preflight failed before any safety snapshot was allocated.\n\
       version output: permission denied";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::MissingDependency,
            "the rsync preflight diagnostic must not be shadowed by a transport needle"
        );
    }

    #[test]
    fn every_rescue_stderr_pattern_classifies_to_its_table_category() {
        for pattern in RESCUE_STDERR_PATTERNS {
            assert_eq!(
                classify_rescue_stderr_failure(pattern.needle),
                pattern.category,
                "pattern {:?} must classify as {:?}",
                pattern.needle,
                pattern.category
            );
        }
    }

    #[test]
    fn typed_core_update_conditions_take_precedence_over_stderr_matching() {
        assert_eq!(
            classify_core_update_error(CoreUpdateErrorKind::Network, None),
            RescueFailureCategory::Network
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                Some(CoreUpdateNpxResolution {
                    resolved: false,
                    source: "not_resolved",
                })
            ),
            RescueFailureCategory::NpxResolveFailed
        );
    }

    #[test]
    fn rescue_failure_category_values_are_hq_pro_safe_labels() {
        for category in RescueFailureCategory::ALL {
            let label = category.label();
            assert!(label.len() <= 64, "{label:?} exceeds hq-pro's label cap");
            assert!(
                label.bytes().all(|byte| byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'.' | b':' | b'-')),
                "{label:?} violates hq-pro SAFE_MARKETING_LABEL_RE"
            );
        }
    }

    #[test]
    fn sentry_reports_one_event_per_failure_signature_per_process() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        let report = |error_kind, error_category, exit_code| CoreUpdateSentryFailureReport {
            source: "automatic",
            channel: Channel::Release,
            exit_code,
            error_kind,
            error_category,
            rescue_stderr_tail: Some(hq_telemetry::redact_core_update_diagnostic_tail(
                "fatal: could not clone Core source",
            )),
            npx_resolution: Some(CoreUpdateNpxResolution {
                resolved: true,
                source: "managed_toolchain",
            }),
        };
        let events = sentry::test::with_captured_events_options(
            || {
                report_core_update_failure_once(report(
                    "rescue_exit",
                    RescueFailureCategory::Unknown,
                    Some(5),
                ));
                report_core_update_failure_once(report(
                    "rescue_exit",
                    RescueFailureCategory::Unknown,
                    Some(5),
                ));
                report_core_update_failure_once(report(
                    "network",
                    RescueFailureCategory::Network,
                    None,
                ));
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );

        assert_eq!(events.len(), 2, "identical failures must dedupe in-process");
        assert_eq!(events[0].fingerprint, vec!["rescue_exit", "unknown"]);
        assert_eq!(events[1].fingerprint, vec!["network", "network"]);
        assert_eq!(events[0].tags["errorKind"], "rescue_exit");
        assert_eq!(events[0].tags["errorCategory"], "unknown");
        assert_eq!(events[0].tags["channel"], "release");
        assert_eq!(events[0].tags["platform"], core_update_sentry_platform());
        assert_eq!(events[0].tags["source"], "automatic");
        assert_eq!(events[0].tags["exitCode"], "5");
        assert_eq!(events[1].tags["exitCode"], "not_available");
        assert_eq!(
            events[0].extra["rescueStderrTail"],
            sentry::protocol::Value::String("fatal: could not clone Core source".to_string())
        );
    }

    #[test]
    fn hq_pro_core_update_allowlist_snapshot_is_not_empty() {
        assert!(!HQ_PRO_LABEL_PROPERTY_KEYS.is_empty());
        assert!(!HQ_PRO_BOOLEAN_PROPERTY_KEYS.is_empty());
        assert!(!HQ_PRO_NUMBER_PROPERTY_KEYS.is_empty());
    }

    #[test]
    fn core_update_failed_properties_have_no_untracked_hq_pro_allowlist_gaps() {
        let npx_resolution = CoreUpdateNpxResolution {
            resolved: true,
            source: "managed_toolchain",
        };
        let properties = core_update_failed_properties(
            "automatic",
            Channel::Release,
            Some("15.0.4"),
            true,
            Some(true),
            Some(true),
            Duration::from_millis(42),
            Some(5),
            "rescue_exit",
            CoreUpdateFailureDetails {
                rescue_stderr_tail: Some("fatal: could not clone hq-core"),
                rescue_failure_category: RescueFailureCategory::Unknown,
                npx_resolution: Some(npx_resolution),
            },
        );
        let mut missing: Vec<&str> = properties
            .keys()
            .map(String::as_str)
            .filter(|key| !hq_pro_admits_core_update_property(key))
            .collect();
        missing.sort_unstable();

        let mut expected = EXPECTED_HQ_PRO_CORE_UPDATE_PROPERTY_GAPS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            missing, expected,
            "every core_update_failed property must be admitted by hq-pro or appear in the explicit companion-PR gap list"
        );
    }

    #[test]
    fn native_auto_update_installs_only_when_every_gate_is_open() {
        assert_eq!(
            core_auto_update_decision(true, true, false),
            CoreAutoUpdateDecision::Install
        );
        assert_eq!(
            core_auto_update_decision(false, true, false),
            CoreAutoUpdateDecision::SkipAutomaticUpdatesDisabled
        );
        // `isEligible` is staging-email metadata, not a release-update gate.
        // Client users on the resolved release channel must auto-update too.
        assert_eq!(
            core_auto_update_decision(true, false, false),
            CoreAutoUpdateDecision::Ignore
        );
        assert_eq!(
            core_auto_update_decision(true, true, true),
            CoreAutoUpdateDecision::DeferForSync
        );
    }

    #[test]
    fn semver_lt_basic() {
        assert!(semver_lt("14.0.0", "14.2.0"));
        assert!(semver_lt("14.2.0", "14.2.1"));
        assert!(!semver_lt("14.2.0", "14.2.0"));
        assert!(!semver_lt("14.2.1", "14.2.0"));
        assert!(semver_lt("v14.0.0", "v14.1.0"));
    }

    #[test]
    fn semver_lt_handles_dirty_segments() {
        // hq-core tags are plain `vX.Y.Z` so we don't bother with full
        // pre-release ordering — just confirm the parser doesn't crash on
        // suffixed forms and treats them by their numeric prefix.
        assert!(!semver_lt("14.1.0", "14.0.0-rc1"));
    }

    #[test]
    fn recent_core_state_is_reusable_inside_window() {
        let at = Instant::now();
        let window = Duration::from_secs(15);
        let now = at + Duration::from_secs(1);
        assert!(recent_core_state_is_reusable(at, now, window));
    }

    #[test]
    fn recent_core_state_is_stale_at_window() {
        let at = Instant::now();
        let window = Duration::from_secs(15);
        let now = at + window;
        assert!(!recent_core_state_is_reusable(at, now, window));
    }

    #[test]
    fn recent_core_state_is_stale_after_window() {
        let at = Instant::now();
        let window = Duration::from_secs(15);
        let now = at + window + Duration::from_millis(1);
        assert!(!recent_core_state_is_reusable(at, now, window));
    }
}
