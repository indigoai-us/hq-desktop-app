//! Core-files drift check.
//!
//! Tells the user "your local hq-core files differ from what your installed
//! `hqVersion` shipped." Surfaces as a small `N drifted` pill on the HQ-
//! version footer row of the popover; clicking opens a detail window
//! (see `drift_detail.rs`) listing the modified / missing / added files
//! with per-row actions.
//!
//! Family alignment with the other two notifiers:
//!   * `updater.rs`            → menubar self-update
//!   * `hq_cli_update.rs`      → `@indigoai-us/hq-cli` npm nag
//!   * `hq_core_update.rs`     → "new hq-core release" nag (version-only)
//!   * `hq_core_drift.rs`      → this — file-content drift vs the version
//!                                the user is *currently* on (orthogonal to
//!                                the update nag: drift is "what changed
//!                                under you" vs. update is "what's newer
//!                                upstream").
//!
//! Source of truth for "upstream content":
//!   `GET https://api.github.com/repos/indigoai-us/hq-core/git/trees/v{hqVersion}?recursive=1`
//! returns the entire tree as one JSON, each blob carrying its git SHA-1
//! (`sha1("blob {len}\0{content}")`). We compute the same hash locally
//! for each file under the locked paths and compare — no content download
//! is needed unless the user later clicks Restore.
//!
//! Why git-trees instead of the tarball: one API call, no archive parsing,
//! no transitive crate weight (only +`sha1`). Locked-paths scope is
//! ~9 entries / few hundred files, well under the 7000-entry tree cap.
//!
//! Cadence: first check 30s after launch (offset from updater 10s / CLI
//! 15s / core-update 20s so we don't spike the loop), then every 6h.
//!
//! Scope: `rules.locked` from the user's local `core.yaml`. Reviewable
//! and auto-generated paths (`core/workers/registry.yaml`, `workspace/`,
//! `.claude/skills/`) are intentionally excluded — they're expected to
//! diverge.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub use hq_desktop_core::drift_scope::{
    excluded_scope_paths, git_blob_sha, is_conflict_artifact, path_in_excluded_scope,
    path_in_locked_scope, read_locked_paths, walk_local_under_scope,
};
use serde::{Deserialize, Serialize};

use crate::commands::config::{read_hq_config_lenient, MenubarPrefs};
use crate::commands::hq_core_staging::StagingStatus;
use crate::commands::hq_core_update::get_local_version;
use crate::util::logfile::log;
use crate::util::paths;

// Restore endpoint: built inline in `restore_from_upstream` as
// `https://raw.githubusercontent.com/{repo}/{ref}/{path}` from the
// caller-supplied `target_repo` + `target_ref`. Uses the codeload CDN
// rather than the API to avoid burning the 60/hr rate limit on bulk
// restores. (The old `RAW_URL` constant hard-coded
// `indigoai-us/hq-core@v{tag}` — dropped when the restore became
// channel-aware in PR #110 / Codex P2 round.)

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One drift entry. `git_sha_upstream` is `None` for ADDED (no upstream
/// counterpart); `git_sha_local` is `None` for MISSING (no local copy).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftEntry {
    /// Path relative to the HQ folder (e.g. `core/policies/foo.md`).
    pub path: String,
    /// File size in bytes — local for modified/added, upstream for missing.
    pub size: u64,
    /// Local git-blob SHA-1, or None when the file is missing locally.
    pub git_sha_local: Option<String>,
    /// Upstream git-blob SHA-1, or None when the path is locally-added
    /// (not part of upstream at the current hqVersion).
    pub git_sha_upstream: Option<String>,
    /// Where this drifted file's content already lives in the staging
    /// promotion pipeline (`staging main` / `PR #n` / `unaccounted`), or
    /// `None` when staging classification is dark for this user (the public
    /// default — see `hq_core_staging`). Absent from the serialized payload
    /// when `None`, so non-eligible users' reports are byte-identical to the
    /// pre-feature shape. Only stamped on modified/added entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_status: Option<StagingStatus>,
}

/// Drift summary emitted to the frontend. `count` is the total of the
/// three lists, used by the popover footer pill.
///
/// `Deserialize` is required (not just `Serialize`) because the same struct
/// round-trips through the renderer when the user clicks the drift pill:
/// frontend `invoke('open_drift_detail', { report })` passes the cached
/// payload back to Rust, which stashes it in `PendingDrift` for the detail
/// window's `*_ready` handshake. Round-tripping the report (vs. re-fetching
/// from GitHub) avoids burning a second API call on every pill click and
/// guarantees the detail window's count matches the pill's exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    /// Total number of drifted files (modified + missing + added).
    pub count: usize,
    /// Files present in both but with differing content.
    pub modified: Vec<DriftEntry>,
    /// Files in upstream but not local (deleted or never synced).
    pub missing: Vec<DriftEntry>,
    /// Files local under a locked-path prefix but absent upstream
    /// (locally-added under a scope that shouldn't be added to).
    pub added: Vec<DriftEntry>,
    /// ISO-8601 timestamp of when the scan ran.
    pub scanned_at: String,
    /// The version/ref this report was *built against* (the target tree's
    /// version, NOT the local installed version). On the release channel
    /// this is the latest release tag without the `v` prefix
    /// (e.g. `"14.2.1"`); on staging it's an `owner/repo@ref`-shaped
    /// string (e.g. `"indigoai-us/hq-core-staging@a1b2c3d"`).
    ///
    /// Used by the detail window for the "files differ from vX.Y.Z"
    /// header label and the per-file upstream-blob URL. The `@`
    /// substring is the discriminator the Svelte side uses to format
    /// staging vs release.
    ///
    /// NOTE: this is NOT the same as the local installed `hqVersion`
    /// surfaced in the popover footer — pre-update, those differ when
    /// the user is behind. Keeping them separate is what lets the detail
    /// window link to (and `restore_from_upstream` fetch from) the tree
    /// the drift was *measured against*, so the SHA check in the restore
    /// path actually passes.
    pub hq_version: String,
    /// `owner/repo` the report was built against. Forwarded to
    /// `restore_from_upstream` so it knows where to fetch raw blob
    /// content from. Pre-unification this was always
    /// `indigoai-us/hq-core` (hard-coded in `RAW_URL`); after
    /// unification staging reports land here too with the staging
    /// repo, so the restore endpoint can't keep the hard-code.
    pub target_repo: String,
    /// Git ref the report was built against — branch, tag, or SHA the
    /// caller should pass back to `restore_from_upstream`. For release
    /// reports this is the `v`-prefixed tag (e.g. `"v14.2.1"`); for
    /// staging it's the 40-char SHA of `main`'s HEAD at scan time.
    pub target_ref: String,
}

/// Tauri command — restore a single file from upstream by overwriting
/// the local copy with the content at `{target_repo}@{target_ref}` on
/// GitHub.
///
/// `target_repo` + `target_ref` come from the open drift report (the
/// detail window forwards them from `DriftReport.target_repo` /
/// `target_ref`) so the restore fetches from the *same tree the report
/// was scanned against*. Before Codex P2 review on PR #110 these args
/// didn't exist and the restore read local `hqVersion` directly +
/// hard-coded `indigoai-us/hq-core`; that worked only when the user was
/// already on the release tag the report compared against. After the
/// unification a v14.0.0 user gets a report measured against v14.2.1,
/// so the old codepath fetched `v14.0.0`'s content and failed the SHA
/// check against `entry.gitShaUpstream` (which carries the v14.2.1
/// blob SHA). The args make the fetch source explicit.
///
/// Both args are `Option` for back-compat: legacy callers without a
/// recent report fall through to the original behavior (local
/// `hqVersion` + `indigoai-us/hq-core`).
///
/// Safety:
///   * `path` is constrained to live under one of `rules.locked` (the
///     same scopes the drift scan considers). Anything else returns
///     `Err` without touching disk — guards against a renderer being
///     tricked into requesting arbitrary writes.
///   * The local file is created if missing (Missing case) and
///     overwritten if present (Modified case).
///   * Added-only paths cannot be "restored" because there is no
///     upstream to restore from — callers should not invoke this for
///     them, and the function rejects with `Err("not in upstream scope")`.
///   * The fetched content is hash-verified against the expected
///     upstream blob SHA when provided, so a CDN poisoning or wrong-tag
///     fetch surfaces as an error instead of a silent bad write.
#[tauri::command]
pub async fn restore_from_upstream(
    path: String,
    expected_upstream_sha: Option<String>,
    target_repo: Option<String>,
    target_ref: Option<String>,
) -> Result<(), String> {
    let repo = target_repo.unwrap_or_else(|| "indigoai-us/hq-core".to_string());
    let git_ref = match target_ref {
        Some(r) => r,
        None => {
            let Some(v) = get_local_version() else {
                return Err("hqVersion not detectable — cannot resolve upstream tag".into());
            };
            format!("v{v}")
        }
    };

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

    let locked = read_locked_paths(&hq_folder);
    if !path_in_locked_scope(&path, &locked) {
        return Err(format!("path {path:?} not in locked-path scope"));
    }

    // Guard against absolute paths, ".." traversal, or weird shapes.
    let normalised = Path::new(&path);
    if normalised.is_absolute()
        || normalised
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("path {path:?} is not a safe relative path"));
    }

    let url = format!("https://raw.githubusercontent.com/{repo}/{git_ref}/{path}");
    let client = reqwest::Client::builder()
        .default_headers(crate::util::client_info::client_headers())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("build client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("upstream returned HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read upstream body: {e}"))?;

    if let Some(expected) = expected_upstream_sha {
        let actual = git_blob_sha(&bytes);
        if actual != expected {
            return Err(format!(
                "upstream content sha mismatch: expected {expected}, got {actual} — refusing to write"
            ));
        }
    }

    let target: PathBuf = hq_folder.join(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create parent dir for {target:?}: {e}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("write {target:?}: {e}"))?;
    log(
        "hq-core-drift",
        &format!("restored {} bytes to {}", bytes.len(), path),
    );
    Ok(())
}
