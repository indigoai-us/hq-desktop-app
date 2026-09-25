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
const BASELINE_REFRESH_PENDING_SKIP_REASON: &str = "baseline_refresh_pending";
const APPLIED_RESCUE_NO_RETRY_SKIP_REASON: &str = "rescue_applied_preserve_restore_failed";
/// Per-channel applied-commit marker in `~/.hq/menubar.json`. This intentionally
/// uses the established untyped, atomic menubar merge path: typed preferences
/// would discard this update-bookkeeping key on an unrelated settings save.
const BASELINE_REFRESH_PENDING_KEY: &str = "coreBaselineRefreshPending";
const AUTOMATIC_NO_RETRY_TARGETS_KEY: &str = "coreAutomaticNoRetryTargets";

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
    managed_git_retry: ManagedGitRetryOutcome,
}

impl CoreUpdateError {
    pub(crate) fn new(kind: CoreUpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            npx_resolution: None,
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
        }
    }

    pub(crate) fn with_npx_resolution(mut self, npx_resolution: CoreUpdateNpxResolution) -> Self {
        self.npx_resolution = Some(npx_resolution);
        self
    }

    pub(crate) fn with_managed_git_retry(
        mut self,
        managed_git_retry: ManagedGitRetryOutcome,
    ) -> Self {
        self.managed_git_retry = managed_git_retry;
        self
    }

    pub(crate) const fn kind(&self) -> CoreUpdateErrorKind {
        self.kind
    }

    pub(crate) const fn npx_resolution(&self) -> Option<CoreUpdateNpxResolution> {
        self.npx_resolution
    }

    pub(crate) const fn managed_git_retry(&self) -> ManagedGitRetryOutcome {
        self.managed_git_retry
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
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

/// Closed outcome of the one-time Core-update retry that can put HQ's managed
/// Git ahead of a user-selected Git after the latter fails a recognized clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManagedGitRetryOutcome {
    NotNeeded,
    ManagedGitUnavailable,
    Succeeded,
    Failed,
}

impl ManagedGitRetryOutcome {
    const fn label(self) -> &'static str {
        match self {
            Self::NotNeeded => "not_needed",
            Self::ManagedGitUnavailable => "managed_git_unavailable",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }

    pub(crate) const fn attempted(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

/// Closed telemetry dimension for why a Core rescue failed.
///
/// This remains a dimension rather than raw diagnostic text: hq-pro admits
/// `errorCategory` as a short safe label, while its telemetry privacy boundary
/// deliberately rejects free-form process output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RescueFailureCategory {
    MissingDependency,
    SnapshotUnreadable,
    SnapshotExternalSymlink,
    SnapshotFailed,
    OutdatedDependency,
    Auth,
    Network,
    Dns,
    Tls,
    DiskFull,
    Permission,
    NotFound,
    NpxResolveFailed,
    Timeout,
    LockContention,
    SnapshotRecoveryRequired,
    RsyncPartialTransfer,
    DirectoryNotEmpty,
    RsyncBroken,
    PreserveRestoreFailed,
    Unknown,
}

impl RescueFailureCategory {
    const ALL: &[Self] = &[
        Self::MissingDependency,
        Self::SnapshotUnreadable,
        Self::SnapshotExternalSymlink,
        Self::SnapshotFailed,
        Self::OutdatedDependency,
        Self::Auth,
        Self::Network,
        Self::Dns,
        Self::Tls,
        Self::DiskFull,
        Self::Permission,
        Self::NotFound,
        Self::NpxResolveFailed,
        Self::Timeout,
        Self::LockContention,
        Self::SnapshotRecoveryRequired,
        Self::RsyncPartialTransfer,
        Self::DirectoryNotEmpty,
        Self::RsyncBroken,
        Self::PreserveRestoreFailed,
        Self::Unknown,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::MissingDependency => "missing-dependency",
            Self::SnapshotUnreadable => "snapshot-unreadable",
            Self::SnapshotExternalSymlink => "snapshot-external-symlink",
            Self::SnapshotFailed => "snapshot-failed",
            Self::OutdatedDependency => "outdated-dependency",
            Self::Auth => "auth",
            Self::Network => "network",
            Self::Dns => "dns",
            Self::Tls => "tls",
            Self::DiskFull => "disk-full",
            Self::Permission => "permission",
            Self::NotFound => "not-found",
            Self::NpxResolveFailed => "npx-resolve-failed",
            Self::Timeout => "timeout",
            Self::LockContention => "lock-contention",
            Self::SnapshotRecoveryRequired => "snapshot-recovery-required",
            Self::RsyncPartialTransfer => "rsync-partial-transfer",
            Self::DirectoryNotEmpty => "directory-not-empty",
            Self::RsyncBroken => "rsync-broken",
            Self::PreserveRestoreFailed => "preserve-restore-failed",
            Self::Unknown => "unknown",
        }
    }
}

/// Bounded, path-free dimensions extracted from the raw rescue output before
/// it is redacted. The issue fingerprint stays constant; these fields answer
/// the operational questions needed to diagnose a failed install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CoreUpdateRescueTelemetry {
    pub(crate) rescue_step: &'static str,
    pub(crate) rescue_error_class: &'static str,
    pub(crate) git_source: &'static str,
    pub(crate) git_version: String,
    pub(crate) rsync_source: &'static str,
    pub(crate) rsync_version: String,
    pub(crate) node_source: &'static str,
    pub(crate) node_version: String,
    pub(crate) disk_free_bucket: &'static str,
    pub(crate) root_on_synced_folder: &'static str,
    pub(crate) network_probe: &'static str,
    pub(crate) attempt_number: u32,
    pub(crate) first_error_line: Option<String>,
    pub(crate) stage_markers: Vec<String>,
}

impl Default for CoreUpdateRescueTelemetry {
    fn default() -> Self {
        Self {
            rescue_step: "unknown",
            rescue_error_class: "unknown",
            git_source: "none",
            git_version: "unknown".to_string(),
            rsync_source: "none",
            rsync_version: "unknown".to_string(),
            node_source: "unknown",
            node_version: "unknown".to_string(),
            disk_free_bucket: "unknown",
            root_on_synced_folder: "unknown",
            network_probe: "unknown",
            attempt_number: 1,
            first_error_line: None,
            stage_markers: Vec::new(),
        }
    }
}

impl CoreUpdateRescueTelemetry {
    pub(crate) fn from_raw(raw: &str, attempt_number: u32) -> Self {
        Self::from_raw_with_probe_results(
            raw,
            attempt_number,
            CoreUpdateToolProbeResults::default(),
        )
    }

    pub(crate) async fn from_raw_with_probes(raw: &str, attempt_number: u32) -> Self {
        let initial = Self::from_raw(raw, attempt_number);
        let child_path = paths::child_path();
        let git = (initial.git_version == "unknown")
            .then(|| paths::resolve_bin_on_child_path("git"))
            .flatten();
        let rsync = (initial.rsync_version == "unknown")
            .then(|| paths::resolve_bin_on_child_path("rsync"))
            .flatten();
        let node = (initial.node_version == "unknown")
            .then(|| paths::resolve_bin_on_child_path("node"))
            .flatten();
        let (git_version, rsync_version, node_version) = tokio::join!(
            core_update_probe_tool_version(git, child_path.clone(), "git"),
            core_update_probe_tool_version(rsync, child_path.clone(), "rsync"),
            core_update_probe_tool_version(node, child_path, "node"),
        );

        Self::from_raw_with_probe_results(
            raw,
            attempt_number,
            CoreUpdateToolProbeResults {
                git_version,
                rsync_version,
                node_version,
            },
        )
    }

    fn from_raw_with_probe_results(
        raw: &str,
        attempt_number: u32,
        probe_results: CoreUpdateToolProbeResults,
    ) -> Self {
        let rescue_error_class = raw
            .lines()
            .find_map(core_update_rescue_error_class)
            .unwrap_or("unknown");
        let stage_markers = core_update_stage_markers(raw);
        let rescue_step = stage_markers
            .last()
            .and_then(|marker| marker.split('|').nth(1))
            .map(core_update_rescue_step_from_marker)
            .unwrap_or("unknown");
        let rescue_step = if rescue_step == "unknown" {
            core_update_rescue_step_from_raw(raw, rescue_error_class)
        } else {
            rescue_step
        };
        let first_error_line = raw.lines().find_map(|line| {
            core_update_rescue_error_class(line).map(|_| line.trim().chars().take(240).collect())
        });

        let mut telemetry = Self {
            rescue_step,
            rescue_error_class,
            git_source: core_update_tool_source("git"),
            git_version: core_update_tool_version(raw, "git", "git_version"),
            rsync_source: core_update_tool_source("rsync"),
            rsync_version: core_update_tool_version(raw, "rsync", "rsync_version"),
            node_source: core_update_node_source(),
            node_version: core_update_tool_version(raw, "node", "node_version"),
            disk_free_bucket: core_update_disk_free_bucket(raw),
            root_on_synced_folder: core_update_synced_folder(raw),
            network_probe: core_update_network_probe(raw, rescue_error_class),
            attempt_number: core_update_attempt_number(raw, attempt_number),
            first_error_line,
            stage_markers,
        };
        if telemetry.git_version == "unknown" {
            if let Some(version) = probe_results.git_version {
                telemetry.git_version = version;
            }
        }
        if telemetry.rsync_version == "unknown" {
            if let Some(version) = probe_results.rsync_version {
                telemetry.rsync_version = version;
            }
        }
        if telemetry.node_version == "unknown" {
            if let Some(version) = probe_results.node_version {
                telemetry.node_version = version;
            }
        }
        telemetry
    }
}

#[derive(Debug, Default)]
struct CoreUpdateToolProbeResults {
    git_version: Option<String>,
    rsync_version: Option<String>,
    node_version: Option<String>,
}

const CORE_UPDATE_TOOL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

async fn core_update_probe_tool_version(
    resolved: Option<paths::ResolvedProgram>,
    child_path: String,
    tool: &'static str,
) -> Option<String> {
    let resolved = resolved?;
    if !resolved.is_spawnable() {
        return None;
    }
    let mut command = paths::tokio_spawn_command(&resolved.path, &["--version"]);
    command.env("PATH", child_path).kill_on_drop(true);
    let output = tokio::time::timeout(CORE_UPDATE_TOOL_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut raw = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        raw.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    let key = match tool {
        "git" => "git_version",
        "rsync" => "rsync_version",
        "node" => "node_version",
        _ => return None,
    };
    let version = core_update_probe_version(&raw, tool, key);
    (version != "unknown").then_some(version)
}

fn core_update_tool_source(name: &str) -> &'static str {
    let Some(resolved) = paths::resolve_bin_on_child_path(name) else {
        return "none";
    };
    core_update_tool_source_for_path(std::path::Path::new(&resolved.path))
}

fn core_update_tool_source_for_path(path: &std::path::Path) -> &'static str {
    match paths::resolution_source_of(path) {
        hq_desktop_core::paths::ResolutionSource::ManagedToolchain => "managed",
        hq_desktop_core::paths::ResolutionSource::NotResolved => "none",
        _ => "system",
    }
}

fn core_update_node_source() -> &'static str {
    let Some(resolved) = paths::resolve_bin_on_child_path("node") else {
        return "not_resolved";
    };
    paths::resolution_source_of(std::path::Path::new(&resolved.path)).telemetry_value()
}

fn core_update_tool_version(raw: &str, tool: &str, key: &str) -> String {
    core_update_tool_version_inner(raw, tool, key, false)
}

fn core_update_probe_version(raw: &str, tool: &str, key: &str) -> String {
    core_update_tool_version_inner(raw, tool, key, true)
}

fn core_update_tool_version_inner(
    raw: &str,
    tool: &str,
    key: &str,
    allow_bare_node: bool,
) -> String {
    if let Some(version) = raw.lines().find_map(|line| {
        core_update_key_value(line, key)
            .map(core_update_safe_version)
            .filter(|version| version != "unknown")
    }) {
        return version;
    }

    raw.lines()
        .find_map(|line| {
            core_update_tool_version_token(line, tool, allow_bare_node)
                .map(core_update_safe_version)
                .filter(|version| version != "unknown")
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn core_update_key_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let (candidate, value) = line.trim().split_once('=')?;
    candidate
        .trim()
        .eq_ignore_ascii_case(key)
        .then_some(value.trim())
}

fn core_update_tool_version_token<'a>(
    line: &'a str,
    tool: &str,
    allow_bare_node: bool,
) -> Option<&'a str> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    match tool {
        "git" if tokens.len() >= 3 && tokens[0].eq_ignore_ascii_case("git") => tokens[1]
            .eq_ignore_ascii_case("version")
            .then_some(tokens[2]),
        "rsync" if tokens.len() >= 3 && tokens[0].eq_ignore_ascii_case("rsync") => tokens[1]
            .eq_ignore_ascii_case("version")
            .then_some(tokens[2]),
        "node" if tokens.len() >= 3 && tokens[0].eq_ignore_ascii_case("node") => (tokens[1]
            .eq_ignore_ascii_case("version")
            || tokens[1].eq_ignore_ascii_case("--version"))
        .then_some(tokens[2]),
        "node" if allow_bare_node && tokens.len() == 1 && tokens[0].starts_with('v') => {
            Some(tokens[0])
        }
        _ => None,
    }
}

fn core_update_safe_version(value: &str) -> String {
    let value = value.trim().trim_start_matches('v');
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
        || !value.chars().any(|character| character.is_ascii_digit())
    {
        return "unknown".to_string();
    }
    value.to_string()
}

fn core_update_stage_markers(raw: &str) -> Vec<String> {
    let observed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut markers: Vec<String> = raw
        .lines()
        .filter_map(|line| {
            let marker = line.trim().strip_prefix("==>")?.trim();
            let stage = core_update_stage_token(marker);
            let timestamp = line
                .split_whitespace()
                .find(|token| chrono::DateTime::parse_from_rfc3339(token).is_ok())
                .unwrap_or(&observed_at);
            Some(format!("{timestamp}|{stage}"))
        })
        .collect();
    if markers.len() > 32 {
        markers.drain(..markers.len() - 32);
    }
    markers
}

fn core_update_stage_token(marker: &str) -> &'static str {
    let marker = marker.to_ascii_lowercase();
    if marker.contains("clone") || marker.contains("cloning") {
        "clone"
    } else if marker.contains("rsync") {
        "rsync"
    } else if marker.contains("overlay") {
        "rsync"
    } else if marker.contains("npm") || marker.contains("npx") {
        "npm-install"
    } else if marker.contains("verify")
        || marker.contains("source sha")
        || marker == "done"
        || marker.starts_with("done ")
    {
        "verify"
    } else if marker.contains("checkout") {
        "checkout"
    } else {
        "unknown"
    }
}

fn core_update_rescue_step_from_marker(stage: &str) -> &'static str {
    match stage {
        "clone" => "clone",
        "checkout" => "checkout",
        "rsync" => "rsync",
        "npm-install" => "npm-install",
        "verify" => "verify",
        _ => "unknown",
    }
}

fn core_update_rescue_step_from_raw(raw: &str, error_class: &str) -> &'static str {
    match error_class {
        "rsync_missing" | "rsync_failed" | "rsync_partial" => return "rsync",
        "npx_resolve_failed" | "npm_enoent" => return "npm-install",
        _ => {}
    }
    if raw.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("npx failed")
            || lower.contains("npx could not be spawned")
            || lower.contains("npm err")
    }) {
        "npm-install"
    } else if raw.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("rsync preflight failed")
            || lower.contains("rsync status 23")
            || lower.contains("hq_rescue_failure_kind=rsync-")
            || lower.contains("rsync error")
            || lower.contains("rsync failed")
            || lower.contains("rsync broken")
            || lower.contains("rsync partial")
            || lower.contains("rsync exited")
    }) {
        "rsync"
    } else {
        "unknown"
    }
}

fn core_update_rescue_error_class(line: &str) -> Option<&'static str> {
    let lower = line.to_ascii_lowercase();
    let trimmed = lower.trim_start();
    let diagnostic_line = trimmed.starts_with("error")
        || trimmed.starts_with("fatal")
        || trimmed.starts_with("npm err")
        || trimmed.starts_with("npx")
        || trimmed.starts_with("hq_rescue_failure_kind=")
        || trimmed.starts_with("rsync")
        || trimmed.starts_with("could not resolve host")
        || trimmed.starts_with("name or service not known")
        || trimmed.starts_with("connection")
        || trimmed.starts_with("operation")
        || trimmed.starts_with("no space")
        || lower.contains("clone succeeded, but checkout failed");
    if !diagnostic_line {
        return None;
    }
    if lower.contains("hq_rescue_failure_kind=rsync-partial") || lower.contains("rsync status 23") {
        Some("rsync_partial")
    } else if lower.contains("npx failed") || lower.contains("npx could not be spawned") {
        Some("npx_resolve_failed")
    } else if lower.contains("clone succeeded, but checkout failed")
        || lower.contains("checkout failed")
    {
        Some("checkout_failed")
    } else if lower.contains("clone failed") {
        Some("clone_failed")
    } else if lower.contains("rsync-missing")
        || lower.contains("rsync preflight failed")
            && (lower.contains("missing")
                || lower.contains("not installed")
                || lower.contains("not found"))
        || lower.contains("rsync is not installed")
    {
        Some("rsync_missing")
    } else if lower.contains("enoent") || lower.contains("npm err! code enoent") {
        Some("npm_enoent")
    } else if lower.contains("eacces") || lower.contains("access is denied") {
        Some("eacces")
    } else if lower.contains("enospc") || lower.contains("no space left on device") {
        Some("enospc")
    } else if lower.contains("could not resolve host")
        || lower.contains("name or service not known")
        || lower.contains("dns")
    {
        Some("dns")
    } else if lower.contains("certificate verify failed")
        || lower.contains("ssl certificate problem")
        || lower.contains("tls")
    {
        Some("tls")
    } else if lower.contains("timed out") || lower.contains("timeout") {
        Some("timeout")
    } else if lower.contains("hq_rescue_failure_kind=rsync-failed")
        || lower.contains("hq_rescue_failure_kind=rsync-found-but-broken")
        || lower.contains("rsync preflight failed")
            && !lower.contains("missing")
            && !lower.contains("not installed")
            && !lower.contains("not found")
    {
        Some("rsync_failed")
    } else {
        None
    }
}

fn core_update_disk_free_bucket(raw: &str) -> &'static str {
    for line in raw.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(bucket) = core_update_explicit_disk_bucket(&lower) {
            return bucket;
        }
        if !(lower.contains("disk") || lower.contains("space") || lower.contains("available"))
            || !lower.contains("free") && !lower.contains("available")
        {
            continue;
        }
        let tokens: Vec<&str> = lower
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '.')
            .filter(|token| !token.is_empty())
            .collect();
        for anchor in ["have", "available", "avail", "free"] {
            if let Some(index) = tokens.iter().position(|token| *token == anchor) {
                if let Some(bucket) = core_update_disk_bucket_at(&tokens, index + 1) {
                    return bucket;
                }
            }
        }
        for index in 0..tokens.len() {
            if let Some(bucket) = core_update_disk_bucket_at(&tokens, index) {
                return bucket;
            }
        }
    }
    "unknown"
}

fn core_update_explicit_disk_bucket(line: &str) -> Option<&'static str> {
    for key in ["disk_free_bytes", "free_bytes", "available_bytes"] {
        let Some((candidate, value)) = line.split_once('=') else {
            continue;
        };
        if candidate.trim() != key {
            continue;
        }
        let Ok(bytes) = value.trim().parse::<f64>() else {
            return None;
        };
        return core_update_disk_bucket_from_gib(bytes / 1024.0 / 1024.0 / 1024.0);
    }
    None
}

fn core_update_disk_bucket_at(tokens: &[&str], index: usize) -> Option<&'static str> {
    let token = tokens.get(index)?;
    if let Some(split) = token.find(|character: char| character.is_ascii_alphabetic()) {
        let (number, unit) = token.split_at(split);
        if let Ok(value) = number.parse::<f64>() {
            return core_update_disk_bucket_from_unit(value, unit);
        }
    }
    let value = token.parse::<f64>().ok()?;
    let unit = tokens.get(index + 1)?;
    core_update_disk_bucket_from_unit(value, unit)
}

fn core_update_disk_bucket_from_unit(value: f64, unit: &str) -> Option<&'static str> {
    let gib = match unit {
        "b" | "byte" | "bytes" => value / 1024.0 / 1024.0 / 1024.0,
        "kb" | "kib" => value / 1024.0 / 1024.0,
        "mb" | "mib" => value / 1024.0,
        "gb" | "gib" => value,
        _ => return None,
    };
    core_update_disk_bucket_from_gib(gib)
}

fn core_update_disk_bucket_from_gib(gib: f64) -> Option<&'static str> {
    Some(if gib < 1.0 {
        "<1G"
    } else if gib < 5.0 {
        "1-5G"
    } else if gib < 20.0 {
        "5-20G"
    } else {
        ">20G"
    })
}

fn core_update_synced_folder(raw: &str) -> &'static str {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("onedrive") {
        "onedrive"
    } else if lower.contains("icloud") {
        "icloud"
    } else if lower.contains("dropbox") {
        "dropbox"
    } else {
        "unknown"
    }
}

fn core_update_network_probe(raw: &str, error_class: &str) -> &'static str {
    let lower = raw.to_ascii_lowercase();
    for token in ["ok", "dns", "tls", "timeout", "offline"] {
        if lower.contains(&format!("network_probe={token}"))
            || lower.contains(&format!("network probe: {token}"))
        {
            return token;
        }
    }
    match error_class {
        "dns" => "dns",
        "tls" => "tls",
        "timeout" => "timeout",
        "clone_failed" | "checkout_failed" => "unknown",
        _ if lower.contains("network unreachable") || lower.contains("offline") => "offline",
        _ => "unknown",
    }
}

fn core_update_attempt_number(raw: &str, fallback: u32) -> u32 {
    raw.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("attempt_number=")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(fallback.max(1))
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
        category: RescueFailureCategory::RsyncBroken,
        needle: "rsync found at",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::SnapshotRecoveryRequired,
        needle: "safety snapshot circuit breaker is open",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::RsyncPartialTransfer,
        needle: "some files/attrs were not transferred",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::DirectoryNotEmpty,
        needle: "enotempty",
    },
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
        category: RescueFailureCategory::MissingDependency,
        needle: "have not agreed to the xcode license",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::SnapshotExternalSymlink,
        needle: "resolves outside the hq root",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::SnapshotUnreadable,
        needle: "safety snapshot could not read",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::SnapshotFailed,
        needle: "safety snapshot could not",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::OutdatedDependency,
        needle: "unknown option `filter=blob:none'",
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
        category: RescueFailureCategory::Timeout,
        needle: "ssl connection timeout",
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
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "remote helper 'https' aborted session",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "was not closed cleanly",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "bytes of body are still expected",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "unexpected disconnect while reading sideband packet",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "early eof",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "invalid index-pack output",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "from promisor remote",
    },
];

const CLONE_CHECKOUT_FAILURE_NEEDLE: &str = "clone succeeded, but checkout failed";
const CLONE_CHECKOUT_TRANSPORT_NEEDLES: &[&str] = &[
    "rpc failed",
    "curl 92",
    "curl 56",
    "early eof",
    "unexpected disconnect",
    "remote helper 'https' aborted session",
];

fn clone_checkout_failure_is_network(stderr: &str) -> bool {
    stderr.contains(CLONE_CHECKOUT_FAILURE_NEEDLE)
        && (CLONE_CHECKOUT_TRANSPORT_NEEDLES
            .iter()
            .any(|needle| stderr.contains(needle))
            || (stderr.contains("could not fetch") && stderr.contains("promisor remote")))
}

// These are OS-error renderings emitted before the rescue process can start or
// while its update baseline is being persisted. They intentionally do not
// participate in rescue-exit classification. Keep specific causes before their
// broader counterparts so an actionable diagnosis is not shadowed.
const NPM_CACHE_OTHER_WINDOW_NEEDLE: &str =
    "hq sync is still preparing its npm cache in another window. wait a moment, then try sync again.";

const SPAWN_ERROR_PATTERNS: &[RescueStderrPattern] = &[
    RescueStderrPattern {
        category: RescueFailureCategory::LockContention,
        needle: NPM_CACHE_OTHER_WINDOW_NEEDLE,
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "no such file or directory",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "program not found",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "cannot find the file",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "enoent",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::LockContention,
        needle: "another process has locked a portion of the file",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Permission,
        needle: "access is denied",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Permission,
        needle: "eacces",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Permission,
        needle: "this account cannot write to it",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "installation is not executable",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::MissingDependency,
        needle: "node.js was not found",
    },
    RescueStderrPattern {
        category: RescueFailureCategory::Network,
        needle: "check your network and npm setup",
    },
];

fn classify_rescue_stderr_failure(stderr: &str) -> RescueFailureCategory {
    let stderr = stderr.to_ascii_lowercase();
    if let Some(category) = stderr.lines().find_map(|line| {
        match line.strip_prefix("hq_rescue_failure_kind=").map(str::trim) {
            Some("snapshot-copy-unreadable") => Some(RescueFailureCategory::SnapshotUnreadable),
            Some("snapshot-copy-failed") => Some(RescueFailureCategory::SnapshotFailed),
            Some("snapshot-recovery-circuit-breaker") => {
                Some(RescueFailureCategory::SnapshotRecoveryRequired)
            }
            Some("rsync-partial") => Some(RescueFailureCategory::RsyncPartialTransfer),
            Some("rsync-failed") => Some(RescueFailureCategory::RsyncBroken),
            Some("rsync-found-but-broken") => Some(RescueFailureCategory::RsyncBroken),
            Some("network-unreachable") => Some(RescueFailureCategory::Network),
            Some("missing-dependency") => Some(RescueFailureCategory::MissingDependency),
            Some("rsync-missing") => Some(RescueFailureCategory::MissingDependency),
            Some("preserve-restore-failed") => Some(RescueFailureCategory::PreserveRestoreFailed),
            _ => None,
        }
    }) {
        return category;
    }

    if clone_checkout_failure_is_network(&stderr) {
        return RescueFailureCategory::Network;
    }

    if stderr.contains("remote-https")
        && stderr.contains("is not a git command")
        && stderr.contains("remote helper 'https' aborted session")
    {
        return RescueFailureCategory::MissingDependency;
    }

    RESCUE_STDERR_PATTERNS
        .iter()
        .find(|pattern| stderr.contains(pattern.needle))
        .map(|pattern| pattern.category)
        .unwrap_or(RescueFailureCategory::Unknown)
}

fn classify_spawn_error(detail: &str) -> Option<RescueFailureCategory> {
    let detail = detail.to_ascii_lowercase();
    SPAWN_ERROR_PATTERNS
        .iter()
        .find(|pattern| detail.contains(pattern.needle))
        .map(|pattern| pattern.category)
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

fn rescue_failure_requires_no_automatic_retry(stderr: &str) -> bool {
    stderr.contains("HQ_RESCUE_FAILURE_KIND=preserve-restore-failed")
        || stderr.contains("HQ_RESCUE_FAILURE_KIND=snapshot-recovery-circuit-breaker")
}

/// Build the sentence shown after an automatic rescue applied the release but
/// could not restore preserved paths. Every path and the snapshot location
/// comes from the rescue output.
pub(crate) fn preserve_restore_failure_notice(rescue_output: &str) -> Option<String> {
    let mut in_restore_section = false;
    let mut paths = Vec::new();
    let mut snapshot = None;

    for line in rescue_output.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("==> Could not restore these preserved paths after the update:")
        {
            in_restore_section = true;
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("Safety snapshot:") {
            let path = path.trim();
            if !path.is_empty() {
                snapshot = Some(path.to_string());
            }
            continue;
        }
        if in_restore_section {
            if trimmed.starts_with("The updated HQ release files are already in place") {
                in_restore_section = false;
                continue;
            }
            if let Some((path, _reason)) = trimmed.split_once(": ") {
                let path = path.trim();
                if !path.is_empty() {
                    paths.push(path.to_string());
                }
            }
        }
    }

    if paths.is_empty() {
        return None;
    }
    let snapshot = snapshot?;
    let joined_paths = paths.join(", ");
    Some(format!(
        "The rescue could not restore preserved path(s) {joined_paths}; it kept the bytes in {snapshot}."
    ))
}

pub(crate) fn classify_core_update_error(
    error_kind: CoreUpdateErrorKind,
    detail: &str,
    npx_resolution: Option<CoreUpdateNpxResolution>,
) -> RescueFailureCategory {
    if npx_resolution.is_some_and(|resolution| !resolution.resolved) {
        return RescueFailureCategory::NpxResolveFailed;
    }

    match error_kind {
        CoreUpdateErrorKind::Network => RescueFailureCategory::Network,
        CoreUpdateErrorKind::RescueSpawn => {
            classify_spawn_error(detail).unwrap_or_else(|| classify_rescue_stderr_failure(detail))
        }
        CoreUpdateErrorKind::AlreadyInProgress
        | CoreUpdateErrorKind::InvalidCoreRoot
        | CoreUpdateErrorKind::ChannelConfiguration
        | CoreUpdateErrorKind::Internal => RescueFailureCategory::Unknown,
    }
}

/// Additional diagnostics emitted only with `core_update_failed`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CoreUpdateFailureDetails<'a> {
    /// A redacted 16 KiB rescue-log tail retained for the Sentry diagnostic.
    pub(crate) rescue_stderr_tail: Option<&'a str>,
    /// Dimensions parsed from the raw rescue output before it is redacted.
    pub(crate) rescue_telemetry: Option<&'a CoreUpdateRescueTelemetry>,
    pub(crate) rescue_failure_category: RescueFailureCategory,
    pub(crate) npx_resolution: Option<CoreUpdateNpxResolution>,
    pub(crate) managed_git_retry: ManagedGitRetryOutcome,
}

pub(crate) fn core_update_failure_details(error: &CoreUpdateError) -> CoreUpdateFailureDetails<'_> {
    let detail = error.message();
    let rescue_stderr_tail = match error.kind() {
        CoreUpdateErrorKind::RescueSpawn => Some(detail),
        _ => None,
    };

    CoreUpdateFailureDetails {
        rescue_stderr_tail,
        rescue_telemetry: None,
        rescue_failure_category: classify_core_update_error(
            error.kind(),
            detail,
            error.npx_resolution(),
        ),
        npx_resolution: error.npx_resolution(),
        managed_git_retry: error.managed_git_retry(),
    }
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
pub(crate) struct BaselineRefreshTarget {
    pub(crate) source: String,
    pub(crate) commit: String,
}

fn baseline_refresh_menubar_path(
    injected_path: Option<&std::path::Path>,
) -> Result<Option<std::path::PathBuf>, String> {
    if let Some(path) = injected_path {
        return Ok(Some(path.to_path_buf()));
    }

    #[cfg(test)]
    {
        // Unit tests that touch persisted Core state must inject their own
        // file. Never derive it from process-global HOME variables.
        Ok(None)
    }

    #[cfg(not(test))]
    {
        paths::menubar_json_path().map(Some)
    }
}

fn persisted_baseline_refresh_target(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) -> Option<BaselineRefreshTarget> {
    let path = baseline_refresh_menubar_path(injected_path).ok().flatten()?;
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    let value = menubar
        .get(BASELINE_REFRESH_PENDING_KEY)
        .and_then(Value::as_object)
        .and_then(|targets| targets.get(channel_label(channel)))?
        .as_object()?;
    let source = value.get("source")?.as_str()?.trim();
    let commit = value.get("commit")?.as_str()?.trim();
    (!source.is_empty() && !commit.is_empty()).then(|| BaselineRefreshTarget {
        source: source.to_string(),
        commit: commit.to_string(),
    })
}

fn persist_baseline_refresh_target(
    channel: Channel,
    source: &str,
    commit: &str,
    injected_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let Some(path) = baseline_refresh_menubar_path(injected_path)? else {
        return Ok(());
    };
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    let mut targets = menubar
        .get(BASELINE_REFRESH_PENDING_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    targets.insert(
        channel_label(channel).to_string(),
        json!({"source": source, "commit": commit}),
    );
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(BASELINE_REFRESH_PENDING_KEY, Value::Object(targets))],
    )
}

fn clear_persisted_baseline_refresh_target(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let Some(path) = baseline_refresh_menubar_path(injected_path)? else {
        return Ok(());
    };
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    let mut targets = menubar
        .get(BASELINE_REFRESH_PENDING_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    targets.remove(channel_label(channel));
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(BASELINE_REFRESH_PENDING_KEY, Value::Object(targets))],
    )
}

fn persisted_automatic_no_retry_target(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) -> Option<String> {
    let path = baseline_refresh_menubar_path(injected_path).ok().flatten()?;
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    menubar
        .get(AUTOMATIC_NO_RETRY_TARGETS_KEY)
        .and_then(Value::as_object)
        .and_then(|targets| targets.get(channel_label(channel)))
        .and_then(Value::as_str)
        .filter(|target| !target.trim().is_empty())
        .map(str::to_string)
}

fn persist_automatic_no_retry_target(
    channel: Channel,
    target: &str,
    injected_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let Some(path) = baseline_refresh_menubar_path(injected_path)? else {
        return Ok(());
    };
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    let mut targets = menubar
        .get(AUTOMATIC_NO_RETRY_TARGETS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    targets.insert(
        channel_label(channel).to_string(),
        Value::String(target.to_string()),
    );
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(AUTOMATIC_NO_RETRY_TARGETS_KEY, Value::Object(targets))],
    )
}

fn clear_persisted_automatic_no_retry_target(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let Some(path) = baseline_refresh_menubar_path(injected_path)? else {
        return Ok(());
    };
    let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
    let mut targets = menubar
        .get(AUTOMATIC_NO_RETRY_TARGETS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    targets.remove(channel_label(channel));
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(AUTOMATIC_NO_RETRY_TARGETS_KEY, Value::Object(targets))],
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutomaticTargetState {
    target: String,
    consecutive_failures: u8,
    completed_without_version_move: bool,
    baseline_refresh_pending: bool,
    no_retry_after_applied_failure: bool,
    last_failure_at: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutomaticTargetEligibility {
    Eligible,
    CompletedWithoutVersionMove,
    BaselineRefreshPending,
    NoRetryAfterAppliedFailure,
    ConsecutiveFailureCapReached,
    RetryIntervalNotElapsed,
}

fn automatic_target_eligibility(channel: Channel, target: &str) -> AutomaticTargetEligibility {
    automatic_target_eligibility_with_path(channel, target, Instant::now(), None)
}

fn automatic_target_eligibility_at(
    channel: Channel,
    target: &str,
    attempted_at: Instant,
) -> AutomaticTargetEligibility {
    automatic_target_eligibility_with_path(channel, target, attempted_at, None)
}

fn automatic_target_eligibility_with_path(
    channel: Channel,
    target: &str,
    attempted_at: Instant,
    injected_path: Option<&std::path::Path>,
) -> AutomaticTargetEligibility {
    let persisted_baseline_refresh_pending =
        persisted_baseline_refresh_target(channel, injected_path).is_some();
    let persisted_no_retry_target =
        persisted_automatic_no_retry_target(channel, injected_path);
    let states = AUTO_TARGET_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(state) = states.get(&channel) else {
        if persisted_no_retry_target.as_deref() == Some(target) {
            return AutomaticTargetEligibility::NoRetryAfterAppliedFailure;
        }
        if persisted_baseline_refresh_pending {
            return AutomaticTargetEligibility::BaselineRefreshPending;
        }
        return AutomaticTargetEligibility::Eligible;
    };
    if state.target != target {
        if persisted_baseline_refresh_pending {
            return AutomaticTargetEligibility::BaselineRefreshPending;
        }
        return AutomaticTargetEligibility::Eligible;
    }
    if state.no_retry_after_applied_failure || persisted_no_retry_target.as_deref() == Some(target) {
        AutomaticTargetEligibility::NoRetryAfterAppliedFailure
    } else if state.baseline_refresh_pending || persisted_baseline_refresh_pending {
        AutomaticTargetEligibility::BaselineRefreshPending
    } else if state.completed_without_version_move {
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

fn automatic_target_baseline_refresh_pending_with_path(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) -> bool {
    AUTO_TARGET_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&channel)
        .is_some_and(|state| state.baseline_refresh_pending)
        || persisted_baseline_refresh_target(channel, injected_path).is_some()
}

fn record_automatic_target_failure_at(channel: Channel, target: &str, attempted_at: Instant) {
    record_automatic_target_failure_at_with_path(channel, target, attempted_at, None);
}

fn record_automatic_target_failure_at_with_path(
    channel: Channel,
    target: &str,
    attempted_at: Instant,
    injected_path: Option<&std::path::Path>,
) {
    let baseline_refresh_pending =
        automatic_target_baseline_refresh_pending_with_path(channel, injected_path);
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
            baseline_refresh_pending,
            no_retry_after_applied_failure: false,
            last_failure_at: None,
        });
    if state.target != target {
        *state = AutomaticTargetState {
            target: target.to_string(),
            consecutive_failures: 0,
            completed_without_version_move: false,
            baseline_refresh_pending,
            no_retry_after_applied_failure: false,
            last_failure_at: None,
        };
    }
    state.baseline_refresh_pending = baseline_refresh_pending;
    state.no_retry_after_applied_failure = false;
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.last_failure_at = Some(attempted_at);
}

fn record_automatic_target_no_retry_after_applied_failure_with_path(
    channel: Channel,
    target: &str,
    injected_path: Option<&std::path::Path>,
) {
    let baseline_refresh_pending =
        automatic_target_baseline_refresh_pending_with_path(channel, injected_path);
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
            baseline_refresh_pending,
            no_retry_after_applied_failure: false,
            last_failure_at: None,
        });
    if state.target != target {
        *state = AutomaticTargetState {
            target: target.to_string(),
            consecutive_failures: 0,
            completed_without_version_move: false,
            baseline_refresh_pending,
            no_retry_after_applied_failure: false,
            last_failure_at: None,
        };
    }
    state.no_retry_after_applied_failure = true;
    state.consecutive_failures = 0;
    state.last_failure_at = None;
    if let Err(error) = persist_automatic_no_retry_target(channel, target, injected_path) {
        log(
            "hq-core-state",
            &format!(
                "could not persist automatic Core no-retry target for {} target {}: {error}",
                channel_label(channel),
                target
            ),
        );
    }
}

pub(crate) fn clear_automatic_no_retry_for_manual(channel: Channel) {
    clear_automatic_no_retry_for_manual_with_path(channel, None);
}

fn clear_automatic_no_retry_for_manual_with_path(
    channel: Channel,
    injected_path: Option<&std::path::Path>,
) {
    if let Some(states) = AUTO_TARGET_STATES.get() {
        let mut states = states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = states.get_mut(&channel) {
            state.no_retry_after_applied_failure = false;
        }
    }
    if let Err(error) = clear_persisted_automatic_no_retry_target(channel, injected_path) {
        log(
            "hq-core-state",
            &format!(
                "could not clear automatic Core no-retry target for manual {} update: {error}",
                channel_label(channel)
            ),
        );
    }
}

fn record_automatic_target_completed(channel: Channel, target: &str) {
    record_automatic_target_completed_with_path(channel, target, None);
}

fn record_automatic_target_completed_with_path(
    channel: Channel,
    target: &str,
    injected_path: Option<&std::path::Path>,
) {
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
                baseline_refresh_pending: false,
                no_retry_after_applied_failure: false,
                last_failure_at: None,
            },
        );
    if let Err(error) = clear_persisted_baseline_refresh_target(channel, injected_path) {
        log(
            "hq-core-state",
            &format!(
                "could not clear completed Core baseline repair for {} target {}: {error}",
                channel_label(channel),
                target
            ),
        );
    }
    if let Err(error) = clear_persisted_automatic_no_retry_target(channel, injected_path) {
        log(
            "hq-core-state",
            &format!(
                "could not clear automatic Core no-retry target for {} target {}: {error}",
                channel_label(channel),
                target
            ),
        );
    }
}

/// Kept as a compatibility hook for both rescue wrappers. Baseline refresh
/// state is recorded by the applied-rescue baseline writer, so this hook never
/// schedules another installer run after a successful rescue.
pub(crate) fn arm_baseline_retry_after_successful_core_update(
    _channel: Channel,
    _target: &str,
    _exit_code: i32,
    _baseline_persisted: bool,
) {
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
        Value::String(crate::app_version::current().to_string()),
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

/// One Sentry issue collects every failed Core update. The diagnostic axes are
/// tags and extras so changes in the observed failure do not fragment the
/// issue while the event still answers which rescue stage failed.
const CORE_UPDATE_SENTRY_RATE_LIMIT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CoreUpdateSentryRateKey {
    rescue_step: &'static str,
    rescue_error_class: &'static str,
    pre_rescue_error_kind: Option<&'static str>,
    pre_rescue_error_category: Option<RescueFailureCategory>,
}

#[derive(Debug, Clone, Copy)]
struct CoreUpdateSentryRateEntry {
    captured_at: Instant,
    suppressed_since_last: u32,
}

static CORE_UPDATE_SENTRY_RATE_LIMITS: OnceLock<
    Mutex<HashMap<CoreUpdateSentryRateKey, CoreUpdateSentryRateEntry>>,
> = OnceLock::new();

#[derive(Debug, Clone)]
struct CoreUpdateSentryFailureReport {
    source: &'static str,
    channel: Channel,
    exit_code: Option<i32>,
    error_kind: &'static str,
    error_category: RescueFailureCategory,
    rescue_stderr_tail: Option<String>,
    rescue_telemetry: CoreUpdateRescueTelemetry,
    npx_resolution: Option<CoreUpdateNpxResolution>,
    managed_git_retry: ManagedGitRetryOutcome,
}

fn core_update_sentry_error_kind(error_kind: &'static str) -> &'static str {
    match error_kind {
        "already_in_progress"
        | "invalid_core_root"
        | "network"
        | "rescue_spawn"
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
        Some(23) => "23",
        Some(126) => "126",
        Some(127) => "127",
        Some(-1) => "signal_or_unknown",
        Some(_) => "other",
        None => "not_available",
    }
}

fn claim_core_update_sentry_capture(
    report: &CoreUpdateSentryFailureReport,
    now: Instant,
) -> Option<u32> {
    let key = core_update_sentry_rate_key(report);
    let mut limits = CORE_UPDATE_SENTRY_RATE_LIMITS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match limits.get_mut(&key) {
        Some(entry)
            if now.saturating_duration_since(entry.captured_at) < CORE_UPDATE_SENTRY_RATE_LIMIT =>
        {
            entry.suppressed_since_last = entry.suppressed_since_last.saturating_add(1);
            None
        }
        Some(entry) => {
            let suppressed = entry.suppressed_since_last;
            *entry = CoreUpdateSentryRateEntry {
                captured_at: now,
                suppressed_since_last: 0,
            };
            Some(suppressed)
        }
        None => {
            limits.insert(
                key,
                CoreUpdateSentryRateEntry {
                    captured_at: now,
                    suppressed_since_last: 0,
                },
            );
            Some(0)
        }
    }
}

fn core_update_sentry_rate_key(report: &CoreUpdateSentryFailureReport) -> CoreUpdateSentryRateKey {
    let unclassified_rescue = report.rescue_telemetry.rescue_step == "unknown"
        && report.rescue_telemetry.rescue_error_class == "unknown";
    CoreUpdateSentryRateKey {
        rescue_step: report.rescue_telemetry.rescue_step,
        rescue_error_class: report.rescue_telemetry.rescue_error_class,
        pre_rescue_error_kind: unclassified_rescue.then_some(report.error_kind),
        pre_rescue_error_category: unclassified_rescue.then_some(report.error_category),
    }
}

fn send_core_update_failure_report(
    report: CoreUpdateSentryFailureReport,
    suppressed_since_last: u32,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let fingerprint = core_update_sentry_fingerprint(report.error_kind, report.error_category);
        for marker in &report.rescue_telemetry.stage_markers {
            let message = marker
                .split_once('|')
                .map(|(_, stage)| stage)
                .unwrap_or("unknown");
            sentry::add_breadcrumb(sentry::Breadcrumb {
                category: Some("core-update".to_string()),
                message: Some(message.to_string()),
                ..Default::default()
            });
        }
        sentry::with_scope(
            |sentry_scope| {
                sentry_scope.set_fingerprint(Some(&fingerprint));
                sentry_scope.set_tag("errorKind", report.error_kind);
                sentry_scope.set_tag("errorCategory", report.error_category.label());
                sentry_scope.set_tag("channel", channel_label(report.channel));
                sentry_scope.set_tag("platform", core_update_sentry_platform());
                sentry_scope.set_tag("source", core_update_sentry_source(report.source));
                sentry_scope.set_tag("exitCode", core_update_sentry_exit_code(report.exit_code));
                sentry_scope.set_tag("exit_code", core_update_sentry_exit_code(report.exit_code));
                sentry_scope.set_tag("managedGitRetryOutcome", report.managed_git_retry.label());
                sentry_scope.set_tag("rescue_step", report.rescue_telemetry.rescue_step);
                sentry_scope.set_tag(
                    "rescue_error_class",
                    report.rescue_telemetry.rescue_error_class,
                );
                sentry_scope.set_tag("git_source", report.rescue_telemetry.git_source);
                sentry_scope.set_tag("git_version", report.rescue_telemetry.git_version.clone());
                sentry_scope.set_tag("rsync_source", report.rescue_telemetry.rsync_source);
                sentry_scope.set_tag(
                    "rsync_version",
                    report.rescue_telemetry.rsync_version.clone(),
                );
                sentry_scope.set_tag("node_source", report.rescue_telemetry.node_source);
                sentry_scope.set_tag("node_version", report.rescue_telemetry.node_version.clone());
                sentry_scope.set_tag("disk_free_bucket", report.rescue_telemetry.disk_free_bucket);
                sentry_scope.set_tag(
                    "root_on_synced_folder",
                    report.rescue_telemetry.root_on_synced_folder,
                );
                sentry_scope.set_tag("network_probe", report.rescue_telemetry.network_probe);
                sentry_scope.set_tag(
                    "attempt_number",
                    report.rescue_telemetry.attempt_number.to_string(),
                );
                sentry_scope.set_tag("app_version", crate::app_version::current());
                sentry_scope.set_tag("os_version", os_info::get().version().to_string());
                sentry_scope.set_tag("suppressed_since_last", suppressed_since_last.to_string());
                sentry_scope.set_extra(
                    "coreUpdateExitCode",
                    report
                        .exit_code
                        .map(|code| sentry::protocol::Value::Number(code.into()))
                        .unwrap_or(sentry::protocol::Value::Null),
                );
                sentry_scope.set_extra(
                    "coreUpdateAppVersion",
                    sentry::protocol::Value::String(crate::app_version::current().to_string()),
                );
                sentry_scope.set_extra(
                    "managedGitRetryAttempted",
                    sentry::protocol::Value::Bool(report.managed_git_retry.attempted()),
                );
                if let Some(rescue_stderr_tail) = report.rescue_stderr_tail {
                    sentry_scope.set_extra(
                        "rescueStderrTail",
                        sentry::protocol::Value::String(rescue_stderr_tail),
                    );
                }
                if let Some(first_error_line) = report.rescue_telemetry.first_error_line {
                    sentry_scope.set_extra(
                        "rescueErrorReason",
                        sentry::protocol::Value::String(
                            hq_telemetry::redact_core_update_diagnostic_tail(&first_error_line),
                        ),
                    );
                }
                sentry_scope.set_extra(
                    "rescueStageMarkers",
                    sentry::protocol::Value::Array(
                        report
                            .rescue_telemetry
                            .stage_markers
                            .into_iter()
                            .map(sentry::protocol::Value::String)
                            .collect(),
                    ),
                );
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

fn core_update_sentry_fingerprint(
    _error_kind: &'static str,
    _error_category: RescueFailureCategory,
) -> [&'static str; 1] {
    ["desktop-core-update-failed"]
}

fn core_update_rescue_step_for_category(category: RescueFailureCategory) -> &'static str {
    match category {
        RescueFailureCategory::RsyncBroken | RescueFailureCategory::RsyncPartialTransfer => "rsync",
        RescueFailureCategory::NpxResolveFailed => "npm-install",
        _ => "unknown",
    }
}

fn core_update_rescue_error_class_for_category(category: RescueFailureCategory) -> &'static str {
    match category {
        RescueFailureCategory::RsyncBroken => "rsync_failed",
        RescueFailureCategory::RsyncPartialTransfer => "rsync_partial",
        RescueFailureCategory::NpxResolveFailed => "npx_resolve_failed",
        _ => "unknown",
    }
}

fn core_update_sentry_failure_report(
    source: &'static str,
    channel: Channel,
    exit_code: Option<i32>,
    error_kind: &'static str,
    details: CoreUpdateFailureDetails<'_>,
) -> CoreUpdateSentryFailureReport {
    let mut rescue_telemetry = details.rescue_telemetry.cloned().unwrap_or_else(|| {
        CoreUpdateRescueTelemetry::from_raw(
            details.rescue_stderr_tail.unwrap_or_default(),
            1 + u32::from(details.managed_git_retry.attempted()),
        )
    });
    if rescue_telemetry.rescue_step == "unknown" {
        let step = core_update_rescue_step_for_category(details.rescue_failure_category);
        if step != "unknown" {
            rescue_telemetry.rescue_step = step;
        }
    }
    if rescue_telemetry.rescue_error_class == "unknown" {
        let error_class =
            core_update_rescue_error_class_for_category(details.rescue_failure_category);
        if error_class != "unknown" {
            rescue_telemetry.rescue_error_class = error_class;
        }
    }
    CoreUpdateSentryFailureReport {
        source,
        channel,
        exit_code,
        error_kind: core_update_sentry_error_kind(error_kind),
        error_category: details.rescue_failure_category,
        rescue_stderr_tail: details
            .rescue_stderr_tail
            .map(hq_telemetry::redact_core_update_diagnostic_tail),
        rescue_telemetry,
        npx_resolution: details.npx_resolution,
        managed_git_retry: details.managed_git_retry,
    }
}

fn report_core_update_failure_once(report: CoreUpdateSentryFailureReport) {
    report_core_update_failure_at(report, Instant::now());
}

fn report_core_update_failure_at(report: CoreUpdateSentryFailureReport, now: Instant) {
    if let Some(suppressed_since_last) = claim_core_update_sentry_capture(&report, now) {
        send_core_update_failure_report(report, suppressed_since_last);
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
        let source_hub = sentry::Hub::main();
        if source_hub.client().is_none() {
            return;
        }
        let report =
            core_update_sentry_failure_report(source, channel, exit_code, error_kind, details);
        let hub = std::sync::Arc::new(sentry::Hub::new_from_top(source_hub));
        hq_telemetry::dispatch_sentry_report(move || {
            sentry::Hub::run(hub, || report_core_update_failure_once(report));
        });
    }));
}

/// A post-apply baseline write matters for later drift detection, but it does
/// not change whether the rescue update itself succeeded. Keep its Sentry
/// issue separate from `core_update_failed` so an operational follow-up does
/// not look like an update failure to either people or alerting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CoreUpdateBaselinePersistenceWarningSignature {
    channel: Channel,
    error_category: RescueFailureCategory,
    diagnostic_tags: CoreUpdateBaselinePersistenceDiagnosticTags,
}

static CORE_UPDATE_BASELINE_WARNING_SIGNATURES: OnceLock<
    Mutex<HashSet<CoreUpdateBaselinePersistenceWarningSignature>>,
> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CoreUpdateBaselinePersistenceDiagnosticTags {
    write_path: &'static str,
    error_kind: &'static str,
    directory_state: &'static str,
    target_state: &'static str,
    temp_state: &'static str,
    permission_state: &'static str,
    disk_state: &'static str,
    concurrent_writer: &'static str,
}

impl CoreUpdateBaselinePersistenceDiagnosticTags {
    fn unknown() -> Self {
        Self {
            write_path: "unknown",
            error_kind: "unknown",
            directory_state: "unknown",
            target_state: "unknown",
            temp_state: "unknown",
            permission_state: "unknown",
            disk_state: "unknown",
            concurrent_writer: "unknown",
        }
    }

    fn from_detail(detail: &str) -> Self {
        let Some(start) = detail.rfind("[baseline_persistence_diagnostics ") else {
            return Self::unknown();
        };
        let marker = detail[start..].split(']').next().unwrap_or_default();
        let value = |key: &str| {
            marker
                .split_ascii_whitespace()
                .find_map(|field| field.strip_prefix(&format!("{key}=")))
                .unwrap_or("unknown")
        };
        let bounded = |value: &str, allowed: &[&'static str]| {
            allowed
                .iter()
                .copied()
                .find(|item| *item == value)
                .unwrap_or("unknown")
        };

        Self {
            write_path: bounded(
                value("write_path"),
                &[
                    "validate_key",
                    "create_directory",
                    "serialize",
                    "write_temp",
                    "remove_target",
                    "rename_temp",
                ],
            ),
            error_kind: bounded(
                value("error_kind"),
                &[
                    "invalid_input",
                    "serialization",
                    "not_found",
                    "permission_denied",
                    "already_exists",
                    "storage_full",
                    "out_of_memory",
                    "interrupted",
                    "other",
                ],
            ),
            directory_state: bounded(
                value("directory_state"),
                &["file", "directory", "other", "missing", "unknown"],
            ),
            target_state: bounded(
                value("target_state"),
                &["file", "directory", "other", "missing", "unknown"],
            ),
            temp_state: bounded(
                value("temp_state"),
                &["file", "directory", "other", "missing", "unknown"],
            ),
            permission_state: bounded(
                value("permission_state"),
                &["denied", "not_denied", "unknown"],
            ),
            disk_state: bounded(
                value("disk_state"),
                &["storage_full", "not_storage_full", "unknown"],
            ),
            concurrent_writer: bounded(
                value("concurrent_writer"),
                &[
                    "shared_temp_preexisting",
                    "temp_consumed_target_present",
                    "no_evidence",
                    "unknown",
                ],
            ),
        }
    }
}

#[derive(Debug, Clone)]
struct CoreUpdateBaselinePersistenceWarningReport {
    source: &'static str,
    channel: Channel,
    error_category: RescueFailureCategory,
    diagnostic_tags: CoreUpdateBaselinePersistenceDiagnosticTags,
    detail: String,
}

fn core_update_baseline_persistence_warning_report(
    source: &'static str,
    channel: Channel,
    detail: &str,
) -> CoreUpdateBaselinePersistenceWarningReport {
    CoreUpdateBaselinePersistenceWarningReport {
        source: core_update_sentry_source(source),
        channel,
        error_category: classify_spawn_error(detail)
            .unwrap_or_else(|| classify_rescue_stderr_failure(detail)),
        diagnostic_tags: CoreUpdateBaselinePersistenceDiagnosticTags::from_detail(detail),
        detail: hq_telemetry::redact_core_update_diagnostic_tail(detail),
    }
}

fn claim_core_update_baseline_warning_signature(
    signature: CoreUpdateBaselinePersistenceWarningSignature,
) -> bool {
    CORE_UPDATE_BASELINE_WARNING_SIGNATURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(signature)
}

fn send_core_update_baseline_persistence_warning(
    report: CoreUpdateBaselinePersistenceWarningReport,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let category = report.error_category.label();
        let fingerprint = ["desktop-core-update-baseline-persistence-failed"];
        sentry::with_scope(
            |sentry_scope| {
                sentry_scope.set_fingerprint(Some(&fingerprint));
                sentry_scope.set_tag("operation", "baseline_persistence");
                sentry_scope.set_tag("errorCategory", category);
                sentry_scope.set_tag("channel", channel_label(report.channel));
                sentry_scope.set_tag("platform", core_update_sentry_platform());
                sentry_scope.set_tag("source", report.source);
                sentry_scope.set_tag(
                    "persistence_write_path",
                    report.diagnostic_tags.write_path,
                );
                sentry_scope.set_tag(
                    "persistence_error_kind",
                    report.diagnostic_tags.error_kind,
                );
                sentry_scope.set_tag(
                    "persistence_directory_state",
                    report.diagnostic_tags.directory_state,
                );
                sentry_scope.set_tag(
                    "persistence_target_state",
                    report.diagnostic_tags.target_state,
                );
                sentry_scope.set_tag(
                    "persistence_temp_state",
                    report.diagnostic_tags.temp_state,
                );
                sentry_scope.set_tag(
                    "persistence_permission_state",
                    report.diagnostic_tags.permission_state,
                );
                sentry_scope.set_tag(
                    "persistence_disk_state",
                    report.diagnostic_tags.disk_state,
                );
                sentry_scope.set_tag(
                    "persistence_concurrent_writer",
                    report.diagnostic_tags.concurrent_writer,
                );
                sentry_scope.set_extra(
                    "baselinePersistenceDetail",
                    sentry::protocol::Value::String(report.detail),
                );
            },
            || {
                sentry::capture_message(
                    "Desktop Core update applied but baseline persistence failed",
                    sentry::Level::Warning,
                )
            },
        );
    }));
}

fn report_core_update_baseline_persistence_warning_once(
    report: CoreUpdateBaselinePersistenceWarningReport,
) {
    let signature = CoreUpdateBaselinePersistenceWarningSignature {
        channel: report.channel,
        error_category: report.error_category,
        diagnostic_tags: report.diagnostic_tags,
    };
    if claim_core_update_baseline_warning_signature(signature) {
        send_core_update_baseline_persistence_warning(report);
    }
}

fn queue_core_update_baseline_persistence_warning(
    source: &'static str,
    channel: Channel,
    detail: &str,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source_hub = sentry::Hub::main();
        if source_hub.client().is_none() {
            return;
        }
        let report = core_update_baseline_persistence_warning_report(source, channel, detail);
        let hub = std::sync::Arc::new(sentry::Hub::new_from_top(source_hub));
        hq_telemetry::dispatch_sentry_report(move || {
            sentry::Hub::run(hub, || {
                report_core_update_baseline_persistence_warning_once(report)
            });
        });
    }));
}

/// Records a degraded post-apply baseline write without converting the update
/// into a failure. The caller deliberately continues with its successful
/// rescue result so the UI reports the completed update.
pub(crate) fn record_core_update_baseline_persistence_failure(
    source: &'static str,
    channel: Channel,
    log_tag: &str,
    detail: &str,
) {
    log(log_tag, detail);
    queue_core_update_baseline_persistence_warning(source, channel, detail);
}

#[cfg(test)]
fn reset_core_update_sentry_signatures_for_test() {
    if let Some(limits) = CORE_UPDATE_SENTRY_RATE_LIMITS.get() {
        limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

#[cfg(test)]
fn reset_core_update_baseline_warning_signatures_for_test() {
    if let Some(signatures) = CORE_UPDATE_BASELINE_WARNING_SIGNATURES.get() {
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

/// Capture the paths known to the last successful baseline before rescue
/// rewrites `core/core.yaml`. Rescue leaves user-only paths in locked scopes;
/// normal runs log only their count, so the previous baseline path set is the
/// safe local boundary for the next baseline. Paths introduced by the new
/// source remain absent from the floor and are compared with the target tree
/// by the drift classifier.
pub(crate) fn core_drift_baseline_paths_before_rescue(
    hq_folder: &std::path::Path,
    source_repo: &str,
) -> BTreeSet<String> {
    core_drift_baseline_before_rescue(hq_folder, source_repo).unwrap_or_default()
}

/// Return the previous baseline membership, preserving the distinction between
/// an absent baseline and a valid empty baseline for the post-rescue refresh.
pub(crate) fn core_drift_baseline_before_rescue(
    hq_folder: &std::path::Path,
    source_repo: &str,
) -> Option<BTreeSet<String>> {
    let Some((source, commit)) = local_source_stamp(hq_folder) else {
        return None;
    };
    if source != source_repo {
        return None;
    }
    hq_desktop_core::drift_scope::load_core_drift_baseline(hq_folder, &source, &commit).map(
        |baseline| {
            baseline
                .normalized_blobs
                .into_keys()
                .collect()
        },
    )
}

fn normalize_rescue_path_relative(
    hq_folder: &std::path::Path,
    skipped_path: &str,
) -> Option<String> {
    let root = hq_folder.to_string_lossy().replace('\\', "/");
    let candidate = skipped_path.trim().replace('\\', "/");
    let root = root.trim_end_matches('/');

    if candidate.len() <= root.len()
        || !candidate[..root.len()].eq_ignore_ascii_case(root)
        || candidate.as_bytes().get(root.len()) != Some(&b'/')
    {
        return None;
    }

    let relative = candidate[root.len() + 1..].trim_matches('/');
    if relative.is_empty()
        || relative.split('/').any(|component| component.is_empty() || component == "." || component == "..")
    {
        return None;
    }
    Some(relative.to_string())
}

/// Parse the rescue's explicit snapshot-skip diagnostics. A marker without a
/// following absolute warning path makes the local fallback unsafe because its
/// bytes may still be from before the applied release.
fn skipped_rescue_paths(
    hq_folder: &std::path::Path,
    rescue_output: &str,
) -> Result<BTreeSet<String>, String> {
    let mut skipped = BTreeSet::new();
    let mut awaiting_path = false;

    for line in rescue_output.lines() {
        let line = line.trim();
        if line.starts_with("HQ_RESCUE_SKIPPED_KIND=") {
            if awaiting_path {
                return Err("rescue snapshot skip marker had no parseable path".to_string());
            }
            awaiting_path = true;
            continue;
        }
        if !awaiting_path {
            continue;
        }
        let Some(path) = line.strip_prefix("warning: snapshot skipped ") else {
            continue;
        };
        let Some(path) = path.strip_suffix(
            ". It was not backed up and was left untouched. The update continued.",
        ) else {
            continue;
        };
        let Some(relative) = normalize_rescue_path_relative(hq_folder, path.trim()) else {
            return Err("rescue snapshot skip path was not under the HQ root".to_string());
        };
        skipped.insert(relative);
        awaiting_path = false;
    }

    if awaiting_path {
        return Err("rescue snapshot skip marker had no parseable path".to_string());
    }
    Ok(skipped)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedRescueBaseline {
    pub(crate) commit: String,
    pub(crate) baseline_persisted: bool,
    pub(crate) refresh_pending: bool,
    pub(crate) persistence_diagnostic: Option<String>,
}

fn optional_core_tree_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = crate::util::client_info::client_headers();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(token) = token {
        let bearer = format!("Bearer {token}");
        let value = reqwest::header::HeaderValue::from_str(&bearer)
            .map_err(|error| format!("build GitHub authorization header: {error}"))?;
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("build Core baseline client: {error}"))
}

fn persist_applied_rescue_baseline_from_tree_with_path(
    hq_folder: &std::path::Path,
    previous_baseline_paths: Option<&BTreeSet<String>>,
    rescue_output: &str,
    channel: Channel,
    injected_path: Option<&std::path::Path>,
    remote_tree: Result<BTreeMap<String, (String, u64)>, String>,
) -> Result<AppliedRescueBaseline, String> {
    let (source, commit) = local_source_stamp(hq_folder).ok_or_else(|| {
        "rescue completed without a replaced_from_source.last_sync_sha stamp".to_string()
    })?;

    match remote_tree {
        Ok(tree) => {
            let blobs = tree
                .into_iter()
                .map(|(path, (sha, _))| (path, sha))
                .collect();
            if let Err(error) =
                hq_desktop_core::drift_scope::persist_core_drift_baseline_with_diagnostics(
                    hq_folder, &source, &commit, blobs,
                )
            {
                log(
                    "hq-core-state",
                    &format!(
                        "could not persist authoritative Core baseline {source}@{commit}: {error}; keeping refresh pending"
                    ),
                );
                persist_baseline_refresh_target(
                    channel,
                    &source,
                    &commit,
                    injected_path,
                )?;
                return Ok(AppliedRescueBaseline {
                    commit,
                    baseline_persisted: false,
                    refresh_pending: true,
                    persistence_diagnostic: Some(error.to_string()),
                });
            }
            let mut refresh_pending = false;
            if let Err(error) =
                clear_persisted_baseline_refresh_target(channel, injected_path)
            {
                log(
                    "hq-core-state",
                    &format!(
                        "persisted Core baseline {source}@{commit}, but could not clear its pending refresh marker: {error}; retrying the tree fetch"
                    ),
                );
                if let Err(persist_error) =
                    persist_baseline_refresh_target(
                        channel,
                        &source,
                        &commit,
                        injected_path,
                    )
                {
                    log(
                        "hq-core-state",
                        &format!(
                            "could not retain the pending Core baseline refresh marker: {persist_error}"
                        ),
                    );
                } else {
                    refresh_pending = true;
                }
            }
            Ok(AppliedRescueBaseline {
                commit,
                baseline_persisted: true,
                refresh_pending,
                persistence_diagnostic: None,
            })
        }
        Err(fetch_error) => {
            log(
                "hq-core-state",
                &format!(
                    "GitHub tree fetch failed for applied Core baseline {source}@{commit}: {fetch_error}; using local fallback"
                ),
            );
            let local_blobs = match previous_baseline_paths {
                Some(previous_paths) => match skipped_rescue_paths(hq_folder, rescue_output) {
                    Ok(skipped) => {
                        let locked = read_locked_paths(hq_folder);
                        Some(
                            walk_local_under_scope(hq_folder, &locked)
                                .into_iter()
                                .filter(|(path, _)| {
                                    previous_paths.contains(path) && !skipped.contains(path)
                                })
                                .map(|(path, (sha, _))| (path, sha))
                                .collect::<BTreeMap<_, _>>(),
                        )
                    }
                    Err(parse_error) => {
                        log(
                            "hq-core-state",
                            &format!(
                                "cannot derive a local Core baseline for {source}@{commit}: {parse_error}"
                            ),
                        );
                        None
                    }
                },
                None => None,
            };

            let mut baseline_persisted = false;
            let mut persistence_diagnostic = None;
            if let Some(blobs) = local_blobs {
                match hq_desktop_core::drift_scope::persist_core_drift_baseline_with_diagnostics(
                    hq_folder, &source, &commit, blobs,
                ) {
                    Ok(()) => baseline_persisted = true,
                    Err(error) => {
                        log(
                            "hq-core-state",
                            &format!(
                                "could not persist local fallback baseline {source}@{commit}: {error}"
                            ),
                        );
                        persistence_diagnostic = Some(error.to_string());
                    }
                }
            }
            persist_baseline_refresh_target(
                channel,
                &source,
                &commit,
                injected_path,
            )?;
            Ok(AppliedRescueBaseline {
                commit,
                baseline_persisted,
                refresh_pending: true,
                persistence_diagnostic,
            })
        }
    }
}

fn refresh_pending_baseline_from_tree_with_path(
    hq_folder: &std::path::Path,
    channel: Channel,
    pending: &BaselineRefreshTarget,
    injected_path: Option<&std::path::Path>,
    remote_tree: Result<BTreeMap<String, (String, u64)>, String>,
) -> Result<(), String> {
    let Some((source, commit)) = local_source_stamp(hq_folder) else {
        return Err("pending baseline refresh has no local stamp".to_string());
    };
    if source != pending.source || commit != pending.commit {
        return Err(format!(
            "pending baseline stamp changed from {}@{} to {source}@{commit}",
            pending.source, pending.commit
        ));
    }
    let tree = remote_tree?;
    let blobs = tree
        .into_iter()
        .map(|(path, (sha, _))| (path, sha))
        .collect();
    hq_desktop_core::drift_scope::persist_core_drift_baseline(
        hq_folder, &source, &commit, blobs,
    )?;
    clear_persisted_baseline_refresh_target(channel, injected_path)?;
    Ok(())
}

async fn persist_applied_rescue_baseline_with_fetcher<F, Fut>(
    hq_folder: &std::path::Path,
    previous_baseline_paths: Option<&BTreeSet<String>>,
    rescue_output: &str,
    channel: Channel,
    token: Option<&str>,
    fetcher: F,
) -> Result<AppliedRescueBaseline, String>
where
    F: FnOnce(String, String, Option<String>) -> Fut,
    Fut: Future<Output = Result<BTreeMap<String, (String, u64)>, String>>,
{
    persist_applied_rescue_baseline_with_fetcher_and_path(
        hq_folder,
        previous_baseline_paths,
        rescue_output,
        channel,
        token,
        None,
        fetcher,
    )
    .await
}

async fn persist_applied_rescue_baseline_with_fetcher_and_path<F, Fut>(
    hq_folder: &std::path::Path,
    previous_baseline_paths: Option<&BTreeSet<String>>,
    rescue_output: &str,
    channel: Channel,
    token: Option<&str>,
    injected_path: Option<&std::path::Path>,
    fetcher: F,
) -> Result<AppliedRescueBaseline, String>
where
    F: FnOnce(String, String, Option<String>) -> Fut,
    Fut: Future<Output = Result<BTreeMap<String, (String, u64)>, String>>,
{
    let (source, commit) = local_source_stamp(hq_folder).ok_or_else(|| {
        "rescue completed without a replaced_from_source.last_sync_sha stamp".to_string()
    })?;
    let remote_tree = fetcher(source, commit, token.map(str::to_string)).await;
    persist_applied_rescue_baseline_from_tree_with_path(
        hq_folder,
        previous_baseline_paths,
        rescue_output,
        channel,
        injected_path,
        remote_tree,
    )
}

/// Persist the authoritative GitHub tree for the commit the rescue stamped.
/// When GitHub cannot be reached, preserve only the previous local membership
/// after removing rescue-skipped paths and leave a durable refresh marker.
pub(crate) async fn persist_applied_rescue_baseline(
    hq_folder: &std::path::Path,
    previous_baseline_paths: Option<&BTreeSet<String>>,
    rescue_output: &str,
    channel: Channel,
    token: Option<&str>,
) -> Result<AppliedRescueBaseline, String> {
    persist_applied_rescue_baseline_with_fetcher(
        hq_folder,
        previous_baseline_paths,
        rescue_output,
        channel,
        token,
        |source, commit, token| async move {
            match optional_core_tree_client(token.as_deref()) {
                Ok(client) => fetch_tree(&client, &source, &commit).await,
                Err(error) => Err(error),
            }
        },
    )
    .await
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
    SkippedBaselineRefreshPending,
    SkippedNoRetryAfterAppliedFailure,
    SkippedConsecutiveFailureCap,
    SkippedRetryInterval,
    Succeeded,
    SucceededWithBaselinePersistenceFailure,
    FailedExit(i32),
    Failed(CoreUpdateErrorKind),
}

/// The rescue exit code is the user-facing update result. The baseline bit is
/// deliberately separate so automatic bookkeeping can retry degraded drift
/// setup without relabeling an applied update as a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreUpdateAutoInstall {
    exit_code: i32,
    baseline_persisted: bool,
    baseline_refresh_pending: bool,
    rescue_stderr_tail: String,
}

impl CoreUpdateAutoInstall {
    const fn new(exit_code: i32, baseline_persisted: bool) -> Self {
        Self {
            exit_code,
            baseline_persisted,
            baseline_refresh_pending: false,
            rescue_stderr_tail: String::new(),
        }
    }

    fn from_run(run: &crate::commands::hq_core_staging::RescueRunResult) -> Self {
        Self {
            exit_code: run.exit_code,
            baseline_persisted: run.baseline_persisted,
            baseline_refresh_pending: run.baseline_refresh_pending,
            rescue_stderr_tail: run.rescue_stderr_tail.clone(),
        }
    }
}

fn core_update_auto_install_from_run(
    app: &AppHandle,
    run: &crate::commands::hq_core_staging::RescueRunResult,
) -> CoreUpdateAutoInstall {
    if run.exit_code != 0 && rescue_failure_requires_no_automatic_retry(&run.rescue_stderr_tail) {
        let detail = preserve_restore_failure_notice(&run.log_tail);
        let message = match detail {
            Some(detail) => format!("Update failed. Full log: {}. {detail}", run.log_path),
            None => format!("Update failed. Full log: {}.", run.log_path),
        };
        let _ = app.emit(
            "hq-core-update:automatic-failed",
            json!({
                "title": "Update failed",
                "logPath": run.log_path,
                "message": message,
            }),
        );
        log("hq-core-update", &message);
    }
    CoreUpdateAutoInstall::from_run(run)
}

async fn execute_native_core_auto_update<F, Fut>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<CoreUpdateAutoInstall, CoreUpdateError>>,
{
    execute_native_core_auto_update_with_clock(
        candidate,
        auto_updates,
        sync_in_progress,
        Instant::now,
        None,
        install,
    )
    .await
}

async fn execute_native_core_auto_update_with_clock<F, Fut, Now>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    now: Now,
    injected_path: Option<&std::path::Path>,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<CoreUpdateAutoInstall, CoreUpdateError>>,
    Now: Fn() -> Instant,
{
    let baseline_refresh_pending =
        automatic_target_baseline_refresh_pending_with_path(candidate.channel, injected_path);
    match core_auto_update_decision(
        auto_updates,
        candidate.version_behind || baseline_refresh_pending,
        sync_in_progress,
    ) {
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
            match automatic_target_eligibility_with_path(
                candidate.channel,
                candidate.target_version,
                now(),
                injected_path,
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
                AutomaticTargetEligibility::BaselineRefreshPending => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: applied Core baseline refresh is pending",
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
                        Some(BASELINE_REFRESH_PENDING_SKIP_REASON),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedBaselineRefreshPending;
                }
                AutomaticTargetEligibility::NoRetryAfterAppliedFailure => {
                    log(
                        "hq-core-update",
                        "native auto-update skipped: rescue applied the target but could not restore preserved files",
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
                        Some(APPLIED_RESCUE_NO_RETRY_SKIP_REASON),
                    );
                    return NativeCoreAutoUpdateOutcome::SkippedNoRetryAfterAppliedFailure;
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
                Ok(result)
                    if result.exit_code == 0
                        && result.baseline_persisted
                        && !result.baseline_refresh_pending =>
                {
                    record_automatic_target_completed_with_path(
                        candidate.channel,
                        candidate.target_version,
                        injected_path,
                    );
                    log("hq-core-update", "native auto-update succeeded");
                    NativeCoreAutoUpdateOutcome::Succeeded
                }
                Ok(result) if result.exit_code == 0 => {
                    log(
                        "hq-core-update",
                        "native auto-update applied; the stamped Core baseline will refresh on a later scheduled check",
                    );
                    NativeCoreAutoUpdateOutcome::SucceededWithBaselinePersistenceFailure
                }
                Ok(result) => {
                    if rescue_failure_requires_no_automatic_retry(&result.rescue_stderr_tail) {
                        record_automatic_target_no_retry_after_applied_failure_with_path(
                            candidate.channel,
                            candidate.target_version,
                            injected_path,
                        );
                    } else {
                        record_automatic_target_failure_at_with_path(
                            candidate.channel,
                            candidate.target_version,
                            now(),
                            injected_path,
                        );
                    }
                    log(
                        "hq-core-update",
                        &format!(
                            "native auto-update failed: rescue_exit={}",
                            result.exit_code
                        ),
                    );
                    NativeCoreAutoUpdateOutcome::FailedExit(result.exit_code)
                }
                Err(error) => {
                    record_automatic_target_failure_at_with_path(
                        candidate.channel,
                        candidate.target_version,
                        now(),
                        injected_path,
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
    Fut: Future<Output = Result<CoreUpdateAutoInstall, CoreUpdateError>>,
{
    execute_native_core_auto_update_with_clock(
        candidate,
        auto_updates,
        sync_in_progress,
        || attempted_at,
        None,
        install,
    )
    .await
}

#[cfg(test)]
async fn execute_native_core_auto_update_at_with_path<F, Fut>(
    candidate: CoreAutoUpdateCandidate<'_>,
    auto_updates: bool,
    sync_in_progress: bool,
    attempted_at: Instant,
    injected_path: &std::path::Path,
    install: F,
) -> NativeCoreAutoUpdateOutcome
where
    F: FnOnce(Channel, CoreUpdateRunGuard, CoreUpdateTelemetryContext) -> Fut,
    Fut: Future<Output = Result<CoreUpdateAutoInstall, CoreUpdateError>>,
{
    execute_native_core_auto_update_with_clock(
        candidate,
        auto_updates,
        sync_in_progress,
        || attempted_at,
        Some(injected_path),
        install,
    )
    .await
}

async fn retry_pending_baseline_refresh_at<F, Fut>(
    channel: Channel,
    hq_folder: &std::path::Path,
    token: Option<String>,
    fetcher: F,
) -> bool
where
    F: FnOnce(String, String, Option<String>) -> Fut,
    Fut: Future<Output = Result<BTreeMap<String, (String, u64)>, String>>,
{
    retry_pending_baseline_refresh_at_with_path(channel, hq_folder, token, None, fetcher).await
}

async fn retry_pending_baseline_refresh_at_with_path<F, Fut>(
    channel: Channel,
    hq_folder: &std::path::Path,
    token: Option<String>,
    injected_path: Option<&std::path::Path>,
    fetcher: F,
) -> bool
where
    F: FnOnce(String, String, Option<String>) -> Fut,
    Fut: Future<Output = Result<BTreeMap<String, (String, u64)>, String>>,
{
    let Some(pending) = persisted_baseline_refresh_target(channel, injected_path) else {
        return false;
    };
    let Some((source, stamped_commit)) = local_source_stamp(hq_folder) else {
        log(
            "hq-core-state",
            "pending Core baseline refresh has no local stamp; keeping the scheduled installer suppressed",
        );
        return true;
    };
    if source != pending.source || stamped_commit != pending.commit {
        log(
            "hq-core-state",
            &format!(
                "clearing stale Core baseline refresh for {}@{}; stamp is {}@{}",
                pending.source, pending.commit, source, stamped_commit
            ),
        );
        if let Err(error) = clear_persisted_baseline_refresh_target(channel, injected_path) {
            log(
                "hq-core-state",
                &format!("could not clear stale Core baseline refresh: {error}"),
            );
        }
        return false;
    }

    let remote_tree = fetcher(
        source.clone(),
        stamped_commit.clone(),
        token,
    )
    .await;
    match remote_tree {
        Ok(tree) => match refresh_pending_baseline_from_tree_with_path(
            hq_folder,
            channel,
            &pending,
            injected_path,
            Ok(tree),
        ) {
            Ok(()) => {
                if let Err(error) =
                    clear_persisted_baseline_refresh_target(channel, injected_path)
                {
                    log(
                        "hq-core-state",
                        &format!("could not clear refreshed Core baseline marker: {error}"),
                    );
                }
                log(
                    "hq-core-state",
                    &format!("refreshed authoritative Core baseline {source}@{stamped_commit}"),
                );
                true
            }
            Err(error) => {
                record_core_update_baseline_persistence_failure(
                    "automatic",
                    channel,
                    "hq-core-state",
                    &format!(
                        "Core baseline refresh failed after tree fetch for {source}@{stamped_commit}: {error}"
                    ),
                );
                true
            }
        },
        Err(error) => {
            record_core_update_baseline_persistence_failure(
                "automatic",
                channel,
                "hq-core-state",
                &format!(
                    "Core baseline refresh pending for {source}@{stamped_commit}: {error}"
                ),
            );
            true
        }
    }
}

/// Retry only the GitHub tree request for a completed rescue whose local
/// fallback baseline is waiting for authoritative membership. The installer is
/// deliberately outside this path.
async fn retry_pending_baseline_refresh(state: &CoreState) -> bool {
    let hq_folder = hq_core_staging::resolve_hq_folder();
    retry_pending_baseline_refresh_at(
        state.channel,
        &hq_folder,
        hq_core_staging::resolve_gh_token(),
        |source, commit, token| async move {
            match optional_core_tree_client(token.as_deref()) {
                Ok(client) => fetch_tree(&client, &source, &commit).await,
                Err(error) => Err(error),
            }
        },
    )
    .await
}

async fn run_native_core_auto_update(app: &AppHandle, state: &CoreState) {
    if retry_pending_baseline_refresh(state).await {
        return;
    }
    let app_for_install = (*app).clone();
    let outcome = execute_native_core_auto_update(
        CoreAutoUpdateCandidate::from(state),
        hq_desktop_core::hq_cli_update::auto_update_enabled(),
        crate::updater::sync_in_progress(),
        move |channel, run_guard, observation| {
            let app_for_install = app_for_install.clone();
            async move {
                match channel {
                    Channel::Release => {
                        crate::commands::hq_core_update::install_hq_core_update_automatic(
                            run_guard,
                            observation,
                        )
                        .await
                        .map(|run| core_update_auto_install_from_run(&app_for_install, &run))
                    }
                    Channel::Staging => {
                        crate::commands::hq_core_staging::run_replace_from_staging_automatic(
                            run_guard,
                            observation,
                        )
                        .await
                        .map(|run| core_update_auto_install_from_run(&app_for_install, &run))
                    }
                }
            }
        },
    )
    .await;

    if matches!(
        outcome,
        NativeCoreAutoUpdateOutcome::Succeeded
            | NativeCoreAutoUpdateOutcome::SucceededWithBaselinePersistenceFailure
    ) {
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
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tempfile::TempDir;

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
                Ok(CoreUpdateAutoInstall::new(5, true))
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
                Ok(CoreUpdateAutoInstall::new(5, true))
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
                Ok(CoreUpdateAutoInstall::new(0, true))
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
    async fn pending_baseline_refresh_survives_restart_without_spawning_installer() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(home.path().join(".hq")).unwrap();
        let menubar_path = home.path().join(".hq/menubar.json");
        std::fs::write(&menubar_path, r#"{"futureKey":"must-survive"}"#).unwrap();
        let target = "15.0.117-baseline-refresh-restart-contract";
        persist_baseline_refresh_target(
            Channel::Release,
            "indigoai-us/hq-core",
            &"a".repeat(40),
            Some(&menubar_path),
        )
        .unwrap();

        reset_automatic_target_states_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let retry_calls = Arc::clone(&calls);
        let retry = execute_native_core_auto_update_at_with_path(
            CoreAutoUpdateCandidate {
                channel: Channel::Release,
                local_version: Some(target),
                target_version: target,
                is_eligible: true,
                version_behind: false,
            },
            true,
            false,
            Instant::now(),
            &menubar_path,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                retry_calls.fetch_add(1, Ordering::AcqRel);
                Ok(CoreUpdateAutoInstall::new(0, true))
            },
        )
        .await;

        assert_eq!(retry, NativeCoreAutoUpdateOutcome::SkippedBaselineRefreshPending);
        assert_eq!(calls.load(Ordering::Acquire), 0);
        let menubar = hq_desktop_core::first_run::read_menubar_obj(&menubar_path);
        assert_eq!(
            menubar.get("futureKey"),
            Some(&Value::String("must-survive".into()))
        );
    }

    #[tokio::test]
    async fn baseline_refresh_scheduled_retry_fetches_tree_without_installer() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let home = TempDir::new().unwrap();
        let menubar_path = home.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        let root = TempDir::new().unwrap();
        let source = "indigoai-us/hq-core";
        let commit = "b".repeat(40);
        let old_path = "core/policies/old.md";
        std::fs::create_dir_all(root.path().join("core/policies")).unwrap();
        std::fs::write(root.path().join(old_path), b"local\n").unwrap();
        std::fs::write(
            root.path().join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {commit}\n"
            ),
        )
        .unwrap();
        let previous_paths = [old_path.to_string()].into_iter().collect::<BTreeSet<_>>();

        let first = persist_applied_rescue_baseline_from_tree_with_path(
            root.path(),
            Some(&previous_paths),
            "",
            Channel::Release,
            Some(&menubar_path),
            Err("HTTP 403".to_string()),
        )
        .unwrap();
        assert!(first.baseline_persisted);
        assert!(first.refresh_pending);
        assert_eq!(
            persisted_baseline_refresh_target(Channel::Release, Some(&menubar_path)),
            Some(BaselineRefreshTarget {
                source: source.to_string(),
                commit: commit.clone()
            })
        );

        let mut remote = BTreeMap::new();
        remote.insert(old_path.to_string(), ("remote-old-blob".to_string(), 1));
        remote.insert(
            "core/policies/new.md".to_string(),
            ("remote-new-blob".to_string(), 1),
        );
        let fetch_calls = Arc::new(AtomicUsize::new(0));
        let failed_fetch_calls = Arc::clone(&fetch_calls);
        assert!(retry_pending_baseline_refresh_at_with_path(
            Channel::Release,
            root.path(),
            None,
            Some(&menubar_path),
            move |_, _, _| async move {
                failed_fetch_calls.fetch_add(1, Ordering::AcqRel);
                Err("HTTP 403".to_string())
            },
        )
        .await);

        let installer_calls = Arc::new(AtomicUsize::new(0));
        let installer_calls_for_attempt = Arc::clone(&installer_calls);
        let skipped = execute_native_core_auto_update_at_with_path(
            CoreAutoUpdateCandidate {
                channel: Channel::Release,
                local_version: Some("15.0.4"),
                target_version: "15.0.117-baseline-refresh-scheduled",
                is_eligible: true,
                version_behind: true,
            },
            true,
            false,
            Instant::now(),
            &menubar_path,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                installer_calls_for_attempt.fetch_add(1, Ordering::AcqRel);
                Ok(CoreUpdateAutoInstall::new(0, true))
            },
        )
        .await;
        assert_eq!(
            skipped,
            NativeCoreAutoUpdateOutcome::SkippedBaselineRefreshPending
        );
        assert_eq!(installer_calls.load(Ordering::Acquire), 0);

        let successful_fetch_calls = Arc::clone(&fetch_calls);
        assert!(retry_pending_baseline_refresh_at_with_path(
            Channel::Release,
            root.path(),
            None,
            Some(&menubar_path),
            move |_, _, _| async move {
                successful_fetch_calls.fetch_add(1, Ordering::AcqRel);
                Ok(remote)
            },
        )
        .await);
        assert_eq!(fetch_calls.load(Ordering::Acquire), 2);
        assert!(
            persisted_baseline_refresh_target(Channel::Release, Some(&menubar_path)).is_none()
        );
        let baseline =
            hq_desktop_core::drift_scope::load_core_drift_baseline(root.path(), source, &commit)
                .unwrap();
        assert_eq!(
            baseline.normalized_blobs.get("core/policies/new.md"),
            Some(&"remote-new-blob".to_string())
        );
    }

    #[tokio::test]
    async fn applied_preserve_restore_failure_is_persisted_as_no_retry_across_restart() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let home = TempDir::new().unwrap();
        let menubar_path = home.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        reset_automatic_target_states_for_test();
        let target = "15.0.117-preserve-restore-no-retry-contract";
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        let transcript = "==> Could not restore these preserved paths after the update:\n  personal/settings.json: restore failed\nThe updated HQ release files are already in place.\nSafety snapshot: /tmp/hq-snapshot-123\nHQ_RESCUE_FAILURE_KIND=preserve-restore-failed";
        let first = execute_native_core_auto_update_at_with_path(
            CoreAutoUpdateCandidate {
                channel: Channel::Release,
                local_version: Some("15.0.4"),
                target_version: target,
                is_eligible: true,
                version_behind: true,
            },
            true,
            false,
            Instant::now(),
            &menubar_path,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                first_calls.fetch_add(1, Ordering::AcqRel);
                Ok(CoreUpdateAutoInstall {
                    exit_code: 1,
                    baseline_persisted: true,
                    baseline_refresh_pending: false,
                    rescue_stderr_tail: "HQ_RESCUE_FAILURE_KIND=preserve-restore-failed"
                        .to_string(),
                })
            },
        )
        .await;
        assert_eq!(first, NativeCoreAutoUpdateOutcome::FailedExit(1));
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert_eq!(
            persisted_automatic_no_retry_target(Channel::Release, Some(&menubar_path)).as_deref(),
            Some(target)
        );
        assert_eq!(
            preserve_restore_failure_notice(transcript).as_deref(),
            Some(
                "The rescue could not restore preserved path(s) personal/settings.json; it kept the bytes in /tmp/hq-snapshot-123."
            )
        );

        reset_automatic_target_states_for_test();
        let second = execute_native_core_auto_update_at_with_path(
            CoreAutoUpdateCandidate {
                channel: Channel::Release,
                local_version: Some("15.0.4"),
                target_version: target,
                is_eligible: true,
                version_behind: true,
            },
            true,
            false,
            Instant::now(),
            &menubar_path,
            |_, _run_guard, _| async move {
                panic!("a persisted no-retry target must not spawn the automatic installer");
            },
        )
        .await;
        assert_eq!(
            second,
            NativeCoreAutoUpdateOutcome::SkippedNoRetryAfterAppliedFailure
        );
        assert_eq!(calls.load(Ordering::Acquire), 1);

        clear_automatic_no_retry_for_manual_with_path(Channel::Release, Some(&menubar_path));
        assert!(
            persisted_automatic_no_retry_target(Channel::Release, Some(&menubar_path)).is_none()
        );
        assert_eq!(
            automatic_target_eligibility_with_path(
                Channel::Release,
                target,
                Instant::now(),
                Some(&menubar_path),
            ),
            AutomaticTargetEligibility::Eligible,
            "a manual Update or Restore clears the automatic no-retry target before spawning",
        );
        let manual_calls = Arc::new(AtomicUsize::new(0));
        let manual_calls_for_run = Arc::clone(&manual_calls);
        let manual = execute_native_core_auto_update_at_with_path(
            CoreAutoUpdateCandidate {
                channel: Channel::Release,
                local_version: Some("15.0.4"),
                target_version: target,
                is_eligible: true,
                version_behind: true,
            },
            true,
            false,
            Instant::now(),
            &menubar_path,
            move |_, run_guard, _| async move {
                let _run_guard = run_guard;
                manual_calls_for_run.fetch_add(1, Ordering::AcqRel);
                Ok(CoreUpdateAutoInstall::new(0, true))
            },
        )
        .await;
        assert_eq!(manual, NativeCoreAutoUpdateOutcome::Succeeded);
        assert_eq!(manual_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn pre_apply_failure_still_reports_an_update_failure() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        reset_automatic_target_states_for_test();
        let candidate = CoreAutoUpdateCandidate {
            channel: Channel::Release,
            local_version: Some("15.0.4"),
            target_version: "15.0.117-pre-apply-failure-contract",
            is_eligible: true,
            version_behind: true,
        };

        let outcome =
            execute_native_core_auto_update(candidate, true, false, |_, run_guard, _| async move {
                let _run_guard = run_guard;
                Err(CoreUpdateError::new(
                    CoreUpdateErrorKind::Network,
                    "fetch latest hq-core release: connection refused",
                ))
            })
            .await;

        assert_eq!(
            outcome,
            NativeCoreAutoUpdateOutcome::Failed(CoreUpdateErrorKind::Network)
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
                Ok(CoreUpdateAutoInstall::new(0, true))
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
                Ok(CoreUpdateAutoInstall::new(0, true))
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
                    Ok(CoreUpdateAutoInstall::new(5, true))
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
                Ok(CoreUpdateAutoInstall::new(0, true))
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
                rescue_telemetry: None,
                rescue_failure_category: classify_rescue_exit_failure(stderr, npx_resolution),
                npx_resolution: Some(npx_resolution),
                managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
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
        let category = classify_rescue_stderr_failure(stderr);

        assert_eq!(category, RescueFailureCategory::MissingDependency);
        assert_eq!(category.label(), "missing-dependency");
    }

    #[test]
    fn rescue_xcode_license_refusal_is_a_missing_dependency() {
        let stderr = "==> Cloning [Filtered] @main (full history, blob:none filter) ...\n\
You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\n\
error: clone failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::MissingDependency
        );
    }

    #[test]
    fn rescue_specific_preflight_failures_precede_broader_permission_needles() {
        let cases = [
            (
                "error: rsync preflight failed before any safety snapshot was allocated.\n\
       version output: permission denied",
                "rsync preflight",
            ),
            (
                "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\n\
permission denied",
                "Xcode license refusal",
            ),
        ];

        for (stderr, diagnosis) in cases {
            assert_eq!(
                classify_rescue_stderr_failure(stderr),
                RescueFailureCategory::MissingDependency,
                "the {diagnosis} diagnostic must not be shadowed by a broader permission needle"
            );
        }
    }

    #[test]
    fn rescue_broken_git_https_transport_is_a_missing_dependency() {
        let stderr = "warning: templates not found in ...\n\
git: 'remote-https' is not a git command. See 'git --help'.\n\
fatal: remote helper 'https' aborted session\n\
error: clone failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::MissingDependency
        );
    }

    #[test]
    fn rescue_broken_git_https_transport_keeps_auth_precedence() {
        assert_eq!(
            classify_rescue_stderr_failure("is not a git command; authentication failed"),
            RescueFailureCategory::Auth
        );
    }

    #[test]
    fn rescue_https_missing_helper_without_abort_is_not_missing_dependency() {
        assert_eq!(
            classify_rescue_stderr_failure("git: 'remote-https' is not a git command"),
            RescueFailureCategory::Unknown
        );
    }

    #[test]
    fn rescue_generic_clone_failure_remains_unknown() {
        assert_eq!(
            classify_rescue_stderr_failure("error: clone failed"),
            RescueFailureCategory::Unknown
        );
    }

    #[test]
    fn fixture_1_http2_clone_disconnect_is_network() {
        let stderr = concat!(
            "error: RPC failed; curl 92 HTTP/2 stream 3 was not closed cleanly: CANCEL (err 8)\n",
            "error: 625 bytes of body are still expected\n",
            "fetch-pack: unexpected disconnect while reading sideband packet\n",
            "fatal: early EOF\n",
            "fatal: fetch-pack: invalid index-pack output\n",
            "fatal: could not fetch 454b8427cd757f30dc7fdb9a325d19c399770417 from promisor remote\n",
            "warning: Clone succeeded, but checkout failed.\n",
            "error: clone failed",
        );

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::Network
        );
    }

    #[test]
    fn local_checkout_failure_without_transport_diagnostic_is_unknown() {
        let stderr = concat!(
            "warning: Clone succeeded, but checkout failed.\n",
            "error: invalid path 'aux.txt'\n",
        );

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::Unknown
        );
    }

    #[test]
    fn fixture_2_ssl_connection_timeout_is_timeout() {
        let stderr =
            "fatal: unable to access '[Filtered]': SSL connection timeout\nerror: clone failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::Timeout
        );
    }

    #[test]
    fn fixture_3_https_helper_abort_without_missing_helper_is_network() {
        let stderr = "fatal: remote helper 'https' aborted session\nerror: clone failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::Network
        );
    }

    #[test]
    fn fixture_4_curl_receive_timeout_is_timeout() {
        let stderr = concat!(
            "error: RPC failed; curl 56 Recv failure: Operation timed out\n",
            "fatal: expected 'packfile'\n",
            "error: clone failed",
        );

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::Timeout
        );
    }

    #[test]
    fn fixture_5_snapshot_circuit_breaker_is_recovery_required() {
        let stderr =
            "error: safety snapshot circuit breaker is open: two interrupted updates still need recovery proof.";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotRecoveryRequired
        );
    }

    #[test]
    fn fixture_6_rsync_code_23_is_partial_transfer() {
        let stderr = "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1306) [sender=3.4.1]";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::RsyncPartialTransfer
        );
        assert_eq!(core_update_sentry_exit_code(Some(23)), "23");
    }

    #[test]
    fn fixture_7_enotempty_is_directory_not_empty() {
        let stderr = "Error: ENOTEMPTY, Directory not empty: '[Filtered]' '[Filtered]'";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::DirectoryNotEmpty
        );
    }

    #[test]
    fn fixture_8_npm_cache_other_window_is_lock_contention() {
        let detail = "HQ Sync is still preparing its npm cache in another window. Wait a moment, then try Sync again.";

        assert_eq!(
            classify_core_update_error(CoreUpdateErrorKind::RescueSpawn, detail, None),
            RescueFailureCategory::LockContention
        );
    }

    #[test]
    fn fixture_9_found_rsync_that_exits_is_rsync_broken() {
        let stderr = concat!(
            "error: rsync preflight failed before any safety snapshot was allocated.\n",
            "rsync exited with status 1.\n",
            r#"rsync found at: [Filtered]\AppData\Local\IndigoHQ\toolchain\npm-prefix\rsync.cmd"#,
            "\nInstall or repair rsync, then retry the HQ update.",
        );

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::RsyncBroken
        );
    }

    #[test]
    fn fixture_10_network_unreachable_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=network-unreachable";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=network-unreachable\nerror: clone failed",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::Network
        );
    }

    #[test]
    fn fixture_10_missing_dependency_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=missing-dependency";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=missing-dependency\nerror: clone failed",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::MissingDependency
        );
    }

    #[test]
    fn rsync_missing_marker_survives_redaction_and_classifies_as_missing_dependency() {
        let marker = "HQ_RESCUE_FAILURE_KIND=rsync-missing";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ could not install rsync, which the update needs.\nHQ_RESCUE_FAILURE_KIND=rsync-missing",
        );

        assert!(redacted.ends_with(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::MissingDependency
        );
    }

    #[test]
    fn fixture_11_preserve_restore_failed_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=preserve-restore-failed";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=preserve-restore-failed\nerror: restore failed",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::PreserveRestoreFailed
        );
    }

    #[test]
    fn snapshot_recovery_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=snapshot-recovery-circuit-breaker";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=snapshot-recovery-circuit-breaker\nerror: rescue failed",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::SnapshotRecoveryRequired
        );
    }

    #[test]
    fn rsync_partial_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=rsync-partial";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=rsync-partial\nrsync exited with status 23",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::RsyncPartialTransfer
        );
    }

    #[test]
    fn rsync_failed_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=rsync-failed";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=rsync-failed\nrsync exited with status 1",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::RsyncBroken
        );
    }

    #[test]
    fn rsync_found_but_broken_marker_survives_redaction_and_classifies() {
        let marker = "HQ_RESCUE_FAILURE_KIND=rsync-found-but-broken";
        let redacted = hq_telemetry::redact_core_update_diagnostic_tail(
            "HQ_RESCUE_FAILURE_KIND=rsync-found-but-broken\nrsync exited with status 1",
        );

        assert!(redacted.contains(marker));
        assert_eq!(
            classify_rescue_stderr_failure(&redacted),
            RescueFailureCategory::RsyncBroken
        );
    }

    #[test]
    fn rescue_snapshot_read_failure_with_errno_is_snapshot_unreadable() {
        let stderr = "error: safety snapshot could not read <path> 102 (Unknown system error -11).";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotUnreadable
        );
    }

    #[test]
    fn rescue_snapshot_read_failure_without_errno_is_snapshot_unreadable() {
        let stderr = "error: safety snapshot could not read <path> (Unknown system error -11).";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotUnreadable
        );
    }

    #[test]
    fn rescue_snapshot_external_symlink_failure_is_classified() {
        let stderr = "error: safety snapshot could not safely record <path> (UNKNOWN): target for .mcp.json resolves outside the HQ root.";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotExternalSymlink
        );
    }

    #[test]
    fn rescue_snapshot_record_failure_is_snapshot_failed() {
        let stderr =
            "error: safety snapshot could not safely record <path> (UNKNOWN): copy failed.";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotFailed
        );
    }

    #[test]
    fn rescue_outdated_git_filter_option_is_an_outdated_dependency() {
        let stderr = "error: unknown option `filter=blob:none'";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::OutdatedDependency
        );
    }

    #[test]
    fn rescue_snapshot_unreadable_marker_precedes_phrase_classification() {
        let stderr = "HQ_RESCUE_FAILURE_KIND=snapshot-copy-unreadable\nerror: rescue failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::SnapshotUnreadable
        );
    }

    #[test]
    fn rescue_snapshot_failed_marker_precedes_phrase_classification() {
        let raw_stderr = "HQ_RESCUE_FAILURE_KIND=snapshot-copy-failed\nerror: safety snapshot could not read <path> (Unknown system error -11).";
        let stderr = hq_telemetry::redact_core_update_diagnostic_tail(raw_stderr);

        assert_eq!(
            classify_rescue_stderr_failure(&stderr),
            RescueFailureCategory::SnapshotFailed
        );
    }

    #[test]
    fn rescue_snapshot_marker_is_classified_after_core_update_redaction() {
        let raw_stderr = concat!(
            "HQ_RESCUE_FAILURE_KIND=snapshot-copy-unreadable\n",
            "HQ_RESCUE_SNAPSHOT_COPY_CODE=EDEADLK\n",
            "error: safety snapshot could not read /Users/alice/HQ/core/release.txt 102 (Unknown system error -11)."
        );
        let stderr = hq_telemetry::redact_core_update_diagnostic_tail(raw_stderr);

        assert!(stderr.contains("HQ_RESCUE_FAILURE_KIND=snapshot-copy-unreadable"));
        assert!(!stderr.contains("HQ_RESCUE_SNAPSHOT_COPY_CODE=EDEADLK"));
        assert_eq!(
            classify_rescue_stderr_failure(&stderr),
            RescueFailureCategory::SnapshotUnreadable
        );
    }

    #[test]
    fn rescue_skip_marker_survives_redaction_without_snapshot_classification() {
        let raw_stderr = concat!(
            "HQ_RESCUE_SKIPPED_KIND=snapshot-copy-unreadable\n",
            "HQ_RESCUE_SNAPSHOT_COPY_CODE=EDEADLK\n",
            "warning: snapshot skipped /Users/alice/HQ/core/release.txt. It was not backed up and was left untouched. The update continued.\n",
            "error: clone failed"
        );
        let stderr = hq_telemetry::redact_core_update_diagnostic_tail(raw_stderr);

        assert!(stderr.contains("HQ_RESCUE_SKIPPED_KIND=snapshot-copy-unreadable"));
        assert!(!stderr.contains("HQ_RESCUE_SNAPSHOT_COPY_CODE=EDEADLK"));
        assert_eq!(
            classify_rescue_stderr_failure(&stderr),
            RescueFailureCategory::Unknown
        );
    }

    #[test]
    fn rescue_unknown_marker_falls_through_to_stderr_patterns() {
        let stderr =
            "HQ_RESCUE_FAILURE_KIND=something-we-do-not-know\nerror: rsync preflight failed";

        assert_eq!(
            classify_rescue_stderr_failure(stderr),
            RescueFailureCategory::MissingDependency
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
    fn rescue_exit_failure_retains_origin_main_categories_and_precedence() {
        let npx_resolution = CoreUpdateNpxResolution {
            resolved: true,
            source: "managed_toolchain",
        };
        let origin_main_cases = [
            (
                "rsync preflight failed",
                RescueFailureCategory::MissingDependency,
            ),
            ("authentication failed", RescueFailureCategory::Auth),
            ("could not resolve host", RescueFailureCategory::Dns),
            ("ssl certificate problem", RescueFailureCategory::Tls),
            ("no space left on device", RescueFailureCategory::DiskFull),
            ("operation not permitted", RescueFailureCategory::Permission),
            ("repository not found", RescueFailureCategory::NotFound),
            ("operation timed out", RescueFailureCategory::Timeout),
            ("connection refused", RescueFailureCategory::Network),
        ];

        for (stderr, expected) in origin_main_cases {
            assert_eq!(
                classify_rescue_exit_failure(stderr, npx_resolution),
                expected,
                "rescue exit must retain origin/main classification for {stderr:?}"
            );
        }

        for (stderr, expected) in [
            (
                "authentication failed: no such file or directory",
                RescueFailureCategory::Auth,
            ),
            (
                "connection refused: no such file or directory",
                RescueFailureCategory::Network,
            ),
        ] {
            assert_eq!(
                classify_rescue_exit_failure(stderr, npx_resolution),
                expected,
                "spawn-shaped detail must not change rescue-exit precedence"
            );
        }
    }

    #[test]
    fn core_update_error_classification_uses_typed_conditions_before_detail() {
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::Network,
                "failed to connect while resolving the update",
                None,
            ),
            RescueFailureCategory::Network
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: ENOENT: No such file or directory",
                Some(CoreUpdateNpxResolution {
                    resolved: false,
                    source: "not_resolved",
                })
            ),
            RescueFailureCategory::NpxResolveFailed
        );

        for error_kind in [
            CoreUpdateErrorKind::AlreadyInProgress,
            CoreUpdateErrorKind::InvalidCoreRoot,
            CoreUpdateErrorKind::ChannelConfiguration,
            CoreUpdateErrorKind::Internal,
        ] {
            assert_eq!(
                classify_core_update_error(error_kind, "connection refused", None),
                RescueFailureCategory::Unknown,
                "{error_kind:?} must keep its existing typed classification"
            );
        }
    }

    #[test]
    fn rescue_spawn_errors_classify_their_details() {
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: ENOENT: No such file or directory (os error 2)",
                None,
            ),
            RescueFailureCategory::MissingDependency
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: Access is denied (os error 5)",
                None,
            ),
            RescueFailureCategory::Permission
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "authentication failed: no such file or directory",
                None,
            ),
            RescueFailureCategory::MissingDependency,
            "spawn-shaped details must take precedence only on the spawn path"
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: unexpected operating-system failure",
                None,
            ),
            RescueFailureCategory::Unknown,
            "an unrecognized spawn failure must not become a catch-all category"
        );
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "update process quiescence is already in progress",
                None,
            ),
            RescueFailureCategory::Unknown,
            "the existing category vocabulary has no lock-conflict label"
        );
    }

    #[test]
    fn rescue_spawn_classifies_windows_npm_cache_lock_contention() {
        let detail = "HQ Sync could not coordinate npm cache preparation: The process cannot access the file because another process has locked a portion of the file. (os error 33)";

        assert_eq!(
            classify_core_update_error(CoreUpdateErrorKind::RescueSpawn, detail, None),
            RescueFailureCategory::LockContention
        );
    }

    #[test]
    fn rescue_spawn_classifies_normalized_npx_materialization_failures() {
        let cases = [
            (
                "HQ Sync cannot update its npm cache because this account cannot write to it. Fix the npm cache permissions, then try Sync again.",
                RescueFailureCategory::Permission,
            ),
            (
                "HQ Sync cannot run the sync engine because the Node/npm installation is not executable. Reinstall Node 20 or newer, then reopen HQ Sync.",
                RescueFailureCategory::MissingDependency,
            ),
            (
                "HQ Sync cannot start the sync engine because Node.js was not found. Install Node 20 or newer, then reopen HQ Sync.",
                RescueFailureCategory::MissingDependency,
            ),
            (
                "HQ Sync could not prepare its npm cache (npx exited with code 1). Check your network and npm setup, then try Sync again.",
                RescueFailureCategory::Network,
            ),
        ];

        for (message, expected) in cases {
            assert_eq!(
                classify_core_update_error(CoreUpdateErrorKind::RescueSpawn, message, None),
                expected,
                "normalized npx materialization message must classify as {expected:?}: {message}"
            );
        }
    }

    #[test]
    fn interrupted_npx_materialization_remains_unknown() {
        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "HQ Sync could not prepare its npm cache because npx was interrupted. Try Sync again.",
                None,
            ),
            RescueFailureCategory::Unknown,
            "an interrupted npx process has no sufficiently specific failure category"
        );
    }

    #[test]
    fn rescue_exit_keeps_auth_precedence_over_spawn_needles() {
        assert_eq!(
            classify_rescue_exit_failure(
                "authentication failed: no such file or directory",
                CoreUpdateNpxResolution {
                    resolved: true,
                    source: "managed_toolchain",
                },
            ),
            RescueFailureCategory::Auth,
            "rescue-exit classification must not use spawn-pattern precedence"
        );
    }

    #[test]
    fn unresolved_npx_precedes_detail_classification_for_spawn_errors() {
        let unresolved_npx = Some(CoreUpdateNpxResolution {
            resolved: false,
            source: "not_resolved",
        });

        assert_eq!(
            classify_core_update_error(
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: No such file or directory",
                unresolved_npx,
            ),
            RescueFailureCategory::NpxResolveFailed
        );
    }

    #[test]
    fn rescue_stderr_needles_remain_case_insensitive() {
        assert_eq!(
            classify_rescue_stderr_failure("fatal: COULD NOT RESOLVE HOST: github.com"),
            RescueFailureCategory::Dns
        );
    }

    #[test]
    fn sentry_exit_code_names_dependency_spawn_failures() {
        assert_eq!(core_update_sentry_exit_code(Some(127)), "127");
        assert_eq!(core_update_sentry_exit_code(Some(126)), "126");
        assert_eq!(core_update_sentry_exit_code(Some(3)), "3");
        assert_eq!(core_update_sentry_exit_code(Some(-1)), "signal_or_unknown");
        assert_eq!(core_update_sentry_exit_code(None), "not_available");
        assert_eq!(core_update_sentry_exit_code(Some(23)), "23");
        assert_eq!(core_update_sentry_exit_code(Some(42)), "other");
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
    fn rescue_failure_categories_are_admitted_by_the_closed_error_vocabulary() {
        for category in RescueFailureCategory::ALL {
            assert!(
                crate::commands::telemetry::ERROR_CATEGORY_VALUES.contains(&category.label()),
                "{} must be present in ERROR_CATEGORY_VALUES",
                category.label()
            );
        }
    }

    fn report_for_core_update_error(error: &CoreUpdateError) -> CoreUpdateSentryFailureReport {
        core_update_sentry_failure_report(
            "automatic",
            Channel::Release,
            None,
            error.kind().label(),
            core_update_failure_details(error),
        )
    }

    #[test]
    fn rescue_spawn_report_keeps_a_bounded_redacted_detail() {
        let error = CoreUpdateError::new(
            CoreUpdateErrorKind::RescueSpawn,
            "npx failed: Access is denied for /Users/alice/.npm; token npm_abcdefghijklmnop",
        );

        let report = report_for_core_update_error(&error);
        let tail = report
            .rescue_stderr_tail
            .expect("RescueSpawn reports retain a redacted diagnostic tail");

        assert!(tail.contains("Access is denied"));
        assert!(!tail.contains("/Users/alice"));
        assert!(!tail.contains("npm_abcdefghijklmnop"));
        assert!(tail.len() <= hq_telemetry::SETUP_DIAGNOSTIC_STREAM_LIMIT_BYTES);
    }

    #[test]
    fn core_update_error_report_keeps_origin_main_dimensions() {
        let cases = [
            (
                CoreUpdateErrorKind::RescueSpawn,
                "spawn rescue script: Access is denied (os error 5)",
                RescueFailureCategory::Permission,
                "rescue_spawn",
                "not_available",
            ),
            (
                CoreUpdateErrorKind::Network,
                "unrelated network wording",
                RescueFailureCategory::Network,
                "network",
                "not_available",
            ),
            (
                CoreUpdateErrorKind::Internal,
                "connection refused",
                RescueFailureCategory::Unknown,
                "internal",
                "not_available",
            ),
        ];

        for (kind, detail, category, error_kind, exit_code) in cases {
            let error = CoreUpdateError::new(kind, detail);
            let report = report_for_core_update_error(&error);

            assert_eq!(report.error_category, category);
            assert_eq!(report.error_kind, error_kind);
            assert_eq!(core_update_sentry_exit_code(report.exit_code), exit_code);
        }
    }

    #[test]
    fn rescue_exit_report_keeps_its_existing_redacted_tail() {
        let stderr =
            "fatal: unable to access https://github.com/indigoai-us/hq-core at /Users/alice/.npm";
        let details = CoreUpdateFailureDetails {
            rescue_stderr_tail: Some(stderr),
            rescue_telemetry: None,
            rescue_failure_category: RescueFailureCategory::Unknown,
            npx_resolution: None,
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
        };

        let report = core_update_sentry_failure_report(
            "automatic",
            Channel::Release,
            Some(5),
            "rescue_exit",
            details,
        );

        assert_eq!(
            report.rescue_stderr_tail,
            Some(hq_telemetry::redact_core_update_diagnostic_tail(stderr))
        );
    }

    #[test]
    fn spawn_failure_fingerprint_excludes_the_detail() {
        let first = report_for_core_update_error(&CoreUpdateError::new(
            CoreUpdateErrorKind::RescueSpawn,
            "npx failed: Access is denied while opening its cache",
        ));
        let second = report_for_core_update_error(&CoreUpdateError::new(
            CoreUpdateErrorKind::RescueSpawn,
            "npx failed: Access is denied while launching its shim",
        ));

        assert_eq!(first.error_category, second.error_category);
        assert_eq!(
            core_update_sentry_fingerprint(first.error_kind, first.error_category),
            core_update_sentry_fingerprint(second.error_kind, second.error_category)
        );
    }

    #[test]
    fn every_core_update_failure_uses_one_issue_fingerprint() {
        let first = core_update_sentry_fingerprint(
            "rescue_exit",
            RescueFailureCategory::MissingDependency,
        );
        let second = core_update_sentry_fingerprint(
            "network",
            RescueFailureCategory::Tls,
        );

        assert_eq!(first.as_slice(), ["desktop-core-update-failed"].as_slice());
        assert_eq!(second.as_slice(), ["desktop-core-update-failed"].as_slice());
    }

    #[test]
    fn rescue_telemetry_extracts_closed_dimensions_and_scrubs_reason() {
        let raw = "==> Cloning source\n==> Verifying checkout\nnode_version=20.11.1\ngit_version=2.44.0\nrsync_version=3.2.7\ndisk free: 3 GiB\nnetwork_probe=ok\nroot=/Users/ada/OneDrive/HQ\nattempt_number=2\nfatal: clone failed at /Users/ada/OneDrive/HQ\n";
        let telemetry = CoreUpdateRescueTelemetry::from_raw(raw, 1);

        assert_eq!(telemetry.rescue_step, "verify");
        assert_eq!(telemetry.rescue_error_class, "clone_failed");
        assert_eq!(telemetry.git_version, "2.44.0");
        assert_eq!(telemetry.rsync_version, "3.2.7");
        assert!(matches!(
            telemetry.node_source,
            "settings_path"
                | "managed_toolchain"
                | "user_prefix"
                | "system_prefix"
                | "login_shell"
                | "not_resolved"
        ));
        assert_eq!(telemetry.node_version, "20.11.1");
        assert_eq!(telemetry.disk_free_bucket, "1-5G");
        assert_eq!(telemetry.root_on_synced_folder, "onedrive");
        assert_eq!(telemetry.network_probe, "ok");
        assert_eq!(telemetry.attempt_number, 2);
        assert_eq!(telemetry.stage_markers.len(), 2);
        assert!(telemetry.stage_markers[0].ends_with("|clone"));
        assert!(telemetry.stage_markers[1].ends_with("|verify"));

        let reason = hq_telemetry::redact_core_update_diagnostic_tail(
            telemetry.first_error_line.as_deref().unwrap_or_default(),
        );
        assert!(!reason.contains("/Users/ada"));
        assert!(!reason.contains("OneDrive/HQ"));
    }

    #[test]
    fn rescue_telemetry_does_not_infer_versions_from_unstructured_output() {
        let telemetry = CoreUpdateRescueTelemetry::from_raw(
            "source=https://github.com/indigoai-us/hq-core/releases/tag/v0.10.302\nv22.17.0\n",
            1,
        );

        assert_eq!(telemetry.git_version, "unknown");
        assert_eq!(telemetry.rsync_version, "unknown");
        assert_eq!(telemetry.node_version, "unknown");
        assert_eq!(telemetry.root_on_synced_folder, "unknown");
    }

    #[test]
    fn rescue_version_probe_accepts_bare_node_version_output() {
        assert_eq!(
            core_update_tool_version("v22.17.0\n", "node", "node_version"),
            "unknown"
        );
        assert_eq!(
            core_update_probe_version("v22.17.0\n", "node", "node_version"),
            "22.17.0"
        );
    }

    #[test]
    fn rescue_telemetry_keeps_the_latest_unknown_stage_unknown() {
        let telemetry = CoreUpdateRescueTelemetry::from_raw(
            "==> Cloning source\n==> Preparing retry\nfatal: clone failed\n",
            1,
        );

        assert_eq!(telemetry.rescue_step, "unknown");
    }

    #[test]
    fn rescue_telemetry_classifies_each_supported_error_class() {
        for (raw, expected_step, expected_class) in [
            ("==> Cloning\nerror: clone failed", "clone", "clone_failed"),
            (
                "==> Checkout\nerror: clone succeeded, but checkout failed",
                "checkout",
                "checkout_failed",
            ),
            (
                "==> Rsync\nrsync preflight failed: missing binary",
                "rsync",
                "rsync_missing",
            ),
            (
                "==> Rsync\nrsync preflight failed: ENOSPC",
                "rsync",
                "enospc",
            ),
            (
                "==> Rsync\nrsync preflight failed: EACCES",
                "rsync",
                "eacces",
            ),
            (
                "==> Rsync\nrsync preflight failed: timed out",
                "rsync",
                "timeout",
            ),
            ("==> npm install\nnpm ERR! code ENOENT", "npm-install", "npm_enoent"),
            (
                "rsync version 3.2.7 protocol version 31\nnpm ERR! code EACCES",
                "npm-install",
                "eacces",
            ),
            ("rsync version 3.2.7 protocol version 31", "unknown", "unknown"),
            ("error: EACCES", "unknown", "eacces"),
            ("error: ENOSPC", "unknown", "enospc"),
            ("fatal: Could not resolve host", "unknown", "dns"),
            ("fatal: SSL certificate problem", "unknown", "tls"),
            ("fatal: operation timed out", "unknown", "timeout"),
        ] {
            let telemetry = CoreUpdateRescueTelemetry::from_raw(raw, 1);
            assert_eq!(telemetry.rescue_step, expected_step, "raw={raw:?}");
            assert_eq!(telemetry.rescue_error_class, expected_class, "raw={raw:?}");
        }
    }

    #[test]
    fn rescue_telemetry_does_not_classify_a_user_path_as_an_error() {
        let telemetry = CoreUpdateRescueTelemetry::from_raw(
            "==> Verifying\ncreated /tmp/error: clone failed.txt\n",
            1,
        );

        assert_eq!(telemetry.rescue_error_class, "unknown");
        assert_eq!(telemetry.rescue_step, "verify");

        let marker_telemetry = CoreUpdateRescueTelemetry::from_raw(
            "==> Verify /Users/ada/T2026-09-22T17:00:00Z\n",
            1,
        );
        assert!(marker_telemetry
            .stage_markers
            .iter()
            .all(|marker| !marker.contains("/Users/ada")));
    }

    #[test]
    fn rescue_telemetry_real_output_shapes_populate_diagnostic_dimensions() {
        let fixtures = [
            (
                concat!(
                    "==> HQ root:    C:\\Users\\alice\\HQ\r\n",
                    "==> Mode:       preserve-list (default)\r\n",
                    "error: insufficient free space for safety snapshot (need 32 GiB, have 3 GiB).\r\n",
                    "rsync preflight failed before any safety snapshot was allocated.\r\n",
                    "       rsync exited with status 1.\r\n",
                    "       rsync found at: C:\\Users\\alice\\AppData\\Local\\IndigoHQ\\toolchain\\npm-prefix\\rsync.exe\r\n",
                    "git version 2.44.0.windows.1\r\n",
                    "rsync version 3.2.7 protocol version 31\r\n",
                    "node_version=22.17.0\r\n",
                    "HQ_RESCUE_FAILURE_KIND=rsync-found-but-broken\r\n",
                ),
                RescueFailureCategory::RsyncBroken,
                "rsync",
                "rsync_failed",
                "1-5G",
                "2.44.0.windows.1",
            ),
            (
                concat!(
                    "==> HQ root:    C:\\Users\\alice\\HQ\r\n",
                    "==> Mode:       preserve-list (default)\r\n",
                    "==> Overlaying source onto HQ root ...\r\n",
                    "rsync status 23 during overlay\r\n",
                    "HQ_RESCUE_FAILURE_KIND=rsync-partial\r\n",
                    "free space check: need 32 GiB, have 8 GiB\r\n",
                    "git version 2.44.0.windows.1\r\n",
                    "rsync version 3.2.7 protocol version 31\r\n",
                    "node_version=22.17.0\r\n",
                ),
                RescueFailureCategory::RsyncPartialTransfer,
                "rsync",
                "rsync_partial",
                "5-20G",
                "2.44.0.windows.1",
            ),
            (
                concat!(
                    "==> HQ root:    /Users/alice/HQ\n",
                    "==> Mode:       preserve-list (default)\n",
                    "npx failed to resolve hq-rescue\n",
                    "error: npx could not be spawned\n",
                    "free disk: 24 GiB\n",
                    "git version 2.44.0\n",
                    "rsync version 3.2.7 protocol version 31\n",
                    "node_version=22.17.0\n",
                ),
                RescueFailureCategory::NpxResolveFailed,
                "npm-install",
                "npx_resolve_failed",
                ">20G",
                "2.44.0",
            ),
        ];

        for (
            raw,
            category,
            expected_step,
            expected_error_class,
            expected_disk,
            expected_git_version,
        ) in fixtures
        {
            let telemetry = CoreUpdateRescueTelemetry::from_raw(raw, 1);
            assert_eq!(telemetry.rescue_step, expected_step, "raw={raw:?}");
            assert_eq!(telemetry.git_version, expected_git_version, "raw={raw:?}");
            assert_eq!(telemetry.rsync_version, "3.2.7", "raw={raw:?}");
            assert_eq!(telemetry.node_version, "22.17.0", "raw={raw:?}");
            assert_eq!(telemetry.disk_free_bucket, expected_disk, "raw={raw:?}");

            let report = core_update_sentry_failure_report(
                "automatic",
                Channel::Release,
                Some(1),
                "rescue_exit",
                CoreUpdateFailureDetails {
                    rescue_stderr_tail: Some(raw),
                    rescue_telemetry: Some(&telemetry),
                    rescue_failure_category: category,
                    npx_resolution: None,
                    managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
                },
            );
            assert_eq!(
                report.rescue_telemetry.rescue_error_class, expected_error_class,
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn rescue_category_fills_missing_telemetry_dimensions() {
        let telemetry = CoreUpdateRescueTelemetry::from_raw("==> Mode: preserve-list\n", 1);
        let report = core_update_sentry_failure_report(
            "automatic",
            Channel::Release,
            Some(1),
            "rescue_exit",
            CoreUpdateFailureDetails {
                rescue_stderr_tail: None,
                rescue_telemetry: Some(&telemetry),
                rescue_failure_category: RescueFailureCategory::RsyncBroken,
                npx_resolution: None,
                managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
            },
        );

        assert_eq!(report.rescue_telemetry.rescue_step, "rsync");
        assert_eq!(report.rescue_telemetry.rescue_error_class, "rsync_failed");
    }

    #[test]
    fn core_update_fingerprint_ignores_lock_and_failure_category_details() {
        let report = report_for_core_update_error(&CoreUpdateError::new(
            CoreUpdateErrorKind::RescueSpawn,
            "HQ Sync could not coordinate npm cache preparation: The process cannot access the file because another process has locked a portion of the file. (os error 33)",
        ));

        assert_eq!(report.error_category, RescueFailureCategory::LockContention);
        assert_eq!(
            core_update_sentry_fingerprint(report.error_kind, report.error_category),
            ["desktop-core-update-failed"]
        );
        assert_eq!(
            core_update_sentry_fingerprint(
                "rescue_spawn",
                RescueFailureCategory::MissingDependency,
            ),
            ["desktop-core-update-failed"]
        );
    }

    #[test]
    fn sentry_rate_limits_each_rescue_step_and_error_class() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        let report = |error_kind: &'static str,
                      error_category: RescueFailureCategory,
                      exit_code: Option<i32>| CoreUpdateSentryFailureReport {
            source: "automatic",
            channel: Channel::Release,
            exit_code,
            error_kind,
            error_category,
            rescue_stderr_tail: Some(hq_telemetry::redact_core_update_diagnostic_tail(
                "fatal: could not clone Core source",
            )),
            rescue_telemetry: CoreUpdateRescueTelemetry {
                rescue_step: match error_kind {
                    "rescue_exit" => "clone",
                    "network" => "checkout",
                    _ => "npm-install",
                },
                rescue_error_class: match error_kind {
                    "rescue_exit" => "clone_failed",
                    "network" => "dns",
                    _ => "eacces",
                },
                stage_markers: vec!["marker|clone".to_string()],
                ..Default::default()
            },
            npx_resolution: Some(CoreUpdateNpxResolution {
                resolved: true,
                source: "managed_toolchain",
            }),
            // This fixture models a directly reported failure, before any
            // managed-Git retry can have been attempted.
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
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
                report_core_update_failure_once(report(
                    "rescue_spawn",
                    RescueFailureCategory::LockContention,
                    None,
                ));
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );

        assert_eq!(events.len(), 3, "identical rescue dimensions must rate-limit");
        assert_eq!(events[0].fingerprint, vec!["desktop-core-update-failed"]);
        assert_eq!(events[1].fingerprint, vec!["desktop-core-update-failed"]);
        assert_eq!(events[2].fingerprint, vec!["desktop-core-update-failed"]);
        assert_eq!(events[0].tags["errorKind"], "rescue_exit");
        assert_eq!(events[0].tags["errorCategory"], "unknown");
        assert_eq!(events[0].tags["channel"], "release");
        assert_eq!(events[0].tags["platform"], core_update_sentry_platform());
        assert_eq!(events[0].tags["source"], "automatic");
        assert_eq!(events[0].tags["exitCode"], "5");
        assert_eq!(events[1].tags["exitCode"], "not_available");
        assert_eq!(events[2].tags["errorCategory"], "lock-contention");
        assert_eq!(events[2].tags["exitCode"], "not_available");
        assert_eq!(events[0].tags["rescue_step"], "clone");
        assert_eq!(events[0].tags["rescue_error_class"], "clone_failed");
        assert_eq!(events[0].tags["suppressed_since_last"], "0");
        assert!(events[0].breadcrumbs.values.iter().any(|breadcrumb| {
            breadcrumb.category.as_deref() == Some("core-update")
                && breadcrumb.message.as_deref() == Some("clone")
        }));
        assert_eq!(
            events[0].extra["rescueStderrTail"],
            sentry::protocol::Value::String("fatal: could not clone Core source".to_string())
        );
    }

    #[test]
    fn unclassified_pre_rescue_failures_keep_distinct_rate_keys() {
        let telemetry = CoreUpdateRescueTelemetry::default();
        let report = |error_kind: &'static str, error_category| CoreUpdateSentryFailureReport {
            source: "automatic",
            channel: Channel::Release,
            exit_code: None,
            error_kind,
            error_category,
            rescue_stderr_tail: None,
            rescue_telemetry: telemetry.clone(),
            npx_resolution: None,
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
        };

        let first = report("rescue_spawn", RescueFailureCategory::MissingDependency);
        let second = report("network", RescueFailureCategory::Network);
        let same = report("rescue_spawn", RescueFailureCategory::MissingDependency);

        assert_ne!(
            core_update_sentry_rate_key(&first),
            core_update_sentry_rate_key(&second)
        );
        assert_eq!(
            core_update_sentry_rate_key(&first),
            core_update_sentry_rate_key(&same)
        );
    }

    #[test]
    fn sentry_rate_limit_reports_suppressed_count_after_window() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        let telemetry = CoreUpdateRescueTelemetry {
            rescue_step: "clone",
            rescue_error_class: "clone_failed",
            ..Default::default()
        };
        let report = || CoreUpdateSentryFailureReport {
            source: "automatic",
            channel: Channel::Release,
            exit_code: Some(5),
            error_kind: "rescue_exit",
            error_category: RescueFailureCategory::Unknown,
            rescue_stderr_tail: None,
            rescue_telemetry: telemetry.clone(),
            npx_resolution: None,
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
        };
        let start = Instant::now();
        let events = sentry::test::with_captured_events_options(
            || {
                report_core_update_failure_at(report(), start);
                report_core_update_failure_at(report(), start + Duration::from_secs(1));
                report_core_update_failure_at(
                    report(),
                    start + CORE_UPDATE_SENTRY_RATE_LIMIT + Duration::from_secs(1),
                );
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tags["suppressed_since_last"], "0");
        assert_eq!(events[1].tags["suppressed_since_last"], "1");
    }

    #[test]
    fn baseline_persistence_failure_is_a_redacted_warning_with_its_own_fingerprint() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_baseline_warning_signatures_for_test();
        let detail = "core update applied but baseline persistence failed: commits/main HTTP 403 Forbidden at /home/alice/.hq; token ghp_abcdefghijklmnop";
        let report =
            core_update_baseline_persistence_warning_report("automatic", Channel::Release, detail);
        let events = sentry::test::with_captured_events_options(
            || {
                report_core_update_baseline_persistence_warning_once(report.clone());
                report_core_update_baseline_persistence_warning_once(report);
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );

        assert_eq!(
            events.len(),
            1,
            "identical degraded writes dedupe in-process"
        );
        let event = hq_telemetry::before_send(events.into_iter().next().unwrap()).unwrap();
        assert_eq!(event.level, sentry::Level::Warning);
        assert_eq!(
            event.message.as_deref(),
            Some("Desktop Core update applied but baseline persistence failed")
        );
        assert_eq!(
            event.fingerprint,
            vec!["desktop-core-update-baseline-persistence-failed"],
            "baseline warnings must not merge with Core-update-failed issues"
        );
        assert_eq!(event.tags["operation"], "baseline_persistence");
        assert_eq!(event.tags["persistence_write_path"], "unknown");
        assert_eq!(event.tags["persistence_error_kind"], "unknown");
        assert_eq!(event.tags["persistence_directory_state"], "unknown");
        assert_eq!(event.tags["persistence_target_state"], "unknown");
        assert_eq!(event.tags["persistence_temp_state"], "unknown");
        assert_eq!(event.tags["persistence_permission_state"], "unknown");
        assert_eq!(event.tags["persistence_disk_state"], "unknown");
        assert_eq!(event.tags["persistence_concurrent_writer"], "unknown");
        assert_eq!(event.tags["channel"], "release");
        assert_eq!(event.tags["source"], "automatic");
        let redacted = event.extra["baselinePersistenceDetail"]
            .as_str()
            .expect("warning retains a redacted diagnostic");
        assert!(redacted.contains("HTTP 403 Forbidden"));
        assert!(!redacted.contains("/home/alice"));
        assert!(!redacted.contains("ghp_abcdefghijklmnop"));
    }

    #[test]
    fn baseline_persistence_warning_emits_bounded_write_diagnostics() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_baseline_warning_signatures_for_test();
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("core/workspace/core-drift-baselines");
        std::fs::create_dir_all(directory.parent().unwrap()).unwrap();
        std::fs::write(&directory, b"block baseline directory creation").unwrap();
        let error = hq_desktop_core::drift_scope::persist_core_drift_baseline(
            temp.path(),
            "indigoai-us/hq-core",
            "0123456789abcdef",
            std::collections::BTreeMap::new(),
        )
        .unwrap_err();
        let detail = format!("core update applied but baseline persistence failed: {error}");
        let report =
            core_update_baseline_persistence_warning_report("automatic", Channel::Release, &detail);
        let events = sentry::test::with_captured_events_options(
            || send_core_update_baseline_persistence_warning(report),
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );
        let event = hq_telemetry::before_send(events.into_iter().next().unwrap()).unwrap();

        assert_eq!(event.level, sentry::Level::Warning);
        assert_eq!(event.tags["persistence_write_path"], "create_directory");
        assert!(matches!(
            event.tags["persistence_error_kind"].as_str(),
            "already_exists" | "other"
        ));
        assert_eq!(event.tags["persistence_directory_state"], "file");
        assert!(matches!(
            event.tags["persistence_target_state"].as_str(),
            "missing" | "unknown"
        ));
        assert!(matches!(
            event.tags["persistence_temp_state"].as_str(),
            "missing" | "unknown"
        ));
        assert_eq!(event.tags["persistence_permission_state"], "not_denied");
        assert_eq!(event.tags["persistence_disk_state"], "not_storage_full");
        assert_eq!(event.tags["persistence_concurrent_writer"], "no_evidence");
        assert!(!event
            .tags
            .values()
            .any(|value| value.contains(temp.path().to_str().unwrap())));
        let redacted = event.extra["baselinePersistenceDetail"]
            .as_str()
            .expect("warning retains a redacted diagnostic");
        assert!(!redacted.contains(temp.path().to_str().unwrap()));
    }

    #[test]
    fn baseline_persistence_warnings_deduplicate_by_diagnostic_identity() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_baseline_warning_signatures_for_test();
        let report_for = |write_path| {
            let detail = format!(
                "core update applied but baseline persistence failed: I/O failure [baseline_persistence_diagnostics write_path={write_path} error_kind=other directory_state=directory target_state=missing temp_state=missing permission_state=not_denied disk_state=not_storage_full concurrent_writer=no_evidence]"
            );
            core_update_baseline_persistence_warning_report("automatic", Channel::Release, &detail)
        };
        let first = report_for("write_temp");
        let duplicate = report_for("write_temp");
        let distinct = report_for("rename_temp");
        assert_eq!(first.error_category, distinct.error_category);

        let events = sentry::test::with_captured_events_options(
            || {
                report_core_update_baseline_persistence_warning_once(first);
                report_core_update_baseline_persistence_warning_once(duplicate);
                report_core_update_baseline_persistence_warning_once(distinct);
            },
            sentry::ClientOptions {
                before_send: Some(std::sync::Arc::new(hq_telemetry::before_send)),
                ..Default::default()
            },
        );
        assert_eq!(events.len(), 2);
        let events = events
            .into_iter()
            .map(|event| hq_telemetry::before_send(event).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events[0].tags["persistence_write_path"], "write_temp");
        assert_eq!(events[1].tags["persistence_write_path"], "rename_temp");
    }

    #[test]
    fn baseline_persistence_failure_is_recorded_in_the_local_diagnostic_log() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_baseline_warning_signatures_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("hq-sync.log");
        let _log_guard = hq_desktop_core::logfile::LogOverrideGuard::new(path.clone());
        let detail =
            "core update applied but baseline persistence failed: commits/main HTTP 403 Forbidden";

        let events = captured_dispatched_core_update_events(
            &["Desktop Core update applied but baseline persistence failed"],
            || {
                record_core_update_baseline_persistence_failure(
                    "manual",
                    Channel::Release,
                    "hq-core-update",
                    detail,
                );
            },
        );

        let contents = std::fs::read_to_string(path).unwrap();
        assert!(contents.contains("[hq-core-update]"));
        assert!(contents.contains(detail));
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].message.as_deref(),
            Some("Desktop Core update applied but baseline persistence failed")
        );
    }

    #[test]
    fn applied_rescue_baseline_uses_prior_floor_paths_and_the_new_local_stamp() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let menubar_path = temp.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        let source = "indigoai-us/hq-core";
        let old_commit = "0".repeat(40);
        let new_commit = "1".repeat(40);
        let tracked_path = "core/policies/example.md";
        let tracked_file = root.join(tracked_path);
        std::fs::create_dir_all(tracked_file.parent().unwrap()).unwrap();
        std::fs::write(&tracked_file, b"old\n").unwrap();
        std::fs::write(
            root.join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {old_commit}\n"
            ),
        )
        .unwrap();

        let mut old_blobs = BTreeMap::new();
        old_blobs.insert(
            tracked_path.to_string(),
            hq_desktop_core::drift_scope::drift_blob_sha(b"old\n"),
        );
        hq_desktop_core::drift_scope::persist_core_drift_baseline(
            root,
            source,
            &old_commit,
            old_blobs,
        )
        .unwrap();
        let previous_paths = core_drift_baseline_paths_before_rescue(root, source);
        assert!(previous_paths.contains(tracked_path));

        // Simulate the successful rescue overlay and its stamp. The new file
        // represents an upstream addition; the local-only file represents a
        // path rescue left in place outside the upstream tree.
        std::fs::write(&tracked_file, b"new upstream content\n").unwrap();
        std::fs::write(root.join("core/policies/added-by-update.md"), b"new\n").unwrap();
        std::fs::write(root.join("core/policies/local-only.md"), b"mine\n").unwrap();
        std::fs::write(
            root.join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {new_commit}\n"
            ),
        )
        .unwrap();

        let persisted = persist_applied_rescue_baseline_from_tree_with_path(
            root,
            Some(&previous_paths),
            "",
            Channel::Release,
            Some(&menubar_path),
            Err("HTTP 403".to_string()),
        )
        .unwrap();
        assert_eq!(persisted.commit, new_commit);
        let baseline =
            hq_desktop_core::drift_scope::load_core_drift_baseline(root, source, &new_commit)
                .unwrap();
        assert_eq!(
            baseline.normalized_blobs.get(tracked_path),
            Some(&hq_desktop_core::drift_scope::drift_blob_sha(
                b"new upstream content\n"
            ))
        );
        assert!(!baseline
            .normalized_blobs
            .contains_key("core/policies/added-by-update.md"));
        assert!(!baseline
            .normalized_blobs
            .contains_key("core/policies/local-only.md"));
    }

    #[test]
    fn applied_rescue_baseline_excludes_paths_the_rescue_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let menubar_path = temp.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        let source = "indigoai-us/hq-core";
        let new_commit = "4".repeat(40);
        let kept = "core/policies/kept.md";
        let skipped = "core/policies/skipped.md";
        std::fs::create_dir_all(root.join("core/policies")).unwrap();
        std::fs::write(root.join(kept), b"new kept\n").unwrap();
        std::fs::write(root.join(skipped), b"old skipped\n").unwrap();
        std::fs::write(
            root.join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {new_commit}\n"
            ),
        )
        .unwrap();
        let previous_paths = [kept.to_string(), skipped.to_string()]
            .into_iter()
            .collect::<BTreeSet<_>>();

        let output = format!(
            "HQ_RESCUE_SKIPPED_KIND=snapshot-copy-failed\nHQ_RESCUE_SNAPSHOT_COPY_CODE=EACCES\nwarning: snapshot skipped {}. It was not backed up and was left untouched. The update continued.",
            root.join(skipped).display()
        );
        persist_applied_rescue_baseline_from_tree_with_path(
            root,
            Some(&previous_paths),
            &output,
            Channel::Release,
            Some(&menubar_path),
            Err("HTTP 403".to_string()),
        )
        .unwrap();

        let baseline =
            hq_desktop_core::drift_scope::load_core_drift_baseline(root, source, &new_commit)
                .unwrap();
        assert!(baseline.normalized_blobs.contains_key(kept));
        assert!(!baseline.normalized_blobs.contains_key(skipped));
    }

    #[tokio::test]
    async fn applied_rescue_baseline_uses_the_stamped_commit_tree_when_fetch_succeeds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let menubar_path = temp.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        let source = "indigoai-us/hq-core";
        let commit = "5".repeat(40);
        std::fs::create_dir_all(root.join("core/policies")).unwrap();
        std::fs::write(root.join("core/policies/local.md"), b"local\n").unwrap();
        std::fs::write(
            root.join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {commit}\n"
            ),
        )
        .unwrap();
        let mut remote = BTreeMap::new();
        remote.insert(
            "core/policies/release.md".to_string(),
            ("github-release-blob".to_string(), 20),
        );
        let expected_commit = commit.clone();

        let result = persist_applied_rescue_baseline_with_fetcher_and_path(
            root,
            None,
            "",
            Channel::Release,
            Some("github-token"),
            Some(&menubar_path),
            move |fetched_source, fetched_commit, token| async move {
                assert_eq!(fetched_source, source);
                assert_eq!(fetched_commit, expected_commit);
                assert_eq!(token.as_deref(), Some("github-token"));
                Ok(remote)
            },
        )
        .await
        .unwrap();

        assert_eq!(result.commit, commit);
        assert!(result.baseline_persisted);
        assert!(!result.refresh_pending);
        let baseline =
            hq_desktop_core::drift_scope::load_core_drift_baseline(root, source, &commit)
                .unwrap();
        assert_eq!(
            baseline.normalized_blobs,
            BTreeMap::from([(
                "core/policies/release.md".to_string(),
                "github-release-blob".to_string()
            )])
        );
    }

    #[test]
    fn applied_rescue_baseline_succeeds_with_no_prior_floor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let menubar_path = temp.path().join("menubar.json");
        std::fs::write(&menubar_path, "{}").unwrap();
        let source = "indigoai-us/hq-core";
        let commit = "2".repeat(40);
        std::fs::create_dir_all(root.join("core/policies")).unwrap();
        std::fs::write(root.join("core/policies/example.md"), b"new\n").unwrap();
        std::fs::write(root.join("core/policies/local-only.md"), b"mine\n").unwrap();
        std::fs::write(
            root.join("core/core.yaml"),
            format!(
                "rules:\n  locked:\n    - core/policies/\nreplaced_from_source:\n  source: {source}\n  last_sync_sha: {commit}\n"
            ),
        )
        .unwrap();

        let previous_paths = core_drift_baseline_before_rescue(root, source);
        assert!(previous_paths.is_none());
        let persisted = persist_applied_rescue_baseline_from_tree_with_path(
            root,
            previous_paths.as_ref(),
            "",
            Channel::Release,
            Some(&menubar_path),
            Err("HTTP 403".to_string()),
        )
        .unwrap();

        assert!(!persisted.baseline_persisted);
        assert!(persisted.refresh_pending);
        assert!(
            hq_desktop_core::drift_scope::load_core_drift_baseline(root, source, &commit)
                .is_none()
        );
    }

    fn sentry_user_tokens(id_token: Option<String>) -> crate::commands::cognito::CognitoTokens {
        crate::commands::cognito::CognitoTokens {
            access_token: "access-token".to_string(),
            id_token,
            refresh_token: "refresh-token".to_string(),
            expires_at: i64::MAX,
        }
    }

    fn sentry_user_id_token() -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "sub": "cognito-sub-ada",
                "email": "ada@getindigo.ai",
                "name": "Ada Lovelace",
            }))
            .expect("Sentry test claims serialize"),
        );
        format!("header.{payload}.signature")
    }

    fn core_update_sentry_test_details() -> CoreUpdateFailureDetails<'static> {
        CoreUpdateFailureDetails {
            rescue_stderr_tail: None,
            rescue_telemetry: None,
            rescue_failure_category: RescueFailureCategory::Permission,
            npx_resolution: None,
            managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
        }
    }

    fn queue_core_update_sentry_test_report() {
        queue_core_update_failure_report(
            "automatic",
            Channel::Release,
            None,
            "rescue_spawn",
            core_update_sentry_test_details(),
        );
    }

    fn is_core_update_sentry_event(event: &sentry::protocol::Event<'static>) -> bool {
        matches!(
            event.message.as_deref(),
            Some(
                "Desktop Core update failed"
                    | "Desktop Core update applied but baseline persistence failed"
            )
        )
    }

    fn queue_core_update_sentry_retry_test_report() {
        queue_core_update_failure_report(
            "automatic",
            Channel::Release,
            Some(5),
            "rescue_exit",
            CoreUpdateFailureDetails {
                rescue_stderr_tail: Some("error: clone failed"),
                rescue_telemetry: None,
                rescue_failure_category: RescueFailureCategory::MissingDependency,
                npx_resolution: None,
                managed_git_retry: ManagedGitRetryOutcome::Failed,
            },
        );
    }

    /// Collects envelopes like `sentry::test::TestTransport`, but also exposes a
    /// NON-draining count so a waiter can observe delivery.
    ///
    /// The count has to be taken here, at the transport, rather than in a
    /// `before_send` hook. `Client::capture_event` calls `before_send` (inside
    /// `prepare_event`) and only afterwards builds the envelope and calls
    /// `transport.send_envelope`. A waiter counting in `before_send` can
    /// therefore see the full expected count while the last envelope has not
    /// reached the collected list yet — it then stops waiting, the hub unwinds,
    /// and the snapshot comes back one event short. That is a real race, and it
    /// failed CI on an unrelated pull request.
    #[derive(Default)]
    struct CountingTestTransport {
        collected: Mutex<Vec<sentry::Envelope>>,
    }

    impl CountingTestTransport {
        /// Number of collected envelopes whose event message is one we asked for.
        fn matching(&self, expected_messages: &[&'static str]) -> usize {
            self.collected
                .lock()
                .unwrap()
                .iter()
                .filter_map(|envelope| envelope.event())
                .filter(|event| {
                    expected_messages
                        .iter()
                        .any(|expected| *expected == event.message.as_deref().unwrap_or_default())
                })
                .count()
        }

        fn take_events(&self) -> Vec<sentry::protocol::Event<'static>> {
            std::mem::take(&mut *self.collected.lock().unwrap())
                .into_iter()
                .filter_map(|envelope| envelope.event().cloned())
                .collect()
        }
    }

    impl sentry::Transport for CountingTestTransport {
        fn send_envelope(&self, envelope: sentry::Envelope) {
            self.collected.lock().unwrap().push(envelope);
        }
    }

    fn captured_dispatched_core_update_events(
        expected_messages: &[&'static str],
        report: impl FnOnce(),
    ) -> Vec<sentry::protocol::Event<'static>> {
        let expected_count = expected_messages.len();
        let transport = Arc::new(CountingTestTransport::default());
        let options = sentry::ClientOptions {
            dsn: Some(
                "https://public@sentry.invalid/1"
                    .parse()
                    .expect("the test DSN parses"),
            ),
            transport: Some(Arc::new(transport.clone())),
            ..Default::default()
        };
        let client: Arc<sentry::Client> = Arc::new(options.into());

        let hub = Arc::new(sentry::Hub::new(
            Some(Arc::clone(&client)),
            Arc::new(Default::default()),
        ));
        sentry::Hub::run(hub, || {
            let main_hub = sentry::Hub::main();
            // The test transport is installed on this test's temporary hub.
            // Production initialization binds the client to the process hub, so
            // mirror that setup before exercising cross-thread reporting.
            main_hub.bind_client(Some(Arc::clone(&client)));
            report();

            // Wait on the TRANSPORT, so the loop cannot finish before the
            // envelopes it is waiting for have actually been collected. Count
            // only the messages this test asked for: another Core report can be
            // in flight from a neighbouring test.
            let deadline = Instant::now() + Duration::from_secs(5);
            while transport.matching(expected_messages) < expected_count
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                transport.matching(expected_messages),
                expected_count,
                "each requested Core update report must reach the Sentry transport"
            );

            main_hub.configure_scope(|scope| scope.set_user(None));
            main_hub.bind_client(None);
        });

        transport
            .take_events()
            .into_iter()
            .filter(is_core_update_sentry_event)
            .collect()
    }

    #[test]
    fn dispatched_core_update_report_carries_user_bound_on_an_auth_thread() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        let tokens = sentry_user_tokens(Some(sentry_user_id_token()));
        let events =
            captured_dispatched_core_update_events(&["Desktop Core update failed"], || {
                std::thread::spawn(move || {
                    crate::commands::auth::set_sentry_user_from_tokens(&tokens);
                })
                .join()
                .expect("auth thread does not panic");
                queue_core_update_sentry_test_report();
            });

        assert_eq!(events.len(), 1);
        let user = events[0]
            .user
            .as_ref()
            .expect("Core update event carries the signed-in user");
        assert_eq!(user.id.as_deref(), Some("cognito-sub-ada"));
        assert_eq!(user.email.as_deref(), Some("ada@getindigo.ai"));
        assert_eq!(user.username.as_deref(), Some("Ada Lovelace"));
    }

    #[test]
    fn sign_out_clears_the_user_for_dispatched_core_update_reports() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        reset_core_update_baseline_warning_signatures_for_test();
        let tokens = sentry_user_tokens(Some(sentry_user_id_token()));
        let events = captured_dispatched_core_update_events(
            &[
                "Desktop Core update failed",
                "Desktop Core update applied but baseline persistence failed",
            ],
            || {
                std::thread::spawn(move || {
                    crate::commands::auth::set_sentry_user_from_tokens(&tokens);
                })
                .join()
                .expect("auth thread does not panic");
                std::thread::spawn(crate::commands::auth::clear_sentry_user)
                    .join()
                    .expect("sign-out thread does not panic");
                queue_core_update_sentry_test_report();
                queue_core_update_baseline_persistence_warning(
                    "automatic",
                    Channel::Release,
                    "core update applied but baseline persistence failed: commits/main HTTP 403 Forbidden",
                );
            },
        );

        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .any(|event| event.message.as_deref() == Some("Desktop Core update failed")),
            "the ordinary Core update failure report is dispatched after sign-out"
        );
        assert!(
            events.iter().any(|event| {
                event.message.as_deref()
                    == Some("Desktop Core update applied but baseline persistence failed")
            }),
            "the baseline-persistence warning is dispatched after sign-out"
        );
        assert!(
            events.iter().all(|event| event.user.is_none()),
            "Core update reports after sign-out must not identify the previous user"
        );
    }

    #[test]
    fn dispatched_core_update_report_names_a_failed_managed_git_retry() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();
        reset_core_update_sentry_signatures_for_test();
        let events = captured_dispatched_core_update_events(
            &["Desktop Core update failed"],
            queue_core_update_sentry_retry_test_report,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags["managedGitRetryOutcome"], "failed");
        assert_eq!(
            events[0].extra["managedGitRetryAttempted"],
            sentry::protocol::Value::Bool(true)
        );
    }

    #[test]
    fn malformed_or_missing_id_token_still_clears_the_sentry_user() {
        let _test_lock = CORE_UPDATE_SENTRY_TEST_LOCK.lock().unwrap();

        for id_token in [None, Some("not-a-jwt".to_string())] {
            reset_core_update_sentry_signatures_for_test();
            let signed_in_tokens = sentry_user_tokens(Some(sentry_user_id_token()));
            let malformed_tokens = sentry_user_tokens(id_token);
            let events =
                captured_dispatched_core_update_events(&["Desktop Core update failed"], || {
                    std::thread::spawn(move || {
                        crate::commands::auth::set_sentry_user_from_tokens(&signed_in_tokens);
                    })
                    .join()
                    .expect("auth thread does not panic");
                    std::thread::spawn(move || {
                        crate::commands::auth::set_sentry_user_from_tokens(&malformed_tokens);
                    })
                    .join()
                    .expect("malformed-token auth thread does not panic");
                    queue_core_update_sentry_test_report();
                });

            assert_eq!(events.len(), 1);
            assert!(
                events[0].user.is_none(),
                "missing or malformed id tokens must clear the Sentry user"
            );
        }
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
                rescue_telemetry: None,
                rescue_failure_category: RescueFailureCategory::Unknown,
                npx_resolution: Some(npx_resolution),
                managed_git_retry: ManagedGitRetryOutcome::NotNeeded,
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
