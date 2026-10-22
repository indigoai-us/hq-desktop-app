//! H8 paired personal-root setup and adoption review (gated).
//!
//! When the gate is on, a new HQ root is created only by the hq-cloud
//! `personal-projection initialize` action, after the person's vault authority
//! exists, and before any template, git, or sync work touches it. An existing
//! or empty folder is never seeded: it goes to an explicit adoption review,
//! with one user approval per phase (preserve, adopt, baseline, resume).
//!
//! The gate is a local setting that is off unless set explicitly, AND the
//! paired hq-cloud build must be pinned (`personal_projection_supported`).
//! The pin is empty, so in shipped builds every entry point here reports
//! `legacy` and the existing setup path runs unchanged.
//!
//! The Desktop keeps a small app-private record next to hq-cloud's state
//! (`<stateDir>/desktop-personal-root.json`, outside the root). It stores the
//! reviewed plan verbatim so a relaunch can show it again. It is never proof
//! of ownership: every phase is still decided by the wrapper.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use hq_desktop_core::personal_projection::{
    self as pp, InspectStatus, LocalPause, Outcome, Pause, PersonalProjectionClient, Phase,
    ProjectionRunner, ReviewedPlan, UserApproval,
};

use crate::util::logfile::log;

/// menubar.json key for the local opt-in. Off unless explicitly `true`.
pub(crate) const PAIRED_ROOT_SETTING: &str = "pairedPersonalRootInit";

/// App-private record file inside the canonical state directory.
pub(crate) const RECORD_FILE: &str = "desktop-personal-root.json";

/// Event the main window listens to for the adoption review.
pub(crate) const PERSONAL_ROOT_CHANGED_EVENT: &str = "personal-root:changed";

const RECORD_SCHEMA: u32 = 1;

/// Whether the paired personal-root flow is active on this computer.
pub(crate) fn paired_root_gate_enabled() -> bool {
    #[cfg(test)]
    if let Some(forced) = GATE_OVERRIDE.with(std::cell::Cell::get) {
        return forced;
    }
    pp::personal_projection_supported() && local_setting_on()
}

#[cfg(test)]
thread_local! {
    static GATE_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Test-only: force the gate on this thread until dropped.
#[cfg(test)]
pub(crate) struct GateOverride;

#[cfg(test)]
impl GateOverride {
    pub(crate) fn set(enabled: bool) -> Self {
        GATE_OVERRIDE.with(|cell| cell.set(Some(enabled)));
        Self
    }
}

#[cfg(test)]
impl Drop for GateOverride {
    fn drop(&mut self) {
        GATE_OVERRIDE.with(|cell| cell.set(None));
    }
}

fn local_setting_on() -> bool {
    let Ok(path) = crate::util::paths::menubar_json_path() else {
        return false;
    };
    hq_desktop_core::first_run::read_menubar_obj(&path)
        .get(PAIRED_ROOT_SETTING)
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

/// Where the root is in the paired flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RootPhase {
    /// Saved before `initialize` is spawned, so a commit whose result was lost
    /// (cancel, timeout, crash) is recognized on the next run.
    InitializePending,
    /// `initialize` created the root; the first seed may run.
    Initialized,
    /// The first seed finished. Later runs never re-extract the template.
    Seeded,
    /// `inspect` matched the current account. Not a lease, not a seed permit.
    OwnerObserved,
    /// The folder exists without an owner; waiting for the user's review.
    AdoptionReview,
    Preserved,
    Adopted,
    BaselineReady,
    /// The wrapper authorized ordinary operation. The Desktop starts its own
    /// runner once.
    ResumeAuthorized,
    /// Stopped with a typed reason that needs the user.
    Paused,
}

impl RootPhase {
    fn in_adoption(self) -> bool {
        matches!(
            self,
            RootPhase::AdoptionReview
                | RootPhase::Preserved
                | RootPhase::Adopted
                | RootPhase::BaselineReady
        )
    }

    /// The record names a root this state directory owns or is adopting.
    /// Paused records and an unplanned review do not.
    fn holds_root(self) -> bool {
        matches!(
            self,
            RootPhase::InitializePending
                | RootPhase::Initialized
                | RootPhase::Seeded
                | RootPhase::OwnerObserved
                | RootPhase::ResumeAuthorized
                | RootPhase::Preserved
                | RootPhase::Adopted
                | RootPhase::BaselineReady
        )
    }

    /// The phase the next user approval applies to, if any.
    fn next_approval(self, has_plan: bool) -> Option<Phase> {
        match self {
            RootPhase::AdoptionReview if has_plan => Some(Phase::Preserve),
            RootPhase::Preserved => Some(Phase::Adopt),
            RootPhase::Adopted => Some(Phase::Baseline),
            RootPhase::BaselineReady => Some(Phase::Resume),
            _ => None,
        }
    }
}

/// The app-private record. `plan` holds the wrapper's bytes verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RootRecord {
    pub schema_version: u32,
    pub root_path: String,
    pub phase: RootPhase,
    #[serde(default)]
    pub projection_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default)]
    pub plan: Option<Box<RawValue>>,
    #[serde(default)]
    pub receipt_digest: Option<String>,
    /// Identity of the root `initialize` created (device, inode on Unix).
    /// The seed write boundary refuses a root that no longer matches.
    #[serde(default)]
    pub root_device: Option<u64>,
    #[serde(default)]
    pub root_inode: Option<u64>,
}

impl RootRecord {
    fn new(root: &Path, phase: RootPhase) -> Self {
        Self {
            schema_version: RECORD_SCHEMA,
            root_path: root.to_string_lossy().into_owned(),
            phase,
            projection_id: None,
            reason: None,
            retryable: false,
            plan: None,
            receipt_digest: None,
            root_device: None,
            root_inode: None,
        }
    }

    fn paused(root: &Path, reason: &str, retryable: bool) -> Self {
        let mut record = Self::new(root, RootPhase::Paused);
        record.reason = Some(reason.to_string());
        record.retryable = retryable;
        record
    }

    fn reviewed_plan(&self) -> Option<ReviewedPlan> {
        self.plan
            .as_ref()
            .and_then(|raw| ReviewedPlan::from_persisted(raw.get()))
    }
}

pub(crate) fn record_path(state_dir: &Path) -> PathBuf {
    state_dir.join(RECORD_FILE)
}

pub(crate) fn read_record(state_dir: &Path) -> Option<RootRecord> {
    let bytes = std::fs::read(record_path(state_dir)).ok()?;
    let record: RootRecord = serde_json::from_slice(&bytes).ok()?;
    (record.schema_version == RECORD_SCHEMA).then_some(record)
}

/// Write the record atomically. The state directory may be created here: it
/// is private metadata outside the root, never the root itself.
pub(crate) fn write_record(state_dir: &Path, record: &RootRecord) -> Result<(), String> {
    std::fs::create_dir_all(state_dir)
        .map_err(|e| format!("could not prepare the HQ state folder: {e}"))?;
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|e| format!("could not encode the personal root record: {e}"))?;
    let target = record_path(state_dir);
    let tmp = state_dir.join(format!("{RECORD_FILE}.{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("could not write the personal root record: {e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("could not write the personal root record: {e}"))?;
    }
    std::fs::rename(&tmp, &target)
        .map_err(|e| format!("could not save the personal root record: {e}"))
}

/// Typed name for a pause, for the record and the UI.
fn pause_name(pause: &Pause) -> String {
    match pause {
        Pause::Wire(wire) => serde_json::to_value(wire.reason)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "state_unreadable".to_string()),
        Pause::Local(local) => match local {
            LocalPause::UnsupportedCli => "unsupported_cli",
            LocalPause::Cancelled => "cancelled",
            LocalPause::SpawnFailed => "spawn_failed",
            LocalPause::Timeout => "timeout",
            LocalPause::RequestRejected => "request_rejected",
            LocalPause::ResponseTooLarge => "response_too_large",
        }
        .to_string(),
    }
}

/// Canonical root and state paths, with the containment checks hq-cloud also
/// makes. Returns a typed reason on refusal.
pub(crate) fn canonical_paths(root_input: &str, state_dir: &Path) -> Result<PathBuf, &'static str> {
    let input = Path::new(root_input);
    if !input.is_absolute() {
        return Err("request_rejected");
    }
    let root = hq_desktop_core::journal::canonical_prospective_path(input)
        .map_err(|_| "state_unreadable")?;
    if hq_desktop_core::journal::root_contains_state_dir(&root, state_dir) {
        return Err("state_inside_root");
    }
    Ok(root)
}

/// Create the root's missing parent folders, never the root itself, and never
/// anything inside the state directory.
fn prepare_parent(root: &Path, state_dir: &Path) -> Result<(), &'static str> {
    let parent = root.parent().ok_or("request_rejected")?;
    if parent.starts_with(state_dir) {
        return Err("state_inside_root");
    }
    std::fs::create_dir_all(parent).map_err(|_| "parent_unavailable")?;
    // The leaf must still be absent: initialize creates it exclusively.
    match std::fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("root_replaced"),
    }
}

/// Inspect, then (for a new root) initialize. Authority is resolved by the
/// caller first. Returns the record to show.
///
/// A saved record that holds a root (initialize pending, initialized, seeded,
/// owned, or mid-adoption) is never overwritten by a pause: the pause is shown
/// on a copy, so the projection id, root identity, and the one-root guard
/// survive an offline launch, a busy wrapper, a timeout, or a cancel.
pub(crate) fn prepare_with<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    root_input: &str,
    state_dir: &Path,
) -> RootRecord {
    let root = match canonical_paths(root_input, state_dir) {
        Ok(root) => root,
        Err(reason) => {
            return RootRecord::paused(Path::new(root_input), reason, false);
        }
    };
    let root_str = root.to_string_lossy().into_owned();
    let existing = read_record(state_dir);
    if let Some(existing) = existing
        .as_ref()
        .filter(|r| r.phase.holds_root() || r.phase.in_adoption())
    {
        // One personal root per state directory.
        if existing.root_path != root_str {
            return RootRecord::paused(&root, "state_in_use_by_other_root", false);
        }
    }
    let existing = existing.filter(|r| r.root_path == root_str);
    let protected = existing
        .as_ref()
        .filter(|r| r.phase.holds_root() || r.phase.in_adoption());

    match client.inspect(&root_str) {
        Outcome::Done(report) => match report.status {
            InspectStatus::NewRoot => match protected {
                // Our earlier initialize never committed (the root is still
                // absent): initialize again. Exclusive creation makes this safe.
                Some(record) if record.phase == RootPhase::InitializePending => {
                    initialize_new_root(client, &root, &root_str, state_dir)
                }
                // We recorded this root before and it is gone now.
                Some(record) => with_reason(record, "root_replaced", false),
                None => initialize_new_root(client, &root, &root_str, state_dir),
            },
            InspectStatus::OwnerObserved => {
                owner_observed(&root, protected, report.projection_id, state_dir)
            }
            InspectStatus::AdoptionRequired => {
                persist(state_dir, adoption_record(&root, existing.as_ref()))
            }
        },
        Outcome::Paused(pause) if pause.requires_adoption() => {
            persist(state_dir, adoption_record(&root, existing.as_ref()))
        }
        Outcome::Paused(pause) => match protected {
            Some(record) => with_reason(record, &pause_name(&pause), pause.retryable()),
            None => persist(
                state_dir,
                RootRecord::paused(&root, &pause_name(&pause), pause.retryable()),
            ),
        },
    }
}

/// A copy of `record` showing `reason`, without saving it.
fn with_reason(record: &RootRecord, reason: &str, retryable: bool) -> RootRecord {
    let mut view = record.clone();
    view.reason = Some(reason.to_string());
    view.retryable = retryable;
    view
}

fn persist(state_dir: &Path, record: RootRecord) -> RootRecord {
    match write_record(state_dir, &record) {
        Ok(()) => record,
        Err(error) => {
            log("personal-root", &error);
            with_reason(&record, "state_unreadable", false)
        }
    }
}

/// Device and inode of `path` itself (never through a symlink).
pub(crate) fn root_identity(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Some((0, 0))
    }
}

fn initialized_record(root: &Path, projection_id: String) -> RootRecord {
    let mut record = RootRecord::new(root, RootPhase::Initialized);
    record.projection_id = Some(projection_id);
    if let Some((device, inode)) = root_identity(root) {
        record.root_device = Some(device);
        record.root_inode = Some(inode);
    }
    record
}

fn initialize_new_root<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    root: &Path,
    root_str: &str,
    state_dir: &Path,
) -> RootRecord {
    if let Err(reason) = prepare_parent(root, state_dir) {
        return RootRecord::paused(root, reason, false);
    }
    // Record the intent before spawning, so a lost result is recoverable.
    let pending = RootRecord::new(root, RootPhase::InitializePending);
    if let Err(error) = write_record(state_dir, &pending) {
        log("personal-root", &error);
        return RootRecord::paused(root, "state_unreadable", false);
    }
    match client.initialize(root_str) {
        Outcome::Done(initialized) => persist(
            state_dir,
            initialized_record(root, initialized.projection_id),
        ),
        Outcome::Paused(pause) if pause.requires_adoption() => {
            persist(state_dir, RootRecord::new(root, RootPhase::AdoptionReview))
        }
        // Keep the pending intent saved; the next run re-inspects.
        Outcome::Paused(pause) => with_reason(&pending, &pause_name(&pause), pause.retryable()),
    }
}

fn root_is_empty(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok_and(|mut entries| entries.next().is_none())
}

fn owner_observed(
    root: &Path,
    protected: Option<&RootRecord>,
    projection_id: Option<String>,
    state_dir: &Path,
) -> RootRecord {
    match protected {
        // Our initialize committed but its result was lost. An empty root is
        // exactly what initialize leaves, so the first seed may still run.
        // Anything else in it is recovery, never a silent seed.
        Some(record) if record.phase == RootPhase::InitializePending => match projection_id {
            Some(id) if root_is_empty(root) => persist(state_dir, initialized_record(root, id)),
            _ => with_reason(record, "state_changed", false),
        },
        // Our own root. A different projection than the recorded one is
        // recovery, never a silent reseed.
        Some(record)
            if matches!(
                record.phase,
                RootPhase::Initialized
                    | RootPhase::Seeded
                    | RootPhase::OwnerObserved
                    | RootPhase::ResumeAuthorized
            ) =>
        {
            if projection_id.is_some()
                && record.projection_id.is_some()
                && projection_id != record.projection_id
            {
                with_reason(record, "state_changed", false)
            } else {
                record.clone()
            }
        }
        Some(record) => with_reason(record, "state_changed", false),
        None => {
            let mut record = RootRecord::new(root, RootPhase::OwnerObserved);
            record.projection_id = projection_id;
            persist(state_dir, record)
        }
    }
}

fn adoption_record(root: &Path, existing: Option<&RootRecord>) -> RootRecord {
    match existing {
        Some(record) if record.phase.in_adoption() => {
            let mut record = record.clone();
            record.reason = None;
            record.retryable = false;
            record
        }
        _ => RootRecord::new(root, RootPhase::AdoptionReview),
    }
}

/// Ask the wrapper for the adoption plan and keep it verbatim.
pub(crate) fn plan_adoption_with<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    state_dir: &Path,
) -> Result<RootRecord, String> {
    let record = read_record(state_dir).ok_or("There is no folder waiting for review.")?;
    if record.phase != RootPhase::AdoptionReview {
        return Err("This folder is not waiting for a review.".to_string());
    }
    let state_str = state_dir.to_string_lossy().into_owned();
    let next = match client.plan_adoption(&record.root_path, &state_str) {
        Outcome::Done(plan) => {
            let mut next = record.clone();
            next.plan = RawValue::from_string(plan.raw_json().to_string()).ok();
            next.reason = None;
            next.retryable = false;
            next
        }
        Outcome::Paused(pause) => {
            let mut view = record.clone();
            view.reason = Some(pause_name(&pause));
            view.retryable = pause.retryable();
            // owner_mismatch and other recovery reasons stop the review.
            if matches!(&pause, Pause::Wire(w) if !w.retryable && !pause.requires_adoption()) {
                let stopped = RootRecord::paused(
                    Path::new(&record.root_path),
                    view.reason.as_deref().unwrap_or("state_unreadable"),
                    false,
                );
                return Ok(persist(state_dir, stopped));
            }
            return Ok(view);
        }
    };
    Ok(persist(state_dir, next))
}

/// Result of one approved phase.
pub(crate) struct ApprovalResult {
    pub record: RootRecord,
    /// True exactly when this call reached `resume_authorized`; the caller
    /// starts the Desktop's own runner once.
    pub start_runner: bool,
}

/// Run exactly one phase for one user approval. Never chains to the next.
pub(crate) fn approve_with<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    state_dir: &Path,
    approval: &UserApproval,
) -> Result<ApprovalResult, String> {
    let record = read_record(state_dir).ok_or("There is no folder waiting for review.")?;
    let expected = record.phase.next_approval(record.plan.is_some());
    if expected != Some(approval.phase) {
        return Err("That step is not the next one for this folder.".to_string());
    }
    let plan = record
        .reviewed_plan()
        .ok_or("The reviewed plan could not be read. Start the review again.")?;
    if approval.plan_digest != plan.plan().approved_plan_digest {
        return Err("This approval is for a different plan.".to_string());
    }

    let mut next = record.clone();
    next.reason = None;
    next.retryable = false;
    let mut start_runner = false;
    let pause = match approval.phase {
        Phase::Preserve => match client.preserve(&plan, approval) {
            Outcome::Done(_) => {
                next.phase = RootPhase::Preserved;
                None
            }
            Outcome::Paused(p) => Some(p),
        },
        Phase::Adopt => match client.adopt(&plan, approval) {
            Outcome::Done(adopted) => {
                next.phase = RootPhase::Adopted;
                next.projection_id = Some(adopted.projection_id);
                None
            }
            Outcome::Paused(p) => Some(p),
        },
        Phase::Baseline => match client.baseline(&plan, approval) {
            Outcome::Done(ready) => {
                next.phase = RootPhase::BaselineReady;
                next.projection_id = Some(ready.projection_id);
                next.receipt_digest = Some(ready.receipt_digest);
                None
            }
            Outcome::Paused(p) => Some(p),
        },
        Phase::Resume => {
            let baseline = baseline_from_record(&record)
                .ok_or("The upload receipt is missing. Start the review again.")?;
            match client.resume(&plan, approval, &baseline) {
                Outcome::Done(resumed) => {
                    next.phase = RootPhase::ResumeAuthorized;
                    next.projection_id = Some(resumed.projection_id);
                    start_runner = true;
                    None
                }
                Outcome::Paused(p) => Some(p),
            }
        }
    };
    if let Some(pause) = pause {
        // The record keeps its phase and plan; nothing retries on its own. A
        // typed stop that is not retryable is saved with the record so the
        // step stays hidden until the folder is checked again.
        let view = with_reason(&record, &pause_name(&pause), pause.retryable());
        let stopped = matches!(&pause, Pause::Wire(w) if !w.retryable);
        let record = if stopped {
            persist(state_dir, view)
        } else {
            view
        };
        return Ok(ApprovalResult {
            record,
            start_runner: false,
        });
    }
    let saved = write_record(state_dir, &next);
    if let Err(error) = saved {
        log("personal-root", &error);
        let mut view = next;
        view.reason = Some("state_unreadable".to_string());
        return Ok(ApprovalResult {
            record: view,
            start_runner: false,
        });
    }
    Ok(ApprovalResult {
        record: next,
        start_runner,
    })
}

fn baseline_from_record(record: &RootRecord) -> Option<pp::BaselineReady> {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "status": "baseline_ready",
        "projectionId": record.projection_id.as_ref()?,
        "receiptDigest": record.receipt_digest.as_ref()?,
        "resumed": false,
    });
    serde_json::from_value(value).ok()
}

/// What the content stage may do with the root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SeedDecision {
    /// Gate off: the existing setup path, unchanged.
    Legacy,
    /// Freshly initialized by this Desktop: extract the template.
    Seed,
    /// Already seeded or owned: keep the files, never re-extract.
    KeepExisting,
}

/// Decide the content stage for `root_input`. With the gate on, anything but
/// an initialized or owned root refuses, and nothing is created.
pub(crate) fn seed_decision_with(
    gate: bool,
    root_input: &str,
    state_dir: &Path,
) -> Result<SeedDecision, String> {
    if !gate {
        return Ok(SeedDecision::Legacy);
    }
    let root = canonical_paths(root_input, state_dir).map_err(|_| seed_refused())?;
    let record = read_record(state_dir).ok_or_else(seed_refused)?;
    if record.root_path != root.to_string_lossy() || !root.is_dir() {
        return Err(seed_refused());
    }
    match record.phase {
        RootPhase::Initialized => {
            check_recorded_identity(&record, &root)?;
            Ok(SeedDecision::Seed)
        }
        RootPhase::Seeded | RootPhase::OwnerObserved | RootPhase::ResumeAuthorized => {
            Ok(SeedDecision::KeepExisting)
        }
        _ => Err(seed_refused()),
    }
}

fn seed_refused() -> String {
    "HQ has not finished preparing this folder. Go back to the folder step and try again."
        .to_string()
}

fn root_replaced_error() -> String {
    "This folder was moved or replaced after HQ prepared it. HQ wrote nothing into it.".to_string()
}

fn check_recorded_identity(record: &RootRecord, root: &Path) -> Result<(), String> {
    let expected = record.root_device.zip(record.root_inode);
    match (expected, root_identity(root)) {
        (Some(expected), Some(actual)) if expected == actual => Ok(()),
        _ => Err(root_replaced_error()),
    }
}

/// The write boundary for the first seed. `check` runs before every template
/// write and refuses a root whose identity changed; `revalidate_with` asks the
/// wrapper, right before the first write, that the current account still owns
/// exactly the root this Desktop initialized.
pub(crate) struct SeedFence {
    root: PathBuf,
    record: RootRecord,
}

impl SeedFence {
    pub(crate) fn for_root(state_dir: &Path, root_input: &str) -> Result<Self, String> {
        let root = canonical_paths(root_input, state_dir).map_err(|_| seed_refused())?;
        let record = read_record(state_dir).ok_or_else(seed_refused)?;
        if record.phase != RootPhase::Initialized || record.root_path != root.to_string_lossy() {
            return Err(seed_refused());
        }
        Ok(Self { root, record })
    }

    /// Cheap per-write check: same folder (device and inode), not a symlink.
    pub(crate) fn check(&self) -> Result<(), String> {
        check_recorded_identity(&self.record, &self.root)
    }

    /// Before the first write: identity, then the wrapper's `inspect` must
    /// report the recorded projection as owned by the current account.
    pub(crate) fn revalidate_with<R: ProjectionRunner>(
        &self,
        client: &PersonalProjectionClient<R>,
    ) -> Result<(), String> {
        self.check()?;
        match client.inspect(&self.record.root_path) {
            Outcome::Done(report)
                if report.status == InspectStatus::OwnerObserved
                    && report.projection_id == self.record.projection_id =>
            {
                self.check()
            }
            Outcome::Done(_) => Err(root_replaced_error()),
            Outcome::Paused(pause) => Err(format!(
                "HQ stopped before writing into this folder ({}).",
                pause_name(&pause)
            )),
        }
    }

    /// Production revalidation through the pinned wrapper.
    pub(crate) async fn revalidate(&self) -> Result<(), String> {
        let fence = SeedFence {
            root: self.root.clone(),
            record: self.record.clone(),
        };
        match with_client(move |client| fence.revalidate_with(client)).await? {
            Some(result) => result,
            None => Err(personal_root_reason_message("unsupported_cli")),
        }
    }
}

fn personal_root_reason_message(reason: &str) -> String {
    format!("HQ stopped before writing into this folder ({reason}).")
}

/// Record that the first seed finished, so no later run re-extracts.
pub(crate) fn mark_seeded(state_dir: &Path, root: &str) {
    if let Some(mut record) = read_record(state_dir) {
        if record.phase == RootPhase::Initialized && record.root_path == root {
            record.phase = RootPhase::Seeded;
            if let Err(error) = write_record(state_dir, &record) {
                log("personal-root", &error);
            }
        }
    }
}

/// Whether personal sync may run for the current root. Company sync is never
/// held here. With the gate off this is always true.
pub(crate) fn personal_sync_permitted(record: Option<&RootRecord>, root: &Path) -> bool {
    record.is_some_and(|record| {
        record.reason.is_none()
            && record.root_path == root.to_string_lossy()
            && matches!(
                record.phase,
                RootPhase::Initialized
                    | RootPhase::Seeded
                    | RootPhase::OwnerObserved
                    | RootPhase::ResumeAuthorized
            )
    })
}

// ── UI view ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntryView {
    pub key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadEntryView {
    pub key: String,
    pub kind: String,
    pub size: u64,
    pub wire_size: u64,
    pub local_hash: String,
    pub wire_hash: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub transaction_id: String,
    pub state_directory: String,
    pub authority_digest: String,
    pub inventory_digest: String,
    pub max_upload_rows: u64,
    pub max_upload_bytes: u64,
    pub max_duration_ms: u64,
    /// Every upload the baseline phase may make. Capped for display; the
    /// total is in `upload_count`.
    pub upload_entries: Vec<UploadEntryView>,
    pub approved_plan_digest: String,
    pub file_count: u64,
    pub byte_count: u64,
    pub upload_count: usize,
    pub upload_bytes: u64,
    pub preserved_only: Vec<PlanEntryView>,
    pub preserved_only_total: usize,
    pub destination_uid: String,
    pub destination_bucket: String,
    pub destination_region: String,
    pub destination_endpoint: String,
    pub historical_uids: Vec<String>,
}

/// What the onboarding Directory step and the main-window review render.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalRootView {
    /// `legacy` when the gate is off; otherwise a [`RootPhase`] name.
    pub phase: String,
    pub root_path: Option<String>,
    pub reason: Option<String>,
    pub retryable: bool,
    /// `preserve`, `adopt`, `baseline`, or `resume` when a user approval is next.
    pub next_phase: Option<String>,
    pub plan: Option<PlanView>,
    /// Personal sync is held, but an hq daemon this app did not start is
    /// running sync and cannot be told to leave personal out.
    pub hold_unenforced: bool,
}

const PRESERVED_ONLY_PREVIEW: usize = 200;
const UPLOAD_ENTRIES_PREVIEW: usize = 2_000;

impl PersonalRootView {
    pub(crate) fn legacy() -> Self {
        Self {
            phase: "legacy".to_string(),
            root_path: None,
            reason: None,
            retryable: false,
            next_phase: None,
            plan: None,
            hold_unenforced: false,
        }
    }

    pub(crate) fn unsupported(root: Option<String>) -> Self {
        Self {
            phase: "paused".to_string(),
            root_path: root,
            reason: Some("unsupported_cli".to_string()),
            retryable: false,
            next_phase: None,
            plan: None,
            hold_unenforced: false,
        }
    }

    pub(crate) fn from_record(record: &RootRecord) -> Self {
        let plan = record.reviewed_plan().map(|reviewed| {
            let plan = reviewed.plan();
            PlanView {
                transaction_id: plan.transaction_id.clone(),
                state_directory: plan.state_directory.clone(),
                authority_digest: plan.authority_digest.clone(),
                inventory_digest: plan.inventory_digest.clone(),
                max_upload_rows: plan.max_upload_rows,
                max_upload_bytes: plan.max_upload_bytes,
                max_duration_ms: plan.max_duration_ms,
                upload_entries: plan
                    .upload_entries
                    .iter()
                    .take(UPLOAD_ENTRIES_PREVIEW)
                    .map(|e| UploadEntryView {
                        key: e.key.clone(),
                        kind: match e.kind {
                            pp::UploadKind::File => "file".to_string(),
                            pp::UploadKind::Symlink => "symlink".to_string(),
                        },
                        size: e.size,
                        wire_size: e.wire_size,
                        local_hash: e.local_hash.clone(),
                        wire_hash: e.wire_hash.clone(),
                    })
                    .collect(),
                approved_plan_digest: plan.approved_plan_digest.clone(),
                file_count: plan.file_count,
                byte_count: plan.byte_count,
                upload_count: plan.upload_entries.len(),
                upload_bytes: plan.upload_entries.iter().map(|e| e.size).sum(),
                preserved_only: plan
                    .preserved_only
                    .iter()
                    .take(PRESERVED_ONLY_PREVIEW)
                    .map(|e| PlanEntryView {
                        key: e.key.clone(),
                        reason: e.reason.clone(),
                    })
                    .collect(),
                preserved_only_total: plan.preserved_only.len(),
                destination_uid: plan.destination.uid.clone(),
                destination_bucket: plan.destination.bucket.clone(),
                destination_region: plan.destination.region.clone(),
                destination_endpoint: plan.destination.endpoint.clone(),
                historical_uids: plan.historical_uids.clone(),
            }
        });
        let phase = serde_json::to_value(record.phase)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "paused".to_string());
        Self {
            phase,
            root_path: Some(record.root_path.clone()),
            reason: record.reason.clone(),
            retryable: record.retryable,
            next_phase: record
                .phase
                .next_approval(record.plan.is_some())
                .filter(|_| record.reason.is_none() || record.retryable)
                .map(|p| phase_name(p).to_string()),
            plan,
            hold_unenforced: false,
        }
    }
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Preserve => "preserve",
        Phase::Adopt => "adopt",
        Phase::Baseline => "baseline",
        Phase::Resume => "resume",
    }
}

fn parse_phase(name: &str) -> Option<Phase> {
    match name {
        "preserve" => Some(Phase::Preserve),
        "adopt" => Some(Phase::Adopt),
        "baseline" => Some(Phase::Baseline),
        "resume" => Some(Phase::Resume),
        _ => None,
    }
}

// ── Tauri entry points ──────────────────────────────────────────────────────

fn state_dir() -> Result<PathBuf, String> {
    hq_desktop_core::journal::state_dir_canonical()
        .map_err(|e| format!("could not resolve the HQ state folder: {e}"))
}

/// Run `body` with a fresh production client on a blocking thread. `None`
/// means the paired build is not available, which is reported as unsupported.
async fn with_client<T: Send + 'static>(
    body: impl FnOnce(&PersonalProjectionClient<pp::PinnedProjectionRunner>) -> T + Send + 'static,
) -> Result<Option<T>, String> {
    // Sign-out and quit close this latch, signal the wrapper child, and wait
    // for it to exit before tokens or paths change.
    let ticket = hq_desktop_core::work_admission::personal_work()
        .admit()
        .map_err(|closed| closed.message().to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = pp::production_client()?;
        let _registration = ticket.register_cancel(client.runner().cancel_flag());
        let result = body(&client);
        drop(ticket);
        Some(result)
    })
    .await
    .map_err(|e| format!("personal root task failed: {e}"))
}

#[tauri::command]
pub fn personal_root_gate_enabled() -> bool {
    paired_root_gate_enabled()
}

/// The saved state, for a relaunch or the main-window review.
#[tauri::command]
pub fn personal_root_state() -> PersonalRootView {
    if !paired_root_gate_enabled() {
        return PersonalRootView::legacy();
    }
    let mut view = match state_dir().ok().and_then(|dir| read_record(&dir)) {
        Some(record) => PersonalRootView::from_record(&record),
        None => PersonalRootView::legacy(),
    };
    view.hold_unenforced = hq_desktop_core::daemon::personal_projection_held()
        && !crate::commands::hq_daemon_host::personal_hold_reaches_runner();
    view
}

/// "Try again" / "Check this folder again": run inspect (and initialize for a
/// genuinely new root) for the recorded folder. Never retries a phase.
#[tauri::command]
pub async fn personal_root_recheck(app: tauri::AppHandle) -> Result<PersonalRootView, String> {
    if !paired_root_gate_enabled() {
        return Ok(PersonalRootView::legacy());
    }
    let state = state_dir()?;
    let root = read_record(&state)
        .map(|record| record.root_path)
        .ok_or("There is no folder to check.")?;
    let view = prepare_personal_root(app.clone(), root).await?;
    if view.phase != "paused" && view.reason.is_none() {
        // A confirmed owner lifts the launch hold.
        if let (Ok(state), Some(root)) = (state_dir(), view.root_path.as_deref()) {
            if personal_sync_permitted(read_record(&state).as_ref(), Path::new(root)) {
                hq_desktop_core::daemon::set_personal_projection_hold(false);
            }
        }
    }
    emit_changed(&app);
    Ok(view)
}

/// Directory step: authority first, then inspect, then (for a new root)
/// initialize. Creates nothing but the root's missing parents and the private
/// state record; the root itself only through `initialize`.
#[tauri::command]
pub async fn prepare_personal_root(
    app: tauri::AppHandle,
    path: String,
) -> Result<PersonalRootView, String> {
    if !paired_root_gate_enabled() {
        return Ok(PersonalRootView::legacy());
    }
    let state = state_dir()?;
    // Authority first. With Cloud off nothing is provisioned here; the wrapper
    // still authenticates on its own, and a missing authority pauses visibly.
    if !hq_desktop_core::daemon::is_cloud_paused() {
        if let Err(error) = crate::commands::personal::provision_personal_authority(&app).await {
            log("personal-root", &format!("authority unavailable: {error}"));
            return Ok(PersonalRootView::from_record(&RootRecord::paused(
                Path::new(&path),
                "authority_unavailable",
                true,
            )));
        }
    }
    let root_input = path.clone();
    let record = with_client(move |client| prepare_with(client, &root_input, &state)).await?;
    Ok(match record {
        Some(record) => PersonalRootView::from_record(&record),
        None => PersonalRootView::unsupported(Some(path)),
    })
}

/// Adoption review: ask the wrapper for the plan. Uploads nothing.
#[tauri::command]
pub async fn personal_root_plan_adoption() -> Result<PersonalRootView, String> {
    if !paired_root_gate_enabled() {
        return Ok(PersonalRootView::legacy());
    }
    let state = state_dir()?;
    let record = with_client(move |client| plan_adoption_with(client, &state)).await?;
    match record {
        Some(record) => Ok(PersonalRootView::from_record(&record?)),
        None => Ok(PersonalRootView::unsupported(None)),
    }
}

/// One user click for one phase, carrying the plan digest the user saw.
#[tauri::command]
pub async fn personal_root_approve_phase(
    app: tauri::AppHandle,
    phase: String,
    plan_digest: String,
) -> Result<PersonalRootView, String> {
    if !paired_root_gate_enabled() {
        return Ok(PersonalRootView::legacy());
    }
    let phase = parse_phase(&phase).ok_or("Unknown step.")?;
    let state = state_dir()?;
    let approval = UserApproval { phase, plan_digest };
    let result = with_client(move |client| approve_with(client, &state, &approval)).await?;
    let Some(result) = result else {
        return Ok(PersonalRootView::unsupported(None));
    };
    let result = result?;
    if result.start_runner {
        start_owned_runner_after_resume(&app);
    }
    Ok(PersonalRootView::from_record(&result.record))
}

/// After `resume_authorized`: lift the personal hold so the Desktop's own
/// runner includes personal. The wrapper never starts a runner.
///
/// - During onboarding nothing starts here: finishing setup starts the sync
///   services, now with personal included.
/// - A running watcher is never stopped (that would interrupt company sync).
///   The hosted hq daemon picks the change up through its settings watcher;
///   the legacy watcher gets one ordinary sync pass now, and includes
///   personal from its next generation.
fn start_owned_runner_after_resume(app: &tauri::AppHandle) {
    hq_desktop_core::daemon::set_personal_projection_hold(false);
    if !crate::commands::lifecycle::sync_held_for_setup()
        && crate::commands::hq_daemon_host::current_phase()
            == crate::commands::hq_daemon_host::HostPhase::Legacy
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::commands::sync::start_sync_with_trigger(
                app,
                None,
                crate::commands::cdp_mirror::SyncTrigger::Auto,
            )
            .await
            {
                log(
                    "personal-root",
                    &format!("first personal pass after resume did not start: {error}"),
                );
            }
        });
    }
    emit_changed(app);
}

fn emit_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit_to("main", PERSONAL_ROOT_CHANGED_EVENT, ());
    let _ = app.emit_to(
        crate::commands::desktop_alt::WINDOW_LABEL,
        PERSONAL_ROOT_CHANGED_EVENT,
        (),
    );
}

/// Launch check for an installed root. With the gate on, personal sync is held
/// (company sync is not) until `inspect` confirms the recorded owner. An
/// upgraded user whose root needs adoption sees the review in the main window.
pub(crate) fn on_launch(app: &tauri::AppHandle) {
    if !paired_root_gate_enabled() {
        return;
    }
    hq_desktop_core::daemon::set_personal_projection_hold(true);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(state) = state_dir() else {
            return;
        };
        let Ok(root) = crate::commands::install_directory::resolve_existing_hq_path() else {
            return;
        };
        let state_for_check = state.clone();
        let root_for_check = root.clone();
        let checked =
            with_client(move |client| launch_check_with(client, &root_for_check, &state_for_check))
                .await;
        let permitted = matches!(checked, Ok(Some(true)));
        if permitted {
            hq_desktop_core::daemon::set_personal_projection_hold(false);
        } else {
            log(
                "personal-root",
                "personal sync held at launch: the folder needs review or recovery",
            );
            if !crate::commands::hq_daemon_host::personal_hold_reaches_runner() {
                // Contract gap: an hq daemon this app did not start keeps its
                // own settings. Shown in the review; activation stays held.
                log(
                    "personal-root",
                    "personal hold cannot reach the running hq daemon (not started by this app)",
                );
            }
        }
        emit_changed(&app);
    });
}

/// Inspect the installed root and update the record. True when personal sync
/// may run.
pub(crate) fn launch_check_with<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    root: &str,
    state_dir: &Path,
) -> bool {
    let record = prepare_launch_record(client, root, state_dir);
    let canonical = canonical_paths(root, state_dir).ok();
    canonical.is_some_and(|root| personal_sync_permitted(Some(&record), &root))
}

/// Launch differs from setup in one way: an absent installed root is never
/// initialized here. Only the Directory step creates roots.
fn prepare_launch_record<R: ProjectionRunner>(
    client: &PersonalProjectionClient<R>,
    root: &str,
    state_dir: &Path,
) -> RootRecord {
    let Ok(canonical) = canonical_paths(root, state_dir) else {
        return RootRecord::paused(Path::new(root), "state_inside_root", false);
    };
    if !canonical.exists() {
        return RootRecord::paused(&canonical, "root_replaced", false);
    }
    prepare_with(client, root, state_dir)
}

#[cfg(test)]
#[path = "personal_root_tests.rs"]
mod tests;
