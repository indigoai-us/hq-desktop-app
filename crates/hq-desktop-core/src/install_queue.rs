//! Background install queue for first-run setup (US-005).
//!
//! The blocking onboarding phase only installs what the first screen needs.
//! Everything else runs here, in a fixed order, after the app is usable:
//! node, hq-cli, the chosen tool's global runtime hooks, Claude Code (only
//! when none is present), Codex (only when chosen), gh, yq, jq, a lean qmd
//! without node-llama-cpp, search indexing, the first vault upload, and the
//! embeddings runtime last.
//!
//! This module is pure: the item table, the scheduling rule, the manifest
//! format and the presence probes. The app crate owns the runners, the Tauri
//! commands and the progress event.
//!
//! Scheduling: items sit in one of two lanes. At most one `Npm` item runs at
//! a time, in list order, so global npm installs stay serial under the
//! existing cli-install lock. `Network` items (binary downloads, the vault
//! upload) run beside it as soon as their prerequisites are met.
//!
//! The manifest lives at `<managed toolchain dir>/install-queue.json`. A
//! relaunch reloads it, re-runs any item that was interrupted or whose
//! binary has gone missing, and continues from the next pending item.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = "install-queue.json";
pub const SCHEMA_VERSION: u32 = 1;
const LOG_TAG: &str = "install-queue";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueItemId {
    Node,
    HqCli,
    RuntimeHooks,
    ClaudeCode,
    Codex,
    Gh,
    Yq,
    Jq,
    Qmd,
    SearchIndex,
    VaultUpload,
    Embeddings,
}

impl QueueItemId {
    /// Fixed queue order. Npm-lane items run in exactly this order.
    pub const ALL: [QueueItemId; 12] = [
        QueueItemId::Node,
        QueueItemId::HqCli,
        QueueItemId::RuntimeHooks,
        QueueItemId::ClaudeCode,
        QueueItemId::Codex,
        QueueItemId::Gh,
        QueueItemId::Yq,
        QueueItemId::Jq,
        QueueItemId::Qmd,
        QueueItemId::SearchIndex,
        QueueItemId::VaultUpload,
        QueueItemId::Embeddings,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            QueueItemId::Node => "node",
            QueueItemId::HqCli => "hq-cli",
            QueueItemId::RuntimeHooks => "runtime-hooks",
            QueueItemId::ClaudeCode => "claude-code",
            QueueItemId::Codex => "codex",
            QueueItemId::Gh => "gh",
            QueueItemId::Yq => "yq",
            QueueItemId::Jq => "jq",
            QueueItemId::Qmd => "qmd",
            QueueItemId::SearchIndex => "search-index",
            QueueItemId::VaultUpload => "vault-upload",
            QueueItemId::Embeddings => "embeddings",
        }
    }

    pub fn parse(value: &str) -> Option<QueueItemId> {
        QueueItemId::ALL.into_iter().find(|id| id.as_str() == value)
    }

    /// Chip label for the item currently running.
    pub fn label(self) -> &'static str {
        match self {
            QueueItemId::Node => "Node.js",
            QueueItemId::HqCli => "HQ command line",
            QueueItemId::RuntimeHooks => "Runtime hooks",
            QueueItemId::ClaudeCode => "Claude Code",
            QueueItemId::Codex => "Codex",
            QueueItemId::Gh => "GitHub CLI",
            QueueItemId::Yq => "yq",
            QueueItemId::Jq => "jq",
            QueueItemId::Qmd => "Search engine",
            QueueItemId::SearchIndex => "Search index",
            QueueItemId::VaultUpload => "First upload",
            QueueItemId::Embeddings => "Semantic search",
        }
    }

    pub fn lane(self) -> Lane {
        match self {
            QueueItemId::HqCli
            | QueueItemId::RuntimeHooks
            | QueueItemId::ClaudeCode
            | QueueItemId::Codex
            | QueueItemId::Qmd
            | QueueItemId::SearchIndex
            | QueueItemId::Embeddings => Lane::Npm,
            QueueItemId::Node
            | QueueItemId::Gh
            | QueueItemId::Yq
            | QueueItemId::Jq
            | QueueItemId::VaultUpload => Lane::Network,
        }
    }

    /// Items that must be satisfied (done or skipped) before this one runs.
    /// `Embeddings` additionally waits for every other item to settle; see
    /// [`is_ready`].
    pub fn prerequisites(self) -> &'static [QueueItemId] {
        match self {
            QueueItemId::Node | QueueItemId::Gh | QueueItemId::Yq | QueueItemId::Jq => &[],
            QueueItemId::HqCli | QueueItemId::ClaudeCode | QueueItemId::Codex | QueueItemId::Qmd => {
                &[QueueItemId::Node]
            }
            QueueItemId::RuntimeHooks => &[QueueItemId::HqCli],
            QueueItemId::SearchIndex => &[QueueItemId::Qmd, QueueItemId::HqCli],
            QueueItemId::VaultUpload => &[],
            QueueItemId::Embeddings => &[QueueItemId::Qmd],
        }
    }

    /// Telemetry `step` value, `install-queue:<item>`.
    pub fn telemetry_step(self) -> String {
        format!("install-queue:{}", self.as_str())
    }

    /// Timing log id, `queue:<item>`, in the US-001 first-run line format.
    pub fn timing_id(self) -> String {
        format!("queue:{}", self.as_str())
    }
}

/// Items the deps onboarding stage waits for: every tool install up to and
/// including qmd. Search indexing, the vault upload and embeddings are
/// waited for by their own stages (or not at all, for embeddings).
pub const INSTALL_ITEMS: [QueueItemId; 9] = [
    QueueItemId::Node,
    QueueItemId::HqCli,
    QueueItemId::RuntimeHooks,
    QueueItemId::ClaudeCode,
    QueueItemId::Codex,
    QueueItemId::Gh,
    QueueItemId::Yq,
    QueueItemId::Jq,
    QueueItemId::Qmd,
];

/// Items the onboarding wizard runs itself (its indexing and initial-sync
/// stages). The queue holds them until they are released, so the two never
/// run the same work twice. A relaunch with no wizard running releases them
/// and the queue runs whatever is still pending.
pub const GATED_ITEMS: [QueueItemId; 2] = [QueueItemId::SearchIndex, QueueItemId::VaultUpload];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lane {
    Npm,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemState {
    Pending,
    Running,
    Done,
    Skipped,
    Failed,
}

impl ItemState {
    pub fn satisfied(self) -> bool {
        matches!(self, ItemState::Done | ItemState::Skipped)
    }

    pub fn terminal(self) -> bool {
        matches!(self, ItemState::Done | ItemState::Skipped | ItemState::Failed)
    }
}

/// Which tool the user picked during onboarding. `tool` decides which global
/// runtime hooks are configured; `codex` decides whether Codex is installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueChoices {
    #[serde(default = "default_tool")]
    pub tool: String,
    #[serde(default)]
    pub codex: bool,
}

fn default_tool() -> String {
    "claude".to_string()
}

impl Default for QueueChoices {
    fn default() -> Self {
        QueueChoices {
            tool: default_tool(),
            codex: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecord {
    pub id: QueueItemId,
    pub state: ItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ItemRecord {
    fn pending(id: QueueItemId) -> Self {
        ItemRecord {
            id,
            state: ItemState::Pending,
            started_at: None,
            ended_at: None,
            elapsed_ms: None,
            skip_reason: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueManifest {
    pub schema_version: u32,
    pub created_at: String,
    pub choices: QueueChoices,
    pub items: Vec<ItemRecord>,
    /// Gated items the queue may run itself. See [`GATED_ITEMS`].
    #[serde(default)]
    pub released: Vec<QueueItemId>,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_manifest(choices: QueueChoices) -> QueueManifest {
    let mut manifest = QueueManifest {
        schema_version: SCHEMA_VERSION,
        created_at: now_rfc3339(),
        choices: QueueChoices::default(),
        items: QueueItemId::ALL.into_iter().map(ItemRecord::pending).collect(),
        released: Vec::new(),
    };
    apply_choices(&mut manifest, choices);
    manifest
}

pub const SKIP_NOT_CHOSEN: &str = "not-chosen";
pub const SKIP_ALREADY_PRESENT: &str = "already-present";
pub const SKIP_BUNDLED: &str = "bundled";

/// Record the user's choices. Codex not chosen is skipped with
/// `not-chosen`; choosing it later puts a not-chosen skip back to pending.
pub fn apply_choices(manifest: &mut QueueManifest, choices: QueueChoices) {
    let codex = choices.codex;
    manifest.choices = choices;
    if let Some(record) = manifest.item_mut(QueueItemId::Codex) {
        if !codex && record.state == ItemState::Pending {
            record.state = ItemState::Skipped;
            record.skip_reason = Some(SKIP_NOT_CHOSEN.to_string());
        } else if codex
            && record.state == ItemState::Skipped
            && record.skip_reason.as_deref() == Some(SKIP_NOT_CHOSEN)
        {
            *record = ItemRecord::pending(QueueItemId::Codex);
        }
    }
}

impl QueueManifest {
    pub fn item(&self, id: QueueItemId) -> Option<&ItemRecord> {
        self.items.iter().find(|record| record.id == id)
    }

    pub fn item_mut(&mut self, id: QueueItemId) -> Option<&mut ItemRecord> {
        self.items.iter_mut().find(|record| record.id == id)
    }

    pub fn state(&self, id: QueueItemId) -> ItemState {
        self.item(id).map(|record| record.state).unwrap_or(ItemState::Pending)
    }

    pub fn mark_running(&mut self, id: QueueItemId) {
        if let Some(record) = self.item_mut(id) {
            record.state = ItemState::Running;
            record.started_at = Some(now_rfc3339());
            record.ended_at = None;
            record.elapsed_ms = None;
            record.skip_reason = None;
            record.error = None;
        }
    }

    pub fn mark_finished(&mut self, id: QueueItemId, outcome: &ItemOutcome, elapsed_ms: u64) {
        if let Some(record) = self.item_mut(id) {
            record.ended_at = Some(now_rfc3339());
            record.elapsed_ms = Some(elapsed_ms);
            match outcome {
                ItemOutcome::Done => {
                    record.state = ItemState::Done;
                }
                ItemOutcome::Skipped(reason) => {
                    record.state = ItemState::Skipped;
                    record.skip_reason = Some(reason.clone());
                }
                ItemOutcome::Failed(error) => {
                    record.state = ItemState::Failed;
                    record.error = Some(error.clone());
                }
            }
        }
    }

    /// True for a gated item the queue has not been allowed to run yet.
    pub fn is_held(&self, id: QueueItemId) -> bool {
        GATED_ITEMS.contains(&id) && !self.released.contains(&id)
    }

    /// Let the queue run a gated item itself. Idempotent.
    pub fn release(&mut self, id: QueueItemId) {
        if GATED_ITEMS.contains(&id) && !self.released.contains(&id) {
            self.released.push(id);
        }
    }

    pub fn release_all_gated(&mut self) {
        for id in GATED_ITEMS {
            self.release(id);
        }
    }

    /// Put failed items back to pending so the queue retries them. Returns
    /// the ids that were reset.
    pub fn retry_failed(&mut self) -> Vec<QueueItemId> {
        let mut reset = Vec::new();
        for record in &mut self.items {
            if record.state == ItemState::Failed {
                reset.push(record.id);
                *record = ItemRecord::pending(record.id);
            }
        }
        reset
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemOutcome {
    Done,
    Skipped(String),
    Failed(String),
}

/// True when the item can never run in this pass because a prerequisite
/// failed (directly or through another blocked item).
pub fn is_blocked(manifest: &QueueManifest, id: QueueItemId) -> bool {
    id.prerequisites().iter().any(|&prereq| match manifest.state(prereq) {
        ItemState::Failed => true,
        ItemState::Pending => is_blocked(manifest, prereq),
        _ => false,
    })
}

/// True when the item is pending and every prerequisite is satisfied.
/// Embeddings also waits until every other item has settled, so model
/// downloads never compete with the rest of setup.
pub fn is_ready(manifest: &QueueManifest, id: QueueItemId) -> bool {
    if manifest.state(id) != ItemState::Pending || manifest.is_held(id) {
        return false;
    }
    if !id
        .prerequisites()
        .iter()
        .all(|&prereq| manifest.state(prereq).satisfied())
    {
        return false;
    }
    if id == QueueItemId::Embeddings {
        return QueueItemId::ALL
            .into_iter()
            .filter(|&other| other != QueueItemId::Embeddings)
            .all(|other| is_settled(manifest, other));
    }
    true
}

/// Settled: terminal, or pending but blocked by a failed prerequisite. A
/// caller waiting on an item stops waiting once it is settled.
pub fn is_settled(manifest: &QueueManifest, id: QueueItemId) -> bool {
    let state = manifest.state(id);
    state.terminal() || (state == ItemState::Pending && is_blocked(manifest, id))
}

/// Items to start now. At most one npm-lane item, chosen in list order: an
/// earlier npm item that is still waiting on a prerequisite holds back the
/// later ones, and an earlier item blocked by a failure is passed over.
/// Every ready network-lane item is started alongside.
pub fn plan_next(manifest: &QueueManifest) -> Vec<QueueItemId> {
    let mut next = Vec::new();
    let npm_running = manifest
        .items
        .iter()
        .any(|record| record.state == ItemState::Running && record.id.lane() == Lane::Npm);
    if !npm_running {
        for id in QueueItemId::ALL.into_iter().filter(|id| id.lane() == Lane::Npm) {
            if manifest.state(id) != ItemState::Pending || manifest.is_held(id) {
                continue;
            }
            if is_ready(manifest, id) {
                next.push(id);
                break;
            }
            if is_blocked(manifest, id) {
                continue;
            }
            break;
        }
    }
    for id in QueueItemId::ALL.into_iter().filter(|id| id.lane() == Lane::Network) {
        if is_ready(manifest, id) {
            next.push(id);
        }
    }
    next
}

/// Failed items among `ids`, plus items in `ids` that are blocked by a
/// failure elsewhere (reported as the failed prerequisite's dependents).
pub fn failed_among(manifest: &QueueManifest, ids: &[QueueItemId]) -> Vec<QueueItemId> {
    ids.iter()
        .copied()
        .filter(|&id| {
            manifest.state(id) == ItemState::Failed
                || (manifest.state(id) == ItemState::Pending && is_blocked(manifest, id))
        })
        .collect()
}

/// Presence answer from a probe. `Unknown` items (search index, upload)
/// are not re-checked on resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Present,
    Missing,
    Unknown,
}

/// Prepare a loaded manifest for a new run. An item left `running` was
/// interrupted by a quit and goes back to pending. A `done` item whose
/// binary the probe reports missing goes back to pending. Failed items are
/// retried. Returns the ids that were reset, for logging.
pub fn reconcile_on_resume(
    manifest: &mut QueueManifest,
    probe: impl Fn(QueueItemId) -> Presence,
) -> Vec<QueueItemId> {
    let mut reset = Vec::new();
    for record in &mut manifest.items {
        let rerun = match record.state {
            ItemState::Running | ItemState::Failed => true,
            ItemState::Done => probe(record.id) == Presence::Missing,
            ItemState::Pending | ItemState::Skipped => false,
        };
        if rerun {
            reset.push(record.id);
            *record = ItemRecord::pending(record.id);
        }
    }
    reset
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueState {
    /// No queue manifest, or nothing started yet.
    Idle,
    Running,
    /// Something failed and nothing else can run. The chip offers Retry.
    Attention,
    Complete,
}

/// Payload of `get_install_queue_status` and the `install-queue:progress`
/// event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub state: QueueState,
    /// Chip label of the item running now (npm lane first), if any.
    pub current: Option<String>,
    pub current_id: Option<String>,
    /// Items done or skipped.
    pub done: usize,
    pub total: usize,
    pub failed: Vec<String>,
}

pub fn idle_status() -> QueueStatus {
    QueueStatus {
        state: QueueState::Idle,
        current: None,
        current_id: None,
        done: 0,
        total: QueueItemId::ALL.len(),
        failed: Vec::new(),
    }
}

/// Status for the chip. `active` is true while the app's queue task runs.
pub fn status(manifest: &QueueManifest, active: bool) -> QueueStatus {
    let done = manifest.items.iter().filter(|record| record.state.satisfied()).count();
    let total = manifest.items.len();
    let failed: Vec<String> = manifest
        .items
        .iter()
        .filter(|record| record.state == ItemState::Failed)
        .map(|record| record.id.as_str().to_string())
        .collect();
    let running: Vec<QueueItemId> = manifest
        .items
        .iter()
        .filter(|record| record.state == ItemState::Running)
        .map(|record| record.id)
        .collect();
    let current = running
        .iter()
        .copied()
        .find(|id| id.lane() == Lane::Npm)
        .or_else(|| running.first().copied());
    let state = if done == total {
        QueueState::Complete
    } else if !failed.is_empty() && running.is_empty() && plan_next(manifest).is_empty() {
        QueueState::Attention
    } else if active || !running.is_empty() {
        QueueState::Running
    } else {
        QueueState::Idle
    };
    QueueStatus {
        state,
        current: current.map(|id| id.label().to_string()),
        current_id: current.map(|id| id.as_str().to_string()),
        done,
        total,
        failed,
    }
}

/// True when every item the blocking setup depends on is settled. Lifecycle
/// uses the inverse: pending queue items do not send the user back to the
/// setup card.
pub fn has_unfinished_items(manifest: &QueueManifest) -> bool {
    manifest.items.iter().any(|record| !record.state.satisfied())
}

/// True when the manifest says `id` will still be installed by the queue,
/// so a missing binary is expected rather than a broken install.
pub fn item_pending_in_queue(manifest: &QueueManifest, id: QueueItemId) -> bool {
    !manifest.state(id).satisfied()
}

/// Startup gate helper. `hq_resolved` and `node_resolved` say whether the
/// binaries resolve now. Returns true when every missing one is an item the
/// queue still owes (pending or running), so the app opens normally and the
/// queue installs it. A missing binary whose item is done, skipped or
/// failed is a broken install and returns false. Nothing missing also
/// returns false: the caller has nothing to excuse.
pub fn queue_owes_missing_tools(
    manifest: &QueueManifest,
    hq_resolved: bool,
    node_resolved: bool,
) -> bool {
    let owed = |id: QueueItemId| {
        matches!(manifest.state(id), ItemState::Pending | ItemState::Running) && !is_blocked(manifest, id)
    };
    let mut missing = Vec::new();
    if !hq_resolved {
        missing.push(QueueItemId::HqCli);
    }
    if !node_resolved {
        missing.push(QueueItemId::Node);
    }
    !missing.is_empty() && missing.into_iter().all(owed)
}

pub fn manifest_path_in(toolchain_dir: &Path) -> PathBuf {
    toolchain_dir.join(MANIFEST_FILE)
}

#[derive(Debug)]
pub enum LoadOutcome {
    Fresh,
    Loaded(QueueManifest),
    /// Unreadable, unparsable or wrong schema. The caller starts a fresh
    /// queue; the reason has already been logged.
    Corrupt(String),
}

pub fn load_manifest(path: &Path) -> LoadOutcome {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return LoadOutcome::Fresh,
        Err(err) => {
            let reason = format!("read {} failed: {err}", path.display());
            crate::logfile::log(LOG_TAG, &format!("manifest corrupt, starting fresh: {reason}"));
            return LoadOutcome::Corrupt(reason);
        }
    };
    match parse_manifest(&raw) {
        Ok(manifest) => LoadOutcome::Loaded(manifest),
        Err(reason) => {
            crate::logfile::log(LOG_TAG, &format!("manifest corrupt, starting fresh: {reason}"));
            LoadOutcome::Corrupt(reason)
        }
    }
}

fn parse_manifest(raw: &str) -> Result<QueueManifest, String> {
    let manifest: QueueManifest =
        serde_json::from_str(raw).map_err(|err| format!("parse failed: {err}"))?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "schema_version {} does not match {SCHEMA_VERSION}",
            manifest.schema_version
        ));
    }
    let ids: Vec<QueueItemId> = manifest.items.iter().map(|record| record.id).collect();
    if ids != QueueItemId::ALL {
        return Err("item list does not match the queue order".to_string());
    }
    Ok(manifest)
}

/// Write through a temp file and rename, so a quit mid-write leaves the
/// previous manifest intact.
pub fn save_manifest(path: &Path, manifest: &QueueManifest) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("manifest path {} has no parent", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|err| format!("create {} failed: {err}", dir.display()))?;
    let body = serde_json::to_string_pretty(manifest)
        .map_err(|err| format!("serialize manifest failed: {err}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|err| format!("write {} failed: {err}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|err| {
        format!("rename {} to {} failed: {err}", tmp.display(), path.display())
    })
}

fn executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// First executable named `name` in `dirs`. On Windows `.cmd` and `.exe`
/// variants are checked too.
pub fn binary_present_in(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut names = vec![name.to_string()];
    if cfg!(windows) {
        names.push(format!("{name}.cmd"));
        names.push(format!("{name}.exe"));
    }
    dirs.iter().find_map(|dir| {
        names
            .iter()
            .map(|candidate| dir.join(candidate))
            .find(|path| executable_file(path))
    })
}

/// Any Claude Code install: a `claude` on the search path, or the native
/// installer's `~/.claude/local/claude`, which is not on the search path.
pub fn claude_code_present_in(home: &Path, dirs: &[PathBuf]) -> Option<PathBuf> {
    binary_present_in("claude", dirs).or_else(|| {
        let local = home.join(".claude").join("local").join("claude");
        executable_file(&local).then_some(local)
    })
}

/// `setup_pending` reason for a search made before embeddings exist.
pub const SEMANTIC_SEARCH_REASON: &str = "semantic-search";
pub const SEMANTIC_SEARCH_PENDING_COPY: &str =
    "Keyword search works now. Semantic search is still setting up.";

/// Classify qmd search output from before embeddings exist. `qmd vsearch`
/// prints "N documents need embeddings" and returns nothing; `qmd query`
/// fails to load node-llama-cpp. Both map to the `semantic-search`
/// setup_pending reason, shown with [`SEMANTIC_SEARCH_PENDING_COPY`] next to
/// the keyword results. The search caller (hq-cli) adopts this contract.
pub fn classify_semantic_search_output(output: &str) -> Option<String> {
    let lower = output.to_ascii_lowercase();
    let needs_embeddings = lower.contains("need embeddings") || lower.contains("needs embeddings");
    let runtime_missing = output.contains("ERR_MODULE_NOT_FOUND") && output.contains("node-llama-cpp");
    (needs_embeddings || runtime_missing).then(|| SEMANTIC_SEARCH_REASON.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_search_classifier_flags_missing_embeddings_only() {
        assert_eq!(
            classify_semantic_search_output("Warning: 42 documents need embeddings. Run qmd embed."),
            Some(SEMANTIC_SEARCH_REASON.to_string())
        );
        assert_eq!(
            classify_semantic_search_output(
                "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node-llama-cpp' imported from qmd"
            ),
            Some(SEMANTIC_SEARCH_REASON.to_string())
        );
        assert_eq!(classify_semantic_search_output("notes/plan.md:3 install queue"), None);
        assert_eq!(
            classify_semantic_search_output("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'"),
            None
        );
        assert_eq!(
            SEMANTIC_SEARCH_PENDING_COPY,
            "Keyword search works now. Semantic search is still setting up."
        );
    }

    fn manifest_with(choices: QueueChoices) -> QueueManifest {
        new_manifest(choices)
    }

    fn finish(manifest: &mut QueueManifest, id: QueueItemId, outcome: ItemOutcome) {
        manifest.mark_running(id);
        manifest.mark_finished(id, &outcome, 1);
    }

    /// Drive the queue to completion with every item succeeding, returning
    /// each round of started items.
    fn run_all(manifest: &mut QueueManifest) -> Vec<Vec<QueueItemId>> {
        let mut rounds = Vec::new();
        loop {
            let next = plan_next(manifest);
            if next.is_empty() {
                break;
            }
            for &id in &next {
                manifest.mark_running(id);
            }
            for &id in &next {
                manifest.mark_finished(id, &ItemOutcome::Done, 1);
            }
            rounds.push(next);
        }
        rounds
    }

    #[test]
    fn ids_round_trip_and_keep_the_fixed_order() {
        let names: Vec<&str> = QueueItemId::ALL.iter().map(|id| id.as_str()).collect();
        assert_eq!(
            names,
            [
                "node",
                "hq-cli",
                "runtime-hooks",
                "claude-code",
                "codex",
                "gh",
                "yq",
                "jq",
                "qmd",
                "search-index",
                "vault-upload",
                "embeddings"
            ]
        );
        for id in QueueItemId::ALL {
            assert_eq!(QueueItemId::parse(id.as_str()), Some(id));
        }
        assert_eq!(QueueItemId::parse("homebrew"), None);
        assert_eq!(QueueItemId::Codex.telemetry_step(), "install-queue:codex");
        assert_eq!(QueueItemId::Qmd.timing_id(), "queue:qmd");
    }

    #[test]
    fn first_round_starts_downloads_and_no_npm_item_before_node() {
        let mut manifest = manifest_with(QueueChoices::default());
        let downloads = vec![QueueItemId::Node, QueueItemId::Gh, QueueItemId::Yq, QueueItemId::Jq];
        // The vault upload is held for the wizard until released.
        assert_eq!(plan_next(&manifest), downloads);
        manifest.release_all_gated();
        let mut with_upload = downloads.clone();
        with_upload.push(QueueItemId::VaultUpload);
        assert_eq!(plan_next(&manifest), with_upload);
    }

    #[test]
    fn npm_lane_runs_one_item_at_a_time_in_list_order() {
        let mut manifest = manifest_with(QueueChoices {
            tool: "codex".to_string(),
            codex: true,
        });
        manifest.release_all_gated();
        let rounds = run_all(&mut manifest);
        let npm_order: Vec<QueueItemId> = rounds
            .iter()
            .flat_map(|round| round.iter().copied().filter(|id| id.lane() == Lane::Npm))
            .collect();
        assert_eq!(
            npm_order,
            vec![
                QueueItemId::HqCli,
                QueueItemId::RuntimeHooks,
                QueueItemId::ClaudeCode,
                QueueItemId::Codex,
                QueueItemId::Qmd,
                QueueItemId::SearchIndex,
                QueueItemId::Embeddings
            ]
        );
        for round in &rounds {
            assert!(
                round.iter().filter(|id| id.lane() == Lane::Npm).count() <= 1,
                "two npm items in one round: {round:?}"
            );
        }
        assert_eq!(rounds.last().unwrap(), &vec![QueueItemId::Embeddings]);
        assert_eq!(status(&manifest, false).state, QueueState::Complete);
    }

    #[test]
    fn no_new_npm_item_starts_while_one_is_running() {
        let mut manifest = manifest_with(QueueChoices::default());
        finish(&mut manifest, QueueItemId::Node, ItemOutcome::Done);
        manifest.mark_running(QueueItemId::HqCli);
        let next = plan_next(&manifest);
        assert!(next.iter().all(|id| id.lane() == Lane::Network), "{next:?}");
        assert!(next.contains(&QueueItemId::Gh));
    }

    #[test]
    fn embeddings_waits_for_every_other_item() {
        let mut manifest = manifest_with(QueueChoices::default());
        for id in [
            QueueItemId::Node,
            QueueItemId::HqCli,
            QueueItemId::RuntimeHooks,
            QueueItemId::ClaudeCode,
            QueueItemId::Qmd,
            QueueItemId::SearchIndex,
        ] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        // vault upload and the downloads are still pending.
        assert!(!is_ready(&manifest, QueueItemId::Embeddings));
        assert!(!plan_next(&manifest).contains(&QueueItemId::Embeddings));
        for id in [QueueItemId::Gh, QueueItemId::Yq, QueueItemId::Jq, QueueItemId::VaultUpload] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        assert_eq!(plan_next(&manifest), vec![QueueItemId::Embeddings]);
    }

    #[test]
    fn a_failed_item_blocks_dependents_and_independent_items_continue() {
        let mut manifest = manifest_with(QueueChoices::default());
        finish(&mut manifest, QueueItemId::Node, ItemOutcome::Done);
        finish(&mut manifest, QueueItemId::HqCli, ItemOutcome::Failed("npm exit 1".into()));
        // runtime-hooks and search-index depend on hq-cli; claude-code does not.
        assert!(is_blocked(&manifest, QueueItemId::RuntimeHooks));
        assert_eq!(plan_next(&manifest)[0], QueueItemId::ClaudeCode);
        finish(&mut manifest, QueueItemId::ClaudeCode, ItemOutcome::Done);
        assert_eq!(plan_next(&manifest)[0], QueueItemId::Qmd);
        finish(&mut manifest, QueueItemId::Qmd, ItemOutcome::Done);
        assert!(is_blocked(&manifest, QueueItemId::SearchIndex));
        assert_eq!(
            failed_among(&manifest, &INSTALL_ITEMS),
            vec![QueueItemId::HqCli, QueueItemId::RuntimeHooks]
        );
        for id in [QueueItemId::Gh, QueueItemId::Yq, QueueItemId::Jq, QueueItemId::VaultUpload] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        // Everything except the blocked items settled, so embeddings runs.
        assert_eq!(plan_next(&manifest), vec![QueueItemId::Embeddings]);
        finish(&mut manifest, QueueItemId::Embeddings, ItemOutcome::Done);
        let chip = status(&manifest, false);
        assert_eq!(chip.state, QueueState::Attention);
        assert_eq!(chip.failed, vec!["hq-cli".to_string()]);
        assert!(is_settled(&manifest, QueueItemId::SearchIndex));

        assert_eq!(manifest.retry_failed(), vec![QueueItemId::HqCli]);
        assert_eq!(plan_next(&manifest), vec![QueueItemId::HqCli]);
    }

    #[test]
    fn codex_not_chosen_is_skipped_and_choosing_it_later_reopens_it() {
        let mut manifest = manifest_with(QueueChoices::default());
        let codex = manifest.item(QueueItemId::Codex).unwrap();
        assert_eq!(codex.state, ItemState::Skipped);
        assert_eq!(codex.skip_reason.as_deref(), Some(SKIP_NOT_CHOSEN));
        apply_choices(
            &mut manifest,
            QueueChoices {
                tool: "codex".into(),
                codex: true,
            },
        );
        assert_eq!(manifest.state(QueueItemId::Codex), ItemState::Pending);
        // A Codex that was installed stays done when choices are re-applied.
        finish(&mut manifest, QueueItemId::Codex, ItemOutcome::Done);
        apply_choices(&mut manifest, QueueChoices::default());
        assert_eq!(manifest.state(QueueItemId::Codex), ItemState::Done);
    }

    #[test]
    fn resume_reruns_the_interrupted_item_and_does_not_repeat_done_items() {
        let tmp = tempfile::tempdir().unwrap();
        let path = manifest_path_in(tmp.path());
        let mut manifest = manifest_with(QueueChoices::default());
        for id in [QueueItemId::Node, QueueItemId::HqCli, QueueItemId::Gh] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        manifest.mark_running(QueueItemId::RuntimeHooks);
        save_manifest(&path, &manifest).unwrap();

        let LoadOutcome::Loaded(mut loaded) = load_manifest(&path) else {
            panic!("manifest did not load");
        };
        assert_eq!(loaded, manifest);
        let reset = reconcile_on_resume(&mut loaded, |_| Presence::Present);
        assert_eq!(reset, vec![QueueItemId::RuntimeHooks]);
        assert_eq!(loaded.state(QueueItemId::HqCli), ItemState::Done);
        let next = plan_next(&loaded);
        assert_eq!(next[0], QueueItemId::RuntimeHooks);
        assert!(!next.contains(&QueueItemId::Node));
        assert!(!next.contains(&QueueItemId::Gh));
        let chip = status(&loaded, true);
        assert_eq!(chip.done, 4); // node, hq-cli, gh, codex (not chosen)
        assert_eq!(chip.total, 12);
    }

    #[test]
    fn resume_reruns_a_done_item_whose_binary_is_missing() {
        let mut manifest = manifest_with(QueueChoices::default());
        for id in [QueueItemId::Node, QueueItemId::HqCli, QueueItemId::Gh] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        finish(&mut manifest, QueueItemId::Yq, ItemOutcome::Failed("timeout".into()));
        let reset = reconcile_on_resume(&mut manifest, |id| {
            if id == QueueItemId::Gh {
                Presence::Missing
            } else {
                Presence::Present
            }
        });
        assert_eq!(reset, vec![QueueItemId::Gh, QueueItemId::Yq]);
        assert_eq!(manifest.state(QueueItemId::Node), ItemState::Done);
        assert_eq!(manifest.state(QueueItemId::Gh), ItemState::Pending);
        assert!(manifest.item(QueueItemId::Yq).unwrap().error.is_none());
    }

    #[test]
    fn corrupt_or_foreign_manifests_load_as_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let path = manifest_path_in(tmp.path());
        assert!(matches!(load_manifest(&path), LoadOutcome::Fresh));

        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(load_manifest(&path), LoadOutcome::Corrupt(_)));

        let mut manifest = manifest_with(QueueChoices::default());
        manifest.schema_version = 99;
        std::fs::write(&path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let LoadOutcome::Corrupt(reason) = load_manifest(&path) else {
            panic!("schema mismatch accepted");
        };
        assert!(reason.contains("schema_version 99"), "{reason}");

        let mut manifest = manifest_with(QueueChoices::default());
        manifest.items.pop();
        std::fs::write(&path, serde_json::to_string(&manifest).unwrap()).unwrap();
        assert!(matches!(load_manifest(&path), LoadOutcome::Corrupt(_)));
    }

    #[test]
    fn save_replaces_the_file_and_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = manifest_path_in(&tmp.path().join("toolchain"));
        let mut manifest = manifest_with(QueueChoices::default());
        save_manifest(&path, &manifest).unwrap();
        finish(&mut manifest, QueueItemId::Node, ItemOutcome::Done);
        save_manifest(&path, &manifest).unwrap();
        let LoadOutcome::Loaded(loaded) = load_manifest(&path) else {
            panic!("manifest did not load");
        };
        assert_eq!(loaded.state(QueueItemId::Node), ItemState::Done);
        assert!(!path.with_extension("json.tmp").exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"schemaVersion\": 1"), "{raw}");
        assert!(raw.contains("\"id\": \"hq-cli\""), "{raw}");
    }

    #[cfg(unix)]
    fn write_exe(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn claude_present_on_path_or_in_claude_local_is_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let dirs = vec![bin.clone()];
        assert_eq!(claude_code_present_in(&home, &dirs), None);

        // A non-executable file does not count.
        let local = home.join(".claude/local/claude");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, "").unwrap();
        assert_eq!(claude_code_present_in(&home, &dirs), None);

        write_exe(&local);
        assert_eq!(claude_code_present_in(&home, &dirs), Some(local.clone()));

        let on_path = bin.join("claude");
        write_exe(&on_path);
        assert_eq!(claude_code_present_in(&home, &dirs), Some(on_path));
        assert_eq!(binary_present_in("codex", &dirs), None);
    }

    #[test]
    fn status_reports_the_running_npm_item_and_counts() {
        let mut manifest = manifest_with(QueueChoices {
            tool: "claude".into(),
            codex: true,
        });
        for id in [
            QueueItemId::Node,
            QueueItemId::HqCli,
            QueueItemId::RuntimeHooks,
        ] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        finish(
            &mut manifest,
            QueueItemId::ClaudeCode,
            ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.into()),
        );
        manifest.mark_running(QueueItemId::Gh);
        manifest.mark_running(QueueItemId::Codex);
        let chip = status(&manifest, true);
        assert_eq!(chip.state, QueueState::Running);
        assert_eq!(chip.current.as_deref(), Some("Codex"));
        assert_eq!(chip.current_id.as_deref(), Some("codex"));
        assert_eq!(chip.done, 4);
        assert_eq!(chip.total, 12);
        assert!(has_unfinished_items(&manifest));
        assert!(item_pending_in_queue(&manifest, QueueItemId::Qmd));
        assert!(!item_pending_in_queue(&manifest, QueueItemId::HqCli));
        let json = serde_json::to_value(&chip).unwrap();
        assert_eq!(json["currentId"], "codex");
        assert_eq!(json["state"], "running");
    }

    #[test]
    fn gated_items_wait_for_release_and_the_release_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let path = manifest_path_in(tmp.path());
        let mut manifest = manifest_with(QueueChoices::default());
        for id in [
            QueueItemId::Node,
            QueueItemId::HqCli,
            QueueItemId::RuntimeHooks,
            QueueItemId::ClaudeCode,
            QueueItemId::Gh,
            QueueItemId::Yq,
            QueueItemId::Jq,
            QueueItemId::Qmd,
        ] {
            finish(&mut manifest, id, ItemOutcome::Done);
        }
        // Prerequisites are met, but the wizard owns both gated items.
        assert!(manifest.is_held(QueueItemId::SearchIndex));
        assert!(!is_ready(&manifest, QueueItemId::SearchIndex));
        assert!(plan_next(&manifest).is_empty());
        // Embeddings waits behind the held items.
        assert!(!is_ready(&manifest, QueueItemId::Embeddings));

        manifest.release(QueueItemId::SearchIndex);
        manifest.release(QueueItemId::SearchIndex);
        assert_eq!(manifest.released, vec![QueueItemId::SearchIndex]);
        assert_eq!(plan_next(&manifest), vec![QueueItemId::SearchIndex]);
        // Only gated items can be released.
        manifest.release(QueueItemId::Gh);
        assert!(!manifest.released.contains(&QueueItemId::Gh));

        save_manifest(&path, &manifest).unwrap();
        let LoadOutcome::Loaded(loaded) = load_manifest(&path) else {
            panic!("manifest did not load");
        };
        assert!(!loaded.is_held(QueueItemId::SearchIndex));
        assert!(loaded.is_held(QueueItemId::VaultUpload));
    }

    #[test]
    fn a_manifest_without_a_released_list_loads_with_nothing_released() {
        let tmp = tempfile::tempdir().unwrap();
        let path = manifest_path_in(tmp.path());
        let manifest = manifest_with(QueueChoices::default());
        let mut value = serde_json::to_value(&manifest).unwrap();
        value.as_object_mut().unwrap().remove("released");
        std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();
        let LoadOutcome::Loaded(loaded) = load_manifest(&path) else {
            panic!("legacy manifest did not load");
        };
        assert!(loaded.released.is_empty());
        assert!(loaded.is_held(QueueItemId::VaultUpload));
    }

    #[test]
    fn queue_owes_missing_tools_only_for_items_it_will_still_install() {
        let mut manifest = manifest_with(QueueChoices::default());
        // Nothing missing: nothing to excuse.
        assert!(!queue_owes_missing_tools(&manifest, true, true));
        // Missing hq and node, both pending: the queue installs them.
        assert!(queue_owes_missing_tools(&manifest, false, false));
        manifest.mark_running(QueueItemId::Node);
        assert!(queue_owes_missing_tools(&manifest, true, false));

        // Node failed: hq-cli is blocked behind it, and node itself is broken.
        manifest.mark_finished(QueueItemId::Node, &ItemOutcome::Failed("download".into()), 1);
        assert!(!queue_owes_missing_tools(&manifest, false, true));
        assert!(!queue_owes_missing_tools(&manifest, true, false));

        // A done item whose binary is gone is a broken install.
        let mut manifest = manifest_with(QueueChoices::default());
        finish(&mut manifest, QueueItemId::Node, ItemOutcome::Done);
        finish(&mut manifest, QueueItemId::HqCli, ItemOutcome::Done);
        assert!(!queue_owes_missing_tools(&manifest, false, true));
        // One owed and one broken is not excused.
        let mut manifest = manifest_with(QueueChoices::default());
        finish(&mut manifest, QueueItemId::Node, ItemOutcome::Done);
        assert!(!queue_owes_missing_tools(&manifest, false, false));
        assert!(queue_owes_missing_tools(&manifest, false, true));
    }
}
