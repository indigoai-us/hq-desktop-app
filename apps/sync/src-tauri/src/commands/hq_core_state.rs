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

use std::collections::{BTreeMap, BTreeSet, HashSet};
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
static AUTO_ATTEMPTED_TARGETS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Channel the user is tracking. Drives target selection + the action-pill
/// label. Carries the resolving repo + ref so the frontend can render
/// "Update to v14.2.0" vs "Update to Staging" without re-parsing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
}

impl CoreUpdateError {
    pub(crate) fn new(kind: CoreUpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) const fn kind(&self) -> CoreUpdateErrorKind {
        self.kind
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

fn mark_automatic_target_attempted(channel: Channel, target: &str) -> bool {
    let key = format!("{}:{target}", channel_label(channel));
    AUTO_ATTEMPTED_TARGETS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key)
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
    crate::commands::telemetry::emit_desktop_telemetry_best_effort(
        event_name,
        Value::Object(properties),
    );
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
            if !mark_automatic_target_attempted(candidate.channel, candidate.target_version) {
                log(
                    "hq-core-update",
                    "native auto-update skipped: target already attempted this session",
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
                    log("hq-core-update", "native auto-update succeeded");
                    NativeCoreAutoUpdateOutcome::Succeeded
                }
                Ok(exit_code) => {
                    log(
                        "hq-core-update",
                        &format!("native auto-update failed: rescue_exit={exit_code}"),
                    );
                    NativeCoreAutoUpdateOutcome::FailedExit(exit_code)
                }
                Err(error) => {
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
    use std::sync::Arc;

    static CORE_UPDATE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn core_update_run_guard_serializes_and_releases_the_update_slot() {
        let _test_lock = CORE_UPDATE_TEST_LOCK.lock().await;
        let first = try_begin_core_update().expect("first update owns the slot");
        assert!(try_begin_core_update().is_err());
        drop(first);

        let retry = try_begin_core_update().expect("dropping the guard releases the slot");
        drop(retry);
    }

    #[test]
    fn automatic_target_deduplication_is_scoped_to_the_channel() {
        let target = "15.0.117-deduplication-contract";

        assert!(mark_automatic_target_attempted(Channel::Release, target));
        assert!(!mark_automatic_target_attempted(Channel::Release, target));
        assert!(mark_automatic_target_attempted(Channel::Staging, target));
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
